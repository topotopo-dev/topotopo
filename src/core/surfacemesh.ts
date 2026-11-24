import { GeoBuilder } from './geometry.ts';
import type { Geometry, Src } from './geometry.ts';
import { M, crossSection } from './manifold.ts';
import { cross, dot, normalize, sub } from './math.ts';
import type { Vec3 } from './math.ts';
import { CLOSED_V, KNOTS_V, ORDER_V, SURFACE_COLS, TRIM_LOOPS, TRIM_NAMES, TRIM_UV, evaluate, normal, sampleTrimSegment, surfaceFromPrim, surfacePoint, surfaceTrims, trimBoundaryName, trimEdges } from './nurbssurface.ts';
import type { NurbsSurface, SurfaceUV } from './nurbssurface.ts';
import { KNOTS_ATTRIB, ORDER_ATTRIB, spanBreaks } from './splines.ts';

type UV = SurfaceUV;
type Band = { width: number; depth: number; rows: number; group: string };
type BandRules = { forName: (name: string) => Band[]; groups: string[] };
type Path<T> = { points: T[]; closed: boolean }; // A closed path repeats its first point, possibly across a period.
type Vertex = { uv: UV; depth: number; corner?: boolean; point?: Sample; grid?: number };
type Sample = { id: number; P: Vec3; src: Src; faceNormal?: Vec3 };
type Station = { uv: UV; direction: UV; scale: number; corner: boolean };
type Loop = { trim: Path<UV>; rings: Path<Vertex>[]; outer: Path<Vertex>; bands: Band[] };
type Options = { size: number; counts: readonly [number, number]; tolerance: number; bands: unknown };
const DOMAIN: UV[] = [[0, 0], [1, 0], [1, 1], [0, 1]];
const EPS = 1e-10;
const MAX_GRID = 1_000_000;
const MAX_ZIP_STATES = 4_000_000;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const mix = (a: UV, b: UV, t: number): UV => [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];
const delta = (a: UV, b: UV): UV => [a[0] - b[0], a[1] - b[1]];
const shift = (p: UV, d: UV): UV => [p[0] + d[0], p[1] + d[1]];
const orient = (a: UV, b: UV, c: UV) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const wrap = (u: number) => u - Math.floor(u);
const clamp = (t: number, min = 0, max = 1) => Math.max(min, Math.min(max, t));
const blend3 = (a: Vec3, b: Vec3, t: number): Vec3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const distanceToSegment = (p: Vec3, a: Vec3, b: Vec3) => {
  const d = sub(b, a), t = clamp(dot(sub(p, a), d) / (dot(d, d) || 1));
  return dist(p, blend3(a, b, t));
};

function faceCosine(points: readonly Vec3[], uv?: readonly UV[]) {
  let max = -1;
  for (let i = 0; i < points.length; i++) {
    const prev = (i + points.length - 1) % points.length, next = (i + 1) % points.length;
    if (uv && orient(uv[prev], uv[i], uv[next]) < 0) continue;
    const a = points[prev], b = points[i], c = points[next];
    const ax = a[0] - b[0], ay = a[1] - b[1], az = a[2] - b[2];
    const cx = c[0] - b[0], cy = c[1] - b[1], cz = c[2] - b[2];
    const product = (ax * ax + ay * ay + az * az) * (cx * cx + cy * cy + cz * cz);
    max = Math.max(max, product ? (ax * cx + ay * cy + az * cz) / Math.sqrt(product) : 1);
  }
  return max;
}
const THIN = Math.cos(Math.PI / 12);

function readBandList(value: unknown): Band[] {
  if (!Array.isArray(value)) throw new Error('Each band pattern needs a list. Use [] for no bands.');
  return value.map((item, i) => {
    const { width, depth = 0, rows = 1, group = `band${i}` } = item ?? {};
    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(depth) || !Number.isInteger(rows) || rows < 1 || rows > 1024 ||
      typeof group !== 'string' || !group.trim()) {
      throw new Error(`Band ${i} needs a positive width and a finite depth in metres, 1 to 1024 rows, and a group name.`);
    }
    return { width, depth, rows, group };
  });
}

function readBands(value: unknown): BandRules {
  if (Array.isArray(value)) {
    const bands = readBandList(value);
    return { forName: () => bands, groups: bands.map((band) => band.group) };
  }
  if (!value || typeof value !== 'object') throw new Error('Bands must be a list or an object mapping name patterns to lists. Use [] for no bands.');
  const rules = Object.entries(value).map(([key, list]) => ({
    pattern: new RegExp(`^${key.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 's'),
    bands: readBandList(list),
  }));
  return { forName: (name) => rules.find(({ pattern }) => pattern.test(name))?.bands ?? [],
    groups: [...new Set(rules.flatMap(({ bands }) => bands.map((band) => band.group)))] };
}

function upperBound(xs: ArrayLike<number>, x: number) {
  let lo = 0, hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (xs[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function arcMap(at: (t: number) => Vec3, ts: number[]) {
  const lengths = [0];
  let a = at(0);
  for (let i = 1; i < ts.length; i++) {
    const b = at(ts[i]);
    lengths.push(lengths[i - 1] + dist(a, b));
    a = b;
  }
  const length = lengths[lengths.length - 1];
  function lookup(x: number, from: number[], to: number[]) {
    const i = Math.min(from.length - 2, Math.max(0, upperBound(from, x) - 1));
    return lerp(to[i], to[i + 1], (x - from[i]) / (from[i + 1] - from[i] || 1));
  }
  return { length, parameter: (m: number) => lookup(m, lengths, ts), metres: (t: number) => lookup(t, ts, lengths) };
}

function axis(s: NurbsSurface, d: number, o: Options) {
  const spline = d ? s.v : s.u;
  const at = (t: number, other: number) => surfacePoint(s, d ? [other, t] : [t, other]);
  const breaks = spanBreaks(spline), ts: number[] = [];
  for (let i = 1; i < breaks.length; i++) {
    const n = Math.max(4, Math.ceil((breaks[i] - breaks[i - 1]) * 512));
    for (let k = 0; k < n; k++) ts.push(lerp(breaks[i - 1], breaks[i], k / n));
  }
  ts.push(1);
  const mid = arcMap((t) => at(t, 0.5), ts);
  const mean = Array.from({ length: 9 }, (_, k) => k === 4 ? mid.length : arcMap((t) => at(t, k / 8), ts).length)
    .reduce((a, b) => a + b, 0) / 9;
  const count = Math.max(spline.closed ? 3 : 1, o.counts[d] || Math.round(mean / o.size));
  if (count > MAX_GRID) throw gridLimit();
  const lines = Array.from({ length: count + 1 }, (_, i) => i === count ? 1 : mid.length > EPS ? mid.parameter(mid.length * i / count) : i / count);
  const metres = (t: number) => spline.closed ? Math.floor(t) * mid.length + mid.metres(wrap(t)) : mid.metres(t);
  return { lines, mean, metres };
}

const gridLimit = () => new RangeError('Surface mesh exceeds 1,000,000 grid faces. Use a larger size or tolerance, or lower counts.');

function refineGrid(s: NurbsSurface, u: number[], v: number[], tolerance: number) {
  const probes = (breaks: number[]) => [...new Set([...breaks, ...Array.from({ length: 17 }, (_, k) => k / 16)])];
  const alongU = probes(spanBreaks(s.v)), alongV = probes(spanBreaks(s.u));
  for (let pass = 0; pass < 16; pass++) {
    const nu = u.length - 1, nv = v.length - 1;
    if (nu * nv > MAX_GRID) throw gridLimit();
    const splitU = new Uint8Array(nu), splitV = new Uint8Array(nv);
    function chord(lines: number[], split: Uint8Array, across: number[], at: (t: number, q: number) => Vec3) {
      for (const q of across) {
        let a = at(lines[0], q);
        for (let i = 0; i < split.length; i++) {
          const b = at(lines[i + 1], q);
          if (!split[i] && dist(at((lines[i] + lines[i + 1]) / 2, q), blend3(a, b, 0.5)) > tolerance / 2) split[i] = 1;
          a = b;
        }
      }
    }
    chord(u, splitU, alongU, (x, y) => surfacePoint(s, [x, y]));
    chord(v, splitV, alongV, (y, x) => surfacePoint(s, [x, y]));
    if (!splitU.includes(1) && !splitV.includes(1)) {
      // Test both possible diagonals of every quad with just two rows of positions in memory.
      let lower = u.map((x) => surfacePoint(s, [x, v[0]]));
      for (let j = 0; j < nv; j++) {
        const upper = u.map((x) => surfacePoint(s, [x, v[j + 1]]));
        for (let i = 0; i < nu; i++) {
          if (splitU[i] || splitV[j]) continue;
          const p = surfacePoint(s, [(u[i] + u[i + 1]) / 2, (v[j] + v[j + 1]) / 2]);
          if (dist(p, blend3(lower[i], upper[i + 1], 0.5)) > tolerance ||
              dist(p, blend3(lower[i + 1], upper[i], 0.5)) > tolerance) {
            splitU[i] = 1; splitV[j] = 1;
          }
        }
        lower = upper;
      }
      if (!splitU.includes(1) && !splitV.includes(1)) return;
    }
    for (const [lines, split] of [[u, splitU], [v, splitV]] as const) {
      const next = lines.flatMap((x, i) => split[i] ? [x, (x + lines[i + 1]) / 2] : [x]);
      lines.length = 0;
      for (const x of next) lines.push(x);
    }
  }
  throw new RangeError('Cannot refine the grid within tolerance. Use a larger tolerance.');
}

type Edge = { a: UV; b: UV; name?: string };

function key(s: NurbsSurface, p: UV) {
  const unit = Math.round(1 / EPS);
  const index = (x: number, closed: boolean) => Math.round((closed ? wrap(x) : x) / EPS) % (closed ? unit : Infinity);
  return `${index(p[0], s.u.closed)},${index(p[1], s.v.closed)}`;
}

function paths(s: NurbsSurface, edges: Edge[]): Path<UV>[] {
  const next = new Map<string, Edge[]>();
  const incoming = new Set<string>();
  for (const e of edges) {
    const k = key(s, e.a), list = next.get(k) ?? [];
    list.push(e); next.set(k, list); incoming.add(key(s, e.b));
  }
  const out: (Path<UV> & { name?: string })[] = [];
  // Start open chains at the natural edge, then walk the remaining closed boundaries.
  for (const start of [...[...next.keys()].filter((k) => !incoming.has(k)), ...next.keys()]) {
    const list = next.get(start)!;
    while (list.length) {
      let e: Edge | undefined = list.pop()!;
      const points = [e.a];
      const lengths = new Map<string, number>();
      let closed = false;
      while (e) {
        if (e.name !== undefined) lengths.set(e.name, (lengths.get(e.name) ?? 0) + dist(surfacePoint(s, e.a), surfacePoint(s, e.b)));
        points.push(shift(points[points.length - 1], delta(e.b, e.a)));
        const to = key(s, e.b);
        if (to === start) { closed = true; break; }
        e = next.get(to)?.pop();
      }
      const name = [...lengths].sort((a, b) => b[1] - a[1])[0]?.[0];
      out.push({ points, closed, name });
    }
  }
  return out;
}

function trimPaths(s: NurbsSurface, region: UV[][], stored: UV[][], names: string[]) {
  const sources = names.map((name, i) => ({ name, loops: [stored[i]] }));
  const edges = region.flatMap((loop): Edge[] => {
    const edges = trimEdges(loop);
    if (!names.some(Boolean)) return edges;
    const name = trimBoundaryName(s, edges, sources);
    return edges.map((edge) => ({ ...edge, name }));
  });
  const domainAxis = ({ a, b }: Edge) => [0, 1].find((d) => a[d] === b[d] && (a[d] === 0 || a[d] === 1));
  const periodic = [s.u.closed, s.v.closed];
  const seamEnds = periodic.map((closed, d) => !closed ? [] : [...new Set(edges.filter((e) => domainAxis(e) === d)
    .flatMap(({ a, b }) => [a[1 - d], b[1 - d]]))].sort((a, b) => a - b));
  const regular: Edge[] = [], seams = new Map<string, Edge>();
  for (const e of edges) {
    const d = domainAxis(e);
    if (d === undefined) { regular.push(e); continue; }
    if (!periodic[d]) continue;
    const along = 1 - d, from = e.a[along], to = e.b[along];
    const between = seamEnds[d].filter((x) => x > Math.min(from, to) && x < Math.max(from, to));
    if (from > to) between.reverse();
    const stops = [e.a, ...between.map((x) => d ? [x, e.a[1]] as UV : [e.a[0], x] as UV), e.b];
    for (let i = 1; i < stops.length; i++) {
      const a = stops[i - 1], b = stops[i], tag = `${d}:${a[along]},${b[along]}`, rev = `${d}:${b[along]},${a[along]}`;
      if (!seams.delete(rev)) seams.set(tag, { a, b });
    }
  }
  return paths(s, [...regular, ...seams.values()]);
}

function addPeriodic(s: NurbsSurface, loop: UV[], out: UV[][]) {
  const shifts = (d: number, closed: boolean) => {
    if (!closed) return [0];
    let low = Infinity, high = -Infinity;
    for (const p of loop) { low = Math.min(low, p[d]); high = Math.max(high, p[d]); }
    const from = Math.ceil(-high), to = Math.floor(1 - low);
    return Array.from({ length: to - from + 1 }, (_, i) => from + i);
  };
  for (const u of shifts(0, s.u.closed)) for (const v of shifts(1, s.v.closed)) out.push(loop.map((p) => shift(p, [u, v])));
}

function stations(s: NurbsSurface, path: Path<UV>, o: Options, width: number): Station[] {
  const original = path.points;
  const uv = original.slice(0, -1).flatMap((a, i) => [a, ...sampleTrimSegment(s, a, original[i + 1], o.tolerance / 8)]);
  uv.push(original[original.length - 1]);
  const p = uv.map((q) => surfacePoint(s, q)), length = [0];
  for (let i = 1; i < p.length; i++) length.push(length[i - 1] + dist(p[i], p[i - 1]));
  const end = p.length - 1, total = length[end];
  if (!(total > EPS)) return [];
  const edge = (i: number) => delta(uv[i + 1], uv[i]);
  const corners: number[] = [];
  for (let i = path.closed ? 0 : 1; i < end; i++) {
    const prev = (i + end - 1) % end;
    const a = normalize(sub(p[prev + 1], p[prev])), b = normalize(sub(p[i + 1], p[i]));
    const turn = Math.acos(clamp(dot(a, b), -1, 1));
    if (turn > Math.PI / 6) corners.push(i);
  }
  const cuts = [0, ...corners.filter((i) => i > 0), end];
  const at = (m: number): UV => {
    const lap = path.closed ? Math.floor(m / total) : 0;
    m = clamp(m - lap * total, 0, total);
    const i = Math.min(end - 1, upperBound(length, m) - 1);
    const q = mix(uv[i], uv[i + 1], (m - length[i]) / (length[i + 1] - length[i] || 1));
    return shift(q, [lap * (uv[end][0] - uv[0][0]), lap * (uv[end][1] - uv[0][1])]);
  };
  const chosen: number[] = [0];
  function keep(a: number, b: number, depth: number) {
    const x = surfacePoint(s, at(a)), y = surfacePoint(s, at(b));
    let split = (a + b) / 2, error = distanceToSegment(surfacePoint(s, at(split)), x, y);
    const i = upperBound(length, a + EPS);
    for (let j = i; j < end && length[j] < b - EPS; j++) {
      const d = distanceToSegment(p[j], x, y);
      if (d > error) { error = d; split = length[j]; }
    }
    if (error > o.tolerance * 0.7 && depth < 20) { keep(a, split, depth + 1); keep(split, b, depth + 1); }
    else chosen.push(b);
  }
  for (let i = 1; i < cuts.length; i++) {
    const a = length[cuts[i - 1]], b = length[cuts[i]];
    const spacing = path.closed ? Math.min(total / 4, o.size) : o.size;
    const n = Math.max(1, Math.round((b - a) / spacing));
    if (n > MAX_GRID) throw gridLimit();
    for (let k = 0; k < n; k++) keep(lerp(a, b, k / n), k + 1 === n ? b : lerp(a, b, (k + 1) / n), 0);
  }
  const cornerAt = new Map(corners.map((i) => [length[i], i]));
  const out: Station[] = [];
  const add = (m: number, incoming: UV, outgoing: UV, corner: boolean) => {
    const q = at(m), e = evaluate(s, q[0], q[1], 1);
    const tangent = ([du, dv]: UV) => normalize(e.Su.map((u, k) => u * du + e.Sv[k] * dv) as Vec3);
    const n = normal(s, q[0], q[1], e), a = tangent(incoming), b = tangent(outgoing);
    const turn = Math.atan2(dot(n, cross(a, b)), dot(a, b)), left = cross(n, a);
    const uu = dot(e.Su, e.Su), vv = dot(e.Sv, e.Sv), uv = dot(e.Su, e.Sv), det = uu * vv - uv * uv;
    const fan = corner && width > 0 && turn < -2 * Math.PI / 3 - EPS;
    // A sharp convex turn shares one cut point. Four sectors keep the apex angles above 30 degrees.
    const count = fan ? 5 : 1;
    for (let i = 0; i < count; i++) {
      const radians = turn * (fan ? i / 4 : 0.5);
      const direction3 = left.map((x, k) => x * Math.cos(radians) - a[k] * Math.sin(radians)) as Vec3;
      const u = dot(direction3, e.Su), v = dot(direction3, e.Sv);
      let direction: UV = det > 0 ? [(vv * u - uv * v) / det, (uu * v - uv * u) / det] : [0, 0];
      if (!path.closed && (m === 0 || m === total)) {
        if (!s.u.closed && (q[0] < EPS || q[0] > 1 - EPS)) direction = [0, Math.sign(direction[1]) / Math.sqrt(vv)];
        if (!s.v.closed && (q[1] < EPS || q[1] > 1 - EPS)) direction = [Math.sign(direction[0]) / Math.sqrt(uu), 0];
      }
      out.push({ uv: q, direction, scale: corner && !fan ? 1 / Math.cos(turn / 2) : 1, corner: corner && (!fan || i === 2) });
    }
  };
  const selected = path.closed ? chosen.slice(0, -1) : chosen;
  const step = Math.max(EPS, Math.min(o.size * 0.01, total * 0.0001));
  for (const m of selected) {
    const i = cornerAt.get(m);
    if (i !== undefined) {
      add(m, edge((i + end - 1) % end), edge(i), true);
    } else {
      const a = delta(at(m), at(m - step)), b = delta(at(m + step), at(m));
      add(m, m === 0 && !path.closed ? b : a, m === total && !path.closed ? a : b, false);
    }
  }
  if (path.closed) out.push({ ...out[0], uv: shift(out[0].uv, delta(uv[end], uv[0])) });
  return out;
}

function offset(s: NurbsSurface, station: Station, width: number): UV {
  const { uv, direction, scale } = station;
  const target = width * scale;
  if (!target) return uv;
  const a = surfacePoint(s, uv);
  let t = target;
  for (let i = 0; i < 20; i++) {
    const q = shift(uv, [direction[0] * t, direction[1] * t]);
    if ((!s.u.closed && (q[0] < -EPS || q[0] > 1 + EPS)) || (!s.v.closed && (q[1] < -EPS || q[1] > 1 + EPS))) {
      throw new Error('A band runs past the surface edge. Make the bands narrower or move the opening away from the edge.');
    }
    const d = dist(a, surfacePoint(s, q));
    if (Math.abs(d - target) <= 1e-8) return q;
    if (!(d > 0)) break;
    t *= clamp(target / d, 0.5, 2);
  }
  throw new Error('Cannot fit a band to the surface at its requested width. Make the bands narrower.');
}

function intersection(a: UV, b: UV, c: UV, d: UV): UV | null {
  const x = delta(b, a), y = delta(d, c), q = delta(c, a);
  const det = orient([0, 0], x, y);
  if (!det) return null;
  const u = orient([0, 0], q, y) / det, v = orient([0, 0], q, x) / det;
  return u >= 0 && u <= 1 && v >= 0 && v <= 1 ? mix(a, b, u) : null;
}

function mergeCorners(path: Path<Vertex>) {
  const vs = path.points, end = vs.length - 1;
  // Clip the small backtracking loops where an inward offset overtakes the neighbouring stations.
  for (let i = 0; i < end; i++) for (let j = i + 2; j < end; j++) {
    if (vs[i] === vs[i + 1] || vs[j] === vs[j + 1] || (path.closed && i === 0 && j === end - 1)) continue;
    const q = intersection(vs[i].uv, vs[i + 1].uv, vs[j].uv, vs[j + 1].uv);
    if (!q) continue;
    const last = j - i < end / 2 || !path.closed;
    const merged = { uv: q, depth: vs[i].depth, corner: true };
    if (last) for (let k = i + 1; k <= j; k++) vs[k] = merged;
    else {
      for (let k = 0; k <= i; k++) vs[k] = merged;
      for (let k = j + 1; k <= end; k++) vs[k] = merged;
    }
  }
}

function makeLoops(s: NurbsSurface, trims: (Path<UV> & { name?: string })[], o: Options, rules: BandRules) {
  let faces = 0;
  return trims.flatMap((trim): Loop[] => {
    const bands = rules.forName(trim.name ?? '');
    const depth = bands.reduce((sum, b) => sum + b.depth, 0);
    const width = bands.reduce((sum, b) => sum + b.width, 0);
    const rows = bands.reduce((sum, b) => sum + b.rows, 0);
    const st = stations(s, trim, o, width);
    if (!st.length) return [];
    faces += rows * (st.length - 1);
    if (faces > MAX_GRID) throw new RangeError('Surface mesh exceeds 1,000,000 band faces. Use fewer rows or a larger size or tolerance.');
    function ring(w: number, d: number): Path<Vertex> {
      const points: Vertex[] = [];
      for (const p of st) {
        const prev = points[points.length - 1];
        if (prev && !w && p.uv === prev.uv) {
          prev.corner ||= p.corner;
          points.push(prev);
        } else points.push({ uv: offset(s, p, w), depth: d, corner: p.corner });
      }
      if (trim.closed) {
        const period = delta(st[st.length - 1].uv, st[0].uv);
        if (Math.hypot(...period) < EPS) points[points.length - 1] = points[0];
      }
      const path = { points, closed: trim.closed };
      if (w) mergeCorners(path);
      return path;
    }
    let w = 0, d = depth;
    const rings = [ring(w, d)];
    for (const b of bands) {
      for (let row = 1; row <= b.rows; row++) {
        const last = b === bands[bands.length - 1] && row === b.rows;
        rings.push(ring(w + b.width * row / b.rows, last ? 0 : d - b.depth * row / b.rows));
      }
      w += b.width; d -= b.depth;
    }
    return [{ trim, rings, outer: rings[rings.length - 1], bands }];
  });
}

function rowFill(region: UV[][], y: number) {
  const xs: { x: number; sign: number }[] = [];
  for (const loop of region) for (let k = 0; k < loop.length; k++) {
    const a = loop[k], b = loop[(k + 1) % loop.length];
    if ((a[1] > y) === (b[1] > y)) continue;
    xs.push({ x: lerp(a[0], b[0], (y - a[1]) / (b[1] - a[1])), sign: a[1] > b[1] ? 1 : -1 });
  }
  return xs.sort((a, b) => a.x - b.x);
}

function afterBands(s: NurbsSurface, region: UV[][], loops: Loop[]): UV[][] {
  if (loops.every((loop) => loop.rings.length === 1)) return region;
  const strips = loops.map(({ rings, outer }) => {
    const a = rings[0].points, b = outer.points, polygons: UV[][] = [];
    for (let i = 1; i < b.length; i++) addPeriodic(s, [a[i - 1].uv, a[i].uv, b[i].uv, b[i - 1].uv], polygons);
    return polygons;
  });
  const sections = strips.map((polys) => crossSection(polys, 'Positive'));
  try {
    for (let i = 0; i < sections.length; i++) for (let j = i + 1; j < sections.length; j++) {
      const overlap = sections[i].intersect(sections[j]);
      const hit = !overlap.isEmpty();
      overlap.delete();
      if (!hit) continue;
      const p = loops[i].rings[0].points.map(({ uv }) => surfacePoint(s, uv));
      const q = loops[j].rings[0].points.map(({ uv }) => surfacePoint(s, uv));
      let gap = Infinity;
      for (const [from, to] of [[p, q], [q, p]]) for (const a of from)
        for (let k = 1; k < to.length; k++) gap = Math.min(gap, distanceToSegment(a, to[k - 1], to[k]));
      throw new Error(`Bands for trim loops ${i + 1} and ${j + 1} overlap. The gap is ${gap.toPrecision(3)} m. Make the bands narrower or move the openings further apart.`);
    }
    const inside = crossSection(region, 'Positive'), bands = crossSection(strips.flat(), 'Positive');
    const remaining = inside.subtract(bands);
    try { return remaining.toPolygons() as UV[][]; }
    finally { inside.delete(); bands.delete(); remaining.delete(); }
  } finally {
    for (const section of sections) section.delete();
  }
}

function gridCells(s: NurbsSurface, u: number[], v: number[], region: UV[][], loops: Loop[], scales: UV, gap: number) {
  const nu = u.length - 1, nv = v.length - 1, keep = new Uint8Array(nu * nv);
  const outlines: UV[][] = [];
  for (const loop of loops) addPeriodic(s, loop.outer.points.map((p) => p.uv), outlines);
  region = afterBands(s, region, loops);
  for (let j = 0; j < nv; j++) {
    const scan = rowFill(region, (v[j] + v[j + 1]) / 2);
    let winding = 0, k = 0;
    for (let i = 0; i < nu; i++) {
      const x = (u[i] + u[i + 1]) / 2;
      while (k < scan.length && scan[k].x <= x) winding += scan[k++].sign;
      keep[j * nu + i] = Number(winding > 0);
    }
  }
  // Measure clearance in the local tangent plane of each short ring segment.
  for (const outline of outlines) for (let k = 1; k < outline.length; k++) {
    const a = outline[k - 1], b = outline[k], [x, y] = mix(a, b, 0.5);
    const { Su, Sv } = evaluate(s, x, y, 1);
    const uu = Math.hypot(...Su), uv = uu > EPS ? dot(Su, Sv) / uu : 0;
    const vv = Math.sqrt(Math.max(0, dot(Sv, Sv) - uv * uv));
    const valid = uu > EPS && vv > EPS;
    const margin: UV = valid ? [gap / uu * Math.hypot(1, uv / vv), gap / vv] :
      [gap / Math.max(scales[0], EPS), gap / Math.max(scales[1], EPS)];
    const metric = ([u, v]: UV): Vec3 => valid ?
      [uu * (u - a[0]) + uv * (v - a[1]), vv * (v - a[1]), 0] :
      [scales[0] * (u - a[0]), scales[1] * (v - a[1]), 0];
    const A = metric(a), B = metric(b);
    const i0 = Math.max(0, upperBound(u, Math.min(a[0], b[0]) - margin[0]) - 1);
    const j0 = Math.max(0, upperBound(v, Math.min(a[1], b[1]) - margin[1]) - 1);
    const i1 = Math.min(nu, upperBound(u, Math.max(a[0], b[0]) + margin[0]));
    const j1 = Math.min(nv, upperBound(v, Math.max(a[1], b[1]) + margin[1]));
    for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) {
      const id = j * nu + i;
      if (!keep[id]) continue;
      const inCell = ([x, y]: UV) => x >= u[i] && x <= u[i + 1] && y >= v[j] && y <= v[j + 1];
      const corners: UV[] = [[u[i], v[j]], [u[i + 1], v[j]], [u[i + 1], v[j + 1]], [u[i], v[j + 1]]];
      const p = corners.map(metric);
      const near = inCell(a) || inCell(b) || corners.some((c, k) => {
        const next = (k + 1) % 4;
        return intersection(a, b, c, corners[next]) || distanceToSegment(p[k], A, B) <= gap ||
          distanceToSegment(A, p[k], p[next]) <= gap || distanceToSegment(B, p[k], p[next]) <= gap;
      });
      if (near) keep[id] = 0;
    }
  }
  return keep;
}

function gridPaths(s: NurbsSurface, u: number[], v: number[], cells: Uint8Array) {
  const nu = u.length - 1, nv = v.length - 1, edges: Edge[] = [];
  const removed = (i: number, j: number) => {
    if (s.u.closed) i = (i + nu) % nu;
    if (s.v.closed) j = (j + nv) % nv;
    return i >= 0 && i < nu && j >= 0 && j < nv && !cells[j * nu + i];
  };
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) if (cells[j * nu + i]) {
    const a: UV = [u[i], v[j]], b: UV = [u[i + 1], v[j]], c: UV = [u[i + 1], v[j + 1]], d: UV = [u[i], v[j + 1]];
    if (removed(i, j - 1)) edges.push({ a, b });
    if (removed(i + 1, j)) edges.push({ a: b, b: c });
    if (removed(i, j + 1)) edges.push({ a: c, b: d });
    if (removed(i - 1, j)) edges.push({ a: d, b: a });
  }
  return paths(s, edges);
}

function compactPath(path: Path<Vertex>): Path<Vertex> {
  const points = path.points.filter((p, i, array) => !i || p !== array[i - 1]);
  return { points, closed: path.closed };
}

function nearest(s: NurbsSurface, a: Path<Vertex>, b: Path<Vertex>, scale: UV) {
  let best = Infinity, i = 0, j = 0, shiftBy: UV = [0, 0];
  const na = a.closed ? a.points.length - 1 : 1, nb = b.closed ? b.points.length - 1 : 1;
  for (let x = 0; x < na; x++) for (let y = 0; y < nb; y++) {
    const [u, v] = delta(a.points[x].uv, b.points[y].uv);
    const du = s.u.closed ? Math.round(u) : 0, dv = s.v.closed ? Math.round(v) : 0;
    const d = ((u - du) * scale[0]) ** 2 + ((v - dv) * scale[1]) ** 2;
    if (d < best) { best = d; i = x; j = y; shiftBy = [du, dv]; }
  }
  return { best, i, j, shiftBy };
}

function rotate(path: Path<Vertex>, i: number, by: UV): Vertex[] {
  const a = path.points, end = a.length - 1, period = delta(a[end].uv, a[0].uv);
  return Array.from({ length: a.length }, (_, k) => {
    let j = i + k, d = by;
    if (j > end) { j -= end; d = shift(by, period); }
    return { ...a[j], uv: shift(a[j].uv, d) };
  });
}

function zip(grid: Vertex[], ring: Vertex[], scale: UV, size: number): Vertex[][] | null {
  const m = grid.length, n = ring.length;
  if (m === 1 && n === 1) return [];
  if (m * n > MAX_ZIP_STATES) throw new RangeError('The transition has too many stations. Use a larger size or tolerance.');
  const cost = new Float64Array(m * n).fill(Infinity), step = new Uint8Array(m * n);
  const thin = new Uint32Array(m * n);
  const gp = grid.map((v) => v.point!.P), rp = ring.map((v) => v.point!.P);
  const linkCost = (a: UV, b: UV) => (((a[0] - b[0]) * scale[0]) ** 2 + ((a[1] - b[1]) * scale[1]) ** 2) / (size * size);
  const positive = (a: UV, b: UV, c: UV) => orient(a, b, c) > 1e-16;
  cost[0] = 0;
  // Walk both frontiers in order. Minimize thin faces first, then prefer short links and well-shaped quads.
  for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) {
    const k = i * n + j, score = cost[k];
    if (!Number.isFinite(score)) continue;
    const a = grid[i].uv, b = ring[j].uv, c = ring[j + 1]?.uv, d = grid[i + 1]?.uv;
    const gridOK = d && positive(a, b, d), ringOK = c && positive(a, b, c);
    const offer = (to: number, advance: number, p: UV, q: UV, cosine: number) => {
      const count = thin[k] + Number(cosine > THIN);
      const next = score + linkCost(p, q) + (advance === 3 ? 0 : 3) + 8 * Math.max(0, cosine - 0.7071);
      if (!step[to] || count < thin[to] || (count === thin[to] && next < cost[to])) {
        cost[to] = next; step[to] = advance; thin[to] = count;
      }
    };
    if (gridOK) offer(k + n, 1, d, b, faceCosine([gp[i], rp[j], gp[i + 1]]));
    if (ringOK) offer(k + 1, 2, a, c, faceCosine([gp[i], rp[j], rp[j + 1]]));
    if (c && d && ((gridOK && positive(d, b, c)) || (ringOK && positive(a, c, d)))) {
      offer(k + n + 1, 3, d, c, faceCosine([gp[i], rp[j], rp[j + 1], gp[i + 1]], [a, b, c, d]));
    }
  }
  if (!step[step.length - 1]) return null;
  const faces: Vertex[][] = [];
  let i = m - 1, j = n - 1;
  while (i || j) {
    const advance = step[i * n + j], x = i - (advance & 1), y = j - (advance >> 1);
    faces.push([grid[x], ring[y], ...(j > y ? [ring[j]] : []), ...(i > x ? [grid[i]] : [])]);
    i = x; j = y;
  }
  return faces.reverse();
}

function closestGrid(grid: Vertex[], corner: Vertex) {
  let nearest = 0, best = Infinity;
  for (let i = 0; i < grid.length; i++) {
    const d = dist(grid[i].point!.P, corner.point!.P);
    if (d < best) { best = d; nearest = i; }
  }
  return nearest;
}

function zipRuns(grid: Vertex[], ring: Vertex[], scale: UV, size: number) {
  let a = 0, b = 0;
  const faces: Vertex[][] = [];
  for (let j = 1; j < ring.length; j++) {
    const last = j === ring.length - 1;
    if (!last && !ring[j].corner) continue;
    const i = last ? grid.length - 1 : closestGrid(grid, ring[j]);
    if (i < a) return null;
    const run = zip(grid.slice(a, i + 1), ring.slice(b, j + 1), scale, size);
    if (!run) return null;
    for (const face of run) faces.push(face);
    a = i; b = j;
  }
  return faces;
}

type PlacedPath = { path: Path<Vertex>; by: UV };
type TransitionGroup = { borders: PlacedPath[]; rings: PlacedPath[]; winding: boolean };

/** Associate the paths with the removed cells they bound, unwrapping across a periodic seam as needed. */
function transitionGroups(s: NurbsSurface, u: number[], v: number[], cells: Uint8Array,
  borders: Path<Vertex>[], rings: Path<Vertex>[]) {
  const nu = u.length - 1, nv = v.length - 1;
  const owner = new Int32Array(cells.length).fill(-1);
  const tileU = new Int32Array(cells.length), tileV = new Int32Array(cells.length);
  const groups: TransitionGroup[] = [];

  function collect(start: number) {
    const index = groups.length, group: TransitionGroup = { borders: [], rings: [], winding: false };
    groups.push(group);
    const pending = [start];
    owner[start] = index;
    while (pending.length) {
      const a = pending.pop()!, i = a % nu, j = Math.floor(a / nu);
      for (const [x, y] of [[i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1]]) {
        const du = Math.floor(x / nu), dv = Math.floor(y / nv);
        if ((du && !s.u.closed) || (dv && !s.v.closed)) continue;
        const b = (y - dv * nv) * nu + x - du * nu;
        if (cells[b]) continue;
        const bu = tileU[a] + du, bv = tileV[a] + dv;
        if (owner[b] >= 0) {
          group.winding ||= tileU[b] !== bu || tileV[b] !== bv;
          continue;
        }
        owner[b] = index; tileU[b] = bu; tileV[b] = bv;
        pending.push(b);
      }
    }
  }

  for (const [kind, paths] of [['borders', borders], ['rings', rings]] as const) for (const path of paths) {
    for (let k = 1; k < path.points.length; k++) {
      const a = path.points[k - 1].uv, b = path.points[k].uv, [dx, dy] = delta(b, a);
      const length = Math.hypot(dx, dy);
      if (length < EPS) continue;
      // The removed cell is on the right of a directed grid boundary.
      const step = kind === 'borders' ? EPS * 8 / length : 0;
      const [x, y] = shift(mix(a, b, 0.5), [dy * step, -dx * step]);
      const du = s.u.closed ? Math.floor(x) : 0, dv = s.v.closed ? Math.floor(y) : 0;
      const i = upperBound(u, x - du) - 1, j = upperBound(v, y - dv) - 1;
      if (i < 0 || i >= nu || j < 0 || j >= nv || cells[j * nu + i]) continue;
      const id = j * nu + i;
      if (owner[id] < 0) collect(id);
      groups[owner[id]][kind].push({ path, by: [tileU[id] - du, tileV[id] - dv] });
      break;
    }
  }
  return groups;
}

/** Close any open paths along the natural edge, where the transition has no adjacent face. */
function transitionContours(s: NurbsSurface, group: TransitionGroup, gridAt: (p: UV) => Vertex) {
  const contours: Vertex[][] = [], open: Vertex[][] = [];
  for (const [paths, reverse] of [[group.borders, true], [group.rings, false]] as const) for (const { path, by } of paths) {
    const points = path.points.map((p) => ({ ...p, uv: shift(p.uv, by) }));
    if (path.closed) points.pop();
    if (reverse) points.reverse();
    (path.closed ? contours : open).push(points);
  }

  const perimeter = ([u, v]: UV): [number, number] => {
    if (s.u.closed) return [Math.round(v), v < 0.5 ? u : -u];
    if (s.v.closed) return [Math.round(u), u < 0.5 ? -v : v];
    return [0, v <= EPS ? u : u >= 1 - EPS ? 1 + v : v >= 1 - EPS ? 3 - u : 4 - v];
  };
  const endpoints = open.flatMap((points, i) => [points[0], points[points.length - 1]].map(({ uv }, k) => {
    const [edge, position] = perimeter(uv);
    return { edge, position, i, start: k === 0 };
  })).sort((a, b) => a.edge - b.edge || a.position - b.position || Number(a.start) - Number(b.start));
  const next = new Map<number, { i: number; corners: Vertex[] }>();
  for (let k = 0; k < endpoints.length; k++) {
    const a = endpoints[k], b = endpoints[(k + 1) % endpoints.length];
    if (a.start) continue;
    if (!b.start || a.edge !== b.edge) return null;
    const wrap = b.position < a.position;
    if (wrap && (s.u.closed || s.v.closed)) return null;
    const corners: Vertex[] = [];
    for (let t = Math.floor(a.position + EPS) + 1; !s.u.closed && !s.v.closed && t < b.position + (wrap ? 4 : 0) - EPS; t++) {
      corners.push(gridAt(DOMAIN[t % 4]));
    }
    next.set(a.i, { i: b.i, corners });
  }
  for (const first of next.keys()) {
    const contour: Vertex[] = [];
    let i = first;
    do {
      const to = next.get(i);
      if (!to) return null;
      for (const point of open[i]) contour.push(point);
      contour.push(...to.corners);
      next.delete(i);
      i = to.i;
    } while (i !== first);
    contours.push(contour);
  }
  return contours;
}

function triangulateTransition(contours: Vertex[][], scale: UV, sample: (v: Vertex) => Sample) {
  const vertices = contours.flat(), positions = vertices.map((v) => sample(v).P);
  const uv = vertices.map((v) => v.uv);
  const triangles = M().triangulate(contours.map((path) => path.map(({ uv: [u, v] }) => [u * scale[0], v * scale[1]])), -1, false) as number[][];
  const cosine = (face: number[]) => faceCosine(face.map((i) => positions[i]), face.length === 4 ? face.map((i) => uv[i]) : undefined);
  const edgeKey = (a: number, b: number) => Math.min(a, b) * vertices.length + Math.max(a, b);
  const sides = (t: number[]) => t.map((a, k) => edgeKey(a, t[(k + 1) % 3]));
  const links = new Map<number, Set<number>>();
  const link = (i: number) => {
    for (const key of sides(triangles[i])) {
      const set = links.get(key) ?? new Set<number>();
      set.add(i); links.set(key, set);
    }
  };
  const scores = triangles.map(cosine);
  triangles.forEach((_, i) => link(i));
  function quad(key: number) {
    const set = links.get(key);
    if (!set || set.size !== 2) return null;
    const [i, j] = set, t = triangles[i], q = triangles[j];
    const k = sides(t).indexOf(key), a = t[k], b = t[(k + 1) % 3], c = t[(k + 2) % 3];
    const d = q.find((x) => x !== a && x !== b)!;
    return { i, j, a, b, c, d };
  }
  // Improve the worst world-space angle with interior flips, leaving all boundary edges in place.
  const pending = [...links.keys()];
  for (let budget = 12 * triangles.length + 64; pending.length && budget > 0; budget--) {
    const key = pending.pop()!, pair = quad(key);
    if (!pair) continue;
    const { i, j, a, b, c, d } = pair;
    if (orient(uv[a], uv[d], uv[c]) <= 0 || orient(uv[d], uv[b], uv[c]) <= 0) continue;
    const x = [a, d, c], y = [d, b, c], sx = cosine(x), sy = cosine(y);
    if (Math.max(sx, sy) >= Math.max(scores[i], scores[j]) - 1e-10) continue;
    for (const k of [i, j]) for (const side of sides(triangles[k])) links.get(side)!.delete(k);
    triangles[i] = x; triangles[j] = y; scores[i] = sx; scores[j] = sy;
    link(i); link(j);
    pending.push(...sides(x), ...sides(y));
  }

  const candidates = [...links.keys()].flatMap((key) => {
    const pair = quad(key);
    if (!pair) return [];
    const { i, j, a, b, c, d } = pair;
    const face = [a, d, b, c], score = cosine(face);
    const saved = Number(scores[i] > THIN) + Number(scores[j] > THIN) - Number(score > THIN);
    return saved < 0 ? [] : [{ i, j, face, score, saved }];
  }).sort((a, b) => b.saved - a.saved || a.score - b.score);
  const used = new Uint8Array(triangles.length), faces: number[][] = [];
  for (const { i, j, face } of candidates) if (!used[i] && !used[j]) {
    used[i] = used[j] = 1;
    faces.push(face);
  }
  triangles.forEach((face, i) => { if (!used[i]) faces.push(face); });
  return faces.map((face) => face.map((i) => vertices[i]));
}

function transitionError(prim: number, rings: number, borders: number) {
  return new Error(`Surface prim ${prim} has ${rings} trim paths and ${borders} matching grid boundaries. Use a smaller size, increase counts, or make the bands narrower.`);
}

function appendMesh(b: GeoBuilder, src: Geometry, prim: number, s: NurbsSurface, o: Options, rules: BandRules, stats: MeshStats) {
  const au = axis(s, 0, o), av = axis(s, 1, o), u = au.lines, v = av.lines, scale: UV = [au.mean, av.mean];
  refineGrid(s, u, v, o.tolerance);
  const nu = u.length - 1, nv = v.length - 1, cols = nu + Number(!s.u.closed);
  const names: string[] = [], stored = surfaceTrims(src, prim, names);
  let region = [DOMAIN];
  if (stored) {
    const positive = crossSection(stored, 'Positive'), domain = crossSection([DOMAIN], 'Positive');
    const kept = positive.intersect(domain);
    try { region = kept.toPolygons() as UV[][]; }
    finally { positive.delete(); domain.delete(); kept.delete(); }
  }
  const loops = stored ? makeLoops(s, trimPaths(s, region, stored, names), o, rules) : [];
  const cells = stored ? gridCells(s, u, v, region, loops, scale, o.size * 0.35) : null;
  const borders = cells ? gridPaths(s, u, v, cells) : [];

  const index = (axis: number[], t: number, closed: boolean) => {
    if (closed && Math.abs(t - Math.round(t)) < EPS) return 0;
    if (closed) t = wrap(t);
    const i = Math.min(axis.length - 1, upperBound(axis, t));
    return i && Math.abs(axis[i - 1] - t) < Math.abs(axis[i] - t) ? i - 1 : i;
  };
  const gridAt = (p: UV, i = index(u, p[0], s.u.closed), j = index(v, p[1], s.v.closed)): Vertex =>
    ({ uv: p, depth: 0, grid: j * cols + i });
  const gridBorders = borders.map(({ points, closed }) => ({ points: points.map((p) => gridAt(p)), closed }));
  const rings = loops.map((loop) => compactPath(loop.outer));
  const direct = new Map<Path<Vertex>, Path<Vertex>>(), shared = new Set<Path<Vertex>>();
  const sharedGroups: TransitionGroup[] = [];
  const groups = cells && (borders.length !== loops.length || loops.length > 1)
    ? transitionGroups(s, u, v, cells, gridBorders, rings) : [];
  if (borders.length !== loops.length || groups.some(({ rings }) => rings.length > 1)) {
    let usedBorders = 0, usedRings = 0;
    for (const { borders, rings, winding } of groups) {
      usedBorders += borders.length;
      usedRings += rings.length;
      if (borders.length === 1 && rings.length === 1 && borders[0].path.closed === rings[0].path.closed) {
        direct.set(rings[0].path, borders[0].path);
      } else if (borders.length && rings.length > 1 && !winding) {
        for (const { path } of rings) shared.add(path);
        sharedGroups.push({ borders, rings, winding });
      } else throw transitionError(prim, loops.length, gridBorders.length);
    }
    if (usedBorders !== gridBorders.length || usedRings !== rings.length) throw transitionError(prim, loops.length, gridBorders.length);
  }
  const poles = new Map<number, number>();
  const joins = new Map<number, number>();
  const gridSamples: (Sample | undefined)[] = [];
  function collapsed(at: (t: number) => UV) {
    const p = surfacePoint(s, at(0));
    return Array.from({ length: 16 }, (_, k) => (k + 1) / 17)
      .every((t) => dist(p, surfacePoint(s, at(t))) <= Math.max(...scale) * 1e-12);
  }
  function pole(ids: number[]) {
    const parent = ids.map((id) => poles.get(id)).find((id) => id !== undefined) ?? ids[0];
    for (const id of ids) {
      const previous = poles.get(id);
      if (previous !== undefined && previous !== parent) joins.set(previous, parent);
      poles.set(id, parent);
    }
  }
  if (!s.v.closed) for (const j of [0, nv]) {
    if (collapsed((t) => [t, v[j]])) pole(Array.from({ length: cols }, (_, i) => j * cols + i));
  }
  if (!s.u.closed) for (const i of [0, nu]) {
    if (collapsed((t) => [u[i], t])) pole(Array.from({ length: nv + Number(!s.v.closed) }, (_, j) => j * cols + i));
  }

  const pn = b.attrib('point', 'N', 3), tex = b.attrib('vertex', 'uv', src.vertices.get('uv')?.size === 2 ? 2 : 3);
  const bandAttrib = b.attrib('prim', 'band', 1, 'int');
  const surfaceGroup = b.group('prim', 'surface');
  const faceGroups = new Map(rules.groups.map((name) => [name, b.group('prim', name)]));
  const generated: number[] = [];
  const displaced: Sample[] = [];

  function sample(p: Vertex): Sample {
    if (p.point) return p.point;
    let id = p.grid;
    let [x, y] = p.uv;
    if (id !== undefined) {
      id = poles.get(id) ?? id;
      while (joins.has(id)) id = joins.get(id)!;
      const known = gridSamples[id];
      if (known) return known;
      x = u[id % cols]; y = v[Math.floor(id / cols)];
    }
    const e = evaluate(s, x, y, 1, true), n = normal(s, x, y, e);
    const P = p.depth ? e.P.map((x, i) => x + p.depth * n[i]) as Vec3 : e.P;
    const pt = b.addPoint(...P, { i: e.idx.map((i) => s.points[i]), w: e.w });
    pn.set(pt, n);
    const result: Sample = { id: pt, P, src: { i: e.idx.map((i) => src.primStart[prim] + i), w: e.w } };
    if (p.depth) {
      result.faceNormal = [0, 0, 0];
      displaced.push(result);
    }
    if (id !== undefined) gridSamples[id] = result;
    else p.point = result;
    return result;
  }

  function emit(face: Vertex[], band: number, kind: 'poles' | 'corners' | 'transitions', group = surfaceGroup) {
    const points: Sample[] = [], uv: UV[] = [];
    for (const corner of face) {
      const p = sample(corner);
      if (points.some((q) => q.id === p.id)) continue;
      points.push(p); uv.push(corner.uv);
    }
    if (points.length < 3) return;
    if (points.length === 4) stats.quads++;
    else { stats.triangles++; stats[kind]++; }
    if (kind === 'transitions') stats.transition_faces++;
    if (kind !== 'poles') {
      const cosine = faceCosine(points.map((p) => p.P), uv);
      const angle = Math.acos(clamp(cosine, -1, 1)) * 180 / Math.PI;
      stats.min_angle = Math.min(stats.min_angle, angle);
      if (cosine > THIN) stats.thin_faces++;
    }
    const first = b.numVertices;
    const id = b.addPrim(points.map((p) => p.id), true, prim, points.map((p) => p.src));
    generated.push(id);
    group.add(id);
    bandAttrib.set(id, band);
    const uvOrigin = [s.u.closed, s.v.closed].map((closed, axis) =>
      closed ? Math.floor(uv.reduce((sum, p) => sum + p[axis], 0) / uv.length) : 0);
    for (let k = 0; k < uv.length; k++) {
      const [u, v] = uv[k];
      tex.set(first + k, [au.metres(u - uvOrigin[0]), av.metres(v - uvOrigin[1]), 0]);
    }
    if (points.some((p) => p.faceNormal)) {
      const p = points[0].P, n = [0, 0, 0];
      for (let i = 2; i < points.length; i++) {
        const t = cross(sub(points[i - 1].P, p), sub(points[i].P, p));
        for (let k = 0; k < 3; k++) n[k] += t[k];
      }
      for (const { faceNormal } of points) if (faceNormal) for (let k = 0; k < 3; k++) faceNormal[k] += n[k];
    } else {
      let x = 0, y = 0, px = 0, py = 0, pz = 0;
      for (let i = 0; i < points.length; i++) {
        x += uv[i][0]; y += uv[i][1]; px += points[i].P[0]; py += points[i].P[1]; pz += points[i].P[2];
      }
      const n = points.length;
      const p = surfacePoint(s, [x / n, y / n]);
      stats.max_chord_error = Math.max(stats.max_chord_error, dist(p, [px / n, py / n, pz / n]));
    }
  }

  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    if (cells && !cells[j * nu + i]) continue;
    const a = i + 1 === nu && s.u.closed ? 0 : i + 1, z = j + 1 === nv && s.v.closed ? 0 : j + 1;
    emit([gridAt([u[i], v[j]], i, j), gridAt([u[i + 1], v[j]], a, j),
      gridAt([u[i + 1], v[j + 1]], a, z), gridAt([u[i], v[j + 1]], i, z)], -1, 'poles');
  }
  for (const [i, loop] of loops.entries()) {
    const { bands } = loop;
    // The duplicate endpoint of a winding loop has its own texture coordinates.
    for (const { points, closed } of loop.rings) if (closed) points[points.length - 1].point = sample(points[0]);
    stats.stations += loop.rings[0].points.length - Number(loop.trim.closed);
    stats.bands += bands.length;
    let row = 0;
    for (let band = 0; band < bands.length; band++) for (let r = 0; r < bands[band].rows; r++, row++) {
      const a = loop.rings[row].points, c = loop.rings[row + 1].points;
      const group = faceGroups.get(bands[band].group)!;
      for (let i = 1; i < a.length; i++) emit([a[i - 1], a[i], c[i], c[i - 1]], band, 'corners', group);
    }
    const outer = rings[i];
    if (shared.has(outer)) continue;
    let best: ReturnType<typeof nearest> | undefined, match = -1;
    for (let i = 0; i < gridBorders.length; i++) {
      const border = gridBorders[i];
      if (direct.size && direct.get(outer) !== border) continue;
      if (border.closed !== outer.closed) continue;
      const candidate = nearest(s, border, outer, scale);
      if (!best || candidate.best < best.best) { best = candidate; match = i; }
    }
    if (!best) throw transitionError(prim, loops.length, borders.length);
    const border = gridBorders.splice(match, 1)[0];
    // Keep the point handles when rotating the UVs to the start of the zipper.
    for (const p of outer.points) p.point = sample(p);
    for (const p of border.points) p.point = sample(p);
    const corner = outer.closed ? outer.points.findIndex((p) => p.corner) : -1;
    let gridStart = best.i, ringStart = best.j, period = best.shiftBy;
    if (corner >= 0) {
      gridStart = closestGrid(border.points.slice(0, -1), outer.points[corner]);
      ringStart = corner;
      const [du, dv] = delta(border.points[gridStart].uv, outer.points[ringStart].uv);
      period = [s.u.closed ? Math.round(du) : 0, s.v.closed ? Math.round(dv) : 0];
    }
    const faces = zipRuns(rotate(border, gridStart, [0, 0]), rotate(outer, ringStart, period), scale, o.size);
    if (!faces) throw new Error(`Cannot join a trim to the grid on surface prim ${prim}. Use a smaller size or increase counts.`);
    for (const face of faces) emit(face, -1, 'transitions');
  }
  for (const group of sharedGroups) {
    for (const { path } of [...group.borders, ...group.rings]) for (const p of path.points) p.point = sample(p);
    const contours = transitionContours(s, group, gridAt);
    if (!contours) throw transitionError(prim, loops.length, borders.length);
    for (const face of triangulateTransition(contours, scale, sample)) emit(face, -1, 'transitions');
  }
  for (const p of displaced) if (Math.hypot(...p.faceNormal!) > 0) pn.set(p.id, normalize(p.faceNormal!));
  return generated;
}

type MeshStats = Record<'quads' | 'triangles' | 'quad_share' | 'bands' | 'stations' | 'max_chord_error' | 'min_angle' | 'thin_faces' | 'poles' | 'corners' | 'transitions' | 'transition_faces', number>;

export function meshSurfaces(src: Geometry, o: Options) {
  const stats: MeshStats = { quads: 0, triangles: 0, quad_share: 1, bands: 0, stations: 0, max_chord_error: 0,
    min_angle: Infinity, thin_faces: 0, poles: 0, corners: 0, transitions: 0, transition_faces: 0 };
  if (!src.hasSurfaces()) return { geo: src, stats: { ...stats, min_angle: 0 } };
  const rules = readBands(o.bands), b = new GeoBuilder(src);
  const keep = new Uint8Array(src.numPoints).fill(1), pointMap = new Int32Array(src.numPoints);
  for (let p = 0; p < src.numPrims; p++) if (src.isSurface(p)) for (const i of src.primPoints(p)) keep[i] = 0;
  for (let p = 0; p < src.numPrims; p++) if (!src.isSurface(p)) for (const i of src.primPoints(p)) keep[i] = 1;
  keep.forEach((copy, i) => { if (copy) pointMap[i] = b.copyPoint(i); });
  const kinds: [number, number][] = [], copied: [number, number][] = [], generated: number[] = [];
  for (let p = 0; p < src.numPrims; p++) {
    if (src.isSurface(p)) {
      const s = surfaceFromPrim(src, p);
      if (!s) throw new Error(`Surface prim ${p} has an invalid NURBS control grid. Check its control points and surface_cols.`);
      for (const id of appendMesh(b, src, p, s, o, rules, stats)) generated.push(id);
    } else {
      const pts = src.primPoints(p).map((i) => pointMap[i]), start = src.primStart[p];
      const id = b.addPrim(pts, !!src.primClosed[p], p, pts.map((_, k) => start + k));
      if (src.isSpline(p)) kinds.push([id, src.primKind![p]]);
      copied.push([id, p]);
    }
  }
  const geo = b.build();
  if (kinds.length) {
    geo.ensurePacked();
    for (const [id, kind] of kinds) geo.primKind![id] = kind;
  }
  for (const name of ['surface', ...rules.groups]) {
    const from = src.primGroups.get(name), to = geo.primGroups.get(name);
    if (from && to) for (const [id, p] of copied) to[id] = from[p];
  }
  for (const name of [TRIM_UV, TRIM_LOOPS, TRIM_NAMES, SURFACE_COLS, ORDER_ATTRIB, KNOTS_ATTRIB, ORDER_V, KNOTS_V, CLOSED_V]) {
    const attr = geo.prims.get(name);
    if (attr) for (const id of generated) attr.set(id, attr.isArray ? [] : 0);
  }
  const normals = geo.points.get('N')!, vertexNormals = geo.vertices.get('N');
  if (vertexNormals) for (const p of generated) for (let i = geo.primStart[p]; i < geo.primStart[p + 1]; i++) {
    vertexNormals.set(i, normals.get(geo.vertexPoint[i]));
  }
  const faces = stats.quads + stats.triangles;
  if (faces) stats.quad_share = stats.quads / faces;
  if (!Number.isFinite(stats.min_angle)) stats.min_angle = 0;
  return { geo, stats };
}
