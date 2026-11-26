// The web app server (src/web/server.ts) and its folder pages (src/web/folders.ts, folder-page.ts, markdown.ts).
// First a library whose previews bake: the front page (workspaces and libraries as cards, the search over every
// package and output), a package's folder page (reached by its stable address /p/<library>/<id>), thumbnails (a
// placeholder before the first bake), preview.glb, the embed page, attachments (inside the package only, scripts never
// inline), /api/packages (CORS only for listed origins), framing headers, the Host and Origin checks, a bake from a file
// change, a package's versions and outputs and the packages it uses, TopoTopo's built-in library, the registered
// workspaces (their packages, found by scanning them; a registered library inside one shown as the workspace's).
// Then a workspace and an Unreal library whose previews do not bake, as folder pages: the routes, the notes (markdown
// rendered and escaped, links by what they lead to: relative, res://, /Game/, missing, YouTube and Vimeo), files by
// type, the plumbing never shown, the engine project shown and not audited, containment ("..", encoded "..", absolute
// paths, dot paths, a link leading out), ranges, media types, the flags (broken links, a preview that did not cook,
// versions not published, an export older than its graph, outputs nobody uses) rolled up into folder and front-page
// cards, and the old routes still answering. Then what a note link may never do (look up a network share, a path
// outside the tree, plumbing by another name), and the page's look in its markup. Last the markdown renderer and the
// link rules alone.
//   node test/web.ts
import './cache-guard.ts';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { createPackage } from '../src/web/library.ts';
import { BUILTIN_LIBRARY } from '../src/config.ts';
import type { WebConfig } from '../src/config.ts';
import { startWeb, runningWeb } from '../src/web/server.ts';
import type { WebServer } from '../src/web/server.ts';
import type { BakeState } from '../src/web/library.ts';
import { builtinLibrary, workingHash } from '../src/packages/registry.ts';
import { esc, frontPage, previewRowWords, previewSummary, runningWords } from '../src/web/pages.ts';
import type { PreviewItem, PreviewsData } from '../src/web/pages.ts';
import { folderPage } from '../src/web/folder-page.ts';
import { markdownLinks, renderMarkdown } from '../src/web/markdown.ts';
import { exportSources, exportStale, imageSize, linkText, listFolder, PathError, resolveIn, resolveLink, videoPlayer, walkTree } from '../src/web/folders.ts';
import { canonicalJSON } from '../src/io/source.ts';
import { sha256Hex } from '../src/core/sha256.ts';
import { CACHE_MAX_BYTES } from '../src/host/cook.ts';
import { NODE_CACHE_MAX_BYTES } from '../src/host/diskcache.ts';
import { TOPOTOPO_VERSION, isNewerVersion } from '../src/host/version.ts';
import { editCommand, editorIdleTick } from '../src/packages/commands.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'topotopo-web-'));
// a config of its own: the libraries registered on this machine play no part
process.env.TOPOTOPO_CONFIG = path.join(tmp, 'config.json');
process.env.TOPOTOPO_PORT = '0';
delete process.env.TOPOTOPO_LIBRARIES;
fs.writeFileSync(process.env.TOPOTOPO_CONFIG, JSON.stringify({ libraries: [{ name: 'game', path: path.join(tmp, 'lib') }] }));
let failures = 0, passes = 0;
const check = (cond: any, msg: string) => { if (cond) passes++; else failures++; console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); };
const section = (s: string) => console.log(`\n== ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (pred: () => boolean | Promise<boolean>, ms: number) => { const t0 = Date.now(); while (!(await pred()) && Date.now() - t0 < ms) await sleep(100); return pred(); };
function bakeState(dir: string): BakeState | null {
  try { return JSON.parse(fs.readFileSync(path.join(dir, '.web', 'bake.json'), 'utf8')); } catch { return null; }
}
const write = (file: string, v: string | Buffer | object) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof v === 'string' || Buffer.isBuffer(v) ? v : JSON.stringify(v)); };

const lib = { name: 'game', path: path.join(tmp, 'lib') };
/** TopoTopo's built-in packages, a library the web app always shows */
const BUILTIN = builtinLibrary().length;
fs.mkdirSync(lib.path);
const BOX = { nodes: { b: { type: 'box' } }, output: 'b' };
const PNG = fs.readFileSync(path.resolve('library/props/thumbs/crate.png'));
const crate = createPackage(lib, 'props/crate', { title: 'Crate <b>&', tags: ['props'], graph: BOX, links: [{ label: 'board', url: 'http://board.local/x' }] });
fs.writeFileSync(path.join(crate.dir, 'attachments', 'concept.png'), PNG);
fs.writeFileSync(path.join(crate.dir, 'attachments', 'evil.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
fs.writeFileSync(path.join(tmp, 'secret.txt'), 'secret');
const cfg: WebConfig = { file: path.join(tmp, 'config.json'), libraries: [lib], workspaces: [], web: { port: 0, cors: ['http://board.local:3000'] } };

// the pages here read flags: they wait for each audit however long a busy machine takes
const g = await startWeb({ config: cfg, port: 0, auditWait: 60_000 });
const bakeDetails = (state: BakeState | null) => `queue size ${g.queue.size}, ${state?.error ?? (state ? 'no bake error' : 'no bake.json yet')}`;
let f: WebServer | null = null;
type Res = { status: number; headers: http.IncomingHttpHeaders; body: Buffer };
const reqAt = (port: number, p: string, o: { method?: string; headers?: Record<string, string> } = {}) => new Promise<Res>((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, method: o.method ?? 'GET', headers: o.headers }, (res) => {
    const chunks: Buffer[] = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
  });
  r.on('error', reject);
  r.end();
});
const req = (p: string, o: { method?: string; headers?: Record<string, string> } = {}) => reqAt(g.port, p, o);
/** a page, following the redirects of stable addresses */
const page = async (p: string, port = g.port): Promise<Res & { url: string }> => {
  let url = p;
  for (let i = 0; i < 5; i++) {
    const r = await reqAt(port, url);
    if (r.status >= 300 && r.status < 400 && r.headers.location) { url = r.headers.location; continue; }
    return { ...r, url };
  }
  throw new Error(`too many redirects from ${p}`);
};

try {
  section('the installed built-in library');
  {
    const source = BUILTIN_LIBRARY.path;
    const installed = path.join(tmp, 'installed', 'library');
    const nature = path.join(installed, 'nature');
    fs.cpSync(path.join(source, 'nature', 'versions'), path.join(nature, 'versions'), { recursive: true });
    // A release has no working manifest. Stage the thumbnails separately so this also exercises serving them.
    fs.cpSync(path.join(source, 'nature', 'thumbs'), path.join(nature, 'thumbs'), { recursive: true });
    BUILTIN_LIBRARY.path = installed;
    try {
      f = await startWeb({ config: { ...cfg, libraries: [], workspaces: [] }, port: 0, bake: false, auditWait: 60_000 });
      const home = (await reqAt(f.port, '/')).body.toString();
      const search = /href="([^"]+)" data-key="topotopo\/nature"[\s\S]*?data-hay="topotopo\/nature\/tree_lowpoly/.exec(home);
      const found = search && await page(search[1], f.port);
      const version = await page('/l/topotopo/nature/versions/1.0/', f.port);
      check(found?.status === 200 && /<h1>Nature<\/h1>/.test(found.body.toString())
        && /<img class="othumb" src="\/p\/topotopo\/nature\/thumbs\/tree_lowpoly\.png"/.test(found.body.toString())
        && /Use in a new package/.test(found.body.toString()) && !/Open in editor|data-post="[^"]*bake"/.test(found.body.toString()),
        `the search link for tree_lowpoly opens a read-only built-in package page with previews (${found?.url})`);
      check(version.url === found?.url && !version.body.includes('none of the packages of the library'),
        `a published version folder leads to its built-in package page (${version.url}${version.body.includes('none of the packages of the library') ? ': none of the packages of the library' : ''})`);
      const thumb = await reqAt(f.port, '/p/topotopo/nature/thumb.png');
      check(thumb.status === 200 && thumb.body.length > 1000, 'the search card serves the packaged thumbnail when it is present');
    } finally { f?.close(); f = null; BUILTIN_LIBRARY.path = source; }
  }

  section('the running bar and the status');
  {
    const res = await req('/api/status');
    const status = JSON.parse(res.body.toString());
    check(res.status === 200 && status.ok === true && status.stoppable === false && status.baking === g.queue.size
      && Number.isInteger(status.memory) && status.memory > 0 && Array.isArray(status.editors) && status.editors.length === 0,
      'the status reports the web app memory, bake queue, editors and whether it can stop');
    check((await req('/api/status', { headers: { host: 'other.example' } })).status === 403
      && !(await req('/api/status', { headers: { origin: 'http://other.example' } })).headers['access-control-allow-origin'],
      'the status has the same Host and Origin rules as other API reads');
    const pages = await Promise.all([req('/'), page('/p/game/crate'), req('/l/no-such-library/')]);
    check(pages.every((r) => (r.body.toString().match(/<footer class="running"/g) ?? []).length === 1
      && r.body.includes('An editor stops by itself 10 minutes after its last tab is closed.')
      && r.body.includes('Stops TopoTopo and its editors. Open a file to start it again.')), 'every shell page carries one running bar with the editor and stop tooltips');
    const small = runningWords('120 MB'), large = runningWords('1.3 GB', '2');
    check(small.running + small.memory === 'TopoTopo is running · 120 MB', 'the running text gives the memory without an editor count');
    check(large.running + large.editors + large.memory === 'TopoTopo is running · 2 editors open · 1.3 GB',
      'the running text gives the editor count and memory');
    check(small.editor === ' · 1 editor open', 'the running text uses singular for one editor');
    check(small.stopped === 'TopoTopo has stopped. Open a file to start it again.', 'the stopped text says to open a file again');
    check(small.lost === 'TopoTopo is not running any more. Open a file to start it again.', 'the lost-contact text says the web app is gone');
  }

  section('preview words');
  {
    const item: PreviewItem = { package: 'props/harbour', title: 'Harbour', url: '/l/props/harbour/', state: 'waiting' };
    check(previewRowWords(item, 0) === 'waiting · next' && previewRowWords(item, 1) === 'waiting · 2 before it'
      && previewRowWords(item, 1, Date.now(), false) === 'waiting · 1 before it', 'waiting previews show their place in line (the one being made counts, none while paused)');
    const current: PreviewItem = { ...item, state: 'baking', startedAt: 1000 };
    check(previewRowWords(current, 0, 13_000) === 'making its preview · 12 s'
        && previewRowWords(current, 0, 14_000) === 'making its preview · 13 s', 'the current preview shows elapsed time');
    check(previewRowWords({ ...item, state: 'done', ms: 8400 }, 0) === 'made in 8.4 s'
        && previewRowWords({ ...item, state: 'done', ms: 125_000 }, 0) === 'made in 2 min 05 s', 'a finished preview shows how long it took');
    check(previewRowWords({ ...item, state: 'failed', error: 'no geometry' }, 0) === 'could not make its preview: no geometry', 'a failed preview says why');
    check(previewRowWords({ ...item, state: 'skipped' }, 0) === 'skipped: it keeps its old preview, and is made again when it changes or on Re-bake',
      'a skipped preview says what happens to it');
    const empty: PreviewsData = { items: [], paused: false, done: 0, total: 0, failed: 0, skipped: 0 };
    const active = { ...empty, items: [current], done: 3, total: 7, leftMs: 90_000 };
    check(previewSummary(empty) === "No previews to make. TopoTopo makes a package's preview by itself when the package changes.", 'the page explains why it is empty');
    check(previewSummary(active) === '3 of 7 previews made · making Harbour · about 2 min left'
      && previewSummary({ ...active, leftMs: 1200, failed: 1 }) === '3 of 7 previews made · making Harbour · about 2 s left · 1 failed',
      'the progress line has the count, current preview, estimate and failures');
    check(previewSummary({ ...active, paused: true }) === '3 of 7 previews made · paused: the preview being made finishes, the others wait',
      'the paused line says what happens to the previews');
    const finishedAt = new Date(2020, 0, 1, 14, 2).getTime();
    check(previewSummary({ ...empty, total: 8, done: 7, failed: 1 }, finishedAt) === '7 previews made at 14:02 · 1 failed',
      'the finished line gives the time and failed count');
    const bar = { done: 3, total: 7, active: 4, waiting: true, paused: false };
    check(runningWords(undefined, undefined, bar).previews === ' · making previews: 3 of 7'
      && runningWords(undefined, undefined, { ...bar, paused: true }).previews === ' · previews paused'
      && runningWords(undefined, undefined, { ...bar, active: 1, waiting: false, paused: true }).previews === ' · making previews: 3 of 7'
      && runningWords(undefined, undefined, { ...bar, active: 0, waiting: false }).previews === '',
      'the bar shows progress, says paused only while something waits, and clears the finished round');
  }

  section('preview pages and actions');
  {
    const library = { name: 'previews', path: path.join(tmp, 'preview-pages') };
    const first = createPackage(library, 'first', { title: 'First', graph: BOX });
    const second = createPackage(library, 'second', { title: 'Second <&>', graph: BOX });
    const web = await startWeb({ config: { ...cfg, libraries: [library] }, port: 0, bake: false });
    const get = (url: string) => reqAt(web.port, url);
    const json = async (url: string) => JSON.parse((await get(url)).body.toString());
    const post = (action: string, pkg?: string, guarded = true, origin?: string) => fetch(new URL('/api/bakes', web.url), {
      method: 'POST', headers: { ...(guarded ? { 'x-topotopo-open': '1' } : {}), ...(origin ? { origin } : {}) },
      body: JSON.stringify({ action, package: pkg }),
    });
    const got = { text: '' };
    const stream = http.get(new URL('/api/events', web.url), (res) => res.on('data', (c) => { got.text += c; }));
    stream.on('error', () => {});
    const events = () => got.text.split('\n\n').slice(0, -1).filter((s) => s.startsWith('data: ')).map((s) => JSON.parse(s.slice(6)));
    try {
      const initial = await get('/api/bakes');
      check(initial.status === 200 && JSON.parse(initial.body.toString()).total === 0, 'GET /api/bakes reports an empty list');
      const empty = await get('/previews');
      check(empty.status === 200 && empty.body.toString().includes('No previews to make. TopoTopo makes a package&#39;s preview by itself when the package changes.')
        && empty.body.includes('id="running-previews" href="/previews"'), 'the Previews page starts with the empty words and the bar links to it');
      check((await post('pause', undefined, false)).status === 403
        && (await post('pause', undefined, true, 'http://other.example')).status === 403
        && (await reqAt(web.port, '/api/bakes', { headers: { host: 'other.example' } })).status === 403
        && (await reqAt(web.port, '/api/bakes', { method: 'PUT', headers: { 'x-topotopo-open': '1' } })).status === 405,
        'preview actions require the page header, a local Host and Origin, and POST');
      await until(() => events().some((e) => e.bakes && !e.bakes.paused), 10_000);
      const pause = await post('pause');
      check(pause.status === 200 && ((await pause.json()) as PreviewsData).paused && await until(() => events().some((e) => e.bakes?.paused), 10_000),
        'Pause responds with the new state and sends it on the event stream');
      check(web.queue.add(first.dir) && web.queue.add(second.dir), 'packages can be added while paused');
      const reBake = await reqAt(web.port, '/p/previews/second/bake', { method: 'POST' });
      const waiting = await json('/api/bakes');
      check(reBake.status === 200 && JSON.parse(reBake.body.toString()).queued && waiting.items.map((x: PreviewItem) => x.package).join() === 'previews/second,previews/first'
        && waiting.items.every((x: PreviewItem) => x.state === 'waiting' && !('dir' in x)), 'Re-bake puts a waiting preview first and the API uses package names and links');
      const list = await get('/previews');
      check(list.status === 200 && list.body.includes('href="/l/previews/second/">Second &lt;&amp;&gt;</a>') && list.body.includes('waiting · next')
        && list.body.includes('waiting · 1 before it') && !list.body.includes('waiting · 2 before it') && list.body.includes('>Resume</button>') && list.body.includes('>Skip</button>'), 'the Previews page links each waiting package and offers Resume and Skip');
      const home = await get('/');
      const folder = await page('/p/previews/first', web.port);
      const status = await json('/api/status');
      check(home.body.includes('>waiting to bake</span>') && folder.body.includes('Waiting to bake…')
        && status.baking === 2 && status.bakes.total === 2 && status.bakes.done === 0 && status.bakes.paused && !status.bakes.current,
        'cards, folder pages and status distinguish waiting previews from the one being made');
      const unknown = await post('skip', 'previews/missing');
      const badAction = await post('other');
      check(unknown.status === 400 && ((await unknown.json()) as { error: string }).error === 'That package was not found.'
        && badAction.status === 400 && ((await badAction.json()) as { error: string }).error === 'Choose Pause, Resume, or Skip.', 'unknown packages and actions get plain errors');
      const skipped = await post('skip', 'previews/first');
      check(skipped.status === 200 && ((await skipped.json()) as PreviewsData).skipped === 1
        && await until(() => events().some((e) => e.bakes?.skipped === 1 && e.cards.some((c: { status: string }) => c.status === 'new')), 10_000),
        'Skip removes a waiting preview and the event stream restores its card status');
      const resumed = await post('resume');
      check(resumed.status === 200 && !((await resumed.json()) as PreviewsData).paused && await until(() => events().some((e) => !e.bakes?.paused
        && e.bakes?.items.some((i: PreviewItem) => i.state === 'baking') && e.cards.some((c: { status: string; line: string }) => c.status === 'baking' && c.line === 'Baking…')), 10_000),
        'Resume starts the next preview and the event stream says it is baking');
      const running = await json('/api/status');
      check(running.bakes.total === 2 && (running.baking ? running.bakes.current.title === second.manifest.title && running.bakes.current.ms >= 0
        : running.bakes.done === 1), 'status gives the title and elapsed time of the current preview');
      if (web.queue.pending(second.dir)) await post('skip', 'previews/second');
      await web.queue.idle();
    } finally { stream.destroy(); web.close(); }
  }

  section('skipped previews and file changes');
  {
    const library = { name: 'previews', path: path.join(tmp, 'preview-changes') };
    const p = createPackage(library, 'crate');
    const web = await startWeb({ config: { ...cfg, libraries: [library] }, port: 0 });
    const graph = path.join(p.dir, 'graphs', 'main.json');
    const packageUrl = '/p/previews/crate';
    const skip = () => fetch(new URL('/api/bakes', web.url), {
      method: 'POST', headers: { 'x-topotopo-open': '1' }, body: JSON.stringify({ action: 'skip', package: 'previews/crate' }),
    });
    try {
      web.queue.pause();
      write(graph, BOX);
      check(await until(() => web.queue.state(p.dir) === 'waiting', 20_000) && (await skip()).status === 200, 'an automatically requested preview can be skipped');
      check((await reqAt(web.port, `${packageUrl}/thumb.png`)).status === 200
        && (await reqAt(web.port, `${packageUrl}/preview.glb`)).status === 404
        && web.queue.state(p.dir) === 'skipped' && !bakeState(p.dir), 'requests for missing previews do not ask for the skipped package again');
      write(graph, { nodes: { b: { type: 'sphere' } }, output: 'b' });
      check(await until(() => web.queue.state(p.dir) === 'waiting', 20_000), 'changing a skipped package asks for its preview again');
      const skippedAgain = await skip();
      const manual = await reqAt(web.port, `${packageUrl}/bake`, { method: 'POST' });
      check(skippedAgain.status === 200 && manual.status === 200 && web.queue.state(p.dir) === 'waiting', 'Re-bake also asks for a skipped preview again');
    } finally { web.close(); }
  }

  section('storage and version');
  {
    const storage = { nodes: path.join(tmp, 'storage-nodes'), cooks: path.join(tmp, 'storage-cooks') };
    for (const dir of Object.values(storage)) fs.mkdirSync(dir);
    const scratch = fs.realpathSync(tmp);
    const safe = Object.values(storage).every((dir) => {
      const rel = path.relative(scratch, fs.realpathSync(dir));
      return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
    });
    check(safe, 'both cache folders are inside this test’s temporary folder');
    if (!safe) throw new Error('refusing to clear a cache outside the temporary folder');

    write(path.join(storage.nodes, 'one.ttnode'), 'node');
    write(path.join(storage.nodes, 'two.ttnode'), 'result');
    write(path.join(storage.nodes, 'one.123.abcd.tmp'), 'tmp');
    write(path.join(storage.nodes, 'engine.json'), '{}');
    write(path.join(storage.nodes, 'keep.txt'), 'keep');
    write(path.join(storage.nodes, 'other', 'three.ttnode'), 'keep');
    const entry = 'a'.repeat(64);
    write(path.join(storage.cooks, 'blobs', 'b'.repeat(64)), 'blob');
    write(path.join(storage.cooks, 'blobs', 'c'.repeat(64)), 'blobs');
    write(path.join(storage.cooks, entry, 'manifest.json'), '{}');
    write(path.join(storage.cooks, 'keep.txt'), 'keep');
    write(path.join(storage.cooks, 'other', 'keep.txt'), 'keep');
    const library = { name: 'storage', path: path.join(tmp, 'storage-library') };
    const p = createPackage(library, 'sample', { graph: BOX });
    write(path.join(p.dir, '.web', 'preview.glb'), 'preview');
    write(path.join(p.dir, 'versions', '1.0.0', 'sample.topo'), 'version');
    write(path.join(p.dir, 'packages', 'example', 'sample', '1.0.0', 'sample.topo'), 'copy');
    const options = { config: { ...cfg, libraries: [library] }, port: 0, bake: false, storage };
    let latestCalls = 0;
    const web = await startWeb({ ...options, latestVersion: async () => { latestCalls++; return '99.0.0'; } });
    try {
      const home = await reqAt(web.port, '/'), stored = await reqAt(web.port, '/storage');
      const bar = (r: Res) => r.body.toString().match(/<footer class="running"[^>]*>[\s\S]*?<\/footer>/)?.[0] ?? '';
      const versionText = `version ${TOPOTOPO_VERSION}`;
      check(home.status === 200 && stored.status === 200, 'home and Storage answer');
      check(bar(home).includes(`${versionText} · <a href="/storage">Storage</a>`)
        && bar(stored).includes(`${versionText} · Storage`) && !bar(stored).includes('href="/storage"'),
        'both running bars give the version and only the home bar links to Storage');
      check(stored.body.includes('<h1>Storage</h1>') && ['Results of slow nodes', 'Cooked files for game engines', 'Previews', 'Published versions']
        .every((name) => stored.body.includes(`<h2>${name}</h2>`)), 'Storage names all four rows');
      check(latestCalls === 0, 'opening the pages does not look up the latest version');

      const getStorage = () => reqAt(web.port, '/api/storage');
      const initial = await getStorage();
      const own = [{ id: 'previews', bytes: 7, packages: 1, clear: false }, { id: 'versions', bytes: 11, packages: 1, clear: false }];
      const cacheItems = [
        { id: 'nodes', bytes: 15, files: 4, limit: NODE_CACHE_MAX_BYTES, dir: storage.nodes, clear: true },
        { id: 'cooks', bytes: 11, files: 3, limit: CACHE_MAX_BYTES, dir: storage.cooks, clear: true },
      ];
      check(initial.status === 200 && canonicalJSON(JSON.parse(initial.body.toString())) === canonicalJSON({ ok: true, items: [...cacheItems, ...own] }),
        'Storage gives the exact cache totals and paths and measures only the listed package’s previews and versions');
      const clear = (what: string, guarded = true) => fetch(new URL('/api/storage/clear', web.url), {
        method: 'POST', headers: { 'content-type': 'application/json', ...(guarded ? { 'x-topotopo-open': '1' } : {}) },
        body: JSON.stringify({ what }),
      });
      check((await reqAt(web.port, '/api/storage/clear')).status === 405, 'clearing storage needs POST');
      check((await clear('nodes', false)).status === 403, 'clearing storage needs the page’s header');
      check((await clear('home')).status === 400, 'only the two caches can be cleared');
      for (const item of cacheItems) {
        const res = await clear(item.id), body = await res.json();
        check(res.status === 200 && canonicalJSON(body) === canonicalJSON({ ok: true, freed: item.bytes }), `clearing ${item.id} reports the bytes freed`);
        check(fs.readdirSync(item.dir).sort().join(',') === 'keep.txt,other', `clearing ${item.id} leaves the other file and folder`);
        const after = await getStorage();
        check(after.status === 200 && JSON.parse(after.body.toString()).items.some((x: { id: string; bytes: number; files: number }) =>
          x.id === item.id && x.bytes === 0 && x.files === 0), `Storage measures ${item.id} as empty after clearing`);
      }
      const res = await reqAt(web.port, '/api/version/latest');
      check(res.status === 200 && canonicalJSON(JSON.parse(res.body.toString())) === canonicalJSON({
        ok: true, current: TOPOTOPO_VERSION, latest: '99.0.0', newer: true,
      }) && latestCalls === 1, 'a newer version is reported when asked');
    } finally { await web.close(); }

    const current = await startWeb({ ...options, latestVersion: async () => TOPOTOPO_VERSION });
    try {
      const res = await reqAt(current.port, '/api/version/latest');
      check(res.status === 200 && canonicalJSON(JSON.parse(res.body.toString())) === canonicalJSON({
        ok: true, current: TOPOTOPO_VERSION, latest: TOPOTOPO_VERSION, newer: false,
      }), 'the installed version can already be the newest');
    } finally { await current.close(); }
    const offline = await startWeb({ ...options, latestVersion: async () => { throw new Error('offline'); } });
    try {
      const res = await reqAt(offline.port, '/api/version/latest');
      check(res.status === 200 && canonicalJSON(JSON.parse(res.body.toString())) === canonicalJSON({
        ok: false, error: 'npmjs.com could not be reached: offline',
      }), 'a failed version check says why');
    } finally { await offline.close(); }

    check([['0.6.0', '0.5.3'], ['0.5.10', '0.5.9'], ['1.0.0', '0.99.99']].every(([a, b]) => isNewerVersion(a, b)),
      'major, minor and patch number increases each count as newer');
    check([['0.5.3', '0.5.3'], ['0.5.2', '0.5.3'], ['0.6.0-beta.1', '0.6.0'], ['latest', '0.5.3'], ['', '0.5.3']]
      .every(([a, b]) => !isNewerVersion(a, b)), 'equal, older and invalid versions are never newer, and suffixes are ignored');
  }

  section('an editor starts behind a page');
  {
    const editorLib = { name: 'editor', path: path.join(tmp, 'editor-lib') };
    const good = createPackage(editorLib, 'good', { title: 'Test <editor>', graph: BOX });
    const broken = createPackage(editorLib, 'broken', { graph: BOX });
    fs.rmdirSync(path.join(broken.dir, 'inputs'));
    write(path.join(broken.dir, 'inputs'), 'a file in place of the inputs folder');
    let stopped = false;
    const web = await startWeb({ config: { ...cfg, libraries: [editorLib], workspaces: [] }, port: 0, bake: false, onStop: () => { stopped = true; } });
    const get = (p: string) => reqAt(web.port, p);
    const status = async () => JSON.parse((await get('/api/status')).body.toString());
    const editUrl = `/p/editor/${good.id}/edit`, brokenUrl = `/p/editor/${broken.id}/edit`;
    const wait = async (url: string) => {
      const r = await get(`${url}?wait=1`);
      return { status: r.status, ...JSON.parse(r.body.toString()) };
    };
    try {
      check((await status()).stoppable === true, 'the status offers Stop TopoTopo when the web app can be stopped');
      const at = performance.now(), start = await get(editUrl), ms = performance.now() - at;
      check(start.status === 200 && start.headers['content-type']?.startsWith('text/html') && ms < 2000
        && start.body.includes('Starting the editor for Test &lt;editor&gt;…') && start.body.includes('The first start of a large package can take a minute.')
        && start.body.includes('<footer class="running"'), `the editor returns a starting page at once (${Math.round(ms)} ms)`);
      const starting = await wait(editUrl);
      check(starting.status === 200 && starting.ok && starting.starting === true, 'the editor status says that it is starting');
      let url = '';
      check(await until(async () => { url ||= (await wait(editUrl)).url ?? ''; return !!url; }, 60_000), 'the starting editor reports its URL when ready');
      const again = await get(editUrl);
      check(!!url && again.status === 302 && again.headers.location === url, 'the ready editor opens directly on the next visit');
      check(await until(async () => {
        const s = await status();
        return s.editors.length === 1 && s.editors[0].package === 'Test <editor>' && Number.isInteger(s.editors[0].memory)
          && s.editors[0].memory > 0 && s.memory > s.editors[0].memory;
      }, 40_000), 'the status gives the editor title and memory and counts it in the total');

      const failedPage = await get(brokenUrl);
      check(failedPage.status === 200 && failedPage.headers['content-type']?.startsWith('text/html')
        && failedPage.body.includes('Try again') && failedPage.body.includes('Show folder') && failedPage.body.includes('Back to the package'),
        'a broken package starts behind HTML with the actions for a failed start');
      let error = '';
      check(await until(async () => {
        if (!error) { const r = await wait(brokenUrl); if (r.status === 500 && r.ok === false) error = r.error; }
        return error.includes('inputs');
      }, 60_000), 'a failed start reports its reason as a JSON error on the wait route');
      check((await wait(brokenUrl)).status !== 500, 'the failed start is reported once');
      const executable = process.execPath;
      try {
        process.execPath = '';
        const immediate = await get(brokenUrl);
        check(immediate.status === 500 && immediate.headers['content-type']?.startsWith('text/html') && immediate.body.includes('The editor could not start.'),
          'a synchronous error starting the editor has a readable HTML page');
      } finally { process.execPath = executable; }
      check((await get(brokenUrl)).status === 200, 'a plain visit after a failure retries');

      const stop = await reqAt(web.port, '/api/stop', { method: 'POST', headers: { 'x-topotopo-open': '1' } });
      const editorGone = async () => { try { await fetch(url, { signal: AbortSignal.timeout(1000) }); return false; } catch { return true; } };
      check(stop.status === 200 && await until(() => stopped, 25_000) && !!url && await editorGone(), 'stopping the web app waits for the editor to exit and closes its port');
    } finally { web.close(); }
  }

  section('an editor stops by itself when no page is open');
  {
    const expired = { clients: 0, busy: false, idleSince: 0, now: 6000, lastTick: 4500, interval: 1500, limit: 6000 };
    const working = editorIdleTick({ ...expired, busy: true });
    check(!working.stop && working.idleSince === 0 && editorIdleTick(expired).stop,
      'an export or cook keeps an idle editor open, and the next free tick can stop it');
    const woke = editorIdleTick({ ...expired, now: 60_000 });
    check(!woke.stop && woke.idleSince === 60_000, 'a late tick gives a sleeping editor a fresh idle window');
    check(!editorIdleTick({ ...expired, idleSince: woke.idleSince, now: 61_500, lastTick: 60_000 }).stop,
      'the tick after waking keeps the editor open for the new idle window');

    const savedIdle = process.env.TOPOTOPO_EDITOR_IDLE_MS, idleMs = 6000;
    let web: WebServer | undefined, stream: http.ClientRequest | undefined;
    try {
      process.env.TOPOTOPO_EDITOR_IDLE_MS = '0';
      let error = '';
      check(await editCommand(['--json'], 'topotopo', { out: () => {}, err: (s) => { error = s; } }) === 1
        && error.includes('TOPOTOPO_EDITOR_IDLE_MS must be a positive number of milliseconds'), 'an invalid idle limit fails the editor start');
      process.env.TOPOTOPO_EDITOR_IDLE_MS = String(idleMs);
      const idleLib = { name: 'idle', path: path.join(tmp, 'idle-lib') };
      const pkg = createPackage(idleLib, 'idle-box', { title: 'Idle box', graph: BOX });
      const app = web = await startWeb({ config: { ...cfg, libraries: [idleLib], workspaces: [] }, port: 0, bake: false });
      const get = (p: string) => reqAt(app.port, p);
      const edit = `/p/idle/${pkg.id}/edit`, reopen = new URL(edit, app.url).href;
      const open = async () => {
        const page = await get(edit);
        let url = page.headers.location;
        if (!await until(async () => {
          url ||= JSON.parse((await get(`${edit}?wait=1`)).body.toString()).url;
          return !!url;
        }, 60_000)) throw new Error('the idle editor did not start');
        return url!;
      };
      const running = async () => JSON.parse((await get('/api/status')).body.toString()).editors.some((e: { package: string }) => e.package === 'Idle box');
      const info = async (url: string) => JSON.parse((await reqAt(Number(new URL(url).port), '/api/package')).body.toString());
      const first = await open();
      let connected = false;
      stream = http.get(new URL('/api/events', first), (res) => {
        connected = res.statusCode === 200 && res.headers['content-type'] === 'text/event-stream';
        res.resume();
      });
      stream.on('error', () => {});
      check(await until(() => connected, 30_000), 'a page connects to the idle editor');
      const before = await info(first);
      check(before.reopen === reopen && typeof before.instanceId === 'string' && before.instanceId.length > 0,
        'the editor gives its page the absolute edit address and its instance id');
      await sleep(idleMs + 1500);
      check(await running(), 'the editor stays open past the idle limit while a page is connected');
      stream.destroy();
      check(await until(async () => !await running(), 45_000), 'the editor stops after its last page closes');
      const after = await info(await open());
      check(after.reopen === reopen && typeof after.instanceId === 'string' && after.instanceId !== before.instanceId,
        'visiting the edit address again starts a new editor');
    } finally {
      stream?.destroy();
      web?.close();
      if (savedIdle === undefined) delete process.env.TOPOTOPO_EDITOR_IDLE_MS;
      else process.env.TOPOTOPO_EDITOR_IDLE_MS = savedIdle;
    }
  }

  section('published copies');
  {
    const source = createPackage({ name: 'scratch', path: tmp }, 'frozen-source', { title: 'Frozen source', graph: BOX });
    write(path.join(source.dir, 'frozen-source.topo'), { title: 'Frozen source', name: 'scratch/frozen-source' });
    const cli = path.resolve('src/cli.ts');
    execFileSync(process.execPath, [cli, 'publish', source.dir, '--note', 'first version']);
    const copy = path.join(source.dir, 'versions', '1.0');
    const files = () => JSON.stringify(fs.readdirSync(copy, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name)).sort()
      .map((file) => [path.relative(copy, file), fs.statSync(file).size]));

    const beforeEdit = files();
    const edit = spawnSync(process.execPath, [cli, 'edit', copy, '--json'], {
      encoding: 'utf8', timeout: 30_000,
    });
    check(edit.status === 1 && !edit.stdout.trim() && edit.stderr.trim() === `${copy} is a published copy, which is never changed: open its package's folder (${source.dir})` && files() === beforeEdit,
      'edit refuses a published version without starting or writing to it');

    const dependencies = path.join(source.dir, 'packages');
    const dependency = path.join(dependencies, 'vendor', 'alias', '4.2');
    fs.cpSync(copy, dependency, { recursive: true });
    const copiesWeb = await startWeb({ config: { ...cfg, libraries: [{ name: 'copies', path: dependencies }], workspaces: [] }, port: 0 });
    try {
      const open = async (dir: string) => {
        const res = await fetch(`${copiesWeb.url}api/open`, { method: 'POST', headers: { 'x-topotopo-open': '1' }, body: JSON.stringify({ kind: 'package', dir }) });
        const result = await res.json() as { url?: string; error?: string };
        return { status: res.status, ...result };
      };
      const beforeOpen = files();
      const opened = await open(copy);
      const openedPage = opened.url ? (await page(opened.url, copiesWeb.port)).body.toString() : '';
      check(opened.status === 200 && opened.url === '/l/frozen-source/?copy=1.0'
        && openedPage.includes('You opened the published copy 1.0. Published copies are never changed: this is the package it was published from.'),
        'opening a published version lands on its working package with a notice');
      check(!(await reqAt(copiesWeb.port, '/l/frozen-source/?copy=%3Cscript%3E')).body.includes('You opened the published copy'), 'an invalid copy version shows no notice');
      await sleep(3000);
      check(!copiesWeb.queue.pending(copy) && !fs.existsSync(path.join(copy, '.web')) && files() === beforeOpen,
        'opening a published version leaves its files and preview folder untouched');
      const refused = await open(dependency);
      check(refused.status === 409 && refused.error === `${dependency} is a copy of scratch/frozen-source 1.0 that ${source.dir} uses, which is never changed and has no page: open the package itself`,
        'a dependency copy is refused with the package and version in its record');
      fs.unlinkSync(path.join(dependency, 'version.json'));
      copiesWeb.rescan();
      const noRecord = await open(dependency);
      check(noRecord.status === 409 && noRecord.error === `${dependency} is a copy of vendor/alias 4.2 that ${source.dir} uses, which is never changed and has no page: open the package itself`,
        'a dependency copy without a record is refused with the package and version in its path');
      const copiedFolder = await reqAt(copiesWeb.port, '/l/copies/vendor/alias/4.2/');
      check(!/Open in editor|Re-bake/.test(copiedFolder.body.toString())
        && (await reqAt(copiesWeb.port, '/p/copies/frozen-source/edit')).status === 404
        && (await reqAt(copiesWeb.port, '/p/copies/frozen-source/bake', { method: 'POST' })).status === 404
        && !fs.existsSync(path.join(dependency, '.web')), 'a scan rooted inside packages never exposes a copy for editing or baking');
    } finally { copiesWeb.close(); }
  }

  section('pages');
  {
    const home = await req('/');
    const html = home.body.toString();
    check(home.status === 200 && html.includes('href="/l/game/props/crate/"') && html.includes('Crate &lt;b&gt;&amp;'), 'the front page\'s search results link the package\'s folder page and escape its title');
    check(/<a class="rcard" href="\/l\/game\/" data-root="l\/game">/.test(html) && html.indexOf('data-root="l/game"') < html.indexOf('data-root="l/topotopo"'), 'the front page shows the library as a card, TopoTopo\'s built-in library after it');
    check(/frame-ancestors 'self'/.test(String(home.headers['content-security-policy'])) && /frame-src 'self' https:\/\/www\.youtube-nocookie\.com https:\/\/player\.vimeo\.com/.test(String(home.headers['content-security-policy'])), 'pages are not framed by other sites, and frame nothing but the video players');
    const stable = await req('/p/game/crate');
    check(stable.status === 302 && stable.headers.location === '/l/game/props/crate/', 'a package\'s stable address leads to its folder page');
    const pg = await page('/p/game/crate');
    const ph = pg.body.toString();
    check(pg.status === 200 && ph.includes('concept.png') && ph.includes('http://board.local/x') && ph.includes(`http://127.0.0.1:${g.port}/embed/game/crate`) && ph.includes(`http://127.0.0.1:${g.port}/p/game/crate`), 'the package\'s folder page: attachments, links, the board snippets with the absolute stable URLs');
    const at = (s: string) => ph.indexOf(s);
    check(at('class="pkgblock"') > 0 && at('class="pkgblock"') < at('<section class="pictures"') && at('<section class="pictures"') < at('<h2>Attachments') && at('<h2>Attachments') < at('class="divider"')
      && at('class="divider"') < at('<section class="pkgdetails">') && at('<section class="pkgdetails">') < at('id="bake"') && at('id="bake"') < at('<details class="board">') && at('<details class="board">') < at('stable link</a>'),
      'a package\'s page: its preview and its pictures first; below the divider its graphs, how it baked, the board snippets and where it is');
    check(/<div class="actions">[\s\S]*?Re-bake<\/button>\s*<span class="bakenow" id="bakenow" aria-live="polite">(Baking…)?<\/span>\s*<\/div>/.test(ph) && !/<details class="graph" open/.test(ph) && /<details class="graph"><summary><b>main<\/b>/.test(ph),
      'beside its buttons a word while it bakes; its graphs folded to a line each');
    check((await req('/p/game/nope')).status === 404, 'an unknown package is 404');
    check((await req('/static/web.css')).status === 200 && (await req('/app/embed.js')).status === 200 && (await req('/vendor/three/build/three.module.js')).status === 200, 'styles, the embed module and three.js are served');
    check((await req('/static/../server.ts')).status === 404, 'no files outside the static folder');
    const health = JSON.parse((await req('/api/health')).body.toString());
    check(health.web === true && health.packages === 1 + BUILTIN && health.libraries === 2, `health: the library's package and TopoTopo's built-in ones (${BUILTIN})`);
    check(await runningWeb(g.port) === g.url, 'runningWeb recognises it');
  }

  section('bake on start, thumbnails, preview.glb, embed');
  {
    const baked = await until(() => fs.existsSync(path.join(crate.dir, '.web', 'preview.glb')) && g.queue.size === 0, 180000);
    check(baked, 'a never-baked package is baked on start' + (baked ? '' : ` (${bakeDetails(bakeState(crate.dir))})`));
    if (baked) {
      const t = await req('/p/game/crate/thumb.png');
      check(t.status === 200 && t.headers['content-type'] === 'image/png' && t.body.readUInt32BE(16) === 512, 'thumb.png is the baked 512 px thumbnail');
      const again = await req('/p/game/crate/thumb.png', { headers: { 'if-none-match': String(t.headers.etag) } });
      check(again.status === 304, 'an unchanged thumbnail answers 304');
      const glb = await req('/p/game/crate/preview.glb');
      check(glb.status === 200 && glb.body.toString('latin1', 0, 4) === 'glTF', 'preview.glb');
      const embed = await req('/embed/game/crate');
      const eh = embed.body.toString();
      const ecsp = String(embed.headers['content-security-policy']);
      check(embed.status === 200 && !/frame-ancestors/.test(ecsp) && /connect-src 'self' data: blob:/.test(ecsp) && eh.includes('data-src="/p/game/crate/preview.glb?v=') && eh.includes('/app/embed.js'), 'the embed page can be framed by any board, loads the GLB, and nothing from other sites');
      check(/data-wheel="click"/.test(eh) && /id="hint"/.test(eh), 'the embed page leaves the wheel to the page around it until it is clicked');
      const ph = (await page('/p/game/crate')).body.toString();
      check(ph.includes('<iframe class="view" src="/embed/game/crate"'), 'a baked package\'s folder page shows its preview in 3D');
    } else {
      console.log('SKIP bake on start: the first bake did not finish (the five checks that read its files)');
    }
  }

  section('files of a package (the stable addresses)');
  {
    const img = await req('/p/game/crate/files/attachments/concept.png');
    check(img.status === 200 && img.headers['content-type'] === 'image/png' && !img.headers['content-disposition'] && img.headers['x-content-type-options'] === 'nosniff', 'an attached image is shown inline');
    const svg = await req('/p/game/crate/files/attachments/evil.svg');
    check(svg.status === 200 && /attachment/.test(String(svg.headers['content-disposition'])) && svg.headers['content-security-policy'] === 'sandbox', 'an SVG (scripts) is a sandboxed download');
    check((await req('/p/game/crate/files/attachments/..%2F..%2F..%2Fsecret.txt')).status === 400, 'encoded ".." is refused');
    check((await req('/p/game/crate/files/graphs/main.json')).status === 400, 'only attachments/ and exports/ are served there');
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
    check((await req('/l/game/?reveal', { method: 'POST', headers: { origin: 'http://evil.example' } })).status === 403, 'a cross-site "show folder" is refused');
    check((await req('/p/game/crate/bake')).status === 405, 'bake needs POST');
  }

  section('changes');
  {
    const first = bakeState(crate.dir);
    check(first !== null, 'the first bake wrote .web/bake.json');
    if (first === null) {
      console.log('SKIP a graph saved by another process is baked again: the first bake did not write .web/bake.json');
    } else {
      const at0 = first.at;
      fs.writeFileSync(path.join(crate.dir, 'graphs', 'main.json'), JSON.stringify({ nodes: { b: { type: 'sphere' } }, output: 'b' }));
      const rebaked = await until(() => {
        const state = bakeState(crate.dir);
        return state !== null && state.at !== at0;
      }, 90000);
      check(rebaked, 'a graph saved by another process is baked again');
    }
    createPackage(lib, 'props/barrel', { graph: BOX });
    check(await until(async () => JSON.parse((await req('/api/health')).body.toString()).packages === 2 + BUILTIN, 10000), 'a new package folder appears');
    check((await page('/p/game/barrel')).url === '/l/game/props/barrel/', 'and has its folder page');
  }

  section('a bake whose thumbnail renders with shading "pbr" (MikkTSpace loads itself)');
  {
    const shiny = createPackage(lib, 'props/shiny', { title: 'Shiny', graph: { nodes: { b: { type: 'box' }, uv: { type: 'uv_project', in: ['b'] } }, output: 'uv', meta: { thumbnail_render: { shading: 'pbr' } } } as any });
    const ok = await until(() => (bakeState(shiny.dir)?.at ?? 0) > 0, 180000);
    const state = bakeState(shiny.dir);
    const baked = ok && state?.ok === true && fs.existsSync(path.join(shiny.dir, '.web', 'thumb.png'));
    check(baked, `the bake needs no preload script (${baked ? 'ok' : bakeDetails(state)})`);
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
    const pg = (await page('/p/game/empty')).body.toString();
    check(pg.includes('No default graph yet: this package has no graphs. Open in editor shows how one gets built; the preview appears here when it exists.')
      && !/class="bake err/.test(pg) && pg.includes('<p class="dim">No graphs yet.</p>'),
      'its page says what to do, not an error');
    check(!fs.existsSync(path.join(empty.dir, '.web', 'bake.json')), 'nothing is baked before it has a default graph');
    const bp = (await page('/p/game/beside')).body.toString();
    check(/<b>tower<\/b> <span class="tag">default<\/span>/.test(bp), 'a graph file beside the manifest is a graph of the package, here its default one');
    const baked = await until(() => fs.existsSync(path.join(beside.dir, '.web', 'thumb.png')), 180000);
    check(baked, 'and is baked' + (baked ? '' : ` (${bakeDetails(bakeState(beside.dir))})`));
  }

  section('a graph file that cannot be read');
  {
    const p = createPackage(lib, 'props/unreadable', { title: 'Unreadable' });
    const file = path.join(p.dir, 'graphs', 'main.json'), bake = path.join(p.dir, '.web', 'bake.json');
    write(file, '}');
    write(path.join(p.dir, 'graphs', 'other.json'), '}');
    g.rescan();
    const at = '/p/game/unreadable';
    const status = async () => JSON.parse((await req('/api/packages')).body.toString()).packages.find((x: any) => x.id === p.id)?.status;
    check(await status() === 'unread', 'the package has unread status');
    const rejected = await req(at + '/bake', { method: 'POST' });
    const error = JSON.parse(rejected.body.toString()).error;
    check(rejected.status === 400 && /^Its graph file graphs\/main\.json cannot be read: .+/.test(error), 'a re-bake request answers 400 with the unreadable file and parser error');
    const pg = (await page(at)).body.toString();
    check(pg.includes(`id="bake">${esc(error)}</p>`) && !pg.includes('Re-bake') && pg.includes('Open in editor') && !pg.includes('No default graph yet'),
      'the package page explains the unreadable graph and offers Open in editor');
    check(pg.includes('<b>other</b>: cannot be read') && !pg.includes('0 nodes'), 'a non-default unreadable graph is listed with the error');
    const mark = '<span class="status s-unread">graph file cannot be read</span>';
    check((await req('/')).body.includes(mark) && (await page('/l/game/props/')).body.includes(mark), 'the front and folder cards mark the package unread');
    const preview = await req(at + '/preview.glb');
    check(preview.status === 404 && JSON.parse(preview.body.toString()).error === error, 'the preview request explains the unreadable graph');
    check(!await until(() => fs.existsSync(bake), 3000), 'the unreadable default graph is not baked');
    write(file, BOX);
    const baked = await until(async () => fs.existsSync(bake) && await status() === 'ok', 180000);
    check(baked, 'repairing the default graph bakes it and gives ok status' + (baked ? '' : ` (${bakeDetails(bakeState(p.dir))})`));
  }

  section('packages: a package\'s versions and outputs, the packages a package uses, the cards mark packages');
  {
    // a package with two published versions and a package that uses the first, their records as publishing and use
    // write them (versions/<v>/version.json, packages/<owner>/<name>/<v>/version.json)
    const pine = { graph: 'main', node: 'tree', label: 'Pine', kind: 'mesh', tags: ['conifer', 'low-poly'], sliders: { height: { type: 'float', default: 4 } }, inputs: [{ index: 0, label: 'ground' }] };
    const rec = (version: string, note: string, published: string) => ({ package: 'studio/trees', version, note, published, big: false, hash: `h${version}`, outputs: { pine }, default: pine, topotopo: '0' });
    const trees = createPackage(lib, 'nature/trees', { title: 'Trees', graph: BOX });
    const forest = createPackage(lib, 'levels/forest', { title: 'Forest', graph: BOX });
    const edit = (dir: string, fn: (m: any) => void) => { const file = path.join(dir, `${path.basename(dir)}.topo`); const m = JSON.parse(fs.readFileSync(file, 'utf8')); fn(m); fs.writeFileSync(file, JSON.stringify(m, null, 2)); };
    edit(trees.dir, (m) => { m.name = 'studio/trees'; });
    write(path.join(trees.dir, 'versions', '1.0', 'version.json'), rec('1.0', 'first trees', '2026-10-20T10:00:00.000Z'));
    write(path.join(trees.dir, 'versions', '1.1', 'version.json'), rec('1.1', 'rounder <crowns>', '2026-10-22T10:00:00.000Z'));
    edit(forest.dir, (m) => { m.uses = { 'studio/trees': '1.0' }; });
    write(path.join(forest.dir, 'packages', 'studio', 'trees', '1.0', 'version.json'), rec('1.0', 'first trees', '2026-10-20T10:00:00.000Z'));
    g.rescan();
    const pg = (await page('/p/game/trees')).body.toString();
    check(/class="pkgline">Package <span class="pkg"[^>]*>studio\/trees 1\.1<\/span>/.test(pg), 'a package\'s page names it in full, with its newest version');
    check(/<span class="vn">1\.1<\/span><span class="vd">2026-10-22<\/span><span class="vt">rounder &lt;crowns&gt;<\/span>/.test(pg) && /<span class="vn">1\.0<\/span><span class="vd">2026-10-20<\/span><span class="vt">first trees<\/span>/.test(pg)
      && pg.indexOf('id="v-1.1"') < pg.indexOf('id="v-1.0"') && /id="v-1\.0"[\s\S]*?<ul class="vouts"><li><code>studio\/trees\/pine<\/code>/.test(pg),
      'its versions, newest first, with their dates and notes (escaped); each opens to the outputs it published');
    check(/<h2>Used by <span class="count">1<\/span><\/h2><table class="vars uses"><tbody><tr><th><a href="\/l\/game\/levels\/forest\/">Forest<\/a><\/th><td>1\.0<\/td>/.test(pg), 'a package\'s page lists the packages that use it, linked to their folder pages');
    check(/<code>studio\/trees\/pine<\/code><br><code>studio\/trees<\/code> <span class="dim">\(the default\)<\/span><\/th><td>Pine<span class="tags"><span class="kind"[^>]*>mesh<\/span><span class="tag">conifer<\/span><span class="tag">low-poly<\/span><\/span><\/td><td class="dim">node &quot;tree&quot; of graph &quot;main&quot; · params height · input ground<\/td>/.test(pg),
      'the outputs it publishes, by the node type a graph names them with: their kinds, tags, params and inputs, the default output');
    const user = (await page('/p/game/forest')).body.toString();
    check(/<h2>Packages it uses <span class="count">1<\/span><\/h2>/.test(user) && /<th><a href="\/l\/game\/nature\/trees\/">studio\/trees<\/a><\/th><td>1\.0<\/td><td class="unotes"><span class="urow"><span class="newer">1\.1 is out<\/span><span class="udate">2026-10-20<\/span><span class="unote" title="first trees">first trees<\/span><\/span><\/td>/.test(user) && /publishes no versions/.test(user),
      'a package\'s page lists the packages it uses: the version in use, a newer version, its date and its note on one line (whole on hover)');
    const grid = (await req('/')).body.toString();
    const cardOf = (key: string) => { const at = grid.indexOf(`data-key="${key}"`); return at < 0 ? '' : grid.slice(at, grid.indexOf('</a>', at)); };
    check(cardOf('game/trees').includes('<span class="pkg" title="package studio/trees, newest version 1.1">studio/trees 1.1</span>') && cardOf('game/forest') && !cardOf('game/forest').includes('class="pkg"'),
      'the search\'s cards mark a package with its full name and newest version');
    check(/<span class="out" hidden data-hay="studio\/trees\/pine studio\/trees pine mesh conifer low-poly"><code>studio\/trees\/pine<\/code><span class="kind"[^>]*>mesh<\/span><span class="tag">conifer<\/span>/.test(cardOf('game/trees')) && !cardOf('game/forest').includes('class="out"')
      && /placeholder="Search \d+ packages and \d+ outputs"/.test(grid), 'the search finds a package\'s outputs by name, kind and tag: each card carries them, shown when the search finds them');
    check(/data-hay="[^"]*studio\/trees/.test(cardOf('game/forest')) && /<span class="upd" title="studio\/trees 1\.0 is in use; 1\.1 is out">update: studio\/trees 1\.1<\/span>/.test(cardOf('game/forest')),
      'a package\'s card: the search finds it by the packages it uses, and it says that an update exists');
    // TopoTopo's built-in library: a library like the others, last; its packages have folder pages
    const props = cardOf('topotopo/props');
    check(/data-root="l\/topotopo"/.test(grid) && /TopoTopo&#39;s built-in library/.test(grid)
      && /href="\/l\/topotopo\/props\/" data-key="topotopo\/props"/.test(grid) && /<span class="out" hidden data-hay="topotopo\/props\/barrel [^"]*"><code>topotopo\/props\/barrel<\/code>/.test(props) && /src="\/p\/topotopo\/props\/thumb\.png\?v=1\.0"/.test(props),
      'TopoTopo\'s built-in library is a library card, and the search finds its packages\' outputs');
    const pp = await page('/p/topotopo/props');
    const pph = pp.body.toString();
    check(pp.url === '/l/topotopo/props/' && /<h1>Props<\/h1>/.test(pph) && /class="pkgline">Package <span class="pkg"[^>]*>topotopo\/props 1\.0<\/span>/.test(pph) && /<img class="othumb" src="\/p\/topotopo\/props\/thumbs\/barrel\.png"[^>]*><code>topotopo\/props\/barrel<\/code>/.test(pph)
      && /<h2>Used by <span class="count">0<\/span>/.test(pph) && /One of TopoTopo&#39;s own packages: every package can use its outputs by name/.test(pph) && !/Open in editor|data-post="[^"]*bake"/.test(pph),
      'a built-in package has a folder page: its versions, its outputs with their thumbnails, the packages that use it, nothing to edit or bake');
    const th = await req('/p/topotopo/props/thumbs/barrel.png'), thumb = await req('/p/topotopo/props/thumb.png');
    check(th.status === 200 && th.headers['content-type'] === 'image/png' && thumb.status === 200 && thumb.body.length > 1000 && (await req('/p/topotopo/props/thumbs/..%2Fprops.topo')).status === 404
      && (await req('/p/topotopo/nope')).status === 404 && (await req('/p/topotopo/props/bake', { method: 'POST' })).status === 400,
      'a built-in package\'s thumbnails are served (its card shows one of its outputs\'), and it is not baked here');
    check((await page('/l/topotopo/')).body.toString().includes('href="/l/topotopo/props/"'), 'the built-in library\'s folder page has a card per package');
    edit(forest.dir, (m) => { m.uses = { ...m.uses, 'topotopo/props': '1.0' }; });
    g.rescan();
    const user2 = (await page('/p/game/forest')).body.toString();
    check(/<th><a href="\/l\/topotopo\/props\/">topotopo\/props<\/a><\/th><td>1\.0<\/td>/.test(user2) && /<a href="\/l\/game\/levels\/forest\/">Forest<\/a>/.test((await page('/p/topotopo/props')).body.toString()),
      'a package\'s page links the built-in packages it uses, and the built-in package\'s page lists the package');
    const api = JSON.parse((await req('/api/packages')).body.toString());
    check(JSON.stringify(api.packages.find((x: any) => x.id === 'trees')?.package) === '{"name":"studio/trees","version":"1.1"}' && api.packages.find((x: any) => x.id === 'forest')?.package === undefined && api.packages.find((x: any) => x.id === 'trees')?.url.endsWith('/p/game/trees'),
      '/api/packages names the packages too, with their stable addresses');
  }

  section('workspaces: on the front page, their packages with folder pages, among the users of a package');
  {
    const ws = path.join(tmp, 'valley');
    fs.mkdirSync(path.join(ws, 'scenes', 'hall'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'valley.topows'), JSON.stringify({ libraries: ['game'], engine: { type: 'godot', project: 'game/project.godot' }, uses: { 'topotopo/props': '1.0' } }));
    write(path.join(ws, 'game', 'project.godot'), 'config_version=5\n[application]\nconfig/name="Valley Run"\n');
    fs.writeFileSync(path.join(ws, 'scenes', 'hall', 'hall.topo'), JSON.stringify({ title: 'Pump hall' }));
    // a library registered inside the workspace: shown once, as the workspace's
    const art = { name: 'valley-art', path: path.join(ws, 'art') };
    createPackage(art, 'rugs/rug', { title: 'Rug', graph: BOX });
    cfg.libraries.push(art);
    cfg.workspaces.push({ name: 'valley', path: ws });
    g.rescan();
    const home = (await req('/')).body.toString();
    const card = home.slice(home.indexOf('data-root="w/valley"'), home.indexOf('</a>', home.indexOf('data-root="w/valley"')));
    check(home.indexOf('data-root="w/valley"') > 0 && home.indexOf('data-root="w/valley"') < home.indexOf('data-root="l/game"') && /Workspace · Godot · Valley Run/.test(card) && /<b>2<\/b> <span>packages<\/span>/.test(card),
      `the front page shows the workspace first: its engine project, its packages (${card.replace(/\s+/g, ' ').slice(0, 400)})`);
    check(!/data-root="l\/valley-art"/.test(home), 'a registered library inside a registered workspace shows once, as the workspace\'s');
    const hall = await page('/p/valley/hall');
    check(hall.url === '/w/valley/scenes/hall/' && /Pump hall/.test(hall.body.toString()) && /in the workspace &quot;valley&quot;/.test(hall.body.toString()), 'a workspace\'s package has a folder page, reached by /p/<workspace>/<id>');
    check((await page('/p/valley/rug')).url === '/w/valley/art/rugs/rug/', 'and so does the package of the library inside it, as the workspace\'s');
    const inside = await req('/l/valley-art/rugs/');
    check(inside.status === 302 && inside.headers.location === '/w/valley/art/rugs/', 'the library inside the workspace leads to its folder in the workspace');
    check(/<a href="\/w\/valley\/">workspace valley<\/a><\/th><td>1\.0<\/td><td class="dim">workspace<\/td>/.test((await page('/p/topotopo/props')).body.toString()), 'a built-in package\'s users include the workspaces that use it');
    const root = (await page('/w/valley/')).body.toString();
    check(/class="fcard k-engine" href="\/w\/valley\/game\/"/.test(root) && /<span class="ftitle">Valley Run<\/span>/.test(root), 'the engine project inside the workspace is one card');
    check(/<section class="wsuses"><h2>Packages it uses <span class="count">1<\/span><\/h2>[\s\S]*?<th><a href="\/l\/topotopo\/props\/">topotopo\/props<\/a><\/th><td>1\.0<\/td>/.test(root), 'the workspace\'s root lists the packages it uses, linked');
    cfg.workspaces.length = 0;
    cfg.libraries.pop();
    g.rescan();
  }

  section('templates');
  {
    check(esc(`<a href="x">'&`) === '&lt;a href=&quot;x&quot;&gt;&#39;&amp;', 'esc');
    const u = { home: '/', package: () => '/p', thumb: () => '/t', glb: () => '/g', embed: () => '/e', file: () => '/f', edit: () => null, folder: () => '/w/', raw: () => '/r', model: () => '/m', asset: (n: string) => n, app: (n: string) => n, three: '/3/' };
    const html = frontPage({ workspaces: [], libraries: [], packages: [], problems: ['<script>'] }, u);
    check(html.includes('&lt;script&gt;') && html.includes('library add') && html.includes('workspace init'), 'problems are escaped; an empty web app says how to add a workspace and a library');
    check(html.indexOf('<details class="problems">') > html.indexOf('id="libraries"') && html.indexOf('id="libraries"') > html.indexOf('id="workspaces"'), 'the front page: the workspaces and libraries first, problems after them');
  }

  // ------------------------------------------------------------------------------------------- folder pages
  section('folder pages: a workspace and an Unreal library, previews not baked');
  const yard = path.join(tmp, 'yard');
  const ue = path.join(tmp, 'Ridge');
  const kit = path.join(ue, 'Content', 'Kit');
  /** a second workspace for what a note link may never do, plumbing by other names, the look and the flags that are not there */
  const probe = path.join(tmp, 'probe');
  {
    write(path.join(yard, 'yard.topows'), { libraries: [], engine: { type: 'godot', project: 'game/project.godot' } });
    // the Godot project inside: browsable, not audited
    write(path.join(yard, 'game', 'project.godot'), 'config_version=5\n[application]\nconfig/name="Yard Game"\n');
    write(path.join(yard, 'game', 'scenes', 'main.tscn'), '[gd_scene format=3]\n');
    write(path.join(yard, 'game', 'README.md'), 'See [the missing plan](plan.md).\n');
    write(path.join(yard, 'game', 'art', 'tile.png'), PNG);
    write(path.join(yard, 'game', 'art', 'tile.png.import'), '[remap]\n');
    write(path.join(yard, 'game', 'art', 'tile.png.uid'), 'uid://x\n');
    write(path.join(yard, 'game', '.godot', 'cache.bin'), 'x');
    // notes, pictures, sounds, a video, a model
    write(path.join(yard, 'notes', '02-later.md'), '# Later\n\nThe second box.\n');
    write(path.join(yard, 'notes', '01-overview.md'), [
      '# Overview <script>alert(1)</script>', '',
      'Text with **strong**, *em*, `code`, <b>raw html</b> and [a script link](javascript:alert(1)).', '',
      '![shot](shot.png)', '', '[the sound](../sounds/kick.wav)', '', '[turntable](clip.webm)', '', '[the crate in 3D](../props/crate/exports/crate.glb)', '', '[crate.glb](../props/crate/exports/crate.glb)', '',
      '[the sounds](../sounds)', '', '[the crate](../props/crate)', '', '[the later note](02-later.md)', '',
      'https://www.youtube.com/watch?v=aqz-KE-bpKQ&t=1m5s', '', '[light study](https://vimeo.com/76979871)', '', '[outside picture](https://example.com/x.png)', '',
      '[missing](gone.png) and ![also missing](../nowhere/x.png)', '', 'Godot: [main scene](res://scenes/main.tscn) and [no scene](res://scenes/none.tscn)', '',
      '| a | b |', '|---|:-:|', '| 1 | 2 |', '',
    ].join('\n'));
    write(path.join(yard, 'notes', '03-todo.txt'), 'plain <text>\nhttps://example.com/x\nhttps://www.youtube.com/watch?v=aqz-KE-bpKQ&t=90s and https://x.org/O\'Neil.\n');
    write(path.join(yard, 'notes', '04-runs.md'), 'See [the last run](../logs/run-30.txt).\n');
    // a board: cards with front matter, a README with a table of contents, a picture and a folder in running text,
    // prompts, and a note with a broken link past the 24 boxes
    write(path.join(yard, 'board', 'README.md'), '# Board\n\n- [Usage](#usage)\n- [the card\'s setup](01-card.md#setup)\n\nSet dressing from the [kitbash sounds](../sounds) fills the streets.\n\nSee the [concept](../notes/shot.png). More text.\n\n## Usage\n\nRead the cards.\n');
    write(path.join(yard, 'board', '01-card.md'), "---\ntitle: 'Machine planning off the tick'\nlane: done\nmilestone: ''\ntags:\n  - ai\n  - threats\n---\n\nThe card.\n\n## Setup\n\nSteps.\n");
    for (let i = 0; i < 30; i++) write(path.join(yard, 'board', `c-${String(i).padStart(2, '0')}.md`), `card ${i}\n`);
    write(path.join(yard, 'board', 'a-prompt.txt'), 'the first prompt\n');
    write(path.join(yard, 'board', 'z-flagged.md'), '[gone](nowhere.png)\n');
    for (let i = 1; i <= 30; i++) write(path.join(yard, 'logs', `run-${i}.txt`), `run ${i}\n`);
    write(path.join(yard, 'notes', 'shot.png'), PNG);
    write(path.join(yard, 'notes', 'clip.webm'), Buffer.alloc(4096, 7));
    write(path.join(yard, 'notes', 'evil.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    write(path.join(yard, 'notes', 'page.html'), '<script>alert(1)</script>');
    const wav = Buffer.alloc(1000);
    wav.write('RIFF', 0, 'latin1');
    for (const n of ['kick', 'snare']) { write(path.join(yard, 'sounds', `${n}.wav`), wav); write(path.join(yard, 'sounds', `${n}.wav.import`), '[remap]\n'); }
    write(path.join(yard, 'sounds', 'loop.ogg'), Buffer.alloc(300, 1));
    // plumbing a page never shows
    write(path.join(yard, '.cache', 'x.txt'), 'x');
    write(path.join(yard, 'node_modules', 'm', 'index.js'), 'x');
    write(path.join(yard, 'topotopo-packages', 'lock.json'), '{}');
    write(path.join(yard, 'Saved', 'log.txt'), 'x');
    write(path.join(tmp, 'outside', 'secret.txt'), 'secret');
    // packages: one with an export older than its graph and one whose export matches it, one whose preview did not
    // cook, one that publishes and has no version, one with changes no version holds and outputs nobody uses
    const place = { name: 'yard', path: yard, workspace: true };
    const crateP = createPackage(place, 'props/crate', { title: 'Crate', graph: BOX });
    const graphSha = (spec: object) => sha256Hex(canonicalJSON(spec));
    const source = (sha: string) => ({ format: 'topotopo-export-source', version: 1, files: ['crate.glb'], source: { graph: 'main', graph_sha256: sha, output: null, node: 'b', frame: 1, fps: 24, vars: {}, seeds: {}, export: { format: 'glb', options: {} }, topotopo: '0' } });
    write(path.join(crateP.dir, 'exports', 'crate.glb'), fs.readFileSync(path.join(crate.dir, '.web', 'preview.glb')));
    write(path.join(crateP.dir, 'exports', 'crate.glb.source.json'), source(graphSha({ nodes: { b: { type: 'sphere' } }, output: 'b' })));
    write(path.join(crateP.dir, 'exports', 'fresh.glb'), fs.readFileSync(path.join(crate.dir, '.web', 'preview.glb')));
    write(path.join(crateP.dir, 'exports', 'fresh.glb.source.json'), source(graphSha(BOX)));
    write(path.join(crateP.dir, 'versions', 'x.txt'), 'x');
    write(path.join(crateP.dir, 'previews', 'front.png'), PNG);
    write(path.join(crateP.dir, 'inputs', 'mask.png'), PNG);
    write(path.join(crateP.dir, 'thumbs', 'box.png'), PNG);
    for (let i = 0; i < 15; i++) write(path.join(crateP.dir, 'renders', `f${String(i).padStart(2, '0')}.png`), PNG);
    const broken =createPackage(place, 'levels/broken', { title: 'Broken', graph: BOX });
    write(path.join(broken.dir, '.web', 'bake.json'), { key: 'k', at: 1, ok: false, error: '[rocks] unknown node type "scatter_rockz"\nmore' });
    const lamp = createPackage(place, 'props/lamp', { title: 'Lamp', graph: BOX });
    const edit = (dir: string, fn: (m: any) => void) => { const file = path.join(dir, `${path.basename(dir)}.topo`); const m = JSON.parse(fs.readFileSync(file, 'utf8')); fn(m); fs.writeFileSync(file, JSON.stringify(m, null, 2)); };
    edit(lamp.dir, (m) => { m.name = 'yard/lamp'; });
    const posts = createPackage(place, 'props/posts', { title: 'Posts', graph: BOX });
    edit(posts.dir, (m) => { m.name = 'yard/posts'; });
    const out = (graph: string, node: string) => ({ graph, node, label: node, kind: 'mesh', tags: [], sliders: {}, inputs: [] });
    write(path.join(posts.dir, 'versions', '1.0', 'version.json'), { package: 'yard/posts', version: '1.0', note: 'first', published: '2026-10-01T00:00:00.000Z', big: false, hash: 'not-this', outputs: { post: out('main', 'b'), fence: out('main', 'f') }, default: out('main', 'b'), topotopo: '0' });
    write(path.join(broken.dir, 'graphs', 'uses.json'), { nodes: { p: { type: 'yard/posts/post' } }, output: 'p' });
    // an Unreal project's content: a library in it
    write(path.join(ue, 'Ridge.uproject'), '{}');
    write(path.join(kit, 'Meshes', 'SM_Rock.uasset'), 'x');
    write(path.join(kit, 'Meshes', 'SM_Tree.uasset'), 'x');
    write(path.join(kit, 'Maps', 'L_Test.umap'), 'x');
    write(path.join(kit, 'README.md'), 'The rock: [SM_Rock](/Game/Kit/Meshes/SM_Rock) and [the gone one](/Game/Kit/Meshes/SM_Gone).\n');
    // a workspace whose file TopoTopo refuses: its folders still show, and the problem is a flag
    write(path.join(tmp, 'old', 'old.topows'), { engine: { type: 'godot', project: 'game/project.godot', assets: 'game/assets' } });
    write(path.join(tmp, 'old', 'props', 'chair', 'chair.topo'), { title: 'Chair' });
    // a link that leads out of the workspace
    try { fs.symlinkSync(path.join(tmp, 'outside'), path.join(yard, 'notes', 'out'), process.platform === 'win32' ? 'junction' : 'dir'); } catch { /* no links here: the check below says so */ }

    write(path.join(probe, 'probe.topows'), { libraries: [] });
    write(path.join(probe, 'notes', '01-a.md'), 'A note.\n');
    write(path.join(probe, 'notes', '02-unc.md'), [
      '[unc-pct](%5C%5Cunreachable.invalid%5Cs%5Cx.png) [unc-root](/%5C%5Cunreachable.invalid%5Cs%5Cy.png) [unc-raw](\\\\\\\\unreachable.invalid\\s\\z.png)',
      '[out-missing](../../outside/nothere.png) [hidden-missing](../.secret/nothere.png) [drive](C:%5CWindows%5Cwin.ini)',
      '[nul](bad%00name.png) and [gone](gone.png)', '',
    ].join('\n'));
    write(path.join(probe, '.secret', 'key.txt'), 'secret');
    try { fs.symlinkSync(path.join(probe, '.secret'), path.join(probe, 'inner'), process.platform === 'win32' ? 'junction' : 'dir'); } catch { /* no links here: the check says so */ }
    write(path.join(probe, 'tools', 'run.bat'), '@echo off\n');
    write(path.join(probe, 'tools', 'node_modules', 'logo.png'), PNG);
    for (const n of ['A.uasset', 'B.uasset', 'Map.umap']) write(path.join(probe, 'mixed', n), 'x');
    write(path.join(probe, 'mixed', 'pic.png'), PNG);
    fs.mkdirSync(path.join(probe, 'empty-a'), { recursive: true });
    write(path.join(probe, 'empty-b', '.web', 'x'), 'x');
    write(path.join(probe, 'sounds', 'blip.wav'), wav);
    const pplace = { name: 'probe', path: probe, workspace: true };
    const tower = createPackage(pplace, 'kit/tower', { title: 'Tower', graph: BOX });
    write(path.join(tower.dir, 'exports', 'tower.glb'), fs.readFileSync(path.join(crate.dir, '.web', 'preview.glb')));
    write(path.join(tower.dir, 'exports', 'tower.glb.source.json'), { format: 'topotopo-export-source', version: 1, files: ['tower.glb'], source: { graph: 'main', graph_sha256: sha256Hex(canonicalJSON(BOX)), output: null, node: 'b', frame: 1, fps: 24, vars: {}, seeds: {}, export: { format: 'glb', options: {} }, topotopo: '0' } });
    createPackage(pplace, 'levels/quay', { title: 'Quay' });
    const yard2 = createPackage(pplace, 'levels/yard2', { title: 'Yard2', graph: BOX });
    write(path.join(yard2.dir, '.web', 'thumb.png'), fs.readFileSync(path.join(crate.dir, '.web', 'thumb.png')));
    write(path.join(yard2.dir, '.web', 'bake.json'), { key: 'k', at: 1, ok: false, error: '[rocks] unknown node type "scatter_rockz"' });
    for (const q of ['q1', 'q2']) {
      const p = createPackage(pplace, `levels/${q}`, { title: q.toUpperCase(), graph: BOX });
      write(path.join(p.dir, '.web', 'bake.json'), { key: 'k', at: 1, ok: false, error: 'it did not cook' });
    }
    // a package published as it is, whose one output a package of the workspace uses by its name alone
    const stable = createPackage(pplace, 'props/stable', { title: 'Stable', graph: BOX });
    const sfile = path.join(stable.dir, 'stable.topo');
    fs.writeFileSync(sfile, JSON.stringify({ ...JSON.parse(fs.readFileSync(sfile, 'utf8')), name: 'probe/stable' }, null, 2));
    const post = { graph: 'main', node: 'b', label: 'Post', kind: 'mesh', tags: [], sliders: {}, inputs: [] };
    createPackage(pplace, 'props/user', { title: 'User', graph: { nodes: { p: { type: 'probe/stable' } }, output: 'p' } });
    write(path.join(stable.dir, 'versions', '1.0', 'version.json'), { package: 'probe/stable', version: '1.0', note: 'first', published: '2026-10-01T00:00:00.000Z', big: false, hash: workingHash(stable.dir), outputs: { post }, default: post, topotopo: '0' });
  }
  const fcfg: WebConfig = { file: path.join(tmp, 'config.json'), libraries: [{ name: 'kit', path: kit }], workspaces: [{ name: 'yard', path: yard }, { name: 'old', path: path.join(tmp, 'old') }, { name: 'probe', path: probe }], web: { port: 0, cors: [] } };
  f = await startWeb({ config: fcfg, port: 0, bake: false, auditWait: 60_000 });
  const fr = (p: string, o: { method?: string; headers?: Record<string, string> } = {}) => reqAt(f!.port, p, o);
  const fp = (p: string) => page(p, f!.port);

  section('folder pages: routes');
  {
    const root = await fr('/w/yard/');
    const rh = root.body.toString();
    check(root.status === 200 && /<h1>yard<\/h1>/.test(rh) && /Workspace · Godot · Yard Game/.test(rh), 'a workspace\'s root is its folder page');
    check((await fr('/w/yard')).status === 301 && (await fr('/w/yard')).headers.location === '/w/yard/' && (await fr('/w/yard/notes')).headers.location === '/w/yard/notes/', 'a folder\'s address ends with a slash');
    const notes = await fr('/w/yard/notes/');
    check(notes.status === 200 && /<nav class="crumbs" aria-label="Folders"><a href="\/w\/yard\/">yard<\/a><span class="sep">\/<\/span><span aria-current="page">notes<\/span><\/nav>/.test(notes.body.toString()), 'a folder page has the breadcrumb from the root');
    check((await fr('/l/kit/')).status === 200 && (await fr('/l/kit/Meshes/')).status === 200, 'a library\'s folders are pages at /l/<library>/');
    check((await fr('/w/nope/')).status === 404 && (await fr('/l/nope/')).status === 404 && (await fr('/w/yard/nothing/')).status === 404, 'an unknown workspace, library or folder is 404');
    check((await fr('/l/yard/notes/')).headers.location === '/w/yard/notes/', 'a workspace\'s name under /l/ leads to the workspace');
    const img = await fr('/w/yard/notes/shot.png');
    check(img.status === 200 && img.headers['content-type'] === 'image/png' && !img.headers['content-disposition'] && img.headers['content-security-policy'] === 'sandbox', 'a file\'s address serves it, inline when the browser shows its type');
    const model = await fr('/model/w/yard/props/crate/exports/crate.glb');
    const mh = model.body.toString(), mcsp = String(model.headers['content-security-policy']);
    const map = /<script type="importmap">([^<]*)<\/script>/.exec(mh)?.[1] ?? '';
    check(model.status === 200 && mh.includes('data-src="/w/yard/props/crate/exports/crate.glb"') && /frame-ancestors 'self'/.test(mcsp), 'a model\'s 3D view loads the file, framed by the web app only');
    check(/default-src 'self'/.test(mcsp) && /script-src 'self' 'wasm-unsafe-eval' /.test(mcsp) && /connect-src 'self' data: blob:;/.test(mcsp) && /img-src 'self' data: blob:;/.test(mcsp) && mcsp.includes(`'sha256-${crypto.createHash('sha256').update(map).digest('base64')}'`) && /data-wheel="zoom"/.test(mh),
      'a model\'s 3D view loads nothing from other sites (a glTF\'s outside buffers and textures are refused), three.js by its import map\'s hash; its wheel zooms');
    check((await fr('/model/w/yard/notes/shot.png')).status === 404, 'only models have a 3D view');
  }

  section('folder pages: notes');
  {
    const h = (await fr('/w/yard/notes/')).body.toString();
    check(h.indexOf('id="note-01-overview.md"') > 0 && h.indexOf('id="note-01-overview.md"') < h.indexOf('id="note-02-later.md"') && h.indexOf('id="note-02-later.md"') < h.indexOf('id="note-03-todo.txt"'), 'every .md and .txt file is a box, in file name order');
    check(/<h1 id="note-01-overview\.md--overview-scriptalert1script">Overview &lt;script&gt;alert\(1\)&lt;\/script&gt;<\/h1>/.test(h) && /<strong>strong<\/strong>, <em>em<\/em>, <code>code<\/code>, &lt;b&gt;raw html&lt;\/b&gt;/.test(h) && !/<script>alert/.test(h), 'markdown renders, and raw HTML is escaped');
    check(/<span class="lnk-text"[^>]*>a script link<\/span>/.test(h) && !/href="javascript/.test(h), 'a javascript: link stays text');
    check(/<a class="limg" href="\/w\/yard\/notes\/shot\.png" data-view="image"[^>]*><img src="\/w\/yard\/notes\/shot\.png" alt="shot" width="256" height="256"/.test(h), 'a relative image shows inline, its size known before it loads');
    check(/<div class="lblocks"><span class="embed audio"><span class="cap">the sound<\/span><audio controls preload="metadata" src="\/w\/yard\/sounds\/kick\.wav"><\/audio>/.test(h), 'a link to a sound alone in its paragraph is a player');
    check(/<span class="embed video"><video controls preload="metadata" src="\/w\/yard\/notes\/clip\.webm">/.test(h), 'a link to a video is a player');
    check(/<button type="button" class="lmodel" data-view="model" data-src="\/model\/w\/yard\/props\/crate\/exports\/crate\.glb"[^>]*><span class="cube"><\/span><span><b>the crate in 3D<\/b><span>crate\.glb · View in 3D<\/span>/.test(h) && /<b>crate\.glb<\/b><span>View in 3D<\/span>/.test(h),
      'a link to a model opens it in 3D, titled with the link\'s words (the file\'s name below them, once)');
    check(/<a class="lcard" href="\/w\/yard\/sounds\/">[\s\S]*?<b>the sounds<\/b><span>sounds · 0 folders · 3 files<\/span>/.test(h) && /<a class="lcard" href="\/w\/yard\/props\/crate\/">[\s\S]*?<b>the crate<\/b><span>Crate · package<\/span>/.test(h), 'a link to a folder or a package is a card titled with the link\'s words, the folder\'s name and counts below');
    check(/<a href="#note-02-later\.md">the later note<\/a>/.test(h), 'a link to a note on the same page leads to its box');
    check(/<iframe src="https:\/\/www\.youtube-nocookie\.com\/embed\/aqz-KE-bpKQ\?start=65"/.test(h) && /<iframe src="https:\/\/player\.vimeo\.com\/video\/76979871\?dnt=1"/.test(h), 'YouTube and Vimeo addresses play in their privacy players');
    check(/<a href="https:\/\/example\.com\/x\.png" target="_blank" rel="noopener noreferrer">outside picture<\/a>/.test(h) && !/<img src="https:/.test(h), 'an outside picture stays a link: nothing else from outside is loaded');
    check(/<s class="missing" title="missing: gone\.png">missing<\/s>/.test(h) && /<s class="missing" title="missing: \.\.\/nowhere\/x\.png">also missing<\/s>/.test(h), 'a link to a missing file is struck through');
    check(/<a href="\/w\/yard\/game\/scenes\/main\.tscn">main scene<\/a>/.test(h) && /<s class="missing" title="missing: res:\/\/scenes\/none\.tscn">/.test(h), 'res:// resolves against the Godot project');
    check(/<div class="table"><table><thead><tr><th class="n">a<\/th><th style="text-align:center" class="n">b<\/th>/.test(h), 'tables render, their short cells on one line');
    check(/<pre class="txt">plain &lt;text&gt;\n<a href="https:\/\/example\.com\/x" target="_blank" rel="noopener noreferrer">https:\/\/example\.com\/x<\/a>/.test(h), 'a .txt note is its text, escaped, its addresses linked');
    check(/<a href="https:\/\/www\.youtube\.com\/watch\?v=aqz-KE-bpKQ&amp;t=90s" [^>]*>https:\/\/www\.youtube\.com\/watch\?v=aqz-KE-bpKQ&amp;t=90s<\/a>/.test(h) && /<a href="https:\/\/x\.org\/O&#39;Neil"/.test(h), 'a .txt note\'s address keeps its "&" and "\'"');
    const logs = (await fr('/w/yard/logs/')).body.toString();
    check((logs.match(/<article class="note"/g) ?? []).length === 24 && /6 more notes of this folder are listed with its other files/.test(logs) && /run-30\.txt/.test(logs), 'a folder of many text files shows the first 24 as boxes and lists the rest');
    const asked = (await fr('/w/yard/logs/?note=run-30.txt')).body.toString();
    check(/<article class="note open" id="note-run-30\.txt">/.test(asked) && /5 more notes/.test(asked), 'a note past the boxes opens as one when a link asks for it (?note=)');
    check(/<a href="\/w\/yard\/logs\/\?note=run-30\.txt#note-run-30\.txt">the last run<\/a>/.test(h), 'a link to a note in another folder asks its page to show it');
    const fm = (await fr('/w/yard/board/')).body.toString();
    check(/<dl class="props"><div><dt>title<\/dt><dd>Machine planning off the tick<\/dd><\/div><div><dt>lane<\/dt><dd>done<\/dd><\/div>/.test(fm) && !/<dt>milestone</.test(fm) && !/<hr>\s*<h2/.test(fm) && /<dt>tags<\/dt><dd>ai, threats<\/dd>/.test(fm), 'front matter shows as the note\'s properties, not as a rule and a heading');
    const ordered = fm.indexOf('id="note-README.md"');
    check(ordered > 0 && ordered < fm.indexOf('id="note-01-card.md"') && fm.indexOf('id="note-01-card.md"') < fm.indexOf('id="note-c-00.md"') && /id="note-z-flagged\.md"/.test(fm) && !/id="note-a-prompt\.txt"/.test(fm) && /a-prompt\.txt<\/a>/.test(fm),
      'a folder\'s README is its first box, documents before text files, and a note with a flag is always a box');
    check(/<a href="#note-README\.md--usage">Usage<\/a>/.test(fm) && /<a href="#note-01-card\.md--setup">the card&#39;s setup<\/a>/.test(fm) && /<h2 id="note-01-card\.md--setup">Setup<\/h2>/.test(fm), 'a link to a heading of the note, or of another note, leads to that heading');
    check(/<a class="lk lk-dir" href="\/w\/yard\/sounds\/">kitbash sounds<\/a> fills the streets\.<\/p><div class="lblocks"><a class="lcard" href="\/w\/yard\/sounds\/">/.test(fm), 'a folder link in running text stays a link with its words, its card below the paragraph');
    check(/See the <a class="lk lk-img" href="\/w\/yard\/notes\/shot\.png" data-view="image"[^>]*>concept<\/a>\. More text\.<\/p><div class="lblocks"><figure class="lfig"><a class="limg"[^>]*><img [^>]*><\/a><figcaption>concept<\/figcaption><\/figure>/.test(fm), 'a picture linked in running text: the sentence keeps its word, the picture follows with it as a caption');
    const k = (await fr('/l/kit/')).body.toString();
    check(/<a href="\/l\/kit\/Meshes\/SM_Rock\.uasset">SM_Rock<\/a>/.test(k) && /<s class="missing" title="missing: \/Game\/Kit\/Meshes\/SM_Gone">/.test(k), 'an Unreal /Game/ path resolves against the project\'s Content/');
  }

  section('folder pages: files by type, plumbing hidden, the engine project');
  {
    const h = (await fr('/w/yard/').then((r) => r.body.toString()));
    check(!/\.cache|node_modules|topotopo-packages|>Saved</.test(h.slice(h.indexOf('<main'))), 'dot folders, node_modules, topotopo-packages and engine caches are not shown');
    check((await fr('/w/yard/node_modules/')).status === 404 && (await fr('/w/yard/topotopo-packages/lock.json')).status === 404 && (await fr('/w/yard/props/crate/versions/')).status === 404, 'nor served');
    const crateP = (await fr('/w/yard/props/crate/')).body.toString();
    check(!/href="\/w\/yard\/props\/crate\/versions\/"/.test(crateP) && /href="\/w\/yard\/props\/crate\/exports\/"/.test(crateP) && /href="\/w\/yard\/props\/crate\/graphs\/"/.test(crateP), 'a package\'s versions/ is not shown; its graphs/ and exports/ are');
    check(/<a class="fcard k-engine" href="\/w\/yard\/game\/">[\s\S]*?<span class="ftitle">Yard Game<\/span>[\s\S]*?<span class="fsub">Godot project<\/span>/.test(h) && !/k-engine[\s\S]{0,600}fbadge/.test(h.slice(h.indexOf('k-engine'), h.indexOf('k-engine') + 600)), 'the Godot project inside is one card, without flags');
    const game = (await fr('/w/yard/game/')).body.toString();
    check(/the Godot project: shown as it is, not audited for flags/.test(game) && !/class="flags"/.test(game) && /<s class="missing"/.test(game), 'the Godot project opens as a page: its broken link shows, and is not a flag');
    const art = (await fr('/w/yard/game/art/')).body.toString();
    check(/tile\.png/.test(art) && !/tile\.png\.import|tile\.png\.uid/.test(art), 'the files Godot writes beside ours are hidden');
    const sounds = (await fr('/w/yard/sounds/')).body.toString();
    check(/<h2>Sounds <span class="count">3<\/span><\/h2>/.test(sounds) && (sounds.match(/<audio controls/g) ?? []).length === 3 && !/\.import/.test(sounds), 'sounds are players, one each');
    const notes = (await fr('/w/yard/notes/')).body.toString();
    check(/<h2>Images <span class="count">1<\/span>/.test(notes) && /<h2>Videos <span class="count">1<\/span>/.test(notes) && /<h2>Other files <span class="count">2<\/span>/.test(notes) && /evil\.svg/.test(notes), 'files group by type: images, videos, other files');
    const exportsP = (await fr('/w/yard/props/crate/exports/')).body.toString();
    const tile = (name: string) => { const at = exportsP.indexOf(`<span class="mname">${name}</span>`); return at < 0 ? '' : exportsP.slice(exportsP.lastIndexOf('<button', at), exportsP.indexOf('</button>', at)); };
    check(/<h2>Models <span class="count">2<\/span>/.test(exportsP) && /from main/.test(tile('crate.glb')) && /class="stale"/.test(tile('crate.glb')) && /from main/.test(tile('fresh.glb')) && !/class="stale"/.test(tile('fresh.glb')) && !/source\.json/.test(exportsP),
      'an export shows the graph it came from, its sidecar hidden, and whether its graph changed since (one older than its graph, one not)');
    const k = (await fr('/l/kit/Meshes/')).body.toString();
    check(/2 Unreal assets \(\.uasset, \.umap\)/.test(k) && !/SM_Rock\.uasset<\/a>/.test(k), 'Unreal\'s .uasset and .umap files are one line with a count');
    check(!/href="\/w\/yard\/notes\/out\/"/.test(notes), 'a link leading out of the workspace is not listed');
  }

  section('folder pages: containment, ranges, media types');
  {
    check((await fr('/w/yard/notes/../../outside/secret.txt')).status === 404, '".." in the path never leaves the workspace');
    check((await fr('/w/yard/%2e%2e/outside/secret.txt')).status !== 200 && (await fr('/w/yard/notes/..%2F..%2Foutside%2Fsecret.txt')).status === 400, 'encoded ".." is refused');
    check((await fr('/w/yard/C:%5CWindows%5Cwin.ini')).status === 400 && (await fr('/w/yard/%2Fetc%2Fpasswd')).status === 400 && (await fr('/w/yard//etc/passwd')).status === 400, 'absolute paths are refused');
    check((await fr('/w/yard/.cache/x.txt')).status === 400 && (await fr('/w/yard/game/.godot/cache.bin')).status === 400, 'dot paths are refused');
    const linked = fs.existsSync(path.join(yard, 'notes', 'out'));
    check(!linked || (await fr('/w/yard/notes/out/secret.txt')).status === 400, `a link leading out of the workspace is refused${linked ? '' : ' (no link could be made here)'}`);
    const part = await fr('/w/yard/sounds/kick.wav', { headers: { range: 'bytes=100-199' } });
    check(part.status === 206 && part.headers['content-range'] === 'bytes 100-199/1000' && part.body.length === 100 && part.headers['accept-ranges'] === 'bytes' && part.headers['content-type'] === 'audio/wav', 'a range request answers 206 with that part (audio and video seek)');
    const tail = await fr('/w/yard/sounds/kick.wav', { headers: { range: 'bytes=-10' } }), open = await fr('/w/yard/sounds/kick.wav', { headers: { range: 'bytes=990-' } });
    check(tail.status === 206 && tail.headers['content-range'] === 'bytes 990-999/1000' && open.body.length === 10, 'suffix and open-ended ranges');
    const past = await fr('/w/yard/sounds/kick.wav', { headers: { range: 'bytes=5000-' } });
    check(past.status === 416 && past.headers['content-range'] === 'bytes */1000', 'a range past the end is 416');
    const whole = await fr('/w/yard/sounds/kick.wav');
    check(whole.status === 200 && whole.body.length === 1000 && whole.headers['content-length'] === '1000', 'no range: the whole file');
    check((await fr('/w/yard/sounds/loop.ogg')).headers['content-type'] === 'audio/ogg' && (await fr('/w/yard/notes/clip.webm')).headers['content-type'] === 'video/webm' && (await fr('/w/yard/props/crate/exports/crate.glb')).headers['content-type'] === 'model/gltf-binary', 'media types: audio, video, models');
    const svg = await fr('/w/yard/notes/evil.svg'), htmlFile = await fr('/w/yard/notes/page.html');
    check(/^attachment/.test(String(svg.headers['content-disposition'])) && /^attachment/.test(String(htmlFile.headers['content-disposition'])) && svg.headers['content-security-policy'] === 'sandbox', 'SVG and HTML are sandboxed downloads only');
    check(/^attachment/.test(String((await fr('/w/yard/notes/shot.png?download')).headers['content-disposition'])), '?download downloads any file');
    check((await fr('/w/yard/notes/shot.png', { method: 'POST' })).status === 405, 'files are read only');
  }

  section('folder pages: flags');
  {
    const notes = (await fr('/w/yard/notes/')).body.toString();
    check(/<details class="flags"[\s\S]*?01-overview\.md links to gone\.png, which is not there[\s\S]*?Fix the link, or put the file there/.test(notes) && /res:\/\/scenes\/none\.tscn, which is not there/.test(notes), 'a link to a missing file is a flag on its folder, with what to do');
    const crateP = (await fr('/w/yard/props/crate/')).body.toString();
    check(/exports\/crate\.glb was made from an older version of its graph/.test(crateP) && !/exports\/fresh\.glb was made/.test(crateP), 'an export older than its graph is a flag; one made from the graph as it is is not');
    check(/>crate\.glb<\/a> <span class="stale"/.test(crateP) && !/>fresh\.glb<\/a> <span class="stale"/.test(crateP), 'and the package\'s list of exports marks the same one as older than its graph');
    const broken = (await fr('/w/yard/levels/broken/')).body.toString();
    check(/The preview of Broken did not cook: \[rocks\] unknown node type &quot;scatter_rockz&quot;<\/span>/.test(broken), 'a package whose preview did not cook is a flag, with why');
    const lamp = (await fr('/w/yard/props/lamp/')).body.toString();
    check(/yard\/lamp publishes versions and has none yet/.test(lamp), 'a package that publishes versions and has none is a flag');
    const posts = (await fr('/w/yard/props/posts/')).body.toString();
    check(/yard\/posts has changes that no version holds \(the newest is 1\.0\)/.test(posts), 'a package with changes no version holds is a flag');
    check(/No package in this workspace uses 1 of the 2 outputs yard\/posts 1\.0 publishes: fence/.test(posts), 'published outputs no package of the workspace uses are a flag on the package that publishes them');
    const root = (await fr('/w/yard/')).body.toString();
    const cardFlags = (href: string) => { const at = root.indexOf(`k-folder" href="${href}"`); return /<span class="fbadge"[^>]*>(\d+) flags?<\/span>/.exec(root.slice(at, root.indexOf('</a>', at)))?.[1]; };
    check(cardFlags('/w/yard/notes/') === '3' && cardFlags('/w/yard/props/') === '4' && cardFlags('/w/yard/levels/') === '1', `flags roll up into each folder card (notes ${cardFlags('/w/yard/notes/')}, props ${cardFlags('/w/yard/props/')}, levels ${cardFlags('/w/yard/levels/')})`);
    check(/<details class="flags" aria-label="Flags">\s*<summary><span class="ftotal">9 flags<\/span> <span class="fwhere">in 6 folders below<\/span><span class="fkinds">: \d+ broken links?, /.test(root), 'the root sums its folders\' flags, in one line that opens');
    const home = (await fr('/')).body.toString();
    const card = home.slice(home.indexOf('data-root="w/yard"'), home.indexOf('</a>', home.indexOf('data-root="w/yard"')));
    check(/<span class="stats"><span class="stat"><b>4<\/b> <span>packages<\/span>/.test(card) && /<span class="stat fstat"><b>9<\/b> <span>flags<\/span><\/span><\/span>/.test(card), 'and so does the workspace\'s card on the front page: what is in it first, its flags last');
    check(/<span class="fkind">stale export<\/span>/.test(crateP) && /<span class="fkind">bake failed<\/span>/.test(broken) && /<span class="fkind">unpublished<\/span>/.test(lamp) && /<span class="fkind">unused outputs<\/span>/.test(posts) && /<span class="fkind">broken link<\/span>/.test(notes),
      'each flag\'s chip says what is wrong');
  }

  section('folder pages: what a person looks at first, then the divider');
  {
    const order = (h: string, ...marks: string[]) => marks.every((m, i) => h.indexOf(m) >= 0 && (i === 0 || h.indexOf(marks[i - 1]) < h.indexOf(m)));
    const root = (await fr('/w/yard/')).body.toString();
    check(order(root, '<section class="folders"', 'class="divider"', '<details class="flags"', '<p class="foot">'), 'a workspace\'s root: its folders first, its flags below the divider');
    const notes = (await fr('/w/yard/notes/')).body.toString();
    check(order(notes, '<h2>Images', '<h2>Videos', 'class="divider"', 'id="note-01-overview.md"', '<details class="flags"'), 'a folder: its pictures and files first; below the divider its notes, then its flags');
    const only = (await fr('/w/probe/notes/')).body.toString();
    check(!/class="divider"/.test(only) && order(only, '<div class="head">', 'id="note-01-a.md"', '<details class="flags"'), 'a folder of notes alone: its notes are what it shows, no divider above them');
    const crate = (await fr('/w/yard/props/crate/')).body.toString();
    check(order(crate, 'class="pkgblock"', '<section class="pkgout">', '<h2>Exports', '<section class="pictures"', '<section class="folders"', 'class="divider"', '<section class="pkgdetails">', '<details class="flags"', '<section class="pkgend">'),
      'a package: its preview, its exports, its pictures and its folders first; below the divider its graphs, its flags, the board snippets');
    check(/<section class="pictures" aria-label="Pictures"><h2><a class="hfolder" href="\/w\/yard\/props\/crate\/previews\/">previews\/<\/a> <span class="count">1<\/span><\/h2>\s*<div class="igrid few"><a class="tile" href="\/w\/yard\/props\/crate\/previews\/front\.png" data-view="image"/.test(crate)
      && /class="fcard k-folder" href="\/w\/yard\/props\/crate\/previews\/"/.test(crate), 'a package\'s folder of images shows them as a strip with its pictures; its card stays with the folders');
    const rendersStrip = /<a class="hfolder" href="\/w\/yard\/props\/crate\/renders\/">renders\/<\/a> <span class="count">15<\/span><\/h2>([\s\S]*?)<\/div>\s*<p class="dim small more">and 3 more/.exec(crate);
    check(!!rendersStrip && (rendersStrip[1].match(/class="tile"/g) ?? []).length === 12, `a folder of 15 images: a strip of 12 and "and 3 more" (${rendersStrip ? (rendersStrip[1].match(/class="tile"/g) ?? []).length : 'no strip'})`);
    check(!/class="hfolder" href="\/w\/yard\/props\/crate\/(inputs|thumbs)\/"/.test(crate), 'inputs/ (masks and guides) and thumbs/ (output thumbnails) are no picture strips');
  }

  section('folder pages: flags that are not there');
  {
    const stable = (await fr('/w/probe/props/stable/')).body.toString();
    check(/<h1>Stable<\/h1>/.test(stable) && !/probe\/stable has changes|probe\/stable publishes versions and has none/.test(stable), 'a package whose newest version holds it as it is has no flag to publish');
    check(!/No package in this workspace uses[^<]*probe\/stable/.test(stable), 'nor one for outputs, when a package of the workspace uses each of them (one by its name alone, the default)');
    const q1 = path.join(probe, 'levels', 'q1'), q2 = path.join(probe, 'levels', 'q2');
    const before = (await fr('/w/probe/levels/q2/')).body.toString();
    f!.queue.add(q1);
    f!.queue.add(q2);
    const during = (await fr('/w/probe/levels/q2/')).body.toString();
    const still = f!.queue.pending(q2);
    check(/The preview of Q2 did not cook/.test(before) && (!still || !/The preview of Q2 did not cook/.test(during)), `a preview that did not cook is no flag while it bakes again${still ? '' : ' (the bake ended before the page was read)'}`);
    await f!.queue.idle();
  }

  section('folder pages: a workspace whose file cannot be read');
  {
    const home = (await fr('/')).body.toString();
    const card = home.slice(home.indexOf('data-root="w/old"'), home.indexOf('</a>', home.indexOf('data-root="w/old"')));
    check(/<span class="rprob">Its workspace file cannot be read: see its page<\/span>/.test(card) && /<span class="stat fstat"><b>1<\/b> <span>flag<\/span>/.test(card), 'its card says its file cannot be read, as a flag');
    const root = (await fr('/w/old/')).body.toString();
    check(/<span class="fkind">workspace<\/span><span class="fwhat">old\.topows cannot be read: [^<]*assets/.test(root) && /href="\/w\/old\/props\/"/.test(root), 'its root says what is wrong with the file, and its folders still show');
    check(/<h1>Chair<\/h1>/.test((await fr('/w/old/props/chair/')).body.toString()), 'and its packages');
  }

  section('folder pages: old routes');
  {
    check((await fr('/p/yard/crate')).headers.location === '/w/yard/props/crate/' && (await fr('/p/yard/crate/thumb.png')).status === 200 && (await fr('/embed/yard/crate')).status === 200, 'a package\'s stable address, thumbnail and embed answer');
    check((await fr('/p/yard/crate/files/exports/crate.glb')).status === 200 && (await fr('/p/yard/crate/files/exports/crate.glb', { headers: { range: 'bytes=0-3' } })).body.toString('latin1') === 'glTF', 'and its files, with ranges');
    check((await fr('/p/yard/crate/bake')).status === 405 && (await fr('/p/yard/crate/reveal')).status === 405, 'its actions still need POST');
  }

  section('notes: what a link may never do');
  {
    // a link to a network share, or to a path outside the tree or in plumbing, is never looked up: a stat of
    // \\host\share would open an SMB connection (and offer the user's credentials) to whatever host a note names
    const looked: string[] = [];
    const watch = <T extends (...a: any[]) => any>(fn: T): T => ((p: any, ...rest: any[]) => {
      const s = String(p);
      if (/^[\\/]{2}/.test(s) || /unreachable\.invalid|outside[\\/]nothere|\.secret[\\/]nothere/.test(s)) { looked.push(s); throw Object.assign(new Error('refused by the test'), { code: 'UNKNOWN' }); }
      return fn(p, ...rest);
    }) as T;
    const keep = { statSync: fs.statSync, realpathSync: fs.realpathSync, existsSync: fs.existsSync, readdirSync: fs.readdirSync, openSync: fs.openSync };
    const native = fs.realpathSync.native;
    (fs as any).statSync = watch(keep.statSync); (fs as any).existsSync = watch(keep.existsSync); (fs as any).readdirSync = watch(keep.readdirSync); (fs as any).openSync = watch(keep.openSync);
    (fs as any).realpathSync = Object.assign(watch(keep.realpathSync), { native: watch(native) });
    try {
      const proot = { kind: 'w' as const, name: 'probe', dir: probe, engine: { type: 'godot' as const, file: path.join(probe, 'game', 'project.godot') } };
      const notes = path.join(probe, 'notes');
      const hrefs = ['%5C%5Cunreachable.invalid%5Cs%5Cx.png', '/%5C%5Cunreachable.invalid%5Cs%5Cy.png', '\\\\unreachable.invalid\\s\\z.png', 'res://%5C%5Cunreachable.invalid%5Cs%5Cr.png', '../../outside/nothere.png', '../.secret/nothere.png', 'C:%5CWindows%5Cwin.ini', '%2F%2Funreachable.invalid%2Fs%2Fq.png'];
      const out = hrefs.map((h) => resolveLink(proot, notes, h));
      check(out.every((t) => t.t === 'text') && !looked.length, `a network share (\\\\host\\share, also percent-encoded, from the root or res://), an absolute path, a path out of the tree or into a dot folder stays text and is never looked up (${out.map((t) => t.t).join(' ')}; looked up: ${looked.join(', ') || 'nothing'})`);
      const walk = await walkTree(proot);
      check(!looked.length && walk.flags.filter((x) => x.note === '02-unc.md').map((x) => x.what).join(' | ') === '02-unc.md links to gone.png, which is not there',
        `the audit looks none of them up and flags none of them; one that cannot be looked up hides no other broken link (${walk.flags.map((x) => x.what).join(' | ')})`);
    } finally { Object.assign(fs, keep); (fs as any).realpathSync = Object.assign(keep.realpathSync, { native }); }
    const page = await fr('/w/probe/notes/');
    const ph = page.body.toString();
    check(page.status === 200 && /<s class="missing" title="missing: gone\.png">gone<\/s>/.test(ph) && !/missing: \.\.\/\.\.\/outside/.test(ph) && !/C:\\\\Users|AppData/.test(ph.slice(0, ph.indexOf('<p class="foot">'))), 'a note whose link names no file (a NUL in it) still renders, its other broken link struck through, no path of this machine shown');
  }

  section('folder pages: plumbing by another name');
  {
    const linked = fs.existsSync(path.join(probe, 'inner'));
    check(!linked || ((await fr('/w/probe/inner/key.txt')).status === 404 && !/href="\/w\/probe\/inner\/"/.test((await fr('/w/probe/')).body.toString())), `a link inside the tree that leads into a dot folder is neither listed nor served${linked ? '' : ' (no link could be made here)'}`);
    const proot = { kind: 'w' as const, name: 'probe', dir: probe, engine: null };
    if (linked) {
      const stat = fs.statSync, lstat = fs.lstatSync, readlink = fs.readlinkSync, native = fs.realpathSync.native;
      const looked: string[] = [];
      const guard = (fn: (...args: any[]) => any) => (file: any, ...args: any[]) => {
        if (/inner[\\/]missing|^[\\/]{2}/.test(String(file))) { looked.push(String(file)); throw new Error('unsafe lookup'); }
        return fn(file, ...args);
      };
      try {
        (fs as any).statSync = guard(stat); (fs as any).lstatSync = guard(lstat); fs.realpathSync.native = guard(native) as typeof native;
        check(resolveLink(proot, probe, 'inner/missing.png').t === 'text' && !looked.length, 'a missing file through a hidden junction stays text without probing its child');
        // Simulate a network junction by replacing only readlink: no network share is ever created or contacted.
        (fs as any).readlinkSync = (file: any, ...args: any[]) => path.basename(String(file)) === 'inner' ? '\\\\unreachable.invalid\\share' : (readlink as any)(file, ...args);
        check(resolveLink(proot, probe, 'inner/missing.png').t === 'text' && !looked.length, 'a network junction target is rejected before it is followed');
        check((await fr('/w/probe/inner/key.txt')).status === 400 && !looked.length, 'file serving rejects a network junction before following it too');
      } finally { fs.statSync = stat; fs.lstatSync = lstat; fs.readlinkSync = readlink; fs.realpathSync.native = native; }
    }
    let short = '';
    if (process.platform === 'win32') { try { short = /<DIR>\s+(\S+~\d\S*)\s+\.secret\s*$/m.exec(execFileSync('cmd', ['/c', 'dir', '/x', '/a', probe], { encoding: 'utf8' }))?.[1] ?? ''; } catch { /* no dir: no short names */ } }
    check(!short || ((await fr(`/w/probe/${short}/key.txt`)).status === 404 && (await fr(`/w/probe/${short}/`)).status === 404), `a Windows short name of a dot folder (${short || 'none on this volume'}) is refused as the folder is`);
    check(!short || resolveLink(proot, probe, `${short}/missing.png`).t === 'text', 'a missing file below a hidden short name stays text, not a broken-link flag');
    const caseless = fs.existsSync(path.join(yard, 'NOTES'));
    const upper = await fr('/w/yard/NOTES/');
    check(!caseless ? upper.status === 404 : upper.status === 301 && upper.headers.location === '/w/yard/notes/', `a folder asked for in another letter case leads to its own address (its flags are found by it)${caseless ? '' : ' (a case-sensitive file system: 404)'}`);
  }

  section('folder pages: links written through a root alias');
  {
    const target = path.join(tmp, 'alias-target'), alias = path.join(tmp, 'alias-root'), outside = path.join(tmp, 'alias-outside');
    write(path.join(target, 'visible', 'readme.txt'), 'visible');
    write(path.join(target, '.secret', 'key.txt'), 'secret');
    write(path.join(outside, 'key.txt'), 'outside');
    const type = process.platform === 'win32' ? 'junction' : 'dir';
    fs.symlinkSync(target, alias, type);
    fs.symlinkSync(path.join(alias, 'visible'), path.join(target, 'visible-link'), type);
    fs.symlinkSync(path.join(alias, '.secret'), path.join(target, 'hidden-link'), type);
    fs.symlinkSync(outside, path.join(target, 'outside-link'), type);
    const status = (parts: string[]) => {
      try { return { code: 200, abs: resolveIn(alias, parts).abs }; }
      catch (e) { if (e instanceof PathError) return { code: e.status, abs: '' }; throw e; }
    };
    const visible = status(['visible-link', 'readme.txt']);
    check(visible.code === 200 && fs.readFileSync(visible.abs, 'utf8') === 'visible', 'an internal link written with the configured root alias remains readable');
    check(status(['hidden-link', 'key.txt']).code === 404, 'a hidden target written with the root alias is hidden, not misclassified as outside');
    const names = listFolder(alias, '', alias).folders.map((f) => f.name);
    check(names.includes('visible-link') && !names.includes('hidden-link') && !names.includes('outside-link'), 'listing through a root alias shows visible internal links and hides hidden or external links');
    const stat = fs.statSync, lstat = fs.lstatSync, native = fs.realpathSync.native;
    const looked: string[] = [];
    const sensitive = [path.join(target, '.secret'), path.join(alias, '.secret'), outside];
    const guard = (fn: (...args: any[]) => any) => (file: any, ...args: any[]) => {
      const p = path.resolve(String(file));
      if (sensitive.some((d) => p === d || p.startsWith(d + path.sep))) { looked.push(p); throw new Error('unsafe lookup'); }
      return fn(file, ...args);
    };
    try {
      (fs as any).statSync = guard(stat); (fs as any).lstatSync = guard(lstat); fs.realpathSync.native = guard(native) as typeof native;
      check(status(['hidden-link', 'missing.txt']).code === 404 && !looked.length, 'a missing child through a root-alias link is hidden before its target is probed');
      check(status(['outside-link', 'key.txt']).code === 400 && !looked.length, 'root-alias handling still rejects an outside target before probing it');
    } finally { fs.statSync = stat; fs.lstatSync = lstat; fs.realpathSync.native = native; }
  }

  section('folder pages: the look, in the markup');
  {
    const root = (await fr('/w/probe/')).body.toString();
    check(/<h2>Folders <span class="count">\d+ · 2 empty<\/span><\/h2>/.test(root) && /<p class="empties"><span class="dim">Empty:<\/span> <a href="\/w\/probe\/empty-a\/">empty-a<\/a><span class="dim">, <\/span><a href="\/w\/probe\/empty-b\/">empty-b<\/a><\/p>/.test(root) && !/k-folder" href="\/w\/probe\/empty-a\/"/.test(root),
      'empty folders are one line of links, not cards');
    const toolCard = root.slice(root.indexOf('href="/w/probe/tools/"'), root.indexOf('</a>', root.indexOf('href="/w/probe/tools/"')));
    check(toolCard.length > 0 && !/node_modules/.test(toolCard), 'a folder\'s picture never comes from plumbing (which is not served)');
    const mixed = root.slice(root.indexOf('href="/w/probe/mixed/"'), root.indexOf('</a>', root.indexOf('href="/w/probe/mixed/"')));
    const mixedPage = (await fr('/w/probe/mixed/')).body.toString();
    check(/<span class="fsub">0 folders · 1 file · 3 Unreal assets<\/span>/.test(mixed) && /<p class="hstats">0 folders · 1 file<\/p>/.test(mixedPage), 'a folder card counts files as its page does: Unreal\'s assets apart');
    const kitCard = (await fr('/w/probe/kit/tower/')).body.toString();
    const ex = kitCard.slice(kitCard.indexOf('href="/w/probe/kit/tower/exports/"'), kitCard.indexOf('</a>', kitCard.indexOf('href="/w/probe/kit/tower/exports/"')));
    check(/<span class="fsub">0 folders · 1 file<\/span>/.test(ex) && /<p class="hstats">0 folders · 1 file<\/p>/.test((await fr('/w/probe/kit/tower/exports/')).body.toString()), 'and an export\'s sidecar with the export it describes');
    const quay = (await fr('/w/probe/levels/quay/')).body.toString();
    check(/<div class="view none"><span class="cube"><\/span><p>No preview yet: this package has no graph to bake<\/p><\/div>/.test(quay) && !/data-post="[^"]*\/bake"/.test(quay), 'a package with no graph: a short frame that says so, and no Re-bake');
    check((await fr('/p/probe/quay/bake', { method: 'POST' })).status === 400 && !fs.existsSync(path.join(probe, 'levels', 'quay', '.web', 'bake.json')), 'and nothing is baked when asked: there is nothing to bake');
    check(!/class="pkgcols/.test(quay) && /class="divider"[\s\S]*<h2>Graphs <span class="count">0<\/span>/.test(quay), 'a package that makes nothing yet, publishes no versions and uses none: no empty parts, its graphs below the divider');
    check(/<section class="pkgout"><div class="pkgcols solo"><div><h2>Exports <span class="count">1<\/span>/.test(kitCard), 'a package with exports and no versions: its exports in one column, no empty one beside them');
    const yard2 = (await fr('/w/probe/levels/yard2/')).body.toString();
    check(/<div class="stage old"><img class="view pic" src="\/p\/probe\/yard2\/thumb\.png[^"]*" alt="Yard2" width="512" height="512"><span class="oldmark">Last good preview: the newest graph did not cook<\/span><\/div>/.test(yard2), 'a bake that failed: the last good preview, at its own size, dimmed and marked');
    const sounds = (await fr('/w/probe/sounds/')).body.toString();
    check(/<audio controls preload="metadata" src="\/w\/probe\/sounds\/blip\.wav"><\/audio><span class="adur" title="length"><\/span><span class="asize">/.test(sounds), 'each sound has its length beside its size (filled in when the player reads it)');
  }

  section('the walk: in turns, and where it stops short');
  {
    const proot = { kind: 'w' as const, name: 'probe', dir: probe, engine: null };
    let turned = false, first = '';
    setImmediate(() => { turned = true; });
    await walkTree(proot, { slice: 0 }).then(() => { first ||= turned ? 'turn' : 'walk'; });
    let turned2 = false, first2 = '';
    setImmediate(() => { turned2 = true; });
    await walkTree(proot).then(() => { first2 ||= turned2 ? 'turn' : 'walk'; });
    check(first === 'turn' && first2 === 'walk', `a server's walk gives the event loop turns (pages keep answering while a large tree is audited): ${first} / ${first2}`);
    const cut = await walkTree(proot, { limits: { notes: 1, depth: 1 } });
    check(cut.cut.some((x) => /the first 1 notes were checked/.test(x)) && cut.cut.some((x) => /more than 1 below the root/.test(x)), `a walk that stops short says where (${cut.cut.join('; ')})`);
    const h = await startWeb({ config: { file: path.join(tmp, 'config.json'), libraries: [], workspaces: [{ name: 'probe', path: probe }], web: { port: 0, cors: [] } }, port: 0, bake: false, walkLimits: { notes: 1 }, auditWait: 60_000 });
    try {
      const home = (await reqAt(h.port, '/')).body.toString();
      const pr = (await reqAt(h.port, '/w/probe/')).body.toString();
      check(/<b>\d+\+<\/b> <span>flags<\/span>/.test(home) && /class="rcut"/.test(home) && /<p class="notice cut">Audited in part, a very large tree: the first 1 notes were checked for links\. Flags past that are not counted\.<\/p>/.test(pr),
        'and the front page and the root\'s page say so: the flag count is a floor');
    } finally { h.close(); }
    // the audits follow the files: a note written while the server runs (also while its first audit is under way) is
    // read again, and so is one fixed, in the tree that changed
    const live = path.join(tmp, 'live');
    write(path.join(live, 'live.topows'), { libraries: [] });
    write(path.join(live, 'docs', 'a.md'), 'A note.\n');
    const lv = await startWeb({ config: { file: path.join(tmp, 'config.json'), libraries: [], workspaces: [{ name: 'live', path: live }], web: { port: 0, cors: [] } }, port: 0, bake: false });
    try {
      write(path.join(live, 'docs', 'b.md'), '[gone](gone.png)\n');
      const flagged = await until(async () => /b\.md links to gone\.png, which is not there/.test((await reqAt(lv.port, '/w/live/')).body.toString()), 10_000);
      write(path.join(live, 'docs', 'b.md'), '[a](a.md)\n');
      const fixed = await until(async () => !/b\.md links to gone\.png/.test((await reqAt(lv.port, '/w/live/')).body.toString()), 10_000);
      check(flagged && fixed, `a broken link written while the server runs is a flag on its root, and goes when it is fixed (${flagged} / ${fixed})`);
    } finally { lv.close(); }
  }

  section('audits of a large tree: each thing read once, pages that do not wait');
  {
    // a graph is read and hashed once per change, however many exports name it: those made from it as it is, those
    // older than it, those made with other vars
    const kit = path.join(tmp, 'hashes', 'kit');
    const graph = { vars: { size: 1 }, nodes: { b: { type: 'box', params: { size: '$size' } } }, output: 'b' };
    const graphFile = path.join(kit, 'graphs', 'main.json');
    write(graphFile, graph);
    const sha = (spec: object) => sha256Hex(canonicalJSON(spec));
    const made = (name: string, graphSha: string, vars: object) => write(path.join(kit, 'exports', `${name}.glb.source.json`), { format: 'topotopo-export-source', version: 1, files: [`${name}.glb`], source: { graph: 'main', graph_sha256: graphSha, output: null, node: 'b', frame: 1, fps: 24, vars, seeds: {}, export: { format: 'glb', options: {} }, topotopo: '0' } });
    for (let i = 0; i < 20; i++) made(`a-fresh-${i}`, sha(graph), { size: 1 });
    for (let i = 0; i < 5; i++) made(`b-old-${i}`, sha({ ...graph, output: 'old' }), { size: 1 });
    for (let i = 0; i < 5; i++) made(`c-vars-${i}`, sha({ ...graph, vars: { size: 2 } }), { size: 2 });
    const reads = { n: 0 };
    const readFile = fs.readFileSync;
    (fs as any).readFileSync = (...a: Parameters<typeof readFile>) => { if (path.resolve(String(a[0])) === path.resolve(graphFile)) reads.n++; return (readFile as any)(...a); };
    try {
      const stale = () => exportSources(kit).map((e) => `${e.rel.replace(/-\d+\.glb$/, '')}:${exportStale(graphFile, e.made)}`);
      const first = new Set(stale()), firstReads = reads.n;
      check(first.size === 3 && first.has('a-fresh:false') && first.has('b-old:graph') && first.has('c-vars:false') && firstReads === 2,
        `30 exports of one graph: it is read twice, once for its hash and once for the other vars set (${firstReads} reads; ${[...first].join(', ')})`);
      stale();
      check(reads.n === firstReads, `checked again, unchanged: it is not read again (${reads.n - firstReads} reads)`);
      write(graphFile, { ...graph, nodes: { b: { type: 'sphere' } } });
      const after = new Set(stale());
      check(after.size === 3 && after.has('a-fresh:graph') && after.has('b-old:graph') && after.has('c-vars:graph') && reads.n - firstReads === 2,
        `the graph changed: read again once per vars set, and every export is older than it (${reads.n - firstReads} reads; ${[...after].join(', ')})`);
      write(graphFile, '{ not json');
      const broken = new Set(stale());
      write(graphFile, graph);
      const back = new Set(stale());
      check(broken.size === 3 && [...broken].every((x) => x.endsWith(':null')) && back.has('a-fresh:false') && back.has('c-vars:false') && back.has('b-old:graph'),
        `a graph that cannot be read says so for each export, and when it is mended they are as before (${[...broken].join(', ')} / ${[...back].join(', ')})`);
    } finally { (fs as any).readFileSync = readFile; }

    // an export's sidecar is opened once per change, however many walks and checks read it
    const side = path.join(tmp, 'sidecars');
    const sidecar = (i: number, graphSha: string) => write(path.join(side, 'exports', `m${i}.glb.source.json`), { format: 'topotopo-export-source', version: 1, files: [`m${i}.glb`], source: { graph: 'main', graph_sha256: graphSha, output: null, node: 'b', frame: 1, fps: 24, vars: {}, seeds: {}, export: { format: 'glb', options: {} }, topotopo: '0' } });
    write(path.join(side, 'side.topows'), { libraries: [] });
    for (let i = 0; i < 10; i++) { write(path.join(side, 'exports', `m${i}.glb`), 'x'); sidecar(i, 'a'.repeat(64)); }
    const opened: string[] = [];
    const open = fs.openSync;
    (fs as any).openSync = (...a: Parameters<typeof open>) => { if (/\.source\.json$/.test(String(a[0]))) opened.push(String(a[0])); return (open as any)(...a); };
    try {
      const sideRoot = { kind: 'w' as const, name: 'side', dir: side, engine: null };
      await walkTree(sideRoot);
      const firstOpens = opened.length;
      exportSources(side);
      await walkTree(sideRoot);
      const again = opened.length - firstOpens;
      sidecar(3, 'b'.repeat(64));
      const changed = exportSources(side).find((e) => e.rel === 'm3.glb')?.made.graph_sha256;
      await walkTree(sideRoot);
      check(firstOpens === 10 && again === 0 && opened.length === 11 && changed === 'b'.repeat(64),
        `10 sidecars: each opened once by the first walk, then by no check or walk until one changes, which is read again (${firstOpens}, ${again}, ${opened.length - firstOpens - again})`);
    } finally { (fs as any).openSync = open; }

    // a walk looks up what its notes' links share once: each path's real path is asked once, and the flags are those of
    // the links looked up one by one
    const shared = path.join(tmp, 'shared-links');
    write(path.join(shared, 'shared.topows'), { libraries: [] });
    write(path.join(shared, 'art', 'pics', 'a.png'), PNG);
    for (let i = 0; i < 30; i++) write(path.join(shared, 'docs', `n${String(i).padStart(2, '0')}`, 'note.md'), `[a](../../art/pics/a.png) [gone](../../art/pics/gone.png) [top](/art/pics/a.png)\n`);
    const sroot = { kind: 'w' as const, name: 'shared', dir: shared, engine: null };
    const asked = new Map<string, number>();
    const native = fs.realpathSync.native;
    fs.realpathSync.native = ((p: any, o?: any) => { asked.set(String(p), (asked.get(String(p)) ?? 0) + 1); return (native as any)(p, o); }) as typeof native;
    let walk;
    try { walk = await walkTree(sroot); } finally { fs.realpathSync.native = native; }
    const most = Math.max(...asked.values());
    const oneByOne = fs.readdirSync(path.join(shared, 'docs')).flatMap((d) => ['../../art/pics/a.png', '../../art/pics/gone.png', '/art/pics/a.png'].map((h) => resolveLink(sroot, path.join(shared, 'docs', d), h))).filter((t) => t.t === 'path' && !t.exists).length;
    check(most === 1 && walk.flags.length === 30 && oneByOne === 30 && walk.flags.every((f) => /note\.md links to \.\.\/\.\.\/art\/pics\/gone\.png, which is not there/.test(f.what)),
      `90 links of 30 notes to the same folder: each real path asked once (at most ${most} times, ${asked.size} paths), the same 30 broken links as looked up one by one (${walk.flags.length} / ${oneByOne})`);

    // a page answers while its tree's audit runs: with none yet it says the tree is being checked; made from the audit
    // before a change it says the tree is checked again. Either waits for the audit of the tree as it is (its number), and
    // hears of it however late it connects to the event stream
    const big = path.join(tmp, 'big');
    write(path.join(big, 'big.topows'), { libraries: [] });
    for (let i = 0; i < 400; i++) write(path.join(big, 'notes', `d${i % 20}`, `n${i}.md`), `[gone](gone-${i}.png) [up](../d${(i + 1) % 20}/n${(i + 1) % 400}.md)\n`);
    // and a package with an export older than its graph, exported again
    const re = path.join(tmp, 'reexport');
    write(path.join(re, 're.topows'), { libraries: [] });
    for (let i = 0; i < 20; i++) write(path.join(re, 'notes', `n${i}.md`), `[next](n${(i + 1) % 20}.md)\n`);
    const reCrate = createPackage({ name: 're', path: re, workspace: true }, 'props/crate', { title: 'Crate', graph: BOX });
    const reSource = (graphSha: string) => ({ format: 'topotopo-export-source', version: 1, files: ['crate.glb'], source: { graph: 'main', graph_sha256: graphSha, output: null, node: 'b', frame: 1, fps: 24, vars: {}, seeds: {}, export: { format: 'glb', options: {} }, topotopo: '0' } });
    write(path.join(reCrate.dir, 'exports', 'crate.glb'), 'glTF');
    write(path.join(reCrate.dir, 'exports', 'crate.glb.source.json'), reSource(sha256Hex(canonicalJSON({ nodes: { b: { type: 'sphere' } }, output: 'b' }))));
    // a slow disk: each look at a path of the trees takes a moment (the audits still give the event loop their turns).
    // The walks look at real paths, which differ from tmp's when it has a short name (C:\Users\RUNNER~1\…)
    const slow: [string, number][] = [big, re].flatMap((d, i) => [...new Set([d, fs.realpathSync.native(d)])].map((x): [string, number] => [x, i ? 2 : 0.2]));
    const lstat = fs.lstatSync;
    (fs as any).lstatSync = (...a: Parameters<typeof lstat>) => { const s = slow.find(([d]) => String(a[0]).startsWith(d)); if (s) { const t = performance.now(); while (performance.now() - t < s[1]) { /* a slow disk */ } } return (lstat as any)(...a); };
    const bw = await startWeb({ config: { file: path.join(tmp, 'config.json'), libraries: [], workspaces: [{ name: 'big', path: big }, { name: 're', path: re }], web: { port: 0, cors: [] } }, port: 0, bake: false, auditWait: 0 });
    const live = (html: string) => JSON.parse(/data-json="([^"]*)"/.exec(html)?.[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') ?? '{}');
    const streams = new Set<http.ClientRequest>();
    const listen = () => {
      const got = { text: '', close: () => s.destroy() };
      const s = http.get({ host: '127.0.0.1', port: bw.port, path: '/api/events', headers: { host: `127.0.0.1:${bw.port}` } }, (res) => res.on('data', (c) => { got.text += c; }));
      s.on('error', () => {});
      s.on('close', () => streams.delete(s));
      streams.add(s);
      return got;
    };
    type AuditEvent = { audits?: Record<string, number>; changed?: string[]; folders?: string[]; audited?: string; n?: number };
    const events = (text: string): AuditEvent[] => [...text.matchAll(/^data: (.+)\n/gm)].map((m) => JSON.parse(m[1]));
    /** the trees whose audit is ready, as a page that connects now hears first */
    const readyNow = async (ms = 5000): Promise<Record<string, number>> => {
      const s = listen();
      try {
        await until(() => events(s.text).length > 0, ms);
        return events(s.text)[0]?.audits ?? {};
      } finally { s.close(); }
    };
    const auditedN = (data: AuditEvent[], key: string) => Math.max(0, ...data.filter((e) => e.audited === key).map((e) => e.n ?? 0));
    const auditAfterChange = async (late: ReturnType<typeof listen>, from: number, folder: string, key: string, before: number) => {
      const changeAt = (data: AuditEvent[]) => data.findLastIndex((e, i) => i >= from && e.changed !== undefined && !!e.folders?.includes(folder));
      const changed = await until(() => changeAt(events(late.text)) >= 0, 10_000);
      check(changed, `the file watcher reports a change in ${folder}`);
      return changed && await until(() => {
        const data = events(late.text);
        return auditedN(data.slice(changeAt(data) + 1), key) > before;
      }, 30_000);
    };
    const checkLatePage = async (late: ReturnType<typeof listen>, key: string, before: number, label: string) => {
      let listed: number | undefined, heard = 0, matched = false;
      const deadline = Date.now() + 10_000;
      const same = await until(async () => {
        if (matched || Date.now() >= deadline) return matched;
        listed = (await readyNow(Math.min(5000, deadline - Date.now())))[key];
        heard = auditedN(events(late.text), key);
        matched = heard > before && listed === heard;
        return matched;
      }, 10_000);
      check(same, `${label} (listed ${listed}, heard ${heard})`);
    };
    try {
      const home = (await reqAt(bw.port, '/')).body.toString();
      const page = (await reqAt(bw.port, '/w/big/')).body.toString();
      check(/<a class="rcard ws checking"[^>]*data-root="w\/big" data-wait="0"/.test(home) && /checking for flags…/.test(home) && /<p class="notice checking">Checking the workspace for flags/.test(page) && !/class="flags"/.test(page) && live(page).wait === 0,
        'pages made while the first audit runs answer at once: the card and the page say the tree is being checked, no flags yet, and wait for its audit');
      const full = await until(async () => /<span class="ftotal">400 flags<\/span>/.test((await reqAt(bw.port, '/w/big/')).body.toString()), 30_000);
      const shown = (await reqAt(bw.port, '/w/big/')).body.toString();
      check(full && live(shown).wait === undefined && !/rechecking/.test(shown), 'when the audit is done the page shows its 400 broken links, and waits for nothing');
      // a page made while the audit ran connects only after it was made (its script loads first): the event stream
      // tells it first which trees have their audit, with its number
      const late = listen();
      await until(() => events(late.text).length > 0, 5000);
      const ready = events(late.text)[0]?.audits ?? {};
      check(ready['w/big'] > 0, `a page that connects after its tree's audit was made still hears of it: the stream first lists the trees whose audit is ready (${JSON.stringify(ready)})`);
      const before = ready['w/big'];
      const from = events(late.text).length;
      write(path.join(big, 'notes', 'd0', 'extra.md'), '[gone](gone-extra.png)\n');
      bw.rescan();
      const during = (await reqAt(bw.port, '/w/big/')).body.toString();
      const homeDuring = (await reqAt(bw.port, '/')).body.toString();
      // the audit before is no news to a page that connects now (it is not of the tree as it is)
      const listed = (await readyNow())['w/big'];
      check(/<span class="ftotal">400 flags<\/span>/.test(during) && !/notice checking/.test(during) && /class="dim small rechecking">Re-checking after a change/.test(during) && live(during).wait === before
        && new RegExp(`<a class="rcard ws rechecking"[^>]*data-root="w/big" data-wait="${before}"`).test(homeDuring) && /re-checking…/.test(homeDuring) && listed !== before,
        `the tree changed: a page answers at once with the audit before, says it is checked again, and waits for the next (wait ${live(during).wait}, audit ${before}, listed ${listed})`);
      const done = await auditAfterChange(late, from, 'w/big/notes/d0', 'w/big', before);
      const nextPage = (await reqAt(bw.port, '/w/big/')).body.toString();
      check(done && /<span class="ftotal">401 flags<\/span>/.test(nextPage) && live(nextPage).wait === undefined && !/rechecking/.test(nextPage),
        `the event stream says when the next audit is made (its number ${auditedN(events(late.text), 'w/big')} after ${before}), and the page made then shows it`);
      await checkLatePage(late, 'w/big', before, 'and a page that connects later hears of that one');

      // he exports again and reloads at once: the package page shows the audit before (its export still older than its
      // graph, as its flag) and says it is checked again; the exports list reads the export as it is; when the audit is
      // made the package page shows the export made from its graph as it is
      const crateUrl = '/w/re/props/crate/';
      const staleMark = />crate\.glb<\/a> <span class="stale"/;
      const settled = await until(async () => { const b = (await reqAt(bw.port, crateUrl)).body.toString(); return staleMark.test(b) && live(b).wait === undefined; }, 30_000);
      check(settled && /exports\/crate\.glb was made from an older version of its graph/.test((await reqAt(bw.port, crateUrl)).body.toString()), 'a package page marks an export older than its graph, as its audit says');
      const reBefore = (await readyNow())['w/re'] ?? 0;
      const reFrom = events(late.text).length;
      write(path.join(reCrate.dir, 'exports', 'crate.glb.source.json'), reSource(sha256Hex(canonicalJSON(BOX))));
      bw.rescan();
      const reDuring = (await reqAt(bw.port, crateUrl)).body.toString();
      const listing = (await reqAt(bw.port, `${crateUrl}exports/`)).body.toString();
      check(staleMark.test(reDuring) && /class="dim small rechecking">Re-checking after a change/.test(reDuring) && live(reDuring).wait === reBefore && reBefore > 0 && !/class="stale"/.test(listing),
        `exported again, the page reloaded at once: it shows the audit before and says it is checked again (wait ${live(reDuring).wait}); the exports list reads it as it is`);
      const reDone = await auditAfterChange(late, reFrom, 'w/re/props/crate/exports', 'w/re', reBefore);
      const reAfter = (await reqAt(bw.port, crateUrl)).body.toString();
      check(reDone && !staleMark.test(reAfter) && !/exports\/crate\.glb was made from an older version/.test(reAfter) && live(reAfter).wait === undefined && !/rechecking/.test(reAfter),
        `when its audit is made (number ${auditedN(events(late.text), 'w/re')}) the page it reloads to marks the export as made from its graph as it is, and waits for nothing`);
      await checkLatePage(late, 'w/re', reBefore, 'and a package page that connects later hears of that one');
    } finally { for (const s of streams) s.destroy(); bw.close(); (fs as any).lstatSync = lstat; }
  }

  // ------------------------------------------------------------------------------------------- markdown, links
  section('markdown and link rules alone');
  {
    check(renderMarkdown('<img src=x onerror=alert(1)>') === '<p>&lt;img src=x onerror=alert(1)&gt;</p>', 'raw HTML is text');
    check(renderMarkdown('[x](javascript:alert(1)) [y](data:text/html,1) [z](https://a.b/c)') === '<p>x y <a href="https://a.b/c" target="_blank" rel="noopener noreferrer">z</a></p>', 'only web, mail and relative addresses link by default');
    check(renderMarkdown('- a\n- b\n  - c\n\n1. one\n2. two') === '<ul><li>a</li><li>b\n<ul><li>c</li></ul></li></ul>\n<ol><li>one</li><li>two</li></ol>', 'lists, nested and ordered');
    check(renderMarkdown('```js\nconst a = "<b>";\n```') === '<pre><code class="language-js">const a = &quot;&lt;b&gt;&quot;;</code></pre>', 'fenced code is escaped');
    check(renderMarkdown('> **quote**\n\n---\n\nsnake_case_name and _em_') === '<blockquote><p><strong>quote</strong></p></blockquote>\n<hr>\n<p>snake_case_name and <em>em</em></p>', 'quotes, rules, and underscores inside words stay');
    const timeMarkdown = () => {
      const t0 = performance.now();
      for (const s of ['['.repeat(100000), '*a '.repeat(30000), 'a `'.repeat(30000), '[a](b) '.repeat(30000)]) renderMarkdown(s);
      return performance.now() - t0;
    };
    const first = timeMarkdown();
    const second = first >= 3000 ? timeMarkdown() : undefined;
    const times = `${first.toFixed(0)} ms${second === undefined ? '' : `, again ${second.toFixed(0)} ms`}`;
    check(Math.min(first, second ?? first) < 3000, `a note of 100,000 brackets, stars or backticks renders in time (${times}): nothing is scanned again from every mark`);
    check(renderMarkdown('[ref][r]\n\n[r]: other.md "T"') === '<p><a href="other.md" title="T">ref</a></p>', 'reference links');
    check(markdownLinks('![a](a.png) [b](<b c.md>) `[not](x)` https://x.y/z.').map((l) => `${l.image ? '!' : ''}${l.href}`).join(' ') === '!a.png b c.md https://x.y/z', 'markdownLinks finds images, links and bare addresses, never inside code');
    check(videoPlayer('https://youtu.be/aqz-KE-bpKQ') === 'https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ' && videoPlayer('https://www.youtube.com/shorts/aqz-KE-bpKQ') === 'https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ'
      && videoPlayer('https://vimeo.com/76979871/abcdef1234') === 'https://player.vimeo.com/video/76979871?dnt=1&h=abcdef1234' && videoPlayer('https://www.youtube.com/watch?v=bad') === null && videoPlayer('https://example.com/watch?v=aqz-KE-bpKQ') === null,
      'YouTube (watch, youtu.be, shorts) and Vimeo (with an unlisted hash) become privacy players; nothing else does');
    const root = { kind: 'w' as const, name: 'yard', dir: yard, engine: { type: 'godot' as const, file: path.join(yard, 'game', 'project.godot') } };
    const at = (href: string) => resolveLink(root, path.join(yard, 'notes'), href);
    const rel = at('shot.png'), up = at('../sounds/kick.wav'), fromRoot = at('/sounds/kick.wav'), res = at('res://scenes/main.tscn'), out = at('../../outside/secret.txt'), gone = at('gone.png'), dot = at('../.cache/x.txt');
    check(rel.t === 'path' && rel.exists && rel.rel === 'notes/shot.png' && up.t === 'path' && up.rel === 'sounds/kick.wav' && fromRoot.t === 'path' && fromRoot.rel === 'sounds/kick.wav', 'a path resolves against the note\'s folder, "/" against the root');
    check(res.t === 'path' && res.exists && res.rel === 'game/scenes/main.tscn', 'res:// resolves against the Godot project');
    check(out.t === 'text' && gone.t === 'path' && !gone.exists && dot.t === 'text', 'outside the root or in plumbing: text, never looked up; missing: not there');
    check(at('file:///C:/x').t === 'text' && resolveLink({ ...root, engine: null }, tmp, 'res://x').t === 'text', 'other schemes stay text, and res:// with no Godot project');
    check(at('#Usage').t === 'anchor' && (at('02-later.md#Later') as any).hash === 'Later', 'a "#" link is a heading of the note; a note\'s path keeps the heading it names');
    check(renderMarkdown('---\ntitle: "A \\"card\\""\nlist: [a, b]\nempty:\n---\n\nText') === '<dl class="props"><div><dt>title</dt><dd>A &quot;card&quot;</dd></div><div><dt>list</dt><dd>a, b</dd></div></dl>\n<p>Text</p>'
      && renderMarkdown('---\nSome text\n---') === '<hr>\n<h2 id="some-text">Some text</h2>', 'front matter is the note\'s properties; a rule over text is not front matter');
    check(markdownLinks('---\nlink: "[x](gone.png)"\n---\n[y](y.png)').map((l) => l.href).join(' ') === 'y.png', 'the audit reads no links in front matter');
    check(linkText('a https://e.com/?a=1&b=2 b (https://e.com/x_(y)). c') === 'a <a href="https://e.com/?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">https://e.com/?a=1&amp;b=2</a> b (<a href="https://e.com/x_(y)" target="_blank" rel="noopener noreferrer">https://e.com/x_(y)</a>). c',
      'addresses in plain text are found before escaping: "&" stays in them, the sentence\'s punctuation does not');
    const alone = renderMarkdown('[a](x)\n\nsee [b](y) here', { link: (l, inner, at) => ({ inline: at.alone ? '' : `<a>${inner}</a>`, block: `<i>${l.href}</i>` }) });
    check(alone === '<div class="lblocks"><i>x</i></div>\n<p>see <a>b</a> here</p><div class="lblocks"><i>y</i></div>', `a link alone in its paragraph may stand as its block; in running text its block follows the paragraph (${alone})`);
    const img = (name: string, b: Buffer) => { const file = path.join(tmp, name); fs.writeFileSync(file, b); return imageSize(file); };
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xfe]), Buffer.alloc(0xfffc), Buffer.from([0xff, 0xe1, 0xff, 0xfe]), Buffer.alloc(0xfffc), Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20]), Buffer.alloc(16)]);
    const gif = Buffer.from('GIF89a\x40\x01\xf0\x00', 'latin1');
    const webp = Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBPVP8X', 'latin1'), Buffer.alloc(8), Buffer.from([0x3f, 0x01, 0x00, 0xef, 0x00, 0x00])]);
    check(JSON.stringify([img('a.jpg', jpeg), img('a.gif', gif), img('a.webp', webp), imageSize(path.resolve('library/props/thumbs/crate.png'))]) === '[{"w":800,"h":600},{"w":320,"h":240},{"w":320,"h":240},{"w":256,"h":256}]',
      'an image\'s size from its header (JPEG past a large EXIF block, GIF, WebP, PNG): a note\'s pictures keep their place while they load');
  }
  section('the package page and export-all agree on changed outputs');
  {
    const ws = path.join(tmp, 'output-freshness');
    write(path.join(ws, 'outputs.topows'), { libraries: [] });
    const graph = {
      vars: { x: 1, y: 2 },
      nodes: { a: { type: 'sphere', params: { radius: '=x' } }, b: { type: 'sphere', params: { radius: '=y' } } },
      output: 'a',
      outputs: {
        a: { node: 'a', export: { format: 'glb', path: 'a.glb' } },
        b: { node: 'b', export: { format: 'glb', path: 'b.glb' } },
      },
    };
    const p = createPackage({ name: 'outputs', path: ws }, 'kit', { title: 'Kit', graph });
    const graphFile = path.join(p.dir, 'graphs', 'main.json');
    const cli = (...args: string[]) => execFileSync(process.execPath, [path.resolve('src/cli.ts'), graphFile, ...args], { encoding: 'utf8' }).trim().split(/\r?\n/).at(-1);
    const first = cli('--export-all');
    check(first === '--export-all: 2 written, 0 unchanged, 0 failed', `export-all writes both published outputs (${first})`);
    const nodeFile = path.join(p.dir, 'exports', 'node.glb');
    cli('--node', 'b', '--export', nodeFile);

    const web = await startWeb({ config: { ...cfg, libraries: [], workspaces: [{ name: 'outputs', path: ws }] }, port: 0, bake: false, auditWait: 60_000 });
    try {
      const status = async (expected: string, message: string) => {
        const pkg = await reqAt(web.port, '/w/outputs/kit/');
        const list = await reqAt(web.port, '/w/outputs/kit/exports/');
        const badges = [...pkg.body.toString().matchAll(/>([\w]+)\.glb<\/a> <span class="stale"/g)].map((m) => m[1]).join(',');
        const audit = [...pkg.body.toString().matchAll(/class="fwhat">exports\/([\w]+)\.glb /g)].map((m) => m[1]).join(',');
        const files = [...list.body.toString().matchAll(/<span class="mname">([\w]+)\.glb<\/span>(?:(?!<\/button>)[\s\S])*?<span class="stale"/g)].map((m) => m[1]).join(',');
        check(pkg.status === 200 && list.status === 200 && badges === expected && audit === expected && files === expected,
          `${message} (package: ${badges || 'none'}, audit: ${audit || 'none'}, files: ${files || 'none'})`);
      };
      await status('', 'the exports are current when first written');

      graph.nodes.a.params.radius = '=x * 2';
      write(graphFile, graph);
      web.rescan();
      await status('a', 'changing a node only output a reads marks only a');

      graph.nodes.a.params.radius = '=x';
      graph.vars.x = 3;
      write(graphFile, graph);
      web.rescan();
      await status('a', 'changing x marks only output a');
      const a = cli('--export-all');
      check(a === '--export-all: 1 written, 1 unchanged, 0 failed', `export-all rewrites only the changed output (${a})`);

      graph.vars.y = 4;
      write(graphFile, graph);
      web.rescan();
      await status('b,node', 'changing y marks output b and the direct export of its node');
      cli('--export-all');
      web.rescan();
      await status('node', 'export-all clears both published outputs');
      cli('--node', 'b', '--export', nodeFile);
      web.rescan();
      await status('', 'exporting the node again clears its mark');

      // an export made by other TopoTopo code says so, not that its graph changed
      const record = path.join(p.dir, 'exports', 'a.glb.source.json'), made = JSON.parse(fs.readFileSync(record, 'utf8'));
      made.source.engine_sha256 = '0'.repeat(64);
      fs.writeFileSync(record, JSON.stringify(made, null, 2));
      web.rescan();
      await status('a', 'an export made by other TopoTopo code is marked');
      const page = (await reqAt(web.port, '/w/outputs/kit/')).body.toString();
      check(/>a\.glb<\/a> <span class="stale"[^>]*>made by an earlier TopoTopo</.test(page) && /exports\/a\.glb was made by an earlier TopoTopo/.test(page) && !/older than its graph/.test(page),
        'and its mark and flag say an earlier TopoTopo made it');
    } finally { web.close(); }
  }
} catch (e: any) {
  check(false, `the run stopped: ${e?.cause?.code ?? e?.code ?? ''} ${e?.message ?? e}`.trim());
} finally {
  g.close();
  f?.close();
}

console.log(`\n${passes} passed, ${failures} failed — temp ${tmp}`);
process.exit(failures ? 1 : 0);
