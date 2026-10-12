// Interop round trips: glTF through gltf-transform (plain, quantized, meshopt) with materials, vertex colours,
// uvs, custom attributes, polylines and points; Houdini .geo (all attribute classes, groups, strings, polylines,
// a hand-written Houdini-style sample); CSV (plain + Unreal PCG); points JSON. Every GLB written is checked with
// the Khronos glTF validator (gltf-validator, offline).
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

// EXT_mesh_gpu_instancing on import: instances are expanded (packed prims come later)
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
  const back = await importGeometryAsync(bytes, 'glb', { warn: (m) => warns.push(m) });
  const bb = back.bbox();
  check(back.numPrims === 3 && close(bb.max[0], 11, 1e-6) && close(bb.min[1], 2, 1e-6) && warns.some((w) => /instancing/.test(w)), `EXT_mesh_gpu_instancing: 3 instances expanded with the node transform (${back.numPrims} prims, bbox x ${bb.min[0]}..${bb.max[0]})`);
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
  check(checkGeo(g).length === 0, 'houdini_box.geo: valid geometry');
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

console.log(fail ? `${fail} interop check(s) failed` : 'interop: all checks passed');
process.exit(fail ? 1 : 0);
