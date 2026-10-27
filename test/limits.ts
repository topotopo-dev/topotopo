// Resource limits: huge counts and long simulations must fail or clamp, never take the process
// down or keep it busy for hours.
//   node test/limits.ts [--verbose]
//
// Asserts:
//   - every int / ivec param that counts something has a max (a registry scan; the params that are not counts are
//     listed below and must exist), so "count": 1e15 from a graph or an agent is clamped instead of running the
//     process out of heap (`resample {count: 1e15}` was a fatal OOM);
//   - absurd counts cook quickly at their max (resample, line, circle, copy_xform, smooth, group_expand, which also
//     stops once the group no longer changes), and point_grid refuses a product of counts above its limit;
//   - the long-running nodes (rbd_settle, rbd_stack, drape, inflate, particles, heightfield_erode, remesh_quad) stop
//     with an error naming them once engine.simTimeoutMs is spent, pool off and on; the WASM calls of remesh_quad and
//     heightfield_erode's kernel backend run on a pool worker that the limit stops (with the pool on), give the same bits
//     there as on the cooking thread, and a later cook works.
// Runs in a child process with a hard wall-clock limit, so a limit that does not hold fails the test instead of
// crashing or hanging it.
import { spawnSync } from 'node:child_process';
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { allNodeDefs } from '../src/graph/registry.ts';
import type { GraphSpec } from '../src/graph/types.ts';
import { createNodeHost } from '../src/host/node.ts';
import { fingerprint } from './fingerprint.ts';

const args = process.argv.slice(2);
const HARD_LIMIT_MS = 300_000;
if (!args.includes('--child')) {
  const res = spawnSync(process.execPath, [process.argv[1], '--child', ...args], { stdio: 'inherit', timeout: HARD_LIMIT_MS });
  if (res.error || res.signal || (res.status !== 0 && res.status !== 1)) {
    console.log(`FAIL limits: the test process ${res.signal || res.error ? `did not finish within ${HARD_LIMIT_MS / 1000}s` : `crashed (exit ${res.status})`}: a limit did not hold`);
    process.exit(1);
  }
  process.exit(res.status ?? 1);
}
const VERBOSE = args.includes('--verbose');

let fail = 0, pass = 0;
const check = (ok: any, msg: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
  if (ok) pass++; else fail++;
};
const section = (s: string) => console.log(`\n== ${s}`);

// ------------------------------------------------------------------ every count has a max
section('int params that count something have a max');
/** int params that are not counts: seeds, frames, indices (clamped by their nodes), an offset and a pixel height in a formula */
const NOT_COUNTS = [
  'rbd_settle.seed', 'rbd_stack.seed', 'drape.seed', 'inflate.seed',
  'particles.start_frame', 'rbd_settle.start_frame', 'rbd_stack.start_frame', 'solver.start_frame',
  'switch.index', 'input.index', 'lod.level', 'polybridge.twist', 'lod.screen_height',
];
{
  const unbounded: string[] = [], seen = new Set<string>();
  let counted = 0;
  for (const d of allNodeDefs())
    for (const [k, p] of Object.entries(d.params)) {
      if (p.type !== 'int' && p.type !== 'ivec2' && p.type !== 'ivec3') continue;
      const key = `${d.type}.${k}`;
      seen.add(key);
      if (NOT_COUNTS.includes(key)) continue;
      counted++;
      if (p.max === undefined || !Number.isFinite(p.max)) unbounded.push(key);
    }
  check(!unbounded.length, `${counted} int count params have a max${unbounded.length ? `; missing: ${unbounded.join(', ')}` : ''}`);
  const stale = NOT_COUNTS.filter((k) => !seen.has(k));
  check(!stale.length, `the ${NOT_COUNTS.length} params exempt as not counts exist${stale.length ? `; gone: ${stale.join(', ')}` : ''}`);
}

// ------------------------------------------------------------------ absurd counts
section('absurd counts are clamped to their max');
const off = new Engine(createNodeHost({ workers: 0, shelf: false }));
await off.init();
async function timed(e: Engine, g: GraphSpec) {
  e.cache.clear();
  const t = performance.now();
  const r = await e.cook(structuredClone(g));
  return { r, ms: performance.now() - t };
}
{
  const cases: { label: string; graph: GraphSpec; ok: (g: any) => boolean }[] = [
    { label: 'resample {count: 1e15} (a fatal OOM before)', graph: { nodes: { l: { type: 'line' }, r: { type: 'resample', in: ['l'], params: { mode: 'count', count: 1e15 } } }, output: 'r' }, ok: (g) => g.numPoints === 1_000_001 },
    { label: 'line {points: 1e15}', graph: { nodes: { l: { type: 'line', params: { points: 1e15 } } }, output: 'l' }, ok: (g) => g.numPoints === 1_000_000 },
    { label: 'circle {segments: "1e15"}', graph: { nodes: { c: { type: 'circle', params: { segments: '1e15' } } }, output: 'c' }, ok: (g) => g.numPoints === 1_000_000 },
    { label: 'copy_xform {count: 1e12}', graph: { nodes: { p: { type: 'points', params: { positions: [[0, 0, 0]] } }, c: { type: 'copy_xform', in: ['p'], params: { count: 1e12 } } }, output: 'c' }, ok: (g) => g.numPoints === 100_000 },
    { label: 'smooth {iterations: 1e15}', graph: { nodes: { b: { type: 'box' }, s: { type: 'smooth', in: ['b'], params: { iterations: 1e15 } } }, output: 's' }, ok: (g) => g.numPoints === 8 },
    {
      label: 'group_expand {steps: 1e15} (stops once the group no longer grows)',
      graph: { nodes: { g: { type: 'grid', params: { divisions: [30, 30] } }, a: { type: 'group', in: ['g'], params: { name: 'seed', class: 'prim', pattern: '0' } }, x: { type: 'group_expand', in: ['a'], params: { group: 'seed', class: 'prim', steps: 1e15 } } }, output: 'x' },
      ok: (g) => g.primGroups.get('seed')?.every((v: number) => v === 1),
    },
    {
      label: 'group_expand {steps: -1e15} (half the grid shrinks to nothing, then stops)',
      graph: { nodes: { g: { type: 'grid', params: { divisions: [30, 30] } }, a: { type: 'group', in: ['g'], params: { name: 'half', class: 'prim', pattern: '0-449' } }, x: { type: 'group_expand', in: ['a'], params: { group: 'half', class: 'prim', steps: -1e15 } } }, output: 'x' },
      ok: (g) => g.primGroups.get('half')?.every((v: number) => v === 0),
    },
  ];
  for (const c of cases) {
    const { r, ms } = await timed(off, c.graph);
    check(r.ok && c.ok(r.geo) && ms < 20000, `${c.label}: ${r.ok ? `${r.geo!.numPoints.toLocaleString('en-US')} points` : r.errors.map((x) => x.message).join('; ')} in ${ms.toFixed(0)} ms`);
  }
  const { r } = await timed(off, { nodes: { p: { type: 'point_grid', params: { counts: [1e15, 1e15, 1e15] } } }, output: 'p' });
  check(!r.ok && /^point_grid: counts \[100000, 100000, 100000\] give .* points, more than 20,000,000$/.test(r.errors[0]?.message ?? ''), `point_grid refuses a product of counts above its limit (${r.errors[0]?.message})`);
}

// ------------------------------------------------------------------ the time limit of long-running nodes
section('long-running nodes stop at engine.simTimeoutMs');
const LIMIT = 300;
/** heavy cooks: each takes from seconds to minutes with the default limit */
const HEAVY: Record<string, { graph: GraphSpec; poolOnly?: boolean }> = {
  rbd_settle: { graph: { nodes: { rock: { type: 'sphere', params: { type: 'ico', level: 1, radius: 0.2 } }, pts: { type: 'point_grid', params: { counts: [15, 3, 15], size: [6, 2, 6], center: [0, 2, 0] } }, c: { type: 'copy_to_points', in: ['rock', 'pts'], params: { pack: true } }, t: { type: 'rbd_settle', in: ['c'], params: { duration: 20, sleep_threshold: 0.0001 } } }, output: 't' } },
  rbd_stack: { graph: { nodes: { crate: { type: 'box', params: { size: [0.3, 0.3, 0.3] } }, one: { type: 'points', params: { positions: [[0, 0, 0]] } }, pts: { type: 'copy_xform', in: ['one'], params: { count: 400 } }, c: { type: 'copy_to_points', in: ['crate', 'pts'], params: { pack: true } }, t: { type: 'rbd_stack', in: ['c'], params: { interval: 60, duration: 5, sleep_threshold: 0.0001 } } }, output: 't' } },
  drape: { graph: { nodes: { cloth: { type: 'grid', params: { size: [2, 2], divisions: [60, 60], center: [0, 1.2, 0] } }, t: { type: 'drape', in: ['cloth'], params: { steps: 3000, substeps: 8, floor: true } } }, output: 't' } },
  inflate: { graph: { nodes: { m: { type: 'sphere', params: { rows: 40, cols: 80 } }, t: { type: 'inflate', in: ['m'], params: { steps: 3000, substeps: 8 } } }, output: 't' } },
  particles: { graph: { nodes: { src: { type: 'point_grid', params: { counts: [10, 1, 10] } }, t: { type: 'particles', in: ['src'], params: { steps: 20000, emit_rate: 5, life: 2, noise: 2, animate: false } } }, output: 't' } },
  heightfield_erode: { graph: { nodes: { hf: { type: 'heightfield', params: { size: [40, 40], resolution: 0.1 } }, n: { type: 'heightfield_noise', in: ['hf'], params: { amplitude: 4, element_size: 8 } }, t: { type: 'heightfield_erode', in: ['n'], params: { iterations: 3000 } } }, output: 't' } },
  // one WASM call each: only a pool worker can be stopped (pool off, they would run for minutes)
  'heightfield_erode (kernel)': { poolOnly: true, graph: { nodes: { hf: { type: 'heightfield', params: { size: [40, 40], resolution: 0.05 } }, n: { type: 'heightfield_noise', in: ['hf'], params: { amplitude: 4, element_size: 8 } }, t: { type: 'heightfield_erode', in: ['n'], params: { iterations: 5000, backend: 'kernel', method: 'pipe' } } }, output: 't' } },
  remesh_quad: { poolOnly: true, graph: { nodes: { m: { type: 'sphere', params: { rows: 150, cols: 300 } }, t: { type: 'remesh_quad', in: ['m'], params: { target_faces: 200000, smooth_iterations: 100 } } }, output: 't' } },
};
for (const workers of [0, 2]) {
  const mode = workers ? 'pool on' : 'pool off';
  const e = new Engine(createNodeHost({ workers, shelf: false, ...(workers ? { pool: { minElements: 1 } } : {}) }));
  await e.init();
  e.simTimeoutMs = LIMIT;
  for (const [label, c] of Object.entries(HEAVY)) {
    if (c.poolOnly && !workers) continue;
    const type = label.split(' ')[0];
    const { r, ms } = await timed(e, c.graph);
    const err = r.errors.find((x) => x.node === 't');
    const ok = !r.ok && !!err && err.message.startsWith(`${type}: stopped after ${LIMIT} ms, the time limit of long-running nodes`) && !!err.hint;
    // stopped at the first check past the limit: a batch, a few solver steps, an iteration; a worker at once
    check(ok && ms < LIMIT + 8000, `${mode}: ${label} stops after ${ms.toFixed(0)} ms (${err?.message ?? 'cooked'})`);
    if (VERBOSE) console.log(`   hint: ${err?.hint}`);
  }
  if (workers) {
    // the WASM calls give the same bits on a worker as here, and the pool works after the stopped ones
    e.simTimeoutMs = 600000;
    const small: Record<string, GraphSpec> = {
      remesh_quad: { nodes: { m: { type: 'sphere', params: { rows: 12, cols: 24 } }, t: { type: 'remesh_quad', in: ['m'], params: { target_faces: 400 } } }, output: 't' },
      'erode droplet': { nodes: { hf: { type: 'heightfield', params: { size: [10, 10], resolution: 0.2 } }, n: { type: 'heightfield_noise', in: ['hf'], params: { amplitude: 2, element_size: 4 } }, t: { type: 'heightfield_erode', in: ['n'], params: { iterations: 20, backend: 'kernel' } } }, output: 't' },
      'erode pipe': { nodes: { hf: { type: 'heightfield', params: { size: [10, 10], resolution: 0.2 } }, n: { type: 'heightfield_noise', in: ['hf'], params: { amplitude: 2, element_size: 4 } }, t: { type: 'heightfield_erode', in: ['n'], params: { iterations: 20, backend: 'kernel', method: 'pipe' } } }, output: 't' },
    };
    for (const [label, g] of Object.entries(small)) {
      const tasks = e.host.pool!.stats().tasks;
      const a = await timed(e, g), b = await timed(off, g);
      const same = a.r.ok && b.r.ok && JSON.stringify(fingerprint(a.r.geo!)) === JSON.stringify(fingerprint(b.r.geo!));
      check(same && e.host.pool!.stats().tasks > tasks, `${label} on a pool worker = on the cooking thread, bit for bit (${a.r.errors.map((x) => x.message).join('; ') || 'ok'})`);
    }
  }
  await e.host.pool?.close();
}
{
  // the default limit is generous, and the env var reaches the MCP server
  check(new Engine(createNodeHost({ workers: 0, shelf: false })).simTimeoutMs === 600000, 'engine.simTimeoutMs defaults to 10 minutes');
}

console.log(`\nlimits: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
