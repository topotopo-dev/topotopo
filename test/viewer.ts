// Live viewer tests (src/viewer/server.ts): the routes behind the human's control surface. Exposed vars in
// /api/graphs, POST /api/vars (and how it coalesces bursts), the inputs/ drop target, reference-layer GLBs, and the
// Host/Origin checks.
//   node test/viewer.ts
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { Workspace } from '../src/workspace.ts';
import type { EditOp } from '../src/workspace.ts';
import { inputFileName, startViewer } from '../src/viewer/server.ts';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'topotopo-viewer-'));

let failures = 0, passes = 0;
const check = (cond: any, msg: string) => {
  if (cond) passes++;
  else failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`);
};
const section = (s: string) => console.log(`\n== ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (pred: () => boolean, ms: number) => { const t0 = Date.now(); while (!pred() && Date.now() - t0 < ms) await sleep(50); return pred(); };
const sizeOf = (summary: string) => /size ([\d.]+) × ([\d.]+) × ([\d.]+)/.exec(summary)?.slice(1).map(Number) ?? [];
const TRI_OBJ = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n';

section('input file names');
{
  check(inputFileName('scan.obj') === 'scan.obj' && inputFileName('my scan.points.json') === 'my scan.points.json', 'plain names and double extensions are kept');
  check(inputFileName('a:b?.obj') === 'a_b_.obj' && inputFileName('CON.obj') === '_CON.obj' && inputFileName('name.obj. ') === 'name.obj', 'characters and names Windows cannot store are made safe');
  const bad = ['../x.obj', 'a/b.obj', 'a\\b.obj', '..', '.hidden', '', 'x'.repeat(201)].filter((n) => { try { inputFileName(n); return true; } catch { return false; } });
  check(bad.length === 0, `folders, "..", dotfiles, empty and over-long names are refused (accepted: ${JSON.stringify(bad)})`);
}

section('topotopo view: exposed vars, POST /api/vars, inputs');
{
  const gfile = path.join(tmp, 'boxes.json');
  fs.writeFileSync(gfile, JSON.stringify({
    nodes: { b: { type: 'box', params: { size: '=s' } } },
    vars: { s: 1, extra: 'x' },
    params: { s: { type: 'float', default: 1, min: 0.1, max: 10, desc: 'box size' } },
  }));
  const proc = spawn(process.execPath, [path.join(root, 'src', 'cli.ts'), 'view', gfile, '--port', '0'], { cwd: root });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  try {
    const up = await until(() => /view: http:\/\/127\.0\.0\.1:\d+\//.test(out), 30000);
    check(up, `view prints its URL (${out.trim().split('\n').pop()})`);
    if (up) {
      const url = /view: (http:\/\/127\.0\.0\.1:\d+)\//.exec(out)![1];
      const getJSON = async (p: string) => { const r = await fetch(url + p); return { status: r.status, j: await r.json() as any }; };
      const postVars = async (body: unknown, graph = 'boxes', headers: Record<string, string> = {}) => {
        const r = await fetch(`${url}/api/vars?graph=${graph}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
        return { status: r.status, j: await r.json() as any };
      };
      const upload = async (name: string, body: string, overwrite = false) => {
        const r = await fetch(`${url}/api/inputs?name=${encodeURIComponent(name)}&overwrite=${overwrite ? 1 : 0}`, { method: 'POST', body });
        return { status: r.status, j: await r.json() as any };
      };
      const box = async () => sizeOf((await getJSON('/api/info?graph=boxes')).j.summary);

      const g = (await getJSON('/api/graphs')).j[0];
      check(g.params?.s?.max === 10 && g.params.s.desc === 'box size' && g.vars?.s === 1 && g.vars.extra === 'x' && Array.isArray(g.locked) && g.locked.length === 0,
        `/api/graphs carries params, vars and locked (${JSON.stringify({ params: g.params, vars: g.vars, locked: g.locked })})`);

      const r1 = await postVars({ vars: { s: 2 } });
      check(r1.status === 200 && r1.j.ok === true && typeof r1.j.ms === 'number' && Array.isArray(r1.j.errors) && !r1.j.errors.length, `POST /api/vars answers { ok, ms, errors } (${JSON.stringify(r1.j)})`);
      check((await box()).join() === '2,2,2', 'the "=s" param reads the new var: GET /api/info shows a 2 m box');

      const lk = await postVars({ vars: {}, locked: ['s', 's'] });
      const g2 = (await getJSON('/api/graphs')).j[0];
      check(lk.j.ok && JSON.stringify(g2.locked) === '["s"]' && g2.vars.s === 2, `"locked" replaces meta.locked (deduplicated) and leaves the vars alone (${JSON.stringify(g2.locked)})`);

      const burst = await Promise.all([3, 4, 5].map((s) => postVars({ vars: { s } })));
      check(burst.every((r) => r.status === 200 && r.j.ok), `a burst of three POSTs: all answered ok (${burst.map((r) => r.j.vars?.s).join(', ')})`);
      check((await box()).join() === '5,5,5' && (await getJSON('/api/graphs')).j[0].vars.s === 5, 'the burst ends with the last value applied (a 5 m box)');

      const bad = await postVars({ vars: [1] });
      const noGraph = await postVars({ vars: { s: 1 } }, 'nope');
      const get = await fetch(`${url}/api/vars?graph=boxes`);
      const rejected = await postVars({ vars: { s: "=npoints('b')" } });
      check(bad.status === 400 && noGraph.status === 404 && get.status === 405 && rejected.status === 400 && /node reference/.test(rejected.j.errors.join()),
        `bad bodies 400, unknown graph 404, GET 405, a var reading a node 400 (${rejected.j.errors.join()})`);
      check((await getJSON('/api/graphs')).j[0].vars.s === 5, 'a rejected edit leaves the graph unchanged');
      const cross = await postVars({ vars: { s: 9 } }, 'boxes', { origin: 'http://evil.example' });
      // fetch cannot set Host (a forbidden header): a DNS-rebound page would send its own name
      const host = await new Promise<number>((resolve, reject) => {
        http.get(`${url}/api/graphs`, { headers: { host: 'evil.example:80' } }, (r) => { r.resume(); resolve(r.statusCode ?? 0); }).on('error', reject);
      });
      check(cross.status === 403 && host === 403 && (await getJSON('/api/graphs')).j[0].vars.s === 5, `cross-origin writes and foreign Host headers are refused (${cross.status}, ${host})`);

      // the inputs/ drop target, watched over the event stream
      const ac = new AbortController();
      let events = '';
      const stream = fetch(url + '/api/events', { signal: ac.signal }).then(async (r) => {
        const rd = r.body!.getReader(), dec = new TextDecoder();
        for (;;) { const { value, done } = await rd.read(); if (done) break; events += dec.decode(value); }
      }).catch(() => { /* aborted */ });
      await until(() => events.includes(': hello'), 5000);
      const u1 = await upload('tri.obj', TRI_OBJ);
      check(u1.status === 200 && u1.j.ok && u1.j.path === 'tri.obj', `POST /api/inputs stores the file (${JSON.stringify(u1.j)})`);
      check(await until(() => /data: \{"inputs":\d+\}/.test(events), 5000), 'and broadcasts an {inputs: n} event');
      const list = (await getJSON('/api/inputs')).j;
      check(Array.isArray(list) && list.some((f: any) => f.path === 'tri.obj' && f.kind === 'geometry' && f.size === TRI_OBJ.length), `GET /api/inputs lists it (${JSON.stringify(list)})`);
      const glb = new Uint8Array(await (await fetch(`${url}/api/input?path=tri.obj`)).arrayBuffer());
      check(new TextDecoder().decode(glb.slice(0, 4)) === 'glTF', `GET /api/input returns a GLB (${glb.length} bytes)`);
      const info = (await getJSON('/api/input_info?path=tri.obj')).j;
      check(/3 points, 1 prims/.test(info.summary) && /size 1\.00 × 1\.00 × 0\.00/.test(info.summary), 'GET /api/input_info summarises it (counts, bbox)');
      const again = await upload('tri.obj', TRI_OBJ + 'v 0 0 1\n');
      const forced = await upload('tri.obj', TRI_OBJ + 'v 0 0 1\nf 1 2 4\n', true);
      const info2 = (await getJSON('/api/input_info?path=tri.obj')).j;
      check(again.status === 409 && again.j.exists && forced.status === 200 && /4 points, 2 prims/.test(info2.summary),
        `a repeated upload is 409 without overwrite=1 and replaces the file with it (${again.status}, ${forced.status})`);
      const evil = await upload('../evil.obj', TRI_OBJ);
      const traversal = await fetch(`${url}/api/input?path=${encodeURIComponent('../boxes.json')}`);
      const missing = await fetch(`${url}/api/input?path=nope.obj`);
      check(evil.status === 400 && traversal.status === 400 && missing.status === 404, `names with folders and paths leaving inputs/ are refused (${evil.status}, ${traversal.status}, ${missing.status})`);
      await upload('notes.txt', 'hello');
      const txt = await getJSON('/api/input?path=notes.txt');
      check(txt.status === 500 && /unsupported import format "txt"/.test(txt.j.error), `an unsupported file is a JSON 500 like /api/geo (${txt.j.error})`);
      check(!(await getJSON('/api/inputs')).j.some((f: any) => /\.part$/.test(f.path)), 'no upload leftovers in inputs/');
      ac.abort();
      await stream;
    }
  } finally { proc.kill(); }
}

section('POST /api/vars: a burst during a cook is applied by one more cook');
{
  const engine = new Engine(createNodeHost({ baseDir: tmp }));
  await engine.init();
  const ws = new Workspace(path.join(tmp, 'ws'), engine);
  ws.load();
  ws.setGraph('g', { nodes: { b: { type: 'box', params: { size: '=s' } } }, vars: { s: 1 } });
  // every edit takes a while, so the next requests arrive while one runs
  const edits: Record<string, any>[] = [];
  const edit = ws.edit.bind(ws);
  ws.edit = async (name: string, ops: EditOp[], opts?: { frame?: number }) => {
    edits.push({ ...ops[0].vars });
    await sleep(300);
    return edit(name, ops, opts);
  };
  const v = await startViewer(ws, 0);
  const post = async (body: unknown) => (await fetch(`${v.url}api/vars?graph=g`, { method: 'POST', body: JSON.stringify(body) })).json() as Promise<any>;
  try {
    const first = post({ vars: { s: 2 } });
    await sleep(100);
    const replies = await Promise.all([first, post({ vars: { s: 3 } }), post({ vars: { s: 4, t: 1 }, locked: ['s'] }), post({ vars: { s: 5 } })]);
    check(edits.length === 2 && edits[0].s === 2 && edits[1].s === 5 && edits[1].t === 1, `four requests, two edits: the first, then the merged rest (${JSON.stringify(edits)})`);
    check(replies.every((r) => r.ok) && replies[0].vars.s === 2 && replies.slice(1).every((r) => r.vars.s === 5 && r.vars.t === 1),
      `every request is answered after its values are applied (${replies.map((r) => r.vars.s).join(', ')})`);
    const g = ws.getGraph('g');
    check(g.vars?.s === 5 && JSON.stringify(g.meta?.locked) === '["s"]', 'the latest values and the locked set are stored');
    const stored = JSON.parse(fs.readFileSync(path.join(ws.graphDir, 'g.json'), 'utf8'));
    check(stored.vars.s === 5 && JSON.stringify(stored.meta?.locked) === '["s"]', 'and persisted in the workspace');
  } finally { v.close(); }
}

console.log(`\n${passes} passed, ${failures} failed — temp ${tmp}`);
process.exit(failures ? 1 : 0);
