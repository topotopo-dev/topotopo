import { GeoBuilder } from './geometry.ts';
import type { Geometry } from './geometry.ts';
import { cross, dot, sub } from './math.ts';
import type { Vec3 } from './math.ts';
import { MAX_ORDER, arcTable, curveParams, evalDerivs, evalPoint, fitKnots, fitSpline, lengthAtU, makeSpline, spanBreaks } from './splines.ts';
import type { FitResult, Parameterization, Spline } from './splines.ts';
import { setSurfacePrim } from './nurbssurface.ts';

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

interface NetworkCurve {
  closed: boolean;
  breaks: number[];
  eval(u: number): ReturnType<typeof evalDerivs>;
  length(u: number): number;
}

/** Use the actual spline, including its weights. An exact half can also be evaluated on its reflection. */
export function networkCurve(s: Spline, mirrorHalf = false): NetworkCurve {
  const tab = arcTable(s, 2), breaks = spanBreaks(s);
  if (!(tab.total > 0)) throw new Error('loft: a network curve has no length. Supply a curve with distinct points.');
  const length = (u: number) => lengthAtU(s, tab, u) / tab.total;
  if (!mirrorHalf) return { closed: s.closed, breaks, eval: (u) => evalDerivs(s, u), length };
  const start = Math.abs(evalPoint(s, 0)[0]) <= 1e-4, end = Math.abs(evalPoint(s, 1)[0]) <= 1e-4;
  const reverse = start && !end;
  const halfLength = (u: number) => reverse ? 1 - length(1 - u) : length(u);
  const halfBreaks = reverse ? breaks.slice().reverse().map((u) => 1 - u) : breaks;
  return {
    closed: start && end,
    breaks: [...halfBreaks.map((u) => u / 2), ...halfBreaks.slice(0, -1).reverse().map((u) => 1 - u / 2)],
    eval: (u) => {
      const reflected = u > 0.5, t = 2 * (reflected ? 1 - u : u);
      const e = evalDerivs(s, reverse ? 1 - t : t);
      if ((t === 0 && start && end) || t === 1) e.P[0] = 0;
      const sign = reflected ? -1 : 1, dt = 2 * sign * (reverse ? -1 : 1);
      e.P[0] *= sign;
      for (let k = 0; k < 3; k++) {
        e.d1[k] *= dt * (k === 0 ? sign : 1);
        e.d2[k] *= 4 * (k === 0 ? sign : 1);
      }
      return e;
    },
    length: (u) => u <= 0.5 ? halfLength(2 * u) / 2 : 1 - halfLength(2 - 2 * u) / 2,
  };
}

const unit = (t: number, closed: boolean) => closed ? mod(t, 1) : Math.max(0, Math.min(1, t));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const EPS_PARAM = 1e-12;

function sampleSpans(breaks: number[], minimum: number) {
  const samples: number[] = [];
  for (let i = 1; i < breaks.length; i++) {
    const a = breaks[i - 1], b = breaks[i], n = Math.max(3, Math.ceil((b - a) * minimum));
    for (let k = 0; k < n; k++) if (b > a) samples.push(lerp(a, b, k / n));
  }
  samples.push(1);
  return samples;
}

function crossingSamples(curve: NetworkCurve) {
  const t = sampleSpans(curve.breaks, 24);
  if (curve.closed) t.pop();
  return { curve, t, P: t.map((u) => curve.eval(u).P) };
}

type CrossingSamples = ReturnType<typeof crossingSamples>;

function closestCrossing(a: CrossingSamples, b: CrossingSamples, tolerance: number) {
  const na = a.t.length, nb = b.t.length;
  const gaps = a.P.map((p) => Float64Array.from(b.P, (q) => {
    const dx = p[0] - q[0], dy = p[1] - q[1], dz = p[2] - q[2];
    return dx * dx + dy * dy + dz * dz;
  }));
  const cap = (i: number, n: number, closed: boolean) => closed ? mod(i, n) : i;
  const paramDistance = (u: number, v: number, closed: boolean) => closed ? Math.min(Math.abs(u - v), 1 - Math.abs(u - v)) : Math.abs(u - v);
  const hits: { u: number; v: number }[] = [];
  let best = { u: 0, v: 0, P: [0, 0, 0] as Vec3, gap: Infinity };
  for (let i = 0; i < na; i++) for (let j = 0; j < nb; j++) {
    const d = gaps[i][j];
    if (d > (gaps[cap(i - 1, na, a.curve.closed)]?.[j] ?? Infinity) ||
        d > (gaps[cap(i + 1, na, a.curve.closed)]?.[j] ?? Infinity) ||
        d > (gaps[i][cap(j - 1, nb, b.curve.closed)] ?? Infinity) ||
        d > (gaps[i][cap(j + 1, nb, b.curve.closed)] ?? Infinity)) continue;
    let u = a.t[i], v = b.t[j], x = a.curve.eval(u), y = b.curve.eval(v);
    let r = sub(x.P, y.P), dd = dot(r, r);
    for (let step = 0; step < 24; step++) {
      const f = dot(r, x.d1), g = -dot(r, y.d1), aa = dot(x.d1, x.d1), bb = -dot(x.d1, y.d1), cc = dot(y.d1, y.d1);
      const lockU = !a.curve.closed && ((u === 0 && f >= 0) || (u === 1 && f <= 0));
      const lockV = !b.curve.closed && ((v === 0 && g >= 0) || (v === 1 && g <= 0));
      const h = aa + dot(r, x.d2), k = cc - dot(r, y.d2), det = h * k - bb * bb;
      let du = lockU ? 0 : -f / Math.max(aa, h, 1e-300), dv = lockV ? 0 : -g / Math.max(cc, k, 1e-300);
      if (!lockU && !lockV && h > 0 && det > h * k * 1e-12) {
        du = (bb * g - k * f) / det;
        dv = (bb * f - h * g) / det;
      }
      if (Math.max(Math.abs(du), Math.abs(dv)) < 1e-14) break;
      let moved = false;
      for (let scale = 1; scale >= 1 / 1024; scale *= 0.5) {
        const nextU = unit(u + scale * du, a.curve.closed), nextV = unit(v + scale * dv, b.curve.closed);
        const nx = a.curve.eval(nextU), ny = b.curve.eval(nextV), nr = sub(nx.P, ny.P), next = dot(nr, nr);
        if (next >= dd) continue;
        u = nextU; v = nextV; x = nx; y = ny; r = nr; dd = next; moved = true;
        break;
      }
      if (!moved) break;
    }
    const gap = Math.sqrt(dd);
    if (gap <= tolerance && !hits.some((p) => paramDistance(p.u, u, a.curve.closed) < 1e-6 && Math.abs(p.v - v) < 1e-6)) hits.push({ u, v });
    if (gap < best.gap) best = { u, v, P: x.P.map((q, k) => (q + y.P[k]) / 2) as Vec3, gap };
  }
  const snap = (t: number, closed: boolean) => t < EPS_PARAM ? 0 : t > 1 - EPS_PARAM ? Number(!closed) : t;
  return { ...best, u: snap(best.u, a.curve.closed), v: snap(best.v, b.curve.closed), hits: hits.length };
}

type NetCrossing = ReturnType<typeof closestCrossing>;

/** Map each common span back onto the source with a monotone cubic. Shared slopes avoid kinks at the pins. */
function networkSamples(curve: NetworkCurve, original: number[], common: number[], pins: Vec3[], phase: number, mirror: boolean, density: number, fitSpans: number[]) {
  const source = original.slice(), target = common.slice();
  if (target[0] > 0) { target.unshift(0); source.unshift(0); }
  if (target.at(-1)! < 1) { target.push(1); source.push(1); }
  if (mirror && !target.includes(0.5)) {
    const i = target.findIndex((u) => u > 0.5);
    target.splice(i, 0, 0.5); source.splice(i, 0, 0.5);
  }
  const secants = source.slice(1).map((u, i) => (u - source[i]) / (target[i + 1] - target[i]));
  const mean = (a: number, b: number) => a > 0 && b > 0 ? 2 * a * b / (a + b) : 0;
  const slopes = source.map((_, i) => i > 0 && i < secants.length ? mean(secants[i - 1], secants[i])
    : curve.closed ? mean(secants[0], secants.at(-1)!) : i === 0 ? secants[0] : secants.at(-1)!);
  const at = (i: number, u: number) => {
    const width = target[i + 1] - target[i], t = (u - target[i]) / width;
    return lerp(source[i], source[i + 1], t) + width * t * (1 - t) *
      ((1 - t) * (slopes[i] - secants[i]) - t * (slopes[i + 1] - secants[i]));
  };
  const params = sampleSpans([...new Set([...target, ...fitSpans])].sort((a, b) => a - b), density);
  if (curve.closed) params.pop();
  // Include samples inside each source knot span, even if it maps to a very narrow interval.
  for (const t of sampleSpans(curve.breaks, 0)) {
    const x = unit(t - phase, curve.closed), i = source.findIndex((q) => q > x) - 1;
    if (i < 0 || x - source[i] <= EPS_PARAM || source[i + 1] - x <= EPS_PARAM) continue;
    let a = target[i], b = target[i + 1];
    for (let k = 0; k < 42; k++) {
      const m = (a + b) / 2;
      if (at(i, m) > x) b = m; else a = m;
    }
    params.push((a + b) / 2);
  }
  params.sort((a, b) => a - b);
  let i = 0;
  const points = params.map((u) => {
    while (i < target.length - 2 && u >= target[i + 1]) i++;
    return curve.eval(unit(at(i, u) + phase, curve.closed)).P;
  });
  const indices = common.map((u) => params.indexOf(u)), Q = points.map((q) => q.slice());
  indices.forEach((k, j) => { Q[k] = pins[j]; });
  return { params, points, Q: Q.flat(), pins: indices };
}

/** A family of interpolation weights in one shared spline basis. */
function networkWeights(params: number[], order: number, closed: boolean, mirror: boolean) {
  const stations = params.map((t, i) => ({ t, left: i, right: i }));
  if (closed) while (stations.length < Math.max(3, order)) {
    // Add stations only when a periodic basis needs more CVs than there are curves.
    let k = 0, width = 0;
    for (let i = 0; i < stations.length; i++) {
      const span = (stations[i + 1]?.t ?? stations[0].t + 1) - stations[i].t;
      if (span > width) { k = i; width = span; }
    }
    const mid = mod(stations[k].t + width / 2, 1), opposite = mod(1 - mid, 1);
    for (const t of mirror ? [mid, opposite] : [mid]) {
      if (stations.some((s) => Math.abs(s.t - t) <= EPS_PARAM)) continue;
      let j = params.findIndex((u) => u > t);
      if (j < 0) j = 0;
      stations.push({ t, left: mod(j - 1, params.length), right: j });
    }
    stations.sort((a, b) => a.t - b.t);
  }
  if (stations.length === 1) {
    return [{ P: Float64Array.from({ length: order * 3 }, (_, i) => Number(i % 3 === 0)), knots: fitKnots(Float64Array.of(0, 1), false, order, order), order, closed, params: Float64Array.of(params[0]), error: 0 }];
  }
  const n = stations.length;
  const t = Float64Array.from(stations.map((s) => s.t));
  const start = (order % 2 === 0 || !closed) ? t[0] : (t[0] + t[n - 1] - 1) / 2;
  const periodic = closed ? Float64Array.from({ length: n + 1 }, (_, i) => i === n ? start + 1
    : order % 2 === 0 ? t[i] : i === 0 ? start : (t[i] + t[i - 1]) / 2) : null;
  if (periodic && start > 0) for (let i = 0; i < periodic.length; i++) periodic[i] -= 1;
  const weights = params.map((_, i) => {
    const Q = stations.flatMap((s) => [(Number(s.left === i) + Number(s.right === i)) / 2, 0, 0]);
    // Open interpolation fixes its ends, so interior rail parameters need a clamped domain extending to them.
    // Interpolate on the full surface domain using constant weights outside the first and last rails.
    if (!closed) {
      const open = Array.from(t);
      if (open[0] > 0) { open.unshift(0); Q.unshift(Q[0], 0, 0); }
      if (open.at(-1)! < 1) { open.push(1); Q.push(Q.at(-3)!, 0, 0); }
      const count = open.length, o = Math.min(order, count);
      let fit = fitColumn(Q, Float64Array.from(open), direction(Float64Array.from(open), false, o, count, mirror), false, o, count);
      // A lower-order open interpolant is a single Bezier span. Elevate it exactly.
      while (fit.order < order) {
        const P = new Float64Array((fit.order + 1) * 3);
        for (let j = 0; j <= fit.order; j++) P[j * 3] = lerp(fit.P[Math.min(j, fit.order - 1) * 3], fit.P[Math.max(j - 1, 0) * 3], j / fit.order);
        const elevated = fit.order + 1;
        fit = { ...fit, P, order: elevated, knots: fitKnots(Float64Array.of(0, 1), false, elevated, elevated) };
      }
      return fit;
    }
    return fitSpline(Q, { closed, order, cvs: n, knots: periodic!, params: t.map((u) => mod(u - start, 1)), corrections: 0 });
  });
  if (weights.some((r) => !(r.error < 1e-9))) throw new Error('loft: could not interpolate the crossings. Space the sections and rails farther apart.');
  return weights.map(startAtZero);
}

function networkRefit(curves: NetworkCurve[], crossings: NetCrossing[][], common: number[], weights: FitResult[], phases: number[], mirror: boolean, tolerance: number, label: string) {
  const { closed, order, knots } = weights[0];
  const spans = Array.from(new Set(knots));
  const samples = (density: number, fitSpans: number[]) => curves.map((curve, i) => networkSamples(curve,
    crossings[i].map((q) => q.u), common, crossings[i].map((q) => q.P), phases[i], mirror,
    Math.max(density, curve.breaks.length * 4), fitSpans));
  let worst = 0, worstIndex = 0;
  for (let split = 1; split <= 256; split *= 2) {
    const inner = spans.slice(1).flatMap((b, i) => Array.from({ length: split - 1 }, (_, j) => lerp(spans[i], b, (j + 1) / split)));
    const K = Float64Array.from([...knots, ...inner].sort((a, b) => a - b)), cvs = K.length - (closed ? 1 : order);
    if (cvs < common.length + order) continue;
    const density = Math.max(96, cvs * 4), fitSpans = Array.from(new Set(K));
    const training = samples(density, fitSpans), validation = samples(density * 2 + 1, fitSpans);
    const fits = training.map(({ Q, params, pins }) => fitSpline(Q, { closed, order, cvs, knots: K, params, pins, corrections: 0 }));
    worst = 0;
    for (let i = 0; i < fits.length; i++) {
      const curve = makeSpline('nurbs', fits[i].P, fits[i]), { params, points } = validation[i];
      const p = [0, 0, 0];
      for (let j = 0; j < params.length; j++) {
        const error = distance(evalPoint(curve, params[j], p), points[j]);
        if (error > worst) { worst = error; worstIndex = i; }
      }
    }
    if (worst <= tolerance + 1e-12) return { fits, weights: compatible([...weights, fits[0]]).slice(0, weights.length), error: worst };
  }
  throw new Error(`loft: ${label} ${worstIndex + 1} could only be fitted within ${+(worst * 1000).toPrecision(4)} mm. Raise tolerance or smooth the input curve.`);
}

/** The Gordon sum of the two skins, less the interpolated crossing grid. */
export function fitCurveNetwork(sections: NetworkCurve[], rails: NetworkCurve[], order: [number, number], tolerance: number, networkTolerance: number, mirror: boolean) {
  if (sections.length < 2) throw new Error('loft needs at least 2 curves');
  if (!rails.length || rails.some((r) => r.closed)) throw new Error('loft: supply at least one open rail curve.');
  const closedU = sections[0].closed;
  if (sections.some((s) => s.closed !== closedU)) throw new Error('loft sections must be all closed or all open');
  const sectionSamples = sections.map(crossingSamples), railSamples = rails.map(crossingSamples);
  let gap = 0;
  const grid = sectionSamples.map((s, i) => railSamples.map((r, j) => {
    const q = closestCrossing(s, r, networkTolerance);
    if (q.gap > networkTolerance) throw new Error(`loft: section ${i + 1}, rail ${j + 1} have a gap of ${+(q.gap * 1000).toPrecision(4)} mm. Move the rail onto the section or raise network_tolerance.`);
    if (q.hits > 1) throw new Error(`loft: rail ${j + 1} meets section ${i + 1} more than once. Edit the rail so it crosses the section once.`);
    if (q.gap / 2 > tolerance + 1e-12) throw new Error(`loft: section ${i + 1} and rail ${j + 1} need ${+(q.gap * 500).toPrecision(4)} mm of tolerance to meet at their midpoint. Move the rail closer or raise tolerance.`);
    gap = Math.max(gap, q.gap);
    return q;
  }));
  const rows = sections.map((_, i) => i).sort((i, j) => grid[i][0].v - grid[j][0].v);
  const cols = rails.map((_, j) => j).sort((i, j) => grid[0][i].u - grid[0][j].u);
  const seam = sections.map((_, i) => closedU && !mirror ? grid[i][cols[0]].u : 0);
  const uGrid = rows.map((i) => cols.map((j) => ({ ...grid[i][j], u: unit(grid[i][j].u - seam[i], closedU) })));
  const vGrid = cols.map((j) => rows.map((i) => ({ ...grid[i][j], u: grid[i][j].v })));
  uGrid.forEach((row, i) => row.forEach((q, j) => {
    if (j && q.u <= row[j - 1].u + EPS_PARAM)
      throw new Error(`loft: section ${rows[i] + 1} meets rails ${cols[j - 1] + 1} and ${cols[j] + 1} out of order. Align the curves so every section meets the rails in the same order.`);
  }));
  vGrid.forEach((col, j) => col.forEach((q, i) => {
    if (i && q.u <= col[i - 1].u + EPS_PARAM)
      throw new Error(`loft: section ${rows[i] + 1} meets rails 1 and ${cols[j] + 1} out of order. Align the rails so they meet the sections in the same order.`);
  }));
  const relativeLength = (c: NetworkCurve, phase: number, u: number) => {
    const x = u + phase;
    return x <= 1 ? c.length(x) - c.length(phase) : 1 + c.length(x - 1) - c.length(phase);
  };
  const u = cols.map((_, j) => rows.reduce((sum, i, k) => sum + relativeLength(sections[i], seam[i], uGrid[k][j].u) / rows.length, 0));
  const v = rows.map((_, i) => cols.reduce((sum, j, k) => sum + rails[j].length(vGrid[k][i].u) / cols.length, 0));
  const snap = (t: number) => t < EPS_PARAM ? 0 : t > 1 - EPS_PARAM ? 1 : t;
  u.forEach((t, i) => { u[i] = closedU ? t < EPS_PARAM ? 0 : t : snap(t); });
  v.forEach((t, i) => { v[i] = snap(t); });
  const [orderU, orderV] = order;
  const U = networkRefit(rows.map((i) => sections[i]), uGrid, u, networkWeights(u, orderU, closedU, mirror), rows.map((i) => seam[i]), mirror, tolerance, 'section');
  const V = networkRefit(cols.map((j) => rails[j]), vGrid, v, networkWeights(v, orderV, false, false), cols.map(() => 0), false, tolerance, 'rail');
  const colsU = U.fits[0].P.length / 3, rowsV = V.fits[0].P.length / 3, P = new Float64Array(colsU * rowsV * 3);
  const crossingSkin = cols.map((_, b) => Float64Array.from({ length: rowsV * 3 }, (_, q) => {
    let value = 0;
    for (let a = 0; a < rows.length; a++) value += V.weights[a].P[q - q % 3] * uGrid[a][b].P[q % 3];
    return value;
  }));
  for (let j = 0; j < rowsV; j++) for (let i = 0; i < colsU; i++) for (let k = 0; k < 3; k++) {
    let value = 0;
    for (let a = 0; a < rows.length; a++) value += V.weights[a].P[j * 3] * U.fits[a].P[i * 3 + k];
    for (let b = 0; b < cols.length; b++) value += U.weights[b].P[i * 3] * (V.fits[b].P[j * 3 + k] - crossingSkin[b][j * 3 + k]);
    P[(j * colsU + i) * 3 + k] = value;
  }
  const result: SurfaceFit = {
    P, cols: colsU, rows: rowsV, knotsU: U.fits[0].knots, knotsV: V.fits[0].knots,
    orderU, orderV, closedU, closedV: false, error: Math.max(U.error, V.error), pinnedSections: 0,
    params: v.map((y) => u.map((x): [number, number] => [x, y])),
  };
  if (closedU) {
    const mid = Math.floor(rows.length / 2), c = sections[rows[mid]];
    const pts = Array.from({ length: 16 }, (_, i) => c.eval(i / 16).P);
    orientSectionOutward(result, { pts, closed: true }, mid);
  }
  return { surface: result, gap, reordered: rows.some((i, j) => i !== j) };
}

/** Write one surface prim with row-major CVs and unit weights. */
export function addSurfacePrim(s: SurfaceFit): Geometry {
  const b = new GeoBuilder(), ids: number[] = [];
  for (let i = 0; i < s.cols * s.rows; i++) ids.push(b.addPoint(...point(s.P, i)));
  b.addPrim(ids, s.closedU);
  const g = b.build();
  setSurfacePrim(g, 0, s.cols, { orderU: s.orderU, orderV: s.orderV, closedU: s.closedU, closedV: s.closedV, knotsU: s.knotsU, knotsV: s.knotsV });
  g.prims.add('name', 'string', 1).set(0, 'surface');
  g.detail.add('fit_error', 'float', 1).set(0, s.error);
  return g;
}
