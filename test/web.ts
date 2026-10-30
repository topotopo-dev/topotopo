// The web app server (src/web/server.ts): the grid, a package page, thumbnails (a placeholder before the first
// bake), preview.glb, the embed page, attachments (inside the package only, scripts never inline), /api/packages
// (CORS only for listed origins), framing headers, the Host and Origin checks, a bake from a file change, a package's
// versions and outputs and the packages it uses, TopoTopo's built-in library as a library with the same package pages,
// the registered workspaces on the front page (their packages, found by scanning them, with pages of their own; a
// registered library inside one shown once, as the workspace's) and among a package's users, and the pages' templates
// escaping what they show.
//   node test/web.ts
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createPackage } from '../src/web/library.ts';
import type { WebConfig } from '../src/config.ts';
import { startWeb, runningWeb } from '../src/web/server.ts';
import { builtinLibrary } from '../src/packages/registry.ts';
import { esc, frontPage } from '../src/web/pages.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'topotopo-web-'));
// a config of its own: the libraries registered on this machine play no part
process.env.TOPOTOPO_CONFIG = path.join(tmp, 'config.json');
delete process.env.TOPOTOPO_LIBRARIES;
fs.writeFileSync(process.env.TOPOTOPO_CONFIG, JSON.stringify({ libraries: [{ name: 'game', path: path.join(tmp, 'lib') }] }));
let failures = 0, passes = 0;
const check = (cond: any, msg: string) => { if (cond) passes++; else failures++; console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); };
const section = (s: string) => console.log(`\n== ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (pred: () => boolean | Promise<boolean>, ms: number) => { const t0 = Date.now(); while (!(await pred()) && Date.now() - t0 < ms) await sleep(100); return pred(); };

const lib = { name: 'game', path: path.join(tmp, 'lib') };
/** TopoTopo's built-in packages, a library the web app always shows */
const BUILTIN = builtinLibrary().length;
fs.mkdirSync(lib.path);
const BOX = { nodes: { b: { type: 'box' } }, output: 'b' };
const crate = createPackage(lib, 'props/crate', { title: 'Crate <b>&', tags: ['props'], graph: BOX, links: [{ label: 'board', url: 'http://board.local/x' }] });
fs.writeFileSync(path.join(crate.dir, 'attachments', 'concept.png'), fs.readFileSync(path.resolve('library/props/thumbs/crate.png')));
fs.writeFileSync(path.join(crate.dir, 'attachments', 'evil.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
fs.writeFileSync(path.join(tmp, 'secret.txt'), 'secret');
const cfg: WebConfig = { file: path.join(tmp, 'config.json'), libraries: [lib], workspaces: [], web: { port: 0, cors: ['http://board.local:3000'] } };

const g = await startWeb({ config: cfg, port: 0 });
const req = (p: string, o: { method?: string; headers?: Record<string, string> } = {}) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port: g.port, path: p, method: o.method ?? 'GET', headers: o.headers }, (res) => {
    const chunks: Buffer[] = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
  });
  r.on('error', reject);
  r.end();
});

try {
  section('pages');
  {
    const home = await req('/');
    const html = home.body.toString();
    check(home.status === 200 && html.includes('href="/p/game/crate"') && html.includes('Crate &lt;b&gt;&amp;'), 'the grid links the package and escapes its title');
    check(home.headers['content-security-policy'] === "frame-ancestors 'self'", 'pages are not framed by other sites');
    const page = await req('/p/game/crate');
    const ph = page.body.toString();
    check(page.status === 200 && ph.includes('concept.png') && ph.includes('http://board.local/x') && ph.includes(`http://127.0.0.1:${g.port}/embed/game/crate`), 'the package page: attachments, links, the embed snippet with the absolute URL');
    check((await req('/p/game/nope')).status === 404, 'an unknown package is 404');
    check((await req('/static/web.css')).status === 200 && (await req('/app/embed.js')).status === 200 && (await req('/vendor/three/build/three.module.js')).status === 200, 'styles, the embed module and three.js are served');
    check((await req('/static/../server.ts')).status === 404, 'no files outside the static folder');
    const health = JSON.parse((await req('/api/health')).body.toString());
    check(health.web === true && health.packages === 1 + BUILTIN && health.libraries === 2, `health: the library's package and TopoTopo's built-in ones (${BUILTIN})`);
    check(await runningWeb(g.port) === g.url, 'runningWeb recognises it');
  }

  section('bake on start, thumbnails, preview.glb, embed');
  {
    check(await until(() => fs.existsSync(path.join(crate.dir, '.web', 'preview.glb')) && g.queue.size === 0, 60000), 'a never-baked package is baked on start');
    const t = await req('/p/game/crate/thumb.png');
    check(t.status === 200 && t.headers['content-type'] === 'image/png' && t.body.readUInt32BE(16) === 512, 'thumb.png is the baked 512 px thumbnail');
    const again = await req('/p/game/crate/thumb.png', { headers: { 'if-none-match': String(t.headers.etag) } });
    check(again.status === 304, 'an unchanged thumbnail answers 304');
    const glb = await req('/p/game/crate/preview.glb');
    check(glb.status === 200 && glb.body.toString('latin1', 0, 4) === 'glTF', 'preview.glb');
    const embed = await req('/embed/game/crate');
    const eh = embed.body.toString();
    check(embed.status === 200 && !embed.headers['content-security-policy'] && eh.includes('data-src="/p/game/crate/preview.glb?v=') && eh.includes('/app/embed.js'), 'the embed page can be framed and loads the GLB');
  }

  section('files');
  {
    const img = await req('/p/game/crate/files/attachments/concept.png');
    check(img.status === 200 && img.headers['content-type'] === 'image/png' && !img.headers['content-disposition'] && img.headers['x-content-type-options'] === 'nosniff', 'an attached image is shown inline');
    const svg = await req('/p/game/crate/files/attachments/evil.svg');
    check(svg.status === 200 && /attachment/.test(String(svg.headers['content-disposition'])) && svg.headers['content-security-policy'] === 'sandbox', 'an SVG (scripts) is a sandboxed download');
    check((await req('/p/game/crate/files/attachments/..%2F..%2F..%2Fsecret.txt')).status === 400, 'encoded ".." is refused');
    check((await req('/p/game/crate/files/graphs/main.json')).status === 400, 'only attachments/ and exports/ are served');
    check((await req('/p/game/crate/files/attachments/missing.png')).status === 404, 'a missing file is 404');
  }

  section('api, Host and Origin');
  {
    const list = await req('/api/packages', { headers: { origin: 'http://board.local:3000' } });
    const j = JSON.parse(list.body.toString());
    check(list.headers['access-control-allow-origin'] === 'http://board.local:3000' && j.packages[0].embed === `http://127.0.0.1:${g.port}/embed/game/crate`, 'a listed board origin may read the package list');
    check(!JSON.stringify(j).includes(tmp.replace(/\\/g, '\\\\')), 'the list has no absolute paths');
    const other = await req('/api/packages', { headers: { origin: 'http://evil.example' } });
    check(!other.headers['access-control-allow-origin'], 'other origins get no CORS header');
    check((await req('/', { headers: { host: 'evil.example' } })).status === 403, 'a foreign Host is refused (DNS rebinding)');
    check((await req('/p/game/crate/bake', { method: 'POST', headers: { origin: 'http://evil.example' } })).status === 403, 'a cross-site POST is refused');
    check((await req('/p/game/crate/bake')).status === 405, 'bake needs POST');
  }

  section('changes');
  {
    const at0 = JSON.parse(fs.readFileSync(path.join(crate.dir, '.web', 'bake.json'), 'utf8')).at;
    fs.writeFileSync(path.join(crate.dir, 'graphs', 'main.json'), JSON.stringify({ nodes: { b: { type: 'sphere' } }, output: 'b' }));
    const rebaked = await until(() => { try { return JSON.parse(fs.readFileSync(path.join(crate.dir, '.web', 'bake.json'), 'utf8')).at !== at0; } catch { return false; } }, 30000);
    check(rebaked, 'a graph saved by another process is baked again');
    createPackage(lib, 'props/barrel', { graph: BOX });
    check(await until(async () => JSON.parse((await req('/api/health')).body.toString()).packages === 2 + BUILTIN, 10000), 'a new package folder appears');
    check((await req('/p/game/barrel')).status === 200, 'and has its page');
  }

  section('a bake whose thumbnail renders with shading "pbr" (MikkTSpace loads itself)');
  {
    const shiny = createPackage(lib, 'props/shiny', { title: 'Shiny', graph: { nodes: { b: { type: 'box' }, uv: { type: 'uv_project', in: ['b'] } }, output: 'uv', meta: { thumbnail_render: { shading: 'pbr' } } } as any });
    const ok = await until(() => { try { return JSON.parse(fs.readFileSync(path.join(shiny.dir, '.web', 'bake.json'), 'utf8')).at > 0; } catch { return false; } }, 60000);
    const state = ok ? JSON.parse(fs.readFileSync(path.join(shiny.dir, '.web', 'bake.json'), 'utf8')) : null;
    check(state?.ok === true && fs.existsSync(path.join(shiny.dir, '.web', 'thumb.png')), `the bake needs no preload script (${state?.error ?? 'ok'})`);
  }

  section('a package without its default graph, and graph files beside its manifest');
  {
    const empty = createPackage(lib, 'props/empty', { title: 'Empty' });
    const beside = createPackage(lib, 'props/beside', { title: 'Beside' });
    fs.writeFileSync(path.join(beside.dir, 'tower.json'), JSON.stringify(BOX));
    const file = path.join(beside.dir, 'beside.topo'), m = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...m, graph: 'tower' }, null, 2));
    g.rescan();
    await sleep(1500);
    const grid = (await req('/')).body.toString();
    const at = grid.indexOf('data-key="game/empty"'), card = grid.slice(at, grid.indexOf('</a>', at));
    check(card.includes('<span class="status s-empty">no default graph yet</span>') && !card.includes('bake failed'), 'a new package\'s card says it has no default graph yet, never a failed bake');
    const page = (await req('/p/game/empty')).body.toString();
    check(/No default graph yet: this package has no graphs\. Ask your agent to build one/.test(page) && !/class="bake err/.test(page) && /No graphs yet\. Ask your agent to build one/.test(page),
      'its page says what to do, not an error');
    check(!fs.existsSync(path.join(empty.dir, '.web', 'bake.json')), 'nothing is baked before it has a default graph');
    const bp = (await req('/p/game/beside')).body.toString();
    check(/<h3>tower <span class="tag">default<\/span>/.test(bp), 'a graph file beside the manifest is a graph of the package, here its default one');
    check(await until(() => fs.existsSync(path.join(beside.dir, '.web', 'thumb.png')), 60000), 'and is baked');
  }

  section('packages: a package\'s versions and outputs, the packages a package uses, the grid marks packages');
  {
    // a package with two published versions and a package that uses the first, their records as publishing and use
    // write them (versions/<v>/version.json, packages/<owner>/<name>/<v>/version.json)
    const pine = { graph: 'main', node: 'tree', label: 'Pine', kind: 'mesh', tags: ['conifer', 'low-poly'], sliders: { height: { type: 'float', default: 4 } }, inputs: [{ index: 0, label: 'ground' }] };
    const rec = (version: string, note: string, published: string) => ({ package: 'studio/trees', version, note, published, big: false, hash: `h${version}`, outputs: { pine }, default: pine, topotopo: '0' });
    const trees = createPackage(lib, 'nature/trees', { title: 'Trees', graph: BOX });
    const forest = createPackage(lib, 'levels/forest', { title: 'Forest', graph: BOX });
    const edit = (dir: string, f: (m: any) => void) => { const file = path.join(dir, `${path.basename(dir)}.topo`); const m = JSON.parse(fs.readFileSync(file, 'utf8')); f(m); fs.writeFileSync(file, JSON.stringify(m, null, 2)); };
    const write = (file: string, v: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(v)); };
    edit(trees.dir, (m) => { m.name = 'studio/trees'; });
    write(path.join(trees.dir, 'versions', '1.0', 'version.json'), rec('1.0', 'first trees', '2026-10-20T10:00:00.000Z'));
    write(path.join(trees.dir, 'versions', '1.1', 'version.json'), rec('1.1', 'rounder <crowns>', '2026-10-22T10:00:00.000Z'));
    edit(forest.dir, (m) => { m.uses = { 'studio/trees': '1.0' }; });
    write(path.join(forest.dir, 'packages', 'studio', 'trees', '1.0', 'version.json'), rec('1.0', 'first trees', '2026-10-20T10:00:00.000Z'));
    g.rescan();
    const page = (await req('/p/game/trees')).body.toString();
    check(/class="pkgline">Package <span class="pkg"[^>]*>studio\/trees 1\.1<\/span>/.test(page), 'a package\'s page names it in full, with its newest version');
    check(/<span class="vn">1\.1<\/span><span class="vd">2026-10-22<\/span><span class="vt">rounder &lt;crowns&gt;<\/span>/.test(page) && /<span class="vn">1\.0<\/span><span class="vd">2026-10-20<\/span><span class="vt">first trees<\/span>/.test(page)
      && page.indexOf('id="v-1.1"') < page.indexOf('id="v-1.0"') && /id="v-1\.0"[\s\S]*?<ul class="vouts"><li><code>studio\/trees\/pine<\/code>/.test(page),
      'its versions, newest first, with their dates and notes (escaped); each opens to the outputs it published');
    check(/<h2>Used by <span class="count">1<\/span><\/h2><table class="vars uses"><tbody><tr><th><a href="\/p\/game\/forest">Forest<\/a><\/th><td>1\.0<\/td>/.test(page), 'a package\'s page lists the packages that use it, linked');
    check(/<code>studio\/trees\/pine<\/code><br><code>studio\/trees<\/code> <span class="dim">\(the default\)<\/span><\/th><td>Pine<span class="tags"><span class="kind"[^>]*>mesh<\/span><span class="tag">conifer<\/span><span class="tag">low-poly<\/span><\/span><\/td><td class="dim">node &quot;tree&quot; of graph &quot;main&quot; · params height · input ground<\/td>/.test(page),
      'the outputs it publishes, by the node type a graph names them with: their kinds, tags, params and inputs, the default output');
    const user = (await req('/p/game/forest')).body.toString();
    check(/<h2>Packages it uses<\/h2>/.test(user) && /<th><a href="\/p\/game\/trees">studio\/trees<\/a><\/th><td>1\.0<\/td><td class="dim">first trees · 2026-10-20 <span class="newer">1\.1 is out<\/span><\/td>/.test(user) && !/class="pkgline"/.test(user),
      'a package\'s page lists the packages it uses: the version in use, its note, the package\'s page, a newer version');
    const grid = (await req('/')).body.toString();
    const cardOf = (key: string) => { const at = grid.indexOf(`data-key="${key}"`); return at < 0 ? '' : grid.slice(at, grid.indexOf('</a>', at)); };
    check(cardOf('game/trees').includes('<span class="pkg" title="package studio/trees, newest version 1.1">studio/trees 1.1</span>') && cardOf('game/forest') && !cardOf('game/forest').includes('class="pkg"'),
      'the grid marks a package with its full name and newest version');
    check(/<span class="out" hidden data-hay="studio\/trees\/pine studio\/trees pine mesh conifer low-poly"><code>studio\/trees\/pine<\/code><span class="kind"[^>]*>mesh<\/span><span class="tag">conifer<\/span>/.test(cardOf('game/trees')) && !cardOf('game/forest').includes('class="out"')
      && /placeholder="Search \d+ packages and \d+ outputs"/.test(grid), 'the grid\'s search finds a package\'s outputs by name, kind and tag: each card carries them, shown when the search finds them');
    check(/data-hay="[^"]*studio\/trees/.test(cardOf('game/forest')) && /<span class="upd" title="studio\/trees 1\.0 is in use; 1\.1 is out">update: studio\/trees 1\.1<\/span>/.test(cardOf('game/forest')),
      'a package\'s card: the search finds it by the packages it uses, and it says that an update exists');
    // TopoTopo's built-in library: a library like the others, last on the grid; its packages have the package page
    const props = cardOf('topotopo/props');
    check(/<section class="library" id="lib-topotopo">/.test(grid) && grid.indexOf('id="lib-topotopo"') > grid.indexOf('id="lib-game"') && /TopoTopo's built-in library: ready-made packages every package can use/.test(grid)
      && /href="\/p\/topotopo\/props" data-key="topotopo\/props"/.test(grid) && /<span class="out" hidden data-hay="topotopo\/props\/barrel [^"]*"><code>topotopo\/props\/barrel<\/code>/.test(props) && /src="\/p\/topotopo\/props\/thumb\.png\?v=1\.0"/.test(props),
      'TopoTopo\'s built-in library is a library on the grid, the last one, and its cards\' search finds their outputs');
    const pp = (await req('/p/topotopo/props')).body.toString();
    check(/<h1>Props<\/h1>/.test(pp) && /class="pkgline">Package <span class="pkg"[^>]*>topotopo\/props 1\.0<\/span>/.test(pp) && /<img class="othumb" src="\/p\/topotopo\/props\/thumbs\/barrel\.png"[^>]*><code>topotopo\/props\/barrel<\/code>/.test(pp)
      && /<h2>Used by <span class="count">0<\/span>/.test(pp) && /One of TopoTopo&#39;s own packages: every package can use its outputs/.test(pp) && !/Open in editor|data-post="bake"/.test(pp),
      'a built-in package has the package page: its versions, its outputs with their thumbnails, the packages that use it, nothing to edit or bake');
    const th = await req('/p/topotopo/props/thumbs/barrel.png'), thumb = await req('/p/topotopo/props/thumb.png');
    check(th.status === 200 && th.headers['content-type'] === 'image/png' && thumb.status === 200 && thumb.body.length > 1000 && (await req('/p/topotopo/props/thumbs/..%2Fprops.topo')).status === 404
      && (await req('/p/topotopo/nope')).status === 404 && (await req('/p/topotopo/props/bake', { method: 'POST' })).status === 400,
      'a built-in package\'s thumbnails are served (its card shows one of its outputs\'), nothing else of its folder, and it is not baked here');
    edit(forest.dir, (m) => { m.uses = { ...m.uses, 'topotopo/props': '1.0' }; });
    g.rescan();
    const user2 = (await req('/p/game/forest')).body.toString();
    check(/<th><a href="\/p\/topotopo\/props">topotopo\/props<\/a><\/th><td>1\.0<\/td>/.test(user2) && /<a href="\/p\/game\/forest">Forest<\/a>/.test((await req('/p/topotopo/props')).body.toString()),
      'a package\'s page links the built-in packages it uses, and the built-in package\'s page lists the package');
    const api = JSON.parse((await req('/api/packages')).body.toString());
    check(JSON.stringify(api.packages.find((x: any) => x.id === 'trees')?.package) === '{"name":"studio/trees","version":"1.1"}' && api.packages.find((x: any) => x.id === 'forest')?.package === undefined,
      '/api/packages names the packages too');
  }

  section('workspaces: on the front page with their packages, which have pages of their own, and among the users of a package');
  {
    const ws = path.join(tmp, 'valley');
    fs.mkdirSync(path.join(ws, 'scenes', 'hall'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'topotopo-workspace.json'), JSON.stringify({ name: 'valley', libraries: ['game'], engine: { type: 'godot', project: 'game/project.godot' }, uses: { 'topotopo/props': '1.0' } }));
    fs.writeFileSync(path.join(ws, 'scenes', 'hall', 'hall.topo'), JSON.stringify({ title: 'Pump hall' }));
    // a library registered inside the workspace: shown once, as the workspace's
    const art = { name: 'valley-art', path: path.join(ws, 'art') };
    createPackage(art, 'rugs/rug', { title: 'Rug', graph: BOX });
    cfg.libraries.push(art);
    cfg.workspaces.push({ name: 'valley', path: ws });
    g.rescan();
    const home = (await req('/')).body.toString();
    const block = home.slice(home.indexOf('id="workspaces"'), home.indexOf('id="lib-'));
    check(home.indexOf('id="ws-valley"') > 0 && home.indexOf('id="ws-valley"') < home.indexOf('id="lib-game"') && /Godot · game\/project\.godot<\/span>/.test(block) && !/exports to/.test(block)
      && /<a href="\/p\/valley\/hall">Pump hall<\/a>/.test(block) && /<a href="\/p\/valley\/rug">Rug<\/a>/.test(block) && /<th>Shared libraries<\/th><td>game<\/td>/.test(block) && /<a href="\/p\/topotopo\/props">topotopo\/props<\/a> 1\.0/.test(block),
      `the front page lists the workspace first: its engine (no word on where exports go), its shared libraries, its packages linked to their pages, the packages it uses (${block.replace(/\s+/g, ' ').slice(0, 900)})`);
    check(!/id="lib-valley-art"/.test(home), 'a registered library inside a registered workspace shows once, as the workspace\'s');
    const page = await req('/p/valley/hall');
    check(page.status === 200 && /Pump hall/.test(page.body.toString()) && /in the workspace &quot;valley&quot;/.test(page.body.toString()), 'a workspace\'s package has a page of its own at /p/<workspace>/<id>');
    check((await req('/p/valley/rug')).status === 200, 'and so does the package of the library inside it, as the workspace\'s');
    check(/<a href="\/#ws-valley">workspace valley<\/a><\/th><td>1\.0<\/td><td class="dim">workspace<\/td>/.test((await req('/p/topotopo/props')).body.toString()), 'a built-in package\'s users include the workspaces that use it');
    cfg.workspaces.length = 0;
    cfg.libraries.pop();
    g.rescan();
  }

  section('templates');
  {
    check(esc(`<a href="x">'&`) === '&lt;a href=&quot;x&quot;&gt;&#39;&amp;', 'esc');
    const u = { home: '/', package: () => '/p', thumb: () => '/t', glb: () => '/g', embed: () => '/e', file: () => '/f', edit: () => null, asset: (n: string) => n, app: (n: string) => n, three: '/3/' };
    const html = frontPage({ libraries: [], problems: ['<script>'] }, u);
    check(html.includes('&lt;script&gt;') && html.includes('library add'), 'problems are escaped; an empty web app says how to add a library');
  }
} finally {
  g.close();
}

console.log(`\n${passes} passed, ${failures} failed — temp ${tmp}`);
process.exit(failures ? 1 : 0);
