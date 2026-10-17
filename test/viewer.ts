// Live viewer tests (src/viewer/server.ts): the routes behind the human's control surface. The page (a shell and its
// ES modules under /app/), exposed vars in /api/graphs, POST /api/vars (and how it coalesces bursts), the last cook in
// /api/report, the inputs/ drop target (under `topotopo view`, beside the graph file), reference-layer GLBs (a PNG as
// a textured quad), markers (POST /api/markers → inputs/markers.json, read back through a file node), and the
// Host/Origin checks. The page's browser-free logic is tested in test/viewer-logic.ts.
//   node test/viewer.ts
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { primNormals } from '../src/core/topology.ts';
import { encodePNG } from '../src/render/png.ts';
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

      // the page: a shell that loads ES modules from /app/ and three.js from /vendor/three/
      const page = await fetch(url + '/');
      const shell = await page.text();
      check(page.status === 200 && /text\/html/.test(page.headers.get('content-type') ?? '') && /<script type="module" src="\/app\/main\.js">/.test(shell) && /href="\/app\/style\.css"/.test(shell),
        'GET / serves the shell, which loads /app/main.js and /app/style.css');
      const appFiles = fs.readdirSync(path.join(root, 'src', 'viewer', 'app'));
      const served = await Promise.all(appFiles.map(async (f) => { const r = await fetch(`${url}/app/${f}`); return { f, status: r.status, type: r.headers.get('content-type') ?? '', len: (await r.arrayBuffer()).byteLength }; }));
      const wrong = served.filter((x) => x.status !== 200 || !x.len || !(x.f.endsWith('.js') ? /^text\/javascript/ : x.f.endsWith('.css') ? /^text\/css/ : /./).test(x.type));
      check(appFiles.includes('main.js') && !wrong.length, `every file of src/viewer/app is served under /app/ with its MIME type (${served.length} files${wrong.length ? `; wrong: ${JSON.stringify(wrong)}` : ''})`);
      const three = await fetch(url + '/vendor/three/build/three.module.js');
      const addon = await fetch(url + '/vendor/three/examples/jsm/lines/LineMaterial.js');
      check(three.status === 200 && addon.status === 200 && /javascript/.test(three.headers.get('content-type') ?? ''), 'three.js and its addons are served from /vendor/three/');
      const escapes = await Promise.all(['/app/../server.ts', '/app/%2e%2e/server.ts', '/app/', '/app/nope.js', '/app/..%5cserver.ts'].map(async (p) => (await fetch(url + p)).status));
      check(escapes.every((s) => s === 404), `/app/ serves nothing outside src/viewer/app, nor folders or missing files (${escapes.join(', ')})`);

      const g = (await getJSON('/api/graphs')).j[0];
      check(g.params?.s?.max === 10 && g.params.s.desc === 'box size' && g.vars?.s === 1 && g.vars.extra === 'x',
        `/api/graphs carries params and vars (${JSON.stringify({ params: g.params, vars: g.vars })})`);
      const rep0 = (await getJSON('/api/report?graph=boxes')).j, noRep = await getJSON('/api/report?graph=nope');
      check(rep0.cooked === true && rep0.ok === true && rep0.graph === 'boxes' && rep0.target === 'b' && typeof rep0.ms === 'number' && Array.isArray(rep0.errors) && !rep0.errors.length && noRep.status === 404,
        `GET /api/report gives the last cook of a graph: target, ok, ms, errors (${JSON.stringify(rep0)}); an unknown graph is 404`);

      const r1 = await postVars({ vars: { s: 2 } });
      check(r1.status === 200 && r1.j.ok === true && typeof r1.j.ms === 'number' && Array.isArray(r1.j.errors) && !r1.j.errors.length, `POST /api/vars answers { ok, ms, errors } (${JSON.stringify(r1.j)})`);
      check((await box()).join() === '2,2,2', 'the "=s" param reads the new var: GET /api/info shows a 2 m box');

      const burst = await Promise.all([3, 4, 5].map((s) => postVars({ vars: { s } })));
      check(burst.every((r) => r.status === 200 && r.j.ok), `a burst of three POSTs: all answered ok (${burst.map((r) => r.j.vars?.s).join(', ')})`);
      check((await box()).join() === '5,5,5' && (await getJSON('/api/graphs')).j[0].vars.s === 5, 'the burst ends with the last value applied (a 5 m box)');

      const rep1 = (await getJSON('/api/report?graph=boxes')).j;
      check(rep1.version > rep0.version && rep1.ok, `the report follows the edits (version ${rep0.version} → ${rep1.version})`);

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

      // markers through `topotopo view`: written to the inputs/ beside the graph file
      const postMarkers = (markers: unknown[]) => fetch(`${url}/api/markers`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ markers }) });
      const markerFiles = () => ['markers.json', '.markers.json'].filter((f) => fs.existsSync(path.join(tmp, 'inputs', f)));
      const pm = await postMarkers([{ id: 's', kind: 'site', name: 'camp', points: [[0.5, 0, 0.5]] }]);
      const mi = (await getJSON('/api/input_info?path=markers.json')).j;
      check(pm.status === 200 && markerFiles().length === 2 && (await getJSON('/api/inputs')).j.some((f: any) => f.path === 'markers.json') && /1 points, 0 prims/.test(mi.summary ?? ''),
        `view: POST /api/markers writes markers.json and .markers.json into inputs/ beside boxes.json; a file node reads it (${String(mi.summary ?? mi.error).split('\n')[0]})`);
      const pe = await postMarkers([]);
      check(pe.status === 200 && !markerFiles().length && !(await getJSON('/api/inputs')).j.some((f: any) => f.path === 'markers.json') && !(await getJSON('/api/markers')).j.markers.length,
        'view: an empty marker list removes both again');
      ac.abort();
      await stream;
    }
  } finally { proc.kill(); }
}

section('topotopo view: drops go to inputs/ beside the graph file');
{
  // the graph file's folder gets inputs/ with the first drop, and the graph reads the file as "inputs/<name>"
  const site = path.join(tmp, 'site');
  fs.mkdirSync(site);
  const gfile = path.join(site, 'house.json'), inputs = path.join(site, 'inputs');
  fs.writeFileSync(gfile, JSON.stringify({ nodes: { b: { type: 'box' } } }));
  const proc = spawn(process.execPath, [path.join(root, 'src', 'cli.ts'), 'view', gfile, '--port', '0'], { cwd: root });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  try {
    const up = await until(() => /view: http:\/\/127\.0\.0\.1:\d+\//.test(out), 30000);
    check(up && out.includes(`go to ${inputs}${path.sep}`), `view says where dropped files go (${out.trim().split('\n').pop()})`);
    if (up) {
      const url = /view: (http:\/\/127\.0\.0\.1:\d+)\//.exec(out)![1];
      const getJSON = async (p: string) => { const r = await fetch(url + p); return { status: r.status, j: await r.json() as any }; };
      const where = (await getJSON('/api/inputs_dir')).j, listed = (await getJSON('/api/inputs')).j;
      check(where.dir === inputs && where.where === 'beside house.json' && Array.isArray(listed) && !listed.length && !fs.existsSync(inputs),
        `GET /api/inputs_dir names inputs/ beside the graph file, not made before a drop (${JSON.stringify(where)})`);
      const r = await fetch(`${url}/api/inputs?name=tri.obj`, { method: 'POST', body: TRI_OBJ });
      const j = await r.json() as any;
      check(r.status === 200 && j.path === 'tri.obj' && fs.readFileSync(path.join(inputs, 'tri.obj'), 'utf8') === TRI_OBJ,
        `the first drop makes the folder and stores the file at <graph folder>/inputs/tri.obj (${JSON.stringify(j)})`);
      // the viewer re-cooks when the graph file is saved
      fs.writeFileSync(gfile, JSON.stringify({ nodes: { f: { type: 'file', params: { path: 'inputs/tri.obj' } } } }));
      const recooked = await until(() => (out.match(/cooked house/g) ?? []).length >= 2, 15000);
      const info = (await getJSON('/api/info?graph=house')).j;
      check(recooked && /3 points, 1 prims/.test(info.summary ?? ''), `a file node reading "inputs/tri.obj" cooks the dropped file (${String(info.summary ?? info.error).split('\n')[0]})`);
    }
  } finally { proc.kill(); }
}

section('GET /api/input: "inputs/<rel>" through the host, the path a graph uses');
{
  // the engine's base folder holds inputs/ under the MCP server and under `topotopo view`; an engine that resolves paths
  // elsewhere (an embedding app) gets the absolute path
  const cookedPath = async (wsDir: string, baseDir: string, inputs?: string) => {
    const engine = new Engine(createNodeHost({ baseDir }));
    await engine.init();
    const ws = new Workspace(wsDir, engine, { inputs });
    ws.load();
    const seen: unknown[] = [];
    const cook = engine.cook.bind(engine);
    engine.cook = ((g: any, o?: any) => { seen.push(g.nodes?.f?.params?.path); return cook(g, o); }) as typeof engine.cook;
    const v = await startViewer(ws, 0);
    try {
      const where = ((await (await fetch(`${v.url}api/inputs_dir`)).json()) as any).where;
      await fetch(`${v.url}api/inputs?name=tri.obj`, { method: 'POST', body: TRI_OBJ });
      const r = await fetch(`${v.url}api/input_info?path=tri.obj`);
      const ok = r.status === 200 && /3 points, 1 prims/.test(((await r.json()) as any).summary);
      return { ok, path: seen[seen.length - 1], where };
    } finally { v.close(); }
  };
  const graphDir = path.join(tmp, 'graphs_here');
  const view = await cookedPath(path.join(tmp, 'scratch'), graphDir, path.join(graphDir, 'inputs'));
  const mcp = await cookedPath(path.join(tmp, 'mcp_ws'), path.join(tmp, 'mcp_ws'));
  const other = await cookedPath(path.join(tmp, 'embedded_ws'), path.join(tmp, 'elsewhere'));
  check(view.ok && view.path === 'inputs/tri.obj' && mcp.ok && mcp.path === 'inputs/tri.obj',
    `inputs/ beside the graph file (view) and in an MCP workspace: cooked as "inputs/tri.obj" (${view.path}, ${mcp.path})`);
  check(other.ok && other.path === path.join(tmp, 'embedded_ws', 'inputs', 'tri.obj'), `an engine based elsewhere: the absolute path (${other.path})`);
  check(mcp.where === 'in the workspace' && view.where === `in ${graphDir}`,
    `the page's default words for the folder: "${mcp.where}", or the folder holding a given one ("${view.where}")`);
}

section('inputs/ watch: files copied in by hand, also after the folder was deleted and a drop made it again');
{
  const base = path.join(tmp, 'watched'), inputs = path.join(base, 'inputs');
  const engine = new Engine(createNodeHost({ baseDir: base }));
  await engine.init();
  const ws = new Workspace(path.join(tmp, 'watched_scratch'), engine, { inputs });
  ws.load();
  const v = await startViewer(ws, 0);
  const ac = new AbortController();
  let hello = false, events = 0;
  const stream = fetch(`${v.url}api/events`, { signal: ac.signal }).then(async (r) => {
    const rd = r.body!.getReader(), dec = new TextDecoder();
    for (;;) {
      const { value, done } = await rd.read();
      if (done) break;
      const s = dec.decode(value);
      hello ||= s.includes(': hello');
      events += (s.match(/"inputs":\d+/g) ?? []).length;
    }
  }).catch(() => { /* aborted */ });
  const drop = (name: string) => fetch(`${v.url}api/inputs?name=${name}`, { method: 'POST', body: TRI_OBJ }).then((r) => r.status);
  /** a file copied into inputs/ by hand once the viewer is quiet: true when an {inputs} event follows */
  const byHand = async (name: string) => {
    await sleep(600);
    const before = events;
    fs.writeFileSync(path.join(inputs, name), TRI_OBJ);
    return until(() => events > before, 5000);
  };
  try {
    await until(() => hello, 5000);
    const first = await drop('a.obj') === 200 && await byHand('b.obj');
    // Windows reports a watched folder's deletion with a stream of events and no error, and the stream outlives a new
    // folder of the same name: the old watch must go, or files copied into the new folder pass unseen
    fs.rmSync(inputs, { recursive: true });
    await sleep(600);
    const again = await drop('c.obj') === 200 && await byHand('d.obj');
    check(first && again, `a file copied into inputs/ is announced, also after the folder was deleted and a drop made it again (${first}, ${again})`);
  } finally {
    ac.abort();
    await stream;
    v.close();
  }
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
    const replies = await Promise.all([first, post({ vars: { s: 3 } }), post({ vars: { s: 4, t: 1 } }), post({ vars: { s: 5 } })]);
    check(edits.length === 2 && edits[0].s === 2 && edits[1].s === 5 && edits[1].t === 1, `four requests, two edits: the first, then the merged rest (${JSON.stringify(edits)})`);
    check(replies.every((r) => r.ok) && replies[0].vars.s === 2 && replies.slice(1).every((r) => r.vars.s === 5 && r.vars.t === 1),
      `every request is answered after its values are applied (${replies.map((r) => r.vars.s).join(', ')})`);
    const g = ws.getGraph('g');
    check(g.vars?.s === 5 && g.vars?.t === 1, 'the latest values are stored');
    const stored = JSON.parse(fs.readFileSync(path.join(ws.graphDir, 'g.json'), 'utf8'));
    check(stored.vars.s === 5 && stored.vars.t === 1, 'and persisted in the workspace');
  } finally { v.close(); }
}

section('a dropped PNG and an image-only graph show as textured quads');
{
  const engine = new Engine(createNodeHost({ baseDir: path.join(tmp, 'wspng') }));
  await engine.init();
  const ws = new Workspace(path.join(tmp, 'wspng'), engine);
  ws.load();
  ws.setGraph('tex', { nodes: { n: { type: 'tex_noise', params: { resolution: [32, 16] } } } });
  const v = await startViewer(ws, 0);
  /** The JSON chunk of a GLB response. */
  const glbJSON = async (p: string) => {
    const b = new Uint8Array(await (await fetch(v.url + p)).arrayBuffer());
    return new TextDecoder().decode(b.slice(0, 4)) === 'glTF' ? JSON.parse(new TextDecoder().decode(b.subarray(20, 20 + new DataView(b.buffer).getUint32(12, true)))) : null;
  };
  const quad = (j: any, name: string) => !!j && j.meshes?.length === 1 && j.images?.length === 1 && j.materials?.[0]?.name === `image:${name}`
    && !!j.materials[0].extensions?.KHR_materials_unlit && !!j.materials[0].pbrMetallicRoughness?.baseColorTexture;
  try {
    // a 4 × 2 RGBA PNG, as the page uploads a dropped file
    const png = encodePNG(new Uint8Array(32).fill(200), 4, 2, (d) => zlib.deflateSync(d));
    const up = await fetch(`${v.url}api/inputs?name=albedo.png`, { method: 'POST', body: png });
    check(up.status === 200, `POST /api/inputs stores a PNG (${up.status})`);
    const list = await (await fetch(v.url + 'api/inputs')).json() as any[];
    check(list.some((f) => f.path === 'albedo.png' && f.kind === 'image'), 'GET /api/inputs lists it as an image');
    const j = await glbJSON('api/input?path=albedo.png');
    check(quad(j, 'albedo'), `GET /api/input returns one flat quad with the image as an unlit base colour map (${JSON.stringify(j?.materials?.map((m: any) => m.name))})`);
    const info = await (await fetch(v.url + 'api/input_info?path=albedo.png')).json() as any;
    check(/image "albedo": 4×2, layers: C rgba/.test(info.summary), `GET /api/input_info summarises the image (${info.summary?.split('\n')[1]})`);
    check(quad(await glbJSON('api/geo?graph=tex'), 'noise'), 'a graph whose output is only an image shows it the same way (GET /api/geo)');
  } finally { v.close(); }
}

section('markers: POST /api/markers writes inputs/markers.json, read back through a file node');
{
  // the engine the CLI and the MCP server use, its base directory the workspace: agents read "inputs/markers.json"
  const dir = path.join(tmp, 'mk');
  const engine = new Engine(createNodeHost({ baseDir: dir }));
  await engine.init();
  const ws = new Workspace(dir, engine);
  ws.load();
  const v = await startViewer(ws, 0);
  const api = async (method: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(`${v.url}api/markers`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, j: await r.json() as any };
  };
  const listed = async () => ((await (await fetch(`${v.url}api/inputs`)).json()) as any[]).map((f) => f.path);
  const geoFile = path.join(ws.inputDir, 'markers.json'), listFile = path.join(ws.inputDir, '.markers.json');
  const ac = new AbortController();
  let events = '';
  const stream = fetch(v.url + 'api/events', { signal: ac.signal }).then(async (r) => {
    const rd = r.body!.getReader(), dec = new TextDecoder();
    for (;;) { const { value, done } = await rd.read(); if (done) break; events += dec.decode(value); }
  }).catch(() => { /* aborted */ });
  try {
    await until(() => events.includes(': hello'), 5000);
    check(JSON.stringify((await api('GET')).j) === '{"markers":[]}', 'GET /api/markers is an empty list before any marker');

    const markers = [
      { id: 'a', kind: 'site', name: 'village', points: [[10, 2, -5]], radius: 5 },
      { id: 'b', kind: 'site', name: 'well', points: [[-4, 1, 3]] }, // radius: the default 5
      { id: 'c', kind: 'path', name: 'road', points: [[0, 0, 0], [20, 1, 0], [20, 2, 30]] },
      { id: 'd', kind: 'zone', name: 'keep empty', points: [[0, 0, 0], [10, 0, 0], [10, 0, 10], [0, 0, 10]] }, // clockwise seen from above
      { id: 'e', kind: 'volume', name: 'no trees', points: [[30, 1, 30], [20, 2, 40]], height: 8 },
    ];
    const r = await api('POST', { markers });
    check(r.status === 200 && r.j.ok && r.j.count === 5 && r.j.path === 'markers.json' && r.j.points === 17 && r.j.prims === 8,
      `POST /api/markers with two sites, a path, a zone and a volume: 200 (${JSON.stringify(r.j)})`);
    check(await until(() => /data: \{"inputs":\d+\}/.test(events), 5000), 'and broadcasts an {inputs: n} event');
    const names = await listed();
    check(fs.existsSync(geoFile) && fs.existsSync(listFile) && names.includes('markers.json') && !names.includes('.markers.json') && !fs.readdirSync(ws.inputDir).some((f) => f.endsWith('.part')),
      `inputs/markers.json is listed, the editable inputs/.markers.json is stored but hidden (${JSON.stringify(names)})`);
    const expected = markers.map((m) => (m.id === 'b' ? { ...m, radius: 5 } : m));
    check(JSON.stringify((await api('GET')).j.markers) === JSON.stringify(expected), 'GET /api/markers returns the same list (defaults filled in)');

    const cooked = await engine.cook({ nodes: { f: { type: 'file', params: { path: 'inputs/markers.json' } } }, output: 'f' });
    const g = cooked.geo!;
    check(cooked.ok && g.numPoints === 17 && g.numPrims === 8, `a file node reads inputs/markers.json (${cooked.errors.map((e) => e.message).join('; ') || `${g.numPoints} points, ${g.numPrims} prims`})`);
    if (cooked.ok) {
      const pt = (a: string) => g.points.get(a), pr = (a: string) => g.prims.get(a);
      const sites = [...Array(g.numPoints).keys()].filter((i) => pt('role')?.get(i) === 'site');
      check(sites.length === 2 && sites.map((i) => pt('name')?.get(i)).join() === 'village,well' && sites.every((i) => pt('pscale')?.get(i) === 5 && JSON.stringify(pt('orient')?.get(i)) === '[0,0,0,1]'),
        `2 points with role site, pscale 5, orient identity and their names (${sites.map((i) => `${pt('name')?.get(i)} ${pt('pscale')?.get(i)}`).join(', ')})`);
      const ofRole = (role: string) => [...Array(g.numPrims).keys()].filter((p) => pr('role')?.get(p) === role);
      const [road] = ofRole('path'), [zone] = ofRole('zone'), vol = ofRole('volume');
      check(ofRole('path').length === 1 && g.primClosed[road] === 0 && g.primSize(road) === 3 && pr('name')?.get(road) === 'road', 'one open polyline (3 points) with role path, named road');
      const N = primNormals(g);
      check(ofRole('zone').length === 1 && g.primClosed[zone] === 1 && g.primSize(zone) === 4 && pr('name')?.get(zone) === 'keep empty' && N[zone * 3 + 1] > 0.99,
        `one closed polyline (4 points) with role zone, named "keep empty", turned to face up (normal y ${N[zone * 3 + 1]?.toFixed(2)})`);
      // the box: 6 closed quads on 8 points, each edge shared by two faces in opposite directions, faces pointing out
      const P = g.P, corners = new Set(vol.flatMap((p) => g.primPoints(p)));
      const lo = [0, 1, 2].map((a) => Math.min(...[...corners].map((i) => P[i * 3 + a]))), hi = [0, 1, 2].map((a) => Math.max(...[...corners].map((i) => P[i * 3 + a])));
      const edges = new Map<string, number>();
      for (const p of vol) { const q = g.primPoints(p); q.forEach((a, k) => { const key = `${a}>${q[(k + 1) % q.length]}`; edges.set(key, (edges.get(key) ?? 0) + 1); }); }
      const closed = edges.size === 24 && [...edges].every(([k, n]) => { const [a, b] = k.split('>'); return n === 1 && edges.get(`${b}>${a}`) === 1; });
      const outward = vol.every((p) => {
        const q = g.primPoints(p), c = [0, 1, 2].map((a) => q.reduce((s, i) => s + P[i * 3 + a], 0) / q.length);
        return [0, 1, 2].reduce((s, a) => s + N[p * 3 + a] * (c[a] - (lo[a] + hi[a]) / 2), 0) > 0;
      });
      check(vol.length === 6 && vol.every((p) => g.primClosed[p] && g.primSize(p) === 4 && pr('name')?.get(p) === 'no trees') && corners.size === 8 && closed && outward
        && [lo, hi].map((x) => x.join()).join(' ') === '20,1,30 30,9,40',
        `one closed box of 6 quads with role volume, named "no trees", facing out, from the lower corner up 8 m (${lo.join()} → ${hi.join()})`);
    }

    const before = fs.readFileSync(geoFile, 'utf8');
    const bad: [unknown, RegExp][] = [
      [{ markers: 'x' }, /"markers"/],
      [{ markers: [{ kind: 'lake', name: 'x', points: [[0, 0, 0]] }] }, /kind "lake"/],
      [{ markers: [{ kind: 'path', name: 'x', points: [[0, 0, 0]] }] }, /2 or more points/],
      [{ markers: [{ kind: 'zone', name: 'x', points: [[0, 0, 0], [1, 0, 0]] }] }, /3 or more points/],
      [{ markers: [{ kind: 'site', name: 'A', points: [[0, 0, 0]] }, { kind: 'site', name: ' a', points: [[1, 0, 0]] }] }, /unique/],
      [{ markers: [{ kind: 'site', name: 'x', points: [[0, 'y', 0]] }] }, /\[x, y, z\]/],
      [{ markers: [{ kind: 'site', name: 'x', points: [[0, 0, 0]], radius: 0 }] }, /radius/],
      [{ markers: [{ kind: 'volume', name: 'x', points: [[0, 0, 0], [0, 0, 5]] }] }, /differ in x and in z/],
      [{ markers: [{ kind: 'site', name: '  ', points: [[0, 0, 0]] }] }, /name/],
    ];
    const replies = await Promise.all(bad.map(([b]) => api('POST', b)));
    check(replies.every((x, i) => x.status === 400 && x.j.ok === false && bad[i][1].test(x.j.error)), `invalid bodies are 400 with a message (${replies.map((x) => x.j.error).join(' | ')})`);
    const notJSON = await fetch(`${v.url}api/markers`, { method: 'POST', body: '{nope' });
    const cross = await api('POST', { markers: [] }, { origin: 'http://evil.example' });
    const del = await fetch(`${v.url}api/markers`, { method: 'DELETE' });
    check(notJSON.status === 400 && cross.status === 403 && del.status === 405 && fs.readFileSync(geoFile, 'utf8') === before && (await api('GET')).j.markers.length === 5,
      `no JSON 400, cross-origin 403, DELETE 405, and none of them changes the files (${notJSON.status}, ${cross.status}, ${del.status})`);

    fs.writeFileSync(listFile, '{"markers": [{"kind": "site"}]}');
    const broken = (await api('GET')).j;
    check(Array.isArray(broken.markers) && !broken.markers.length && /unreadable/.test(broken.error), `a broken stored list reads as empty, with the reason (${broken.error})`);
    const cleared = await api('POST', { markers: [] });
    check(cleared.status === 200 && cleared.j.count === 0 && cleared.j.path === null && !fs.existsSync(geoFile) && !fs.existsSync(listFile) && !(await listed()).includes('markers.json') && !(await api('GET')).j.markers.length,
      'an empty list removes inputs/markers.json and inputs/.markers.json');

    // as after an upload, a markers write that makes inputs/ again watches the new folder
    const announced = () => (events.match(/"inputs":\d+/g) ?? []).length;
    fs.rmSync(ws.inputDir, { recursive: true, force: true });
    await sleep(600);
    const remade = await api('POST', { markers: [markers[0]] });
    await sleep(600);
    const seen = announced();
    fs.writeFileSync(path.join(ws.inputDir, 'by-hand.obj'), TRI_OBJ);
    check(remade.status === 200 && fs.existsSync(geoFile) && await until(() => announced() > seen, 5000),
      'a markers write that makes inputs/ again watches it: a file copied in by hand is announced');
  } finally {
    ac.abort();
    await stream;
    v.close();
  }
}

console.log(`\n${passes} passed, ${failures} failed — temp ${tmp}`);
process.exit(failures ? 1 : 0);
