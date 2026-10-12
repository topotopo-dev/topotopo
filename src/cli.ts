#!/usr/bin/env node
// Command line: cook a graph JSON file, then render / export / inspect.
//   node src/cli.ts <graph.json> [--node name] [--render out.png] [--views quad|quad_uv|persp|front,top|persp,uv]
//                   [--checker] [--color-by attr] [--export out.glb] [--inspect summary|attributes|topology|all]
//   node src/cli.ts --catalog | --help-node scatter
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import './nodes/index.ts';
import { Engine } from './graph/engine.ts';
import { allNodeDefs } from './graph/registry.ts';
import { createNodeHost } from './host/node.ts';
import { renderGeometry } from './render/raster.ts';
import type { ViewName } from './render/raster.ts';
import { encodePNG } from './render/png.ts';
import { exportGeometry } from './io/export.ts';
import type { ExportFormat } from './io/export.ts';
import { inspect } from './inspect.ts';
import { catalogText, nodeDoc } from './mcp/docs.ts';

const argv = process.argv.slice(2);
const opt = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };

if (!argv.length || argv.includes('-h') || argv.includes('--help')) {
  console.log('usage: node src/cli.ts <graph.json> [--node n] [--render out.png] [--views quad|quad_uv|persp|front,top|persp,uv] [--checker] [--color-by attr] [--export out.glb] [--inspect all]\n       node src/cli.ts --catalog | --help-node <type>');
  process.exit(0);
}
if (argv.includes('--catalog')) { console.log(catalogText(allNodeDefs())); process.exit(0); }
if (opt('--help-node')) {
  const d = allNodeDefs().find((x) => x.type === opt('--help-node'));
  console.log(d ? nodeDoc(d) : 'unknown node');
  process.exit(0);
}

const file = argv[0];
const graph = JSON.parse(fs.readFileSync(file, 'utf8'));
const engine = new Engine(createNodeHost({ baseDir: path.dirname(path.resolve(file)) }));
await engine.init();
const r = await engine.cook(graph, { target: opt('--node') });
for (const e of r.errors) console.error(`error [${e.node}] ${e.message}${e.hint ? ` (hint: ${e.hint})` : ''}`);
for (const w of r.warnings) console.error(`warning [${w.node}] ${w.message}`);
if (!r.ok || !r.geo) process.exit(1);
console.log(`cooked ${file} → ${r.target} in ${r.ms.toFixed(0)} ms`);
console.log(inspect(r.geo, { detail: (opt('--inspect') as any) ?? 'summary' }));
const out = opt('--render');
if (out) {
  const v = opt('--views') ?? 'quad';
  const views = v === 'quad' ? undefined : v === 'quad_uv' ? (['persp', 'uv'] as ViewName[]) : (v.split(',') as ViewName[]);
  const img = renderGeometry(r.geo, { views, colorBy: opt('--color-by') ?? null, checker: argv.includes('--checker'), title: path.basename(file, '.json') });
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, encodePNG(img.rgba, img.width, img.height, (d) => zlib.deflateSync(d)));
  console.log(`rendered ${out} (${img.width}x${img.height})${img.notes.length ? ' — ' + img.notes.join('; ') : ''}`);
}
const ex = opt('--export');
if (ex) {
  const fmt = path.extname(ex).slice(1).toLowerCase() as ExportFormat;
  fs.mkdirSync(path.dirname(path.resolve(ex)), { recursive: true });
  fs.writeFileSync(ex, exportGeometry(r.geo, fmt, { splitByName: true }));
  console.log(`exported ${ex}`);
}
