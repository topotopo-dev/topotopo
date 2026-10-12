// Exporters: glTF/GLB (gltf-transform, src/io/gltf.ts), OBJ, STL, PLY, USDA, native JSON, Houdini .geo
// (src/io/hgeo.ts), CSV and points JSON (src/io/points.ts).
//
// exportGeometry() is synchronous and covers every format except glTF, whose writer (gltf-transform) is
// asynchronous: use exportGeometryAsync() for glb/gltf (it handles every format).
import { Geometry } from '../core/geometry.ts';
import { primNormals, resolveVertexNormals, triangulate } from '../core/topology.ts';
import { geoToJSON } from './json.ts';
import { exportGLB, exportGLTF } from './gltf.ts';
import { exportHoudiniGeo } from './hgeo.ts';
import { exportCSV, exportPointsJSON } from './points.ts';
import { decomposeXform, expandForExport, isolatedMask, pieces, xf, xfLinear } from './common.ts';
import type { ExportOptions } from './common.ts';
import { DEFAULT_TRANSFER, expandPacked, flattenSource, stripPacked } from '../core/packed.ts';
import { heightmapBytes } from './heightmap.ts';
import type { HeightmapFormat } from './heightmap.ts';

export type { ExportOptions } from './common.ts';
export { exportGLB, exportGLTF } from './gltf.ts';
export { exportHoudiniGeo } from './hgeo.ts';
export { exportCSV, exportPointsJSON } from './points.ts';

const SKIP_CUSTOM = new Set(['P', 'N', 'uv', 'Cd']);

function isolatedPoints(g: Geometry, o: ExportOptions) {
  const iso = isolatedMask(g);
  const P: number[] = [], C: number[] = [];
  const cd = g.points.get('Cd');
  for (let i = 0; i < g.numPoints; i++) if (iso[i]) {
    P.push(...xf(g.P[i * 3], g.P[i * 3 + 1], g.P[i * 3 + 2], o));
    if (cd) C.push(...(cd.get(i) as number[]));
  }
  return { positions: Float32Array.from(P), colors: cd ? Float32Array.from(C) : null };
}

// ---------------------------------------------------------------- OBJ

export function exportOBJ(g: Geometry, o: ExportOptions = {}): string {
  g = expandForExport(g, o, 'obj');
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
  g = expandForExport(g, o, 'stl');
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
  g = expandForExport(g, o, 'ply');
  const np = g.numPoints;
  const N = g.points.get('N'), Cd = g.points.get('Cd');
  const custom = o.custom !== false ? [...g.points.map].filter(([n, a]) => !SKIP_CUSTOM.has(n) && (a.type === 'float' || a.type === 'int') && a.size <= 4) : [];
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

/**
 * USDA stage: meshes, curves and points under /root, split by prim name. Packed instances (instancing 'packed', the
 * default) become one PointInstancer /root/instances whose prototypes (one per packed source, under its
 * "prototypes" scope) are written the same way; instancing 'expand' writes real copies instead.
 */
export function exportUSDA(g: Geometry, o: ExportOptions = {}): string {
  const out: string[] = ['#usda 1.0', '(', '    defaultPrim = "root"', '    metersPerUnit = 1', `    upAxis = "${o.upAxis === 'z' ? 'Z' : 'Y'}"`, ')', '', 'def Xform "root"', '{'];
  const used = new Set<string>();
  const uniq = (n: string) => { let k = usdName(n), i = 1; while (used.has(k)) k = usdName(n) + '_' + i++; used.add(k); return k; };
  let inst: Geometry | null = null;
  if (g.hasPacked()) {
    if (o.instancing === 'expand') g = expandPacked(g, { transfer: DEFAULT_TRANSFER }).geo;
    else { inst = g; g = stripPacked(g); }
  }
  usdaPrims(g, o, uniq, out);
  if (inst) usdaInstancer(inst, o, uniq, out);
  out.push('}', '');
  return out.join('\n');
}

/** PointInstancer for the packed prims of g (prototypes = packed sources), appended to out under /root. */
function usdaInstancer(g: Geometry, o: ExportOptions, uniq: (n: string) => string, out: string[]) {
  const kind = g.primKind!, S = g.packedSource!, X = g.packedXform!, P = g.P;
  const name = uniq('instances');
  const protoUsed = new Set<string>();
  const protoNames = g.packedSources.map((src, k) => {
    const na = src.prims.get('name');
    const vals = na && na.type === 'string' ? new Set(na.data as string[]) : null;
    let n = usdName(vals && vals.size === 1 && [...vals][0] ? [...vals][0] : `proto_${k}`), i = 1;
    const b = n;
    while (protoUsed.has(n)) n = b + '_' + i++;
    protoUsed.add(n);
    return n;
  });
  const idx: number[] = [], pos: number[] = [], ori: string[] = [], scl: number[] = [];
  let sheared = 0;
  for (let p = 0; p < kind.length; p++) {
    if (!kind[p] || g.primStart[p + 1] - g.primStart[p] !== 1) continue;
    const a = g.vertexPoint[g.primStart[p]];
    idx.push(S[p]);
    pos.push(...xf(P[a * 3], P[a * 3 + 1], P[a * 3 + 2], o));
    const d = decomposeXform(xfLinear(X, p * 9, o));
    if (d.shear) sheared++;
    ori.push(`(${fmt(d.q[3])}, ${fmt(d.q[0])}, ${fmt(d.q[1])}, ${fmt(d.q[2])})`);
    scl.push(...d.s);
  }
  out.push(`    def PointInstancer "${name}"`, '    {');
  out.push(`        rel prototypes = [${protoNames.map((n) => `</root/${name}/prototypes/${n}>`).join(', ')}]`);
  out.push(`        int[] protoIndices = [${idx.join(', ')}]`);
  out.push(`        point3f[] positions = [${Array.from({ length: pos.length / 3 }, (_, k) => tup(pos, k, 3)).join(', ')}]`);
  out.push(`        quath[] orientations = [${ori.join(', ')}]`);
  out.push(`        float3[] scales = [${Array.from({ length: scl.length / 3 }, (_, k) => tup(scl, k, 3)).join(', ')}]`);
  out.push('        def Scope "prototypes"', '        {');
  g.packedSources.forEach((src, k) => {
    out.push(`            def Xform "${protoNames[k]}"`, '            {');
    const lines: string[] = [];
    const pu = new Set<string>();
    usdaPrims(flattenSource(src), o, (n) => { let s = usdName(n), i = 1; while (pu.has(s)) s = usdName(n) + '_' + i++; pu.add(s); return s; }, lines);
    for (const l of lines) out.push('            ' + l);
    out.push('            }');
  });
  out.push('        }', '    }');
  if (sheared) o.warn?.(`usda PointInstancer: ${sheared} instance transform(s) have shear (non-uniform scale after rotation), written as orientation + per-axis scale; use instancing "expand" for exact geometry`);
}

/** Mesh, BasisCurves and Points prims of g (split by prim name) as USDA lines at the indentation of /root's children. */
function usdaPrims(g: Geometry, o: ExportOptions, uniq: (n: string) => string, out: string[]) {
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
}

export type ExportFormat = 'glb' | 'gltf' | 'obj' | 'stl' | 'ply' | 'usda' | 'json' | 'geo' | 'csv' | 'pointsjson' | HeightmapFormat;

export const EXPORT_FORMATS: ExportFormat[] = ['glb', 'gltf', 'obj', 'usda', 'ply', 'stl', 'json', 'geo', 'csv', 'pointsjson', 'png16', 'r16', 'mask_png'];

/** Format from a file name: the extension, with ".points.json" → pointsjson. */
export function exportFormatFromPath(path: string): string {
  const p = String(path).split('?')[0].toLowerCase();
  if (p.endsWith('.points.json')) return 'pointsjson';
  const ext = p.slice(p.lastIndexOf('.') + 1);
  return ext === 'usd' ? 'usda' : ext;
}

/** Synchronous export for every format except glb/gltf (see exportGeometryAsync). */
export function exportGeometry(g: Geometry, format: ExportFormat, o: ExportOptions = {}): Uint8Array {
  const enc = new TextEncoder();
  switch (format) {
    // heightfield -> Unreal heightmap (main file only; heightmapExport also returns the JSON sidecar and mask layers)
    case 'png16': case 'r16': case 'mask_png': return heightmapBytes(g, format, o);
    case 'obj': return enc.encode(exportOBJ(g, o));
    case 'stl': return exportSTL(g, o);
    case 'ply': return exportPLY(g, o);
    case 'usda': return enc.encode(exportUSDA(g, o));
    case 'json': return enc.encode(JSON.stringify(geoToJSON(g)));
    case 'geo': return enc.encode(exportHoudiniGeo(g, o));
    case 'csv': return enc.encode(exportCSV(g, o));
    case 'pointsjson': return enc.encode(exportPointsJSON(g, o));
    case 'glb': case 'gltf': throw new Error(`${format} export is asynchronous (gltf-transform): use exportGeometryAsync`);
    default: throw new Error(`unknown export format "${format}" (${EXPORT_FORMATS.join(', ')})`);
  }
}

/** Export to any format. */
export async function exportGeometryAsync(g: Geometry, format: ExportFormat, o: ExportOptions = {}): Promise<Uint8Array> {
  if (format === 'glb') return exportGLB(g, o);
  if (format === 'gltf') return new TextEncoder().encode(await exportGLTF(g, o));
  return exportGeometry(g, format, o);
}

export { primNormals };
