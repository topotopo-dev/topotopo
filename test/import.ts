// Scene imports: glTF hierarchy/extras/instances, directory variants and optional real headless Blender.
import '../src/nodes/index.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshGPUInstancing, KHRLightsPunctual } from '@gltf-transform/extensions';
import { Engine } from '../src/graph/engine.ts';
import type { GraphSpec } from '../src/graph/types.ts';
import { createNodeHost, findBlender } from '../src/host/node.ts';
import { importFormatFromPath, importGeometryAsync } from '../src/io/import.ts';
import { exportGeometryAsync } from '../src/io/export.ts';
import { expandPacked } from '../src/core/packed.ts';
import { checkGeo } from './fixtures.ts';
import type { Geometry } from '../src/core/geometry.ts';

let passed = 0, failed = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (ok) passed++; else failed++; };
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const near = (a: ArrayLike<number>, b: number[]) => a.length === b.length && Array.from(a).every((v, i) => Math.abs(v - b[i]) < 1e-6);
const values = (g: Geometry, cls: 'point' | 'prim', key: string) => {
  const a = g.table(cls).get(key);
  return a ? Array.from({ length: a.count }, (_, i) => a.get(i)) : [];
};
const fileGraph = (file: string, params: Record<string, unknown> = {}): GraphSpec => ({ nodes: { file: { type: 'file', params: { path: file, ...params } } }, output: 'file' });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'topotopo-import-'));
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
try {
  const doc = new Document(), buffer = doc.createBuffer();
  const scene = doc.createScene('scene'); doc.getRoot().setDefaultScene(scene);
  const q: [number, number, number, number] = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
  const village = doc.createNode('village').setTranslation([10, 20, 30]).setRotation(q).setScale([2, 2, 2]);
  const empty = doc.createNode('site').setTranslation([1, 2, 3]).setScale([1, 2, 3]).setExtras({
    role: 'site', radius: 2.5, flag: true, tag: 'a', pair: [1, 2], triple: [1, 2, 3], quat: [0, 0, 0, 1],
    nested: { ignored: true }, long: [1, 2, 3, 4, 5], strings: ['a', 'b'], topotopo: { private: 1 },
  });
  village.addChild(empty); scene.addChild(village);
  const pos = doc.createAccessor().setType('VEC3').setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buffer);
  const material = doc.createMaterial('clay');
  const mesh = doc.createMesh('triangle').addPrimitive(doc.createPrimitive().setAttribute('POSITION', pos).setMaterial(material)).setExtras({
    category: 'mesh', rating: 1, meshOnly: 7, name: 'must not replace', P: [9, 9, 9], uv: [1, 2],
  });
  for (let i = 0; i < 3; i++) village.addChild(doc.createNode(`copy${i}`).setMesh(mesh).setTranslation([i * 2, 0, 0]).setExtras({
    category: `node${i}`, ...(i === 1 ? { rating: 2.5, unique: 'second' } : {}),
  }));
  scene.addChild(doc.createNode('camera').setCamera(doc.createCamera().setType('perspective')));
  const lights = doc.createExtension(KHRLightsPunctual);
  scene.addChild(doc.createNode('light').setExtension('KHR_lights_punctual', lights.createLight().setType('point')));
  const bytes = await io.writeBinary(doc), warnings: string[] = [];
  const g = await importGeometryAsync(bytes, 'glb', { warn: (m) => warnings.push(m) });
  check(g.numPoints === 5 && g.numPrims === 3 && g.numPacked === 3 && g.packedSources.length === 1, 'glTF two empties + three shared nodes: one source, three packed prims');
  check(eq(values(g, 'point', 'name').slice(0, 2), ['village', 'site']) && g.points.get('path')?.get(1) === 'village', 'empty names and ancestor path');
  check(near(g.P.slice(3, 6), [6, 22, 36]) && near(g.points.get('orient')!.get(1) as number[], q)
    && near(g.points.get('scale')!.get(1) as number[], [2, 4, 6]) && g.points.get('pscale')?.get(1) === 1, 'empty world translation, unit quaternion, scale and pscale');
  check(g.points.get('role')?.get(1) === 'site' && g.points.get('radius')?.get(1) === 2.5 && g.points.get('flag')?.get(1) === 1
    && g.points.get('flag')?.type === 'int' && g.points.get('tag')?.get(1) === 'a', 'empty scalar extras retain types and values');
  check(eq(g.points.get('pair')?.get(1), [1, 2]) && g.points.get('triple')?.size === 3 && g.points.get('quat')?.size === 4
    && !g.points.has('nested') && !g.points.has('long') && !g.points.has('strings') && !g.points.has('topotopo'), 'numeric vector extras accepted; nested/invalid/private extras ignored');
  check(eq(values(g, 'prim', 'name'), ['copy0', 'copy1', 'copy2']) && eq(values(g, 'prim', 'path'), ['village', 'village', 'village']), 'shared mesh names and paths live on each packed prim');
  check(eq(values(g, 'prim', 'category'), ['node0', 'node1', 'node2']) && eq(values(g, 'prim', 'rating'), [1, 2.5, 1])
    && g.prims.get('rating')?.type === 'float' && eq(values(g, 'prim', 'unique'), ['', 'second', '']) && eq(values(g, 'prim', 'meshOnly'), [7, 7, 7]), 'node extras win; Geometry.merge promotes numeric types and fills missing values');
  check(warnings.length === 2 && warnings.includes('skipped 2 cameras/lights')
    && warnings.some((m) => m.includes('P, name, uv')), 'one camera/light warning and one named reserved-extras warning');
  const unpacked = expandPacked(g, { transfer: '*' }).geo;
  check(eq(values(unpacked, 'point', 'name').slice(2), ['copy0', 'copy0', 'copy0', 'copy1', 'copy1', 'copy1', 'copy2', 'copy2', 'copy2'])
    && eq(values(unpacked, 'prim', 'category'), ['node0', 'node1', 'node2']), 'unpack preserves per-instance names and requested extras (mixed-scene names follow point precedence)');
  const expanded = await importGeometryAsync(bytes, 'glb', { instancing: 'expand' });
  check(!expanded.hasPacked() && expanded.numPoints === 11 && expanded.numPrims === 3
    && eq(values(expanded, 'prim', 'name'), ['copy0', 'copy1', 'copy2']) && near(expanded.bbox().max, unpacked.bbox().max), 'expand mode retains three world-space mesh copies');
  check(checkGeo(g).length === 0 && checkGeo(expanded).length === 0, 'merged scenes satisfy geometry invariants');
  const reexported = await importGeometryAsync(await exportGeometryAsync(g, 'glb', { custom: true }), 'glb');
  check(reexported.numPacked === 3 && eq(values(reexported, 'prim', 'name'), ['copy0', 'copy1', 'copy2'])
    && eq(values(reexported, 'prim', 'category'), ['node0', 'node1', 'node2']), 'packed names and extras survive GLB export (custom attributes) and reimport');
  check(eq(values(g, 'prim', 'name'), values(await importGeometryAsync(bytes, 'glb'), 'prim', 'name')), 'repeated import has stable instance order');
  fs.writeFileSync(path.join(tmp, 'scene.glb'), bytes);
  const host = createNodeHost({ baseDir: tmp, workers: 0 });
  const engine = new Engine(host); await engine.init();
  const cooked = await engine.cook(fileGraph('scene.glb'));
  check(cooked.ok && cooked.geo?.numPacked === 3, 'scene with sparse extras cooks through file node');

  // Single-use meshes stay expanded; unrelated scenes do not affect shared-mesh counts.
  const single = new Document(), sb = single.createBuffer();
  const sm = single.createMesh('one').addPrimitive(single.createPrimitive().setAttribute('POSITION', single.createAccessor().setType('VEC3').setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(sb)));
  single.createScene('active').addChild(single.createNode('only').setMesh(sm));
  single.createScene('other').addChild(single.createNode('unused').setMesh(sm));
  const one = await importGeometryAsync(await io.writeBinary(single), 'glb');
  check(one.numPrims === 1 && one.numPoints === 3 && !one.hasPacked() && one.prims.get('path')?.get(0) === '', 'single active-scene reference remains expanded, with root path');
  const ext = single.createExtension(EXTMeshGPUInstancing);
  single.getRoot().listNodes()[0].setExtension('EXT_mesh_gpu_instancing', ext.createInstancedMesh().setAttribute('TRANSLATION', single.createAccessor().setType('VEC3').setArray(new Float32Array([0, 0, 0, 2, 0, 0])).setBuffer(sb))).setExtras({ tag: 'gpu' });
  const gpu = await importGeometryAsync(await io.writeBinary(single), 'glb');
  check(gpu.numPacked === 2 && eq(values(gpu, 'prim', 'path'), ['', '']) && eq(values(gpu, 'prim', 'tag'), ['gpu', 'gpu']), 'EXT instances also receive object extras and paths');
  const emptyDoc = new Document(); emptyDoc.createScene().addChild(emptyDoc.createNode());
  const unnamed = await importGeometryAsync(await io.writeBinary(emptyDoc), 'glb');
  check(unnamed.numPoints === 1 && unnamed.points.get('name')?.get(0) === '' && unnamed.points.get('path')?.get(0) === '', 'unnamed root empty has empty name and path');

  const folder = path.join(tmp, 'models'); fs.mkdirSync(folder);
  const obj = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n';
  fs.writeFileSync(path.join(folder, 'b.obj'), 'o original\n' + obj);
  fs.writeFileSync(path.join(folder, 'a.obj'), obj);
  fs.writeFileSync(path.join(folder, 'c.ply'), 'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n');
  fs.writeFileSync(path.join(folder, 'ignored.txt'), 'not geometry');
  fs.mkdirSync(path.join(folder, 'nested')); fs.writeFileSync(path.join(folder, 'nested', 'hidden.obj'), obj);
  const folderGraph = fileGraph('models');
  const first = await engine.cook(folderGraph), again = await engine.cook(folderGraph);
  check(first.ok && first.geo?.numPoints === 9 && first.geo.numPrims === 3 && eq(values(first.geo, 'prim', 'name'), ['a', 'b', 'c']), 'folder loads sorted OBJ/PLY variants, ignores TXT and subdirectories');
  check(again.ok && again.results.get('file')?.cached === true, 'unchanged directory hits the engine cache');
  fs.writeFileSync(path.join(folder, 'a.obj'), obj.replace('1 0 0', '7 0 0'));
  fs.utimesSync(path.join(folder, 'a.obj'), new Date(), new Date(Date.now() + 2000));
  const edited = await engine.cook(folderGraph);
  check(edited.ok && edited.geo?.bbox().max[0] === 7 && !edited.results.get('file')?.cached, 'editing a folder member invalidates the file node');
  fs.writeFileSync(path.join(folder, 'd.obj'), obj);
  const added = await engine.cook(folderGraph);
  check(added.ok && added.geo?.numPrims === 4 && !added.results.get('file')?.cached, 'adding a folder member invalidates the file node');
  fs.unlinkSync(path.join(folder, 'd.obj'));
  const removed = await engine.cook(folderGraph);
  check(removed.ok && removed.geo?.numPrims === 3, 'removing a folder member invalidates the file node');
  const converted = await engine.cook(fileGraph('models', { scale: 2, up_axis: 'z', weld: true }));
  check(converted.ok && converted.geo?.bbox().max[0] === 14 && converted.geo.bbox().min[2] === -2, 'folder applies axis/scale/weld per file');
  const sceneFolder = path.join(tmp, 'scenes'); fs.mkdirSync(sceneFolder); fs.writeFileSync(path.join(sceneFolder, 'set.glb'), bytes);
  const namedScene = await engine.cook(fileGraph('scenes'));
  check(namedScene.ok && eq(values(namedScene.geo!, 'prim', 'name'), ['set/copy0', 'set/copy1', 'set/copy2'])
    && eq(values(namedScene.geo!, 'point', 'name').slice(0, 2), ['set/village', 'set/site']), 'folder prefixes multi-object names on packed prims and empty points');
  check(eq(values(cooked.geo!, 'prim', 'name'), ['copy0', 'copy1', 'copy2']), 'folder naming does not mutate earlier cooked geometry');
  const mixed = path.join(tmp, 'mixed'); fs.mkdirSync(mixed);
  const pure = new Document(), pb = pure.createBuffer();
  const pm = pure.createMesh().addPrimitive(pure.createPrimitive().setAttribute('POSITION', pure.createAccessor().setType('VEC3').setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(pb)));
  pure.createScene().addChild(pure.createNode('left').setMesh(pm)).addChild(pure.createNode('right').setMesh(pm));
  fs.writeFileSync(path.join(mixed, 'models.glb'), await io.writeBinary(pure));
  fs.writeFileSync(path.join(mixed, 'markers.v1.points.json'), JSON.stringify({ format: 'topotopo-points', version: 1, count: 1, attributes: { P: { type: 'float', size: 3, data: [0, 0, 0] } } }));
  const mixedFolder = await engine.cook(fileGraph('mixed'));
  const mixedBack = await importGeometryAsync(await exportGeometryAsync(mixedFolder.geo!, 'glb', { custom: true }), 'glb');
  check(mixedFolder.ok && values(mixedFolder.geo!, 'point', 'name').includes('markers.v1') && eq(values(mixedBack, 'prim', 'name'), ['models/left', 'models/right']), 'separate point-stream and packed files keep folder names through export; dotted stems survive');
  const noConversion = new Engine({ ...host, convertFile: undefined });
  const missing = await noConversion.cook(fileGraph('anything.blend'));
  check(!missing.ok && missing.errors.some((e) => e.message === '.blend needs the Node host with Blender installed (set TOPOTOPO_BLENDER); export a .glb instead'), 'host without convertFile gives the actionable .blend error');
  const noDirectory = new Engine({ ...host, listDir: undefined });
  const unsupported = await noDirectory.cook(folderGraph);
  check(!unsupported.ok && unsupported.errors.some((e) => e.message.includes('isDirectory/listDir')), 'host without directory support errors clearly');
  const urlHost = new Engine({ ...host, isDirectory: undefined, listDir: undefined, readFile: async () => new TextEncoder().encode(obj) });
  const url = await urlHost.cook(fileGraph('https://example.invalid/model/', { format: 'obj' }));
  check(url.ok && url.geo?.numPrims === 1, 'hosts without directory support still read URLs ending in a slash');
  check(importFormatFromPath('CHARACTERS.BLEND') === 'blend', '.blend format detected case-insensitively');

  const blender = await findBlender();
  if (!blender) console.log('SKIP .blend (no Blender)');
  else {
    const blend = path.join(tmp, 'test scene.blend');
    const create = `import bpy
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.context.scene.unit_settings.scale_length = 0.5
collection = bpy.data.collections.new('village')
bpy.context.scene.collection.children.link(collection)
empty = bpy.data.objects.new('site', None)
collection.objects.link(empty)
empty.location = (2, 4, 6)
empty.rotation_euler.z = 1.5707963267948966
empty.scale = (2, 2, 2)
empty['role'] = 'site'
bpy.ops.curve.primitive_bezier_curve_add()
bpy.context.object.name = 'path_curve'
bpy.ops.mesh.primitive_cube_add()
cube = bpy.context.object
cube.name = 'cube'
cube['weight'] = 2.5
copy = cube.copy()
copy.data = cube.data
copy.name = 'linked'
copy.parent = empty
copy.location.x = 4
copy.hide_render = True
copy.hide_viewport = True
collection.objects.link(copy)
collection.hide_viewport = True
bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(blend)})
`;
    execFileSync(blender, ['-b', '--factory-startup', '--python-expr', create], { windowsHide: true, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    const digest = () => createHash('sha256').update(fs.readFileSync(blend)).digest('hex');
    const before = digest();
    let runs = 0;
    const blendHost = createNodeHost({ baseDir: tmp, workers: 0, onBlenderRun: (r) => {
      runs++; console.log(`Blender ${r.executable}: ${(r.durationMs / 1000).toFixed(3)}s`);
      for (const line of r.output.split(/\r?\n/)) if (line.startsWith('TopoTopo ')) console.log(line);
    } });
    const blendEngine = new Engine(blendHost); await blendEngine.init();
    const graph = fileGraph(blend);
    const firstBlend = await blendEngine.cook(graph);
    check(firstBlend.ok, `first .blend cook${firstBlend.ok ? '' : ': ' + firstBlend.errors.map((e) => e.message).join('; ')}`);
    if (firstBlend.geo) {
      const b = firstBlend.geo, pointNames = values(b, 'point', 'name'), primNames = values(b, 'prim', 'name');
      const site = pointNames.indexOf('site'), curve = primNames.indexOf('path_curve');
      check(site >= 0 && b.points.get('role')?.get(site) === 'site' && near(b.P.slice(site * 3, site * 3 + 3), [1, 3, -2])
        && String(b.points.get('path')?.get(site)).includes('village'), '.blend empty keeps its name, extras, collection path and metre/Y-up position');
      check(curve >= 0 && !b.primClosed[curve] && (b.primKind?.[curve] ?? 0) === 0, '.blend unbevelled Bezier curve arrives as an open polyline');
      check(b.numPacked === 2 && b.packedSources.length === 1 && primNames.includes('cube') && primNames.includes('linked'), '.blend linked duplicate (including hidden object) shares one packed source');
      const linked = primNames.indexOf('linked'), anchor = b.vertexPoint[b.primStart[linked]];
      check(linked >= 0 && near(b.P.slice(anchor * 3, anchor * 3 + 3), [1, 3, -6]), '.blend transformed parent and child retain their evaluated world matrices');
      check(b.prims.get('weight')?.get(primNames.indexOf('cube')) === 2.5 && b.prims.get('weight')?.get(primNames.indexOf('linked')) === 2.5, '.blend object custom property becomes a packed prim attribute');
      check(checkGeo(b).length === 0, '.blend geometry satisfies invariants');
    }
    const secondEngine = new Engine(blendHost); await secondEngine.init();
    const second = await secondEngine.cook(graph);
    check(second.ok && runs === 1, 'fresh engine second cook hits disk cache: no new Blender conversion process');
    fs.utimesSync(blend, new Date(), new Date(Date.now() + 2000));
    const touched = await blendEngine.cook(graph);
    check(touched.ok && runs === 2 && !touched.results.get('file')?.cached, 'touched .blend re-cooks and launches a second Blender conversion');
    check(digest() === before, 'conversion leaves source .blend bytes unchanged');
    const cachedFiles = fs.readdirSync(path.join(tmp, '.cache/blend')).filter((f) => f.endsWith('.glb'));
    check(cachedFiles.length === 2 && fs.readFileSync(path.join(tmp, '.cache/blend', cachedFiles[0])).equals(fs.readFileSync(path.join(tmp, '.cache/blend', cachedFiles[1]))), 'reconversion of identical .blend content produces byte-identical GLBs');
    const blendFolder = path.join(tmp, 'blend-folder'); fs.mkdirSync(blendFolder); fs.copyFileSync(blend, path.join(blendFolder, 'scene.blend'));
    const fromFolder = await blendEngine.cook(fileGraph('blend-folder'));
    check(fromFolder.ok && fromFolder.geo?.numPacked === 2 && values(fromFolder.geo, 'prim', 'name').includes('scene/linked'), 'folder mode converts .blend members and prefixes instance names');
    const invalid = path.join(tmp, 'invalid.blend'); fs.writeFileSync(invalid, 'not a blend file');
    const bad = await blendEngine.cook(fileGraph(invalid));
    check(!bad.ok && bad.errors.some((e) => /Blender failed \(exit code/.test(e.message) && /[Ff]ile|[Ff]ormat/.test(e.message)), 'failed Blender process reports its exit code and output tail');
    const collectionFile = path.join(tmp, 'collection.blend');
    execFileSync(blender, ['--factory-startup', '-b', '--python-expr', `import bpy
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.context.scene.unit_settings.scale_length = 0.5
collection = bpy.data.collections.new('group')
bpy.context.scene.collection.children.link(collection)
bpy.ops.mesh.primitive_cube_add(location=(10,0,0))
cube = bpy.context.object
for c in list(cube.users_collection): c.objects.unlink(cube)
collection.objects.link(cube)
instance = bpy.data.objects.new('instance', None)
instance.instance_type = 'COLLECTION'
instance.instance_collection = collection
instance.location.x = 10
bpy.context.scene.collection.objects.link(instance)
bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(collectionFile)})
`], { windowsHide: true, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    const collectionResult = await blendEngine.cook(fileGraph(collectionFile));
    check(collectionResult.ok && near(collectionResult.geo!.bbox().max, [10.5, 0.5, 0.5]), '.blend collection instances receive the scene unit scale exactly once');
    const validator: any = await import('gltf-validator');
    const validation = await validator.validateBytes(await blendHost.convertFile!(collectionFile, 'glb'), { maxIssues: 100 });
    check(validation.issues.numErrors === 0, `unit-scaled GLB validates (${validation.issues.numErrors} errors)`);
  }
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
console.log(`scene import: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
