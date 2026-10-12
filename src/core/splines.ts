// Spline primitives: Bezier and NURBS curves (Houdini's BezierCurve / NURBCurve prims).
//
// Storage (see the comment at the top of geometry.ts): primKind 2 = Bezier, 3 = NURBS; the prim's vertices are its
// control points (CVs) in order; primClosed; prim int "spline_order" (degree + 1, default 4); NURBS knots in the prim
// float[] "knots"; rational weights in the point float "Pw" (default 1).
//
// Bezier: segments of `order` CVs that share their end CVs, as in Houdini: an open curve with 7 CVs and order 4 has
// two cubic segments (CVs 0-3 and 3-6). A closed curve wraps (its last segment ends on CV 0), so it has
// segments × (order - 1) CVs. A CV count that does not fit ends in a lower-degree segment. The global parameter
// u ∈ [0, 1] is split evenly between the segments.
//
// NURBS: an open curve has n + order knots (default: clamped, so it starts and ends on its first and last CV). A closed
// curve is periodic and stores n + 1 breakpoints b0 ≤ … ≤ bn (period bn − b0); CV i influences the spans
// [b(i−degree), b(i+1)] cyclically. A knot vector that does not fit (wrong length, decreasing, empty domain) is replaced
// by a uniform one with a note. u ∈ [0, 1] maps linearly onto the knot domain.
//
// Evaluation: de Casteljau for Bezier segments and de Boor for NURBS, in homogeneous coordinates (weights);
// derivatives from the B-spline basis derivatives (quotient rule for rational curves); arc length by Gauss–Legendre
// quadrature per knot span; closest point by coarse sampling + Newton; polylines by adaptive subdivision until every
// chord is within a tolerance of the curve. Conversions are exact (Bezier → NURBS by multiple knots and degree
// elevation, NURBS → Bezier by blossoming). Fitting: global interpolation and least-squares approximation (ends kept,
// optional smoothing, parameter correction) through a profile Cholesky solve of the normal equations, which handles
// open (banded) and closed (cyclic) curves alike.
import { GeoBuilder, Geometry } from './geometry.ts';
import type { Src } from './geometry.ts';
import type { Vec3 } from './math.ts';

export const KIND_PACKED = 1;
export const KIND_BEZIER = 2;
export const KIND_NURBS = 3;
export type SplineType = 'bezier' | 'nurbs';
export const ORDER_ATTRIB = 'spline_order';
export const KNOTS_ATTRIB = 'knots';
export const WEIGHT_ATTRIB = 'Pw';
export const DEFAULT_ORDER = 4;
export const MAX_ORDER = 11;
export type Parameterization = 'uniform' | 'chord' | 'centripetal';
export const PARAMETERIZATIONS: Parameterization[] = ['uniform', 'chord', 'centripetal'];

/** Prim kind number of a spline type. */
export const kindOf = (t: SplineType) => (t === 'bezier' ? KIND_BEZIER : KIND_NURBS);
/** Spline type of a prim kind (null for polygons/polylines and packed prims). */
export const typeOfKind = (k: number): SplineType | null => (k === KIND_BEZIER ? 'bezier' : k === KIND_NURBS ? 'nurbs' : null);

/** One B-spline piece: a NURBS curve, or one Bezier segment (clamped knots 0…0 1…1). */
interface Piece {
  /** degree */
  p: number;
  /** homogeneous CVs (x·w, y·w, z·w, w) */
  H: Float64Array;
  /** knot vector, (number of CVs) + p + 1 entries */
  U: Float64Array;
  /** parameter domain [a, b] */
  a: number;
  b: number;
  /** index of each piece CV in the curve's CV list (closed NURBS wrap around) */
  cv: Int32Array;
  /** global u range of the piece */
  u0: number;
  u1: number;
  bezier: boolean;
}

/** A curve ready for evaluation (see makeSpline / splineFromPrim). */
export interface Spline {
  type: SplineType;
  /** effective order (lower than requested when there are too few CVs) */
  order: number;
  closed: boolean;
  /** number of CVs */
  n: number;
  /** CV positions, 3 per CV */
  P: Float64Array;
  /** CV weights */
  W: Float64Array;
  /** NURBS: the knot vector in storage form (n + order open, n + 1 closed); Bezier: empty */
  knots: Float64Array;
  rational: boolean;
  /** problems found and fixed (knots regenerated, order lowered, …) */
  notes: string[];
  pieces: Piece[];
}

export interface SplineInit {
  order?: number;
  closed?: boolean;
  /** one weight per CV (default 1) */
  weights?: ArrayLike<number> | null;
  /** NURBS knot vector in storage form; null/empty or invalid = uniform (clamped for open curves) */
  knots?: ArrayLike<number> | null;
}

// ---------------------------------------------------------------- construction

const clampOrder = (o: number) => Math.max(2, Math.min(MAX_ORDER, Math.round(Number.isFinite(o) ? o : DEFAULT_ORDER)));

/** Clamped uniform knot vector on [0, 1] for n CVs of degree p (n + p + 1 knots). */
export function clampedUniformKnots(n: number, p: number): Float64Array {
  const U = new Float64Array(n + p + 1);
  const spans = n - p;
  for (let i = 0; i < U.length; i++) U[i] = i <= p ? 0 : i >= n ? 1 : (i - p) / spans;
  return U;
}

/** Uniform breakpoints 0, 1/n, …, 1 for a closed NURBS with n CVs. */
export function uniformBreakpoints(n: number): Float64Array {
  return Float64Array.from({ length: n + 1 }, (_, i) => i / n);
}

function validKnots(K: ArrayLike<number> | null | undefined, len: number, lo: number, hi: number): boolean {
  if (!K || K.length !== len) return false;
  for (let i = 0; i < len; i++) if (!Number.isFinite(K[i]) || (i && K[i] < K[i - 1])) return false;
  return K[lo] < K[hi];
}

/** The full (periodic) knot vector of a closed NURBS from its n + 1 breakpoints (n + 2p + 1 knots). */
function periodicKnots(b: ArrayLike<number>, n: number, p: number): Float64Array {
  const U = new Float64Array(n + 2 * p + 1), T = b[n] - b[0];
  for (let j = 0; j <= n; j++) U[j + p] = b[j];
  for (let k = 1; k <= p; k++) { U[p - k] = b[n - k] - T; U[n + p + k] = b[k] + T; }
  return U;
}

function homogeneous(P: Float64Array, W: Float64Array, idx: ArrayLike<number>): Float64Array {
  const H = new Float64Array(idx.length * 4);
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k], w = W[i];
    H[k * 4] = P[i * 3] * w; H[k * 4 + 1] = P[i * 3 + 1] * w; H[k * 4 + 2] = P[i * 3 + 2] * w; H[k * 4 + 3] = w;
  }
  return H;
}

/** Bezier segments as CV index lists (Houdini layout, see the file comment). */
export function bezierSegments(n: number, p: number, closed: boolean): number[][] {
  const segs: number[][] = [];
  if (n < 2 || p < 1) return segs;
  if (!closed) {
    for (let i = 0; i < n - 1;) {
      const e = Math.min(i + p, n - 1), s: number[] = [];
      for (let j = i; j <= e; j++) s.push(j);
      segs.push(s);
      i = e;
    }
  } else {
    for (let i = 0; i < n;) {
      const e = Math.min(i + p, n), s: number[] = [];
      for (let j = i; j <= e; j++) s.push(j % n);
      segs.push(s);
      i = e;
    }
  }
  return segs;
}

/** A spline from CV positions (3 numbers per CV). */
export function makeSpline(type: SplineType, P: ArrayLike<number>, o: SplineInit = {}): Spline {
  const n = Math.floor(P.length / 3);
  const Pc = Float64Array.from({ length: n * 3 }, (_, i) => +P[i]);
  const W = new Float64Array(n).fill(1);
  const notes: string[] = [];
  let rational = false;
  if (o.weights) {
    let bad = 0;
    for (let i = 0; i < n; i++) {
      const w = Number(o.weights[i] ?? 1);
      if (!(w > 1e-12) || !Number.isFinite(w)) { bad++; W[i] = 1e-12; } else W[i] = w;
      if (W[i] !== 1) rational = true;
    }
    if (bad) notes.push(`${bad} non-positive weight(s) raised to 1e-12`);
  }
  const closed = !!o.closed && n >= 3;
  let order = clampOrder(o.order ?? DEFAULT_ORDER);
  const s: Spline = { type, order, closed, n, P: Pc, W, knots: new Float64Array(0), rational, notes, pieces: [] };
  if (n === 0) return s;
  if (n === 1) {
    s.pieces.push({ p: 0, H: homogeneous(Pc, W, [0]), U: Float64Array.of(0, 1), a: 0, b: 1, cv: Int32Array.of(0), u0: 0, u1: 1, bezier: true });
    return s;
  }
  if (type === 'bezier') {
    const p = order - 1;
    const segs = bezierSegments(n, p, closed);
    const S = segs.length;
    const want = closed ? S * p : S * p + 1;
    if (want !== n || segs.some((g) => g.length !== p + 1))
      notes.push(`Bezier with ${n} CVs does not fit order ${order} (${closed ? 'closed: a multiple of ' + p : 'open: ' + p + '·segments + 1'}); the last segment has degree ${segs[S - 1].length - 1}`);
    segs.forEach((seg, k) => {
      const d = seg.length - 1;
      const U = new Float64Array(2 * d + 2);
      U.fill(1, d + 1);
      s.pieces.push({ p: d, H: homogeneous(Pc, W, seg), U, a: 0, b: 1, cv: Int32Array.from(seg), u0: k / S, u1: (k + 1) / S, bezier: true });
    });
    return s;
  }
  // NURBS
  let p = order - 1;
  if (p > n - 1) { p = n - 1; notes.push(`order ${order} needs at least ${order} CVs: lowered to ${p + 1}`); }
  s.order = order = p + 1;
  if (!closed) {
    const K = o.knots && o.knots.length ? o.knots : null;
    let U: Float64Array;
    if (validKnots(K, n + p + 1, p, n)) U = Float64Array.from(K!);
    else {
      if (K) notes.push(`knots: ${K.length} values do not form a valid open knot vector of ${n + p + 1} (n + order); using uniform clamped knots`);
      U = clampedUniformKnots(n, p);
    }
    s.knots = U;
    s.pieces.push({ p, H: homogeneous(Pc, W, Int32Array.from({ length: n }, (_, i) => i)), U, a: U[p], b: U[n], cv: Int32Array.from({ length: n }, (_, i) => i), u0: 0, u1: 1, bezier: false });
  } else {
    const K = o.knots && o.knots.length ? o.knots : null;
    let b: Float64Array;
    let ok = validKnots(K, n + 1, 0, n);
    if (ok) {
      // a breakpoint repeated more than p + 1 times would leave a span without support
      let run = 1;
      for (let i = 1; i <= n && ok; i++) { run = K![i] === K![i - 1] ? run + 1 : 1; if (run > p + 1) ok = false; }
    }
    if (ok) b = Float64Array.from(K!);
    else {
      if (K) notes.push(`knots: ${K.length} values do not form valid closed breakpoints (n + 1 = ${n + 1}, increasing); using uniform ones`);
      b = uniformBreakpoints(n);
    }
    s.knots = b;
    const cv = Int32Array.from({ length: n + p }, (_, i) => i % n);
    const U = periodicKnots(b, n, p);
    s.pieces.push({ p, H: homogeneous(Pc, W, cv), U, a: b[0], b: b[n], cv, u0: 0, u1: 1, bezier: false });
  }
  return s;
}

// ---------------------------------------------------------------- evaluation kernels

/** Knot span k with U[k] ≤ t < U[k+1] (the last non-empty span at the end of the domain). */
function findSpan(pc: Piece, t: number): number {
  const U = pc.U, p = pc.p, ncv = U.length - p - 1;
  if (p === 0) return 0;
  if (t >= U[ncv]) {
    let k = ncv - 1;
    while (k > p && !(U[k] < U[k + 1])) k--;
    return k;
  }
  if (t <= U[p]) {
    let k = p;
    while (k < ncv - 1 && !(U[k] < U[k + 1])) k++;
    return k;
  }
  let lo = p, hi = ncv;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t < U[mid]) hi = mid; else lo = mid;
  }
  return lo;
}

const scratch = new Float64Array(4 * (MAX_ORDER + 1));

/** Point of a piece at parameter t (homogeneous de Boor / de Casteljau), into out[0..3). */
function pieceDeBoor(pc: Piece, t: number, out: number[] | Float64Array) {
  const p = pc.p, H = pc.H, d = scratch;
  if (pc.bezier) {
    for (let j = 0; j < (p + 1) * 4; j++) d[j] = H[j];
    const s = 1 - t;
    for (let r = 1; r <= p; r++)
      for (let j = 0; j <= p - r; j++) for (let c = 0; c < 4; c++) d[j * 4 + c] = s * d[j * 4 + c] + t * d[(j + 1) * 4 + c];
    const w = d[3] || 1e-300;
    out[0] = d[0] / w; out[1] = d[1] / w; out[2] = d[2] / w;
    return;
  }
  const U = pc.U, k = findSpan(pc, t);
  for (let j = 0; j <= p; j++) for (let c = 0; c < 4; c++) d[j * 4 + c] = H[(k - p + j) * 4 + c];
  for (let r = 1; r <= p; r++)
    for (let j = p; j >= r; j--) {
      const i = k - p + j, den = U[i + p + 1 - r] - U[i];
      const al = den > 0 ? (t - U[i]) / den : 0;
      for (let c = 0; c < 4; c++) d[j * 4 + c] = (1 - al) * d[(j - 1) * 4 + c] + al * d[j * 4 + c];
    }
  const w = d[p * 4 + 3] || 1e-300;
  out[0] = d[p * 4] / w; out[1] = d[p * 4 + 1] / w; out[2] = d[p * 4 + 2] / w;
}

const MAXP1 = MAX_ORDER + 1;
const NDU = new Float64Array(MAXP1 * MAXP1), LEFT = new Float64Array(MAXP1), RIGHT = new Float64Array(MAXP1);
const AA = new Float64Array(2 * MAXP1), DERS = new Float64Array(3 * MAXP1);

/**
 * B-spline basis functions and their derivatives up to nd (≤ 2) at t in span k (Piegl & Tiller A2.3), into a shared
 * scratch buffer: derivative d of basis j (the CV k - p + j) is at [d * MAXP1 + j]. Read it before the next call.
 */
function dersBasis(pc: Piece, k: number, t: number, nd: number): Float64Array {
  const p = pc.p, U = pc.U, P1 = MAXP1;
  const ndu = NDU, left = LEFT, right = RIGHT, ders = DERS, a = AA;
  ndu[0] = 1;
  for (let j = 1; j <= p; j++) {
    left[j] = t - U[k + 1 - j];
    right[j] = U[k + j] - t;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const v = right[r + 1] + left[j - r];
      ndu[j * P1 + r] = v;
      const tmp = v !== 0 ? ndu[r * P1 + j - 1] / v : 0;
      ndu[r * P1 + j] = saved + right[r + 1] * tmp;
      saved = left[j - r] * tmp;
    }
    ndu[j * P1 + j] = saved;
  }
  for (let j = 0; j <= p; j++) ders[j] = ndu[j * P1 + p];
  for (let r = 0; r <= p; r++) {
    let s1 = 0, s2 = P1;
    a[0] = 1;
    for (let kk = 1; kk <= nd; kk++) {
      let d = 0;
      const rk = r - kk, pk = p - kk;
      if (r >= kk) {
        const den = ndu[(pk + 1) * P1 + rk];
        a[s2] = den !== 0 ? a[s1] / den : 0;
        d = a[s2] * ndu[rk * P1 + pk];
      }
      const j1 = rk >= -1 ? 1 : -rk, j2 = r - 1 <= pk ? kk - 1 : p - r;
      for (let j = j1; j <= j2; j++) {
        const den = ndu[(pk + 1) * P1 + rk + j];
        a[s2 + j] = den !== 0 ? (a[s1 + j] - a[s1 + j - 1]) / den : 0;
        d += a[s2 + j] * ndu[(rk + j) * P1 + pk];
      }
      if (r <= pk) {
        const den = ndu[(pk + 1) * P1 + r];
        a[s2 + kk] = den !== 0 ? -a[s1 + kk - 1] / den : 0;
        d += a[s2 + kk] * ndu[r * P1 + pk];
      }
      ders[kk * P1 + r] = d;
      const tmp = s1; s1 = s2; s2 = tmp;
    }
  }
  let f = p;
  for (let kk = 1; kk <= nd; kk++) {
    for (let j = 0; j <= p; j++) ders[kk * P1 + j] *= f;
    f *= p - kk;
  }
  return ders;
}

interface Located { pc: Piece; t: number; dtdu: number }

function locate(s: Spline, u: number): Located {
  if (s.closed) { if (u < 0 || u > 1) u -= Math.floor(u); }
  else u = u < 0 ? 0 : u > 1 ? 1 : u;
  const ps = s.pieces;
  let k = 0;
  if (ps.length > 1) k = Math.min(ps.length - 1, Math.max(0, Math.floor(u * ps.length)));
  const pc = ps[k];
  const du = pc.u1 - pc.u0;
  const t = pc.a + ((u - pc.u0) / du) * (pc.b - pc.a);
  return { pc, t: Math.min(pc.b, Math.max(pc.a, t)), dtdu: (pc.b - pc.a) / du };
}

// ---------------------------------------------------------------- public evaluation

/** Point at global parameter u ∈ [0, 1]. */
export function evalPoint(s: Spline, u: number, out: number[] = [0, 0, 0]): number[] {
  if (!s.pieces.length) { out[0] = out[1] = out[2] = 0; return out; }
  const L = locate(s, u);
  pieceDeBoor(L.pc, L.t, out);
  return out;
}

const DV = new Float64Array(9);

/** Point (DV[0..3)), first (DV[3..6)) and, with nd 2, second derivative (DV[6..9)) with respect to u, into DV. */
function derivs(s: Spline, u: number, nd: 1 | 2): Float64Array {
  const out = DV;
  out.fill(0);
  if (!s.pieces.length) return out;
  const { pc, t, dtdu } = locate(s, u);
  const p = pc.p;
  if (p === 0) { pieceDeBoor(pc, t, out); return out; }
  const k = pc.bezier ? p : findSpan(pc, t);
  const n = Math.min(nd, p);
  const D = dersBasis(pc, k, t, n), H = pc.H;
  let x0 = 0, y0 = 0, z0 = 0, w0 = 0, x1 = 0, y1 = 0, z1 = 0, w1 = 0, x2 = 0, y2 = 0, z2 = 0, w2 = 0;
  for (let j = 0; j <= p; j++) {
    const o = (k - p + j) * 4, hx = H[o], hy = H[o + 1], hz = H[o + 2], hw = H[o + 3];
    const N0 = D[j], N1 = D[MAXP1 + j];
    x0 += N0 * hx; y0 += N0 * hy; z0 += N0 * hz; w0 += N0 * hw;
    x1 += N1 * hx; y1 += N1 * hy; z1 += N1 * hz; w1 += N1 * hw;
    if (n > 1) { const N2 = D[2 * MAXP1 + j]; x2 += N2 * hx; y2 += N2 * hy; z2 += N2 * hz; w2 += N2 * hw; }
  }
  if (!(w0 !== 0)) w0 = 1e-300;
  const px = x0 / w0, py = y0 / w0, pz = z0 / w0;
  const d1x = (x1 - w1 * px) / w0, d1y = (y1 - w1 * py) / w0, d1z = (z1 - w1 * pz) / w0;
  out[0] = px; out[1] = py; out[2] = pz;
  out[3] = d1x * dtdu; out[4] = d1y * dtdu; out[5] = d1z * dtdu;
  if (nd > 1) {
    const s2 = dtdu * dtdu;
    out[6] = ((x2 - 2 * w1 * d1x - w2 * px) / w0) * s2;
    out[7] = ((y2 - 2 * w1 * d1y - w2 * py) / w0) * s2;
    out[8] = ((z2 - 2 * w1 * d1z - w2 * pz) / w0) * s2;
  }
  return out;
}

/** Point, first and second derivative with respect to u ∈ [0, 1]. */
export function evalDerivs(s: Spline, u: number): { P: Vec3; d1: Vec3; d2: Vec3 } {
  const D = derivs(s, u, 2);
  return { P: [D[0], D[1], D[2]], d1: [D[3], D[4], D[5]], d2: [D[6], D[7], D[8]] };
}

/** Unit tangent at u (zero vector where the curve stops, e.g. on a doubled CV). */
export function tangentAt(s: Spline, u: number): Vec3 {
  const { d1 } = evalDerivs(s, u);
  const l = Math.hypot(d1[0], d1[1], d1[2]);
  return l > 1e-14 ? [d1[0] / l, d1[1] / l, d1[2] / l] : [0, 0, 0];
}

/** Curvature 1/R at u: |C' × C''| / |C'|³. */
export function curvatureAt(s: Spline, u: number): number {
  const { d1, d2 } = evalDerivs(s, u);
  const cx = d1[1] * d2[2] - d1[2] * d2[1], cy = d1[2] * d2[0] - d1[0] * d2[2], cz = d1[0] * d2[1] - d1[1] * d2[0];
  const l = Math.hypot(d1[0], d1[1], d1[2]);
  return l > 1e-14 ? Math.hypot(cx, cy, cz) / (l * l * l) : 0;
}

/**
 * Point at u plus the rational basis weights of the CVs that shape it (CV indices and weights summing to 1): the
 * provenance used to interpolate CV attributes along the curve.
 */
export function evalBasis(s: Spline, u: number): { P: number[]; idx: number[]; w: number[] } {
  if (!s.pieces.length) return { P: [0, 0, 0], idx: [], w: [] };
  const { pc, t } = locate(s, u);
  const p = pc.p;
  const P = [0, 0, 0];
  pieceDeBoor(pc, t, P);
  if (p === 0) return { P, idx: [pc.cv[0]], w: [1] };
  const k = pc.bezier ? p : findSpan(pc, t);
  const N = dersBasis(pc, k, t, 0);
  const idx: number[] = [], w: number[] = [];
  let sum = 0;
  for (let j = 0; j <= p; j++) { const x = N[j] * pc.H[(k - p + j) * 4 + 3]; sum += x; }
  for (let j = 0; j <= p; j++) {
    const x = (N[j] * pc.H[(k - p + j) * 4 + 3]) / (sum || 1);
    if (x === 0) continue;
    idx.push(pc.cv[k - p + j]); w.push(x);
  }
  return { P, idx, w };
}

/** Global u values of the span boundaries (knot spans, Bezier segments), sorted, from 0 to 1. */
export function spanBreaks(s: Spline): number[] {
  const out: number[] = [0];
  for (const pc of s.pieces) {
    if (pc.bezier || pc.p === 0) { out.push(pc.u1); continue; }
    const U = pc.U, scaleU = (pc.u1 - pc.u0) / (pc.b - pc.a);
    let last = pc.a;
    for (let i = 0; i < U.length; i++) {
      const t = U[i];
      if (t > last && t < pc.b) { out.push(pc.u0 + (t - pc.a) * scaleU); last = t; }
    }
    out.push(pc.u1);
  }
  out[out.length - 1] = 1;
  return out;
}

// ---------------------------------------------------------------- arc length

const GLX = [-0.906179845938664, -0.5384693101056831, 0, 0.5384693101056831, 0.906179845938664];
const GLW = [0.23692688505618908, 0.47862867049936647, 0.5688888888888889, 0.47862867049936647, 0.23692688505618908];

/** |dC/du| at u. */
export function speedAt(s: Spline, u: number): number {
  const D = derivs(s, u, 1);
  return Math.sqrt(D[3] * D[3] + D[4] * D[4] + D[5] * D[5]);
}

function gl5(s: Spline, u0: number, u1: number): number {
  const h = (u1 - u0) / 2, m = (u1 + u0) / 2;
  let acc = 0;
  for (let i = 0; i < 5; i++) acc += GLW[i] * speedAt(s, m + h * GLX[i]);
  return acc * h;
}

export interface ArcTable {
  /** global u of the table nodes (span boundaries subdivided) */
  u: Float64Array;
  /** arc length from u = 0 to each node */
  s: Float64Array;
  total: number;
}

/** Cumulative arc length table: each span split in `sub` intervals, each integrated with 5-point Gauss–Legendre. */
export function arcTable(s: Spline, sub = 8): ArcTable {
  const br = spanBreaks(s);
  const us: number[] = [0];
  for (let i = 0; i + 1 < br.length; i++) for (let k = 1; k <= sub; k++) us.push(br[i] + ((br[i + 1] - br[i]) * k) / sub);
  const u = Float64Array.from(us), L = new Float64Array(u.length);
  for (let i = 1; i < u.length; i++) L[i] = L[i - 1] + (u[i] > u[i - 1] ? gl5(s, u[i - 1], u[i]) : 0);
  return { u, s: L, total: L[L.length - 1] };
}

/** Arc length of the whole curve. */
export function arcLength(s: Spline): number {
  return arcTable(s).total;
}

/** Global u at arc length len from the start (safeguarded Newton inside the table interval). */
export function uAtLength(s: Spline, tab: ArcTable, len: number): number {
  const { u, s: L, total } = tab;
  if (!(len > 0)) return 0;
  if (len >= total) return 1;
  let lo = 0, hi = L.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (L[mid] <= len) lo = mid; else hi = mid; }
  const u0 = u[lo], s0 = L[lo], seg = L[hi] - s0;
  let a = u0, b = u[hi];
  let x = seg > 0 ? u0 + ((b - u0) * (len - s0)) / seg : u0;
  for (let it = 0; it < 12; it++) {
    const f = s0 + (x > u0 ? gl5(s, u0, x) : 0) - len;
    if (Math.abs(f) <= 1e-13 * Math.max(1, total)) break;
    if (f > 0) b = x; else a = x;
    const sp = speedAt(s, x);
    let nx = sp > 1e-14 ? x - f / sp : (a + b) / 2;
    if (!(nx > a && nx < b)) nx = (a + b) / 2;
    if (Math.abs(nx - x) < 1e-15) break;
    x = nx;
  }
  return x;
}

/** Arc length from u = 0 to u. */
export function lengthAtU(s: Spline, tab: ArcTable, u: number): number {
  if (!(u > 0)) return 0;
  if (u >= 1) return tab.total;
  const U = tab.u;
  let lo = 0, hi = U.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (U[mid] <= u) lo = mid; else hi = mid; }
  return tab.s[lo] + (u > U[lo] ? gl5(s, U[lo], u) : 0);
}

/**
 * Global u of nseg + 1 points evenly spaced by arc length (closed curves: nseg points, the last segment returns to
 * the start), with the arc length of each and the total.
 */
export function samplesByLength(s: Spline, nseg: number): { u: number[]; len: number[]; total: number } {
  const tab = arcTable(s), total = tab.total, cnt = s.closed ? nseg : nseg + 1;
  const u: number[] = [], len: number[] = [];
  for (let i = 0; i < cnt; i++) {
    const L = (total * i) / nseg;
    u.push(i === 0 ? 0 : !s.closed && i === nseg ? 1 : uAtLength(s, tab, L));
    len.push(L);
  }
  return { u, len, total };
}

/**
 * The natural parameter of CV k (global u): its Greville abscissa (the average of the degree knots it spans) for
 * NURBS, its place within its segment for Bezier curves. Curve attributes on CVs are evaluated there.
 */
export function grevilleU(s: Spline, k: number): number {
  for (const pc of s.pieces) {
    if (pc.bezier || pc.p === 0) {
      const j = Array.prototype.indexOf.call(pc.cv, k);
      if (j >= 0) return pc.p ? pc.u0 + (j / pc.p) * (pc.u1 - pc.u0) : pc.u0;
      continue;
    }
    const p = pc.p, U = pc.U;
    let t = 0;
    for (let i = k + 1; i <= k + p; i++) t += U[i];
    t /= p;
    const T = pc.b - pc.a;
    if (s.closed) t = pc.a + ((((t - pc.a) % T) + T) % T);
    return Math.min(1, Math.max(0, (t - pc.a) / T));
  }
  return 0;
}

// ---------------------------------------------------------------- closest point

/** Closest point of the curve to q: global u, position and distance (coarse samples per span + Newton). */
export function closestPoint(s: Spline, q: ArrayLike<number>, samplesPerSpan = 8): { u: number; P: number[]; dist: number } {
  if (!s.pieces.length) return { u: 0, P: [0, 0, 0], dist: Infinity };
  const br = spanBreaks(s);
  const cand: { u: number; d: number }[] = [];
  const tmp = [0, 0, 0];
  for (let i = 0; i + 1 < br.length; i++)
    for (let k = 0; k <= samplesPerSpan; k++) {
      if (k === samplesPerSpan && i + 2 < br.length) continue;
      const u = br[i] + ((br[i + 1] - br[i]) * k) / samplesPerSpan;
      evalPoint(s, u, tmp);
      cand.push({ u, d: Math.hypot(tmp[0] - q[0], tmp[1] - q[1], tmp[2] - q[2]) });
    }
  cand.sort((x, y) => x.d - y.d);
  let best = { u: cand[0].u, P: evalPoint(s, cand[0].u), dist: cand[0].d };
  for (const c of cand.slice(0, 3)) {
    let u = c.u;
    for (let it = 0; it < 24; it++) {
      const { P, d1, d2 } = evalDerivs(s, u);
      const r0 = P[0] - q[0], r1 = P[1] - q[1], r2 = P[2] - q[2];
      const f = d1[0] * r0 + d1[1] * r1 + d1[2] * r2;
      const fp = d2[0] * r0 + d2[1] * r1 + d2[2] * r2 + d1[0] * d1[0] + d1[1] * d1[1] + d1[2] * d1[2];
      if (!(fp > 1e-300)) break;
      let nu = u - f / fp;
      if (s.closed) nu -= Math.floor(nu); else nu = Math.min(1, Math.max(0, nu));
      if (Math.abs(nu - u) < 1e-15) { u = nu; break; }
      u = nu;
    }
    const P = evalPoint(s, u), d = Math.hypot(P[0] - q[0], P[1] - q[1], P[2] - q[2]);
    if (d < best.dist) best = { u, P, dist: d };
  }
  return best;
}

// ---------------------------------------------------------------- polylines

export interface PolylineOptions {
  /** > 0: this many segments per span (knot span or Bezier segment), evenly in parameter */
  segments?: number;
  /** adaptive: maximum distance between the curve and its chords (default defaultTolerance) */
  tolerance?: number;
}

/** Default polyline tolerance: 5e-4 of the CV bounding box diagonal. */
export function defaultTolerance(s: Spline): number {
  const P = s.P;
  let mn0 = Infinity, mn1 = Infinity, mn2 = Infinity, mx0 = -Infinity, mx1 = -Infinity, mx2 = -Infinity;
  for (let i = 0; i < P.length; i += 3) {
    mn0 = Math.min(mn0, P[i]); mx0 = Math.max(mx0, P[i]);
    mn1 = Math.min(mn1, P[i + 1]); mx1 = Math.max(mx1, P[i + 1]);
    mn2 = Math.min(mn2, P[i + 2]); mx2 = Math.max(mx2, P[i + 2]);
  }
  const d = Math.hypot(mx0 - mn0, mx1 - mn1, mx2 - mn2);
  return Math.max(1e-9, (Number.isFinite(d) ? d : 1) * 5e-4);
}

function distToSegment(p: number[], a: number[], b: number[]): number {
  const ab0 = b[0] - a[0], ab1 = b[1] - a[1], ab2 = b[2] - a[2];
  const l2 = ab0 * ab0 + ab1 * ab1 + ab2 * ab2;
  let t = l2 > 0 ? ((p[0] - a[0]) * ab0 + (p[1] - a[1]) * ab1 + (p[2] - a[2]) * ab2) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(a[0] + ab0 * t - p[0], a[1] + ab1 * t - p[1], a[2] + ab2 * t - p[2]);
}

/**
 * Global u values of a polyline approximating the curve: open curves include 0 and 1, closed curves stop before 1
 * (the closing segment returns to u = 0). Adaptive by default: intervals are halved until the curve at 1/4, 1/2 and
 * 3/4 of each interval lies within the tolerance of its chord.
 */
export function polylineParams(s: Spline, o: PolylineOptions = {}): number[] {
  if (!s.pieces.length) return [];
  if (s.n === 1) return [0];
  const br = spanBreaks(s);
  const out: number[] = [];
  if (o.segments && o.segments > 0) {
    const m = Math.max(1, Math.round(o.segments));
    for (let i = 0; i + 1 < br.length; i++) for (let k = 0; k < m; k++) out.push(br[i] + ((br[i + 1] - br[i]) * k) / m);
    if (!s.closed) out.push(1);
    return out;
  }
  const tol = o.tolerance && o.tolerance > 0 ? o.tolerance : defaultTolerance(s);
  const A = [0, 0, 0], B = [0, 0, 0], M = [0, 0, 0];
  const rec = (u0: number, a: number[], u1: number, b: number[], depth: number) => {
    let err = 0;
    for (const f of [0.25, 0.5, 0.75]) {
      evalPoint(s, u0 + (u1 - u0) * f, M);
      err = Math.max(err, distToSegment(M, a, b));
      if (err > tol) break;
    }
    if (err <= tol || depth >= 16) { out.push(u0); return; }
    const um = (u0 + u1) / 2, m = evalPoint(s, um, [0, 0, 0]);
    rec(u0, a, um, m, depth + 1);
    rec(um, m, u1, b, depth + 1);
  };
  const init = Math.max(2, Math.min(4, s.order));
  for (let i = 0; i + 1 < br.length; i++)
    for (let k = 0; k < init; k++) {
      const u0 = br[i] + ((br[i + 1] - br[i]) * k) / init, u1 = br[i] + ((br[i + 1] - br[i]) * (k + 1)) / init;
      evalPoint(s, u0, A); evalPoint(s, u1, B);
      rec(u0, A.slice(), u1, B.slice(), 0);
    }
  if (!s.closed) out.push(1);
  return out;
}

/** Positions of a polyline approximating the curve (3 numbers per point), see polylineParams. */
export function toPolyline(s: Spline, o: PolylineOptions = {}): { u: number[]; P: Float64Array } {
  const u = polylineParams(s, o), P = new Float64Array(u.length * 3), tmp = [0, 0, 0];
  u.forEach((x, i) => { evalPoint(s, x, tmp); P[i * 3] = tmp[0]; P[i * 3 + 1] = tmp[1]; P[i * 3 + 2] = tmp[2]; });
  return { u, P };
}

// ---------------------------------------------------------------- parameterisation and knots

/**
 * Parameter values of points (3 numbers each) on [0, 1]: open = one per point (0 … 1); closed = one per point plus 1
 * for the return to the first point. uniform: evenly; chord: by distance; centripetal: by √distance.
 */
export function curveParams(Q: ArrayLike<number>, closed: boolean, mode: Parameterization): Float64Array {
  const m = Math.floor(Q.length / 3), cnt = closed ? m + 1 : m;
  const t = new Float64Array(cnt);
  if (cnt < 2) return t;
  let total = 0;
  for (let i = 1; i < cnt; i++) {
    const a = (i - 1) % m, b = i % m;
    let d = Math.hypot(Q[b * 3] - Q[a * 3], Q[b * 3 + 1] - Q[a * 3 + 1], Q[b * 3 + 2] - Q[a * 3 + 2]);
    if (mode === 'uniform') d = 1; else if (mode === 'centripetal') d = Math.sqrt(d);
    total += d;
    t[i] = total;
  }
  if (!(total > 0)) for (let i = 0; i < cnt; i++) t[i] = i / (cnt - 1);
  else for (let i = 0; i < cnt; i++) t[i] /= total;
  t[cnt - 1] = 1;
  return t;
}

/** Open knot vector by averaging the parameters (Piegl & Tiller eq. 9.8): n params, degree p → n + p + 1 knots. */
export function averagedKnots(t: ArrayLike<number>, p: number): Float64Array {
  const n = t.length, U = new Float64Array(n + p + 1);
  for (let i = n; i < U.length; i++) U[i] = 1;
  for (let j = 1; j <= n - 1 - p; j++) {
    let s = 0;
    for (let i = j; i < j + p; i++) s += t[i];
    U[j + p] = s / p;
  }
  return U;
}

/**
 * Knots for a NURBS whose CVs are the given points: uniform = clamped uniform (open) / evenly spaced breakpoints
 * (closed); chord / centripetal = spacing that follows the CV distances.
 */
export function autoKnots(P: ArrayLike<number>, closed: boolean, order: number, mode: Parameterization): Float64Array {
  const n = Math.floor(P.length / 3), p = Math.min(clampOrder(order) - 1, Math.max(1, n - 1));
  if (closed) return mode === 'uniform' ? uniformBreakpoints(n) : curveParams(P, true, mode);
  if (mode === 'uniform') return clampedUniformKnots(n, p);
  return averagedKnots(curveParams(P, false, mode), p);
}

/** Knots in storage form of a NURBS equal to a Bezier curve with S segments of degree p (breakpoints 0 … S). */
export function bezierKnots(S: number, p: number, closed: boolean): Float64Array {
  const out: number[] = [];
  if (closed) {
    out.push(0);
    for (let k = 1; k <= S; k++) for (let j = 0; j < p; j++) out.push(k);
  } else {
    for (let j = 0; j <= p; j++) out.push(0);
    for (let k = 1; k < S; k++) for (let j = 0; j < p; j++) out.push(k);
    for (let j = 0; j <= p; j++) out.push(S);
  }
  return Float64Array.from(out);
}

// ---------------------------------------------------------------- exact conversions

/** A CV of a converted curve: position, weight and its blend of source CVs (for attribute provenance). */
export interface ConvertedCV { P: Vec3; w: number; idx: number[]; wts: number[] }

function cvFromCoeffs(s: Spline, idx: ArrayLike<number>, coef: ArrayLike<number>): ConvertedCV {
  let x = 0, y = 0, z = 0, w = 0;
  const m = new Map<number, number>();
  for (let j = 0; j < idx.length; j++) {
    const c = coef[j];
    if (c === 0) continue;
    const i = idx[j], wi = s.W[i] * c;
    x += s.P[i * 3] * wi; y += s.P[i * 3 + 1] * wi; z += s.P[i * 3 + 2] * wi; w += wi;
    m.set(i, (m.get(i) ?? 0) + wi);
  }
  const iw = w || 1e-300;
  return { P: [x / iw, y / iw, z / iw], w, idx: [...m.keys()], wts: [...m.values()].map((v) => v / iw) };
}

/** Coefficients over d + 1 Bezier CVs of the CVs of the same segment elevated to degree p. */
function elevationCoeffs(d: number, p: number): number[][] {
  let rows: number[][] = Array.from({ length: d + 1 }, (_, i) => Array.from({ length: d + 1 }, (_, j) => (i === j ? 1 : 0)));
  for (let e = d; e < p; e++) {
    const next: number[][] = [];
    for (let i = 0; i <= e + 1; i++) {
      const a = i / (e + 1);
      next.push(rows[0].map((_, c) => (i > 0 ? a * rows[i - 1][c] : 0) + (i <= e ? (1 - a) * rows[i][c] : 0)));
    }
    rows = next;
  }
  return rows;
}

/**
 * Bezier → NURBS, exactly: the same CVs (a short last segment is degree-elevated, adding CVs) with knots of
 * multiplicity degree at the segment joins (bezierKnots).
 */
export function bezierToNurbs(s: Spline): { cvs: ConvertedCV[]; knots: Float64Array; order: number } {
  const p = s.order - 1;
  const cvs: ConvertedCV[] = [];
  if (s.n < 2) return { cvs: s.n ? [cvFromCoeffs(s, [0], [1])] : [], knots: new Float64Array(0), order: s.order };
  s.pieces.forEach((pc, k) => {
    const rows = elevationCoeffs(pc.p, p);
    const last = s.closed || k < s.pieces.length - 1 ? p - 1 : p;
    for (let i = 0; i <= last; i++) cvs.push(cvFromCoeffs(s, pc.cv, rows[i]));
  });
  return { cvs, knots: bezierKnots(s.pieces.length, p, s.closed), order: p + 1 };
}

/** Coefficients over the p + 1 CVs of span k of the blossom f(ts[0], …, ts[p-1]) (de Boor with one parameter per level). */
function blossomCoeffs(pc: Piece, k: number, ts: number[]): number[][] {
  const p = pc.p, U = pc.U;
  let d: number[][] = Array.from({ length: p + 1 }, (_, j) => Array.from({ length: p + 1 }, (_, c) => (c === j ? 1 : 0)));
  for (let r = 1; r <= p; r++) {
    const t = ts[r - 1], nd = d.map((row) => row.slice());
    for (let j = p; j >= r; j--) {
      const i = k - p + j, den = U[i + p + 1 - r] - U[i];
      const al = den > 0 ? (t - U[i]) / den : 0;
      for (let c = 0; c <= p; c++) nd[j][c] = (1 - al) * d[j - 1][c] + al * d[j][c];
    }
    d = nd;
  }
  return d;
}

/** NURBS → Bezier, exactly: one Bezier segment per non-empty knot span (CVs by blossoming). */
export function nurbsToBezier(s: Spline): { cvs: ConvertedCV[]; order: number } {
  const pc = s.pieces[0];
  if (!pc || s.n < 2) return { cvs: s.n ? [cvFromCoeffs(s, [0], [1])] : [], order: s.order };
  const p = pc.p, U = pc.U;
  const spans: number[] = [];
  for (let k = p; k < U.length - p - 1; k++) if (U[k] < U[k + 1] && U[k] >= pc.a && U[k + 1] <= pc.b) spans.push(k);
  const cvs: ConvertedCV[] = [];
  spans.forEach((k, si) => {
    const a = U[k], b = U[k + 1];
    const idx = Array.from({ length: p + 1 }, (_, j) => pc.cv[k - p + j]);
    const last = s.closed || si < spans.length - 1 ? p - 1 : p;
    for (let j = 0; j <= last; j++) {
      const ts = [...new Array(p - j).fill(a), ...new Array(j).fill(b)];
      const coef = blossomCoeffs(pc, k, ts)[p];
      // coefficients act on homogeneous CVs: divide the CV weights back out (cvFromCoeffs multiplies by them)
      cvs.push(cvFromCoeffs(s, idx, coef));
    }
  });
  return { cvs, order: p + 1 };
}

/**
 * A G1 piecewise cubic Bezier through the points (open: 3·(m−1) + 1 CVs, closed: 3·m): tangents along the neighbouring
 * chords (Catmull–Rom directions), handles one third of each segment long.
 */
export function bezierThrough(Q: ArrayLike<number>, closed: boolean): Float64Array {
  const m = Math.floor(Q.length / 3);
  const pt = (i: number): Vec3 => { const k = closed ? ((i % m) + m) % m : i; return [Q[k * 3], Q[k * 3 + 1], Q[k * 3 + 2]]; };
  const nrm = (v: Vec3): Vec3 => { const l = Math.hypot(v[0], v[1], v[2]); return l > 1e-15 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 0]; };
  if (m < 2) return Float64Array.from(Q);
  const T: Vec3[] = [];
  for (let i = 0; i < m; i++) {
    if (closed || (i > 0 && i < m - 1)) {
      const a = pt(i - 1), b = pt(i), c = pt(i + 1);
      const d0 = nrm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]), d1 = nrm([c[0] - b[0], c[1] - b[1], c[2] - b[2]]);
      T.push(nrm([d0[0] + d1[0], d0[1] + d1[1], d0[2] + d1[2]]));
    } else T.push([0, 0, 0]);
  }
  if (!closed) {
    // ends: reflect the neighbour's tangent about the end chord (natural-looking ends)
    const end = (i: number, j: number) => {
      const a = pt(i), b = pt(j), c = nrm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
      const tj = m > 2 ? T[j] : c, d = 2 * (c[0] * tj[0] + c[1] * tj[1] + c[2] * tj[2]);
      return nrm([c[0] * d - tj[0], c[1] * d - tj[1], c[2] * d - tj[2]]);
    };
    T[0] = end(0, 1);
    const tl = end(m - 1, m - 2);
    T[m - 1] = [-tl[0], -tl[1], -tl[2]];
  }
  const out: number[] = [];
  const segs = closed ? m : m - 1;
  for (let i = 0; i < segs; i++) {
    const a = pt(i), b = pt(i + 1), L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / 3;
    const ta = T[i], tb = T[(i + 1) % m];
    out.push(...a, a[0] + ta[0] * L, a[1] + ta[1] * L, a[2] + ta[2] * L, b[0] - tb[0] * L, b[1] - tb[1] * L, b[2] - tb[2] * L);
  }
  if (!closed) out.push(...pt(m - 1));
  return Float64Array.from(out);
}

// ---------------------------------------------------------------- fitting (profile Cholesky on the normal equations)

/** Symmetric positive definite matrix in envelope (profile) storage: row i holds columns lo[i] … i. */
class Profile {
  n: number;
  lo: Int32Array;
  off: Int32Array;
  v: Float64Array;
  constructor(n: number, h: number, cyclic: boolean) {
    this.n = n;
    this.lo = new Int32Array(n);
    this.off = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) {
      this.lo[i] = cyclic && i >= n - h ? 0 : Math.max(0, i - h);
      this.off[i + 1] = this.off[i] + (i - this.lo[i] + 1);
    }
    this.v = new Float64Array(this.off[n]);
  }
  add(i: number, j: number, x: number) {
    if (j > i) { const t = i; i = j; j = t; }
    if (j < this.lo[i]) throw new Error(`profile: (${i}, ${j}) outside the envelope`);
    this.v[this.off[i] + j - this.lo[i]] += x;
  }
  private at(i: number, j: number) { return this.v[this.off[i] + j - this.lo[i]]; }
  /** In-place Cholesky (L Lᵀ); false when the matrix is not positive definite. */
  cholesky(): boolean {
    const { n, lo, off, v } = this;
    for (let i = 0; i < n; i++) {
      for (let j = lo[i]; j <= i; j++) {
        let sum = v[off[i] + j - lo[i]];
        const k0 = Math.max(lo[i], lo[j]);
        for (let k = k0; k < j; k++) sum -= v[off[i] + k - lo[i]] * v[off[j] + k - lo[j]];
        if (j < i) v[off[i] + j - lo[i]] = sum / this.at(j, j);
        else {
          if (!(sum > 0)) return false;
          v[off[i] + i - lo[i]] = Math.sqrt(sum);
        }
      }
    }
    return true;
  }
  /** Solve L Lᵀ x = b for 3 right-hand sides (b: 3 per row), in place. */
  solve(b: Float64Array) {
    const { n, lo, off, v } = this;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 3; c++) {
        let s = b[i * 3 + c];
        for (let k = lo[i]; k < i; k++) s -= v[off[i] + k - lo[i]] * b[k * 3 + c];
        b[i * 3 + c] = s / v[off[i] + i - lo[i]];
      }
    }
    for (let i = n - 1; i >= 0; i--) {
      const d = v[off[i] + i - lo[i]];
      for (let c = 0; c < 3; c++) b[i * 3 + c] /= d;
      for (let k = lo[i]; k < i; k++) {
        const l = v[off[i] + k - lo[i]];
        for (let c = 0; c < 3; c++) b[k * 3 + c] -= l * b[i * 3 + c];
      }
    }
  }
}

export interface FitResult {
  /** CV positions (3 per CV) */
  P: Float64Array;
  /** knots in storage form */
  knots: Float64Array;
  order: number;
  closed: boolean;
  /** parameter (global u) of each input point on the fitted curve */
  params: Float64Array;
  /** largest distance between an input point and the curve at its parameter */
  error: number;
}

/**
 * Least-squares B-spline through points Q (3 per point) with n CVs: open curves keep their first and last point;
 * smoothing ≥ 0 adds a penalty on the second differences of the CVs (relative to the data weight); `corrections`
 * re-projects the parameters onto the curve and refits. n = number of points interpolates.
 */
export function fitSpline(Q: ArrayLike<number>, o: { closed: boolean; order: number; cvs: number; mode?: Parameterization; smoothing?: number; corrections?: number }): FitResult {
  const m = Math.floor(Q.length / 3), closed = o.closed && m >= 3;
  const mode = o.mode ?? 'centripetal';
  const tAll = curveParams(Q, closed, mode);
  const params = closed ? tAll.subarray(0, m).slice() : tAll.slice();
  let n = Math.max(2, Math.min(Math.round(o.cvs), m));
  if (closed) n = Math.max(3, n);
  let p = Math.min(clampOrder(o.order) - 1, n - 1);
  const order = p + 1;
  const empty = (): FitResult => ({ P: Float64Array.from(Q), knots: new Float64Array(0), order, closed, params, error: 0 });
  if (m < 2) return empty();
  // knots
  let knots: Float64Array;
  if (!closed) {
    if (n === m) knots = averagedKnots(params, p);
    else {
      knots = new Float64Array(n + p + 1);
      for (let i = n; i < knots.length; i++) knots[i] = 1;
      const d = m / (n - p);
      for (let j = 1; j <= n - p - 1; j++) {
        const i = Math.floor(j * d), a = j * d - i;
        knots[p + j] = (1 - a) * params[Math.max(0, i - 1)] + a * params[Math.min(m - 1, i)];
      }
    }
  } else if (n === m) {
    knots = tAll.slice();
    if (p % 2 === 0) {
      // even degree: breakpoints halfway between the data parameters keep the periodic system regular
      const b = new Float64Array(n + 1);
      for (let j = 0; j < n; j++) b[j] = (tAll[j] + tAll[j + 1]) / 2 - tAll[1] / 2;
      b[n] = b[0] + 1;
      knots = b;
    }
  } else {
    knots = new Float64Array(n + 1);
    for (let j = 0; j <= n; j++) {
      const x = (j * m) / n, i = Math.floor(x), f = x - i;
      knots[j] = i >= m ? 1 : (1 - f) * tAll[i] + f * tAll[i + 1];
    }
  }
  const lam = Math.max(0, o.smoothing ?? 0) * (m / n);
  const corrections = n === m ? 0 : Math.max(0, o.corrections ?? 2);
  let P = new Float64Array(n * 3);
  if (!closed) { for (let c = 0; c < 3; c++) { P[c] = Q[c]; P[(n - 1) * 3 + c] = Q[(m - 1) * 3 + c]; } }
  const proto = makeSpline('nurbs', new Float64Array(n * 3), { order, closed, knots });
  knots = proto.knots; // (identical unless the computed vector was unusable and got replaced)
  const pc = proto.pieces[0];
  const h = Math.max(p, lam > 0 ? 2 : 0);
  const solveOnce = (): boolean => {
    // unknowns: open curves solve for CVs 1 … n-2 (the ends are the end points); closed curves for all n
    const off = closed ? 0 : 1, nu = closed ? n : n - 2;
    if (nu <= 0) return true;
    const A = new Profile(nu, Math.min(h, nu - 1), closed);
    const rhs = new Float64Array(nu * 3);
    const tp = closed ? pc.b - pc.a : 1;
    for (let k = 0; k < m; k++) {
      const t = pc.a + params[k] * tp;
      const span = findSpan(pc, t);
      const N = dersBasis(pc, span, t, 0);
      const cols: number[] = [], vals: number[] = [];
      const r = [Q[k * 3], Q[k * 3 + 1], Q[k * 3 + 2]];
      for (let j = 0; j <= p; j++) {
        if (N[j] === 0) continue;
        const ci = pc.cv[span - p + j];
        if (!closed && (ci === 0 || ci === n - 1)) { for (let c = 0; c < 3; c++) r[c] -= N[j] * P[ci * 3 + c]; continue; }
        cols.push(ci - off); vals.push(N[j]);
      }
      for (let a = 0; a < cols.length; a++) {
        for (let b = 0; b <= a; b++) {
          // a CV can appear twice in a span of a closed curve with few CVs: count both
          if (cols[a] === cols[b] && a !== b) A.add(cols[a], cols[b], 2 * vals[a] * vals[b]);
          else A.add(cols[a], cols[b], vals[a] * vals[b]);
        }
        for (let c = 0; c < 3; c++) rhs[cols[a] * 3 + c] += vals[a] * r[c];
      }
    }
    if (lam > 0) {
      // second differences P[i-1] - 2 P[i] + P[i+1]
      const rows = closed ? n : n - 2;
      for (let q = 0; q < rows; q++) {
        const i = closed ? q : q + 1;
        const idx = [(i - 1 + n) % n, i, (i + 1) % n], cf = [1, -2, 1];
        const cols: number[] = [], vals: number[] = [], fixed = [0, 0, 0];
        idx.forEach((ci, k) => {
          if (!closed && (ci === 0 || ci === n - 1)) { for (let c = 0; c < 3; c++) fixed[c] += cf[k] * P[ci * 3 + c]; }
          else { cols.push(ci - off); vals.push(cf[k]); }
        });
        for (let a = 0; a < cols.length; a++) {
          for (let b = 0; b <= a; b++) A.add(cols[a], cols[b], (cols[a] === cols[b] && a !== b ? 2 : 1) * lam * vals[a] * vals[b]);
          for (let c = 0; c < 3; c++) rhs[cols[a] * 3 + c] -= lam * vals[a] * fixed[c];
        }
      }
    }
    const backup = A.v.slice();
    if (!A.cholesky()) {
      // singular (e.g. coincident data): a tiny ridge keeps the solve defined
      let tr = 0;
      for (let i = 0; i < nu; i++) tr += backup[A.off[i] + i - A.lo[i]];
      A.v.set(backup);
      for (let i = 0; i < nu; i++) A.v[A.off[i] + i - A.lo[i]] += 1e-9 * (tr / nu || 1);
      if (!A.cholesky()) return false;
    }
    A.solve(rhs);
    for (let i = 0; i < nu; i++) for (let c = 0; c < 3; c++) P[(i + off) * 3 + c] = rhs[i * 3 + c];
    return true;
  };
  if (!solveOnce()) return empty();
  let curve = makeSpline('nurbs', P, { order, closed, knots });
  for (let it = 0; it < corrections; it++) {
    for (let k = closed ? 0 : 1; k < (closed ? m : m - 1); k++) {
      let u = params[k];
      for (let j = 0; j < 4; j++) {
        const { P: C, d1, d2 } = evalDerivs(curve, u);
        const r0 = C[0] - Q[k * 3], r1 = C[1] - Q[k * 3 + 1], r2 = C[2] - Q[k * 3 + 2];
        const f = d1[0] * r0 + d1[1] * r1 + d1[2] * r2;
        const fp = d2[0] * r0 + d2[1] * r1 + d2[2] * r2 + d1[0] * d1[0] + d1[1] * d1[1] + d1[2] * d1[2];
        if (!(fp > 1e-300)) break;
        u = Math.min(closed ? 1 - 1e-12 : 1, Math.max(0, u - f / fp));
      }
      params[k] = u;
    }
    if (!solveOnce()) break;
    curve = makeSpline('nurbs', P, { order, closed, knots });
  }
  let error = 0;
  const tmp = [0, 0, 0];
  for (let k = 0; k < m; k++) {
    evalPoint(curve, params[k], tmp);
    error = Math.max(error, Math.hypot(tmp[0] - Q[k * 3], tmp[1] - Q[k * 3 + 1], tmp[2] - Q[k * 3 + 2]));
  }
  return { P, knots, order, closed, params, error };
}

/** NURBS through every point (global interpolation). */
export function interpolateSpline(Q: ArrayLike<number>, closed: boolean, order: number, mode: Parameterization = 'centripetal'): FitResult {
  return fitSpline(Q, { closed, order, cvs: Math.floor(Q.length / 3), mode });
}

/** Fewest CVs (searched) whose least-squares fit stays within tol of every point; interpolates at worst. */
export function fitSplineTolerance(Q: ArrayLike<number>, o: { closed: boolean; order: number; tolerance: number; mode?: Parameterization; smoothing?: number; maxCvs?: number }): FitResult {
  const m = Math.floor(Q.length / 3);
  const closed = o.closed && m >= 3;
  const nMax = Math.max(2, Math.min(m, o.maxCvs && o.maxCvs > 0 ? o.maxCvs : m));
  const nMin = Math.min(nMax, Math.max(closed ? 3 : 2, clampOrder(o.order)));
  const fit = (n: number) => fitSpline(Q, { closed, order: o.order, cvs: n, mode: o.mode, smoothing: o.smoothing });
  let lo = nMin - 1, hiFit: FitResult | null = null, hi = nMin;
  // grow geometrically until within tolerance (or the maximum), then bisect between the last miss and the first hit
  for (;;) {
    const r = fit(hi);
    if (r.error <= o.tolerance || hi >= nMax) { hiFit = r; break; }
    lo = hi;
    hi = Math.min(nMax, Math.ceil(hi * 1.6) + 1);
  }
  while (hi - lo > 1 && hiFit.error <= o.tolerance) {
    const mid = (lo + hi) >> 1;
    const r = fit(mid);
    if (r.error <= o.tolerance) { hi = mid; hiFit = r; } else lo = mid;
  }
  return hiFit;
}

// ---------------------------------------------------------------- geometry helpers

/** The spline of prim p of g (CVs, Pw weights, spline_order, knots, closed). */
export function splineFromPrim(g: Geometry, prim: number): Spline {
  const type = typeOfKind(g.primKind?.[prim] ?? 0) ?? 'nurbs';
  const pts = g.primPoints(prim), n = pts.length, P = new Float64Array(n * 3), Pd = g.P;
  for (let k = 0; k < n; k++) { P[k * 3] = Pd[pts[k] * 3]; P[k * 3 + 1] = Pd[pts[k] * 3 + 1]; P[k * 3 + 2] = Pd[pts[k] * 3 + 2]; }
  const wa = g.points.get(WEIGHT_ATTRIB);
  let weights: Float64Array | null = null;
  if (wa && wa.type === 'float' && !wa.isArray) {
    weights = new Float64Array(n);
    const d = wa.data as Float64Array;
    for (let k = 0; k < n; k++) weights[k] = d[pts[k] * wa.size];
  }
  const oa = g.prims.get(ORDER_ATTRIB);
  let order = DEFAULT_ORDER;
  if (oa && oa.type !== 'string' && !oa.isArray) { const v = Number(oa.get(prim)); if (v >= 2) order = v; }
  const ka = g.prims.get(KNOTS_ATTRIB);
  const knots = ka && ka.isArray && ka.type !== 'string[]' ? (ka.getArray(prim) as number[]) : null;
  return makeSpline(type, P, { order, closed: !!g.primClosed[prim], weights, knots });
}

/**
 * Make prim p of g (a geometry the caller owns) a spline: kind, "spline_order" and, for NURBS, "knots" (empty for
 * Bezier and for uniform NURBS knots chosen at evaluation).
 */
export function setSplinePrim(g: Geometry, p: number, type: SplineType, order: number, knots?: ArrayLike<number> | null) {
  g.ensurePacked();
  g.primKind![p] = kindOf(type);
  const oa = g.prims.get(ORDER_ATTRIB);
  (oa && !oa.isArray && oa.type !== 'string' ? oa : g.prims.add(ORDER_ATTRIB, 'int', 1)).set(p, clampOrder(order));
  let ka = g.prims.get(KNOTS_ATTRIB);
  if (!ka || !ka.isArray || ka.type === 'string[]') ka = g.prims.add(KNOTS_ATTRIB, 'float[]', 1);
  ka.set(p, type === 'nurbs' && knots ? Array.from(knots) : []);
}

/** Remove the spline attributes (spline_order, knots, Pw) once no spline prim is left; compacts array storage. */
export function tidySplineAttribs(g: Geometry): Geometry {
  if (g.hasSplines()) { g.prims.get(KNOTS_ATTRIB)?.compact(); return g; }
  g.prims.delete(ORDER_ATTRIB);
  g.prims.delete(KNOTS_ATTRIB);
  g.points.delete(WEIGHT_ATTRIB);
  if (g.primKind && !g.primKind.includes(1)) g.clearPacked();
  return g;
}

export interface ToPolylinesOptions extends PolylineOptions {
  /** convert only prims with group[p] set (others, splines included, stay as they are) */
  group?: ArrayLike<number> | null;
  /** also return pointOrigin: the input point each output point comes from (its heaviest CV for curve samples) */
  origins?: boolean;
}

/**
 * Replace spline prims by polylines (closed splines by closed polygons) sampled with polylineParams. Points and
 * vertices of the samples blend the CVs' attributes with the curve's own basis weights, so a width or colour on the
 * CVs varies along the curve as the curve does. Other prims, their points and isolated points keep their numbers;
 * CV points no other prim uses are removed. Prim order is unchanged.
 */
export function splinesToPolylines(g: Geometry, o: ToPolylinesOptions = {}): { geo: Geometry; converted: number; pointOrigin?: Int32Array } {
  if (!g.hasSplines()) return { geo: g, converted: 0, pointOrigin: o.origins ? Int32Array.from({ length: g.numPoints }, (_, i) => i) : undefined };
  const np0 = g.numPoints, npr = g.numPrims;
  const b = new GeoBuilder(g);
  for (let i = 0; i < np0; i++) b.copyPoint(i);
  const keepKind = new Uint8Array(npr);
  const origin: number[] = [];
  let converted = 0;
  for (let p = 0; p < npr; p++) {
    const s0 = g.primStart[p], e0 = g.primStart[p + 1];
    const pts = g.primPoints(p);
    if (!g.isSpline(p) || (o.group && !o.group[p])) {
      const vs: number[] = [];
      for (let v = s0; v < e0; v++) vs.push(v);
      b.addPrim(pts, !!g.primClosed[p], p, vs);
      if (g.isSpline(p)) keepKind[p] = g.primKind![p];
      continue;
    }
    converted++;
    const s = splineFromPrim(g, p);
    const us = polylineParams(s, o);
    const ids: number[] = [], vsrc: Src[] = [];
    for (const u of us) {
      const e = evalBasis(s, u);
      const pi = e.idx.map((k) => pts[k]), vi = e.idx.map((k) => s0 + k);
      ids.push(b.addPoint(e.P[0], e.P[1], e.P[2], { i: pi, w: e.w }));
      vsrc.push({ i: vi, w: e.w });
      if (o.origins) { let bi = 0; for (let k = 1; k < e.w.length; k++) if (e.w[k] > e.w[bi]) bi = k; origin.push(pi[bi] ?? 0); }
    }
    b.addPrim(ids, s.closed && ids.length >= 3, p, vsrc);
  }
  let out = b.build();
  // spline prims left alone keep their kind
  if (keepKind.some((k) => k)) {
    out.ensurePacked();
    for (let p = 0; p < npr; p++) if (keepKind[p]) out.primKind![p] = keepKind[p];
  }
  const oa = out.prims.get(ORDER_ATTRIB), ka = out.prims.get(KNOTS_ATTRIB);
  for (let p = 0; p < npr; p++) {
    if (keepKind[p] || !g.isSpline(p)) continue;
    if (oa && !oa.isArray && oa.type !== 'string') oa.set(p, 0);
    if (ka && ka.isArray) ka.set(p, []);
  }
  // CV points that only spline prims used go away; points other prims use and isolated points stay
  const usedBefore = new Uint8Array(np0), usedAfter = new Uint8Array(out.numPoints);
  for (let v = 0; v < g.numVertices; v++) usedBefore[g.vertexPoint[v]] = 1;
  for (let v = 0; v < out.numVertices; v++) usedAfter[out.vertexPoint[v]] = 1;
  const keep = new Uint8Array(out.numPoints);
  for (let i = 0; i < out.numPoints; i++) keep[i] = i >= np0 || usedAfter[i] || !usedBefore[i] ? 1 : 0;
  let pointOrigin: Int32Array | undefined;
  if (o.origins) {
    const all = Int32Array.from({ length: out.numPoints }, (_, i) => (i < np0 ? i : origin[i - np0]));
    pointOrigin = Int32Array.from(all.filter((_, i) => keep[i]));
  }
  out = out.subsetPoints(keep);
  return { geo: tidySplineAttribs(out), converted, pointOrigin };
}

/** Polyline input for a node that samples curves itself: spline prims evaluated (no-op without splines). */
export function evaluateSplines(g: Geometry, o: PolylineOptions = {}): Geometry {
  return g.hasSplines() ? splinesToPolylines(g, o).geo : g;
}

/** "2 bezier, 1 nurbs" counts, for summaries (null without splines). */
export function splineCounts(g: Geometry): { bezier: number; nurbs: number } | null {
  const k = g.primKind;
  if (!k) return null;
  let bz = 0, nb = 0;
  for (let i = 0; i < k.length; i++) { if (k[i] === KIND_BEZIER) bz++; else if (k[i] === KIND_NURBS) nb++; }
  return bz || nb ? { bezier: bz, nurbs: nb } : null;
}
