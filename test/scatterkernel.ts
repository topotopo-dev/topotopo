// Scatter WASM: exact JS/scalar/SIMD parity, input ownership, order/caps, and hostile ABI input.
// node test/scatterkernel.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as scalar from '../kernels/pkg/topotopo_kernels.js';
import * as simd from '../kernels/pkg-simd/topotopo_kernels.js';
import { relaxOnSurface, sampleEliminate, scatterAutoUsesJs } from '../src/core/scatter.ts';
import { minDistanceSelect, TriSurface } from '../src/core/pcg.ts';
import { Geometry } from '../src/core/geometry.ts';
import { triangulate } from '../src/core/topology.ts';
import { rng } from '../src/core/random.ts';
import { kernelsWasmURL, loadKernels } from '../src/wasm/kernels.ts';
import type { ScatterRelaxResult } from '../src/wasm/kernels.ts';

await scalar.default({ module_or_path: fs.readFileSync(new URL('../kernels/pkg/topotopo_kernels_bg.wasm', import.meta.url)) });
await simd.default({ module_or_path: fs.readFileSync(new URL('../kernels/pkg-simd/topotopo_kernels_bg.wasm', import.meta.url)) });
const kernels = await loadKernels(fs.readFileSync(kernelsWasmURL));
let checks = 0;
function exact(actual: ArrayBufferView, expected: ArrayBufferView, label: string): void {
  assert.equal(actual.constructor, expected.constructor, `${label}: array type`);
  assert.deepEqual(new Uint8Array(actual.buffer, actual.byteOffset, actual.byteLength),
    new Uint8Array(expected.buffer, expected.byteOffset, expected.byteLength), `${label}: identical bytes`);
  checks++;
}

// The measured crossover applies to actual parallel capacity, with separate units for candidates and kept points.
// The node supplies zero workers for cold/unavailable pools or when the configured pool minimum excludes a stage.
const autoCases: [stage: 'eliminate' | 'relax', count: number, varying: boolean, workers: number, js: boolean][] = [
  ['eliminate', 199_999, true, 3, false], ['eliminate', 200_000, true, 3, true],
  ['eliminate', 200_000, true, 15, true], ['eliminate', 499_999, true, 2, false],
  ['eliminate', 500_000, true, 2, true], ['eliminate', 5_000_000, true, 1, false],
  ['eliminate', 500_000, true, 0, false], ['eliminate', 5_000_000, false, 15, true],
  ['eliminate', 499_999, false, 4, false], ['eliminate', 500_000, false, 4, true],
  ['eliminate', 500_000, false, 3, false], ['eliminate', 249_999, false, 8, false],
  ['eliminate', 250_000, false, 8, true], ['eliminate', 250_000, false, 7, false],
  ['eliminate', 250_000, false, 15, true], ['eliminate', 199_999, false, 15, false],
  ['eliminate', 5_000_000, false, 2, false], ['eliminate', 500_000, false, 0, false],
  ['relax', 49_999, false, 3, false], ['relax', 50_000, false, 3, true],
  ['relax', 50_000, true, 3, true], ['relax', 50_000, false, 15, true],
  ['relax', 500_000, true, 2, false], ['relax', 50_000, false, 1, false],
  ['relax', 50_000, true, 0, false],
];
for (const [stage, count, varying, workers, js] of autoCases) {
  assert.equal(scatterAutoUsesJs(stage, count, varying, workers), js,
    `auto ${stage}: ${count} points, varying ${varying}, ${workers} eligible workers`);
  checks++;
}

for (let seed = 0; seed < 12; seed++) {
  const random = rng(seed), n = 100 + seed * 37;
  const positions = Float64Array.from({ length: 3 * n }, (_, i) => i % 3 === 1 && seed % 2 ? 0 : random() * 10 - 5);
  if (seed % 3 === 0) for (let i = 0; i < 3 * n; i++) positions[i] = Math.round(positions[i]); // exact ties, duplicates
  const saved = positions.slice(), radius = seed % 2 ? 0.7 : 1.5;
  for (const weighted of [false, true]) {
    const scale = weighted ? Float64Array.from({ length: n }, () => 0.25 + random() * 2) : new Float64Array();
    const savedScale = scale.slice();
    for (const target of [0, Math.floor(n / 5), n, n + 3]) {
      const label = `seed ${seed}, weighted ${weighted}, target ${target}`;
      const js = sampleEliminate(positions, target, radius, weighted ? scale : undefined);
      const a = scalar.scatter_eliminate_f64(positions, scale, target, radius);
      exact(a, js, `${label}: scalar/JS`);
      exact(simd.scatter_eliminate_f64(positions, scale, target, radius), a, `${label}: SIMD/scalar`);
      exact(kernels.scatter_eliminate(positions, target, radius, weighted ? scale : undefined), a, `${label}: loader/scalar`);
      assert.equal(a.length, Math.min(n, target), `${label}: exact count`); checks++;
      for (let i = 1; i < a.length; i++) assert.ok(a[i] > a[i - 1], `${label}: ascending unique indices`);
    }
    exact(positions, saved, 'elimination does not mutate positions');
    exact(scale, savedScale, 'elimination does not mutate scale');
    const p32 = Float32Array.from(positions), s32 = Float32Array.from(scale), target = Math.floor(n / 5);
    const js32 = sampleEliminate(Float64Array.from(p32), target, radius, weighted ? s32 : undefined);
    const a32 = scalar.scatter_eliminate(p32, s32, target, radius);
    exact(a32, js32, 'f32: same selection as JS on widened input');
    exact(simd.scatter_eliminate(p32, s32, target, radius), a32, 'f32: SIMD/scalar');
    exact(kernels.scatter_eliminate(p32, target, radius, weighted ? s32 : undefined), a32, 'f32: loader/scalar');
  }
  const order = Int32Array.from({ length: n }, (_, i) => n - i - 1);
  const groups = Int32Array.from({ length: n }, (_, i) => i % 7);
  for (const r of [0, 0.25, 1]) for (const limit of [0, 1, 30, n]) for (const cap of [0, 3]) {
    const counts = new Map<number, number>();
    const js = minDistanceSelect(positions, order, r, limit,
      cap ? i => (counts.get(groups[i]) ?? 0) < cap : undefined,
      cap ? i => counts.set(groups[i], (counts.get(groups[i]) ?? 0) + 1) : undefined);
    const gs = cap ? groups : new Int32Array();
    const a = scalar.scatter_min_distance_f64(positions, order, r, limit, gs, cap);
    exact(a, js, `min distance ${r}, limit ${limit}, cap ${cap}: scalar/JS`);
    exact(simd.scatter_min_distance_f64(positions, order, r, limit, gs, cap), a, 'min distance: SIMD/scalar');
    exact(kernels.scatter_min_distance(positions, order, r, limit, cap ? groups : undefined, cap), a, 'min distance: loader/scalar');
  }
  exact(positions, saved, 'minimum distance does not mutate positions');
}

// Exercise both sides of the compact-grid cutoff, SIMD pairs with odd tails, and exact distance ties in
// one-, two- and three-dimensional cells. Sparse/extreme domains must preserve the KD fallback's order too.
const searchCases: { label: string; positions: Float64Array; radius: number }[] = [];
for (const n of [255, 256, 257, 513]) {
  const positions = Float64Array.from({ length: n * 3 }, (_, k) => {
    const i = Math.floor(k / 3), axis = k % 3;
    return axis === 0 ? (i % 17 - 8) * 0.25 : axis === 1 ? (i % 2 ? -0 : 0) : (Math.floor(i / 17) - 8) * 0.25;
  });
  searchCases.push({ label: `planar grid ${n}`, positions, radius: 0.375 });
}
searchCases.push({ label: 'cubic grid, exact-radius boundaries and repeated distance shells', radius: 0.25,
  positions: Float64Array.from({ length: 729 * 3 }, (_, k) => {
    const i = Math.floor(k / 3), axis = k % 3;
    return (Math.floor(i / 9 ** axis) % 9 - 4) * 0.25;
  }) });
searchCases.push({ label: 'line cell boundaries and coincident odd tail', radius: 0.25,
  positions: Float64Array.from({ length: 385 * 3 }, (_, k) => {
    const i = Math.floor(k / 3);
    return k % 3 === 0 ? (Math.floor(i / 3) - 64) * 0.5 + (i % 3 - 1) * Number.EPSILON : 0;
  }) });
searchCases.push({ label: 'disconnected clusters with sparse-grid fallback', radius: 0.375,
  positions: Float64Array.from({ length: 513 * 3 }, (_, k) => {
    const i = Math.floor(k / 3), axis = k % 3;
    return axis === 1 ? 0 : (i < 256 ? -1e6 : 1e6) + (axis === 0 ? i % 16 : Math.floor(i / 16) % 16) * 0.25;
  }) });
searchCases.push({ label: 'grid extent beyond wasm32 usize falls back safely', radius: 0.25,
  positions: Float64Array.from({ length: 513 * 3 }, (_, k) => {
    const i = Math.floor(k / 3);
    return k % 3 === 0 ? (i < 256 ? 0 : 2 ** 32) + (i % 16) * 0.25 : k % 3 === 1 ? 0 : (Math.floor(i / 16) % 16) * 0.25;
  }) });
searchCases.push({ label: 'subnormal squared radius KD fallback', radius: 1e-155,
  positions: Float64Array.from({ length: 257 * 3 }, (_, k) => k % 3 === 0 ? (Math.floor(k / 3) - 128) * 1e-155 : 0) });
for (const { label, positions, radius } of searchCases) {
  const n = positions.length / 3, saved = positions.slice(), target = Math.floor(n / 4);
  for (const adaptive of [false, true]) {
    const scale = adaptive ? Float64Array.from({ length: n }, (_, i) => [0.25, 0.5, 1, 1, 2][i % 5]) : undefined;
    const expected = sampleEliminate(positions, target, radius, scale);
    exact(scalar.scatter_eliminate_f64(positions, scale ?? new Float64Array(), target, radius), expected,
      `${label}, adaptive ${adaptive}: scalar/JS`);
    exact(simd.scatter_eliminate_f64(positions, scale ?? new Float64Array(), target, radius), expected,
      `${label}, adaptive ${adaptive}: SIMD/JS`);
    exact(kernels.scatter_eliminate(positions, target, radius, scale), expected, `${label}: loader/JS`);
  }
  const order = Int32Array.from({ length: n }, (_, i) => n - i - 1);
  const groups = Int32Array.from({ length: n }, (_, i) => i % 11), counts = new Int32Array(11), cap = 5;
  const expected = minDistanceSelect(positions, order, radius, n,
    i => counts[groups[i]] < cap, i => { counts[groups[i]]++; });
  exact(scalar.scatter_min_distance_f64(positions, order, radius, n, groups, cap), expected, `${label}: minimum distance scalar/JS`);
  exact(simd.scatter_min_distance_f64(positions, order, radius, n, groups, cap), expected, `${label}: minimum distance SIMD/JS`);
  exact(kernels.scatter_min_distance(positions, order, radius, n, groups, cap), expected, `${label}: minimum distance loader/JS`);
  exact(positions, saved, `${label}: inputs unchanged`);
}

// Exactly-radius pairs are retained; the original order controls which near duplicates survive.
const boundary = new Float64Array([0, 0, 0, 1, 0, 0, 1 - Number.EPSILON, 0, 0]);
const extremePositions = new Float64Array(384 * 3).fill(1e-150), extremeScale = new Float64Array(384).fill(1e298);
const extremeExpected = sampleEliminate(extremePositions, 20, 1e-151, extremeScale);
exact(scalar.scatter_eliminate_f64(extremePositions, extremeScale, 20, 1e-151), extremeExpected, 'extreme adaptive grid extent: scalar/JS');
exact(simd.scatter_eliminate_f64(extremePositions, extremeScale, 20, 1e-151), extremeExpected, 'extreme adaptive grid extent: SIMD/JS');
exact(kernels.scatter_min_distance(boundary, new Int32Array([0, 1, 2]), 1), new Int32Array([0, 1]), 'strict minimum distance boundary');
exact(kernels.scatter_min_distance(boundary, new Int32Array([2, 1, 0]), 1), new Int32Array([2]), 'caller order is preserved');
const boundary32 = Float32Array.from(boundary), order32 = new Int32Array([2, 1, 0]);
const expected32 = minDistanceSelect(Float64Array.from(boundary32), order32, 1);
exact(kernels.scatter_min_distance(boundary32, order32, 1), expected32, 'f32 minimum distance: loader/JS on widened input');
exact(scalar.scatter_min_distance(boundary32, order32, 1, 3, new Int32Array(), 0), expected32, 'f32 minimum distance: scalar/JS');
exact(simd.scatter_min_distance(boundary32, order32, 1, 3, new Int32Array(), 0), expected32, 'f32 minimum distance: SIMD/JS');
exact(kernels.scatter_eliminate(new Float64Array(), 0, 1), new Int32Array(), 'empty elimination');
exact(kernels.scatter_min_distance(new Float64Array(), new Int32Array(), 1), new Int32Array(), 'empty minimum distance');

// A crease plus overlapping triangles exercises projection and equal-distance BVH ties. Coincident points exercise
// hashed repulsion directions. Inputs and the caller's initial triangle/barycentric arrays retain their ownership.
const mesh = new Geometry({ positions: [-2, 0, -2, 2, 0, -2, 2, 0, 2, -2, 0, 2, 0, 1, 0],
  prims: [[0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4], [0, 1, 4]] });
const surface = new TriSurface(mesh, triangulate(mesh).tris), arrays = surface.arrays();
for (const weighted of [false, true]) for (const coincident of [false, true]) for (const iterations of [0, 1, 4]) {
  const random = rng(19), n = 24;
  const positions = Float64Array.from({ length: n * 3 }, (_, i) => coincident ? 0 : i % 3 === 1 ? 0.4 : random() * 2 - 1);
  const spacing = new Float64Array(n).fill(0.55), triangles = new Int32Array(n), barycentrics = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) barycentrics[i * 3] = 1;
  const cw = weighted ? Float64Array.from({ length: surface.numTris * 3 }, (_, i) => i % 3 === 0 ? 0 : 0.25 + i / 10) : undefined;
  const options = { radius: 0, weighted, dBar: 0.55, wMean: 0.8 };
  const expected = { positions: positions.slice(), spacing: spacing.slice(), triangles: triangles.slice(), barycentrics: barycentrics.slice() };
  await relaxOnSurface(surface, expected.positions, expected.spacing, expected.triangles, expected.barycentrics,
    iterations, options, cw ?? null);
  const raw = (module: typeof scalar): ScatterRelaxResult => module.scatter_relax(positions, spacing, triangles,
    barycentrics, arrays.T, arrays.nodes, arrays.child, arrays.order, arrays.triPrim, arrays.C,
    cw ?? new Float64Array(), iterations, { radius: 0, weighted, d_bar: options.dBar, w_mean: options.wMean }) as ScatterRelaxResult;
  const a = raw(scalar), b = raw(simd), loaded = kernels.scatter_relax(positions, spacing, triangles, barycentrics,
    arrays, iterations, options, cw);
  for (const key of ['positions', 'spacing', 'triangles', 'barycentrics'] as const) {
    const label = `relax weighted ${weighted}, coincident ${coincident}, iterations ${iterations}, ${key}`;
    exact(a[key], expected[key], `${label}: scalar/JS`);
    exact(b[key], a[key], `${label}: SIMD/scalar`);
    exact(loaded[key], a[key], `${label}: loader/scalar`);
  }
  exact(triangles, new Int32Array(n), 'relax does not mutate input triangles');
  exact(spacing, new Float64Array(n).fill(0.55), 'relax does not mutate input spacing');
}

// More than 256 points enters the relaxation search grid. Repeated positions, zero spacing, changing adaptive
// radii and several passes exercise cell crossings and rebuilt neighbour tie order after surface projection.
for (const weighted of [false, true]) {
  const n = 289;
  const positions = Float64Array.from({ length: n * 3 }, (_, k) => {
    const i = Math.floor(k / 3), id = i % 11 === 0 ? i - i % 17 : i;
    return k % 3 === 0 ? (id % 17 - 8) * 0.1875 : k % 3 === 1 ? 0.4 : (Math.floor(id / 17) - 8) * 0.1875;
  });
  const spacing = Float64Array.from({ length: n }, (_, i) => i % 13 === 0 ? 0 : 0.2 + (i % 5) * 0.075);
  const triangles = new Int32Array(n), barycentrics = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) barycentrics[i * 3] = 1;
  const cw = weighted ? Float64Array.from({ length: surface.numTris * 3 }, (_, i) => i % 4 === 0 ? 0 : 0.2 + i / 10) : undefined;
  const options = { radius: 0, weighted, dBar: 0.35, wMean: 0.8 }, iterations = 6;
  const inputs = { positions, spacing, triangles, barycentrics };
  const saved = { positions: positions.slice(), spacing: spacing.slice(), triangles: triangles.slice(), barycentrics: barycentrics.slice() };
  const expected = { positions: positions.slice(), spacing: spacing.slice(), triangles: triangles.slice(), barycentrics: barycentrics.slice() };
  await relaxOnSurface(surface, expected.positions, expected.spacing, expected.triangles, expected.barycentrics,
    iterations, options, cw ?? null);
  const raw = (module: typeof scalar): ScatterRelaxResult => module.scatter_relax(positions, spacing, triangles,
    barycentrics, arrays.T, arrays.nodes, arrays.child, arrays.order, arrays.triPrim, arrays.C,
    cw ?? new Float64Array(), iterations, { radius: 0, weighted, d_bar: options.dBar, w_mean: options.wMean }) as ScatterRelaxResult;
  const a = raw(scalar), b = raw(simd), loaded = kernels.scatter_relax(positions, spacing, triangles, barycentrics,
    arrays, iterations, options, cw);
  for (const key of ['positions', 'spacing', 'triangles', 'barycentrics'] as const) {
    exact(a[key], expected[key], `relax grid weighted ${weighted}, ${key}: scalar/JS`);
    exact(b[key], expected[key], `relax grid weighted ${weighted}, ${key}: SIMD/JS`);
    exact(loaded[key], expected[key], `relax grid weighted ${weighted}, ${key}: loader/JS`);
    exact(inputs[key], saved[key], `relax grid weighted ${weighted}, ${key}: inputs unchanged`);
  }
}

const valid = new Float64Array([0, 0, 0, 1, 0, 0]), order = new Int32Array([0, 1]);
exact(kernels.scatter_eliminate(valid, 6_000_000, 1), order, 'requested target is capped to available candidates');
exact(kernels.scatter_min_distance(valid, order, 0, Infinity, new Int32Array([0, 0]), 6_000_000), order, 'group cap beyond candidate count stays unrestricted');
const duplicateOrder = new Int32Array([0, 0, 0, 0, 0]);
exact(kernels.scatter_min_distance(valid, duplicateOrder, 0, Infinity, new Int32Array([0, 0]), 6_000_000), duplicateOrder, 'large caps preserve duplicate entries in caller order');
const cyclicChildren = arrays.child.slice(); cyclicChildren[0] = 0; cyclicChildren[1] = 0;
const relaxArgs = { radius: 0, weighted: false, dBar: 0.5, wMean: 1 };
const hostile: [string, () => unknown][] = [
  ['incomplete position', () => kernels.scatter_eliminate(new Float64Array([0, 1]), 1, 1)],
  ['nonfinite position', () => kernels.scatter_eliminate(new Float64Array([NaN, 0, 0]), 0, 1)],
  ['infinite position', () => kernels.scatter_min_distance(new Float64Array([Infinity, 0, 0]), new Int32Array([0]), 1)],
  ['negative count', () => kernels.scatter_eliminate(valid, -1, 1)],
  ['fractional count', () => kernels.scatter_eliminate(valid, 0.5, 1)],
  ['invalid radius', () => kernels.scatter_eliminate(valid, 1, NaN)],
  ['negative radius', () => kernels.scatter_min_distance(valid, order, -1)],
  ['invalid scale length', () => kernels.scatter_eliminate(valid, 1, 1, new Float64Array([1]))],
  ['nonfinite scale', () => kernels.scatter_eliminate(valid, 1, 1, new Float64Array([1, Infinity]))],
  ['negative index', () => kernels.scatter_min_distance(valid, new Int32Array([-1]), 1)],
  ['index past input', () => kernels.scatter_min_distance(valid, new Int32Array([2]), 1)],
  ['fractional limit', () => kernels.scatter_min_distance(valid, order, 1, 1.5)],
  ['invalid group length', () => kernels.scatter_min_distance(valid, order, 1, 2, new Int32Array([0]), 1)],
  ['negative group ID', () => kernels.scatter_min_distance(valid, order, 1, 2, new Int32Array([0, -1]), 1)],
  ['relax invalid spacing', () => kernels.scatter_relax(valid, new Float64Array([0.5, NaN]), order,
    new Float64Array(6), arrays, 1, relaxArgs)],
  ['relax cyclic BVH', () => kernels.scatter_relax(valid, new Float64Array([0.5, 0.5]), order,
    new Float64Array(6), { ...arrays, child: cyclicChildren }, 1, relaxArgs)],
  ['relax excessive iterations', () => kernels.scatter_relax(valid, new Float64Array([0.5, 0.5]), order,
    new Float64Array(6), arrays, 1025, relaxArgs)],
];
for (const [label, run] of hostile) {
  assert.throws(run, /scatter_/, label); checks++;
  exact(kernels.scatter_min_distance(valid, order, 1), order, `${label}: next valid call still works`);
}
console.log(`scatterkernel: ${checks} checks passed (exact JS/scalar/SIMD indices; hostile inputs rejected)`);
