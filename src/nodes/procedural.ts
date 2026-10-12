// Procedural generators: L-systems, text, 2D Voronoi / Delaunay.
import { GeoBuilder, Geometry } from '../core/geometry.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import { rng } from '../core/random.ts';
import { cross, dot, length, normalize, qAxisAngle, qRotate } from '../core/math.ts';
import type { Vec3 } from '../core/math.ts';
import { M, crossSectionFaces, fromManifold, planeMatrix, polygonsToGeo, propLayout } from '../core/manifold.ts';
import { Delaunay } from 'd3-delaunay';
import { FRAMES, P } from './util.ts';
import opentype from 'opentype.js';

// ---------------------------------------------------------------- L-system

interface Tok { s: string; arg: number | null }

function parseTokens(str: string): Tok[] {
  const out: Tok[] = [];
  for (let i = 0; i < str.length; i++) {
    const s = str[i];
    if (/\s/.test(s)) continue;
    let arg: number | null = null;
    if (str[i + 1] === '(') {
      const j = str.indexOf(')', i + 2);
      if (j > 0) { arg = Number(str.slice(i + 2, j)); i = j; }
    }
    out.push({ s, arg });
  }
  return out;
}

defineNode({
  type: 'lsystem',
  category: 'generate',
  summary: 'Lindenmayer system: grammar rewriting + 3D turtle → branching curves (with width) and leaf points. Plants, trees, fractals.',
  aliases: ['l_system', 'turtle', 'plant', 'tree'],
  description:
    'Turtle starts at the origin heading +Y. Symbols: F/G draw forward, f/g move without drawing, + - yaw, & ^ pitch, \\ / roll, | turn around, ' +
    '[ ] push/pop branch, ! shrink width (width_scale), " scale step (step_scale), J K M emit leaf points (groups J/K/M + leaves) with N/up/orient/pscale. ' +
    'A number in parentheses overrides the step or angle: F(0.5) +(10). Rules: {"F": "FF-[-F+F]+[+F-F]"}; stochastic: {"F": [["F[+F]F", 0.6], ["F[-F]F", 0.4]]}.',
  inputs: [],
  params: {
    axiom: { type: 'string', default: 'A', desc: 'start string', aliases: ['premise', 'start'] },
    rules: { type: 'json', default: { A: 'F[&+A][&-A][^A]', F: 'F' }, desc: 'rewrite rules: {symbol: replacement} or {symbol: [[replacement, weight], ...]}' },
    generations: { type: 'int', default: 5, min: 0, max: 16, desc: 'rewrite iterations', aliases: ['iterations', 'depth'] },
    angle: { type: 'float', default: 28, desc: 'turn angle in degrees' },
    step: { type: 'float', default: 0.3, desc: 'forward step length', aliases: ['length', 'step_size'] },
    step_scale: { type: 'float', default: 0.9, desc: 'multiplier applied by "' },
    width: { type: 'float', default: 0.08, desc: 'initial branch diameter (point attribute width)' },
    width_scale: { type: 'float', default: 0.7, desc: 'multiplier applied by !' },
    auto_taper: { type: 'bool', default: true, desc: 'also shrink width and step on each [ branch' },
    branch_scale: { type: 'float', default: 0.85, desc: 'auto_taper step multiplier per branch level' },
    angle_variance: { type: 'float', default: 0, min: 0, desc: 'random ± degrees added to every turn' },
    step_variance: { type: 'float', default: 0, min: 0, max: 1, desc: 'random ± fraction on every step' },
    tropism: { type: 'vec3', default: [0, -1, 0], desc: 'bending direction (e.g. gravity)' },
    tropism_strength: { type: 'float', default: 0, desc: 'bending amount per step (0 = off; ~0.05-0.3)' },
    seed: P.seed(),
    max_length: { type: 'int', default: 400000, min: 1, desc: 'safety cap on the expanded string length' },
  },
  outputs: 'polylines with point width/depth, prim depth; leaf points in groups leaves, J, K, M with N, up, orient, pscale',
  cook: ({ p }) => {
    const r = rng(p.seed + 0.25);
    const rules: Record<string, [string, number][]> = {};
    for (const [k, v] of Object.entries(p.rules ?? {})) {
      if (typeof v === 'string') rules[k] = [[v, 1]];
      else if (Array.isArray(v)) rules[k] = v.map((x: any) => (Array.isArray(x) ? [String(x[0]), Number(x[1] ?? 1)] : [String(x), 1]));
      else throw new NodeError(`rule for "${k}" must be a string or [[replacement, weight], ...]`);
    }
    let str = String(p.axiom);
    for (let gen = 0; gen < p.generations; gen++) {
      let next = '';
      for (let i = 0; i < str.length; i++) {
        const c = str[i];
        let suffix = '';
        if (str[i + 1] === '(') { const j = str.indexOf(')', i + 2); if (j > 0) { suffix = str.slice(i + 1, j + 1); i = j; } }
        const rule = rules[c];
        if (!rule) { next += c + suffix; continue; }
        let pick = rule[0][0];
        if (rule.length > 1) {
          const tot = rule.reduce((s, x) => s + x[1], 0);
          let x = r() * tot;
          for (const [rep, w] of rule) { if ((x -= w) <= 0) { pick = rep; break; } }
        }
        next += pick;
        if (next.length > p.max_length) throw new NodeError(`L-system string exceeded ${p.max_length} symbols at generation ${gen + 1}; lower generations`);
      }
      str = next;
    }
    const toks = parseTokens(str);
    const b = new GeoBuilder();
    const wA = b.attrib('point', 'width', 1), dA = b.attrib('point', 'depth', 1, 'int');
    const pdA = b.attrib('prim', 'depth', 1, 'int');
    const leafN = b.attrib('point', 'N', 3), leafUp = b.attrib('point', 'up', 3), leafS = b.attrib('point', 'pscale', 1);
    const leafG = b.group('point', 'leaves');
    const symG: Record<string, Set<number>> = { J: b.group('point', 'J'), K: b.group('point', 'K'), M: b.group('point', 'M') };
    interface T { pos: Vec3; H: Vec3; L: Vec3; U: Vec3; w: number; step: number; depth: number; cur: number[] | null; last: number }
    let t: T = { pos: [0, 0, 0], H: [0, 1, 0], L: [-1, 0, 0], U: [0, 0, 1], w: p.width, step: p.step, depth: 0, cur: null, last: -1 };
    const stack: T[] = [];
    const prims: { pts: number[]; depth: number }[] = [];
    const rot = (axis: Vec3, deg: number) => {
      const q = qAxisAngle(axis, deg);
      t.H = normalize(qRotate(q, t.H)); t.L = normalize(qRotate(q, t.L)); t.U = normalize(qRotate(q, t.U));
    };
    const jitter = () => (p.angle_variance ? (r() * 2 - 1) * p.angle_variance : 0);
    const newPt = () => { const id = b.addPoint(t.pos[0], t.pos[1], t.pos[2]); wA.set(id, t.w); dA.set(id, t.depth); return id; };
    const endCurve = () => { if (t.cur && t.cur.length >= 2) prims.push({ pts: t.cur, depth: t.depth }); t.cur = null; };
    const trop = normalize(p.tropism);
    for (const { s, arg } of toks) {
      switch (s) {
        case 'F': case 'G': {
          if (!t.cur) t.cur = [newPt()];
          let st = arg ?? t.step;
          if (p.step_variance) st *= 1 + (r() * 2 - 1) * p.step_variance;
          t.pos = [t.pos[0] + t.H[0] * st, t.pos[1] + t.H[1] * st, t.pos[2] + t.H[2] * st];
          if (p.tropism_strength) {
            const ax = cross(t.H, trop), l = length(ax);
            if (l > 1e-6) rot(ax, (p.tropism_strength * l * 180) / Math.PI);
          }
          t.cur.push(newPt());
          break;
        }
        case 'f': case 'g': {
          endCurve();
          const st = arg ?? t.step;
          t.pos = [t.pos[0] + t.H[0] * st, t.pos[1] + t.H[1] * st, t.pos[2] + t.H[2] * st];
          break;
        }
        case '+': rot(t.U, (arg ?? p.angle) + jitter()); break;
        case '-': rot(t.U, -((arg ?? p.angle) + jitter())); break;
        case '&': rot(t.L, (arg ?? p.angle) + jitter()); break;
        case '^': rot(t.L, -((arg ?? p.angle) + jitter())); break;
        case '\\': rot(t.H, (arg ?? p.angle) + jitter()); break;
        case '/': rot(t.H, -((arg ?? p.angle) + jitter())); break;
        case '|': rot(t.U, 180); break;
        case '!': t.w *= arg ?? p.width_scale; break;
        case '"': t.step *= arg ?? p.step_scale; break;
        case '[': {
          stack.push({ ...t, pos: [...t.pos] as Vec3, H: [...t.H] as Vec3, L: [...t.L] as Vec3, U: [...t.U] as Vec3, cur: t.cur });
          t = { ...t, cur: null, depth: t.depth + 1 };
          if (p.auto_taper) { t.w *= p.width_scale; t.step *= p.branch_scale; }
          break;
        }
        case ']': {
          endCurve();
          const prev = stack.pop();
          if (prev) t = prev;
          break;
        }
        case 'J': case 'K': case 'M': {
          const id = b.addPoint(t.pos[0], t.pos[1], t.pos[2]);
          leafN.set(id, t.H); leafUp.set(id, t.U); leafS.set(id, arg ?? t.step);
          wA.set(id, t.w); dA.set(id, t.depth);
          leafG.add(id); symG[s].add(id);
          break;
        }
        default: break;
      }
    }
    endCurve();
    while (stack.length) { t = stack.pop()!; endCurve(); }
    for (const pr of prims) { const id = b.addPrim(pr.pts, false); pdA.set(id, pr.depth); }
    const g = b.build();
    // orient for leaves (from N/up), so copy_to_points works with either convention
    return g;
  },
});

// ---------------------------------------------------------------- text

const fontFailed = new Map<string, string>();
const fontCache = new Map<string, any>();

function flattenPath(cmds: any[], segs: number): number[][][] {
  const contours: number[][][] = [];
  let cur: number[][] = [];
  let x = 0, y = 0;
  for (const c of cmds) {
    if (c.type === 'M') { if (cur.length > 2) contours.push(cur); cur = [[c.x, -c.y]]; x = c.x; y = c.y; }
    else if (c.type === 'L') { cur.push([c.x, -c.y]); x = c.x; y = c.y; }
    else if (c.type === 'Q') {
      for (let k = 1; k <= segs; k++) { const t = k / segs, a = (1 - t) ** 2, b = 2 * (1 - t) * t, d = t * t; cur.push([a * x + b * c.x1 + d * c.x, -(a * y + b * c.y1 + d * c.y)]); }
      x = c.x; y = c.y;
    } else if (c.type === 'C') {
      for (let k = 1; k <= segs; k++) {
        const t = k / segs, a = (1 - t) ** 3, b = 3 * (1 - t) ** 2 * t, d = 3 * (1 - t) * t * t, e = t ** 3;
        cur.push([a * x + b * c.x1 + d * c.x2 + e * c.x, -(a * y + b * c.y1 + d * c.y2 + e * c.y)]);
      }
      x = c.x; y = c.y;
    } else if (c.type === 'Z') { if (cur.length > 2) contours.push(cur); cur = []; }
  }
  if (cur.length > 2) contours.push(cur);
  // drop duplicate closing points
  return contours.map((ct) => {
    const a = ct[0], z = ct[ct.length - 1];
    return Math.hypot(a[0] - z[0], a[1] - z[1]) < 1e-9 ? ct.slice(0, -1) : ct;
  });
}

defineNode({
  type: 'text',
  category: 'generate',
  summary: 'Text from a TrueType/OpenType font: filled faces, outlines, or extruded solid. Lies in the XY plane facing +Z.',
  aliases: ['font', 'type', 'lettering'],
  inputs: [],
  params: {
    text: { type: 'string', default: 'Polyforge', desc: 'text (use \\n for new lines)' },
    font: { type: 'string', default: '', desc: 'font file path or family name ("" = system default sans)' },
    size: { type: 'float', default: 1, desc: 'font size (em height in units)' },
    align: { type: 'enum', options: ['left', 'center', 'right'], default: 'center', desc: 'horizontal alignment' },
    valign: { type: 'enum', options: ['baseline', 'center', 'bottom', 'top'], default: 'bottom', desc: 'vertical alignment' },
    depth: { type: 'float', default: 0, min: 0, desc: 'extrusion depth (> 0 makes a solid)' },
    output: { type: 'enum', options: ['auto', 'faces', 'outlines', 'solid'], default: 'auto', desc: 'auto = solid if depth > 0, else faces' },
    line_spacing: { type: 'float', default: 1.2, desc: 'line height as a multiple of size' },
    curve_segments: { type: 'int', default: 6, min: 1, max: 32, desc: 'segments per glyph curve' },
    center: P.center(),
  },
  signatureExtra: (p, engine) => engine.host.findFont(p.font || undefined) ?? 'nofont',
  async cook({ p, engine, warn }) {
    const host = engine.host;
    const name = p.font || undefined;
    const candidates = host.fontCandidates?.(name) ?? [host.findFont(name)].filter((f): f is string => !!f);
    if (!candidates.length) throw new NodeError(`font "${p.font || '(default)'}" not found; give a .ttf/.otf path`);
    // not every system font parses (opentype.js rejects some GSUB tables), so try the candidates in order
    let font: any = null;
    const failures: string[] = [];
    for (const path of candidates) {
      const cached = fontCache.get(path);
      if (cached) { font = cached; break; }
      if (fontFailed.has(path)) { failures.push(`${path}: ${fontFailed.get(path)}`); continue; }
      const bytes = await host.readFile(path);
      try { font = opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)); }
      catch (e: any) { fontFailed.set(path, e.message); failures.push(`${path}: ${e.message}`); continue; }
      fontCache.set(path, font);
      break;
    }
    if (!font) throw new NodeError(`cannot parse any font for "${p.font || '(default)'}"`, failures.join('; '));
    if (failures.length && !name) warn(`skipped unparsable font(s): ${failures.map((f) => f.split(':')[0]).join(', ')}`);
    const lines = String(p.text).split(/\\n|\n/);
    let polys: number[][][] = [];
    const lineH = p.size * p.line_spacing;
    lines.forEach((line, li) => {
      const path0 = font.getPath(line, 0, li * lineH, p.size, { kerning: true });
      let cs = flattenPath(path0.commands, p.curve_segments);
      if (p.align !== 'left' && cs.length) {
        const w = font.getAdvanceWidth(line, p.size, { kerning: true });
        const dx = p.align === 'center' ? -w / 2 : -w;
        cs = cs.map((c) => c.map(([x, y]) => [x + dx, y]));
      }
      polys.push(...cs);
    });
    if (!polys.length) return new Geometry();
    let ymin = Infinity, ymax = -Infinity;
    for (const c of polys) for (const q of c) { ymin = Math.min(ymin, q[1]); ymax = Math.max(ymax, q[1]); }
    const dy = p.valign === 'center' ? -(ymin + ymax) / 2 : p.valign === 'bottom' ? -ymin : p.valign === 'top' ? -ymax : 0;
    polys = polys.map((c) => c.map(([x, y]) => [x + p.center[0], y + dy + p.center[1]]));
    const W = M();
    const cs = new W.CrossSection(polys, 'NonZero');
    const mode = p.output === 'auto' ? (p.depth > 0 ? 'solid' : 'faces') : p.output;
    let g: Geometry;
    if (mode === 'solid') {
      const m = cs.extrude(Math.max(p.depth, 1e-4));
      const mt = m.translate([0, 0, p.center[2] - p.depth / 2]);
      g = fromManifold(mt, propLayout([])).geo;
      m.delete(); mt.delete();
    } else if (mode === 'outlines') g = polygonsToGeo(cs.toPolygons(), 'xy', p.center[2]);
    else g = crossSectionFaces(cs, 'xy', p.center[2]);
    cs.delete();
    return g;
  },
});

// ---------------------------------------------------------------- 2D Voronoi / Delaunay

function planarPoints(g: Geometry, plane: keyof typeof FRAMES) {
  const F = FRAMES[plane], Pd = g.P;
  const uv: [number, number][] = [];
  let off = 0;
  for (let i = 0; i < g.numPoints; i++) {
    const x = Pd[i * 3], y = Pd[i * 3 + 1], z = Pd[i * 3 + 2];
    uv.push([x * F.U[0] + y * F.U[1] + z * F.U[2], x * F.V[0] + y * F.V[1] + z * F.V[2]]);
    off += x * F.N[0] + y * F.N[1] + z * F.N[2];
  }
  return { uv, off: g.numPoints ? off / g.numPoints : 0 };
}

defineNode({
  type: 'voronoi2d',
  category: 'curve',
  summary: '2D Voronoi cells around points (on a plane), clipped to a rectangle; site attributes copied to cells. City blocks, cracks, tiles.',
  aliases: ['voronoi_cells', 'voronoi_2d'],
  inputs: [{ name: 'sites', desc: 'points (optional: random sites are generated)', optional: true }],
  params: {
    count: { type: 'int', default: 30, min: 1, desc: 'random sites when no input' },
    size: { type: 'vec2', default: [10, 10], desc: 'clip rectangle size (centered at center); [0,0] = sites bbox + 10%' },
    center: P.center(),
    plane: P.plane('xz'),
    inset: { type: 'float', default: 0, min: 0, desc: 'shrink each cell (gap between cells)' },
    relax: { type: 'int', default: 0, min: 0, max: 50, desc: 'Lloyd relaxation iterations (more even cells)' },
    seed: P.seed(),
  },
  outputs: 'closed polygons with prim class (cell id) and site attributes',
  cook: ({ inputs, p }) => {
    const F = FRAMES[p.plane as keyof typeof FRAMES];
    const src = inputs[0] ?? null;
    let sites: [number, number][], off = 0;
    const cu = p.center[0] * F.U[0] + p.center[1] * F.U[1] + p.center[2] * F.U[2];
    const cv = p.center[0] * F.V[0] + p.center[1] * F.V[1] + p.center[2] * F.V[2];
    if (src && src.numPoints) { const pp = planarPoints(src, p.plane); sites = pp.uv; off = pp.off; }
    else {
      const r = rng(p.seed + 9.1);
      sites = Array.from({ length: p.count }, () => [cu + (r() - 0.5) * p.size[0], cv + (r() - 0.5) * p.size[1]]);
      off = p.center[0] * F.N[0] + p.center[1] * F.N[1] + p.center[2] * F.N[2];
    }
    let bounds: [number, number, number, number];
    if (p.size[0] > 0 && p.size[1] > 0) bounds = [cu - p.size[0] / 2, cv - p.size[1] / 2, cu + p.size[0] / 2, cv + p.size[1] / 2];
    else {
      const xs = sites.map((s) => s[0]), ys = sites.map((s) => s[1]);
      const mx = (Math.max(...xs) - Math.min(...xs)) * 0.1 + 1e-3, my = (Math.max(...ys) - Math.min(...ys)) * 0.1 + 1e-3;
      bounds = [Math.min(...xs) - mx, Math.min(...ys) - my, Math.max(...xs) + mx, Math.max(...ys) + my];
    }
    for (let it = 0; it <= p.relax; it++) {
      const vor = Delaunay.from(sites).voronoi(bounds);
      if (it === p.relax) {
        let cells: number[][][] = [];
        const ids: number[] = [];
        for (let i = 0; i < sites.length; i++) {
          const poly = vor.cellPolygon(i);
          if (!poly) continue;
          cells.push(poly.slice(0, -1) as number[][]);
          ids.push(i);
        }
        if (p.inset > 0) {
          const W = M();
          cells = cells.map((c) => {
            const cs = new W.CrossSection([c], 'Positive');
            const o = cs.offset(-p.inset, 'Miter', 2);
            const pl = o.toPolygons();
            cs.delete(); o.delete();
            return pl[0] ?? [];
          });
        }
        const keep = cells.map((c) => c.length >= 3);
        const g = polygonsToGeo(cells.filter((_, k) => keep[k]) as [number, number][][], p.plane, off);
        const kept = ids.filter((_, k) => keep[k]);
        (g.prims.add('class', 'int', 1).data as Int32Array).set(kept);
        if (src) for (const [name, a] of src.points.map) {
          if (name === 'P') continue;
          const d = g.prims.add(name, a.type, a.size);
          kept.forEach((s, k) => d.set(k, a.get(s)));
        }
        return g;
      }
      // Lloyd step
      sites = sites.map((s, i) => {
        const poly = vor.cellPolygon(i);
        if (!poly) return s;
        let ax = 0, ay = 0, A = 0;
        for (let k = 0; k < poly.length - 1; k++) {
          const [x0, y0] = poly[k], [x1, y1] = poly[k + 1], c = x0 * y1 - x1 * y0;
          A += c; ax += (x0 + x1) * c; ay += (y0 + y1) * c;
        }
        return Math.abs(A) > 1e-12 ? [ax / (3 * A), ay / (3 * A)] : s;
      });
    }
    return new Geometry();
  },
});

defineNode({
  type: 'triangulate2d',
  category: 'curve',
  summary: 'Delaunay-triangulate points projected on a plane (keeps 3D positions) — terrain from point samples, meshes from scatters.',
  aliases: ['delaunay', 'triangulate_2d'],
  inputs: [{ name: 'points', desc: 'points' }],
  params: {
    plane: P.plane('xz'),
    max_edge: { type: 'float', default: 0, min: 0, desc: 'drop triangles with an edge longer than this (0 = keep all)' },
  },
  cook: ({ input, p }) => {
    const g = input(0);
    if (g.numPoints < 3) throw new NodeError('need at least 3 points');
    const { uv } = planarPoints(g, p.plane);
    const d = Delaunay.from(uv);
    const out = g.clone();
    const prims: number[][] = [];
    const Pd = g.P;
    const el = (a: number, b: number) => Math.hypot(Pd[a * 3] - Pd[b * 3], Pd[a * 3 + 1] - Pd[b * 3 + 1], Pd[a * 3 + 2] - Pd[b * 3 + 2]);
    // collinear points: d3-delaunay jitters them into zero-area slivers; fewer than 3 distinct points: -1 / repeated ids
    const flat = !!(d as any).collinear;
    for (let t = 0; t < d.triangles.length && !flat; t += 3) {
      const a = d.triangles[t], b = d.triangles[t + 1], c = d.triangles[t + 2];
      if (a < 0 || b < 0 || c < 0 || a === b || b === c || a === c) continue;
      if (p.max_edge > 0 && Math.max(el(a, b), el(b, c), el(c, a)) > p.max_edge) continue;
      prims.push([a, c, b]);
    }
    const tri = new Geometry({ positions: g.P, prims });
    tri.points = out.points;
    tri.pointGroups = out.pointGroups;
    tri.detail = out.detail;
    // make faces point along the plane normal
    const N = FRAMES[p.plane as keyof typeof FRAMES].N;
    if (prims.length) {
      const [a, b, c] = prims[0];
      const u = [Pd[b * 3] - Pd[a * 3], Pd[b * 3 + 1] - Pd[a * 3 + 1], Pd[b * 3 + 2] - Pd[a * 3 + 2]];
      const v = [Pd[c * 3] - Pd[a * 3], Pd[c * 3 + 1] - Pd[a * 3 + 1], Pd[c * 3 + 2] - Pd[a * 3 + 2]];
      if (dot(cross(u as Vec3, v as Vec3), N) < 0) for (let t = 0; t < tri.numPrims; t++) tri.vertexPoint.subarray(tri.primStart[t], tri.primStart[t + 1]).reverse();
    }
    return tri;
  },
});

export { planeMatrix };
