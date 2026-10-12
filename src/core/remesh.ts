// Isotropic remeshing (Botsch & Kobbelt 2004, "A remeshing approach to multiresolution modeling") and the
// closest-point BVH it projects with.
//
// remeshTriangles() is the kernel: typed arrays in, typed arrays out, no Geometry. It is the single function a
// native (Rust/WASM) remesher would replace. isotropicRemesh() wraps it for Geometry: triangulation, feature, seam
// and border detection (constraint and lock flags), the target-length field, and the attribute-preserving rebuild
// (GeoBuilder provenance from each output point's final closest-point projection onto the input surface).
//
// Kernel loop, per iteration (L = target length, per vertex when adaptive; an edge uses the mean of its ends):
//   1. split edges longer than 4/3 L at their midpoint (repeated until none is left, at most 10 rounds)
//   2. collapse edges shorter than 4/5 L when no edge of the result gets longer than 4/3 L (link condition,
//      valence, normal-flip and feature checks; the lower-valence end goes)
//   3. flip edges when that brings the four vertices closer to valence 6 (4 on boundaries)
//   4. tangential relaxation: move each free vertex to the (target-weighted) centroid of its neighbours, in its
//      tangent plane; vertices on a constraint curve move along the curve only; corners and locked vertices stay
//   5. project back: free vertices onto the closest point of the input triangles, curve vertices onto the closest
//      input constraint segment (both through a BVH, starting from the previous hit)
// Constraint edges (features, seams, resampled boundaries) are never flipped, are split like other edges (the new
// vertex joins the curve) and are only collapsed along the curve. Locked edges (preserved boundaries, group borders,
// non-manifold edges) are never touched and their vertices never move.
import { GeoBuilder } from './geometry.ts';
import type { Attribute, Geometry, Src } from './geometry.ts';
import { EDGE_KEY_LIMIT, edgeList } from './edges.ts';
import type { EdgeSet } from './edges.ts';
import { triangulate } from './topology.ts';

// ---------------------------------------------------------------- closest-point BVH

const LEAF = 4;

/**
 * Allocation-free BVH over triangles (stride 3) or segments (stride 2) for closest-point and box-overlap
 * queries. Items are given as corner positions (stride * 3 floats per item). After closest(), the hit point is
 * (px, py, pz), its squared distance d2 and its barycentrics (b0, b1, b2) on the item's corners (b2 = 0 for
 * segments).
 */
export class ClosestBVH {
  readonly stride: number;
  readonly V: Float64Array;
  readonly count: number;
  private order: Int32Array;
  private bmin: Float64Array;
  private bmax: Float64Array;
  /** internal node: left child; leaf: -1 */
  private left: Int32Array;
  /** internal node: right child; leaf: first index into order */
  private right: Int32Array;
  private leafN: Int32Array;
  private nodes = 0;
  private stack = new Int32Array(512);
  px = 0; py = 0; pz = 0; d2 = Infinity; b0 = 0; b1 = 0; b2 = 0;
  // scratch result of the last item test
  private tx = 0; private ty = 0; private tz = 0; private t0 = 0; private t1 = 0; private t2 = 0;

  constructor(V: Float64Array, stride: 2 | 3) {
    this.stride = stride;
    this.V = V;
    const n = (this.count = V.length / (stride * 3));
    this.order = new Int32Array(n);
    for (let i = 0; i < n; i++) this.order[i] = i;
    const cap = Math.max(1, 2 * Math.ceil(n / LEAF) + 2) * 2;
    this.bmin = new Float64Array(cap * 3);
    this.bmax = new Float64Array(cap * 3);
    this.left = new Int32Array(cap);
    this.right = new Int32Array(cap);
    this.leafN = new Int32Array(cap);
    if (!n) return;
    const cen = new Float64Array(n * 3), s3 = stride * 3;
    for (let i = 0; i < n; i++)
      for (let c = 0; c < 3; c++) {
        let acc = 0;
        for (let k = 0; k < stride; k++) acc += V[i * s3 + k * 3 + c];
        cen[i * 3 + c] = acc / stride;
      }
    this.build(0, n, cen);
  }

  private build(lo: number, hi: number, cen: Float64Array): number {
    const id = this.nodes++;
    const V = this.V, o = this.order, s = this.stride, s3 = s * 3;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = lo; i < hi; i++) {
      const b = o[i] * s3;
      for (let k = 0; k < s3; k += 3) {
        const x = V[b + k], y = V[b + k + 1], z = V[b + k + 2];
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (z < z0) z0 = z; if (z > z1) z1 = z;
      }
    }
    this.bmin[id * 3] = x0; this.bmin[id * 3 + 1] = y0; this.bmin[id * 3 + 2] = z0;
    this.bmax[id * 3] = x1; this.bmax[id * 3 + 1] = y1; this.bmax[id * 3 + 2] = z1;
    if (hi - lo <= LEAF) {
      this.left[id] = -1;
      this.right[id] = lo;
      this.leafN[id] = hi - lo;
      return id;
    }
    let c0 = Infinity, c1 = Infinity, c2 = Infinity, d0 = -Infinity, d1 = -Infinity, d2 = -Infinity;
    for (let i = lo; i < hi; i++) {
      const b = o[i] * 3, x = cen[b], y = cen[b + 1], z = cen[b + 2];
      if (x < c0) c0 = x; if (x > d0) d0 = x;
      if (y < c1) c1 = y; if (y > d1) d1 = y;
      if (z < c2) c2 = z; if (z > d2) d2 = z;
    }
    const ex = d0 - c0, ey = d1 - c1, ez = d2 - c2;
    const ax = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
    const mid = (lo + hi) >> 1;
    this.select(lo, hi - 1, mid, ax, cen);
    const l = this.build(lo, mid, cen);
    const r = this.build(mid, hi, cen);
    this.left[id] = l;
    this.right[id] = r;
    return id;
  }

  private select(l: number, r: number, k: number, ax: number, cen: Float64Array) {
    const o = this.order;
    while (r > l) {
      const pv = cen[o[(l + r) >> 1] * 3 + ax];
      let i = l, j = r;
      while (i <= j) {
        while (cen[o[i] * 3 + ax] < pv) i++;
        while (cen[o[j] * 3 + ax] > pv) j--;
        if (i <= j) { const t = o[i]; o[i] = o[j]; o[j] = t; i++; j--; }
      }
      if (k <= j) r = j; else if (k >= i) l = i; else break;
    }
  }

  private boxDist2(n: number, x: number, y: number, z: number): number {
    const a = this.bmin, b = this.bmax, i = n * 3;
    let d = 0, t = a[i] - x;
    if (t > 0) d += t * t; else { t = x - b[i]; if (t > 0) d += t * t; }
    t = a[i + 1] - y;
    if (t > 0) d += t * t; else { t = y - b[i + 1]; if (t > 0) d += t * t; }
    t = a[i + 2] - z;
    if (t > 0) d += t * t; else { t = z - b[i + 2]; if (t > 0) d += t * t; }
    return d;
  }

  /** Squared distance from (x, y, z) to item i; the closest point and barycentrics go to the scratch fields. */
  itemDist2(i: number, x: number, y: number, z: number): number {
    return this.stride === 3 ? this.triDist2(i * 9, x, y, z) : this.segDist2(i * 6, x, y, z);
  }

  /** Closest point to (x, y, z) on item i alone; results in px/py/pz, d2, b0/b1/b2 like closest(). */
  onItem(i: number, x: number, y: number, z: number): number {
    const d = this.itemDist2(i, x, y, z);
    this.px = this.tx; this.py = this.ty; this.pz = this.tz; this.d2 = d; this.b0 = this.t0; this.b1 = this.t1; this.b2 = this.t2;
    return d;
  }

  private segDist2(o: number, x: number, y: number, z: number): number {
    const V = this.V;
    const ax = V[o], ay = V[o + 1], az = V[o + 2];
    const dx = V[o + 3] - ax, dy = V[o + 4] - ay, dz = V[o + 5] - az;
    const ll = dx * dx + dy * dy + dz * dz;
    let t = ll > 0 ? ((x - ax) * dx + (y - ay) * dy + (z - az) * dz) / ll : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    this.tx = ax + dx * t; this.ty = ay + dy * t; this.tz = az + dz * t;
    this.t0 = 1 - t; this.t1 = t; this.t2 = 0;
    const ex = this.tx - x, ey = this.ty - y, ez = this.tz - z;
    return ex * ex + ey * ey + ez * ez;
  }

  /** Closest point on a triangle (Ericson, Real-Time Collision Detection 5.1.5). */
  private triDist2(o: number, px: number, py: number, pz: number): number {
    const T = this.V;
    const ax = T[o], ay = T[o + 1], az = T[o + 2], bx = T[o + 3], by = T[o + 4], bz = T[o + 5], cx = T[o + 6], cy = T[o + 7], cz = T[o + 8];
    const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
    const apx = px - ax, apy = py - ay, apz = pz - az;
    const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
    let u = 1, v = 0, w = 0;
    if (!(d1 <= 0 && d2 <= 0)) {
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
              else {
                const s = va + vb + vc;
                if (s !== 0 && Number.isFinite(s)) { const den = 1 / s; v = vb * den; w = vc * den; u = 1 - v - w; }
              }
            }
          }
        }
      }
    }
    this.tx = ax * u + bx * v + cx * w; this.ty = ay * u + by * v + cy * w; this.tz = az * u + bz * v + cz * w;
    this.t0 = u; this.t1 = v; this.t2 = w;
    const dx = this.tx - px, dy = this.ty - py, dz = this.tz - pz;
    return dx * dx + dy * dy + dz * dz;
  }

  /**
   * Closest item to (x, y, z), or -1 when there is none within sqrt(maxD2). `hint` (an item expected to be close,
   * e.g. the previous hit) tightens the search bound first. Results in px/py/pz, d2, b0/b1/b2.
   */
  closest(x: number, y: number, z: number, hint = -1, maxD2 = Infinity): number {
    let best = maxD2, bi = -1, rx = 0, ry = 0, rz = 0, r0 = 0, r1 = 0, r2 = 0;
    if (hint >= 0 && hint < this.count) {
      const d = this.itemDist2(hint, x, y, z);
      if (d < best) { best = d; bi = hint; rx = this.tx; ry = this.ty; rz = this.tz; r0 = this.t0; r1 = this.t1; r2 = this.t2; }
    }
    if (this.count) {
      const st = this.stack, L = this.left, R = this.right, o = this.order;
      let sp = 0;
      st[sp++] = 0;
      while (sp > 0) {
        const n = st[--sp];
        if (this.boxDist2(n, x, y, z) >= best) continue;
        const l = L[n];
        if (l < 0) {
          const s = R[n], e = s + this.leafN[n];
          for (let k = s; k < e; k++) {
            const it = o[k];
            if (it === bi) continue;
            const d = this.itemDist2(it, x, y, z);
            if (d < best) { best = d; bi = it; rx = this.tx; ry = this.ty; rz = this.tz; r0 = this.t0; r1 = this.t1; r2 = this.t2; }
          }
        } else {
          const r = R[n], dl = this.boxDist2(l, x, y, z), dr = this.boxDist2(r, x, y, z);
          if (sp + 2 > st.length) { const grown = new Int32Array(st.length * 2); grown.set(st); this.stack = grown; }
          const S = this.stack;
          if (dl <= dr) { if (dr < best) S[sp++] = r; if (dl < best) S[sp++] = l; }
          else { if (dl < best) S[sp++] = l; if (dr < best) S[sp++] = r; }
          if (S !== st) return this.closest(x, y, z, bi >= 0 ? bi : hint, maxD2);
        }
      }
    }
    this.px = rx; this.py = ry; this.pz = rz; this.d2 = best; this.b0 = r0; this.b1 = r1; this.b2 = r2;
    return bi;
  }

  /**
   * closest() with a shortcut for coherent queries: when the point lies within sqrt(acceptD2) of the hint item and
   * its closest point is inside the item (every barycentric >= margin, i.e. not on a side or corner, where a
   * neighbour may be closer), the hint is taken without a tree search. A point that moved a little along the surface
   * since its last query almost always passes, and staying on the hint's sheet is what a remesher wants anyway.
   */
  closestNear(x: number, y: number, z: number, hint: number, acceptD2: number, margin = 1e-6): number {
    if (hint >= 0 && hint < this.count) {
      const d = this.onItem(hint, x, y, z);
      if (d <= acceptD2 && this.b0 >= margin && this.b1 >= margin && (this.stride === 2 || this.b2 >= margin)) return hint;
    }
    return this.closest(x, y, z, hint);
  }

  /** Items whose bounding boxes overlap the box [min, max] (appended to out). */
  overlapping(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, out: number[]) {
    if (!this.count) return;
    const st: number[] = [0], A = this.bmin, B = this.bmax, o = this.order, V = this.V, s3 = this.stride * 3;
    while (st.length) {
      const n = st.pop()!, i = n * 3;
      if (A[i] > x1 || B[i] < x0 || A[i + 1] > y1 || B[i + 1] < y0 || A[i + 2] > z1 || B[i + 2] < z0) continue;
      const l = this.left[n];
      if (l >= 0) { st.push(l, this.right[n]); continue; }
      for (let k = this.right[n], e = k + this.leafN[n]; k < e; k++) {
        const it = o[k], b = it * s3;
        let ax = Infinity, ay = Infinity, az = Infinity, bx = -Infinity, by = -Infinity, bz = -Infinity;
        for (let c = 0; c < s3; c += 3) {
          const x = V[b + c], y = V[b + c + 1], z = V[b + c + 2];
          if (x < ax) ax = x; if (x > bx) bx = x;
          if (y < ay) ay = y; if (y > by) by = y;
          if (z < az) az = z; if (z > bz) bz = z;
        }
        if (ax > x1 || bx < x0 || ay > y1 || by < y0 || az > z1 || bz < z0) continue;
        out.push(it);
      }
    }
  }
}

// ---------------------------------------------------------------- kernel

/** Half-edge flags (kernel input/output). */
export const EDGE_CONSTRAINT = 1;
export const EDGE_LOCKED = 2;
export const EDGE_SEAM = 4;

const VLOCK = 1, VDEAD = 2, VBAD = 4;

export interface RemeshInput {
  /** vertex positions, 3 per vertex */
  pos: Float64Array;
  /** triangles, 3 vertex indices each, consistently wound */
  tris: Int32Array;
  /**
   * per triangle side (index 3t + k = side from corner k to corner k + 1): EDGE_CONSTRAINT (feature, seam or
   * resampled boundary: split along, never flipped, collapsed only along itself), EDGE_LOCKED (never touched, its
   * vertices never move), EDGE_SEAM (attribute seam; reported back on the output sides). Both sides of an edge
   * are OR-ed. Boundary sides without flags are treated as constraints.
   */
  edgeFlags: Uint8Array;
  /** per vertex: 1 = locked (never moves, never removed) */
  vertexLock: Uint8Array;
  /** reference surface for projection, 9 floats per triangle */
  refTris: Float64Array;
  /** a prebuilt BVH over refTris (optional; built when missing) */
  refBVH?: ClosestBVH | null;
  /** reference constraint curves, 6 floats per segment (curve vertices project onto these) */
  refSegs: Float64Array;
  /** target edge length per vertex (adaptive) or one value for all */
  target: number | Float64Array;
  /** adaptive target sampled on the reference: 3 values per reference triangle (its corners), 2 per segment */
  refTriTarget?: Float64Array | null;
  refSegTarget?: Float64Array | null;
  iterations: number;
  /** relaxation passes per iteration (each followed by a projection) */
  relaxPasses?: number;
  /** curve vertices whose two constraint edges turn by more than this (degrees) become corners */
  cornerAngle?: number;
}

export interface RemeshOutput {
  pos: Float64Array;
  tris: Int32Array;
  /** per output triangle side (3t + k), the flags carried along (see RemeshInput.edgeFlags) */
  edgeFlags: Uint8Array;
  /** per output vertex: the input vertex it still is (never moved), else -1 */
  orig: Int32Array;
  /** per output vertex: what it was last projected onto: 1 = reference triangle, 2 = segment, 0 = nothing */
  refKind: Uint8Array;
  refItem: Int32Array;
  /** barycentrics of the projection on the reference item (3 per vertex; the third is 0 for segments) */
  bary: Float64Array;
  stats: { splits: number; collapses: number; flips: number };
}

const nxt = (h: number) => (h % 3 === 2 ? h - 2 : h + 1);
const prv = (h: number) => (h % 3 === 0 ? h + 2 : h - 1);

/** Mutable triangle mesh in corner-table form: half-edge h = 3f + k runs from corner k of face f to corner k + 1. */
class IsoMesh {
  nv = 0; nf = 0;
  pos!: Float64Array;
  vOut!: Int32Array; vFlag!: Uint8Array; vCon!: Int32Array; vVal!: Int32Array; vT!: Float64Array;
  vItem!: Int32Array; vKind!: Uint8Array; vBary!: Float64Array; vOrig!: Int32Array;
  hv!: Int32Array; ho!: Int32Array; hf!: Uint8Array; fDead!: Uint8Array;
  mark!: Int32Array;
  stamp = 1;
  fanA = new Int32Array(64); fanB = new Int32Array(64);
  cand = new Int32Array(64); candL = new Float64Array(64);
  /** incoming boundary half-edge at the end of the last fan walk (-1 for interior vertices) */
  fanIn = -1;
  splits = 0; collapses = 0; flips = 0;
  uniform: boolean;
  triBVH: ClosestBVH;
  segBVH: ClosestBVH | null;
  refTriT: Float64Array | null;
  refSegT: Float64Array | null;
  cosCorner: number;

  constructor(inp: RemeshInput) {
    const nv = inp.pos.length / 3, nf = inp.tris.length / 3;
    this.allocV(Math.max(16, nv * 2));
    this.allocF(Math.max(16, nf * 2));
    this.nv = nv; this.nf = nf;
    this.pos.set(inp.pos);
    this.hv.set(inp.tris);
    this.uniform = typeof inp.target === 'number';
    if (typeof inp.target === 'number') this.vT.fill(inp.target, 0, nv); else this.vT.set(inp.target);
    for (let v = 0; v < nv; v++) { this.vOrig[v] = v; this.vItem[v] = -1; }
    this.triBVH = inp.refBVH ?? new ClosestBVH(inp.refTris, 3);
    this.segBVH = inp.refSegs.length ? new ClosestBVH(inp.refSegs, 2) : null;
    this.refTriT = inp.refTriTarget ?? null;
    this.refSegT = inp.refSegTarget ?? null;
    this.cosCorner = Math.cos(((inp.cornerAngle ?? 180) * Math.PI) / 180);
    this.connect(inp);
  }

  private allocV(cap: number) {
    const g = <T extends Float64Array | Int32Array | Uint8Array>(old: T | undefined, mk: (n: number) => T, k = 1): T => {
      const a = mk(cap * k);
      if (old) a.set(old.subarray(0, Math.min(old.length, cap * k)) as any);
      return a;
    };
    this.pos = g(this.pos, (n) => new Float64Array(n), 3);
    this.vOut = g(this.vOut, (n) => new Int32Array(n));
    this.vFlag = g(this.vFlag, (n) => new Uint8Array(n));
    this.vCon = g(this.vCon, (n) => new Int32Array(n));
    this.vVal = g(this.vVal, (n) => new Int32Array(n));
    this.vT = g(this.vT, (n) => new Float64Array(n));
    this.vItem = g(this.vItem, (n) => new Int32Array(n));
    this.vKind = g(this.vKind, (n) => new Uint8Array(n));
    this.vBary = g(this.vBary, (n) => new Float64Array(n), 3);
    this.vOrig = g(this.vOrig, (n) => new Int32Array(n));
    this.mark = g(this.mark, (n) => new Int32Array(n));
  }

  private allocF(cap: number) {
    const grow = <T extends Int32Array | Uint8Array>(old: T | undefined, mk: (n: number) => T, n: number): T => {
      const a = mk(n);
      if (old) a.set(old as any);
      return a;
    };
    this.hv = grow(this.hv, (n) => new Int32Array(n), cap * 3);
    this.ho = grow(this.ho, (n) => new Int32Array(n), cap * 3);
    this.hf = grow(this.hf, (n) => new Uint8Array(n), cap * 3);
    this.fDead = grow(this.fDead, (n) => new Uint8Array(n), cap);
  }

  private newVertex(x: number, y: number, z: number): number {
    if (this.nv * 3 >= this.pos.length) this.allocV((this.nv + 1) * 2);
    const v = this.nv++;
    this.pos[v * 3] = x; this.pos[v * 3 + 1] = y; this.pos[v * 3 + 2] = z;
    this.vFlag[v] = 0; this.vCon[v] = 0; this.vVal[v] = 0; this.vOrig[v] = -1; this.vItem[v] = -1; this.vKind[v] = 0;
    return v;
  }

  private newFace(): number {
    if (this.nf >= this.fDead.length) this.allocF((this.nf + 1) * 2);
    const f = this.nf++;
    this.fDead[f] = 0;
    return f;
  }

  /** Pair half-edges, lock non-manifold edges and vertices, set vOut (boundary half-edge first), valences, corners. */
  private connect(inp: RemeshInput) {
    const nv = this.nv, nh = this.nf * 3, hv = this.hv, ho = this.ho, hf = this.hf;
    const start = new Int32Array(nv + 1);
    for (let h = 0; h < nh; h++) start[hv[h] + 1]++;
    for (let v = 0; v < nv; v++) start[v + 1] += start[v];
    const list = new Int32Array(nh), fill = start.slice(0, nv);
    for (let h = 0; h < nh; h++) list[fill[hv[h]]++] = h;
    for (let h = 0; h < nh; h++) {
      const a = hv[h], b = hv[nxt(h)];
      let same = 0, opp = 0, twin = -1;
      for (let k = start[a]; k < start[a + 1]; k++) if (hv[nxt(list[k])] === b) same++;
      for (let k = start[b]; k < start[b + 1]; k++) if (hv[nxt(list[k])] === a) { opp++; twin = list[k]; }
      hf[h] |= inp.edgeFlags[h] & 7;
      if (same === 1 && opp <= 1) ho[h] = opp ? twin : -1;
      else { ho[h] = -1; hf[h] |= EDGE_LOCKED; }
    }
    for (let h = 0; h < nh; h++) {
      const t = ho[h];
      if (t > h) { const f = hf[h] | hf[t]; hf[h] = f; hf[t] = f; }
      else if (t < 0 && !(hf[h] & (EDGE_LOCKED | EDGE_CONSTRAINT))) hf[h] |= EDGE_CONSTRAINT;
    }
    for (let v = 0; v < nv; v++) {
      if (inp.vertexLock[v]) this.vFlag[v] |= VLOCK;
      if (start[v + 1] === start[v]) { this.vFlag[v] |= VDEAD; continue; }
      this.fixOut(v, list[start[v]]);
      // a vertex whose fan does not reach all its half-edges joins several fans (bowtie): freeze it
      const n = this.fan(v, 0);
      if (n !== start[v + 1] - start[v]) {
        this.vFlag[v] |= VLOCK | VBAD;
        for (let k = start[v]; k < start[v + 1]; k++) {
          const h = list[k], t = ho[h];
          hf[h] |= EDGE_LOCKED; if (t >= 0) hf[t] |= EDGE_LOCKED;
          const p = prv(h), tp = ho[p];
          hf[p] |= EDGE_LOCKED; if (tp >= 0) hf[tp] |= EDGE_LOCKED;
        }
      }
    }
    for (let h = 0; h < nh; h++) if (hf[h] & EDGE_LOCKED) { this.vFlag[hv[h]] |= VLOCK; this.vFlag[hv[nxt(h)]] |= VLOCK; }
    for (let v = 0; v < nv; v++) {
      if (this.vFlag[v] & VDEAD) continue;
      if (this.vFlag[v] & VBAD) { this.vVal[v] = start[v + 1] - start[v]; continue; }
      const n = this.fan(v, 0);
      this.vVal[v] = n + (this.fanIn >= 0 ? 1 : 0);
      this.vCon[v] = this.countCon(v);
    }
    // corners: constraint valence other than 0 or 2, or a sharp turn of the curve
    const P = this.pos;
    for (let v = 0; v < nv; v++) {
      const c = this.vCon[v], fl = this.vFlag[v];
      if (fl & (VDEAD | VLOCK)) continue;
      if (c !== 0 && c !== 2) { this.vFlag[v] |= VLOCK; continue; }
      if (c === 2 && this.cosCorner > -1) {
        const x = this.curveNeighbors(v);
        if (x < 0) { this.vFlag[v] |= VLOCK; continue; }
        const x1 = this.cn1, x2 = this.cn2;
        const e1x = P[v * 3] - P[x1 * 3], e1y = P[v * 3 + 1] - P[x1 * 3 + 1], e1z = P[v * 3 + 2] - P[x1 * 3 + 2];
        const e2x = P[x2 * 3] - P[v * 3], e2y = P[x2 * 3 + 1] - P[v * 3 + 1], e2z = P[x2 * 3 + 2] - P[v * 3 + 2];
        const l = Math.sqrt((e1x * e1x + e1y * e1y + e1z * e1z) * (e2x * e2x + e2y * e2y + e2z * e2z));
        if (l > 0 && (e1x * e2x + e1y * e2y + e1z * e2z) / l < this.cosCorner) this.vFlag[v] |= VLOCK;
      }
    }
  }

  /** Make vOut[v] the boundary outgoing half-edge if v is on a boundary (rotate clockwise from h). */
  private fixOut(v: number, h: number) {
    const ho = this.ho;
    let g = h, guard = 0;
    while (ho[g] >= 0 && guard++ < 100000) {
      g = nxt(ho[g]);
      if (g === h) break;
    }
    this.vOut[v] = g;
  }

  /** Outgoing half-edges of v in CCW order into fanA (buf 0) or fanB (buf 1); sets fanIn. Returns the count. */
  fan(v: number, buf: number): number {
    const ho = this.ho, start = this.vOut[v];
    let out = buf ? this.fanB : this.fanA, n = 0, h = start;
    this.fanIn = -1;
    for (let guard = 0; guard < 100000; guard++) {
      if (n === out.length) {
        const g = new Int32Array(n * 2); g.set(out); out = g;
        if (buf) this.fanB = g; else this.fanA = g;
      }
      out[n++] = h;
      const p = prv(h), t = ho[p];
      if (t < 0) { this.fanIn = p; break; }
      h = t;
      if (h === start) break;
    }
    return n;
  }

  private countCon(v: number): number {
    const n = this.fan(v, 0), F = this.fanA, hf = this.hf;
    let c = 0;
    for (let k = 0; k < n; k++) if (hf[F[k]] & EDGE_CONSTRAINT) c++;
    if (this.fanIn >= 0 && hf[this.fanIn] & EDGE_CONSTRAINT) c++;
    return c;
  }

  cn1 = -1; cn2 = -1;
  /** The two constraint neighbours of a curve vertex into cn1/cn2; returns -1 if there are not exactly two. */
  private curveNeighbors(v: number): number {
    const n = this.fan(v, 0), F = this.fanA, hf = this.hf, hv = this.hv;
    let c = 0;
    this.cn1 = this.cn2 = -1;
    for (let k = 0; k < n; k++) if (hf[F[k]] & EDGE_CONSTRAINT) { if (c === 0) this.cn1 = hv[nxt(F[k])]; else this.cn2 = hv[nxt(F[k])]; c++; }
    if (this.fanIn >= 0 && hf[this.fanIn] & EDGE_CONSTRAINT) { if (c === 0) this.cn1 = hv[this.fanIn]; else this.cn2 = hv[this.fanIn]; c++; }
    return c === 2 ? 0 : -1;
  }

  private isB(v: number) { return this.ho[this.vOut[v]] < 0; }

  private len2(a: number, b: number) {
    const P = this.pos, dx = P[a * 3] - P[b * 3], dy = P[a * 3 + 1] - P[b * 3 + 1], dz = P[a * 3 + 2] - P[b * 3 + 2];
    return dx * dx + dy * dy + dz * dz;
  }

  // ------------------------------------------------------------ split

  private link(a: number, b: number) {
    this.ho[a] = b;
    if (b >= 0) this.ho[b] = a;
  }

  split(h: number) {
    this.splits++;
    let hv = this.hv;
    const t = this.ho[h], h1 = nxt(h), h2 = prv(h);
    const a = hv[h], b = hv[h1], c = hv[h2];
    const P = this.pos;
    const m = this.newVertex((P[a * 3] + P[b * 3]) / 2, (P[a * 3 + 1] + P[b * 3 + 1]) / 2, (P[a * 3 + 2] + P[b * 3 + 2]) / 2);
    this.vT[m] = (this.vT[a] + this.vT[b]) / 2;
    const ha = this.vKind[a] ? a : b;
    this.vItem[m] = this.vItem[ha]; this.vKind[m] = this.vKind[ha];
    const f2 = this.newFace();
    hv = this.hv;
    const ho = this.ho, hf = this.hf;
    const s0 = f2 * 3, s1 = s0 + 1, s2 = s0 + 2;
    const oh1 = ho[h1], fl1 = hf[h1], fh = hf[h];
    // f0 = (a, m, c); f2 = (m, b, c)
    hv[h1] = m;
    hv[s0] = m; hv[s1] = b; hv[s2] = c;
    this.link(s1, oh1); hf[s1] = fl1;
    this.link(h1, s2); hf[h1] = 0; hf[s2] = 0;
    hf[s0] = fh;
    if (t >= 0) {
      const t1 = nxt(t), t2 = prv(t), d = hv[t2];
      const f3 = this.newFace();
      const H = this.hv, O = this.ho, Fl = this.hf;
      const r0 = f3 * 3, r1 = r0 + 1, r2 = r0 + 2;
      const ot1 = O[t1], flt1 = Fl[t1];
      // f1 = (b, m, d); f3 = (m, a, d)
      H[t1] = m;
      H[r0] = m; H[r1] = a; H[r2] = d;
      this.link(r1, ot1); Fl[r1] = flt1;
      this.link(t1, r2); Fl[t1] = 0; Fl[r2] = 0;
      Fl[r0] = Fl[t];
      this.link(h, r0);
      this.link(s0, t);
      if (this.vOut[a] === t1) this.vOut[a] = r1;
      this.vVal[d]++;
      this.vVal[m] = 4;
    } else {
      this.ho[s0] = -1;
      this.vVal[m] = 3;
    }
    if (this.vOut[b] === h1) this.vOut[b] = s1;
    this.vOut[m] = s0;
    this.vVal[c]++;
    this.vCon[m] = fh & EDGE_CONSTRAINT ? 2 : 0;
  }

  /** A half-edge of the edge {a, b}, or -1 when a and b are not connected. */
  private findEdge(a: number, b: number): number {
    const n = this.fan(a, 0), F = this.fanA, hv = this.hv;
    for (let k = 0; k < n; k++) if (hv[nxt(F[k])] === b) return F[k];
    return this.fanIn >= 0 && hv[this.fanIn] === b ? this.fanIn : -1;
  }

  /**
   * Split every edge longer than 4/3 L, longest first (longest-edge bisection keeps triangles well shaped; walking
   * slots in index order instead lets the long side of a face move to a new slot every time a shorter side of that
   * face is split, which grows slivers). Rounds repeat until no edge is too long (at most 16).
   */
  splitLong(): boolean {
    let any = false;
    for (let round = 0; round < 16; round++) {
      let n = 0;
      const nh = this.nf * 3;
      for (let h = 0; h < nh; h++) {
        if (this.fDead[(h / 3) | 0]) continue;
        const t = this.ho[h];
        if (t >= 0 && t < h) continue;
        if (this.hf[h] & EDGE_LOCKED) continue;
        const a = this.hv[h], b = this.hv[nxt(h)];
        const L = (this.vT[a] + this.vT[b]) * (0.5 * 4 / 3), l2 = this.len2(a, b);
        if (l2 <= L * L) continue;
        if (n === this.cand.length) { const g = new Int32Array(n * 2 + 64); g.set(this.cand); this.cand = g; const q = new Float64Array(n * 2 + 64); q.set(this.candL); this.candL = q; }
        this.cand[n] = h; this.candL[n] = l2; n++;
      }
      if (!n) break;
      any = true;
      // remember the candidates by their end points: splits move sides between slots
      const order = new Int32Array(n), A = new Int32Array(n), B = new Int32Array(n), CL = this.candL;
      for (let i = 0; i < n; i++) { order[i] = i; A[i] = this.hv[this.cand[i]]; B[i] = this.hv[nxt(this.cand[i])]; }
      order.sort((x, y) => CL[y] - CL[x] || x - y);
      for (let k = 0; k < n; k++) {
        const i = order[k], h = this.findEdge(A[i], B[i]);
        if (h < 0 || this.hf[h] & EDGE_LOCKED) continue;
        this.split(h);
      }
    }
    return any;
  }

  // ------------------------------------------------------------ collapse

  /** Can `rem` (an end of the edge of half-edge h) be collapsed into the other end `keep`? */
  private canCollapse(h: number, rem: number, keep: number): boolean {
    const vf = this.vFlag, hf = this.hf, hv = this.hv, ho = this.ho, P = this.pos;
    if (vf[rem] & (VLOCK | VBAD) || vf[keep] & VBAD) return false;
    if (hf[h] & EDGE_LOCKED) return false;
    const t = ho[h];
    // the sides of each incident face at rem (merged away) and at keep
    const er0 = hv[h] === rem ? prv(h) : nxt(h), ek0 = hv[h] === rem ? nxt(h) : prv(h);
    const x0 = hv[prv(h)];
    let er1 = -1, ek1 = -1, x1 = -1;
    if (t >= 0) { er1 = hv[t] === rem ? prv(t) : nxt(t); ek1 = hv[t] === rem ? nxt(t) : prv(t); x1 = hv[prv(t)]; }
    if (this.vCon[rem] > 0) {
      if (!(hf[h] & EDGE_CONSTRAINT)) return false;
      if (hf[er0] & EDGE_CONSTRAINT || (t >= 0 && hf[er1] & EDGE_CONSTRAINT)) return false;
    }
    if (ho[er0] < 0 && ho[ek0] < 0) return false;
    if (t >= 0) {
      if (ho[er1] < 0 && ho[ek1] < 0) return false;
      if (x0 === x1) return false;
      if (this.isB(rem) && this.isB(keep)) return false;
    }
    if (this.vVal[x0] <= (this.isB(x0) ? 2 : 3)) return false;
    if (t >= 0 && this.vVal[x1] <= (this.isB(x1) ? 2 : 3)) return false;
    // geometry first (cheapest rejection): no new edge longer than 4/3 L
    const nr = this.fan(rem, 0), FA = this.fanA, inR = this.fanIn;
    const tk = this.vT[keep], vT = this.vT;
    const kx = P[keep * 3], ky = P[keep * 3 + 1], kz = P[keep * 3 + 2];
    for (let k = 0; k <= nr; k++) {
      const y = k < nr ? hv[nxt(FA[k])] : inR >= 0 ? hv[inR] : -1;
      if (y < 0 || y === keep) continue;
      const L = (tk + vT[y]) * (0.5 * 4 / 3), Y = y * 3;
      const dx = P[Y] - kx, dy = P[Y + 1] - ky, dz = P[Y + 2] - kz;
      if (dx * dx + dy * dy + dz * dz > L * L) return false;
    }
    // link condition: rem and keep share only x0 and x1
    const st = ++this.stamp, mk = this.mark;
    for (let k = 0; k < nr; k++) mk[hv[nxt(FA[k])]] = st;
    if (inR >= 0) mk[hv[inR]] = st;
    const nk = this.fan(keep, 1), FB = this.fanB, inK = this.fanIn;
    for (let k = 0; k <= nk; k++) {
      const y = k < nk ? hv[nxt(FB[k])] : inK >= 0 ? hv[inK] : -1;
      if (y >= 0 && mk[y] === st && y !== x0 && y !== x1) return false;
    }
    // no face turned over
    const rx = P[rem * 3], ry = P[rem * 3 + 1], rz = P[rem * 3 + 2];
    const f0 = (h / 3) | 0, f1 = t >= 0 ? (t / 3) | 0 : -1;
    for (let k = 0; k < nr; k++) {
      const g = FA[k], f = (g / 3) | 0;
      if (f === f0 || f === f1) continue;
      const u = hv[nxt(g)] * 3, w = hv[prv(g)] * 3;
      // old normal (u - rem) x (w - rem), new normal (u - keep) x (w - keep)
      const ax = P[u] - rx, ay = P[u + 1] - ry, az = P[u + 2] - rz, bx = P[w] - rx, by = P[w + 1] - ry, bz = P[w + 2] - rz;
      const cx = P[u] - kx, cy = P[u + 1] - ky, cz = P[u + 2] - kz, dx = P[w] - kx, dy = P[w + 1] - ky, dz = P[w + 2] - kz;
      const n1x = ay * bz - az * by, n1y = az * bx - ax * bz, n1z = ax * by - ay * bx;
      const n2x = cy * dz - cz * dy, n2y = cz * dx - cx * dz, n2z = cx * dy - cy * dx;
      const l1 = n1x * n1x + n1y * n1y + n1z * n1z, l2 = n2x * n2x + n2y * n2y + n2z * n2z;
      if (!(l2 > 1e-30)) return false;
      const d = n1x * n2x + n1y * n2y + n1z * n2z;
      if (d <= 0.2 * Math.sqrt(l1 * l2)) return false;
    }
    return true;
  }

  private collapse(h: number, rem: number, keep: number) {
    this.collapses++;
    const hv = this.hv, ho = this.ho, hf = this.hf;
    const t = ho[h];
    const f0 = (h / 3) | 0, f1 = t >= 0 ? (t / 3) | 0 : -1;
    const er0 = hv[h] === rem ? prv(h) : nxt(h), ek0 = hv[h] === rem ? nxt(h) : prv(h);
    const x0 = hv[prv(h)];
    let er1 = -1, ek1 = -1, x1 = -1;
    if (t >= 0) { er1 = hv[t] === rem ? prv(t) : nxt(t); ek1 = hv[t] === rem ? nxt(t) : prv(t); x1 = hv[prv(t)]; }
    // an outgoing half-edge of each third vertex outside the dead faces
    const outside = (x: number, f: number) => {
      const s = f * 3;
      const og = hv[s] === x ? s : hv[s + 1] === x ? s + 1 : s + 2;
      const a = ho[prv(og)];
      return a >= 0 ? a : nxt(ho[og]);
    };
    const c0 = outside(x0, f0), c1 = t >= 0 ? outside(x1, f1) : -1;
    // rem's half-edges become keep's
    const nr = this.fan(rem, 0), FA = this.fanA;
    let kc = -1;
    for (let k = 0; k < nr; k++) {
      const g = FA[k], f = (g / 3) | 0;
      hv[g] = keep;
      if (kc < 0 && f !== f0 && f !== f1) kc = g;
    }
    if (kc < 0) {
      const nk = this.fan(keep, 1), FB = this.fanB;
      for (let k = 0; k < nk; k++) { const f = (FB[k] / 3) | 0; if (f !== f0 && f !== f1) { kc = FB[k]; break; } }
    }
    const merge = (er: number, ek: number) => {
      const a = ho[er], b = ho[ek], fl = hf[er] | hf[ek];
      if (a >= 0) { ho[a] = b; hf[a] = fl; }
      if (b >= 0) { ho[b] = a; hf[b] = fl; }
    };
    merge(er0, ek0);
    if (t >= 0) merge(er1, ek1);
    this.fDead[f0] = 1;
    if (f1 >= 0) this.fDead[f1] = 1;
    this.vFlag[rem] |= VDEAD;
    this.vVal[keep] = this.vVal[rem] + this.vVal[keep] - (t >= 0 ? 4 : 3);
    this.vVal[x0]--;
    if (x1 >= 0) this.vVal[x1]--;
    if (kc >= 0) this.fixOut(keep, kc);
    this.fixOut(x0, c0);
    if (x1 >= 0) this.fixOut(x1, c1);
    this.vCon[keep] = this.countCon(keep);
    this.vCon[x0] = this.countCon(x0);
    if (x1 >= 0) this.vCon[x1] = this.countCon(x1);
  }

  collapseShort() {
    const nh = this.nf * 3;
    for (let h = 0; h < nh; h++) {
      if (this.fDead[(h / 3) | 0]) continue;
      const t = this.ho[h];
      if (t >= 0 && t < h) continue;
      if (this.hf[h] & EDGE_LOCKED) continue;
      const a = this.hv[h], b = this.hv[nxt(h)];
      const L = (this.vT[a] + this.vT[b]) * (0.5 * 4 / 5);
      if (this.len2(a, b) >= L * L) continue;
      // remove the lower-valence end first (pmp convention), else the other one
      const first = this.vVal[a] < this.vVal[b] ? a : b, second = first === a ? b : a;
      if (this.canCollapse(h, first, second)) this.collapse(h, first, second);
      else if (this.canCollapse(h, second, first)) this.collapse(h, second, first);
    }
  }

  // ------------------------------------------------------------ flip

  private connected(c: number, d: number): boolean {
    const n = this.fan(c, 0), F = this.fanA, hv = this.hv;
    for (let k = 0; k < n; k++) if (hv[nxt(F[k])] === d) return true;
    return this.fanIn >= 0 && hv[this.fanIn] === d;
  }

  flipEdges() {
    const nh = this.nf * 3, P = this.pos;
    for (let h = 0; h < nh; h++) {
      if (this.fDead[(h / 3) | 0]) continue;
      const t = this.ho[h];
      if (t < h) continue;
      if (this.hf[h] & (EDGE_CONSTRAINT | EDGE_LOCKED)) continue;
      const hv = this.hv, vf = this.vFlag;
      const a = hv[h], b = hv[nxt(h)], c = hv[prv(h)], d = hv[prv(t)];
      if (c === d || (vf[a] | vf[b] | vf[c] | vf[d]) & VBAD) continue;
      const va = this.vVal[a], vb = this.vVal[b], vc = this.vVal[c], vd = this.vVal[d];
      const ta = this.isB(a) ? 4 : 6, tb = this.isB(b) ? 4 : 6, tc = this.isB(c) ? 4 : 6, td = this.isB(d) ? 4 : 6;
      if (va - 1 < (ta === 4 ? 2 : 3) || vb - 1 < (tb === 4 ? 2 : 3)) continue;
      const before = Math.abs(va - ta) + Math.abs(vb - tb) + Math.abs(vc - tc) + Math.abs(vd - td);
      const after = Math.abs(va - 1 - ta) + Math.abs(vb - 1 - tb) + Math.abs(vc + 1 - tc) + Math.abs(vd + 1 - td);
      if (after >= before) continue;
      // geometry: both new triangles must face like the old pair
      const A = a * 3, B = b * 3, C = c * 3, D = d * 3;
      triNormal(P, A, B, C);
      const n1x = TN[0], n1y = TN[1], n1z = TN[2];
      triNormal(P, B, A, D);
      const nx = n1x + TN[0], ny = n1y + TN[1], nz = n1z + TN[2];
      triNormal(P, A, D, C);
      if (TN[0] * nx + TN[1] * ny + TN[2] * nz <= 0) continue;
      triNormal(P, B, C, D);
      if (TN[0] * nx + TN[1] * ny + TN[2] * nz <= 0) continue;
      if (this.connected(c, d)) continue;
      this.flip(h);
    }
  }

  private flip(h: number) {
    this.flips++;
    const hv = this.hv, ho = this.ho, hf = this.hf;
    const t = ho[h], h1 = nxt(h), t1 = nxt(t);
    const a = hv[h], b = hv[h1], c = hv[prv(h)], d = hv[prv(t)];
    const oh1 = ho[h1], fh1 = hf[h1], ot1 = ho[t1], ft1 = hf[t1];
    // f0 = (a, d, c), f1 = (b, c, d)
    hv[h1] = d; hv[t1] = c;
    this.link(h, ot1); hf[h] = ft1;
    this.link(t, oh1); hf[t] = fh1;
    this.link(h1, t1); hf[h1] = 0; hf[t1] = 0;
    if (this.vOut[a] === t1) this.vOut[a] = h;
    if (this.vOut[b] === h1) this.vOut[b] = t;
    this.vVal[a]--; this.vVal[b]--; this.vVal[c]++; this.vVal[d]++;
  }

  // ------------------------------------------------------------ relaxation + projection

  relax() {
    const nv = this.nv, nf = this.nf, P = this.pos, hv = this.hv, hf = this.hf, vf = this.vFlag;
    const N = new Float64Array(nv * 3);
    for (let f = 0; f < nf; f++) {
      if (this.fDead[f]) continue;
      const A = hv[f * 3] * 3, B = hv[f * 3 + 1] * 3, C = hv[f * 3 + 2] * 3;
      triNormal(P, A, B, C);
      const x = TN[0], y = TN[1], z = TN[2];
      N[A] += x; N[A + 1] += y; N[A + 2] += z;
      N[B] += x; N[B + 1] += y; N[B + 2] += z;
      N[C] += x; N[C + 1] += y; N[C + 2] += z;
    }
    const upd = new Float64Array(nv * 3), moved = new Uint8Array(nv);
    for (let v = 0; v < nv; v++) {
      if (vf[v] & (VDEAD | VLOCK)) continue;
      const px = P[v * 3], py = P[v * 3 + 1], pz = P[v * 3 + 2];
      const tv = this.vT[v];
      if (this.vCon[v] === 0) {
        const n = this.fan(v, 0), F = this.fanA;
        if (this.fanIn >= 0) continue; // free boundary vertex (should not happen: boundaries are constraints)
        let sx = 0, sy = 0, sz = 0, sw = 0;
        for (let k = 0; k < n; k++) {
          const x = hv[nxt(F[k])];
          let w = 1;
          if (!this.uniform) { const te = (tv + this.vT[x]) * 0.5; w = 1 / (te * te); }
          sx += P[x * 3] * w; sy += P[x * 3 + 1] * w; sz += P[x * 3 + 2] * w; sw += w;
        }
        if (!(sw > 0)) continue;
        let dx = sx / sw - px, dy = sy / sw - py, dz = sz / sw - pz;
        const nx = N[v * 3], ny = N[v * 3 + 1], nz = N[v * 3 + 2], nl = nx * nx + ny * ny + nz * nz;
        if (nl > 0) { const s = (dx * nx + dy * ny + dz * nz) / nl; dx -= nx * s; dy -= ny * s; dz -= nz * s; }
        upd[v * 3] = px + dx; upd[v * 3 + 1] = py + dy; upd[v * 3 + 2] = pz + dz;
        moved[v] = 1;
      } else if (this.vCon[v] === 2) {
        if (this.curveNeighbors(v) < 0) continue;
        const x1 = this.cn1, x2 = this.cn2;
        let w1 = 1, w2 = 1;
        if (!this.uniform) {
          const a = (tv + this.vT[x1]) * 0.5, b = (tv + this.vT[x2]) * 0.5;
          w1 = 1 / (a * a); w2 = 1 / (b * b);
        }
        const ux = (P[x1 * 3] * w1 + P[x2 * 3] * w2) / (w1 + w2), uy = (P[x1 * 3 + 1] * w1 + P[x2 * 3 + 1] * w2) / (w1 + w2), uz = (P[x1 * 3 + 2] * w1 + P[x2 * 3 + 2] * w2) / (w1 + w2);
        let tx = P[x2 * 3] - P[x1 * 3], ty = P[x2 * 3 + 1] - P[x1 * 3 + 1], tz = P[x2 * 3 + 2] - P[x1 * 3 + 2];
        const tl = Math.hypot(tx, ty, tz);
        if (!(tl > 0)) continue;
        tx /= tl; ty /= tl; tz /= tl;
        const s = (ux - px) * tx + (uy - py) * ty + (uz - pz) * tz;
        upd[v * 3] = px + tx * s; upd[v * 3 + 1] = py + ty * s; upd[v * 3 + 2] = pz + tz * s;
        moved[v] = 1;
      }
    }
    for (let v = 0; v < nv; v++) {
      if (!moved[v]) continue;
      P[v * 3] = upd[v * 3]; P[v * 3 + 1] = upd[v * 3 + 1]; P[v * 3 + 2] = upd[v * 3 + 2];
      this.vOrig[v] = -1;
    }
  }

  project() {
    const nv = this.nv, P = this.pos, vf = this.vFlag, tri = this.triBVH, seg = this.segBVH;
    for (let v = 0; v < nv; v++) {
      if (vf[v] & (VDEAD | VLOCK)) continue;
      if (this.vOrig[v] >= 0 && this.vKind[v]) continue; // never moved and already located
      const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
      // a point that is still near the segment / triangle it was projected on last time keeps it (see closestNear)
      const acc = this.vT[v] * this.vT[v] * 0.01;
      if (this.vCon[v] > 0 && seg) {
        const i = seg.closestNear(x, y, z, this.vKind[v] === 2 ? this.vItem[v] : -1, acc);
        if (i < 0) continue;
        this.vKind[v] = 2; this.vItem[v] = i;
        this.vBary[v * 3] = seg.b0; this.vBary[v * 3 + 1] = seg.b1; this.vBary[v * 3 + 2] = 0;
        if (this.vOrig[v] < 0) { P[v * 3] = seg.px; P[v * 3 + 1] = seg.py; P[v * 3 + 2] = seg.pz; }
        if (this.refSegT) this.vT[v] = this.refSegT[i * 2] * seg.b0 + this.refSegT[i * 2 + 1] * seg.b1;
      } else {
        const i = tri.closestNear(x, y, z, this.vKind[v] === 1 ? this.vItem[v] : -1, acc);
        if (i < 0) continue;
        this.vKind[v] = 1; this.vItem[v] = i;
        this.vBary[v * 3] = tri.b0; this.vBary[v * 3 + 1] = tri.b1; this.vBary[v * 3 + 2] = tri.b2;
        if (this.vOrig[v] < 0) { P[v * 3] = tri.px; P[v * 3 + 1] = tri.py; P[v * 3 + 2] = tri.pz; }
        if (this.refTriT) this.vT[v] = this.refTriT[i * 3] * tri.b0 + this.refTriT[i * 3 + 1] * tri.b1 + this.refTriT[i * 3 + 2] * tri.b2;
      }
    }
  }

  output(): RemeshOutput {
    const nv = this.nv, nf = this.nf, remap = new Int32Array(nv).fill(-1);
    let cv = 0;
    for (let v = 0; v < nv; v++) if (!(this.vFlag[v] & VDEAD)) remap[v] = cv++;
    let cf = 0;
    for (let f = 0; f < nf; f++) if (!this.fDead[f]) cf++;
    const tris = new Int32Array(cf * 3), flags = new Uint8Array(cf * 3);
    const used = new Uint8Array(nv);
    let k = 0;
    for (let f = 0; f < nf; f++) {
      if (this.fDead[f]) continue;
      for (let c = 0; c < 3; c++) {
        const v = this.hv[f * 3 + c];
        tris[k * 3 + c] = remap[v]; flags[k * 3 + c] = this.hf[f * 3 + c]; used[v] = 1;
      }
      k++;
    }
    // drop vertices no face uses (cannot normally happen, but keeps the output compact)
    let n = 0;
    const r2 = new Int32Array(cv).fill(-1);
    for (let v = 0; v < nv; v++) if (remap[v] >= 0 && used[v]) r2[remap[v]] = n++;
    for (let i = 0; i < tris.length; i++) tris[i] = r2[tris[i]];
    const pos = new Float64Array(n * 3), orig = new Int32Array(n), kind = new Uint8Array(n), item = new Int32Array(n), bary = new Float64Array(n * 3);
    for (let v = 0; v < nv; v++) {
      if (remap[v] < 0 || !used[v]) continue;
      const o = r2[remap[v]];
      pos[o * 3] = this.pos[v * 3]; pos[o * 3 + 1] = this.pos[v * 3 + 1]; pos[o * 3 + 2] = this.pos[v * 3 + 2];
      orig[o] = this.vOrig[v]; kind[o] = this.vKind[v]; item[o] = this.vItem[v];
      bary[o * 3] = this.vBary[v * 3]; bary[o * 3 + 1] = this.vBary[v * 3 + 1]; bary[o * 3 + 2] = this.vBary[v * 3 + 2];
    }
    return { pos, tris, edgeFlags: flags, orig, refKind: kind, refItem: item, bary, stats: { splits: this.splits, collapses: this.collapses, flips: this.flips } };
  }
}

const TN = [0, 0, 0];
/** Unnormalised normal (B - A) x (C - A) of the triangle at float offsets A, B, C into TN. */
function triNormal(P: Float64Array, A: number, B: number, C: number) {
  const ax = P[B] - P[A], ay = P[B + 1] - P[A + 1], az = P[B + 2] - P[A + 2];
  const bx = P[C] - P[A], by = P[C + 1] - P[A + 1], bz = P[C + 2] - P[A + 2];
  TN[0] = ay * bz - az * by; TN[1] = az * bx - ax * bz; TN[2] = ax * by - ay * bx;
}

/**
 * The remeshing kernel (see the header): typed arrays in, typed arrays out. Deterministic: every pass walks
 * elements in index order.
 */
export function remeshTriangles(inp: RemeshInput): RemeshOutput {
  const m = new IsoMesh(inp);
  const passes = Math.max(1, inp.relaxPasses ?? 1);
  for (let it = 0; it < inp.iterations; it++) {
    m.splitLong();
    m.collapseShort();
    m.flipEdges();
    for (let k = 0; k < passes; k++) {
      m.relax();
      m.project();
    }
  }
  return m.output();
}

// ---------------------------------------------------------------- Geometry wrapper

export interface IsoRemeshOptions {
  iterations: number;
  /** target edge length; 0 = the mean edge length of the input (inside the group) */
  targetLength: number;
  /** point float attribute with a per-point target length ('' = uniform) */
  targetAttrib: string;
  /** edges whose faces meet at more than this many degrees are kept as features (0 = none) */
  featureAngle: number;
  /** keep boundary edges and points exactly (else the boundary is resampled along itself) */
  preserveBoundary: boolean;
  /** prim mask to remesh (null = all); the border of the selection stays fixed */
  group: Uint8Array | null;
  /** edges to keep as features, with the edge groups whose membership is carried to the new feature edges */
  featureEdges: EdgeSet | null;
  featureGroups: string[];
  /** keep borders between prims with different string attributes or prim groups as features */
  keepPrimBorders: boolean;
  relaxPasses: number;
  /** refuse when the estimated output exceeds this many triangles */
  maxTriangles: number;
}

export interface IsoRemeshResult {
  geo: Geometry;
  targetLength: number;
  inputTriangles: number;
  outputTriangles: number;
  stats: { splits: number; collapses: number; flips: number; features: number; lockedPoints: number };
}

export class RemeshError extends Error {}

/** Twin side of every triangle side (3t + k): -1 = boundary, -2 = non-manifold or inconsistently wound. */
export function sideTwins(tris: Int32Array, nv: number): Int32Array {
  const nh = tris.length, nx = (h: number) => (h % 3 === 2 ? h - 2 : h + 1);
  const start = new Int32Array(nv + 1);
  for (let h = 0; h < nh; h++) start[tris[h] + 1]++;
  for (let v = 0; v < nv; v++) start[v + 1] += start[v];
  const list = new Int32Array(nh), fill = start.slice(0, nv);
  for (let h = 0; h < nh; h++) list[fill[tris[h]]++] = h;
  const out = new Int32Array(nh);
  for (let h = 0; h < nh; h++) {
    const a = tris[h], b = tris[nx(h)];
    let same = 0, opp = 0, tw = -1;
    for (let k = start[a]; k < start[a + 1]; k++) if (tris[nx(list[k])] === b) same++;
    for (let k = start[b]; k < start[b + 1]; k++) if (tris[nx(list[k])] === a) { opp++; tw = list[k]; }
    out[h] = same === 1 && opp <= 1 ? (opp ? tw : -1) : -2;
  }
  return out;
}

/** Do the vertex attribute values of corners va and vb differ? (floats with a small relative tolerance) */
export function vertexAttribsDiffer(attrs: Attribute[], va: number, vb: number): boolean {
  if (va === vb) return false;
  for (const a of attrs) {
    const s = a.size;
    if (a.type === 'string') { if ((a.data as string[])[va] !== (a.data as string[])[vb]) return true; continue; }
    const d = a.data as Float64Array;
    for (let c = 0; c < s; c++) {
      const x = d[va * s + c], y = d[vb * s + c];
      if (Math.abs(x - y) > 1e-6 * (1 + Math.abs(x) + Math.abs(y))) return true;
    }
  }
  return false;
}

/** Region id per prim from string prim attributes and prim group membership (null when there is nothing to compare). */
export function primRegions(g: Geometry): Int32Array | null {
  const strs = [...g.prims.map].filter(([, a]) => a.type === 'string');
  const grps = [...g.primGroups.values()];
  if (!strs.length && !grps.length) return null;
  const ids = new Map<string, number>(), out = new Int32Array(g.numPrims);
  for (let p = 0; p < g.numPrims; p++) {
    let k = '';
    for (const [, a] of strs) k += (a.data as string[])[p] + '\u0001';
    for (const m of grps) k += m[p] ? '1' : '0';
    let id = ids.get(k);
    if (id === undefined) { id = ids.size; ids.set(k, id); }
    out[p] = id;
  }
  return out;
}

/**
 * Isotropic remeshing of the (selected) polygons of g into triangles, attributes carried by provenance:
 * point attributes are interpolated at each new point's closest location on the input (barycentric blend of the
 * input triangle's points; along constraint curves, of the segment's two points), vertex attributes the same way
 * per wedge (corners around a point not separated by a seam share one value, taken on the side of the seam the
 * face is on), prim attributes and groups come from the input prim under the face's centre. Unselected prims pass
 * through unchanged. Throws RemeshError for invalid settings.
 */
export function isotropicRemesh(g: Geometry, o: IsoRemeshOptions): IsoRemeshResult {
  const sel = o.group;
  const { tris: triV, triPrim } = triangulate(g, sel);
  const vp = g.vertexPoint, Pg = g.P;
  // drop triangles with a repeated point (degenerate polygons)
  const keepT: number[] = [];
  for (let t = 0; t < triPrim.length; t++) {
    const a = vp[triV[t * 3]], b = vp[triV[t * 3 + 1]], c = vp[triV[t * 3 + 2]];
    if (a !== b && b !== c && a !== c) keepT.push(t);
  }
  const nt = keepT.length;
  if (!nt) throw new RemeshError('no polygons to remesh (the input or the group has no faces with 3+ points)');
  // working vertices = points used by the selected triangles
  const wOf = new Int32Array(g.numPoints).fill(-1), wPt: number[] = [];
  const tris = new Int32Array(nt * 3), tVtx = new Int32Array(nt * 3), tPrim = new Int32Array(nt);
  for (let i = 0; i < nt; i++) {
    const t = keepT[i];
    tPrim[i] = triPrim[t];
    for (let k = 0; k < 3; k++) {
      const v = triV[t * 3 + k], p = vp[v];
      if (wOf[p] < 0) { wOf[p] = wPt.length; wPt.push(p); }
      tris[i * 3 + k] = wOf[p];
      tVtx[i * 3 + k] = v;
    }
  }
  const nv = wPt.length;
  const pos = new Float64Array(nv * 3);
  for (let i = 0; i < nv; i++) for (let c = 0; c < 3; c++) pos[i * 3 + c] = Pg[wPt[i] * 3 + c];
  const refTris = new Float64Array(nt * 9);
  for (let i = 0; i < nt * 3; i++) for (let c = 0; c < 3; c++) refTris[i * 3 + c] = pos[tris[i] * 3 + c];
  // twins: -1 = boundary side, -2 = non-manifold or inconsistently wound (found through per-vertex side lists)
  const nh = nt * 3, nxtI = (h: number) => (h % 3 === 2 ? h - 2 : h + 1);
  const twinOf = sideTwins(tris, nv);
  // sides of the selection without a twin that other prims use are the selection's border
  let polyCount: ReturnType<typeof edgeList> | null = null;
  const fullCount = (pa: number, pb: number) => {
    if (!sel) return 1;
    polyCount ??= edgeList(g);
    const e = polyCount.index.get(pa < pb ? pa * EDGE_KEY_LIMIT + pb : pb * EDGE_KEY_LIMIT + pa);
    return e === undefined ? 0 : polyCount.polyCount[e];
  };
  const regions = o.keepPrimBorders ? primRegions(g) : null;
  const cosF = o.featureAngle > 0 ? Math.cos((o.featureAngle * Math.PI) / 180) : -2;
  const vAttrs = [...g.vertices.map.values()].filter((a) => !a.isArray);
  const hasVtx = vAttrs.length > 0;
  const flags = new Uint8Array(nh);
  const tn = new Float64Array(nt * 3);
  for (let i = 0; i < nt; i++) {
    triNormal(refTris, i * 9, i * 9 + 3, i * 9 + 6);
    const l = Math.hypot(TN[0], TN[1], TN[2]) || 1;
    tn[i * 3] = TN[0] / l; tn[i * 3 + 1] = TN[1] / l; tn[i * 3 + 2] = TN[2] / l;
  }
  for (let h = 0; h < nh; h++) {
    const a = tris[h], b = tris[nxtI(h)], pa = wPt[a], pb = wPt[b];
    const twin = twinOf[h];
    if (twin < 0) {
      if (twin === -2) { flags[h] |= EDGE_LOCKED; continue; } // non-manifold / inconsistent
      // a side without a twin among the selected triangles: a real boundary, or the border of the selection
      flags[h] |= fullCount(pa, pb) >= 2 ? EDGE_LOCKED : o.preserveBoundary ? EDGE_LOCKED : EDGE_CONSTRAINT;
      continue;
    }
    if (twin < h) { flags[h] = flags[twin]; continue; }
    const f = (h / 3) | 0, gF = (twin / 3) | 0;
    let fl = 0;
    if (cosF > -2 && tn[f * 3] * tn[gF * 3] + tn[f * 3 + 1] * tn[gF * 3 + 1] + tn[f * 3 + 2] * tn[gF * 3 + 2] < cosF) fl |= EDGE_CONSTRAINT;
    if (hasVtx && (vertexAttribsDiffer(vAttrs, tVtx[h], tVtx[nxtI(twin)]) || vertexAttribsDiffer(vAttrs, tVtx[nxtI(h)], tVtx[twin]))) fl |= EDGE_CONSTRAINT | EDGE_SEAM;
    if (regions && tPrim[f] !== tPrim[gF] && regions[tPrim[f]] !== regions[tPrim[gF]]) fl |= EDGE_CONSTRAINT;
    if (o.featureEdges && o.featureEdges.has(pa, pb)) fl |= EDGE_CONSTRAINT;
    flags[h] = fl;
  }
  // constraint segments (one per undirected constraint edge) for curve projection
  const segA: number[] = [], segB: number[] = [], segTri: number[] = [];
  for (let h = 0; h < nh; h++) {
    if (!(flags[h] & EDGE_CONSTRAINT) || flags[h] & EDGE_LOCKED) continue;
    const tw = twinOf[h];
    if (tw >= 0 && tw < h) continue;
    segA.push(tris[h]); segB.push(tris[nxtI(h)]); segTri.push((h / 3) | 0);
  }
  const ns = segA.length, refSegs = new Float64Array(ns * 6);
  for (let s = 0; s < ns; s++) for (let c = 0; c < 3; c++) { refSegs[s * 6 + c] = pos[segA[s] * 3 + c]; refSegs[s * 6 + 3 + c] = pos[segB[s] * 3 + c]; }
  // target length field
  const bb = g.bbox(), diag = Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) || 1;
  let L = o.targetLength;
  if (!(L > 0)) {
    let sum = 0, cnt = 0;
    for (let h = 0; h < nh; h++) {
      const a = tris[h], b = tris[nxtI(h)];
      sum += Math.hypot(pos[a * 3] - pos[b * 3], pos[a * 3 + 1] - pos[b * 3 + 1], pos[a * 3 + 2] - pos[b * 3 + 2]);
      cnt++;
    }
    L = sum / Math.max(1, cnt);
  }
  const minL = diag * 1e-4;
  L = Math.max(L, minL);
  let target: number | Float64Array = L;
  let refTriTarget: Float64Array | null = null, refSegTarget: Float64Array | null = null;
  if (o.targetAttrib) {
    const at = g.points.get(o.targetAttrib);
    if (!at || at.type === 'string' || at.isArray) throw new RemeshError(`target_attrib "${o.targetAttrib}" is not a numeric point attribute`);
    const d = at.data as Float64Array, s = at.size;
    const tv = new Float64Array(nv);
    for (let i = 0; i < nv; i++) { const x = d[wPt[i] * s]; tv[i] = x > 0 && Number.isFinite(x) ? Math.max(x, minL) : L; }
    target = tv;
    refTriTarget = new Float64Array(nt * 3);
    for (let i = 0; i < nt * 3; i++) refTriTarget[i] = tv[tris[i]];
    refSegTarget = new Float64Array(ns * 2);
    for (let s2 = 0; s2 < ns; s2++) { refSegTarget[s2 * 2] = tv[segA[s2]]; refSegTarget[s2 * 2 + 1] = tv[segB[s2]]; }
  }
  // size guard: estimated triangle count from area / (equilateral area at the target)
  let est = 0;
  for (let i = 0; i < nt; i++) {
    triNormal(refTris, i * 9, i * 9 + 3, i * 9 + 6);
    const area = Math.hypot(TN[0], TN[1], TN[2]) / 2;
    let lt = L;
    if (typeof target !== 'number') lt = (target[tris[i * 3]] + target[tris[i * 3 + 1]] + target[tris[i * 3 + 2]]) / 3;
    est += area / (0.433 * lt * lt);
  }
  if (est > o.maxTriangles) throw new RemeshError(`target length ${+L.toPrecision(3)} would make ~${Math.round(est).toLocaleString('en-US')} triangles (limit ${o.maxTriangles.toLocaleString('en-US')}); raise target_length`);
  const vertexLock = new Uint8Array(nv);
  const triBVH = new ClosestBVH(refTris, 3);
  const out = remeshTriangles({
    pos, tris, edgeFlags: flags, vertexLock, refTris, refBVH: triBVH, refSegs, target, refTriTarget, refSegTarget,
    iterations: o.iterations, relaxPasses: o.relaxPasses, cornerAngle: o.featureAngle > 0 ? o.featureAngle : 180,
  });
  // ---------------------------------------------------------------- rebuild with provenance
  const b = new GeoBuilder(g);
  const copied = new Int32Array(g.numPoints).fill(-1);
  const copyPt = (p: number) => (copied[p] >= 0 ? copied[p] : (copied[p] = b.copyPoint(p)));
  // unselected prims (and polylines / small prims) pass through
  for (let p = 0; p < g.numPrims; p++) {
    const s = g.primStart[p], e = g.primStart[p + 1];
    const remeshed = g.primClosed[p] && e - s >= 3 && (!sel || sel[p]);
    if (remeshed) continue;
    const pts: number[] = [], vs: number[] = [];
    for (let v = s; v < e; v++) { pts.push(copyPt(vp[v])); vs.push(v); }
    b.addPrim(pts, !!g.primClosed[p], p, vs);
  }
  const onv = out.orig.length, ont = out.tris.length / 3, OP = out.pos;
  let locked = 0;
  const ptOut = new Int32Array(onv);
  for (let v = 0; v < onv; v++) {
    if (out.orig[v] >= 0 && out.refKind[v] === 0) { ptOut[v] = copyPt(wPt[out.orig[v]]); locked++; continue; }
    if (out.orig[v] >= 0) { ptOut[v] = copyPt(wPt[out.orig[v]]); continue; }
    let src: Src;
    if (out.refKind[v] === 2) {
      const s = out.refItem[v];
      src = { i: [wPt[segA[s]], wPt[segB[s]]], w: [out.bary[v * 3], out.bary[v * 3 + 1]] };
    } else {
      let t = out.refKind[v] === 1 ? out.refItem[v] : -1, w0 = out.bary[v * 3], w1 = out.bary[v * 3 + 1], w2 = out.bary[v * 3 + 2];
      if (t < 0) { t = triBVH.closest(OP[v * 3], OP[v * 3 + 1], OP[v * 3 + 2]); w0 = triBVH.b0; w1 = triBVH.b1; w2 = triBVH.b2; }
      src = { i: [wPt[tris[t * 3]], wPt[tris[t * 3 + 1]], wPt[tris[t * 3 + 2]]], w: [w0, w1, w2] };
    }
    ptOut[v] = b.addPoint(OP[v * 3], OP[v * 3 + 1], OP[v * 3 + 2], src);
  }
  // a reference triangle hint per output vertex (curve vertices: the triangle that owns their segment)
  const hintTri = (v: number) => (out.refKind[v] === 1 ? out.refItem[v] : out.refKind[v] === 2 ? segTri[out.refItem[v]] : -1);
  // prim provenance: the input prim under the face (corners agreeing on one prim, else the face centre's closest)
  const needPrim = g.prims.map.size > 0 || g.primGroups.size > 0;
  const needVtx = g.vertices.map.size > 0 || g.vertexGroups.size > 0;
  const T = out.tris, EF = out.edgeFlags;
  const primOf = new Int32Array(ont).fill(-1);
  if (needPrim) {
    for (let f = 0; f < ont; f++) {
      const a = T[f * 3], c1 = T[f * 3 + 1], c2 = T[f * 3 + 2];
      const ta = hintTri(a), tb = hintTri(c1), tc = hintTri(c2);
      if (ta >= 0 && tb >= 0 && tc >= 0 && tPrim[ta] === tPrim[tb] && tPrim[tb] === tPrim[tc]) { primOf[f] = tPrim[ta]; continue; }
      const cx = (OP[a * 3] + OP[c1 * 3] + OP[c2 * 3]) / 3, cy = (OP[a * 3 + 1] + OP[c1 * 3 + 1] + OP[c2 * 3 + 1]) / 3, cz = (OP[a * 3 + 2] + OP[c1 * 3 + 2] + OP[c2 * 3 + 2]) / 3;
      const t = triBVH.closestNear(cx, cy, cz, ta >= 0 ? ta : tb >= 0 ? tb : tc, Infinity);
      primOf[f] = t >= 0 ? tPrim[t] : -1;
    }
  }
  // vertex provenance per wedge: corners around a point between two seam edges share one source
  let vtxSrc: (Src | null)[] | null = null;
  if (needVtx) {
    vtxSrc = new Array(ont * 3).fill(null);
    // corners per output vertex
    const cs = new Int32Array(onv + 1);
    for (let i = 0; i < ont * 3; i++) cs[T[i] + 1]++;
    for (let v = 0; v < onv; v++) cs[v + 1] += cs[v];
    const cl = new Int32Array(ont * 3), cf = cs.slice(0, onv);
    for (let i = 0; i < ont * 3; i++) cl[cf[T[i]]++] = i;
    const tw = sideTwins(T, onv);
    const parent = new Int32Array(ont * 3);
    for (let i = 0; i < parent.length; i++) parent[i] = i;
    const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    for (let h = 0; h < ont * 3; h++) {
      if (EF[h] & EDGE_SEAM) continue;
      const t = tw[h];
      if (t < h) continue;
      // corner a in h's face (h) joins corner a in t's face (next(t)); corner c (next(h)) joins t
      const u1 = find(h), u2 = find(nxtI(t));
      if (u1 !== u2) parent[u1] = u2;
      const u3 = find(nxtI(h)), u4 = find(t);
      if (u3 !== u4) parent[u3] = u4;
    }
    const wedgeSrc: (Src | undefined)[] = new Array(ont * 3);
    for (let v = 0; v < onv; v++) {
      for (let k = cs[v]; k < cs[v + 1]; k++) {
        const corner = cl[k], root = find(corner);
        let s = wedgeSrc[root];
        if (!s) {
          const f = (corner / 3) | 0;
          const a = T[f * 3], c1 = T[f * 3 + 1], c2 = T[f * 3 + 2];
          const px = OP[v * 3], py = OP[v * 3 + 1], pz = OP[v * 3 + 2];
          const cx = (OP[a * 3] + OP[c1 * 3] + OP[c2 * 3]) / 3, cy = (OP[a * 3 + 1] + OP[c1 * 3 + 1] + OP[c2 * 3 + 1]) / 3, cz = (OP[a * 3 + 2] + OP[c1 * 3 + 2] + OP[c2 * 3 + 2]) / 3;
          // nudge into the face to find the input triangle on the face's side of a seam, then locate the point
          // itself on that triangle (the plain closest triangle of a seam point may lie across the seam)
          const e = 1e-3;
          let t = triBVH.closestNear(px + (cx - px) * e, py + (cy - py) * e, pz + (cz - pz) * e, hintTri(v), Infinity);
          if (t < 0) t = 0;
          triBVH.onItem(t, px, py, pz);
          s = { i: [tVtx[t * 3], tVtx[t * 3 + 1], tVtx[t * 3 + 2]], w: [triBVH.b0, triBVH.b1, triBVH.b2] };
          wedgeSrc[root] = s;
        }
        vtxSrc[corner] = s;
      }
    }
  }
  for (let f = 0; f < ont; f++) {
    const pts = [ptOut[T[f * 3]], ptOut[T[f * 3 + 1]], ptOut[T[f * 3 + 2]]];
    b.addPrim(pts, true, primOf[f], vtxSrc ? [vtxSrc[f * 3], vtxSrc[f * 3 + 1], vtxSrc[f * 3 + 2]] : undefined);
  }
  // feature edge groups: new constraint edges take the groups of the input segment under their midpoint
  if (o.featureGroups.length && ns) {
    const segBVH = new ClosestBVH(refSegs, 2);
    const sets = o.featureGroups.map((name) => ({ name, src: g.edgeGroups.get(name), dst: b.edgeGroup(name) }));
    for (const s of sets) if (s.src) for (const [x, y] of s.src) if (copied[x] >= 0 && copied[y] >= 0) s.dst.add(copied[x], copied[y]);
    for (let h = 0; h < ont * 3; h++) {
      if (!(EF[h] & EDGE_CONSTRAINT)) continue;
      const a = T[h], c = T[nxtI(h)];
      const sgi = segBVH.closest((OP[a * 3] + OP[c * 3]) / 2, (OP[a * 3 + 1] + OP[c * 3 + 1]) / 2, (OP[a * 3 + 2] + OP[c * 3 + 2]) / 2);
      if (sgi < 0) continue;
      const pa = wPt[segA[sgi]], pb = wPt[segB[sgi]];
      for (const s of sets) if (s.src?.has(pa, pb)) s.dst.add(ptOut[a], ptOut[c]);
    }
  }
  const geo = b.build();
  // explicitly built feature groups may name point pairs that are no prim edge (split input edges): drop those
  if (o.featureGroups.length) {
    const live = new Set<number>();
    for (let p = 0; p < geo.numPrims; p++) {
      const s = geo.primStart[p], e = geo.primStart[p + 1], last = geo.primClosed[p] ? e : e - 1;
      for (let v = s; v < last; v++) {
        const x = geo.vertexPoint[v], y = geo.vertexPoint[v + 1 < e ? v + 1 : s];
        if (x !== y) live.add(x < y ? x * EDGE_KEY_LIMIT + y : y * EDGE_KEY_LIMIT + x);
      }
    }
    for (const name of o.featureGroups) {
      const set = geo.edgeGroups.get(name);
      if (set) for (const k of [...set.keyIterator()]) if (!live.has(k)) set.deleteKey(k);
    }
  }
  // interpolated normals are no longer unit length
  for (const cls of ['point', 'vertex', 'prim'] as const) {
    const n = geo.table(cls).get('N');
    if (!n || n.type !== 'float' || n.size !== 3) continue;
    const d = n.data as Float64Array;
    for (let i = 0; i < d.length; i += 3) { const l = Math.hypot(d[i], d[i + 1], d[i + 2]); if (l > 1e-20) { d[i] /= l; d[i + 1] /= l; d[i + 2] /= l; } }
  }
  return { geo, targetLength: L, inputTriangles: nt, outputTriangles: ont, stats: { ...out.stats, features: ns, lockedPoints: locked } };
}
