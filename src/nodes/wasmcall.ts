// Long WASM kernel calls under a node's time limit (R-18, R-17 N4). remesh_quad and the kernel backend of
// heightfield_erode run one call into the Rust/WASM kernels (src/wasm/kernels.ts) that nothing on its own thread can
// stop. When the host has a worker pool and the call is big, it runs on a pool worker instead, as the task "wasm"
// (src/host/worker.ts) with the rest of the node's time limit as the task's limit: a call that runs too long is stopped
// (the worker is replaced) and the node fails with its budget error. The worker runs the same WASM module on copies of
// the same arrays, so the result is the same bits. Small calls, and hosts without a pool, run here.
import { kernelsWasmVariant } from '../wasm/kernels.ts';
import type { Kernels } from '../wasm/kernels.ts';
import type { CookContext } from '../graph/types.ts';
import type { SimBudget } from './util.ts';

/** A call: the kernel function and its plain arguments; its arrays travel separately (absent optional layers: none). */
export type WasmCall =
  | { fn: 'remesh_quad'; options: Record<string, any> }
  | { fn: 'erode_droplet'; w: number; h: number; cell: number; params: Record<string, any>; seed: number }
  | { fn: 'erode_pipe'; w: number; h: number; cell: number; params: Record<string, any>; seed: number };

/**
 * Run a call on loaded kernels, on whichever thread. Arrays: remesh_quad positions, tris, crease_edges, locked_edges,
 * direction_edges; erode_* height, hardness?, freeze?, and rain? (pipe).
 */
export function runWasmCall(k: Kernels, c: WasmCall, a: Record<string, any>): any {
  switch (c.fn) {
    case 'remesh_quad':
      return k.remesh_quad(a.positions, a.tris, { ...c.options, crease_edges: a.crease_edges, locked_edges: a.locked_edges, direction_edges: a.direction_edges });
    case 'erode_droplet':
      return k.erode_droplet(a.height, a.hardness ?? null, c.w, c.h, c.cell, c.params, c.seed, a.freeze ?? null);
    case 'erode_pipe':
      return k.erode_pipe(a.height, a.hardness ?? null, c.w, c.h, c.cell, c.params, c.seed, a.freeze ?? null, a.rain ?? null);
  }
  throw new Error(`unknown WASM call "${(c as any).fn}"`);
}

/**
 * Run `call` for the node of `ctx`: on a pool worker under the rest of `budget` when the host has a pool and `size`
 * (the call's work, in the caller's units) reaches `minSize` (or the pool's minElements override), else here.
 */
export async function wasmCallUnderBudget(
  ctx: CookContext, kernels: Kernels, call: WasmCall, arrays: Record<string, ArrayBufferView | null | undefined>,
  size: number, minSize: number, budget: SimBudget,
): Promise<any> {
  const present: Record<string, ArrayBufferView> = {};
  for (const [k, v] of Object.entries(arrays)) if (v) present[k] = v;
  const pool = ctx.engine.host.pool;
  if (!pool || pool.size <= 0 || size < (pool.minElements ?? minSize)) return runWasmCall(kernels, call, present);
  budget.check();
  try {
    const r = await pool.run({ kernel: 'wasm', args: { ...call, variant: kernelsWasmVariant }, arrays: present, timeoutMs: Math.max(1, budget.left()) });
    return r.value;
  } catch (e: any) {
    if (e?.kernel === undefined && /^kernel "wasm" timed out/.test(String(e?.message))) throw budget.error();
    // no worker could start, or the worker selected another WASM build: run it here
    if (e?.code === 'POOL_UNAVAILABLE' || /WASM variant/.test(String(e?.message))) return runWasmCall(kernels, call, present);
    throw e;
  }
}
