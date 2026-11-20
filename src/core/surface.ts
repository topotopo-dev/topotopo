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
//                      on it, so thin strips are sampled along their length). A triangle whose texels are farther apart
//                      than the cloud's spacing in metres gets an even lattice at that spacing instead, so what is
//                      measured over a distance does not depend on texel density; a triangle no cell lands on (an island
//                      under a texel) gets points along its middle, and one with no uv area (no texel) gets none. Every
//                      point sits at least 2 × the ray offset inside its triangle's edges, so at a crease or where parts
//                      touch it does not lie in the neighbouring face's plane. Each point weighs the area it stands for
//                      (its triangle's area over its points). Ties between triangles are settled by where they are, so
//                      the cloud does not depend on prim order.
//   buried points      a point inside a solid (a post sunk into a plate, a bolt through a panel) is buried. A solid is a
//                      closed piece that faces outward, of the mesh or of the surroundings; open pieces, one-sided
//                      sheets and inward shells bury nothing (they only block rays), nor does a solid of the
//                      surroundings that holds the whole model (a room). Inside is decided by counting crossings of that
//                      solid along 3 rays. Buried points read covered, are never a neighbour in curvature, and a texel
//                      takes their values only when it has no point that is not buried near (it is buried itself).
//   rays               each cloud point casts `samples` cosine-weighted rays over its hemisphere once, from just above its
//                      flat triangle; occlusion, cavity and visibility are counts over that one set (each with its own
//                      distance limit). Shelter casts its own cone of rays around its direction in the same pass; the
//                      part of the cone behind the surface is covered and comes from a table (no ray noise on flat
//                      faces), the rays in front estimate the rest. Directions behind the point's flat triangle are left
//                      out of every count: on a faceted convex surface they would hit the neighbouring facets. A point
//                      pressed flat against the surroundings and facing them is covered (a face turned away from them
//                      is measured by its rays). Ray directions are seeded from the point's position.
//   interpolation      a texel sample takes the weighted mean of every cloud point of its own piece within R = 2 × the
//                      local cloud spacing, weight (1 − d²/R²)² × max(0, n·nₚ)⁴ × the point's weight, so values do not
//                      bleed around sharp edges, onto the far side of a thin plate or onto another part; with no weight
//                      it takes the nearest point of its own triangle. A texel of an island far coarser than the rest
//                      (R over 4 grid cells: a hidden island packed smaller than a texel) takes the same mean over the
//                      points merged into clusters (per grid cell, part and side), so it costs about what the others do
//   surface curvature  per cloud point p with normal n, over the points q within the radius that are not buried (of any
//                      part, so a junction between parts reads concave) whose normal turns less than 120° away:
//                      c · r · Σ w (n_q − n)·(q − p) / (|q − p|² + ε²) / Σ w, w = (1 − d²/r²)² × the point's weight
//                      (its area), ε = r / 6, c chosen so a 90° edge through the point reads 1 (as bake_curvature's
//                      dihedral bake). A sphere of radius R reads about 1.3 r / R; facets do not show as lines because
//                      the shading normals, not the faces, are read (below one edge length a soft wave of the
//                      interpolated normals remains). At a radius over 8 cluster sizes the neighbours are clusters of
//                      points (per cell, part and side), so the work per point stays bounded.
//   limits             every kernel stops past `deadline` (the time limit of long-running nodes); the radius is at most
//                      half the model's size (checked by the nodes).
// Radius queries use a uniform grid over the cloud (cloudGrid).
// Every loop over cloud points or texel samples is a range function run by a kernel (core/kernels.ts), so the pool and
// the cooking thread give the same bits.
import type { Geometry } from './geometry.ts';
import { rasterizeUV, vertexPositions } from './bake.ts';
import { bboxDiagonal } from './analysis.ts';
import type { RayScene } from './analysis.ts';
import type { TriBVH } from './spatial.ts';
import { closestScratch } from './spatial.ts';
import { resolveVertexNormals, triangulate } from './topology.ts';
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
  /** per piece: 1 for a closed piece that faces outward as measured (a solid: what lies inside it is buried) */
  solid: Uint8Array;
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
  const solid = new Uint8Array(pieces);
  for (let c = 0; c < pieces; c++) solid[c] = !open[c] && pv[c] > 0 ? 1 : 0;
  return { flip, piece, pieces, turned, inward, canon, solid };
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

// ---------------------------------------------------------------- limits and position-keyed randomness

/** Thrown by a surface kernel whose args.deadline (Date.now() milliseconds, 0 = none) has passed; nodes turn it into their time-limit error. */
export const PAST_DEADLINE = 'surface measure: past the deadline';
/** Every 256 elements: has the deadline passed? (the same on the pool and on the cooking thread) */
const late = (deadline: number | undefined, i: number) => !!deadline && (i & 255) === 0 && Date.now() > deadline;

/** The ray offset for a model of bounding-box diagonal `diag`: 10⁻⁴ of it, at most 1 mm. */
export const rayBias = (diag: number) => Math.min(1e-4 * (diag || 1), 0.001);

/** A 32-bit hash of a position and a seed: randomness that follows where a point is, not where it is listed. */
function hashPos(x: number, y: number, z: number, seed: number): number {
  return hash32(hash32(hash32(seed ^ hashNumber(x)) ^ hashNumber(y)) ^ hashNumber(z));
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
   * the surface each point stands for in m²: its triangle's area over its points. A sliver (a decimated mesh has them,
   * with normals that do not fit the surface around them) weighs almost nothing, and a chart packed denser in the atlas
   * does not outvote its neighbour across an edge
   */
  wt: Float32Array;
  /** CSR: the points of triangle t are pts[start[t] .. start[t + 1]) */
  start: Int32Array;
  pts: Int32Array;
  /** grid cells across the atlas */
  cols: number;
  rows: number;
  /** per triangle: the lattice size of a triangle sampled by the lattice (0 = by the texel grid) */
  lat: Int32Array;
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
  /** every point stays at least this far (metres) inside its triangle's edges (up to 0.3 of each height); per triangle */
  inset: number | Float64Array;
  /**
   * The cloud's spacing in metres at most (0 = no limit): a triangle with fewer texels than that gets an even lattice
   * instead of its texel grid, so what is measured over a radius does not depend on texel density. The lattice adds
   * at most as many points as the texel grid has; past that the limit is raised.
   */
  maxStep?: number;
}

/** Points over the surface (see the header): a grid every k texels over the uv atlas, then points on every triangle no cell landed on. */
export function buildCloud(o: CloudInput): Cloud {
  const { uv, tris, skip, VP, VN } = o;
  const nt = Math.floor(tris.length / 3);
  const cols = Math.max(1, Math.round(o.W / o.k)), rows = Math.max(1, Math.round(o.H / o.k));
  // ties between triangles settled by where they are, not by their order
  const key = new Float64Array(nt);
  for (let t = 0; t < nt; t++) {
    const a = tris[t * 3] * 3, b = tris[t * 3 + 1] * 3, c = tris[t * 3 + 2] * 3;
    key[t] = hashPos((VP[a] + VP[b] + VP[c]) / 3, (VP[a + 1] + VP[b + 1] + VP[c + 1]) / 3, (VP[a + 2] + VP[b + 2] + VP[c + 2]) / 3, 0x5f3759df) >>> 0;
  }
  const map = rasterizeUV(uv, tris, cols, rows, true, skip, key);
  const T: number[] = [], B1: number[] = [], B2: number[] = [];
  const has = new Uint8Array(nt);
  const uvArea = (t: number) => {
    const ua = tris[t * 3] * 2, ub = tris[t * 3 + 1] * 2, uc = tris[t * 3 + 2] * 2;
    return Math.abs((uv[ub] - uv[ua]) * (uv[uc + 1] - uv[ua + 1]) - (uv[uc] - uv[ua]) * (uv[ub + 1] - uv[ua + 1]));
  };
  const elen = (a: number, b: number) => Math.hypot(VP[a] - VP[b], VP[a + 1] - VP[b + 1], VP[a + 2] - VP[b + 2]);
  const longest = (t: number) => {
    const c0 = tris[t * 3] * 3, c1 = tris[t * 3 + 1] * 3, c2 = tris[t * 3 + 2] * 3;
    return Math.max(elen(c0, c1), elen(c1, c2), elen(c2, c0));
  };
  // triangles coarser than maxStep: an even lattice of s × s sub-triangles, a point at each one's centroid
  const lat = new Int32Array(nt);
  if (o.maxStep && o.maxStep > 0) {
    let raster = 0;
    for (let c = 0; c < map.tri.length; c++) if (map.tri[c] >= 0) raster++;
    let step = o.maxStep;
    for (let pass = 0; pass < 8; pass++) {
      let extra = 0;
      for (let t = 0; t < nt; t++) {
        lat[t] = 0;
        if ((skip && skip[t]) || !(o.triL[t] > step) || !(uvArea(t) > 1e-18)) continue;
        lat[t] = Math.min(64, Math.ceil(longest(t) / step));
        extra += lat[t] * lat[t];
      }
      if (extra <= Math.max(raster, 4096)) break;
      step *= Math.sqrt(extra / Math.max(raster, 4096));
    }
  }
  for (let c = 0; c < map.tri.length; c++) {
    const t = map.tri[c];
    if (t < 0 || lat[t]) continue;
    T.push(t); B1.push(map.b1[c]); B2.push(map.b2[c]);
    has[t] = 1;
  }
  for (let t = 0; t < nt; t++) {
    const L = lat[t];
    if (!L) continue;
    for (let i = 0; i < L; i++) for (let j = 0; i + j < L; j++) {
      T.push(t); B1.push((i + 1 / 3) / L); B2.push((j + 1 / 3) / L);
      if (i + j <= L - 2) { T.push(t); B1.push((i + 2 / 3) / L); B2.push((j + 2 / 3) / L); }
    }
    has[t] = 1;
  }
  // triangles no cell landed on (small or thin; one with no uv area holds no texel and needs none): points along the
  // middle of the longest edge's strip
  for (let t = 0; t < nt; t++) {
    if (has[t] || (skip && skip[t])) continue;
    if (!(uvArea(t) > 1e-18)) continue;
    const c0 = tris[t * 3] * 3, c1 = tris[t * 3 + 1] * 3, c2 = tris[t * 3 + 2] * 3;
    const l01 = elen(c0, c1), l12 = elen(c1, c2), l20 = elen(c2, c0);
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
  const area = new Float64Array(nt), mins = new Float64Array(nt * 3);
  for (let t = 0; t < nt; t++) {
    const a = tris[t * 3] * 3, b = tris[t * 3 + 1] * 3, c = tris[t * 3 + 2] * 3;
    const ux = VP[b] - VP[a], uy = VP[b + 1] - VP[a + 1], uz = VP[b + 2] - VP[a + 2], vx = VP[c] - VP[a], vy = VP[c + 1] - VP[a + 1], vz = VP[c + 2] - VP[a + 2];
    area[t] = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    // the least barycentric of each corner that keeps a point `inset` from the opposite edge (height h = 2A / edge)
    const e = [Math.hypot(VP[c] - VP[b], VP[c + 1] - VP[b + 1], VP[c + 2] - VP[b + 2]), Math.hypot(vx, vy, vz), Math.hypot(ux, uy, uz)];
    const ins = typeof o.inset === 'number' ? o.inset : o.inset[t];
    for (let q = 0; q < 3; q++) mins[t * 3 + q] = area[t] > 0 ? Math.min(0.3, (ins * e[q]) / (2 * area[t])) : 0;
  }
  for (let i = 0; i < n; i++) {
    const t = T[i];
    // A point on an edge (the conservative raster puts one there for every cell that only overlaps the triangle) would
    // cast its rays from inside the neighbouring face's plane at a crease or where parts touch: it moves toward the
    // centroid until it is `inset` from every edge.
    let w1 = B1[i], w2 = B2[i], w0 = 1 - w1 - w2, sc = 1;
    const bs = [w0, w1, w2];
    for (let q = 0; q < 3; q++) { const m = mins[t * 3 + q]; if (bs[q] < m) sc = Math.min(sc, (1 / 3 - m) / (1 / 3 - bs[q])); }
    if (sc < 1) { w0 = 1 / 3 + sc * (w0 - 1 / 3); w1 = 1 / 3 + sc * (w1 - 1 / 3); w2 = 1 - w0 - w1; }
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
    const w = area[t] / m;
    for (let k = start[t]; k < start[t + 1]; k++) wt[pts[k]] = w;
  }
  return { n, P, N, tri, piece, wt, start, pts, cols, rows, lat };
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
  deadline?: number;
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
  const CB: Uint8Array | undefined = A.CB;
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
  const covered = (o: number) => {
    for (let j = 0; j < nh; j++) V[o + j] = a.hemi[j].kind === 'cavity' ? 1 : 0;
    for (let j = 0; j < nc; j++) V[o + nh + j] = 1;
  };
  for (let i = start; i < end; i++) {
    if (late(a.deadline, i - start)) throw new Error(PAST_DEADLINE);
    const nx = N[i * 3], ny = N[i * 3 + 1], nz = N[i * 3 + 2], px = P[i * 3], py = P[i * 3 + 1], pz = P[i * 3 + 2];
    const o = i * m;
    // inside another part: never seen, and no texel that is seen takes its values
    if (CB && CB[i]) { covered(o); continue; }
    if (!(nx || ny || nz)) {
      // no normal (a collapsed triangle): open
      for (let j = 0; j < nh; j++) V[o + j] = a.hemi[j].kind === 'cavity' ? 0 : 1;
      for (let j = 0; j < nc; j++) V[o + nh + j] = 0;
      continue;
    }
    // The flat triangle under the point: a direction in front of the smooth normal but behind the triangle would hit
    // the triangle's own neighbours on a faceted convex surface (the shadow terminator), so it is left out of the count.
    let fx = 0, fy = 0, fz = 0;
    if (FN) { fx = FN[i * 3]; fy = FN[i * 3 + 1]; fz = FN[i * 3 + 2]; }
    const hasF = fx !== 0 || fy !== 0 || fz !== 0;
    // pressed flat against the surroundings, facing them: covered from every side. One-sided: the surroundings must lie
    // in front of the face (or, touching it, face it); a face turned away from them is measured by its rays.
    if (contact && a.contact > 0) {
      const t = contact.closestInto(px, py, pz, a.contact, cs);
      if (t >= 0) {
        const T = contact.T, q = t * 9;
        const ux = T[q + 3] - T[q], uy = T[q + 4] - T[q + 1], uz = T[q + 5] - T[q + 2], wx = T[q + 6] - T[q], wy = T[q + 7] - T[q + 1], wz = T[q + 8] - T[q + 2];
        const cx = uy * wz - uz * wy, cy = uz * wx - ux * wz, cz = ux * wy - uy * wx, cl = Math.hypot(cx, cy, cz);
        const qx = cs.x - px, qy = cs.y - py, qz = cs.z - pz, ql = Math.hypot(qx, qy, qz);
        const toward = ql > 0.05 * a.contact ? qx * nx + qy * ny + qz * nz > 0.7 * ql : cx * nx + cy * ny + cz * nz <= -0.7 * cl;
        if (cl > 0 && Math.abs(cx * nx + cy * ny + cz * nz) >= 0.7 * cl && toward) { covered(o); continue; }
      }
    }
    // rays start above the flat triangle (off its plane even where the smooth normal is not), from a point kept inside
    // its edges, so at a crease or a contact line they do not start in the neighbouring face's plane
    const bx = hasF ? fx : nx, by = hasF ? fy : ny, bz = hasF ? fz : nz;
    const ox = px + bx * a.bias, oy = py + by * a.bias, oz = pz + bz * a.bias;
    const h1 = hashPos(px, py, pz, seedH), h2 = hash32(h1 ^ 0x68e31da4);
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
      let facet = hasF;
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

// ---------------------------------------------------------------- buried points (kernel surface_buried)

/** 3 fixed directions for the inside test, off the axes and off each other (a ray along a face or an edge of an
 * axis-aligned model would graze it). */
const BURY_DIRS = (() => {
  const d = [[0.5377, 0.8121, 0.2265], [-0.6731, 0.2489, 0.6964], [0.3091, -0.5743, -0.7581]];
  return d.flatMap((v) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; });
})();

/**
 * Cloud points [start, end) inside a solid (A.B out: 1 = buried). A solid is a closed piece that faces outward: another
 * part of the mesh, or a closed piece of the surroundings that does not hold the whole model (one that does is a room
 * around it). Open pieces, one-sided sheets and pieces that face inward bury nothing. From just above its flat triangle a
 * point casts 3 rays and counts, along each, every crossing of each solid whose box holds it; it is inside a solid when
 * at least 2 of the 3 counts are odd. Shared: the scene's T…triPt, per scene triangle its solid SSol (-1 = none), per
 * solid its box SBox (6) and its piece SPc (the point's own piece never buries it); A.P, A.N, A.FN, A.CPiece per point.
 */
export function surfaceBuriedRange(a: { bias: number; deadline?: number }, A: Record<string, any>, scene: RayScene, start: number, end: number): void {
  const P: Float64Array = A.P, N: Float64Array = A.N, FN: Float32Array = A.FN, CPiece: Int32Array = A.CPiece, B: Uint8Array = A.B;
  const SSol: Int32Array = A.SSol, SBox: Float64Array = A.SBox, SPc: Int32Array = A.SPc;
  const ns = SPc.length, eps = Math.max(1e-9, a.bias * 1e-3);
  const cand: number[] = [], odd = new Int8Array(ns), votes = new Int8Array(ns);
  for (let i = start; i < end; i++) {
    if (late(a.deadline, i - start)) throw new Error(PAST_DEADLINE);
    B[i] = 0;
    let nx = FN[i * 3], ny = FN[i * 3 + 1], nz = FN[i * 3 + 2];
    if (!(nx || ny || nz)) { nx = N[i * 3]; ny = N[i * 3 + 1]; nz = N[i * 3 + 2]; }
    const ox = P[i * 3] + nx * a.bias, oy = P[i * 3 + 1] + ny * a.bias, oz = P[i * 3 + 2] + nz * a.bias, own = CPiece[i];
    // the solids whose box holds the point
    cand.length = 0;
    for (let k = 0; k < ns; k++) {
      if (SPc[k] === own) continue;
      const b = k * 6;
      if (ox >= SBox[b] && oy >= SBox[b + 1] && oz >= SBox[b + 2] && ox <= SBox[b + 3] && oy <= SBox[b + 4] && oz <= SBox[b + 5]) cand.push(k);
    }
    if (!cand.length) continue;
    for (const k of cand) votes[k] = 0;
    for (let r = 0; r < 3; r++) {
      const dx = BURY_DIRS[r * 3], dy = BURY_DIRS[r * 3 + 1], dz = BURY_DIRS[r * 3 + 2];
      // past every candidate's box no crossing changes a count
      let tEnd = 0;
      for (const k of cand) {
        const b = k * 6;
        const ex = dx > 0 ? (SBox[b + 3] - ox) / dx : dx < 0 ? (SBox[b] - ox) / dx : Infinity;
        const ey = dy > 0 ? (SBox[b + 4] - oy) / dy : dy < 0 ? (SBox[b + 1] - oy) / dy : Infinity;
        const ez = dz > 0 ? (SBox[b + 5] - oz) / dz : dz < 0 ? (SBox[b + 2] - oz) / dz : Infinity;
        tEnd = Math.max(tEnd, Math.min(ex, ey, ez));
        odd[k] = 0;
      }
      // every crossing along the ray (one per hit: a ray through a shared edge or corner counts it once)
      let tmin = 0;
      for (let h = 0; h < 4096; h++) {
        const t = scene.nearest(ox, oy, oz, dx, dy, dz, tEnd + eps, tmin);
        if (!(t < Infinity)) break;
        const tr = scene.lastTri, k = tr >= 0 ? SSol[tr] : -1;
        if (k >= 0) odd[k] ^= 1;
        tmin = t + eps;
      }
      for (const k of cand) if (odd[k]) votes[k]++;
    }
    for (const k of cand) if (votes[k] >= 2) { B[i] = 1; break; }
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
  /** the neighbour points are the query points themselves (a point does not count itself) */
  self: boolean;
  deadline?: number;
}

/**
 * Surface curvature (see the header) at query points [start, end) (A.QP, A.QN; A.QB 1 = buried: 0, not measured) from
 * the neighbour points A.CP, A.CN, A.CW (the surface each stands for, m²) in the grid A.GH, A.GS, A.GI, A.GP
 * (cloudGrid): the cloud itself, or its clusters when the radius is large (thinCloud). Neighbours of any part count, so
 * the concave line where two parts meet reads; buried ones (A.CB) never do. A.V out.
 */
export function surfaceCurvatureRange(a: CurvatureCloudArgs, A: Record<string, any>, start: number, end: number): void {
  const QP: Float64Array = A.QP, QN: Float64Array = A.QN, QB: Uint8Array | undefined = A.QB;
  const N: Float64Array = A.CN, CW: Float32Array = A.CW, CB: Uint8Array | undefined = A.CB, V: Float32Array = A.V;
  const GH: Float64Array = A.GH, GS: Int32Array = A.GS, GI: Int32Array = A.GI, GP: Float64Array = A.GP;
  const ox = GH[0], oy = GH[1], oz = GH[2], h = GH[3], gx = GH[4], gy = GH[5], gz = GH[6];
  const r = a.radius, r2 = r * r, e2 = (CURV_EPS * r) ** 2, scale = CURVATURE_SCALE * r;
  for (let i = start; i < end; i++) {
    if (late(a.deadline, i - start)) throw new Error(PAST_DEADLINE);
    if (QB && QB[i]) { V[i] = 0; continue; }
    const px = QP[i * 3], py = QP[i * 3 + 1], pz = QP[i * 3 + 2], nx = QN[i * 3], ny = QN[i * 3 + 1], nz = QN[i * 3 + 2];
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
        if (a.self && q === i) continue;
        if (CB && CB[q]) continue; // inside another part: not a surface anyone sees
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

/** Clusters a cloud thins to for curvature at a radius over this many cluster sizes (the work per point stays bounded). */
export const CURVATURE_THIN = 8;

/**
 * The cloud's points (buried ones left out) merged per cell of size h, per part and per side the normal mostly faces
 * (so the two faces of an edge stay apart): area-weighted mean position and normal, summed area. For curvature at a
 * radius many times the spacing: the sum over the disc is the same integral at a coarser step.
 */
export function thinCloud(c: Cloud, CB: Uint8Array | null, h: number): { n: number; P: Float64Array; N: Float64Array; W: Float32Array; piece: Int32Array; of: Int32Array } {
  const P: number[] = [], N: number[] = [], W: number[] = [], piece: number[] = [], of = new Int32Array(c.n).fill(-1);
  let lx = Infinity, ly = Infinity, lz = Infinity, hx = -Infinity, hy = -Infinity, hz = -Infinity, np = 1;
  for (let i = 0; i < c.n; i++) {
    const x = c.P[i * 3], y = c.P[i * 3 + 1], z = c.P[i * 3 + 2];
    if (x < lx) lx = x; if (x > hx) hx = x; if (y < ly) ly = y; if (y > hy) hy = y; if (z < lz) lz = z; if (z > hz) hz = z;
    if (c.piece[i] >= np) np = c.piece[i] + 1;
  }
  // a number per cell, side and part (a string where that number would not be exact)
  const nx = Math.floor((hx - lx) / h) + 1, ny = Math.floor((hy - ly) / h) + 1, nz = Math.floor((hz - lz) / h) + 1;
  const exact = nx * ny * nz * 6 * np < Number.MAX_SAFE_INTEGER;
  const ids = new Map<number | string, number>();
  for (let i = 0; i < c.n; i++) {
    const w = c.wt[i];
    if ((CB && CB[i]) || !(w > 0)) continue;
    const x = c.P[i * 3], y = c.P[i * 3 + 1], z = c.P[i * 3 + 2], nx_ = c.N[i * 3], ny_ = c.N[i * 3 + 1], nz_ = c.N[i * 3 + 2];
    const ax = Math.abs(nx_), ay = Math.abs(ny_), az = Math.abs(nz_);
    const side = ax >= ay && ax >= az ? (nx_ > 0 ? 0 : 1) : ay >= az ? (ny_ > 0 ? 2 : 3) : nz_ > 0 ? 4 : 5;
    const ix = Math.floor((x - lx) / h), iy = Math.floor((y - ly) / h), iz = Math.floor((z - lz) / h);
    const key = exact ? (((iz * ny + iy) * nx + ix) * 6 + side) * np + c.piece[i] : `${ix},${iy},${iz},${c.piece[i]},${side}`;
    let j = ids.get(key);
    if (j === undefined) { j = W.length; ids.set(key, j); P.push(0, 0, 0); N.push(0, 0, 0); W.push(0); piece.push(c.piece[i]); }
    of[i] = j;
    P[j * 3] += w * x; P[j * 3 + 1] += w * y; P[j * 3 + 2] += w * z;
    N[j * 3] += w * nx_; N[j * 3 + 1] += w * ny_; N[j * 3 + 2] += w * nz_;
    W[j] += w;
  }
  const n = W.length, OP = new Float64Array(n * 3), ON = new Float64Array(n * 3);
  for (let j = 0; j < n; j++) {
    for (let q = 0; q < 3; q++) OP[j * 3 + q] = P[j * 3 + q] / W[j];
    const l = Math.hypot(N[j * 3], N[j * 3 + 1], N[j * 3 + 2]);
    if (l > 0) for (let q = 0; q < 3; q++) ON[j * 3 + q] = N[j * 3 + q] / l;
  }
  return { n, P: OP, N: ON, W: Float32Array.from(W), piece: Int32Array.from(piece), of };
}

// ---------------------------------------------------------------- cloud → texel samples (kernel surface_interp)

export interface InterpArgs {
  /** values per cloud point */
  m: number;
  /** radius above which a texel reads the clusters (A.KGH …), when they are given */
  coarse?: number;
  deadline?: number;
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
 * point) and its triangle lists A.TS, A.TPts; for coarse texels (radius over a.coarse) the clusters' grid A.KGH, A.KGS,
 * A.KGI, A.KGP and their A.KN, A.KW, A.KPiece, A.KV.
 */
export function surfaceInterpRange(a: InterpArgs, A: Record<string, any>, start: number, end: number): void {
  const tri: Int32Array = A.tri, b1: Float32Array = A.b1, b2: Float32Array = A.b2, V: Float32Array = A.V;
  const tris: Uint32Array = A.tris, VP: Float64Array = A.VP, VN: Float64Array = A.VN, TR: Float64Array = A.TR, TPiece: Int32Array = A.TPiece;
  const CP: Float64Array = A.CP, CN: Float64Array = A.CN, CW: Float32Array = A.CW, CPiece: Int32Array = A.CPiece, CV: Float32Array = A.CV, TS: Int32Array = A.TS, TPts: Int32Array = A.TPts;
  const GH: Float64Array = A.GH, GS: Int32Array = A.GS, GI: Int32Array = A.GI, GP: Float64Array = A.GP;
  const ox = GH[0], oy = GH[1], oz = GH[2], h = GH[3], gx = GH[4], gy = GH[5], gz = GH[6];
  const CB: Uint8Array | undefined = A.CB;
  const KGH: Float64Array | undefined = A.KGH, KGS: Int32Array = A.KGS, KGI: Int32Array = A.KGI, KGP: Float64Array = A.KGP;
  const KN: Float64Array = A.KN, KW: Float32Array = A.KW, KPiece: Int32Array = A.KPiece, KV: Float32Array = A.KV, coarse = a.coarse ?? Infinity;
  const m = a.m, acc = new Float64Array(m), accB = new Float64Array(m);
  for (let i = start; i < end; i++) {
    if (late(a.deadline, i - start)) throw new Error(PAST_DEADLINE);
    const t = tri[i], w1 = b1[i], w2 = b2[i], w0 = 1 - w1 - w2;
    const ia = tris[t * 3] * 3, ib = tris[t * 3 + 1] * 3, ic = tris[t * 3 + 2] * 3;
    const px = VP[ia] * w0 + VP[ib] * w1 + VP[ic] * w2, py = VP[ia + 1] * w0 + VP[ib + 1] * w1 + VP[ic + 1] * w2, pz = VP[ia + 2] * w0 + VP[ib + 2] * w1 + VP[ic + 2] * w2;
    let nx = VN[ia] * w0 + VN[ib] * w1 + VN[ic] * w2, ny = VN[ia + 1] * w0 + VN[ib + 1] * w1 + VN[ic + 1] * w2, nz = VN[ia + 2] * w0 + VN[ib + 2] * w1 + VN[ic + 2] * w2;
    const nl = Math.hypot(nx, ny, nz);
    if (nl > 0) { nx /= nl; ny /= nl; nz /= nl; }
    const R = TR[t], R2 = R * R, pc = TPiece[t];
    if (KGH && R > coarse) {
      // a coarse texel: the clusters within R (the full scan below when none faces its way)
      const kox = KGH[0], koy = KGH[1], koz = KGH[2], kh = KGH[3], kgx = KGH[4], kgy = KGH[5], kgz = KGH[6];
      const x0 = Math.max(0, Math.floor((px - R - kox) / kh)), x1 = Math.min(kgx - 1, Math.floor((px + R - kox) / kh));
      const y0 = Math.max(0, Math.floor((py - R - koy) / kh)), y1 = Math.min(kgy - 1, Math.floor((py + R - koy) / kh));
      const z0 = Math.max(0, Math.floor((pz - R - koz) / kh)), z1 = Math.min(kgz - 1, Math.floor((pz + R - koz) / kh));
      acc.fill(0);
      let sw = 0;
      for (let cz = z0; cz <= z1; cz++) for (let cy = y0; cy <= y1; cy++) {
        const row = (cz * kgy + cy) * kgx;
        for (let k = KGS[row + x0], ke = KGS[row + x1 + 1]; k < ke; k++) {
          const dx = KGP[k * 3] - px, dy = KGP[k * 3 + 1] - py, dz = KGP[k * 3 + 2] - pz, d2 = dx * dx + dy * dy + dz * dz;
          if (d2 >= R2) continue;
          const q = KGI[k];
          if (KPiece[q] !== pc) continue;
          const dn = nx * KN[q * 3] + ny * KN[q * 3 + 1] + nz * KN[q * 3 + 2];
          if (!(dn > 0)) continue;
          const d = 1 - d2 / R2, dn2 = dn * dn, w = d * d * dn2 * dn2 * KW[q];
          sw += w;
          for (let c = 0; c < m; c++) acc[c] += w * KV[q * m + c];
        }
      }
      if (sw > 0) { for (let c = 0; c < m; c++) V[i * m + c] = acc[c] / sw; continue; }
    }
    const x0 = Math.max(0, Math.floor((px - R - ox) / h)), x1 = Math.min(gx - 1, Math.floor((px + R - ox) / h));
    const y0 = Math.max(0, Math.floor((py - R - oy) / h)), y1 = Math.min(gy - 1, Math.floor((py + R - oy) / h));
    const z0 = Math.max(0, Math.floor((pz - R - oz) / h)), z1 = Math.min(gz - 1, Math.floor((pz + R - oz) / h));
    acc.fill(0);
    accB.fill(0);
    let sw = 0, swB = 0;
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
        // a buried point only serves texels that have nothing else near (they are buried themselves)
        if (CB && CB[q]) { swB += w; for (let c = 0; c < m; c++) accB[c] += w * CV[q * m + c]; continue; }
        sw += w;
        for (let c = 0; c < m; c++) acc[c] += w * CV[q * m + c];
      }
    }
    const o = i * m;
    if (sw > 0) { for (let c = 0; c < m; c++) V[o + c] = acc[c] / sw; continue; }
    if (swB > 0) { for (let c = 0; c < m; c++) V[o + c] = accB[c] / swB; continue; }
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
  deadline?: number;
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
    if (late(a.deadline, i - start)) throw new Error(PAST_DEADLINE);
    samplePos(A, i, p);
    const v = f(p[0] * sx, p[1] * sy, p[2] * sz), u = unsigned ? v : 0.5 + 0.5 * v;
    V[i] = u < 0 ? 0 : u > 1 ? 1 : u;
  }
}

/** Distance (metres) to the target surface at texel samples [start, end) into A.V; Infinity beyond a.maxD. */
export function bakeDistanceRange(a: { maxD: number; deadline?: number }, A: Record<string, any>, bvh: TriBVH, start: number, end: number): void {
  const V: Float32Array = A.V, p = new Float64Array(3), cs = closestScratch();
  for (let i = start; i < end; i++) {
    if (late(a.deadline, i - start)) throw new Error(PAST_DEADLINE);
    samplePos(A, i, p);
    const t = bvh.closestInto(p[0], p[1], p[2], a.maxD, cs);
    V[i] = t >= 0 ? Math.sqrt(cs.d2) : Infinity;
  }
}

// ---------------------------------------------------------------- orchestration (the nodes call these)

/** A kernel runner: CookContext.parallelMap (synchronous on the cooking thread, a promise on the pool). */
export type RunKernel = (kernel: string, job: { count: number; args?: any; inputs?: Record<string, any>; results?: Record<string, any>; shared?: Record<string, any> }, opts?: { minElements?: number }) => unknown;

/** f(x) now when x is a value, after it when x is a promise (keeps cooks on the cooking thread synchronous). */
export const afterRun = <T, U>(x: T | Promise<T>, f: (v: T) => U | Promise<U>): U | Promise<U> => (x instanceof Promise ? x.then(f) : f(x));

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
  /** prim of each triangle, and the bounding-box diagonal */
  triPrim: Uint32Array;
  diag: number;
}

export function surfaceMesh(g: Geometry, tris: Uint32Array, triPrim: Uint32Array, uv: Float64Array, skip: Uint8Array | null, W: number, H: number): SurfaceMesh {
  const VP = vertexPositions(g);
  const diag = bboxDiagonal(g) || 1, tol = 1e-6 * diag;
  const authored = authoredNormals(g);
  const orient = measureOrientation(g, tol, authored);
  const shading = authored ? resolveVertexNormals(g, 60) : smoothNormals(g, orient, 60);
  const { VN, turned } = measureNormals(g, orient, shading);
  const nt = triPrim.length, triPiece = new Int32Array(nt);
  for (let t = 0; t < nt; t++) triPiece[t] = orient.piece[triPrim[t]];
  const triTexel = triangleTexelSizes(VP, uv, tris, W, H);
  const median = medianTexelSize(VP, uv, tris, W, H, skip);
  return { VP, VN, triPiece, orient, turnedVertices: turned, triTexel, median, triPrim, diag };
}

/** A cloud with its lookup: KD tree, and per triangle the interpolation radius R (2 × the local spacing). */
export interface SurfaceCloud {
  cloud: Cloud;
  /** radius queries (curvature, interpolation) */
  grid: { GH: Float64Array; GS: Int32Array; GI: Int32Array; GP: Float64Array };
  TR: Float64Array;
  /** per cloud point: the unit normal of its flat triangle, on the side of its (smooth) normal; 0 when collapsed */
  FN: Float32Array;
  /** grid step in texels, and the median spacing in metres over the points (where the texels are) */
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
  const spacing = k * mesh.median;
  // the inset from each piece's own size, so a part's points stay put when other parts are added
  const np = mesh.orient.pieces, box = new Float64Array(np * 6);
  for (let c = 0; c < np; c++) box.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], c * 6);
  for (let t = 0; t < nt; t++) {
    const c = mesh.triPiece[t] * 6;
    for (let q = 0; q < 3; q++) {
      const v = tris[t * 3 + q] * 3;
      for (let a = 0; a < 3; a++) { const x = mesh.VP[v + a]; if (x < box[c + a]) box[c + a] = x; if (x > box[c + 3 + a]) box[c + 3 + a] = x; }
    }
  }
  const pieceInset = new Float64Array(np);
  for (let c = 0; c < np; c++) pieceInset[c] = 2 * rayBias(Math.hypot(box[c * 6 + 3] - box[c * 6], box[c * 6 + 4] - box[c * 6 + 1], box[c * 6 + 5] - box[c * 6 + 2]) || mesh.diag);
  const inset = new Float64Array(nt);
  for (let t = 0; t < nt; t++) inset[t] = pieceInset[mesh.triPiece[t]];
  const cloud = buildCloud({ uv, tris, skip, W, H, k, VP: mesh.VP, VN: mesh.VN, triPiece: mesh.triPiece, triL, inset, maxStep: spacing });
  for (let t = 0; t < nt; t++) {
    const L = cloud.lat[t];
    if (!L) continue;
    const c0 = tris[t * 3] * 3, c1 = tris[t * 3 + 1] * 3, c2 = tris[t * 3 + 2] * 3, VP = mesh.VP;
    const el = (a: number, b: number) => Math.hypot(VP[a] - VP[b], VP[a + 1] - VP[b + 1], VP[a + 2] - VP[b + 2]);
    triL[t] = Math.max(el(c0, c1), el(c1, c2), el(c2, c0)) / L;
    TR[t] = 2 * triL[t];
  }
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
  // the spacing where the points are, the median over the points: an atlas packed for what is seen puts most texels on
  // a small part of the surface, so the median over the area (the lattice's step) can be many times coarser, and a grid
  // that coarse would scan thousands of points for each texel
  const L = new Float64Array(cloud.n);
  for (let i = 0; i < cloud.n; i++) L[i] = triL[cloud.tri[i]];
  L.sort();
  const at = cloud.n ? L[cloud.n >> 1] : 0;
  return { cloud, grid: cloudGrid(cloud.P, cloud.n, 2 * (at || spacing || fallback)), TR, FN, k, spacing: at || spacing };
}

/**
 * Which cloud points lie inside another part or the surroundings (1 = buried), or null when the scene has one part and
 * nothing else. `scene` holds the mesh's triangles first (RayScene.of(g) or of the mesh merged before its surroundings).
 */
/**
 * Which cloud points lie inside a solid (see surfaceBuriedRange), or null when nothing can bury anything. `scene` holds
 * the mesh's triangles first, then those of `sur` (the surroundings, or null), in triangulation order.
 */
export function runBuried(run: RunKernel, sc: SurfaceCloud, mesh: SurfaceMesh, scene: RayScene, sur: Geometry | null, deadline = 0): Uint8Array | null | Promise<Uint8Array | null> {
  const arr = scene.toArrays(), nS = arr.order.length, nt = mesh.triPiece.length, o = mesh.orient;
  // the surroundings' pieces and which of them are solids
  let surTri: Int32Array | null = null, surOrient: Orientation | null = null;
  if (sur && nS > nt) {
    const st = triangulate(sur);
    if (st.triPrim.length !== nS - nt) return null;
    surOrient = measureOrientation(sur, 1e-6 * (bboxDiagonal(sur) || 1), null);
    surTri = new Int32Array(st.triPrim.length);
    for (let j = 0; j < st.triPrim.length; j++) surTri[j] = surOrient.piece[st.triPrim[j]];
  } else if (nS !== nt) return null;
  // solids: the mesh's closed outward pieces, then the surroundings'; a box per solid
  const solidOf = new Int32Array(o.pieces + (surOrient?.pieces ?? 0)).fill(-1);
  const SPcL: number[] = [];
  for (let c = 0; c < o.pieces; c++) if (o.solid[c]) { solidOf[c] = SPcL.length; SPcL.push(c); }
  if (surOrient) for (let c = 0; c < surOrient.pieces; c++) if (surOrient.solid[c]) { solidOf[o.pieces + c] = SPcL.length; SPcL.push(-3 - c); }
  // a single piece cannot bury its own points
  if (!SPcL.length || (SPcL.length === 1 && SPcL[0] >= 0 && o.pieces === 1)) return null;
  const ns = SPcL.length, SSol = new Int32Array(nS).fill(-1), SBox = new Float64Array(ns * 6);
  for (let k = 0; k < ns; k++) { SBox[k * 6] = SBox[k * 6 + 1] = SBox[k * 6 + 2] = Infinity; SBox[k * 6 + 3] = SBox[k * 6 + 4] = SBox[k * 6 + 5] = -Infinity; }
  const T = arr.T;
  for (let t = 0; t < nS; t++) {
    const pc = t < nt ? mesh.triPiece[t] : surTri ? o.pieces + surTri[t - nt] : -1;
    const k = pc >= 0 ? solidOf[pc] : -1;
    SSol[t] = k;
    if (k < 0) continue;
    for (let v = 0; v < 3; v++) for (let q = 0; q < 3; q++) {
      const x = T[t * 9 + v * 3 + q];
      if (x < SBox[k * 6 + q]) SBox[k * 6 + q] = x;
      if (x > SBox[k * 6 + 3 + q]) SBox[k * 6 + 3 + q] = x;
    }
  }
  // a solid of the surroundings whose box holds the whole model is a room around it, not a solid it is buried in
  let lx = Infinity, ly = Infinity, lz = Infinity, hx = -Infinity, hy = -Infinity, hz = -Infinity;
  for (let t = 0; t < nt * 9; t += 3) { lx = Math.min(lx, T[t]); ly = Math.min(ly, T[t + 1]); lz = Math.min(lz, T[t + 2]); hx = Math.max(hx, T[t]); hy = Math.max(hy, T[t + 1]); hz = Math.max(hz, T[t + 2]); }
  for (let k = 0; k < ns; k++) {
    if (SPcL[k] >= 0) continue;
    const b = k * 6;
    if (SBox[b] <= lx && SBox[b + 1] <= ly && SBox[b + 2] <= lz && SBox[b + 3] >= hx && SBox[b + 4] >= hy && SBox[b + 5] >= hz) {
      for (let t = 0; t < nS; t++) if (SSol[t] === k) SSol[t] = -1;
      SBox[b] = SBox[b + 1] = SBox[b + 2] = Infinity; SBox[b + 3] = SBox[b + 4] = SBox[b + 5] = -Infinity;
    }
  }
  const SPc = Int32Array.from(SPcL);
  const c = sc.cloud, B = new Uint8Array(c.n);
  return afterRun(run('surface_buried', { count: c.n, args: { bias: rayBias(mesh.diag), deadline }, inputs: { P: c.P, N: c.N, FN: sc.FN, CPiece: c.piece }, results: { B }, shared: { ...arr, SSol, SBox, SPc } }, { minElements: 4096 }) as any, () => B);
}

/** Ray measures per cloud point (hemisphere measures first, then cones): cloud.n × (hemi + cones) values. Buried points read covered. */
export function runRays(run: RunKernel, sc: SurfaceCloud, scene: RayScene, contact: TriBVH | null, args: SurfaceRayArgs, CB: Uint8Array | null = null): Float32Array | Promise<Float32Array> {
  const m = args.hemi.length + args.cones.length, c = sc.cloud;
  const V = new Float32Array(c.n * m);
  const shared: Record<string, any> = { ...scene.toArrays() };
  if (contact) { const a = contact.arrays(); Object.assign(shared, { cT: a.T, cnodes: a.nodes, cchild: a.child, corder: a.order, ctriPt: a.triPt }); }
  const inputs: Record<string, any> = { P: c.P, N: c.N, FN: sc.FN };
  if (CB) inputs.CB = CB;
  const rays = Math.max(1, args.samples * Math.max(1, m));
  return afterRun(run('surface_rays', { count: c.n, args, inputs, results: { V }, shared }, { minElements: Math.ceil(32768 / rays) }) as any, () => V);
}

/**
 * Surface curvature per cloud point at `radius` (buried points read 0 and are never neighbours). When the radius is
 * more than `thin` cluster sizes of the spacing, the neighbours are the cloud thinned to clusters of radius / thin, so a
 * large radius costs about what a small one does.
 */
export function runCurvature(run: RunKernel, sc: SurfaceCloud, radius: number, CB: Uint8Array | null = null, deadline = 0, thin = CURVATURE_THIN): Float32Array | Promise<Float32Array> {
  const c = sc.cloud, V = new Float32Array(c.n), hc = radius / thin;
  const shared: Record<string, any> = { QP: c.P, QN: c.N };
  if (CB) shared.QB = CB;
  let self = true;
  if (thin > 0 && hc > 1.5 * sc.spacing) {
    const k = thinCloud(c, CB, hc);
    Object.assign(shared, cloudGrid(k.P, k.n, radius), { CP: k.P, CN: k.N, CW: k.W });
    self = false;
  } else {
    Object.assign(shared, sc.grid, { CP: c.P, CN: c.N, CW: c.wt });
    if (CB) shared.CB = CB;
  }
  return afterRun(run('surface_curvature', { count: c.n, args: { radius, self, deadline }, results: { V }, shared }) as any, () => V);
}

/** Grid cells (2 × the spacing) over which a texel's radius reads the clusters instead of the points. */
export const INTERP_COARSE = 4;

/**
 * Cloud values (m per point) at every texel sample: n × m values. A texel takes buried points only when nothing else is
 * near; one whose radius is over `coarse` grid cells reads the clusters (Infinity: every texel reads the points).
 */
export function runInterp(run: RunKernel, s: { n: number; tri: Int32Array; b1: Float32Array; b2: Float32Array }, tris: Uint32Array, mesh: SurfaceMesh, sc: SurfaceCloud, CV: Float32Array, m: number, CB: Uint8Array | null = null, deadline = 0, coarseCells = INTERP_COARSE): Float32Array | Promise<Float32Array> {
  const c = sc.cloud, V = new Float32Array(s.n * m);
  const args: InterpArgs = { m, deadline };
  const shared: Record<string, any> = { ...sc.grid, tris, VP: mesh.VP, VN: mesh.VN, TR: sc.TR, TPiece: mesh.triPiece, CP: c.P, CN: c.N, CW: c.wt, CPiece: c.piece, CV, TS: c.start, TPts: c.pts };
  if (CB) shared.CB = CB;
  // coarse islands (R over `coarseCells` grid cells) read the cloud merged per grid cell, part and side, in a grid that
  // many times coarser
  const h = sc.grid.GH[3], coarse = coarseCells * h;
  let any = false;
  for (let t = 0; t < sc.TR.length && !any; t++) any = sc.TR[t] > coarse;
  if (any) {
    const K = thinCloud(c, CB, h), KV = new Float32Array(K.n * m), KS = new Float64Array(K.n);
    for (let i = 0; i < c.n; i++) {
      const j = K.of[i];
      if (j < 0) continue;
      const w = c.wt[i];
      KS[j] += w;
      for (let q = 0; q < m; q++) KV[j * m + q] += w * CV[i * m + q];
    }
    for (let j = 0; j < K.n; j++) if (KS[j] > 0) for (let q = 0; q < m; q++) KV[j * m + q] /= KS[j];
    const G = cloudGrid(K.P, K.n, coarse);
    Object.assign(shared, { KGH: G.GH, KGS: G.GS, KGI: G.GI, KGP: G.GP, KN: K.N, KW: K.W, KPiece: K.piece, KV });
    args.coarse = coarse;
  }
  return afterRun(run('surface_interp', { count: s.n, args, inputs: { tri: s.tri, b1: s.b1, b2: s.b2 }, results: { V }, shared }) as any, () => V);
}

// ---------------------------------------------------------------- edge wear (bake_edge_wear)

/**
 * Edge proximity per cloud point (kernel surface_spread), at two reaches: V[2i] the largest E[q] × (1 − d / width),
 * V[2i + 1] the largest E[q] × (1 − d / far), over the points q of the same part within reach that are not buried and
 * do not face away (normals more than 120° apart: the far side of a thin plate), the point itself included (far ≥
 * width). E is the edge field (0..1); buried points read 0. Shared: the cloud's A.CP, A.CN, A.CPiece, A.CB, its grid
 * A.GH, A.GS, A.GI, A.GP, and A.E; A.V out (2 per point).
 */
export function surfaceSpreadRange(a: { width: number; far: number; deadline?: number }, A: Record<string, any>, start: number, end: number): void {
  const CP: Float64Array = A.CP, CN: Float64Array = A.CN, CPiece: Int32Array = A.CPiece, CB: Uint8Array | undefined = A.CB, E: Float32Array = A.E, V: Float32Array = A.V;
  const GH: Float64Array = A.GH, GS: Int32Array = A.GS, GI: Int32Array = A.GI, GP: Float64Array = A.GP;
  const ox = GH[0], oy = GH[1], oz = GH[2], h = GH[3], gx = GH[4], gy = GH[5], gz = GH[6];
  const w = a.width, f = Math.max(a.width, a.far), f2 = f * f;
  for (let i = start; i < end; i++) {
    if (late(a.deadline, i - start)) throw new Error(PAST_DEADLINE);
    if (CB && CB[i]) { V[i * 2] = 0; V[i * 2 + 1] = 0; continue; }
    let best = E[i], bestF = E[i];
    if (bestF < 1 && f > 0) {
      const px = CP[i * 3], py = CP[i * 3 + 1], pz = CP[i * 3 + 2], nx = CN[i * 3], ny = CN[i * 3 + 1], nz = CN[i * 3 + 2], pc = CPiece[i];
      const x0 = Math.max(0, Math.floor((px - f - ox) / h)), x1 = Math.min(gx - 1, Math.floor((px + f - ox) / h));
      const y0 = Math.max(0, Math.floor((py - f - oy) / h)), y1 = Math.min(gy - 1, Math.floor((py + f - oy) / h));
      const z0 = Math.max(0, Math.floor((pz - f - oz) / h)), z1 = Math.min(gz - 1, Math.floor((pz + f - oz) / h));
      for (let cz = z0; cz <= z1; cz++) for (let cy = y0; cy <= y1; cy++) {
        const row = (cz * gy + cy) * gx;
        for (let k = GS[row + x0], ke = GS[row + x1 + 1]; k < ke; k++) {
          const dx = GP[k * 3] - px, dy = GP[k * 3 + 1] - py, dz = GP[k * 3 + 2] - pz, d2 = dx * dx + dy * dy + dz * dz;
          if (d2 >= f2) continue;
          const q = GI[k], e = E[q];
          if (e <= bestF || CPiece[q] !== pc || (CB && CB[q])) continue;
          if (nx * CN[q * 3] + ny * CN[q * 3 + 1] + nz * CN[q * 3 + 2] < -0.5) continue;
          const d = Math.sqrt(d2), vf = e * (1 - d / f);
          if (vf > bestF) bestF = vf;
          if (d < w) { const v = e * (1 - d / w); if (v > best) best = v; }
        }
      }
    }
    V[i * 2] = best;
    V[i * 2 + 1] = bestF;
  }
}

/** Edge proximity per cloud point at width and far (2 per point; see surfaceSpreadRange) from the edge field E per point. */
export function runSpread(run: RunKernel, sc: SurfaceCloud, E: Float32Array, width: number, far: number, CB: Uint8Array | null = null, deadline = 0): Float32Array | Promise<Float32Array> {
  const c = sc.cloud, V = new Float32Array(c.n * 2);
  const shared: Record<string, any> = { ...sc.grid, CP: c.P, CN: c.N, CPiece: c.piece, E };
  if (CB) shared.CB = CB;
  return afterRun(run('surface_spread', { count: c.n, args: { width, far, deadline }, results: { V }, shared }, { minElements: 8192 }) as any, () => V);
}

export interface EdgeWearArgs {
  seed: number;
  /** breakup feature size and patch size (metres) */
  chipSize: number;
  patchSize: number;
  raggedness: number;
  patchiness: number;
  focusAmount: number;
  deadline?: number;
}

/** Seeds of the edge-wear noises (chips, warp, patches) from the node's seed. */
const wearSeeds = (seed: number) => [hash32(seed ^ 0x6368), hash32(seed ^ 0x7761), hash32(seed ^ 0x7061)];

/**
 * The continuous wear field at texel samples [start, end) into A.V (kernel edge_wear): with handled h (A.HD, optional),
 * edge proximity e blended from the near to the far reach by h (A.PX, 2 per sample), focus f = focusAmount × h, a patch
 * factor p (large 3D patches, 1 ± patchiness) and a chip factor c (3D noise at chipSize, its domain warped by raggedness
 * × 1.5 × chipSize, 0.35..1.65), W = 0.8 e (1 + f) p c + 0.12 f, clamped to 0..1. Where e is 0 the noise is not
 * evaluated (W = 0.12 f): flats only rub, never chip. Positions from the samples' triangles and barycentrics (A.tri,
 * A.b1, A.b2; shared A.tris, A.VP).
 */
export function edgeWearRange(a: EdgeWearArgs, A: Record<string, any>, start: number, end: number): void {
  const PX: Float32Array = A.PX, HD: Float32Array | undefined = A.HD, V: Float32Array = A.V;
  const [sc, sw, sp] = wearSeeds(a.seed);
  const chip = fractal(makeNoise('perlin', sc), { octaves: 5, roughness: 0.55 });
  const wx = fractal(makeNoise('perlin', sw), { octaves: 3, roughness: 0.5 }), wy = fractal(makeNoise('perlin', sw + 1), { octaves: 3, roughness: 0.5 }), wz = fractal(makeNoise('perlin', sw + 2), { octaves: 3, roughness: 0.5 });
  const patch = fractal(makeNoise('perlin', sp), { octaves: 3, roughness: 0.5 });
  const ic = 1 / a.chipSize, iw = 0.5 / a.chipSize, ip = 1 / a.patchSize, warp = 1.5 * a.raggedness * a.chipSize, pz = a.patchiness;
  const p = new Float64Array(3);
  for (let i = start; i < end; i++) {
    if (late(a.deadline, i - start)) throw new Error(PAST_DEADLINE);
    const hd = HD ? HD[i] : 0, e = PX[i * 2] + (PX[i * 2 + 1] - PX[i * 2]) * hd, f = a.focusAmount * hd;
    if (!(e > 0)) { V[i] = 0.12 * f; continue; }
    samplePos(A, i, p);
    const x = p[0], y = p[1], z = p[2];
    let pv = (0.5 + 0.5 * patch(x * ip, y * ip, z * ip) - 0.3) / 0.4;
    pv = pv <= 0 ? 0 : pv >= 1 ? 1 : pv * pv * (3 - 2 * pv);
    const pf = 1 - pz + 2 * pz * pv;
    const ux = x + warp * wx(x * iw, y * iw, z * iw), uy = y + warp * wy(x * iw, y * iw, z * iw), uz = z + warp * wz(x * iw, y * iw, z * iw);
    const c = 0.35 + 1.3 * (0.5 + 0.5 * chip(ux * ic, uy * ic, uz * ic));
    const v = 0.8 * e * (1 + f) * pf * c + 0.12 * f;
    V[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
}

/** The continuous wear field at every texel sample (see edgeWearRange). */
export function runEdgeWear(run: RunKernel, s: { n: number; tri: Int32Array; b1: Float32Array; b2: Float32Array }, tris: Uint32Array, VP: Float64Array, PX: Float32Array, HD: Float32Array | null, args: EdgeWearArgs): Float32Array | Promise<Float32Array> {
  const V = new Float32Array(s.n);
  const shared: Record<string, any> = { tris, VP, PX };
  if (HD) shared.HD = HD;
  return afterRun(run('edge_wear', { count: s.n, args, inputs: { tri: s.tri, b1: s.b1, b2: s.b2 }, results: { V }, shared }) as any, () => V);
}

/**
 * Facets of curved surfaces per piece: for every edge shared by two triangles that bend between 0.5° and 30° (a
 * faceted round: not a flat, not a designed edge), the height of the smaller triangle across it. Returns per piece the
 * median of those (0 when fewer than 16 such edges), for the warning that facets would read as edges.
 */
export function facetSizes(g: Geometry, tris: Uint32Array, triPrim: Uint32Array, piece: Int32Array, pieces: number): Float64Array {
  const VP = vertexPositions(g), vp = g.vertexPoint, nt = triPrim.length;
  const FN = new Float64Array(nt * 3), area2 = new Float64Array(nt);
  for (let t = 0; t < nt; t++) {
    const a = tris[t * 3] * 3, b = tris[t * 3 + 1] * 3, c = tris[t * 3 + 2] * 3;
    const ux = VP[b] - VP[a], uy = VP[b + 1] - VP[a + 1], uz = VP[b + 2] - VP[a + 2], wx = VP[c] - VP[a], wy = VP[c + 1] - VP[a + 1], wz = VP[c + 2] - VP[a + 2];
    const x = uy * wz - uz * wy, y = uz * wx - ux * wz, z = ux * wy - uy * wx, l = Math.hypot(x, y, z);
    area2[t] = l;
    if (l > 0) { FN[t * 3] = x / l; FN[t * 3 + 1] = y / l; FN[t * 3 + 2] = z / l; }
  }
  const first = new Map<number, number>(), sizes: number[][] = Array.from({ length: pieces }, () => []);
  const cosLo = Math.cos((30 * Math.PI) / 180), cosHi = Math.cos((0.5 * Math.PI) / 180);
  for (let t = 0; t < nt; t++) for (let e = 0; e < 3; e++) {
    const va = tris[t * 3 + e], vb = tris[t * 3 + ((e + 1) % 3)], pa = vp[va], pb = vp[vb];
    if (pa === pb) continue;
    const key = pa < pb ? pa * 4294967296 + pb : pb * 4294967296 + pa;
    const o = first.get(key);
    if (o === undefined) { first.set(key, t); continue; }
    const pc = piece[triPrim[t]];
    if (pc < 0 || piece[triPrim[o]] !== pc) continue;
    const d = FN[t * 3] * FN[o * 3] + FN[t * 3 + 1] * FN[o * 3 + 1] + FN[t * 3 + 2] * FN[o * 3 + 2];
    if (!(d < cosHi && d > cosLo)) continue;
    const len = Math.hypot(VP[va * 3] - VP[vb * 3], VP[va * 3 + 1] - VP[vb * 3 + 1], VP[va * 3 + 2] - VP[vb * 3 + 2]);
    if (!(len > 0)) continue;
    sizes[pc].push(Math.min(area2[t], area2[o]) / len);
  }
  const out = new Float64Array(pieces);
  sizes.forEach((v, c) => { if (v.length >= 16) { v.sort((x, y) => x - y); out[c] = v[v.length >> 1]; } });
  return out;
}

/** 3D noise 0..1 at every texel sample. */
export function runNoise(run: RunKernel, s: { n: number; tri: Int32Array; b1: Float32Array; b2: Float32Array }, tris: Uint32Array, VP: Float64Array, args: NoiseArgs): Float32Array | Promise<Float32Array> {
  const V = new Float32Array(s.n);
  return afterRun(run('bake_noise', { count: s.n, args, inputs: { tri: s.tri, b1: s.b1, b2: s.b2 }, results: { V }, shared: { tris, VP } }) as any, () => V);
}

/** Distance (metres) from every texel sample to the target's surface; Infinity beyond maxD. */
export function runDistance(run: RunKernel, s: { n: number; tri: Int32Array; b1: Float32Array; b2: Float32Array }, tris: Uint32Array, VP: Float64Array, target: TriBVH, maxD: number, deadline = 0): Float32Array | Promise<Float32Array> {
  const V = new Float32Array(s.n), b = target.arrays();
  const shared = { T: b.T, nodes: b.nodes, child: b.child, order: b.order, triPt: b.triPt, tris, VP };
  return afterRun(run('bake_distance', { count: s.n, args: { maxD, deadline }, inputs: { tri: s.tri, b1: s.b1, b2: s.b2 }, results: { V }, shared }) as any, () => V);
}
