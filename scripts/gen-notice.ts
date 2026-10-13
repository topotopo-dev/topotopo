// Generate NOTICE: every third-party licence text that ships with or is bundled into Polyforge.
//   node scripts/gen-notice.ts          writes NOTICE
//   node scripts/gen-notice.ts --check  exits 1 when NOTICE is stale (part of npm test)
//
// Sources
// - npm: the production dependency tree as recorded in package-lock.json (every entry outside the dev tree), licence
//   texts read from the installed packages (LICENSE* / LICENCE* / COPYING*), plus EXTRA_TEXTS for packages whose
//   tarball ships no licence file.
// - Rust: the crates compiled into the WebAssembly kernels (kernels/pkg), from `cargo metadata` for
//   wasm32-unknown-unknown (each crate's license field), with the licence files of each crate's source directory in
//   the cargo registry; a crate without one gets its SPDX expression and a note.
// - Bundled assets that are not packages (BUNDLED: assets/fonts).
//
// Same NOTICE on every platform (the rule):
// - The package list comes from package-lock.json, never from what npm happened to install on this machine.
// - Optional packages (lock entries marked optional/devOptional: the per-platform builds such as @img/sharp-<os>-<cpu>,
//   @img/sharp-libvips-<os>-<cpu> and their own dependencies) are listed for EVERY platform with the version and the
//   licence recorded in package-lock.json, and their licence texts are not reproduced: npm installs only the ones that
//   match the machine, so reading their files would make NOTICE depend on the platform. Each line names its npm page.
// - Every other entry must be installed with the locked version (npm ci); otherwise the script stops instead of
//   writing a different file.
// - The Rust section records a fingerprint of kernels/Cargo.lock. --check regenerates it with `cargo metadata
//   --offline` when cargo and the crate sources are present (identical output on every OS: the texts come from the
//   crate packages); where they are not (CI, machines without Rust; npm test needs no Rust) it keeps the committed
//   section if the fingerprint still matches Cargo.lock, and fails if it does not. Writing (npm run notice) runs
//   cargo metadata, which fetches missing crates; without cargo it keeps the committed section on a matching
//   fingerprint and stops otherwise.
//
// Licence policy (CONTRIBUTING.md, AGENTS.md): what ships is MIT, Apache-2.0, BSD, ISC or MPL-2.0; build-time-only
// tooling (proc-macro crates, build scripts) may also use other permissive licences (Unicode-3.0, Zlib, CC0); no GPL
// or AGPL anywhere. Writing NOTICE lists every package whose licence falls outside that so it gets looked at.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KERNELS = path.join(ROOT, 'kernels');
const TARGET = path.join(ROOT, 'NOTICE');
const check = process.argv.includes('--check');
const RUST_HEADING = 'Rust crates compiled into the WebAssembly kernels (kernels/pkg)';
const SEP = '='.repeat(78);

/** Licence texts for packages whose published tarball has no licence file. Keep in sync with package.json. */
const EXTRA_TEXTS: Record<string, { licence: string; homepage: string; text: string }> = {
  'xatlas-wasm': {
    licence: 'MIT',
    homepage: 'https://github.com/jpcy/xatlas',
    text: `MIT License

Copyright (c) 2018-2020 Jonathan Young

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

(xatlas-wasm is a WebAssembly build of xatlas; the npm tarball ships no licence file, so the upstream text is
reproduced here.)`,
  },
};

/** Bundled assets that are not npm packages. */
const BUNDLED: { name: string; licence: string; homepage: string; file: string }[] = [
  { name: 'DejaVu Sans (assets/fonts/DejaVuSans.ttf)', licence: 'Bitstream Vera Fonts licence + public domain (DejaVu changes)', homepage: 'https://dejavu-fonts.github.io/', file: 'assets/fonts/LICENSE_DEJAVU' },
];

interface Dep { name: string; version: string; licence: string; homepage?: string; text: string }
interface OptionalDep { name: string; version: string; licence: string; platform: string }
interface Crate { name: string; version: string; licence: string; repository?: string; buildOnly: boolean; texts: { file: string; text: string }[] }

const lf = (s: string) => s.replace(/\r\n?/g, '\n');
function stop(msg: string): never { console.error(msg); process.exit(1); }

function findLicenceFile(dir: string): string | null {
  let entries: string[];
  try { entries = fs.readdirSync(dir).sort(); } catch { return null; } // sorted: directory order differs by file system
  const pick = entries.find((f) => /^(LICENSE|LICENCE|COPYING)(\.|$)/i.test(f) && !/\.(js|ts|json|mjs|cjs)$/i.test(f));
  return pick ? path.join(dir, pick) : null;
}

/** The checkout that holds node_modules: this one, or the main checkout when running inside a git worktree. */
function installRoot(): string {
  if (fs.existsSync(path.join(ROOT, 'node_modules'))) return ROOT;
  try {
    const common = execSync('git rev-parse --git-common-dir', { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const main = path.resolve(ROOT, common, '..');
    if (fs.existsSync(path.join(main, 'node_modules'))) return main;
  } catch { /* not a worktree */ }
  return ROOT;
}

/** npm packages outside the dev tree, from package-lock.json: those installed everywhere, and the optional ones. */
function npmPackages(): { deps: Dep[]; optional: OptionalDep[] } {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  if (!lock.packages) stop('package-lock.json has no "packages" map (lockfileVersion 2 or later is needed)');
  const base = installRoot();
  const deps = new Map<string, Dep>();
  const optional = new Map<string, OptionalDep>();
  const unsynced: string[] = [];
  for (const [key, e] of Object.entries<any>(lock.packages)) {
    if (!key || e.dev || e.link) continue; // the project itself, dev-only packages, workspace links
    const name: string = e.name ?? key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const version = String(e.version ?? '');
    const id = `${name}@${version}`;
    if (e.optional || e.devOptional) {
      const platform = [e.os, e.cpu, e.libc].filter((v) => Array.isArray(v) && v.length).map((v: string[]) => v.join('/')).join(' ');
      optional.set(id, { name, version, licence: e.license ?? 'UNKNOWN', platform });
      continue;
    }
    if (deps.has(id)) continue;
    const dir = path.join(base, key);
    let pkg: any;
    try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { unsynced.push(`${id} is not installed`); continue; }
    if (pkg.version !== version) { unsynced.push(`${id} is installed as ${pkg.version}`); continue; }
    const licence = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? (Array.isArray(pkg.licenses) ? pkg.licenses.map((l: any) => l.type).join(' OR ') : 'UNKNOWN');
    const file = findLicenceFile(dir);
    let text = file ? lf(fs.readFileSync(file, 'utf8')).trim() : '';
    const extra = EXTRA_TEXTS[name];
    if (!text && extra) text = extra.text.trim();
    if (!text) text = `(no licence file in the package; declared licence: ${licence})`;
    const homepage = typeof pkg.homepage === 'string' ? pkg.homepage : typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
    deps.set(id, { name, version, licence, homepage: extra?.homepage ?? homepage, text });
  }
  if (unsynced.length) stop(`node_modules (${base}) does not match package-lock.json; run npm ci:\n  ${unsynced.join('\n  ')}`);
  const byId = <T extends { name: string; version: string }>(a: T, b: T) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version);
  return { deps: [...deps.values()].sort(byId), optional: [...optional.values()].sort(byId) };
}

/** Short fingerprint of kernels/Cargo.lock (line endings normalised), recorded in the Rust section. */
function cargoLockFingerprint(): string {
  return crypto.createHash('sha256').update(lf(fs.readFileSync(path.join(KERNELS, 'Cargo.lock'), 'utf8'))).digest('hex').slice(0, 16);
}

/**
 * Crates of the kernels for wasm32 (cargo metadata), or the reason they could not be read. Shipped: reachable from
 * the kernels crate through normal dependencies without passing a proc-macro crate. Build-time: the rest of what the
 * build compiles (proc macros, build-dependencies and their dependencies). Dev-dependencies are left out.
 */
function cargoCrates(offline: boolean): Crate[] | string {
  let out: string;
  try {
    out = execFileSync('cargo', ['metadata', '--format-version', '1', '--manifest-path', path.join(KERNELS, 'Cargo.toml'),
      '--filter-platform', 'wasm32-unknown-unknown', '--locked', ...(offline ? ['--offline'] : [])],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64e6 });
  } catch (e: any) {
    const why = e?.code === 'ENOENT' ? 'cargo is not installed' : String(e?.stderr ?? e?.message ?? e).trim().split('\n').pop();
    return `cargo metadata failed: ${why}`;
  }
  const meta = JSON.parse(out);
  const pkgs = new Map<string, any>(meta.packages.map((p: any) => [p.id, p]));
  const nodes = new Map<string, any>(meta.resolve.nodes.map((n: any) => [n.id, n]));
  const root: string = meta.resolve.root;
  const procMacro = (id: string) => pkgs.get(id).targets.some((t: any) => t.kind.includes('proc-macro'));
  const reach = (kinds: (string | null)[], follow: (id: string) => boolean) => {
    const seen = new Set<string>();
    const stack = [root];
    while (stack.length) {
      for (const d of nodes.get(stack.pop()!)?.deps ?? []) {
        if (d.pkg === root || seen.has(d.pkg) || !d.dep_kinds.some((k: any) => kinds.includes(k.kind)) || !follow(d.pkg)) continue;
        seen.add(d.pkg);
        stack.push(d.pkg);
      }
    }
    return seen;
  };
  const shipped = reach([null], (id) => !procMacro(id));
  const all = reach([null, 'build'], () => true);
  const crates: Crate[] = [];
  for (const id of all) {
    const p = pkgs.get(id);
    const dir = path.dirname(p.manifest_path);
    const files = fs.readdirSync(dir).filter((f) => /^(LICEN[CS]E|COPYING|UNLICENSE)([-._].*)?$/i.test(f) && !/\.(rs|toml|json|js|ts|py|sh)$/i.test(f));
    if (p.license_file && !files.includes(p.license_file)) files.push(p.license_file);
    files.sort();
    crates.push({
      name: p.name, version: p.version, licence: p.license ?? (p.license_file ? `see ${p.license_file}` : 'UNKNOWN'),
      repository: p.repository ?? undefined, buildOnly: !shipped.has(id),
      texts: files.map((f: string) => ({ file: f, text: lf(fs.readFileSync(path.join(dir, f), 'utf8')).trim() })),
    });
  }
  return crates.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** The Rust section: summary lines, then each distinct licence text once with the crates that carry it. */
function renderRust(crates: Crate[], fingerprint: string): string {
  const out: string[] = [];
  out.push(RUST_HEADING, '-'.repeat(RUST_HEADING.length));
  out.push(`Resolved by cargo metadata for wasm32-unknown-unknown from kernels/Cargo.lock (sha256 ${fingerprint}).`);
  out.push('"build-time" marks proc-macro crates and build-script dependencies: they run while the module is compiled and');
  out.push('are not linked into it. Identical licence texts are printed once, followed by the crates that carry them.');
  out.push('');
  for (const c of crates) out.push(`${c.name}@${c.version}: ${c.licence}${c.repository ? ` (${c.repository})` : ''}${c.buildOnly ? ' build-time' : ''}`);
  out.push('');
  const groups = new Map<string, string[]>();
  for (const c of crates) {
    if (!c.texts.length) {
      out.push(SEP, `${c.name}@${c.version}`, `Licence: ${c.licence}`, '', `(no licence file in the crate's source package; its licence is the SPDX expression above)`, '');
      continue;
    }
    for (const t of c.texts) {
      const who = `${c.name}@${c.version} ${t.file}`;
      const g = groups.get(t.text);
      if (g) g.push(who); else groups.set(t.text, [who]);
    }
  }
  for (const [text, who] of groups) {
    const lines: string[] = [];
    let line = 'Crates:';
    for (const w of who) {
      if (line.length + w.length + 2 > 118) { lines.push(line + ','); line = '  ' + w; } else line += (line === 'Crates:' ? ' ' : ', ') + w;
    }
    lines.push(line);
    out.push(SEP, ...lines, '', text, '');
  }
  return out.join('\n') + '\n';
}

/** The committed Rust section (the end of NOTICE) and its Cargo.lock fingerprint. */
function committedRust(): { text: string; fingerprint: string } | null {
  if (!fs.existsSync(TARGET)) return null;
  const cur = lf(fs.readFileSync(TARGET, 'utf8'));
  const at = cur.indexOf('\n' + RUST_HEADING + '\n');
  if (at < 0) return null;
  const text = cur.slice(at + 1);
  const m = /kernels\/Cargo\.lock \(sha256 ([0-9a-f]{16})\)/.exec(text);
  return m ? { text, fingerprint: m[1] } : null;
}

function render(deps: Dep[], optional: OptionalDep[], rust: string): string {
  const out: string[] = [];
  out.push('Polyforge');
  out.push('Copyright (c) 2026 faxcorp');
  out.push('');
  out.push('This product is licensed under the Apache License, Version 2.0 (see LICENSE).');
  out.push('It includes, bundles or depends on the third-party components below. Each component keeps its own licence;');
  out.push('the full texts follow. This file is generated by scripts/gen-notice.ts; run "npm run notice" after changing');
  out.push('dependencies or bundled assets.');
  out.push('');
  out.push('Summary');
  out.push('-------');
  for (const b of BUNDLED) out.push(`${b.name}: ${b.licence} (${b.homepage})`);
  for (const d of deps) out.push(`${d.name}@${d.version}: ${d.licence}${d.homepage ? ` (${d.homepage})` : ''}`);
  out.push('');
  out.push('Optional npm packages: npm installs only those matching the platform (os, cpu, libc in brackets). They are');
  out.push('listed for every platform with the licence recorded in package-lock.json; their licence texts are in each');
  out.push('package and are not reproduced here, so that this file is the same on every platform.');
  for (const o of optional) out.push(`${o.name}@${o.version}: ${o.licence}${o.platform ? ` [${o.platform}]` : ''} (https://www.npmjs.com/package/${o.name})`);
  out.push('');
  out.push(`Rust crates in the WebAssembly kernels (kernels/pkg): see "${RUST_HEADING}" at the end.`);
  out.push('');
  out.push('Licence texts');
  out.push('-------------');
  for (const b of BUNDLED) {
    out.push(SEP, `${b.name}`, `Licence: ${b.licence}`, `Source: ${b.homepage}`, '', lf(fs.readFileSync(path.join(ROOT, b.file), 'utf8')).trim(), '');
  }
  for (const d of deps) {
    out.push(SEP, `${d.name}@${d.version}`, `Licence: ${d.licence}`, ...(d.homepage ? [`Source: ${d.homepage}`] : []), '', d.text, '');
  }
  return out.join('\n') + '\n' + rust;
}

/** SPDX expression → true when some alternative uses only allowed licences ("A OR B", "A AND B", parentheses). */
function spdxAllowed(expr: string, ok: (id: string) => boolean): boolean {
  const toks = expr.replace(/[()]/g, ' $& ').replace(/\//g, ' OR ').split(/\s+/).filter(Boolean);
  let i = 0;
  const primary = (): boolean => {
    const t = toks[i++];
    if (t === '(') { const v = any(); i++; return v; }
    if (toks[i] === 'WITH') i += 2;
    return ok(String(t).replace(/\+$/, ''));
  };
  const all = (): boolean => { let v = primary(); while (toks[i] === 'AND') { i++; v = primary() && v; } return v; };
  const any = (): boolean => { let v = all(); while (toks[i] === 'OR') { i++; v = all() || v; } return v; };
  return any();
}
const SHIPS = (id: string) => /^(MIT|MIT-0|Apache-2\.0|0BSD|BSD-[1-4]-Clause|ISC|MPL-2\.0)$/.test(id);
const BUILD_TIME = (id: string) => SHIPS(id) || /^(Unicode-3\.0|Unicode-DFS-2016|Zlib|CC0-1\.0|Unlicense)$/.test(id);

// ---------------------------------------------------------------------------------------------------------------
const { deps, optional } = npmPackages();
const fingerprint = cargoLockFingerprint();
const crates = cargoCrates(check);
let rust: string;
let rustNote: string;
if (typeof crates !== 'string') {
  rust = renderRust(crates, fingerprint);
  rustNote = `${crates.length} Rust crates`;
} else {
  const kept = committedRust();
  if (!kept) stop(`NOTICE has no Rust crate section and ${crates}. Run npm run notice with Rust (cargo) installed.`);
  if (kept.fingerprint !== fingerprint) {
    stop(`kernels/Cargo.lock changed since NOTICE was generated (${kept.fingerprint} → ${fingerprint}) and ${crates}.\n` +
      'Run npm run notice where cargo can resolve the kernels crate (it fetches the crate sources).');
  }
  rust = kept.text;
  rustNote = `Rust crates kept from NOTICE: Cargo.lock unchanged; ${crates}`;
}
const text = render(deps, optional, rust);
const summary = `${deps.length} packages + ${optional.length} optional + ${BUNDLED.length} bundled assets, ${rustNote}`;
if (check) {
  const current = fs.existsSync(TARGET) ? lf(fs.readFileSync(TARGET, 'utf8')) : '';
  if (current !== text) stop('NOTICE is stale: run npm run notice');
  console.log(`NOTICE is up to date (${summary})`);
} else {
  fs.writeFileSync(TARGET, text);
  console.log(`wrote NOTICE: ${summary}, ${text.length} bytes`);
  const unknown = deps.filter((d) => d.licence === 'UNKNOWN' || d.text.startsWith('(no licence file'));
  if (unknown.length) console.log('check these (no licence text): ' + unknown.map((d) => d.name).join(', '));
  const outside = [
    ...[...deps, ...optional].filter((d) => !spdxAllowed(d.licence, SHIPS)).map((d) => `${d.name}@${d.version} (${d.licence})`),
    ...(typeof crates === 'string' ? [] : crates.filter((c) => !spdxAllowed(c.licence, c.buildOnly ? BUILD_TIME : SHIPS))
      .map((c) => `${c.name}@${c.version} (${c.licence}${c.buildOnly ? ', build-time' : ''})`)),
  ];
  if (outside.length) console.log(`outside the licence allow-list in CONTRIBUTING.md, review: ${outside.join(', ')}`);
}
