// Open the live viewer on a project without an MCP client; optionally load the examples.
//   node scripts/preview.ts [--project dir] [--examples]
// The folder (default: project/ in the repository) becomes a project by the MCP server's rule (startPackage: in no
// project, and holding nothing but TopoTopo's own folders), so the examples that use TopoTopo's own packages cook
// there: their first use copies the kits into it.
import fs from 'node:fs';
import path from 'node:path';
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { startPackage } from '../src/package.ts';
import { openPackage } from '../src/open.ts';
import { startViewer } from '../src/viewer/server.ts';

const argv = process.argv.slice(2);
const i = argv.indexOf('--project');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const start = startPackage(path.resolve(i >= 0 ? argv[i + 1] : path.join(root, 'project')));
console.log(start.log);
const wsDir = start.dir;
const engine = new Engine(createNodeHost({ baseDir: wsDir }));
await engine.init();
const { session: ws, packages } = openPackage(engine, wsDir);
if (argv.includes('--examples')) {
  const dir = path.join(root, 'examples');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && x !== 'project.json')) {
    const name = path.basename(f, '.json');
    const graph = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const n of packages.addFor(graph)) console.log(n);
    ws.setGraph(name, graph);
    const r = await ws.cook(name);
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${name} (${r.ms.toFixed(0)} ms)`);
  }
}
const v = await startViewer(ws);
console.log(`preview: ${v.url}  (project ${wsDir}; Ctrl+C to stop)`);
