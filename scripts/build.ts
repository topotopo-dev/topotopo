// Build the publishable JavaScript: dist/ from src/ with tsc alone (tsconfig.build.json), no bundler.
//   node scripts/build.ts      (npm run build; npm pack / npm publish run it through prepack)
//
// Development and tests run src/*.ts directly (Node type stripping); only the npm package uses dist/, because Node
// refuses to strip types from files under node_modules. Steps: remove dist/, compile, copy the non-TypeScript files of
// src/ (the viewer page and its modules), mark the bin entry executable, then check the output: no relative import may
// still name a .ts file, and every file the code finds relative to its own module must exist relative to dist/ as well.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join('/');

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

const t0 = Date.now();
fs.rmSync(DIST, { recursive: true, force: true });

const tsc = path.join(path.dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'bin', 'tsc');
try {
  execFileSync(process.execPath, [tsc, '-p', path.join(ROOT, 'tsconfig.build.json')], { cwd: ROOT, stdio: 'inherit' });
} catch {
  console.error('build: tsc failed');
  process.exit(1);
}

// assets that live next to the modules that read them (src/viewer/index.html, the page's src/viewer/app/ modules)
let copied = 0;
for (const f of walk(SRC)) {
  if (f.endsWith('.ts')) continue;
  const to = path.join(DIST, path.relative(SRC, f));
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(f, to);
  copied++;
}
fs.copyFileSync(path.join(ROOT, 'integrations/blender/export_scene.py'), path.join(DIST, 'host/export_scene.py'));
copied++;

// bin entries (package.json "bin") must start with a shebang; npm makes them executable on install, this covers npm link
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const bins = typeof pkg.bin === 'string' ? [pkg.bin] : Object.values<string>(pkg.bin ?? {});
const problems: string[] = [];
for (const b of new Set(bins)) {
  const f = path.join(ROOT, b);
  if (!fs.existsSync(f)) { problems.push(`bin ${b} was not built`); continue; }
  // exactly this line: "node\r" (a CRLF checkout) is not found by env on Linux and macOS
  if (fs.readFileSync(f, 'utf8').split('\n')[0] !== '#!/usr/bin/env node') problems.push(`bin ${b} does not start with exactly #!/usr/bin/env node (LF)`);
  fs.chmodSync(f, 0o755);
}

// the emitted JavaScript must not import .ts files (tsc rewrites literal specifiers; a computed one would slip through)
const tsSpecifier = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|new URL\(\s*)(['"`])(\.{1,2}\/[^'"`]*\.ts)\1/g;
const js = walk(DIST).filter((f) => f.endsWith('.js'));
for (const f of js) {
  for (const m of fs.readFileSync(f, 'utf8').matchAll(tsSpecifier)) problems.push(`${rel(f)} still refers to ${m[2]}`);
}

// module-relative files (src/host/node.ts, src/wasm/kernels.ts, src/host/pool.ts, src/host/version.ts, src/viewer/server.ts)
for (const [from, target] of [
  ['host/node.js', '../../shelf/index.json'],
  ['host/node.js', '../../assets/fonts/DejaVuSans.ttf'],
  ['host/node.js', './export_scene.py'],
  ['wasm/kernels.js', '../../kernels/pkg/topotopo_kernels_bg.wasm'],
  ['wasm/kernels.js', '../../kernels/pkg/topotopo_kernels.js'],
  ['wasm/kernels.js', '../../kernels/pkg-simd/topotopo_kernels_bg.wasm'],
  ['wasm/kernels.js', '../../kernels/pkg-simd/topotopo_kernels.js'],
  ['host/pool.js', './worker.js'],
  ['host/version.js', '../../package.json'],
  ['viewer/server.js', './index.html'],
  ['viewer/server.js', './app/main.js'],
  ['viewer/server.js', './app/style.css'],
  ['viewer/server.js', './app/markers.js'],
  ['index.js', './index.d.ts'],
]) {
  const p = path.resolve(path.dirname(path.join(DIST, from)), target);
  if (!fs.existsSync(p)) problems.push(`dist/${from} looks for ${target}, which is missing (${rel(p)})`);
}

const wasmBytes = ['pkg', 'pkg-simd'].reduce((sum, dir) => {
  const file = path.join(ROOT, 'kernels', dir, 'topotopo_kernels_bg.wasm');
  return sum + (fs.existsSync(file) ? fs.statSync(file).size : 0);
}, 0);
if (wasmBytes > 2_500_000) problems.push(`combined scalar/SIMD WASM is ${wasmBytes} bytes (limit 2500000)`);

if (problems.length) {
  for (const p of problems) console.error('build: ' + p);
  process.exit(1);
}
console.log(`built dist/: ${js.length} modules, ${copied} asset file(s), bin ${[...new Set(bins)].join(', ')} (${Date.now() - t0} ms)`);
