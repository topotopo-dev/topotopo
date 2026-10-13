// Rigid-body settling for procedural assembly: Houdini's "RBD drop / settle" idiom (rocks dropped onto a terrain, crates
// stacked into a pile, a container filled), on top of the Rapier physics engine (@dimforge/rapier3d-compat, WASM).
//
// Host-agnostic: the caller loads Rapier (src/wasm/rapier.ts) and passes the module in.
//
//  1. collectRbdScene: input geometry → pieces. A packed prim is one piece; its source's convex hull is computed once
//     per source and every instance applies its own scale/shear U to it (hulls commute with linear maps). Polygons
//     are grouped into pieces by a prim attribute (`piece`, `copynum`, `name`) or by connectivity. Points shared
//     between pieces are split first, so a piece moves on its own. A piece's body frame: packed = the anchor and the
//     rotation part Q of packedXform = Q·U; unpacked = its bounding-box centre, unrotated.
//  2. RbdSim: a Rapier world with the static colliders (ground plane, input-1 triangles, pieces with `active` = 0) and
//     one dynamic body per piece, inserted in a stable spatial order (input order does not matter) with a seeded tiny
//     jitter that breaks perfectly symmetric stacks. It steps at a fixed rate until every piece is asleep or slower than
//     the settle threshold for CALM_TIME seconds, or a step limit; pieces that stay nearly at rest get extra damping
//     (rest damping) so slow wobbling ends. Stack mode drops the pieces one at a time, lifting each above whatever is
//     already under it. advance(n) can be called again with a larger n (animated cooks resume).
//  3. applyRbd: the settled transforms back into a copy of the geometry (packed: anchor P and packedXform; unpacked: P
//     and the vectors N/up/orient/…), plus point attributes v, w, settled and contacts and the point group `fallen`.
//
// Determinism: Rapier's WASM build is deterministic for one build of the library (IEEE-754 arithmetic in WASM has no
// platform-dependent rounding; no SIMD, threads or random hashing are involved). Same inputs, params and seed give the
// same output bit for bit; a different Rapier version may settle differently.
import { AttribTable, Geometry } from './geometry.ts';
import type { Attribute } from './geometry.ts';
import { connectivity, triangulate } from './topology.ts';
import { expandPacked, flattenSource } from './packed.ts';
import { heightfieldsOf, heightfieldToMesh } from './heightfield.ts';
import { qFromMat, qMul, qNormalize } from './math.ts';
import { rand } from './random.ts';
import type { Quat, Vec3 } from './math.ts';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { Collider, RigidBody, Shape, World } from '@dimforge/rapier3d-compat';

type Rapier = typeof RAPIER;

export const RBD_SHAPES = ['convex_hull', 'box', 'sphere', 'mesh'] as const;
export type RbdShapeKind = (typeof RBD_SHAPES)[number];
export const RBD_PIECE_MODES = ['auto', 'connectivity', 'name', 'attrib'] as const;
export type RbdPieceMode = (typeof RBD_PIECE_MODES)[number];

/** A collision shape in a body's frame. */
export interface RbdShape {
  kind: 'hull' | 'box' | 'sphere' | 'mesh';
  /** points in the shape's frame (unpacked: the body frame; packed: the source frame, instances apply their U) */
  points: Float32Array;
  /** mesh: triangles (indices into points) */
  indices?: Uint32Array;
  /** largest distance of a point from the body origin */
  radius: number;
}

export interface RbdPiece {
  packed: boolean;
  /** packed: the packed prim; unpacked: the piece's first prim */
  prim: number;
  /** packed: the anchor point (-1 for unpacked pieces) */
  anchor: number;
  /** the points that move with the piece (packed: the anchor) */
  points: Int32Array;
  /** body origin in the input pose */
  origin: Vec3;
  /** body rotation in the input pose (packed: Q of packedXform = Q·U; unpacked: identity) */
  rot: Quat;
  /** packed: U, the body-frame scale/shear (3×3 column-major), so that packedXform = R(rot)·U */
  U: Float64Array | null;
  shape: number;
  /** `active` = 0: the piece does not move but others collide with it */
  fixed: boolean;
  v: Vec3;
  w: Vec3;
}

export interface RbdScene {
  /** a copy of the input with the points shared between pieces split (applyRbd writes into a copy of it) */
  geo: Geometry;
  pieces: RbdPiece[];
  shapes: RbdShape[];
  /** index into pieces of every prim (-1: none) */
  primPiece: Int32Array;
  notes: string[];
}

export interface RbdCollectOptions {
  pieces: RbdPieceMode;
  pieceAttrib: string;
  shape: RbdShapeKind;
}

// ------------------------------------------------------------------ small math

/** R(q) as a 3×3 column-major matrix. */
export function quatToMat3(q: ArrayLike<number>, out: Float64Array = new Float64Array(9)): Float64Array {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  out[0] = 1 - 2 * (yy + zz); out[1] = 2 * (xy + wz); out[2] = 2 * (xz - wy);
  out[3] = 2 * (xy - wz); out[4] = 1 - 2 * (xx + zz); out[5] = 2 * (yz + wx);
  out[6] = 2 * (xz + wy); out[7] = 2 * (yz - wx); out[8] = 1 - 2 * (xx + yy);
  return out;
}

/** A · B for 3×3 column-major matrices. */
function mul3(A: ArrayLike<number>, B: ArrayLike<number>, out: Float64Array = new Float64Array(9)): Float64Array {
  for (let c = 0; c < 3; c++)
    for (let r = 0; r < 3; r++) out[c * 3 + r] = A[r] * B[c * 3] + A[3 + r] * B[c * 3 + 1] + A[6 + r] * B[c * 3 + 2];
  return out;
}

/** Aᵀ · B for 3×3 column-major matrices. */
function mul3T(A: ArrayLike<number>, B: ArrayLike<number>, out: Float64Array = new Float64Array(9)): Float64Array {
  for (let c = 0; c < 3; c++)
    for (let r = 0; r < 3; r++) out[c * 3 + r] = A[r * 3] * B[c * 3] + A[r * 3 + 1] * B[c * 3 + 1] + A[r * 3 + 2] * B[c * 3 + 2];
  return out;
}

/**
 * M = Q·U with Q a rotation (Gram-Schmidt on M's columns, right-handed) and U = Qᵀ·M (upper triangular; a negative
 * last diagonal entry when M mirrors). Degenerate columns fall back to Q = identity.
 */
export function rotationScale(M: ArrayLike<number>): { q: Quat; Q: Float64Array; U: Float64Array } {
  const c0: Vec3 = [M[0], M[1], M[2]], c1: Vec3 = [M[3], M[4], M[5]];
  const l0 = Math.hypot(c0[0], c0[1], c0[2]);
  let Q: Float64Array;
  if (!(l0 > 1e-12)) Q = Float64Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1);
  else {
    const x: Vec3 = [c0[0] / l0, c0[1] / l0, c0[2] / l0];
    const d = x[0] * c1[0] + x[1] * c1[1] + x[2] * c1[2];
    let y: Vec3 = [c1[0] - d * x[0], c1[1] - d * x[1], c1[2] - d * x[2]];
    const l1 = Math.hypot(y[0], y[1], y[2]);
    if (!(l1 > 1e-12 * Math.max(1, l0))) {
      // second column parallel to the first: any perpendicular
      const a: Vec3 = Math.abs(x[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      const e = a[0] * x[0] + a[1] * x[1] + a[2] * x[2];
      y = [a[0] - e * x[0], a[1] - e * x[1], a[2] - e * x[2]];
      const l = Math.hypot(y[0], y[1], y[2]);
      y = [y[0] / l, y[1] / l, y[2] / l];
    } else y = [y[0] / l1, y[1] / l1, y[2] / l1];
    const z: Vec3 = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
    Q = Float64Array.of(x[0], x[1], x[2], y[0], y[1], y[2], z[0], z[1], z[2]);
  }
  const m4 = new Float64Array(16);
  m4[0] = Q[0]; m4[1] = Q[1]; m4[2] = Q[2]; m4[4] = Q[3]; m4[5] = Q[4]; m4[6] = Q[5]; m4[8] = Q[6]; m4[9] = Q[7]; m4[10] = Q[8]; m4[15] = 1;
  return { q: qFromMat(m4), Q, U: mul3T(Q, M) };
}

// ------------------------------------------------------------------ pieces

/** Value of a numeric attribute (point or prim) as a 3-vector, averaged over points; null when absent. */
function vec3Of(g: Geometry, name: string, pts: ArrayLike<number>, prim: number): Vec3 | null {
  const pa = g.points.get(name);
  if (pa && pa.type === 'float' && pa.size === 3 && !pa.isArray && pts.length) {
    const d = pa.data as Float64Array, s: Vec3 = [0, 0, 0];
    for (let i = 0; i < pts.length; i++) { const o = pts[i] * 3; s[0] += d[o]; s[1] += d[o + 1]; s[2] += d[o + 2]; }
    return [s[0] / pts.length, s[1] / pts.length, s[2] / pts.length];
  }
  const ra = g.prims.get(name);
  if (ra && ra.type === 'float' && ra.size === 3 && !ra.isArray && prim >= 0) {
    const d = ra.data as Float64Array;
    return [d[prim * 3], d[prim * 3 + 1], d[prim * 3 + 2]];
  }
  return null;
}

/** `active` (prim, else point) of a piece: false when it is 0. Absent = active. */
function isActive(g: Geometry, pts: ArrayLike<number>, prim: number): boolean {
  for (const [a, i] of [[g.prims.get('active'), prim], [g.points.get('active'), pts.length ? pts[0] : -1]] as [Attribute | undefined, number][]) {
    if (!a || a.isArray || a.type === 'string' || i < 0) continue;
    return (a.data as Float64Array | Int32Array)[i * a.size] !== 0;
  }
  return true;
}

/** Piece key of every prim (-1 = no piece): packed prims are pieces of their own, polygons grouped by mode. */
function primPieces(g: Geometry, o: RbdCollectOptions): { key: Int32Array; count: number; by: string } {
  const n = g.numPrims, key = new Int32Array(n).fill(-1);
  const kind = g.primKind;
  let by: string = o.pieces;
  let values: ((p: number) => string | number) | null = null;
  const primAttr = (name: string) => {
    const a = g.prims.get(name);
    if (a) return (p: number) => (a.isArray ? JSON.stringify(a.get(p)) : a.type === 'string' ? (a.data as string[])[p] : a.size === 1 ? (a.data as any)[p] : JSON.stringify(a.get(p)));
    const pa = g.points.get(name);
    if (pa) return (p: number) => { const v = g.primStart[p]; return JSON.stringify(pa.get(g.vertexPoint[v])); };
    return null;
  };
  if (o.pieces === 'auto') {
    for (const name of ['piece', 'copynum', 'name']) if (g.prims.has(name)) { values = primAttr(name); by = name; break; }
    if (!values) by = 'connectivity';
  } else if (o.pieces === 'name' || o.pieces === 'attrib') {
    const name = o.pieces === 'name' ? 'name' : o.pieceAttrib;
    if (!name) throw new Error('pieces = "attrib" needs piece_attrib (a prim attribute naming the pieces)');
    values = primAttr(name);
    if (!values) throw new Error(`no prim attribute "${name}" to split pieces by (prim attributes: ${g.prims.names().join(', ') || 'none'})`);
    by = name;
  }
  const classes = !values ? connectivity(g).primClass : null;
  const ids = new Map<string | number, number>();
  let count = 0;
  for (let p = 0; p < n; p++) {
    if (g.primStart[p + 1] === g.primStart[p]) continue;
    if (kind && kind[p] === 1) { key[p] = count++; continue; }
    if (kind && kind[p] >= 2) continue; // spline prims are converted by the engine before the cook
    const k = values ? values(p) : classes![p];
    let id = ids.get(k);
    if (id === undefined) { id = count++; ids.set(k, id); }
    key[p] = id;
  }
  return { key, count, by };
}

/**
 * Make every point belong to one piece: a point used by prims of several pieces is copied for each further piece
 * (attributes and groups copied too). Returns the owner piece of every point (-1: loose or unused).
 */
function splitSharedPoints(g: Geometry, primPiece: Int32Array): Int32Array {
  const np = g.numPoints, owner = new Int32Array(np).fill(-1);
  const extra: number[] = [], extraOwner: number[] = [];
  const copies = new Map<number, number>(); // point * pieces + piece → new point
  const vp = g.vertexPoint;
  const stride = primPiece.length + 1;
  for (let p = 0; p < g.numPrims; p++) {
    const k = primPiece[p];
    if (k < 0) continue;
    for (let v = g.primStart[p]; v < g.primStart[p + 1]; v++) {
      const pt = vp[v];
      if (owner[pt] === -1) owner[pt] = k;
      else if (owner[pt] !== k) {
        const key = pt * stride + k;
        let c = copies.get(key);
        if (c === undefined) { c = np + extra.length; extra.push(pt); extraOwner.push(k); copies.set(key, c); }
        vp[v] = c;
      }
    }
  }
  if (!extra.length) return owner;
  const idx = new Int32Array(np + extra.length);
  for (let i = 0; i < np; i++) idx[i] = i;
  for (let i = 0; i < extra.length; i++) idx[np + i] = extra[i];
  g.points = g.points.gather(idx);
  for (const [name, m] of g.pointGroups) {
    const out = new Uint8Array(idx.length);
    for (let i = 0; i < idx.length; i++) out[i] = m[idx[i]];
    g.pointGroups.set(name, out);
  }
  const all = new Int32Array(idx.length);
  all.set(owner);
  for (let i = 0; i < extra.length; i++) all[np + i] = extraOwner[i];
  return all;
}

/** Triangles of a geometry as point indices (closed polygons only). */
function pointTriangles(g: Geometry, primMask?: ArrayLike<number> | null): { tris: Uint32Array; triPrim: Uint32Array } {
  const t = triangulate(g, primMask);
  const out = new Uint32Array(t.tris.length);
  for (let i = 0; i < out.length; i++) out[i] = g.vertexPoint[t.tris[i]];
  return { tris: out, triPrim: t.triPrim };
}

/**
 * The pieces of `src` (input 0 of the rbd nodes), with their collision shapes. Throws an Error with a readable
 * message on a bad piece attribute.
 */
export function collectRbdScene(src: Geometry, o: RbdCollectOptions): RbdScene {
  const notes: string[] = [];
  const g = src.clone();
  const { key: primPiece, count } = primPieces(g, o);
  const owner = splitSharedPoints(g, primPiece);
  const P = g.P;
  // members of each piece
  const firstPrim = new Int32Array(count).fill(-1);
  for (let p = 0; p < g.numPrims; p++) { const k = primPiece[p]; if (k >= 0 && firstPrim[k] < 0) firstPrim[k] = p; }
  const ptCount = new Int32Array(count + 1);
  for (let i = 0; i < owner.length; i++) if (owner[i] >= 0) ptCount[owner[i] + 1]++;
  for (let k = 0; k < count; k++) ptCount[k + 1] += ptCount[k];
  const ptList = new Int32Array(ptCount[count]), fill = ptCount.slice(0, count);
  for (let i = 0; i < owner.length; i++) if (owner[i] >= 0) ptList[fill[owner[i]]++] = i;
  // triangles of unpacked pieces, only when a static piece may need its mesh
  let meshTris: { tris: Uint32Array; triPrim: Uint32Array } | null = null;
  const shapes: RbdShape[] = [];
  const shapeIds = new Map<string, number>();
  const pieces: RbdPiece[] = [];
  const keyPiece = new Int32Array(count).fill(-1);
  let meshFallback = 0, degenerate = 0;
  const kind = g.primKind;
  const wantShape = (fixed: boolean): RbdShape['kind'] => {
    if (o.shape === 'mesh') {
      if (fixed) return 'mesh';
      meshFallback++;
      return 'hull';
    }
    return o.shape === 'convex_hull' ? 'hull' : o.shape;
  };
  for (let k = 0; k < count; k++) {
    const prim = firstPrim[k];
    const pts = ptList.subarray(ptCount[k], ptCount[k + 1]);
    const packed = !!kind && kind[prim] === 1;
    const fixed = !isActive(g, pts, prim);
    const v = vec3Of(g, 'v', pts, prim) ?? [0, 0, 0], w = vec3Of(g, 'w', pts, prim) ?? [0, 0, 0];
    const sk = wantShape(fixed);
    if (packed) {
      const s = g.packedSource![prim], a = g.vertexPoint[g.primStart[prim]];
      const M = g.packedXform!.subarray(prim * 9, prim * 9 + 9);
      const { q, U } = rotationScale(M);
      const id = `${s}|${sk}`;
      let si = shapeIds.get(id);
      if (si === undefined) {
        const shape = sourceShape(flattenSource(g.packedSources[s]), sk);
        if (!shape) { degenerate++; continue; }
        si = shapes.length;
        shapes.push(shape);
        shapeIds.set(id, si);
      }
      keyPiece[k] = pieces.length;
      pieces.push({ packed: true, prim, anchor: a, points: Int32Array.of(a), origin: [P[a * 3], P[a * 3 + 1], P[a * 3 + 2]], rot: q, U, shape: si, fixed, v, w });
      continue;
    }
    if (pts.length === 0) { degenerate++; continue; }
    // body origin: bounding-box centre
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pts.length; i++) for (let c = 0; c < 3; c++) { const x = P[pts[i] * 3 + c]; if (x < lo[c]) lo[c] = x; if (x > hi[c]) hi[c] = x; }
    const origin: Vec3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    // the shape's points in a canonical order (by position), so the hull does not depend on the point numbering
    const sorted = Array.from(pts).sort((a, b) => P[a * 3] - P[b * 3] || P[a * 3 + 1] - P[b * 3 + 1] || P[a * 3 + 2] - P[b * 3 + 2] || a - b);
    const local = new Float32Array(pts.length * 3);
    let r2 = 0;
    for (let i = 0; i < sorted.length; i++) {
      const x = P[sorted[i] * 3] - origin[0], y = P[sorted[i] * 3 + 1] - origin[1], z = P[sorted[i] * 3 + 2] - origin[2];
      local[i * 3] = x; local[i * 3 + 1] = y; local[i * 3 + 2] = z;
      r2 = Math.max(r2, x * x + y * y + z * z);
    }
    const shape: RbdShape = { kind: sk, points: local, radius: Math.sqrt(r2) };
    if (sk === 'mesh') {
      meshTris ??= pointTriangles(g);
      const localIndex = new Map<number, number>();
      for (let i = 0; i < sorted.length; i++) localIndex.set(sorted[i], i);
      const tris: number[] = [];
      for (let t = 0; t < meshTris.triPrim.length; t++) {
        if (primPiece[meshTris.triPrim[t]] !== k) continue;
        tris.push(localIndex.get(meshTris.tris[t * 3])!, localIndex.get(meshTris.tris[t * 3 + 1])!, localIndex.get(meshTris.tris[t * 3 + 2])!);
      }
      if (tris.length) shape.indices = Uint32Array.from(tris);
      else shape.kind = 'hull';
    }
    shapes.push(shape);
    keyPiece[k] = pieces.length;
    pieces.push({ packed: false, prim, anchor: -1, points: pts.slice(), origin, rot: [0, 0, 0, 1], U: null, shape: shapes.length - 1, fixed, v, w });
  }
  for (let p = 0; p < primPiece.length; p++) if (primPiece[p] >= 0) primPiece[p] = keyPiece[primPiece[p]];
  if (meshFallback) notes.push(`collision_shape "mesh" is for static pieces (active = 0); ${meshFallback} moving piece${meshFallback === 1 ? '' : 's'} use convex_hull`);
  if (degenerate) notes.push(`${degenerate} piece${degenerate === 1 ? ' has' : 's have'} no points and stay${degenerate === 1 ? 's' : ''} where ${degenerate === 1 ? 'it is' : 'they are'}`);
  return { geo: g, pieces, shapes, primPiece, notes };
}

/**
 * A packed source's collision shape in the source's frame. Instances apply their U (scale/shear) to the hull, which is
 * the hull of the transformed points too (hulls commute with linear maps), so the hull is computed once per source.
 */
function sourceShape(src: Geometry, kind: RbdShape['kind']): RbdShape | null {
  const n = src.numPoints;
  if (!n) return null;
  const P = src.P, pts = new Float32Array(n * 3);
  // canonical point order, as for unpacked pieces: the same piece packed or not gets the same hull
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => P[a * 3] - P[b * 3] || P[a * 3 + 1] - P[b * 3 + 1] || P[a * 3 + 2] - P[b * 3 + 2] || a - b);
  const slot = new Int32Array(n);
  let r2 = 0;
  order.forEach((i, k) => {
    slot[i] = k;
    pts[k * 3] = P[i * 3]; pts[k * 3 + 1] = P[i * 3 + 1]; pts[k * 3 + 2] = P[i * 3 + 2];
    r2 = Math.max(r2, P[i * 3] * P[i * 3] + P[i * 3 + 1] * P[i * 3 + 1] + P[i * 3 + 2] * P[i * 3 + 2]);
  });
  const shape: RbdShape = { kind, points: pts, radius: Math.sqrt(r2) };
  if (kind === 'mesh') {
    const t = pointTriangles(src);
    if (t.tris.length) shape.indices = t.tris.map((i) => slot[i]);
    else shape.kind = 'hull';
  }
  return shape;
}

// ------------------------------------------------------------------ static colliders

export interface RbdStaticMesh {
  vertices: Float32Array;
  indices: Uint32Array;
}

/**
 * The collision triangles of input 1 (world frame): its polygons (packed instances expanded) and its heightfields
 * (as the triangles heightfield_to_mesh draws). Null when there is nothing to collide with.
 */
export function staticMesh(g: Geometry, notes: string[]): RbdStaticMesh | null {
  const parts: Geometry[] = [];
  if (g.numPrims) parts.push(g.hasPacked() ? expandPacked(g).geo : g);
  for (const hf of heightfieldsOf(g)) parts.push(heightfieldToMesh(hf, { normals: false }));
  if (g.volumes.some((v) => v.kind === 'sdf' || v.kind === 'grid')) notes.push('SDF volumes in the collision input are ignored (convert them to polygons first)');
  let nv = 0, nt = 0;
  const tri = parts.map((p) => { const t = pointTriangles(p); nv += p.numPoints; nt += t.tris.length; return t; });
  if (!nt) return null;
  const vertices = new Float32Array(nv * 3), indices = new Uint32Array(nt);
  let vo = 0, to = 0;
  parts.forEach((p, i) => {
    const P = p.P;
    for (let k = 0; k < P.length; k++) vertices[vo * 3 + k] = P[k];
    const t = tri[i].tris;
    for (let k = 0; k < t.length; k++) indices[to + k] = t[k] + vo;
    vo += p.numPoints; to += t.length;
  });
  return { vertices, indices };
}

// ------------------------------------------------------------------ simulation

export interface RbdStackOptions {
  /** steps between two drops */
  interval: number;
  /** raise a piece above whatever is already under its drop position */
  lift: boolean;
  /** gap left above the pile when lifting (m) */
  clearance: number;
  order: 'input' | 'height' | 'random';
}

export interface RbdSimOptions {
  gravity: Vec3;
  friction: number;
  restitution: number;
  /** kg/m³ */
  density: number;
  linearDamping: number;
  angularDamping: number;
  /** seconds per step */
  dt: number;
  /** hard limit on steps (the simulation also ends once everything has settled) */
  maxSteps: number;
  solverIterations: number;
  /** m/s: a piece slower than this (and turning slower than this / its radius) counts as settled */
  sleepThreshold: number;
  /** continuous collision detection for fast pieces */
  ccd: boolean;
  /** most vertices of a convex hull (0 = the exact hull); see reduceHull */
  hullPoints: number;
  /**
   * angular damping added to a piece that has been nearly at rest for REST_TIME (linear: 40 % of it), so slow wobbling
   * and creeping end; removed when the piece speeds up again. 0 = off
   */
  restDamping: number;
  /** height of the ground plane, null = none */
  ground: number | null;
  seed: number;
  /** jitter as a fraction of each piece's radius (offset) and in radians (tilt) */
  jitter: number;
  stack: RbdStackOptions | null;
}

export interface RbdResult {
  /** per piece: final body translation and rotation (x, y, z, w) */
  t: Float64Array;
  q: Float64Array;
  /** per piece: centre of mass, linear and angular velocity at the end */
  com: Float64Array;
  v: Float64Array;
  w: Float64Array;
  settled: Uint8Array;
  contacts: Int32Array;
  fallen: Uint8Array;
  /** 0 for pieces stack mode has not dropped yet */
  spawned: Uint8Array;
  steps: number;
  /** why the simulation ended: settled, asleep, steps, frame (an animated cook stopped at its frame) */
  reason: string;
  /** deepest overlap between two colliders at the end (m) */
  maxPenetration: number;
  /** pieces overlapping another piece at the start by more than 5 % of their radius (settle mode) */
  startOverlaps: number;
}

/** Seconds every piece must stay below the settle threshold before the simulation ends. */
export const CALM_TIME = 0.5;
/** Steps between two settle / fall checks. */
const CHECK = 5;
/** Rest damping: a piece slower than REST_FACTOR × the settle threshold for REST_TIME seconds is damped (restDamping). */
const REST_FACTOR = 4, REST_TIME = 0.5;
/** ... and released when it speeds up past RELEASE_FACTOR × the threshold again (pushed, or rolling off). */
const RELEASE_FACTOR = 10;

interface BodyState {
  body: RigidBody | null;
  collider: Collider | null;
  /** the shape again, for the stack mode's downward casts */
  castShape: Shape | null;
  castOffset: Vec3;
  t: Vec3;
  q: Quat;
  fallen: boolean;
  /** pose and velocities kept when a fallen body is removed */
  last: { t: Vec3; q: Quat; com: Vec3; v: Vec3; w: Vec3 } | null;
  /** seconds the piece has been nearly at rest (below REST_FACTOR × the settle threshold) */
  slow: number;
  /** rest damping applied */
  braked: boolean;
}

/**
 * A shape's collision data, computed once per shape: the (reduced) convex hull from Rapier's quickhull in a scratch
 * world, or the mesh. Box and sphere shapes keep the hull vertices too: they bound the same extreme points.
 */
interface BuiltShape {
  kind: 'hull' | 'box' | 'sphere' | 'mesh';
  /** hull or mesh vertices (all points when there is no hull) in the shape's frame */
  vertices: Float32Array;
  /** hull or mesh triangles */
  indices?: Uint32Array;
}

/** A piece's collision shape in its body frame (BuiltShape with the piece's U applied). */
interface Inst {
  kind: 'hull' | 'box' | 'sphere' | 'mesh';
  vertices: Float32Array;
  indices?: Uint32Array;
  /** box and sphere: centre in the body frame; box half extents; sphere radius */
  center: Vec3;
  half: Vec3;
  radius: number;
  /** largest distance of a vertex from the body origin */
  extent: number;
}

/**
 * A Rapier world for one rbd cook. Construction builds every collider and body (stack mode: only the static ones);
 * advance(n) steps until step n or until the pieces have settled; read() returns the poses. free() releases the WASM
 * memory (the world is not garbage collected).
 */
export class RbdSim {
  readonly R: Rapier;
  readonly world: World;
  readonly scene: RbdScene;
  readonly o: RbdSimOptions;
  step = 0;
  done = false;
  reason = '';
  private states: BodyState[];
  private inst: Inst[];
  private queue: number[] = [];
  private calm = 0;
  /** per piece: below this height it can only fall further (under every collider), see `fall` */
  private killY: Float64Array;
  private topY: number;
  private startOverlaps = 0;

  constructor(R: Rapier, scene: RbdScene, statics: RbdStaticMesh | null, o: RbdSimOptions) {
    this.R = R;
    this.scene = scene;
    this.o = o;
    const world = (this.world = new R.World({ x: o.gravity[0], y: o.gravity[1], z: o.gravity[2] }));
    world.timestep = o.dt;
    world.numSolverIterations = Math.max(1, Math.round(o.solverIterations));
    const pieces = scene.pieces;
    // hulls are computed by Rapier in a scratch world (one for all shapes)
    const scratch = new R.World({ x: 0, y: 0, z: 0 });
    let built: BuiltShape[];
    try { built = scene.shapes.map((s) => buildShape(R, scratch, s, o.hullPoints)); } finally { scratch.free(); }
    const inst = (this.inst = pieces.map((p) => instanceShape(built[p.shape], p.U)));
    // Rapier's length unit: the median piece size (its tolerances and own sleep thresholds scale with it)
    const sizes = inst.map((b) => b.extent * 2).filter((s) => s > 0).sort((a, b) => a - b);
    world.lengthUnit = Math.min(1000, Math.max(0.001, sizes.length ? sizes[sizes.length >> 1] : 1));
    // scene bounds: pieces and statics
    let lo = Infinity, hi = -Infinity, ext = 0, floor = Infinity;
    const cx = [0, 0], cn = [Infinity, -Infinity, Infinity, -Infinity];
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i], r = inst[i].extent;
      lo = Math.min(lo, p.origin[1] - r); hi = Math.max(hi, p.origin[1] + r);
      if (p.fixed) floor = Math.min(floor, p.origin[1] - r);
      cn[0] = Math.min(cn[0], p.origin[0] - r); cn[1] = Math.max(cn[1], p.origin[0] + r);
      cn[2] = Math.min(cn[2], p.origin[2] - r); cn[3] = Math.max(cn[3], p.origin[2] + r);
    }
    if (statics) {
      const V = statics.vertices;
      for (let i = 0; i < V.length; i += 3) {
        lo = Math.min(lo, V[i + 1]); hi = Math.max(hi, V[i + 1]); floor = Math.min(floor, V[i + 1]);
        cn[0] = Math.min(cn[0], V[i]); cn[1] = Math.max(cn[1], V[i]);
        cn[2] = Math.min(cn[2], V[i + 2]); cn[3] = Math.max(cn[3], V[i + 2]);
      }
    }
    if (o.ground !== null) { lo = Math.min(lo, o.ground); hi = Math.max(hi, o.ground); floor = Math.min(floor, o.ground); }
    if (!Number.isFinite(lo)) { lo = 0; hi = 0; cn[0] = cn[2] = -1; cn[1] = cn[3] = 1; }
    cx[0] = (cn[0] + cn[1]) / 2; cx[1] = (cn[2] + cn[3]) / 2;
    ext = Math.max(cn[1] - cn[0], cn[3] - cn[2], hi - lo, 1);
    // a piece whose origin is more than twice its radius below the lowest collider can never land again; with nothing
    // to land on at all, pieces fall freely for a while (10 m or the scene size) before they count as fallen
    this.killY = Float64Array.from(inst, (b) => (Number.isFinite(floor) ? floor - 2 * b.extent - 1e-3 : lo - Math.max(10, ext)));
    this.topY = hi;
    // static colliders: ground, input-1 triangles
    if (o.ground !== null) {
      const half = Math.max(50, 4 * ext), th = Math.max(1, ext / 20);
      world.createCollider(R.ColliderDesc.cuboid(half, th / 2, half).setTranslation(cx[0], o.ground - th / 2, cx[1]).setFriction(o.friction).setRestitution(o.restitution));
    }
    if (statics) {
      let desc;
      try {
        desc = R.ColliderDesc.trimesh(statics.vertices, statics.indices, R.TriMeshFlags.FIX_INTERNAL_EDGES_TWO_SIDED);
        world.createCollider(desc.setFriction(o.friction).setRestitution(o.restitution));
      } catch {
        world.createCollider(R.ColliderDesc.trimesh(statics.vertices, statics.indices).setFriction(o.friction).setRestitution(o.restitution));
      }
    }
    // bodies in a stable order: by input position (so permuting the input does not change the result), ties by index
    const order = pieces.map((_, i) => i);
    const q6 = (x: number) => Math.round(x * 1e6);
    order.sort((a, b) => {
      const A = pieces[a].origin, B = pieces[b].origin;
      return q6(A[1]) - q6(B[1]) || q6(A[0]) - q6(B[0]) || q6(A[2]) - q6(B[2]) || a - b;
    });
    this.states = pieces.map((p) => ({ body: null, collider: null, castShape: null, castOffset: [0, 0, 0], t: p.origin, q: p.rot, fallen: false, last: null, slow: 0, braked: false }));
    // jitter, seeded by the rank in that order (input order independent)
    if (o.jitter > 0) {
      order.forEach((i, rank) => {
        const p = pieces[i];
        if (p.fixed) return;
        const r = inst[i].extent, j = o.jitter;
        const u = (c: number) => rand(rank * 8 + c, o.seed) * 2 - 1;
        const st = this.states[i];
        st.t = [p.origin[0] + u(0) * j * r, p.origin[1], p.origin[2] + u(1) * j * r];
        let ax: Vec3 = [u(2), u(3), u(4)];
        const l = Math.hypot(ax[0], ax[1], ax[2]) || 1;
        ax = [ax[0] / l, ax[1] / l, ax[2] / l];
        const ang = j * (0.5 + 0.5 * rand(rank * 8 + 5, o.seed)), s = Math.sin(ang / 2);
        st.q = qNormalize(qMul([ax[0] * s, ax[1] * s, ax[2] * s, Math.cos(ang / 2)], p.rot));
      });
    }
    // fixed pieces now; moving pieces now (settle) or queued (stack)
    for (const i of order) if (pieces[i].fixed) this.addBody(i);
    const moving = order.filter((i) => !pieces[i].fixed);
    if (o.stack) {
      if (o.stack.order === 'input') moving.sort((a, b) => a - b);
      else if (o.stack.order === 'height') moving.sort((a, b) => pieces[a].origin[1] - pieces[b].origin[1] || a - b);
      else {
        // seeded shuffle of the spatial order
        const keyed = moving.map((i, rank) => ({ i, k: rand(rank * 8 + 7, o.seed + 1) }));
        keyed.sort((a, b) => a.k - b.k || a.i - b.i);
        moving.splice(0, moving.length, ...keyed.map((x) => x.i));
      }
      this.queue = moving;
      // one step with only the static colliders, so the first drop's lift cast sees them (queries use the broad
      // phase, which a step updates)
      world.step();
    } else for (const i of moving) this.addBody(i);
  }

  private addBody(i: number) {
    const R = this.R, o = this.o, p = this.scene.pieces[i], st = this.states[i], b = this.inst[i];
    const desc = p.fixed ? R.RigidBodyDesc.fixed() : R.RigidBodyDesc.dynamic();
    desc.setTranslation(st.t[0], st.t[1], st.t[2]).setRotation({ x: st.q[0], y: st.q[1], z: st.q[2], w: st.q[3] });
    if (!p.fixed) {
      desc.setLinvel(p.v[0], p.v[1], p.v[2]).setAngvel({ x: p.w[0], y: p.w[1], z: p.w[2] });
      desc.setLinearDamping(o.linearDamping).setAngularDamping(o.angularDamping).setCcdEnabled(o.ccd);
    }
    const body = this.world.createRigidBody(desc);
    const cd = colliderDesc(R, b);
    cd.setDensity(o.density).setFriction(o.friction).setRestitution(o.restitution);
    st.collider = this.world.createCollider(cd, body);
    st.body = body;
  }

  /** Stack mode: add the next queued piece, lifted above what is under it. */
  private drop() {
    const i = this.queue.shift()!;
    const st = this.states[i], b = this.inst[i], so = this.o.stack!;
    if (so.lift) {
      const R = this.R;
      st.castShape ??= castShapeOf(R, b);
      // box and sphere casts are centred on the origin: offset them by the collider's centre, rotated
      const rq = quatToMat3(st.q), c: Vec3 = b.kind === 'box' || b.kind === 'sphere' ? b.center : [0, 0, 0];
      st.castOffset = [rq[0] * c[0] + rq[3] * c[1] + rq[6] * c[2], rq[1] * c[0] + rq[4] * c[1] + rq[7] * c[2], rq[2] * c[0] + rq[5] * c[1] + rq[8] * c[2]];
      const start = Math.max(st.t[1], this.topY + 2 * b.extent + so.clearance + 1e-3);
      const span = start - st.t[1];
      if (span > 1e-9) {
        const hit = this.world.castShape(
          { x: st.t[0] + st.castOffset[0], y: start + st.castOffset[1], z: st.t[2] + st.castOffset[2] },
          { x: st.q[0], y: st.q[1], z: st.q[2], w: st.q[3] },
          { x: 0, y: -1, z: 0 }, st.castShape, 0, span, false,
        );
        if (hit) st.t = [st.t[0], Math.max(st.t[1], start - hit.time_of_impact + so.clearance), st.t[2]];
      }
    }
    this.addBody(i);
    this.topY = Math.max(this.topY, st.t[1] + b.extent);
  }

  /** Step until `target` steps were taken in total, or the pieces have settled. */
  advance(target: number): void {
    const o = this.o;
    const limit = Math.min(target, o.maxSteps);
    const interval = o.stack ? Math.max(1, Math.round(o.stack.interval)) : 1;
    while (!this.done && this.step < limit) {
      if (this.queue.length && this.step % interval === 0) this.drop();
      this.world.step();
      this.step++;
      if (this.step === 1 && !o.stack) this.startOverlaps = this.countOverlaps();
      if (this.step % CHECK === 0) this.check();
    }
    if (!this.done && this.step >= o.maxSteps) { this.done = true; this.reason = 'steps'; }
    if (!this.done) this.reason = 'frame';
  }

  /** Settle and fall checks every CHECK steps. */
  private check() {
    const thr = this.o.sleepThreshold;
    let calm = true, asleep = true;
    const v = { x: 0, y: 0, z: 0 }, w = { x: 0, y: 0, z: 0 }, t = { x: 0, y: 0, z: 0 };
    const pieces = this.scene.pieces, o = this.o, step = CHECK * o.dt;
    for (let i = 0; i < this.states.length; i++) {
      const st = this.states[i], body = st.body;
      if (!body || st.fallen || pieces[i].fixed) continue;
      if (body.isSleeping()) continue;
      asleep = false;
      body.translation(t);
      if (t.y < this.killY[i]) { this.fall(i); continue; }
      body.linvel(v); body.angvel(w);
      const speed = Math.max(Math.hypot(v.x, v.y, v.z), Math.hypot(w.x, w.y, w.z) * this.inst[i].extent);
      if (speed > thr) calm = false;
      if (o.restDamping > 0) {
        st.slow = speed < REST_FACTOR * thr ? st.slow + step : 0;
        if (!st.braked && st.slow >= REST_TIME - 1e-9) {
          st.braked = true;
          body.setLinearDamping(o.linearDamping + 0.4 * o.restDamping);
          body.setAngularDamping(o.angularDamping + o.restDamping);
        } else if (st.braked && speed > RELEASE_FACTOR * thr) {
          st.braked = false;
          body.setLinearDamping(o.linearDamping);
          body.setAngularDamping(o.angularDamping);
        }
      }
    }
    if (this.queue.length) { this.calm = 0; return; }
    if (asleep) { this.done = true; this.reason = 'asleep'; return; }
    this.calm = calm ? this.calm + CHECK * this.o.dt : 0;
    if (this.calm >= CALM_TIME - 1e-9) { this.done = true; this.reason = 'settled'; }
  }

  /** A piece fell below everything: freeze it where it is (removed from the world) and remember it. */
  private fall(i: number) {
    const st = this.states[i], body = st.body!;
    st.last = readBody(body);
    st.fallen = true;
    this.world.removeRigidBody(body);
    st.body = null; st.collider = null;
  }

  /** Pieces overlapping another collider by more than 5 % of their radius. */
  private countOverlaps(): number {
    let n = 0;
    const pieces = this.scene.pieces;
    for (let i = 0; i < this.states.length; i++) {
      const c = this.states[i].collider;
      if (!c || pieces[i].fixed) continue;
      const tol = -0.05 * this.inst[i].extent;
      let deep = false;
      this.world.contactPairsWith(c, (other) => {
        if (deep) return;
        this.world.contactPair(c, other, (m) => { for (let k = 0; k < m.numContacts(); k++) if (m.contactDist(k) < tol) deep = true; });
      });
      if (deep) n++;
    }
    return n;
  }

  read(): RbdResult {
    const n = this.states.length, pieces = this.scene.pieces;
    const res: RbdResult = {
      t: new Float64Array(n * 3), q: new Float64Array(n * 4), com: new Float64Array(n * 3), v: new Float64Array(n * 3), w: new Float64Array(n * 3),
      settled: new Uint8Array(n), contacts: new Int32Array(n), fallen: new Uint8Array(n), spawned: new Uint8Array(n),
      steps: this.step, reason: this.done ? this.reason : 'frame', maxPenetration: 0, startOverlaps: this.startOverlaps,
    };
    const thr = this.o.sleepThreshold;
    for (let i = 0; i < n; i++) {
      const st = this.states[i], p = pieces[i];
      let s = st.last;
      if (st.body) s = readBody(st.body);
      if (!s) s = { t: st.t, q: st.q, com: st.t, v: [0, 0, 0], w: [0, 0, 0] };
      res.t.set(s.t, i * 3); res.q.set(s.q, i * 4); res.com.set(s.com, i * 3); res.v.set(s.v, i * 3); res.w.set(s.w, i * 3);
      res.fallen[i] = st.fallen ? 1 : 0;
      res.spawned[i] = st.body || st.fallen ? 1 : 0;
      const r = this.inst[i].extent;
      if (p.fixed) res.settled[i] = 1;
      else if (st.body && !st.fallen) {
        const slow = Math.hypot(s.v[0], s.v[1], s.v[2]) <= thr && Math.hypot(s.w[0], s.w[1], s.w[2]) * r <= thr;
        res.settled[i] = st.body.isSleeping() || slow ? 1 : 0;
      }
      // contacts: other colliders touching this one (within 1 % of its radius)
      const c = st.collider;
      if (!c) continue;
      const tol = 0.01 * r;
      let count = 0, deepest = 0;
      this.world.contactPairsWith(c, (other) => {
        let touching = false;
        this.world.contactPair(c, other, (m) => {
          for (let k = 0; k < m.numContacts(); k++) {
            const d = m.contactDist(k);
            if (d <= tol) touching = true;
            if (-d > deepest) deepest = -d;
          }
        });
        if (touching) count++;
      });
      res.contacts[i] = count;
      if (deepest > res.maxPenetration) res.maxPenetration = deepest;
    }
    return res;
  }

  free() {
    this.world.free();
  }
}

function readBody(b: RigidBody): { t: Vec3; q: Quat; com: Vec3; v: Vec3; w: Vec3 } {
  const t = b.translation(), q = b.rotation(), c = b.worldCom(), v = b.linvel(), w = b.angvel();
  return { t: [t.x, t.y, t.z], q: [q.x, q.y, q.z, q.w], com: [c.x, c.y, c.z], v: [v.x, v.y, v.z], w: [w.x, w.y, w.z] };
}

/** Box of points: centre and half extents (at least `min` thick). */
function boxOf(pts: Float32Array, min: number): { center: Vec3; half: Vec3 } {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pts.length; i += 3) for (let c = 0; c < 3; c++) { const x = pts[i + c]; if (x < lo[c]) lo[c] = x; if (x > hi[c]) hi[c] = x; }
  if (!(lo[0] <= hi[0])) return { center: [0, 0, 0], half: [min, min, min] };
  return {
    center: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2],
    half: [Math.max(min, (hi[0] - lo[0]) / 2), Math.max(min, (hi[1] - lo[1]) / 2), Math.max(min, (hi[2] - lo[2]) / 2)],
  };
}

/** Compute a shape's collision data once (hulls through Rapier, in a scratch world). */
function buildShape(R: Rapier, scratch: World, s: RbdShape, hullPoints: number): BuiltShape {
  if (s.kind === 'mesh' && s.indices) return { kind: 'mesh', vertices: s.points, indices: s.indices };
  // the hull; degenerate (flat, a line, a point) falls back to a thin box around the points
  const extent = Math.max(s.radius, 1e-6);
  try {
    const c = scratch.createCollider(R.ColliderDesc.convexHull(s.points)!);
    let vertices = c.vertices(), indices = c.indices();
    const volume = c.volume();
    scratch.removeCollider(c, false);
    if (vertices && indices && volume > 1e-6 * extent ** 3) {
      if (s.kind === 'hull' && hullPoints >= 4 && vertices.length / 3 > hullPoints) {
        const r = reduceHull(R, scratch, vertices, indices, hullPoints);
        if (r) ({ vertices, indices } = r);
      }
      return s.kind === 'hull' ? { kind: 'hull', vertices, indices } : { kind: s.kind, vertices };
    }
  } catch {
    // no hull: below
  }
  return { kind: s.kind === 'sphere' ? 'sphere' : 'box', vertices: s.points };
}

/** A piece's shape: the built shape with U applied (winding flipped when U mirrors), its box, sphere and extent. */
function instanceShape(b: BuiltShape, U: Float64Array | null): Inst {
  let V = b.vertices, I = b.indices;
  if (U && !(U[0] === 1 && U[4] === 1 && U[8] === 1 && !U[1] && !U[2] && !U[3] && !U[5] && !U[6] && !U[7])) {
    V = new Float32Array(V.length);
    const S = b.vertices;
    for (let i = 0; i < V.length; i += 3) {
      const x = S[i], y = S[i + 1], z = S[i + 2];
      V[i] = U[0] * x + U[3] * y + U[6] * z; V[i + 1] = U[1] * x + U[4] * y + U[7] * z; V[i + 2] = U[2] * x + U[5] * y + U[8] * z;
    }
    const det = U[0] * (U[4] * U[8] - U[7] * U[5]) - U[3] * (U[1] * U[8] - U[7] * U[2]) + U[6] * (U[1] * U[5] - U[4] * U[2]);
    if (det < 0 && I) {
      const F = I.slice();
      for (let t = 0; t < F.length; t += 3) { const x = F[t + 1]; F[t + 1] = F[t + 2]; F[t + 2] = x; }
      I = F;
    }
  }
  let r2 = 0;
  for (let i = 0; i < V.length; i += 3) r2 = Math.max(r2, V[i] * V[i] + V[i + 1] * V[i + 1] + V[i + 2] * V[i + 2]);
  const extent = Math.max(Math.sqrt(r2), 1e-6);
  const minHalf = Math.max(1e-4, extent * 0.01);
  const box = boxOf(V, minHalf);
  let kind = b.kind;
  // a hull flattened by a zero scale has no volume: a thin box instead
  if (kind === 'hull' && Math.min(box.half[0], box.half[1], box.half[2]) <= minHalf) kind = 'box';
  let s2 = 0;
  const c = box.center;
  for (let i = 0; i < V.length; i += 3) s2 = Math.max(s2, (V[i] - c[0]) ** 2 + (V[i + 1] - c[1]) ** 2 + (V[i + 2] - c[2]) ** 2);
  return { kind, vertices: V, indices: I, ...box, radius: Math.max(minHalf, Math.sqrt(s2)), extent };
}

/**
 * A hull of at most maxN of the vertices V of a convex hull (triangles I) that loses as little as possible. Greedy on the
 * support function (how far the shape reaches in a direction: what decides how deep a resting piece sinks): start from
 * the extreme vertices along 26 directions, then add, one at a time, the vertex that gives the full hull's support in
 * the direction where the chosen set falls shortest (directions: the hull's face normals and 256 spread over the
 * sphere), until maxN vertices or no direction falls short. One quickhull at the end, none per step. An inner
 * approximation: pieces can sink into each other by the largest remaining shortfall (a few % of the radius on round
 * shapes at 64 vertices).
 */
export function reduceHull(R: Rapier, scratch: World, V: Float32Array, I: Uint32Array, maxN: number): { vertices: Float32Array; indices: Uint32Array } | null {
  const n = V.length / 3, nf = I.length / 3;
  const chosen = new Uint8Array(n);
  const picked: number[] = [];
  const pick = (i: number) => { if (!chosen[i]) { chosen[i] = 1; picked.push(i); } };
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
    if (!dx && !dy && !dz) continue;
    let best = -1, bv = -Infinity;
    for (let i = 0; i < n; i++) { const t = V[i * 3] * dx + V[i * 3 + 1] * dy + V[i * 3 + 2] * dz; if (t > bv) { bv = t; best = i; } }
    if (best >= 0) pick(best);
  }
  // directions: the hull's face normals plus 256 spread over the sphere; h = the full hull's support along each (and
  // the vertex giving it), cur = the chosen set's support
  const nd = nf + 256;
  const N = new Float64Array(nd * 3), h = new Float64Array(nd), arg = new Int32Array(nd), cur = new Float64Array(nd).fill(-Infinity);
  for (let f = 0; f < nf; f++) {
    const a = I[f * 3] * 3, b = I[f * 3 + 1] * 3, c = I[f * 3 + 2] * 3;
    const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2];
    const vx = V[c] - V[a], vy = V[c + 1] - V[a + 1], vz = V[c + 2] - V[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    N[f * 3] = nx / l; N[f * 3 + 1] = ny / l; N[f * 3 + 2] = nz / l;
  }
  for (let k = 0; k < 256; k++) {
    const z = 1 - (2 * k + 1) / 256, r = Math.sqrt(1 - z * z), a = k * 2.399963229728653;
    N[(nf + k) * 3] = r * Math.cos(a); N[(nf + k) * 3 + 1] = z; N[(nf + k) * 3 + 2] = r * Math.sin(a);
  }
  for (let d = 0; d < nd; d++) {
    let bv = -Infinity, bi = 0;
    for (let i = 0; i < n; i++) { const t = N[d * 3] * V[i * 3] + N[d * 3 + 1] * V[i * 3 + 1] + N[d * 3 + 2] * V[i * 3 + 2]; if (t > bv) { bv = t; bi = i; } }
    h[d] = bv; arg[d] = bi;
  }
  const raise = (i: number) => {
    const x = V[i * 3], y = V[i * 3 + 1], z = V[i * 3 + 2];
    for (let d = 0; d < nd; d++) { const t = N[d * 3] * x + N[d * 3 + 1] * y + N[d * 3 + 2] * z; if (t > cur[d]) cur[d] = t; }
  };
  for (const i of picked) raise(i);
  while (picked.length < maxN) {
    let wd = -1, wv = 1e-9;
    for (let d = 0; d < nd; d++) { const t = h[d] - cur[d]; if (t > wv) { wv = t; wd = d; } }
    if (wd < 0) break;
    pick(arg[wd]);
    raise(arg[wd]);
  }
  const pts = new Float32Array(picked.length * 3);
  picked.sort((a, b) => a - b).forEach((i, k) => { pts[k * 3] = V[i * 3]; pts[k * 3 + 1] = V[i * 3 + 1]; pts[k * 3 + 2] = V[i * 3 + 2]; });
  try {
    const c = scratch.createCollider(R.ColliderDesc.convexHull(pts)!);
    const vertices = c.vertices(), indices = c.indices();
    scratch.removeCollider(c, false);
    return vertices && indices ? { vertices, indices } : null;
  } catch {
    return null;
  }
}

function colliderDesc(R: Rapier, b: Inst) {
  if (b.kind === 'hull') {
    const d = R.ColliderDesc.convexMesh(b.vertices!, b.indices!);
    if (d) return d;
  }
  if (b.kind === 'mesh') return R.ColliderDesc.trimesh(b.vertices!, b.indices!);
  if (b.kind === 'sphere') return R.ColliderDesc.ball(b.radius).setTranslation(b.center[0], b.center[1], b.center[2]);
  return R.ColliderDesc.cuboid(b.half[0], b.half[1], b.half[2]).setTranslation(b.center[0], b.center[1], b.center[2]);
}

/** The shape for a downward cast, centred like the collider (castOffset holds the centre). */
function castShapeOf(R: Rapier, b: Inst): Shape {
  if (b.kind === 'hull') return new R.ConvexPolyhedron(b.vertices!, b.indices!);
  if (b.kind === 'sphere') return new R.Ball(b.radius);
  if (b.kind === 'mesh') return new R.TriMesh(b.vertices!, b.indices!);
  return new R.Cuboid(b.half[0], b.half[1], b.half[2]);
}

// ------------------------------------------------------------------ write back

export interface RbdApplyOptions {
  /** remove pieces that fell below everything (else they stay where they were frozen, in group `fallen`) */
  deleteFallen: boolean;
  /** remove pieces the stack mode has not dropped yet (animated cooks) */
  hideUnspawned?: boolean;
}

/**
 * A copy of the scene geometry with the simulation result written into it.
 * Packed pieces: anchor P and packedXform (= R(q)·U); unpacked pieces: P, and N/up/tangentu/force rotated, orient
 * composed. Every piece's points get v (rigid velocity at the point), w (angular velocity, rad/s), settled (0/1) and
 * contacts (touching colliders).
 */
export function applyRbd(scene: RbdScene, r: RbdResult, o: RbdApplyOptions): Geometry {
  const g = scene.geo.clone(), P = g.P, pieces = scene.pieces;
  const np = g.numPoints;
  const vA = g.points.add('v', 'float', 3).data as Float64Array;
  const wA = g.points.add('w', 'float', 3).data as Float64Array;
  const settledA = g.points.add('settled', 'int', 1).data as Int32Array;
  const contactsA = g.points.add('contacts', 'int', 1).data as Int32Array;
  // rotation of each piece relative to its input pose (for N, up, orient)
  const dR = new Float64Array(pieces.length * 9), dQ = new Float64Array(pieces.length * 4);
  const R = new Float64Array(9);
  let anyFallen = false, anyHidden = false;
  for (let k = 0; k < pieces.length; k++) {
    const p = pieces[k];
    const t: Vec3 = [r.t[k * 3], r.t[k * 3 + 1], r.t[k * 3 + 2]];
    const q: Quat = [r.q[k * 4], r.q[k * 4 + 1], r.q[k * 4 + 2], r.q[k * 4 + 3]];
    quatToMat3(q, R);
    // relative rotation: q · rot⁻¹
    const qi: Quat = [-p.rot[0], -p.rot[1], -p.rot[2], p.rot[3]];
    const d = qNormalize(qMul(q, qi));
    dQ.set(d, k * 4);
    quatToMat3(d, dR.subarray(k * 9, k * 9 + 9));
    if (p.packed) {
      const a = p.anchor;
      P[a * 3] = t[0]; P[a * 3 + 1] = t[1]; P[a * 3 + 2] = t[2];
      g.packedXform!.set(mul3(R, p.U!), p.prim * 9);
    } else {
      const o0 = p.origin;
      for (let i = 0; i < p.points.length; i++) {
        const o3 = p.points[i] * 3;
        const x = P[o3] - o0[0], y = P[o3 + 1] - o0[1], z = P[o3 + 2] - o0[2];
        P[o3] = t[0] + R[0] * x + R[3] * y + R[6] * z;
        P[o3 + 1] = t[1] + R[1] * x + R[4] * y + R[7] * z;
        P[o3 + 2] = t[2] + R[2] * x + R[5] * y + R[8] * z;
      }
    }
    const c = [r.com[k * 3], r.com[k * 3 + 1], r.com[k * 3 + 2]], v = [r.v[k * 3], r.v[k * 3 + 1], r.v[k * 3 + 2]], w = [r.w[k * 3], r.w[k * 3 + 1], r.w[k * 3 + 2]];
    for (let i = 0; i < p.points.length; i++) {
      const pt = p.points[i], o3 = pt * 3;
      const x = P[o3] - c[0], y = P[o3 + 1] - c[1], z = P[o3 + 2] - c[2];
      vA[o3] = v[0] + w[1] * z - w[2] * y; vA[o3 + 1] = v[1] + w[2] * x - w[0] * z; vA[o3 + 2] = v[2] + w[0] * y - w[1] * x;
      wA[o3] = w[0]; wA[o3 + 1] = w[1]; wA[o3 + 2] = w[2];
      settledA[pt] = r.settled[k];
      contactsA[pt] = r.contacts[k];
    }
    if (r.fallen[k]) anyFallen = true;
    if (!r.spawned[k] && o.hideUnspawned) anyHidden = true;
  }
  // vectors: point attributes per owner piece, vertex/prim attributes per prim piece
  const ptPiece = new Int32Array(np).fill(-1);
  pieces.forEach((p, k) => { for (let i = 0; i < p.points.length; i++) ptPiece[p.points[i]] = k; });
  const vertexPiece = (vtx: number) => ptPiece[g.vertexPoint[vtx]];
  rotateVectors(g.points, (i) => ptPiece[i], dR, dQ, true);
  rotateVectors(g.vertices, vertexPiece, dR, dQ, false);
  rotateVectors(g.prims, (i) => scene.primPiece[i], dR, dQ, false);
  if (anyFallen) {
    const m = new Uint8Array(np);
    pieces.forEach((p, k) => { if (r.fallen[k]) for (let i = 0; i < p.points.length; i++) m[p.points[i]] = 1; });
    g.pointGroups.set('fallen', m);
  }
  if ((anyFallen && o.deleteFallen) || anyHidden) {
    const keep = new Uint8Array(np).fill(1);
    pieces.forEach((p, k) => {
      if ((r.fallen[k] && o.deleteFallen) || (!r.spawned[k] && o.hideUnspawned)) for (let i = 0; i < p.points.length; i++) keep[p.points[i]] = 0;
    });
    const out = g.subsetPoints(keep);
    if (o.deleteFallen) out.pointGroups.delete('fallen');
    return out;
  }
  return g;
}

const VECTORS = ['N', 'up', 'tangentu', 'force'];

/** Rotate N/up/tangentu/force (and point orient) of the elements of moved pieces by their relative rotation. */
function rotateVectors(t: AttribTable, pieceOf: (i: number) => number, dR: Float64Array, dQ: Float64Array, point: boolean) {
  for (const [name, a] of t.map) {
    if (a.type !== 'float' || a.isArray) continue;
    const d = a.data as Float64Array;
    if (VECTORS.includes(name) && a.size === 3) {
      for (let i = 0; i < t.count; i++) {
        const k = pieceOf(i);
        if (k < 0) continue;
        const R = dR.subarray(k * 9, k * 9 + 9), x = d[i * 3], y = d[i * 3 + 1], z = d[i * 3 + 2];
        d[i * 3] = R[0] * x + R[3] * y + R[6] * z; d[i * 3 + 1] = R[1] * x + R[4] * y + R[7] * z; d[i * 3 + 2] = R[2] * x + R[5] * y + R[8] * z;
      }
    } else if (point && name === 'orient' && a.size === 4) {
      for (let i = 0; i < t.count; i++) {
        const k = pieceOf(i);
        if (k < 0) continue;
        const q = qMul([dQ[k * 4], dQ[k * 4 + 1], dQ[k * 4 + 2], dQ[k * 4 + 3]], [d[i * 4], d[i * 4 + 1], d[i * 4 + 2], d[i * 4 + 3]]);
        d[i * 4] = q[0]; d[i * 4 + 1] = q[1]; d[i * 4 + 2] = q[2]; d[i * 4 + 3] = q[3];
      }
    }
  }
}
