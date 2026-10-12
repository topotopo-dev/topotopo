// Topology helpers: normals, areas, adjacency, edges, triangulation.
import earcut from 'earcut';
import { Geometry } from './geometry.ts';
import type { Vec3 } from './math.ts';
import type { EdgeSet } from './edges.ts';
import { halfEdges } from './halfedge.ts';

/** Newell normal (unnormalised; length = 2 * area). Robust for non-planar polygons. */
export function primNewell(g: Geometry, p: number, out: number[] = [0, 0, 0]): number[] {
  const P = g.P, vp = g.vertexPoint, s = g.primStart[p], e = g.primStart[p + 1];
  let nx = 0, ny = 0, nz = 0;
  for (let v = s; v < e; v++) {
    const a = vp[v] * 3, b = vp[v + 1 < e ? v + 1 : s] * 3;
    nx += (P[a + 1] - P[b + 1]) * (P[a + 2] + P[b + 2]);
    ny += (P[a + 2] - P[b + 2]) * (P[a] + P[b]);
    nz += (P[a] - P[b]) * (P[a + 1] + P[b + 1]);
  }
  out[0] = nx; out[1] = ny; out[2] = nz;
  return out;
}

export function primNormals(g: Geometry): Float64Array {
  const out = new Float64Array(g.numPrims * 3), t = [0, 0, 0];
  for (let p = 0; p < g.numPrims; p++) {
    if (!g.primClosed[p]) continue;
    primNewell(g, p, t);
    const l = Math.hypot(t[0], t[1], t[2]) || 1;
    out[p * 3] = t[0] / l; out[p * 3 + 1] = t[1] / l; out[p * 3 + 2] = t[2] / l;
  }
  return out;
}

/** primNormals and primArea of every prim from one Newell pass (the same values as calling both). */
function primNormalsAreas(g: Geometry): { fn: Float64Array; area: Float64Array } {
  const n = g.numPrims, fn = new Float64Array(n * 3), area = new Float64Array(n), t = [0, 0, 0];
  for (let p = 0; p < n; p++) {
    if (!g.primClosed[p]) continue;
    primNewell(g, p, t);
    const h = Math.hypot(t[0], t[1], t[2]), l = h || 1;
    fn[p * 3] = t[0] / l; fn[p * 3 + 1] = t[1] / l; fn[p * 3 + 2] = t[2] / l;
    area[p] = h / 2;
  }
  return { fn, area };
}

export function primArea(g: Geometry, p: number): number {
  if (!g.primClosed[p]) return 0;
  const t = primNewell(g, p);
  return Math.hypot(t[0], t[1], t[2]) / 2;
}

export function primCentroid(g: Geometry, p: number): Vec3 {
  const P = g.P, s = g.primStart[p], e = g.primStart[p + 1];
  let x = 0, y = 0, z = 0;
  for (let v = s; v < e; v++) {
    const i = g.vertexPoint[v] * 3;
    x += P[i]; y += P[i + 1]; z += P[i + 2];
  }
  const n = Math.max(1, e - s);
  return [x / n, y / n, z / n];
}

export function primPerimeter(g: Geometry, p: number): number {
  const P = g.P, s = g.primStart[p], e = g.primStart[p + 1];
  let L = 0;
  const last = g.primClosed[p] ? e : e - 1;
  for (let v = s; v < last; v++) {
    const a = g.vertexPoint[v] * 3, b = g.vertexPoint[v + 1 < e ? v + 1 : s] * 3;
    L += Math.hypot(P[a] - P[b], P[a + 1] - P[b + 1], P[a + 2] - P[b + 2]);
  }
  return L;
}

/** Area-weighted point normals. Points not on any polygon get (0,1,0). */
export function pointNormals(g: Geometry): Float64Array {
  const N = new Float64Array(g.numPoints * 3), t = [0, 0, 0];
  for (let p = 0; p < g.numPrims; p++) {
    if (!g.primClosed[p]) continue;
    primNewell(g, p, t);
    for (let v = g.primStart[p]; v < g.primStart[p + 1]; v++) {
      const i = g.vertexPoint[v] * 3;
      N[i] += t[0]; N[i + 1] += t[1]; N[i + 2] += t[2];
    }
  }
  for (let i = 0; i < N.length; i += 3) {
    const l = Math.hypot(N[i], N[i + 1], N[i + 2]);
    if (l > 1e-20) { N[i] /= l; N[i + 1] /= l; N[i + 2] /= l; } else { N[i] = 0; N[i + 1] = 1; N[i + 2] = 0; }
  }
  return N;
}

/**
 * Per-vertex normals; faces sharing a point are averaged only when within cuspDeg of each other.
 * hardEdges (point pairs) additionally split the normals: around a point, faces are only averaged
 * when they can be reached from each other across shared edges that are not hard.
 */
export function vertexNormals(g: Geometry, cuspDeg = 60, hardEdges: EdgeSet | null = null): Float64Array {
  if (hardEdges && hardEdges.size) return vertexNormalsHard(g, cuspDeg, hardEdges);
  const { fn, area } = primNormalsAreas(g);
  const pp = pointPrims(g);
  const vprim = g.vertexPrims();
  const cosT = Math.cos((cuspDeg * Math.PI) / 180);
  const out = new Float64Array(g.numVertices * 3);
  for (let v = 0; v < g.numVertices; v++) {
    const p = vprim[v], pt = g.vertexPoint[v];
    const nx = fn[p * 3], ny = fn[p * 3 + 1], nz = fn[p * 3 + 2];
    let ax = 0, ay = 0, az = 0;
    for (let k = pp.start[pt]; k < pp.start[pt + 1]; k++) {
      const q = pp.prims[k];
      const qx = fn[q * 3], qy = fn[q * 3 + 1], qz = fn[q * 3 + 2];
      if (q === p || nx * qx + ny * qy + nz * qz >= cosT) {
        const w = area[q] + 1e-12;
        ax += qx * w; ay += qy * w; az += qz * w;
      }
    }
    const l = Math.hypot(ax, ay, az) || 1;
    out[v * 3] = ax / l; out[v * 3 + 1] = ay / l; out[v * 3 + 2] = az / l;
  }
  return out;
}

/** vertexNormals with hard edges: smoothing fans around each point are cut at hard edges. */
function vertexNormalsHard(g: Geometry, cuspDeg: number, hard: EdgeSet): Float64Array {
  const { fn, area } = primNormalsAreas(g);
  const he = halfEdges(g);
  // union corners (half-edges) at the same point that are joined across a non-hard shared edge
  const parent = new Int32Array(he.numHalfEdges);
  for (let h = 0; h < parent.length; h++) parent[h] = h;
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let h = 0; h < he.numHalfEdges; h++) {
    const t = he.heTwin[h];
    if (t < 0 || t < h) continue;
    const a = he.heOrigin[h], b = he.dest(h);
    if (hard.has(a, b)) continue;
    // corner at a in h's face joins the corner at a in t's face (t runs b→a, so next(t) starts at a); same for b
    const r1 = find(h), r2 = find(he.heNext[t]);
    if (r1 !== r2) parent[r1] = r2;
    const r3 = find(he.heNext[h]), r4 = find(t);
    if (r3 !== r4) parent[r3] = r4;
  }
  const vprim = g.vertexPrims();
  const cosT = Math.cos((cuspDeg * Math.PI) / 180);
  // vertices per point (CSR)
  const start = new Int32Array(g.numPoints + 1);
  for (let v = 0; v < g.numVertices; v++) start[g.vertexPoint[v] + 1]++;
  for (let i = 0; i < g.numPoints; i++) start[i + 1] += start[i];
  const list = new Int32Array(g.numVertices), fill = start.slice(0, g.numPoints);
  for (let v = 0; v < g.numVertices; v++) list[fill[g.vertexPoint[v]]++] = v;
  const out = new Float64Array(g.numVertices * 3);
  for (let v = 0; v < g.numVertices; v++) {
    const p = vprim[v], pt = g.vertexPoint[v], hv = he.vertexHalf[v];
    const root = hv >= 0 ? find(hv) : -1;
    const nx = fn[p * 3], ny = fn[p * 3 + 1], nz = fn[p * 3 + 2];
    let ax = 0, ay = 0, az = 0;
    for (let k = start[pt]; k < start[pt + 1]; k++) {
      const u = list[k], q = vprim[u];
      if (u !== v) {
        const hu = he.vertexHalf[u];
        if (root >= 0 ? hu < 0 || find(hu) !== root : false) continue;
        if (q !== p && fn[q * 3] * nx + fn[q * 3 + 1] * ny + fn[q * 3 + 2] * nz < cosT) continue;
      }
      const w = area[q] + 1e-12;
      ax += fn[q * 3] * w; ay += fn[q * 3 + 1] * w; az += fn[q * 3 + 2] * w;
    }
    const l = Math.hypot(ax, ay, az) || 1;
    out[v * 3] = ax / l; out[v * 3 + 1] = ay / l; out[v * 3 + 2] = az / l;
  }
  return out;
}

/**
 * Per-vertex shading normals by Houdini precedence (vertex N, then point N), falling back to
 * computed normals wherever N is missing or zero-length (e.g. after merging parts without N).
 */
export function resolveVertexNormals(g: Geometry, cuspDeg = 60): Float64Array {
  const vN = g.vertices.get('N'), pN = g.points.get('N');
  const src = vN && vN.size === 3 && vN.type === 'float' ? { d: vN.data as Float64Array, pt: false } : pN && pN.size === 3 && pN.type === 'float' ? { d: pN.data as Float64Array, pt: true } : null;
  let computed: Float64Array | null = null;
  const out = new Float64Array(g.numVertices * 3);
  for (let v = 0; v < g.numVertices; v++) {
    let x = 0, y = 0, z = 0;
    if (src) {
      const i = (src.pt ? g.vertexPoint[v] : v) * 3;
      x = src.d[i]; y = src.d[i + 1]; z = src.d[i + 2];
    }
    const l = Math.hypot(x, y, z);
    if (l < 1e-9) {
      if (!computed) computed = vertexNormals(g, cuspDeg);
      out[v * 3] = computed[v * 3]; out[v * 3 + 1] = computed[v * 3 + 1]; out[v * 3 + 2] = computed[v * 3 + 2];
    } else { out[v * 3] = x / l; out[v * 3 + 1] = y / l; out[v * 3 + 2] = z / l; }
  }
  return out;
}

/**
 * After moving points: recompute any existing N so shading follows the new shape (vertex N keeps hardEdges hard).
 * Writes into g's N attributes in place and returns g: only call it on a clone or freshly built geometry.
 */
export function refreshNormals(g: Geometry, cuspDeg = 60, hardEdges: EdgeSet | null = null): Geometry {
  const pN = g.points.get('N');
  if (pN && pN.size === 3 && pN.type === 'float') {
    // only points on polygons get new normals; isolated points (scatters, leaves) keep theirs
    const fresh = pointNormals(g), d = pN.data as Float64Array;
    const onPoly = new Uint8Array(g.numPoints);
    for (let p = 0; p < g.numPrims; p++) if (g.primClosed[p]) for (let v = g.primStart[p]; v < g.primStart[p + 1]; v++) onPoly[g.vertexPoint[v]] = 1;
    for (let i = 0; i < g.numPoints; i++) if (onPoly[i]) { d[i * 3] = fresh[i * 3]; d[i * 3 + 1] = fresh[i * 3 + 1]; d[i * 3 + 2] = fresh[i * 3 + 2]; }
  }
  const vN = g.vertices.get('N');
  if (vN && vN.size === 3 && vN.type === 'float') (vN.data as Float64Array).set(vertexNormals(g, cuspDeg, hardEdges));
  const prN = g.prims.get('N');
  if (prN && prN.size === 3 && prN.type === 'float') (prN.data as Float64Array).set(primNormals(g));
  return g;
}

/** CSR map point → prims using it (a prim appears once per vertex referencing the point). */
export function pointPrims(g: Geometry) {
  const cnt = new Int32Array(g.numPoints + 1);
  for (let v = 0; v < g.numVertices; v++) cnt[g.vertexPoint[v] + 1]++;
  for (let i = 0; i < g.numPoints; i++) cnt[i + 1] += cnt[i];
  const prims = new Int32Array(g.numVertices), fill = cnt.slice(0, g.numPoints);
  for (let p = 0; p < g.numPrims; p++)
    for (let v = g.primStart[p]; v < g.primStart[p + 1]; v++) prims[fill[g.vertexPoint[v]]++] = p;
  return { start: cnt, prims };
}

export interface EdgeInfo {
  a: Int32Array; // lower point index
  b: Int32Array; // higher point index
  count: Int32Array; // number of polygon sides using the edge
  firstPrim: Int32Array;
  /** second prim using the edge (-1 if none) */
  secondPrim: Int32Array;
  map: Map<number, number>; // key(a,b) -> edge index
  key: (a: number, b: number) => number;
}

/** Unique undirected edges of all prims (polyline segments included). */
export function buildEdges(g: Geometry): EdgeInfo {
  const n = g.numPoints;
  const key = (a: number, b: number) => (a < b ? a * n + b : b * n + a);
  const map = new Map<number, number>();
  const A: number[] = [], B: number[] = [], C: number[] = [], F: number[] = [], S: number[] = [];
  for (let p = 0; p < g.numPrims; p++) {
    const s = g.primStart[p], e = g.primStart[p + 1];
    const last = g.primClosed[p] ? e : e - 1;
    for (let v = s; v < last; v++) {
      const a = g.vertexPoint[v], b = g.vertexPoint[v + 1 < e ? v + 1 : s];
      if (a === b) continue;
      const k = key(a, b);
      const ei = map.get(k);
      if (ei === undefined) {
        map.set(k, A.length);
        A.push(Math.min(a, b)); B.push(Math.max(a, b)); C.push(1); F.push(p); S.push(-1);
      } else { C[ei]++; if (S[ei] < 0 && F[ei] !== p) S[ei] = p; }
    }
  }
  return { a: Int32Array.from(A), b: Int32Array.from(B), count: Int32Array.from(C), firstPrim: Int32Array.from(F), secondPrim: Int32Array.from(S), map, key };
}

/** CSR point adjacency through edges. */
export function pointNeighbors(g: Geometry) {
  const E = buildEdges(g);
  const cnt = new Int32Array(g.numPoints + 1);
  for (let e = 0; e < E.a.length; e++) { cnt[E.a[e] + 1]++; cnt[E.b[e] + 1]++; }
  for (let i = 0; i < g.numPoints; i++) cnt[i + 1] += cnt[i];
  const nb = new Int32Array(E.a.length * 2), fill = cnt.slice(0, g.numPoints);
  for (let e = 0; e < E.a.length; e++) { nb[fill[E.a[e]]++] = E.b[e]; nb[fill[E.b[e]]++] = E.a[e]; }
  return { start: cnt, nb };
}

/** Directed boundary half-edges of closed polygons, chained into loops of point indices. */
export function boundaryLoops(g: Geometry): number[][] {
  const n = g.numPoints;
  const half = new Map<number, number>(); // directed key a->b count
  const dk = (a: number, b: number) => a * n + b;
  const next = new Map<number, number[]>();
  for (let p = 0; p < g.numPrims; p++) {
    if (!g.primClosed[p]) continue;
    const s = g.primStart[p], e = g.primStart[p + 1];
    for (let v = s; v < e; v++) {
      const a = g.vertexPoint[v], b = g.vertexPoint[v + 1 < e ? v + 1 : s];
      half.set(dk(a, b), (half.get(dk(a, b)) ?? 0) + 1);
    }
  }
  for (const [k] of half) {
    const a = Math.floor(k / n), b = k % n;
    if (!half.has(dk(b, a))) {
      // boundary half-edge a->b; hole loop runs opposite: b->a
      if (!next.has(b)) next.set(b, []);
      next.get(b)!.push(a);
    }
  }
  const loops: number[][] = [];
  const used = new Set<number>();
  for (const [start, outs] of next) {
    for (const first of outs) {
      const ek = dk(start, first);
      if (used.has(ek)) continue;
      const loop = [start];
      let cur = start, nx = first;
      used.add(ek);
      let guard = 0;
      while (nx !== start && guard++ < 1e7) {
        loop.push(nx);
        const cands = next.get(nx) ?? [];
        const pick = cands.find((c) => !used.has(dk(nx, c)));
        if (pick === undefined) break;
        used.add(dk(nx, pick));
        cur = nx; nx = pick;
      }
      void cur;
      if (nx === start && loop.length >= 3) loops.push(loop);
    }
  }
  return loops;
}

export interface Triangulation {
  tris: Uint32Array; // vertex indices, 3 per triangle
  triPrim: Uint32Array; // source prim per triangle
}

/** Triangulate closed polygons. Fans for convex quads/tris, earcut otherwise. Output winding follows the polygon. */
export function triangulate(g: Geometry, primMask?: ArrayLike<number> | null): Triangulation {
  const P = g.P, vp = g.vertexPoint;
  const tris: number[] = [], tp: number[] = [];
  const nrm = [0, 0, 0];
  const pt = (v: number) => vp[v] * 3;
  const triN = (a: number, b: number, c: number) => {
    const ia = pt(a), ib = pt(b), ic = pt(c);
    const ux = P[ib] - P[ia], uy = P[ib + 1] - P[ia + 1], uz = P[ib + 2] - P[ia + 2];
    const wx = P[ic] - P[ia], wy = P[ic + 1] - P[ia + 1], wz = P[ic + 2] - P[ia + 2];
    return (uy * wz - uz * wy) * nrm[0] + (uz * wx - ux * wz) * nrm[1] + (ux * wy - uy * wx) * nrm[2];
  };
  for (let p = 0; p < g.numPrims; p++) {
    if (!g.primClosed[p] || (primMask && !primMask[p])) continue;
    const s = g.primStart[p], e = g.primStart[p + 1], n = e - s;
    if (n < 3) continue;
    if (n === 3) { tris.push(s, s + 1, s + 2); tp.push(p); continue; }
    primNewell(g, p, nrm);
    if (n === 4) {
      // pick the diagonal that keeps both triangles facing the polygon normal
      const ok02 = triN(s, s + 1, s + 2) > 0 && triN(s, s + 2, s + 3) > 0;
      if (ok02 || !(triN(s + 1, s + 2, s + 3) > 0 && triN(s + 1, s + 3, s) > 0)) {
        tris.push(s, s + 1, s + 2, s, s + 2, s + 3);
      } else tris.push(s + 1, s + 2, s + 3, s + 1, s + 3, s);
      tp.push(p, p);
      continue;
    }
    // project to the dominant plane and ear-clip
    const ax = Math.abs(nrm[0]), ay = Math.abs(nrm[1]), az = Math.abs(nrm[2]);
    const [u, w] = ax >= ay && ax >= az ? [1, 2] : ay >= az ? [2, 0] : [0, 1];
    const flat = new Float64Array(n * 2);
    for (let k = 0; k < n; k++) { flat[k * 2] = P[pt(s + k) + u]; flat[k * 2 + 1] = P[pt(s + k) + w]; }
    const idx = earcut(flat as unknown as number[]);
    if (idx.length === 0) {
      for (let k = 1; k < n - 1; k++) { tris.push(s, s + k, s + k + 1); tp.push(p); }
      continue;
    }
    for (let k = 0; k < idx.length; k += 3) {
      let a = s + idx[k], b = s + idx[k + 1], c = s + idx[k + 2];
      if (triN(a, b, c) < 0) [b, c] = [c, b];
      tris.push(a, b, c);
      tp.push(p);
    }
  }
  return { tris: Uint32Array.from(tris), triPrim: Uint32Array.from(tp) };
}

/** Connected components over shared points. Returns component id per prim and per point. */
export function connectivity(g: Geometry) {
  const parent = new Int32Array(g.numPoints);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  };
  for (let p = 0; p < g.numPrims; p++) {
    const s = g.primStart[p], e = g.primStart[p + 1];
    for (let v = s + 1; v < e; v++) {
      const a = find(g.vertexPoint[s]), b = find(g.vertexPoint[v]);
      if (a !== b) parent[b] = a;
    }
  }
  const id = new Map<number, number>();
  const ptClass = new Int32Array(g.numPoints);
  for (let i = 0; i < g.numPoints; i++) {
    const r = find(i);
    let c = id.get(r);
    if (c === undefined) { c = id.size; id.set(r, c); }
    ptClass[i] = c;
  }
  const primClass = new Int32Array(g.numPrims);
  for (let p = 0; p < g.numPrims; p++) primClass[p] = g.primSize(p) ? ptClass[g.vertexPoint[g.primStart[p]]] : -1;
  return { ptClass, primClass, count: id.size };
}

/**
 * Reverse the winding of selected prims (all if mask is null). Closed polygons keep their
 * first vertex (Houdini convention); open polylines are fully reversed.
 */
export function reversePrims(g: Geometry, mask: ArrayLike<number> | null = null): Geometry {
  const out = g.clone();
  const order = new Int32Array(g.numVertices);
  for (let p = 0; p < g.numPrims; p++) {
    const s = g.primStart[p], e = g.primStart[p + 1], n = e - s;
    for (let k = 0; k < n; k++) {
      let src = s + k;
      if (!mask || mask[p]) src = g.primClosed[p] ? s + (k === 0 ? 0 : n - k) : e - 1 - k;
      order[s + k] = src;
    }
  }
  for (let v = 0; v < g.numVertices; v++) out.vertexPoint[v] = g.vertexPoint[order[v]];
  out.vertices = g.vertices.gather(order);
  for (const [k, m] of g.vertexGroups) out.vertexGroups.set(k, Uint8Array.from(order, (v) => m[v]));
  const vn = out.vertices.get('N');
  if (vn && vn.type === 'float') {
    const d = vn.data as Float64Array;
    const vp = g.vertexPrims();
    for (let v = 0; v < g.numVertices; v++) if (!mask || mask[vp[v]]) for (let c = 0; c < vn.size; c++) d[v * vn.size + c] *= -1;
  }
  return out;
}

/** Signed volume of closed polygons (positive when faces point outward). */
export function signedVolume(g: Geometry): number {
  const { tris } = triangulate(g);
  const P = g.P;
  let vol = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const a = g.vertexPoint[tris[t]] * 3, b = g.vertexPoint[tris[t + 1]] * 3, c = g.vertexPoint[tris[t + 2]] * 3;
    vol += P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]);
  }
  return vol / 6;
}

/** Make a closed mesh face outward (flip everything if the signed volume is negative). */
export function orientOutward(g: Geometry): Geometry {
  return signedVolume(g) < 0 ? reversePrims(g) : g;
}

/** Quick topology health report used by inspect and by solid ops. */
export function topologyReport(g: Geometry) {
  const E = buildEdges(g);
  let boundary = 0, nonManifold = 0;
  for (let e = 0; e < E.count.length; e++) {
    if (E.count[e] === 1) boundary++;
    else if (E.count[e] > 2) nonManifold++;
  }
  let polys = 0, lines = 0, degenerate = 0, tris = 0, quads = 0, ngons = 0;
  for (let p = 0; p < g.numPrims; p++) {
    const n = g.primSize(p);
    if (g.primClosed[p]) {
      polys++;
      if (n < 3 || primArea(g, p) < 1e-14) degenerate++;
      if (n === 3) tris++; else if (n === 4) quads++; else if (n > 4) ngons++;
    } else lines++;
  }
  const used = new Uint8Array(g.numPoints);
  for (let v = 0; v < g.numVertices; v++) used[g.vertexPoint[v]] = 1;
  let unused = 0;
  for (let i = 0; i < used.length; i++) if (!used[i]) unused++;
  const conn = connectivity(g);
  const V = g.numPoints - unused, F = polys, Ecount = E.a.length;
  const closed = polys > 0 && boundary === 0 && nonManifold === 0;
  return {
    polys, lines, tris, quads, ngons, degenerate, edges: Ecount, boundaryEdges: boundary,
    nonManifoldEdges: nonManifold, unusedPoints: unused, pieces: conn.count,
    closed, euler: V - Ecount + F,
  };
}
