// Spline toolkit nodes: Bezier and NURBS curve prims (bezier, nurbs), conversion (convert_curve), fitting
// (spline_fit), corner fillets (fillet_curve), 3D offsets (offset_curve_3d), projection onto surfaces (project_curve)
// and curve attributes (curve_attribs). Kernels: core/splines.ts. Storage: primKind 2/3 (see core/geometry.ts).
import { GeoBuilder, Geometry } from '../core/geometry.ts';
import type { Src } from '../core/geometry.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import type { CookContext } from '../graph/types.ts';
import { evalRamp } from '../graph/params.ts';
import { cross, dot, normalize } from '../core/math.ts';
import type { Vec3 } from '../core/math.ts';
import {
  PARAMETERIZATIONS, arcTable, autoKnots, bezierThrough, bezierToNurbs, curvatureAt, evalBasis, evalPoint, evaluateSplines,
  fitSpline, fitSplineTolerance, grevilleU, interpolateSpline, kindOf, lengthAtU, makeSpline, nurbsToBezier, polylineParams,
  samplesByLength, setSplinePrim, splineFromPrim, tangentAt, tidySplineAttribs, typeOfKind,
} from '../core/splines.ts';
import type { ConvertedCV, FitResult, Parameterization, PolylineOptions, Spline, SplineType } from '../core/splines.ts';
import { TriBVH } from '../core/spatial.ts';
import { primNormals, resolveVertexNormals } from '../core/topology.ts';
import { heightfieldPreviewMesh, heightfieldsOf } from '../core/heightfield.ts';
import { rmFrames } from './curves.ts';
import { P, mask } from './util.ts';

const DEG = Math.PI / 180;

// ---------------------------------------------------------------- helpers

/** [[x,y,z], …] (2-number entries → [x, 0, z]) from a json param. */
function jsonPoints(v: any, what: string): number[][] {
  if (!Array.isArray(v)) throw new NodeError(`${what} must be a list of [x,y,z] points`);
  return v.map((q: any, i: number) => {
    if (!Array.isArray(q) || (q.length !== 2 && q.length !== 3) || q.some((x: any) => !Number.isFinite(+x)))
      throw new NodeError(`${what}[${i}] must be [x,y,z] (or [x,z] on the ground), got ${JSON.stringify(q)}`);
    return q.length === 2 ? [+q[0], 0, +q[1]] : [+q[0], +q[1], +q[2]];
  });
}

/** A list of numbers from a json param ([] / null = none). */
function jsonNumbers(v: any, what: string): number[] | null {
  if (v === null || v === undefined || (Array.isArray(v) && !v.length)) return null;
  if (!Array.isArray(v) || v.some((x) => !Number.isFinite(+x))) throw new NodeError(`${what} must be a list of numbers`);
  return v.map(Number);
}

function positionsOf(g: Geometry, pts: ArrayLike<number>): Float64Array {
  const out = new Float64Array(pts.length * 3), Pd = g.P;
  for (let k = 0; k < pts.length; k++) { out[k * 3] = Pd[pts[k] * 3]; out[k * 3 + 1] = Pd[pts[k] * 3 + 1]; out[k * 3 + 2] = Pd[pts[k] * 3 + 2]; }
  return out;
}

const v3 = (A: ArrayLike<number>, k: number): Vec3 => [A[k * 3], A[k * 3 + 1], A[k * 3 + 2]];
const addS = (a: Vec3, b: Vec3, s: number): Vec3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];

function polyOpts(p: Record<string, any>): PolylineOptions {
  return { segments: p.segments > 0 ? p.segments : 0, tolerance: p.tolerance > 0 ? p.tolerance : 0 };
}

/** Warn the distinct notes (knots replaced, order lowered, …) of the splines of g, at most three. */
function warnSplineNotes(g: Geometry, warn: (m: string) => void) {
  const notes = new Set<string>();
  for (let p = 0; p < g.numPrims && notes.size < 3; p++) if (g.isSpline(p)) for (const n of splineFromPrim(g, p).notes) notes.add(`prim ${p}: ${n}`);
  for (const n of notes) warn(n);
}

/** A vertex of a rebuilt prim: a source vertex kept as it is ({k}: local index), or a new point blending source vertices. */
type CurveVtx = { k: number } | { P: ArrayLike<number>; idx: number[]; w: number[] };

/**
 * Rebuild a geometry prim by prim. Every input point keeps its number (they are copied first); prims are kept, retyped
 * (same CVs, new spline kind) or replaced by new curves whose points blend the source prim's vertices (attributes
 * follow). finish() sets the spline kinds, writes Pw for new rational CVs and removes the points that only replaced
 * prims used.
 */
class Rebuild {
  readonly g: Geometry;
  readonly b: GeoBuilder;
  private np0: number;
  private kinds: { prim: number; kind: number; type?: SplineType; order?: number; knots?: ArrayLike<number> | null }[] = [];
  private pw = new Map<number, number>();
  touched = false;

  constructor(g: Geometry) {
    this.g = g;
    this.b = new GeoBuilder(g);
    this.np0 = g.numPoints;
    for (let i = 0; i < this.np0; i++) this.b.copyPoint(i);
  }

  private verts(pr: number): number[] {
    const out: number[] = [];
    for (let v = this.g.primStart[pr]; v < this.g.primStart[pr + 1]; v++) out.push(v);
    return out;
  }

  /** The prim unchanged (spline kind kept). */
  keep(pr: number): number {
    const g = this.g;
    const np = this.b.addPrim(g.primPoints(pr), !!g.primClosed[pr], pr, this.verts(pr));
    if (g.isSpline(pr)) this.kinds.push({ prim: np, kind: g.primKind![pr] });
    return np;
  }

  /** Same CVs, now a spline of the given type (or a polyline for type null). */
  retype(pr: number, type: SplineType | null, order: number, knots: ArrayLike<number> | null, closed = !!this.g.primClosed[pr]): number {
    const np = this.b.addPrim(this.g.primPoints(pr), closed, pr, this.verts(pr));
    if (type) { this.kinds.push({ prim: np, kind: kindOf(type), type, order, knots }); this.touched = true; }
    return np;
  }

  /**
   * A new curve made of kept source vertices and new blended points; returns the prim and the new point ids.
   * repeatFirst ends an open curve on its first point again (loops whose ends meet).
   */
  addCurve(pr: number, verts: CurveVtx[], closed: boolean, spline?: { type: SplineType; order: number; knots?: ArrayLike<number> | null; weights?: ArrayLike<number> | null }, repeatFirst = false): { prim: number; created: number[] } {
    if (spline) this.touched = true;
    const g = this.g, pts = pr >= 0 ? g.primPoints(pr) : [], vs0 = pr >= 0 ? g.primStart[pr] : 0;
    const ids: number[] = [], vsrc: Src[] = [], created: number[] = [];
    verts.forEach((c, j) => {
      if ('k' in c) { ids.push(pts[c.k]); vsrc.push(vs0 + c.k); return; }
      const id = this.b.addPoint(c.P[0], c.P[1], c.P[2], c.idx.length ? { i: c.idx.map((k) => pts[k]), w: c.w } : null);
      ids.push(id);
      created.push(id);
      vsrc.push(c.idx.length ? { i: c.idx.map((k) => vs0 + k), w: c.w } : null);
      if (spline?.weights) { const w = spline.weights[j]; if (w !== undefined && w !== 1) this.pw.set(id, w); }
    });
    if (repeatFirst && ids.length) { ids.push(ids[0]); vsrc.push(vsrc[0]); }
    const prim = this.b.addPrim(ids, closed && ids.length >= 3, pr, vsrc);
    if (spline) this.kinds.push({ prim, kind: kindOf(spline.type), type: spline.type, order: spline.order, knots: spline.knots ?? null });
    return { prim, created };
  }

  /** The curve of spline prim pr as a polyline (closed curves as closed polygons). */
  evaluate(pr: number, o: PolylineOptions): number {
    const s = splineFromPrim(this.g, pr);
    const verts: CurveVtx[] = polylineParams(s, o).map((u) => { const e = evalBasis(s, u); return { P: e.P, idx: e.idx, w: e.w }; });
    return this.addCurve(pr, verts, s.closed).prim;
  }

  /** New CVs from an exact conversion (bezierToNurbs / nurbsToBezier). */
  convertedCVs(pr: number, cvs: ConvertedCV[], type: SplineType, order: number, knots: ArrayLike<number> | null): number {
    const rational = cvs.some((c) => Math.abs(c.w - 1) > 1e-12);
    return this.addCurve(pr, cvs.map((c) => ({ P: c.P, idx: c.idx, w: c.wts })), !!this.g.primClosed[pr], { type, order, knots, weights: rational ? cvs.map((c) => c.w) : null }).prim;
  }

  finish(): Geometry {
    let out = this.b.build();
    if (this.kinds.length) {
      out.ensurePacked();
      for (const k of this.kinds) {
        if (k.type) setSplinePrim(out, k.prim, k.type, k.order!, k.knots);
        else out.primKind![k.prim] = k.kind;
      }
    }
    if (this.pw.size) {
      const a = out.points.add('Pw', 'float', 1);
      for (const [i, w] of this.pw) a.set(i, w);
    }
    // original points that only replaced prims used go away (points of kept prims and isolated points stay)
    const g = this.g, np0 = this.np0;
    const usedBefore = new Uint8Array(np0), usedAfter = new Uint8Array(np0);
    for (let v = 0; v < g.numVertices; v++) usedBefore[g.vertexPoint[v]] = 1;
    for (let v = 0; v < out.numVertices; v++) if (out.vertexPoint[v] < np0) usedAfter[out.vertexPoint[v]] = 1;
    const keep = new Uint8Array(out.numPoints).fill(1);
    let drop = false;
    for (let i = 0; i < np0; i++) if (usedBefore[i] && !usedAfter[i]) { keep[i] = 0; drop = true; }
    if (drop) out = out.subsetPoints(keep);
    return this.touched || g.hasSplines() ? tidySplineAttribs(out) : out;
  }
}

/** Input prims that carry a curve: polygons, polylines and splines with at least two vertices (not packed). */
const isCurvePrim = (g: Geometry, p: number) => (g.primKind ? g.primKind[p] !== 1 : true) && g.primSize(p) >= 2;

const PARAM_DESC = 'parameterisation: uniform (even), chord (follows point distances), centripetal (√distances; best for sharp turns)';

// ---------------------------------------------------------------- bezier / nurbs

interface GenParams { type: SplineType }

function splineGenerator({ type }: GenParams, ctx: CookContext): Geometry {
  const { p, warn } = ctx;
  const order = p.order;
  const mode: Parameterization = p.parameterization ?? 'uniform';
  const explicit = type === 'nurbs' ? jsonNumbers(p.knots, 'knots') : null;
  const weights = jsonNumbers(p.weights, 'weights');
  const knotsFor = (P: ArrayLike<number>, closed: boolean): Float64Array | null => {
    if (type !== 'nurbs') return null;
    const n = P.length / 3;
    const s = makeSpline('nurbs', P, { order, closed, knots: explicit ?? autoKnots(P, closed, order, mode) });
    if (explicit && s.notes.length) warn(s.notes[s.notes.length - 1]);
    return n ? s.knots : null;
  };
  if (!ctx.hasInput(0)) {
    let pts = jsonPoints(p.points, 'points').flat();
    if (pts.length < 6) throw new NodeError('points: a curve needs at least 2 CVs');
    const n0 = pts.length / 3, closed = !!p.closed && n0 >= 3;
    let knots: ArrayLike<number> | null = null;
    if (type === 'nurbs' && p.fit) {
      const r = interpolateSpline(pts, closed, order, mode === 'uniform' ? 'centripetal' : mode);
      pts = Array.from(r.P);
      knots = r.knots;
      if (explicit) warn('knots are ignored with fit:true (the interpolating knots are computed from the points)');
    } else knots = knotsFor(pts, closed);
    const n = pts.length / 3;
    const g = new Geometry({ positions: pts, prims: [Array.from({ length: n }, (_, i) => i)], closed });
    if (weights) {
      if (p.fit) warn('weights are ignored with fit:true');
      else {
        if (weights.length !== n) warn(`weights: ${weights.length} values for ${n} CVs (missing ones are 1)`);
        const a = g.points.add('Pw', 'float', 1);
        for (let i = 0; i < n; i++) a.set(i, weights[i] ?? 1);
      }
    }
    setSplinePrim(g, 0, type, makeSpline(type, pts, { order, closed }).order, knots);
    warnSplineNotes(g, warn);
    return g;
  }
  // from the input: each curve's points become CVs (or, without prims, all points in order)
  const src = ctx.input(0);
  if (weights) warn('weights apply to the points param only; with an input set the point attribute Pw');
  let g = src;
  if (!src.numPrims) {
    // a point cloud: all points in point order make one curve
    if (src.numPoints < 2) throw new NodeError('the input has fewer than 2 points to use as CVs');
    const b = new GeoBuilder(src);
    const ids = Array.from({ length: src.numPoints }, (_, i) => b.copyPoint(i));
    b.addPrim(ids, !!p.closed && ids.length >= 3);
    g = b.build();
  }
  const rb = new Rebuild(g);
  for (let pr = 0; pr < g.numPrims; pr++) {
    if (!isCurvePrim(g, pr)) { rb.keep(pr); continue; }
    const closed = (!!g.primClosed[pr] || !!p.closed) && g.primSize(pr) >= 3;
    const pts = g.primPoints(pr), Q = positionsOf(g, pts);
    if (type === 'nurbs' && p.fit) {
      const r = interpolateSpline(Q, closed, order, mode === 'uniform' ? 'centripetal' : mode);
      // CV k takes the attributes of point k (as many CVs as points)
      rb.addCurve(pr, Array.from({ length: r.P.length / 3 }, (_, k) => ({ P: v3(r.P, k), idx: [k], w: [1] })), closed, { type, order: r.order, knots: r.knots });
      continue;
    }
    let knots: ArrayLike<number> | null = null;
    if (type === 'nurbs') knots = explicit && explicit.length === (closed ? pts.length + 1 : pts.length + Math.min(order, pts.length)) ? explicit : knotsFor(Q, closed);
    rb.retype(pr, type, makeSpline(type, Q, { order, closed }).order, knots, closed);
  }
  const out = rb.finish();
  warnSplineNotes(out, warn);
  return out;
}

const DEFAULT_BEZIER = [[0, 0, 0], [0.6, 1.2, 0], [1.6, 1.2, 0], [2.2, 0, 0], [2.8, -1.2, 0], [3.8, -1.2, 0], [4.4, 0, 0]];
const DEFAULT_NURBS = [[0, 0, 0], [1, 0, 1.5], [2.5, 0.5, 1.5], [3, 1, 0], [4.5, 0.5, -0.5], [5.5, 0, 0.5]];

defineNode({
  type: 'bezier',
  category: 'curve',
  summary: 'Bezier curve prim from control points (CVs) and an order; evaluates exactly wherever it is used.',
  description: 'Houdini Curve SOP in Bezier mode (a BezierCurve prim). Segments of `order` CVs share their end CVs: 7 CVs of order 4 make two cubic segments (CVs 0-3 and 3-6); a closed curve wraps back to CV 0 (segments × (order-1) CVs). The CVs are ordinary points: transform, deformers, wrangles and attribute nodes move or edit them, and point attributes (Cd, width, Pw weights) blend along the curve. Nodes that need polylines get the evaluated curve automatically (with a note); convert_curve/resample choose the resolution. With an input, each polyline/polygon (or, without prims, all points in order) becomes a Bezier prim on those points.',
  aliases: ['bezier_curve', 'beziercurve'],
  inputs: [{ name: 'points', desc: 'optional: polylines/polygons (or ordered points) whose points become CVs', optional: true }],
  params: {
    points: { type: 'json', default: DEFAULT_BEZIER, desc: 'CVs [[x,y,z], …] when no input is connected (2-number entries → [x, 0, z])', aliases: ['cvs', 'positions', 'pts'] },
    order: { type: 'int', default: 4, min: 2, max: 11, desc: 'order = degree + 1 (4 = cubic, 3 = quadratic, 2 = linear)' },
    closed: { type: 'bool', default: false, desc: 'closed curve (wraps back to the first CV; regular with a multiple of order-1 CVs)' },
    weights: { type: 'json', default: [], desc: 'rational weight per CV (point attribute Pw; [] = all 1); larger pulls the curve toward the CV' },
  },
  outputs: 'Bezier prims (prim spline_order; point Pw with weights)',
  example: { type: 'bezier', params: { points: [[0, 0, 0], [1, 2, 0], [3, 2, 0], [4, 0, 0]], order: 4 } },
  cook: (ctx) => splineGenerator({ type: 'bezier' }, ctx),
});

defineNode({
  type: 'nurbs',
  category: 'curve',
  summary: 'NURBS curve prim from control points (CVs), order, knots and weights; or through points with fit.',
  description: 'Houdini Curve SOP in NURBS mode (a NURBCurve prim). Open curves have n + order knots (automatic: clamped, so the curve starts and ends on its end CVs); closed curves are periodic with n + 1 breakpoints. fit:true makes the curve pass through the points (global interpolation; the CVs are computed). The CVs are ordinary points (transform/deform/wrangle move them, attributes blend along the curve); nodes that need polylines get the evaluated curve automatically. With an input, each polyline/polygon (or all points in order) becomes a NURBS prim.',
  aliases: ['nurbs_curve', 'nurbscurve'],
  inputs: [{ name: 'points', desc: 'optional: polylines/polygons (or ordered points) whose points become CVs (or are interpolated with fit)', optional: true }],
  params: {
    points: { type: 'json', default: DEFAULT_NURBS, desc: 'CVs [[x,y,z], …] when no input is connected (2-number entries → [x, 0, z])', aliases: ['cvs', 'positions', 'pts'] },
    order: { type: 'int', default: 4, min: 2, max: 11, desc: 'order = degree + 1 (4 = cubic); lowered when there are fewer CVs' },
    closed: { type: 'bool', default: false, desc: 'closed (periodic) curve' },
    knots: { type: 'json', default: [], desc: 'explicit knots: open n + order non-decreasing values, closed n + 1 breakpoints; [] = automatic' },
    parameterization: { type: 'enum', options: PARAMETERIZATIONS, default: 'uniform', desc: `automatic knot spacing (${PARAM_DESC})`, aliases: ['knot_spacing', 'parameterisation'] },
    weights: { type: 'json', default: [], desc: 'rational weight per CV (point attribute Pw; [] = all 1)' },
    fit: { type: 'bool', default: false, desc: 'interpolate: the curve passes through the points (CVs computed) instead of using them as CVs', aliases: ['interpolate', 'through_points'] },
  },
  outputs: 'NURBS prims (prim spline_order, prim float[] knots; point Pw with weights)',
  example: { type: 'nurbs', params: { points: [[0, 0, 0], [2, 0, 2], [4, 0, 0], [6, 0, 2]], fit: true } },
  cook: (ctx) => splineGenerator({ type: 'nurbs' }, ctx),
});

// ---------------------------------------------------------------- convert_curve

defineNode({
  type: 'convert_curve',
  category: 'curve',
  summary: 'Convert curves between polyline, Bezier and NURBS (exact between spline types; fit to pass through points).',
  description: 'Houdini Convert SOP for curves. Spline → polyline evaluates the curve (adaptive by tolerance, or segments per span); closed splines become closed polygons. Bezier ↔ NURBS is exact (multiple knots / blossoming; a short last Bezier segment is degree-elevated). Polyline → spline uses the points as CVs, or with fit passes through them (NURBS: global interpolation; Bezier: smooth cubic segments). Attributes follow (CV blends). Use convert to polyline before nodes that need a specific resolution; others convert automatically.',
  aliases: ['convert', 'curve_convert'],
  inputs: [{ name: 'curves', desc: 'polylines, polygons, Bezier or NURBS curves' }],
  splines: 'keep',
  params: {
    to: { type: 'enum', options: ['polyline', 'bezier', 'nurbs'], default: 'polyline', desc: 'target type', aliases: ['type', 'target'] },
    order: { type: 'int', default: 4, min: 2, max: 11, desc: 'order of curves made from polylines (fit Bezier is always cubic)' },
    fit: { type: 'bool', default: false, desc: 'polylines → spline: pass through the points instead of using them as CVs', aliases: ['interpolate'] },
    parameterization: { type: 'enum', options: PARAMETERIZATIONS, default: 'centripetal', desc: `knots of NURBS made from polylines (${PARAM_DESC})` },
    segments: { type: 'int', default: 0, min: 0, desc: 'to polyline: segments per knot span / Bezier segment; 0 = adaptive (tolerance)', aliases: ['divisions', 'lod'] },
    tolerance: { type: 'float', default: 0, min: 0, desc: 'to polyline: largest chord-to-curve distance; 0 = 1/2000 of each curve\'s CV box diagonal' },
    group: P.group('prim'),
  },
  example: { type: 'convert_curve', params: { to: 'polyline', tolerance: 0.001 } },
  cook: ({ input, p, warn }) => {
    const g = input(0);
    const sel = mask(g, 'prim', p.group);
    const rb = new Rebuild(g);
    const po = polyOpts(p);
    let orderNote = false;
    for (let pr = 0; pr < g.numPrims; pr++) {
      const from = typeOfKind(g.primKind?.[pr] ?? 0) ?? 'polyline';
      if ((sel && !sel[pr]) || !isCurvePrim(g, pr) || from === p.to) {
        if (from === p.to && from !== 'polyline' && (!sel || sel[pr]) && splineFromPrim(g, pr).order !== p.order) orderNote = true;
        rb.keep(pr);
        continue;
      }
      if (p.to === 'polyline') { rb.evaluate(pr, po); continue; }
      const closed = !!g.primClosed[pr] && g.primSize(pr) >= 3;
      if (from === 'polyline') {
        const Q = positionsOf(g, g.primPoints(pr)), m = Q.length / 3;
        if (!p.fit) { rb.retype(pr, p.to, makeSpline(p.to, Q, { order: p.order, closed }).order, p.to === 'nurbs' ? autoKnots(Q, closed, p.order, p.parameterization) : null, closed); continue; }
        if (p.to === 'bezier') {
          // through every point: point k is CV 3k, the handles blend the two points of their segment
          const C = bezierThrough(Q, closed);
          const verts: CurveVtx[] = Array.from({ length: C.length / 3 }, (_, j) => {
            const seg = Math.floor(j / 3), r = j % 3;
            if (r === 0) return { k: seg % m };
            const f = r / 3;
            return { P: v3(C, j), idx: [seg % m, (seg + 1) % m], w: [1 - f, f] };
          });
          rb.addCurve(pr, verts, closed, { type: 'bezier', order: 4 });
          if (p.order !== 4) orderNote = true;
        } else {
          const r = interpolateSpline(Q, closed, p.order, p.parameterization);
          rb.addCurve(pr, Array.from({ length: r.P.length / 3 }, (_, k) => ({ P: v3(r.P, k), idx: [k], w: [1] })), closed, { type: 'nurbs', order: r.order, knots: r.knots });
        }
        continue;
      }
      const s = splineFromPrim(g, pr);
      if (p.to === 'nurbs') { const r = bezierToNurbs(s); rb.convertedCVs(pr, r.cvs, 'nurbs', r.order, r.knots); }
      else { const r = nurbsToBezier(s); rb.convertedCVs(pr, r.cvs, 'bezier', r.order, null); }
    }
    if (orderNote) warn(p.to === 'bezier' && p.fit ? 'fit Bezier curves are cubic (order 4)' : `curves already of type ${p.to} keep their order (order is used for curves made from polylines)`);
    const out = rb.finish();
    warnSplineNotes(out, warn);
    return out;
  },
});

// ---------------------------------------------------------------- spline_fit

defineNode({
  type: 'spline_fit',
  category: 'curve',
  summary: 'Least-squares NURBS through ordered points: smooth noisy polylines, compress dense curves to few CVs.',
  description: 'Houdini Fit SOP (approximation). Each polyline/polygon (or, without prims, all points in order) is approximated by a B-spline: cv_count CVs, or (cv_count 0) the fewest CVs that keep every point within tolerance (interpolating at worst). Open curves keep their end points. smoothing adds a penalty on the CVs\' second differences (0 = none; around 1 irons out noise; larger flattens). Parameters are corrected (re-projected) twice. Output NURBS prims, or polylines sampled from the fit. Writes prim fit_error.',
  aliases: ['fit_curve', 'curve_fit', 'fitcurve'],
  inputs: [{ name: 'points', desc: 'polylines/polygons (each fitted), or ordered points without prims (one curve)' }],
  params: {
    order: { type: 'int', default: 4, min: 2, max: 11, desc: 'order of the fitted curve (4 = cubic)' },
    cv_count: { type: 'int', default: 0, min: 0, desc: 'number of CVs; 0 = as few as the tolerance allows', aliases: ['cvs', 'count'] },
    tolerance: { type: 'float', default: 0.01, min: 0, desc: 'largest allowed distance from a point to the curve (cv_count 0)', aliases: ['tol', 'max_error'] },
    smoothing: { type: 'float', default: 0, min: 0, desc: 'second-difference penalty on the CVs (0 = none, ~1 smooths noise)', aliases: ['smooth'] },
    parameterization: { type: 'enum', options: PARAMETERIZATIONS, default: 'centripetal', desc: PARAM_DESC },
    closed: { type: 'enum', options: ['auto', 'open', 'closed'], default: 'auto', desc: 'auto = as the input prim (open for point clouds)' },
    output: { type: 'enum', options: ['nurbs', 'polyline'], default: 'nurbs', desc: 'NURBS prims or polylines sampled from the fit' },
    segments: { type: 'int', default: 0, min: 0, desc: 'polyline output: segments per knot span; 0 = adaptive (tolerance / 4)' },
    group: P.group('prim'),
  },
  outputs: 'prim fit_error (largest distance from an input point to the fitted curve)',
  example: { type: 'spline_fit', params: { tolerance: 0.02, smoothing: 0.5 } },
  cook: ({ input, p, warn }) => {
    const src = input(0);
    const sel = mask(src, 'prim', p.group);
    const fit = (Q: Float64Array, closed: boolean): FitResult => {
      const o = { closed, order: p.order, mode: p.parameterization as Parameterization, smoothing: p.smoothing };
      return p.cv_count > 0 ? fitSpline(Q, { ...o, cvs: p.cv_count }) : fitSplineTolerance(Q, { ...o, tolerance: Math.max(1e-9, p.tolerance) });
    };
    /** Curve vertices of a fit: CVs (nurbs) or samples (polyline), each blending the two data points around its parameter. */
    const verts = (r: FitResult, m: number): { verts: CurveVtx[]; spline: Spline } => {
      const s = makeSpline('nurbs', r.P, { order: r.order, closed: r.closed, knots: r.knots });
      const prm = r.params;
      const around = (u: number): { idx: number[]; w: number[] } => {
        let k = 0;
        while (k < m - 1 && prm[k + 1] <= u) k++;
        const k1 = r.closed ? (k + 1) % m : Math.min(m - 1, k + 1);
        const t0 = prm[k], t1 = k1 === 0 && r.closed ? 1 : prm[k1];
        const f = t1 > t0 ? Math.min(1, Math.max(0, (u - t0) / (t1 - t0))) : 0;
        return { idx: [k, k1], w: [1 - f, f] };
      };
      if (p.output === 'polyline') {
        const tol = p.tolerance > 0 ? p.tolerance / 4 : 0;
        return { spline: s, verts: polylineParams(s, { segments: p.segments, tolerance: tol }).map((u) => ({ P: evalPoint(s, u), ...around(u) })) };
      }
      return { spline: s, verts: Array.from({ length: s.n }, (_, k) => ({ P: v3(r.P, k), ...around(grevilleU(s, k)) })) };
    };
    let worst = 0;
    if (!src.numPrims) {
      // a point cloud in point order: one curve, the points are consumed
      const m = src.numPoints;
      if (m < 2) throw new NodeError('spline_fit needs at least 2 points');
      const Q = positionsOf(src, Array.from({ length: m }, (_, i) => i));
      const r = fit(Q, p.closed === 'closed' && m >= 3);
      worst = r.error;
      const b = new GeoBuilder(src);
      const { verts: vs } = verts(r, m);
      const ids = vs.map((c) => { const q = c as { P: number[]; idx: number[]; w: number[] }; return b.addPoint(q.P[0], q.P[1], q.P[2], { i: q.idx, w: q.w }); });
      const prim = b.addPrim(ids, r.closed, -1);
      b.attrib('prim', 'fit_error', 1).set(prim, r.error);
      let out = b.build();
      if (p.output === 'nurbs') setSplinePrim(out, 0, 'nurbs', r.order, r.knots);
      else out = tidySplineAttribs(out);
      return out;
    }
    const rb = new Rebuild(src);
    const fe = rb.b.attrib('prim', 'fit_error', 1);
    for (let pr = 0; pr < src.numPrims; pr++) {
      if ((sel && !sel[pr]) || !isCurvePrim(src, pr)) { rb.keep(pr); continue; }
      const pts = src.primPoints(pr), m = pts.length;
      const closed = (p.closed === 'auto' ? !!src.primClosed[pr] : p.closed === 'closed') && m >= 3;
      const r = fit(positionsOf(src, pts), closed);
      worst = Math.max(worst, r.error);
      const { verts: vs } = verts(r, m);
      const { prim } = rb.addCurve(pr, vs, r.closed, p.output === 'nurbs' ? { type: 'nurbs', order: r.order, knots: r.knots } : undefined);
      fe.set(prim, r.error);
    }
    if (p.cv_count === 0 && worst > p.tolerance * 1.0001) warn(`some curves could not be fitted within tolerance ${p.tolerance} (largest error ${+worst.toPrecision(3)}): they interpolate their points`);
    return rb.finish();
  },
});

// ---------------------------------------------------------------- fillet_curve

defineNode({
  type: 'fillet_curve',
  category: 'curve',
  summary: 'Round, chamfer or Bezier-blend the corners of polylines and polygons (3D, any plane per corner).',
  description: 'Like Houdini\'s PolyPath/fillet tools for curves (Fillet SOP is for surfaces). Each corner whose turn exceeds angle_min (and whose point is in group) is replaced by an arc of `radius` tangent to both edges (round), a straight cut at the same tangent points (chamfer) or a quadratic Bezier through the corner\'s handle (bezier). clamp shrinks radii that do not fit between neighbouring corners. Corners of open curves at their ends are never filleted. Attributes are blended from the corner and its neighbours; new points join point group "fillet". Bezier/NURBS input is converted to polylines first (a smooth curve has no corners).',
  aliases: ['curve_fillet', 'polyline_fillet', 'polyfillet'],
  inputs: [{ name: 'curves', desc: 'polylines or polygons' }],
  params: {
    radius: { type: 'float', default: 0.2, min: 0, desc: 'fillet radius (chamfer/bezier: the same tangent points)', aliases: ['rad', 'r'] },
    type: { type: 'enum', options: ['round', 'chamfer', 'bezier'], default: 'round', desc: 'corner shape', aliases: ['shape', 'mode'] },
    segments: { type: 'int', default: 6, min: 1, desc: 'segments per round/bezier corner', aliases: ['divisions'] },
    angle_min: { type: 'float', default: 1, min: 0, max: 180, desc: 'leave corners that turn less than this (degrees)' },
    group: P.group('point', 'corner points to fillet ("" = all), e.g. "@P.y>0", "0-4"'),
    clamp: { type: 'bool', default: true, desc: 'shrink radii that do not fit between neighbouring corners' },
    radius_attrib: { type: 'string', default: '', desc: 'optional point float attribute multiplying the radius per corner' },
  },
  outputs: 'point group fillet (new corner points)',
  example: { type: 'fillet_curve', params: { radius: 0.5, segments: 8 } },
  cook: ({ input, p }) => {
    const g = input(0);
    const ptSel = mask(g, 'point', p.group);
    const ra = p.radius_attrib ? g.points.get(p.radius_attrib) : null;
    if (p.radius_attrib && (!ra || ra.type === 'string' || ra.isArray)) throw new NodeError(`no numeric point attribute "${p.radius_attrib}" for radius_attrib`);
    const minTurn = p.angle_min * DEG;
    const rb = new Rebuild(g);
    const fg = rb.b.group('point', 'fillet');
    for (let pr = 0; pr < g.numPrims; pr++) {
      if (!isCurvePrim(g, pr) || g.primSize(pr) < 3) { rb.keep(pr); continue; }
      let pts = g.primPoints(pr);
      let closed = !!g.primClosed[pr];
      // an open polyline whose ends meet is a loop: fillet its seam too, keep it open (seam point repeated)
      const loop = !closed && pts.length > 3 && pts[0] === pts[pts.length - 1];
      if (loop) pts = pts.slice(0, -1);
      const cyc = closed || loop;
      const m = pts.length, X = positionsOf(g, pts);
      const t = new Float64Array(m), ang = new Float64Array(m);
      const d1s: Vec3[] = new Array(m), d2s: Vec3[] = new Array(m), lenA = new Float64Array(m), lenB = new Float64Array(m);
      for (let k = 0; k < m; k++) {
        if (!cyc && (k === 0 || k === m - 1)) continue;
        if (ptSel && !ptSel[pts[k]]) continue;
        const a = (k - 1 + m) % m, c = (k + 1) % m;
        const P0 = v3(X, k), A = v3(X, a), B = v3(X, c);
        const da: Vec3 = [A[0] - P0[0], A[1] - P0[1], A[2] - P0[2]], db: Vec3 = [B[0] - P0[0], B[1] - P0[1], B[2] - P0[2]];
        const la = Math.hypot(...da), lb = Math.hypot(...db);
        if (!(la > 1e-12 && lb > 1e-12)) continue;
        const d1 = normalize(da), d2 = normalize(db);
        const th = Math.acos(Math.max(-1, Math.min(1, dot(d1, d2)))); // interior angle
        if (Math.PI - th < minTurn || th < 1e-6) continue;
        const r = p.radius * (ra ? Number(ra.get(pts[k])) : 1);
        if (!(r > 0)) continue;
        t[k] = r / Math.tan(th / 2);
        ang[k] = th; d1s[k] = d1; d2s[k] = d2; lenA[k] = la; lenB[k] = lb;
      }
      if (p.clamp) {
        // tangent lengths of the two corners of an edge may not add up to more than the edge
        const f = new Float64Array(m).fill(1);
        for (let k = 0; k < m; k++) {
          const c = (k + 1) % m;
          if (!cyc && k === m - 1) continue;
          const L = Math.hypot(X[c * 3] - X[k * 3], X[c * 3 + 1] - X[k * 3 + 1], X[c * 3 + 2] - X[k * 3 + 2]);
          const need = t[k] + t[c];
          if (need > L && need > 0) { const s = L / need; f[k] = Math.min(f[k], s); f[c] = Math.min(f[c], s); }
        }
        for (let k = 0; k < m; k++) t[k] *= f[k];
      }
      const verts: CurveVtx[] = [];
      for (let k = 0; k < m; k++) {
        if (!(t[k] > 1e-12)) { verts.push({ k }); continue; }
        const a = (k - 1 + m) % m, c = (k + 1) % m, th = ang[k], d1 = d1s[k], d2 = d2s[k], tk = t[k];
        const P0 = v3(X, k);
        const T1 = addS(P0, d1, tk), T2 = addS(P0, d2, tk);
        const fa = tk / lenA[k], fb = tk / lenB[k];
        const prov = (s: number) => ({ idx: [k, a, k, c], w: [(1 - s) * (1 - fa), (1 - s) * fa, s * (1 - fb), s * fb] });
        const push = (P: Vec3, s: number) => { verts.push({ P, ...prov(s) }); };
        if (p.type === 'chamfer') { push(T1, 0); push(T2, 1); continue; }
        const n = Math.max(1, p.segments);
        if (p.type === 'bezier') {
          for (let j = 0; j <= n; j++) {
            const s = j / n, w0 = (1 - s) * (1 - s), w1 = 2 * s * (1 - s), w2 = s * s;
            push([w0 * T1[0] + w1 * P0[0] + w2 * T2[0], w0 * T1[1] + w1 * P0[1] + w2 * T2[1], w0 * T1[2] + w1 * P0[2] + w2 * T2[2]], s);
          }
          continue;
        }
        // round: arc around the centre on the bisector, from T1 to T2
        const bis = normalize([d1[0] + d2[0], d1[1] + d2[1], d1[2] + d2[2]]);
        const C = addS(P0, bis, tk / Math.cos(th / 2));
        const va: Vec3 = [T1[0] - C[0], T1[1] - C[1], T1[2] - C[2]], vb: Vec3 = [T2[0] - C[0], T2[1] - C[1], T2[2] - C[2]];
        const phi = Math.PI - th, sp = Math.sin(phi);
        for (let j = 0; j <= n; j++) {
          const s = j / n;
          const wa = sp > 1e-12 ? Math.sin((1 - s) * phi) / sp : 1 - s, wb = sp > 1e-12 ? Math.sin(s * phi) / sp : s;
          push([C[0] + va[0] * wa + vb[0] * wb, C[1] + va[1] * wa + vb[1] * wb, C[2] + va[2] * wa + vb[2] * wb], s);
        }
      }
      // tangent points of neighbouring corners that meet exactly (clamped radii): keep one
      const posOf = (c: CurveVtx): Vec3 => ('k' in c ? v3(X, c.k) : (c.P as Vec3));
      const same = (a: CurveVtx, b: CurveVtx) => { const x = posOf(a), y = posOf(b); return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) < 1e-12; };
      const vv: CurveVtx[] = [];
      for (const c of verts) if (!(vv.length && !('k' in c) && same(vv[vv.length - 1], c))) vv.push(c);
      if (cyc && vv.length > 1 && !('k' in vv[vv.length - 1]) && same(vv[0], vv[vv.length - 1])) vv.pop();
      const { created } = rb.addCurve(pr, vv, closed, undefined, loop);
      for (const id of created) fg.add(id);
    }
    return rb.finish();
  },
});

// ---------------------------------------------------------------- offset_curve_3d

/**
 * Offset of one polyline by d along each edge's side vector (direction × up: the right of the direction of travel),
 * corners per `corner`; lift moves along the up vectors. Returns points with the local vertex they come from.
 */
function offsetPolyline(
  X: Float64Array, closed: boolean, ups: Vec3[], plane: Vec3 | null, d: number, lift: number,
  corner: string, mitreLimit: number, roundSegs: number,
): { P: Vec3; k: number }[] {
  const n = X.length / 3, segs = closed ? n : n - 1;
  const out: { P: Vec3; k: number }[] = [];
  if (n < 2) return out;
  const dir: Vec3[] = [], side: Vec3[] = [];
  for (let s = 0; s < segs; s++) {
    const a = v3(X, s), b = v3(X, (s + 1) % n);
    const v: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    dir.push(Math.hypot(...v) > 1e-14 ? normalize(v) : [0, 0, 0]);
  }
  // zero-length edges take the direction of the previous (else the next) real edge
  const zero = (v: Vec3) => !v[0] && !v[1] && !v[2];
  for (let s = 1; s < segs; s++) if (zero(dir[s])) dir[s] = dir[s - 1];
  for (let s = segs - 2; s >= 0; s--) if (zero(dir[s])) dir[s] = dir[s + 1];
  if (zero(dir[0])) for (let s = 0; s < segs; s++) dir[s] = [1, 0, 0];
  for (let s = 0; s < segs; s++) {
    const u = plane ?? normalize([ups[s][0] + ups[(s + 1) % n][0], ups[s][1] + ups[(s + 1) % n][1], ups[s][2] + ups[(s + 1) % n][2]]);
    let x = cross(dir[s], u);
    if (Math.hypot(...x) < 1e-9) x = s ? side[s - 1] : cross(dir[s], Math.abs(dir[s][1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]);
    side.push(normalize(x));
  }
  const liftOf = (k: number): Vec3 => (plane ?? ups[k]);
  const at = (k: number, sv: Vec3, len = d): Vec3 => {
    const P0 = v3(X, k), L = liftOf(k);
    return [P0[0] + sv[0] * len + L[0] * lift, P0[1] + sv[1] * len + L[1] * lift, P0[2] + sv[2] * len + L[2] * lift];
  };
  for (let k = 0; k < n; k++) {
    if (!closed && (k === 0 || k === n - 1)) { out.push({ P: at(k, side[k === 0 ? 0 : segs - 1]), k }); continue; }
    const a = side[(k - 1 + segs) % segs], b = side[k % segs];
    const c = dot(a, b);
    if (c > 1 - 1e-12 || d === 0) { out.push({ P: at(k, a), k }); continue; }
    const inner = dot(dir[k % segs], a) * d > 0;
    const mit: Vec3 = c > -1 + 1e-9 ? [(a[0] + b[0]) / (1 + c), (a[1] + b[1]) / (1 + c), (a[2] + b[2]) / (1 + c)] : a;
    const mlen = Math.hypot(...mit);
    if (inner || corner === 'mitre') {
      if (mlen <= mitreLimit || inner) {
        const f = inner && mlen > mitreLimit ? mitreLimit / mlen : 1;
        out.push({ P: at(k, [mit[0] * f, mit[1] * f, mit[2] * f]), k });
        continue;
      }
      out.push({ P: at(k, a), k }, { P: at(k, b), k }); // beyond the mitre limit: bevel
      continue;
    }
    if (corner === 'bevel') { out.push({ P: at(k, a), k }, { P: at(k, b), k }); continue; }
    // round: slerp the side vector from a to b
    const phi = Math.acos(Math.max(-1, Math.min(1, c))), sp = Math.sin(phi);
    const m = Math.max(1, Math.ceil((roundSegs * phi) / (Math.PI / 2)));
    for (let j = 0; j <= m; j++) {
      const s = j / m, wa = sp > 1e-12 ? Math.sin((1 - s) * phi) / sp : 1 - s, wb = sp > 1e-12 ? Math.sin(s * phi) / sp : s;
      out.push({ P: at(k, [a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb]), k });
    }
  }
  return out;
}

defineNode({
  type: 'offset_curve_3d',
  category: 'curve',
  summary: 'Offset curves sideways in 3D (rotation-minimising frame or a fixed plane normal): rails, kerbs, parallel paths.',
  description: 'Each edge moves by distance along its side vector direction × up (positive = to the right of the direction of travel, like side_offset of points_along_curve), where up comes from a rotation-minimising frame started at `up` (point attribute up overrides) or, with frame "plane", is the fixed `up` normal (keeps both rails level on a sloped path). Corners: mitre (sharp; beyond mitre_limit × distance becomes bevel), round or bevel on the outer side; inner corners always meet at the mitre point. lift raises the result along up. both:true writes the -distance offset too (prim int side ±1) — a double rail for sweep. Bezier/NURBS curves are sampled first. offset_curve is the 2D (Clipper) offset of closed shapes in a plane: use it for outlines/insets of flat shapes, this one for open 3D paths.',
  aliases: ['curve_offset', 'offset3d', 'polyoffset'],
  inputs: [{ name: 'curves', desc: 'polylines/polygons (Bezier/NURBS curves are sampled adaptively)' }],
  splines: 'keep',
  params: {
    distance: { type: 'float', default: 0.25, desc: 'side offset, positive = right of the direction of travel (negative = left)', aliases: ['offset', 'dist'] },
    lift: { type: 'float', default: 0, desc: 'offset along up (e.g. rail height)', aliases: ['height', 'up_offset'] },
    frame: { type: 'enum', options: ['rmf', 'plane'], default: 'rmf', desc: 'rmf = rotation-minimising frame along each curve; plane = fixed up normal' },
    up: { type: 'vec3', default: [0, 1, 0], desc: 'initial up (rmf) or the plane normal (plane)', aliases: ['normal', 'plane_normal'] },
    corner: { type: 'enum', options: ['mitre', 'round', 'bevel'], default: 'mitre', desc: 'outer corner style', aliases: ['join', 'corners'] },
    mitre_limit: { type: 'float', default: 4, min: 1, desc: 'mitres longer than this × distance are bevelled', aliases: ['miter_limit'] },
    round_segments: { type: 'int', default: 4, min: 1, desc: 'segments per 90° of round corners' },
    both: { type: 'bool', default: false, desc: 'also output the -distance offset (two rails; prim int side = +1 / -1)', aliases: ['both_sides', 'double'] },
    keep_input: { type: 'bool', default: false, desc: 'keep the input curves as well' },
    group: P.group('prim'),
  },
  outputs: 'prim int side (+1 / -1) with both',
  example: { type: 'offset_curve_3d', params: { distance: 0.6, lift: 1, both: true } },
  cook: ({ input, p }) => {
    const g = evaluateSplines(input(0));
    const sel = mask(g, 'prim', p.group);
    const upA = g.points.get('up');
    const plane = p.frame === 'plane' ? normalize(p.up) : null;
    if (plane && !(Math.hypot(...plane) > 0)) throw new NodeError('up must be a non-zero vector');
    const rb = new Rebuild(g);
    const sideA = p.both ? rb.b.attrib('prim', 'side', 1, 'int') : null;
    for (let pr = 0; pr < g.numPrims; pr++) {
      if ((sel && !sel[pr]) || !isCurvePrim(g, pr)) { rb.keep(pr); continue; }
      let pts = g.primPoints(pr), closed = !!g.primClosed[pr] && pts.length >= 3;
      const loop = !closed && pts.length > 3 && pts[0] === pts[pts.length - 1];
      if (loop) { pts = pts.slice(0, -1); closed = true; }
      const X = positionsOf(g, pts);
      let ups: Vec3[];
      if (plane) ups = pts.map(() => plane);
      else {
        const list = Array.from({ length: pts.length }, (_, k) => v3(X, k) as number[]);
        ups = rmFrames(list, closed, p.up, upA && upA.size === 3 ? pts.map((i) => upA.get(i) as Vec3) : undefined).Y;
      }
      if (p.keep_input) { const np = rb.keep(pr); if (sideA) sideA.set(np, 0); }
      const sides = p.both ? [1, -1] : [1];
      for (const sgn of sides) {
        const res = offsetPolyline(X, closed, ups, plane, p.distance * sgn, p.lift, p.corner, p.mitre_limit, p.round_segments);
        const verts: CurveVtx[] = res.map((r) => ({ P: r.P, idx: [r.k], w: [1] }));
        const { prim } = rb.addCurve(pr, verts, closed && !loop, undefined, loop);
        if (sideA) sideA.set(prim, sgn);
      }
    }
    return rb.finish();
  },
});

// ---------------------------------------------------------------- project_curve

/** Curves resampled evenly by arc length (spacing; splines exactly), isolated points copied; attributes blended. */
function resampleBySpacing(g: Geometry, spacing: number): Geometry {
  const b = new GeoBuilder(g);
  const used = new Uint8Array(g.numPoints);
  for (let v = 0; v < g.numVertices; v++) used[g.vertexPoint[v]] = 1;
  for (let i = 0; i < g.numPoints; i++) if (!used[i]) b.copyPoint(i);
  for (let pr = 0; pr < g.numPrims; pr++) {
    const pts = g.primPoints(pr);
    if (!isCurvePrim(g, pr)) { b.addPrim(pts.map((i) => b.copyPoint(i)), !!g.primClosed[pr], pr); continue; }
    if (g.isSpline(pr)) {
      const s = splineFromPrim(g, pr);
      const tab = arcTable(s);
      const nseg = Math.max(s.closed ? 3 : 1, Math.round(tab.total / spacing));
      const ids = samplesByLength(s, nseg, tab).u.map((u) => { const e = evalBasis(s, u); return b.addPoint(e.P[0], e.P[1], e.P[2], { i: e.idx.map((k) => pts[k]), w: e.w }); });
      b.addPrim(ids, s.closed, pr);
      continue;
    }
    const closed = !!g.primClosed[pr];
    const idx = closed ? [...pts, pts[0]] : pts;
    const L = [0];
    for (let k = 1; k < idx.length; k++) L.push(L[k - 1] + Math.hypot(...([0, 1, 2].map((c) => g.P[idx[k] * 3 + c] - g.P[idx[k - 1] * 3 + c]) as Vec3)));
    const total = L[L.length - 1];
    const nseg = Math.max(closed ? 3 : 1, Math.round(total / spacing));
    const ids: number[] = [];
    let k = 0;
    for (let i = 0; i < (closed ? nseg : nseg + 1); i++) {
      const s = (total * i) / nseg;
      while (k < L.length - 2 && L[k + 1] < s) k++;
      const f = L[k + 1] > L[k] ? Math.min(1, Math.max(0, (s - L[k]) / (L[k + 1] - L[k]))) : 0;
      ids.push(f === 0 ? b.copyPoint(idx[k]) : f === 1 ? b.copyPoint(idx[k + 1]) : b.blendPoint([idx[k], idx[k + 1]], [1 - f, f]));
    }
    b.addPrim(ids, closed, pr);
  }
  return tidySplineAttribs(b.build());
}

defineNode({
  type: 'project_curve',
  category: 'curve',
  summary: 'Project curves onto a surface or heightfield (along a direction or to the closest point): roads and paths on terrain.',
  description: 'Houdini Ray SOP applied to curves. Optionally resamples each curve by spacing first (splines exactly), so the projected curve follows the surface between the original points. direction mode casts rays (both ways with bidirectional); closest snaps to the nearest surface point. Writes point hit (1/0) and N (surface normal at the hit); misses stay where they are or are deleted. lift raises the result along the normal. Targets: polygons (input 1), or a heightfield (sampled exactly for vertical rays, through its preview mesh otherwise).',
  aliases: ['curve_project', 'ray_curve', 'projectcurve'],
  inputs: [{ name: 'curves', desc: 'curves (or points) to project' }, { name: 'target', desc: 'surface mesh or heightfield' }],
  splines: 'keep',
  params: {
    mode: { type: 'enum', options: ['direction', 'closest'], default: 'direction', desc: 'rays along direction, or the closest surface point' },
    direction: { type: 'vec3', default: [0, -1, 0], desc: 'ray direction (mode direction)', aliases: ['dir'] },
    bidirectional: { type: 'bool', default: true, desc: 'also cast the opposite direction (the nearer hit wins)' },
    spacing: { type: 'float', default: 0, min: 0, desc: 'resample curves to this segment length first (0 = keep the points)', aliases: ['resample', 'length'] },
    lift: { type: 'float', default: 0, desc: 'offset from the surface along its normal' },
    max_distance: { type: 'float', default: 1e9, min: 0, desc: 'ignore hits further than this' },
    misses: { type: 'enum', options: ['keep', 'delete'], default: 'keep', desc: 'points without a hit: stay where they are (hit 0) or are deleted' },
    normals: { type: 'bool', default: true, desc: 'write point N from the surface' },
    smooth_normals: { type: 'bool', default: true, desc: 'N (and lift) from the interpolated vertex normals of the surface (60° cusp); false = the normal of the hit face' },
    group: P.group('point'),
  },
  outputs: 'point hit (int), N (surface normal)',
  example: { type: 'project_curve', params: { spacing: 0.25, lift: 0.05 } },
  cook: ({ input, hasInput, p }) => {
    if (!hasInput(1)) throw new NodeError('project_curve needs a target surface or heightfield in input 1');
    const g0 = input(0), tgt = input(1);
    const g = (p.spacing > 0 ? resampleBySpacing(g0, p.spacing) : evaluateSplines(g0)).clone();
    const dir = normalize(p.direction);
    if (p.mode === 'direction' && !(Math.hypot(...dir) > 0)) throw new NodeError('direction must be a non-zero vector');
    let polys = 0;
    for (let pr = 0; pr < tgt.numPrims; pr++) if (tgt.primClosed[pr] && tgt.primSize(pr) >= 3 && !tgt.isPacked(pr)) { polys++; break; }
    const hf = heightfieldsOf(tgt)[0] ?? null;
    const vertical = Math.abs(dir[1]) > 1 - 1e-9;
    const exactHF = !polys && hf && p.mode === 'direction' && vertical ? hf : null;
    let bvh: TriBVH | null = null, fn: Float64Array | null = null, vn: Float64Array | null = null;
    if (!exactHF) {
      const mesh = polys ? tgt : hf ? heightfieldPreviewMesh(hf) : tgt;
      bvh = new TriBVH(mesh);
      if (!bvh.numTris) throw new NodeError('target has no polygons or heightfield to project onto');
      fn = primNormals(mesh) as Float64Array;
      if (p.smooth_normals) vn = resolveVertexNormals(mesh, 60);
    }
    /** Surface normal at a hit: barycentric blend of the triangle's vertex normals, or its face normal. */
    const normalAt = (tri: number, prim: number, b0: number, b1: number, b2: number): Vec3 => {
      if (!vn) return [fn![prim * 3], fn![prim * 3 + 1], fn![prim * 3 + 2]];
      const T = bvh!.triVtx, a = T[tri * 3] * 3, b = T[tri * 3 + 1] * 3, c = T[tri * 3 + 2] * 3;
      const n = normalize([b0 * vn[a] + b1 * vn[b] + b2 * vn[c], b0 * vn[a + 1] + b1 * vn[b + 1] + b2 * vn[c + 1], b0 * vn[a + 2] + b1 * vn[b + 2] + b2 * vn[c + 2]]);
      return Math.hypot(...n) > 0 ? n : [fn![prim * 3], fn![prim * 3 + 1], fn![prim * 3 + 2]];
    };
    const sel = mask(g, 'point', p.group);
    const Pd = g.P;
    // origin nudges perpendicular to the ray (1e-7 of the target size) for rays that hit a triangle edge exactly
    const tb = tgt.bbox(true), eps = 1e-7 * Math.max(1e-6, Math.hypot(tb.max[0] - tb.min[0], tb.max[1] - tb.min[1], tb.max[2] - tb.min[2]));
    const e1 = normalize(cross(dir, Math.abs(dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])), e2 = cross(dir, e1);
    const nudges: Vec3[] = [[0, 0, 0], [e1[0] * eps, e1[1] * eps, e1[2] * eps], [(e1[0] + e2[0]) * -eps, (e1[1] + e2[1]) * -eps, (e1[2] + e2[2]) * -eps]];
    const hitA = g.points.add('hit', 'int', 1).data as Int32Array;
    const NA = p.normals ? (g.points.add('N', 'float', 3).data as Float64Array) : null;
    const miss = new Uint8Array(g.numPoints);
    for (let i = 0; i < g.numPoints; i++) {
      if (sel && !sel[i]) continue;
      const x = Pd[i * 3], y = Pd[i * 3 + 1], z = Pd[i * 3 + 2];
      let pos: number[] | null = null, nrm: Vec3 = [0, 1, 0];
      if (exactHF) {
        const b = exactHF.bounds;
        if (x >= b.min[0] - 1e-9 && x <= b.max[0] + 1e-9 && z >= b.min[2] - 1e-9 && z <= b.max[2] + 1e-9) {
          const h = exactHF.sample(x, z);
          if (Math.abs(h - y) <= p.max_distance && (p.bidirectional || (dir[1] < 0 ? h <= y : h >= y))) {
            const e = exactHF.cellSize;
            nrm = normalize([-(exactHF.sample(x + e, z) - exactHF.sample(x - e, z)) / (2 * e), 1, -(exactHF.sample(x, z + e) - exactHF.sample(x, z - e)) / (2 * e)]);
            pos = [x, h, z];
          }
        }
      } else if (p.mode === 'closest') {
        const c = bvh!.closest(x, y, z, p.max_distance);
        if (c) { pos = c.pos; nrm = normalAt(c.tri, c.prim, c.bary[0], c.bary[1], c.bary[2]); }
      } else {
        // a ray exactly along a shared triangle edge can slip between both triangles: retry from nudged origins
        for (let k = 0; k < nudges.length && !pos; k++) {
          const ox = x + nudges[k][0], oy = y + nudges[k][1], oz = z + nudges[k][2];
          const a = bvh!.raycast(ox, oy, oz, dir[0], dir[1], dir[2], p.max_distance, 0);
          const bk = p.bidirectional ? bvh!.raycast(ox, oy, oz, -dir[0], -dir[1], -dir[2], p.max_distance, 0) : null;
          const best = a && (!bk || a.t <= bk.t) ? a : bk;
          if (best) { pos = [best.pos[0] - nudges[k][0], best.pos[1] - nudges[k][1], best.pos[2] - nudges[k][2]]; nrm = normalAt(best.tri, best.prim, 1 - best.u - best.v, best.u, best.v); }
        }
      }
      if (!pos) { miss[i] = 1; hitA[i] = 0; continue; }
      Pd[i * 3] = pos[0] + nrm[0] * p.lift; Pd[i * 3 + 1] = pos[1] + nrm[1] * p.lift; Pd[i * 3 + 2] = pos[2] + nrm[2] * p.lift;
      hitA[i] = 1;
      if (NA) { NA[i * 3] = nrm[0]; NA[i * 3 + 1] = nrm[1]; NA[i * 3 + 2] = nrm[2]; }
    }
    if (p.misses === 'delete' && miss.some((m) => m)) return g.subsetPoints(miss.map((m) => (m ? 0 : 1)));
    return g;
  },
});

// ---------------------------------------------------------------- curve_attribs

defineNode({
  type: 'curve_attribs',
  category: 'curve',
  summary: 'Write curveu, arclength, tangent, frames (N/up), curvature, segment index and ramps along curves.',
  description: 'Houdini Orient Along Curve plus the measure/attribute parts of Resample. Per point of each curve: curveu (0..1 by arc length), arclength (distance from the start), tangentu (unit tangent), with frame: N = tangent and up = rotation-minimising up (what copy_to_points needs to align copies along the curve; sweep reads up), curvature (1/radius; polylines: circle through the point and its neighbours), segment (index of the edge that starts at the point; splines: knot span / Bezier segment). ramp_attrib evaluates `ramp` at curveu into a float attribute (e.g. width for polywire, pscale for copies). On Bezier/NURBS prims the values are written on the CVs, evaluated on the curve at each CV\'s natural parameter (Greville abscissa).',
  aliases: ['curveu', 'curve_attributes', 'orient_along_curve', 'orientalongcurve'],
  inputs: [{ name: 'curves', desc: 'polylines, polygons, Bezier or NURBS curves' }],
  splines: 'keep',
  params: {
    curveu: { type: 'bool', default: true, desc: 'write point curveu (0..1 by arc length)' },
    arclength: { type: 'bool', default: true, desc: 'write point arclength (distance from the curve start)', aliases: ['length'] },
    tangent: { type: 'bool', default: true, desc: 'write point tangentu (unit tangent)' },
    frame: { type: 'bool', default: false, desc: 'write point N (= tangent) and up (rotation-minimising), for copy_to_points/sweep', aliases: ['orient', 'frames'] },
    curvature: { type: 'bool', default: false, desc: 'write point curvature (1/radius)' },
    segment: { type: 'bool', default: false, desc: 'write point int segment (edge / span index)' },
    up: { type: 'vec3', default: [0, 1, 0], desc: 'initial up of the rotation-minimising frames (an input point attribute up steers them per point instead)' },
    ramp_attrib: { type: 'string', default: '', desc: 'float point attribute to fill with ramp(curveu), e.g. "width" ("" = none)', aliases: ['attrib', 'name'] },
    ramp: { type: 'ramp', default: [[0, 1], [1, 1]], desc: 'value along the curve (u 0..1) for ramp_attrib' },
    ramp_scale: { type: 'float', default: 1, desc: 'multiplier of the ramp values' },
    group: P.group('prim'),
  },
  outputs: 'point curveu, arclength, tangentu, N + up (frame), curvature, segment, ramp_attrib',
  example: { type: 'curve_attribs', params: { frame: true, ramp_attrib: 'width', ramp: [[0, 0.3], [1, 0.05]] } },
  cook: ({ input, p }) => {
    const g = input(0).clone();
    const sel = mask(g, 'prim', p.group);
    // an up attribute of the input steers the frames (read before frame:true writes its own)
    const upIn = g.points.get('up');
    const ups = upIn && upIn.size === 3 && upIn.type === 'float' ? (upIn.clone().data as Float64Array) : null;
    const pa = (name: string, size = 1, type: 'float' | 'int' = 'float') => g.points.add(name, type, size);
    const cu = p.curveu ? pa('curveu') : null, al = p.arclength ? pa('arclength') : null, tg = p.tangent ? pa('tangentu', 3) : null;
    const NA = p.frame ? pa('N', 3) : null, UA = p.frame ? pa('up', 3) : null, kA = p.curvature ? pa('curvature') : null, sA = p.segment ? pa('segment', 1, 'int') : null;
    let rampA: ReturnType<typeof pa> | null = null;
    if (p.ramp_attrib) {
      const v0 = evalRamp(p.ramp, 0);
      rampA = g.points.add(p.ramp_attrib, 'float', Array.isArray(v0) ? v0.length : 1);
    }
    for (let pr = 0; pr < g.numPrims; pr++) {
      if ((sel && !sel[pr]) || !isCurvePrim(g, pr)) continue;
      const pts = g.primPoints(pr), n = pts.length;
      let closed = !!g.primClosed[pr] && n >= 3;
      const u = new Float64Array(n), len = new Float64Array(n), curv = new Float64Array(n), seg = new Int32Array(n);
      const tan: Vec3[] = new Array(n);
      let pos: number[][];
      if (g.isSpline(pr)) {
        const s: Spline = splineFromPrim(g, pr);
        closed = s.closed;
        const tab = arcTable(s);
        const us = Array.from({ length: n }, (_, k) => grevilleU(s, k));
        pos = us.map((x) => evalPoint(s, x));
        for (let k = 0; k < n; k++) {
          len[k] = lengthAtU(s, tab, us[k]);
          u[k] = tab.total > 0 ? len[k] / tab.total : 0;
          tan[k] = tangentAt(s, us[k]);
          curv[k] = curvatureAt(s, us[k]);
          seg[k] = s.type === 'bezier' ? Math.min(s.pieces.length - 1, Math.floor(us[k] * s.pieces.length)) : Math.max(0, spanIndex(s, us[k]));
        }
      } else {
        const X = positionsOf(g, pts);
        pos = Array.from({ length: n }, (_, k) => v3(X, k) as number[]);
        let acc = 0;
        for (let k = 0; k < n; k++) {
          if (k) acc += Math.hypot(X[k * 3] - X[k * 3 - 3], X[k * 3 + 1] - X[k * 3 - 2], X[k * 3 + 2] - X[k * 3 - 1]);
          len[k] = acc;
        }
        const total = closed ? acc + Math.hypot(X[0] - X[(n - 1) * 3], X[1] - X[(n - 1) * 3 + 1], X[2] - X[(n - 1) * 3 + 2]) : acc;
        for (let k = 0; k < n; k++) {
          u[k] = total > 0 ? len[k] / total : 0;
          seg[k] = closed ? k : Math.min(k, n - 2);
          // curvature of the circle through the point and its neighbours
          if (closed || (k > 0 && k < n - 1)) {
            const A = v3(X, (k - 1 + n) % n), B = v3(X, k), C = v3(X, (k + 1) % n);
            const ab: Vec3 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], bc: Vec3 = [C[0] - B[0], C[1] - B[1], C[2] - B[2]], ac: Vec3 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
            const den = Math.hypot(...ab) * Math.hypot(...bc) * Math.hypot(...ac);
            curv[k] = den > 1e-300 ? (2 * Math.hypot(...cross(ab, bc))) / den : 0;
          }
        }
      }
      const F = rmFrames(pos, closed, p.up, ups ? pts.map((i) => [ups[i * 3], ups[i * 3 + 1], ups[i * 3 + 2]] as Vec3) : undefined);
      for (let k = 0; k < n; k++) {
        const i = pts[k];
        const t = tan[k] ?? F.T[k];
        if (cu) cu.set(i, u[k]);
        if (al) al.set(i, len[k]);
        if (tg) tg.set(i, t);
        if (NA) NA.set(i, t);
        if (UA) UA.set(i, F.Y[k]);
        if (kA) kA.set(i, curv[k]);
        if (sA) sA.set(i, seg[k]);
        if (rampA) {
          const v = evalRamp(p.ramp, u[k]);
          rampA.set(i, Array.isArray(v) ? v.map((x: number) => x * p.ramp_scale) : v * p.ramp_scale);
        }
      }
    }
    return g;
  },
});

/** Knot span number (0-based, among the non-empty spans) of a NURBS at global u. */
function spanIndex(s: Spline, u: number): number {
  const pc = s.pieces[0];
  if (!pc || pc.bezier) return 0;
  const t = pc.a + Math.min(1, Math.max(0, u)) * (pc.b - pc.a);
  let k = -1;
  let last = -Infinity;
  for (let i = 0; i < pc.U.length - 1; i++) {
    const a = pc.U[i], b = pc.U[i + 1];
    if (!(b > a) || b <= pc.a || a >= pc.b) continue;
    if (a !== last) k++;
    last = a;
    if (t < b || b >= pc.b) return k;
  }
  return Math.max(0, k);
}
