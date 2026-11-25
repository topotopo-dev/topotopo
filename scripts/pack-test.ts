// Pack test: build the npm tarball, install it into an empty folder in a temp directory and use it the way a user
// would. Not part of npm test (it builds, packs and installs: about a minute); run it before a release.
//   node scripts/pack-test.ts [--keep]      (npm run pack:test; --keep leaves the temp directory for inspection)
//
// Checks
// - npm pack (prepack builds dist/): required files are in the tarball, TopoTopo's built-in library among them (the
//   versions of its own packages, library/<name>/versions/), the examples with their cards (examples/<name>.json and .md,
//   each example package's manifest, graphs and inputs: help {examples}), and nothing from src/, test/, the examples'
//   renders and package copies, out/, the built-in packages' working folders and thumbnails, or the Rust sources is.
// - The bin from the installed package: `npm exec --no -- topotopo --help`, and cooking an example graph copied into the
//   temp folder with a PNG render and a GLB export (examples/town_from_lots.json: straight_skeleton runs in the WASM
//   kernels loaded from the installed kernels/pkg, and the door frames are topotopo/architecture's: `topotopo init`
//   makes the folder a package, and the cook's first use copies the built-in package in from the installed built-in library).
// - The cook for Godot from the installed bin: `topotopo cook <package> --for godot --progress json` on the neutral props
//   of the cook tests in a Godot project, `topotopo godot status` reading it as current, and `topotopo godot setup`
//   copying the addon the package carries (integrations/godot/addons/topotopo, every file of it in the tarball).
// - The cook for Unreal from the installed bin: `topotopo cook <package> --for unreal --progress json` on the same props in
//   an Unreal project's Content/, `topotopo unreal status` reading it as current, and `topotopo unreal setup` copying
//   the TopoTopo plugin from the tarball, enabling it for Win64, and recording the installed command line.
// - The library: `import 'topotopo'` (exports map) and its types (tsc on a consumer file), the built-in library, the
//   bundled font, the worker pool entry (dist/host/worker.js) and the SDF grid kernels, all from the installed location,
//   and rbd_settle with the Rapier physics engine (@dimforge/rapier3d-compat) resolved from the installed dependencies.
// - The MCP server over stdio as a client starts it (`npm exec --no -- topotopo mcp --package …`, which is what
//   `npx -y topotopo mcp` runs once the package is installed) on a new folder, which it makes a package:
//   catalog (TopoTopo's own packages too), a build that names a built-in package's output and copies the built-in package in from the installed
//   built-in library, a build that uses sdf_grid, and the preview page with three.js served from the installed
//   dependencies.
// - `topotopo open <package>` from the installed bin: it starts the web app of the installed dist/ unseen, on a folder and
//   a config of its own, records the address instead of opening a browser, the address answers, and a second open reuses it.
// - On Windows, `topotopo setup` from the installed bin against a scratch registry key and Start menu folder (never the real ones):
//   the file links name the installed launcher, Node.js and icons, and `setup --remove` leaves the scratch key as it was.
// - On Windows, the launcher from the installed package (launcher/win32-x64/topotopo-open.exe): it finds the installed
//   command line and a Node.js by itself and reports a failing open.
// The bin always runs through `npm exec --no --`: it never downloads, so only the tarball under test can answer.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.argv.includes('--keep');
// an empty config of its own, which every command below inherits: the libraries registered on this machine play no part
process.env.TOPOTOPO_CONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'topotopo-config-')), 'config.json');
delete process.env.TOPOTOPO_LIBRARIES;
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const NAME: string = pkg.name;
const BIN = Object.keys(pkg.bin)[0];

/** The newest version TopoTopo's built-in library holds of a built-in package, which a first use copies in. */
const newestOf = (name: string) => fs.readdirSync(path.join(ROOT, 'library', name, 'versions')).filter((v) => /^\d+\.\d+$/.test(v))
  .sort((a, b) => { const [x, y] = a.split('.').map(Number), [u, w] = b.split('.').map(Number); return x - u || y - w; }).at(-1)!;
/** A version as a regular expression matches it. */
const re = (v: string) => v.replace(/\./g, '\\.');

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
// the packed CLI keeps slow node results in a cache folder: this run's own, removed with the temp directory
process.env.TOPOTOPO_NODE_CACHE_DIR = path.join(tmp, 'node-cache');
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
    ...fs.readdirSync(path.join(ROOT, 'library')).map((k) => `library/${k}/versions/${newestOf(k)}/version.json`), 'assets/fonts/DejaVuSans.ttf', 'assets/fonts/LICENSE_DEJAVU',
    'kernels/pkg/topotopo_kernels.js', 'kernels/pkg/topotopo_kernels_bg.wasm', 'kernels/pkg/LICENSE',
    'kernels/pkg-simd/topotopo_kernels.js', 'kernels/pkg-simd/topotopo_kernels_bg.wasm', 'kernels/pkg-simd/LICENSE',
    'launcher/win32-x64/topotopo-open.exe', 'assets/icons/topotopo-package.ico', 'assets/icons/topotopo-workspace.ico',
  ];
  const missing = required.filter((f) => !files.includes(f));
  check(!missing.length, `tarball has the runtime files${missing.length ? `; missing: ${missing.join(', ')}` : ''}`);
  // the Godot addon, whole (topotopo godot setup copies it into a project), and none of its tests or demo
  const addonFiles: string[] = [];
  const walkAddon = (dir: string, rel: string) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const r = `${rel}/${e.name}`; if (e.isDirectory()) walkAddon(path.join(dir, e.name), r); else addonFiles.push(r); } };
  walkAddon(path.join(ROOT, 'integrations', 'godot', 'addons', 'topotopo'), 'integrations/godot/addons/topotopo');
  const addonMissing = addonFiles.filter((f) => !files.includes(f));
  check(addonFiles.length > 10 && !addonMissing.length && !files.some((f) => /^integrations\/godot\/(tests|demo)\//.test(f)),
    `tarball has every file of the Godot addon (${addonFiles.length}) and not its tests or demo${addonMissing.length ? `; missing: ${addonMissing.join(', ')}` : ''}`);
  // TopoTopo ships the whole Unreal plugin as source.
  const unrealFiles: string[] = [];
  const walkUnreal = (dir: string, rel: string) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const r = `${rel}/${e.name}`; if (e.isDirectory()) walkUnreal(path.join(dir, e.name), r); else unrealFiles.push(r); } };
  const unrealPath = 'integrations/unreal/TopoTopo';
  walkUnreal(path.join(ROOT, unrealPath), unrealPath);
  const unrealMissing = unrealFiles.filter((f) => !files.includes(f));
  const unrealStray = files.filter((f) => f.startsWith('integrations/unreal/') && !unrealFiles.includes(f));
  check(unrealFiles.length > 40 && !unrealMissing.length && !unrealStray.length && !files.some((f) => /^integrations\/unreal\/TopoTopo\/(Binaries|Intermediate)\//.test(f)),
    `tarball contains only the TopoTopo Unreal plugin (${unrealFiles.length} files)${unrealMissing.length ? `; missing: ${unrealMissing.join(', ')}` : ''}${unrealStray.length ? `; extra: ${unrealStray.join(', ')}` : ''}`);
  const wasmBytes = info.files.filter((f: any) => f.path.endsWith('.wasm')).reduce((sum: number, f: any) => sum + f.size, 0);
  check(wasmBytes > 0 && wasmBytes <= 2_500_000, `tarball WASM totals ${wasmBytes} bytes (limit 2500000)`);
  // the examples and their cards (src/mcp/examples.ts, help {examples}), and each example package's manifest, graphs and inputs
  const exampleFiles: string[] = [];
  for (const e of fs.readdirSync(path.join(ROOT, 'examples'), { withFileTypes: true })) {
    const dir = path.join(ROOT, 'examples', e.name);
    if (e.isFile() && /\.(json|md)$/.test(e.name)) exampleFiles.push(`examples/${e.name}`);
    else if (e.isDirectory() && fs.readdirSync(dir).some((f) => f.endsWith('.topo'))) {
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.topo'))) exampleFiles.push(`examples/${e.name}/${f}`);
      for (const sub of ['graphs', 'inputs']) {
        if (fs.existsSync(path.join(dir, sub))) for (const f of fs.readdirSync(path.join(dir, sub)).filter((x) => !x.startsWith('.'))) exampleFiles.push(`examples/${e.name}/${sub}/${f}`);
      }
    }
  }
  const exampleMissing = exampleFiles.filter((f) => !files.includes(f));
  check(exampleFiles.length > 30 && !exampleMissing.length, `tarball has the examples and their cards (${exampleFiles.length} files)${exampleMissing.length ? `; missing: ${exampleMissing.slice(0, 5).join(', ')}` : ''}`);
  const shippedExample = (f: string) => /^examples\/[\w-]+\.(json|md)$/.test(f) || /^examples\/[\w-]+\/([\w-]+\.topo|(graphs|inputs)\/[^/]+)$/.test(f);
  const stray = files.filter((f) => /^(src|test|out|bench|scripts|docs|package|tmp|kernels\/(src|target|tests|benches))\//.test(f) || (/^examples\//.test(f) && !shippedExample(f)) ||
    (/^library\//.test(f) && !/^library\/[\w-]+\/versions\//.test(f)) ||
    (/^launcher\//.test(f) && f !== 'launcher/win32-x64/topotopo-open.exe') || /^assets\/icons\/src\//.test(f) || (/\.ts$/.test(f) && !/\.d\.ts$/.test(f)) || /\.tgz$/.test(f));
  check(!stray.length, `tarball has no sources, tests, example renders or package copies, build output or working folders of the built-in library${stray.length ? `; found: ${stray.slice(0, 10).join(', ')}` : ''}`);
  // every file of every version of TopoTopo's own packages: a version has the same files wherever it is
  const versionFiles: string[] = [];
  const walkVersions = (dir: string, rel: string) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const r = `${rel}/${e.name}`; if (e.isDirectory()) walkVersions(path.join(dir, e.name), r); else versionFiles.push(r); } };
  for (const k of fs.readdirSync(path.join(ROOT, 'library'))) walkVersions(path.join(ROOT, 'library', k, 'versions'), `library/${k}/versions`);
  const unshipped = versionFiles.filter((f) => !files.includes(f));
  check(!unshipped.length && versionFiles.length > 30, `tarball has every file of the built-in library's versions (${versionFiles.length})${unshipped.length ? `; missing: ${unshipped.slice(0, 5).join(', ')}` : ''}`);

  // ------------------------------------------------------------------------------------------------ install
  step('npm install <tarball> into an empty folder');
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: `${NAME}-pack-test`, private: true, type: 'module' }, null, 2));
  sh(`npm install --no-audit --no-fund --prefer-offline "${tarball}"`, app);
  const installed = path.join(app, 'node_modules', NAME);
  for (const variant of ['pkg', 'pkg-simd']) {
    const readme = fs.readFileSync(path.join(installed, 'kernels', variant, 'README.md'), 'utf8');
    for (const document of ['BUILD.md'])
      check(readme.includes(`https://github.com/topotopo-dev/topotopo/blob/main/kernels/${document}`) &&
        !readme.includes(`](${document}`), `${variant} README ${document} link works outside the source checkout`);
  }
  const inPkg = (p: unknown) => typeof p === 'string' && path.resolve(p).toLowerCase().startsWith(installed.toLowerCase() + path.sep);
  check(fs.existsSync(path.join(installed, 'dist', 'cli.js')) && !fs.existsSync(path.join(installed, 'src')), `installed node_modules/${NAME} (dist/, no src/)`);
  const shim = path.join(app, 'node_modules', '.bin', process.platform === 'win32' ? `${BIN}.cmd` : BIN);
  check(fs.existsSync(shim), `bin shim node_modules/.bin/${path.basename(shim)}`);
  if (process.platform !== 'win32') check((fs.statSync(path.join(installed, 'dist', 'cli.js')).mode & 0o111) !== 0, 'dist/cli.js is executable');

  // ------------------------------------------------------------------------------------------------ CLI
  step(`CLI: npm exec --no -- ${BIN}`);
  const help = sh(`npm exec --no -- ${BIN} --help`, app);
  check(help.startsWith(`usage: ${BIN} `) && help.includes(`${BIN} mcp`), `--help prints the usage (${help.split('\n')[0].slice(0, 60)}…)`);
  fs.copyFileSync(path.join(ROOT, 'examples', 'town_from_lots.json'), path.join(app, 'roofs.json'));
  // the example names topotopo/architecture's outputs: only a package's graphs use packages
  const init = sh(`npm exec --no -- ${BIN} init .`, app);
  check(/^package app → /.test(init) && fs.existsSync(path.join(app, 'app.topo')), `init makes the temp folder a package (${init.split('\n')[0]})`);
  const cook = sh(`npm exec --no -- ${BIN} roofs.json --render roofs.png --export roofs.glb`, app);
  const lock = fs.existsSync(path.join(app, 'packages', 'lock.json')) ? JSON.parse(fs.readFileSync(path.join(app, 'packages', 'lock.json'), 'utf8')) : {};
  const arch = newestOf('architecture');
  check(new RegExp(`added topotopo/architecture ${re(arch)} to package app from TopoTopo's built-in library`).test(cook) && lock.packages?.['topotopo/architecture']?.[arch]?.library === 'topotopo'
    && fs.existsSync(path.join(app, 'packages', 'topotopo', 'architecture', arch, 'version.json')), `the first use copies topotopo/architecture ${arch} in from the installed built-in library and locks it`);
  const png = path.join(app, 'roofs.png');
  const pngOk = fs.existsSync(png) && fs.readFileSync(png).subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && fs.statSync(png).size > 20000;
  check(/cooked roofs\.json/.test(cook) && pngOk, `cooked examples/town_from_lots.json (straight_skeleton + topotopo/architecture) and rendered roofs.png (${pngOk ? fs.statSync(png).size : 0} bytes)`);
  check(fs.existsSync(path.join(app, 'roofs.glb')) && fs.readFileSync(path.join(app, 'roofs.glb')).subarray(0, 4).toString() === 'glTF', 'exported roofs.glb');
  console.log(cook.split('\n').filter((l) => /^(cooked|geometry|rendered|exported)/.test(l)).join('\n'));

  // ------------------------------------------------------------------------------------------------ Windows launcher
  const launcherFile = info.files.find((f: any) => f.path === 'launcher/win32-x64/topotopo-open.exe');
  console.log(`launcher/win32-x64/topotopo-open.exe: ${launcherFile?.size ?? 0} bytes unpacked`);
  if (process.platform === 'win32') {
    step('Windows launcher from the installed package');
    // what a double-click runs, found from where the package is installed: the installed dist/cli.js and a Node.js
    // found without --node (none beside this prefix, so the installer's registry entry or PATH). open on a file that is
    // not there must fail and say so, whatever open does with a real one.
    const exe = path.join(installed, 'launcher', 'win32-x64', 'topotopo-open.exe');
    const env = { ...process.env, TOPOTOPO_LAUNCHER_QUIET: '1' };
    const version = execFileSync(exe, ['--version'], { env, encoding: 'utf8' }).trim();
    check(/^topotopo-open \S+ source [0-9a-f]{16}$/.test(version), `installed launcher answers --version (${version})`);
    const r = spawnSync(exe, [path.join(app, 'missing.topo')], { cwd: app, env, encoding: 'utf8', timeout: 60000 });
    const said = (r.stderr ?? '').replace(/\r\n/g, '\n');
    check(r.status !== 0 && said.startsWith('TopoTopo could not open missing.topo.\n\n') && said.trim().split('\n').length > 2 && !said.includes('src/cli.ts'),
      `installed launcher runs the installed command line: open on a missing file fails and says why (exit ${r.status}: ${JSON.stringify(said.split('\n')[2] ?? '')})`);
  }

  // ------------------------------------------------------------------------------------------------ setup
  if (process.platform === 'win32') {
    step(`setup: npm exec --no -- ${BIN} setup, against a scratch registry key and Start menu folder`);
    // the installed command line writes the file links against a scratch key (never HKCU\Software\Classes) and a temporary
    // Start menu folder, they point at the installed launcher and icons, and setup --remove leaves the key as it was
    const scratch = `HKCU\\Software\\TopoTopoTest-pack-${process.pid}`;
    const startMenu = path.join(tmp, 'start menu');
    const setupEnv = { ...process.env, TOPOTOPO_SETUP_CLASSES: `${scratch}\\Classes`, TOPOTOPO_SETUP_FILEEXTS: `${scratch}\\FileExts`, TOPOTOPO_SETUP_START_MENU: startMenu, TOPOTOPO_SETUP_NO_NOTIFY: '1', TOPOTOPO_HOME: path.join(tmp, 'setup-home') };
    const reg = (...a: string[]) => spawnSync('reg.exe', a, { encoding: 'utf8', windowsHide: true });
    const exportKey = (key: string) => { const f = path.join(tmp, `${Math.random().toString(36).slice(2)}.reg`); return reg('export', key, f, '/y').status === 0 ? fs.readFileSync(f).toString('utf16le') : null; };
    const valueOf = (key: string, name?: string) => { const m = /REG_SZ\s+(.*)\r?$/m.exec(reg('query', key, ...(name ? ['/v', name] : ['/ve'])).stdout ?? ''); return m?.[1] ?? ''; };
    try {
      check(reg('add', `${scratch}\\Classes\\.topo`, '/ve', '/d', 'Other.App', '/f').status === 0, 'the scratch registry key is made');
      const before = exportKey(`${scratch}\\Classes`);
      const said = sh(`npm exec --no -- ${BIN} setup`, app, setupEnv);
      const open = valueOf(`${scratch}\\Classes\\TopoTopo.Package\\shell\\open\\command`);
      const launcherPath = path.join(installed, 'launcher', 'win32-x64', 'topotopo-open.exe');
      const node = /--node "([^"]+)" "%1"$/.exec(open)?.[1];
      check(open.startsWith(`"${launcherPath}" --node "`) && !!node && fs.existsSync(node), `setup from the installed package links the files to the installed launcher and the Node.js it runs with (${open})`);
      const icons = ['Package', 'Workspace'].map((k) => valueOf(`${scratch}\\Classes\\TopoTopo.${k}\\DefaultIcon`));
      check(icons[0] === path.join(installed, 'assets', 'icons', 'topotopo-package.ico') && icons[1] === path.join(installed, 'assets', 'icons', 'topotopo-workspace.ico') && icons.every((f) => fs.existsSync(f)),
        'the icons are the installed package\'s and exist');
      check(valueOf(`${scratch}\\Classes\\.topo`) === 'TopoTopo.Package' && valueOf(`${scratch}\\Classes\\.topows`) === 'TopoTopo.Workspace' && fs.existsSync(path.join(startMenu, 'TopoTopo.lnk')) && /setup --remove/.test(said),
        'the .topo and .topows links and the Start menu entry are made');
      const removed = sh(`npm exec --no -- ${BIN} setup --remove`, app, setupEnv);
      check(exportKey(`${scratch}\\Classes`) === before && !fs.existsSync(path.join(startMenu, 'TopoTopo.lnk')) && /everything is as it was/.test(removed), 'setup --remove leaves the scratch key as it was and the Start menu entry gone');
    } finally {
      reg('delete', scratch, '/f');
    }
  }

  // ------------------------------------------------------------------------------------------------ open
  step(`open: npm exec --no -- ${BIN} open <package>`);
  {
    // the installed command line opens a package: it starts the web app (the installed dist/, unseen, on a free port of
    // its own folder and config), records the address instead of opening a browser, and the address answers
    const home = path.join(tmp, 'open-home');
    fs.mkdirSync(home);
    const net = await import('node:net');
    const port = await new Promise<number>((resolve) => { const sv = net.createServer(); sv.listen(0, '127.0.0.1', () => { const p = (sv.address() as any).port as number; sv.close(() => resolve(p)); }); });
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ web: { port } }));
    const kit = path.join(tmp, 'open-kit', 'demo-kit');
    fs.mkdirSync(kit, { recursive: true });
    sh(`npm exec --no -- ${BIN} init "${kit}"`, app);
    const log = path.join(home, 'browser.log');
    const openEnv = { ...process.env, TOPOTOPO_HOME: home, TOPOTOPO_CONFIG: path.join(home, 'config.json'), TOPOTOPO_BROWSER_LOG: log };
    let lockPid = 0;
    try {
      const said = sh(`npm exec --no -- ${BIN} open "${path.join(kit, 'demo-kit.topo')}"`, app, openEnv);
      const lock = JSON.parse(fs.readFileSync(path.join(home, 'web.lock'), 'utf8'));
      lockPid = lock.pid;
      const url = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim() : '';
      const res = url ? await fetch(url, { headers: { connection: 'close' }, signal: AbortSignal.timeout(20000) }).catch(() => null) : null;
      check(/^opening http:\/\/127\.0\.0\.1:\d+\/l\/demo-kit\/$/m.test(said) && url === said.trim().replace(/^opening /, '') && lock.port === port && res?.status === 200, `open starts the web app from the installed dist/ and the package's page answers (${url}: ${res?.status})`);
      sh(`npm exec --no -- ${BIN} open "${kit}"`, app, openEnv);
      check(JSON.parse(fs.readFileSync(path.join(home, 'web.lock'), 'utf8')).pid === lockPid && fs.readFileSync(log, 'utf8').trim().split(String.fromCharCode(10)).length === 2, 'a second open reuses that web app');
    } finally {
      // the installed command stops the web app it started (its health confirms the pid)
      const stopped = spawnSync('npm', ['exec', '--no', '--', BIN, 'open', '--stop'], { cwd: app, env: openEnv, encoding: 'utf8', shell: process.platform === 'win32', timeout: 60000 });
      check(/stopped the web app/.test(stopped.stdout ?? '') && !!lockPid && !fs.existsSync(path.join(home, 'web.lock')), `open --stop ends the web app from the installed dist/ (${(stopped.stdout ?? '').trim()})`);
    }
  }

  // ------------------------------------------------------------------------------------------------ Godot
  step(`Godot: npm exec --no -- ${BIN} cook … --for godot`);
  // a Godot project with the neutral props package of the cook tests (test/data/cook/props), cooked by the installed bin
  const game = path.join(tmp, 'godot game');
  const copy = (from: string, to: string) => {
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from, { withFileTypes: true })) (e.isDirectory() ? copy : fs.copyFileSync)(path.join(from, e.name), path.join(to, e.name));
  };
  copy(path.join(ROOT, 'test', 'data', 'cook', 'props'), path.join(game, 'props'));
  fs.writeFileSync(path.join(game, 'project.godot'), 'config_version=5\n');
  const cookEnv = { ...process.env, TOPOTOPO_CACHE: path.join(tmp, 'cook-cache') };
  const progress = sh(`npm exec --no -- ${BIN} cook "${path.join(game, 'props')}" --for godot --progress json --quiet`, app, cookEnv).split(/\r?\n/).filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
  const crate = path.join(game, 'props', 'outputs', 'crate', 'crate.glb');
  check(progress.at(-1)?.event === 'done' && progress.at(-1)?.ok && fs.existsSync(crate) && fs.readFileSync(crate).subarray(0, 4).toString() === 'glTF' && fs.existsSync(path.join(game, 'props', '.topotopo', 'godot.json')),
    `cook --for godot writes the outputs and the record (${progress.filter((e) => e.event === 'output').map((e) => `${e.output}:${e.state}`).join(' ')})`);
  const status = sh(`npm exec --no -- ${BIN} godot status "${game}"`, app, cookEnv);
  check(/^\s+ok\s+res:\/\/props\/props\.topo/m.test(status), `godot status reads the package as current (${status.split('\n')[1]?.trim()})`);
  const setup = sh(`npm exec --no -- ${BIN} godot setup "${game}"`, app, cookEnv);
  check(/copied the addon/.test(setup) && fs.existsSync(path.join(game, 'addons', 'topotopo', 'plugin.cfg')) && fs.existsSync(path.join(game, 'addons', 'topotopo', 'plugin.gd'))
    && fs.readFileSync(path.join(game, 'project.godot'), 'utf8').includes('enabled=PackedStringArray("res://addons/topotopo/plugin.cfg")'),
    `godot setup copies the addon the installed package carries into addons/topotopo/ and enables it (${setup.split('\n')[0]})`);

  // ------------------------------------------------------------------------------------------------ Unreal
  step(`Unreal: npm exec --no -- ${BIN} cook … --for unreal`);
  // An Unreal project with the same props in Content/, cooked by the installed bin, then set up from it.
  const ue = path.join(tmp, 'unreal game');
  copy(path.join(ROOT, 'test', 'data', 'cook', 'props'), path.join(ue, 'Content', 'props'));
  fs.writeFileSync(path.join(ue, 'Game.uproject'), JSON.stringify({ FileVersion: 3, EngineAssociation: '5.8', Plugins: [] }, null, '\t') + '\n');
  const ueProgress = sh(`npm exec --no -- ${BIN} cook "${path.join(ue, 'Content', 'props')}" --for unreal --progress json --quiet`, app, cookEnv).split(/\r?\n/).filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
  const ueCrate = path.join(ue, 'Saved', 'TopoTopo', 'Game', 'props', 'outputs', 'crate', 'crate.glb');
  check(ueProgress.at(-1)?.event === 'done' && ueProgress.at(-1)?.ok && fs.existsSync(ueCrate) && fs.readFileSync(ueCrate).subarray(0, 4).toString() === 'glTF' && fs.existsSync(path.join(ue, 'Content', 'props', '.topotopo', 'unreal.json')),
    `cook --for unreal writes the outputs below Saved/ and the record (${ueProgress.filter((e) => e.event === 'output').map((e) => `${e.output}:${e.state}`).join(' ')})`);
  const ueConfig = process.env.TOPOTOPO_UNREAL_TEST_CONFIG ?? process.env.TOPOTOPO_CONFIG!;
  const ueSetup = sh(`npm exec --no -- ${BIN} unreal setup "${ue}"`, app, { ...cookEnv, TOPOTOPO_CONFIG: ueConfig });
  const uproject = JSON.parse(fs.readFileSync(path.join(ue, 'Game.uproject'), 'utf8'));
  const entry = uproject.Plugins.find((p: any) => p.Name === 'TopoTopo');
  const record = JSON.parse(fs.readFileSync(ueConfig, 'utf8')).install ?? {};
  check(/copied the plugin/.test(ueSetup) && fs.readdirSync(path.join(ue, 'Plugins')).join() === 'TopoTopo'
    && fs.existsSync(path.join(ue, 'Plugins', 'TopoTopo', 'TopoTopo.uplugin')) && uproject.Plugins.length === 1 && entry?.Enabled === true
    && entry.SupportedTargetPlatforms?.join() === 'Win64' && path.resolve(record.cli ?? '').toLowerCase() === path.join(installed, 'dist', 'cli.js').toLowerCase(),
    `unreal setup copies the TopoTopo plugin, enables it and records the installed CLI (${ueSetup.split('\n')[0]})`);
  const ueStatus = sh(`npm exec --no -- ${BIN} unreal status "${ue}" --strict`, app, cookEnv);
  check(/every package is current/.test(ueStatus), `unreal status --strict reads the package as current after setup (${ueStatus.trim().split('\n').at(-1)})`);

  // ------------------------------------------------------------------------------------------------ library
  step(`library: import '${NAME}' from the installed package`);
  fs.writeFileSync(path.join(app, 'lib.mjs'), `
import { Engine, allNodeDefs } from '${NAME}';
import meta from '${NAME}/package.json' with { type: 'json' };
import { createNodeHost } from './node_modules/${NAME}/dist/host/node.js';
import { BUILTIN_LIBRARY } from './node_modules/${NAME}/dist/config.js';
import { createNodePool } from './node_modules/${NAME}/dist/host/pool.js';
import { kernelsWasmURL, kernelsWasmVariant, getLoadedKernels } from './node_modules/${NAME}/dist/wasm/kernels.js';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const out = { version: meta.version, nodes: allNodeDefs().length, library: BUILTIN_LIBRARY.path, wasm: fileURLToPath(kernelsWasmURL), variant: kernelsWasmVariant };
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
const rbd = await engine.cook({ nodes: { b: { type: 'box', params: { size: [0.5, 0.5, 0.5], center: [0, 2, 0] } }, s: { type: 'rbd_settle', in: ['b'] } }, output: 's' });
out.rbd = rbd.ok ? rbd.geo.bbox().min[1] : rbd.errors.map((e) => e.message).join('; ');
out.rapier = createRequire(import.meta.resolve('${NAME}')).resolve('@dimforge/rapier3d-compat');
await engine.host.pool.close();
console.log(JSON.stringify(out));
`);
  const autoEnv = { ...process.env };
  delete autoEnv.TOPOTOPO_WASM;
  const lib = JSON.parse(sh('node lib.mjs', app, autoEnv).trim().split('\n').pop()!);
  check(lib.version === pkg.version && lib.nodes >= 200, `import '${NAME}': ${lib.nodes} node types, ${NAME}/package.json ${lib.version}`);
  check(inPkg(lib.library) && fs.existsSync(path.join(lib.library, 'nature', 'versions', '1.0', 'version.json')) && !fs.existsSync(path.join(lib.library, 'nature', 'graphs')),
    `TopoTopo's built-in library from the installed package, its versions alone (${path.relative(app, lib.library)})`);
  check(inPkg(lib.font) && path.basename(lib.font) === 'DejaVuSans.ttf', `bundled font from the installed package (${lib.font && path.relative(app, lib.font)})`);
  check(inPkg(lib.wasm) && fs.existsSync(lib.wasm), `kernel WASM from the installed package (${path.relative(app, lib.wasm)})`);
  check(lib.variant === 'simd' && lib.wasm.includes('pkg-simd'), 'installed loader selects SIMD by feature detection on Node 22+');
  check(lib.poolResult === '2,4,6', `worker pool runs dist/host/worker.js (selftest ${lib.poolResult})`);
  check(typeof lib.wrangle === 'number' && lib.poolTasks > 0, `wrangle on the pool: ${lib.wrangle} points, ${lib.poolTasks} pool task(s)`);
  check(typeof lib.sdf === 'number' && lib.sdf > 0 && lib.kernelsLoaded, `sdf_grid + grid_to_mesh in the WASM kernels: ${lib.sdf} prims`);
  check(typeof lib.rbd === 'number' && Math.abs(lib.rbd) < 0.005, `rbd_settle drops a box onto the ground (bottom at ${typeof lib.rbd === 'number' ? lib.rbd.toFixed(4) : lib.rbd})`);
  check(typeof lib.rapier === 'string' && path.resolve(lib.rapier).toLowerCase().startsWith(path.join(app, 'node_modules', '@dimforge').toLowerCase()), `Rapier resolves from the installed dependencies (${lib.rapier && path.relative(app, lib.rapier)})`);

  // A fresh process per variant checks selection before import and proves both complete packages initialise.
  fs.writeFileSync(path.join(app, 'kernels.mjs'), `
import assert from 'node:assert/strict';
import { createNodeHost } from './node_modules/${NAME}/dist/host/node.js';
import { kernelsWasmVariant, kernelsWasmURL, loadHostKernels } from './node_modules/${NAME}/dist/wasm/kernels.js';
const kernels = await loadHostKernels(createNodeHost({ workers: 0 }));
const roof = kernels.roof([0, 0, 6, 0, 6, 4, 0, 4], [], 35);
assert.ok(roof.vertices.length > 0);
const bowl = Float32Array.of(3,3,3,3,0,3,3,3,3);
const filled = kernels.fill_sinks(bowl, 3, 3, { writeDirection: true });
assert.equal(filled.height[4], 3);
assert.equal(filled.fill[4], 3);
assert.notEqual(filled.direction[4], 255);
const lake = kernels.fill_sinks(bowl, 3, 3, { maxDepth: 1 });
assert.equal(lake.height[4], 0);
assert.equal(lake.lake[4], 3);
console.log(JSON.stringify({ variant: kernelsWasmVariant, url: kernelsWasmURL.href, vertices: Array.from(roof.vertices) }));
`);
  const scalar = JSON.parse(sh('node kernels.mjs', app, { ...autoEnv, TOPOTOPO_WASM: 'scalar' }).trim().split('\n').pop()!);
  const simd = JSON.parse(sh('node kernels.mjs', app, { ...autoEnv, TOPOTOPO_WASM: 'simd' }).trim().split('\n').pop()!);
  check(scalar.variant === 'scalar' && scalar.url.includes('/pkg/') && scalar.vertices.length > 0, 'installed scalar override loads and cooks a roof');
  check(simd.variant === 'simd' && simd.url.includes('/pkg-simd/') && JSON.stringify(simd.vertices) === JSON.stringify(scalar.vertices),
    'installed SIMD override loads and matches the scalar roof exactly');

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
  const ws = path.join(tmp, 'package');
  const transport = new StdioClientTransport({
    // npm exec --no: the local bin or nothing (npx in a non-TTY would fall back to downloading a same-named package)
    command: 'npm', args: ['exec', '--no', '--', BIN, 'mcp', '--package', ws], cwd: app,
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
    check(client.getServerVersion()?.name === NAME && client.getServerVersion()?.version === pkg.version, `server ${client.getServerVersion()?.name} ${client.getServerVersion()?.version}`);
    const cat = await call('catalog', {});
    check(!cat.isError && cat.txt.includes('straight_skeleton') && cat.txt.includes('topotopo/nature/rock'), 'catalog lists the nodes and the installed packages of TopoTopo\'s own');
    // the examples ship with the package: help lists them and gives one's card and graph, which validates here
    const exIdx = await call('help', { topic: 'examples' });
    const exOne = await call('help', { examples: ['town_from_lots'] });
    const exGraph = /\nGRAPH [^\n]*\n\n(\{[\s\S]*\})$/.exec(exOne.txt)?.[1];
    const exDry = exGraph ? await call('build', { name: 'roofs_example', graph: JSON.parse(exGraph), dry_run: true }) : null;
    check(/\n- town_from_lots — /.test(exIdx.txt) && !!exDry && !exDry.isError && /^✓ valid/.test(exDry.txt),
      `help lists the installed examples and gives one whose graph validates: ${exDry?.txt.split('\n')[0] ?? exOne.txt.slice(0, 80)}`);
    // the documented setup: a new folder, which the server made a package, so the first build that names a
    // an output of one of TopoTopo's own packages copies it in
    const rock = await call('build', { graph: { nodes: { r: { type: 'topotopo/nature/rock', params: { size: 2 } } } }, name: 'rock' });
    const nature = newestOf('nature');
    check(fs.existsSync(path.join(ws, 'package.topo')) && !rock.isError && new RegExp(`note: added topotopo/nature ${re(nature)}`).test(rock.txt) && fs.existsSync(path.join(ws, 'packages', 'topotopo', 'nature', nature, 'version.json')),
      `a new folder is a package: the first build copies topotopo/nature in from the installed built-in library: ${rock.txt.split('\n')[0]}`);
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
  check(/ready \(stdio\)/.test(serverLog) && /made the folder .* a package \(package\.topo\)/.test(serverLog) && /session .*: \d+ graphs, \d+ assets; package /.test(serverLog),
    `server log: ${serverLog.split('\n').filter((l) => l.includes('package') || l.includes('session')).map((l) => l.trim()).join(' | ')}`);
} catch (e: any) {
  failures++;
  console.log(`FAIL ${e?.stack ?? e}`);
}

console.log(`\n${failures ? `${failures} FAILED` : 'pack test passed'} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
if (failures || keep) console.log(`kept ${tmp}`);
else fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
