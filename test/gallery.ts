// The gallery web server (src/gallery/server.ts): the grid, a project page, thumbnails (a placeholder before the first
// bake), preview.glb, the embed page, attachments (inside the project only, scripts never inline), /api/projects
// (CORS only for listed origins), framing headers, the Host and Origin checks, a bake from a file change, and the
// pages' templates escaping what they show.
//   node test/gallery.ts
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createProject } from '../src/gallery/library.ts';
import type { GalleryConfig } from '../src/gallery/library.ts';
import { startGallery, runningGallery } from '../src/gallery/server.ts';
import { esc, galleryPage } from '../src/gallery/pages.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'topotopo-gallery-'));
let failures = 0, passes = 0;
const check = (cond: any, msg: string) => { if (cond) passes++; else failures++; console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); };
const section = (s: string) => console.log(`\n== ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (pred: () => boolean | Promise<boolean>, ms: number) => { const t0 = Date.now(); while (!(await pred()) && Date.now() - t0 < ms) await sleep(100); return pred(); };

const lib = { name: 'game', path: path.join(tmp, 'lib') };
fs.mkdirSync(lib.path);
const BOX = { nodes: { b: { type: 'box' } }, output: 'b' };
const crate = createProject(lib, 'props/crate', { title: 'Crate <b>&', tags: ['props'], graph: BOX, links: [{ label: 'board', url: 'http://board.local/x' }] });
fs.writeFileSync(path.join(crate.dir, 'attachments', 'concept.png'), fs.readFileSync(path.resolve('shelf/thumbs/crate.png')));
fs.writeFileSync(path.join(crate.dir, 'attachments', 'evil.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
fs.writeFileSync(path.join(tmp, 'secret.txt'), 'secret');
const cfg: GalleryConfig = { file: path.join(tmp, 'config.json'), libraries: [lib], gallery: { port: 0, cors: ['http://board.local:3000'] } };

const g = await startGallery({ config: cfg, port: 0 });
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
    check(home.status === 200 && html.includes('href="/p/game/crate"') && html.includes('Crate &lt;b&gt;&amp;'), 'the grid links the project and escapes its title');
    check(home.headers['content-security-policy'] === "frame-ancestors 'self'", 'pages are not framed by other sites');
    const page = await req('/p/game/crate');
    const ph = page.body.toString();
    check(page.status === 200 && ph.includes('concept.png') && ph.includes('http://board.local/x') && ph.includes(`http://127.0.0.1:${g.port}/embed/game/crate`), 'the project page: attachments, links, the embed snippet with the absolute URL');
    check((await req('/p/game/nope')).status === 404, 'an unknown project is 404');
    check((await req('/static/gallery.css')).status === 200 && (await req('/app/embed.js')).status === 200 && (await req('/vendor/three/build/three.module.js')).status === 200, 'styles, the embed module and three.js are served');
    check((await req('/static/../server.ts')).status === 404, 'no files outside the static folder');
    const health = JSON.parse((await req('/api/health')).body.toString());
    check(health.gallery === true && health.projects === 1, 'health');
    check(await runningGallery(g.port) === g.url, 'runningGallery recognises it');
  }

  section('bake on start, thumbnails, preview.glb, embed');
  {
    check(await until(() => fs.existsSync(path.join(crate.dir, '.gallery', 'preview.glb')) && g.queue.size === 0, 60000), 'a never-baked project is baked on start');
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
    const list = await req('/api/projects', { headers: { origin: 'http://board.local:3000' } });
    const j = JSON.parse(list.body.toString());
    check(list.headers['access-control-allow-origin'] === 'http://board.local:3000' && j.projects[0].embed === `http://127.0.0.1:${g.port}/embed/game/crate`, 'a listed board origin may read the project list');
    check(!JSON.stringify(j).includes(tmp.replace(/\\/g, '\\\\')), 'the list has no absolute paths');
    const other = await req('/api/projects', { headers: { origin: 'http://evil.example' } });
    check(!other.headers['access-control-allow-origin'], 'other origins get no CORS header');
    check((await req('/', { headers: { host: 'evil.example' } })).status === 403, 'a foreign Host is refused (DNS rebinding)');
    check((await req('/p/game/crate/bake', { method: 'POST', headers: { origin: 'http://evil.example' } })).status === 403, 'a cross-site POST is refused');
    check((await req('/p/game/crate/bake')).status === 405, 'bake needs POST');
  }

  section('changes');
  {
    const at0 = JSON.parse(fs.readFileSync(path.join(crate.dir, '.gallery', 'bake.json'), 'utf8')).at;
    fs.writeFileSync(path.join(crate.dir, 'graphs', 'main.json'), JSON.stringify({ nodes: { b: { type: 'sphere' } }, output: 'b' }));
    const rebaked = await until(() => { try { return JSON.parse(fs.readFileSync(path.join(crate.dir, '.gallery', 'bake.json'), 'utf8')).at !== at0; } catch { return false; } }, 30000);
    check(rebaked, 'a graph saved by another process is baked again');
    createProject(lib, 'props/barrel', { graph: BOX });
    check(await until(async () => JSON.parse((await req('/api/health')).body.toString()).projects === 2, 10000), 'a new project folder appears');
    check((await req('/p/game/barrel')).status === 200, 'and has its page');
  }

  section('templates');
  {
    check(esc(`<a href="x">'&`) === '&lt;a href=&quot;x&quot;&gt;&#39;&amp;', 'esc');
    const u = { home: '/', project: () => '/p', thumb: () => '/t', glb: () => '/g', embed: () => '/e', file: () => '/f', edit: () => null, asset: (n: string) => n, app: (n: string) => n, three: '/3/' };
    const html = galleryPage({ libraries: [], problems: ['<script>'] }, u);
    check(html.includes('&lt;script&gt;') && html.includes('library add'), 'problems are escaped; an empty gallery says how to add a library');
  }
} finally {
  g.close();
}

console.log(`\n${passes} passed, ${failures} failed — temp ${tmp}`);
process.exit(failures ? 1 : 0);
