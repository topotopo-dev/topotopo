// Reference-driven deformers: soft_transform (falloff edit), lattice (free-form deformation), path_deform (bend along a
// curve), point_deform (follow a proxy point cloud) and rest (rest positions for stable noise on deforming geometry).
// All of them clone the input and move P, so every attribute and group carries through untouched; N, up, v and orient
// point attributes are carried through the local deformation and any existing normals are refreshed afterwards.
import { Geometry } from '../core/geometry.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import { DEG, cross, dot, normalize, perpendicular, qFromMat, qMul, qNormalize } from '../core/math.ts';
import type { Quat, Vec3 } from '../core/math.ts';
import { KDTree } from '../core/spatial.ts';
import { pointNeighbors, refreshNormals } from '../core/topology.ts';
import { rmFrames } from './curves.ts';
import { makeBox } from './generate.ts';
import { AXES, FALLOFF_KINDS, P, falloffWeight, getPointNormals, mask } from './util.ts';

// ---------------------------------------------------------------- 3x3 / rotation helpers (row-major m[r * 3 + c])

type M3 = Float64Array;

const m3identity = (): M3 => Float64Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1);

function m3mul(a: ArrayLike<number>, b: ArrayLike<number>): M3 {
  const o = new Float64Array(9);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return o;
}

function m3transpose(m: ArrayLike<number>): M3 {
  return Float64Array.of(m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]);
}

function m3invert(m: ArrayLike<number>): M3 | null {
  const a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5], g = m[6], h = m[7], i = m[8];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!(Math.abs(det) > 1e-300)) return null;
  const s = 1 / det;
  return Float64Array.of(
    A * s, -(b * i - c * h) * s, (b * f - c * e) * s,
    B * s, (a * i - c * g) * s, -(a * f - c * d) * s,
    C * s, -(a * h - b * g) * s, (a * e - b * d) * s,
  );
}

function quatToM3(q: Quat): M3 {
  const [x, y, z, w] = q;
  return Float64Array.of(
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  );
}

/** Quaternion of an exact rotation matrix (row-major). */
function m3ToQuat(r: ArrayLike<number>): Quat {
  const m = new Float64Array(16);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[j * 4 + i] = r[i * 3 + j];
  m[15] = 1;
  return qFromMat(m);
}

/** Eigenvector of the largest eigenvalue of a symmetric 4x4 matrix (cyclic Jacobi). */
function maxEigvec4(A: number[]): number[] {
  const a = A.slice(), v = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (let sweep = 0; sweep < 32; sweep++) {
    let off = 0, diag = 0;
    for (let p = 0; p < 4; p++) {
      diag += a[p * 5] * a[p * 5];
      for (let q = p + 1; q < 4; q++) off += a[p * 4 + q] * a[p * 4 + q];
    }
    if (off <= 1e-30 * diag || off < 1e-300) break;
    for (let p = 0; p < 3; p++)
      for (let q = p + 1; q < 4; q++) {
        const apq = a[p * 4 + q];
        if (Math.abs(apq) < 1e-300) continue;
        const theta = (a[q * 5] - a[p * 5]) / (2 * apq);
        const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < 4; k++) {
          const akp = a[k * 4 + p], akq = a[k * 4 + q];
          a[k * 4 + p] = c * akp - s * akq; a[k * 4 + q] = s * akp + c * akq;
        }
        for (let k = 0; k < 4; k++) {
          const apk = a[p * 4 + k], aqk = a[q * 4 + k];
          a[p * 4 + k] = c * apk - s * aqk; a[q * 4 + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 4; k++) {
          const vkp = v[k * 4 + p], vkq = v[k * 4 + q];
          v[k * 4 + p] = c * vkp - s * vkq; v[k * 4 + q] = s * vkp + c * vkq;
        }
      }
  }
  let best = 0;
  for (let k = 1; k < 4; k++) if (a[k * 5] > a[best * 5]) best = k;
  return [v[best], v[4 + best], v[8 + best], v[12 + best]];
}

/**
 * Rotation maximising tr(R S) for S = sum of a·bᵀ (a = rest offsets, b = deformed offsets), i.e. the best rotation
 * taking the a's onto the b's (Horn 1987, closed form via quaternions). Works for planar and collinear sets.
 */
export function hornRotation(S: ArrayLike<number>): Quat {
  const Sxx = S[0], Sxy = S[1], Sxz = S[2], Syx = S[3], Syy = S[4], Syz = S[5], Szx = S[6], Szy = S[7], Szz = S[8];
  const v = maxEigvec4([
    Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx,
    Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz,
    Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy,
    Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz,
  ]);
  const q = qNormalize([v[1], v[2], v[3], v[0]]);
  return q[3] < 0 ? [-q[0], -q[1], -q[2], -q[3]] : q;
}

/** The rotation closest to a linear map L (row-major), as a quaternion (polar decomposition). */
export function nearestRotation(L: ArrayLike<number>): Quat {
  return hornRotation(m3transpose(L));
}

// ---------------------------------------------------------------- vector attributes that follow the deformation

interface FrameAttribs { N?: Float64Array; up?: Float64Array; v?: Float64Array; orient?: Float64Array }

/** Point N / up / v / orient arrays of g (already cloned), or null when there are none. */
function frameAttribs(g: Geometry): FrameAttribs | null {
  const get = (name: string, size: number) => {
    const a = g.points.get(name);
    return a && a.type === 'float' && a.size === size ? (a.data as Float64Array) : undefined;
  };
  const fa: FrameAttribs = { N: get('N', 3), up: get('up', 3), v: get('v', 3), orient: get('orient', 4) };
  return fa.N || fa.up || fa.v || fa.orient ? fa : null;
}

/**
 * Carry point i's vector attributes through the local linear map L (row-major): up and v by L, N by the inverse
 * transpose (renormalised), orient by the nearest rotation. `isRotation` skips the inverse and the polar decomposition.
 */
function transformFrameAttribs(fa: FrameAttribs, i: number, L: ArrayLike<number>, isRotation = false) {
  const o = i * 3;
  for (const d of [fa.up, fa.v]) {
    if (!d) continue;
    const x = d[o], y = d[o + 1], z = d[o + 2];
    d[o] = L[0] * x + L[1] * y + L[2] * z;
    d[o + 1] = L[3] * x + L[4] * y + L[5] * z;
    d[o + 2] = L[6] * x + L[7] * y + L[8] * z;
  }
  if (fa.N) {
    const inv = isRotation ? null : m3invert(L);
    const M = inv ? m3transpose(inv) : L;
    const d = fa.N, x = d[o], y = d[o + 1], z = d[o + 2];
    const nx = M[0] * x + M[1] * y + M[2] * z, ny = M[3] * x + M[4] * y + M[5] * z, nz = M[6] * x + M[7] * y + M[8] * z;
    const l = Math.hypot(nx, ny, nz);
    if (l > 1e-20) { d[o] = nx / l; d[o + 1] = ny / l; d[o + 2] = nz / l; }
  }
  if (fa.orient) {
    const q = isRotation ? m3ToQuat(L) : nearestRotation(L);
    const d = fa.orient, k = i * 4;
    const r = qNormalize(qMul(q, [d[k], d[k + 1], d[k + 2], d[k + 3]]));
    d[k] = r[0]; d[k + 1] = r[1]; d[k + 2] = r[2]; d[k + 3] = r[3];
  }
}

/** FNV-style 64-bit content hash of a float array (two 32-bit lanes), for binding caches. */
function hashFloats(a: Float64Array): string {
  const u = new Uint32Array(a.buffer, a.byteOffset, a.length * 2);
  let h1 = 0x811c9dc5, h2 = 0x9e3779b9;
  for (let i = 0; i < u.length; i++) {
    h1 = Math.imul(h1 ^ u[i], 0x01000193);
    h2 = Math.imul(h2 ^ u[i], 0x5bd1e995) ^ (h2 >>> 15);
  }
  return `${a.length}:${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`;
}

/** A float vec3 point attribute's data, or null. */
function vec3Attrib(g: Geometry, name: string): Float64Array | null {
  const a = name ? g.points.get(name) : undefined;
  return a && a.type === 'float' && a.size === 3 ? (a.data as Float64Array) : null;
}

// ---------------------------------------------------------------- soft_transform

/** Min-heap of (distance, index) pairs for Dijkstra. */
class MinHeap {
  d: number[] = [];
  i: number[] = [];
  /** distance of the element returned by the last pop() */
  last = 0;
  get size() { return this.d.length; }
  push(dist: number, idx: number) {
    const d = this.d, ix = this.i;
    let k = d.length;
    d.push(dist); ix.push(idx);
    while (k > 0) {
      const pa = (k - 1) >> 1;
      if (d[pa] <= dist) break;
      d[k] = d[pa]; ix[k] = ix[pa]; k = pa;
    }
    d[k] = dist; ix[k] = idx;
  }
  pop(): number {
    const d = this.d, ix = this.i;
    const top = ix[0];
    this.last = d[0];
    const dist = d.pop()!, idx = ix.pop()!;
    const m = d.length;
    if (m) {
      let k = 0;
      for (;;) {
        let c = 2 * k + 1;
        if (c >= m) break;
        if (c + 1 < m && d[c + 1] < d[c]) c++;
        if (d[c] >= dist) break;
        d[k] = d[c]; ix[k] = ix[c]; k = c;
      }
      d[k] = dist; ix[k] = idx;
    }
    return top;
  }
}

/** Shortest distance along mesh/curve edges from any seed point, explored up to maxDist (Infinity beyond). */
export function edgeDistance(g: Geometry, seeds: ArrayLike<number>, maxDist: number): Float64Array {
  const n = g.numPoints, Pd = g.P;
  const { start, nb } = pointNeighbors(g);
  const dist = new Float64Array(n).fill(Infinity);
  const heap = new MinHeap();
  for (let k = 0; k < seeds.length; k++) { dist[seeds[k]] = 0; heap.push(0, seeds[k]); }
  while (heap.size) {
    const i = heap.pop(), d = heap.last;
    if (d > dist[i]) continue;
    for (let e = start[i]; e < start[i + 1]; e++) {
      const j = nb[e];
      const nd = d + Math.hypot(Pd[j * 3] - Pd[i * 3], Pd[j * 3 + 1] - Pd[i * 3 + 1], Pd[j * 3 + 2] - Pd[i * 3 + 2]);
      if (nd < dist[j] && nd < maxDist) { dist[j] = nd; heap.push(nd, j); }
    }
  }
  return dist;
}

/**
 * Linear part of the weighted soft transform, row-major: Rz·Ry·Rx (angles r·w in degrees, x applied first, as
 * m4euler 'xyz') times diag(1 + (s - 1)·w).
 */
function softMatrix(r: Vec3, s: Vec3, w: number, out: Float64Array) {
  const ax = r[0] * w * DEG, ay = r[1] * w * DEG, az = r[2] * w * DEG;
  const cx = Math.cos(ax), sx = Math.sin(ax), cy = Math.cos(ay), sy = Math.sin(ay), cz = Math.cos(az), sz = Math.sin(az);
  const k0 = 1 + (s[0] - 1) * w, k1 = 1 + (s[1] - 1) * w, k2 = 1 + (s[2] - 1) * w;
  out[0] = cz * cy * k0; out[1] = (cz * sy * sx - sz * cx) * k1; out[2] = (cz * sy * cx + sz * sx) * k2;
  out[3] = sz * cy * k0; out[4] = (sz * sy * sx + cz * cx) * k1; out[5] = (sz * sy * cx - cz * sx) * k2;
  out[6] = -sy * k0; out[7] = cy * sx * k1; out[8] = cy * cx * k2;
}

/** Straight-line distance to the nearest seed point within maxDist (Infinity beyond). */
function nearestSeedDistance(g: Geometry, seeds: number[], maxDist: number): Float64Array {
  const Pd = g.P, n = g.numPoints;
  const tree = new KDTree(Pd, seeds);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = tree.nearest(Pd[i * 3], Pd[i * 3 + 1], Pd[i * 3 + 2], maxDist).dist;
  return out;
}

defineNode({
  type: 'soft_transform',
  category: 'deform',
  packed: 'keep',
  summary: 'Move / rotate / scale a point group with a soft falloff around it (Houdini Soft Transform / Edit with a soft radius).',
  description:
    'Points in `group` get the full transform; other points within `radius` of the group get a partial one, weighted by ' +
    'the `falloff` curve of their distance (1 at the group, 0 at the radius). The transform is blended by scaling its ' +
    'parameters (translate·w, rotate·w, scale lerped from 1), so rotations sweep along arcs. `distance: "surface"` measures ' +
    'along mesh edges (Dijkstra) instead of straight lines, so the edit does not jump across gaps (a lip, a finger next to ' +
    'another). Houdini: Soft Transform SOP / Edit SOP with a soft radius; `weight_attrib` exposes the soft weights.',
  aliases: ['softxform', 'soft_xform', 'edit', 'soft_edit'],
  inputs: [{ name: 'geo', desc: 'geometry to edit' }],
  params: {
    group: P.group('point', 'points that get the full transform ("" = all points: a plain rigid transform)'),
    translate: { type: 'vec3', default: [0, 0, 0], desc: 'translation of the group', aliases: ['t', 'move', 'offset'] },
    rotate: { type: 'vec3', default: [0, 0, 0], desc: 'rotation in degrees about X, Y, Z (applied in xyz order)', aliases: ['r', 'rot', 'rotation'] },
    scale: { type: 'vec3', default: [1, 1, 1], desc: 'scale about the pivot (a single number = uniform)', aliases: ['s'] },
    pivot_mode: { type: 'enum', options: ['centroid', 'param'], default: 'centroid', desc: 'centroid = average position of the group; param = the `pivot` value' },
    pivot: { type: 'vec3', default: [0, 0, 0], desc: 'pivot for rotate/scale when pivot_mode = param', aliases: ['p'] },
    radius: { type: 'float', default: 1, min: 0, desc: 'soft radius beyond the group; the weight falls to 0 at this distance (0 = only the group moves)', aliases: ['soft_radius', 'rad', 'falloff_radius'] },
    falloff: { type: 'enum', options: FALLOFF_KINDS, default: 'smooth', desc: 'falloff shape over the normalised distance d: smooth (smoothstep), linear, ease_in ((1-d)^2, peaked), ease_out (1-d^2, dome), sharp ((1-sqrt d)^2, spike), ramp (the `ramp` param)', aliases: ['soft_type', 'kernel'] },
    ramp: { type: 'ramp', default: [[0, 1], [1, 0]], desc: 'falloff = ramp: weight over the normalised distance (0 = at the group, 1 = at the radius)' },
    distance: { type: 'enum', options: ['euclidean', 'surface'], default: 'euclidean', desc: 'euclidean = straight-line distance to the nearest group point; surface = shortest path along edges from the group', aliases: ['metric', 'distance_metric'] },
    weight_attrib: { type: 'string', default: '', desc: 'also write the soft weight (0..1) to this point float attribute ("" = off)', aliases: ['weight'] },
  },
  outputs: 'point <weight_attrib> (optional)',
  example: {
    nodes: {
      grid: { type: 'grid', params: { size: [4, 4], divisions: [40, 40] } },
      out: { type: 'soft_transform', in: ['grid'], params: { group: '@P.x>-0.05 ^@P.x>0.05', translate: [0, 1, 0], radius: 1.5 } },
    },
  },
  cook: ({ input, p, warn }) => {
    const g = input(0).clone();
    const n = g.numPoints;
    if (!n) return g;
    const sel = mask(g, 'point', p.group);
    const Pd = g.P;
    const w = new Float64Array(n);
    if (!sel) w.fill(1);
    else {
      const members: number[] = [];
      for (let i = 0; i < n; i++) if (sel[i]) { w[i] = 1; members.push(i); }
      if (!members.length) warn(`group "${p.group}" matched no points: nothing moves`);
      else if (p.radius > 0) {
        let dist: Float64Array;
        if (p.distance === 'surface' && g.numPrims > 0) dist = edgeDistance(g, members, p.radius);
        else {
          if (p.distance === 'surface') warn('distance = surface needs polygons or curves (there are none): using euclidean');
          dist = nearestSeedDistance(g, members, p.radius);
        }
        for (let i = 0; i < n; i++) if (!sel[i] && dist[i] < p.radius) w[i] = falloffWeight(p.falloff, dist[i] / p.radius, p.ramp);
      }
    }
    let pivot = p.pivot as Vec3;
    if (p.pivot_mode === 'centroid') {
      const c = [0, 0, 0];
      let cnt = 0;
      for (let i = 0; i < n; i++) if (!sel || sel[i]) { c[0] += Pd[i * 3]; c[1] += Pd[i * 3 + 1]; c[2] += Pd[i * 3 + 2]; cnt++; }
      if (cnt) pivot = [c[0] / cnt, c[1] / cnt, c[2] / cnt];
    }
    const t = p.translate as Vec3, r = p.rotate as Vec3, s = p.scale as Vec3;
    const fa = frameAttribs(g);
    // p' = pivot + t·w + R(r·w) · diag(lerp(1, s, w)) · (p - pivot), i.e. m4trs(t·w, r·w, s_w, pivot) without allocations
    const L = new Float64Array(9);
    let lastW = NaN;
    for (let i = 0; i < n; i++) {
      const wi = w[i];
      if (wi === 0) continue;
      if (wi !== lastW) { softMatrix(r, s, wi, L); lastW = wi; }
      const x = Pd[i * 3] - pivot[0], y = Pd[i * 3 + 1] - pivot[1], z = Pd[i * 3 + 2] - pivot[2];
      Pd[i * 3] = pivot[0] + t[0] * wi + L[0] * x + L[1] * y + L[2] * z;
      Pd[i * 3 + 1] = pivot[1] + t[1] * wi + L[3] * x + L[4] * y + L[5] * z;
      Pd[i * 3 + 2] = pivot[2] + t[2] * wi + L[6] * x + L[7] * y + L[8] * z;
      if (fa) transformFrameAttribs(fa, i, L);
    }
    if (p.weight_attrib) (g.points.add(p.weight_attrib, 'float', 1).data as Float64Array).set(w);
    return refreshNormals(g);
  },
});

// ---------------------------------------------------------------- lattice

interface LatticeGrid {
  /** sorted node coordinates per axis */
  c: Float64Array[];
  n: [number, number, number];
  /** displacement (deformed - rest) per node, node index (k * ny + j) * nx + i */
  disp: Float64Array;
}

/** Cluster coordinates into distinct node positions (cluster width <= tol). */
function axisNodes(vals: Float64Array, tol: number): Float64Array {
  const s = vals.slice().sort();
  const reps: number[] = [];
  let first = s[0], sum = s[0], cnt = 1;
  for (let i = 1; i < s.length; i++) {
    if (s[i] - first <= tol) { sum += s[i]; cnt++; continue; }
    reps.push(sum / cnt);
    first = sum = s[i]; cnt = 1;
  }
  reps.push(sum / cnt);
  return Float64Array.from(reps);
}

function nearestNode(c: Float64Array, x: number): number {
  let lo = 0, hi = c.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (c[mid] < x) lo = mid + 1; else hi = mid;
  }
  return lo > 0 && Math.abs(c[lo - 1] - x) < Math.abs(c[lo] - x) ? lo - 1 : lo;
}

const LATTICE_HINT = 'make the rest lattice with point_grid, box or bound (with divisions) and deform a copy of it; keep the point order';

/**
 * Lattice structure from the rest points (any axis-aligned grid, any spacing, any point order) and the displacement
 * of every node. Nodes missing from the rest (the interior of a box/bound) get a harmonic fill of their neighbours.
 */
function buildLattice(R: ArrayLike<number>, D: ArrayLike<number>): LatticeGrid {
  const np = R.length / 3;
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < np; i++) for (let a = 0; a < 3; a++) { const v = R[i * 3 + a]; if (v < mn[a]) mn[a] = v; if (v > mx[a]) mx[a] = v; }
  const diag = Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]);
  const tol = 1e-8 * Math.max(diag, 1e-12);
  const c = [0, 1, 2].map((a) => axisNodes(Float64Array.from({ length: np }, (_, i) => R[i * 3 + a]), tol));
  const n = [c[0].length, c[1].length, c[2].length] as [number, number, number];
  const total = n[0] * n[1] * n[2];
  if (total > Math.max(64, np * 8) || total > 4_000_000)
    throw new NodeError(`the rest lattice (${np} points) is not an axis-aligned grid: its coordinates take ${n.join(' × ')} distinct values`, LATTICE_HINT);
  const disp = new Float64Array(total * 3);
  const owner = new Int32Array(total).fill(-1);
  for (let i = 0; i < np; i++) {
    const cell = (nearestNode(c[2], R[i * 3 + 2]) * n[1] + nearestNode(c[1], R[i * 3 + 1])) * n[0] + nearestNode(c[0], R[i * 3]);
    if (owner[cell] >= 0) throw new NodeError(`rest lattice points ${owner[cell]} and ${i} sit on the same lattice node`, LATTICE_HINT);
    owner[cell] = i;
    for (let a = 0; a < 3; a++) disp[cell * 3 + a] = D[i * 3 + a] - R[i * 3 + a];
  }
  if (np < total) fillMissing(disp, owner, n);
  return { c, n, disp };
}

/** Gauss–Seidel harmonic fill of unknown node displacements (reproduces affine fields exactly). */
function fillMissing(disp: Float64Array, owner: Int32Array, n: [number, number, number]) {
  const [nx, ny, nz] = n;
  const unknown: number[] = [];
  const mean = [0, 0, 0];
  let known = 0, scale = 0;
  for (let k = 0; k < owner.length; k++) {
    if (owner[k] < 0) { unknown.push(k); continue; }
    known++;
    for (let a = 0; a < 3; a++) { mean[a] += disp[k * 3 + a]; scale = Math.max(scale, Math.abs(disp[k * 3 + a])); }
  }
  for (const k of unknown) for (let a = 0; a < 3; a++) disp[k * 3 + a] = mean[a] / Math.max(1, known);
  if (scale === 0) return;
  const maxIter = Math.min(20000, 200 + 50 * Math.max(nx, ny, nz) ** 2);
  const s = [0, 0, 0];
  for (let it = 0; it < maxIter; it++) {
    let change = 0;
    for (const k of unknown) {
      const i = k % nx, j = Math.floor(k / nx) % ny, kk = Math.floor(k / (nx * ny));
      s[0] = s[1] = s[2] = 0;
      let cnt = 0;
      const add = (q: number) => { cnt++; s[0] += disp[q * 3]; s[1] += disp[q * 3 + 1]; s[2] += disp[q * 3 + 2]; };
      if (i > 0) add(k - 1);
      if (i < nx - 1) add(k + 1);
      if (j > 0) add(k - nx);
      if (j < ny - 1) add(k + nx);
      if (kk > 0) add(k - nx * ny);
      if (kk < nz - 1) add(k + nx * ny);
      if (!cnt) continue;
      for (let a = 0; a < 3; a++) {
        const v = s[a] / cnt;
        change = Math.max(change, Math.abs(v - disp[k * 3 + a]));
        disp[k * 3 + a] = v;
      }
    }
    if (change <= 1e-13 * scale) break;
  }
}

/** Segment index (clamped to the end cells) and the unclamped local parameter, so outside points extrapolate. */
function locate(c: Float64Array, x: number): [number, number] {
  const m = c.length;
  if (m < 2) return [0, 0];
  let lo = 0, hi = m - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (c[mid] <= x) lo = mid; else hi = mid - 1;
  }
  return [lo, (x - c[lo]) / (c[lo + 1] - c[lo])];
}

function trilinear(L: LatticeGrid, x: number, y: number, z: number, out: number[]) {
  const [nx, ny] = L.n;
  const [i, tx] = locate(L.c[0], x), [j, ty] = locate(L.c[1], y), [k, tz] = locate(L.c[2], z);
  out[0] = out[1] = out[2] = 0;
  for (let dz = 0; dz < 2; dz++) {
    const wz = dz ? tz : 1 - tz;
    if (wz === 0) continue;
    for (let dy = 0; dy < 2; dy++) {
      const wy = dy ? ty : 1 - ty;
      if (wy === 0) continue;
      for (let dx = 0; dx < 2; dx++) {
        const wx = dx ? tx : 1 - tx;
        if (wx === 0) continue;
        const cell = ((k + dz) * ny + j + dy) * nx + i + dx, w = wx * wy * wz;
        out[0] += w * L.disp[cell * 3]; out[1] += w * L.disp[cell * 3 + 1]; out[2] += w * L.disp[cell * 3 + 2];
      }
    }
  }
}

/** Bernstein basis of degree B.length - 1 at u, and its derivative. */
function bernstein(u: number, B: Float64Array, dB: Float64Array) {
  const n = B.length - 1;
  B.fill(0); B[0] = 1;
  if (n === 0) { dB[0] = 0; return; }
  for (let d = 1; d <= n; d++) {
    if (d === n) for (let i = 0; i <= n; i++) dB[i] = n * ((i > 0 ? B[i - 1] : 0) - (i < n ? B[i] : 0));
    for (let i = d; i >= 0; i--) B[i] = (i < d ? (1 - u) * B[i] : 0) + (i > 0 ? u * B[i - 1] : 0);
  }
}

/** Bezier FFD (Sederberg–Parry) of the displacement field; first-order extrapolation outside the lattice box. */
function makeBernstein(L: LatticeGrid) {
  const [nx, ny, nz] = L.n;
  const B = L.n.map((m) => new Float64Array(m)), dB = L.n.map((m) => new Float64Array(m));
  const q = [0, 0, 0], e = [0, 0, 0];
  return (x: number, y: number, z: number, out: number[]) => {
    q[0] = x; q[1] = y; q[2] = z;
    for (let a = 0; a < 3; a++) {
      const c = L.c[a], m = c.length;
      const u = m > 1 ? (q[a] - c[0]) / (c[m - 1] - c[0]) : 0;
      const uc = u < 0 ? 0 : u > 1 ? 1 : u;
      e[a] = u - uc;
      bernstein(uc, B[a], dB[a]);
    }
    const ext = e[0] !== 0 || e[1] !== 0 || e[2] !== 0;
    out[0] = out[1] = out[2] = 0;
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++) {
        const byz = B[1][j] * B[2][k];
        const gy = ext ? dB[1][j] * B[2][k] * e[1] + B[1][j] * dB[2][k] * e[2] : 0;
        for (let i = 0; i < nx; i++) {
          let w = B[0][i] * byz;
          if (ext) w += dB[0][i] * byz * e[0] + B[0][i] * gy;
          if (w === 0) continue;
          const cell = (k * ny + j) * nx + i;
          out[0] += w * L.disp[cell * 3]; out[1] += w * L.disp[cell * 3 + 1]; out[2] += w * L.disp[cell * 3 + 2];
        }
      }
  };
}

/** Number of points of a box/bound with divisions D (surface points only). */
const boxPointCount = (D: number[]) => (D[0] + 1) * (D[1] + 1) * (D[2] + 1) - (D[0] - 1) * (D[1] - 1) * (D[2] - 1);
const gridPointCount = (D: number[]) => (D[0] + 1) * (D[1] + 1) * (D[2] + 1);

/** Divisions giving `count` points whose cells are closest to cubes for the given box size, or null. */
function inferDivisions(count: number, boxOrder: boolean, size: number[]): number[] | null {
  const diag = Math.hypot(size[0], size[1], size[2]) || 1;
  const flat = size.map((s) => s < 1e-4 * diag);
  let best: number[] | null = null, bestScore = Infinity;
  const lo = boxOrder ? 1 : 0;
  for (let a = lo; a <= 48; a++)
    for (let b = lo; b <= 48; b++)
      for (let c = lo; c <= 48; c++) {
        const D = [a, b, c];
        if ((boxOrder ? boxPointCount(D) : gridPointCount(D)) !== count) continue;
        const logs: number[] = [];
        let score = 0;
        for (let k = 0; k < 3; k++) {
          if (flat[k]) score += D[k];
          else if (D[k] === 0) score += 100;
          else logs.push(Math.log(size[k] / D[k]));
        }
        const mean = logs.reduce((x, y) => x + y, 0) / Math.max(1, logs.length);
        for (const l of logs) score += (l - mean) ** 2;
        if (score < bestScore) { bestScore = score; best = D; }
      }
  return best;
}

/** Rest lattice for the two-input form: the bounding box of geo with `divisions`, in box or point_grid point order. */
function bboxRestLattice(geo: Geometry, deformed: Geometry, divisions: number[], warn: (m: string) => void): Float64Array {
  const b = geo.bbox(true);
  if (b.empty) throw new NodeError('geo is empty: there is no bounding box to fit the lattice to');
  const size = [0, 1, 2].map((a) => Math.max(b.max[a] - b.min[a], 1e-6)) as Vec3;
  const center = [0, 1, 2].map((a) => (b.min[a] + b.max[a]) / 2) as Vec3;
  const boxOrder = deformed.numPrims > 0, n = deformed.numPoints;
  const count = boxOrder ? boxPointCount : gridPointCount;
  let D = divisions.map((d) => Math.max(1, Math.round(d)));
  if (count(D) !== n) {
    const found = inferDivisions(n, boxOrder, size);
    const what = boxOrder ? 'a box/bound' : 'a point_grid (divisions + 1 points per axis)';
    if (!found)
      throw new NodeError(
        `the deformed lattice has ${n} points, but ${what} with divisions [${D.join(', ')}] has ${count(D)}`,
        'set divisions to match the lattice, wire the rest lattice into input 2 and the deformed one into input 3, or run the lattice through a rest node before deforming it',
      );
    warn(`divisions [${D.join(', ')}] give ${count(D)} lattice points but the deformed lattice has ${n}: using divisions [${found.join(', ')}]`);
    D = found;
  }
  if (boxOrder) return makeBox(size, center, D).P;
  const out = new Float64Array(n * 3);
  let o = 0;
  for (let k = 0; k <= D[2]; k++)
    for (let j = 0; j <= D[1]; j++)
      for (let i = 0; i <= D[0]; i++) {
        const t = [i, j, k];
        for (let a = 0; a < 3; a++) out[o++] = D[a] ? b.min[a] + (size[a] * t[a]) / D[a] : center[a];
      }
  return out;
}

defineNode({
  type: 'lattice',
  category: 'deform',
  packed: 'keep',
  summary: 'Free-form deformation: bend geometry by moving the points of a coarse lattice box (trilinear or Bezier).',
  description:
    'Embeds the geometry in a lattice and moves it with the lattice. Three inputs: geo, rest lattice, deformed lattice ' +
    '(same point count and order). The rest lattice can be any axis-aligned grid of points (point_grid, box or bound with ' +
    'divisions, any spacing); the interior nodes a box lacks are filled harmonically. Two inputs: input 2 is the DEFORMED ' +
    'lattice; its rest is its "rest" attribute if present, else the bounding box of geo with `divisions` (box order when ' +
    'the lattice has faces, point_grid order when it is points only), so geo → bound(divisions) → bend → lattice is the ' +
    'simplest graph. Points outside the lattice are extrapolated. Houdini: Lattice SOP; interp = bernstein is the classic ' +
    'Sederberg–Parry FFD (assumes evenly spaced rest nodes).',
  aliases: ['latticedeform', 'ffd'],
  inputs: [
    { name: 'geo', desc: 'geometry to deform' },
    { name: 'lattice', desc: 'rest lattice (axis-aligned point_grid / box / bound); with only two inputs: the deformed lattice' },
    { name: 'deformed', desc: 'deformed lattice: the rest lattice with its points moved (same count and order)', optional: true },
  ],
  params: {
    divisions: { type: 'ivec3', default: [2, 2, 2], min: 1, desc: 'two-input form without a "rest" attribute: lattice divisions, matching the box/bound (or point_grid counts - 1) that was deformed; inferred with a warning when they do not match', aliases: ['divs', 'div'] },
    interp: { type: 'enum', options: ['trilinear', 'bernstein'], default: 'trilinear', desc: 'trilinear = piecewise per lattice cell (local); bernstein = smooth Bezier volume over the whole lattice (global; evenly spaced lattices)', aliases: ['interpolation', 'mode'] },
    group: P.group('point', 'points to deform ("" = all)'),
  },
  example: {
    nodes: {
      column: { type: 'tube', params: { radius: 0.25, height: 3, rows: 30, center: [0, 1.5, 0] } },
      cage: { type: 'bound', in: ['column'], params: { divisions: [1, 4, 1] } },
      bent: { type: 'bend', in: ['cage'], params: { angle: 70 } },
      out: { type: 'lattice', in: ['column', 'bent'], params: { divisions: [1, 4, 1] } },
    },
  },
  cook: ({ input, hasInput, p, warn }) => {
    const src = input(0);
    if (!hasInput(1)) throw new NodeError('lattice needs a lattice in input 2 (the deformed lattice, or the rest lattice with the deformed one in input 3)');
    if (!src.numPoints) return src;
    let R: ArrayLike<number>, D: ArrayLike<number>;
    if (hasInput(2)) {
      const rest = input(1), def = input(2);
      if (rest.numPoints !== def.numPoints) throw new NodeError(`rest lattice has ${rest.numPoints} points, deformed lattice has ${def.numPoints}: they must match`, LATTICE_HINT);
      R = rest.P; D = def.P;
    } else {
      const def = input(1);
      D = def.P;
      if (!D.length) throw new NodeError('the lattice has no points');
      R = vec3Attrib(def, 'rest') ?? bboxRestLattice(src, def, p.divisions, warn);
    }
    if (!D.length) throw new NodeError('the lattice has no points');
    const g = src.clone();
    const L = buildLattice(R, D);
    const evalDisp = p.interp === 'bernstein' ? makeBernstein(L) : (x: number, y: number, z: number, o: number[]) => trilinear(L, x, y, z, o);
    const sel = mask(g, 'point', p.group);
    const Pd = g.P, d = [0, 0, 0];
    for (let i = 0; i < g.numPoints; i++) {
      if (sel && !sel[i]) continue;
      evalDisp(Pd[i * 3], Pd[i * 3 + 1], Pd[i * 3 + 2], d);
      Pd[i * 3] += d[0]; Pd[i * 3 + 1] += d[1]; Pd[i * 3 + 2] += d[2];
    }
    return refreshNormals(g);
  },
});

// ---------------------------------------------------------------- path_deform

interface Curve { pts: number[][]; closed: boolean; ups?: Vec3[] }

/** The first curve of g (a prim with at least two points); points without prims count as one polyline in order. */
function firstCurve(g: Geometry, what: string): Curve {
  const Pd = g.P;
  let idx: number[] | null = null, closed = false;
  for (let pr = 0; pr < g.numPrims && !idx; pr++) {
    const ids = g.primPoints(pr);
    if (ids.length < 2) continue;
    idx = ids; closed = !!g.primClosed[pr];
  }
  if (!idx && !g.numPrims && g.numPoints >= 2) idx = Array.from({ length: g.numPoints }, (_, i) => i);
  if (!idx) throw new NodeError(`${what} input has no curve (needs a polyline or polygon with at least 2 points)`);
  if (!closed && idx.length > 2 && idx[0] === idx[idx.length - 1]) { idx = idx.slice(0, -1); closed = true; }
  const upA = vec3Attrib(g, 'up');
  return {
    pts: idx.map((i) => [Pd[i * 3], Pd[i * 3 + 1], Pd[i * 3 + 2]]),
    closed,
    ups: upA ? idx.map((i) => [upA[i * 3], upA[i * 3 + 1], upA[i * 3 + 2]] as Vec3) : undefined,
  };
}

/** Component of u perpendicular to the unit vector t, normalised (with a fallback when u is parallel to t). */
function perpUp(t: Vec3, u: Vec3): Vec3 {
  const d = dot(u, t);
  let y: Vec3 = [u[0] - t[0] * d, u[1] - t[1] * d, u[2] - t[2] * d];
  if (Math.hypot(y[0], y[1], y[2]) < 1e-6) {
    const alt: Vec3 = Math.abs(t[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const e = dot(alt, t);
    y = [alt[0] - t[0] * e, alt[1] - t[1] * e, alt[2] - t[2] * e];
  }
  return normalize(y);
}

interface Frame { pos: number[]; X: number[]; Y: number[]; T: number[] }
const newFrame = (): Frame => ({ pos: [0, 0, 0], X: [0, 0, 0], Y: [0, 0, 0], T: [0, 0, 0] });

/** Arc-length parametrised polyline with per-point frames (rotation-minimising or a fixed up vector). */
class CurveSampler {
  pts: number[][];
  closed: boolean;
  X: Vec3[];
  Y: Vec3[];
  T: Vec3[];
  Ls: Float64Array;
  length: number;
  nseg: number;

  constructor(c: Curve, frame: string, up: Vec3) {
    this.pts = c.pts;
    this.closed = c.closed;
    const F = rmFrames(c.pts, c.closed, up, frame === 'rmf' ? c.ups : undefined);
    this.T = F.T;
    if (frame === 'up') {
      this.Y = F.T.map((t, i) => perpUp(t, c.ups ? normalize(c.ups[i]) : up));
      this.X = this.Y.map((y, i) => cross(y, F.T[i]));
    } else { this.X = F.X; this.Y = F.Y; }
    const n = c.pts.length;
    this.nseg = c.closed ? n : n - 1;
    this.Ls = new Float64Array(this.nseg + 1);
    for (let k = 0; k < this.nseg; k++) {
      const a = c.pts[k], b = c.pts[(k + 1) % n];
      this.Ls[k + 1] = this.Ls[k] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    }
    this.length = this.Ls[this.nseg];
  }

  /** Position and frame at arc length s. Open curves continue straight past their ends; closed curves wrap. */
  at(s: number, o: Frame) {
    const n = this.pts.length, L = this.length;
    if (this.closed) s = ((s % L) + L) % L;
    else if (s <= 0 || s >= L) {
      const e = s <= 0 ? 0 : n - 1, over = s <= 0 ? s : s - L;
      const p = this.pts[e], T = this.T[e];
      for (let a = 0; a < 3; a++) { o.pos[a] = p[a] + T[a] * over; o.X[a] = this.X[e][a]; o.Y[a] = this.Y[e][a]; o.T[a] = T[a]; }
      return;
    }
    let lo = 0, hi = this.nseg - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.Ls[mid] <= s) lo = mid; else hi = mid - 1;
    }
    const a = lo, b = (lo + 1) % n, seg = this.Ls[lo + 1] - this.Ls[lo];
    const f = seg > 0 ? Math.min(1, Math.max(0, (s - this.Ls[lo]) / seg)) : 0;
    const Ta = this.T[a], Tb = this.T[b], Ya = this.Y[a], Yb = this.Y[b];
    let T = normalize([Ta[0] + (Tb[0] - Ta[0]) * f, Ta[1] + (Tb[1] - Ta[1]) * f, Ta[2] + (Tb[2] - Ta[2]) * f]);
    if (T[0] === 0 && T[1] === 0 && T[2] === 0) T = Ta;
    const yl: Vec3 = [Ya[0] + (Yb[0] - Ya[0]) * f, Ya[1] + (Yb[1] - Ya[1]) * f, Ya[2] + (Yb[2] - Ya[2]) * f];
    const d = dot(yl, T);
    let Y = normalize([yl[0] - T[0] * d, yl[1] - T[1] * d, yl[2] - T[2] * d]);
    if (Y[0] === 0 && Y[1] === 0 && Y[2] === 0) Y = perpendicular(T);
    const X = cross(Y, T);
    const pa = this.pts[a], pb = this.pts[b];
    for (let c = 0; c < 3; c++) { o.pos[c] = pa[c] + (pb[c] - pa[c]) * f; o.X[c] = X[c]; o.Y[c] = Y[c]; o.T[c] = T[c]; }
  }

  /** Arc length of the point on the curve closest to (x, y, z). */
  closest(x: number, y: number, z: number): number {
    const n = this.pts.length;
    let best = Infinity, bs = 0;
    for (let k = 0; k < this.nseg; k++) {
      const a = this.pts[k], b = this.pts[(k + 1) % n];
      const ex = b[0] - a[0], ey = b[1] - a[1], ez = b[2] - a[2];
      const l2 = ex * ex + ey * ey + ez * ez;
      let t = l2 > 0 ? ((x - a[0]) * ex + (y - a[1]) * ey + (z - a[2]) * ez) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = a[0] + ex * t - x, dy = a[1] + ey * t - y, dz = a[2] + ez * t - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < best) { best = d2; bs = this.Ls[k] + (this.Ls[k + 1] - this.Ls[k]) * t; }
    }
    return bs;
  }
}

defineNode({
  type: 'path_deform',
  category: 'deform',
  packed: 'keep',
  summary: 'Bend geometry along a curve: the geometry axis (default Z) follows the path with rotation-minimising frames, twist and stretch.',
  description:
    'The geometry coordinate along `axis` becomes arc length on the curve; the other two coordinates become offsets in ' +
    'the curve frame (for axis z: x → side, y → up; the frame starts from `up`, so a straight curve along +Z from the ' +
    'origin leaves the geometry unchanged). The reference is the straight line along `axis` through the origin, or the ' +
    'bounding box along `axis` when `stretch` is on (then it maps onto `length` or the whole curve). With a rest curve in ' +
    'input 3, each point binds to its closest point on that curve instead, so geometry modelled along one curve moves to ' +
    'another. Open curves continue straight past their ends; closed curves wrap. Point N, up, v and orient rotate with ' +
    'the frame. Houdini: Path Deform SOP (the rest-curve form is like Wire/Curve deform).',
  aliases: ['pathdeform', 'curve_deform', 'curvedeform'],
  inputs: [
    { name: 'geo', desc: 'geometry laid out along `axis`' },
    { name: 'curve', desc: 'the path: the first curve (polyline; a closed polygon loops)' },
    { name: 'rest_curve', desc: 'optional curve the geometry was modelled along (points bind to their closest point on it)', optional: true },
  ],
  params: {
    axis: { type: 'enum', options: ['z', 'x', 'y'], default: 'z', desc: 'geometry axis mapped along the curve' },
    offset: { type: 'float', default: 0, desc: 'slide along the path, in metres', aliases: ['shift', 'path_offset'] },
    stretch: { type: 'bool', default: false, desc: 'scale the geometry along the path so its extent along `axis` covers `length` (or the whole curve)', aliases: ['fit', 'stretch_to_fit'] },
    length: { type: 'float', default: 0, min: 0, desc: 'stretch: target length along the path (0 = the curve length)' },
    twist: { type: 'float', default: 0, desc: 'twist in degrees about the path, accumulated linearly over the whole curve length' },
    roll: { type: 'float', default: 0, desc: 'constant rotation about the path in degrees' },
    up: { type: 'vec3', default: [0, 1, 0], desc: 'up hint: the frame Y starts closest to it (rmf) or follows it everywhere (frame = up); a curve point attribute "up" overrides' },
    frame: { type: 'enum', options: ['rmf', 'up'], default: 'rmf', desc: 'rmf = rotation-minimising frames (no flips on 3D curves); up = keep Y toward `up` at every point (roads, rails that stay level)' },
    group: P.group('point', 'points to deform ("" = all)'),
  },
  example: {
    nodes: {
      link: { type: 'box', params: { size: [0.12, 0.04, 0.25] } },
      links: { type: 'copy_xform', in: ['link'], params: { count: 40, translate: [0, 0, 0.3], rotate: [0, 0, 90] } },
      path: { type: 'spiral', params: { radius: 1, height: 2, turns: 2 } },
      out: { type: 'path_deform', in: ['links', 'path'], params: { stretch: true } },
    },
  },
  cook: ({ input, hasInput, p }) => {
    const src = input(0);
    const ul = Math.hypot(p.up[0], p.up[1], p.up[2]);
    const up: Vec3 = ul > 1e-12 ? [p.up[0] / ul, p.up[1] / ul, p.up[2] / ul] : [0, 1, 0];
    const path = new CurveSampler(firstCurve(input(1), 'curve'), p.frame, up);
    const L = path.length;
    if (!(L > 0)) throw new NodeError('the path curve has zero length');
    const g = src.clone();
    const n = g.numPoints;
    if (!n) return g;
    const sel = mask(g, 'point', p.group);
    const Pd = g.P;
    const target = p.length > 0 ? p.length : L;
    // binding: arc length s on the path, cross-section coordinates (a, b) and the rest frame of every point
    const S = new Float64Array(n), A = new Float64Array(n), B = new Float64Array(n);
    const restFrames: Frame[] | null = hasInput(2) ? [] : null;
    let X0: Vec3 = [1, 0, 0], Y0: Vec3 = [0, 1, 0], T0: Vec3 = [0, 0, 1];
    if (restFrames) {
      const rest = new CurveSampler(firstCurve(input(2), 'rest_curve'), p.frame, up);
      if (!(rest.length > 0)) throw new NodeError('the rest curve has zero length');
      const k = p.stretch ? target / rest.length : 1;
      for (let i = 0; i < n; i++) {
        const f = newFrame();
        restFrames.push(f);
        if (sel && !sel[i]) continue;
        const x = Pd[i * 3], y = Pd[i * 3 + 1], z = Pd[i * 3 + 2];
        const s0 = rest.closest(x, y, z);
        rest.at(s0, f);
        const dx = x - f.pos[0], dy = y - f.pos[1], dz = z - f.pos[2];
        A[i] = dx * f.X[0] + dy * f.X[1] + dz * f.X[2];
        B[i] = dx * f.Y[0] + dy * f.Y[1] + dz * f.Y[2];
        S[i] = (s0 + dx * f.T[0] + dy * f.T[1] + dz * f.T[2]) * k + p.offset;
      }
    } else {
      T0 = AXES[p.axis];
      Y0 = perpUp(T0, up);
      X0 = cross(Y0, T0);
      let cmin = Infinity, cmax = -Infinity;
      for (let i = 0; i < n; i++) {
        const c = Pd[i * 3] * T0[0] + Pd[i * 3 + 1] * T0[1] + Pd[i * 3 + 2] * T0[2];
        if (c < cmin) cmin = c;
        if (c > cmax) cmax = c;
      }
      const ext = cmax - cmin;
      const k = p.stretch && ext > 1e-12 ? target / ext : 1, base = p.stretch ? cmin : 0;
      for (let i = 0; i < n; i++) {
        const x = Pd[i * 3], y = Pd[i * 3 + 1], z = Pd[i * 3 + 2];
        A[i] = x * X0[0] + y * X0[1] + z * X0[2];
        B[i] = x * Y0[0] + y * Y0[1] + z * Y0[2];
        S[i] = (x * T0[0] + y * T0[1] + z * T0[2] - base) * k + p.offset;
      }
    }
    const fa = frameAttribs(g);
    const f = newFrame(), rot = new Float64Array(9), Xr = [0, 0, 0], Yr = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      if (sel && !sel[i]) continue;
      const s = S[i];
      path.at(s, f);
      const th = (p.roll + (p.twist * s) / L) * DEG, cs = Math.cos(th), sn = Math.sin(th);
      for (let c = 0; c < 3; c++) {
        Xr[c] = f.X[c] * cs + f.Y[c] * sn;
        Yr[c] = f.Y[c] * cs - f.X[c] * sn;
        Pd[i * 3 + c] = f.pos[c] + Xr[c] * A[i] + Yr[c] * B[i];
      }
      if (fa) {
        const rf = restFrames ? restFrames[i] : null;
        const x0 = rf ? rf.X : X0, y0 = rf ? rf.Y : Y0, t0 = rf ? rf.T : T0;
        for (let r = 0; r < 3; r++)
          for (let c = 0; c < 3; c++) rot[r * 3 + c] = Xr[r] * x0[c] + Yr[r] * y0[c] + f.T[r] * t0[c];
        transformFrameAttribs(fa, i, rot, true);
      }
    }
    return refreshNormals(g);
  },
});

// ---------------------------------------------------------------- point_deform

interface Binding {
  /** per geometry point: range into idx/w */
  start: Int32Array;
  idx: Int32Array;
  w: Float64Array;
  /** per proxy point: range into fitIdx (neighbours used to fit its local transform) */
  fitStart: Int32Array;
  fitIdx: Int32Array;
}

const bindingCache = new Map<string, Binding>();
const BINDING_CACHE_SIZE = 4;

/** Capture weights of every geometry point to its nearest proxy points, plus each proxy point's fit neighbours. */
function computeBinding(G: Float64Array, R: Float64Array, radius: number, K: number, power: number, F: number): Binding {
  const ng = G.length / 3, nr = R.length / 3;
  const tree = new KDTree(R);
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < nr; i++) for (let a = 0; a < 3; a++) { const v = R[i * 3 + a]; if (v < mn[a]) mn[a] = v; if (v > mx[a]) mx[a] = v; }
  const eps = 1e-9 * (Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) || 1);
  const start = new Int32Array(ng + 1), idx: number[] = [], w: number[] = [];
  const dist = (j: number, x: number, y: number, z: number) => Math.hypot(R[j * 3] - x, R[j * 3 + 1] - y, R[j * 3 + 2] - z);
  for (let i = 0; i < ng; i++) {
    start[i] = idx.length;
    const x = G[i * 3], y = G[i * 3 + 1], z = G[i * 3 + 2];
    const cand = radius > 0 ? tree.within(x, y, z, radius, K + 1) : tree.knn(x, y, z, K + 1);
    if (!cand.length) continue;
    const d = cand.map((j) => dist(j, x, y, z));
    if (d[0] < eps) { idx.push(cand[0]); w.push(1); continue; }
    // Franke–Little weights fade to 0 at the (K+1)-th neighbour, so the capture is continuous across space
    const m = Math.min(K, cand.length);
    const cut = cand.length > K ? d[K] : radius > 0 ? radius : Infinity;
    const ws: number[] = [];
    let sum = 0;
    for (let k = 0; k < m; k++) {
      const v = Number.isFinite(cut) ? Math.max(0, cut - d[k]) / (cut * d[k]) : 1 / d[k];
      ws.push(Math.pow(v, power));
      sum += ws[k];
    }
    if (!(sum > 0)) {
      sum = 0;
      for (let k = 0; k < m; k++) { ws[k] = Math.pow(1 / d[k], power); sum += ws[k]; }
    }
    for (let k = 0; k < m; k++) if (ws[k] > 0) { idx.push(cand[k]); w.push(ws[k] / sum); }
  }
  start[ng] = idx.length;
  const fitStart = new Int32Array(nr + 1), fitIdx: number[] = [];
  for (let j = 0; j < nr; j++) {
    fitStart[j] = fitIdx.length;
    const x = R[j * 3], y = R[j * 3 + 1], z = R[j * 3 + 2];
    for (const q of tree.knn(x, y, z, F + 1)) if (q !== j && dist(q, x, y, z) > eps) fitIdx.push(q);
  }
  fitStart[nr] = fitIdx.length;
  return { start, idx: Int32Array.from(idx), w: Float64Array.from(w), fitStart, fitIdx: Int32Array.from(fitIdx) };
}

/** Binding from a small LRU cache keyed by content, so re-cooks with only the deformed proxy changed skip the capture. */
function getBinding(G: Float64Array, R: Float64Array, radius: number, K: number, power: number, F: number): Binding {
  const key = `${hashFloats(G)}|${hashFloats(R)}|${radius}|${K}|${power}|${F}`;
  const hit = bindingCache.get(key);
  if (hit) { bindingCache.delete(key); bindingCache.set(key, hit); return hit; }
  const b = computeBinding(G, R, radius, K, power, F);
  bindingCache.set(key, b);
  while (bindingCache.size > BINDING_CACHE_SIZE) bindingCache.delete(bindingCache.keys().next().value!);
  return b;
}

/** Local linear transform of every proxy point (row-major 3x3 each), fitted to how its neighbours moved. */
function proxyTransforms(R: Float64Array, D: Float64Array, bind: Binding, mode: string): Float64Array {
  const nr = R.length / 3;
  const out = new Float64Array(nr * 9);
  const S = new Float64Array(9), C = new Float64Array(9), a = [0, 0, 0], b = [0, 0, 0];
  for (let j = 0; j < nr; j++) {
    if (mode === 'translate' || bind.fitStart[j + 1] === bind.fitStart[j]) { out.set(m3identity(), j * 9); continue; }
    S.fill(0); C.fill(0);
    let tr = 0;
    for (let e = bind.fitStart[j]; e < bind.fitStart[j + 1]; e++) {
      const q = bind.fitIdx[e];
      for (let c = 0; c < 3; c++) { a[c] = R[q * 3 + c] - R[j * 3 + c]; b[c] = D[q * 3 + c] - D[j * 3 + c]; }
      const ww = 1 / (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) { S[r * 3 + c] += ww * a[r] * b[c]; C[r * 3 + c] += ww * a[r] * a[c]; }
      tr += 1;
    }
    // a small pull toward identity resolves rotations about collinear neighbourhoods and unconstrained directions
    const lam = 1e-9 * tr;
    const Sr = S.slice();
    Sr[0] += lam; Sr[4] += lam; Sr[8] += lam;
    const Rm = quatToM3(hornRotation(Sr));
    if (mode !== 'affine') { out.set(Rm, j * 9); continue; }
    // stretch in the rotated frame: X = (Rᵀ Σ b aᵀ + λI)(Σ a aᵀ + λI)⁻¹, M = R X
    const RtB = m3mul(m3transpose(Rm), m3transpose(S));
    RtB[0] += lam; RtB[4] += lam; RtB[8] += lam;
    const Cr = C.slice();
    Cr[0] += lam; Cr[4] += lam; Cr[8] += lam;
    const Ci = m3invert(Cr);
    out.set(Ci ? m3mul(Rm, m3mul(RtB, Ci)) : Rm, j * 9);
  }
  return out;
}

defineNode({
  type: 'point_deform',
  category: 'deform',
  packed: 'keep',
  summary: 'Deform geometry by a proxy: points follow their nearest proxy points, including the local rotation (Houdini Point Deform).',
  description:
    'Each geometry point is captured by its `max_points` nearest rest proxy points (within `radius` when it is > 0), with ' +
    'inverse-distance weights that fade to zero at the next-nearest point, so the capture is smooth. Each proxy point gets a ' +
    'local transform fitted to how its neighbours moved (`mode`: rigid rotation, affine with stretch, or plain offsets), and ' +
    'the geometry point moves with the weighted blend of those transforms, so bends and twists of a coarse proxy (a point ' +
    'cloud, a simulated low-res mesh, a point lattice) rotate the detail instead of shearing it. Rest and deformed proxy ' +
    'need the same point count and order. Two inputs: input 2 is the deformed proxy and its "rest" attribute is the rest. ' +
    'The capture is cached by content, so re-cooks where only the deformed proxy changes re-use it. Houdini: Point Deform SOP.',
  aliases: ['pointdeform', 'proxy_deform'],
  inputs: [
    { name: 'geo', desc: 'geometry to deform (e.g. the high-res mesh)' },
    { name: 'rest', desc: 'rest proxy points (point cloud or mesh); with only two inputs: the deformed proxy carrying a "rest" attribute' },
    { name: 'deformed', desc: 'deformed proxy: the rest proxy with its points moved (same count and order)', optional: true },
  ],
  params: {
    radius: { type: 'float', default: 0, min: 0, desc: 'capture radius around each geometry point (0 = unlimited: always the nearest max_points); points with no proxy point in range stay put' },
    max_points: { type: 'int', default: 4, min: 1, max: 64, desc: 'proxy points each geometry point is bound to', aliases: ['maxpts', 'max_pts', 'k'] },
    power: { type: 'float', default: 2, min: 0, max: 8, desc: 'inverse-distance weight exponent (higher = each point follows its nearest proxy point more closely)' },
    mode: { type: 'enum', options: ['rigid', 'affine', 'translate'], default: 'rigid', desc: 'local transform of each proxy point: rigid = rotation (detail keeps its shape), affine = rotation + stretch/shear, translate = offsets only (no rotation)' },
    fit_points: { type: 'int', default: 8, min: 2, max: 64, desc: 'neighbours used to fit each proxy point\'s local transform', advanced: true },
    group: P.group('point', 'points to deform ("" = all)'),
  },
  example: {
    nodes: {
      geo: { type: 'tube', params: { radius: 0.3, height: 2, rows: 20, center: [0, 1, 0] } },
      rest: { type: 'point_grid', params: { counts: [3, 6, 3], size: [0.8, 2, 0.8], center: [0, 1, 0] } },
      bent: { type: 'bend', in: ['rest'], params: { angle: 90 } },
      out: { type: 'point_deform', in: ['geo', 'rest', 'bent'] },
    },
  },
  cook: ({ input, hasInput, p }) => {
    const src = input(0);
    let R: Float64Array, D: Float64Array;
    if (hasInput(2)) {
      const rest = input(1), def = input(2);
      if (rest.numPoints !== def.numPoints)
        throw new NodeError(`rest proxy has ${rest.numPoints} points, deformed proxy has ${def.numPoints}: they must match`, 'deform a copy of the rest proxy without adding or removing points');
      R = rest.P; D = def.P;
    } else if (hasInput(1)) {
      const def = input(1);
      const ra = vec3Attrib(def, 'rest');
      if (!ra) throw new NodeError('with two inputs the proxy must carry a "rest" point attribute', 'wire geo, rest proxy and deformed proxy, or run the proxy through a rest node before deforming it');
      R = ra; D = def.P;
    } else throw new NodeError('point_deform needs the rest and deformed proxy points in inputs 2 and 3');
    if (!R.length) throw new NodeError('the proxy has no points');
    const g = src.clone();
    const n = g.numPoints;
    if (!n) return g;
    const bind = getBinding(src.P, R, p.radius, p.max_points, p.power, p.fit_points);
    const M = proxyTransforms(R, D, bind, p.mode);
    const sel = mask(g, 'point', p.group);
    const Pd = g.P, fa = frameAttribs(g), Lacc = new Float64Array(9);
    for (let i = 0; i < n; i++) {
      if (sel && !sel[i]) continue;
      const s = bind.start[i], e = bind.start[i + 1];
      if (s === e) continue;
      const x = Pd[i * 3], y = Pd[i * 3 + 1], z = Pd[i * 3 + 2];
      let ox = 0, oy = 0, oz = 0;
      if (fa) Lacc.fill(0);
      for (let k = s; k < e; k++) {
        const j = bind.idx[k], w = bind.w[k], m = j * 9;
        const dx = x - R[j * 3], dy = y - R[j * 3 + 1], dz = z - R[j * 3 + 2];
        ox += w * (D[j * 3] + M[m] * dx + M[m + 1] * dy + M[m + 2] * dz);
        oy += w * (D[j * 3 + 1] + M[m + 3] * dx + M[m + 4] * dy + M[m + 5] * dz);
        oz += w * (D[j * 3 + 2] + M[m + 6] * dx + M[m + 7] * dy + M[m + 8] * dz);
        if (fa) for (let c = 0; c < 9; c++) Lacc[c] += w * M[m + c];
      }
      Pd[i * 3] = ox; Pd[i * 3 + 1] = oy; Pd[i * 3 + 2] = oz;
      if (fa) transformFrameAttribs(fa, i, Lacc);
    }
    return refreshNormals(g);
  },
});

// ---------------------------------------------------------------- rest

defineNode({
  type: 'rest',
  category: 'deform',
  packed: 'keep',
  summary: 'Store the current positions in a "rest" point attribute, so noise and textures stay put while the geometry deforms.',
  description:
    'Copies P (or P of the second input, which must have the same point count) into a vec3 point attribute. Nodes that ' +
    'sample noise in space (noise_displace, attrib_noise) read "rest" instead of P when it exists, so a noise pattern ' +
    'sticks to the surface through later transforms and deformers. lattice and point_deform also read a "rest" attribute ' +
    'on a deformed cage as its rest shape. Houdini: Rest Position SOP (rest, rnml).',
  aliases: ['rest_position', 'restpos'],
  inputs: [
    { name: 'geo', desc: 'geometry' },
    { name: 'rest_from', desc: 'optional geometry with the same point count whose positions become the rest', optional: true },
  ],
  params: {
    name: { type: 'string', default: 'rest', desc: 'attribute name', aliases: ['attrib', 'attribute'] },
    normals: { type: 'bool', default: false, desc: 'also store the point normals as "rnml" (computed from the faces when there is no N)', aliases: ['rnml', 'rest_normals'] },
  },
  outputs: 'point rest (vec3), rnml (vec3, normals = true)',
  example: {
    nodes: {
      ball: { type: 'sphere', params: { type: 'ico', level: 4 } },
      rest: { type: 'rest', in: ['ball'] },
      moved: { type: 'transform', in: ['rest'], params: { translate: [3, 0, 0] } },
      out: { type: 'noise_displace', in: ['moved'], params: { amplitude: 0.2, frequency: 2 } },
    },
  },
  cook: ({ input, hasInput, p }) => {
    if (!p.name) throw new NodeError('name must not be empty');
    const g = input(0).clone();
    let src = g;
    if (hasInput(1)) {
      src = input(1);
      if (src.numPoints !== g.numPoints) throw new NodeError(`rest_from has ${src.numPoints} points, geo has ${g.numPoints}: they must match`);
    }
    (g.points.add(p.name, 'float', 3).data as Float64Array).set(src.P);
    if (p.normals) (g.points.add('rnml', 'float', 3).data as Float64Array).set(getPointNormals(src));
    return g;
  },
});
