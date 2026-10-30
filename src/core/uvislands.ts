// Island tools for uv packing (uv_layout, uv_unwrap): per island texel weights from a prim attribute, rotations that
// align islands to the world axes, cutting charts that waste an atlas, and joining thin charts onto a neighbour.
//
// Cutting: a chart longer than the tile side at the density the atlas could reach, or a ring or arc whose convex hull
// is mostly empty (its hole and the inside of its bend take only islands smaller than the gap), is cut across its
// length into two parts by distance from one end (uv distance through uv-continuous edges, so a ring is cut at two
// opposite places), and each connected part is cut again while it still qualifies. Parts are whole polygons and keep
// their uv; the packer moves each part on its own, so each cut becomes a seam.
import type { Geometry } from './geometry.ts';
import { primArea } from './topology.ts';
import { convexHull2D, minAreaRectAngle, polygonSides, uvSeamPairs } from './uv.ts';
import type { PackResult } from './uvpack.ts';
import { uvOverlapPairs } from './uvoverlap.ts';

/** Per prim 3D area, uv area (unsigned) and uv centroid; uv per vertex (2 numbers). */
function primMeasures(g: Geometry, uv: ArrayLike<number>, labels: ArrayLike<number>) {
  const np = g.numPrims, a3 = new Float64Array(np), aUV = new Float64Array(np), cu = new Float64Array(np), cv = new Float64Array(np);
  for (let p = 0; p < np; p++) {
    if (labels[p] < 0) continue;
    const s = g.primStart[p], e = g.primStart[p + 1];
    let a = 0, su = 0, sv = 0;
    for (let v = s; v < e; v++) {
      const w = v + 1 < e ? v + 1 : s;
      a += uv[v * 2] * uv[w * 2 + 1] - uv[w * 2] * uv[v * 2 + 1];
      su += uv[v * 2]; sv += uv[v * 2 + 1];
    }
    aUV[p] = Math.abs(a) / 2; a3[p] = primArea(g, p);
    cu[p] = su / Math.max(1, e - s); cv[p] = sv / Math.max(1, e - s);
  }
  return { a3, aUV, cu, cv };
}

/**
 * Per island texel weight from a numeric prim attribute (its first component), the mean over the island's prims
 * weighted by 3D area; values <= 0 or not finite count as 1, so an attribute set on a group (attrib_create with group)
 * weights only those parts. null when the attribute is missing.
 */
export function islandWeights(g: Geometry, labels: ArrayLike<number>, count: number, attrib: string): Float64Array | null {
  const a = attrib ? g.prims.get(attrib) : undefined;
  if (!a || a.type === 'string' || a.isArray) return null;
  const d = a.data as Float64Array | Int32Array, sz = a.size;
  const sum = new Float64Array(count), wsum = new Float64Array(count);
  for (let p = 0; p < g.numPrims; p++) {
    const k = labels[p];
    if (k < 0) continue;
    const x = Number(d[p * sz]), w = Math.max(primArea(g, p), 1e-30);
    sum[k] += (Number.isFinite(x) && x > 0 ? x : 1) * w; wsum[k] += w;
  }
  return Float64Array.from(sum, (s, k) => (wsum[k] > 0 ? s / wsum[k] : 1));
}

/**
 * Per island the rotation (radians, counter-clockwise, as the packer's angles) that turns world up (+Y) to +v; an island
 * with no up direction (a horizontal face) turns +X to +u instead. Gradients of the world coordinates over the uv of
 * each polygon (fanned into triangles), weighted by uv area. NaN for an island with no uv area.
 */
export function worldAngles(g: Geometry, uv: ArrayLike<number>, labels: ArrayLike<number>, count: number): Float64Array {
  const G = new Float64Array(count * 6); // per island: grad X (a, b), grad Y, grad Z
  const P = g.P, vp = g.vertexPoint;
  for (let p = 0; p < g.numPrims; p++) {
    const k = labels[p];
    if (k < 0) continue;
    const s = g.primStart[p], e = g.primStart[p + 1];
    for (let v = s + 1; v + 1 < e; v++) {
      const du1 = uv[v * 2] - uv[s * 2], dv1 = uv[v * 2 + 1] - uv[s * 2 + 1], du2 = uv[(v + 1) * 2] - uv[s * 2], dv2 = uv[(v + 1) * 2 + 1] - uv[s * 2 + 1];
      const det = du1 * dv2 - du2 * dv1;
      if (!(Math.abs(det) > 0) || !Number.isFinite(det)) continue;
      const sg = Math.sign(det), p0 = vp[s] * 3, p1 = vp[v] * 3, p2 = vp[v + 1] * 3;
      for (let c = 0; c < 3; c++) {
        const d1 = P[p1 + c] - P[p0 + c], d2 = P[p2 + c] - P[p0 + c];
        // gradient (a, b) = ((d1 dv2 - d2 dv1) / det, (du1 d2 - du2 d1) / det), times the uv area |det| / 2
        G[k * 6 + c * 2] += ((d1 * dv2 - d2 * dv1) * sg) / 2;
        G[k * 6 + c * 2 + 1] += ((du1 * d2 - du2 * d1) * sg) / 2;
      }
    }
  }
  const out = new Float64Array(count).fill(NaN);
  for (let k = 0; k < count; k++) {
    const gx = Math.hypot(G[k * 6], G[k * 6 + 1]), gy = Math.hypot(G[k * 6 + 2], G[k * 6 + 3]), gz = Math.hypot(G[k * 6 + 4], G[k * 6 + 5]);
    if (gy > 0.2 * Math.max(gx, gz) && gy > 0) out[k] = Math.PI / 2 - Math.atan2(G[k * 6 + 3], G[k * 6 + 2]);
    else if (gx > 0) out[k] = -Math.atan2(G[k * 6 + 1], G[k * 6]);
    else if (gz > 0) out[k] = Math.PI / 2 + Math.atan2(G[k * 6 + 5], G[k * 6 + 4]);
  }
  return out;
}

export interface CutOptions {
  /** uniform: islands are sized by 3D area (equal texel density); keep: by their uv area */
  scaleMode: 'uniform' | 'keep';
  /** per island texel weight (islandWeights), or null */
  weights?: ArrayLike<number> | null;
  /** tiles the islands are packed into */
  tiles: number;
  /** > 0: tile sides per packing unit the islands are packed at (a fixed texel density), instead of the one that fills the tiles */
  tileScale?: number;
  /** > 0: the most tile sides per packing unit (a texel density the packing may not exceed) */
  maxTileScale?: number;
}

export interface CutResult {
  /** per prim the new island (parts numbered after the islands they come from, in order) */
  labels: Int32Array;
  count: number;
  /** islands cut, the parts they became, and a prim of the first island cut (-1 when none was) */
  cut: number;
  parts: number;
  firstCut: number;
}

/**
 * Whether packing a (islands cut into parts) beats b (the islands whole) by enough to pay for the seams: fewer tiles,
 * or a texel density at least 2 % higher.
 */
export function packsDenser(a: PackResult, b: PackResult): boolean {
  if (!a.packed) return false;
  if (!b.packed) return true;
  if (a.tilesUsed !== b.tilesUsed) return a.tilesUsed < b.tilesUsed;
  return a.texelsPerUnit > b.texelsPerUnit * 1.02;
}

/** Utilisation the island sizes are judged at, and the cut thresholds (shares of a tile side and of a tile). */
const CUT_FILL = 0.8;
const CUT_LONG = 0.9;
const CUT_HOLLOW = 0.5;
const CUT_HOLLOW_MIN = 0.01;
const CUT_DEPTH = 6;

/** Signed area of a flat polygon [x, y, ...]. */
function polyArea(pts: number[]): number {
  let s = 0;
  for (let i = 0, n = pts.length / 2; i < n; i++) { const j = (i + 1) % n; s += pts[i * 2] * pts[j * 2 + 1] - pts[j * 2] * pts[i * 2 + 1]; }
  return s / 2;
}

/** Cut charts longer than the tile, and rings and arcs, into parts (see the file comment). labels: island per prim. */
export function cutLongCharts(g: Geometry, uv: ArrayLike<number>, labels: ArrayLike<number>, count: number, o: CutOptions): CutResult {
  const np = g.numPrims;
  const same: CutResult = { labels: Int32Array.from(labels), count, cut: 0, parts: count, firstCut: -1 };
  if (!count) return same;
  const m = primMeasures(g, uv, labels);
  const members: number[][] = Array.from({ length: count }, () => []);
  const isl3 = new Float64Array(count), islUV = new Float64Array(count);
  for (let p = 0; p < np; p++) { const k = labels[p]; if (k < 0) continue; members[k].push(p); isl3[k] += m.a3[p]; islUV[k] += m.aUV[p]; }
  // packing units per uv unit, as the packer sizes the islands
  let dens = 0, densN = 0;
  for (let k = 0; k < count; k++) if (islUV[k] > 1e-18 && isl3[k] > 1e-18) { dens += Math.sqrt(isl3[k] / islUV[k]); densN++; }
  const meanDens = densN ? dens / densN : 1;
  const sc = new Float64Array(count);
  let A = 0;
  for (let k = 0; k < count; k++) {
    sc[k] = o.scaleMode === 'uniform' ? (islUV[k] > 1e-18 && isl3[k] > 1e-18 ? Math.sqrt(isl3[k] / islUV[k]) : meanDens) : 1;
    const w = o.weights ? Number(o.weights[k]) : 1;
    if (Number.isFinite(w) && w > 0) sc[k] *= w;
    A += islUV[k] * sc[k] * sc[k];
  }
  if (!(A > 0)) return same;
  let s = (o.tileScale ?? 0) > 0 ? o.tileScale! : Math.sqrt((CUT_FILL * Math.max(1, o.tiles)) / A);
  if ((o.maxTileScale ?? 0) > 0) s = Math.min(s, o.maxTileScale!);
  // prims joined through uv-continuous edges of one island
  const mask = Uint8Array.from({ length: np }, (_, p) => (labels[p] >= 0 ? 1 : 0));
  const S = polygonSides(g, mask), seam = uvSeamPairs(S, uv as Float64Array);
  const deg = new Int32Array(np + 1);
  for (let i = 0; i < S.count; i++) if (!seam[i] && labels[S.pA[i]] === labels[S.pB[i]] && S.pA[i] !== S.pB[i]) { deg[S.pA[i] + 1]++; deg[S.pB[i] + 1]++; }
  for (let p = 0; p < np; p++) deg[p + 1] += deg[p];
  const adj = new Int32Array(deg[np]), fill = deg.slice(0, np);
  for (let i = 0; i < S.count; i++) if (!seam[i] && labels[S.pA[i]] === labels[S.pB[i]] && S.pA[i] !== S.pB[i]) { adj[fill[S.pA[i]]++] = S.pB[i]; adj[fill[S.pB[i]]++] = S.pA[i]; }
  // working sets: a stamp marks the prims of the set being cut
  const stamp = new Int32Array(np), dist = new Float64Array(np);
  let gen = 0;
  const qualifies = (set: number[], k: number) => {
    const pts: number[] = [];
    let area = 0;
    for (const p of set) { area += m.aUV[p]; for (let v = g.primStart[p]; v < g.primStart[p + 1]; v++) pts.push(uv[v * 2], uv[v * 2 + 1]); }
    const hull = convexHull2D(pts), ang = minAreaRectAngle(hull), c = Math.cos(ang), sn = Math.sin(ang);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < hull.length; i += 2) {
      const x = hull[i] * c - hull[i + 1] * sn, y = hull[i] * sn + hull[i + 1] * c;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const f = sc[k] * s, len = Math.max(x1 - x0, y1 - y0) * f, hullArea = Math.abs(polyArea(hull)) * f * f;
    return len > CUT_LONG || (hullArea > CUT_HOLLOW_MIN && area * f * f < CUT_HOLLOW * hullArea);
  };
  /** distances (uv, centroid to centroid) from `from` within the stamped set; returns the farthest prim and its distance */
  const sweep = (from: number, set: number[]): [number, number] => {
    for (const p of set) dist[p] = Infinity;
    dist[from] = 0;
    const hk: number[] = [0], hv: number[] = [from];
    const push = (key: number, val: number) => {
      let i = hk.length; hk.push(key); hv.push(val);
      while (i > 0) { const q = (i - 1) >> 1; if (hk[q] <= key) break; hk[i] = hk[q]; hv[i] = hv[q]; i = q; }
      hk[i] = key; hv[i] = val;
    };
    const pop = (): [number, number] => {
      const top: [number, number] = [hk[0], hv[0]], lk = hk.pop()!, lv = hv.pop()!;
      if (hk.length) {
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let j = i, jk = lk;
          if (l < hk.length && hk[l] < jk) { j = l; jk = hk[l]; }
          if (r < hk.length && hk[r] < jk) { j = r; jk = hk[r]; }
          if (j === i) break;
          hk[i] = hk[j]; hv[i] = hv[j]; i = j;
        }
        hk[i] = lk; hv[i] = lv;
      }
      return top;
    };
    let far = from, farD = 0;
    while (hk.length) {
      const [d, p] = pop();
      if (d > dist[p]) continue;
      if (d > farD) { farD = d; far = p; }
      for (let i = deg[p]; i < deg[p + 1]; i++) {
        const q = adj[i];
        if (stamp[q] !== gen) continue;
        const nd = d + Math.hypot(m.cu[q] - m.cu[p], m.cv[q] - m.cv[p]);
        if (nd < dist[q]) { dist[q] = nd; push(nd, q); }
      }
    }
    return [far, farD];
  };
  /** connected parts of `set` restricted to prims passing `keep` */
  const components = (set: number[], keep: (p: number) => boolean): number[][] => {
    gen++;
    for (const p of set) if (keep(p)) stamp[p] = gen;
    const out: number[][] = [];
    for (const p of set) {
      if (stamp[p] !== gen) continue;
      const part = [p];
      stamp[p] = -gen;
      for (let i = 0; i < part.length; i++) {
        const x = part[i];
        for (let j = deg[x]; j < deg[x + 1]; j++) { const q = adj[j]; if (stamp[q] === gen) { stamp[q] = -gen; part.push(q); } }
      }
      out.push(part);
    }
    return out;
  };
  const cutSet = (set: number[], k: number, depth: number): number[][] => {
    if (depth >= CUT_DEPTH || set.length < 2 || !qualifies(set, k)) return [set];
    gen++;
    for (const p of set) stamp[p] = gen;
    const [a] = sweep(set[0], set);
    const [, D] = sweep(a, set);
    if (!(D > 0)) return [set];
    const near = new Set<number>();
    for (const p of set) if (dist[p] < D / 2) near.add(p);
    if (!near.size || near.size === set.length) return [set];
    const parts = [...components(set, (p) => near.has(p)), ...components(set, (p) => !near.has(p))];
    if (parts.length < 2) return [set];
    return parts.flatMap((part) => cutSet(part, k, depth + 1));
  };
  const out = new Int32Array(np).fill(-1);
  let next = 0, cut = 0, firstCut = -1;
  for (let k = 0; k < count; k++) {
    const set = members[k];
    if (!set.length) continue;
    const parts = cutSet(set, k, 0);
    if (parts.length > 1) { cut++; if (firstCut < 0) firstCut = set[0]; }
    for (const part of parts) { for (const p of part) out[p] = next; next++; }
  }
  if (!cut) return same;
  return { labels: out, count: next, cut, parts: next, firstCut };
}

export interface MergeOptions {
  /** texture size and the padding between charts, in its texels */
  resolution: number;
  padding: number;
}

export interface MergeResult { labels: Int32Array; count: number; merged: number }

/** A chart narrower than this many padding widths (at the density the atlas could reach, at least THIN_MIN_TEXELS) and at least THIN_ASPECT times longer than wide is thin. */
const THIN_PADDINGS = 3;
const THIN_MIN_TEXELS = 8;
const THIN_ASPECT = 3;
/** The seam two charts share must line up to this share of the thin chart's width, at a scale within MERGE_SCALE of the density ratio. */
const MERGE_FIT = 0.05;
const MERGE_SCALE = 0.1;

/**
 * Join thin charts (bevel strips, narrow bands) onto a neighbouring chart, so fewer charts each lose a padding border
 * in the atlas. A thin chart (uniform texel density: its narrow side, at the density that fills about three quarters of
 * the tile, under THIN_PADDINGS paddings, and long) is turned, scaled and shifted (a least squares similarity) so the
 * seam it shares with the neighbour lines up; it joins when the scale is within MERGE_SCALE of the two charts' density
 * ratio, the seam lines up within MERGE_FIT of its width, and it keeps its winding and overlaps neither itself nor the
 * neighbour. The seam's corners then take the neighbour's uv, so
 * it is no longer a seam. Neighbours are tried by shared seam length. uv (per vertex) is changed in place.
 */
export function mergeThinCharts(g: Geometry, uv: Float64Array, labels: ArrayLike<number>, count: number, o: MergeOptions): MergeResult {
  const np = g.numPrims, vp = g.vertexPoint;
  const same: MergeResult = { labels: Int32Array.from(labels), count, merged: 0 };
  if (count < 2 || !(o.resolution > 0)) return same;
  const m = primMeasures(g, uv, labels);
  const members: number[][] = Array.from({ length: count }, () => []);
  const a3 = new Float64Array(count), aUV = new Float64Array(count);
  let total3 = 0;
  for (let p = 0; p < np; p++) { const k = labels[p]; if (k < 0) continue; members[k].push(p); a3[k] += m.a3[p]; aUV[k] += m.aUV[p]; total3 += m.a3[p]; }
  if (!(total3 > 0)) return same;
  const dens = Float64Array.from(a3, (x, k) => (x > 1e-30 && aUV[k] > 1e-30 ? Math.sqrt(aUV[k] / x) : 0)); // uv per world unit
  const texPerWorld = Math.sqrt(0.75 / total3) * o.resolution;
  const thinTexels = Math.max(THIN_MIN_TEXELS, THIN_PADDINGS * o.padding);
  // narrow and long side (world units) of each chart's minimum bounding rectangle
  const width = new Float64Array(count), length = new Float64Array(count);
  for (let k = 0; k < count; k++) {
    if (!dens[k] || !members[k].length) continue;
    const pts: number[] = [];
    for (const p of members[k]) for (let v = g.primStart[p]; v < g.primStart[p + 1]; v++) pts.push(uv[v * 2], uv[v * 2 + 1]);
    const hull = convexHull2D(pts), ang = minAreaRectAngle(hull), c = Math.cos(ang), s = Math.sin(ang);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < hull.length; i += 2) {
      const x = hull[i] * c - hull[i + 1] * s, y = hull[i] * s + hull[i + 1] * c;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    width[k] = Math.min(x1 - x0, y1 - y0) / dens[k];
    length[k] = Math.max(x1 - x0, y1 - y0) / dens[k];
  }
  const thin: number[] = [];
  for (let k = 0; k < count; k++) if (dens[k] > 0 && width[k] * texPerWorld < thinTexels && length[k] >= THIN_ASPECT * width[k]) thin.push(k);
  if (!thin.length) return same;
  // seams between charts: side pairs whose prims are in different charts
  const mask = Uint8Array.from({ length: np }, (_, p) => (labels[p] >= 0 ? 1 : 0));
  const S = polygonSides(g, mask);
  const seamsOf: number[][] = Array.from({ length: count }, () => []);
  for (let i = 0; i < S.count; i++) {
    const ka = labels[S.pA[i]], kb = labels[S.pB[i]];
    if (ka !== kb) { seamsOf[ka].push(i); seamsOf[kb].push(i); }
  }
  // triangles per prim (fans), for the overlap test
  const triOf: number[][] = Array.from({ length: np }, () => []);
  for (let p = 0; p < np; p++) {
    if (labels[p] < 0) continue;
    const s0 = g.primStart[p], e = g.primStart[p + 1];
    for (let v = s0 + 1; v + 1 < e; v++) triOf[p].push(s0, v, v + 1);
  }
  const root = Int32Array.from({ length: count }, (_, i) => i);
  const find = (x: number) => { while (root[x] !== x) { root[x] = root[root[x]]; x = root[x]; } return x; };
  const P = g.P, edgeLen = (i: number) => {
    const a = vp[S.a1[i]] * 3, b = vp[S.b1[i]] * 3;
    return Math.hypot(P[a] - P[b], P[a + 1] - P[b + 1], P[a + 2] - P[b + 2]);
  };
  let merged = 0;
  thin.sort((x, y) => width[x] - width[y] || x - y);
  for (const A of thin) {
    if (find(A) !== A) continue;
    // neighbours by shared seam length
    const shared = new Map<number, number>();
    for (const i of seamsOf[A]) {
      const ka = find(labels[S.pA[i]]), kb = find(labels[S.pB[i]]);
      const other = ka === A ? kb : kb === A ? ka : -1;
      if (other < 0 || other === A) continue;
      shared.set(other, (shared.get(other) ?? 0) + edgeLen(i));
    }
    const cands = [...shared].sort((x, y) => y[1] - x[1] || x[0] - y[0]).slice(0, 3).map(([k]) => k);
    for (const B of cands) {
      if (!dens[B]) continue;
      // corresponding corners on the seam: A's uv and B's uv of each shared point
      const corr = new Map<number, [number, number]>(); // point -> [A corner, B corner]
      for (const i of seamsOf[A]) {
        const ka = find(labels[S.pA[i]]), kb = find(labels[S.pB[i]]);
        if (!((ka === A && kb === B) || (ka === B && kb === A))) continue;
        const aFirst = ka === A;
        const pairs: [number, number][] = aFirst ? [[S.a1[i], S.a2[i]], [S.b1[i], S.b2[i]]] : [[S.a2[i], S.a1[i]], [S.b2[i], S.b1[i]]];
        for (const [ca, cb] of pairs) if (!corr.has(vp[ca])) corr.set(vp[ca], [ca, cb]);
      }
      if (corr.size < 2) continue;
      // similarity fit (rotation and scale, least squares) of A's seam corners onto B's; the scale must be near the
      // density ratio, so A keeps about B's texel density
      const k = dens[B] / dens[A];
      let ax = 0, ay = 0, bx = 0, by = 0;
      for (const [ca, cb] of corr.values()) { ax += uv[ca * 2]; ay += uv[ca * 2 + 1]; bx += uv[cb * 2]; by += uv[cb * 2 + 1]; }
      const n = corr.size;
      ax /= n; ay /= n; bx /= n; by /= n;
      let sxx = 0, sxy = 0, saa = 0;
      for (const [ca, cb] of corr.values()) {
        const x = uv[ca * 2] - ax, y = uv[ca * 2 + 1] - ay, u = uv[cb * 2] - bx, w = uv[cb * 2 + 1] - by;
        sxx += x * u + y * w; sxy += x * w - y * u; saa += x * x + y * y;
      }
      if (!(saa > 0)) continue;
      const c = sxx / saa, s = sxy / saa, scale = Math.hypot(c, s);
      if (!(scale > k * (1 - MERGE_SCALE) && scale < k * (1 + MERGE_SCALE))) continue;
      const move = (u: number, w: number): [number, number] => [(u - ax) * c - (w - ay) * s + bx, (u - ax) * s + (w - ay) * c + by];
      let resid = 0;
      for (const [ca, cb] of corr.values()) {
        const [u, w] = move(uv[ca * 2], uv[ca * 2 + 1]);
        resid = Math.max(resid, Math.hypot(u - uv[cb * 2], w - uv[cb * 2 + 1]));
      }
      if (resid / dens[B] > MERGE_FIT * width[A]) continue;
      // A moved, its seam corners on B's
      const moved = new Map<number, [number, number]>();
      const seamUV = new Map<number, number>(); // point -> B corner
      for (const [pt, [, cb]] of corr) seamUV.set(pt, cb);
      const primsA = members[A], primsB = members[B];
      for (const p of primsA) for (let v = g.primStart[p]; v < g.primStart[p + 1]; v++) {
        const cb = seamUV.get(vp[v]);
        moved.set(v, cb !== undefined ? [uv[cb * 2], uv[cb * 2 + 1]] : move(uv[v * 2], uv[v * 2 + 1]));
      }
      // the joined chart must keep A's winding and overlap nowhere
      const tris: number[] = [];
      for (const p of primsA) tris.push(...triOf[p]);
      const nA = tris.length / 3;
      for (const p of primsB) tris.push(...triOf[p]);
      const nt = tris.length / 3, U = new Float64Array(nt * 6), signed = new Float64Array(nt), valid: number[] = [];
      let flipped = false;
      for (let t = 0; t < nt; t++) {
        for (let q = 0; q < 3; q++) {
          const v = tris[t * 3 + q], mv = t < nA ? moved.get(v)! : null;
          U[t * 6 + q * 2] = mv ? mv[0] : uv[v * 2]; U[t * 6 + q * 2 + 1] = mv ? mv[1] : uv[v * 2 + 1];
        }
        const o6 = t * 6, du1 = U[o6 + 2] - U[o6], dv1 = U[o6 + 3] - U[o6 + 1], du2 = U[o6 + 4] - U[o6], dv2 = U[o6 + 5] - U[o6 + 1];
        const cr = du1 * dv2 - du2 * dv1, e2 = du1 * du1 + dv1 * dv1 + du2 * du2 + dv2 * dv2;
        if (Math.abs(cr) > 1e-12 * e2 && Number.isFinite(cr)) { signed[t] = cr / 2; valid.push(t); if (t < nA && cr < 0) flipped = true; }
      }
      if (flipped) continue;
      let clash = false;
      uvOverlapPairs(U, valid, signed, (t0, t1) => { if (t0 < nA || t1 < nA) clash = true; }, { skip: (t0, t1) => clash || (t0 >= nA && t1 >= nA) });
      if (clash) continue;
      for (const [v, [u, w]] of moved) { uv[v * 2] = u; uv[v * 2 + 1] = w; }
      root[A] = B;
      aUV[B] += aUV[A] * scale * scale; a3[B] += a3[A];
      for (const p of members[A]) members[B].push(p);
      for (const i of seamsOf[A]) seamsOf[B].push(i);
      members[A] = []; seamsOf[A] = [];
      merged++;
      break;
    }
  }
  if (!merged) return same;
  const out = new Int32Array(np).fill(-1), ids = new Map<number, number>();
  for (let p = 0; p < np; p++) {
    if (labels[p] < 0) continue;
    const r = find(labels[p]);
    let id = ids.get(r);
    if (id === undefined) { id = ids.size; ids.set(r, id); }
    out[p] = id;
  }
  return { labels: out, count: ids.size, merged };
}
