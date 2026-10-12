// Curves: generation (line, circle, curve, spiral, 2D shapes) and operations
// (resample, carve, ends, sweep, polywire, revolve, extrude, offset, 2D booleans, fill, loft).
import { GeoBuilder, Geometry } from '../core/geometry.ts';
import type { Src } from '../core/geometry.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import { add, cross, dot, length, normalize, scale, sub } from '../core/math.ts';
import type { Vec3 } from '../core/math.ts';
import { orientOutward, topologyReport } from '../core/topology.ts';
import { crossSection, crossSectionFaces, detectPlane, fromManifold, planeMatrix, polygonsToGeo, propLayout, toPolygons } from '../core/manifold.ts';
import type { Plane } from '../core/manifold.ts';
import { FRAMES, P, mask } from './util.ts';
import { evalRamp } from '../graph/params.ts';

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
    points: { type: 'int', default: 2, min: 2, desc: 'number of points', aliases: ['count', 'npts'] },
  },
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
    segments: { type: 'int', default: 32, min: 3, desc: 'number of segments', aliases: ['divisions', 'divs', 'points'] },
    plane: P.plane('xz'),
    center: P.center(),
    arc: { type: 'vec2', default: [0, 360], desc: 'begin/end angle in degrees (anything < 360 makes an open arc)' },
    open: { type: 'bool', default: false, desc: 'output an open polyline instead of a closed polygon face' },
  },
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
  summary: 'Curve through explicit points; optional Catmull-Rom smoothing; open or closed.',
  aliases: ['polyline', 'path', 'spline'],
  inputs: [],
  params: {
    points: { type: 'json', default: [[0, 0, 0], [1, 0.5, 0], [2, 0, 0]], desc: 'list of [x,y,z] (2-number entries → [x, 0, z] on the ground)', aliases: ['positions', 'pts'] },
    closed: { type: 'bool', default: false, desc: 'close the curve (makes a polygon)' },
    smooth: { type: 'bool', default: false, desc: 'Catmull-Rom interpolate through the points' },
    subdivisions: { type: 'int', default: 8, min: 1, desc: 'smooth: samples per segment' },
  },
  cook: ({ p }) => {
    if (!Array.isArray(p.points) || p.points.length < 2) throw new NodeError('points must be a list of at least 2 [x,y,z]');
    let pts: number[][] = p.points.map((q: any) => (q.length === 2 ? [+q[0], 0, +q[1]] : [+q[0], +q[1], +q[2]]));
    if (p.smooth && pts.length > 2) pts = catmullRom(pts, p.closed, p.subdivisions).pos;
    return new Geometry({ positions: pts.flat(), prims: [pts.map((_, i) => i)], closed: p.closed });
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
    points_per_turn: { type: 'int', default: 32, min: 3, desc: 'resolution' },
    clockwise: { type: 'bool', default: false, desc: 'turn direction when seen from above' },
    center: P.center(),
  },
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
  summary: 'Flat 2D shapes as closed polygons: rect, rounded_rect, ngon, star, gear, cross, L, U.',
  aliases: ['rect', 'rectangle', 'ngon', 'star', 'polygon2d'],
  inputs: [],
  params: {
    shape: { type: 'enum', options: ['rect', 'rounded_rect', 'ngon', 'star', 'gear', 'cross', 'L', 'U'], default: 'rect', desc: 'shape type' },
    size: { type: 'vec2', default: [1, 1], desc: 'rect/rounded_rect/cross/L/U: width and depth' },
    radius: { type: 'float', default: 0.5, desc: 'ngon/star/gear: outer radius' },
    inner_radius: { type: 'float', default: 0.25, desc: 'star/gear: inner radius' },
    sides: { type: 'int', default: 6, min: 3, desc: 'ngon sides / star points / gear teeth', aliases: ['points', 'teeth'] },
    corner_radius: { type: 'float', default: 0.1, min: 0, desc: 'rounded_rect corner radius' },
    corner_segments: { type: 'int', default: 6, min: 1, desc: 'rounded_rect segments per corner' },
    thickness: { type: 'float', default: 0.25, desc: 'cross/L/U arm thickness' },
    rotate: { type: 'float', default: 0, desc: 'rotation in degrees within the plane' },
    plane: P.plane('xz'),
    center: P.center(),
  },
  cook: ({ p }) => {
    const [w, d] = p.size;
    let pts2: number[][] = [];
    const hw = w / 2, hd = d / 2, t = p.thickness;
    switch (p.shape) {
      case 'rect': pts2 = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]]; break;
      case 'rounded_rect': {
        const r = Math.min(p.corner_radius, hw, hd), s = p.corner_segments;
        const cs = [[hw - r, -hd + r, -90], [hw - r, hd - r, 0], [-hw + r, hd - r, 90], [-hw + r, -hd + r, 180]];
        for (const [cx, cy, a0] of cs) for (let k = 0; k <= s; k++) {
          const a = ((a0 + (90 * k) / s) * Math.PI) / 180;
          pts2.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
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
  inputs: [{ name: 'curves', desc: 'polylines or polygons' }],
  params: {
    mode: { type: 'enum', options: ['length', 'count'], default: 'length', desc: 'segment length or a fixed segment count per curve' },
    length: { type: 'float', default: 0.1, min: 1e-6, desc: 'target segment length', aliases: ['seglen', 'segment_length'] },
    count: { type: 'int', default: 20, min: 1, desc: 'segments per curve (mode=count)', aliases: ['segments'] },
    smooth: { type: 'bool', default: false, desc: 'Catmull-Rom smooth before resampling' },
    group: P.group('prim'),
    tangent: { type: 'bool', default: false, desc: 'also write point tangentu (unit tangent)' },
  },
  outputs: 'point curveu (0..1 along each curve), optional tangentu',
  cook: ({ input, p }) => {
    const g = input(0);
    const sel = mask(g, 'prim', p.group);
    const b = new GeoBuilder(g);
    const cu = b.attrib('point', 'curveu', 1);
    const tg = p.tangent ? b.attrib('point', 'tangentu', 3) : null;
    for (let pr = 0; pr < g.numPrims; pr++) {
      const ptsIdx = g.primPoints(pr);
      const closed = !!g.primClosed[pr];
      if ((sel && !sel[pr]) || ptsIdx.length < 2) {
        b.addPrim(ptsIdx.map((i) => b.copyPoint(i)), closed, pr);
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
    return b.build();
  },
});

defineNode({
  type: 'carve',
  category: 'curve',
  summary: 'Trim curves to a portion of their length (u range 0..1).',
  inputs: [{ name: 'curves', desc: 'polylines' }],
  params: {
    start: { type: 'float', default: 0, min: 0, max: 1, desc: 'start u (0..1 of arc length)' },
    end: { type: 'float', default: 0.5, min: 0, max: 1, desc: 'end u' },
  },
  cook: ({ input, p }) => {
    const g = input(0);
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
  aliases: ['convert_curve', 'unroll'],
  inputs: [{ name: 'geo', desc: 'polygons or polylines' }],
  params: {
    mode: { type: 'enum', options: ['unroll', 'close', 'open'], default: 'unroll', desc: 'unroll: polygon → polyline outline (ends meet); close: polyline → polygon; open: polygon → polyline (drops closing edge)' },
    group: P.group('prim'),
  },
  cook: ({ input, p }) => {
    const g = input(0);
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
    const rings: number[][] = [];
    for (let k = 0; k < pts.length; k++) {
      const u = L[k] / total;
      let s = psA ? (psA.get(idx[k]) as number) : 1;
      if (o.radiusOf) s *= o.radiusOf(idx[k]);
      if (o.scaleRamp) s *= evalRamp(o.scaleRamp, u) as number;
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
      capG.add(b.addPrim(rings[0].slice().reverse(), true, pr));
      capG.add(b.addPrim(rings[rings.length - 1].slice(), true, pr));
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
  inputs: [
    { name: 'backbone', desc: 'curves to sweep along' },
    { name: 'profile', desc: 'cross-section curve drawn in the XY plane (optional; one per backbone or a single shared one)', optional: true },
  ],
  params: {
    shape: { type: 'enum', options: ['circle', 'square', 'ribbon', 'half_circle'], default: 'circle', desc: 'built-in profile when no profile input' },
    radius: { type: 'float', default: 0.1, desc: 'built-in profile radius / half width', aliases: ['width', 'rad'] },
    divisions: { type: 'int', default: 12, min: 2, desc: 'built-in profile segments', aliases: ['sides', 'cols'] },
    caps: { type: 'bool', default: true, desc: 'cap open ends (closed profiles only)' },
    twist: { type: 'float', default: 0, desc: 'total twist in degrees along each curve' },
    scale_ramp: { type: 'ramp', default: [[0, 1], [1, 1]], desc: 'profile scale along the curve (u 0..1); point pscale also multiplies' },
    up: { type: 'vec3', default: [0, 1, 0], desc: 'initial up vector (point attribute "up" overrides per point)' },
    uv_length: { type: 'bool', default: false, desc: 'v coordinate in world length instead of 0..1' },
  },
  outputs: 'vertex uv; prim groups caps, sides',
  cook: ({ input, hasInput, p }) => {
    const g = input(0);
    let profiles: Profile[];
    if (hasInput(1)) {
      const pg = input(1);
      profiles = [];
      for (let pr = 0; pr < pg.numPrims; pr++) profiles.push({ pts: curvePoints(pg, pr), closed: !!pg.primClosed[pr] });
      if (!profiles.length) throw new NodeError('profile input has no curves');
    } else if (p.shape === 'square') profiles = [{ pts: [[-p.radius, -p.radius, 0], [p.radius, -p.radius, 0], [p.radius, p.radius, 0], [-p.radius, p.radius, 0]], closed: true }];
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
  inputs: [{ name: 'curves', desc: 'polylines (or polygon edges)' }],
  params: {
    radius: { type: 'float', default: 0.05, desc: 'tube radius (used when no width attribute)', aliases: ['rad', 'wire_radius'] },
    divisions: { type: 'int', default: 8, min: 3, desc: 'sides around the tube', aliases: ['sides', 'cols'] },
    caps: { type: 'bool', default: true, desc: 'cap the tube ends' },
    use_width: { type: 'bool', default: true, desc: 'use point "width" attribute (diameter) when present' },
  },
  outputs: 'vertex uv; prim groups caps, sides',
  cook: ({ input, p }) => {
    const g = input(0);
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
  summary: 'Lathe: revolve profile curves (drawn in XY, x = radius) around the Y axis. Profiles touching the axis close up.',
  aliases: ['lathe'],
  inputs: [{ name: 'profile', desc: 'curves in the XY plane (x = distance from the axis)' }],
  params: {
    segments: { type: 'int', default: 32, min: 3, desc: 'segments around', aliases: ['divisions', 'cols'] },
    angle: { type: 'vec2', default: [0, 360], desc: 'start/end angle in degrees' },
    caps: { type: 'bool', default: false, desc: 'cap partial revolves (closed profiles)' },
    flip: { type: 'bool', default: false, desc: 'reverse face orientation' },
  },
  outputs: 'vertex uv',
  cook: ({ input, p }) => {
    const g = input(0);
    const span = p.angle[1] - p.angle[0], full = Math.abs(span) >= 360 - 1e-9;
    const n = p.segments, cols = full ? n : n + 1;
    const b = new GeoBuilder(g);
    const uv = b.attrib('vertex', 'uv', 3);
    for (let pr = 0; pr < g.numPrims; pr++) {
      const idx = g.primPoints(pr), closed = !!g.primClosed[pr];
      const grid: number[][] = [];
      for (const i of idx) {
        const x = g.P[i * 3], y = g.P[i * 3 + 1], z = g.P[i * 3 + 2];
        const r = Math.hypot(x, z);
        if (r < 1e-9) { const c = b.copyPoint(i); grid.push(new Array(cols).fill(c)); continue; }
        const a0 = Math.atan2(-z, x);
        const row: number[] = [];
        for (let j = 0; j < cols; j++) {
          const a = a0 + ((p.angle[0] + (span * j) / n) * Math.PI) / 180;
          row.push(b.addPoint(r * Math.cos(a), y, -r * Math.sin(a), i));
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
    divisions: { type: 'int', default: 1, min: 1, desc: 'segments along the extrusion' },
    twist: { type: 'float', default: 0, desc: 'twist in degrees (about each shape centroid)' },
    scale_top: { type: 'vec2', default: [1, 1], desc: 'scale of the top cap (taper); [0,0] = pyramid' },
    center: { type: 'bool', default: false, desc: 'extrude symmetrically about the shape plane' },
    plane: { type: 'enum', options: ['auto', 'xz', 'xy', 'yz'], default: 'auto', desc: 'shape plane (auto = flattest axis)' },
    caps: { type: 'bool', default: true, desc: 'add top/bottom caps' },
  },
  outputs: 'prim groups top, bottom, side',
  cook: ({ input, p }) => {
    const g = input(0);
    if (!g.numPrims) throw new NodeError('extrude needs closed shapes (polygons) as input');
    const plane: Plane = p.plane === 'auto' ? detectPlane(g) : p.plane;
    const { polys, offset } = toPolygons(g, plane);
    // holes or tapering to a point → use manifold's robust extrude
    let nested = false;
    for (let i = 0; i < polys.length && !nested; i++)
      for (let j = 0; j < polys.length; j++) if (i !== j && pointInPoly(polys[i][0], polys[j])) { nested = true; break; }
    const pyramid = p.scale_top[0] === 0 && p.scale_top[1] === 0;
    if (nested || pyramid) {
      const cs = crossSection(polys, 'EvenOdd');
      let m = cs.extrude(Math.abs(p.height), p.divisions - 1, p.twist, p.scale_top, p.center);
      cs.delete();
      if (p.height < 0) { const mm = m.mirror([0, 0, 1]); m.delete(); m = mm; }
      const mt = m.transform(planeMatrix(plane, offset));
      m.delete();
      const out = fromManifold(mt, propLayout([])).geo;
      mt.delete();
      return out;
    }
    const F = FRAMES[plane];
    const b = new GeoBuilder();
    const top = b.group('prim', 'top'), bottom = b.group('prim', 'bottom'), side = b.group('prim', 'side');
    const h0 = p.center ? -p.height / 2 : 0;
    for (const poly0 of polys) {
      const poly = area2(poly0) < 0 ? poly0.slice().reverse() : poly0;
      const cx = poly.reduce((s, q) => s + q[0], 0) / poly.length, cy = poly.reduce((s, q) => s + q[1], 0) / poly.length;
      const rings: number[][] = [];
      for (let k = 0; k <= p.divisions; k++) {
        const t = k / p.divisions, w = offset + h0 + p.height * t;
        const a = ((p.twist * t) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
        const sx = 1 + (p.scale_top[0] - 1) * t, sy = 1 + (p.scale_top[1] - 1) * t;
        rings.push(poly.map(([u, v]) => {
          const du = (u - cx) * sx, dv = (v - cy) * sy;
          const uu = cx + du * c - dv * s, vv = cy + du * s + dv * c;
          return b.addPoint(F.U[0] * uu + F.V[0] * vv + F.N[0] * w, F.U[1] * uu + F.V[1] * vv + F.N[1] * w, F.U[2] * uu + F.V[2] * vv + F.N[2] * w);
        }));
      }
      const m = poly.length;
      for (let k = 0; k < p.divisions; k++)
        for (let j = 0; j < m; j++) side.add(b.addPrim([rings[k][j], rings[k][(j + 1) % m], rings[k + 1][(j + 1) % m], rings[k + 1][j]]));
      if (p.caps) {
        bottom.add(b.addPrim(rings[0].slice().reverse()));
        top.add(b.addPrim(rings[p.divisions].slice()));
      }
    }
    let out = b.build();
    if (p.height < 0) out = orientOutward(out);
    return out;
  },
});

const NO_SHAPES = 'no closed shapes in the input (polygons, or polylines whose ends meet, with 3+ points): output is empty';

defineNode({
  type: 'offset_curve',
  category: 'curve',
  summary: '2D offset (grow/shrink) of closed shapes, like PolyExpand2D. Negative distance = inset.',
  aliases: ['polyexpand2d', 'offset2d', 'inset2d'],
  inputs: [{ name: 'shapes', desc: 'closed polygons in a plane' }],
  params: {
    distance: { type: 'float', default: 0.1, desc: 'offset distance (negative shrinks)', aliases: ['offset', 'dist'] },
    join: { type: 'enum', options: ['round', 'miter', 'square'], default: 'round', desc: 'corner style' },
    segments: { type: 'int', default: 16, min: 3, desc: 'segments per full circle for round joins' },
    output: { type: 'enum', options: ['outlines', 'faces'], default: 'outlines', desc: 'outlines = closed polygons per contour; faces = filled with holes cut' },
    plane: { type: 'enum', options: ['auto', 'xz', 'xy', 'yz'], default: 'auto', desc: 'shape plane' },
  },
  cook: ({ input, p, warn }) => {
    const g = input(0);
    const plane: Plane = p.plane === 'auto' ? detectPlane(g) : p.plane;
    const { polys, offset } = toPolygons(g, plane);
    if (!polys.length && g.numPoints) warn(NO_SHAPES);
    const cs = crossSection(polys, 'EvenOdd');
    const jt = p.join === 'round' ? 'Round' : p.join === 'miter' ? 'Miter' : 'Square';
    const o = cs.offset(p.distance, jt, 2, p.segments);
    cs.delete();
    const out = p.output === 'faces' ? crossSectionFaces(o, plane, offset) : polygonsToGeo(o.toPolygons(), plane, offset);
    o.delete();
    return out;
  },
});

defineNode({
  type: 'boolean2d',
  category: 'curve',
  summary: '2D boolean of closed shapes in a plane (union / subtract / intersect / xor).',
  aliases: ['curve_boolean', 'shape_boolean'],
  inputs: [{ name: 'a', desc: 'shapes A' }, { name: 'b', desc: 'shapes B (optional: union of A with itself)', optional: true }],
  params: {
    operation: { type: 'enum', options: ['union', 'subtract', 'intersect', 'xor'], default: 'union', desc: 'boolean op', aliases: ['op', 'mode'] },
    output: { type: 'enum', options: ['outlines', 'faces'], default: 'faces', desc: 'faces = filled (holes cut, triangulated where needed); outlines = closed contour polygons' },
    plane: { type: 'enum', options: ['auto', 'xz', 'xy', 'yz'], default: 'auto', desc: 'shape plane' },
  },
  cook: ({ input, hasInput, p, warn }) => {
    const A = input(0), B = hasInput(1) ? input(1) : null;
    const plane: Plane = p.plane === 'auto' ? detectPlane(B ? Geometry.merge([A, B]) : A) : p.plane;
    const ta = toPolygons(A, plane), tb = B ? toPolygons(B, plane) : null;
    if (!ta.polys.length && !tb?.polys.length && (A.numPoints || B?.numPoints)) warn(NO_SHAPES);
    const offset = ta.polys.length || !tb ? ta.offset : tb.offset;
    const csA = crossSection(ta.polys, 'NonZero');
    let r;
    if (!tb) r = csA;
    else {
      const csB = crossSection(tb.polys, 'NonZero');
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
  aliases: ['polyfill', 'fill_curves'],
  inputs: [{ name: 'outlines', desc: 'closed polygons/polylines in a plane' }],
  params: {
    rule: { type: 'enum', options: ['EvenOdd', 'NonZero'], default: 'EvenOdd', desc: 'fill rule for overlapping contours' },
    plane: { type: 'enum', options: ['auto', 'xz', 'xy', 'yz'], default: 'auto', desc: 'plane' },
  },
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
  summary: 'Skin a surface through a sequence of curves (in prim order). Curves are resampled to equal counts.',
  aliases: ['skin'],
  inputs: [{ name: 'curves', desc: 'two or more curves, in order' }],
  params: {
    closed: { type: 'bool', default: false, desc: 'connect the last curve back to the first' },
    caps: { type: 'bool', default: false, desc: 'cap the first and last curves (when they are closed)' },
  },
  outputs: 'vertex uv',
  cook: ({ input, p }) => {
    const g = input(0);
    if (g.numPrims < 2) throw new NodeError('loft needs at least 2 curves');
    const curves = Array.from({ length: g.numPrims }, (_, pr) => ({ pts: curvePoints(g, pr), closed: !!g.primClosed[pr] }));
    const n = Math.max(...curves.map((c) => c.pts.length));
    const closedU = curves[0].closed;
    const sampled = curves.map((c) => {
      const pts = c.closed ? [...c.pts, c.pts[0]] : c.pts;
      const L = arcLengths(pts, false), T = L[L.length - 1] || 1;
      const cnt = closedU ? n : n;
      const out: number[][] = [];
      for (let i = 0; i < cnt; i++) {
        const s = (T * i) / (closedU ? cnt : cnt - 1);
        let k = 0;
        while (k < L.length - 2 && L[k + 1] < s) k++;
        const f = L[k + 1] > L[k] ? (s - L[k]) / (L[k + 1] - L[k]) : 0;
        out.push(pts[k].map((v, ci) => v + (pts[k + 1][ci] - v) * f));
      }
      return out;
    });
    const b = new GeoBuilder();
    const uv = b.attrib('vertex', 'uv', 3);
    const ids = sampled.map((row) => row.map((q) => b.addPoint(q[0], q[1], q[2])));
    const nr = ids.length, rows = p.closed ? nr : nr - 1, cols = closedU ? n : n - 1;
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const r1 = (r + 1) % nr, c1 = (c + 1) % n;
        const vb = b.numVertices;
        b.addPrim([ids[r][c], ids[r][c1], ids[r1][c1], ids[r1][c]]);
        [[c / cols, r / rows], [(c + 1) / cols, r / rows], [(c + 1) / cols, (r + 1) / rows], [c / cols, (r + 1) / rows]].forEach(([a, d], k) => uv.set(vb + k, [a, d, 0]));
      }
    if (p.caps && closedU && !p.closed) {
      b.addPrim(ids[0].slice().reverse());
      b.addPrim(ids[nr - 1].slice());
    }
    let out = b.build();
    if (topologyReport(out).closed) out = orientOutward(out);
    return out;
  },
});
