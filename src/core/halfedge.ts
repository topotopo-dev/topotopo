// Half-edge mesh derived on demand from a Geometry and cached per Geometry object.
//
//  - Built from closed polygons with >= 3 corners only. Polylines are ignored, and so are
//    polygons with a repeated consecutive point (degenerate; run clean/fuse first).
//  - One half-edge per polygon corner, allocated in vertex order: half-edge h starts at the
//    corner heVertex[h] of face heFace[h], goes from heOrigin[h] to heOrigin[heNext[h]].
//  - Undirected edges get ids in order of first occurrence (walking faces and their corners in
//    order), so for polygon-only meshes edge ids equal the edge-group index ranges ("0-10").
//  - Twins pair two half-edges of opposite direction on the same edge. Non-manifold edges (more
//    than two incident polygons) and edges whose two polygons have inconsistent winding (both
//    half-edges in the same direction) never throw: only the first opposite-direction pair (if
//    any) becomes twins, the rest keep heTwin = -1 (they behave like boundaries for walks), and
//    the edge is listed in nonManifoldEdges (winding problems also in flippedEdges).
//    isManifold is true when no edge is listed. Non-manifold *vertices* (bowties) are allowed;
//    queries around them fall back to unordered results.
//  - The structure holds topology only; geometric queries (dihedralAngle, edgeLength) read the
//    current P. The cache is keyed by the Geometry object and invalidated when its topology
//    arrays (vertexPoint, primStart, primClosed) are replaced or the point count changes. Code
//    that edits those arrays in place after querying must call invalidateHalfEdges(g).
import type { Geometry } from './geometry.ts';
import { edgeKey } from './edges.ts';

export interface EdgeWalk {
  /**
   * edgeLoop: points along the loop in order (a closed loop does not repeat its first point).
   * edgeRing: the endpoints of each rung as consecutive pairs [a0, b0, a1, b1, ...].
   */
  points: number[];
  /** undirected edge ids along the walk, in order */
  edges: number[];
  closed: boolean;
}

export class HalfEdgeMesh {
  readonly geo: Geometry;
  readonly numHalfEdges: number;
  /** point at the start of each half-edge */
  readonly heOrigin: Int32Array;
  /** polygon (prim index) of each half-edge */
  readonly heFace: Int32Array;
  readonly heNext: Int32Array;
  readonly hePrev: Int32Array;
  /** opposite half-edge, -1 on boundaries (and on unpaired non-manifold / flipped sides) */
  readonly heTwin: Int32Array;
  /** geometry vertex (polygon corner) the half-edge starts at */
  readonly heVertex: Int32Array;
  /** undirected edge id of each half-edge */
  readonly heEdge: Int32Array;
  /** first half-edge per prim (-1 for polylines and skipped polygons) */
  readonly faceFirst: Int32Array;
  /** one outgoing half-edge per point (a boundary one when the point is on a boundary), -1 if none */
  readonly pointFirst: Int32Array;
  /** half-edge of each geometry vertex (-1 if its prim is not part of the structure) */
  readonly vertexHalf: Int32Array;
  readonly numEdges: number;
  /** representative half-edge per edge (the first one encountered) */
  readonly edgeHalf: Int32Array;
  /** edge endpoints, edgeA < edgeB */
  readonly edgeA: Int32Array;
  readonly edgeB: Int32Array;
  /** CSR: all half-edges of edge e are edgeHalves[edgeHalfStart[e] .. edgeHalfStart[e+1]-1] */
  readonly edgeHalfStart: Int32Array;
  readonly edgeHalves: Int32Array;
  /** CSR: outgoing half-edges of point p (unordered) */
  readonly pointHalfStart: Int32Array;
  readonly pointHalves: Int32Array;
  readonly nonManifoldEdges = new Set<number>();
  readonly flippedEdges = new Set<number>();
  private index = new Map<number, number>();
  // topology identity used to validate the cache
  readonly srcVertexPoint: Int32Array;
  readonly srcPrimStart: Int32Array;
  readonly srcPrimClosed: Uint8Array;
  readonly srcNumPoints: number;

  constructor(g: Geometry) {
    this.geo = g;
    this.srcVertexPoint = g.vertexPoint; this.srcPrimStart = g.primStart; this.srcPrimClosed = g.primClosed; this.srcNumPoints = g.numPoints;
    const vp = g.vertexPoint, np = g.numPoints, nprim = g.numPrims;
    this.faceFirst = new Int32Array(nprim).fill(-1);
    this.vertexHalf = new Int32Array(g.numVertices).fill(-1);
    let nh = 0;
    for (let p = 0; p < nprim; p++) {
      if (!g.primClosed[p]) continue;
      const s = g.primStart[p], e = g.primStart[p + 1];
      if (e - s < 3) continue;
      let ok = true;
      for (let v = s; v < e; v++) if (vp[v] === vp[v + 1 < e ? v + 1 : s]) { ok = false; break; }
      if (!ok) continue;
      for (let v = s; v < e; v++) this.vertexHalf[v] = nh++;
    }
    this.numHalfEdges = nh;
    const O = (this.heOrigin = new Int32Array(nh)), F = (this.heFace = new Int32Array(nh));
    const N = (this.heNext = new Int32Array(nh)), PV = (this.hePrev = new Int32Array(nh));
    const T = (this.heTwin = new Int32Array(nh).fill(-1)), V = (this.heVertex = new Int32Array(nh));
    for (let p = 0; p < nprim; p++) {
      const s = g.primStart[p], first = this.vertexHalf[s];
      if (first < 0) continue;
      const n = g.primStart[p + 1] - s;
      this.faceFirst[p] = first;
      for (let k = 0; k < n; k++) {
        const h = first + k;
        O[h] = vp[s + k]; F[h] = p; V[h] = s + k;
        N[h] = first + (k + 1) % n; PV[h] = first + (k - 1 + n) % n;
      }
    }
    // undirected edges in order of first occurrence
    const E = (this.heEdge = new Int32Array(nh));
    const A: number[] = [], B: number[] = [], firstH: number[] = [];
    const cnt: number[] = [];
    for (let h = 0; h < nh; h++) {
      const a = O[h], b = O[N[h]];
      const k = edgeKey(a, b);
      let e = this.index.get(k);
      if (e === undefined) { e = A.length; this.index.set(k, e); A.push(Math.min(a, b)); B.push(Math.max(a, b)); firstH.push(h); cnt.push(0); }
      E[h] = e; cnt[e]++;
    }
    const ne = (this.numEdges = A.length);
    this.edgeA = Int32Array.from(A); this.edgeB = Int32Array.from(B); this.edgeHalf = Int32Array.from(firstH);
    const es = (this.edgeHalfStart = new Int32Array(ne + 1));
    for (let e = 0; e < ne; e++) es[e + 1] = es[e] + cnt[e];
    const eh = (this.edgeHalves = new Int32Array(nh)), fill = es.slice(0, ne);
    for (let h = 0; h < nh; h++) eh[fill[E[h]]++] = h;
    // twins: the first opposite-direction pair of each edge
    for (let e = 0; e < ne; e++) {
      const s = es[e], n = es[e + 1] - s;
      if (n > 2) this.nonManifoldEdges.add(e);
      let paired = false;
      for (let i = 0; i < n && !paired; i++)
        for (let j = i + 1; j < n; j++) {
          const hi = eh[s + i], hj = eh[s + j];
          if (O[hi] !== O[hj]) { T[hi] = hj; T[hj] = hi; paired = true; break; }
        }
      if (n >= 2 && !paired) { this.nonManifoldEdges.add(e); this.flippedEdges.add(e); }
      else if (n > 2) {
        // flag winding problems among the extra sides too
        let fwd = 0;
        for (let i = 0; i < n; i++) if (O[eh[s + i]] === O[eh[s]]) fwd++;
        if (fwd !== n - fwd) this.flippedEdges.add(e);
      }
    }
    // outgoing half-edges per point; pointFirst prefers a boundary half-edge
    const pf = (this.pointFirst = new Int32Array(np).fill(-1));
    const ps = (this.pointHalfStart = new Int32Array(np + 1));
    for (let h = 0; h < nh; h++) {
      const p = O[h];
      ps[p + 1]++;
      if (pf[p] < 0 || (T[pf[p]] >= 0 && T[h] < 0)) pf[p] = h;
    }
    for (let p = 0; p < np; p++) ps[p + 1] += ps[p];
    const ph = (this.pointHalves = new Int32Array(nh)), pfill = ps.slice(0, np);
    for (let h = 0; h < nh; h++) ph[pfill[O[h]]++] = h;
  }

  get isManifold(): boolean { return this.nonManifoldEdges.size === 0; }

  /** Point a half-edge points to. */
  dest(h: number): number { return this.heOrigin[this.heNext[h]]; }

  /** Undirected edge id of {a, b}, or -1. */
  edgeId(a: number, b: number): number {
    if (a === b || a < 0 || b < 0) return -1;
    return this.index.get(edgeKey(a, b)) ?? -1;
  }

  /** A half-edge running a → b, or -1. */
  halfEdge(a: number, b: number): number {
    const e = this.edgeId(a, b);
    if (e < 0) return -1;
    for (let k = this.edgeHalfStart[e]; k < this.edgeHalfStart[e + 1]; k++) if (this.heOrigin[this.edgeHalves[k]] === a) return this.edgeHalves[k];
    return -1;
  }

  edgePoints(e: number): [number, number] { return [this.edgeA[e], this.edgeB[e]]; }

  /** Number of polygons using edge e (1 = boundary, 2 = shared, > 2 = non-manifold). */
  edgeValence(e: number): number { return this.edgeHalfStart[e + 1] - this.edgeHalfStart[e]; }

  isBoundaryEdge(e: number): boolean { return this.edgeValence(e) === 1; }

  /** Polygons using edge e. */
  edgeFaces(e: number): number[] {
    const out: number[] = [];
    for (let k = this.edgeHalfStart[e]; k < this.edgeHalfStart[e + 1]; k++) out.push(this.heFace[this.edgeHalves[k]]);
    return out;
  }

  /** Half-edges of a face in winding order ([] for polylines / skipped prims). */
  faceHalfEdges(f: number): number[] {
    const first = this.faceFirst[f];
    if (first < 0) return [];
    const out = [first];
    for (let h = this.heNext[first]; h !== first; h = this.heNext[h]) out.push(h);
    return out;
  }

  faceSize(f: number): number {
    const s = this.geo.primStart;
    return this.faceFirst[f] < 0 ? 0 : s[f + 1] - s[f];
  }

  /**
   * Outgoing half-edges of point p. For a manifold fan they come in rotation order (starting at
   * the boundary half-edge if p is on a boundary); around non-manifold points the order is
   * by half-edge index.
   */
  outgoing(p: number): number[] {
    const s = this.pointHalfStart[p], e = this.pointHalfStart[p + 1], n = e - s;
    if (n === 0) return [];
    const out: number[] = [];
    const start = this.pointFirst[p];
    let h = start;
    do {
      out.push(h);
      const t = this.heTwin[this.hePrev[h]];
      if (t < 0) break;
      h = t;
    } while (h !== start && out.length <= n);
    if (out.length === n && new Set(out).size === n) return out;
    return Array.from(this.pointHalves.subarray(s, e));
  }

  /** Points connected to p by a polygon edge (fan order when p is manifold). Polyline segments are not included. */
  pointOneRing(p: number): number[] {
    const out: number[] = [], seen = new Set<number>();
    const push = (q: number) => { if (!seen.has(q)) { seen.add(q); out.push(q); } };
    for (const h of this.outgoing(p)) { push(this.dest(h)); push(this.heOrigin[this.hePrev[h]]); }
    return out;
  }

  /** Polygons around p (each once, fan order when p is manifold). */
  pointPrims(p: number): number[] {
    const out: number[] = [], seen = new Set<number>();
    for (const h of this.outgoing(p)) { const f = this.heFace[h]; if (!seen.has(f)) { seen.add(f); out.push(f); } }
    return out;
  }

  /** Polygons sharing an edge with f (all of them across non-manifold edges). */
  faceNeighbors(f: number): number[] {
    const out: number[] = [], seen = new Set<number>([f]);
    for (const h of this.faceHalfEdges(f)) {
      const e = this.heEdge[h];
      for (let k = this.edgeHalfStart[e]; k < this.edgeHalfStart[e + 1]; k++) {
        const q = this.heFace[this.edgeHalves[k]];
        if (!seen.has(q)) { seen.add(q); out.push(q); }
      }
    }
    return out;
  }

  /** Unit Newell normal of a polygon from the current positions. */
  faceNormal(f: number, out: number[] = [0, 0, 0]): number[] {
    const g = this.geo, P = g.P, vp = g.vertexPoint, s = g.primStart[f], e = g.primStart[f + 1];
    let nx = 0, ny = 0, nz = 0;
    for (let v = s; v < e; v++) {
      const a = vp[v] * 3, b = vp[v + 1 < e ? v + 1 : s] * 3;
      nx += (P[a + 1] - P[b + 1]) * (P[a + 2] + P[b + 2]);
      ny += (P[a + 2] - P[b + 2]) * (P[a] + P[b]);
      nz += (P[a] - P[b]) * (P[a + 1] + P[b + 1]);
    }
    const l = Math.hypot(nx, ny, nz) || 1;
    out[0] = nx / l; out[1] = ny / l; out[2] = nz / l;
    return out;
  }

  /**
   * Angle in degrees between the normals of the two polygons on edge e (0 = flat, 90 = box edge).
   * Uses the twin pair when there is one, else the first two polygons (a flipped neighbour's normal is
   * negated first). NaN for boundary edges.
   */
  dihedralAngle(e: number): number {
    const s = this.edgeHalfStart[e], n = this.edgeHalfStart[e + 1] - s;
    if (n < 2) return NaN;
    let h1 = this.edgeHalf[e], h2 = this.heTwin[h1];
    if (h2 < 0) { h1 = this.edgeHalves[s]; h2 = this.edgeHalves[s + 1]; }
    const n1 = this.faceNormal(this.heFace[h1]), n2 = this.faceNormal(this.heFace[h2]);
    let d = n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2];
    if (this.heOrigin[h1] === this.heOrigin[h2]) d = -d;
    return (Math.acos(Math.max(-1, Math.min(1, d))) * 180) / Math.PI;
  }

  edgeLength(e: number): number {
    const P = this.geo.P, a = this.edgeA[e] * 3, b = this.edgeB[e] * 3;
    return Math.hypot(P[a] - P[b], P[a + 1] - P[b + 1], P[a + 2] - P[b + 2]);
  }

  /** True when p is an interior point with exactly 4 edges and only quads around it. */
  private regularQuadPoint(p: number): boolean {
    const out = this.outgoing(p);
    if (out.length !== 4) return false;
    for (const h of out) if (this.heTwin[h] < 0 || this.faceSize(this.heFace[h]) !== 4) return false;
    return this.heTwin[this.hePrev[out[3]]] === out[0];
  }

  /** True when p is a boundary point with 3 edges (2 boundary, 1 interior) and only quads. */
  private regularBoundaryPoint(p: number): boolean {
    const out = this.outgoing(p);
    if (out.length !== 2) return false;
    for (const h of out) if (this.faceSize(this.heFace[h]) !== 4) return false;
    return this.heTwin[out[0]] < 0 && this.heTwin[this.hePrev[out[1]]] < 0;
  }

  /** Edge-loop continuation of half-edge h across its end point, or -1. */
  private loopStep(h: number): number {
    if (this.heTwin[h] < 0) {
      // boundary loop: continue along the boundary through regular boundary points
      const b = this.dest(h);
      if (!this.regularBoundaryPoint(b)) return -1;
      return this.nextBoundary(h);
    }
    const b = this.dest(h);
    if (!this.regularQuadPoint(b)) return -1;
    const t = this.heTwin[this.heNext[h]];
    return t < 0 ? -1 : this.heNext[t];
  }

  /** Boundary half-edge leaving dest(h) in the same boundary fan, or -1. */
  private nextBoundary(h: number): number {
    let g = this.heNext[h], guard = 0;
    while (this.heTwin[g] >= 0 && guard++ < this.numHalfEdges) g = this.heNext[this.heTwin[g]];
    return this.heTwin[g] < 0 ? g : -1;
  }

  /** Repeatedly apply step from h0, collecting half-edges until it stops, revisits an edge, or closes on startEdge. */
  private walk(h0: number, step: (h: number) => number, startEdge: number, seen: Set<number>): { hs: number[]; closed: boolean } {
    const hs: number[] = [];
    let cur = h0;
    for (;;) {
      const nx = step(cur);
      if (nx < 0) return { hs, closed: false };
      const e = this.heEdge[nx];
      if (e === startEdge) return { hs, closed: true };
      if (seen.has(e)) return { hs, closed: false };
      seen.add(e);
      hs.push(nx);
      cur = nx;
    }
  }

  /**
   * Houdini-style edge loop through edge {a, b}: continues straight across points with four quads
   * around them (the edge opposite the incoming one), stops at poles (valence != 4), non-quads and
   * boundaries. A loop that starts on a boundary edge follows the boundary through points with
   * three edges. Returns null when {a, b} is not a polygon edge.
   */
  edgeLoop(a: number, b: number): EdgeWalk | null {
    const e = this.edgeId(a, b);
    if (e < 0) return null;
    let h = this.halfEdge(a, b);
    if (h < 0) { h = this.halfEdge(b, a); [a, b] = [b, a]; }
    const seen = new Set<number>([e]);
    const fwd = this.walk(h, (x) => this.loopStep(x), e, seen);
    const points = [a, b], edges = [e];
    for (const x of fwd.hs) { edges.push(this.heEdge[x]); points.push(this.dest(x)); }
    if (fwd.closed) { points.pop(); return { points, edges, closed: true }; }
    // backwards from a
    let back: number[] = [];
    if (this.heTwin[h] >= 0) back = this.walk(this.heTwin[h], (x) => this.loopStep(x), e, seen).hs;
    else back = this.walk(h, (x) => this.prevBoundaryStep(x), e, seen).hs;
    const bp: number[] = [], be: number[] = [];
    for (const x of back) { be.push(this.heEdge[x]); bp.push(this.heTwin[h] >= 0 ? this.dest(x) : this.heOrigin[x]); }
    return { points: [...bp.reverse(), ...points], edges: [...be.reverse(), ...edges], closed: false };
  }

  /** Boundary loop step backwards: the boundary half-edge ending at origin(h), through regular boundary points. */
  private prevBoundaryStep(h: number): number {
    const a = this.heOrigin[h];
    if (!this.regularBoundaryPoint(a)) return -1;
    let p = this.hePrev[h], guard = 0;
    while (this.heTwin[p] >= 0 && guard++ < this.numHalfEdges) p = this.hePrev[this.heTwin[p]];
    return this.heTwin[p] < 0 ? p : -1;
  }

  /**
   * Edge ring through edge {a, b}: the opposite edges of successive quads (parallel rungs),
   * stopping at non-quads and boundaries. Returns null when {a, b} is not a polygon edge.
   */
  edgeRing(a: number, b: number): EdgeWalk | null {
    const e = this.edgeId(a, b);
    if (e < 0) return null;
    const seen = new Set<number>([e]);
    const step = (h: number) => {
      // h is a half-edge in face f; the ring continues across the opposite side of f
      if (this.faceSize(this.heFace[h]) !== 4) return -1;
      return this.heNext[this.heNext[h]];
    };
    const ringFrom = (h: number) => {
      const out: number[] = [];
      let cur = h, closed = false;
      for (;;) {
        const opp = step(cur);
        if (opp < 0) break;
        const oe = this.heEdge[opp];
        if (oe === e) { closed = true; break; }
        if (seen.has(oe)) break;
        seen.add(oe);
        out.push(opp);
        const t = this.heTwin[opp];
        if (t < 0) break;
        cur = t;
      }
      return { out, closed };
    };
    const h = this.edgeHalf[e];
    const fwd = ringFrom(h);
    const mid = (x: number) => [this.heOrigin[x], this.dest(x)];
    const edges = [e, ...fwd.out.map((x) => this.heEdge[x])];
    const points = [mid(h), ...fwd.out.map(mid)].flat();
    if (fwd.closed) return { points, edges, closed: true };
    const t = this.heTwin[h];
    if (t >= 0) {
      const back = ringFrom(t).out;
      return { points: [...back.reverse().map(mid).flat(), ...points], edges: [...back.map((x) => this.heEdge[x]), ...edges], closed: false };
    }
    return { points, edges, closed: false };
  }

  /**
   * Walk the boundary that contains boundary half-edge `start` (use pointFirst[p] to start at a
   * point). Returns the boundary half-edges in walking order (each ends where the next starts);
   * [] when `start` is not a boundary half-edge.
   */
  walkBoundary(start: number): { halfEdges: number[]; closed: boolean } {
    if (start < 0 || start >= this.numHalfEdges || this.heTwin[start] >= 0) return { halfEdges: [], closed: false };
    const out = [start], seen = new Set<number>([start]);
    let cur = start;
    for (;;) {
      const nx = this.nextBoundary(cur);
      if (nx < 0) return { halfEdges: out, closed: false };
      if (nx === start) return { halfEdges: out, closed: true };
      if (seen.has(nx)) return { halfEdges: out, closed: false };
      seen.add(nx);
      out.push(nx);
      cur = nx;
    }
  }

  /**
   * Closed boundary loops as point lists, oriented against the boundary half-edges (the hole's
   * orientation, like topology.boundaryLoops: a polygon built from a loop caps the hole facing the
   * same way as the surrounding faces).
   */
  boundaryLoops(): number[][] {
    const done = new Uint8Array(this.numHalfEdges);
    const loops: number[][] = [];
    for (let h = 0; h < this.numHalfEdges; h++) {
      if (this.heTwin[h] >= 0 || done[h]) continue;
      const w = this.walkBoundary(h);
      for (const x of w.halfEdges) done[x] = 1;
      if (w.closed && w.halfEdges.length >= 3) loops.push(w.halfEdges.map((x) => this.heOrigin[x]).reverse());
    }
    return loops;
  }
}

const cache = new WeakMap<Geometry, HalfEdgeMesh>();

/** The half-edge structure of g (built once per geometry object, see the header comment). */
export function halfEdges(g: Geometry): HalfEdgeMesh {
  const c = cache.get(g);
  if (c && c.srcVertexPoint === g.vertexPoint && c.srcPrimStart === g.primStart && c.srcPrimClosed === g.primClosed && c.srcNumPoints === g.numPoints) return c;
  const m = new HalfEdgeMesh(g);
  cache.set(g, m);
  return m;
}

/** Drop the cached half-edge structure of g (after editing its topology arrays in place). */
export function invalidateHalfEdges(g: Geometry) {
  cache.delete(g);
}
