// Export → import round trips for the mesh formats (glTF, .geo, CSV and points JSON details: test/interop.ts).
//   node test/io.ts
import '../src/nodes/index.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { exportGeometry, exportGeometryAsync } from '../src/io/export.ts';
import { importGeometryAsync } from '../src/io/import.ts';
import { topologyReport } from '../src/core/topology.ts';
import { Geometry } from '../src/core/geometry.ts';
import { Heightfield, heightfieldsOf } from '../src/core/heightfield.ts';
import { m4identity } from '../src/core/math.ts';
import { packedFromMatrices } from '../src/core/packed.ts';
import { exportFilesAsync } from '../src/io/files.ts';
import { unrealLandscapeBundle } from '../src/io/unreal.ts';
import { heightmapExport } from '../src/io/heightmap.ts';
import { decodePNG } from '../src/io/png-decode.ts';
import { importCSV } from '../src/io/points.ts';

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
process.exit(fail ? 1 : 0);
