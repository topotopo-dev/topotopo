// Houdini JSON geometry (.geo): reader and writer.
//
// The file is a JSON array of alternating keys and values:
//   fileversion, hasindex, pointcount, vertexcount, primitivecount, info,
//   topology   → ["pointref", ["indices", [point of each vertex]]]
//   attributes → ["vertexattributes", [...], "pointattributes", [...], "primitiveattributes", [...], "globalattributes", [...]]
//                each attribute is [[scope, type numeric|string, name, options], [size, storage, defaults, values]]
//                numeric values: "tuples" | "arrays" | "rawpagedata" (+ pagesize, packing, constantpageflags)
//                string values:  "strings" table + "indices" (numeric values of int32)
//   primitives → list of [header, body]: "Polygon_run"/"PolygonCurve_run" (startvertex, nprimitives, nvertices or
//                nvertices_rle [count, repeat, …]); binary-style short keys (p_r, c_r, s_v, n_p, r_v, n_v) are accepted;
//                the older "run" (runtype Poly, varyingfields, uniformfields) and per-prim "Poly" (vertex, closed) too.
//   pointgroups / primitivegroups / vertexgroups → [[name], [selection: [unordered: bit array | ordered: indices]]]
//   edgegroups → [[name], [points: [a0, b0, a1, b1, …]]]
//
// Written: every attribute (float as fpreal64 by default or fpreal32, int as int32, strings via the string table)
// and every group, polygons as Polygon_run and polylines as PolygonCurve_run (open polygons), in Houdini's own
// rawpagedata layout. Read: the same, plus the alternatives above. Prims of other types (volumes/VDB, packed,
// spheres, NURBS…) are skipped with a warning.
// Uncompressed binary .bgeo (Houdini's binary JSON encoding of the same tree) is read too; .bgeo.sc (Blosc) is not.
//
// Winding: Houdini polygons wind clockwise seen from the front (left-hand rule), polyforge counter-clockwise (like
// OBJ and glTF). Closed polygons are therefore written and read with their vertex order reversed, keeping the first
// vertex ([v0, v1, v2, v3] ⇄ [v0, v3, v2, v1]); vertex attributes and vertex groups follow their vertices. Open
// polylines keep their direction.
import { Attribute, AttribTable, Geometry, defaultValueFor } from '../core/geometry.ts';
import type { AttribType } from '../core/geometry.ts';
import { materialBasename } from '../core/materials.ts';
import { EdgeSet } from '../core/edges.ts';
import { expandForExport } from './common.ts';
import type { ExportOptions } from './common.ts';

const PAGE = 1024;

/** Houdini attribute type info ("options" → "type") for well-known names. */
const TYPEINFO: Record<string, string> = {
  P: 'point', rest: 'point', pivot: 'point', N: 'normal', Cd: 'color', uv: 'texturecoord', uv2: 'texturecoord',
  v: 'vector', up: 'vector', scale: 'vector', trans: 'vector', orient: 'quaternion', rot: 'quaternion',
};

// ------------------------------------------------------------------ write

type GroupMap = Map<string, Uint8Array>;

const numFmt32 = (x: number) => (Number.isFinite(x) ? +Math.fround(x).toPrecision(9) : 0);
const numFmt64 = (x: number) => (Number.isFinite(x) ? x : 0);

function attribJSON(name: string, a: Attribute, count: number, prec: 32 | 64): any[] {
  const opts = TYPEINFO[name] && a.type === 'float' ? { type: { type: 'string', value: TYPEINFO[name] } } : {};
  const header = ['scope', 'public', 'type', a.type === 'string' ? 'string' : 'numeric', 'name', name, 'options', opts];
  if (a.type === 'string') {
    const table: string[] = [], index = new Map<string, number>();
    const idx = new Array(count);
    const d = a.data as string[];
    for (let i = 0; i < count; i++) {
      const s = d[i] ?? '';
      let k = index.get(s);
      if (k === undefined) { k = table.length; table.push(s); index.set(s, k); }
      idx[i] = k;
    }
    return [header, ['size', 1, 'storage', 'int32', 'strings', table, 'indices', ['size', 1, 'storage', 'int32', 'pagesize', PAGE, 'rawpagedata', idx]]];
  }
  const storage = a.type === 'int' ? 'int32' : prec === 32 ? 'fpreal32' : 'fpreal64';
  const fmt = a.type === 'int' ? (x: number) => x : prec === 32 ? numFmt32 : numFmt64;
  const def = Array.isArray(a.def) ? a.def.slice(0, a.size) : [];
  while (def.length < a.size) def.push(0);
  const uniform = def.every((x) => x === def[0]);
  const defaults = ['size', uniform ? 1 : a.size, 'storage', a.type === 'int' ? 'int64' : 'fpreal64', 'values', uniform ? [def[0] ?? 0] : def];
  const data = Array.from(a.data as Float64Array, fmt);
  return [header, ['size', a.size, 'storage', storage, 'defaults', defaults, 'values', ['size', a.size, 'storage', storage, 'pagesize', PAGE, 'rawpagedata', data]]];
}

function tableJSON(t: AttribTable, prec: 32 | 64): any[] {
  const out: any[] = [];
  for (const [k, a] of t.map) {
    // fixed-size float/int and single strings; other kinds (array attributes) are not written yet
    if (!(a.type === 'float' || a.type === 'int' || (a.type === 'string' && a.size === 1))) continue;
    out.push(attribJSON(k, a, t.count, prec));
  }
  return out;
}

function groupsJSON(m: GroupMap): any[] {
  const out: any[] = [];
  for (const [name, mask] of m) out.push([['name', name], ['selection', ['unordered', ['i8', Array.from(mask, (x) => (x ? 1 : 0))]]]]);
  return out;
}

/** Edge groups as flat point pairs (EdgeSet.toPairs() when present). */
function edgePairs(e: any): number[] {
  if (!e) return [];
  if (typeof e.toPairs === 'function') return Array.from(e.toPairs() as ArrayLike<number>);
  if (Array.isArray(e) || ArrayBuffer.isView(e)) return Array.from(e as ArrayLike<number>);
  return [];
}

/** RLE of per-prim vertex counts: [count, repeat, count, repeat, …]. */
function rle(counts: number[]): number[] {
  const out: number[] = [];
  for (const c of counts) {
    if (out.length && out[out.length - 2] === c) out[out.length - 1]++;
    else out.push(c, 1);
  }
  return out;
}

/** Serialise to Houdini .geo JSON text. Positions are written as they are (Houdini is Y-up metres too). */
export function exportHoudiniGeo(g: Geometry, o: ExportOptions = {}): string {
  g = expandForExport(g, o, 'geo');
  const prec: 32 | 64 = o.precision === 32 ? 32 : 64;
  const bb = g.bbox();
  const prims: any[] = [];
  for (let p = 0; p < g.numPrims;) {
    const closed = g.primClosed[p];
    const start = p;
    const counts: number[] = [];
    while (p < g.numPrims && g.primClosed[p] === closed) { counts.push(g.primSize(p)); p++; }
    prims.push([['type', closed ? 'Polygon_run' : 'PolygonCurve_run'], ['startvertex', g.primStart[start], 'nprimitives', counts.length, 'nvertices_rle', rle(counts)]]);
  }
  // file vertex k ← our vertex fileVtx[k] (closed polygons reversed, first vertex kept)
  const fileVtx = new Int32Array(g.numVertices);
  for (let p = 0; p < g.numPrims; p++) {
    const s0 = g.primStart[p], e = g.primStart[p + 1];
    for (let v = s0; v < e; v++) fileVtx[v] = g.primClosed[p] && v > s0 ? e - (v - s0) : v;
  }
  const attributes: any[] = [];
  const add = (key: string, t: AttribTable) => { const l = tableJSON(t, prec); if (l.length) attributes.push(key, l); };
  add('vertexattributes', g.vertices.gather(fileVtx));
  add('pointattributes', g.points);
  add('primitiveattributes', g.prims);
  add('globalattributes', g.detail);
  const nPolys = g.primClosed.reduce((s, c) => s + c, 0), nCurves = g.numPrims - nPolys;
  const summary = [nPolys ? `${nPolys} Polygons` : '', nCurves ? `${nCurves} Polygon Curves` : ''].filter(Boolean).join('\n');
  const out: any[] = [
    'fileversion', '20.0.0', 'hasindex', false,
    'pointcount', g.numPoints, 'vertexcount', g.numVertices, 'primitivecount', g.numPrims,
    'info', { software: 'polyforge', bounds: [bb.min[0], bb.max[0], bb.min[1], bb.max[1], bb.min[2], bb.max[2]], primcount_summary: summary + '\n' },
    'topology', ['pointref', ['indices', Array.from(fileVtx, (v) => g.vertexPoint[v])]],
    'attributes', attributes,
    'primitives', prims,
  ];
  if (g.pointGroups.size) out.push('pointgroups', groupsJSON(g.pointGroups));
  if (g.primGroups.size) out.push('primitivegroups', groupsJSON(g.primGroups));
  const vg = (g as any).vertexGroups as GroupMap | undefined;
  if (vg && vg.size) out.push('vertexgroups', groupsJSON(new Map([...vg].map(([k, m]) => [k, Uint8Array.from(fileVtx, (v) => m[v])]))));
  const eg = (g as any).edgeGroups as Map<string, any> | undefined;
  if (eg && eg.size) out.push('edgegroups', [...eg].map(([name, e]) => [['name', name], ['points', edgePairs(e)]]));
  return JSON.stringify(out);
}

// ------------------------------------------------------------------ read

/** [k0, v0, k1, v1, …] → object (objects pass through). */
function kv(x: any): Record<string, any> {
  if (!Array.isArray(x)) return x && typeof x === 'object' ? x : {};
  const o: Record<string, any> = {};
  for (let i = 0; i + 1 < x.length; i += 2) if (typeof x[i] === 'string') o[x[i]] = x[i + 1];
  return o;
}

const FLOAT_STORAGE = new Set(['fpreal16', 'fpreal32', 'fpreal64', 'real16', 'real32', 'real64']);

/** Numeric values block → flat array of count*size numbers. */
function readValues(vb: any, count: number, size: number): number[] {
  const v = kv(vb);
  const out = new Array(count * size).fill(0);
  if (Array.isArray(v.tuples)) {
    const t = v.tuples as any[];
    for (let i = 0; i < Math.min(count, t.length); i++) {
      const e = Array.isArray(t[i]) ? t[i] : [t[i]];
      for (let c = 0; c < size; c++) out[i * size + c] = +e[c] || 0;
    }
  } else if (Array.isArray(v.arrays)) {
    const arrs = v.arrays as any[][];
    if (arrs.length === size) for (let c = 0; c < size; c++) for (let i = 0; i < count; i++) out[i * size + c] = +arrs[c]?.[i] || 0;
    else { const flat = arrs.flat(); for (let i = 0; i < Math.min(flat.length, out.length); i++) out[i] = +flat[i] || 0; }
  } else if (Array.isArray(v.rawpagedata)) {
    const raw = v.rawpagedata as number[];
    const pagesize = +v.pagesize || PAGE;
    const packing: number[] = Array.isArray(v.packing) && v.packing.length ? v.packing.map(Number) : [size];
    const flags: any[] = Array.isArray(v.constantpageflags) ? v.constantpageflags : [];
    let r = 0;
    for (let page = 0, start = 0; start < count; page++, start += pagesize) {
      const n = Math.min(pagesize, count - start);
      let off = 0;
      packing.forEach((ps, gi) => {
        const fl = flags[gi];
        if (Array.isArray(fl) && fl[page]) {
          for (let c = 0; c < ps; c++) { const val = +raw[r++] || 0; for (let e = 0; e < n; e++) out[(start + e) * size + off + c] = val; }
        } else for (let e = 0; e < n; e++) for (let c = 0; c < ps; c++) out[(start + e) * size + off + c] = +raw[r++] || 0;
        off += ps;
      });
    }
  }
  return out;
}

function readAttrib(entry: any, count: number, warn: (m: string) => void): { name: string; attr: Attribute } | null {
  if (!Array.isArray(entry) || entry.length < 2) return null;
  const h = kv(entry[0]), b = kv(entry[1]);
  const name = String(h.name ?? '');
  if (!name) return null;
  const size = Math.max(1, +b.size || 1);
  if (h.type === 'string') {
    if (size !== 1) { warn(`string attribute "${name}" has ${size} components; skipped`); return null; }
    const strings: string[] = Array.isArray(b.strings) ? b.strings.map(String) : [];
    const idx = readValues(b.indices, count, 1);
    return { name, attr: new Attribute('string', 1, Array.from({ length: count }, (_, i) => (idx[i] >= 0 ? strings[idx[i]] ?? '' : ''))) };
  }
  if (h.type !== 'numeric') { warn(`attribute "${name}" of type "${h.type}" is not supported; skipped`); return null; }
  const storage = String(b.storage ?? kv(b.values).storage ?? 'fpreal32');
  const type: AttribType = FLOAT_STORAGE.has(storage) ? 'float' : 'int';
  const vals = readValues(b.values, count, size);
  const dv = kv(b.defaults);
  let def: number[] = Array.isArray(dv.values) ? dv.values.map(Number) : (defaultValueFor(name, size, type) as number[]);
  if (def.length === 1 && size > 1) def = new Array(size).fill(def[0]);
  while (def.length < size) def.push(0);
  const data = type === 'int' ? Int32Array.from(vals, (x) => Math.round(x)) : Float64Array.from(vals);
  return { name, attr: new Attribute(type, size, data, def.slice(0, size)) };
}

/** Bit array of a group selection → membership flags. Accepts ["i8", [...]], ["boolRLE", [n, v, …]] and plain arrays. */
function readBits(x: any, n: number): Uint8Array {
  const m = new Uint8Array(n);
  if (!Array.isArray(x)) return m;
  if (typeof x[0] === 'string') {
    const kind = x[0], data = x[1] ?? [];
    if (kind === 'boolRLE') {
      let i = 0;
      for (let k = 0; k + 1 < data.length; k += 2) { const c = +data[k], val = data[k + 1] ? 1 : 0; for (let j = 0; j < c && i < n; j++) m[i++] = val; }
      return m;
    }
    for (let i = 0; i < Math.min(n, data.length); i++) m[i] = data[i] ? 1 : 0;
    return m;
  }
  for (let i = 0; i < Math.min(n, x.length); i++) m[i] = x[i] ? 1 : 0;
  return m;
}

function readGroup(entry: any, n: number): { name: string; mask: Uint8Array } | null {
  if (!Array.isArray(entry) || entry.length < 2) return null;
  const h = kv(entry[0]);
  const name = String(h.name ?? '');
  if (!name) return null;
  const sel = kv(kv(entry[1]).selection);
  let mask: Uint8Array = new Uint8Array(n);
  if (sel.unordered !== undefined) mask = readBits(sel.unordered, n);
  else if (Array.isArray(sel.ordered)) {
    // ordered groups: an index list (possibly wrapped like a bit array)
    const list = typeof sel.ordered[0] === 'string' ? sel.ordered[1] ?? [] : sel.ordered;
    for (const i of list) if (i >= 0 && i < n) mask[i] = 1;
  }
  return { name, mask };
}

/** Per-prim vertex lists (file vertex numbers) or null for skipped prims. */
function readPrims(list: any[], warn: (m: string) => void): { prims: (number[] | null)[]; closed: boolean[] } {
  const prims: (number[] | null)[] = [];
  const closed: boolean[] = [];
  const skipped = new Map<string, number>();
  const push = (verts: number[] | null, c: boolean) => { prims.push(verts); closed.push(c); };
  for (const entry of list ?? []) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const h = kv(entry[0]);
    const type = String(h.type ?? '');
    const body = entry[1];
    if (type === 'Polygon_run' || type === 'p_r' || type === 'PolygonCurve_run' || type === 'c_r') {
      const b = kv(body);
      const start = +(b.startvertex ?? b.s_v ?? 0), n = +(b.nprimitives ?? b.n_p ?? 0);
      let counts: number[] = [];
      const plain = b.nvertices ?? b.n_v, runs = b.nvertices_rle ?? b.r_v;
      if (Array.isArray(plain)) counts = plain.map(Number);
      else if (Array.isArray(runs)) for (let k = 0; k + 1 < runs.length; k += 2) for (let j = 0; j < +runs[k + 1]; j++) counts.push(+runs[k]);
      const isClosed = type === 'Polygon_run' || type === 'p_r';
      let v = start;
      for (let i = 0; i < n; i++) { const c = counts[i] ?? 0; push(Array.from({ length: c }, (_, k) => v + k), isClosed); v += c; }
    } else if (type === 'run' && (h.runtype === 'Poly' || h.runtype === 'Polygon')) {
      const fields: string[] = Array.isArray(h.varyingfields) ? h.varyingfields : ['vertex'];
      const uni = kv(h.uniformfields);
      for (const pr of Array.isArray(body) ? body : []) {
        const vals: Record<string, any> = {};
        fields.forEach((f, i) => (vals[f] = pr?.[i]));
        const c = vals.closed ?? uni.closed ?? true;
        push((Array.isArray(vals.vertex) ? vals.vertex : []).map(Number), !!c);
      }
    } else if (type === 'Poly' || type === 'Polygon') {
      const b = kv(body);
      push((Array.isArray(b.vertex) ? b.vertex : []).map(Number), b.closed ?? true);
    } else if (type === 'run') {
      const n = Array.isArray(body) ? body.length : 0;
      skipped.set(String(h.runtype ?? 'run'), (skipped.get(String(h.runtype ?? 'run')) ?? 0) + n);
      for (let i = 0; i < n; i++) push(null, false);
    } else {
      skipped.set(type || 'unknown', (skipped.get(type || 'unknown') ?? 0) + 1);
      push(null, false);
    }
  }
  for (const [t, n] of skipped) warn(`skipped ${n} ${t} primitive${n > 1 ? 's' : ''}${/volume|vdb/i.test(t) ? ' (volumes/SDFs are not imported)' : ' (only polygons and polylines are imported)'}`);
  return { prims, closed };
}

// ------------------------------------------------------------------ binary JSON (.bgeo)

/** True when the bytes start with Houdini's binary JSON magic (0x7f "NSJb"). */
export function isBinaryJSON(b: Uint8Array): boolean {
  return b.length >= 5 && b[0] === 0x7f && ((b[1] === 0x4e && b[2] === 0x53 && b[3] === 0x4a && b[4] === 0x62) || (b[1] === 0x62 && b[2] === 0x4a && b[3] === 0x53 && b[4] === 0x4e));
}

function half(h: number): number {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

/**
 * Decode Houdini binary JSON (UT_JSON binary: token-defined strings, typed scalars, uniform arrays) into plain
 * JSON values. Uniform arrays become typed arrays or plain arrays.
 */
export function decodeBinaryJSON(b: Uint8Array): any {
  if (!isBinaryJSON(b)) throw new Error('not Houdini binary JSON (no 0x7f NSJb magic)');
  const le = b[1] === 0x4e; // "NSJb" little-endian, "bJSN" byte-swapped
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const td = new TextDecoder();
  const tokens = new Map<number, string>();
  let o = 5;
  const len = (): number => {
    const c = b[o++];
    if (c < 0xf1) return c;
    if (c === 0xf2) { const v = dv.getUint16(o, le); o += 2; return v; }
    if (c === 0xf4) { const v = dv.getUint32(o, le); o += 4; return v; }
    if (c === 0xf8) { const v = Number(dv.getBigUint64(o, le)); o += 8; return v; }
    throw new Error(`bgeo: bad length byte 0x${c.toString(16)} at ${o - 1}`);
  };
  const str = () => { const n = len(); const t = td.decode(b.subarray(o, o + n)); o += n; return t; };
  const scalar = (t: number): number | boolean => {
    let v: number;
    switch (t) {
      case 0x10: return b[o++] !== 0;
      case 0x11: v = dv.getInt8(o); o += 1; return v;
      case 0x12: v = dv.getInt16(o, le); o += 2; return v;
      case 0x13: v = dv.getInt32(o, le); o += 4; return v;
      case 0x14: v = Number(dv.getBigInt64(o, le)); o += 8; return v;
      case 0x18: v = half(dv.getUint16(o, le)); o += 2; return v;
      case 0x19: v = dv.getFloat32(o, le); o += 4; return v;
      case 0x1a: v = dv.getFloat64(o, le); o += 8; return v;
      case 0x21: return b[o++];
      case 0x22: v = dv.getUint16(o, le); o += 2; return v;
      default: throw new Error(`bgeo: unknown token 0x${t.toString(16)} at ${o - 1}`);
    }
  };
  const value = (): any => {
    for (;;) {
      if (o >= b.length) throw new Error('bgeo: unexpected end of data');
      const t = b[o++];
      switch (t) {
        case 0x2b: { const id = len(); tokens.set(id, str()); continue; } // token definition
        case 0x2d: len(); continue; // token undefine
        case 0x5b: { const a: any[] = []; while (b[o] !== 0x5d) a.push(value()); o++; return a; }
        case 0x7b: { const m: Record<string, any> = {}; while (b[o] !== 0x7d) { const k = value(); m[String(k)] = value(); } o++; return m; }
        case 0x27: return str();
        case 0x26: return tokens.get(len()) ?? '';
        case 0x30: return false;
        case 0x31: return true;
        case 0x00: return null;
        case 0x40: {
          const et = b[o++], n = len();
          if (et === 0x10) {
            const a: boolean[] = new Array(n);
            for (let i = 0; i < n; i += 32) { const w = dv.getUint32(o, le); o += 4; for (let k = 0; k < 32 && i + k < n; k++) a[i + k] = ((w >>> k) & 1) === 1; }
            return a;
          }
          const a: any[] = new Array(n);
          for (let i = 0; i < n; i++) a[i] = scalar(et);
          return a;
        }
        default: return scalar(t);
      }
    }
  };
  return value();
}

/** Uncompressed binary .bgeo. */
export function importHoudiniBgeo(bytes: Uint8Array, warn: (m: string) => void = () => {}): Geometry {
  return importHoudiniGeo(decodeBinaryJSON(bytes), warn);
}

/** Parse Houdini .geo JSON (text or already-parsed value). */
export function importHoudiniGeo(src: string | any, warn: (m: string) => void = () => {}): Geometry {
  const root = kv(typeof src === 'string' ? JSON.parse(src) : src);
  const np = +(root.pointcount ?? 0), nvFile = +(root.vertexcount ?? 0), nprFile = +(root.primitivecount ?? 0);
  const pointref = kv(kv(root.topology).pointref);
  const vpFile = readValues(['rawpagedata', Array.isArray(pointref.indices) ? pointref.indices : []], nvFile, 1);
  const { prims: primList, closed: closedList } = readPrims(Array.isArray(root.primitives) ? root.primitives : [], warn);
  if (primList.length !== nprFile && nprFile) warn(`primitivecount ${nprFile} but ${primList.length} primitives read`);
  // kept prims and their vertices (file numbering → ours)
  const keptPrims: number[] = [], vtxSrc: number[] = [], starts: number[] = [0], closed: number[] = [];
  primList.forEach((verts, i) => {
    if (!verts) return;
    keptPrims.push(i);
    // Houdini winds closed polygons clockwise: reverse, keeping the first vertex
    const ordered = closedList[i] && verts.length > 2 ? [verts[0], ...verts.slice(1).reverse()] : verts;
    for (const v of ordered) {
      if (!(v >= 0 && v < nvFile)) throw new Error(`Houdini geo: primitive ${i} references vertex ${v} (vertexcount ${nvFile})`);
      vtxSrc.push(v);
    }
    starts.push(vtxSrc.length);
    closed.push(closedList[i] ? 1 : 0);
  });
  const g = new Geometry();
  const attrs = kv(root.attributes);
  const table = (key: string, count: number) => {
    const t = new AttribTable(count);
    for (const e of Array.isArray(attrs[key]) ? attrs[key] : []) { const r = readAttrib(e, count, warn); if (r) t.map.set(r.name, r.attr); }
    return t;
  };
  g.points = table('pointattributes', np);
  if (!g.points.has('P')) g.points.add('P', 'float', 3);
  else if (g.points.get('P')!.size !== 3 || g.points.get('P')!.type !== 'float') {
    const p = g.points.get('P')!;
    g.points.delete('P');
    const P = g.points.add('P', 'float', 3);
    for (let i = 0; i < np; i++) P.set(i, (p.get(i) as number[]).slice(0, 3));
  }
  const vtab = table('vertexattributes', nvFile), ptab = table('primitiveattributes', nprFile);
  g.vertices = vtab.gather(vtxSrc);
  g.prims = ptab.gather(keptPrims);
  g.detail = table('globalattributes', 1);
  g.vertexPoint = Int32Array.from(vtxSrc, (v) => {
    const pt = vpFile[v];
    return pt >= 0 && pt < np ? pt : 0;
  });
  g.primStart = Int32Array.from(starts);
  g.primClosed = Uint8Array.from(closed);
  // Houdini material paths → material names (the original attribute is kept)
  const shop = g.prims.get('shop_materialpath');
  if (shop && shop.type === 'string' && !g.prims.has('material')) {
    const a = g.prims.add('material', 'string', 1);
    for (let i = 0; i < g.numPrims; i++) a.set(i, materialBasename(String(shop.get(i))));
  }
  for (const e of Array.isArray(root.pointgroups) ? root.pointgroups : []) { const r = readGroup(e, np); if (r) g.pointGroups.set(r.name, r.mask); }
  for (const e of Array.isArray(root.primitivegroups) ? root.primitivegroups : []) {
    const r = readGroup(e, nprFile);
    if (r) g.primGroups.set(r.name, Uint8Array.from(keptPrims, (p) => r.mask[p]));
  }
  const vgroups = Array.isArray(root.vertexgroups) ? root.vertexgroups : [];
  const vg = (g as any).vertexGroups as GroupMap | undefined;
  if (vgroups.length && !vg) warn(`${vgroups.length} vertex group(s) skipped: this build has no vertex groups`);
  for (const e of vgroups) {
    const r = readGroup(e, nvFile);
    if (r && vg) vg.set(r.name, Uint8Array.from(vtxSrc, (v) => r.mask[v]));
  }
  const egroups = Array.isArray(root.edgegroups) ? root.edgegroups : [];
  for (const e of egroups) {
    if (!Array.isArray(e) || e.length < 2) continue;
    const name = String(kv(e[0]).name ?? '');
    const b = kv(e[1]);
    const pairs: number[] = (b.points ?? b.edges ?? b.pairs ?? []).map(Number);
    if (!name) continue;
    g.edgeGroups.set(name, EdgeSet.fromPairs(pairs).filter((a, b) => a < g.numPoints && b < g.numPoints));
  }
  return g;
}
