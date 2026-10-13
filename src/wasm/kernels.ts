// The caller owns I/O; importing this module does not read or instantiate WASM.
import type { Host } from '../host/types.ts';
import type { ErosionParams } from '../core/erosion.ts';
import { hash32 } from '../core/random.ts';
import type { TriBVHArrays } from '../core/spatial.ts';

/** Source indices use flattened contour order: outer first, then each hole. */
export interface KernelProvenance {
  /** Exact input point, or -1 when the point uses the blend CSR. */
  src_point: Int32Array;
  blend_offset: Uint32Array;
  blend_index: Uint32Array;
  blend_weight: Float32Array;
  /** Input ring (outer = 0), or -1 for a generated height cap. */
  src_prim: Int32Array;
  /** Exact input corner for each output face corner, or -1 for a generated corner. */
  src_vertex: Int32Array;
}

export interface SkeletonResult extends KernelProvenance {
  /** Planar x,y pairs. */
  vertices: Float64Array;
  /** x0,y0,x1,y1 for each arc. */
  arcs: Float64Array;
  /** 0 = skeleton, 1 = input contour. */
  arc_kind: Uint8Array;
  face_start: Uint32Array;
  face_vertex_index: Uint32Array;
  /** Outgoing input edge, numbered outer first and then holes. */
  face_edge: Uint32Array;
  node_time: Float64Array;
}

export interface OffsetResult extends KernelProvenance {
  vertices: Float64Array;
  polygon_start: Uint32Array;
  polygon_vertex_index: Uint32Array;
  /** 0 = outer loop, 1 = hole. */
  polygon_hole: Uint8Array;
}

export interface RoofResult extends KernelProvenance {
  /** Kernel coordinates are x,y,height; the node maps these to Y-up. */
  vertices: Float64Array;
  face_start: Uint32Array;
  face_vertex_index: Uint32Array;
  face_edge: Uint32Array;
}

export interface Kernels {
  /** Weighted sample elimination; scale is a per-candidate radius multiplier, empty/absent means uniform. */
  scatter_eliminate(positions: Float32Array | Float64Array, target: number, rmax: number, scale?: Float32Array | Float64Array): Int32Array;
  /** Ordered greedy rejection; optional per-candidate group IDs enforce a uniform per-group cap. */
  scatter_min_distance(positions: Float32Array | Float64Array, order: Int32Array, radius: number, limit?: number, groups?: Int32Array, groupCap?: number): Int32Array;
  /** Repulsion and closest-surface projection, retaining the surface's triangle order and f64 precision. */
  scatter_relax(positions: Float64Array, spacing: Float64Array, triangles: Int32Array, barycentrics: Float64Array, surface: Required<TriBVHArrays> & { C: Float64Array }, iterations: number, options: ScatterRelaxOptions, cornerWeights?: Float64Array): ScatterRelaxResult;
  erode_droplet(height: Float32Array, hardness: Float32Array | null | undefined, w: number, h: number, cell: number, params?: DropletErosionOptions, seed?: number | bigint, freeze?: Float32Array | null): ErosionResult;
  erode_pipe(height: Float32Array, hardness: Float32Array | null | undefined, w: number, h: number, cell: number, params?: PipeErosionOptions, seed?: number | bigint, freeze?: Float32Array | null, rain?: Float32Array | null): ErosionResult;
  /** Talus angle is radians. Returned debris is signed thermal height change. */
  thermal_erode(height: Float32Array, hardness: Float32Array | null | undefined, w: number, h: number, cell: number, talusAngle: number, rate: number, iterations: number): ErosionResult;
  /** Priority flood; a 0..1 mask protects outlets with value 1, whose terrain is never raised. */
  fill_sinks(height: Float32Array, w: number, h: number, options?: FillSinksOptions, mask?: Float32Array | null): FillSinksResult;
  flow_accumulation(height: Float32Array, w: number, h: number, cell: number, method?: 'd8' | 'dinf', fillSinks?: boolean): FlowAccumulationResult;
  remesh_quad(positions: Float64Array, tris: Uint32Array, options?: QuadRemeshOptions): QuadRemeshResult;
  sdf_from_mesh(positions: Float64Array, tris: Uint32Array, voxel: number, band: number, padding: number, fill: boolean): KernelGrid;
  grid_csg(a: GridInput, b: GridInput, op: GridOperation, k?: number): KernelGrid;
  grid_offset(grid: GridInput, distance: number): KernelGrid;
  grid_blur(grid: GridInput, radius: number): KernelGrid;
  grid_dilate(grid: GridInput, distance: number): KernelGrid;
  grid_erode(grid: GridInput, distance: number): KernelGrid;
  grid_resample(grid: GridInput, voxel: number): KernelGrid;
  dual_contour(grid: GridInput, iso?: number, qefTolerance?: number, sharp?: boolean, clampToCell?: boolean, conservative?: boolean, adaptive?: number, sharpThreshold?: number): DualContourResult;
  straight_skeleton(outer: ArrayLike<number>, holes?: readonly ArrayLike<number>[], weights?: ArrayLike<number>): SkeletonResult;
  /** Positive distances move inward; negative distances move outward. */
  offset_polygon(outer: ArrayLike<number>, holes: readonly ArrayLike<number>[], distance: number): OffsetResult;
  /** Pitches are degrees: one value or one value for each outgoing contour edge. */
  roof(outer: ArrayLike<number>, holes: readonly ArrayLike<number>[], pitch: number | ArrayLike<number>, heightCap?: number): RoofResult;
}

export interface ScatterRelaxOptions { radius: number; weighted: boolean; dBar: number; wMean: number }
export interface ScatterRelaxResult {
  positions: Float64Array;
  spacing: Float64Array;
  triangles: Int32Array;
  barycentrics: Float64Array;
}

/** Parameters match core/erosion.ts, except talusAngle is radians at the kernel boundary. */
export interface DropletErosionOptions extends Partial<Omit<ErosionParams, 'talusAngle'>> {
  iterations?: number;
  /** Thermal angle of repose in radians. */
  talusAngle?: number;
}
export interface PipeErosionOptions {
  iterations?: number;
  /** Uniform rainfall depth per second; multiplied by the optional rain array. */
  rainAmount?: number;
  evaporation?: number;
  sedimentCapacity?: number;
  erosionRate?: number;
  depositionRate?: number;
  gravity?: number;
  /** Thermal angle of repose in radians. */
  talusAngle?: number;
  thermalRate?: number;
  /** Maximum timestep in seconds; 0 lets the kernel choose a stable CFL timestep. */
  timeStep?: number;
  boundary?: 'closed' | 'open';
  /** Stream-power incision K * drainage^m * slope^n; 0 disables incision. */
  streamPowerK?: number;
  streamPowerM?: number;
  streamPowerN?: number;
  /** Route stream-power incision across filled depressions without raising the ground. */
  fillSinks?: boolean;
  /** Initial standing-water depth in metres; empty/absent starts dry. */
  initialWater?: Float32Array;
}
export interface FillSinksOptions {
  /** Minimum rise per receiver step, in metres; 0 resolves flats through stable directions. */
  epsilon?: number;
  /** Retain entire connected depressions deeper than this many metres; 0 fills all. */
  maxDepth?: number;
  writeDirection?: boolean;
}
export interface FillSinksResult {
  height: Float32Array;
  /** Added terrain thickness in metres, nonnegative. */
  fill: Float32Array;
  /** Retained standing-water depth in metres above the unchanged lake bed. */
  lake: Float32Array;
  /** Flat-resolved receiver, or an empty array when writeDirection is false. */
  direction: Uint8Array;
}
export interface ErosionResult {
  height: Float32Array;
  /** Droplet: signed net hydraulic change. Pipe: cumulative deposited thickness. */
  sediment: Float32Array;
  /** Droplet/standalone thermal: signed net thermal change. Pipe: deposited thermal thickness. */
  debris: Float32Array;
  /** Droplet: raw water passage. Pipe: normalised integrated velocity, 0..1. */
  flow: Float32Array;
  /** Droplet: raw resting water. Pipe: remaining water depth. */
  water: Float32Array;
  /** Cumulative eroded depth, nonnegative. */
  wear: Float32Array;
}
export interface FlowAccumulationResult {
  /** Contributing area in square world units, including each sample's own cell area. */
  drainage: Float32Array;
  /** E, SE, S, SW, W, NW, N, NE = 0..7; 255 = sink. D-infinity records the dominant receiver. */
  direction: Uint8Array;
}

/** Lengths are world units; feature_angle is radians in the kernel API. */
export interface QuadRemeshOptions {
  target_length?: number;
  target_faces?: number;
  quad_only?: boolean;
  cleanup?: boolean;
  feature_angle?: number;
  align_boundaries?: boolean;
  smooth_iterations?: number;
  preserve_sharp?: boolean;
  /** Flat pairs of input point indices; hard field alignment constraints. */
  crease_edges?: Uint32Array;
  /** Orientation-only seam directions; do not pin the position field. */
  direction_edges?: Uint32Array;
  /** Flat pairs of input points whose edges and endpoints must remain exact. */
  locked_edges?: Uint32Array;
  max_faces?: number;
}
export interface QuadRemeshQuality {
  quad_fraction: number;
  singularities: number;
  /** Interior irregular vertices divided by all output vertices (boundaries excluded from numerator). */
  irregular_fraction: number;
  edge_length_min: number;
  edge_length_mean: number;
  edge_length_max: number;
  planarity_mean: number;
  planarity_max: number;
  target_edge_length: number;
}
/** Inherited src_prim identifies the supplied source triangle under each output face. */
export interface QuadRemeshResult extends KernelProvenance {
  positions: Float64Array;
  prim_start: Uint32Array;
  vertex_point: Uint32Array;
  /** Source triangle for each output point; indices address the supplied tris array. */
  source_triangle: Uint32Array;
  /** Three Float64 barycentric weights per output point, after final projection. */
  barycentric: Float64Array;
  quality: QuadRemeshQuality;
}

export type GridOperation = 'union' | 'intersect' | 'subtract' | 'smooth_union' | 'smooth_intersect' | 'smooth_subtract';
export interface GridInput {
  dims: ArrayLike<number>;
  origin: ArrayLike<number>;
  voxel: number;
  values: Float32Array;
}
export interface KernelGrid extends GridInput { dims: Uint32Array; origin: Float64Array }
export interface DualContourResult {
  positions: Float64Array;
  prim_start: Uint32Array;
  vertex_point: Uint32Array;
  /** Flattened grid sample index at the lower corner of each output vertex's cell. */
  cell_index: Uint32Array;
  /** Cells that required conservative extraction to avoid invalid dual faces. */
  fallback_cells: number;
  /** Accepted adaptive simplifications; zero when uniform extraction is retained. */
  adaptive_collapses: number;
}
function gridArg(g: GridInput): KernelGrid {
  if (!g || !g.dims || !g.origin || !(g.values instanceof Float32Array))
    throw new Error('grid: dims, origin and Float32Array values are required');
  if (g.dims.length !== 3 || Array.from(g.dims).some(v => !Number.isInteger(v) || v < 2 || v > 0xffffffff))
    throw new Error('grid: dims must contain three integers >= 2');
  if (g.origin.length !== 3 || Array.from(g.origin).some(v => !Number.isFinite(v)))
    throw new Error('grid: origin must contain three finite coordinates');
  if (!Number.isFinite(g.voxel) || g.voxel <= 0) throw new Error('grid: voxel must be finite and > 0');
  const count = g.dims[0] * g.dims[1] * g.dims[2];
  if (!Number.isSafeInteger(count) || count > 64 * 1024 * 1024 || g.values.length !== count)
    throw new Error('grid: values length must match dims and stay within the 67108864 sample limit');
  for (let a = 0; a < 3; a++) {
    const extent = (g.dims[a] - 1) * g.voxel;
    if (!Number.isFinite(g.origin[a] + extent) || extent > 3.4028234663852886e38 / 16)
      throw new Error('grid: origin or extent exceeds the supported finite distance range');
    if (g.origin[a] + g.voxel <= g.origin[a] || g.origin[a] + extent <= g.origin[a] + (g.dims[a] - 2) * g.voxel)
      throw new Error('grid: voxel spacing is not representable at this origin/extent; increase voxel size or move the grid closer to zero');
  }
  return { dims: Uint32Array.from(g.dims), origin: array(g.origin), voxel: g.voxel, values: g.values };
}

export type KernelsWasmVariant = 'scalar' | 'simd';

/** Probe an unexecuted function returning v128.const; no browser/version assumptions or relaxed SIMD. */
export function supportsWasmSimd(): boolean {
  const wasm = (globalThis as { WebAssembly?: { validate(bytes: Uint8Array): boolean } }).WebAssembly;
  return wasm !== undefined && wasm.validate(Uint8Array.of(
    0, 97, 115, 109, 1, 0, 0, 0, // magic/version
    1, 5, 1, 96, 0, 1, 123, // () -> v128
    3, 2, 1, 0, // one function
    10, 22, 1, 20, 0, 253, 12, // function body, v128.const
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 11,
  ));
}

function selectWasmVariant(): KernelsWasmVariant {
  // Reading an optional environment variable needs no Node import; browsers select by feature detection.
  const override = (globalThis as { process?: { env?: { TOPOTOPO_WASM?: string } } }).process?.env?.TOPOTOPO_WASM;
  if (override !== undefined && override !== '' && override !== 'scalar' && override !== 'simd')
    throw new Error('TOPOTOPO_WASM must be scalar or simd');
  if (override === 'scalar') return 'scalar';
  const simd = supportsWasmSimd();
  if (override === 'simd' && !simd) throw new Error('TOPOTOPO_WASM=simd requires WebAssembly simd128 support');
  return simd ? 'simd' : 'scalar';
}

/** Selection is fixed on first import. Set TOPOTOPO_WASM before importing this module or starting workers. */
export const kernelsWasmVariant = selectWasmVariant();
export const kernelsWasmURL = kernelsWasmVariant === 'simd'
  ? new URL('../../kernels/pkg-simd/topotopo_kernels_bg.wasm', import.meta.url)
  : new URL('../../kernels/pkg/topotopo_kernels_bg.wasm', import.meta.url);
let modulePromise: Promise<Kernels> | undefined;
let loadedKernels: Kernels | undefined;
const hosts = new WeakMap<Host, Promise<Kernels>>();
const array = (values: ArrayLike<number>): Float64Array => values instanceof Float64Array ? values : Float64Array.from(values);
const rings = (values: readonly ArrayLike<number>[]): Float64Array[] => values.map(array);

function call<T>(name: string, fn: () => T): T {
  try { return fn(); }
  catch (error) { throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
}

const emptyLayer = new Float32Array(0);
const emptyScatterScale = new Float64Array(0);
const emptyScatterGroups = new Int32Array(0);
export const SCATTER_KERNEL_MAX_POINTS = 5_000_000;
export const SCATTER_RELAX_MAX_POINTS = 4_000_000;
function scatterPositions(positions: Float32Array | Float64Array): void {
  if (!(positions instanceof Float32Array || positions instanceof Float64Array))
    throw new Error('positions must be Float32Array or Float64Array');
  if (positions.length % 3 || positions.length / 3 > SCATTER_KERNEL_MAX_POINTS)
    throw new Error('positions must contain xyz triples for at most 5000000 candidates');
}
function scatterCount(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff)
    throw new Error(`${name} must be a nonnegative 32-bit integer`);
}
function erosionGrid(height: Float32Array, w: number, h: number, cell: number): void {
  if (!(height instanceof Float32Array)) throw new Error('height must be a Float32Array');
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 2 || h < 2 || w > 0xffffffff || h > 0xffffffff)
    throw new Error('width and height must be integers >= 2');
  if (!Number.isSafeInteger(w * h) || w * h !== height.length) throw new Error('height length must equal width * height');
  if (!Number.isFinite(cell) || cell <= 0) throw new Error('cell size must be finite and > 0');
}
function erosionLayer(layer: Float32Array | null | undefined, count: number, name: string): Float32Array {
  if (layer == null) return emptyLayer;
  if (!(layer instanceof Float32Array) || (layer.length !== 0 && layer.length !== count))
    throw new Error(`${name} must be a Float32Array with width * height values (or empty)`);
  return layer;
}
function erosionSeed(seed: number | bigint): bigint {
  if (typeof seed === 'bigint') {
    if (seed < 0n || seed > 0xffffffffffffffffn) throw new Error('bigint seed must fit an unsigned 64-bit integer');
    return seed;
  }
  if (!Number.isFinite(seed)) throw new Error('seed must be finite');
  if (Number.isSafeInteger(seed) && seed >= 0) return BigInt(seed);
  // Node seeds may be fractional or negative; preserve all their bits rather than truncating them.
  const bytes = new DataView(new ArrayBuffer(8));
  bytes.setFloat64(0, seed, true);
  return bytes.getBigUint64(0, true);
}
/** Exact core/random.ts initial state for number seeds; explicit byte order also covers big-endian hosts. */
function erosionRngState(seed: number): number {
  let hashed: number;
  if (Number.isInteger(seed) && Math.abs(seed) < 2 ** 31) hashed = hash32(seed ^ 0x9e3779b9);
  else {
    const bytes = new DataView(new ArrayBuffer(8));
    bytes.setFloat64(0, seed, true);
    hashed = hash32(bytes.getUint32(0, true) ^ hash32(bytes.getUint32(4, true)));
  }
  return hash32(hashed + 0x6d2b79f5);
}
function erosionOptions(p: DropletErosionOptions | PipeErosionOptions | FillSinksOptions): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(p)) {
    if (value !== undefined) result[key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)] = value;
  }
  return result;
}

/** Inspect availability without performing I/O or starting a load (used by erosion backend=auto). */
export function getLoadedKernels(): Kernels | undefined { return loadedKernels; }

/** Initialise the shipped module once, sharing concurrent callers. Failed loads may be retried. */
export function loadKernels(bytes: Uint8Array): Promise<Kernels> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const wasm = kernelsWasmVariant === 'simd'
        ? await import('../../kernels/pkg-simd/topotopo_kernels.js')
        : await import('../../kernels/pkg/topotopo_kernels.js');
      await wasm.default({ module_or_path: bytes });
      const result: Kernels = Object.freeze({
        scatter_eliminate: (positions: Float32Array | Float64Array, target: number, rmax: number, scale?: Float32Array | Float64Array) =>
          call('scatter_eliminate', () => {
            scatterPositions(positions); scatterCount(target, 'target');
            target = Math.min(target, positions.length / 3);
            if (scale !== undefined && !(scale instanceof Float32Array || scale instanceof Float64Array))
              throw new Error('scale must be Float32Array or Float64Array');
            // Keep geometry's f64 coordinates exact; f32 callers get the same algorithm on their rounded input.
            // Widen a mixed-precision scale rather than silently rounding it to match the positions.
            if (positions instanceof Float32Array && (scale === undefined || scale instanceof Float32Array))
              return wasm.scatter_eliminate(positions, scale ?? emptyLayer, target, rmax);
            return wasm.scatter_eliminate_f64(array(positions), scale ? array(scale) : emptyScatterScale, target, rmax);
          }),
        scatter_min_distance: (positions: Float32Array | Float64Array, order: Int32Array, radius: number, limit = Infinity, groups?: Int32Array, groupCap = 0) =>
          call('scatter_min_distance', () => {
            scatterPositions(positions);
            if (!(order instanceof Int32Array)) throw new Error('order must be Int32Array');
            if (groups !== undefined && !(groups instanceof Int32Array)) throw new Error('groups must be Int32Array');
            if (limit !== Infinity) scatterCount(limit, 'limit');
            scatterCount(groupCap, 'groupCap');
            groupCap = Math.min(groupCap, order.length);
            const count = Math.min(limit, order.length);
            return positions instanceof Float32Array
              ? wasm.scatter_min_distance(positions, order, radius, count, groups ?? emptyScatterGroups, groupCap)
              : wasm.scatter_min_distance_f64(positions, order, radius, count, groups ?? emptyScatterGroups, groupCap);
          }),
        scatter_relax: (positions: Float64Array, spacing: Float64Array, triangles: Int32Array, barycentrics: Float64Array, surface: Required<TriBVHArrays> & { C: Float64Array }, iterations: number, options: ScatterRelaxOptions, cornerWeights?: Float64Array) =>
          call('scatter_relax', () => {
            for (const [name, value] of Object.entries({ positions, spacing, barycentrics, T: surface.T, nodes: surface.nodes, C: surface.C }))
              if (!(value instanceof Float64Array)) throw new Error(`${name} must be Float64Array`);
            if (!(triangles instanceof Int32Array) || !(surface.child instanceof Int32Array) || !(surface.order instanceof Int32Array) || !(surface.triPrim instanceof Uint32Array))
              throw new Error('triangles and surface child/order must be Int32Array; triPrim must be Uint32Array');
            if (cornerWeights !== undefined && !(cornerWeights instanceof Float64Array)) throw new Error('cornerWeights must be Float64Array');
            scatterCount(iterations, 'iterations');
            return wasm.scatter_relax(positions, spacing, triangles, barycentrics, surface.T, surface.nodes,
              surface.child, surface.order, surface.triPrim, surface.C, cornerWeights ?? emptyScatterScale,
              iterations, { radius: options.radius, weighted: options.weighted, d_bar: options.dBar, w_mean: options.wMean }) as ScatterRelaxResult;
          }),
        erode_droplet: (height: Float32Array, hardness: Float32Array | null | undefined, w: number, h: number, cell: number, params: DropletErosionOptions = {}, seed: number | bigint = 0, freeze?: Float32Array | null) =>
          call('erode_droplet', () => {
            erosionGrid(height, w, h, cell);
            const seedValue = erosionSeed(seed), options = erosionOptions(params);
            if (typeof seed === 'number') options.rng_state = erosionRngState(seed);
            return wasm.erode_droplet(height, erosionLayer(hardness, height.length, 'hardness'), erosionLayer(freeze, height.length, 'freeze'), w, h, cell, options, seedValue) as ErosionResult;
          }),
        erode_pipe: (height: Float32Array, hardness: Float32Array | null | undefined, w: number, h: number, cell: number, params: PipeErosionOptions = {}, seed: number | bigint = 0, freeze?: Float32Array | null, rain?: Float32Array | null) =>
          call('erode_pipe', () => {
            erosionGrid(height, w, h, cell);
            if (params.initialWater !== undefined) erosionLayer(params.initialWater, height.length, 'initialWater');
            return wasm.erode_pipe(height, erosionLayer(hardness, height.length, 'hardness'), erosionLayer(freeze, height.length, 'freeze'), erosionLayer(rain, height.length, 'rain'), w, h, cell, erosionOptions(params), erosionSeed(seed)) as ErosionResult;
          }),
        thermal_erode: (height: Float32Array, hardness: Float32Array | null | undefined, w: number, h: number, cell: number, talusAngle: number, rate: number, iterations: number) =>
          call('thermal_erode', () => {
            erosionGrid(height, w, h, cell);
            if (!Number.isInteger(iterations) || iterations < 0 || iterations > 0xffffffff) throw new Error('iterations must be a nonnegative integer');
            return wasm.thermal_erode(height, erosionLayer(hardness, height.length, 'hardness'), w, h, cell, talusAngle, rate, iterations) as ErosionResult;
          }),
        fill_sinks: (height: Float32Array, w: number, h: number, options: FillSinksOptions = {}, mask?: Float32Array | null) =>
          call('fill_sinks', () => {
            erosionGrid(height, w, h, 1);
            const result = wasm.fill_sinks(height, w, h, erosionOptions(options), erosionLayer(mask, height.length, 'mask')) as FillSinksResult;
            result.direction ??= new Uint8Array(0);
            return result;
          }),
        flow_accumulation: (height: Float32Array, w: number, h: number, cell: number, method: 'd8' | 'dinf' = 'dinf', fillSinks = false) =>
          call('flow_accumulation', () => {
            erosionGrid(height, w, h, cell);
            if (method !== 'd8' && method !== 'dinf') throw new Error('method must be d8 or dinf');
            return wasm.flow_accumulation(height, w, h, cell, method, fillSinks) as FlowAccumulationResult;
          }),
        remesh_quad: (positions: Float64Array, tris: Uint32Array, options: QuadRemeshOptions = {}) =>
          call('remesh_quad', () => {
            if (!(positions instanceof Float64Array) || !(tris instanceof Uint32Array))
              throw new Error('positions must be Float64Array and tris must be Uint32Array');
            return wasm.remesh_quad(positions, tris, options) as QuadRemeshResult;
          }),
        sdf_from_mesh: (positions: Float64Array, tris: Uint32Array, voxel: number, band: number, padding: number, fill: boolean) =>
          call('sdf_from_mesh', () => wasm.sdf_from_mesh(positions, tris, voxel, band, padding, fill) as KernelGrid),
        grid_csg: (a: GridInput, b: GridInput, op: GridOperation, k = 0) =>
          call('grid_csg', () => wasm.grid_csg(gridArg(a), gridArg(b), op, k) as KernelGrid),
        grid_offset: (grid: GridInput, d: number) => call('grid_offset', () => wasm.grid_offset(gridArg(grid), d) as KernelGrid),
        grid_blur: (grid: GridInput, radius: number) => call('grid_blur', () => {
          if (!Number.isInteger(radius) || radius < 0 || radius > 1024) throw new Error('radius must be an integer in 0..1024');
          return wasm.grid_blur(gridArg(grid), radius) as KernelGrid;
        }),
        grid_dilate: (grid: GridInput, d: number) => call('grid_dilate', () => wasm.grid_dilate(gridArg(grid), d) as KernelGrid),
        grid_erode: (grid: GridInput, d: number) => call('grid_erode', () => wasm.grid_erode(gridArg(grid), d) as KernelGrid),
        grid_resample: (grid: GridInput, voxel: number) => call('grid_resample', () => wasm.grid_resample(gridArg(grid), voxel) as KernelGrid),
        dual_contour: (grid: GridInput, iso = 0, qefTolerance = 1e-6, sharp = true, clampToCell = true, conservative = false, adaptive = 0, sharpThreshold = 0.5) =>
          call('dual_contour', () => wasm.dual_contour(gridArg(grid), iso, qefTolerance, sharp, clampToCell, conservative, adaptive, sharpThreshold) as DualContourResult),
        straight_skeleton: (outer: ArrayLike<number>, holes: readonly ArrayLike<number>[] = [], weights?: ArrayLike<number>) =>
          call('straight_skeleton', () => wasm.straight_skeleton(array(outer), rings(holes), weights ? array(weights) : undefined) as SkeletonResult),
        offset_polygon: (outer: ArrayLike<number>, holes: readonly ArrayLike<number>[], distance: number) =>
          call('offset_polygon', () => wasm.offset_polygon(array(outer), rings(holes), distance) as OffsetResult),
        roof: (outer: ArrayLike<number>, holes: readonly ArrayLike<number>[], pitch: number | ArrayLike<number>, heightCap?: number) =>
          call('roof', () => wasm.roof(array(outer), rings(holes), array(typeof pitch === 'number' ? [pitch] : pitch), heightCap) as RoofResult),
      });
      loadedKernels = result;
      return result;
    })();
    modulePromise.catch(() => { modulePromise = undefined; });
  }
  return modulePromise;
}

/** Lazy per-host I/O cache. Paths are module-relative, independent of the host's working directory. */
export function loadHostKernels(host: Host): Promise<Kernels> {
  let promise = hosts.get(host);
  if (!promise) {
    // Host accepts paths and HTTP URLs. Decode a file URL without importing Node's url/path modules.
    const url = kernelsWasmURL;
    const path = url.protocol === 'file:'
      ? (url.hostname ? `//${url.hostname}` : '') + decodeURIComponent(url.pathname).replace(/^\/(?=[A-Za-z]:\/)/, '')
      : url.href;
    promise = host.readFile(path).then(loadKernels);
    hosts.set(host, promise);
    promise.catch(() => { hosts.delete(host); });
  }
  return promise;
}
