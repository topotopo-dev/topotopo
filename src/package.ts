// A package: a folder holding one <id>.topo file, its manifest, whose name is the package id, with the folders TopoTopo
// works with (graphs/ assets/ inputs/ exports/) and, when it publishes versions or uses packages, its published versions/
// and the copies in packages/ (src/packages/). Reading and writing the manifest, finding the package a folder belongs to
// and the places it finds packages in (its workspace and the libraries the workspace lists, else the registered
// libraries), making a folder a package (init, and the MCP server's rule when it starts), and the lock its package
// commands hold while they write.
import fs from 'node:fs';
import path from 'node:path';
import { ID_RE, parsePackageName } from './graph/scope.ts';
import { MANIFEST_EXT, NAME_RE, PACKAGE_FOLDERS, graphFiles, topoFiles } from './session.ts';
import { BUILTIN_LIBRARY, loadConfig } from './config.ts';
import { readWorkspace, writeWorkspace } from './workspace.ts';
import { folderKey, forgetScans } from './scan.ts';
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
 * the CLI, the MCP server and the viewer read, change and write the manifest, the uses and the lock under it, so that
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
      if (waited > 10_000) throw new Error(`${file} is held by another TopoTopo process (the viewer, an MCP server or a command) changing the packages this one uses; try again when it is done, or delete the file if no such process runs`);
      pause(50);
      waited += 50;
    }
  }
  heldLocks.add(file);
  try { return f(); } finally { heldLocks.delete(file); fs.rmSync(file, { force: true }); }
}

export interface PackageLink { label: string; url: string }
/** A package's manifest, <id>.topo: the id is the file's name, not a field. */
export interface PackageManifest {
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
  name?: string;
  /** the packages its graphs use, with the version in use: {"owner/name": "1.3"} (written by the tools) */
  uses: Record<string, string>;
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
 * it is in, when it is not the manifest).
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

/** A manifest checked and normalised; throws naming the problem. `id`: the package id, its file's name (the default title). */
export function parseManifest(raw: any, id: string): PackageManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('a package manifest must be an object');
  if (Object.hasOwn(raw, 'id')) throw new Error('"id": the file\'s name is the package id; remove "id"');
  if (Object.hasOwn(raw, 'package')) throw new Error('"package" is "name" now: rename it');
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
  const name = raw.name === undefined ? undefined : str(raw.name, 'name');
  if (name !== undefined && !isPackageName(name)) throw new Error(`"name" "${name}" must be "owner/name": each part lower-case letters, digits, - and _, starting with a letter or digit`);
  const uses = parseUses(raw.uses);
  // a package lists no libraries: its workspace does (an empty list is dropped)
  if (raw.libraries !== undefined && !(Array.isArray(raw.libraries) && !raw.libraries.length)) throw new Error(librariesGone(raw.libraries));
  return {
    graph, bake,
    title: str(raw.title, 'title', id),
    description: str(raw.description, 'description'),
    tags: [...new Set(tags.map((t: string) => t.trim()).filter(Boolean))] as string[],
    links: links.map((l: any) => ({ label: typeof l.label === 'string' && l.label ? l.label : l.url, url: l.url })),
    created: str(raw.created, 'created'),
    ...(name !== undefined ? { name } : {}),
    uses,
  };
}

/**
 * What a manifest that still lists "libraries" is told: where each entry goes now. A workspace lists the libraries its
 * packages find packages in; outside a workspace every registered library counts.
 */
function librariesGone(v: unknown): string {
  const entries = Array.isArray(v) ? v.filter((e): e is string => typeof e === 'string' && !!e.trim()) : [];
  const how = entries.length ? entries.map((e) => `${program()} workspace library add ${/\s/.test(e) ? JSON.stringify(e) : e}`).join('; ') : `${program()} workspace library add <library>`;
  return `"libraries" is gone from the package manifest: the workspace lists the libraries its packages use (${how}); outside a workspace every registered library counts. Remove "libraries"`;
}

/**
 * The manifest of the package whose folder is `dir`: its file and the package id, the file's name; null for a folder
 * that holds no .topo file (one that holds project.json instead is none either: oldManifest says what to do). Throws
 * for a folder with more than one, naming them, and for a file name that is no package id.
 */
export function manifestAt(dir: string): { file: string; id: string } | null {
  const found = topoFiles(dir);
  if (!found.length) return null;
  if (found.length > 1) throw new Error(`${dir} holds ${found.slice(0, -1).join(', ')} and ${found.at(-1)}: a package has one ${MANIFEST_EXT} file, whose name is its id`);
  const id = found[0].slice(0, -MANIFEST_EXT.length);
  if (!ID_RE.test(id)) throw new Error(`${path.join(dir, found[0])}: the file's name is the package id: lower-case letters, digits, - and _, starting with a letter or digit ("${slugify(id) || 'package'}${MANIFEST_EXT}")`);
  return { file: path.join(dir, found[0]), id };
}

/**
 * What a folder that holds project.json and no .topo file is told: a package's manifest is <id>.topo, named after the
 * id it had (else after the folder). null for any other folder.
 */
export function oldManifest(dir: string): string | null {
  const file = path.join(dir, 'project.json');
  if (topoFiles(dir).length || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return null;
  let raw: any = null;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* not JSON: named after its folder */ }
  const id = typeof raw?.id === 'string' && ID_RE.test(raw.id) ? raw.id : slugify(path.basename(dir)) || 'package';
  const inside = [raw?.package !== undefined ? '"package" to "name"' : '', raw?.id !== undefined ? 'remove "id"' : ''].filter(Boolean);
  return `${dir} holds project.json, which TopoTopo no longer reads: rename it to ${id}${MANIFEST_EXT}${inside.length ? ` and, in it, ${inside.join(' and ')}` : ''}`;
}

/** oldManifest for the nearest folder at or above `start` it speaks of, as the end of a message ("; …"); '' for none. */
export function oldManifestAbove(start: string): string {
  for (let d = path.resolve(start); ; ) {
    const said = oldManifest(d);
    if (said) return `; ${said}`;
    const up = path.dirname(d);
    if (up === d) return '';
    d = up;
  }
}

/** The manifest of a package folder (manifestAt); throws for a folder that is no package. */
function needManifest(dir: string): { file: string; id: string } {
  const at = manifestAt(dir);
  if (!at) throw new Error(oldManifest(dir) ?? `${dir} is no package: it holds no ${MANIFEST_EXT} file`);
  return at;
}

/** A package folder's manifest file, <id>.topo; throws for a folder that is no package. */
export const manifestFile = (dir: string) => needManifest(dir).file;
/** A package folder's id, the name of its .topo file; throws for a folder that is no package. */
export const packageId = (dir: string) => needManifest(dir).id;

export function readManifest(dir: string): PackageManifest {
  const { file, id } = needManifest(dir);
  return readManifestFile(file, id);
}

/** A manifest file read and checked (`id`: its name, the package id); throws naming the file. */
export function readManifestFile(file: string, id: string): PackageManifest {
  let raw: any;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e: any) { throw new Error(`${file}: ${e.message}`); }
  try { return parseManifest(raw, id); } catch (e: any) { throw new Error(`${file}: ${e.message}`); }
}

/**
 * Write a manifest (atomically), keeping keys of the file this version does not know: the folder's .topo file, or a new
 * <id>.topo in a folder that holds none.
 */
export function writeManifest(dir: string, m: PackageManifest, id?: string) {
  const file = manifestAt(dir)?.file ?? (id === undefined ? manifestFile(dir) : path.join(dir, `${id}${MANIFEST_EXT}`));
  let raw: any = {};
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new or unreadable: replaced */ }
  const out = { ...raw, ...m };
  // "uses" appears once it holds something (or when the file had it already); an empty "libraries" goes
  if (!Object.keys(m.uses).length && !Object.hasOwn(raw, 'uses')) delete out.uses;
  if (Array.isArray(out.libraries) && !out.libraries.length) delete out.libraries;
  writeAtomic(file, JSON.stringify(out, null, 2) + '\n');
  forgetScans();
}

/** Written as a dot-file next to the target and renamed, so readers never see half a file. */
export function writeAtomic(file: string, data: string | Uint8Array) {
  const part = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}-${Date.now().toString(36)}.part`);
  try { fs.writeFileSync(part, data); renameInto(part, file); } catch (e) { fs.rmSync(part, { force: true }); throw e; }
}

/**
 * The package a folder belongs to: the folder itself, or the nearest one above, that holds a .topo file (manifestAt);
 * null for none. Throws for a folder on the way that holds several.
 */
export function packageDirOf(start: string): string | null {
  let d = path.resolve(start);
  for (;;) {
    if (manifestAt(d)) return d;
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

/** The graph a new package starts with (graphs/main.json): a box, so that the graph its manifest shows cooks. */
const STARTER = { description: 'A starting point: replace it with the package\'s graph.', nodes: { box: { type: 'box' } }, output: 'box' };

/**
 * Make a folder a package (`topotopo init`), in a workspace, a library or anywhere: <id>.topo (the id and title from the
 * folder's name, or from `title`; the graph it shows; and the name it publishes under, `name`, "owner/name"), graphs/
 * with a starter graph when it holds none (so that
 * the graph the manifest shows is there: graphs/main.json, a box), a .gitignore for the derived files and a
 * .gitattributes that keeps its versions and package copies byte for byte (both completed when they exist). In a folder
 * that is a package already, `name` sets the name it publishes under (when it has none yet); without it, that is an
 * error. Fails for a folder inside another package, and for one that holds project.json (oldManifest).
 */
export function initPackage(dir: string, o: { name?: string; title?: string } = {}): { dir: string; id: string; manifest: PackageManifest; said: string } {
  const abs = path.resolve(dir);
  if (o.name !== undefined) ownPackageName(o.name);
  const at = manifestAt(abs);
  if (at) {
    if (o.name === undefined) throw new Error(`${abs} is a package already (${at.file}); --name owner/name sets the name it publishes under`);
    const m = readManifest(abs);
    if (m.name === o.name) return { dir: abs, id: at.id, manifest: m, said: `package ${at.id} → ${abs} publishes as ${m.name} already` };
    if (m.name) throw new Error(`package ${at.id} publishes as ${m.name} already: a package keeps its name (to publish it under another name, change "name" in ${at.file} yourself)`);
    m.name = o.name;
    writeManifest(abs, m);
    packageRepoFiles(abs);
    return { dir: abs, id: at.id, manifest: m, said: `package ${at.id} → ${abs} publishes as ${m.name} now` };
  }
  const old = oldManifest(abs);
  if (old) throw new Error(old);
  const outer = packageDirOf(path.dirname(abs));
  if (outer) throw new Error(`${abs} is inside the package ${outer}: a package cannot hold another`);
  const title = o.title ?? path.basename(abs);
  const id = slugify(title);
  if (!ID_RE.test(id)) throw new Error(`"${title}" gives no usable package id: name the folder with letters or digits`);
  // the graph it shows: main, unless graphs/ holds others and no main
  const graphs = path.join(abs, 'graphs');
  fs.mkdirSync(graphs, { recursive: true });
  const held = [...graphFiles(abs).keys()];
  const graph = held.length && !held.includes('main') ? held[0] : 'main';
  if (!held.length) fs.writeFileSync(path.join(graphs, 'main.json'), JSON.stringify(STARTER, null, 2) + '\n');
  const raw = { title, graph, created: new Date().toISOString().slice(0, 10), ...(o.name !== undefined ? { name: o.name } : {}) };
  const manifest = parseManifest(raw, id);
  writeAtomic(path.join(abs, `${id}${MANIFEST_EXT}`), JSON.stringify(raw, null, 2) + '\n');
  forgetScans();
  packageRepoFiles(abs);
  return { dir: abs, id, manifest, said: `package ${id} → ${abs}${manifest.name ? ` (publishes as ${manifest.name})` : ''}` };
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
 * (initPackage; `title`: its title and id, else the folder's name), so that its graphs use packages, TopoTopo's own
 * among them, as they come. A folder with anything else in it (a repository, a folder of the person's) stays as it is:
 * workspace {action:"init"} makes it a package when the person says so.
 */
export function startPackage(dir: string, o: { title?: string } = {}): PackageStart {
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
      dir: abs, log: `the folder ${abs} is in no package and holds ${held}, which TopoTopo does not make: left as it is${oldManifestAbove(abs)}`,
      note: `The folder ${abs} is in no package, so its graphs cannot use packages, TopoTopo's own packages ("topotopo/nature/rock" …) among them: it holds ${held}, which TopoTopo does not make (it makes graphs/, assets/, exports/, inputs/), so the server left it as it is${oldManifestAbove(abs)}. Ask the person before making it a package; workspace {action:"init"} then does it (<id>${MANIFEST_EXT}, graphs/, .gitignore, .gitattributes).`,
    };
  }
  let made: ReturnType<typeof initPackage>;
  try { made = initPackage(abs, { title: o.title }); } catch (e: any) { return { dir: abs, log: `the folder ${abs} could not be made a package: ${e.message}`, note: `The folder ${abs} could not be made a package, so its graphs cannot use packages: ${e.message}` }; }
  const file = `${made.id}${MANIFEST_EXT}`;
  return {
    dir: abs, log: `made the folder ${abs} a package (${file}): it held nothing but what TopoTopo makes itself`,
    note: `The folder ${abs} became a package, "${made.id}", when the server started (${file}, graphs/${made.manifest.graph}.json): it held nothing but TopoTopo's own folders. Its graphs use packages as they come, TopoTopo's own packages ("topotopo/nature/rock" …) among them. Next: build into graph "${made.manifest.graph}"; to publish versions of it, workspace {action:"set", name:"<owner>/${made.id}"} names it. It finds packages in its workspace and the libraries the workspace lists (workspace {action:"libraries"} shows them), or outside a workspace in every registered library.`,
  };
}

// -------------------------------------------------------------------------------- where a package looks for packages

/** The file at a game's root that makes it a workspace: the libraries every package inside it looks in. */
export const WORKSPACE_FILE = 'topotopo-workspace.json';
/** A library's own file: its name, the same whatever path or registered name reaches the library. */
export const LIBRARY_FILE = 'library.json';

export interface Located {
  /** the package the folder belongs to (itself or the nearest folder above with a .topo file) */
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

/**
 * A place a package finds packages in, besides TopoTopo's built-in library (librariesFor). `from`: "self", the workspace
 * the package is in, or outside a workspace the library it is in (scanned from the package's own checkout); "listed",
 * a shared library the workspace's file lists; "registered", outside a workspace, a library registered on this machine.
 */
export interface LibraryAt {
  from: 'self' | 'listed' | 'registered';
  /** what names it: the workspace file's entry, a registered name, or the workspace's or library's own name */
  entry: string;
  root: string;
  /** the workspace's name, a registered name, a library's own name (library.json), else the entry */
  name: string;
  /** a workspace (from "self"), not a library */
  workspace?: boolean;
  /**
   * found by its folder (the workspace, a library.json above the package, a path in the workspace file), not by a
   * registered name: the lock records it by its path from the folder of the copies
   */
  byPath: boolean;
}
/** The places a package finds packages in, in order, and what is wrong with the entries that do not work (the others still do). */
export interface Libraries {
  libs: LibraryAt[];
  problems: string[];
  /** the workspace around the folder, or null */
  workspace: string | null;
  /** the workspace, or the library the folder is in, when it is the first place */
  self: LibraryAt | null;
}

/** A place as messages name it: the workspace "my-game", library "props". */
export const placeText = (l: Pick<LibraryAt, 'name' | 'workspace'>) => (l.workspace ? `the workspace "${l.name}"` : `library "${l.name}"`);
/** TopoTopo's built-in library as messages name it. */
export const BUILTIN_TEXT = 'TopoTopo\'s built-in library';

/** `inner` is `outer` or a folder inside it. */
export const within = (inner: string, outer: string) => { const r = path.relative(path.resolve(outer), path.resolve(inner)); return !r.startsWith('..') && !path.isAbsolute(r); };
const isDir = (p: string) => !!fs.statSync(p, { throwIfNoEntry: false })?.isDirectory();

/**
 * What an entry of a workspace's "libraries" names: a registered library's name ("props"), or a path written from the
 * workspace, "../shared/props" (a library in the same repository, so every checkout and worktree reads its own).
 * Anything else says how to write it.
 */
export function libraryEntry(entry: string): { path: string } | { name: string } | { error: string } {
  const e = entry.trim();
  if (path.isAbsolute(e) || /^[A-Za-z]:/.test(e))
    return { error: `"${entry}" is an absolute path: register the library (${program()} library add <name> ${e}) and list it by its name, or list it by its path from the workspace ("../shared/props")` };
  if (e === '.' || e === '..' || /^\.\.?[\\/]/.test(e)) return { path: e };
  if (ID_RE.test(e)) return { name: e };
  return { error: `"${entry}" is neither a path written from the workspace ("../${e.replace(/\\/g, '/')}") nor a registered library's name (lower-case letters, digits, - and _)` };
}

/**
 * The places a folder's package finds packages in, in order (TopoTopo's built-in library comes after them, and only it
 * has the packages named "topotopo/…"):
 *   in a workspace: the workspace itself (its scan), then the shared libraries its file lists, in order;
 *   outside a workspace, in a library (a registered library's root at or above the folder, or a library.json): that
 *   library, scanned from the package's own checkout so its siblings come from the same worktree, then every other
 *   registered library;
 *   outside both: every registered library.
 * A workspace file that cannot be read is a problem, and only the built-in library is looked in until it is fixed.
 */
export function librariesFor(start: string): Libraries {
  const { package: pkg, workspace: ws } = locate(start);
  const out: Libraries = { libs: [], problems: [], workspace: ws, self: null };
  if (ws) {
    let m: ReturnType<typeof readWorkspace>;
    try { m = readWorkspace(ws); } catch (e: any) { out.problems.push(`${e.message}; until it is fixed, packages are found in ${BUILTIN_TEXT} only`); return out; }
    out.self = { from: 'self', entry: '.', root: ws, name: m.name, workspace: true, byPath: true };
    const listed = resolveListed(ws, m.libraries);
    out.libs.push(out.self, ...listed.libs);
    out.problems.push(...listed.problems);
    return out;
  }
  let cfg: WebConfig | null = null;
  try { cfg = loadConfig(); } catch (e: any) { out.problems.push(e.message); }
  const registered = cfg?.libraries ?? [];
  out.self = libraryAround(pkg ?? start, registered);
  if (out.self) out.libs.push(out.self);
  const seen = new Set(out.libs.map((l) => folderKey(l.root)));
  for (const l of registered) {
    // the library the package is in, reached from another checkout under its registered name, counts once
    if (seen.has(folderKey(l.path)) || l.name === out.self?.name) continue;
    seen.add(folderKey(l.path));
    out.libs.push({ from: 'registered', entry: l.name, root: l.path, name: l.name, byPath: false });
  }
  return out;
}

/** The library a folder outside a workspace is in: the nearest registered library's root or library.json at or above it. */
function libraryAround(start: string, registered: { name: string; path: string }[]): LibraryAt | null {
  for (let d = path.resolve(start); ; ) {
    const reg = registered.find((l) => folderKey(l.path) === folderKey(d));
    if (reg) return { from: 'self', entry: reg.name, root: reg.path, name: reg.name, byPath: false };
    if (fs.existsSync(path.join(d, LIBRARY_FILE))) {
      const name = libraryName(d) ?? (slugify(path.basename(d)) || 'library');
      return { from: 'self', entry: name, root: d, name, byPath: true };
    }
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/**
 * The shared libraries a workspace's file lists, in order, each once; what is wrong with an entry is a problem and the
 * others still count: a name not registered on this machine, a folder that is not there, a package's folder, an entry
 * of neither form, a library inside the workspace (its packages are found by themselves) or holding it. TopoTopo's
 * built-in library is none of them (listing it changes nothing).
 */
export function resolveListed(ws: string, entries: string[]): { libs: LibraryAt[]; problems: string[] } {
  const out = { libs: [] as LibraryAt[], problems: [] as string[] };
  const file = path.join(ws, WORKSPACE_FILE);
  let cfg: WebConfig | null | undefined;
  const said = (entry: string, why: string) => out.problems.push(`${file} "libraries": "${entry}" ${why}; the other libraries still count`);
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry === BUILTIN_LIBRARY.name) continue;
    const k = libraryEntry(entry);
    if ('error' in k) { out.problems.push(`${file} "libraries": ${k.error}; the other libraries still count`); continue; }
    let root: string, name: string;
    if ('name' in k) {
      if (cfg === undefined) { try { cfg = loadConfig(); } catch (e: any) { cfg = null; out.problems.push(e.message); } }
      const lib = cfg?.libraries.find((l) => l.name === entry);
      if (!lib) {
        said(entry, cfg?.workspaces.some((w) => w.name === entry)
          ? 'is a registered workspace, not a library: a workspace\'s packages are found from inside it ("libraries" holds shared libraries only)'
          : `is not registered on this machine${cfg ? ` (${cfg.file} has ${cfg.libraries.map((l) => l.name).join(', ') || 'none'})` : ''}: ${program()} library add ${entry} <folder> registers it`);
        continue;
      }
      root = path.resolve(lib.path); name = entry;
    } else {
      root = path.resolve(ws, k.path);
      if (!isDir(root)) { said(entry, `is no folder (${root})`); continue; }
      let at: ReturnType<typeof manifestAt> = null;
      try { at = manifestAt(root); } catch (e: any) { said(entry, `is a package's folder that cannot be read: ${e.message}`); continue; }
      if (at) { said(entry, `is a package's folder (${path.basename(at.file)}), not a library: list the folder of the library that holds it`); continue; }
      name = libraryName(root) ?? entry;
    }
    if (within(root, ws)) { said(entry, `is inside the workspace (${root}): its packages are found by themselves; remove it from "libraries"`); continue; }
    if (within(ws, root)) { said(entry, `(${root}) holds the workspace: list a shared library outside it; the workspace's own packages are found by themselves`); continue; }
    if (seen.has(folderKey(root))) continue;
    seen.add(folderKey(root));
    out.libs.push({ from: 'listed', entry, root, name, byPath: !('name' in k) });
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
  /** the file whose "uses" lists the versions in use: the package's manifest, or the workspace's file */
  usesFile: string;
  /** the workspace whose one shared copy this is, or null: the package's own copies */
  workspace: string | null;
}

/**
 * Where a package keeps the copies of the packages it uses: in a workspace, the workspace's one shared copy for every package in it
 * (topotopo-packages/ beside topotopo-workspace.json, whose "uses" name one version of each package for the whole
 * game); else, and for a package that publishes versions (its uses are published with it), its own packages/ beside its
 * manifest.
 */
export function copiesFor(folder: string): CopyStore {
  const dir = path.resolve(folder);
  let at: ReturnType<typeof manifestAt> = null;
  try { at = manifestAt(dir); } catch { /* two manifests: said where the package is read */ }
  const own: CopyStore = { root: dir, packages: path.join(dir, 'packages'), usesFile: at?.file ?? path.join(dir, `${slugify(path.basename(dir)) || 'package'}${MANIFEST_EXT}`), workspace: null };
  let pkg: string | undefined;
  try { pkg = readManifest(dir).name; } catch { /* not a package, or its manifest is not valid: its own folder */ }
  if (pkg) return own;
  const ws = locate(dir).workspace;
  return ws ? { root: ws, packages: path.join(ws, WORKSPACE_PACKAGES), usesFile: path.join(ws, WORKSPACE_FILE), workspace: ws } : own;
}

/** The versions the packages of a store use: the "uses" of the package's manifest, or of the workspace's file. */
export function readUses(store: CopyStore): Record<string, string> {
  return store.workspace ? readWorkspace(store.workspace).uses : readManifest(store.root).uses;
}

/** Write the uses of a store (hold its lock: withStoreLock). */
export function writeUses(store: CopyStore, uses: Record<string, string>) {
  const sorted = Object.fromEntries(Object.entries(uses).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  if (store.workspace) writeWorkspace(store.workspace, { ...readWorkspace(store.workspace), uses: sorted });
  else writeManifest(store.root, { ...readManifest(store.root), uses: sorted });
}
