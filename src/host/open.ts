// `topotopo open [<file|folder>]`: open a package (<id>.topo) or a workspace (<name>.topows) in the browser, the command
// a double-clicked file runs (launcher/, which has no timeout: all the waits share one deadline, 75 seconds, and a
// failure is one plain sentence on stderr with exit code 1). `topotopo open --stop` stops the web app it started.
//   - A web app of this user is found through a lock file, <TopoTopo folder>/web.lock: {"port": 7340, "pid": 1234}. The
//     folder is ~/.topotopo ($TOPOTOPO_HOME names another). The lock names a live web app when its process lives and its
//     port's /api/health answers with that pid. A web app that is busy (it reads a large tree) answers late: it is waited
//     for, up to 15 seconds. A lock that cannot be confirmed (the process is gone, the port is closed, answers as something
//     else or does not answer for 15 seconds) is stale: it is replaced, and no process is ended for it.
//   - A web app that was asked to stop (a bake finishing first can take seconds) says so in its health and refuses to list
//     anything: `open` waits for it to leave and starts another.
//   - A running web app is used whatever its version or engine code, and never ended by `open`. `open` tells it its own
//     version and engine code with each request: when they are not the web app's, its pages say that TopoTopo has changed
//     since it started, with a button that stops it (POST /api/stop), and the person opens the file again.
//   - Without one, the web app starts detached, silent and windowless (`topotopo web`, src/web/server.ts), with the
//     TopoTopo folder as its working folder and its output in <TopoTopo folder>/web.log. It stays up to be reused.
//   - The web app is asked for the page (POST /api/open): it lists the package or workspace for its run when the config
//     does not (nothing is written to the config), and answers the address of the page.
//   - The default browser opens on that address and `open` ends. $TOPOTOPO_BROWSER_LOG names a file that the address is
//     appended to instead (scripts and tests: no window opens).
//   - `open --stop` asks the web app to stop (POST /api/stop: bakes finish, editors end, the process leaves) and waits for
//     it; only if it does not leave in time, and its health confirms the pid of the lock, that one process is ended.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.ts';
import { manifestAt, oldManifest, oldWorkspace, processAlive, takeLock, workspaceAt } from '../package.ts';
import { MANIFEST_EXT, WORKSPACE_EXT, topoFiles, topowsFiles } from '../session.ts';
import { engineSha256 } from './engine-code.ts';
import { TOPOTOPO_VERSION } from './version.ts';

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', import.meta.url.endsWith('.ts') ? 'cli.ts' : 'cli.js');

/** The one time `open` has for everything it waits for: another `open` starting the web app, the web app starting, its answers. */
const OPEN_MS = 75_000;
/** How long a web app that is starting may take. */
const START_MS = 30_000;
/**
 * How long a port that accepts connections and does not answer is waited for before its lock counts as one that cannot be
 * confirmed (a web app that is busy reading a large tree answers within this; one that never answers is no web app).
 */
const BUSY_MS = 15_000;
/** How long `open --stop` gives the web app to leave by itself (its bakes may take up to 20 s to finish). */
const STOP_MS = 40_000;

/** The person's TopoTopo folder: ~/.topotopo, or $TOPOTOPO_HOME. */
export const topotopoHome = () => path.resolve(process.env.TOPOTOPO_HOME ?? path.join(os.homedir(), '.topotopo'));
/** The lock file of the web app `open` starts and reuses. */
export const lockFile = (home = topotopoHome()) => path.join(home, 'web.lock');

export interface OpenOptions {
  /** the person's TopoTopo folder (default: topotopoHome()) */
  home?: string;
  /** opens an address in the browser (default: the system's browser, or $TOPOTOPO_BROWSER_LOG) */
  browser?: (url: string) => Promise<void>;
  /** told the pid of each web app this call starts (tests stop only those) */
  spawned?: (pid: number) => void;
  /** the deadline for all the waits, in ms (default 75 s) */
  timeoutMs?: number;
  /** how long a web app that does not answer is waited for before its lock counts as one that cannot be confirmed (default 40 s; --stop 15 s) */
  busyMs?: number;
}

/** The time left of the one deadline of a call; asking for it after the deadline fails with one sentence. */
class Deadline {
  private end: number;
  private total: number;
  constructor(ms: number) { this.total = ms; this.end = Date.now() + ms; }
  /** the ms left, at most `cap`; throws when none is left, saying what was being waited for */
  left(waitingFor: string, cap = Infinity): number {
    const left = this.end - Date.now();
    if (left <= 0) throw new Error(`gave up after ${Math.round(this.total / 1000)} seconds waiting for ${waitingFor}`);
    return Math.min(left, cap);
  }
}

/** What was asked for: a package's or a workspace's folder, or nothing (the home page). */
export type Target = { kind: 'package' | 'workspace'; dir: string; what: string } | { kind: 'home' };

/**
 * The package or workspace a file or folder names. A .topo or .topows file is itself; a folder is the package or
 * workspace it holds. Throws one sentence for a path that is not there, a file of another kind, and a folder that
 * holds neither (or both, or two of a kind).
 */
export function resolveTarget(given: string | undefined): Target {
  if (given === undefined) return { kind: 'home' };
  const abs = path.resolve(given);
  const stat = fs.statSync(abs, { throwIfNoEntry: false });
  if (!stat) throw new Error(`${abs} does not exist`);
  if (stat.isFile()) {
    const dir = path.dirname(abs), name = path.basename(abs);
    if (name.endsWith(MANIFEST_EXT) && name.length > MANIFEST_EXT.length) { manifestAt(dir); return { kind: 'package', dir, what: name }; }
    if (name.endsWith(WORKSPACE_EXT) && name.length > WORKSPACE_EXT.length) { workspaceAt(dir); return { kind: 'workspace', dir, what: name }; }
    throw new Error(`${abs} is neither a package (${MANIFEST_EXT}) nor a workspace (${WORKSPACE_EXT}) file`);
  }
  const pkgs = topoFiles(abs), wss = topowsFiles(abs);
  if (pkgs.length && wss.length) throw new Error(`${abs} holds both ${pkgs[0]} and ${wss[0]}: open the file you mean`);
  if (pkgs.length) { manifestAt(abs); return { kind: 'package', dir: abs, what: pkgs[0] }; }
  if (wss.length) { workspaceAt(abs); return { kind: 'workspace', dir: abs, what: wss[0] }; }
  throw new Error(oldWorkspace(abs) ?? oldManifest(abs) ?? `${abs} holds no ${MANIFEST_EXT} or ${WORKSPACE_EXT} file`);
}

// ------------------------------------------------------------------------------------------------------- the web app

interface Lock { port: number; pid: number }
/** What a web app's /api/health says of it (src/web/server.ts). */
interface Health { web: true; pid: number; version?: string; engine?: string; open?: boolean; stopping?: boolean }

const readLock = (file: string): Lock | null => {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Number.isInteger(j?.port) && Number.isInteger(j?.pid) && j.port > 0 ? { port: j.port, pid: j.pid } : null;
  } catch { return null; }
};

/** The web app's own last act when it was stopped by a request: its lock goes, when the lock is its own. */
export function removeLockIfMine(home = topotopoHome()) {
  const lock = readLock(lockFile(home));
  if (lock?.pid === process.pid) fs.rmSync(lockFile(home), { force: true });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Ask a port for its health, waiting while it is busy: `live` (the web app answered), `stopping` (a web app that was asked
 * to stop and is finishing: it is not one to open a file in), `other` (something else answered), `closed` (nothing
 * listens), `busy` (it accepts connections but did not answer within `limit` ms).
 */
export async function probe(port: number, limit: number): Promise<{ state: 'live' | 'stopping'; health: Health } | { state: 'other' | 'closed' | 'busy' }> {
  for (const t0 = Date.now(); Date.now() - t0 < limit; ) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { connection: 'close' }, signal: AbortSignal.timeout(Math.min(5000, Math.max(500, limit - (Date.now() - t0)))) });
      const j: any = await res.json().catch(() => null);
      return j?.web === true && Number.isInteger(j.pid) ? { state: j.stopping === true ? 'stopping' : 'live', health: j } : { state: 'other' };
    } catch (e: any) {
      if (e?.cause?.code === 'ECONNREFUSED') return { state: 'closed' };
      if (e?.name !== 'TimeoutError') await sleep(200); // a reset, a connection that did not open yet: asked again
    }
  }
  return { state: 'busy' };
}

/** What the lock says of a web app: it is live, it is stopping, the port is silent (it accepts connections and never answers), or there is none. */
type Verdict = { live: Lock } | { stopping: Lock } | { silent: Lock } | { none: true };

/**
 * The web app the lock names, when its process lives and its port answers with that pid. A web app that was asked to stop
 * and is finishing says so (`stopping`). Anything else (the process is gone, the port is closed or answers as something
 * else or with another pid) is a lock that cannot be confirmed (`none`); so is one whose port nothing answers on for
 * `busyMs` (`silent`: decided once, and `knownSilent` is that decision again for the same lock). No process is ended for it.
 */
async function judge(file: string, dl: Deadline, busyMs = BUSY_MS, knownSilent?: Lock): Promise<Verdict> {
  const lock = readLock(file);
  if (!lock || !processAlive(lock.pid)) return { none: true };
  if (knownSilent && knownSilent.pid === lock.pid && knownSilent.port === lock.port) return { none: true };
  const r = await probe(lock.port, dl.left('the web app', busyMs));
  if (r.state === 'busy') return { silent: lock };
  if ((r.state === 'live' || r.state === 'stopping') && r.health.pid === lock.pid) return r.state === 'live' ? { live: lock } : { stopping: lock };
  return { none: true };
}

/** Wait for a web app that is stopping to leave: its process ends (its lock goes with it). */
async function waitToLeave(lock: Lock, dl: Deadline): Promise<void> {
  while (processAlive(lock.pid)) { dl.left(`the web app (process ${lock.pid}) that is stopping to leave`); await sleep(100); }
}

/** End a process and what it started. */
function killTree(pid: number) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else { try { process.kill(pid); } catch { /* gone already */ } }
}

/** A port nothing listens on: the config's when it is free (0: any), else one the system gives. */
function freePort(preferred: number): Promise<number> {
  const listen = (port: number) => new Promise<number>((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(port, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
  return listen(preferred).catch(() => listen(0));
}

/** Start the web app detached, silent and windowless; resolves once it answers, with its lock written. */
async function startServer(home: string, lockPath: string, o: OpenOptions, dl: Deadline): Promise<Lock> {
  fs.mkdirSync(home, { recursive: true });
  const port = await freePort(loadConfig().web.port);
  const logFile = path.join(home, 'web.log');
  const fd = fs.openSync(logFile, 'w');
  let exited: number | null | undefined;
  let child;
  try {
    // the web app's working folder is the TopoTopo folder: never the folder of what is being opened
    child = spawn(process.execPath, [cli, 'web', '--port', String(port)], { cwd: home, detached: true, windowsHide: true, stdio: ['ignore', fd, fd] });
  } finally { fs.closeSync(fd); }
  child.on('exit', (code) => { exited = code ?? -1; });
  child.on('error', (e) => { exited = -1; fs.appendFileSync(logFile, `${e.message}\n`); });
  child.unref();
  if (child.pid) o.spawned?.(child.pid);
  const why = () => {
    let tail = '';
    try { tail = fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-2).join(' '); } catch { /* no log */ }
    return `the web app did not start${exited !== undefined ? ` (it stopped with code ${exited})` : ' in time'}${tail ? `: ${tail}` : ''} (${logFile})`;
  };
  const limit = Date.now() + Math.min(START_MS, dl.left('the web app to start'));
  while (Date.now() < limit) {
    if (exited !== undefined) throw new Error(why());
    const r = child.pid ? await probe(port, 1500) : null;
    if (r?.state === 'live' && r.health.pid === child.pid) {
      const lock: Lock = { port, pid: child.pid };
      fs.writeFileSync(lockPath, JSON.stringify(lock) + '\n');
      return lock;
    }
    await sleep(100);
  }
  // a web app that never answered is not left behind
  if (child.pid) killTree(child.pid);
  throw new Error(why());
}

/** The web app of this user, started when none runs (one `open` starts it; another waits and uses it). */
export async function ensureServer(home: string, o: OpenOptions, dl: Deadline): Promise<Lock> {
  const lockPath = lockFile(home);
  let silent: Lock | undefined;
  // the live web app, or null when there is none to use: one that is stopping is waited for to leave first
  const find = async (): Promise<Lock | null> => {
    for (;;) {
      const v = await judge(lockPath, dl, o.busyMs, silent);
      if ('live' in v) return v.live;
      if ('stopping' in v) { await waitToLeave(v.stopping, dl); continue; }
      if ('silent' in v) silent = v.silent;
      return null;
    }
  };
  const first = await find();
  if (first) return first;
  fs.mkdirSync(home, { recursive: true });
  let release: () => void;
  try {
    release = takeLock(path.join(home, 'web.starting'), { waitMs: dl.left('another TopoTopo to start the web app'), held: () => 'gave up waiting for another TopoTopo that is starting the web app' });
  } catch (e: any) { throw new Error(e.message); }
  try {
    // another `open` may have started it while this one waited
    return (await find()) ?? (await startServer(home, lockPath, o, dl));
  } finally { release(); }
}

/** `open --stop`: ask the web app the lock names to stop; end that process only if it does not leave, and its health confirms its pid. */
async function stopCommand(home: string, io: { out(s: string): void }, dl: Deadline, busyMs = 15_000): Promise<void> {
  const lockPath = lockFile(home);
  const lock = readLock(lockPath);
  if (!lock || !processAlive(lock.pid)) { fs.rmSync(lockPath, { force: true }); io.out('no web app of yours is running'); return; }
  const r = await probe(lock.port, dl.left('the web app', busyMs));
  if ((r.state !== 'live' && r.state !== 'stopping') || r.health.pid !== lock.pid) {
    // a reused pid, or another program on the port: the lock goes, no process is ended
    fs.rmSync(lockPath, { force: true });
    io.out(`no web app of yours answers at port ${lock.port} as process ${lock.pid}: the lock was removed and nothing was ended`);
    return;
  }
  let asked = true;
  // one that is stopping was asked already
  if (r.state === 'live') try {
    const res = await fetch(`http://127.0.0.1:${lock.port}/api/stop`, { method: 'POST', headers: { 'x-topotopo-open': '1', connection: 'close' }, signal: AbortSignal.timeout(dl.left('the web app to take the request to stop', 10_000)) });
    asked = res.ok;
  } catch { asked = false; }
  for (const t0 = Date.now(); asked && processAlive(lock.pid) && Date.now() - t0 < STOP_MS; ) await sleep(100);
  let ended = '';
  if (processAlive(lock.pid)) {
    // it did not leave (or cannot be asked): the one process its health confirmed
    const again = await probe(lock.port, 2000);
    if ((again.state === 'live' || again.state === 'stopping') && again.health.pid === lock.pid) {
      killTree(lock.pid);
      for (const t0 = Date.now(); processAlive(lock.pid) && Date.now() - t0 < 10_000; ) await sleep(100);
      ended = ' (it did not leave when asked, so the process was ended)';
    }
    if (processAlive(lock.pid)) throw new Error(`the web app (process ${lock.pid}) did not stop`);
  }
  fs.rmSync(lockPath, { force: true });
  io.out(`stopped the web app (process ${lock.pid}, port ${lock.port})${ended}`);
}

/** Ask the web app for the page (it lists the package or workspace first when it does not): its path. */
async function pageFor(server: Lock, target: Exclude<Target, { kind: 'home' }>, dl: Deadline): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${server.port}/api/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-topotopo-open': '1', connection: 'close' },
      body: JSON.stringify({ kind: target.kind, dir: target.dir, version: TOPOTOPO_VERSION, engine: engineSha256() }),
      signal: AbortSignal.timeout(dl.left('the web app to list the page')),
    });
  } catch (e: any) {
    if (e?.name === 'TimeoutError') throw new Error(`gave up waiting for the web app to list ${target.what}`);
    throw new Error(`the web app did not answer: ${e?.message ?? e}`);
  }
  const body: any = await res.json().catch(() => null);
  if (res.status === 503 && body?.error) throw Object.assign(new Error(body.error), { stopping: true }); // asked to stop between the check and this request
  if (res.status === 404 || res.status === 405) throw new Error(`the running web app (port ${server.port}) cannot open files: run topotopo open --stop, then open ${target.what} again`);
  if (!res.ok || typeof body?.url !== 'string') throw new Error(body?.error ?? `the web app answered ${res.status}`);
  return body.url;
}

// ------------------------------------------------------------------------------------------------------- the browser

/** Open an address in the default browser (or, with $TOPOTOPO_BROWSER_LOG, append it to that file). Resolves once it is opening. */
export async function openBrowser(url: string): Promise<void> {
  const log = process.env.TOPOTOPO_BROWSER_LOG;
  if (log) { fs.appendFileSync(log, `${url}\n`); return; }
  const [cmd, args] = process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  await new Promise<void>((resolve, reject) => {
    const c = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    c.once('error', (e) => reject(new Error(`no browser could be opened (${e.message}): open ${url} yourself`)));
    c.once('spawn', () => { c.unref(); resolve(); });
  });
}

// ------------------------------------------------------------------------------------------------------- the command

/**
 * `open [<file|folder>]` or `open --stop`: returns the exit code; a failure is one sentence on `err`. Opens the home
 * page when no path is given.
 */
export async function openCommand(argv: string[], prog: string, io: { out(s: string): void; err(s: string): void }, o: OpenOptions = {}): Promise<number> {
  try {
    const usage = `usage: ${prog} open [<file.topo | file.topows | folder>] | open --stop`;
    const dl = new Deadline(o.timeoutMs ?? OPEN_MS);
    const home = o.home ?? topotopoHome();
    if (argv.length === 1 && argv[0] === '--stop') { await stopCommand(home, io, new Deadline(OPEN_MS + STOP_MS), o.busyMs); return 0; }
    if (argv.length > 1 || argv[0]?.startsWith('--')) throw new Error(usage);
    const target = resolveTarget(argv[0]);
    // a web app that was asked to stop between the check and the request is waited for to leave, and another is started
    let server = await ensureServer(home, o, dl), where = '/';
    for (let tries = 0; target.kind !== 'home'; tries++) {
      try { where = await pageFor(server, target, dl); break; }
      catch (e: any) { if (!e?.stopping || tries >= 3) throw e; server = await ensureServer(home, o, dl); }
    }
    const url = `http://127.0.0.1:${server.port}${where}`;
    await (o.browser ?? openBrowser)(url);
    io.out(`opening ${url}`);
    return 0;
  } catch (e: any) {
    io.err(String(e?.message ?? e).split('\n')[0]);
    return 1;
  }
}
