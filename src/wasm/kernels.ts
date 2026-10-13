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
  straight_skeleton(outer: ArrayLike<number>, holes?: readonly ArrayLike<number>[], weights?: ArrayLike<number>): SkeletonResult;
  /** Positive distances move inward; negative distances move outward. */
  offset_polygon(outer: ArrayLike<number>, holes: readonly ArrayLike<number>[], distance: number): OffsetResult;
  /** Pitches are degrees: one value or one value for each outgoing contour edge. */
  roof(outer: ArrayLike<number>, holes: readonly ArrayLike<number>[], pitch: number | ArrayLike<number>, heightCap?: number): RoofResult;
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
