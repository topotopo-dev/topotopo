// Generate NOTICE: every third-party licence text that ships with or is bundled into Polyforge.
//   node scripts/gen-notice.ts          writes NOTICE
//   node scripts/gen-notice.ts --check  exits 1 when NOTICE is stale
//
// Sources: the production dependency tree (npm ls --prod), read from node_modules (LICENSE* / LICENCE* / COPYING*),
// plus bundled assets that are not npm packages (assets/fonts) and packages whose tarball ships no licence file
// (listed in EXTRA_TEXTS with the upstream text).
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const check = process.argv.includes('--check');

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

function findLicenceFile(dir: string): string | null {
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return null; }
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

function prodTree(): Record<string, any> {
  const json = execSync('npm ls --prod --all --json --long=false', { cwd: installRoot(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64e6 });
  return JSON.parse(json);
}

function collect(): Dep[] {
  const tree = prodTree();
  const seen = new Map<string, Dep>();
  const walk = (deps: Record<string, any> | undefined) => {
    for (const [name, info] of Object.entries(deps ?? {})) {
      if (!info || info.missing || (info as any).extraneous) continue;
      const version = String(info.version ?? '');
      if (!version) continue; // optional dependency that is not installed on this platform
      const key = `${name}@${version}`;
      if (!seen.has(key)) {
        const dir = (info as any).path ?? path.join(installRoot(), 'node_modules', name);
        let pkg: any = {};
        try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { /* keep going */ }
        const licence = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? (Array.isArray(pkg.licenses) ? pkg.licenses.map((l: any) => l.type).join(' OR ') : 'UNKNOWN');
        const lf = findLicenceFile(dir);
        let text = lf ? fs.readFileSync(lf, 'utf8').replace(/\r\n/g, '\n').trim() : '';
        const extra = EXTRA_TEXTS[name];
        if (!text && extra) text = extra.text.trim();
        if (!text) text = `(no licence file in the package; declared licence: ${licence})`;
        const homepage = typeof pkg.homepage === 'string' ? pkg.homepage : typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
        seen.set(key, { name, version, licence, homepage: extra?.homepage ?? homepage, text });
      }
      walk((info as any).dependencies);
    }
  };
  walk(tree.dependencies);
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

function render(deps: Dep[]): string {
  const out: string[] = [];
  out.push('Polyforge');
  out.push('Copyright (c) 2026 faxlab');
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
  out.push('Licence texts');
  out.push('-------------');
  const sep = '='.repeat(78);
  for (const b of BUNDLED) {
    out.push(sep, `${b.name}`, `Licence: ${b.licence}`, `Source: ${b.homepage}`, '', fs.readFileSync(path.join(ROOT, b.file), 'utf8').replace(/\r\n/g, '\n').trim(), '');
  }
  for (const d of deps) {
    out.push(sep, `${d.name}@${d.version}`, `Licence: ${d.licence}`, ...(d.homepage ? [`Source: ${d.homepage}`] : []), '', d.text, '');
  }
  return out.join('\n') + '\n';
}

const deps = collect();
const text = render(deps);
const target = path.join(ROOT, 'NOTICE');
if (check) {
  const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n') : '';
  if (current !== text) { console.error('NOTICE is stale: run npm run notice'); process.exit(1); }
  console.log(`NOTICE is up to date (${deps.length} packages + ${BUNDLED.length} bundled assets)`);
} else {
  fs.writeFileSync(target, text);
  console.log(`wrote NOTICE: ${deps.length} packages + ${BUNDLED.length} bundled assets, ${text.length} bytes`);
  const unknown = deps.filter((d) => d.licence === 'UNKNOWN' || d.text.startsWith('(no licence file'));
  if (unknown.length) console.log('check these: ' + unknown.map((d) => d.name).join(', '));
}
