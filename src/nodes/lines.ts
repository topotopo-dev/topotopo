// Build a subdivision cage from longitudinal feature lines.
import { edgeKey } from '../core/edges.ts';
import { GeoBuilder, Geometry } from '../core/geometry.ts';
import type { Vec3 } from '../core/math.ts';
import { fillPatch, newellOf } from '../core/polyedit.ts';
import type { FillPatch } from '../core/polyedit.ts';
import { evalBasis, evalPoint, evaluateSplines, makeSpline } from '../core/splines.ts';
import { orientOutward, topologyReport } from '../core/topology.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import type { CookContext } from '../graph/types.ts';
import { catmullRom } from './curves.ts';
import { subdivideLevel, writeCreaseAttrib } from './topology.ts';

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

type Interpolation = 'smooth' | 'linear' | 'cv';

function lineReader(name: string, raw: unknown, source: number[] | null, interpolation: Interpolation, axis: number, mirror: boolean): Line {
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
  const slopes = interpolation === 'smooth' ? [0, 1, 2].map((c) => c === axis ? [] : tangents(x, points.map((v) => v[c]))) : null;
  const spline = interpolation === 'cv' && points.length > 2 ? makeSpline('nurbs', points.flat(), { order: 4 }) : null;
  return { name, centre, start: x[0], end: x[x.length - 1], at(v) {
    if (spline) {
      const pos: Vec3 = [0, 0, 0];
      let lo = 0, hi = 1;
      if (v === x[0] || v === x[x.length - 1]) {
        hi = lo = v === x[0] ? 0 : 1;
      } else {
        // Strictly ordered controls make the axis coordinate monotone, so each station has one root.
        for (let i = 0; i < 48; i++) {
          const u = (lo + hi) / 2;
          if (evalPoint(spline, u, pos)[axis] < v) lo = u;
          else hi = u;
        }
      }
      const u = (lo + hi) / 2;
      evalPoint(spline, u, pos);
      pos[axis] = v;
      if (centre) pos[0] = 0;
      if (!source) return { pos, src: null };
      const { idx, w } = evalBasis(spline, u);
      return { pos, src: { i: idx.map((i) => source[i]), w } };
    }
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
    return lineReader(name, raw, ids, spline ? 'linear' : p.interpolation, axis, mirror);
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

type End = 'open' | 'cap' | 'point' | 'round';
function endModes(value: unknown, closed: boolean): [End, End] {
  const modes = Array.isArray(value) ? value : [value, value];
  if (modes.length !== 2 || modes.some((v) => v !== 'open' && v !== 'cap' && v !== 'point' && v !== 'round')) {
    error(`ends value ${JSON.stringify(value)} is unknown. Use "open", "cap", "point", "round" or a pair of these`);
  }
  for (const mode of modes) if (!closed && (mode === 'cap' || mode === 'round')) {
    error(`ends "${mode}" needs closed sections. Set closed to true or use "open" or "point"`);
  }
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

function sectionGroups(value: unknown, lines: Line[], stations: number[], wrap: boolean, mirror: boolean, layout: Layout): SectionGroup[] {
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
    const from = v.from === undefined ? stations[0] : v.from, to = v.to === undefined ? stations[stations.length - 1] : v.to;
    if (!finite(from) || !finite(to) || from > to) error(`groups "${name}" needs finite from and to positions in metres with from <= to`);
    const start = wrap ? a : Math.min(a, b), end = wrap ? b : Math.max(a, b);
    const gaps: number[] = [];
    if (a === b) {
      if (!mirror) error(`groups "${name}" between needs two different lines. Use mirror "x" to select a line and its reflection`);
      if (!layout.strips.some(({ gap }) => gap === -a - 1)) {
        error(`groups "${name}" has no strip between "${lines[a].name}" and its reflection. Use an off-centre first or last line with a strip across x = 0`);
      }
      gaps.push(-a - 1);
    }
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
    return mirror ? (a === b ? -a - 1 : Math.min(a, b)) : a;
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
interface Cage {
  points: CagePoint[];
  faces: CageFace[];
  rings: number[][];
  caps: Cap[];
  sharp: Map<number, number>;
}

function tipSample(samples: Sample[], axis: number, position: number, mirror: boolean): Sample {
  const first = samples[0].pos;
  const pos = samples.every((s) => dist(first, s.pos) <= CENTRE) ? first.slice() as Vec3
    : samples.reduce<Vec3>((a, { pos: b }) => [a[0] + b[0] / samples.length, a[1] + b[1] / samples.length, a[2] + b[2] / samples.length], [0, 0, 0]);
  if (mirror) pos[0] = 0;
  pos[axis] = position;
  return { pos, src: blend(samples.map((s) => s.src), samples.map(() => 1 / samples.length)) };
}

function makeCage(lines: Line[], layout: Layout, stations: number[], ends: [End, End], closed: boolean, axis: number, mirror: boolean, weights: number[][], warn: CookContext['warn']): Cage {
  const points: CagePoint[] = [], faces: CageFace[] = [], caps: Cage['caps'] = [];
  const { anchors, rows, strips } = layout;
  const last = stations.length - 1;
  const firstRing = Number(ends[0] === 'round'), lastRing = last - Number(ends[1] === 'round');
  if (firstRing > lastRing) error('ends "round" needs a ring before the tip. Add a station between the ends');
  if (last === 1 && ends[0] === 'point' && ends[1] === 'point') error('ends "point" at both ends needs at least 3 stations. Add a station between the tips');
  const tips = new Map<number, Sample>();
  const rings = stations.map((pos, station) => {
    const samples = sampleSection(lines, layout, pos, closed, axis);
    const end = station === 0 ? ends[0] : station === last ? ends[1] : 'open';
    if (end === 'round') {
      if (samples.some((s) => dist(s.pos, samples[0].pos) > CENTRE)) {
        error(`ends "round" needs the lines to meet at station ${station}. Bring them together at the tip or use "cap"`);
      }
      tips.set(station, tipSample(samples, axis, pos, mirror));
      return [];
    }
    if (end === 'point') {
      const id = points.length;
      points.push({ ...tipSample(samples, axis, pos, mirror), row: 0, station, line: -1, crease: 0 });
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
    return ids;
  });

  ends.forEach((mode, side) => {
    if (mode !== 'cap' && mode !== 'round') return;
    const station = side === 0 ? firstRing : lastRing;
    const ring = rings[station];
    caps.push(makeCap([...new Set(side === 0 ? ring.slice().reverse() : ring)], points, station, mirror, warn, tips.get(side === 0 ? 0 : last)));
  });
  const sharp = new Map<number, number>();
  for (let s = firstRing; s < lastRing; s++) {
    const lower = rings[s], upper = rings[s + 1];
    strips.forEach(({ a, b, gap }, col) => {
      const ids = [lower[a], lower[b], upper[b], upper[a]];
      const u0 = col / strips.length, u1 = (col + 1) / strips.length, v0 = s / last, v1 = (s + 1) / last;
      const uv: Vec3[] = [[u0, v0, 0], [u1, v0, 0], [u1, v1, 0], [u0, v1, 0]];
      const keep = ids.map((id, i) => id !== ids[(i + 3) % 4]);
      const corners = ids.filter((_, i) => keep[i]);
      if (corners.length < 3) return;
      faces.push({ ids: corners, uv: uv.filter((_, i) => keep[i]), row: Math.min(a, b), station: s, gap });
    });
  }
  for (let s = firstRing; s < lastRing; s++) for (let r = 0; r < rows.length; r++) {
    if (rows[r].step) continue;
    const a = rings[s][r], b = rings[s + 1][r];
    const weight = Math.min(points[a].crease, points[b].crease);
    if (weight > 0 && a !== b) sharp.set(edgeKey(a, b), weight);
  }
  // A hard rim isolates the flat cap from the side stencils during subdivision.
  for (const cap of caps) if (!cap.dome) cap.ids.forEach((a, i) => sharp.set(edgeKey(a, cap.ids[(i + 1) % cap.ids.length]), 10));
  return { points, faces, rings, caps, sharp };
}

interface Dome { tip: Vec3; offset: Vec3; profile: number[]; mirror: boolean }
interface Cap { ids: number[]; faces: number[][]; weights: Blend[]; dome?: Dome }

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

/** A round cap needs movable interior points, including on a small or odd loop. */
function roundPatch(loop: Vec3[], mirror: boolean): FillPatch {
  const n = loop.length;
  if (n === 3) return {
    points: [{ pos: newellOf(loop).c, i: [0, 1, 2], w: [1 / 3, 1 / 3, 1 / 3] }],
    faces: [[0, 1, -1], [1, 2, -1], [2, 0, -1]],
  };
  // Fit an even grid to an odd rim and keep the extra rim point in its boundary face.
  const omitted = n % 2 ? (mirror ? loop.findIndex((p) => Math.abs(p[0]) <= CENTRE) : n - 1) : -1;
  const ids = loop.map((_, i) => i).filter((i) => i !== omitted);
  const rim = ids.map((i) => loop[i]);
  const grid = fillPatch(rim, 'grid', 0);
  const patch = mirror ? mirroredGrid(rim, grid) : grid;
  if (!patch.points.length) {
    const m = rim.length;
    // An inset ring gives the grid independent controls even when it is only one quad wide.
    const indices = rim.map((_, i) => i);
    patch.faces = patch.faces.map((face) => face.map((i) => -i - 1));
    for (let i = 0; i < m; i++) {
      const next = (i + 1) % m;
      patch.faces.push([i, next, -next - 1, -i - 1]);
      const w = indices.map((j) => 0.5 / m + (i === j ? 0.5 : 0));
      patch.points.push({ pos: rim[i], i: indices, w });
    }
  }
  if (omitted < 0) return patch;
  const before = (omitted + n - 1) % n, after = (omitted + 1) % n;
  for (const p of patch.points) p.i = p.i.map((i) => ids[i]);
  patch.faces = patch.faces.map((face) => {
    const mapped = face.map((i) => i < 0 ? i : ids[i]);
    const edge = mapped.findIndex((a, k) => a === before && mapped[(k + 1) % mapped.length] === after);
    if (edge >= 0) mapped.splice(edge + 1, 0, omitted);
    return mapped;
  });
  return patch;
}

function makeCap(ids: number[], points: CagePoint[], station: number, mirror: boolean, warn: CookContext['warn'], tip?: Sample): Cap {
  if (ids.length < 3) error(`ends "${tip ? 'round' : 'cap'}" needs a loop at station ${station}. Add a ring before the tip or use "point"`);
  const loop = ids.map((i) => points[i].pos);
  let patch = tip ? roundPatch(loop, mirror) : fillPatch(loop, 'grid', 0);
  if (patch.note) warn(`lines_plan: ends "cap" at station ${station} used the quad fallback for its ${ids.length}-point loop. Use an even number of rows for a grid`);
  if (!tip && mirror) patch = mirroredGrid(loop, patch);

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
  if (!tip) return { ids, faces: patch.faces, weights };
  // Let deeper grid points rise further toward the tip. The rim has zero displacement.
  const profile = new Array<number>(weights.length).fill(0), queue: number[] = [];
  neighbours.forEach((ns, i) => {
    if ([...ns].some((j) => j >= 0)) { profile[i] = 1; queue.push(i); }
  });
  let peak = 1;
  for (let next = 0; next < queue.length; next++) {
    const i = queue[next];
    for (const j of neighbours[i]) if (j < 0 && !profile[-j - 1]) {
      profile[-j - 1] = peak = profile[i] + 1;
      queue.push(-j - 1);
    }
  }
  const centre = newellOf(loop).c;
  const offset = tip.pos.map((v, c) => mirror && c === 0 ? 0 : v - centre[c]) as Vec3;
  return { ids, faces: patch.faces, weights, dome: { tip: tip.pos, offset, profile: profile.map((v) => v / peak), mirror } };
}

function capCage(cage: Cage, positions: Vec3[], sources?: (Blend | null)[]) {
  const capFaces: number[][] = [];
  for (const { ids, faces, weights, dome } of cage.caps) {
    const offset = positions.length, loop = ids.map((i) => positions[i]);
    weights.forEach(({ i, w }, j) => {
      const p: Vec3 = [0, 0, 0];
      i.forEach((j, k) => { for (let c = 0; c < 3; c++) p[c] += loop[j][c] * w[k]; });
      if (dome) for (let c = 0; c < 3; c++) p[c] += dome.offset[c] * dome.profile[j];
      positions.push(p);
      sources?.push(blend(i.map((j) => cage.points[ids[j]].src), w));
    });
    for (const f of faces) capFaces.push(f.map((j) => j < 0 ? offset - j - 1 : ids[j]));
  }
  return capFaces;
}

function fitCage(cage: Cage, positions: Vec3[], levels: number): number {
  if (!levels) return 0;
  const sides = cage.faces.map((f) => f.ids);
  const n = positions.length;
  let start = n;
  const domes = cage.caps.flatMap(({ weights, dome }, i) => {
    const begin = start;
    start += weights.length;
    return dome ? [{ dome, begin, name: `cap_profile_${i}`, child: -1, gain: 0 }] : [];
  });
  for (let step = 0; ; step++) {
    const current = positions.slice();
    const capFaces = capCage(cage, current);
    let g = new Geometry({ positions: current.flat(), prims: [...sides, ...capFaces] });
    if (step === 0) for (const { name, dome, begin } of domes) {
      (g.points.add(name, 'float', 1).data as Float64Array).set(dome.profile, begin);
    }
    let sharp = cage.sharp.size ? cage.sharp : null;
    const child = Int32Array.from({ length: n }, (_, i) => i);
    for (let l = 0; l < levels; l++) {
      const r = subdivideLevel(g, true, 'smooth', sharp);
      for (let i = 0; i < n; i++) child[i] = r.vtxPt[child[i]];
      g = r.geo;
      sharp = r.sharp;
    }
    const P = g.P;
    let max = 0;
    const tipDeltas = domes.map((d) => {
      const { mirror, tip } = d.dome;
      if (step === 0) {
        // Subdivision applies the position stencil to float attributes, locating the grid crown
        // even when it is a child edge or face point rather than a cage vertex.
        const profile = g.points.get(d.name)!.data as Float64Array;
        let nearest = Infinity;
        for (let i = 0; i < profile.length; i++) {
          if (profile[i] <= 0 || profile[i] < d.gain - 1e-12 || (mirror && Math.abs(P[3 * i]) > CENTRE)) continue;
          const distance = dist(tip, point(P, i));
          if (profile[i] <= d.gain + 1e-12 && distance >= nearest) continue;
          d.child = i;
          d.gain = profile[i];
          nearest = distance;
        }
        if (d.child < 0) error('ends "round" could not find a crown on the cap. Add rows or turn off mirroring');
      }
      const p = point(P, d.child), shift = tip.map((v, c) => v - p[c]) as Vec3;
      max = Math.max(max, Math.hypot(...shift));
      return shift.map((v, c) => mirror && c === 0 ? 0 : v / d.gain);
    });
    const delta = cage.points.map(({ pos }, i): Vec3 => {
      const j = child[i] * 3;
      const d: Vec3 = [pos[0] - P[j], pos[1] - P[j + 1], pos[2] - P[j + 2]];
      max = Math.max(max, Math.hypot(...d));
      return d;
    });
    if (!Number.isFinite(max)) error('fit_levels could not fit these sections. Separate overlapping lines or lower fit_levels');
    if (max < 0.00005 || step === 100) return max;
    tipDeltas.forEach((d, i) => d.forEach((v, c) => { domes[i].dome.offset[c] += v; }));
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
  b.skip.point.add(CREASE);
  b.skip.vertex.add(CREASE);
  const row = b.attrib('point', 'row', 1, 'int'), line = b.attrib('point', 'line', 1, 'string');
  const station = b.attrib('point', 'station', 1, 'int');
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
    for (let s = 0; s + 1 < cage.rings.length; s++) {
      if (cage.rings[s].length && cage.rings[s + 1].length) group.add(cage.rings[s][r], cage.rings[s + 1][r]);
    }
  });
  const geo = b.build();
  const out = topologyReport(geo).closed ? orientOutward(geo) : geo;
  writeCreaseAttrib(out, CREASE, 'vertex', cage.sharp);
  out.detail.add('fit_error', 'float', 1).set(0, fitError);
  return out;
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
    'Four to seven well-placed points per line read smoother than many, and cv helps when the numbers are rough. ' +
    'Use round for noses, tips and domes, and point only for a sharp tip. ' +
    'Place an intake, lamp or outlet face with stations and rows_between, select it with groups, and inset and push it in with poly_extrude before subdivide to avoid jagged or cross-shaped openings. ' +
    'Count a quad mesh’s triangles with nvertices(0) - 2 * nprims(0) and keep the output in quads. ' +
    'Match fit_levels to the levels in subdivide so the surface passes through the sampled lines.',
  inputs: [{ name: 'lines', optional: true, desc: 'open curves in section order with prim string name (defaults to line0, line1 and so on)' }],
  splines: 'keep',
  params: {
    lines: { type: 'json', default: pod, readsGiven: true, desc: 'feature line names and [x,y,z] points in metres in section order. A small pod is used when no curves are connected' },
    axis: { type: 'enum', default: 'z', options: ['x', 'y', 'z'], desc: 'length axis for station positions in metres. Defaults to z, with the front toward +z. Use mirror none along x' },
    interpolation: { type: 'enum', default: 'smooth', options: ['smooth', 'linear', 'cv'], desc: 'Smooth passes a shape-preserving cubic through the points. Linear joins the points with straight segments. CV uses the points as controls for a clamped uniform cubic B-spline that passes through both endpoints.' },
    stations: { type: 'json', default: 12, desc: 'count or strictly ascending axis positions in metres. Defaults to 12 evenly spaced stations across the shared line range' },
    mirror: { type: 'enum', default: 'x', options: ['x', 'none'], desc: 'x mirrors the positive x half and shares centre lines by default. Use none for a full section' },
    closed: { type: 'bool', default: true, desc: 'join the section into a loop by default. For an open mirrored section, leave at least one end line off x = 0' },
    rows_between: { type: 'json', default: 0, desc: 'extra rows per line gap, as a count or a list of counts. Defaults to zero. Closed sections without mirroring include the last-to-first gap' },
    ends: { type: 'json', default: 'cap', desc: 'open, cap, round, point, or a pair in ascending station order. Cap keeps a flat grid inside a sharp rim. Round fits a dome to the tip where the lines meet. Point makes a sharp tip' },
    creases: { type: 'json', default: {}, desc: 'line names with subdivision sharpness weights or [axis position in metres, weight] keys. Defaults to no creases. Keys interpolate linearly and are zero outside their range' },
    groups: { type: 'json', default: {}, desc: 'named face selections with between: [line, line] and optional from and to in metres, snapped to the nearest stations. Repeat a boundary line name to select the strip across its mirror. Unmirrored closed sections read between in section order' },
    fit_levels: { type: 'int', default: 2, min: 0, max: 4, desc: 'number of subdivision levels to fit, two by default. Zero puts cage points directly on the sampled sections' },
  },
  outputs: 'point row (int), line (string), station (int); prim row and station (int), prim groups sides, caps and groups; edge groups line_<name>; vertex uv and creaseweight (float); detail fit_error (float, metres)',
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
        ends: 'round',
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
    const groups = sectionGroups(p.groups, lines, stations, !mirror && p.closed, mirror, layout);
    const cage = makeCage(lines, layout, stations, ends, p.closed, axis, mirror, weights, warn);
    const positions = cage.points.map(({ pos }) => pos.slice() as Vec3);
    const fitError = fitCage(cage, positions, p.fit_levels);
    if (fitError > 0.001) warn(`lines_plan: fit_levels ${p.fit_levels} left a ${fitError.toFixed(6)} m fit error. Try more rows or stations, or a lower fit_levels`);
    return buildCage(cage, positions, layout, lines, groups, src, fitError);
  },
});
