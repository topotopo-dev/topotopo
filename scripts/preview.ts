// Open the live viewer on a workspace without an MCP client; optionally load the examples.
//   node scripts/preview.ts [--workspace dir] [--examples]
import fs from 'node:fs';
import path from 'node:path';
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { Workspace } from '../src/workspace.ts';
import { startViewer } from '../src/viewer/server.ts';

const argv = process.argv.slice(2);
const i = argv.indexOf('--workspace');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const wsDir = path.resolve(i >= 0 ? argv[i + 1] : path.join(root, 'workspace'));
const engine = new Engine(createNodeHost({ baseDir: wsDir }));
await engine.init();
const ws = new Workspace(wsDir, engine);
ws.load();
if (argv.includes('--examples')) {
  const dir = path.join(root, 'examples');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const name = path.basename(f, '.json');
    ws.setGraph(name, JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    const r = await ws.cook(name);
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${name} (${r.ms.toFixed(0)} ms)`);
  }
}
const v = await startViewer(ws);
console.log(`preview: ${v.url}  (workspace ${wsDir}; Ctrl+C to stop)`);
