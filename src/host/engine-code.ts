// The engine's identity for "would this export be made the same now" (io/source.ts engine_sha256): a SHA-256 of the
// code that cooks, not the version number, which a source checkout keeps through many engine changes. It covers the
// code tree this module runs from (src/ in a checkout, dist/ in the npm package), the WASM kernels, the bundled fonts
// and package.json: any edit to them, committed or not, gives another hash. Computed once per process, when an export
// first asks for it.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** The package root (two levels above src/host/engine-code.ts and dist/host/engine-code.js). */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
/** The code tree this module runs from: src/ or dist/. */
const CODE = fileURLToPath(new URL('..', import.meta.url));

let memo: string | undefined;

/** The running engine's code hash (engineCodeHash of its own package), computed on first use. */
export function engineSha256(): string {
  return (memo ??= engineCodeHash(ROOT, CODE));
}

/** The files an engine's code hash covers: [path relative to root with /, absolute path], in path order. */
function engineFiles(root: string, code: string): [string, string][] {
  const files: string[] = [];
  const walk = (dir: string) => {
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const n of names) {
      const p = path.join(dir, n);
      const st = fs.statSync(p, { throwIfNoEntry: false });
      if (st?.isDirectory()) walk(p);
      else if (st?.isFile()) files.push(p);
    }
  };
  walk(code);
  for (const d of ['kernels/pkg', 'kernels/pkg-simd', 'assets/fonts']) walk(path.join(root, d));
  files.push(path.join(root, 'package.json'));
  const rel = (p: string) => path.relative(root, p).split(path.sep).join('/');
  return files.map((p): [string, string] => [rel(p), p]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * SHA-256 over an engine's code: every file under `code` (src/ or dist/), kernels/pkg, kernels/pkg-simd and
 * assets/fonts of `root`, and its package.json, in path order, each as its path, size and bytes. Folders that are not
 * there are left out; links are followed.
 */
export function engineCodeHash(root: string, code: string): string {
  const h = createHash('sha256');
  for (const f of engineFiles(root, code)) {
    let bytes: Buffer;
    try { bytes = fs.readFileSync(f[1]); } catch { continue; }
    h.update(`${f[0]}\0${bytes.length}\0`);
    h.update(bytes);
  }
  return h.digest('hex');
}

/**
 * A quick stand-in for telling whether the running engine's code changed since a hash was taken: SHA-256 over the path,
 * size and modification time of the files engineCodeHash covers (a few milliseconds, where reading them takes most of a
 * second). Computed again on every call.
 */
export function engineStamp(): string {
  const h = createHash('sha256');
  for (const f of engineFiles(ROOT, CODE)) {
    const st = fs.statSync(f[1], { throwIfNoEntry: false });
    h.update(`${f[0]}\0${st?.size ?? -1}\0${st?.mtimeMs ?? -1}\0`);
  }
  return h.digest('hex');
}

/** The package root engineSha256 and engineStamp cover (where its node_modules begin). */
export const ENGINE_ROOT = ROOT;
