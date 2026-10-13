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

/** Most triangles in a leaf: a range this small is not split. */
const BVH_LEAF = 4;
/** SAH bins per axis. */
const BVH_BINS = 16;
/** Below this depth splits follow the SAH; deeper ranges are halved at their centroid median (bounds the depth). */
const BVH_SAH_DEPTH = 48;

/** The arrays a TriBVH's queries read (RayScene.toArrays shares them with worker threads). */
export interface TriBVHArrays {
  T: Float64Array; nodes: Float64Array; child: Int32Array; order: Int32Array; triPt?: Int32Array; triPrim?: Uint32Array;
}

/**
 * Bounding volume hierarchy over the triangles of a geometry (triangulated polygons), built with the surface area
 * heuristic: every range of more than BVH_LEAF triangles is split where the binned SAH (BVH_BINS centroid bins on the
 * axis of widest centroid spread) is cheapest, so rays and closest-point queries visit few nodes. Binning all three
 * axes was measured too: ~1.7× the build time for a few percent faster queries, not worth it here. Layout: node n has
 * bounds nodes[6n..6n+5] (min xyz, max xyz) and children child[2n], child[2n+1]; a leaf stores -1 - start and its
 * count, its triangles being order[start .. start+count). Nodes are numbered depth first (a node before its subtrees,
 * left subtree first); within a leaf the triangles keep ascending index order (stable partitions). Depth is at most
 * BVH_SAH_DEPTH + log2(triangles) + 1, so the fixed traversal stacks of RayScene (512) suffice. The build is
 * deterministic.
 */
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
  /** traversal stack of closest() (grown on demand) */
  private cstack = new Int32Array(128);
  /** traversal stack and hit scratch of raycast() / raycastAll() */
  private rstack = new Int32Array(128);
  private rhit = new Float64Array(3);

  constructor(g: Geometry) {
    const { tris, triPrim } = triangulate(g);
    const P = g.P, nt = tris.length / 3, vpt = g.vertexPoint;
    this.T = new Float64Array(nt * 9);
    this.triPrim = triPrim;
    this.triVtx = tris;
    this.triPt = new Int32Array(nt * 3);
    for (let t = 0; t < nt; t++)
      for (let k = 0; k < 3; k++) {
        const pt = vpt[tris[t * 3 + k]], p = pt * 3;
        this.triPt[t * 3 + k] = pt;
        this.T[t * 9 + k * 3] = P[p]; this.T[t * 9 + k * 3 + 1] = P[p + 1]; this.T[t * 9 + k * 3 + 2] = P[p + 2];
      }
    this.order = new Int32Array(nt);
    for (let t = 0; t < nt; t++) this.order[t] = t;
    this.nodes = new Float64Array(6);
    this.child = new Int32Array(2);
    if (nt) this.build(nt);
  }

  /**
   * A BVH over arrays from another TriBVH (TriBVH.arrays(), e.g. shared with a worker thread): no build. Ray queries,
   * the watertight edge test (it needs T and triPt) and closest-point queries work; triVtx is empty.
   */
  static fromArrays(a: TriBVHArrays): TriBVH {
    const bvh = Object.create(TriBVH.prototype) as TriBVH;
    const nt = a.order.length;
    Object.assign(bvh as any, {
      T: a.T, nodes: a.nodes, child: a.child, order: a.order, triPt: a.triPt ?? new Int32Array(0),
      triPrim: a.triPrim ?? Uint32Array.from({ length: nt }, (_, i) => i), triVtx: new Uint32Array(0),
      nodeCount: a.nodes.length / 6, edgeNbr: null,
      cstack: new Int32Array(128), rstack: new Int32Array(128), rhit: new Float64Array(3),
    });
    return bvh;
  }

  /** The arrays the queries read (fromArrays rebuilds a BVH over them). */
  arrays(): Required<TriBVHArrays> {
    return { T: this.T, nodes: this.nodes, child: this.child, order: this.order, triPt: this.triPt, triPrim: this.triPrim };
  }

  get numTris() { return this.order.length; }

  /**
   * Binned SAH build (see the class comment). Each range bins its triangles by centroid along the axis where the
   * centroids spread most (BVH_BINS bins, each with its triangles' bounds), takes the cheapest split
   * area(left) · count(left) + area(right) · count(right), and partitions stably; the children's bounds come from the
   * bins and their centroid bounds from the partition pass, so every level costs two passes over its triangles.
   */
  private build(nt: number) {
    const T = this.T, order = this.order;
    // per-triangle bounds and centroids
    const tb = new Float64Array(nt * 6), cen = new Float64Array(nt * 3);
    let mn0 = Infinity, mn1 = Infinity, mn2 = Infinity, mx0 = -Infinity, mx1 = -Infinity, mx2 = -Infinity;
    let cn0 = Infinity, cn1 = Infinity, cn2 = Infinity, cx0 = -Infinity, cx1 = -Infinity, cx2 = -Infinity;
    for (let t = 0; t < nt; t++) {
      const o = t * 9, b = t * 6, q = t * 3;
      for (let c = 0; c < 3; c++) {
        const x = T[o + c], y = T[o + 3 + c], z = T[o + 6 + c];
        let mn = x, mx = x;
        if (y < mn) mn = y; if (y > mx) mx = y;
        if (z < mn) mn = z; if (z > mx) mx = z;
        tb[b + c] = mn; tb[b + 3 + c] = mx;
        cen[q + c] = (x + y + z) / 3;
      }
      let v = tb[b]; if (v < mn0) mn0 = v;
      v = tb[b + 1]; if (v < mn1) mn1 = v;
      v = tb[b + 2]; if (v < mn2) mn2 = v;
      v = tb[b + 3]; if (v > mx0) mx0 = v;
      v = tb[b + 4]; if (v > mx1) mx1 = v;
      v = tb[b + 5]; if (v > mx2) mx2 = v;
      v = cen[q]; if (v < cn0) cn0 = v; if (v > cx0) cx0 = v;
      v = cen[q + 1]; if (v < cn1) cn1 = v; if (v > cx1) cx1 = v;
      v = cen[q + 2]; if (v < cn2) cn2 = v; if (v > cx2) cx2 = v;
    }
    const maxNodes = 2 * nt - 1;
    const nodes = new Float64Array(maxNodes * 6), child = new Int32Array(maxNodes * 2);
    const tmp = new Int32Array(nt);
    const B = BVH_BINS;
    const bcnt = new Int32Array(B), bbox = new Float64Array(B * 6), rbox = new Float64Array(B * 6), rcnt = new Int32Array(B);
    // ranges to build: (lo, hi, child slot receiving the id or -1, depth) and their node + centroid bounds (12 numbers)
    let st = new Int32Array(4 * 64), sb = new Float64Array(12 * 64), sp = 0, count = 0;
    const push = (lo: number, hi: number, slot: number, depth: number, bx: ArrayLike<number>, bo: number) => {
      if ((sp + 1) * 4 > st.length) {
        const g = new Int32Array(st.length * 2), h = new Float64Array(sb.length * 2);
        g.set(st); h.set(sb); st = g; sb = h;
      }
      st[sp * 4] = lo; st[sp * 4 + 1] = hi; st[sp * 4 + 2] = slot; st[sp * 4 + 3] = depth;
      for (let k = 0; k < 12; k++) sb[sp * 12 + k] = bx[bo + k];
      sp++;
    };
    const rootBox = [mn0, mn1, mn2, mx0, mx1, mx2, cn0, cn1, cn2, cx0, cx1, cx2];
    push(0, nt, -1, 0, rootBox, 0);
    const kids = new Float64Array(24); // left then right: node bounds, centroid bounds
    while (sp > 0) {
      sp--;
      const lo = st[sp * 4], hi = st[sp * 4 + 1], slot = st[sp * 4 + 2], depth = st[sp * 4 + 3], so = sp * 12;
      const id = count++;
      if (slot >= 0) child[slot] = id;
      const nb = id * 6;
      for (let k = 0; k < 6; k++) nodes[nb + k] = sb[so + k];
      const n = hi - lo;
      if (n <= BVH_LEAF) { child[id * 2] = -1 - lo; child[id * 2 + 1] = n; continue; }
      const c0 = sb[so + 6], c1 = sb[so + 7], c2 = sb[so + 8], e0 = sb[so + 9] - c0, e1 = sb[so + 10] - c1, e2 = sb[so + 11] - c2;
      // the axis where the centroids spread most (NaN extents count as 0)
      const ax = e0 >= e1 && e0 >= e2 ? 0 : e1 >= e2 ? 1 : 2;
      const ext = ax === 0 ? e0 : ax === 1 ? e1 : e2, cmin = ax === 0 ? c0 : ax === 1 ? c1 : c2;
      let mid = -1;
      if (depth < BVH_SAH_DEPTH && ext > 0 && ext < Infinity) {
        const k = B / ext;
        bcnt.fill(0);
        for (let j = 0; j < B * 6; j += 6) {
          bbox[j] = bbox[j + 1] = bbox[j + 2] = Infinity;
          bbox[j + 3] = bbox[j + 4] = bbox[j + 5] = -Infinity;
        }
        for (let i = lo; i < hi; i++) {
          const t = order[i], b = t * 6, f = (cen[t * 3 + ax] - cmin) * k;
          // bin(c) = floor((c - min) · B / extent), clamped; NaN → 0
          const j = f >= B ? B - 1 : f | 0, o = j * 6;
          bcnt[j]++;
          let v = tb[b]; if (v < bbox[o]) bbox[o] = v;
          v = tb[b + 1]; if (v < bbox[o + 1]) bbox[o + 1] = v;
          v = tb[b + 2]; if (v < bbox[o + 2]) bbox[o + 2] = v;
          v = tb[b + 3]; if (v > bbox[o + 3]) bbox[o + 3] = v;
          v = tb[b + 4]; if (v > bbox[o + 4]) bbox[o + 4] = v;
          v = tb[b + 5]; if (v > bbox[o + 5]) bbox[o + 5] = v;
        }
        // suffix unions (bins j..B-1), then the prefix sweep picks the cheapest split
        let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity, c = 0;
        for (let j = B - 1; j > 0; j--) {
          const o = j * 6;
          if (bbox[o] < x0) x0 = bbox[o]; if (bbox[o + 1] < y0) y0 = bbox[o + 1]; if (bbox[o + 2] < z0) z0 = bbox[o + 2];
          if (bbox[o + 3] > x1) x1 = bbox[o + 3]; if (bbox[o + 4] > y1) y1 = bbox[o + 4]; if (bbox[o + 5] > z1) z1 = bbox[o + 5];
          c += bcnt[j];
          rcnt[j] = c;
          rbox[o] = x0; rbox[o + 1] = y0; rbox[o + 2] = z0; rbox[o + 3] = x1; rbox[o + 4] = y1; rbox[o + 5] = z1;
        }
        let best = Infinity, split = -1;
        x0 = y0 = z0 = Infinity; x1 = y1 = z1 = -Infinity; c = 0;
        for (let j = 0; j < B - 1; j++) {
          const o = j * 6;
          if (bbox[o] < x0) x0 = bbox[o]; if (bbox[o + 1] < y0) y0 = bbox[o + 1]; if (bbox[o + 2] < z0) z0 = bbox[o + 2];
          if (bbox[o + 3] > x1) x1 = bbox[o + 3]; if (bbox[o + 4] > y1) y1 = bbox[o + 4]; if (bbox[o + 5] > z1) z1 = bbox[o + 5];
          c += bcnt[j];
          const rc = rcnt[j + 1];
          if (!c || !rc) continue;
          const r = (j + 1) * 6;
          const rArea = boxArea(rbox[r], rbox[r + 1], rbox[r + 2], rbox[r + 3], rbox[r + 4], rbox[r + 5]);
          const cost = boxArea(x0, y0, z0, x1, y1, z1) * c + rArea * rc;
          if (cost < best) {
            best = cost; split = j;
            kids[0] = x0; kids[1] = y0; kids[2] = z0; kids[3] = x1; kids[4] = y1; kids[5] = z1;
            for (let q = 0; q < 6; q++) kids[12 + q] = rbox[r + q];
          }
        }
        if (split >= 0) {
          // stable partition (bins <= split to the left), gathering the children's centroid bounds
          let l = lo, r = 0;
          let a0 = Infinity, a1 = Infinity, a2 = Infinity, b0 = -Infinity, b1 = -Infinity, b2 = -Infinity;
          let p0 = Infinity, p1 = Infinity, p2 = Infinity, q0 = -Infinity, q1 = -Infinity, q2 = -Infinity;
          for (let i = lo; i < hi; i++) {
            const t = order[i], q = t * 3, f = (cen[q + ax] - cmin) * k;
            const x = cen[q], y = cen[q + 1], z = cen[q + 2];
            if ((f >= B ? B - 1 : f | 0) <= split) {
              order[l++] = t;
              if (x < a0) a0 = x; if (x > b0) b0 = x; if (y < a1) a1 = y; if (y > b1) b1 = y; if (z < a2) a2 = z; if (z > b2) b2 = z;
            } else {
              tmp[r++] = t;
              if (x < p0) p0 = x; if (x > q0) q0 = x; if (y < p1) p1 = y; if (y > q1) q1 = y; if (z < p2) p2 = z; if (z > q2) q2 = z;
            }
          }
          for (let i = 0; i < r; i++) order[l + i] = tmp[i];
          mid = l;
          kids[6] = a0; kids[7] = a1; kids[8] = a2; kids[9] = b0; kids[10] = b1; kids[11] = b2;
          kids[18] = p0; kids[19] = p1; kids[20] = p2; kids[21] = q0; kids[22] = q1; kids[23] = q2;
        }
      }
      if (mid < 0) {
        // no usable SAH split (all centroids in one bin, or too deep): halve at the median centroid on that axis
        mid = (lo + hi) >> 1;
        medianSplit(order, tmp, lo, hi, mid, cen, ax);
        rangeBounds(order, lo, mid, tb, cen, kids, 0);
        rangeBounds(order, mid, hi, tb, cen, kids, 12);
      }
      // right pushed first so the left subtree is numbered (and built) first
      push(mid, hi, id * 2 + 1, depth + 1, kids, 12);
      push(lo, mid, id * 2, depth + 1, kids, 0);
    }
    this.nodeCount = count;
    this.nodes = nodes.slice(0, count * 6);
    this.child = child.slice(0, count * 2);
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

  /** Squared distance from (x, y, z) to node n's box. */
  private boxDist2(n: number, x: number, y: number, z: number) {
    const b = this.nodes, i = n * 6;
    let d = b[i] - x, e = x - b[i + 3];
    const dx = d > e ? (d > 0 ? d : 0) : e > 0 ? e : 0;
    d = b[i + 1] - y; e = y - b[i + 4];
    const dy = d > e ? (d > 0 ? d : 0) : e > 0 ? e : 0;
    d = b[i + 2] - z; e = z - b[i + 5];
    const dz = d > e ? (d > 0 ? d : 0) : e > 0 ? e : 0;
    return dx * dx + dy * dy + dz * dz;
  }

  /**
   * closest() without allocations: the triangle of the closest surface point within maxDist (-1 when none), its
   * squared distance, position and barycentrics written to out. Same traversal (nearer child first) and ties (the
   * first triangle found keeps it) as closest().
   */
  closestInto(x: number, y: number, z: number, maxDist: number, out: ClosestScratch): number {
    if (!this.numTris) return -1;
    let best2 = maxDist === Infinity ? Infinity : maxDist * maxDist, bestT = -1;
    const tmp = out.tmp, tb = out.tmpBary, child = this.child, order = this.order, T = this.T;
    let st = this.cstack, sp = 0;
    st[sp++] = 0;
    while (sp > 0) {
      const n = st[--sp];
      if (this.boxDist2(n, x, y, z) >= best2) continue;
      const c0 = child[n * 2], c1 = child[n * 2 + 1];
      if (c0 < 0) {
        const s = -1 - c0;
        for (let i = s; i < s + c1; i++) {
          const t = order[i];
          const d2 = closestOnTri(T, t * 9, x, y, z, tmp, tb);
          if (d2 < best2) { best2 = d2; bestT = t; out.x = tmp[0]; out.y = tmp[1]; out.z = tmp[2]; out.b0 = tb[0]; out.b1 = tb[1]; out.b2 = tb[2]; }
        }
      } else {
        if (sp + 2 > st.length) { const g = new Int32Array(st.length * 2); g.set(st); this.cstack = st = g; }
        const d0 = this.boxDist2(c0, x, y, z), d1 = this.boxDist2(c1, x, y, z);
        if (d0 < d1) { st[sp++] = c1; st[sp++] = c0; } else { st[sp++] = c0; st[sp++] = c1; }
      }
    }
    out.d2 = best2;
    return bestT;
  }

  closest(x: number, y: number, z: number, maxDist = Infinity): ClosestHit | null {
    const s = closestScratch();
    const t = this.closestInto(x, y, z, maxDist, s);
    if (t < 0) return null;
    return { dist: Math.sqrt(s.d2), pos: [s.x, s.y, s.z], tri: t, prim: this.triPrim[t], bary: [s.b0, s.b1, s.b2] };
  }

  /** Nearest hit along a ray (dir need not be normalised; t is in units of |dir|). */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tmax = Infinity, tmin = 1e-9): RayHit | null {
    if (!this.numTris) return null;
    let bestT = tmax, bestTri = -1, bu = 0, bv = 0;
    const ix = invDir(dx), iy = invDir(dy), iz = invDir(dz), child = this.child, order = this.order, T = this.T, h = this.rhit;
    let st = this.rstack, sp = 0;
    st[sp++] = 0;
    while (sp > 0) {
      const n = st[--sp];
      if (!this.rayBox(n, ox, oy, oz, ix, iy, iz, bestT)) continue;
      const c0 = child[n * 2], c1 = child[n * 2 + 1];
      if (c0 < 0) {
        const s = -1 - c0;
        for (let i = s; i < s + c1; i++) {
          const t = order[i];
          if (rayTri(this, T, t * 9, ox, oy, oz, dx, dy, dz, h) && h[0] > tmin && h[0] < bestT) { bestT = h[0]; bestTri = t; bu = h[1]; bv = h[2]; }
        }
      } else {
        if (sp + 2 > st.length) { const g = new Int32Array(st.length * 2); g.set(st); this.rstack = st = g; }
        st[sp++] = c0; st[sp++] = c1;
      }
    }
    if (bestTri < 0) return null;
    return { t: bestT, tri: bestTri, prim: this.triPrim[bestTri], u: bu, v: bv, pos: [ox + dx * bestT, oy + dy * bestT, oz + dz * bestT] };
  }

  /** All ray-parameter hits (sorted), for inside/outside parity tests. */
  raycastAll(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number[] {
    const hits: number[] = [];
    if (!this.numTris) return hits;
    const ix = invDir(dx), iy = invDir(dy), iz = invDir(dz), child = this.child, order = this.order, T = this.T, h = this.rhit;
    let st = this.rstack, sp = 0;
    st[sp++] = 0;
    while (sp > 0) {
      const n = st[--sp];
      if (!this.rayBox(n, ox, oy, oz, ix, iy, iz, Infinity)) continue;
      const c0 = child[n * 2], c1 = child[n * 2 + 1];
      if (c0 < 0) {
        const s = -1 - c0;
        for (let i = s; i < s + c1; i++) if (rayTri(this, T, order[i] * 9, ox, oy, oz, dx, dy, dz, h) && h[0] > 0) hits.push(h[0]);
      } else {
        if (sp + 2 > st.length) { const g = new Int32Array(st.length * 2); g.set(st); this.rstack = st = g; }
        st[sp++] = c0; st[sp++] = c1;
      }
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

  /** Does the ray enter node n's box within [0, tmax]? (slabs; an axis the ray lies in a face plane of is unconstrained) */
  private rayBox(n: number, ox: number, oy: number, oz: number, ix: number, iy: number, iz: number, tmax: number) {
    const b = this.nodes, i = n * 6;
    let t0 = 0, t1 = tmax, s: number;
    let ta = (b[i] - ox) * ix, tb = (b[i + 3] - ox) * ix;
    if (ta > tb) { s = ta; ta = tb; tb = s; }
    if (ta !== ta) ta = -Infinity;
    if (tb !== tb) tb = Infinity;
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1 * 1.0000001 + 1e-12) return false;
    ta = (b[i + 1] - oy) * iy; tb = (b[i + 4] - oy) * iy;
    if (ta > tb) { s = ta; ta = tb; tb = s; }
    if (ta !== ta) ta = -Infinity;
    if (tb !== tb) tb = Infinity;
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1 * 1.0000001 + 1e-12) return false;
    ta = (b[i + 2] - oz) * iz; tb = (b[i + 5] - oz) * iz;
    if (ta > tb) { s = ta; ta = tb; tb = s; }
    if (ta !== ta) ta = -Infinity;
    if (tb !== tb) tb = Infinity;
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    return !(t0 > t1 * 1.0000001 + 1e-12);
  }
}

/**
 * 1 / d for slab tests, with +Infinity for a zero component of either sign. With -0 the slab products of a ray lying
 * exactly in a box's face plane came out as (NaN, -Infinity) and culled the box: a vertical ray (direction (-0, 1, -0),
 * e.g. the negated (0, -1, 0)) through a terrain vertex on a leaf boundary missed the terrain.
 */
export const invDir = (d: number): number => (d === 0 ? Infinity : 1 / d);

/** Scratch result of TriBVH.closestInto (reused across queries). */
export interface ClosestScratch {
  d2: number; x: number; y: number; z: number; b0: number; b1: number; b2: number;
  tmp: number[]; tmpBary: number[];
}

export function closestScratch(): ClosestScratch {
  return { d2: Infinity, x: 0, y: 0, z: 0, b0: 0, b1: 0, b2: 0, tmp: [0, 0, 0], tmpBary: [0, 0, 0] };
}

/** Half the surface area of a box (the SAH only compares them). */
function boxArea(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  return dx * dy + dy * dz + dz * dx;
}

/**
 * Split order[lo..hi) at mid: the mid - lo triangles first in (centroid on axis ax, index) order (NaN centroids last) go
 * to the front, both halves keeping their relative order (stable).
 */
/** Bounds of the triangles order[lo..hi) (from their boxes tb) and of their centroids, into out[o..o+11]. */
function rangeBounds(order: Int32Array, lo: number, hi: number, tb: Float64Array, cen: Float64Array, out: Float64Array, o: number) {
  let mn0 = Infinity, mn1 = Infinity, mn2 = Infinity, mx0 = -Infinity, mx1 = -Infinity, mx2 = -Infinity;
  let cn0 = Infinity, cn1 = Infinity, cn2 = Infinity, cx0 = -Infinity, cx1 = -Infinity, cx2 = -Infinity;
  for (let i = lo; i < hi; i++) {
    const t = order[i], b = t * 6, q = t * 3;
    let v = tb[b]; if (v < mn0) mn0 = v;
    v = tb[b + 1]; if (v < mn1) mn1 = v;
    v = tb[b + 2]; if (v < mn2) mn2 = v;
    v = tb[b + 3]; if (v > mx0) mx0 = v;
    v = tb[b + 4]; if (v > mx1) mx1 = v;
    v = tb[b + 5]; if (v > mx2) mx2 = v;
    v = cen[q]; if (v < cn0) cn0 = v; if (v > cx0) cx0 = v;
    v = cen[q + 1]; if (v < cn1) cn1 = v; if (v > cx1) cx1 = v;
    v = cen[q + 2]; if (v < cn2) cn2 = v; if (v > cx2) cx2 = v;
  }
  out[o] = mn0; out[o + 1] = mn1; out[o + 2] = mn2; out[o + 3] = mx0; out[o + 4] = mx1; out[o + 5] = mx2;
  out[o + 6] = cn0; out[o + 7] = cn1; out[o + 8] = cn2; out[o + 9] = cx0; out[o + 10] = cx1; out[o + 11] = cx2;
}

function medianSplit(order: Int32Array, tmp: Int32Array, lo: number, hi: number, mid: number, cen: Float64Array, ax: number) {
  const less = (a: number, b: number) => {
    const x = cen[a * 3 + ax], y = cen[b * 3 + ax], xn = x !== x, yn = y !== y;
    if (xn || yn) return xn && yn ? a < b : yn;
    return x !== y ? x < y : a < b;
  };
  const sorted = order.slice(lo, hi).sort((a, b) => (less(a, b) ? -1 : 1));
  const pivot = sorted[mid - lo - 1];
  let l = lo, r = 0;
  for (let i = lo; i < hi; i++) {
    const t = order[i];
    if (t === pivot || less(t, pivot)) order[l++] = t; else tmp[r++] = t;
  }
  for (let i = 0; i < r; i++) order[l + i] = tmp[i];
}

/**
 * Barycentric margin around a triangle's edges: a Möller–Trumbore hit whose coordinates are within it of an edge (or
 * outside by less) is decided by TriBVH.crossesTri instead, so rays through shared edges and vertices are handled
 * watertight; everywhere else the Möller–Trumbore verdict stands (it agrees there).
 */
export const EDGE_BAND = 1e-9;

const axisOf = (k: number, x: number, y: number, z: number) => (k === 0 ? x : k === 1 ? y : z);

/** Möller–Trumbore, two-sided, watertight on edges (see EDGE_BAND). On a hit writes [t, u, v] to out and returns true. */
function rayTri(
  bvh: TriBVH, T: Float64Array, o: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, out: Float64Array,
): boolean {
  const e1x = T[o + 3] - T[o], e1y = T[o + 4] - T[o + 1], e1z = T[o + 5] - T[o + 2];
  const e2x = T[o + 6] - T[o], e2y = T[o + 7] - T[o + 1], e2z = T[o + 8] - T[o + 2];
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-18) return false;
  const inv = 1 / det;
  const tx = ox - T[o], ty = oy - T[o + 1], tz = oz - T[o + 2];
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < -EDGE_BAND || u > 1 + EDGE_BAND) return false;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < -EDGE_BAND || u + v > 1 + EDGE_BAND) return false;
  if ((u < EDGE_BAND || v < EDGE_BAND || u + v > 1 - EDGE_BAND) && !bvh.crossesTri(o / 9, ox, oy, oz, dx, dy, dz)) return false;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  out[0] = t; out[1] = u; out[2] = v;
  return true;
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
