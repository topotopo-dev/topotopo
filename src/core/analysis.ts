// Geometry analysis shared by the measure nodes (curvature, occlusion, distance, assert) and the
// explain / diff tools:
//  - discrete curvature (cotangent Laplacian with mixed Voronoi areas, angle deficit)
//  - allocation-free ray queries over a TriBVH (any-hit occlusion, nearest hit, parity inside test)
//  - stratified, seeded hemisphere / cone ray sampling for occlusion, thickness and cavity
//  - closest-point queries against mesh surfaces (BVH), polylines (segment BVH) and point clouds (KD-tree)
//  - mesh checks: self-intersections, duplicate points, short edges, non-manifold points
//  - shape descriptors: per-piece topology (closed, genus, boundary loops, volume), PCA, mirror symmetry,
//    area-weighted surface sampling, directed (Hausdorff) distances
// Host-agnostic: no I/O.
import { Geometry } from './geometry.ts';
import type { Vec3 } from './math.ts';
import { buildEdges, connectivity, pointNeighbors, triangulate } from './topology.ts';
import { halfEdges } from './halfedge.ts';
import { EDGE_BAND, KDTree, TriBVH, invDir } from './spatial.ts';
import { trianglesContact } from './tritri.ts';
import type { TriBVHArrays } from './spatial.ts';
import { hash32, hashNumber } from './random.ts';

// ---------------------------------------------------------------- small helpers

/** A number with 4 significant digits for messages ("0.9993", "1250", "2.5e-6"). */
export function fmt(x: number): string {
  if (!Number.isFinite(x)) return String(x);
  if (x === 0) return '0';
  const a = Math.abs(x);
  if (a >= 1e7 || a < 1e-4) return x.toExponential(3).replace(/\.?0+e/, 'e');
  return String(+x.toPrecision(4));
}

/** Length of the bbox diagonal (0 for empty geometry). */
export function bboxDiagonal(g: Geometry): number {
  if (!g.numPoints) return 0;
  const b = g.bbox();
  return Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
}

/** Value at quantile q (0..1) of the values (NaN ignored). */
export function quantile(v: ArrayLike<number>, q: number): number {
  const a: number[] = [];
  for (let i = 0; i < v.length; i++) if (v[i] === v[i]) a.push(v[i]);
  if (!a.length) return NaN;
  a.sort((x, y) => x - y);
  const t = Math.max(0, Math.min(1, q)) * (a.length - 1), i = Math.floor(t), f = t - i;
  return i + 1 < a.length ? a[i] * (1 - f) + a[i + 1] * f : a[i];
}

/** Fit values to 0..1 in place between the clipPercent and (100 - clipPercent) percentiles; constant values become 0.5. */
export function percentileFit(v: Float64Array, clipPercent: number): { lo: number; hi: number } {
  const c = Math.max(0, Math.min(49.9, clipPercent)) / 100;
  const lo = quantile(v, c), hi = quantile(v, 1 - c);
  const span = hi - lo;
  for (let i = 0; i < v.length; i++) {
    if (!(span > 1e-300)) { v[i] = 0.5; continue; }
    const t = (v[i] - lo) / span;
    v[i] = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  return { lo, hi };
}

/** Uniform Laplacian smoothing of a per-point scalar over polygon/polyline neighbours (in place). */
export function smoothPointValues(g: Geometry, v: Float64Array, iterations: number, lambda = 0.5): void {
  if (iterations <= 0 || !g.numPrims) return;
  const { start, nb } = pointNeighbors(g);
  const tmp = new Float64Array(v.length);
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < v.length; i++) {
      const s = start[i], e = start[i + 1];
      if (e === s) { tmp[i] = v[i]; continue; }
      let acc = 0;
      for (let k = s; k < e; k++) acc += v[nb[k]];
      tmp[i] = v[i] + lambda * (acc / (e - s) - v[i]);
    }
    v.set(tmp);
  }
}

/**
 * Copy values from the nearest (in edge hops) valid point to every invalid point, for each array in vals.
 * Returns the number of invalid points no valid point could reach (they get 0).
 */
export function fillFromNearestValid(g: Geometry, valid: Uint8Array, vals: Float64Array[]): number {
  const np = g.numPoints;
  const src = new Int32Array(np).fill(-1), queue = new Int32Array(np);
  let qh = 0, qt = 0;
  for (let i = 0; i < np; i++) if (valid[i]) { src[i] = i; queue[qt++] = i; }
  if (qt === np) return 0;
  const { start, nb } = pointNeighbors(g);
  while (qh < qt) {
    const i = queue[qh++];
    for (let k = start[i]; k < start[i + 1]; k++) {
      const j = nb[k];
      if (src[j] < 0) { src[j] = src[i]; queue[qt++] = j; }
    }
  }
  let unreached = 0;
  for (let i = 0; i < np; i++) {
    if (valid[i]) continue;
    const s = src[i];
    if (s < 0) unreached++;
    for (const a of vals) a[i] = s >= 0 ? a[s] : 0;
  }
  return unreached;
}

// ---------------------------------------------------------------- curvature

export const CURVATURE_TYPES = ['mean', 'gaussian', 'principal_min', 'principal_max', 'convexity'];

export interface CurvatureData {
  /** signed mean curvature per point, 1/m (positive = convex with respect to the normals; 1 on a unit sphere) */
  mean: Float64Array;
  /** Gaussian curvature per point, 1/m² (angle deficit over the mixed Voronoi area) */
  gaussian: Float64Array;
  /** 1 where the value comes from a complete manifold one-ring; boundary, non-manifold and isolated points are 0 */
  valid: Uint8Array;
  boundary: number;
  nonManifold: number;
  isolated: number;
}

/**
 * Discrete curvature of the polygons of g (n-gons through their triangulation), Meyer et al. 2003:
 * mean curvature normal from the cotangent Laplacian over the mixed Voronoi area, Gaussian curvature
 * from the angle deficit. N are point normals (3 per point) giving the sign of the mean curvature.
 * Invalid points (boundary, non-manifold, no polygons) keep their raw (meaningless) values; callers fill them.
 */
export function discreteCurvature(g: Geometry, N: ArrayLike<number>): CurvatureData {
  const np = g.numPoints, P = g.P, vp = g.vertexPoint;
  const { tris } = triangulate(g);
  const L = new Float64Array(np * 3), A = new Float64Array(np), ang = new Float64Array(np);
  const used = new Uint8Array(np);
  for (let t = 0; t < tris.length; t += 3) {
    const a = vp[tris[t]], b = vp[tris[t + 1]], c = vp[tris[t + 2]];
    if (a === b || b === c || a === c) continue;
    const ia = a * 3, ib = b * 3, ic = c * 3;
    const abx = P[ib] - P[ia], aby = P[ib + 1] - P[ia + 1], abz = P[ib + 2] - P[ia + 2];
    const acx = P[ic] - P[ia], acy = P[ic + 1] - P[ia + 1], acz = P[ic + 2] - P[ia + 2];
    const bcx = P[ic] - P[ib], bcy = P[ic + 1] - P[ib + 1], bcz = P[ic + 2] - P[ib + 2];
    const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
    const cr = Math.hypot(nx, ny, nz); // 2 × area
    const ab2 = abx * abx + aby * aby + abz * abz, ac2 = acx * acx + acy * acy + acz * acz, bc2 = bcx * bcx + bcy * bcy + bcz * bcz;
    if (!(cr > 1e-12 * Math.max(ab2, ac2, bc2))) continue; // degenerate sliver
    const dA = abx * acx + aby * acy + abz * acz; // angle at a: ab·ac
    const dB = -(abx * bcx + aby * bcy + abz * bcz); // at b: ba·bc
    const dC = acx * bcx + acy * bcy + acz * bcz; // at c: ca·cb
    const cotA = dA / cr, cotB = dB / cr, cotC = dC / cr;
    // Laplacian Σ (cot α + cot β)(p_i − p_j): edge bc weighted by cotA, ca by cotB, ab by cotC
    L[ia] += -cotB * acx - cotC * abx; L[ia + 1] += -cotB * acy - cotC * aby; L[ia + 2] += -cotB * acz - cotC * abz;
    L[ib] += -cotA * bcx + cotC * abx; L[ib + 1] += -cotA * bcy + cotC * aby; L[ib + 2] += -cotA * bcz + cotC * abz;
    L[ic] += cotA * bcx + cotB * acx; L[ic + 1] += cotA * bcy + cotB * acy; L[ic + 2] += cotA * bcz + cotB * acz;
    ang[a] += Math.atan2(cr, dA); ang[b] += Math.atan2(cr, dB); ang[c] += Math.atan2(cr, dC);
    const area = cr / 2;
    if (dA < 0) { A[a] += area / 2; A[b] += area / 4; A[c] += area / 4; }
    else if (dB < 0) { A[b] += area / 2; A[a] += area / 4; A[c] += area / 4; }
    else if (dC < 0) { A[c] += area / 2; A[a] += area / 4; A[b] += area / 4; }
    else {
      A[a] += (ab2 * cotC + ac2 * cotB) / 8;
      A[b] += (ab2 * cotC + bc2 * cotA) / 8;
      A[c] += (ac2 * cotB + bc2 * cotA) / 8;
    }
    used[a] = used[b] = used[c] = 1;
  }
  // boundary and non-manifold points from the polygon edges
  const bad = new Uint8Array(np);
  let boundary = 0, nonManifold = 0, isolated = 0;
  const he = halfEdges(g);
  for (let e = 0; e < he.numEdges; e++) {
    const nm = he.nonManifoldEdges.has(e);
    if (he.edgeValence(e) !== 1 && !nm) continue;
    const a = he.edgeA[e], b = he.edgeB[e];
    if (nm) { bad[a] = 2; bad[b] = 2; } else { if (!bad[a]) bad[a] = 1; if (!bad[b]) bad[b] = 1; }
  }
  for (const p of nonManifoldPoints(g)) bad[p] = 2;
  const mean = new Float64Array(np), gaussian = new Float64Array(np), valid = new Uint8Array(np);
  for (let i = 0; i < np; i++) {
    const a = A[i];
    if (a > 0) {
      mean[i] = (L[i * 3] * N[i * 3] + L[i * 3 + 1] * N[i * 3 + 1] + L[i * 3 + 2] * N[i * 3 + 2]) / (4 * a);
      gaussian[i] = (2 * Math.PI - ang[i]) / a;
    }
    if (!used[i] || !(a > 0)) { isolated++; continue; }
    if (bad[i] === 1) { boundary++; continue; }
    if (bad[i] === 2) { nonManifold++; continue; }
    valid[i] = 1;
  }
  return { mean, gaussian, valid, boundary, nonManifold, isolated };
}

/**
 * Points whose polygons do not form a single fan (bowties: two cones touching at a point).
 * Points on non-manifold edges are reported by the half-edge structure instead.
 */
export function nonManifoldPoints(g: Geometry): number[] {
  const he = halfEdges(g);
  const out: number[] = [];
  for (let p = 0; p < g.numPoints; p++) {
    const n = he.pointHalfStart[p + 1] - he.pointHalfStart[p];
    if (n < 2) continue;
    const start = he.pointFirst[p];
    let h = start, count = 0;
    do {
      count++;
      const t = he.heTwin[he.hePrev[h]];
      if (t < 0) break;
      h = t;
    } while (h !== start && count <= n);
    if (count < n) out.push(p);
  }
  return out;
}

/** Curvature values of one type from mean H and Gaussian K (convexity: sign of H, 0 where |H|·scale < 1e-6). */
export function curvatureOfType(type: string, H: Float64Array, K: Float64Array, scale: number): Float64Array {
  const n = H.length, out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const h = H[i], k = K[i];
    switch (type) {
      case 'gaussian': out[i] = k; break;
      case 'principal_max': out[i] = h + Math.sqrt(Math.max(0, h * h - k)); break;
      case 'principal_min': out[i] = h - Math.sqrt(Math.max(0, h * h - k)); break;
      case 'convexity': out[i] = Math.abs(h) * scale < 1e-6 ? 0 : Math.sign(h); break;
      default: out[i] = h;
    }
  }
  return out;
}

// ---------------------------------------------------------------- ray queries

/**
 * Allocation-free ray queries over a TriBVH (its node bounds, children, triangle order and corner positions).
 * Triangles are two-sided. Directions need not be normalised: t is in units of |dir|.
 */
export class RayScene {
  bvh: TriBVH;
  /** triangle of the last nearest() hit (-1 = none) */
  lastTri = -1;
  private T: Float64Array;
  private nodes: Float64Array;
  private child: Int32Array;
  private order: Int32Array;
  private stack = new Int32Array(512);
  private tstack = new Float64Array(512);

  constructor(bvh: TriBVH) {
    this.bvh = bvh;
    this.T = bvh.T; this.nodes = bvh.nodes; this.child = bvh.child; this.order = bvh.order;
  }

  static of(g: Geometry): RayScene { return new RayScene(new TriBVH(g)); }

  /** The arrays the ray queries read, for sharing the scene with worker threads (rebuilt there with fromArrays). */
  toArrays(): { T: Float64Array; nodes: Float64Array; child: Int32Array; order: Int32Array; triPt: Int32Array } {
    return { T: this.T, nodes: this.nodes, child: this.child, order: this.order, triPt: this.bvh.triPt };
  }

  /**
   * A scene over arrays from toArrays() (no BVH build). The BVH is a real TriBVH instance over the shared arrays, so
   * the ray queries and the watertight edge test (crossesTri → neighbours/facing, which need T and triPt) work; the
   * closest-point and attribute lookups that need the source geometry are not available here.
   */
  static fromArrays(a: TriBVHArrays): RayScene {
    return new RayScene(TriBVH.fromArrays(a));
  }

  get empty() { return this.bvh.numTris === 0; }

  /** Entry distance of the ray into node n's box, or Infinity when it misses within [0, tmax). */
  private enter(n: number, ox: number, oy: number, oz: number, ix: number, iy: number, iz: number, tmax: number): number {
    const b = this.nodes, o = n * 6;
    let t0 = (b[o] - ox) * ix, t1 = (b[o + 3] - ox) * ix, s: number;
    if (t0 > t1) { s = t0; t0 = t1; t1 = s; }
    // NaN (ray in a slab plane with a zero direction component) leaves the axis unconstrained
    let tn = t0 === t0 ? t0 : -Infinity, tf = t1 === t1 ? t1 : Infinity;
    t0 = (b[o + 1] - oy) * iy; t1 = (b[o + 4] - oy) * iy;
    if (t0 > t1) { s = t0; t0 = t1; t1 = s; }
    if (t0 > tn) tn = t0;
    if (t1 < tf) tf = t1;
    t0 = (b[o + 2] - oz) * iz; t1 = (b[o + 5] - oz) * iz;
    if (t0 > t1) { s = t0; t0 = t1; t1 = s; }
    if (t0 > tn) tn = t0;
    if (t1 < tf) tf = t1;
    if (tn > tf * 1.0000001 + 1e-12 || tf < 0 || tn >= tmax) return Infinity;
    return tn < 0 ? 0 : tn;
  }

  /** Möller–Trumbore against triangle tri, watertight on edges (EDGE_BAND, TriBVH.crossesTri): t or -1. */
  private hitTri(tri: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number {
    const T = this.T, o = tri * 9;
    const e1x = T[o + 3] - T[o], e1y = T[o + 4] - T[o + 1], e1z = T[o + 5] - T[o + 2];
    const e2x = T[o + 6] - T[o], e2y = T[o + 7] - T[o + 1], e2z = T[o + 8] - T[o + 2];
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det > -1e-30 && det < 1e-30) return -1;
    const inv = 1 / det;
    const tx = ox - T[o], ty = oy - T[o + 1], tz = oz - T[o + 2];
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < -EDGE_BAND || u > 1 + EDGE_BAND) return -1;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < -EDGE_BAND || u + v > 1 + EDGE_BAND) return -1;
    if ((u < EDGE_BAND || v < EDGE_BAND || u + v > 1 - EDGE_BAND) && !this.bvh.crossesTri(tri, ox, oy, oz, dx, dy, dz)) return -1;
    return (e2x * qx + e2y * qy + e2z * qz) * inv;
  }

  /** True when the ray hits a triangle at tmin < t < tmax. */
  occluded(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tmax: number, tmin = 0): boolean {
    if (this.empty) return false;
    const ix = invDir(dx), iy = invDir(dy), iz = invDir(dz);
    const st = this.stack, child = this.child, order = this.order;
    let sp = 0;
    st[sp++] = 0;
    while (sp > 0) {
      const n = st[--sp];
      if (this.enter(n, ox, oy, oz, ix, iy, iz, tmax) === Infinity) continue;
      const c0 = child[n * 2], c1 = child[n * 2 + 1];
      if (c0 < 0) {
        const s = -1 - c0;
        for (let i = s; i < s + c1; i++) {
          const t = this.hitTri(order[i], ox, oy, oz, dx, dy, dz);
          if (t > tmin && t < tmax) return true;
        }
      } else { st[sp++] = c1; st[sp++] = c0; }
    }
    return false;
  }

  /** Nearest hit at tmin < t < tmax, or Infinity (lastTri = its triangle). */
  nearest(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tmax = Infinity, tmin = 0): number {
    this.lastTri = -1;
    if (this.empty) return Infinity;
    const ix = invDir(dx), iy = invDir(dy), iz = invDir(dz);
    const st = this.stack, ts = this.tstack, child = this.child, order = this.order;
    let best = tmax, sp = 0;
    st[0] = 0; ts[0] = this.enter(0, ox, oy, oz, ix, iy, iz, best); sp = 1;
    while (sp > 0) {
      sp--;
      const n = st[sp];
      if (!(ts[sp] < best)) continue;
      const c0 = child[n * 2], c1 = child[n * 2 + 1];
      if (c0 < 0) {
        const s = -1 - c0;
        for (let i = s; i < s + c1; i++) {
          const t = this.hitTri(order[i], ox, oy, oz, dx, dy, dz);
          if (t > tmin && t < best) { best = t; this.lastTri = order[i]; }
        }
      } else {
        const t0 = this.enter(c0, ox, oy, oz, ix, iy, iz, best), t1 = this.enter(c1, ox, oy, oz, ix, iy, iz, best);
        // push the far child first so the near one is popped first
        if (t0 <= t1) {
          if (t1 < best) { st[sp] = c1; ts[sp++] = t1; }
          if (t0 < best) { st[sp] = c0; ts[sp++] = t0; }
        } else {
          if (t0 < best) { st[sp] = c0; ts[sp++] = t0; }
          if (t1 < best) { st[sp] = c1; ts[sp++] = t1; }
        }
      }
    }
    return best < tmax ? best : Infinity;
  }

  /** Number of triangle crossings along the ray (t > 0). */
  countHits(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number {
    if (this.empty) return 0;
    const ix = invDir(dx), iy = invDir(dy), iz = invDir(dz);
    const st = this.stack, child = this.child, order = this.order;
    let sp = 0, hits = 0;
    st[sp++] = 0;
    while (sp > 0) {
      const n = st[--sp];
      if (this.enter(n, ox, oy, oz, ix, iy, iz, Infinity) === Infinity) continue;
      const c0 = child[n * 2], c1 = child[n * 2 + 1];
      if (c0 < 0) {
        const s = -1 - c0;
        for (let i = s; i < s + c1; i++) if (this.hitTri(order[i], ox, oy, oz, dx, dy, dz) > 0) hits++;
      } else { st[sp++] = c1; st[sp++] = c0; }
    }
    return hits;
  }

  private mstack = new Int32Array(512);

  // Packets: up to 32 rays from one origin walk the BVH together, live rays held in a bitmask. The node bounds
  // relative to the origin are computed once per node; the slab test runs per live ray. ID holds the inverse
  // directions and must not contain Infinity for a zero component (use 1 / (d || 1e-300)), so 0 * ID is never NaN.

  /**
   * Any-hit test of a packet of n <= 32 rays from one origin (directions D, inverse directions ID, 3 per ray):
   * returns the bitmask of rays that hit a triangle at 0 < t < tmax.
   */
  occludedPacket(ox: number, oy: number, oz: number, D: Float64Array, ID: Float64Array, n: number, tmax: number): number {
    if (this.empty || n <= 0) return 0;
    const T = this.T, b = this.nodes, child = this.child, order = this.order, st = this.stack, ms = this.mstack;
    let hit = 0, sp = 0;
    st[sp] = 0; ms[sp++] = n >= 32 ? -1 : (1 << n) - 1;
    while (sp > 0) {
      sp--;
      const nd = st[sp];
      let m = ms[sp] & ~hit;
      if (!m) continue;
      // slab test of every live ray against the node
      const o = nd * 6;
      const x0 = b[o] - ox, y0 = b[o + 1] - oy, z0 = b[o + 2] - oz, x1 = b[o + 3] - ox, y1 = b[o + 4] - oy, z1 = b[o + 5] - oz;
      let mm = 0;
      while (m) {
        const bit = m & -m;
        m ^= bit;
        const q = (31 - Math.clz32(bit)) * 3;
        const ix = ID[q], iy = ID[q + 1], iz = ID[q + 2];
        let t0 = x0 * ix, t1 = x1 * ix, s: number;
        if (t0 > t1) { s = t0; t0 = t1; t1 = s; }
        let tn = t0, tf = t1;
        t0 = y0 * iy; t1 = y1 * iy;
        if (t0 > t1) { s = t0; t0 = t1; t1 = s; }
        if (t0 > tn) tn = t0;
        if (t1 < tf) tf = t1;
        t0 = z0 * iz; t1 = z1 * iz;
        if (t0 > t1) { s = t0; t0 = t1; t1 = s; }
        if (t0 > tn) tn = t0;
        if (t1 < tf) tf = t1;
        if (tn <= tf && tf >= 0 && tn < tmax) mm |= bit;
      }
      if (!mm) continue;
      const c0 = child[nd * 2], c1 = child[nd * 2 + 1];
      if (c0 >= 0) { st[sp] = c1; ms[sp++] = mm; st[sp] = c0; ms[sp++] = mm; continue; }
      const s = -1 - c0;
      for (let i = s; i < s + c1 && mm; i++) {
        const tq = order[i] * 9;
        const e1x = T[tq + 3] - T[tq], e1y = T[tq + 4] - T[tq + 1], e1z = T[tq + 5] - T[tq + 2];
        const e2x = T[tq + 6] - T[tq], e2y = T[tq + 7] - T[tq + 1], e2z = T[tq + 8] - T[tq + 2];
        const tx = ox - T[tq], ty = oy - T[tq + 1], tz = oz - T[tq + 2];
        const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
        const tnum = e2x * qx + e2y * qy + e2z * qz;
        let m2 = mm;
        while (m2) {
          const bit = m2 & -m2;
          m2 ^= bit;
          const q = (31 - Math.clz32(bit)) * 3;
          const dx = D[q], dy = D[q + 1], dz = D[q + 2];
          const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
          const det = e1x * px + e1y * py + e1z * pz;
          if (det > -1e-30 && det < 1e-30) continue;
          const inv = 1 / det;
          const u = (tx * px + ty * py + tz * pz) * inv;
          if (u < -EDGE_BAND || u > 1 + EDGE_BAND) continue;
          const v = (dx * qx + dy * qy + dz * qz) * inv;
          if (v < -EDGE_BAND || u + v > 1 + EDGE_BAND) continue;
          if ((u < EDGE_BAND || v < EDGE_BAND || u + v > 1 - EDGE_BAND) && !this.bvh.crossesTri(order[i], ox, oy, oz, dx, dy, dz)) continue;
          const t = tnum * inv;
          if (t > 0 && t < tmax) { hit |= bit; mm &= ~bit; }
        }
      }
    }
    return hit;
  }

  /**
   * Nearest hits of a packet of n <= 32 rays from one origin: best[k] = nearest t in (0, tmax) of ray k, or Infinity.
   * Children are visited near-first along the packet's first direction.
   */
  nearestPacket(ox: number, oy: number, oz: number, D: Float64Array, ID: Float64Array, n: number, tmax: number, best: Float64Array): void {
    for (let k = 0; k < n; k++) best[k] = tmax;
    if (!this.empty && n > 0) {
      const T = this.T, b = this.nodes, child = this.child, order = this.order, st = this.stack, ms = this.mstack;
      const ax = D[0], ay = D[1], az = D[2];
      let sp = 0;
      st[sp] = 0; ms[sp++] = n >= 32 ? -1 : (1 << n) - 1;
      while (sp > 0) {
        sp--;
        const nd = st[sp];
        // slab test of the packet's rays against the node, each limited by its own nearest hit so far
        let m = ms[sp], mm = 0;
        const o = nd * 6;
        const x0 = b[o] - ox, y0 = b[o + 1] - oy, z0 = b[o + 2] - oz, x1 = b[o + 3] - ox, y1 = b[o + 4] - oy, z1 = b[o + 5] - oz;
        while (m) {
          const bit = m & -m;
          m ^= bit;
          const k = 31 - Math.clz32(bit), q = k * 3;
          const ix = ID[q], iy = ID[q + 1], iz = ID[q + 2];
          let t0 = x0 * ix, t1 = x1 * ix, s: number;
          if (t0 > t1) { s = t0; t0 = t1; t1 = s; }
          let tn = t0, tf = t1;
          t0 = y0 * iy; t1 = y1 * iy;
          if (t0 > t1) { s = t0; t0 = t1; t1 = s; }
          if (t0 > tn) tn = t0;
          if (t1 < tf) tf = t1;
          t0 = z0 * iz; t1 = z1 * iz;
          if (t0 > t1) { s = t0; t0 = t1; t1 = s; }
          if (t0 > tn) tn = t0;
          if (t1 < tf) tf = t1;
          if (tn <= tf && tf >= 0 && tn < best[k]) mm |= bit;
        }
        if (!mm) continue;
        const c0 = child[nd * 2], c1 = child[nd * 2 + 1];
        if (c0 >= 0) {
          const o0 = c0 * 6, o1 = c1 * 6;
          const d = (b[o1] + b[o1 + 3] - b[o0] - b[o0 + 3]) * ax + (b[o1 + 1] + b[o1 + 4] - b[o0 + 1] - b[o0 + 4]) * ay + (b[o1 + 2] + b[o1 + 5] - b[o0 + 2] - b[o0 + 5]) * az;
          if (d >= 0) { st[sp] = c1; ms[sp++] = mm; st[sp] = c0; ms[sp++] = mm; } else { st[sp] = c0; ms[sp++] = mm; st[sp] = c1; ms[sp++] = mm; }
          continue;
        }
        const s = -1 - c0;
        for (let i = s; i < s + c1; i++) {
          const tq = order[i] * 9;
          const e1x = T[tq + 3] - T[tq], e1y = T[tq + 4] - T[tq + 1], e1z = T[tq + 5] - T[tq + 2];
          const e2x = T[tq + 6] - T[tq], e2y = T[tq + 7] - T[tq + 1], e2z = T[tq + 8] - T[tq + 2];
          const tx = ox - T[tq], ty = oy - T[tq + 1], tz = oz - T[tq + 2];
          const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
          const tnum = e2x * qx + e2y * qy + e2z * qz;
          let m2 = mm;
          while (m2) {
            const bit = m2 & -m2;
            m2 ^= bit;
            const k = 31 - Math.clz32(bit), q = k * 3;
            const dx = D[q], dy = D[q + 1], dz = D[q + 2];
            const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
            const det = e1x * px + e1y * py + e1z * pz;
            if (det > -1e-30 && det < 1e-30) continue;
            const inv = 1 / det;
            const u = (tx * px + ty * py + tz * pz) * inv;
            if (u < -EDGE_BAND || u > 1 + EDGE_BAND) continue;
            const v = (dx * qx + dy * qy + dz * qz) * inv;
            if (v < -EDGE_BAND || u + v > 1 + EDGE_BAND) continue;
            if ((u < EDGE_BAND || v < EDGE_BAND || u + v > 1 - EDGE_BAND) && !this.bvh.crossesTri(order[i], ox, oy, oz, dx, dy, dz)) continue;
            const t = tnum * inv;
            if (t > 0 && t < best[k]) best[k] = t;
          }
        }
      }
    }
    for (let k = 0; k < n; k++) if (!(best[k] < tmax)) best[k] = Infinity;
  }

  /** Inside a closed mesh: majority vote of ray parity along three skewed directions. */
  inside(x: number, y: number, z: number): boolean {
    let votes = 0;
    if (this.countHits(x, y, z, 0.5773, 0.5774, 0.5775) % 2 === 1) votes++;
    if (this.countHits(x, y, z, -0.6123, 0.3536, 0.7071) % 2 === 1) votes++;
    if (votes === 1 && this.countHits(x, y, z, 0.2673, -0.8018, 0.5345) % 2 === 1) votes++;
    return votes >= 2;
  }
}

export type RayMode = 'occlusion' | 'thickness' | 'cavity';

export interface RaySampleOptions {
  mode: RayMode;
  samples: number;
  /** rays only count hits closer than this (thickness: misses count as this distance) */
  maxDistance: number;
  /** ray origin offset along the (inward, for thickness) normal */
  bias: number;
  /** half-angle of the sampling cone in degrees (90 = hemisphere) */
  coneAngle: number;
  seed: number;
}

/**
 * Per-point ray-cast measure. Directions are cosine-weighted inside a cone around N (around -N for thickness),
 * from a Fibonacci lattice shifted per point by a seeded random offset; rays go in packets of 32 (one BVH walk each).
 *  occlusion: fraction of rays hitting within maxDistance (0 = open sky, 1 = enclosed)
 *  cavity:    like occlusion but each hit weighs 1 - t/maxDistance (nearby walls count most)
 *  thickness: mean distance to the first hit along the inward rays (misses count as maxDistance), in metres
 * Points with a zero normal or outside the mask get 0.
 */
export function rayMeasure(
  P: ArrayLike<number>, N: ArrayLike<number>, scene: RayScene, o: RaySampleOptions, mask?: ArrayLike<number> | null,
  /** write into this array instead of a new one (points outside [start, end) are left alone: chunked runs) */
  into?: Float64Array, start = 0, end?: number,
): Float64Array {
  const n = Math.floor(P.length / 3), out = into ?? new Float64Array(n);
  const i0 = Math.max(0, start), i1 = Math.min(n, end ?? n);
  if (scene.empty) {
    if (o.mode === 'thickness') for (let i = i0; i < i1; i++) if (!mask || mask[i]) out[i] = o.maxDistance;
    return out;
  }
  const S = Math.max(1, Math.floor(o.samples));
  const sinA = Math.sin((Math.max(0, Math.min(90, o.coneAngle)) * Math.PI) / 180);
  const seedH = hash32(hashNumber(o.seed) ^ 0x2c1b3c6d);
  const maxD = o.maxDistance > 0 ? o.maxDistance : Infinity;
  const inward = o.mode === 'thickness';
  const D = new Float64Array(96), ID = new Float64Array(96), best = new Float64Array(32);
  // sample pattern: a Fibonacci lattice in the unit square (u1 stratified in S strata, u2 by the golden ratio),
  // shifted per point by a seeded random offset (Cranley-Patterson rotation), mapped cosine-weighted into the cone
  const U1 = new Float64Array(S), U2 = new Float64Array(S);
  for (let s = 0; s < S; s++) { U1[s] = (s + 0.5) / S; U2[s] = (s * 0.6180339887498949) % 1; }
  for (let i = i0; i < i1; i++) {
    if (mask && !mask[i]) continue;
    let nx = N[i * 3], ny = N[i * 3 + 1], nz = N[i * 3 + 2];
    const l = Math.hypot(nx, ny, nz);
    if (!(l > 1e-12)) continue;
    nx /= l; ny /= l; nz /= l;
    if (inward) { nx = -nx; ny = -ny; nz = -nz; }
    // tangent frame
    let tx: number, ty: number, tz: number;
    if (Math.abs(nx) < 0.9) { tx = 0; ty = nz; tz = -ny; } else { tx = -nz; ty = 0; tz = nx; }
    const tl = Math.hypot(tx, ty, tz);
    tx /= tl; ty /= tl; tz /= tl;
    const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
    const ox = P[i * 3] + nx * o.bias, oy = P[i * 3 + 1] + ny * o.bias, oz = P[i * 3 + 2] + nz * o.bias;
    const h1 = hash32(Math.imul(i, 0x9e3779b1) ^ seedH), h2 = hash32(h1 ^ 0x68e31da4);
    const a1 = h1 / 4294967296, a2 = h2 / 4294967296;
    let acc = 0;
    // packets of up to 32 rays share the origin and one BVH walk
    for (let s0 = 0; s0 < S; s0 += 32) {
      const cnt = Math.min(32, S - s0);
      for (let k = 0; k < cnt; k++) {
        let u1 = U1[s0 + k] + a1, u2 = U2[s0 + k] + a2;
        if (u1 >= 1) u1 -= 1;
        if (u2 >= 1) u2 -= 1;
        const st = Math.sqrt(u1) * sinA, ct = Math.sqrt(Math.max(0, 1 - st * st)), phi = 2 * Math.PI * u2;
        const cx = st * Math.cos(phi), cy = st * Math.sin(phi);
        const dx = tx * cx + bx * cy + nx * ct, dy = ty * cx + by * cy + ny * ct, dz = tz * cx + bz * cy + nz * ct;
        D[k * 3] = dx; D[k * 3 + 1] = dy; D[k * 3 + 2] = dz;
        // a zero component would give 0 * Infinity = NaN in the slab test: use a huge finite inverse instead
        ID[k * 3] = 1 / (dx || 1e-300); ID[k * 3 + 1] = 1 / (dy || 1e-300); ID[k * 3 + 2] = 1 / (dz || 1e-300);
      }
      if (o.mode === 'occlusion') {
        let m = scene.occludedPacket(ox, oy, oz, D, ID, cnt, maxD);
        while (m) { acc++; m &= m - 1; }
        continue;
      }
      scene.nearestPacket(ox, oy, oz, D, ID, cnt, maxD, best);
      for (let k = 0; k < cnt; k++) {
        const t = best[k];
        if (o.mode === 'cavity') { if (t < maxD) acc += 1 - t / maxD; }
        else acc += t < maxD ? t + o.bias : o.maxDistance;
      }
    }
    out[i] = acc / S;
  }
  return out;
}

// ---------------------------------------------------------------- closest points

/** Result of a closest-point query (reused, no allocation). */
export interface Nearest {
  dist: number;
  /** prim index in the target (-1 for point-cloud targets) */
  prim: number;
  /** point index for point-cloud targets, else -1 */
  point: number;
  x: number; y: number; z: number;
  /** parametric coordinates on the prim (see SurfaceQuery) */
  u: number; v: number;
}

export function newNearest(): Nearest {
  return { dist: Infinity, prim: -1, point: -1, x: 0, y: 0, z: 0, u: 0, v: 0 };
}

/** BVH over polyline segments: closest point on any segment. */
export class SegmentTree {
  S: Float64Array; // 6 per segment
  segPrim: Int32Array;
  segU0: Float64Array;
  segU1: Float64Array;
  order: Int32Array;
  nodes: Float64Array;
  child: Int32Array;
  nodeCount = 0;
  private stack = new Int32Array(512);

  constructor(g: Geometry) {
    const S: number[] = [], prim: number[] = [], u0: number[] = [], u1: number[] = [];
    const P = g.P, vp = g.vertexPoint;
    for (let p = 0; p < g.numPrims; p++) {
      if (g.primClosed[p]) continue;
      const s = g.primStart[p], e = g.primStart[p + 1], nseg = e - s - 1;
      for (let v = s; v < e - 1; v++) {
        const a = vp[v] * 3, b = vp[v + 1] * 3;
        S.push(P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2]);
        prim.push(p); u0.push((v - s) / nseg); u1.push((v - s + 1) / nseg);
      }
    }
    const n = prim.length;
    this.S = Float64Array.from(S); this.segPrim = Int32Array.from(prim);
    this.segU0 = Float64Array.from(u0); this.segU1 = Float64Array.from(u1);
    this.order = Int32Array.from({ length: n }, (_, i) => i);
    this.nodes = new Float64Array(Math.max(1, n * 2) * 6);
    this.child = new Int32Array(Math.max(1, n * 2) * 2);
    if (n) this.build(0, n);
  }

  get numSegments() { return this.segPrim.length; }

  private build(lo: number, hi: number): number {
    const id = this.nodeCount++, S = this.S, o = this.order, nb = id * 6;
    let mn0 = Infinity, mn1 = Infinity, mn2 = Infinity, mx0 = -Infinity, mx1 = -Infinity, mx2 = -Infinity;
    for (let i = lo; i < hi; i++) {
      const b = o[i] * 6;
      for (let k = 0; k < 6; k += 3) {
        const x = S[b + k], y = S[b + k + 1], z = S[b + k + 2];
        if (x < mn0) mn0 = x; if (x > mx0) mx0 = x;
        if (y < mn1) mn1 = y; if (y > mx1) mx1 = y;
        if (z < mn2) mn2 = z; if (z > mx2) mx2 = z;
      }
    }
    const nd = this.nodes;
    nd[nb] = mn0; nd[nb + 1] = mn1; nd[nb + 2] = mn2; nd[nb + 3] = mx0; nd[nb + 4] = mx1; nd[nb + 5] = mx2;
    if (hi - lo <= 4) { this.child[id * 2] = -1 - lo; this.child[id * 2 + 1] = hi - lo; return id; }
    const ex = [mx0 - mn0, mx1 - mn1, mx2 - mn2];
    const ax = ex[0] >= ex[1] && ex[0] >= ex[2] ? 0 : ex[1] >= ex[2] ? 1 : 2;
    const cen = (i: number) => S[i * 6 + ax] + S[i * 6 + 3 + ax];
    const sub = Array.from(o.subarray(lo, hi)).sort((a, b) => cen(a) - cen(b));
    o.set(sub, lo);
    const mid = (lo + hi) >> 1;
    const l = this.build(lo, mid), r = this.build(mid, hi);
    this.child[id * 2] = l; this.child[id * 2 + 1] = r;
    return id;
  }

  private boxDist2(n: number, x: number, y: number, z: number) {
    const b = this.nodes, i = n * 6;
    const dx = Math.max(b[i] - x, 0, x - b[i + 3]), dy = Math.max(b[i + 1] - y, 0, y - b[i + 4]), dz = Math.max(b[i + 2] - z, 0, z - b[i + 5]);
    return dx * dx + dy * dy + dz * dz;
  }

  /** Closest point within maxDist; fills out (prim, u along the polyline 0..1) and returns true when found. */
  closest(x: number, y: number, z: number, maxDist: number, out: Nearest): boolean {
    if (!this.numSegments) return false;
    let best2 = maxDist === Infinity ? Infinity : maxDist * maxDist, bestSeg = -1, bestT = 0;
    const S = this.S, st = this.stack, child = this.child, order = this.order;
    let sp = 0;
    st[sp++] = 0;
    while (sp > 0) {
      const n = st[--sp];
      if (this.boxDist2(n, x, y, z) >= best2) continue;
      const c0 = child[n * 2], c1 = child[n * 2 + 1];
      if (c0 < 0) {
        const s = -1 - c0;
        for (let i = s; i < s + c1; i++) {
          const sg = order[i], o = sg * 6;
          const ax = S[o], ay = S[o + 1], az = S[o + 2];
          const dx = S[o + 3] - ax, dy = S[o + 4] - ay, dz = S[o + 5] - az;
          const l2 = dx * dx + dy * dy + dz * dz;
          let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy + (z - az) * dz) / l2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const px = ax + dx * t - x, py = ay + dy * t - y, pz = az + dz * t - z;
          const d2 = px * px + py * py + pz * pz;
          if (d2 < best2) { best2 = d2; bestSeg = sg; bestT = t; }
        }
      } else {
        const d0 = this.boxDist2(c0, x, y, z), d1 = this.boxDist2(c1, x, y, z);
        if (d0 < d1) { st[sp++] = c1; st[sp++] = c0; } else { st[sp++] = c0; st[sp++] = c1; }
      }
    }
    if (bestSeg < 0) return false;
    const o = bestSeg * 6;
    out.dist = Math.sqrt(best2); out.prim = this.segPrim[bestSeg]; out.point = -1;
    out.x = S[o] + (S[o + 3] - S[o]) * bestT; out.y = S[o + 1] + (S[o + 4] - S[o + 1]) * bestT; out.z = S[o + 2] + (S[o + 5] - S[o + 2]) * bestT;
    out.u = this.segU0[bestSeg] + (this.segU1[bestSeg] - this.segU0[bestSeg]) * bestT; out.v = 0;
    return true;
  }
}

/**
 * Closest-point queries against a geometry: polygons through a TriBVH, polylines through a SegmentTree,
 * and (when the geometry has no prims at all) its points through a KD-tree. Loose points of geometry that
 * has prims are ignored. Prim uv: triangles (1-u-v)·p0 + u·p1 + v·p2 (Houdini primuv), quads bilinear with
 * corners (0,0) (1,0) (1,1) (0,1), other polygons a polar layout of their corners, polylines u = 0..1 by vertex.
 */
export class SurfaceQuery {
  bvh: TriBVH | null = null;
  rays: RayScene | null = null;
  segs: SegmentTree | null = null;
  kd: KDTree | null = null;
  hasPolygons = false;
  hasCurves = false;
  hasPoints = false;
  /** per triangle: the prim uv of its three corners (6 numbers) */
  private triUV: Float64Array | null = null;
  private tmp = newNearest();

  constructor(g: Geometry) {
    let polys = 0, lines = 0;
    for (let p = 0; p < g.numPrims; p++) if (g.primClosed[p]) { if (g.primSize(p) >= 3) polys++; } else if (g.primSize(p) >= 2) lines++;
    if (polys) {
      const bvh = new TriBVH(g);
      if (bvh.numTris) {
        this.bvh = bvh;
        this.hasPolygons = true;
        this.rays = new RayScene(bvh);
        const nt = bvh.numTris, uv = (this.triUV = new Float64Array(nt * 6));
        for (let t = 0; t < nt; t++) {
          const prim = bvh.triPrim[t], s = g.primStart[prim], n = g.primStart[prim + 1] - s;
          for (let k = 0; k < 3; k++) {
            const c = bvh.triVtx[t * 3 + k] - s;
            let u: number, v: number;
            if (n === 3) { u = c === 1 ? 1 : 0; v = c === 2 ? 1 : 0; }
            else if (n === 4) { u = c === 1 || c === 2 ? 1 : 0; v = c >= 2 ? 1 : 0; }
            else { const a = (2 * Math.PI * c) / n; u = 0.5 + 0.5 * Math.cos(a); v = 0.5 + 0.5 * Math.sin(a); }
            uv[t * 6 + k * 2] = u; uv[t * 6 + k * 2 + 1] = v;
          }
        }
      }
    }
    if (lines) { this.segs = new SegmentTree(g); this.hasCurves = this.segs.numSegments > 0; }
    if (!g.numPrims && g.numPoints) { this.kd = new KDTree(g.P); this.hasPoints = true; }
  }

  get empty() { return !this.hasPolygons && !this.hasCurves && !this.hasPoints; }

  /** What the query measures against, for messages. */
  get kind(): string {
    const k = [this.hasPolygons && 'surface', this.hasCurves && 'curves', this.hasPoints && 'points'].filter(Boolean);
    return k.length ? k.join(' + ') : 'nothing';
  }

  /** Closest point within maxDist (Infinity = unlimited). Returns false when nothing is that close. */
  nearest(x: number, y: number, z: number, maxDist: number, out: Nearest): boolean {
    let found = false, lim = maxDist;
    if (this.bvh) {
      const h = this.bvh.closest(x, y, z, lim);
      if (h) {
        const uv = this.triUV!, o = h.tri * 6, b = h.bary;
        out.dist = h.dist; out.prim = h.prim; out.point = -1;
        out.x = h.pos[0]; out.y = h.pos[1]; out.z = h.pos[2];
        out.u = b[0] * uv[o] + b[1] * uv[o + 2] + b[2] * uv[o + 4];
        out.v = b[0] * uv[o + 1] + b[1] * uv[o + 3] + b[2] * uv[o + 5];
        found = true; lim = h.dist;
      }
    }
    if (this.segs && this.segs.closest(x, y, z, lim, this.tmp) && (!found || this.tmp.dist < out.dist)) {
      Object.assign(out, this.tmp);
      found = true; lim = out.dist;
    }
    if (this.kd) {
      const r = this.kd.nearest(x, y, z, lim);
      if (r.index >= 0 && (!found || r.dist < out.dist)) {
        const P = this.kd.P;
        out.dist = r.dist; out.prim = -1; out.point = r.index;
        out.x = P[r.index * 3]; out.y = P[r.index * 3 + 1]; out.z = P[r.index * 3 + 2]; out.u = 0; out.v = 0;
        found = true;
      }
    }
    return found;
  }

  /** Inside the closed polygon surface (ray parity vote); false without polygons. */
  inside(x: number, y: number, z: number): boolean {
    return this.rays ? this.rays.inside(x, y, z) : false;
  }
}

// ---------------------------------------------------------------- sampling and distances

export interface SurfaceSamples {
  /** positions, 3 per sample */
  P: Float64Array;
  /** unit face normals (polygon samples) or 0 (curve and point samples) */
  N: Float64Array;
  /** source prim (-1 for point samples) */
  prim: Int32Array;
}

/**
 * Seeded samples of a geometry: area-weighted on its polygons, length-weighted on its polylines, and its points
 * when it has no prims. With includePoints, the points used by prims (strided down to at most count) are added too.
 */
export function sampleSurface(g: Geometry, count: number, seed = 0, includePoints = false): SurfaceSamples {
  const P = g.P, vp = g.vertexPoint;
  const outP: number[] = [], outN: number[] = [], outPrim: number[] = [];
  const seedH = hashNumber(seed);
  const r = (k: number) => hash32(hash32(Math.imul(k, 0x9e3779b1)) ^ seedH) / 4294967296;
  let rk = 1;
  if (!g.numPrims) {
    const n = g.numPoints, step = Math.max(1, n / Math.max(1, count));
    for (let f = 0; f < n; f += step) { const i = Math.floor(f) * 3; outP.push(P[i], P[i + 1], P[i + 2]); outN.push(0, 0, 0); outPrim.push(-1); }
    return { P: Float64Array.from(outP), N: Float64Array.from(outN), prim: Int32Array.from(outPrim) };
  }
  const { tris, triPrim } = triangulate(g);
  const nt = tris.length / 3;
  const segs: number[] = [], segPrim: number[] = [];
  for (let p = 0; p < g.numPrims; p++) {
    if (g.primClosed[p]) continue;
    for (let v = g.primStart[p]; v < g.primStart[p + 1] - 1; v++) { segs.push(vp[v], vp[v + 1]); segPrim.push(p); }
  }
  const triA = new Float64Array(nt), segL = new Float64Array(segPrim.length);
  let areaSum = 0, lenSum = 0;
  for (let t = 0; t < nt; t++) {
    const a = vp[tris[t * 3]] * 3, b = vp[tris[t * 3 + 1]] * 3, c = vp[tris[t * 3 + 2]] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const wx = P[c] - P[a], wy = P[c + 1] - P[a + 1], wz = P[c + 2] - P[a + 2];
    triA[t] = Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) / 2;
    areaSum += triA[t];
  }
  for (let s = 0; s < segPrim.length; s++) {
    const a = segs[s * 2] * 3, b = segs[s * 2 + 1] * 3;
    segL[s] = Math.hypot(P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]);
    lenSum += segL[s];
  }
  const nTri = areaSum > 0 ? (lenSum > 0 ? Math.ceil(count * 0.7) : count) : 0;
  const nSeg = lenSum > 0 ? count - nTri : 0;
  const pickCdf = (w: Float64Array, total: number, n: number, emit: (i: number) => void) => {
    const cdf = new Float64Array(w.length);
    let acc = 0;
    for (let i = 0; i < w.length; i++) { acc += w[i]; cdf[i] = acc; }
    for (let k = 0; k < n; k++) {
      const x = ((k + r(rk++)) / n) * total; // stratified along the cdf
      let lo = 0, hi = w.length - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (cdf[m] < x) lo = m + 1; else hi = m; }
      emit(lo);
    }
  };
  if (nTri) pickCdf(triA, areaSum, nTri, (t) => {
    const a = vp[tris[t * 3]] * 3, b = vp[tris[t * 3 + 1]] * 3, c = vp[tris[t * 3 + 2]] * 3;
    let s1 = r(rk++), s2 = r(rk++);
    if (s1 + s2 > 1) { s1 = 1 - s1; s2 = 1 - s2; }
    for (let k = 0; k < 3; k++) outP.push(P[a + k] + (P[b + k] - P[a + k]) * s1 + (P[c + k] - P[a + k]) * s2);
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const wx = P[c] - P[a], wy = P[c + 1] - P[a + 1], wz = P[c + 2] - P[a + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx, l = Math.hypot(nx, ny, nz) || 1;
    outN.push(nx / l, ny / l, nz / l);
    outPrim.push(triPrim[t]);
  });
  if (nSeg) pickCdf(segL, lenSum, nSeg, (s) => {
    const a = segs[s * 2] * 3, b = segs[s * 2 + 1] * 3, t = r(rk++);
    for (let k = 0; k < 3; k++) outP.push(P[a + k] + (P[b + k] - P[a + k]) * t);
    outN.push(0, 0, 0); outPrim.push(segPrim[s]);
  });
  if (includePoints) {
    const used = new Uint8Array(g.numPoints);
    for (let v = 0; v < g.numVertices; v++) used[vp[v]] = 1;
    const ids: number[] = [];
    for (let i = 0; i < g.numPoints; i++) if (used[i]) ids.push(i);
    const step = Math.max(1, ids.length / Math.max(1, count));
    for (let f = 0; f < ids.length; f += step) { const i = ids[Math.floor(f)] * 3; outP.push(P[i], P[i + 1], P[i + 2]); outN.push(0, 0, 0); outPrim.push(-1); }
  }
  return { P: Float64Array.from(outP), N: Float64Array.from(outN), prim: Int32Array.from(outPrim) };
}

export interface DirectedDistance {
  /** largest sample distance (directed Hausdorff) */
  max: number;
  mean: number;
  /** sample position with the largest distance */
  at: Vec3;
  count: number;
}

/** Distances from sample positions to a SurfaceQuery target. */
export function directedDistance(samples: ArrayLike<number>, target: SurfaceQuery): DirectedDistance {
  const n = Math.floor(samples.length / 3), out = newNearest();
  let max = 0, sum = 0, at: Vec3 = [0, 0, 0], cnt = 0;
  for (let i = 0; i < n; i++) {
    const x = samples[i * 3], y = samples[i * 3 + 1], z = samples[i * 3 + 2];
    if (!target.nearest(x, y, z, Infinity, out)) continue;
    cnt++;
    sum += out.dist;
    if (out.dist > max) { max = out.dist; at = [x, y, z]; }
  }
  return { max: cnt ? max : Infinity, mean: cnt ? sum / cnt : Infinity, at, count: cnt };
}

// ---------------------------------------------------------------- mesh checks

export interface SelfIntersectionResult {
  /** intersecting triangle pairs found */
  pairs: number;
  /** prims that take part in an intersection */
  prims: Uint8Array;
  /** candidate pairs tested (bbox overlaps of non-adjacent triangles) */
  tested: number;
  /** the search stopped at maxTests: more intersections may exist */
  capped: boolean;
}

/**
 * Pairs of non-adjacent triangles (no shared point) that cross each other: an edge of one passes through the
 * interior of the other. Coplanar overlaps and touching configurations are not reported. The BVH limits the
 * candidates; the search stops after maxTests candidate pairs.
 * strict: every pair that meets beyond what it shares (core/tritri.ts): crossings, touching contacts, coplanar
 * overlaps, and triangles with a shared corner or edge that fold through or onto each other. Used by solidify.
 */
export function selfIntersections(g: Geometry, maxTests = 2_000_000, opts: { strict?: boolean } = {}): SelfIntersectionResult {
  const strict = !!opts.strict;
  const prims = new Uint8Array(g.numPrims);
  const bvh = new TriBVH(g);
  const nt = bvh.numTris, T = bvh.T, vp = g.vertexPoint, tv = bvh.triVtx;
  const nodes = bvh.nodes, child = bvh.child, order = bvh.order;
  const stack = new Int32Array(512);
  let pairs = 0, tested = 0, capped = false;
  const pad = bboxDiagonal(g) * 1e-9, eps = 1e-9;
  outer: for (let i = 0; i < nt; i++) {
    const o = i * 9;
    const mnx = Math.min(T[o], T[o + 3], T[o + 6]) - pad, mxx = Math.max(T[o], T[o + 3], T[o + 6]) + pad;
    const mny = Math.min(T[o + 1], T[o + 4], T[o + 7]) - pad, mxy = Math.max(T[o + 1], T[o + 4], T[o + 7]) + pad;
    const mnz = Math.min(T[o + 2], T[o + 5], T[o + 8]) - pad, mxz = Math.max(T[o + 2], T[o + 5], T[o + 8]) + pad;
    const a0 = vp[tv[i * 3]], a1 = vp[tv[i * 3 + 1]], a2 = vp[tv[i * 3 + 2]];
    let sp = 0;
    stack[sp++] = 0;
    while (sp > 0) {
      const n = stack[--sp], b = n * 6;
      if (nodes[b] > mxx || nodes[b + 3] < mnx || nodes[b + 1] > mxy || nodes[b + 4] < mny || nodes[b + 2] > mxz || nodes[b + 5] < mnz) continue;
      const c0 = child[n * 2], c1 = child[n * 2 + 1];
      if (c0 >= 0) { stack[sp++] = c0; stack[sp++] = c1; continue; }
      const s = -1 - c0;
      for (let k = s; k < s + c1; k++) {
        const j = order[k];
        if (j <= i) continue;
        const b0 = vp[tv[j * 3]], b1 = vp[tv[j * 3 + 1]], b2 = vp[tv[j * 3 + 2]];
        const shared = (b0 === a0 || b0 === a1 || b0 === a2 ? 1 : 0) + (b1 === a0 || b1 === a1 || b1 === a2 ? 1 : 0) + (b2 === a0 || b2 === a1 || b2 === a2 ? 1 : 0);
        if (shared && !strict) continue;
        const q = j * 9;
        if (Math.min(T[q], T[q + 3], T[q + 6]) > mxx || Math.max(T[q], T[q + 3], T[q + 6]) < mnx ||
            Math.min(T[q + 1], T[q + 4], T[q + 7]) > mxy || Math.max(T[q + 1], T[q + 4], T[q + 7]) < mny ||
            Math.min(T[q + 2], T[q + 5], T[q + 8]) > mxz || Math.max(T[q + 2], T[q + 5], T[q + 8]) < mnz) continue;
        if (tested >= maxTests) { capped = true; break outer; }
        tested++;
        if (strict ? trianglesContact(T, o, q, Math.min(shared, 2), pad) || shared === 3 : trianglesCross(T, o, q, eps)) {
          pairs++;
          prims[bvh.triPrim[i]] = 1; prims[bvh.triPrim[j]] = 1;
        }
      }
    }
  }
  return { pairs, prims, tested, capped };
}

/** An edge of triangle A (offset a in T) crosses the interior of triangle B (offset b), or vice versa. */
function trianglesCross(T: Float64Array, a: number, b: number, eps: number): boolean {
  for (let k = 0; k < 3; k++) {
    const p = a + k * 3, q = a + ((k + 1) % 3) * 3;
    if (segmentCrossesTri(T, T[p], T[p + 1], T[p + 2], T[q], T[q + 1], T[q + 2], b, eps)) return true;
  }
  for (let k = 0; k < 3; k++) {
    const p = b + k * 3, q = b + ((k + 1) % 3) * 3;
    if (segmentCrossesTri(T, T[p], T[p + 1], T[p + 2], T[q], T[q + 1], T[q + 2], a, eps)) return true;
  }
  return false;
}

function segmentCrossesTri(T: Float64Array, ax: number, ay: number, az: number, bx: number, by: number, bz: number, o: number, eps: number): boolean {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const e1x = T[o + 3] - T[o], e1y = T[o + 4] - T[o + 1], e1z = T[o + 5] - T[o + 2];
  const e2x = T[o + 6] - T[o], e2y = T[o + 7] - T[o + 1], e2z = T[o + 8] - T[o + 2];
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  // parallel or coplanar segment: not a crossing
  const scale = Math.hypot(dx, dy, dz) * Math.hypot(e1x, e1y, e1z) * Math.hypot(e2x, e2y, e2z);
  if (!(Math.abs(det) > 1e-9 * scale)) return false;
  const inv = 1 / det;
  const tx = ax - T[o], ty = ay - T[o + 1], tz = az - T[o + 2];
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u <= eps || u >= 1 - eps) return false;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v <= eps || u + v >= 1 - eps) return false;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return t > eps && t < 1 - eps;
}

/** Points that have another point within tol (both are marked). */
export function duplicatePoints(g: Geometry, tol: number): { count: number; mask: Uint8Array } {
  const n = g.numPoints, mask = new Uint8Array(n);
  if (n < 2) return { count: 0, mask };
  // grid of cells at least tol wide (and at most 1e5 per axis, so cell keys are exact integers): a point within
  // tol of another lies in the same or a neighbouring cell
  const P = g.P, t = Math.max(0, tol), t2 = t * t, b = g.bbox();
  const R = 100000, ext = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
  const cell = Math.max(t, ext / R, 1e-300), M = R + 3;
  const key = (x: number, y: number, z: number) => (x * M + y) * M + z;
  const head = new Map<number, number>(), next = new Int32Array(n).fill(-1);
  const cx = new Int32Array(n), cy = new Int32Array(n), cz = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    cx[i] = 1 + Math.floor((P[i * 3] - b.min[0]) / cell); cy[i] = 1 + Math.floor((P[i * 3 + 1] - b.min[1]) / cell); cz[i] = 1 + Math.floor((P[i * 3 + 2] - b.min[2]) / cell);
    const k = key(cx[i], cy[i], cz[i]);
    const h = head.get(k);
    if (h !== undefined) next[i] = h;
    head.set(k, i);
  }
  for (let i = 0; i < n; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (let j = head.get(key(cx[i] + dx, cy[i] + dy, cz[i] + dz)) ?? -1; j >= 0; j = next[j]) {
        if (j <= i) break; // chains run from the highest index down
        const ex = P[j * 3] - x, ey = P[j * 3 + 1] - y, ez = P[j * 3 + 2] - z;
        if (ex * ex + ey * ey + ez * ez <= t2) { mask[i] = 1; mask[j] = 1; }
      }
    }
  }
  let count = 0;
  for (let i = 0; i < n; i++) count += mask[i];
  return { count, mask };
}

/** Unique prim edges shorter than minLen (polyline segments included), the shortest length, and the prims using them. */
export function shortEdges(g: Geometry, minLen: number): { count: number; shortest: number; prims: Uint8Array } {
  const E = buildEdges(g), P = g.P, prims = new Uint8Array(g.numPrims);
  let count = 0, shortest = Infinity;
  for (let e = 0; e < E.a.length; e++) {
    const a = E.a[e] * 3, b = E.b[e] * 3;
    const l = Math.hypot(P[a] - P[b], P[a + 1] - P[b + 1], P[a + 2] - P[b + 2]);
    if (l < shortest) shortest = l;
    if (l < minLen) {
      count++;
      prims[E.firstPrim[e]] = 1;
      if (E.secondPrim[e] >= 0) prims[E.secondPrim[e]] = 1;
    }
  }
  // zero-length sides (a point repeated consecutively) are skipped by buildEdges
  for (let p = 0; p < g.numPrims; p++) {
    const s = g.primStart[p], e = g.primStart[p + 1], last = g.primClosed[p] ? e : e - 1;
    for (let v = s; v < last; v++) {
      if (g.vertexPoint[v] !== g.vertexPoint[v + 1 < e ? v + 1 : s]) continue;
      shortest = 0;
      if (minLen > 0) { prims[p] = 1; count++; }
    }
  }
  return { count, shortest, prims };
}

// ---------------------------------------------------------------- pieces and shape descriptors

export interface PieceInfo {
  polys: number;
  lines: number;
  points: number;
  /** polygon edges used by exactly one polygon */
  boundaryEdges: number;
  /** polygon edges used by more than two polygons */
  nonManifoldEdges: number;
  boundaryLoops: number;
  /** polygons only: V - E + F */
  euler: number;
  /** (2 - euler - boundaryLoops) / 2 (meaningful for orientable manifold pieces) */
  genus: number;
  closed: boolean;
  area: number;
  /** signed volume of closed pieces (negative = faces point inward), 0 for open pieces */
  volume: number;
  /** an inward-facing closed piece inside the bbox of a larger outward-facing one: the wall of a cavity (correct, not flipped) */
  cavity: boolean;
  min: Vec3;
  max: Vec3;
}

export interface PieceReport {
  pieces: PieceInfo[];
  /** piece index per prim (-1 for empty prims) */
  primPiece: Int32Array;
  /** points not used by any prim */
  loosePoints: number;
  /** polygon edges whose two polygons are wound inconsistently */
  flippedEdges: number;
  /** prims on such edges */
  flippedPrims: Uint8Array;
}

/** Connected pieces (over shared points) of the prims of g, with topology, area, volume and bbox per piece. */
export function pieceReport(g: Geometry): PieceReport {
  const conn = connectivity(g);
  const P = g.P, vp = g.vertexPoint;
  // components that hold prims, renumbered in order of their first prim
  const remap = new Int32Array(conn.count).fill(-1);
  const primPiece = new Int32Array(g.numPrims).fill(-1);
  const pieces: PieceInfo[] = [];
  const mk = (): PieceInfo => ({ polys: 0, lines: 0, points: 0, boundaryEdges: 0, nonManifoldEdges: 0, boundaryLoops: 0, euler: 0, genus: 0, closed: false, area: 0, volume: 0, cavity: false, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
  for (let p = 0; p < g.numPrims; p++) {
    const c = conn.primClass[p];
    if (c < 0) continue;
    if (remap[c] < 0) { remap[c] = pieces.length; pieces.push(mk()); }
    const k = remap[c];
    primPiece[p] = k;
    if (g.primClosed[p]) pieces[k].polys++; else pieces[k].lines++;
  }
  const used = new Uint8Array(g.numPoints), polyPt = new Uint8Array(g.numPoints);
  for (let p = 0; p < g.numPrims; p++) for (let v = g.primStart[p]; v < g.primStart[p + 1]; v++) { used[vp[v]] = 1; if (g.primClosed[p]) polyPt[vp[v]] = 1; }
  let loosePoints = 0;
  const V = new Int32Array(pieces.length);
  for (let i = 0; i < g.numPoints; i++) {
    if (!used[i]) { loosePoints++; continue; }
    const k = remap[conn.ptClass[i]];
    if (k < 0) continue;
    const pc = pieces[k];
    pc.points++;
    if (polyPt[i]) V[k]++;
    for (let a = 0; a < 3; a++) { const x = P[i * 3 + a]; if (x < pc.min[a]) pc.min[a] = x; if (x > pc.max[a]) pc.max[a] = x; }
  }
  // polygon edges
  const E = buildEdges(g), Ecount = new Int32Array(pieces.length);
  for (let e = 0; e < E.a.length; e++) {
    const p = E.firstPrim[e];
    if (!g.primClosed[p]) continue;
    const k = primPiece[p];
    if (k < 0) continue;
    Ecount[k]++;
    if (E.count[e] === 1) pieces[k].boundaryEdges++;
    else if (E.count[e] > 2) pieces[k].nonManifoldEdges++;
  }
  const he = halfEdges(g);
  for (const loop of he.boundaryLoops()) {
    const k = remap[conn.ptClass[loop[0]]];
    if (k >= 0) pieces[k].boundaryLoops++;
  }
  const flippedPrims = new Uint8Array(g.numPrims);
  for (const e of he.flippedEdges) for (const f of he.edgeFaces(e)) flippedPrims[f] = 1;
  // area and signed volume
  const { tris, triPrim } = triangulate(g);
  for (let t = 0; t < tris.length; t += 3) {
    const k = primPiece[triPrim[t / 3]];
    if (k < 0) continue;
    const a = vp[tris[t]] * 3, b = vp[tris[t + 1]] * 3, c = vp[tris[t + 2]] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const wx = P[c] - P[a], wy = P[c + 1] - P[a + 1], wz = P[c + 2] - P[a + 2];
    pieces[k].area += Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) / 2;
    pieces[k].volume += (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6;
  }
  pieces.forEach((pc, k) => {
    pc.closed = pc.polys > 0 && pc.lines === 0 && pc.boundaryEdges === 0 && pc.nonManifoldEdges === 0;
    pc.euler = V[k] - Ecount[k] + pc.polys;
    pc.genus = pc.polys ? Math.max(0, Math.round((2 - pc.euler - pc.boundaryLoops) / 2)) : 0;
    if (!pc.closed) pc.volume = 0;
  });
  // cavities: inward-facing closed pieces enclosed by the bbox of a bigger outward-facing closed piece
  const outward = pieces.filter((x) => x.closed && x.volume > 0);
  for (const pc of pieces) {
    if (!pc.closed || !(pc.volume < 0)) continue;
    pc.cavity = outward.some((o) => o.volume > -pc.volume && [0, 1, 2].every((i) => o.min[i] <= pc.min[i] && o.max[i] >= pc.max[i]));
  }
  return { pieces, primPiece, loosePoints, flippedEdges: he.flippedEdges.size, flippedPrims };
}

/** Eigen decomposition of a symmetric 3×3 matrix (row-major, 9 numbers) by Jacobi rotations, largest value first. */
export function symmetricEigen3(m: ArrayLike<number>): { values: number[]; vectors: Vec3[] } {
  const a = Array.from(m) as number[];
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = a[1] * a[1] + a[2] * a[2] + a[5] * a[5];
    if (off <= 1e-30 * (a[0] * a[0] + a[4] * a[4] + a[8] * a[8]) || off === 0) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      const apq = a[p * 3 + q];
      if (apq === 0) continue;
      const theta = (a[q * 3 + q] - a[p * 3 + p]) / (2 * apq);
      const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) { // A·J
        const akp = a[k * 3 + p], akq = a[k * 3 + q];
        a[k * 3 + p] = c * akp - s * akq; a[k * 3 + q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) { // Jᵀ·A
        const apk = a[p * 3 + k], aqk = a[q * 3 + k];
        a[p * 3 + k] = c * apk - s * aqk; a[q * 3 + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k * 3 + p], vkq = v[k * 3 + q];
        v[k * 3 + p] = c * vkp - s * vkq; v[k * 3 + q] = s * vkp + c * vkq;
      }
    }
  }
  const idx = [0, 1, 2].sort((i, j) => a[j * 3 + j] - a[i * 3 + i]);
  return { values: idx.map((i) => a[i * 3 + i]), vectors: idx.map((i) => [v[i], v[3 + i], v[6 + i]] as Vec3) };
}

export interface PrincipalAxes {
  center: Vec3;
  /** unit axes, sorted by extent (largest first) */
  axes: Vec3[];
  /** extent of the points along each axis */
  extents: number[];
}

/** PCA of the surface (area-weighted second moments of the triangles), or of the points without polygons. */
export function principalAxes(g: Geometry): PrincipalAxes {
  const P = g.P, vp = g.vertexPoint;
  const M = new Float64Array(9), mu = [0, 0, 0];
  let W = 0;
  const tris = g.numPrims ? triangulate(g).tris : new Uint32Array(0);
  for (let t = 0; t < tris.length; t += 3) {
    const a = vp[tris[t]] * 3, b = vp[tris[t + 1]] * 3, c = vp[tris[t + 2]] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const wx = P[c] - P[a], wy = P[c + 1] - P[a + 1], wz = P[c + 2] - P[a + 2];
    const A = Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) / 2;
    if (!(A > 0)) continue;
    const s = [P[a] + P[b] + P[c], P[a + 1] + P[b + 1] + P[c + 1], P[a + 2] + P[b + 2] + P[c + 2]];
    for (let i = 0; i < 3; i++) {
      mu[i] += (A * s[i]) / 3;
      for (let j = 0; j < 3; j++) M[i * 3 + j] += (A * (P[a + i] * P[a + j] + P[b + i] * P[b + j] + P[c + i] * P[c + j] + s[i] * s[j])) / 12;
    }
    W += A;
  }
  if (!(W > 0)) {
    M.fill(0); mu.fill(0);
    const n = g.numPoints;
    for (let k = 0; k < n; k++) for (let i = 0; i < 3; i++) {
      mu[i] += P[k * 3 + i];
      for (let j = 0; j < 3; j++) M[i * 3 + j] += P[k * 3 + i] * P[k * 3 + j];
    }
    W = n;
  }
  if (!(W > 0)) return { center: [0, 0, 0], axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], extents: [0, 0, 0] };
  const c: Vec3 = [mu[0] / W, mu[1] / W, mu[2] / W];
  const C = new Float64Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i * 3 + j] = M[i * 3 + j] / W - c[i] * c[j];
  const { vectors } = symmetricEigen3(C);
  const step = Math.max(1, Math.floor(g.numPoints / 200000));
  const ext = vectors.map((ax) => {
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < g.numPoints; k += step) {
      const d = P[k * 3] * ax[0] + P[k * 3 + 1] * ax[1] + P[k * 3 + 2] * ax[2];
      if (d < lo) lo = d; if (d > hi) hi = d;
    }
    return hi > lo ? hi - lo : 0;
  });
  const idx = [0, 1, 2].sort((i, j) => ext[j] - ext[i]);
  return { center: c, axes: idx.map((i) => vectors[i]), extents: idx.map((i) => ext[i]) };
}

export interface MirrorResult {
  axis: 'x' | 'y' | 'z';
  /** plane position (bbox centre along the axis) */
  at: number;
  /** largest distance of a mirrored sample from the geometry (search stops early once far beyond the tolerance) */
  maxDeviation: number;
  /** maxDeviation <= tolerance */
  symmetric: boolean;
}

/**
 * Mirror symmetry about the planes through the bbox centre perpendicular to x, y and z: samples of the
 * geometry are mirrored and their distance to the geometry measured (surface for meshes, KD-tree for points).
 */
export function mirrorSymmetry(g: Geometry, query: SurfaceQuery, samples: SurfaceSamples, tolerance: number): MirrorResult[] {
  const b = g.bbox(), out = newNearest(), S = samples.P, n = S.length / 3;
  const q = [0, 0, 0];
  return (['x', 'y', 'z'] as const).map((axis, a) => {
    const at = (b.min[a] + b.max[a]) / 2;
    let maxDev = 0;
    for (let i = 0; i < n; i++) {
      q[0] = S[i * 3]; q[1] = S[i * 3 + 1]; q[2] = S[i * 3 + 2];
      q[a] = 2 * at - q[a];
      if (!query.nearest(q[0], q[1], q[2], Infinity, out)) { maxDev = Infinity; break; }
      if (out.dist > maxDev) { maxDev = out.dist; if (maxDev > tolerance * 100) break; }
    }
    return { axis, at, maxDeviation: maxDev, symmetric: maxDev <= tolerance };
  });
}
