// Importers: OBJ, STL, PLY, glTF/GLB (gltf-transform, src/io/gltf.ts), native JSON, Houdini .geo (src/io/hgeo.ts),
// CSV and points JSON (src/io/points.ts).
//
// importGeometry() is synchronous and covers every format except glTF, whose reader (gltf-transform) is
// asynchronous: use importGeometryAsync() for glb/gltf (it handles every format, and reads external .bin files).
import { Geometry } from '../core/geometry.ts';
import { geoFromJSON } from './json.ts';
import { importGLTFAsync } from './gltf.ts';
import { importHoudiniGeo } from './hgeo.ts';
import { importCSV, importPointsJSON, isPointsJSON } from './points.ts';

export { importGLTFAsync } from './gltf.ts';
export { importHoudiniGeo } from './hgeo.ts';
export { importCSV, importPointsJSON } from './points.ts';

const td = new TextDecoder();

export const IMPORT_FORMATS = ['obj', 'stl', 'ply', 'glb', 'gltf', 'json', 'geo', 'csv', 'pointsjson'];

export interface ImportOptions {
  /** reads other files by path (glTF external buffers); usually Host.readFile */
  readFile?: (path: string) => Promise<Uint8Array>;
  /** path of the file, to resolve relative references */
  path?: string;
  /** receives non-fatal problems (skipped primitives or attributes) */
  warn?: (msg: string) => void;
}

/** Format from a file name: the extension, with ".points.json" → pointsjson. */
export function importFormatFromPath(path: string): string {
  const p = String(path).split('?')[0].toLowerCase();
  if (p.endsWith('.points.json')) return 'pointsjson';
  return p.slice(p.lastIndexOf('.') + 1);
}

/** JSON of any supported flavour: polyforge geometry, points stream, or Houdini .geo (a key/value array). */
function importAnyJSON(j: any, warn?: (m: string) => void): Geometry {
  if (Array.isArray(j)) return importHoudiniGeo(j, warn);
  if (isPointsJSON(j)) return importPointsJSON(j);
  return geoFromJSON(j);
}

/** Synchronous import for every format except glb/gltf (see importGeometryAsync). */
export function importGeometry(bytes: Uint8Array, fmt: string, opts: ImportOptions = {}): Geometry {
  switch (fmt) {
    case 'obj': return importOBJ(td.decode(bytes));
    case 'stl': return importSTL(bytes);
    case 'ply': return importPLY(bytes);
    case 'json': return importAnyJSON(JSON.parse(td.decode(bytes)), opts.warn);
    case 'geo': case 'hgeo': return importHoudiniGeo(td.decode(bytes), opts.warn);
    case 'csv': return importCSV(td.decode(bytes));
    case 'pointsjson': return importPointsJSON(JSON.parse(td.decode(bytes)));
    case 'glb': case 'gltf': throw new Error(`${fmt} import is asynchronous (gltf-transform): use importGeometryAsync`);
    default: throw new Error(`unsupported import format "${fmt}" (${IMPORT_FORMATS.join(', ')})`);
  }
}

/** Import any supported format. */
export async function importGeometryAsync(bytes: Uint8Array, fmt: string, opts: ImportOptions = {}): Promise<Geometry> {
  if (fmt === 'glb' || fmt === 'gltf') return importGLTFAsync(bytes, opts);
  return importGeometry(bytes, fmt, opts);
}

export function importOBJ(text: string): Geometry {
  const V: number[] = [], VC: number[] = [], VT: number[] = [], VN: number[] = [];
  const faces: { v: number[]; t: number[]; n: number[]; name: string; closed: boolean }[] = [];
  let name = '';
  let hasColor = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const parts = line.split(/\s+/);
    const tag = parts[0];
    if (tag === 'v') {
      V.push(+parts[1], +parts[2], +parts[3]);
      if (parts.length >= 7) { VC.push(+parts[4], +parts[5], +parts[6]); hasColor = true; } else VC.push(1, 1, 1);
    } else if (tag === 'vt') VT.push(+parts[1], +(parts[2] ?? 0));
    else if (tag === 'vn') VN.push(+parts[1], +parts[2], +parts[3]);
    else if (tag === 'o' || tag === 'g') name = parts.slice(1).join(' ');
    else if (tag === 'f' || tag === 'l') {
      const f = { v: [] as number[], t: [] as number[], n: [] as number[], name, closed: tag === 'f' };
      for (const c of parts.slice(1)) {
        const [a, b, d] = c.split('/');
        const fix = (x: string | undefined, len: number) => (x ? (+x < 0 ? len + +x : +x - 1) : -1);
        f.v.push(fix(a, V.length / 3)); f.t.push(fix(b, VT.length / 2)); f.n.push(fix(d, VN.length / 3));
      }
      faces.push(f);
    }
  }
  const g = new Geometry({ positions: V, prims: faces.map((f) => f.v), closed: faces.map((f) => f.closed) });
  if (hasColor) (g.points.add('Cd', 'float', 3).data as Float64Array).set(VC);
  const hasT = faces.some((f) => f.t.some((x) => x >= 0)), hasN = faces.some((f) => f.n.some((x) => x >= 0));
  if (hasT || hasN) {
    const uv = hasT ? (g.vertices.add('uv', 'float', 3).data as Float64Array) : null;
    const N = hasN ? (g.vertices.add('N', 'float', 3).data as Float64Array) : null;
    let v = 0;
    for (const f of faces)
      for (let k = 0; k < f.v.length; k++, v++) {
        if (uv && f.t[k] >= 0) { uv[v * 3] = VT[f.t[k] * 2]; uv[v * 3 + 1] = VT[f.t[k] * 2 + 1]; }
        if (N && f.n[k] >= 0) { N[v * 3] = VN[f.n[k] * 3]; N[v * 3 + 1] = VN[f.n[k] * 3 + 1]; N[v * 3 + 2] = VN[f.n[k] * 3 + 2]; }
      }
  }
  if (faces.some((f) => f.name)) {
    const a = g.prims.add('name', 'string', 1);
    faces.forEach((f, i) => a.set(i, f.name));
  }
  return g;
}

function weldTriangles(pos: number[]): Geometry {
  const map = new Map<string, number>();
  const P: number[] = [], prims: number[][] = [];
  for (let t = 0; t < pos.length / 9; t++) {
    const tri: number[] = [];
    for (let k = 0; k < 3; k++) {
      const o = t * 9 + k * 3;
      const key = `${pos[o].toFixed(6)},${pos[o + 1].toFixed(6)},${pos[o + 2].toFixed(6)}`;
      let id = map.get(key);
      if (id === undefined) { id = P.length / 3; P.push(pos[o], pos[o + 1], pos[o + 2]); map.set(key, id); }
      tri.push(id);
    }
    if (tri[0] !== tri[1] && tri[1] !== tri[2] && tri[0] !== tri[2]) prims.push(tri);
  }
  return new Geometry({ positions: P, prims });
}

export function importSTL(bytes: Uint8Array): Geometry {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const isBinary = bytes.byteLength >= 84 && 84 + dv.getUint32(80, true) * 50 === bytes.byteLength;
  const pos: number[] = [];
  if (isBinary) {
    const n = dv.getUint32(80, true);
    for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) pos.push(dv.getFloat32(84 + t * 50 + 12 + k * 4, true));
  } else {
    for (const m of td.decode(bytes).matchAll(/vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g)) pos.push(+m[1], +m[2], +m[3]);
  }
  return weldTriangles(pos);
}

export function importPLY(bytes: Uint8Array): Geometry {
  const headEnd = (() => { const s = td.decode(bytes.subarray(0, Math.min(bytes.length, 65536))); const i = s.indexOf('end_header'); return i < 0 ? -1 : i + 'end_header'.length + (s[i + 10] === '\r' ? 2 : 1); })();
  if (headEnd < 0) throw new Error('PLY: no end_header');
  const header = td.decode(bytes.subarray(0, headEnd)).split(/\r?\n/);
  const format = header.find((l) => l.startsWith('format'))?.split(/\s+/)[1] ?? 'ascii';
  const elements: { name: string; count: number; props: { name: string; type: string; list?: [string, string] }[] }[] = [];
  for (const l of header) {
    const p = l.trim().split(/\s+/);
    if (p[0] === 'element') elements.push({ name: p[1], count: +p[2], props: [] });
    else if (p[0] === 'property') {
      const el = elements[elements.length - 1];
      if (p[1] === 'list') el.props.push({ name: p[4], type: 'list', list: [p[2], p[3]] });
      else el.props.push({ name: p[2], type: p[1] });
    }
  }
  const sizes: Record<string, number> = { char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2, int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };
  const dv = new DataView(bytes.buffer, bytes.byteOffset + headEnd, bytes.byteLength - headEnd);
  const le = format !== 'binary_big_endian';
  let off = 0;
  const tokens = format === 'ascii' ? td.decode(bytes.subarray(headEnd)).split(/\s+/).filter(Boolean) : [];
  let ti = 0;
  const read = (type: string): number => {
    if (format === 'ascii') return +tokens[ti++];
    let v: number;
    switch (type) {
      case 'char': case 'int8': v = dv.getInt8(off); break;
      case 'uchar': case 'uint8': v = dv.getUint8(off); break;
      case 'short': case 'int16': v = dv.getInt16(off, le); break;
      case 'ushort': case 'uint16': v = dv.getUint16(off, le); break;
      case 'int': case 'int32': v = dv.getInt32(off, le); break;
      case 'uint': case 'uint32': v = dv.getUint32(off, le); break;
      case 'double': case 'float64': v = dv.getFloat64(off, le); break;
      default: v = dv.getFloat32(off, le);
    }
    off += sizes[type] ?? 4;
    return v;
  };
  let verts: Record<string, number[]> = {};
  const faces: number[][] = [];
  for (const el of elements) {
    if (el.name === 'vertex') {
      verts = Object.fromEntries(el.props.map((p) => [p.name, [] as number[]]));
      for (let i = 0; i < el.count; i++) for (const p of el.props) {
        if (p.list) { const n = read(p.list[0]); for (let k = 0; k < n; k++) read(p.list[1]); continue; }
        verts[p.name].push(read(p.type));
      }
    } else if (el.name === 'face') {
      for (let i = 0; i < el.count; i++) for (const p of el.props) {
        if (p.list) {
          const n = read(p.list[0]);
          const f: number[] = [];
          for (let k = 0; k < n; k++) f.push(read(p.list[1]));
          if (p.name === 'vertex_indices' || p.name === 'vertex_index') faces.push(f);
        } else read(p.type);
      }
    } else {
      for (let i = 0; i < el.count; i++) for (const p of el.props) {
        if (p.list) { const n = read(p.list[0]); for (let k = 0; k < n; k++) read(p.list[1]); } else read(p.type);
      }
    }
  }
  const n = verts.x?.length ?? 0;
  const P = new Array(n * 3);
  for (let i = 0; i < n; i++) { P[i * 3] = verts.x[i]; P[i * 3 + 1] = verts.y[i]; P[i * 3 + 2] = verts.z[i]; }
  const g = new Geometry({ positions: P, prims: faces });
  const used = new Set(['x', 'y', 'z']);
  if (verts.nx) { const a = g.points.add('N', 'float', 3); for (let i = 0; i < n; i++) a.set(i, [verts.nx[i], verts.ny[i], verts.nz[i]]); ['nx', 'ny', 'nz'].forEach((k) => used.add(k)); }
  const cr = verts.red ?? verts.r, cg = verts.green ?? verts.g, cb = verts.blue ?? verts.b;
  if (cr && cg && cb) {
    const scale = Math.max(...cr.slice(0, 1000)) > 1 ? 1 / 255 : 1;
    const a = g.points.add('Cd', 'float', 3);
    for (let i = 0; i < n; i++) a.set(i, [cr[i] * scale, cg[i] * scale, cb[i] * scale]);
    ['red', 'green', 'blue', 'r', 'g', 'b'].forEach((k) => used.add(k));
  }
  for (const [k, vals] of Object.entries(verts)) if (!used.has(k)) (g.points.add(k, 'float', 1).data as Float64Array).set(vals);
  return g;
}
