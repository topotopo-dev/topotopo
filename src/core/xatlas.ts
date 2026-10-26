// Bridge to xatlas (chart segmentation, parameterisation and atlas packing), through the xatlas-wasm
// package: a single-file ES module with the WASM embedded, so it loads the same way in Node and in a
// browser bundle (no Worker, fetch or file path needed). Loaded lazily on first use.
//
// xatlas works on triangles. Polygons are triangulated here; the caller maps the output back to the
// polygon corners (output index i corresponds to input triangle corner i).
import type { Geometry } from './geometry.ts';
import { triangulate } from './topology.ts';

let modPromise: Promise<any> | null = null;

export async function loadXatlas(): Promise<any> {
  if (!modPromise) {
    modPromise = (async () => {
      const m: any = await import('xatlas-wasm');
      const create = m.default ?? m.createXAtlas ?? m;
      return await create();
    })();
    modPromise.catch(() => { modPromise = null; });
  }
  return modPromise;
}

export interface XatlasChartOptions {
  maxChartArea?: number;
  maxBoundaryLength?: number;
  normalDeviationWeight?: number;
  roundnessWeight?: number;
  straightnessWeight?: number;
  normalSeamWeight?: number;
  textureSeamWeight?: number;
  maxCost?: number;
  maxIterations?: number;
  /** enforce consistent (non-mirrored) uv winding */
  fixWinding?: boolean;
}

export interface XatlasPackOptions {
  padding?: number;
  resolution?: number;
  texelsPerUnit?: number;
  bruteForce?: boolean;
  rotateCharts?: boolean;
  rotateChartsToAxis?: boolean;
  blockAlign?: boolean;
  bilinear?: boolean;
}

export interface XatlasResult {
  /** triangle corners (geometry vertex indices), 3 per triangle */
  tris: Uint32Array;
  /** source prim per triangle */
  triPrim: Uint32Array;
  /** per triangle corner: atlas uv in texels (x, y) */
  cornerUV: Float64Array;
  /** chart per triangle (-1 when xatlas ignored it: zero area) */
  triChart: Int32Array;
  /** atlas (sub-image) per triangle */
  triAtlas: Int32Array;
  width: number;
  height: number;
  atlasCount: number;
  chartCount: number;
  utilization: number[];
}

/** Bounding-box diagonal small inputs are scaled up to before xatlas sees them (world units). */
const XATLAS_SIZE = 100;

/** The factor that brings a position list's bounding-box diagonal up to XATLAS_SIZE (1 when it is already larger). */
function xatlasScale(pos: number[]): number {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i++) {
    const a = i % 3;
    if (pos[i] < lo[a]) lo[a] = pos[i];
    if (pos[i] > hi[a]) hi[a] = pos[i];
  }
  const d = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  return d > 0 && d < XATLAS_SIZE ? XATLAS_SIZE / d : 1;
}

/**
 * Run xatlas on the closed polygons of g (prims outside primMask are skipped). Input vertices are the
 * geometry points, or per-vertex keys (`vertexKey[v]`, e.g. split along seams); `faceGroup[prim]`
 * keeps prims with different values in different charts.
 */
export function runXatlas(
  X: any, g: Geometry, chart: XatlasChartOptions, pack: XatlasPackOptions | null,
  opts: { vertexKey?: Int32Array | null; faceGroup?: Int32Array | null; primMask?: ArrayLike<number> | null; unmirror?: boolean } = {},
): XatlasResult {
  const { tris, triPrim } = triangulate(g, opts.primMask ?? null);
  const nt = tris.length / 3;
  const P = g.P;
  // input vertex per triangle corner
  const keyOf = (v: number) => (opts.vertexKey ? opts.vertexKey[v] : g.vertexPoint[v]);
  const remap = new Map<number, number>();
  const pos: number[] = [];
  const idx = new Uint32Array(tris.length);
  for (let i = 0; i < tris.length; i++) {
    const v = tris[i], k = keyOf(v);
    let x = remap.get(k);
    if (x === undefined) {
      x = pos.length / 3;
      remap.set(k, x);
      const pt = g.vertexPoint[v];
      pos.push(P[pt * 3], P[pt * 3 + 1], P[pt * 3 + 2]);
    }
    idx[i] = x;
  }
  const result: XatlasResult = {
    tris, triPrim, cornerUV: new Float64Array(tris.length * 2), triChart: new Int32Array(nt).fill(-1), triAtlas: new Int32Array(nt).fill(-1),
    width: 0, height: 0, atlasCount: 0, chartCount: 0, utilization: [],
  };
  if (!nt) return result;
  // xatlas compares positions and areas against absolute epsilons (about 1e-4 and 1.2e-7), so on a model a few
  // centimetres across it welds bevel corners and drops small faces as degenerate. Scale small inputs up to a
  // bounding-box diagonal of XATLAS_SIZE; the world-unit options scale with them, so the result is unchanged.
  const k = xatlasScale(pos), repack = pack;
  if (k !== 1) {
    for (let i = 0; i < pos.length; i++) pos[i] *= k;
    chart = { ...chart };
    if (chart.maxChartArea) chart.maxChartArea *= k * k;
    if (chart.maxBoundaryLength) chart.maxBoundaryLength *= k;
    if (pack?.texelsPerUnit) pack = { ...pack, texelsPerUnit: pack.texelsPerUnit / k };
  }
  const atlas = X.createAtlas();
  try {
    const decl: any = { positions: Float32Array.from(pos), indices: idx };
    if (opts.faceGroup) decl.faceMaterialData = Uint32Array.from(triPrim, (p) => Math.max(0, opts.faceGroup![p]));
    const err = atlas.addMesh(decl);
    if (err !== 0) throw new Error(`xatlas addMesh failed: ${X.addMeshErrorString ? X.addMeshErrorString(err) : err}`);
    atlas.computeCharts(chart);
    atlas.packCharts(pack ?? { resolution: 256, padding: 0, rotateCharts: false, blockAlign: true });
    const m = atlas.getMesh(0);
    result.width = atlas.width; result.height = atlas.height;
    result.atlasCount = atlas.atlasCount; result.chartCount = m.chartCount;
    for (let a = 0; a < atlas.atlasCount; a++) result.utilization.push(atlas.getUtilization(a));
    const out = m.indices as Uint32Array;
    const verts = m.vertices as { atlasIndex: number; chartIndex: number; uv: [number, number] }[];
    for (let i = 0; i < out.length && i < tris.length; i++) {
      const ov = verts[out[i]];
      result.cornerUV[i * 2] = ov.uv[0];
      result.cornerUV[i * 2 + 1] = ov.uv[1];
      const t = (i / 3) | 0;
      if (ov.chartIndex >= 0 && result.triChart[t] < 0) { result.triChart[t] = ov.chartIndex; result.triAtlas[t] = ov.atlasIndex; }
    }
    if (opts.unmirror && repack) unmirrorAndRepack(X, result, out, verts.length, repack);
  } finally {
    atlas.destroy();
  }
  return result;
}

/**
 * xatlas charts come out in either orientation (its texel space is y-down and LSCM/planar charts are not
 * winding-aware). Mirror the charts whose uv winding disagrees with the polygon winding, then repack all
 * charts with xatlas's UV-mesh packer so the packing stays tight and overlap-free.
 */
function unmirrorAndRepack(X: any, r: XatlasResult, out: Uint32Array, nOut: number, pack: XatlasPackOptions): void {
  const nt = r.triChart.length;
  const signed = new Map<number, number>();
  for (let t = 0; t < nt; t++) {
    const c = r.triChart[t];
    if (c < 0) continue;
    const u = r.cornerUV, i = t * 6;
    const a = (u[i + 2] - u[i]) * (u[i + 5] - u[i + 1]) - (u[i + 3] - u[i + 1]) * (u[i + 4] - u[i]);
    signed.set(c, (signed.get(c) ?? 0) + a);
  }
  let mirrored = 0;
  for (const [, a] of signed) if (a < 0) mirrored++;
  if (!mirrored) return;
  const uvs = new Float32Array(nOut * 2);
  for (let i = 0; i < out.length; i++) {
    const c = r.triChart[(i / 3) | 0];
    const flip = c >= 0 && signed.get(c)! < 0;
    uvs[out[i] * 2] = flip ? -r.cornerUV[i * 2] : r.cornerUV[i * 2];
    uvs[out[i] * 2 + 1] = r.cornerUV[i * 2 + 1];
  }
  const b = X.createAtlas();
  try {
    const err = b.addUvMesh({ uvs, indices: out, faceMaterialData: Uint32Array.from(r.triChart, (c) => c + 1) });
    if (err !== 0) return;
    b.computeCharts();
    b.packCharts(pack);
    const m = b.getMesh(0);
    const o2 = m.indices as Uint32Array;
    const v2 = m.vertices as { atlasIndex: number; uv: [number, number] }[];
    if (o2.length !== out.length) return;
    for (let i = 0; i < o2.length; i++) {
      const ov = v2[o2[i]];
      r.cornerUV[i * 2] = ov.uv[0];
      r.cornerUV[i * 2 + 1] = ov.uv[1];
      if (i % 3 === 0) r.triAtlas[i / 3] = ov.atlasIndex;
    }
    r.width = b.width; r.height = b.height; r.atlasCount = b.atlasCount;
    r.utilization = [];
    for (let a = 0; a < b.atlasCount; a++) r.utilization.push(b.getUtilization(a));
  } finally {
    b.destroy();
  }
}
