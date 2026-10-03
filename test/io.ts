// Export → import round trips for every format that has an importer.
//   node test/io.ts
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { exportGeometry } from '../src/io/export.ts';
import { importGeometry } from '../src/io/import.ts';
import { topologyReport } from '../src/core/topology.ts';

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
for (const fmt of ['json', 'obj', 'ply', 'glb', 'stl'] as const) {
  const bytes = exportGeometry(g, fmt, { custom: true });
  const back = importGeometry(bytes, fmt);
  const rep = topologyReport(back);
  const sameArea = Math.abs(rep.polys - (fmt === 'glb' || fmt === 'stl' ? g.numPrims * 2 : g.numPrims)) === 0;
  check(sameArea && back.numPoints > 0, `${fmt}: ${bytes.byteLength} bytes → ${back.numPoints} pts ${back.numPrims} prims, closed=${rep.closed} (src ${g.numPoints}/${g.numPrims})`);
  if (fmt === 'json') check(back.points.has('heat') && back.points.has('Cd'), 'json keeps custom + Cd attributes');
  if (fmt === 'ply') check(back.points.has('heat') && back.points.has('Cd'), 'ply keeps custom + Cd attributes');
  if (fmt === 'obj' || fmt === 'stl' || fmt === 'json' || fmt === 'ply') check(rep.closed, `${fmt}: watertight after round trip`);
}
const usd = new TextDecoder().decode(exportGeometry(g, 'usda'));
check(usd.startsWith('#usda 1.0') && usd.includes('def Mesh') && usd.includes('faceVertexCounts'), 'usda structure');
process.exit(fail ? 1 : 0);
