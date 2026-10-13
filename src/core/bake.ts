// UV-space baking: rasterise a mesh's triangles into texel space and interpolate per-texel surface data (position,
// normal, attributes, triangle and island ids) for the bake nodes (src/nodes/bake.ts).
//
//   texel (i, j)   centre at u = (i + 0.5) / W, v = 1 - (j + 0.5) / H (core/image.ts conventions)
//   coverage       a texel is covered by the triangle containing its centre; texels whose square only overlaps a
//                  triangle (conservative coverage) take the closest point of the nearest such triangle, so thin
//                  triangles and island borders leave no holes
//   supersample    the bake runs at S × S texels per output texel and averages the covered ones (coverage → mask)
//   padding        uncovered texels within `padding` texels of a covered one copy the nearest covered texel (exact
//                  Euclidean distance transform), so mipmaps and bilinear filtering do not bleed the background
// The ray bakes (ao, thickness, height, normal from a high-res mesh) feed texel positions and normals to the pool
// kernels "occlusion" and "bake_project" (core/kernels.ts).
import type { Geometry } from './geometry.ts';
import { distanceTransform } from './heightfield.ts';
import { RayScene } from './analysis.ts';
import { hash32 } from './random.ts';

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
 * take the closest point on the nearest one.
 */
export function rasterizeUV(uv: ArrayLike<number>, tris: ArrayLike<number>, w: number, h: number, conservative = true): TexelMap {
  const n = w * h, nt = Math.floor(tris.length / 3);
  const tri = new Int32Array(n).fill(-1), b1 = new Float32Array(n), b2 = new Float32Array(n);
  let degenerate = 0, outside = 0;
  const X = (v: number) => uv[v * 2] * w, Y = (v: number) => (1 - uv[v * 2 + 1]) * h;
  const area2 = new Float64Array(nt);
  for (let t = 0; t < nt; t++) {
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
  let covered = 0;
  for (let k = 0; k < n; k++) if (tri[k] >= 0) covered++;
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
    covered = 0;
    for (let k = 0; k < n; k++) if (tri[k] >= 0) covered++;
  }
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

/** Per-texel interpolation of per-vertex values (`size` floats per triangulation vertex index). Uncovered texels stay 0. */
export function interpolate(map: TexelMap, tris: ArrayLike<number>, vals: ArrayLike<number>, size: number, out = new Float32Array(map.w * map.h * size)): Float32Array {
  const { tri, b1, b2 } = map;
  for (let k = 0; k < tri.length; k++) {
    const t = tri[k];
    if (t < 0) continue;
    const w1 = b1[k], w2 = b2[k], w0 = 1 - w1 - w2;
    const a = tris[t * 3] * size, b = tris[t * 3 + 1] * size, c = tris[t * 3 + 2] * size;
    for (let s = 0; s < size; s++) out[k * size + s] = vals[a + s] * w0 + vals[b + s] * w1 + vals[c + s] * w2;
  }
  return out;
}

/** Per-vertex copy of a point, vertex, prim or detail attribute (first `size` components; missing components 0). */
export function vertexValues(g: Geometry, name: string, size: number, vprim?: Int32Array): Float64Array | null {
  const f = g.findAttrib(name, ['vertex', 'point', 'prim', 'detail']);
  if (!f || f.attr.type === 'string' || f.attr.isArray) return null;
  const a = f.attr, d = a.data as Float64Array | Int32Array, s = a.size, nv = g.numVertices;
  const out = new Float64Array(nv * size);
  const vp = f.cls === 'prim' ? vprim ?? g.vertexPrims() : null;
  for (let v = 0; v < nv; v++) {
    const e = f.cls === 'vertex' ? v : f.cls === 'point' ? g.vertexPoint[v] : f.cls === 'prim' ? vp![v] : 0;
    for (let c = 0; c < size; c++) out[v * size + c] = c < s ? d[e * s + c] : 0;
  }
  return out;
}

/** World positions per vertex (3 per vertex) from the points. */
export function vertexPositions(g: Geometry): Float64Array {
  const P = g.P, out = new Float64Array(g.numVertices * 3);
  for (let v = 0; v < g.numVertices; v++) { const p = g.vertexPoint[v] * 3; out[v * 3] = P[p]; out[v * 3 + 1] = P[p + 1]; out[v * 3 + 2] = P[p + 2]; }
  return out;
}

/** Normalise 3-vectors in place (zero vectors stay zero). */
export function normalize3(a: Float32Array | Float64Array): void {
  for (let i = 0; i < a.length; i += 3) {
    const l = Math.hypot(a[i], a[i + 1], a[i + 2]);
    if (l > 0) { a[i] /= l; a[i + 1] /= l; a[i + 2] /= l; }
  }
}

/**
 * UV islands: connected triangles sharing corners with the same point and the same uv (union-find over corner keys).
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
  for (let t = 0; t < nt; t++) {
    const a = find(corner[t * 3]), b = find(corner[t * 3 + 1]), c = find(corner[t * 3 + 2]);
    if (a !== b) parent[b] = a;
    const c2 = find(c), a2 = find(a);
    if (c2 !== a2) parent[c2] = a2;
  }
  const label = new Map<number, number>(), triIsland = new Int32Array(nt);
  for (let t = 0; t < nt; t++) {
    const r = find(corner[t * 3]);
    let l = label.get(r);
    if (l === undefined) { l = label.size; label.set(r, l); }
    triIsland[t] = l;
  }
  return { triIsland, count: label.size };
}

/**
 * Average S × S blocks of a supersampled bake (ch floats per texel) over their covered texels; coverage = the covered
 * fraction of each block. Blocks with no covered texel stay 0.
 */
export function downsample(vals: Float32Array, ch: number, w: number, h: number, s: number, cov: Uint8Array): { vals: Float32Array; coverage: Float32Array } {
  if (s <= 1) {
    const coverage = new Float32Array(w * h);
    for (let k = 0; k < coverage.length; k++) coverage[k] = cov[k];
    return { vals, coverage };
  }
  const W = w / s, H = h / s, out = new Float32Array(W * H * ch), coverage = new Float32Array(W * H);
  const acc = new Float64Array(ch);
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      acc.fill(0);
      let n = 0;
      for (let y = 0; y < s; y++)
        for (let x = 0; x < s; x++) {
          const k = (j * s + y) * w + i * s + x;
          if (!cov[k]) continue;
          n++;
          for (let c = 0; c < ch; c++) acc[c] += vals[k * ch + c];
        }
      const o = j * W + i;
      coverage[o] = n / (s * s);
      if (n) for (let c = 0; c < ch; c++) out[o * ch + c] = acc[c] / n;
    }
  return { vals: out, coverage };
}

/**
 * Padding (edge dilation): every texel with coverage 0 within `padding` texels of a covered texel copies that texel;
 * the rest get `background`. Returns the number of texels filled by padding.
 */
export function dilate(vals: Float32Array, ch: number, w: number, h: number, coverage: Float32Array, padding: number, background: number[]): number {
  const n = w * h;
  let filled = 0;
  const sites = new Uint8Array(n);
  let any = false;
  for (let k = 0; k < n; k++) if (coverage[k] > 0) { sites[k] = 1; any = true; }
  const lim = padding * padding;
  const { d2, nearest } = any && padding > 0 ? distanceTransform(sites, w, h) : { d2: null, nearest: null };
  for (let k = 0; k < n; k++) {
    if (sites[k]) continue;
    if (d2 && nearest && d2[k] <= lim && nearest[k] >= 0) {
      const s = nearest[k];
      for (let c = 0; c < ch; c++) vals[k * ch + c] = vals[s * ch + c];
      filled++;
    } else for (let c = 0; c < ch; c++) vals[k * ch + c] = background[c] ?? 0;
  }
  return filled;
}

/** Tangent per triangle (unnormalised dP/du from uv) and the handedness sign of (dP/du, dP/dv) against the face normal. */
export function triangleTangents(g: Geometry, uv: ArrayLike<number>, tris: ArrayLike<number>): { T: Float64Array; sign: Float32Array } {
  const nt = Math.floor(tris.length / 3), P = g.P;
  const T = new Float64Array(nt * 3), sign = new Float32Array(nt);
  for (let t = 0; t < nt; t++) {
    const va = tris[t * 3], vb = tris[t * 3 + 1], vc = tris[t * 3 + 2];
    const a = g.vertexPoint[va] * 3, b = g.vertexPoint[vb] * 3, c = g.vertexPoint[vc] * 3;
    const e1 = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], e2 = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
    const du1 = uv[vb * 2] - uv[va * 2], dv1 = uv[vb * 2 + 1] - uv[va * 2 + 1], du2 = uv[vc * 2] - uv[va * 2], dv2 = uv[vc * 2 + 1] - uv[va * 2 + 1];
    const det = du1 * dv2 - du2 * dv1;
    const r = Math.abs(det) > 1e-20 ? 1 / det : 0;
    const tx = (e1[0] * dv2 - e2[0] * dv1) * r, ty = (e1[1] * dv2 - e2[1] * dv1) * r, tz = (e1[2] * dv2 - e2[2] * dv1) * r;
    const bx = (e2[0] * du1 - e1[0] * du2) * r, by = (e2[1] * du1 - e1[1] * du2) * r, bz = (e2[2] * du1 - e1[2] * du2) * r;
    const nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
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

// ---------------------------------------------------------------- projection from a high-res mesh (kernel bake_project)

export interface ProjectArgs {
  /** ray start offset along the normal and the search distance on each side (metres) */
  cage: number;
}

/**
 * For texels [start, end): cast a ray from P + N·cage along -N over 2·cage against the high-res scene and write the
 * signed height of the nearest hit above the low surface (cage - t; NaN on a miss) and, when HN (the high mesh's
 * point normals) is given, the hit's interpolated normal into NO.
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
    if (!NO || !HN) continue;
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
