// `topotopo open [<file|folder>]`: open a package (<id>.topo) or a workspace (<name>.topows) in the browser, the command
// a double-clicked file runs (launcher/, which has no timeout: every wait here has a limit, and a failure is one plain
// sentence on stderr with exit code 1). `topotopo open --stop` stops the web app it started.
//   - A web app of this user is found through a lock file, <TopoTopo folder>/web.lock: {"port": 7340, "pid": 1234}. The
//     folder is ~/.topotopo ($TOPOTOPO_HOME names another). The lock names a live web app when its process lives and its
//     port's /api/health answers with that pid. A web app that is busy (it reads a large tree) answers late: it is waited
//     for, never replaced. The lock is stale, and replaced, when its process has ended, its port is closed, or the port
//     answers as something else (another pid, not the web app).
//   - A web app of another TopoTopo (another version or engine code, or one without /api/open) is stopped, when its health
//     confirms the pid of the lock, and a fresh one started: nobody can restart a windowless process by hand.
//   - Without one, the web app starts detached, silent and windowless (`topotopo web`, src/web/server.ts), with the
//     TopoTopo folder as its working folder and its output in <TopoTopo folder>/web.log. It stays up to be reused.
//   - The web app is asked for the page (POST /api/open): it lists the package or workspace for its run when the config
//     does not (nothing is written to the config), and answers the address of the page.
//   - The default browser opens on that address and `open` ends. $TOPOTOPO_BROWSER_LOG names a file that the address is
//     appended to instead (scripts and tests: no window opens).
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

/** How long a web app that is starting may take before `open` gives up, and how long it waits for another `open` starting one. */
const START_MS = 30_000;
/** How long the web app may take to list a package or workspace (it reads the tree first). */
const ASK_MS = 60_000;
/** How long a busy web app is waited for before its health check is given up. */
const BUSY_MS = 60_000;

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
interface Health { web: true; pid: number; version?: string; engine?: string; open?: boolean }

const readLock = (file: string): Lock | null => {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Number.isInteger(j?.port) && Number.isInteger(j?.pid) && j.port > 0 ? { port: j.port, pid: j.pid } : null;
  } catch { return null; }
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Ask a port for its health, waiting while it is busy: `live` (the web app answered), `other` (something else
 * answered), `closed` (nothing listens), `busy` (it accepts connections but did not answer within `limit` ms).
 */
export async function probe(port: number, limit = BUSY_MS): Promise<{ state: 'live'; health: Health } | { state: 'other' | 'closed' | 'busy' }> {
  for (const t0 = Date.now(); Date.now() - t0 < limit; ) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { connection: 'close' }, signal: AbortSignal.timeout(Math.min(5000, Math.max(500, limit - (Date.now() - t0)))) });
      const j: any = await res.json().catch(() => null);
      return j?.web === true && Number.isInteger(j.pid) ? { state: 'live', health: j } : { state: 'other' };
    } catch (e: any) {
      if (e?.cause?.code === 'ECONNREFUSED') return { state: 'closed' };
      if (e?.name !== 'TimeoutError') await sleep(200); // a reset, a connection that did not open yet: asked again
    }
  }
  return { state: 'busy' };
}

/** The web app the lock names, with its health, when its process lives and its port answers with that pid; else null (stale). Throws for one that stays busy. */
async function livingServer(file: string): Promise<{ lock: Lock; health: Health } | null> {
  const lock = readLock(file);
  if (!lock || !processAlive(lock.pid)) return null;
  const r = await probe(lock.port);
  if (r.state === 'busy') throw new Error(`the web app (process ${lock.pid}, port ${lock.port}) did not answer within ${BUSY_MS / 1000} seconds: it is busy, try again in a minute`);
  return r.state === 'live' && r.health.pid === lock.pid ? { lock, health: r.health } : null;
}

/** Whether a running web app is this TopoTopo's: the same version and engine code, and it answers /api/open. */
const compatible = (h: Health) => h.open === true && h.version === TOPOTOPO_VERSION && h.engine === engineSha256();

/** End a process and what it started. */
function killTree(pid: number) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else { try { process.kill(pid); } catch { /* gone already */ } }
}

/** Stop the web app a lock names (its health has confirmed the pid), and remove the lock. */
async function stopServer(lock: Lock, lockPath: string) {
  killTree(lock.pid);
  for (const t0 = Date.now(); processAlive(lock.pid) && Date.now() - t0 < 10_000; ) await sleep(100);
  if (processAlive(lock.pid)) throw new Error(`the web app (process ${lock.pid}) did not stop`);
  fs.rmSync(lockPath, { force: true });
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
async function startServer(home: string, lockPath: string, o: OpenOptions): Promise<Lock> {
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
    return `the web app did not start${exited !== undefined ? ` (it stopped with code ${exited})` : ` within ${START_MS / 1000} seconds`}${tail ? `: ${tail}` : ''} (${logFile})`;
  };
  for (const t0 = Date.now(); Date.now() - t0 < START_MS; ) {
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

/** The web app of this user (this TopoTopo's), started when none runs (one `open` starts it; another waits and uses it). */
export async function ensureServer(home = topotopoHome(), o: OpenOptions = {}): Promise<Lock> {
  const lockPath = lockFile(home);
  /** a running web app of this TopoTopo, or null; one of another is stopped */
  const usable = async () => {
    const have = await livingServer(lockPath);
    if (!have) return null;
    if (compatible(have.health)) return have.lock;
    await stopServer(have.lock, lockPath);
    return null;
  };
  const first = await usable();
  if (first) return first;
  fs.mkdirSync(home, { recursive: true });
  let release: () => void;
  try {
    release = takeLock(path.join(home, 'web.starting'), { waitMs: START_MS + BUSY_MS, held: () => `another TopoTopo is starting the web app and did not finish within ${(START_MS + BUSY_MS) / 1000} seconds` });
  } catch (e: any) { throw new Error(e.message); }
  try {
    // another `open` may have started it while this one waited
    return (await usable()) ?? (await startServer(home, lockPath, o));
  } finally { release(); }
}

/** `open --stop`: stop the web app the lock names, when its health confirms its pid. */
async function stopCommand(home: string, io: { out(s: string): void }): Promise<void> {
  const lockPath = lockFile(home);
  const lock = readLock(lockPath);
  if (!lock || !processAlive(lock.pid)) { fs.rmSync(lockPath, { force: true }); io.out('no web app of yours is running'); return; }
  const r = await probe(lock.port, 30_000);
  if (r.state === 'busy') throw new Error(`the web app (process ${lock.pid}, port ${lock.port}) did not answer within 30 seconds, so it was not stopped`);
  if (r.state !== 'live' || r.health.pid !== lock.pid) { fs.rmSync(lockPath, { force: true }); io.out('no web app of yours is running (the lock named another program, which was left alone)'); return; }
  await stopServer(lock, lockPath);
  io.out(`stopped the web app (process ${lock.pid}, port ${lock.port})`);
}

/** Ask the web app for the page (it lists the package or workspace first when it does not): its path. */
async function pageFor(server: Lock, target: Exclude<Target, { kind: 'home' }>): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${server.port}/api/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-topotopo-open': '1', connection: 'close' },
      body: JSON.stringify({ kind: target.kind, dir: target.dir }),
      signal: AbortSignal.timeout(ASK_MS),
    });
  } catch (e: any) { throw new Error(`the web app did not answer within ${ASK_MS / 1000} seconds: ${e?.name === 'TimeoutError' ? 'it is busy' : e?.message ?? e}`); }
  const body: any = await res.json().catch(() => null);
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
    if (argv.length === 1 && argv[0] === '--stop') { await stopCommand(o.home ?? topotopoHome(), io); return 0; }
    if (argv.length > 1 || argv[0]?.startsWith('--')) throw new Error(usage);
    const target = resolveTarget(argv[0]);
    const server = await ensureServer(o.home, o);
    const where = target.kind === 'home' ? '/' : await pageFor(server, target);
    const url = `http://127.0.0.1:${server.port}${where}`;
    await (o.browser ?? openBrowser)(url);
    io.out(`opening ${url}`);
    return 0;
  } catch (e: any) {
    io.err(String(e?.message ?? e).split('\n')[0]);
    return 1;
  }
}
