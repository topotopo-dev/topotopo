// Point streams: CSV and compact JSON, for PCG tools, spreadsheets and Houdini's Table Import SOP.
//
// CSV: one row per point, header from point attributes with component suffixes (P.x,P.y,P.z,N.x,…,pscale,name);
//   strings are quoted. Prims are ignored. Import is header-driven: "P.x" / "P[x]" / bare "x,y,z" / Unreal
//   "Position.X" columns; non-numeric columns become string attributes.
// PCG CSV (pcg: true): Unreal PCG point columns in Unreal space. Unreal is Z-up and left-handed, in centimetres:
//   X = x, Y = z, Z = y (the Houdini Engine convention), times `scale` (default 100). Columns:
//   Name (row key), Position.X/Y/Z, Rotation.Roll/Pitch/Yaw (degrees, from orient, else N + up, then rot),
//   Scale.X/Y/Z (scale × pscale), Density (density or 1), Color.R/G/B/A (Cd, Alpha), Seed (seed or a hash of the
//   point number), then the remaining attributes.
//   pcgStruct: the same values as Unreal struct text in one cell each, the form Unreal's DataTable CSV importer and
//   exporter use: Position "(X=…,Y=…,Z=…)", Rotation "(Pitch=…,Yaw=…,Roll=…)", Scale "(X=…,Y=…,Z=…)", Density,
//   Color "(X=r,Y=g,Z=b,W=a)" (FVector4), Seed. A row struct {FVector Position; FRotator Rotation; FVector Scale;
//   float Density; FVector4 Color; int32 Seed} imports it directly.
// Points JSON: { format: "polyforge-points", version: 1, count, attributes: { P: { type, size, data } } }.
import { Attribute, AttribTable, Geometry, defaultValueFor } from '../core/geometry.ts';
import type { AttribType } from '../core/geometry.ts';
import { hash32 } from '../core/random.ts';
import { lookAtBasis, m4fromQuat, m4identity, m4mul, qFromMat } from '../core/math.ts';
import type { Mat4, Quat, Vec3 } from '../core/math.ts';
import { attributeList, expandForExport, xf, xfDir } from './common.ts';
import type { ExportOptions } from './common.ts';

const COMP = ['x', 'y', 'z', 'w'];
/** Vector attributes that follow an up-axis change. */
const DIRECTIONS = new Set(['N', 'up', 'v']);
/** Attribute names imported as int from CSV (CSV carries no types). */
const INT_NAMES = new Set(['id', 'class', 'seed', 'copynum', 'piece', 'variant', 'ptnum', 'primnum']);

function fmtNum(x: number): string {
  if (!Number.isFinite(x)) return '0';
  if (Number.isInteger(x)) return String(x);
  return String(+x.toPrecision(9));
}

const quote = (s: string) => '"' + String(s).replace(/"/g, '""') + '"';

/** Point attributes to write, P first. */
function selectAttribs(g: Geometry, o: ExportOptions, exclude: Set<string> = new Set()): [string, Attribute][] {
  const want = attributeList(o.attributes);
  const out: [string, Attribute][] = [];
  const names = want.length ? want : ['P', ...g.points.names().filter((n) => n !== 'P')];
  for (const n of names) {
    if (exclude.has(n)) continue;
    const a = g.points.get(n);
    if (a && (a.type === 'float' || a.type === 'int' || a.type === 'string')) out.push([n, a]); // array attributes are skipped
  }
  return out;
}

/** Values of point i of an attribute after the export conversion (P scaled/axis-converted, directions axis-converted). */
function pointValue(name: string, a: Attribute, i: number, o: ExportOptions): number[] {
  const v = a.get(i);
  const arr = Array.isArray(v) ? v : [v as number];
  if (name === 'P' && a.size === 3) return xf(arr[0], arr[1], arr[2], o);
  if (DIRECTIONS.has(name) && a.size === 3) return xfDir(arr[0], arr[1], arr[2], o);
  return arr;
}

function columnsFor(name: string, a: Attribute): string[] {
  if (a.type === 'string' || a.size === 1) return [name];
  return Array.from({ length: a.size }, (_, c) => `${name}.${a.size <= 4 ? COMP[c] : c}`);
}

// ------------------------------------------------------------------ PCG helpers

/** Houdini instance rotation of point i: orient, else N (+Z) and up (+Y), then rot. */
function pointRotation(g: Geometry, i: number): Mat4 {
  const get = (n: string) => g.points.get(n);
  let R: Mat4 = m4identity();
  const o = get('orient');
  if (o && o.size === 4) R = m4fromQuat(o.get(i) as Quat);
  else {
    const N = get('N') ?? get('v'), up = get('up');
    if (N && N.size === 3) {
      const d = N.get(i) as number[];
      if (Math.hypot(d[0], d[1], d[2]) > 1e-12) R = lookAtBasis(d as Vec3, up && up.size === 3 ? (up.get(i) as Vec3) : [0, 1, 0]);
    }
  }
  const rot = get('rot');
  if (rot && rot.size === 4) R = m4mul(R, m4fromQuat(rot.get(i) as Quat));
  return R;
}

const DEG = 180 / Math.PI;
const swap = (v: number[]) => [v[0], v[2], v[1]];
const dot3 = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Unreal FRotator (pitch, yaw, roll in degrees) of a Houdini rotation matrix, through the Y/Z swap. */
export function unrealRotator(R: Mat4): { pitch: number; yaw: number; roll: number } {
  const col = (k: number) => [R[k * 4], R[k * 4 + 1], R[k * 4 + 2]];
  // Unreal local axes in Unreal world space: X ← Houdini X, Y ← Houdini Z, Z ← Houdini Y
  const X = swap(col(0)), Y = swap(col(2)), Z = swap(col(1));
  const pitch = Math.atan2(X[2], Math.hypot(X[0], X[1])) * DEG;
  const yaw = Math.atan2(X[1], X[0]) * DEG;
  const sy = Math.sin(yaw / DEG), cy = Math.cos(yaw / DEG);
  const SY = [-sy, cy, 0];
  const roll = Math.atan2(dot3(Z, SY), dot3(Y, SY)) * DEG;
  return { pitch, yaw, roll };
}

/** Inverse of unrealRotator: Houdini rotation matrix from an Unreal FRotator. */
export function rotatorToHoudini(pitch: number, yaw: number, roll: number): Mat4 {
  const sp = Math.sin(pitch / DEG), cp = Math.cos(pitch / DEG), sy = Math.sin(yaw / DEG), cy = Math.cos(yaw / DEG), sr = Math.sin(roll / DEG), cr = Math.cos(roll / DEG);
  // FRotationMatrix rows = Unreal local axes in Unreal world space
  const X = [cp * cy, cp * sy, sp];
  const Y = [sr * sp * cy - cr * sy, sr * sp * sy + cr * cy, -sr * cp];
  const Z = [-(cr * sp * cy + sr * sy), cy * sr - cr * sp * sy, cr * cp];
  const hx = swap(X), hy = swap(Z), hz = swap(Y);
  const m = m4identity();
  m[0] = hx[0]; m[1] = hx[1]; m[2] = hx[2];
  m[4] = hy[0]; m[5] = hy[1]; m[6] = hy[2];
  m[8] = hz[0]; m[9] = hz[1]; m[10] = hz[2];
  return m;
}

const fmtFixed = (x: number) => (Number.isFinite(x) ? x.toFixed(6) : '0.000000');

/** Attributes consumed by the PCG columns. */
const PCG_USED = new Set(['P', 'N', 'v', 'up', 'orient', 'rot', 'pscale', 'scale', 'Cd', 'Alpha', 'density', 'seed', 'trans']);

function pcgRows(g: Geometry, o: ExportOptions): { header: string[]; rows: string[][] } {
  const s = o.scale ?? 100;
  const get = (n: string) => g.points.get(n);
  const extras = selectAttribs(g, { ...o, attributes: attributeList(o.attributes).filter((n) => !PCG_USED.has(n)) }, PCG_USED);
  const struct = !!o.pcgStruct;
  const header = struct ? ['Name', 'Position', 'Rotation', 'Scale', 'Density', 'Color', 'Seed']
    : ['Name', 'Position.X', 'Position.Y', 'Position.Z', 'Rotation.Roll', 'Rotation.Pitch', 'Rotation.Yaw', 'Scale.X', 'Scale.Y', 'Scale.Z', 'Density', 'Color.R', 'Color.G', 'Color.B', 'Color.A', 'Seed'];
  const ue = (keys: string[], vals: number[]) => quote('(' + keys.map((k, j) => `${k}=${fmtFixed(vals[j])}`).join(',') + ')');
  const XYZ = ['X', 'Y', 'Z'];
  for (const [n, a] of extras) header.push(...columnsFor(n, a));
  const P = g.P, tr = get('trans'), ps = get('pscale'), sc = get('scale'), cd = get('Cd'), al = get('Alpha'), de = get('density'), sd = get('seed');
  const rows: string[][] = [];
  for (let i = 0; i < g.numPoints; i++) {
    const p = [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
    if (tr && tr.size === 3) { const t = tr.get(i) as number[]; p[0] += t[0]; p[1] += t[1]; p[2] += t[2]; }
    const rot = unrealRotator(pointRotation(g, i));
    const k = ps && (ps.type === 'float' || ps.type === 'int') ? (ps.get(i) as number) : 1;
    const sv = sc && sc.size === 3 ? (sc.get(i) as number[]) : [1, 1, 1];
    const c = cd && cd.size >= 3 ? (cd.get(i) as number[]) : [1, 1, 1];
    const a = al && al.type === 'float' ? (al.get(i) as number) : 1;
    const seed = sd && (sd.type === 'int' || sd.type === 'float') ? Math.round(Array.isArray(sd.get(i)) ? (sd.get(i) as number[])[0] : (sd.get(i) as number)) : hash32(i) >>> 1;
    const dens = de && (de.type === 'float' || de.type === 'int') ? (de.get(i) as number) : 1;
    const pos = [p[0] * s, p[2] * s, p[1] * s], scl = [sv[0] * k, sv[2] * k, sv[1] * k];
    const row = struct
      ? [String(i), ue(XYZ, pos), ue(['Pitch', 'Yaw', 'Roll'], [rot.pitch, rot.yaw, rot.roll]), ue(XYZ, scl), fmtNum(dens), ue(['X', 'Y', 'Z', 'W'], [c[0], c[1], c[2], a]), String(seed)]
      : [String(i), fmtNum(pos[0]), fmtNum(pos[1]), fmtNum(pos[2]), fmtNum(rot.roll), fmtNum(rot.pitch), fmtNum(rot.yaw),
        fmtNum(scl[0]), fmtNum(scl[1]), fmtNum(scl[2]), fmtNum(dens), fmtNum(c[0]), fmtNum(c[1]), fmtNum(c[2]), fmtNum(a), String(seed)];
    for (const [n, at] of extras) {
      if (at.type === 'string') row.push(quote(String(at.get(i))));
      else for (const x of pointValue(n, at, i, {})) row.push(fmtNum(x));
    }
    rows.push(row);
  }
  return { header, rows };
}

// ------------------------------------------------------------------ CSV

/** CSV text, one row per point. */
export function exportCSV(g: Geometry, o: ExportOptions = {}): string {
  g = expandForExport(g, o, 'csv');
  let header: string[], rows: string[][];
  if (o.pcg) ({ header, rows } = pcgRows(g, o));
  else {
    const attrs = selectAttribs(g, o);
    header = attrs.flatMap(([n, a]) => columnsFor(n, a));
    rows = [];
    for (let i = 0; i < g.numPoints; i++) {
      const row: string[] = [];
      for (const [n, a] of attrs) {
        if (a.type === 'string') row.push(quote(String(a.get(i))));
        else for (const x of pointValue(n, a, i, o)) row.push(fmtNum(x));
      }
      rows.push(row);
    }
  }
  return [header.map((h) => (/[",\s]/.test(h) ? quote(h) : h)).join(','), ...rows.map((r) => r.join(','))].join('\n') + '\n';
}

/** RFC 4180 parsing (quoted fields, "" escapes, CRLF), delimiter , ; or tab from the header line. */
export function parseCSV(text: string): string[][] {
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const counts = [',', ';', '\t'].map((d) => firstLine.split(d).length);
  const delim = [',', ';', '\t'][counts.indexOf(Math.max(...counts))];
  const rows: string[][] = [];
  let row: string[] = [], field = '', q = false, quotedField = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += ch;
    } else if (ch === '"') { q = true; quotedField = true; }
    else if (ch === delim) { row.push(quotedField ? field : field.trim()); field = ''; quotedField = false; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(quotedField ? field : field.trim()); field = ''; quotedField = false;
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(quotedField ? field : field.trim()); if (row.length > 1 || row[0] !== '') rows.push(row); }
  return rows;
}

const PCG_COLUMNS = /^(position|rotation|scale|color)(\.(x|y|z|roll|pitch|yaw|r|g|b|a))?$|^(density|seed)$/i;

/** Unreal struct text "(X=1.0,Y=2.0,Z=3.0)" → { X: 1, Y: 2, Z: 3 } (null when the cell is not struct text). */
function ueStruct(cell: string): Record<string, number> | null {
  const m = /^\s*\((.*)\)\s*$/.exec(cell);
  if (!m) return null;
  const out: Record<string, number> = {};
  for (const part of m[1].split(',')) {
    const kv = /^\s*([A-Za-z]+)\s*=\s*([-+\d.eE]+)\s*$/.exec(part);
    if (kv) out[kv[1].toLowerCase()] = Number(kv[2]);
  }
  return out;
}

/** Column name → attribute base + component index (−1 = scalar). */
function splitColumn(h: string): { base: string; comp: number } {
  let m = /^(.+?)\.(x|y|z|w|r|g|b|a|\d+)$/i.exec(h) ?? /^(.+?)\[(x|y|z|w|r|g|b|a|\d+)\]$/i.exec(h);
  if (m) {
    const c = m[2].toLowerCase();
    const comp = /\d/.test(c) ? +c : 'xr'.includes(c) ? 0 : 'yg'.includes(c) ? 1 : 'zb'.includes(c) ? 2 : 3;
    return { base: m[1], comp };
  }
  if (/^[xyz]$/i.test(h)) return { base: 'P', comp: 'xyz'.indexOf(h.toLowerCase()) };
  return { base: h, comp: -1 };
}

/** Points from CSV text (see the module comment for the accepted columns). */
export function importCSV(text: string): Geometry {
  const rows = parseCSV(text);
  if (!rows.length) return new Geometry();
  const header = rows[0];
  const body = rows.slice(1);
  const n = body.length;
  const posCol = header.findIndex((h) => /^position$/i.test(h.trim()));
  const pcg = header.some((h) => /^position\.x$/i.test(h.trim())) || (posCol >= 0 && !!body.length && !!ueStruct(body[0][posCol] ?? ''));
  const col = (i: number) => body.map((r) => r[i] ?? '');
  const isNum = (s: string) => s === '' || Number.isFinite(Number(s));
  if (pcg) return importPCG(header, col, n);
  // group columns into attributes
  const groups = new Map<string, { comps: Map<number, number>; scalar: number }>();
  header.forEach((h, i) => {
    const { base, comp } = splitColumn(h.trim());
    let gr = groups.get(base);
    if (!gr) { gr = { comps: new Map(), scalar: -1 }; groups.set(base, gr); }
    if (comp < 0) gr.scalar = i; else gr.comps.set(comp, i);
  });
  if (!groups.has('P')) throw new Error('CSV needs position columns: P.x,P.y,P.z (or x,y,z, or Unreal Position.X/Y/Z)');
  const g = new Geometry({ positions: new Float64Array(n * 3) });
  const t = g.points;
  for (const [base, gr] of groups) {
    if (gr.scalar >= 0 && !gr.comps.size) {
      const vals = col(gr.scalar);
      if (vals.every(isNum)) {
        const type: AttribType = INT_NAMES.has(base) && vals.every((s) => s === '' || Number.isInteger(Number(s))) ? 'int' : 'float';
        const a = Attribute.create(type, 1, n, defaultValueFor(base, 1, type));
        vals.forEach((s, i) => { if (s !== '') a.set(i, Number(s)); });
        t.map.set(base, a);
      } else t.map.set(base, new Attribute('string', 1, vals.slice()));
      continue;
    }
    const size = Math.max(...gr.comps.keys()) + 1;
    const cols = Array.from({ length: size }, (_, c) => (gr.comps.has(c) ? col(gr.comps.get(c)!) : null));
    const type: AttribType = INT_NAMES.has(base) ? 'int' : 'float';
    const a = base === 'P' ? t.get('P')! : Attribute.create(type, size, n, defaultValueFor(base, size, type));
    const d = a.data as Float64Array;
    cols.forEach((vals, c) => { if (vals) vals.forEach((s, i) => { if (s !== '' && isNum(s)) d[i * a.size + c] = Number(s); }); });
    if (base !== 'P') t.map.set(base, a);
  }
  return g;
}

function importPCG(header: string[], col: (i: number) => string[], n: number): Geometry {
  const idx = (name: string) => header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
  const has = (base: string, comp: string) => idx(`${base}.${comp}`) >= 0 || idx(base) >= 0;
  // a component from a flat column ("Position.X") or from a struct-text column ("Position" = "(X=…,Y=…,Z=…)")
  const num = (base: string, comp: string, def: number, key = comp): number[] => {
    const flat = idx(`${base}.${comp}`);
    if (flat >= 0) return col(flat).map((v) => (v === '' ? def : Number(v)));
    const st = idx(base);
    if (st >= 0) return col(st).map((v) => { const o = ueStruct(v); const x = o?.[key.toLowerCase()]; return x === undefined ? def : x; });
    return new Array(n).fill(def);
  };
  const s = 100;
  const X = num('Position', 'X', 0), Y = num('Position', 'Y', 0), Z = num('Position', 'Z', 0);
  const pos = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) { pos[i * 3] = X[i] / s; pos[i * 3 + 1] = Z[i] / s; pos[i * 3 + 2] = Y[i] / s; }
  const g = new Geometry({ positions: pos });
  const t = g.points;
  if (has('Rotation', 'Roll') || has('Rotation', 'Pitch') || has('Rotation', 'Yaw')) {
    const r = num('Rotation', 'Roll', 0), p = num('Rotation', 'Pitch', 0), y = num('Rotation', 'Yaw', 0);
    const o = t.add('orient', 'float', 4);
    for (let i = 0; i < n; i++) o.set(i, qFromMat(rotatorToHoudini(p[i], y[i], r[i])));
  }
  if (has('Scale', 'X')) {
    const sx = num('Scale', 'X', 1), sy = num('Scale', 'Y', 1), sz = num('Scale', 'Z', 1);
    const a = t.add('scale', 'float', 3);
    for (let i = 0; i < n; i++) a.set(i, [sx[i], sz[i], sy[i]]);
  }
  if (idx('Density') >= 0) { const d = col(idx('Density')).map((v) => (v === '' ? 1 : Number(v))), a = t.add('density', 'float', 1); d.forEach((v, i) => a.set(i, v)); }
  if (has('Color', 'R')) {
    // flat Color.R/G/B/A, or FVector4 / FLinearColor struct text (X/Y/Z/W or R/G/B/A keys)
    const st = idx('Color') >= 0 && idx('Color.R') < 0;
    const r = num('Color', 'R', 1, st ? 'X' : 'R'), gg = num('Color', 'G', 1, st ? 'Y' : 'G'), b = num('Color', 'B', 1, st ? 'Z' : 'B'), al = num('Color', 'A', 1, st ? 'W' : 'A');
    if (st) { const lc = col(idx('Color')).map((v) => ueStruct(v)); lc.forEach((o, i) => { if (o && o.r !== undefined) { r[i] = o.r; gg[i] = o.g ?? 1; b[i] = o.b ?? 1; al[i] = o.a ?? 1; } }); }
    const a = t.add('Cd', 'float', 3), aa = t.add('Alpha', 'float', 1);
    for (let i = 0; i < n; i++) { a.set(i, [r[i], gg[i], b[i]]); aa.set(i, al[i]); }
  }
  if (idx('Seed') >= 0) { const d = col(idx('Seed')).map(Number), a = t.add('seed', 'int', 1); d.forEach((v, i) => a.set(i, Math.round(v || 0))); }
  // remaining columns as attributes (generic rules); the row-name column is dropped
  const rest = header.map((h, i) => [h.trim(), i] as const).filter(([h, i]) => !PCG_COLUMNS.test(h) && !(i === 0 && /^(name|---|rowname)$/i.test(h)));
  if (rest.length) {
    const sub = importCSVColumns(rest.map(([h]) => h), rest.map(([, i]) => col(i)), n);
    for (const [k, a] of sub.map) t.map.set(k, a);
  }
  return g;
}

/** Generic column → attribute conversion for a subset of columns (used for PCG extras). */
function importCSVColumns(header: string[], cols: string[][], n: number): AttribTable {
  const lines = [header.map(quote).join(',') + ',P.x,P.y,P.z'];
  for (let i = 0; i < n; i++) lines.push(cols.map((c) => quote(c[i] ?? '')).join(',') + ',0,0,0');
  const g = importCSV(lines.join('\n'));
  g.points.delete('P');
  return g.points;
}

// ------------------------------------------------------------------ points JSON

/** Compact JSON point stream (all or `attributes` point attributes; prims ignored). */
export function exportPointsJSON(g: Geometry, o: ExportOptions = {}): string {
  g = expandForExport(g, o, 'points json');
  const attributes: Record<string, { type: AttribType; size: number; data: (number | string)[] }> = {};
  for (const [n, a] of selectAttribs(g, o)) {
    const data: (number | string)[] = [];
    for (let i = 0; i < g.numPoints; i++) {
      if (a.type === 'string') data.push(String(a.get(i)));
      else for (const x of pointValue(n, a, i, o)) data.push(Number.isFinite(x) ? x : 0);
    }
    attributes[n] = { type: a.type, size: a.type === 'string' ? 1 : a.size, data };
  }
  return JSON.stringify({ format: 'polyforge-points', version: 1, count: g.numPoints, attributes });
}

/** True for a parsed object that looks like a points JSON stream. */
export function isPointsJSON(j: any): boolean {
  return !!j && typeof j === 'object' && !Array.isArray(j) && (j.format === 'polyforge-points' || (typeof j.count === 'number' && j.attributes && typeof j.attributes === 'object' && !j.points));
}

export function importPointsJSON(j: any): Geometry {
  if (!isPointsJSON(j)) throw new Error('not a points JSON stream ({count, attributes: {P: {type, size, data}}})');
  const n = Math.max(0, Math.floor(j.count));
  const g = new Geometry({ positions: new Float64Array(n * 3) });
  for (const [name, spec] of Object.entries(j.attributes as Record<string, any>)) {
    const type: AttribType = spec?.type === 'string' ? 'string' : spec?.type === 'int' ? 'int' : 'float';
    const size = type === 'string' ? 1 : Math.max(1, Math.floor(spec?.size ?? 1));
    const data: any[] = Array.isArray(spec?.data) ? spec.data : [];
    if (name === 'P' && type === 'float' && size === 3) { (g.points.get('P')!.data as Float64Array).set(data.slice(0, n * 3).map(Number)); continue; }
    if (type === 'string') { g.points.map.set(name, new Attribute('string', 1, Array.from({ length: n }, (_, i) => String(data[i] ?? '')))); continue; }
    const a = Attribute.create(type, size, n, defaultValueFor(name, size, type));
    const d = a.data as Float64Array;
    for (let i = 0; i < Math.min(d.length, data.length); i++) d[i] = type === 'int' ? Math.round(Number(data[i])) : Number(data[i]);
    g.points.map.set(name, a);
  }
  return g;
}
