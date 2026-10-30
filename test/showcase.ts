// Cook and render every graph in examples/ to examples/renders/<name>.png.
// A graph's meta.render (any render tool option: views, checker, color_by, azimuth, wireframe, section_axis, glyphs, …) overrides the default quad view.
// examples/ is a project: the graphs that name TopoTopo's own packages cook them from its copies in examples/packages/.
//   node test/showcase.ts [filter]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { openPackages } from '../src/packages/registry.ts';
import { renderGeometry } from '../src/render/raster.ts';
import { renderArgs } from '../src/render/options.ts';
import { encodePNG } from '../src/render/png.ts';
import { summarize } from '../src/inspect.ts';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const dir = path.join(root, 'examples');
const outDir = path.join(dir, 'renders');
fs.mkdirSync(outDir, { recursive: true });
const engine = new Engine(createNodeHost({ baseDir: dir }));
await engine.init();
const packages = openPackages(engine, dir);
for (const p of packages.check()) console.log(`warning: ${p}`);
const filter = process.argv[2];
let failed = 0;
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && x !== 'project.json' && (!filter || x.includes(filter)))) {
  const name = path.basename(f, '.json');
  const graph = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const r = await engine.cook(graph, { frame: graph.meta?.frame }); // animated examples name their display frame
  if (!r.ok || !r.geo) {
    failed++;
    console.log(`FAIL ${name}: ${r.errors.map((e) => `[${e.node}] ${e.message}`).join('; ')}`);
    continue;
  }
  const t0 = performance.now();
  const ro = graph.meta?.render ?? {};
  const img = renderGeometry(r.geo, { ...renderArgs(ro), title: r.frame !== 1 ? `${name} @ frame ${r.frame}` : name, views: ro.views, checker: !!ro.checker, colorBy: ro.color_by ?? null, azimuth: ro.azimuth, elevation: ro.elevation, zoom: ro.zoom });
  fs.writeFileSync(path.join(outDir, name + '.png'), encodePNG(img.rgba, img.width, img.height, (d) => zlib.deflateSync(d)));
  console.log(`ok   ${name}: cook ${r.ms.toFixed(0)} ms, render ${(performance.now() - t0).toFixed(0)} ms${r.warnings.length ? `, ${r.warnings.length} warnings: ${r.warnings.slice(0, 2).map((w) => `[${w.node}] ${w.message}`).join('; ')}` : ''}`);
  console.log('     ' + summarize(r.geo).split('\n').slice(0, 2).join('\n     '));
}
process.exit(failed ? 1 : 0);
