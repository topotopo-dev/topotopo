// Exact uv overlap test between triangles, shared by inspect uv (uvreport.ts) and the uv nodes that check their own
// output (uv_layout, uv_flatten, uv_unwrap, decimate with uv).
//
// Candidate pairs come from a uniform grid over the uv bounds of the triangles; each pair is tested once, in the grid
// cell that holds the lower corner of the intersection of the two bounding boxes. The exact intersection area comes
// from clipping one triangle against the other (convex polygon clipping). Triangles that only share an edge or a
// corner have no intersection area and are not overlaps.
import type { Geometry } from './geometry.ts';
import { primWhere } from './report.ts';

/** A triangle is collapsed (no uv area) when |cross| <= COLLAPSED_Q · (sum of squared edge lengths). */
export const COLLAPSED_Q = 1e-9;
/** A pair overlaps when the intersection area exceeds OVERLAP_REL of the smaller triangle. */
export const OVERLAP_REL = 1e-7;

/** Area of the intersection of two counter-clockwise triangles (6 numbers each) by convex clipping. */
export function triIntersectionArea(a: Float64Array | number[], b: Float64Array | number[]): number {
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

/** Per triangle of U (6 uv numbers each): ok = finite and not collapsed; signed = signed uv area (0 when not ok). */
export function uvTriangleAreas(U: Float64Array, nt: number): { ok: Uint8Array; signed: Float64Array } {
  const ok = new Uint8Array(nt), signed = new Float64Array(nt);
  for (let t = 0; t < nt; t++) {
    const o6 = t * 6;
    let finite = true;
    for (let k = 0; k < 6; k++) if (!Number.isFinite(U[o6 + k])) finite = false;
    if (!finite) continue;
    const du1 = U[o6 + 2] - U[o6], dv1 = U[o6 + 3] - U[o6 + 1], du2 = U[o6 + 4] - U[o6], dv2 = U[o6 + 5] - U[o6 + 1];
    const cr = du1 * dv2 - du2 * dv1, e2 = du1 * du1 + dv1 * dv1 + du2 * du2 + dv2 * dv2 + (du2 - du1) ** 2 + (dv2 - dv1) ** 2;
    if (!(Math.abs(cr) > COLLAPSED_Q * e2)) continue;
    ok[t] = 1; signed[t] = cr / 2;
  }
  return { ok, signed };
}

/** U for a triangle list over per-vertex uv (2 numbers per vertex): 6 numbers per triangle. */
export function trianglesUV(uv: ArrayLike<number>, tris: ArrayLike<number>): Float64Array {
  const nt = Math.floor(tris.length / 3), U = new Float64Array(nt * 6);
  for (let c = 0; c < nt * 3; c++) { const v = tris[c]; U[c * 2] = uv[v * 2]; U[c * 2 + 1] = uv[v * 2 + 1]; }
  return U;
}

export interface OverlapScan {
  /** pairs whose bounding boxes overlap with positive extent */
  candidatePairs: number;
  /** pairs tested exactly (all candidates unless maxTests stopped the scan, or skip excluded them) */
  testedPairs: number;
  /** maxTests was reached: later candidates were counted but not tested */
  stopped: boolean;
}

export interface OverlapScanOptions {
  /** most exact pair tests (default unlimited) */
  maxTests?: number;
  /** pairs not to test (still counted as candidates): e.g. two triangles of the same island */
  skip?: (ta: number, tb: number) => boolean;
}

/**
 * Every overlapping pair among the triangles `valid` (ids into U, which holds 6 uv numbers per triangle; signed: signed
 * uv area per triangle, from uvTriangleAreas). onPair(ta, tb, area) runs with ta < tb for each pair whose intersection
 * area exceeds OVERLAP_REL of the smaller triangle; the order of calls is deterministic.
 */
export function uvOverlapPairs(U: Float64Array, valid: ArrayLike<number>, signed: Float64Array, onPair: (ta: number, tb: number, area: number) => void, o: OverlapScanOptions = {}): OverlapScan {
  const scan: OverlapScan = { candidatePairs: 0, testedPairs: 0, stopped: false };
  const nv = valid.length;
  if (nv < 2) return scan;
  const maxTests = o.maxTests ?? Infinity, skip = o.skip;
  let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
  for (let i = 0; i < nv; i++) {
    const t = valid[i];
    for (let k = 0; k < 3; k++) { const u = U[t * 6 + k * 2], v = U[t * 6 + k * 2 + 1]; if (u < minU) minU = u; if (u > maxU) maxU = u; if (v < minV) minV = v; if (v > maxV) maxV = v; }
  }
  // counter-clockwise copies for clipping
  const nt = U.length / 6, ccw = new Float64Array(nt * 6), bb = new Float64Array(nt * 4);
  for (let i = 0; i < nv; i++) {
    const t = valid[i], o6 = t * 6;
    if (signed[t] > 0) for (let k = 0; k < 6; k++) ccw[o6 + k] = U[o6 + k];
    else { ccw[o6] = U[o6]; ccw[o6 + 1] = U[o6 + 1]; ccw[o6 + 2] = U[o6 + 4]; ccw[o6 + 3] = U[o6 + 5]; ccw[o6 + 4] = U[o6 + 2]; ccw[o6 + 5] = U[o6 + 3]; }
    bb[t * 4] = Math.min(U[o6], U[o6 + 2], U[o6 + 4]); bb[t * 4 + 1] = Math.min(U[o6 + 1], U[o6 + 3], U[o6 + 5]);
    bb[t * 4 + 2] = Math.max(U[o6], U[o6 + 2], U[o6 + 4]); bb[t * 4 + 3] = Math.max(U[o6 + 1], U[o6 + 3], U[o6 + 5]);
  }
  const span = Math.max(maxU - minU, maxV - minV, 1e-12);
  const cells = Math.max(1, Math.min(1024, Math.ceil(Math.sqrt(nv / 2))));
  const cs = span / cells;
  const nx = Math.max(1, Math.min(1024, Math.ceil((maxU - minU) / cs) || 1)), ny = Math.max(1, Math.min(1024, Math.ceil((maxV - minV) / cs) || 1));
  const cellOf = (u: number, n: number, lo: number) => Math.max(0, Math.min(n - 1, Math.floor((u - lo) / cs)));
  const counts = new Int32Array(nx * ny + 1);
  for (let i = 0; i < nv; i++) {
    const t = valid[i];
    for (let y = cellOf(bb[t * 4 + 1], ny, minV); y <= cellOf(bb[t * 4 + 3], ny, minV); y++) for (let x = cellOf(bb[t * 4], nx, minU); x <= cellOf(bb[t * 4 + 2], nx, minU); x++) counts[y * nx + x + 1]++;
  }
  for (let i = 0; i < nx * ny; i++) counts[i + 1] += counts[i];
  const items = new Int32Array(counts[nx * ny]), fill = counts.slice(0, nx * ny);
  for (let i = 0; i < nv; i++) {
    const t = valid[i];
    for (let y = cellOf(bb[t * 4 + 1], ny, minV); y <= cellOf(bb[t * 4 + 3], ny, minV); y++) for (let x = cellOf(bb[t * 4], nx, minU); x <= cellOf(bb[t * 4 + 2], nx, minU); x++) items[fill[y * nx + x]++] = t;
  }
  for (let c = 0; c < nx * ny; c++) {
    const s = counts[c], e = counts[c + 1], cx = c % nx, cy = Math.floor(c / nx);
    for (let i = s; i < e; i++) for (let j = i + 1; j < e; j++) {
      const ta = items[i], tb = items[j];
      // bounding boxes overlap with positive extent, and this cell owns the pair
      const lu = Math.max(bb[ta * 4], bb[tb * 4]), lv = Math.max(bb[ta * 4 + 1], bb[tb * 4 + 1]);
      if (lu >= Math.min(bb[ta * 4 + 2], bb[tb * 4 + 2]) || lv >= Math.min(bb[ta * 4 + 3], bb[tb * 4 + 3])) continue;
      if (cellOf(lu, nx, minU) !== cx || cellOf(lv, ny, minV) !== cy) continue;
      scan.candidatePairs++;
      const t0 = Math.min(ta, tb), t1 = Math.max(ta, tb);
      if (skip && skip(t0, t1)) continue;
      if (scan.testedPairs >= maxTests) { scan.stopped = true; continue; }
      scan.testedPairs++;
      const A = triIntersectionArea(ccw.subarray(t0 * 6, t0 * 6 + 6), ccw.subarray(t1 * 6, t1 * 6 + 6));
      if (A > OVERLAP_REL * Math.min(Math.abs(signed[t0]), Math.abs(signed[t1]))) onPair(t0, t1, A);
    }
  }
  return scan;
}

export interface UVOverlapCheck {
  /** overlapping triangle pairs whose prims are in different groups (islands), and pairs inside one group */
  across: number;
  within: number;
  /** the largest pair of each kind: triangle ids and intersection area */
  firstAcross: { t: [number, number]; area: number } | null;
  firstWithin: { t: [number, number]; area: number } | null;
  scan: OverlapScan;
}

/**
 * Overlapping uv triangle pairs of a triangulation (tris: vertex triples; triPrim: prim per triangle) over per-vertex uv,
 * split by groupOfPrim (an island id per prim; -1 = fixed prims, whose pairs among themselves are not tested).
 */
export function uvOverlapCheck(uv: ArrayLike<number>, tris: ArrayLike<number>, triPrim: ArrayLike<number>, groupOfPrim: ArrayLike<number>, o: OverlapScanOptions = {}): UVOverlapCheck {
  const U = trianglesUV(uv, tris), nt = U.length / 6;
  const { ok, signed } = uvTriangleAreas(U, nt);
  const valid: number[] = [];
  for (let t = 0; t < nt; t++) if (ok[t]) valid.push(t);
  const grp = (t: number) => groupOfPrim[triPrim[t]];
  const r: UVOverlapCheck = { across: 0, within: 0, firstAcross: null, firstWithin: null, scan: { candidatePairs: 0, testedPairs: 0, stopped: false } };
  r.scan = uvOverlapPairs(U, valid, signed, (t0, t1, area) => {
    if (grp(t0) === grp(t1)) {
      r.within++;
      if (!r.firstWithin || area > r.firstWithin.area) r.firstWithin = { t: [t0, t1], area };
    } else {
      r.across++;
      if (!r.firstAcross || area > r.firstAcross.area) r.firstAcross = { t: [t0, t1], area };
    }
  }, { ...o, skip: (t0, t1) => (grp(t0) < 0 && grp(t1) < 0) || (o.skip ? o.skip(t0, t1) : false) });
  return r;
}

/** A pair of overlapping triangles in words: both prims' parts and 3D positions, and where in uv they meet. */
export function uvPairText(g: Geometry, uv: ArrayLike<number>, tris: ArrayLike<number>, triPrim: ArrayLike<number>, t0: number, t1: number): string {
  const at = (t: number) => {
    const P = g.P, c = [0, 0, 0];
    for (let k = 0; k < 3; k++) { const i = g.vertexPoint[tris[t * 3 + k]] * 3; c[0] += P[i] / 3; c[1] += P[i + 1] / 3; c[2] += P[i + 2] / 3; }
    return primWhere(g, triPrim[t], c);
  };
  let u = 0, v = 0;
  for (const t of [t0, t1]) for (let k = 0; k < 3; k++) { u += uv[tris[t * 3 + k] * 2] / 6; v += uv[tris[t * 3 + k] * 2 + 1] / 6; }
  return `${at(t0)} × ${at(t1)}, near uv (${u.toFixed(3)}, ${v.toFixed(3)})`;
}
