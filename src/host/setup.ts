// `topotopo setup` and `topotopo setup --remove`: the Windows file links that make a double-click open TopoTopo. Per user,
// no administrator rights, nothing outside the user's own registry hive, profile and TopoTopo folder.
//
//   setup writes (relative to HKCU\Software\Classes):
//     .topo, .topows                           default = TopoTopo.Package / TopoTopo.Workspace; OpenWithProgids\<ProgID> (so
//                                              TopoTopo is in "Open with" even where another program is the default)
//     TopoTopo.Package, TopoTopo.Workspace     default = the name Explorer shows; DefaultIcon = assets/icons/topotopo-*.ico of
//                                              this install; shell\open FriendlyAppName = TopoTopo;
//                                              shell\open\command = "<launcher>" --node "<node>" "%1"
//     Applications\topotopo-open.exe           FriendlyAppName, SupportedTypes, shell\open\command (what "Open with" shows
//                                              for the program: TopoTopo, not the name of the exe)
//     Directory\shell\TopoTopo and Directory\Background\shell\TopoTopo     "Open in TopoTopo" on a folder and on a folder's
//                                              background, with the icon, running the launcher on "%1" / "%V"
//     <Start menu>\Programs\TopoTopo.lnk       the home page, through the launcher
//   then tells Explorer the associations changed (SHChangeNotify, SHCNE_ASSOCCHANGED, from a hidden PowerShell) so it
//   redraws icons.
//
//   Before it writes anything, setup records what is there (every value it will replace as the .reg file text of that value,
//   which keys did not exist, a Start menu file it replaces) in <TopoTopo folder>/setup.json. `setup --remove` restores
//   from that record: values put back, keys setup made deleted when nothing else lives in them, the shortcut deleted (or the
//   file it replaced put back). Running setup again changes nothing and keeps the first record's originals.
//
//   Windows already has a choice of the person's for a file type when HKCU\...\Explorer\FileExts\<.ext>\UserChoice names
//   another program; it is protected, and setup never writes it: the links are written anyway (TopoTopo is then in "Open
//   with") and the person is told how to choose.
//
// Tools on every Windows, through child processes without a window: reg.exe (export and delete), `reg import` of a .reg
// file (UTF-16, so any path keeps its letters) and Windows PowerShell (the shortcut, the notification).
//
// Test overrides (environment): TOPOTOPO_SETUP_CLASSES (the registry key standing in for HKCU\Software\Classes),
// TOPOTOPO_SETUP_FILEEXTS (the one standing in for ...\Explorer\FileExts), TOPOTOPO_SETUP_START_MENU (the folder standing in
// for the Start menu's Programs folder), TOPOTOPO_SETUP_NO_NOTIFY=1 (no notification to Explorer), and TOPOTOPO_HOME (the
// TopoTopo folder, as for `open`). Registry overrides must be keys under HKCU.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { topotopoHome } from './open.ts';

const REAL_CLASSES = 'HKEY_CURRENT_USER\\Software\\Classes';
const REAL_FILEEXTS = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts';
const EXE = 'topotopo-open.exe';
const RECORD = 'setup.json';
const SHORTCUT = 'TopoTopo.lnk';

const SYSTEM32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
const REG = path.join(SYSTEM32, 'reg.exe');
const POWERSHELL = path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');

export interface SetupOptions {
  /** the person's TopoTopo folder (default: topotopoHome()) */
  home?: string;
  /** the TopoTopo install: the folder that holds launcher/, assets/ and dist/ (default: the one this file is in) */
  root?: string;
  /** the Node.js the links run (default: the one running this) */
  node?: string;
  /** the platform and processor to act as (tests of the messages) */
  platform?: string;
  arch?: string;
}

interface Io { out(s: string): void; err(s: string): void }
/** A failure that is one plain sentence for the person. */
class Say extends Error {}

// ------------------------------------------------------------------------------------------------------ .reg files

/** A key's name as Windows spells it, from HKCU\... or HKEY_CURRENT_USER\...; throws for anything outside HKCU. */
function userKey(name: string, what: string): string {
  const m = /^(?:HKCU|HKEY_CURRENT_USER)\\(.+?)\\*$/i.exec(name.trim());
  if (!m) throw new Say(`${what} must be a key under HKCU (it is "${name}")`);
  return `HKEY_CURRENT_USER\\${m[1]}`;
}

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
/** The text of a string value in a .reg file; the default value has the name ''. */
const valueName = (name: string) => (name === '' ? '@' : `"${esc(name)}"`);
const sz = (name: string, data: string) => `${valueName(name)}="${esc(data)}"`;
/** an empty value of kind REG_NONE: a name that only says it is there */
const none = (name: string) => `${valueName(name)}=hex(0):`;

interface Section { key: string; lines: string[] }

/** Read a .reg file's text into its keys, each with its values' lines (long hex lines joined). */
function parseReg(text: string): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null, pending = '';
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    let line = raw;
    if (pending) { line = pending + raw.trimStart(); pending = ''; }
    if (line.endsWith('\\') && (line.startsWith('@') || line.startsWith('"'))) { pending = line.slice(0, -1); continue; }
    const head = /^\[(.+)\]$/.exec(line);
    if (head) { cur = { key: head[1], lines: [] }; sections.push(cur); } else if (cur && line !== '') cur.lines.push(line);
  }
  return sections;
}

/** The line of a value in a key's section, or null. Names compare without regard to case, as the registry does. */
function lineOf(sections: Section[], key: string, name: string): string | null {
  const sec = sections.find((s) => s.key.toLowerCase() === key.toLowerCase());
  const start = `${valueName(name)}=`.toLowerCase();
  return sec?.lines.find((l) => l.toLowerCase().startsWith(start)) ?? null;
}

// ------------------------------------------------------------------------------------------------------ the tools

interface Ran { status: number | null; stdout: string; stderr: string }
const run = (exe: string, args: string[], env?: NodeJS.ProcessEnv): Ran => {
  const r = spawnSync(exe, args, { windowsHide: true, encoding: 'utf8', env: env ?? process.env, timeout: 60_000 });
  return { status: r.error ? -1 : r.status, stdout: r.stdout ?? '', stderr: r.error ? String(r.error.message) : r.stderr ?? '' };
};

/** One run's registry tool: a temporary folder for the .reg files it exchanges with reg.exe, removed by `done`. */
class Registry {
  private dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topotopo-setup-'));
  private n = 0;
  done() { fs.rmSync(this.dir, { recursive: true, force: true }); }
  /** A key and everything under it as sections, or null when the key does not exist. */
  export(key: string): Section[] | null {
    const file = path.join(this.dir, `export-${this.n++}.reg`);
    const r = run(REG, ['export', key, file, '/y']);
    if (r.status !== 0 || !fs.existsSync(file)) return null;
    return parseReg(fs.readFileSync(file).toString('utf16le'));
  }
  /** Write values: [{key, lines}] in one .reg import. */
  import(parts: { key: string; lines: string[] }[]) {
    if (!parts.length) return;
    const text = ['Windows Registry Editor Version 5.00', '', ...parts.flatMap((p) => [`[${p.key}]`, ...p.lines, ''])].join('\r\n');
    const file = path.join(this.dir, `import-${this.n++}.reg`);
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]));
    const r = run(REG, ['import', file]);
    if (r.status !== 0) throw new Say(`reg.exe could not write the registry (${(r.stderr || r.stdout).trim().split(/\r?\n/)[0] || `exit ${r.status}`})`);
  }
  /** whether a key exists */
  exists(key: string): boolean { return run(REG, ['query', key]).status === 0; }
  deleteValue(key: string, name: string) { run(REG, name === '' ? ['delete', key, '/ve', '/f'] : ['delete', key, '/v', name, '/f']); }
  deleteKey(key: string) { run(REG, ['delete', key, '/f']); }
  /** the REG_SZ value of a key, or null */
  read(key: string, name: string): string | null {
    const line = lineOf(this.export(key) ?? [], key, name);
    const m = line && /^(?:@|"(?:[^"\\]|\\.)*")="(.*)"$/.exec(line);
    return m ? m[1].replace(/\\(.)/g, '$1') : null;
  }
}

const powershell = (script: string, env: Record<string, string>): Ran =>
  run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { ...process.env, ...env });

const SHORTCUT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:TT_LNK)',
  '$s.TargetPath = $env:TT_TARGET',
  '$s.Arguments = $env:TT_ARGS',
  '$s.IconLocation = $env:TT_ICON',
  "$s.Description = 'TopoTopo'",
  '$s.Save()',
].join('\n');

// SHCNE_ASSOCCHANGED (0x08000000), SHCNF_IDLIST | SHCNF_FLUSHNOWAIT (0x2000): Explorer rereads the associations and redraws icons
const NOTIFY_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -Namespace TopoTopo -Name Shell -MemberDefinition '[DllImport(\"shell32.dll\")] public static extern void SHChangeNotify(int eventId, uint flags, IntPtr item1, IntPtr item2);'",
  '[TopoTopo.Shell]::SHChangeNotify(0x08000000, 0x2000, [IntPtr]::Zero, [IntPtr]::Zero)',
].join('\n');

// ------------------------------------------------------------------------------------------------------ the plan

/** A value setup writes: the key (below the classes root), the value's name ('' the default) and its .reg line. */
interface Item { key: string; name: string; line: string }

/** The keys setup exports before it writes and when it looks for what is there: where its values live. */
const TOPS = ['.topo', '.topows', 'TopoTopo.Package', 'TopoTopo.Workspace', `Applications\\${EXE}`, 'Directory\\shell\\TopoTopo', 'Directory\\Background\\shell\\TopoTopo'];

const quote = (p: string) => `"${p}"`;

function planItems(launcher: string, node: string, icons: { package: string; workspace: string }): { items: Item[]; args: string } {
  const args = `--node ${quote(node)}`;
  const command = (arg: string) => `${quote(launcher)} ${args} ${quote(arg)}`;
  const items: Item[] = [];
  const add = (key: string, name: string, line: string) => items.push({ key, name, line });
  const kinds = [
    { ext: '.topo', progId: 'TopoTopo.Package', label: 'TopoTopo package', icon: icons.package },
    { ext: '.topows', progId: 'TopoTopo.Workspace', label: 'TopoTopo workspace', icon: icons.workspace },
  ];
  for (const k of kinds) {
    add(k.ext, '', sz('', k.progId));
    add(`${k.ext}\\OpenWithProgids`, k.progId, none(k.progId));
    add(k.progId, '', sz('', k.label));
    add(`${k.progId}\\DefaultIcon`, '', sz('', k.icon));
    add(`${k.progId}\\shell\\open`, 'FriendlyAppName', sz('FriendlyAppName', 'TopoTopo'));
    add(`${k.progId}\\shell\\open\\command`, '', sz('', command('%1')));
  }
  const app = `Applications\\${EXE}`;
  add(app, 'FriendlyAppName', sz('FriendlyAppName', 'TopoTopo'));
  add(`${app}\\SupportedTypes`, '.topo', sz('.topo', ''));
  add(`${app}\\SupportedTypes`, '.topows', sz('.topows', ''));
  add(`${app}\\shell\\open\\command`, '', sz('', command('%1')));
  for (const [key, arg] of [['Directory\\shell\\TopoTopo', '%1'], ['Directory\\Background\\shell\\TopoTopo', '%V']]) {
    add(key, '', sz('', 'Open in TopoTopo'));
    add(key, 'Icon', sz('Icon', icons.package));
    add(`${key}\\command`, '', sz('', command(arg)));
  }
  return { items, args };
}

/** Every key from the classes root down to this one, shallowest first. */
const ancestry = (key: string) => key.split('\\').map((_, i, parts) => parts.slice(0, i + 1).join('\\'));

interface SetupRecord {
  format: 1;
  /** the registry key and the Start menu folder this setup wrote to, which --remove undoes */
  classes: string;
  startMenu: string;
  /** every value setup wrote: what it replaced, as the .reg line of that value (null: there was none) */
  values: { key: string; name: string; before: string | null }[];
  /** every key on the way to those values: whether it existed before setup */
  keys: { key: string; existed: boolean }[];
  /** the Start menu entry: what it was made with, and whether it replaced a file (kept in <TopoTopo folder>/setup-backup) */
  shortcut?: { path: string; target: string; args: string; icon: string; replaced: boolean };
}

const readRecord = (home: string): SetupRecord | null => {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, RECORD), 'utf8'));
    return j?.format === 1 && Array.isArray(j.values) && Array.isArray(j.keys) ? j : null;
  } catch { return null; }
};
const writeRecord = (home: string, rec: SetupRecord) => {
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, RECORD);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(rec, null, 2) + '\n');
  fs.renameSync(`${file}.tmp`, file);
};

// ------------------------------------------------------------------------------------------------------ the command

const startMenuFolder = () => {
  const given = process.env.TOPOTOPO_SETUP_START_MENU;
  if (given) return path.resolve(given);
  if (!process.env.APPDATA) throw new Say('Windows has not said where your Start menu is (APPDATA is not set)');
  return path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
};

/** The program Windows has recorded as the person's own choice for an extension (protected: only read), or null. */
function userChoice(reg: Registry, fileExts: string, ext: string): string | null {
  return reg.read(`${fileExts}\\${ext}\\UserChoice`, 'ProgId');
}

/**
 * `setup` or `setup --remove`: returns the exit code; a failure is one sentence on `err`.
 */
export async function setupCommand(argv: string[], prog: string, io: Io, o: SetupOptions = {}): Promise<number> {
  let reg: Registry | null = null;
  try {
    if (argv.length > 1 || (argv.length === 1 && argv[0] !== '--remove')) throw new Say(`usage: ${prog} setup [--remove]`);
    const removing = argv[0] === '--remove';
    const platform = o.platform ?? process.platform, arch = o.arch ?? process.arch;
    if (platform !== 'win32') throw new Say('file links exist for Windows only so far');
    const home = path.resolve(o.home ?? topotopoHome());
    if (removing) return await remove(home, io, (reg = new Registry()));

    if (arch !== 'x64') throw new Say(`the launcher is for x64 only so far, and this Node.js is ${arch}`);
    const root = path.resolve(o.root ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
    const launcher = path.join(root, 'launcher', 'win32-x64', EXE);
    const icons = { package: path.join(root, 'assets', 'icons', 'topotopo-package.ico'), workspace: path.join(root, 'assets', 'icons', 'topotopo-workspace.ico') };
    const absent = [launcher, icons.package, icons.workspace].filter((f) => !fs.existsSync(f)).map((f) => path.relative(root, f).replace(/\\/g, '/'));
    if (absent.length) throw new Say(`this TopoTopo install is missing ${absent.join(' and ')}: install TopoTopo again`);
    if (!fs.existsSync(path.join(root, 'dist', 'cli.js'))) throw new Say(`this is a source checkout that was never built (dist/cli.js is missing): run npm run build once, then ${prog} setup again`);

    const classes = userKey(process.env.TOPOTOPO_SETUP_CLASSES ?? REAL_CLASSES, 'TOPOTOPO_SETUP_CLASSES');
    const fileExts = userKey(process.env.TOPOTOPO_SETUP_FILEEXTS ?? REAL_FILEEXTS, 'TOPOTOPO_SETUP_FILEEXTS');
    const startMenu = startMenuFolder();
    const node = path.resolve(o.node ?? process.execPath);
    reg = new Registry();
    return await setup({ home, launcher, icons, node, classes, fileExts, startMenu, prog }, io, reg);
  } catch (e: any) {
    io.err(String(e?.message ?? e).split('\n')[0]);
    return 1;
  } finally { reg?.done(); }
}

interface Ctx { home: string; launcher: string; icons: { package: string; workspace: string }; node: string; classes: string; fileExts: string; startMenu: string; prog: string }

async function setup(c: Ctx, io: Io, reg: Registry): Promise<number> {
  const full = (key: string) => `${c.classes}\\${key}`;
  const { items, args } = planItems(c.launcher, c.node, c.icons);
  const existing = readRecord(c.home);
  if (existing && (existing.classes.toLowerCase() !== c.classes.toLowerCase() || path.resolve(existing.startMenu).toLowerCase() !== c.startMenu.toLowerCase())) {
    throw new Say(`an earlier setup wrote to another place (${existing.classes}, ${existing.startMenu}): run ${c.prog} setup --remove first, which puts that one back`);
  }
  const rec: SetupRecord = existing ?? { format: 1, classes: c.classes, startMenu: c.startMenu, values: [], keys: [] };

  // what is there now: the values, and which keys exist
  const sections = TOPS.flatMap((t) => reg.export(full(t)) ?? []);
  // a key under one of those that the export did not list is not there; the few above them are asked for
  const keyExists = (key: string) => sections.some((s) => s.key.toLowerCase() === full(key).toLowerCase()) || (!TOPS.some((t) => key === t || key.startsWith(`${t}\\`)) && reg.exists(full(key)));
  for (const it of items) {
    for (const key of ancestry(it.key)) if (!rec.keys.some((k) => k.key === key)) rec.keys.push({ key, existed: keyExists(key) });
    if (!rec.values.some((v) => v.key === it.key && v.name === it.name)) rec.values.push({ key: it.key, name: it.name, before: lineOf(sections, full(it.key), it.name) });
  }
  const changes = items.filter((it) => lineOf(sections, full(it.key), it.name) !== it.line);

  // the shortcut
  const lnk = path.join(c.startMenu, SHORTCUT);
  const icon = `${c.icons.package},0`;
  const sc = rec.shortcut;
  const shortcutOk = !!sc && sc.path === lnk && sc.target === c.launcher && sc.args === args && sc.icon === icon && fs.existsSync(lnk);

  // Windows' own choice of program, which setup never writes
  const chosen: { ext: string; progId: string }[] = [];
  for (const [ext, progId] of [['.topo', 'TopoTopo.Package'], ['.topows', 'TopoTopo.Workspace']]) {
    const have = userChoice(reg, c.fileExts, ext);
    if (have && have.toLowerCase() !== progId.toLowerCase()) chosen.push({ ext, progId: have });
  }

  // the record first, so that a setup that stops part way can still be undone
  if (!existing || changes.length || !shortcutOk) writeRecord(c.home, rec);
  try {
    reg.import([...new Set(changes.map((it) => it.key))].map((key) => ({ key: full(key), lines: changes.filter((it) => it.key === key).map((it) => it.line) })));
    if (!shortcutOk) {
      fs.mkdirSync(c.startMenu, { recursive: true });
      let replaced = sc?.replaced ?? false;
      if (!sc && fs.existsSync(lnk)) {
        const backup = path.join(c.home, 'setup-backup');
        fs.mkdirSync(backup, { recursive: true });
        fs.copyFileSync(lnk, path.join(backup, SHORTCUT));
        replaced = true;
      }
      const r = powershell(SHORTCUT_SCRIPT, { TT_LNK: lnk, TT_TARGET: c.launcher, TT_ARGS: args, TT_ICON: icon });
      if (r.status !== 0 || !fs.existsSync(lnk)) throw new Say(`PowerShell could not make the Start menu entry (${(r.stderr || r.stdout).trim().split(/\r?\n/)[0] || `exit ${r.status}`})`);
      rec.shortcut = { path: lnk, target: c.launcher, args, icon, replaced };
      writeRecord(c.home, rec);
    }
    notify();
  } catch (e: any) {
    throw new Say(`${String(e?.message ?? e).split('\n')[0]}; setup stopped part way, and ${c.prog} setup --remove puts back what it had written`);
  }

  const again = !!existing && !changes.length && shortcutOk;
  io.out(`${again ? 'already in place, nothing changed: ' : ''}.topo packages and .topows workspaces now have the TopoTopo icons and open in TopoTopo when double-clicked`);
  io.out('folders have "Open in TopoTopo" in their right-click menu, and TopoTopo is in the Start menu');
  io.out(`to undo all of it: ${c.prog} setup --remove`);
  for (const { ext, progId } of chosen) {
    io.out(`note: Windows already has your own choice of program for ${ext} files (${progId}), which no program may change for you: right-click a ${ext} file, choose Open with, then TopoTopo, then Always`);
  }
  return 0;
}

/** Tell Explorer the associations changed, so it redraws icons (not when a test says so). */
function notify() {
  if (process.env.TOPOTOPO_SETUP_NO_NOTIFY === '1') return;
  // Explorer's redraw is a courtesy: a failure to send it does not undo the setup
  powershell(NOTIFY_SCRIPT, {});
}

async function remove(home: string, io: Io, reg: Registry): Promise<number> {
  const rec = readRecord(home);
  if (!rec) { io.out(`nothing to remove: setup has not been run for this TopoTopo folder (${path.join(home, RECORD)} is missing)`); return 0; }
  const full = (key: string) => `${rec.classes}\\${key}`;
  const created = rec.keys.filter((k) => !k.existed).map((k) => k.key).sort((x, y) => x.split('\\').length - y.split('\\').length);
  // what is in the keys setup made now: one export of each outermost one
  const now = new Map<string, string[]>();
  for (const k of created.filter((k) => !created.some((o) => o !== k && k.startsWith(`${o}\\`)))) for (const sec of reg.export(full(k)) ?? []) now.set(sec.key.toLowerCase(), sec.lines);
  const sectionOf = (key: string) => full(key).toLowerCase();
  const mine = (key: string) => new Set(rec.values.filter((v) => v.key === key && v.before === null).map((v) => valueName(v.name).toLowerCase()));
  // a key setup made goes, with what is under it, when nothing else lives in it or under it any more
  const deletable = (key: string): boolean => {
    const lines = now.get(sectionOf(key));
    if (!lines) return false;
    const own = mine(key);
    if (lines.some((l) => !own.has(l.slice(0, l.indexOf('=')).toLowerCase()))) return false;
    return [...now.keys()].filter((k) => k.startsWith(`${sectionOf(key)}\\`) && !k.slice(sectionOf(key).length + 1).includes('\\'))
      .every((child) => created.some((c) => sectionOf(c) === child && deletable(c)));
  };
  const gone: string[] = [];
  for (const k of created) if (!gone.some((g) => k.startsWith(`${g}\\`)) && deletable(k)) { reg.deleteKey(full(k)); gone.push(k); }
  // the values setup wrote in keys that stay are deleted, and what it replaced is put back
  const keep: { key: string; lines: string[] }[] = [];
  for (const v of [...rec.values].reverse()) {
    if (gone.some((g) => v.key === g || v.key.startsWith(`${g}\\`))) continue;
    if (v.before === null) reg.deleteValue(full(v.key), v.name);
    else keep.push({ key: full(v.key), lines: [v.before] });
  }
  reg.import(keep);
  // the Start menu entry
  if (rec.shortcut) {
    fs.rmSync(rec.shortcut.path, { force: true });
    const backup = path.join(home, 'setup-backup', SHORTCUT);
    if (rec.shortcut.replaced && fs.existsSync(backup)) fs.copyFileSync(backup, rec.shortcut.path);
    fs.rmSync(path.join(home, 'setup-backup'), { recursive: true, force: true });
  }
  fs.rmSync(path.join(home, RECORD), { force: true });
  notify();
  io.out('removed the TopoTopo file links, the folder menu entry and the Start menu entry: everything is as it was before setup');
  return 0;
}
