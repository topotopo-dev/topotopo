// Compare the two shipped builds directly, independently of loader feature detection or overrides.
// node test/erosionsimd.ts [path/to/simd/package]
// Every returned field is exact: floats, signed zeros, topology, provenance and quality statistics.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as scalar from '../kernels/pkg/topotopo_kernels.js';
import type { GridInput, KernelGrid, QuadRemeshOptions } from '../src/wasm/kernels.ts';

const simdPath = process.argv[2] ? path.resolve(process.argv[2]) : fileURLToPath(new URL('../kernels/pkg-simd/', import.meta.url));
const simd: typeof scalar = await import(pathToFileURL(path.join(simdPath, 'topotopo_kernels.js')).href);
const scalarBytes = fs.readFileSync(new URL('../kernels/pkg/topotopo_kernels_bg.wasm', import.meta.url));
const simdBytes = fs.readFileSync(path.join(simdPath, 'topotopo_kernels_bg.wasm'));
assert.notDeepEqual(simdBytes, scalarBytes, 'parity requires two different build artifacts');
assert.ok(scalarBytes.length + simdBytes.length <= 2_500_000, 'combined shipped WASM size is at most 2.5 MB');
await scalar.default({ module_or_path: scalarBytes });
await simd.default({ module_or_path: simdBytes });

type KernelName = Exclude<keyof typeof scalar, 'default' | 'initSync'>;
const coverage = new Map<KernelName, number>();
let checks = 0;
let rejections = 0;
function exact(actual: unknown, expected: unknown, label: string): void {
  if (ArrayBuffer.isView(expected)) {
    assert.ok(ArrayBuffer.isView(actual), `${label}: typed array result`);
    assert.equal(actual.constructor, expected.constructor, `${label}: array type`);
    assert.deepEqual(
      new Uint8Array(actual.buffer, actual.byteOffset, actual.byteLength),
      new Uint8Array(expected.buffer, expected.byteOffset, expected.byteLength),
      `${label}: identical bytes`,
    );
  } else if (expected !== null && typeof expected === 'object') {
    assert.ok(actual !== null && typeof actual === 'object', `${label}: object result`);
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${label}: result fields`);
    for (const key of Object.keys(expected)) exact(
      (actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key], `${label}.${key}`,
    );
  } else {
    assert.equal(actual, expected, label);
  }
}
function compare<T extends object>(name: KernelName, label: string, run: (module: typeof scalar) => T): T {
  const expected = run(scalar);
  exact(run(simd), expected, `${name}: ${label}`);
  coverage.set(name, (coverage.get(name) ?? 0) + 1);
  checks++;
  return expected;
}
const contourErrors = new Set([
  'dual_contour: an unconstrained QEF leaves its source cell; enable clamp_to_cell for safe extraction',
  'dual_contour: level set reaches the grid boundary; enlarge the grid padding or reduce the iso/offset',
  'dual_contour: a sign-changing edge has an infinite sample; increase band width or fill the grid',
]);
function compareContour(grid: GridInput, index: number, iso: number, tolerance: number, sharp: boolean, clamp: boolean,
  conservative = false, adaptive = 0, sharpThreshold = 0.5): void {
  // Safe extraction rejects boundary surfaces, infinite sign-changing edges and
  // unclamped QEF solutions outside their cell. Keep rejection counts separate.
  const label = `dual_contour: grid ${index}, iso ${iso}, sharp ${sharp}, clamp ${clamp}, conservative ${conservative}, adaptive ${adaptive}, sharp threshold ${sharpThreshold}`;
  let expected: object;
  try {
    expected = scalar.dual_contour(grid, iso, tolerance, sharp, clamp, conservative, adaptive, sharpThreshold);
  } catch (error) {
    assert.ok(typeof error === 'string' && contourErrors.has(error), `${label}: known ABI validation error`);
    assert.throws(() => simd.dual_contour(grid, iso, tolerance, sharp, clamp, conservative, adaptive, sharpThreshold), actual => actual === error, label);
    rejections++;
    return;
  }
  exact(simd.dual_contour(grid, iso, tolerance, sharp, clamp, conservative, adaptive, sharpThreshold), expected, label);
  coverage.set('dual_contour', (coverage.get('dual_contour') ?? 0) + 1);
  checks++;
}

// Split events, holes, collinear vertices, close edge directions and a nonuniform convex contour.
const polygons = [
  { name: 'rectangle', outer: [0, 0, 6, 0, 6, 4, 0, 4], holes: [] },
  { name: 'concave', outer: [0, 0, 6, 0, 6, 2, 2, 2, 2, 6, 0, 6], holes: [] },
  { name: 'courtyard', outer: [0, 0, 8, 0, 8, 8, 0, 8], holes: [[2, 2, 2, 6, 6, 6, 6, 2]] },
  { name: 'collinear', outer: [0, 0, 3, 0, 6, 0, 6, 4, 0, 4], holes: [] },
  { name: 'near-parallel', outer: [0, 0, 3, 1e-7, 6, 0, 6, 4, 0, 4], holes: [] },
  { name: '31 vertices', outer: Array.from({ length: 31 }, (_, i) => {
    const a = i * 2 * Math.PI / 31;
    return [Math.cos(a) * (10 + 0.01 * (i % 3)), Math.sin(a) * (10 + 0.01 * (i % 3))];
  }).flat(), holes: [] },
];
for (const [index, p] of polygons.entries()) {
  const outer = Float64Array.from(p.outer), holes = p.holes.map(ring => Float64Array.from(ring));
  compare('straight_skeleton', p.name, k => k.straight_skeleton(outer, holes));
  for (const distance of [-0.05, 0.05, 20])
    compare('offset_polygon', `${p.name}, distance ${distance}`, k => k.offset_polygon(outer, holes, distance));
  compare('roof', p.name, k => k.roof(outer, holes, Float64Array.of(35)));
  compare('roof', `${p.name}, capped`, k => k.roof(outer, holes, Float64Array.of(35), 0.5));
  if (index < 3) {
    const count = outer.length / 2 + holes.reduce((sum, ring) => sum + ring.length / 2, 0);
    const pitches = Float64Array.from({ length: count }, (_, i) => [23, 41, 57, 32, 64, 48, 38][i % 7]);
    const weights = pitches.map(pitch => 1 / Math.tan(pitch * Math.PI / 180));
    compare('straight_skeleton', `${p.name}, weighted`, k => k.straight_skeleton(outer, holes, weights));
    compare('roof', `${p.name}, per-edge pitches`, k => k.roof(outer, holes, pitches, 0.5));
  }
}

const cubeP = Float64Array.of(-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1);
const cubeT = Uint32Array.of(0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5);
const reverseT = Uint32Array.from(cubeT, (_, i) => cubeT[i - i % 3 + [0, 2, 1][i % 3]]);
const meshGrids: KernelGrid[] = [];
for (const [name, tris] of [['closed cube', cubeT], ['reversed cube', reverseT], ['open cube', cubeT.slice(6)]] as const) {
  for (const fill of [false, true]) {
    const grid = compare('sdf_from_mesh', `${name}, fill ${fill}`,
      k => k.sdf_from_mesh(cubeP, tris, 0.25, 2, 4, fill)) as KernelGrid;
    meshGrids.push(grid);
  }
}
function analytic(dims: [number, number, number], origin: [number, number, number], voxel: number,
  sample: (x: number, y: number, z: number) => number): GridInput {
  const values = new Float32Array(dims[0] * dims[1] * dims[2]);
  for (let z = 0; z < dims[2]; z++) for (let y = 0; y < dims[1]; y++) for (let x = 0; x < dims[0]; x++)
    values[(z * dims[1] + y) * dims[0] + x] = sample(origin[0] + x * voxel, origin[1] + y * voxel, origin[2] + z * voxel);
  return { dims: Uint32Array.from(dims), origin: Float64Array.from(origin), voxel, values };
}
const sphere = analytic([9, 9, 9], [-1, -1, -1], 0.25, (x, y, z) => Math.hypot(x, y, z) - 0.7);
const oblong = analytic([10, 7, 8], [-1, -0.75, -0.75], 0.25, (x, y, z) => Math.hypot(x * 0.8, y, z) - 0.55);
const thin = analytic([2, 5, 3], [0, -0.5, -0.25], 0.25, (x, y, z) => x + 2 * y - z);
const shifted = analytic([5, 7, 9], [-0.8, -0.6, -1.1], 0.3, (x, y, z) => x - y / 2 + z / 4);
const signed = analytic([5, 3, 2], [0, 0, 0], 0.25, x => x === 0 ? -Infinity : x === 0.25 ? -0 : x === 0.5 ? 0 : x === 0.75 ? 0.25 : Infinity);
const grids = [sphere, oblong, thin, shifted, signed, ...meshGrids];
for (const [index, grid] of grids.entries()) {
  for (const distance of [-0.2, 0, 0.2])
    compare('grid_offset', `grid ${index}, offset ${distance}`, k => k.grid_offset(grid, distance));
  for (const radius of [0, 1, 3])
    compare('grid_blur', `grid ${index}, radius ${radius}`, k => k.grid_blur(grid, radius));
  compare('grid_dilate', `grid ${index}`, k => k.grid_dilate(grid, 0.375));
  compare('grid_erode', `grid ${index}`, k => k.grid_erode(grid, 0.375));
  for (const voxel of [grid.voxel, grid.voxel * 0.75, grid.voxel * 1.5])
    compare('grid_resample', `grid ${index}, voxel ${voxel}`, k => k.grid_resample(grid, voxel));
  for (const op of ['union', 'intersect', 'subtract', 'smooth_union', 'smooth_intersect', 'smooth_subtract'])
    compare('grid_csg', `grid ${index}, ${op}`, k => k.grid_csg(grid, shifted, op, 0.2));
  // Both QEF branches and the unclamped case, on odd, even, thin and infinite-band layouts.
  for (const sharp of [false, true]) for (const clamp of [false, true])
    compareContour(grid, index, 0, 1e-6, sharp, clamp);
  compareContour(grid, index, 0.125, 1e-4, true, true);
  compareContour(grid, index, 0, 1e-6, true, true, true);
  compareContour(grid, index, 0, 1e-6, true, true, false, 0.1, 0.25);
}

// Contouring parity includes retained quads, nonplanar splits, sharp features,
// topology fallback and adaptive requests, including their reported counts.
const contourCorpus = [
  analytic([21, 21, 21], [-1.25, -1.25, -1.25], 0.125, (x, y, z) => Math.hypot(Math.hypot(x, z) - 0.7, y) - 0.23),
  analytic([21, 21, 21], [-1.25, -1.25, -1.25], 0.125, (x, y, z) => {
    const q = [Math.abs(x - 0.023) - 0.63, Math.abs(y + 0.037) - 0.55, Math.abs(z - 0.019) - 0.47];
    return Math.hypot(...q.map(v => Math.max(0, v))) + Math.min(Math.max(...q), 0);
  }),
  analytic([21, 21, 21], [-1.25, -1.25, -1.25], 0.125, (x, y, z) => Math.min(
    Math.hypot(x + 0.23, y - 0.07, z + 0.13) - 0.58,
    Math.hypot(x - 0.31, y + 0.17, z - 0.09) - 0.51,
    Math.hypot(x - 0.11, y - 0.41, z + 0.27) - 0.38)),
  // Isolated alternating negative samples exercise cells with multiple sheets.
  analytic([9, 9, 9], [-1, -1, -1], 0.25, (x, y, z) => Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) > 0.5
    ? 1 : ((Math.round((x + y + z) * 4) & 1) ? -0.1 : 0.2)),
];
for (const [index, grid] of contourCorpus.entries()) for (const conservative of [false, true])
  for (const adaptive of [0, 0.1, 0.4]) for (const threshold of [0, 0.5, 1])
    compareContour(grid, grids.length + index, 0, 1e-6, true, true, conservative, adaptive, threshold);

function triangleGrid(w: number, h: number, noisy: boolean): { positions: Float64Array; tris: Uint32Array } {
  const positions = new Float64Array(w * h * 3), tris: number[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    positions.set([x / 2, noisy ? ((x * 17 + y * 13) % 7 - 3) / 128 : 0, -y / 2], (y * w + x) * 3);
    if (x + 1 < w && y + 1 < h) {
      const a = y * w + x;
      if ((x + y) % 2) tris.push(a, a + 1, a + w, a + 1, a + w + 1, a + w);
      else tris.push(a, a + 1, a + w + 1, a, a + w + 1, a + w);
    }
  }
  return { positions, tris: Uint32Array.from(tris) };
}
for (const [name, positions, tris, options] of [
  ['cube sharp', cubeP, cubeT, { target_length: 0.5, preserve_sharp: true }],
  ['cube smooth', cubeP, cubeT, { target_faces: 96, preserve_sharp: false, smooth_iterations: 4 }],
  ['cube quads only', cubeP, cubeT, { target_faces: 96, quad_only: true }],
] as const) compare('remesh_quad', name, k => k.remesh_quad(positions, tris, options));
for (const [w, h] of [[5, 5], [8, 7]]) for (const noisy of [false, true]) {
  const { positions, tris } = triangleGrid(w, h, noisy);
  const variants: QuadRemeshOptions[] = [
    { target_length: 0.5, quad_only: false },
    { target_faces: (w - 1) * (h - 1), quad_only: true, align_boundaries: false },
    { target_length: 0.5, crease_edges: Uint32Array.of(0, 1, 1, 2), locked_edges: Uint32Array.of(0, w, w, w * 2) },
  ];
  for (const [index, options] of variants.entries())
    compare('remesh_quad', `${w}x${h}, noisy ${noisy}, options ${index}`, k => k.remesh_quad(positions, tris, options));
}

// Keep the original 30 comparisons, now comparing every returned byte, and add thermal erosion.
const empty = new Float32Array(0), w = 33, h = 25;
for (let seed = 0; seed < 6; seed++) {
  const height = Float32Array.from({ length: w * h }, (_, i) => 4 + (h - 1 - Math.floor(i / w)) / 16 + Math.abs(i % w - 16) / 32 + ((i * 977 + seed * 23) % 47) / 64);
  const freeze = seed % 2 ? Float32Array.from(height, (_, i) => i % 7 === 0 ? 1 : 0) : empty;
  for (const boundary of ['closed', 'open']) {
    const params = { iterations: 25, rain_amount: 0.01, boundary, stream_power_k: seed % 2 ? 0.03 : 0 };
    compare('erode_pipe', `original seed ${seed}, ${boundary}`, k => k.erode_pipe(height, empty, freeze, empty, w, h, 1, params, BigInt(seed)));
  }
  compare('erode_droplet', `original seed ${seed}`, k => k.erode_droplet(height, empty, freeze, w, h, 0.1, { iterations: 10 }, BigInt(seed)));
  compare('thermal_erode', `original seed ${seed}`, k => k.thermal_erode(height, empty, w, h, 0.1, 0.4, 0.2, 10));
  for (const method of ['d8', 'dinf'])
    compare('flow_accumulation', `original seed ${seed}, ${method}`, k => k.flow_accumulation(height, w, h, 1, method));
}
// Tiny domains and each vector-tail length; hard/frozen cells, nonuniform rainfall, sinks and flat ties.
for (const [width, heightCount] of [[2, 2], [3, 5], [4, 4], [7, 6], [8, 9], [17, 13], [32, 24], [64, 65]]) {
  const label = `${width}x${heightCount}`, count = width * heightCount;
  const terrain = Float32Array.from({ length: count }, (_, i) => {
    const x = i % width - (width - 1) / 2, y = Math.floor(i / width) - (heightCount - 1) / 2;
    return (x * x + y * y) / 64 + (i % 11 === 0 ? 1 : 0);
  });
  const hardness = Float32Array.from({ length: count }, (_, i) => [0, 0.25, 0.8, 1][i % 4]);
  const freeze = Float32Array.from({ length: count }, (_, i) => i % 7 === 0 ? 1 : i % 3 === 0 ? 0.5 : 0);
  const rain = Float32Array.from({ length: count }, (_, i) => i % 5 === 0 ? 0 : (i % 3 + 1) / 2);
  for (const boundary of ['closed', 'open']) for (const iterations of [0, 15]) {
    const params = { iterations, boundary, rain_amount: 0.03, thermal_rate: 0.1, time_step: 0.02, stream_power_k: 0.01 };
    compare('erode_pipe', `${label}, masked, ${boundary}, ${iterations} steps`, k => k.erode_pipe(terrain, hardness, freeze, rain, width, heightCount, 0.5, params, 0xffffffffffffffffn));
  }
  compare('erode_pipe', `${label}, dry`, k => k.erode_pipe(terrain, empty, empty, empty, width, heightCount, 1, { iterations: 10, rain_amount: 0 }, 0n));
  compare('erode_droplet', `${label}, unmasked smoothing`, k => k.erode_droplet(terrain, empty, empty, width, heightCount, 0.5, { iterations: 5, rain_density: 0.2 }, 0n));
  compare('erode_droplet', `${label}, masked`, k => k.erode_droplet(terrain, hardness, freeze, width, heightCount, 0.5, { iterations: 5, erosion_radius: 2, thermal_rate: 0.1 }, 0xffffffffffffffffn));
  compare('thermal_erode', `${label}, hardness`, k => k.thermal_erode(terrain, hardness, width, heightCount, 0.5, 0.4, 0.2, 15));
  for (const method of ['d8', 'dinf']) {
    compare('flow_accumulation', `${label}, sinks, ${method}`, k => k.flow_accumulation(terrain, width, heightCount, 0.5, method));
    compare('flow_accumulation', `${label}, flat ties, ${method}`, k => k.flow_accumulation(new Float32Array(count), width, heightCount, 0.5, method));
  }
}

// Signed zero and alternating active/inactive thermal lanes, at odd and even row lengths.
for (const size of [7, 8]) for (const impulse of [0, 0.125, -0.125]) {
  const terrain = Float32Array.from({ length: size * size }, (_, i) => i % 2 ? -0 : 0);
  if (impulse !== 0) terrain[Math.floor(size / 2) * size + Math.floor(size / 2)] = impulse;
  const label = `${size}x${size}, signed zeros, impulse ${impulse}`;
  compare('thermal_erode', label, k => k.thermal_erode(terrain, empty, size, size, 1, 0, 0.25, 2));
  compare('erode_droplet', label, k => k.erode_droplet(terrain, empty, empty, size, size, 1,
    { iterations: 5, rain_density: 1, max_lifetime: 3, thermal_rate: 0 }, 1n));
}

// A new public binding cannot quietly ship without a scalar/SIMD result comparison.
const scatterP = Float64Array.from({ length: 384 * 3 }, (_, i) => i % 3 === 1 ? 0 : i % 3 === 0 ? (Math.floor(i / 3) % 24) / 10 : Math.floor(i / 72) / 10);
const scatterScale = Float64Array.from({ length: 384 }, (_, i) => 0.5 + (i % 7) / 10);
const scatterP32 = Float32Array.from(scatterP), scatterScale32 = Float32Array.from(scatterScale);
const scatterOrder = Int32Array.from({ length: 384 }, (_, i) => 383 - i), scatterGroups = Int32Array.from({ length: 384 }, (_, i) => i % 7);
compare('scatter_eliminate_f64', 'adaptive planar candidates', k => k.scatter_eliminate_f64(scatterP, scatterScale, 77, 0.2));
compare('scatter_eliminate', 'f32 adaptive planar candidates', k => k.scatter_eliminate(scatterP32, scatterScale32, 77, 0.2));
compare('scatter_min_distance_f64', 'ordered capped rejection', k => k.scatter_min_distance_f64(scatterP, scatterOrder, 0.2, 384, scatterGroups, 3));
compare('scatter_min_distance', 'f32 ordered capped rejection', k => k.scatter_min_distance(scatterP32, scatterOrder, 0.2, 384, scatterGroups, 3));
const scatterCorners = new Float64Array([0, 0, 0, 5, 0, 0, 0, 0, 5]);
const scatterBary = new Float64Array(384 * 3); for (let i = 0; i < 384; i++) scatterBary[i * 3] = 1;
compare('scatter_relax', 'planar projection', k => k.scatter_relax(scatterP, new Float64Array(384).fill(0.2), new Int32Array(384), scatterBary,
  scatterCorners, new Float64Array([0, 0, 0, 5, 0, 5]), new Int32Array([-1, 1]), new Int32Array([0]), new Uint32Array([0]),
  scatterCorners, new Float64Array(), 3, { radius: 0, weighted: false, d_bar: 0.2, w_mean: 1 }));
assert.deepEqual([...coverage.keys()].sort(), Object.keys(scalar).filter(name => name !== 'default' && name !== 'initSync').sort());
assert.deepEqual(Object.keys(simd).sort(), Object.keys(scalar).sort(), 'identical public bindings');
console.log(`erosionsimd: ${checks} scalar/SIMD bit-exact result comparisons passed across ${coverage.size} kernels`);
console.log(`erosionsimd: ${rejections} matching contour validation rejections`);
console.log(Object.fromEntries(coverage));
