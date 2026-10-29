// The project's packages in the live viewer (src/viewer/packages.ts): GET /api/packages (each package the project
// uses, the version in use and its note, the updates and the notes of the newer versions, its working folder, whether
// the session follows it), the package names on the node list (the Scene tree's mark), the before/after of an update
// (the places and what changed, progress events, a place's GLB with each version and both overlaid, nothing written),
// its stop (its own: its cooks are not the workspace's) and a newer one taking its place, Update (the copies, the graphs
// cooked again, a node's error after a big one, the must-change list kept until dismissed), the follow switch (a save
// in the followed working folder cooks the scene again; off: the copy), the offer after a save in a working folder the
// session does not follow, a version published while the viewer runs, the errors, a viewer outside a project, and the
// viewer of a graph file in a project (topotopo view), whose before/after cooks the project's graphs in its folder.
//   node test/viewer-packages.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../src/nodes/index.ts';
import { GeoBuilder } from '../src/core/geometry.ts';
import { Engine } from '../src/graph/engine.ts';
import { defineNode } from '../src/graph/registry.ts';
import type { GraphSpec } from '../src/graph/types.ts';
import { createNodeHost } from '../src/host/node.ts';
import { Workspace } from '../src/workspace.ts';
import { readManifest } from '../src/gallery/library.ts';
import { openPackages, publishPackage } from '../src/gallery/packages.ts';
import type { ProjectPackages } from '../src/gallery/packages.ts';
import { startViewer } from '../src/viewer/server.ts';
import { viewGraphFile } from '../src/viewer/graph-file.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'topotopo-viewer-packages-'));
process.env.TOPOTOPO_CONFIG = path.join(tmp, 'cfg', 'config.json');
delete process.env.TOPOTOPO_LIBRARIES;

let failures = 0, passes = 0;
const check = (cond: any, msg: string) => { if (cond) passes++; else failures++; console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); };
const section = (s: string) => console.log(`\n== ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (pred: () => boolean, ms: number) => { const t0 = Date.now(); while (!pred() && Date.now() - t0 < ms) await sleep(50); return pred(); };
const json = (file: string, v: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(v, null, 2) + '\n'); };
const exists = (...p: string[]) => fs.existsSync(path.join(...p));
const height = (summary: string) => Number(/size [\d.]+ × ([\d.]+) × [\d.]+/.exec(summary)?.[1]);

// test only: waits in 20 ms steps that check for a stop, then a box
defineNode({
  type: 'test_pkg_wait', category: 'flow', summary: 'test only: waits ms in 20 ms steps, then a box', inputs: [],
  params: { ms: { type: 'int', default: 20, desc: 'ms' } },
  cook: async (ctx) => {
    for (let t = 0; t < ctx.p.ms; t += 20) { await ctx.checkpoint(); await sleep(20); }
    const b = new GeoBuilder();
    for (const [x, y, z] of [[0, 0, 0], [1, 1, 1]]) b.addPoint(x, y, z);
    return b.build();
  },
});

// ------------------------------------------------------------------ the libraries and the project
//   lib/trees  studio/trees 1.0, 1.1 (rounder crowns: a small update)
//   lib/rocks  studio/rocks 1.0, 2.0 (the slider "size" is now "radius": a big update)
//   lib/slow   studio/slow 1.0, 1.1 (its cooks wait: for the stop)
//   forest     uses each at 1.0 (libraries: ["../lib"]); graphs main, waits, yard (a graph_ref to a graph of the
//              project, and an asset of it), and a graph file scene.json beside graphs/
const LIB = path.join(tmp, 'lib'), TREES = path.join(LIB, 'trees'), ROCKS = path.join(LIB, 'rocks'), SLOW = path.join(LIB, 'slow'), FOREST = path.join(tmp, 'forest');
const project = (dir: string, manifest: Record<string, unknown>, graphs: Record<string, GraphSpec>) => {
  json(path.join(dir, 'project.json'), { id: path.basename(dir), title: path.basename(dir), graph: 'main', ...manifest });
  for (const [n, g] of Object.entries(graphs)) json(path.join(dir, 'graphs', `${n}.json`), g);
};
const setGraph = (dir: string, name: string, g: GraphSpec) => json(path.join(dir, 'graphs', `${name}.json`), g);
const engines: Engine[] = [];
async function open(dir: string): Promise<{ engine: Engine; pk: ProjectPackages; ws: Workspace }> {
  const engine = new Engine(createNodeHost({ baseDir: dir, workers: 0 }));
  await engine.init();
  engines.push(engine);
  const pk = openPackages(engine, dir);
  const ws = new Workspace(dir, engine);
  ws.packages = pk;
  ws.load();
  return { engine, pk, ws };
}
const publish = async (dir: string, note: string) => { const o = await open(dir); const r = await publishPackage(o.pk, { note }); if (!r.ok) throw new Error(`publish ${dir}: ${r.blocks.join('; ')}`); return r.version!; };

const trees = (crown: number): GraphSpec => ({
  nodes: {
    trunk: { type: 'tube', params: { radius: 0.2, height: '=height' } },
    crown: { type: 'sphere', params: { radius: '=crown' } },
    lifted: { type: 'transform', in: ['crown'], params: { translate: [0, '=height', 0] } },
    tree: { type: 'merge', in: ['trunk', 'lifted'] },
  },
  output: 'tree', vars: { height: 4, crown }, params: { height: { type: 'float', min: 1, max: 20 }, crown: { type: 'float', min: 0.2, max: 5 } },
  outputs: { pine: { node: 'tree', label: 'Pine' } },
});
const rocks = (slider: string): GraphSpec => ({
  nodes: { stone: { type: 'sphere', params: { radius: `=${slider}` } } }, output: 'stone',
  vars: { [slider]: 0.8 }, params: { [slider]: { type: 'float', min: 0.1, max: 5 } }, outputs: { boulder: { node: 'stone' } },
});
const slow = (ms: number): GraphSpec => ({ nodes: { w: { type: 'test_pkg_wait', params: { ms: '=ms' } } }, output: 'w', vars: { ms }, params: { ms: { type: 'int', min: 0, max: 5000 } }, outputs: { wait: { node: 'w' } } });

project(TREES, { package: 'studio/trees' }, { main: trees(1) });
project(ROCKS, { package: 'studio/rocks' }, { main: rocks('size') });
project(SLOW, { package: 'studio/slow' }, { main: slow(20) });
for (const d of [TREES, ROCKS, SLOW]) await publish(d, 'first');
const forestMain: GraphSpec = {
  nodes: {
    ground: { type: 'grid', params: { size: [20, 20] } },
    pine: { type: 'studio/trees/pine', params: { height: 5 } },
    small_pine: { type: 'studio/trees/pine', params: { height: 3, crown: 0.8 } },
    boulder: { type: 'studio/rocks/boulder', params: { size: 1.2 } },
    out: { type: 'merge', in: ['ground', 'pine', 'small_pine', 'boulder'] },
  },
  output: 'out',
};
project(FOREST, { libraries: ['../lib'] }, {
  main: forestMain,
  waits: { nodes: { a: { type: 'studio/slow/wait', params: { ms: 300 } }, b: { type: 'studio/slow/wait', params: { ms: 301 } }, c: { type: 'studio/slow/wait', params: { ms: 302 } }, out: { type: 'merge', in: ['a', 'b', 'c'] } }, output: 'out' },
  // a place whose cook needs the project's own graphs and assets (graph_ref, an asset)
  plate: { nodes: { p: { type: 'grid', params: { size: [6, 6] } } }, output: 'p' },
  yard: { nodes: { g: { type: 'graph_ref', params: { graph: 'plate' } }, s: { type: 'stand' }, t: { type: 'studio/trees/pine', params: { height: "=bbox('g').size.x", crown: "=bbox('s').size.x" } }, out: { type: 'merge', in: ['t', 'g', 's'] } }, output: 'out' },
});
json(path.join(FOREST, 'assets', 'stand.json'), { nodes: { b: { type: 'box', params: { size: [1, 0.2, 1] } } }, output: 'b' });
json(path.join(FOREST, 'scene.json'), { nodes: { t: { type: 'studio/trees/pine', params: { height: 2 } } }, output: 't' });
{
  const o = await open(FOREST);
  for (const p of ['studio/trees', 'studio/rocks', 'studio/slow']) o.pk.use(p);
}
setGraph(TREES, 'main', trees(1.5));
setGraph(ROCKS, 'main', rocks('radius'));
setGraph(SLOW, 'main', slow(25));
check(await publish(TREES, 'rounder crowns') === '1.1' && await publish(ROCKS, 'the size slider is now radius') === '2.0' && await publish(SLOW, 'waits longer') === '1.1',
  'the fixture: studio/trees 1.1 (small), studio/rocks 2.0 (big), studio/slow 1.1');

// ------------------------------------------------------------------ the viewer on the project (topotopo edit, the MCP server)
const o = await open(FOREST);
const v = await startViewer(o.ws, 0);
const url = v.url.replace(/\/$/, '');
const events: any[] = [];
const ac = new AbortController();
const stream = fetch(`${url}/api/events`, { signal: ac.signal }).then(async (r) => {
  const rd = r.body!.getReader(), dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await rd.read();
    if (done) break;
    buf += dec.decode(value);
    for (let i; (i = buf.indexOf('\n\n')) >= 0;) { const m = buf.slice(0, i); buf = buf.slice(i + 2); if (m.startsWith('data: ')) events.push(JSON.parse(m.slice(6))); }
  }
}).catch(() => { /* aborted */ });
const get = async (p: string) => { const r = await fetch(url + p); return { status: r.status, j: await r.json() as any }; };
const post = async (p: string, body: unknown) => { const r = await fetch(url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, j: await r.json() as any }; };
const packages = async () => (await get('/api/packages')).j;
const row = async (pkg: string) => (await packages()).packages.find((p: any) => p.package === pkg);
const files = (dir: string) => JSON.stringify([fs.readFileSync(path.join(dir, 'project.json'), 'utf8'), fs.readFileSync(path.join(dir, 'packages', 'lock.json'), 'utf8'), fs.readdirSync(path.join(dir, 'packages', 'studio')).sort()]);
const info = async (graph = 'main') => (await get(`/api/info?graph=${graph}`)).j.summary as string;

try {
  await until(() => v.clients() > 0, 3000);
  section('GET /api/packages: what the project uses, the updates and their notes');
  {
    const s = await packages();
    check(s.project?.id === 'forest' && s.project.dir === FOREST && JSON.stringify(s.project.libraries) === '["../lib"]' && !s.problems.length && s.running === null,
      `the project, the libraries it lists (${JSON.stringify(s.project)})`);
    check(s.packages.map((p: any) => p.package).join() === 'studio/rocks,studio/slow,studio/trees', `every package it uses, by name (${s.packages.map((p: any) => p.package)})`);
    const t = s.packages.find((p: any) => p.package === 'studio/trees'), r = s.packages.find((p: any) => p.package === 'studio/rocks');
    check(t.version === '1.0' && t.note === 'first' && /^\d{4}-\d\d-\d\dT/.test(t.published) && t.small === '1.1' && !t.big && t.newer.map((x: any) => `${x.version} ${x.note} ${x.big}`).join() === '1.1 rounder crowns false',
      `studio/trees: 1.0 in use, its note and date; a small update 1.1 and its note (${JSON.stringify(t).slice(0, 200)})`);
    check(r.version === '1.0' && !r.small && r.big === '2.0' && r.newer[0].big === true && r.newer[0].note === 'the size slider is now radius', 'studio/rocks: a big update 2.0, marked big');
    check(JSON.stringify(t.outputs) === JSON.stringify([{ type: 'studio/trees/pine', label: 'Pine', kind: 'mesh', tags: [], used: true }]) && JSON.stringify(r.outputs) === JSON.stringify([{ type: 'studio/rocks/boulder', kind: 'mesh', tags: [], used: true }]),
      `the outputs of the version in use, with their kinds and tags, marked where the project uses them (${JSON.stringify(t.outputs)})`);
    check(JSON.stringify(t.usedBy.map((u: any) => `${u.graph} › ${u.node}`).sort()) === JSON.stringify(['main › pine', 'main › small_pine', 'scene › t', 'yard › t']) && t.usedBy.every((u: any) => u.type === 'studio/trees/pine'),
      `the nodes of the project's graphs that use a package (${t.usedBy.map((u: any) => `${u.graph} › ${u.node}`)})`);
    check(!t.kit && t.canFollow && s.project.title === 'forest' && s.project.package === null, 'a package with one working folder can show it live; the project by its title');
    const found = (await get('/api/packages/search?q=tree')).j;
    const hits = found.libraries.flatMap((l: any) => l.hits.map((h: any) => `${l.standing}:${h.type}${h.used ? `@${h.used}` : ''}`));
    check(hits.includes('listed:studio/trees/pine@1.0') && hits.some((h: string) => h.startsWith('builtin:topotopo/nature/')),
      `Find packages: the project's libraries and TopoTopo's kits, and what the project uses (${hits.join(', ')})`);
    check((await get('/api/packages/author')).status === 400, 'a project that is no package has no author panel');
    check(t.working.length === 1 && t.working[0].dir === TREES && t.working[0].library === '../lib' && t.followed === null && JSON.stringify(t.libraries) === '["../lib"]',
      'its working folder in the libraries the project lists; not followed');
    const g = (await get('/api/graphs')).j.find((x: any) => x.name === 'main');
    const named = Object.fromEntries(g.nodes.map((n: any) => [n.name, n.packages ?? null]));
    check(JSON.stringify(named.pine) === '["studio/trees"]' && JSON.stringify(named.boulder) === '["studio/rocks"]' && named.ground === null,
      `/api/graphs names the package each node uses, for the Scene tree's mark (${JSON.stringify(named)})`);
  }

  section('the before/after of a small update: the places, what changed, a, b and the overlay; nothing written');
  {
    const was = files(FOREST);
    events.length = 0;
    const r = await post('/api/packages/compare', { package: 'studio/trees' });
    const j = r.j;
    check(r.status === 200 && j.ok && j.target.from === '1.0' && j.target.to === '1.1' && !j.target.big && j.target.up && j.target.library === '../lib' && j.target.between.map((x: any) => x.version).join() === '1.1',
      `without "to": the newest with the same big number (${r.status} ${j.error ?? `${j.target?.from} → ${j.target?.to}`})`);
    check(j.uses.map((u: any) => `${u.file} ${u.node}`).join(' | ') === 'graphs/main.json pine | graphs/main.json small_pine | graphs/yard.json t | scene.json t',
      `every place the project uses it, a graph file beside graphs/ too (${j.uses.map((u: any) => `${u.file} ${u.node}`).join(' | ')})`);
    const pine = j.places.find((c: any) => c.node === 'pine'), small = j.places.find((c: any) => c.node === 'small_pine'), yard = j.places.find((c: any) => c.file === 'graphs/yard.json');
    check(pine.before.ok && pine.after.ok && !pine.diff.identical && /^shape changed by up to/.test(pine.diff.verdict) && /^counts:/m.test(pine.diff.text) && pine.views.a && pine.views.b && pine.views.overlay,
      `a place that changed: both cooked, what changed, a, b and the overlay to look at (${pine.diff?.verdict})`);
    check(small.diff.identical && small.uses[0].set === '{"height":3,"crown":0.8}', 'a place that sets the slider whose default changed does not change');
    check(yard.before.ok && yard.after.ok, `a graph that reads a graph and an asset of the project cooks (${yard.before.errors.join('; ')})`);
    // the events come on their own connection: the last may arrive after the answer
    await until(() => events.some((e) => e.compare && !e.compare.running && e.compare.id === j.id), 3000);
    const progress = events.filter((e) => e.compare);
    check(progress.some((e) => e.compare.running && e.compare.total === 8 && /^graphs\/main\.json pine with studio\/trees 1\.(0|1)$/.test(e.compare.what)) && progress.at(-1).compare.running === false && progress.at(-1).compare.id === j.id,
      `{compare} events say how far it is, and when it ended (${progress.length} events)`);
    check(files(FOREST) === was, 'nothing is written: project.json, the lock and the copies are as they were');
    const geo = async (side: string, id = j.id, place = pine.index) => { const res = await fetch(`${url}/api/packages/compare/geo?id=${id}&place=${place}&side=${side}`); return { status: res.status, magic: res.status === 200 ? Buffer.from(await res.arrayBuffer()).toString('latin1', 0, 4) : (await res.json() as any).error }; };
    const [a, b, ov] = await Promise.all(['a', 'b', 'overlay'].map((s) => geo(s)));
    check(a.magic === 'glTF' && b.magic === 'glTF' && ov.magic === 'glTF', 'GET /api/packages/compare/geo: the place with each version, and both overlaid, as GLBs');
    const bad = await geo('c'), none = await geo('a', j.id, 99), old = await geo('a', 'nope'), unnamed = await fetch(`${url}/api/packages/compare/geo?id=${j.id}&side=a`);
    check(bad.status === 400 && none.status === 404 && old.status === 404 && /no longer the last one/.test(old.magic) && unnamed.status === 400,
      `a side that is none, a place that is none or not named, a before/after that is not the last: ${bad.status}, ${none.status}, ${unnamed.status}, ${old.status}`);
    const last = await get('/api/packages/compare');
    check(last.j.compare?.id === j.id && last.j.compare.places.length === 4 && last.j.running === null && (await packages()).compare?.id === j.id, 'GET /api/packages/compare gives the last one in full');
  }

  section('the before/after of a big update: what goes away, what the graphs must change');
  {
    const r = (await post('/api/packages/compare', { package: 'studio/rocks', to: '2.0' })).j;
    const boulder = r.places[0];
    check(r.ok && r.target.big && r.interfaceBig.some((x: string) => /output "boulder": param "size" removed/.test(x)) && /^graphs\/main\.json boulder: sets param "size", which studio\/rocks 2\.0 does not have/.test(r.mustChange[0]),
      `a big version: what goes away, what the graphs must change (${r.mustChange.join('; ')})`);
    check(boulder.before.ok && !boulder.after.ok && /unknown param "size"/.test(boulder.after.errors.join()) && boulder.views.a && !boulder.views.b && !boulder.views.overlay,
      'a place that does not cook with it: a to look at, not b, no overlay');
    const b = await fetch(`${url}/api/packages/compare/geo?id=${r.id}&place=0&side=b`);
    check(b.status === 422 && /with studio\/rocks 2\.0 it does not cook: \[boulder\] unknown param "size"/.test((await b.json() as any).error), 'its b says why there is none');
  }

  section('the errors, as clear as the CLI\'s');
  {
    const none = await post('/api/packages/compare', { package: 'studio/oaks' });
    const latest = await post('/api/packages/compare', { package: 'studio/rocks' });
    const far = await post('/api/packages/compare', { package: 'studio/trees', to: '1.9' });
    const noPkg = await post('/api/packages/compare', {});
    check(none.status === 400 && /this project does not use studio\/oaks: its uses are studio\/rocks, studio\/slow, studio\/trees/.test(none.j.error), `a package the project does not use: ${none.j.error}`);
    check(latest.status === 400 && /studio\/rocks 1\.0 is the newest 1\.x .* and 2\.0 is a big version, a step of its own: name it/.test(latest.j.error), `a big update is named: ${latest.j.error}`);
    check(far.status === 400 && /no library this project lists has studio\/trees 1\.9: they have 1\.0, 1\.1/.test(far.j.error) && noPkg.status === 400 && /"package" is required/.test(noPkg.j.error), 'a version no library has; no package');
    const methods = await Promise.all([fetch(`${url}/api/packages/stop`), fetch(`${url}/api/packages`, { method: 'POST' }), fetch(`${url}/api/packages/nope`)]);
    check(methods.map((m) => m.status).join() === '405,405,404', `GET of a POST route, POST of a GET route, an unknown route (${methods.map((m) => m.status)})`);
    const cross = await fetch(`${url}/api/packages/follow`, { method: 'POST', headers: { origin: 'http://evil.example' }, body: '{"package":"studio/trees"}' });
    check(cross.status === 403 && !(await row('studio/trees')).followed, 'a write from another site is refused');
  }

  section('Stop: the before/after stops at its next node; a newer one takes the place of one in progress');
  {
    events.length = 0;
    const pending = post('/api/packages/compare', { package: 'studio/slow' });
    const after = () => events.some((e) => e.compare?.running && / with studio\/slow 1\.1$/.test(e.compare.what));
    check(await until(after, 15000), 'it runs: the cooks with the new version have started');
    const t0 = performance.now();
    const st = await post('/api/packages/stop', {});
    const r = await pending;
    const took = performance.now() - t0;
    check(st.j.ok && st.j.stopping && r.j.ok && r.j.stopped && r.j.places.length < 3 && r.j.comparisons === 3 && took < 1500,
      `POST /api/packages/stop: it answers stopped, with ${r.j.places?.length} of ${r.j.comparisons} compared, in ${took.toFixed(0)} ms`);
    await until(() => events.some((e) => e.compare && !e.compare.running && e.compare.id === r.j.id), 3000);
    check(events.some((e) => e.compare?.stopping) && events.filter((e) => e.compare).at(-1).compare.stopped === true, 'the events say it is stopping, then that it stopped');
    check((await post('/api/packages/stop', {})).j.stopping === false, 'a stop with nothing running says so');
    // the latest wins: a newer before/after stops the one in progress, which answers 409
    events.length = 0;
    const first = post('/api/packages/compare', { package: 'studio/slow' });
    await until(() => events.some((e) => e.compare?.running && e.compare.total > 0), 5000);
    const second = await post('/api/packages/compare', { package: 'studio/trees' });
    const one = await first;
    check(one.status === 409 && /a newer before\/after took the place of this one/.test(one.j.error) && second.j.ok && second.j.target.package === 'studio/trees',
      `a newer before/after takes the place of the one in progress (${one.status} ${one.j.error ?? 'ok'})`);
  }

  section('Update: the copies, the graphs cook again, the mark goes');
  {
    const stale = await post('/api/packages/update', { package: 'studio/trees', from: '1.1', to: '1.1' });
    const noTo = await post('/api/packages/update', { package: 'studio/trees' });
    check(stale.status === 409 && /project\.json uses studio\/trees 1\.0 now, not 1\.1: look at the before\/after again/.test(stale.j.error) && noTo.status === 400 && /"from" and "to" are required/.test(noTo.j.error),
      `an update of what the person did not look at is refused (${stale.j.error})`);
    const h0 = height(await info()), version0 = (await get('/api/report?graph=main')).j.version;
    events.length = 0;
    const r = await post('/api/packages/update', { package: 'studio/trees', from: '1.0', to: '1.1' });
    check(r.status === 200 && r.j.ok && /^updated studio\/trees 1\.0 → 1\.1 in project forest/.test(r.j.text) && !r.j.mustChange.length && readManifest(FOREST).uses['studio/trees'] === '1.1'
      && exists(FOREST, 'packages', 'studio', 'trees', '1.1', 'version.json') && !exists(FOREST, 'packages', 'studio', 'trees', '1.0'), `applied: the copy of 1.1 in, 1.0 out, project.json (${r.j.text})`);
    check(await until(() => events.some((e) => e.graph === 'main') && events.some((e) => e.packages !== undefined), 8000), 'the pages hear it: the packages, and the graphs that use it');
    const rep = (await get('/api/report?graph=main')).j;
    check(rep.version > version0 && rep.ok && height(await info()) > h0, `the graph cooked again with 1.1: its crown is rounder (height ${h0} → ${height(await info())})`);
    const t = await row('studio/trees');
    check(t.version === '1.1' && !t.small && !t.newer.length && t.note === 'rounder crowns' && (await packages()).compare === null, 'the package is up to date (the mark goes); the before/after is done with');
    const big = await post('/api/packages/update', { package: 'studio/rocks', from: '1.0', to: '2.0' });
    check(big.j.ok && /sets param "size"/.test(big.j.mustChange.join()) && /the project's graphs must change for studio\/rocks 2\.0/.test(big.j.text), 'a big update is applied, and says what the graphs must change');
    const kept = (await row('studio/rocks')).mustChange;
    check(kept?.from === '1.0' && kept.to === '2.0' && /^graphs\/main\.json boulder: sets param "size"/.test(kept.items[0]), 'that list stays in view (GET /api/packages)');
    await until(() => !!(o.ws.lastReport.get('main') && !o.ws.lastReport.get('main')!.ok), 5000);
    const node = (await get('/api/graphs')).j.find((x: any) => x.name === 'main').nodes.find((n: any) => n.name === 'boulder');
    check(/unknown param "size" for studio\/rocks\/boulder/.test(node.error ?? ''), `the node that must change reports it (${node.error})`);
    const d = await post('/api/packages/dismiss', { package: 'studio/rocks' });
    check(d.j.ok && !(await row('studio/rocks')).mustChange, 'dismissed, the list goes');
    // the graph follows the big version (graphs/main.json is written too)
    o.ws.setGraph('main', { ...forestMain, nodes: { ...forestMain.nodes, boulder: { type: 'studio/rocks/boulder', params: { radius: 1.2 } } } });
  }

  section('follow: the working folder for this session; a save there cooks the scene again; off: the copy');
  {
    const was = fs.readFileSync(path.join(FOREST, 'project.json'), 'utf8');
    const on = await post('/api/packages/follow', { package: 'studio/trees', on: true });
    const t = await row('studio/trees');
    check(on.j.ok && on.j.followed && /^following studio\/trees for this session: its working folder/.test(on.j.text) && t.followed?.dir === TREES && fs.readFileSync(path.join(FOREST, 'project.json'), 'utf8') === was,
      `on: it shows as followed, nothing is saved (${on.j.text?.slice(0, 60)}…)`);
    await until(() => !o.ws.activity('main'), 5000);
    const h1 = height(await info());
    events.length = 0;
    setGraph(TREES, 'main', trees(2.5));
    // what the file watcher sets off, at once (the offer below waits for the real watcher)
    v.pokePackages('studio/trees', 'graphs/main.json');
    check(await until(() => events.some((e) => e.graph === 'main'), 8000), 'a save in the working folder: the graph is cooked again and the pages hear it');
    const h2 = height(await info());
    check(h2 > h1 && events.every((e) => !e.saved), `the scene shows the working folder (height ${h1} → ${h2}); no offer for a folder followed`);
    const off = await post('/api/packages/follow', { package: 'studio/trees', on: false });
    await until(() => !o.ws.activity('main'), 5000);
    check(off.j.ok && !off.j.followed && /stopped following studio\/trees: it resolves to its copy \(1\.1\) again/.test(off.j.text) && height(await info()) === h1 && !(await row('studio/trees')).followed,
      `off: the copy again (${off.j.text})`);
    const bad = await post('/api/packages/follow', { package: 'studio/oaks' });
    check(bad.status === 400 && /no library this project lists has a package studio\/oaks/.test(bad.j.error), `a package no library has: ${bad.j.error}`);
  }

  section('the offer: a save in the working folder of a package the session does not follow');
  {
    await sleep(600);
    events.length = 0;
    json(path.join(TREES, 'exports', 'look.json'), { x: 1 });
    await sleep(700);
    check(!events.some((e) => e.saved), 'a file a version does not hold (exports/) is no save');
    setGraph(TREES, 'main', trees(3));
    check(await until(() => events.some((e) => e.saved === 'studio/trees' && typeof e.packages === 'number'), 8000), 'a save in graphs/: {packages, saved: "studio/trees"}, so the page asks whether to follow it');
  }

  section('a version published while the viewer runs is a new update');
  {
    events.length = 0;
    check(await publish(TREES, 'big crowns') === '1.2', 'studio/trees 1.2 published from its working folder');
    v.pokePackages();
    check(await until(() => events.some((e) => e.packages !== undefined && !e.saved), 8000) && (await row('studio/trees')).small === '1.2', 'the pages hear it, and 1.2 is a small update');
  }
} finally {
  ac.abort();
  await stream;
  v.close();
}

section('a viewer whose graphs are in no project: nothing to show');
{
  const loose = path.join(tmp, 'loose');
  fs.mkdirSync(loose);
  const engine = new Engine(createNodeHost({ baseDir: loose, workers: 0 }));
  await engine.init();
  const ws = new Workspace(loose, engine);
  ws.packages = openPackages(engine, loose);
  ws.load();
  const lv = await startViewer(ws, 0);
  try {
    const s = await (await fetch(`${lv.url}api/packages`)).json() as any;
    const c = await fetch(`${lv.url}api/packages/compare`, { method: 'POST', body: '{"package":"studio/trees"}' });
    check(s.project === null && !s.packages.length && c.status === 400 && /in no project: topotopo init <folder> \(MCP: library \{action:"init"\} for the open workspace, when the person says so\) makes the folder a project/.test((await c.json() as any).error),
      'no project: no packages, and a before/after says how to make one');
  } finally { lv.close(); }
}

section('topotopo view: a graph file in the project; the before/after cooks the project\'s graphs in its folder');
{
  const lines: string[] = [];
  const view = await viewGraphFile(path.join(FOREST, 'scene.json'), { name: 'scene', port: 0, log: (l) => lines.push(l) });
  try {
    const s = await (await fetch(`${view.url}api/packages`)).json() as any;
    check(s.project?.dir === FOREST && s.packages.some((p: any) => p.package === 'studio/trees' && p.small === '1.2'), 'the packages of the project the file belongs to');
    const r = await (await fetch(`${view.url}api/packages/compare`, { method: 'POST', body: '{"package":"studio/trees"}' })).json() as any;
    const yard = r.places?.find((c: any) => c.file === 'graphs/yard.json'), scene = r.places?.find((c: any) => c.file === 'scene.json');
    // the yard sets the crown itself (from the stand asset), so only the scene, which takes the default, changes
    check(r.ok && yard?.before.ok && yard.after.ok && yard.diff.identical && scene?.before.ok && scene.after.ok && !scene.diff.identical,
      `its workspace is a scratch folder: a graph of the project still reads the project's graphs and assets (${yard?.before.errors.join('; ') || 'ok'})`);
  } finally { view.close(); }
}

await engines[0]?.host.pool?.close();
console.log(`\n${passes} passed, ${failures} failed — temp ${tmp}`);
process.exit(failures ? 1 : 0);
