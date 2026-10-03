// Spatial acceleration: a KD-tree over points and a BVH over triangles.
import { Geometry } from './geometry.ts';
import { triangulate } from './topology.ts';

// ---------------------------------------------------------------- KD-tree

export class KDTree {
  P: ArrayLike<number>;
  idx: Int32Array;
  axis: Int8Array;
  n: number;

  constructor(P: ArrayLike<number>, subset?: ArrayLike<number>) {
    this.P = P;
    this.idx = subset ? Int32Array.from(subset) : Int32Array.from({ length: P.length / 3 }, (_, i) => i);
    this.n = this.idx.length;
    this.axis = new Int8Array(this.n);
    this.build(0, this.n);
  }

  private build(lo: number, hi: number) {
    if (hi - lo <= 1) return;
    const P = this.P, idx = this.idx;
    let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = lo; i < hi; i++) for (let c = 0; c < 3; c++) {
      const v = P[idx[i] * 3 + c];
      if (v < mn[c]) mn[c] = v; if (v > mx[c]) mx[c] = v;
    }
    const ex = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];
    const ax = ex[0] >= ex[1] && ex[0] >= ex[2] ? 0 : ex[1] >= ex[2] ? 1 : 2;
    const mid = (lo + hi) >> 1;
    this.select(lo, hi - 1, mid, ax);
    this.axis[mid] = ax;
    this.build(lo, mid);
    this.build(mid + 1, hi);
  }

  private select(l: number, r: number, k: number, ax: number) {
    const P = this.P, idx = this.idx;
    while (r > l) {
      const pv = P[idx[(l + r) >> 1] * 3 + ax];
      let i = l, j = r;
      while (i <= j) {
        while (P[idx[i] * 3 + ax] < pv) i++;
        while (P[idx[j] * 3 + ax] > pv) j--;
        if (i <= j) { const t = idx[i]; idx[i] = idx[j]; idx[j] = t; i++; j--; }
      }
      if (k <= j) r = j; else if (k >= i) l = i; else break;
    }
  }

  nearest(x: number, y: number, z: number, maxDist = Infinity): { index: number; dist: number } {
    let best = -1, bd2 = maxDist === Infinity ? Infinity : maxDist * maxDist;
    const P = this.P, idx = this.idx, q = [x, y, z];
    const rec = (lo: number, hi: number) => {
      if (lo >= hi) return;
      const mid = (lo + hi) >> 1, i = idx[mid], ax = this.axis[mid];
      const dx = P[i * 3] - x, dy = P[i * 3 + 1] - y, dz = P[i * 3 + 2] - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bd2) { bd2 = d2; best = i; }
      if (hi - lo === 1) return;
      const diff = q[ax] - P[i * 3 + ax];
      const [a0, a1, b0, b1] = diff < 0 ? [lo, mid, mid + 1, hi] : [mid + 1, hi, lo, mid];
      rec(a0, a1);
      if (diff * diff < bd2) rec(b0, b1);
    };
    rec(0, this.n);
    return { index: best, dist: best < 0 ? Infinity : Math.sqrt(bd2) };
  }

  /** Points within radius r, nearest first, at most maxCount. */
  within(x: number, y: number, z: number, r: number, maxCount = Infinity): number[] {
    const out: [number, number][] = [];
    const r2 = r * r, P = this.P, idx = this.idx, q = [x, y, z];
    const rec = (lo: number, hi: number) => {
      if (lo >= hi) return;
      const mid = (lo + hi) >> 1, i = idx[mid], ax = this.axis[mid];
      const dx = P[i * 3] - x, dy = P[i * 3 + 1] - y, dz = P[i * 3 + 2] - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 <= r2) out.push([d2, i]);
      if (hi - lo === 1) return;
      const diff = q[ax] - P[i * 3 + ax];
      if (diff <= r) rec(lo, mid);
      if (diff >= -r) rec(mid + 1, hi);
    };
    rec(0, this.n);
    out.sort((a, b) => a[0] - b[0]);
    return (maxCount < out.length ? out.slice(0, maxCount) : out).map((e) => e[1]);
  }

  /** k nearest points (unbounded radius). */
  knn(x: number, y: number, z: number, k: number): number[] {
    const heap: [number, number][] = []; // max-heap by distance (simple sorted insert, k small)
    const P = this.P, idx = this.idx, q = [x, y, z];
    let worst = Infinity;
    const rec = (lo: number, hi: number) => {
      if (lo >= hi) return;
      const mid = (lo + hi) >> 1, i = idx[mid], ax = this.axis[mid];
      const dx = P[i * 3] - x, dy = P[i * 3 + 1] - y, dz = P[i * 3 + 2] - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (heap.length < k || d2 < worst) {
        let j = heap.length;
        heap.push([d2, i]);
        while (j > 0 && heap[j - 1][0] > d2) { heap[j] = heap[j - 1]; j--; }
        heap[j] = [d2, i];
        if (heap.length > k) heap.pop();
        worst = heap.length === k ? heap[heap.length - 1][0] : Infinity;
      }
      if (hi - lo === 1) return;
      const diff = q[ax] - P[i * 3 + ax];
      const [a0, a1, b0, b1] = diff < 0 ? [lo, mid, mid + 1, hi] : [mid + 1, hi, lo, mid];
      rec(a0, a1);
      if (diff * diff < worst) rec(b0, b1);
    };
    rec(0, this.n);
    return heap.map((e) => e[1]);
  }
}

// ---------------------------------------------------------------- triangle BVH

export interface ClosestHit { dist: number; pos: [number, number, number]; tri: number; prim: number; bary: [number, number, number] }
export interface RayHit { t: number; tri: number; prim: number; u: number; v: number; pos: [number, number, number] }

export class TriBVH {
  /** triangle corner positions, 9 per triangle */
  T: Float64Array;
  triPrim: Uint32Array;
  /** vertex indices of each triangle corner (into source geometry), for attribute interpolation */
  triVtx: Uint32Array;
  order: Int32Array;
  nodes: Float64Array; // per node: minx miny minz maxx maxy maxz
  child: Int32Array; // per node: left (or -1-leafStart), right (or leafCount)
  nodeCount = 0;

  constructor(g: Geometry) {
    const { tris, triPrim } = triangulate(g);
    const P = g.P, nt = tris.length / 3;
    this.T = new Float64Array(nt * 9);
    this.triPrim = triPrim;
    this.triVtx = tris;
    for (let t = 0; t < nt; t++)
      for (let k = 0; k < 3; k++) {
        const p = g.vertexPoint[tris[t * 3 + k]] * 3;
        this.T[t * 9 + k * 3] = P[p]; this.T[t * 9 + k * 3 + 1] = P[p + 1]; this.T[t * 9 + k * 3 + 2] = P[p + 2];
      }
    this.order = Int32Array.from({ length: nt }, (_, i) => i);
    this.nodes = new Float64Array(Math.max(1, nt * 2) * 6);
    this.child = new Int32Array(Math.max(1, nt * 2) * 2);
    const cen = new Float64Array(nt * 3);
    for (let t = 0; t < nt; t++) for (let c = 0; c < 3; c++) cen[t * 3 + c] = (this.T[t * 9 + c] + this.T[t * 9 + 3 + c] + this.T[t * 9 + 6 + c]) / 3;
    if (nt) this.build(0, nt, cen);
  }

  get numTris() { return this.order.length; }

  private build(lo: number, hi: number, cen: Float64Array): number {
    const id = this.nodeCount++;
    const T = this.T, o = this.order, nb = id * 6;
    let mn0 = Infinity, mn1 = Infinity, mn2 = Infinity, mx0 = -Infinity, mx1 = -Infinity, mx2 = -Infinity;
    for (let i = lo; i < hi; i++) {
      const b = o[i] * 9;
      for (let k = 0; k < 9; k += 3) {
        const x = T[b + k], y = T[b + k + 1], z = T[b + k + 2];
        if (x < mn0) mn0 = x; if (x > mx0) mx0 = x;
        if (y < mn1) mn1 = y; if (y > mx1) mx1 = y;
        if (z < mn2) mn2 = z; if (z > mx2) mx2 = z;
      }
    }
    this.nodes[nb] = mn0; this.nodes[nb + 1] = mn1; this.nodes[nb + 2] = mn2;
    this.nodes[nb + 3] = mx0; this.nodes[nb + 4] = mx1; this.nodes[nb + 5] = mx2;
    if (hi - lo <= 4) {
      this.child[id * 2] = -1 - lo;
      this.child[id * 2 + 1] = hi - lo;
      return id;
    }
    let cmn = [Infinity, Infinity, Infinity], cmx = [-Infinity, -Infinity, -Infinity];
    for (let i = lo; i < hi; i++) for (let c = 0; c < 3; c++) {
      const v = cen[o[i] * 3 + c];
      if (v < cmn[c]) cmn[c] = v; if (v > cmx[c]) cmx[c] = v;
    }
    const ex = [cmx[0] - cmn[0], cmx[1] - cmn[1], cmx[2] - cmn[2]];
    const ax = ex[0] >= ex[1] && ex[0] >= ex[2] ? 0 : ex[1] >= ex[2] ? 1 : 2;
    const sub = Array.from(o.subarray(lo, hi)).sort((a, b) => cen[a * 3 + ax] - cen[b * 3 + ax]);
    o.set(sub, lo);
    const mid = (lo + hi) >> 1;
    const l = this.build(lo, mid, cen);
    const r = this.build(mid, hi, cen);
    this.child[id * 2] = l;
    this.child[id * 2 + 1] = r;
    return id;
  }

  private boxDist2(n: number, x: number, y: number, z: number) {
    const b = this.nodes, i = n * 6;
    const dx = Math.max(b[i] - x, 0, x - b[i + 3]);
    const dy = Math.max(b[i + 1] - y, 0, y - b[i + 4]);
    const dz = Math.max(b[i + 2] - z, 0, z - b[i + 5]);
    return dx * dx + dy * dy + dz * dz;
  }

  closest(x: number, y: number, z: number, maxDist = Infinity): ClosestHit | null {
    if (!this.numTris) return null;
    let best2 = maxDist === Infinity ? Infinity : maxDist * maxDist, bestT = -1;
    const bp = [0, 0, 0], bb = [0, 0, 0], tmp = [0, 0, 0], tb = [0, 0, 0];
    const stack = [0];
    while (stack.length) {
      const n = stack.pop()!;
      if (this.boxDist2(n, x, y, z) >= best2) continue;
      const c0 = this.child[n * 2], c1 = this.child[n * 2 + 1];
      if (c0 < 0) {
        const s = -1 - c0;
        for (let i = s; i < s + c1; i++) {
          const t = this.order[i];
          const d2 = closestOnTri(this.T, t * 9, x, y, z, tmp, tb);
          if (d2 < best2) { best2 = d2; bestT = t; bp[0] = tmp[0]; bp[1] = tmp[1]; bp[2] = tmp[2]; bb[0] = tb[0]; bb[1] = tb[1]; bb[2] = tb[2]; }
        }
      } else {
        const d0 = this.boxDist2(c0, x, y, z), d1 = this.boxDist2(c1, x, y, z);
        if (d0 < d1) { stack.push(c1, c0); } else { stack.push(c0, c1); }
      }
    }
    if (bestT < 0) return null;
    return { dist: Math.sqrt(best2), pos: [bp[0], bp[1], bp[2]], tri: bestT, prim: this.triPrim[bestT], bary: [bb[0], bb[1], bb[2]] };
  }

  /** Nearest hit along a ray (dir need not be normalised; t is in units of |dir|). */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tmax = Infinity, tmin = 1e-9): RayHit | null {
    if (!this.numTris) return null;
    let bestT = tmax, bestTri = -1, bu = 0, bv = 0;
    const inv = [1 / dx, 1 / dy, 1 / dz];
    const stack = [0];
    while (stack.length) {
      const n = stack.pop()!;
      if (!this.rayBox(n, ox, oy, oz, inv, bestT)) continue;
      const c0 = this.child[n * 2], c1 = this.child[n * 2 + 1];
      if (c0 < 0) {
        const s = -1 - c0;
        for (let i = s; i < s + c1; i++) {
          const t = this.order[i];
          const r = rayTri(this.T, t * 9, ox, oy, oz, dx, dy, dz);
          if (r && r[0] > tmin && r[0] < bestT) { bestT = r[0]; bestTri = t; bu = r[1]; bv = r[2]; }
        }
      } else stack.push(c0, c1);
    }
    if (bestTri < 0) return null;
    return { t: bestT, tri: bestTri, prim: this.triPrim[bestTri], u: bu, v: bv, pos: [ox + dx * bestT, oy + dy * bestT, oz + dz * bestT] };
  }

  /** All ray-parameter hits (sorted), for inside/outside parity tests. */
  raycastAll(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number[] {
    const hits: number[] = [];
    if (!this.numTris) return hits;
    const inv = [1 / dx, 1 / dy, 1 / dz];
    const stack = [0];
    while (stack.length) {
      const n = stack.pop()!;
      if (!this.rayBox(n, ox, oy, oz, inv, Infinity)) continue;
      const c0 = this.child[n * 2], c1 = this.child[n * 2 + 1];
      if (c0 < 0) {
        const s = -1 - c0;
        for (let i = s; i < s + c1; i++) {
          const r = rayTri(this.T, this.order[i] * 9, ox, oy, oz, dx, dy, dz);
          if (r && r[0] > 0) hits.push(r[0]);
        }
      } else stack.push(c0, c1);
    }
    return hits.sort((a, b) => a - b);
  }

  /** Inside test by majority vote of ray parity along three skewed directions. */
  inside(x: number, y: number, z: number): boolean {
    const dirs = [[0.5773, 0.5774, 0.5775], [-0.6123, 0.3536, 0.7071], [0.2673, -0.8018, 0.5345]];
    let votes = 0;
    for (const d of dirs) if (this.raycastAll(x, y, z, d[0], d[1], d[2]).length % 2 === 1) votes++;
    return votes >= 2;
  }

  private rayBox(n: number, ox: number, oy: number, oz: number, inv: number[], tmax: number) {
    const b = this.nodes, i = n * 6;
    let t0 = 0, t1 = tmax;
    const o = [ox, oy, oz];
    for (let a = 0; a < 3; a++) {
      let ta = (b[i + a] - o[a]) * inv[a], tb = (b[i + 3 + a] - o[a]) * inv[a];
      if (ta > tb) { const t = ta; ta = tb; tb = t; }
      if (Number.isNaN(ta)) ta = -Infinity;
      if (Number.isNaN(tb)) tb = Infinity;
      t0 = ta > t0 ? ta : t0;
      t1 = tb < t1 ? tb : t1;
      if (t0 > t1 * 1.0000001 + 1e-12) return false;
    }
    return true;
  }
}

/** Möller–Trumbore, two-sided. Returns [t, u, v] or null. */
function rayTri(T: Float64Array, o: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number) {
  const e1x = T[o + 3] - T[o], e1y = T[o + 4] - T[o + 1], e1z = T[o + 5] - T[o + 2];
  const e2x = T[o + 6] - T[o], e2y = T[o + 7] - T[o + 1], e2z = T[o + 8] - T[o + 2];
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-18) return null;
  const inv = 1 / det;
  const tx = ox - T[o], ty = oy - T[o + 1], tz = oz - T[o + 2];
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return null;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return null;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return [t, u, v];
}

/** Closest point on triangle (Ericson). Writes point to out, barycentrics to bary; returns squared distance. */
function closestOnTri(T: Float64Array, o: number, px: number, py: number, pz: number, out: number[], bary: number[]): number {
  const ax = T[o], ay = T[o + 1], az = T[o + 2], bx = T[o + 3], by = T[o + 4], bz = T[o + 5], cx = T[o + 6], cy = T[o + 7], cz = T[o + 8];
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let u = 1, v = 0, w = 0;
  if (d1 <= 0 && d2 <= 0) { u = 1; v = 0; w = 0; }
  else {
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { u = 0; v = 1; w = 0; }
    else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) { const t = d1 / (d1 - d3); u = 1 - t; v = t; w = 0; }
      else {
        const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
        const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) { u = 0; v = 0; w = 1; }
        else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) { const t = d2 / (d2 - d6); u = 1 - t; v = 0; w = t; }
          else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const t = (d4 - d3) / (d4 - d3 + (d5 - d6)); u = 0; v = 1 - t; w = t; }
            else { const den = 1 / (va + vb + vc); v = vb * den; w = vc * den; u = 1 - v - w; }
          }
        }
      }
    }
  }
  out[0] = ax * u + bx * v + cx * w; out[1] = ay * u + by * v + cy * w; out[2] = az * u + bz * v + cz * w;
  bary[0] = u; bary[1] = v; bary[2] = w;
  const dx = out[0] - px, dy = out[1] - py, dz = out[2] - pz;
  return dx * dx + dy * dy + dz * dz;
}
