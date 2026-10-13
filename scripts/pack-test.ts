// Pack test: build the npm tarball, install it into an empty project in a temp directory and use it the way a user
// would. Not part of npm test (it builds, packs and installs: about a minute); run it before a release.
//   node scripts/pack-test.ts [--keep]      (npm run pack:test; --keep leaves the temp directory for inspection)
//
// Checks
// - npm pack (prepack builds dist/): required files are in the tarball, nothing from src/, test/, examples/, out/,
//   shelf/thumbs or the Rust sources is.
// - The bin from the installed package: `npm exec --no -- topotopo --help`, and cooking an example graph copied into the
//   temp project with a PNG render and a GLB export (examples/skeleton_roofs.json: straight_skeleton runs in the WASM
//   kernels loaded from the installed kernels/pkg, and the house walls come from the installed shelf).
// - The library: `import 'topotopo'` (exports map) and its types (tsc on a consumer file), the shelf, the bundled
//   font, the worker pool entry (dist/host/worker.js) and the SDF grid kernels, all from the installed location.
// - The MCP server over stdio as a client starts it (`npm exec --no -- topotopo mcp --workspace …`, which is what
//   `npx -y topotopo mcp` runs once the package is installed): catalog, a build that uses sdf_grid, and the preview
//   page with three.js served from the installed dependencies.
// The bin always runs through `npm exec --no --`: it never downloads, so only the tarball under test can answer.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.argv.includes('--keep');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const NAME: string = pkg.name;
const BIN = Object.keys(pkg.bin)[0];

let failures = 0;
const check = (cond: unknown, msg: string) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failures++; };
const t0 = Date.now();
const step = (msg: string) => console.log(`\n== ${msg} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
/** a shell command (npm and npx are .cmd scripts on Windows); returns stdout, throws with stdout + stderr on failure */
const sh = (cmd: string, cwd: string, env: NodeJS.ProcessEnv = process.env): string => {
  try {
    return execSync(cmd, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256e6 });
  } catch (e: any) {
    throw new Error(`${cmd} failed (exit ${e.status}):\n${e.stdout ?? ''}\n${e.stderr ?? ''}`);
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `${NAME}-pack-`));
const app = path.join(tmp, 'app');
fs.mkdirSync(app);
console.log(`temp directory ${tmp}`);

try {
  // ------------------------------------------------------------------------------------------------ the tarball
  step('npm pack (prepack builds dist/)');
  const packOut = sh(`npm pack --json --pack-destination "${tmp}"`, ROOT);
  // lifecycle output (the build log) precedes the JSON on stdout
  const info = JSON.parse(packOut.slice(packOut.search(/^\[/m)))[0];
  const tarball = path.join(tmp, info.filename);
  const files: string[] = info.files.map((f: any) => f.path);
  console.log(`${info.filename}: ${files.length} files, ${(info.size / 1e6).toFixed(2)} MB packed, ${(info.unpackedSize / 1e6).toFixed(2)} MB unpacked`);
  const required = [
    'package.json', 'README.md', 'LICENSE', 'NOTICE',
    'dist/index.js', 'dist/index.d.ts', 'dist/cli.js', 'dist/mcp/server.js', 'dist/host/node.js', 'dist/host/pool.js',
    'dist/host/worker.js', 'dist/wasm/kernels.js', 'dist/viewer/server.js', 'dist/viewer/index.html',
    'shelf/index.json', 'assets/fonts/DejaVuSans.ttf', 'assets/fonts/LICENSE_DEJAVU',
    'kernels/pkg/topotopo_kernels.js', 'kernels/pkg/topotopo_kernels_bg.wasm', 'kernels/pkg/LICENSE',
  ];
  const missing = required.filter((f) => !files.includes(f));
  check(!missing.length, `tarball has the runtime files${missing.length ? `; missing: ${missing.join(', ')}` : ''}`);
  const stray = files.filter((f) => /^(src|test|examples|out|bench|scripts|docs|workspace|tmp|kernels\/(src|target|tests|benches)|shelf\/thumbs)\//.test(f) ||
    (/\.ts$/.test(f) && !/\.d\.ts$/.test(f)) || /\.tgz$/.test(f));
  check(!stray.length, `tarball has no sources, tests, examples or build output${stray.length ? `; found: ${stray.slice(0, 10).join(', ')}` : ''}`);
  check(files.filter((f) => f.startsWith('shelf/') && f.endsWith('.json')).length === fs.readdirSync(path.join(ROOT, 'shelf')).filter((f) => f.endsWith('.json')).length,
    'tarball has every shelf asset');

  // ------------------------------------------------------------------------------------------------ install
  step('npm install <tarball> into an empty project');
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: `${NAME}-pack-test`, private: true, type: 'module' }, null, 2));
  sh(`npm install --no-audit --no-fund --prefer-offline "${tarball}"`, app);
  const installed = path.join(app, 'node_modules', NAME);
  const inPkg = (p: unknown) => typeof p === 'string' && path.resolve(p).toLowerCase().startsWith(installed.toLowerCase() + path.sep);
  check(fs.existsSync(path.join(installed, 'dist', 'cli.js')) && !fs.existsSync(path.join(installed, 'src')), `installed node_modules/${NAME} (dist/, no src/)`);
  const shim = path.join(app, 'node_modules', '.bin', process.platform === 'win32' ? `${BIN}.cmd` : BIN);
  check(fs.existsSync(shim), `bin shim node_modules/.bin/${path.basename(shim)}`);
  if (process.platform !== 'win32') check((fs.statSync(path.join(installed, 'dist', 'cli.js')).mode & 0o111) !== 0, 'dist/cli.js is executable');

  // ------------------------------------------------------------------------------------------------ CLI
  step(`CLI: npm exec --no -- ${BIN}`);
  const help = sh(`npm exec --no -- ${BIN} --help`, app);
  check(help.startsWith(`usage: ${BIN} `) && help.includes(`${BIN} mcp`), `--help prints the usage (${help.split('\n')[0].slice(0, 60)}…)`);
  fs.copyFileSync(path.join(ROOT, 'examples', 'skeleton_roofs.json'), path.join(app, 'roofs.json'));
  const cook = sh(`npm exec --no -- ${BIN} roofs.json --render roofs.png --export roofs.glb`, app);
  const png = path.join(app, 'roofs.png');
  const pngOk = fs.existsSync(png) && fs.readFileSync(png).subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && fs.statSync(png).size > 20000;
  check(/cooked roofs\.json/.test(cook) && pngOk, `cooked examples/skeleton_roofs.json (straight_skeleton + shelf) and rendered roofs.png (${pngOk ? fs.statSync(png).size : 0} bytes)`);
  check(fs.existsSync(path.join(app, 'roofs.glb')) && fs.readFileSync(path.join(app, 'roofs.glb')).subarray(0, 4).toString() === 'glTF', 'exported roofs.glb');
  console.log(cook.split('\n').filter((l) => /^(cooked|geometry|rendered|exported)/.test(l)).join('\n'));

  // ------------------------------------------------------------------------------------------------ library
  step(`library: import '${NAME}' from the installed package`);
  fs.writeFileSync(path.join(app, 'lib.mjs'), `
import { Engine, allNodeDefs } from '${NAME}';
import meta from '${NAME}/package.json' with { type: 'json' };
import { createNodeHost, SHELF_DIR } from './node_modules/${NAME}/dist/host/node.js';
import { createNodePool } from './node_modules/${NAME}/dist/host/pool.js';
import { kernelsWasmURL, getLoadedKernels } from './node_modules/${NAME}/dist/wasm/kernels.js';
import { fileURLToPath } from 'node:url';
const out = { version: meta.version, nodes: allNodeDefs().length, shelf: SHELF_DIR, wasm: fileURLToPath(kernelsWasmURL) };
const host = createNodeHost({ workers: 0 });
out.font = host.findFont();
const pool = createNodePool({ size: 1 });
const r = await pool.run({ kernel: 'selftest.scale', args: { factor: 2 }, range: [0, 3], arrays: { x: Float64Array.of(1, 2, 3) } });
out.poolResult = Array.from(r.arrays.x).join(',');
await pool.close();
const engine = new Engine(createNodeHost({ workers: 2, pool: { minElements: 1 } }));
await engine.init();
const wr = await engine.cook({ nodes: { g: { type: 'grid' }, w: { type: 'wrangle', in: ['g'], params: { code: '@P.y += sin(@P.x * 3) * 0.1;' } } }, output: 'w' });
out.wrangle = wr.ok ? wr.geo.numPoints : wr.errors.map((e) => e.message).join('; ');
out.poolTasks = engine.host.pool.stats().tasks;
const sdf = await engine.cook({ nodes: { b: { type: 'box' }, g: { type: 'sdf_grid', in: ['b'], params: { voxel_size: 0.1 } }, m: { type: 'grid_to_mesh', in: ['g'] } }, output: 'm' });
out.sdf = sdf.ok ? sdf.geo.numPrims : sdf.errors.map((e) => e.message).join('; ');
out.kernelsLoaded = !!getLoadedKernels();
await engine.host.pool.close();
console.log(JSON.stringify(out));
`);
  const lib = JSON.parse(sh('node lib.mjs', app).trim().split('\n').pop()!);
  check(lib.version === pkg.version && lib.nodes >= 200, `import '${NAME}': ${lib.nodes} node types, ${NAME}/package.json ${lib.version}`);
  check(inPkg(lib.shelf) && fs.existsSync(path.join(lib.shelf, 'index.json')), `shelf from the installed package (${path.relative(app, lib.shelf)})`);
  check(inPkg(lib.font) && path.basename(lib.font) === 'DejaVuSans.ttf', `bundled font from the installed package (${lib.font && path.relative(app, lib.font)})`);
  check(inPkg(lib.wasm) && fs.existsSync(lib.wasm), `kernel WASM from the installed package (${path.relative(app, lib.wasm)})`);
  check(lib.poolResult === '2,4,6', `worker pool runs dist/host/worker.js (selftest ${lib.poolResult})`);
  check(typeof lib.wrangle === 'number' && lib.poolTasks > 0, `wrangle on the pool: ${lib.wrangle} points, ${lib.poolTasks} pool task(s)`);
  check(typeof lib.sdf === 'number' && lib.sdf > 0 && lib.kernelsLoaded, `sdf_grid + grid_to_mesh in the WASM kernels: ${lib.sdf} prims`);

  step('types: tsc on a consumer file');
  fs.writeFileSync(path.join(app, 'check.ts'), [
    `import { Engine, Geometry, allNodeDefs } from '${NAME}';`,
    `import type { GraphSpec, CookReport } from '${NAME}';`,
    'export const count: number = allNodeDefs().length;',
    '// @ts-expect-error allNodeDefs() returns NodeDef[]: this line only type-checks wrong when the types did not resolve',
    'export const wrong: string = allNodeDefs();',
    'export async function run(e: Engine, g: GraphSpec): Promise<Geometry | null> { const r: CookReport = await e.cook(g); return r.geo; }',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(app, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, skipLibCheck: true, types: [] },
    files: ['check.ts'],
  }, null, 2));
  const tsc = path.join(path.dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'bin', 'tsc');
  let tscOut = '';
  try { execFileSync(process.execPath, [tsc, '-p', path.join(app, 'tsconfig.json')], { cwd: app, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e: any) { tscOut = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim(); }
  check(!tscOut, `the package's .d.ts files type a consumer (exports "types")${tscOut ? `:\n${tscOut}` : ''}`);

  // ------------------------------------------------------------------------------------------------ MCP
  step(`MCP server: npm exec --no -- ${BIN} mcp`);
  const ws = path.join(tmp, 'workspace');
  const transport = new StdioClientTransport({
    // npm exec --no: the local bin or nothing (npx in a non-TTY would fall back to downloading a same-named package)
    command: 'npm', args: ['exec', '--no', '--', BIN, 'mcp', '--workspace', ws], cwd: app,
    env: { ...process.env, TOPOTOPO_PORT: '0' } as Record<string, string>, stderr: 'pipe',
  });
  let serverLog = '';
  transport.stderr?.on('data', (d) => { serverLog += String(d); });
  const client = new Client({ name: `${NAME}-pack-test`, version: '0.0.1' });
  try {
    await client.connect(transport);
    const call = async (name: string, args: any) => {
      const r: any = await client.callTool({ name, arguments: args });
      return { txt: r.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n'), isError: !!r.isError };
    };
    check(client.getServerVersion()?.name === NAME, `server ${client.getServerVersion()?.name} ${client.getServerVersion()?.version}`);
    const cat = await call('catalog', {});
    check(!cat.isError && cat.txt.includes('straight_skeleton') && cat.txt.includes('[shelf]'), 'catalog lists the nodes and the installed shelf');
    const b = await call('build', { graph: { nodes: { b: { type: 'box' }, g: { type: 'sdf_grid', in: ['b'], params: { voxel_size: 0.1 } }, m: { type: 'grid_to_mesh', in: ['g'] } } } });
    check(!b.isError && b.txt.includes('✓'), `build with sdf_grid (WASM kernels in the server): ${b.txt.split('\n')[0].slice(0, 80)}`);
    const pv = await call('preview', {});
    const url = /https?:\/\/[^\s]+\//.exec(pv.txt)?.[0];
    const page = url ? await fetch(url).then((r) => (r.ok ? r.text() : '')) : '';
    const three = url ? await fetch(url + 'vendor/three/build/three.module.js').then((r) => r.status) : 0;
    check(!!url && page.includes('<html') && three === 200, `preview page ${url} (index.html from dist/viewer, three.js ${three})`);
  } finally {
    await client.close().catch(() => {});
  }
  check(/ready \(stdio\)/.test(serverLog) && /\d+ shelf assets/.test(serverLog), `server log: ${serverLog.split('\n').find((l) => l.includes('workspace'))?.trim()}`);
} catch (e: any) {
  failures++;
  console.log(`FAIL ${e?.stack ?? e}`);
}

console.log(`\n${failures ? `${failures} FAILED` : 'pack test passed'} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
if (failures || keep) console.log(`kept ${tmp}`);
else fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
