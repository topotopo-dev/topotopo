// Session.watch(): files written by other processes, and graphs/ and assets/ removed and made again (git checkout,
// stash or branch switch) are followed without restarting the session.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { Session } from '../src/session.ts';

let failed = 0;
const check = (cond: any, msg: string) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!cond) failed++;
};
const section = (s: string) => console.log(`\n== ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (pred: () => boolean, ms: number) => { const t0 = Date.now(); while (!pred() && Date.now() - t0 < ms) await sleep(50); return pred(); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'topotopo-watch-'));
const box = (s: number) => JSON.stringify({ nodes: { b: { type: 'box', params: { size: [s, s, s] } } }, output: 'b' });
const asset = (type: string) => JSON.stringify({ nodes: { c: { type } }, output: 'c' });
const size = (w: Session, g: string) => (w.graphs.get(g)?.nodes.b.params as any)?.size?.[0];
const open = async (dir: string) => {
  const e = new Engine(createNodeHost({ baseDir: dir }));
  await e.init();
  const w = new Session(dir, e);
  w.load();
  w.watch();
  return w;
};

for (const pkg of [false, true]) {
  section(pkg ? 'a package (manifest in the folder)' : 'a plain folder');
  const dir = path.join(tmp, pkg ? 'pkg' : 'plain');
  const graphs = path.join(dir, 'graphs'), assets = path.join(dir, 'assets');
  fs.mkdirSync(graphs, { recursive: true });
  fs.mkdirSync(assets, { recursive: true });
  if (pkg) fs.writeFileSync(path.join(dir, 'watched.topo'), JSON.stringify({ title: 'Watched', graph: 'main' }));
  fs.writeFileSync(path.join(graphs, 'main.json'), box(1));
  const w = await open(dir);
  const heard: string[] = [];
  w.listeners.add((ev) => heard.push(ev.graph));
  try {
    check(size(w, 'main') === 1, 'the graph is loaded');
    fs.writeFileSync(path.join(graphs, 'main.json'), box(2));
    check(await until(() => size(w, 'main') === 2, 5000) && heard.includes('main'), 'a file edit is followed and heard');

    fs.rmSync(graphs, { recursive: true, force: true });
    check(await until(() => !w.graphs.has('main'), 5000), 'graphs/ removed: its graphs go');
    fs.mkdirSync(graphs);
    fs.writeFileSync(path.join(graphs, 'main.json'), box(3));
    fs.writeFileSync(path.join(graphs, 'other.json'), box(4));
    check(await until(() => size(w, 'main') === 3 && size(w, 'other') === 4, 5000), 'graphs/ made again with graph files: the session lists them again');
    heard.length = 0;
    fs.writeFileSync(path.join(graphs, 'other.json'), box(5));
    check(await until(() => size(w, 'other') === 5, 5000) && heard.includes('other'), 'and follows edits in the new folder');

    // as git does it: removed and made again at once, before any event is read
    fs.rmSync(graphs, { recursive: true, force: true });
    fs.mkdirSync(graphs);
    fs.writeFileSync(path.join(graphs, 'main.json'), box(6));
    check(await until(() => size(w, 'main') === 6 && !w.graphs.has('other'), 5000), 'graphs/ removed and made again at once: the session shows the new content');
    fs.writeFileSync(path.join(graphs, 'main.json'), box(7));
    check(await until(() => size(w, 'main') === 7, 5000), 'and follows edits after that');

    fs.writeFileSync(path.join(assets, 'peg.json'), asset('tube'));
    check(await until(() => w.engine.root.assets.has('peg'), 5000), 'an asset written into assets/ is registered');
    fs.rmSync(assets, { recursive: true, force: true });
    fs.mkdirSync(assets);
    fs.writeFileSync(path.join(assets, 'cap.json'), asset('sphere'));
    check(await until(() => w.engine.root.assets.has('cap'), 5000), 'assets/ removed and made again: its assets are registered');
    fs.writeFileSync(path.join(assets, 'rim.json'), asset('torus'));
    check(await until(() => w.engine.root.assets.has('rim'), 5000), 'and new ones in it after that');
  } finally { w.unwatch(); }
}

fs.rmSync(tmp, { recursive: true, force: true });
if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log('\nsession-watch: all passed');
