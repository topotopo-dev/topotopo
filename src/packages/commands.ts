// The web app's commands (src/cli.ts dispatches here):
//   topotopo web [--port 7340] [--library <folder>] [--no-bake]       the web app on 127.0.0.1
//   topotopo library add <name> <folder>                             register a folder as a library (~/.topotopo/config.json)
//   topotopo library list                                            the registered libraries, their packages and problems
//   topotopo library new <library> <folder/name> [--title t] [--tags a,b] [--description d]
//   topotopo library bake <package folder> | --stale | --all          bake previews in this process
//   topotopo edit [folder] [--port 7341] [--json]                     the live viewer on a package (the web app's editor)
// and the packages a package uses (src/packages/registry.ts, src/packages/update.ts), as PACKAGE_COMMANDS says them:
//   topotopo workspace [folder]                                       the workspace (game) around a folder
//   topotopo workspace init [folder] [--name n] [--engine godot:<path>|unreal:<path>|none] [--assets <folder>] [--library <folder or name>] [--follow | --no-follow]
//                                                                     make a game's folder a workspace, or change one
//   topotopo workspace add|list [folder]                              register a workspace for the web app's front page; list them
//   topotopo init [folder] [--name owner/name]                        make a folder a package, or set the name it publishes under
//   topotopo libraries add|remove <folder or name> [folder]           the libraries the package finds packages in
//   topotopo use owner/name [folder] [--version 1.1]                  add a package from the libraries the package lists
//   topotopo remove owner/name [folder]                               remove a package no graph of the package names
//   topotopo packages [owner/name] [folder]                           what the package uses and can use; one package
//   topotopo publish [folder] --note "..." [--big] [--dry-run]        publish the next version of the package
//   topotopo search [words] [folder] [--kind k] [--tag t]             the outputs of every library, for the package
//   topotopo outdated [folder]                                        the newer versions of what it uses, with their notes
//   topotopo check [folder]                                           cook what the workspace relies on; what broke and why
//   topotopo update owner/name [folder] [--to 1.4] [--render <folder>]           the before/after of an update
//   topotopo update owner/name [folder] --from 1.3 --to 1.4 --apply              apply the update you looked at
// A folder named must exist (a package's folder, or one inside it); without one, the current folder's package. Each
// package command returns its exit code and says what it did through an Io (the console by default), so that tests
// run them in this process.
import fs from 'node:fs';
import path from 'node:path';
import { KINDS } from '../graph/outputs.ts';
import { parsePackageName } from '../graph/scope.ts';
import { addLibrary, loadConfig } from '../config.ts';
import { createPackage, isStale, readBakeState, scanAll } from '../web/library.ts';
import { initPackage, libraryEntryFor, manifestFile, oldManifestAbove, packageDirOf, readManifest, slugify } from '../package.ts';
import type { WebConfig } from '../config.ts';

/**
 * The package commands as every list of them says them: src/cli.ts (its header and --help), this file's header, the
 * help topic "packages" and README.md, each of which holds every usage as it is here (test/docs.ts checks).
 */
export const PACKAGE_COMMANDS: { usage: string; what: string }[] = [
  { usage: 'workspace [folder]', what: 'the workspace (the game) around a folder: its engine project, the libraries every package inside looks in, its packages' },
  { usage: 'workspace init [folder] [--name n] [--engine godot:<path>|unreal:<path>|none] [--assets <folder>] [--library <folder or name>] [--follow | --no-follow]', what: 'make a game\'s folder a workspace (topotopo-workspace.json; the engine project is found when not given; its packages share one copy of each package, moved into topotopo-packages/; --follow shows its own packages live from their working folders, for looking), or change one' },
  { usage: 'workspace add|list [folder]', what: 'register a workspace by its name for the web app\'s front page, or list the registered ones' },
  { usage: 'init [folder] [--name owner/name]', what: 'make a folder a package (<id>.topo, graphs/main.json), or set the name an existing package publishes under' },
  { usage: 'libraries add|remove <folder or name> [folder]', what: 'list or unlist a library the package finds packages in: a folder by its path from the package, else a registered library\'s name' },
  { usage: 'use owner/name [folder] [--version 1.1]', what: 'add a package: its newest version (or --version) in the libraries the package lists, copied into packages/' },
  { usage: 'remove owner/name [folder]', what: 'remove a package no graph of the package names: its copy goes, with the copies nothing else uses' },
  { usage: 'packages [owner/name] [folder]', what: 'what the package uses and can use, one line each; with a package, its versions and its outputs' },
  { usage: 'publish [folder] --note "..." [--big] [--dry-run]', what: 'publish the next version of the package into versions/; --dry-run checks everything and writes nothing' },
  { usage: 'search [words] [folder] [--kind k] [--tag t]', what: 'the outputs of every library, and whether the package can use them' },
  { usage: 'outdated [folder]', what: 'the packages it uses that have newer versions, with their notes' },
  { usage: 'check [folder]', what: 'cook the newest version of every package in the workspace\'s (or the package\'s) libraries, and every graph of its packages; list what broke and why, changing nothing' },
  { usage: 'update owner/name [folder] [--to 1.4] [--render <folder>]', what: 'the before/after of an update: every place the package uses it, cooked with both versions; nothing is written' },
  { usage: 'update owner/name [folder] --from 1.3 --to 1.4 --apply', what: 'apply the update you looked at: copy it in, set "uses" and the lock, delete the copies nothing uses' },
];

/** Where a command says what it did (out) and what went wrong (err). */
export interface Io { out(s: string): void; err(s: string): void }
export const consoleIo: Io = { out: (s) => console.log(s), err: (s) => console.error(s) };

/** A command's failure, said on stderr: exit code 1. */
class Fail extends Error {}
const fail = (msg: string): never => { throw new Fail(msg); };

/** A command: its exit code, or nothing for one that keeps running (a server). */
export type Command = (argv: string[], prog: string, io?: Io) => Promise<number | void>;

/** Run a command's body: a failure, or any error it throws, is said on stderr and exits 1. */
async function run(io: Io, f: () => Promise<number | void>): Promise<number | void> {
  try { return await f(); } catch (e: any) { io.err(String(e?.message ?? e)); return 1; }
}

/**
 * A command's arguments: its options (`valued` take the next argument as their value, `flags` none) and the rest in
 * order. An unknown option, or a valued one without its value, fails with the usage.
 */
function args(argv: string[], valued: string[], flags: string[], usage: string) {
  const opts = new Map<string, string>(), many = new Map<string, string[]>(), rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { rest.push(a); continue; }
    if (flags.includes(a)) { opts.set(a, ''); continue; }
    if (!valued.includes(a)) fail(`unknown option ${a}\n${usage}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) fail(`${a} needs a value\n${usage}`);
    opts.set(a, v);
    many.set(a, [...(many.get(a) ?? []), v]);
    i++;
  }
  // opt: the option's (last) value; all: every value of an option given more than once
  return { opt: (f: string) => opts.get(f), all: (f: string) => many.get(f) ?? [], has: (f: string) => opts.has(f), rest };
}

/**
 * The package a command acts on: the folder named (which must exist; a folder inside a package acts on that package),
 * else the current folder's. Fails for a folder in no package, saying how to make one.
 */
function packageOf(folder: string | undefined, prog: string): string {
  const abs = path.resolve(folder ?? '.');
  if (folder !== undefined && !isDir(abs)) fail(`no folder ${abs}`);
  return packageDirOf(abs) ?? fail(`${abs} is in no package: ${prog} init${folder === undefined ? '' : ` ${quoted(folder)}`} makes the folder a package (<id>.topo)${oldManifestAbove(abs)}`);
}

const isDir = (abs: string) => !!fs.statSync(abs, { throwIfNoEntry: false })?.isDirectory();
/** "owner/name", a package (no output) */
const isPackage = (s: string) => { const n = parsePackageName(s); return typeof n !== 'string' && n.output === null; };
/** A folder argument that is a version ("1.1", "2") and no folder: what was meant, said. */
const versionGiven = (folder: string | undefined, meant: string) => {
  if (folder !== undefined && /^\d+(\.\d+)?$/.test(folder) && !isDir(path.resolve(folder))) fail(`"${folder}" is no folder here: ${meant}`);
};

/** The packages a package uses, in an engine of their own (its worker pool closed by `close`). */
async function usesOfPackage(folder: string) {
  const { Engine } = await import('../graph/engine.ts');
  const { createNodeHost } = await import('../host/node.ts');
  const { openPackages } = await import('./registry.ts');
  const engine = new Engine(createNodeHost({ baseDir: folder }));
  await engine.init();
  return { engine, pk: openPackages(engine, folder), close: async () => { await engine.host.pool?.close(); } };
}

const quoted = (s: string) => (/[\s"]/.test(s) ? JSON.stringify(s) : s);

// ---------------------------------------------------------------------------------------------------- the web app

export async function webCommand(argv: string[], prog: string, io: Io = consoleIo): Promise<number | void> {
  return run(io, async () => {
    const a = args(argv, ['--port', '--library'], ['--no-bake'], `usage: ${prog} web [--port 7340] [--library <folder>] [--no-bake]`);
    let cfg: WebConfig = loadConfig();
    const extra = a.opt('--library');
    if (extra) {
      const name = slugify(path.basename(path.resolve(extra))) || 'library';
      cfg = { ...cfg, libraries: [...cfg.libraries.filter((l) => l.name !== name), { name, path: path.resolve(extra) }] };
    }
    if (!cfg.libraries.length) io.out(`no libraries yet: register a folder with \`${prog} library add <name> <folder>\` (or pass --library <folder>)`);
    const port = a.opt('--port') !== undefined ? Number(a.opt('--port')) : cfg.web.port;
    const { startWeb, runningWeb } = await import('../web/server.ts');
    try {
      const g = await startWeb({ config: cfg, port, bake: !a.has('--no-bake'), log: (m) => io.out(m) });
      const n = cfg.libraries.length;
      io.out(`web app: ${g.url}  (${n} librar${n === 1 ? 'y' : 'ies'}: ${cfg.libraries.map((l) => `${l.name} → ${l.path}`).join(', ') || 'none'}; Ctrl+C to stop)`);
      if (g.queue.size) io.out(`baking ${g.queue.size} package(s) in the background`);
    } catch (e: any) {
      if (e?.code !== 'EADDRINUSE') throw e;
      const url = await runningWeb(port);
      if (url) { io.out(`web app: ${url}  (already running)`); return 0; }
      fail(`port ${port} is taken by another program: pass --port, or set "web": {"port": N} in ${cfg.file}`);
    }
  });
}

export async function libraryCommand(argv: string[], prog: string, io: Io = consoleIo): Promise<number | void> {
  return run(io, async () => {
    const usage = `usage: ${prog} library add <name> <folder> | list | new <library> <folder/name> [--title t] [--tags a,b] [--description d] | bake <package folder> | bake --stale | bake --all`;
    const a = args(argv, ['--title', '--tags', '--description'], ['--stale', '--all'], usage);
    const [sub, x, y] = a.rest;
    let cfg = loadConfig();
    if (sub === 'add') {
      if (!x || !y) fail(usage);
      cfg = addLibrary(x, y);
      io.out(`library ${x} → ${path.resolve(y)} (in ${cfg.file})`);
      return 0;
    }
    if (sub === 'list') {
      if (!cfg.libraries.length) io.out(`no libraries (config ${cfg.file}): ${prog} library add <name> <folder>`);
      for (const s of scanAll(cfg)) {
        io.out(`${s.name}  ${s.root}  (${s.packages.length} packages)`);
        for (const p of s.packages) {
          const st = readBakeState(p.dir);
          const status = !st ? 'not baked' : !st.ok ? 'bake failed' : isStale(p) ? 'stale' : 'baked';
          io.out(`  ${p.id.padEnd(24)} ${p.rel.padEnd(32)} ${status}${p.manifest.tags.length ? '  [' + p.manifest.tags.join(', ') + ']' : ''}`);
        }
        for (const pr of s.problems) io.out(`  ! ${pr}`);
      }
      return 0;
    }
    if (sub === 'new') {
      if (!x || !y) fail(usage);
      const lib = cfg.libraries.find((l) => l.name === x) ?? fail(`no library "${x}" (${cfg.libraries.map((l) => l.name).join(', ') || `none: ${prog} library add <name> <folder>`})`);
      const p = createPackage(lib, y, { title: a.opt('--title'), description: a.opt('--description'), tags: a.opt('--tags')?.split(',').map((t) => t.trim()).filter(Boolean) });
      io.out(`package ${p.lib}/${p.id} → ${p.dir}`);
      io.out(`  page: http://127.0.0.1:${cfg.web.port}/p/${p.lib}/${p.id}`);
      return 0;
    }
    if (sub === 'bake') {
      const { bakePackage } = await import('../web/bake.ts');
      let dirs: string[];
      if (a.has('--all') || a.has('--stale')) dirs = scanAll(cfg).flatMap((s) => s.packages).filter((p) => a.has('--all') || isStale(p)).map((p) => p.dir);
      else if (x) dirs = [packageOf(x, prog)];
      else return fail(usage);
      let failed = 0;
      for (const d of dirs) {
        const s = await bakePackage(d);
        if (!s.ok) failed++;
        io.out(`${s.ok ? 'ok  ' : 'FAIL'} ${d}  ${s.ok ? `${s.ms} ms, ${s.points} points, ${s.prims} prims${s.glb ? '' : ', no preview.glb'}` : s.error}`);
      }
      if (!dirs.length) io.out('nothing to bake');
      return failed ? 1 : 0;
    }
    fail(usage);
  });
}

/** `edit [folder]`: the live viewer on a package, following changes other processes make to it. */
export async function editCommand(argv: string[], prog: string, io: Io = consoleIo): Promise<number | void> {
  return run(io, async () => {
    const a = args(argv, ['--port'], ['--json'], `usage: ${prog} edit [folder] [--port 7341] [--json]`);
    const dir = packageOf(a.rest[0], prog);
    const { Engine } = await import('../graph/engine.ts');
    const { createNodeHost } = await import('../host/node.ts');
    const { openPackage } = await import('../open.ts');
    const { startViewer } = await import('../viewer/server.ts');
    const engine = new Engine(createNodeHost({ baseDir: dir }));
    await engine.init();
    const ws = openPackage(engine, dir, { watch: true }).session;
    const v = await startViewer(ws, a.opt('--port') !== undefined ? Number(a.opt('--port')) : undefined);
    if (a.has('--json')) {
      // started by the web app: report the URL, and stop once no page has been open for a while
      io.out(JSON.stringify({ url: v.url }));
      let idleSince = Date.now();
      setInterval(() => {
        if (v.clients() > 0) idleSince = Date.now();
        else if (Date.now() - idleSince > 10 * 60_000) { v.close(); process.exit(0); }
      }, 30_000);
    } else io.out(`edit: ${v.url}  (${dir}; Ctrl+C to stop)`);
  });
}

// ---------------------------------------------------------------------------------------------------- packages

/** `init [folder] [--name owner/name]`: make a folder a package, or set the name an existing package publishes under. */
export async function initCommand(argv: string[], prog: string, io: Io = consoleIo): Promise<number> {
  return (await run(io, async () => {
    const a = args(argv, ['--name'], [], `usage: ${prog} init [folder] [--name owner/name]`);
    const r = initPackage(a.rest[0] ?? '.', { name: a.opt('--name') });
    io.out(r.said);
    if (!/ publishes as \S+ (already|now)$/.test(r.said))
      io.out(`  graphs go in graphs/ (it shows "${r.manifest.graph}"); ${prog} libraries add <folder> lists a library it finds packages in; TopoTopo's own packages need none`);
    return 0;
  })) ?? 0;
}

/** `libraries add|remove <folder or registered name> [folder]`: the libraries the package lists, as the person says. */
export async function librariesCommand(argv: string[], prog: string, io: Io = consoleIo): Promise<number> {
  return (await run(io, async () => {
    const usage = `usage: ${prog} libraries add <library folder or registered name> [folder] | remove <library> [folder]`;
    const a = args(argv, [], [], usage);
    const [sub, given, folder] = a.rest;
    if ((sub !== 'add' && sub !== 'remove') || !given) fail(usage);
    const packageDir = packageOf(folder, prog);
    const listed = readManifest(packageDir).libraries;
    const { pk, close } = await usesOfPackage(packageDir);
    try {
      if (sub === 'add') {
        const entry = libraryEntryFor(packageDir, given);
        if (listed.includes(entry)) { io.out(`${path.basename(manifestFile(packageDir))} lists "${entry}" already`); return 0; }
        io.out(pk.setLibraries([...listed, entry]));
      } else {
        // the entry as listed, or the folder or registered name it stands for
        const abs = path.resolve(given);
        const entry = listed.find((e) => e === given || e === given.replace(/\\/g, '/') || path.resolve(packageDir, e) === abs);
        if (!entry) fail(`${path.basename(manifestFile(packageDir))} does not list "${given}": it lists ${listed.map((e) => `"${e}"`).join(', ') || 'no libraries'}`);
        io.out(pk.setLibraries(listed.filter((e) => e !== entry)));
      }
      return 0;
    } finally { await close(); }
  })) ?? 0;
}

/** `use owner/name [folder] [--version 1.1]`: add a package to those the package uses, from the libraries it lists. */
export async function useCommand(argv: string[], prog: string, io: Io = consoleIo): Promise<number> {
  return (await run(io, async () => {
    const usage = `usage: ${prog} use owner/name [folder] [--version 1.1]`;
    const a = args(argv, ['--version'], [], usage);
    const [pkg, folder] = a.rest;
    if (!pkg) fail(usage);
    versionGiven(folder, `a version is named with --version, ${prog} use ${pkg} --version ${/^\d+$/.test(folder ?? '') ? `${folder}.0` : folder}`);
    const { pk, close } = await usesOfPackage(packageOf(folder, prog));
    try {
      io.out(pk.use(pkg, { version: a.opt('--version') }).text);
      for (const p of pk.check()) io.err(`warning: ${p}`);
      return 0;
    } finally { await close(); }
  })) ?? 0;
}

/** `remove owner/name [folder]`: remove a package no graph of the package names any more. */
export async function removeCommand(argv: string[], prog: string, io: Io = consoleIo): Promise<number> {
  return (await run(io, async () => {
    const usage = `usage: ${prog} remove owner/name [folder]`;
    const [pkg, folder] = args(argv, [], [], usage).rest;
    if (!pkg) fail(usage);
    const { removePackage } = await import('./update.ts');
    const { pk, close } = await usesOfPackage(packageOf(folder, prog));
    try { io.out(removePackage(pk, pkg).text); return 0; } finally { await close(); }
  })) ?? 0;
}

/** `packages [owner/name] [folder]`: what the package uses and can use, one line each; or one package with its outputs. */
export async function packagesCommand(argv: string[], prog: string, io: Io = consoleIo): Promise<number> {
  return (await run(io, async () => {
    const a = args(argv, [], [], `usage: ${prog} packages [owner/name] [folder]`);
    // a package name first (one that is no folder here), then the folder
    const first = a.rest[0], named = first !== undefined && isPackage(first) && !isDir(path.resolve(first));
    const pkg = named ? first : undefined, folder = named ? a.rest[1] : a.rest[0];
    const { packagesText, packageText } = await import('./registry.ts');
    const { pk, close } = await usesOfPackage(packageOf(folder, prog));
    try { io.out(pkg ? packageText(pk, pkg) : packagesText(pk)); return 0; } finally { await close(); }
  })) ?? 0;
}

/**
 * `publish [folder] --note "..." [--big] [--dry-run]`: publish the next version of the package; --dry-run
 * says what publishing would do and writes nothing.
 */
export async function publishCommand(argv: string[], prog: string, io: Io = consoleIo): Promise<number> {
  return (await run(io, async () => {
    const a = args(argv, ['--note'], ['--big', '--dry-run'], `usage: ${prog} publish [folder] --note "what changed" [--big] [--dry-run]`);
    const { publishPackage, publishText } = await import('./registry.ts');
    const { pk, close } = await usesOfPackage(packageOf(a.rest[0], prog));
    try {
      const r = await publishPackage(pk, { note: a.opt('--note'), big: a.has('--big'), dryRun: a.has('--dry-run') });
      io.out(publishText(r));
      return r.ok ? 0 : 1;
    } finally { await close(); }
  })) ?? 0;
}

/**
 * `search [words] [folder] [--kind k] [--tag t]`: the outputs of every library, and whether the package can use them.
 * The folder is written as a path (".", "./forest", "../forest", an absolute path), so that a word is never one.
 */
export async function searchCommand(argv: string[], prog: string, io: Io = consoleIo): Promise<number> {
  return (await run(io, async () => {
    const a = args(argv, ['--kind', '--tag'], [], `usage: ${prog} search [words] [folder] [--kind ${KINDS.join('|')}] [--tag t]`);
    const asPath = (s: string) => s === '.' || s === '..' || /^\.\.?[\\/]/.test(s) || path.isAbsolute(s) || /^[A-Za-z]:/.test(s);
    const last = a.rest.at(-1), folder = last !== undefined && asPath(last) ? last : undefined;
    const words = folder === undefined ? a.rest : a.rest.slice(0, -1);
    if (folder !== undefined && !isDir(path.resolve(folder))) fail(`no folder ${path.resolve(folder)}`);
    const { searchPackages, searchText } = await import('./registry.ts');
    io.out(searchText(searchPackages(packageDirOf(path.resolve(folder ?? '.')), { query: words.join(' '), kind: a.opt('--kind'), tag: a.opt('--tag') })));
    return 0;
  })) ?? 0;
}

/** `outdated [folder]`: the packages it uses that have newer versions, with their notes. */
export async function outdatedCommand(argv: string[], prog: string, io: Io = consoleIo): Promise<number> {
  return (await run(io, async () => {
    const folder = args(argv, [], [], `usage: ${prog} outdated [folder]`).rest[0];
    const { outdatedText } = await import('./update.ts');
    const { pk, close } = await usesOfPackage(packageOf(folder, prog));
    try { io.out(outdatedText(pk, false, folder)); return 0; } finally { await close(); }
  })) ?? 0;
}

/**
 * `check [folder]`: cook the newest version of every package in the libraries of the workspace around the folder (or
 * of its package), and every graph of its packages; say what broke and why. Writes nothing; exit code 1 when something
 * broke (a build machine runs it after updating TopoTopo).
 */
export async function checkCommand(argv: string[], prog: string, io: Io = consoleIo): Promise<number> {
  return (await run(io, async () => {
    const folder = args(argv, [], [], `usage: ${prog} check [folder]`).rest[0];
    const at = path.resolve(folder ?? '.');
    if (folder !== undefined && !fs.existsSync(at)) fail(`${at} does not exist`);
    const { checkAll, checkText } = await import('./check.ts');
    const r = await checkAll(at, { progress: (what) => io.err(`checking ${what}`) });
    io.out(checkText(r));
    return r.items.some((i) => i.failures.length) ? 1 : 0;
  })) ?? 0;
}

/**
 * `update owner/name [folder] [--to <version>] [--render <folder>]`: the before/after of updating a package in
 * use, which writes nothing (--render writes its overlay renders into a folder); `--from <version> --to <version>
 * --apply` applies the update whose before/after the person saw. Ctrl+C stops a long before/after at the next node.
 * Nothing to update is no failure.
 */
export async function updateCommand(argv: string[], prog: string, io: Io = consoleIo): Promise<number> {
  return (await run(io, async () => {
    const usage = `usage: ${prog} update owner/name [folder] [--to <version>] [--render <folder>]   (the before/after)\n       ${prog} update owner/name [folder] --from <version> --to <version> --apply   (apply the update you looked at)`;
    const a = args(argv, ['--to', '--from', '--render'], ['--apply'], usage);
    const [pkg, folder] = a.rest;
    if (!pkg) fail(usage);
    versionGiven(folder, `a version is named with --to, ${prog} update ${pkg} --to ${/^\d+$/.test(folder ?? '') ? `${folder}.0` : folder}`);
    const { applyUpdate, beforeAfter, beforeAfterText, overlayRenders } = await import('./update.ts');
    const { NothingToUpdate, loadPackage } = await import('./registry.ts');
    const packageDir = packageOf(folder, prog);
    const { engine, pk, close } = await usesOfPackage(packageDir);
    try {
      if (a.has('--apply')) {
        const from = a.opt('--from'), to = a.opt('--to');
        if (!from || !to) fail(`--apply needs --from and --to: the version in use and the version of the before/after you looked at (the before/after ends with the command)\n${usage}`);
        io.out(applyUpdate(pk, pkg, { from: from!, to: to! }).text);
        return 0;
      }
      if (a.has('--from')) fail(`--from goes with --apply\n${usage}`);
      for (const p of loadPackage(engine, packageDir)) io.err(`warning: ${p}`);
      const stop = { aborted: false };
      const onStop = () => { stop.aborted = true; io.err('stopping at the next node (Ctrl+C again ends it at once); nothing is written'); };
      process.once('SIGINT', onStop);
      let r;
      try { r = await beforeAfter(pk, pkg, { to: a.opt('--to'), signal: stop, progress: (done, total, what) => io.err(`[${done + 1}/${total}] ${what}`) }); }
      finally { process.off('SIGINT', onStop); }
      const again = `${prog} ${['update', pkg, ...(folder ? [folder] : []), '--from', r.target.from, '--to', r.target.to, '--apply'].map(quoted).join(' ')}`;
      io.out(beforeAfterText(r, `nothing was written. To apply it: ${again}`));
      const renders = overlayRenders(r, Infinity), dir = a.opt('--render');
      if (dir && renders.length) {
        fs.mkdirSync(path.resolve(dir), { recursive: true });
        const files = renders.map((x, i) => {
          const file = path.join(path.resolve(dir), `${String(i + 1).padStart(2, '0')}-${x.title.replace(/[^A-Za-z0-9_.-]+/g, '_')}.png`);
          fs.writeFileSync(file, x.png);
          return file;
        });
        io.out([`overlay renders (grey: the same with both, blue: only with ${r.target.to}, orange: only with ${r.target.from}):`, ...files.map((f) => `  ${f}`)].join('\n'));
      } else if (renders.length) io.out(`--render <folder> writes an overlay render of each place that changed`);
      return r.stopped ? 1 : 0;
    } catch (e) {
      if (e instanceof NothingToUpdate) { io.out(e.message); return 0; }
      throw e;
    } finally { await close(); }
  })) ?? 0;
}

/** The commands src/cli.ts dispatches here, by name. */
/** `workspace [folder]`, `workspace init …`, `workspace add|list`: the game a package sits in (src/workspace.ts). */
const workspaceCommand: Command = (argv, prog, io = consoleIo) => run(io, async () => {
  const { initWorkspace, workspaceText, readWorkspace } = await import('../workspace.ts');
  const { addWorkspace } = await import('../config.ts');
  const { locate } = await import('../package.ts');
  const sub = ['init', 'add', 'list'].includes(argv[0]) ? argv[0] : 'show';
  const a = args(sub === 'show' ? argv : argv.slice(1), ['--name', '--engine', '--assets', '--library'], ['--follow', '--no-follow'], `usage: ${prog} workspace [folder] | workspace init [folder] [--name n] [--engine godot:<path>|unreal:<path>|none] [--assets <folder>] [--library <folder or name>] [--follow | --no-follow] | workspace add|list [folder]`);
  const folder = path.resolve(a.rest[0] ?? '.');
  if (a.rest[0] !== undefined && !fs.existsSync(folder)) fail(`${folder} does not exist`);
  if (sub === 'init') {
    if (a.has('--follow') && a.has('--no-follow')) fail('--follow or --no-follow, not both');
    const r = initWorkspace(folder, { name: a.opt('--name'), engine: a.opt('--engine'), assets: a.opt('--assets'), libraries: a.all('--library'), follow: a.has('--follow') ? true : a.has('--no-follow') ? false : undefined });
    io.out(r.text);
    io.out(`next: ${prog} workspace add ${a.rest[0] ?? '.'} lists it on the web app's front page`);
    return 0;
  }
  if (sub === 'add') {
    const ws = locate(folder).workspace;
    if (!ws) fail(`${folder} is in no workspace: ${prog} workspace init <folder> makes one`);
    const m = readWorkspace(ws!);
    const cfg = addWorkspace(m.name, ws!);
    io.out(`registered the workspace "${m.name}" (${ws}) in ${cfg.file}`);
    return 0;
  }
  if (sub === 'list') {
    const { loadConfig } = await import('../config.ts');
    const cfg = loadConfig();
    io.out(cfg.workspaces.length ? cfg.workspaces.map((w) => `${w.name}  ${w.path}`).join('\n') : `no workspaces registered (${cfg.file}): ${prog} workspace add <folder>`);
    return 0;
  }
  io.out(workspaceText(folder));
  return 0;
});

export const commands: Record<string, Command> = {
  web: webCommand, library: libraryCommand, edit: editCommand, workspace: workspaceCommand, init: initCommand, libraries: librariesCommand, use: useCommand,
  remove: removeCommand, packages: packagesCommand, publish: publishCommand, search: searchCommand, outdated: outdatedCommand, check: checkCommand, update: updateCommand,
};
