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
//   node scripts/export-demo.ts [out dir]   (default out/unreal_demo)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { exportFilesAsync } from '../src/io/files.ts';
import type { FileExportOptions } from '../src/io/files.ts';
import type { ExportFormat } from '../src/io/export.ts';
import type { Geometry } from '../src/core/geometry.ts';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const out = path.resolve(process.argv[2] ?? path.join(root, 'out', 'unreal_demo'));
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

await write(landscape, 'unreal_landscape', 'landscape');
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
for (const f of [...written].sort((a, b) => a.path.localeCompare(b.path))) console.log(`  ${f.path.padEnd(w)}  ${kb(f.bytes).padStart(10)}`);
console.log(`  ${written.length} files, ${kb(written.reduce((s, f) => s + f.bytes, 0))}`);
for (const m of warnings) console.log(`warning: ${m}`);
