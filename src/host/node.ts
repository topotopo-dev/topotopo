// Node.js implementation of the Host interface.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ExprSandbox, Host, WorkerPool } from './types.ts';
import { createNodePool, poolOptionsFromEnv } from './pool.ts';
import type { NodePoolOptions } from './pool.ts';
import { installSnippetLib } from '../core/snippet-lib.ts';
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

/**
 * The repository's asset shelf (shelf/index.json + one graph per asset). Paths relative to this module hold for the
 * sources (src/host) and for the built package (dist/host): both sit two levels below the package root.
 */
export const SHELF_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../shelf');

/** opts.shelf: shelf directory (default SHELF_DIR), or false for an engine without the shelf. */
/** The process-wide pool of hosts created with the environment's settings (created lazily: no thread until used). */
let envPool: WorkerPool | undefined | null = null;

export interface NodeHostOptions {
  baseDir?: string;
  /** shelf directory (default SHELF_DIR), or false for an engine without the shelf */
  shelf?: string | false;
  /**
   * Worker threads for Host.pool. Default: TOPOTOPO_WORKERS (availableParallelism() - 1 when unset), shared by every
   * host of the process; a number gives this host its own pool (0 = none).
   */
  workers?: number;
  /** further pool settings for a host with its own pool (idleMs, minElements) */
  pool?: Partial<NodePoolOptions>;
}

export function createNodeHost(opts: NodeHostOptions = {}): Host {
  const baseDir = opts.baseDir ?? process.cwd();
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
  const realmGlobal = vm.runInContext('globalThis', ctx);
  realmGlobal.__hostApi = hostApi;
  realmGlobal.console = { log: () => {} };
  vm.runInContext(`(${installSnippetLib.toString()})(globalThis, __hostApi); delete globalThis.__hostApi;`, ctx);
  const scriptCache = new Map<string, any>();
  realmPromiseProtos.add(realmGlobal.Promise.prototype);
  filterRealmRejections();
  const guarded = (fn: () => any, timeoutMs: number) => {
    realmGlobal.__job = fn;
    try {
      return vm.runInContext('__job()', ctx, { timeout: Math.max(1, timeoutMs) });
    } finally {
      realmGlobal.__job = undefined;
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

  const findIn = (dir: string, pred: (f: string) => boolean, depth = 0): string | null => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const e of entries) if (e.isFile() && pred(e.name)) return path.join(dir, e.name);
    if (depth < 3) for (const e of entries) if (e.isDirectory()) { const r = findIn(path.join(dir, e.name), pred, depth + 1); if (r) return r; }
    return null;
  };

  return {
    name: 'node',
    shelfPath: opts.shelf === false ? undefined : opts.shelf ?? SHELF_DIR,
    pool,
    resolvePath: (p) => (/^https?:\/\//.test(p) || path.isAbsolute(p) ? p : path.resolve(baseDir, p)),
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
        const r = fn(wake);
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
