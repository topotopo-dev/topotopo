// Rational tensor-product surfaces. The two axes use the NURBS curve knot and basis conventions.
import earcut from 'earcut';
import type { GeoBuilder, Geometry, Src } from './geometry.ts';
import { crossSection } from './manifold.ts';
import { cross, dist, dot, sub } from './math.ts';
import type { Vec3 } from './math.ts';
import { DEFAULT_ORDER, KNOTS_ATTRIB, MAXP1, ORDER_ATTRIB, WEIGHT_ATTRIB, dersBasis, findSpan, makeSpline, spanBreaks } from './splines.ts';
import type { Spline } from './splines.ts';

export const KIND_NURBS_SURFACE = 4;
export const SURFACE_COLS = 'surface_cols';
export const ORDER_V = 'spline_order_v';
export const KNOTS_V = 'knots_v';
export const CLOSED_V = 'closed_v';
export const TRIM_UV = 'trim_uv';
export const TRIM_LOOPS = 'trim_loops';
export const TRIM_NAMES = 'trim_names';
export type SurfaceUV = [number, number];
const meshSources = new WeakMap<GeoBuilder, Geometry>();

/** The positively filled region of the unit square. A missing region keeps the whole square. */
export function surfaceTrims(g: Geometry, prim: number, names?: string[]): SurfaceUV[][] | null {
  const uv = g.prims.get(TRIM_UV), counts = g.prims.get(TRIM_LOOPS);
  if (uv?.type !== 'float[]' || counts?.type !== 'int[]') return null;
  const xy = uv.getArray(prim) as number[], sizes = counts.getArray(prim) as number[];
  if (!sizes.length || sizes.some((n) => n < 3) || sizes.reduce((a, b) => a + b, 0) * 2 !== xy.length) return null;
  if (names) {
    const attr = g.prims.get(TRIM_NAMES);
    const stored = attr?.type === 'string[]' ? attr.getArray(prim) as string[] : [];
    names.length = sizes.length;
    sizes.forEach((_, i) => { names[i] = stored[i] ?? ''; });
  }
  let i = 0;
  return sizes.map((n) => Array.from({ length: n }, (): SurfaceUV => [xy[i++], xy[i++]]));
}

export function setSurfaceTrims(g: Geometry, prim: number, loops: readonly SurfaceUV[][] | null, names?: readonly string[]): void {
  if (!loops?.length && !g.prims.has(TRIM_UV) && !g.prims.has(TRIM_LOOPS)) return;
  g.prims.add(TRIM_UV, 'float[]', 1).set(prim, loops?.flat(2) ?? []);
  g.prims.add(TRIM_LOOPS, 'int[]', 1).set(prim, loops?.map((loop) => loop.length) ?? []);
  if (names || g.prims.has(TRIM_NAMES)) {
    g.prims.add(TRIM_NAMES, 'string[]', 1).set(prim, loops?.map((_, i) => names?.[i] ?? '') ?? []);
  }
}

type TrimEdge = { a: SurfaceUV; b: SurfaceUV };

export const trimEdges = (loop: SurfaceUV[]) => loop.map((a, i): TrimEdge => ({ a, b: loop[(i + 1) % loop.length] }));

/** Name the source that contributes the most length to a trim boundary. */
export function trimBoundaryName(s: NurbsSurface, edges: TrimEdge[], sources: { loops: SurfaceUV[][]; name: string }[]) {
  const mix = (a: SurfaceUV, b: SurfaceUV, t: number): SurfaceUV => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  let best = 0, name = '';
  for (const source of sources) {
    let length = 0;
    const segments = source.loops.flatMap(trimEdges);
    for (const { a, b } of edges) {
      if (a.some((x, d) => x === b[d] && (x === 0 || x === 1))) continue;
      const dx = b[0] - a[0], dy = b[1] - a[1], size = Math.hypot(dx, dy);
      if (!size) continue;
      const intervals: [number, number][] = [];
      for (const { a: p, b: q } of segments) {
        if ([p, q].some(([x, y]) => Math.abs((x - a[0]) * dy - (y - a[1]) * dx) > 4e-8 * size)) continue;
        const at = ([x, y]: SurfaceUV) => ((x - a[0]) * dx + (y - a[1]) * dy) / (size * size);
        const pa = at(p), pb = at(q), lo = Math.max(0, Math.min(pa, pb)), hi = Math.min(1, Math.max(pa, pb));
        if (lo < hi) intervals.push([lo, hi]);
      }
      intervals.sort((a, b) => a[0] - b[0]);
      let end = 0;
      for (const [lo, hi] of intervals) if (hi > end) {
        length += dist(surfacePoint(s, mix(a, b, Math.max(lo, end))), surfacePoint(s, mix(a, b, hi)));
        end = hi;
      }
    }
    if (length > best) { best = length; name = source.name; }
  }
  return name;
}

export interface SurfaceOptions {
  orderU?: number;
  orderV?: number;
  closedU?: boolean;
  closedV?: boolean;
  knotsU?: ArrayLike<number> | null;
  knotsV?: ArrayLike<number> | null;
  weights?: ArrayLike<number>;
}

export interface NurbsSurface {
  cols: number;
  rows: number;
  u: Spline;
  v: Spline;
  points: number[];
  P: Float64Array;
  W: Float64Array;
  notes: string[];
}

/** Read the dimensions and stored orders without evaluating the surface. */
export function surfaceLayout(g: Geometry, prim: number) {
  const cols = Number(g.prims.get(SURFACE_COLS)?.get(prim) ?? 0);
  const rows = g.primSize(prim) / cols;
  if (!Number.isInteger(cols) || cols < 2 || !Number.isInteger(rows) || rows < 2) return null;
  return { cols, rows, orderU: Number(g.prims.get(ORDER_ATTRIB)?.get(prim)) || DEFAULT_ORDER,
    orderV: Number(g.prims.get(ORDER_V)?.get(prim)) || DEFAULT_ORDER };
}

/** Drop surfaces and their unshared CVs while retaining genuinely loose points. */
export function withoutSurfaces(g: Geometry): Geometry {
  if (!g.hasSurfaces()) return g;
  const keep = new Uint8Array(g.numPoints).fill(1);
  for (let p = 0; p < g.numPrims; p++) if (g.isSurface(p)) for (const i of g.primPoints(p)) keep[i] = 0;
  const out = g.subsetPrims(g.primClosed.map((_, p) => Number(!g.isSurface(p))), false);
  for (const i of out.vertexPoint) keep[i] = 1;
  return out.subsetPoints(keep);
}

/** Set the surface storage on an existing prim whose vertices are already in CV order. */
export function setSurfacePrim(g: Geometry, prim: number, cols: number, o: SurfaceOptions = {}): void {
  g.ensurePacked();
  g.primKind![prim] = KIND_NURBS_SURFACE;
  g.primClosed[prim] = o.closedU ? 1 : 0;
  for (const [name, value] of [[SURFACE_COLS, cols], [ORDER_ATTRIB, o.orderU ?? DEFAULT_ORDER],
    [ORDER_V, o.orderV ?? DEFAULT_ORDER], [CLOSED_V, o.closedV ? 1 : 0]] as const) {
    g.prims.add(name, 'int', 1).set(prim, value);
  }
  g.prims.add(KNOTS_ATTRIB, 'float[]', 1).set(prim, Array.from(o.knotsU ?? []));
  g.prims.add(KNOTS_V, 'float[]', 1).set(prim, Array.from(o.knotsV ?? []));
  if (o.weights) {
    const w = g.points.add(WEIGHT_ATTRIB, 'float', 1);
    g.primPoints(prim).forEach((pt, k) => w.set(pt, o.weights![k] ?? 1));
  }
}

/** Read and validate a surface. Invalid dimensions do not describe a CV grid. */
export function surfaceFromPrim(g: Geometry, prim: number): NurbsSurface | null {
  const layout = g.isSurface(prim) ? surfaceLayout(g, prim) : null;
  if (!layout) return null;
  const { cols, rows, orderU, orderV } = layout;
  const axis = (n: number, order: number, closed: boolean, name: string) => {
    const a = g.prims.get(name);
    const knots = a?.isArray && a.type !== 'string[]' ? a.getArray(prim) as number[] : null;
    return makeSpline('nurbs', new Float64Array(n * 3), { order, closed, knots });
  };
  const u = axis(cols, orderU, !!g.primClosed[prim], KNOTS_ATTRIB);
  const v = axis(rows, orderV, Number(g.prims.get(CLOSED_V)?.get(prim)) === 1, KNOTS_V);
  const notes = [...u.notes.map((n) => `u: ${n}`), ...v.notes.map((n) => `v: ${n}`)];
  const points = g.primPoints(prim), weight = g.points.get(WEIGHT_ATTRIB);
  const P = new Float64Array(3 * points.length), W = new Float64Array(points.length);
  let bad = 0;
  points.forEach((pt, k) => {
    P.set(g.P.subarray(3 * pt, 3 * pt + 3), k * 3);
    const w = weight?.type === 'float' ? Number(weight.get(pt)) : 1;
    if (w > 1e-12 && Number.isFinite(w)) W[k] = w;
    else { W[k] = 1; bad++; }
  });
  if (bad) notes.push(`${bad} non-positive weight(s) (Pw) treated as 1`);
  return { cols, rows, u, v, points, P, W, notes };
}

const parameter = (s: Spline, t: number) => s.closed ? t - Math.floor(t) : Math.max(0, Math.min(1, t));

function basis(s: Spline, t: number, order: number) {
  const pc = s.pieces[0], scale = pc.b - pc.a;
  const x = Math.min(pc.b, pc.a + parameter(s, t) * scale);
  const span = findSpan(pc, x), nd = Math.min(order, pc.p);
  const d = dersBasis(pc, span, x, nd);
  const idx: number[] = [], b: number[] = [], d1: number[] = [], d2: number[] = [];
  for (let j = 0; j <= pc.p; j++) {
    idx.push(pc.cv[span - pc.p + j]);
    b.push(d[j]);
    d1.push(nd >= 1 ? d[MAXP1 + j] * scale : 0);
    d2.push(nd >= 2 ? d[2 * MAXP1 + j] * scale * scale : 0);
  }
  return { idx, b, d1, d2 };
}

const zero = (): Vec3 => [0, 0, 0];

export function evaluate(s: NurbsSurface, u: number, v: number, order: 0 | 1 | 2, provenance = false) {
  const U = basis(s.u, u, order), V = basis(s.v, v, order);
  const count = order === 0 ? 1 : order === 1 ? 3 : 6;
  const h = new Float64Array(24), B = new Float64Array(6);
  const idx: number[] = [], w: number[] = [];
  // Accumulate around a nearby CV so a large translation does not enter the derivative sums.
  const refU = Math.max(0, U.b.findIndex((b) => b > 0)), refV = Math.max(0, V.b.findIndex((b) => b > 0));
  const ref = 3 * (V.idx[refV] * s.cols + U.idx[refU]);
  for (let j = 0; j < V.idx.length; j++) for (let i = 0; i < U.idx.length; i++) {
    const k = V.idx[j] * s.cols + U.idx[i], pt = k * 3, weight = s.W[k];
    B[0] = U.b[i] * V.b[j];
    if (order > 0) { B[1] = U.d1[i] * V.b[j]; B[2] = U.b[i] * V.d1[j]; }
    if (order === 2) { B[3] = U.d2[i] * V.b[j]; B[4] = U.d1[i] * V.d1[j]; B[5] = U.b[i] * V.d2[j]; }
    for (let d = 0; d < count; d++) {
      const a = B[d] * weight, h0 = d * 4;
      for (let c = 0; c < 3; c++) h[h0 + c] += a * (s.P[pt + c] - s.P[ref + c]);
      h[h0 + 3] += a;
    }
    if (provenance && B[0] !== 0) { idx.push(k); w.push(B[0] * weight); }
  }
  const P = zero(), Su = zero(), Sv = zero(), Suu = zero(), Suv = zero(), Svv = zero();
  const W = h[3];
  for (let c = 0; c < 3; c++) {
    const p = h[c] / W;
    P[c] = p + s.P[ref + c];
    if (order === 0) continue;
    Su[c] = (h[4 + c] - p * h[7]) / W;
    Sv[c] = (h[8 + c] - p * h[11]) / W;
    if (order === 1) continue;
    Suu[c] = (h[12 + c] - p * h[15] - 2 * Su[c] * h[7]) / W;
    Suv[c] = (h[16 + c] - p * h[19] - Su[c] * h[11] - Sv[c] * h[7]) / W;
    Svv[c] = (h[20 + c] - p * h[23] - 2 * Sv[c] * h[11]) / W;
  }
  for (let k = 0; k < w.length; k++) w[k] /= W;
  return { P, Su, Sv, Suu, Suv, Svv, idx, w };
}

function unitNormal({ Su, Sv }: { Su: Vec3; Sv: Vec3 }): Vec3 | null {
  const a = Math.hypot(...Su), b = Math.hypot(...Sv);
  if (!(a > 0 && b > 0)) return null;
  const n = cross([Su[0] / a, Su[1] / a, Su[2] / a], [Sv[0] / b, Sv[1] / b, Sv[2] / b]);
  const l = Math.hypot(...n);
  return l > 1e-14 ? [n[0] / l, n[1] / l, n[2] / l] : null;
}

export function normal(s: NurbsSurface, u: number, v: number, e: { Su: Vec3; Sv: Vec3 }): Vec3 {
  const n = unitNormal(e);
  if (n) return n;
  u = parameter(s.u, u); v = parameter(s.v, v);
  const du = u < 0.5 ? 1e-6 : -1e-6, dv = v < 0.5 ? 1e-6 : -1e-6;
  for (const [x, y] of [[u + du, v], [u, v + dv], [u + du, v + dv]]) {
    const q = unitNormal(evaluate(s, x, y, 1));
    if (q) return q;
  }
  return [0, 1, 0];
}

/** Exact point and partial derivatives with respect to normalized u and v, and a unit normal. */
export function evalSurface(s: NurbsSurface, u: number, v: number) {
  const { P, Su, Sv, Suu, Suv, Svv } = evaluate(s, u, v, 2);
  return { P, Su, Sv, Suu, Suv, Svv, N: normal(s, u, v, { Su, Sv }) };
}

export function surfacePoint(s: NurbsSurface, [u, v]: SurfaceUV): Vec3 {
  return evaluate(s, u, v, 0).P;
}

/** Interior points needed to draw a straight UV segment as chords on the surface. */
export function sampleTrimSegment(s: NurbsSurface, a: SurfaceUV, b: SurfaceUV, tolerance: number): SurfaceUV[] {
  const out: SurfaceUV[] = [];
  const at = (a: SurfaceUV, b: SurfaceUV, t: number): SurfaceUV => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const split = (a: SurfaceUV, b: SurfaceUV, p: Vec3, q: Vec3, depth: number) => {
    for (const t of [0.5, 0.25, 0.75]) {
      const uv = at(a, b, t), m = surfacePoint(s, uv);
      if (Math.hypot(...m.map((x, i) => x - p[i] - (q[i] - p[i]) * t)) <= tolerance) continue;
      const mid = t === 0.5 ? uv : at(a, b, 0.5), r = t === 0.5 ? m : surfacePoint(s, mid);
      if (depth >= 16) throw new RangeError('Cannot mesh the trim within tolerance. Use a larger tolerance.');
      split(a, mid, p, r, depth + 1);
      out.push(mid);
      split(mid, b, r, q, depth + 1);
      break;
    }
  };
  split(a, b, surfacePoint(s, a), surfacePoint(s, b), 0);
  return out;
}

function samples(breaks: number[], segments: number): number[] {
  const out: number[] = [];
  for (let i = 1; i < breaks.length; i++)
    for (let j = 0; j < segments; j++) out.push(breaks[i - 1] + (breaks[i] - breaks[i - 1]) * j / segments);
  out.push(1);
  return out;
}

/** Closest point, starting from samples in every knot span and refining by bounded Newton steps. */
export function closestSurfacePoint(s: NurbsSurface, q: Vec3) {
  const U = samples(spanBreaks(s.u), 4), V = samples(spanBreaks(s.v), 4);
  const cache = U.map((u) => V.map((v) => {
    const r = sub(evaluate(s, u, v, 0).P, q);
    return dot(r, r);
  }));
  let best = { u: 0, v: 0, P: evaluate(s, 0, 0, 0).P, d2: Infinity };
  const refine = (u: number, v: number) => {
    let e = evaluate(s, u, v, 2);
    let r = sub(e.P, q), d2 = dot(r, r);
    for (let i = 0; i < 32; i++) {
      const fu = dot(r, e.Su), fv = dot(r, e.Sv);
      const a = dot(e.Su, e.Su) + dot(r, e.Suu), b = dot(e.Su, e.Sv) + dot(r, e.Suv), c = dot(e.Sv, e.Sv) + dot(r, e.Svv);
      const lockU = !s.u.closed && ((u === 0 && fu >= 0) || (u === 1 && fu <= 0));
      const lockV = !s.v.closed && ((v === 0 && fv >= 0) || (v === 1 && fv <= 0));
      const det = a * c - b * b;
      let du = lockU ? 0 : -fu / Math.max(a, dot(e.Su, e.Su), 1e-300);
      let dv = lockV ? 0 : -fv / Math.max(c, dot(e.Sv, e.Sv), 1e-300);
      if (!lockU && !lockV && a > 0 && det > a * c * 1e-12) {
        du = (b * fv - c * fu) / det;
        dv = (b * fu - a * fv) / det;
      }
      if (Math.max(Math.abs(du), Math.abs(dv)) < 1e-14) break;
      let accepted = false;
      for (let f = 1; f >= 1 / 1024; f *= 0.5) {
        const x = parameter(s.u, u + f * du), y = parameter(s.v, v + f * dv);
        if (x === u && y === v) continue;
        const next = evaluate(s, x, y, 2), delta = sub(next.P, q), d = dot(delta, delta);
        if (d > d2 + 8 * Number.EPSILON * d2) continue;
        u = x; v = y; e = next; r = delta; d2 = d;
        accepted = true;
        break;
      }
      if (!accepted) break;
    }
    if (d2 < best.d2) best = { u, v, P: e.P, d2 };
  };
  // Start from the coarse local minima, including minima on the open boundaries.
  for (let i = 0; i < U.length - Number(s.u.closed); i++) for (let j = 0; j < V.length - Number(s.v.closed); j++) {
    const d = cache[i][j];
    const un = i === 0 && s.u.closed ? U.length - 2 : i - 1;
    const vn = j === 0 && s.v.closed ? V.length - 2 : j - 1;
    const afterU = cache[i + 1]?.[j], afterV = cache[i][j + 1];
    if (d <= (cache[un]?.[j] ?? Infinity) && d <= (afterU ?? Infinity) &&
        d <= (cache[i][vn] ?? Infinity) && d <= (afterV ?? Infinity)) refine(U[i], V[j]);
  }
  return best;
}

export interface SurfaceMeshOptions {
  segments?: number | readonly [number, number];
  tolerance?: number;
}

function cvTolerance(s: NurbsSurface): number {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < s.P.length; i += 3) for (let c = 0; c < 3; c++) {
    lo[c] = Math.min(lo[c], s.P[i + c]);
    hi[c] = Math.max(hi[c], s.P[i + c]);
  }
  return Math.max(1e-9, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2000);
}

export function meshParams(s: NurbsSurface, o: SurfaceMeshOptions): [number[], number[]] {
  const us = spanBreaks(s.u), vs = spanBreaks(s.v);
  const [su, sv] = typeof o.segments === 'number' ? [o.segments, o.segments] : o.segments ?? [0, 0];
  const nu = su > 0 ? Math.max(1, Math.round(su)) : s.u.closed ? 3 : 2;
  const nv = sv > 0 ? Math.max(1, Math.round(sv)) : s.v.closed ? 3 : 2;
  const checkSize = (u: number, v: number) => {
    if (u * v > 1_000_000) throw new RangeError('NURBS surface conversion exceeds 1,000,000 faces. Lower segments or use a larger tolerance.');
  };
  checkSize((us.length - 1) * nu, (vs.length - 1) * nv);
  const U = samples(us, nu), V = samples(vs, nv);
  if (su > 0 && sv > 0) return [U, V];
  const tol = o.tolerance && o.tolerance > 0 ? o.tolerance : cvTolerance(s);
  const P = (u: number, v: number) => evaluate(s, u, v, 0).P;
  const bad = (p: Vec3, a: Vec3, b: Vec3, e: number) =>
    Math.hypot(p[0] - (a[0] + b[0]) / 2, p[1] - (a[1] + b[1]) / 2, p[2] - (a[2] + b[2]) / 2) > e;
  const mid = (axis: number[], i: number) => (axis[i] + axis[i + 1]) / 2;
  // Bisect a parameter interval across the entire surface when any sampled isoparm needs it.
  // Split the error budget between axes so it also bounds the bilinear face centre.
  for (let depth = 0; depth < 16; depth++) {
    const splitU = new Uint8Array(U.length - 1), splitV = new Uint8Array(V.length - 1);
    const rows = V.flatMap((v, j) => j + 1 < V.length ? [v, mid(V, j)] : [v]);
    const cols = U.flatMap((u, i) => i + 1 < U.length ? [u, mid(U, i)] : [u]);
    if (!(su > 0)) for (const v of rows) {
      let a = P(U[0], v);
      for (let i = 0; i + 1 < U.length; i++) {
        const b = P(U[i + 1], v);
        if (!splitU[i] && bad(P(mid(U, i), v), a, b, tol * 0.5)) splitU[i] = 1;
        a = b;
      }
    }
    if (!(sv > 0)) for (const u of cols) {
      let a = P(u, V[0]);
      for (let j = 0; j + 1 < V.length; j++) {
        const b = P(u, V[j + 1]);
        if (!splitV[j] && bad(P(u, mid(V, j)), a, b, tol * 0.5)) splitV[j] = 1;
        a = b;
      }
    }
    // A non-planar quad is drawn as two triangles. Check the centre of either diagonal.
    for (let j = 0; j + 1 < V.length; j++) for (let i = 0; i + 1 < U.length; i++) {
      if (splitU[i] || splitV[j]) continue;
      const p = P(mid(U, i), mid(V, j));
      if (bad(p, P(U[i], V[j]), P(U[i + 1], V[j + 1]), tol) ||
          bad(p, P(U[i + 1], V[j]), P(U[i], V[j + 1]), tol)) {
        if (!(su > 0)) splitU[i] = 1;
        if (!(sv > 0)) splitV[j] = 1;
      }
    }
    if (!splitU.includes(1) && !splitV.includes(1)) break;
    checkSize(U.length - 1 + splitU.reduce((a, b) => a + b, 0), V.length - 1 + splitV.reduce((a, b) => a + b, 0));
    for (let i = splitU.length - 1; i >= 0; i--) if (splitU[i]) U.splice(i + 1, 0, mid(U, i));
    for (let j = splitV.length - 1; j >= 0; j--) if (splitV[j]) V.splice(j + 1, 0, mid(V, j));
  }
  return [U, V];
}

/** Mesh a surface, preserving point, vertex and prim provenance. Returns the number of pole triangles. */
export function appendSurfaceMesh(b: GeoBuilder, g: Geometry, prim: number, s: NurbsSurface, o: SurfaceMeshOptions, origin?: number[]): number {
  const [U, V] = meshParams(s, o);
  const nu = U.length - Number(s.u.closed), nv = V.length - Number(s.v.closed);
  const n = b.attrib('point', 'N', 3), uv = b.attrib('vertex', 'uv', 3);
  const vn = g.vertices.has('N') ? b.attrib('vertex', 'N', 3) : null;
  const start = g.primStart[prim];
  // Detect a collapsed isoparm from its supported CVs. Interior CV rows alone do not define isoparms.
  const collapsed = (transverse: Spline, t: number, row: boolean) => {
    const { idx, b: weights } = basis(transverse, t, 0);
    let ref = -1;
    for (let a = 0; a < idx.length; a++) {
      if (!weights[a]) continue;
      for (let k = 0; k < (row ? s.cols : s.rows); k++) {
        const p = 3 * (row ? idx[a] * s.cols + k : k * s.cols + idx[a]);
        if (ref < 0) ref = p;
        else if (s.P[p] !== s.P[ref] || s.P[p + 1] !== s.P[ref + 1] || s.P[p + 2] !== s.P[ref + 2]) return false;
      }
    }
    return true;
  };
  const rowPole = V.slice(0, nv).map((v) => collapsed(s.v, v, true));
  const colPole = U.slice(0, nu).map((u) => collapsed(s.u, u, false));
  const trims = surfaceTrims(g, prim);
  if (trims) {
    // Mesh faces inherit the surface's attributes, but the trim arrays belong only to exact prims.
    if (b.src === g) {
      b.src = g.clone();
      meshSources.set(b, g);
    }
    if (meshSources.get(b) === g) setSurfaceTrims(b.src!, prim, null);
    return appendTrimmedMesh(b, prim, s, U, V, rowPole, colPole, trims,
      o.tolerance && o.tolerance > 0 ? o.tolerance : cvTolerance(s), n, uv, vn, start, origin);
  }
  const ids = new Int32Array(nu * nv), vsrc: Src[] = [], normals: Vec3[] = [];
  const joined = rowPole.includes(true) && colPole.includes(true);
  let joinedPole = -1;
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const k = j * nu + i, e = evaluate(s, U[i], V[j], 1, true);
    const pts = e.idx.map((cv) => s.points[cv]);
    vsrc[k] = { i: e.idx.map((cv) => start + cv), w: e.w };
    const onJoinedPole = joined && (rowPole[j] || colPole[i]);
    if (onJoinedPole && joinedPole >= 0) ids[k] = joinedPole;
    else if (rowPole[j] && i) ids[k] = ids[j * nu];
    else if (colPole[i] && j) ids[k] = ids[i];
    else {
      ids[k] = b.addPoint(...e.P, { i: pts, w: e.w });
      if (onJoinedPole) joinedPole = ids[k];
      const N = normal(s, U[i], V[j], e);
      n.set(ids[k], N);
      if (vn) normals[ids[k]] = N;
      if (origin) {
        let best = 0;
        for (let a = 1; a < e.w.length; a++) if (e.w[a] > e.w[best]) best = a;
        origin.push(pts[best]);
      }
    }
  }
  let triangles = 0;
  for (let j = 0; j + 1 < V.length; j++) for (let i = 0; i + 1 < U.length; i++) {
    const corners = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]];
    const pts: number[] = [], vs: Src[] = [], coords: number[][] = [];
    for (const [x, y] of corners) {
      const k = (y % nv) * nu + (x % nu), id = ids[k];
      if (pts.includes(id)) continue;
      pts.push(id); vs.push(vsrc[k]); coords.push([U[x], V[y], 0]);
    }
    if (pts.length < 3) continue;
    if (pts.length === 3) triangles++;
    const first = b.numVertices;
    b.addPrim(pts, true, prim, vs);
    coords.forEach((value, k) => {
      uv.set(first + k, value);
      vn?.set(first + k, normals[pts[k]]);
    });
  }
  return triangles;
}

const CLIP_SCALE = 4096;
const GRID_EPS = 1e-10;

function upperBound(axis: number[], t: number): number {
  let lo = 0, hi = axis.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (axis[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function gridLine(axis: number[], t: number): number {
  const i = upperBound(axis, t);
  if (i > 0 && t - axis[i - 1] <= GRID_EPS) return i - 1;
  return i < axis.length && axis[i] - t <= GRID_EPS ? i : -1;
}

/** Cells away from the contour need only a winding test. Keep grid crossings for both sides of each clipped edge. */
function trimGrid(loops: SurfaceUV[][], U: number[], V: number[], s: NurbsSurface) {
  const axes = [U, V], closed = [s.u.closed, s.v.closed];
  const w = U.length - 1, h = V.length - 1;
  const cells = new Uint8Array(w * h);
  const lines = axes.map((a) => a.map((): number[] => []));
  const scan = V.slice(1).map((b, j) => (V[j] + b) / 2);
  const crossings = scan.map((): [number, number][] => []);
  const mark = (i: number, j: number) => {
    if (i >= 0 && i < w && j >= 0 && j < h) cells[j * w + i] = 2;
  };
  const around = (axis: number, t: number): number[] => {
    const a = axes[axis], line = gridLine(a, t);
    if (line < 0) return [upperBound(a, t) - 1];
    if (closed[axis] && (line === 0 || line === a.length - 1)) return [a.length - 2, 0];
    return [line - 1, line];
  };
  const markPoint = ([u, v]: SurfaceUV) => {
    for (const i of around(0, u)) for (const j of around(1, v)) mark(i, j);
  };
  for (const loop of loops) for (let k = 0; k < loop.length; k++) {
    const a = loop[k], b = loop[(k + 1) % loop.length];
    const du = b[0] - a[0], dv = b[1] - a[1];
    if (dv) for (let j = upperBound(scan, Math.min(a[1], b[1])); j < h && scan[j] <= Math.max(a[1], b[1]); j++) {
      crossings[j].push([a[0] + du * (scan[j] - a[1]) / dv, dv > 0 ? -1 : 1]);
    }
    // The domain edges already belong to the grid. A trim reaches them through its other edges.
    if ((a[0] === b[0] && (a[0] === 0 || a[0] === 1)) || (a[1] === b[1] && (a[1] === 0 || a[1] === 1))) continue;
    const times = [0, 1];
    for (let d = 0; d < 2; d++) {
      const axis = axes[d], lo = Math.min(a[d], b[d]), hi = Math.max(a[d], b[d]);
      for (let i = upperBound(axis, lo); i < axis.length && axis[i] < hi; i++) times.push((axis[i] - a[d]) / (b[d] - a[d]));
    }
    times.sort((a, b) => a - b);
    const at = (t: number): SurfaceUV => [a[0] + du * t, a[1] + dv * t];
    for (let i = 0; i < times.length; i++) {
      const t = times[i], q = at(t);
      const u = gridLine(U, q[0]), v = gridLine(V, q[1]);
      if (u >= 0 && v < 0) lines[0][u].push(q[1]);
      if (v >= 0 && u < 0) lines[1][v].push(q[0]);
      markPoint(q);
      if (i > 0) markPoint(at((times[i - 1] + t) / 2));
    }
  }
  lines.forEach((rows, d) => {
    if (closed[d]) rows[0] = rows[rows.length - 1] = [...rows[0], ...rows[rows.length - 1]];
    rows.forEach((row, i) => {
      row.sort((a, b) => a - b);
      rows[i] = row.filter((x, j) => !j || x - row[j - 1] > GRID_EPS);
    });
  });
  for (let j = 0; j < h; j++) {
    const row = crossings[j].sort(([a], [b]) => a - b);
    let k = 0, winding = 0;
    for (let i = 0; i < w; i++) {
      const mid = (U[i] + U[i + 1]) / 2;
      while (k < row.length && row[k][0] <= mid) winding += row[k++][1];
      if (!cells[j * w + i] && winding > 0) cells[j * w + i] = 1;
    }
  }
  return { cells, lines };
}

/** Triangulate collapsed-free UV contours, restoring subdivisions on their boundary edges after earcut. */
function triangulateTrim(
  loops: SurfaceUV[][], edgePoints: (a: SurfaceUV, b: SurfaceUV) => SurfaceUV[], emit: (uv: SurfaceUV[]) => void,
) {
  const points: SurfaceUV[] = [], holes: number[] = [];
  const sides = new Map<string, SurfaceUV[]>();
  for (const loop of loops) {
    if (loop.length < 3) continue;
    // Earcut can drop collinear vertices. Keep their edges as chains to insert after triangulation.
    const corners = loop.flatMap((b, i) => {
      const a = loop[(i + loop.length - 1) % loop.length], c = loop[(i + 1) % loop.length];
      const x = b[0] - a[0], y = b[1] - a[1], r = c[0] - b[0], t = c[1] - b[1];
      return Math.abs(x * t - y * r) <= 2e-15 * (Math.hypot(x, y) + Math.hypot(r, t)) && x * r + y * t >= 0 ? [] : [i];
    });
    if (corners.length < 3) continue;
    if (points.length) holes.push(points.length);
    const base = points.length;
    corners.forEach((i, j) => {
      points.push(loop[i]);
      const next = (j + 1) % corners.length, end = corners[next], chain: SurfaceUV[] = [];
      for (let a = i; a !== end;) {
        const b = (a + 1) % loop.length;
        chain.push(...edgePoints(loop[a], loop[b]));
        if (b !== end) chain.push(loop[b]);
        a = b;
      }
      if (chain.length) {
        sides.set(`${base + j},${base + next}`, chain);
        sides.set(`${base + next},${base + j}`, chain.slice().reverse());
      }
    });
  }
  const indices = earcut(points.flat(), holes, 2);
  for (let i = 0; i < indices.length; i += 3) {
    const triangles = [indices.slice(i, i + 3)];
    while (triangles.length) {
      const face = triangles.pop()!;
      let split = false;
      for (let k = 0; k < 3; k++) {
        const a = face[k], b = face[(k + 1) % 3], c = face[(k + 2) % 3];
        const chain = sides.get(`${a},${b}`);
        if (!chain) continue;
        let prev = a;
        for (const q of chain) {
          const next = points.push(q) - 1;
          triangles.push([prev, next, c]);
          prev = next;
        }
        triangles.push([prev, b, c]);
        split = true;
        break;
      }
      if (!split) emit(face.map((j) => points[j]));
    }
  }
}

type SurfaceAttribute = ReturnType<GeoBuilder['attrib']>;

function appendTrimmedMesh(
  b: GeoBuilder, prim: number, s: NurbsSurface, U: number[], V: number[], rowPole: boolean[], colPole: boolean[],
  loops: SurfaceUV[][], tol: number, n: SurfaceAttribute, uv: SurfaceAttribute, vn: SurfaceAttribute | null, start: number,
  origin?: number[],
): number {
  const { cells, lines } = trimGrid(loops, U, V, s);
  const scaled = (loop: SurfaceUV[]): SurfaceUV[] => loop.map(([u, v]) => [u * CLIP_SCALE, v * CLIP_SCALE]);
  const region = crossSection(loops.map(scaled), 'Positive');
  const points = new Map<string, number>();
  const vertices = new Map<string, { id: number; src: Src }>();
  const normals: Vec3[] = [];
  const joined = rowPole.includes(true) && colPole.includes(true);
  const vertex = ([u, v]: SurfaceUV) => {
    const x = u === 1 && s.u.closed ? 0 : u, y = v === 1 && s.v.closed ? 0 : v;
    const key = `${x},${y}`, prev = vertices.get(key);
    if (prev) return prev;
    const row = rowPole[gridLine(V, y)], col = colPole[gridLine(U, x)];
    const pole = row || col ? joined ? 'pole' : row ? `row${y}` : `col${x}` : key;
    let id = points.get(pole);
    const e = evaluate(s, x, y, 1, true);
    if (id === undefined) {
      const pts = e.idx.map((cv) => s.points[cv]);
      id = b.addPoint(...e.P, { i: pts, w: e.w });
      points.set(pole, id);
      const N = normal(s, x, y, e);
      n.set(id, N);
      if (vn) normals[id] = N;
      if (origin) origin.push(pts[e.w.indexOf(Math.max(...e.w))]);
    }
    const value = { id, src: { i: e.idx.map((cv) => start + cv), w: e.w } };
    vertices.set(key, value);
    return value;
  };
  let poleTriangles = 0;
  const emit = (corners: SurfaceUV[]) => {
    const ids: number[] = [], srcs: Src[] = [], coords: SurfaceUV[] = [];
    for (const q of corners) {
      const { id, src } = vertex(q);
      if (ids.includes(id)) continue;
      ids.push(id); srcs.push(src); coords.push(q);
    }
    if (ids.length < 3) return;
    if (corners.length === 4 && ids.length === 3) poleTriangles++;
    const first = b.numVertices;
    b.addPrim(ids, true, prim, srcs);
    coords.forEach(([u, v], k) => {
      uv.set(first + k, [u, v, 0]);
      vn?.set(first + k, normals[ids[k]]);
    });
  };
  try {
    const w = U.length - 1;
    for (let j = 0; j + 1 < V.length; j++) for (let i = 0; i < w; i++) {
      const cell = cells[j * w + i];
      if (!cell) continue;
      const u = U[i], x = U[i + 1], v = V[j], y = V[j + 1];
      const rect: SurfaceUV[] = [[u, v], [x, v], [x, y], [u, y]];
      if (cell === 1) { emit(rect); continue; }
      const sides = [[lines[0][i], lines[0][i + 1]], [lines[1][j], lines[1][j + 1]]];
      const snap = (q: number, values: number[]) => {
        const k = upperBound(values, q + GRID_EPS) - 1;
        return k >= 0 && Math.abs(values[k] - q) <= GRID_EPS ? values[k] : q;
      };
      const side = (a: number, lo: number, hi: number) => Math.abs(a - lo) <= GRID_EPS ? 0 : Math.abs(a - hi) <= GRID_EPS ? 1 : -1;
      const canonical = ([a, d]: SurfaceUV): SurfaceUV => {
        a /= CLIP_SCALE; d /= CLIP_SCALE;
        const i = side(a, u, x), j = side(d, v, y);
        return [i === 0 ? u : i === 1 ? x : j < 0 ? a : snap(a, sides[1][j]),
          j === 0 ? v : j === 1 ? y : i < 0 ? d : snap(d, sides[0][i])];
      };
      const edgePoints = (a: SurfaceUV, b: SurfaceUV): SurfaceUV[] => {
        const fixed = a[0] === b[0] && side(a[0], u, x) >= 0 ? 0 : a[1] === b[1] && side(a[1], v, y) >= 0 ? 1 : -1;
        if (fixed === -1) return sampleTrimSegment(s, a, b, tol);
        const d = fixed === 0 ? 1 : 0, on = side(a[fixed], rect[0][fixed], rect[2][fixed]);
        const ms = sides[fixed][on], min = Math.min(a[d], b[d]), max = Math.max(a[d], b[d]);
        const out: SurfaceUV[] = [];
        for (let k = upperBound(ms, min + GRID_EPS); k < ms.length && ms[k] < max - GRID_EPS; k++) {
          out.push(fixed === 0 ? [a[0], ms[k]] : [ms[k], a[1]]);
        }
        return a[d] < b[d] ? out : out.reverse();
      };
      const clip = region.intersect([scaled(rect)]);
      try {
        for (const part of clip.decompose()) {
          let contours: SurfaceUV[][];
          try { contours = (part.toPolygons() as SurfaceUV[][]).map((loop) => loop.map(canonical)); }
          finally { part.delete(); }
          const clean = contours.map((loop) => loop.filter(([x, y], k) => {
            const q = loop[(k + 1) % loop.length];
            return q[0] !== x || q[1] !== y;
          }));
          if (clean.length === 1 && clean[0].length === 4 &&
              rect.every(([u, v]) => clean[0].some(([x, y]) => u === x && v === y)) &&
              rect.every((q, k) => !edgePoints(q, rect[(k + 1) % 4]).length)) emit(rect);
          else triangulateTrim(clean, edgePoints, emit);
        }
      } finally { clip.delete(); }
    }
  } finally { region.delete(); }
  return poleTriangles;
}
