// Curves: generation (line, circle, curve, spiral, 2D shapes) and operations
// (resample, carve, ends, sweep, polywire, revolve, extrude, offset, 2D booleans, fill, loft).
// Bezier/NURBS prims and the spline toolkit live in splines.ts (nodes) and core/splines.ts (kernels).
import { GeoBuilder, Geometry } from '../core/geometry.ts';
import type { Src } from '../core/geometry.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import { add, cross, dot, length, m4applyDir, m4euler, normalize, scale, sub } from '../core/math.ts';
import type { Vec3 } from '../core/math.ts';
import { orientOutward, primNormals, topologyReport } from '../core/topology.ts';
import { mergeTriangles } from '../core/polymerge.ts';
import earcut from 'earcut';
import { crossSection, crossSectionFaces, detectPlane, fromManifold, orientNested, planeMatrix, polygonsToGeo, propLayout, toPolygons } from '../core/manifold.ts';
import type { Plane } from '../core/manifold.ts';
import { FRAMES, P, mask } from './util.ts';
import { evalRamp } from '../graph/params.ts';
import { arcTable, evalBasis, evaluateSplines, samplesByLength, splineFromPrim, tangentAt, tidySplineAttribs } from '../core/splines.ts';
import { filletCurves } from './splines.ts';

// ---------------------------------------------------------------- helpers

/** Catmull–Rom (centripetal) through points; returns dense samples. */
export function catmullRom(pts: number[][], closed: boolean, sub: number): { pos: number[][]; seg: number[]; t: number[] } {
  const n = pts.length;
  const out: number[][] = [], seg: number[] = [], tt: number[] = [];
  if (n < 2) return { pos: pts.map((p) => p.slice()), seg: pts.map(() => 0), t: pts.map(() => 0) };
  const get = (i: number) => {
    if (closed) return pts[((i % n) + n) % n];
    if (i < 0) return pts[0].map((v, c) => 2 * v - pts[1][c]);
    if (i >= n) return pts[n - 1].map((v, c) => 2 * v - pts[n - 2][c]);
    return pts[i];
  };
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    const d = (a: number[], b: number[]) => Math.pow(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), 0.5) || 1e-6;
    const t0 = 0, t1 = t0 + d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3);
    for (let k = 0; k < sub; k++) {
      const t = t1 + ((t2 - t1) * k) / sub;
      const v = [0, 1, 2].map((c) => {
        const A1 = ((t1 - t) / (t1 - t0)) * p0[c] + ((t - t0) / (t1 - t0)) * p1[c];
        const A2 = ((t2 - t) / (t2 - t1)) * p1[c] + ((t - t1) / (t2 - t1)) * p2[c];
        const A3 = ((t3 - t) / (t3 - t2)) * p2[c] + ((t - t2) / (t3 - t2)) * p3[c];
        const B1 = ((t2 - t) / (t2 - t0)) * A1 + ((t - t0) / (t2 - t0)) * A2;
        const B2 = ((t3 - t) / (t3 - t1)) * A2 + ((t - t1) / (t3 - t1)) * A3;
        return ((t2 - t) / (t2 - t1)) * B1 + ((t - t1) / (t2 - t1)) * B2;
      });
      out.push(v); seg.push(i); tt.push(k / sub);
    }
  }
  if (!closed) { out.push(pts[n - 1].slice()); seg.push(n - 2); tt.push(1); }
  return { pos: out, seg, t: tt };
}

function curvePoints(g: Geometry, p: number): number[][] {
  const Pd = g.P;
  return g.primPoints(p).map((i) => [Pd[i * 3], Pd[i * 3 + 1], Pd[i * 3 + 2]]);
}

/** Rotation-minimising frames (double reflection). Returns per-point [X, Y, Z=T]. */
export function rmFrames(pts: number[][], closed: boolean, up: Vec3, ups?: (Vec3 | null)[]): { X: Vec3[]; Y: Vec3[]; T: Vec3[] } {
  const n = pts.length;
  const T: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const a = closed ? pts[(i - 1 + n) % n] : pts[Math.max(0, i - 1)];
    const b = closed ? pts[(i + 1) % n] : pts[Math.min(n - 1, i + 1)];
    let t = normalize(sub(b as Vec3, a as Vec3));
    if (length(t) === 0) t = i > 0 ? T[i - 1] : [0, 0, 1];
    T.push(t);
  }
  const Y: Vec3[] = [], X: Vec3[] = [];
  const perpUp = (t: Vec3, u: Vec3): Vec3 => {
    let y = sub(u, scale(t, dot(u, t)));
    if (length(y) < 1e-6) {
      const alt: Vec3 = Math.abs(t[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      y = sub(alt, scale(t, dot(alt, t)));
    }
    return normalize(y);
  };
  if (ups && ups.every((u) => u)) {
    for (let i = 0; i < n; i++) { Y.push(perpUp(T[i], ups[i]!)); X.push(cross(Y[i], T[i])); }
    return { X, Y, T };
  }
  Y.push(perpUp(T[0], up));
  for (let i = 0; i < n - 1; i++) {
    const v1 = sub(pts[i + 1] as Vec3, pts[i] as Vec3);
    const c1 = dot(v1, v1);
    if (c1 < 1e-20) { Y.push(Y[i]); continue; }
    const rL = sub(Y[i], scale(v1, (2 / c1) * dot(v1, Y[i])));
    const tL = sub(T[i], scale(v1, (2 / c1) * dot(v1, T[i])));
    const v2 = sub(T[i + 1], tL);
    const c2 = dot(v2, v2);
    Y.push(normalize(c2 < 1e-20 ? rL : sub(rL, scale(v2, (2 / c2) * dot(v2, rL)))));
  }
  if (closed && n > 2) {
    // distribute the holonomy so the frame closes without a seam twist
    const yEnd = Y[n - 1];
    const v1 = sub(pts[0] as Vec3, pts[n - 1] as Vec3), c1 = dot(v1, v1);
    let yWrap = yEnd;
    if (c1 > 1e-20) {
      const rL = sub(yEnd, scale(v1, (2 / c1) * dot(v1, yEnd)));
      const tL = sub(T[n - 1], scale(v1, (2 / c1) * dot(v1, T[n - 1])));
      const v2 = sub(T[0], tL), c2 = dot(v2, v2);
      yWrap = normalize(c2 < 1e-20 ? rL : sub(rL, scale(v2, (2 / c2) * dot(v2, rL))));
    }
    const ang = Math.atan2(dot(cross(yWrap, Y[0]), T[0]), dot(yWrap, Y[0]));
    for (let i = 0; i < n; i++) {
      const a = (ang * i) / n;
      const x0 = cross(Y[i], T[i]);
      Y[i] = normalize(add(scale(Y[i], Math.cos(a)), scale(x0, Math.sin(a))));
    }
  }
  for (let i = 0; i < n; i++) X.push(cross(Y[i], T[i]));
  return { X, Y, T };
}

function arcLengths(pts: number[][], closed: boolean): number[] {
  const L = [0];
  for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]));
  if (closed && pts.length > 1) {
    const a = pts[pts.length - 1], b = pts[0];
    L.push(L[L.length - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  }
  return L;
}

function placeOnPlane(u: number, v: number, plane: keyof typeof FRAMES, c: Vec3): number[] {
  const { U, V } = FRAMES[plane];
  return [c[0] + U[0] * u + V[0] * v, c[1] + U[1] * u + V[1] * v, c[2] + U[2] * u + V[2] * v];
}

// ---------------------------------------------------------------- generators

defineNode({
  type: 'line',
  category: 'curve',
  summary: 'Straight polyline from an origin along a direction.',
  inputs: [],
  params: {
    origin: { type: 'vec3', default: [0, 0, 0], desc: 'start point', aliases: ['start', 'center'] },
    direction: { type: 'vec3', default: [0, 1, 0], desc: 'direction (normalised)', aliases: ['dir'] },
    length: { type: 'float', default: 1, desc: 'length', aliases: ['dist'] },
    points: { type: 'int', default: 2, min: 2, max: 1000000, desc: 'number of points', aliases: ['count', 'npts'] },
  },
  example: { type: 'line', params: { direction: [1, 0, 0], length: 5, points: 11 } },
  cook: ({ p }) => {
    const d = normalize(p.direction);
    const pts = Array.from({ length: p.points }, (_, i) => add(p.origin, scale(d, (p.length * i) / (p.points - 1))));
    return new Geometry({ positions: pts.flat(), prims: [pts.map((_, i) => i)], closed: false });
  },
});

defineNode({
  type: 'circle',
  category: 'curve',
  summary: 'Circle / ellipse / arc. Full circles are closed polygons (faces); arcs or open=true give polylines.',
  aliases: ['arc', 'ellipse'],
  inputs: [],
  params: {
    radius: { type: 'float', default: 1, desc: 'radius', aliases: ['rad', 'r'] },
    scale: { type: 'vec2', default: [1, 1], desc: 'ellipse scale along the plane axes' },
    segments: { type: 'int', default: 32, min: 3, max: 1000000, desc: 'number of segments', aliases: ['divisions', 'divs', 'points'] },
    plane: P.plane('xz'),
    center: P.center(),
    arc: { type: 'vec2', default: [0, 360], desc: 'begin/end angle in degrees (anything < 360 makes an open arc)' },
    open: { type: 'bool', default: false, desc: 'output an open polyline instead of a closed polygon face' },
  },
  example: { type: 'circle', params: { radius: 2, segments: 48, arc: [0, 180] } },
  cook: ({ p }) => {
    const span = p.arc[1] - p.arc[0];
    const full = Math.abs(span) >= 360 - 1e-9;
    const n = p.segments;
    const count = full ? n : n + 1;
    const pts: number[][] = [];
    for (let i = 0; i < count; i++) {
      const a = ((p.arc[0] + (span * i) / n) * Math.PI) / 180;
      pts.push(placeOnPlane(p.radius * p.scale[0] * Math.cos(a), p.radius * p.scale[1] * Math.sin(a), p.plane, p.center));
    }
    const ids = pts.map((_, i) => i);
    if (full && p.open) ids.push(0); // closed loop as an open polyline sharing the first point
    return new Geometry({ positions: pts.flat(), prims: [ids], closed: full && !p.open });
  },
});

defineNode({
  type: 'curve',
  category: 'curve',
  summary: 'Curve through explicit points; optional Catmull-Rom smoothing or rounded corners; open or closed.',
  description: 'corner_radius rounds the corners with arcs tangent to both edges: one number for every corner, or a list with one radius per point (0 keeps that corner sharp; the ends of an open curve are never rounded). Radii that do not fit between neighbouring corners shrink. A point that is not three numbers (NaN, null, a missing coordinate) is an error that names it.',
  aliases: ['polyline', 'path', 'spline'],
  inputs: [],
  params: {
    points: { type: 'json', default: [[0, 0, 0], [1, 0.5, 0], [2, 0, 0]], desc: 'list of [x,y,z] (2-number entries → [x, 0, z] on the ground)', aliases: ['positions', 'pts'] },
    closed: { type: 'bool', default: false, desc: 'close the curve (makes a polygon)' },
    smooth: { type: 'bool', default: false, desc: 'Catmull-Rom interpolate through the points (not with corner_radius)' },
    subdivisions: { type: 'int', default: 8, min: 1, max: 10000, desc: 'smooth: samples per segment' },
    corner_radius: { type: 'json', default: 0, desc: 'round the corners: a radius for every corner, or a list with one per point (0 = sharp)', aliases: ['fillet', 'radius', 'radii', 'corner_radii'] },
    corner_segments: { type: 'int', default: 6, min: 1, max: 10000, desc: 'segments per rounded corner' },
  },
  outputs: 'point group fillet (the points of rounded corners)',
  example: { type: 'curve', params: { points: [[0, 0, 0], [2, 0, 1], [4, 0, -1], [6, 0, 0]], smooth: true, subdivisions: 12 } },
  cook: ({ p, warn }) => {
    if (!Array.isArray(p.points) || p.points.length < 2) throw new NodeError('points must be a list of at least 2 [x,y,z]');
    const pts: number[][] = p.points.map((q: any, i: number) => {
      const ok = Array.isArray(q) && (q.length === 2 || q.length === 3) && q.every((x: unknown) => typeof x === 'number' && Number.isFinite(x));
      const v = ok ? (q.length === 2 ? [q[0], 0, q[1]] : [q[0], q[1], q[2]]) : [];
      if (!ok) throw new NodeError(`point ${i} is not three numbers: ${JSON.stringify(q)}`, 'every entry of points is [x, y, z] (or [x, z] on the ground); an expression that divides by zero gives NaN');
      return v;
    });
    const radii = p.corner_radius;
    const perPoint = Array.isArray(radii);
    if (perPoint && radii.length !== pts.length) throw new NodeError(`corner_radius has ${radii.length} entries for ${pts.length} points`, 'give one radius per point (0 keeps a corner sharp), or one number for every corner');
    if (!perPoint && !(typeof radii === 'number' && Number.isFinite(radii))) throw new NodeError(`corner_radius must be a number or a list of numbers, got ${JSON.stringify(radii)}`);
    if (perPoint && !radii.every((r: any) => typeof r === 'number' && Number.isFinite(r))) throw new NodeError('corner_radius: every entry must be a number');
    const rounded = perPoint ? radii.some((r: number) => r > 0) : radii > 0;
    if (rounded && p.smooth) warn('smooth is ignored: corner_radius rounds the corners instead');
    const final = p.smooth && pts.length > 2 && !rounded ? catmullRom(pts, p.closed, p.subdivisions).pos : pts;
    const g = new Geometry({ positions: final.flat(), prims: [final.map((_, i) => i)], closed: p.closed });
    if (!rounded) return g;
    return filletCurves(g, {
      radius: 1, type: 'round', segments: p.corner_segments, angleMin: 0.01, sel: null, clamp: true,
      radiusOf: (pt) => (perPoint ? radii[pt] : radii),
    });
  },
});

defineNode({
  type: 'spiral',
  category: 'curve',
  summary: 'Helix / spiral curve rising along +Y.',
  aliases: ['helix'],
  inputs: [],
  params: {
    radius: { type: 'float', default: 1, desc: 'start radius' },
    radius_end: { type: 'float', default: -1, desc: 'end radius (-1 = same as radius)' },
    height: { type: 'float', default: 2, desc: 'total rise' },
    turns: { type: 'float', default: 3, desc: 'number of turns' },
    points_per_turn: { type: 'int', default: 32, min: 3, max: 100000, desc: 'resolution' },
    clockwise: { type: 'bool', default: false, desc: 'turn direction when seen from above' },
    center: P.center(),
  },
  example: { type: 'spiral', params: { radius: 1, radius_end: 0.3, height: 3, turns: 5 } },
  cook: ({ p }) => {
    const n = Math.max(2, Math.ceil(p.turns * p.points_per_turn) + 1);
    const r1 = p.radius_end < 0 ? p.radius : p.radius_end;
    const pts: number[][] = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1), a = t * p.turns * Math.PI * 2 * (p.clockwise ? -1 : 1), r = p.radius + (r1 - p.radius) * t;
      pts.push([p.center[0] + r * Math.cos(a), p.center[1] + p.height * t, p.center[2] - r * Math.sin(a)]);
    }
    return new Geometry({ positions: pts.flat(), prims: [pts.map((_, i) => i)], closed: false });
  },
});

defineNode({
  type: 'shape2d',
  category: 'curve',
  summary: 'Flat 2D shapes as closed polygons: rect, rounded_rect, capsule (slot), ngon, star, gear, cross, L, U.',
  aliases: ['rect', 'rectangle', 'ngon', 'star', 'polygon2d'],
  inputs: [],
  params: {
    shape: { type: 'enum', options: ['rect', 'rounded_rect', 'capsule', 'slot', 'ngon', 'star', 'gear', 'cross', 'L', 'U'], default: 'rect', desc: 'shape type; capsule and slot are the same stadium: a rect whose short ends are half circles' },
    size: { type: 'vec2', default: [1, 1], desc: 'rect/rounded_rect/capsule/slot/cross/L/U: width and depth (overall, ends included)' },
    radius: { type: 'float', default: 0.5, desc: 'ngon/star/gear: outer radius' },
    inner_radius: { type: 'float', default: 0.25, desc: 'star/gear: inner radius' },
    sides: { type: 'int', default: 6, min: 3, max: 100000, desc: 'ngon sides / star points / gear teeth', aliases: ['points', 'teeth'] },
    corner_radius: { type: 'float', default: 0.1, min: 0, desc: 'rounded_rect corner radius' },
    corner_segments: { type: 'int', default: 6, min: 1, max: 10000, desc: 'rounded_rect/capsule/slot: segments per quarter circle' },
    thickness: { type: 'float', default: 0.25, desc: 'cross/L/U arm thickness' },
    rotate: { type: 'float', default: 0, desc: 'rotation in degrees within the plane' },
    plane: P.plane('xz'),
    center: P.center(),
  },
  example: { type: 'shape2d', params: { shape: 'gear', radius: 1, inner_radius: 0.8, sides: 16 } },
  cook: ({ p }) => {
    const [w, d] = p.size;
    let pts2: number[][] = [];
    const hw = w / 2, hd = d / 2, t = p.thickness;
    switch (p.shape) {
      case 'rect': pts2 = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]]; break;
      case 'rounded_rect': case 'capsule': case 'slot': {
        const r = p.shape === 'rounded_rect' ? Math.min(p.corner_radius, hw, hd) : Math.min(hw, hd), s = p.corner_segments;
        const cs = [[hw - r, -hd + r, -90], [hw - r, hd - r, 0], [-hw + r, hd - r, 90], [-hw + r, -hd + r, 180]];
        for (const [cx, cy, a0] of cs) for (let k = 0; k <= s; k++) {
          const a = ((a0 + (90 * k) / s) * Math.PI) / 180;
          pts2.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
        }
        // a radius of half the width or depth makes neighbouring arcs meet: keep their shared end point once
        const eps = 1e-9 * Math.max(hw, hd);
        for (let i = pts2.length - 1; i >= 0 && pts2.length > 3; i--) {
          const q = pts2[(i + 1) % pts2.length];
          if (Math.abs(pts2[i][0] - q[0]) <= eps && Math.abs(pts2[i][1] - q[1]) <= eps) pts2.splice(i, 1);
        }
        break;
      }
      case 'ngon': for (let i = 0; i < p.sides; i++) { const a = (2 * Math.PI * i) / p.sides; pts2.push([p.radius * Math.cos(a), p.radius * Math.sin(a)]); } break;
      case 'star': for (let i = 0; i < p.sides * 2; i++) { const a = (Math.PI * i) / p.sides + Math.PI / 2, r = i % 2 ? p.inner_radius : p.radius; pts2.push([r * Math.cos(a), r * Math.sin(a)]); } break;
      case 'gear': {
        const n = p.sides;
        for (let i = 0; i < n; i++) {
          const a0 = (2 * Math.PI * i) / n, step = (2 * Math.PI) / n;
          for (const [f, r] of [[0, p.inner_radius], [0.2, p.radius], [0.5, p.radius], [0.7, p.inner_radius]] as [number, number][])
            pts2.push([r * Math.cos(a0 + f * step), r * Math.sin(a0 + f * step)]);
        }
        break;
      }
      case 'cross': {
        const a = t / 2;
        pts2 = [[-a, -hd], [a, -hd], [a, -a], [hw, -a], [hw, a], [a, a], [a, hd], [-a, hd], [-a, a], [-hw, a], [-hw, -a], [-a, -a]];
        break;
      }
      case 'L': pts2 = [[-hw, -hd], [hw, -hd], [hw, -hd + t], [-hw + t, -hd + t], [-hw + t, hd], [-hw, hd]]; break;
      case 'U': pts2 = [[-hw, -hd], [hw, -hd], [hw, hd], [hw - t, hd], [hw - t, -hd + t], [-hw + t, -hd + t], [-hw + t, hd], [-hw, hd]]; break;
    }
    const ra = (p.rotate * Math.PI) / 180, c = Math.cos(ra), s = Math.sin(ra);
    const pts = pts2.map(([u, v]) => placeOnPlane(u * c - v * s, u * s + v * c, p.plane, p.center));
    return new Geometry({ positions: pts.flat(), prims: [pts.map((_, i) => i)], closed: true });
  },
});

// ---------------------------------------------------------------- resample / carve / ends

defineNode({
  type: 'resample',
  category: 'curve',
  summary: 'Resample curves (and polygon outlines) to even spacing; optional smoothing. Adds curveu.',
  description: 'Bezier/NURBS prims are sampled on the true curve, evenly by arc length (treat_splines "exact"; their CV attributes are blended with the curve\'s own basis weights), or along their control polygon ("control_polygon"); either way the result is a polyline.',
  inputs: [{ name: 'curves', desc: 'polylines, polygons or Bezier/NURBS curves' }],
  splines: 'keep',
  params: {
    mode: { type: 'enum', options: ['length', 'count'], default: 'length', desc: 'segment length or a fixed segment count per curve' },
    length: { type: 'float', default: 0.1, min: 1e-6, desc: 'target segment length', aliases: ['seglen', 'segment_length'] },
    count: { type: 'int', default: 20, min: 1, max: 1000000, desc: 'segments per curve (mode=count)', aliases: ['segments'] },
    smooth: { type: 'bool', default: false, desc: 'Catmull-Rom smooth before resampling (polylines)' },
    group: P.group('prim'),
    tangent: { type: 'bool', default: false, desc: 'also write point tangentu (unit tangent)' },
    treat_splines: { type: 'enum', options: ['exact', 'control_polygon'], default: 'exact', desc: 'Bezier/NURBS prims: sample the curve itself by arc length (exact) or their control polygon as a polyline' },
  },
  outputs: 'point curveu (0..1 along each curve), optional tangentu',
  example: {
    nodes: {
      path: { type: 'curve', params: { points: [[0, 0, 0], [3, 0, 2], [6, 0, 0]] } },
      even: { type: 'resample', in: ['path'], params: { length: 0.25, smooth: true, tangent: true } },
    },
    output: 'even',
  },
  cook: ({ input, p }) => {
    const g = input(0);
    const sel = mask(g, 'prim', p.group);
    const b = new GeoBuilder(g);
    const cu = b.attrib('point', 'curveu', 1);
    const tg = p.tangent ? b.attrib('point', 'tangentu', 3) : null;
    const keptSplines: [number, number][] = [];
    for (let pr = 0; pr < g.numPrims; pr++) {
      const ptsIdx = g.primPoints(pr);
      const closed = !!g.primClosed[pr];
      if ((sel && !sel[pr]) || ptsIdx.length < 2) {
        const np = b.addPrim(ptsIdx.map((i) => b.copyPoint(i)), closed, pr);
        if (g.isSpline(pr)) keptSplines.push([np, g.primKind![pr]]);
        continue;
      }
      if (g.isSpline(pr) && p.treat_splines === 'exact') {
        // the true curve, evenly by arc length; CV attributes follow the curve's basis weights
        const s = splineFromPrim(g, pr);
        const tab = arcTable(s);
        let nseg = p.mode === 'count' ? p.count : Math.max(1, Math.round(tab.total / p.length));
        if (s.closed) nseg = Math.max(3, nseg);
        const smp = samplesByLength(s, nseg, tab);
        const ids = smp.u.map((u, i) => {
          const e = evalBasis(s, u);
          const id = b.addPoint(e.P[0], e.P[1], e.P[2], { i: e.idx.map((k) => ptsIdx[k]), w: e.w });
          cu.set(id, smp.total > 0 ? smp.len[i] / smp.total : 0);
          if (tg) tg.set(id, tangentAt(s, u));
          return id;
        });
        b.addPrim(ids, s.closed, pr);
        continue;
      }
      // dense polyline with provenance (pairs of source points + weight)
      let dense: { pos: number[]; a: number; bb: number; t: number }[] = [];
      const pts = curvePoints(g, pr);
      if (p.smooth && pts.length > 2) {
        const cr = catmullRom(pts, closed, 12);
        cr.pos.forEach((q, k) => {
          const i0 = cr.seg[k], i1 = closed ? (i0 + 1) % pts.length : Math.min(i0 + 1, pts.length - 1);
          dense.push({ pos: q, a: ptsIdx[i0], bb: ptsIdx[i1], t: cr.t[k] });
        });
        if (closed) dense.push({ ...dense[0] });
      } else {
        dense = ptsIdx.map((i, k) => ({ pos: pts[k], a: i, bb: i, t: 0 }));
        if (closed) dense.push({ pos: pts[0], a: ptsIdx[0], bb: ptsIdx[0], t: 0 });
      }
      const L = arcLengths(dense.map((d) => d.pos), false);
      const total = L[L.length - 1];
      let nseg = p.mode === 'count' ? p.count : Math.max(1, Math.round(total / p.length));
      if (closed) nseg = Math.max(3, nseg);
      const nOut = closed ? nseg : nseg + 1;
      const ids: number[] = [];
      let k = 0;
      for (let i = 0; i < nOut; i++) {
        const s = (total * i) / nseg;
        while (k < L.length - 2 && L[k + 1] < s) k++;
        const segL = L[k + 1] - L[k], f = segL > 0 ? (s - L[k]) / segL : 0;
        const A = dense[k], B = dense[k + 1];
        const pos = A.pos.map((v, c) => v + (B.pos[c] - v) * f);
        // provenance: blend the source points around this sample
        const wA = 1 - f, wB = f;
        const srcI = [A.a, A.bb, B.a, B.bb], srcW = [wA * (1 - A.t), wA * A.t, wB * (1 - B.t), wB * B.t];
        const id = b.addPoint(pos[0], pos[1], pos[2], { i: srcI, w: srcW } as Src);
        cu.set(id, total > 0 ? s / total : 0);
        if (tg) tg.set(id, normalize(sub(B.pos as Vec3, A.pos as Vec3)));
        ids.push(id);
      }
      b.addPrim(ids, closed, pr);
    }
    const out = b.build();
    if (!g.hasSplines()) return out;
    // spline prims outside the group stay splines (GeoBuilder makes every prim a polygon/polyline)
    if (keptSplines.length) { out.ensurePacked(); for (const [np, k] of keptSplines) out.primKind![np] = k; }
    return tidySplineAttribs(out);
  },
});

defineNode({
  type: 'carve',
  category: 'curve',
  summary: 'Trim curves to a portion of their length (u range 0..1).',
  inputs: [{ name: 'curves', desc: 'polylines (Bezier/NURBS curves are evaluated first)' }],
  splines: 'keep',
  params: {
    start: { type: 'float', default: 0, min: 0, max: 1, desc: 'start u (0..1 of arc length)' },
    end: { type: 'float', default: 0.5, min: 0, max: 1, desc: 'end u' },
  },
  example: {
    nodes: {
      path: { type: 'spiral', params: { turns: 2 } },
      part: { type: 'carve', in: ['path'], params: { start: 0.25, end: 0.75 } },
    },
    output: 'part',
  },
  cook: ({ input, p }) => {
    const g = evaluateSplines(input(0));
    const b = new GeoBuilder(g);
    for (let pr = 0; pr < g.numPrims; pr++) {
      const idx = g.primPoints(pr);
      if (g.primClosed[pr]) idx.push(idx[0]);
      const pts = idx.map((i) => [g.P[i * 3], g.P[i * 3 + 1], g.P[i * 3 + 2]]);
      const L = arcLengths(pts, false), T = L[L.length - 1];
      const s0 = Math.min(p.start, p.end) * T, s1 = Math.max(p.start, p.end) * T;
      const at = (s: number) => {
        let k = 0;
        while (k < L.length - 2 && L[k + 1] < s) k++;
        const f = L[k + 1] > L[k] ? (s - L[k]) / (L[k + 1] - L[k]) : 0;
        return b.blendPoint([idx[k], idx[k + 1]], [1 - f, f]);
      };
      const ids = [at(s0)];
      for (let k = 1; k < L.length - 1; k++) if (L[k] > s0 && L[k] < s1) ids.push(b.copyPoint(idx[k]));
      ids.push(at(s1));
      if (ids.length >= 2) b.addPrim(ids, false, pr);
    }
    return b.build();
  },
});

defineNode({
  type: 'ends',
  category: 'curve',
  summary: 'Convert between closed polygons and open polylines (unroll outlines / close curves).',
  aliases: ['unroll'],
  inputs: [{ name: 'geo', desc: 'polygons or polylines (Bezier/NURBS curves are evaluated first)' }],
  splines: 'keep',
  params: {
    mode: { type: 'enum', options: ['unroll', 'close', 'open'], default: 'unroll', desc: 'unroll: polygon → polyline outline (ends meet); close: polyline → polygon; open: polygon → polyline (drops closing edge)' },
    group: P.group('prim'),
  },
  example: {
    nodes: {
      ring: { type: 'circle', params: { radius: 1, segments: 32 } },
      outline: { type: 'ends', in: ['ring'], params: { mode: 'unroll' } },
    },
    output: 'outline',
  },
  cook: ({ input, p }) => {
    const g = evaluateSplines(input(0));
    const sel = mask(g, 'prim', p.group);
    const b = new GeoBuilder(g);
    for (let i = 0; i < g.numPoints; i++) b.copyPoint(i);
    for (let pr = 0; pr < g.numPrims; pr++) {
      const ids = g.primPoints(pr), on = !sel || sel[pr];
      const vs: number[] = [];
      for (let v = g.primStart[pr]; v < g.primStart[pr + 1]; v++) vs.push(v);
      if (on && p.mode === 'unroll' && g.primClosed[pr]) b.addPrim([...ids, ids[0]], false, pr, [...vs, vs[0]]);
      else if (on && p.mode === 'open' && g.primClosed[pr]) b.addPrim(ids, false, pr, vs);
      else if (on && p.mode === 'close' && !g.primClosed[pr]) {
        if (ids.length > 2 && ids[0] === ids[ids.length - 1]) { ids.pop(); vs.pop(); }
        b.addPrim(ids, true, pr, vs);
      } else b.addPrim(ids, !!g.primClosed[pr], pr, vs);
    }
    return b.build();
  },
});

// ---------------------------------------------------------------- sweep / polywire

interface Profile { pts: number[][]; closed: boolean }

function sweepCurves(
  g: Geometry, profiles: Profile[], o: { caps: boolean; twist: number; up: Vec3; scaleRamp: any[] | null; radiusOf?: (pt: number) => number; uvLength: boolean },
): Geometry {
  const b = new GeoBuilder(g);
  b.skip.point.add('N'); b.skip.point.add('up'); b.skip.point.add('tangentu');
  const uv = b.attrib('vertex', 'uv', 3);
  const upA = g.points.get('up');
  const psA = g.points.get('pscale');
  const capG = b.group('prim', 'caps'), sideG = b.group('prim', 'sides');
  for (let pr = 0; pr < g.numPrims; pr++) {
    let idx = g.primPoints(pr);
    let closed = !!g.primClosed[pr];
    if (!closed && idx.length > 2 && idx[0] === idx[idx.length - 1]) { idx = idx.slice(0, -1); closed = true; }
    if (idx.length < 2) continue;
    const pts = idx.map((i) => [g.P[i * 3], g.P[i * 3 + 1], g.P[i * 3 + 2]]);
    const ups = upA ? idx.map((i) => upA.get(i) as Vec3) : undefined;
    const F = rmFrames(pts, closed, o.up, ups);
    const L = arcLengths(pts, closed), total = L[L.length - 1] || 1;
    const prof = profiles[Math.min(pr, profiles.length - 1)];
    const m = prof.pts.length;
    const rings: number[][] = [], scales: number[] = [];
    for (let k = 0; k < pts.length; k++) {
      const u = L[k] / total;
      let s = psA ? (psA.get(idx[k]) as number) : 1;
      if (o.radiusOf) s *= o.radiusOf(idx[k]);
      if (o.scaleRamp) s *= evalRamp(o.scaleRamp, u) as number;
      scales.push(s);
      const tw = ((o.twist * u) * Math.PI) / 180, c = Math.cos(tw), sn = Math.sin(tw);
      const X = F.X[k], Y = F.Y[k], T = F.T[k];
      const ring: number[] = [];
      for (const q of prof.pts) {
        const px = (q[0] * c - q[1] * sn) * s, py = (q[0] * sn + q[1] * c) * s, pz = q[2] * s;
        ring.push(b.addPoint(pts[k][0] + X[0] * px + Y[0] * py + T[0] * pz, pts[k][1] + X[1] * px + Y[1] * py + T[1] * pz, pts[k][2] + X[2] * px + Y[2] * py + T[2] * pz, idx[k]));
      }
      rings.push(ring);
    }
    const nk = closed ? pts.length : pts.length - 1, nj = prof.closed ? m : m - 1;
    for (let k = 0; k < nk; k++) {
      const k1 = (k + 1) % pts.length;
      const v0 = L[k] / total, v1 = closed && k1 === 0 ? 1 : L[k + 1] / total;
      for (let j = 0; j < nj; j++) {
        const j1 = (j + 1) % m;
        const vb = b.numVertices;
        const prim = b.addPrim([rings[k][j], rings[k][j1], rings[k1][j1], rings[k1][j]], true, pr);
        sideG.add(prim);
        const scaleV = o.uvLength ? total : 1;
        [[j / nj, v0], [(j + 1) / nj, v0], [(j + 1) / nj, v1], [j / nj, v1]].forEach(([a, c2], q) => uv.set(vb + q, [a, c2 * scaleV, 0]));
      }
    }
    if (o.caps && !closed && prof.closed && m >= 3) {
      // caps take the profile's own flat layout: its x, y spread over 0..1 (uv_length: in metres at that end's scale)
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const q of prof.pts) { x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]); }
      const span = Math.max(x1 - x0, y1 - y0) || 1;
      for (const end of [0, rings.length - 1]) {
        const ids = end === 0 ? rings[0].slice().reverse() : rings[end].slice();
        const order = end === 0 ? prof.pts.map((_, j) => m - 1 - j) : prof.pts.map((_, j) => j);
        const sc = o.uvLength ? scales[end] : 1 / span;
        const vb = b.numVertices;
        capG.add(b.addPrim(ids, true, pr));
        order.forEach((j, q) => {
          const u = (prof.pts[j][0] - x0) * sc, v = (prof.pts[j][1] - y0) * sc;
          uv.set(vb + q, [end === 0 ? 1 - u : u, v, 0]);
        });
      }
    }
  }
  return b.build();
}

function circleProfile(r: number, n: number): Profile {
  return { pts: Array.from({ length: n }, (_, i) => [r * Math.cos((2 * Math.PI * i) / n), r * Math.sin((2 * Math.PI * i) / n), 0]), closed: true };
}

defineNode({
  type: 'sweep',
  category: 'curve',
  summary: 'Sweep a cross-section along curves using rotation-minimising frames (tubes, ribbons, rails, mouldings).',
  description: 'The profile is drawn in the XY plane around the origin, looking along the curve: at every curve point it is placed with its +Z along the curve (the direction of travel), its +Y on the up direction (the "up" param, or the point attribute up) kept perpendicular to the curve, and its +X = Y × Z, to the left of the direction of travel when up points up. The frame then turns as little as possible from point to point (rotation-minimising), so a flat ribbon does not twist on its own; twist adds a turn. The sides are wound so a closed profile drawn counter-clockwise (seen from +Z) faces outward; caps on open curves face away from the curve. uv: u runs around the profile, v along the curve; caps take the profile\'s flat layout.',
  inputs: [
    { name: 'backbone', desc: 'curves to sweep along (Bezier/NURBS curves are sampled adaptively)' },
    { name: 'profile', desc: 'cross-section curve drawn in the XY plane (optional; one per backbone or a single shared one)', optional: true },
  ],
  splines: 'keep',
  params: {
    shape: { type: 'enum', options: ['circle', 'square', 'rect', 'ribbon', 'half_circle'], default: 'circle', desc: 'built-in profile when no profile input; rect is size wide (X) and high (Y), for straps and bars' },
    radius: { type: 'float', default: 0.1, desc: 'built-in profile radius / half width', aliases: ['width', 'rad'] },
    size: { type: 'vec2', default: [0.2, 0.05], desc: 'rect profile: width along the profile X (sideways) and height along Y (up)' },
    divisions: { type: 'int', default: 12, min: 2, max: 1024, desc: 'built-in profile segments', aliases: ['sides', 'cols'] },
    caps: { type: 'bool', default: true, desc: 'cap open ends (closed profiles only)' },
    twist: { type: 'float', default: 0, desc: 'total twist in degrees along each curve' },
    scale_ramp: { type: 'ramp', default: [[0, 1], [1, 1]], desc: 'profile scale along the curve (u 0..1); point pscale also multiplies' },
    up: { type: 'vec3', default: [0, 1, 0], desc: 'initial up vector (point attribute "up" overrides per point)' },
    uv_length: { type: 'bool', default: false, desc: 'v coordinate in world length instead of 0..1' },
  },
  outputs: 'vertex uv; prim groups caps, sides',
  example: {
    nodes: {
      path: { type: 'curve', params: { points: [[0, 0, 0], [1, 1, 0], [3, 1.5, 1], [4, 3, 1]], smooth: true } },
      horn: { type: 'sweep', in: ['path'], params: { radius: 0.3, divisions: 16, scale_ramp: [[0, 1], [1, 0.1]] } },
    },
    output: 'horn',
  },
  cook: ({ input, hasInput, p }) => {
    const g = evaluateSplines(input(0));
    let profiles: Profile[];
    if (hasInput(1)) {
      const pg = evaluateSplines(input(1));
      profiles = [];
      for (let pr = 0; pr < pg.numPrims; pr++) profiles.push({ pts: curvePoints(pg, pr), closed: !!pg.primClosed[pr] });
      if (!profiles.length) throw new NodeError('profile input has no curves');
    } else if (p.shape === 'square') profiles = [{ pts: [[-p.radius, -p.radius, 0], [p.radius, -p.radius, 0], [p.radius, p.radius, 0], [-p.radius, p.radius, 0]], closed: true }];
    else if (p.shape === 'rect') { const w = p.size[0] / 2, h = p.size[1] / 2; profiles = [{ pts: [[-w, -h, 0], [w, -h, 0], [w, h, 0], [-w, h, 0]], closed: true }]; }
    else if (p.shape === 'ribbon') profiles = [{ pts: [[-p.radius, 0, 0], [p.radius, 0, 0]], closed: false }];
    else if (p.shape === 'half_circle') profiles = [{ pts: Array.from({ length: p.divisions + 1 }, (_, i) => { const a = (Math.PI * i) / p.divisions; return [p.radius * Math.cos(a), p.radius * Math.sin(a), 0]; }), closed: false }];
    else profiles = [circleProfile(p.radius, p.divisions)];
    const ramp = p.scale_ramp.length === 2 && p.scale_ramp.every((k: any) => k.value === 1) ? null : p.scale_ramp;
    return sweepCurves(g, profiles, { caps: p.caps, twist: p.twist, up: p.up, scaleRamp: ramp, uvLength: p.uv_length });
  },
});

defineNode({
  type: 'polywire',
  category: 'curve',
  summary: 'Turn curves into tubes. Per-point radius from "width" (diameter) or pscale. Great for branches, cables, wireframes.',
  aliases: ['wire', 'tubes'],
  inputs: [{ name: 'curves', desc: 'polylines (or polygon edges); Bezier/NURBS curves are sampled adaptively' }],
  splines: 'keep',
  params: {
    radius: { type: 'float', default: 0.05, desc: 'tube radius (used when no width attribute)', aliases: ['rad', 'wire_radius'] },
    divisions: { type: 'int', default: 8, min: 3, max: 1024, desc: 'sides around the tube', aliases: ['sides', 'cols'] },
    caps: { type: 'bool', default: true, desc: 'cap the tube ends' },
    use_width: { type: 'bool', default: true, desc: 'use point "width" attribute (diameter) when present' },
  },
  outputs: 'vertex uv; prim groups caps, sides',
  example: {
    nodes: {
      tree: { type: 'lsystem', params: { generations: 4 } },
      branches: { type: 'polywire', in: ['tree'], params: { divisions: 6 } },
    },
    output: 'branches',
  },
  cook: ({ input, p }) => {
    const g = evaluateSplines(input(0));
    const wA = p.use_width ? g.points.get('width') : undefined;
    return sweepCurves(g, [circleProfile(1, p.divisions)], {
      caps: p.caps, twist: 0, up: [0, 1, 0], scaleRamp: null, uvLength: false,
      radiusOf: (pt) => (wA ? Math.max(1e-6, (wA.get(pt) as number) / 2) : p.radius),
    });
  },
});

// ---------------------------------------------------------------- revolve / extrude / loft

defineNode({
  type: 'revolve',
  category: 'curve',
  summary: 'Lathe: revolve profile curves around an axis (Y through the origin by default). Profiles touching the axis close up.',
  description: 'Each profile point turns around the axis line (through origin, along axis) at its own distance from it, so the profile can be drawn in any plane that holds the axis: the XY plane (x = radius) for the default Y axis, the XY plane (y = radius) for axis [1, 0, 0]. angle is measured from where the profile is drawn, turning counter-clockwise when the axis points at the viewer. Closed results face outward.',
  aliases: ['lathe'],
  inputs: [{ name: 'profile', desc: 'curves in a plane holding the axis (default: the XY plane, x = distance from the Y axis)' }],
  params: {
    axis: { type: 'vec3', default: [0, 1, 0], desc: 'direction of the axis to turn around', aliases: ['direction', 'dir'] },
    origin: { type: 'vec3', default: [0, 0, 0], desc: 'a point on the axis', aliases: ['center', 'pivot'] },
    segments: { type: 'int', default: 32, min: 3, max: 4096, desc: 'segments around', aliases: ['divisions', 'cols'] },
    angle: { type: 'vec2', default: [0, 360], desc: 'start/end angle in degrees' },
    caps: { type: 'bool', default: false, desc: 'cap partial revolves (closed profiles)' },
    flip: { type: 'bool', default: false, desc: 'reverse face orientation' },
  },
  outputs: 'vertex uv',
  example: {
    nodes: {
      profile: { type: 'curve', params: { points: [[0, 0, 0], [0.4, 0, 0], [0.25, 0.6, 0], [0.45, 1.2, 0], [0, 1.2, 0]], smooth: true } },
      vase: { type: 'revolve', in: ['profile'], params: { segments: 48 } },
    },
    output: 'vase',
  },
  cook: ({ input, p }) => {
    const g = input(0);
    const span = p.angle[1] - p.angle[0], full = Math.abs(span) >= 360 - 1e-9;
    const n = p.segments, cols = full ? n : n + 1;
    const al = Math.hypot(p.axis[0], p.axis[1], p.axis[2]);
    if (!(al > 0)) throw new NodeError('axis must not be zero', 'e.g. [0, 1, 0] for the Y axis');
    // a frame with the axis as its Y: points go into it, turn around Y, and come back
    const R = toYAxis([p.axis[0] / al, p.axis[1] / al, p.axis[2] / al]), o = p.origin;
    const local = (i: number): Vec3 => {
      const x = g.P[i * 3] - o[0], y = g.P[i * 3 + 1] - o[1], z = g.P[i * 3 + 2] - o[2];
      return [R[0] * x + R[1] * y + R[2] * z, R[3] * x + R[4] * y + R[5] * z, R[6] * x + R[7] * y + R[8] * z];
    };
    const world = (x: number, y: number, z: number): Vec3 =>
      [o[0] + R[0] * x + R[3] * y + R[6] * z, o[1] + R[1] * x + R[4] * y + R[7] * z, o[2] + R[2] * x + R[5] * y + R[8] * z];
    const b = new GeoBuilder(g);
    const uv = b.attrib('vertex', 'uv', 3);
    for (let pr = 0; pr < g.numPrims; pr++) {
      const idx = g.primPoints(pr), closed = !!g.primClosed[pr];
      const grid: number[][] = [];
      for (const i of idx) {
        const [x, y, z] = local(i);
        const r = Math.hypot(x, z);
        if (r < 1e-9) { const c = b.copyPoint(i); grid.push(new Array(cols).fill(c)); continue; }
        const a0 = Math.atan2(-z, x);
        const row: number[] = [];
        for (let j = 0; j < cols; j++) {
          const a = a0 + ((p.angle[0] + (span * j) / n) * Math.PI) / 180;
          const w = world(r * Math.cos(a), y, -r * Math.sin(a));
          row.push(b.addPoint(w[0], w[1], w[2], i));
        }
        grid.push(row);
      }
      const ni = closed ? idx.length : idx.length - 1;
      for (let i = 0; i < ni; i++) {
        const i1 = (i + 1) % idx.length;
        for (let j = 0; j < n; j++) {
          const j1 = full ? (j + 1) % n : j + 1;
          let q = [grid[i][j], grid[i][j1], grid[i1][j1], grid[i1][j]];
          let t = [[j / n, i / ni], [(j + 1) / n, i / ni], [(j + 1) / n, (i + 1) / ni], [j / n, (i + 1) / ni]];
          if (p.flip) { q = q.reverse(); t = t.reverse(); }
          const keep = q.map((v, k) => k === 0 || v !== q[k - 1]).map((kk, k) => kk && !(k === 3 && q[3] === q[0]));
          const fq = q.filter((_, k) => keep[k]), ft = t.filter((_, k) => keep[k]);
          if (fq.length < 3) continue;
          const vb = b.numVertices;
          b.addPrim(fq, true, pr);
          ft.forEach(([a, c], k) => uv.set(vb + k, [a, c, 0]));
        }
      }
      if (p.caps && !full && closed) {
        b.addPrim(grid.map((r) => r[0]).reverse(), true, pr);
        b.addPrim(grid.map((r) => r[cols - 1]), true, pr);
      }
    }
    let out = b.build();
    if (topologyReport(out).closed) out = orientOutward(out);
    return out;
  },
});

/** Row-major rotation taking unit vector a onto +Y (Rodrigues; a half turn about X when a points down). */
function toYAxis(a: Vec3): number[] {
  const c = a[1];
  if (c < -1 + 1e-12) return [1, 0, 0, 0, -1, 0, 0, 0, -1];
  // v = a × Y, R = I + [v]x + [v]x² / (1 + c)
  const vx = -a[2], vy = 0, vz = a[0], k = 1 / (1 + c);
  return [
    1 - (vy * vy + vz * vz) * k, -vz + vx * vy * k, vy + vx * vz * k,
    vz + vx * vy * k, 1 - (vx * vx + vz * vz) * k, -vx + vy * vz * k,
    -vy + vx * vz * k, vx + vy * vz * k, 1 - (vx * vx + vy * vy) * k,
  ];
}

function pointInPoly(pt: number[], poly: number[][]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function area2(poly: number[][]) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return a / 2;
}

defineNode({
  type: 'extrude',
  category: 'curve',
  summary: 'Extrude flat closed shapes into solids (holes supported). Quad sides + n-gon caps; groups top/bottom/side.',
  aliases: ['linear_extrude', 'extrude2d'],
  inputs: [{ name: 'shapes', desc: 'closed polygons lying in a plane (e.g. shape2d, circle, text)' }],
  params: {
    height: { type: 'float', default: 1, desc: 'extrusion distance along the plane normal', aliases: ['depth', 'distance', 'h'] },
    divisions: { type: 'int', default: 1, min: 1, max: 10000, desc: 'segments along the extrusion' },
    twist: { type: 'float', default: 0, desc: 'twist in degrees (about each shape centroid)' },
    scale_top: { type: 'vec2', default: [1, 1], desc: 'scale of the top cap (taper); [0,0] = pyramid' },
    center: { type: 'bool', default: false, desc: 'extrude symmetrically about the shape plane' },
    plane: { type: 'enum', options: ['auto', 'xz', 'xy', 'yz'], default: 'auto', desc: 'shape plane (auto = flattest axis)' },
    caps: { type: 'bool', default: true, desc: 'add top/bottom caps' },
  },
  outputs: 'prim groups top, bottom, side',
  example: {
    nodes: {
      star: { type: 'shape2d', params: { shape: 'star', radius: 1, inner_radius: 0.5, sides: 5 } },
      solid: { type: 'extrude', in: ['star'], params: { height: 0.3, scale_top: [0.8, 0.8] } },
    },
    output: 'solid',
  },
  cook: ({ input, p }) => {
    const g = input(0);
    if (!g.numPrims) throw new NodeError('extrude needs closed shapes (polygons) as input');
    const plane: Plane = p.plane === 'auto' ? detectPlane(g) : p.plane;
    const { polys: raw, offset } = toPolygons(g, plane);
    const F = FRAMES[plane];
    const pyramid = p.scale_top[0] === 0 && p.scale_top[1] === 0;
    if (pyramid) {
      // tapering to a point: manifold's extrude makes the apex; groups by face direction
      const cs = crossSection(raw, 'EvenOdd');
      let m = cs.extrude(Math.abs(p.height), p.divisions - 1, p.twist, p.scale_top, p.center);
      cs.delete();
      if (p.height < 0) { const mm = m.mirror([0, 0, 1]); m.delete(); m = mm; }
      const mt = m.transform(planeMatrix(plane, offset));
      m.delete();
      const tri = fromManifold(mt, propLayout([])).geo;
      mt.delete();
      const nrm = primNormals(tri), down = Math.sign(p.height || 1);
      const bottom = Uint8Array.from({ length: tri.numPrims }, (_, t) => ((nrm[t * 3] * F.N[0] + nrm[t * 3 + 1] * F.N[1] + nrm[t * 3 + 2] * F.N[2]) * down < -0.9999 ? 1 : 0));
      const out = mergeTriangles(tri, Float64Array.from(bottom));
      const bm = new Uint8Array(out.numPrims), on = primNormals(out);
      for (let t = 0; t < out.numPrims; t++) bm[t] = (on[t * 3] * F.N[0] + on[t * 3 + 1] * F.N[1] + on[t * 3 + 2] * F.N[2]) * down < -0.9999 ? 1 : 0;
      out.addGroup('prim', 'bottom', bm);
      out.addGroup('prim', 'top', new Uint8Array(out.numPrims));
      out.addGroup('prim', 'side', bm.map((x) => 1 - x));
      return out;
    }
    // shapes inside shapes are holes (and shapes inside holes islands): outlines counter-clockwise, holes clockwise
    const { polys, depth, parent } = orientNested(raw);
    const root = polys.map((_, i) => { let r = i; while (parent[r] >= 0) r = parent[r]; return r; });
    const centre = polys.map((poly) => [poly.reduce((s, q) => s + q[0], 0) / poly.length, poly.reduce((s, q) => s + q[1], 0) / poly.length]);
    const b = new GeoBuilder();
    const top = b.group('prim', 'top'), bottom = b.group('prim', 'bottom'), side = b.group('prim', 'side');
    const h0 = p.center ? -p.height / 2 : 0;
    const rings = polys.map((poly, i) => {
      // twist and taper about the outermost outline's centre, so holes stay where they are in their shape
      const [cx, cy] = centre[root[i]];
      const out: number[][] = [];
      for (let k = 0; k <= p.divisions; k++) {
        const t = k / p.divisions, w = offset + h0 + p.height * t;
        const a = ((p.twist * t) * Math.PI) / 180, c = Math.cos(a), sn = Math.sin(a);
        const sx = 1 + (p.scale_top[0] - 1) * t, sy = 1 + (p.scale_top[1] - 1) * t;
        out.push(poly.map(([u, v]) => {
          const du = (u - cx) * sx, dv = (v - cy) * sy;
          const uu = cx + du * c - dv * sn, vv = cy + du * sn + dv * c;
          return b.addPoint(F.U[0] * uu + F.V[0] * vv + F.N[0] * w, F.U[1] * uu + F.V[1] * vv + F.N[1] * w, F.U[2] * uu + F.V[2] * vv + F.N[2] * w);
        }));
      }
      return out;
    });
    polys.forEach((poly, i) => {
      const m = poly.length, r = rings[i];
      for (let k = 0; k < p.divisions; k++)
        for (let j = 0; j < m; j++) side.add(b.addPrim([r[k][j], r[k][(j + 1) % m], r[k + 1][(j + 1) % m], r[k + 1][j]]));
    });
    if (p.caps) {
      // each outline with its own holes is one cap, triangulated on the ring points (so it stays watertight) and
      // merged back into as few polygons as a cap with holes needs
      const capTris: number[][] = [], capOf: number[] = [];
      polys.forEach((poly, i) => {
        if (depth[i] % 2) return;
        const holes = polys.map((_, j) => j).filter((j) => parent[j] === i);
        if (!holes.length) {
          bottom.add(b.addPrim(rings[i][0].slice().reverse()));
          top.add(b.addPrim(rings[i][p.divisions].slice()));
          return;
        }
        const flat: number[] = [], holeAt: number[] = [], ids: number[] = [];
        for (const j of [i, ...holes]) {
          if (j !== i) holeAt.push(flat.length / 2);
          polys[j].forEach((q, k) => { flat.push(q[0], q[1]); ids.push(k); });
        }
        const owner = [i, ...holes].flatMap((j) => polys[j].map(() => j));
        const tri = earcut(flat, holeAt.length ? holeAt : undefined);
        for (let t = 0; t < tri.length; t += 3) {
          capTris.push([tri[t], tri[t + 1], tri[t + 2]].map((x) => owner[x] * 1e9 + ids[x]));
          capOf.push(i);
        }
      });
      const capGeo = (level: number, flip: boolean) => {
        const cb = new GeoBuilder();
        const map = new Map<number, number>();
        const pt = (code: number) => {
          let id = map.get(code);
          if (id === undefined) {
            const j = Math.floor(code / 1e9), k = code - j * 1e9, src = rings[j][level][k];
            id = cb.addPoint(b.pos[src * 3], b.pos[src * 3 + 1], b.pos[src * 3 + 2]);
            map.set(code, id);
          }
          return id;
        };
        // earcut's triangles run one way round in plane coordinates: counter-clockwise faces +N
        for (const t of capTris) {
          const [x, y, z] = t.map(pt);
          const ccw = signed2(t.map((c) => { const j = Math.floor(c / 1e9); return polys[j][c - j * 1e9]; })) > 0;
          cb.addPrim(ccw !== flip ? [x, y, z] : [x, z, y]);
        }
        const tg = cb.build();
        const merged = mergeTriangles(tg, Float64Array.from(capOf));
        // back to the ring points
        const back = new Map<number, number>();
        for (const [code, id] of map) { const j = Math.floor(code / 1e9); back.set(id, rings[j][level][code - j * 1e9]); }
        return { merged, back };
      };
      for (const [level, grp, flip] of [[0, bottom, true], [p.divisions, top, false]] as const) {
        const { merged, back } = capGeo(level, flip);
        for (let pr = 0; pr < merged.numPrims; pr++) grp.add(b.addPrim(merged.primPoints(pr).map((i) => back.get(i)!)));
      }
    }
    let out = b.build();
    if (p.height < 0) out = orientOutward(out);
    return out;
  },
});

/** Twice the signed area of a 2D triangle (> 0 counter-clockwise). */
function signed2(t: number[][]) {
  return (t[1][0] - t[0][0]) * (t[2][1] - t[0][1]) - (t[2][0] - t[0][0]) * (t[1][1] - t[0][1]);
}

const NO_SHAPES = 'no closed shapes in the input (polygons, or polylines whose ends meet, with 3+ points): output is empty';

defineNode({
  type: 'offset_curve',
  category: 'curve',
  summary: '2D offset (grow/shrink) of closed shapes, like PolyExpand2D. Negative distance = inset. Open paths become straps.',
  description: 'Closed shapes grow by distance (shrink when negative). An open path (a polyline whose ends do not meet) becomes a strap: a closed outline at |distance| on both sides, with its ends cut square at the end points (cap butt), rounded, or extended by the distance; extrude it for a 3D strap or band. Shapes and straps in one input are joined.',
  aliases: ['polyexpand2d', 'offset2d', 'inset2d', 'strap', 'stroke'],
  inputs: [{ name: 'shapes', desc: 'closed polygons in a plane, or open paths for straps' }],
  params: {
    distance: { type: 'float', default: 0.1, desc: 'offset distance (negative shrinks); straps: half their width', aliases: ['offset', 'dist'] },
    join: { type: 'enum', options: ['round', 'miter', 'square'], default: 'round', desc: 'corner style' },
    cap: { type: 'enum', options: ['butt', 'round', 'square'], default: 'butt', desc: 'strap ends: butt = cut square at the end point, round = half circle, square = extended by the distance' },
    segments: { type: 'int', default: 16, min: 3, max: 10000, desc: 'segments per full circle for round joins and caps' },
    output: { type: 'enum', options: ['outlines', 'faces'], default: 'outlines', desc: 'outlines = closed polygons per contour; faces = filled with holes cut' },
    plane: { type: 'enum', options: ['auto', 'xz', 'xy', 'yz'], default: 'auto', desc: 'shape plane' },
  },
  example: {
    nodes: {
      plan: { type: 'shape2d', params: { shape: 'L', size: [4, 3], thickness: 1.2 } },
      inner: { type: 'offset_curve', in: ['plan'], params: { distance: -0.2, join: 'miter' } },
    },
    output: 'inner',
  },
  cook: ({ input, p, warn }) => {
    const g = input(0);
    const plane: Plane = p.plane === 'auto' ? detectPlane(g) : p.plane;
    // open paths (ends apart) are straps; the rest are shapes
    const isOpen = (pr: number) => {
      if (g.primClosed[pr]) return false;
      const ids = g.primPoints(pr);
      if (ids.length < 2) return false;
      const a = ids[0] * 3, b = ids[ids.length - 1] * 3;
      return Math.hypot(g.P[a] - g.P[b], g.P[a + 1] - g.P[b + 1], g.P[a + 2] - g.P[b + 2]) > 1e-9;
    };
    const open = Uint8Array.from({ length: g.numPrims }, (_, pr) => (isOpen(pr) ? 1 : 0));
    const anyOpen = open.some((x) => x);
    const shapes = anyOpen ? g.subsetPrims(open.map((x) => 1 - x), false) : g;
    const { polys, offset } = toPolygons(shapes, plane);
    const jt = p.join === 'round' ? 'Round' : p.join === 'miter' ? 'Miter' : 'Square';
    const cs = crossSection(polys, 'EvenOdd');
    let o = cs.offset(p.distance, jt, 2, p.segments);
    cs.delete();
    let nStraps = 0, planeOffset = offset;
    if (anyOpen) {
      const lines = g.subsetPrims(open, false);
      const w = Math.abs(p.distance);
      if (!polys.length) planeOffset = toPolygons(lines, plane).offset;
      if (w > 0) for (const path of toPaths(lines, plane)) {
        const st = strap(path, w, p.join, p.cap, p.segments);
        const u = o.add(st);
        o.delete(); st.delete(); o = u;
        nStraps++;
      }
      else warn('distance is 0: open paths give no strap');
    }
    if (!polys.length && !nStraps && g.numPoints) warn(NO_SHAPES);
    const out = p.output === 'faces' ? crossSectionFaces(o, plane, planeOffset) : polygonsToGeo(o.toPolygons(), plane, planeOffset);
    o.delete();
    return out;
  },
});

/** Open polylines as 2D point lists in the plane frame. */
function toPaths(g: Geometry, plane: Plane): [number, number][][] {
  const F = FRAMES[plane], P = g.P, out: [number, number][][] = [];
  for (let pr = 0; pr < g.numPrims; pr++) {
    const path: [number, number][] = [];
    for (const i of g.primPoints(pr)) {
      const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
      const q: [number, number] = [x * F.U[0] + y * F.U[1] + z * F.U[2], x * F.V[0] + y * F.V[1] + z * F.V[2]];
      const last = path[path.length - 1];
      if (!last || Math.hypot(q[0] - last[0], q[1] - last[1]) > 1e-12) path.push(q);
    }
    if (path.length >= 2) out.push(path);
  }
  return out;
}

/**
 * The outline of a strap of half-width w along an open 2D path, as a CrossSection: a rectangle per segment joined at
 * the corners (round: a disc; miter: the wedge to the mitre point, cut back to a bevel when it would reach past 2·w;
 * square: the wedge cut flat) and capped at the ends.
 */
function strap(path: [number, number][], w: number, join: string, cap: string, segments: number): any {
  const n = path.length;
  const dir = (i: number) => { const a = path[i], b = path[i + 1], l = Math.hypot(b[0] - a[0], b[1] - a[1]); return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; };
  const parts: [number, number][][] = [];
  const disc = (c: [number, number]) => Array.from({ length: segments }, (_, k): [number, number] => { const a = (2 * Math.PI * k) / segments; return [c[0] + w * Math.cos(a), c[1] + w * Math.sin(a)]; });
  for (let i = 0; i < n - 1; i++) {
    const [dx, dy] = dir(i), nx = -dy * w, ny = dx * w;
    let a = path[i], b = path[i + 1];
    if (cap === 'square' && i === 0) a = [a[0] - dx * w, a[1] - dy * w];
    if (cap === 'square' && i === n - 2) b = [b[0] + dx * w, b[1] + dy * w];
    parts.push([[a[0] + nx, a[1] + ny], [a[0] - nx, a[1] - ny], [b[0] - nx, b[1] - ny], [b[0] + nx, b[1] + ny]]);
  }
  for (let i = 1; i < n - 1; i++) {
    const c = path[i], d0 = dir(i - 1), d1 = dir(i);
    const turn = d0[0] * d1[1] - d0[1] * d1[0];
    if (Math.abs(turn) < 1e-12 && d0[0] * d1[0] + d0[1] * d1[1] > 0) continue;
    if (join === 'round') { parts.push(disc(c)); continue; }
    // the outer side of the corner: the gap between the two rectangles
    const s = turn > 0 ? -1 : 1;
    const o0: [number, number] = [c[0] - d0[1] * w * s, c[1] + d0[0] * w * s], o1: [number, number] = [c[0] - d1[1] * w * s, c[1] + d1[0] * w * s];
    const bis = [o0[0] + o1[0] - 2 * c[0], o0[1] + o1[1] - 2 * c[1]], bl = Math.hypot(bis[0], bis[1]);
    const cosHalf = bl / (2 * w);
    const miter = cosHalf > 1e-9 ? w / cosHalf : Infinity;
    if (join === 'miter' && miter <= 2 * w) parts.push([c, o0, [c[0] + (bis[0] / bl) * miter, c[1] + (bis[1] / bl) * miter], o1]);
    else parts.push([c, o0, o1]);
  }
  if (cap === 'round') { parts.push(disc(path[0])); parts.push(disc(path[n - 1])); }
  // every part counter-clockwise, then one union
  const ccw = parts.map((q) => { let a = 0; for (let i = 0; i < q.length; i++) { const u = q[i], v = q[(i + 1) % q.length]; a += u[0] * v[1] - v[0] * u[1]; } return a < 0 ? q.slice().reverse() : q; });
  return crossSection(ccw, 'Positive');
}

defineNode({
  type: 'boolean2d',
  category: 'curve',
  summary: '2D boolean of closed shapes in a plane (union / subtract / intersect / xor).',
  description: 'Within each input, a shape lying wholly inside another is a hole in it (a merged plate and circle make a plate with a hole), a shape inside that hole an island, and shapes that only overlap are joined. Faces with holes come out as a few polygons that share edges.',
  aliases: ['curve_boolean', 'shape_boolean'],
  inputs: [{ name: 'a', desc: 'shapes A' }, { name: 'b', desc: 'shapes B (optional: union of A with itself)', optional: true }],
  params: {
    operation: { type: 'enum', options: ['union', 'subtract', 'intersect', 'xor'], default: 'union', desc: 'boolean op', aliases: ['op', 'mode'] },
    output: { type: 'enum', options: ['outlines', 'faces'], default: 'faces', desc: 'faces = filled, holes cut (a face with holes as a few polygons sharing edges); outlines = closed contour polygons' },
    plane: { type: 'enum', options: ['auto', 'xz', 'xy', 'yz'], default: 'auto', desc: 'shape plane' },
  },
  example: {
    nodes: {
      plate: { type: 'shape2d', params: { shape: 'rounded_rect', size: [3, 1.5], corner_radius: 0.2 } },
      hole: { type: 'circle', params: { radius: 0.4, segments: 32 } },
      cut: { type: 'boolean2d', in: ['plate', 'hole'], params: { operation: 'subtract' } },
    },
    output: 'cut',
  },
  cook: ({ input, hasInput, p, warn }) => {
    const A = input(0), B = hasInput(1) ? input(1) : null;
    const plane: Plane = p.plane === 'auto' ? detectPlane(B ? Geometry.merge([A, B]) : A) : p.plane;
    const ta = toPolygons(A, plane), tb = B ? toPolygons(B, plane) : null;
    if (!ta.polys.length && !tb?.polys.length && (A.numPoints || B?.numPoints)) warn(NO_SHAPES);
    const offset = ta.polys.length || !tb ? ta.offset : tb.offset;
    // within each input a shape inside another is a hole, shapes that overlap union (orientNested)
    const csA = crossSection(orientNested(ta.polys).polys, 'NonZero');
    let r;
    if (!tb) r = csA;
    else {
      const csB = crossSection(orientNested(tb.polys).polys, 'NonZero');
      r = p.operation === 'union' ? csA.add(csB) : p.operation === 'subtract' ? csA.subtract(csB) : p.operation === 'intersect' ? csA.intersect(csB) : csA.add(csB).subtract(csA.intersect(csB));
      csB.delete();
    }
    const out = p.output === 'faces' ? crossSectionFaces(r, plane, offset) : polygonsToGeo(r.toPolygons(), plane, offset);
    r.delete();
    if (r !== csA) csA.delete();
    return out;
  },
});

defineNode({
  type: 'fill',
  category: 'curve',
  summary: 'Fill closed outlines into faces, cutting holes (even-odd), e.g. text outlines or nested shapes.',
  aliases: ['fill_curves', 'fill_outlines'],
  inputs: [{ name: 'outlines', desc: 'closed polygons/polylines in a plane' }],
  params: {
    rule: { type: 'enum', options: ['EvenOdd', 'NonZero'], default: 'EvenOdd', desc: 'fill rule for overlapping contours' },
    plane: { type: 'enum', options: ['auto', 'xz', 'xy', 'yz'], default: 'auto', desc: 'plane' },
  },
  example: { nodes: { glyph: { type: 'text', params: { text: 'B', output: 'outlines' } }, face: { type: 'fill', in: ['glyph'] } }, output: 'face' },
  cook: ({ input, p, warn }) => {
    const g = input(0);
    const plane: Plane = p.plane === 'auto' ? detectPlane(g) : p.plane;
    const { polys, offset } = toPolygons(g, plane);
    if (!polys.length && g.numPoints) warn(NO_SHAPES);
    const cs = crossSection(polys, p.rule);
    const out = crossSectionFaces(cs, plane, offset);
    cs.delete();
    return out;
  },
});

defineNode({
  type: 'loft',
  category: 'curve',
  summary: 'Skin a surface through a sequence of curves (in prim order), or through copies of one profile placed by "sections".',
  description: 'Sections: with several input curves, each is a section in prim order. With one curve and the sections list, each entry places a copy of it: {"offset": [x, y, z], "scale": [sx, sy], "rotate": [rx, ry, rz]} (any key may be left out; a number for offset moves it along the curve\'s normal, a number for scale scales it evenly), applied as scale and rotate about the curve\'s centre, then the offset. Correspondence: when every section has the same number of points, point k of one section joins point k of the next (insets and rounded corners stay where they are); otherwise each section is resampled evenly by length (resample "length"). Closed sections are turned to run the same way round as the first one, and each starts at the point nearest the previous section\'s start, so the skin does not twist. Winding: the side faces follow the first section\'s direction; a closed result (closed sections with caps, or closed: true) is turned to face outward, caps included. uv: u along the section, v across the sections.',
  aliases: ['skin'],
  inputs: [{ name: 'curves', desc: 'two or more curves, in order; or one profile with sections' }],
  params: {
    sections: { type: 'json', default: [], desc: 'one input curve: a list of placements, each {offset, scale, rotate} (see the description)', aliases: ['stations', 'placements'] },
    resample: { type: 'enum', options: ['auto', 'length', 'none'], default: 'auto', desc: 'auto = keep the points when every section has the same count, else even by length; length = always resample evenly; none = points by index (counts must match)' },
    closed: { type: 'bool', default: false, desc: 'connect the last curve back to the first' },
    caps: { type: 'bool', default: false, desc: 'cap the first and last curves (when they are closed)' },
  },
  outputs: 'vertex uv; prim groups caps, sides',
  example: {
    nodes: {
      a: { type: 'circle', params: { radius: 1, segments: 32 } },
      b: { type: 'circle', params: { radius: 0.5, segments: 32, center: [0, 1, 0] } },
      c: { type: 'circle', params: { radius: 0.8, segments: 32, center: [0, 2, 0] } },
      rings: { type: 'merge', in: ['a', 'b', 'c'] },
      skin: { type: 'loft', in: ['rings'], params: { caps: true } },
    },
    output: 'skin',
  },
  cook: ({ input, p }) => {
    const g = evaluateSplines(input(0));
    let curves = Array.from({ length: g.numPrims }, (_, pr) => ({ pts: curvePoints(g, pr), closed: !!g.primClosed[pr] }))
      .filter((c) => c.pts.length >= 2);
    if (Array.isArray(p.sections) && p.sections.length) {
      if (curves.length !== 1) throw new NodeError(`sections places copies of one profile, but the input has ${curves.length} curves`, 'merge nothing into the profile, or leave sections empty to loft through the input curves');
      curves = p.sections.map((sec: any, i: number) => placeSection(curves[0], sec, i));
    }
    if (curves.length < 2) throw new NodeError('loft needs at least 2 curves', 'merge two or more curves in order, or give one profile and a sections list');
    // every open polyline whose ends meet is a loop
    for (const c of curves) if (!c.closed && c.pts.length > 3 && dist3(c.pts[0], c.pts[c.pts.length - 1]) < 1e-9) { c.pts.pop(); c.closed = true; }
    const closedU = curves[0].closed;
    if (curves.some((c) => c.closed !== closedU)) throw new NodeError('loft sections must be all closed or all open', 'close them with ends {mode: close}, or open them');
    const same = curves.every((c) => c.pts.length === curves[0].pts.length);
    if (p.resample === 'none' && !same) throw new NodeError(`resample "none" needs every section with the same number of points (${curves.map((c) => c.pts.length).join(', ')})`, 'use resample "auto" or "length"');
    const n = Math.max(...curves.map((c) => c.pts.length));
    let rows: number[][][] = p.resample === 'length' || !same
      ? curves.map((c) => evenByLength(c.pts, c.closed, n))
      : curves.map((c) => c.pts.map((q) => q.slice()));
    if (closedU) {
      // same way round as the first section, each starting where the previous one starts
      const n0 = loopNormal(rows[0]);
      for (let r = 1; r < rows.length; r++) {
        if (dot(loopNormal(rows[r]), n0) < 0) rows[r] = [rows[r][0], ...rows[r].slice(1).reverse()];
        const prev = rows[r - 1][0];
        let best = 0, bd = Infinity;
        rows[r].forEach((q, k) => { const d = dist3(q, prev); if (d < bd) { bd = d; best = k; } });
        if (best) rows[r] = [...rows[r].slice(best), ...rows[r].slice(0, best)];
      }
    }
    const b = new GeoBuilder();
    const uv = b.attrib('vertex', 'uv', 3);
    const sides = b.group('prim', 'sides'), capsG = b.group('prim', 'caps');
    const ids = rows.map((row) => row.map((q) => b.addPoint(q[0], q[1], q[2])));
    const nr = ids.length, m = rows[0].length, nRows = p.closed ? nr : nr - 1, cols = closedU ? m : m - 1;
    for (let r = 0; r < nRows; r++)
      for (let c = 0; c < cols; c++) {
        const r1 = (r + 1) % nr, c1 = (c + 1) % m;
        const vb = b.numVertices;
        sides.add(b.addPrim([ids[r][c], ids[r][c1], ids[r1][c1], ids[r1][c]]));
        [[c / cols, r / nRows], [(c + 1) / cols, r / nRows], [(c + 1) / cols, (r + 1) / nRows], [c / cols, (r + 1) / nRows]].forEach(([a, d], k) => uv.set(vb + k, [a, d, 0]));
      }
    if (p.caps && closedU && !p.closed) {
      capsG.add(b.addPrim(ids[0].slice().reverse()));
      capsG.add(b.addPrim(ids[nr - 1].slice()));
    }
    let out = b.build();
    if (topologyReport(out).closed) out = orientOutward(out);
    return out;
  },
});

function dist3(a: number[], b: number[]) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }

/** Newell normal of a closed loop of points. */
function loopNormal(pts: number[][]): Vec3 {
  const n: Vec3 = [0, 0, 0];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], c = pts[(i + 1) % pts.length];
    n[0] += (a[1] - c[1]) * (a[2] + c[2]); n[1] += (a[2] - c[2]) * (a[0] + c[0]); n[2] += (a[0] - c[0]) * (a[1] + c[1]);
  }
  return n;
}

/** n points spread evenly by length along a curve (a closed one starts and ends at its first point). */
function evenByLength(pts0: number[][], closed: boolean, n: number): number[][] {
  const pts = closed ? [...pts0, pts0[0]] : pts0;
  const L = arcLengths(pts, false), T = L[L.length - 1] || 1;
  const out: number[][] = [];
  for (let i = 0; i < n; i++) {
    const s = (T * i) / (closed ? n : n - 1);
    let k = 0;
    while (k < L.length - 2 && L[k + 1] < s) k++;
    const f = L[k + 1] > L[k] ? (s - L[k]) / (L[k + 1] - L[k]) : 0;
    out.push(pts[k].map((v, ci) => v + (pts[k + 1][ci] - v) * f));
  }
  return out;
}

/** A copy of the profile placed by one sections entry: scale and rotate about its centre, then offset. */
function placeSection(prof: { pts: number[][]; closed: boolean }, sec: any, i: number): { pts: number[][]; closed: boolean } {
  if (!sec || typeof sec !== 'object' || Array.isArray(sec)) throw new NodeError(`sections[${i}] must be an object like {"offset": [0, 0.1, 0], "scale": [0.8, 0.8]}`);
  const vec = (v: any, k: string, def: number[]) => {
    if (v === undefined) return def;
    const a = typeof v === 'number' ? null : v;
    if (a && !(Array.isArray(a) && a.every((x: any) => typeof x === 'number' && Number.isFinite(x)))) throw new NodeError(`sections[${i}].${k} must be a number or a list of numbers`);
    return a ?? v;
  };
  const c = prof.pts.reduce((s, q) => [s[0] + q[0], s[1] + q[1], s[2] + q[2]], [0, 0, 0]).map((x) => x / prof.pts.length);
  const N = normalize(loopNormal(prof.pts) as Vec3);
  const nrm: Vec3 = length(N) > 0 ? N : [0, 1, 0];
  const off = vec(sec.offset, 'offset', [0, 0, 0]);
  const offset: number[] = typeof off === 'number' ? [nrm[0] * off, nrm[1] * off, nrm[2] * off] : [off[0] ?? 0, off[1] ?? 0, off[2] ?? 0];
  const sc = vec(sec.scale, 'scale', [1, 1]);
  // scale in the profile's own plane: along two axes perpendicular to its normal
  const ax: Vec3 = Math.abs(nrm[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const U = normalize(cross(ax, nrm)), V = cross(nrm, U);
  const sx = typeof sc === 'number' ? sc : sc[0] ?? 1, sy = typeof sc === 'number' ? sc : sc[1] ?? sx;
  const rot = vec(sec.rotate, 'rotate', [0, 0, 0]);
  const R = m4euler(typeof rot === 'number' ? [0, rot, 0] : [rot[0] ?? 0, rot[1] ?? 0, rot[2] ?? 0]);
  const pts = prof.pts.map((q) => {
    const d: Vec3 = [q[0] - c[0], q[1] - c[1], q[2] - c[2]];
    const u = dot(d, U) * sx, v = dot(d, V) * sy, w = dot(d, nrm);
    const e: Vec3 = [U[0] * u + V[0] * v + nrm[0] * w, U[1] * u + V[1] * v + nrm[1] * w, U[2] * u + V[2] * v + nrm[2] * w];
    const r = m4applyDir(R, e[0], e[1], e[2]);
    return [c[0] + r[0] + offset[0], c[1] + r[1] + offset[1], c[2] + r[2] + offset[2]];
  });
  return { pts, closed: prof.closed };
}

