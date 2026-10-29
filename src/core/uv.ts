// UV toolkit core (no I/O): polygon side pairing, seams, charts and UV vertices (corner classes),
// LSCM parameterisation (Lévy et al. 2002) with a conjugate-gradient solver, cut graphs that open
// closed or handled charts into disks, and island packing (min-area rotation, texel-density scaling,
// skyline packing into one tile or UDIMs).
//
// UVs are a vertex attribute `uv` of size 3 (u, v, 0), Houdini convention. Internally per-vertex
// (u, v) pairs are Float64Array(numVertices * 2).
import type { Geometry } from './geometry.ts';
import { primArea, triangulate } from './topology.ts';

// ---------------------------------------------------------------- uv io

/** Per-vertex (u, v) from a vertex or point `uv` attribute, or null when there is none. */
export function readUV(g: Geometry): Float64Array | null {
  const f = g.findAttrib('uv', ['vertex', 'point']);
  if (!f || f.attr.type === 'string') return null;
  const a = f.attr, d = a.data as Float64Array | Int32Array, s = a.size;
  const out = new Float64Array(g.numVertices * 2);
  for (let v = 0; v < g.numVertices; v++) {
    const i = (f.cls === 'vertex' ? v : g.vertexPoint[v]) * s;
    out[v * 2] = d[i];
    out[v * 2 + 1] = s > 1 ? d[i + 1] : 0;
  }
  return out;
}

/** Store per-vertex (u, v) as the vertex attribute uv (u, v, 0); a point uv is removed. */
export function writeUV(g: Geometry, uv: Float64Array): void {
  g.points.delete('uv');
  g.vertices.delete('uv');
  const a = g.vertices.add('uv', 'float', 3).data as Float64Array;
  for (let v = 0; v < g.numVertices; v++) {
    a[v * 3] = uv[v * 2];
    a[v * 3 + 1] = uv[v * 2 + 1];
  }
}

// ---------------------------------------------------------------- union-find

export class UnionFind {
  parent: Int32Array;
  constructor(n: number) {
    this.parent = new Int32Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }
  find(x: number): number {
    const p = this.parent;
    while (p[x] !== x) { p[x] = p[p[x]]; x = p[x]; }
    return x;
  }
  union(a: number, b: number): void {
    a = this.find(a); b = this.find(b);
    if (a !== b) { if (a < b) this.parent[b] = a; else this.parent[a] = b; }
  }
}

// ---------------------------------------------------------------- polygon sides

/**
 * Edges of closed polygons, paired across neighbouring polygons. Pair i joins prim pA[i] (corners a1 at
 * point a, b1 at point b) with prim pB[i] (corners a2 at a, b2 at b). Sides without exactly one partner
 * (open borders, non-manifold edges, a polygon using an edge twice) are boundary sides: start corner bv,
 * end corner bw, prim bp.
 */
export interface Sides {
  count: number;
  pA: Int32Array; pB: Int32Array;
  a1: Int32Array; b1: Int32Array; a2: Int32Array; b2: Int32Array;
  bv: Int32Array; bw: Int32Array; bp: Int32Array;
}

export function polygonSides(g: Geometry, primMask?: ArrayLike<number> | null): Sides {
  const vp = g.vertexPoint, n = Math.max(1, g.numPoints);
  const map = new Map<number, number>();
  const sp: number[] = [], sv: number[] = [], sw: number[] = [], partner: number[] = [];
  for (let p = 0; p < g.numPrims; p++) {
    if (!g.primClosed[p] || (primMask && !primMask[p])) continue;
    const s = g.primStart[p], e = g.primStart[p + 1];
    if (e - s < 3) continue;
    for (let v = s; v < e; v++) {
      const w = v + 1 < e ? v + 1 : s;
      const a = vp[v], b = vp[w];
      if (a === b) continue;
      const k = a < b ? a * n + b : b * n + a;
      const id = sp.length;
      sp.push(p); sv.push(v); sw.push(w); partner.push(-1);
      const f = map.get(k);
      if (f === undefined) map.set(k, id);
      else if (partner[f] === -1 && sp[f] !== p) { partner[f] = id; partner[id] = f; }
      else {
        if (partner[f] >= 0) partner[partner[f]] = -2;
        partner[f] = -2; partner[id] = -2;
      }
    }
  }
  const pA: number[] = [], pB: number[] = [], a1: number[] = [], b1: number[] = [], a2: number[] = [], b2: number[] = [];
  const bv: number[] = [], bw: number[] = [], bp: number[] = [];
  for (let id = 0; id < sp.length; id++) {
    const q = partner[id];
    if (q < 0) { bv.push(sv[id]); bw.push(sw[id]); bp.push(sp[id]); continue; }
    if (q < id) continue;
    const a = vp[sv[id]];
    pA.push(sp[id]); pB.push(sp[q]);
    a1.push(sv[id]); b1.push(sw[id]);
    if (vp[sv[q]] === a) { a2.push(sv[q]); b2.push(sw[q]); } else { a2.push(sw[q]); b2.push(sv[q]); }
  }
  return {
    count: pA.length,
    pA: Int32Array.from(pA), pB: Int32Array.from(pB),
    a1: Int32Array.from(a1), b1: Int32Array.from(b1), a2: Int32Array.from(a2), b2: Int32Array.from(b2),
    bv: Int32Array.from(bv), bw: Int32Array.from(bw), bp: Int32Array.from(bp),
  };
}

/** Pairs whose two sides disagree on uv at either end (a UV seam). */
export function uvSeamPairs(S: Sides, uv: Float64Array, tol = 1e-6): Uint8Array {
  const m = new Uint8Array(S.count);
  const diff = (x: number, y: number) => Math.abs(uv[x * 2] - uv[y * 2]) > tol || Math.abs(uv[x * 2 + 1] - uv[y * 2 + 1]) > tol;
  for (let i = 0; i < S.count; i++) if (diff(S.a1[i], S.a2[i]) || diff(S.b1[i], S.b2[i])) m[i] = 1;
  return m;
}

/** Mark pairs whose points match a predicate on the (unordered) point pair. */
export function pairsWhere(g: Geometry, S: Sides, test: (a: number, b: number) => boolean, into?: Uint8Array): Uint8Array {
  const m = into ?? new Uint8Array(S.count);
  for (let i = 0; i < S.count; i++) if (test(g.vertexPoint[S.a1[i]], g.vertexPoint[S.b1[i]])) m[i] = 1;
  return m;
}

/** A test for edges listed as point pairs ([[a, b], ...] or a flat [a, b, a, b, ...]). */
export function pointPairTest(list: any): ((a: number, b: number) => boolean) | null {
  if (!Array.isArray(list) || !list.length) return null;
  const set = new Set<string>();
  const add = (a: any, b: any) => { a = Number(a); b = Number(b); if (Number.isFinite(a) && Number.isFinite(b)) set.add(a < b ? `${a},${b}` : `${b},${a}`); };
  if (Array.isArray(list[0])) for (const e of list) add(e[0], e[1]);
  else for (let i = 0; i + 1 < list.length; i += 2) add(list[i], list[i + 1]);
  if (!set.size) return null;
  return (a, b) => set.has(a < b ? `${a},${b}` : `${b},${a}`);
}

/** A test for an edge group (geometry with edge groups: Map<string, {has(a, b)}>), or null. */
export function edgeGroupTest(g: Geometry, name: string): ((a: number, b: number) => boolean) | null {
  const eg = (g as any).edgeGroups;
  const set = eg instanceof Map ? eg.get(name) : undefined;
  if (!set || typeof set.has !== 'function' || set.size === 0) return null;
  return (a, b) => !!set.has(a, b);
}

/** Connected components of polygons across uncut pairs. Prims outside the mask (or open) get -1. */
export function primComponents(g: Geometry, S: Sides, cut: Uint8Array | null, primMask?: ArrayLike<number> | null) {
  const uf = new UnionFind(g.numPrims);
  for (let i = 0; i < S.count; i++) if (!cut || !cut[i]) uf.union(S.pA[i], S.pB[i]);
  const id = new Map<number, number>();
  const comp = new Int32Array(g.numPrims).fill(-1);
  for (let p = 0; p < g.numPrims; p++) {
    if (!g.primClosed[p] || g.primSize(p) < 3 || (primMask && !primMask[p])) continue;
    const r = uf.find(p);
    let c = id.get(r);
    if (c === undefined) { c = id.size; id.set(r, c); }
    comp[p] = c;
  }
  return { comp, count: id.size };
}

/**
 * UV vertices: polygon corners joined across uncut pairs (the corners around a point that are not
 * separated by a seam). Returns the class representative per vertex.
 */
export function cornerClasses(g: Geometry, S: Sides, cut: Uint8Array | null): UnionFind {
  const uf = new UnionFind(g.numVertices);
  for (let i = 0; i < S.count; i++) {
    if (cut && cut[i]) continue;
    uf.union(S.a1[i], S.a2[i]);
    uf.union(S.b1[i], S.b2[i]);
  }
  return uf;
}

// ---------------------------------------------------------------- charts

export interface Chart {
  /** prims of the chart */
  prims: number[];
  /** local UV vertex per geometry vertex of the chart's prims (Map vertex → local index) */
  local: Map<number, number>;
  /** point of each local UV vertex */
  point: Int32Array;
  /** triangles in local indices, and their source prim */
  tris: Int32Array;
  triPrim: Int32Array;
  /** local vertices on the chart border */
  border: Uint8Array;
  /** number of boundary loops, Euler characteristic */
  loops: number;
  euler: number;
}

/**
 * Build charts (components over uncut pairs) with their UV vertices and triangles.
 * `cut` marks pairs that are seams; pairs between different components are implicitly seams.
 */
export function buildCharts(g: Geometry, S: Sides, cut: Uint8Array, primMask?: ArrayLike<number> | null): { charts: Chart[]; chartOfPrim: Int32Array } {
  const { comp, count } = primComponents(g, S, cut, primMask);
  const uf = cornerClasses(g, S, cut);
  const charts: Chart[] = [];
  for (let c = 0; c < count; c++) charts.push({ prims: [], local: new Map(), point: new Int32Array(0), tris: new Int32Array(0), triPrim: new Int32Array(0), border: new Uint8Array(0), loops: 0, euler: 0 });
  for (let p = 0; p < g.numPrims; p++) if (comp[p] >= 0) charts[comp[p]].prims.push(p);
  const { tris, triPrim } = triangulate(g, comp.map((c) => (c >= 0 ? 1 : 0)));
  const triLists: number[][] = charts.map(() => []), triPrims: number[][] = charts.map(() => []);
  for (let t = 0; t < triPrim.length; t++) {
    const c = comp[triPrim[t]];
    triLists[c].push(tris[t * 3], tris[t * 3 + 1], tris[t * 3 + 2]);
    triPrims[c].push(triPrim[t]);
  }
  // pairs inside each chart (uncut), for the Euler characteristic
  const interior = new Int32Array(count);
  for (let i = 0; i < S.count; i++) if (!cut[i] && comp[S.pA[i]] >= 0) interior[comp[S.pA[i]]]++;
  const cutSides: number[][] = charts.map(() => []);
  for (let i = 0; i < S.count; i++) {
    if (!cut[i]) continue;
    if (comp[S.pA[i]] >= 0) cutSides[comp[S.pA[i]]].push(S.a1[i], S.b1[i]);
    if (comp[S.pB[i]] >= 0) cutSides[comp[S.pB[i]]].push(S.b2[i], S.a2[i]);
  }
  for (let i = 0; i < S.bv.length; i++) if (comp[S.bp[i]] >= 0) cutSides[comp[S.bp[i]]].push(S.bv[i], S.bw[i]);
  charts.forEach((ch, c) => {
    const rootToLocal = new Map<number, number>();
    const pts: number[] = [];
    for (const p of ch.prims)
      for (let v = g.primStart[p]; v < g.primStart[p + 1]; v++) {
        const r = uf.find(v);
        let l = rootToLocal.get(r);
        if (l === undefined) { l = pts.length; rootToLocal.set(r, l); pts.push(g.vertexPoint[v]); }
        ch.local.set(v, l);
      }
    ch.point = Int32Array.from(pts);
    ch.tris = Int32Array.from(triLists[c], (v) => ch.local.get(v)!);
    ch.triPrim = Int32Array.from(triPrims[c]);
    ch.border = new Uint8Array(pts.length);
    const bs = cutSides[c];
    const loopUF = new UnionFind(pts.length);
    for (let k = 0; k < bs.length; k += 2) {
      const x = ch.local.get(bs[k])!, y = ch.local.get(bs[k + 1])!;
      ch.border[x] = 1; ch.border[y] = 1;
      loopUF.union(x, y);
    }
    const roots = new Set<number>();
    for (let i = 0; i < pts.length; i++) if (ch.border[i]) roots.add(loopUF.find(i));
    ch.loops = roots.size;
    ch.euler = pts.length - (interior[c] + bs.length / 2) + ch.prims.length;
  });
  return { charts, chartOfPrim: comp };
}

/** True when a chart is not a topological disk-with-holes LSCM can flatten: closed, or with handles. */
export function chartNeedsCut(ch: Chart): boolean {
  if (ch.loops === 0) return true;
  const genus2 = 2 - ch.euler - ch.loops; // = 2 * genus
  return genus2 > 0;
}

/**
 * Extra seams that open a closed or handled chart into a disk: the cut graph (pairs not crossed by a
 * dual spanning tree, with dangling branches pruned; border points anchor branches), plus a slit along
 * the shortest edge path between two far-apart points when a closed genus-0 chart prunes to nothing.
 * Returns the pair indices to cut.
 */
export function cutGraph(g: Geometry, S: Sides, cut: Uint8Array, chartOfPrim: Int32Array, chart: number, ch: Chart): number[] {
  const P = g.P, vp = g.vertexPoint;
  const inChart = (i: number) => !cut[i] && chartOfPrim[S.pA[i]] === chart;
  // dual spanning tree over prims (BFS)
  const pairsOfPrim = new Map<number, number[]>();
  for (let i = 0; i < S.count; i++) {
    if (!inChart(i)) continue;
    for (const p of [S.pA[i], S.pB[i]]) {
      let l = pairsOfPrim.get(p);
      if (!l) { l = []; pairsOfPrim.set(p, l); }
      l.push(i);
    }
  }
  const visited = new Set<number>([ch.prims[0]]);
  const inTree = new Set<number>();
  const queue = [ch.prims[0]];
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    for (const i of pairsOfPrim.get(p) ?? []) {
      const q = S.pA[i] === p ? S.pB[i] : S.pA[i];
      if (visited.has(q)) continue;
      visited.add(q); inTree.add(i); queue.push(q);
    }
  }
  // candidate cut edges on points; border points are anchors
  const borderPt = new Set<number>();
  for (let l = 0; l < ch.point.length; l++) if (ch.border[l]) borderPt.add(ch.point[l]);
  const cand: number[] = [];
  for (const [, list] of pairsOfPrim) for (const i of list) if (!inTree.has(i) && S.pA[i] !== undefined) cand.push(i);
  const candSet = [...new Set(cand)];
  const deg = new Map<number, number>();
  const edgesAt = new Map<number, number[]>();
  for (const i of candSet) {
    for (const pt of [vp[S.a1[i]], vp[S.b1[i]]]) {
      deg.set(pt, (deg.get(pt) ?? 0) + 1);
      let l = edgesAt.get(pt);
      if (!l) { l = []; edgesAt.set(pt, l); }
      l.push(i);
    }
  }
  const alive = new Set(candSet);
  const leaves: number[] = [];
  for (const [pt, d] of deg) if (d === 1 && !borderPt.has(pt)) leaves.push(pt);
  while (leaves.length) {
    const pt = leaves.pop()!;
    if (deg.get(pt) !== 1 || borderPt.has(pt)) continue;
    const e = edgesAt.get(pt)!.find((i) => alive.has(i));
    if (e === undefined) continue;
    alive.delete(e);
    for (const q of [vp[S.a1[e]], vp[S.b1[e]]]) {
      deg.set(q, deg.get(q)! - 1);
      if (deg.get(q) === 1 && !borderPt.has(q)) leaves.push(q);
    }
  }
  const out = [...alive];
  if (out.length || ch.loops > 0) return out;
  // closed genus-0 chart: slit along the shortest path between two far-apart points
  const adj = new Map<number, [number, number, number][]>(); // pt -> [nb, pair, len]
  for (let i = 0; i < S.count; i++) {
    if (!inChart(i)) continue;
    const a = vp[S.a1[i]], b = vp[S.b1[i]];
    const len = Math.hypot(P[a * 3] - P[b * 3], P[a * 3 + 1] - P[b * 3 + 1], P[a * 3 + 2] - P[b * 3 + 2]);
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a)!.push([b, i, len]); adj.get(b)!.push([a, i, len]);
  }
  const pts = [...adj.keys()];
  if (pts.length < 2) return out;
  const far = (from: number) => {
    let best = from, bd = -1;
    for (const q of pts) {
      const d = (P[q * 3] - P[from * 3]) ** 2 + (P[q * 3 + 1] - P[from * 3 + 1]) ** 2 + (P[q * 3 + 2] - P[from * 3 + 2]) ** 2;
      if (d > bd) { bd = d; best = q; }
    }
    return best;
  };
  const s0 = far(pts[0]), s1 = far(s0);
  const dist = new Map<number, number>([[s0, 0]]);
  const prev = new Map<number, [number, number]>();
  const heap = new MinHeap();
  heap.push(0, s0);
  while (heap.size) {
    const [d, u] = heap.pop();
    if (d > (dist.get(u) ?? Infinity)) continue;
    if (u === s1) break;
    for (const [w, i, len] of adj.get(u)!) {
      const nd = d + len;
      if (nd < (dist.get(w) ?? Infinity)) { dist.set(w, nd); prev.set(w, [u, i]); heap.push(nd, w); }
    }
  }
  for (let u = s1; prev.has(u); u = prev.get(u)![0]) out.push(prev.get(u)![1]);
  return out;
}

class MinHeap {
  k: number[] = [];
  v: number[] = [];
  get size() { return this.k.length; }
  push(key: number, val: number) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop(): [number, number] {
    const k = this.k, v = this.v;
    const top: [number, number] = [k[0], v[0]];
    const lk = k.pop()!, lv = v.pop()!;
    if (k.length) {
      let i = 0;
      const n = k.length;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i, mk = lk;
        if (l < n && k[l] < mk) { m = l; mk = k[l]; }
        if (r < n && k[r] < mk) { m = r; mk = k[r]; }
        if (m === i) break;
        k[i] = k[m]; v[i] = v[m]; i = m;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

// ---------------------------------------------------------------- LSCM

export interface LscmResult { uv: Float64Array; iterations: number; residual: number }

/**
 * Least squares conformal map of a triangle mesh (positions xyz per vertex, triangles as local
 * indices). Two vertices are pinned (pins, or the two farthest-apart `candidates`, or vertices).
 * Solves the normal equations of the LSCM system with Jacobi-preconditioned conjugate gradients,
 * starting from a projection on the best-fit plane. Returns (u, v) per vertex.
 */
export function lscm(pos: Float64Array, tris: Int32Array, pins?: [number, number] | null, candidates?: ArrayLike<number> | null, opts: { maxIter?: number; tol?: number } = {}): LscmResult {
  const n = pos.length / 3, nt = tris.length / 3;
  const uv = new Float64Array(n * 2);
  if (n === 0) return { uv, iterations: 0, residual: 0 };
  // --- vertex adjacency (block CSR, 2x2 blocks)
  const nbr: number[][] = Array.from({ length: n }, (_, i) => [i]);
  for (let t = 0; t < nt; t++)
    for (let j = 0; j < 3; j++)
      for (let k = 0; k < 3; k++) {
        if (j === k) continue;
        const a = tris[t * 3 + j], b = tris[t * 3 + k];
        if (!nbr[a].includes(b)) nbr[a].push(b);
      }
  const rowStart = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) { nbr[i].sort((x, y) => x - y); rowStart[i + 1] = rowStart[i] + nbr[i].length; }
  const col = new Int32Array(rowStart[n]);
  for (let i = 0; i < n; i++) col.set(nbr[i], rowStart[i]);
  const blk = new Float64Array(rowStart[n] * 4); // uu, uv, vu, vv
  const blockIndex = (i: number, j: number) => {
    let lo = rowStart[i], hi = rowStart[i + 1] - 1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (col[m] < j) lo = m + 1; else if (col[m] > j) hi = m - 1; else return m; }
    return -1;
  };
  // --- assemble AᵀA
  const Mr = [0, 0, 0], Mi = [0, 0, 0];
  let totalArea = 0;
  for (let t = 0; t < nt; t++) {
    const i0 = tris[t * 3], i1 = tris[t * 3 + 1], i2 = tris[t * 3 + 2];
    const e1x = pos[i1 * 3] - pos[i0 * 3], e1y = pos[i1 * 3 + 1] - pos[i0 * 3 + 1], e1z = pos[i1 * 3 + 2] - pos[i0 * 3 + 2];
    const e2x = pos[i2 * 3] - pos[i0 * 3], e2y = pos[i2 * 3 + 1] - pos[i0 * 3 + 1], e2z = pos[i2 * 3 + 2] - pos[i0 * 3 + 2];
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const dbl = Math.hypot(nx, ny, nz); // twice the area
    const l1 = Math.hypot(e1x, e1y, e1z);
    if (dbl < 1e-14 || l1 < 1e-12) continue;
    totalArea += dbl / 2;
    // local frame: x along e1, y = n × x
    const xx = e1x / l1, xy = e1y / l1, xz = e1z / l1;
    const yx = (ny * xz - nz * xy) / dbl, yy = (nz * xx - nx * xz) / dbl, yz = (nx * xy - ny * xx) / dbl;
    const X = [0, l1, e2x * xx + e2y * xy + e2z * xz], Y = [0, 0, e2x * yx + e2y * yy + e2z * yz];
    const sc = 1 / Math.sqrt(dbl);
    for (let j = 0; j < 3; j++) {
      const j1 = (j + 1) % 3, j2 = (j + 2) % 3;
      Mr[j] = (X[j2] - X[j1]) * sc;
      Mi[j] = (Y[j2] - Y[j1]) * sc;
    }
    const ids = [i0, i1, i2];
    // row Re: u_j * Mr_j - v_j * Mi_j ; row Im: u_j * Mi_j + v_j * Mr_j
    for (let j = 0; j < 3; j++)
      for (let k = 0; k < 3; k++) {
        const b = blockIndex(ids[j], ids[k]) * 4;
        blk[b] += Mr[j] * Mr[k] + Mi[j] * Mi[k]; // u_j u_k
        blk[b + 1] += -Mr[j] * Mi[k] + Mi[j] * Mr[k]; // u_j v_k
        blk[b + 2] += -Mi[j] * Mr[k] + Mr[j] * Mi[k]; // v_j u_k
        blk[b + 3] += Mi[j] * Mi[k] + Mr[j] * Mr[k]; // v_j v_k
      }
  }
  // --- pins
  let pin: [number, number];
  if (pins && pins[0] !== pins[1] && pins[0] >= 0 && pins[1] >= 0 && pins[0] < n && pins[1] < n) pin = pins;
  else pin = farthestPair(pos, candidates && candidates.length >= 2 ? candidates : null, n);
  // --- initial guess: best-fit plane projection, similarity-aligned to the pin targets
  let ax = 0, ay = 0, az = 0;
  for (let t = 0; t < nt; t++) {
    const i0 = tris[t * 3] * 3, i1 = tris[t * 3 + 1] * 3, i2 = tris[t * 3 + 2] * 3;
    const e1x = pos[i1] - pos[i0], e1y = pos[i1 + 1] - pos[i0 + 1], e1z = pos[i1 + 2] - pos[i0 + 2];
    const e2x = pos[i2] - pos[i0], e2y = pos[i2 + 1] - pos[i0 + 1], e2z = pos[i2 + 2] - pos[i0 + 2];
    ax += e1y * e2z - e1z * e2y; ay += e1z * e2x - e1x * e2z; az += e1x * e2y - e1y * e2x;
  }
  let al = Math.hypot(ax, ay, az);
  if (al < 1e-20) { ax = 0; ay = 1; az = 0; al = 1; }
  ax /= al; ay /= al; az /= al;
  let ux = Math.abs(ax) < 0.9 ? 1 : 0, uy = Math.abs(ax) < 0.9 ? 0 : 1, uz = 0;
  const d0 = ux * ax + uy * ay + uz * az;
  ux -= d0 * ax; uy -= d0 * ay; uz -= d0 * az;
  const ul = Math.hypot(ux, uy, uz); ux /= ul; uy /= ul; uz /= ul;
  const wx = ay * uz - az * uy, wy = az * ux - ax * uz, wz = ax * uy - ay * ux;
  for (let i = 0; i < n; i++) {
    uv[i * 2] = pos[i * 3] * ux + pos[i * 3 + 1] * uy + pos[i * 3 + 2] * uz;
    uv[i * 2 + 1] = pos[i * 3] * wx + pos[i * 3 + 1] * wy + pos[i * 3 + 2] * wz;
  }
  const [p0, p1] = pin;
  const L = Math.hypot(pos[p1 * 3] - pos[p0 * 3], pos[p1 * 3 + 1] - pos[p0 * 3 + 1], pos[p1 * 3 + 2] - pos[p0 * 3 + 2]) || 1;
  {
    // similarity mapping projected pin0 → (0,0), pin1 → (L,0)
    const sx = uv[p0 * 2], sy = uv[p0 * 2 + 1];
    const dx = uv[p1 * 2] - sx, dy = uv[p1 * 2 + 1] - sy;
    const dl2 = dx * dx + dy * dy || 1;
    // complex multiply by (L / (dx + i dy)) = L (dx - i dy) / |d|^2
    const cr = (L * dx) / dl2, ci = (-L * dy) / dl2;
    for (let i = 0; i < n; i++) {
      const x = uv[i * 2] - sx, y = uv[i * 2 + 1] - sy;
      uv[i * 2] = x * cr - y * ci;
      uv[i * 2 + 1] = x * ci + y * cr;
    }
    uv[p0 * 2] = 0; uv[p0 * 2 + 1] = 0; uv[p1 * 2] = L; uv[p1 * 2 + 1] = 0;
  }
  if (nt === 0) return { uv, iterations: 0, residual: 0 };
  // --- CG on the free unknowns (x layout: u_i at 2i, v_i at 2i+1)
  const N2 = n * 2;
  const fixed = new Uint8Array(N2);
  fixed[p0 * 2] = fixed[p0 * 2 + 1] = fixed[p1 * 2] = fixed[p1 * 2 + 1] = 1;
  const diag = new Float64Array(N2);
  for (let i = 0; i < n; i++) {
    const b = blockIndex(i, i) * 4;
    diag[i * 2] = blk[b] > 1e-30 ? blk[b] : 1;
    diag[i * 2 + 1] = blk[b + 3] > 1e-30 ? blk[b + 3] : 1;
  }
  const matvec = (x: Float64Array, y: Float64Array) => {
    for (let i = 0; i < n; i++) {
      let su = 0, sv = 0;
      for (let k = rowStart[i]; k < rowStart[i + 1]; k++) {
        const j = col[k], b = k * 4, xu = x[j * 2], xv = x[j * 2 + 1];
        su += blk[b] * xu + blk[b + 1] * xv;
        sv += blk[b + 2] * xu + blk[b + 3] * xv;
      }
      y[i * 2] = su; y[i * 2 + 1] = sv;
    }
  };
  const x = uv;
  const r = new Float64Array(N2), z = new Float64Array(N2), p = new Float64Array(N2), Ap = new Float64Array(N2);
  matvec(x, r);
  for (let i = 0; i < N2; i++) r[i] = fixed[i] ? 0 : -r[i];
  let rz = 0, r0 = 0;
  for (let i = 0; i < N2; i++) { z[i] = r[i] / diag[i]; p[i] = z[i]; rz += r[i] * z[i]; r0 += r[i] * r[i]; }
  const scale = Math.max(1e-30, totalArea);
  const tol = opts.tol ?? 1e-9;
  const maxIter = opts.maxIter ?? Math.max(500, Math.min(30000, 50 * Math.ceil(Math.sqrt(n)) + 500));
  let it = 0, rr = r0;
  while (it < maxIter && Math.sqrt(rr) > tol * Math.sqrt(scale)) {
    matvec(p, Ap);
    let pAp = 0;
    for (let i = 0; i < N2; i++) { if (fixed[i]) Ap[i] = 0; pAp += p[i] * Ap[i]; }
    if (!(pAp > 0)) break;
    const alpha = rz / pAp;
    rr = 0;
    let rzNew = 0;
    for (let i = 0; i < N2; i++) {
      x[i] += alpha * p[i];
      r[i] -= alpha * Ap[i];
      z[i] = r[i] / diag[i];
      rzNew += r[i] * z[i];
      rr += r[i] * r[i];
    }
    const beta = rzNew / rz;
    rz = rzNew;
    for (let i = 0; i < N2; i++) p[i] = z[i] + beta * p[i];
    it++;
  }
  // keep the orientation of the polygons (counter-clockwise in uv when seen from the normal side)
  let signed = 0;
  for (let t = 0; t < nt; t++) {
    const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2];
    signed += (x[b * 2] - x[a * 2]) * (x[c * 2 + 1] - x[a * 2 + 1]) - (x[b * 2 + 1] - x[a * 2 + 1]) * (x[c * 2] - x[a * 2]);
  }
  if (signed < 0) for (let i = 0; i < n; i++) x[i * 2 + 1] = -x[i * 2 + 1];
  for (let i = 0; i < N2; i++) if (!Number.isFinite(x[i])) x[i] = 0;
  const converged = Math.sqrt(rr) <= tol * Math.sqrt(scale) * 10;
  return { uv: x, iterations: it, residual: converged ? 0 : Math.sqrt(rr / Math.max(1e-300, r0)) };
}

/** Approximate farthest-apart pair (double sweep) among candidate vertex indices (all when null). */
export function farthestPair(pos: Float64Array, cand: ArrayLike<number> | null, n: number): [number, number] {
  const m = cand ? cand.length : n;
  const at = (k: number) => (cand ? cand[k] : k);
  if (m < 2) return [0, Math.min(1, n - 1)];
  const sweep = (from: number) => {
    let best = at(0), bd = -1;
    for (let k = 0; k < m; k++) {
      const q = at(k);
      const d = (pos[q * 3] - pos[from * 3]) ** 2 + (pos[q * 3 + 1] - pos[from * 3 + 1]) ** 2 + (pos[q * 3 + 2] - pos[from * 3 + 2]) ** 2;
      if (d > bd) { bd = d; best = q; }
    }
    return best;
  };
  const a = sweep(at(0)), b = sweep(a);
  return a === b ? [at(0), at(1)] : [a, b];
}

// ---------------------------------------------------------------- packing

export interface Island {
  prims: number[];
  /** distinct vertices (corners) of the island */
  verts: number[];
  area3: number;
  areaUV: number;
}

/** Islands = polygons joined across edges whose uv is continuous (or by an int prim attribute). */
export function findIslands(g: Geometry, uv: Float64Array, byAttr: Int32Array | Float64Array | null = null, primMask?: ArrayLike<number> | null): { islands: Island[]; islandOfPrim: Int32Array } {
  let comp: Int32Array, count: number;
  if (byAttr) {
    const ids = new Map<number, number>();
    comp = new Int32Array(g.numPrims).fill(-1);
    for (let p = 0; p < g.numPrims; p++) {
      if (!g.primClosed[p] || g.primSize(p) < 3 || (primMask && !primMask[p])) continue;
      let c = ids.get(byAttr[p]);
      if (c === undefined) { c = ids.size; ids.set(byAttr[p], c); }
      comp[p] = c;
    }
    count = ids.size;
  } else {
    const S = polygonSides(g, primMask);
    ({ comp, count } = primComponents(g, S, uvSeamPairs(S, uv), primMask));
  }
  const islands: Island[] = Array.from({ length: count }, () => ({ prims: [], verts: [], area3: 0, areaUV: 0 }));
  for (let p = 0; p < g.numPrims; p++) {
    const c = comp[p];
    if (c < 0) continue;
    const isl = islands[c];
    isl.prims.push(p);
    isl.area3 += primArea(g, p);
    const s = g.primStart[p], e = g.primStart[p + 1];
    let a = 0;
    for (let v = s; v < e; v++) {
      isl.verts.push(v);
      const w = v + 1 < e ? v + 1 : s;
      a += uv[v * 2] * uv[w * 2 + 1] - uv[w * 2] * uv[v * 2 + 1];
    }
    isl.areaUV += Math.abs(a) / 2;
  }
  return { islands, islandOfPrim: comp };
}

/** Convex hull (monotone chain) of 2D points given as flat [x, y, ...]; returns hull as flat CCW list. */
export function convexHull2D(pts: ArrayLike<number>): number[] {
  const n = pts.length / 2;
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => pts[a * 2] - pts[b * 2] || pts[a * 2 + 1] - pts[b * 2 + 1]);
  const cross = (o: number, a: number, b: number) => (pts[a * 2] - pts[o * 2]) * (pts[b * 2 + 1] - pts[o * 2 + 1]) - (pts[a * 2 + 1] - pts[o * 2 + 1]) * (pts[b * 2] - pts[o * 2]);
  const lower: number[] = [], upper: number[] = [];
  for (const i of idx) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], i) <= 0) lower.pop();
    lower.push(i);
  }
  for (let k = idx.length - 1; k >= 0; k--) {
    const i = idx[k];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], i) <= 0) upper.pop();
    upper.push(i);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  const out: number[] = [];
  for (const i of hull) out.push(pts[i * 2], pts[i * 2 + 1]);
  if (!out.length && n) out.push(pts[0], pts[1]);
  return out;
}

/** Angle (radians) that rotates a hull to its minimum-area bounding rectangle (rotating calipers over hull edges). */
export function minAreaRectAngle(hull: number[]): number {
  const m = hull.length / 2;
  if (m < 3) {
    if (m === 2) return -Math.atan2(hull[3] - hull[1], hull[2] - hull[0]);
    return 0;
  }
  let best = 0, bestArea = Infinity;
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    const ang = Math.atan2(hull[j * 2 + 1] - hull[i * 2 + 1], hull[j * 2] - hull[i * 2]);
    const c = Math.cos(-ang), s = Math.sin(-ang);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let k = 0; k < m; k++) {
      const x = hull[k * 2] * c - hull[k * 2 + 1] * s, y = hull[k * 2] * s + hull[k * 2 + 1] * c;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const area = (x1 - x0) * (y1 - y0);
    if (area < bestArea - 1e-12) { bestArea = area; best = -ang; }
  }
  return best;
}

export interface Rect { w: number; h: number; id: number }
export interface Placed { x: number; y: number; rot: boolean; bin: number }

/**
 * Skyline bottom-left packing of rects into `bins` rectangles of W × H. Returns placements (by rect id) or null if they
 * do not fit. The skyline is a list of segments [x0, x1) at height y that tile [0, W) exactly; a rect rests on the
 * highest segment under its whole span, so no two rects overlap.
 */
export function skylinePack(rects: Rect[], W: number, bins: number, allowRotate: boolean, H = W): Placed[] | null {
  const out: Placed[] = new Array(rects.length);
  let bin = 0;
  let sky: { x0: number; x1: number; y: number }[] = [{ x0: 0, x1: W, y: 0 }];
  for (const r of rects) {
    for (;;) {
      let best: { x: number; y: number; top: number; rot: boolean; w: number } | null = null;
      for (const rot of allowRotate && r.w !== r.h ? [false, true] : [false]) {
        const w = rot ? r.h : r.w, h = rot ? r.w : r.h;
        if (!(w <= W && h <= H)) continue;
        for (let i = 0; i < sky.length; i++) {
          const x = sky[i].x0;
          if (x + w > W) break;
          let y = 0;
          for (let j = i; j < sky.length && sky[j].x0 < x + w; j++) if (sky[j].y > y) y = sky[j].y;
          const top = y + h;
          if (top > H) continue;
          if (!best || top < best.top || (top === best.top && x < best.x)) best = { x, y, top, rot, w };
        }
      }
      if (!best) {
        if (++bin >= bins) return null;
        sky = [{ x0: 0, x1: W, y: 0 }];
        continue;
      }
      out[r.id] = { x: best.x, y: best.y, rot: best.rot, bin };
      // the new segment [x, x + w) at the rect's top; the segments it covers are clipped exactly
      const n0 = best.x, n1 = best.x + best.w;
      const next: { x0: number; x1: number; y: number }[] = [];
      for (const s of sky) {
        if (s.x1 <= n0 || s.x0 >= n1) { next.push(s); continue; }
        if (s.x0 < n0) next.push({ x0: s.x0, x1: n0, y: s.y });
        if (s.x1 > n1) next.push({ x0: n1, x1: s.x1, y: s.y });
      }
      next.push({ x0: n0, x1: n1, y: best.top });
      next.sort((p, q) => p.x0 - q.x0);
      sky = [];
      for (const s of next) {
        if (!(s.x1 > s.x0)) continue;
        const last = sky[sky.length - 1];
        if (last && last.y === s.y) last.x1 = s.x1;
        else sky.push({ ...s });
      }
      break;
    }
  }
  return out;
}

/** Scale each chart's uv uniformly into the unit square (keeping its aspect). */
export function normaliseCharts(uv: Float64Array, charts: { verts: number[] }[]): void {
  for (const ch of charts) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const v of ch.verts) {
      const x = uv[v * 2], y = uv[v * 2 + 1];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const s = Math.max(x1 - x0, y1 - y0);
    const k = s > 1e-30 ? 1 / s : 1;
    for (const v of ch.verts) { uv[v * 2] = (uv[v * 2] - x0) * k; uv[v * 2 + 1] = (uv[v * 2 + 1] - y0) * k; }
  }
}
