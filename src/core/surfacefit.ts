import { GeoBuilder } from './geometry.ts';
import type { Geometry } from './geometry.ts';
import { cross, dot, sub } from './math.ts';
import type { Vec3 } from './math.ts';
import { MAX_ORDER, curveParams, evalDerivs, evalPoint, fitKnots, fitSpline, makeSpline } from './splines.ts';
import type { FitResult, Parameterization } from './splines.ts';

export interface SurfaceSection {
  pts: number[][];
  closed: boolean;
  pins?: number[];
}

interface SurfaceFitOptions {
  fit?: 'interpolate' | 'approximate';
  closedV?: boolean;
  order?: [number, number];
  cvs?: [number, number];
  tolerance?: number;
  smoothing?: number;
  mode?: Parameterization;
  /** Sections built by mirrorSection. */
  mirror?: boolean;
}

export interface SurfaceFit {
  P: Float64Array;
  cols: number;
  rows: number;
  knotsU: Float64Array;
  knotsV: Float64Array;
  orderU: number;
  orderV: number;
  closedU: boolean;
  closedV: boolean;
  error: number;
  /** Parameters of each input point, indexed by section and then by point. */
  params: [number, number][][];
  pinnedSections: number;
  /** Approximate fits: the smoothing used in u and v (lower than requested when the request missed the tolerance). */
  smoothing?: [number, number];
}

export function mirrorSection(section: SurfaceSection, index: number): SurfaceSection {
  const { pts, pins } = section;
  pts.forEach((q, i) => {
    if (q[0] < -1e-6) throw new Error(`mirror x: section ${index + 1}, point ${i + 1} has negative x`);
  });
  const last = pts.length - 1;
  const start = Math.abs(pts[0][0]) <= 1e-4, end = Math.abs(pts[last][0]) <= 1e-4;
  if (!start && !end) throw new Error(`mirror x: section ${index + 1} needs an end on x = 0`);
  const indices = pts.map((_, i) => i);
  if (start && !end) indices.reverse();
  const reflected = indices.filter((i) => !(i === 0 && start) && !(i === last && end)).reverse();
  const pinned = new Set(pins);
  const fullPins: number[] = [];
  const full = [...indices, ...reflected].map((k, i) => {
    if (pinned.has(k)) fullPins.push(i);
    const [x, y, z] = pts[k];
    return [(k === 0 && start) || (k === last && end) ? 0 : i >= pts.length ? -x : x, y, z];
  });
  return { pts: full, closed: start && end, pins: fullPins };
}

const distance = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const mod = (i: number, n: number) => i < 0 ? (i % n + n) % n : i % n;
const point = (P: Float64Array, i: number): Vec3 => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];

function centroid({ pts }: SurfaceSection): Vec3 {
  const c: Vec3 = [0, 0, 0];
  for (const p of pts) for (let k = 0; k < 3; k++) c[k] += p[k] / pts.length;
  return c;
}

function stationParams(sections: SurfaceSection[], closed: boolean, same: boolean, mode: Parameterization): Float64Array {
  if (!same || mode === 'uniform') return curveParams(sections.flatMap(centroid), closed, mode);
  const count = sections.length, n = sections[0].pts.length;
  const t = new Float64Array(count + Number(closed));
  for (let j = 1; j < t.length; j++) {
    const a = sections[j - 1].pts, b = sections[j % count].pts;
    let d = 0;
    for (let i = 0; i < n; i++) {
      const l = distance(a[i], b[i]);
      d += mode === 'chord' ? l : Math.sqrt(l);
    }
    t[j] = t[j - 1] + d / n;
  }
  const total = t[t.length - 1];
  return t.map((x, i) => total > 0 ? x / total : i / (t.length - 1));
}

/** Treat opposite samples identically under u → 1 − u. */
function symmetric(t: Float64Array): Float64Array {
  const last = t.length - 1;
  for (let i = 1; i <= last / 2; i++) {
    t[i] = (t[i] + (1 - t[last - i])) / 2;
    t[last - i] = 1 - t[i];
  }
  return t;
}

interface Direction {
  knots: Float64Array;
  at(t: number): number;
}

function direction(t: Float64Array, closed: boolean, order: number, cvs: number, mirror = false): Direction {
  if (!closed) {
    const knots = fitKnots(t, false, order, cvs);
    return { knots: mirror ? symmetric(knots) : knots, at: (u) => u };
  }
  // The even-degree system uses midpoints between breaks. Put the origin at the last midpoint before zero.
  const b = cvs + 1 === t.length ? t.slice() : fitKnots(t, true, 4, cvs);
  if (mirror) symmetric(b);
  if (order % 2 === 0) return { knots: b, at: (u) => u };
  const knots = b.map((q, i) => (q + (i ? b[i - 1] : b[cvs - 1] - 1)) / 2);
  return { knots, at: (u) => mod(u - knots[0], 1) };
}

/** Insert one knot without changing the curve. A periodic insertion also changes its periodic copies. */
function insertKnot(curve: FitResult, t: number): FitResult {
  const { P, knots, order, closed } = curve, n = P.length / 3, p = order - 1;
  let k = 0;
  while (knots[k + 1] <= t) k++;
  const K = Float64Array.from([...knots.subarray(0, k + 1), t, ...knots.subarray(k + 1)]);
  const Q = new Float64Array((n + 1) * 3);
  const knot = (i: number) => closed ? knots[mod(i, n)] + Math.floor(i / n) : knots[i];
  const first = closed ? k + 1 : k - p + 1, last = closed ? k + p : k;
  for (let i = closed ? first : 0; i < (closed ? first + n + 1 : n + 1); i++) {
    const j = mod(i, n + 1);
    if (i < first) Q.set(P.subarray(i * 3, i * 3 + 3), j * 3);
    else if (i > last) {
      const a = mod(i - 1, n);
      Q.set(P.subarray(a * 3, a * 3 + 3), j * 3);
    } else {
      const a = closed ? i - p : i, b = i + Number(!closed) * p;
      const f = (t - knot(a)) / (knot(b) - knot(a));
      const left = point(P, mod(i - 1, n)), right = point(P, mod(i, n));
      for (let d = 0; d < 3; d++) Q[j * 3 + d] = (1 - f) * left[d] + f * right[d];
    }
  }
  return { ...curve, P: Q, knots: K };
}

/** Give periodic curves the same domain before forming the union of their knots. */
function startAtZero(curve: FitResult): FitResult {
  if (!curve.closed || curve.knots[0] === 0) return curve;
  if (!curve.knots.includes(0)) curve = insertKnot(curve, 0);
  const n = curve.P.length / 3, start = curve.knots.indexOf(0);
  const P = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) P.set(point(curve.P, (start + i) % n), i * 3);
  const knots = Float64Array.from({ length: n + 1 }, (_, i) => {
    const j = start + i;
    return curve.knots[j % n] + Math.floor(j / n);
  });
  return { ...curve, P, knots };
}

function multiplicities(knots: Float64Array): Map<number, number> {
  const m = new Map<number, number>();
  for (const t of knots) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

function compatible(curves: FitResult[]): FitResult[] {
  const aligned = curves.map(startAtZero), union = new Map<number, number>();
  for (const r of aligned) for (const [t, n] of multiplicities(r.knots)) union.set(t, Math.max(union.get(t) ?? 0, n));
  const ordered = [...union].sort(([a], [b]) => a - b);
  return aligned.map((r) => {
    const have = multiplicities(r.knots);
    for (const [t, n] of ordered) for (let i = have.get(t) ?? 0; i < n; i++) r = insertKnot(r, t);
    return r;
  });
}

interface Candidate<T> { value: T; error: number }

/** Grow and bisect the CV count, as in curve fitting. */
function search<T>(min: number, max: number, tolerance: number, fit: (n: number) => Candidate<T>): Candidate<T> {
  let hi = min, lo = min - 1, best = fit(hi);
  while (best.error > tolerance && hi < max) {
    lo = hi;
    hi = Math.min(max, Math.ceil(hi * 1.6) + 1);
    best = fit(hi);
  }
  while (hi - lo > 1 && best.error <= tolerance) {
    const mid = (lo + hi) >> 1, candidate = fit(mid);
    if (candidate.error <= tolerance) { hi = mid; best = candidate; } else lo = mid;
  }
  return best;
}

/**
 * The fewest CVs within tolerance at the requested penalty. When no count fits at that penalty, the largest smaller
 * penalty that fits; `penalty` says which one was used, so the caller can report it.
 */
function fair<T>(min: number, max: number, tolerance: number, smoothing: number, fit: (n: number, penalty: number) => Candidate<T>): Candidate<T> & { penalty: number } {
  const preferred = search(min, max, tolerance, (n) => fit(n, smoothing));
  if (preferred.error <= tolerance || smoothing === 0) return { ...preferred, penalty: smoothing };
  let best = { ...search(min, max, tolerance, (n) => fit(n, 0)), penalty: 0 };
  if (best.error > tolerance) return best;
  let lo = 0, hi = smoothing;
  // At each penalty, search for the smallest feasible CV count.
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    const candidate = search(min, max, tolerance, (n) => fit(n, mid));
    if (candidate.error <= tolerance) { best = { ...candidate, penalty: mid }; lo = mid; } else hi = mid;
  }
  return best;
}

function fitColumn(Q: ArrayLike<number>, t: Float64Array, d: Direction, closed: boolean, order: number, cvs: number, smoothing = 0, pins?: number[]) {
  const params = t.subarray(0, t.length - Number(closed)).map(d.at);
  return fitSpline(Q, { params, knots: d.knots, closed, order, cvs, smoothing, pins, corrections: 0 });
}

/** Fit a tensor-product NURBS surface through ordered sections. */
export function fitSurface(sections: SurfaceSection[], o: SurfaceFitOptions = {}): SurfaceFit {
  if (sections.length < 2) throw new Error('loft needs at least 2 curves');
  const closedU = sections[0].closed, closedV = !!o.closedV, n = sections.length;
  if (closedV && n < 3) throw new Error('closed: use at least 3 sections to close a surface in v');
  if (sections.some((s) => s.closed !== closedU)) throw new Error('loft sections must be all closed or all open');
  const counts = sections.map((s) => s.pts.length), minU = Math.min(...counts), maxU = Math.max(...counts);
  if (minU < (closedU ? 3 : 2)) throw new Error('loft sections need at least 2 points when open and 3 when closed');
  const [ou, ov] = o.order ?? [4, 4], [cu, cv] = o.fit === 'approximate' ? o.cvs ?? [0, 0] : [0, 0];
  const orderU = Math.max(2, Math.min(ou, minU, cu || MAX_ORDER, MAX_ORDER));
  const orderV = Math.max(2, Math.min(ov, n, cv || MAX_ORDER, MAX_ORDER));
  const same = minU === maxU, mode = o.mode ?? 'centripetal';
  const data = sections.map((s) => Float64Array.from(s.pts.flat()));
  const u = data.map((P) => {
    const t = curveParams(P, closedU, mode);
    return o.mirror ? symmetric(t) : t;
  });
  const v = stationParams(sections, closedV, same, mode);
  const vPins = sections.flatMap((s, j) => s.pins?.length ? [j] : []);

  function skin(uFits: FitResult[], dv: Direction, rows: number, smoothing: number, pins?: number[]): SurfaceFit {
    const cols = uFits[0].P.length / 3, P = new Float64Array(cols * rows * 3);
    const Q = new Float64Array(n * 3);
    const sectionRows = Array.from({ length: n }, () => new Float64Array(cols * 3));
    const vParams = v.subarray(0, n).map(dv.at);
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < n; j++) Q.set(point(uFits[j].P, i), j * 3);
      const r = fitColumn(Q, v, dv, closedV, orderV, rows, smoothing, pins);
      for (let j = 0; j < rows; j++) P.set(point(r.P, j), (j * cols + i) * 3);
      const column = makeSpline('nurbs', r.P, r);
      for (let j = 0; j < n; j++) sectionRows[j].set(evalPoint(column, vParams[j]), i * 3);
    }
    const knotsU = uFits[0].knots, knotsV = dv.knots;
    let error = 0;
    const params = sectionRows.map((row, j) => {
      const s = makeSpline('nurbs', row, { knots: knotsU, closed: closedU, order: orderU });
      return Array.from(uFits[j].params, (t, i): [number, number] => {
        error = Math.max(error, distance(evalPoint(s, t), sections[j].pts[i]));
        return [t, vParams[j]];
      });
    });
    return { P, cols, rows, knotsU, knotsV, orderU, orderV, closedU, closedV, error, params, pinnedSections: vPins.length };
  }

  function interpolate(): SurfaceFit {
    const avg = same ? u[0].map((_, i) => u.reduce((sum, t) => sum + t[i], 0) / n) : u[0];
    const common = direction(avg, closedU, orderU, maxU, o.mirror);
    const dv = direction(v, closedV, orderV, n);
    if (same) {
      const r = skin(data.map((Q, j) => fitColumn(Q, u[j], common, closedU, orderU, maxU)), dv, n, 0);
      if (r.error <= 1e-6) return r;
    }
    const curves = data.map((Q, j) => {
      const d = direction(u[j], closedU, orderU, counts[j], o.mirror);
      return { ...fitColumn(Q, u[j], d, closedU, orderU, counts[j]), params: u[j].subarray(0, counts[j]) };
    });
    const r = skin(compatible(curves), dv, n, 0);
    if (!(r.error <= 1e-6)) throw new Error('fit interpolate: could not pass through all points. Remove coincident or unevenly spaced samples');
    return r;
  }

  let result: SurfaceFit;
  if (o.fit !== 'approximate') result = interpolate();
  else {
    const tolerance = o.tolerance ?? 0.001, smoothing = o.smoothing ?? 0;
    const pool = u.flatMap((t) => Array.from(t.subarray(0, t.length - Number(closedU)))).sort((a, b) => a - b);
    if (closedU) pool.push(1);
    const union = Float64Array.from(pool);
    const uPins = Math.max(...sections.map((s) => s.pins?.length ?? 0));
    const uFit = (cols: number, penalty: number): Candidate<FitResult[]> => {
      const d = direction(union, closedU, orderU, cols, o.mirror);
      const value = data.map((Q, j) => fitColumn(Q, u[j], d, closedU, orderU, cols, penalty, sections[j].pins));
      return { value, error: Math.max(...value.map((r) => r.error)) };
    };
    // Leave room for error from the v pass when allocating the tolerance in u.
    const uf = cu > 0 ? { ...uFit(Math.max(orderU, closedU ? 3 : 2, Math.min(cu, maxU)), smoothing), penalty: smoothing }
      : fair(Math.min(maxU, Math.max(closedU ? 3 : 2, orderU + uPins)), maxU, tolerance / 2, smoothing, uFit);
    const vFit = (rows: number, penalty: number): Candidate<SurfaceFit> => {
      const value = skin(uf.value, direction(v, closedV, orderV, rows), rows, penalty, vPins);
      return { value, error: value.error };
    };
    const vf = cv > 0 ? { ...vFit(Math.max(orderV, closedV ? 3 : 2, Math.min(cv, n)), smoothing), penalty: smoothing }
      : fair(Math.min(n, Math.max(closedV ? 3 : 2, orderV + vPins.length)), n, tolerance, smoothing, vFit);
    result = { ...vf.value, smoothing: [uf.penalty, vf.penalty] };
    if (!cu && !cv && result.error > tolerance) result = { ...interpolate(), smoothing: [0, 0] };
  }
  if (closedU) orientSectionOutward(result, sections[Math.floor(n / 2)], Math.floor(n / 2));
  return result;
}

function orientSectionOutward(s: SurfaceFit, section: SurfaceSection, j: number) {
  const center = centroid(section), v = s.params[j][0][1];
  const U = new Float64Array(s.cols * 3), V = new Float64Array(U.length);
  for (let i = 0; i < s.cols; i++) {
    const pts = Array.from({ length: s.rows }, (_, r) => point(s.P, r * s.cols + i)).flat();
    const d = evalDerivs(makeSpline('nurbs', pts, { knots: s.knotsV, order: s.orderV, closed: s.closedV }), v);
    U.set(d.P, i * 3);
    V.set(d.d1, i * 3);
  }
  const o = { knots: s.knotsU, order: s.orderU, closed: true };
  const up = makeSpline('nurbs', U, o), vp = makeSpline('nurbs', V, o);
  let facing = 0;
  for (const [u] of s.params[j]) {
    const a = evalDerivs(up, u);
    facing += dot(cross(a.d1, evalPoint(vp, u) as Vec3), sub(a.P, center));
  }
  if (facing >= 0) return;
  const P = s.P.slice();
  for (let r = 0; r < s.rows; r++) for (let i = 0; i < s.cols; i++) {
    const source = mod(s.orderU - 2 - i, s.cols);
    s.P.set(point(P, r * s.cols + source), (r * s.cols + i) * 3);
  }
  const K = s.knotsU;
  s.knotsU = K.map((_, i) => K[0] + (K[s.cols] - K[s.cols - i]));
  for (const row of s.params) for (const uv of row) uv[0] = (1 - uv[0]) % 1;
}

/** Write one surface prim with row-major CVs and unit weights. */
export function addSurfacePrim(s: SurfaceFit): Geometry {
  const b = new GeoBuilder(), ids: number[] = [];
  for (let i = 0; i < s.cols * s.rows; i++) ids.push(b.addPoint(...point(s.P, i)));
  b.addPrim(ids, s.closedU);
  const g = b.build().ensurePacked();
  g.primKind![0] = 4;
  g.prims.add('surface_cols', 'int', 1).set(0, s.cols);
  g.prims.add('spline_order', 'int', 1).set(0, s.orderU);
  g.prims.add('spline_order_v', 'int', 1).set(0, s.orderV);
  g.prims.add('closed_v', 'int', 1).set(0, Number(s.closedV));
  g.prims.add('knots', 'float[]', 1).set(0, Array.from(s.knotsU));
  g.prims.add('knots_v', 'float[]', 1).set(0, Array.from(s.knotsV));
  g.prims.add('name', 'string', 1).set(0, 'surface');
  g.detail.add('fit_error', 'float', 1).set(0, s.error);
  return g;
}
