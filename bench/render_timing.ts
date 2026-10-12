// Render timing: quad view of a ~200k-triangle torus, default and with wireframe "all", plus an optional
// set of render tool arguments (snake_case, as in the MCP render tool).
//   node bench/render_timing.ts ['{"shading":"ao","views":"quad"}']
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { renderGeometry } from '../src/render/raster.ts';
import { renderArgs } from '../src/render/options.ts';

const engine = new Engine(createNodeHost({ baseDir: process.cwd() }));
await engine.init();
const r = await engine.cook({ nodes: { t: { type: 'torus', params: { rows: 316, cols: 316 } } }, output: 't' });
const g = r.geo!;
const runs: [string, Record<string, unknown>][] = [['quad (default)', {}], ['quad wireframe:"all"', { wireframe: 'all' }]];
if (process.argv[2]) runs.push([process.argv[2], JSON.parse(process.argv[2])]);
for (const [label, a] of runs) {
  const o = renderArgs(a);
  renderGeometry(g, o); // warm-up
  const t0 = performance.now();
  const img = renderGeometry(g, o);
  console.log(`${label}: ${(performance.now() - t0).toFixed(0)} ms (${g.numPrims * 2} triangles, ${img.width}x${img.height})`);
}
