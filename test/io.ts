// Export → import round trips for the mesh formats (glTF, .geo, CSV and points JSON details: test/interop.ts), tiled
// Landscape bundles, and export sources (io/source.ts: the record of how an export was made) with var overrides.
//   node test/io.ts
import '../src/nodes/index.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { exportGeometry, exportGeometryAsync } from '../src/io/export.ts';
import { importGeometryAsync } from '../src/io/import.ts';
import { topologyReport } from '../src/core/topology.ts';
import { Geometry } from '../src/core/geometry.ts';
import { Heightfield, heightfieldsOf } from '../src/core/heightfield.ts';
import { Image } from '../src/core/image.ts';
import { m4identity } from '../src/core/math.ts';
import { packedFromMatrices } from '../src/core/packed.ts';
import { sha256Hex } from '../src/core/sha256.ts';
import { exportFilesAsync } from '../src/io/files.ts';
import { unrealLandscapeBundle } from '../src/io/unreal.ts';
import { heightmapExport } from '../src/io/heightmap.ts';
import { glbSceneReport, sceneReportText } from '../src/io/inspect-scene.ts';
import { decodePNG } from '../src/io/png-decode.ts';
import { importCSV } from '../src/io/points.ts';
import { canonicalJSON, exportSource, graphSha256 } from '../src/io/source.ts';
import { publishedOutputs } from '../src/io/targets.ts';
import { parseVarArg, parseVarValue, withVars } from '../src/graph/vars.ts';
import type { GraphSpec } from '../src/graph/types.ts';
import { prepareTarget, writeTargets } from '../src/host/export-targets.ts';
import { ArtifactStore } from '../src/host/artifacts.ts';
import { TOPOTOPO_VERSION } from '../src/host/version.ts';

const engine = new Engine(createNodeHost());
await engine.init();
const r = await engine.cook({
  nodes: {
    b: { type: 'box', params: { divisions: [2, 2, 2] } },
    c: { type: 'color', in: ['b'], params: { mode: 'random', class: 'point' } },
    s: { type: 'attrib_randomize', in: ['c'], params: { name: 'heat' } },
  },
});
const g = r.geo!;
let fail = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) fail++; };
for (const fmt of ['json', 'obj', 'ply', 'glb', 'stl', 'geo'] as const) {
  const bytes = await exportGeometryAsync(g, fmt, { custom: true });
  const back = await importGeometryAsync(bytes, fmt);
  const rep = topologyReport(back);
  const sameArea = Math.abs(rep.polys - (fmt === 'glb' || fmt === 'stl' ? g.numPrims * 2 : g.numPrims)) === 0;
  check(sameArea && back.numPoints > 0, `${fmt}: ${bytes.byteLength} bytes → ${back.numPoints} pts ${back.numPrims} prims, closed=${rep.closed} (src ${g.numPoints}/${g.numPrims})`);
  if (fmt === 'json') check(back.points.has('heat') && back.points.has('Cd'), 'json keeps custom + Cd attributes');
  if (fmt === 'ply') check(back.points.has('heat') && back.points.has('Cd'), 'ply keeps custom + Cd attributes');
  if (fmt === 'glb') check(back.points.has('heat') && back.points.has('Cd'), 'glb keeps custom + Cd attributes');
  if (fmt === 'geo') check(back.points.has('heat') && back.points.has('Cd') && back.numVertices === g.numVertices, 'geo keeps custom + Cd attributes and vertices');
  if (fmt === 'obj' || fmt === 'stl' || fmt === 'json' || fmt === 'ply' || fmt === 'geo') check(rep.closed, `${fmt}: watertight after round trip`);
}
const usd = new TextDecoder().decode(exportGeometry(g, 'usda'));
check(usd.startsWith('#usda 1.0') && usd.includes('def Mesh') && usd.includes('faceVertexCounts'), 'usda structure');

// Tiled Landscape bundles: test a non-square source that needs padding in both dimensions. A nonzero origin and
// half-metre cells catch tile/sample/world-coordinate mix-ups; a non-unit layer catches per-tile normalisation.
const hf = new Heightfield(12, 10, 0.5, [-2, 3]);
hf.layers.set('height', Float32Array.from({ length: hf.count }, (_, k) => -3 + (k % hf.width) * 0.75 + Math.floor(k / hf.width) * 1.5 + (k % hf.width) * Math.floor(k / hf.width) / 32));
hf.layers.set('grass', Float32Array.from({ length: hf.count }, (_, k) => (k % hf.width) / (hf.width - 1)));
hf.layers.set('soil depth', Float32Array.from({ length: hf.count }, (_, k) => 2 + 2 * (k % hf.width) + Math.floor(k / hf.width) / 4));
const anchors = [[1, 1], [7, 1], [1, 7], [7, 7], [11, 9], [14, 14], [-1, -1], [15, 15], [6.99999999, 7]];
const packed = packedFromMatrices(g, anchors.map(([x, z]) => {
  const m = m4identity();
  m[12] = hf.x(x); m[13] = 2; m[14] = hf.z(z);
  return m;
}));
const ids = packed.points.add('id', 'int', 1);
anchors.forEach((_, i) => ids.set(i, i));
const labels = anchors.map((_, i) => i === 3 ? 'first line\nsecond line, "quoted"' : i === 6 ? 'outside\r\nanchor' : `anchor ${i}`);
const labelAttribute = packed.points.add('label', 'string', 1);
labels.forEach((label, i) => labelAttribute.set(i, label));
const terrain = new Geometry();
terrain.volumes = [hf];
const scene = Geometry.merge([terrain, packed]);
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((v, i) => v === b[i]);
const baseline = await unrealLandscapeBundle(scene);
const zero = await unrealLandscapeBundle(scene, { tile_size: 0 });
check(baseline.files.length === zero.files.length && baseline.files.every((f, i) => f.path === zero.files[i].path && same(f.bytes, zero.files[i].bytes)), 'tiled export: tile_size 0 is byte-identical to the default single bundle');
check(baseline.manifest.version === 1 && !('tiles' in zero.manifest), 'tiled export: tile_size 0 retains the version-1 manifest');
const bundle = await unrealLandscapeBundle(scene, { tile_size: 7 });
const man = bundle.manifest, tileList = man.tiles as Record<string, any>[];
const files = new Map(bundle.files.map((f) => [f.path, f.bytes]));
check(man.version === 2 && tileList.length === 4 && same(man.tile_grid.grid, [2, 2]) && man.tile_grid.tile_size_quads === 7,
  'tiled export: version-2 manifest describes a 2×2 grid of seven-quad tiles');
check(same(man.tile_grid.source_resolution, [12, 10]) && same(man.tile_grid.padded_resolution, [15, 15]) && man.tile_grid.padding.right === 3 && man.tile_grid.padding.bottom === 5 && man.tile_grid.padding.mode === 'edge',
  'tiled export: non-square source records exact right/bottom edge padding');
check(same(man.landscape.overall_resolution, [15, 15]) && man.landscape.exact_fit,
  'tiled export: global Landscape layout fits the padded sample grid exactly');
check(same(files.get('instances.csv')!, baseline.files.find((f) => f.path === 'instances.csv')!.bytes)
  && bundle.files.filter((f) => /meshes\.json$/.test(f.path)).length === 1 && !bundle.files.some((f) => /^tiles\/.*\.glb$/.test(f.path)),
  'tiled export: preserves the global stream and shares one mesh sidecar and source meshes');
const heightReference = decodePNG(heightmapExport(scene, 'png16').files[0].bytes).data;
const layerReferences = new Map(baseline.manifest.layers.map((layer: Record<string, any>) => [layer.name, decodePNG(baseline.files.find((f) => f.path === layer.file)!.bytes).data]));
const tileImages = new Map<string, Uint16Array>();
const tileLayers = new Map<string, Map<string, Uint16Array>>();
const allIds: number[] = [];
let metadataOK = true, samplesOK = true, weightsOK = true, splitOK = true, roundtripOK = true;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'topotopo-io-tiles-'));
try {
  for (const tile of tileList) {
    const [x, y] = tile.grid_position as [number, number], prefix = `tiles/${x}_${y}`;
    const h = tile.heightmap;
    const side = JSON.parse(text(files.get(h.sidecar)!));
    const image = decodePNG(files.get(h.file)!);
    const localLayers = new Map<string, Uint16Array>();
    tileImages.set(`${x}_${y}`, image.data);
    tileLayers.set(`${x}_${y}`, localLayers);
    metadataOK &&= h.file === `${prefix}/heightmap.png` && h.sidecar === `${prefix}/heightmap.json`
      && same(tile.sample_min, [x * 7, y * 7]) && same(tile.sample_max, [(x + 1) * 7, (y + 1) * 7])
      && same(tile.world_offset_cm, [x * 350, y * 350, 0]) && same(h.resolution, [8, 8])
      && image.width === 8 && image.height === 8 && image.bitDepth === 16
      && h.height_min_m === man.heightmap.height_min_m && h.height_max_m === man.heightmap.height_max_m
      && side.height_min === h.height_min_m && side.height_max === h.height_max_m
      && same(side.origin, [hf.x(x * 7), hf.z(y * 7)]) && side.cell_size === hf.cellSize
      && man.landscape.section_size_quads === 7 && man.landscape.sections_per_component === 1 && same(man.tile_grid.tile_components, [1, 1]);
    for (const layer of tile.layers) {
      localLayers.set(layer.name, decodePNG(files.get(layer.file)!).data);
      metadataOK &&= layer.file.startsWith(`${prefix}/layers/`);
    }
    for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) {
      const sourceIndex = Math.min(y * 7 + j, hf.height - 1) * hf.width + Math.min(x * 7 + i, hf.width - 1);
      samplesOK &&= image.data[j * 8 + i] === heightReference[sourceIndex];
      for (const [name, values] of localLayers) weightsOK &&= values[j * 8 + i] === (layerReferences.get(name) as Uint16Array)[sourceIndex];
    }
    const csv = text(files.get(tile.instances.csv)!);
    const rows = importCSV(csv);
    const rowIds = Array.from({ length: rows.numPoints }, (_, i) => rows.points.get('id')!.get(i) as number);
    allIds.push(...rowIds);
    const expectedIds = anchors.flatMap(([ax, ay], i) => Math.min(1, Math.max(0, Math.floor(ax / 7))) === x && Math.min(1, Math.max(0, Math.floor(ay / 7))) === y ? [i] : []);
    splitOK &&= tile.instances.csv === `${prefix}/instances.csv` && tile.instances.meshes === 'instances.meshes.json'
      && tile.instances.count === rows.numPoints && same(rowIds, expectedIds);
    splitOK &&= rowIds.every((id, i) => rows.points.get('label')!.get(i) === labels[id]);
    // A tile CSV is a literal subset of the global rows, preserving seeds, attributes and transforms.
    const globalLines = new Set(text(files.get('instances.csv')!).trim().split('\n'));
    splitOK &&= csv.trim().split('\n').every((line) => globalLines.has(line));
    const file = path.join(tmp, `${x}_${y}.png`);
    fs.writeFileSync(file, files.get(h.file)!);
    const back = await engine.cook({ nodes: { tile: { type: 'heightfield_from_image', params: {
      path: file, resolution: side.cell_size, height_min: side.height_min, height_max: side.height_max,
      center: [side.origin[0] + side.size[0] / 2, 0, side.origin[1] + side.size[1] / 2],
    } } } });
    const imported = back.geo && heightfieldsOf(back.geo)[0];
    roundtripOK &&= back.ok && !!imported && imported.width === 8 && imported.height === 8 && same(imported.origin, side.origin);
    if (imported) for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) {
      const original = hf.layer('height')![Math.min(y * 7 + j, hf.height - 1) * hf.width + Math.min(x * 7 + i, hf.width - 1)];
      roundtripOK &&= Math.abs(imported.layer('height')![j * 8 + i] - original) <= (side.height_max - side.height_min) / 65535 + 1e-5;
    }
  }
} finally {
  // mkdtemp returns the exact owned directory; no computed parent path is removed.
  fs.rmSync(tmp, { recursive: true, force: true });
}
check(metadataOK, 'tiled export: tile file paths, inclusive ranges, offsets, shared height range, sidecars and component settings agree');
check(samplesOK, 'tiled export: all tile samples equal the globally quantised source, with repeated edge padding');
check(weightsOK, 'tiled export: unit and non-unit weight layers use global ranges, including padded samples');
check(splitOK && allIds.length === anchors.length && new Set(allIds).size === anchors.length && man.instances.count === anchors.length,
  'tiled export: instance split sums to the global count, with exact-once half-open seam ownership and clamped outside anchors');
check(roundtripOK, 'tiled export: every tile round-trips through heightfield_from_image within one quantisation step');
let seamsOK = true;
for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
  const samples = [tileImages.get(`${x}_${y}`)!, ...tileLayers.get(`${x}_${y}`)!.values()];
  if (x < 1) {
    const right = [tileImages.get(`${x + 1}_${y}`)!, ...tileLayers.get(`${x + 1}_${y}`)!.values()];
    for (let l = 0; l < samples.length; l++) for (let i = 0; i < 8; i++) seamsOK &&= samples[l][i * 8 + 7] === right[l][i * 8];
  }
  if (y < 1) {
    const bottom = [tileImages.get(`${x}_${y + 1}`)!, ...tileLayers.get(`${x}_${y + 1}`)!.values()];
    for (let l = 0; l < samples.length; l++) for (let i = 0; i < 8; i++) seamsOK &&= samples[l][7 * 8 + i] === bottom[l][i];
  }
}
check(seamsOK, 'tiled export: all horizontal and vertical height/weight seams share bit-identical samples');
const viaFiles = await exportFilesAsync(terrain, 'unreal_landscape', 'bundle/tiled.json', { tile_size: 7 });
const viaManifest = JSON.parse(text(viaFiles.files.find((f) => f.path === 'bundle/tiled.json')!.bytes));
check(viaManifest.tiles.length === 4 && viaManifest.tiles.every((t: Record<string, any>) => t.instances === null)
  && viaFiles.files.some((f) => f.path === 'bundle/tiles/1_1/heightmap.png'),
  'tiled export: file dispatcher forwards tile_size and custom manifest names, including terrain-only bundles');
{
  const only = await unrealLandscapeBundle(terrain, { layers: ['grass'] });
  const weight = only.files.filter((f) => f.path.startsWith('layers/')).map((f) => f.path);
  check(weight.length === 1 && weight[0] === 'layers/grass.png' && JSON.parse(text(only.files.find((f) => f.path === 'landscape.json')!.bytes)).layers.length === 1, `unreal_landscape layers option keeps only the named weight maps (${weight.join(', ')})`);
  let unknown = '';
  try { await unrealLandscapeBundle(terrain, { layers: ['nope'] }); } catch (e: any) { unknown = e.message; }
  check(/layer "nope" not found/.test(unknown), 'unreal_landscape rejects an unknown layer name');
}
const repeated = await unrealLandscapeBundle(scene, { tile_size: 7 });
check(bundle.files.length === repeated.files.length && bundle.files.every((f, i) => f.path === repeated.files[i].path && same(f.bytes, repeated.files[i].bytes)),
  'tiled export: repeated exports are byte-identical');
const sparse = packedFromMatrices(g, [m4identity()]);
sparse.volumes = [hf];
const sparseBundle = await unrealLandscapeBundle(sparse, { tile_size: 7, heightMin: -10, heightMax: 40 });
check(same(sparseBundle.manifest.tiles.map((tile: Record<string, any>) => tile.instances.count), [1, 0, 0, 0])
  && sparseBundle.manifest.tiles.every((tile: Record<string, any>) => importCSV(text(sparseBundle.files.find((f) => f.path === tile.instances.csv)!.bytes)).numPoints === tile.instances.count),
  'tiled export: empty tiles keep valid header-only CSVs with zero counts');
check(sparseBundle.manifest.tiles.every((tile: Record<string, any>) => tile.heightmap.height_min_m === -10 && tile.heightmap.height_max_m === 40),
  'tiled export: explicit height range is shared by every tile');
for (const tileSize of [-7, 7.5, NaN, 8]) {
  let rejected = false;
  try { await unrealLandscapeBundle(terrain, { tile_size: tileSize }); } catch (error) { rejected = /tile_size/.test(String(error)); }
  check(rejected, `tiled export: rejects invalid/non-fitting tile_size ${tileSize}`);
}

// ---------------------------------------------------------------- export sources (io/source.ts) and var overrides
{
  const nodeSha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
  let shaOK = true;
  for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 1000, 70000]) {
    const b = Uint8Array.from({ length: n }, (_, i) => (i * 131 + 7) & 255);
    shaOK &&= sha256Hex(b) === nodeSha(b);
  }
  check(shaOK && sha256Hex('héllo ✓') === nodeSha('héllo ✓'), 'sha256 (pure TypeScript) matches node:crypto across block boundaries and for UTF-8 text');
  check(canonicalJSON({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null, u: undefined } }) === '{"a":{"c":null,"d":[1,{"x":1,"y":2}]},"b":1}', 'canonicalJSON sorts keys at every level and drops undefined');

  const spec: GraphSpec = {
    nodes: {
      hills: { type: 'heightfield_noise', params: { seed: '=seed', amplitude: '=relief' } },
      loop: { type: 'foreach', params: { body: { nodes: { pts: { type: 'scatter', params: { Seed: 4 } } } } } },
      box: { type: 'box' },
    },
    vars: { seed: 3, relief: 6 },
  };
  const src = exportSource({ graph: 'terrain', spec, node: 'hills', format: 'glb', options: { up_axis: 'z', scale: undefined }, version: '9.9.9' });
  check(JSON.stringify(Object.keys(src)) === JSON.stringify(['graph', 'graph_sha256', 'output', 'node', 'frame', 'fps', 'vars', 'seeds', 'export', 'topotopo']), 'source block: fields in a fixed order');
  check(src.output === null && src.frame === 1 && src.fps === 24 && JSON.stringify(src.vars) === '{"relief":6,"seed":3}' && JSON.stringify(src.seeds) === '{"hills":"=seed","loop/pts":4}'
    && JSON.stringify(src.export) === '{"format":"glb","options":{"up_axis":"z"}}' && src.topotopo === '9.9.9',
    `source block: the engine's time defaults, sorted vars, seeds by node path as written (nested bodies too), the options given (${JSON.stringify(src)})`);
  const reordered: GraphSpec = { vars: { relief: 6, seed: 3 }, nodes: { box: { type: 'box' }, loop: spec.nodes.loop, hills: { type: 'heightfield_noise', params: { amplitude: '=relief', seed: '=seed' } } } };
  check(src.graph_sha256 === nodeSha(canonicalJSON({ version: 1, ...spec })) && graphSha256(reordered) === src.graph_sha256,
    'graph_sha256: SHA-256 of the canonical, version-stamped graph JSON; key order does not change it');

  // --var values and overrides (src/graph/vars.ts)
  const throws = (f: () => unknown, re: RegExp) => { try { f(); return false; } catch (e) { return re.test((e as Error).message); } };
  check(parseVarValue('8') === 8 && parseVarValue('-0.5') === -0.5 && parseVarValue('.5') === 0.5 && parseVarValue('1e3') === 1000
    && parseVarValue('true') === true && parseVarValue('false') === false && parseVarValue('null') === null
    && JSON.stringify(parseVarValue('[1, 2]')) === '[1,2]' && JSON.stringify(parseVarValue('{"a": 1}')) === '{"a":1}'
    && parseVarValue('"8"') === '8' && parseVarValue('ridged') === 'ridged' && parseVarValue('') === '', 'var values: numbers, booleans, JSON, other text as a string');
  check(throws(() => parseVarValue('[1, 2'), /not valid JSON/) && throws(() => parseVarArg('relief'), /name=value/) && throws(() => parseVarArg('=3'), /name=value/)
    && JSON.stringify(parseVarArg('label=a=b')) === '["label","a=b"]', 'var arguments: malformed values and missing names fail; a value may contain "="');
  const tuned = withVars(spec, [['relief', 9]]);
  check(tuned.vars!.relief === 9 && tuned.vars!.seed === 3 && spec.vars!.relief === 6 && withVars(spec, []) === spec, 'withVars sets vars on a copy of the graph');
  check(throws(() => withVars(spec, [['relif', 1]]), /unknown var "relif" \(did you mean relief\?\); the graph's vars: seed, relief/)
    && throws(() => withVars({ nodes: {} }, [['x', 1]]), /the graph has no vars/) && withVars({ nodes: {}, params: { k: { type: 'float' } } }, [['k', 2]]).vars!.k === 2,
    'withVars: an unknown var names the known ones; a var declared in params counts');
  check(exportSource({ graph: 'terrain', spec: tuned, node: 'hills', format: 'glb', version: '9.9.9' }).graph_sha256 !== src.graph_sha256, 'graph_sha256 changes with a var value');

  // where each format records it (io/files.ts)
  const s = (format: string) => exportSource({ graph: 'g', spec: { nodes: { b: { type: 'box' } }, vars: { k: 1 } }, node: 'b', format, version: '9.9.9' });
  const json = (b: Uint8Array) => JSON.parse(text(b));
  const glbJSON = (b: Uint8Array) => json(b.subarray(20, 20 + new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(12, true)));
  const glbA = await exportFilesAsync(g, 'glb', 'out/b.glb', { source: s('glb') });
  const glbB = await exportFilesAsync(g, 'glb', 'out/b.glb', { source: s('glb') });
  const manifest = json(glbA.files[1].bytes);
  check(glbA.files.map((f) => f.path).join() === 'out/b.glb,out/b.glb.source.json' && glbA.sourceFile === 'out/b.glb.source.json' && glbA.sourceManifest === glbA.sourceFile
    && manifest.format === 'topotopo-export-source' && manifest.version === 1 && JSON.stringify(manifest.files) === '["b.glb"]' && JSON.stringify(manifest.source) === JSON.stringify(s('glb')),
    'glb: <file>.source.json next to it names the file and holds the source block');
  check(glbA.files.length === glbB.files.length && glbA.files.every((f, i) => same(f.bytes, glbB.files[i].bytes)), 'the same export with the same source is byte-identical, manifest included');
  const asset = glbJSON(glbA.files[0].bytes).asset;
  const validation = await createRequire(import.meta.url)('gltf-validator').validateBytes(glbA.files[0].bytes, { maxIssues: 20, writeTimestamp: false });
  check(JSON.stringify(asset.extras?.source) === JSON.stringify(s('glb')) && asset.generator === 'topotopo' && validation.issues.numErrors === 0,
    `glb: asset.extras.source holds the same block; the glTF validator reports ${validation.issues.numErrors} errors`);
  const unrecorded = await exportFilesAsync(g, 'glb', 'out/b.glb', {});
  check(unrecorded.files.length === 1 && !('extras' in glbJSON(unrecorded.files[0].bytes).asset) && unrecorded.sourceFile === undefined, 'without a source an export writes no record');
  const gltf = await exportFilesAsync(g, 'gltf', 'out/b.gltf', { source: s('gltf') });
  check(JSON.stringify(json(gltf.files[0].bytes).asset.extras.source) === JSON.stringify(s('gltf')) && gltf.files[1].path === 'out/b.gltf.source.json', 'gltf: asset.extras.source and the manifest');
  const hm = await exportFilesAsync(terrain, 'png16', 'out/h.png', { source: s('png16') });
  const hmPlain = await exportFilesAsync(terrain, 'png16', 'out/h.png', {});
  check(hm.files.map((f) => f.path).join() === 'out/h.png,out/h.json' && hm.sourceFile === 'out/h.json' && hm.sourceManifest === undefined
    && JSON.stringify(json(hm.files[1].bytes).source) === JSON.stringify(s('png16')) && !('source' in json(hmPlain.files[1].bytes)) && same(hm.files[0].bytes, hmPlain.files[0].bytes),
    'png16: the .json sidecar records the source, no extra manifest; the heightmap itself is unchanged');
  const rows = await exportFilesAsync(scene, 'csv', 'out/i.csv', { pcg: true, source: s('csv'), warn: () => {} });
  check(rows.sourceFile === 'out/i.meshes.json' && !rows.files.some((f) => f.path.endsWith('.source.json')) && json(rows.files.find((f) => f.path === 'out/i.meshes.json')!.bytes).source.export.format === 'csv',
    'csv instance rows: <name>.meshes.json records the source');
  const points = await exportFilesAsync(g, 'csv', 'out/p.csv', { source: s('csv') });
  check(points.files.map((f) => f.path).join() === 'out/p.csv,out/p.csv.source.json', 'csv without instances: the manifest next to it');
  const level = await exportFilesAsync(scene, 'unreal_landscape', 'out/level', { source: s('unreal_landscape'), warn: () => {} });
  check(level.sourceFile === 'out/level/landscape.json' && json(level.files.find((f) => f.path === 'out/level/landscape.json')!.bytes).source.graph === 'g'
    && !('source' in json(level.files.find((f) => f.path === 'out/level/heightmap.json')!.bytes)) && !level.files.some((f) => f.path.endsWith('.source.json')),
    'unreal_landscape: landscape.json records the source (the bundle\'s heightmap.json does not repeat it)');
  const masks = await exportFilesAsync(terrain, 'mask_png', 'out/w.png', { layers: ['grass', 'soil depth'], source: s('mask_png') });
  check(JSON.stringify(json(masks.files.find((f) => f.path === 'out/w.png.source.json')!.bytes).files) === '["w_grass.png","w_soil_depth.png"]', 'mask_png: the manifest names every layer file');
  const images = new Geometry();
  images.volumes.push(new Image(2, 2, 'atlas').set('C', new Float32Array(4).fill(0.5)));
  const maps = await exportFilesAsync(images, 'textures', 'out/maps', { source: s('textures') });
  check(maps.sourceFile === 'out/maps/source.json' && JSON.stringify(json(maps.files[maps.files.length - 1].bytes).files) === '["atlas.png"]', 'textures: source.json inside the folder');

  // an export target (the viewer's Export button, MCP export {output}, CLI --export-all) builds its own from the graph
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topotopo-io-targets-'));
  try {
    const gs: GraphSpec = { nodes: { b: { type: 'box' } }, vars: { k: 1 }, outputs: { part: { node: 'b', export: { format: 'obj', path: 'parts/b.obj', up_axis: 'z' } } } };
    const part = publishedOutputs('g', gs, 'b')[1];
    const prepared = await prepareTarget(g, 'g', part as typeof part & { target: NonNullable<typeof part.target> }, dir, engine.host, { frame: 5 });
    const man = json(prepared.files.find((f) => f.path === prepared.sourceManifest)!.bytes).source;
    check(prepared.sourceManifest === path.join(dir, 'parts', 'b.obj.source.json') && man.graph === 'g' && man.output === 'part' && man.node === 'b' && man.frame === 5 && man.fps === 24
      && JSON.stringify(man.export) === '{"format":"obj","options":{"up_axis":"z"}}' && JSON.stringify(man.vars) === '{"k":1}' && man.topotopo === TOPOTOPO_VERSION && man.graph_sha256 === graphSha256(gs),
      'an export target records its source from the graph it is published from');
    writeTargets([prepared], dir);
    check(fs.existsSync(path.join(dir, 'parts', 'b.obj.source.json')) && new ArtifactStore(dir).records()[0].files.length === 2, 'writeTargets writes the manifest with the export and records both');
  } finally {
    // mkdtemp returns the exact owned directory
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- inspect detail "scene": the glb export read back
{
  const sc = await engine.cook({
    nodes: {
      body: { type: 'box', params: { size: [1, 0.5, 0.4] } },
      body_n: { type: 'attrib_create', in: ['body'], params: { name: 'name', class: 'prim', value: 'body' } },
      m: { type: 'material', in: ['body_n'], params: { name: 'paint', base_color: [0.8, 0.1, 0.1], roughness: 0.4 } },
      hook: { type: 'scene_null', in: ['m'], params: { name: 'hook', parent: 'body', translate: [0.5, 0.25, 0] } },
    },
    output: 'hook',
  });
  const glb = await exportGeometryAsync(sc.geo!, 'glb', {}) as Uint8Array;
  const rep = glbSceneReport(glb);
  const body = rep.nodes.find((x) => x.name === 'body'), hook = rep.nodes.find((x) => x.name === 'hook');
  check(rep.triangles === 12 && body?.kind === 'mesh' && rep.meshes[0].primitives[0].material === 'paint' && rep.materials[0].name === 'paint' && Math.abs(rep.materials[0].roughness - 0.4) < 1e-6,
    `scene report: the mesh, its triangles and material as the glb holds them (${rep.triangles} tris, ${rep.materials.map((x) => x.name)})`);
  check(hook?.kind === 'empty' && hook.parent === 'body' && hook.world.map((x) => +x.toFixed(3)).join() === '0.5,0.25,0', `scene report: the socket under its parent at its world position (${JSON.stringify(hook)})`);
  const txt = sceneReportText(rep).join('\n');
  check(/^scene \(the glb export, read back\): 2 nodes, 1 meshes, 12 triangles, 1 materials/.test(txt) && /\n {4}hook: empty \(socket\); at \(0\.500, 0\.250, 0\.000\)/.test(txt) && /paint: base colour factor \(linear\) \(0\.60, 0\.01, 0\.01\), metallic 0\.00, roughness 0\.40; no maps/.test(txt), 'scene report text: nodes as a tree, materials');
}
process.exit(fail ? 1 : 0);
