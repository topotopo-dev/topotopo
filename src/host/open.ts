// `topotopo open [<file|folder>]`: open a package (<id>.topo) or a workspace (<name>.topows) in the browser, the command
// a double-clicked file runs (launcher/, which has no timeout: every wait here has a limit, and a failure is one plain
// sentence on stderr with exit code 1).
//   - A web app of this user is found through a lock file, <TopoTopo folder>/web.lock: {"port": 7340, "pid": 1234}. The
//     folder is ~/.topotopo ($TOPOTOPO_HOME names another). The lock counts when its process lives and its port answers
//     as TopoTopo's web app; otherwise it is stale and replaced.
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
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.ts';
import { manifestAt, oldManifest, oldWorkspace, processAlive, takeLock, workspaceAt } from '../package.ts';
import { MANIFEST_EXT, WORKSPACE_EXT, topoFiles, topowsFiles } from '../session.ts';
import { runningWeb } from '../web/server.ts';

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', import.meta.url.endsWith('.ts') ? 'cli.ts' : 'cli.js');

/** How long a web app that is starting may take before `open` gives up, and how long it waits for another `open` starting one. */
const START_MS = 30_000;
/** How long the web app may take to list a package or workspace (it reads the tree first). */
const ASK_MS = 60_000;

/** The person's TopoTopo folder: ~/.topotopo, or $TOPOTOPO_HOME. */
export const topotopoHome = () => path.resolve(process.env.TOPOTOPO_HOME ?? path.join(os.homedir(), '.topotopo'));
/** The lock file of the web app `open` starts and reuses. */
export const lockFile = (home = topotopoHome()) => path.join(home, 'web.lock');

export interface OpenOptions {
  /** the person's TopoTopo folder (default: topotopoHome()) */
  home?: string;
  /** opens an address in the browser (default: the system's browser, or $TOPOTOPO_BROWSER_LOG) */
  browser?: (url: string) => Promise<void>;
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
    if (name.endsWith(MANIFEST_EXT) && name.length > MANIFEST_EXT.length) { check(() => manifestAt(dir)); return { kind: 'package', dir, what: name }; }
    if (name.endsWith(WORKSPACE_EXT) && name.length > WORKSPACE_EXT.length) { check(() => workspaceAt(dir)); return { kind: 'workspace', dir, what: name }; }
    throw new Error(`${abs} is neither a package (${MANIFEST_EXT}) nor a workspace (${WORKSPACE_EXT}) file`);
  }
  const pkgs = topoFiles(abs), wss = topowsFiles(abs);
  if (pkgs.length && wss.length) throw new Error(`${abs} holds both ${pkgs[0]} and ${wss[0]}: open the file you mean`);
  if (pkgs.length) { check(() => manifestAt(abs)); return { kind: 'package', dir: abs, what: pkgs[0] }; }
  if (wss.length) { check(() => workspaceAt(abs)); return { kind: 'workspace', dir: abs, what: wss[0] }; }
  throw new Error(oldWorkspace(abs) ?? oldManifest(abs) ?? `${abs} holds no ${MANIFEST_EXT} or ${WORKSPACE_EXT} file`);
}
/** Run a check that throws a sentence (two files in a folder, a name that is no id). */
const check = (f: () => unknown) => { f(); };

// ------------------------------------------------------------------------------------------------------- the web app

interface Lock { port: number; pid: number }

const readLock = (file: string): Lock | null => {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Number.isInteger(j?.port) && Number.isInteger(j?.pid) && j.port > 0 ? { port: j.port, pid: j.pid } : null;
  } catch { return null; }
};

/** The web app the lock names, when its process lives and its port answers as the web app; else null (the lock is stale). */
async function livingServer(file: string): Promise<Lock | null> {
  const lock = readLock(file);
  if (!lock || !processAlive(lock.pid)) return null;
  // a busy web app (it reads a large tree) may answer late: it is asked a few times before its lock counts as stale
  for (let i = 0; i < 4; i++) if (await runningWeb(lock.port)) return lock;
  return null;
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Start the web app detached, silent and windowless; resolves once it answers, with its lock written. */
async function startServer(home: string, lockPath: string): Promise<Lock> {
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
  const why = () => {
    let tail = '';
    try { tail = fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-2).join(' '); } catch { /* no log */ }
    return `the web app did not start${exited !== undefined ? ` (it stopped with code ${exited})` : ` within ${START_MS / 1000} seconds`}${tail ? `: ${tail}` : ''} (${logFile})`;
  };
  for (const t0 = Date.now(); Date.now() - t0 < START_MS; ) {
    if (exited !== undefined) throw new Error(why());
    if (child.pid && (await runningWeb(port))) {
      const lock: Lock = { port, pid: child.pid };
      fs.writeFileSync(lockPath, JSON.stringify(lock) + '\n');
      return lock;
    }
    await sleep(100);
  }
  // a web app that never answered is not left behind
  try { if (child.pid) process.kill(child.pid); } catch { /* gone already */ }
  throw new Error(why());
}

/** The running web app of this user, started when none is (one `open` starts it; another waits and uses it). */
export async function ensureServer(home = topotopoHome()): Promise<Lock> {
  const lockPath = lockFile(home);
  const have = await livingServer(lockPath);
  if (have) return have;
  fs.mkdirSync(home, { recursive: true });
  let release: () => void;
  try {
    release = takeLock(path.join(home, 'web.starting'), { waitMs: START_MS + 5000, held: () => `another TopoTopo is starting the web app and did not finish within ${START_MS / 1000} seconds` });
  } catch (e: any) { throw new Error(e.message); }
  try {
    // another `open` may have started it while this one waited
    return (await livingServer(lockPath)) ?? (await startServer(home, lockPath));
  } finally { release(); }
}

/** Ask the web app for the page (it lists the package or workspace first when it does not): its path. */
async function pageFor(server: Lock, target: Exclude<Target, { kind: 'home' }>): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${server.port}/api/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-topotopo-open': '1' },
      body: JSON.stringify({ kind: target.kind, dir: target.dir }),
      signal: AbortSignal.timeout(ASK_MS),
    });
  } catch (e: any) { throw new Error(`the web app did not answer within ${ASK_MS / 1000} seconds: ${e?.name === 'TimeoutError' ? 'it is busy' : e?.message ?? e}`); }
  const body: any = await res.json().catch(() => null);
  if (res.status === 404) throw new Error(`the running web app (port ${server.port}) is older than this TopoTopo and cannot open ${target.what}: stop it and run the command again`);
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
 * `open [<file|folder>]`: returns the exit code; a failure is one sentence on `err`. Opens the home page when no path is
 * given.
 */
export async function openCommand(argv: string[], prog: string, io: { out(s: string): void; err(s: string): void }, o: OpenOptions = {}): Promise<number> {
  try {
    if (argv.length > 1 || argv[0]?.startsWith('--')) throw new Error(`usage: ${prog} open [<file.topo | file.topows | folder>]`);
    const target = resolveTarget(argv[0]);
    const server = await ensureServer(o.home);
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
