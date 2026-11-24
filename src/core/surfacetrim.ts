import { symmetricEigen3 } from './analysis.ts';
import { GeoBuilder, Geometry } from './geometry.ts';
import { PLANE_FRAMES, crossSection, detectPlane } from './manifold.ts';
import { add, clamp, cross, dist, dot, lerp3, length, normalize, scale, sub } from './math.ts';
import type { Vec3 } from './math.ts';
import { closestSurfacePoint, evalSurface, meshParams, sampleTrimSegment, setSurfaceTrims, surfaceFromPrim, surfacePoint, surfaceTrims } from './nurbssurface.ts';
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

function chain(s: NurbsSurface, before: Hit[], after: Hit[]): Hit[] {
  if (before.length === 1) return [{ ...after[0], uv: unwrapUV(s, before[0].uv, after[0].uv) }];
  const pairs = before.flatMap((a, i) => after.map((b, j) => {
    const uv = unwrapUV(s, a.uv, b.uv);
    return { i, j, uv, distance: distUV(a.uv, uv) };
  })).sort((a, b) => a.distance - b.distance);
  const ordered: Hit[] = [], used = new Set<number>();
  for (const { i, j, uv } of pairs) if (!ordered[i] && !used.has(j)) {
    ordered[i] = { uv, P: after[j].P };
    used.add(j);
  }
  return ordered;
}

function projectOutline(s: NurbsSurface, prim: number, o: TrimOptions, outline: Outline): SurfaceUV[][] {
  const project = o.project === 'axis' ? axisProjector(s, outline, o.hits) : (q: Vec3): Hit[] => {
    const { u, v, P } = closestSurfacePoint(s, q);
    return [{ uv: [u, v], P }];
  };
  const sample = (t: number) => {
    const q = outline.at(t);
    return { t, q, hits: project(q) };
  };
  const initial = outline.breaks.slice(1).flatMap((b, i) => {
    const a = outline.breaks[i];
    return [a, a + (b - a) / 4, (a + b) / 2, b - (b - a) / 4].map(sample);
  });
  const count = initial.find((a) => a.hits.length)?.hits.length ?? 0;
  const label = `Outline prim ${outline.prim}`;
  if (!count) throw new Error(`${label} misses surface prim ${prim}. Move the outline or use project: closest.`);
  const verify = ({ q, hits }: ReturnType<typeof sample>) => {
    if (hits.length !== count) throw new Error(`${label} changes its number of hits on surface prim ${prim} at [${q.map((x) => +x.toPrecision(8)).join(', ')}] m. Move the outline or use project: closest.`);
  };
  initial.forEach(verify);
  const loops = initial[0].hits.map((): SurfaceUV[] => []);
  const follow = (a: ReturnType<typeof sample>, b: ReturnType<typeof sample>, depth: number): Hit[] => {
    const end = chain(s, a.hits, b.hits);
    let middle: ReturnType<typeof sample> | undefined;
    let good = true;
    for (const f of [0.5, 0.25, 0.75]) {
      const c = sample(a.t + (b.t - a.t) * f);
      verify(c);
      if (f === 0.5) middle = c;
      const predicted = a.hits.map((h, i) => ({ uv: mixUV(h.uv, end[i].uv, f), P: lerp3(h.P, end[i].P, f) }));
      const actual = chain(s, predicted, c.hits);
      if (actual.some((h, i) => dist(h.P, predicted[i].P) > o.tolerance / 4 ||
          dist(h.P, surfacePoint(s, predicted[i].uv)) > o.tolerance / 4)) { good = false; break; }
    }
    if (good) {
      a.hits.forEach((h, i) => loops[i].push(h.uv));
      return end;
    }
    if (depth >= 16) throw new Error(`${label} cannot be projected onto surface prim ${prim} within tolerance. Move the outline or use a larger tolerance.`);
    return follow({ ...middle!, hits: follow(a, middle!, depth + 1) }, b, depth + 1);
  };
  // Use the initial steps to check hit counts even on straight spans. Refine the sampled path from its knots.
  let a = initial[0];
  for (let i = 4; i <= initial.length; i += 4) {
    const b = i < initial.length ? initial[i] : { ...initial[0], t: 1 };
    a = { ...b, hits: follow(a, b, 0) };
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

/** Join the region boundary across periodic seams, canceling the shared seam segments. */
function cutBoundaries(s: NurbsSurface, region: SurfaceUV[][], brushes: Brush[]) {
  const key = (p: SurfaceUV) => clampUV(s, p).map((x) => Math.round(x / UV_EPS)).join(',');
  const outgoing = new Map<string, BoundaryEdge[]>();
  const seam = (a: SurfaceUV, b: SurfaceUV) => s.u.closed && a[0] === b[0] && (a[0] === 0 || a[0] === 1) ? 0
    : s.v.closed && a[1] === b[1] && (a[1] === 0 || a[1] === 1) ? 1 : -1;
  const segments = region.flatMap((loop) => loop.map((a, i) => ({ a, b: loop[(i + 1) % loop.length] })));
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
    let owner = brushes.length;
    for (;;) {
      const { a, b } = edge, last = uv[uv.length - 1];
      uv.push([last[0] + b[0] - a[0], last[1] + b[1] - a[1]]);
      const mid = mixUV(a, b, 0.5);
      for (let i = 0; i < owner; i++) if (brushes[i].loops.some((loop) => onLoop(mid, loop))) { owner = i; break; }
      const next = key(b);
      if (next === first) { if (owner < brushes.length) out.push({ uv, name: brushes[owner].name }); break; }
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
  const cuts = new Map<number, { outside: SurfaceUV[][]; inside: SurfaceUV[][]; edges: { fit: FitResult; name: string }[] }>();
  let loops = 0;
  for (const prim of selection) {
    const s = surfaceFromPrim(src, prim);
    if (!s) throw new Error(`Surface prim ${prim} has an invalid NURBS control grid. Check its control points and surface_cols.`);
    const original = crossSection(surfaceTrims(src, prim) ?? [DOMAIN], 'Positive');
    const brushes: Brush[] = [];
    try {
      for (const outline of outlines) {
        const projected = projectOutline(s, prim, o, outline);
        loops += projected.length;
        brushes.push({ name: outline.name, loops: projected.flatMap((loop) => periodicCopies(s, loop)) });
      }
      const brush = crossSection(brushes.flatMap((b) => b.loops), 'Positive');
      try {
        const outside = o.keep === 'inside' ? null : original.subtract(brush);
        const inside = o.keep === 'outside' ? null : original.intersect(brush);
        try {
          if (outside?.isEmpty() || inside?.isEmpty()) {
            const outline = outlines[outlines.length - 1];
            throw new Error(`Surface prim ${prim} and outline prim ${outline.prim} leave no area. Move the outline or change keep.`);
          }
          const boundary = ((outside ?? inside).toPolygons()) as SurfaceUV[][];
          const edges = o.edges ? cutBoundaries(s, boundary, brushes).map(({ uv, name }) => ({ name, fit: edgeSpline(s, uv, o.tolerance) })) : [];
          cuts.set(prim, { outside: outside ? boundary : [], inside: inside ? inside.toPolygons() as SurfaceUV[][] : [], edges });
        } finally { outside?.delete(); inside?.delete(); }
      } finally { brush.delete(); }
    } finally { original.delete(); }
  }

  if (o.keep !== 'both' && !o.edges) {
    const geo = src.clone();
    for (const [p, cut] of cuts) setSurfaceTrims(geo, p, cut.outside.length ? cut.outside : cut.inside);
    return { geo, loops, surfaces: cuts.size, edges: 0 };
  }
  const b = new GeoBuilder(src);
  for (let i = 0; i < src.numPoints; i++) b.copyPoint(i);
  const kinds: [number, number][] = [], regions: [number, SurfaceUV[][]][] = [];
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
      regions.push([inside, cut.inside]);
      b.group('prim', 'trim_outside').add(p);
      b.group('prim', 'trim_inside').add(inside);
    }
  }
  for (const [p, cut] of cuts) {
    regions.push([p, cut.outside.length ? cut.outside : cut.inside]);
    // For both regions the outside prim owns the shared cut curve.
    for (const { fit, name } of cut.edges) {
      const pts = Array.from({ length: fit.P.length / 3 }, (_, i) => b.addPoint(fit.P[3 * i], fit.P[3 * i + 1], fit.P[3 * i + 2]));
      const prim = b.addPrim(pts, true);
      b.group('prim', 'edges').add(prim);
      b.attrib('prim', 'name', 1, 'string').set(prim, name || `edge_${edges.length}`);
      b.attrib('prim', 'edge_surface', 1, 'int').set(prim, p);
      edges.push({ prim, fit });
    }
  }
  if (edges.length) src.primGroups.get('edges')?.forEach((keep, p) => { if (keep) b.group('prim', 'edges').add(p); });
  const geo = b.build();
  geo.ensurePacked();
  for (const [p, kind] of kinds) geo.primKind![p] = kind;
  for (const [p, region] of regions) setSurfaceTrims(geo, p, region);
  for (const { prim, fit } of edges) setSplinePrim(geo, prim, 'nurbs', fit.order, fit.knots);
  return { geo, loops, surfaces: cuts.size, edges: edges.length };
}
