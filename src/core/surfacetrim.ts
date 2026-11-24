import { symmetricEigen3 } from './analysis.ts';
import { GeoBuilder, Geometry } from './geometry.ts';
import { PLANE_FRAMES, crossSection, detectPlane } from './manifold.ts';
import { add, clamp, cross, dist, dot, lerp3, length, normalize, scale, sub } from './math.ts';
import type { Vec3 } from './math.ts';
import { TRIM_NAMES, closestSurfacePoint, evalSurface, meshParams, sampleTrimSegment, setSurfaceTrims, surfaceFromPrim, surfacePoint, surfaceTrims, trimBoundaryName, trimEdges } from './nurbssurface.ts';
import type { NurbsSurface, SurfaceUV } from './nurbssurface.ts';
import { evalPoint, fitSpline, makeSpline, polylineParams, setSplinePrim, splineFromPrim } from './splines.ts';
import type { FitResult } from './splines.ts';

export interface TrimOptions {
  project: 'axis' | 'closest';
  direction: Vec3;
  hits: 'all' | 'front' | 'back';
  keep: 'outside' | 'inside' | 'both';
  tolerance: number;
  edges: boolean;
  surfaces: Uint8Array | null;
  outlines: Uint8Array | null;
}

type Outline = {
  prim: number;
  name: string;
  at: (t: number) => Vec3;
  breaks: number[];
  direction: Vec3;
  centre: Vec3;
  normal: Vec3;
};

const DOMAIN: SurfaceUV[] = [[0, 0], [1, 0], [1, 1], [0, 1]];
const HIT_EPS = 1e-9;
const UV_EPS = 1e-8;
const clampUV = (s: NurbsSurface, [u, v]: SurfaceUV): SurfaceUV =>
  [s.u.closed ? u - Math.floor(u) : clamp(u, 0, 1), s.v.closed ? v - Math.floor(v) : clamp(v, 0, 1)];
const unwrapUV = (s: NurbsSurface, a: SurfaceUV, b: SurfaceUV): SurfaceUV =>
  [b[0] + (s.u.closed ? Math.round(a[0] - b[0]) : 0), b[1] + (s.v.closed ? Math.round(a[1] - b[1]) : 0)];
const mixUV = (a: SurfaceUV, b: SurfaceUV, t: number): SurfaceUV => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const distUV = (a: SurfaceUV, b: SurfaceUV) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const area2 = (loop: SurfaceUV[]) => loop.reduce((sum, [u, v], i) => {
  const [x, y] = loop[(i + 1) % loop.length];
  return sum + u * y - v * x;
}, 0);

function outlinePlane(points: Vec3[]) {
  const centre = scale(points.reduce(add, [0, 0, 0]), 1 / points.length);
  const offsets = points.map((p) => sub(p, centre));
  const covariance = new Float64Array(9);
  for (const q of offsets) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) covariance[i * 3 + j] += q[i] * q[j];
  let normal = symmetricEigen3(covariance).vectors[2];
  const axis = PLANE_FRAMES[detectPlane(new Geometry({ positions: points.flat() }))].N;
  const alignment = dot(normal, axis);
  const dominant = normal.reduce((a, b) => Math.abs(a) >= Math.abs(b) ? a : b);
  if ((Math.abs(alignment) > 1e-8 ? alignment : dominant) < 0) normal = scale(normal, -1);
  const radius = offsets.reduce((r, p) => Math.max(r, length(p)), 0);
  const deviation = offsets.reduce((d, p) => Math.max(d, Math.abs(dot(p, normal))), 0);
  return { centre, normal, planar: deviation <= Math.max(HIT_EPS, radius * 1e-10) };
}

function readOutline(g: Geometry, prim: number, o: TrimOptions): Outline {
  const label = `Outline prim ${prim}`;
  if (g.isSurface(prim) || g.isPacked(prim)) throw new Error(`${label} must be a closed polyline, Bezier or NURBS curve.`);
  if (!g.primClosed[prim]) throw new Error(`${label} is open. Close it before trimming.`);
  const points = g.primPoints(prim).map((i) => [g.P[3 * i], g.P[3 * i + 1], g.P[3 * i + 2]] as Vec3);
  const spline = g.isSpline(prim) ? splineFromPrim(g, prim) : null;
  if (!spline && points.length && dist(points[0], points[points.length - 1]) === 0) points.pop();
  if (points.length < 3) throw new Error(`${label} needs at least three points to enclose an area.`);
  const at = spline ? (t: number) => evalPoint(spline, t) as Vec3 : (t: number) => {
    const k = t * points.length, i = Math.floor(k) % points.length;
    return lerp3(points[i], points[(i + 1) % points.length], k - Math.floor(k));
  };
  const breaks = spline ? polylineParams(spline, { tolerance: o.tolerance / 4 }) : points.map((_, i) => i / points.length);
  const name = g.prims.get('name');
  const plane = o.project === 'axis' ? outlinePlane(points) : { centre: points[0], normal: [0, 0, 0] as Vec3, planar: true };
  const inferred = length(o.direction) <= 1e-20;
  if (inferred && !plane.planar)
    throw new Error(`${label} is non-planar. Set direction to the axis to project along.`);
  return { prim, name: name?.type === 'string' ? String(name.get(prim)) : '', at, breaks: [...breaks, 1],
    direction: inferred ? plane.normal : normalize(o.direction), centre: plane.centre, normal: plane.normal };
}

type Hit = { uv: SurfaceUV; P: Vec3 };

function axisProjector(s: NurbsSurface, outline: Outline, side: TrimOptions['hits']): (q: Vec3) => Hit[] {
  const dir = outline.direction;
  const axis: Vec3 = Math.abs(dir[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const X = normalize(cross(dir, axis)), Y = cross(dir, X);
  const relative = (p: Vec3) => sub(p, outline.centre);
  const [U, V] = meshParams(s, { segments: 4 });
  const grid = V.map((v) => U.map((u) => {
    const uv: SurfaceUV = [u, v], p = relative(surfacePoint(s, uv));
    return { uv, x: dot(p, X), y: dot(p, Y) };
  }));
  type Vertex = typeof grid[number][number];
  const triangles: { p: Vertex; q: Vertex; r: Vertex; bx: number; by: number; cx: number; cy: number; det: number;
    minX: number; maxX: number; minY: number; maxY: number }[] = [];
  for (let j = 1; j < V.length; j++) for (let i = 1; i < U.length; i++) {
    const a = grid[j - 1][i - 1], b = grid[j - 1][i], c = grid[j][i], d = grid[j][i - 1];
    for (const [p, q, r] of [[a, b, c], [a, c, d]] as Vertex[][]) {
      const bx = q.x - p.x, by = q.y - p.y, cx = r.x - p.x, cy = r.y - p.y;
      const det = bx * cy - by * cx;
      if (Math.abs(det) <= 1e-14 * Math.hypot(bx, by) * Math.hypot(cx, cy)) continue;
      const minX = Math.min(p.x, q.x, r.x), maxX = Math.max(p.x, q.x, r.x);
      const minY = Math.min(p.y, q.y, r.y), maxY = Math.max(p.y, q.y, r.y);
      // Also try near the mesh silhouette. A curved span can extend just past its chord.
      const ex = (maxX - minX) / 8 + HIT_EPS, ey = (maxY - minY) / 8 + HIT_EPS;
      triangles.push({ p, q, r, bx, by, cx, cy, det, minX: minX - ex, maxX: maxX + ex, minY: minY - ey, maxY: maxY + ey });
    }
  }
  const refine = (q: Vec3, uv: SurfaceUV): Hit | null => {
    for (let i = 0; i < 32; i++) {
      const { P, Su, Sv } = evalSurface(s, ...uv);
      const r = sub(P, q), t = dot(r, dir);
      const error = sub(r, scale(dir, t));
      if (length(error) <= HIT_EPS) return { uv, P };
      const u = dot(Su, X), v = dot(Su, Y), x = dot(Sv, X), y = dot(Sv, Y);
      const det = u * y - v * x;
      if (Math.abs(det) <= 1e-14 * length(Su) * length(Sv)) break;
      const a = dot(error, X), b = dot(error, Y);
      // Eliminate t along the unit axis, then solve the transverse Newton system for u and v.
      const du = (x * b - y * a) / det, dv = (v * a - u * b) / det;
      const step = Math.max(1, 4 * Math.abs(du), 4 * Math.abs(dv));
      const next = clampUV(s, [uv[0] + du / step, uv[1] + dv / step]);
      if (distUV(uv, next) < 1e-14) break;
      uv = next;
    }
    return null;
  };
  const facing = dot(dir, outline.normal);
  return (q: Vec3) => {
    const rel = relative(q), x = dot(rel, X), y = dot(rel, Y);
    const hits: Hit[] = [];
    for (const tri of triangles) {
      if (x < tri.minX || x > tri.maxX || y < tri.minY || y > tri.maxY) continue;
      const { p, q: b, r: c, bx, by, cx, cy, det } = tri;
      const dx = x - p.x, dy = y - p.y;
      const v = (dx * cy - dy * cx) / det, w = (bx * dy - by * dx) / det, u = 1 - v - w;
      if (Math.min(u, v, w) < -0.125) continue;
      const seed: SurfaceUV = [p.uv[0] * u + b.uv[0] * v + c.uv[0] * w, p.uv[1] * u + b.uv[1] * v + c.uv[1] * w];
      if (hits.some((h) => distUV(h.uv, unwrapUV(s, h.uv, seed)) < 1e-12)) continue;
      const hit = refine(q, clampUV(s, seed));
      if (!hit || hits.some((h) => distUV(h.uv, unwrapUV(s, h.uv, hit.uv)) <= UV_EPS)) continue;
      const t = Math.abs(facing) > 1e-8
        ? dot(relative(hit.P), outline.normal) * Math.sign(facing) : dot(sub(hit.P, q), dir);
      if ((side === 'front' && t < -HIT_EPS) || (side === 'back' && t > HIT_EPS)) continue;
      hits.push(hit);
    }
    return hits.sort((a, b) => a.uv[0] - b.uv[0] || a.uv[1] - b.uv[1]);
  };
}

function matchHits(s: NurbsSurface, before: Hit[], after: Hit[]) {
  const pairs = before.flatMap((a, i) => after.map((b, j) => {
    const uv = unwrapUV(s, a.uv, b.uv);
    return { i, j, uv, distance: distUV(a.uv, uv) };
  })).sort((a, b) => a.distance - b.distance);
  const ordered: typeof pairs = [], used = new Set<number>();
  for (const pair of pairs) if (!ordered[pair.i] && !used.has(pair.j)) {
    ordered[pair.i] = pair;
    used.add(pair.j);
  }
  return ordered;
}

function chain(s: NurbsSurface, before: Hit[], after: Hit[]): Hit[] {
  if (before.length === 1) return [{ ...after[0], uv: unwrapUV(s, before[0].uv, after[0].uv) }];
  return matchHits(s, before, after).map(({ j, uv }) => ({ uv, P: after[j].P }));
}

type ProjectionSample = { t: number; q: Vec3; hits: Hit[] };

function openEdge(s: NurbsSurface, uv: SurfaceUV, epsilon = UV_EPS) {
  return DOMAIN.findIndex((a, i) => {
    const d = (i + 1) % 2;
    return !(d ? s.v : s.u).closed && Math.abs(uv[d] - a[d]) <= epsilon;
  });
}

function orientLoop(loop: SurfaceUV[], label: string, epsilon: number) {
  const clean = loop.filter((p, k) => distUV(p, loop[(k + 1) % loop.length]) > epsilon);
  const area = area2(clean);
  if (clean.length < 3 || Math.abs(area) < 1e-16) throw new Error(`${label} encloses no area. Move the outline.`);
  return area > 0 ? clean : clean.reverse();
}

/** Follow partial hit tracks and close them just outside the edges they crossed. */
function offEdgeLoops(s: NurbsSurface, o: TrimOptions, outline: Outline, label: string, initial: ProjectionSample[],
  sample: (t: number) => ProjectionSample, hitError: (q: Vec3) => Error): SurfaceUV[][] {
  type End = { hit: Hit; t: number; edge: number };
  const entries: End[] = [], exits: End[] = [];
  const next = new Map<Hit, { hit: Hit; bridge?: SurfaceUV[] }>();
  const snap = (hit: Hit, edge: number) => { hit.uv[(edge + 1) % 2] = DOMAIN[edge][(edge + 1) % 2]; };
  const record = (hit: Hit, a: ProjectionSample, miss: ProjectionSample, ends: End[]) => {
    const edge = openEdge(s, hit.uv, 1e-6);
    if (edge < 0) throw hitError(miss.q);
    snap(hit, edge);
    ends.push({ hit, t: a.t % 1, edge });
  };
  const trace = (a: ProjectionSample, b: ProjectionSample, depth: number) => {
    const pairs = matchHits(s, a.hits, b.hits);
    const changes = pairs.filter(Boolean).length !== Math.max(a.hits.length, b.hits.length);
    if (changes && depth >= 25) {
      const matched = new Set(pairs.map((p) => p.j));
      a.hits.forEach((h, i) => { if (!pairs[i]) record(h, a, b, exits); });
      b.hits.forEach((h, j) => { if (!matched.has(j)) record(h, b, a, entries); });
    } else {
      const mid = sample((a.t + b.t) / 2);
      const predicted = pairs.map(({ i, j, uv }) => ({ uv: mixUV(a.hits[i].uv, uv, 0.5), P: lerp3(a.hits[i].P, b.hits[j].P, 0.5) }));
      const different = mid.hits.length !== a.hits.length;
      const bent = !changes && !different && predicted.length && chain(s, predicted, mid.hits).some((h, i) =>
        dist(h.P, predicted[i].P) > o.tolerance / 4 || dist(h.P, surfacePoint(s, predicted[i].uv)) > o.tolerance / 4);
      if (changes || different || bent) {
        if (depth >= 25) throw hitError(mid.q);
        trace(a, mid, depth + 1); trace(mid, b, depth + 1);
        return;
      }
    }
    for (const { i, j } of pairs.filter(Boolean)) next.set(a.hits[i], { hit: b.hits[j] });
  };
  for (let i = 1; i < initial.length; i++) trace(initial[i - 1], initial[i], 0);

  const bridge = (a: End, b: End): SurfaceUV[] => {
    const outside = (p: SurfaceUV, edge: number): SurfaceUV => {
      const uv: SurfaceUV = [...p], d = (edge + 1) % 2;
      uv[d] += uv[d] === 0 ? -0.01 : 0.01;
      return uv;
    };
    const start = outside(a.hit.uv, a.edge), stop = outside(unwrapUV(s, a.hit.uv, b.hit.uv), b.edge);
    if (a.edge === b.edge) return [start, stop];
    const corners = (from: number, to: number, step: number) => {
      const uv: SurfaceUV[] = [];
      for (let edge = from; edge !== to;) {
        const next = (edge + step + 4) % 4, corner = DOMAIN[step > 0 ? next : edge];
        if (next !== to && ((next % 2 ? s.u : s.v).closed)) return null;
        uv.push(outside(outside(corner, edge), next));
        edge = next;
      }
      return uv;
    };
    const routes = [corners(a.edge, b.edge, 1), corners(a.edge, b.edge, -1)].filter((route) => route !== null);
    if (!routes.length) throw new Error(`${label} leaves through an open edge and returns through the opposite edge of a periodic surface. Split the outline into separate cuts.`);
    // Choose the outside route nearest the missing stretch in the projection plane.
    const mid = outline.at((a.t + ((b.t - a.t + 1) % 1) / 2) % 1);
    const cost = (route: SurfaceUV[]) => route.reduce((sum, uv) => {
      const delta = sub(surfacePoint(s, uv.map((x) => clamp(x, 0, 1)) as SurfaceUV), mid);
      return sum + length(sub(delta, scale(outline.direction, dot(delta, outline.direction))));
    }, 0) / route.length;
    routes.sort((a, b) => cost(a) - cost(b));
    return [start, ...routes[0], stop];
  };
  const gaps = exits.flatMap((a) => entries.map((b) => ({ a, b, time: (b.t - a.t + 1) % 1,
    distance: distUV(a.hit.uv, unwrapUV(s, a.hit.uv, b.hit.uv)) })));
  gaps.sort((a, b) => a.time - b.time || a.distance - b.distance);
  const used = new Set<End>();
  for (const { a, b } of gaps) {
    if (next.has(a.hit) || used.has(b)) continue;
    next.set(a.hit, { hit: b.hit, bridge: bridge(a, b) });
    used.add(b);
  }
  const loops: SurfaceUV[][] = [], seen = new Set<Hit>();
  for (const first of next.keys()) {
    if (seen.has(first)) continue;
    const loop = [first.uv];
    let hit = first;
    do {
      const link = next.get(hit);
      if (!link || seen.has(hit)) throw new Error(`${label} leaves through an open edge without closing a cut. Move or split the outline.`);
      seen.add(hit);
      const previous = loop[loop.length - 1];
      if (link.bridge) {
        // Move the whole exterior route into the current periodic copy.
        const du = previous[0] - hit.uv[0], dv = previous[1] - hit.uv[1];
        loop.push(...link.bridge.map(([u, v]): SurfaceUV => [u + du, v + dv]));
      }
      hit = link.hit;
      loop.push(unwrapUV(s, loop[loop.length - 1], hit.uv));
    } while (hit !== first);
    if (distUV(loop.pop()!, first.uv) > UV_EPS) throw new Error(`${label} leaves through an open edge without closing a cut. Move or split the outline.`);
    loops.push(orientLoop(loop, label, UV_EPS));
  }
  return loops;
}

function projectOutline(s: NurbsSurface, prim: number, o: TrimOptions, outline: Outline): SurfaceUV[][] {
  const project = o.project === 'axis' ? axisProjector(s, outline, o.hits) : (q: Vec3): Hit[] => {
    const { u, v, P } = closestSurfacePoint(s, q);
    return [{ uv: [u, v], P }];
  };
  const cache = new Map<number, ProjectionSample>();
  const sample = (t: number): ProjectionSample => {
    const known = cache.get(t);
    if (known) return known;
    if (t === 1) return { ...sample(0), t };
    const q = outline.at(t);
    const result = { t, q, hits: project(q) };
    cache.set(t, result);
    return result;
  };
  // Only axis projection needs the extra hit-count checks. Closest always returns one hit.
  const initial = o.project === 'closest' ? [] : outline.breaks.slice(1).flatMap((b, i) => {
    const a = outline.breaks[i];
    return [a, a + (b - a) / 4, (a + b) / 2, b - (b - a) / 4].map(sample);
  });
  const count = o.project === 'closest' ? 1 : initial.find((a) => a.hits.length)?.hits.length ?? 0;
  const label = `Outline prim ${outline.prim}`;
  const projection = `${label} on surface prim ${prim}`;
  if (!count) throw new Error(`${label} misses surface prim ${prim}. Move the outline or use project: closest.`);
  const hitError = (q: Vec3) => new Error(`${label} changes its number of hits on surface prim ${prim} at [${q.map((x) => +x.toPrecision(8)).join(', ')}] m. Move the outline or use project: closest.`);
  const offEdge = () => offEdgeLoops(s, o, outline, projection, [...cache.values(), sample(1)].sort((a, b) => a.t - b.t), sample, hitError);
  if (initial.some((a) => a.hits.length !== count)) return offEdge();
  const countChange = Symbol();
  let a = sample(0);
  const loops = a.hits.map((): SurfaceUV[] => []);
  const follow = (a: ReturnType<typeof sample>, b: ReturnType<typeof sample>, depth: number): Hit[] => {
    const end = chain(s, a.hits, b.hits);
    let middle: ReturnType<typeof sample> | undefined;
    let good = true;
    for (const f of [0.5, 0.25, 0.75]) {
      const c = sample(a.t + (b.t - a.t) * f);
      if (c.hits.length !== count) throw countChange;
      if (f === 0.5) middle = c;
      const predicted = a.hits.map((h, i) => ({ uv: mixUV(h.uv, end[i].uv, f), P: lerp3(h.P, end[i].P, f) }));
      const actual = chain(s, predicted, c.hits);
      if (actual.some((h, i) => dist(h.P, predicted[i].P) > o.tolerance / 4 ||
          dist(h.P, surfacePoint(s, predicted[i].uv)) > o.tolerance / 4)) { good = false; break; }
    }
    const edge = o.project === 'closest' && depth >= 16 ? openEdge(s, a.hits[0].uv) : -1;
    if (good || (edge >= 0 && edge === openEdge(s, end[0].uv))) {
      a.hits.forEach((h, i) => loops[i].push(h.uv));
      return end;
    }
    if (depth >= 16) throw new Error(`${label} cannot be projected onto surface prim ${prim} within tolerance. Move the outline or use a larger tolerance.`);
    return follow({ ...middle!, hits: follow(a, middle!, depth + 1) }, b, depth + 1);
  };
  // Use the initial steps to check hit counts even on straight spans. Refine the sampled path from its knots.
  try {
    for (const t of outline.breaks.slice(1)) {
      const b = sample(t);
      a = { ...b, hits: follow(a, b, 0) };
    }
  } catch (error) {
    if (error === countChange) return offEdge();
    throw error;
  }
  return loops.map((loop, i) => {
    if (distUV(a.hits[i].uv, loop[0]) > UV_EPS) throw new Error(`${label} does not close a region on surface prim ${prim}. Move the outline or use project: closest.`);
    const clean = loop.filter((p, k) => distUV(p, loop[(k + 1) % loop.length]) > 1e-12);
    const area = area2(clean);
    if (clean.length < 3 || Math.abs(area) < 1e-16) throw new Error(`${label} encloses no area on surface prim ${prim}. Move the outline.`);
    return area > 0 ? clean : clean.reverse();
  });
}

function periodicCopies(s: NurbsSurface, loop: SurfaceUV[]): SurfaceUV[][] {
  const shifts = (axis: number, closed: boolean) => {
    if (!closed) return [0];
    let min = Infinity, max = -Infinity;
    for (const p of loop) { min = Math.min(min, p[axis]); max = Math.max(max, p[axis]); }
    const from = -Math.floor(max), to = -Math.floor(min);
    return Array.from({ length: to - from + 1 }, (_, i) => from + i);
  };
  return shifts(0, s.u.closed).flatMap((x) => shifts(1, s.v.closed).map((y) =>
    loop.map(([u, v]): SurfaceUV => [u + x, v + y])));
}

type BoundaryEdge = { a: SurfaceUV; b: SurfaceUV };
type Brush = { loops: SurfaceUV[][]; name: string };
type TrimRegion = { loops: SurfaceUV[][]; names?: string[] };

/** Join the region boundary across periodic seams, canceling the shared seam segments. */
function cutBoundaries(s: NurbsSurface, region: SurfaceUV[][], brushes: Brush[], sources: Brush[], names: boolean) {
  const key = (p: SurfaceUV) => clampUV(s, p).map((x) => Math.round(x / UV_EPS)).join(',');
  const outgoing = new Map<string, BoundaryEdge[]>();
  const seam = (a: SurfaceUV, b: SurfaceUV) => s.u.closed && a[0] === b[0] && (a[0] === 0 || a[0] === 1) ? 0
    : s.v.closed && a[1] === b[1] && (a[1] === 0 || a[1] === 1) ? 1 : -1;
  const segments = region.flatMap(trimEdges);
  const ends = [0, 1].map((d) => [...new Set(segments.flatMap(({ a, b }) => seam(a, b) === d ? [a[1 - d], b[1 - d]] : []))].sort((a, b) => a - b));
  const seamEdges = new Map<string, BoundaryEdge>();
  const append = (e: BoundaryEdge) => {
    const id = key(e.a), list = outgoing.get(id) ?? [];
    list.push(e); outgoing.set(id, list);
  };
  for (const { a, b } of segments) {
    const d = seam(a, b);
    if (d < 0) { append({ a, b }); continue; }
    const along = 1 - d, min = Math.min(a[along], b[along]), max = Math.max(a[along], b[along]);
    const points = ends[d].filter((x) => x > min && x < max).map((x): SurfaceUV => d === 0 ? [a[0], x] : [x, a[1]]);
    if (a[along] > b[along]) points.reverse();
    const path = [a, ...points, b];
    for (let i = 1; i < path.length; i++) {
      const p = path[i - 1], q = path[i], id = `${d}:${p[along]},${q[along]}`, rev = `${d}:${q[along]},${p[along]}`;
      if (!seamEdges.delete(rev)) seamEdges.set(id, { a: p, b: q });
    }
  }
  for (const e of seamEdges.values()) append(e);
  const onLoop = (p: SurfaceUV, loop: SurfaceUV[]) => loop.some((a, i) => {
    const b = loop[(i + 1) % loop.length], dx = b[0] - a[0], dy = b[1] - a[1];
    const t = clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy), 0, 1);
    return distUV(p, mixUV(a, b, t)) <= 4 * UV_EPS;
  });
  const out: { uv: SurfaceUV[]; name: string }[] = [];
  for (const edges of outgoing.values()) while (edges.length) {
    let edge = edges.pop()!;
    const first = key(edge.a), uv = [edge.a];
    let owner = false;
    const path: BoundaryEdge[] = [];
    for (;;) {
      const { a, b } = edge, last = uv[uv.length - 1];
      path.push(edge);
      uv.push([last[0] + b[0] - a[0], last[1] + b[1] - a[1]]);
      const mid = mixUV(a, b, 0.5);
      owner ||= brushes.some((brush) => brush.loops.some((loop) => onLoop(mid, loop)));
      const next = key(b);
      if (next === first) { if (owner) out.push({ uv, name: names ? trimBoundaryName(s, path, sources) : '' }); break; }
      const linked = outgoing.get(next)?.pop();
      if (!linked) break;
      edge = linked;
    }
  }
  return out;
}

function edgeSpline(s: NurbsSurface, uv: SurfaceUV[], tolerance: number): FitResult {
  const samples = uv.slice(1).flatMap((b, i) => [uv[i], ...sampleTrimSegment(s, uv[i], b, tolerance / 4)]);
  const Q = samples.map((p) => surfacePoint(s, p)).flat();
  const fit = (order: number) => fitSpline(Q, { order, cvs: samples.length, closed: true, pins: [0], mode: 'chord' });
  const smooth = fit(4);
  const spline = makeSpline('nurbs', smooth.P, smooth);
  const follows = smooth.error <= tolerance / 2 && samples.every((a, i) => {
    const b = samples[i + 1] ?? uv[uv.length - 1], t0 = smooth.params[i], t1 = smooth.params[i + 1] ?? 1;
    return [0.25, 0.5, 0.75].every((t) =>
      dist(surfacePoint(s, mixUV(a, b, t)), evalPoint(spline, t0 + (t1 - t0) * t) as Vec3) <= tolerance / 2);
  });
  // A linear NURBS preserves sharp corners and follows the same sampled chords when a cubic overshoots.
  return follows ? smooth : fit(2);
}

export function trimSurfaces(src: Geometry, profiles: Geometry, o: TrimOptions) {
  const selection = Array.from({ length: src.numPrims }, (_, p) => p).filter((p) => src.isSurface(p) && (!o.surfaces || o.surfaces[p]));
  const outlines = selection.length ? Array.from({ length: profiles.numPrims }, (_, p) => p)
    .filter((p) => !o.outlines || o.outlines[p]).map((p) => readOutline(profiles, p, o)) : [];
  if (!outlines.length) return { geo: src, loops: 0, surfaces: 0, edges: 0 };
  const cuts = new Map<number, { outside?: TrimRegion; inside?: TrimRegion; edges: { fit: FitResult; name: string }[] }>();
  const named = profiles.prims.get('name')?.type === 'string' || src.prims.has(TRIM_NAMES);
  let loops = 0;
  for (const prim of selection) {
    const s = surfaceFromPrim(src, prim);
    if (!s) throw new Error(`Surface prim ${prim} has an invalid NURBS control grid. Check its control points and surface_cols.`);
    const previousNames: string[] = [], previous = surfaceTrims(src, prim, previousNames);
    const original = crossSection(previous ?? [DOMAIN], 'Positive');
    const brushes: Brush[] = [];
    try {
      for (const outline of outlines) {
        const projected = projectOutline(s, prim, o, outline);
        loops += projected.length;
        brushes.push({ name: outline.name, loops: projected.flatMap((loop) => periodicCopies(s, loop)) });
      }
      const brush = crossSection(brushes.flatMap((b) => b.loops), 'Positive');
      try {
        const sources = [...brushes, ...previous?.map((loop, i) => ({ name: previousNames[i], loops: [loop] })) ?? []];
        const region = (loops: SurfaceUV[][]): TrimRegion => ({ loops, names: named ? loops.map((loop) => trimBoundaryName(s, trimEdges(loop), sources)) : undefined });
        const outside = o.keep === 'inside' ? null : original.subtract(brush);
        const inside = o.keep === 'outside' ? null : original.intersect(brush);
        try {
          if (outside?.isEmpty() || inside?.isEmpty()) {
            const outline = outlines[outlines.length - 1];
            throw new Error(`Surface prim ${prim} and outline prim ${outline.prim} leave no area. Move the outline or change keep.`);
          }
          const boundary = ((outside ?? inside).toPolygons()) as SurfaceUV[][];
          const edges = o.edges ? cutBoundaries(s, boundary, brushes, sources, named).map(({ uv, name }) => ({ name, fit: edgeSpline(s, uv, o.tolerance) })) : [];
          cuts.set(prim, { outside: outside ? region(boundary) : undefined,
            inside: inside ? region((outside ? inside.toPolygons() : boundary) as SurfaceUV[][]) : undefined, edges });
        } finally { outside?.delete(); inside?.delete(); }
      } finally { brush.delete(); }
    } finally { original.delete(); }
  }

  if (o.keep !== 'both' && !o.edges) {
    const geo = src.clone();
    for (const [p, cut] of cuts) {
      const { loops, names } = (cut.outside ?? cut.inside)!;
      setSurfaceTrims(geo, p, loops, names);
    }
    return { geo, loops, surfaces: cuts.size, edges: 0 };
  }
  const b = new GeoBuilder(src);
  for (let i = 0; i < src.numPoints; i++) b.copyPoint(i);
  const kinds: [number, number][] = [], regions: [number, TrimRegion][] = [];
  const edges: { prim: number; fit: FitResult }[] = [];
  const append = (p: number, copyCVs = false) => {
    const vs = Array.from({ length: src.primSize(p) }, (_, k) => src.primStart[p] + k);
    let pts = src.primPoints(p);
    if (copyCVs) {
      const copies = new Map<number, number>();
      pts = pts.map((i) => {
        const known = copies.get(i);
        if (known !== undefined) return known;
        const copy = b.copyPoint(i);
        copies.set(i, copy);
        return copy;
      });
    }
    const id = b.addPrim(pts, !!src.primClosed[p], p, vs);
    if (src.isSurface(p) || src.isSpline(p)) kinds.push([id, src.primKind![p]]);
    return id;
  };
  for (let p = 0; p < src.numPrims; p++) {
    append(p);
  }
  if (o.keep === 'both') {
    for (const name of ['trim_outside', 'trim_inside']) {
      src.primGroups.get(name)?.forEach((keep, p) => { if (keep && !cuts.has(p)) b.group('prim', name).add(p); });
    }
    for (const [p, cut] of cuts) {
      const inside = append(p, true);
      regions.push([inside, cut.inside!]);
      b.group('prim', 'trim_outside').add(p);
      b.group('prim', 'trim_inside').add(inside);
    }
  }
  for (const [p, cut] of cuts) {
    regions.push([p, (cut.outside ?? cut.inside)!]);
    // For both regions the outside prim owns the shared cut curve.
    for (const { fit, name } of cut.edges) {
      const pts = Array.from({ length: fit.P.length / 3 }, (_, i) => b.addPoint(fit.P[3 * i], fit.P[3 * i + 1], fit.P[3 * i + 2]));
      const prim = b.addPrim(pts, true);
      b.group('prim', 'edges').add(prim);
      b.attrib('prim', 'name', 1, 'string').set(prim, named ? name : `edge_${edges.length}`);
      b.attrib('prim', 'edge_surface', 1, 'int').set(prim, p);
      edges.push({ prim, fit });
    }
  }
  if (edges.length) src.primGroups.get('edges')?.forEach((keep, p) => { if (keep) b.group('prim', 'edges').add(p); });
  const geo = b.build();
  geo.ensurePacked();
  for (const [p, kind] of kinds) geo.primKind![p] = kind;
  for (const [p, { loops, names }] of regions) setSurfaceTrims(geo, p, loops, names);
  for (const { prim, fit } of edges) setSplinePrim(geo, prim, 'nurbs', fit.order, fit.knots);
  return { geo, loops, surfaces: cuts.size, edges: edges.length };
}
