// `topotopo open` (src/host/open.ts): the command a double-clicked package or workspace runs.
//   node test/open.ts
// It starts the web app (a real server, detached) for each scenario that needs one, in a temporary TopoTopo folder with
// a temporary config, on ports chosen at run time, and records the address that would open in the browser instead of
// opening one. Only servers this test started are stopped (named by the lock files of its own folders), also on failure.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { ROOT } from './fixtures.ts';
import { initPackage } from '../src/package.ts';
import { initWorkspace } from '../src/workspace.ts';
import { lockFile, openCommand, resolveTarget } from '../src/host/open.ts';

let fail = 0, pass = 0;
const check = (ok: unknown, msg: string) => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
};

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'topotopo-open-')));
const CLI = path.join(ROOT, 'src', 'cli.ts');
const freePort = () => new Promise<number>((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });

/** The servers this test started: the pids its lock files named. */
const started = new Set<number>();
const stop = (pid: number) => {
  started.delete(pid); // a pid that is stopped is never signalled again: the system may give it to another program
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(pid);
  } catch { /* gone already */ }
};
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const lockOf = (home: string) => { try { return JSON.parse(fs.readFileSync(lockFile(home), 'utf8')) as { port: number; pid: number }; } catch { return null; } };
const note = (home: string) => { const l = lockOf(home); if (l) started.add(l.pid); return l; };
const stopAll = () => { for (const pid of [...started]) stop(pid); };
process.on('exit', stopAll);
const waitGone = async (pid: number) => { for (let i = 0; i < 100 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100)); };

// servers come and go on one port: no pooled connection (connection: close)
const get = async (url: string) => { try { const r = await fetch(url, { headers: { connection: 'close' }, signal: AbortSignal.timeout(20_000) }); return { status: r.status, text: await r.text() }; } catch (e: any) { throw new Error(`GET ${url}: ${e?.cause?.code ?? e?.message}`); } };

try {
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  const cfgFile = path.join(home, 'config.json');
  const cfgText = JSON.stringify({ web: { port: await freePort() }, libraries: [{ name: 'shared', path: path.join(tmp, 'shared') }] });
  fs.writeFileSync(cfgFile, cfgText);
  process.env.TOPOTOPO_HOME = home;
  process.env.TOPOTOPO_CONFIG = cfgFile;
  delete process.env.TOPOTOPO_BROWSER_LOG;

  // a package in a library the config lists, one in a folder of its own (listed for the run), a workspace with a package
  const shared = path.join(tmp, 'shared', 'rock');
  fs.mkdirSync(shared, { recursive: true });
  initPackage(shared);
  const loose = path.join(tmp, 'loose', 'demo-kit');
  fs.mkdirSync(loose, { recursive: true });
  initPackage(loose);
  const ws = path.join(tmp, 'games', 'my-world');
  fs.mkdirSync(path.join(ws, 'props', 'crate'), { recursive: true });
  initWorkspace(ws, { engine: 'none' });
  initPackage(path.join(ws, 'props', 'crate'));

  const urls: string[] = [];
  const opened = async (...argv: string[]) => {
    const out: string[] = [], err: string[] = [];
    const code = await openCommand(argv, 'topotopo', { out: (s) => out.push(s), err: (s) => err.push(s) }, { browser: async (u) => { urls.push(u); } });
    return { code, out, err, url: urls.at(-1) };
  };

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
  const lock1 = note(home);
  check(first.code === 0 && !!lock1 && alive(lock1.pid) && first.url === `http://127.0.0.1:${lock1.port}/l/loose/demo-kit/`, `start: no web app runs, so one starts and its lock names its port and pid (${first.url}, ${Date.now() - t0} ms)`);
  const page = first.url ? await get(first.url) : { status: 0, text: '' };
  check(page.status === 200 && /demo-kit/.test(page.text), `the package's page answers 200 (${page.status})`);
  check(lock1 && lock1.port === JSON.parse(cfgText).web.port && fs.existsSync(path.join(home, 'web.log')), 'the web app took the config\'s port (it was free) and wrote its output to web.log in the TopoTopo folder');
  check(fs.readFileSync(cfgFile, 'utf8') === cfgText, 'the config is as it was: the package was listed for the run only');

  // ---- reuse: a second open starts no second web app
  const second = await opened(path.join(ws, 'my-world.topows'));
  const lock2 = note(home);
  check(second.code === 0 && lock2?.pid === lock1?.pid && lock2?.port === lock1?.port && alive(lock1!.pid) && second.url === `http://127.0.0.1:${lock1!.port}/w/my-world/`, `reuse: the second open uses the same web app (pid ${lock2?.pid}, ${second.url})`);
  const wsPage = second.url ? await get(second.url) : { status: 0, text: '' };
  const listed = await get(`http://127.0.0.1:${lock1!.port}/api/packages`);
  check(wsPage.status === 200 && /my-world/.test(wsPage.text) && /"lib":"my-world"[^}]*"id":"crate"|"id":"crate"[^}]*"lib":"my-world"/.test(listed.text), `the workspace's page answers 200 and the web app lists its package (${wsPage.status})`);
  const fromFolder = await opened(ws), pkgFolder = await opened(shared), fileAgain = await opened(path.join(loose, 'demo-kit.topo'));
  check(fromFolder.url === second.url && fileAgain.url === first.url, 'a folder opens the workspace it holds like its file, and the same package again gives the same page');
  const rock = pkgFolder.url ? await get(pkgFolder.url) : { status: 0, text: '' };
  check(pkgFolder.url === `http://127.0.0.1:${lock1!.port}/l/shared/rock/` && rock.status === 200 && fs.readFileSync(cfgFile, 'utf8') === cfgText, `a folder holding a package opens it, in the library the config lists (${pkgFolder.url})`);
  const inWorld = await opened(path.join(ws, 'props', 'crate'));
  check(inWorld.code === 0 && inWorld.url === `http://127.0.0.1:${lock1!.port}/w/my-world/props/crate/` && (await get(inWorld.url!)).status === 200, `a package in an opened workspace opens in the workspace (${inWorld.url})`);
  const home1 = await opened();
  check(home1.code === 0 && home1.url === `http://127.0.0.1:${lock1!.port}/` && (await get(home1.url)).status === 200 && lockOf(home)?.pid === lock1!.pid, 'no path opens the home page');

  // ---- stale lock: a process that ended
  stop(lock1!.pid);
  await waitGone(lock1!.pid);
  const gone = spawn(process.execPath, ['-e', '0']);
  await new Promise((r) => gone.once('exit', r));
  fs.writeFileSync(lockFile(home), JSON.stringify({ port: lock1!.port, pid: gone.pid }) + '\n');
  const afterDead = await opened(path.join(loose, 'demo-kit.topo'));
  const lock3 = note(home);
  check(afterDead.code === 0 && !!lock3 && lock3.pid !== gone.pid && alive(lock3.pid) && (await get(afterDead.url!)).status === 200, `stale lock (its process has ended): replaced by a new web app (pid ${lock3?.pid})`);

  // ---- stale lock: the port answers, but not as TopoTopo's web app (and the process in the lock lives: this one)
  stop(lock3!.pid);
  await waitGone(lock3!.pid);
  const dummyPort = await freePort();
  const dummy = http.createServer((_q, r) => { r.writeHead(200, { 'content-type': 'application/json' }); r.end('{"hello":"not topotopo"}'); });
  await new Promise<void>((r) => dummy.listen(dummyPort, '127.0.0.1', r));
  fs.writeFileSync(lockFile(home), JSON.stringify({ port: dummyPort, pid: process.pid }) + '\n');
  const afterOther = await opened(path.join(shared, 'rock.topo'));
  const lock4 = note(home);
  check(afterOther.code === 0 && !!lock4 && lock4.port !== dummyPort && lock4.pid !== process.pid && alive(lock4.pid) && afterOther.url?.startsWith(`http://127.0.0.1:${lock4.port}/`) && (await get(afterOther.url!)).status === 200,
    `stale lock (its port is answered by something else): replaced, and that other program is left alone (port ${dummyPort} still answers: ${(await get(`http://127.0.0.1:${dummyPort}/`)).status})`);
  dummy.close();
  stop(lock4!.pid);
  await waitGone(lock4!.pid);

  // ---- the command as a person runs it: the default opener is replaced by a file, and the exit code is the command's
  const run = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, [CLI, 'open', ...args], { encoding: 'utf8', timeout: 90_000, env: { ...process.env, TOPOTOPO_BROWSER_LOG: path.join(tmp, 'browser.log'), ...env } });
  const cliMissing = run([path.join(tmp, 'nothing.topo')]);
  check(cliMissing.status === 1 && cliMissing.stdout === '' && /^.*nothing\.topo does not exist\n$/.test(cliMissing.stderr), `the CLI: a missing path exits 1 with one sentence on stderr (${cliMissing.stderr.trim()})`);
  const cliOk = run([path.join(loose, 'demo-kit.topo')]);
  const lock5 = note(home);
  const recorded = fs.existsSync(path.join(tmp, 'browser.log')) ? fs.readFileSync(path.join(tmp, 'browser.log'), 'utf8').trim() : '';
  check(cliOk.status === 0 && !!lock5 && recorded === `http://127.0.0.1:${lock5.port}/l/loose/demo-kit/` && (await get(recorded)).status === 200 && cliOk.stderr === '', `the CLI: opens the package (exit ${cliOk.status}, address recorded: ${recorded})`);
  const cliWs = run([ws]);
  const recorded2 = fs.readFileSync(path.join(tmp, 'browser.log'), 'utf8').trim().split('\n');
  check(cliWs.status === 0 && lockOf(home)?.pid === lock5!.pid && recorded2.at(-1) === `http://127.0.0.1:${lock5!.port}/w/my-world/` && (await get(recorded2.at(-1)!)).status === 200, 'the CLI: the workspace folder opens on the same web app');
  const cliBad = run(['--nope']);
  check(cliBad.status === 1 && /^usage: .* open /.test(cliBad.stderr), 'the CLI: an unknown option says the usage');
} catch (e: any) {
  check(false, `the test itself failed: ${e?.stack ?? e}`);
  try { console.log(`web.log: ${fs.readFileSync(path.join(tmp, 'home', 'web.log'), 'utf8').trim().split(/\r?\n/).slice(-8).join(' | ')}`); } catch { /* none */ }
} finally {
  stopAll();
  await new Promise((r) => setTimeout(r, 500));
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

console.log(`\nopen: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
