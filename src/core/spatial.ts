// Spatial acceleration: a KD-tree over points and a BVH over triangles.
import { Geometry } from './geometry.ts';
import { triangulate } from './topology.ts';

// ---------------------------------------------------------------- KD-tree

export class KDTree {
  P: ArrayLike<number>;
  idx: Int32Array;
  axis: Int8Array;
  n: number;
  /** positions in tree order (TP[3k..3k+2] = P[3·idx[k]..]) as of construction; neighbours() reads them */
  readonly TP: Float64Array;

  constructor(P: ArrayLike<number>, subset?: ArrayLike<number>) {
    this.P = P;
    if (subset) this.idx = Int32Array.from(subset);
    else {
      const n = P.length / 3, idx = new Int32Array(n);
      for (let i = 0; i < idx.length; i++) idx[i] = i;
      this.idx = idx;
    }
    this.n = this.idx.length;
    this.axis = new Int8Array(this.n);
    // the build permutes a copy of the coordinates alongside idx, so it reads them sequentially
    const TP = (this.TP = new Float64Array(this.n * 3)), idx = this.idx;
    for (let k = 0; k < this.n; k++) { const i = idx[k] * 3; TP[k * 3] = P[i]; TP[k * 3 + 1] = P[i + 1]; TP[k * 3 + 2] = P[i + 2]; }
    this.build(0, this.n);
  }

  private build(lo: number, hi: number) {
    if (hi - lo <= 1) return;
    const W = this.TP;
    let mn0 = Infinity, mn1 = Infinity, mn2 = Infinity, mx0 = -Infinity, mx1 = -Infinity, mx2 = -Infinity;
    for (let i = lo; i < hi; i++) {
      const x = W[i * 3], y = W[i * 3 + 1], z = W[i * 3 + 2];
      if (x < mn0) mn0 = x; if (x > mx0) mx0 = x;
      if (y < mn1) mn1 = y; if (y > mx1) mx1 = y;
      if (z < mn2) mn2 = z; if (z > mx2) mx2 = z;
    }
    const ex0 = mx0 - mn0, ex1 = mx1 - mn1, ex2 = mx2 - mn2;
    const ax = ex0 >= ex1 && ex0 >= ex2 ? 0 : ex1 >= ex2 ? 1 : 2;
    const mid = (lo + hi) >> 1;
    this.select(lo, hi - 1, mid, ax);
    this.axis[mid] = ax;
    this.build(lo, mid);
    this.build(mid + 1, hi);
  }

  /** Quickselect (Hoare partition, middle pivot) of position k on axis ax within idx[l..r], moving TP along. */
  private select(l: number, r: number, k: number, ax: number) {
    const W = this.TP, idx = this.idx;
    while (r > l) {
      const pv = W[((l + r) >> 1) * 3 + ax];
      let i = l, j = r;
      while (i <= j) {
        while (W[i * 3 + ax] < pv) i++;
        while (W[j * 3 + ax] > pv) j--;
        if (i <= j) {
          const t = idx[i]; idx[i] = idx[j]; idx[j] = t;
          const a = i * 3, b = j * 3;
          let s = W[a]; W[a] = W[b]; W[b] = s;
          s = W[a + 1]; W[a + 1] = W[b + 1]; W[b + 1] = s;
          s = W[a + 2]; W[a + 2] = W[b + 2]; W[b + 2] = s;
          i++; j--;
        }
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

  /**
   * within() without allocations: the indices of the points within radius r, nearest first (equal distances in the
   * order within() returns them), written to buf.idx (squared distances to buf.d2; both grow as needed). Returns the
   * count. Same traversal, test and stable ordering as within(), so the lists are identical as long as the positions
   * have not changed since the tree was built (it reads its tree-ordered copy, which is what makes it fast).
   */
  neighbours(x: number, y: number, z: number, r: number, buf: NeighbourBuffer): number {
    const r2 = r * r, T = this.TP, idx = this.idx, axis = this.axis;
    let st = this.stack, sp = 0, m = 0;
    if (this.n > 0) { st[sp++] = 0; st[sp++] = this.n; }
    while (sp > 0) {
      const hi = st[--sp], lo = st[--sp];
      if (lo >= hi) continue;
      const mid = (lo + hi) >> 1, ax = axis[mid];
      const dx = T[mid * 3] - x, dy = T[mid * 3 + 1] - y, dz = T[mid * 3 + 2] - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 <= r2) {
        if (m === buf.idx.length) growNeighbours(buf);
        buf.idx[m] = idx[mid]; buf.d2[m] = d2; m++;
      }
      if (hi - lo === 1) continue;
      const diff = (ax === 0 ? x : ax === 1 ? y : z) - T[mid * 3 + ax];
      if (sp + 4 > st.length) { const g = new Int32Array(st.length * 2); g.set(st); this.stack = st = g; }
      // within() recurses left then right: push right first so left pops first
      if (diff >= -r) { st[sp++] = mid + 1; st[sp++] = hi; }
      if (diff <= r) { st[sp++] = lo; st[sp++] = mid; }
    }
    sortByDistance(buf, m);
    return m;
  }

  private stack = new Int32Array(128);

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

/** Scratch lists for KDTree.neighbours. */
export interface NeighbourBuffer { idx: Int32Array; d2: Float64Array; tmpIdx?: Int32Array; tmpD2?: Float64Array }

export function neighbourBuffer(capacity = 64): NeighbourBuffer {
  return { idx: new Int32Array(capacity), d2: new Float64Array(capacity) };
}

function growNeighbours(buf: NeighbourBuffer) {
  const idx = new Int32Array(buf.idx.length * 2), d2 = new Float64Array(buf.d2.length * 2);
  idx.set(buf.idx); d2.set(buf.d2);
  buf.idx = idx; buf.d2 = d2;
}

/** Stable sort of the first m entries by squared distance (the order Array.prototype.sort gives within()). */
function sortByDistance(buf: NeighbourBuffer, m: number) {
  const idx = buf.idx, d2 = buf.d2;
  if (m <= 32) {
    for (let k = 1; k < m; k++) {
      const kd = d2[k], ki = idx[k];
      let j = k - 1;
      while (j >= 0 && d2[j] > kd) { d2[j + 1] = d2[j]; idx[j + 1] = idx[j]; j--; }
      d2[j + 1] = kd; idx[j + 1] = ki;
    }
    return;
  }
  // bottom-up merge sort (stable), ping-ponging between the buffer and scratch
  if (!buf.tmpIdx || buf.tmpIdx.length < m) { buf.tmpIdx = new Int32Array(idx.length); buf.tmpD2 = new Float64Array(idx.length); }
  let si = idx, sd = d2, di = buf.tmpIdx, dd = buf.tmpD2!;
  for (let width = 1; width < m; width *= 2) {
    for (let lo = 0; lo < m; lo += 2 * width) {
      const mid = Math.min(lo + width, m), hi = Math.min(lo + 2 * width, m);
      let a = lo, b = mid, o = lo;
      while (a < mid && b < hi) {
        if (sd[b] < sd[a]) { di[o] = si[b]; dd[o++] = sd[b++]; } else { di[o] = si[a]; dd[o++] = sd[a++]; }
      }
      while (a < mid) { di[o] = si[a]; dd[o++] = sd[a++]; }
      while (b < hi) { di[o] = si[b]; dd[o++] = sd[b++]; }
    }
    const ti = si, td = sd;
    si = di; sd = dd; di = ti; dd = td;
  }
  if (si !== idx) { idx.set(si.subarray(0, m)); d2.set(sd.subarray(0, m)); }
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
  /** point index of each triangle corner (3 per triangle); shared with worker threads by RayScene.toArrays */
  triPt: Int32Array;
  /** per triangle edge k (corner k → k+1): the triangle across it, -1 = none (boundary), -2 = several; built on demand */
  private edgeNbr: Int32Array | null = null;

  constructor(g: Geometry) {
    const { tris, triPrim } = triangulate(g);
    const P = g.P, nt = tris.length / 3;
    this.T = new Float64Array(nt * 9);
    this.triPrim = triPrim;
    this.triVtx = tris;
    this.triPt = new Int32Array(nt * 3);
    for (let t = 0; t < nt; t++)
      for (let k = 0; k < 3; k++) {
        const pt = g.vertexPoint[tris[t * 3 + k]], p = pt * 3;
        this.triPt[t * 3 + k] = pt;
        this.T[t * 9 + k * 3] = P[p]; this.T[t * 9 + k * 3 + 1] = P[p + 1]; this.T[t * 9 + k * 3 + 2] = P[p + 2];
      }
    this.order = new Int32Array(nt);
    for (let t = 0; t < nt; t++) this.order[t] = t;
    this.nodes = new Float64Array(Math.max(1, nt * 2) * 6);
    this.child = new Int32Array(Math.max(1, nt * 2) * 2);
    const cen = new Float64Array(nt * 3);
    for (let t = 0; t < nt; t++) for (let c = 0; c < 3; c++) cen[t * 3 + c] = (this.T[t * 9 + c] + this.T[t * 9 + 3 + c] + this.T[t * 9 + 6 + c]) / 3;
    let finite = true;
    for (let k = 0; k < cen.length && finite; k++) if (!Number.isFinite(cen[k])) finite = false;
    if (nt) { if (finite) this.buildSelect(0, nt, cen, -1, -1, -1); else this.build(0, nt, cen); }
  }

  get numTris() { return this.order.length; }

  /**
   * The tree build() makes (same nodes, numbering, bounds, splits and leaf order) without sorting at every node.
   *
   * build() stably sorts each node's range by the centroid on its split axis and halves it, so a node's range is
   * ordered by (its axis, its parent's axis, ..., the root's axis, triangle index): a total order. Halving only needs
   * the smaller half of that order, found by quickselect; a leaf (<= 4 triangles) keeps its parent's order, so leaves
   * are sorted by the parent's key. (c0, c1, c2) = the axes of the key this range arrived in, most recent first (-1 =
   * none; repeated axes add nothing). Centroids must be finite (build() is used otherwise).
   */
  private buildSelect(lo: number, hi: number, cen: Float64Array, c0: number, c1: number, c2: number): number {
    const id = this.nodeCount++;
    const T = this.T, o = this.order, nb = id * 6;
    const leaf = hi - lo <= 4;
    // a leaf keeps its arrival order: sort it by the arrival key
    if (leaf)
      for (let i = lo + 1; i < hi; i++) {
        const t = o[i];
        let j = i - 1;
        while (j >= lo && keyLess(cen, t, o[j], c0, c1, c2)) { o[j + 1] = o[j]; j--; }
        o[j + 1] = t;
      }
    // bounds; zs flags which signs of zero occur per axis (bit 2a: -0, bit 2a+1: +0)
    let mn0 = Infinity, mn1 = Infinity, mn2 = Infinity, mx0 = -Infinity, mx1 = -Infinity, mx2 = -Infinity, zs = 0;
    for (let i = lo; i < hi; i++) {
      const b = o[i] * 9;
      for (let k = 0; k < 9; k += 3) {
        const x = T[b + k], y = T[b + k + 1], z = T[b + k + 2];
        if (x < mn0) mn0 = x; if (x > mx0) mx0 = x;
        if (y < mn1) mn1 = y; if (y > mx1) mx1 = y;
        if (z < mn2) mn2 = z; if (z > mx2) mx2 = z;
        if (x === 0) zs |= 1 / x < 0 ? 1 : 2;
        if (y === 0) zs |= 1 / y < 0 ? 4 : 8;
        if (z === 0) zs |= 1 / z < 0 ? 16 : 32;
      }
    }
    // build() scans the range in arrival order, so a bound of zero takes the sign of the first zero in that order;
    // an internal node's range is not in arrival order here, so settle that case explicitly (rare)
    if (!leaf && zs) {
      if ((zs & 3) === 3) { if (mn0 === 0) mn0 = firstZero(T, o, lo, hi, cen, 0, c0, c1, c2); if (mx0 === 0) mx0 = firstZero(T, o, lo, hi, cen, 0, c0, c1, c2); }
      if ((zs & 12) === 12) { if (mn1 === 0) mn1 = firstZero(T, o, lo, hi, cen, 1, c0, c1, c2); if (mx1 === 0) mx1 = firstZero(T, o, lo, hi, cen, 1, c0, c1, c2); }
      if ((zs & 48) === 48) { if (mn2 === 0) mn2 = firstZero(T, o, lo, hi, cen, 2, c0, c1, c2); if (mx2 === 0) mx2 = firstZero(T, o, lo, hi, cen, 2, c0, c1, c2); }
    }
    this.nodes[nb] = mn0; this.nodes[nb + 1] = mn1; this.nodes[nb + 2] = mn2;
    this.nodes[nb + 3] = mx0; this.nodes[nb + 4] = mx1; this.nodes[nb + 5] = mx2;
    if (leaf) {
      this.child[id * 2] = -1 - lo;
      this.child[id * 2 + 1] = hi - lo;
      return id;
    }
    let cn0 = Infinity, cn1 = Infinity, cn2 = Infinity, cx0 = -Infinity, cx1 = -Infinity, cx2 = -Infinity;
    for (let i = lo; i < hi; i++) {
      const b = o[i] * 3, x = cen[b], y = cen[b + 1], z = cen[b + 2];
      if (x < cn0) cn0 = x; if (x > cx0) cx0 = x;
      if (y < cn1) cn1 = y; if (y > cx1) cx1 = y;
      if (z < cn2) cn2 = z; if (z > cx2) cx2 = z;
    }
    const ex0 = cx0 - cn0, ex1 = cx1 - cn1, ex2 = cx2 - cn2;
    const ax = ex0 >= ex1 && ex0 >= ex2 ? 0 : ex1 >= ex2 ? 1 : 2;
    // this node's key: ax, then the arrival key's axes without ax
    const d1 = c0 === ax ? c1 : c0, d2 = c0 === ax || c1 === ax ? c2 : c1;
    const mid = (lo + hi) >> 1;
    selectKey(o, lo, hi - 1, mid, cen, ax, d1, d2);
    const l = this.buildSelect(lo, mid, cen, ax, d1, d2);
    const r = this.buildSelect(mid, hi, cen, ax, d1, d2);
    this.child[id * 2] = l;
    this.child[id * 2 + 1] = r;
    return id;
  }

  /** The original build: a stable sort per node (used when a centroid is not finite). */
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

  /** Triangles across each triangle edge, from the corner point indices (welded edges only). */
  private neighbours(): Int32Array {
    if (this.edgeNbr) return this.edgeNbr;
    const tp = this.triPt, ne = tp.length, nbr = new Int32Array(ne).fill(-1);
    let np = 0;
    for (let i = 0; i < ne; i++) if (tp[i] >= np) np = tp[i] + 1;
    // half-edges listed under their lower point; a match links the two triangles
    const head = new Int32Array(np).fill(-1), next = new Int32Array(ne).fill(-1);
    for (let h = 0; h < ne; h++) {
      const t = (h / 3) | 0, k = h - t * 3;
      const a = tp[h], b = tp[t * 3 + (k + 1) % 3];
      if (a === b) continue;
      const lo = a < b ? a : b, hi = a < b ? b : a;
      let m = head[lo];
      while (m >= 0) {
        const mt = (m / 3) | 0, mk = m - mt * 3, ma = tp[m], mb = tp[mt * 3 + (mk + 1) % 3];
        if ((ma < mb ? mb : ma) === hi) break;
        m = next[m];
      }
      if (m < 0) { next[h] = head[lo]; head[lo] = h; continue; }
      const mt = (m / 3) | 0;
      if (nbr[m] === -1) { nbr[m] = t; nbr[h] = mt; }
      else {
        // a third triangle on the edge: non-manifold, no single neighbour
        if (nbr[m] >= 0) { const o = nbr[m]; for (let q = o * 3; q < o * 3 + 3; q++) if (nbr[q] === mt) nbr[q] = -2; }
        nbr[m] = -2; nbr[h] = -2;
      }
    }
    return (this.edgeNbr = nbr);
  }

  /** Sign of triangle t's normal along d (+1, -1, or 0 when the triangle is edge-on or degenerate). */
  private facing(t: number, dx: number, dy: number, dz: number): number {
    const T = this.T, o = t * 9;
    const ux = T[o + 3] - T[o], uy = T[o + 4] - T[o + 1], uz = T[o + 5] - T[o + 2];
    const vx = T[o + 6] - T[o], vy = T[o + 7] - T[o + 1], vz = T[o + 8] - T[o + 2];
    const f = (uy * vz - uz * vy) * dx + (uz * vx - ux * vz) * dy + (ux * vy - uy * vx) * dz;
    return f > 0 ? 1 : f < 0 ? -1 : 0;
  }

  /**
   * Watertight test of the ray o + t·d against triangle t (Woop, Benthin, Wald 2013, two-sided). The vertices are sheared
   * into the ray's frame and each edge function is a 2D cross product of the edge's two vertices, so the edge function of
   * a shared edge is computed from the same two numbers in both triangles and is the exact negative in a consistently
   * wound neighbour: no ray slips between them. An edge function of exactly 0 (the ray meets the edge or a vertex):
   *  - on an edge shared with a triangle that faces the same way along the ray, it takes the sign it would have with the
   *    ray moved by a fixed infinitesimal offset (simulation of simplicity), so such a ray is inside exactly one of the
   *    triangles around the edge or vertex;
   *  - on a boundary edge, or one whose neighbour faces the other way or is edge-on (a silhouette), it does not
   *    constrain: boundaries and silhouettes stay closed, as before.
   * A ray in the triangle's plane is the caller's (parallel) case.
   */
  crossesTri(t: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): boolean {
    const T = this.T, o = t * 9;
    const ax = dx < 0 ? -dx : dx, ay = dy < 0 ? -dy : dy, az = dz < 0 ? -dz : dz;
    let kx: number, ky: number, kz: number;
    if (ax >= ay && ax >= az) { kz = 0; kx = 1; ky = 2; } else if (ay >= az) { kz = 1; kx = 2; ky = 0; } else { kz = 2; kx = 0; ky = 1; }
    const dk = axisOf(kz, dx, dy, dz);
    if (dk < 0) { const s = kx; kx = ky; ky = s; }
    const sx = axisOf(kx, dx, dy, dz) / dk, sy = axisOf(ky, dx, dy, dz) / dk;
    const okx = axisOf(kx, ox, oy, oz), oky = axisOf(ky, ox, oy, oz), okz = axisOf(kz, ox, oy, oz);
    const az0 = T[o + kz] - okz, bz0 = T[o + 3 + kz] - okz, cz0 = T[o + 6 + kz] - okz;
    const Ax = T[o + kx] - okx - sx * az0, Ay = T[o + ky] - oky - sy * az0;
    const Bx = T[o + 3 + kx] - okx - sx * bz0, By = T[o + 3 + ky] - oky - sy * bz0;
    const Cx = T[o + 6 + kx] - okx - sx * cz0, Cy = T[o + 6 + ky] - oky - sy * cz0;
    // edge functions at the 2D origin (the ray) of the edges C→B (triangle edge 1), A→C (edge 2), B→A (edge 0)
    let U = Cx * By - Cy * Bx, V = Ax * Cy - Ay * Cx, W = Bx * Ay - By * Ax;
    if (U === 0 || V === 0 || W === 0) {
      const nbr = this.neighbours(), face = this.facing(t, dx, dy, dz);
      const shared = (k: number) => { const n = nbr[t * 3 + k]; return n === -2 || (n >= 0 && face !== 0 && this.facing(n, dx, dy, dz) === face); };
      // sign for the ray moved by (ε, ε²): -(Qy - Py), or (Qx - Px) for an edge along x; NaN = unconstrained
      if (U === 0) U = shared(1) ? (By !== Cy ? Cy - By : Bx - Cx) : NaN;
      if (V === 0) V = shared(2) ? (Cy !== Ay ? Ay - Cy : Cx - Ax) : NaN;
      if (W === 0) W = shared(0) ? (Ay !== By ? By - Ay : Ax - Bx) : NaN;
      const pos = U > 0 || V > 0 || W > 0, neg = U < 0 || V < 0 || W < 0;
      return pos !== neg;
    }
    return (U > 0 && V > 0 && W > 0) || (U < 0 && V < 0 && W < 0);
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
          const r = rayTri(this, this.T, t * 9, ox, oy, oz, dx, dy, dz);
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
          const r = rayTri(this, this.T, this.order[i] * 9, ox, oy, oz, dx, dy, dz);
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

/** Does triangle a come before b in the order (centroid on k0, then k1, then k2, then index)? k = -1 skips. */
function keyLess(cen: Float64Array, a: number, b: number, k0: number, k1: number, k2: number): boolean {
  if (k0 >= 0) { const x = cen[a * 3 + k0], y = cen[b * 3 + k0]; if (x !== y) return x < y; }
  if (k1 >= 0) { const x = cen[a * 3 + k1], y = cen[b * 3 + k1]; if (x !== y) return x < y; }
  if (k2 >= 0) { const x = cen[a * 3 + k2], y = cen[b * 3 + k2]; if (x !== y) return x < y; }
  return a < b;
}

/**
 * The first zero coordinate on axis c in arrival order (triangles by keyLess, corners in order) among o[lo..hi): -0 or
 * +0. Only called when the range has a zero on that axis.
 */
function firstZero(T: Float64Array, o: Int32Array, lo: number, hi: number, cen: Float64Array, c: number, k0: number, k1: number, k2: number): number {
  let best = -1;
  for (let i = lo; i < hi; i++) {
    const t = o[i], b = t * 9;
    if (T[b + c] !== 0 && T[b + 3 + c] !== 0 && T[b + 6 + c] !== 0) continue;
    if (best < 0 || keyLess(cen, t, best, k0, k1, k2)) best = t;
  }
  const b = best * 9;
  return T[b + c] === 0 ? T[b + c] : T[b + 3 + c] === 0 ? T[b + 3 + c] : T[b + 6 + c];
}

/**
 * Quickselect on o[l..r] (inclusive) under keyLess: afterwards o[l..k-1] hold the k - l smallest. The key is a total
 * order, so the halves are the same sets whatever the pivots. Falls back to a full sort after many rounds.
 */
function selectKey(o: Int32Array, l: number, r: number, k: number, cen: Float64Array, k0: number, k1: number, k2: number) {
  const lo0 = l, hi0 = r;
  let rounds = 0;
  while (r > l) {
    if (++rounds > 64) {
      const sub = Array.from(o.subarray(lo0, hi0 + 1)).sort((a, b) => (keyLess(cen, a, b, k0, k1, k2) ? -1 : keyLess(cen, b, a, k0, k1, k2) ? 1 : 0));
      o.set(sub, lo0);
      return;
    }
    const m = (l + r) >> 1;
    // median of three into o[m]
    let t: number;
    if (keyLess(cen, o[m], o[l], k0, k1, k2)) { t = o[m]; o[m] = o[l]; o[l] = t; }
    if (keyLess(cen, o[r], o[l], k0, k1, k2)) { t = o[r]; o[r] = o[l]; o[l] = t; }
    if (keyLess(cen, o[r], o[m], k0, k1, k2)) { t = o[r]; o[r] = o[m]; o[m] = t; }
    const pv = o[m];
    let i = l, j = r;
    while (i <= j) {
      while (keyLess(cen, o[i], pv, k0, k1, k2)) i++;
      while (keyLess(cen, pv, o[j], k0, k1, k2)) j--;
      if (i <= j) { t = o[i]; o[i] = o[j]; o[j] = t; i++; j--; }
    }
    if (k <= j) r = j; else if (k >= i) l = i; else break;
  }
}

/**
 * Barycentric margin around a triangle's edges: a Möller–Trumbore hit whose coordinates are within it of an edge (or
 * outside by less) is decided by TriBVH.crossesTri instead, so rays through shared edges and vertices are handled
 * watertight; everywhere else the Möller–Trumbore verdict stands (it agrees there).
 */
export const EDGE_BAND = 1e-9;

const axisOf = (k: number, x: number, y: number, z: number) => (k === 0 ? x : k === 1 ? y : z);

/** Möller–Trumbore, two-sided, watertight on edges (see EDGE_BAND). Returns [t, u, v] or null. */
function rayTri(bvh: TriBVH, T: Float64Array, o: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number) {
  const e1x = T[o + 3] - T[o], e1y = T[o + 4] - T[o + 1], e1z = T[o + 5] - T[o + 2];
  const e2x = T[o + 6] - T[o], e2y = T[o + 7] - T[o + 1], e2z = T[o + 8] - T[o + 2];
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-18) return null;
  const inv = 1 / det;
  const tx = ox - T[o], ty = oy - T[o + 1], tz = oz - T[o + 2];
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < -EDGE_BAND || u > 1 + EDGE_BAND) return null;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < -EDGE_BAND || u + v > 1 + EDGE_BAND) return null;
  if ((u < EDGE_BAND || v < EDGE_BAND || u + v > 1 - EDGE_BAND) && !bvh.crossesTri(o / 9, ox, oy, oz, dx, dy, dz)) return null;
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
