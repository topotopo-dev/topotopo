// Worker pool tests: lazy start and close, kernel round trips (transfer), CookContext.parallelMap against the serial
// loop for every ported node (bit-identical arrays, same fingerprints and reports with the pool on and off),
// concurrent branches and in-flight sharing, the lazy switch, worker errors, crashes and timeouts, the size
// threshold, POLYFORGE_WORKERS=0, the CLI exiting with the pool in use, and the MCP server ending on stdin close.
//   node test/pool.ts            these tests
//   node test/pool.ts --golden   also the golden layer with every kernel forced onto the pool (npm run test:pool)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import type { CookReport } from '../src/graph/engine.ts';
import { defineNode } from '../src/graph/registry.ts';
import type { GraphSpec } from '../src/graph/types.ts';
import { NodeError } from '../src/graph/types.ts';
import { createNodeHost } from '../src/host/node.ts';
import { createNodePool, poolOptionsFromEnv, workersFromEnv } from '../src/host/pool.ts';
import { parallelMap } from '../src/graph/parallel.ts';
import { GEOMETRY_FUNCTIONS } from '../src/core/snippet-lib.ts';
import { Geometry } from '../src/core/geometry.ts';
import { fingerprint } from './fingerprint.ts';
import { ROOT } from './fixtures.ts';

let failures = 0, passes = 0;
const check = (cond: any, msg: string) => {
  if (cond) passes++;
  else failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`);
};
const section = (s: string) => console.log(`\n== ${s}`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'polyforge-pool-'));

// test-only nodes (registered in this process only)
let sleeps = 0;
defineNode({
  type: 'test_pool_sleep', category: 'flow', summary: 'test only: waits, then outputs a box (counts cooks)',
  inputs: [], params: { ms: { type: 'int', default: 100, desc: 'wait' }, tag: { type: 'string', default: '', desc: 'signature tag' } },
  cook: async ({ p }) => {
    sleeps++;
    await new Promise((r) => setTimeout(r, p.ms));
    const g = new Geometry({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], prims: [[0, 1, 2]] });
    return g;
  },
});
defineNode({
  type: 'test_pool_kernel', category: 'flow', summary: 'test only: runs a kernel on the pool',
  inputs: [], params: {
    kernel: { type: 'string', default: 'selftest.square', desc: 'kernel' },
    count: { type: 'int', default: 1000, desc: 'elements' },
    args: { type: 'json', default: {}, desc: 'kernel args' },
    timeout: { type: 'int', default: 0, desc: 'ms' },
  },
  cook: async ({ p, parallelMap: pm }) => {
    const src = Float64Array.from({ length: p.count }, (_, i) => i * 0.5);
    const out = new Float64Array(p.count);
    await pm(p.kernel, { count: p.count, args: p.args, inputs: { in: src }, results: { out } }, { minElements: 1, timeoutMs: p.timeout });
    const g = new Geometry({ positions: [0, 0, 0] });
    g.detail.add('sum', 'float', 1).set(0, out.reduce((a, b) => a + b, 0));
    return g;
  },
});
defineNode({
  type: 'test_pool_fail', category: 'flow', summary: 'test only: fails', inputs: [], params: { tag: { type: 'string', default: '', desc: 'tag' } },
  cook: ({ p }) => { throw new NodeError(`failing on purpose ${p.tag}`); },
});

const newEngine = async (workers: number, minElements?: number) => {
  const e = new Engine(createNodeHost({ baseDir: tmp, workers, pool: minElements !== undefined ? { minElements } : undefined }));
  await e.init();
  return e;
};
const off = await newEngine(0);
const on = await newEngine(4, 1); // every kernel goes to the pool, whatever its size
const onDefault = await newEngine(4); // default thresholds

/** exact equality of every attribute array, group and topology array */
function sameBits(a: Geometry, b: Geometry): string | null {
  const eq = (x: ArrayLike<any>, y: ArrayLike<any>) => {
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (!Object.is(x[i], y[i])) return false;
    return true;
  };
  if (!eq(a.primStart, b.primStart) || !eq(a.vertexPoint, b.vertexPoint) || !eq(a.primClosed, b.primClosed)) return 'topology';
  for (const cls of ['point', 'vertex', 'prim', 'detail'] as const) {
    const ta = a.table(cls), tb = b.table(cls);
    if (ta.names().join() !== tb.names().join()) return `${cls} attribute names ${ta.names()} vs ${tb.names()}`;
    for (const n of ta.names()) if (!eq(ta.get(n)!.data, tb.get(n)!.data)) return `${cls} attribute ${n}`;
  }
  for (const cls of ['point', 'prim', 'vertex'] as const) {
    const ga = a.groups(cls), gb = b.groups(cls);
    if ([...ga.keys()].join() !== [...gb.keys()].join()) return `${cls} groups`;
    for (const [k, m] of ga) if (!eq(m, gb.get(k)!)) return `${cls} group ${k}`;
  }
  return null;
}
const reportText = (r: CookReport) => JSON.stringify({
  ok: r.ok, errors: r.errors, warnings: r.warnings,
  results: [...r.results.values()].map((x) => [x.node, x.cached, x.error?.message ?? '', x.warnings, x.timeDependent]),
});

/** cook on both engines (cold caches) and compare outputs bit for bit and reports */
async function same(label: string, graph: GraphSpec, opts: { frame?: number; expectParallel?: boolean } = {}) {
  off.cache.clear(); on.cache.clear();
  const before = on.poolStats.parallel;
  const a = await off.cook(structuredClone(graph), { frame: opts.frame });
  const b = await on.cook(structuredClone(graph), { frame: opts.frame });
  const ran = on.poolStats.parallel - before;
  const bits = a.geo && b.geo ? sameBits(a.geo, b.geo) : a.geo || b.geo ? 'one side has no geometry' : null;
  const fp = JSON.stringify(a.geo ? fingerprint(a.geo) : null) === JSON.stringify(b.geo ? fingerprint(b.geo) : null);
  const rep = reportText(a) === reportText(b);
  const par = opts.expectParallel === undefined || (opts.expectParallel ? ran > 0 : ran === 0);
  check(!bits && fp && rep && par && a.ok === b.ok,
    `${label}: pool off = pool on${bits ? ` — differs in ${bits}` : ''}${fp ? '' : ' — fingerprints differ'}${rep ? '' : ' — reports differ'}` +
    `${par ? '' : ` — expected ${opts.expectParallel ? 'a pool run' : 'no pool run'}, got ${ran}`} (${ran} pool job${ran === 1 ? '' : 's'}${a.ok ? '' : `, error: ${a.errors[0]?.message}`})`);
  if (!rep) { console.log('   off:', reportText(a).slice(0, 600)); console.log('   on: ', reportText(b).slice(0, 600)); }
  return { a, b };
}

// ------------------------------------------------------------------ pool basics
section('pool basics');
{
  check(workersFromEnv({ POLYFORGE_WORKERS: '0' }) === 0 && workersFromEnv({ POLYFORGE_WORKERS: '3' }) === 3, 'POLYFORGE_WORKERS: 0 disables, a number sets the size');
  check(workersFromEnv({}) === Math.max(0, os.availableParallelism() - 1), `default size: availableParallelism() - 1 (${workersFromEnv({})})`);
  check(poolOptionsFromEnv({ POLYFORGE_POOL_MIN: '1', POLYFORGE_WORKERS_IDLE_MS: '500' }).minElements === 1, 'POLYFORGE_POOL_MIN read');
  check(createNodeHost({ workers: 0 }).pool === undefined && !off.concurrent, 'workers 0: no pool, sequential cooking');
  check(!!on.host.pool && on.concurrent, 'workers 4: pool, concurrent cooking');

  const pool = createNodePool({ size: 2, idleMs: 300 })!;
  check(pool.stats().workers === 0 && pool.stats().started === 0, 'lazy: no worker thread before the first task');
  const x = Float64Array.from([1, 2, 3, 4]);
  const r1: any = await pool.run({ kernel: 'selftest.scale', args: { factor: 2 }, range: [0, 4], arrays: { x }, transfer: true });
  check(x.byteLength === 0 && Array.from(r1.arrays.x).join() === '2,4,6,8' && r1.value === 20, 'round trip with transfer: the array moved there and back, scaled');
  const y = Float64Array.from([1, 2, 3]);
  const r2: any = await pool.run({ kernel: 'selftest.scale', args: { factor: 3 }, range: [0, 3], arrays: { x: y } });
  check(Array.from(y).join() === '1,2,3' && Array.from(r2.arrays.x).join() === '3,6,9', 'without transfer the caller keeps its array (copied)');
  const sab = new Float64Array(new SharedArrayBuffer(16)); sab.set([5, 6]);
  await pool.run({ kernel: 'selftest.scale', args: { factor: 10 }, range: [0, 2], arrays: { x: sab } });
  check(sab[0] === 50 && sab[1] === 60, 'shared memory is written in place');
  check(pool.stats().started >= 1, `workers started on demand (${pool.stats().started})`);
  const bad = await pool.run({ kernel: 'no_such_kernel' }).then(() => '', (e) => e.message);
  check(/kernel "no_such_kernel" failed: unknown kernel/.test(bad), `unknown kernel: ${bad}`);
  await new Promise((r) => setTimeout(r, 700));
  check(pool.stats().workers === 0, 'idle workers stop after the idle time');
  const r3: any = await pool.run({ kernel: 'selftest.scale', args: { factor: 1 }, range: [0, 1], arrays: { x: Float64Array.of(7) } });
  check(r3.value === 7, 'the pool restarts after the idle shutdown');
  await pool.close();
  check(pool.stats().workers === 0, 'close() stops the workers');
  const r4: any = await pool.run({ kernel: 'selftest.scale', args: { factor: 1 }, range: [0, 1], arrays: { x: Float64Array.of(9) } });
  check(r4.value === 9, 'and it restarts lazily after close()');
  await pool.close();

  // shared data: sent once per worker, then named by key
  const p1 = createNodePool({ size: 1 })!;
  const tri = { T: Float64Array.from([0, 0, 0, 1, 0, 0, 0, 0, 1]) };
  for (let i = 0; i < 3; i++) await p1.run({ kernel: 'selftest.scale', args: { factor: 1 }, range: [0, 0], arrays: { x: new Float64Array(1) }, shared: { key: 'k1', arrays: tri } });
  check(p1.stats().tasks === 3, 'tasks with shared data reuse the worker cache');
  await p1.close();

  // parallelMap = serial loop, chunked
  const n = 10007, src = Float64Array.from({ length: n }, (_, i) => Math.sin(i));
  const o1 = new Float64Array(n), o2 = new Float64Array(n);
  const s1: any = parallelMap(undefined, 'selftest.square', { count: n, inputs: { in: src }, results: { out: o1 } });
  const s2: any = await parallelMap(on.host.pool, 'selftest.square', { count: n, inputs: { in: src }, results: { out: o2 } });
  check(!(s1 instanceof Promise) && !s1.parallel && s2.parallel && s2.chunks === 4 && o1.every((v, i) => Object.is(v, o2[i])), `parallelMap: ${s2.chunks} chunks on the pool = one serial run, bit for bit`);
}

// ------------------------------------------------------------------ ported nodes: pool on = pool off
section('ported nodes: pool on = pool off, bit for bit');
{
  const grid = { type: 'grid', params: { size: [4, 4], divisions: [60, 60] } };
  const sphere = { type: 'sphere', params: { type: 'uv', rows: 30, cols: 40 } };
  for (const mode of ['normal', 'direction', '3d', 'curl']) {
    await same(`noise_displace ${mode}`, { nodes: { g: grid, n: { type: 'noise_displace', in: ['g'], params: { mode, amplitude: 0.3, frequency: [2, 1.5, 3], offset: [0.1, 0, 0.3], octaves: 4 } } }, output: 'n' }, { expectParallel: true });
  }
  await same('noise_displace worley, not centered, group, mask, store, rest', {
    nodes: {
      s: sphere,
      m: { type: 'attrib_noise', in: ['s'], params: { name: 'mask', frequency: [3, 3, 3] } },
      r: { type: 'rest', in: ['m'] },
      t: { type: 'transform', in: ['r'], params: { translate: [0.5, 0, 0] } },
      n: { type: 'noise_displace', in: ['t'], params: { noise: 'worley', centered: false, group: '@P.y>0', mask_attrib: 'mask', store: 'nv', fractal: 'ridged' } },
    }, output: 'n',
  }, { expectParallel: true });
  await same('noise_displace with point normals', { nodes: { s: sphere, nn: { type: 'normal', in: ['s'] }, n: { type: 'noise_displace', in: ['nn'], params: { amplitude: 0.2, noise: 'simplex' } } }, output: 'n' }, { expectParallel: true });
  for (const size of [1, 3]) {
    await same(`attrib_noise size ${size}`, { nodes: { g: grid, a: { type: 'attrib_noise', in: ['g'], params: { name: 'w', size, range: [-1, 2], contrast: 1.7, noise: size === 3 ? 'value' : 'perlin', fractal: 'turbulence' } } }, output: 'a' }, { expectParallel: true });
  }
  const rock = { s: sphere, n: { type: 'noise_displace', in: ['s'], params: { amplitude: 0.3, frequency: 2 } } };
  for (const mode of ['occlusion', 'cavity', 'thickness']) {
    await same(`occlusion ${mode}`, { nodes: { ...rock, o: { type: 'occlusion', in: ['n'], params: { mode, samples: 24, seed: 3 } } }, output: 'o' }, { expectParallel: true });
  }
  await same('occlusion with occluder, group, invert', {
    nodes: { ...rock, ground: { type: 'grid', params: { size: [6, 6], center: [0, -1.1, 0] } }, o: { type: 'occlusion', in: ['n', 'ground'], params: { samples: 16, group: '@P.y<0', invert: true } } },
    output: 'o',
  }, { expectParallel: true });
  const w = (code: string, extra: any = {}) => ({ nodes: { g: grid, w: { type: 'wrangle', in: ['g'], params: { code, ...extra } } }, output: 'w' });
  await same('wrangle (bench snippet)', w('@P.y += sin(@P.x * 3) * 0.1;\n@Cd = [@P.x, @P.y, 0.5];'), { expectParallel: true });
  await same('wrangle with noise, rand, groups, typed new attributes', w('f@h = noise(mul(@P, 2));\n@group_top = @P.y + @h > 0.1;\n@pscale = rand(@ptnum) * 0.5;\ni@k = @ptnum % 7;\nif (@P.x > 1) return;\n@P.z += fit(@h, -1, 1, 0, 0.2);'), { expectParallel: true });
  await same('wrangle on a group, with vars and @Frame', { ...w('@P.y += @Frame * 0.01 + vars.k;', { group: '@P.x>0' }), vars: { k: 0.25 } }, { frame: 3, expectParallel: true });
  await same('wrangle reading another input', {
    nodes: { g: grid, t: { type: 'transform', in: ['g'], params: { translate: [0, 1, 0] } }, w: { type: 'wrangle', in: ['g', 't'], params: { code: 'v@d = sub(@opinput1_P, @P);' } } }, output: 'w',
  }, { expectParallel: true });
  const err = await same('wrangle runtime error (same message, same line)', w('const a = 1;\nif (@ptnum == 2000) throw new Error("boom " + @ptnum);'), { expectParallel: false });
  check(/wrangle error: boom 2000 \(line 2:/.test(err.b.errors[0]?.message ?? ''), `  the error names the snippet line: ${err.b.errors[0]?.message}`);
  await same('wrangle with addpoint stays on the cooking thread', w('if (@ptnum % 500 == 0) addpoint(0, add(@P, [0, 1, 0]));'), { expectParallel: false });
  await same('wrangle with a string attribute stays on the cooking thread', w('s@name = "p" + @ptnum;'), { expectParallel: false });
  await same('wrangle writing vars stays on the cooking thread', w('vars.n = (vars.n || 0) + 1; @P.y += vars.n * 0;'), { expectParallel: false });
  await same('prim wrangle stays on the cooking thread', w('@Cd = [1, 0, 0];', { run_over: 'prims' }), { expectParallel: false });
  // the geometry-function list covers every library function that goes through the wrangle API
  const realm = createNodeHost({ workers: 0 }).compile('globalThis');
  const viaApi = Object.keys(realm).filter((k) => typeof realm[k] === 'function' && /\bC\(\)/.test(String(realm[k])));
  const missing = viaApi.filter((k) => !GEOMETRY_FUNCTIONS.includes(k));
  check(viaApi.length > 30 && !missing.length, `GEOMETRY_FUNCTIONS lists every API function (${viaApi.length})${missing.length ? '; missing: ' + missing.join(', ') : ''}`);
}

// ------------------------------------------------------------------ threshold
section('small inputs stay on the cooking thread');
{
  const s0 = { ...onDefault.poolStats };
  onDefault.cache.clear();
  await onDefault.cook({ nodes: { s: { type: 'sphere' }, n: { type: 'noise_displace', in: ['s'] } }, output: 'n' });
  check(onDefault.poolStats.serial === s0.serial + 1 && onDefault.poolStats.parallel === s0.parallel, `a small noise_displace bypasses the pool (serial ${onDefault.poolStats.serial - s0.serial}, parallel ${onDefault.poolStats.parallel - s0.parallel})`);
  await onDefault.cook({ nodes: { g: { type: 'grid', params: { divisions: [200, 200] } }, n: { type: 'noise_displace', in: ['g'] } }, output: 'n' });
  check(onDefault.poolStats.parallel === s0.parallel + 1, `40k points go to the pool (${onDefault.poolStats.parallel - s0.parallel} job, ${onDefault.poolStats.chunks - s0.chunks} chunks)`);
  const s1 = { ...onDefault.poolStats };
  await onDefault.cook({ nodes: { s: { type: 'sphere', params: { rows: 20, cols: 20 } }, o: { type: 'occlusion', in: ['s'], params: { samples: 8 } } }, output: 'o' });
  check(onDefault.poolStats.serial === s1.serial + 1, 'a small occlusion bypasses the pool (ray count threshold)');
}

// ------------------------------------------------------------------ concurrency and in-flight sharing
section('concurrent branches');
{
  const branches: GraphSpec = { nodes: { a: { type: 'test_pool_sleep', params: { ms: 150, tag: 'a' } }, b: { type: 'test_pool_sleep', params: { ms: 150, tag: 'b' } }, m: { type: 'merge', in: ['a', 'b'] } }, output: 'm' };
  off.cache.clear(); on.cache.clear();
  let t = performance.now();
  const seq = await off.cook(branches);
  const tSeq = performance.now() - t;
  t = performance.now();
  const con = await on.cook(branches);
  const tCon = performance.now() - t;
  check(seq.ok && con.ok && tSeq >= 290 && tCon < 260, `two async branches overlap: sequential ${tSeq.toFixed(0)} ms, concurrent ${tCon.toFixed(0)} ms`);
  check(reportText(seq) === reportText(con), 'same report');

  const dup: GraphSpec = { nodes: { a: { type: 'test_pool_sleep', params: { ms: 120, tag: 'same' } }, b: { type: 'test_pool_sleep', params: { ms: 120, tag: 'same' } }, m: { type: 'merge', in: ['a', 'b'] } }, output: 'm' };
  on.cache.clear();
  sleeps = 0;
  const d = await on.cook(dup);
  const ra = d.results.get('a')!, rb = d.results.get('b')!;
  check(d.ok && sleeps === 1 && ra.sig === rb.sig && !ra.cached && rb.cached, `two concurrent cooks of one signature cook once (${sleeps} cook; a cached ${ra.cached}, b cached ${rb.cached})`);
  off.cache.clear();
  check(reportText(await off.cook(dup)) === reportText(d), 'and report like a sequential cook (the first one cooked, the second a cache hit)');
  // the role swap: b reaches the cache check first, but a comes first in a sequential cook
  const swap: GraphSpec = { nodes: { a0: { type: 'null', in: ['a'] }, a1: { type: 'null', in: ['a0'] }, a: { type: 'test_pool_sleep', params: { ms: 80, tag: 'x' } }, b: { type: 'test_pool_sleep', params: { ms: 80, tag: 'x' } }, m: { type: 'merge', in: ['a1', 'b'] } }, output: 'm' };
  on.cache.clear(); off.cache.clear();
  check(reportText(await on.cook(swap)) === reportText(await off.cook(swap)), 'shared cooks are attributed as in a sequential cook');

  // failing inputs: only what a sequential cook reaches is reported
  const fails: GraphSpec = { nodes: { f1: { type: 'test_pool_fail', params: { tag: '1' } }, f2: { type: 'test_pool_fail', params: { tag: '2' } }, ok: { type: 'box' }, m: { type: 'merge', in: ['f1', 'ok', 'f2'] } }, output: 'm' };
  on.cache.clear(); off.cache.clear();
  const fo = await off.cook(fails), fc = await on.cook(fails);
  check(reportText(fo) === reportText(fc) && fc.errors.length === 1 && !fc.results.has('f2'), `failed inputs: same errors as sequential (${fc.errors.map((e) => e.node).join(', ')})`);
  // expression references are pulled alongside the inputs
  const refs: GraphSpec = { nodes: { a: { type: 'test_pool_sleep', params: { ms: 120, tag: 'r1' } }, b: { type: 'test_pool_sleep', params: { ms: 120, tag: 'r2' } }, t: { type: 'transform', in: ['a'], params: { translate: [0, "=npoints('b')", 0] } } }, output: 't' };
  on.cache.clear(); off.cache.clear();
  t = performance.now();
  const rc = await on.cook(refs);
  const tr = performance.now() - t;
  check(rc.ok && tr < 220 && reportText(rc) === reportText(await off.cook(refs)), `inputs and referenced nodes cook together (${tr.toFixed(0)} ms), same report`);
  // foreach iterations overlap
  const fe: GraphSpec = { nodes: { f: { type: 'foreach', params: { mode: 'count', count: 3, body: { nodes: { s: { type: 'test_pool_sleep', params: { ms: 100, tag: '=iteration' } } }, output: 's' } } } }, output: 'f' };
  on.cache.clear(); off.cache.clear();
  t = performance.now();
  const fc2 = await on.cook(fe);
  const tf = performance.now() - t;
  const fo2 = await off.cook(fe);
  check(fc2.ok && tf < 250 && reportText(fc2) === reportText(fo2) && fingerprint(fc2.geo!).hashes.P === fingerprint(fo2.geo!).hashes.P, `foreach iterations overlap (${tf.toFixed(0)} ms for 3 × 100 ms), same result`);
}

section('switch cooks only the selected input');
{
  const g: GraphSpec = { nodes: { bad: { type: 'test_pool_fail' }, box: { type: 'box' }, sw: { type: 'switch', in: ['bad', 'box'], params: { index: 1 } } }, output: 'sw' };
  for (const [name, e] of [['sequential', off], ['concurrent', on]] as const) {
    e.cache.clear();
    const r = await e.cook(g);
    check(r.ok && r.geo!.numPoints === 8 && !r.results.has('bad'), `${name}: an unselected failing candidate is not cooked`);
  }
  const r0 = await off.cook({ ...g, nodes: { ...g.nodes, sw: { ...g.nodes.sw, params: { index: 0 } } } });
  check(!r0.ok && /input 0/.test(r0.errors.map((e) => e.message).join() + JSON.stringify([...r0.results.values()].map((x) => x.error?.message))), 'the selected failing candidate fails the switch');
}

// ------------------------------------------------------------------ failures
section('worker errors, crashes and timeouts fail only the node');
{
  on.cache.clear();
  const k = (params: any): GraphSpec => ({ nodes: { k: { type: 'test_pool_kernel', params } } });
  const e1 = await on.cook(k({ kernel: 'selftest.throw', count: 4000, args: { at: 3000 } }));
  check(!e1.ok && /kernel "selftest.throw" failed: selftest failure at element 3000/.test(e1.errors[0]?.message ?? ''), `kernel error → node error: ${e1.errors[0]?.message}`);
  const ok1 = await on.cook(k({ count: 4000 }));
  check(ok1.ok, 'the next cook works');
  const crashes = on.host.pool!.stats().crashes;
  const e2 = await on.cook(k({ kernel: 'selftest.crash', count: 8 }));
  check(!e2.ok && /worker thread crashed/.test(e2.errors[0]?.message ?? '') && on.host.pool!.stats().crashes > crashes, `crash → node error: ${e2.errors[0]?.message}`);
  const ok2 = await on.cook(k({ count: 4001 }));
  check(ok2.ok && ok2.geo!.detail.get('sum')!.get(0) === Array.from({ length: 4001 }, (_, i) => (i * 0.5) ** 2 + i).reduce((a, b) => a + b, 0), 'the pool replaced the worker: the next cook works');
  const t0 = performance.now();
  const e3 = await on.cook(k({ kernel: 'selftest.spin', count: 4, args: { ms: 3000 }, timeout: 300 }));
  check(!e3.ok && /timed out after 300 ms/.test(e3.errors[0]?.message ?? '') && performance.now() - t0 < 2500, `timeout → node error: ${e3.errors[0]?.message}`);
  const ok3 = await on.cook(k({ count: 4002 }));
  check(ok3.ok, 'the next cook works after a timeout');
  const graph: GraphSpec = { nodes: { a: { type: 'test_pool_kernel', params: { kernel: 'selftest.throw', count: 100, args: { at: 5 } } }, b: { type: 'box' }, m: { type: 'merge', in: ['b'] } }, output: 'm' };
  check((await on.cook(graph)).ok, 'a failing kernel node outside the output branch does not affect the cook');
}

// ------------------------------------------------------------------ processes
section('processes end with the pool in use');
{
  const gfile = path.join(tmp, 'noise.json');
  fs.writeFileSync(gfile, JSON.stringify({ nodes: { g: { type: 'grid', params: { divisions: [100, 100] } }, n: { type: 'noise_displace', in: ['g'] }, w: { type: 'wrangle', in: ['n'], params: { code: '@Cd = [@P.y, 0, 0];' } } }, output: 'w' }));
  const env = { ...process.env, POLYFORGE_WORKERS: '3', POLYFORGE_POOL_MIN: '1' };
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [path.join(ROOT, 'src', 'cli.ts'), gfile], { encoding: 'utf8', env, timeout: 60000 });
  check(r.status === 0 && /cooked/.test(r.stdout), `CLI with the pool forced exits (status ${r.status}, ${(performance.now() - t0).toFixed(0)} ms)${r.status ? ': ' + r.stderr.slice(0, 300) : ''}`);
  const z = spawnSync(process.execPath, [path.join(ROOT, 'src', 'cli.ts'), gfile], { encoding: 'utf8', env: { ...process.env, POLYFORGE_WORKERS: '0' }, timeout: 60000 });
  check(z.status === 0 && z.stdout.split('\n').slice(1).join('\n') === r.stdout.split('\n').slice(1).join('\n'), 'POLYFORGE_WORKERS=0: the CLI prints the same summary');
  // MCP server: closing stdin ends the process
  const ws = path.join(tmp, 'ws');
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'mcp', 'server.ts'), '--workspace', ws], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  await new Promise<void>((res) => { const iv = setInterval(() => { if (/ready/.test(err)) { clearInterval(iv); res(); } }, 50); setTimeout(() => { clearInterval(iv); res(); }, 20000); });
  const exited = new Promise<number | null>((res) => child.on('exit', (c) => res(c)));
  child.stdin.end();
  const code = await Promise.race([exited, new Promise<string>((res) => setTimeout(() => res('still running'), 10000))]);
  if (code === 'still running') child.kill();
  check(code === 0 && /shutting down \(stdin closed\)/.test(err), `MCP server exits when the client closes stdin (${code})`);
}

// ------------------------------------------------------------------ golden layer with the pool forced
if (process.argv.includes('--golden')) {
  section('golden layer with every kernel on the pool (POLYFORGE_WORKERS=4, POLYFORGE_POOL_MIN=1)');
  const g = spawnSync(process.execPath, [path.join(ROOT, 'test', 'golden.ts')], { encoding: 'utf8', env: { ...process.env, POLYFORGE_WORKERS: '4', POLYFORGE_POOL_MIN: '1' }, timeout: 900000 });
  const tail = g.stdout.trim().split('\n').slice(-3).join(' | ');
  check(g.status === 0, `golden: exit ${g.status} — ${tail}${g.status ? '\n' + g.stdout.split('\n').filter((l) => /FAIL|differs|mismatch/i.test(l)).slice(0, 20).join('\n') + g.stderr.slice(0, 500) : ''}`);
}

await on.host.pool?.close();
await onDefault.host.pool?.close();
console.log(`\n${passes} passed, ${failures} failed — temp ${tmp}`);
process.exit(failures ? 1 : 0);
