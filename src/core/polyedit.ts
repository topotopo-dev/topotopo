// Polygon-editing kernels behind the polyedit nodes (knife, polysplit, polybridge, polyfill, dissolve,
// edge_collapse, edge_divide). Host-agnostic; the nodes live in src/nodes/polyedit.ts.
//
//  FaceSplitter    inserts points on edges and splits polygons along chords between their corners. An
//                  inserted point belongs to the edge, so every polygon using the edge gains it and closed
//                  meshes stay watertight. Source edge groups follow the child edges of split edges.
//  quadRing        the edge ring across quads through a seed edge, rungs oriented parallel to the seed.
//  planeChords     chords splitting a (possibly concave) polygon along a plane.
//  orderChain      an edge set as one ordered open or closed chain of points.
//  enclosedFaces   the faces a loop of edges cuts off (the smaller side).
//  bridgeChains    a strip of quads between two chains (with divisions, twist, curved blend).
//  fillPatch       faces filling one boundary loop: n-gon, triangles, quad fan / paired quads, Coons grid.
//  dissolveEdges   remove edges, merging the faces on both sides into one polygon per region.
//  collapseEdges   merge the endpoints of edges (chains collapse to one point), dropping degenerate faces.
import { GeoBuilder, Geometry } from './geometry.ts';
import type { Src } from './geometry.ts';
import { EdgeSet, edgeFromKey, edgeKey, edgeList } from './edges.ts';
import { halfEdges } from './halfedge.ts';
import type { HalfEdgeMesh } from './halfedge.ts';
import { triangulate } from './topology.ts';

/** User-facing failure of a polyedit kernel (nodes turn it into a NodeError). */
export class PolyEditError extends Error {}

type V3 = number[];
const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len3 = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const unit3 = (a: V3): V3 => { const l = len3(a); return l > 1e-20 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; };
const ptOf = (P: ArrayLike<number>, i: number): V3 => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];

/** Newell normal (unnormalised) and centroid of a closed point sequence. */
export function newellOf(pos: V3[]): { n: V3; c: V3 } {
  const n: V3 = [0, 0, 0], c: V3 = [0, 0, 0];
  const m = pos.length;
  for (let k = 0; k < m; k++) {
    const a = pos[k], b = pos[(k + 1) % m];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
    c[0] += a[0]; c[1] += a[1]; c[2] += a[2];
  }
  if (m) { c[0] /= m; c[1] /= m; c[2] /= m; }
  return { n, c };
}

// ---------------------------------------------------------------- FaceSplitter

/** A polygon corner in a FaceSplitter ring. */
export interface Corner {
  /** builder (= output) point id */
  id: number;
  /** vertex provenance: the source vertex, or a blend of the two corners of the side it was inserted on */
  src: Src;
  /** the source point the corner copies, -1 for an inserted edge point */
  srcPoint: number;
}

interface Cut { t: number; id: number } // t measured from the lower to the higher point index

/**
 * Inserts points on edges and splits polygons along chords. Usage: new FaceSplitter(g); edgePoint() for every
 * new point; ring(p) to see a polygon's corners including inserted points; chord(p, idA, idB) to split p between
 * two of its corners; breakAt(p, ids) to cut a polyline at points; build().
 * Every source point is copied first (builder id = source point number). Chords of one polygon are applied in
 * order, each splitting the sub-polygon that holds both endpoints; a chord along an existing side is ignored.
 */
export class FaceSplitter {
  readonly g: Geometry;
  readonly b: GeoBuilder;
  /** source point → builder point (identity) */
  readonly pt: Int32Array;
  /** builder ids of the inserted points, in creation order */
  readonly inserted: number[] = [];
  /** chord edges build() created (output point ids) */
  readonly created: [number, number][] = [];
  /** source prim of every output prim (filled by build) */
  readonly primSource: number[] = [];
  private cuts = new Map<number, Cut[]>();
  private chords = new Map<number, [number, number][]>();
  private breaks = new Map<number, Set<number>>();

  constructor(g: Geometry) {
    this.g = g;
    this.b = new GeoBuilder(g);
    this.pt = new Int32Array(g.numPoints);
    for (let i = 0; i < g.numPoints; i++) this.pt[i] = this.b.copyPoint(i);
  }

  /** Position of a builder point. */
  pos(id: number): V3 { return ptOf(this.b.pos, id); }

  /**
   * The point at fraction t from a to b on edge a-b, created once per edge and fraction (fractions within 1e-9
   * share a point). Fractions within `snap` of 0 or 1 give the endpoint instead.
   */
  edgePoint(a: number, b: number, t: number, snap = 1e-9): number {
    if (t <= snap || a === b) return this.pt[a];
    if (t >= 1 - snap) return this.pt[b];
    if (a > b) { const x = a; a = b; b = x; t = 1 - t; }
    const k = edgeKey(a, b);
    let list = this.cuts.get(k);
    if (!list) { list = []; this.cuts.set(k, list); }
    for (const c of list) if (Math.abs(c.t - t) <= 1e-9) return c.id;
    const id = this.b.blendPoint([a, b], [1 - t, t]);
    list.push({ t, id });
    list.sort((x, y) => x.t - y.t);
    this.inserted.push(id);
    return id;
  }

  /** Points inserted on edge a-b, ordered from a to b, with their fraction from a. */
  pointsOn(a: number, b: number): { id: number; t: number }[] {
    if (a === b) return [];
    const list = this.cuts.get(edgeKey(a, b));
    if (!list) return [];
    return a < b ? list.map((c) => ({ id: c.id, t: c.t })) : list.slice().reverse().map((c) => ({ id: c.id, t: 1 - c.t }));
  }

  /** Corners of prim p in order, including the points inserted on its sides. */
  ring(p: number): Corner[] {
    const g = this.g, s = g.primStart[p], n = g.primStart[p + 1] - s, closed = !!g.primClosed[p];
    const out: Corner[] = [];
    for (let k = 0; k < n; k++) {
      const v = s + k, a = g.vertexPoint[v];
      out.push({ id: this.pt[a], src: v, srcPoint: a });
      if (!closed && k === n - 1) break;
      const v1 = s + ((k + 1) % n), c = g.vertexPoint[v1];
      for (const q of this.pointsOn(a, c)) out.push({ id: q.id, src: { i: [v, v1], w: [1 - q.t, q.t] }, srcPoint: -1 });
    }
    return out;
  }

  /** Split polygon p between two of its corners (builder ids). */
  chord(p: number, x: number, y: number) {
    if (x === y) return;
    let l = this.chords.get(p);
    if (!l) { l = []; this.chords.set(p, l); }
    l.push([x, y]);
  }

  /** Cut polyline p into separate polylines at these points (builder ids). */
  breakAt(p: number, ids: Iterable<number>) {
    let s = this.breaks.get(p);
    if (!s) { s = new Set(); this.breaks.set(p, s); }
    for (const i of ids) s.add(i);
  }

  private emit(R: Corner[], closed: boolean, p: number) {
    const id = this.b.addPrim(R.map((c) => c.id), closed, p, R.map((c) => c.src));
    this.primSource[id] = p;
  }

  private splitRing(p: number, ring: Corner[]): Corner[][] {
    const rings = [ring];
    const cs = this.chords.get(p);
    if (!cs) return rings;
    for (const [x, y] of cs) {
      for (let r = 0; r < rings.length; r++) {
        const R = rings[r], n = R.length;
        const i = R.findIndex((c) => c.id === x), j = R.findIndex((c) => c.id === y);
        if (i < 0 || j < 0) continue;
        if ((i + 1) % n === j || (j + 1) % n === i) break; // already a side
        const lo = Math.min(i, j), hi = Math.max(i, j);
        rings.splice(r, 1, R.slice(lo, hi + 1), [...R.slice(hi), ...R.slice(0, lo + 1)]);
        this.created.push([x, y]);
        break;
      }
    }
    return rings;
  }

  build(): Geometry {
    const g = this.g;
    for (let p = 0; p < g.numPrims; p++) {
      const ring = this.ring(p);
      if (g.primClosed[p]) {
        for (const R of this.splitRing(p, ring)) this.emit(R, true, p);
        continue;
      }
      const br = this.breaks.get(p);
      if (!br) { this.emit(ring, false, p); continue; }
      let run: Corner[] = [];
      for (let k = 0; k < ring.length; k++) {
        run.push(ring[k]);
        if (k > 0 && k < ring.length - 1 && br.has(ring[k].id)) {
          if (run.length >= 2) this.emit(run, false, p);
          run = [ring[k]];
        }
      }
      if (run.length >= 2) this.emit(run, false, p);
    }
    const out = this.b.build();
    // source edge groups follow the child edges of every split edge
    if (g.edgeGroups.size && this.cuts.size)
      for (const [name, set] of g.edgeGroups) {
        let dst = out.edgeGroups.get(name);
        if (!dst) { dst = new EdgeSet(); out.edgeGroups.set(name, dst); }
        for (const [k, list] of this.cuts) {
          if (!set.hasKey(k)) continue;
          const [a, c] = edgeFromKey(k);
          let prev = this.pt[a];
          for (const cut of list) { dst.add(prev, cut.id); prev = cut.id; }
          dst.add(prev, this.pt[c]);
        }
      }
    return out;
  }
}

// ---------------------------------------------------------------- plane chords

/**
 * Chords that split one polygon ring along a plane. sign[k] ∈ {-1, 0, 1} per corner (0 = on the plane),
 * pos(k) its position, axis a direction along the line where the plane meets the polygon.
 * A run of on-plane corners between corners on opposite sides is a crossing; a run between corners on the same
 * side touches the plane and counts twice (once per end). Sorted along the line, crossings alternate between
 * entering and leaving the polygon, so pairing them in order gives the interior segments (each chord ends at the
 * run end facing its partner). Returns pairs of ring indices.
 */
export function planeChords(sign: ArrayLike<number>, pos: (k: number) => V3, axis: V3): [number, number][] {
  const n = sign.length;
  let start = -1;
  for (let k = 0; k < n; k++) if (sign[k] !== 0) { start = k; break; }
  if (start < 0) return [];
  const ord = (i: number) => (start + i) % n;
  interface Ev { a: number; b: number; s: number; run: number }
  const runs: { a: number; b: number; cross: boolean }[] = [];
  for (let i = 0; i < n;) {
    let j = i + 1;
    while (j < n && sign[ord(j)] === 0) j++;
    if (j > i + 1) runs.push({ a: ord(i + 1), b: ord(j - 1), cross: sign[ord(i)] !== sign[ord(j)] });
    i = j;
  }
  let ax = axis;
  if (len3(ax) < 1e-12) {
    // polygon parallel to the plane (or degenerate): use the spread of the on-plane corners
    const zs = runs.flatMap((r) => [r.a, r.b]);
    let best = 0;
    ax = [1, 0, 0];
    for (const z of zs) { const d = sub3(pos(z), pos(zs[0])); if (len3(d) > best) { best = len3(d); ax = d; } }
  }
  const proj = (k: number) => dot3(pos(k), ax);
  const evs: Ev[] = [];
  runs.forEach((r, ri) => {
    if (r.cross) evs.push({ a: r.a, b: r.b, s: (proj(r.a) + proj(r.b)) / 2, run: ri });
    else { evs.push({ a: r.a, b: r.a, s: proj(r.a), run: ri }); evs.push({ a: r.b, b: r.b, s: proj(r.b), run: ri }); }
  });
  evs.sort((x, y) => x.s - y.s);
  const out: [number, number][] = [];
  for (let k = 0; k + 1 < evs.length; k += 2) {
    const E = evs[k], F = evs[k + 1];
    if (E.run === F.run) continue;
    const near = (ev: Ev, target: number) => (Math.abs(proj(ev.a) - target) <= Math.abs(proj(ev.b) - target) ? ev.a : ev.b);
    const x = near(E, F.s), y = near(F, E.s);
    if (x !== y) out.push([x, y]);
  }
  return out;
}

// ---------------------------------------------------------------- rings and chains

export interface QuadRing {
  /** rung edges as [p, q], all oriented parallel to the seed edge's a → b */
  rungs: [number, number][];
  /** faces crossed: face i lies between rung i and rung i+1 (wrapping when closed) */
  faces: number[];
  closed: boolean;
}

/**
 * The edge ring through edge a-b across quads, like halfedge.edgeRing but with every rung oriented parallel to
 * a → b and the crossed faces listed (what loop insertion needs). Stops at non-quads, boundaries and revisited
 * edges. Null when a-b is not a polygon edge.
 */
export function quadRing(he: HalfEdgeMesh, a: number, b: number): QuadRing | null {
  let h = he.halfEdge(a, b), flip = false;
  if (h < 0) { h = he.halfEdge(b, a); flip = true; }
  if (h < 0) return null;
  const rung = (x: number, f: boolean): [number, number] => (f ? [he.dest(x), he.heOrigin[x]] : [he.heOrigin[x], he.dest(x)]);
  const seed = he.heEdge[h];
  const seen = new Set<number>([seed]);
  const walk = (x0: number, f0: boolean) => {
    const rungs: [number, number][] = [], faces: number[] = [];
    let x = x0, closed = false;
    for (;;) {
      const face = he.heFace[x];
      if (he.faceSize(face) !== 4) break;
      const opp = he.heNext[he.heNext[x]], oe = he.heEdge[opp];
      if (oe === seed) { faces.push(face); closed = true; break; }
      if (seen.has(oe)) break;
      seen.add(oe);
      faces.push(face);
      rungs.push(rung(opp, !f0)); // opp runs against x inside the quad
      const t = he.heTwin[opp];
      if (t < 0) break;
      x = t; // the twin runs like x again, so the orientation flag stays
    }
    return { rungs, faces, closed };
  };
  const fwd = walk(h, flip);
  if (fwd.closed) return { rungs: [rung(h, flip), ...fwd.rungs], faces: fwd.faces, closed: true };
  const t0 = he.heTwin[h];
  const back = t0 >= 0 ? walk(t0, !flip) : { rungs: [] as [number, number][], faces: [] as number[], closed: false };
  return {
    rungs: [...back.rungs.reverse(), rung(h, flip), ...fwd.rungs],
    faces: [...back.faces.reverse(), ...fwd.faces],
    closed: false,
  };
}

export interface Chain { points: number[]; closed: boolean }

/** An edge set as one ordered chain of points (open: from the lower-numbered end; closed: from the lowest point). */
export function orderChain(edges: EdgeSet): Chain {
  const adj = new Map<number, number[]>();
  const link = (a: number, b: number) => { let l = adj.get(a); if (!l) { l = []; adj.set(a, l); } l.push(b); };
  for (const [a, b] of edges) { link(a, b); link(b, a); }
  if (!adj.size) throw new PolyEditError('the edge selection is empty');
  const ends: number[] = [];
  for (const [p, l] of adj) {
    if (l.length > 2) throw new PolyEditError(`the edges branch at point ${p} (${l.length} selected edges meet there); select one chain`);
    if (l.length === 1) ends.push(p);
  }
  const closed = ends.length === 0;
  let start = Infinity;
  for (const p of closed ? adj.keys() : ends) if (p < start) start = p;
  const points = [start];
  let prev = -1, cur = start;
  while (points.length <= adj.size) {
    const l = adj.get(cur)!;
    const nx = prev < 0 ? Math.min(...l) : l[0] === prev ? (l.length > 1 ? l[1] : -1) : l[0];
    if (nx < 0 || nx === start) break;
    points.push(nx);
    prev = cur; cur = nx;
  }
  if (points.length !== adj.size) throw new PolyEditError(`the edges form several separate chains (${adj.size} points, one chain covers ${points.length}); select one chain`);
  return { points, closed };
}

/** Polygon edges of a chain as an EdgeSet. */
export function chainEdges(c: Chain): EdgeSet {
  const s = new EdgeSet();
  const n = c.points.length;
  for (let k = 0; k + 1 < n; k++) s.add(c.points[k], c.points[k + 1]);
  if (c.closed && n > 2) s.add(c.points[n - 1], c.points[0]);
  return s;
}

/**
 * Faces cut off by a set of edges: polygons are grouped into components that connect without crossing the
 * edges; when the edges separate two or more components, the smallest one (fewest faces) is returned, e.g. the
 * cap a loop bounds. Empty when the edges do not separate anything (open chains, boundary loops).
 */
export function enclosedFaces(g: Geometry, edges: EdgeSet): Uint8Array {
  const he = halfEdges(g);
  const nf = g.numPrims;
  const comp = new Int32Array(nf).fill(-1);
  const sizes: number[] = [];
  for (let f = 0; f < nf; f++) {
    if (he.faceFirst[f] < 0 || comp[f] >= 0) continue;
    const id = sizes.length, stack = [f];
    let size = 0;
    comp[f] = id;
    while (stack.length) {
      const x = stack.pop()!;
      size++;
      for (const h of he.faceHalfEdges(x)) {
        if (edges.has(he.heOrigin[h], he.dest(h))) continue;
        const t = he.heTwin[h];
        if (t < 0) continue;
        const y = he.heFace[t];
        if (comp[y] < 0) { comp[y] = id; stack.push(y); }
      }
    }
    sizes.push(size);
  }
  const touching = new Set<number>();
  let separates = false;
  for (const [a, b] of edges) {
    const e = he.edgeId(a, b);
    if (e < 0) continue;
    const fs = he.edgeFaces(e);
    for (const f of fs) touching.add(comp[f]);
    if (fs.length === 2 && comp[fs[0]] !== comp[fs[1]]) separates = true;
  }
  const out = new Uint8Array(nf);
  if (!separates || touching.size < 2) return out;
  let best = -1;
  for (const c of touching) if (best < 0 || sizes[c] < sizes[best] || (sizes[c] === sizes[best] && c < best)) best = c;
  for (let f = 0; f < nf; f++) if (comp[f] === best) out[f] = 1;
  return out;
}

// ---------------------------------------------------------------- bridge

/** +1 when the polygon half-edges along the chain run in point order, -1 against, 0 unknown or mixed. */
export function chainDirection(he: HalfEdgeMesh, pts: number[], closed: boolean): number {
  let votes = 0;
  const n = pts.length, segs = closed ? n : n - 1;
  for (let k = 0; k < segs; k++) {
    const a = pts[k], b = pts[(k + 1) % n];
    const f = he.halfEdge(a, b) >= 0, r = he.halfEdge(b, a) >= 0;
    if (f && !r) votes++;
    else if (r && !f) votes--;
  }
  return Math.sign(votes);
}

/**
 * Unit direction pointing out of a chain's opening into free space: the chain's Newell normal, signed so that
 * it points away from the adjacent faces' centre and against their normals (a hole in a wall opens into the
 * solid; the open end of a tube continues along the tube). [0,0,0] when nothing is known.
 */
export function openingDirection(g: Geometry, he: HalfEdgeMesh, pts: number[], closed: boolean): V3 {
  const P = g.P;
  const pos = pts.map((p) => ptOf(P, p));
  const { n: nw, c } = newellOf(pos);
  const faces = new Set<number>();
  const n = pts.length, segs = closed ? n : n - 1;
  for (let k = 0; k < segs; k++) { const e = he.edgeId(pts[k], pts[(k + 1) % n]); if (e >= 0) for (const f of he.edgeFaces(e)) faces.add(f); }
  if (!faces.size) return [0, 0, 0];
  const avgN: V3 = [0, 0, 0], cAdj: V3 = [0, 0, 0];
  for (const f of faces) {
    const fn = he.faceNormal(f);
    const s = g.primStart[f], e = g.primStart[f + 1];
    const fc: V3 = [0, 0, 0];
    for (let v = s; v < e; v++) { const q = ptOf(P, g.vertexPoint[v]); fc[0] += q[0]; fc[1] += q[1]; fc[2] += q[2]; }
    for (let i = 0; i < 3; i++) { avgN[i] += fn[i]; cAdj[i] += fc[i] / (e - s) / faces.size; }
  }
  let scale = 0;
  for (const q of pos) scale += len3(sub3(q, c));
  scale = scale / pos.length || 1;
  const away = sub3(c, cAdj);
  if (len3(nw) < 1e-12 * scale * scale) return unit3(away);
  const d = unit3(nw);
  const score = dot3(d, away) / scale - dot3(d, unit3(avgN));
  return score >= 0 ? d : [-d[0], -d[1], -d[2]];
}

/** Normalised arc-length parameter of every chain point (a closed chain reaches 1 back at its start). */
function arcParams(pos: V3[], closed: boolean): number[] {
  const n = pos.length, u = [0];
  let acc = 0;
  for (let k = 1; k < n; k++) { acc += len3(sub3(pos[k], pos[k - 1])); u.push(acc); }
  const total = acc + (closed && n > 1 ? len3(sub3(pos[0], pos[n - 1])) : 0);
  return total > 0 ? u.map((x) => x / total) : u.map((_, k) => k / Math.max(1, closed ? n : n - 1));
}

/** Point at arc parameter u on a chain: the two chain indices around it and the blend weight of the second. */
function chainAt(params: number[], closed: boolean, u: number): { i0: number; i1: number; w: number } {
  const n = params.length, m = closed ? n + 1 : n;
  if (m < 2) return { i0: 0, i1: 0, w: 0 };
  const at = (k: number) => (k >= n ? 1 : params[k]);
  // last segment start k (0..m-2) with at(k) <= u
  let lo = 0, hi = m - 2;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (at(mid) <= u) lo = mid; else hi = mid - 1; }
  const span = at(lo + 1) - at(lo);
  const w = span > 0 ? Math.min(1, Math.max(0, (u - at(lo)) / span)) : 0;
  return { i0: lo % n, i1: (lo + 1) % n, w };
}

export interface BridgeOptions {
  divisions: number;
  /** extra vertex offset of the target around closed chains */
  twist: number;
  /** 0 = straight rungs, 1 = cubic curves leaving and entering along the openings' directions */
  blend: number;
  /** flip the winding of the bridge faces */
  reverse: boolean;
}

/**
 * Bridge two chains of g with a strip of polygons (g keeps all its prims; new prims go to prim group "bridge").
 * Orientation: where a chain is a mesh boundary, the bridge winds against the existing half-edges so the result
 * is consistent; otherwise the target's direction is chosen geometrically (smallest total rung length). Closed
 * chains are aligned by the rotation with the smallest rung lengths, then shifted by twist. Equal point counts
 * give quads; different counts are matched by normalised arc length: intermediate rows take the larger count
 * and the smaller chain is zipped to its neighbouring row with triangles where needed.
 */
export function bridgeChains(g: Geometry, A: Chain, B: Chain, o: BridgeOptions): { geo: Geometry; faces: number } {
  if (A.closed !== B.closed) throw new PolyEditError(`cannot bridge a ${A.closed ? 'closed' : 'open'} chain to a ${B.closed ? 'closed' : 'open'} one`);
  const closed = A.closed;
  const minPts = closed ? 3 : 2;
  if (A.points.length < minPts || B.points.length < minPts) throw new PolyEditError('each chain needs at least one edge');
  const shared = A.points.filter((p) => B.points.includes(p));
  if (shared.length) throw new PolyEditError(`source and target share point(s) ${shared.slice(0, 5).join(', ')}`);
  const he = halfEdges(g), P = g.P;
  const posOf = (p: number) => ptOf(P, p);
  const dirS = chainDirection(he, A.points, closed), dirT = chainDirection(he, B.points, closed);
  // candidate orientations: s along its half-edges, t against its half-edges (when known)
  const sOpts = dirS === 0 ? [A.points, A.points.slice().reverse()] : [dirS > 0 ? A.points : A.points.slice().reverse()];
  const tOpts = dirT === 0 ? [B.points, B.points.slice().reverse()] : [dirT < 0 ? B.points : B.points.slice().reverse()];
  const rotate = (a: number[], k: number) => { const n = a.length; k = ((k % n) + n) % n; return [...a.slice(k), ...a.slice(0, k)]; };
  const costOf = (s: number[], t: number[]) => {
    const sp = s.map(posOf), tp = t.map(posOf);
    if (s.length === t.length) { let c = 0; for (let k = 0; k < s.length; k++) { const d = sub3(sp[k], tp[k]); c += dot3(d, d); } return c; }
    const us = arcParams(sp, closed), ut = arcParams(tp, closed);
    let c = 0;
    for (let k = 0; k < s.length; k++) {
      const q = chainAt(ut, closed, us[k]);
      const x = tp[q.i0].map((v, i) => v + (tp[q.i1][i] - v) * q.w);
      const d = sub3(sp[k], x); c += dot3(d, d);
    }
    return c;
  };
  let best = { s: sOpts[0], t: tOpts[0], cost: Infinity };
  for (const s of sOpts)
    for (const t0 of tOpts)
      for (let r = 0; r < (closed ? t0.length : 1); r++) {
        const t = closed ? rotate(t0, r) : t0;
        const c = costOf(s, t);
        if (c < best.cost - 1e-12) best = { s, t, cost: c };
      }
  const s = best.s;
  const t = closed && o.twist ? rotate(best.t, o.twist) : best.t;

  const b = new GeoBuilder(g);
  for (let i = 0; i < g.numPoints; i++) b.copyPoint(i);
  for (let p = 0; p < g.numPrims; p++) {
    const vs: number[] = [];
    for (let v = g.primStart[p]; v < g.primStart[p + 1]; v++) vs.push(v);
    b.addPrim(vs.map((v) => g.vertexPoint[v]), !!g.primClosed[p], p, vs);
  }
  // corners of the chain points in their adjacent polygons (vertex attributes of the bridge come from them)
  const vtxOf = new Map<number, number>();
  let primSrc = -1;
  for (const chain of [s, t]) {
    const n = chain.length, segs = closed ? n : n - 1;
    for (let k = 0; k < segs; k++) {
      const a = chain[k], c = chain[(k + 1) % n];
      const h = he.halfEdge(a, c) >= 0 ? he.halfEdge(a, c) : he.halfEdge(c, a);
      if (h < 0) continue;
      if (primSrc < 0) primSrc = he.heFace[h];
      const o0 = he.heOrigin[h], o1 = he.dest(h);
      if (!vtxOf.has(o0)) vtxOf.set(o0, he.heVertex[h]);
      if (!vtxOf.has(o1)) vtxOf.set(o1, he.heVertex[he.heNext[h]]);
    }
  }
  // curve between the two openings
  const sp = s.map(posOf), tp = t.map(posOf);
  const cS = newellOf(sp).c, cT = newellOf(tp).c;
  const dist = len3(sub3(cT, cS));
  const outS = openingDirection(g, he, s, closed), outT = openingDirection(g, he, t, closed);
  const curve = (p0: V3, p1: V3, u: number): V3 => {
    const str = sub3(p1, p0);
    const T0 = len3(outS) ? str.map((v, i) => v + (outS[i] * dist - v) * o.blend) : str;
    const T1 = len3(outT) ? str.map((v, i) => v + (-outT[i] * dist - v) * o.blend) : str;
    const u2 = u * u, u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
    return [0, 1, 2].map((i) => h00 * p0[i] + h10 * T0[i] + h01 * p1[i] + h11 * T1[i]);
  };
  interface Col { pos: V3; pi: number[]; pw: number[] } // a point on a chain as a blend of chain points
  const colAt = (chain: number[], pos: V3[], params: number[], u: number): Col => {
    const q = chainAt(params, closed, u);
    return { pos: pos[q.i0].map((v, i) => v + (pos[q.i1][i] - v) * q.w), pi: [chain[q.i0], chain[q.i1]], pw: [1 - q.w, q.w] };
  };
  const vsrc = (pi: number[], pw: number[]): Src => {
    const vi: number[] = [], vw: number[] = [];
    for (let k = 0; k < pi.length; k++) { const v = vtxOf.get(pi[k]); if (v === undefined) return null; vi.push(v); vw.push(pw[k]); }
    return { i: vi, w: vw };
  };
  interface Node { id: number; src: Src }
  const D = Math.max(1, Math.floor(o.divisions));
  const rowOfChain = (chain: number[]): Node[] => chain.map((p) => ({ id: p, src: vtxOf.has(p) ? vtxOf.get(p)! : null }));
  const midRow = (a: Col[], c: Col[], u: number): Node[] => a.map((x, k) => {
    const y = c[k], q = curve(x.pos, y.pos, u);
    const pi = [...x.pi, ...y.pi], pw = [...x.pw.map((w) => w * (1 - u)), ...y.pw.map((w) => w * u)];
    return { id: b.addPoint(q[0], q[1], q[2], { i: pi, w: pw }), src: vsrc(pi, pw) };
  });
  const grp = b.group('prim', 'bridge');
  let faces = 0;
  const face = (ns: Node[]) => {
    const list = o.reverse ? ns.slice().reverse() : ns;
    grp.add(b.addPrim(list.map((x) => x.id), true, primSrc, list.map((x) => x.src)));
    faces++;
  };
  /** Faces between row a (source side) and row c (target side); quads when counts match, else a zip by parameter. */
  const strip = (a: Node[], ua: number[], c: Node[], uc: number[]) => {
    const na = a.length, nc = c.length;
    if (na === nc) {
      const segs = closed ? na : na - 1;
      for (let k = 0; k < segs; k++) face([a[(k + 1) % na], a[k], c[k], c[(k + 1) % nc]]);
      return;
    }
    const A2 = closed ? [...a, a[0]] : a, C2 = closed ? [...c, c[0]] : c;
    const pa = closed ? [...ua, 1] : ua, pc = closed ? [...uc, 1] : uc;
    let i = 0, j = 0;
    const ia = A2.length - 1, jc = C2.length - 1;
    while (i < ia || j < jc) {
      const dA = i < ia ? Math.abs(pa[i + 1] - pc[j]) : Infinity;
      const dC = j < jc ? Math.abs(pa[i] - pc[j + 1]) : Infinity;
      const dB = i < ia && j < jc ? Math.abs(pa[i + 1] - pc[j + 1]) : Infinity;
      if (dB <= dA && dB <= dC) { face([A2[i + 1], A2[i], C2[j], C2[j + 1]]); i++; j++; }
      else if (dA <= dC) { face([A2[i + 1], A2[i], C2[j]]); i++; }
      else { face([A2[i], C2[j], C2[j + 1]]); j++; }
    }
  };
  const us = arcParams(sp, closed), ut = arcParams(tp, closed);
  const rowS = rowOfChain(s), rowT = rowOfChain(t);
  if (D === 1) strip(rowS, us, rowT, ut);
  else {
    const largerS = s.length >= t.length;
    const uL = largerS ? us : ut;
    const colS: Col[] = largerS ? s.map((p, k) => ({ pos: sp[k], pi: [p], pw: [1] })) : uL.map((u) => colAt(s, sp, us, u));
    const colT: Col[] = !largerS || s.length === t.length ? t.map((p, k) => ({ pos: tp[k], pi: [p], pw: [1] })) : uL.map((u) => colAt(t, tp, ut, u));
    const rows: Node[][] = [];
    for (let r = 1; r < D; r++) rows.push(midRow(colS, colT, r / D));
    strip(rowS, us, rows[0], uL);
    for (let r = 0; r + 1 < rows.length; r++) strip(rows[r], uL, rows[r + 1], uL);
    strip(rows[rows.length - 1], uL, rowT, ut);
  }
  return { geo: b.build(), faces };
}

// ---------------------------------------------------------------- fill

export type FillMode = 'single' | 'triangles' | 'quads' | 'grid';

export interface FillPatch {
  /** interior points: position and blend weights over loop indices */
  points: { pos: V3; i: number[]; w: number[] }[];
  /** faces; a corner k >= 0 is loop index k, k < 0 is interior point -k-1 */
  faces: number[][];
  /** set when the requested mode fell back to another */
  note?: string;
}

/** Plane of a loop: centroid, unit normal (from the loop's own winding) and an in-plane basis. */
function loopPlane(pos: V3[]) {
  const { n: nw, c } = newellOf(pos);
  const n = unit3(nw);
  const ref: V3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = unit3(cross3(ref, n)), v = cross3(n, u);
  return { c, n, u, v, to2: (q: V3) => { const d = sub3(q, c); return [dot3(d, u), dot3(d, v)]; } };
}

const cross2 = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Quality of a planar quad in [0, 1] (1 = all corners 90°), -1 when it is not strictly convex. */
export function quadQuality(q: number[][]): number {
  let worst = 0;
  for (let k = 0; k < 4; k++) {
    const p = q[(k + 3) % 4], c = q[k], nx = q[(k + 1) % 4];
    if (cross2(p, c, nx) <= 1e-14) return -1;
    const a = [p[0] - c[0], p[1] - c[1]], b = [nx[0] - c[0], nx[1] - c[1]];
    const ang = Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1]) / (Math.hypot(a[0], a[1]) * Math.hypot(b[0], b[1]) || 1))));
    worst = Math.max(worst, Math.abs(ang - Math.PI / 2));
  }
  return 1 - worst / (Math.PI / 2);
}

/** Ear-clipping triangulation of a loop (indices into the loop, winding of the loop). */
function earTriangles(pos: V3[]): number[][] {
  const flat: number[] = [];
  for (const q of pos) flat.push(q[0], q[1], q[2]);
  const tmp = new Geometry({ positions: flat, prims: [pos.map((_, k) => k)] });
  const { tris } = triangulate(tmp);
  const out: number[][] = [];
  for (let k = 0; k < tris.length; k += 3) out.push([tris[k], tris[k + 1], tris[k + 2]]);
  return out;
}

/**
 * Faces filling one loop (points in hole-cap order, so the faces wind like the surrounding surface).
 *  single     one n-gon
 *  triangles  ear clipping
 *  quads      loops that are star-shaped around their centroid: a quad fan around a centre point (fan triangles
 *             paired with the offset of best quality; odd loops keep one triangle); other loops: ear-clipped
 *             triangles paired greedily into convex quads by quality (quad-dominant). Interior points then get
 *             `smooth` Laplacian steps, projected back onto the loop plane.
 *  grid       even loops: Coons patch of an a×b grid whose four corners are the sharpest turns of the loop
 *             (sides a, b, a, b); interior points get `smooth` Laplacian steps. Odd loops fall back to quads.
 */
export function fillPatch(pos: V3[], mode: FillMode, smooth: number): FillPatch {
  const n = pos.length;
  if (n < 3) return { points: [], faces: [] };
  if (mode === 'single' || n === 3) return { points: [], faces: [pos.map((_, k) => k)] };
  if (mode === 'triangles') return { points: [], faces: earTriangles(pos) };
  if (mode === 'grid') {
    if (n % 2 === 0) return gridPatch(pos, smooth);
    const q = quadPatch(pos, smooth);
    q.note = `grid fill needs an even number of points (loop has ${n}); used quads`;
    return q;
  }
  return quadPatch(pos, smooth);
}

function quadPatch(pos: V3[], smooth: number): FillPatch {
  const n = pos.length;
  const pl = loopPlane(pos);
  const p2 = pos.map(pl.to2);
  const center = [0, 0];
  for (const q of p2) { center[0] += q[0] / n; center[1] += q[1] / n; }
  let star = true;
  for (let k = 0; k < n && star; k++) if (cross2(center, p2[k], p2[(k + 1) % n]) <= 1e-12) star = false;
  if (n === 4) {
    const q = quadQuality(p2);
    if (q >= 0) return { points: [], faces: [[0, 1, 2, 3]] };
  }
  if (star) {
    // fan around the centre: quads [c, k, k+1, k+2]; odd n keeps one triangle [c, t, t+1]
    const quadQ = (k: number) => quadQuality([center, p2[k % n], p2[(k + 1) % n], p2[(k + 2) % n]]);
    let bestFaces: number[][] = [], bestScore = -Infinity;
    const starts = n % 2 === 0 ? [0, 1] : Array.from({ length: n }, (_, t) => t);
    for (const t of starts) {
      const faces: number[][] = [];
      let score = 0;
      const first = n % 2 === 0 ? t : t + 1;
      for (let j = 0; j < Math.floor(n / 2); j++) {
        const k = first + 2 * j;
        faces.push([-1, k % n, (k + 1) % n, (k + 2) % n]);
        const q = quadQ(k);
        score += q < 0 ? -10 : q;
      }
      if (n % 2) faces.push([-1, t % n, (t + 1) % n]);
      if (score > bestScore + 1e-12) { bestScore = score; bestFaces = faces; }
    }
    const c3 = pos.reduce((acc, q) => acc.map((v, i) => v + q[i] / n), [0, 0, 0]);
    const pts = [{ pos: c3, i: pos.map((_, k) => k), w: pos.map(() => 1 / n) }];
    relax(pos, pts, bestFaces, smooth, pl);
    return { points: pts, faces: bestFaces };
  }
  // ear clipping, then greedy pairing of neighbouring triangles into convex quads
  const tris = earTriangles(pos);
  const edgeTris = new Map<number, number[]>();
  tris.forEach((t, ti) => { for (let k = 0; k < 3; k++) { const key = edgeKey(t[k], t[(k + 1) % 3]); const l = edgeTris.get(key); if (l) l.push(ti); else edgeTris.set(key, [ti]); } });
  const cands: { q: number; a: number; c: number; quad: number[] }[] = [];
  for (const [, l] of edgeTris) {
    if (l.length !== 2) continue;
    const [ta, tc] = l, T = tris[ta], U = tris[tc];
    for (let k = 0; k < 3; k++) {
      const x = T[k], y = T[(k + 1) % 3];
      if (!(U.includes(x) && U.includes(y))) continue;
      const d = U.find((z) => z !== x && z !== y)!;
      const quad = [y, T[(k + 2) % 3], x, d];
      const q = quadQuality(quad.map((i) => p2[i]));
      if (q >= 0) cands.push({ q, a: ta, c: tc, quad });
    }
  }
  cands.sort((x, y) => y.q - x.q || x.a - y.a);
  const used = new Uint8Array(tris.length);
  const faces: number[][] = [];
  for (const c of cands) if (!used[c.a] && !used[c.c]) { used[c.a] = used[c.c] = 1; faces.push(c.quad); }
  tris.forEach((t, ti) => { if (!used[ti]) faces.push(t); });
  return { points: [], faces };
}

/** Laplacian smoothing of interior points (corner indices < 0) over the faces' edges; optional plane projection. */
function relax(pos: V3[], pts: { pos: V3 }[], faces: number[][], iters: number, plane: { c: V3; n: V3 } | null) {
  if (!pts.length || iters <= 0) return;
  const nb: Set<number>[] = pts.map(() => new Set());
  for (const f of faces)
    for (let k = 0; k < f.length; k++) {
      const a = f[k], c = f[(k + 1) % f.length];
      if (a < 0) nb[-a - 1].add(c);
      if (c < 0) nb[-c - 1].add(a);
    }
  const at = (k: number) => (k >= 0 ? pos[k] : pts[-k - 1].pos);
  for (let it = 0; it < iters; it++) {
    const next = pts.map((p, i) => {
      if (!nb[i].size) return p.pos;
      const s: V3 = [0, 0, 0];
      for (const k of nb[i]) { const q = at(k); s[0] += q[0]; s[1] += q[1]; s[2] += q[2]; }
      const m: V3 = [s[0] / nb[i].size, s[1] / nb[i].size, s[2] / nb[i].size];
      if (!plane) return m;
      const d = dot3(sub3(m, plane.c), plane.n);
      return [m[0] - plane.n[0] * d, m[1] - plane.n[1] * d, m[2] - plane.n[2] * d];
    });
    next.forEach((q, i) => { pts[i].pos = q; });
  }
}

function gridPatch(pos: V3[], smooth: number): FillPatch {
  const n = pos.length, half = n / 2;
  const pl = loopPlane(pos);
  const p2 = pos.map(pl.to2);
  // turning angle at each loop point (in the loop plane; convex turns positive)
  const turn = p2.map((c, k) => {
    const p = p2[(k + n - 1) % n], nx = p2[(k + 1) % n];
    const a = [c[0] - p[0], c[1] - p[1]], b = [nx[0] - c[0], nx[1] - c[1]];
    return Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]);
  });
  let best = { o: 0, a: Math.max(1, Math.floor(half / 2)), score: -Infinity };
  for (let a = 1; a < half; a++) {
    const bb = half - a;
    for (let o = 0; o < n; o++) {
      const corners = [o, o + a, o + a + bb, o + 2 * a + bb].map((k) => k % n);
      let score = 0;
      for (const k of corners) score += turn[k];
      score -= 0.5 * (Math.abs(a - bb) / half);
      if (score > best.score + 1e-9) best = { o, a, score };
    }
  }
  const { o, a } = best, bb = half - a;
  const L = (k: number) => (((o + k) % n) + n) % n;
  const bottom = (i: number) => L(i), right = (j: number) => L(a + j), top = (i: number) => L(2 * a + bb - i), left = (j: number) => L(n - j);
  const c0 = bottom(0), c1 = bottom(a), c2 = right(bb), c3 = top(0);
  const ids: number[][] = Array.from({ length: a + 1 }, () => new Array(bb + 1).fill(0));
  const pts: { pos: V3; i: number[]; w: number[] }[] = [];
  for (let i = 0; i <= a; i++)
    for (let j = 0; j <= bb; j++) {
      if (j === 0) { ids[i][j] = bottom(i); continue; }
      if (j === bb) { ids[i][j] = top(i); continue; }
      if (i === 0) { ids[i][j] = left(j); continue; }
      if (i === a) { ids[i][j] = right(j); continue; }
      const u = i / a, v = j / bb;
      const w = new Map<number, number>();
      const add = (k: number, x: number) => w.set(k, (w.get(k) ?? 0) + x);
      add(bottom(i), 1 - v); add(top(i), v); add(left(j), 1 - u); add(right(j), u);
      add(c0, -(1 - u) * (1 - v)); add(c1, -u * (1 - v)); add(c2, -u * v); add(c3, -(1 - u) * v);
      const wi = [...w.keys()], ww = wi.map((k) => w.get(k)!);
      const q: V3 = [0, 0, 0];
      wi.forEach((k, m) => { for (let c = 0; c < 3; c++) q[c] += pos[k][c] * ww[m]; });
      pts.push({ pos: q, i: wi, w: ww });
      ids[i][j] = -pts.length;
    }
  const faces: number[][] = [];
  for (let i = 0; i < a; i++) for (let j = 0; j < bb; j++) faces.push([ids[i][j], ids[i + 1][j], ids[i + 1][j + 1], ids[i][j + 1]]);
  relax(pos, pts, faces, smooth, null);
  return { points: pts, faces };
}

// ---------------------------------------------------------------- dissolve

export interface DissolveOptions {
  /** remove points of dissolved edges that are left with exactly two edges */
  removeInline: boolean;
  /** drop polygons with fewer than three distinct points or no area */
  removeDegenerate: boolean;
  /** points to remove when they are left with two edges or fewer (dissolve-points mode) */
  removePoints?: Uint8Array | null;
}

export interface DissolveResult { geo: Geometry; merged: number; boundarySkipped: number; regionsSkipped: number; inlineRemoved: number }

/**
 * Remove the edges of a set, merging the polygons on both sides. Faces connected through dissolved edges form a
 * region whose outline becomes one polygon (walked on the half-edge structure, rotating around points inside the
 * region); edges whose two faces end up in the same region vanish too. Boundary and non-manifold edges cannot be
 * dissolved and are skipped, as are regions whose outline is not a single loop (a ring of faces, a whole closed
 * surface). Points are copied 1:1, so groups and attributes carry over; merged polygons take the prim attributes
 * of their lowest-numbered face and go to prim group "dissolved".
 */
export function dissolveEdges(g: Geometry, edges: EdgeSet, o: DissolveOptions): DissolveResult {
  const he = halfEdges(g);
  const nprim = g.numPrims, np = g.numPoints;
  const parent = Int32Array.from({ length: nprim }, (_, i) => i);
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  let boundarySkipped = 0;
  for (const key of edges.keyIterator()) {
    const [a, b] = edgeFromKey(key);
    const e = he.edgeId(a, b);
    if (e < 0) continue;
    const h = he.edgeHalf[e], t = he.heTwin[h];
    if (t < 0 || he.edgeValence(e) !== 2) { boundarySkipped++; continue; }
    const r1 = find(he.heFace[h]), r2 = find(he.heFace[t]);
    if (r1 !== r2) parent[Math.max(r1, r2)] = Math.min(r1, r2); // the root stays the region's lowest face
  }
  const regions = new Map<number, number[]>();
  for (let f = 0; f < nprim; f++) {
    if (he.faceFirst[f] < 0) continue;
    const r = find(f);
    let l = regions.get(r);
    if (!l) { l = []; regions.set(r, l); }
    l.push(f);
  }
  const outline = new Map<number, number[]>(); // region root → boundary half-edges in order
  const inlineCand = new Uint8Array(np);
  let regionsSkipped = 0, merged = 0;
  for (const [root, faces] of regions) {
    if (faces.length < 2) continue;
    const isB = (h: number) => { const t = he.heTwin[h]; return t < 0 || find(he.heFace[t]) !== root; };
    const loops: number[][] = [];
    const used = new Set<number>();
    let broken = false;
    for (const f of faces)
      for (const h of he.faceHalfEdges(f)) {
        if (!isB(h) || used.has(h)) continue;
        const loop: number[] = [];
        let x = h;
        for (;;) {
          used.add(x);
          loop.push(x);
          let y = he.heNext[x], spin = 0;
          while (!isB(y) && spin++ <= he.numHalfEdges) y = he.heNext[he.heTwin[y]];
          if (!isB(y)) { broken = true; break; }
          if (y === h) break;
          if (used.has(y)) { broken = true; break; }
          x = y;
        }
        loops.push(loop);
      }
    if (broken || loops.length !== 1 || loops[0].length < 3) { regionsSkipped++; continue; }
    outline.set(root, loops[0]);
    merged += faces.length - 1;
    for (const f of faces) for (const h of he.faceHalfEdges(f)) if (!isB(h)) { inlineCand[he.heOrigin[h]] = 1; inlineCand[he.dest(h)] = 1; }
  }
  interface Poly { pts: number[]; vs: number[]; closed: boolean; src: number; merged: boolean }
  const polys: Poly[] = [];
  for (let p = 0; p < nprim; p++) {
    if (he.faceFirst[p] >= 0) {
      const r = find(p), loop = outline.get(r);
      if (loop) {
        if (r === p) polys.push({ pts: loop.map((h) => he.heOrigin[h]), vs: loop.map((h) => he.heVertex[h]), closed: true, src: p, merged: true });
        continue;
      }
    }
    const vs: number[] = [];
    for (let v = g.primStart[p]; v < g.primStart[p + 1]; v++) vs.push(v);
    polys.push({ pts: vs.map((v) => g.vertexPoint[v]), vs, closed: !!g.primClosed[p], src: p, merged: false });
  }
  // inline / dissolved points left with two edges
  const forced = o.removePoints ?? null;
  const remove = new Uint8Array(np);
  let inlineRemoved = 0;
  if (o.removeInline || forced) {
    const isCand = (i: number) => (o.removeInline && inlineCand[i]) || (forced && forced[i]);
    const nb = new Map<number, Set<number>>();
    const link = (a: number, b: number) => { if (!isCand(a)) return; let s = nb.get(a); if (!s) { s = new Set(); nb.set(a, s); } s.add(b); };
    for (const Q of polys) {
      const n = Q.pts.length, last = Q.closed ? n : n - 1;
      for (let k = 0; k < last; k++) { const a = Q.pts[k], b = Q.pts[(k + 1) % n]; if (a !== b) { link(a, b); link(b, a); } }
    }
    for (const [i, s] of nb) if ((o.removeInline && inlineCand[i] && s.size === 2) || (forced && forced[i] && s.size <= 2)) remove[i] = 1;
    // never shrink a polygon below a triangle (keep the point everywhere then, so neighbours still match)
    for (let changed = true; changed;) {
      changed = false;
      for (const Q of polys) {
        if (!Q.closed) continue;
        let keep = 0;
        for (const q of Q.pts) if (!remove[q]) keep++;
        if (keep < 3 && keep < Q.pts.length) { for (const q of Q.pts) if (remove[q]) { remove[q] = 0; changed = true; } }
      }
    }
    for (let i = 0; i < np; i++) if (remove[i]) inlineRemoved++;
  }
  const b = new GeoBuilder(g);
  for (let i = 0; i < np; i++) b.copyPoint(i);
  const grp = b.group('prim', 'dissolved');
  const P = g.P;
  for (const Q of polys) {
    let pts = Q.pts, vs = Q.vs;
    if (Q.closed && inlineRemoved) {
      const k = pts.map((q) => !remove[q]);
      pts = pts.filter((_, i) => k[i]); vs = vs.filter((_, i) => k[i]);
    }
    if (o.removeDegenerate && Q.closed) {
      if (new Set(pts).size < 3) continue;
      const { n } = newellOf(pts.map((q) => ptOf(P, q)));
      if (len3(n) < 1e-14) continue;
    }
    const id = b.addPrim(pts, Q.closed, Q.src, vs);
    if (Q.merged) grp.add(id);
  }
  const out = b.build();
  return { geo: nprim ? out.removeUnusedPoints() : out, merged, boundarySkipped, regionsSkipped, inlineRemoved };
}

// ---------------------------------------------------------------- collapse

export type CollapseMode = 'center' | 'first' | 'last';

/**
 * Collapse edges: points joined by collapsed edges (chains included) merge into one point at their centroid
 * (center: the midpoint for a single edge), or at the lowest / highest point number of the cluster (first / last).
 * Polygons lose repeated consecutive corners; polygons left with fewer than three corners (polylines: two) are
 * removed. New points go to point group "collapsed"; edge groups are remapped through the merge.
 */
export function collapseEdges(g: Geometry, edges: EdgeSet, mode: CollapseMode): { geo: Geometry; clusters: number; removedPrims: number } {
  const np = g.numPoints;
  const parent = Int32Array.from({ length: np }, (_, i) => i);
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (const [a, c] of edges) {
    if (a >= np || c >= np) continue;
    const r1 = find(a), r2 = find(c);
    if (r1 !== r2) parent[Math.max(r1, r2)] = Math.min(r1, r2);
  }
  const members = new Map<number, number[]>();
  for (let i = 0; i < np; i++) { const r = find(i); const l = members.get(r); if (l) l.push(i); else members.set(r, [i]); }
  const b = new GeoBuilder(g);
  const grp = b.group('point', 'collapsed');
  const map = new Int32Array(np).fill(-1);
  let clusters = 0;
  for (let i = 0; i < np; i++) {
    if (map[i] >= 0) continue;
    const m = members.get(find(i))!;
    if (m.length < 2) { map[i] = b.copyPoint(i); continue; }
    const id = mode === 'first' ? b.copyPoint(m[0]) : mode === 'last' ? b.copyPoint(m[m.length - 1]) : b.blendPoint(m, m.map(() => 1 / m.length));
    for (const q of m) map[q] = id;
    grp.add(id);
    clusters++;
  }
  let removedPrims = 0;
  for (let p = 0; p < g.numPrims; p++) {
    const closed = !!g.primClosed[p];
    const pts: number[] = [], vs: number[] = [];
    for (let v = g.primStart[p]; v < g.primStart[p + 1]; v++) {
      const id = map[g.vertexPoint[v]];
      if (pts.length && pts[pts.length - 1] === id) continue;
      pts.push(id); vs.push(v);
    }
    if (closed) while (pts.length > 1 && pts[0] === pts[pts.length - 1]) { pts.pop(); vs.pop(); }
    if (pts.length < (closed ? 3 : 2)) { removedPrims++; continue; }
    b.addPrim(pts, closed, p, vs);
  }
  const out = b.build();
  if (g.edgeGroups.size) {
    const L = edgeList(out);
    for (const [name, set] of g.edgeGroups) {
      let dst = out.edgeGroups.get(name);
      if (!dst) { dst = new EdgeSet(); out.edgeGroups.set(name, dst); }
      for (const [a, c] of set) {
        if (a >= np || c >= np) continue;
        const x = map[a], y = map[c];
        if (x !== y && L.index.has(edgeKey(x, y))) dst.add(x, y);
      }
    }
  }
  return { geo: g.numPrims ? out.removeUnusedPoints() : out, clusters, removedPrims };
}
