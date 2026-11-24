// Build a subdivision cage from longitudinal feature lines.
import { GeoBuilder, Geometry } from '../core/geometry.ts';
import type { Vec3 } from '../core/math.ts';
import { fillPatch, newellOf } from '../core/polyedit.ts';
import type { FillPatch } from '../core/polyedit.ts';
import { evaluateSplines } from '../core/splines.ts';
import { orientOutward, topologyReport } from '../core/topology.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import type { CookContext } from '../graph/types.ts';
import { catmullRom } from './curves.ts';
import { creaseSharpness, subdivideLevel } from './topology.ts';

const CENTRE = 1e-6;
const CREASE = 'creaseweight';
const ident = /^[A-Za-z_][A-Za-z_0-9]*$/;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown): v is number => finite(v) && Number.isSafeInteger(v) && v >= 0;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const point = (p: ArrayLike<number>, i: number): Vec3 => [p[3 * i], p[3 * i + 1], p[3 * i + 2]];

function error(message: string): never { throw new NodeError(`lines_plan: ${message}`); }

interface Blend { i: number[]; w: number[] }
interface Sample { pos: Vec3; src: Blend | null }

function blend(samples: (Blend | null)[], weights: number[]): Blend | null {
  if (!samples.some(Boolean)) return null;
  const acc = new Map<number, number>();
  samples.forEach((src, j) => src?.i.forEach((i, k) => {
    acc.set(i, (acc.get(i) ?? 0) + src.w[k] * weights[j]);
  }));
  return { i: [...acc.keys()], w: [...acc.values()] };
}

interface Line {
  name: string;
  centre: boolean;
  start: number;
  end: number;
  at(position: number): Sample;
}

/** PCHIP slopes. Interior tangents are weighted harmonic means, and end tangents are one-sided and limited. */
function tangents(x: number[], y: number[]): number[] {
  const h = x.slice(1).map((v, i) => v - x[i]);
  const d = h.map((v, i) => (y[i + 1] - y[i]) / v);
  if (d.length === 1) return [d[0], d[0]];
  const end = (i: number, j: number) => {
    const m = ((2 * h[i] + h[j]) * d[i] - h[i] * d[j]) / (h[i] + h[j]);
    if (Math.sign(m) !== Math.sign(d[i])) return 0;
    return Math.sign(d[i]) !== Math.sign(d[j]) && Math.abs(m) > 3 * Math.abs(d[i]) ? 3 * d[i] : m;
  };
  const m = [end(0, 1)];
  for (let i = 1; i < d.length; i++) {
    const a = d[i - 1], b = d[i], w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
    m.push(a === 0 || b === 0 || Math.sign(a) !== Math.sign(b) ? 0 : (w1 + w2) / (w1 / a + w2 / b));
  }
  m.push(end(d.length - 1, d.length - 2));
  return m;
}

/** Lower index of the span that contains v, or the nearest span outside the range. */
function span(x: number[], v: number): number {
  let a = 0, b = x.length - 1;
  while (b - a > 1) {
    const i = (a + b) >>> 1;
    if (x[i] <= v) a = i;
    else b = i;
  }
  return a;
}

function lineReader(name: string, raw: unknown, source: number[] | null, smooth: boolean, axis: number, mirror: boolean): Line {
  if (!Array.isArray(raw) || raw.length < 2) error(`lines line "${name}" needs at least 2 points (metres)`);
  const points = raw.map((v, i): Vec3 => {
    if (!Array.isArray(v) || v.length !== 3 || !finite(v[0]) || !finite(v[1]) || !finite(v[2])) {
      error(`lines line "${name}" point ${i} needs three finite coordinates in metres`);
    }
    if (mirror && v[0] < 0) error(`mirror "x" needs x >= 0 on line "${name}" point ${i} (x = ${v[0]})`);
    return [v[0], v[1], v[2]];
  });
  const centre = mirror && points.every((v) => v[0] <= CENTRE);
  const x = points.map((v) => v[axis]);
  const dir = Math.sign(x[1] - x[0]);
  for (let i = 1; i < x.length; i++) {
    if (dir === 0 || Math.sign(x[i] - x[i - 1]) !== dir) {
      const letter = 'xyz'[axis];
      error(`lines line "${name}" turns back or repeats a position along ${letter} near ${letter} = ${x[i - 1]} (each station plane must cut a line once). Draw it one way along axis "${letter}"`);
    }
  }
  if (dir < 0) { points.reverse(); x.reverse(); source?.reverse(); }
  const slopes = smooth ? [0, 1, 2].map((c) => c === axis ? [] : tangents(x, points.map((v) => v[c]))) : null;
  return { name, centre, start: x[0], end: x[x.length - 1], at(v) {
    const i = span(x, v), h = x[i + 1] - x[i], t = (v - x[i]) / h;
    const u = 1 - t, a = points[i], b = points[i + 1];
    const pos = a.map((y, c) => {
      if (centre && c === 0) return 0;
      if (c === axis) return v;
      if (t === 0) return y;
      if (t === 1) return b[c];
      const m = slopes?.[c];
      if (!m) return lerp(y, b[c], t);
      const value = u * u * (1 + 2 * t) * y + t * t * (1 + 2 * u) * b[c] + t * u * h * (u * m[i] - t * m[i + 1]);
      return Math.max(Math.min(y, b[c]), Math.min(Math.max(y, b[c]), value));
    }) as Vec3;
    const src = source ? { i: [source[i], source[i + 1]], w: [u, t] } : null;
    return { pos, src };
  } };
}

function readLines(ctx: CookContext, axis: number, mirror: boolean) {
  const { p } = ctx;
  const input = ctx.inputs[0];
  if (input && ctx.given('lines')) error('give either the lines param or input 0 (lines)');
  if (!input && !object(p.lines)) error('lines needs an object of named point lists in section order');
  const src = input ? evaluateSplines(input, { segments: 128 }) : null;
  const names = input?.prims.get('name');
  const seen = new Set<string>();
  const read = (name: string, raw: unknown, ids: number[] | null, spline: boolean) => {
    if (!ident.test(name)) error(`lines name "${name}" must start with a letter or underscore and use only letters, digits and underscores`);
    if (seen.has(name)) error(`lines name "${name}" appears twice. Give each line a unique name`);
    seen.add(name);
    return lineReader(name, raw, ids, !spline && p.interpolation === 'smooth', axis, mirror);
  };
  const lines = src && input ? Array.from({ length: src.numPrims }, (_, i) => {
    const name = (names?.type === 'string' ? String(names.get(i)) : '') || `line${i}`;
    if (input.primClosed[i]) error(`input 0 (lines) has a closed curve "${name}". Supply open curves`);
    const ids = src.primPoints(i);
    return read(name, ids.map((j) => point(src.P, j)), ids, input.isSpline(i));
  }) : Object.entries(p.lines).map(([name, raw]) => read(name, raw, null, false));
  if (lines.length < 2) error('lines needs at least 2 feature lines in section order');
  return { lines, src };
}

function stationPositions(value: unknown, lines: Line[], warn: CookContext['warn']): number[] {
  if (Array.isArray(value)) {
    if (value.length < 2) error('stations needs at least 2 positions in metres');
    if (value.some((v, i) => !finite(v) || (i > 0 && v <= value[i - 1]))) error('stations positions must be finite and strictly ascending in metres');
    for (const v of value) for (const { name, start, end } of lines) {
      if (v < start || v > end) error(`stations position ${v} m is outside line "${name}" (${start} to ${end} m). Move the station or extend the line`);
    }
    return value;
  }
  if (!count(value) || value < 2) error('stations needs an integer count of at least 2 or an ascending list of positions in metres');
  if (value > 2e6) error('stations count is too large. Lower stations');
  let lo = -Infinity, hi = Infinity;
  for (const { start, end } of lines) { lo = Math.max(lo, start); hi = Math.min(hi, end); }
  if (!(lo < hi)) error('stations needs a shared axis range. Extend the lines until their ranges overlap');
  const cut = lines.filter(({ start, end }) => start < lo || end > hi).map(({ name }) => `"${name}"`);
  if (cut.length) warn(`lines_plan: stations uses the shared range ${lo} to ${hi} m and trims ${cut.join(', ')}. Match the line ranges to keep their full lengths`);
  return Array.from({ length: value }, (_, i) => i === value - 1 ? hi : lerp(lo, hi, i / (value - 1)));
}

type End = 'open' | 'cap' | 'point';
function endModes(value: unknown, closed: boolean): [End, End] {
  const modes = Array.isArray(value) ? value : [value, value];
  if (modes.length !== 2 || modes.some((v) => v !== 'open' && v !== 'cap' && v !== 'point')) {
    error(`ends value ${JSON.stringify(value)} is unknown. Use "open", "cap", "point" or a pair of these`);
  }
  if (!closed && modes.includes('cap')) error('ends "cap" needs closed sections. Set closed to true or use "open" or "point"');
  return [modes[0], modes[1]];
}

function lineIndex(lines: Line[], name: unknown, param: string): number {
  const i = lines.findIndex((l) => l.name === name);
  if (i < 0) error(`${param} names unknown line ${JSON.stringify(name)}. Use ${lines.map((l) => `"${l.name}"`).join(', ')}`);
  return i;
}

function creaseWeights(value: unknown, lines: Line[], stations: number[]): number[][] {
  if (!object(value)) error('creases needs an object of line names and weights or [position, weight] keys');
  const weights = lines.map(() => stations.map(() => 0));
  for (const [name, v] of Object.entries(value)) {
    const i = lineIndex(lines, name, 'creases');
    if (finite(v) && v >= 0) { weights[i].fill(v); continue; }
    if (!Array.isArray(v) || !v.length || v.some((q) => !Array.isArray(q) || q.length !== 2 || !finite(q[0]) || !finite(q[1]) || q[1] < 0)) {
      error(`creases for line "${name}" needs a nonnegative weight or [position in metres, weight] keys`);
    }
    const x = v.map((q) => q[0]);
    if (x.some((q, j) => j > 0 && q <= x[j - 1])) error(`creases keys for line "${name}" must have strictly ascending positions in metres`);
    weights[i] = stations.map((s) => {
      if (s < x[0] || s > x[x.length - 1]) return 0;
      if (x.length === 1) return v[0][1];
      const j = span(x, s);
      return lerp(v[j][1], v[j + 1][1], (s - x[j]) / (x[j + 1] - x[j]));
    });
  }
  return weights;
}

interface SectionGroup { name: string; from: number; to: number; gaps: number[] }

function sectionGroups(value: unknown, lines: Line[], stations: number[], wrap: boolean): SectionGroup[] {
  if (!object(value)) error('groups needs an object of names with between and optional from and to positions');
  const nearest = (pos: number) => {
    const i = span(stations, pos);
    return pos - stations[i] <= stations[i + 1] - pos ? i : i + 1;
  };
  return Object.entries(value).map(([name, v]) => {
    if (!name || name === 'sides' || name === 'caps') error(`groups name ${JSON.stringify(name)} is reserved or empty. Give the group its own name`);
    if (!object(v) || !Array.isArray(v.between) || v.between.length !== 2) error(`groups "${name}" needs between: ["line1", "line2"]`);
    const a = lineIndex(lines, v.between[0], `groups "${name}" between`);
    const b = lineIndex(lines, v.between[1], `groups "${name}" between`);
    if (a === b) error(`groups "${name}" between needs two different lines`);
    const from = v.from === undefined ? stations[0] : v.from, to = v.to === undefined ? stations[stations.length - 1] : v.to;
    if (!finite(from) || !finite(to) || from > to) error(`groups "${name}" needs finite from and to positions in metres with from <= to`);
    const start = wrap ? a : Math.min(a, b), end = wrap ? b : Math.max(a, b);
    const gaps: number[] = [];
    for (let i = start; i !== end; i = (i + 1) % lines.length) gaps.push(i);
    return { name, from: nearest(from), to: nearest(to), gaps };
  });
}

interface Anchor { line: number; mirrored: boolean }
interface Row { anchor: number; step: number; divisions: number }
interface Strip { a: number; b: number; gap: number }

function sectionLayout(lines: Line[], value: unknown, mirror: boolean, closed: boolean, ns: number, levels: number) {
  const n = lines.length, gaps = n - Number(mirror || !closed);
  const extra = Array.isArray(value) ? value : Array.from({ length: gaps }, () => value);
  if (extra.length !== gaps) error(`rows_between needs ${gaps} counts, one for each gap between the lines`);
  if (!extra.every(count)) error('rows_between needs a nonnegative integer count or a list of such counts');
  const anchors: Anchor[] = lines.map((_, line) => ({ line, mirrored: false }));
  if (mirror) {
    for (let i = n - 1; i >= 0; i--) {
      if ((i === 0 || i === n - 1) && lines[i].centre) continue;
      anchors.push({ line: i, mirrored: true });
    }
    if (!closed && lines[0].centre) {
      if (lines[n - 1].centre) error('closed false with mirror "x" needs an end line off x = 0. Leave a gap at one end of the section');
      // Start after the open edge, so the open Catmull–Rom curve crosses the shared centre line.
      anchors.push(...anchors.splice(0, n));
    }
  }
  if (closed && anchors.length < 3) error('closed sections need at least 3 distinct rows around the body. Add a line off the centre or set closed to false');
  const segments = anchors.length - Number(!closed);
  const gapAt = (i: number) => {
    const a = anchors[i].line, b = anchors[(i + 1) % anchors.length].line;
    return mirror ? (a === b ? -1 : Math.min(a, b)) : a;
  };
  let columns = 0;
  for (let i = 0; i < segments; i++) columns += 1 + (extra[gapAt(i)] ?? 0);
  if (columns * ns * 4 ** (levels + 1) > 2e7) error('stations, rows_between and fit_levels would make too many vertices. Lower one of these values');

  const rows: Row[] = [], strips: Strip[] = [], first: number[] = [], extras: number[] = [];
  const centres = new Map<number, number>();
  for (let i = 0; i < anchors.length; i++) {
    const { line } = anchors[i], shared = centres.get(line);
    first.push(shared ?? rows.length);
    if (shared === undefined) {
      if (lines[line].centre) centres.set(line, rows.length);
      rows.push({ anchor: i, step: 0, divisions: 1 });
    }
    if (i >= segments) continue;
    const divisions = 1 + (extra[gapAt(i)] ?? 0);
    extras[i] = rows.length;
    for (let step = 1; step < divisions; step++) rows.push({ anchor: i, step, divisions });
  }
  for (let i = 0; i < segments; i++) {
    const gap = gapAt(i), divisions = 1 + (extra[gap] ?? 0);
    let a = first[i];
    for (let j = 1; j <= divisions; j++) {
      const b = j === divisions ? first[(i + 1) % anchors.length] : extras[i] + j - 1;
      strips.push({ a, b, gap });
      a = b;
    }
  }
  return { anchors, rows, strips };
}

type Layout = ReturnType<typeof sectionLayout>;

function sampleSection(lines: Line[], layout: Layout, position: number, closed: boolean, axis: number): Sample[] {
  const { anchors, rows } = layout;
  const readings = lines.map((l) => l.at(position));
  const section = anchors.map(({ line, mirrored }) => {
    const { pos, src } = readings[line];
    return mirrored ? { pos: [-pos[0], pos[1], pos[2]] as Vec3, src } : readings[line];
  });
  const coords = section.map((s) => s.pos);
  const samples = new Map<number, number[][]>();
  return rows.map(({ anchor, step, divisions }) => {
    const a = section[anchor];
    if (!step) return a;
    let curve = samples.get(divisions);
    if (!curve) { curve = catmullRom(coords, closed, divisions).pos; samples.set(divisions, curve); }
    const pos = curve[anchor * divisions + step] as Vec3;
    pos[axis] = position;
    const b = section[(anchor + 1) % anchors.length], t = step / divisions;
    return { pos, src: blend([a.src, b.src], [1 - t, t]) };
  });
}

interface CagePoint extends Sample { row: number; station: number; line: number; crease: number }
interface CageFace { ids: number[]; uv: Vec3[]; row: number; station: number; gap: number }
interface Cage { points: CagePoint[]; faces: CageFace[]; rings: number[][]; caps: Cap[] }

function makeCage(lines: Line[], layout: Layout, stations: number[], ends: [End, End], closed: boolean, axis: number, mirror: boolean, weights: number[][], warn: CookContext['warn']): Cage {
  const points: CagePoint[] = [], faces: CageFace[] = [], caps: Cage['caps'] = [];
  const { anchors, rows, strips } = layout;
  const last = stations.length - 1;
  const rings = stations.map((pos, station) => {
    const samples = sampleSection(lines, layout, pos, closed, axis);
    const end = station === 0 ? ends[0] : station === last ? ends[1] : 'open';
    if (end === 'point') {
      const first = samples[0].pos;
      const tip = samples.every((sample) => dist(first, sample.pos) <= CENTRE) ? first.slice() as Vec3
        : samples.reduce<Vec3>((a, { pos: b }) => [a[0] + b[0] / samples.length, a[1] + b[1] / samples.length, a[2] + b[2] / samples.length], [0, 0, 0]);
      if (mirror) tip[0] = 0;
      tip[axis] = pos;
      const id = points.length;
      points.push({ pos: tip, src: blend(samples.map((s) => s.src), samples.map(() => 1 / samples.length)), row: 0, station, line: -1, crease: 0 });
      return rows.map(() => id);
    }
    const seam = new Map<string, number>();
    const ids = samples.map((sample, row) => {
      const desc = rows[row], line = desc.step ? -1 : anchors[desc.anchor].line;
      const key = mirror && sample.pos[0] === 0 ? `${sample.pos[1]},${sample.pos[2]}` : null;
      const existing = key === null ? undefined : seam.get(key);
      if (existing !== undefined) return existing;
      const id = points.length;
      if (key !== null) seam.set(key, id);
      points.push({ ...sample, row, station, line, crease: line < 0 ? 0 : weights[line][station] });
      return id;
    });
    if (end === 'cap') caps.push(makeCap([...new Set(station === 0 ? ids.slice().reverse() : ids)], points, station, mirror, warn));
    return ids;
  });

  if (last === 1 && ends[0] === 'point' && ends[1] === 'point') error('ends "point" at both ends needs at least 3 stations. Add a station between the tips');
  const adjacent = new Set<number>();
  for (let s = 0; s < last; s++) {
    const lower = rings[s], upper = rings[s + 1];
    strips.forEach(({ a, b, gap }, col) => {
      const ids = [lower[a], lower[b], upper[b], upper[a]];
      const u0 = col / strips.length, u1 = (col + 1) / strips.length, v0 = s / last, v1 = (s + 1) / last;
      const uv: Vec3[] = [[u0, v0, 0], [u1, v0, 0], [u1, v1, 0], [u0, v1, 0]];
      const keep = ids.map((id, i) => id !== ids[(i + 3) % 4]);
      const corners = ids.filter((_, i) => keep[i]);
      if (corners.length < 3) return;
      faces.push({ ids: corners, uv: uv.filter((_, i) => keep[i]), row: Math.min(a, b), station: s, gap });
      for (const [j, k] of [[0, 1], [2, 3]]) {
        const p = points[ids[j]], q = points[ids[k]];
        if (gap >= 0 && p.line !== q.line && p.crease > 0 && q.crease > 0) adjacent.add(gap);
      }
    });
  }
  for (const gap of adjacent) {
    const a = lines[gap].name, b = lines[(gap + 1) % lines.length].name;
    warn(`lines_plan: creases on neighbouring lines "${a}" and "${b}" also crease the edges between them. Use rows_between to separate them`);
  }
  return { points, faces, rings, caps };
}

interface Cap { ids: number[]; faces: number[][]; weights: Blend[]; planar: boolean }

/** Grid cap corners must reflect onto one another to keep the subdivision weights symmetric. */
function mirroredGrid(loop: Vec3[], patch: FillPatch): FillPatch {
  const n = loop.length, half = n / 2;
  if (n % 2 || n <= 4) return patch;
  const [x, y, z] = loop[0];
  const reflected = loop.findIndex((q) => dist(q, [-x, y, z]) <= 1e-9);
  if (reflected < 0) return patch;
  const reflect = (i: number) => (reflected - i + n) % n;
  if (!loop.every(([x, y, z], i) => dist(loop[reflect(i)], [-x, y, z]) <= 1e-9)) return patch;
  const uses = new Uint32Array(n);
  for (const f of patch.faces) for (const i of f) if (i >= 0) uses[i]++;
  if (uses.every((c, i) => c !== 1 || uses[reflect(i)] === 1)) return patch;

  let best: number[] = [], score = -Infinity;
  for (let a = 1; a < half; a++) {
    for (let s = 0; s < n; s++) {
      const corners = [s, (s + a) % n, (s + half) % n, (s + half + a) % n];
      if (!corners.every((i) => corners.includes(reflect(i)))) continue;
      const quality = corners.reduce((sum, i) => sum + Number(uses[i] === 1), 0) - Math.abs(2 * a - half) / half;
      if (quality > score) { best = corners; score = quality; }
    }
  }
  if (!best.length) return patch;
  const corners: Vec3[] = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
  const reference: Vec3[] = [];
  best.forEach((start, i) => {
    const a = corners[i], b = corners[(i + 1) % 4], size = (best[(i + 1) % 4] - start + n) % n;
    for (let j = 0; j < size; j++) reference[(start + j) % n] = [lerp(a[0], b[0], j / size), lerp(a[1], b[1], j / size), 0];
  });
  return fillPatch(reference, 'grid', 0);
}

function makeCap(ids: number[], points: CagePoint[], station: number, mirror: boolean, warn: CookContext['warn']): Cap {
  if (ids.length < 3) error(`ends "cap" needs a loop at station ${station}. Use "point" for a collapsed end`);
  const loop = ids.map((i) => points[i].pos);
  let patch = fillPatch(loop, 'grid', 0);
  if (patch.note) warn(`lines_plan: ends "cap" at station ${station} used the quad fallback for its ${ids.length}-point loop. Use an even number of rows for a grid`);
  if (mirror) patch = mirroredGrid(loop, patch);

  // Keep the selected grid during fitting. Apply polyfill's ten Laplacian passes to the Coons weights so
  // the same smoothed grid can be placed against each new boundary without reselecting its corners.
  const neighbours = patch.points.map(() => new Set<number>());
  for (const f of patch.faces) f.forEach((a, i) => {
    const b = f[(i + 1) % f.length];
    if (a < 0) neighbours[-a - 1].add(b);
    if (b < 0) neighbours[-b - 1].add(a);
  });
  const boundary = ids.map((_, i) => ({ i: [i], w: [1] }));
  let weights: Blend[] = patch.points;
  for (let i = 0; i < 10; i++) weights = neighbours.map((ns, j) => ns.size
    ? blend([...ns].map((q) => q < 0 ? weights[-q - 1] : boundary[q]), [...ns].map(() => 1 / ns.size))!
    : weights[j]);
  return { ids, faces: patch.faces, weights, planar: ids.length % 2 === 1 && weights.length > 0 };
}

function capCage(cage: Cage, positions: Vec3[], sources?: (Blend | null)[]) {
  const capFaces: number[][] = [];
  for (const { ids, faces, weights, planar } of cage.caps) {
    const offset = positions.length, loop = ids.map((i) => positions[i]);
    const plane = planar ? newellOf(loop) : null;
    const length = plane ? Math.hypot(...plane.n) : 0;
    for (const { i, w } of weights) {
      const p: Vec3 = [0, 0, 0];
      i.forEach((j, k) => { for (let c = 0; c < 3; c++) p[c] += loop[j][c] * w[k]; });
      if (plane && length > 0) {
        const d = p.reduce((sum, v, c) => sum + (v - plane.c[c]) * (plane.n[c] / length), 0);
        for (let c = 0; c < 3; c++) p[c] -= d * (plane.n[c] / length);
      }
      positions.push(p);
      sources?.push(blend(i.map((j) => cage.points[ids[j]].src), w));
    }
    for (const f of faces) capFaces.push(f.map((j) => j < 0 ? offset - j - 1 : ids[j]));
  }
  return capFaces;
}

function fitCage(cage: Cage, positions: Vec3[], levels: number): number {
  if (!levels) return 0;
  const sides = cage.faces.map((f) => f.ids);
  const weights = cage.points.map((p) => p.crease);
  const creased = weights.some((w) => w > 0);
  const n = positions.length;
  for (let step = 0; ; step++) {
    const current = positions.slice();
    const capFaces = capCage(cage, current);
    let g = new Geometry({ positions: current.flat(), prims: [...sides, ...capFaces] });
    if (creased) (g.points.add(CREASE, 'float', 1).data as Float64Array).set(weights);
    let sharp = creased ? creaseSharpness(g, '', 10, CREASE)?.sharp ?? null : null;
    if (creased) g.points.delete(CREASE);
    const child = Int32Array.from({ length: n }, (_, i) => i);
    for (let l = 0; l < levels; l++) {
      const r = subdivideLevel(g, true, 'smooth', sharp);
      for (let i = 0; i < n; i++) child[i] = r.vtxPt[child[i]];
      g = r.geo;
      sharp = r.sharp;
    }
    const P = g.P;
    let max = 0;
    const delta = cage.points.map(({ pos }, i): Vec3 => {
      const j = child[i] * 3;
      const d: Vec3 = [pos[0] - P[j], pos[1] - P[j + 1], pos[2] - P[j + 2]];
      max = Math.max(max, Math.hypot(...d));
      return d;
    });
    if (!Number.isFinite(max)) error('fit_levels could not fit these sections. Separate overlapping lines or lower fit_levels');
    if (max < 0.00005 || step === 100) return max;
    delta.forEach((d, i) => {
      const p = positions[i];
      p[0] += d[0]; p[1] += d[1]; p[2] += d[2];
    });
  }
}

function buildCage(cage: Cage, positions: Vec3[], layout: Layout, lines: Line[], groups: SectionGroup[], src: Geometry | null, fitError: number): Geometry {
  const capSources: (Blend | null)[] = [];
  const capFaces = capCage(cage, positions, capSources);
  const b = new GeoBuilder(src);
  b.volumes = [];
  b.skip.prim.add('name');
  const row = b.attrib('point', 'row', 1, 'int'), line = b.attrib('point', 'line', 1, 'string');
  const station = b.attrib('point', 'station', 1, 'int'), crease = b.attrib('point', CREASE);
  const primRow = b.attrib('prim', 'row', 1, 'int'), primStation = b.attrib('prim', 'station', 1, 'int');
  const uv = b.attrib('vertex', 'uv', 3);
  const sides = b.group('prim', 'sides'), caps = b.group('prim', 'caps');
  const named = groups.map((g) => ({ ...g, members: b.group('prim', g.name) }));
  positions.forEach((pos, i) => {
    const pt = cage.points[i];
    const id = b.addPoint(...pos, pt ? pt.src : capSources[i - cage.points.length]);
    row.set(id, pt?.row ?? -1);
    station.set(id, pt?.station ?? -1);
    line.set(id, (pt && lines[pt.line]?.name) || '');
    crease.set(id, pt?.crease ?? 0);
  });
  const addFace = (ids: number[], r: number, s: number) => {
    const area = Math.hypot(...newellOf(ids.map((i) => positions[i])).n);
    if (!(area > 0 && Number.isFinite(area))) {
      error(`lines and ends made a zero-area or invalid face at row ${r}, station ${s}. Separate overlapping lines or use "point" for a collapsed end`);
    }
    const id = b.addPrim(ids);
    primRow.set(id, r);
    primStation.set(id, s);
    return id;
  };
  for (const f of cage.faces) {
    const v = b.numVertices;
    const id = addFace(f.ids, f.row, f.station);
    f.uv.forEach((value, k) => uv.set(v + k, value));
    sides.add(id);
    for (const g of named) if (f.station >= g.from && f.station < g.to && g.gaps.includes(f.gap)) g.members.add(id);
  }
  for (const f of capFaces) caps.add(addFace(f, -1, -1));
  const edgeGroups = lines.map((l) => b.edgeGroup(`line_${l.name}`));
  layout.rows.forEach(({ anchor, step }, r) => {
    if (step) return;
    const group = edgeGroups[layout.anchors[anchor].line];
    for (let s = 0; s + 1 < cage.rings.length; s++) group.add(cage.rings[s][r], cage.rings[s + 1][r]);
  });
  const out = b.build();
  out.detail.add('fit_error', 'float', 1).set(0, fitError);
  return topologyReport(out).closed ? orientOutward(out) : out;
}

const pod = {
  keel: [[0, -0.067, -0.5], [0, -0.128, -0.29], [0, -0.14, 0], [0, -0.122, 0.29], [0, -0.051, 0.5]],
  sill: [[0.059, -0.045, -0.5], [0.121, -0.091, -0.29], [0.137, -0.103, 0], [0.117, -0.086, 0.29], [0.053, -0.036, 0.5]],
  belt: [[0.085, 0, -0.5], [0.183, 0, -0.29], [0.203, 0, 0], [0.172, 0, 0.29], [0.075, 0, 0.5]],
  shoulder: [[0.059, 0.054, -0.5], [0.127, 0.113, -0.29], [0.145, 0.132, 0], [0.125, 0.105, 0.29], [0.05, 0.046, 0.5]],
  roof: [[0, 0.075, -0.5], [0, 0.149, -0.29], [0, 0.177, 0], [0, 0.147, 0.29], [0, 0.062, 0.5]],
};

defineNode({
  type: 'lines_plan',
  category: 'curve',
  aliases: ['cage_from_lines', 'lines_cage', 'skin_lines'],
  summary: 'Build a cage from the long lines of a body so the smoothed surface passes through them.',
  description:
    'Draw feature lines along the length of the body, with +Z toward the front by default. Give the lines in order around a cross-section. ' +
    'Use an object such as {"keel":[[0,0,-0.5],[0,0,0.5]],"belt":[[0.15,0.1,-0.5],[0.2,0.1,0.5]]} with other lines around the section, or connect named open curves. ' +
    'Mirror x reflects the positive x half and shares centre lines. Stations cut all the lines at the same axis positions. Smooth reading uses a shape-preserving cubic between line points, and extra rows round out each section. ' +
    'Leave the ends open, fill closed sections with grid caps, or bring each end to a point. Set a crease weight per line or use position and weight pairs to fade a crease along its length. ' +
    'Group faces between lines and stations for panels or openings. Match fit_levels to the levels in subdivide so its vertex points pass through the sampled line points and extra rows.',
  inputs: [{ name: 'lines', optional: true, desc: 'open curves in section order with prim string name (defaults to line0, line1 and so on)' }],
  splines: 'keep',
  params: {
    lines: { type: 'json', default: pod, readsGiven: true, desc: 'feature line names and [x,y,z] points in metres in section order. A small pod is used when no curves are connected' },
    axis: { type: 'enum', default: 'z', options: ['x', 'y', 'z'], desc: 'length axis for station positions in metres. Defaults to z, with the front toward +z. Use mirror none along x' },
    interpolation: { type: 'enum', default: 'smooth', options: ['smooth', 'linear'], desc: 'reading between points. Smooth uses a shape-preserving cubic by default, and linear uses straight segments. Spline samples are always read linearly' },
    stations: { type: 'json', default: 12, desc: 'count or strictly ascending axis positions in metres. Defaults to 12 evenly spaced stations across the shared line range' },
    mirror: { type: 'enum', default: 'x', options: ['x', 'none'], desc: 'x mirrors the positive x half and shares centre lines by default. Use none for a full section' },
    closed: { type: 'bool', default: true, desc: 'join the section into a loop by default. For an open mirrored section, leave at least one end line off x = 0' },
    rows_between: { type: 'json', default: 0, desc: 'extra rows per line gap, as a count or a list of counts. Defaults to zero. Closed sections without mirroring include the last-to-first gap' },
    ends: { type: 'json', default: 'cap', desc: 'open, cap, point, or a pair in ascending station order. Defaults to a grid cap at both ends' },
    creases: { type: 'json', default: {}, desc: 'line names with subdivision sharpness weights or [axis position in metres, weight] keys. Defaults to no creases. Keys interpolate linearly and are zero outside their range' },
    groups: { type: 'json', default: {}, desc: 'named face selections with between: [line, line] and optional from and to in metres, snapped to the nearest stations. Defaults to no groups. Unmirrored closed sections read between in section order' },
    fit_levels: { type: 'int', default: 2, min: 0, max: 4, desc: 'number of subdivision levels to fit, two by default. Zero puts cage points directly on the sampled sections' },
  },
  outputs: 'point row (int), line (string), station (int), creaseweight (float); prim row and station (int), prim groups sides, caps and groups; edge groups line_<name>; vertex uv; detail fit_error (float, metres)',
  example: {
    nodes: {
      cage: { type: 'lines_plan', params: {
        lines: {
          keel: [[0, 0.004, -0.5], [0, -0.058, -0.478], ...pod.keel.slice(1, -1), [0, -0.044, 0.478], [0, 0.006, 0.5]],
          sill: [[0, 0.004, -0.5], [0.052, -0.039, -0.478], ...pod.sill.slice(1, -1), [0.047, -0.031, 0.478], [0, 0.006, 0.5]],
          belt: [[0, 0.004, -0.5], [0.075, 0, -0.478], ...pod.belt.slice(1, -1), [0.066, 0.001, 0.478], [0, 0.006, 0.5]],
          shoulder: [[0, 0.004, -0.5], [0.052, 0.048, -0.478], ...pod.shoulder.slice(1, -1), [0.044, 0.041, 0.478], [0, 0.006, 0.5]],
          roof: [[0, 0.004, -0.5], [0, 0.066, -0.478], ...pod.roof.slice(1, -1), [0, 0.055, 0.478], [0, 0.006, 0.5]],
        },
        ends: 'point',
        stations: [-0.5, -0.478, -0.429, -0.306, -0.184, -0.061, 0.061, 0.184, 0.306, 0.429, 0.478, 0.5],
        creases: { belt: [[-0.38, 0], [-0.14, 1.6], [0.14, 1.6], [0.38, 0]] },
        groups: { side_panel: { between: ['belt', 'shoulder'], from: -0.16, to: 0.17 } },
      } },
      body: { type: 'subdivide', in: ['cage'], params: { levels: 2 } },
    },
    output: 'body',
  },
  // The cook signature sorts object keys, but the order of feature lines controls the section.
  signatureExtra: (p) => object(p.lines) ? Object.keys(p.lines).join(',') : '',
  cook(ctx) {
    const { p, warn } = ctx;
    const axis = 'xyz'.indexOf(p.axis), mirror = p.mirror === 'x';
    if (axis === 0 && mirror) error('mirror "x" needs axis "y" or "z". Set mirror to "none" to build along x');
    const { lines, src } = readLines(ctx, axis, mirror);
    const ends = endModes(p.ends, p.closed);
    const stations = stationPositions(p.stations, lines, warn);
    const layout = sectionLayout(lines, p.rows_between, mirror, p.closed, stations.length, p.fit_levels);
    const weights = creaseWeights(p.creases, lines, stations);
    const groups = sectionGroups(p.groups, lines, stations, !mirror && p.closed);
    const cage = makeCage(lines, layout, stations, ends, p.closed, axis, mirror, weights, warn);
    const positions = cage.points.map(({ pos }) => pos.slice() as Vec3);
    const fitError = fitCage(cage, positions, p.fit_levels);
    if (fitError > 0.001) warn(`lines_plan: fit_levels ${p.fit_levels} left a ${fitError.toFixed(6)} m fit error. Try more rows or stations, or a lower fit_levels`);
    return buildCage(cage, positions, layout, lines, groups, src, fitError);
  },
});
