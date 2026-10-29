// Image cutouts and atlas workflows: behaviour, topology, immutability, rendering and GLB round trips.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { defineNode } from '../src/graph/registry.ts';
import { Geometry } from '../src/core/geometry.ts';
import { Image, findImage, sampleUV } from '../src/core/image.ts';
import { traceMask } from '../src/core/traceimage.ts';
import { crossSection } from '../src/core/manifold.ts';
import { cropImage, dilateImage } from '../src/core/imageops.ts';
import { readMaterials, writeMaterials, normalizeMaterial } from '../src/core/materials.ts';
import { geoToJSON, geoFromJSON } from '../src/io/json.ts';
import { exportGeometryAsync } from '../src/io/export.ts';
import { importGLTFAsync, gltfDocument, documentToGeometry } from '../src/io/gltf.ts';
import { NodeIO } from '@gltf-transform/core';
import { renderGeometry } from '../src/render/raster.ts';
import { textureSampler } from '../src/render/texview.ts';
import { fingerprint } from './fingerprint.ts';
import { backTint } from '../src/viewer/app/scene.js';
import * as THREE from 'three';
import type { GraphSpec } from '../src/graph/types.ts';

let passed = 0;
function test(name: string, fn: () => void) { fn(); passed++; console.log('PASS ' + name); }
const engine = new Engine(createNodeHost({ workers: 0 }));
await engine.init();
const inputs = new Map<number, Geometry>();
let id = 0;
defineNode({ type: '__imageops_test_source', category: 'test', inputs: [], params: { id: { type: 'int', default: 0, desc: 'test input' } }, summary: 'test', cook: ({ p }) => inputs.get(p.id)! });
async function cook(type: string, geos: Geometry[], params: Record<string, any> = {}): Promise<Geometry> {
  const nodes: GraphSpec['nodes'] = {};
  const names = geos.map((g, i) => { const n = 'src' + i; inputs.set(++id, g); nodes[n] = { type: '__imageops_test_source', params: { id } }; return n; });
  nodes.out = { type, in: names, params };
  const r = await engine.cook({ nodes, output: 'out' });
  if (!r.ok || !r.geo) throw new Error(r.errors.map((e) => e.message).join('; '));
  return r.geo;
}
async function rejects(type: string, geos: Geometry[], params: Record<string, any>, re: RegExp) {
  await assert.rejects(() => cook(type, geos, params), re); passed++; console.log('PASS readable error: ' + type + ' ' + re);
}
function img(w: number, h: number, name: string, ch = 1, fn = (i: number, c: number) => i + c): Image {
  return new Image(w, h, name).set('C', Float32Array.from({ length: w * h * ch }, (_, i) => fn(Math.floor(i / ch), i % ch)));
}
function geo(...images: Image[]): Geometry { const g = new Geometry(); g.volumes = images; return g; }
function eq(a: ArrayLike<number>, b: ArrayLike<number>) { assert.deepEqual(Array.from(a), Array.from(b)); }
function near(a: number, b: number, eps = 1e-6) { assert.ok(Math.abs(a - b) <= eps, a + ' != ' + b); }
function mask(rows: string[]): Float32Array { return Float32Array.from(rows.join(''), (v) => v === '#' ? 1 : 0); }
function contourTopology(loops: ReturnType<typeof traceMask>): number[] {
  const cs = crossSection(loops.map((l) => l.points), 'EvenOdd'), parts = cs.decompose();
  try { return parts.map((p: any) => p.toPolygons().length).sort((a: number, b: number) => a - b); }
  finally { for (const part of parts) part.delete(); cs.delete(); }
}

// Cropping all layers, exact pixels, dimensions, source immutability.
const source = img(5, 3, 'source', 4, (i, c) => i * 4 + c);
source.set('id', Float32Array.from({ length: 15 }, (_, i) => i));
const sourceGeo = geo(source, img(1, 1, 'other'));
const sourceBefore = fingerprint(sourceGeo);
const cropped = await cook('tex_crop', [sourceGeo], { image: 'source', origin: [-1, 1], size: [4, 3], name: 'crop' });
test('crop: exact top-left rectangle, all layers and zero outside', () => {
  const c = findImage(cropped, 'crop')!;
  assert.equal(c.width, 4); assert.equal(c.height, 3);
  eq(c.layer('id')!, [0, 5, 6, 7, 0, 10, 11, 12, 0, 0, 0, 0]);
  eq(c.layer('C')!.subarray(4, 8), source.layer('C')!.subarray(20, 24));
  assert.ok(findImage(cropped, 'other')); assert.deepEqual(fingerprint(sourceGeo), sourceBefore);
});
const cropDefault = await cook('tex_crop', [sourceGeo], { image: 'source' });
test('crop: defaults preserve every source value; the result takes the node name', () => {
  eq(findImage(cropDefault, 'out')!.layer('C')!, source.layer('C')!);
  eq(findImage(cropDefault, 'out')!.layer('id')!, source.layer('id')!);
});
await rejects('tex_crop', [sourceGeo], {}, /holds 2 images \("source", "other"\)/);
test('crop: nearest keeps discrete IDs; filtered resize area-averages without wrapping', () => {
  const s = img(2, 2, 'a');
  eq(cropImage(s, 0, 0, 2, 2, 4, 2, true, 'b').layer('C')!, [0, 0, 1, 1, 2, 2, 3, 3]);
  eq(cropImage(s, 0, 0, 2, 2, 1, 1, false, 'b').layer('C')!, [1.5]);
});
await rejects('tex_crop', [sourceGeo], { image: 'source', origin: [9, 0] }, /at least 1/);
await rejects('tex_crop', [sourceGeo], { image: 'source', size: [8192, 8192] }, /too large/);

// Dilation: exact nearest sites including deterministic ties, no alpha loss.
const rgba = img(7, 5, 'rgba', 4, (i, c) => c === 3 ? (i === 8 || i === 26 ? 1 : 0) : i + c / 4);
const padded = await cook('tex_dilate', [geo(rgba)], { radius: 3 });
test('dilate: exact nearest source, deterministic ties, unchanged alpha and unreached pixels', () => {
  const a = rgba.layer('C')!, b = findImage(padded)!.layer('C')!;
  for (let i = 0; i < 35; i++) {
    const distances = [8, 26].map((s) => ({ s, d: (i % 7 - s % 7) ** 2 + (Math.floor(i / 7) - Math.floor(s / 7)) ** 2 })).sort((x, y) => x.d - y.d || x.s - y.s);
    const src = distances[0].d <= 9 ? distances[0].s : i;
    for (let c = 0; c < 3; c++) assert.equal(b[i * 4 + c], a[src * 4 + c]);
    assert.equal(b[i * 4 + 3], a[i * 4 + 3]);
  }
});
test('dilate: empty/full masks and radius zero do nothing', () => {
  const a = Float32Array.from([4, 3, 2, 1]);
  for (const [m, r] of [[new Float32Array(4), 8], [new Float32Array(4).fill(1), 8], [Float32Array.from([1, 0, 0, 0]), 0]] as const) eq(dilateImage(a, 1, 2, 2, m, 0, r, true), a);
});
const grey = img(3, 1, 'data', 1, (i) => [3, 7, 9][i]), validity = img(3, 1, 'mask', 1, (i) => i === 0 ? 1 : 0);
const gd = await cook('tex_dilate', [geo(grey), geo(validity)], { radius: 1 });
test('dilate: explicit grayscale mask, radius and original source preserved', () => {
  eq(findImage(gd)!.layer('C')!, [3, 3, 9]); eq(grey.layer('C')!, [3, 7, 9]);
});
const noPreserve = await cook('tex_dilate', [geo(rgba)], { radius: 1, preserve_alpha: false });
test('dilate: preserve_alpha false extends alpha too', () => assert.equal(findImage(noPreserve)!.layer('C')![9 * 4 + 3], 1));
await rejects('tex_dilate', [geo(grey)], {}, /explicit mask/);
await rejects('tex_dilate', [geo(grey), geo(img(2, 2, 'bad'))], {}, /dimensions must match/);

// Tracing and filling: positive XY winding, holes, thin features and stable component IDs.
function signedArea(g: Geometry): number {
  let sum = 0;
  for (let p = 0; p < g.numPrims; p++) {
    const pts = g.primPoints(p);
    for (let i = 0; i < pts.length; i++) { const a = pts[i] * 3, b = pts[(i + 1) % pts.length] * 3; sum += g.P[a] * g.P[b + 1] - g.P[b] * g.P[a + 1]; }
  }
  return sum / 2;
}
const rows = ['.........', '.#####.#.', '.#...#.#.', '.#...#.#.', '.#####.#.', '.........'];
const im = new Image(9, 6, 'shapes').set('C', mask(rows));
const traced = await cook('trace_image', [geo(im)], { channel: 'luminance', tolerance: 0 });
const filled = await cook('fill', [traced], { plane: 'xy' });
test('trace: ring, hole and one-pixel strip survive fill with exact area', () => {
  assert.equal(traced.numPrims, 3);
  eq(traced.prims.get('hole')!.data as Int32Array, [0, 1, 0]);
  assert.equal(new Set(traced.prims.get('class')!.data as Int32Array).size, 2);
  near(signedArea(filled), rows.join('').split('#').length / 81 - 1 / 81);
});
const full = await cook('trace_image', [geo(img(4, 2, 'full', 1, () => 1))], { channel: 'r' });
test('trace: full mask covers the full canvas, aspect and UVs retained', () => {
  assert.equal(full.numPoints, 4); near(signedArea(full), 0.5);
  assert.deepEqual(full.bbox().min, [0, 0, 0]); assert.deepEqual(full.bbox().max, [1, 0.5, 0]);
  eq(full.detail.get('image_size')!.get(0) as number[], [4, 2]);
});
const empty = await cook('trace_image', [geo(img(4, 2, 'empty', 1, () => 0))], { channel: 'luminance' });
test('trace: empty mask returns empty geometry', () => assert.equal(empty.numPrims, 0));
const diagonal = await cook('trace_image', [geo(new Image(2, 2, 'diagonal').set('C', mask(['#.', '.#'])))], { channel: 'r', tolerance: 8 });
test('trace: diagonal contacts remain two components even at high tolerance', () => {
  assert.equal(diagonal.numPrims, 2); assert.equal(new Set(diagonal.prims.get('class')!.data as Int32Array).size, 2);
});
const filtered = await cook('trace_image', [geo(im)], { channel: 'r', min_area: 5, tolerance: 0 });
test('trace: min_area removes whole small components, retaining the large component hole', () => {
  assert.equal(filtered.numPrims, 2); eq(filtered.prims.get('hole')!.data as Int32Array, [0, 1]);
});
const simplified = await cook('trace_image', [geo(im)], { channel: 'r', tolerance: 8 });
test('trace: large tolerance cannot erase holes or the thin strip', () => {
  eq(simplified.prims.get('hole')!.data as Int32Array, traced.prims.get('hole')!.data as Int32Array);
  assert.ok(simplified.numPoints <= traced.numPoints);
});
const uv = await cook('uv_project', [filled], { method: 'planar', axis: 'z', scale: [1, 6 / 9] });
test('trace → fill → UV projection retains original transparent margins', () => {
  const attr = uv.vertices.get('uv')!;
  for (let v = 0; v < uv.numVertices; v++) { const p = uv.vertexPoint[v] * 3, u = attr.get(v) as number[]; near(u[0], uv.P[p]); near(u[1], uv.P[p + 1] * 9 / 6); }
});
test('trace: exhaustive 3×3 masks preserve signed area, component/hole flags and determinism', () => {
  for (let bits = 0; bits < 512; bits++) {
    const a = Float32Array.from({ length: 9 }, (_, i) => (bits >> i) & 1), loops = traceMask(a, 3, 3, 0.5, 0, 0);
    let area = 0;
    for (const loop of loops) for (let i = 0; i < loop.points.length; i++) {
      const p = loop.points[i], q = loop.points[(i + 1) % loop.points.length]; area += (p[0] * q[1] - q[0] * p[1]) / 2;
    }
    assert.equal(area, a.reduce((s, v) => s + v, 0));
    const simple = traceMask(a, 3, 3, 0.5, 0, 10);
    assert.deepEqual(simple.map((l) => [l.component, l.hole]), loops.map((l) => [l.component, l.hole]));
    assert.deepEqual(contourTopology(simple), contourTopology(loops));
    assert.deepEqual(simple, traceMask(a, 3, 3, 0.5, 0, 10));
  }
});
test('trace: random narrow channels and nested regions retain actual filled topology', () => {
  let seed = 79;
  for (let trial = 0; trial < 100; trial++) {
    const pixels = Float32Array.from({ length: 16 * 16 }, () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 < 0.55 ? 1 : 0; });
    const raw = traceMask(pixels, 16, 16, 0.5, 0, 0), simplified = traceMask(pixels, 16, 16, 0.5, 0, 4);
    assert.deepEqual(contourTopology(simplified), contourTopology(raw), 'combined topology trial ' + trial);
    // Clipper may stitch contours from different components at diagonal contacts in
    // different ways. Compare each 4-connected foreground component independently.
    for (const c of new Set(raw.map((l) => l.component))) {
      assert.deepEqual(contourTopology(simplified.filter((l) => l.component === c)), contourTopology(raw.filter((l) => l.component === c)), 'topology trial ' + trial + ', component ' + c);
    }
  }
  const pixels = mask(['#######', '#.....#', '#.###.#', '#.#.#.#', '#.###.#', '#.....#', '#######']);
  assert.deepEqual(contourTopology(traceMask(pixels, 7, 7, 0.5, 0, 8)), [2, 2]);
});
await rejects('trace_image', [geo(im)], {}, /alpha channel requires RGBA/);

// Atlas multiple maps, rectangular target, placement and errors.
const maps = geo(img(3, 2, 'a_color', 4), img(3, 2, 'a_data'), img(2, 4, 'b_color', 4), img(2, 4, 'b_data'));
const items = [{ name: 'a', maps: { color: 'a_color', data: 'a_data' } }, { name: 'b', maps: { data: 'b_data', color: 'b_color' } }];
const before = fingerprint(maps);
const packed = await cook('tex_pack', [maps], { items, resolution: [16, 8], padding: 1 });
test('pack: channels align, native pixels survive and UV transforms address original pixels', () => {
  assert.equal(packed.numPoints, 2); assert.equal(packed.numPrims, 0);
  const occupied = new Set<string>();
  for (let i = 0; i < 2; i++) {
    assert.equal(packed.points.get('name')!.get(i), items[i].name);
    const [x, y, w, h] = packed.points.get('rect')!.get(i) as number[];
    const off = packed.points.get('uv_offset')!.get(i) as number[], scale = packed.points.get('uv_scale')!.get(i) as number[];
    for (let yy = y - 1; yy < y + h + 1; yy++) for (let xx = x - 1; xx < x + w + 1; xx++) {
      const key = xx + ',' + yy; assert.ok(!occupied.has(key)); occupied.add(key);
      assert.ok(xx >= 0 && xx < 16 && yy >= 0 && yy < 8);
    }
    for (const slot of ['color', 'data'] as const) {
      // the atlas images are named <node>_<label> (the node is "out")
      const src = findImage(maps, items[i].maps[slot])!, atlas = findImage(packed, 'out_' + slot)!, ch = src.channels('C');
      for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) {
        const out: number[] = [];
        sampleUV(atlas.layer('C')!, ch, 16, 8, off[0] + ((col + 0.5) / w) * scale[0], off[1] + (1 - (row + 0.5) / h) * scale[1], out, false, true);
        eq(out, src.layer('C')!.subarray((row * w + col) * ch, (row * w + col + 1) * ch));
      }
      assert.equal(atlas.layer('C')![((y - 1) * 16 + x) * ch], 0);
    }
  }
  assert.deepEqual(fingerprint(maps), before);
});
const again = await cook('tex_pack', [maps], { items, resolution: [16, 8], padding: 1 });
test('pack: reproducible output and placement attributes survive JSON', () => {
  assert.deepEqual(fingerprint(packed), fingerprint(again));
  assert.deepEqual(fingerprint(packed), fingerprint(geoFromJSON(geoToJSON(packed))));
});
await rejects('tex_pack', [maps], { items, resolution: 4 }, /do not fit/);
await rejects('tex_pack', [maps], { items: [items[0], { name: 'b', maps: { color: 'b_color' } }] }, /matching map labels/);
await rejects('tex_pack', [maps], { items: [{ name: 'a', maps: { color: 'a_color', data: 'b_data' } }] }, /dimensions must match/);
await rejects('tex_pack', [maps], { items: [{ name: 'a', maps: { color: 'missing' } }] }, /missing image/);
await rejects('tex_pack', [maps], { items: [items[0], items[0]] }, /unique/);
await rejects('tex_pack', [maps], { items: [{ name: 'a', maps: { color: 'a_color' } }, { name: 'b', maps: { color: 'b_data' } }] }, /channel counts/);

// Alpha material and export checks. Real GLB bytes are validated and imported, not just extras inspection.
function quad(z = 0): Geometry {
  const g = new Geometry({ positions: [0, 0, z, 1, 0, z, 1, 1, z, 0, 1, z], prims: [[0, 1, 2, 3]] });
  const uv = g.points.add('uv', 'float', 3); [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]].forEach((p, i) => uv.set(i, p));
  return g;
}
const base = quad();
const mat = await cook('material', [base], { name: 'cutout', alpha_mode: 'mask', alpha_cutoff: 0.6, double_sided: true });
const alphaImage = img(8, 8, 'alpha', 4, (i, c) => c === 3 ? (i % 8 < 4 ? 0 : 1) : c === 0 ? 1 : 0.05);
const textured = await cook('texture_to_material', [mat, geo(alphaImage)], { material: 'cutout', base_color: 'alpha' });
test('material: explicit alpha fields survive texture assignment and JSON', () => {
  assert.equal(readMaterials(textured).cutout.alphaMode, 'MASK'); near(readMaterials(textured).cutout.alphaCutoff!, 0.6);
  assert.equal(readMaterials(geoFromJSON(geoToJSON(textured))).cutout.alphaMode, 'MASK');
  assert.ok(!('alphaMode' in normalizeMaterial({})));
});
const validator = createRequire(import.meta.url)('gltf-validator');
const bytes = await exportGeometryAsync(textured, 'glb');
const report = await validator.validateBytes(bytes);
test('GLB: validates, exports standard mask/cutoff and embeds RGBA texture', () => assert.equal(report.issues.numErrors, 0));
const document = await new NodeIO().readBinary(bytes);
test('GLB: actual standard material fields are MASK, cutoff 0.6, two-sided', () => {
  const m = document.getRoot().listMaterials()[0]; assert.equal(m.getAlphaMode(), 'MASK'); near(m.getAlphaCutoff(), 0.6); assert.ok(m.getDoubleSided());
});
const imported = await importGLTFAsync(bytes);
test('GLB: round trip retains mask and cutoff', () => { const m = Object.values(readMaterials(imported))[0]; assert.equal(m.alphaMode, 'MASK'); near(m.alphaCutoff!, 0.6); });
for (const m of document.getRoot().listMaterials()) m.setExtras({});
const external = documentToGeometry(document);
test('GLB: imports standard alpha settings without TopoTopo extras', () => { const m = Object.values(readMaterials(external))[0]; assert.equal(m.alphaMode, 'MASK'); near(m.alphaCutoff!, 0.6); });
for (const mode of ['auto', 'opaque', 'mask', 'blend']) {
  const g = await cook('material', [base], { alpha_mode: mode, alpha: 0.3 });
  test('GLB: mode ' + mode + ' has correct scalar-alpha precedence', () => assert.equal(gltfDocument(g).getRoot().listMaterials()[0].getAlphaMode(), mode === 'auto' ? 'BLEND' : mode.toUpperCase()));
}
test('sampler: RGBA alpha is sampled; grey maps have alpha 1', () => {
  const s = textureSampler(textured, [])!, p: number[] = [];
  s.sample(0, 0.125, 0.5, 0, p); assert.equal(p[3], 0);
  s.sample(0, 0.875, 0.5, 0, p); assert.equal(p[3], 1);
  const grey = textured.clone(); grey.volumes = [img(2, 2, 'alpha', 1, () => 0.3)];
  textureSampler(grey, [])!.sample(0, 0.5, 0.5, 0, p); assert.equal(p[3], 1);
});
test('viewer: explicit two-sided surfaces keep their materials; diagnostics stay for others', () => {
  const a = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, alphaTest: 0.5 });
  backTint(a); assert.equal(a.userData.backTint, undefined); assert.equal(a.alphaTest, 0.5);
  const b = new THREE.MeshStandardMaterial(); backTint(b); assert.equal(b.userData.backTint, true);
});

function scene(front: Geometry, back: Geometry): Geometry {
  const g = Geometry.merge([front, back]);
  writeMaterials(g, { ...readMaterials(front), ...readMaterials(back) });
  return g;
}
const back = await cook('material', [quad(-0.1)], { name: 'background', base_color: [0.05, 0.05, 1] });
const opts = { size: 128, views: ['front'] as const, grid: false, wireframe: false, textures: true, ssaa: 1, title: 'mask test' };
const render = (g: Geometry) => renderGeometry(g, { ...opts, views: ['front'] });
function rgbCount(r: ReturnType<typeof render>, color: 'red' | 'blue') {
  let n = 0;
  for (let i = 0; i < r.width * 128 * 4; i += 4) if (color === 'red' ? r.rgba[i] > r.rgba[i + 2] + 60 : r.rgba[i + 2] > r.rgba[i] + 60) n++;
  return n;
}
test('render: masked front reveals background, independent of draw order', () => {
  const a = render(scene(textured, back)), b = render(scene(back, textured));
  assert.ok(rgbCount(a, 'blue') > 500); assert.ok(rgbCount(a, 'red') > 500);
  eq(a.rgba, b.rgba);
});
const reversed = await cook('reverse', [textured]);
test('render: both orientations of a two-sided masked card show its cutout', () => {
  const a = render(scene(textured, back)), b = render(scene(reversed, back));
  assert.equal(rgbCount(a, 'blue'), rgbCount(b, 'blue')); assert.equal(rgbCount(a, 'red'), rgbCount(b, 'red'));
});
const lowAlpha = textured.clone(); (lowAlpha.points.add('Alpha', 'float', 1).data as Float64Array).fill(0.5);
test('render: vertex Alpha multiplies texture/material opacity before cutoff', () => assert.equal(rgbCount(render(scene(lowAlpha, back)), 'red'), 0));
const lowMaterial = textured.clone(); const table = readMaterials(lowMaterial); table.cutout.alpha = 0.5; writeMaterials(lowMaterial, table);
test('render: scalar opacity also multiplies the mask', () => assert.equal(rgbCount(render(scene(lowMaterial, back)), 'red'), 0));
const cutoffExact = textured.clone(); const exactTable = readMaterials(cutoffExact); exactTable.cutout.alpha = 0.6; writeMaterials(cutoffExact, exactTable);
test('render: alpha equal to cutoff survives', () => assert.ok(rgbCount(render(scene(cutoffExact, back)), 'red') > 500));
const opaque = textured.clone(); const ot = readMaterials(opaque); ot.cutout.alphaMode = 'OPAQUE'; writeMaterials(opaque, ot);
test('render: explicit opaque ignores texture transparency', () => assert.equal(rgbCount(render(scene(opaque, back)), 'blue'), 0));

// The public example is also an integration test once present.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const example = path.join(root, 'examples', 'image_cutouts.json');
if (fs.existsSync(example)) {
  const r = await engine.cook(JSON.parse(fs.readFileSync(example, 'utf8')));
  test('complete image_cutouts graph cooks', () => assert.ok(r.ok, r.errors.map((e) => e.node + ': ' + e.message).join('; ')));
  const glb = await exportGeometryAsync(r.geo!, 'glb'), check = await validator.validateBytes(glb);
  test('complete graph exports a valid masked GLB without placement points', () => {
    assert.equal(check.issues.numErrors, 0); assert.ok(r.geo!.numPrims > 0);
    assert.equal(new Set(r.geo!.vertexPoint).size, r.geo!.numPoints);
    assert.ok(Object.values(readMaterials(r.geo!)).some((m) => m.alphaMode === 'MASK'));
  });
}
console.log(passed + ' passed, 0 failed');

