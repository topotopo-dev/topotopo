// UV-space baking: rasterise a mesh's triangles into texel space and evaluate surface data per texel (position,
// normal, attributes, triangle and island ids, ray measures, edge curvature) for the bake nodes (src/nodes/bake.ts).
//
//   texel (i, j)   centre at u = (i + 0.5) / W, v = 1 - (j + 0.5) / H (core/image.ts conventions)
//   coverage       a texel is covered by the triangle containing its centre; texels whose square only overlaps a
//                  triangle (conservative coverage) take the closest point of the nearest such triangle, so thin
//                  triangles and island borders leave no holes
//   supersample    the bake runs at S × S samples per output texel and averages the covered ones; the covered
//                  fraction is the coverage ("mask" layer)
//   padding        uncovered texels within `padding` texels of a covered one copy the nearest covered texel (exact
//                  Euclidean distance transform), so mipmaps and bilinear filtering do not bleed the background
// Only covered samples are evaluated: a BakeSamples lists them with their triangle and barycentric weights, the
// per-sample values are computed (on the worker pool for rays and curvature: kernels "occlusion", "bake_project",
// "bake_curvature" in core/kernels.ts) and resolve() averages them into the output texels.
import type { Geometry } from './geometry.ts';
import { distanceTransform } from './heightfield.ts';
import type { RayScene } from './analysis.ts';
import { hash32 } from './random.ts';
import { primNormals } from './topology.ts';

export interface TexelMap {
  w: number;
  h: number;
  /** triangle per texel (index into the triangulation; -1 = not covered) */
  tri: Int32Array;
  /** barycentric weights of corners 1 and 2 per texel (corner 0 = 1 - b1 - b2) */
  b1: Float32Array;
  b2: Float32Array;
  /** covered texels */
  covered: number;
  /** triangles with no area in uv (skipped) */
  degenerate: number;
  /** triangles reaching outside the 0..1 uv square (clipped) */
  outside: number;
}

/**
 * Rasterise triangles (vertex index triples into `uv`, 2 floats per vertex) into a w × h texel grid. Centre-inside
 * texels first; then, with conservative, texels within half a texel diagonal of a triangle that no triangle covers
 * take the closest point on the nearest one. `skip` leaves triangles out (masked prims).
 */
export function rasterizeUV(uv: ArrayLike<number>, tris: ArrayLike<number>, w: number, h: number, conservative = true, skip?: Uint8Array | null): TexelMap {
  const n = w * h, nt = Math.floor(tris.length / 3);
  const tri = new Int32Array(n).fill(-1), b1 = new Float32Array(n), b2 = new Float32Array(n);
  let degenerate = 0, outside = 0;
  const X = (v: number) => uv[v * 2] * w, Y = (v: number) => (1 - uv[v * 2 + 1]) * h;
  const area2 = new Float64Array(nt);
  for (let t = 0; t < nt; t++) {
    if (skip && skip[t]) continue;
    const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2];
    const ax = X(a), ay = Y(a), bx = X(b), by = Y(b), cx = X(c), cy = Y(c);
    const ar = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    area2[t] = ar;
    if (!(Math.abs(ar) > 1e-12)) { degenerate++; continue; }
    if (Math.min(ax, bx, cx) < -1e-6 || Math.min(ay, by, cy) < -1e-6 || Math.max(ax, bx, cx) > w + 1e-6 || Math.max(ay, by, cy) > h + 1e-6) outside++;
    const i0 = Math.max(0, Math.floor(Math.min(ax, bx, cx) - 0.5)), i1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cx) - 0.5));
    const j0 = Math.max(0, Math.floor(Math.min(ay, by, cy) - 0.5)), j1 = Math.min(h - 1, Math.ceil(Math.max(ay, by, cy) - 0.5));
    const inv = 1 / ar;
    for (let j = j0; j <= j1; j++) {
      const py = j + 0.5;
      for (let i = i0; i <= i1; i++) {
        const px = i + 0.5;
        const w1 = ((cx - ax) * (py - ay) - (cy - ay) * (px - ax)) * -inv; // weight of b
        const w2 = ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) * inv; // weight of c
        if (w1 < -1e-9 || w2 < -1e-9 || w1 + w2 > 1 + 1e-9) continue;
        const k = j * w + i;
        tri[k] = t; b1[k] = w1; b2[k] = w2;
      }
    }
  }
  if (conservative) {
    const best = new Float32Array(n).fill(Infinity);
    const R = Math.SQRT1_2 + 1e-6, R2 = R * R;
    for (let t = 0; t < nt; t++) {
      if (!(Math.abs(area2[t]) > 1e-12)) continue;
      const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2];
      const ax = X(a), ay = Y(a), bx = X(b), by = Y(b), cx = X(c), cy = Y(c);
      const i0 = Math.max(0, Math.floor(Math.min(ax, bx, cx) - 0.5 - R)), i1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cx) - 0.5 + R));
      const j0 = Math.max(0, Math.floor(Math.min(ay, by, cy) - 0.5 - R)), j1 = Math.min(h - 1, Math.ceil(Math.max(ay, by, cy) - 0.5 + R));
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const k = j * w + i;
          if (tri[k] >= 0 && best[k] === Infinity) continue; // covered by a centre test
          const q = closestOnTri(i + 0.5, j + 0.5, ax, ay, bx, by, cx, cy);
          if (q.d2 > R2 || q.d2 >= best[k]) continue;
          best[k] = q.d2; tri[k] = t; b1[k] = q.w1; b2[k] = q.w2;
        }
    }
  }
  let covered = 0;
  for (let k = 0; k < n; k++) if (tri[k] >= 0) covered++;
  return { w, h, tri, b1, b2, covered, degenerate, outside };
}

const cq = { d2: 0, w1: 0, w2: 0 };
/** Closest point of triangle abc to p in 2D: squared distance and barycentric weights of b and c (Ericson). */
function closestOnTri(px: number, py: number, ax: number, ay: number, bx: number, by: number, cx: number, cy: number) {
  const abx = bx - ax, aby = by - ay, acx = cx - ax, acy = cy - ay, apx = px - ax, apy = py - ay;
  const d1 = abx * apx + aby * apy, d2 = acx * apx + acy * apy;
  const set = (w1: number, w2: number) => {
    const qx = ax + abx * w1 + acx * w2 - px, qy = ay + aby * w1 + acy * w2 - py;
    cq.d2 = qx * qx + qy * qy; cq.w1 = w1; cq.w2 = w2; return cq;
  };
  if (d1 <= 0 && d2 <= 0) return set(0, 0);
  const bpx = px - bx, bpy = py - by, d3 = abx * bpx + aby * bpy, d4 = acx * bpx + acy * bpy;
  if (d3 >= 0 && d4 <= d3) return set(1, 0);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return set(d1 / (d1 - d3), 0);
  const cpx = px - cx, cpy = py - cy, d5 = abx * cpx + aby * cpy, d6 = acx * cpx + acy * cpy;
  if (d6 >= 0 && d5 <= d6) return set(0, 1);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return set(0, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const t = (d4 - d3) / (d4 - d3 + (d5 - d6)); return set(1 - t, t); }
  const den = 1 / (va + vb + vc);
  return set(vb * den, vc * den);
}

// ---------------------------------------------------------------- covered samples

/** The covered samples of a (supersampled) texel map: what the bakes evaluate. */
export interface BakeSamples {
  /** output size (texels) and supersampling factor: the map is (W·S) × (H·S) */
  W: number;
  H: number;
  S: number;
  /** number of covered samples */
  n: number;
  /** output texel of each sample */
  texel: Int32Array;
  /** triangle and barycentric weights (corners 1, 2) of each sample */
  tri: Int32Array;
  b1: Float32Array;
  b2: Float32Array;
  degenerate: number;
  outside: number;
}

/** Rasterise at S × S samples per texel and list the covered samples (row-major sample order). */
export function bakeSamples(uv: ArrayLike<number>, tris: ArrayLike<number>, W: number, H: number, S: number, skip?: Uint8Array | null): BakeSamples {
  const w = W * S, h = H * S;
  const map = rasterizeUV(uv, tris, w, h, true, skip);
  const n = map.covered;
  const texel = new Int32Array(n), tri = new Int32Array(n), b1 = new Float32Array(n), b2 = new Float32Array(n);
  let k = 0;
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const q = j * w + i, t = map.tri[q];
      if (t < 0) continue;
      texel[k] = Math.floor(j / S) * W + Math.floor(i / S);
      tri[k] = t; b1[k] = map.b1[q]; b2[k] = map.b2[q];
      k++;
    }
  return { W, H, S, n, texel, tri, b1, b2, degenerate: map.degenerate, outside: map.outside };
}

/** Per-sample interpolation of per-vertex values (`size` floats per vertex index of the triangulation). */
export function interpolate(s: BakeSamples, tris: ArrayLike<number>, vals: ArrayLike<number>, size: number): Float64Array {
  const out = new Float64Array(s.n * size);
  for (let k = 0; k < s.n; k++) {
    const t = s.tri[k], w1 = s.b1[k], w2 = s.b2[k], w0 = 1 - w1 - w2;
    const a = tris[t * 3] * size, b = tris[t * 3 + 1] * size, c = tris[t * 3 + 2] * size;
    for (let q = 0; q < size; q++) out[k * size + q] = vals[a + q] * w0 + vals[b + q] * w1 + vals[c + q] * w2;
  }
  return out;
}

/**
 * Average the samples (ch values each) into the W × H output: data (W·H·ch) and coverage (covered fraction of each
 * texel's S × S samples). Texels without samples stay 0 (dilate() fills them).
 */
export function resolve(s: BakeSamples, vals: ArrayLike<number>, ch: number): { data: Float32Array; coverage: Float32Array } {
  const nt = s.W * s.H;
  const acc = new Float64Array(nt * ch), cnt = new Int32Array(nt);
  for (let k = 0; k < s.n; k++) {
    const t = s.texel[k];
    cnt[t]++;
    for (let c = 0; c < ch; c++) acc[t * ch + c] += vals[k * ch + c];
  }
  const data = new Float32Array(nt * ch), coverage = new Float32Array(nt), inv = 1 / (s.S * s.S);
  for (let t = 0; t < nt; t++) {
    if (!cnt[t]) continue;
    coverage[t] = cnt[t] * inv;
    for (let c = 0; c < ch; c++) data[t * ch + c] = acc[t * ch + c] / cnt[t];
  }
  return { data, coverage };
}

/**
 * Padding (edge dilation): every texel with coverage 0 within `padding` texels of a covered texel copies that texel;
 * the rest get `background`. Writes vals in place; returns the number of texels filled by padding.
 */
export function dilate(vals: Float32Array, ch: number, w: number, h: number, coverage: Float32Array, padding: number, background: number[]): number {
  const n = w * h;
  let filled = 0;
  const sites = new Uint8Array(n);
  let any = false;
  for (let k = 0; k < n; k++) if (coverage[k] > 0) { sites[k] = 1; any = true; }
  const lim = padding * padding;
  const dt = any && padding > 0 ? distanceTransform(sites, w, h) : null;
  for (let k = 0; k < n; k++) {
    if (sites[k]) continue;
    if (dt && dt.d2[k] <= lim && dt.nearest[k] >= 0) {
      const s = dt.nearest[k];
      for (let c = 0; c < ch; c++) vals[k * ch + c] = vals[s * ch + c];
      filled++;
    } else for (let c = 0; c < ch; c++) vals[k * ch + c] = background[c] ?? 0;
  }
  return filled;
}

/** Normalise 3-vectors in place (zero vectors stay zero). */
export function normalize3(a: Float32Array | Float64Array): void {
  for (let i = 0; i < a.length; i += 3) {
    const l = Math.hypot(a[i], a[i + 1], a[i + 2]);
    if (l > 0) { a[i] /= l; a[i + 1] /= l; a[i + 2] /= l; }
  }
}

/** Per-vertex copy of a point, vertex, prim or detail attribute (first `size` components; missing components = fill). */
export function vertexValues(g: Geometry, name: string, size: number, fill = 0): Float64Array | null {
  const f = g.findAttrib(name, ['vertex', 'point', 'prim', 'detail']);
  if (!f || f.attr.type === 'string' || f.attr.isArray) return null;
  const a = f.attr, d = a.data as Float64Array | Int32Array, s = a.size, nv = g.numVertices;
  const out = new Float64Array(nv * size);
  const vp = f.cls === 'prim' ? g.vertexPrims() : null;
  for (let v = 0; v < nv; v++) {
    const e = f.cls === 'vertex' ? v : f.cls === 'point' ? g.vertexPoint[v] : f.cls === 'prim' ? vp![v] : 0;
    for (let c = 0; c < size; c++) out[v * size + c] = c < s ? d[e * s + c] : s === 1 && c < 3 ? d[e] : fill;
  }
  return out;
}

/**
 * Smooth per-vertex normals for projection rays: area-weighted face normals averaged over every polygon touching the
 * same position (points matched within tol), so hard edges and split points do not open gaps between the rays of
 * neighbouring faces (the "averaged normals" cage of bakers).
 */
export function averagedVertexNormals(g: Geometry, tol: number): Float64Array {
  const P = g.P, np = g.numPoints, q = 1 / Math.max(tol, 1e-12);
  const canon = new Int32Array(np), ids = new Map<string, number>();
  for (let i = 0; i < np; i++) {
    const k = `${Math.round(P[i * 3] * q)},${Math.round(P[i * 3 + 1] * q)},${Math.round(P[i * 3 + 2] * q)}`;
    let id = ids.get(k);
    if (id === undefined) { id = i; ids.set(k, i); }
    canon[i] = id;
  }
  const acc = new Float64Array(np * 3);
  for (let p = 0; p < g.numPrims; p++) {
    if (!g.primClosed[p]) continue;
    const s = g.primStart[p], e = g.primStart[p + 1];
    let nx = 0, ny = 0, nz = 0;
    for (let v = s; v < e; v++) {
      const a = g.vertexPoint[v] * 3, b = g.vertexPoint[v + 1 < e ? v + 1 : s] * 3;
      nx += (P[a + 1] - P[b + 1]) * (P[a + 2] + P[b + 2]);
      ny += (P[a + 2] - P[b + 2]) * (P[a] + P[b]);
      nz += (P[a] - P[b]) * (P[a + 1] + P[b + 1]);
    }
    for (let v = s; v < e; v++) { const c = canon[g.vertexPoint[v]] * 3; acc[c] += nx; acc[c + 1] += ny; acc[c + 2] += nz; }
  }
  const out = new Float64Array(g.numVertices * 3);
  for (let v = 0; v < g.numVertices; v++) {
    const c = canon[g.vertexPoint[v]] * 3, l = Math.hypot(acc[c], acc[c + 1], acc[c + 2]) || 1;
    out[v * 3] = acc[c] / l; out[v * 3 + 1] = acc[c + 1] / l; out[v * 3 + 2] = acc[c + 2] / l;
  }
  return out;
}

/** World positions per vertex (3 per vertex) from the points. */
export function vertexPositions(g: Geometry): Float64Array {
  const P = g.P, out = new Float64Array(g.numVertices * 3);
  for (let v = 0; v < g.numVertices; v++) { const p = g.vertexPoint[v] * 3; out[v * 3] = P[p]; out[v * 3 + 1] = P[p + 1]; out[v * 3 + 2] = P[p + 2]; }
  return out;
}

// ---------------------------------------------------------------- islands, tangents, id colours

/**
 * UV islands: triangles connected through corners with the same point and the same uv (union-find over corner keys).
 * Returns the island of each triangle (0..count-1, in order of first appearance).
 */
export function uvIslands(g: Geometry, uv: ArrayLike<number>, tris: ArrayLike<number>): { triIsland: Int32Array; count: number } {
  const nt = Math.floor(tris.length / 3);
  const key = new Map<string, number>();
  const corner = new Int32Array(nt * 3);
  for (let i = 0; i < nt * 3; i++) {
    const v = tris[i];
    const k = `${g.vertexPoint[v]}:${Math.round(uv[v * 2] * 1e6)}:${Math.round(uv[v * 2 + 1] * 1e6)}`;
    let id = key.get(k);
    if (id === undefined) { id = key.size; key.set(k, id); }
    corner[i] = id;
  }
  const parent = new Int32Array(key.size);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const unite = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
  for (let t = 0; t < nt; t++) { unite(corner[t * 3], corner[t * 3 + 1]); unite(corner[t * 3], corner[t * 3 + 2]); }
  const label = new Map<number, number>(), triIsland = new Int32Array(nt);
  for (let t = 0; t < nt; t++) {
    const r = find(corner[t * 3]);
    let l = label.get(r);
    if (l === undefined) { l = label.size; label.set(r, l); }
    triIsland[t] = l;
  }
  return { triIsland, count: label.size };
}

/** Tangent per triangle (unnormalised dP/du from uv) and the handedness sign of (dP/du, dP/dv) against the face normal. */
export function triangleTangents(g: Geometry, uv: ArrayLike<number>, tris: ArrayLike<number>): { T: Float64Array; sign: Float32Array } {
  const nt = Math.floor(tris.length / 3), P = g.P;
  const T = new Float64Array(nt * 3), sign = new Float32Array(nt);
  for (let t = 0; t < nt; t++) {
    const va = tris[t * 3], vb = tris[t * 3 + 1], vc = tris[t * 3 + 2];
    const a = g.vertexPoint[va] * 3, b = g.vertexPoint[vb] * 3, c = g.vertexPoint[vc] * 3;
    const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
    const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
    const du1 = uv[vb * 2] - uv[va * 2], dv1 = uv[vb * 2 + 1] - uv[va * 2 + 1], du2 = uv[vc * 2] - uv[va * 2], dv2 = uv[vc * 2 + 1] - uv[va * 2 + 1];
    const det = du1 * dv2 - du2 * dv1;
    const r = Math.abs(det) > 1e-20 ? 1 / det : 0;
    const tx = (e1x * dv2 - e2x * dv1) * r, ty = (e1y * dv2 - e2y * dv1) * r, tz = (e1z * dv2 - e2z * dv1) * r;
    const bx = (e2x * du1 - e1x * du2) * r, by = (e2y * du1 - e1y * du2) * r, bz = (e2z * du1 - e1z * du2) * r;
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    // (N × T) · B > 0: right-handed
    const cx = ny * tz - nz * ty, cy = nz * tx - nx * tz, cz = nx * ty - ny * tx;
    T[t * 3] = tx; T[t * 3 + 1] = ty; T[t * 3 + 2] = tz;
    sign[t] = cx * bx + cy * by + cz * bz < 0 ? -1 : 1;
  }
  return { T, sign };
}

/** Random colour of an island id (stable per id and seed). */
export function idColor(id: number, seed = 0): [number, number, number] {
  const hsh = hash32(Math.imul(id + 1, 0x9e3779b1) ^ hash32(Math.floor(seed * 7919) + 77));
  const hue = (hsh & 0xffff) / 65536, sat = 0.55 + ((hsh >>> 16) & 0xff) / 255 * 0.4, val = 0.65 + ((hsh >>> 24) & 0xff) / 255 * 0.35;
  const i = Math.floor(hue * 6), f = hue * 6 - i, p = val * (1 - sat), q = val * (1 - f * sat), tt = val * (1 - (1 - f) * sat);
  return ([[val, tt, p], [q, val, p], [p, val, tt], [p, q, val], [tt, p, val], [val, p, q]] as [number, number, number][])[i % 6];
}

// ---------------------------------------------------------------- projection onto a high-res mesh (kernel bake_project)

export interface ProjectArgs {
  /** ray start offset along the normal and the search distance on each side (metres) */
  cage: number;
}

/**
 * For samples [start, end): cast a ray from P + N·cage along -N over 2·cage against the high-res scene and write the
 * signed height of the nearest hit above the low surface (D = cage - t; NaN on a miss) and, when HN (the high mesh's
 * point normals) is given, the hit's interpolated normal into NO (in the low normal's hemisphere).
 */
export function projectRange(a: ProjectArgs, A: Record<string, any>, scene: RayScene, start: number, end: number): void {
  const P: Float64Array = A.P, N: Float64Array = A.N, D: Float64Array = A.D, NO: Float64Array | undefined = A.NO;
  const HN: Float64Array | undefined = A.HN, Tri: Float64Array = A.T, triPt: Int32Array = A.triPt;
  const cage = a.cage;
  for (let i = start; i < end; i++) {
    const nx = N[i * 3], ny = N[i * 3 + 1], nz = N[i * 3 + 2];
    if (!(nx || ny || nz)) { D[i] = NaN; continue; }
    const ox = P[i * 3] + nx * cage, oy = P[i * 3 + 1] + ny * cage, oz = P[i * 3 + 2] + nz * cage;
    const t = scene.nearest(ox, oy, oz, -nx, -ny, -nz, 2 * cage, 0);
    if (!(t < Infinity)) { D[i] = NaN; continue; }
    D[i] = cage - t;
    if (!NO || !HN || !HN.length) continue;
    const tri = scene.lastTri, o = tri * 9;
    const qx = ox - nx * t, qy = oy - ny * t, qz = oz - nz * t;
    // barycentrics of the hit in the triangle
    const e1x = Tri[o + 3] - Tri[o], e1y = Tri[o + 4] - Tri[o + 1], e1z = Tri[o + 5] - Tri[o + 2];
    const e2x = Tri[o + 6] - Tri[o], e2y = Tri[o + 7] - Tri[o + 1], e2z = Tri[o + 8] - Tri[o + 2];
    const px = qx - Tri[o], py = qy - Tri[o + 1], pz = qz - Tri[o + 2];
    const d00 = e1x * e1x + e1y * e1y + e1z * e1z, d01 = e1x * e2x + e1y * e2y + e1z * e2z, d11 = e2x * e2x + e2y * e2y + e2z * e2z;
    const d20 = px * e1x + py * e1y + pz * e1z, d21 = px * e2x + py * e2y + pz * e2z;
    const den = d00 * d11 - d01 * d01 || 1;
    const w1 = (d11 * d20 - d01 * d21) / den, w2 = (d00 * d21 - d01 * d20) / den, w0 = 1 - w1 - w2;
    const pa = triPt[tri * 3] * 3, pb = triPt[tri * 3 + 1] * 3, pc = triPt[tri * 3 + 2] * 3;
    let hx = HN[pa] * w0 + HN[pb] * w1 + HN[pc] * w2, hy = HN[pa + 1] * w0 + HN[pb + 1] * w1 + HN[pc + 1] * w2, hz = HN[pa + 2] * w0 + HN[pb + 2] * w1 + HN[pc + 2] * w2;
    const l = Math.hypot(hx, hy, hz) || 1;
    hx /= l; hy /= l; hz /= l;
    // the high mesh's normals may face the other way (two-sided hit): keep them in the low normal's hemisphere
    if (hx * nx + hy * ny + hz * nz < 0) { hx = -hx; hy = -hy; hz = -hz; }
    NO[i * 3] = hx; NO[i * 3 + 1] = hy; NO[i * 3 + 2] = hz;
  }
}

// ---------------------------------------------------------------- edge curvature (kernel bake_curvature)
//
// Curvature per sample from the mesh's dihedral angles: every edge between two polygons carries its signed bend
// k = ±angle / 90° (+ convex, − concave), and a sample sums k × the edge's length inside a disc of radius r around it,
// weighted by (1 − d²/r²)² and normalised so that a straight edge passing through the sample counts fully:
//   value = Σ k_e ∫_e (1 − |x − p|²/r²)² dx / (16 r / 15)
// A 90° box edge reads 1 on the edge line and fades as (1 − d²/r²)^{5/2} over r; a smooth surface of radius R reads
// about 1.25 r / R (the kernel-averaged mean curvature), flat faces 0. Measured in 3D, so uv seams do not show, and
// edges whose faces both turn away from the sample's normal (the far side of a thin plank) are skipped. Points are
// matched by position, so meshes with split points (hard normals, unwelded boxes) still have their edges found.

export interface CurvatureEdges {
  /** segment endpoints, 6 per edge */
  E: Float64Array;
  /** signed bend per edge: angle / 90°, + convex, − concave */
  K: Float64Array;
  /** the two face normals, 6 per edge */
  FN: Float64Array;
  count: number;
}

/** Edges between two polygons (points matched by position, tolerance `tol`) with a bend of at least minAngle degrees. */
export function curvatureEdges(g: Geometry, tol: number, minAngle = 0.5): CurvatureEdges {
  const P = g.P, np = g.numPoints;
  const canon = new Int32Array(np);
  const ids = new Map<string, number>();
  const q = 1 / Math.max(tol, 1e-12);
  for (let i = 0; i < np; i++) {
    const k = `${Math.round(P[i * 3] * q)},${Math.round(P[i * 3 + 1] * q)},${Math.round(P[i * 3 + 2] * q)}`;
    let id = ids.get(k);
    if (id === undefined) { id = i; ids.set(k, i); }
    canon[i] = id;
  }
  const FNp = primNormals(g);
  const cen = new Float64Array(g.numPrims * 3);
  for (let p = 0; p < g.numPrims; p++) {
    const s = g.primStart[p], e = g.primStart[p + 1];
    for (let v = s; v < e; v++) { const o = g.vertexPoint[v] * 3; cen[p * 3] += P[o]; cen[p * 3 + 1] += P[o + 1]; cen[p * 3 + 2] += P[o + 2]; }
    const c = Math.max(1, e - s);
    cen[p * 3] /= c; cen[p * 3 + 1] /= c; cen[p * 3 + 2] /= c;
  }
  // edge (canonical point pair) → faces using it
  const faces = new Map<number, number[]>();
  const key = (a: number, b: number) => (a < b ? a * np + b : b * np + a);
  for (let p = 0; p < g.numPrims; p++) {
    if (!g.primClosed[p] || g.primSize(p) < 3) continue;
    const s = g.primStart[p], e = g.primStart[p + 1];
    for (let v = s; v < e; v++) {
      const a = canon[g.vertexPoint[v]], b = canon[g.vertexPoint[v + 1 < e ? v + 1 : s]];
      if (a === b) continue;
      const k = key(a, b);
      const l = faces.get(k);
      if (l) l.push(p); else faces.set(k, [p]);
    }
  }
  const E: number[] = [], K: number[] = [], FN: number[] = [];
  const cosMin = Math.cos((minAngle * Math.PI) / 180);
  for (const [k, l] of faces) {
    if (l.length !== 2) continue;
    const f1 = l[0], f2 = l[1];
    const n1x = FNp[f1 * 3], n1y = FNp[f1 * 3 + 1], n1z = FNp[f1 * 3 + 2], n2x = FNp[f2 * 3], n2y = FNp[f2 * 3 + 1], n2z = FNp[f2 * 3 + 2];
    const c = Math.max(-1, Math.min(1, n1x * n2x + n1y * n2y + n1z * n2z));
    if (c > cosMin) continue;
    const dx = cen[f2 * 3] - cen[f1 * 3], dy = cen[f2 * 3 + 1] - cen[f1 * 3 + 1], dz = cen[f2 * 3 + 2] - cen[f1 * 3 + 2];
    // convex when each face's centroid lies below the other face's plane
    const s = (n1x * dx + n1y * dy + n1z * dz) - (n2x * dx + n2y * dy + n2z * dz);
    const a = Math.floor(k / np), b = k - a * np;
    E.push(P[a * 3], P[a * 3 + 1], P[a * 3 + 2], P[b * 3], P[b * 3 + 1], P[b * 3 + 2]);
    K.push((s <= 0 ? 1 : -1) * (Math.acos(c) / (Math.PI / 2)));
    FN.push(n1x, n1y, n1z, n2x, n2y, n2z);
  }
  return { E: Float64Array.from(E), K: Float64Array.from(K), FN: Float64Array.from(FN), count: K.length };
}

export interface EdgeGrid {
  origin: [number, number, number];
  cell: number;
  dims: [number, number, number];
  /** CSR: cell c holds items[start[c] .. start[c + 1]) */
  start: Int32Array;
  items: Int32Array;
}

/** A uniform grid over the edges (each edge listed in every cell its box overlaps); cells at least `minCell` wide. */
export function edgeGrid(e: CurvatureEdges, minCell: number): EdgeGrid {
  const E = e.E, m = e.count;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m * 2; i++) for (let c = 0; c < 3; c++) { const x = E[i * 3 + c]; if (x < lo[c]) lo[c] = x; if (x > hi[c]) hi[c] = x; }
  if (!m) return { origin: [0, 0, 0], cell: 1, dims: [1, 1, 1], start: new Int32Array(2), items: new Int32Array(0) };
  const ext = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], 1e-9);
  const cell = Math.max(minCell, ext / 96);
  const dims: [number, number, number] = [0, 1, 2].map((c) => Math.max(1, Math.floor((hi[c] - lo[c]) / cell) + 1)) as any;
  const cellOf = (x: number, c: number) => Math.min(dims[c] - 1, Math.max(0, Math.floor((x - lo[c]) / cell)));
  const count = new Int32Array(dims[0] * dims[1] * dims[2] + 1);
  const visit = (i: number, f: (c: number) => void) => {
    const o = i * 6;
    const i0 = cellOf(Math.min(E[o], E[o + 3]), 0), i1 = cellOf(Math.max(E[o], E[o + 3]), 0);
    const j0 = cellOf(Math.min(E[o + 1], E[o + 4]), 1), j1 = cellOf(Math.max(E[o + 1], E[o + 4]), 1);
    const k0 = cellOf(Math.min(E[o + 2], E[o + 5]), 2), k1 = cellOf(Math.max(E[o + 2], E[o + 5]), 2);
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let ii = i0; ii <= i1; ii++) f((k * dims[1] + j) * dims[0] + ii);
  };
  for (let i = 0; i < m; i++) visit(i, (c) => count[c + 1]++);
  for (let c = 0; c + 1 < count.length; c++) count[c + 1] += count[c];
  const items = new Int32Array(count[count.length - 1]), fill = count.slice(0, -1);
  for (let i = 0; i < m; i++) visit(i, (c) => { items[fill[c]++] = i; });
  return { origin: [lo[0], lo[1], lo[2]], cell, dims, start: count, items };
}

export interface CurvatureArgs {
  radius: number;
  /** skip edges whose faces both have normal · sample normal below this */
  facing: number;
  origin: [number, number, number];
  cell: number;
  dims: [number, number, number];
}

/** Edge curvature (see above) for samples [start, end): P, N per sample, edges E/K/FN, grid start/items → V. */
export function curvatureRange(a: CurvatureArgs, A: Record<string, any>, start: number, end: number): void {
  const P: Float64Array = A.P, N: Float64Array = A.N, E: Float64Array = A.E, K: Float64Array = A.K, FN: Float64Array = A.FN;
  const CS: Int32Array = A.start, CI: Int32Array = A.items, V: Float64Array = A.V;
  const r = a.radius, r2 = r * r, br = 1 / r2, norm = 15 / (16 * r);
  const [ox, oy, oz] = a.origin, cell = a.cell, [dx, dy, dz] = a.dims;
  const stamp = new Int32Array(K.length);
  const F = (t: number, aa: number) => t * (aa * aa - t * t * ((2 * aa * br) / 3 - (br * br * t * t) / 5));
  for (let i = start; i < end; i++) {
    const px = P[i * 3], py = P[i * 3 + 1], pz = P[i * 3 + 2], nx = N[i * 3], ny = N[i * 3 + 1], nz = N[i * 3 + 2];
    const ci0 = Math.max(0, Math.floor((px - r - ox) / cell)), ci1 = Math.min(dx - 1, Math.floor((px + r - ox) / cell));
    const cj0 = Math.max(0, Math.floor((py - r - oy) / cell)), cj1 = Math.min(dy - 1, Math.floor((py + r - oy) / cell));
    const ck0 = Math.max(0, Math.floor((pz - r - oz) / cell)), ck1 = Math.min(dz - 1, Math.floor((pz + r - oz) / cell));
    let sum = 0;
    for (let ck = ck0; ck <= ck1; ck++)
      for (let cj = cj0; cj <= cj1; cj++)
        for (let ci = ci0; ci <= ci1; ci++) {
          const c = (ck * dy + cj) * dx + ci;
          for (let q = CS[c]; q < CS[c + 1]; q++) {
            const e = CI[q];
            if (stamp[e] === i + 1) continue;
            stamp[e] = i + 1;
            const f = e * 6;
            if (Math.max(nx * FN[f] + ny * FN[f + 1] + nz * FN[f + 2], nx * FN[f + 3] + ny * FN[f + 4] + nz * FN[f + 5]) < a.facing) continue;
            const ax = E[f], ay = E[f + 1], az = E[f + 2];
            let ux = E[f + 3] - ax, uy = E[f + 4] - ay, uz = E[f + 5] - az;
            const L = Math.hypot(ux, uy, uz);
            if (!(L > 0)) continue;
            ux /= L; uy /= L; uz /= L;
            const wx = px - ax, wy = py - ay, wz = pz - az;
            const t0 = wx * ux + wy * uy + wz * uz;
            const d2 = wx * wx + wy * wy + wz * wz - t0 * t0;
            if (d2 >= r2) continue;
            const half = Math.sqrt(r2 - d2);
            const lo = Math.max(-t0, -half), hi = Math.min(L - t0, half);
            if (hi <= lo) continue;
            const aa = 1 - d2 * br;
            sum += K[e] * (F(hi, aa) - F(lo, aa)) * norm;
          }
        }
    V[i] = sum;
  }
}
