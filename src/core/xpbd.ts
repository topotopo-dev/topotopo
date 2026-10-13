// XPBD cloth (Vellum-lite): extended position-based dynamics over typed arrays, pure TypeScript, deterministic.
//
// Model (buildCloth): one particle per point; the polygons are triangulated (topology.triangulate) for the constraints
// only. Constraints, all in compliance form (alpha = 1 / stiffness, alpha~ = alpha / h², Macklin et al. 2016), so a
// stiffness means the same thing at any step size:
//  - stretch: a distance constraint per polygon side and polyline segment, k = stretch_stiffness (N/m: on a regular
//    quad grid this is the sheet's 2D Young's modulus, independent of the resolution). The stretch edges are grouped
//    into straight chains (stretchChains: the rows and columns of a quad grid, greedy straightest paths on any mesh) and
//    every chain is solved as one block, exactly (solveChains: its linearised constraints are tridiagonal, Thomas
//    algorithm). Point-wise Gauss-Seidel moves a correction one edge per sweep, so a cloth hanging N edges deep keeps a
//    stretch that grows like N²·g·h²; a chain solve carries it along the whole row or column at once. Points resting on
//    a contact plane get the mobility w·(I - ν νᵀ) in that solve, so it slides them along the surface instead of pushing
//    them into it (where the contact would undo the correction: a cloth over an edge would stay stretched at the edge);
//  - shear: both diagonals of every quad, the inner triangulation edges of larger polygons, k = shear_stiffness;
//  - bend: across every edge shared by two triangles (not the diagonal inside a quad, which the crossed shear diagonals
//    keep flat), k = bend_stiffness · 3|e|² / (A1 + A2) per hinge (discrete shells; bend_stiffness is a bending rigidity
//    in N·m, resolution independent). Hinges flat at rest use the isometric bending of Bergou et al. 2006 (a linear
//    vector constraint over a cotangent stencil, no trigonometry, ~4× cheaper; compliance matched to ½ k θ²), falling
//    back to the dihedral constraint once folded past 90°, where the quadratic energy loses its pull; hinges curved at
//    rest use the dihedral angle towards the input's rest angle (Bridson et al. 2003 gradients, well defined at the flat
//    state; a polynomial atan2, fastAtan2, so the angle has the same bits everywhere);
//  - tethers (long-range attachments, Kim et al. 2012): each point reachable from a pin may not get farther from its
//    nearest pin than along the cloth at rest, which stops pinned cloth from stretching under its weight or the wind;
//  - volume (inflate): C = V - pressure · V0 over the closed triangulation, compliance V0² / (k · area);
//  - contacts: per point, a half-space (collider contact plane, the floor) and point-point self collision.
// Masses come from the triangle areas (density, kg/m²) or a `mass` attribute; pinned points have inverse mass 0.
//
// Time stepping (XpbdCloth.step): `substeps` substeps per step of 1/fps s, `iterations` sweeps per substep ("small
// steps", Macklin et al. 2019). A sweep runs shear, bend, tethers, volume and self collision point by point, then the
// stretch chains, then the contacts, so the stiffest constraints have the last word before the contacts. External forces
// (gravity, quadratic air drag on the triangles against the wind) are integrated explicitly once per step, velocities
// come from the positions, then friction and exponential damping. With one sweep per substep the Lagrange multipliers
// are always 0 when read, so that path skips them (same bits).
//
// Determinism: the point-wise constraint arrays are sorted by a greedy graph colouring (no two constraints of one colour
// share a point), so a sweep is Gauss-Seidel across colours and Jacobi within one (the order inside a colour does not
// matter, which a parallel solve would need); chains run in their build order. Sweeps within a substep alternate
// direction (forward first: alternating across substeps with one sweep each pumped a period-2 mode). The
// solve itself runs on one thread in that fixed order; only the collision queries (collideRange, the kernel
// "cloth_collide") may run in chunks, and they are pure per point, so results are the same bits with or without a pool.
//
// Collisions are speculative contact planes found once per step (collideRange): each point within its query radius
// (thickness + a multiple of how far it can move in the step) of a collider triangle gets the plane through the closest
// point, normal towards the point's side; the substeps keep the point `thickness` in front of it. A point keeps its plane
// while it moves less than thickness/4, skips the query while its last distance minus its travel exceeds the radius, and
// starts the BVH search from its last triangle. Sharp convex collider corners also get corner-triangle contacts
// (findCornerContacts), so a box corner cannot poke between cloth points. On closed, consistently
// wound pieces the side is decided by angle-weighted pseudo-normals (Bærentzen & Aanæs 2005), so points that end up inside
// are pushed out; on open pieces a point keeps the side it started the step on (two-sided sheets). The floor is the plane
// y = floor_height. Coulomb friction removes tangential motion up to friction × the normal correction (Macklin et al. 2014).
import type { Geometry } from './geometry.ts';
import { triangulate } from './topology.ts';
import { TriBVH, closestOnTri, closestScratch } from './spatial.ts';
import type { ClosestScratch } from './spatial.ts';

// ---------------------------------------------------------------- model

export interface ClothBuildOptions {
  /** surface density in kg/m² (masses = density × a third of the adjacent triangle areas) */
  density: number;
  /** stretch stiffness in N/m (0 = no stretch constraints) */
  stretch: number;
  /** shear stiffness in N/m (0 = none) */
  shear: number;
  /** bending rigidity in N·m (0 = no bend constraints) */
  bend: number;
  /** multiplies the rest lengths of stretch and shear constraints (< 1 tightens) */
  restScale: number;
  /** optional per-point masses (kg) overriding the density */
  mass?: Float64Array | null;
  /** solve the stretch edges as straight chains, each exactly (default true, see stretchChains) */
  chains?: boolean;
}

export interface ClothModel {
  n: number;
  /** rest positions (3n) */
  X: Float64Array;
  mass: Float64Array;
  /** triangles of the closed polygons as point indices (3 per triangle), winding of the polygons */
  tris: Int32Array;
  /** distance constraints: points, rest length, compliance (1/k), kind (0 stretch, 1 shear), colour-sorted */
  dA: Int32Array; dB: Int32Array; dRest: Float64Array; dAlpha: Float64Array; dKind: Uint8Array;
  /** colour ranges of the distance constraints: colour c is [dColours[c], dColours[c + 1]) */
  dColours: Int32Array;
  /** the stretch constraints are [0, nStretch), the shear constraints follow */
  nStretch: number;
  /**
   * stretch chains (empty = the stretch edges are solved one by one): chain k runs through the points
   * cPts[cStart[k] .. cStart[k + 1]), its links are the stretch constraints cCons[cStart[k] - k ..] in order
   */
  cPts: Int32Array; cStart: Int32Array; cCons: Int32Array;
  /** bend constraints, Bridson order per constraint: wing 1, wing 2, edge start, edge end (4 ints), colour-sorted */
  bP: Int32Array; bRest: Float64Array; bAlpha: Float64Array;
  bColours: Int32Array;
  /** isometric bends of the hinges flat at rest: edge start, edge end, wing 1, wing 2 (4 ints), stencil (4), compliance */
  iP: Int32Array; iK: Float64Array; iAlpha: Float64Array;
  /** (K₃·h)² per isometric bend: |q|² of a fold θ is iC·2(1 - cos θ) */
  iC: Float64Array;
  /** mean stretch edge length (0 when there are none) */
  meanEdge: number;
  /** rest length multiplier (rest_scale) */
  restScale: number;
  /** total triangle area */
  area: number;
}

/** Points i < j as one Map key (n ≤ 2^26 keeps it exact). */
const pairKey = (a: number, b: number, n: number) => (a < b ? a * n + b : b * n + a);

/** Twice the area of triangle (a, b, c) of P, and its unnormalised normal into out. */
function triCross(P: ArrayLike<number>, a: number, b: number, c: number, out: Float64Array): number {
  const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
  const ux = P[b * 3] - ax, uy = P[b * 3 + 1] - ay, uz = P[b * 3 + 2] - az;
  const vx = P[c * 3] - ax, vy = P[c * 3 + 1] - ay, vz = P[c * 3 + 2] - az;
  out[0] = uy * vz - uz * vy; out[1] = uz * vx - ux * vz; out[2] = ux * vy - uy * vx;
  return Math.sqrt(out[0] * out[0] + out[1] * out[1] + out[2] * out[2]);
}

/**
 * atan2 by a minimax polynomial (Abramowitz & Stegun 4.4.49, |error| < 1e-5 rad): a few multiplies instead of
 * Math.atan2 in the bend loop, and the same bits on every platform. Rest and current angles both use it.
 */
export function fastAtan2(y: number, x: number): number {
  const ax = x < 0 ? -x : x, ay = y < 0 ? -y : y;
  const mx = ax > ay ? ax : ay;
  if (mx === 0) return 0;
  const a = (ax > ay ? ay : ax) / mx, s = a * a;
  let r = a * (0.999866 + s * (-0.3302995 + s * (0.180141 + s * (-0.085133 + s * 0.0208351))));
  if (ay > ax) r = 1.5707963267948966 - r;
  if (x < 0) r = 3.141592653589793 - r;
  return y < 0 ? -r : r;
}

/**
 * Signed dihedral angle of the bend stencil (x1, x2 wings; x3 → x4 the shared edge) in (-π, π]: 0 when flat, positive
 * when the wings fold towards N1 = (x1 - x3) × (x1 - x4). NaN for a degenerate stencil.
 */
export function dihedralAngle(P: ArrayLike<number>, i1: number, i2: number, i3: number, i4: number): number {
  const x3 = i3 * 3, x4 = i4 * 3, x1 = i1 * 3, x2 = i2 * 3;
  const ex = P[x4] - P[x3], ey = P[x4 + 1] - P[x3 + 1], ez = P[x4 + 2] - P[x3 + 2];
  const a1x = P[x1] - P[x3], a1y = P[x1 + 1] - P[x3 + 1], a1z = P[x1 + 2] - P[x3 + 2];
  const b1x = P[x1] - P[x4], b1y = P[x1 + 1] - P[x4 + 1], b1z = P[x1 + 2] - P[x4 + 2];
  const a2x = P[x2] - P[x4], a2y = P[x2 + 1] - P[x4 + 1], a2z = P[x2 + 2] - P[x4 + 2];
  const b2x = P[x2] - P[x3], b2y = P[x2 + 1] - P[x3 + 1], b2z = P[x2 + 2] - P[x3 + 2];
  const n1x = a1y * b1z - a1z * b1y, n1y = a1z * b1x - a1x * b1z, n1z = a1x * b1y - a1y * b1x;
  const n2x = a2y * b2z - a2z * b2y, n2y = a2z * b2x - a2x * b2z, n2z = a2x * b2y - a2y * b2x;
  const el = Math.sqrt(ex * ex + ey * ey + ez * ez);
  const l1 = n1x * n1x + n1y * n1y + n1z * n1z, l2 = n2x * n2x + n2y * n2y + n2z * n2z;
  if (!(el > 1e-300 && l1 > 1e-300 && l2 > 1e-300)) return NaN;
  const cx = n1y * n2z - n1z * n2y, cy = n1z * n2x - n1x * n2z, cz = n1x * n2y - n1y * n2x;
  return fastAtan2((cx * ex + cy * ey + cz * ez) * (1 / el), n1x * n2x + n1y * n2y + n1z * n2z);
}

/**
 * Isometric bending stencil of the hinge (x0, x1) with wings x2, x3 (Bergou et al. 2006): K = (c03 + c04, c01 + c02,
 * -c01 - c03, -c02 - c04) from the cotangents of the angles at the hinge ends (e0 = x1 - x0, e1 = x2 - x0, e2 = x3 - x0,
 * e3 = x2 - x1, e4 = x3 - x1). Σ Kᵢ xᵢ vanishes for any flat placement and is unchanged by rigid motions of a flat
 * hinge. null for a degenerate hinge.
 */
export function isoStencil(P: ArrayLike<number>, i0: number, i1: number, i2: number, i3: number): [number, number, number, number] | null {
  const v = (a: number, b: number) => [P[b * 3] - P[a * 3], P[b * 3 + 1] - P[a * 3 + 1], P[b * 3 + 2] - P[a * 3 + 2]];
  const cot = (a: number[], b: number[]) => {
    const cx = a[1] * b[2] - a[2] * b[1], cy = a[2] * b[0] - a[0] * b[2], cz = a[0] * b[1] - a[1] * b[0];
    const s = Math.sqrt(cx * cx + cy * cy + cz * cz);
    return s > 1e-300 ? (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / s : NaN;
  };
  const e0 = v(i0, i1), e1 = v(i0, i2), e2 = v(i0, i3), e3 = v(i1, i2), e4 = v(i1, i3), ne0 = [-e0[0], -e0[1], -e0[2]];
  const c01 = cot(e0, e1), c02 = cot(e0, e2), c03 = cot(ne0, e3), c04 = cot(ne0, e4);
  const K: [number, number, number, number] = [c03 + c04, c01 + c02, -c01 - c03, -c02 - c04];
  return K.every(Number.isFinite) ? K : null;
}

/**
 * Greedy colouring of constraints with `k` points each (idx[c·k + j]): constraint c gets the smallest colour none of
 * its points has yet (64 colours; the rest share one last colour, still solved in a fixed order). Returns the
 * constraint order sorted by colour (stable) and the colour ranges.
 */
export function colourConstraints(k: number, idx: Int32Array, count: number, n: number): { order: Int32Array; starts: Int32Array } {
  const lo = new Uint32Array(n), hi = new Uint32Array(n), col = new Uint8Array(count);
  const tally = new Int32Array(66);
  for (let c = 0; c < count; c++) {
    let m0 = 0, m1 = 0;
    for (let j = 0; j < k; j++) { const p = idx[c * k + j]; m0 |= lo[p]; m1 |= hi[p]; }
    let cc = 64;
    if (m0 !== -1 && (m0 >>> 0) !== 0xffffffff) cc = 31 - Math.clz32(~m0 & (m0 + 1));
    else if ((m1 >>> 0) !== 0xffffffff) cc = 32 + 31 - Math.clz32(~m1 & (m1 + 1));
    col[c] = cc;
    tally[cc + 1]++;
    if (cc < 32) { const bit = 1 << cc; for (let j = 0; j < k; j++) lo[idx[c * k + j]] |= bit; }
    else if (cc < 64) { const bit = 1 << (cc - 32); for (let j = 0; j < k; j++) hi[idx[c * k + j]] |= bit; }
  }
  for (let c = 0; c < 65; c++) tally[c + 1] += tally[c];
  const starts = Int32Array.from(tally.subarray(0, 66));
  const fill = tally.slice(0, 65), order = new Int32Array(count);
  for (let c = 0; c < count; c++) order[fill[col[c]]++] = c;
  // drop empty trailing colours
  let last = 65;
  while (last > 0 && starts[last] === starts[last - 1]) last--;
  return { order, starts: starts.slice(0, last + 1) };
}

/**
 * Decompose the stretch edges [0, count) into straight chains: starting from each unused edge (in order), extend
 * both ends through the unused edge that continues most straight at rest (within 45°; never closing a loop). On a
 * quad grid these are its rows and columns; on any mesh every edge ends up in exactly one chain (possibly alone).
 * A chain is then solved as one block (XpbdCloth.solveChains): its linearised constraints form a tridiagonal system,
 * so a correction travels the whole chain in one solve instead of one edge per Gauss-Seidel sweep.
 */
export function stretchChains(X: Float64Array, A: Int32Array, B: Int32Array, count: number, n: number): { cPts: Int32Array; cStart: Int32Array; cCons: Int32Array } {
  const deg = new Int32Array(n + 1);
  for (let c = 0; c < count; c++) { deg[A[c] + 1]++; deg[B[c] + 1]++; }
  for (let i = 0; i < n; i++) deg[i + 1] += deg[i];
  const inc = new Int32Array(count * 2), fill = deg.slice(0, n);
  for (let c = 0; c < count; c++) { inc[fill[A[c]]++] = c; inc[fill[B[c]]++] = c; }
  const used = new Uint8Array(count), stamp = new Int32Array(n).fill(-1);
  const pts: number[] = [], cons: number[] = [], start: number[] = [0];
  const front: number[] = [], frontC: number[] = [], back: number[] = [], backC: number[] = [];
  let chain = 0;
  // the next edge after the step prev → p: the unused one at p that continues most straight (cos > 0.7) to a point
  // not yet on this chain
  const next = (prev: number, p: number): number => {
    let dx = X[p * 3] - X[prev * 3], dy = X[p * 3 + 1] - X[prev * 3 + 1], dz = X[p * 3 + 2] - X[prev * 3 + 2];
    const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    dx /= l; dy /= l; dz /= l;
    let best = -1, bestCos = 0.7;
    for (let e = deg[p]; e < deg[p + 1]; e++) {
      const c = inc[e];
      if (used[c]) continue;
      const q = A[c] === p ? B[c] : A[c];
      if (stamp[q] === chain) continue;
      let ex = X[q * 3] - X[p * 3], ey = X[q * 3 + 1] - X[p * 3 + 1], ez = X[q * 3 + 2] - X[p * 3 + 2];
      const el = Math.sqrt(ex * ex + ey * ey + ez * ez) || 1;
      ex /= el; ey /= el; ez /= el;
      const cs = dx * ex + dy * ey + dz * ez;
      if (cs > bestCos) { bestCos = cs; best = c; }
    }
    return best;
  };
  for (let c0 = 0; c0 < count; c0++) {
    if (used[c0]) continue;
    used[c0] = 1;
    chain = c0;
    stamp[A[c0]] = stamp[B[c0]] = chain;
    front.length = frontC.length = back.length = backC.length = 0;
    // forward from B, backward from A
    let prev = A[c0], p = B[c0];
    back.push(p);
    for (;;) {
      const c = next(prev, p);
      if (c < 0) break;
      used[c] = 1;
      const q = A[c] === p ? B[c] : A[c];
      stamp[q] = chain;
      back.push(q); backC.push(c);
      prev = p; p = q;
    }
    prev = B[c0]; p = A[c0];
    for (;;) {
      const c = next(prev, p);
      if (c < 0) break;
      used[c] = 1;
      const q = A[c] === p ? B[c] : A[c];
      stamp[q] = chain;
      front.push(q); frontC.push(c);
      prev = p; p = q;
    }
    for (let k = front.length - 1; k >= 0; k--) pts.push(front[k]);
    pts.push(A[c0]);
    for (const q of back) pts.push(q);
    for (let k = frontC.length - 1; k >= 0; k--) cons.push(frontC[k]);
    cons.push(c0);
    for (const c of backC) cons.push(c);
    start.push(pts.length);
  }
  return { cPts: Int32Array.from(pts), cStart: Int32Array.from(start), cCons: Int32Array.from(cons) };
}

/** Build the particles and constraints of a cloth from a polygon mesh (any polygons, polylines, loose points). */
export function buildCloth(g: Geometry, o: ClothBuildOptions): ClothModel {
  const n = g.numPoints, P = g.P, vp = g.vertexPoint, ps = g.primStart, closed = g.primClosed;
  const X = Float64Array.from(P);
  const { tris: tv, triPrim } = triangulate(g);
  const nt0 = tv.length / 3;
  const tl: number[] = [], tprim: number[] = [];
  for (let t = 0; t < nt0; t++) {
    const a = vp[tv[t * 3]], b = vp[tv[t * 3 + 1]], c = vp[tv[t * 3 + 2]];
    if (a === b || b === c || a === c) continue;
    tl.push(a, b, c);
    tprim.push(triPrim[t]);
  }
  const tris = Int32Array.from(tl), nt = tris.length / 3;
  const cr = new Float64Array(3);

  // masses
  const mass = new Float64Array(n);
  let area = 0;
  for (let t = 0; t < nt; t++) {
    const a2 = triCross(X, tris[t * 3], tris[t * 3 + 1], tris[t * 3 + 2], cr);
    area += a2 / 2;
    const m = (o.density * a2) / 6;
    mass[tris[t * 3]] += m; mass[tris[t * 3 + 1]] += m; mass[tris[t * 3 + 2]] += m;
  }

  // stretch: polygon sides and polyline segments (each undirected pair once)
  const edgeIdx = new Map<number, number>();
  const dA: number[] = [], dB: number[] = [], dRest: number[] = [], dK: number[] = [];
  const addDist = (a: number, b: number, kind: number) => {
    if (a === b) return;
    const key = pairKey(a, b, n);
    if (edgeIdx.has(key)) return;
    edgeIdx.set(key, dA.length);
    const dx = X[a * 3] - X[b * 3], dy = X[a * 3 + 1] - X[b * 3 + 1], dz = X[a * 3 + 2] - X[b * 3 + 2];
    dA.push(a); dB.push(b); dRest.push(Math.sqrt(dx * dx + dy * dy + dz * dz) * o.restScale); dK.push(kind);
  };
  const segLen: number[] = [];
  for (let p = 0; p < g.numPrims; p++) {
    const s = ps[p], e = ps[p + 1], m = e - s;
    if (m < 2 || g.isPacked(p)) continue;
    const cl = closed[p] && m >= 3;
    for (let v = s; v < (cl ? e : e - 1); v++) {
      const a = vp[v], b = vp[v + 1 < e ? v + 1 : s];
      addDist(a, b, 0);
      if (!cl) segLen.push(a, b);
    }
  }
  const nStretch = dA.length;
  let meanEdge = 0;
  for (let c = 0; c < nStretch; c++) meanEdge += dRest[c];
  meanEdge = nStretch ? meanEdge / nStretch / (o.restScale || 1) : 0;
  // polyline points and loose points get a mass from their segments (a strip as wide as the segment), else a token one
  for (let k = 0; k < segLen.length; k += 2) {
    const a = segLen[k], b = segLen[k + 1];
    const l = Math.hypot(X[a * 3] - X[b * 3], X[a * 3 + 1] - X[b * 3 + 1], X[a * 3 + 2] - X[b * 3 + 2]);
    if (mass[a] === 0 || mass[b] === 0) { mass[a] += (o.density * l * l) / 2; mass[b] += (o.density * l * l) / 2; }
  }
  const token = o.density * Math.max(meanEdge, 0.01) ** 2;
  for (let i = 0; i < n; i++) if (!(mass[i] > 0)) mass[i] = token > 0 ? token : 1e-6;
  if (o.mass) for (let i = 0; i < n; i++) if (o.mass[i] > 0) mass[i] = o.mass[i];

  // shear: both diagonals of quads, inner triangulation edges of larger polygons
  if (o.shear > 0) {
    for (let p = 0; p < g.numPrims; p++) {
      if (!closed[p] || g.isPacked(p)) continue;
      const s = ps[p], m = ps[p + 1] - s;
      if (m === 4) { addDist(vp[s], vp[s + 2], 1); addDist(vp[s + 1], vp[s + 3], 1); }
    }
    for (let t = 0; t < nt; t++) {
      const pr = tprim[t];
      if (ps[pr + 1] - ps[pr] <= 4) continue;
      for (let k = 0; k < 3; k++) addDist(tris[t * 3 + k], tris[t * 3 + ((k + 1) % 3)], 1);
    }
  }
  const nd = dA.length;
  const alphaS = o.stretch > 0 ? 1 / o.stretch : Infinity, alphaH = o.shear > 0 ? 1 / o.shear : Infinity;

  // bends: triangle pairs across an edge, except the diagonal inside a quad
  const bl: number[] = [], bRest: number[] = [], bAlpha: number[] = [];
  const il: number[] = [], iK: number[] = [], iAlpha: number[] = [], iC: number[] = [];
  if (o.bend > 0 && nt > 1) {
    const first = new Map<number, number>(); // edge key → tri * 3 + k of the first triangle, -1 = more than two
    const second = new Map<number, number>();
    for (let t = 0; t < nt; t++)
      for (let k = 0; k < 3; k++) {
        const key = pairKey(tris[t * 3 + k], tris[t * 3 + ((k + 1) % 3)], n);
        const f = first.get(key);
        if (f === undefined) first.set(key, t * 3 + k);
        else if (second.has(key)) second.set(key, -1);
        else second.set(key, t * 3 + k);
      }
    for (const [key, s2] of second) {
      if (s2 < 0) continue; // non-manifold
      const s1 = first.get(key)!;
      const t1 = (s1 / 3) | 0, k1 = s1 % 3, t2 = (s2 / 3) | 0, k2 = s2 % 3;
      const pr1 = tprim[t1], pr2 = tprim[t2];
      // the diagonal inside a quad: the crossed shear diagonals keep the quad flat (without shear it bends like any edge)
      const side = edgeIdx.get(key);
      if (o.shear > 0 && pr1 === pr2 && ps[pr1 + 1] - ps[pr1] === 4 && !(side !== undefined && side < nStretch)) continue;
      const e0 = tris[t1 * 3 + k1], e1 = tris[t1 * 3 + ((k1 + 1) % 3)];
      const w1 = tris[t1 * 3 + ((k1 + 2) % 3)], w2 = tris[t2 * 3 + ((k2 + 2) % 3)];
      if (w1 === w2 || w1 === e0 || w1 === e1 || w2 === e0 || w2 === e1) continue;
      const th = dihedralAngle(X, w1, w2, e0, e1);
      if (!Number.isFinite(th)) continue;
      const A1 = triCross(X, w1, e0, e1, cr) / 2, A2 = triCross(X, w2, e0, e1, cr) / 2;
      const el2 = (X[e0 * 3] - X[e1 * 3]) ** 2 + (X[e0 * 3 + 1] - X[e1 * 3 + 1]) ** 2 + (X[e0 * 3 + 2] - X[e1 * 3 + 2]) ** 2;
      const k = (o.bend * 3 * el2) / (A1 + A2);
      if (!(k > 0) || !Number.isFinite(k)) continue;
      if (Math.abs(th) < 1e-6) {
        // flat at rest: the isometric (quadratic) bending of Bergou et al. 2006, q = Σ Kᵢ xᵢ over (e0, e1, w1, w2) with
        // cotangent weights, q = 0 when flat; |q| ≈ |K₃|·h·θ for a fold θ (h = the wing's distance from the hinge),
        // so the compliance (K₃ h)² / k gives the same energy ½ k θ² as the dihedral constraint
        const iso = isoStencil(X, e0, e1, w1, w2);
        if (!iso) continue;
        const h = (2 * A2) / Math.sqrt(el2);
        const c2 = (iso[3] * h) ** 2;
        il.push(e0, e1, w1, w2); iK.push(iso[0], iso[1], iso[2], iso[3]); iAlpha.push(c2 / k); iC.push(c2);
        continue;
      }
      bl.push(w1, w2, e0, e1); bRest.push(th); bAlpha.push(1 / k);
    }
  }
  // colour and sort: stretch constraints [0, nStretch), then shear
  const m: ClothModel = {
    n, X, mass, tris,
    dA: new Int32Array(nd), dB: new Int32Array(nd), dRest: new Float64Array(nd), dAlpha: new Float64Array(nd), dKind: new Uint8Array(nd),
    dColours: new Int32Array(1), nStretch,
    bP: new Int32Array(bl.length), bRest: new Float64Array(bRest.length), bAlpha: new Float64Array(bAlpha.length), bColours: new Int32Array(1),
    cPts: new Int32Array(0), cStart: Int32Array.of(0), cCons: new Int32Array(0),
    iP: new Int32Array(0), iK: new Float64Array(0), iAlpha: new Float64Array(0), iC: new Float64Array(0),
    meanEdge, area, restScale: o.restScale,
  };
  const colours: number[] = [0];
  for (const [lo, hi] of [[0, nStretch], [nStretch, nd]]) {
    const cnt = hi - lo, dIdx = new Int32Array(cnt * 2);
    for (let c = 0; c < cnt; c++) { dIdx[c * 2] = dA[lo + c]; dIdx[c * 2 + 1] = dB[lo + c]; }
    const dc = colourConstraints(2, dIdx, cnt, n);
    for (let j = 0; j < cnt; j++) {
      const c = lo + dc.order[j];
      m.dA[lo + j] = dA[c]; m.dB[lo + j] = dB[c]; m.dRest[lo + j] = dRest[c]; m.dKind[lo + j] = dK[c];
      m.dAlpha[lo + j] = dK[c] === 0 ? alphaS : alphaH;
    }
    for (let k = 1; k < dc.starts.length; k++) colours.push(lo + dc.starts[k]);
  }
  m.dColours = Int32Array.from(colours);
  if (o.chains !== false && nStretch) Object.assign(m, stretchChains(X, m.dA, m.dB, nStretch, n));
  const nb = bRest.length;
  const bc = colourConstraints(4, Int32Array.from(bl), nb, n);
  for (let j = 0; j < nb; j++) {
    const c = bc.order[j];
    for (let q = 0; q < 4; q++) m.bP[j * 4 + q] = bl[c * 4 + q];
    m.bRest[j] = bRest[c]; m.bAlpha[j] = bAlpha[c];
  }
  m.bColours = bc.starts;
  const ni = iAlpha.length, ic = colourConstraints(4, Int32Array.from(il), ni, n);
  m.iP = new Int32Array(ni * 4); m.iK = new Float64Array(ni * 4); m.iAlpha = new Float64Array(ni); m.iC = new Float64Array(ni);
  for (let j = 0; j < ni; j++) {
    const c = ic.order[j];
    for (let q = 0; q < 4; q++) { m.iP[j * 4 + q] = il[c * 4 + q]; m.iK[j * 4 + q] = iK[c * 4 + q]; }
    m.iAlpha[j] = iAlpha[c]; m.iC[j] = iC[c];
  }
  return m;
}

/** Signed volume of the closed triangulation of P (positive when the polygons wind outwards). */
export function meshVolume(P: ArrayLike<number>, tris: Int32Array): number {
  let v = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t] * 3, b = tris[t + 1] * 3, c = tris[t + 2] * 3;
    v += P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) + P[a + 1] * (P[b + 2] * P[c] - P[b] * P[c + 2]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]);
  }
  return v / 6;
}

// ---------------------------------------------------------------- tethers (long-range attachments)

/**
 * Nearest anchors along the cloth: a multi-source Dijkstra over the stretch/shear edges (rest lengths) from every
 * anchor point, with reusable typed buffers. The edge graph and the heap are built once per model.
 */
export class AnchorSearch {
  n: number;
  private start: Int32Array;
  private adj: Int32Array;
  private len: Float64Array;
  private hd: Float64Array;
  private hp: Int32Array;
  private ha: Int32Array;
  private done: Uint8Array;
  /** nearest anchor per point (-1 = none reachable) and the path length to it */
  anchor: Int32Array;
  dist: Float64Array;

  constructor(m: ClothModel) {
    const n = (this.n = m.n), nd = m.dA.length;
    const deg = new Int32Array(n + 1);
    for (let c = 0; c < nd; c++) { deg[m.dA[c] + 1]++; deg[m.dB[c] + 1]++; }
    for (let i = 0; i < n; i++) deg[i + 1] += deg[i];
    const adj = new Int32Array(nd * 2), len = new Float64Array(nd * 2), fill = deg.slice(0, n);
    // edges in ascending constraint order per point (deterministic)
    for (let c = 0; c < nd; c++) {
      const a = m.dA[c], b = m.dB[c];
      adj[fill[a]] = b; len[fill[a]++] = m.dRest[c];
      adj[fill[b]] = a; len[fill[b]++] = m.dRest[c];
    }
    this.start = deg; this.adj = adj; this.len = len;
    const cap = nd * 2 + n + 1;
    this.hd = new Float64Array(cap); this.hp = new Int32Array(cap); this.ha = new Int32Array(cap);
    this.done = new Uint8Array(n);
    this.anchor = new Int32Array(n);
    this.dist = new Float64Array(n);
  }

  /** Fill anchor/dist from the anchor mask. Ties go to whichever path the (deterministic) heap settles first. */
  run(anchors: Uint8Array) {
    const n = this.n, hd = this.hd, hp = this.hp, ha = this.ha, done = this.done, start = this.start, adj = this.adj, len = this.len;
    const anchor = this.anchor, dist = this.dist;
    done.fill(0); anchor.fill(-1); dist.fill(Infinity);
    let size = 0;
    const push = (d: number, p: number, a: number) => {
      let k = size++;
      while (k > 0) {
        const q = (k - 1) >> 1;
        if (hd[q] < d || (hd[q] === d && hp[q] <= p)) break;
        hd[k] = hd[q]; hp[k] = hp[q]; ha[k] = ha[q]; k = q;
      }
      hd[k] = d; hp[k] = p; ha[k] = a;
    };
    for (let i = 0; i < n; i++) if (anchors[i]) push(0, i, i);
    while (size > 0) {
      const d = hd[0], p = hp[0], a = ha[0];
      // pop: move the last entry down from the root
      size--;
      if (size > 0) {
        const ld = hd[size], lp = hp[size], la = ha[size];
        let k = 0;
        for (;;) {
          const l = k * 2 + 1;
          if (l >= size) break;
          let s = l;
          const r = l + 1;
          if (r < size && (hd[r] < hd[l] || (hd[r] === hd[l] && hp[r] < hp[l]))) s = r;
          if (ld < hd[s] || (ld === hd[s] && lp <= hp[s])) break;
          hd[k] = hd[s]; hp[k] = hp[s]; ha[k] = ha[s]; k = s;
        }
        hd[k] = ld; hp[k] = lp; ha[k] = la;
      }
      if (done[p]) continue;
      done[p] = 1; dist[p] = d; anchor[p] = a;
      for (let e = start[p]; e < start[p + 1]; e++) {
        const q = adj[e];
        if (!done[q]) push(d + len[e], q, a);
      }
    }
  }
}

/** True when every rest position lies on one plane (to 1e-9 of the size): tethers can then use straight distances. */
export function restIsPlanar(X: Float64Array, tris: Int32Array): boolean {
  const n = X.length / 3;
  if (n < 4) return true;
  let size = 0;
  for (let i = 3; i < X.length; i++) size = Math.max(size, Math.abs(X[i] - X[i % 3]));
  const cr = new Float64Array(3);
  for (let t = 0; t < tris.length; t += 3) {
    const l = triCross(X, tris[t], tris[t + 1], tris[t + 2], cr);
    if (!(l > 1e-12 * size * size)) continue;
    const nx = cr[0] / l, ny = cr[1] / l, nz = cr[2] / l, o = tris[t] * 3;
    for (let i = 0; i < n; i++) {
      const d = (X[i * 3] - X[o]) * nx + (X[i * 3 + 1] - X[o + 1]) * ny + (X[i * 3 + 2] - X[o + 2]) * nz;
      if (Math.abs(d) > 1e-9 * size) return false;
    }
    return true;
  }
  return true;
}

// ---------------------------------------------------------------- colliders

/**
 * A static collider: the triangle BVH plus outward pseudo-normals (per triangle FN, per triangle edge EN, per point
 * VN) and a per-triangle flag TC for triangles on closed, consistently wound pieces (inside/outside is defined there).
 */
export interface Collider {
  bvh: TriBVH;
  FN: Float64Array;
  EN: Float64Array;
  VN: Float64Array;
  TC: Uint8Array;
  numTris: number;
  /** sharp convex corners of closed pieces: point ids, positions and outward pseudo-normals (3 per corner) */
  SV: Int32Array;
  SP: Float64Array;
  SN: Float64Array;
}

/** Collider data of a mesh (its polygons), or null when it has none. */
export function buildCollider(g: Geometry): Collider | null {
  const bvh = new TriBVH(g);
  const nt = bvh.numTris;
  if (!nt) return null;
  const T = bvh.T, tp = bvh.triPt, np = g.numPoints;
  const FN = new Float64Array(nt * 3);
  for (let t = 0; t < nt; t++) {
    const o = t * 9;
    const ux = T[o + 3] - T[o], uy = T[o + 4] - T[o + 1], uz = T[o + 5] - T[o + 2];
    const vx = T[o + 6] - T[o], vy = T[o + 7] - T[o + 1], vz = T[o + 8] - T[o + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (l > 0) { FN[t * 3] = nx / l; FN[t * 3 + 1] = ny / l; FN[t * 3 + 2] = nz / l; }
  }
  // edge twins: an edge is good when exactly two triangles use it in opposite directions
  const firstUse = new Map<number, number>(), twin = new Int32Array(nt * 3).fill(-1), bad = new Uint8Array(nt);
  const count = new Map<number, number>();
  for (let t = 0; t < nt; t++)
    for (let k = 0; k < 3; k++) {
      const a = tp[t * 3 + k], b = tp[t * 3 + ((k + 1) % 3)];
      const key = pairKey(a, b, np);
      count.set(key, (count.get(key) ?? 0) + 1);
      const f = firstUse.get(key);
      if (f === undefined) firstUse.set(key, t * 3 + k);
      else {
        const ft = (f / 3) | 0, fk = f % 3;
        const fa = tp[ft * 3 + fk];
        if (fa === b) { twin[t * 3 + k] = f; twin[f] = t * 3 + k; }
      }
    }
  for (let t = 0; t < nt; t++)
    for (let k = 0; k < 3; k++) {
      const key = pairKey(tp[t * 3 + k], tp[t * 3 + ((k + 1) % 3)], np);
      if (count.get(key) !== 2 || twin[t * 3 + k] < 0) bad[t] = 1;
    }
  // pieces over good edges (union-find), closed when no triangle has a bad edge
  const parent = new Int32Array(nt);
  for (let t = 0; t < nt; t++) parent[t] = t;
  const find = (x: number) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let s = 0; s < nt * 3; s++) {
    const o = twin[s];
    if (o < 0) continue;
    const a = find((s / 3) | 0), b = find((o / 3) | 0);
    if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
  }
  const openPiece = new Uint8Array(nt), vol = new Float64Array(nt);
  for (let t = 0; t < nt; t++) {
    const r = find(t);
    if (bad[t]) openPiece[r] = 1;
    const o = t * 9;
    vol[r] += T[o] * (T[o + 4] * T[o + 8] - T[o + 5] * T[o + 7]) + T[o + 1] * (T[o + 5] * T[o + 6] - T[o + 3] * T[o + 8]) + T[o + 2] * (T[o + 3] * T[o + 7] - T[o + 4] * T[o + 6]);
  }
  const TC = new Uint8Array(nt);
  for (let t = 0; t < nt; t++) {
    const r = find(t);
    if (openPiece[r]) continue;
    TC[t] = 1;
    if (vol[r] < 0) { FN[t * 3] = -FN[t * 3]; FN[t * 3 + 1] = -FN[t * 3 + 1]; FN[t * 3 + 2] = -FN[t * 3 + 2]; }
  }
  // edge pseudo-normals (sum of the two face normals), vertex pseudo-normals (angle-weighted)
  const EN = new Float64Array(nt * 9), VN = new Float64Array(np * 3);
  for (let t = 0; t < nt; t++)
    for (let k = 0; k < 3; k++) {
      const s = t * 3 + k, o = twin[s];
      let x = FN[t * 3], y = FN[t * 3 + 1], z = FN[t * 3 + 2];
      if (o >= 0) { const u = ((o / 3) | 0) * 3; x += FN[u]; y += FN[u + 1]; z += FN[u + 2]; }
      const l = Math.sqrt(x * x + y * y + z * z);
      if (l > 1e-12) { EN[s * 3] = x / l; EN[s * 3 + 1] = y / l; EN[s * 3 + 2] = z / l; }
      else { EN[s * 3] = FN[t * 3]; EN[s * 3 + 1] = FN[t * 3 + 1]; EN[s * 3 + 2] = FN[t * 3 + 2]; }
      // corner k angle
      const o9 = t * 9, c0 = k * 3, c1 = ((k + 1) % 3) * 3, c2 = ((k + 2) % 3) * 3;
      const ax = T[o9 + c1] - T[o9 + c0], ay = T[o9 + c1 + 1] - T[o9 + c0 + 1], az = T[o9 + c1 + 2] - T[o9 + c0 + 2];
      const bx = T[o9 + c2] - T[o9 + c0], by = T[o9 + c2 + 1] - T[o9 + c0 + 1], bz = T[o9 + c2 + 2] - T[o9 + c0 + 2];
      const la = Math.sqrt(ax * ax + ay * ay + az * az), lb = Math.sqrt(bx * bx + by * by + bz * bz);
      if (la > 0 && lb > 0) {
        const ang = Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by + az * bz) / (la * lb))));
        const p = tp[t * 3 + k] * 3;
        VN[p] += ang * FN[t * 3]; VN[p + 1] += ang * FN[t * 3 + 1]; VN[p + 2] += ang * FN[t * 3 + 2];
      }
    }
  for (let i = 0; i < np * 3; i += 3) {
    const l = Math.sqrt(VN[i] * VN[i] + VN[i + 1] * VN[i + 1] + VN[i + 2] * VN[i + 2]);
    if (l > 1e-12) { VN[i] /= l; VN[i + 1] /= l; VN[i + 2] /= l; }
  }
  // sharp convex corners of closed pieces (a face normal more than 25° off the pseudo-normal, every neighbour below the
  // tangent plane): the vertices that can poke between cloth points (XpbdCloth.findCornerContacts)
  const minDot = new Float64Array(np).fill(2), ok = new Uint8Array(np).fill(1), seen = new Uint8Array(np), pos = new Float64Array(np * 3);
  for (let t = 0; t < nt; t++)
    for (let k = 0; k < 3; k++) {
      const p = tp[t * 3 + k], o = t * 9 + k * 3;
      seen[p] = 1;
      pos[p * 3] = T[o]; pos[p * 3 + 1] = T[o + 1]; pos[p * 3 + 2] = T[o + 2];
      const vx = VN[p * 3], vy = VN[p * 3 + 1], vz = VN[p * 3 + 2];
      minDot[p] = Math.min(minDot[p], FN[t * 3] * vx + FN[t * 3 + 1] * vy + FN[t * 3 + 2] * vz);
      if (!TC[t]) ok[p] = 0;
      for (const j of [(k + 1) % 3, (k + 2) % 3]) {
        const q = t * 9 + j * 3;
        if ((T[q] - T[o]) * vx + (T[q + 1] - T[o + 1]) * vy + (T[q + 2] - T[o + 2]) * vz > 1e-9) ok[p] = 0;
      }
    }
  const sv: number[] = [];
  for (let p = 0; p < np; p++) if (seen[p] && ok[p] && minDot[p] < 0.906) sv.push(p);
  const SV = Int32Array.from(sv), SP = new Float64Array(sv.length * 3), SN = new Float64Array(sv.length * 3);
  for (let i = 0; i < sv.length; i++)
    for (let c = 0; c < 3; c++) { SP[i * 3 + c] = pos[sv[i] * 3 + c]; SN[i * 3 + c] = VN[sv[i] * 3 + c]; }
  return { bvh, FN, EN, VN, TC, numTris: nt, SV, SP, SN };
}

/** The arrays of a collider the "cloth_collide" kernel reads (shared with worker threads). */
export function colliderArrays(c: Collider): Record<string, Float64Array | Int32Array | Uint8Array | Uint32Array> {
  const b = c.bvh.arrays();
  return { T: b.T, nodes: b.nodes, child: b.child, order: b.order, triPt: b.triPt, FN: c.FN, EN: c.EN, VN: c.VN, TC: c.TC };
}

/** A collider over arrays from colliderArrays (in a worker thread): no BVH build. */
export function colliderFromArrays(A: Record<string, any>): Collider {
  const bvh = TriBVH.fromArrays({ T: A.T, nodes: A.nodes, child: A.child, order: A.order, triPt: A.triPt });
  return { bvh, FN: A.FN, EN: A.EN, VN: A.VN, TC: A.TC, numTris: A.order.length, SV: new Int32Array(0), SP: new Float64Array(0), SN: new Float64Array(0) };
}

/**
 * Contact planes for points [start, end) with R[i] > 0 (points with R[i] <= 0 are left untouched): the closest collider
 * point within 2·R[i]; when it is within R[i] the point gets the contact plane through it (CP, normal CN, unit, towards
 * the side the point belongs on) and CF[i] = 1, else CF[i] = 0. QD[i] is the distance found (2·R[i] when nothing is
 * that close), a lower bound the caller uses to skip later queries. CT[i] is the triangle of the previous query (-1 =
 * none) and is updated: its distance bounds the BVH search (warm start). Pure per point, so any chunking gives the same
 * bits.
 */
export function collideRange(c: Collider, X: Float64Array, R: Float64Array, CP: Float64Array, CN: Float64Array, CF: Uint8Array, CT: Int32Array, QD: Float64Array, start: number, end: number, scratch: ClosestScratch = closestScratch()) {
  const FN = c.FN, EN = c.EN, VN = c.VN, TC = c.TC, tp = c.bvh.triPt, bvh = c.bvh, T = bvh.T, nt = c.numTris;
  const wp = [0, 0, 0], wb = [0, 0, 0];
  for (let i = start; i < end; i++) {
    const r = R[i];
    if (!(r > 0)) continue;
    CF[i] = 0;
    const x = X[i * 3], y = X[i * 3 + 1], z = X[i * 3 + 2], reach = 2 * r;
    // warm start: the previous triangle's distance (when within reach) bounds the search
    const prev = CT[i];
    let bound = reach, warm = -1;
    if (prev >= 0 && prev < nt) {
      const d2 = closestOnTri(T, prev * 9, x, y, z, wp, wb);
      if (d2 <= reach * reach) { warm = prev; bound = Math.sqrt(d2) * (1 + 1e-9) + 1e-12; }
    }
    let t = bvh.closestInto(x, y, z, bound, scratch);
    const s = scratch;
    if (t < 0 && warm >= 0) {
      // nothing nearer than the previous triangle: it is the closest
      t = warm;
      s.x = wp[0]; s.y = wp[1]; s.z = wp[2]; s.b0 = wb[0]; s.b1 = wb[1]; s.b2 = wb[2];
    }
    CT[i] = t;
    if (t < 0) { QD[i] = reach; continue; }
    const qd = Math.sqrt((x - s.x) ** 2 + (y - s.y) ** 2 + (z - s.z) ** 2);
    QD[i] = qd;
    if (qd > r) continue;
    // pseudo-normal of the feature the closest point lies on (exact zeros mark edges and corners)
    let px: number, py: number, pz: number;
    const b0 = s.b0, b1 = s.b1, b2 = s.b2;
    let q = -1, e = -1;
    if (b0 === 0 && b1 === 0) q = tp[t * 3 + 2];
    else if (b1 === 0 && b2 === 0) q = tp[t * 3];
    else if (b0 === 0 && b2 === 0) q = tp[t * 3 + 1];
    else if (b0 === 0) e = t * 3 + 1;
    else if (b1 === 0) e = t * 3 + 2;
    else if (b2 === 0) e = t * 3;
    if (q >= 0) { px = VN[q * 3]; py = VN[q * 3 + 1]; pz = VN[q * 3 + 2]; }
    else if (e >= 0) { px = EN[e * 3]; py = EN[e * 3 + 1]; pz = EN[e * 3 + 2]; }
    else { px = FN[t * 3]; py = FN[t * 3 + 1]; pz = FN[t * 3 + 2]; }
    const dx = x - s.x, dy = y - s.y, dz = z - s.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    let nx: number, ny: number, nz: number;
    if (d > 1e-12) {
      nx = dx / d; ny = dy / d; nz = dz / d;
      if (TC[t] && nx * px + ny * py + nz * pz < 0) { nx = -nx; ny = -ny; nz = -nz; }
    } else if (TC[t]) { nx = px; ny = py; nz = pz; }
    else { nx = FN[t * 3]; ny = FN[t * 3 + 1]; nz = FN[t * 3 + 2]; }
    CP[i * 3] = s.x; CP[i * 3 + 1] = s.y; CP[i * 3 + 2] = s.z;
    CN[i * 3] = nx; CN[i * 3 + 1] = ny; CN[i * 3 + 2] = nz;
    CF[i] = 1;
  }
}

// ---------------------------------------------------------------- simulation

export interface SimOptions {
  /** step length in seconds */
  dt: number;
  substeps: number;
  iterations: number;
  gravity: [number, number, number];
  /** exponential velocity damping rate (1/s) */
  damping: number;
  /** quadratic air drag ½·ρ·Cd (kg/m³) of the triangles against the wind (0 = no air) */
  drag: number;
  /** wind velocity (m/s) */
  wind: [number, number, number];
  /** collision offset (m) */
  thickness: number;
  friction: number;
  floor: boolean;
  floorHeight: number;
  selfCollision: boolean;
  /** long-range attachments to the pins (pinTethers) */
  tethers: boolean;
  /** volume constraint (inflate): target / rest volume, and its stiffness in N/m (0 = no volume constraint) */
  pressure?: number;
  pressureStiffness?: number;
  /** steps over which the pressure rises from 1 to its value (0 = at once); an instant jump would throw the cloth outwards */
  pressureRamp?: number;
}

/** Simulation state of a cloth model. Positions start at `x0`; pinned points never move. */
export class XpbdCloth {
  m: ClothModel;
  o: SimOptions;
  n: number;
  x: Float64Array;
  xp: Float64Array;
  v: Float64Array;
  w: Float64Array;
  h: number;
  /** per-step collider contacts (written by the caller, e.g. through collideRange): plane point, normal, flag */
  cp: Float64Array;
  cn: Float64Array;
  cf: Uint8Array;
  /** collider triangle of each point's last contact (-1 = none): the warm start of the next query */
  ct: Int32Array;
  /** distance to the collider at each point's last query (a lower bound later; collideRange writes it) */
  qd: Float64Array;
  /** tether anchor (-1 = none) and maximum distance per point */
  tA: Int32Array | null = null;
  tD: Float64Array | null = null;
  /** self-collision pairs of the current step: i, j and the minimum distance */
  sI = new Int32Array(0);
  sJ = new Int32Array(0);
  sD = new Float64Array(0);
  sCount = 0;
  /** collider-corner contacts of the current step: cloth triangle, barycentrics, corner position and outward normal */
  kT = new Int32Array(0);
  kB = new Float64Array(0);
  kC = new Float64Array(0);
  kN = new Float64Array(0);
  kCount = 0;
  private kStamp = 0;
  /** collider query lower bounds (queryRadius / afterQuery): position at the last query and the distance then */
  private qX: Float64Array | null = null;
  /** corner search data (findCornerContacts): point → triangles, triangle stamps, hashed corners, per-corner scratch */
  private corners: {
    col: Collider; start: Int32Array; tri: Int32Array; stamp: Int32Array; cst: Int32Array; cent: Int32Array; mask: number; inv: number;
    best: Float64Array; finder: Int32Array;
  } | null = null;
  /** volume constraint */
  vRest = 0;
  vSign = 1;
  vAlpha = 0;
  /** current target volume ratio (ramps to o.pressure) and the number of steps taken */
  vTarget = 1;
  stepIndex = 0;
  private dAlphaT: Float64Array;
  private dInvDen: Float64Array;
  private bAlphaT: Float64Array;
  private dLambda: Float64Array;
  private bLambda: Float64Array;
  private iAlphaT: Float64Array;
  private iInvDen: Float64Array;
  private iLambda: Float64Array;
  private vLambda = 0;
  /** accumulated contact corrections this substep (floor, collider), for friction */
  private penF: Float64Array;
  private penC: Float64Array;
  private grad: Float64Array | null = null;
  private acc: Float64Array | null = null;
  /** first distance constraint of the one-by-one sweep (nStretch when the stretch edges are solved as chains) */
  private firstPoint = 0;
  /** chain solve scratch per link: direction, inverse pivot, eliminated super-diagonal, right-hand side / Δλ */
  private cN: Float64Array | null = null;
  private cD: Float64Array | null = null;
  private cC: Float64Array | null = null;
  private cR: Float64Array | null = null;
  /** chain solve: up to two blocked (contact) normals per point and their count (contactNormals) */
  private cG: Float64Array | null = null;
  private cGK: Uint8Array | null = null;

  constructor(m: ClothModel, o: SimOptions, x0: Float64Array, v0: Float64Array | null, pinned: Uint8Array) {
    this.m = m; this.o = o;
    const n = (this.n = m.n);
    this.x = Float64Array.from(x0);
    this.xp = Float64Array.from(x0);
    this.v = v0 ? Float64Array.from(v0) : new Float64Array(n * 3);
    this.w = new Float64Array(n);
    for (let i = 0; i < n; i++) this.w[i] = pinned[i] ? 0 : 1 / m.mass[i];
    for (let i = 0; i < n; i++) if (pinned[i]) { this.v[i * 3] = 0; this.v[i * 3 + 1] = 0; this.v[i * 3 + 2] = 0; }
    this.h = o.dt / Math.max(1, o.substeps);
    const h2 = this.h * this.h;
    this.dAlphaT = new Float64Array(m.dAlpha.length);
    this.dInvDen = new Float64Array(m.dAlpha.length);
    for (let c = 0; c < m.dAlpha.length; c++) {
      const at = (this.dAlphaT[c] = m.dAlpha[c] / h2), ws = this.w[m.dA[c]] + this.w[m.dB[c]];
      // 1 / (w_a + w_b + alpha~), 0 = inactive (both ends pinned, or no stiffness)
      this.dInvDen[c] = ws === 0 || at === Infinity ? 0 : 1 / (ws + at);
    }
    const ni = m.iAlpha.length;
    this.iAlphaT = new Float64Array(ni); this.iInvDen = new Float64Array(ni); this.iLambda = new Float64Array(ni * 3);
    for (let c = 0; c < ni; c++) {
      const at = (this.iAlphaT[c] = m.iAlpha[c] / h2);
      let ws = 0;
      for (let q = 0; q < 4; q++) ws += this.w[m.iP[c * 4 + q]] * m.iK[c * 4 + q] * m.iK[c * 4 + q];
      this.iInvDen[c] = ws === 0 ? 0 : 1 / (ws + at);
    }
    this.bAlphaT = new Float64Array(m.bAlpha.length);
    for (let c = 0; c < m.bAlpha.length; c++) this.bAlphaT[c] = m.bAlpha[c] / h2;
    this.dLambda = new Float64Array(m.dAlpha.length);
    this.bLambda = new Float64Array(m.bAlpha.length);
    this.cp = new Float64Array(n * 3);
    this.cn = new Float64Array(n * 3);
    this.cf = new Uint8Array(n);
    this.ct = new Int32Array(n).fill(-1);
    this.qd = new Float64Array(n);
    this.penF = new Float64Array(n);
    this.penC = new Float64Array(n);
    if (o.tethers) this.pinTethers(pinned);
    if (m.cStart.length > 1) {
      let longest = 1;
      for (let k = 0; k + 1 < m.cStart.length; k++) longest = Math.max(longest, m.cStart[k + 1] - m.cStart[k]);
      this.firstPoint = m.nStretch;
      this.cN = new Float64Array(longest * 3); this.cD = new Float64Array(longest); this.cC = new Float64Array(longest);
      this.cR = new Float64Array(longest);
      this.cG = new Float64Array(n * 6); this.cGK = new Uint8Array(n);
    }
    if (o.pressure !== undefined && (o.pressureStiffness ?? 0) > 0 && m.tris.length) {
      const v = meshVolume(m.X, m.tris);
      this.vSign = v < 0 ? -1 : 1;
      this.vRest = Math.abs(v);
      if (this.vRest > 0 && m.area > 0) this.vAlpha = (this.vRest * this.vRest) / (o.pressureStiffness! * m.area) / h2;
      this.grad = new Float64Array(n * 3);
    }
    if (o.drag > 0 && m.tris.length) this.acc = new Float64Array(n * 3);
  }

  /**
   * Tethers (long-range attachments to the pins, Kim et al. 2012): every point reachable from a pin may not get farther
   * from its nearest pin than along the cloth at rest (the straight rest distance when the rest cloth is planar, where
   * that is the shortest path, else the edge path, which is never shorter than the true one). Pinned cloth then cannot
   * stretch under its own weight or the wind, whatever the iteration count.
   */
  private pinTethers(pinned: Uint8Array) {
    const n = this.n;
    let any = 0;
    for (let i = 0; i < n; i++) any += pinned[i];
    if (!any || any === n) return;
    const s = new AnchorSearch(this.m);
    s.run(pinned);
    const X = this.m.X, rs = this.m.restScale, A = (this.tA = new Int32Array(n)), D = (this.tD = new Float64Array(n));
    const planar = restIsPlanar(X, this.m.tris);
    for (let i = 0; i < n; i++) {
      const a = s.anchor[i];
      if (a < 0 || a === i || this.w[i] === 0) { A[i] = -1; continue; }
      A[i] = a;
      D[i] = planar ? Math.hypot(X[i * 3] - X[a * 3], X[i * 3 + 1] - X[a * 3 + 1], X[i * 3 + 2] - X[a * 3 + 2]) * rs : s.dist[i];
    }
  }

  /** Move points out of the floor (and nothing else) without giving them velocity. */
  settleFloor() {
    if (!this.o.floor) return;
    const y0 = this.o.floorHeight + this.o.thickness, x = this.x, xp = this.xp, w = this.w;
    for (let i = 0; i < this.n; i++) if (w[i] > 0 && x[i * 3 + 1] < y0) { x[i * 3 + 1] = y0; xp[i * 3 + 1] = y0; }
  }

  /** Project points out of the current collider contact planes without giving them velocity (initial overlaps). */
  settleContacts() {
    const x = this.x, xp = this.xp, w = this.w, cp = this.cp, cn = this.cn, cf = this.cf, th = this.o.thickness;
    for (let i = 0; i < this.n; i++) {
      if (!cf[i] || w[i] === 0) continue;
      const o = i * 3;
      const d = (x[o] - cp[o]) * cn[o] + (x[o + 1] - cp[o + 1]) * cn[o + 1] + (x[o + 2] - cp[o + 2]) * cn[o + 2];
      if (d < th) {
        const k = th - d;
        x[o] += k * cn[o]; x[o + 1] += k * cn[o + 1]; x[o + 2] += k * cn[o + 2];
        xp[o] = x[o]; xp[o + 1] = x[o + 1]; xp[o + 2] = x[o + 2];
      }
    }
  }

  /**
   * Collider query radius per point for the next step (collideRange): thickness plus twice the distance the point can
   * travel in a step at its current speed under gravity, plus half a thickness of margin; 0 = no query this step, for
   * - pinned points;
   * - points with a contact that have moved less than a quarter of the thickness since their query: the contact plane
   *   is kept (on a curved collider it is off by (thickness/4)²/(2·radius) at most);
   * - points that cannot be within the radius: the distance found at the last query (qd, at least twice that query's
   *   radius when nothing was found) less how far the point has moved since is a lower bound on its distance now.
   */
  queryRadius(R: Float64Array) {
    const o = this.o, dt = o.dt, v = this.v, w = this.w, x = this.x, cf = this.cf, qd = this.qd, keep = 0.25 * o.thickness;
    const g = Math.hypot(o.gravity[0], o.gravity[1], o.gravity[2]);
    const base = 1.5 * o.thickness + 2 * g * dt * dt;
    const QX = (this.qX ??= Float64Array.from(x));
    for (let i = 0; i < this.n; i++) {
      if (w[i] === 0) { R[i] = 0; cf[i] = 0; continue; }
      const k = i * 3;
      const ex = x[k] - QX[k], ey = x[k + 1] - QX[k + 1], ez = x[k + 2] - QX[k + 2];
      const moved = Math.sqrt(ex * ex + ey * ey + ez * ez);
      if (cf[i] && moved < keep) { R[i] = 0; continue; }
      const s = Math.sqrt(v[k] * v[k] + v[k + 1] * v[k + 1] + v[k + 2] * v[k + 2]);
      const r = base + 2 * s * dt;
      if (qd[i] - moved > r) { R[i] = 0; cf[i] = 0; continue; }
      R[i] = r;
    }
  }

  /** After the collider query with radii R (queryRadius): the queried points remember where they were. */
  afterQuery(R: Float64Array) {
    const x = this.x, QX = this.qX!;
    for (let i = 0; i < this.n; i++) {
      if (!(R[i] > 0)) continue;
      const k = i * 3;
      QX[k] = x[k]; QX[k + 1] = x[k + 1]; QX[k + 2] = x[k + 2];
    }
  }

  /**
   * Self-collision pairs for the next step from a spatial hash: points closer than 2·thickness plus how far the pair
   * can approach in a step (capped at 2·thickness). The minimum distance of a pair is 2·thickness, or their rest
   * distance when that is smaller (neighbours in the cloth). Pairs come out sorted by (i, j).
   */
  findSelfPairs() {
    const n = this.n, x = this.x, X = this.m.X, v = this.v, t2 = 2 * this.o.thickness;
    if (!(t2 > 0) || n < 2) { this.sCount = 0; return; }
    let vmax = 0;
    for (let i = 0; i < n * 3; i += 3) vmax = Math.max(vmax, Math.sqrt(v[i] * v[i] + v[i + 1] * v[i + 1] + v[i + 2] * v[i + 2]));
    const rq = t2 + Math.min(t2, 2 * vmax * this.o.dt), rq2 = rq * rq, inv = 1 / rq;
    let size = 1;
    while (size < n * 2) size <<= 1;
    const mask = size - 1;
    const cell = new Int32Array(n * 3), hsh = new Int32Array(n), start = new Int32Array(size + 1);
    const hc = (cx: number, cy: number, cz: number) => ((Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663) ^ Math.imul(cz, 83492791)) >>> 0) & mask;
    for (let i = 0; i < n; i++) {
      const cx = Math.floor(x[i * 3] * inv), cy = Math.floor(x[i * 3 + 1] * inv), cz = Math.floor(x[i * 3 + 2] * inv);
      cell[i * 3] = cx; cell[i * 3 + 1] = cy; cell[i * 3 + 2] = cz;
      const hv = hc(cx, cy, cz);
      hsh[i] = hv; start[hv + 1]++;
    }
    for (let k = 0; k < size; k++) start[k + 1] += start[k];
    const fill = start.slice(0, size), ent = new Int32Array(n);
    for (let i = 0; i < n; i++) ent[fill[hsh[i]]++] = i;
    const pi: number[] = [], pj: number[] = [], pd: number[] = [];
    const seen = new Int32Array(27);
    const found: number[] = [];
    for (let i = 0; i < n; i++) {
      const cx = cell[i * 3], cy = cell[i * 3 + 1], cz = cell[i * 3 + 2];
      let ns = 0;
      found.length = 0;
      for (let dz = -1; dz <= 1; dz++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const hv = hc(cx + dx, cy + dy, cz + dz);
            let dup = false;
            for (let k = 0; k < ns; k++) if (seen[k] === hv) { dup = true; break; }
            if (dup) continue;
            seen[ns++] = hv;
            for (let e = start[hv]; e < start[hv + 1]; e++) {
              const j = ent[e];
              if (j <= i) continue;
              const ex = x[j * 3] - x[i * 3], ey = x[j * 3 + 1] - x[i * 3 + 1], ez = x[j * 3 + 2] - x[i * 3 + 2];
              if (ex * ex + ey * ey + ez * ez < rq2) found.push(j);
            }
          }
      found.sort((a, b) => a - b);
      for (const j of found) {
        const rd = Math.hypot(X[j * 3] - X[i * 3], X[j * 3 + 1] - X[i * 3 + 1], X[j * 3 + 2] - X[i * 3 + 2]);
        const md = Math.min(t2, rd);
        if (md > 1e-12) { pi.push(i); pj.push(j); pd.push(md); }
      }
    }
    this.sI = Int32Array.from(pi); this.sJ = Int32Array.from(pj); this.sD = Float64Array.from(pd); this.sCount = pi.length;
  }

  /**
   * Air drag of every triangle against the wind, k·A·vn·|vn| along the normal (vn = the normal component of the wind
   * relative to the triangle), a third to each corner, as accelerations per point (acc). Evaluated once per step and
   * held over its substeps; a point's acceleration is capped so that a step cannot push it past the wind speed
   * (keeps strong wind and light cloth stable).
   */
  private aero() {
    const acc = this.acc!, x = this.x, v = this.v, tris = this.m.tris, mass = this.m.mass, dt = this.o.dt;
    const wx = this.o.wind[0], wy = this.o.wind[1], wz = this.o.wind[2], k = this.o.drag / 3;
    acc.fill(0);
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t] * 3, b = tris[t + 1] * 3, c = tris[t + 2] * 3;
      const ux = x[b] - x[a], uy = x[b + 1] - x[a + 1], uz = x[b + 2] - x[a + 2];
      const qx = x[c] - x[a], qy = x[c + 1] - x[a + 1], qz = x[c + 2] - x[a + 2];
      const nx = uy * qz - uz * qy, ny = uz * qx - ux * qz, nz = ux * qy - uy * qx;
      const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (!(l > 1e-300)) continue;
      const rx = wx - (v[a] + v[b] + v[c]) / 3, ry = wy - (v[a + 1] + v[b + 1] + v[c + 1]) / 3, rz = wz - (v[a + 2] + v[b + 2] + v[c + 2]) / 3;
      // with n = N/|N| and A = |N|/2: k·A·vn·|vn|·n = k/2 · (r·N)·|r·N| / |N|² · N
      const rn = rx * nx + ry * ny + rz * nz;
      const s = (k * 0.5 * rn * (rn < 0 ? -rn : rn)) / (l * l * l);
      const fx = s * nx, fy = s * ny, fz = s * nz;
      acc[a] += fx; acc[a + 1] += fy; acc[a + 2] += fz;
      acc[b] += fx; acc[b + 1] += fy; acc[b + 2] += fz;
      acc[c] += fx; acc[c + 1] += fy; acc[c + 2] += fz;
    }
    for (let i = 0; i < this.n; i++) {
      const o = i * 3, im = 1 / mass[i];
      let ax = acc[o] * im, ay = acc[o + 1] * im, az = acc[o + 2] * im;
      const al = Math.sqrt(ax * ax + ay * ay + az * az);
      if (al > 0) {
        const rx = wx - v[o], ry = wy - v[o + 1], rz = wz - v[o + 2];
        const lim = Math.sqrt(rx * rx + ry * ry + rz * rz) / dt;
        if (al > lim) { const f = lim / al; ax *= f; ay *= f; az *= f; }
      }
      acc[o] = ax; acc[o + 1] = ay; acc[o + 2] = az;
    }
  }

  /** One step of o.dt: substeps × (predict, iterations of constraint sweeps, friction, velocities). */
  step() {
    const o = this.o, n = this.n, x = this.x, xp = this.xp, v = this.v, w = this.w, h = this.h;
    const gx = o.gravity[0], gy = o.gravity[1], gz = o.gravity[2];
    const damp = Math.exp(-Math.max(0, o.damping) * h);
    if (this.acc) this.aero();
    if (this.grad) {
      // inflate gradually: the target volume ratio rises from 1 to the pressure along a smoothstep over pressureRamp steps
      const ramp = this.o.pressureRamp ?? 0, u = ramp > 0 ? Math.min(1, (this.stepIndex + 1) / ramp) : 1;
      this.vTarget = 1 + ((this.o.pressure ?? 1) - 1) * u * u * (3 - 2 * u);
    }
    this.stepIndex++;
    const acc = this.acc;
    for (let sub = 0; sub < o.substeps; sub++) {
      for (let i = 0; i < n; i++) {
        const k = i * 3;
        xp[k] = x[k]; xp[k + 1] = x[k + 1]; xp[k + 2] = x[k + 2];
        if (w[i] === 0) continue;
        let vx = v[k] + h * gx, vy = v[k + 1] + h * gy, vz = v[k + 2] + h * gz;
        if (acc) { vx += h * acc[k]; vy += h * acc[k + 1]; vz += h * acc[k + 2]; }
        v[k] = vx; v[k + 1] = vy; v[k + 2] = vz;
        x[k] += h * vx; x[k + 1] += h * vy; x[k + 2] += h * vz;
      }
      // with one sweep per substep the multipliers are always 0 when read: skip them (same bits, less work)
      const lam = o.iterations > 1;
      if (lam) { this.dLambda.fill(0); this.bLambda.fill(0); this.iLambda.fill(0); }
      this.vLambda = 0;
      this.penF.fill(0);
      this.penC.fill(0);
      for (let it = 0; it < o.iterations; it++) {
        // forward, backward, ... within a substep, forward again at the next: alternating across substeps with one sweep each
        // pumps a period-2 mode (a closed sphere crumpled from a 1e-3 jitter), a symmetric sweep within a substep does not
        const fwd = (it & 1) === 0;
        // soft and point-wise constraints first; the stiff, contact-aware stretch chains last before the contacts
        if (lam) this.solveDistances(fwd); else this.solveDistancesOnce(fwd);
        if (this.m.bAlpha.length) this.solveBends(fwd, lam);
        if (this.iInvDen.length) this.solveIso(fwd, lam);
        if (this.tA) this.solveTethers();
        if (this.grad) this.solveVolume();
        if (this.sCount) this.solveSelf();
        if (this.cN) this.solveChains(fwd, lam);
        this.solveContacts();
      }
      if (o.friction > 0) this.applyFriction();
      const ih = 1 / h;
      for (let i = 0; i < n; i++) {
        const k = i * 3;
        if (w[i] === 0) { v[k] = 0; v[k + 1] = 0; v[k + 2] = 0; continue; }
        v[k] = (x[k] - xp[k]) * ih * damp; v[k + 1] = (x[k + 1] - xp[k + 1]) * ih * damp; v[k + 2] = (x[k + 2] - xp[k + 2]) * ih * damp;
      }
    }
  }

  /** Distance constraints one by one (the shear ones only when the stretch edges are solved as chains). */
  private solveDistances(fwd: boolean) {
    const m = this.m, x = this.x, w = this.w, A = m.dA, B = m.dB, R = m.dRest, AT = this.dAlphaT, ID = this.dInvDen, L = this.dLambda;
    const nd = A.length, first = this.firstPoint, last = nd - 1 + first;
    for (let j = first; j < nd; j++) {
      const c = fwd ? j : last - j;
      const id = ID[c];
      if (id === 0) continue;
      const a = A[c], b = B[c];
      const ia = a * 3, ib = b * 3;
      const dx = x[ia] - x[ib], dy = x[ia + 1] - x[ib + 1], dz = x[ia + 2] - x[ib + 2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < 1e-24) continue;
      const il = 1 / Math.sqrt(d2);
      const dl = (R[c] - d2 * il - AT[c] * L[c]) * id;
      L[c] += dl;
      const s = dl * il;
      const sa = s * w[a], sb = s * w[b];
      x[ia] += sa * dx; x[ia + 1] += sa * dy; x[ia + 2] += sa * dz;
      x[ib] -= sb * dx; x[ib + 1] -= sb * dy; x[ib + 2] -= sb * dz;
    }
  }

  /** solveDistances for the first sweep of a substep (multipliers 0): the same update without reading or writing them. */
  private solveDistancesOnce(fwd: boolean) {
    const m = this.m, x = this.x, w = this.w, A = m.dA, B = m.dB, R = m.dRest, ID = this.dInvDen;
    const nd = A.length, first = this.firstPoint, last = nd - 1 + first;
    for (let j = first; j < nd; j++) {
      const c = fwd ? j : last - j;
      const id = ID[c];
      if (id === 0) continue;
      const a = A[c], b = B[c];
      const ia = a * 3, ib = b * 3;
      const dx = x[ia] - x[ib], dy = x[ia + 1] - x[ib + 1], dz = x[ia + 2] - x[ib + 2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < 1e-24) continue;
      const il = 1 / Math.sqrt(d2);
      const s = (R[c] - d2 * il) * id * il;
      const sa = s * w[a], sb = s * w[b];
      x[ia] += sa * dx; x[ia + 1] += sa * dy; x[ia + 2] += sa * dz;
      x[ib] -= sb * dx; x[ib + 1] -= sb * dy; x[ib + 2] -= sb * dz;
    }
  }

  /**
   * Stretch chains as blocks: per chain, the linearised constraints C_i = |x_{i+1} - x_i| - L_i give the tridiagonal
   * system (J M Jᵀ + α̃) Δλ = -C - α̃ λ, solved exactly by the Thomas algorithm (J M Jᵀ is symmetric positive
   * semi-definite); Δx = M Jᵀ Δλ. M is the points' mobility: w·I for a free point, w·(I - Σ ν νᵀ) for a point resting
   * on a contact plane (normals ν of the collider plane and the floor it touches), so the solve slides points along the
   * surfaces they rest on instead of pushing them in (which the contact would undo: a rope over an edge would keep its
   * edge link stretched). Inactive links (both ends pinned or blocked, no stiffness, zero length) get Δλ = 0. Chains run
   * in a fixed order, alternating direction like the other sweeps.
   */
  /**
   * Blocked directions per point for the chain solve: the normals of the contact planes it rests on (collider plane,
   * floor), orthonormalised, into cG (6 per point) and cGK (their count). Computed once per sweep.
   */
  private contactNormals() {
    const o = this.o, x = this.x, w = this.w, G = this.cG!, GK = this.cGK!, cf = this.cf, cp = this.cp, cn = this.cn;
    const th = o.thickness, tol = th * 1e-6 + 1e-9, floor = o.floor, y0 = o.floorHeight + th + tol;
    for (let p = 0; p < this.n; p++) {
      const q = p * 6, xo = p * 3;
      let c = 0;
      if (w[p] !== 0) {
        if (cf[p] && (x[xo] - cp[xo]) * cn[xo] + (x[xo + 1] - cp[xo + 1]) * cn[xo + 1] + (x[xo + 2] - cp[xo + 2]) * cn[xo + 2] <= th + tol) {
          G[q] = cn[xo]; G[q + 1] = cn[xo + 1]; G[q + 2] = cn[xo + 2]; c = 1;
        }
        if (floor && x[xo + 1] <= y0) {
          // (0, 1, 0) minus its part along the first normal
          let gx = 0, gy = 1, gz = 0;
          if (c) { const d = G[q + 1]; gx -= d * G[q]; gy -= d * G[q + 1]; gz -= d * G[q + 2]; }
          const gl = Math.sqrt(gx * gx + gy * gy + gz * gz);
          if (gl > 1e-6) { G[q + c * 3] = gx / gl; G[q + c * 3 + 1] = gy / gl; G[q + c * 3 + 2] = gz / gl; c++; }
        }
      }
      GK[p] = c;
    }
  }

  private solveChains(fwd: boolean, lam: boolean) {
    const m = this.m, x = this.x, w = this.w, P = m.cPts, S = m.cStart, K = m.cCons, R = m.dRest, AT = this.dAlphaT, L = this.dLambda;
    const N = this.cN!, Cp = this.cC!, Rp = this.cR!, IP = this.cD!, G = this.cG!, GK = this.cGK!;
    const nc = S.length - 1;
    this.contactNormals();
    // u·M_p·v: w_p (u·v minus the parts along p's blocked normals)
    const mob = (p: number, ux: number, uy: number, uz: number, vx: number, vy: number, vz: number) => {
      let r = ux * vx + uy * vy + uz * vz;
      for (let g = 0, q = p * 6; g < GK[p]; g++, q += 3) r -= (ux * G[q] + uy * G[q + 1] + uz * G[q + 2]) * (vx * G[q] + vy * G[q + 1] + vz * G[q + 2]);
      return w[p] * r;
    };
    for (let jj = 0; jj < nc; jj++) {
      const k = fwd ? jj : nc - 1 - jj;
      const s = S[k], nl = S[k + 1] - s - 1, lo = s - k;
      // forward: assemble link i (direction, diagonal, right-hand side) and eliminate it (Thomas); IP = 1 / pivot,
      // Rp = eliminated right-hand side, Cp = eliminated super-diagonal (known once link i + 1 is assembled)
      let px = 0, py = 0, pz = 0;
      for (let i = 0; i < nl; i++) {
        const a = P[s + i], b = P[s + i + 1], cid = K[lo + i], q = i * 3;
        const ia = a * 3, ib = b * 3, wa = w[a], wb = w[b], ga = GK[a];
        const dx = x[ib] - x[ia], dy = x[ib + 1] - x[ia + 1], dz = x[ib + 2] - x[ia + 2];
        const d2 = dx * dx + dy * dy + dz * dz, ws = wa + wb, at = AT[cid];
        let dg = 0, rhs = 0, nx = 0, ny = 0, nz = 0;
        if (ws !== 0 && at !== Infinity && d2 >= 1e-24) {
          const il = 1 / Math.sqrt(d2);
          nx = dx * il; ny = dy * il; nz = dz * il;
          // a free point's mobility along the unit direction is just its inverse mass
          dg = (ga ? mob(a, nx, ny, nz, nx, ny, nz) : wa) + (GK[b] ? mob(b, nx, ny, nz, nx, ny, nz) : wb);
          if (dg > 1e-9 * ws) { dg += at; rhs = lam ? R[cid] - d2 * il - at * L[cid] : R[cid] - d2 * il; }
          else { dg = 0; nx = ny = nz = 0; }
        }
        // inactive link: a decoupled row 1·Δλ = 0
        if (dg === 0) dg = 1;
        N[q] = nx; N[q + 1] = ny; N[q + 2] = nz;
        if (i === 0) { IP[0] = 1 / dg; Rp[0] = rhs * IP[0]; px = nx; py = ny; pz = nz; continue; }
        const off = ga ? -mob(a, px, py, pz, nx, ny, nz) : -wa * (px * nx + py * ny + pz * nz);
        px = nx; py = ny; pz = nz;
        const c = (Cp[i - 1] = off * IP[i - 1]);
        const ip = (IP[i] = 1 / (dg - off * c));
        Rp[i] = (rhs - off * Rp[i - 1]) * ip;
      }
      // backward: Δλ_i = Rp_i - Cp_i Δλ_{i+1}; then point i + 1 gets Δx = M (n_i Δλ_i - n_{i+1} Δλ_{i+1})
      let next = 0;
      for (let i = nl - 1; i >= -1; i--) {
        let dl = 0;
        if (i >= 0) {
          dl = i === nl - 1 ? Rp[i] : Rp[i] - Cp[i] * next;
          Rp[i] = dl;
          if (lam) L[K[lo + i]] += dl;
        }
        const p = P[s + i + 1], wp = w[p];
        if (wp !== 0) {
          let fx = 0, fy = 0, fz = 0;
          if (i >= 0) { const q = i * 3; fx = N[q] * dl; fy = N[q + 1] * dl; fz = N[q + 2] * dl; }
          if (i + 1 < nl) { const q = (i + 1) * 3; fx -= N[q] * next; fy -= N[q + 1] * next; fz -= N[q + 2] * next; }
          for (let g = 0, q = p * 6; g < GK[p]; g++, q += 3) {
            const d = fx * G[q] + fy * G[q + 1] + fz * G[q + 2];
            fx -= d * G[q]; fy -= d * G[q + 1]; fz -= d * G[q + 2];
          }
          const xo = p * 3;
          x[xo] += wp * fx; x[xo + 1] += wp * fy; x[xo + 2] += wp * fz;
        }
        next = dl;
      }
    }
  }

  /**
   * Isometric bends (flat rest): the vector constraint q = Σ Kᵢ xᵢ, gradient Kᵢ·I, so Δλ = -(q + α̃λ) / (Σ wᵢ Kᵢ² + α̃).
   * |q|² = (K₃h)²·2(1 - cos θ) for a fold θ, so the quadratic energy loses its pull towards flat as a hinge folds over
   * (none at all at 180°: a crumpled quad would stay folded); past 90° (|q|² > 2(K₃h)²) the hinge is projected with
   * the dihedral constraint instead, whose restoring force grows with the angle.
   */
  private solveIso(fwd: boolean, lam: boolean) {
    const x = this.x, w = this.w, IP = this.m.iP, IK = this.m.iK, IC = this.m.iC, ID = this.iInvDen, AT = this.iAlphaT, L = this.iLambda;
    const ni = ID.length;
    for (let j = 0; j < ni; j++) {
      const c = fwd ? j : ni - 1 - j, id = ID[c];
      if (id === 0) continue;
      const o = c * 4, i0 = IP[o], i1 = IP[o + 1], i2 = IP[o + 2], i3 = IP[o + 3];
      const a = i0 * 3, b = i1 * 3, p = i2 * 3, q = i3 * 3, k0 = IK[o], k1 = IK[o + 1], k2 = IK[o + 2], k3 = IK[o + 3];
      const qx = k0 * x[a] + k1 * x[b] + k2 * x[p] + k3 * x[q];
      const qy = k0 * x[a + 1] + k1 * x[b + 1] + k2 * x[p + 1] + k3 * x[q + 1];
      const qz = k0 * x[a + 2] + k1 * x[b + 2] + k2 * x[p + 2] + k3 * x[q + 2];
      if (qx * qx + qy * qy + qz * qz > 2 * IC[c]) {
        // folded past 90°: the dihedral constraint towards flat, compliance 1/k = α / (K₃h)²
        this.dihedral(i2, i3, i0, i1, 0, AT[c] / IC[c], null, 0);
        continue;
      }
      let dx: number, dy: number, dz: number;
      if (lam) {
        const at = AT[c], l = c * 3;
        dx = -(qx + at * L[l]) * id; dy = -(qy + at * L[l + 1]) * id; dz = -(qz + at * L[l + 2]) * id;
        L[l] += dx; L[l + 1] += dy; L[l + 2] += dz;
      } else { dx = -qx * id; dy = -qy * id; dz = -qz * id; }
      let f = w[i0] * k0; x[a] += f * dx; x[a + 1] += f * dy; x[a + 2] += f * dz;
      f = w[i1] * k1; x[b] += f * dx; x[b + 1] += f * dy; x[b + 2] += f * dz;
      f = w[i2] * k2; x[p] += f * dx; x[p + 1] += f * dy; x[p + 2] += f * dz;
      f = w[i3] * k3; x[q] += f * dx; x[q + 1] += f * dy; x[q + 2] += f * dz;
    }
  }

  /** Dihedral bends (curved rest): one dihedral projection per hinge. */
  private solveBends(fwd: boolean, lam: boolean) {
    const BP = this.m.bP, R = this.m.bRest, AT = this.bAlphaT, nb = R.length;
    for (let j = 0; j < nb; j++) {
      const c = fwd ? j : nb - 1 - j;
      this.dihedral(BP[c * 4], BP[c * 4 + 1], BP[c * 4 + 2], BP[c * 4 + 3], R[c], AT[c], lam ? this.bLambda : null, c);
    }
  }

  /**
   * Project the dihedral angle of the hinge (wings i1, i2; edge i3 → i4) towards `rest` with compliance at = α / h²
   * (multiplier L[li] when L is given, else the multiplier-free first-sweep update).
   */
  private dihedral(i1: number, i2: number, i3: number, i4: number, rest: number, at: number, L: Float64Array | null, li: number) {
    const x = this.x, w = this.w;
    const w1 = w[i1], w2 = w[i2], w3 = w[i3], w4 = w[i4];
    if (w1 + w2 + w3 + w4 === 0) return;
    const p1 = i1 * 3, p2 = i2 * 3, p3 = i3 * 3, p4 = i4 * 3;
    const ex = x[p4] - x[p3], ey = x[p4 + 1] - x[p3 + 1], ez = x[p4 + 2] - x[p3 + 2];
    const a1x = x[p1] - x[p3], a1y = x[p1 + 1] - x[p3 + 1], a1z = x[p1 + 2] - x[p3 + 2];
    const b1x = x[p1] - x[p4], b1y = x[p1 + 1] - x[p4 + 1], b1z = x[p1 + 2] - x[p4 + 2];
    const a2x = x[p2] - x[p4], a2y = x[p2 + 1] - x[p4 + 1], a2z = x[p2 + 2] - x[p4 + 2];
    const b2x = x[p2] - x[p3], b2y = x[p2 + 1] - x[p3 + 1], b2z = x[p2 + 2] - x[p3 + 2];
    const n1x = a1y * b1z - a1z * b1y, n1y = a1z * b1x - a1x * b1z, n1z = a1x * b1y - a1y * b1x;
    const n2x = a2y * b2z - a2z * b2y, n2y = a2z * b2x - a2x * b2z, n2z = a2x * b2y - a2y * b2x;
    const e2 = ex * ex + ey * ey + ez * ez;
    const l1 = n1x * n1x + n1y * n1y + n1z * n1z, l2 = n2x * n2x + n2y * n2y + n2z * n2z;
    if (!(e2 > 1e-24 && l1 > 1e-24 && l2 > 1e-24)) return;
    const el = Math.sqrt(e2), iel = 1 / el;
    const cx = n1y * n2z - n1z * n2y, cy = n1z * n2x - n1x * n2z, cz = n1x * n2y - n1y * n2x;
    const cs = n1x * n2x + n1y * n2y + n1z * n2z;
    const theta = fastAtan2((cx * ex + cy * ey + cz * ez) * iel, cs);
    let C = theta - rest;
    if (C > Math.PI) C -= 2 * Math.PI; else if (C < -Math.PI) C += 2 * Math.PI;
    // ∂θ/∂x = -(u1, u2, u3, u4) of Bridson et al. 2003 for this θ (checked against finite differences in test/cloth.ts):
    // u1 = |E| N1/|N1|², u2 = |E| N2/|N2|², u3 and u4 from the wings' projections on the edge (they sum to zero).
    // Every gradient is a combination g = α N1 + β N2, so |g|² = α²|N1|² + β²|N2|² + 2αβ N1·N2.
    const il1 = 1 / l1, il2 = 1 / l2;
    const s1 = el * il1, s2 = el * il2, q1 = iel * il1, q2 = iel * il2;
    const e14 = a1x * ex + a1y * ey + a1z * ez, e24 = b2x * ex + b2y * ey + b2z * ez;
    // (x1 - x4)·E = (x1 - x3)·E - |E|², likewise for x2
    const d13 = (e14 - e2) * q1, d23 = (e24 - e2) * q2, d14 = e14 * q1, d24 = e24 * q2;
    const den = w1 * e2 * il1 + w2 * e2 * il2 + w3 * (d13 * d13 * l1 + d23 * d23 * l2 + 2 * d13 * d23 * cs) +
      w4 * (d14 * d14 * l1 + d24 * d24 * l2 + 2 * d14 * d24 * cs) + at;
    if (!(den > 1e-300)) return;
    let dl: number;
    if (L) { dl = (-C - at * L[li]) / den; L[li] += dl; } else dl = -C / den;
    // Δx_i = w_i Δλ g_i with g1 = -s1 N1, g2 = -s2 N2, g3 = -(d13 N1 + d23 N2), g4 = d14 N1 + d24 N2
    let k = -w1 * dl * s1; x[p1] += k * n1x; x[p1 + 1] += k * n1y; x[p1 + 2] += k * n1z;
    k = -w2 * dl * s2; x[p2] += k * n2x; x[p2 + 1] += k * n2y; x[p2 + 2] += k * n2z;
    let k1 = -w3 * dl * d13, k2 = -w3 * dl * d23;
    x[p3] += k1 * n1x + k2 * n2x; x[p3 + 1] += k1 * n1y + k2 * n2y; x[p3 + 2] += k1 * n1z + k2 * n2z;
    k1 = w4 * dl * d14; k2 = w4 * dl * d24;
    x[p4] += k1 * n1x + k2 * n2x; x[p4 + 1] += k1 * n1y + k2 * n2y; x[p4 + 2] += k1 * n1z + k2 * n2z;
  }

  private solveTethers() {
    const x = this.x, w = this.w, A = this.tA!, D = this.tD!;
    for (let i = 0; i < this.n; i++) {
      const a = A[i];
      if (a < 0 || w[i] === 0) continue;
      const k = i * 3, q = a * 3;
      const dx = x[k] - x[q], dy = x[k + 1] - x[q + 1], dz = x[k + 2] - x[q + 2];
      const d2 = dx * dx + dy * dy + dz * dz, md = D[i];
      if (d2 <= md * md) continue;
      const d = Math.sqrt(d2), s = (md - d) / d;
      x[k] += s * dx; x[k + 1] += s * dy; x[k + 2] += s * dz;
    }
  }

  private solveVolume() {
    const x = this.x, w = this.w, tris = this.m.tris, gr = this.grad!, sign = this.vSign;
    gr.fill(0);
    let V = 0;
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t] * 3, b = tris[t + 1] * 3, c = tris[t + 2] * 3;
      const ax = x[a], ay = x[a + 1], az = x[a + 2], bx = x[b], by = x[b + 1], bz = x[b + 2], cx = x[c], cy = x[c + 1], cz = x[c + 2];
      const bcx = by * cz - bz * cy, bcy = bz * cx - bx * cz, bcz = bx * cy - by * cx;
      V += ax * bcx + ay * bcy + az * bcz;
      gr[a] += bcx; gr[a + 1] += bcy; gr[a + 2] += bcz;
      gr[b] += cy * az - cz * ay; gr[b + 1] += cz * ax - cx * az; gr[b + 2] += cx * ay - cy * ax;
      gr[c] += ay * bz - az * by; gr[c + 1] += az * bx - ax * bz; gr[c + 2] += ax * by - ay * bx;
    }
    V = (sign * V) / 6;
    const C = V - this.vTarget * this.vRest;
    let den = 0;
    const s6 = sign / 6;
    for (let i = 0; i < this.n; i++) {
      if (w[i] === 0) continue;
      const k = i * 3;
      den += w[i] * (gr[k] * gr[k] + gr[k + 1] * gr[k + 1] + gr[k + 2] * gr[k + 2]) * (1 / 36);
    }
    const at = this.vAlpha;
    if (!(den + at > 1e-300)) return;
    const dl = (-C - at * this.vLambda) / (den + at);
    this.vLambda += dl;
    for (let i = 0; i < this.n; i++) {
      if (w[i] === 0) continue;
      const k = i * 3, f = w[i] * dl * s6;
      x[k] += f * gr[k]; x[k + 1] += f * gr[k + 1]; x[k + 2] += f * gr[k + 2];
    }
  }

  private solveSelf() {
    const x = this.x, w = this.w, I = this.sI, J = this.sJ, D = this.sD;
    for (let c = 0; c < this.sCount; c++) {
      const i = I[c], j = J[c], wi = w[i], wj = w[j];
      if (wi + wj === 0) continue;
      const a = i * 3, b = j * 3;
      const dx = x[a] - x[b], dy = x[a + 1] - x[b + 1], dz = x[a + 2] - x[b + 2];
      const d2 = dx * dx + dy * dy + dz * dz, md = D[c];
      if (d2 >= md * md || d2 < 1e-24) continue;
      const d = Math.sqrt(d2), s = (md - d) / (d * (wi + wj));
      x[a] += wi * s * dx; x[a + 1] += wi * s * dy; x[a + 2] += wi * s * dz;
      x[b] -= wj * s * dx; x[b + 1] -= wj * s * dy; x[b + 2] -= wj * s * dz;
    }
  }

  private solveContacts() {
    const o = this.o, x = this.x, w = this.w, th = o.thickness, n = this.n;
    const cf = this.cf, cp = this.cp, cn = this.cn, penC = this.penC, penF = this.penF;
    for (let i = 0; i < n; i++) {
      if (!cf[i] || w[i] === 0) continue;
      const k = i * 3;
      const d = (x[k] - cp[k]) * cn[k] + (x[k + 1] - cp[k + 1]) * cn[k + 1] + (x[k + 2] - cp[k + 2]) * cn[k + 2];
      if (d >= th) continue;
      const s = th - d;
      x[k] += s * cn[k]; x[k + 1] += s * cn[k + 1]; x[k + 2] += s * cn[k + 2];
      penC[i] += s;
    }
    if (o.floor) {
      const y0 = o.floorHeight + th;
      for (let i = 0; i < n; i++) {
        const k = i * 3 + 1;
        if (w[i] === 0 || x[k] >= y0) continue;
        penF[i] += y0 - x[k];
        x[k] = y0;
      }
    }
    if (this.kCount) this.solveCorners();
  }

  /**
   * Collider corners under cloth triangles (findCornerContacts): keep the triangle's point above the corner (at the
   * stored barycentrics) `thickness` in front of it along the triangle normal turned outwards, moving the three cloth
   * points by their barycentric share (C = (Σ bᵢ xᵢ - c)·n - thickness, ∇ₓᵢ C = bᵢ n).
   */
  private solveCorners() {
    const x = this.x, w = this.w, tris = this.m.tris, th = this.o.thickness, T = this.kT, B = this.kB, C = this.kC, Nc = this.kN;
    for (let k = 0; k < this.kCount; k++) {
      const t = T[k] * 3, a = tris[t] * 3, b = tris[t + 1] * 3, c = tris[t + 2] * 3;
      const b0 = B[k * 3], b1 = B[k * 3 + 1], b2 = B[k * 3 + 2];
      // triangle normal, turned towards the corner's outward normal
      const ux = x[b] - x[a], uy = x[b + 1] - x[a + 1], uz = x[b + 2] - x[a + 2];
      const vx = x[c] - x[a], vy = x[c + 1] - x[a + 1], vz = x[c + 2] - x[a + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (!(nl > 1e-300)) continue;
      const sg = nx * Nc[k * 3] + ny * Nc[k * 3 + 1] + nz * Nc[k * 3 + 2] < 0 ? -1 / nl : 1 / nl;
      nx *= sg; ny *= sg; nz *= sg;
      const px = b0 * x[a] + b1 * x[b] + b2 * x[c], py = b0 * x[a + 1] + b1 * x[b + 1] + b2 * x[c + 1], pz = b0 * x[a + 2] + b1 * x[b + 2] + b2 * x[c + 2];
      const d = (px - C[k * 3]) * nx + (py - C[k * 3 + 1]) * ny + (pz - C[k * 3 + 2]) * nz;
      if (d >= th) continue;
      const wa = w[tris[t]], wb = w[tris[t + 1]], wc = w[tris[t + 2]];
      const den = wa * b0 * b0 + wb * b1 * b1 + wc * b2 * b2;
      if (!(den > 0)) continue;
      const s = (th - d) / den;
      let f = wa * b0 * s; x[a] += f * nx; x[a + 1] += f * ny; x[a + 2] += f * nz;
      f = wb * b1 * s; x[b] += f * nx; x[b + 1] += f * ny; x[b + 2] += f * nz;
      f = wc * b2 * s; x[c] += f * nx; x[c + 1] += f * ny; x[c + 2] += f * nz;
    }
  }

  /**
   * Corner contacts for the next step. Point contacts alone let a sharp collider corner poke between cloth points, so
   * every sharp convex corner (Collider.SV) facing up against gravity (its outward normal within 78° of up; any corner
   * without gravity) that a cloth point with a collider contact comes within 1.5 edges of looks for the cloth triangle
   * around that point's 2-ring into which it projects, facing along the corner's normal (within 72°), in front of the
   * corner and at most 2·thickness + half an edge away; the nearest such triangle becomes a contact for the step's
   * substeps (solveCorners). The corners are hashed once (they are static); the per-step cost is the contact points.
   */
  findCornerContacts(col: Collider) {
    this.kCount = 0;
    const ns = col.SV.length, tris = this.m.tris, nt = tris.length / 3, n = this.n;
    if (!ns || !nt) return;
    const x = this.x, o = this.o, th = o.thickness, edge = this.m.meanEdge || 0.01, SP = col.SP, SN = col.SN;
    const gl = Math.hypot(o.gravity[0], o.gravity[1], o.gravity[2]);
    const upx = gl > 0 ? -o.gravity[0] / gl : 0, upy = gl > 0 ? -o.gravity[1] / gl : 0, upz = gl > 0 ? -o.gravity[2] / gl : 0;
    const hc = (cx: number, cy: number, cz: number, mask: number) => ((Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663) ^ Math.imul(cz, 83492791)) >>> 0) & mask;
    if (!this.corners || this.corners.col !== col) {
      // point → triangles, and a hash of the usable corners (cells 1.5 edges wide)
      const start = new Int32Array(n + 1);
      for (let k = 0; k < tris.length; k++) start[tris[k] + 1]++;
      for (let i = 0; i < n; i++) start[i + 1] += start[i];
      const tri = new Int32Array(tris.length), fill = start.slice(0, n);
      for (let k = 0; k < tris.length; k++) tri[fill[tris[k]]++] = (k / 3) | 0;
      const use: number[] = [];
      for (let s = 0; s < ns; s++) if (gl === 0 || SN[s * 3] * upx + SN[s * 3 + 1] * upy + SN[s * 3 + 2] * upz > 0.2) use.push(s);
      let size = 1;
      while (size < use.length * 2) size <<= 1;
      const mask = size - 1, inv = 1 / (1.5 * edge), cst = new Int32Array(size + 1), cell = new Int32Array(use.length);
      for (let k = 0; k < use.length; k++) {
        const s = use[k];
        cell[k] = hc(Math.floor(SP[s * 3] * inv), Math.floor(SP[s * 3 + 1] * inv), Math.floor(SP[s * 3 + 2] * inv), mask);
        cst[cell[k] + 1]++;
      }
      for (let k = 0; k < size; k++) cst[k + 1] += cst[k];
      const cfill = cst.slice(0, size), cent = new Int32Array(use.length);
      for (let k = 0; k < use.length; k++) cent[cfill[cell[k]]++] = use[k];
      this.corners = { col, start, tri, stamp: new Int32Array(nt).fill(-1), cst, cent, mask, inv, best: new Float64Array(ns), finder: new Int32Array(ns).fill(-1) };
    }
    const K = this.corners, cf = this.cf, cn = this.cn, cp = this.cp;
    if (!K.cent.length) return;
    // each corner's nearest cloth point that has a collider contact plane within reach
    const r = 1.5 * edge, r2 = r * r, found: number[] = [];
    for (let i = 0; i < n; i++) {
      if (!cf[i] || this.w[i] === 0) continue;
      const xo = i * 3;
      if ((x[xo] - cp[xo]) * cn[xo] + (x[xo + 1] - cp[xo + 1]) * cn[xo + 1] + (x[xo + 2] - cp[xo + 2]) * cn[xo + 2] > th + edge) continue;
      const gx = Math.floor(x[xo] * K.inv), gy = Math.floor(x[xo + 1] * K.inv), gz = Math.floor(x[xo + 2] * K.inv);
      for (let dz = -1; dz <= 1; dz++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const h = hc(gx + dx, gy + dy, gz + dz, K.mask);
            for (let e = K.cst[h]; e < K.cst[h + 1]; e++) {
              const s = K.cent[e];
              const ex = x[xo] - SP[s * 3], ey = x[xo + 1] - SP[s * 3 + 1], ez = x[xo + 2] - SP[s * 3 + 2];
              const d2 = ex * ex + ey * ey + ez * ez;
              if (d2 >= r2) continue;
              if (K.finder[s] < 0) { found.push(s); K.finder[s] = i; K.best[s] = d2; }
              else if (d2 < K.best[s]) { K.finder[s] = i; K.best[s] = d2; }
            }
          }
    }
    found.sort((a, b) => a - b);
    const { start, tri, stamp } = K, reach = 2 * th + 0.5 * edge;
    const kt: number[] = [], kb: number[] = [], kc: number[] = [], kn: number[] = [];
    for (const s of found) {
      const p0 = K.finder[s];
      K.finder[s] = -1;
      const cx = SP[s * 3], cy = SP[s * 3 + 1], cz = SP[s * 3 + 2], nx0 = SN[s * 3], ny0 = SN[s * 3 + 1], nz0 = SN[s * 3 + 2];
      const sid = ++this.kStamp;
      let best = -1, bestH = Infinity, b0 = 0, b1 = 0, b2 = 0;
      // triangles of the 2-ring around the finder point
      for (let e0 = start[p0]; e0 < start[p0 + 1]; e0++) {
        const t0 = tri[e0];
        for (let k0 = 0; k0 < 3; k0++) {
          const q = tris[t0 * 3 + k0];
          for (let e = start[q]; e < start[q + 1]; e++) {
            const t = tri[e];
            if (stamp[t] === sid) continue;
            stamp[t] = sid;
            const a = tris[t * 3] * 3, b = tris[t * 3 + 1] * 3, c = tris[t * 3 + 2] * 3;
            const ux = x[b] - x[a], uy = x[b + 1] - x[a + 1], uz = x[b + 2] - x[a + 2];
            const vx = x[c] - x[a], vy = x[c + 1] - x[a + 1], vz = x[c + 2] - x[a + 2];
            let tx = uy * vz - uz * vy, ty = uz * vx - ux * vz, tz = ux * vy - uy * vx;
            const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
            if (!(tl > 1e-300)) continue;
            tx /= tl; ty /= tl; tz /= tl;
            const facing = tx * nx0 + ty * ny0 + tz * nz0;
            if (facing < 0) { tx = -tx; ty = -ty; tz = -tz; }
            if (Math.abs(facing) < 0.3) continue;
            // the triangle's plane must lie in front of the corner (along the oriented normal), within reach
            const wx = cx - x[a], wy = cy - x[a + 1], wz = cz - x[a + 2];
            const hgt = -(wx * tx + wy * ty + wz * tz);
            if (hgt < -th || hgt > reach || Math.abs(hgt) >= bestH) continue;
            // the corner's projection onto the plane, in barycentrics, inside the triangle
            const d00 = ux * ux + uy * uy + uz * uz, d01 = ux * vx + uy * vy + uz * vz, d11 = vx * vx + vy * vy + vz * vz;
            const d20 = wx * ux + wy * uy + wz * uz, d21 = wx * vx + wy * vy + wz * vz, den = d00 * d11 - d01 * d01;
            if (!(den > 0)) continue;
            const q1 = (d11 * d20 - d01 * d21) / den, q2 = (d00 * d21 - d01 * d20) / den, q0 = 1 - q1 - q2;
            if (q0 < 0 || q1 < 0 || q2 < 0) continue;
            best = t; bestH = Math.abs(hgt); b0 = q0; b1 = q1; b2 = q2;
          }
        }
      }
      if (best < 0) continue;
      kt.push(best); kb.push(b0, b1, b2); kc.push(cx, cy, cz); kn.push(nx0, ny0, nz0);
    }
    this.kT = Int32Array.from(kt); this.kB = Float64Array.from(kb); this.kC = Float64Array.from(kc); this.kN = Float64Array.from(kn);
    this.kCount = kt.length;
  }

  /** Coulomb friction from the contact corrections of this substep (static below friction × depth, else kinetic). */
  private applyFriction() {
    const mu = this.o.friction, x = this.x, xp = this.xp, n = this.n, cn = this.cn, penC = this.penC, penF = this.penF;
    for (let i = 0; i < n; i++) {
      const k = i * 3;
      if (penF[i] > 0) {
        // floor: tangential = xz
        const dx = x[k] - xp[k], dz = x[k + 2] - xp[k + 2];
        const l = Math.sqrt(dx * dx + dz * dz), lim = mu * penF[i];
        if (l > 0) {
          const f = l <= lim ? 1 : lim / l;
          x[k] -= dx * f; x[k + 2] -= dz * f;
        }
      }
      if (penC[i] > 0) {
        const nx = cn[k], ny = cn[k + 1], nz = cn[k + 2];
        const dx = x[k] - xp[k], dy = x[k + 1] - xp[k + 1], dz = x[k + 2] - xp[k + 2];
        const dn = dx * nx + dy * ny + dz * nz;
        const tx = dx - dn * nx, ty = dy - dn * ny, tz = dz - dn * nz;
        const l = Math.sqrt(tx * tx + ty * ty + tz * tz), lim = mu * penC[i];
        if (l > 0) {
          const f = l <= lim ? 1 : lim / l;
          x[k] -= tx * f; x[k + 1] -= ty * f; x[k + 2] -= tz * f;
        }
      }
    }
  }

  /** True when every position and velocity is finite. */
  finite(): boolean {
    const x = this.x, v = this.v;
    for (let i = 0; i < x.length; i++) if (!Number.isFinite(x[i]) || !Number.isFinite(v[i])) return false;
    return true;
  }

  /** Current volume of the closed triangulation (signed like the rest volume). */
  volume(): number {
    return this.vSign * meshVolume(this.x, this.m.tris);
  }
}
