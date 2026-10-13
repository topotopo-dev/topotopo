// Worker thread entry of the Node pool (src/host/pool.ts). Runs registered kernels (src/core/kernels.ts) and the
// wrangle kernel, which compiles the generated per-point kernel source in this worker's own scripting realm (a
// Node host with the snippet library, created on the first wrangle task).
//
// Protocol: {type:'run', id, kernel, args, range, arrays, shared?} → {type:'result', id, ok, value, arrays} |
// {type:'result', id, ok:false, error, stack, user} | {type:'result', id, missingShared: key}. Shared data arrives
// once per worker ({key, arrays}) and is cached here; later tasks name only the key.
import { parentPort } from 'node:worker_threads';
import { KERNELS } from '../core/kernels.ts';
import type { KernelContext } from '../core/kernels.ts';
import type { Host } from './types.ts';

const port = parentPort!;

/** small LRU of shared data and of objects built from it */
class Lru<V> {
  private map = new Map<string, V>();
  private max: number;
  constructor(max: number) { this.max = max; }
  get(k: string): V | undefined {
    const v = this.map.get(k);
    if (v !== undefined) { this.map.delete(k); this.map.set(k, v); }
    return v;
  }
  set(k: string, v: V) {
    this.map.delete(k);
    this.map.set(k, v);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }
}
const sharedData = new Lru<Record<string, ArrayBufferView>>(8);
const memo = new Lru<any>(16);
const memoize = <T>(key: string, make: () => T): T => {
  let v = memo.get(key);
  if (v === undefined) { v = make(); memo.set(key, v); }
  return v;
};

let realm: Host | null = null;

/** One chunk of a point wrangle (eligibility and the kernel source come from src/core/wrangle.ts). */
async function wrangleChunk(a: any, arrays: Record<string, any>, start: number, end: number) {
  if (!realm) realm = (await import('./node.ts')).createNodeHost({ workers: 0 });
  const { wrangleRunError } = await import('../core/wrangle.ts');
  const { runUserCode } = await import('../core/usercode.ts');
  const kernel = realm.compile(a.source);
  const B = Array.from({ length: a.bindings }, (_, i) => ({ data: arrays['b' + i] }));
  const env = {
    n: a.n, s: start, e: end, mask: arrays.mask ?? null, vp: null, vprim: null, B,
    numpt: a.numpt, numprim: a.numprim, numvtx: a.numvtx, frame: a.frame, time: a.time, timeInc: a.timeInc, vars: a.vars,
    centroid: () => { throw new Error('centroid is not available in a point wrangle'); },
  };
  const g = realm.compile('globalThis');
  g.__cur = null;
  try {
    // what the snippet throws is read inside the time limit too (a thrown object's message getter is user code)
    runUserCode(realm, () => kernel(env), a.timeoutMs, true);
  } catch (e: any) {
    throw Object.assign(wrangleRunError(e, a.bodyLine, a.code, a.timeoutMs), { topotopoUser: true });
  }
}

port.on('message', async (m: any) => {
  if (m?.type !== 'run') return;
  let shared: Record<string, ArrayBufferView> = {};
  if (m.shared) {
    if (m.shared.arrays) { sharedData.set(m.shared.key, m.shared.arrays); shared = m.shared.arrays; }
    else {
      const c = sharedData.get(m.shared.key);
      if (!c) { port.postMessage({ type: 'result', id: m.id, missingShared: m.shared.key }); return; }
      shared = c;
    }
  }
  const [start, end] = m.range ?? [0, 0];
  try {
    let value: any;
    if (m.kernel === 'wrangle') value = await wrangleChunk(m.args, m.arrays, start, end);
    else if (m.kernel === 'selftest.crash') process.exit(7);
    else {
      const k = KERNELS[m.kernel];
      if (!k) throw new Error(`unknown kernel "${m.kernel}"`);
      const ctx: KernelContext = { sharedKey: m.shared?.key ?? '', memo: m.shared ? memoize : (_k, make) => make() };
      value = k.run(m.args, { ...shared, ...m.arrays }, start, end, ctx);
    }
    // hand back the arrays that are not shared memory, moved (the caller copied or moved them in)
    const back: Record<string, ArrayBufferView> = {};
    const transfer: ArrayBuffer[] = [];
    for (const [n, a] of Object.entries(m.arrays as Record<string, ArrayBufferView>)) {
      if (a.buffer instanceof SharedArrayBuffer) continue;
      back[n] = a;
      if (a.buffer instanceof ArrayBuffer && !transfer.includes(a.buffer)) transfer.push(a.buffer);
    }
    port.postMessage({ type: 'result', id: m.id, ok: true, value, arrays: back }, transfer);
  } catch (e: any) {
    port.postMessage({ type: 'result', id: m.id, ok: false, error: String(e?.message ?? e), stack: String(e?.stack ?? ''), user: !!e?.topotopoUser });
  }
});

port.postMessage({ type: 'ready' });
