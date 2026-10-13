// Portability: what a Windows-only test run cannot see. CI runs npm test on ubuntu-latest and windows-latest; these
// checks keep the generated, committed files and the scripts independent of the machine they run on.
//   node test/portability.ts
// - Collation: every localeCompare in scripts/ and src/ names a locale. Without one it follows the machine's locale
//   (LANG / LC_ALL on Linux and macOS, the user locale on Windows), and docs/nodes.md, NOTICE and the site come out in a
//   different order (Lithuanian sorts y after i, Czech ch after h). On Linux and macOS the generators also run under
//   such locales and must still match the committed files.
// - Case: the files package.json names (scripts, bin, main, files) exist with exactly that spelling; Windows and macOS
//   file systems ignore case, Linux does not.
// - Symlinked checkout: the scripts that are both a library and a command (gen-docs, gen-shelf, check-site) still run
//   their command when started through a symlinked path (a junction on Windows); a check that silently does nothing
//   would pass.
// - Line endings: .gitattributes keeps checkouts LF on Windows too, and the bin's shebang line is exact (a CRLF one
//   breaks `#!/usr/bin/env node` on Linux).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { ROOT } from './fixtures.ts';

let fail = 0, pass = 0;
const check = (ok: unknown, msg: string) => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
};
const run = (file: string, args: string[], env: NodeJS.ProcessEnv = process.env, cwd = ROOT) =>
  new Promise<{ code: number; out: string }>((resolve) => {
    execFile(process.execPath, [file, ...args], { cwd, env, encoding: 'utf8', timeout: 120000, maxBuffer: 64e6 }, (err: any, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: `${stdout}${stderr}` }));
  });
const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join('/');

// ------------------------------------------------------------------------------------------------ collation
const noLocale: string[] = [];
for (const f of [...walk(path.join(ROOT, 'scripts')), ...walk(path.join(ROOT, 'src'))].filter((x) => x.endsWith('.ts'))) {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    // a call with a single argument: localeCompare(x) / localeCompare(a.b(c))
    for (const m of line.matchAll(/\.localeCompare\(((?:[^(),]|\([^()]*\))*)\)/g)) noLocale.push(`${rel(f)}:${i + 1}: ${m[0]}`);
  });
}
check(!noLocale.length, `localeCompare names a locale everywhere in scripts/ and src/${noLocale.length ? `:\n  ${noLocale.join('\n  ')}` : ''}`);

if (process.platform === 'win32') console.log('skip generators under other locales: ICU ignores LANG/LC_ALL on Windows');
else {
  const jobs: Promise<void>[] = [];
  for (const locale of ['lt_LT.UTF-8', 'cs_CZ.UTF-8']) {
    const env = { ...process.env, LC_ALL: locale, LANG: locale };
    jobs.push(run(path.join(ROOT, 'scripts', 'gen-docs.ts'), ['--check'], env).then((r) =>
      check(r.code === 0, `docs/nodes.md is the same under LC_ALL=${locale} (${r.out.trim().split('\n').pop()})`)));
    jobs.push(run(path.join(ROOT, 'scripts', 'gen-notice.ts'), ['--check'], env).then((r) =>
      check(r.code === 0, `NOTICE is the same under LC_ALL=${locale} (${r.out.trim().split('\n').pop()?.slice(0, 60)}…)`)));
  }
  await Promise.all(jobs);
}

// ------------------------------------------------------------------------------------------------ exact file names
/** True when every segment of a repository-relative path exists with exactly this spelling. */
const existsExact = (p: string) => {
  let dir = ROOT;
  for (const seg of p.split('/').filter((s) => s && s !== '.')) {
    if (seg === '..') return false;
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { return false; }
    if (!names.includes(seg)) return false;
    dir = path.join(dir, seg);
  }
  return true;
};
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const named = new Set<string>();
for (const cmd of Object.values<string>(pkg.scripts ?? {})) {
  for (const m of cmd.matchAll(/\bnode\s+((?:--?[\w-]+(?:=\S+)?\s+)*)([^\s&|;]+\.(?:ts|js|mjs))/g)) named.add(m[2]);
}
const bins = typeof pkg.bin === 'string' ? [pkg.bin] : Object.values<string>(pkg.bin ?? {});
// dist/ is build output: its entries map to src/ (tsconfig.build.json rootDir src → outDir dist)
for (const b of [...bins, pkg.main, pkg.types].filter(Boolean)) named.add(String(b).replace(/^(\.\/)?dist\//, 'src/').replace(/\.d\.ts$|\.js$/, '.ts'));
for (const f of pkg.files ?? []) if (!/^!|^dist$|[*]/.test(f)) named.add(f);
const missing = [...named].filter((p) => !existsExact(p));
check(!missing.length, `${named.size} paths named by package.json exist with that exact case${missing.length ? `; not found: ${missing.join(', ')}` : ''}`);

// ------------------------------------------------------------------------------------------------ symlinked checkout
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'topotopo-port-'));
try {
  const link = path.join(tmp, 'checkout');
  fs.symlinkSync(ROOT, link, process.platform === 'win32' ? 'junction' : 'dir');
  const [site, docs, shelf] = await Promise.all([
    run(path.join(link, 'scripts', 'check-site.ts'), [path.join(tmp, 'no-site')], process.env, tmp),
    run(path.join(link, 'scripts', 'gen-docs.ts'), ['--check'], process.env, tmp),
    run(path.join(link, 'scripts', 'gen-shelf.ts'), ['--check'], process.env, tmp),
  ]);
  check(site.code === 1 && /does not exist/.test(site.out), `check-site through a symlinked path reports a missing site (exit ${site.code}: ${site.out.trim().split('\n')[0] || 'no output'})`);
  check(docs.code === 0 && /docs\/nodes\.md is up to date/.test(docs.out), `gen-docs --check through a symlinked path runs its check (${docs.out.trim() || 'no output'})`);
  check(shelf.code === 0 && /^shelf: /m.test(shelf.out), `gen-shelf --check through a symlinked path runs its check (${shelf.out.trim().split('\n').pop() || 'no output'})`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ------------------------------------------------------------------------------------------------ line endings
// Checkouts get LF on every OS through .gitattributes (git's core.autocrlf would otherwise write CRLF on Windows, and a
// CRLF shebang line makes `topotopo` fail on Linux with "env: 'node\r': No such file or directory").
const attrs = fs.existsSync(path.join(ROOT, '.gitattributes')) ? fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8') : '';
check(/^\*\s+text=auto\s+eol=lf\s*$/m.test(attrs), '.gitattributes checks text files out with LF (* text=auto eol=lf)');
const binSources = bins.map((b) => String(b).replace(/^(\.\/)?dist\//, 'src/').replace(/\.js$/, '.ts'));
for (const b of new Set(binSources)) {
  const first = fs.readFileSync(path.join(ROOT, b), 'utf8').split('\n')[0];
  check(first === '#!/usr/bin/env node', `${b} starts with exactly "#!/usr/bin/env node" (${JSON.stringify(first)})`);
}

console.log(`\nportability: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
