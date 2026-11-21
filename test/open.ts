// `topotopo open` (src/host/open.ts): the command a double-clicked package or workspace runs.
//   node test/open.ts
// It starts the web app (a real server, detached) for each scenario that needs one, in a temporary TopoTopo folder with
// a temporary config, on ports chosen at run time, and records the address that would open in the browser instead of
// opening one. It ends only processes it started itself: the web apps `open` starts in this process (open tells it their
// pids), its own helper processes, and, for web apps the command line started, through `open --stop` in its own temporary
// folder (which stops only a process its web app's health confirms). Nothing is ever stopped because a lock file names it.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { ROOT } from './fixtures.ts';
import { initPackage } from '../src/package.ts';
import { initWorkspace } from '../src/workspace.ts';
import { engineSha256 } from '../src/host/engine-code.ts';
import { TOPOTOPO_VERSION } from '../src/host/version.ts';
import { lockFile, openCommand, probe, resolveTarget } from '../src/host/open.ts';
import type { OpenOptions } from '../src/host/open.ts';

let fail = 0, pass = 0;
const check = (ok: unknown, msg: string) => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
};

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'topotopo-open-')));
const CLI = path.join(ROOT, 'src', 'cli.ts');
const freePort = () => new Promise<number>((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The processes this test started itself (web apps open started here, helper processes): the only ones it ever ends. */
const own = new Set<number>();
const killOwn = (pid: number) => {
  if (!own.delete(pid)) return; // never a pid this test did not start
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else { try { process.kill(pid); } catch { /* gone */ } }
};
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitGone = async (pid: number) => { for (let i = 0; i < 100 && alive(pid); i++) await sleep(100); };
/** a process that does nothing until it is ended */
const sleeper = () => { const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); own.add(c.pid!); return c.pid!; };
const lockOf = (home: string) => { try { return JSON.parse(fs.readFileSync(lockFile(home), 'utf8')) as { port: number; pid: number }; } catch { return null; } };

const get = async (url: string) => {
  try { const r = await fetch(url, { headers: { connection: 'close' }, signal: AbortSignal.timeout(20_000) }); return { status: r.status, text: await r.text() }; }
  catch (e: any) { throw new Error(`GET ${url}: ${e?.cause?.code ?? e?.message}`); }
};
/** a request path sent as it is (fetch tidies ../ away) */
const raw = (port: number, p: string) => new Promise<number>((resolve, reject) => {
  const q = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers: { connection: 'close' } }, (r) => { r.resume(); resolve(r.statusCode ?? 0); });
  q.on('error', reject); q.end();
});

/** A stand-in web app: answers /api/health, but not before `delay` ms after it was made (a busy one), and /api/open with a fixed address. */
const fake = async (health: object, delay = 0) => {
  const port = await freePort();
  const readyAt = Date.now() + delay;
  const server = http.createServer((req, res) => {
    const answer = () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(req.url === '/api/health' ? JSON.stringify(health) : JSON.stringify({ url: '/fake/' })); };
    req.resume();
    if (req.url === '/api/health') setTimeout(answer, Math.max(0, readyAt - Date.now())); else answer();
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  return { port, close: () => server.close() };
};

let home = '';
const spawnedPids: number[] = [];
const urls: string[] = [];
let callOptions: Partial<OpenOptions> = {};
const opened = async (...argv: string[]) => {
  const out: string[] = [], err: string[] = [];
  const code = await openCommand(argv, 'topotopo', { out: (s) => out.push(s), err: (s) => err.push(s) }, { browser: async (u) => { urls.push(u); }, spawned: (pid) => { spawnedPids.push(pid); own.add(pid); }, ...callOptions });
  return { code, out, err, url: urls.at(-1) };
};
/** the same with options for this call only (a shorter deadline, a shorter wait for a web app that does not answer) */
const openedWith = async (options: Partial<OpenOptions>, ...argv: string[]) => { callOptions = options; try { return await opened(...argv); } finally { callOptions = {}; } };
/** a POST as it is sent: its status */
const post = (port: number, p: string, headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
  const q = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { connection: 'close', ...headers } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
  q.on('error', reject); q.end('{}');
});
const connects = (port: number) => new Promise<boolean>((resolve) => { const c = net.connect(port, '127.0.0.1'); c.once('connect', () => { c.destroy(); resolve(true); }); c.once('error', () => resolve(false)); });
const hereHealth = (pid: number) => ({ web: true, pid, version: TOPOTOPO_VERSION, engine: engineSha256(), open: true });

try {
  home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  const cfgFile = path.join(home, 'config.json');
  const cfgWs = path.join(tmp, 'cfgws', 'file-name');
  fs.mkdirSync(cfgWs, { recursive: true });
  fs.writeFileSync(path.join(cfgWs, 'file-name.topows'), JSON.stringify({ engine: 'none' }));
  const cfgText = JSON.stringify({ web: { port: await freePort() }, libraries: [{ name: 'shared', path: path.join(tmp, 'shared') }], workspaces: [{ name: 'cfg-name', path: cfgWs }] });
  fs.writeFileSync(cfgFile, cfgText);
  process.env.TOPOTOPO_HOME = home;
  process.env.TOPOTOPO_CONFIG = cfgFile;
  delete process.env.TOPOTOPO_BROWSER_LOG;

  const mkPkg = (...parts: string[]) => { const d = path.join(tmp, ...parts); fs.mkdirSync(d, { recursive: true }); initPackage(d); return d; };
  const shared = mkPkg('shared', 'rock');
  const loose = mkPkg('loose', 'demo-kit');
  const ws = path.join(tmp, 'games', 'my-world');
  fs.mkdirSync(path.join(ws, 'props', 'crate'), { recursive: true });
  initWorkspace(ws, { engine: 'none' });
  initPackage(path.join(ws, 'props', 'crate'));

  // ---- the path given
  check(resolveTarget(undefined).kind === 'home' && resolveTarget(path.join(shared, 'rock.topo')).kind === 'package' && resolveTarget(shared).kind === 'package'
    && resolveTarget(path.join(ws, 'my-world.topows')).kind === 'workspace' && resolveTarget(ws).kind === 'workspace', 'a package or workspace file, or the folder that holds one, is what is opened; no path is the home page');
  const missing = await opened(path.join(tmp, 'nowhere', 'gone.topo'));
  check(missing.code === 1 && missing.err.length === 1 && /nowhere.gone\.topo does not exist$/.test(missing.err[0]) && !urls.length && !lockOf(home), `a path that does not exist fails with one sentence, opens nothing and starts nothing (${missing.err[0]})`);
  const other = await opened(path.join(ws, 'props'));
  check(other.code === 1 && other.err.length === 1 && /holds no \.topo or \.topows file$/.test(other.err[0]) && !urls.length && !lockOf(home), `a folder that holds neither says so (${other.err[0]})`);
  fs.writeFileSync(path.join(tmp, 'notes.txt'), 'x');
  const text = await opened(path.join(tmp, 'notes.txt'));
  check(text.code === 1 && /is neither a package \(\.topo\) nor a workspace \(\.topows\) file$/.test(text.err[0] ?? '') && !urls.length, `a file of another kind says so (${text.err[0]})`);
  const oldWs = path.join(tmp, 'old-ws');
  fs.mkdirSync(oldWs);
  fs.writeFileSync(path.join(oldWs, 'topotopo-workspace.json'), JSON.stringify({ name: 'old-ws' }));
  const oldSaid = await opened(oldWs);
  check(oldSaid.code === 1 && /rename it to old-ws\.topows/.test(oldSaid.err[0] ?? '') && !urls.length && !lockOf(home), `a folder with the old workspace file name is told the new name (${oldSaid.err[0]})`);
  const both = path.join(tmp, 'both');
  fs.mkdirSync(both);
  fs.writeFileSync(path.join(both, 'a.topo'), '{}'); fs.writeFileSync(path.join(both, 'b.topows'), '{}');
  const bothSaid = await opened(both);
  check(bothSaid.code === 1 && /holds both a\.topo and b\.topows: open the file you mean$/.test(bothSaid.err[0] ?? ''), `a folder holding a package file and a workspace file asks which (${bothSaid.err[0]})`);

  // ---- start: no web app runs, so one starts, and the package's page answers
  const t0 = Date.now();
  const first = await opened(path.join(loose, 'demo-kit.topo'));
  const lock1 = lockOf(home);
  check(first.code === 0 && !!lock1 && spawnedPids.length === 1 && lock1.pid === spawnedPids[0] && alive(lock1.pid) && first.url === `http://127.0.0.1:${lock1.port}/l/demo-kit/`, `start: no web app runs, so one starts and its lock names its port and pid (${first.url}, ${Date.now() - t0} ms)`);
  const page = first.url ? await get(first.url) : { status: 0, text: '' };
  check(page.status === 200 && /demo-kit/.test(page.text), `the package's page answers 200 (${page.status})`);
  check(lock1 && lock1.port === JSON.parse(cfgText).web.port && fs.existsSync(path.join(home, 'web.log')), 'the web app took the config\'s port (it was free) and wrote its output to web.log in the TopoTopo folder');
  check(fs.readFileSync(cfgFile, 'utf8') === cfgText, 'the config is as it was: the package was listed for the run only');
  const health = await probe(lock1!.port, 5000);
  check(health.state === 'live' && health.health.pid === lock1!.pid && health.health.version === TOPOTOPO_VERSION && health.health.engine === engineSha256() && health.health.open === true, '/api/health says the pid, the version and the engine code hash of the web app');
  const base = `http://127.0.0.1:${lock1!.port}`;
  const ownPackages = async () => (JSON.parse((await get(`${base}/api/packages`)).text).packages as { lib: string; id: string }[]).filter((p) => p.lib !== 'topotopo').map((p) => `${p.lib}/${p.id}`).sort();

  // ---- a package opened by itself: nothing around it is listed, baked or served
  const sib = path.join(tmp, 'siblings');
  const alpha = mkPkg('siblings', 'alpha'), beta = mkPkg('siblings', 'beta');
  fs.writeFileSync(path.join(sib, 'secret.txt'), 'not for the web app');
  const a = await opened(path.join(alpha, 'alpha.topo'));
  check(a.code === 0 && a.url === `${base}/l/alpha/` && (await get(a.url!)).status === 200, `a package in no workspace or library is listed as itself (${a.url})`);
  let baked = false;
  for (let i = 0; i < 300 && !baked; i++) { baked = fs.existsSync(path.join(alpha, '.web', 'bake.json')); if (!baked) await sleep(250); }
  const listedNow = await ownPackages();
  check(baked && listedNow.includes('alpha/alpha') && !listedNow.some((p) => /beta/.test(p)), `the opened package is listed and baked, its sibling is not listed (${listedNow.join(', ')})`);
  check(!fs.existsSync(path.join(beta, '.web')) && !fs.existsSync(path.join(sib, '.web')), 'the sibling package is not baked: nothing was written into it or into the folder around');
  const reach = ['/l/alpha/..%2Fbeta%2Fbeta.topo', '/l/alpha/../beta/beta.topo', '/l/alpha/../secret.txt', '/p/alpha/beta', '/p/beta/beta', '/l/beta/', '/l/siblings/', '/l/alpha/..%2Fsecret.txt'];
  const reached = await Promise.all(reach.map(async (p) => [p, await raw(lock1!.port, p)] as const));
  check(reached.every(([, s]) => s !== 200), `the sibling, its files and the folder around are not served (${reached.map(([, s]) => s).join(' ')})`);
  check(!(await get(`${base}/l/alpha/`)).text.includes('beta') && !(await get(`${base}/`)).text.includes('beta'), 'the opened package\'s page and the home page do not name its sibling');

  // ---- reuse: a second open starts no second web app
  const second = await opened(path.join(ws, 'my-world.topows'));
  check(second.code === 0 && lockOf(home)?.pid === lock1!.pid && spawnedPids.length === 1 && second.url === `${base}/w/my-world/`, `reuse: the second open uses the same web app, and none was started (${second.url})`);
  const wsPage = second.url ? await get(second.url) : { status: 0, text: '' };
  check(wsPage.status === 200 && /my-world/.test(wsPage.text) && (await ownPackages()).includes('my-world/crate'), `the workspace's page answers 200 and the web app lists its package (${wsPage.status})`);
  const fromFolder = await opened(ws), pkgFolder = await opened(shared), fileAgain = await opened(path.join(loose, 'demo-kit.topo'));
  check(fromFolder.url === second.url && fileAgain.url === first.url, 'a folder opens the workspace it holds like its file, and the same package again gives the same page');
  const rock = pkgFolder.url ? await get(pkgFolder.url) : { status: 0, text: '' };
  check(pkgFolder.url === `${base}/l/shared/rock/` && rock.status === 200 && fs.readFileSync(cfgFile, 'utf8') === cfgText, `a folder holding a package opens it, in the library the config lists (${pkgFolder.url})`);
  const inWorld = await opened(path.join(ws, 'props', 'crate'));
  check(inWorld.code === 0 && inWorld.url === `${base}/w/my-world/props/crate/` && (await get(inWorld.url!)).status === 200, `a package in an opened workspace opens in the workspace (${inWorld.url})`);
  const home1 = await opened();
  check(home1.code === 0 && home1.url === `${base}/` && (await get(home1.url)).status === 200 && lockOf(home)?.pid === lock1!.pid, 'no path opens the home page');

  // ---- a package made after its workspace was listed: found at once, without waiting for the watch
  const fresh = path.join(ws, 'props', 'fresh');
  fs.mkdirSync(fresh);
  initPackage(fresh);
  const freshOpen = await opened(path.join(fresh, 'fresh.topo'));
  check(freshOpen.code === 0 && freshOpen.url === `${base}/w/my-world/props/fresh/` && (await get(freshOpen.url!)).status === 200, `a package made a moment ago is found in its listed workspace (${freshOpen.url ?? freshOpen.err[0]})`);

  // ---- the same workspace name twice: the second is listed under another name for this run
  const ws2 = path.join(tmp, 'games-copy', 'my-world');
  fs.mkdirSync(path.join(ws2, 'props', 'crate'), { recursive: true });
  initWorkspace(ws2, { engine: 'none' });
  initPackage(path.join(ws2, 'props', 'crate'));
  const clash = await opened(path.join(ws2, 'my-world.topows'));
  const clashAgain = await opened(ws2);
  const afterClash = await ownPackages();
  check(clash.code === 0 && clash.url === `${base}/w/my-world-2/` && clashAgain.url === clash.url && (await get(clash.url!)).status === 200 && afterClash.includes('my-world-2/crate') && afterClash.includes('my-world/crate'),
    `a workspace whose name is taken is listed under another name for this run, once (${clash.url ?? clash.err[0]}; ${clashAgain.url}; ${afterClash.join(', ')})`);

  // ---- a copy the workspace uses: no page, nothing listed
  const copy = path.join(ws, 'topotopo-packages', 'studio', 'rocks', '1.0');
  fs.mkdirSync(copy, { recursive: true });
  fs.writeFileSync(path.join(copy, 'rocks.topo'), '{}');
  const before = await ownPackages();
  const copied = await opened(path.join(copy, 'rocks.topo'));
  check(copied.code === 1 && copied.err.length === 1 && /is a copy of studio\/rocks that the workspace "my-world" uses \(its topotopo-packages folder\)/.test(copied.err[0])
    && JSON.stringify(await ownPackages()) === JSON.stringify(before) && (await get(`${base}/l/rocks/`)).status === 404, `a copy in a workspace's topotopo-packages folder fails with one sentence and lists nothing (${copied.err[0]})`);

  // ---- paths with spaces and letters beyond ASCII
  const spaced = mkPkg('Mano projektai ąčę', 'demo pakuotė', 'kit-one');
  const wsSpaced = path.join(tmp, 'Pasaulis ąž ūė', 'world-two');
  fs.mkdirSync(path.join(wsSpaced, 'objektai'), { recursive: true });
  initWorkspace(wsSpaced, { engine: 'none' });
  const spacedOpen = await opened(path.join(spaced, 'kit-one.topo')), wsSpacedOpen = await opened(wsSpaced);
  check(spacedOpen.code === 0 && (await get(spacedOpen.url!)).status === 200 && wsSpacedOpen.code === 0 && (await get(wsSpacedOpen.url!)).status === 200,
    `paths with spaces and non-ASCII letters open (${spacedOpen.url}, ${wsSpacedOpen.url})`);

  // ---- a name some listed workspace has in its pages (its file's, not its config name) is taken
  const clashPkg = mkPkg('namesake', 'file-name');
  const namesake = await opened(path.join(clashPkg, 'file-name.topo'));
  check(namesake.code === 0 && namesake.url === `${base}/l/file-name-2/` && (await get(namesake.url!)).status === 200 && (await get(`${base}/w/file-name/`)).status === 200 && !(await get(`${base}/w/file-name/`)).text.includes('namesake'),
    `a package opened by itself does not take the name a listed workspace shows under (${namesake.url ?? namesake.err[0]})`);

  // ---- a root that goes away while the web app runs: dropped, the web app stays up
  const bakedIn = async (d: string) => { for (let i = 0; i < 240 && !fs.existsSync(path.join(d, '.web', 'bake.json')); i++) await sleep(250); };
  const up = async () => { const h = await probe(lock1!.port, 5000); return h.state === 'live' && h.health.pid === lock1!.pid && alive(lock1!.pid); };
  const gone3 = ['gone-a', 'gone-b', 'gone-c'].map((id) => mkPkg('vanish', id));
  for (const d of gone3) { const o = await opened(path.join(d, `${path.basename(d)}.topo`)); check(o.code === 0 && (await get(o.url!)).status === 200, `${path.basename(d)} is listed by itself`); }
  const wsGone = ['ws-ren', 'ws-del'].map((n) => {
    const d = path.join(tmp, 'vanishws', n);
    fs.mkdirSync(path.join(d, 'inner'), { recursive: true });
    initWorkspace(d, { engine: 'none' });
    initPackage(path.join(d, 'inner'));
    return d;
  });
  for (const d of wsGone) { const o = await opened(d); check(o.code === 0 && (await get(o.url!)).status === 200, `${path.basename(d)} is listed for the run`); }
  for (const d of [...gone3, ...wsGone.map((w) => path.join(w, 'inner'))]) await bakedIn(d);
  const tGone = Date.now();
  fs.renameSync(gone3[0], `${gone3[0]}-renamed`);
  fs.mkdirSync(path.join(tmp, 'vanish-moved'));
  fs.renameSync(gone3[1], path.join(tmp, 'vanish-moved', 'gone-b'));
  fs.rmSync(gone3[2], { recursive: true, force: true });
  fs.renameSync(wsGone[0], `${wsGone[0]}-renamed`);
  fs.rmSync(wsGone[1], { recursive: true, force: true });
  let listedAfter: string[] = [];
  for (let i = 0; i < 80; i++) { await sleep(250); listedAfter = await ownPackages(); if (!listedAfter.some((p) => /gone-|ws-ren|ws-del/.test(p))) break; }
  const goneMs = Date.now() - tGone;
  check(goneMs < 10_000, `the web app noticed the roots that went away when it happened, not at its next periodic rescan (${goneMs} ms)`);
  check(await up() &&!listedAfter.some((p) => /gone-/.test(p)) && !listedAfter.some((p) => /^ws-(ren|del)\//.test(p)), `a lone package renamed, moved or deleted, and a workspace opened for the run renamed or deleted: dropped, the web app stays up (${listedAfter.join(', ')})`);
  const pagesGone = await Promise.all(['/l/gone-a/', '/l/gone-b/', '/l/gone-c/', '/w/ws-ren/', '/w/ws-del/'].map((x) => get(`${base}${x}`).then((g) => g.status)));
  check(pagesGone.every((c) => c === 404) && (await get(`${base}/`)).status === 200, `their pages say they are not there (${pagesGone.join(' ')}), the home page answers`);
  const weblog = fs.readFileSync(path.join(home, 'web.log'), 'utf8');
  check(/is gone: no longer listed/.test(weblog) && !/Error|ENOENT|at .*\.ts/.test(weblog), 'web.log says so in a line and holds no error');

  // ---- TopoTopo changed since the web app started: it is used all the same, and its pages say so, with a button that stops it
  const quiet = (await get(`${base}/`)).text;
  check(!quiet.includes('has changed since this server started'), 'no line at the top while the version and engine code of open are the web app\'s');
  const forged = await fetch(`${base}/api/open`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-topotopo-open': '1', connection: 'close' }, body: JSON.stringify({ kind: 'workspace', dir: ws, version: TOPOTOPO_VERSION, engine: 'another engine' }) });
  const loud = (await get(`${base}/`)).text, loudFolder = (await get(`${base}/w/my-world/`)).text;
  check(forged.status === 200 && [loud, loudFolder].every((t) => t.includes('TopoTopo has changed since this server started.') && t.includes('data-stop-topotopo') && t.includes('then open your file again')) && alive(lock1!.pid), 'a web app asked by another engine code says so at the top of the front page and a folder page, and runs on');
  check(await post(lock1!.port, '/api/stop', {}) === 403 && await post(lock1!.port, '/api/stop', { 'x-topotopo-open': '1', origin: 'http://evil.example' }) === 403 && await post(lock1!.port, '/api/open', {}) === 403 && alive(lock1!.pid), '/api/stop and /api/open are refused without the header, and from another origin');

  // ---- a web app that is stopping is no web app to open a file in: the person presses Stop TopoTopo during a bake and opens
  // their file again at once. Its health says it is stopping, /api/open refuses, and open waits for it to leave and starts another
  const home2 = path.join(tmp, 'home-two');
  fs.mkdirSync(home2);
  const heavy = mkPkg('heavy', 'heavy-kit');
  fs.writeFileSync(path.join(heavy, 'graphs', 'main.json'), JSON.stringify({ nodes: { g: { type: 'grid', params: { size: [10, 10], divisions: [1800, 1800] } }, m: { type: 'mountain', in: ['g'] } }, output: 'm' }));
  const homeOne = process.env.TOPOTOPO_HOME;
  process.env.TOPOTOPO_HOME = home2; // the web app it starts takes the TopoTopo folder from the environment
  try {
    const heavyOpen = await openedWith({ home: home2 }, path.join(heavy, 'heavy-kit.topo'));
    const lockA = lockOf(home2);
    check(heavyOpen.code === 0 && !!lockA && lockA.pid !== lock1!.pid, `a second web app is started in its own folder, and its bake of a heavy package begins (${heavyOpen.url})`);
    const asked = await post(lockA!.port, '/api/stop', { 'x-topotopo-open': '1' });
    const stoppingNow = await probe(lockA!.port, 3000);
    const refusedOpen = await post(lockA!.port, '/api/open', { 'x-topotopo-open': '1' });
    check(asked === 200 && stoppingNow.state === 'stopping' && stoppingNow.health.pid === lockA!.pid && refusedOpen === 503 && alive(lockA!.pid),
      `after /api/stop the web app says it is stopping while its bake finishes, and /api/open is refused (${asked}, ${stoppingNow.state}, ${refusedOpen})`);
    const tStop = Date.now(), spawnedBefore = spawnedPids.length;
    const reopened = await openedWith({ home: home2 }, path.join(loose, 'demo-kit.topo'));
    const lockB = lockOf(home2);
    check(reopened.code === 0 && !!lockB && lockB.pid !== lockA!.pid && !alive(lockA!.pid) && spawnedPids.length === spawnedBefore + 1 && lockB.pid === spawnedPids.at(-1) && (await get(reopened.url!)).status === 200,
      `an open in those seconds waits for the web app to leave and starts a fresh one, whose page answers (${Date.now() - tStop} ms, ${reopened.url ?? reopened.err[0]})`);
    own.delete(lockA!.pid);
    if (lockB) { killOwn(lockB.pid); await waitGone(lockB.pid); }
    fs.rmSync(lockFile(home2), { force: true });
  } finally { process.env.TOPOTOPO_HOME = homeOne; }

  // ---- a stop lets a bake finish and ends an editor the way it ends itself
  // (the earlier bakes are done first: the bake of the package below then starts at once, so the stop finds it running)
  for (let i = 0; i < 400; i++) { const h = await probe(lock1!.port, 5000); if (h.state === 'live' && !(h.health as any).baking) break; await sleep(100); }
  const stopBake = mkPkg('stoppers', 'stop-bake'), stopBake2 = mkPkg('stoppers', 'stop-bake-two');
  await opened(path.join(stopBake, 'stop-bake.topo'));
  const edit = await fetch(`${base}/p/stop-bake/stop-bake/edit`, { redirect: 'manual', headers: { connection: 'close' }, signal: AbortSignal.timeout(60_000) });
  const editorUrl = edit.headers.get('location') ?? '';
  const editorPort = editorUrl ? Number(new URL(editorUrl).port) : 0;
  check(edit.status === 302 && editorPort > 0 && await connects(editorPort), `the editor of the opened package runs (${editorUrl})`);
  await opened(path.join(stopBake2, 'stop-bake-two.topo'));

  // ---- --stop ends the web app this call started, and only it
  const stopped = await opened('--stop');
  const gone = await probe(lock1!.port, 3000);
  check(stopped.code === 0 && /^stopped the web app \(process \d+, port \d+\)$/.test(stopped.out[0] ?? '') && !alive(lock1!.pid) && !lockOf(home) && gone.state === 'closed', `open --stop: stops the web app, removes the lock, the port is closed (${stopped.out[0]})`);
  own.delete(lock1!.pid);
  const states = [stopBake, stopBake2].map((d) => { try { return JSON.parse(fs.readFileSync(path.join(d, '.web', 'bake.json'), 'utf8')); } catch { return null; } });
  check(states.every((x) => x === null || x.ok === true) && states[0]?.ok === true && !(await connects(editorPort)), `the stop let the bake that was running finish (no bake cut short: ${states.map((x) => (x ? (x.ok ? 'ok' : x.error) : 'not started')).join(', ')}) and the editor is gone (port ${editorPort} closed)`);
  const none = await opened('--stop');
  check(none.code === 0 && /^no web app of yours is running$/.test(none.out[0] ?? ''), 'open --stop with none running says so and succeeds');
  const bystander = sleeper();
  const liar = await fake({ web: true, pid: bystander + 1_000_000, version: TOPOTOPO_VERSION, engine: engineSha256(), open: true });
  fs.writeFileSync(lockFile(home), JSON.stringify({ port: liar.port, pid: bystander }));
  const refused = await opened('--stop');
  check(refused.code === 0 && alive(bystander) && !lockOf(home) && /nothing was ended/.test(refused.out[0] ?? ''), 'open --stop does not end a process whose web app health does not confirm the lock\'s pid');
  liar.close();
  // a lock whose process lives but whose port does not answer at all: --stop removes it and ends nothing; open starts normally
  const silent = net.createServer((c) => { c.on('error', () => {}); });
  const silentPort = await freePort();
  await new Promise<void>((r2) => silent.listen(silentPort, '127.0.0.1', r2));
  fs.writeFileSync(lockFile(home), JSON.stringify({ port: silentPort, pid: bystander }));
  const unconfirmed = await openedWith({ busyMs: 1500 }, '--stop');
  check(unconfirmed.code === 0 && /nothing was ended/.test(unconfirmed.out[0] ?? '') && alive(bystander) && !lockOf(home), 'open --stop with a lock whose process lives and whose port never answers: the lock is removed, nothing is ended');
  fs.writeFileSync(lockFile(home), JSON.stringify({ port: silentPort, pid: bystander }));
  const beforeUnconfirmed = spawnedPids.length;
  const startedAnyway = await openedWith({ busyMs: 1500 }, path.join(loose, 'demo-kit.topo'));
  check(startedAnyway.code === 0 && spawnedPids.length === beforeUnconfirmed + 1 && alive(bystander) && lockOf(home)?.pid === spawnedPids.at(-1) && (await get(startedAnyway.url!)).status === 200, 'open with such a lock starts a web app as usual instead of failing, and ends nothing');
  killOwn(spawnedPids.at(-1)!); await waitGone(spawnedPids.at(-1)!);
  // the same with the real timings: a port that accepts connections and never answers HTTP is judged once, after about 15 s,
  // and the web app is then started inside the 75 s of open (it used to wait 40 s, then the 35 s left, then have no time to start)
  fs.writeFileSync(lockFile(home), JSON.stringify({ port: silentPort, pid: bystander }));
  const beforeReal = spawnedPids.length, tReal = Date.now();
  const realTimings = await opened(path.join(loose, 'demo-kit.topo'));
  const realMs = Date.now() - tReal;
  check(realTimings.code === 0 && realMs >= 12_000 && realMs < 45_000 && spawnedPids.length === beforeReal + 1 && lockOf(home)?.pid === spawnedPids.at(-1) && alive(bystander) && (await get(realTimings.url!)).status === 200,
    `a lock whose process lives and whose port never answers, with the real timings: judged once after about 15 s, then a web app starts, inside the 75 s (${realMs} ms, ${realTimings.url ?? realTimings.err[0]})`);
  killOwn(spawnedPids.at(-1)!); await waitGone(spawnedPids.at(-1)!);
  silent.close(); killOwn(bystander);

  // ---- stale lock: a process that ended
  const gonePid = await new Promise<number>((resolve) => { const g = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' }); g.once('exit', () => resolve(g.pid!)); });
  fs.writeFileSync(lockFile(home), JSON.stringify({ port: lock1!.port, pid: gonePid }) + '\n');
  const before3 = spawnedPids.length;
  const afterDead = await opened(path.join(loose, 'demo-kit.topo'));
  const lock3 = lockOf(home);
  check(afterDead.code === 0 && !!lock3 && lock3.pid !== gonePid && spawnedPids.length === before3 + 1 && lock3.pid === spawnedPids.at(-1) && (await get(afterDead.url!)).status === 200, `stale lock (its process has ended): replaced by a new web app (pid ${lock3?.pid})`);
  killOwn(lock3!.pid); await waitGone(lock3!.pid);

  // ---- stale lock: the port answers, but not as TopoTopo's web app (and the process in the lock lives: this one)
  const dummy = await fake({ hello: 'not topotopo' });
  fs.writeFileSync(lockFile(home), JSON.stringify({ port: dummy.port, pid: process.pid }) + '\n');
  const afterOther = await opened(path.join(shared, 'rock.topo'));
  const lock4 = lockOf(home);
  check(afterOther.code === 0 && !!lock4 && lock4.port !== dummy.port && lock4.pid === spawnedPids.at(-1) && alive(process.pid) && (await get(afterOther.url!)).status === 200 && (await get(`http://127.0.0.1:${dummy.port}/`)).status === 200,
    `stale lock (its port is answered by something else): replaced, and that other program is left alone (port ${dummy.port} still answers)`);
  dummy.close(); killOwn(lock4!.pid); await waitGone(lock4!.pid);

  // ---- a busy web app is waited for, never replaced: it answers its health check only 8 s after it was made
  const busy = await fake(hereHealth(process.pid), 8000);
  fs.writeFileSync(lockFile(home), JSON.stringify({ port: busy.port, pid: process.pid }) + '\n');
  const before5 = spawnedPids.length, tb = Date.now();
  const busyOpen = await opened(path.join(loose, 'demo-kit.topo'));
  check(busyOpen.code === 0 && busyOpen.url === `http://127.0.0.1:${busy.port}/fake/` && spawnedPids.length === before5 && JSON.stringify(lockOf(home)) === JSON.stringify({ port: busy.port, pid: process.pid }) && Date.now() - tb >= 6000,
    `a web app that answers its health check after 8 s is waited for: no other is started and its lock stays (${Date.now() - tb} ms, ${busyOpen.url ?? busyOpen.err[0]})`);
  busy.close();

  // ---- a web app of another version or engine code is used as it is, and not ended
  const other1 = sleeper();
  const otherApp = await fake({ web: true, pid: other1, version: TOPOTOPO_VERSION, engine: 'another engine', open: true });
  fs.writeFileSync(lockFile(home), JSON.stringify({ port: otherApp.port, pid: other1 }) + '\n');
  const before6 = spawnedPids.length;
  const usedAsIs = await opened(path.join(loose, 'demo-kit.topo'));
  check(usedAsIs.code === 0 && usedAsIs.url === `http://127.0.0.1:${otherApp.port}/fake/` && alive(other1) && spawnedPids.length === before6 && lockOf(home)?.pid === other1, 'a running web app with another engine code is used, not ended, and no other is started');
  const noOpen = await fake({ web: true, pid: other1, version: '0.0.1', engine: engineSha256() });
  otherApp.close();
  fs.writeFileSync(lockFile(home), JSON.stringify({ port: noOpen.port, pid: other1 }) + '\n');
  const used2 = await opened(path.join(loose, 'demo-kit.topo'));
  check(used2.code === 0 && alive(other1) && spawnedPids.length === before6, 'nor is one of another version');
  noOpen.close(); killOwn(other1);
  fs.rmSync(lockFile(home), { force: true });

  // ---- one deadline for every wait: a web app that stays busy past it fails with one sentence
  const slow = await fake(hereHealth(process.pid), 20_000);
  fs.writeFileSync(lockFile(home), JSON.stringify({ port: slow.port, pid: process.pid }) + '\n');
  const tl = Date.now();
  const late = await openedWith({ timeoutMs: 3000 }, path.join(loose, 'demo-kit.topo'));
  check(late.code === 1 && late.err.length === 1 && /^gave up after 3 seconds waiting for /.test(late.err[0]) && Date.now() - tl < 8000 && spawnedPids.length === before6, `every wait shares one deadline: past it, one sentence (${late.err[0]}, ${Date.now() - tl} ms)`);
  slow.close();
  fs.rmSync(lockFile(home), { force: true });

  // ---- two open at the same moment (two processes, as two double-clicks): one web app
  const log = path.join(tmp, 'browser.log');
  const runAsync = (args: string[]) => new Promise<{ status: number | null; stderr: string }>((resolve) => {
    const c = spawn(process.execPath, [CLI, 'open', ...args], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, TOPOTOPO_BROWSER_LOG: log } });
    let stderr = ''; c.stderr!.on('data', (d) => { stderr += d; });
    const t = setTimeout(() => c.kill(), 120_000);
    c.once('exit', (status) => { clearTimeout(t); resolve({ status, stderr }); });
  });
  const pair = await Promise.all([runAsync([path.join(alpha, 'alpha.topo')]), runAsync([path.join(ws, 'my-world.topows')])]);
  const seen = fs.readFileSync(log, 'utf8').trim().split(/\r?\n/);
  const origins = new Set(seen.map((u) => new URL(u).origin));
  const lock7 = lockOf(home);
  check(pair.every((r) => r.status === 0 && r.stderr === '') && seen.length === 2 && origins.size === 1 && !!lock7 && origins.has(`http://127.0.0.1:${lock7.port}`) && (await Promise.all(seen.map((u) => get(u)))).every((r) => r.status === 200),
    `two opens at the same moment end with one web app (${[...origins].join(' ')}, exit ${pair.map((r) => r.status).join('/')})`);

  // ---- the command as a person runs it: the default opener is replaced by a file, and the exit code is the command's
  fs.rmSync(log, { force: true });
  const run = (args: string[]) => spawnSync(process.execPath, [CLI, 'open', ...args], { encoding: 'utf8', timeout: 90_000, env: { ...process.env, TOPOTOPO_BROWSER_LOG: log } });
  const cliMissing = run([path.join(tmp, 'nothing.topo')]);
  check(cliMissing.status === 1 && cliMissing.stdout === '' && /^.*nothing\.topo does not exist\n$/.test(cliMissing.stderr), `the CLI: a missing path exits 1 with one sentence on stderr (${cliMissing.stderr.trim()})`);
  const cliOk = run([path.join(spaced, 'kit-one.topo')]);
  const recorded = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim() : '';
  check(cliOk.status === 0 && recorded === `http://127.0.0.1:${lock7!.port}/l/kit-one/` && (await get(recorded)).status === 200 && cliOk.stderr === '', `the CLI: opens a package in a folder with spaces and non-ASCII letters (exit ${cliOk.status}, address recorded: ${recorded})`);
  const cliWs = run([wsSpaced]);
  const recorded2 = fs.readFileSync(log, 'utf8').trim().split(/\r?\n/);
  check(cliWs.status === 0 && lockOf(home)?.pid === lock7!.pid && recorded2.at(-1) === `http://127.0.0.1:${lock7!.port}/w/world-two/` && (await get(recorded2.at(-1)!)).status === 200, 'the CLI: a workspace folder with such a path opens on the same web app');
  const cliBad = run(['--nope']);
  check(cliBad.status === 1 && /^usage: .* open /.test(cliBad.stderr), 'the CLI: an unknown option says the usage');
  const cliStop = run(['--stop']);
  check(cliStop.status === 0 && /^stopped the web app/.test(cliStop.stdout) && !alive(lock7!.pid) && !lockOf(home), `the CLI: open --stop ends the web app (${cliStop.stdout.trim()})`);
} catch (e: any) {
  check(false, `the test itself failed: ${e?.stack ?? e}`);
  try { console.log(`web.log: ${fs.readFileSync(path.join(tmp, 'home', 'web.log'), 'utf8').trim().split(/\r?\n/).slice(-8).join(' | ')}`); } catch { /* none */ }
} finally {
  // the web apps this process started, and the helpers; one a command line started is stopped by open --stop, which
  // stops only a process its web app's own health confirms
  for (const pid of [...own]) killOwn(pid);
  if (home && lockOf(home)?.pid === process.pid) fs.rmSync(lockFile(home), { force: true }); // a stand-in's lock: this process is no web app to stop
  if (home) await openCommand(['--stop'], 'topotopo', { out: () => {}, err: () => {} }, { home }).catch(() => 1);
  await sleep(500);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

console.log(`\nopen: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
