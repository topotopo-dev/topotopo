// Trim sheets: one texture sheet described as named horizontal bands (strips that tile along u) and hotspot
// rectangles, at a real size in metres. The description travels with geometry as the detail string attribute
// `trim_sheets` (JSON, keyed by sheet name); mapped prims name their sheet and band in the prim strings `trim_sheet`
// and `trim_band`. Mapping (sweep, polywire, tube, extrude, trim_map, hotspot), baking (trim_layout, tiling bakes),
// the uv report and the sheet view all read the same record.
//
// Conventions, shared by every node that maps onto a sheet:
// - Image rows run top-down (row 0 at v = 1), as image volumes store them. Bands stack from the top.
// - u along a path is the distance from the path's start divided by the band's period; a closed path stretches the
//   period so a whole number of repeats fits. A band that does not tile (and a rectangle) fits the length once.
// - v fills the band across the profile. The band reads upright with the profile's +y up and is never mirrored, so
//   on faces that point to the left of the path u runs against it.
import type { Geometry } from './geometry.ts';

export const TRIM_SHEETS_DETAIL = 'trim_sheets';
export const TRIM_SHEET_ATTRIB = 'trim_sheet';
export const TRIM_BAND_ATTRIB = 'trim_band';

export type BandKind = 'surface' | 'edge' | 'cap';

export interface TrimBand {
  name: string;
  /** real height across the band, metres */
  height: number;
  /** u repeat length, metres (the sheet's width by default) */
  period: number;
  tile: boolean;
  kind: BandKind;
  /** 45° bevel width at the band's top and bottom borders, metres (0 = none) */
  bevel: number;
  /** pixel rows [top, bottom) */
  rows: [number, number];
  /** v range [bottom, top] */
  v: [number, number];
}

export interface TrimRect {
  name: string;
  /** pixels from the top-left: [x, y, width, height] */
  rect: [number, number, number, number];
  /** may be turned 90° to fit */
  rotate: boolean;
  bevel: number;
  /** real size [width, height], metres */
  size: [number, number];
  u: [number, number];
  v: [number, number];
}

export interface TrimSheet {
  name: string;
  resolution: [number, number];
  texels_per_metre: number;
  /** real size [width, height], metres */
  size: [number, number];
  bands: TrimBand[];
  rects: TrimRect[];
}

export type TrimTable = Record<string, TrimSheet>;

/** Where a mapping lands: a band (u tiles over 0..1 per period) or a rectangle (fitted once). */
export interface TrimRegion {
  name: string;
  u: [number, number];
  v: [number, number];
  /** metres covered by u0..u1 */
  length: number;
  /** metres covered by v0..v1 */
  height: number;
  tile: boolean;
  kind: BandKind | 'rect';
  rotate: boolean;
}

const finite = (x: any): x is number => typeof x === 'number' && Number.isFinite(x);
const NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** Build a sheet from its parameters; `fail` throws with a message for the user. */
export function describeSheet(
  o: { name: string; resolution: [number, number]; texels_per_metre: number; bands: any[]; rects: any[]; gap: number },
  fail: (msg: string) => never,
): TrimSheet {
  const [W, H] = o.resolution.map((x) => Math.round(x)) as [number, number];
  const tpm = o.texels_per_metre;
  if (!(W > 0 && H > 0)) fail(`resolution must be two positive pixel sizes, got [${o.resolution}]`);
  if (!(tpm > 0)) fail(`texels_per_metre must be above 0, got ${tpm}`);
  if (!NAME.test(o.name)) fail(`sheet name "${o.name}" must start with a letter and hold letters, digits, _ . -`);
  const used = new Set<string>();
  const named = (x: any, what: string, i: number): string => {
    if (!x || typeof x !== 'object' || Array.isArray(x)) fail(`${what}[${i}] must be an object like {"name": "wall", "height": 0.5}`);
    const n = String(x.name ?? '');
    if (!NAME.test(n)) fail(`${what}[${i}] needs a name that starts with a letter and holds letters, digits, _ . - (got "${n}")`);
    if (used.has(n)) fail(`"${n}" is named twice: band and rectangle names must be unique within a sheet`);
    used.add(n);
    return n;
  };
  const bands: TrimBand[] = [];
  let cursor = 0;
  (o.bands ?? []).forEach((b: any, i: number) => {
    const name = named(b, 'bands', i);
    let top: number, bottom: number, height: number;
    if (b.rows !== undefined) {
      if (!Array.isArray(b.rows) || b.rows.length !== 2 || !b.rows.every(finite) || !(b.rows[1] > b.rows[0])) fail(`bands[${i}] "${name}": rows must be [top, bottom] pixel rows with bottom > top`);
      [top, bottom] = b.rows.map(Math.round);
      height = finite(b.height) ? b.height : (bottom - top) / tpm;
    } else {
      if (!finite(b.height) || b.height <= 0) fail(`bands[${i}] "${name}" needs a height in metres above 0 (or rows: [top, bottom] in pixels)`);
      height = b.height;
      top = cursor;
      bottom = top + Math.max(1, Math.round(height * tpm));
    }
    if (top < 0 || bottom > H) fail(`bands[${i}] "${name}" needs pixel rows ${top}..${bottom} but the sheet is ${H} px high: shorten the bands, lower texels_per_metre or raise resolution`);
    cursor = bottom + Math.max(0, Math.round(o.gap));
    const period = b.period === undefined ? W / tpm : b.period;
    if (!finite(period) || period <= 0) fail(`bands[${i}] "${name}": period must be a length in metres above 0`);
    const kind = b.kind ?? 'surface';
    if (kind !== 'surface' && kind !== 'edge' && kind !== 'cap') fail(`bands[${i}] "${name}": kind must be "surface", "edge" or "cap", got "${kind}"`);
    const bevel = b.bevel ?? 0;
    if (!finite(bevel) || bevel < 0 || bevel * 2 > height) fail(`bands[${i}] "${name}": bevel must be 0 to half the band height (${height / 2} m)`);
    bands.push({ name, height, period, tile: b.tile ?? true, kind, bevel, rows: [top, bottom], v: [1 - bottom / H, 1 - top / H] });
  });
  const rects: TrimRect[] = (o.rects ?? []).map((r: any, i: number) => {
    const name = named(r, 'rects', i);
    const q = r.rect;
    if (!Array.isArray(q) || q.length !== 4 || !q.every(finite) || q[2] <= 0 || q[3] <= 0) fail(`rects[${i}] "${name}": rect must be [x, y, width, height] in pixels from the top-left`);
    const [x, y, w, h] = q.map(Math.round);
    if (x < 0 || y < 0 || x + w > W || y + h > H) fail(`rects[${i}] "${name}": [${q}] runs off the ${W}×${H} sheet`);
    const bevel = r.bevel ?? 0;
    if (!finite(bevel) || bevel < 0 || bevel * 2 > Math.min(w, h) / tpm) fail(`rects[${i}] "${name}": bevel must be 0 to half the shorter side`);
    return { name, rect: [x, y, w, h], rotate: r.rotate ?? true, bevel, size: [w / tpm, h / tpm], u: [x / W, (x + w) / W], v: [1 - (y + h) / H, 1 - y / H] } as TrimRect;
  });
  if (!bands.length && !rects.length) fail('a sheet needs at least one band or rectangle');
  return { name: o.name, resolution: [W, H], texels_per_metre: tpm, size: [W / tpm, H / tpm], bands, rects };
}

/** A band or rectangle by name, as a mapping target; null when the sheet has none of that name. */
export function region(sheet: TrimSheet, name: string): TrimRegion | null {
  const b = sheet.bands.find((x) => x.name === name);
  if (b) return { name, u: [0, 1], v: b.v, length: b.period, height: b.height, tile: b.tile, kind: b.kind, rotate: false };
  const r = sheet.rects.find((x) => x.name === name);
  if (r) return { name, u: r.u, v: r.v, length: r.size[0], height: r.size[1], tile: false, kind: 'rect', rotate: r.rotate };
  return null;
}

export function regionNames(sheet: TrimSheet): string[] {
  return [...sheet.bands.map((b) => b.name), ...sheet.rects.map((r) => r.name)];
}

/** The sheet tables stored on the geometry (empty when there is none or it does not parse). */
export function readTrimSheets(g: Geometry): TrimTable {
  const a = g.detail.get(TRIM_SHEETS_DETAIL);
  if (!a || a.type !== 'string') return {};
  try {
    const raw = JSON.parse(String(a.get(0) || '{}'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
}

/** Store sheets on the geometry (mutates g: clone cooked geometry first), sorted by name. */
export function writeTrimSheets(g: Geometry, t: TrimTable): void {
  const names = Object.keys(t).sort();
  if (!names.length) { g.detail.delete(TRIM_SHEETS_DETAIL); return; }
  const out: TrimTable = {};
  for (const n of names) out[n] = t[n];
  g.detail.add(TRIM_SHEETS_DETAIL, 'string', 1).set(0, JSON.stringify(out));
}

/** Union of the sheets of several geometries; the first definition of a name wins. */
export function mergeTrimTables(geos: (Geometry | null | undefined)[]): TrimTable {
  const out: TrimTable = {};
  for (const g of geos) if (g) for (const [k, s] of Object.entries(readTrimSheets(g))) if (!(k in out)) out[k] = s;
  return out;
}

/**
 * u at distance s along a path of length L. dir -1 runs against the path (faces to its left). Tiling regions repeat
 * every period (stretched on closed paths so whole repeats fit); others fit 0..L once into their u range.
 */
export function pathU(r: TrimRegion, s: number, L: number, closed: boolean, dir: number, offset = 0): number {
  if (r.tile) {
    const per = closed && L > 0 ? L / Math.max(1, Math.round(L / r.length)) : r.length;
    return (dir * (s + offset)) / per;
  }
  const t = L > 0 ? s / L : 0;
  return r.u[0] + (dir < 0 ? 1 - t : t) * (r.u[1] - r.u[0]);
}

/** How each profile segment maps: its region, v at its start and end, and which way u runs (+1 with the path). */
export interface SegmentMap { region: TrimRegion; va: number; vb: number; dir: number }

/**
 * Lay a profile onto bands. `wrap` unrolls consecutive segments of the same region together by length; `faces` gives
 * each segment the whole region. A run that climbs (profile +y) gets v rising along it and u against the path; others
 * v falling and u with it, which keeps the faces unmirrored when their normal is segment × path (`flip`: path ×
 * segment, as extrude walls wind).
 */
export function profileMap(regions: TrimRegion[], segLen: number[], segDy: number[], mode: 'wrap' | 'faces', flip: boolean): SegmentMap[] {
  const n = segLen.length, out: SegmentMap[] = new Array(n);
  let j = 0;
  while (j < n) {
    let e = j + 1;
    if (mode === 'wrap') while (e < n && regions[e].name === regions[j].name) e++;
    let Lr = 0, dy = 0;
    for (let k = j; k < e; k++) { Lr += segLen[k]; dy += segDy[k]; }
    const up = dy > 1e-9 * Math.max(Lr, 1e-12);
    const r = regions[j], dir = (up ? -1 : 1) * (flip ? -1 : 1);
    const at = (t: number) => r.v[0] + (up ? t : 1 - t) * (r.v[1] - r.v[0]);
    let c = 0;
    for (let k = j; k < e; k++) {
      const ta = Lr > 0 ? c / Lr : (k - j) / (e - j);
      c += segLen[k];
      const tb = Lr > 0 ? c / Lr : (k - j + 1) / (e - j);
      out[k] = { region: r, va: at(ta), vb: at(tb), dir };
    }
    j = e;
  }
  return out;
}

/**
 * Cap uvs: points in metres in an unmirrored frame of the cap (u right, v up seen from the front) placed at the
 * region's start and bottom at real size, scaled down only where the cap is taller (or, for regions that do not tile,
 * longer) than the region.
 */
export function capUV(r: TrimRegion, xy: number[][]): number[][] {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of xy) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  let s = 1;
  if (y1 - y0 > r.height) s = r.height / (y1 - y0);
  if (!r.tile && (x1 - x0) * s > r.length) s = r.length / (x1 - x0);
  const du = (r.u[1] - r.u[0]) / r.length, dv = (r.v[1] - r.v[0]) / r.height;
  return xy.map(([x, y]) => [r.u[0] + (x - x0) * s * du, r.v[0] + (y - y0) * s * dv, 0]);
}

/** Parse a band list param: "a" or "a, b, c" (one per profile segment, cycled). */
export function bandList(s: string): string[] {
  return String(s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
}
