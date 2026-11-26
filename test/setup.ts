// `topotopo setup` and `setup --remove` (src/host/setup.ts): the Windows file links behind a double-click.
//   node test/setup.ts
// Never touches the real HKCU\Software\Classes, the real Start menu or the real TopoTopo folder: every run sets the
// overrides (TOPOTOPO_SETUP_CLASSES and _FILEEXTS name a scratch key HKCU\Software\TopoTopoTest-<id>, _START_MENU a
// temporary folder, _NO_NOTIFY skips the message to Explorer, TOPOTOPO_HOME a temporary TopoTopo folder), and deletes the
// scratch key at the end, also after a failure. The real keys setup would write are exported before and after the run to
// show they are as they were. The checks of the messages that do not need Windows run everywhere; the rest is Windows only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './fixtures.ts';
import { setupCommand } from '../src/host/setup.ts';

let fail = 0, pass = 0;
const check = (ok: unknown, msg: string) => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
};

// native: a temp folder with a short name (C:\Users\RUNNER~1\…) gets its long name, the one a shortcut stores
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'topotopo-setup-test-')));
const WIN = process.platform === 'win32';
const SYSTEM32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
const REG = path.join(SYSTEM32, 'reg.exe');
const POWERSHELL = path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const SCRATCH = `HKCU\\Software\\TopoTopoTest-${process.pid}-${Date.now().toString(36)}`;
const CLASSES = `${SCRATCH}\\Classes`;
const FILEEXTS = `${SCRATCH}\\FileExts`;
const regRun = (...args: string[]) => spawnSync(REG, args, { windowsHide: true, encoding: 'utf8' });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** What a run says. */
const say = async (argv: string[], o: Parameters<typeof setupCommand>[3] = {}) => {
  const out: string[] = [], err: string[] = [];
  const code = await setupCommand(argv, 'topotopo', { out: (s) => out.push(s), err: (s) => err.push(s) }, o);
  return { code, out, err };
};

/** A fake TopoTopo install: the launcher, the icons and dist/cli.js, each left out on request. */
function install(dir: string, without: string[] = []) {
  const put = (rel: string, from?: string) => {
    if (without.includes(rel)) return;
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (from) fs.copyFileSync(from, file); else fs.writeFileSync(file, '');
  };
  put('launcher/win32-x64/topotopo-open.exe', path.join(ROOT, 'launcher', 'win32-x64', 'topotopo-open.exe'));
  put('assets/icons/topotopo-package.ico', path.join(ROOT, 'assets', 'icons', 'topotopo-package.ico'));
  put('assets/icons/topotopo-workspace.ico', path.join(ROOT, 'assets', 'icons', 'topotopo-workspace.ico'));
  put('dist/cli.js');
  return dir;
}

/** A key and what is under it, from `reg export` (UTF-16): its text, or null when the key is not there. */
const exportText = (key: string): string | null => {
  const file = path.join(tmp, `export-${Math.random().toString(36).slice(2)}.reg`);
  try { return regRun('export', key, file, '/y').status === 0 ? fs.readFileSync(file).toString('utf16le') : null; } finally { fs.rmSync(file, { force: true }); }
};

/** Every key under `root` with its values, read with `reg query /s`: key relative to root (lower case, the root's own is '') -> name -> [type, data] (the default value is ''). */
function dump(root: string): Map<string, Map<string, [string, string]>> {
  const base = root.replace(/^HKCU/i, 'HKEY_CURRENT_USER').toLowerCase();
  const keys = new Map<string, Map<string, [string, string]>>();
  let cur: Map<string, [string, string]> | null = null;
  for (const line of (regRun('query', root, '/s').stdout ?? '').split(/\r?\n/)) {
    if (/^HKEY_/i.test(line)) { cur = new Map(); keys.set(line.toLowerCase().slice(base.length).replace(/^\x5c/, ''), cur); continue; }
    const m = /^ {4}(.*?) {4}(REG_[A-Z_]+)(?: {4}(.*))?$/.exec(line);
    if (m && cur) cur.set(/^\(.*\)$/.test(m[1]) ? '' : m[1], [m[2], m[3] ?? '']);
  }
  return keys;
}

/** What a .lnk file holds, read from the file itself (the shell link format: target, arguments, icon as Unicode strings). */
const lnkInfo = (file: string) => {
  const b = fs.readFileSync(file);
  const flags = b.readUInt32LE(0x14);
  let p = 0x4c;
  if (flags & 0x1) p += 2 + b.readUInt16LE(p); // the target's item list
  let target = '';
  if (flags & 0x2) { // link info: the local base path, in Unicode when the header says so
    const size = b.readUInt32LE(p), header = b.readUInt32LE(p + 4);
    const at = header >= 0x24 ? p + b.readUInt32LE(p + 28) : p + b.readUInt32LE(p + 16);
    let end = at;
    if (header >= 0x24) { while (b.readUInt16LE(end) !== 0) end += 2; target = b.toString('utf16le', at, end); } else { while (b[end] !== 0) end++; target = b.toString('latin1', at, end); }
    p += size;
  }
  const str = () => { const n = b.readUInt16LE(p); const t = b.toString('utf16le', p + 2, p + 2 + n * 2); p += 2 + n * 2; return t; };
  if (flags & 0x4) str();
  if (flags & 0x8) str();
  if (flags & 0x10) str();
  const args = flags & 0x20 ? str() : '', icon = flags & 0x40 ? str() : '';
  return { target, args, icon: `${icon},${b.readInt32LE(0x38)}` };
};

/** The real keys setup would write and the real files, read only: they must be as they were when this test is over. */
const realKeys = ['.topo', '.topows', 'TopoTopo.Package', 'TopoTopo.Workspace', 'Applications\\topotopo-open.exe', 'Directory\\shell\\TopoTopo', 'Directory\\Background\\shell\\TopoTopo'];
const realState = () => {
  const lnk = path.join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'TopoTopo.lnk');
  const rec = path.join(os.homedir(), '.topotopo', 'setup.json');
  const st = (f: string) => { try { return String(fs.statSync(f).mtimeMs); } catch { return 'absent'; } };
  return JSON.stringify([...realKeys.map((k) => exportText(`HKCU\\Software\\Classes\\${k}`)), st(lnk), st(rec)]);
};

let home = '', startMenu = '';
const realBefore = WIN ? realState() : '';
try {
  // ---- the messages that need no registry (before anything is set up: nothing may be touched)
  const linux = await say([], { platform: 'linux', home: path.join(tmp, 'h-linux') });
  check(linux.code === 1 && linux.err.length === 1 && /^file links exist for Windows only so far$/.test(linux.err[0]) && !linux.out.length && !fs.existsSync(path.join(tmp, 'h-linux')), `not Windows: one sentence, nothing written (${linux.err[0]})`);
  const linuxRemove = await say(['--remove'], { platform: 'darwin', home: path.join(tmp, 'h-linux') });
  check(linuxRemove.code === 1 && /Windows only so far/.test(linuxRemove.err[0] ?? ''), 'setup --remove says the same off Windows');
  const arm = await say([], { platform: 'win32', arch: 'arm64', home: path.join(tmp, 'h-arm') });
  check(arm.code === 1 && arm.err.length === 1 && /^the launcher is for x64 only so far, and this Node\.js is arm64$/.test(arm.err[0]) && !fs.existsSync(path.join(tmp, 'h-arm')), `not x64: one sentence (${arm.err[0]})`);
  const usage = await say(['--bogus'], { platform: 'win32' });
  check(usage.code === 1 && /^usage: topotopo setup \[--remove\]$/.test(usage.err[0] ?? ''), `an unknown argument gets the usage (${usage.err[0]})`);

  if (!WIN) {
    console.log('SKIP the registry, Start menu and Explorer checks: file links exist for Windows only so far');
  } else {
    // ---- the scratch registry and Start menu
    home = path.join(tmp, 'topotopo home');
    startMenu = path.join(tmp, 'Start Menu', 'Programs');
    fs.mkdirSync(startMenu, { recursive: true });
    process.env.TOPOTOPO_SETUP_CLASSES = CLASSES;
    process.env.TOPOTOPO_SETUP_FILEEXTS = FILEEXTS;
    process.env.TOPOTOPO_SETUP_START_MENU = startMenu;
    process.env.TOPOTOPO_SETUP_NO_NOTIFY = '1';
    process.env.TOPOTOPO_HOME = home;
    check(/^HKCU\\Software\\TopoTopoTest-/.test(process.env.TOPOTOPO_SETUP_CLASSES!) && regRun('add', `${CLASSES}\\.topo`, '/ve', '/d', 'Other.App', '/f').status === 0, `the scratch key ${SCRATCH} is set up`);
    // a value that was there before, which setup replaces and --remove must put back, and one it must not touch
    regRun('add', `${CLASSES}\\.topo`, '/v', 'Keep', '/d', 'mine', '/f');
    regRun('add', `${CLASSES}\\.topows\\OpenWithProgids`, '/v', 'Other.App', '/t', 'REG_NONE', '/f');
    regRun('add', `${CLASSES}\\Directory\\shell\\Mine`, '/ve', '/d', 'my entry', '/f');

    const fake = install(path.join(tmp, 'My Apps', 'Topo Topo'));
    const node = path.join(tmp, 'node js', 'node.exe');
    const opts = { root: fake, node, home };
    const launcher = path.join(fake, 'launcher', 'win32-x64', 'topotopo-open.exe');
    const icon = (n: string) => path.join(fake, 'assets', 'icons', `topotopo-${n}.ico`);
    const cmd = (arg: string) => `"${launcher}" --node "${node}" "${arg}"`;

    // ---- the messages that need the install
    const before0 = exportText(CLASSES);
    const planted = dump(CLASSES).get('.topows\\openwithprogids')?.get('Other.App') ?? ['REG_NONE', ''];
    const noLauncher = await say([], { ...opts, root: install(path.join(tmp, 'no launcher'), ['launcher/win32-x64/topotopo-open.exe']) });
    check(noLauncher.code === 1 && noLauncher.err.length === 1 && /^this TopoTopo install is missing launcher\/win32-x64\/topotopo-open\.exe: install TopoTopo again$/.test(noLauncher.err[0]), `the launcher missing: one sentence (${noLauncher.err[0]})`);
    const noIcons = await say([], { ...opts, root: install(path.join(tmp, 'no icons'), ['assets/icons/topotopo-package.ico', 'assets/icons/topotopo-workspace.ico']) });
    check(noIcons.code === 1 && /missing assets\/icons\/topotopo-package\.ico and assets\/icons\/topotopo-workspace\.ico: install TopoTopo again$/.test(noIcons.err[0] ?? ''), `the icons missing: one sentence (${noIcons.err[0]})`);
    const noCli = await say([], { ...opts, root: install(path.join(tmp, 'no cli'), ['dist/cli.js']) });
    check(noCli.code === 1 && noCli.err.length === 1 && /^this TopoTopo install is missing dist\/cli\.js: install TopoTopo again$/.test(noCli.err[0]), `no command line (neither src/cli.ts nor dist/cli.js): one sentence (${noCli.err[0]})`);
    check(exportText(CLASSES) === before0 && !fs.existsSync(path.join(home, 'setup.json')) && !fs.existsSync(path.join(startMenu, 'TopoTopo.lnk')), 'none of those messages changed the registry, the Start menu or the TopoTopo folder');

    // ---- a Start menu override that is empty or not a full path is refused, never the real Start menu
    for (const bad of ['', 'Programs', 'C:']) {
      process.env.TOPOTOPO_SETUP_START_MENU = bad;
      const refused = await say([], opts);
      check(refused.code === 1 && refused.err.length === 1 && /^TOPOTOPO_SETUP_START_MENU must be the full path of a folder/.test(refused.err[0]) && exportText(CLASSES) === before0 && !fs.existsSync(path.join(home, 'setup.json')), `TOPOTOPO_SETUP_START_MENU="${bad}" is refused (${refused.err[0]})`);
    }
    process.env.TOPOTOPO_SETUP_START_MENU = startMenu;

    // ---- --remove without a setup
    const nothing = await say(['--remove'], opts);
    check(nothing.code === 0 && nothing.out.length === 1 && /^nothing to remove: setup has not been run/.test(nothing.out[0]) && !nothing.err.length && exportText(CLASSES) === before0, `--remove without a setup is one sentence and a no-op (${nothing.out[0]})`);

    // ---- setup
    const first = await say([], opts);
    check(first.code === 0 && !first.err.length && first.out.length === 3 && /double-clicked/.test(first.out[0]) && /Open in TopoTopo/.test(first.out[1]) && /setup --remove/.test(first.out[2]), `setup prints three plain lines (${first.out.join(' | ')})`);
    const after1 = exportText(CLASSES);
    const keys = dump(CLASSES);
    // exactly the keys and values that were there plus the ones setup writes
    const expected = new Map<string, Record<string, [string, string]>>();
    const put = (key: string, name: string, type: string, data: string) => { (expected.get(key) ?? expected.set(key, {}).get(key)!)[name] = [type, data]; };
    put('.topo', '', 'REG_SZ', 'TopoTopo.Package'); put('.topo', 'Keep', 'REG_SZ', 'mine');
    put('.topows', '', 'REG_SZ', 'TopoTopo.Workspace');
    put('.topo\\openwithprogids', 'TopoTopo.Package', 'REG_NONE', '');
    put('.topows\\openwithprogids', 'TopoTopo.Workspace', 'REG_NONE', ''); put('.topows\\openwithprogids', 'Other.App', planted[0], planted[1]);
    for (const [id, name, ico] of [['TopoTopo.Package', 'TopoTopo package', 'package'], ['TopoTopo.Workspace', 'TopoTopo workspace', 'workspace']]) {
      const k = id.toLowerCase();
      put(k, '', 'REG_SZ', name); put(`${k}\\defaulticon`, '', 'REG_SZ', icon(ico));
      put(`${k}\\shell\\open`, 'FriendlyAppName', 'REG_SZ', 'TopoTopo'); put(`${k}\\shell\\open\\command`, '', 'REG_SZ', cmd('%1'));
    }
    put('applications\\topotopo-open.exe', 'FriendlyAppName', 'REG_SZ', 'TopoTopo');
    put('applications\\topotopo-open.exe\\supportedtypes', '.topo', 'REG_SZ', ''); put('applications\\topotopo-open.exe\\supportedtypes', '.topows', 'REG_SZ', '');
    put('applications\\topotopo-open.exe\\shell\\open\\command', '', 'REG_SZ', cmd('%1'));
    put('directory\\shell\\mine', '', 'REG_SZ', 'my entry');
    for (const [k, arg] of [['directory\\shell\\topotopo', '%1'], ['directory\\background\\shell\\topotopo', '%V\\.']]) {
      put(k, '', 'REG_SZ', 'Open in TopoTopo'); put(k, 'Icon', 'REG_SZ', icon('package')); put(`${k}\\command`, '', 'REG_SZ', cmd(arg));
    }
    const expectedKeys = new Set([...[...expected.keys()].flatMap((k) => k.split('\\').map((_, i, p) => p.slice(0, i + 1).join('\\')))]);
    const missingKeys = [...expectedKeys].filter((k) => !keys.has(k));
    const extraKeys = [...keys.keys()].filter((k) => !expectedKeys.has(k));
    check(!missingKeys.length && !extraKeys.length, `the scratch key holds exactly the expected ${keys.size} keys${missingKeys.length ? `; missing ${missingKeys.join(', ')}` : ''}${extraKeys.length ? `; unexpected ${extraKeys.join(', ')}` : ''}`);
    const wrong: string[] = [];
    for (const [k, vals] of expected) {
      const have = keys.get(k);
      for (const [n, want] of Object.entries(vals)) {
        const got = have?.get(n);
        if (!got || got[0] !== want[0] || got[1] !== want[1]) wrong.push(`${k} ${n || '(default)'}: wanted ${want.join(' ')}, got ${got?.join(' ') ?? 'nothing'}`);
      }
      for (const n of have?.keys() ?? []) if (!(n in vals)) wrong.push(`${k}: unexpected value ${n || '(default)'}`);
    }
    for (const [k, v] of keys) if (v.size && !expected.has(k)) wrong.push(`${k}: unexpected values`);
    check(!wrong.length, `every value is as expected (${[...expected.values()].reduce((a, v) => a + Object.keys(v).length, 0)} values)${wrong.length ? `: ${wrong.slice(0, 4).join('; ')}` : ''}`);
    const openCmd = keys.get('topotopo.package\\shell\\open\\command')?.get('')?.[1] ?? '';
    check(openCmd === `"${launcher}" --node "${node}" "%1"` && openCmd.indexOf('--node') < openCmd.indexOf('"%1"') && /My Apps\\Topo Topo/.test(openCmd) && /node js\\node\.exe/.test(openCmd), `the open command keeps its quotes around paths with spaces, --node before "%1" (${openCmd})`);
    const lnk = path.join(startMenu, 'TopoTopo.lnk');
    const info = fs.existsSync(lnk) ? lnkInfo(lnk) : null;
    check(!!info && info.target === launcher && info.args === `--node "${node}"` && info.icon === `${icon('package')},0`, `the Start menu has TopoTopo.lnk running the launcher with no path, with the icon (${info?.target} ${info?.args})`);
    check(fs.readdirSync(startMenu).join() === 'TopoTopo.lnk', 'nothing else is in the Start menu folder');
    const record = JSON.parse(fs.readFileSync(path.join(home, 'setup.json'), 'utf8'));
    check(record.format === 1 && record.classes === CLASSES.replace('HKCU', 'HKEY_CURRENT_USER') && record.values.some((v: any) => v.key === '.topo' && v.name === '' && v.before === '@="Other.App"') && record.values.some((v: any) => v.key === '.topows' && v.name === '' && v.before === null)
      && record.keys.some((k: any) => k.key === 'Directory' && k.existed === true) && record.keys.some((k: any) => k.key === 'Applications' && k.existed === false) && !!record.shortcut, `the record in the TopoTopo folder lists what was replaced (.topo was Other.App) and which keys are new`);

    // ---- a second setup changes nothing
    const recordText = fs.readFileSync(path.join(home, 'setup.json'), 'utf8');
    const lnkBefore = fs.statSync(lnk);
    await sleep(30);
    const second = await say([], opts);
    check(second.code === 0 && /^already in place, nothing changed: /.test(second.out[0] ?? '') && exportText(CLASSES) === after1 && fs.readFileSync(path.join(home, 'setup.json'), 'utf8') === recordText
      && fs.statSync(lnk).mtimeMs === lnkBefore.mtimeMs, 'a second setup changes nothing: the keys, the record and the Start menu file are as they were');

    // ---- a protected user choice for another program: the links are written, the message does not claim what is not so
    regRun('add', `${FILEEXTS}\\.topows\\UserChoice`, '/v', 'ProgId', '/d', 'Applications\\other.exe', '/f');
    const chosen = await say([], opts);
    check(chosen.code === 0 && chosen.out.length === 3 && /^already in place, nothing changed: the TopoTopo links are written, but Windows keeps your own choice of program for \.topows files \(Applications\\other\.exe\).*Open with, then TopoTopo, then Always; \.topo files open in TopoTopo when double-clicked$/.test(chosen.out[0]) && !/now have/.test(chosen.out[0]) && exportText(CLASSES) === after1,
      `a user choice for another program: the links are written and the person is told what to pick, not that files open in TopoTopo (${chosen.out[0]?.slice(0, 110)})`);
    check(regRun('query', `${FILEEXTS}\\.topows\\UserChoice`).stdout.includes('Applications\\other.exe') && !regRun('query', `${FILEEXTS}\\.topo\\UserChoice`).stdout.includes('TopoTopo'), 'the user choice key is as it was');
    regRun('delete', `${FILEEXTS}\\.topows\\UserChoice`, '/f');
    regRun('add', `${FILEEXTS}\\.topo\\UserChoice`, '/v', 'ProgId', '/d', 'Applications\\topotopo-open.exe', '/f');
    regRun('add', `${FILEEXTS}\\.topows\\UserChoice`, '/v', 'ProgId', '/d', 'TopoTopo.Workspace', '/f');
    const ours = await say([], opts);
    check(ours.code === 0 && /^already in place, nothing changed: \.topo packages and \.topows workspaces now have the TopoTopo icons and open in TopoTopo when double-clicked$/.test(ours.out[0]), `a user choice of TopoTopo's own (the exe or a ProgID) counts as ours (${ours.out[0]?.slice(0, 60)})`);
    regRun('delete', `${FILEEXTS}`, '/f');

    // ---- remove
    const removed = await say(['--remove'], opts);
    check(removed.code === 0 && removed.out.length === 1 && /everything is as it was/.test(removed.out[0]), `setup --remove says it is done (${removed.out[0]})`);
    check(exportText(CLASSES) === before0, '--remove leaves a reg export of the scratch key byte-identical to the export taken before setup');
    const back = dump(CLASSES);
    check(back.get('.topo')?.get('')?.[1] === 'Other.App' && back.get('.topo')?.get('Keep')?.[1] === 'mine', 'the value that was there before (.topo = Other.App) is back, and the one setup never touched is untouched');
    check(!fs.existsSync(lnk) && !fs.existsSync(path.join(home, 'setup.json')) && !fs.existsSync(path.join(home, 'setup-backup')), 'the Start menu entry and the record are gone');
    const again = await say(['--remove'], opts);
    check(again.code === 0 && /^nothing to remove/.test(again.out[0] ?? '') && exportText(CLASSES) === before0, 'a second --remove is a no-op');

    // ---- --remove looks before it writes: what something else changed since setup is left alone
    await say([], opts);
    regRun('add', `${CLASSES}\\.topo`, '/ve', '/d', 'Another.Program', '/f'); // another program took .topo
    regRun('add', `${CLASSES}\\TopoTopo.Package`, '/v', 'Foreign', '/d', 'x', '/f'); // and put its own value in TopoTopo's ProgID
    const careful = await say(['--remove'], opts);
    const kept = dump(CLASSES);
    check(careful.code === 0 && careful.out.length === 1 && /^removed what setup wrote, except what something else has changed since and is left as it is: .*\.topo \(default value\)/.test(careful.out[0]) && kept.get('.topo')?.get('')?.[1] === 'Another.Program' && kept.get('.topo')?.get('Keep')?.[1] === 'mine',
      `a value another program changed since setup is left alone, in one line (${careful.out[0]?.slice(0, 120)})`);
    check(kept.get('topotopo.package')?.size === 1 && kept.get('topotopo.package')?.get('Foreign')?.[1] === 'x' && !kept.has('topotopo.package\\defaulticon') && !kept.has('topotopo.package\\shell') && !kept.has('topotopo.workspace') && !kept.has('applications') && !kept.has('directory\\shell\\topotopo') && !kept.has('.topo\\openwithprogids'),
      'a key setup made that now holds something else keeps only that; the rest of setup\'s keys and values are removed');
    check(!fs.existsSync(path.join(home, 'setup.json')) && !fs.existsSync(path.join(startMenu, 'TopoTopo.lnk')), 'the record and the Start menu entry are gone');
    regRun('add', `${CLASSES}\\.topo`, '/ve', '/d', 'Other.App', '/f');
    regRun('delete', `${CLASSES}\\TopoTopo.Package`, '/f');
    check(exportText(CLASSES) === before0, 'with the leftovers put away, the scratch key is as it was before setup');

    // ---- a lost record does not poison the next setup
    regRun('delete', `${CLASSES}\\.topo`, '/ve', '/f');
    const before1 = exportText(CLASSES);
    await say([], opts);
    fs.rmSync(path.join(home, 'setup.json'));
    const orphans = await say(['--remove'], opts);
    check(orphans.code === 1 && orphans.err.length === 1 && /^TopoTopo file links exist but .*setup\.json is missing, so what they replaced is not known: run topotopo setup once, and then topotopo setup --remove clears them$/.test(orphans.err[0]) && dump(CLASSES).has('topotopo.package'),
      `--remove with links but no record says so in one sentence and changes nothing (${orphans.err[0]?.slice(0, 90)})`);
    await say([], opts);
    const rebuilt = JSON.parse(fs.readFileSync(path.join(home, 'setup.json'), 'utf8'));
    check(rebuilt.values.every((v: any) => v.before === null) && rebuilt.keys.some((k: any) => k.key === 'Applications' && !k.existed) && rebuilt.keys.some((k: any) => k.key === '.topo' && k.existed) && !rebuilt.shortcut.replaced && !fs.existsSync(path.join(home, 'setup-backup')),
      'a setup that finds TopoTopo\'s own links without a record records that nothing was there before (the shortcut too)');
    const cleared = await say(['--remove'], opts);
    check(cleared.code === 0 && exportText(CLASSES) === before1 && !fs.existsSync(path.join(startMenu, 'TopoTopo.lnk')), 'setup once more and --remove clear the links a lost record left');
    // put .topo back as it was, values in their first order: a value added again goes last, so Keep is added again after it
    regRun('add', `${CLASSES}\\.topo`, '/ve', '/d', 'Other.App', '/f');
    regRun('delete', `${CLASSES}\\.topo`, '/v', 'Keep', '/f');
    regRun('add', `${CLASSES}\\.topo`, '/v', 'Keep', '/d', 'mine', '/f');
    check(exportText(CLASSES) === before0, 'the test put the scratch key back as it was before setup');

    // ---- a Start menu file that was there is put back; paths with letters beyond ASCII survive
    fs.writeFileSync(lnk, 'someone else\'s shortcut');
    const odd = install(path.join(tmp, 'Lietuvių įdiegimas č'));
    const uni = await say([], { ...opts, root: odd });
    const text = exportText(CLASSES) ?? '';
    const oddLnk = lnkInfo(lnk), oddLauncher = path.join(odd, 'launcher', 'win32-x64', 'topotopo-open.exe');
    check(oddLnk.target === oddLauncher && oddLnk.args === `--node "${node}"` && oddLnk.icon === `${path.join(odd, 'assets', 'icons', 'topotopo-package.ico')},0`, `the shortcut's target and icon keep the letters of an install path beyond ASCII (${oddLnk.target})`);
    check(uni.code === 0 && text.includes(odd.replaceAll('\\', '\\\\')) && fs.statSync(lnk).size !== 'someone else\'s shortcut'.length, 'a path with Lithuanian letters is written as it is');
    const uniRemoved = await say(['--remove'], opts);
    check(uniRemoved.code === 0 && fs.readFileSync(lnk, 'utf8') === 'someone else\'s shortcut' && exportText(CLASSES) === before0 && !fs.existsSync(path.join(home, 'setup-backup')), 'a Start menu file that setup replaced is put back by --remove');
    fs.rmSync(lnk, { force: true });

    // ---- "Open in TopoTopo" on a folder's background, a drive root too: the command line Explorer runs, through the launcher
    const recorder = install(path.join(tmp, 'argv recorder'));
    fs.writeFileSync(path.join(recorder, 'dist', 'package.json'), '{"type":"commonjs"}');
    fs.writeFileSync(path.join(recorder, 'dist', 'cli.js'), "require('fs').appendFileSync(process.env.TT_ARGV, JSON.stringify(process.argv.slice(2)) + '\\n');\n");
    await say([], { ...opts, root: recorder, node: process.execPath });
    const bg = dump(CLASSES).get('directory\\background\\shell\\topotopo\\command')?.get('')?.[1] ?? '';
    const argvLog = path.join(tmp, 'argv.log');
    const launchWith = (commandLine: string, folder: string) => {
      spawnSync('cmd.exe', ['/d', '/s', '/c', `"${commandLine.replace('%V', () => folder)}"`], { windowsVerbatimArguments: true, env: { ...process.env, TT_ARGV: argvLog, TOPOTOPO_LAUNCHER_QUIET: '1' }, windowsHide: true, timeout: 60_000 });
      const lines = fs.existsSync(argvLog) ? fs.readFileSync(argvLog, 'utf8').trim().split('\n').filter(Boolean) : [];
      return lines.length ? (JSON.parse(lines.at(-1)!) as string[]) : null;
    };
    const driveRoot = path.parse(tmp).root, ordinary = path.join(tmp, 'ordinary folder');
    fs.mkdirSync(ordinary);
    const same = (a: string | undefined, b: string) => !!a && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
    check(/^"[^"]+topotopo-open\.exe" --node "[^"]+" "%V\\\."$/.test(bg), `the background command ends its folder in \\. inside the quotes (${bg.slice(-30)})`);
    fs.rmSync(argvLog, { force: true });
    const atRoot = launchWith(bg, driveRoot);
    check(atRoot?.[0] === 'open' && atRoot.length === 2 && !atRoot[1].includes('"') && same(atRoot[1], driveRoot), `the command line for a drive root (${driveRoot}) gives open that drive root (${JSON.stringify(atRoot)})`);
    const atFolder = launchWith(bg, ordinary);
    check(atFolder?.[0] === 'open' && atFolder.length === 2 && !atFolder[1].includes('"') && same(atFolder[1], ordinary), `the same command line for an ordinary folder gives open that folder (${JSON.stringify(atFolder)})`);
    const plain = launchWith(bg.replace('%V\\.', '%V'), driveRoot);
    check(plain === null || !same(plain[1], driveRoot), `the plain "%V" form would not have (${JSON.stringify(plain)}): the test can tell`);
    await say(['--remove'], opts);
    check(exportText(CLASSES) === before0, 'and --remove puts the scratch key back');

    // ---- through the command line: the whole round trip, from this source checkout, built or not
    const env = { ...process.env, TOPOTOPO_SETUP_CLASSES: CLASSES, TOPOTOPO_SETUP_FILEEXTS: FILEEXTS, TOPOTOPO_SETUP_START_MENU: startMenu, TOPOTOPO_SETUP_NO_NOTIFY: '1', TOPOTOPO_HOME: path.join(tmp, 'cli home') };
    const cli = (...a: string[]) => spawnSync(process.execPath, [path.join(ROOT, 'src', 'cli.ts'), ...a], { env, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
    const help = cli('--help');
    check(help.status === 0 && /setup \[--remove\]   \(Windows: /.test(help.stdout), 'the command line help describes setup');
    const nope = cli('setup', '--remove');
    check(nope.status === 0 && /^nothing to remove/.test(nope.stdout) && !nope.stderr, 'the command line: setup --remove without a setup is a no-op');
    const viaCli = cli('setup');
    check(viaCli.status === 0 && fs.existsSync(path.join(startMenu, 'TopoTopo.lnk')) && !!dump(CLASSES).get('.topo\\openwithprogids'), `the command line: setup writes the scratch key and the Start menu entry (${viaCli.stderr.trim()})`);
    const gone = cli('setup', '--remove');
    check(gone.status === 0 && exportText(CLASSES) === before0 && !fs.existsSync(path.join(startMenu, 'TopoTopo.lnk')), 'the command line: setup --remove puts it all back');
  }
} catch (e: any) {
  fail++;
  console.log(`FAIL ${e?.stack ?? e}`);
} finally {
  if (WIN) {
    regRun('delete', SCRATCH, '/f');
    check(regRun('query', SCRATCH).status !== 0, 'the scratch key is deleted');
    check(realState() === realBefore, 'the real hive, Start menu and TopoTopo folder are as they were before this test');
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
