// Behavioural tests for the PCG toolkit: scatter v2 (generate_by, density attribute and mask, relaxation, exact
// minimum distance, per-prim cap, emitted attributes), mask, attribute_from_map, orient, points_along_curve, cluster,
// prune, and copy_to_points variant weights / scale_attrib / rotate_attrib (packed = real copies after unpack).
//   node test/pcg.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { getNodeDef } from '../src/graph/registry.ts';
import { Geometry } from '../src/core/geometry.ts';
import { KDTree } from '../src/core/spatial.ts';
import { expandPacked } from '../src/core/packed.ts';
import { band, combineMask, kmeans, minDistanceSelect, sphereOverlapPrune } from '../src/core/pcg.ts';
import { candidatesRange, minDistanceSelectWith, surfaceCandidates } from '../src/core/scatter.ts';
import { rng, rngAt, rngState } from '../src/core/random.ts';
import { qRotate } from '../src/core/math.ts';
import type { Quat, Vec3 } from '../src/core/math.ts';
import { encodeGreyPNG } from '../src/io/heightmap.ts';
import { encodePNG } from '../src/render/png.ts';
import { fingerprint } from './fingerprint.ts';
import { checkGeo } from './fixtures.ts';
import type { CookReport } from '../src/graph/engine.ts';
import type { NodeSpec } from '../src/graph/types.ts';
import { getLoadedKernels, kernelsWasmURL, loadKernels } from '../src/wasm/kernels.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'topotopo-pcg-'));
const engine = new Engine(createNodeHost({ baseDir: tmp }));
await engine.init();

let fail = 0, pass = 0;
const check = (ok: any, msg: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
  if (ok) pass++; else fail++;
};
const section = (s: string) => console.log(`\n== ${s}`);

async function run(nodes: Record<string, NodeSpec>, output: string): Promise<CookReport> {
  return engine.cook({ nodes, output });
}
async function geo(nodes: Record<string, NodeSpec>, output: string): Promise<Geometry> {
  const r = await run(nodes, output);
  if (!r.ok || !r.geo) throw new Error(`cook failed: ${r.errors.map((e) => `[${e.node}] ${e.message}`).join('; ')}`);
  const bad = checkGeo(r.geo);
  if (bad.length) throw new Error(`invalid geometry from ${output}: ${bad.join(', ')}`);
  return r.geo;
}
async function cookErr(nodes: Record<string, NodeSpec>, output: string): Promise<string> {
  const r = await run(nodes, output);
  return r.ok ? '' : r.errors.map((e) => e.message).join('; ');
}
const attr = (g: Geometry, name: string) => g.points.get(name)?.data as Float64Array;
const eq = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);
const fpEq = (a: Geometry, b: Geometry) => eq(fingerprint(a), fingerprint(b));
const maxDiff = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  if (a.length !== b.length) return Infinity;
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};
/** Distance from each point to its nearest other point. */
function nnDistances(P: ArrayLike<number>): number[] {
  const kd = new KDTree(P), n = P.length / 3, out: number[] = [];
  for (let i = 0; i < n; i++) {
    const k = kd.knn(P[i * 3], P[i * 3 + 1], P[i * 3 + 2], 2).filter((j) => j !== i)[0];
    out.push(k === undefined ? Infinity : Math.hypot(P[i * 3] - P[k * 3], P[i * 3 + 1] - P[k * 3 + 1], P[i * 3 + 2] - P[k * 3 + 2]));
  }
  return out;
}
const minOf = (a: number[]) => a.reduce((m, x) => Math.min(m, x), Infinity);
const mean = (a: ArrayLike<number>) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return a.length ? s / a.length : 0; };
const vec = (d: ArrayLike<number>, i: number, s = 3) => Array.from({ length: s }, (_, c) => d[i * s + c]);
const dot3 = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len3 = (a: ArrayLike<number>) => Math.hypot(a[0], a[1], a[2]);

const GRID: NodeSpec = { type: 'grid', params: { size: [10, 10], divisions: [10, 10] } };

// ---------------------------------------------------------------- kernels
section('kernels');
{
  check(band(5, 0, 10, 0) === 1 && band(-1, 0, 10, 0) === 0 && band(11, 0, 10, 2) === 0.5 && band(-0.5, 0, 10, 2) === 0.75 && band(NaN, 0, 1, 1) === 0, 'band: inside 1, linear falloff outside, hard edge without falloff, NaN 0');
  check(combineMask('multiply', 0.5, 0.5) === 0.25 && combineMask('max', 0.2, 0.7) === 0.7 && combineMask('min', 0.2, 0.7) === 0.2 && combineMask('add', 0.7, 0.7) === 1 && combineMask('subtract', 0.2, 0.7) === 0 && combineMask('replace', 0.9, 0.3) === 0.3 && combineMask('multiply', undefined, 0.4) === 0.4, 'combineMask: modes, clamped, missing old mask = the new value');
  const P = new Float64Array(3000);
  for (let i = 0; i < P.length; i++) P[i] = Math.sin(i * 12.9898) * 43758.5453 % 1;
  const keep = minDistanceSelect(P, Int32Array.from({ length: 1000 }, (_, i) => i), 0.1);
  const sub = new Float64Array(keep.length * 3);
  keep.forEach((k, i) => sub.set(P.subarray(k * 3, k * 3 + 3), i * 3));
  check(keep.length > 50 && minOf(nnDistances(sub)) >= 0.1, `minDistanceSelect: ${keep.length} of 1000 kept, nearest pair ${minOf(nnDistances(sub)).toFixed(4)} ≥ 0.1`);
  const radius = Float64Array.from({ length: 1000 }, (_, i) => 0.02 + 0.05 * ((i * 7) % 10) / 10);
  const k2 = sphereOverlapPrune(P, radius, Int32Array.from({ length: 1000 }, (_, i) => i));
  let overl = 0, kept = 0;
  for (let i = 0; i < 1000; i++) if (k2[i]) { kept++; for (let j = i + 1; j < 1000; j++) if (k2[j] && Math.hypot(P[i * 3] - P[j * 3], P[i * 3 + 1] - P[j * 3 + 1], P[i * 3 + 2] - P[j * 3 + 2]) < radius[i] + radius[j]) overl++; }
  check(overl === 0 && kept > 100, `sphereOverlapPrune: ${kept} kept, ${overl} overlapping pairs`);
  const km = kmeans(P, Int32Array.from({ length: 1000 }, (_, i) => i), 5, 20, 1);
  check(km.k === 5 && km.label.every((l) => l >= 0 && l < 5) && km.label[0] === 0, 'kmeans: 5 clusters, labels in order of first appearance');
}

// ---------------------------------------------------------------- scatter kernels (core/scatter.ts)
section('scatter kernels: the chunked stages give what the serial ones give');
{
  // rngAt(state, m) is the m-th draw of rng(seed)
  const seq = rng(7.5), st = rngState(7.5);
  let same = true;
  for (let m = 1; m <= 5000; m++) if (seq() !== rngAt(st, m)) same = false;
  check(same, 'rngAt(rngState(seed), m) = the m-th value of rng(seed), for m = 1..5000');

  // minDistanceSelectWith (conflict lists, in blocks) keeps exactly the candidates the greedy grid keeps
  const r = rng(11), N = 6000, Q = new Float64Array(N * 3);
  for (let i = 0; i < N; i++) { Q[i * 3] = r() * 10; Q[i * 3 + 1] = r() < 0.5 ? 0 : r() * 0.3; Q[i * 3 + 2] = r() * 10; }
  for (let i = 0; i < 40; i++) Q.copyWithin(i * 30 + 3, i * 30, i * 30 + 3); // exact duplicates
  const ord = Int32Array.from({ length: N }, (_, i) => i);
  for (let i = N - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const t = ord[i]; ord[i] = ord[j]; ord[j] = t; }
  let mismatches = 0, cases = 0;
  for (const radius of [0, 0.03, 0.1, 0.17, 0.4, 2.5])
    for (const limit of [Infinity, 700, 50])
      for (const capped of [false, true]) {
        cases++;
        const used = new Int32Array(N);
        const acc = capped ? (i: number) => used[i % 97] < 3 : undefined, kept = capped ? (i: number) => { used[i % 97]++; } : undefined;
        const a = minDistanceSelect(Q, ord, radius, limit, acc, kept);
        used.fill(0);
        const b = minDistanceSelectWith(Q, ord, radius, limit, acc, kept) as Int32Array;
        if (a.length !== b.length || a.some((v, i) => v !== b[i])) mismatches++;
      }
  check(mismatches === 0, `minDistanceSelectWith = minDistanceSelect (greedy grid) over ${cases} radius/limit/accept cases, duplicates included (${mismatches} differ)`);

  // a KD tree whose lower levels are deferred and built range by range (in any order) = the full build
  const full = new KDTree(Q), part = new KDTree(Q, undefined, 97), rs = part.deferred.slice();
  for (let i = rs.length - 2; i >= 0; i -= 2) part.buildRange(rs[i], rs[i + 1]);
  check(rs.length > 20 && full.idx.every((v, i) => v === part.idx[i]) && full.axis.every((v, i) => v === part.axis[i]) && full.TP.every((v, i) => Object.is(v, part.TP[i])),
    `KDTree deferBelow + buildRange of the ${rs.length / 2} deferred ranges (reverse order) = the full build`);

  // the candidate kernel in chunks = in one piece
  const tp = Int32Array.from({ length: 300 }, (_, i) => (i * 7) % 100), Pk = Float64Array.from({ length: 300 }, (_, i) => Math.sin(i));
  const cdf = Float64Array.from({ length: 100 }, (_, i) => (i + 1) * (1 + (i % 3)));
  const one = surfaceCandidates(Pk, tp, cdf, 999, rngState(3), undefined) as { candT: Int32Array; candW: Float64Array; pos: Float64Array };
  const parts = { candT: new Int32Array(999), candW: new Float64Array(2997), pos: new Float64Array(2997) };
  const A = { cdf, tp, P: Pk, ...parts }, args = { state: rngState(3), total: cdf[99], nt: 100 };
  for (const [s, e] of [[0, 1], [1, 400], [400, 401], [401, 999]]) candidatesRange(args, A, s, e);
  check(one.candT.every((v, i) => v === parts.candT[i]) && one.candW.every((v, i) => Object.is(v, parts.candW[i])) && one.pos.every((v, i) => Object.is(v, parts.pos[i])),
    'scatter_candidates: four uneven chunks = one piece, bit for bit');
}

// ---------------------------------------------------------------- scatter v2
section('scatter v2');
{
  // density mode: count = density × area (within 10%; exact here)
  for (const relax of [true, false]) {
    const g = await geo({ grid: GRID, s: { type: 'scatter', in: ['grid'], params: { generate_by: 'density', density: 3, relax } } }, 's');
    check(Math.abs(g.numPoints - 300) <= 30, `density mode (relax ${relax}): ${g.numPoints} points for 3 / m² on 100 m² (want 300 ± 10%)`);
  }
  const legacy = await geo({ grid: GRID, s: { type: 'scatter', in: ['grid'], params: { density: 3 } } }, 's');
  check(legacy.numPoints === 300, `auto mode (legacy): density 3 → ${legacy.numPoints} points`);
  const masked = await geo({ grid: GRID, m: { type: 'attrib_create', in: ['grid'], params: { name: 'mask', value: 0.5 } }, s: { type: 'scatter', in: ['m'], params: { generate_by: 'density', density: 3, density_mask: 'mask' } } }, 's');
  check(masked.numPoints === 150, `density_mask 0.5 halves the density: ${masked.numPoints} points`);
  const autoMasked = await geo({ grid: GRID, m: { type: 'attrib_create', in: ['grid'], params: { name: 'mask', value: 0.5 } }, s: { type: 'scatter', in: ['m'], params: { density: 3, density_mask: 'mask' } } }, 's');
  check(autoMasked.numPoints === 150, `auto mode: density_mask scales the total too (${autoMasked.numPoints})`);
  const scaled = await geo({ grid: GRID, s: { type: 'scatter', in: ['grid'], params: { generate_by: 'density', density: 3, density_scale: 0.5 } } }, 's');
  check(scaled.numPoints === 150, `density_scale 0.5: ${scaled.numPoints} points`);
  const zero = await run({ grid: GRID, m: { type: 'attrib_create', in: ['grid'], params: { name: 'mask', value: 0 } }, s: { type: 'scatter', in: ['m'], params: { generate_by: 'density', density: 3, density_mask: 'mask' } } }, 's');
  check(zero.ok && zero.geo!.numPoints === 0 && zero.warnings.some((w) => /0 everywhere/.test(w.message)), 'a mask of 0 everywhere: no points and a warning (not an error)');
  const noMaskAttr = await cookErr({ grid: GRID, s: { type: 'scatter', in: ['grid'], params: { density_mask: 'nope' } } }, 's');
  check(/density_mask "nope" is not a numeric point, vertex or prim attribute/.test(noMaskAttr), 'missing density_mask attribute: clear error');

  // density_attrib (prim attribute) doubles points where it is 2
  const W2: Record<string, NodeSpec> = {
    grid: GRID,
    w1: { type: 'attrib_create', in: ['grid'], params: { name: 'density', class: 'prim', value: 1 } },
    w2: { type: 'attrib_create', in: ['w1'], params: { name: 'density', class: 'prim', value: 2, group: '@P.x>0' } },
  };
  for (const [label, params] of [['count', { count: 6000, relax: false }], ['density', { generate_by: 'density', density: 20, relax: false }]] as const) {
    const g = await geo({ ...W2, s: { type: 'scatter', in: ['w2'], params: { ...params, density_attrib: 'density' } } }, 's');
    const P = g.P;
    let right = 0, left = 0;
    for (let i = 0; i < g.numPoints; i++) if (P[i * 3] > 0) right++; else left++;
    const want = label === 'density' ? 20 * (50 * 2 + 50) : 6000;
    check(Math.abs(right / left - 2) < 0.2 && Math.abs(g.numPoints - want) <= want * 0.1, `density_attrib (prim) 2 vs 1, ${label} mode: ${right} vs ${left} points (ratio ${(right / left).toFixed(3)}), total ${g.numPoints}`);
  }

  // relaxation pushes points apart
  const raw = await geo({ grid: GRID, s: { type: 'scatter', in: ['grid'], params: { count: 300, relax: false, seed: 3 } } }, 's');
  const rel = await geo({ grid: GRID, s: { type: 'scatter', in: ['grid'], params: { count: 300, relax: false, seed: 3, relax_iterations: 10 } } }, 's');
  const d0 = nnDistances(raw.P), d1 = nnDistances(rel.P);
  let onPlane = true;
  for (let i = 0; i < rel.numPoints; i++) if (Math.abs(rel.P[i * 3 + 1]) > 1e-9 || Math.abs(rel.P[i * 3]) > 5 + 1e-9 || Math.abs(rel.P[i * 3 + 2]) > 5 + 1e-9) onPlane = false;
  check(rel.numPoints === 300 && minOf(d1) > minOf(d0) * 2 && mean(d1) > mean(d0), `relax_iterations 10: nearest-neighbour min ${minOf(d0).toFixed(3)} → ${minOf(d1).toFixed(3)}, mean ${mean(d0).toFixed(3)} → ${mean(d1).toFixed(3)}`);
  check(onPlane, 'relaxed points stay on the surface (projected back)');
  const relSp = new Set(Array.from(rel.points.get('sourceprim')!.data as Int32Array)).size;
  const NN = attr(rel, 'N');
  check(relSp > 50 && Math.abs(NN[1] - 1) < 1e-9, 'relaxed points get their new source prim and normal');
  const relBlue = await geo({ grid: GRID, s: { type: 'scatter', in: ['grid'], params: { count: 300, relax: true, relax_iterations: 5 } } }, 's');
  const bl = await geo({ grid: GRID, s: { type: 'scatter', in: ['grid'], params: { count: 300, relax: true } } }, 's');
  check(minOf(nnDistances(relBlue.P)) >= minOf(nnDistances(bl.P)), `relax_iterations after sample elimination: min distance ${minOf(nnDistances(bl.P)).toFixed(3)} → ${minOf(nnDistances(relBlue.P)).toFixed(3)}`);
  // blue-noise spacing and relaxation keep the density contrast (adaptive radii); the legacy auto mode evens it out
  const ratioOf = (g: Geometry) => { let r = 0; for (let i = 0; i < g.numPoints; i++) if (g.P[i * 3] > 0) r++; return r / (g.numPoints - r); };
  for (const [label, params] of [['sample elimination', {}], ['+ relax_iterations 6', { relax_iterations: 6 }]] as const) {
    const g = await geo({ ...W2, s: { type: 'scatter', in: ['w2'], params: { generate_by: 'count', count: 1500, density_attrib: 'density', ...params } } }, 's');
    check(Math.abs(ratioOf(g) - 2) < 0.25 && g.numPoints === 1500, `${label} follows the density attribute: ratio ${ratioOf(g).toFixed(2)} (want 2)`);
  }
  const blueMask = await geo({ ...W2, m: { type: 'attrib_create', in: ['w2'], params: { name: 'mask', class: 'prim', value: 0.5 } }, m2: { type: 'attrib_create', in: ['m'], params: { name: 'mask', class: 'prim', value: 1, group: '@P.x>0' } }, s: { type: 'scatter', in: ['m2'], params: { generate_by: 'density', density: 10, density_mask: 'mask' } } }, 's');
  check(Math.abs(ratioOf(blueMask) - 2) < 0.25 && Math.abs(blueMask.numPoints - 750) <= 1, `density_mask 1 vs 0.5 with blue-noise spacing: ratio ${ratioOf(blueMask).toFixed(2)}, ${blueMask.numPoints} points`);
  const legacyEven = await geo({ ...W2, s: { type: 'scatter', in: ['w2'], params: { count: 1500, density_attrib: 'density' } } }, 's');
  check(ratioOf(legacyEven) < 1.5, `legacy auto mode with relax keeps its uniform elimination radius (ratio ${ratioOf(legacyEven).toFixed(2)})`);

  // min_distance is exact
  for (const [label, params] of [
    ['relax', { relax: true }], ['no relax', { relax: false }], ['relax_iterations', { relax: false, relax_iterations: 3 }],
  ] as const) {
    const g = await geo({ grid: GRID, s: { type: 'scatter', in: ['grid'], params: { count: 2000, min_distance: 0.15, ...params } } }, 's');
    const m = minOf(nnDistances(g.P));
    check(m >= 0.15 && g.numPoints > 1500, `min_distance 0.15 (${label}): ${g.numPoints} points, nearest pair ${m.toFixed(5)}`);
  }
  const vol = await geo({ b: { type: 'box', params: { size: [4, 4, 4] } }, s: { type: 'scatter', in: ['b'], params: { mode: 'volume', count: 400, min_distance: 0.4 } } }, 's');
  check(minOf(nnDistances(vol.P)) >= 0.4 && vol.numPoints > 300, `min_distance in volume mode: ${vol.numPoints} points, nearest ${minOf(nnDistances(vol.P)).toFixed(4)}`);
  const crv = await geo({ c: { type: 'curve', params: { points: [[0, 0, 0], [10, 0, 0]] } }, s: { type: 'scatter', in: ['c'], params: { count: 200, relax: false, min_distance: 0.2 } } }, 's');
  check(minOf(nnDistances(crv.P)) >= 0.2, `min_distance in curve mode: ${crv.numPoints} points, nearest ${minOf(nnDistances(crv.P)).toFixed(4)}`);

  // max_per_prim
  const capG = await geo({ g: { type: 'grid', params: { size: [4, 4], divisions: [4, 4] } }, s: { type: 'scatter', in: ['g'], params: { count: 200, max_per_prim: 3 } } }, 's');
  const per = new Map<number, number>();
  for (const pr of capG.points.get('sourceprim')!.data as Int32Array) per.set(pr, (per.get(pr) ?? 0) + 1);
  check(Math.max(...per.values()) <= 3 && capG.numPoints === 48, `max_per_prim 3 on 16 prims: ${capG.numPoints} points, at most ${Math.max(...per.values())} per prim`);

  // emitted attributes: vertex uv interpolated, prim attribute copied, exclusions
  const BOXN: Record<string, NodeSpec> = { b: { type: 'box' }, n: { type: 'attrib_create', in: ['b'], params: { name: 'name', class: 'prim', value: 'crate' } } };
  const em = await geo({ ...BOXN, s: { type: 'scatter', in: ['n'], params: { count: 100 } } }, 's');
  const uv = em.points.get('uv'), nm = em.points.get('name');
  check(!!uv && uv.size === 3 && !em.vertices.has('uv') && !!nm && (nm.data as string[]).every((s) => s === 'crate') && !em.prims.has('name'), 'emit_attributes "*": vertex uv interpolated onto points, prim name copied (no empty vertex/prim tables left)');
  let uvOk = true;
  for (let i = 0; i < em.numPoints * 3; i++) if (!((uv!.data as Float64Array)[i] >= -1e-9 && (uv!.data as Float64Array)[i] <= 1 + 1e-9)) uvOk = false;
  check(uvOk, 'interpolated uv stays within the corner values');
  const ex = await geo({ ...BOXN, s: { type: 'scatter', in: ['n'], params: { count: 100, emit_attributes: '^uv' } } }, 's');
  check(!ex.points.has('uv') && ex.points.has('name'), 'emit_attributes "^uv" excludes uv');
  const none = await geo({ ...BOXN, s: { type: 'scatter', in: ['n'], params: { count: 100, keep_attribs: false } } }, 's');
  check(!none.points.has('uv') && !none.points.has('name'), 'keep_attribs false: nothing carried');

  // write options
  const quad = await geo({ g: { type: 'grid', params: { size: [2, 3], divisions: [1, 1] } }, s: { type: 'scatter', in: ['g'], params: { count: 50, write_primuv: true, write_seed: true, write_sourceprim: false } } }, 's');
  const src = await geo({ g: { type: 'grid', params: { size: [2, 3], divisions: [1, 1] } } }, 'g');
  const c = src.primPoints(0).map((i) => vec(src.P, i));
  const puv = attr(quad, 'sourceprimuv');
  let rec = 0;
  for (let i = 0; i < quad.numPoints; i++) {
    const u = puv[i * 3], v = puv[i * 3 + 1];
    for (let k = 0; k < 3; k++) {
      const x = (1 - u) * (1 - v) * c[0][k] + u * (1 - v) * c[1][k] + u * v * c[2][k] + (1 - u) * v * c[3][k];
      rec = Math.max(rec, Math.abs(x - quad.P[i * 3 + k]));
    }
  }
  check(!quad.points.has('sourceprim') && rec < 1e-9, `write_primuv: sourceprimuv reproduces P on the quad (max error ${rec.toExponential(1)}); write_sourceprim false drops sourceprim`);
  const seeds = quad.points.get('seed')!.data as Int32Array;
  check(quad.points.get('seed')!.type === 'int' && new Set(seeds).size === seeds.length && seeds.every((s) => s >= 0), 'write_seed: distinct non-negative int seeds');
  // neutral defaults: spelling out every new param at its default changes nothing
  const def = await geo({ m: { type: 'sphere', params: { type: 'ico', level: 2 } }, s: { type: 'scatter', in: ['m'] } }, 's');
  const explicit = await geo({ m: { type: 'sphere', params: { type: 'ico', level: 2 } }, s: { type: 'scatter', in: ['m'], params: { generate_by: 'auto', density_mask: '', density_scale: 1, relax_iterations: 0, relax_radius: 0, min_distance: 0, max_per_prim: 0, emit_attributes: '*', write_sourceprim: true, write_primuv: false, write_seed: false } } }, 's');
  check(fpEq(def, explicit), 'scatter: new params at their defaults give the legacy result');
}

// ---------------------------------------------------------------- mask
section('mask');
{
  const TILT: Record<string, NodeSpec> = { g: { type: 'grid', params: { size: [4, 4], divisions: [8, 8] } }, t: { type: 'transform', in: ['g'], params: { rotate: [0, 0, 20] } } };
  const lo = await geo({ ...TILT, m: { type: 'mask', in: ['t'], params: { by: 'slope', min: 0, max: 15 } } }, 'm');
  const hi = await geo({ ...TILT, m: { type: 'mask', in: ['t'], params: { by: 'slope', min: 0, max: 25 } } }, 'm');
  check(attr(lo, 'mask').every((v) => v === 0) && attr(hi, 'mask').every((v) => v === 1), 'slope on a 20° plane: all 0 for 0..15°, all 1 for 0..25° (all-or-nothing)');
  const half = await geo({ ...TILT, m: { type: 'mask', in: ['t'], params: { by: 'slope', min: 0, max: 10, falloff: 20 } } }, 'm');
  check(attr(half, 'mask').every((v) => Math.abs(v - 0.5) < 1e-9), 'slope 20° with max 10 and falloff 20: 0.5 everywhere (linear fade)');
  // a point cloud takes the slope of the surface it lies on (input 1) when it has no N
  const cloud = await geo({ ...TILT, p: { type: 'points', params: { positions: [[0, 0, 0], [0.5, 0.18, 0.5]] } }, m: { type: 'mask', in: ['p', 't'], params: { by: 'slope', min: 19.99, max: 20.01 } } }, 'm');
  check(attr(cloud, 'mask').every((v) => v === 1), 'slope of points without N: normals from the reference surface');

  // inside / outside a box
  const PG: NodeSpec = { type: 'point_grid', params: { counts: [11, 1, 11], size: [4, 0, 4] } };
  const ins = await geo({ p: PG, b: { type: 'box', params: { size: [2, 2, 2] } }, m: { type: 'mask', in: ['p', 'b'], params: { by: 'inside' } } }, 'm');
  let insOk = true;
  for (let i = 0; i < ins.numPoints; i++) {
    const x = ins.P[i * 3], z = ins.P[i * 3 + 2];
    if (attr(ins, 'mask')[i] !== (Math.abs(x) < 1 && Math.abs(z) < 1 ? 1 : 0)) insOk = false;
  }
  check(insOk, 'inside a box: 1 inside, 0 outside');
  const soft = await geo({ p: PG, b: { type: 'box', params: { size: [2, 2, 2] } }, m: { type: 'mask', in: ['p', 'b'], params: { by: 'inside', falloff: 0.5 } } }, 'm');
  let softOk = true;
  for (let i = 0; i < soft.numPoints; i++) {
    const x = Math.abs(soft.P[i * 3]), z = Math.abs(soft.P[i * 3 + 2]);
    const d = Math.hypot(Math.max(0, x - 1), Math.max(0, z - 1));
    const want = x < 1 && z < 1 ? 1 : Math.max(0, 1 - d / 0.5);
    if (Math.abs(attr(soft, 'mask')[i] - want) > 1e-9) softOk = false;
  }
  check(softOk, 'inside with falloff 0.5: linear fade over 0.5 m outside');
  check(/connect a closed mesh/.test(await cookErr({ p: PG, m: { type: 'mask', in: ['p'], params: { by: 'inside' } } }, 'm')), 'inside without a second input: clear error');

  // distance ramp values
  const xs = Array.from({ length: 11 }, (_, k) => k * 0.4);
  const LINE: Record<string, NodeSpec> = { p: { type: 'points', params: { positions: xs.map((x) => [x, 0, 0]) } }, road: { type: 'curve', params: { points: [[0, 0, -10], [0, 0, 10]] } } };
  const dm = await geo({ ...LINE, m: { type: 'mask', in: ['p', 'road'], params: { by: 'distance', min: 0, max: 1, falloff: 2 } } }, 'm');
  const want = xs.map((d) => (d <= 1 ? 1 : Math.max(0, 1 - (d - 1) / 2)));
  check(maxDiff(attr(dm, 'mask'), want) < 1e-12, `distance band 0..1 m, falloff 2 m: ${Array.from(attr(dm, 'mask')).map((v) => v.toFixed(2)).join(' ')}`);
  const away = await geo({ ...LINE, m: { type: 'mask', in: ['p', 'road'], params: { by: 'distance', min: 2, max: 1e9, falloff: 1 } } }, 'm');
  check(maxDiff(attr(away, 'mask'), xs.map((d) => (d >= 2 ? 1 : Math.max(0, 1 - (2 - d))))) < 1e-12, 'distance "away from the road" (min 2, falloff 1)');
  const rmp = await geo({ ...LINE, m: { type: 'mask', in: ['p', 'road'], params: { by: 'distance', min: 0, max: 1, falloff: 2, ramp: [[0, 0], [0.5, 1], [1, 1]], invert: true } } }, 'm');
  const wantR = want.map((v) => 1 - (v >= 0.5 ? 1 : v * 2));
  check(maxDiff(attr(rmp, 'mask'), wantR) < 1e-12, 'ramp reshapes the band, invert flips it');

  // combine modes against a hand computation
  const BASE: Record<string, NodeSpec> = {
    p: { type: 'points', params: { positions: [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0], [4, 0, 0]], attribs: { a: [0, 0.25, 0.5, 0.75, 1], mask: [1, 0.5, 0.5, 0, 0.2] } } },
  };
  const a = [0, 0.25, 0.5, 0.75, 1], old = [1, 0.5, 0.5, 0, 0.2];
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  const expect: Record<string, (o: number, v: number) => number> = {
    replace: (_o, v) => v, multiply: (o, v) => o * v, add: (o, v) => clamp(o + v), subtract: (o, v) => clamp(o - v), max: Math.max, min: Math.min,
  };
  for (const [mode, f] of Object.entries(expect)) {
    const g = await geo({ ...BASE, m: { type: 'mask', in: ['p'], params: { by: 'attribute', source_attrib: 'a', min: 1, max: 2, falloff: 1, combine: mode } } }, 'm');
    check(maxDiff(attr(g, 'mask'), a.map((v, i) => f(old[i], v))) < 1e-12, `combine ${mode}`);
  }
  const named = await geo({ ...BASE, m: { type: 'mask', in: ['p'], params: { by: 'attribute', source_attrib: 'a', min: 1, max: 2, falloff: 1, combine: 'multiply', name: 'fresh' } } }, 'm');
  check(maxDiff(attr(named, 'fresh'), a) < 1e-12, 'combine with a missing attribute starts from scratch (multiply = the new mask)');
  const grp = await geo({ ...BASE, m: { type: 'mask', in: ['p'], params: { by: 'group', pattern: '@P.x>1.5', group: '0-3' } } }, 'm');
  check(eq(Array.from(attr(grp, 'mask')), [0, 0, 1, 1, 0.2]), 'by group (pattern), only points in group written (the others keep their mask)');

  // the other features cook and stay in 0..1
  const TER: NodeSpec = { type: 'terrain', params: { size: [20, 20], divisions: [30, 30], height: 4 } };
  for (const [by, extra] of [['height', { min: 0, max: 2, falloff: 1 }], ['curvature', { min: -100, max: 0 }], ['occlusion', { min: 0.2, max: 1, samples: 8 }], ['direction', { min: 0, max: 60 }], ['noise', { min: 0.5, max: 1, falloff: 0.1 }]] as const) {
    const g = await geo({ t: TER, m: { type: 'mask', in: ['t'], params: { by, ...extra } } }, 'm');
    const m = attr(g, 'mask');
    const inRange = m.every((v) => v >= 0 && v <= 1), some = m.some((v) => v > 0) && m.some((v) => v < 1);
    check(inRange && some, `mask by ${by} on a terrain: values in 0..1, mean ${mean(m).toFixed(2)}`);
  }
  const occl = await geo({ g: { type: 'grid', params: { size: [6, 6], divisions: [12, 12] } }, s: { type: 'scatter', in: ['g'], params: { count: 50 } }, wall: { type: 'box', params: { size: [6, 4, 0.5], center: [0, 2, 0] } }, m: { type: 'mask', in: ['s', 'wall'], params: { by: 'occlusion', min: 0.15, max: 1, samples: 32 } } }, 'm');
  const near: number[] = [], far: number[] = [];
  for (let i = 0; i < occl.numPoints; i++) (Math.abs(occl.P[i * 3 + 2]) < 0.8 ? near : far).push(attr(occl, 'mask')[i]);
  check(mean(near) > mean(far), `occlusion of scattered points next to a wall (input 1): near ${mean(near).toFixed(2)} > far ${mean(far).toFixed(2)}`);
}

// ---------------------------------------------------------------- attribute_from_map
section('attribute_from_map');
{
  const W = 256, H = 4;
  const grey = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) grey[y * W + x] = x;
  fs.writeFileSync(path.join(tmp, 'grad.png'), encodeGreyPNG(grey, W, H, 8, (d) => zlib.deflateSync(d)));
  const G: NodeSpec = { type: 'grid', params: { size: [10, 10], divisions: [20, 20] } };
  const xz = await geo({ g: G, a: { type: 'attribute_from_map', in: ['g'], params: { path: 'grad.png', projection: 'xz', size: [10, 10], name: 'v' } } }, 'a');
  let e1 = 0;
  for (let i = 0; i < xz.numPoints; i++) e1 = Math.max(e1, Math.abs(attr(xz, 'v')[i] - (xz.P[i * 3] + 5) / 10));
  check(e1 <= 1 / 255, `planar xz projection of a 0..255 gradient: linear in x within ${e1.toExponential(1)} (≤ 1/255)`);
  const uvm = await geo({ g: G, a: { type: 'attribute_from_map', in: ['g'], params: { path: 'grad.png' } } }, 'a');
  const U = attr(uvm, 'uv');
  let e2 = 0;
  for (let i = 0; i < uvm.numPoints; i++) e2 = Math.max(e2, Math.abs(attr(uvm, 'mask')[i] - U[i * 3]));
  check(e2 <= 1 / 255, `uv projection (point uv): value = u within ${e2.toExponential(1)} (≤ 1/255), default name "mask"`);
  const rem = await geo({ g: G, a: { type: 'attribute_from_map', in: ['g'], params: { path: 'grad.png', projection: 'xz', size: [10, 10], remap: [2, 4], name: 'v' } } }, 'a');
  check(maxDiff(attr(rem, 'v'), Array.from(attr(xz, 'v'), (v) => 2 + 2 * v)) < 1e-12, 'remap [2, 4]');
  // 16-bit, rgb
  const g16 = new Uint16Array(1024 * 2);
  for (let y = 0; y < 2; y++) for (let x = 0; x < 1024; x++) g16[y * 1024 + x] = Math.round((x / 1023) * 65535);
  fs.writeFileSync(path.join(tmp, 'grad16.png'), encodeGreyPNG(g16, 1024, 2, 16, (d) => zlib.deflateSync(d)));
  const x16 = await geo({ g: G, a: { type: 'attribute_from_map', in: ['g'], params: { path: 'grad16.png', projection: 'xz', size: [10, 10], name: 'v' } } }, 'a');
  let e3 = 0;
  for (let i = 0; i < x16.numPoints; i++) e3 = Math.max(e3, Math.abs(attr(x16, 'v')[i] - (x16.P[i * 3] + 5) / 10));
  check(e3 < 2e-5, `16-bit gradient: within ${e3.toExponential(1)}`);
  const rgba = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const o = (y * W + x) * 4; rgba[o] = x; rgba[o + 1] = 255 - x; rgba[o + 2] = 64; rgba[o + 3] = 255; }
  fs.writeFileSync(path.join(tmp, 'rgb.png'), encodePNG(rgba, W, H, (d) => zlib.deflateSync(d)));
  const col = await geo({ g: G, a: { type: 'attribute_from_map', in: ['g'], params: { path: 'rgb.png', projection: 'xz', size: [10, 10], channel: 'rgb' } } }, 'a');
  const cd = attr(col, 'Cd');
  let e4 = 0;
  for (let i = 0; i < col.numPoints; i++) {
    const u = (col.P[i * 3] + 5) / 10;
    e4 = Math.max(e4, Math.abs(cd[i * 3] - u), Math.abs(cd[i * 3 + 1] - (1 - u)), Math.abs(cd[i * 3 + 2] - 64 / 255));
  }
  check(col.points.get('Cd')!.size === 3 && e4 <= 1 / 255, `channel rgb → Cd (r = u, g = 1 - u, b = 64/255) within ${e4.toExponential(1)}`);
  const gch = await geo({ g: G, a: { type: 'attribute_from_map', in: ['g'], params: { path: 'rgb.png', projection: 'xz', size: [10, 10], channel: 'g', name: 'v' } } }, 'a');
  check(maxDiff(attr(gch, 'v'), Array.from({ length: gch.numPoints }, (_, i) => cd[i * 3 + 1])) < 1e-12, 'channel g');
  // vertex class
  const vtx = await geo({ g: G, a: { type: 'attribute_from_map', in: ['g'], params: { path: 'grad.png', projection: 'xz', size: [10, 10], name: 'v', class: 'vertex' } } }, 'a');
  const vv = vtx.vertices.get('v')!.data as Float64Array;
  let e5 = 0;
  for (let v = 0; v < vtx.numVertices; v++) e5 = Math.max(e5, Math.abs(vv[v] - attr(xz, 'v')[vtx.vertexPoint[v]]));
  check(!vtx.points.has('v') && e5 < 1e-12, 'class vertex: one value per vertex (equal to its point here)');
  // nearest filter and wrap
  const nearest = await geo({ p: { type: 'points', params: { positions: [[-5, 0, 0], [5, 0, 0], [6, 0, 0]] } }, a: { type: 'attribute_from_map', in: ['p'], params: { path: 'grad.png', projection: 'xz', size: [10, 10], filter: 'nearest', name: 'v' } } }, 'a');
  check(eq(Array.from(attr(nearest, 'v')), [0, 1, 1]), 'nearest filter; wrap clamp beyond the image');
  const rep = await geo({ p: { type: 'points', params: { positions: [[6, 0, 0]] } }, a: { type: 'attribute_from_map', in: ['p'], params: { path: 'grad.png', projection: 'xz', size: [10, 10], wrap: 'repeat', name: 'v' } } }, 'a');
  check(Math.abs(attr(rep, 'v')[0] - 0.1) < 2 / 255, `wrap repeat tiles the image (x = 6 → ${attr(rep, 'v')[0].toFixed(3)})`);
  // the file stamp is part of the signature: a changed file re-cooks
  const nodes = { p: { type: 'points', params: { positions: [[0, 0, 0]] } } as NodeSpec, a: { type: 'attribute_from_map', in: ['p'], params: { path: 'live.png', projection: 'xz', size: [10, 10], name: 'v' } } as NodeSpec };
  fs.writeFileSync(path.join(tmp, 'live.png'), encodeGreyPNG(new Uint8Array(4).fill(0), 2, 2, 8, (d) => zlib.deflateSync(d)));
  const before = attr(await geo(nodes, 'a'), 'v')[0];
  fs.writeFileSync(path.join(tmp, 'live.png'), encodeGreyPNG(new Uint8Array(9).fill(255), 3, 3, 8, (d) => zlib.deflateSync(d)));
  const after = attr(await geo(nodes, 'a'), 'v')[0];
  check(before === 0 && after === 1, 'a changed image file re-cooks (file stamp in the signature)');
  check(/cannot read "missing.png"/.test(await cookErr({ p: nodes.p, a: { type: 'attribute_from_map', in: ['p'], params: { path: 'missing.png' } } }, 'a')), 'missing file: clear error');
  check(/no uv attribute/.test(await cookErr({ p: nodes.p, a: { type: 'attribute_from_map', in: ['p'], params: { path: 'grad.png' } } }, 'a')), 'uv projection without uv: clear error');
}

// ---------------------------------------------------------------- orient
section('orient');
{
  const PLANE: Record<string, NodeSpec> = {
    g: { type: 'grid', params: { size: [6, 6], divisions: [6, 6] } },
    t: { type: 'transform', in: ['g'], params: { rotate: [30, 0, 0] } },
    p: { type: 'point_grid', params: { counts: [4, 2, 4], size: [3, 1, 3], center: [0, 1, 0] } },
  };
  const nrm = [0, Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)];
  const sf = await geo({ ...PLANE, o: { type: 'orient', in: ['p', 't'], params: { mode: 'surface' } } }, 'o');
  const N = attr(sf, 'N'), O = attr(sf, 'orient'), Up = attr(sf, 'up');
  let eN = 0, eQ = 0;
  for (let i = 0; i < sf.numPoints; i++) {
    eN = Math.max(eN, maxDiff(vec(N, i), nrm));
    const q = vec(O, i, 4) as Quat;
    eQ = Math.max(eQ, maxDiff(qRotate(q, [0, 0, 1]), vec(N, i)), maxDiff(qRotate(q, [0, 1, 0]), vec(Up, i)), Math.abs(dot3(vec(N, i), vec(Up, i))));
  }
  check(eN < 1e-9, `surface mode: N equals the surface normal (max error ${eN.toExponential(1)})`);
  check(eQ < 1e-9, 'orient rotates +Z to N and +Y to up (orthogonal)');
  const snap = await geo({ ...PLANE, o: { type: 'orient', in: ['p', 't'], params: { mode: 'surface', snap: true } } }, 'o');
  let eS = 0;
  for (let i = 0; i < snap.numPoints; i++) eS = Math.max(eS, Math.abs(dot3(vec(snap.P, i), nrm)));
  check(eS < 1e-9, 'surface snap: points moved onto the plane');
  const sy = await geo({ ...PLANE, o: { type: 'orient', in: ['p', 't'], params: { mode: 'surface', align_axis: 'y' } } }, 'o');
  let eY = 0;
  for (let i = 0; i < sy.numPoints; i++) eY = Math.max(eY, maxDiff(vec(attr(sy, 'up'), i), nrm), Math.abs(dot3(vec(attr(sy, 'N'), i), nrm)));
  check(eY < 1e-9, 'surface align_axis y: up = surface normal, N perpendicular (upright models follow the slope)');
  // equivalence with copy_to_points: orient vs N + up give the same copies
  const CP: Record<string, NodeSpec> = { ...PLANE, o: { type: 'orient', in: ['p', 't'], params: { mode: 'surface', random_yaw: [0, 360], tilt: [5, 15] } }, nu: { type: 'attrib_delete', in: ['o'], params: { names: 'orient' } }, b: { type: 'box', params: { size: [0.2, 0.6, 0.1] } }, c1: { type: 'copy_to_points', in: ['b', 'o'] }, c2: { type: 'copy_to_points', in: ['b', 'nu'] } };
  const c1 = await geo(CP, 'c1'), c2 = await geo(CP, 'c2');
  check(maxDiff(c1.P, c2.P) < 1e-9, 'copies by orient = copies by the written N + up');
  // direction + random yaw: upright, horizontal heading; tilt within its range
  const dir = await geo({ p: PLANE.p, o: { type: 'orient', in: ['p'], params: { mode: 'direction', random_yaw: [0, 360], seed: 2 } } }, 'o');
  let horiz = 0, upY = 0;
  const heads = new Set<number>();
  for (let i = 0; i < dir.numPoints; i++) { const n = vec(attr(dir, 'N'), i); horiz = Math.max(horiz, Math.abs(n[1])); upY = Math.max(upY, maxDiff(vec(attr(dir, 'up'), i), [0, 1, 0])); heads.add(Math.round(Math.atan2(n[0], n[2]) * 1000)); }
  check(horiz < 1e-9 && upY < 1e-9 && heads.size > dir.numPoints * 0.8, 'direction + random_yaw [0, 360]: up = +Y, N horizontal with varied headings');
  const tl = await geo({ p: PLANE.p, o: { type: 'orient', in: ['p'], params: { mode: 'direction', tilt: [10, 20] } } }, 'o');
  let tOk = true;
  for (let i = 0; i < tl.numPoints; i++) { const a = (Math.acos(Math.min(1, attr(tl, 'up')[i * 3 + 1])) * 180) / Math.PI; if (a < 10 - 1e-6 || a > 20 + 1e-6) tOk = false; }
  check(tOk, 'tilt [10, 20]: up leans 10..20° from +Y');
  // look_at, curve tangent, random
  const la = await geo({ p: PLANE.p, o: { type: 'orient', in: ['p'], params: { mode: 'look_at', target: [0, 5, 0] } } }, 'o');
  let eL = 0;
  for (let i = 0; i < la.numPoints; i++) { const d = [0 - la.P[i * 3], 5 - la.P[i * 3 + 1], 0 - la.P[i * 3 + 2]]; const l = len3(d); eL = Math.max(eL, maxDiff(vec(attr(la, 'N'), i), d.map((x) => x / l))); }
  check(eL < 1e-9, 'look_at: N points at the target');
  const ct = await geo({ c: { type: 'curve', params: { points: [[-5, 0, 0], [5, 0, 0]] } }, p: { type: 'points', params: { positions: [[0, 1, 1], [2, -1, 0.5], [-3, 0, -2]] } }, o: { type: 'orient', in: ['p', 'c'], params: { mode: 'curve_tangent' } } }, 'o');
  check(maxDiff(attr(ct, 'N'), [1, 0, 0, 1, 0, 0, 1, 0, 0]) < 1e-9 && maxDiff(attr(ct, 'up'), [0, 1, 0, 0, 1, 0, 0, 1, 0]) < 1e-9, 'curve_tangent: N along the nearest curve, up from its rotation-minimising frame');
  const ownCurve = await geo({ c: { type: 'circle', params: { radius: 2, segments: 32 } }, r: { type: 'resample', in: ['c'], params: { length: 0.5 } }, o: { type: 'orient', in: ['r'], params: { mode: 'curve_tangent' } } }, 'o');
  let tang = 0;
  for (let i = 0; i < ownCurve.numPoints; i++) tang = Math.max(tang, Math.abs(dot3(vec(attr(ownCurve, 'N'), i), unitV(vec(ownCurve.P, i)))));
  check(tang < 0.1, `curve_tangent on the input's own closed curve: N tangent to the circle (max |N·radial| ${tang.toFixed(3)})`);
  const rnd = await geo({ p: PLANE.p, o: { type: 'orient', in: ['p'], params: { mode: 'random', axis: [0, 0, 0] } } }, 'o');
  let unitQ = 0;
  for (let i = 0; i < rnd.numPoints; i++) unitQ = Math.max(unitQ, Math.abs(Math.hypot(...vec(attr(rnd, 'orient'), i, 4)) - 1));
  check(unitQ < 1e-12 && new Set(Array.from(attr(rnd, 'orient')).map((x) => x.toFixed(6))).size > rnd.numPoints, 'random: unit quaternions, all different');
  // scale ranges
  const sc = await geo({ p: PLANE.p, o: { type: 'orient', in: ['p'], params: { scale_min: 0.5, scale_max: 1.5 } } }, 'o');
  const ps = attr(sc, 'pscale');
  check(ps.every((v) => v >= 0.5 && v <= 1.5) && new Set(ps).size > ps.length / 2, 'uniform scale range → pscale in [0.5, 1.5]');
  const sv = await geo({ p: PLANE.p, o: { type: 'orient', in: ['p'], params: { scale_min: [1, 2, 3], scale_max: [2, 3, 4], uniform_scale: false } } }, 'o');
  const s3 = attr(sv, 'scale');
  let svOk = !sv.points.has('pscale');
  for (let i = 0; i < sv.numPoints; i++) for (let c = 0; c < 3; c++) if (s3[i * 3 + c] < c + 1 || s3[i * 3 + c] > c + 2) svOk = false;
  check(svOk, 'per-axis scale range → scale');
  const sa = await geo({ p: { type: 'points', params: { positions: [[0, 0, 0], [1, 0, 0], [2, 0, 0]], attribs: { mask: [0, 0.5, 1] } } }, o: { type: 'orient', in: ['p'], params: { scale_min: 1, scale_max: 3, scale_attrib: 'mask' } } }, 'o');
  check(eq(Array.from(attr(sa, 'pscale')), [1, 2, 3]), 'scale_attrib picks the scale from a 0..1 attribute (scale ramp by mask)');
  // upright: posts along a climbing road keep +Y up and only take the heading
  const up = await geo({ c: { type: 'curve', params: { points: [[0, 0, 0], [10, 3, 0], [10, 6, 10]] } }, p: { type: 'points_along_curve', in: ['c'], params: { spacing: 2 } }, o: { type: 'orient', in: ['p'], params: { mode: 'normal_up', upright: true } } }, 'o');
  let eU = 0;
  for (let i = 0; i < up.numPoints; i++) {
    const t = vec(attr(up, 'tangent'), i), h = unitV([t[0], 0, t[2]]);
    eU = Math.max(eU, maxDiff(vec(attr(up, 'up'), i), [0, 1, 0]), maxDiff(vec(attr(up, 'N'), i), h));
  }
  check(eU < 1e-9, 'upright: up = +Y, N = the horizontal heading of the curve tangent');
  // group: unselected points keep the frame copy_to_points would use
  const part = await geo({ p: { type: 'points', params: { positions: [[0, 0, 0], [1, 0, 0]], attribs: { N: [[1, 0, 0], [1, 0, 0]] } } }, o: { type: 'orient', in: ['p'], params: { mode: 'direction', direction: [0, 0, 1], group: '0' } } }, 'o');
  check(maxDiff(qRotate(vec(attr(part, 'orient'), 1, 4) as Quat, [0, 0, 1]), [1, 0, 0]) < 1e-9 && maxDiff(vec(attr(part, 'N'), 0), [0, 0, 1]) < 1e-9, 'group: other points get the orient of their own N/up');
}

function unitV(v: number[]) { const l = len3(v); return v.map((x) => x / l); }

// ---------------------------------------------------------------- points along curves
section('points_along_curve');
{
  const CRV: NodeSpec = { type: 'curve', params: { points: [[0, 0, 0], [3, 0, 0], [3, 0, 4], [3, 2, 4]] } };
  const segs = [[[0, 0, 0], [3, 0, 0]], [[3, 0, 0], [3, 0, 4]], [[3, 0, 4], [3, 2, 4]]];
  /** Arc-length position of a point on the polyline (independent of the node). */
  const arc = (p: number[]) => {
    let acc = 0, best = Infinity, s = 0;
    for (const [a, b] of segs) {
      const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], L = len3(d);
      const t = Math.max(0, Math.min(1, dot3([p[0] - a[0], p[1] - a[1], p[2] - a[2]], d) / (L * L)));
      const q = [a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t], e = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
      if (e < best - 1e-12) { best = e; s = acc + t * L; }
      acc += L;
    }
    return s;
  };
  const sp = await geo({ c: CRV, p: { type: 'points_along_curve', in: ['c'], params: { spacing: 0.7 } } }, 'p');
  const S = Array.from({ length: sp.numPoints }, (_, i) => arc(vec(sp.P, i)));
  const gaps = S.slice(1).map((s, i) => s - S[i]);
  const cu = Array.from(attr(sp, 'curveu'));
  check(sp.numPoints === 13 && gaps.every((g) => Math.abs(g - 0.7) < 1e-6), `spacing 0.7 on a 9 m polyline with corners: ${sp.numPoints} points, arc gaps 0.7 within ${Math.max(...gaps.map((g) => Math.abs(g - 0.7))).toExponential(1)}`);
  check(cu.every((u, i) => i === 0 || u > cu[i - 1]) && maxDiff(cu, S.map((s) => s / 9)) < 1e-9, 'curveu is monotonic and equals arc length / total');
  const T = attr(sp, 'tangent'), Nn = attr(sp, 'N'), Up = attr(sp, 'up'), O = attr(sp, 'orient');
  let frame = 0;
  for (let i = 0; i < sp.numPoints; i++) {
    frame = Math.max(frame, maxDiff(vec(T, i), vec(Nn, i)), Math.abs(dot3(vec(T, i), vec(Up, i))), Math.abs(len3(vec(Up, i)) - 1), maxDiff(qRotate(vec(O, i, 4) as Quat, [0, 0, 1]), vec(T, i)), maxDiff(qRotate(vec(O, i, 4) as Quat, [0, 1, 0]), vec(Up, i)));
  }
  check(frame < 1e-9 && (sp.points.get('curve_id')!.data as Int32Array).every((c) => c === 0), 'tangent = N, unit up ⟂ tangent, orient matches (N, up), curve_id');
  const off = await geo({ c: CRV, p: { type: 'points_along_curve', in: ['c'], params: { spacing: 1, start_offset: 1, end_offset: 2 } } }, 'p');
  const So = Array.from({ length: off.numPoints }, (_, i) => arc(vec(off.P, i)));
  check(off.numPoints === 7 && Math.abs(So[0] - 1) < 1e-9 && Math.abs(So[6] - 7) < 1e-9, `start_offset 1, end_offset 2: points at 1..7 m (${off.numPoints})`);
  const cnt = await geo({ c: CRV, p: { type: 'points_along_curve', in: ['c'], params: { count: 5 } } }, 'p');
  check(maxDiff(Array.from({ length: 5 }, (_, i) => arc(vec(cnt.P, i))), [0, 2.25, 4.5, 6.75, 9]) < 1e-9, 'count 5: evenly from start to end');
  const sub = await geo({ c: CRV, p: { type: 'points_along_curve', in: ['c'], params: { mode: 'subdivision', per_segment: 2 } } }, 'p');
  check(sub.numPoints === 7 && maxDiff(Array.from({ length: 7 }, (_, i) => arc(vec(sub.P, i))), [0, 1.5, 3, 5, 7, 8, 9]) < 1e-9, 'subdivision per_segment 2: vertices and segment midpoints');
  const atp = await geo({ c: CRV, p: { type: 'points_along_curve', in: ['c'], params: { mode: 'at_points' } } }, 'p');
  check(atp.numPoints === 4 && maxDiff(atp.P, [0, 0, 0, 3, 0, 0, 3, 0, 4, 3, 2, 4]) < 1e-12, 'at_points: one point per vertex');
  const loop = await geo({ c: { type: 'circle', params: { radius: 1, segments: 48 } }, p: { type: 'points_along_curve', in: ['c'], params: { count: 12 } } }, 'p');
  const nn = nnDistances(loop.P);
  check(loop.numPoints === 12 && Math.max(...nn) - Math.min(...nn) < 1e-3, `closed loop, count 12: even spacing without a duplicate at the seam (${Math.min(...nn).toFixed(4)}..${Math.max(...nn).toFixed(4)})`);
  const side = await geo({ c: { type: 'curve', params: { points: [[0, 0, 0], [10, 0, 0]] } }, p: { type: 'points_along_curve', in: ['c'], params: { spacing: 5, side_offset: 1, both_sides: true } } }, 'p');
  const sides = Array.from(side.points.get('side')!.data as Int32Array);
  let sideOk = side.numPoints === 6;
  for (let i = 0; i < side.numPoints; i++) if (Math.abs(side.P[i * 3 + 2] - sides[i]) > 1e-12) sideOk = false;
  check(sideOk, 'side_offset 1, both_sides: right of travel (+Z for a curve along +X) = side 1, left = side -1');
  const jit = await geo({ c: CRV, p: { type: 'points_along_curve', in: ['c'], params: { spacing: 0.5, jitter: 0.2 } } }, 'p');
  const cj = Array.from(attr(jit, 'curveu'));
  check(cj.every((u, i) => i === 0 || u >= cj[i - 1]) && cj.every((u) => u >= 0 && u <= 1), 'jitter keeps the points ordered and on the curve');
  const carry = await geo({ c: CRV, w: { type: 'attrib_create', in: ['c'], params: { name: 'width', value: 0.5 } }, n: { type: 'attrib_create', in: ['w'], params: { name: 'name', class: 'prim', value: 'road' } }, p: { type: 'points_along_curve', in: ['n'], params: { spacing: 1 } } }, 'p');
  check(attr(carry, 'width').every((v) => v === 0.5) && (carry.points.get('name')!.data as string[]).every((s) => s === 'road') && carry.numPrims === 0, 'source point attributes interpolated, prim attributes copied, points only');
}

// ---------------------------------------------------------------- cluster
section('cluster');
{
  const PTS: Record<string, NodeSpec> = { g: { type: 'grid', params: { size: [20, 10] } }, s: { type: 'scatter', in: ['g'], params: { count: 500 } } };
  const km = await geo({ ...PTS, c: { type: 'cluster', in: ['s'], params: { count: 7, iterations: 200, center: true, color: true } } }, 'c');
  const L = km.points.get('cluster')!.data as Int32Array, C = attr(km, 'cluster_center');
  const bb = km.bbox();
  const ids = new Set(L);
  let inBox = true, centroid = 0, voronoi = true;
  const sums = new Map<number, number[]>();
  for (let i = 0; i < km.numPoints; i++) {
    const c = vec(C, i);
    if (c.some((x, k) => x < bb.min[k] - 1e-9 || x > bb.max[k] + 1e-9)) inBox = false;
    const s = sums.get(L[i]) ?? [0, 0, 0, 0];
    s[0] += km.P[i * 3]; s[1] += km.P[i * 3 + 1]; s[2] += km.P[i * 3 + 2]; s[3]++;
    sums.set(L[i], s);
  }
  const centers = new Map<number, number[]>();
  for (let i = 0; i < km.numPoints; i++) centers.set(L[i], vec(C, i));
  for (const [c, s] of sums) centroid = Math.max(centroid, maxDiff(centers.get(c)!, [s[0] / s[3], s[1] / s[3], s[2] / s[3]]));
  for (let i = 0; i < km.numPoints; i++) {
    const p = vec(km.P, i), own = Math.hypot(...p.map((x, k) => x - centers.get(L[i])![k]));
    for (const [, c] of centers) if (Math.hypot(...p.map((x, k) => x - c[k])) < own - 1e-9) voronoi = false;
  }
  check(L.every((l) => l >= 0 && l < 7) && ids.size === 7 && L[0] === 0, 'kmeans 7 (converged): every point assigned, 7 clusters, numbered from the first point');
  check(inBox && centroid < 1e-9 && voronoi, 'kmeans: centres inside the bbox, each the centroid of its points, every point nearest its own centre');
  check(km.points.has('Cd') && new Set(Array.from({ length: km.numPoints }, (_, i) => vec(attr(km, 'Cd'), i).map((x) => x.toFixed(4)).join())).size === 7, 'color: one Cd per cluster');
  const again = await geo({ ...PTS, c: { type: 'cluster', in: ['s'], params: { count: 7, iterations: 200, center: true, color: true } } }, 'c');
  check(fpEq(km, again), 'kmeans is deterministic');
  const rc = await geo({ ...PTS, c: { type: 'cluster', in: ['s'], params: { method: 'radius', radius: 2 } } }, 'c');
  const RL = rc.points.get('cluster')!.data as Int32Array;
  let diam = 0;
  for (let i = 0; i < rc.numPoints; i++) for (let j = i + 1; j < rc.numPoints; j++) if (RL[i] === RL[j]) diam = Math.max(diam, Math.hypot(rc.P[i * 3] - rc.P[j * 3], rc.P[i * 3 + 1] - rc.P[j * 3 + 1], rc.P[i * 3 + 2] - rc.P[j * 3 + 2]));
  check(RL.every((l) => l >= 0) && diam <= 4 + 1e-9 && new Set(RL).size > 5, `radius 2: ${new Set(RL).size} clusters, largest diameter ${diam.toFixed(2)} ≤ 4`);
  const grp = await geo({ ...PTS, c: { type: 'cluster', in: ['s'], params: { count: 3, group: '@P.x>0' } } }, 'c');
  const GL = grp.points.get('cluster')!.data as Int32Array;
  let gOk = true;
  for (let i = 0; i < grp.numPoints; i++) if ((grp.P[i * 3] > 0) !== (GL[i] >= 0)) gOk = false;
  check(gOk, 'group: points outside get -1');
}

// ---------------------------------------------------------------- prune
section('prune');
{
  const PTS: Record<string, NodeSpec> = { g: { type: 'grid', params: { size: [10, 10] } }, s: { type: 'scatter', in: ['g'], params: { count: 600, relax: false } }, o: { type: 'orient', in: ['s'], params: { scale_min: 0.5, scale_max: 1.5 } } };
  const pr = await geo({ ...PTS, p: { type: 'prune', in: ['o'], params: { radius: 0.3 } } }, 'p');
  const before = await geo(PTS, 'o');
  const r = (g: Geometry, i: number) => 0.3 * attr(g, 'pscale')[i];
  let overlaps = 0;
  for (let i = 0; i < pr.numPoints; i++) for (let j = i + 1; j < pr.numPoints; j++) if (Math.hypot(pr.P[i * 3] - pr.P[j * 3], pr.P[i * 3 + 2] - pr.P[j * 3 + 2]) < r(pr, i) + r(pr, j)) overlaps++;
  check(overlaps === 0 && pr.numPoints < before.numPoints && pr.numPoints > 100, `overlap: ${before.numPoints} → ${pr.numPoints} points, ${overlaps} overlapping spheres`);
  let biggest = 0;
  for (let i = 1; i < before.numPoints; i++) if (attr(before, 'pscale')[i] > attr(before, 'pscale')[biggest]) biggest = i;
  const kd = new KDTree(pr.P);
  check(kd.nearest(before.P[biggest * 3], before.P[biggest * 3 + 1], before.P[biggest * 3 + 2]).dist < 1e-12, 'priority largest: the biggest sphere survives');
  let covered = true;
  for (let i = 0; i < before.numPoints; i++) {
    const near = kd.nearest(before.P[i * 3], before.P[i * 3 + 1], before.P[i * 3 + 2]);
    if (near.dist < 1e-12) continue;
    const hits = kd.within(before.P[i * 3], before.P[i * 3 + 1], before.P[i * 3 + 2], r(before, i) + 0.3 * 1.5);
    if (!hits.some((j) => Math.hypot(before.P[i * 3] - pr.P[j * 3], before.P[i * 3 + 2] - pr.P[j * 3 + 2]) < r(before, i) + r(pr, j))) covered = false;
  }
  check(covered, 'every removed point overlapped a kept one');
  const rndP = await geo({ ...PTS, p: { type: 'prune', in: ['o'], params: { radius: 0.3, priority: 'random', use_pscale: false } } }, 'p');
  check(minOf(nnDistances(rndP.P)) >= 0.6 - 1e-12, 'priority random, fixed radius: kept points at least 2 × radius apart');
  // density filter
  const D: Record<string, NodeSpec> = { g: { type: 'grid', params: { size: [10, 10] } }, s: { type: 'scatter', in: ['g'], params: { count: 4000, relax: false } } };
  const d1 = await geo({ ...D, p: { type: 'prune', in: ['s'], params: { mode: 'density', fraction: 0.3 } } }, 'p');
  check(Math.abs(d1.numPoints - 1200) < 120, `density fraction 0.3 (no mask attribute = 1): ${d1.numPoints} of 4000 kept`);
  const d2 = await geo({ ...D, m: { type: 'attrib_create', in: ['s'], params: { name: 'mask', value: 0.5 } }, p: { type: 'prune', in: ['m'], params: { mode: 'density' } } }, 'p');
  check(Math.abs(d2.numPoints - 2000) < 200, `density by mask 0.5: ${d2.numPoints} of 4000 kept`);
  // expression
  const E: Record<string, NodeSpec> = { p: { type: 'points', params: { positions: [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]], attribs: { mask: [0.1, 0.6, 0.4, 0.9] } } } };
  const ex = await geo({ ...E, x: { type: 'prune', in: ['p'], params: { mode: 'expression', expression: '@mask < 0.5' } } }, 'x');
  check(eq(Array.from(attr(ex, 'mask')), [0.6, 0.9]), 'expression "@mask < 0.5" (spaces allowed) removes those points');
  const inv = await geo({ ...E, x: { type: 'prune', in: ['p'], params: { mode: 'expression', expression: '@mask<0.5', invert: true } } }, 'x');
  check(eq(Array.from(attr(inv, 'mask')), [0.1, 0.4]), 'invert keeps them instead');
  // near geometry
  const NG: Record<string, NodeSpec> = { p: { type: 'point_grid', params: { counts: [11, 1, 11], size: [10, 0, 10] } }, b: { type: 'box', params: { size: [4, 2, 4] } } };
  const ng = await geo({ ...NG, x: { type: 'prune', in: ['p', 'b'], params: { mode: 'near_geometry', distance: 1.5 } } }, 'x');
  let ngOk = true;
  for (let i = 0; i < ng.numPoints; i++) { const x = Math.abs(ng.P[i * 3]), z = Math.abs(ng.P[i * 3 + 2]); if (Math.hypot(Math.max(0, x - 2), Math.max(0, z - 2)) < 1.5) ngOk = false; }
  check(ngOk && ng.numPoints === 121 - 49, `near_geometry 1.5 m from a box (inside too): ${ng.numPoints} of 121 points left`);
  check(/connect the geometry to keep away from/.test(await cookErr({ ...NG, x: { type: 'prune', in: ['p'], params: { mode: 'near_geometry' } } }, 'x')), 'near_geometry without a second input: clear error');
}

// ---------------------------------------------------------------- copy_to_points: variant weights, scale/rotate attributes
section('copy_to_points variants');
{
  const TREES: Record<string, NodeSpec> = {
    a0: { type: 'box', params: { size: [0.2, 1, 0.2] } }, a: { type: 'attrib_create', in: ['a0'], params: { name: 'name', class: 'prim', value: 'a' } },
    b0: { type: 'sphere', params: { type: 'ico', level: 0, radius: 0.3 } }, b: { type: 'attrib_create', in: ['b0'], params: { name: 'name', class: 'prim', value: 'b' } },
    c0: { type: 'tube', params: { radius: 0.2, height: 0.8, cols: 5 } }, c: { type: 'attrib_create', in: ['c0'], params: { name: 'name', class: 'prim', value: 'c' } },
    trees: { type: 'merge', in: ['a', 'b', 'c'] },
    pts: { type: 'point_grid', params: { counts: [100, 1, 100], size: [100, 0, 100] } },
  };
  const w = await geo({ ...TREES, cp: { type: 'copy_to_points', in: ['trees', 'pts'], params: { pack: true, variants: 'name', variant_weights: [6, 3, 1], seed: 5 } } }, 'cp');
  const counts = [0, 0, 0];
  const srcName = w.packedSources.map((s) => (s.prims.get('name')!.data as string[])[0]);
  for (let p = 0; p < w.numPrims; p++) counts['abc'.indexOf(srcName[w.packedSource![p]])]++;
  const fr = counts.map((c) => c / w.numPrims), want = [0.6, 0.3, 0.1];
  check(w.numPrims === 10000 && fr.every((f, k) => Math.abs(f - want[k]) <= 0.05 * want[k]), `variant_weights [6, 3, 1] over 10k points: ${fr.map((f) => f.toFixed(4)).join(' / ')} (within 5%)`);
  const real = await geo({ ...TREES, pts: { type: 'point_grid', params: { counts: [10, 1, 10], size: [20, 0, 20] } }, cp: { type: 'copy_to_points', in: ['trees', 'pts'], params: { variants: 'name', variant_weights: [6, 3, 1], seed: 5 } } }, 'cp');
  const packd = await geo({ ...TREES, pts: { type: 'point_grid', params: { counts: [10, 1, 10], size: [20, 0, 20] } }, cp: { type: 'copy_to_points', in: ['trees', 'pts'], params: { pack: true, variants: 'name', variant_weights: [6, 3, 1], seed: 5 } } }, 'cp');
  check(fpEq(real, expandPacked(packd, { transfer: '*' }).geo), 'variant_weights: packed copies = real copies after unpack');
  const warnAttr = await run({ ...TREES, v: { type: 'attrib_create', in: ['pts'], params: { name: 'variant', value: 1 } }, cp: { type: 'copy_to_points', in: ['trees', 'v'], params: { pack: true, variants: 'name', variant_weights: [1, 1, 1] } } }, 'cp');
  check(warnAttr.ok && warnAttr.warnings.some((x) => /variant_weights ignored/.test(x.message)), 'variant_weights with a variant attribute: the attribute wins (warning)');
  check(/all 0/.test(await cookErr({ ...TREES, cp: { type: 'copy_to_points', in: ['trees', 'pts'], params: { variants: 'name', variant_weights: [0, 0] } } }, 'cp')), 'variant_weights all 0: clear error');
  // by name (dogfood 2026-10-15: a list follows the sorted piece order): {c: 1, a: 6, b: 3} = [6, 3, 1]
  const byName = await geo({ ...TREES, cp: { type: 'copy_to_points', in: ['trees', 'pts'], params: { pack: true, variants: 'name', variant_weights: { c: 1, a: 6, b: 3 }, seed: 5 } } }, 'cp');
  check(fpEq(byName, w), 'variant_weights by name {c: 1, a: 6, b: 3} = the list [6, 3, 1] (same picks)');
  const typo = await run({ ...TREES, cp: { type: 'copy_to_points', in: ['trees', 'pts'], params: { pack: true, variants: 'name', variant_weights: { a: 1, tree: 2 } } } }, 'cp');
  check(typo.ok && typo.warnings.some((x) => /no variant named "tree" \(variants: a, b, c\)/.test(x.message)), 'variant_weights by name: an unknown name warns and lists the variants');

  // scale_attrib / rotate_attrib = pscale / rot; packed = real
  const PT: Record<string, NodeSpec> = {
    b: { type: 'box', params: { size: [0.4, 1, 0.2], center: [0, 0.5, 0] } },
    p: { type: 'points', params: { positions: [[0, 0, 0], [2, 0, 0], [4, 0, 1]], attribs: { s: [1, 2, 0.5], yaw: [0, 90, 45], e: [[0, 0, 0], [30, 0, 0], [0, 45, 10]] } } },
  };
  const viaAttr = await geo({ ...PT, c: { type: 'copy_to_points', in: ['b', 'p'], params: { scale_attrib: 's', rotate_attrib: 'yaw' } } }, 'c');
  const viaStd = await geo({ ...PT, w: { type: 'wrangle', in: ['p'], params: { code: '@pscale = @s; const h = @yaw * Math.PI / 360; @rot = [0, Math.sin(h), 0, Math.cos(h)];' } }, c: { type: 'copy_to_points', in: ['b', 'w'] } }, 'c');
  check(maxDiff(viaAttr.P, viaStd.P) < 1e-9, 'scale_attrib = pscale and rotate_attrib (float) = a yaw rot quaternion');
  for (const [label, params] of [['scale + yaw', { scale_attrib: 's', rotate_attrib: 'yaw' }], ['euler', { rotate_attrib: 'e' }], ['weights', { variants: 'name', variant_weights: [1, 2, 3] }]] as const) {
    const nodes = { ...PT, ...TREES, src: label === 'weights' ? ({ type: 'null', in: ['trees'] } as NodeSpec) : ({ type: 'null', in: ['b'] } as NodeSpec), o: { type: 'orient', in: ['p'], params: { mode: 'direction', random_yaw: [0, 360] } } as NodeSpec };
    const r1 = await geo({ ...nodes, cc: { type: 'copy_to_points', in: ['src', 'o'], params } }, 'cc');
    const r2 = await geo({ ...nodes, cc: { type: 'copy_to_points', in: ['src', 'o'], params: { ...params, pack: true } } }, 'cc');
    check(fpEq(r1, expandPacked(r2, { transfer: '*' }).geo), `copy_to_points ${label}: packed = real copies after unpack`);
  }
  check(/scale_attrib "nope"/.test(await cookErr({ ...PT, c: { type: 'copy_to_points', in: ['b', 'p'], params: { scale_attrib: 'nope' } } }, 'c')), 'missing scale_attrib: clear error');
}

// ---------------------------------------------------------------- packed input, examples
section('packed instances, examples');
{
  const PK: Record<string, NodeSpec> = { g: { type: 'grid', params: { size: [10, 10] } }, s: { type: 'scatter', in: ['g'], params: { count: 60 } }, b: { type: 'box', params: { size: 0.3 } }, cp: { type: 'copy_to_points', in: ['b', 's'], params: { pack: true } } };
  for (const [type, params] of [['mask', { by: 'height', min: -1, max: 1 }], ['orient', { random_yaw: [0, 360] }], ['cluster', { count: 4 }], ['prune', { radius: 0.4, use_pscale: false }]] as const) {
    const r = await run({ ...PK, x: { type, in: ['cp'], params } }, 'x');
    const g = r.geo!;
    check(r.ok && g.numPacked > 0 && g.numPacked === g.numPoints && !r.warnings.some((w) => /unpack/.test(w.message)) && !checkGeo(g).length, `${type} keeps packed instances (${g.numPacked} of 60)`);
  }
  const auto = await run({ ...PK, x: { type: 'scatter', in: ['cp'], params: { count: 20 } } }, 'x');
  check(auto.ok && auto.geo!.numPoints === 20 && auto.warnings.some((w) => /unpack/i.test(w.message)), 'scatter on packed instances unpacks them (warning)');
  const pac = await run({ c: { type: 'curve', params: { points: [[0, 0, 0], [5, 0, 0]] } }, p: { type: 'points_along_curve', in: ['c'], params: { spacing: 1 } } }, 'p');
  check(pac.ok && pac.geo!.numPoints === 6, 'points_along_curve: 5 m at 1 m → 6 points');
  for (const t of ['scatter', 'mask', 'orient', 'points_along_curve', 'cluster', 'prune']) {
    const ex = getNodeDef(t)!.example;
    const r = await engine.cook(ex.nodes ? ex : { nodes: { a: ex }, output: 'a' });
    check(r.ok && r.geo!.numPoints > 0, `${t}: its docs example cooks (${r.geo?.numPoints ?? 0} points)`);
  }
}

section('scatter backend selection');
{
  const nodes = (backend: string): Record<string, NodeSpec> => ({
    g: GRID,
    m: { type: 'mask', in: ['g'], params: { by: 'noise', min: 0.3, max: 1, falloff: 0.1 } },
    s: { type: 'scatter', in: ['m'], params: { count: 160, seed: 47, generate_by: 'count', density_mask: 'mask',
      min_distance: 0.1, max_per_prim: 3, relax_iterations: 2, write_primuv: true, write_seed: true, backend } },
  });
  check(!getLoadedKernels(), 'scatter auto leaves kernels unloaded until explicitly requested');
  const js = await geo(nodes('js'), 's'), fallback = await run(nodes('auto'), 's');
  check(fallback.ok && fpEq(fallback.geo!, js), 'scatter auto before kernel load matches explicit js');
  await loadKernels(fs.readFileSync(kernelsWasmURL));
  const auto = await run(nodes('auto'), 's'), kernel = await geo(nodes('kernel'), 's');
  check(auto.ok && !auto.results.get('s')?.cached, 'loading kernels invalidates cached scatter auto fallback');
  check(fpEq(auto.geo!, kernel) && fpEq(kernel, js), 'loaded auto, kernel and js scatter have identical fingerprints');
  engine.cache.clear();
  check(fpEq(await geo(nodes('js'), 's'), js), 'explicit js stays unchanged after kernels load');
  check(/backend/.test(await cookErr(nodes('invalid'), 's')), 'invalid scatter backend is rejected by parameter validation');
}

console.log(`\npcg: ${pass} passed, ${fail} failed`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
