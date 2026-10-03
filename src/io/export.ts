// Exporters: glTF binary (GLB), OBJ, STL, PLY, USDA, native JSON.
import { Geometry } from '../core/geometry.ts';
import { primNormals, resolveVertexNormals, triangulate } from '../core/topology.ts';
import { geoToJSON } from './json.ts';

export interface ExportOptions {
  /** multiply positions (e.g. 100 for metres → centimetres) */
  scale?: number;
  /** 'y' (default) or 'z' to convert to a Z-up convention */
  upAxis?: 'y' | 'z';
  /** split into separate meshes/objects by the prim string attribute "name" */
  splitByName?: boolean;
  /** cusp angle for computed normals */
  cuspAngle?: number;
  /** include extra float point attributes (glTF _NAME, PLY properties, USD primvars) */
  custom?: boolean;
}

export interface MeshBuffers {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array | null;
  colors: Float32Array | null;
  indices: Uint32Array;
  custom: { name: string; size: number; data: Float32Array }[];
}

const SKIP_CUSTOM = new Set(['P', 'N', 'uv', 'Cd']);

function xf(x: number, y: number, z: number, o: ExportOptions): [number, number, number] {
  const s = o.scale ?? 1;
  return o.upAxis === 'z' ? [x * s, -z * s, y * s] : [x * s, y * s, z * s];
}

/** Welded triangle buffers with per-corner normals/uv/colours resolved by Houdini precedence. */
export function triangleBuffers(g: Geometry, o: ExportOptions = {}): MeshBuffers {
  const { tris } = triangulate(g);
  const vprim = g.vertexPrims();
  const vN = g.vertices.get('N'), pN = g.points.get('N');
  const normals = resolveVertexNormals(g, o.cuspAngle ?? 60);
  const nOf = (v: number): number[] => [normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]];
  const uvA = g.vertices.get('uv') ?? g.points.get('uv');
  const uvVtx = !!g.vertices.get('uv');
  const cdF = g.findAttrib('Cd', ['vertex', 'point', 'prim', 'detail']);
  const cOf = (v: number): number[] | null => {
    if (!cdF) return null;
    const a = cdF.attr;
    const i = cdF.cls === 'vertex' ? v : cdF.cls === 'point' ? g.vertexPoint[v] : cdF.cls === 'prim' ? vprim[v] : 0;
    const c = a.get(i);
    return Array.isArray(c) ? c : [c as number, c as number, c as number];
  };
  const customAttrs = o.custom ? [...g.points.map].filter(([n, a]) => !SKIP_CUSTOM.has(n) && a.type !== 'string' && a.size <= 4) : [];
  const fastKey = !vN && !!pN && !uvVtx && (!cdF || cdF.cls === 'point' || cdF.cls === 'detail');
  const map = new Map<string | number, number>();
  const P: number[] = [], N: number[] = [], UV: number[] = [], C: number[] = [];
  const CU: number[][] = customAttrs.map(() => []);
  const idx = new Uint32Array(tris.length);
  const Pd = g.P;
  const q = (x: number) => Math.round(x * 1e5);
  for (let k = 0; k < tris.length; k++) {
    const v = tris[k], pt = g.vertexPoint[v];
    const n = nOf(v), c = cOf(v);
    const uv = uvA ? (uvA.get(uvVtx ? v : pt) as number[]) : null;
    const key = fastKey ? pt : `${pt}|${q(n[0])},${q(n[1])},${q(n[2])}|${uv ? q(uv[0]) + ',' + q(uv[1]) : ''}|${c ? q(c[0]) + ',' + q(c[1]) + ',' + q(c[2]) : ''}`;
    let id = map.get(key);
    if (id === undefined) {
      id = P.length / 3;
      map.set(key, id);
      P.push(...xf(Pd[pt * 3], Pd[pt * 3 + 1], Pd[pt * 3 + 2], o));
      const nn = o.upAxis === 'z' ? [n[0], -n[2], n[1]] : n;
      N.push(nn[0], nn[1], nn[2]);
      if (uv) UV.push(uv[0], 1 - uv[1]);
      if (c) C.push(c[0], c[1], c[2]);
      customAttrs.forEach(([, a], ci) => { const val = a.get(pt); if (Array.isArray(val)) CU[ci].push(...val); else CU[ci].push(val as number); });
    }
    idx[k] = id;
  }
  return {
    positions: Float32Array.from(P), normals: Float32Array.from(N),
    uvs: uvA ? Float32Array.from(UV) : null, colors: cdF ? Float32Array.from(C) : null, indices: idx,
    custom: customAttrs.map(([name, a], ci) => ({ name, size: a.size, data: Float32Array.from(CU[ci]) })),
  };
}

function lineBuffers(g: Geometry, o: ExportOptions) {
  const P: number[] = [], I: number[] = [];
  const Pd = g.P;
  const map = new Map<number, number>();
  const id = (pt: number) => { let i = map.get(pt); if (i === undefined) { i = P.length / 3; map.set(pt, i); P.push(...xf(Pd[pt * 3], Pd[pt * 3 + 1], Pd[pt * 3 + 2], o)); } return i; };
  for (let pr = 0; pr < g.numPrims; pr++) {
    if (g.primClosed[pr]) continue;
    for (let v = g.primStart[pr]; v < g.primStart[pr + 1] - 1; v++) I.push(id(g.vertexPoint[v]), id(g.vertexPoint[v + 1]));
  }
  return { positions: Float32Array.from(P), indices: Uint32Array.from(I) };
}

function isolatedPoints(g: Geometry, o: ExportOptions) {
  const used = new Uint8Array(g.numPoints);
  for (let v = 0; v < g.numVertices; v++) used[g.vertexPoint[v]] = 1;
  const P: number[] = [], C: number[] = [];
  const cd = g.points.get('Cd');
  for (let i = 0; i < g.numPoints; i++) if (!used[i]) {
    P.push(...xf(g.P[i * 3], g.P[i * 3 + 1], g.P[i * 3 + 2], o));
    if (cd) C.push(...(cd.get(i) as number[]));
  }
  return { positions: Float32Array.from(P), colors: cd ? Float32Array.from(C) : null };
}

function pieces(g: Geometry, o: ExportOptions): { name: string; geo: Geometry }[] {
  const na = g.prims.get('name');
  if (!o.splitByName || !na || na.type !== 'string') return [{ name: 'mesh', geo: g }];
  const names = [...new Set(na.data as string[])];
  if (names.length <= 1) return [{ name: names[0] || 'mesh', geo: g }];
  const out = names.map((n) => ({ name: n || 'unnamed', geo: g.subsetPrims(Uint8Array.from(na.data as string[], (x) => (x === n ? 1 : 0))) }));
  const used = new Uint8Array(g.numPoints);
  for (let v = 0; v < g.numVertices; v++) used[g.vertexPoint[v]] = 1;
  if (used.some((u) => !u)) out.push({ name: 'points', geo: g.subsetPoints(used.map((u) => (u ? 0 : 1))) });
  return out;
}

// ---------------------------------------------------------------- GLB

export function exportGLB(g: Geometry, o: ExportOptions = {}): Uint8Array {
  const chunks: Uint8Array[] = [];
  let byteLen = 0;
  const json: any = {
    asset: { version: '2.0', generator: 'polyforge' },
    scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], accessors: [], bufferViews: [], buffers: [],
    materials: [{ name: 'default', pbrMetallicRoughness: { baseColorFactor: [0.8, 0.8, 0.8, 1], metallicFactor: 0, roughnessFactor: 0.8 }, doubleSided: false }],
  };
  const addView = (arr: Float32Array | Uint32Array, target?: number) => {
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    const pad = (4 - (byteLen % 4)) % 4;
    if (pad) { chunks.push(new Uint8Array(pad)); byteLen += pad; }
    json.bufferViews.push({ buffer: 0, byteOffset: byteLen, byteLength: bytes.byteLength, ...(target ? { target } : {}) });
    chunks.push(bytes);
    byteLen += bytes.byteLength;
    return json.bufferViews.length - 1;
  };
  const addAcc = (arr: Float32Array | Uint32Array, type: string, nc: number, target?: number, minmax = false) => {
    const view = addView(arr, target);
    const acc: any = { bufferView: view, componentType: arr instanceof Float32Array ? 5126 : 5125, count: arr.length / nc, type };
    if (minmax) {
      const mn = new Array(nc).fill(Infinity), mx = new Array(nc).fill(-Infinity);
      for (let i = 0; i < arr.length; i++) { const c = i % nc; mn[c] = Math.min(mn[c], arr[i]); mx[c] = Math.max(mx[c], arr[i]); }
      acc.min = mn; acc.max = mx;
    }
    json.accessors.push(acc);
    return json.accessors.length - 1;
  };
  const TYPES = ['SCALAR', 'VEC2', 'VEC3', 'VEC4'];
  for (const { name, geo } of pieces(g, { splitByName: true, ...o })) {
    const prims: any[] = [];
    let hasPoly = false;
    for (let p = 0; p < geo.numPrims; p++) if (geo.primClosed[p]) { hasPoly = true; break; }
    if (hasPoly) {
      const m = triangleBuffers(geo, o);
      if (m.indices.length) {
        const attributes: any = { POSITION: addAcc(m.positions, 'VEC3', 3, 34962, true), NORMAL: addAcc(m.normals, 'VEC3', 3, 34962) };
        if (m.uvs) attributes.TEXCOORD_0 = addAcc(m.uvs, 'VEC2', 2, 34962);
        if (m.colors) attributes.COLOR_0 = addAcc(m.colors, 'VEC3', 3, 34962);
        for (const c of m.custom) attributes['_' + c.name.toUpperCase()] = addAcc(c.data, TYPES[c.size - 1], c.size, 34962);
        prims.push({ attributes, indices: addAcc(m.indices, 'SCALAR', 1, 34963), material: 0, mode: 4 });
      }
    }
    const l = lineBuffers(geo, o);
    if (l.indices.length) prims.push({ attributes: { POSITION: addAcc(l.positions, 'VEC3', 3, 34962, true) }, indices: addAcc(l.indices, 'SCALAR', 1, 34963), mode: 1 });
    const pts = isolatedPoints(geo, o);
    if (pts.positions.length) {
      const attributes: any = { POSITION: addAcc(pts.positions, 'VEC3', 3, 34962, true) };
      if (pts.colors) attributes.COLOR_0 = addAcc(pts.colors, 'VEC3', 3, 34962);
      prims.push({ attributes, mode: 0 });
    }
    if (!prims.length) continue;
    json.meshes.push({ name, primitives: prims });
    json.nodes.push({ name, mesh: json.meshes.length - 1 });
    json.scenes[0].nodes.push(json.nodes.length - 1);
  }
  const pad = (4 - (byteLen % 4)) % 4;
  if (pad) { chunks.push(new Uint8Array(pad)); byteLen += pad; }
  json.buffers.push({ byteLength: byteLen });
  let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jpad = (4 - (jsonBytes.length % 4)) % 4;
  if (jpad) { const t = new Uint8Array(jsonBytes.length + jpad).fill(0x20); t.set(jsonBytes); jsonBytes = t; }
  const total = 12 + 8 + jsonBytes.length + 8 + byteLen;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length, true); dv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  let off = 20 + jsonBytes.length;
  dv.setUint32(off, byteLen, true); dv.setUint32(off + 4, 0x004e4942, true);
  off += 8;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

// ---------------------------------------------------------------- OBJ

export function exportOBJ(g: Geometry, o: ExportOptions = {}): string {
  const lines: string[] = ['# polyforge OBJ'];
  const Pd = g.P;
  const cd = g.points.get('Cd');
  for (let i = 0; i < g.numPoints; i++) {
    const p = xf(Pd[i * 3], Pd[i * 3 + 1], Pd[i * 3 + 2], o);
    const c = cd ? (cd.get(i) as number[]) : null;
    lines.push(`v ${p[0].toFixed(6)} ${p[1].toFixed(6)} ${p[2].toFixed(6)}${c ? ` ${c[0].toFixed(4)} ${c[1].toFixed(4)} ${c[2].toFixed(4)}` : ''}`);
  }
  const uvA = g.vertices.get('uv') ?? g.points.get('uv');
  const uvVtx = !!g.vertices.get('uv');
  if (uvA) for (let v = 0; v < g.numVertices; v++) { const t = uvA.get(uvVtx ? v : g.vertexPoint[v]) as number[]; lines.push(`vt ${t[0].toFixed(6)} ${t[1].toFixed(6)}`); }
  const N = resolveVertexNormals(g, o.cuspAngle ?? 60);
  const hasPoly = g.primClosed.some((c) => c === 1);
  if (hasPoly) for (let v = 0; v < g.numVertices; v++) {
    const n = [N[v * 3], N[v * 3 + 1], N[v * 3 + 2]];
    const nn = o.upAxis === 'z' ? [n[0], -n[2], n[1]] : n;
    lines.push(`vn ${nn[0].toFixed(5)} ${nn[1].toFixed(5)} ${nn[2].toFixed(5)}`);
  }
  const na = g.prims.get('name');
  let cur: string | null = null;
  for (let p = 0; p < g.numPrims; p++) {
    if (na && na.type === 'string') { const n = (na.data as string[])[p] || 'unnamed'; if (n !== cur) { lines.push(`o ${n}`); cur = n; } }
    const refs: string[] = [];
    for (let v = g.primStart[p]; v < g.primStart[p + 1]; v++) {
      const pi = g.vertexPoint[v] + 1;
      refs.push(g.primClosed[p] ? `${pi}/${uvA ? v + 1 : ''}/${v + 1}` : String(pi));
    }
    lines.push((g.primClosed[p] ? 'f ' : 'l ') + refs.join(' '));
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------- STL

export function exportSTL(g: Geometry, o: ExportOptions = {}): Uint8Array {
  const { tris } = triangulate(g);
  const nt = tris.length / 3;
  const out = new Uint8Array(84 + nt * 50);
  const dv = new DataView(out.buffer);
  new TextEncoder().encodeInto('polyforge STL', out);
  dv.setUint32(80, nt, true);
  const Pd = g.P;
  for (let t = 0; t < nt; t++) {
    const ps = [0, 1, 2].map((k) => { const i = g.vertexPoint[tris[t * 3 + k]]; return xf(Pd[i * 3], Pd[i * 3 + 1], Pd[i * 3 + 2], o); });
    const u = [ps[1][0] - ps[0][0], ps[1][1] - ps[0][1], ps[1][2] - ps[0][2]], w = [ps[2][0] - ps[0][0], ps[2][1] - ps[0][1], ps[2][2] - ps[0][2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    const base = 84 + t * 50;
    for (let c = 0; c < 3; c++) dv.setFloat32(base + c * 4, n[c] / l, true);
    for (let k = 0; k < 3; k++) for (let c = 0; c < 3; c++) dv.setFloat32(base + 12 + k * 12 + c * 4, ps[k][c], true);
  }
  return out;
}

// ---------------------------------------------------------------- PLY

export function exportPLY(g: Geometry, o: ExportOptions = {}): Uint8Array {
  const np = g.numPoints;
  const N = g.points.get('N'), Cd = g.points.get('Cd');
  const custom = o.custom !== false ? [...g.points.map].filter(([n, a]) => !SKIP_CUSTOM.has(n) && a.type !== 'string' && a.size <= 4) : [];
  const props: string[] = ['property float x', 'property float y', 'property float z'];
  if (N && N.size === 3) props.push('property float nx', 'property float ny', 'property float nz');
  if (Cd && Cd.size >= 3) props.push('property uchar red', 'property uchar green', 'property uchar blue');
  const comp = ['x', 'y', 'z', 'w'];
  for (const [n, a] of custom) for (let c = 0; c < a.size; c++) props.push(`property float ${a.size === 1 ? n : n + '_' + comp[c]}`);
  const faces: number[][] = [];
  for (let p = 0; p < g.numPrims; p++) if (g.primClosed[p]) faces.push(g.primPoints(p));
  const header = ['ply', 'format binary_little_endian 1.0', 'comment polyforge', `element vertex ${np}`, ...props, `element face ${faces.length}`, 'property list uchar int vertex_indices', 'end_header', ''].join('\n');
  const hb = new TextEncoder().encode(header);
  const vsize = 12 + (N && N.size === 3 ? 12 : 0) + (Cd && Cd.size >= 3 ? 3 : 0) + custom.reduce((s, [, a]) => s + a.size * 4, 0);
  const fsize = faces.reduce((s, f) => s + 1 + f.length * 4, 0);
  const out = new Uint8Array(hb.length + np * vsize + fsize);
  out.set(hb);
  const dv = new DataView(out.buffer);
  let off = hb.length;
  const Pd = g.P;
  for (let i = 0; i < np; i++) {
    const p = xf(Pd[i * 3], Pd[i * 3 + 1], Pd[i * 3 + 2], o);
    for (const v of p) { dv.setFloat32(off, v, true); off += 4; }
    if (N && N.size === 3) { const n = N.get(i) as number[]; const nn = o.upAxis === 'z' ? [n[0], -n[2], n[1]] : n; for (const v of nn) { dv.setFloat32(off, v, true); off += 4; } }
    if (Cd && Cd.size >= 3) { const c = Cd.get(i) as number[]; for (let k = 0; k < 3; k++) dv.setUint8(off++, Math.max(0, Math.min(255, Math.round(c[k] * 255)))); }
    for (const [, a] of custom) { const v = a.get(i); const arr = Array.isArray(v) ? v : [v as number]; for (const x of arr) { dv.setFloat32(off, x, true); off += 4; } }
  }
  for (const f of faces) { dv.setUint8(off++, f.length); for (const i of f) { dv.setInt32(off, i, true); off += 4; } }
  return out;
}

// ---------------------------------------------------------------- USDA

const usdName = (s: string) => (s.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1') || 'mesh');
const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(6).replace(/0+$/, '').replace(/\.$/, ''));
const tup = (a: ArrayLike<number>, k: number, n: number) => '(' + Array.from({ length: n }, (_, c) => fmt(a[k * n + c])).join(', ') + ')';

export function exportUSDA(g: Geometry, o: ExportOptions = {}): string {
  const out: string[] = ['#usda 1.0', '(', '    defaultPrim = "root"', '    metersPerUnit = 1', `    upAxis = "${o.upAxis === 'z' ? 'Z' : 'Y'}"`, ')', '', 'def Xform "root"', '{'];
  const used = new Set<string>();
  const uniq = (n: string) => { let k = usdName(n), i = 1; while (used.has(k)) k = usdName(n) + '_' + i++; used.add(k); return k; };
  for (const { name, geo } of pieces(g, { splitByName: true, ...o })) {
    const polys: number[] = [];
    for (let p = 0; p < geo.numPrims; p++) if (geo.primClosed[p]) polys.push(p);
    if (polys.length) {
      const pts: number[] = [];
      for (let i = 0; i < geo.numPoints; i++) pts.push(...xf(geo.P[i * 3], geo.P[i * 3 + 1], geo.P[i * 3 + 2], o));
      const counts: number[] = [], idx: number[] = [], vlist: number[] = [];
      for (const p of polys) { counts.push(geo.primSize(p)); for (let v = geo.primStart[p]; v < geo.primStart[p + 1]; v++) { idx.push(geo.vertexPoint[v]); vlist.push(v); } }
      const cn = resolveVertexNormals(geo, o.cuspAngle ?? 60);
      const nrm: number[] = [];
      for (const v of vlist) {
        const n = [cn[v * 3], cn[v * 3 + 1], cn[v * 3 + 2]];
        nrm.push(...(o.upAxis === 'z' ? [n[0], -n[2], n[1]] : n));
      }
      out.push(`    def Mesh "${uniq(name)}"`, '    {', '        uniform token subdivisionScheme = "none"');
      out.push(`        int[] faceVertexCounts = [${counts.join(', ')}]`);
      out.push(`        int[] faceVertexIndices = [${idx.join(', ')}]`);
      out.push(`        point3f[] points = [${Array.from({ length: pts.length / 3 }, (_, k) => tup(pts, k, 3)).join(', ')}]`);
      out.push(`        normal3f[] normals = [${Array.from({ length: nrm.length / 3 }, (_, k) => tup(nrm, k, 3)).join(', ')}] (`, '            interpolation = "faceVarying"', '        )');
      const uvA = geo.vertices.get('uv') ?? geo.points.get('uv');
      if (uvA) {
        const isV = !!geo.vertices.get('uv');
        const st = vlist.flatMap((v) => (uvA.get(isV ? v : geo.vertexPoint[v]) as number[]).slice(0, 2));
        out.push(`        texCoord2f[] primvars:st = [${Array.from({ length: st.length / 2 }, (_, k) => tup(st, k, 2)).join(', ')}] (`, '            interpolation = "faceVarying"', '        )');
      }
      const cd = geo.findAttrib('Cd', ['vertex', 'point', 'prim', 'detail']);
      if (cd) {
        const vprim = geo.vertexPrims();
        const cols = vlist.flatMap((v) => {
          const i = cd.cls === 'vertex' ? v : cd.cls === 'point' ? geo.vertexPoint[v] : cd.cls === 'prim' ? vprim[v] : 0;
          const c = cd.attr.get(i);
          return Array.isArray(c) ? c.slice(0, 3) : [c as number, c as number, c as number];
        });
        out.push(`        color3f[] primvars:displayColor = [${Array.from({ length: cols.length / 3 }, (_, k) => tup(cols, k, 3)).join(', ')}] (`, '            interpolation = "faceVarying"', '        )');
      }
      if (o.custom) for (const [n, a] of geo.points.map) {
        if (SKIP_CUSTOM.has(n) || a.type !== 'float' || (a.size !== 1 && a.size !== 3)) continue;
        const vals = Array.from(a.data as Float64Array);
        out.push(a.size === 1 ? `        float[] primvars:${usdName(n)} = [${vals.map(fmt).join(', ')}] (` : `        float3[] primvars:${usdName(n)} = [${Array.from({ length: vals.length / 3 }, (_, k) => tup(vals, k, 3)).join(', ')}] (`, '            interpolation = "vertex"', '        )');
      }
      out.push('    }');
    }
    const curves: number[] = [];
    for (let p = 0; p < geo.numPrims; p++) if (!geo.primClosed[p]) curves.push(p);
    if (curves.length) {
      const pts: number[] = [], counts: number[] = [], widths: number[] = [];
      const w = geo.points.get('width');
      for (const p of curves) {
        counts.push(geo.primSize(p));
        for (const i of geo.primPoints(p)) { pts.push(...xf(geo.P[i * 3], geo.P[i * 3 + 1], geo.P[i * 3 + 2], o)); widths.push(w ? (w.get(i) as number) * (o.scale ?? 1) : 0.01); }
      }
      out.push(`    def BasisCurves "${uniq(name + '_curves')}"`, '    {', '        uniform token type = "linear"');
      out.push(`        int[] curveVertexCounts = [${counts.join(', ')}]`);
      out.push(`        point3f[] points = [${Array.from({ length: pts.length / 3 }, (_, k) => tup(pts, k, 3)).join(', ')}]`);
      out.push(`        float[] widths = [${widths.map(fmt).join(', ')}] (`, '            interpolation = "vertex"', '        )', '    }');
    }
  }
  const iso = isolatedPoints(g, o);
  if (iso.positions.length) {
    const n = iso.positions.length / 3;
    out.push('    def Points "points"', '    {', `        point3f[] points = [${Array.from({ length: n }, (_, k) => tup(iso.positions, k, 3)).join(', ')}]`, `        float[] widths = [${new Array(n).fill('0.02').join(', ')}]`, '    }');
  }
  out.push('}', '');
  return out.join('\n');
}

export type ExportFormat = 'glb' | 'obj' | 'stl' | 'ply' | 'usda' | 'json';

export function exportGeometry(g: Geometry, format: ExportFormat, o: ExportOptions = {}): Uint8Array {
  const enc = new TextEncoder();
  switch (format) {
    case 'glb': return exportGLB(g, o);
    case 'obj': return enc.encode(exportOBJ(g, o));
    case 'stl': return exportSTL(g, o);
    case 'ply': return exportPLY(g, o);
    case 'usda': return enc.encode(exportUSDA(g, o));
    case 'json': return enc.encode(JSON.stringify(geoToJSON(g)));
    default: throw new Error(`unknown export format ${format}`);
  }
}

export { primNormals };
