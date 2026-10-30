// A package: a folder holding project.json, with the folders TopoTopo works with (graphs/ assets/ inputs/ exports/) and,
// when it publishes versions or uses packages, its published versions/ and the copies in packages/ (src/packages/). Reading
// and writing project.json, finding the package a folder belongs to, the libraries it lists, making a folder a package
// (init, and the MCP server's rule when it starts), and the lock its package commands hold while they write.
import fs from 'node:fs';
import path from 'node:path';
import { ID_RE, parsePackageName } from './graph/scope.ts';
import { NAME_RE, PACKAGE_FOLDERS, graphFiles } from './session.ts';
import { BUILTIN_LIBRARY, loadConfig } from './config.ts';
import { readWorkspace, writeWorkspace } from './workspace.ts';
import type { WebConfig } from './config.ts';

/** a package version: big.small, from 1.0 */
export const VERSION_RE = /^[1-9]\d*\.(0|[1-9]\d*)$/;

let PROGRAM = 'topotopo';
/**
 * The command a person runs TopoTopo with, as hints name it: "topotopo" installed, "node src/cli.ts" from a clone. The
 * CLI and the MCP server set it from how they were started.
 */
export const program = () => PROGRAM;
export const setProgram = (p: string) => { PROGRAM = p; };

/** Wait `ms` without giving up the thread (a short retry between file operations). */
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Rename a file or folder into place. On Windows a file watcher, an editor or a virus scanner holding a file in it
 * makes the rename fail for a moment (EPERM, EBUSY, EACCES): it is tried again for about two seconds, and then fails
 * with a plain message.
 */
export function renameInto(from: string, to: string) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(from, to); return; }
    catch (e: any) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e?.code)) throw e;
      if (i >= 8) throw new Error(`could not move ${from} to ${to}: another program (a file watcher, an editor, a virus scanner) holds a file there; close it or wait a moment, then try again`);
      pause(Math.min(400, 25 * 2 ** i));
    }
  }
}

/** How long a package's lock may be held before another process takes it as left behind by one that ended. */
const STALE_LOCK_MS = 120_000;

/**
 * Run `f` holding the package's lock, .lock in the folder of its copies (copiesFor: packages/, or the workspace's
 * topotopo-packages/ for a package that shares the workspace's copies), a file only one process can create at a time:
 * the CLI, the MCP server and the viewer read, change and write project.json, the uses and the lock under it, so that
 * none loses another's change. Waits up to about ten seconds for another holder; a lock older than two minutes, or
 * whose process has ended, is taken over. Held again by the same process (a nested call), it just runs `f`.
 */
export function withPackageLock<T>(dir: string, f: () => T): T {
  return withStoreLock(copiesFor(dir), f);
}

/** Run `f` holding the lock of a store of copies (withPackageLock). */
export function withStoreLock<T>(store: CopyStore, f: () => T): T {
  return withLockFile(path.join(store.packages, '.lock'), f);
}

const heldLocks = new Set<string>();
function withLockFile<T>(file: string, f: () => T): T {
  if (heldLocks.has(file)) return f();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let waited = 0; ; ) {
    try {
      fs.writeFileSync(file, `${process.pid} ${new Date().toISOString()}\n`, { flag: 'wx' });
      break;
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
      let stale = false;
      try {
        const [pid] = fs.readFileSync(file, 'utf8').split(' ');
        const age = Date.now() - fs.statSync(file).mtimeMs;
        let alive = true;
        try { process.kill(Number(pid), 0); } catch (k: any) { alive = k?.code === 'EPERM'; }
        stale = age > STALE_LOCK_MS || !alive || Number(pid) === process.pid;
      } catch { /* removed meanwhile: try again */ }
      if (stale) { fs.rmSync(file, { force: true }); continue; }
      if (waited > 10_000) throw new Error(`${file} is held by another TopoTopo process (the viewer, an MCP server or a command) changing the packages this package uses; try again when it is done, or delete the file if no such process runs`);
      pause(50);
      waited += 50;
    }
  }
  heldLocks.add(file);
  try { return f(); } finally { heldLocks.delete(file); fs.rmSync(file, { force: true }); }
}

export interface PackageLink { label: string; url: string }
export interface PackageManifest {
  id: string;
  title: string;
  description: string;
  tags: string[];
  /** the graph its page shows and bakes */
  graph: string;
  /** what to bake instead of the graph's output: another graph, a node, a frame (simulations settle after frame 1) */
  bake: { graph?: string; node?: string; frame?: number };
  /** links back to the board, concept pages, tickets */
  links: PackageLink[];
  /** ISO date */
  created: string;
  /** the name the package publishes under, "owner/name": set by the author before the first publish, never derived */
  package?: string;
  /** the packages its graphs use, with the version in use: {"owner/name": "1.3"} (written by the tools) */
  uses: Record<string, string>;
  /** where it finds packages to add: paths relative to the package (a library in the same repository) or registered library names */
  libraries: string[];
}

export const slugify = (s: string) =>
  s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 64);

// ------------------------------------------------------------------------------------------------------- manifests

const str = (v: unknown, key: string, def = ''): string => {
  if (v === undefined || v === null) return def;
  if (typeof v !== 'string') throw new Error(`"${key}" must be a string`);
  return v;
};

/** "owner/name": a package name (no output). */
export const isPackageName = (s: string) => { const n = parsePackageName(s); return typeof n !== 'string' && n.output === null; };

/**
 * A "uses" map checked ({"owner/name": "1.3"}), sorted by name; throws naming the entry that is wrong (`where`: the file
 * it is in, when it is not project.json).
 */
export function parseUses(v: unknown, where = ''): Record<string, string> {
  const at = where ? `${where}: ` : '';
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error(`${at}"uses" must be {"owner/name": "1.3"}`);
  for (const [k, x] of Object.entries(v)) {
    if (!isPackageName(k)) throw new Error(`${at}"uses": "${k}" is not a package name (owner/name)`);
    if (typeof x !== 'string' || !VERSION_RE.test(x)) throw new Error(`${at}"uses": "${k}" needs a version such as "1.3", got ${JSON.stringify(x)}`);
  }
  return Object.fromEntries(Object.entries(v as Record<string, string>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** project.json checked and normalised; throws naming the problem. `fallbackId` is used when it has no id. */
export function parseManifest(raw: any, fallbackId: string): PackageManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('project.json must be an object');
  const id = str(raw.id, 'id', fallbackId);
  if (!ID_RE.test(id)) throw new Error(`"id" "${id}" must match ${ID_RE}`);
  const graph = str(raw.graph, 'graph', 'main');
  if (!NAME_RE.test(graph)) throw new Error(`"graph" "${graph}" must be a graph name (${NAME_RE})`);
  const tags = raw.tags ?? [];
  if (!Array.isArray(tags) || tags.some((t: unknown) => typeof t !== 'string')) throw new Error('"tags" must be a list of strings');
  const links = raw.links ?? [];
  if (!Array.isArray(links) || links.some((l: any) => !l || typeof l.url !== 'string')) throw new Error('"links" must be a list of {"label", "url"}');
  const b = raw.bake ?? {};
  if (typeof b !== 'object' || Array.isArray(b)) throw new Error('"bake" must be {graph?, node?, frame?}');
  const bake: PackageManifest['bake'] = {};
  if (b.graph !== undefined) { bake.graph = str(b.graph, 'bake.graph'); if (!NAME_RE.test(bake.graph)) throw new Error(`"bake.graph" must be a graph name`); }
  if (b.node !== undefined) bake.node = str(b.node, 'bake.node');
  if (b.frame !== undefined) { if (!Number.isFinite(b.frame)) throw new Error('"bake.frame" must be a number'); bake.frame = b.frame; }
  const pkg = raw.package === undefined ? undefined : str(raw.package, 'package');
  if (pkg !== undefined && !isPackageName(pkg)) throw new Error(`"package" "${pkg}" must be "owner/name": each part lower-case letters, digits, - and _, starting with a letter or digit`);
  const uses = parseUses(raw.uses);
  // each entry's form is checked where the libraries are looked in (libraryEntry): one that is wrong is said there, and
  // the others still work
  const libraries = raw.libraries ?? [];
  if (!Array.isArray(libraries) || libraries.some((l: unknown) => typeof l !== 'string' || !l.trim())) throw new Error('"libraries" must be a list of registered library names and paths relative to the package ("./lib", "../../art/topotopo")');
  return {
    id, graph, bake,
    title: str(raw.title, 'title', id),
    description: str(raw.description, 'description'),
    tags: [...new Set(tags.map((t: string) => t.trim()).filter(Boolean))] as string[],
    links: links.map((l: any) => ({ label: typeof l.label === 'string' && l.label ? l.label : l.url, url: l.url })),
    created: str(raw.created, 'created'),
    ...(pkg !== undefined ? { package: pkg } : {}),
    uses,
    libraries: libraries as string[],
  };
}

export const manifestFile = (dir: string) => path.join(dir, 'project.json');

export function readManifest(dir: string): PackageManifest {
  const file = manifestFile(dir);
  let raw: any;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e: any) { throw new Error(`${file}: ${e.message}`); }
  try { return parseManifest(raw, slugify(path.basename(dir)) || 'package'); } catch (e: any) { throw new Error(`${file}: ${e.message}`); }
}

/** Write a manifest (atomically), keeping keys of the file this version does not know. */
export function writeManifest(dir: string, m: PackageManifest) {
  const file = manifestFile(dir);
  let raw: any = {};
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new or unreadable: replaced */ }
  const out = { ...raw, ...m };
  // "uses" and "libraries" appear once they hold something (or when the file had them already)
  if (!Object.keys(m.uses).length && !Object.hasOwn(raw, 'uses')) delete out.uses;
  if (!m.libraries.length && !Object.hasOwn(raw, 'libraries')) delete out.libraries;
  writeAtomic(file, JSON.stringify(out, null, 2) + '\n');
}

/** Written as a dot-file next to the target and renamed, so readers never see half a file. */
export function writeAtomic(file: string, data: string | Uint8Array) {
  const part = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}-${Date.now().toString(36)}.part`);
  try { fs.writeFileSync(part, data); renameInto(part, file); } catch (e) { fs.rmSync(part, { force: true }); throw e; }
}

// ------------------------------------------------------------------------------------- the libraries a package lists

/**
 * What an entry of project.json "libraries" names: a path relative to the package, written "./lib" or "../../art/lib"
 * (a library in the same repository, so every checkout and worktree reads its own), or a registered library's name
 * ("game"). Anything else says how to write it.
 */
export function libraryEntry(entry: string): { path: string } | { name: string } | { error: string } {
  const e = entry.trim();
  if (path.isAbsolute(e) || /^[A-Za-z]:/.test(e))
    return { error: `"${entry}" is an absolute path: list a library in the same repository by its path relative to the package ("../lib"), any other by its registered name` };
  if (e === '.' || e === '..' || /^\.\.?[\\/]/.test(e)) return { path: e };
  if (ID_RE.test(e)) return { name: e };
  return { error: `"${entry}" is neither a path written from the package ("./${e.replace(/\\/g, '/')}") nor a registered library's name (lower-case letters, digits, - and _)` };
}

/**
 * The entry project.json lists for a library a person names (`topotopo libraries add`): a folder (absolute, or relative
 * to `cwd`) as its path relative to the package, "./x" or "../x"; else a registered library's name. Throws for what is
 * neither, and for a folder that is a package rather than a library.
 */
export function libraryEntryFor(packageDir: string, given: string, cwd = process.cwd()): string {
  const abs = path.resolve(cwd, given);
  if (fs.statSync(abs, { throwIfNoEntry: false })?.isDirectory()) {
    if (fs.existsSync(manifestFile(abs)))
      throw new Error(`${abs} is a package (it holds project.json), not a library: list the folder that holds it, ${path.dirname(abs)}`);
    const rel = path.relative(packageDir, abs).split(path.sep).join('/') || '.';
    if (path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) throw new Error(`${abs} is on another drive than the package: register it (topotopo library add <name> ${abs}) and list it by its name`);
    return rel.startsWith('.') ? rel : `./${rel}`;
  }
  if (ID_RE.test(given)) {
    let cfg: WebConfig | null = null;
    try { cfg = loadConfig(); } catch { /* an unreadable config registers nothing */ }
    if (cfg?.libraries.some((l) => l.name === given) || given === BUILTIN_LIBRARY.name) return given;
    throw new Error(`"${given}" is no folder here and no registered library (${cfg?.libraries.map((l) => l.name).join(', ') || 'none are registered'}): give the library's folder, or register it first (${program()} library add ${given} <folder>)`);
  }
  throw new Error(`no folder ${abs}: give the library's folder or a registered library's name`);
}

/** The package a folder belongs to (the folder itself, or the nearest parent with a project.json), or null. */
export function packageDirOf(start: string): string | null {
  let d = path.resolve(start);
  for (;;) {
    if (fs.existsSync(manifestFile(d))) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/**
 * What a package's .gitignore holds: files derived from it (previews, caches, the hashes of its copies' files) and the
 * lock its package commands hold while they write.
 */
const IGNORED = ['.web/', '.cache/', 'packages/.cache.json', 'packages/.lock'];
/**
 * What a package's .gitattributes holds: its published versions and its package copies are kept byte for byte, their
 * line ends never changed by a checkout (their hashes read text with LF line ends anyway, src/packages/registry.ts).
 */
const ATTRIBUTES = ['versions/** -text', 'packages/** -text'];

/** Add to a text file the lines it does not hold yet, at its end (a new file holds just them). */
function addLines(file: string, lines: string[]) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* new */ }
  const have = new Set(text.split(/\r?\n/).map((l) => l.trim()));
  const missing = lines.filter((l) => !have.has(l));
  if (!missing.length) return;
  fs.writeFileSync(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
}

/** A package's .gitignore and .gitattributes, made or completed. */
export function packageRepoFiles(dir: string) {
  addLines(path.join(dir, '.gitignore'), IGNORED);
  addLines(path.join(dir, '.gitattributes'), ATTRIBUTES);
}

/** A workspace's .gitignore and .gitattributes, made or completed: its shared copies as a package's own are kept. */
export function workspaceRepoFiles(dir: string) {
  addLines(path.join(dir, '.gitignore'), [`${WORKSPACE_PACKAGES}/.cache.json`, `${WORKSPACE_PACKAGES}/.lock`]);
  addLines(path.join(dir, '.gitattributes'), [`${WORKSPACE_PACKAGES}/** -text`]);
}

/**
 * A package name a person gives their package ("owner/name"): checked, and the owner "topotopo", which TopoTopo's own
 * packages have, refused.
 */
export function ownPackageName(pkg: string): string {
  const n = parsePackageName(pkg);
  if (typeof n === 'string' || n.output !== null) throw new Error(`"${pkg}" is not a package name: write "owner/name", each part lower-case letters, digits, - and _, starting with a letter or digit`);
  if (pkg.split('/')[0] === BUILTIN_LIBRARY.name) throw new Error(`the owner "${BUILTIN_LIBRARY.name}" is reserved for TopoTopo's own packages: name the package after its owner, you or your studio ("studio/${pkg.split('/')[1]}")`);
  return pkg;
}

/** The graph a new package starts with (graphs/main.json): a box, so that the graph project.json shows cooks. */
const STARTER = { description: 'A starting point: replace it with the package\'s graph.', nodes: { box: { type: 'box' } }, output: 'box' };

/**
 * Make a folder a package (`topotopo init`), in a library or anywhere: project.json (an id and title from the folder's
 * name, or from `name`; the graph it shows; "libraries": [], where the person lists the libraries it finds packages
 * in; and the name it publishes under, `package`, "owner/name"), graphs/ with a starter graph when it holds none (so that the
 * graph project.json shows is there: graphs/main.json, a box), a .gitignore for the derived files and a .gitattributes
 * that keeps its versions and package copies byte for byte (both completed when they exist). In a folder that is a
 * package already, `package` sets the name it publishes under (when it names none yet); without it, that is an error. Fails for a
 * folder inside another package.
 */
export function initPackage(dir: string, o: { package?: string; name?: string } = {}): { dir: string; manifest: PackageManifest; said: string } {
  const abs = path.resolve(dir);
  if (o.package !== undefined) ownPackageName(o.package);
  if (fs.existsSync(manifestFile(abs))) {
    if (o.package === undefined) throw new Error(`${abs} is a package already (${manifestFile(abs)}); --package owner/name sets the name it publishes under`);
    const m = readManifest(abs);
    if (m.package === o.package) return { dir: abs, manifest: m, said: `package ${m.id} → ${abs} publishes as ${m.package} already` };
    if (m.package) throw new Error(`package ${m.id} publishes as ${m.package} already: a package keeps its name (to publish it under another name, change "package" in ${manifestFile(abs)} yourself)`);
    m.package = o.package;
    writeManifest(abs, m);
    packageRepoFiles(abs);
    return { dir: abs, manifest: m, said: `package ${m.id} → ${abs} publishes as ${m.package} now` };
  }
  const outer = packageDirOf(path.dirname(abs));
  if (outer) throw new Error(`${abs} is inside the package ${outer}: a package cannot hold another`);
  const named = o.name ?? path.basename(abs);
  const id = slugify(named);
  if (!ID_RE.test(id)) throw new Error(`"${named}" gives no usable package id: name the folder with letters or digits`);
  // the graph it shows: main, unless graphs/ holds others and no main
  const graphs = path.join(abs, 'graphs');
  fs.mkdirSync(graphs, { recursive: true });
  const held = [...graphFiles(abs).keys()];
  const graph = held.length && !held.includes('main') ? held[0] : 'main';
  if (!held.length) fs.writeFileSync(path.join(graphs, 'main.json'), JSON.stringify(STARTER, null, 2) + '\n');
  const raw = { id, title: named, graph, created: new Date().toISOString().slice(0, 10), ...(o.package !== undefined ? { package: o.package } : {}), libraries: [] };
  const manifest = parseManifest(raw, id);
  writeAtomic(manifestFile(abs), JSON.stringify(raw, null, 2) + '\n');
  packageRepoFiles(abs);
  return { dir: abs, manifest, said: `package ${id} → ${abs}${manifest.package ? ` (publishes as ${manifest.package})` : ''}` };
}

/** Files an operating system leaves in folders, which say nothing about what a folder holds. */
const SYSTEM_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

/**
 * What a folder holds that TopoTopo does not make itself (its folders graphs/, assets/, exports/, inputs/), by name,
 * a folder's with a slash: none for a folder that holds nothing else, nothing at all, or does not exist yet. Files an
 * operating system leaves in folders do not count.
 */
export function notPackageFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => !(e.isDirectory() && PACKAGE_FOLDERS.includes(e.name)) && !SYSTEM_FILES.has(e.name))
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
}

/** Where the MCP server works, and what it says about it (startPackage). */
export interface PackageStart {
  /** the folder to work in: the one given, or the root of the package it lies in */
  dir: string;
  /** what happened, for the server's log */
  log: string;
  /** what its first tool reply tells the agent (null: nothing to tell) */
  note: string | null;
}

/**
 * The MCP server's rule for its folder when it starts, named or not (scripts/preview.ts applies it too). A folder in
 * a package works in that package's root, which holds its graphs, assets and packages. A folder in no package that holds
 * nothing but what TopoTopo makes itself (graphs/, assets/, exports/, inputs/), or nothing at all, becomes a package
 * (initPackage; `name`: its id and title, else the folder's name), so that its graphs use packages, TopoTopo's own among
 * them, as they come. A folder with anything else in it (a repository, a folder of the person's) stays as it is:
 * library {action:"init"} makes it a package when the person says so.
 */
export function startPackage(dir: string, o: { name?: string } = {}): PackageStart {
  const abs = path.resolve(dir);
  const outer = packageDirOf(abs);
  if (outer === abs) return { dir: abs, log: `the folder ${abs} is a package`, note: null };
  if (outer) return {
    dir: outer, log: `the folder ${abs} is in the package ${outer}: working in the package's folder`,
    note: `The server works in the package ${outer}, the package that holds the folder it was given (${abs}): a package's graphs, assets, inputs and packages are those of its own folder.`,
  };
  const other = notPackageFiles(abs);
  if (other.length) {
    const held = `${other.slice(0, 3).join(', ')}${other.length > 3 ? ` and ${other.length - 3} more` : ''}`;
    return {
      dir: abs, log: `the folder ${abs} is in no package and holds ${held}, which TopoTopo does not make: left as it is`,
      note: `The folder ${abs} is in no package, so its graphs cannot use packages, TopoTopo's own kits ("topotopo/nature/rock" …) among them: it holds ${held}, which TopoTopo does not make (it makes graphs/, assets/, exports/, inputs/), so the server left it as it is. Ask the person before making it a package; library {action:"init"} then does it (project.json, graphs/, .gitignore, .gitattributes).`,
    };
  }
  let made: ReturnType<typeof initPackage>;
  try { made = initPackage(abs, { name: o.name }); } catch (e: any) { return { dir: abs, log: `the folder ${abs} could not be made a package: ${e.message}`, note: `The folder ${abs} could not be made a package, so its graphs cannot use packages: ${e.message}` }; }
  return {
    dir: abs, log: `made the folder ${abs} a package (project.json): it held nothing but what TopoTopo makes itself`,
    note: `The folder ${abs} became a package, "${made.manifest.id}", when the server started (project.json, graphs/${made.manifest.graph}.json): it held nothing but TopoTopo's own folders. Its graphs use packages as they come, TopoTopo's own kits ("topotopo/nature/rock" …) among them. Next: build into graph "${made.manifest.graph}"; to publish versions of it, library {action:"set", package:"<owner>/${made.manifest.id}"} names it; to use packages from another library, library {action:"set", libraries:[...]} when the person names it.`,
  };
}

// -------------------------------------------------------------------------------- where a package looks for packages

/** The file at a game's root that makes it a workspace: the libraries every package inside it looks in. */
export const WORKSPACE_FILE = 'topotopo-workspace.json';
/** A library's own file: its name, the same whatever path or registered name reaches the library. */
export const LIBRARY_FILE = 'library.json';

export interface Located {
  /** the package the folder belongs to (itself or the nearest folder above with project.json) */
  package: string | null;
  /** the workspace around it: the nearest folder at or above the package (or the folder) with topotopo-workspace.json */
  workspace: string | null;
}

/** Where a folder sits: the package it belongs to and the workspace (the game) around it. */
export function locate(start: string): Located {
  const inside = packageDirOf(start);
  for (let d = path.resolve(inside ?? start); ; ) {
    if (fs.existsSync(path.join(d, WORKSPACE_FILE))) return { package: inside, workspace: d };
    const up = path.dirname(d);
    if (up === d) return { package: inside, workspace: null };
    d = up;
  }
}

/** A library's own name (library.json "name"), or null when it has none. */
export function libraryName(root: string): string | null {
  try {
    const n = JSON.parse(fs.readFileSync(path.join(root, LIBRARY_FILE), 'utf8'))?.name;
    return typeof n === 'string' && ID_RE.test(n) ? n : null;
  } catch { return null; }
}

/** A library a package looks in: the entry that lists it, its folder, its name, and who lists it. */
export interface LibraryAt { entry: string; root: string; name: string; from: 'package' | 'workspace' }
/** The libraries a package looks in, and what is wrong with the entries that do not work (the others still do). */
export interface Libraries { libs: LibraryAt[]; problems: string[] }

/**
 * The libraries a package looks in, in order: those its project.json lists (as it is now), then those of the workspace
 * around it (topotopo-workspace.json "libraries"), a library listed by both counted once. Each entry is a path relative
 * to the file that lists it ("./lib", "../lib") or a registered library's name. A library is named by its library.json
 * when it has one, else by the entry. What is wrong with an entry is a problem: a name not registered on this machine,
 * a folder that is not there, a package's folder instead of its library's, an entry of neither form; the others still
 * work. TopoTopo's built-in library is none of them (listing it by its name changes nothing).
 */
export function librariesFor(dir: string): Libraries {
  const lists: LibraryList[] = [{ file: 'project.json', base: dir, entries: readManifest(dir).libraries, from: 'package' }];
  const problems: string[] = [];
  const ws = locate(dir).workspace;
  if (ws) {
    try { lists.push({ file: path.join(ws, WORKSPACE_FILE), base: ws, entries: readWorkspace(ws).libraries, from: 'workspace' }); }
    catch (e: any) { problems.push(e.message); }
  }
  const out = resolveLibraries(lists);
  out.problems.unshift(...problems);
  return out;
}

/** A file's "libraries": the file (for messages), the folder its paths are written from, its entries, who lists them. */
export interface LibraryList { file: string; base: string; entries: string[]; from: LibraryAt['from'] }

/**
 * The libraries some lists name, in order, a library named twice counted once; what is wrong with an entry is a
 * problem and the others still count (see librariesFor).
 */
export function resolveLibraries(lists: LibraryList[]): Libraries {
  const out: Libraries = { libs: [], problems: [] };
  let cfg: WebConfig | null | undefined;
  for (const { file, base, entries, from } of lists) {
    const said = (entry: string, why: string) => out.problems.push(`${file} "libraries": "${entry}" ${why}; the other libraries still count`);
    const add = (entry: string, root: string) => {
      if (out.libs.some((l) => path.resolve(l.root).toLowerCase() === path.resolve(root).toLowerCase())) return;
      out.libs.push({ entry, root, name: libraryName(root) ?? entry, from });
    };
    for (const entry of entries) {
      if (entry === BUILTIN_LIBRARY.name) continue;
      const k = libraryEntry(entry);
      if ('error' in k) { out.problems.push(`${file} "libraries": ${k.error}; the other libraries still count`); continue; }
      if ('name' in k) {
        if (cfg === undefined) { try { cfg = loadConfig(); } catch (e: any) { cfg = null; out.problems.push(e.message); } }
        const lib = cfg?.libraries.find((l) => l.name === entry);
        if (lib) { add(entry, lib.path); continue; }
        const here = path.resolve(base, entry);
        said(entry, fs.statSync(here, { throwIfNoEntry: false })?.isDirectory()
          ? `names no registered library, and a folder of that name is beside ${from === 'package' ? 'project.json' : WORKSPACE_FILE}: a path is written from the ${from}, "./${entry}"`
          : `is not registered on this machine${cfg ? ` (${cfg.file} has ${cfg.libraries.map((l) => l.name).join(', ') || 'none'})` : ''}: ${program()} library add ${entry} <folder> registers it, or list the library by its path from the ${from} ("../lib")`);
        continue;
      }
      const root = path.resolve(base, k.path);
      if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) { said(entry, `is no folder (${root})`); continue; }
      if (fs.existsSync(manifestFile(root))) {
        let pkg = '';
        try { pkg = readManifest(root).package ?? ''; } catch { /* named without its package */ }
        const parent = path.posix.dirname(k.path.replace(/\\/g, '/'));
        said(entry, `is a package${pkg ? ` (published as ${pkg})` : ''}, not a library: list the folder that holds it, "${parent === '.' ? '.' : parent}"`);
        continue;
      }
      add(entry, root);
    }
  }
  return out;
}

// -------------------------------------------------------------------------------- where a package keeps its copies

/** The folder beside topotopo-workspace.json that holds the workspace's one shared copy of each package version. */
export const WORKSPACE_PACKAGES = 'topotopo-packages';

/** Where a package keeps the copies of the packages it uses, and the file whose "uses" names the versions in use. */
export interface CopyStore {
  /** the folder the store belongs to: the package's, or the workspace's */
  root: string;
  /** the folder of the copies (<owner>/<name>/<version>/, flat) and their lock.json */
  packages: string;
  /** the file whose "uses" lists the versions in use: the package's project.json, or the workspace's file */
  usesFile: string;
  /** the workspace whose one shared copy this is, or null: the package's own copies */
  workspace: string | null;
}

/**
 * Where a package keeps the copies of the packages it uses: in a workspace, the workspace's one shared copy for every package in it
 * (topotopo-packages/ beside topotopo-workspace.json, whose "uses" name one version of each package for the whole
 * game); else, and for a package that publishes versions (its uses are published with it), its own packages/ beside its
 * project.json.
 */
export function copiesFor(folder: string): CopyStore {
  const dir = path.resolve(folder);
  const own: CopyStore = { root: dir, packages: path.join(dir, 'packages'), usesFile: manifestFile(dir), workspace: null };
  let pkg: string | undefined;
  try { pkg = readManifest(dir).package; } catch { /* not a package, or project.json is not valid: its own folder */ }
  if (pkg) return own;
  const ws = locate(dir).workspace;
  return ws ? { root: ws, packages: path.join(ws, WORKSPACE_PACKAGES), usesFile: path.join(ws, WORKSPACE_FILE), workspace: ws } : own;
}

/** The versions the packages of a store use: the "uses" of project.json, or of the workspace's file. */
export function readUses(store: CopyStore): Record<string, string> {
  return store.workspace ? readWorkspace(store.workspace).uses : readManifest(store.root).uses;
}

/** Write the uses of a store (hold its lock: withStoreLock). */
export function writeUses(store: CopyStore, uses: Record<string, string>) {
  const sorted = Object.fromEntries(Object.entries(uses).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  if (store.workspace) writeWorkspace(store.workspace, { ...readWorkspace(store.workspace), uses: sorted });
  else writeManifest(store.root, { ...readManifest(store.root), uses: sorted });
}
