// Published results, persistence, export consistency, image channels and camera navigation contracts; what each
// output is and the formats that fit it (io/kinds.ts, checked against the exporters), downloads, export sidecars as
// metadata of their export in the Outputs and Inputs lists (io/sidecars.ts), the heightfield layer drawn in red.
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
import { GeoBuilder } from '../src/core/geometry.ts';
import type { Geometry } from '../src/core/geometry.ts';
import type { GraphSpec } from '../src/graph/types.ts';
import { exportGeometry, EXPORT_FORMATS } from '../src/io/export.ts';
import type { ExportFormat } from '../src/io/export.ts';
import { exportFilesAsync } from '../src/io/files.ts';
import { importGeometry } from '../src/io/import.ts';
import { fittingFormats, outputKind, sizeText } from '../src/io/kinds.ts';
import { jsonFormat, sidecarOf } from '../src/io/sidecars.ts';
import { FORMAT_LABELS, publishedOutputs, resolveTarget, targetExtension } from '../src/io/targets.ts';
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
const pub = publishedOutputs('g', { nodes: { b: { type: 'box' }, s: { type: 'sphere' } }, output: 'b', export: 'glb', outputs: { part: { node: 's', export: 'nope' } } }, 'b');
check(pub.length === 2 && pub[0].default && pub[0].output === null && pub[0].label === 'g' && pub[0].target?.path === 'g.glb' && !pub[1].default && pub[1].target === null,
  'published outputs: the default output first, named after the graph, each with its valid target only');
const one = publishedOutputs('g', { nodes: { b: { type: 'box' } }, export: 'glb', outputs: { yard: { node: 'b', label: 'Yard' }, crate: { node: 'b', export: 'obj' } } }, 'b');
check(one.length === 2 && one[0].output === 'yard' && one[0].default && one[0].label === 'Yard' && one[0].target?.path === 'g.glb' && one[1].output === 'crate' && !one[1].default && one[1].target?.path === 'crate.obj',
  'a named output that is the default output is one entry, the default, with graph.export as its target when it has none of its own');
const own = publishedOutputs('g', { nodes: { b: { type: 'box' } }, export: 'glb', outputs: { yard: { node: 'b', export: 'usda' } } }, 'b');
check(own.length === 1 && own[0].target?.path === 'yard.usda', 'its own target wins');
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
  check(items.filter((x: any) => x.generated && x.view === 'model').length === 3, 'all graphs and named outputs listed');
  check(items.filter((x: any) => x.generated && x.default).map((x: any) => `${x.graph}:${x.label}`).sort().join() === 'another:another,asset:asset', 'one default card per graph, named after it');
  // each card says what it is, decided from the cooked geometry, and offers the formats that write it
  const cards = items.filter((x: any) => x.generated && x.view === 'model');
  check(cards.every((x: any) => x.kind === 'mesh' && /^\d+ polygons, \d+ points$/.test(x.about) && x.size?.length === 3)
    && cards.every((x: any) => x.formats[0].format === 'glb' && !x.formats.some((f: any) => ['png16', 'r16', 'mask_png', 'unreal_landscape', 'csv'].includes(f.format))),
    `mesh cards say so ("${cards[0].about}") and offer mesh formats, GLB first, no heightmap`);
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
  const texture = items.find((x: any) => x.image === 'atlas'), model = items.find((x: any) => x.graph === 'asset' && x.node === 'model' && x.view === 'model');
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
  check(bundle?.files.length === 3 && items.some((x: any) => x.parent === bundle.id && x.view === 'image'), 'bundled images individually inspectable');
  check(bundle.files.find((f: any) => f.name === 'source.json')?.role === 'source' && !items.some((x: any) => x.parent === bundle.id && x.label === 'source.json')
    && bundle.view === 'image' && bundle.download.zip && bundle.download.name === 'maps.zip', 'a textures folder\'s source.json is metadata of the folder, not a card; the card is an image, downloaded as maps.zip');
  const zipped = await fetch(viewer.url + `api/output/zip?id=${bundle.id}`);
  const entries = unzipSync(new Uint8Array(await zipped.arrayBuffer()));
  check(Object.keys(entries).length === 3 && !!entries['atlas_AO.png'] && !!entries['source.json'] && /filename\*=UTF-8''maps\.zip/.test(zipped.headers.get('content-disposition') ?? ''), 'ZIP preserves companion files');
  const savedGlb = items.find((x: any) => x.origin === 'saved' && x.label === 'asset.glb');
  check(savedGlb?.view === 'model' && savedGlb.files.map((f: any) => `${f.name}:${f.role ?? 'main'}`).join() === 'asset.glb:main,asset.glb.source.json:source'
    && !savedGlb.download.zip && savedGlb.download.name === 'asset.glb' && !items.some((x: any) => x.parent === savedGlb.id),
    'a saved GLB is one card (its .source.json is its record) and downloads as the GLB, which carries the record');
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
  const imageRoots = items.filter((x: any) => x.graph === 'image_only' && !x.parent);
  check(imageRoots.length === 1 && imageRoots[0].kind === 'textures' && imageRoots[0].view === 'image' && imageRoots[0].default && imageRoots[0].label === 'Named main', 'an image-only result opens in 2D; its named output "main" is the default output, one card');
  check(items.some((x: any) => x.graph === 'packed' && x.image === 'atlas'), 'packed source textures are published');
  const packed = items.find((x: any) => x.graph === 'packed' && !x.parent);
  const csv = await post({ id: packed.id, export: { format: 'csv', path: 'instances.csv', pcg: true, scale: 100, meshes: true } });
  check(csv.status === 200 && csv.data.files > 2, 'packed output exports instance data with companion meshes');
  items = await list(); const csvSaved = items.find((x: any) => x.origin === 'saved' && x.label === 'instances.csv');
  const packedZip = unzipSync(new Uint8Array(await (await fetch(viewer.url + `api/output/zip?id=${csvSaved.id}`)).arrayBuffer()));
  check(!!packedZip['instances.csv'] && !!packedZip['instances.meshes.json'] && Object.keys(packedZip).some((p) => /^instances_meshes\/.*\.glb$/.test(p)), 'ZIP retains nested mesh paths alongside the stream and sidecar');
  check(packed.kind === 'instances' && /^\d+ instances? of 1 source$/.test(packed.about) && ['glb', 'usda', 'csv', 'pointsjson'].every((f) => packed.formats.some((x: any) => x.format === f))
    && packed.formats.find((x: any) => x.format === 'csv').writes.includes('one row per instance'), `packed instances say so ("${packed.about}") and offer instance formats`);
  check(csvSaved.files.find((f: any) => f.name === 'instances.meshes.json')?.role === 'meshes' && !items.some((x: any) => x.parent === csvSaved.id && /meshes\.json$/.test(x.label)),
    'instance rows: the .meshes.json sidecar is metadata of the stream, not a card');

  // a heightfield: what it is, the formats that write it, downloads with their sidecar, the layer drawn in red
  ws.setGraph('terrain', { nodes: {
    hf: { type: 'heightfield', params: { size: 20, resolution: 1 } },
    hills: { type: 'heightfield_noise', in: ['hf'], params: { amplitude: 2 } },
    flow: { type: 'heightfield_layer', in: ['hills'], params: { layer: 'flow', expression: 'x > 0 ? 3 : 0' } },
  }, output: 'flow' }); ws.bump('terrain');
  items = await settled();
  const field = items.find((x: any) => x.graph === 'terrain' && !x.parent);
  check(field.kind === 'terrain' && field.about === '21 × 21 samples, 1 m apart' && field.size[0] === 20 && field.heightfield.layers.some((l: any) => l.name === 'flow' && l.max === 3),
    `a heightfield card says so ("${field.about}") with its size and layers`);
  check(field.formats.map((f: any) => f.format).join() === 'png16,r16,mask_png,unreal_landscape,json' && field.formats[0].writes === '16-bit PNG + JSON sidecar with the height range and how it was made',
    `a heightfield offers the heightmap formats and no mesh format, each saying what it writes (${field.formats.map((f: any) => f.format).join(', ')})`);
  const dl = async (body: any) => {
    const r = await fetch(viewer.url + 'api/output/download', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { r, name: decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(r.headers.get('content-disposition') ?? '')?.[1] ?? ''), bytes: new Uint8Array(await r.arrayBuffer()) };
  };
  const hm = await dl({ id: field.id, export: 'png16' }), hmZip = hm.r.ok ? unzipSync(hm.bytes) : {};
  const sidecar = hmZip['terrain.json'] ? JSON.parse(new TextDecoder().decode(hmZip['terrain.json'])) : null;
  check(hm.r.ok && hm.name === 'terrain.zip' && Object.keys(hmZip).sort().join() === 'terrain.json,terrain.png' && decodePNG(hmZip['terrain.png']).width === 21
    && sidecar?.source?.graph === 'terrain' && sidecar.source.frame === 1 && sidecar.source.fps === 24 && sidecar.height_max > sidecar.height_min,
    'Download png16: terrain.zip with the 16-bit PNG and its sidecar (height range, how it was made)');
  check(!fs.existsSync(path.join(ws.exportDir, 'terrain.png')) && ws.getGraph('terrain').export === undefined, 'a download writes nothing into exports/ and sets no target');
  const glbDl = await dl({ id: model.id, export: 'glb' });
  const glbJSON = JSON.parse(new TextDecoder().decode(glbDl.bytes.subarray(20, 20 + new DataView(glbDl.bytes.buffer, glbDl.bytes.byteOffset).getUint32(12, true))));
  check(glbDl.r.ok && glbDl.name === 'asset.glb' && glbDl.r.headers.get('x-file-count') === '1' && glbJSON.asset?.extras?.source?.graph === 'asset',
    'Download glb: the one file, which carries how it was made (asset.extras.source)');
  const objDl = await dl({ id: model.id, export: { format: 'obj', up_axis: 'z' } });
  const objZip = objDl.r.ok ? unzipSync(objDl.bytes) : {};
  check(objDl.name === 'asset.zip' && Object.keys(objZip).sort().join() === 'asset.obj,asset.obj.source.json'
    && JSON.parse(new TextDecoder().decode(objZip['asset.obj.source.json'])).source.export.options.up_axis === 'z', 'Download obj: a zip of the OBJ and its .source.json, with the options given');
  check((await dl({ id: field.id, export: 'fbx' })).r.status === 400 && (await dl({ id: texture.id, export: 'png16' })).r.status === 400, 'downloads refuse unknown formats and outputs without formats of their own');
  const geoOf = async (layer?: string) => Buffer.from(await (await fetch(viewer.url + `api/output/geo?id=${field.id}${layer ? `&heightfield_layer=${layer}` : ''}`)).arrayBuffer());
  const plain = await geoOf();
  check(plain.equals(await geoOf('mask')) && !plain.equals(await geoOf('flow')) && !(await geoOf('flow')).equals(await geoOf('none')), 'the preview colours the terrain by the layer chosen (the mask by default)');
  // a heightmap saved by an agent, and files written beside the exports by hand: a sidecar is metadata of its file
  await exportTool.run({ graph: 'terrain', path: path.join(ws.exportDir, 'land.png') });
  fs.copyFileSync(path.join(ws.exportDir, 'asset.glb'), path.join(ws.exportDir, 'scan.glb'));
  fs.copyFileSync(path.join(ws.exportDir, 'asset.glb.source.json'), path.join(ws.exportDir, 'scan.glb.source.json'));
  items = await list();
  const land = items.find((x: any) => x.origin === 'saved' && x.label === 'land.png'), scan = items.find((x: any) => x.origin === 'saved' && x.label === 'scan.glb');
  check(land?.kind === 'terrain' && /^heightmap 21 × 21, 1 m · height -?[\d.]+ \.\. [\d.]+ m$/.test(land.about) && land.view === 'image'
    && land.files.map((f: any) => f.role ?? 'main').join() === 'main,heightmap' && land.download.name === 'land.zip' && !items.some((x: any) => /^land\.json/.test(x.label)),
    `a saved heightmap says what it is from its sidecar ("${land?.about}"), which is no card of its own`);
  check(scan?.files.map((f: any) => f.role ?? 'main').join() === 'main,source' && !items.some((x: any) => x.label === 'scan.glb.source.json') && scan.download.name === 'scan.glb',
    'an unregistered export and its .source.json are one card');
  // the same files dropped into inputs/: the sidecar is metadata of its heightmap, never cooked
  fs.copyFileSync(path.join(ws.exportDir, 'land.png'), path.join(ws.inputDir, 'land.png'));
  fs.copyFileSync(path.join(ws.exportDir, 'land.json'), path.join(ws.inputDir, 'land.json'));
  const inputsList = (await get('api/inputs')).data, landJSON = inputsList.find((f: any) => f.path === 'land.json');
  check(landJSON?.kind === 'metadata' && landJSON.sidecar?.role === 'heightmap' && landJSON.sidecar.of === 'land.png' && /^heightmap sidecar: height range/.test(landJSON.about)
    && inputsList.find((f: any) => f.path === 'land.png')?.kind === 'image', 'Inputs: a heightmap\'s sidecar is metadata of the PNG beside it');
  const sideInfo = await get('api/input_info?path=land.json');
  check(sideInfo.status === 200 && sideInfo.data.metadata && /heightmap sidecar of inputs\/land\.png/.test(sideInfo.data.summary)
    && (await fetch(viewer.url + 'api/input_thumb?path=land.json')).status === 400 && (await fetch(viewer.url + 'api/input?path=land.json')).status === 400,
    'Inputs: a sidecar is described, not cooked (no thumbnail, no geometry)');
  for (const f of ['land.png', 'land.json']) fs.rmSync(path.join(ws.inputDir, f));
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
  // a named output that cooks to another kind than its graph pins says so on its card (publishing would block on it)
  ws.setGraph('pinned', { nodes: { b: { type: 'box' }, c: { type: 'line' } }, output: 'b', outputs: { block: { node: 'b', kind: 'mesh' }, wire: { node: 'c', kind: 'mesh' } } }); ws.bump('pinned');
  items = await settled();
  const pinnedCard = (o: string) => items.find((x: any) => x.graph === 'pinned' && x.output === o);
  check(pinnedCard('block')?.pinned === 'mesh' && pinnedCard('block')?.warning === undefined && pinnedCard('wire')?.kind === 'curves'
    && /^output "wire": its "kind" is "mesh", and it cooks to curves \(1 curve, 2 points\): change what it cooks, or its "kind"/.test(pinnedCard('wire')?.warning ?? ''), `a pinned kind the output does not cook to warns on its card: ${pinnedCard('wire')?.warning}`);
  check(!engine.validate({ nodes: { b: { type: 'box' } }, outputs: { o: { node: 'b', kind: 'mesh', tags: ['a-b'], description: 'x' } } }).errors.length
    && engine.validate({ nodes: { b: { type: 'box' } }, outputs: { o: { node: 'b', kind: 'brick' as any } } }).errors.length === 1, 'kind, tags and description of an output validate; a kind not on the list does not');
  ws.deleteGraph('pinned'); ws.bump('pinned');
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

// What an output is and the formats that fit it (io/kinds.ts), checked against the exporters themselves: every format
// offered for an output writes some of it (its export succeeds and differs from an export of nothing).
{
  const samples: Record<string, { spec: GraphSpec; kind: string; formats: string; text?: RegExp }> = {
    mesh: { spec: { nodes: { b: { type: 'box' } } }, kind: 'mesh', formats: 'glb,gltf,usda,obj,ply,stl,geo,json', text: /^6 polygons, 8 points$/ },
    curves: { spec: { nodes: { c: { type: 'line' } } }, kind: 'curves', formats: 'glb,gltf,usda,obj,geo,json', text: /^1 curve, 2 points$/ },
    points: { spec: { nodes: { g: { type: 'grid' }, s: { type: 'scatter', in: ['g'], params: { count: 20 } } }, output: 's' }, kind: 'points', formats: 'csv,pointsjson,ply,geo,glb,gltf,usda,json', text: /^20 points$/ },
    instances: { spec: { nodes: { g: { type: 'grid' }, s: { type: 'scatter', in: ['g'], params: { count: 5 } }, b: { type: 'box' }, c: { type: 'copy_to_points', in: ['b', 's'], params: { pack: true } } }, output: 'c' },
      kind: 'instances', formats: 'glb,usda,csv,pointsjson,gltf,geo,obj,ply,stl,json', text: /^5 instances of 1 source$/ },
    heightfield: { spec: { nodes: { hf: { type: 'heightfield', params: { size: 8, resolution: 1 } }, n: { type: 'heightfield_noise', in: ['hf'] } }, output: 'n' },
      kind: 'heightfield', formats: 'png16,r16,mask_png,unreal_landscape,json', text: /^9 × 9 samples, 1 m apart$/ },
    scene: { spec: { nodes: { hf: { type: 'heightfield', params: { size: 8, resolution: 1 } }, g: { type: 'grid' }, s: { type: 'scatter', in: ['g'], params: { count: 5 } }, b: { type: 'box' },
      c: { type: 'copy_to_points', in: ['b', 's'], params: { pack: true } }, m: { type: 'merge', in: ['hf', 'c'] } }, output: 'm' },
      kind: 'mixed', formats: 'unreal_landscape,png16,r16,mask_png,glb,usda,csv,pointsjson,gltf,geo,obj,ply,stl,json', text: /^terrain 9 × 9, 1 m \+ 5 instances of 1 source$/ },
    image: { spec: { nodes: { t: { type: 'tex_noise', params: { resolution: 8 } } } }, kind: 'image', formats: 'textures,json', text: /^8 × 8 px$/ },
    textured: { spec: { nodes: { b: { type: 'box' }, t: { type: 'tex_noise', params: { resolution: 8 } }, m: { type: 'merge', in: ['b', 't'] } }, output: 'm' }, kind: 'mesh', formats: 'glb,gltf,usda,obj,ply,stl,geo,textures,json' },
    grid: { spec: { nodes: { s: { type: 'sdf_shape' }, g: { type: 'sdf_grid', in: ['s'] } }, output: 'g' }, kind: 'volume', formats: 'json' },
    sdf: { spec: { nodes: { s: { type: 'sdf_shape' } } }, kind: 'volume', formats: '' },
    empty: { spec: { nodes: { b: { type: 'box' }, d: { type: 'delete', in: ['b'], params: { group: '*' } } }, output: 'd' }, kind: 'empty', formats: '' },
  };
  const nothing = new GeoBuilder().build(), bytesOf = (files: { path: string; bytes: Uint8Array }[]) => Buffer.concat(files.map((f) => Buffer.from(f.bytes)));
  const exportsOf = async (g: Geometry, format: ExportFormat) => { try { return bytesOf((await exportFilesAsync(g, format, `out/x${targetExtension(format) || ''}`)).files); } catch { return null; } };
  for (const [name, s] of Object.entries(samples)) {
    const r = await engine.cook(s.spec);
    if (!r.ok) { check(false, `${name}: the sample cooks (${r.errors.map((e) => e.message).join('; ')})`); continue; }
    const info = outputKind(r.geo!), fits = fittingFormats(info);
    const words: Record<string, string | null> = { heightfield: 'terrain', image: 'textures', mixed: 'scene', empty: null }, word = s.kind in words ? words[s.kind] : s.kind;
    check(info.kind === s.kind && info.published === word && (!s.text || s.text.test(info.text)) && fits.map((f) => f.format).join() === s.formats, `${name}: ${info.published} (${info.kind}) "${info.text}" → ${fits.map((f) => f.format).join(', ') || 'no format'}`);
    const silent: string[] = [];
    for (const f of fits) {
      const out = await exportsOf(r.geo!, f.format), none = await exportsOf(nothing, f.format);
      if (!out || (none && out.equals(none))) silent.push(f.format);
    }
    check(!silent.length, `${name}: every format offered writes some of it${silent.length ? ` (not: ${silent.join(', ')})` : ''}`);
  }
  const big = await engine.cook({ nodes: { hf: { type: 'heightfield', params: { size: 4096, resolution: 2 } } } });
  check(outputKind(big.geo!).published === 'terrain' && outputKind(big.geo!).text === '2049 × 2049 samples, 2 m apart' && sizeText(outputKind(big.geo!).size!) === '4096 × 0 × 4096 m', 'a 4 km field at 2 m is a terrain of "2049 × 2049 samples, 2 m apart"');
  const scene = fittingFormats(outputKind((await engine.cook(samples.scene.spec)).geo!));
  check(scene[0].leaves.length === 0 && scene.find((f) => f.format === 'glb')!.leaves.join() === 'heightfield' && scene.find((f) => f.format === 'png16')!.leaves.join() === 'instances'
    && scene.find((f) => f.format === 'glb')!.oneFile && !scene.find((f) => f.format === 'png16')!.oneFile, 'mixed: each format says what it leaves out; GLB downloads as one file, the heightmap as a zip');
  // sidecars (io/sidecars.ts): by the format they declare first, and the file beside them
  const there = new Set(['t/terrain.png', 'h.r16', 'a.glb', 'maps', 'i.csv', 'level', 'rock.png']), at = (p: string) => there.has(p);
  check(jsonFormat('{\n  "format": "png16",\n  "layer": "height"') === 'png16' && jsonFormat('{"version": 1, "format": "x"}') === null && jsonFormat('[1, 2]') === null, 'jsonFormat reads the format a JSON declares first');
  check(JSON.stringify([sidecarOf('t/terrain.json', 'png16', at), sidecarOf('h.json', 'r16', at), sidecarOf('a.glb.source.json', 'topotopo-export-source', at), sidecarOf('maps/source.json', 'topotopo-export-source', at),
    sidecarOf('i.meshes.json', 'topotopo-instance-meshes', at), sidecarOf('level/landscape.json', 'topotopo-unreal-landscape', at), sidecarOf('lost.json', 'png16', at)])
    === JSON.stringify([{ role: 'heightmap', of: 't/terrain.png' }, { role: 'heightmap', of: 'h.r16' }, { role: 'source', of: 'a.glb' }, { role: 'source', of: 'maps' },
      { role: 'meshes', of: 'i.csv' }, { role: 'landscape', of: 'level' }, { role: 'heightmap', of: null }]), 'sidecarOf: each sidecar and the file it describes (null when that is not there)');
  check(sidecarOf('rock.json', 'topotopo-geo', at) === null && sidecarOf('rock.json', null, at) === null && sidecarOf('rock.png', 'png16', at) === null, 'a geometry JSON (or no JSON) is not a sidecar');
  let readSidecar = '';
  try { importGeometry(new TextEncoder().encode(JSON.stringify({ format: 'png16', layer: 'height', height_min: 0, height_max: 1 })), 'json'); } catch (e) { readSidecar = (e as Error).message; }
  check(/an export's heightmap sidecar .*not geometry: read the heightmap PNG beside it with heightfield_from_image/.test(readSidecar), 'a file node reading a sidecar says what it is and what to read instead');
}

// The agent hears about new inputs: the first answer names what is there, later ones what is new, once.
const listenTools = makeTools(ws), catalog = listenTools.find((t) => t.name === 'catalog')!;
const noteOf = async () => (await catalog.run({ search: 'box' })).content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
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
