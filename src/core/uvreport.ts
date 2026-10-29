// Structured uv diagnostics (inspect detail "uv"): what a texture atlas needs to be bakeable, as numbers an agent can
// assert on instead of a picture.
//
// Triangles are the ones export, render and bakes use (topology.triangulate). Per triangle: uv missing or non-finite,
// collapsed (zero uv area: collinear or coincident corners within rounding), outside the 0..1 tile.
// Charts: triangles connected through uv-continuous edges (both corners share the point and the uv).
// Overlaps: candidate pairs from a uniform grid over the uv bounds (each pair is tested once, in the grid cell that
// holds the lower corner of the intersection of the two bounding boxes), then the exact intersection area by clipping
// one triangle against the other (convex polygon clipping). Triangles that only share an edge or a corner have no
// intersection area and are not overlaps; overlaps inside one chart (folds) count like any other.
// Tiling and LODs: a chart that runs across integer tile borders is a tiling chart (uv for a repeating texture, e.g.
// uv_project over many tiles); a chart inside one tile is an atlas chart (the unit tile, or a UDIM tile). Overlap pairs
// are classified: inTile (two atlas charts: the overlap a bake suffers), tiling (a tiling chart is involved: expected
// for a repeating texture) and acrossLods (prims whose names carry different LOD suffixes, "_lod0" / "_LOD1": LODs share
// the uv space on purpose). tiling says whether the uv set has tiling charts.
// Utilization: with no overlaps and every triangle inside the unit tile, the exact covered fraction of the tile (the
// sum of uv areas). Otherwise summed areas would double count, so the report gives a deterministic raster estimate
// (coverage of an N × N grid of sample points) and says so.
// Texel density per named piece (prim "name") when a texture resolution is given: texels per metre,
// sqrt(uv area · width · height / surface area).
// Work is bounded: exact pair tests stop at maxPairTests (candidate pairs, a cheap bounding-box test, are still all
// counted) and listed examples at maxExamples; an analysis that stops early reports complete: false with the reason,
// never a clean result.
import type { Geometry } from './geometry.ts';
import { triangulate } from './topology.ts';
import { primWhere } from './report.ts';
import type { Triangulation } from './topology.ts';

export interface UVReportOptions {
  /** uv attribute (vertex or point; default "uv") */
  attribute?: string;
  /** texture size in texels for texel density: n or [width, height] */
  resolution?: number | [number, number];
  /** prim string attribute naming pieces (default "name") */
  pieceAttrib?: string;
  /** most exact pair tests (default 4,000,000) */
  maxPairTests?: number;
  /** most overlap examples / collapsed triangle ids listed (default 16) */
  maxExamples?: number;
  /** raster estimate grid size (default 1024) */
  rasterSize?: number;
}

export interface UVOverlap {
  triangles: [number, number];
  prims: [number, number];
  area: number;
  sameChart: boolean;
  /** inTile (two atlas charts), tiling (a tiling chart) or acrossLods (different LODs) */
  kind: 'inTile' | 'tiling' | 'acrossLods';
  /** where the two prims are: "prim 12 of "barrel" (group …) at (x, y, z)" (core/report.ts) */
  where: [string, string];
}

export interface UVPiece { name: string; triangles: number; surfaceArea: number; uvArea: number; texelsPerMetre?: number }

export interface UVOverlapClass { pairs: number; area: number }

export interface UVReport {
  attribute: string;
  /** charts run across tile borders: uv for a repeating texture, not an atlas (their overlaps are overlap.tiling) */
  tiling: boolean;
  /** how many charts run across tile borders */
  tilingCharts: number;
  /** false when uv is missing or a bound stopped the analysis early; reasons lists why */
  complete: boolean;
  reasons: string[];
  missing: boolean;
  triangles: number;
  nonFinite: number;
  collapsed: number;
  collapsedTriangles: number[];
  /** where the first collapsed triangle is (its prim's part and the triangle's centre), or null */
  firstCollapsed: string | null;
  /** where the first triangle outside the unit tile is, or null */
  firstOutOfTile: string | null;
  /** triangles with uv winding opposite to the majority (mirrored islands are legal; listed for review) */
  mirrored: number;
  outOfTile: number;
  /** UDIM-style tiles touched: "u,v" integer pairs (0,0 is the unit tile) */
  tiles: string[];
  charts: number;
  uvArea: number;
  /**
   * pairs / area: every overlapping triangle pair; inTile: between atlas charts (what a bake suffers); tiling: a tiling
   * chart is involved (expected); acrossLods: prims of different LODs (expected); examples: inTile pairs first
   */
  overlap: { pairs: number; sameChartPairs: number; area: number; candidatePairs: number; testedPairs: number; inTile: UVOverlapClass; tiling: UVOverlapClass; acrossLods: UVOverlapClass; examples: UVOverlap[] };
  utilization: { method: 'exact' | 'raster-estimate' | 'none'; value: number; rasterSize?: number; note: string };
  pieces: UVPiece[];
  resolution?: [number, number];
}

/** Relative tolerances: a uv triangle is collapsed below this (doubled area / squared edges); an overlap counts above this fraction of the smaller triangle's area. */
const COLLAPSED_Q = 1e-9;
const OVERLAP_REL = 1e-7;

/** Area of the intersection of two counter-clockwise triangles (6 numbers each) by convex clipping. */
function triIntersectionArea(a: Float64Array | number[], b: Float64Array | number[]): number {
  let poly: number[] = [a[0], a[1], a[2], a[3], a[4], a[5]];
  for (let e = 0; e < 3 && poly.length >= 6; e++) {
    const ax = b[e * 2], ay = b[e * 2 + 1], bx = b[((e + 1) % 3) * 2], by = b[((e + 1) % 3) * 2 + 1];
    const out: number[] = [];
    const n = poly.length / 2;
    for (let i = 0; i < n; i++) {
      const cx = poly[i * 2], cy = poly[i * 2 + 1], dx = poly[((i + 1) % n) * 2], dy = poly[((i + 1) % n) * 2 + 1];
      const sc = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax), sd = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
      if (sc >= 0) out.push(cx, cy);
      if ((sc >= 0) !== (sd >= 0)) { const t = sc / (sc - sd); out.push(cx + (dx - cx) * t, cy + (dy - cy) * t); }
    }
    poly = out;
  }
  if (poly.length < 6) return 0;
  let s = 0;
  for (let i = 0, n = poly.length / 2; i < n; i++) { const j = (i + 1) % n; s += poly[i * 2] * poly[j * 2 + 1] - poly[j * 2] * poly[i * 2 + 1]; }
  return Math.abs(s) / 2;
}

/**
 * Per triangle: 0 = its chart lies in the unit tile, 1 = in one other integer tile (a UDIM tile), 2 = its chart runs
 * across tile borders (a tiling chart). U: 6 uv numbers per triangle; root: the chart of a triangle.
 */
export function chartKinds(U: Float64Array, nt: number, root: (t: number) => number): Uint8Array {
  const eps = 1e-9, tileOf = new Map<number, string>(), out = new Uint8Array(nt);
  const triTile = (t: number): string | null => {
    const o6 = t * 6;
    for (let k = 0; k < 6; k++) if (!Number.isFinite(U[o6 + k])) return null;
    const tu = Math.floor((U[o6] + U[o6 + 2] + U[o6 + 4]) / 3), tv = Math.floor((U[o6 + 1] + U[o6 + 3] + U[o6 + 5]) / 3);
    for (let k = 0; k < 3; k++) {
      const u = U[o6 + k * 2], v = U[o6 + k * 2 + 1];
      if (u < tu - eps || u > tu + 1 + eps || v < tv - eps || v > tv + 1 + eps) return 'x';
    }
    return `${tu},${tv}`;
  };
  const tt: (string | null)[] = new Array(nt);
  for (let t = 0; t < nt; t++) {
    const k = (tt[t] = triTile(t));
    if (k === null) continue;
    const r = root(t), have = tileOf.get(r);
    if (have === undefined) tileOf.set(r, k);
    else if (have !== k) tileOf.set(r, 'x');
  }
  for (let t = 0; t < nt; t++) {
    if (tt[t] === null) continue;
    const k = tileOf.get(root(t));
    out[t] = k === 'x' ? 2 : k === '0,0' ? 0 : 1;
  }
  return out;
}

/**
 * Charts: triangles joined across uv-continuous edges (both corners share the point and the uv). Returns the chart root
 * of a triangle. U: 6 uv numbers per triangle (corner order of tris).
 */
export function chartRoots(vertexPoint: ArrayLike<number>, tris: ArrayLike<number>, U: Float64Array, nt: number): (t: number) => number {
  const parent = Int32Array.from({ length: nt }, (_, i) => i);
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const cornerKey = (c: number) => `${vertexPoint[tris[c]]}:${U[c * 2]}:${U[c * 2 + 1]}`;
  const corner = new Map<string, number>(), cid = new Int32Array(nt * 3);
  for (let c = 0; c < nt * 3; c++) { const k = cornerKey(c); let id = corner.get(k); if (id === undefined) { id = corner.size; corner.set(k, id); } cid[c] = id; }
  const edgeOwner = new Map<number, number>(), nc = corner.size;
  for (let t = 0; t < nt; t++) {
    if (!Number.isFinite(U[t * 6]) || !Number.isFinite(U[t * 6 + 2]) || !Number.isFinite(U[t * 6 + 4])) continue;
    for (let k = 0; k < 3; k++) {
      const x = cid[t * 3 + k], y = cid[t * 3 + ((k + 1) % 3)];
      const key = Math.min(x, y) * nc + Math.max(x, y);
      const other = edgeOwner.get(key);
      if (other === undefined) edgeOwner.set(key, t); else { const ra = find(t), rb = find(other); if (ra !== rb) parent[rb] = ra; }
    }
  }
  return find;
}

/** The LOD of a name: "barrel_lod1" → 1, "crate_LOD0" → 0, "rock.lod2" → 2; -1 without such a suffix. */
export function lodOf(name: string): number {
  const m = /[_.-]lod(\d+)$/i.exec(name);
  return m ? Number(m[1]) : -1;
}

/** Per prim its LOD from the prim "name" (lodOf), or null when no name carries a LOD suffix. */
export function primLods(g: Geometry): Int32Array | null {
  const na = g.prims.get('name');
  if (!na || na.type !== 'string') return null;
  const out = new Int32Array(g.numPrims);
  let any = false;
  for (let p = 0; p < g.numPrims; p++) { out[p] = lodOf(String(na.get(p) ?? '')); if (out[p] >= 0) any = true; }
  return any ? out : null;
}

export function uvReport(g: Geometry, o: UVReportOptions = {}, tri: Triangulation = triangulate(g)): UVReport {
  const name = o.attribute || 'uv';
  const maxEx = Math.max(0, Math.floor(o.maxExamples ?? 16)), maxTests = Math.max(0, Math.floor(o.maxPairTests ?? 4_000_000));
  const res: [number, number] | undefined = o.resolution === undefined ? undefined : Array.isArray(o.resolution) ? [o.resolution[0], o.resolution[1]] : [o.resolution, o.resolution];
  const { tris, triPrim } = tri, nt = tris.length / 3;
  const rep: UVReport = {
    attribute: name, tiling: false, tilingCharts: 0, complete: true, reasons: [], missing: false, triangles: nt, nonFinite: 0, collapsed: 0, collapsedTriangles: [], firstCollapsed: null, firstOutOfTile: null, mirrored: 0,
    outOfTile: 0, tiles: [], charts: 0, uvArea: 0,
    overlap: { pairs: 0, sameChartPairs: 0, area: 0, candidatePairs: 0, testedPairs: 0, inTile: { pairs: 0, area: 0 }, tiling: { pairs: 0, area: 0 }, acrossLods: { pairs: 0, area: 0 }, examples: [] },
    utilization: { method: 'none', value: 0, note: '' }, pieces: [], ...(res ? { resolution: res } : {}),
  };
  const f = g.findAttrib(name, ['vertex', 'point']);
  if (!f || f.attr.type !== 'float' || f.attr.isArray) {
    rep.missing = true; rep.complete = false; rep.reasons.push(`no float vertex or point attribute "${name}"`);
    rep.utilization.note = 'no uv';
    return rep;
  }
  const a = f.attr, d = a.data as Float64Array, sz = a.size;
  /** a triangle in words: its prim's part, at the triangle's centre in world space */
  const triWhere = (t: number) => {
    const P = g.P, i0 = g.vertexPoint[tris[t * 3]] * 3, i1 = g.vertexPoint[tris[t * 3 + 1]] * 3, i2 = g.vertexPoint[tris[t * 3 + 2]] * 3;
    const c = [0, 1, 2].map((k) => (P[i0 + k] + P[i1 + k] + P[i2 + k]) / 3);
    return primWhere(g, triPrim[t], c);
  };
  const U = new Float64Array(nt * 6);
  for (let c = 0; c < nt * 3; c++) {
    const v = tris[c], i = (f.cls === 'vertex' ? v : g.vertexPoint[v]) * sz;
    U[c * 2] = d[i]; U[c * 2 + 1] = sz > 1 ? d[i + 1] : 0;
  }
  // per triangle: validity, signed area, tiles
  const ok = new Uint8Array(nt), signed = new Float64Array(nt), tiles = new Set<string>();
  let pos = 0, neg = 0;
  for (let t = 0; t < nt; t++) {
    const o6 = t * 6;
    let finite = true;
    for (let k = 0; k < 6; k++) if (!Number.isFinite(U[o6 + k])) finite = false;
    if (!finite) { rep.nonFinite++; continue; }
    const du1 = U[o6 + 2] - U[o6], dv1 = U[o6 + 3] - U[o6 + 1], du2 = U[o6 + 4] - U[o6], dv2 = U[o6 + 5] - U[o6 + 1];
    const cr = du1 * dv2 - du2 * dv1, e2 = du1 * du1 + dv1 * dv1 + du2 * du2 + dv2 * dv2 + (du2 - du1) ** 2 + (dv2 - dv1) ** 2;
    let inside = true;
    for (let k = 0; k < 3; k++) {
      const u = U[o6 + k * 2], v = U[o6 + k * 2 + 1];
      if (u < 0 || u > 1 || v < 0 || v > 1) inside = false;
    }
    const cu = (U[o6] + U[o6 + 2] + U[o6 + 4]) / 3, cv = (U[o6 + 1] + U[o6 + 3] + U[o6 + 5]) / 3;
    tiles.add(`${Math.floor(cu)},${Math.floor(cv)}`);
    if (!inside) { rep.outOfTile++; if (rep.firstOutOfTile === null) rep.firstOutOfTile = triWhere(t); }
    if (!(Math.abs(cr) > COLLAPSED_Q * e2)) {
      rep.collapsed++;
      if (rep.collapsedTriangles.length < maxEx) rep.collapsedTriangles.push(t);
      if (rep.firstCollapsed === null) rep.firstCollapsed = triWhere(t);
      continue;
    }
    ok[t] = 1; signed[t] = cr / 2; rep.uvArea += Math.abs(cr) / 2;
    if (cr > 0) pos++; else neg++;
  }
  rep.mirrored = Math.min(pos, neg);
  rep.tiles = [...tiles].sort((x, y) => { const [a0, a1] = x.split(',').map(Number), [b0, b1] = y.split(',').map(Number); return a1 - b1 || a0 - b0; });

  // charts: union triangles across uv-continuous edges (same two points, same uv at both)
  const find = chartRoots(g.vertexPoint, tris, U, nt);
  const roots = new Set<number>();
  for (let t = 0; t < nt; t++) if (Number.isFinite(U[t * 6]) && Number.isFinite(U[t * 6 + 2]) && Number.isFinite(U[t * 6 + 4])) roots.add(find(t));
  rep.charts = roots.size;
  // tiling charts (across tile borders) and the LOD of each prim, to classify the overlaps below
  const kind = chartKinds(U, nt, find);
  const tilingRoots = new Set<number>();
  for (let t = 0; t < nt; t++) if (kind[t] === 2) tilingRoots.add(find(t));
  rep.tilingCharts = tilingRoots.size; rep.tiling = tilingRoots.size > 0;
  const lod = primLods(g);
  const classOf = (ta: number, tb: number): UVOverlap['kind'] =>
    kind[ta] === 2 || kind[tb] === 2 ? 'tiling' : lod && lod[triPrim[ta]] >= 0 && lod[triPrim[tb]] >= 0 && lod[triPrim[ta]] !== lod[triPrim[tb]] ? 'acrossLods' : 'inTile';

  // overlaps: grid candidates, exact clipping
  const valid: number[] = [];
  let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
  for (let t = 0; t < nt; t++) if (ok[t]) {
    valid.push(t);
    for (let k = 0; k < 3; k++) { const u = U[t * 6 + k * 2], v = U[t * 6 + k * 2 + 1]; if (u < minU) minU = u; if (u > maxU) maxU = u; if (v < minV) minV = v; if (v > maxV) maxV = v; }
  }
  const ccw = new Float64Array(nt * 6);
  for (const t of valid) {
    const o6 = t * 6;
    if (signed[t] > 0) for (let k = 0; k < 6; k++) ccw[o6 + k] = U[o6 + k];
    else { ccw[o6] = U[o6]; ccw[o6 + 1] = U[o6 + 1]; ccw[o6 + 2] = U[o6 + 4]; ccw[o6 + 3] = U[o6 + 5]; ccw[o6 + 4] = U[o6 + 2]; ccw[o6 + 5] = U[o6 + 3]; }
  }
  if (valid.length > 1) {
    const span = Math.max(maxU - minU, maxV - minV, 1e-12);
    const cells = Math.max(1, Math.min(1024, Math.ceil(Math.sqrt(valid.length / 2))));
    const cs = span / cells;
    const nx = Math.max(1, Math.min(1024, Math.ceil((maxU - minU) / cs) || 1)), ny = Math.max(1, Math.min(1024, Math.ceil((maxV - minV) / cs) || 1));
    const cellOf = (u: number, n: number, lo: number) => Math.max(0, Math.min(n - 1, Math.floor((u - lo) / cs)));
    const bb = new Float64Array(nt * 4);
    const counts = new Int32Array(nx * ny + 1);
    for (const t of valid) {
      const o6 = t * 6;
      const u0 = Math.min(U[o6], U[o6 + 2], U[o6 + 4]), u1 = Math.max(U[o6], U[o6 + 2], U[o6 + 4]), v0 = Math.min(U[o6 + 1], U[o6 + 3], U[o6 + 5]), v1 = Math.max(U[o6 + 1], U[o6 + 3], U[o6 + 5]);
      bb[t * 4] = u0; bb[t * 4 + 1] = v0; bb[t * 4 + 2] = u1; bb[t * 4 + 3] = v1;
      for (let y = cellOf(v0, ny, minV); y <= cellOf(v1, ny, minV); y++) for (let x = cellOf(u0, nx, minU); x <= cellOf(u1, nx, minU); x++) counts[y * nx + x + 1]++;
    }
    for (let i = 0; i < nx * ny; i++) counts[i + 1] += counts[i];
    const items = new Int32Array(counts[nx * ny]), fill = counts.slice(0, nx * ny);
    for (const t of valid) {
      const u0 = bb[t * 4], v0 = bb[t * 4 + 1], u1 = bb[t * 4 + 2], v1 = bb[t * 4 + 3];
      for (let y = cellOf(v0, ny, minV); y <= cellOf(v1, ny, minV); y++) for (let x = cellOf(u0, nx, minU); x <= cellOf(u1, nx, minU); x++) items[fill[y * nx + x]++] = t;
    }
    let tests = 0, stopped = false;
    for (let c = 0; c < nx * ny; c++) {
      const s = counts[c], e = counts[c + 1], cx = c % nx, cy = Math.floor(c / nx);
      for (let i = s; i < e; i++) for (let j = i + 1; j < e; j++) {
        const ta = items[i], tb = items[j];
        // bounding boxes overlap with positive extent, and this cell owns the pair
        const lu = Math.max(bb[ta * 4], bb[tb * 4]), lv = Math.max(bb[ta * 4 + 1], bb[tb * 4 + 1]);
        if (lu >= Math.min(bb[ta * 4 + 2], bb[tb * 4 + 2]) || lv >= Math.min(bb[ta * 4 + 3], bb[tb * 4 + 3])) continue;
        if (cellOf(lu, nx, minU) !== cx || cellOf(lv, ny, minV) !== cy) continue;
        rep.overlap.candidatePairs++;
        if (tests >= maxTests) { stopped = true; continue; }
        tests++;
        const A = triIntersectionArea(ccw.subarray(ta * 6, ta * 6 + 6), ccw.subarray(tb * 6, tb * 6 + 6));
        if (A > OVERLAP_REL * Math.min(Math.abs(signed[ta]), Math.abs(signed[tb]))) {
          const t0 = Math.min(ta, tb), t1 = Math.max(ta, tb), same = find(t0) === find(t1), k = classOf(t0, t1);
          rep.overlap.pairs++; rep.overlap.area += A;
          rep.overlap[k].pairs++; rep.overlap[k].area += A;
          if (same) rep.overlap.sameChartPairs++;
          // examples: the bake-relevant (inTile) pairs before the expected ones
          const ex = { triangles: [t0, t1] as [number, number], prims: [triPrim[t0], triPrim[t1]] as [number, number], area: A, sameChart: same, kind: k, where: ['', ''] as [string, string] };
          if (rep.overlap.examples.length < maxEx) rep.overlap.examples.push(ex);
          else if (k === 'inTile') {
            const j = rep.overlap.examples.findIndex((e) => e.kind !== 'inTile');
            if (j >= 0) rep.overlap.examples[j] = ex;
          }
        }
      }
    }
    rep.overlap.testedPairs = tests;
    if (stopped) { rep.complete = false; rep.reasons.push(`overlap test stopped after ${tests.toLocaleString('en-US')} exact pair tests (maxPairTests) of ${rep.overlap.candidatePairs.toLocaleString('en-US')} candidate pairs`); }
    const rank = (e: UVOverlap) => (e.kind === 'inTile' ? 0 : 1);
    rep.overlap.examples.sort((x, y) => rank(x) - rank(y) || y.area - x.area || x.triangles[0] - y.triangles[0] || x.triangles[1] - y.triangles[1]);
    for (const e of rep.overlap.examples) e.where = [triWhere(e.triangles[0]), triWhere(e.triangles[1])];
  }

  // utilization
  if (rep.overlap.pairs === 0 && rep.outOfTile === 0 && rep.complete) {
    rep.utilization = { method: 'exact', value: rep.uvArea, note: 'sum of uv triangle areas in the unit tile (no overlaps, nothing outside)' };
  } else if (valid.length) {
    const N = Math.max(16, Math.min(4096, Math.floor(o.rasterSize ?? 1024)));
    const cov = new Uint8Array(N * N);
    for (const t of valid) {
      const o6 = t * 6, ax = ccw[o6] * N, ay = ccw[o6 + 1] * N, bx = ccw[o6 + 2] * N, by = ccw[o6 + 3] * N, cx = ccw[o6 + 4] * N, cy = ccw[o6 + 5] * N;
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(N - 1, Math.ceil(Math.max(ax, bx, cx))), y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(N - 1, Math.ceil(Math.max(ay, by, cy)));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const px = x + 0.5, py = y + 0.5;
        if ((bx - ax) * (py - ay) - (by - ay) * (px - ax) >= 0 && (cx - bx) * (py - by) - (cy - by) * (px - bx) >= 0 && (ax - cx) * (py - cy) - (ay - cy) * (px - cx) >= 0) cov[y * N + x] = 1;
      }
    }
    let k = 0;
    for (let i = 0; i < cov.length; i++) k += cov[i];
    const why = [rep.overlap.pairs ? 'overlapping triangles' : '', rep.outOfTile ? 'triangles outside the unit tile (excluded from the estimate)' : '', rep.complete ? '' : 'an incomplete overlap test'].filter(Boolean).join(', ');
    rep.utilization = { method: 'raster-estimate', value: k / (N * N), rasterSize: N, note: `ESTIMATE: fraction of ${N} × ${N} sample points of the unit tile covered (summed areas would count overlaps twice; because of ${why})` };
  } else rep.utilization = { method: 'none', value: 0, note: 'no valid uv triangles' };

  // per-piece surface and uv area, texel density
  const pa = g.prims.get(o.pieceAttrib || 'name');
  if (pa && pa.type === 'string') {
    const by = new Map<string, UVPiece>(), P = g.P, vp = g.vertexPoint;
    for (let t = 0; t < nt; t++) {
      const key = String(pa.get(triPrim[t]) ?? '');
      let pc = by.get(key);
      if (!pc) { pc = { name: key, triangles: 0, surfaceArea: 0, uvArea: 0 }; by.set(key, pc); }
      const i0 = vp[tris[t * 3]] * 3, i1 = vp[tris[t * 3 + 1]] * 3, i2 = vp[tris[t * 3 + 2]] * 3;
      const ux = P[i1] - P[i0], uy = P[i1 + 1] - P[i0 + 1], uz = P[i1 + 2] - P[i0 + 2], wx = P[i2] - P[i0], wy = P[i2 + 1] - P[i0 + 1], wz = P[i2 + 2] - P[i0 + 2];
      pc.triangles++;
      pc.surfaceArea += 0.5 * Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx);
      if (ok[t]) pc.uvArea += Math.abs(signed[t]);
    }
    rep.pieces = [...by.values()].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
    if (res) for (const pc of rep.pieces) pc.texelsPerMetre = pc.surfaceArea > 0 ? Math.sqrt((pc.uvArea * res[0] * res[1]) / pc.surfaceArea) : 0;
  }
  return rep;
}

/** Short text form of a report for inspect. */
export function uvReportText(r: UVReport): string[] {
  const f = (x: number) => (Math.abs(x) >= 1e-3 || x === 0 ? +x.toPrecision(4) : x.toExponential(2));
  const out = [`uv "${r.attribute}": ${r.complete ? 'COMPLETE' : 'INCOMPLETE'} analysis of ${r.triangles} triangles${r.reasons.length ? ` (${r.reasons.join('; ')})` : ''}`];
  if (r.missing) return out;
  out.push(`  ${r.charts} charts; tiles ${r.tiles.join(' ') || 'none'}; ${r.outOfTile} triangles outside 0..1; ${r.nonFinite} non-finite; ${r.collapsed} collapsed; ${r.mirrored} mirrored`);
  if (r.collapsed && r.firstCollapsed) out.push(`    collapsed (no uv area: bakes and normal maps have no direction there), first ${r.firstCollapsed}`);
  const ov = r.overlap;
  if (r.tiling) out.push(`  TILING: ${r.tilingCharts} chart${r.tilingCharts === 1 ? ' runs' : 's run'} across tile borders: uv for a repeating texture, not an atlas; overlap there is expected`);
  out.push(`  overlaps in tiles (atlas, what a bake suffers): ${ov.inTile.pairs} triangle pairs, area ${f(ov.inTile.area)}; ${ov.testedPairs} of ${ov.candidatePairs} candidate pairs tested exactly`);
  if (ov.tiling.pairs) out.push(`  overlaps of tiling charts (expected): ${ov.tiling.pairs} pairs, area ${f(ov.tiling.area)}`);
  if (ov.acrossLods.pairs) out.push(`  overlaps across LODs (expected: names with different _lodN suffixes share the uv space): ${ov.acrossLods.pairs} pairs, area ${f(ov.acrossLods.area)}`);
  if (ov.sameChartPairs) out.push(`  ${ov.sameChartPairs} of the ${ov.pairs} overlapping pairs lie within one chart (folds)`);
  for (const e of ov.examples.slice(0, 8)) out.push(`    ${e.kind === 'inTile' ? '' : `[${e.kind === 'tiling' ? 'tiling' : 'across LODs'}] `}${e.where[0]} × ${e.where[1]}${e.sameChart ? ' (same chart: a fold)' : ''}: uv area ${f(e.area)}`);
  out.push(`  utilization ${(r.utilization.value * 100).toFixed(2)}% (${r.utilization.method}${r.utilization.rasterSize ? ` ${r.utilization.rasterSize}²` : ''}): ${r.utilization.note}; uv area ${f(r.uvArea)}${r.tiling ? ' (says little for tiling uv)' : ''}`);
  if (r.outOfTile && r.firstOutOfTile && !r.tiling) out.push(`    outside 0..1, first ${r.firstOutOfTile}`);
  if (r.pieces.length) {
    const shown = r.pieces.slice(0, 24);
    out.push(`  pieces (${r.pieces.length})${r.resolution ? `, texel density at ${r.resolution[0]}×${r.resolution[1]}` : ''}:`);
    for (const p of shown) out.push(`    ${p.name || '""'}: ${p.triangles} tris, surface ${f(p.surfaceArea)} m², uv ${f(p.uvArea)}${p.texelsPerMetre !== undefined ? `, ${f(p.texelsPerMetre)} texels/m` : ''}`);
    if (r.pieces.length > shown.length) out.push(`    … ${r.pieces.length - shown.length} more`);
  }
  return out;
}
