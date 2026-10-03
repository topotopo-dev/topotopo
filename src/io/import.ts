// Importers: OBJ, STL, PLY, glTF/GLB, native JSON.
import { GeoBuilder, Geometry } from '../core/geometry.ts';
import { geoFromJSON } from './json.ts';
import { m4apply, m4applyDir, m4fromQuat, m4identity, m4mul, m4normalMatrix, m4scale, m4translate } from '../core/math.ts';
import type { Mat4 } from '../core/math.ts';

const td = new TextDecoder();

export function importGeometry(bytes: Uint8Array, fmt: string): Geometry {
  switch (fmt) {
    case 'obj': return importOBJ(td.decode(bytes));
    case 'stl': return importSTL(bytes);
    case 'ply': return importPLY(bytes);
    case 'glb': case 'gltf': return importGLTF(bytes);
    case 'json': return geoFromJSON(JSON.parse(td.decode(bytes)));
    default: throw new Error(`unsupported import format "${fmt}" (obj, stl, ply, glb, gltf, json)`);
  }
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

export function importGLTF(bytes: Uint8Array): Geometry {
  let json: any, bin: Uint8Array | null = null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) === 0x46546c67) {
    let off = 12;
    while (off < bytes.byteLength) {
      const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
      const chunk = bytes.subarray(off + 8, off + 8 + len);
      if (type === 0x4e4f534a) json = JSON.parse(td.decode(chunk));
      else if (type === 0x004e4942) bin = chunk;
      off += 8 + len;
    }
  } else json = JSON.parse(td.decode(bytes));
  if ((json.extensionsUsed ?? []).some((e: string) => /draco|meshopt/i.test(e))) throw new Error('compressed glTF (Draco/meshopt) is not supported; export uncompressed');
  const buffers: Uint8Array[] = (json.buffers ?? []).map((b: any, i: number) => {
    if (b.uri?.startsWith('data:')) return Uint8Array.from(atob(b.uri.split(',')[1]), (c) => c.charCodeAt(0));
    if (i === 0 && bin) return bin;
    throw new Error('external glTF buffers are not supported; use .glb or embedded data URIs');
  });
  const COMP: Record<number, [number, (d: DataView, o: number) => number, number]> = {
    5120: [1, (d, o) => d.getInt8(o), 127], 5121: [1, (d, o) => d.getUint8(o), 255], 5122: [2, (d, o) => d.getInt16(o, true), 32767],
    5123: [2, (d, o) => d.getUint16(o, true), 65535], 5125: [4, (d, o) => d.getUint32(o, true), 4294967295], 5126: [4, (d, o) => d.getFloat32(o, true), 1],
  };
  const NC: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
  const accessor = (i: number): number[][] => {
    const a = json.accessors[i];
    const bv = json.bufferViews[a.bufferView];
    const buf = buffers[bv.buffer];
    const [cs, rd, mx] = COMP[a.componentType];
    const nc = NC[a.type];
    const stride = bv.byteStride || cs * nc;
    const d = new DataView(buf.buffer, buf.byteOffset + (bv.byteOffset ?? 0) + (a.byteOffset ?? 0));
    const out: number[][] = [];
    for (let k = 0; k < a.count; k++) {
      const e: number[] = [];
      for (let c = 0; c < nc; c++) { const v = rd(d, k * stride + c * cs); e.push(a.normalized ? Math.max(v / mx, -1) : v); }
      out.push(e);
    }
    return out;
  };
  const parts: Geometry[] = [];
  const visit = (ni: number, parent: Mat4) => {
    const n = json.nodes[ni];
    let m = m4identity();
    if (n.matrix) m = Float64Array.from(n.matrix);
    else {
      const t = n.translation ?? [0, 0, 0], r = n.rotation ?? [0, 0, 0, 1], s = n.scale ?? [1, 1, 1];
      m = m4mul(m4translate(t[0], t[1], t[2]), m4mul(m4fromQuat(r), m4scale(s[0], s[1], s[2])));
    }
    const world = m4mul(parent, m);
    if (n.mesh !== undefined) {
      const mesh = json.meshes[n.mesh];
      for (const prim of mesh.primitives) {
        const mode = prim.mode ?? 4;
        const P = accessor(prim.attributes.POSITION);
        const idx = prim.indices !== undefined ? accessor(prim.indices).map((x) => x[0]) : P.map((_, i) => i);
        const b = new GeoBuilder();
        const nm = m4normalMatrix(world);
        for (const q of P) { const w = m4apply(world, q[0], q[1], q[2]); b.addPoint(w[0], w[1], w[2]); }
        const setPt = (name: string, acc: number | undefined, size: number, fn?: (v: number[]) => number[]) => {
          if (acc === undefined) return;
          const a = b.attrib('point', name, size);
          accessor(acc).forEach((v, i) => a.set(i, fn ? fn(v) : v.slice(0, size)));
        };
        setPt('N', prim.attributes.NORMAL, 3, (v) => { const r = m4applyDir(nm, v[0], v[1], v[2]) as number[]; const l = Math.hypot(r[0], r[1], r[2]) || 1; return r.map((x) => x / l); });
        setPt('uv', prim.attributes.TEXCOORD_0, 3, (v) => [v[0], 1 - v[1], 0]);
        setPt('Cd', prim.attributes.COLOR_0, 3, (v) => v.slice(0, 3));
        if (mode === 4) for (let i = 0; i + 2 < idx.length; i += 3) b.addPrim([idx[i], idx[i + 1], idx[i + 2]]);
        else if (mode === 1) for (let i = 0; i + 1 < idx.length; i += 2) b.addPrim([idx[i], idx[i + 1]], false);
        else if (mode === 3 || mode === 2) b.addPrim(idx, mode === 2 ? true : false);
        const g = b.build();
        if (n.name || mesh.name) { const a = g.prims.add('name', 'string', 1); for (let k = 0; k < g.numPrims; k++) a.set(k, n.name ?? mesh.name); }
        parts.push(g);
      }
    }
    for (const c of n.children ?? []) visit(c, world);
  };
  const scene = json.scenes?.[json.scene ?? 0];
  const roots: number[] = scene?.nodes ?? json.nodes?.map((_: any, i: number) => i) ?? [];
  for (const r of roots) visit(r, m4identity());
  return Geometry.merge(parts);
}
