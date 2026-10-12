// Node.js implementation of the Host interface.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import type { Host } from './types.ts';
import { installSnippetLib } from '../core/snippet-lib.ts';
import { makeCurl, makeNoise } from '../core/noise.ts';
import type { Noise3 } from '../core/noise.ts';
import { randN } from '../core/random.ts';

export function createNodeHost(opts: { baseDir?: string } = {}): Host {
  const baseDir = opts.baseDir ?? process.cwd();
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
  const fast = (vm as any).constants?.DONT_CONTEXTIFY;
  const ctx: any = fast ? vm.createContext(fast, { name: 'polyforge-scripts' }) : vm.createContext({}, { name: 'polyforge-scripts' });
  const realmGlobal = vm.runInContext('globalThis', ctx);
  realmGlobal.__hostApi = hostApi;
  realmGlobal.console = { log: () => {} };
  vm.runInContext(`(${installSnippetLib.toString()})(globalThis, __hostApi); delete globalThis.__hostApi;`, ctx);
  const scriptCache = new Map<string, any>();

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
    runGuarded(fn, timeoutMs = 30000) {
      realmGlobal.__job = fn;
      try {
        return vm.runInContext('__job()', ctx, { timeout: Math.max(1, timeoutMs) });
      } finally {
        realmGlobal.__job = undefined;
      }
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
