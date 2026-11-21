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
//                                              background, with the icon, running the launcher on "%1" / "%V\." (a
//                                              drive root's %V is D:\, which ends the quote: D:\\. is the same folder)
//     <Start menu>\Programs\TopoTopo.lnk       the home page, through the launcher
//   then tells Explorer the associations changed (SHChangeNotify, SHCNE_ASSOCCHANGED, from a hidden PowerShell) so it
//   redraws icons.
//
//   Before it writes anything, setup records what is there (every value it will replace as the .reg file text of that value,
//   which keys did not exist, a Start menu file it replaces) in <TopoTopo folder>/setup.json. `setup --remove` restores
//   from that record, after looking at what is there now: a value that is still exactly what setup wrote is put back or
//   deleted as recorded, one that something else changed since is left alone and named; keys setup made are deleted when
//   nothing but its own values live in them; the shortcut is deleted (or the file it replaced put back). Running setup
//   again changes nothing and keeps the first record's originals. Without a record (lost), values and keys that hold
//   only what TopoTopo itself wrote count as nothing-was-there-before, so setup and then --remove clear them.
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

// A shortcut through IShellLinkW, which keeps any letter of a path: WScript.Shell's TargetPath goes through the ANSI code
// page and turns letters it has no place for into others (an install in a folder named with Lithuanian letters).
const LINK_TYPE = `
using System; using System.Runtime.InteropServices; using System.Runtime.InteropServices.ComTypes; using System.Text;
namespace TopoTopo {
  [ComImport, Guid("00021401-0000-0000-C000-000000000046")] class ShellLinkObject {}
  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
  interface IShellLinkW {
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder file, int cch, IntPtr fd, uint flags);
    void GetIDList(out IntPtr pidl);
    void SetIDList(IntPtr pidl);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder name, int cch);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder dir, int cch);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string dir);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder args, int cch);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string args);
    void GetHotkey(out short hotkey);
    void SetHotkey(short hotkey);
    void GetShowCmd(out int show);
    void SetShowCmd(int show);
    void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder icon, int cch, out int index);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string icon, int index);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string rel, uint reserved);
    void Resolve(IntPtr hwnd, uint flags);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string file);
  }
  public static class Link {
    public static void Make(string lnk, string target, string args, string icon, string description) {
      var l = (IShellLinkW)new ShellLinkObject();
      l.SetPath(target); l.SetArguments(args); l.SetIconLocation(icon, 0); l.SetDescription(description);
      ((IPersistFile)l).Save(lnk, true);
    }
    public static string Target(string lnk) {
      var l = (IShellLinkW)new ShellLinkObject();
      ((IPersistFile)l).Load(lnk, 0);
      var sb = new StringBuilder(1024); l.GetPath(sb, 1024, IntPtr.Zero, 0);
      return sb.ToString();
    }
  }
}`;

const SHORTCUT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  `Add-Type -TypeDefinition @'${LINK_TYPE}\n'@`,
  "[TopoTopo.Link]::Make($env:TT_LNK, $env:TT_TARGET, $env:TT_ARGS, $env:TT_ICON, 'TopoTopo')",
].join('\n');

/** Whether a .lnk file runs a topotopo-open.exe. */
function shortcutIsOurs(lnk: string): boolean {
  const script = ["$ErrorActionPreference = 'Stop'", '[Console]::OutputEncoding = [Text.Encoding]::UTF8', `Add-Type -TypeDefinition @'${LINK_TYPE}\n'@`, '[TopoTopo.Link]::Target($env:TT_LNK)'].join('\n');
  const r = powershell(script, { TT_LNK: lnk });
  return r.status === 0 && /topotopo-open\.exe\s*$/i.test(r.stdout);
}

// SHCNE_ASSOCCHANGED (0x08000000), SHCNF_IDLIST | SHCNF_FLUSHNOWAIT (0x2000): Explorer rereads the associations and redraws icons
const NOTIFY_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -Namespace TopoTopo -Name Shell -MemberDefinition '[DllImport(\"shell32.dll\")] public static extern void SHChangeNotify(int eventId, uint flags, IntPtr item1, IntPtr item2);'",
  '[TopoTopo.Shell]::SHChangeNotify(0x08000000, 0x2000, [IntPtr]::Zero, [IntPtr]::Zero)',
].join('\n');

// ------------------------------------------------------------------------------------------------------ the plan

/** A value setup writes: the key (below the classes root), the value's name ('' the default) and its .reg line. */
interface Item { key: string; name: string; line: string; /** whether a line found in the registry is one TopoTopo wrote (any install) */ own: (line: string) => boolean }

/** The keys setup exports before it writes and when it looks for what is there: where its values live. */
const TOPS = ['.topo', '.topows', 'TopoTopo.Package', 'TopoTopo.Workspace', `Applications\\${EXE}`, 'Directory\\shell\\TopoTopo', 'Directory\\Background\\shell\\TopoTopo'];

const quote = (p: string) => `"${p}"`;

function planItems(launcher: string, node: string, icons: { package: string; workspace: string }): { items: Item[]; args: string } {
  const args = `--node ${quote(node)}`;
  const command = (arg: string) => `${quote(launcher)} ${args} ${quote(arg)}`;
  const items: Item[] = [];
  const add = (key: string, name: string, line: string, own: (line: string) => boolean = (l) => l === line) => items.push({ key, name, line, own });
  const runsLauncher = (l: string) => /topotopo-open\.exe/i.test(l);
  const isIcon = (l: string) => /topotopo-(package|workspace)\.ico/i.test(l);
  const kinds = [
    { ext: '.topo', progId: 'TopoTopo.Package', label: 'TopoTopo package', icon: icons.package },
    { ext: '.topows', progId: 'TopoTopo.Workspace', label: 'TopoTopo workspace', icon: icons.workspace },
  ];
  for (const k of kinds) {
    add(k.ext, '', sz('', k.progId));
    add(`${k.ext}\\OpenWithProgids`, k.progId, none(k.progId));
    add(k.progId, '', sz('', k.label));
    add(`${k.progId}\\DefaultIcon`, '', sz('', k.icon), isIcon);
    add(`${k.progId}\\shell\\open`, 'FriendlyAppName', sz('FriendlyAppName', 'TopoTopo'));
    add(`${k.progId}\\shell\\open\\command`, '', sz('', command('%1')), runsLauncher);
  }
  const app = `Applications\\${EXE}`;
  add(app, 'FriendlyAppName', sz('FriendlyAppName', 'TopoTopo'));
  add(`${app}\\SupportedTypes`, '.topo', sz('.topo', ''));
  add(`${app}\\SupportedTypes`, '.topows', sz('.topows', ''));
  add(`${app}\\shell\\open\\command`, '', sz('', command('%1')), runsLauncher);
  // %V of a folder's background is the folder, and of a drive's, `D:\`: inside quotes that ends in \" and reads as a quote
  // (the argument would be D:"). `%V\.` names the same folder either way (C:\x\. and D:\\.) and ends in a dot.
  for (const [key, arg] of [['Directory\\shell\\TopoTopo', '%1'], ['Directory\\Background\\shell\\TopoTopo', '%V\\.']]) {
    add(key, '', sz('', 'Open in TopoTopo'));
    add(key, 'Icon', sz('Icon', icons.package), isIcon);
    add(`${key}\\command`, '', sz('', command(arg)), runsLauncher);
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
  /** every value setup wrote: the .reg line it wrote, and what it replaced, also as the .reg line of that value (null: there was none) */
  values: { key: string; name: string; wrote: string; before: string | null }[];
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

/** The Start menu's Programs folder, or the folder the test override names (which must be a full path, never empty). */
const startMenuFolder = () => {
  const given = process.env.TOPOTOPO_SETUP_START_MENU;
  if (given !== undefined) {
    if (!path.win32.isAbsolute(given)) throw new Say(`TOPOTOPO_SETUP_START_MENU must be the full path of a folder (it is "${given}")`);
    return path.resolve(given);
  }
  if (!process.env.APPDATA) throw new Say('Windows has not said where your Start menu is (APPDATA is not set)');
  return path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
};

/** The key the file links are written under: the real one, or the test override. */
const classesKey = () => userKey(process.env.TOPOTOPO_SETUP_CLASSES ?? REAL_CLASSES, 'TOPOTOPO_SETUP_CLASSES');

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
    if (removing) return await remove(home, prog, io, (reg = new Registry()));

    if (arch !== 'x64') throw new Say(`the launcher is for x64 only so far, and this Node.js is ${arch}`);
    const root = path.resolve(o.root ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
    const launcher = path.join(root, 'launcher', 'win32-x64', EXE);
    const icons = { package: path.join(root, 'assets', 'icons', 'topotopo-package.ico'), workspace: path.join(root, 'assets', 'icons', 'topotopo-workspace.ico') };
    const absent = [launcher, icons.package, icons.workspace].filter((f) => !fs.existsSync(f)).map((f) => path.relative(root, f).replace(/\\/g, '/'));
    if (absent.length) throw new Say(`this TopoTopo install is missing ${absent.join(' and ')}: install TopoTopo again`);
    if (!fs.existsSync(path.join(root, 'dist', 'cli.js'))) throw new Say(`this is a source checkout that was never built (dist/cli.js is missing): run npm run build once, then ${prog} setup again`);

    const classes = classesKey();
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

/** The keys above the ones setup writes in, which Windows may have made for other programs. */
const SHARED_TOPS = ['Applications', 'Directory'];

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
  const lineNow = (it: { key: string; name: string }) => lineOf(sections, full(it.key), it.name);
  // a key under one of those that the export did not list is not there; the few above them are asked for
  const keyExists = (key: string) => sections.some((s) => s.key.toLowerCase() === full(key).toLowerCase()) || (!TOPS.some((t) => key === t || key.startsWith(`${t}\\`)) && reg.exists(full(key)));

  // Without a record (it was lost, or an older setup wrote none), what TopoTopo itself wrote earlier is TopoTopo's: a key
  // that holds only such values (and keys like it) was not there before, so --remove will take it away again.
  const everything = new Map<string, string[]>();
  const ownedOnly = new Map<string, boolean>();
  if (!existing) {
    for (const s of sections) everything.set(s.key.toLowerCase(), s.lines);
    for (const t of SHARED_TOPS) for (const s of reg.export(full(t)) ?? []) everything.set(s.key.toLowerCase(), s.lines);
  }
  const isOwn = (key: string, line: string) => items.some((it) => it.key.toLowerCase() === key.toLowerCase() && line.toLowerCase().startsWith(`${valueName(it.name).toLowerCase()}=`) && it.own(line));
  const onlyOurs = (key: string): boolean => {
    const k = full(key).toLowerCase();
    if (ownedOnly.has(k)) return ownedOnly.get(k)!;
    const lines = everything.get(k);
    const children = [...everything.keys()].filter((x) => x.startsWith(`${k}\\`) && !x.slice(k.length + 1).includes('\\'));
    const yes = !!lines && (lines.length > 0 || children.length > 0) && lines.every((l) => isOwn(key, l)) && children.every((ch) => onlyOurs(ch.slice(full('').length)));
    ownedOnly.set(k, yes);
    return yes;
  };
  for (const it of items) {
    for (const key of ancestry(it.key)) if (!rec.keys.some((k) => k.key === key)) rec.keys.push({ key, existed: keyExists(key) && !(!existing && onlyOurs(key)) });
    const cur = lineNow(it);
    const have = rec.values.find((v) => v.key === it.key && v.name === it.name);
    if (!have) rec.values.push({ key: it.key, name: it.name, wrote: it.line, before: cur !== null && !existing && it.own(cur) ? null : cur });
    else have.wrote = it.line;
  }
  const changes = items.filter((it) => lineNow(it) !== it.line);

  // the shortcut
  const lnk = path.join(c.startMenu, SHORTCUT);
  const icon = `${c.icons.package},0`;
  const sc = rec.shortcut;
  const shortcutOk = !!sc && sc.path === lnk && sc.target === c.launcher && sc.args === args && sc.icon === icon && fs.existsSync(lnk);

  // Windows' own choice of program, which setup never writes: one for TopoTopo is fine, one for another program wins
  const chosen: { ext: string; progId: string }[] = [], mine: string[] = [];
  for (const [ext, progId] of [['.topo', 'TopoTopo.Package'], ['.topows', 'TopoTopo.Workspace']]) {
    const have = userChoice(reg, c.fileExts, ext);
    if (have && ![progId, `Applications\\${EXE}`].some((p) => p.toLowerCase() === have.toLowerCase())) chosen.push({ ext, progId: have }); else mine.push(ext);
  }

  // the record first, so that a setup that stops part way can still be undone
  const recordText = JSON.stringify(rec, null, 2) + '\n';
  const recordNow = (() => { try { return fs.readFileSync(path.join(c.home, RECORD), 'utf8'); } catch { return null; } })();
  if (recordNow !== recordText) writeRecord(c.home, rec);
  try {
    reg.import([...new Set(changes.map((it) => it.key))].map((key) => ({ key: full(key), lines: changes.filter((it) => it.key === key).map((it) => it.line) })));
    if (!shortcutOk) {
      fs.mkdirSync(c.startMenu, { recursive: true });
      let replaced = sc?.replaced ?? false;
      // a file that is already there and is not TopoTopo's own shortcut (a lost record's) is kept for --remove to put back
      if (!sc && fs.existsSync(lnk) && !shortcutIsOurs(lnk)) {
        const backup = path.join(c.home, 'setup-backup');
        fs.mkdirSync(backup, { recursive: true });
        fs.copyFileSync(lnk, path.join(backup, SHORTCUT));
        replaced = true;
      }
      const r = powershell(SHORTCUT_SCRIPT, { TT_LNK: lnk, TT_TARGET: c.launcher, TT_ARGS: args, TT_ICON: c.icons.package });
      if (r.status !== 0 || !fs.existsSync(lnk)) throw new Say(`PowerShell could not make the Start menu entry (${(r.stderr || r.stdout).trim().split(/\r?\n/)[0] || `exit ${r.status}`})`);
      rec.shortcut = { path: lnk, target: c.launcher, args, icon, replaced };
      writeRecord(c.home, rec);
    }
    notify();
  } catch (e: any) {
    throw new Say(`${String(e?.message ?? e).split('\n')[0]}; setup stopped part way, and ${c.prog} setup --remove puts back what it had written`);
  }

  const again = !!existing && !changes.length && shortcutOk;
  const pick = (ext: string) => `right-click a ${ext} file, choose Open with, then TopoTopo, then Always`;
  const kept = chosen.map((x) => `${x.ext} files (${x.progId})`).join(' and ');
  io.out(chosen.length
    ? `${again ? 'already in place, nothing changed: ' : ''}the TopoTopo links are written, but Windows keeps your own choice of program for ${kept}, which no program may change for you: ${chosen.map((x) => pick(x.ext)).join('; ')}${mine.length ? `; ${mine.join(' and ')} files open in TopoTopo when double-clicked` : ''}`
    : `${again ? 'already in place, nothing changed: ' : ''}.topo packages and .topows workspaces now have the TopoTopo icons and open in TopoTopo when double-clicked`);
  io.out('folders have "Open in TopoTopo" in their right-click menu, and TopoTopo is in the Start menu');
  io.out(`to undo all of it: ${c.prog} setup --remove`);
  return 0;
}

/** Tell Explorer the associations changed, so it redraws icons (not when a test says so). */
function notify() {
  if (process.env.TOPOTOPO_SETUP_NO_NOTIFY === '1') return;
  // Explorer's redraw is a courtesy: a failure to send it does not undo the setup
  powershell(NOTIFY_SCRIPT, {});
}

async function remove(home: string, prog: string, io: Io, reg: Registry): Promise<number> {
  const rec = readRecord(home);
  if (!rec) {
    // links without a record (it was lost): said, not guessed at
    const classes = classesKey();
    if (reg.exists(`${classes}\\TopoTopo.Package`) || reg.exists(`${classes}\\TopoTopo.Workspace`)) {
      throw new Say(`TopoTopo file links exist but ${path.join(home, RECORD)} is missing, so what they replaced is not known: run ${prog} setup once, and then ${prog} setup --remove clears them`);
    }
    io.out(`nothing to remove: setup has not been run for this TopoTopo folder (${path.join(home, RECORD)} is missing)`);
    return 0;
  }
  const full = (key: string) => `${rec.classes}\\${key}`;
  const created = rec.keys.filter((k) => !k.existed).map((k) => k.key).sort((x, y) => x.split('\\').length - y.split('\\').length);
  // what is in the registry now: the keys setup writes in, and one export of each outermost key it made elsewhere
  const now = new Map<string, string[]>();
  const exportInto = (key: string) => { for (const sec of reg.export(full(key)) ?? []) now.set(sec.key.toLowerCase(), sec.lines); };
  for (const t of TOPS) exportInto(t);
  for (const k of created.filter((k) => !TOPS.some((t) => k === t || k.startsWith(`${t}\\`)) && !created.some((o) => o !== k && k.startsWith(`${o}\\`)))) exportInto(k);
  const sectionOf = (key: string) => full(key).toLowerCase();
  const currentLine = (v: { key: string; name: string }) => {
    const start = `${valueName(v.name)}=`.toLowerCase();
    return now.get(sectionOf(v.key))?.find((l) => l.toLowerCase().startsWith(start)) ?? null;
  };
  // a value is setup's to take back only while it is still what setup wrote; something else changed it otherwise
  const still = (v: SetupRecord['values'][number]) => v.wrote !== undefined && currentLine(v) === v.wrote;
  const changed = rec.values.filter((v) => !still(v));
  const mine = (key: string) => new Set(rec.values.filter((v) => v.key === key && v.before === null && still(v)).map((v) => valueName(v.name).toLowerCase()));
  // a key setup made goes, with what is under it, when it holds nothing but setup's own values and keys like it
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
  // the values setup wrote in keys that stay are deleted, and what it replaced is put back, unless something else changed them
  const keep: { key: string; lines: string[] }[] = [];
  for (const v of [...rec.values].reverse()) {
    if (gone.some((g) => v.key === g || v.key.startsWith(`${g}\\`)) || !still(v)) continue;
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
  if (changed.length) {
    const what = changed.map((v) => `${v.key}${v.name ? ` ${v.name}` : ' (default value)'}`).join(', ');
    io.out(`removed what setup wrote, except what something else has changed since and is left as it is: ${what}`);
  } else io.out('removed the TopoTopo file links, the folder menu entry and the Start menu entry: everything is as it was before setup');
  return 0;
}
