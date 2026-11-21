// The Windows launcher (launcher/, shipped as launcher/win32-x64/topotopo-open.exe): what double-clicking a package or a
// workspace runs.
//   node test/launcher.ts [--exe <path>]      (part of npm test; CI also runs it on a fresh build with --exe)
// On every OS, read from the file:
// - the PE header: x64, PE32+, subsystem WINDOWS (GUI), so Windows never gives the launcher a console window;
// - its imports: Windows system DLLs only (no Visual C++ runtime to install; the C runtime is linked in);
// - the fingerprint of launcher/'s sources it was built from equals the sources beside it (rebuild with
//   npm run launcher:build after changing them), and it names no machine path.
// On Windows, run against a fake TopoTopo (a dist/cli.js that records how it was started):
// - what it runs: "<node.exe>" "<TopoTopo>\dist\cli.js" open ["<absolute path>"], in the TopoTopo folder, with no path
//   for no argument, Lithuanian letters and spaces kept, a relative path made absolute, src\cli.ts in a source checkout;
// - which node: --node, else the node.exe beside the npm prefix, else the installer's registry entry or PATH;
// - failures: open's exit code and what it said (TOPOTOPO_LAUNCHER_QUIET: on stderr instead of a message box), missing
//   Node.js, missing command line; a server that open leaves running with the pipes does not hold the launcher.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT } from './fixtures.ts';

let fail = 0, pass = 0;
const check = (ok: unknown, msg: string) => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
};
const at = process.argv.indexOf('--exe');
const EXE = at > 0 ? path.resolve(process.argv[at + 1]) : path.join(ROOT, 'launcher', 'win32-x64', 'topotopo-open.exe');
const SOURCES = ['Cargo.toml', 'Cargo.lock', 'build.rs', 'src/main.rs', '.cargo/config.toml'];

/** The fingerprint launcher/build.rs records: FNV-1a 64 over each source's name, NUL, LF text, NUL. */
export function launcherSourceFingerprint(): string {
  let h = 0xcbf29ce484222325n;
  const feed = (bytes: Uint8Array) => { for (const b of bytes) h = ((h ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn; };
  for (const name of SOURCES) {
    feed(Buffer.from(name)); feed(Uint8Array.of(0));
    feed(Buffer.from(fs.readFileSync(path.join(ROOT, 'launcher', name), 'utf8').replace(/\r\n/g, '\n'))); feed(Uint8Array.of(0));
  }
  return h.toString(16).padStart(16, '0');
}

interface Pe { machine: number; magic: number; subsystem: number; imports: string[] }
/** The PE header fields and the imported DLL names of an exe. */
function readPe(b: Buffer): Pe | string {
  if (b.length < 0x40 || b.toString('latin1', 0, 2) !== 'MZ') return 'no MZ header';
  const pe = b.readUInt32LE(0x3c);
  if (b.toString('latin1', pe, pe + 4) !== 'PE\0\0') return 'no PE signature';
  const machine = b.readUInt16LE(pe + 4), sections = b.readUInt16LE(pe + 6), optSize = b.readUInt16LE(pe + 20);
  const opt = pe + 24, magic = b.readUInt16LE(opt);
  if (magic !== 0x20b) return { machine, magic, subsystem: -1, imports: [] };
  const subsystem = b.readUInt16LE(opt + 68);
  const table = opt + optSize;
  const offset = (rva: number) => {
    for (let i = 0; i < sections; i++) {
      const s = table + i * 40, vsize = b.readUInt32LE(s + 8), va = b.readUInt32LE(s + 12), raw = b.readUInt32LE(s + 16), ptr = b.readUInt32LE(s + 20);
      if (rva >= va && rva < va + Math.max(vsize, raw)) return ptr + rva - va;
    }
    return -1;
  };
  const imports: string[] = [];
  const dir = offset(b.readUInt32LE(opt + 112 + 8));
  for (let d = dir; d >= 0 && d + 20 <= b.length; d += 20) {
    const name = b.readUInt32LE(d + 12);
    if (!name) break;
    const at = offset(name);
    imports.push(b.toString('latin1', at, b.indexOf(0, at)));
  }
  return { machine, magic, subsystem, imports };
}

// ------------------------------------------------------------------------------------------------ the file
check(fs.existsSync(EXE), `launcher exe ${path.relative(ROOT, EXE).split(path.sep).join('/')}`);
if (!fs.existsSync(EXE)) process.exit(1);
const bin = fs.readFileSync(EXE);
const pe = readPe(bin);
if (typeof pe === 'string') check(false, `the launcher is a PE file (${pe})`);
else {
  check(pe.machine === 0x8664 && pe.magic === 0x20b, `x64 PE32+ (machine 0x${pe.machine.toString(16)}, optional header 0x${pe.magic.toString(16)})`);
  check(pe.subsystem === 2, `PE subsystem is WINDOWS (GUI): ${pe.subsystem} (2 = GUI, 3 = console, which would open a console window)`);
  const system = /^(kernel32|user32|advapi32|ntdll|bcryptprimitives|api-ms-win-core-[a-z0-9-]+)\.dll$/i;
  const other = pe.imports.filter((d) => !system.test(d));
  check(pe.imports.length > 0 && !other.length, `imports Windows system DLLs only (${pe.imports.join(', ')})${other.length ? `; also needs ${other.join(', ')}` : ''}`);
}
const fingerprint = launcherSourceFingerprint();
check(bin.includes(Buffer.from(fingerprint)), `built from the sources in launcher/ (fingerprint ${fingerprint}; otherwise run npm run launcher:build)`);
const machinePath = /[A-Za-z]:\\[A-Za-z]/.exec(bin.toString('latin1'));
check(!machinePath, `names no machine path${machinePath ? ` (found ${JSON.stringify(bin.toString('latin1', machinePath.index, machinePath.index + 40))})` : ''}`);
check(bin.length < 600_000, `small: ${bin.length} bytes (limit 600000)`);

// ------------------------------------------------------------------------------------------------ running it
if (process.platform !== 'win32') {
  console.log('(the launcher runs on Windows only: its behaviour is checked there)');
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'topotopo-launcher-'));
  const record = path.join(tmp, 'record.json');
  /** A fake TopoTopo at dir: its launcher, a package.json and, unless cli is null, a command line that records argv. */
  const fakeTopoTopo = (dir: string, cli: string | null = 'dist/cli.js') => {
    fs.mkdirSync(path.join(dir, 'launcher', 'win32-x64'), { recursive: true });
    fs.copyFileSync(EXE, path.join(dir, 'launcher', 'win32-x64', 'topotopo-open.exe'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'topotopo', type: 'module' }));
    if (cli) {
      fs.mkdirSync(path.dirname(path.join(dir, cli)), { recursive: true });
      fs.writeFileSync(path.join(dir, cli), `
import fs from 'node:fs';
import { spawn } from 'node:child_process';
fs.writeFileSync(process.env.TOPOTOPO_FAKE_RECORD, JSON.stringify({ argv: process.argv.slice(2), script: process.argv[1], node: process.execPath, cwd: process.cwd() }));
const mode = process.env.TOPOTOPO_FAKE_MODE ?? '';
// a server left running with the pipes (the worst a detached child can do): the launcher must not wait for it
if (mode.startsWith('server')) spawn(process.execPath, ['-e', 'setTimeout(() => {}, 6000)'], { cwd: process.env.TEMP, detached: true, stdio: ['ignore', 'inherit', 'inherit'] }).unref();
if (mode.endsWith('fail')) { console.log('opening ...'); console.error('error: no package or workspace in that folder'); process.exit(3); }
if (mode === 'silent') process.exit(4);
`);
    }
    return path.join(dir, 'launcher', 'win32-x64', 'topotopo-open.exe');
  };
  const prefix = path.join(tmp, 'npm prefix');
  const root = path.join(prefix, 'node_modules', 'topotopo');
  const exe = fakeTopoTopo(root);
  const noNodePath = [path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'), process.env.SystemRoot ?? 'C:\\Windows'].join(path.delimiter);
  /** Runs a launcher; ms is until it exits (a server left running may keep the pipes open longer: a terminal's, not Explorer's). */
  const launch = async (file: string, args: string[], opts: { mode?: string; cwd?: string; path?: string } = {}) => {
    fs.rmSync(record, { force: true });
    const env: NodeJS.ProcessEnv = { ...process.env, TOPOTOPO_LAUNCHER_QUIET: '1', TOPOTOPO_FAKE_RECORD: record, TOPOTOPO_FAKE_MODE: opts.mode ?? '' };
    if (opts.path !== undefined) {
      for (const k of Object.keys(env)) if (k.toUpperCase() === 'PATH') delete env[k];
      env.PATH = opts.path;
    }
    const t0 = Date.now();
    const child = spawn(file, args, { cwd: opts.cwd ?? tmp, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    const killer = setTimeout(() => child.kill(), 30000);
    const code = await new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c)));
    const ms = Date.now() - t0;
    clearTimeout(killer);
    // what it wrote before exiting, without waiting for pipe ends a left-running server holds
    await new Promise<void>((resolve) => { const t = setTimeout(resolve, 300); child.on('close', () => { clearTimeout(t); resolve(); }); });
    child.stdout.destroy(); child.stderr.destroy();
    const rec = fs.existsSync(record) ? JSON.parse(fs.readFileSync(record, 'utf8')) : null;
    return { code, stdout, stderr: stderr.replace(/\r\n/g, '\n'), rec, ms };
  };
  const same = (a: unknown, b: string) => typeof a === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

  const version = await launch(exe, ['--version']);
  check(version.code === 0 && version.stdout.trim() === `topotopo-open 0.1.0 source ${fingerprint}`, `--version: ${version.stdout.trim()}`);

  const files = path.join(tmp, 'Kūrinys ąčęėįšųūž');
  fs.mkdirSync(path.join(files, 'forest workspace'), { recursive: true });
  const kit = path.join(files, 'street kit.topo');
  fs.writeFileSync(kit, '');
  const node = process.execPath;

  const one = await launch(exe, ['--node', node, kit]);
  check(one.code === 0 && one.rec && JSON.stringify(one.rec.argv) === JSON.stringify(['open', kit]),
    `a package: runs open "<path>" with Lithuanian letters and spaces kept (${JSON.stringify(one.rec?.argv)})`);
  check(same(one.rec?.node, node) && same(one.rec?.script, path.join(root, 'dist', 'cli.js')) && same(one.rec?.cwd, root),
    `with the --node given, the package's dist\\cli.js, in the TopoTopo folder (${one.rec?.script})`);
  const none = await launch(exe, ['--node', node]);
  check(none.code === 0 && JSON.stringify(none.rec?.argv) === JSON.stringify(['open']), `no argument: runs open alone (${JSON.stringify(none.rec?.argv)})`);
  const folder = await launch(exe, ['--node', node, path.join(files, 'forest workspace') + '\\']);
  check(folder.code === 0 && folder.rec?.argv.length === 2 && same(folder.rec.argv[1], path.join(files, 'forest workspace')), `a folder, trailing backslash and all (${folder.rec?.argv[1]})`);
  const relative = await launch(exe, ['--node', node, 'street kit.topo'], { cwd: files });
  check(relative.code === 0 && relative.rec?.argv[1] === kit, `a relative path is made absolute (${relative.rec?.argv[1]})`);

  // which node, without --node: beside the npm prefix first (a hard link, or a copy across volumes)
  const besidePrefix = path.join(prefix, 'node.exe');
  try { fs.linkSync(node, besidePrefix); } catch { fs.copyFileSync(node, besidePrefix); }
  const viaPrefix = await launch(exe, [kit], { path: noNodePath });
  check(viaPrefix.code === 0 && same(viaPrefix.rec?.node, besidePrefix), `without --node: the node.exe beside the npm prefix (${viaPrefix.rec?.node})`);
  fs.rmSync(besidePrefix);
  const viaSystem = await launch(exe, [kit], { path: [path.dirname(node), noNodePath].join(path.delimiter) });
  check(viaSystem.code === 0 && /node\.exe$/i.test(viaSystem.rec?.node ?? '') && viaSystem.rec?.argv[1] === kit,
    `without --node or a node beside the prefix: the Node.js installer's registry entry or PATH (${viaSystem.rec?.node})`);

  // a source checkout: no dist\, so src\cli.ts
  const checkout = path.join(tmp, 'checkout');
  const checkoutExe = fakeTopoTopo(checkout, 'src/cli.ts');
  const src = await launch(checkoutExe, ['--node', node, kit]);
  check(src.code === 0 && same(src.rec?.script, path.join(checkout, 'src', 'cli.ts')), `a source checkout without dist\\ runs src\\cli.ts (${src.rec?.script})`);
  // a source checkout with a dist\ left from an earlier build: still its source, never the older build
  fs.mkdirSync(path.join(checkout, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(checkout, 'dist', 'cli.js'), "process.stderr.write('the old build ran'); process.exit(9);\n");
  const stale = await launch(checkoutExe, ['--node', node, kit]);
  check(stale.code === 0 && same(stale.rec?.script, path.join(checkout, 'src', 'cli.ts')), `a source checkout with an old dist\\ beside it still runs src\\cli.ts (${stale.rec?.script ?? stale.stderr})`);

  // failures
  const failed = await launch(exe, ['--node', node, kit], { mode: 'fail' });
  check(failed.code === 3 && failed.stderr.startsWith('TopoTopo could not open street kit.topo.\n\nerror: no package or workspace in that folder'),
    `open fails: its exit code (${failed.code}) and what it said on stderr (${JSON.stringify(failed.stderr.split('\n').slice(0, 3).join(' | '))})`);
  const silent = await launch(exe, ['--node', node], { mode: 'silent' });
  check(silent.code === 4 && silent.stderr.startsWith('TopoTopo could not start.\n\ntopotopo open stopped with exit code 4 and said nothing.'), `open fails silently: the exit code is said (${JSON.stringify(silent.stderr.trim())})`);
  const noNode = await launch(exe, ['--node', path.join(tmp, 'gone', 'node.exe'), kit]);
  check(noNode.code === 1 && noNode.stderr.startsWith(`Node.js was not found at ${path.join(tmp, 'gone', 'node.exe')}.`) && !noNode.rec, `a --node that is gone: says where it looked (${JSON.stringify(noNode.stderr.split('\n')[0])})`);
  const bare = path.join(tmp, 'broken');
  const bareExe = fakeTopoTopo(bare, null);
  const noCli = await launch(bareExe, ['--node', node, kit]);
  check(noCli.code === 1 && noCli.stderr.startsWith(`TopoTopo's command line was not found beside this launcher (expected ${path.join(bare, 'dist', 'cli.js')}).`), `no command line beside it: says what is missing (${JSON.stringify(noCli.stderr.split('\n')[0])})`);

  // a server that open starts and leaves running, holding the pipes: the launcher still ends with open
  const served = await launch(exe, ['--node', node, kit], { mode: 'server' });
  check(served.code === 0 && served.ms < 4000, `open leaves a server running: the launcher ends with open (${served.ms} ms; the server lives 6 s)`);
  const servedFail = await launch(exe, ['--node', node, kit], { mode: 'server-fail' });
  check(servedFail.code === 3 && servedFail.ms < 4000 && servedFail.stderr.includes('error: no package or workspace in that folder'),
    `open fails and leaves a server running: the launcher reports within a second of open's exit (${servedFail.ms} ms)`);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

console.log(`\nlauncher: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
