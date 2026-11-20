// Surface measures: the model measured in 3D and stored per texel, so uv seams never show (bake_measure in
// src/nodes/surface.ts, bake_curvature method surface in src/nodes/bake.ts).
//
//   measuring normals  the shading normals (vertex N, else computed with a 60° cusp over points matched by position),
//                      each turned to the side its face faces once the winding is consistent: faces that disagree with
//                      their neighbours turn back to them, and a piece whose authored normals mostly point the other way
//                      turns with them. A closed piece that still faces inward stays so and is reported (an interior
//                      shell inside an outward piece is inward on purpose and is not). A zero or broken normal takes its
//                      face's.
//   pieces             connected through points matched by position, so uv and normal seams do not split them
//   cloud              points over the surface for the ray and curvature measures: one per cell of a grid laid over the
//                      uv atlas every k texels (conservative: a cell that only overlaps a triangle takes the closest point
//                      on it, so thin strips are sampled along their length), so density follows the texel density and
//                      faces packed small get few points; a triangle no cell lands on (an island under a texel) gets
//                      points along its middle. Each point weighs the surface it stands for (its triangle's area over
//                      its points), so slivers count for little and dense charts do not outvote sparse ones.
//   rays               each cloud point casts `samples` cosine-weighted rays over its hemisphere once; occlusion, cavity
//                      and visibility are counts over that one set (each with its own distance limit). Shelter casts
//                      its own cone of rays around its direction in the same pass; the part of the cone behind the
//                      surface is covered and comes from a table (no ray noise on flat faces), the rays in front estimate
//                      the rest. Directions behind the point's flat triangle are left out of every count: on a faceted
//                      convex surface they would hit the neighbouring facets. A point lying flat against the
//                      surroundings is covered.
//   interpolation      a texel sample takes the weighted mean of every cloud point of its own piece within R = 2 × the
//                      local cloud spacing, weight (1 − d²/R²)² × max(0, n·nₚ)⁴ × the point's weight, so values do not
//                      bleed around sharp edges, onto the far side of a thin plate or onto another part; with no weight
//                      it takes the nearest point of its own triangle (every triangle has one)
//   surface curvature  per cloud point p with normal n, over the points q of its own piece within the radius whose
//                      normal turns less than 120° away: c · r · Σ w (n_q − n)·(q − p) / (|q − p|² + ε²) / Σ w, w = (1 − d²/r²)² × the
//                      point's weight, ε = r / 6, c chosen so a 90° edge through the point reads 1 (as bake_curvature's
//                      dihedral bake). A sphere of radius R reads about 1.3 r / R; facets do not show as lines because
//                      the shading normals, not the faces, are read (below one edge length a soft wave of the
//                      interpolated normals remains).
// Radius queries use a uniform grid over the cloud (cloudGrid).
// Every loop over cloud points or texel samples is a range function run by a kernel (core/kernels.ts), so the pool and
// the cooking thread give the same bits.
import type { Geometry } from './geometry.ts';
import { rasterizeUV, vertexPositions } from './bake.ts';
import { bboxDiagonal } from './analysis.ts';
import type { RayScene } from './analysis.ts';
import type { TriBVH } from './spatial.ts';
import { closestScratch } from './spatial.ts';
import { resolveVertexNormals } from './topology.ts';
import { medianTexelSize, triangleTexelSizes } from './texelsize.ts';
import { hash32, hashNumber } from './random.ts';
import { fractal, makeNoise } from './noise.ts';

// ---------------------------------------------------------------- orientation and pieces

export interface Orientation {
  /** per prim: 1 where the measures turn its winding */
  flip: Uint8Array;
  /** per prim: its piece (connected through points matched by position); -1 for prims that are not polygons */
  piece: Int32Array;
  pieces: number;
  /** prims whose winding the measures turn */
  turned: number[];
  /** the first prim of each closed piece that faces inward and is measured so */
  inward: number[];
  /** canonical point per point (points matched by position) */
  canon: Int32Array;
}

/** Canonical point per point: the first point at the same position (quantised to tol). */
export function weldPoints(P: ArrayLike<number>, np: number, tol: number): Int32Array {
  const canon = new Int32Array(np), ids = new Map<string, number>(), q = 1 / Math.max(tol, 1e-12);
  for (let i = 0; i < np; i++) {
    const k = `${Math.round(P[i * 3] * q)},${Math.round(P[i * 3 + 1] * q)},${Math.round(P[i * 3 + 2] * q)}`;
    let id = ids.get(k);
    if (id === undefined) { id = i; ids.set(k, i); }
    canon[i] = id;
  }
  return canon;
}

/**
 * How the measures orient the mesh (see the header): consistent winding per edge-connected patch (the side most of its
 * area faces wins), then a patch whose authored vertex normals (`authoredN`, per vertex, or null) mostly point against
 * its faces turns with them; closed pieces that still face inward, and lie inside no outward piece, are reported.
 */
export function measureOrientation(g: Geometry, tol: number, authoredN: Float64Array | null): Orientation {
  const np = g.numPoints, nprim = g.numPrims, P = g.P, vp = g.vertexPoint;
  const canon = weldPoints(P, np, tol);
  const poly = (p: number) => g.primClosed[p] && g.primStart[p + 1] - g.primStart[p] >= 3;
  // pieces: union of the canonical points of every polygon
  const parent = new Int32Array(np);
  for (let i = 0; i < np; i++) parent[i] = i;
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let p = 0; p < nprim; p++) {
    if (!poly(p)) continue;
    const s = g.primStart[p], r0 = find(canon[vp[s]]);
    for (let v = s + 1; v < g.primStart[p + 1]; v++) { const r = find(canon[vp[v]]); if (r !== r0) parent[r] = r0; }
  }
  const piece = new Int32Array(nprim).fill(-1), label = new Map<number, number>();
  for (let p = 0; p < nprim; p++) {
    if (!poly(p)) continue;
    const r = find(canon[vp[g.primStart[p]]]);
    let l = label.get(r);
    if (l === undefined) { l = label.size; label.set(r, l); }
    piece[p] = l;
  }
  const pieces = label.size;
  // edges (canonical point pairs) → [prim, runs from the lower point to the higher] per side
  const sides = new Map<number, number[]>();
  for (let p = 0; p < nprim; p++) {
    if (!poly(p)) continue;
    const s = g.primStart[p], e = g.primStart[p + 1];
    for (let v = s; v < e; v++) {
      const a = canon[vp[v]], b = canon[vp[v + 1 < e ? v + 1 : s]];
      if (a === b) continue;
      const k = a < b ? a * np + b : b * np + a;
      let l = sides.get(k);
      if (!l) { l = []; sides.set(k, l); }
      l.push(p, a < b ? 1 : 0);
    }
  }
  const adj: number[][] = Array.from({ length: nprim }, () => []);
  const open = new Uint8Array(pieces);
  for (const l of sides.values()) {
    if (l.length === 4 && l[0] !== l[2]) {
      const turn = l[1] === l[3] ? 1 : 0; // both run the edge the same way: one of them is turned
      adj[l[0]].push(l[2], turn); adj[l[2]].push(l[0], turn);
    } else if (l.length === 2) open[piece[l[0]]] = 1;
    else for (let i = 0; i < l.length; i += 2) open[piece[l[i]]] = 1;
  }
  // area-weighted normal (Newell) and fan volume per polygon, as authored
  const nrm = new Float64Array(nprim * 3), area = new Float64Array(nprim), vol = new Float64Array(nprim);
  for (let p = 0; p < nprim; p++) {
    if (!poly(p)) continue;
    const s = g.primStart[p], e = g.primStart[p + 1];
    let nx = 0, ny = 0, nz = 0;
    for (let v = s; v < e; v++) {
      const a = vp[v] * 3, b = vp[v + 1 < e ? v + 1 : s] * 3;
      nx += (P[a + 1] - P[b + 1]) * (P[a + 2] + P[b + 2]);
      ny += (P[a + 2] - P[b + 2]) * (P[a] + P[b]);
      nz += (P[a] - P[b]) * (P[a + 1] + P[b + 1]);
    }
    nrm[p * 3] = nx; nrm[p * 3 + 1] = ny; nrm[p * 3 + 2] = nz;
    area[p] = Math.hypot(nx, ny, nz) / 2;
    const a = vp[s] * 3;
    for (let v = s + 1; v + 1 < e; v++) {
      const b = vp[v] * 3, d = vp[v + 1] * 3;
      vol[p] += P[a] * (P[b + 1] * P[d + 2] - P[b + 2] * P[d + 1]) - P[a + 1] * (P[b] * P[d + 2] - P[b + 2] * P[d]) + P[a + 2] * (P[b] * P[d + 1] - P[b + 1] * P[d]);
    }
  }
  // consistent winding per patch, the side most of its area faces winning
  const flip = new Uint8Array(nprim), seen = new Uint8Array(nprim);
  for (let f = 0; f < nprim; f++) {
    if (!poly(f) || seen[f]) continue;
    const members = [f];
    seen[f] = 1;
    for (let i = 0; i < members.length; i++) {
      const x = members[i], a = adj[x];
      for (let j = 0; j < a.length; j += 2) {
        const y = a[j];
        if (seen[y]) continue;
        seen[y] = 1; flip[y] = flip[x] ^ a[j + 1];
        members.push(y);
      }
    }
    let kept = 0, turned = 0;
    for (const m of members) { if (flip[m]) turned += area[m]; else kept += area[m]; }
    let invert = turned > kept;
    // authored normals that mostly point against the patch's faces turn it with them
    if (authoredN) {
      let vote = 0;
      for (const m of members) {
        const sgn = (flip[m] ^ (invert ? 1 : 0)) ? -1 : 1;
        let ax = 0, ay = 0, az = 0;
        for (let v = g.primStart[m]; v < g.primStart[m + 1]; v++) {
          const x = authoredN[v * 3], y = authoredN[v * 3 + 1], z = authoredN[v * 3 + 2];
          if (Number.isFinite(x + y + z)) { ax += x; ay += y; az += z; }
        }
        vote += sgn * (ax * nrm[m * 3] + ay * nrm[m * 3 + 1] + az * nrm[m * 3 + 2]);
      }
      if (vote < 0) invert = !invert;
    }
    if (invert) for (const m of members) flip[m] ^= 1;
  }
  const turned: number[] = [];
  for (let p = 0; p < nprim; p++) if (flip[p]) turned.push(p);
  // closed pieces that face inward and lie inside no outward closed piece
  const pv = new Float64Array(pieces), first = new Int32Array(pieces).fill(-1);
  const lo = new Float64Array(pieces * 3).fill(Infinity), hi = new Float64Array(pieces * 3).fill(-Infinity);
  for (let p = 0; p < nprim; p++) {
    const c = piece[p];
    if (c < 0) continue;
    if (first[c] < 0) first[c] = p;
    pv[c] += flip[p] ? -vol[p] : vol[p];
    for (let v = g.primStart[p]; v < g.primStart[p + 1]; v++) {
      const o = vp[v] * 3;
      for (let k = 0; k < 3; k++) { if (P[o + k] < lo[c * 3 + k]) lo[c * 3 + k] = P[o + k]; if (P[o + k] > hi[c * 3 + k]) hi[c * 3 + k] = P[o + k]; }
    }
  }
  const within = (c: number, o: number) => {
    for (let k = 0; k < 3; k++) if (lo[c * 3 + k] < lo[o * 3 + k] || hi[c * 3 + k] > hi[o * 3 + k]) return false;
    return true;
  };
  const inward: number[] = [];
  for (let c = 0; c < pieces; c++) {
    if (open[c] || !(pv[c] < 0)) continue;
    let nested = false;
    for (let o = 0; o < pieces && !nested; o++) if (o !== c && !open[o] && pv[o] > 0 && within(c, o)) nested = true;
    if (!nested) inward.push(first[c]);
  }
  return { flip, piece, pieces, turned, inward, canon };
}

/**
 * Computed shading normals per vertex for a mesh without N: the area-weighted mean of the oriented face normals around
 * the vertex's point, points matched by position (so a uv seam that split the points does not split the normal), over
 * the faces within `cuspDeg` of the vertex's own face (so hard edges stay hard).
 */
export function smoothNormals(g: Geometry, o: Orientation, cuspDeg: number): Float64Array {
  const P = g.P, vp = g.vertexPoint, np = g.numPoints, nprim = g.numPrims, canon = o.canon;
  const fn = new Float64Array(nprim * 3), area = new Float64Array(nprim);
  for (let p = 0; p < nprim; p++) {
    const s = g.primStart[p], e = g.primStart[p + 1];
    if (!g.primClosed[p] || e - s < 3) continue;
    let nx = 0, ny = 0, nz = 0;
    for (let v = s; v < e; v++) {
      const a = vp[v] * 3, b = vp[v + 1 < e ? v + 1 : s] * 3;
      nx += (P[a + 1] - P[b + 1]) * (P[a + 2] + P[b + 2]);
      ny += (P[a + 2] - P[b + 2]) * (P[a] + P[b]);
      nz += (P[a] - P[b]) * (P[a + 1] + P[b + 1]);
    }
    const h = Math.hypot(nx, ny, nz), sg = o.flip[p] ? -1 : 1;
    if (h > 0) { fn[p * 3] = (sg * nx) / h; fn[p * 3 + 1] = (sg * ny) / h; fn[p * 3 + 2] = (sg * nz) / h; }
    area[p] = h / 2;
  }
  // prims around each canonical point (CSR)
  const start = new Int32Array(np + 1);
  for (let p = 0; p < nprim; p++) for (let v = g.primStart[p]; v < g.primStart[p + 1]; v++) start[canon[vp[v]] + 1]++;
  for (let i = 0; i < np; i++) start[i + 1] += start[i];
  const fill = start.slice(0, np), list = new Int32Array(start[np]);
  for (let p = 0; p < nprim; p++) for (let v = g.primStart[p]; v < g.primStart[p + 1]; v++) list[fill[canon[vp[v]]]++] = p;
  const cosT = Math.cos((cuspDeg * Math.PI) / 180), out = new Float64Array(g.numVertices * 3);
  for (let p = 0; p < nprim; p++) {
    const fx = fn[p * 3], fy = fn[p * 3 + 1], fz = fn[p * 3 + 2];
    for (let v = g.primStart[p]; v < g.primStart[p + 1]; v++) {
      const c = canon[vp[v]];
      let ax = 0, ay = 0, az = 0, last = -1;
      for (let k = start[c]; k < start[c + 1]; k++) {
        const q = list[k];
        if (q === last) continue; // a prim listed twice at one point (a collapsed corner)
        last = q;
        const qx = fn[q * 3], qy = fn[q * 3 + 1], qz = fn[q * 3 + 2];
        if (q === p || fx * qx + fy * qy + fz * qz >= cosT) { const w = area[q] + 1e-12; ax += qx * w; ay += qy * w; az += qz * w; }
      }
      const l = Math.hypot(ax, ay, az);
      if (l > 0) { out[v * 3] = ax / l; out[v * 3 + 1] = ay / l; out[v * 3 + 2] = az / l; }
    }
  }
  return out;
}

/** Authored normals per vertex (vertex N, else point N), or null when the mesh has none. */
export function authoredNormals(g: Geometry): Float64Array | null {
  const vN = g.vertices.get('N'), pN = g.points.get('N');
  const src = vN && vN.size === 3 && vN.type === 'float' ? { d: vN.data as Float64Array, pt: false } : pN && pN.size === 3 && pN.type === 'float' ? { d: pN.data as Float64Array, pt: true } : null;
  if (!src) return null;
  const out = new Float64Array(g.numVertices * 3);
  for (let v = 0; v < g.numVertices; v++) {
    const i = (src.pt ? g.vertexPoint[v] : v) * 3;
    out[v * 3] = src.d[i]; out[v * 3 + 1] = src.d[i + 1]; out[v * 3 + 2] = src.d[i + 2];
  }
  return out;
}

/**
 * Measuring normals per vertex: the shading normals `shading` (unit, per vertex) turned, where they point against
 * their face once the face is oriented (`o.flip`), to the face's side. `turned` counts the vertices that turned.
 */
export function measureNormals(g: Geometry, o: Orientation, shading: Float64Array): { VN: Float64Array; turned: number } {
  const P = g.P, vp = g.vertexPoint, VN = new Float64Array(shading.length);
  let turned = 0;
  for (let p = 0; p < g.numPrims; p++) {
    const s = g.primStart[p], e = g.primStart[p + 1];
    let nx = 0, ny = 0, nz = 0;
    if (g.primClosed[p] && e - s >= 3) {
      for (let v = s; v < e; v++) {
        const a = vp[v] * 3, b = vp[v + 1 < e ? v + 1 : s] * 3;
        nx += (P[a + 1] - P[b + 1]) * (P[a + 2] + P[b + 2]);
        ny += (P[a + 2] - P[b + 2]) * (P[a] + P[b]);
        nz += (P[a] - P[b]) * (P[a + 1] + P[b + 1]);
      }
      if (o.flip[p]) { nx = -nx; ny = -ny; nz = -nz; }
    }
    const fl = Math.hypot(nx, ny, nz);
    for (let v = s; v < e; v++) {
      let x = shading[v * 3], y = shading[v * 3 + 1], z = shading[v * 3 + 2];
      // a zero or broken shading normal: the face's own
      if (!(Math.abs(x) + Math.abs(y) + Math.abs(z) > 0) && fl > 0) { x = nx / fl; y = ny / fl; z = nz / fl; }
      else if (x * nx + y * ny + z * nz < 0) { x = -x; y = -y; z = -z; turned++; }
      VN[v * 3] = x; VN[v * 3 + 1] = y; VN[v * 3 + 2] = z;
    }
  }
  return { VN, turned };
}

// ---------------------------------------------------------------- the cloud

export interface Cloud {
  n: number;
  /** positions and unit measuring normals, 3 per point */
  P: Float64Array;
  N: Float64Array;
  /** triangle and piece of each point */
  tri: Int32Array;
  piece: Int32Array;
  /**
   * the surface each point stands for, relative to the local spacing²: its triangle's area over its points, at most 4. A
   * sliver (a decimated mesh has them, with normals that do not fit the surface around them) weighs almost nothing,
   * and the estimates do not depend on how dense the atlas packs a chart
   */
  wt: Float32Array;
  /** CSR: the points of triangle t are pts[start[t] .. start[t + 1]) */
  start: Int32Array;
  pts: Int32Array;
  /** grid cells across the atlas */
  cols: number;
  rows: number;
}

export interface CloudInput {
  uv: ArrayLike<number>;
  tris: ArrayLike<number>;
  /** triangles left out (not baked), or null */
  skip: Uint8Array | null;
  /** the atlas in texels and the grid step in texels */
  W: number;
  H: number;
  k: number;
  /** positions and measuring normals per vertex */
  VP: ArrayLike<number>;
  VN: ArrayLike<number>;
  triPiece: Int32Array;
  /** local cloud spacing per triangle (metres) */
  triL: Float64Array;
}

/** Points over the surface (see the header): a grid every k texels over the uv atlas, then points on every triangle no cell landed on. */
export function buildCloud(o: CloudInput): Cloud {
  const { uv, tris, skip, VP, VN } = o;
  const nt = Math.floor(tris.length / 3);
  const cols = Math.max(1, Math.round(o.W / o.k)), rows = Math.max(1, Math.round(o.H / o.k));
  const map = rasterizeUV(uv, tris, cols, rows, true, skip);
  const T: number[] = [], B1: number[] = [], B2: number[] = [];
  const has = new Uint8Array(nt);
  for (let c = 0; c < map.tri.length; c++) {
    const t = map.tri[c];
    if (t < 0) continue;
    T.push(t); B1.push(map.b1[c]); B2.push(map.b2[c]);
    has[t] = 1;
  }
  // triangles no cell landed on (small, thin, or with no uv area): points along the middle of the longest edge's strip
  for (let t = 0; t < nt; t++) {
    if (has[t] || (skip && skip[t])) continue;
    const c0 = tris[t * 3] * 3, c1 = tris[t * 3 + 1] * 3, c2 = tris[t * 3 + 2] * 3;
    const len = (a: number, b: number) => Math.hypot(VP[a] - VP[b], VP[a + 1] - VP[b + 1], VP[a + 2] - VP[b + 2]);
    const l01 = len(c0, c1), l12 = len(c1, c2), l20 = len(c2, c0);
    // corners A, B of the longest edge and C opposite, as barycentric slots (0: corner 0, 1: corner 1, 2: corner 2)
    const [A, Bc, C, L] = l01 >= l12 && l01 >= l20 ? [0, 1, 2, l01] : l12 >= l20 ? [1, 2, 0, l12] : [2, 0, 1, l20];
    const m = Math.max(1, Math.min(64, Math.round(L / (o.triL[t] || L || 1))));
    for (let j = 0; j < m; j++) {
      const f = (j + 0.5) / m, w = [0, 0, 0];
      w[A] = (2 / 3) * (1 - f); w[Bc] = (2 / 3) * f; w[C] = 1 / 3;
      T.push(t); B1.push(w[1]); B2.push(w[2]);
    }
  }
  const n = T.length;
  const P = new Float64Array(n * 3), N = new Float64Array(n * 3), tri = Int32Array.from(T), piece = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const t = T[i], w1 = B1[i], w2 = B2[i], w0 = 1 - w1 - w2;
    const a = tris[t * 3] * 3, b = tris[t * 3 + 1] * 3, c = tris[t * 3 + 2] * 3;
    let nx = 0, ny = 0, nz = 0;
    for (let q = 0; q < 3; q++) P[i * 3 + q] = VP[a + q] * w0 + VP[b + q] * w1 + VP[c + q] * w2;
    nx = VN[a] * w0 + VN[b] * w1 + VN[c] * w2; ny = VN[a + 1] * w0 + VN[b + 1] * w1 + VN[c + 1] * w2; nz = VN[a + 2] * w0 + VN[b + 2] * w1 + VN[c + 2] * w2;
    const l = Math.hypot(nx, ny, nz);
    if (l > 0) { N[i * 3] = nx / l; N[i * 3 + 1] = ny / l; N[i * 3 + 2] = nz / l; }
    piece[i] = o.triPiece[t];
  }
  const start = new Int32Array(nt + 1);
  for (let i = 0; i < n; i++) start[tri[i] + 1]++;
  for (let t = 0; t < nt; t++) start[t + 1] += start[t];
  const fill = start.slice(0, nt), pts = new Int32Array(n);
  for (let i = 0; i < n; i++) pts[fill[tri[i]]++] = i;
  const wt = new Float32Array(n);
  for (let t = 0; t < nt; t++) {
    const m = start[t + 1] - start[t];
    if (!m) continue;
    const a = tris[t * 3] * 3, b = tris[t * 3 + 1] * 3, c = tris[t * 3 + 2] * 3;
    const ux = VP[b] - VP[a], uy = VP[b + 1] - VP[a + 1], uz = VP[b + 2] - VP[a + 2], vx = VP[c] - VP[a], vy = VP[c + 1] - VP[a + 1], vz = VP[c + 2] - VP[a + 2];
    const area = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx), l = o.triL[t];
    const w = l > 0 ? Math.min(4, area / (m * l * l)) : 1;
    for (let k = start[t]; k < start[t + 1]; k++) wt[pts[k]] = w;
  }
  return { n, P, N, tri, piece, wt, start, pts, cols, rows };
}

// ---------------------------------------------------------------- rays (kernel surface_rays)

/** A face whose rays escape this share or more (cosine-weighted) counts as fully seen (visibility). */
export const OPEN_SHARE = 0.25;

export interface HemiMeasure {
  kind: 'occlusion' | 'cavity' | 'visibility';
  /** hits farther than this do not count (0 = unlimited) */
  maxD: number;
}

export interface ConeMeasure {
  /** unit direction the cone is around and the cosine of its half-angle */
  dir: [number, number, number];
  cos: number;
  maxD: number;
}

export interface SurfaceRayArgs {
  samples: number;
  /** ray start offset along the normal (metres) */
  bias: number;
  seed: number;
  hemi: HemiMeasure[];
  cones: ConeMeasure[];
  /** a point within this of the surroundings (contact BVH), on a face parallel to its own, is covered (0 = no test) */
  contact: number;
}

const popcount = (m: number) => { let c = 0; while (m) { c++; m &= m - 1; } return c; };

const BEHIND_STEPS = 1024;
/**
 * Share of a cone (uniform over its solid angle, half-angle cosine `cosA`) lying behind a surface whose normal makes
 * cosine c with the cone axis, tabulated over c in [-1, 1] (BEHIND_STEPS + 1 entries; read with behindShare). Exact up
 * to the integration over the cone's polar angle, so flat faces get no ray noise from it.
 */
function behindTable(cosA: number): Float64Array {
  const tab = new Float64Array(BEHIND_STEPS + 1), K = 256;
  for (let e = 0; e <= BEHIND_STEPS; e++) {
    const c = -1 + (2 * e) / BEHIND_STEPS, sn = Math.sqrt(Math.max(0, 1 - c * c));
    let sum = 0;
    for (let k = 0; k < K; k++) {
      const ct = cosA + ((1 - cosA) * (k + 0.5)) / K, st = Math.sqrt(Math.max(0, 1 - ct * ct));
      // direction (st cos φ, st sin φ, ct) is behind when sn st cos φ + c ct ≤ 0
      if (sn * st < 1e-12) { sum += c * ct <= 0 ? 1 : 0; continue; }
      const x = (-c * ct) / (sn * st);
      sum += x >= 1 ? 1 : x <= -1 ? 0 : 1 - Math.acos(x) / Math.PI;
    }
    tab[e] = sum / K;
  }
  return tab;
}

function behindShare(tab: Float64Array, c: number): number {
  const x = ((c < -1 ? -1 : c > 1 ? 1 : c) + 1) * 0.5 * BEHIND_STEPS, i = Math.min(BEHIND_STEPS - 1, Math.floor(x)), f = x - i;
  return tab[i] * (1 - f) + tab[i + 1] * f;
}

/**
 * Ray measures for cloud points [start, end): A.P, A.N (positions, unit normals), A.V out (hemi.length + cones.length
 * values per point, hemisphere measures first). Occlusion 1 = open, cavity 1 = in a crevice, visibility 1 = seen from
 * outside (escaped share over OPEN_SHARE, at most 1), shelter 1 = the whole cone covered.
 */
export function surfaceRaysRange(a: SurfaceRayArgs, A: Record<string, any>, scene: RayScene, contact: TriBVH | null, start: number, end: number): void {
  const P: Float64Array = A.P, N: Float64Array = A.N, V: Float32Array = A.V, FN: Float32Array | undefined = A.FN;
  const d3 = new Float64Array(3);
  const nh = a.hemi.length, nc = a.cones.length, m = nh + nc;
  const S = Math.max(1, Math.floor(a.samples));
  const seedH = hash32(hashNumber(a.seed) ^ 0x2c1b3c6d);
  let tmaxH = 0;
  for (const h of a.hemi) tmaxH = Math.max(tmaxH, h.maxD > 0 ? h.maxD : Infinity);
  const D = new Float64Array(96), ID = new Float64Array(96), best = new Float64Array(32), acc = new Float64Array(Math.max(1, nh));
  const U1 = new Float64Array(S), U2 = new Float64Array(S);
  for (let s = 0; s < S; s++) { U1[s] = (s + 0.5) / S; U2[s] = (s * 0.6180339887498949) % 1; }
  const cs = closestScratch();
  // per cone: its tangent frame
  const frames = a.cones.map((c) => frame(c.dir[0], c.dir[1], c.dir[2]));
  const behind = a.cones.map((c) => behindTable(c.cos));
  const empty = scene.empty;
  for (let i = start; i < end; i++) {
    const nx = N[i * 3], ny = N[i * 3 + 1], nz = N[i * 3 + 2], px = P[i * 3], py = P[i * 3 + 1], pz = P[i * 3 + 2];
    const o = i * m;
    if (!(nx || ny || nz)) {
      // no normal (a collapsed triangle): open
      for (let j = 0; j < nh; j++) V[o + j] = a.hemi[j].kind === 'cavity' ? 0 : 1;
      for (let j = 0; j < nc; j++) V[o + nh + j] = 0;
      continue;
    }
    // pressed flat against the surroundings: covered from every side
    if (contact && a.contact > 0) {
      const t = contact.closestInto(px, py, pz, a.contact, cs);
      if (t >= 0) {
        const T = contact.T, q = t * 9;
        const ux = T[q + 3] - T[q], uy = T[q + 4] - T[q + 1], uz = T[q + 5] - T[q + 2], wx = T[q + 6] - T[q], wy = T[q + 7] - T[q + 1], wz = T[q + 8] - T[q + 2];
        const cx = uy * wz - uz * wy, cy = uz * wx - ux * wz, cz = ux * wy - uy * wx, cl = Math.hypot(cx, cy, cz);
        if (cl > 0 && Math.abs(cx * nx + cy * ny + cz * nz) >= 0.7 * cl) {
          for (let j = 0; j < nh; j++) V[o + j] = a.hemi[j].kind === 'cavity' ? 1 : 0;
          for (let j = 0; j < nc; j++) V[o + nh + j] = 1;
          continue;
        }
      }
    }
    const ox = px + nx * a.bias, oy = py + ny * a.bias, oz = pz + nz * a.bias;
    const h1 = hash32(Math.imul(i, 0x9e3779b1) ^ seedH), h2 = hash32(h1 ^ 0x68e31da4);
    // The flat triangle under the point: a direction in front of the smooth normal but behind the triangle would hit
    // the triangle's own neighbours on a faceted convex surface (the shadow terminator), so it is left out of the count.
    let fx = 0, fy = 0, fz = 0;
    if (FN) { fx = FN[i * 3]; fy = FN[i * 3 + 1]; fz = FN[i * 3 + 2]; }
    // hemisphere: cosine-weighted rays, nearest hit per ray, packets of 32 from one origin
    if (nh) {
      acc.fill(0);
      const f = frame(nx, ny, nz);
      const a1 = h1 / 4294967296, a2 = h2 / 4294967296;
      const dir = (s: number, out: Float64Array) => {
        let u1 = U1[s] + a1, u2 = U2[s] + a2;
        if (u1 >= 1) u1 -= 1;
        if (u2 >= 1) u2 -= 1;
        const st = Math.sqrt(u1), ct = Math.sqrt(Math.max(0, 1 - st * st)), phi = 2 * Math.PI * u2;
        const cx = st * Math.cos(phi), cy = st * Math.sin(phi);
        out[0] = f[0] * cx + f[3] * cy + nx * ct; out[1] = f[1] * cx + f[4] * cy + ny * ct; out[2] = f[2] * cx + f[5] * cy + nz * ct;
      };
      // keep the facet test only when some rays pass it
      let facet = fx !== 0 || fy !== 0 || fz !== 0;
      if (facet) {
        let ok = 0;
        for (let s = 0; s < S && !ok; s++) { dir(s, d3); if (d3[0] * fx + d3[1] * fy + d3[2] * fz > 0) ok++; }
        facet = ok > 0;
      }
      let valid = 0, cnt = 0;
      const flush = () => {
        if (!cnt) return;
        if (empty) for (let k = 0; k < cnt; k++) best[k] = Infinity;
        else scene.nearestPacket(ox, oy, oz, D, ID, cnt, tmaxH, best);
        for (let k = 0; k < cnt; k++) {
          const t = best[k];
          if (!(t < Infinity)) continue;
          for (let j = 0; j < nh; j++) {
            const h = a.hemi[j], lim = h.maxD > 0 ? h.maxD : Infinity;
            if (!(t < lim)) continue;
            acc[j] += h.kind === 'cavity' ? 1 - t / lim : 1;
          }
        }
        cnt = 0;
      };
      for (let s = 0; s < S; s++) {
        dir(s, d3);
        if (facet && d3[0] * fx + d3[1] * fy + d3[2] * fz <= 0) continue;
        valid++;
        setRay(D, ID, cnt++, d3[0], d3[1], d3[2]);
        if (cnt === 32) flush();
      }
      flush();
      for (let j = 0; j < nh; j++) {
        const h = a.hemi[j], share = acc[j] / valid;
        V[o + j] = h.kind === 'occlusion' ? 1 - share : h.kind === 'cavity' ? share : Math.min(1, (1 - share) / OPEN_SHARE);
      }
    }
    // cones: uniform over the cap around each direction. The share behind the surface is covered by it and comes from
    // the table; the rays in front estimate how much of the rest is covered.
    for (let j = 0; j < nc; j++) {
      const c = a.cones[j], fr = frames[j], lim = c.maxD > 0 ? c.maxD : Infinity;
      const g1 = hash32(h2 ^ Math.imul(j + 1, 0x85ebca6b)), g2 = hash32(g1 ^ 0x27d4eb2f);
      const b1 = g1 / 4294967296, b2 = g2 / 4294967296;
      const back = behindShare(behind[j], nx * c.dir[0] + ny * c.dir[1] + nz * c.dir[2]);
      let hits = 0, front = 0, cnt = 0;
      const flush = () => { if (cnt) { front += cnt; hits += empty ? 0 : popcount(scene.occludedPacket(ox, oy, oz, D, ID, cnt, lim)); cnt = 0; } };
      for (let s = 0; s < S; s++) {
        let u1 = U1[s] + b1, u2 = U2[s] + b2;
        if (u1 >= 1) u1 -= 1;
        if (u2 >= 1) u2 -= 1;
        const ct = 1 - u1 * (1 - c.cos), st = Math.sqrt(Math.max(0, 1 - ct * ct)), phi = 2 * Math.PI * u2;
        const cx = st * Math.cos(phi), cy = st * Math.sin(phi);
        const dx = fr[0] * cx + fr[3] * cy + c.dir[0] * ct, dy = fr[1] * cx + fr[4] * cy + c.dir[1] * ct, dz = fr[2] * cx + fr[5] * cy + c.dir[2] * ct;
        if (dx * nx + dy * ny + dz * nz <= 0) continue;
        if (dx * fx + dy * fy + dz * fz < 0) continue;
        setRay(D, ID, cnt++, dx, dy, dz);
        if (cnt === 32) flush();
      }
      flush();
      V[o + nh + j] = back + (1 - back) * (front ? hits / front : 0);
    }
  }
}

/** Two unit tangents (t, b) perpendicular to the unit vector n: [tx, ty, tz, bx, by, bz]. */
function frame(nx: number, ny: number, nz: number): number[] {
  let tx: number, ty: number, tz: number;
  if (Math.abs(nx) < 0.9) { tx = 0; ty = nz; tz = -ny; } else { tx = -nz; ty = 0; tz = nx; }
  const tl = Math.hypot(tx, ty, tz);
  tx /= tl; ty /= tl; tz /= tl;
  return [tx, ty, tz, ny * tz - nz * ty, nz * tx - nx * tz, nx * ty - ny * tx];
}

function setRay(D: Float64Array, ID: Float64Array, k: number, dx: number, dy: number, dz: number) {
  D[k * 3] = dx; D[k * 3 + 1] = dy; D[k * 3 + 2] = dz;
  // a zero component would give 0 * Infinity = NaN in the slab test: a huge finite inverse instead
  ID[k * 3] = 1 / (dx || 1e-300); ID[k * 3 + 1] = 1 / (dy || 1e-300); ID[k * 3 + 2] = 1 / (dz || 1e-300);
}

// ---------------------------------------------------------------- surface curvature (kernel surface_curvature)

/** ε of the surface curvature, as a fraction of the radius. */
const CURV_EPS = 1 / 6;

/**
 * The calibration c of the surface curvature: a 90° edge through the point, the two faces sampled evenly, reads 1.
 * Over the half-disc of the other face (n_q − n)·(q − p) = ρ sin φ, so the mean is 6 J / (π r²) with
 * J = ∫₀ʳ (1 − ρ²/r²)² ρ² / (ρ² + ε²) dρ, and c = π r / (6 J) (r = 1 here; Simpson's rule).
 */
export const CURVATURE_SCALE = (() => {
  const steps = 4000, e2 = CURV_EPS * CURV_EPS;
  const f = (x: number) => (1 - x * x) ** 2 * x * x / (x * x + e2);
  let s = f(0) + f(1);
  for (let i = 1; i < steps; i++) s += f(i / steps) * (i % 2 ? 4 : 2);
  const J = s / (3 * steps);
  return Math.PI / (6 * J);
})();

export interface CurvatureCloudArgs {
  radius: number;
}

/**
 * Surface curvature (see the header) of cloud points [start, end): shared A.CP, A.CN (positions, normals), A.CPiece
 * (connected part: only points of the same part count) and the cloud grid A.GH, A.GS, A.GI, A.GP (cloudGrid); A.V out.
 */
export function surfaceCurvatureRange(a: CurvatureCloudArgs, A: Record<string, any>, start: number, end: number): void {
  const P: Float64Array = A.CP, N: Float64Array = A.CN, CW: Float32Array = A.CW, V: Float32Array = A.V;
  const PC: Int32Array | undefined = A.CPiece;
  const GH: Float64Array = A.GH, GS: Int32Array = A.GS, GI: Int32Array = A.GI, GP: Float64Array = A.GP;
  const ox = GH[0], oy = GH[1], oz = GH[2], h = GH[3], gx = GH[4], gy = GH[5], gz = GH[6];
  const r = a.radius, r2 = r * r, e2 = (CURV_EPS * r) ** 2, scale = CURVATURE_SCALE * r;
  for (let i = start; i < end; i++) {
    const px = P[i * 3], py = P[i * 3 + 1], pz = P[i * 3 + 2], nx = N[i * 3], ny = N[i * 3 + 1], nz = N[i * 3 + 2];
    const x0 = Math.max(0, Math.floor((px - r - ox) / h)), x1 = Math.min(gx - 1, Math.floor((px + r - ox) / h));
    const y0 = Math.max(0, Math.floor((py - r - oy) / h)), y1 = Math.min(gy - 1, Math.floor((py + r - oy) / h));
    const z0 = Math.max(0, Math.floor((pz - r - oz) / h)), z1 = Math.min(gz - 1, Math.floor((pz + r - oz) / h));
    let sw = 0, s = 0;
    for (let cz = z0; cz <= z1; cz++) for (let cy = y0; cy <= y1; cy++) {
      const row = (cz * gy + cy) * gx;
      for (let k = GS[row + x0], ke = GS[row + x1 + 1]; k < ke; k++) {
        const dx = GP[k * 3] - px, dy = GP[k * 3 + 1] - py, dz = GP[k * 3 + 2] - pz, d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > r2) continue;
        const q = GI[k];
        if (q === i) continue;
        if (PC && PC[q] !== PC[i]) continue; // another part (buried where parts intersect): not this surface
        const qx = N[q * 3], qy = N[q * 3 + 1], qz = N[q * 3 + 2];
        if (qx * nx + qy * ny + qz * nz < -0.5) continue; // the far side of a thin plate
        const w = (1 - d2 / r2) ** 2 * CW[q];
        s += (w * ((qx - nx) * dx + (qy - ny) * dy + (qz - nz) * dz)) / (d2 + e2);
        sw += w;
      }
    }
    V[i] = sw > 0 ? (scale * s) / sw : 0;
  }
}

// ---------------------------------------------------------------- cloud → texel samples (kernel surface_interp)

export interface InterpArgs {
  /** values per cloud point */
  m: number;
}

/**
 * A uniform grid over the cloud for the interpolation's radius queries (a radius search in a KD tree costs several
 * times more per texel): cells of size h, the points of each cell listed in point order, their positions copied in
 * that order. GH = [origin x, y, z, h, cells x, y, z].
 */
export function cloudGrid(P: Float64Array, n: number, h: number): { GH: Float64Array; GS: Int32Array; GI: Int32Array; GP: Float64Array } {
  let lx = Infinity, ly = Infinity, lz = Infinity, hx = -Infinity, hy = -Infinity, hz = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    if (x < lx) lx = x; if (x > hx) hx = x; if (y < ly) ly = y; if (y > hy) hy = y; if (z < lz) lz = z; if (z > hz) hz = z;
  }
  if (!n) { lx = ly = lz = 0; hx = hy = hz = 0; }
  // at most about 8M cells: a coarser grid on a huge cloud
  let s = Math.max(h, 1e-9);
  const cells = (q: number) => (Math.floor((hx - lx) / q) + 1) * (Math.floor((hy - ly) / q) + 1) * (Math.floor((hz - lz) / q) + 1);
  while (cells(s) > 8e6) s *= 1.5;
  const nx = Math.floor((hx - lx) / s) + 1, ny = Math.floor((hy - ly) / s) + 1, nz = Math.floor((hz - lz) / s) + 1;
  const cellOf = new Int32Array(n), GS = new Int32Array(nx * ny * nz + 1);
  for (let i = 0; i < n; i++) {
    const cx = Math.min(nx - 1, Math.floor((P[i * 3] - lx) / s)), cy = Math.min(ny - 1, Math.floor((P[i * 3 + 1] - ly) / s)), cz = Math.min(nz - 1, Math.floor((P[i * 3 + 2] - lz) / s));
    const c = (cz * ny + cy) * nx + cx;
    cellOf[i] = c; GS[c + 1]++;
  }
  for (let c = 0; c < nx * ny * nz; c++) GS[c + 1] += GS[c];
  const fill = GS.slice(0, nx * ny * nz), GI = new Int32Array(n), GP = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) { const k = fill[cellOf[i]]++; GI[k] = i; GP[k * 3] = P[i * 3]; GP[k * 3 + 1] = P[i * 3 + 1]; GP[k * 3 + 2] = P[i * 3 + 2]; }
  return { GH: Float64Array.of(lx, ly, lz, s, nx, ny, nz), GS, GI, GP };
}

/**
 * For texel samples [start, end) (A.tri, A.b1, A.b2: triangle and barycentrics): the weighted mean of the cloud values
 * (see the header) into A.V (m per sample), over every cloud point within R (the grid A.GH, A.GS, A.GI, A.GP). Shared:
 * A.tris, A.VP, A.VN (per vertex), A.TR (radius per triangle), A.TPiece, the cloud's A.CP, A.CN, A.CPiece, A.CV (m per
 * point) and its triangle lists A.TS, A.TPts.
 */
export function surfaceInterpRange(a: InterpArgs, A: Record<string, any>, start: number, end: number): void {
  const tri: Int32Array = A.tri, b1: Float32Array = A.b1, b2: Float32Array = A.b2, V: Float32Array = A.V;
  const tris: Uint32Array = A.tris, VP: Float64Array = A.VP, VN: Float64Array = A.VN, TR: Float64Array = A.TR, TPiece: Int32Array = A.TPiece;
  const CP: Float64Array = A.CP, CN: Float64Array = A.CN, CW: Float32Array = A.CW, CPiece: Int32Array = A.CPiece, CV: Float32Array = A.CV, TS: Int32Array = A.TS, TPts: Int32Array = A.TPts;
  const GH: Float64Array = A.GH, GS: Int32Array = A.GS, GI: Int32Array = A.GI, GP: Float64Array = A.GP;
  const ox = GH[0], oy = GH[1], oz = GH[2], h = GH[3], gx = GH[4], gy = GH[5], gz = GH[6];
  const m = a.m, acc = new Float64Array(m);
  for (let i = start; i < end; i++) {
    const t = tri[i], w1 = b1[i], w2 = b2[i], w0 = 1 - w1 - w2;
    const ia = tris[t * 3] * 3, ib = tris[t * 3 + 1] * 3, ic = tris[t * 3 + 2] * 3;
    const px = VP[ia] * w0 + VP[ib] * w1 + VP[ic] * w2, py = VP[ia + 1] * w0 + VP[ib + 1] * w1 + VP[ic + 1] * w2, pz = VP[ia + 2] * w0 + VP[ib + 2] * w1 + VP[ic + 2] * w2;
    let nx = VN[ia] * w0 + VN[ib] * w1 + VN[ic] * w2, ny = VN[ia + 1] * w0 + VN[ib + 1] * w1 + VN[ic + 1] * w2, nz = VN[ia + 2] * w0 + VN[ib + 2] * w1 + VN[ic + 2] * w2;
    const nl = Math.hypot(nx, ny, nz);
    if (nl > 0) { nx /= nl; ny /= nl; nz /= nl; }
    const R = TR[t], R2 = R * R, pc = TPiece[t];
    const x0 = Math.max(0, Math.floor((px - R - ox) / h)), x1 = Math.min(gx - 1, Math.floor((px + R - ox) / h));
    const y0 = Math.max(0, Math.floor((py - R - oy) / h)), y1 = Math.min(gy - 1, Math.floor((py + R - oy) / h));
    const z0 = Math.max(0, Math.floor((pz - R - oz) / h)), z1 = Math.min(gz - 1, Math.floor((pz + R - oz) / h));
    acc.fill(0);
    let sw = 0;
    for (let cz = z0; cz <= z1; cz++) for (let cy = y0; cy <= y1; cy++) {
      const row = (cz * gy + cy) * gx;
      for (let k = GS[row + x0], ke = GS[row + x1 + 1]; k < ke; k++) {
        const dx = GP[k * 3] - px, dy = GP[k * 3 + 1] - py, dz = GP[k * 3 + 2] - pz, d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= R2) continue;
        const q = GI[k];
        if (CPiece[q] !== pc) continue;
        const dn = nx * CN[q * 3] + ny * CN[q * 3 + 1] + nz * CN[q * 3 + 2];
        if (!(dn > 0)) continue;
        const d = 1 - d2 / R2, dn2 = dn * dn, w = d * d * dn2 * dn2 * CW[q];
        sw += w;
        for (let c = 0; c < m; c++) acc[c] += w * CV[q * m + c];
      }
    }
    const o = i * m;
    if (sw > 1e-12) { for (let c = 0; c < m; c++) V[o + c] = acc[c] / sw; continue; }
    // nothing near that faces the same way: the nearest point of the sample's own triangle
    let bq = -1, bd = Infinity;
    for (let k = TS[t]; k < TS[t + 1]; k++) {
      const q = TPts[k], dx = CP[q * 3] - px, dy = CP[q * 3 + 1] - py, dz = CP[q * 3 + 2] - pz, d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bd) { bd = d2; bq = q; }
    }
    for (let c = 0; c < m; c++) V[o + c] = bq >= 0 ? CV[bq * m + c] : 0;
  }
}

// ---------------------------------------------------------------- per-sample measures (kernels bake_noise, bake_distance)

export interface NoiseArgs {
  noise: string;
  fractal: 'fbm' | 'ridged' | 'turbulence' | 'none';
  octaves: number;
  roughness: number;
  /** feature size in metres per axis */
  size: [number, number, number];
  seed: number;
}

/** Position of texel sample i from its triangle and barycentrics (A.tri, A.b1, A.b2; shared A.tris, A.VP) into out. */
function samplePos(A: Record<string, any>, i: number, out: Float64Array): void {
  const tris: Uint32Array = A.tris, VP: Float64Array = A.VP;
  const t = A.tri[i], w1 = A.b1[i], w2 = A.b2[i], w0 = 1 - w1 - w2;
  const ia = tris[t * 3] * 3, ib = tris[t * 3 + 1] * 3, ic = tris[t * 3 + 2] * 3;
  out[0] = VP[ia] * w0 + VP[ib] * w1 + VP[ic] * w2; out[1] = VP[ia + 1] * w0 + VP[ib + 1] * w1 + VP[ic + 1] * w2; out[2] = VP[ia + 2] * w0 + VP[ib + 2] * w1 + VP[ic + 2] * w2;
}

/** 3D noise 0..1 at texel samples [start, end) into A.V (see samplePos for the inputs). */
export function bakeNoiseRange(a: NoiseArgs, A: Record<string, any>, start: number, end: number): void {
  const f = fractal(makeNoise(a.noise, a.seed), { octaves: a.octaves, roughness: a.roughness, fractal: a.fractal });
  const unsigned = a.noise === 'worley' && (a.fractal === 'fbm' || a.fractal === 'none');
  const V: Float32Array = A.V, p = new Float64Array(3), sx = 1 / a.size[0], sy = 1 / a.size[1], sz = 1 / a.size[2];
  for (let i = start; i < end; i++) {
    samplePos(A, i, p);
    const v = f(p[0] * sx, p[1] * sy, p[2] * sz), u = unsigned ? v : 0.5 + 0.5 * v;
    V[i] = u < 0 ? 0 : u > 1 ? 1 : u;
  }
}

/** Distance (metres) to the target surface at texel samples [start, end) into A.V; Infinity beyond a.maxD. */
export function bakeDistanceRange(a: { maxD: number }, A: Record<string, any>, bvh: TriBVH, start: number, end: number): void {
  const V: Float32Array = A.V, p = new Float64Array(3), cs = closestScratch();
  for (let i = start; i < end; i++) {
    samplePos(A, i, p);
    const t = bvh.closestInto(p[0], p[1], p[2], a.maxD, cs);
    V[i] = t >= 0 ? Math.sqrt(cs.d2) : Infinity;
  }
}

// ---------------------------------------------------------------- orchestration (the nodes call these)

/** A kernel runner: CookContext.parallelMap (synchronous on the cooking thread, a promise on the pool). */
export type RunKernel = (kernel: string, job: { count: number; args?: any; inputs?: Record<string, any>; results?: Record<string, any>; shared?: Record<string, any> }, opts?: { minElements?: number }) => unknown;

/** f(x) now when x is a value, after it when x is a promise (keeps cooks on the cooking thread synchronous). */
export const then = <T, U>(x: T | Promise<T>, f: (v: T) => U | Promise<U>): U | Promise<U> => (x instanceof Promise ? x.then(f) : f(x));

/** What every surface measure of one mesh, uv and atlas size shares. */
export interface SurfaceMesh {
  /** positions and measuring normals per vertex */
  VP: Float64Array;
  VN: Float64Array;
  /** piece of each triangle */
  triPiece: Int32Array;
  orient: Orientation;
  /** vertices whose shading normal was turned to its face's side */
  turnedVertices: number;
  /** per triangle: metres per texel along u and v */
  triTexel: Float32Array;
  /** area-weighted median metres per texel (0 when no triangle has uv area) */
  median: number;
}

export function surfaceMesh(g: Geometry, tris: Uint32Array, triPrim: Uint32Array, uv: Float64Array, skip: Uint8Array | null, W: number, H: number): SurfaceMesh {
  const VP = vertexPositions(g);
  const tol = 1e-6 * (bboxDiagonal(g) || 1);
  const authored = authoredNormals(g);
  const orient = measureOrientation(g, tol, authored);
  const shading = authored ? resolveVertexNormals(g, 60) : smoothNormals(g, orient, 60);
  const { VN, turned } = measureNormals(g, orient, shading);
  const nt = triPrim.length, triPiece = new Int32Array(nt);
  for (let t = 0; t < nt; t++) triPiece[t] = orient.piece[triPrim[t]];
  const triTexel = triangleTexelSizes(VP, uv, tris, W, H);
  const median = medianTexelSize(VP, uv, tris, W, H, skip);
  return { VP, VN, triPiece, orient, turnedVertices: turned, triTexel, median };
}

/** A cloud with its lookup: KD tree, and per triangle the interpolation radius R (2 × the local spacing). */
export interface SurfaceCloud {
  cloud: Cloud;
  /** radius queries (curvature, interpolation) */
  grid: { GH: Float64Array; GS: Int32Array; GI: Int32Array; GP: Float64Array };
  TR: Float64Array;
  /** per cloud point: the unit normal of its flat triangle, on the side of its (smooth) normal; 0 when collapsed */
  FN: Float32Array;
  /** grid step in texels and the median spacing in metres */
  k: number;
  spacing: number;
}

/** The cloud every k texels (k ≥ 1) over the atlas of `mesh`. */
export function surfaceCloud(mesh: SurfaceMesh, tris: Uint32Array, uv: Float64Array, skip: Uint8Array | null, W: number, H: number, k: number): SurfaceCloud {
  const nt = Math.floor(tris.length / 3), triL = new Float64Array(nt), TR = new Float64Array(nt);
  const fallback = k * (mesh.median || 1e-3);
  for (let t = 0; t < nt; t++) {
    const l = k * Math.max(mesh.triTexel[t * 2], mesh.triTexel[t * 2 + 1]);
    triL[t] = l > 0 ? l : fallback;
    TR[t] = 2 * triL[t];
  }
  const cloud = buildCloud({ uv, tris, skip, W, H, k, VP: mesh.VP, VN: mesh.VN, triPiece: mesh.triPiece, triL });
  const spacing = k * mesh.median;
  const VP = mesh.VP, FN = new Float32Array(cloud.n * 3);
  for (let i = 0; i < cloud.n; i++) {
    const t = cloud.tri[i], a = tris[t * 3] * 3, b = tris[t * 3 + 1] * 3, c = tris[t * 3 + 2] * 3;
    const ux = VP[b] - VP[a], uy = VP[b + 1] - VP[a + 1], uz = VP[b + 2] - VP[a + 2], wx = VP[c] - VP[a], wy = VP[c + 1] - VP[a + 1], wz = VP[c + 2] - VP[a + 2];
    let x = uy * wz - uz * wy, y = uz * wx - ux * wz, z = ux * wy - uy * wx;
    const l = Math.hypot(x, y, z);
    if (!(l > 0)) continue;
    if (x * cloud.N[i * 3] + y * cloud.N[i * 3 + 1] + z * cloud.N[i * 3 + 2] < 0) { x = -x; y = -y; z = -z; }
    FN[i * 3] = x / l; FN[i * 3 + 1] = y / l; FN[i * 3 + 2] = z / l;
  }
  return { cloud, grid: cloudGrid(cloud.P, cloud.n, 2 * (spacing || fallback)), TR, FN, k, spacing };
}

/** Ray measures per cloud point (hemisphere measures first, then cones): cloud.n × (hemi + cones) values. */
export function runRays(run: RunKernel, sc: SurfaceCloud, scene: RayScene, contact: TriBVH | null, args: SurfaceRayArgs): Float32Array | Promise<Float32Array> {
  const m = args.hemi.length + args.cones.length, c = sc.cloud;
  const V = new Float32Array(c.n * m);
  const shared: Record<string, any> = { ...scene.toArrays() };
  if (contact) { const a = contact.arrays(); Object.assign(shared, { cT: a.T, cnodes: a.nodes, cchild: a.child, corder: a.order, ctriPt: a.triPt }); }
  const rays = Math.max(1, args.samples * Math.max(1, m));
  return then(run('surface_rays', { count: c.n, args, inputs: { P: c.P, N: c.N, FN: sc.FN }, results: { V }, shared }, { minElements: Math.ceil(32768 / rays) }) as any, () => V);
}

/** Surface curvature per cloud point at `radius`. */
export function runCurvature(run: RunKernel, sc: SurfaceCloud, radius: number): Float32Array | Promise<Float32Array> {
  const c = sc.cloud, V = new Float32Array(c.n);
  return then(run('surface_curvature', { count: c.n, args: { radius }, results: { V }, shared: { ...sc.grid, CP: c.P, CN: c.N, CW: c.wt, CPiece: c.piece } }) as any, () => V);
}

/** Cloud values (m per point) at every texel sample: n × m values. */
export function runInterp(run: RunKernel, s: { n: number; tri: Int32Array; b1: Float32Array; b2: Float32Array }, tris: Uint32Array, mesh: SurfaceMesh, sc: SurfaceCloud, CV: Float32Array, m: number): Float32Array | Promise<Float32Array> {
  const c = sc.cloud, V = new Float32Array(s.n * m);
  const args: InterpArgs = { m };
  const shared = { ...sc.grid, tris, VP: mesh.VP, VN: mesh.VN, TR: sc.TR, TPiece: mesh.triPiece, CP: c.P, CN: c.N, CW: c.wt, CPiece: c.piece, CV, TS: c.start, TPts: c.pts };
  return then(run('surface_interp', { count: s.n, args, inputs: { tri: s.tri, b1: s.b1, b2: s.b2 }, results: { V }, shared }) as any, () => V);
}

/** 3D noise 0..1 at every texel sample. */
export function runNoise(run: RunKernel, s: { n: number; tri: Int32Array; b1: Float32Array; b2: Float32Array }, tris: Uint32Array, VP: Float64Array, args: NoiseArgs): Float32Array | Promise<Float32Array> {
  const V = new Float32Array(s.n);
  return then(run('bake_noise', { count: s.n, args, inputs: { tri: s.tri, b1: s.b1, b2: s.b2 }, results: { V }, shared: { tris, VP } }) as any, () => V);
}

/** Distance (metres) from every texel sample to the target's surface; Infinity beyond maxD. */
export function runDistance(run: RunKernel, s: { n: number; tri: Int32Array; b1: Float32Array; b2: Float32Array }, tris: Uint32Array, VP: Float64Array, target: TriBVH, maxD: number): Float32Array | Promise<Float32Array> {
  const V = new Float32Array(s.n), b = target.arrays();
  const shared = { T: b.T, nodes: b.nodes, child: b.child, order: b.order, triPt: b.triPt, tris, VP };
  return then(run('bake_distance', { count: s.n, args: { maxD }, inputs: { tri: s.tri, b1: s.b1, b2: s.b2 }, results: { V }, shared }) as any, () => V);
}
