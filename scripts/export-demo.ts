// Export the Unreal demo scene (examples/unreal_demo.json) as the file set for the Unreal 5.8 / Houdini / Blender
// round trip:
//   landscape/         unreal_landscape bundle of node "landscape": heightmap.png + .json, layers/*.png, landscape.json
//                      (import settings + steps), objects.glb (road + instances), instances.csv + instances.meshes.json
//                      + meshes/*.glb
//   scene.glb          node "scene": terrain mesh, road and EXT_mesh_gpu_instancing instances with per-instance attributes
//   scene_expanded.glb the same with the instances as real geometry (importers without EXT_mesh_gpu_instancing)
//   scene.usda         the same as a USD stage: PointInstancer with per-instance primvars, UsdPreviewSurface materials
//   scene.geo          the same as Houdini JSON geometry (fpreal32): PackedGeometry prims with shared embedded geometry
//   instances.csv      node "instances" as Unreal PCG rows (+ instances.meshes.json + instances_meshes/*.glb)
//   demo.json          the list of files with sizes and the scene counts
//   node scripts/export-demo.ts [out dir] [--tiles N]   (default out/unreal_demo)
//   npm run export:demo -- --tiles 2
//   PowerShell: npm.cmd run export:demo -- --tiles 2 (passes --tiles through the npm command shim).
//     writes out/unreal_demo_tiled/: the same 253×253 field split into 2×2 tiles of 126 quads / 127 samples,
//     with shared edge samples and per-tile CSVs in landscape/tiles/<x>_<y>/. Meshes and instance positions stay shared.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { exportFilesAsync } from '../src/io/files.ts';
import type { FileExportOptions } from '../src/io/files.ts';
import type { ExportFormat } from '../src/io/export.ts';
import type { Geometry } from '../src/core/geometry.ts';
import { heightfieldsOf } from '../src/core/heightfield.ts';
import { unrealComponents } from '../src/io/unreal.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let outArg: string | undefined, tiles = 0;
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--tiles') {
    const value = process.argv[++i];
    tiles = Number(value);
    if (!value || !Number.isSafeInteger(tiles) || tiles < 1) throw new Error('--tiles needs a positive integer (for example --tiles 2)');
  } else if (arg.startsWith('--') || outArg !== undefined) throw new Error(`unexpected argument: ${arg}; usage: export-demo.ts [out dir] [--tiles N]`);
  else outArg = arg;
}
const out = path.resolve(outArg ?? path.join(root, 'out', tiles ? 'unreal_demo_tiled' : 'unreal_demo'));
const examples = path.join(root, 'examples');
const graph = JSON.parse(fs.readFileSync(path.join(examples, 'unreal_demo.json'), 'utf8'));
const host = createNodeHost({ baseDir: examples });
const engine = new Engine(host);
await engine.init();

const t0 = performance.now();
const cook = async (target: string): Promise<Geometry> => {
  const r = await engine.cook(graph, { target });
  if (!r.ok || !r.geo) throw new Error(`unreal_demo: node "${target}" failed: ${r.errors.map((e) => `[${e.node}] ${e.message}`).join('; ')}`);
  return r.geo;
};
const scene = await cook('scene'), landscape = await cook('landscape'), instances = await cook('instances');
const cookMs = performance.now() - t0;
let tileSize = 0;
if (tiles) {
  const hf = heightfieldsOf(landscape)[0];
  tileSize = (hf.width - 1) / tiles;
  if (hf.width !== hf.height || !Number.isInteger(tileSize) || !unrealComponents(tileSize + 1, tileSize + 1).exact) {
    throw new Error(`--tiles ${tiles} cannot split this ${hf.width}×${hf.height} field into exact Unreal components; use --tiles 2 for the demo`);
  }
}

// Only replace the explicitly resolved export directory, never the workspace or one of its ancestors.
const rootFromOut = path.relative(out, root);
if (out === path.parse(out).root || rootFromOut === '' || (!rootFromOut.startsWith('..' + path.sep) && rootFromOut !== '..' && !path.isAbsolute(rootFromOut))) {
  throw new Error(`refusing to replace a workspace ancestor: ${out}`);
}
if (fs.existsSync(out)) {
  if (fs.lstatSync(out).isSymbolicLink()) throw new Error(`refusing to replace a linked output directory: ${out}`);
  if (fs.readdirSync(out).length && !fs.existsSync(path.join(out, 'demo.json'))) throw new Error(`refusing to replace a non-demo directory: ${out}`);
}
fs.rmSync(out, { recursive: true, force: true });
const warnings: string[] = [];
const written: { path: string; bytes: number }[] = [];
const write = async (g: Geometry, format: ExportFormat, rel: string, o: FileExportOptions = {}) => {
  const target = path.join(out, rel);
  const outDir = format === 'unreal_landscape' ? target : path.dirname(target);
  const { files, summary } = await exportFilesAsync(g, format, target, {
    deflate: (d) => zlib.deflateSync(d, { level: 6 }),
    readFile: (p) => host.readFile(p),
    texturePath: (p) => path.relative(outDir, host.resolvePath(p)).split(path.sep).join('/'),
    warn: (m) => warnings.push(`${rel}: ${m}`),
    ...o,
  });
  for (const f of files) {
    fs.mkdirSync(path.dirname(f.path), { recursive: true });
    fs.writeFileSync(f.path, f.bytes);
    written.push({ path: path.relative(out, f.path).split(path.sep).join('/'), bytes: f.bytes.byteLength });
  }
  console.log(`${rel}: ${summary}`);
};

await write(landscape, 'unreal_landscape', 'landscape', tiles ? { tile_size: tileSize } : {});
await write(scene, 'glb', 'scene.glb');
await write(scene, 'glb', 'scene_expanded.glb', { instancing: 'expand' });
await write(scene, 'usda', 'scene.usda');
await write(scene, 'geo', 'scene.geo', { precision: 32 });
await write(instances, 'csv', 'instances.csv', { pcg: true });

const info = {
  graph: 'examples/unreal_demo.json',
  cook_ms: Math.round(cookMs),
  scene: { points: scene.numPoints, prims: scene.numPrims, instances: scene.numPacked, sources: scene.packedSources.length },
  instances: instances.numPacked,
  files: written,
  warnings,
};
fs.writeFileSync(path.join(out, 'demo.json'), JSON.stringify(info, null, 2) + '\n');
written.push({ path: 'demo.json', bytes: fs.statSync(path.join(out, 'demo.json')).size });

const kb = (n: number) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`);
console.log(`\n${out}  (cook ${cookMs.toFixed(0)} ms; ${scene.numPacked} instances of ${scene.packedSources.length} sources)`);
const w = Math.max(...written.map((f) => f.path.length));
for (const f of [...written].sort((a, b) => a.path.localeCompare(b.path, 'en'))) console.log(`  ${f.path.padEnd(w)}  ${kb(f.bytes).padStart(10)}`);
console.log(`  ${written.length} files, ${kb(written.reduce((s, f) => s + f.bytes, 0))}`);
for (const m of warnings) console.log(`warning: ${m}`);
