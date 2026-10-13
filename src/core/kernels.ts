// Kernel registry: pure per-element functions over typed arrays, run in chunks on worker threads
// (CookContext.parallelMap, src/graph/parallel.ts) or in one piece on the cooking thread.
//
// Rules for a kernel, so that chunked and serial runs give bit-identical results:
//  - it reads and writes plain typed arrays (no Geometry objects, no scripting realm, no I/O);
//  - indices are global: a chunk processes elements [start, end) and writes only their slots of the outputs;
//  - per-element randomness is seeded by the element index (never by the chunk or the thread);
//  - it does the same floating-point operations in the same order as the serial code it replaces.
// Large read-only data (a BVH) comes in as `shared` arrays, cached per worker under a content hash; objects built
// from it are memoised with ctx.memo(key, make). Host kernels that need more than this (the wrangle kernel compiles
// user code in the worker's own realm) live in src/host/worker.ts.
import { fractal, makeCurl, makeNoise } from './noise.ts';
import type { FractalOpts } from './noise.ts';
import { RayScene, rayMeasure } from './analysis.ts';
import { cellsRange, noiseRange } from './texture.ts';
import type { CellsJob, NoiseJob } from './texture.ts';
import { curvatureRange, projectRange } from './bake.ts';
import type { CurvatureArgs, ProjectArgs } from './bake.ts';
import { candidatesRange, conflictsRange, elimNeighboursRange, elimPairsRange, kdBuildRange, relaxRange } from './scatter.ts';
import type { CandidateArgs, ConflictArgs, RelaxArgs } from './scatter.ts';
import { TriSurface } from './pcg.ts';
import { colliderFromArrays, collideRange } from './xpbd.ts';

export type TypedArray =
  | Float64Array | Float32Array | Int32Array | Uint32Array | Int16Array | Uint16Array | Int8Array | Uint8Array | Uint8ClampedArray;

export interface KernelContext {
  /** content key of the task's shared data ('' when it has none) */
  sharedKey: string;
  /** an object built from shared data, kept per thread under `key` (e.g. a RayScene over shared BVH arrays) */
  memo<T>(key: string, make: () => T): T;
}

export interface Kernel {
  /** elements below which the pool is not worth it (copies and messages would cost more than the work) */
  minElements: number;
  /** chunks per worker: more than 1 balances kernels whose per-element cost varies (ray casting) */
  chunksPerWorker?: number;
  /** process elements [start, end) of the named arrays (inputs, outputs and shared arrays in one record) */
  run(args: any, a: Record<string, any>, start: number, end: number, ctx: KernelContext): any;
}

/** Noise values for noise_displace: one per point (normal/direction), or three (3d: three noises; curl: the curl vector). */
const noiseDisplace: Kernel = {
  minElements: 32768,
  run(a: { noise: string; seed: number; fopts: FractalOpts; mode: string; centered: boolean; freq: number[]; offset: number[] }, A, start, end) {
    const n = fractal(makeNoise(a.noise, a.seed), a.fopts);
    const curl = a.mode === 'curl' ? makeCurl(n) : null;
    const n2 = a.mode === '3d' ? fractal(makeNoise(a.noise, a.seed + 1), a.fopts) : null;
    const n3 = a.mode === '3d' ? fractal(makeNoise(a.noise, a.seed + 2), a.fopts) : null;
    const worley = a.noise === 'worley', centered = a.centered;
    const Q: Float64Array = A.Q, V: Float64Array = A.V, sel: Uint8Array | undefined = A.sel;
    const f = a.freq, o = a.offset;
    for (let i = start; i < end; i++) {
      if (sel && !sel[i]) continue;
      const x = Q[i * 3] * f[0] + o[0], y = Q[i * 3 + 1] * f[1] + o[1], z = Q[i * 3 + 2] * f[2] + o[2];
      if (curl) {
        const c = curl(x, y, z);
        V[i * 3] = c[0]; V[i * 3 + 1] = c[1]; V[i * 3 + 2] = c[2];
        continue;
      }
      let v = n(x, y, z);
      if (worley) v = v * 2 - 1;
      if (!centered) v = v * 0.5 + 0.5;
      if (n2 && n3) {
        let v2 = n2(x, y, z), v3 = n3(x, y, z);
        if (worley) { v2 = v2 * 2 - 1; v3 = v3 * 2 - 1; }
        if (!centered) { v2 = v2 * 0.5 + 0.5; v3 = v3 * 0.5 + 0.5; }
        V[i * 3] = v; V[i * 3 + 1] = v2; V[i * 3 + 2] = v3;
      } else V[i] = v;
    }
  },
};

/** attrib_noise: the attribute values themselves (size components per point). */
const attribNoise: Kernel = {
  minElements: 32768,
  run(a: { noise: string; seed: number; size: number; fopts: FractalOpts; contrast: number; range: number[]; freq: number[]; offset: number[] }, A, start, end) {
    const size = a.size;
    const fns = Array.from({ length: size }, (_, c) => fractal(makeNoise(a.noise, a.seed + c * 101), a.fopts));
    const worley = a.noise === 'worley', k = a.contrast, r0 = a.range[0], r1 = a.range[1];
    const Q: Float64Array = A.Q, D: Float64Array = A.D, f = a.freq, o = a.offset;
    for (let i = start; i < end; i++) {
      const x = Q[i * 3] * f[0] + o[0], y = Q[i * 3 + 1] * f[1] + o[1], z = Q[i * 3 + 2] * f[2] + o[2];
      for (let c = 0; c < size; c++) {
        let v = fns[c](x, y, z);
        if (worley) v = v * 2 - 1;
        v = Math.max(-1, Math.min(1, v * k));
        D[i * size + c] = r0 + (v * 0.5 + 0.5) * (r1 - r0);
      }
    }
  },
};

/** occlusion / cavity / thickness rays per point against a BVH shared as arrays (RayScene.toArrays). */
const occlusion: Kernel = {
  // the node scales this by its ray count (it passes minElements = rays threshold / samples)
  minElements: 4096,
  chunksPerWorker: 4,
  run(a: { mode: any; samples: number; maxDistance: number; bias: number; coneAngle: number; seed: number }, A, start, end, ctx) {
    const scene = ctx.memo('rayscene:' + ctx.sharedKey, () => RayScene.fromArrays(A as any));
    rayMeasure(A.P, A.N, scene, a, A.sel ?? null, A.out, start, end);
  },
};

// ---------------------------------------------------------------- textures (src/nodes/texture.ts, src/nodes/bake.ts)
// Bakes also use "occlusion" above (ao, thickness): one sample per covered texel instead of one per point.

/** tex_noise: fractal noise per pixel (C). */
const texNoiseK: Kernel = {
  minElements: 65536,
  run(a: NoiseJob, A, start, end) { noiseRange(a, A.C, start, end); },
};

/** tex_cells: Voronoi cells per pixel (C and id). */
const texCellsK: Kernel = {
  minElements: 65536,
  run(a: CellsJob, A, start, end) { cellsRange(a, A.C, A.id, start, end); },
};

/** bake_height / bake_normal: one ray per texel from the low mesh into a high-res mesh shared as BVH arrays (+ its point normals HN). */
const bakeProject: Kernel = {
  minElements: 16384,
  chunksPerWorker: 4,
  run(a: ProjectArgs, A, start, end, ctx) {
    const scene = ctx.memo('rayscene:' + ctx.sharedKey, () => RayScene.fromArrays(A as any));
    projectRange(a, A, scene, start, end);
  },
};

/** bake_curvature: dihedral angles of the edges near each texel sample (edges and their grid shared). */
const bakeCurvature: Kernel = {
  minElements: 16384,
  chunksPerWorker: 2,
  run(a: CurvatureArgs, A, start, end) { curvatureRange(a, A, start, end); },
};

// ---------------------------------------------------------------- scatter (src/core/scatter.ts)

/** KD tree: the ranges the top levels deferred, one subtree per element (buildKDTree). */
const kdBuild: Kernel = {
  minElements: 2,
  chunksPerWorker: 2,
  run(a, A, start, end) { kdBuildRange(a, A, start, end); },
};

/** scatter: area-weighted surface candidates (draws by index, rngAt). */
const scatterCandidates: Kernel = {
  minElements: 65536,
  run(a: CandidateArgs, A, start, end) { candidatesRange(a, A, start, end); },
};

/** sample elimination with one radius: neighbour lists and weight contributions per KD slot (returned per chunk). */
const scatterElimNeighbours: Kernel = {
  minElements: 32768,
  chunksPerWorker: 2,
  run(a: { r2: number }, A, start, end) { return elimNeighboursRange(a, A, start, end); },
};

/** sample elimination with radii by density: the pairs found from each candidate (returned per chunk). */
const scatterElimPairs: Kernel = {
  minElements: 32768,
  chunksPerWorker: 2,
  run(a: { rmax: number }, A, start, end) { return elimPairsRange(a, A, start, end); },
};

/** exact minimum distance: each candidate's earlier candidates closer than r (returned per chunk). */
const scatterConflicts: Kernel = {
  minElements: 16384,
  chunksPerWorker: 2,
  run(a: ConflictArgs, A, start, end) { return conflictsRange(a, A, start, end); },
};

/** one relaxation pass on a surface shared as arrays (TriSurface.arrays), rebuilt once per thread. */
const scatterRelax: Kernel = {
  minElements: 2048,
  chunksPerWorker: 4,
  run(a: RelaxArgs, A, start, end, ctx) {
    const surf = ctx.memo('trisurface:' + ctx.sharedKey, () => TriSurface.fromArrays(A as any));
    relaxRange(a, A, start, end, surf);
  },
};

// ---------------------------------------------------------------- cloth (src/core/xpbd.ts)

/** drape / inflate: each point's contact plane against a collider shared as arrays (colliderArrays), once per step. */
const clothCollide: Kernel = {
  minElements: 4096,
  run(_a, A, start, end, ctx) {
    const c = ctx.memo('collider:' + ctx.sharedKey, () => colliderFromArrays(A));
    collideRange(c, A.X, A.R, A.CP, A.CN, A.CF, A.CT, A.QD, start, end);
  },
};

// ---------------------------------------------------------------- self tests (test/pool.ts)

/** x[i] *= factor over the range; returns the sum of the scaled values (round trips, transfer, parallelMap). */
const selftestScale: Kernel = {
  minElements: 1 << 30,
  run(a: { factor: number }, A, start, end) {
    const x: Float64Array = A.x;
    let s = 0;
    for (let i = start; i < Math.min(end, x.length); i++) { x[i] *= a.factor; s += x[i]; }
    return s;
  },
};

/** out[i] = in[i]² + i (per element; the threshold is huge so only a forced pool or minElements uses workers). */
const selftestSquare: Kernel = {
  minElements: 1 << 30,
  run(_a, A, start, end) {
    const src: Float64Array = A.in, out: Float64Array = A.out;
    for (let i = start; i < end; i++) out[i] = src[i] * src[i] + i;
  },
};

/** throws when element `at` is in the chunk */
const selftestThrow: Kernel = {
  minElements: 1 << 30,
  run(a: { at: number }, _A, start, end) {
    if (a.at >= start && a.at < end) throw new Error(`selftest failure at element ${a.at}`);
  },
};

/** busy-waits `ms` milliseconds (timeouts) */
const selftestSpin: Kernel = {
  minElements: 1 << 30,
  run(a: { ms: number }) {
    const t = Date.now();
    while (Date.now() - t < a.ms) { /* spin */ }
    return a.ms;
  },
};

/** a worker handles this one itself by exiting (crash recovery); on the cooking thread it only throws */
const selftestCrash: Kernel = {
  minElements: 1 << 30,
  run() { throw new Error('selftest.crash ends a worker thread; it does nothing on the cooking thread'); },
};

export const KERNELS: Record<string, Kernel> = {
  noise_displace: noiseDisplace,
  attrib_noise: attribNoise,
  occlusion,
  tex_noise: texNoiseK,
  tex_cells: texCellsK,
  bake_project: bakeProject,
  bake_curvature: bakeCurvature,
  kd_build: kdBuild,
  scatter_candidates: scatterCandidates,
  scatter_elim_neighbours: scatterElimNeighbours,
  scatter_elim_pairs: scatterElimPairs,
  scatter_conflicts: scatterConflicts,
  scatter_relax: scatterRelax,
  cloth_collide: clothCollide,
  'selftest.scale': selftestScale,
  'selftest.square': selftestSquare,
  'selftest.throw': selftestThrow,
  'selftest.spin': selftestSpin,
  'selftest.crash': selftestCrash,
};

/**
 * Content hash of typed arrays (two 32-bit FNV-style lanes over their bytes, plus types and lengths), as a key for
 * data cached in the workers. Not cryptographic; collisions would need equal lengths and both lanes to collide.
 */
export function hashArrays(arrays: Record<string, ArrayBufferView>): string {
  let a = 0x811c9dc5, b = 0x050c5d1f;
  const mix = (w: number) => {
    a = Math.imul(a ^ w, 0x01000193);
    b = Math.imul(b ^ (w >>> 16) ^ (w << 16), 0x01000193) ^ (a >>> 7);
  };
  for (const name of Object.keys(arrays).sort()) {
    const v = arrays[name];
    for (let i = 0; i < name.length; i++) mix(name.charCodeAt(i));
    mix(v.byteLength);
    mix((v.constructor?.name ?? '').length);
    const words = (v.byteOffset & 3) === 0 ? Math.floor(v.byteLength / 4) : 0;
    const w32 = new Int32Array(v.buffer, v.byteOffset, words);
    for (let i = 0; i < words; i++) mix(w32[i]);
    const bytes = new Uint8Array(v.buffer, v.byteOffset + words * 4, v.byteLength - words * 4);
    for (let i = 0; i < bytes.length; i++) mix(bytes[i]);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}
