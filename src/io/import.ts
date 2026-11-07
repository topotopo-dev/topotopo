// Importers: OBJ, STL, PLY, glTF/GLB (gltf-transform, src/io/gltf.ts), native JSON, Houdini .geo (src/io/hgeo.ts),
// CSV and points JSON (src/io/points.ts), and PNG as a geometry holding one image volume (src/io/textures.ts).
//
// importGeometry() is synchronous and covers every format except glTF, whose reader (gltf-transform) is
// asynchronous: use importGeometryAsync() for glb/gltf (it handles every format, and reads external .bin files).
// OBJ: usemtl → prim "material"; importGeometryAsync also reads the .mtl files (mtllib) into the material table.
import { Geometry } from '../core/geometry.ts';
import { geoFromJSON } from './json.ts';
import { importGLTFAsync } from './gltf.ts';
import { importHoudiniBgeo, importHoudiniGeo, isBinaryJSON } from './hgeo.ts';
import { importCSV, importPointsJSON, isPointsJSON } from './points.ts';
import { imageFromPNGFile } from './textures.ts';
import { SIDECAR_FORMATS, SIDECAR_NAMES, SIDECAR_TEXT } from './sidecars.ts';
import { MATERIAL_ATTRIB, normalizeMaterial, primMaterials, writeMaterials } from '../core/materials.ts';
import type { MaterialTable } from '../core/materials.ts';

export { importGLTFAsync } from './gltf.ts';
export { importHoudiniBgeo, importHoudiniGeo } from './hgeo.ts';
export { importCSV, importPointsJSON } from './points.ts';

const td = new TextDecoder();

export const IMPORT_FORMATS = ['obj', 'stl', 'ply', 'glb', 'gltf', 'blend', 'json', 'geo', 'bgeo', 'csv', 'pointsjson', 'png'];

export interface ImportOptions {
  /** reads other files by path (glTF external buffers); usually Host.readFile */
  readFile?: (path: string) => Promise<Uint8Array>;
  /** path of the file, to resolve relative references */
  path?: string;
  /** receives non-fatal problems (skipped primitives or attributes) */
  warn?: (msg: string) => void;
  /** glTF shared meshes / EXT_mesh_gpu_instancing: 'packed' (default) = packed prims; 'expand' = real geometry */
  instancing?: 'packed' | 'expand';
}

/** Format from a file name: the extension, with ".points.json" → pointsjson (".png" → png: an image). */
export function importFormatFromPath(path: string): string {
  const p = String(path).split('?')[0].toLowerCase();
  if (p.endsWith('.points.json')) return 'pointsjson';
  if (p.endsWith('.bgeo.sc') || p.endsWith('.geo.sc') || p.endsWith('.bgeo.gz') || p.endsWith('.geo.gz')) return 'bgeo.sc';
  return p.slice(p.lastIndexOf('.') + 1);
}

/** JSON of any supported flavour: topotopo geometry, points stream, or Houdini .geo (a key/value array). */
function importAnyJSON(j: any, warn?: (m: string) => void): Geometry {
  if (Array.isArray(j)) return importHoudiniGeo(j, warn);
  if (isPointsJSON(j)) return importPointsJSON(j);
  // an export's sidecar (io/sidecars.ts) is metadata of the file beside it: say so instead of "not a topotopo-geo file"
  const role = typeof j?.format === 'string' ? SIDECAR_FORMATS[j.format] : undefined;
  if (role) throw new Error(`this JSON is an export's ${SIDECAR_NAMES[role]} (${SIDECAR_TEXT[role]}), not geometry: ${{
    source: 'read the exported file it sits beside',
    heightmap: j.format === 'png16' ? 'read the heightmap PNG beside it with heightfield_from_image (height_min / height_max from this sidecar)' : 'the RAW heightmap beside it is for Unreal; export png16 to read it back',
    meshes: 'read the instance stream (.csv / .points.json) beside it',
    landscape: 'read the files of its folder (heightmap.png, objects.glb)',
  }[role]}`);
  return geoFromJSON(j);
}

/** Synchronous import for every format except glb/gltf (see importGeometryAsync). */
export function importGeometry(bytes: Uint8Array, fmt: string, opts: ImportOptions = {}): Geometry {
  switch (fmt) {
    case 'obj': return importOBJ(td.decode(bytes), opts.warn);
    case 'stl': return importSTL(bytes);
    case 'ply': return importPLY(bytes);
    case 'json': return importAnyJSON(JSON.parse(td.decode(bytes)), opts.warn);
    case 'geo': case 'hgeo': case 'bgeo': return isBinaryJSON(bytes) ? importHoudiniBgeo(bytes, opts.warn) : importHoudiniGeo(td.decode(bytes), opts.warn);
    case 'csv': return importCSV(td.decode(bytes));
    case 'pointsjson': return importPointsJSON(JSON.parse(td.decode(bytes)));
    case 'png': {
      // an image volume named after the file, as the image_file node reads it with its defaults
      const g = new Geometry();
      g.volumes = [imageFromPNGFile(bytes, opts.path ?? 'image.png')];
      return g;
    }
    case 'glb': case 'gltf': throw new Error(`${fmt} import is asynchronous (gltf-transform): use importGeometryAsync`);
    case 'bgeo.sc': throw new Error('compressed Houdini geometry (.bgeo.sc / .gz) is not supported: save as .geo or uncompressed .bgeo');
    default: throw new Error(`unsupported import format "${fmt}" (${IMPORT_FORMATS.join(', ')})`);
  }
}

/** Import any supported format. */
export async function importGeometryAsync(bytes: Uint8Array, fmt: string, opts: ImportOptions = {}): Promise<Geometry> {
  if (fmt === 'glb' || fmt === 'gltf') return importGLTFAsync(bytes, opts);
  if (fmt === 'obj') return importOBJAsync(td.decode(bytes), opts);
  return importGeometry(bytes, fmt, opts);
}

/** An OBJ without its material libraries: usemtl names go into prim "material", the table stays empty (importOBJAsync reads it). */
export function importOBJ(text: string, warn?: (msg: string) => void): Geometry {
  const r = parseOBJ(text);
  if (r.mtllibs.length) warn?.(`obj: material library ${r.mtllibs.map((l) => `"${l}"`).join(', ')} not read (no file access here); prims keep their material names`);
  return r.geo;
}

/**
 * An OBJ with its materials: usemtl → prim "material", and the .mtl files its mtllib lines name (read with
 * opts.readFile, relative to opts.path) → the material table (readMTL). A library that cannot be read is warned of.
 */
export async function importOBJAsync(text: string, opts: ImportOptions = {}): Promise<Geometry> {
  const { geo, mtllibs } = parseOBJ(text);
  if (!mtllibs.length) return geo;
  if (!opts.readFile) return importOBJ(text, opts.warn);
  const dir = opts.path ? opts.path.replace(/[?#].*$/, '').replace(/[^\\/]*$/, '').replace(/[\\/]$/, '') : '';
  const table: MaterialTable = {};
  for (const lib of mtllibs) {
    const at = fileNear(dir, lib);
    try {
      const t = readMTL(td.decode(await opts.readFile(at)), dirOfPath(at));
      for (const [k, m] of Object.entries(t)) if (!(k in table)) table[k] = m;
    } catch (e: any) {
      opts.warn?.(`obj: material library "${lib}" could not be read (${e?.message ?? e}); prims keep their material names, shown with the default material`);
    }
  }
  const missing = [...new Set(primMaterials(geo) ?? [])].filter((m) => m && !(m in table));
  if (missing.length && Object.keys(table).length) opts.warn?.(`obj: ${missing.length} material(s) used but not defined in ${mtllibs.join(', ')}: ${missing.slice(0, 8).join(', ')}; shown with the default material`);
  writeMaterials(geo, table);
  return geo;
}

/** A path relative to a folder ("" = as it is), with "." and inner ".." resolved; absolute paths, drives and URLs stay. */
const fileNear = (dir: string, p: string) => {
  const q = p.replace(/\\/g, '/');
  if (!dir || /^[a-z][a-z0-9+.-]*:/i.test(q) || q.startsWith('/')) return q;
  const out: string[] = [];
  for (const s of `${dir.replace(/\\/g, '/').replace(/\/+$/, '')}/${q}`.split('/')) {
    if (s === '.' || (s === '' && out.length)) continue;
    if (s === '..' && out.length && out[out.length - 1] !== '..' && out[out.length - 1] !== '') out.pop();
    else out.push(s);
  }
  return out.join('/');
};
const dirOfPath = (p: string) => { const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')); return i < 0 ? '' : p.slice(0, i); };

/** Texture map options of a .mtl that take one value (-o, -s, -t take up to three numbers, -mm two). */
const MAP_OPTIONS = new Set(['-blendu', '-blendv', '-bm', '-boost', '-cc', '-clamp', '-imfchan', '-texres', '-type']);

/** Linear (.mtl, as Blender writes it) to display values (TopoTopo colours). */
const mtlDisplay = (c: number) => { const x = Math.max(0, Math.min(1, c)); return x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055; };

/**
 * A .mtl as a material table: Kd → baseColor, Ke → emissive (both linear in the file), d (else 1 - Tr) → alpha,
 * Pr → roughness (else from Ns: 1 - sqrt(Ns / 1000), as Blender reads it), Pm → metallic, map_Kd / norm / map_Pr →
 * the base colour, normal and roughness textures (relative to `dir`, the .mtl's folder; map options such as -s are skipped).
 */
export function readMTL(text: string, dir = ''): MaterialTable {
  const out: MaterialTable = {};
  let m: any = null, ns: number | null = null, rough = false, alpha = false;
  const close = () => {
    if (!m) return;
    if (!rough && ns !== null) m.roughness = 1 - Math.sqrt(Math.max(0, Math.min(1000, ns)) / 1000);
    out[m.name] = normalizeMaterial(m);
  };
  const map = (rest: string[]) => {
    // options (-s 1 1 1, -bm 0.5, -clamp on …) come before the file name, which may hold spaces
    let i = 0;
    while (i < rest.length - 1 && rest[i].startsWith('-')) {
      const opt = rest[i++].toLowerCase(), upTo3 = opt === '-o' || opt === '-s' || opt === '-t';
      const n = upTo3 ? 3 : opt === '-mm' ? 2 : MAP_OPTIONS.has(opt) ? 1 : 0;
      for (let k = 0; k < n && i < rest.length - 1 && (!upTo3 || /^[-+]?[\d.]/.test(rest[i])); k++) i++;
    }
    const file = rest.slice(i).join(' ');
    return file ? fileNear(dir, file) : '';
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const parts = line.split(/\s+/), tag = parts[0].toLowerCase(), rest = parts.slice(1);
    const rgb = () => (rest.length === 1 ? [rest[0], rest[0], rest[0]] : rest.slice(0, 3)).map((x) => mtlDisplay(+x));
    if (tag === 'newmtl') { close(); m = { name: line.slice(parts[0].length).trim(), textures: {} }; ns = null; rough = false; alpha = false; continue; }
    if (!m) continue;
    if (tag === 'kd') m.baseColor = rgb();
    else if (tag === 'ke') m.emissive = rgb();
    else if (tag === 'd') { m.alpha = +rest[0]; alpha = true; }
    else if (tag === 'tr' && !alpha) m.alpha = 1 - +rest[0];
    else if (tag === 'pr') { m.roughness = +rest[0]; rough = true; }
    else if (tag === 'pm') m.metallic = +rest[0];
    else if (tag === 'ns') ns = +rest[0];
    else if (tag === 'map_kd') m.textures.baseColor = map(rest);
    else if (tag === 'norm') m.textures.normal = map(rest);
    else if (tag === 'map_pr') m.textures.roughness = map(rest);
  }
  close();
  return out;
}

function parseOBJ(text: string): { geo: Geometry; mtllibs: string[] } {
  const V: number[] = [], VC: number[] = [], VT: number[] = [], VN: number[] = [];
  const faces: { v: number[]; t: number[]; n: number[]; name: string; mat: string; closed: boolean }[] = [];
  const mtllibs: string[] = [];
  let name = '', mat = '';
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
    else if (tag === 'usemtl') mat = parts.slice(1).join(' ');
    else if (tag === 'mtllib') { const lib = line.slice(tag.length).trim(); if (lib && !mtllibs.includes(lib)) mtllibs.push(lib); }
    else if (tag === 'f' || tag === 'l') {
      const f = { v: [] as number[], t: [] as number[], n: [] as number[], name, mat, closed: tag === 'f' };
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
  if (faces.some((f) => f.mat)) {
    const a = g.prims.add(MATERIAL_ATTRIB, 'string', 1);
    faces.forEach((f, i) => a.set(i, f.mat));
  }
  return { geo: g, mtllibs };
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
