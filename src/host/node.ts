// Node.js implementation of the Host interface.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { ExprSandbox, Host, WorkerPool } from './types.ts';
import { createNodePool, poolOptionsFromEnv } from './pool.ts';
import { packageFolderOf } from './export-targets.ts';
import type { NodePoolOptions } from './pool.ts';
import { REALM_CONTROL, SCRIPT_REALM_SETUP } from '../core/snippet-lib.ts';
import { makeCurl, makeNoise } from '../core/noise.ts';
import type { Noise3 } from '../core/noise.ts';
import { randN } from '../core/random.ts';

/** Promise.prototype of every script realm (async functions in a realm create promises with it). */
const realmPromiseProtos = new WeakSet<object>();
let rejectionFilter = false;

/**
 * A stray rejected promise of a script (an un-awaited lib.run that fails, an async callback that throws, a
 * continuation stopped by a timeout) must not take the process down, which is what Node does with unhandled
 * rejections by default: the MCP server would die. Rejections of realm promises are dropped; any other one is
 * re-thrown as Node would (unless the application listens for them itself).
 */
function filterRealmRejections() {
  if (rejectionFilter) return;
  rejectionFilter = true;
  process.on('unhandledRejection', (reason, promise) => {
    if (realmPromiseProtos.has(Object.getPrototypeOf(promise))) return;
    if (process.listenerCount('unhandledRejection') === 1) throw reason;
  });
}

/** No shell: executable paths and file names are passed as separate arguments on every platform. */
function runBlender(executable: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
      const output = `${stdout}\n${stderr}`.trim();
      if (error) {
        const tail = output.split(/\r?\n/).slice(-40).join('\n');
        const reason = error.message.split(/\r?\n/)[0]; // execFile's message may itself contain all of stderr
        reject(new Error(`Blender failed (exit code ${error.code ?? 'none'}${error.signal ? `, signal ${error.signal}` : ''}${error.killed ? ', timed out or killed' : ''}): ${reason}\n${tail}`));
      } else resolve(output);
    });
  });
}

/** Executable lookup shared by conversion and integration tests. An unavailable installation returns null. */
export async function findBlender(): Promise<string | null> {
  const candidates = [process.env.TOPOTOPO_BLENDER, 'blender'].filter((p): p is string => !!p);
  const foundation = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Blender Foundation');
  try {
    const versions = fs.readdirSync(foundation, { withFileTypes: true }).filter((e) => e.isDirectory() && /^Blender /i.test(e.name));
    versions.sort((a, b) => b.name.localeCompare(a.name, 'en', { numeric: true }));
    candidates.push(...versions.map((e) => path.join(foundation, e.name, 'blender.exe')));
  } catch { /* normal on non-Windows hosts, or without a Foundation install */ }
  candidates.push('C:\\Program Files (x86)\\Steam\\steamapps\\common\\Blender\\blender.exe',
    '/Applications/Blender.app/Contents/MacOS/Blender', '/usr/bin/blender', '/snap/bin/blender');
  for (const candidate of new Set(candidates)) {
    try { await runBlender(candidate, ['--version'], 10_000); return candidate; } catch { /* try the next installation */ }
  }
  return null;
}

function blenderScript(): string {
  for (const relative of ['./export_scene.py', '../../integrations/blender/export_scene.py']) {
    const file = fileURLToPath(new URL(relative, import.meta.url));
    if (fs.existsSync(file)) return file;
  }
  throw new Error('Blender conversion script export_scene.py is missing from this TopoTopo installation');
}

/** The process-wide pool of hosts created with the environment's settings (created lazily: no thread until used). */
let envPool: WorkerPool | undefined | null = null;

/**
 * The folder relative file paths resolve against, for a graph (or a session's folder) in `dir`: its project folder, the nearest
 * folder at or above `dir` with a project.json, else `dir` itself. One rule for the CLI (the graph file's folder), the
 * MCP server (its folder) and the viewer (the graph file's folder): a graph in a project's graphs/ reads
 * "inputs/ref.png" from the project's inputs/, wherever it is cooked from, and exports into the project's exports/
 * (export-targets.ts exportsFolderFor).
 */
export function packageBaseDir(dir: string): string {
  // the project lookup is the one export targets use (exports/ of the same folder): one function for both rules
  return packageFolderOf(dir) ?? path.resolve(dir);
}

export interface NodeHostOptions {
  /** the graph's (or the session's) folder: relative paths resolve against its project folder (packageBaseDir) */
  baseDir?: string;
  /**
   * Worker threads for Host.pool. Default: TOPOTOPO_WORKERS (availableParallelism() - 1 when unset), shared by every
   * host of the process; a number gives this host its own pool (0 = none).
   */
  workers?: number;
  /** further pool settings for a host with its own pool (idleMs, minElements) */
  pool?: Partial<NodePoolOptions>;
  /** Optional diagnostics for actual Blender conversions (not version probes or cache hits). */
  onBlenderRun?: (result: { executable: string; durationMs: number; output: string }) => void;
}

export function createNodeHost(opts: NodeHostOptions = {}): Host {
  const baseDir = packageBaseDir(opts.baseDir ?? process.cwd());
  const conversions = new Map<string, Promise<Uint8Array>>();
  let pool: WorkerPool | undefined;
  if (opts.workers === undefined && !opts.pool) {
    if (envPool === null) envPool = createNodePool(poolOptionsFromEnv());
    pool = envPool;
  } else pool = createNodePool({ ...poolOptionsFromEnv(), ...opts.pool, size: opts.workers ?? opts.pool?.size ?? poolOptionsFromEnv().size });
  const noiseCache = new Map<string, Noise3>();
  const curlCache = new Map<number, (x: number, y: number, z: number) => [number, number, number]>();
  const getNoise = (type: string, seed: number) => {
    const k = type + ':' + seed;
    let f = noiseCache.get(k);
    if (!f) { f = makeNoise(type, seed); noiseCache.set(k, f); }
    return f;
  };
  const hostApi = {
    rand: (vals: ArrayLike<number>) => randN(...Array.from(vals, (v) => (typeof v === 'number' ? v : Number(v) || 0))),
    noise: (type: string, seed: number, x: number, y: number, z: number) => getNoise(type, seed)(x, y, z),
    curl: (seed: number, x: number, y: number, z: number) => {
      let c = curlCache.get(seed);
      if (!c) { c = makeCurl(getNoise('perlin', seed)); curlCache.set(seed, c); }
      return c(x, y, z);
    },
  };

  // DONT_CONTEXTIFY gives the realm an ordinary global object: no interceptors, so global
  // lookups (sdSphere, add, noise …) in hot loops stay fast. Falls back on older Node.
  // microtaskMode 'afterEvaluate' gives the realm its own microtask queue, drained at the end of every
  // runInContext call and inside its timeout: continuations of awaits in script code can only run there, so
  // `await 0; while (true) {}` is stopped like a synchronous loop (see runGuardedAsync).
  const fast = (vm as any).constants?.DONT_CONTEXTIFY;
  const ctxOpts = { name: 'topotopo-scripts', microtaskMode: 'afterEvaluate' as const };
  const ctx: any = fast ? vm.createContext(fast, ctxOpts) : vm.createContext({}, ctxOpts);
  // Set up before any user code runs; afterwards the host never reads or writes a property of the realm's global
  // object, which user code can redefine (a getter or setter that never returns would run here, outside any limit).
  const realmGlobal = vm.runInContext('globalThis', ctx);
  realmGlobal.__hostApi = hostApi;
  realmGlobal.console = { log: () => {} };
  vm.runInContext(SCRIPT_REALM_SETUP, ctx);
  const realmCtl: { setJob: (f: (() => any) | undefined) => void } = vm.runInContext(REALM_CONTROL, ctx);
  const scriptCache = new Map<string, any>();
  realmPromiseProtos.add(realmGlobal.Promise.prototype);
  filterRealmRejections();
  // The job is a closure variable of the realm (set through the frozen control object), and the timed script reaches
  // it through a global const: nothing on the way can be replaced by user code.
  const runJob = new vm.Script(`${REALM_CONTROL}.run()`, { filename: 'job.js' });
  const guarded = (fn: () => any, timeoutMs: number) => {
    realmCtl.setJob(fn);
    try {
      return runJob.runInContext(ctx, { timeout: Math.max(1, timeoutMs) });
    } finally {
      realmCtl.setJob(undefined);
    }
  };
  // running any script drains the realm's microtask queue afterwards (inside the timeout)
  const drain = new vm.Script('undefined', { filename: 'drain.js' });
  // Parsed in the engine's own context, not in a realm: a SyntaxError of the script realm would format its stack (read
  // below, outside any time limit) with that realm's Error.prepareStackTrace, which user code may have replaced. Parsing
  // runs nothing, and whether a function body parses does not depend on the context.
  const checkBody = (body: string) => {
    try {
      vm.compileFunction(body, [], { filename: 'check.js' });
      return null;
    } catch (e: any) {
      if (!(e instanceof SyntaxError) && e?.name !== 'SyntaxError') throw e;
      const m = /check\.js:(\d+)/.exec(String(e.stack ?? ''));
      return { message: String(e.message), line: m ? Number(m[1]) : 1 };
    }
  };

  // "=expr" expressions get a realm of their own, created on first use (src/graph/expr.ts installs the expression
  // library there and locks the realm down). Its own microtask queue is drained inside every timed run, so an
  // expression's async continuation cannot outlive the timeout. The job slot is a lexical binding of the realm's
  // global scope, not a property of its global object; expressions cannot name it (their scope proxy claims every
  // identifier) and their Function constructors are disabled.
  let exprRealm: { ctx: any; setJob: (job: (() => void) | undefined) => void } | null = null;
  const exprCtx = () => {
    if (!exprRealm) {
      const opts = { name: 'topotopo-expressions', microtaskMode: 'afterEvaluate' as const };
      const ectx: any = fast ? vm.createContext(fast, opts) : vm.createContext({}, opts);
      const setJob = vm.runInContext('const __exprJob = { f: undefined };\n(f) => { __exprJob.f = f; }', ectx);
      realmPromiseProtos.add(vm.runInContext('Promise.prototype', ectx));
      exprRealm = { ctx: ectx, setJob };
    }
    return exprRealm;
  };
  const exprJob = new vm.Script('__exprJob.f()', { filename: 'expression-job.js' });
  const exprSandbox: ExprSandbox = {
    compile: (source) => new vm.Script(source, { filename: 'expression.js' }).runInContext(exprCtx().ctx),
    checkSyntax: (body) => checkBody(body),
    run(job, timeoutMs) {
      const r = exprCtx();
      r.setJob(job);
      try {
        exprJob.runInContext(r.ctx, { timeout: Math.max(1, timeoutMs) });
      } finally {
        r.setJob(undefined);
      }
    },
  };

  const fontDirs =
    process.platform === 'win32'
      ? [path.join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts')]
      : process.platform === 'darwin'
        ? ['/System/Library/Fonts/Supplemental', '/Library/Fonts', '/System/Library/Fonts', path.join(os.homedir(), 'Library/Fonts')]
        : ['/usr/share/fonts', '/usr/local/share/fonts', path.join(os.homedir(), '.fonts')];
  const defaults = ['arial.ttf', 'Arial.ttf', 'segoeui.ttf', 'DejaVuSans.ttf', 'LiberationSans-Regular.ttf', 'Roboto-Regular.ttf', 'NotoSans-Regular.ttf'];
  // The bundled font makes the text node deterministic across machines; system fonts only serve explicit names.
  const bundledFont = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../assets/fonts/DejaVuSans.ttf');

  const resolveIn = (dir: string) => (p: string) => (/^https?:\/\//.test(p) || path.isAbsolute(p) ? p : path.resolve(dir, p));

  const findIn = (dir: string, pred: (f: string) => boolean, depth = 0): string | null => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const e of entries) if (e.isFile() && pred(e.name)) return path.join(dir, e.name);
    if (depth < 3) for (const e of entries) if (e.isDirectory()) { const r = findIn(path.join(dir, e.name), pred, depth + 1); if (r) return r; }
    return null;
  };

  return {
    name: 'node',
    pool,
    resolvePath: resolveIn(baseDir),
    async readFile(p) {
      const rp = this.resolvePath(p);
      if (/^https?:\/\//.test(rp)) {
        const r = await fetch(rp);
        if (!r.ok) throw new Error(`fetch ${rp}: HTTP ${r.status}`);
        return new Uint8Array(await r.arrayBuffer());
      }
      return new Uint8Array(await fs.promises.readFile(rp));
    },
    fileStamp(p) {
      const rp = this.resolvePath(p);
      if (/^https?:\/\//.test(rp)) return rp;
      try { const s = fs.statSync(rp); return `${s.mtimeMs}:${s.size}`; } catch { return 'missing'; }
    },
    isDirectory(p) {
      try { return fs.statSync(this.resolvePath(p)).isDirectory(); } catch { return false; }
    },
    listDir(p) {
      const dir = this.resolvePath(p);
      return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() || (e.isSymbolicLink() && fs.statSync(path.join(dir, e.name)).isFile()))
        .map((e) => e.name).sort((a, b) => a.localeCompare(b, 'en'));
    },
    async convertFile(p, target) {
      if (target !== 'glb') throw new Error(`unsupported conversion target "${target}"`);
      const absolute = this.resolvePath(p);
      if (/^https?:\/\//.test(absolute)) throw new Error('.blend conversion needs a local file path');
      const stamp = this.fileStamp(absolute);
      if (stamp === 'missing') throw new Error(`cannot read "${absolute}": file is missing`);
      const key = createHash('sha256').update(JSON.stringify([absolute, stamp])).digest('hex');
      const cacheDir = path.resolve(baseDir, '.cache', 'blend');
      const cached = path.join(cacheDir, `${key}.glb`);
      // In-flight conversions of the same source share a process, including concurrent file nodes.
      let job = conversions.get(key);
      if (!job) {
        job = (async () => {
          try { return new Uint8Array(await fs.promises.readFile(cached)); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
          const executable = await findBlender();
          if (!executable) throw new Error('Blender was not found. Set TOPOTOPO_BLENDER to its executable, or install Blender from https://www.blender.org/download/');
          const seconds = Number(process.env.TOPOTOPO_BLENDER_TIMEOUT ?? 300);
          if (!Number.isFinite(seconds) || seconds <= 0 || seconds * 1000 > 2_147_483_647) throw new Error('TOPOTOPO_BLENDER_TIMEOUT must be a positive number of seconds (default 300)');
          await fs.promises.mkdir(cacheDir, { recursive: true });
          const tempDir = await fs.promises.mkdtemp(path.join(cacheDir, 'convert-'));
          try {
            const outputFile = path.join(tempDir, 'scene.glb');
            const start = performance.now();
            // Factory settings keep user add-ons/startup handlers out of deterministic batch conversions.
            const output = await runBlender(executable, ['--factory-startup', '--disable-autoexec', '-b', absolute, '--python', blenderScript(), '--', outputFile], Math.ceil(seconds * 1000));
            opts.onBlenderRun?.({ executable, durationMs: performance.now() - start, output });
            const bytes = new Uint8Array(await fs.promises.readFile(outputFile));
            await fs.promises.rename(outputFile, cached);
            return bytes;
          } finally { await fs.promises.rm(tempDir, { recursive: true, force: true }); }
        })();
        conversions.set(key, job);
      }
      try { return await job; } finally { if (conversions.get(key) === job) conversions.delete(key); }
    },
    filesAt(dir) {
      // every file method resolves its paths with this.resolvePath, so next to another resolvePath it reads that folder;
      // conversions are still cached under baseDir
      const { readFile, fileStamp, isDirectory, listDir, convertFile, findFont, fontCandidates } = this;
      return { resolvePath: resolveIn(path.resolve(baseDir, dir)), readFile, fileStamp, isDirectory, listDir, convertFile, findFont, fontCandidates };
    },
    compile(source) {
      if (source === 'globalThis') return realmGlobal;
      let v = scriptCache.get(source);
      if (v === undefined) {
        v = new vm.Script(source, { filename: 'snippet.js' }).runInContext(ctx);
        if (scriptCache.size > 1000) scriptCache.clear();
        scriptCache.set(source, v);
      }
      return v;
    },
    checkSyntax(body) {
      return checkBody(body);
    },
    exprSandbox,
    runGuarded(fn, timeoutMs = 30000) {
      return guarded(fn, timeoutMs);
    },
    async runGuardedAsync(fn, timeoutMs = 30000) {
      // The synchronous part and every continuation queued inside the realm run in the first timed call. A promise
      // from outside (lib.run of an async node) settles in the main queue; the realm continuation it releases then
      // waits in the realm queue until a timed drain below. `wake` (called when such a promise settles) triggers
      // the drain at once; a slow poll covers promises nobody announced. The whole run has a wall-clock deadline.
      const t0 = Date.now(), limit = Math.max(1, timeoutMs);
      let state = 0, value: any, woken = false, wakeUp: (() => void) | null = null, thenable = false;
      const wake = () => { woken = true; wakeUp?.(); };
      // Subscribing to the result runs user code too: `then` is looked up on the realm's Promise.prototype, which a
      // script can replace with a loop (or a getter that loops), so it happens inside the timed call. The handlers are
      // functions of this realm, so they still run in the main queue (also after a drain that settled the result).
      const res = guarded(() => {
        const r: any = fn(wake);
        if (r && typeof r.then === 'function') {
          thenable = true;
          r.then((v: any) => { state = 1; value = v; wake(); }, (e: any) => { state = 2; value = e; wake(); });
        }
        return r;
      }, limit);
      if (!thenable) return res;
      while (!state) {
        if (!woken) await null; // a promise already settled by the last call needs no timer
        if (!woken && !state) {
          await new Promise<void>((r) => {
            const timer = setTimeout(() => { wakeUp = null; r(); }, 15);
            wakeUp = () => { wakeUp = null; clearTimeout(timer); r(); };
          });
        }
        woken = false;
        if (state) break;
        const left = limit - (Date.now() - t0);
        if (left <= 0) throw new Error(`Script execution timed out after ${limit}ms`);
        drain.runInContext(ctx, { timeout: left });
      }
      if (state === 2) throw value;
      return value;
    },
    findFont(name) {
      if (name) {
        const rp = this.resolvePath(name);
        if (fs.existsSync(rp) && fs.statSync(rp).isFile()) return rp;
        const want = name.toLowerCase().replace(/[\s_-]/g, '');
        for (const d of fontDirs) {
          const hit = findIn(d, (f) => /\.(ttf|otf)$/i.test(f) && f.toLowerCase().replace(/[\s_-]/g, '').startsWith(want));
          if (hit) return hit;
        }
        return null;
      }
      if (fs.existsSync(bundledFont)) return bundledFont;
      for (const d of fontDirs) for (const f of defaults) {
        const hit = findIn(d, (x) => x === f);
        if (hit) return hit;
      }
      for (const d of fontDirs) {
        const hit = findIn(d, (f) => /\.ttf$/i.test(f));
        if (hit) return hit;
      }
      return null;
    },
    fontCandidates(name) {
      if (name) { const f = this.findFont(name); return f ? [f] : []; }
      const out: string[] = [];
      const push = (f: string | null) => { if (f && !out.includes(f)) out.push(f); };
      if (fs.existsSync(bundledFont)) push(bundledFont);
      for (const f of defaults) for (const d of fontDirs) push(findIn(d, (x) => x === f));
      // then any other TrueType fonts, a handful per directory, as a last resort
      for (const d of fontDirs) {
        const seen = new Set<string>();
        for (let i = 0; i < 8; i++) {
          const hit = findIn(d, (f) => /\.ttf$/i.test(f) && !seen.has(f));
          if (!hit) break;
          seen.add(path.basename(hit));
          push(hit);
        }
      }
      return out;
    },
  };
}

// Projects and their packages for scripts that cook outside the CLI and the MCP server (a world generator): open a
// project (its packages, graphs and assets in the engine's root scope), add what a graph names on first use, cook.
//   const engine = new Engine(createNodeHost({ baseDir: dir })); await engine.init();
//   const { packages } = openPackage(engine, dir); packages.addFor(graph); await engine.cook(graph);
export { openPackage } from '../open.ts';
export type { OpenOptions, Opened } from '../open.ts';
export { openPackages, PackageUses } from '../packages/registry.ts';
