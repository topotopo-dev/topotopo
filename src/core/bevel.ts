// Poly bevel kernels (Houdini PolyBevel / Blender bevel construction) on the half-edge structure.
//
// EDGE BEVEL
//  - Around every point v that touches a bevelled edge, the polygon fan is walked in rotation order: outgoing
//    half-edges h_0..h_{k-1}, fan edges e_i (edge of h_i), face F_i = face(h_i) lying between e_i (its out-edge at v)
//    and e_{i+1} (its in-edge). Each corner of F_i at v is replaced by a short chain of new points, ordered in the
//    face's winding (from the in-edge side to the out-edge side):
//      both edges bevelled  → one "offset meet" point in the face at the offset distance from both edge lines;
//      one edge bevelled    → one point sliding along the other (unbevelled) edge, at the offset distance from the
//                             bevelled edge's line;
//      neither              → the slide points of its two edges, or v itself where an edge has no slide point.
//    A slide point is shared by both faces of its edge (the two faces' slide distances are averaged).
//  - Each bevelled edge a→b (half-edge h in face F_L, twin in F_R) becomes a strip of divisions+1 quads. At each end
//    the strip's cross-section is a profile from the end point in F_L to the end point in F_R: a superellipse arc
//    O + (P0-O)·cos(φ)^(2/r) + (P1-O)·sin(φ)^(2/r), O = P0 + P1 - C, tangent to both faces because the control point C
//    lies on the edge line (the projection of the chord midpoint, or v itself where two boundary points meet, see
//    below). r = 2^(1+2·shape): 0 = circular arc, 1 = nearly square, -0.5 = straight, -1 = concave cove.
//  - Going around v, the faces' boundary points and the strips' end profiles enclose a hole. Its boundary is the
//    concatenation of the reversed face chains with the profile interiors inserted at bevelled edges.
//      3+ distinct boundary points → corner patch: the polygon itself for a chamfer; for round bevels concentric
//        rings of quads (an n-sided polygon or a single point in the middle, all-quad when divisions is odd), relaxed
//        and pushed onto the sphere / superellipsoid around the profiles' common centre — the cube corner becomes an
//        exact sphere octant. Patches whose sides differ in length fall back to a triangle fan. Where v itself is kept
//        (a strip ending at a point with several unbevelled edges), the hole is split at v into lobes, each closed
//        through v and filled as a polygon (chamfer) or a fan from v; a lobe whose points all lie on one line (a flat
//        edge ending where the surface continues flat) is folded into the strip end and the faces instead.
//      2 distinct points (a single bevelled edge ending at an unbevelled point, or two bevelled edges meeting at a
//        mitre such as a cylinder rim) → no patch: the profile uses v as control point and is shared with the
//        neighbouring face (its points are inserted into the face) or with the other strip.
//    Open fans (points on a mesh boundary) get a polygon closing the path, whose closing edge is the new boundary.
//  - Clamp: every new point moves linearly with the offset, so the largest scale λ at which no unbevelled edge is
//    slid past its other end's slide point and no strip side turns inside out (its two end points pass each other
//    along the edge) is found exactly; all offsets are scaled by min(1, 0.999·λ).
// POINT BEVEL
//  Every fan edge of a selected point gets a point at the offset distance from it; each face loses the corner (its two
//  slide points replace it); the hole becomes a polygon, or for divisions > 0 a dome of `divisions` rings whose spokes
//  are superellipse arcs tangent to the edges (exact sphere for a cube corner) meeting at an apex.
//
// Attributes go through GeoBuilder provenance: new points copy their source point; face corners blend the face's own
// corner vertices affinely at the new position (uv stays continuous inside every face); strip vertices blend the two
// sides' corner sources across the profile; corner patches copy the corner vertex of v in the first face of the fan.
// Strips take prim attributes from the larger adjacent face, patches from the first face of the fan.
import { GeoBuilder } from './geometry.ts';
import type { Geometry, Src } from './geometry.ts';
import { EdgeSet, edgeFromKey, edgeKey } from './edges.ts';
import { halfEdges } from './halfedge.ts';
import type { HalfEdgeMesh } from './halfedge.ts';
import { primArea, primNewell, refreshNormals } from './topology.ts';

type V3 = [number, number, number];
/** A strip-end profile entering a corner patch: end points, control point, and how far (signed, relative to the chord) the control point sits outside the surface (> 0 convex edge, < 0 concave). */
interface Crossing { p0: V3; p1: V3; c: V3; bend: number }

export interface BevelOptions {
  /** offset distance (offsetMode distance) or fraction of the shortest edge at the element (fraction) */
  offset: number;
  offsetMode?: 'distance' | 'fraction';
  /** scale offsets down so neighbouring bevels never cross (default true) */
  clamp?: boolean;
  /** 0 = flat chamfer, n = round profile with n+1 segments */
  divisions?: number;
  /** profile convexity -1..1 (0 = circular) */
  shape?: number;
}

export interface BevelResult {
  geo: Geometry;
  warnings: string[];
  /** edges (edge mode) or points (point mode) actually bevelled */
  count: number;
  /** factor applied to the offsets by clamping (1 = unclamped) */
  scale: number;
}

/** Polygon fan around a point in rotation order. */
export interface PointFan {
  v: number;
  /** outgoing half-edges; face i = heFace[hs[i]] lies between fan edges i (out-edge) and i+1 (in-edge) */
  hs: number[];
  closed: boolean;
  /** fan edge ids: k for a closed fan, k + 1 for an open one (the first and last are then boundary edges) */
  edges: number[];
  /** the other endpoint of each fan edge */
  ends: number[];
}

/**
 * The manifold fan of polygons around v (null when v has no polygons, is a non-manifold point such as a bowtie, or a
 * polygon touches it twice). Open fans start at the outgoing boundary half-edge.
 */
export function pointFan(he: HalfEdgeMesh, v: number): PointFan | null {
  const start = he.pointFirst[v];
  if (start < 0) return null;
  const total = he.pointHalfStart[v + 1] - he.pointHalfStart[v];
  const hs: number[] = [];
  let h = start, closed = false;
  for (;;) {
    hs.push(h);
    const t = he.heTwin[he.hePrev[h]];
    if (t < 0) break;
    if (t === start) { closed = true; break; }
    if (hs.length >= total) return null;
    h = t;
  }
  if (hs.length !== total || (!closed && he.heTwin[start] >= 0)) return null;
  if (new Set(hs.map((x) => he.heFace[x])).size !== hs.length) return null;
  const edges = hs.map((x) => he.heEdge[x]), ends = hs.map((x) => he.dest(x));
  if (!closed) {
    const p = he.hePrev[hs[hs.length - 1]];
    edges.push(he.heEdge[p]);
    ends.push(he.heOrigin[p]);
  }
  return { v, hs, closed, edges, ends };
}

// ---------------------------------------------------------------- small vector helpers

const sub = (a: ArrayLike<number>, b: ArrayLike<number>): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: ArrayLike<number>, b: ArrayLike<number>): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: ArrayLike<number>, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: ArrayLike<number>, b: ArrayLike<number>): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: ArrayLike<number>) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3, fallback?: V3): V3 => {
  const l = len(a);
  return l > 1e-300 ? [a[0] / l, a[1] / l, a[2] / l] : fallback ?? [0, 0, 0];
};
const lerp3 = (a: ArrayLike<number>, b: ArrayLike<number>, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Superellipse exponent for a shape value in -1..1. */
export function shapeExponent(shape: number): number {
  return Math.pow(2, 1 + 2 * Math.max(-1, Math.min(1, shape)));
}

/** Point at parameter s (0..1) of the profile from p0 to p1 with control point c (see the header). */
export function profilePoint(p0: V3, p1: V3, c: V3, s: number, r: number): V3 {
  const phi = (s * Math.PI) / 2;
  const X = Math.pow(Math.max(0, Math.cos(phi)), 2 / r), Y = Math.pow(Math.max(0, Math.sin(phi)), 2 / r);
  const O = sub(add(p0, p1), c);
  return [O[0] + (p0[0] - O[0]) * X + (p1[0] - O[0]) * Y, O[1] + (p0[1] - O[1]) * X + (p1[1] - O[1]) * Y, O[2] + (p0[2] - O[2]) * X + (p1[2] - O[2]) * Y];
}

function mixSrc(a: Src, b: Src, t: number): Src {
  const A = toBlend(a), B = toBlend(b);
  if (t <= 0) return a;
  if (t >= 1) return b;
  const i: number[] = [], w: number[] = [];
  for (let k = 0; k < A.i.length; k++) { i.push(A.i[k]); w.push(A.w[k] * (1 - t)); }
  for (let k = 0; k < B.i.length; k++) { i.push(B.i[k]); w.push(B.w[k] * t); }
  return { i, w };
}
function toBlend(s: Src): { i: ArrayLike<number>; w: ArrayLike<number> } {
  if (s === null || s === undefined) return { i: [], w: [] };
  if (typeof s === 'number') return { i: [s], w: [1] };
  return s;
}

// ---------------------------------------------------------------- shared state

/** One element of a face-corner chain before positions are known. */
type Elem = { k: 0 } | { k: 1; j: number } | { k: 2; x: V3 };

interface VRec {
  fan: PointFan;
  k: number;
  bev: Uint8Array;
  d: Float64Array;
  dir: V3[];
  elen: Float64Array;
  slideT: Float64Array; // NaN = no slide point on that fan edge
  elems: Elem[][];
  // built
  slidePt: Int32Array;
  chains: number[][];
  chainSrc: Src[][];
}

/** Index of the in-edge (fan edge i+1) of face i. */
const inIdx = (r: { fan: PointFan; k: number }, i: number) => (r.fan.closed ? (i + 1) % r.k : i + 1);
/** Face before fan edge j (the face whose in-edge is j). */
const faceBefore = (r: { fan: PointFan; k: number }, j: number) => (r.fan.closed ? (j - 1 + r.k) % r.k : j - 1);

class Ctx {
  g: Geometry;
  he: HalfEdgeMesh;
  P: Float64Array;
  b: GeoBuilder;
  r: number;
  n: number;
  private fnorm: Float64Array;
  private fdone: Uint8Array;
  /** prims emitted by the bevel (strips + patches): point lists, prim source, vertex sources, corner flag */
  newPrims: { pts: number[]; src: number; vsrc: Src[]; corner: boolean }[] = [];

  constructor(g: Geometry, divisions: number, shape: number) {
    this.g = g;
    this.he = halfEdges(g);
    this.P = g.P;
    this.b = new GeoBuilder(g);
    for (let i = 0; i < g.numPoints; i++) this.b.copyPoint(i);
    this.n = Math.max(0, Math.floor(divisions));
    this.r = shapeExponent(shape);
    this.fnorm = new Float64Array(g.numPrims * 3);
    this.fdone = new Uint8Array(g.numPrims);
  }

  pt(i: number): V3 { return [this.P[i * 3], this.P[i * 3 + 1], this.P[i * 3 + 2]]; }
  bpos(id: number): V3 { const p = this.b.pos; return [p[id * 3], p[id * 3 + 1], p[id * 3 + 2]]; }
  /** point provenance of the points this kernel created (original points are their own source) */
  private psrc: Src[] = [];
  add(p: V3, src: Src): number {
    const id = this.b.addPoint(p[0], p[1], p[2], src);
    this.psrc[id] = src;
    return id;
  }
  srcOf(id: number): Src { return this.psrc[id] ?? id; }

  faceN(f: number): V3 {
    if (!this.fdone[f]) {
      const t = primNewell(this.g, f), l = Math.hypot(t[0], t[1], t[2]) || 1;
      this.fnorm[f * 3] = t[0] / l; this.fnorm[f * 3 + 1] = t[1] / l; this.fnorm[f * 3 + 2] = t[2] / l;
      this.fdone[f] = 1;
    }
    return [this.fnorm[f * 3], this.fnorm[f * 3 + 1], this.fnorm[f * 3 + 2]];
  }

  /** Affine coordinates (along prev, along next) of p in the corner of half-edge h; null at the corner or if degenerate. */
  private cornerCoords(h: number, p: V3): [number, number] | null {
    const he = this.he;
    const c = this.pt(he.heOrigin[h]);
    const A = sub(this.pt(he.heOrigin[he.hePrev[h]]), c), B = sub(this.pt(he.dest(h)), c), D = sub(p, c);
    const aa = dot(A, A), bb = dot(B, B), ab = dot(A, B), ad = dot(A, D), bd = dot(B, D);
    const det = aa * bb - ab * ab;
    if (!(Math.abs(det) > 1e-14 * aa * bb)) return null;
    const al = (ad * bb - bd * ab) / det, be = (bd * aa - ad * ab) / det;
    return Math.abs(al) < 1e-12 && Math.abs(be) < 1e-12 ? null : [al, be];
  }

  /** Vertex provenance: affine blend of h's corner (corner, prev, next vertices) reproducing position p. */
  blendAt(h: number, p: V3): Src {
    const he = this.he, w = this.cornerCoords(h, p);
    if (!w) return he.heVertex[h];
    return { i: [he.heVertex[h], he.heVertex[he.hePrev[h]], he.heVertex[he.heNext[h]]], w: [1 - w[0] - w[1], w[0], w[1]] };
  }

  /** Point provenance: the same blend over the corner's points. */
  pointBlendAt(h: number, p: V3): Src {
    const he = this.he, w = this.cornerCoords(h, p);
    if (!w) return he.heOrigin[h];
    return { i: [he.heOrigin[h], he.heOrigin[he.hePrev[h]], he.dest(h)], w: [1 - w[0] - w[1], w[0], w[1]] };
  }

  /**
   * Corner patch for a closed loop of boundary points that does not pass through v (see the header). Interior points
   * copy point v. Sides of equal length (all profiles) get the ring grid, others a triangle fan around a centre point.
   */
  patch(v: number, boundary: number[], sideStart: number[], crossings: Crossing[], vsrc: number, psrc: number) {
    const K = sideStart.length;
    const segs = sideStart.map((s, j) => ((j + 1 < K ? sideStart[j + 1] : boundary.length) - s));
    const uniform = segs.every((s) => s === segs[0]);
    const ns = segs[0];
    const pos: V3[] = boundary.map((id) => this.bpos(id));
    const ids: number[] = boundary.slice();
    const faces: number[][] = [];
    const G = scale(pos.reduce((s, p) => add(s, p), [0, 0, 0] as V3), 1 / pos.length);
    const newLocal = (p: V3) => { pos.push(p); ids.push(-1); return pos.length - 1; };
    if (uniform && ns === 1) faces.push(boundary.map((_, i) => i));
    else if (uniform) {
      // concentric rings: ring r has K·(ns - 2r) points; a single centre point when ns is even, a K-gon when odd
      const ringStart: number[] = [0];
      const at = (r: number, j: number, i: number): number => {
        const L = ns - 2 * r;
        if (L === 0) return ringStart[r];
        let jj = ((j % K) + K) % K;
        let li = i - r;
        if (li === L) { jj = (jj + 1) % K; li = 0; }
        return ringStart[r] + jj * L + li;
      };
      for (let r = 1; ns - 2 * r >= 0; r++) {
        const L = ns - 2 * r, t = Math.min(1, r / (ns / 2));
        if (L === 0) { ringStart[r] = newLocal(G); break; }
        ringStart[r] = pos.length;
        for (let j = 0; j < K; j++) for (let i = r; i < ns - r; i++) newLocal(lerp3(pos[at(0, j, i)], G, t));
      }
      for (let r = 0; ; r++) {
        const L = ns - 2 * r;
        if (L <= 0) break;
        if (L === 1) { faces.push(Array.from({ length: K }, (_, j) => at(r, j, r))); break; }
        const inner = (j: number, i: number) => at(r + 1, j, i);
        for (let j = 0; j < K; j++) {
          faces.push([at(r, j - 1, ns - r - 1), at(r, j, r), at(r, j, r + 1), inner(j, r + 1)]);
          for (let i = r + 1; i <= ns - r - 2; i++) faces.push([at(r, j, i), at(r, j, i + 1), inner(j, i + 1), inner(j, i)]);
        }
      }
    } else {
      const c = newLocal(G);
      for (let i = 0; i < boundary.length; i++) faces.push([i, (i + 1) % boundary.length, c]);
    }
    if (pos.length > boundary.length) {
      // relax interior points (Gauss-Seidel on the patch graph), then inflate towards the profiles' sphere
      const nb: Set<number>[] = pos.map(() => new Set());
      for (const f of faces) for (let q = 0; q < f.length; q++) { const a = f[q], c = f[(q + 1) % f.length]; nb[a].add(c); nb[c].add(a); }
      const iters = 20 + 4 * ns;
      for (let it = 0; it < iters; it++)
        for (let i = boundary.length; i < pos.length; i++) {
          let x = 0, y = 0, z = 0;
          for (const q of nb[i]) { x += pos[q][0]; y += pos[q][1]; z += pos[q][2]; }
          const m = nb[i].size || 1;
          pos[i] = [x / m, y / m, z / m];
        }
      // only all-profile patches (the ring grid) bulge; a patch with straight sides lies in its faces' surface
      if (uniform) this.inflate(pos, boundary.length, sideStart.map((s) => pos[s]), crossings);
      for (let i = boundary.length; i < pos.length; i++) ids[i] = this.add(pos[i], v);
    }
    for (const f of faces) this.emit(f.map((i) => ids[i]), psrc, f.map(() => vsrc), true);
  }

  /**
   * Push interior points (index >= first) onto the sphere / superellipsoid around the profiles' common centre. Only when
   * the profiles agree: all convex or all concave, with nearby centres. Saddle corners (convex and concave edges meeting)
   * and flat ones keep the relaxed, harmonic patch.
   */
  inflate(pos: V3[], first: number, corners: V3[], crossings: Crossing[]) {
    if (this.n === 0 || !crossings.length) return;
    let O: V3 = [0, 0, 0], convex = 0, concave = 0;
    for (const x of crossings) {
      O = add(O, sub(add(x.p0, x.p1), x.c));
      if (x.bend > 0.02) convex++;
      else if (x.bend < -0.02) concave++;
    }
    if ((convex && concave) || !(convex || concave)) return;
    O = scale(O, 1 / crossings.length);
    const axes = corners.map((c) => unit(sub(c, O)));
    let R = 0;
    for (const c of corners) R += len(sub(c, O));
    R /= corners.length;
    if (!(R > 1e-12)) return;
    for (const x of crossings) if (len(sub(sub(add(x.p0, x.p1), x.c), O)) > 0.5 * R) return;
    const r = this.r;
    for (let i = first; i < pos.length; i++) {
      const d = sub(pos[i], O), l = len(d);
      if (!(l > 1e-12 * R)) continue;
      const u = scale(d, 1 / l);
      let sr = 0, s2 = 0;
      for (const a of axes) { const c = Math.max(0, dot(u, a)); sr += Math.pow(c, r); s2 += c * c; }
      const f = sr > 0 && s2 > 0 ? Math.pow(sr, -1 / r) / Math.pow(s2, -0.5) : 1;
      pos[i] = add(O, scale(u, R * f));
    }
  }

  emit(pts: number[], src: number, vsrc: Src[], corner: boolean) {
    // drop consecutive repeats (degenerate configurations); skip prims that collapse
    const p: number[] = [], s: Src[] = [], n = pts.length;
    for (let i = 0; i < n; i++) if (pts[i] !== pts[(i + n - 1) % n]) { p.push(pts[i]); s.push(vsrc[i]); }
    if (p.length < 3) return;
    this.newPrims.push({ pts: p, src, vsrc: s, corner });
  }

  /**
   * Emit the rebuilt input prims (corners replaced by chainOf[half-edge]), then the new prims, groups and the
   * bevel_edges edge group; return the finished geometry.
   */
  finish(chainOf: (number[] | undefined)[], chainSrcOf: (Src[] | undefined)[]): Geometry {
    // N is recomputed at the end: every edge of a chamfer is hard, round bevels shade smoothly (cusp 60°)
    const g = this.g, he = this.he, b = this.b;
    const bevel = b.group('prim', 'bevel'), corner = b.group('prim', 'bevel_corner');
    const use = new Map<number, number>();
    const mark = (pts: number[], bit: number) => {
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], c = pts[(i + 1) % pts.length];
        if (a === c) continue;
        const k = edgeKey(a, c);
        use.set(k, (use.get(k) ?? 0) | bit);
      }
    };
    for (let p = 0; p < g.numPrims; p++) {
      const s = g.primStart[p], e = g.primStart[p + 1];
      const pts: number[] = [], src: Src[] = [];
      let touched = false;
      if (he.faceFirst[p] >= 0)
        for (let v = s; v < e; v++) if (chainOf[he.vertexHalf[v]]) { touched = true; break; }
      for (let v = s; v < e; v++) {
        const ch = touched ? chainOf[he.vertexHalf[v]] : undefined;
        if (ch) { pts.push(...ch); src.push(...chainSrcOf[he.vertexHalf[v]]!); }
        else { pts.push(g.vertexPoint[v]); src.push(v); }
      }
      b.addPrim(pts, !!g.primClosed[p], p, src);
      if (touched) mark(pts, 2); // only rebuilt faces can share an edge with a strip or patch
    }
    for (const q of this.newPrims) {
      const id = b.addPrim(q.pts, true, q.src, q.vsrc);
      bevel.add(id);
      if (q.corner) corner.add(id);
      mark(q.pts, 1);
    }
    const eg = b.edgeGroup('bevel_edges');
    const hard = new EdgeSet(); // builder point ids; only used for a chamfer's normals
    for (const [k, bits] of use) {
      if (bits === 3) { const [a, c] = edgeFromKey(k); eg.add(a, c); }
      if (bits & 1) hard.addKey(k);
    }
    const built = b.build();
    // strips and patches copy prim attributes from a face, but not its groups (they are in bevel / bevel_corner)
    const first = built.numPrims - this.newPrims.length;
    for (const [name, m] of built.primGroups) if (name !== 'bevel' && name !== 'bevel_corner') m.fill(0, first);
    const hasN = ['point', 'vertex', 'prim'].some((c) => g.table(c as 'point').get('N')?.size === 3);
    if (hasN && this.n === 0) built.edgeGroups.set('__bevel_hard', hard);
    let out = built.removeUnusedPoints(); // (remaps edge groups)
    if (hasN) {
      const h = out.edgeGroups.get('__bevel_hard') ?? null;
      out.edgeGroups.delete('__bevel_hard');
      out = refreshNormals(out, 60, h);
    }
    return out;
  }
}

// ---------------------------------------------------------------- edge bevel

/** Edges whose two faces bend less than this (degrees) are flat: the default selection leaves them alone. */
export const FLAT_EDGE_DEG = 0.01;

/**
 * Bevel the given edges (point pairs; null = every edge used by two polygons where the surface bends). Boundary, non-manifold and
 * inconsistently wound edges, and edges at non-manifold points, are skipped with a warning. Returns the input object
 * itself when nothing is bevelled.
 */
export function bevelEdges(g: Geometry, sel: EdgeSet | null, opts: BevelOptions): BevelResult {
  const warnings: string[] = [];
  const he = halfEdges(g);
  const ne = he.numEdges;
  const bevE = new Uint8Array(ne);
  let nBoundary = 0, nNonManifold = 0, nNotPoly = 0;
  if (sel) {
    for (const key of sel.keyIterator()) {
      const [a, c] = edgeFromKey(key);
      const e = he.edgeId(a, c);
      if (e < 0) { nNotPoly++; continue; }
      if (he.edgeValence(e) === 1) nBoundary++;
      else if (he.nonManifoldEdges.has(e)) nNonManifold++;
      else bevE[e] = 1;
    }
  } else
    for (let e = 0; e < ne; e++) {
      const val = he.edgeValence(e);
      if (val < 2) continue;
      if (he.nonManifoldEdges.has(e)) nNonManifold++;
      // an edge inside a flat area (a face split in two, a boolean's cut face) has nothing to bevel
      else if (!(he.dihedralAngle(e) < FLAT_EDGE_DEG)) bevE[e] = 1;
    }
  if (nBoundary) warnings.push(`${nBoundary} boundary edge(s) skipped: bevelling open-mesh edges is not supported`);
  if (nNonManifold) warnings.push(`${nNonManifold} non-manifold or inconsistently wound edge(s) skipped`);
  if (nNotPoly) warnings.push(`${nNotPoly} selected edge(s) are not polygon edges (polyline segments) and were skipped`);
  // fans of the endpoints; edges at non-manifold points are dropped
  const fans = new Map<number, PointFan | null>();
  const fanOf = (v: number) => { if (!fans.has(v)) fans.set(v, pointFan(he, v)); return fans.get(v)!; };
  let nBadPoint = 0;
  for (let e = 0; e < ne; e++) {
    if (!bevE[e]) continue;
    if (!fanOf(he.edgeA[e]) || !fanOf(he.edgeB[e])) { bevE[e] = 0; nBadPoint++; }
  }
  if (nBadPoint) warnings.push(`${nBadPoint} edge(s) skipped at non-manifold points`);
  let count = 0;
  for (let e = 0; e < ne; e++) count += bevE[e];
  if (!count) {
    warnings.push(sel ? 'no edges to bevel: geometry unchanged' : 'no edges to bevel: every edge is flat (both faces in one plane) or open; geometry unchanged');
    return { geo: g, warnings, count: 0, scale: 1 };
  }
  const offsetMode = opts.offsetMode ?? 'distance';
  // per-edge offsets
  const offE = new Float64Array(ne);
  const minFanLen = (v: number) => {
    const f = fans.get(v)!;
    let m = Infinity;
    for (const w of f.ends) m = Math.min(m, Math.hypot(g.P[w * 3] - g.P[v * 3], g.P[w * 3 + 1] - g.P[v * 3 + 1], g.P[w * 3 + 2] - g.P[v * 3 + 2]));
    return m;
  };
  for (let e = 0; e < ne; e++)
    if (bevE[e]) offE[e] = offsetMode === 'fraction' ? opts.offset * Math.min(minFanLen(he.edgeA[e]), minFanLen(he.edgeB[e])) : opts.offset;

  const C = new Ctx(g, opts.divisions ?? 0, opts.shape ?? 0);
  const n = C.n;
  // Pass A and the crossing constraints at the current offsets: each constraint is [largest scale, its two points].
  const analyse = () => {
    const recs = new Map<number, VRec>();
    const cons: [number, number, number][] = [];
    // ---- pass A: symbolic corner chains and offset vectors at scale 1
    for (const [v, fan] of fans) {
      if (!fan) continue;
      const k = fan.hs.length, m = fan.edges.length;
      const bev = new Uint8Array(m), d = new Float64Array(m), elen = new Float64Array(m);
      const dir: V3[] = [];
      let any = false;
      const pv = C.pt(v);
      for (let j = 0; j < m; j++) {
        bev[j] = bevE[fan.edges[j]];
        if (bev[j]) any = true;
        d[j] = bev[j] ? offE[fan.edges[j]] : 0;
        const w = sub(C.pt(fan.ends[j]), pv);
        elen[j] = len(w);
        dir.push(unit(w, [1, 0, 0]));
      }
      if (!any) continue;
      const rec: VRec = {
        fan, k, bev, d, dir, elen, slideT: new Float64Array(m).fill(NaN), elems: [],
        slidePt: new Int32Array(m).fill(-1), chains: [], chainSrc: [],
      };
      const sum = new Float64Array(m), cnt = new Int32Array(m);
      const uu: number[] = [];
      for (let i = 0; i < k; i++) {
        const N = C.faceN(he.heFace[fan.hs[i]]);
        const jo = i, ji = inIdx(rec, i);
        const uo = dir[jo], ui = dir[ji];
        const upo = unit(sub(uo, scale(N, dot(uo, N))), uo), upi = unit(sub(ui, scale(N, dot(ui, N))), ui);
        const mo = cross3(N, upo), mi = cross3(upi, N);
        if (bev[jo] && bev[ji]) {
          const sig = dot(N, cross3(upo, upi));
          let x: V3;
          if (Math.abs(sig) > 1e-4) x = scale(add(scale(upi, d[jo]), scale(upo, d[ji])), 1 / sig);
          else x = scale(unit(add(mi, mo), mo), (d[jo] + d[ji]) / 2);
          rec.elems[i] = [{ k: 2, x }];
        } else if (bev[jo]) {
          const s = dot(ui, mo);
          sum[ji] += s > 0 ? d[jo] / Math.max(s, 0.2) : d[jo]; cnt[ji]++;
          rec.elems[i] = [{ k: 1, j: ji }];
        } else if (bev[ji]) {
          const s = dot(uo, mi);
          sum[jo] += s > 0 ? d[ji] / Math.max(s, 0.2) : d[ji]; cnt[jo]++;
          rec.elems[i] = [{ k: 1, j: jo }];
        } else uu.push(i);
      }
      for (let j = 0; j < m; j++) if (cnt[j]) rec.slideT[j] = sum[j] / cnt[j];
      for (const i of uu) {
        const jo = i, ji = inIdx(rec, i);
        const a: Elem = Number.isNaN(rec.slideT[ji]) ? { k: 0 } : { k: 1, j: ji };
        const c: Elem = Number.isNaN(rec.slideT[jo]) ? { k: 0 } : { k: 1, j: jo };
        rec.elems[i] = a.k === 0 && c.k === 0 ? [a] : [a, c];
      }
      recs.set(v, rec);
    }
    // ---- clamp: largest scale at which nothing crosses
    const vecOf = (rec: VRec, el: Elem): V3 => (el.k === 0 ? [0, 0, 0] : el.k === 1 ? scale(rec.dir[el.j], rec.slideT[el.j]) : el.x);
    let lambda = Infinity;
    let pair: [number, number] = [-1, -1];
    const limit = (length: number, coef: number) => {
      if (coef <= 1e-12) return;
      const l = length / coef;
      if (l < lambda) lambda = l;
      if (l < 1) cons.push([l, pair[0], pair[1]]);
    };
    for (const [v, rec] of recs) {
      const { fan } = rec;
      for (let j = 0; j < fan.edges.length; j++) {
        if (rec.bev[j] || Number.isNaN(rec.slideT[j])) continue;
        const w = fan.ends[j], rw = recs.get(w);
        let tw = 0;
        if (rw) { const jw = rw.fan.edges.indexOf(fan.edges[j]); if (jw >= 0 && !Number.isNaN(rw.slideT[jw])) tw = rw.slideT[jw]; }
        pair = [v, w];
        limit(rec.elen[j], rec.slideT[j] + tw);
      }
    }
    for (let e = 0; e < ne; e++) {
      if (!bevE[e]) continue;
      const h = he.edgeHalf[e], t = he.heTwin[h];
      const a = he.heOrigin[h], c = he.dest(h);
      const ra = recs.get(a)!, rc = recs.get(c)!;
      const ja = ra.fan.hs.indexOf(h), jc = rc.fan.hs.indexOf(t);
      const u = unit(sub(C.pt(c), C.pt(a)));
      const L = len(sub(C.pt(c), C.pt(a)));
      // side F_L: a's chain in face(h) (last element), c's chain in face(h) = face before jc (first element)
      pair = [a, c];
      const La = ra.elems[ja][ra.elems[ja].length - 1], Lc = rc.elems[faceBefore(rc, jc)][0];
      limit(L, dot(vecOf(ra, La), u) - dot(vecOf(rc, Lc), u));
      const Ra = ra.elems[faceBefore(ra, ja)][0], Rc = rc.elems[jc][rc.elems[jc].length - 1];
      limit(L, dot(vecOf(ra, Ra), u) - dot(vecOf(rc, Rc), u));
    }
    return { recs, cons, lambda };
  };
  // ---- clamp, locally: where bevels would cross, shrink only the offsets of the edges at the points involved (a
  // few rounds), so one short edge does not flatten every bevel of the mesh; an edge that would keep under a tenth of
  // what the best-kept edges keep (a zero-length or tiny edge next to it) stays sharp. Whatever still crosses is
  // clamped by one factor.
  const clamp = opts.clamp ?? true;
  const off0 = Float64Array.from(offE);
  let { recs, cons, lambda } = analyse();
  let nDropped = 0;
  for (let round = 0; clamp && lambda < 1 && round < 8; round++) {
    const sV = new Map<number, number>();
    const lower = (v: number, l: number) => { if (v >= 0) sV.set(v, Math.min(sV.get(v) ?? 1, l)); };
    for (const [l, p, q] of cons) { lower(p, l * 0.999); lower(q, l * 0.999); }
    let best = 0;
    for (let e = 0; e < ne; e++) {
      if (!bevE[e]) continue;
      const f = Math.min(sV.get(he.edgeA[e]) ?? 1, sV.get(he.edgeB[e]) ?? 1);
      if (f < 1) offE[e] *= f;
      best = Math.max(best, offE[e] / off0[e]);
    }
    // an edge keeping under a tenth of what the best-kept edges keep would only be a sliver: leave it sharp (a huge
    // offset that every edge must give up evenly is not dropped)
    for (let e = 0; e < ne; e++)
      if (bevE[e] && offE[e] < off0[e] * 0.1 * best) { bevE[e] = 0; offE[e] = 0; nDropped++; }
    ({ recs, cons, lambda } = analyse());
  }
  let reduced = 0, minLocal = 1;
  for (let e = 0; e < ne; e++)
    if (bevE[e] && offE[e] < off0[e] * 0.9999) { reduced++; minLocal = Math.min(minLocal, offE[e] / off0[e]); }
  if (reduced) warnings.push(`offset reduced at ${reduced} edge(s) (to ${(minLocal * 100).toFixed(1)}% at least) so neighbouring bevels do not overlap; the other edges keep the full offset`);
  if (nDropped) warnings.push(`${nDropped} edge(s) left sharp: a neighbouring edge is too short to fit the bevel (zero-length edges from duplicate points? fuse first)`);
  if (nDropped) {
    count = 0;
    for (let e = 0; e < ne; e++) count += bevE[e];
  }
  if (!count) {
    warnings.push('no edges to bevel: geometry unchanged');
    return { geo: g, warnings, count: 0, scale: 0 };
  }
  let sc = 1;
  if (clamp && lambda < 1) {
    sc = lambda * 0.999;
    warnings.push(`offset clamped to ${(sc * 100).toFixed(1)}% so neighbouring bevels do not overlap`);
  }
  // ---- pass B: points and chains
  const chainOf: (number[] | undefined)[] = new Array(he.numHalfEdges);
  const chainSrcOf: (Src[] | undefined)[] = new Array(he.numHalfEdges);
  for (const [v, rec] of recs) {
    const pv = C.pt(v);
    const { fan } = rec;
    for (let j = 0; j < fan.edges.length; j++)
      if (!Number.isNaN(rec.slideT[j])) {
        const t = rec.slideT[j] * sc, tau = rec.elen[j] > 0 ? t / rec.elen[j] : 0;
        rec.slidePt[j] = C.add(add(pv, scale(rec.dir[j], t)), { i: [v, fan.ends[j]], w: [1 - tau, tau] });
      }
    for (let i = 0; i < rec.k; i++) {
      const h = fan.hs[i];
      const ids: number[] = [], srcs: Src[] = [];
      for (const el of rec.elems[i]) {
        let id: number;
        if (el.k === 0) {
          id = v;
          srcs.push(he.heVertex[h]);
        } else {
          if (el.k === 1) id = rec.slidePt[el.j];
          else { const p = add(pv, scale(el.x, sc)); id = C.add(p, C.pointBlendAt(h, p)); }
          srcs.push(C.blendAt(h, C.bpos(id)));
        }
        ids.push(id);
      }
      rec.chains[i] = ids;
      rec.chainSrc[i] = srcs;
      chainOf[h] = ids;
      chainSrcOf[h] = srcs;
    }
  }
  // ---- per point: hole boundary, profiles, patches
  const profileOf: (number[] | undefined)[] = new Array(he.numHalfEdges);
  const extraOf: ({ k: number; id: number } | undefined)[] = new Array(he.numHalfEdges);
  for (const [v, rec] of recs) {
    const { fan, k } = rec;
    const pv = C.pt(v);
    const seq: number[] = [], cross: number[] = [];
    const push = (id: number) => { if (seq.length && seq[seq.length - 1] === id) return; seq.push(id); cross.push(-1); };
    for (let i = 0; i < k; i++) {
      const ch = rec.chains[i];
      for (let q = ch.length - 1; q >= 0; q--) push(ch[q]);
      const jn = inIdx(rec, i);
      if (rec.bev[jn]) cross[cross.length - 1] = jn;
    }
    if (fan.closed && seq.length > 1 && seq[0] === seq[seq.length - 1]) { seq.pop(); cross.pop(); }
    const K = seq.length;
    const digon = K === 2;
    // profiles at every bevelled crossing
    const crossInfo: Crossing[] = [];
    const makeProfile = (j: number): number[] => {
      const i0 = faceBefore(rec, j);
      const x0 = rec.chains[i0][0], x1 = rec.chains[j][rec.chains[j].length - 1];
      const p0 = C.bpos(x0), p1 = C.bpos(x1);
      let c: V3;
      if (digon) c = pv;
      else {
        const u = rec.dir[j], mid = lerp3(p0, p1, 0.5);
        c = add(pv, scale(u, dot(sub(mid, pv), u)));
      }
      const nrm = unit(add(C.faceN(he.heFace[fan.hs[i0]]), C.faceN(he.heFace[fan.hs[j]])));
      const chord = len(sub(p1, p0));
      crossInfo.push({ p0, p1, c, bend: chord > 0 ? dot(sub(c, lerp3(p0, p1, 0.5)), nrm) / chord : 0 });
      const ids = [x0];
      for (let q = 1; q <= n; q++) ids.push(C.add(profilePoint(p0, p1, c, q / (n + 1), C.r), mixSrc(C.srcOf(x0), C.srcOf(x1), q / (n + 1))));
      ids.push(x1);
      return ids;
    };
    const profs = new Map<number, number[]>();
    for (let s = 0; s < K; s++) {
      const j = cross[s];
      if (j < 0 || profs.has(j)) continue;
      if (digon && fan.closed && n > 0) {
        const other = cross[1 - s];
        const pr = makeProfile(j);
        profs.set(j, pr);
        if (other >= 0) profs.set(other, pr.slice().reverse());
        else {
          // a single bevelled edge ends here: the face holding [x0, x1] takes the profile points
          const x0 = pr[0], x1 = pr[pr.length - 1];
          let done = false;
          for (let i = 0; i < k && !done; i++) {
            const ch = rec.chains[i];
            const q = ch.findIndex((id, qi) => id === x0 && ch[qi + 1] === x1);
            if (q < 0) continue;
            const ins = pr.slice(1, -1);
            ch.splice(q + 1, 0, ...ins);
            rec.chainSrc[i].splice(q + 1, 0, ...ins.map((id) => C.blendAt(fan.hs[i], C.bpos(id))));
            done = true;
          }
          // (not expected) otherwise close the gap between the straight face edge and the profile with a polygon
          if (!done) C.emit(pr, he.heFace[fan.hs[0]], pr.map(() => he.heVertex[fan.hs[0]]), true);
        }
      } else profs.set(j, makeProfile(j));
    }
    for (const [j, pr] of profs) profileOf[fan.hs[j]] = pr;
    if (K < 3) continue;
    // corner patch
    const boundary: number[] = [], sideStart: number[] = [];
    for (let s = 0; s < K; s++) {
      sideStart.push(boundary.length);
      boundary.push(seq[s]);
      if (cross[s] >= 0) boundary.push(...profs.get(cross[s])!.slice(1, -1));
    }
    const vsrc = he.heVertex[fan.hs[0]], psrc = he.heFace[fan.hs[0]];
    // A flat edge ending where the surface continues flat (kept point v between two slide points on a straight line):
    // the patch would have zero area. Instead v joins the strip's end (replacing a coincident profile point, or as an
    // extra corner of one end quad), and the profile points on either side of v join the two faces along that line.
    const sc1 = cross.filter((j) => j >= 0);
    if (fan.closed && K === 3 && sc1.length === 1) {
      const s0 = cross.indexOf(sc1[0]), kv = seq[(s0 + 2) % 3], base = profs.get(sc1[0])!;
      const x0 = base[0], x1 = base[base.length - 1];
      const P0 = C.bpos(x0), P1 = C.bpos(x1), chord = sub(P1, P0), cl = dot(chord, chord);
      const nw = boundary.reduce((acc, id, i) => add(acc, cross3(C.bpos(id), C.bpos(boundary[(i + 1) % boundary.length]))), [0, 0, 0] as V3);
      if (cl > 0 && len(nw) < 1e-9 * cl) {
        const pk = C.bpos(kv), tk = dot(sub(pk, P0), chord) / cl;
        const hit = base.findIndex((id, i) => i > 0 && i < base.length - 1 && len(sub(C.bpos(id), pk)) < 1e-9 * Math.sqrt(cl));
        if (hit >= 0) base[hit] = kv;
        else {
          let at = 0;
          while (at < base.length - 2 && dot(sub(C.bpos(base[at + 1]), P0), chord) / cl < tk) at++;
          extraOf[fan.hs[sc1[0]]] = { k: at, id: kv };
        }
        const inner = base.slice(1, -1).filter((id) => id !== kv);
        const lower = inner.filter((id) => dot(sub(C.bpos(id), P0), chord) / cl < tk), upper = inner.filter((id) => !lower.includes(id));
        // faces hold [x0, v] and [v, x1] (in profile order); the points between join them
        for (let i = 0; i < k; i++) {
          const ch = rec.chains[i];
          for (const [a0, a1, ins] of [[x0, kv, lower], [kv, x1, upper]] as [number, number, number[]][]) {
            const q = ch.findIndex((id, qi) => id === a0 && ch[qi + 1] === a1);
            if (q < 0 || !ins.length) continue;
            ch.splice(q + 1, 0, ...ins);
            rec.chainSrc[i].splice(q + 1, 0, ...ins.map((id) => C.blendAt(fan.hs[i], C.bpos(id))));
          }
        }
        continue;
      }
    }
    const vi = boundary.indexOf(v);
    if (vi >= 0) {
      // lobes closed through v: polygons for a chamfer, fans from v for round bevels
      const loop = [...boundary.slice(vi), ...boundary.slice(0, vi)];
      let lobe: number[] = [v];
      const flush = () => {
        if (lobe.length >= 3) {
          if (n === 0) C.emit(lobe, psrc, lobe.map(() => vsrc), true);
          else for (let i = 1; i + 1 < lobe.length; i++) C.emit([v, lobe[i], lobe[i + 1]], psrc, [vsrc, vsrc, vsrc], true);
        }
        lobe = [v];
      };
      for (let i = 1; i < loop.length; i++) { if (loop[i] === v) flush(); else lobe.push(loop[i]); }
      flush();
    } else if (fan.closed) C.patch(v, boundary, sideStart, crossInfo, vsrc, psrc);
    else C.emit(boundary, psrc, boundary.map(() => vsrc), true);
  }
  // ---- strips
  for (let e = 0; e < ne; e++) {
    if (!bevE[e]) continue;
    const h = he.edgeHalf[e], t = he.heTwin[h];
    const q = profileOf[h]!.slice().reverse(), r = profileOf[t]!;
    // an extra point folded into an end (see above) sits inside one end quad: index of that quad, or -1
    const xa = extraOf[h], xb = extraOf[t];
    const qa = xa ? n - xa.k : -1, rb0 = xb ? xb.k : -1;
    const fl = he.heFace[h], fr = he.heFace[t];
    const psrc = primArea(g, fr) > primArea(g, fl) * (1 + 1e-9) ? fr : fl;
    // vertex sources: left side = the left face's corner sources, right side = the right face's, blended across
    const ra = recs.get(he.heOrigin[h])!, rb = recs.get(he.dest(h))!;
    const ja = ra.fan.hs.indexOf(h), jb = rb.fan.hs.indexOf(t);
    const la = ra.chainSrc[ja][ra.chainSrc[ja].length - 1], rA = ra.chainSrc[faceBefore(ra, ja)][0];
    const lb = rb.chainSrc[faceBefore(rb, jb)][0], rB = rb.chainSrc[jb][rb.chainSrc[jb].length - 1];
    for (let s = 0; s <= n; s++) {
      const t0 = s / (n + 1), t1 = (s + 1) / (n + 1), tm = (t0 + t1) / 2;
      const pts = [q[s]], src: Src[] = [mixSrc(la, rA, t0)];
      if (s === qa) { pts.push(xa!.id); src.push(mixSrc(la, rA, tm)); }
      pts.push(q[s + 1], r[s + 1]); src.push(mixSrc(la, rA, t1), mixSrc(lb, rB, t1));
      if (s === rb0) { pts.push(xb!.id); src.push(mixSrc(lb, rB, tm)); }
      pts.push(r[s]); src.push(mixSrc(lb, rB, t0));
      C.emit(pts, psrc, src, false);
    }
  }
  return { geo: C.finish(chainOf, chainSrcOf), warnings, count, scale: sc };
}

// ---------------------------------------------------------------- point bevel

/** Bevel (truncate) the selected points (mask, null = all). Points without a manifold polygon fan are skipped. */
export function bevelPoints(g: Geometry, selMask: Uint8Array | null, opts: BevelOptions): BevelResult {
  const warnings: string[] = [];
  const he = halfEdges(g);
  const fans = new Map<number, PointFan>();
  let bad = 0;
  for (let v = 0; v < g.numPoints; v++) {
    if (selMask && !selMask[v]) continue;
    if (he.pointFirst[v] < 0) continue;
    const f = pointFan(he, v);
    if (f) fans.set(v, f); else bad++;
  }
  if (bad) warnings.push(`${bad} point(s) skipped: non-manifold polygon fan`);
  if (!fans.size) {
    warnings.push('no points to bevel: geometry unchanged');
    return { geo: g, warnings, count: 0, scale: 1 };
  }
  const C = new Ctx(g, opts.divisions ?? 0, opts.shape ?? 0);
  const n = C.n;
  const dist = new Map<number, number>();
  for (const [v, fan] of fans) {
    let m = Infinity;
    for (const w of fan.ends) m = Math.min(m, len(sub(C.pt(w), C.pt(v))));
    dist.set(v, (opts.offsetMode ?? 'distance') === 'fraction' ? opts.offset * m : opts.offset);
  }
  let lambda = Infinity;
  for (const [v, fan] of fans)
    for (const w of fan.ends) {
      const coef = dist.get(v)! + (dist.get(w) ?? 0);
      if (coef > 1e-12) lambda = Math.min(lambda, len(sub(C.pt(w), C.pt(v))) / coef);
    }
  let sc = 1;
  if ((opts.clamp ?? true) && lambda < 1) {
    sc = lambda * 0.999;
    warnings.push(`offset clamped to ${(sc * 100).toFixed(1)}% so neighbouring bevels do not overlap`);
  }
  const chainOf: (number[] | undefined)[] = new Array(he.numHalfEdges);
  const chainSrcOf: (Src[] | undefined)[] = new Array(he.numHalfEdges);
  for (const [v, fan] of fans) {
    const pv = C.pt(v), d = dist.get(v)! * sc, k = fan.hs.length, m = fan.edges.length;
    const S = fan.ends.map((w) => {
      const tau = Math.min(1, d / (len(sub(C.pt(w), pv)) || 1));
      return C.add(lerp3(pv, C.pt(w), tau), { i: [v, w], w: [1 - tau, tau] });
    });
    const rec = { fan, k };
    for (let i = 0; i < k; i++) {
      const h = fan.hs[i], ids = [S[inIdx(rec, i)], S[i]];
      chainOf[h] = ids;
      chainSrcOf[h] = ids.map((id) => C.blendAt(h, C.bpos(id)));
    }
    const vsrc = he.heVertex[fan.hs[0]], psrc = he.heFace[fan.hs[0]];
    if (!fan.closed || n === 0 || k < 3) {
      if (m >= 3) C.emit(S, psrc, S.map(() => vsrc), true);
      continue;
    }
    // dome: spokes from each slide point to an apex T on the axis towards v
    const SP = S.map((id) => C.bpos(id));
    const G = scale(SP.reduce((s, p) => add(s, p), [0, 0, 0] as V3), 1 / k);
    let ax = sub(pv, G);
    if (len(ax) < 1e-12) { ax = [0, 0, 0]; for (const h of fan.hs) ax = add(ax, C.faceN(he.heFace[h])); }
    const a = unit(ax, [0, 1, 0]);
    let Hs = 0;
    for (const s of SP) {
      const L = len(sub(pv, s)), hgt = dot(sub(pv, s), a);
      const rel = sub(s, G), rho = len(sub(rel, scale(a, dot(rel, a))));
      const H = hgt > 1e-12 && L + rho > 0 ? (rho * hgt) / (L + rho) : 0;
      Hs += H + dot(rel, a);
    }
    const T = add(G, scale(a, Hs / k));
    const apex = C.add(T, v);
    const rings: number[][] = [S];
    for (let q = 1; q <= n; q++) rings.push([]);
    for (let i = 0; i < k; i++) {
      const s = SP[i], hgt = dot(sub(pv, s), a), Ht = dot(sub(T, s), a);
      const c = hgt > 1e-12 ? lerp3(s, pv, Ht / hgt) : lerp3(s, T, 0.5);
      for (let q = 1; q <= n; q++) rings[q].push(C.add(profilePoint(s, T, c, q / (n + 1), C.r), mixSrc(C.srcOf(S[i]), v, q / (n + 1))));
    }
    for (let q = 0; q < n; q++)
      for (let i = 0; i < k; i++) {
        const i1 = (i + 1) % k;
        C.emit([rings[q][i], rings[q][i1], rings[q + 1][i1], rings[q + 1][i]], psrc, [vsrc, vsrc, vsrc, vsrc], true);
      }
    for (let i = 0; i < k; i++) C.emit([rings[n][i], rings[n][(i + 1) % k], apex], psrc, [vsrc, vsrc, vsrc], true);
  }
  return { geo: C.finish(chainOf, chainSrcOf), warnings, count: fans.size, scale: sc };
}
