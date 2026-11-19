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
const opened = async (...argv: string[]) => {
  const out: string[] = [], err: string[] = [];
  const code = await openCommand(argv, 'topotopo', { out: (s) => out.push(s), err: (s) => err.push(s) }, { browser: async (u) => { urls.push(u); }, spawned: (pid) => { spawnedPids.push(pid); own.add(pid); } });
  return { code, out, err, url: urls.at(-1) };
};
const hereHealth = (pid: number) => ({ web: true, pid, version: TOPOTOPO_VERSION, engine: engineSha256(), open: true });

try {
  home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  const cfgFile = path.join(home, 'config.json');
  const cfgText = JSON.stringify({ web: { port: await freePort() }, libraries: [{ name: 'shared', path: path.join(tmp, 'shared') }] });
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

  // ---- --stop ends the web app this call started, and only it
  const stopped = await opened('--stop');
  const gone = await probe(lock1!.port, 3000);
  check(stopped.code === 0 && /^stopped the web app \(process \d+, port \d+\)$/.test(stopped.out[0] ?? '') && !alive(lock1!.pid) && !lockOf(home) && gone.state === 'closed', `open --stop: stops the web app, removes the lock, the port is closed (${stopped.out[0]})`);
  own.delete(lock1!.pid);
  const none = await opened('--stop');
  check(none.code === 0 && /^no web app of yours is running$/.test(none.out[0] ?? ''), 'open --stop with none running says so and succeeds');
  const bystander = sleeper();
  const liar = await fake({ web: true, pid: bystander + 1_000_000, version: TOPOTOPO_VERSION, engine: engineSha256(), open: true });
  fs.writeFileSync(lockFile(home), JSON.stringify({ port: liar.port, pid: bystander }));
  const refused = await opened('--stop');
  check(refused.code === 0 && alive(bystander) && !lockOf(home) && /left alone/.test(refused.out[0] ?? ''), 'open --stop does not end a process whose web app health does not confirm the lock\'s pid');
  liar.close(); killOwn(bystander);

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

  // ---- a web app of another TopoTopo (another engine code) is stopped and replaced
  const old = sleeper();
  const oldApp = await fake({ web: true, pid: old, version: TOPOTOPO_VERSION, engine: 'another engine', open: true });
  fs.writeFileSync(lockFile(home), JSON.stringify({ port: oldApp.port, pid: old }) + '\n');
  const before6 = spawnedPids.length;
  const replaced = await opened(path.join(loose, 'demo-kit.topo'));
  const lock6 = lockOf(home);
  await waitGone(old);
  check(replaced.code === 0 && !alive(old) && !!lock6 && lock6.pid !== old && spawnedPids.length === before6 + 1 && lock6.pid === spawnedPids.at(-1) && (await get(replaced.url!)).status === 200,
    `a running web app with another engine code is stopped (its health confirmed the pid) and a fresh one started (pid ${lock6?.pid})`);
  own.delete(old); oldApp.close();
  const old2 = sleeper();
  const oldApp2 = await fake({ web: true, pid: old2, version: '0.0.1', engine: engineSha256() });
  killOwn(lock6!.pid); await waitGone(lock6!.pid);
  fs.writeFileSync(lockFile(home), JSON.stringify({ port: oldApp2.port, pid: old2 }) + '\n');
  const replaced2 = await opened(path.join(loose, 'demo-kit.topo'));
  await waitGone(old2);
  check(replaced2.code === 0 && !alive(old2) && lockOf(home)?.pid === spawnedPids.at(-1), 'a web app of another version, without /api/open, is replaced the same way');
  own.delete(old2); oldApp2.close();
  killOwn(lockOf(home)!.pid); await waitGone(lockOf(home)!.pid);
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
