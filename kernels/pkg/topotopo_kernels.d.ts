/* tslint:disable */
/* eslint-disable */

export function dual_contour(g: any, iso: number, qef_tolerance: number, sharp: boolean, clamp_to_cell: boolean): object;

export function erode_droplet(height: Float32Array, hardness: Float32Array, freeze: Float32Array, w: number, h: number, cell: number, params: any, seed: bigint): object;

export function erode_pipe(height: Float32Array, hardness: Float32Array, freeze: Float32Array, rain: Float32Array, w: number, h: number, cell: number, params: any, seed: bigint): object;

export function flow_accumulation(height: Float32Array, w: number, h: number, cell: number, method: string): object;

export function grid_blur(g: any, radius: number): object;

export function grid_csg(a: any, b: any, op: string, k: number): object;

export function grid_dilate(g: any, d: number): object;

export function grid_erode(g: any, d: number): object;

export function grid_offset(g: any, d: number): object;

export function grid_resample(g: any, voxel: number): object;

export function offset_polygon(outer: Float64Array, hole_arrays: Array<any>, distance: number): object;

export function remesh_quad(positions: Float64Array, tris: Uint32Array, options: any): object;

export function roof(outer: Float64Array, hole_arrays: Array<any>, pitch: Float64Array, height_cap?: number | null): object;

export function sdf_from_mesh(positions: Float64Array, tris: Uint32Array, voxel: number, band: number, padding: number, fill: boolean): object;

export function straight_skeleton(outer: Float64Array, hole_arrays: Array<any>, weights?: Float64Array | null): object;

export function thermal_erode(height: Float32Array, hardness: Float32Array, w: number, h: number, cell: number, talus_angle: number, rate: number, iterations: number): object;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly dual_contour: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly erode_droplet: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: bigint) => void;
    readonly erode_pipe: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: bigint) => void;
    readonly flow_accumulation: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly grid_blur: (a: number, b: number, c: number) => void;
    readonly grid_csg: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly grid_dilate: (a: number, b: number, c: number) => void;
    readonly grid_erode: (a: number, b: number, c: number) => void;
    readonly grid_offset: (a: number, b: number, c: number) => void;
    readonly grid_resample: (a: number, b: number, c: number) => void;
    readonly offset_polygon: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly remesh_quad: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly roof: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly sdf_from_mesh: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
    readonly straight_skeleton: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly thermal_erode: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => void;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
