// Particle simulation (Houdini POP-lite) for the `particles` node (src/nodes/particles.ts).
//
// Model. Time advances in steps of dt = 1 / (fps × substeps). At step s, emitter points give birth to particles (a
// rate per step with a per-point phase, plus `emit_all` births at the start); then every live particle integrates one
// step: forces (gravity, noise or curl noise, a field from points / a heightfield / an SDF, attraction), drag toward the
// air velocity (wind, air fields), semi-implicit Euler, then collisions with a floor plane and a mesh (die, slide, bounce
// with Coulomb friction). Particles live until their life runs out or a `die` collision removes them.
//
// Why it parallelises. Particles never interact, and every decision that couples them is made before integration:
// births depend only on the emitters, the step and the lifetimes (`max_particles` counts a particle from its birth to the
// end of its life, also when a collision removed it earlier), so a whole run of steps is emitted first and then each
// particle integrates through it on its own. The integration is one kernel ("particles", src/core/kernels.ts) over the
// particles: chunked on the worker pool it gives the same bits as on one thread (no shared state, per-particle
// randomness is drawn at birth, the collision BVH and field data are shared read-only arrays). A run of steps can also be
// cut anywhere (per frame) with the same result, which is what lets the node cache per-frame states.
//
// State. Between runs the simulation lives in a point Geometry (the node caches it per frame, like the solver): the
// particles' carried emitter attributes and point groups, P, v, id, life, pscale, and internal attributes: __pb (birth
// step), __pu (birth offset within the step: 0 = emitted at time 0 by emit_all, else in (0, 1]), __pkd (the step after
// which the particle dies of age, NEVER = immortal), __pcn (its last contact normal, zero after a step without one),
// __ptrail (ring of the last `trail` positions); detail __pstep (steps simulated), __pnextid, __pskipped (births refused
// by max_particles), __pholders (death steps of particles a collision removed while their life still runs: they keep
// their max_particles slot).
import { Attribute, AttribTable, Geometry } from './geometry.ts';
import { RayScene } from './analysis.ts';
import { closestScratch } from './spatial.ts';
import type { ClosestScratch } from './spatial.ts';
import { randN, rng } from './random.ts';
import type { Heightfield } from './heightfield.ts';
import type { KernelContext } from './kernels.ts';

/** Death step of particles that never die of age. */
export const NEVER = 2147483647;
/** Most steps one cook may simulate. */
export const MAX_STEPS = 1_000_000;
/** Collision responses (index = StepArgs.collide). */
export const COLLIDE_MODES = ['none', 'die', 'slide', 'bounce'];
/** Internal attribute names (never in the node output). */
export const INTERNAL = ['__pb', '__pu', '__pkd', '__pcn', '__ptrail'];
/** Most contacts resolved per particle and step (the rest of the step is dropped). */
const MAX_CONTACTS = 4;

// ---------------------------------------------------------------- kernel arguments

/** Field from input 2: 0 none, 1 points with v (nearest / IDW), 2 heightfield gradient, 3 SDF gradient (sampled grid). */
export type FieldType = 0 | 1 | 2 | 3;

export interface StepArgs {
  /** steps [s0, s1) */
  s0: number;
  s1: number;
  dt: number;
  /** trail ring length (0 = none) */
  trail: number;
  gravity: number[];
  drag: number;
  wind: number[];
  /** noise force amplitude (m/s²), element size (m), curl, octaves, seed */
  noise: number;
  noiseSize: number;
  curl: boolean;
  octaves: number;
  seed: number;
  /** spring strength toward the target (1/s²); 0 none, 1 a point, 2 the closest point of the collision surface */
  attract: number;
  attractMode: 0 | 1 | 2;
  attractPoint: number[];
  /** index into COLLIDE_MODES */
  collide: number;
  bounce: number;
  friction: number;
  floor: boolean;
  floorY: number;
  /** a collision mesh is shared (BVH arrays T, nodes, child, order, triPt) */
  mesh: boolean;
  /** stand-off distance from the mesh for point particles (m) */
  skin: number;
  /** a bounce slower than this (m/s) comes to rest instead */
  restSpeed: number;
  field: FieldType;
  /** the field vector adds to the air velocity (acts through drag) instead of the acceleration */
  fieldAir: boolean;
  fieldScale: number;
  /** points: neighbours (1 = nearest, more = inverse-distance weighted) and search radius (0 = unlimited) */
  fieldK: number;
  fieldMaxD: number;
  /** heightfield grid: samples, cell size, origin (gradient arrays hGX, hGZ shared) */
  hf?: { w: number; h: number; cell: number; ox: number; oz: number };
  /** SDF grid: samples, origin, voxel size (values gV shared) */
  grid?: { nx: number; ny: number; nz: number; ox: number; oy: number; oz: number; voxel: number };
}

// ---------------------------------------------------------------- ages and lifetimes

/** Age (s) after S steps of a particle born at step b with offset u (exactly the expression used everywhere). */
export function ageAt(S: number, b: number, u: number, dt: number): number {
  return (S - b - u) * dt;
}

/** The step after which a particle born at (b, u) with this life dies of age: the first k >= b with ageAt(k+1) >= life. */
export function deathStep(b: number, u: number, life: number, dt: number): number {
  if (!(life > 0)) return NEVER;
  let k = Math.max(b, Math.ceil(life / dt + b + u) - 1);
  if (!Number.isFinite(k) || k >= NEVER - 2) return NEVER;
  while (k > b && ageAt(k, b, u, dt) >= life) k--;
  while (ageAt(k + 1, b, u, dt) < life) k++;
  return k;
}

// ---------------------------------------------------------------- the integration kernel

interface KScratch {
  /** px py pz vx vy vz */
  st: Float64Array;
  /** contact normal */
  n: Float64Array;
  /** force / vector scratch */
  f: Float64Array;
  cs: ClosestScratch;
  ki: Int32Array;
  kd: Float64Array;
  kstack: Int32Array;
  kbound: Float64Array;
  /** the last contact found was the floor */
  floorHit: boolean;
  /** mesh contact: n · (a point of the hit triangle) */
  planeD: number;
  /** the particle's last contact normal (zero = none in the previous step) */
  cn: Float64Array;
}

// ---------------------------------------------------------------- noise with gradients

/** Gradient directions of improved Perlin noise, by hash & 15 (the 12 cube edges, 4 repeated). */
const GRAD = new Float64Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 1, 1, 0, 0, -1, 1, -1, 1, 0, 0, -1, -1,
]);

/** Permutation table of improved Perlin noise for a seed (512 entries, the 256-entry shuffle twice). */
export function perlinPerm(seed: number): Uint8Array {
  const r = rng(seed), perm = Array.from({ length: 256 }, (_, i) => i), p = new Uint8Array(512);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
  }
  for (let i = 0; i < 512; i++) p[i] = perm[i & 255];
  return p;
}

/**
 * Improved Perlin noise at (x, y, z) with its analytic gradient: returns the value and writes d/dx, d/dy, d/dz to
 * out[0..2]. One evaluation instead of the six a finite-difference gradient needs.
 */
export function perlinGrad(p: Uint8Array, x: number, y: number, z: number, out: Float64Array): number {
  const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
  const X = fx & 255, Y = fy & 255, Z = fz & 255;
  x -= fx; y -= fy; z -= fz;
  const u = x * x * x * (x * (x * 6 - 15) + 10), v = y * y * y * (y * (y * 6 - 15) + 10), w = z * z * z * (z * (z * 6 - 15) + 10);
  const du = 30 * x * x * (x * (x - 2) + 1), dv = 30 * y * y * (y * (y - 2) + 1), dw = 30 * z * z * (z * (z - 2) + 1);
  const A = p[X] + Y, AA = p[A] + Z, AB = p[A + 1] + Z, B = p[X + 1] + Y, BA = p[B] + Z, BB = p[B + 1] + Z;
  const G = GRAD;
  const i0 = (p[AA] & 15) * 3, i1 = (p[BA] & 15) * 3, i2 = (p[AB] & 15) * 3, i3 = (p[BB] & 15) * 3;
  const i4 = (p[AA + 1] & 15) * 3, i5 = (p[BA + 1] & 15) * 3, i6 = (p[AB + 1] & 15) * 3, i7 = (p[BB + 1] & 15) * 3;
  const x1 = x - 1, y1 = y - 1, z1 = z - 1;
  const a = G[i0] * x + G[i0 + 1] * y + G[i0 + 2] * z;
  const b = G[i1] * x1 + G[i1 + 1] * y + G[i1 + 2] * z;
  const c = G[i2] * x + G[i2 + 1] * y1 + G[i2 + 2] * z;
  const d = G[i3] * x1 + G[i3 + 1] * y1 + G[i3 + 2] * z;
  const e = G[i4] * x + G[i4 + 1] * y + G[i4 + 2] * z1;
  const f = G[i5] * x1 + G[i5 + 1] * y + G[i5 + 2] * z1;
  const g = G[i6] * x + G[i6 + 1] * y1 + G[i6 + 2] * z1;
  const h = G[i7] * x1 + G[i7 + 1] * y1 + G[i7 + 2] * z1;
  const k1 = b - a, k2 = c - a, k3 = e - a, k4 = a - b - c + d, k5 = a - c - e + g, k6 = a - b - e + f, k7 = -a + b + c - d + e - f - g + h;
  const uv = u * v, vw = v * w, wu = w * u, uvw = uv * w;
  for (let q = 0; q < 3; q++) {
    const ga = G[i0 + q], gb = G[i1 + q], gc = G[i2 + q], gd = G[i3 + q], ge = G[i4 + q], gf = G[i5 + q], gg = G[i6 + q], gh = G[i7 + q];
    out[q] = ga + u * (gb - ga) + v * (gc - ga) + w * (ge - ga) + uv * (ga - gb - gc + gd) + vw * (ga - gc - ge + gg) +
      wu * (ga - gb - ge + gf) + uvw * (-ga + gb + gc - gd + ge - gf - gg + gh);
  }
  out[0] += du * (k1 + v * k4 + w * k6 + vw * k7);
  out[1] += dv * (k2 + w * k5 + u * k4 + wu * k7);
  out[2] += dw * (k3 + u * k6 + v * k5 + uv * k7);
  return a + u * k1 + v * k2 + w * k3 + uv * k4 + vw * k5 + wu * k6 + uvw * k7;
}

/**
 * fBm of perlinGrad (gain 0.5, lacunarity 2.01, octaves offset like noise.ts fractal): returns the value and writes the
 * gradient to g[o..o+2]; t is scratch of 3.
 */
function fbmGrad(p: Uint8Array, oct: number, x: number, y: number, z: number, g: Float64Array, o: number, t: Float64Array): number {
  if (oct === 1) {
    const v = perlinGrad(p, x, y, z, t);
    g[o] = t[0]; g[o + 1] = t[1]; g[o + 2] = t[2];
    return v;
  }
  let sum = 0, amp = 1, f = 1, norm = 0, gx = 0, gy = 0, gz = 0;
  for (let i = 0; i < oct; i++) {
    sum += perlinGrad(p, x * f + i * 17.13, y * f + i * 9.71, z * f + i * 3.37, t) * amp;
    const af = amp * f;
    gx += t[0] * af; gy += t[1] * af; gz += t[2] * af;
    norm += amp; amp *= 0.5; f *= 2.01;
  }
  g[o] = gx / norm; g[o + 1] = gy / norm; g[o + 2] = gz / norm;
  return sum / norm;
}

/**
 * Noise force at (x, y, z) into out: three fBm potentials A, B, C (perms[0..2]) at (x, y, z) / size; curl = their curl
 * (divergence-free), else the three values. Scaled by amp. g is scratch of 9 (the gradients), t of 3.
 */
export function noiseForce(perms: Uint8Array[], oct: number, curl: boolean, inv: number, amp: number, x: number, y: number, z: number, out: Float64Array, g: Float64Array, t: Float64Array) {
  x *= inv; y *= inv; z *= inv;
  const a = fbmGrad(perms[0], oct, x, y, z, g, 0, t), b = fbmGrad(perms[1], oct, x, y, z, g, 3, t), c = fbmGrad(perms[2], oct, x, y, z, g, 6, t);
  if (!curl) { out[0] = a * amp; out[1] = b * amp; out[2] = c * amp; return; }
  // curl (A, B, C) = (dC/dy - dB/dz, dA/dz - dC/dx, dB/dx - dA/dy)
  out[0] = (g[7] - g[5]) * amp; out[1] = (g[2] - g[6]) * amp; out[2] = (g[3] - g[1]) * amp;
}

/**
 * The k nearest points of a KD tree (KDTree.arrays(): tree-ordered positions TP, original indices idx, split axes) within
 * sqrt(maxD2) of (x, y, z), nearest first, into outI / outD2; returns the count. Among equal distances the first point
 * found is kept; the traversal order is fixed, so the result is deterministic.
 */
export function knnInto(
  TP: Float64Array, idx: Int32Array, axis: Int8Array, x: number, y: number, z: number, k: number, maxD2: number,
  outI: Int32Array, outD2: Float64Array, stack: Int32Array, bound: Float64Array,
): number {
  const n = idx.length;
  if (n === 0 || k <= 0) return 0;
  let m = 0, sp = 0;
  stack[0] = 0; stack[1] = n; bound[0] = 0; sp = 1;
  while (sp > 0) {
    sp--;
    const lo = stack[sp * 2], hi = stack[sp * 2 + 1];
    // a range whose split plane is farther than the current k-th distance cannot hold a closer point
    if (m === k ? bound[sp] >= outD2[k - 1] : bound[sp] > maxD2) continue;
    if (lo >= hi) continue;
    const mid = (lo + hi) >> 1, ax = axis[mid];
    const dx = TP[mid * 3] - x, dy = TP[mid * 3 + 1] - y, dz = TP[mid * 3 + 2] - z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 <= maxD2 && (m < k || d2 < outD2[k - 1])) {
      let j = m < k ? m++ : k - 1;
      while (j > 0 && outD2[j - 1] > d2) { outD2[j] = outD2[j - 1]; outI[j] = outI[j - 1]; j--; }
      outD2[j] = d2; outI[j] = idx[mid];
    }
    if (hi - lo === 1) continue;
    if ((sp + 2) * 2 > stack.length || sp + 2 > bound.length) throw new Error('knnInto: traversal stack overflow');
    const diff = (ax === 0 ? x : ax === 1 ? y : z) - TP[mid * 3 + ax], far2 = diff * diff;
    // the far side first, so the near side is popped (and shrinks the k-th distance) before it
    if (diff < 0) {
      stack[sp * 2] = mid + 1; stack[sp * 2 + 1] = hi; bound[sp++] = far2;
      stack[sp * 2] = lo; stack[sp * 2 + 1] = mid; bound[sp++] = 0;
    } else {
      stack[sp * 2] = lo; stack[sp * 2 + 1] = mid; bound[sp++] = far2;
      stack[sp * 2] = mid + 1; stack[sp * 2 + 1] = hi; bound[sp++] = 0;
    }
  }
  return m;
}

/** Trilinear value of an SDF grid at (x, y, z), clamped to the grid. */
function gridValue(V: Float32Array, g: NonNullable<StepArgs['grid']>, x: number, y: number, z: number): number {
  const nx = g.nx, ny = g.ny, nz = g.nz;
  let fx = (x - g.ox) / g.voxel, fy = (y - g.oy) / g.voxel, fz = (z - g.oz) / g.voxel;
  fx = fx < 0 ? 0 : fx > nx - 1 ? nx - 1 : fx;
  fy = fy < 0 ? 0 : fy > ny - 1 ? ny - 1 : fy;
  fz = fz < 0 ? 0 : fz > nz - 1 ? nz - 1 : fz;
  const ix = Math.min(nx - 2, Math.floor(fx)), iy = Math.min(ny - 2, Math.floor(fy)), iz = Math.min(nz - 2, Math.floor(fz));
  const tx = fx - ix, ty = fy - iy, tz = fz - iz;
  const o = ix + nx * (iy + ny * iz), sy = nx, sz = nx * ny;
  const c00 = V[o] + (V[o + 1] - V[o]) * tx, c10 = V[o + sy] + (V[o + sy + 1] - V[o + sy]) * tx;
  const c01 = V[o + sz] + (V[o + sz + 1] - V[o + sz]) * tx, c11 = V[o + sz + sy] + (V[o + sz + sy + 1] - V[o + sz + sy]) * tx;
  const c0 = c00 + (c10 - c00) * ty, c1 = c01 + (c11 - c01) * ty;
  return c0 + (c1 - c0) * tz;
}

/** v clamped to [lo, hi]. */
const clampTo = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Field vector at (x, y, z) into out (zero where the field has nothing to say). */
function fieldVector(a: StepArgs, A: Record<string, any>, s: KScratch, x: number, y: number, z: number, out: Float64Array) {
  out[0] = 0; out[1] = 0; out[2] = 0;
  if (a.field === 1) {
    const maxD2 = a.fieldMaxD > 0 ? a.fieldMaxD * a.fieldMaxD : Infinity;
    const m = knnInto(A.fTP, A.fIdx, A.fAxis, x, y, z, a.fieldK, maxD2, s.ki, s.kd, s.kstack, s.kbound);
    if (!m) return;
    const FV: Float64Array = A.fV;
    if (m === 1 || s.kd[0] === 0) {
      const q = s.ki[0] * 3;
      out[0] = FV[q] * a.fieldScale; out[1] = FV[q + 1] * a.fieldScale; out[2] = FV[q + 2] * a.fieldScale;
      return;
    }
    let wx = 0, wy = 0, wz = 0, ws = 0;
    for (let j = 0; j < m; j++) {
      const w = 1 / s.kd[j], q = s.ki[j] * 3;
      wx += FV[q] * w; wy += FV[q + 1] * w; wz += FV[q + 2] * w; ws += w;
    }
    const k = a.fieldScale / ws;
    out[0] = wx * k; out[1] = wy * k; out[2] = wz * k;
  } else if (a.field === 2) {
    const h = a.hf!, fx = (x - h.ox) / h.cell, fz = (z - h.oz) / h.cell;
    if (!(fx >= 0 && fz >= 0 && fx <= h.w - 1 && fz <= h.h - 1)) return;
    const i = Math.min(h.w - 2, Math.floor(fx)), j = Math.min(h.h - 2, Math.floor(fz));
    const tx = fx - i, tz = fz - j, o = j * h.w + i;
    const GX: Float64Array = A.hGX, GZ: Float64Array = A.hGZ;
    const gx0 = GX[o] + (GX[o + 1] - GX[o]) * tx, gx1 = GX[o + h.w] + (GX[o + h.w + 1] - GX[o + h.w]) * tx;
    const gz0 = GZ[o] + (GZ[o + 1] - GZ[o]) * tx, gz1 = GZ[o + h.w] + (GZ[o + h.w + 1] - GZ[o + h.w]) * tx;
    out[0] = -(gx0 + (gx1 - gx0) * tz) * a.fieldScale;
    out[2] = -(gz0 + (gz1 - gz0) * tz) * a.fieldScale;
  } else if (a.field === 3) {
    // central differences at the closest point inside the grid (outside it the gradient at its boundary)
    const g = a.grid!, V: Float32Array = A.gV, e = g.voxel * 0.5, k = a.fieldScale / (2 * e);
    x = clampTo(x, g.ox + e, g.ox + (g.nx - 1) * g.voxel - e);
    y = clampTo(y, g.oy + e, g.oy + (g.ny - 1) * g.voxel - e);
    z = clampTo(z, g.oz + e, g.oz + (g.nz - 1) * g.voxel - e);
    out[0] = -(gridValue(V, g, x + e, y, z) - gridValue(V, g, x - e, y, z)) * k;
    out[1] = -(gridValue(V, g, x, y + e, z) - gridValue(V, g, x, y - e, z)) * k;
    out[2] = -(gridValue(V, g, x, y, z + e) - gridValue(V, g, x, y, z - e)) * k;
  }
}

/**
 * Earliest contact along the move st.p → st.p + d (fraction 0..1 of d), or -1. Writes the contact normal (facing the
 * particle) to s.n and, for a mesh contact, the plane offset (n · a point of the triangle) to s.planeD. Floor: the plane
 * y = floorY + r. Mesh: a ray along d that starts `stand` (r, or the skin for points) behind the particle, so a particle
 * resting on the surface or a hair under it still finds it; the contact is where the centre is `stand` in front of the
 * hit triangle's plane. Triangles are two-sided: the particle is on the side its centre is on, and within `stand` of the
 * plane (resting, or a hair through it at a crease) on the side of its last contact normal (s.cn), else the side it
 * comes from. A hit the particle moves away from (found behind it through the backed-up start) is not a contact.
 */
function findContact(a: StepArgs, scene: RayScene | null, s: KScratch, dx: number, dy: number, dz: number, r: number): number {
  const st = s.st, n = s.n, cn = s.cn;
  let best = 2;
  s.floorHit = false;
  if (a.floor) {
    const fy = a.floorY + r, y0 = st[1], y1 = y0 + dy;
    if (y0 < fy) { best = 0; s.floorHit = true; }
    else if (y1 < fy) { best = (y0 - fy) / (y0 - y1); s.floorHit = true; }
    if (s.floorHit) { n[0] = 0; n[1] = 1; n[2] = 0; }
  }
  if (!scene || best <= 0) return best <= 1 ? best : -1;
  const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(L > 0)) return best <= 1 ? best : -1;
  const stand = r > 0 ? r : a.skin, back = stand / L;
  const ox = st[0] - dx * back, oy = st[1] - dy * back, oz = st[2] - dz * back, tmax = 1 + 12 * back;
  const hasCn = cn[0] !== 0 || cn[1] !== 0 || cn[2] !== 0;
  const T = scene.bvh.T;
  let tmin = 0;
  for (let tries = 0; tries < 4; tries++) {
    const t = scene.nearest(ox, oy, oz, dx, dy, dz, tmax, tmin);
    if (t === Infinity) break;
    tmin = t;
    const o = scene.lastTri * 9;
    const e1x = T[o + 3] - T[o], e1y = T[o + 4] - T[o + 1], e1z = T[o + 5] - T[o + 2];
    const e2x = T[o + 6] - T[o], e2y = T[o + 7] - T[o + 1], e2z = T[o + 8] - T[o + 2];
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!(nl > 0)) continue;
    nx /= nl; ny /= nl; nz /= nl;
    const dist = (st[0] - T[o]) * nx + (st[1] - T[o + 1]) * ny + (st[2] - T[o + 2]) * nz;
    const flip = dist <= -stand || (dist < stand && (hasCn ? nx * cn[0] + ny * cn[1] + nz * cn[2] < 0 : nx * dx + ny * dy + nz * dz > 0));
    if (flip) { nx = -nx; ny = -ny; nz = -nz; }
    const dn = nx * dx + ny * dy + nz * dz;
    if (dn >= 0) continue;
    const tau = Math.max(0, t - back - stand / (L * Math.max(-dn / L, 0.1)));
    if (tau < 1 && tau < best) {
      best = tau; n[0] = nx; n[1] = ny; n[2] = nz; s.floorHit = false;
      s.planeD = nx * T[o] + ny * T[o + 1] + nz * T[o + 2];
    }
    break;
  }
  return best <= 1 ? best : -1;
}

/** Velocity response to a contact with normal s.n: slide (normal part removed) or bounce, with Coulomb friction. */
function respond(a: StepArgs, s: KScratch) {
  const st = s.st, n = s.n;
  const vn = st[3] * n[0] + st[4] * n[1] + st[5] * n[2];
  if (vn >= 0) return;
  let tx = st[3] - vn * n[0], ty = st[4] - vn * n[1], tz = st[5] - vn * n[2];
  let out = a.collide === 3 ? -vn * a.bounce : 0;
  if (out < a.restSpeed) out = 0;
  const dvn = out - vn;
  if (a.friction > 0) {
    const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
    if (tl > 0) {
      const k = Math.max(0, 1 - (a.friction * dvn) / tl);
      tx *= k; ty *= k; tz *= k;
    }
  }
  st[3] = tx + out * n[0]; st[4] = ty + out * n[1]; st[5] = tz + out * n[2];
}

/**
 * Integrate particles [start, end) through steps [s0, s1). Arrays: P, V, CN (last contact normals) and TR (trail
 * rings) are written; dead (results: 1 = removed by a collision); b, u, kd, rad (read; rad absent = point particles);
 * shared: the collision BVH (T, nodes, child, order, triPt) and the field (fTP, fIdx, fAxis, fV | hGX, hGZ | gV).
 * Returns the contacts resolved.
 */
export function particlesRange(a: StepArgs, A: Record<string, any>, start: number, end: number, ctx: KernelContext): number {
  const P: Float64Array = A.P, V: Float64Array = A.V, TR: Float64Array | undefined = A.TR, dead: Uint8Array = A.dead;
  const CN: Float64Array = A.CN;
  const B: Int32Array = A.b, U: Float64Array = A.u, KD: Int32Array = A.kd, R: Float64Array | undefined = A.rad;
  const needScene = (a.mesh && a.collide > 0) || a.attractMode === 2;
  const scene = needScene ? ctx.memo('particles-scene:' + ctx.sharedKey, () => RayScene.fromArrays(A as any)) : null;
  const meshScene = a.mesh && a.collide > 0 ? scene : null;
  const collide = a.collide > 0 && (a.floor || !!meshScene);
  const oct = Math.max(1, Math.min(8, Math.round(a.octaves)));
  const perms = a.noise ? ctx.memo('particles-perm:' + a.seed, () => [perlinPerm(a.seed), perlinPerm(a.seed + 1), perlinPerm(a.seed + 2)]) : null;
  const ng = new Float64Array(9), nt = new Float64Array(3);
  const inv = 1 / (a.noiseSize > 0 ? a.noiseSize : 1);
  const s: KScratch = {
    st: new Float64Array(6), n: new Float64Array(3), f: new Float64Array(3), cs: closestScratch(),
    ki: new Int32Array(Math.max(1, a.fieldK)), kd: new Float64Array(Math.max(1, a.fieldK)),
    kstack: new Int32Array(512), kbound: new Float64Array(256), floorHit: false, planeD: 0, cn: new Float64Array(3),
  };
  const st = s.st, f = s.f;
  const dt = a.dt, s0 = a.s0, s1 = a.s1, T = a.trail;
  const gx = a.gravity[0], gy = a.gravity[1], gz = a.gravity[2];
  const wx = a.wind[0], wy = a.wind[1], wz = a.wind[2];
  const dragFull = a.drag > 0 ? Math.exp(-a.drag * dt) : 1;
  const ax0 = a.attractPoint[0], ay0 = a.attractPoint[1], az0 = a.attractPoint[2];
  let contacts = 0;
  for (let i = start; i < end; i++) {
    const b = B[i], u = U[i];
    const kFrom = b > s0 ? b : s0, kTo = KD[i] + 1 < s1 ? KD[i] + 1 : s1;
    if (kFrom >= kTo) continue;
    const r = R ? R[i] : 0;
    st[0] = P[i * 3]; st[1] = P[i * 3 + 1]; st[2] = P[i * 3 + 2];
    st[3] = V[i * 3]; st[4] = V[i * 3 + 1]; st[5] = V[i * 3 + 2];
    const cn = s.cn;
    cn[0] = CN[i * 3]; cn[1] = CN[i * 3 + 1]; cn[2] = CN[i * 3 + 2];
    for (let k = kFrom; k < kTo; k++) {
      const h = k === b ? (1 - u) * dt : dt;
      // forces
      let fx = gx, fy = gy, fz = gz, airx = wx, airy = wy, airz = wz;
      if (perms) {
        noiseForce(perms, oct, a.curl, inv, a.noise, st[0], st[1], st[2], f, ng, nt);
        fx += f[0]; fy += f[1]; fz += f[2];
      }
      if (a.field) {
        fieldVector(a, A, s, st[0], st[1], st[2], f);
        if (a.fieldAir) { airx += f[0]; airy += f[1]; airz += f[2]; } else { fx += f[0]; fy += f[1]; fz += f[2]; }
      }
      if (a.attractMode === 1) {
        fx += (ax0 - st[0]) * a.attract; fy += (ay0 - st[1]) * a.attract; fz += (az0 - st[2]) * a.attract;
      } else if (a.attractMode === 2 && scene && scene.bvh.closestInto(st[0], st[1], st[2], Infinity, s.cs) >= 0) {
        fx += (s.cs.x - st[0]) * a.attract; fy += (s.cs.y - st[1]) * a.attract; fz += (s.cs.z - st[2]) * a.attract;
      }
      // velocity: forces, then exact exponential drag toward the air velocity
      st[3] += fx * h; st[4] += fy * h; st[5] += fz * h;
      if (a.drag > 0) {
        const e = h === dt ? dragFull : Math.exp(-a.drag * h);
        st[3] = airx + (st[3] - airx) * e; st[4] = airy + (st[4] - airy) * e; st[5] = airz + (st[5] - airz) * e;
      }
      // move, resolving contacts
      if (!collide) {
        st[0] += st[3] * h; st[1] += st[4] * h; st[2] += st[5] * h;
      } else {
        let rem = 1, died = false, touched = false;
        for (let c = 0; c < MAX_CONTACTS && rem > 0; c++) {
          const dx = st[3] * h * rem, dy = st[4] * h * rem, dz = st[5] * h * rem;
          const tau = findContact(a, meshScene, s, dx, dy, dz, r);
          if (tau < 0) { st[0] += dx; st[1] += dy; st[2] += dz; rem = 0; break; }
          contacts++;
          st[0] += dx * tau; st[1] += dy * tau; st[2] += dz * tau;
          if (s.floorHit) { if (st[1] < a.floorY + r) st[1] = a.floorY + r; }
          else {
            // keep the centre `stand` in front of the contacted plane
            const stand = r > 0 ? r : a.skin, n = s.n, dist = st[0] * n[0] + st[1] * n[1] + st[2] * n[2] - s.planeD;
            if (dist < stand) { const k = stand - dist; st[0] += n[0] * k; st[1] += n[1] * k; st[2] += n[2] * k; }
          }
          if (a.collide === 1) { died = true; break; }
          respond(a, s);
          touched = true;
          cn[0] = s.n[0]; cn[1] = s.n[1]; cn[2] = s.n[2];
          rem *= 1 - tau;
        }
        // spheres: the centre ray keeps the centre off the planes it moves toward; push it out of any other surface
        // closer than the radius (the far flank of a valley, an edge passing by)
        if (!died && r > 0 && meshScene)
          for (let pass = 0; pass < 2; pass++) {
            if (meshScene.bvh.closestInto(st[0], st[1], st[2], r, s.cs) < 0) break;
            const d = Math.sqrt(s.cs.d2);
            if (!(d < r)) break;
            const n = s.n;
            if (d > 1e-12) { n[0] = (st[0] - s.cs.x) / d; n[1] = (st[1] - s.cs.y) / d; n[2] = (st[2] - s.cs.z) / d; }
            else if (cn[0] !== 0 || cn[1] !== 0 || cn[2] !== 0) { n[0] = cn[0]; n[1] = cn[1]; n[2] = cn[2]; }
            else break;
            contacts++;
            if (a.collide === 1) { died = true; break; }
            st[0] = s.cs.x + n[0] * r; st[1] = s.cs.y + n[1] * r; st[2] = s.cs.z + n[2] * r;
            respond(a, s);
            touched = true;
            cn[0] = n[0]; cn[1] = n[1]; cn[2] = n[2];
          }
        if (died) { dead[i] = 1; break; }
        if (!touched) { cn[0] = 0; cn[1] = 0; cn[2] = 0; }
      }
      if (T > 0) {
        const o = (i * T + ((k - b + 1) % T)) * 3;
        TR![o] = st[0]; TR![o + 1] = st[1]; TR![o + 2] = st[2];
      }
    }
    P[i * 3] = st[0]; P[i * 3 + 1] = st[1]; P[i * 3 + 2] = st[2];
    V[i * 3] = st[3]; V[i * 3 + 1] = st[4]; V[i * 3 + 2] = st[5];
    CN[i * 3] = cn[0]; CN[i * 3 + 1] = cn[1]; CN[i * 3 + 2] = cn[2];
  }
  return contacts;
}

// ---------------------------------------------------------------- inputs: emitter, collider, field

export interface EmitterData {
  geo: Geometry;
  count: number;
  P: Float64Array;
  /** emission direction per point (unit; null = +Y) */
  N: Float64Array | null;
  /** initial velocity per point (null = none) */
  V: Float64Array | null;
  /** pscale per point (null = the node's pscale) */
  pscale: Float64Array | null;
  /** random key per point: its id attribute, else its number */
  key: ArrayLike<number> | null;
}

export interface ColliderData {
  scene: RayScene | null;
  /** stand-off distance for point particles */
  skin: number;
}

export interface FieldData {
  type: FieldType;
  args: Partial<StepArgs>;
  shared: Record<string, Float64Array | Float32Array | Int32Array | Int8Array>;
}

/** The field of input 2 for the kernel: its first heightfield / SDF volume, else its points' v. */
export function fieldFrom(
  g: Geometry, opts: { sdfResolution: number; heightfields: Heightfield[] },
): FieldData {
  const hf = opts.heightfields[0];
  if (hf && hf.layers.has('height')) {
    const w = hf.width, hh = hf.height, H = hf.read('height');
    const GX = new Float64Array(w * hh), GZ = new Float64Array(w * hh);
    for (let j = 0; j < hh; j++)
      for (let i = 0; i < w; i++) {
        const [dx, dz] = hf.gradient(i, j, H);
        GX[j * w + i] = dx; GZ[j * w + i] = dz;
      }
    return { type: 2, args: { hf: { w, h: hh, cell: hf.cellSize, ox: hf.origin[0], oz: hf.origin[1] } }, shared: { hGX: GX, hGZ: GZ } };
  }
  const vol = g.volumes.find((v) => v.kind === 'sdf' || v.kind === 'grid');
  if (vol && (vol.kind === 'sdf' || vol.kind === 'grid')) {
    // sample the distance on a regular grid over the volume's bounds (padded by a quarter), so workers can read it
    const bmin = vol.bounds.min, bmax = vol.bounds.max;
    const ext = [bmax[0] - bmin[0], bmax[1] - bmin[1], bmax[2] - bmin[2]];
    const size = Math.max(ext[0], ext[1], ext[2], 1e-6);
    const res = Math.max(4, Math.min(256, Math.round(opts.sdfResolution)));
    const voxel = (size * 1.5) / res;
    const nx = Math.max(2, Math.ceil((ext[0] * 1.5) / voxel) + 1), ny = Math.max(2, Math.ceil((ext[1] * 1.5) / voxel) + 1), nz = Math.max(2, Math.ceil((ext[2] * 1.5) / voxel) + 1);
    const ox = (bmin[0] + bmax[0]) / 2 - ((nx - 1) * voxel) / 2, oy = (bmin[1] + bmax[1]) / 2 - ((ny - 1) * voxel) / 2, oz = (bmin[2] + bmax[2]) / 2 - ((nz - 1) * voxel) / 2;
    const GV = new Float32Array(nx * ny * nz);
    const cap = Math.sqrt(((nx - 1) * voxel) ** 2 + ((ny - 1) * voxel) ** 2 + ((nz - 1) * voxel) ** 2) + voxel;
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const d = vol.sample(ox + i * voxel, oy + j * voxel, oz + k * voxel);
          GV[i + nx * (j + ny * k)] = Number.isFinite(d) ? d : d < 0 ? -cap : cap;
        }
    return { type: 3, args: { grid: { nx, ny, nz, ox, oy, oz, voxel } }, shared: { gV: GV } };
  }
  const v = g.points.get('v');
  if (g.numPoints && v && v.type === 'float' && v.size === 3) return { type: 1, args: {}, shared: { fV: v.data as Float64Array } };
  return { type: 0, args: {}, shared: {} };
}

// ---------------------------------------------------------------- emission

export interface EmitParams {
  dt: number;
  seed: number;
  rate: number;
  emitAll: boolean;
  life: number;
  lifeVar: number;
  speed: number;
  velocityVar: number;
  pscale: number;
  maxParticles: number;
  trail: number;
}

/** Per-emitter phase of the rate emission, in [0, 1). */
function phaseOf(ep: EmitParams, key: number): number {
  return randN(ep.seed, key, -1, 7);
}

/**
 * Emit the births of steps [s0, s1) after `state` (null = the start of the simulation: the emit_all births come first)
 * and return a new state with them appended; never the input state itself, so the caller may write into its arrays.
 * `max_particles` counts every particle from its birth through its death step, including the ones a collision removed
 * (listed in __pholders).
 */
export function emitSteps(state: Geometry | null, em: EmitterData, s0: number, s1: number, ep: EmitParams): Geometry {
  const n0 = state ? state.numPoints : 0;
  // particles holding a slot at s0, and when they release it (death step kd: counted through step kd)
  const span = Math.max(0, s1 - s0);
  const release = new Int32Array(span + 1);
  let live = 0;
  const hold = (kd: number) => { live++; if (kd < s1) release[kd - s0]++; };
  if (state) {
    const kd = state.points.get('__pkd')!.data as Int32Array;
    for (let i = 0; i < n0; i++) if (kd[i] >= s0) hold(kd[i]);
    const holders = state.detail.get('__pholders');
    if (holders) for (const kd of holders.getArray(0) as number[]) if (kd >= s0) hold(kd);
  }
  let skipped = state ? Number(state.detail.get('__pskipped')?.get(0) ?? 0) : 0;
  let nextId = state ? Number(state.detail.get('__pnextid')?.get(0) ?? 0) : 0;
  const src: number[] = [], bs: number[] = [], us: number[] = [], lifes: number[] = [], kds: number[] = [], vel: number[] = [];
  const cnt = em.count, max = ep.maxParticles, dt = ep.dt;
  const keyOf = (e: number) => (em.key ? em.key[e] : e);
  const birth = (e: number, step: number, u: number, k: number) => {
    const key = keyOf(e);
    const life = ep.life > 0 ? Math.max(0, ep.life + (randN(ep.seed, key, k, 2) * 2 - 1) * ep.lifeVar) : 0;
    const kd = life > 0 ? deathStep(step, u, life, dt) : NEVER;
    // initial velocity: emitter v + speed along N + a uniform sample of the velocity_var ball
    let vx = em.V ? em.V[e * 3] : 0, vy = em.V ? em.V[e * 3 + 1] : 0, vz = em.V ? em.V[e * 3 + 2] : 0;
    if (ep.speed) {
      const nx = em.N ? em.N[e * 3] : 0, ny = em.N ? em.N[e * 3 + 1] : 1, nz = em.N ? em.N[e * 3 + 2] : 0;
      vx += nx * ep.speed; vy += ny * ep.speed; vz += nz * ep.speed;
    }
    if (ep.velocityVar > 0) {
      const z = randN(ep.seed, key, k, 3) * 2 - 1, phi = randN(ep.seed, key, k, 4) * 2 * Math.PI;
      const rr = Math.cbrt(randN(ep.seed, key, k, 5)) * ep.velocityVar, sxy = Math.sqrt(Math.max(0, 1 - z * z)) * rr;
      vx += sxy * Math.cos(phi); vy += z * rr; vz += sxy * Math.sin(phi);
    }
    src.push(e); bs.push(step); us.push(u); lifes.push(life); kds.push(kd); vel.push(vx, vy, vz);
    hold(kd);
  };
  if (!state && ep.emitAll)
    for (let e = 0; e < cnt; e++) {
      if (live >= max) { skipped++; continue; }
      birth(e, 0, 0, 0);
    }
  if (ep.rate > 0 && cnt > 0) {
    const phase = new Float64Array(cnt);
    for (let e = 0; e < cnt; e++) phase[e] = phaseOf(ep, keyOf(e));
    const k0 = ep.emitAll ? 1 : 0;
    for (let s = s0; s < s1; s++) {
      if (s > s0) live -= release[s - 1 - s0];
      for (let e = 0; e < cnt; e++) {
        const before = Math.floor(s * ep.rate + phase[e]), c = Math.floor((s + 1) * ep.rate + phase[e]) - before;
        for (let j = 0; j < c; j++) {
          if (live >= max) { skipped++; continue; }
          const k = k0 + before + j;
          // birth offset within the step in (0, 1]: 0 is reserved for particles that exist at time 0 (emit_all)
          birth(e, s, 1 - randN(ep.seed, keyOf(e), k, 1), k);
        }
      }
    }
  }
  const nb = src.length;
  if (!nb) {
    const out = state ? state.clone() : emptyState(s0, ep.trail);
    setDetailInt(out, '__pnextid', nextId);
    setDetailInt(out, '__pskipped', skipped);
    return out;
  }
  // the births: the emitter points' attributes and groups, then the simulation attributes
  const g = new Geometry();
  const srcIdx = Int32Array.from(src);
  g.points = em.geo.points.gather(srcIdx);
  for (const k of ['age', ...INTERNAL]) g.points.delete(k);
  g.pointGroups = new Map([...em.geo.pointGroups].map(([k, m]) => [k, Uint8Array.from(srcIdx, (i) => m[i])]));
  const P = g.P;
  (g.points.add('v', 'float', 3).data as Float64Array).set(vel);
  const id = g.points.add('id', 'int', 1).data as Int32Array;
  for (let i = 0; i < nb; i++) id[i] = nextId++;
  (g.points.add('life', 'float', 1).data as Float64Array).set(lifes);
  const ps = g.points.add('pscale', 'float', 1).data as Float64Array;
  for (let i = 0; i < nb; i++) ps[i] = em.pscale ? em.pscale[src[i]] : ep.pscale;
  (g.points.add('__pb', 'int', 1).data as Int32Array).set(bs);
  (g.points.add('__pu', 'float', 1).data as Float64Array).set(us);
  (g.points.add('__pkd', 'int', 1).data as Int32Array).set(kds);
  g.points.add('__pcn', 'float', 3);
  if (ep.trail > 0) {
    // the ring starts with the birth position (sample 0)
    const T = ep.trail, TR = g.points.add('__ptrail', 'float', T * 3).data as Float64Array;
    for (let i = 0; i < nb; i++) { TR[i * T * 3] = P[i * 3]; TR[i * T * 3 + 1] = P[i * 3 + 1]; TR[i * T * 3 + 2] = P[i * 3 + 2]; }
  }
  const out = state ? Geometry.merge([state, g]) : g;
  setDetailInt(out, '__pnextid', nextId);
  setDetailInt(out, '__pskipped', skipped);
  return out;
}

function setDetailInt(g: Geometry, name: string, v: number) {
  g.detail.add(name, 'int', 1).set(0, v);
}

/** Steps simulated by a state. */
export function stateStep(g: Geometry | null): number {
  return g ? Number(g.detail.get('__pstep')?.get(0) ?? 0) : 0;
}

/** Births refused by max_particles so far. */
export function stateSkipped(g: Geometry | null): number {
  return g ? Number(g.detail.get('__pskipped')?.get(0) ?? 0) : 0;
}

/**
 * After a run of steps up to s1: drop the particles a collision removed (they keep their slot in __pholders until their
 * death step) and the ones whose life ended, and stamp the step. `dead` = 1 per particle removed by a collision.
 */
export function compactState(g: Geometry, dead: Uint8Array | null, s1: number): Geometry {
  const n = g.numPoints, kd = g.points.get('__pkd')!.data as Int32Array;
  const keep = new Uint8Array(n);
  const prev = g.detail.get('__pholders');
  const holders: number[] = [];
  if (prev) for (const k of prev.getArray(0) as number[]) if (k >= s1) holders.push(k);
  let kept = 0;
  for (let i = 0; i < n; i++) {
    if (kd[i] < s1) continue;
    if (dead && dead[i]) { holders.push(kd[i]); continue; }
    keep[i] = 1; kept++;
  }
  const out = kept === n ? g : g.subsetPoints(keep);
  out.detail.set('__pholders', Attribute.fromArrays('int[]', [holders]));
  setDetailInt(out, '__pstep', s1);
  return out;
}

/** A state at step s without particles (the output attributes exist, so an empty result has the usual schema). */
export function emptyState(s: number, trail: number): Geometry {
  const g = new Geometry();
  g.points.add('v', 'float', 3);
  g.points.add('id', 'int', 1);
  g.points.add('life', 'float', 1);
  g.points.add('pscale', 'float', 1);
  for (const [k, t] of [['__pb', 'int'], ['__pu', 'float'], ['__pkd', 'int']] as const) g.points.add(k, t, 1);
  g.points.add('__pcn', 'float', 3);
  if (trail > 0) g.points.add('__ptrail', 'float', trail * 3);
  setDetailInt(g, '__pstep', s);
  return g;
}

// ---------------------------------------------------------------- output

/** The state's point table without the internal attributes (the attributes themselves are shared, not copied). */
function publicPoints(t: AttribTable): AttribTable {
  const out = new AttribTable(t.count);
  for (const [k, a] of t.map) if (!INTERNAL.includes(k)) out.map.set(k, a);
  return out;
}

/** The particles after S steps: P, v, age, life, id, pscale and the carried attributes; no prims. */
export function particlePoints(state: Geometry, S: number, dt: number): Geometry {
  const n = state.numPoints;
  const g = new Geometry();
  g.points = publicPoints(state.points).clone();
  g.pointGroups = new Map([...state.pointGroups].map(([k, m]) => [k, m.slice()]));
  const b = state.points.get('__pb')!.data as Int32Array, u = state.points.get('__pu')!.data as Float64Array;
  const age = g.points.add('age', 'float', 1).data as Float64Array;
  for (let i = 0; i < n; i++) age[i] = ageAt(S, b[i], u[i], dt);
  return g;
}

/**
 * One polyline per particle through its last `T` positions (oldest first, so the last point is the particle), for
 * particles with at least two: points carry the particle's attributes, `age` = the particle's age at that position and
 * `curveu` (0..1 by arc length); prims carry `id`.
 */
export function particleTrails(state: Geometry, S: number, dt: number, T: number): Geometry {
  const n = state.numPoints;
  const b = state.points.get('__pb')!.data as Int32Array, u = state.points.get('__pu')!.data as Float64Array;
  const TR = state.points.get('__ptrail')?.data as Float64Array | undefined;
  const m = new Int32Array(n);
  let total = 0, prims = 0;
  if (TR && T > 0)
    for (let i = 0; i < n; i++) {
      const c = Math.min(T, S - b[i] + 1);
      if (c >= 2) { m[i] = c; total += c; prims++; }
    }
  const src = new Int32Array(total), sample = new Int32Array(total);
  const primStart = new Int32Array(prims + 1), primId = new Int32Array(prims);
  const ids = state.points.get('id')?.data as Int32Array | Float64Array | undefined;
  let o = 0, pr = 0;
  for (let i = 0; i < n; i++) {
    if (!m[i]) continue;
    const last = S - b[i];
    primStart[pr] = o;
    primId[pr++] = ids ? ids[i] : i;
    for (let j = last - m[i] + 1; j <= last; j++) { src[o] = i; sample[o++] = j; }
  }
  primStart[prims] = total;
  const g = new Geometry();
  g.points = publicPoints(state.points).gather(src);
  g.pointGroups = new Map([...state.pointGroups].map(([k, mk]) => [k, Uint8Array.from(src, (i) => mk[i])]));
  const P = g.P, age = g.points.add('age', 'float', 1).data as Float64Array, cu = g.points.add('curveu', 'float', 1).data as Float64Array;
  for (let q = 0; q < total; q++) {
    const i = src[q], j = sample[q], slot = (i * T + (j % T)) * 3;
    P[q * 3] = TR![slot]; P[q * 3 + 1] = TR![slot + 1]; P[q * 3 + 2] = TR![slot + 2];
    age[q] = j === 0 ? 0 : ageAt(j, 0, u[i], dt);
  }
  for (let p = 0; p < prims; p++) {
    const s = primStart[p], e = primStart[p + 1];
    let len = 0;
    for (let q = s + 1; q < e; q++) len += Math.hypot(P[q * 3] - P[q * 3 - 3], P[q * 3 + 1] - P[q * 3 - 2], P[q * 3 + 2] - P[q * 3 - 1]);
    let acc = 0;
    cu[s] = 0;
    for (let q = s + 1; q < e; q++) {
      acc += Math.hypot(P[q * 3] - P[q * 3 - 3], P[q * 3 + 1] - P[q * 3 - 2], P[q * 3 + 2] - P[q * 3 - 1]);
      cu[q] = len > 0 ? acc / len : (q - s) / (e - s - 1);
    }
    cu[e - 1] = 1;
  }
  g.primStart = primStart;
  g.vertexPoint = Int32Array.from({ length: total }, (_, k) => k);
  g.primClosed = new Uint8Array(prims);
  g.vertices = new AttribTable(total);
  g.prims = new AttribTable(prims);
  (g.prims.add('id', 'int', 1).data as Int32Array).set(primId);
  return g;
}
