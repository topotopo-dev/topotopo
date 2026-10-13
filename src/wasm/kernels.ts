// The caller owns I/O; importing this module does not read or instantiate WASM.
import type { Host } from '../host/types.ts';

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
  sdf_from_mesh(positions: Float64Array, tris: Uint32Array, voxel: number, band: number, padding: number, fill: boolean): KernelGrid;
  grid_csg(a: GridInput, b: GridInput, op: GridOperation, k?: number): KernelGrid;
  grid_offset(grid: GridInput, distance: number): KernelGrid;
  grid_blur(grid: GridInput, radius: number): KernelGrid;
  grid_dilate(grid: GridInput, distance: number): KernelGrid;
  grid_erode(grid: GridInput, distance: number): KernelGrid;
  grid_resample(grid: GridInput, voxel: number): KernelGrid;
  dual_contour(grid: GridInput, iso?: number, qefTolerance?: number, sharp?: boolean, clampToCell?: boolean): DualContourResult;
  straight_skeleton(outer: ArrayLike<number>, holes?: readonly ArrayLike<number>[], weights?: ArrayLike<number>): SkeletonResult;
  /** Positive distances move inward; negative distances move outward. */
  offset_polygon(outer: ArrayLike<number>, holes: readonly ArrayLike<number>[], distance: number): OffsetResult;
  /** Pitches are degrees: one value or one value for each outgoing contour edge. */
  roof(outer: ArrayLike<number>, holes: readonly ArrayLike<number>[], pitch: number | ArrayLike<number>, heightCap?: number): RoofResult;
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

export const kernelsWasmURL = new URL('../../kernels/pkg/polyforge_kernels_bg.wasm', import.meta.url);
let modulePromise: Promise<Kernels> | undefined;
const hosts = new WeakMap<Host, Promise<Kernels>>();
const array = (values: ArrayLike<number>): Float64Array => values instanceof Float64Array ? values : Float64Array.from(values);
const rings = (values: readonly ArrayLike<number>[]): Float64Array[] => values.map(array);

function call<T>(name: string, fn: () => T): T {
  try { return fn(); }
  catch (error) { throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
}

/** Initialise the shipped module once, sharing concurrent callers. Failed loads may be retried. */
export function loadKernels(bytes: Uint8Array): Promise<Kernels> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const wasm = await import('../../kernels/pkg/polyforge_kernels.js');
      await wasm.default({ module_or_path: bytes });
      return Object.freeze({
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
        dual_contour: (grid: GridInput, iso = 0, qefTolerance = 1e-6, sharp = true, clampToCell = true) =>
          call('dual_contour', () => wasm.dual_contour(gridArg(grid), iso, qefTolerance, sharp, clampToCell) as DualContourResult),
        straight_skeleton: (outer: ArrayLike<number>, holes: readonly ArrayLike<number>[] = [], weights?: ArrayLike<number>) =>
          call('straight_skeleton', () => wasm.straight_skeleton(array(outer), rings(holes), weights ? array(weights) : undefined) as SkeletonResult),
        offset_polygon: (outer: ArrayLike<number>, holes: readonly ArrayLike<number>[], distance: number) =>
          call('offset_polygon', () => wasm.offset_polygon(array(outer), rings(holes), distance) as OffsetResult),
        roof: (outer: ArrayLike<number>, holes: readonly ArrayLike<number>[], pitch: number | ArrayLike<number>, heightCap?: number) =>
          call('roof', () => wasm.roof(array(outer), rings(holes), array(typeof pitch === 'number' ? [pitch] : pitch), heightCap) as RoofResult),
      });
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
