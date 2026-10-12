// Interop round trips: glTF through gltf-transform (plain, quantized, meshopt) with materials, vertex colours,
// uvs, custom attributes, polylines and points; Houdini .geo (all attribute classes, groups, strings, polylines,
// a hand-written Houdini-style sample); CSV (plain + Unreal PCG); points JSON. Every GLB written is checked with
// the Khronos glTF validator (gltf-validator, offline).
// Part 2: the instance stream (rows, Unreal transforms rebuilt within 1e-6, re-instancing, meshes sidecar + GLBs),
// per-instance attributes in glTF and USD, packed Houdini .geo, material textures (glTF embed, USD UsdUVTexture,
// import paths), the Unreal Landscape bundle, and scripts/export-demo.ts in a temp dir.
//   node test/interop.ts
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { Geometry } from '../src/core/geometry.ts';
import type { AttribClass } from '../src/core/geometry.ts';
import { readMaterials } from '../src/core/materials.ts';
import { primNormals, signedVolume } from '../src/core/topology.ts';
import { exportGeometry, exportGeometryAsync } from '../src/io/export.ts';
import type { ExportFormat, ExportOptions } from '../src/io/export.ts';
import { importGeometry, importGeometryAsync } from '../src/io/import.ts';
import { checkGeo, ROOT } from './fixtures.ts';

const require = createRequire(import.meta.url);
const validator = require('gltf-validator');

let fail = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) fail++; };
const close = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

const engine = new Engine(createNodeHost());
await engine.init();
const cook = async (graph: any): Promise<Geometry> => {
  const r = await engine.cook(graph);
  if (!r.ok || !r.geo) throw new Error(r.errors.map((e) => `${e.node}: ${e.message}`).join('; '));
  return r.geo;
};

async function validate(bytes: Uint8Array, label: string) {
  const report = await validator.validateBytes(bytes, { maxIssues: 50, writeTimestamp: false });
  const errs = report.issues.messages.filter((m: any) => m.severity === 0);
  const warns = report.issues.messages.filter((m: any) => m.severity === 1);
  check(errs.length === 0, `${label}: glTF validator ${report.issues.numErrors} errors, ${report.issues.numWarnings} warnings${errs.length ? ' — ' + errs.slice(0, 3).map((m: any) => `${m.code} ${m.pointer ?? ''} ${m.message}`).join(' | ') : ''}${warns.length ? ' (warnings: ' + [...new Set(warns.map((m: any) => m.code))].join(', ') + ')' : ''}`);
}

// ---------------------------------------------------------------- source geometry
// box with materials (two), point colours, uvs, a custom float and int attribute; a polyline; isolated points
const scene = await cook({
  nodes: {
    b: { type: 'box', params: { divisions: [2, 2, 2] } },
    c: { type: 'color', in: ['b'], params: { mode: 'random', class: 'point' } },
    h: { type: 'attrib_randomize', in: ['c'], params: { name: 'heat' } },
    id: { type: 'wrangle', in: ['h'], params: { code: 'i@tag = @ptnum % 5;' } },
    m1: { type: 'material', in: ['id'], params: { name: 'brick', base_color: '#a5462e', roughness: 0.9, metallic: 0.1 } },
    m2: { type: 'material', in: ['m1'], params: { name: 'glass', group: '@P.y>0.4', base_color: [0.6, 0.8, 1], alpha: 0.4, emissive: [2, 1, 0], double_sided: true } },
    crv: { type: 'curve', params: { points: [[0, 0, 0], [1, 0.5, 0.2], [2, 0, 0.5], [3, 0.4, 0]] } },
    crvm: { type: 'material', in: ['crv'], params: { name: 'wire', base_color: [0, 0, 1], unlit: true } },
    pts: { type: 'point_grid', params: { counts: [3, 1, 3], size: [1, 0, 1], center: [0, 2, 0] } },
    ps: { type: 'attrib_randomize', in: ['pts'], params: { name: 'pscale', min: 0.1, max: 0.5 } },
    out: { type: 'merge', in: ['m2', 'crvm', 'ps'] },
  },
  output: 'out',
});
check(checkGeo(scene).length === 0, 'source geometry is valid');
const table = readMaterials(scene);
check(Object.keys(table).sort().join(',') === 'brick,glass,wire', `merge unions material tables (${Object.keys(table).join(',')})`);

const srcPolys = scene.primClosed.reduce((s, c) => s + c, 0);
const srcCurves = scene.numPrims - srcPolys;

// ---------------------------------------------------------------- glTF
const variants: [string, ExportOptions][] = [['plain', {}], ['quantized', { quantize: true }], ['meshopt', { compress: 'meshopt' }]];
for (const [label, opts] of variants) {
  const bytes = await exportGeometryAsync(scene, 'glb', opts);
  await validate(bytes, `glb ${label}`);
  const back = await importGeometryAsync(bytes, 'glb');
  check(checkGeo(back).length === 0, `glb ${label}: re-import is valid (${bytes.byteLength} bytes → ${back.numPoints} pts, ${back.numPrims} prims)`);
  const polys = back.primClosed.reduce((s, c) => s + c, 0);
  check(polys === srcPolys * 2, `glb ${label}: ${polys} triangles from ${srcPolys} quads`);
  check(back.numPrims - polys === srcCurves, `glb ${label}: ${back.numPrims - polys} polylines (LINE_STRIP) from ${srcCurves}`);
  const cv = back.primStart.length > 1 ? [...Array(back.numPrims).keys()].filter((p) => !back.primClosed[p]).map((p) => back.primSize(p)) : [];
  check(cv.length === 1 && cv[0] === 4, `glb ${label}: polyline keeps its 4 points`);
  const t = readMaterials(back);
  check(JSON.stringify(t) === JSON.stringify(table), `glb ${label}: material table round trips (${Object.keys(t).join(',')})`);
  const mat = back.prims.get('material');
  check(!!mat && new Set(mat.data as string[]).size === 3, `glb ${label}: prim material attribute (${mat ? [...new Set(mat.data as string[])].join(',') : 'missing'})`);
  check(back.points.has('Cd') && back.points.has('uv') && back.points.has('N'), `glb ${label}: Cd, uv, N present`);
  const heat = back.points.get('heat'), tag = back.points.get('tag'), ps = back.points.get('pscale');
  check(!!heat && heat.type === 'float' && !!tag && tag.type === 'int', `glb ${label}: custom float "heat" and int "tag" keep names and types`);
  check(!!ps, `glb ${label}: pscale on points`);
  const bb0 = scene.bbox(), bb1 = back.bbox();
  const tol = label === 'plain' ? 1e-6 : 3e-4;
  check([0, 1, 2].every((c) => close(bb0.min[c], bb1.min[c], tol) && close(bb0.max[c], bb1.max[c], tol)), `glb ${label}: bbox matches (tol ${tol})`);
  // pscale values survive on the isolated points
  if (ps) {
    const src = (scene.points.get('pscale')!.data as Float64Array).filter((x) => x !== 1);
    const got = (ps.data as Float64Array).filter((x) => x !== 1);
    check(src.length === got.length && [...src].sort().every((x, i) => close(x, [...got].sort()[i], 1e-6)), `glb ${label}: pscale values survive`);
  }
}

// gltf JSON with an embedded buffer, and a .gltf + external .bin read through the host
{
  const text = new TextDecoder().decode(await exportGeometryAsync(scene, 'gltf'));
  const back = await importGeometryAsync(new TextEncoder().encode(text), 'gltf');
  check(text.includes('data:application/octet-stream;base64,') && back.numPrims === (await importGeometryAsync(await exportGeometryAsync(scene, 'glb'), 'glb')).numPrims, 'gltf: embedded buffer round trips');
  const tmp = fs.mkdtempSync(path.join(ROOT, 'test', '.tmp-interop-'));
  try {
    const j = JSON.parse(text);
    const b64 = j.buffers[0].uri.split(',')[1];
    fs.mkdirSync(path.join(tmp, 'sub'));
    fs.writeFileSync(path.join(tmp, 'sub', 'scene.bin'), Buffer.from(b64, 'base64'));
    j.buffers[0].uri = 'scene.bin';
    fs.writeFileSync(path.join(tmp, 'sub', 'scene.gltf'), JSON.stringify(j));
    const r = await engine.cook({ nodes: { f: { type: 'file', params: { path: path.join(tmp, 'sub', 'scene.gltf') } } } });
    check(r.ok && r.geo!.numPrims === back.numPrims, `file node: .gltf with an external .bin (${r.geo?.numPrims} prims)${r.ok ? '' : ' ' + r.errors.map((e) => e.message).join(';')}`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// lineMode 'lines' (viewer preview) still re-chains into one polyline
{
  const bytes = await exportGeometryAsync(scene, 'glb', { lineMode: 'lines', splitByName: false });
  await validate(bytes, 'glb lines');
  const back = await importGeometryAsync(bytes, 'glb');
  check(back.numPrims - back.primClosed.reduce((s, c) => s + c, 0) === srcCurves, 'glb lines: LINES re-chain into polylines');
}

// materials off: one default material, no material attribute on import
{
  const back = await importGeometryAsync(await exportGeometryAsync(scene, 'glb', { materials: false }), 'glb');
  check(!back.prims.has('material') && Object.keys(readMaterials(back)).length === 0, 'glb materials:false: default material only');
}

// EXT_mesh_gpu_instancing on import: packed prims by default (one source per mesh), expanded with instancing "expand"
{
  const { Document } = await import('@gltf-transform/core');
  const { EXTMeshGPUInstancing } = await import('@gltf-transform/extensions');
  const doc = new Document();
  const buf = doc.createBuffer();
  const pos = doc.createAccessor().setType('VEC3').setBuffer(buf).setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
  const prim = doc.createPrimitive().setAttribute('POSITION', pos);
  const mesh = doc.createMesh('tri').addPrimitive(prim);
  const ext = doc.createExtension(EXTMeshGPUInstancing).setRequired(true);
  const tr = doc.createAccessor().setType('VEC3').setBuffer(buf).setArray(new Float32Array([0, 0, 0, 5, 0, 0, 10, 0, 0]));
  const node = doc.createNode('inst').setMesh(mesh).setTranslation([0, 2, 0]).setExtension('EXT_mesh_gpu_instancing', ext.createInstancedMesh().setAttribute('TRANSLATION', tr));
  doc.createScene().addChild(node);
  const { HostIO } = await import('../src/io/gltf.ts');
  const bytes = await new HostIO().registerExtensions([EXTMeshGPUInstancing]).writeBinary(doc);
  const warns: string[] = [];
  const back = await importGeometryAsync(bytes, 'glb', { warn: (m) => warns.push(m), instancing: 'expand' });
  const bb = back.bbox();
  check(back.numPrims === 3 && close(bb.max[0], 11, 1e-6) && close(bb.min[1], 2, 1e-6) && warns.some((w) => /instancing/.test(w)), `EXT_mesh_gpu_instancing: 3 instances expanded with the node transform (${back.numPrims} prims, bbox x ${bb.min[0]}..${bb.max[0]})`);
  const packed = await importGeometryAsync(bytes, 'glb');
  const pb = packed.bbox();
  check(packed.numPacked === 3 && packed.packedSources.length === 1 && close(pb.max[0], 11, 1e-6) && close(pb.min[1], 2, 1e-6) && !checkGeo(packed).length, `EXT_mesh_gpu_instancing: 3 packed instances of one source by default (bbox x ${pb.min[0]}..${pb.max[0]})`);
}

// Draco is optional: without draco3dgltf, clear errors on export and import
{
  let hasDraco = true;
  try { const spec = 'draco3dgltf'; await import(spec); } catch { hasDraco = false; }
  if (!hasDraco) {
    let e1 = '', e2 = '';
    try { await exportGeometryAsync(scene, 'glb', { compress: 'draco' }); } catch (e: any) { e1 = e.message; }
    const j = JSON.parse(new TextDecoder().decode(await exportGeometryAsync(scene, 'gltf')));
    j.extensionsUsed = [...(j.extensionsUsed ?? []), 'KHR_draco_mesh_compression'];
    try { await importGeometryAsync(new TextEncoder().encode(JSON.stringify(j)), 'gltf'); } catch (e: any) { e2 = e.message; }
    check(/draco3dgltf/.test(e1) && /draco3dgltf/.test(e2), `Draco without draco3dgltf: clear errors (${e1.slice(0, 60)}…)`);
  } else console.log('SKIP Draco error checks: draco3dgltf is installed');
}

// existing GLB example in the repo still imports
for (const f of fs.readdirSync(path.join(ROOT, 'examples')).filter((x) => x.endsWith('.glb'))) {
  const back = await importGeometryAsync(new Uint8Array(fs.readFileSync(path.join(ROOT, 'examples', f))), 'glb');
  check(back.numPoints > 0 && checkGeo(back).length === 0, `examples/${f}: imports (${back.numPoints} pts)`);
}

// sync API: clear error for glTF
{
  let msg = '';
  try { exportGeometry(scene, 'glb' as ExportFormat); } catch (e: any) { msg = e.message; }
  check(/exportGeometryAsync/.test(msg), 'exportGeometry(glb) points to exportGeometryAsync');
}

// ---------------------------------------------------------------- Houdini .geo
function sameGeo(a: Geometry, b: Geometry, label: string, tol = 0) {
  const issues: string[] = [];
  if (a.numPoints !== b.numPoints || a.numVertices !== b.numVertices || a.numPrims !== b.numPrims) issues.push(`counts ${a.numPoints}/${a.numVertices}/${a.numPrims} vs ${b.numPoints}/${b.numVertices}/${b.numPrims}`);
  if (a.vertexPoint.join() !== b.vertexPoint.join()) issues.push('vertexPoint');
  if (a.primStart.join() !== b.primStart.join()) issues.push('primStart');
  if (a.primClosed.join() !== b.primClosed.join()) issues.push('primClosed');
  for (const cls of ['point', 'vertex', 'prim', 'detail'] as AttribClass[]) {
    const ta = a.table(cls), tb = b.table(cls);
    for (const [k, at] of ta.map) {
      const bt = tb.get(k);
      if (!bt) { issues.push(`${cls} ${k} missing`); continue; }
      if (bt.type !== at.type || bt.size !== at.size) { issues.push(`${cls} ${k} ${at.type}${at.size} → ${bt.type}${bt.size}`); continue; }
      const da = at.data as any, db = bt.data as any;
      for (let i = 0; i < da.length; i++) if (at.type === 'string' ? da[i] !== db[i] : !close(da[i], db[i], tol)) { issues.push(`${cls} ${k}[${i}] ${da[i]} → ${db[i]}`); break; }
    }
    for (const k of tb.map.keys()) if (!ta.has(k)) issues.push(`${cls} ${k} extra`);
  }
  for (const cls of ['point', 'prim'] as const) {
    const ga = a.groups(cls), gb = b.groups(cls);
    for (const [k, m] of ga) if (!gb.has(k) || gb.get(k)!.join() !== m.join()) issues.push(`${cls} group ${k}`);
    if (ga.size !== gb.size) issues.push(`${cls} group count ${ga.size} → ${gb.size}`);
  }
  check(issues.length === 0, `${label}${issues.length ? ': ' + issues.slice(0, 6).join('; ') : ''}`);
}

{
  const src = await cook({
    nodes: {
      b: { type: 'box', params: { divisions: [2, 2, 2] } },
      w: { type: 'wrangle', in: ['b'], params: { code: 'i@id = @ptnum;\nf@heat = @P.y * 2;\nv@vel = set(@P.x, 0, 1);\np@orient = quaternion(radians(30), [0, 1, 0]);\ns@label = @ptnum % 2 ? "odd" : "even";' } },
      wp: { type: 'wrangle', in: ['w'], params: { run_over: 'prims', code: 's@name = @primnum < 12 ? "lower" : "upper";\ni@side = @primnum % 6;' } },
      wv: { type: 'wrangle', in: ['wp'], params: { run_over: 'vertices', code: 'v@uv = set(@vtxnum * 0.01, 0.5, 0);' } },
      g1: { type: 'group', in: ['wv'], params: { name: 'top', class: 'prim', expr: '@P.y > 0.4' } },
      g2: { type: 'group', in: ['g1'], params: { name: 'right', class: 'point', expr: '@P.x > 0.4' } },
      m: { type: 'material', in: ['g2'], params: { name: 'stone', group: 'top' } },
      d: { type: 'attrib_create', in: ['m'], params: { name: 'author', class: 'detail', value: 'polyforge' } },
      crv: { type: 'curve', params: { points: [[0, 0, 0], [1, 1, 0], [2, 0, 0]] } },
      out: { type: 'merge', in: ['d', 'crv'] },
    },
    output: 'out',
  });
  for (const prec of [64, 32] as const) {
    const bytes = exportGeometry(src, 'geo', { precision: prec });
    const text = new TextDecoder().decode(bytes);
    const j = JSON.parse(text);
    check(Array.isArray(j) && j[0] === 'fileversion' && text.includes('"Polygon_run"') && text.includes('"PolygonCurve_run"'), `geo ${prec}: Houdini key/value layout with Polygon_run and PolygonCurve_run`);
    const back = importGeometry(bytes, 'geo');
    sameGeo(src, back, `geo fpreal${prec}: every attribute, group, string and polyline round trips`, prec === 64 ? 0 : 1e-6);
    const idx = j[j.indexOf('topology') + 1][1][1] as number[];
    const p0 = src.primPoints(0);
    check(idx.slice(0, 4).join() === [p0[0], p0[3], p0[2], p0[1]].join(), `geo ${prec}: polygons written clockwise for Houdini (${idx.slice(0, 4).join(',')} from ${p0.join(',')})`);
  }
  // json auto-detects Houdini geo
  const viaJson = importGeometry(exportGeometry(src, 'geo'), 'json');
  check(viaJson.numPrims === src.numPrims, 'json import auto-detects Houdini .geo');
}

// hand-written Houdini 20-style sample: box + one open curve, rawpagedata with constant pages, groups, strings
{
  const warns: string[] = [];
  const g = importGeometry(new Uint8Array(fs.readFileSync(path.join(ROOT, 'test', 'data', 'houdini_box.geo'))), 'geo', { warn: (m) => warns.push(m) });
  check(g.numPoints === 11 && g.numVertices === 29 && g.numPrims === 8, `houdini_box.geo: 11 points, 29 vertices, 8 prims (got ${g.numPoints}/${g.numVertices}/${g.numPrims})`);
  check(g.primSize(6) === 3 && g.primSize(7) === 2 && g.vertexPoint[26] === 10, 'houdini_box.geo: curve vertices (PolygonCurve_run with nvertices)');
  const v = g.points.get('v'), id = g.points.get('id');
  check(!!v && (v.get(4) as number[]).map((x) => +x.toFixed(4)).join() === '0,0.4,2', 'houdini_box.geo: packed [1,1,1] rawpagedata with constant subvector pages');
  check(id?.type === 'int' && id.get(10) === 110, 'houdini_box.geo: int32 point attribute');
  check(g.primClosed.join('') === '11111100', 'houdini_box.geo: 6 polygons + 2 open curves');
  const cd = g.vertices.get('Cd'), n = g.vertices.get('N');
  check(!!cd && (cd.get(5) as number[]).join() === '1,0.5,0', 'houdini_box.geo: constant-page vertex Cd');
  check(!!n && Math.abs((n.get(0) as number[])[1] + 1) < 1e-9, 'houdini_box.geo: vertex N');
  check(g.prims.get('material')?.get(0) === 'brick' && g.prims.get('shop_materialpath')?.get(0) === '/mat/brick', 'houdini_box.geo: shop_materialpath → material basename');
  check(g.prims.get('name')?.get(7) === 'curve', 'houdini_box.geo: prim string attribute');
  check(g.detail.get('frame')?.get(0) === 12, 'houdini_box.geo: detail attribute');
  check(g.pointGroups.get('top')?.join('') === '00110011000' && g.primGroups.get('caps')?.join('') === '10100000', 'houdini_box.geo: point and prim groups (i8 + boolRLE)');
  check(warns.some((w) => /Volume/.test(w)), `houdini_box.geo: volume prim skipped with a warning (${warns.join('; ')})`);
  check(g.vertexGroups.get('corner')?.length === g.numVertices && (g.edgeGroups.get('rim')?.size ?? 0) > 0, `houdini_box.geo: vertex group corner and edge group rim (${g.edgeGroups.get('rim')?.size ?? 0} edges)`);
  {
    const out = exportGeometry(g, 'geo', {});
    const again = importGeometry(typeof out === 'string' ? new TextEncoder().encode(out) : out, 'geo');
    check(again.vertexGroups.get('corner')?.join('') === g.vertexGroups.get('corner')?.join('') && again.edgeGroups.get('rim')?.toPairs().join() === g.edgeGroups.get('rim')?.toPairs().join(),
      'houdini_box.geo: vertex and edge groups survive a write/read round trip');
  }
  check(checkGeo(g).length === 0, 'houdini_box.geo: valid geometry');
  const boxOnly = g.subsetPrims(Uint8Array.from({ length: g.numPrims }, (_, p) => g.primClosed[p]));
  const fN = primNormals(boxOnly), vN = boxOnly.vertices.get('N')!;
  check(close(signedVolume(boxOnly), 1, 1e-9) && [...Array(6).keys()].every((p) => (vN.get(boxOnly.primStart[p]) as number[]).every((x, c) => close(x, fN[p * 3 + c], 1e-9))),
    'houdini_box.geo: clockwise Houdini polygons read outward-facing (volume +1, stored N = face normals)');
  // the same tree in Houdini's binary JSON encoding (.bgeo, uncompressed) reads identically
  const tree = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'data', 'houdini_box.geo'), 'utf8'));
  const gb = importGeometry(encodeBinaryJSON(tree), 'bgeo');
  sameGeo(g, gb, '.bgeo (binary JSON: token strings, uniform typed and bit arrays) matches the ASCII .geo');
}

/** Minimal Houdini binary JSON encoder (test only): token-defined strings, int32/float64 scalars, uniform arrays. */
function encodeBinaryJSON(v: any): Uint8Array {
  const out: number[] = [0x7f, 0x4e, 0x53, 0x4a, 0x62];
  const tokens = new Map<string, number>();
  const raw = (n: number, bytes: number, f: 'i' | 'f' | 'u') => {
    const dv = new DataView(new ArrayBuffer(bytes));
    if (f === 'f') dv.setFloat64(0, n, true); else if (bytes === 4) (f === 'i' ? dv.setInt32(0, n, true) : dv.setUint32(0, n, true)); else dv.setUint16(0, n, true);
    out.push(...new Uint8Array(dv.buffer));
  };
  const len = (n: number) => { if (n < 0xf1) out.push(n); else if (n < 65536) { out.push(0xf2); raw(n, 2, 'u'); } else { out.push(0xf4); raw(n, 4, 'u'); } };
  const str = (s: string) => {
    let id = tokens.get(s);
    if (id === undefined) { id = tokens.size; tokens.set(s, id); out.push(0x2b); len(id); const b = new TextEncoder().encode(s); len(b.length); out.push(...b); }
    out.push(0x26); len(id);
  };
  const num = (n: number) => { if (Number.isInteger(n) && Math.abs(n) < 2 ** 31) { out.push(0x13); raw(n, 4, 'i'); } else { out.push(0x1a); raw(n, 8, 'f'); } };
  const enc = (x: any) => {
    if (x === null) out.push(0x00);
    else if (typeof x === 'boolean') out.push(x ? 0x31 : 0x30);
    else if (typeof x === 'number') num(x);
    else if (typeof x === 'string') str(x);
    else if (Array.isArray(x) && x.length > 1 && x.every((e) => typeof e === 'boolean')) {
      out.push(0x40, 0x10); len(x.length);
      for (let i = 0; i < x.length; i += 32) { let w = 0; for (let k = 0; k < 32 && i + k < x.length; k++) if (x[i + k]) w |= 1 << k; raw(w >>> 0, 4, 'u'); }
    } else if (Array.isArray(x) && x.length > 1 && x.every((e) => typeof e === 'number')) {
      const ints = x.every((e) => Number.isInteger(e));
      out.push(0x40, ints ? 0x13 : 0x1a); len(x.length);
      for (const e of x) raw(e, ints ? 4 : 8, ints ? 'i' : 'f');
    } else if (Array.isArray(x)) { out.push(0x5b); x.forEach(enc); out.push(0x5d); }
    else { out.push(0x7b); for (const [k, e] of Object.entries(x)) { str(k); enc(e); } out.push(0x7d); }
  };
  enc(v);
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------- CSV and points JSON
{
  const pts = await cook({
    nodes: {
      g: { type: 'grid', params: { size: [4, 4], divisions: [3, 3] } },
      s: { type: 'scatter', in: ['g'], params: { count: 20, seed: 3 } },
      a: { type: 'wrangle', in: ['s'], params: { code: 'f@pscale = 0.5 + rand(@ptnum) * 0.5;\nv@up = [0, 1, 0];\nv@N = normalize(set(rand(@ptnum + 1) - 0.5, 0.2, rand(@ptnum + 2) - 0.5));\ni@seed = @ptnum * 7;\ns@name = "tree" + (@ptnum % 3);\nv@Cd = set(rand(@ptnum), 0.5, 0.25);\nf@density = 0.75;' } },
    },
    output: 'a',
  });
  const csv = new TextDecoder().decode(exportGeometry(pts, 'csv'));
  const header = csv.split('\n')[0];
  check(header.startsWith('P.x,P.y,P.z') && header.includes('pscale') && header.includes('N.x') && header.includes('name'), `csv header: ${header}`);
  const back = importGeometry(new TextEncoder().encode(csv), 'csv');
  const maxErr = Math.max(...Array.from(pts.P, (x, i) => Math.abs(x - back.P[i])));
  check(back.numPoints === pts.numPoints && maxErr < 1e-6, `csv round trip: ${back.numPoints} points, max P error ${maxErr.toExponential(1)}`);
  check(back.points.get('name')?.type === 'string' && back.points.get('name')!.get(4) === pts.points.get('name')!.get(4), 'csv: string column → string attribute');
  check(back.points.get('seed')?.type === 'int' && back.points.get('N')?.size === 3, 'csv: seed int, N vector');
  const sub = new TextDecoder().decode(exportGeometry(pts, 'csv', { attributes: ['P', 'pscale'] }));
  check(sub.split('\n')[0] === 'P.x,P.y,P.z,pscale', 'csv attributes option selects columns');

  // Unreal PCG columns, then back
  const pcg = new TextDecoder().decode(exportGeometry(pts, 'csv', { pcg: true }));
  const ph = pcg.split('\n')[0].split(',');
  check(ph.slice(0, 16).join(',') === 'Name,Position.X,Position.Y,Position.Z,Rotation.Roll,Rotation.Pitch,Rotation.Yaw,Scale.X,Scale.Y,Scale.Z,Density,Color.R,Color.G,Color.B,Color.A,Seed', `pcg csv header: ${ph.slice(0, 16).join(',')}`);
  const row = pcg.split('\n')[1].split(',');
  check(close(+row[1], pts.P[0] * 100, 1e-3) && close(+row[2], pts.P[2] * 100, 1e-3) && close(+row[3], pts.P[1] * 100, 1e-3), 'pcg csv: Unreal space X=x, Y=z, Z=y in cm');
  const pb = importGeometry(new TextEncoder().encode(pcg), 'csv');
  const perr = Math.max(...Array.from(pts.P, (x, i) => Math.abs(x - pb.P[i])));
  check(pb.numPoints === pts.numPoints && perr < 1e-5, `pcg csv re-import: positions back in metres Y-up (max error ${perr.toExponential(1)})`);
  // the rotation survives: instance +Z axis (N) and +Y axis (up) match after the round trip
  const { m4fromQuat, lookAtBasis } = await import('../src/core/math.ts');
  let rotErr = 0;
  for (let i = 0; i < pts.numPoints; i++) {
    const R0 = lookAtBasis(pts.points.get('N')!.get(i) as any, [0, 1, 0]);
    const R1 = m4fromQuat(pb.points.get('orient')!.get(i) as any);
    for (const k of [0, 1, 2, 4, 5, 6, 8, 9, 10]) rotErr = Math.max(rotErr, Math.abs(R0[k] - R1[k]));
  }
  check(rotErr < 1e-6, `pcg csv: Rotation (roll/pitch/yaw) round trips to the same orientation (max error ${rotErr.toExponential(1)})`);
  check(close(pb.points.get('scale')!.get(3) as any as number[] ? (pb.points.get('scale')!.get(3) as number[])[0] : 0, pts.points.get('pscale')!.get(3) as number, 1e-6), 'pcg csv: Scale from pscale');
  check(pb.points.get('seed')!.get(5) === 35 && close(pb.points.get('density')!.get(0) as number, 0.75, 1e-9), 'pcg csv: Seed and Density');

  // struct-text cells for Unreal DataTable import ("(X=…,Y=…,Z=…)"), then back
  const pcgS = new TextDecoder().decode(exportGeometry(pts, 'csv', { pcg: true, pcgStruct: true }));
  const sl = pcgS.split('\n');
  check(sl[0].startsWith('Name,Position,Rotation,Scale,Density,Color,Seed') && /^0,"\(X=[-\d.]+,Y=[-\d.]+,Z=[-\d.]+\)","\(Pitch=[-\d.]+,Yaw=[-\d.]+,Roll=[-\d.]+\)"/.test(sl[1]), `pcg struct csv: ${sl[1].slice(0, 90)}`);
  const sb = importGeometry(new TextEncoder().encode(pcgS), 'csv');
  let serr = Math.max(...Array.from(pts.P, (x, i) => Math.abs(x - sb.P[i])));
  for (let i = 0; i < pts.numPoints; i++) {
    const R0 = lookAtBasis(pts.points.get('N')!.get(i) as any, [0, 1, 0]), R1 = m4fromQuat(sb.points.get('orient')!.get(i) as any);
    for (const k of [0, 1, 2, 4, 5, 6, 8, 9, 10]) serr = Math.max(serr, Math.abs(R0[k] - R1[k]));
  }
  check(serr < 1e-5 && close((sb.points.get('Cd')!.get(2) as number[])[0], (pts.points.get('Cd')!.get(2) as number[])[0], 1e-6), `pcg struct csv re-import: position, rotation, colour (max error ${serr.toExponential(1)})`);

  // points JSON
  const pj = exportGeometry(pts, 'pointsjson');
  const pjb = importGeometry(pj, 'pointsjson');
  sameGeo(pts, pjb, 'points.json: every point attribute round trips');
  check(importGeometry(pj, 'json').numPoints === pts.numPoints, 'json import auto-detects points streams');
}

// ---------------------------------------------------------------- file node: auto formats
{
  const tmp = fs.mkdtempSync(path.join(ROOT, 'test', '.tmp-interop-'));
  try {
    const g = await cook({ nodes: { s: { type: 'sphere', params: { type: 'ico', level: 1 } }, m: { type: 'material', in: ['s'], params: { name: 'ball', base_color: 'red' } } }, output: 'm' });
    const files: [string, ExportFormat][] = [['a.glb', 'glb'], ['a.geo', 'geo'], ['a.csv', 'csv'], ['a.points.json', 'pointsjson']];
    for (const [f, fmt] of files) {
      fs.writeFileSync(path.join(tmp, f), await exportGeometryAsync(g, fmt));
      const r = await engine.cook({ nodes: { f: { type: 'file', params: { path: path.join(tmp, f) } } } });
      const want = fmt === 'csv' || fmt === 'pointsjson' ? g.numPoints : fmt === 'glb' ? g.numPrims : g.numPrims;
      const got = fmt === 'csv' || fmt === 'pointsjson' ? r.geo?.numPoints : r.geo?.numPrims;
      check(r.ok && got === want, `file node reads ${f} (${got}/${want})${r.ok ? '' : ' ' + r.errors.map((e) => e.message).join(';')}`);
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// ================================================================ part 2: instances, textures, landscape bundle
// packed scene: three named variants with materials, instances rotated/scaled per point, a mirrored subset, anchor
// attributes of every kind (int id, float tint, string variant, colour, velocity), plus an ordinary mesh
const instGraph = {
  nodes: {
    a: { type: 'box', params: { size: [0.6, 1, 0.6], center: [0, 0.5, 0] } },
    am: { type: 'material', in: ['a'], params: { name: 'crate', base_color: '#a0703c', roughness: 0.7 } },
    an: { type: 'attrib_create', in: ['am'], params: { name: 'name', class: 'prim', value: 'crate' } },
    b: { type: 'sphere', params: { type: 'ico', level: 1, radius: 0.5, center: [0, 0.5, 0] } },
    bm: { type: 'material', in: ['b'], params: { name: 'stone', base_color: [0.4, 0.4, 0.42] } },
    bn: { type: 'attrib_create', in: ['bm'], params: { name: 'name', class: 'prim', value: 'boulder' } },
    c: { type: 'tube', params: { radius: 0.2, height: 2, center: [0, 1, 0], cols: 6 } },
    cn: { type: 'attrib_create', in: ['c'], params: { name: 'name', class: 'prim', value: 'post' } },
    srcs: { type: 'merge', in: ['an', 'bn', 'cn'] },
    pts: { type: 'point_grid', params: { counts: [6, 1, 5], size: [20, 0, 16] } },
    pv: { type: 'attrib_randomize', in: ['pts'], params: { name: 'variant', distribution: 'choice', values: ['crate', 'boulder', 'post'], seed: 3 } },
    po: { type: 'attrib_randomize', in: ['pv'], params: { name: 'orient', distribution: 'orient', seed: 4 } },
    pw: { type: 'wrangle', in: ['po'], params: { code: '@pscale = 0.5 + rand(@ptnum) * 1.5;\nv@scale = set(1, 1 + rand(@ptnum + 1), 1);\ni@id = 1000 + @ptnum * 7;\nf@tint = rand(@ptnum + 2);\nv@Cd = set(rand(@ptnum + 3), 0.25, 0.75);\n@P.y += rand(@ptnum + 4) * 2;' } },
    inst: { type: 'copy_to_points', in: ['srcs', 'pw'], params: { pack: true, variants: 'name', variant_attrib: 'variant' } },
    mir: { type: 'transform', in: ['inst'], params: { group: '@P.x>5', scale: [-1, 1, 1] } },
    rot0: { type: 'transform', in: ['mir'], params: { rotate: [0, 30, 0] } },
    // anchors are points: a wrangle adds a string label and a velocity per instance (copy_to_points consumes variant and v)
    rot: { type: 'wrangle', in: ['rot0'], params: { code: 's@variant = @ptnum % 3 == 0 ? "tall" : "short";\nv@v = set(@ptnum * 0.1, 0, -1);' } },
    ground: { type: 'grid', params: { size: [24, 20] } },
    scene: { type: 'merge', in: ['ground', 'rot'] },
  },
  output: 'scene',
};
const iscene = await cook(instGraph);
const iinst = await cook({ ...instGraph, output: 'rot' });
check(iinst.numPacked === 30 && iinst.packedSources.length === 3 && iscene.numPacked === 30, `instance scene: ${iinst.numPacked} instances of ${iinst.packedSources.length} sources`);
const { instancePoints, rotatorToHoudini } = await import('../src/io/points.ts');
const { packedSourceNames, packedPrims } = await import('../src/io/common.ts');
const { m4fromQuat } = await import('../src/core/math.ts');
const srcNames = packedSourceNames(iinst);
check(srcNames.slice().sort().join() === 'boulder,crate,post', `source names from the prim "name" (${srcNames.join(', ')})`);
const maxAbs = (a: ArrayLike<number>, b: ArrayLike<number>) => { let d = 0; for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i])); return d; };
const mirrored = packedPrims(iinst).filter((p) => { const X = iinst.packedXform!, o = p * 9; return X[o] * (X[o + 4] * X[o + 8] - X[o + 5] * X[o + 7]) - X[o + 3] * (X[o + 1] * X[o + 8] - X[o + 2] * X[o + 7]) + X[o + 6] * (X[o + 1] * X[o + 5] - X[o + 2] * X[o + 4]) < 0; }).length;
check(mirrored > 0 && mirrored < 30, `test scene has mirrored instances (${mirrored})`);

// ---------------------------------------------------------------- instance stream: rows, decomposition, Unreal transforms
{
  const st = instancePoints(iinst);
  let d = 0;
  st.prims.forEach((p, i) => {
    const R = m4fromQuat(st.pts.points.get('orient')!.get(i) as any), s = st.pts.points.get('scale')!.get(i) as number[];
    const M = new Float64Array(16);
    for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) M[c * 4 + r] = R[c * 4 + r] * s[c];
    M[12] = st.pts.P[i * 3]; M[13] = st.pts.P[i * 3 + 1]; M[14] = st.pts.P[i * 3 + 2]; M[15] = 1;
    d = Math.max(d, maxAbs(M, iinst.packedFullTransform(p)));
  });
  check(st.pts.numPoints === iinst.numPacked && d < 1e-9, `instance stream: one row per instance, T·R(orient)·S(scale) rebuilds the full transform (max diff ${d.toExponential(1)})`);
  const pn = st.pts.points.names();
  check(['id', 'tint', 'variant', 'Cd', 'v', 'Mesh'].every((n) => pn.includes(n)) && !pn.includes('pscale') && !pn.includes('N'), `instance stream attributes: ${pn.join(' ')} (transform inputs folded)`);

  const warns: string[] = [];
  const csv = new TextDecoder().decode(exportGeometry(iscene, 'csv', { pcg: true, warn: (m) => warns.push(m) }));
  const rows = parseCSVText(csv);
  const h = rows[0];
  check(rows.length - 1 === iscene.numPacked, `pcg csv: ${rows.length - 1} rows = ${iscene.numPacked} instances`);
  check(h.slice(0, 17).join(',') === 'Name,Position.X,Position.Y,Position.Z,Rotation.Roll,Rotation.Pitch,Rotation.Yaw,Scale.X,Scale.Y,Scale.Z,Density,Color.R,Color.G,Color.B,Color.A,Seed,Mesh' && h.includes('id') && h.includes('tint') && h.includes('variant'),
    `pcg csv instance header: ${h.join(',').slice(0, 140)}`);
  check(warns.some((w) => /other point/.test(w)), 'pcg csv: the non-instanced ground points are reported as not written');
  // Unreal → Houdini: R from the rotator, scale back through the axis swap, position /100 with Y/Z swapped
  const col = (n: string) => h.indexOf(n);
  const prims = packedPrims(iscene);
  let ud = 0, meshOk = true;
  rows.slice(1).forEach((r, i) => {
    const R = rotatorToHoudini(+r[col('Rotation.Pitch')], +r[col('Rotation.Yaw')], +r[col('Rotation.Roll')]);
    const s = [+r[col('Scale.X')], +r[col('Scale.Z')], +r[col('Scale.Y')]];
    const M = new Float64Array(16);
    for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) M[c * 4 + k] = R[c * 4 + k] * s[c];
    M[12] = +r[col('Position.X')] / 100; M[13] = +r[col('Position.Z')] / 100; M[14] = +r[col('Position.Y')] / 100; M[15] = 1;
    ud = Math.max(ud, maxAbs(M, iscene.packedFullTransform(prims[i])));
    if (r[col('Mesh')] !== srcNames[iscene.packedSource![prims[i]]]) meshOk = false;
  });
  check(ud < 1e-6, `pcg csv: Position/Rotation/Scale rebuild every instance 4×4 within 1e-6, mirrored ones included (max diff ${ud.toExponential(1)})`);
  check(meshOk, 'pcg csv: Mesh names the packed source of each row');
  // struct cells (DataTable) carry the same instance rows
  const cs = new TextDecoder().decode(exportGeometry(iscene, 'csv', { pcg: true, pcgStruct: true }));
  check(parseCSVText(cs).length - 1 === 30 && parseCSVText(cs)[0].slice(0, 8).join(',') === 'Name,Position,Rotation,Scale,Density,Color,Seed,Mesh', 'pcg struct csv: one row per instance with Mesh');

  // points JSON stream re-instanced by copy_to_points reproduces the instances
  const pj = exportGeometry(iscene, 'pointsjson');
  const pjj = JSON.parse(new TextDecoder().decode(pj));
  check(pjj.count === 30 && pjj.kind === 'instances' && pjj.meshes.join() === srcNames.join() && pjj.attributes.Mesh?.type === 'string', `points.json instance stream: count ${pjj.count}, kind ${pjj.kind}, meshes ${pjj.meshes.join(',')}`);
  const tmp = fs.mkdtempSync(path.join(ROOT, 'test', '.tmp-interop-'));
  try {
    fs.writeFileSync(path.join(tmp, 'inst.points.json'), pj);
    const reGraph = { ...instGraph, nodes: { ...instGraph.nodes, f: { type: 'file', params: { path: path.join(tmp, 'inst.points.json') } }, re: { type: 'copy_to_points', in: ['srcs', 'f'], params: { pack: true, variants: 'name', variant_attrib: 'Mesh' } } }, output: 're' };
    const re = await cook(reGraph);
    let rd = 0;
    const rp = packedPrims(re), op = packedPrims(iinst);
    rp.forEach((p, i) => { rd = Math.max(rd, maxAbs(re.packedFullTransform(p), iinst.packedFullTransform(op[i]))); });
    const srcOk = rp.every((p, i) => packedSourceNames(re)[re.packedSource![p]] === srcNames[iinst.packedSource![op[i]]]);
    check(rp.length === 30 && rd < 1e-9 && srcOk, `points.json → copy_to_points {variant_attrib: "Mesh"} rebuilds the same instances (max diff ${rd.toExponential(1)})`);

    // the multi-file export: stream + meshes sidecar + one GLB per source
    const { exportFilesAsync } = await import('../src/io/files.ts');
    const res = await exportFilesAsync(iscene, 'csv', path.join(tmp, 'props.csv'), { pcg: true, warn: () => {} });
    const rel = res.files.map((f) => path.relative(tmp, f.path).split(path.sep).join('/'));
    check(rel.join() === ['props.csv', 'props.meshes.json', ...srcNames.map((n) => `props_meshes/${n}.glb`)].join(), `csv instance export files: ${rel.join(', ')}`);
    const side = JSON.parse(new TextDecoder().decode(res.files[1].bytes));
    const counts: Record<string, number> = {};
    for (const p of packedPrims(iscene)) { const n = srcNames[iscene.packedSource![p]]; counts[n] = (counts[n] ?? 0) + 1; }
    check(side.format === 'polyforge-instance-meshes' && side.meshes.every((m: any, i: number) => m.name === srcNames[i] && m.file === `props_meshes/${m.name}.glb` && m.instances === counts[m.name]) && side.meshes.find((m: any) => m.name === 'crate').materials.join() === 'crate',
      'meshes sidecar: names, files, instance counts and materials per source');
    for (const f of res.files.filter((x) => x.path.endsWith('.glb'))) await validate(f.bytes, `source mesh ${path.basename(f.path)}`);
    const crate = await importGeometryAsync(res.files.find((f) => f.path.endsWith('crate.glb'))!.bytes, 'glb');
    check(crate.numPrims === 12 && !crate.hasPacked() && readMaterials(crate).crate !== undefined, `source GLB holds the source mesh at the origin (${crate.numPrims} triangles, material crate)`);
    const noMesh = await exportFilesAsync(iscene, 'pointsjson', path.join(tmp, 'p.points.json'), { meshes: false });
    check(noMesh.files.length === 2 && noMesh.files[1].path.endsWith('p.meshes.json'), 'points.json instance export with meshes:false: stream + sidecar only');
    const exp = await exportFilesAsync(iscene, 'csv', path.join(tmp, 'all.csv'), { instances: 'expand', warn: () => {} });
    check(exp.files.length === 1 && parseCSVText(new TextDecoder().decode(exp.files[0].bytes)).length - 1 > 30 * 8, 'instances:"expand": one row per point of the expanded geometry, no sidecar');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------- per-instance attributes: glTF and USD
{
  const byId = (g: Geometry) => {
    const m = new Map<number, { cd: number[]; tint: number; variant: string; v: number[] }>();
    for (const p of packedPrims(g)) {
      const a = g.vertexPoint[g.primStart[p]];
      const get = (n: string) => { const at = g.points.get(n) ?? g.prims.get(n); return at ? at.get(g.points.has(n) ? a : p) : undefined; };
      m.set(get('id') as number, { cd: get('Cd') as number[], tint: get('tint') as number, variant: get('variant') as string, v: get('v') as number[] });
    }
    return m;
  };
  const want = byId(iscene);
  for (const opts of [{}, { quantize: true }, { compress: 'meshopt' as const }]) {
    const label = JSON.stringify(opts);
    const glb = await exportGeometryAsync(iscene, 'glb', opts);
    await validate(glb, `glb instance attributes ${label}`);
    const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + new DataView(glb.buffer, glb.byteOffset).getUint32(12, true))));
    const sems = Object.keys(json.nodes.find((n: any) => n.extensions?.EXT_mesh_gpu_instancing)?.extensions.EXT_mesh_gpu_instancing.attributes ?? {});
    check(['_COLOR', '_ID', '_TINT', '_VARIANT', '_V'].every((s) => sems.includes(s)) && !sems.includes('_ORIENT') && !sems.includes('_N'), `glb ${label}: instance accessors ${sems.join(' ')}`);
    const back = await importGeometryAsync(glb, 'glb');
    const got = byId(back);
    let ok = got.size === want.size, worst = 0;
    for (const [id, w] of want) {
      const b = got.get(id);
      if (!b || b.variant !== w.variant) { ok = false; continue; }
      worst = Math.max(worst, maxAbs(b.cd, w.cd), Math.abs(b.tint - w.tint), maxAbs(b.v, w.v));
    }
    check(ok && worst < 1e-6 && back.points.get('id')?.type === 'int' && back.points.get('variant')?.type === 'string', `glb ${label}: Cd, id, tint, variant (string), v survive per instance (max diff ${worst.toExponential(1)})`);
    const names = back.prims.get('name');
    check(!!names && new Set(back.packedSources.map((s) => (s.prims.get('name')?.get(0) as string))).size === 3 && packedSourceNames(back).slice().sort().join() === 'boulder,crate,post', 'glb: instanced meshes keep the source names');
  }
  const noCustom = await importGeometryAsync(await exportGeometryAsync(iscene, 'glb', { custom: false }), 'glb');
  check(!noCustom.points.has('tint') && noCustom.numPacked === 30, 'glb custom:false: no instance attributes');

  const usd = new TextDecoder().decode(exportGeometry(iscene, 'usda'));
  const inst = usd.slice(usd.indexOf('def PointInstancer'), usd.indexOf('def Scope "prototypes"'));
  const arrayLen = (re: RegExp) => { const m = re.exec(inst); return m ? m[1].split(/,\s*(?![^()]*\))/).filter((x) => x.trim()).length : -1; };
  check(arrayLen(/color3f\[\] primvars:displayColor = \[([^\]]*)\] \(\s*interpolation = "vertex"/) === 30, 'usda: primvars:displayColor per instance (interpolation vertex)');
  check(arrayLen(/int64\[\] ids = \[([^\]]*)\]/) === 30 && /int64\[\] ids = \[1000, /.test(inst), 'usda: ids from the id attribute');
  check(arrayLen(/vector3f\[\] velocities = \[([^\]]*)\]/) === 30, 'usda: velocities from v');
  check(arrayLen(/float\[\] primvars:tint = \[([^\]]*)\]/) === 30 && arrayLen(/string\[\] primvars:variant = \[([^\]]*)\]/) === 30, 'usda: other anchor attributes as primvars (float tint, string variant)');
  const primvars = [...inst.matchAll(/\S+\[\] primvars:(\w+)/g)].map((m) => m[1]);
  check(!primvars.includes('orient') && !primvars.includes('N'), `usda instancer primvars: ${primvars.join(' ')}`);
  check(/def Material "crate"/.test(usd) && /uniform token info:id = "UsdPreviewSurface"/.test(usd) && /rel material:binding = <\/root\/materials\/crate>/.test(usd), 'usda: UsdPreviewSurface materials bound to the prototype meshes');
  const usdNo = new TextDecoder().decode(exportGeometry(iscene, 'usda', { custom: false, materials: false }));
  check(!/primvars:tint/.test(usdNo) && /int64\[\] ids/.test(usdNo) && !/def Material/.test(usdNo), 'usda custom:false: ids/velocities/displayColor only; materials:false: no materials');
}

// ---------------------------------------------------------------- Houdini .geo: PackedGeometry with shared embedded geometry
{
  for (const prec of [64, 32] as const) {
    const text = new TextDecoder().decode(exportGeometry(iscene, 'geo', { precision: prec }));
    const j = JSON.parse(text);
    const prims = j[j.indexOf('primitives') + 1] as any[];
    const packed = prims.filter((p) => p[0][1] === 'PackedGeometry');
    const shared = j[j.indexOf('sharedprimitivedata') + 1] as any[];
    check(packed.length === 30 && shared.length === 6 && shared[0] === 'PackedGeometry' && shared[1][0] === 'geo:embedded', `geo ${prec}: 30 PackedGeometry prims, 3 embedded sources stored once in sharedprimitivedata`);
    const back = importGeometry(new TextEncoder().encode(text), 'geo');
    let d = 0;
    const a = packedPrims(iscene), b = packedPrims(back);
    a.forEach((p, i) => { d = Math.max(d, maxAbs(back.packedFullTransform(b[i]), iscene.packedFullTransform(p))); });
    const srcSame = a.every((p, i) => back.packedSources[back.packedSource![b[i]]].numPrims === iscene.packedSources[iscene.packedSource![p]].numPrims);
    check(back.numPacked === 30 && back.packedSources.length === 3 && d < (prec === 64 ? 1e-12 : 1e-5) && srcSame && checkGeo(back).length === 0,
      `geo ${prec}: re-import keeps 30 instances of 3 sources, transforms within ${prec === 64 ? '1e-12' : '1e-5'} (max diff ${d.toExponential(1)})`);
    check(back.points.get('tint') !== undefined && back.points.get('variant')?.get(b[0] === undefined ? 0 : back.vertexPoint[back.primStart[b[0]]]) === iscene.points.get('variant')?.get(iscene.vertexPoint[iscene.primStart[a[0]]]), `geo ${prec}: anchor attributes ride along`);
    if (prec === 64) {
      const gb = importGeometry(encodeBinaryJSON(j), 'bgeo');
      check(gb.numPacked === 30 && gb.packedSources.length === 3, '.bgeo (binary JSON) with PackedGeometry reads the same instances');
      // tolerant reader: nested 3×3 rows, the shared key under another parameter name, a pivot
      const alt = JSON.parse(text);
      const ap = alt[alt.indexOf('primitives') + 1] as any[];
      const first = ap.find((p) => p[0][1] === 'PackedGeometry');
      const body = first[1];
      const t = body[body.indexOf('transform') + 1] as number[];
      body[body.indexOf('transform') + 1] = [t.slice(0, 3), t.slice(3, 6), t.slice(6, 9)];
      const params = body[body.indexOf('parameters') + 1];
      params.sharedkey = params.embedded; delete params.embedded;
      body[body.indexOf('pivot') + 1] = [0.5, 0, 0];
      const ga = importGeometry(new TextEncoder().encode(JSON.stringify(alt)), 'geo');
      const pa = packedPrims(ga)[0];
      const srcA = ga.packedSources[ga.packedSource![pa]], src0 = iscene.packedSources[iscene.packedSource![a[0]]];
      check(ga.numPacked === 30 && maxAbs(ga.packedFullTransform(pa), iscene.packedFullTransform(a[0])) < 1e-12 && Math.abs(srcA.bbox().min[0] - (src0.bbox().min[0] - 0.5)) < 1e-9,
        'geo reader: nested 3×3, another key parameter and a pivot (source moved by -pivot) are understood');
    }
  }
  const ex = new TextDecoder().decode(exportGeometry(iscene, 'geo', { instancing: 'expand' }));
  check(!/PackedGeometry/.test(ex) && !/sharedprimitivedata/.test(ex), 'geo instancing:"expand": real geometry, no packed prims');
}

// ---------------------------------------------------------------- material textures
{
  const tmp = fs.mkdtempSync(path.join(ROOT, 'test', '.tmp-interop-'));
  try {
    const zlib = await import('node:zlib');
    const { encodePNG } = await import('../src/render/png.ts');
    const png = (r: number, g: number, b: number) => { const px = new Uint8Array(8 * 8 * 4); for (let i = 0; i < 64; i++) px.set([r, g, b, 255], i * 4); return encodePNG(px, 8, 8, (d) => zlib.deflateSync(d)); };
    fs.mkdirSync(path.join(tmp, 'tex'));
    fs.writeFileSync(path.join(tmp, 'tex', 'brick.png'), png(170, 80, 50));
    fs.writeFileSync(path.join(tmp, 'tex', 'brick_n.png'), png(128, 128, 255));
    fs.writeFileSync(path.join(tmp, 'tex', 'brick_r.png'), png(200, 200, 200));
    const host = createNodeHost({ baseDir: tmp });
    const teng = new Engine(host);
    await teng.init();
    const tr = await teng.cook({
      nodes: {
        b: { type: 'box' },
        u: { type: 'uv_project', in: ['b'], params: { method: 'box' } },
        m: { type: 'material', in: ['u'], params: { name: 'brick', base_color_map: 'tex/brick.png', normal_map: 'tex/brick_n.png', roughness_map: 'tex/brick_r.png', roughness: 0.4 } },
        n: { type: 'material', in: ['m'], params: { name: 'plain', group: '0', base_color: 'red' } },
      },
      output: 'n',
    });
    check(tr.ok, `textured material graph cooks${tr.ok ? '' : ': ' + tr.errors.map((e) => e.message).join('; ')}`);
    const tg = tr.geo!;
    check(JSON.stringify(readMaterials(tg).brick.textures) === JSON.stringify({ baseColor: 'tex/brick.png', normal: 'tex/brick_n.png', roughness: 'tex/brick_r.png' }) && readMaterials(tg).plain.textures === undefined,
      'material node: texture paths in the table (absent when unset)');
    const readFile = (p: string) => host.readFile(p);
    const tw: string[] = [];
    const glb = await exportGeometryAsync(tg, 'glb', { readFile, warn: (m) => tw.push(m) });
    await validate(glb, 'glb with embedded textures');
    const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + new DataView(glb.buffer, glb.byteOffset).getUint32(12, true))));
    const bm = json.materials.find((m: any) => m.name === 'brick');
    check(json.images?.length === 3 && json.textures?.length === 3 && json.images.every((im: any) => im.mimeType === 'image/png' && im.bufferView !== undefined) && !tw.length,
      `glb: 3 images embedded (${json.images?.map((i: any) => i.mimeType).join(', ')})`);
    const pbr = bm.pbrMetallicRoughness; // glTF leaves out factors at their default (1)
    check(pbr.baseColorTexture && bm.normalTexture && pbr.metallicRoughnessTexture && (pbr.roughnessFactor ?? 1) === 1 && (pbr.baseColorFactor ?? [1, 1, 1, 1]).slice(0, 3).join() === '1,1,1',
      'glb: base colour / normal / metallicRoughness textures wired, factors neutral under the maps');
    const back = await importGeometryAsync(glb, 'glb');
    check(JSON.stringify(readMaterials(back).brick.textures) === JSON.stringify(readMaterials(tg).brick.textures), 'glb import: texture paths back in the material table');
    const gltf = new TextDecoder().decode(await exportGeometryAsync(tg, 'gltf', { readFile }));
    check((gltf.match(/"uri":"data:image\/png;base64,/g) ?? []).length === 3, '.gltf: images embedded as data URIs');
    // a .gltf written elsewhere with an external image: the importer records the resolved path, no decoding
    const gj = JSON.parse(gltf);
    for (const m of gj.materials) delete m.extras;
    gj.images[0].uri = 'maps/base.png';
    fs.mkdirSync(path.join(tmp, 'ext'));
    fs.writeFileSync(path.join(tmp, 'ext', 'scene.gltf'), JSON.stringify(gj));
    const fe = await teng.cook({ nodes: { f: { type: 'file', params: { path: path.join(tmp, 'ext', 'scene.gltf') } } } });
    const tex = fe.ok ? Object.values(readMaterials(fe.geo!)).map((m) => m.textures).filter(Boolean) : [];
    const paths = tex.flatMap((t) => Object.values(t!));
    check(fe.ok && paths.some((p) => p.replace(/\\/g, '/').endsWith('ext/maps/base.png')) && paths.some((p) => p.startsWith('embedded:')), `gltf import without extras: texture paths ${paths.join(', ')}`);
    // missing file and no file access: warned, exported without the map, still valid
    const mw: string[] = [];
    const bad = await exportGeometryAsync(tg, 'glb', { readFile: async (p) => { if (p.includes('_n')) throw new Error('nope'); return host.readFile(p); }, warn: (m) => mw.push(m) });
    await validate(bad, 'glb with a missing texture');
    const nw: string[] = [];
    await exportGeometryAsync(tg, 'glb', { warn: (m) => nw.push(m) });
    check(mw.some((m) => /brick_n\.png.*could not be read/.test(m)) && nw.some((m) => /no file access/.test(m)), 'textures: unreadable maps and missing file access are warned');
    const noUv = await teng.cook({ nodes: { b: { type: 'box' }, d: { type: 'attrib_delete', in: ['b'], params: { name: 'uv', class: 'vertex' } }, m: { type: 'material', in: ['d'], params: { name: 't', base_color_map: 'tex/brick.png' } } }, output: 'm' });
    check(noUv.ok && !noUv.geo!.vertices.has('uv') && !noUv.geo!.points.has('uv'), `mesh without uv for the warning check${noUv.ok ? '' : ': ' + noUv.errors.map((e) => e.message).join('; ')}`);
    const uw: string[] = [];
    await exportGeometryAsync(noUv.geo!, 'glb', { readFile, warn: (m) => uw.push(m) });
    check(uw.some((m) => /no uv attribute/.test(m)), 'textures on a mesh without uv are warned');
    // USD: UsdUVTexture network with relative asset paths; geo keeps the paths in the table
    const usd = new TextDecoder().decode(exportGeometry(tg, 'usda', { texturePath: (p) => '../' + p }));
    check(/uniform token info:id = "UsdUVTexture"/.test(usd) && /asset inputs:file = @\.\.\/tex\/brick\.png@/.test(usd) && /color3f inputs:diffuseColor\.connect = <\/root\/materials\/brick\/base_color_map\.outputs:rgb>/.test(usd)
      && /normal3f inputs:normal\.connect/.test(usd) && /float inputs:roughness\.connect = <\/root\/materials\/brick\/roughness_map\.outputs:r>/.test(usd) && /UsdPrimvarReader_float2/.test(usd), 'usda: UsdUVTexture shaders (base colour sRGB, normal, roughness) with relative asset paths');
    check(/def GeomSubset "mat_brick"/.test(usd) && /def GeomSubset "mat_plain"/.test(usd) && /familyName = "materialBind"/.test(usd), 'usda: a mesh mixing materials binds them through GeomSubsets');
    const geo = importGeometry(exportGeometry(tg, 'geo'), 'geo');
    check(JSON.stringify(readMaterials(geo).brick.textures) === JSON.stringify(readMaterials(tg).brick.textures), 'geo: texture paths travel in the detail material table');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------- Unreal Landscape bundle
{
  const { unrealComponents } = await import('../src/io/unreal.ts');
  const lay = (n: number) => { const c = unrealComponents(n, n); return `${c.sectionSize}/${c.sectionsPerComponent}/${c.components[0]}${c.exact ? '' : '!'}`; };
  const table = [127, 253, 505, 1009, 2017, 4033, 8129].map(lay).join(' ');
  check(table === '63/2/1 63/2/2 63/2/4 63/2/8 63/2/16 63/2/32 127/2/32', `Unreal component layouts for the recommended sizes: ${table}`);
  check(!unrealComponents(201, 201).exact && unrealComponents(201, 201).resolution[0] >= 201, 'a size that does not fit is flagged, with the padded resolution');
  const lg = await cook({
    nodes: {
      hf: { type: 'heightfield', params: { size: [63, 63], samples: [127, 127] } },
      n: { type: 'heightfield_noise', in: ['hf'], params: { amplitude: 6, element_size: 20, seed: 2 } },
      e: { type: 'heightfield_erode', in: ['n'], params: { iterations: 5 } },
      m: { type: 'heightfield_mask_by_feature', in: ['e'], params: { feature: 'slope', min_angle: 20, layer: 'rock' } },
      pts: { type: 'heightfield_scatter', in: ['m'], params: { count: 40, mask_layer: '' } },
      id: { type: 'wrangle', in: ['pts'], params: { code: 'i@id = @ptnum;' } },
      s: { type: 'sphere', params: { type: 'ico', level: 1, radius: 0.5 } },
      sn: { type: 'attrib_create', in: ['s'], params: { name: 'name', class: 'prim', value: 'bush' } },
      inst: { type: 'copy_to_points', in: ['sn', 'id'], params: { pack: true } },
      out: { type: 'merge', in: ['m', 'inst'] },
    },
    output: 'out',
  });
  const { exportFilesAsync } = await import('../src/io/files.ts');
  const { heightmapExport } = await import('../src/io/heightmap.ts');
  const { decodePNG } = await import('../src/io/png-decode.ts');
  const res = await exportFilesAsync(lg, 'unreal_landscape', 'bundle/level', {});
  const byPath = new Map(res.files.map((f) => [f.path, f.bytes]));
  const names = [...byPath.keys()];
  const need = ['landscape.json', 'heightmap.png', 'heightmap.json', 'objects.glb', 'instances.csv', 'instances.meshes.json', 'meshes/bush.glb', 'layers/rock.png', 'layers/flow.png'];
  check(need.every((n) => byPath.has('bundle/level/' + n)), `bundle files: ${names.map((n) => n.replace('bundle/level/', '')).join(', ')}`);
  const man = JSON.parse(new TextDecoder().decode(byPath.get('bundle/level/landscape.json')!));
  const side = JSON.parse(new TextDecoder().decode(byPath.get('bundle/level/heightmap.json')!));
  const ref = heightmapExport(lg, 'png16').info as any;
  check(JSON.stringify(man.landscape.scale) === JSON.stringify(ref.unreal.scale) && JSON.stringify(man.landscape.actor_location_cm) === JSON.stringify(ref.unreal.location_cm) && JSON.stringify(side.unreal) === JSON.stringify(ref.unreal)
    && man.heightmap.height_min_m === ref.height_min && man.heightmap.height_max_m === ref.height_max && man.heightmap.resolution.join() === '127,127',
    `bundle manifest matches heightmapExport's sidecar: scale (${man.landscape.scale}), actor location (${man.landscape.actor_location_cm})`);
  const half = 63 * man.landscape.scale[0];
  check(man.landscape.section_size_quads === 63 && man.landscape.sections_per_component === 2 && man.landscape.components.join() === '1,1' && man.landscape.exact_fit && man.landscape.overall_resolution.join() === '127,127'
    && Math.abs(man.landscape.new_landscape_location_cm[0] - (man.landscape.actor_location_cm[0] + half)) < 1e-6 && man.manual_import.length >= 5,
    `bundle: Landscape layout 63 quads, 2×2 sections, 1×1 component; panel location = corner + half size (${man.landscape.new_landscape_location_cm})`);
  const hm = decodePNG(byPath.get('bundle/level/heightmap.png')!);
  const rk = decodePNG(byPath.get('bundle/level/layers/rock.png')!);
  check(hm.width === 127 && hm.bitDepth === 16 && rk.width === 127 && rk.bitDepth === 8 && man.layers.some((l: any) => l.name === 'rock' && l.file === 'layers/rock.png'), 'bundle: 16-bit heightmap and 8-bit layer PNGs decode at 127×127');
  check(!man.layers.some((l: any) => l.name === 'height') && man.instances.count === 40 && man.instances.sources.join() === 'bush' && man.objects === 'objects.glb', 'bundle manifest: layers (no height), instances, objects');
  await validate(byPath.get('bundle/level/objects.glb')!, 'bundle objects.glb');
  check(parseCSVText(new TextDecoder().decode(byPath.get('bundle/level/instances.csv')!)).length - 1 === 40, 'bundle instances.csv: 40 rows');
  const viaJson = await exportFilesAsync(lg, 'unreal_landscape', 'x/terrain.json', {});
  check(viaJson.files[0].path === 'x/terrain.json' && viaJson.files.some((f) => f.path === 'x/heightmap.png'), 'unreal_landscape with a .json path names the manifest');
  let nohf = '';
  try { await exportFilesAsync(await cook({ nodes: { b: { type: 'box' } } }), 'unreal_landscape', 'y', {}); } catch (e: any) { nohf = e.message; }
  check(/no heightfield/.test(nohf), 'unreal_landscape without a heightfield: clear error');
}

// ---------------------------------------------------------------- export:demo in a temp dir
{
  const tmp = fs.mkdtempSync(path.join(ROOT, 'test', '.tmp-interop-'));
  try {
    const { execFileSync } = await import('node:child_process');
    const t0 = performance.now();
    const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'export-demo.ts'), tmp], { encoding: 'utf8', cwd: ROOT });
    const info = JSON.parse(fs.readFileSync(path.join(tmp, 'demo.json'), 'utf8'));
    const files: string[] = info.files.map((f: any) => f.path);
    const need = ['landscape/landscape.json', 'landscape/heightmap.png', 'landscape/objects.glb', 'landscape/instances.csv', 'scene.glb', 'scene.usda', 'scene.geo', 'instances.csv', 'instances.meshes.json'];
    check(need.every((f) => files.includes(f) && fs.statSync(path.join(tmp, f)).size > 0) && info.scene.instances > 100 && info.warnings.length === 0 && /files, /.test(out),
      `export:demo: ${files.length} files, ${info.scene.instances} instances of ${info.scene.sources} sources in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    const man = JSON.parse(fs.readFileSync(path.join(tmp, 'landscape', 'landscape.json'), 'utf8'));
    check(man.landscape.exact_fit && man.landscape.components.join() === '2,2' && ['grass', 'rock', 'road'].every((l) => man.layers.some((x: any) => x.name === l)), 'export:demo: the landscape fits Unreal exactly (2×2 components) with grass/rock/road layers');
    await validate(new Uint8Array(fs.readFileSync(path.join(tmp, 'scene.glb'))), 'export:demo scene.glb');
    const sg = importGeometry(new Uint8Array(fs.readFileSync(path.join(tmp, 'scene.geo'))), 'geo');
    check(sg.numPacked === info.scene.instances, `export:demo scene.geo re-imports ${sg.numPacked} packed instances`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

/** RFC 4180 rows (test helper). */
function parseCSVText(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}

console.log(fail ? `${fail} interop check(s) failed` : 'interop: all checks passed');
process.exit(fail ? 1 : 0);
