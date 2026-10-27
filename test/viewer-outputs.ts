// Published results, persistence, export consistency, image channels and camera navigation contracts.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import * as THREE from 'three';
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { Workspace } from '../src/workspace.ts';
import type { JSONEdit } from '../src/viewer/json-edit.ts';
import { Image } from '../src/core/image.ts';
import { exportGeometry, EXPORT_FORMATS } from '../src/io/export.ts';
import { FORMAT_LABELS, publishedOutputs, resolveTarget } from '../src/io/targets.ts';
import { decodePNG } from '../src/io/png-decode.ts';
import { imagePNG } from '../src/io/textures.ts';
import { startViewer } from '../src/viewer/server.ts';
import { ArtifactStore } from '../src/host/artifacts.ts';
import { makeTools } from '../src/mcp/tools.ts';
import { createOutputs, outputZip } from '../src/viewer/outputs.ts';
import { createViews } from '../src/viewer/app/camera.js';
import * as km from '../src/viewer/app/keymap.js';
import { channelPixels, zoomImage } from '../src/viewer/app/image-view.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'topotopo-outputs-'));
const host = createNodeHost({ baseDir: tmp, workers: 0 }), engine = new Engine(host);
await engine.init();
const ws = new Workspace(path.join(tmp, 'workspace'), engine, { exports: path.join(tmp, 'exports') }); ws.load();
let checks = 0;
function check(value: unknown, label: string) { assert.ok(value, label); checks++; console.log('PASS ' + label); }
const img = new Image(2, 1, 'atlas'); img.set('C', Float32Array.from([.2, .4, .6, .25, 1, .25, 0, 0])); img.set('AO', Float32Array.from([.25, .75]));
const box = (await engine.cook({ nodes: { b: { type: 'box' }, uv: { type: 'uv_project', in: 'b' } } })).geo!;
box.volumes.push(img); fs.writeFileSync(path.join(tmp, 'asset.json'), exportGeometry(box, 'json'));
ws.setGraph('asset', { nodes: { model: { type: 'file', params: { path: 'asset.json' } }, second: { type: 'box', params: { size: '=size' } } }, output: 'model', outputs: { other: { node: 'second', label: 'Second result' } }, vars: { size: 2 } });
ws.setGraph('another', { nodes: { b: { type: 'sphere' } } });
const renamed = ws.applyEdits('asset', [{ op: 'rename', node: 'second', to: 'renamed' }]).graph;
check(renamed.outputs?.other.node === 'renamed', 'renaming maintains published outputs');
check(!ws.applyEdits('asset', [{ op: 'remove', node: 'second' }]).graph.outputs?.other, 'removing unpublishes removed node');
check(engine.validate({ nodes: { b: { type: 'box' } }, outputs: { bad: { node: 'absent' } } }).errors.length > 0, 'invalid output references rejected');
check(!!ws.mergeGraph('asset', { nodes: {}, outputs: { extra: { node: 'model' } } }).outputs?.other, 'merge retains existing publications');
// export targets in the graph (io/targets.ts)
check(engine.validate({ nodes: { b: { type: 'box' } }, export: 'fbx' }).errors.some((e) => /not one of/.test(e.message)), 'an unknown export format fails validation');
check(engine.validate({ nodes: { b: { type: 'box' } }, outputs: { o: { node: 'b', export: { format: 'glb', path: '/abs.glb' } } } }).errors.length === 1, 'a named output target outside exports/ fails validation');
check(!engine.validate({ nodes: { b: { type: 'box' } }, export: { format: 'USD', path: 'scenes/b.usda', up_axis: 'z' } }).errors.length, 'a target with a path and options validates (usd means usda)');
check(resolveTarget('unreal_landscape', 'my level').path === 'my_level' && resolveTarget('pointsjson', 'pts').path === 'pts.points.json', 'default target paths: a folder for bundles, the format extension otherwise');
const pub = publishedOutputs('g', { nodes: { b: { type: 'box' } }, export: 'glb', outputs: { part: { node: 'b', export: 'nope' } } }, 'b');
check(pub[0].target?.path === 'g.glb' && pub[1].target === null, 'published outputs carry their valid targets only');
check(ws.applyEdits('asset', [{ op: 'export', output: 'other', export: 'obj' }]).graph.outputs!.other.export === 'obj' && ws.applyEdits('asset', [{ op: 'export', export: 'glb' }]).graph.export === 'glb', 'the export op sets a named or the default target');
check(ws.applyEdits('asset', [{ op: 'export', export: 'glb' }, { op: 'export', export: null }]).graph.export === undefined, 'export null removes a target');
let unknown = ''; try { ws.applyEdits('asset', [{ op: 'export', output: 'othr', export: 'glb' }]); } catch (e) { unknown = (e as Error).message; }
check(/did you mean other/.test(unknown), 'an export op for an unknown output suggests the right one');
check(Object.keys(FORMAT_LABELS).sort().join() === [...EXPORT_FORMATS].sort().join(), 'the target formats are exactly the export formats');
let viewer = await startViewer(ws, 0);
const get = async (route: string) => { const r = await fetch(viewer.url + route); return { status: r.status, data: await r.json() as any }; };
const list = async () => (await get('api/outputs')).data.items;
async function settled() {
  for (let i = 0; i < 200; i++) { const items = await list(); if (items.filter((x: any) => x.generated).every((x: any) => x.status !== 'loading')) return items; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error('outputs did not settle');
}
const post = async (body: any) => { const r = await fetch(viewer.url + 'api/output/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, data: await r.json() as any }; };
const command = async (route: string, body: any) => { const r = await fetch(viewer.url + 'api/output/' + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, data: await r.json() as any }; };
try {
  let items = await settled();
  check(items.filter((x: any) => x.generated && x.kind === 'geometry').length === 3, 'all graphs and named outputs listed');
  fs.mkdirSync(ws.inputDir, { recursive: true });
  for (const ext of ['jpg', 'jpeg', 'webp', 'png']) {
    const bytes = ext === 'png' ? imagePNG(img) : Uint8Array.of(1, 2, 3);
    fs.writeFileSync(path.join(ws.inputDir, 'reference.' + ext), bytes);
    check((await get('api/input_info?path=reference.' + ext)).status === 200, `${ext} metadata bypasses procedural importer`);
    const raw = await fetch(viewer.url + 'api/input_image?path=reference.' + ext);
    check(raw.ok && Buffer.from(await raw.arrayBuffer()).equals(bytes), `${ext} original image bytes preserved`);
  }
  fs.writeFileSync(path.join(ws.inputDir, 'mesh.json'), exportGeometry(box, 'json'));
  const inputThumb = await fetch(viewer.url + 'api/input_thumb?path=mesh.json');
  check(inputThumb.ok && decodePNG(new Uint8Array(await inputThumb.arrayBuffer())).width === 160, 'mesh input has a rendered thumbnail');
  check((await get('api/input_image?path=../asset.json')).status === 400, 'image routes reject traversal');
  items = await settled();
  check(!items.some((x: any) => x.label.startsWith('reference.')) && items.every((x: any) => x.origin === 'published'), 'input references do not enter the outputs catalogue');
  const texture = items.find((x: any) => x.image === 'atlas'), model = items.find((x: any) => x.graph === 'asset' && x.node === 'model' && x.kind === 'geometry');
  check(texture.width === 2 && texture.layers.join() === 'C,AO', 'generated images include every named layer');
  const pixels = async (mode: string) => decodePNG(new Uint8Array(await (await fetch(viewer.url + `api/output/image?id=${texture.id}&mode=${mode}`)).arrayBuffer()));
  check((await pixels('RGB')).data[4] === 255 && (await pixels('RGB')).data[7] === 255, 'RGB preserves hidden colour and ignores packed alpha');
  check((await pixels('A')).data[0] === 64 && (await pixels('A')).data[4] === 0, 'alpha previews AO as greyscale');
  check((await get(`api/output/uv?id=${texture.id}`)).data.segments.length > 0, 'texture exposes mesh UV overlay');
  // export targets: a first export stores one in the graph, later exports write it again
  check(model.exportable && model.target === null && model.output === null, 'published outputs start without an export target');
  check((await post({ id: model.id })).status === 400, 'exporting without a target asks for one');
  const first = await post({ id: model.id, export: 'glb' });
  check(first.status === 200 && fs.existsSync(path.join(ws.exportDir, 'asset.glb')) && ws.getGraph('asset').export === 'glb', 'a first export stores its target in the graph and writes exports/<graph>.glb');
  items = await list(); const targeted = items.find((x: any) => x.id === model.id);
  // the GLB and asset.glb.source.json, the record of how it was made (io/source.ts)
  check(targeted.target?.path === 'asset.glb' && targeted.saved?.files === 2 && targeted.saved.size > 0, 'the card reads its target and its last save');
  const source = JSON.parse(fs.readFileSync(path.join(ws.exportDir, 'asset.glb.source.json'), 'utf8')).source;
  check(source.graph === 'asset' && source.output === null && source.node === targeted.node && source.frame === 1 && source.export.format === 'glb', 'a target export records its source through the shared export code');
  const again = await post({ id: model.id });
  const mainReceipts = new ArtifactStore(ws.exportDir).records().filter((a) => a.graph === 'asset' && a.output === '');
  check(again.status === 200 && !fs.readdirSync(ws.exportDir).some((f) => /^asset_\d+\.glb$/.test(f)) && mainReceipts.length === 1, 'exporting again overwrites the same file and receipt');
  check((await post({ id: model.id, export: { format: 'glb', path: '../escape.glb' } })).status === 400, 'a target cannot leave exports/');
  check((await post({ id: model.id, export: { format: 'glb', scale: -1 } })).status === 400 && (await post({ id: model.id, export: { format: 'glb', sacle: 2 } })).status === 400, 'invalid and unknown export options rejected');
  check((await post({ id: model.id, export: 'fbx' })).status === 400 && ws.getGraph('asset').export === 'glb', 'unknown formats rejected, the target unchanged');
  check((await get('api/output/file?id=../../etc/passwd')).status === 404, 'downloads require known identifiers');
  const other = items.find((x: any) => x.graph === 'asset' && x.output === 'other');
  const part = await post({ id: other.id, export: { format: 'obj', path: 'parts/nacelle.obj', up_axis: 'z' } });
  check(part.status === 200 && fs.existsSync(path.join(ws.exportDir, 'parts', 'nacelle.obj')) && (ws.getGraph('asset').outputs!.other.export as any).up_axis === 'z', 'a named output exports to its own path with its options');
  check(!texture.exportable && (await post({ id: texture.id })).status === 400, 'textures have no target of their own');
  const png = await fetch(viewer.url + `api/output/image?id=${texture.id}&mode=RGBA&download=1`);
  check(png.ok && /attachment/.test(png.headers.get('content-disposition') ?? '') && decodePNG(new Uint8Array(await png.arrayBuffer())).width === 2, 'a texture downloads as a PNG');
  const maps = await post({ id: model.id, export: { format: 'textures', path: 'maps', layers: ['*'] } });
  // two image layers and the folder's source.json
  check(maps.status === 200 && maps.data.files === 3 && fs.existsSync(path.join(ws.exportDir, 'maps', 'source.json')), 'a textures target writes every image layer into its folder');
  items = await list(); const bundle = items.find((x: any) => x.origin === 'saved' && x.label === 'maps');
  check(bundle?.files.length === 3 && items.some((x: any) => x.parent === bundle.id && x.kind === 'image'), 'bundled images individually inspectable');
  const zip = new Uint8Array(await (await fetch(viewer.url + `api/output/zip?id=${bundle.id}`)).arrayBuffer());
  const entries = unzipSync(zip); check(Object.keys(entries).length === 3 && !!entries['atlas_AO.png'] && !!entries['source.json'], 'ZIP preserves companion files');
  check((await post({ id: model.id, export: 'glb' })).status === 200, 'a target changes back');
  const zinput = [{ name: 'a/file.png', bytes: Uint8Array.from([1, 2, 3]) }];
  check(Buffer.compare(outputZip(zinput), outputZip(zinput)) === 0, 'ZIP bytes deterministic');
  const nestedDir = path.join(ws.exportDir, 'nested'), deepFile = path.join(nestedDir, 'deep', 'a.bin'), topFile = path.join(nestedDir, 'top.txt');
  fs.mkdirSync(path.dirname(deepFile), { recursive: true }); fs.writeFileSync(deepFile, 'a'); fs.writeFileSync(topFile, 'b');
  const nested = new ArtifactStore(ws.exportDir).record([deepFile, topFile], { label: 'nested' });
  const nestedZip = unzipSync(new Uint8Array(await (await fetch(viewer.url + `api/output/zip?id=file-${nested.id}`)).arrayBuffer()));
  check(Object.keys(nestedZip).sort().join() === 'deep/a.bin,top.txt', 'ZIP names are relative to the folder all files share (no ../)');
  const tools = makeTools(ws), render = tools.find((t) => t.name === 'render')!, exportTool = tools.find((t) => t.name === 'export')!;
  await render.run({ graph: 'asset', node: 'second', size: 64 });
  check(new ArtifactStore(ws.exportDir).list().some((a) => a.format === 'png'), 'MCP renders are saved and registered automatically');
  await render.run({ graph: 'asset', node: 'second', size: 64 });
  const shots = fs.readdirSync(path.join(ws.exportDir, 'renders')).filter((f) => f.startsWith('asset-second'));
  const shotReceipts = new ArtifactStore(ws.exportDir).records().filter((a) => a.files.some((p) => path.basename(p).startsWith('asset-second')));
  check(shots.join() === 'asset-second.png' && shotReceipts.length === 1, 'repeated renders overwrite one file and one receipt per graph node');
  const viaMcp = await exportTool.run({ graph: 'asset', output: 'other' });
  check(!viaMcp.isError && /nacelle\.obj/.test(viaMcp.content[0].type === 'text' ? viaMcp.content[0].text : ''), 'MCP export {output} writes the named target');
  const noTarget = await exportTool.run({ graph: 'another' });
  check(!!noTarget.isError && /no export target/.test(noTarget.content[0].type === 'text' ? noTarget.content[0].text : ''), 'MCP export without a target says how to set one');
  ws.setGraph('image_only', { nodes: { tex: { type: 'tex_noise', params: { resolution: 16 } } }, outputs: { main: { node: 'tex', label: 'Named main' } } }); ws.bump('image_only');
  ws.setGraph('packed', { nodes: { file: { type: 'file', params: { path: 'asset.json' } }, pack: { type: 'pack', in: 'file' } } }); ws.bump('packed');
  ws.setGraph('reference', { nodes: { ref: { type: 'graph_ref', params: { graph: 'asset', node: 'second' } } } }); ws.bump('reference');
  items = await settled();
  check(items.filter((x: any) => x.graph === 'image_only' && !x.parent && x.kind === 'image').length === 2, 'image-only roots open in 2D and a named main does not collide');
  check(items.some((x: any) => x.graph === 'packed' && x.image === 'atlas'), 'packed source textures are published');
  const packed = items.find((x: any) => x.graph === 'packed' && !x.parent);
  const csv = await post({ id: packed.id, export: { format: 'csv', path: 'instances.csv', pcg: true, scale: 100, meshes: true } });
  check(csv.status === 200 && csv.data.files > 2, 'packed output exports instance data with companion meshes');
  items = await list(); const csvSaved = items.find((x: any) => x.origin === 'saved' && x.label === 'instances.csv');
  const packedZip = unzipSync(new Uint8Array(await (await fetch(viewer.url + `api/output/zip?id=${csvSaved.id}`)).arrayBuffer()));
  check(!!packedZip['instances.csv'] && !!packedZip['instances.meshes.json'] && Object.keys(packedZip).some((p) => /^instances_meshes\/.*\.glb$/.test(p)), 'ZIP retains nested mesh paths alongside the stream and sidecar');
  const ref = items.find((x: any) => x.graph === 'reference');
  await ws.edit('asset', [{ op: 'vars', vars: { size: 4 } }]);
  items = await settled();
  check(items.find((x: any) => x.id === ref.id).revision !== ref.revision, 'referenced graph edits refresh dependent outputs');
  // Export all: every target, the outputs without one listed
  const everything = await command('export-all', {});
  check(everything.status === 200 && everything.data.written.length === 3 && everything.data.skipped.some((s: any) => s.graph === 'another'), 'Export all writes every target and lists the outputs without one');
  ws.setGraph('twin', { nodes: { b: { type: 'box' } }, export: { format: 'glb', path: 'asset.glb' } }); ws.bump('twin');
  const assetBytes = fs.readFileSync(path.join(ws.exportDir, 'asset.glb'));
  const conflict = await command('export-all', {});
  check(conflict.status === 409 && fs.readFileSync(path.join(ws.exportDir, 'asset.glb')).equals(assetBytes), 'two targets writing one file are refused before any write');
  ws.deleteGraph('twin'); ws.bump('twin');
  const saves: JSONEdit[][] = [], spy = await startViewer(ws, 0, { source: { graph: 'asset', label: 'asset.json', save: (edits) => { saves.push(edits); } } });
  try {
    const spyPost = (body: any) => fetch(spy.url + 'api/output/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    await spyPost({ id: model.id });
    const quiet = saves.length;
    await spyPost({ id: model.id, export: { format: 'glb', path: 'asset.glb', scale: 2 } });
    check(quiet === 0 && saves.length === 1 && saves[0][0].path.at(-1) === 'export' && (saves[0][0].value as any)?.scale === 2, 'setting a target writes it into the graph file (topotopo view); exporting alone does not');
  } finally { spy.close(); }
  const beforeFailure = fs.readFileSync(path.join(ws.exportDir, 'parts', 'nacelle.obj'));
  await ws.edit('asset', [{ op: 'set', node: 'model', params: { path: 'missing.obj' } }]);
  items = await settled();
  const failed = items.find((x: any) => x.id === model.id);
  const retained = await fetch(viewer.url + `api/output/geo?id=${model.id}`);
  check(failed.status === 'error' && retained.status === 200 && new TextDecoder().decode(new Uint8Array(await retained.arrayBuffer()).subarray(0, 4)) === 'glTF', 'failed recook retains its last valid model preview');
  const failedAll = await command('export-all', {});
  check(failedAll.status === 422 && fs.readFileSync(path.join(ws.exportDir, 'parts', 'nacelle.obj')).equals(beforeFailure), 'a cook failure stops Export all before any write');
  ws.setGraph('broken', { nodes: { b: { type: 'file', params: { path: 'missing.obj' } } } }); ws.bump('broken');
  items = await settled(); check(items.some((x: any) => x.graph === 'broken' && x.status === 'error'), 'failed output remains visible');
  fs.writeFileSync(path.join(ws.exportDir, 'agent.txt'), 'result');
  check((await list()).some((x: any) => x.label === 'agent.txt'), 'external agent-written outputs discovered');
  viewer.close(); viewer = await startViewer(new Workspace(path.join(tmp, 'other'), engine, { exports: ws.exportDir }), 0);
  check((await list()).some((x: any) => x.origin === 'saved' && x.label === 'asset.glb'), 'saved outputs survive server restart');
} finally { viewer.close(); }

const v = createViews(() => ({ center: new THREE.Vector3(), radius: 100 })); v.layout(800, 600);
const c = v.cam(1), hit = new THREE.Vector3(2, 3, 0), eye = c.eye, aim = c.target.clone();
v.anchor(1, hit); check(c.eye.distanceTo(eye) < 1e-12 && c.target.distanceTo(aim) < 1e-12, 'choosing pivot never moves camera');
const radius = c.eye.distanceTo(hit), screen = v.project(1, hit);
v.tumble(1, 70, 20, c.pivot); const after = v.project(1, hit);
check(Math.abs(c.eye.distanceTo(hit) - radius) < 1e-10 && Math.hypot(after.x - screen.x, after.y - screen.y) < 1e-8, 'orbit holds hit point stationary on screen');
const pivot = c.pivot.clone(), e0 = c.eye; v.track(1, 40, -20, c.pivot);
check(c.eye.clone().sub(e0).distanceTo(c.pivot.clone().sub(pivot)) < 1e-10, 'pan moves camera and pivot equally');
check(v.anchor(1, null).distanceTo(c.pivot) < 1e-12, 'empty space retains pivot');
const anchor = c.pivot.clone(), before = v.project(1, anchor); v.zoomAt(1, .5, anchor); const projected = v.project(1, anchor);
check(Math.hypot(before.x - projected.x, before.y - projected.y) < 1e-8, 'cursor zoom holds surface anchor on screen');
for (const r of [0.001, 1e6]) { v.frame(1, new THREE.Box3(new THREE.Vector3(-r, -r, -r), new THREE.Vector3(r, r, r))); v.zoomAt(1, 0.01, c.pivot.clone()); check(Number.isFinite(c.dist) && c.dist > 0, `navigation handles scene scale ${r}`); }
const reload = createViews(() => ({ center: new THREE.Vector3(), radius: 1 })); reload.load(v.toJSON());
check(reload.cam(1).pivot.distanceTo(c.pivot) === 0, 'camera pivot survives stored view reload');
check(km.matchDrag('topotopo', { button: 2 }) === 'tumble' && km.matchDrag('topotopo', { button: 1 }) === 'track' && km.matchDrag('topotopo', { button: 0 }) === null, 'TopoTopo mouse binds preserve selection');
check(km.matchKey('topotopo', { key: '4', code: 'Digit4' }) === 'viewRight', 'TopoTopo views need no modifiers');
check(channelPixels(Uint8ClampedArray.from([10, 20, 30, 40]), 'A').join() === '40,40,40,255', 'image alpha mode');
const z = zoomImage({ x: 20, y: 30, scale: 1 }, 70, 90, 2); check(z.x === -30 && z.y === -30 && z.scale === 2, '2D zoom preserves cursor pixel');
// The CLI keeps receipts in exports/ beside the graph only for files it writes there.
const cliDir = path.join(tmp, 'cli'), cliGraph = path.join(cliDir, 'g.json'), cliExports = path.join(cliDir, 'exports');
fs.mkdirSync(cliDir); fs.writeFileSync(cliGraph, JSON.stringify({ nodes: { b: { type: 'box' } } }));
const cli = (...args: string[]) => execFileSync(process.execPath, [fileURLToPath(new URL('../src/cli.ts', import.meta.url)), cliGraph, ...args], { stdio: 'pipe' });
cli('--render', path.join(tmp, 'elsewhere.png'));
check(!fs.existsSync(cliExports), 'a CLI render outside exports/ leaves no exports folder beside the graph');
cli('--render', path.join(cliExports, 'shot.png'));
check(new ArtifactStore(cliExports).records().some((a) => a.files.some((p) => path.basename(p) === 'shot.png')), 'a CLI render inside exports/ is registered for the viewer');
let noTargets = ''; try { cli('--export-all'); } catch (e: any) { noTargets = String(e.stderr); }
check(/no output of .* has an export target/.test(noTargets), 'CLI --export-all without targets says where to add one');
fs.writeFileSync(cliGraph, JSON.stringify({ nodes: { b: { type: 'box' }, s: { type: 'sphere' } }, output: 'b', export: 'glb', outputs: { ball: { node: 's', export: { format: 'obj', path: 'parts/ball.obj' } } } }));
cli('--export-all');
check(fs.existsSync(path.join(cliExports, 'g.glb')) && fs.existsSync(path.join(cliExports, 'parts', 'ball.obj')), 'CLI --export-all writes every target into exports/ beside the graph');
check(new ArtifactStore(cliExports).records().some((a) => a.output === 'ball' && a.graph === 'g'), 'CLI target exports are registered like the viewer\'s');

// The agent hears about new inputs: the first answer names what is there, later ones what is new, once.
const listenTools = makeTools(ws), catalog = listenTools.find((t) => t.name === 'catalog')!;
const noteOf = async () => (await catalog.run({ filter: 'shelf' })).content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
check(/inputs\/ holds \d+ file\(s\) from the person/.test(await noteOf()), 'the first answer names the files in inputs/');
check(!/inputs\/ holds|new or changed in inputs/.test(await noteOf()), 'nothing new: no note');
fs.writeFileSync(path.join(ws.inputDir, 'guides.json'), exportGeometry(box, 'json'));
const heard = await noteOf();
check(/new or changed in inputs\/ since your last call: inputs\/guides\.json/.test(heard), 'a new input is announced with its path');
check(!/new or changed in inputs/.test(await noteOf()), 'and only once');
fs.writeFileSync(path.join(ws.inputDir, 'more.json'), exportGeometry(box, 'json'));
await listenTools.find((t) => t.name === 'inputs')!.run({ action: 'list' });
check(!/new or changed in inputs/.test(await noteOf()), 'the inputs tool\'s own answer counts as hearing');

// A scan that fails (a file vanishing mid-scan) must not throw from the workspace listener; the timer shares the guard.
const broken = new Workspace(path.join(tmp, 'broken'), engine, { exports: path.join(tmp, 'broken-exports') }); broken.load();
const brokenOutputs = createOutputs(broken, () => {});
broken.listInputs = () => { throw new Error('vanished mid-scan'); };
let threw = false;
try { for (const l of broken.listeners) l({ graph: 'main', version: 1 }); } catch { threw = true; } finally { brokenOutputs.close(); }
check(!threw, 'a failing outputs scan never throws from the workspace listener or the refresh timer');

// UTF-8 text saved twice as Latin-1 ("Â·", "Ã—") showed up in the Properties panel once.
const appDir = fileURLToPath(new URL('../src/viewer/app/', import.meta.url));
const garbled = [...fs.readdirSync(appDir).map((f) => path.join(appDir, f)), fileURLToPath(new URL('../src/viewer/index.html', import.meta.url))]
  .filter((f) => /\.(js|css|html)$/.test(f) && /[ÂÃ]/.test(fs.readFileSync(f, 'utf8')));
check(!garbled.length, `viewer sources carry no double-encoded UTF-8 (${garbled.map((f) => path.basename(f)).join(', ') || 'none'})`);
console.log(`viewer outputs: ${checks} passed`);
