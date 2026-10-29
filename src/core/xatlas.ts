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
 * xatlas charts of a set of triangles (vertex triples into g). A corner's input vertex is keyOf(v) (its point, or a
 * seam-split key); triangles of different group(t) never share a chart. The triangles are scaled on their own to a
 * bounding-box diagonal of XATLAS_SIZE, so a small part of a large model is charted as finely as it would be alone.
 * Returns the chart per triangle (-1: xatlas dropped it, e.g. no area) and the uv per triangle corner in xatlas texel
 * space: each chart's shape (where xatlas placed it is not used).
 */
export function xatlasCharts(
  X: any, g: Geometry, tris: ArrayLike<number>,
  o: { keyOf: (v: number) => number; group?: ((t: number) => number) | null; chart: XatlasChartOptions },
): { triChart: Int32Array; cornerUV: Float64Array; chartCount: number } {
  const nt = Math.floor(tris.length / 3), P = g.P;
  const remap = new Map<number, number>(), pos: number[] = [], idx = new Uint32Array(nt * 3);
  for (let i = 0; i < nt * 3; i++) {
    const v = tris[i], key = o.keyOf(v);
    let x = remap.get(key);
    if (x === undefined) {
      x = pos.length / 3;
      remap.set(key, x);
      const pt = g.vertexPoint[v];
      pos.push(P[pt * 3], P[pt * 3 + 1], P[pt * 3 + 2]);
    }
    idx[i] = x;
  }
  const res = { triChart: new Int32Array(nt).fill(-1), cornerUV: new Float64Array(nt * 6), chartCount: 0 };
  if (!nt) return res;
  let chart = o.chart;
  const k = xatlasScale(pos);
  if (k !== 1) {
    for (let i = 0; i < pos.length; i++) pos[i] *= k;
    chart = { ...chart };
    if (chart.maxChartArea) chart.maxChartArea *= k * k;
    if (chart.maxBoundaryLength) chart.maxBoundaryLength *= k;
  }
  const atlas = X.createAtlas();
  try {
    const decl: any = { positions: Float32Array.from(pos), indices: idx };
    if (o.group) decl.faceMaterialData = Uint32Array.from({ length: nt }, (_, t) => Math.max(0, o.group!(t)));
    const err = atlas.addMesh(decl);
    if (err !== 0) throw new Error(`xatlas addMesh failed: ${X.addMeshErrorString ? X.addMeshErrorString(err) : err}`);
    atlas.computeCharts(chart);
    // xatlas writes uv only when it packs; the placement is thrown away, so the atlas is as small as keeps the shapes
    // precise (its cost grows with its area)
    atlas.packCharts({ resolution: Math.max(64, Math.min(1024, Math.round(Math.sqrt(nt) * 8))), padding: 0, rotateCharts: false, rotateChartsToAxis: false, blockAlign: true });
    const m = atlas.getMesh(0);
    res.chartCount = m.chartCount;
    const out = m.indices as Uint32Array;
    const verts = m.vertices as { chartIndex: number; uv: [number, number] }[];
    for (let i = 0; i < out.length && i < nt * 3; i++) {
      const ov = verts[out[i]];
      res.cornerUV[i * 2] = ov.uv[0];
      res.cornerUV[i * 2 + 1] = ov.uv[1];
      const t = (i / 3) | 0;
      if (ov.chartIndex >= 0 && res.triChart[t] < 0) res.triChart[t] = ov.chartIndex;
    }
  } finally {
    atlas.destroy();
  }
  return res;
}

/**
 * Run xatlas on the closed polygons of g (prims outside primMask are skipped). Input vertices are the
 * geometry points, or per-vertex keys (`vertexKey[v]`, e.g. split along seams); `faceGroup[prim]`
 * keeps prims with different values in different charts.
 */
export function runXatlas(
  X: any, g: Geometry, chart: XatlasChartOptions, pack: XatlasPackOptions | null,
  opts: { vertexKey?: Int32Array | null; faceGroup?: Int32Array | null; primMask?: ArrayLike<number> | null } = {},
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
  const k = xatlasScale(pos);
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
  } finally {
    atlas.destroy();
  }
  return result;
}
