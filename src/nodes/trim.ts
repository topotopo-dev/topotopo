// Trim sheets: the sheet description node, the trim options shared by the nodes that build strips (sweep, polywire,
// tube, extrude), and mapping of any faces onto a band (trim_map). The record and conventions are in core/trim.ts.
import { Geometry, GeoBuilder } from '../core/geometry.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import type { CookContext, ParamDef } from '../graph/types.ts';
import {
  TRIM_BAND_ATTRIB, TRIM_SHEET_ATTRIB, bandList, describeSheet, pathU, readTrimSheets, region, regionNames, writeTrimSheets,
} from '../core/trim.ts';
import type { TrimRegion, TrimSheet, TrimTable } from '../core/trim.ts';
import { buildStrips, cutCourses, faceNormals, matchRegion } from '../core/trimmap.ts';
import { mask, P } from './util.ts';
import { hash32 } from '../core/random.ts';

/** The trim options of a strip-building node; `around` names what its profile is. */
export function trimParams(around: string): Record<string, ParamDef> {
  return {
    trim_band: {
      type: 'string', default: '',
      desc: `trim sheet band (or rectangle) to map onto ("" = the node's own uv): u runs along the path at the band's period, v fills the band across ${around}. A comma list ("stone, coping") gives one band per segment of ${around}, cycled. "sheet:band" picks a sheet when several are carried. Help topic trim_sheets.`,
      aliases: ['trim'],
    },
    trim_around: {
      type: 'enum', options: ['wrap', 'faces'], default: 'wrap',
      desc: `wrap: consecutive segments of ${around} on the same band share it by length (one band wrapped round); faces: every segment fills the whole band`,
    },
    trim_cap: { type: 'string', default: '', desc: 'band for the caps at real size ("" = the sheet\'s first band of kind cap, else the first trim_band)' },
    trim_offset: { type: 'float', default: 0, desc: 'shift u along the path, metres (staggers the joints of pieces side by side)' },
  };
}

export interface TrimTarget {
  sheet: TrimSheet;
  /** one region per profile segment, cycled */
  sides: TrimRegion[];
  cap: TrimRegion;
  mode: 'wrap' | 'faces';
  offset: number;
}

/** The sheets a node maps onto: its sheet input when wired, else the ones the geometry carries. */
export function sheetsFor(ctx: CookContext, sheetInput: number, g: Geometry): TrimTable {
  return ctx.hasInput(sheetInput) ? readTrimSheets(ctx.input(sheetInput)) : readTrimSheets(g);
}

/** A band reference ("band" or "sheet:band") resolved in the table. */
export function pickRegion(table: TrimTable, ref: string, inputName: string): { sheet: TrimSheet; region: TrimRegion } {
  const sheets = Object.values(table);
  if (!sheets.length) throw new NodeError(`band "${ref}" needs a trim sheet: wire a trim_sheet node into the ${inputName} input, or map geometry that carries one (help topic trim_sheets)`);
  const colon = ref.indexOf(':');
  if (colon >= 0) {
    const s = table[ref.slice(0, colon)], name = ref.slice(colon + 1);
    if (!s) throw new NodeError(`no trim sheet "${ref.slice(0, colon)}" (there are: ${Object.keys(table).join(', ')})`);
    const r = region(s, name);
    if (!r) throw new NodeError(`sheet "${s.name}" has no band or rectangle "${name}" (it has: ${regionNames(s).join(', ')})`);
    return { sheet: s, region: r };
  }
  const hits = sheets.filter((s) => region(s, ref));
  if (hits.length > 1) throw new NodeError(`"${ref}" is in sheets ${hits.map((s) => s.name).join(' and ')}: name it as "${hits[0].name}:${ref}"`);
  if (!hits.length) throw new NodeError(`no band or rectangle "${ref}" in ${sheets.map((s) => `sheet "${s.name}" (it has: ${regionNames(s).join(', ')})`).join('; ')}`);
  return { sheet: hits[0], region: region(hits[0], ref)! };
}

/** The node's trim target, or null when trim_band is empty. */
export function trimTarget(ctx: CookContext, sheetInput: number, g: Geometry, inputName = 'sheet'): TrimTarget | null {
  const refs = bandList(ctx.p.trim_band);
  if (!refs.length) return null;
  const table = sheetsFor(ctx, sheetInput, g);
  const picked = refs.map((r) => pickRegion(table, r, inputName));
  const sheet = picked[0].sheet;
  if (picked.some((x) => x.sheet !== sheet)) throw new NodeError(`trim_band names bands of several sheets (${[...new Set(picked.map((x) => x.sheet.name))].join(', ')}): one node maps onto one sheet`);
  const capRef = String(ctx.p.trim_cap ?? '').trim();
  const capBand = sheet.bands.find((b) => b.kind === 'cap');
  const cap = capRef ? pickRegion({ [sheet.name]: sheet }, capRef.includes(':') ? capRef.slice(capRef.indexOf(':') + 1) : capRef, inputName).region
    : capBand ? region(sheet, capBand.name)! : picked[0].region;
  return { sheet, sides: picked.map((x) => x.region), cap, mode: ctx.p.trim_around === 'faces' ? 'faces' : 'wrap', offset: ctx.p.trim_offset ?? 0 };
}

/**
 * Name the sheet and band of mapped prims (null = leave the prim as it is) and carry the sheet on the geometry.
 * Mutates g: call it on geometry the node built.
 */
export function stampTrim(g: Geometry, sheet: TrimSheet, bandOf: (string | null)[]): void {
  const bandA = g.prims.add(TRIM_BAND_ATTRIB, 'string', 1, ''), sheetA = g.prims.add(TRIM_SHEET_ATTRIB, 'string', 1, '');
  for (let p = 0; p < g.numPrims; p++) {
    const b = bandOf[p];
    if (b === null || b === undefined) continue;
    bandA.set(p, b); sheetA.set(p, sheet.name);
  }
  writeTrimSheets(g, { ...readTrimSheets(g), [sheet.name]: sheet });
}

// ---------------------------------------------------------------- trim_sheet

defineNode({
  type: 'trim_sheet',
  category: 'uv',
  summary: 'Describe a trim sheet once: named bands that tile along u (and hotspot rectangles) at a real size. Mapping, baking, the uv report and the sheet view read it.',
  description:
    'A trim sheet is one texture whose horizontal bands each hold a strip of surface that repeats along u: stone ' +
    'courses, a coping, a step nosing, a metal edge. Bands stack from the top of the image downwards; each is height ' +
    'metres tall, so it takes height × texels_per_metre pixel rows (or give rows: [top, bottom] in pixels). Along u a ' +
    'band repeats every period metres (default: the sheet width, resolution[0] / texels_per_metre). kind marks what a ' +
    'band is for: surface, edge (a rounded or bevelled edge strip) or cap (end caps of sweeps and tubes). bevel is the ' +
    'width of the 45° chamfer trim_layout bakes into the band\'s borders. Rectangles below the bands are hotspots: ' +
    'rect [x, y, width, height] in pixels from the top-left (as Hammer++ .rect files), fitted by hotspot. The output ' +
    'carries no geometry, only the sheet (detail trim_sheets): wire it into the sheet input of sweep, polywire, tube, ' +
    'extrude, trim_map, hotspot or trim_layout. Search words: trim sheet, trim band, hotspot, texture a railing, uvs ' +
    'along a path. Help topic trim_sheets.',
  aliases: ['trim', 'trimsheet', 'ultimate_trim', 'hotspot_sheet'],
  inputs: [],
  params: {
    name: { type: 'string', default: 'trim', desc: 'sheet name (mapped prims carry it in trim_sheet; materials may share it)', aliases: ['sheet'] },
    resolution: {
      type: 'ivec2', default: [1024, 1024], min: 1, max: 8192,
      desc: 'sheet image size in pixels [width, height]; the bakes default to it', aliases: ['res', 'image_size'],
    },
    texels_per_metre: { type: 'float', default: 512, min: 1, desc: 'texel density: pixels per metre on the model (the sheet width in metres is resolution[0] / this)', aliases: ['texel_density', 'px_per_m', 'tpm'] },
    bands: {
      type: 'json',
      default: [{ name: 'wall', height: 1 }, { name: 'edge', height: 0.25, kind: 'edge' }, { name: 'trim', height: 0.25, bevel: 0.01 }, { name: 'cap', height: 0.5, kind: 'cap', tile: false }],
      desc: 'bands from the top: [{name, height (m), period (m, default the sheet width), tile (default true), kind ("surface" | "edge" | "cap"), bevel (m), rows ([top, bottom] px, instead of stacking)}]',
      aliases: ['strips', 'trims'],
    },
    rects: { type: 'json', default: [], desc: 'hotspot rectangles: [{name, rect: [x, y, width, height] px from the top-left, rotate (may turn 90°, default true), bevel (m)}]', aliases: ['hotspots', 'rectangles'] },
    gap: { type: 'int', default: 0, min: 0, desc: 'empty pixel rows between stacked bands (padding against mip bleed)', aliases: ['padding'] },
  },
  outputs: 'no geometry; detail trim_sheets (the sheet description, JSON)',
  example: {
    nodes: {
      sheet: { type: 'trim_sheet', params: { name: 'stone', resolution: [512, 512], texels_per_metre: 256, bands: [{ name: 'wall', height: 1 }, { name: 'coping', height: 0.25, kind: 'edge' }, { name: 'cap', height: 0.5, kind: 'cap', tile: false }] } },
      path: { type: 'curve', params: { points: [[0, 0, 0], [2, 0, 0], [3, 0, 1]] } },
      rail: { type: 'sweep', in: ['path', null, 'sheet'], params: { shape: 'rect', size: [0.3, 0.2], trim_band: 'coping' } },
    },
    output: 'rail',
  },
  cook: ({ p }) => {
    const sheet = describeSheet({ name: String(p.name).trim(), resolution: p.resolution, texels_per_metre: p.texels_per_metre, bands: asList(p.bands, 'bands'), rects: asList(p.rects, 'rects'), gap: p.gap }, (m) => { throw new NodeError(m); });
    const g = new Geometry();
    writeTrimSheets(g, { [sheet.name]: sheet });
    return g;
  },
});

// ---------------------------------------------------------------- trim_map

defineNode({
  type: 'trim_map',
  category: 'uv',
  summary: 'Map selected faces onto a trim sheet band: u along the faces at the band\'s period (running on round corners), v across the band; or cut walls into courses one band high.',
  description:
    'Faces of the group that share an edge form a strip. On walls (normals within 45° of level) u runs level and v up; ' +
    'on floors and ceilings u runs along the strip\'s longest edge (along picks another direction). u and v are ' +
    'unfolded across the shared edges, so u carries on round the corners of a wall and v over the fold of a coping. ' +
    'u starts at 0 at the strip\'s start and repeats every period of the band; a band that does not tile, and a ' +
    'rectangle, fits the strip once. fit says how the strip meets the band across: stretch fills the band with each ' +
    'strip, scale keeps real size from the strip\'s bottom (higher parts run out of the band: the uv report counts ' +
    'them), courses cuts the faces into rows one band high from the strip\'s bottom and maps each row onto the whole ' +
    'band (stone courses), adding the cut points to the neighbouring faces so no T-junctions appear. Faces are never ' +
    'mirrored. Search words: trim sheet, trim band, texture a wall, stone courses, uvs along a path. Help topic trim_sheets.',
  aliases: ['trim_uv', 'trim_project', 'band_map'],
  inputs: [
    { name: 'geometry', desc: 'faces to map' },
    { name: 'sheet', desc: 'trim sheet (a trim_sheet node; optional: else the one the geometry carries)', optional: true },
  ],
  params: {
    group: P.group('prim', 'faces to map ("" = all), e.g. "side", "@P.y>0.1", "!caps"'),
    band: { type: 'string', default: '', desc: 'band (or rectangle) to map onto; "sheet:band" picks a sheet when several are carried', aliases: ['trim_band', 'trim'] },
    along: { type: 'enum', options: ['auto', 'x', 'y', 'z', 'longest'], default: 'auto', desc: 'direction of u: auto = level on walls, the longest edge on floors; x, y, z = that axis laid into each face; longest = the strip\'s longest edge on every face' },
    fit: { type: 'enum', options: ['stretch', 'scale', 'courses'], default: 'stretch', desc: 'across the band: stretch = each strip fills it; scale = real size from the strip\'s bottom; courses = cut into rows one band high, each filling the band' },
    connect: { type: 'bool', default: true, desc: 'faces sharing an edge form one strip (u and v run on across the edge); off: every face is its own strip' },
    offset: { type: 'float', default: 0, desc: 'shift u, metres' },
    stagger: { type: 'float', default: 0, desc: 'courses: shift u by this many metres more on each row (a running bond)' },
  },
  outputs: 'vertex uv; prim trim_band, trim_sheet; detail trim_sheets',
  example: {
    nodes: {
      sheet: { type: 'trim_sheet', params: { name: 'stone', resolution: [512, 512], texels_per_metre: 256, bands: [{ name: 'course', height: 0.5 }, { name: 'coping', height: 0.25 }] } },
      plan: { type: 'shape2d', params: { shape: 'rect', size: [3, 0.4] } },
      wall: { type: 'extrude', in: ['plan'], params: { height: 1.6 } },
      stone: { type: 'trim_map', in: ['wall', 'sheet'], params: { group: 'side', band: 'course', fit: 'courses', stagger: 0.3 } },
      top: { type: 'trim_map', in: ['stone'], params: { group: 'top', band: 'coping' } },
    },
    output: 'top',
  },
  cook: (ctx) => {
    const { p } = ctx;
    const g = ctx.input(0);
    const ref = String(p.band ?? '').trim();
    if (!ref) throw new NodeError('trim_map needs a band: the name of a band or rectangle of the sheet', 'e.g. "band": "wall"; the trim_sheet node lists the bands');
    const { sheet, region: r } = pickRegion(sheetsFor(ctx, 1, g), ref, 'sheet');
    const sel = mask(g, 'prim', p.group);
    const strips = buildStrips(g, sel, p.along, p.connect);
    if (!strips.count) { ctx.warn('no faces in the group: nothing mapped'); return g; }
    const courses = p.fit === 'courses';
    const cut = courses ? cutCourses(g, strips, r.height) : null;
    const out = cut ? cut.geo : g.clone();
    const uv = out.vertices.add('uv', 'float', 3);
    const bandOf: (string | null)[] = new Array(out.numPrims).fill(null);
    for (let pr = 0; pr < out.numPrims; pr++) {
      const sp = cut ? cut.src[pr] : pr, k = strips.of[sp];
      if (k < 0) continue;
      const c = cut ? cut.course[pr] : 0;
      const [u0, u1, v0, v1] = strips.range.subarray(k * 4, k * 4 + 4);
      for (let v = out.primStart[pr]; v < out.primStart[pr + 1]; v++) {
        const q = out.vertexPoint[v] * 3, x = out.P[q], y = out.P[q + 1], z = out.P[q + 2];
        const um = x * strips.u[sp * 3] + y * strips.u[sp * 3 + 1] + z * strips.u[sp * 3 + 2] + strips.uo[sp];
        const vm = x * strips.v[sp * 3] + y * strips.v[sp * 3 + 1] + z * strips.v[sp * 3 + 2] + strips.vo[sp];
        const t = p.fit === 'stretch' ? (vm - v0) / (v1 - v0 || 1) : (vm - v0) / r.height - c;
        uv.set(v, [pathU(r, um - u0, u1 - u0, false, 1, p.offset + p.stagger * c), r.v[0] + t * (r.v[1] - r.v[0]), 0]);
      }
      bandOf[pr] = r.name;
    }
    stampTrim(out, sheet, bandOf);
    return out;
  },
});

// ---------------------------------------------------------------- trim_layout

defineNode({
  type: 'trim_layout',
  category: 'uv',
  summary: 'Lay a trim sheet out flat at real size, one strip per band, to bake its maps; relief adds the 45° border bevels and rounds edge bands.',
  description:
    'The layout lies in the XY plane, the sheet\'s bottom-left corner at the origin, facing +Z. Each band is a strip x = 0 ' +
    'to its period and y over its real height, with uv filling the band (u 0..1 is one period). Rectangles sit at their ' +
    'place on the sheet. relief builds the high poly for those maps: a 45° chamfer of the band\'s bevel at each border, ' +
    'an edge band as a quarter-round, and a rectangle as a panel raised by its bevel. Bake with the layout as the low ' +
    'mesh and the relief as the high mesh (bake_normal, bake_ao, bake_curvature). A model placed at the same coordinates ' +
    'lines up with the strips. Help topic trim_sheets.',
  aliases: ['trim_bake', 'trim_mesh', 'sheet_layout'],
  inputs: [{ name: 'sheet', desc: 'the trim sheet (a trim_sheet node, or geometry carrying one)' }],
  params: {
    sheet: { type: 'string', default: '', desc: 'which sheet when the input carries several ("" = the only one)', aliases: ['name'] },
    relief: { type: 'bool', default: false, desc: 'the high poly: 45° bevels, quarter-round edge bands, raised rectangles' },
  },
  outputs: 'the strips; vertex uv; prim trim_band, trim_sheet; a prim group per band; detail trim_sheets',
  example: {
    nodes: {
      sheet: { type: 'trim_sheet', params: { name: 'stone', resolution: [256, 256], texels_per_metre: 128, bands: [{ name: 'wall', height: 1, bevel: 0.02 }, { name: 'edge', height: 0.1, kind: 'edge' }] } },
      flat: { type: 'trim_layout', in: ['sheet'] },
    },
    output: 'flat',
  },
  cook: (ctx) => {
    const table = readTrimSheets(ctx.input(0));
    const sheet = oneSheet(table, String(ctx.p.sheet ?? '').trim());
    const g = layoutMesh(sheet, !!ctx.p.relief);
    stampTrim(g, sheet, (g.prims.get(TRIM_BAND_ATTRIB)!.data as string[]).slice());
    return g;
  },
});

/** The sheet a node asked for: the named one, or the only one carried. */
function oneSheet(table: TrimTable, name: string): TrimSheet {
  const sheets = Object.values(table);
  if (name) {
    const s = table[name];
    if (!s) throw new NodeError(`no trim sheet "${name}"${sheets.length ? ` (there are: ${Object.keys(table).join(', ')})` : ''}`);
    return s;
  }
  if (sheets.length !== 1) throw new NodeError(sheets.length ? `the input carries sheets ${Object.keys(table).join(', ')}: name one with sheet` : 'the input carries no trim sheet: wire a trim_sheet node');
  return sheets[0];
}

/** Bands and rectangles as strips in the XY plane (z = 0), or the relief high poly. */
function layoutMesh(sheet: TrimSheet, relief: boolean): Geometry {
  const b = new GeoBuilder();
  const uv = b.attrib('vertex', 'uv', 3);
  const band = b.attrib('prim', TRIM_BAND_ATTRIB, 1, 'string', '');
  const quads: { name: string; c: { x: number; y: number; z: number; u: number; v: number }[] }[] = [];
  const vAt = (y0: number, y1: number, v0: number, v1: number, y: number) => v0 + (v1 - v0) * ((y - y0) / (y1 - y0 || 1));
  for (const r of sheet.bands) {
    const y0 = r.v[0] * sheet.size[1], y1 = r.v[1] * sheet.size[1], x1 = r.period;
    if (relief && r.kind === 'edge') {
      const n = 8;
      for (let i = 0; i < n; i++) {
        const a0 = (Math.PI / 2) * (i / n), a1 = (Math.PI / 2) * ((i + 1) / n);
        const f = (a: number) => ({ y: y0 + (y1 - y0) * Math.sin(a), z: r.height * (1 - Math.cos(a)), v: r.v[0] + (r.v[1] - r.v[0]) * (a / (Math.PI / 2)) });
        const p0 = f(a0), p1 = f(a1);
        quads.push({ name: r.name, c: [{ x: 0, y: p0.y, z: p0.z, u: 0, v: p0.v }, { x: x1, y: p0.y, z: p0.z, u: 1, v: p0.v }, { x: x1, y: p1.y, z: p1.z, u: 1, v: p1.v }, { x: 0, y: p1.y, z: p1.z, u: 0, v: p1.v }] });
      }
      continue;
    }
    const bev = relief ? Math.min(r.bevel, (y1 - y0) / 2) : 0;
    if (bev > 1e-8) {
      const rows: [number, number, number, number][] = [[y0, y0 + bev, 0, bev], [y0 + bev, y1 - bev, bev, bev], [y1 - bev, y1, bev, 0]];
      for (const [a, c, za, zc] of rows) quads.push({ name: r.name, c: [{ x: 0, y: a, z: za, u: 0, v: vAt(y0, y1, r.v[0], r.v[1], a) }, { x: x1, y: a, z: za, u: 1, v: vAt(y0, y1, r.v[0], r.v[1], a) }, { x: x1, y: c, z: zc, u: 1, v: vAt(y0, y1, r.v[0], r.v[1], c) }, { x: 0, y: c, z: zc, u: 0, v: vAt(y0, y1, r.v[0], r.v[1], c) }] });
    } else quads.push({ name: r.name, c: [{ x: 0, y: y0, z: 0, u: 0, v: r.v[0] }, { x: x1, y: y0, z: 0, u: 1, v: r.v[0] }, { x: x1, y: y1, z: 0, u: 1, v: r.v[1] }, { x: 0, y: y1, z: 0, u: 0, v: r.v[1] }] });
  }
  for (const r of sheet.rects) {
    const x0 = r.u[0] * sheet.size[0], x1 = r.u[1] * sheet.size[0], y0 = r.v[0] * sheet.size[1], y1 = r.v[1] * sheet.size[1];
    const bev = relief ? Math.min(r.bevel, (x1 - x0) / 2, (y1 - y0) / 2) : 0;
    const panel = (xa: number, xb: number, ya: number, yb: number, z: number) => quads.push({ name: r.name, c: [{ x: xa, y: ya, z, u: r.u[0] + (r.u[1] - r.u[0]) * (xa - x0) / (x1 - x0), v: vAt(y0, y1, r.v[0], r.v[1], ya) }, { x: xb, y: ya, z, u: r.u[0] + (r.u[1] - r.u[0]) * (xb - x0) / (x1 - x0), v: vAt(y0, y1, r.v[0], r.v[1], ya) }, { x: xb, y: yb, z, u: r.u[0] + (r.u[1] - r.u[0]) * (xb - x0) / (x1 - x0), v: vAt(y0, y1, r.v[0], r.v[1], yb) }, { x: xa, y: yb, z, u: r.u[0] + (r.u[1] - r.u[0]) * (xa - x0) / (x1 - x0), v: vAt(y0, y1, r.v[0], r.v[1], yb) }] });
    if (bev > 1e-8) {
      panel(x0 + bev, x1 - bev, y0 + bev, y1 - bev, bev);
      panel(x0, x1, y0, y0 + bev, 0); quads[quads.length - 1].c[2].z = bev; quads[quads.length - 1].c[3].z = bev;
      panel(x0, x1, y1 - bev, y1, 0); quads[quads.length - 1].c[0].z = bev; quads[quads.length - 1].c[1].z = bev;
      panel(x0, x0 + bev, y0 + bev, y1 - bev, 0); quads[quads.length - 1].c[1].z = bev; quads[quads.length - 1].c[2].z = bev;
      panel(x1 - bev, x1, y0 + bev, y1 - bev, 0); quads[quads.length - 1].c[0].z = bev; quads[quads.length - 1].c[3].z = bev;
    } else panel(x0, x1, y0, y1, 0);
  }
  for (const q of quads) {
    const v0 = b.numVertices;
    const prim = b.addPrim(q.c.map((c) => b.addPoint(c.x, c.y, c.z)));
    q.c.forEach((c, i) => uv.set(v0 + i, [c.u, c.v, 0]));
    band.set(prim, q.name);
    b.group('prim', q.name).add(prim);
  }
  return b.build();
}

// ---------------------------------------------------------------- hotspot

defineNode({
  type: 'hotspot',
  category: 'uv',
  summary: 'Fit each island of coplanar faces to the trim-sheet rectangle or band closest to its real size.',
  description:
    'Faces of the group that share an edge and lie in one plane form an island. Walls keep v up and u level; floors ' +
    'and ceilings run u along their longest edge. Each island is fitted to the rectangle or band whose real size is ' +
    'closest: the cost is the worse of the two directions on a log scale, and a rectangle that allows rotation may be ' +
    'turned 90°. A band that tiles only has to match across its height (u repeats). An island is stretched to the fit ' +
    'up to max_stretch; past that it is left unmapped, in the group hotspot_unmatched. Ties take the seeded hash of ' +
    'the island\'s position, so the same mesh always fits the same way. Search words: hotspot, trim sheet, trim band. ' +
    'Help topic trim_sheets.',
  aliases: ['hotspot_map', 'uv_hotspot', 'rect_map'],
  inputs: [
    { name: 'geometry', desc: 'faces to fit' },
    { name: 'sheet', desc: 'trim sheet (a trim_sheet node; optional: else the one the geometry carries)', optional: true },
  ],
  params: {
    group: P.group('prim', 'faces to fit ("" = all)'),
    sheet: { type: 'string', default: '', desc: 'which sheet when several are carried ("" = the only one)' },
    max_stretch: { type: 'float', default: 2, min: 1, desc: 'largest size ratio accepted in the worse direction; an island past it stays in hotspot_unmatched' },
    seed: P.seed(),
  },
  outputs: 'vertex uv; prim trim_band, trim_sheet; prim group hotspot_unmatched; detail trim_sheets',
  example: {
    nodes: {
      sheet: { type: 'trim_sheet', params: { name: 'panels', resolution: [512, 512], texels_per_metre: 256, bands: [{ name: 'edge', height: 0.1 }], rects: [{ name: 'wide', rect: [0, 128, 256, 128] }, { name: 'tall', rect: [256, 128, 128, 256], rotate: false }] } },
      wall: { type: 'box', params: { size: [1, 0.5, 0.05], center: [0, 0.25, 0] } },
      door: { type: 'box', params: { size: [0.5, 1, 0.05], center: [1.2, 0.5, 0] } },
      parts: { type: 'merge', in: ['wall', 'door'] },
      nrm: { type: 'normal', in: ['parts'], params: { class: 'prim' } },
      fit: { type: 'hotspot', in: ['nrm', 'sheet'], params: { group: '@N.z>0.5' } },
    },
    output: 'fit',
  },
  cook: (ctx) => {
    const { p } = ctx;
    const g = ctx.input(0);
    const sheet = oneSheet(sheetsFor(ctx, 1, g), String(p.sheet ?? '').trim());
    const regions = [...sheet.bands, ...sheet.rects].map((x) => region(sheet, x.name)!);
    const sel = mask(g, 'prim', p.group);
    const N = faceNormals(g);
    const coplanar = (a: number, b: number) => {
      const d = Math.abs(N[a * 3] * N[b * 3] + N[a * 3 + 1] * N[b * 3 + 1] + N[a * 3 + 2] * N[b * 3 + 2]);
      if (d < Math.cos((5 * Math.PI) / 180)) return false;
      const pa = g.vertexPoint[g.primStart[a]] * 3, pb = g.vertexPoint[g.primStart[b]] * 3;
      const dx = g.P[pb] - g.P[pa], dy = g.P[pb + 1] - g.P[pa + 1], dz = g.P[pb + 2] - g.P[pa + 2];
      return Math.abs(dx * N[a * 3] + dy * N[a * 3 + 1] + dz * N[a * 3 + 2]) < 1e-4 * (1 + Math.hypot(dx, dy, dz));
    };
    const strips = buildStrips(g, sel, 'auto', true, coplanar);
    const out = g.clone();
    const uv = out.vertices.add('uv', 'float', 3);
    const bandOf: (string | null)[] = new Array(out.numPrims).fill(null);
    const unmatched = new Set<number>();
    const fitOf = new Map<number, { fit: ReturnType<typeof matchRegion>; u0: number; u1: number; v0: number; v1: number }>();
    for (let k = 0; k < strips.count; k++) {
      const u0 = strips.range[k * 4], u1 = strips.range[k * 4 + 1], v0 = strips.range[k * 4 + 2], v1 = strips.range[k * 4 + 3];
      const su = Math.max(0, u1 - u0), sv = Math.max(0, v1 - v0);
      const tie = hash32((Math.round((u0 + u1) * 500) ^ hash32(Math.round((v0 + v1) * 500)) ^ Math.round(p.seed)) >>> 0);
      const fits = regions.map((r) => matchRegion([su, sv], [r], p.max_stretch)).filter((f): f is NonNullable<typeof f> => !!f);
      fits.sort((a, b) => a.cost - b.cost || (hash32(tie ^ hash32(a.region.name.length * 131 + b.region.name.length)) - tie));
      // stable tie: lower hash of the region name with the island wins
      fits.sort((a, b) => (Math.abs(a.cost - b.cost) > 1e-9 ? a.cost - b.cost : (hash32(tie ^ nameHash(a.region.name)) - hash32(tie ^ nameHash(b.region.name)))));
      const fit = fits[0] ?? null;
      if (fit) fitOf.set(k, { fit, u0, u1, v0, v1 });
    }
    for (let pr = 0; pr < out.numPrims; pr++) {
      const k = strips.of[pr];
      const got = k >= 0 ? fitOf.get(k) : undefined;
      if (!got || !got.fit) { if (k >= 0) unmatched.add(pr); continue; }
      const { fit, u0, u1, v0, v1 } = got, r = fit.region;
      for (let v = out.primStart[pr]; v < out.primStart[pr + 1]; v++) {
        const q = out.vertexPoint[v] * 3;
        const um = out.P[q] * strips.u[pr * 3] + out.P[q + 1] * strips.u[pr * 3 + 1] + out.P[q + 2] * strips.u[pr * 3 + 2] + strips.uo[pr];
        const vm = out.P[q] * strips.v[pr * 3] + out.P[q + 1] * strips.v[pr * 3 + 1] + out.P[q + 2] * strips.v[pr * 3 + 2] + strips.vo[pr];
        let su = (um - u0) / (u1 - u0 || 1), sv = (vm - v0) / (v1 - v0 || 1);
        if (fit.rot) { const t = su; su = sv; sv = 1 - t; }
        const uu = r.tile ? (um - u0) / r.length : r.u[0] + su * (r.u[1] - r.u[0]);
        uv.set(v, [uu, r.v[0] + sv * (r.v[1] - r.v[0]), 0]);
      }
      bandOf[pr] = r.name;
    }
    const miss = out.primGroups.get('hotspot_unmatched') ?? new Uint8Array(out.numPrims);
    const m = miss.length === out.numPrims ? miss : new Uint8Array(out.numPrims);
    for (const p of unmatched) m[p] = 1;
    out.primGroups.set('hotspot_unmatched', m);
    stampTrim(out, sheet, bandOf);
    const n = unmatched.size;
    if (n) ctx.warn(`${n} island face${n === 1 ? '' : 's'} fit no rectangle or band within max_stretch ${p.max_stretch} (group hotspot_unmatched)`);
    return out;
  },
});

function nameHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = hash32(h ^ s.charCodeAt(i));
  return h >>> 0;
}

function asList(v: any, what: string): any[] {
  if (v === null || v === undefined || v === '') return [];
  if (!Array.isArray(v)) throw new NodeError(`${what} must be a list of objects, got ${JSON.stringify(v).slice(0, 60)}`);
  return v;
}
