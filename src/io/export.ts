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
import { INSTANCE_ATTRIB_SKIP, anchorAttribs, anchorValue, decomposeXform, expandForExport, isolatedMask, packedPrims, packedSourceNames, pieces, xf, xfDir, xfLinear } from './common.ts';
import type { ExportOptions } from './common.ts';
import { DEFAULT_TRANSFER, expandPacked, flattenSource, stripPacked } from '../core/packed.ts';
import { mergeMaterialTables, normalizeMaterial, primMaterials } from '../core/materials.ts';
import type { MaterialTable } from '../core/materials.ts';
import { heightmapBytes } from './heightmap.ts';
import { hasSplinesDeep, splinesToPolylinesDeep } from '../core/splines.ts';
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

/** The OBJ text (with mtllib when o.mtllib is given and a prim has a material); see objText for the .mtl. */
export function exportOBJ(g: Geometry, o: ExportOptions = {}): string {
  return objText(g, o).obj;
}

/**
 * An OBJ export's files: the .obj and, when a prim has a material (and o.materials is not false), the .mtl named by
 * o.mtllib, which the .obj references. Spline prims are written as polylines.
 */
export function exportOBJFiles(g: Geometry, o: ExportOptions = {}): { obj: Uint8Array; mtl: Uint8Array | null; materials: number } {
  const enc = new TextEncoder();
  const r = objText(splinesForExport(g, o, 'obj'), o);
  return { obj: enc.encode(r.obj), mtl: r.mtl !== null && o.mtllib ? enc.encode(r.mtl) : null, materials: r.materials };
}

/** A unique name for prims without a material among prims with one (OBJ has no "no material" once usemtl is set). */
function freeMaterialName(table: MaterialTable, used: Set<string>): string {
  let n = 'default', k = 1;
  while (n in table || used.has(n)) n = `default_${k++}`;
  return n;
}

/** sRGB display value ↔ linear: Kd and Ke in a .mtl are linear (as Blender writes and reads them), TopoTopo colours display values. */
const mtlLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const mtlRGB = (c: readonly number[]) => c.slice(0, 3).map((x) => mtlLinear(Math.max(0, x)).toFixed(6)).join(' ');

/**
 * The .mtl of the materials prims use, in order of first use: Kd / Ke (linear), d (alpha), Pr / Pm (roughness,
 * metallic: the PBR extension Blender reads) and Ns from the roughness for readers without it, map_Kd / norm / map_Pr
 * (texture paths through o.texturePath, else as the table writes them). A name missing from the table is written with
 * the default material.
 */
function mtlText(used: string[], table: MaterialTable, o: ExportOptions): string {
  const tex = (t: string | undefined) => (t ? (o.texturePath ? o.texturePath(t) : t) : '');
  const out = ['# topotopo MTL'];
  for (const name of used) {
    const m = table[name] ?? normalizeMaterial({});
    out.push('', `newmtl ${name}`, `Kd ${mtlRGB(m.baseColor)}`);
    if (m.emissive.some((x) => x > 0)) out.push(`Ke ${mtlRGB(m.emissive)}`);
    const r = Math.max(0, Math.min(1, m.roughness));
    out.push(`Ns ${((1 - r) ** 2 * 1000).toFixed(3)}`, `Pr ${r.toFixed(6)}`, `Pm ${Math.max(0, Math.min(1, m.metallic)).toFixed(6)}`, `d ${Math.max(0, Math.min(1, m.alpha)).toFixed(6)}`, 'illum 2');
    if (m.textures?.baseColor) out.push(`map_Kd ${tex(m.textures.baseColor)}`);
    if (m.textures?.normal) out.push(`norm ${tex(m.textures.normal)}`);
    if (m.textures?.roughness) out.push(`map_Pr ${tex(m.textures.roughness)}`);
    if (m.textures?.orm) o.warn?.(`obj: material "${name}": its orm map is not written (a .mtl has no packed occlusion/roughness/metallic map; glb and usda keep it)`);
  }
  return out.join('\n') + '\n';
}

function objText(g: Geometry, o: ExportOptions): { obj: string; mtl: string | null; materials: number } {
  g = expandForExport(g, o, 'obj');
  // prim materials: usemtl per run of prims (again after each object line), the .mtl with the ones used
  const mats = o.materials !== false ? primMaterials(g) : null;
  const withMat = !!mats && mats.some((m) => m);
  const table = withMat ? mergeMaterialTables([g]) : {};
  const used: string[] = [], seen = new Set<string>();
  const none = withMat && mats!.some((m) => !m) ? freeMaterialName(table, new Set(mats!)) : '';
  const matOf = (p: number) => (mats![p] || none);
  const lines: string[] = ['# topotopo OBJ'];
  if (withMat) {
    for (let p = 0; p < g.numPrims; p++) { const m = matOf(p); if (!seen.has(m)) { seen.add(m); used.push(m); } }
    if (o.mtllib) lines.push(`mtllib ${o.mtllib}`);
  }
  const Pd = g.P;
  const cd = g.points.get('Cd');
  for (let i = 0; i < g.numPoints; i++) {
    const p = xf(Pd[i * 3], Pd[i * 3 + 1], Pd[i * 3 + 2], o);
    const c = cd ? (cd.get(i) as number[]) : null;
    lines.push(`v ${p[0].toFixed(6)} ${p[1].toFixed(6)} ${p[2].toFixed(6)}${c ? ` ${c[0].toFixed(4)} ${c[1].toFixed(4)} ${c[2].toFixed(4)}` : ''}`);
  }
  // vt and vn of the face corners, each distinct value written once (a smooth mesh shares them between corners)
  const uvA = g.vertices.get('uv') ?? g.points.get('uv');
  const uvVtx = !!g.vertices.get('uv');
  const hasPoly = g.primClosed.some((c) => c === 1);
  const N = hasPoly ? resolveVertexNormals(g, o.cuspAngle ?? 60) : null;
  const vtOf = new Int32Array(g.numVertices), vnOf = new Int32Array(g.numVertices);
  const vtIds = new Map<string, number>(), vnIds = new Map<string, number>();
  const idOf = (ids: Map<string, number>, line: string) => { let i = ids.get(line); if (i === undefined) ids.set(line, (i = ids.size + 1)); return i; };
  for (let p = 0; p < g.numPrims; p++) {
    if (!g.primClosed[p]) continue;
    for (let v = g.primStart[p]; v < g.primStart[p + 1]; v++) {
      if (uvA) { const t = uvA.get(uvVtx ? v : g.vertexPoint[v]) as number[]; vtOf[v] = idOf(vtIds, `vt ${t[0].toFixed(6)} ${t[1].toFixed(6)}`); }
      const n = [N![v * 3], N![v * 3 + 1], N![v * 3 + 2]];
      const nn = o.upAxis === 'z' ? [n[0], -n[2], n[1]] : n;
      vnOf[v] = idOf(vnIds, `vn ${nn[0].toFixed(5)} ${nn[1].toFixed(5)} ${nn[2].toFixed(5)}`);
    }
  }
  for (const l of vtIds.keys()) lines.push(l);
  for (const l of vnIds.keys()) lines.push(l);
  const na = g.prims.get('name');
  let cur: string | null = null, curMat: string | null = null;
  for (let p = 0; p < g.numPrims; p++) {
    if (na && na.type === 'string') { const n = (na.data as string[])[p] || 'unnamed'; if (n !== cur) { lines.push(`o ${n}`); cur = n; curMat = null; } }
    if (withMat && matOf(p) !== curMat) { curMat = matOf(p); lines.push(`usemtl ${curMat}`); }
    const refs: string[] = [];
    for (let v = g.primStart[p]; v < g.primStart[p + 1]; v++) {
      const pi = g.vertexPoint[v] + 1;
      refs.push(g.primClosed[p] ? `${pi}/${uvA ? vtOf[v] : ''}/${vnOf[v]}` : String(pi));
    }
    lines.push((g.primClosed[p] ? 'f ' : 'l ') + refs.join(' '));
  }
  return { obj: lines.join('\n') + '\n', mtl: withMat ? mtlText(used, table, o) : null, materials: used.length };
}

// ---------------------------------------------------------------- STL

export function exportSTL(g: Geometry, o: ExportOptions = {}): Uint8Array {
  g = expandForExport(g, o, 'stl');
  const { tris } = triangulate(g);
  const nt = tris.length / 3;
  const out = new Uint8Array(84 + nt * 50);
  const dv = new DataView(out.buffer);
  new TextEncoder().encodeInto('topotopo STL', out);
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
  // PLY carries its extra properties by default (custom_attribs false drops them)
  const custom = o.custom !== false ? [...g.points.map].filter(([n, a]) => !SKIP_CUSTOM.has(n) && (a.type === 'float' || a.type === 'int') && a.size <= 4) : [];
  const props: string[] = ['property float x', 'property float y', 'property float z'];
  if (N && N.size === 3) props.push('property float nx', 'property float ny', 'property float nz');
  if (Cd && Cd.size >= 3) props.push('property uchar red', 'property uchar green', 'property uchar blue');
  const comp = ['x', 'y', 'z', 'w'];
  for (const [n, a] of custom) for (let c = 0; c < a.size; c++) props.push(`property float ${a.size === 1 ? n : n + '_' + comp[c]}`);
  const faces: number[][] = [];
  for (let p = 0; p < g.numPrims; p++) if (g.primClosed[p]) faces.push(g.primPoints(p));
  const header = ['ply', 'format binary_little_endian 1.0', 'comment topotopo', `element vertex ${np}`, ...props, `element face ${faces.length}`, 'property list uchar int vertex_indices', 'end_header', ''].join('\n');
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
/** A colour tuple for USD: TopoTopo colours are display values, USD colour inputs and primvars are linear. */
const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const tupColor = (a: ArrayLike<number>, k: number, n: number) => '(' + Array.from({ length: n }, (_, c) => fmt(linear(a[k * n + c]))).join(', ') + ')';

/**
 * USDA stage: meshes, curves and points under /root, split by prim name. Packed instances (instancing 'packed', the
 * default) become one PointInstancer /root/instances whose prototypes (one per packed source, under its
 * "prototypes" scope) are written the same way; instancing 'expand' writes real copies instead.
 * Per-instance data on the PointInstancer: ids (int "id"), velocities (v), primvars:displayColor / displayOpacity
 * (Cd / Alpha) and, unless custom is false, every other anchor attribute as primvars:<name>, all with interpolation
 * "vertex" (USD's per-instance interpolation on a PointInstancer).
 * Materials (unless materials is false): the material table becomes UsdPreviewSurface materials under
 * /root/materials, texture maps UsdUVTexture shaders reading primvars:st (asset paths through texturePath), bound
 * per mesh (MaterialBindingAPI) or per face set (GeomSubset family "materialBind") when a mesh mixes materials.
 */
export function exportUSDA(g: Geometry, o: ExportOptions = {}): string {
  const out: string[] = ['#usda 1.0', '(', '    defaultPrim = "root"', '    metersPerUnit = 1', `    upAxis = "${o.upAxis === 'z' ? 'Z' : 'Y'}"`, ')', '', 'def Xform "root"', '{'];
  const used = new Set<string>(['materials']);
  const uniq = (n: string) => { let k = usdName(n), i = 1; while (used.has(k)) k = usdName(n) + '_' + i++; used.add(k); return k; };
  let inst: Geometry | null = null;
  if (g.hasPacked()) {
    if (o.instancing === 'expand') g = expandPacked(g, { transfer: DEFAULT_TRANSFER }).geo;
    else { inst = g; g = stripPacked(g); }
  }
  const mats = o.materials === false ? null : usdaMaterials(mergeMaterialTables([g, ...(inst ? [inst, ...inst.packedSources] : [])]), o, out);
  usdaPrims(g, o, uniq, out, mats);
  if (inst) usdaInstancer(inst, o, uniq, out, mats);
  out.push('}', '');
  return out.join('\n');
}

const usdStr = (s: string) => JSON.stringify(String(s));
const usdAsset = (s: string) => '@' + String(s).replace(/\\/g, '/').replace(/@/g, '%40') + '@';

/**
 * UsdPreviewSurface materials for a table under /root/materials (nothing when the table is empty). Returns material
 * name → prim path.
 */
function usdaMaterials(table: MaterialTable, o: ExportOptions, out: string[]): Map<string, string> | null {
  const names = Object.keys(table);
  if (!names.length) return null;
  const paths = new Map<string, string>();
  const used = new Set<string>();
  out.push('    def Scope "materials"', '    {');
  for (const name of names) {
    const m = table[name];
    let id = usdName(name), k = 1;
    while (used.has(id)) id = `${usdName(name)}_${k++}`;
    used.add(id);
    const mp = `/root/materials/${id}`;
    paths.set(name, mp);
    const tex = m.textures ?? {};
    const file = (t: string) => usdAsset(o.texturePath ? o.texturePath(t) : t);
    const I = '            ';
    out.push(`        def Material "${id}"`, '        {', `            token outputs:surface.connect = <${mp}/surface.outputs:surface>`, '');
    out.push(`${I}def Shader "surface"`, `${I}{`, `${I}    uniform token info:id = "UsdPreviewSurface"`);
    out.push(`${I}    color3f inputs:diffuseColor = ${tupColor(m.baseColor, 0, 3)}`);
    if (tex.baseColor) out.push(`${I}    color3f inputs:diffuseColor.connect = <${mp}/base_color_map.outputs:rgb>`);
    out.push(`${I}    color3f inputs:emissiveColor = ${tupColor(m.emissive, 0, 3)}`);
    out.push(`${I}    float inputs:metallic = ${fmt(m.metallic)}`);
    if (tex.orm) out.push(`${I}    float inputs:metallic.connect = <${mp}/orm_map.outputs:b>`);
    out.push(`${I}    float inputs:roughness = ${fmt(m.roughness)}`);
    // an orm map (occlusion R, roughness G, metallic B) drives occlusion, roughness and metallic and wins over a roughness map
    if (tex.orm) out.push(`${I}    float inputs:roughness.connect = <${mp}/orm_map.outputs:g>`, `${I}    float inputs:occlusion.connect = <${mp}/orm_map.outputs:r>`);
    else if (tex.roughness) out.push(`${I}    float inputs:roughness.connect = <${mp}/roughness_map.outputs:r>`);
    if (tex.normal) out.push(`${I}    normal3f inputs:normal.connect = <${mp}/normal_map.outputs:rgb>`);
    out.push(`${I}    float inputs:opacity = ${fmt(m.alpha)}`);
    out.push(`${I}    int inputs:useSpecularWorkflow = 0`);
    out.push(`${I}    token outputs:surface`, `${I}}`);
    if (tex.baseColor || tex.normal || tex.roughness || tex.orm) {
      out.push('', `${I}def Shader "st_reader"`, `${I}{`, `${I}    uniform token info:id = "UsdPrimvarReader_float2"`, `${I}    string inputs:varname = "st"`, `${I}    float2 outputs:result`, `${I}}`);
      const texShader = (id2: string, path: string, colorSpace: string, output: string, extra: string[] = []) => {
        out.push('', `${I}def Shader "${id2}"`, `${I}{`, `${I}    uniform token info:id = "UsdUVTexture"`, `${I}    asset inputs:file = ${file(path)}`,
          `${I}    float2 inputs:st.connect = <${mp}/st_reader.outputs:result>`, `${I}    token inputs:sourceColorSpace = "${colorSpace}"`,
          `${I}    token inputs:wrapS = "repeat"`, `${I}    token inputs:wrapT = "repeat"`, ...extra.map((l) => I + '    ' + l), `${I}    ${output}`, `${I}}`);
      };
      if (tex.baseColor) texShader('base_color_map', tex.baseColor, 'sRGB', 'float3 outputs:rgb');
      if (tex.roughness && !tex.orm) texShader('roughness_map', tex.roughness, 'raw', 'float outputs:r');
      if (tex.orm) texShader('orm_map', tex.orm, 'raw', 'float outputs:r', ['float outputs:g', 'float outputs:b']);
      if (tex.normal) texShader('normal_map', tex.normal, 'raw', 'float3 outputs:rgb', ['float4 inputs:scale = (2, 2, 2, 1)', 'float4 inputs:bias = (-1, -1, -1, 0)']);
    }
    out.push('        }');
  }
  out.push('    }');
  return paths;
}

/** Material binding lines for a mesh/curves prim: a direct binding when all faces agree, else GeomSubsets. */
function usdaBinding(faceMats: (string | null)[], mats: Map<string, string> | null, indent: string): { schema: boolean; body: string[] } {
  if (!mats || !faceMats.length) return { schema: false, body: [] };
  const groups = new Map<string, number[]>();
  faceMats.forEach((m, i) => { if (m && mats.has(m)) { let l = groups.get(m); if (!l) groups.set(m, (l = [])); l.push(i); } });
  if (!groups.size) return { schema: false, body: [] };
  if (groups.size === 1 && [...groups.values()][0].length === faceMats.length) return { schema: true, body: [`${indent}rel material:binding = <${mats.get([...groups.keys()][0])}>`] };
  const body: string[] = [`${indent}uniform token subsetFamily:materialBind:familyType = "nonOverlapping"`];
  const used = new Set<string>();
  for (const [m, idx] of groups) {
    let id = 'mat_' + usdName(m), k = 1;
    while (used.has(id)) id = `mat_${usdName(m)}_${k++}`;
    used.add(id);
    body.push('', `${indent}def GeomSubset "${id}" (`, `${indent}    prepend apiSchemas = ["MaterialBindingAPI"]`, `${indent})`, `${indent}{`,
      `${indent}    uniform token elementType = "face"`, `${indent}    uniform token familyName = "materialBind"`,
      `${indent}    int[] indices = [${idx.join(', ')}]`, `${indent}    rel material:binding = <${mats.get(m)}>`, `${indent}}`);
  }
  return { schema: false, body };
}

/** USD array type of an attribute (null when it has no USD form here). */
function usdArrayType(type: string, size: number): string | null {
  if (type === 'string') return size === 1 ? 'string[]' : null;
  if (size < 1 || size > 4) return null;
  const base = type === 'int' ? 'int' : 'float';
  return size === 1 ? `${base}[]` : `${base}${size}[]`;
}

/** PointInstancer for the packed prims of g (prototypes = packed sources), appended to out under /root. */
function usdaInstancer(g: Geometry, o: ExportOptions, uniq: (n: string) => string, out: string[], mats: Map<string, string> | null = null) {
  const kind = g.primKind!, S = g.packedSource!, X = g.packedXform!, P = g.P;
  const name = uniq('instances');
  const protoNames = packedSourceNames(g).map(usdName);
  const idx: number[] = [], pos: number[] = [], ori: string[] = [], scl: number[] = [];
  let sheared = 0;
  for (let p = 0; p < kind.length; p++) {
    if (kind[p] !== 1 || g.primStart[p + 1] - g.primStart[p] !== 1) continue;
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
  // per-instance data: ids, velocities, display colour / opacity, other anchor attributes as primvars
  const prims = packedPrims(g);
  const vertex = ['            interpolation = "vertex"', '        )'];
  for (const a of anchorAttribs(g, INSTANCE_ATTRIB_SKIP)) {
    const vals = prims.map((p) => anchorValue(g, a, p));
    const num = vals as number[][];
    const t = a.attr.type, sz = a.attr.size;
    if (a.name === 'id' && t === 'int' && sz === 1) { out.push(`        int64[] ids = [${num.map((v) => v[0]).join(', ')}]`); continue; }
    if (a.name === 'v' && t === 'float' && sz === 3) {
      const sc = o.scale ?? 1;
      out.push(`        vector3f[] velocities = [${num.map((v) => { const d = xfDir(v[0] * sc, v[1] * sc, v[2] * sc, o); return tup(d, 0, 3); }).join(', ')}]`);
      continue;
    }
    // display colour / opacity only when they say something (merged geometry gives anchors Houdini's white default)
    if ((a.name === 'Cd' || a.name === 'Alpha') && t === 'float' && num.every((v) => v.every((x) => x === 1))) continue;
    if (a.name === 'Cd' && t === 'float' && sz >= 3) { out.push(`        color3f[] primvars:displayColor = [${num.map((v) => tupColor(v, 0, 3)).join(', ')}] (`, ...vertex); continue; }
    if (a.name === 'Alpha' && t === 'float' && sz === 1) { out.push(`        float[] primvars:displayOpacity = [${num.map((v) => fmt(v[0])).join(', ')}] (`, ...vertex); continue; }
    if (o.custom !== true) continue;
    const ut = usdArrayType(t, sz);
    if (!ut) continue;
    const body = t === 'string' ? (vals as string[]).map(usdStr).join(', ') : sz === 1 ? num.map((v) => fmt(v[0])).join(', ') : num.map((v) => tup(v, 0, sz)).join(', ');
    out.push(`        ${ut} primvars:${usdName(a.name)} = [${body}] (`, ...vertex);
  }
  out.push('        def Scope "prototypes"', '        {');
  g.packedSources.forEach((src, k) => {
    out.push(`            def Xform "${protoNames[k]}"`, '            {');
    const lines: string[] = [];
    const pu = new Set<string>();
    usdaPrims(flattenSource(src), o, (n) => { let s = usdName(n), i = 1; while (pu.has(s)) s = usdName(n) + '_' + i++; pu.add(s); return s; }, lines, mats);
    for (const l of lines) out.push('            ' + l);
    out.push('            }');
  });
  out.push('        }', '    }');
  if (sheared) o.warn?.(`usda PointInstancer: ${sheared} instance transform(s) have shear (non-uniform scale after rotation), written as orientation + per-axis scale; use instancing "expand" for exact geometry`);
}

/** Mesh, BasisCurves and Points prims of g (split by prim name) as USDA lines at the indentation of /root's children. */
function usdaPrims(g: Geometry, o: ExportOptions, uniq: (n: string) => string, out: string[], mats: Map<string, string> | null = null) {
  for (const { name, geo } of pieces(g, { splitByName: true, ...o })) {
    const polys: number[] = [];
    for (let p = 0; p < geo.numPrims; p++) if (geo.primClosed[p]) polys.push(p);
    const pm = mats ? primMaterials(geo) : null;
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
      const bind = usdaBinding(pm ? polys.map((p) => pm[p] || null) : [], mats, '        ');
      out.push(`    def Mesh "${uniq(name)}"${bind.schema ? ' (' : ''}`, ...(bind.schema ? ['        prepend apiSchemas = ["MaterialBindingAPI"]', '    )'] : []), '    {', '        uniform token subdivisionScheme = "none"');
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
        out.push(`        color3f[] primvars:displayColor = [${Array.from({ length: cols.length / 3 }, (_, k) => tupColor(cols, k, 3)).join(', ')}] (`, '            interpolation = "faceVarying"', '        )');
      }
      if (o.custom) for (const [n, a] of geo.points.map) {
        if (SKIP_CUSTOM.has(n) || a.type !== 'float' || (a.size !== 1 && a.size !== 3)) continue;
        const vals = Array.from(a.data as Float64Array);
        out.push(a.size === 1 ? `        float[] primvars:${usdName(n)} = [${vals.map(fmt).join(', ')}] (` : `        float3[] primvars:${usdName(n)} = [${Array.from({ length: vals.length / 3 }, (_, k) => tup(vals, k, 3)).join(', ')}] (`, '            interpolation = "vertex"', '        )');
      }
      out.push(...bind.body);
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
      const cb = usdaBinding(pm ? curves.map((p) => pm[p] || null) : [], mats, '        ');
      const cbind = cb.schema ? cb : { schema: false, body: [] as string[] }; // curves: whole-prim binding only
      out.push(`    def BasisCurves "${uniq(name + '_curves')}"${cbind.schema ? ' (' : ''}`, ...(cbind.schema ? ['        prepend apiSchemas = ["MaterialBindingAPI"]', '    )'] : []), '    {', '        uniform token type = "linear"');
      out.push(`        int[] curveVertexCounts = [${counts.join(', ')}]`);
      out.push(`        point3f[] points = [${Array.from({ length: pts.length / 3 }, (_, k) => tup(pts, k, 3)).join(', ')}]`);
      out.push(`        float[] widths = [${widths.map(fmt).join(', ')}] (`, '            interpolation = "vertex"', '        )', ...cbind.body, '    }');
    }
  }
  const iso = isolatedPoints(g, o);
  if (iso.positions.length) {
    const n = iso.positions.length / 3;
    out.push('    def Points "points"', '    {', `        point3f[] points = [${Array.from({ length: n }, (_, k) => tup(iso.positions, k, 3)).join(', ')}]`, `        float[] widths = [${new Array(n).fill('0.02').join(', ')}]`, '    }');
  }
}

export type ExportFormat = 'glb' | 'gltf' | 'obj' | 'stl' | 'ply' | 'usda' | 'json' | 'geo' | 'csv' | 'pointsjson' | HeightmapFormat | 'unreal_landscape' | 'textures';

/** Every export format; unreal_landscape and textures write a directory (exportFilesAsync in io/files.ts). */
export const EXPORT_FORMATS: ExportFormat[] = ['glb', 'gltf', 'obj', 'usda', 'ply', 'stl', 'json', 'geo', 'csv', 'pointsjson', 'png16', 'r16', 'mask_png', 'unreal_landscape', 'textures'];

/** Format from a file name: the extension, with ".points.json" → pointsjson. */
export function exportFormatFromPath(path: string): string {
  const p = String(path).split('?')[0].toLowerCase();
  if (p.endsWith('.points.json')) return 'pointsjson';
  const ext = p.slice(p.lastIndexOf('.') + 1);
  return ext === 'usd' ? 'usda' : ext;
}

/**
 * Spline prims (Bezier/NURBS), also inside packed sources, written as the polylines they evaluate to, with a note: the
 * formats here have no spline prims (json keeps them losslessly and is not converted).
 */
function splinesForExport(g: Geometry, o: ExportOptions, format: string): Geometry {
  if (!hasSplinesDeep(g)) return g;
  const n = g.numSplines;
  o.warn?.(`${format}: ${n ? `${n} spline curve${n === 1 ? '' : 's'}` : 'spline curves inside packed instances'} (Bezier/NURBS) written as polylines (json keeps them as splines)`);
  return splinesToPolylinesDeep(g).geo;
}

/** Synchronous export for every format except glb/gltf (see exportGeometryAsync). */
export function exportGeometry(g: Geometry, format: ExportFormat, o: ExportOptions = {}): Uint8Array {
  const enc = new TextEncoder();
  if (format !== 'json') g = splinesForExport(g, o, format);
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
    case 'unreal_landscape': throw new Error('unreal_landscape writes a directory of files: use exportFilesAsync (src/io/files.ts)');
    case 'textures': throw new Error('textures writes a directory of PNG files: use exportFilesAsync (src/io/files.ts)');
    default: throw new Error(`unknown export format "${format}" (${EXPORT_FORMATS.join(', ')})`);
  }
}

/** Export to any format. */
export async function exportGeometryAsync(g: Geometry, format: ExportFormat, o: ExportOptions = {}): Promise<Uint8Array> {
  if (format === 'glb' || format === 'gltf') g = splinesForExport(g, o, format);
  if (format === 'glb') return exportGLB(g, o);
  if (format === 'gltf') return new TextEncoder().encode(await exportGLTF(g, o));
  return exportGeometry(g, format, o);
}

export { primNormals };
