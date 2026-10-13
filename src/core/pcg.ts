// PCG kernels (procedural content generation: scattering, masks, instancing helpers), used by src/nodes/pcg.ts and by
// scatter v2 in src/nodes/copy.ts. Typed arrays in and out, no host APIs, deterministic for a seed.
//
//  PointGrid             hashed uniform grid for incremental radius queries (points are inserted as they are kept)
//  minDistanceSelect     greedy dart throwing over a candidate order: no two kept points closer than r (exact)
//  sphereOverlapPrune    greedy keep in priority order: no two kept spheres (centre, radius) overlap (exact)
//  relaxPoints           repulsion relaxation (Lloyd-style point relax) with a projection callback (onto a surface)
//  kmeans, radiusClusters
//  band, combineMask     0..1 masks from a feature value and their combination with an existing mask
//  sampleImage           bilinear / nearest lookups in a decoded image with repeat / clamp / mirror wrapping
//  frameQuat             instance frame (Houdini copy convention: +Z = N, +Y = up) as a quaternion
import { AttribTable, Geometry } from './geometry.ts';
import { KDTree, TriBVH, closestScratch } from './spatial.ts';
import type { ClosestScratch, TriBVHArrays } from './spatial.ts';
import { hash32, hashNumber, rng } from './random.ts';
import type { Quat, Vec3 } from './math.ts';

// ---------------------------------------------------------------- closest points on a triangle list

/** Result of TriSurface.closest (reused, no allocation). */
export interface TriPoint { x: number; y: number; z: number; b0: number; b1: number; b2: number }

/**
 * Closest-point queries on a list of triangles of g (3 vertex indices each, as triangulate() returns them), e.g. the
 * selected part of a surface. Returns the triangle index into that list and its barycentrics (corner order of the list).
 */
export class TriSurface {
  private bvh: TriBVH;
  private C: Float64Array;
  readonly numTris: number;

  constructor(g: Geometry, tris: ArrayLike<number>) {
    const nt = Math.floor(tris.length / 3);
    this.numTris = nt;
    const tg = new Geometry({ positions: g.P });
    tg.primStart = Int32Array.from({ length: nt + 1 }, (_, i) => i * 3);
    tg.vertexPoint = Int32Array.from({ length: nt * 3 }, (_, k) => g.vertexPoint[tris[k]]);
    tg.primClosed = new Uint8Array(nt).fill(1);
    tg.vertices = new AttribTable(nt * 3);
    tg.prims = new AttribTable(nt);
    this.bvh = new TriBVH(tg);
    const P = g.P, C = (this.C = new Float64Array(nt * 9));
    for (let k = 0; k < nt * 3; k++) {
      const p = g.vertexPoint[tris[k]] * 3;
      C[k * 3] = P[p]; C[k * 3 + 1] = P[p + 1]; C[k * 3 + 2] = P[p + 2];
    }
  }

  /** The arrays of the surface (fromArrays rebuilds it from them, e.g. in a worker thread). */
  arrays(): Required<TriBVHArrays> & { C: Float64Array } {
    return { ...this.bvh.arrays(), C: this.C };
  }

  /** A surface over arrays from arrays() (no BVH build): closest() gives the same results. */
  static fromArrays(a: TriBVHArrays & { C: Float64Array }): TriSurface {
    const s = Object.create(TriSurface.prototype) as TriSurface;
    Object.assign(s as any, { bvh: TriBVH.fromArrays(a), C: a.C, numTris: a.order.length, hit: closestScratch() });
    return s;
  }

  private hit: ClosestScratch = closestScratch();

  /** Closest point on the triangles; fills out and returns the triangle index (-1 when there are no triangles). */
  closest(x: number, y: number, z: number, out: TriPoint): number {
    const h = this.hit, tri = this.bvh.closestInto(x, y, z, Infinity, h);
    if (tri < 0) return -1;
    const t = this.bvh.triPrim[tri], C = this.C, o = t * 9;
    out.x = h.x; out.y = h.y; out.z = h.z;
    // barycentrics of the hit in the list's corner order
    const v0x = C[o + 3] - C[o], v0y = C[o + 4] - C[o + 1], v0z = C[o + 5] - C[o + 2];
    const v1x = C[o + 6] - C[o], v1y = C[o + 7] - C[o + 1], v1z = C[o + 8] - C[o + 2];
    const v2x = out.x - C[o], v2y = out.y - C[o + 1], v2z = out.z - C[o + 2];
    const d00 = v0x * v0x + v0y * v0y + v0z * v0z, d01 = v0x * v1x + v0y * v1y + v0z * v1z, d11 = v1x * v1x + v1y * v1y + v1z * v1z;
    const d20 = v2x * v0x + v2y * v0y + v2z * v0z, d21 = v2x * v1x + v2y * v1y + v2z * v1z;
    const den = d00 * d11 - d01 * d01;
    if (Math.abs(den) > 1e-30) {
      let b1 = (d11 * d20 - d01 * d21) / den, b2 = (d00 * d21 - d01 * d20) / den;
      b1 = b1 < 0 ? 0 : b1; b2 = b2 < 0 ? 0 : b2;
      let b0 = 1 - b1 - b2;
      if (b0 < 0) { const s = b1 + b2; b1 /= s; b2 /= s; b0 = 0; }
      out.b0 = b0; out.b1 = b1; out.b2 = b2;
    } else { out.b0 = h.b0; out.b1 = h.b1; out.b2 = h.b2; }
    return t;
  }
}

// ---------------------------------------------------------------- incremental spatial grid

/** Hash key of an integer grid cell (PointGrid; the min-distance kernel in scatter.ts keys its cells the same way). */
export function cellKey(ix: number, iy: number, iz: number): number {
  return (Math.imul(ix | 0, 73856093) ^ Math.imul(iy | 0, 19349663) ^ Math.imul(iz | 0, 83492791)) | 0;
}

/**
 * A uniform grid over points that are inserted one at a time (the KD-tree in spatial.ts is static). Cells are
 * addressed by a hash of their integer coordinates; a collision only costs time, never correctness, because
 * queries test real distances.
 */
export class PointGrid {
  readonly P: ArrayLike<number>;
  readonly cell: number;
  private inv: number;
  private cells = new Map<number, number[]>();

  constructor(P: ArrayLike<number>, cell: number) {
    this.P = P;
    this.cell = cell > 0 && Number.isFinite(cell) ? cell : 1;
    this.inv = 1 / this.cell;
  }

  private static key(ix: number, iy: number, iz: number): number { return cellKey(ix, iy, iz); }

  insert(i: number) {
    const P = this.P, inv = this.inv;
    const k = PointGrid.key(Math.floor(P[i * 3] * inv), Math.floor(P[i * 3 + 1] * inv), Math.floor(P[i * 3 + 2] * inv));
    const list = this.cells.get(k);
    if (list) list.push(i); else this.cells.set(k, [i]);
  }

  /**
   * Visit inserted points within distance r of (x, y, z): fn(j, d2) with the squared distance. Stops and returns
   * true as soon as fn returns true. A point can be visited twice when two cells share a hash key.
   */
  query(x: number, y: number, z: number, r: number, fn: (j: number, d2: number) => boolean | void): boolean {
    const P = this.P, inv = this.inv, r2 = r * r;
    const span = Math.max(1, Math.ceil(r * inv));
    const cx = Math.floor(x * inv), cy = Math.floor(y * inv), cz = Math.floor(z * inv);
    for (let ix = cx - span; ix <= cx + span; ix++)
      for (let iy = cy - span; iy <= cy + span; iy++)
        for (let iz = cz - span; iz <= cz + span; iz++) {
          const list = this.cells.get(PointGrid.key(ix, iy, iz));
          if (!list) continue;
          for (let k = 0; k < list.length; k++) {
            const j = list[k];
            const dx = P[j * 3] - x, dy = P[j * 3 + 1] - y, dz = P[j * 3 + 2] - z;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 <= r2 && fn(j, d2)) return true;
          }
        }
    return false;
  }
}

// ---------------------------------------------------------------- exact selection

/**
 * Greedy dart throwing over candidates in the given order: a candidate is kept when no kept point is closer than r
 * (pairs at exactly r are allowed), so the result honours the minimum distance exactly. accept(i) can veto a candidate
 * before the distance test (e.g. a per-prim cap) and kept(i) is told about every kept one. Stops after `limit` points.
 * Returns the kept candidate indices in the order they were kept.
 */
export function minDistanceSelect(
  P: ArrayLike<number>, order: ArrayLike<number>, r: number, limit = Infinity,
  accept?: (i: number) => boolean, kept?: (i: number) => void,
): Int32Array {
  const out: number[] = [];
  const grid = r > 0 ? new PointGrid(P, r) : null;
  const r2 = r * r;
  const tooClose = (_j: number, d2: number) => d2 < r2;
  for (let k = 0; k < order.length && out.length < limit; k++) {
    const i = order[k];
    if (accept && !accept(i)) continue;
    if (grid) {
      if (grid.query(P[i * 3], P[i * 3 + 1], P[i * 3 + 2], r, tooClose)) continue;
      grid.insert(i);
    }
    out.push(i);
    if (kept) kept(i);
  }
  return Int32Array.from(out);
}

/**
 * Keep spheres in priority order unless they overlap a sphere already kept (distance < r_i + r_j). Exact for any mix of
 * radii (grid cells of twice the largest radius). Spheres with radius 0 never overlap. Returns a keep mask over all
 * points; points not listed in `order` are not kept.
 */
export function sphereOverlapPrune(P: ArrayLike<number>, radius: ArrayLike<number>, order: ArrayLike<number>): Uint8Array {
  const n = Math.floor(P.length / 3), keep = new Uint8Array(n);
  let rmax = 0;
  for (let k = 0; k < order.length; k++) rmax = Math.max(rmax, radius[order[k]] || 0);
  if (!(rmax > 0)) {
    for (let k = 0; k < order.length; k++) keep[order[k]] = 1;
    return keep;
  }
  const grid = new PointGrid(P, 2 * rmax);
  for (let k = 0; k < order.length; k++) {
    const i = order[k], ri = Math.max(0, radius[i] || 0);
    if (ri > 0) {
      const hit = grid.query(P[i * 3], P[i * 3 + 1], P[i * 3 + 2], ri + rmax, (j, d2) => {
        const s = ri + Math.max(0, radius[j] || 0);
        return d2 < s * s;
      });
      if (hit) continue;
      grid.insert(i);
    }
    keep[i] = 1;
  }
  return keep;
}

// ---------------------------------------------------------------- relaxation

/**
 * Lloyd-style point relaxation by repulsion: every iteration each point moves away from neighbours closer than the
 * pair spacing (spacing[i] + spacing[j]) / 2, by half the overlap per neighbour (the move is capped at half the point's
 * spacing), then `project` moves it back onto the domain (e.g. the closest point on a surface) and may update its
 * spacing (local density). P is modified in place. Each iteration rebuilds a KD-tree over the current positions.
 */
export function relaxPoints(
  P: Float64Array, spacing: Float64Array, iterations: number,
  project: (i: number, x: number, y: number, z: number) => void,
): void {
  const n = Math.floor(P.length / 3);
  if (n < 2 || !(iterations > 0)) return;
  const disp = new Float64Array(n * 3);
  for (let it = 0; it < iterations; it++) {
    let smax = 0;
    for (let i = 0; i < n; i++) if (spacing[i] > smax) smax = spacing[i];
    if (!(smax > 0)) return;
    const kd = new KDTree(P);
    disp.fill(0);
    for (let i = 0; i < n; i++) {
      const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2], si = spacing[i];
      if (!(si > 0)) continue;
      const near = kd.within(x, y, z, (si + smax) / 2);
      let dx = 0, dy = 0, dz = 0;
      for (const j of near) {
        if (j === i) continue;
        const rest = (si + spacing[j]) / 2;
        let ex = x - P[j * 3], ey = y - P[j * 3 + 1], ez = z - P[j * 3 + 2];
        let d = Math.hypot(ex, ey, ez);
        if (d >= rest) continue;
        if (d < 1e-12) {
          // coincident: push in a direction that depends on the pair only
          const h = hash32(Math.min(i, j) * 7919 + Math.max(i, j));
          const a = (h / 4294967296) * Math.PI * 2;
          ex = Math.cos(a); ey = 0; ez = Math.sin(a); d = 1;
          if (i > j) { ex = -ex; ez = -ez; }
          const push = rest * 0.5;
          dx += ex * push; dy += ey * push; dz += ez * push;
          continue;
        }
        const push = (rest - d) * 0.5 / d;
        dx += ex * push; dy += ey * push; dz += ez * push;
      }
      const len = Math.hypot(dx, dy, dz), cap = 0.5 * si;
      if (len > cap) { const s = cap / len; dx *= s; dy *= s; dz *= s; }
      disp[i * 3] = dx; disp[i * 3 + 1] = dy; disp[i * 3 + 2] = dz;
    }
    for (let i = 0; i < n; i++) project(i, P[i * 3] + disp[i * 3], P[i * 3 + 1] + disp[i * 3 + 1], P[i * 3 + 2] + disp[i * 3 + 2]);
  }
}

// ---------------------------------------------------------------- clustering

export interface Clusters {
  /** cluster per listed point (same order as the index list), 0..k-1 */
  label: Int32Array;
  /** cluster centres, 3 per cluster */
  centers: Float64Array;
  k: number;
}

/** Renumber labels 0.. in order of first appearance and reorder the centres to match. */
function relabel(label: Int32Array, centers: Float64Array, k: number): Clusters {
  const map = new Int32Array(k).fill(-1);
  let next = 0;
  for (let i = 0; i < label.length; i++) if (map[label[i]] < 0) map[label[i]] = next++;
  const C = new Float64Array(next * 3);
  for (let c = 0; c < k; c++) if (map[c] >= 0) C.set(centers.subarray(c * 3, c * 3 + 3), map[c] * 3);
  for (let i = 0; i < label.length; i++) label[i] = map[label[i]];
  return { label, centers: C, k: next };
}

/**
 * k-means (Lloyd iterations) over the points idx[], seeded k-means++ initialisation. Empty clusters are re-seeded with
 * the point farthest from its centre. Stops early when no assignment changes. Labels are renumbered in order of first
 * appearance, so cluster 0 holds idx[0].
 */
export function kmeans(P: ArrayLike<number>, idx: ArrayLike<number>, k: number, iterations: number, seed: number): Clusters {
  const n = idx.length;
  k = Math.max(0, Math.min(Math.floor(k), n));
  const label = new Int32Array(n);
  if (!n || !k) return { label, centers: new Float64Array(0), k: 0 };
  const r = rng(seed + 0.25);
  const C = new Float64Array(k * 3);
  const px = (a: number, c: number) => P[idx[a] * 3 + c];
  // k-means++ (O(n·k)); for very large n·k a seeded random choice of k distinct points instead
  const D2 = new Float64Array(n).fill(Infinity);
  let first = Math.min(n - 1, Math.floor(r() * n));
  if (n * k > 5e7) {
    const pick = Int32Array.from({ length: n }, (_, a) => a);
    for (let c = 0; c < k; c++) {
      const b = c + Math.floor(r() * (n - c));
      const t = pick[c]; pick[c] = pick[b]; pick[b] = t;
      C[c * 3] = px(pick[c], 0); C[c * 3 + 1] = px(pick[c], 1); C[c * 3 + 2] = px(pick[c], 2);
    }
  }
  for (let c = 0; c < k && n * k <= 5e7; c++) {
    let pick = first;
    if (c > 0) {
      let total = 0;
      for (let a = 0; a < n; a++) total += D2[a];
      if (total > 0) {
        let t = r() * total;
        pick = n - 1;
        for (let a = 0; a < n; a++) { t -= D2[a]; if (t < 0) { pick = a; break; } }
      } else pick = Math.min(n - 1, Math.floor(r() * n));
    }
    C[c * 3] = px(pick, 0); C[c * 3 + 1] = px(pick, 1); C[c * 3 + 2] = px(pick, 2);
    for (let a = 0; a < n; a++) {
      const dx = px(a, 0) - C[c * 3], dy = px(a, 1) - C[c * 3 + 1], dz = px(a, 2) - C[c * 3 + 2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < D2[a]) D2[a] = d2;
    }
    first = pick;
  }
  label.fill(-1);
  const sum = new Float64Array(k * 3), cnt = new Int32Array(k), dist = new Float64Array(n);
  for (let it = 0; it < Math.max(1, iterations); it++) {
    const kd = new KDTree(C);
    let changed = 0;
    for (let a = 0; a < n; a++) {
      const nr = kd.nearest(px(a, 0), px(a, 1), px(a, 2));
      if (nr.index !== label[a]) { label[a] = nr.index; changed++; }
      dist[a] = nr.dist;
    }
    if (!changed && it > 0) break;
    sum.fill(0); cnt.fill(0);
    for (let a = 0; a < n; a++) {
      const c = label[a];
      sum[c * 3] += px(a, 0); sum[c * 3 + 1] += px(a, 1); sum[c * 3 + 2] += px(a, 2); cnt[c]++;
    }
    for (let c = 0; c < k; c++) {
      if (cnt[c]) { C[c * 3] = sum[c * 3] / cnt[c]; C[c * 3 + 1] = sum[c * 3 + 1] / cnt[c]; C[c * 3 + 2] = sum[c * 3 + 2] / cnt[c]; continue; }
      // empty: take the point farthest from its centre
      let far = 0;
      for (let a = 1; a < n; a++) if (dist[a] > dist[far]) far = a;
      C[c * 3] = px(far, 0); C[c * 3 + 1] = px(far, 1); C[c * 3 + 2] = px(far, 2);
      dist[far] = 0;
    }
  }
  // final assignment against the final centres, then centres = centroids of their members
  const kd = new KDTree(C);
  for (let a = 0; a < n; a++) label[a] = kd.nearest(px(a, 0), px(a, 1), px(a, 2)).index;
  sum.fill(0); cnt.fill(0);
  for (let a = 0; a < n; a++) { const c = label[a]; sum[c * 3] += px(a, 0); sum[c * 3 + 1] += px(a, 1); sum[c * 3 + 2] += px(a, 2); cnt[c]++; }
  for (let c = 0; c < k; c++) if (cnt[c]) for (let q = 0; q < 3; q++) C[c * 3 + q] = sum[c * 3 + q] / cnt[c];
  return relabel(label, C, k);
}

/**
 * Radius clustering (leader algorithm): points are visited in a seeded random order; an unassigned point starts a
 * cluster and takes every unassigned point within r of it, so each cluster fits in a ball of radius r around its
 * leader. Centres are the centroids of the members. Labels are renumbered in order of first appearance.
 */
export function radiusClusters(P: ArrayLike<number>, idx: ArrayLike<number>, r: number, seed: number): Clusters {
  const n = idx.length, label = new Int32Array(n).fill(-1);
  if (!n) return { label, centers: new Float64Array(0), k: 0 };
  const order = Int32Array.from({ length: n }, (_, a) => a);
  const rnd = rng(seed + 0.75);
  for (let a = n - 1; a > 0; a--) { const b = Math.floor(rnd() * (a + 1)); const t = order[a]; order[a] = order[b]; order[b] = t; }
  const sub = Float64Array.from({ length: n * 3 }, (_, q) => P[idx[Math.floor(q / 3)] * 3 + (q % 3)]);
  const kd = new KDTree(sub);
  let k = 0;
  for (let o = 0; o < n; o++) {
    const a = order[o];
    if (label[a] >= 0) continue;
    const c = k++;
    label[a] = c;
    if (r > 0) for (const b of kd.within(sub[a * 3], sub[a * 3 + 1], sub[a * 3 + 2], r)) if (label[b] < 0) label[b] = c;
  }
  const C = new Float64Array(k * 3), cnt = new Int32Array(k);
  for (let a = 0; a < n; a++) { const c = label[a]; C[c * 3] += sub[a * 3]; C[c * 3 + 1] += sub[a * 3 + 1]; C[c * 3 + 2] += sub[a * 3 + 2]; cnt[c]++; }
  for (let c = 0; c < k; c++) for (let q = 0; q < 3; q++) C[c * 3 + q] /= cnt[c];
  return relabel(label, C, k);
}

// ---------------------------------------------------------------- masks

/**
 * 1 for v in [lo, hi], fading linearly to 0 over `fall` outside the range (a hard edge when fall is 0).
 * NaN gives 0.
 */
export function band(v: number, lo: number, hi: number, fall: number): number {
  if (!(v === v)) return 0;
  if (v < lo) return fall > 0 ? Math.max(0, 1 - (lo - v) / fall) : 0;
  if (v > hi) return fall > 0 ? Math.max(0, 1 - (v - hi) / fall) : 0;
  return 1;
}

export const MASK_COMBINE = ['replace', 'multiply', 'add', 'subtract', 'max', 'min'];

/**
 * Combine a new mask value with an existing one, clamped to 0..1. Without an existing mask the new value is used
 * (each mode then starts from its identity: 1 for multiply and min, 0 for add, subtract and max).
 */
export function combineMask(mode: string, old: number | undefined, v: number): number {
  let r: number;
  if (old === undefined) r = mode === 'subtract' ? 0 : v;
  else switch (mode) {
    case 'multiply': r = old * v; break;
    case 'add': r = old + v; break;
    case 'subtract': r = old - v; break;
    case 'max': r = old > v ? old : v; break;
    case 'min': r = old < v ? old : v; break;
    default: r = v;
  }
  return r > 0 ? (r < 1 ? r : 1) : 0;
}

// ---------------------------------------------------------------- images

/** A decoded image (io/png-decode.ts PngImage): channels interleaved, row 0 at the top. */
export interface ImageLike {
  width: number;
  height: number;
  channels: 1 | 2 | 3 | 4;
  maxValue: number;
  data: ArrayLike<number>;
}

export type WrapMode = 'repeat' | 'clamp' | 'mirror';

function wrapIndex(i: number, n: number, mode: WrapMode): number {
  if (mode === 'clamp') return i < 0 ? 0 : i >= n ? n - 1 : i;
  if (mode === 'mirror') {
    const p = 2 * n, m = ((i % p) + p) % p;
    return m < n ? m : p - 1 - m;
  }
  return ((i % n) + n) % n;
}

/**
 * RGBA (0..1) of an image at continuous pixel coordinates (x to the right, y down, pixel centres on integers) into
 * out[0..4]. Grey images give r = g = b; images without alpha give a = 1. Bilinear or nearest filtering.
 */
export function sampleImage(img: ImageLike, x: number, y: number, wrap: WrapMode, bilinear: boolean, out: Float64Array): Float64Array {
  const W = img.width, H = img.height, ch = img.channels, d = img.data, inv = 1 / img.maxValue;
  out[0] = out[1] = out[2] = 0; out[3] = 0;
  const add = (px: number, py: number, w: number) => {
    if (w === 0) return;
    const o = (wrapIndex(py, H, wrap) * W + wrapIndex(px, W, wrap)) * ch;
    if (ch <= 2) {
      const g = d[o] * inv;
      out[0] += g * w; out[1] += g * w; out[2] += g * w;
      out[3] += (ch === 2 ? d[o + 1] * inv : 1) * w;
    } else {
      out[0] += d[o] * inv * w; out[1] += d[o + 1] * inv * w; out[2] += d[o + 2] * inv * w;
      out[3] += (ch === 4 ? d[o + 3] * inv : 1) * w;
    }
  };
  if (!(x === x) || !(y === y)) return out;
  if (!bilinear) { add(Math.round(x), Math.round(y), 1); return out; }
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  add(x0, y0, (1 - fx) * (1 - fy));
  add(x0 + 1, y0, fx * (1 - fy));
  add(x0, y0 + 1, (1 - fx) * fy);
  add(x0 + 1, y0 + 1, fx * fy);
  return out;
}

// ---------------------------------------------------------------- frames

const norm3 = (v: number[]): number => Math.hypot(v[0], v[1], v[2]);

/**
 * Unit quaternion (x, y, z, w) of the frame whose +Z is N and +Y is up (Gram-Schmidt: up is made perpendicular to N;
 * when they are parallel a fallback axis is used). Same convention as copy_to_points and lookAtBasis.
 */
export function frameQuat(N: ArrayLike<number>, up: ArrayLike<number>): Quat {
  let zx = N[0], zy = N[1], zz = N[2];
  const zl = Math.hypot(zx, zy, zz);
  if (!(zl > 1e-12)) { zx = 0; zy = 0; zz = 1; } else { zx /= zl; zy /= zl; zz /= zl; }
  // x = up × z
  let ux = up[0], uy = up[1], uz = up[2];
  let xx = uy * zz - uz * zy, xy = uz * zx - ux * zz, xz = ux * zy - uy * zx;
  if (Math.hypot(xx, xy, xz) < 1e-8) {
    ux = Math.abs(zy) < 0.9 ? 0 : 1; uy = Math.abs(zy) < 0.9 ? 1 : 0; uz = 0;
    xx = uy * zz - uz * zy; xy = uz * zx - ux * zz; xz = ux * zy - uy * zx;
  }
  const xl = Math.hypot(xx, xy, xz);
  xx /= xl; xy /= xl; xz /= xl;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  // rotation matrix columns x, y, z → quaternion
  const m00 = xx, m01 = yx, m02 = zx, m10 = xy, m11 = yy, m12 = zy, m20 = xz, m21 = yz, m22 = zz;
  const tr = m00 + m11 + m22;
  let qx: number, qy: number, qz: number, qw: number;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    qw = 0.25 * s; qx = (m21 - m12) / s; qy = (m02 - m20) / s; qz = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    qw = (m21 - m12) / s; qx = 0.25 * s; qy = (m01 + m10) / s; qz = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    qw = (m02 - m20) / s; qx = (m01 + m10) / s; qy = 0.25 * s; qz = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    qw = (m10 - m01) / s; qx = (m02 + m20) / s; qy = (m12 + m21) / s; qz = 0.25 * s;
  }
  const l = Math.hypot(qx, qy, qz, qw) || 1;
  return [qx / l, qy / l, qz / l, qw / l];
}

/** v with its component along the unit vector n removed, normalised; null when (nearly) parallel. */
export function perpTo(v: ArrayLike<number>, n: ArrayLike<number>): Vec3 | null {
  const d = v[0] * n[0] + v[1] * n[1] + v[2] * n[2];
  const p = [v[0] - n[0] * d, v[1] - n[1] * d, v[2] - n[2] * d];
  const l = norm3(p);
  return l > 1e-9 ? [p[0] / l, p[1] / l, p[2] / l] : null;
}

/** Per-element seed (PCG $Seed): a non-negative 31-bit hash of the node seed and an element index. */
export function elementSeed(seed: number, i: number): number {
  return hash32(hashNumber(seed) ^ hash32(i + 0x2545f491)) & 0x7fffffff;
}
