// Packages on disk (the engine side is src/graph/packages.ts): the copies of the package versions a project uses and
// their lock, the libraries a project finds packages in, adding a package on first use, following a package's working
// folder for one session, publishing a version, and the newer versions of what a project uses and updating to one
// (the before/after is src/gallery/update.ts).
//
//   <package>/project.json                          "package": "studio/trees" (set by the author), "uses", "libraries"
//   <package>/versions/1.3/                         a published version, never written over: project.json (without
//                                                   "libraries"), graphs/, assets/, inputs/, packages/ (the copies it
//                                                   uses and their lock) and version.json (note, hash, interface)
//   <project>/packages/<owner>/<name>/<version>/    the project's copy of a version it uses, or of one those use: flat,
//                                                   each version once
//   <project>/packages/lock.json                    every copied version: its hash, the library it came from (as
//                                                   project.json lists it) and its own uses
//
// A copy holds the files of the version but the copies the version holds itself, which sit flat beside it; it keeps the
// version's lock. A version's hash covers every file of the version but version.json: the sorted posix paths, each with
// the SHA-256 of the file's bytes ("<sha256>  <path>" lines, hashed again). A copy is checked against it together with
// the copies it uses as the project holds them, so a copy edited by hand shows. A project finds packages only in the
// libraries its project.json lists: a path relative to the project (a library in the same repository, so every checkout
// and worktree reads its own) or a registered library's name, and before those in TopoTopo's built-in library, which
// holds TopoTopo's own packages and which every project looks in without listing it. Cooking needs only the copies.
//
// A package's graphs name its own outputs by full name, with no entry in its uses: in a version they resolve to that
// version, in a followed working folder to that folder, and in the project that is the package to its own graphs as
// they are now (its working folder, as following it would). Outputs that name each other in a loop do not resolve, and
// publishing refuses them.
//
// Update goes to the newest version with the same big number, or to a version named (a big one is named). Its
// before/after reads the new version where its library holds it, apart from the copies (a scope and results of its
// own), and copies nothing; applying copies it in, sets "uses" and the lock, and deletes the copies nothing uses any
// more: those the uses needed before and need no more.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { graphInterface } from '../graph/engine.ts';
import type { Engine } from '../graph/engine.ts';
import { migrateGraph } from '../graph/migrate.ts';
import { ownOutputsNamed, packageAt, packageOutputDef, packagesNamedIn } from '../graph/packages.ts';
import { didYouMean, resolveParamName } from '../graph/params.ts';
import { getNodeDef } from '../graph/registry.ts';
import { ID_RE, parsePackageName } from '../graph/scope.ts';
import type { PackageIssue, PackageResolver, Scope } from '../graph/scope.ts';
import type { GraphSpec, NodeDef } from '../graph/types.ts';
import { TOPOTOPO_VERSION } from '../host/version.ts';
import { NAME_RE } from '../workspace.ts';
import type { Workspace, WorkspacePackages } from '../workspace.ts';
import { BUILTIN_LIBRARY, VERSION_RE, loadConfig, manifestFile, projectDirOf, readManifest, scanLibrary, writeAtomic, writeManifest } from './library.ts';
import type { GalleryConfig, ProjectManifest } from './library.ts';

/** Publishing warns about a version above this size: every project that uses it keeps a copy. */
export const MAX_VERSION_BYTES = 50 * 2 ** 20;
/** The owner of TopoTopo's own packages: nobody else publishes under it. */
export const RESERVED_OWNER = 'topotopo';
/** How a folder becomes a project, said where only a project will do. */
const MAKE_PROJECT = 'topotopo init <folder> (MCP: library {action:"init"} for the open workspace) makes the folder a project (project.json)';
/** A library as messages name it: library "game", and TopoTopo's built-in library by its name and what it is. */
export const libraryText = (name: string) => `library "${name}"${name === BUILTIN_LIBRARY.name ? ' (TopoTopo\'s built-in library)' : ''}`;

export interface LockEntry { hash: string; library: string; uses: Record<string, string> }
/** packages/lock.json: every copied version, by package and version. */
export interface Lock { packages: Record<string, Record<string, LockEntry>> }

export interface SliderInfo { type: string; default?: unknown; min?: number; max?: number; options?: (string | number)[]; label?: string; desc?: string }
export interface InputInfo { index: number; label: string }
/** A published output: the graph and node it cooks, its sliders (the graph's vars) and its inputs (its input nodes). */
export interface OutputInfo { graph: string; node: string; label?: string; sliders: Record<string, SliderInfo>; inputs: InputInfo[] }

/** version.json */
export interface VersionInfo {
  package: string;
  version: string;
  note: string;
  /** ISO time */
  published: string;
  /** the author marked it big (publish --big) */
  big: boolean;
  hash: string;
  /** every published output, and the default output (the output node of the graph project.json shows) */
  outputs: Record<string, OutputInfo>;
  default: OutputInfo;
  /** the TopoTopo version that published it */
  topotopo: string;
}

// ------------------------------------------------------------------------------------------------------- versions

const versionParts = (v: string) => v.split('.').map(Number);
export const compareVersions = (a: string, b: string) => { const [x, y] = versionParts(a), [u, w] = versionParts(b); return x - u || y - w; };
/** A version that starts a big version: 2.0, 3.0, 10.0 (1.0 is the first one, 1.10 a small one). */
export const startsBigVersion = (v: string) => { const [big, small] = versionParts(v); return small === 0 && big > 1; };
const newestOf = (vs: Iterable<string>) => [...vs].sort(compareVersions).at(-1);

/** A package name "owner/name" (no output). */
const isPackageName = (s: string) => { const n = parsePackageName(s); return typeof n !== 'string' && n.output === null; };

function readVersionInfo(dir: string): VersionInfo {
  const file = path.join(dir, 'version.json');
  let raw: any;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e: any) { throw new Error(`${file}: ${e.message}`); }
  if (!raw || typeof raw !== 'object' || typeof raw.package !== 'string' || typeof raw.version !== 'string' || typeof raw.hash !== 'string' || !raw.outputs || !raw.default)
    throw new Error(`${file} is not a version record: it needs package, version, hash, outputs and default`);
  return raw;
}

// ---------------------------------------------------------------------------------------------------------- files

const sha = (d: string | Uint8Array) => createHash('sha256').update(d).digest('hex');
const byRel = (a: { rel: string }, b: { rel: string }) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);
const sortKeys = <T>(o: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
/** a copy's folder in a packages/ folder */
const copyAt = (packages: string, pkg: string, v: string) => path.join(packages, ...pkg.split('/'), v);
/** a version's own copies (not its lock), which a copy of it leaves out */
const nestedCopy = (rel: string) => rel.startsWith('packages/') && rel !== 'packages/lock.json';

/** what is said about a copy that is missing, and about one edited by hand (a loaded copy warns, publishing blocks) */
const missingCopy = (pkg: string, v: string, at: string) => `the copy of ${pkg} ${v} is missing: ${at}`;
const editedCopy = (pkg: string, v: string, at: string) => `the copy of ${pkg} ${v} (${at}) was edited by hand: its files no longer match the hash packages/lock.json records; restore it, or delete it and run topotopo use with the package the project uses that needs it, which copies what is missing`;

/** Every file below `dir`, dot-files and dot-folders skipped: posix paths relative to it, sorted. */
function filesBelow(dir: string): { rel: string; abs: string }[] {
  const out: { rel: string; abs: string }[] = [];
  const walk = (d: string, rel: string, depth: number) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(d, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      let st: fs.Stats;
      try { st = fs.statSync(abs); } catch { continue; }
      if (st.isDirectory()) { if (depth < 32) walk(abs, r, depth + 1); } // the depth cap stops link cycles
      else if (st.isFile()) out.push({ rel: r, abs });
    }
  };
  walk(dir, '', 0);
  return out.sort(byRel);
}

/** SHA-256 of files kept while their size and time stay the same: copies and followed folders are read again often. */
const shaCache = new Map<string, { stamp: string; sha: string }>();
function fileSha(abs: string, cached: boolean): string {
  if (!cached) return sha(fs.readFileSync(abs));
  const st = fs.statSync(abs), stamp = `${st.size}:${st.mtimeMs}`;
  const c = shaCache.get(abs);
  if (c?.stamp === stamp) return c.sha;
  const h = sha(fs.readFileSync(abs));
  shaCache.set(abs, { stamp, sha: h });
  return h;
}

/** The hash of a set of files: their sorted posix paths, each with the SHA-256 of its bytes. */
export function filesHash(files: { rel: string; sha: string }[]): string {
  return sha([...files].sort(byRel).map((f) => `${f.sha}  ${f.rel}\n`).join(''));
}

/**
 * The hash a version published from the project folder `dir` now would have, which tells whether a working folder
 * differs from its versions (its files are re-read only when they change).
 */
export function workingHash(dir: string): string {
  const m = readManifest(dir), lock = readLock(dir);
  return filesHash(versionFiles(dir, m, lock).map((f) => ({ rel: f.rel, sha: f.bytes ? sha(f.bytes) : fileSha(f.abs!, true) })));
}

/** The hash of a version folder as published: every file but its version.json. */
export function versionHash(dir: string, cached = false): string {
  return filesHash(filesBelow(dir).filter((f) => f.rel !== 'version.json').map((f) => ({ rel: f.rel, sha: fileSha(f.abs, cached) })));
}

/**
 * The hash of the version a copy holds: its own files (but version.json) with, under packages/, the copies its lock
 * lists as the packages/ folder `packages` holds them.
 */
function copyHash(copy: string, packages: string): string {
  const files = filesBelow(copy).filter((f) => f.rel !== 'version.json').map((f) => ({ rel: f.rel, sha: fileSha(f.abs, true) }));
  for (const [pkg, vs] of Object.entries(readLock(copy).packages)) for (const v of Object.keys(vs))
    for (const f of filesBelow(copyAt(packages, pkg, v))) files.push({ rel: `packages/${pkg}/${v}/${f.rel}`, sha: fileSha(f.abs, true) });
  return filesHash(files);
}

/** Copy the files of `from` that `keep` keeps into a new folder `to`, through a .part folder renamed into place. */
function copyTree(from: string, to: string, keep: (rel: string) => boolean = () => true) {
  if (fs.existsSync(to)) throw new Error(`${to} is there already`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const part = path.join(path.dirname(to), `.${path.basename(to)}.${process.pid}-${Date.now().toString(36)}.part`);
  try {
    for (const f of filesBelow(from)) {
      if (!keep(f.rel)) continue;
      const dest = path.join(part, ...f.rel.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(f.abs, dest);
    }
    fs.mkdirSync(part, { recursive: true });
    fs.renameSync(part, to);
  } catch (e) { fs.rmSync(part, { recursive: true, force: true }); throw e; }
}

// ----------------------------------------------------------------------------------------------------------- lock

export const lockFile = (dir: string) => path.join(dir, 'packages', 'lock.json');

const usesOf = (v: unknown, where: string): Record<string, string> => {
  if (v === undefined) return {};
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.entries(v).some(([k, x]) => !isPackageName(k) || typeof x !== 'string' || !VERSION_RE.test(x)))
    throw new Error(`${where}: "uses" must be {"owner/name": "1.3"}`);
  return sortKeys(v as Record<string, string>);
};

/** A folder's packages/lock.json (empty when there is none); throws naming the file when it is not valid. */
export function readLock(dir: string): Lock {
  const file = lockFile(dir);
  if (!fs.existsSync(file)) return { packages: {} };
  let raw: any;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e: any) { throw new Error(`${file}: ${e.message}`); }
  const shape = `${file} must be {"packages": {"owner/name": {"1.3": {"hash", "library", "uses"}}}}`;
  if (!raw || typeof raw !== 'object' || !raw.packages || typeof raw.packages !== 'object' || Array.isArray(raw.packages)) throw new Error(shape);
  const out: Lock = { packages: {} };
  for (const [pkg, vs] of Object.entries<any>(raw.packages)) {
    if (!isPackageName(pkg) || !vs || typeof vs !== 'object' || Array.isArray(vs)) throw new Error(shape);
    for (const [v, e] of Object.entries<any>(vs)) {
      if (!VERSION_RE.test(v) || !e || typeof e.hash !== 'string') throw new Error(shape);
      (out.packages[pkg] ??= {})[v] = { hash: e.hash, library: typeof e.library === 'string' ? e.library : '', uses: usesOf(e.uses, `${file} ${pkg} ${v}`) };
    }
  }
  return out;
}

/** The lock as written: packages by name, versions by number. */
function lockText(lock: Lock): string {
  const packages = Object.fromEntries(Object.entries(sortKeys(lock.packages)).map(([pkg, vs]) =>
    [pkg, Object.fromEntries(Object.keys(vs).sort(compareVersions).map((v) => [v, { hash: vs[v].hash, library: vs[v].library, uses: sortKeys(vs[v].uses) }]))]));
  return JSON.stringify({ packages }, null, 2) + '\n';
}

function writeLock(dir: string, lock: Lock) {
  fs.mkdirSync(path.join(dir, 'packages'), { recursive: true });
  writeAtomic(lockFile(dir), lockText(lock));
}

/** Every version `uses` needs through the lock (its uses, theirs …), sorted; throws for one the lock does not list. */
function usesClosure(uses: Record<string, string>, lock: Lock): [string, string][] {
  const out = new Map<string, [string, string]>();
  const visit = (pkg: string, v: string, by: string) => {
    const key = `${pkg}@${v}`;
    if (out.has(key)) return;
    const e = lock.packages[pkg]?.[v];
    if (!e) throw new Error(`packages/lock.json does not list ${pkg} ${v} (${by} uses it): copy it with topotopo use ${pkg}`);
    out.set(key, [pkg, v]);
    for (const [p, w] of Object.entries(e.uses)) visit(p, w, `${pkg} ${v}`);
  };
  for (const [pkg, v] of Object.entries(uses)) visit(pkg, v, 'project.json');
  return [...out.values()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : compareVersions(a[1], b[1])));
}

// -------------------------------------------------------------------------------------------- what a package holds

/** A graph folder's graphs by name (top level of graphs/, migrated); unreadable ones are problems. */
function readGraphs(dir: string, problems: string[]): Map<string, GraphSpec> {
  const out = new Map<string, GraphSpec>();
  let files: string[] = [];
  try { files = fs.readdirSync(path.join(dir, 'graphs')).filter((f) => f.endsWith('.json')).sort(); } catch { /* no graphs */ }
  for (const f of files) {
    const name = f.slice(0, -5);
    if (!NAME_RE.test(name)) continue;
    try { out.set(name, migrateGraph(JSON.parse(fs.readFileSync(path.join(dir, 'graphs', f), 'utf8')))); }
    catch (e: any) { problems.push(`graphs/${f}: ${e.message}`); }
  }
  return out;
}

interface FolderOutput { name: string | null; graph: string; spec: GraphSpec; node: string; label?: string }

/**
 * What a package folder publishes: every named output of every graph in graphs/ but those marked "publish": false, and
 * the default output, the output node of the graph project.json shows. Names that are not ids, clashes and a missing
 * default are problems (publishing blocks on them); a clashing name is left out.
 */
function folderOutputs(m: ProjectManifest, graphs: Map<string, GraphSpec>): { named: FolderOutput[]; default: FolderOutput | null; problems: string[] } {
  const problems: string[] = [];
  const byName = new Map<string, FolderOutput[]>();
  for (const [graph, spec] of graphs) {
    for (const [id, out] of Object.entries(spec.outputs ?? {})) {
      if (!out || typeof out !== 'object' || out.publish === false) continue;
      if (!ID_RE.test(id)) { problems.push(`output "${id}" (graph "${graph}") is not a package output name: lower-case letters, digits, - and _, starting with a letter or digit`); continue; }
      if (typeof out.node !== 'string' || !Object.hasOwn(spec.nodes, out.node)) { problems.push(`output "${id}" (graph "${graph}") names no node of its graph`); continue; }
      const list = byName.get(id) ?? [];
      list.push({ name: id, graph, spec, node: out.node, ...(typeof out.label === 'string' ? { label: out.label } : {}) });
      byName.set(id, list);
    }
  }
  const named: FolderOutput[] = [];
  for (const [id, list] of byName) {
    if (list.length > 1) problems.push(`output "${id}" is published by graphs ${list.map((o) => `"${o.graph}"`).join(' and ')}: output names are unique in a package (mark all but one "publish": false, or rename)`);
    else named.push(list[0]);
  }
  let def: FolderOutput | null = null;
  const shown = graphs.get(m.graph);
  if (!shown) problems.push(`no default output: project.json shows graph "${m.graph}", and graphs/ has no ${m.graph}.json`);
  else if (!shown.output || !Object.hasOwn(shown.nodes, shown.output)) problems.push(`no default output: set "output" in graphs/${m.graph}.json (the graph project.json shows); TopoTopo never picks an end node for a package`);
  else def = { name: null, graph: m.graph, spec: shown, node: shown.output };
  return { named: named.sort((a, b) => (a.name! < b.name! ? -1 : 1)), default: def, problems };
}

/**
 * The outputs of package `pkg` that name each other in a loop, through its own outputs by full name (ownOutputsNamed, in
 * the package's scope): output (its name, "" for the default output) → the loop, said.
 */
function outputLoops(pkg: string, outs: FolderOutput[], scope: Scope): Map<string, string> {
  const refs = new Map(outs.map((o) => [o.name ?? '', ownOutputsNamed(pkg, o.spec, o.node, scope)]));
  const label = (k: string) => (k ? `${pkg}/${k}` : pkg);
  const loops = new Map<string, string>(), state = new Map<string, number>();
  const visit = (k: string, stack: string[]) => {
    if (state.get(k) === 2 || !refs.has(k)) return;
    if (state.get(k) === 1) {
      const loop = [...stack.slice(stack.indexOf(k)), k];
      const said = loop.length === 2 ? `${label(k)} names itself` : `${loop.map(label).join(' → ')} name each other in a loop`;
      for (const x of loop) if (!loops.has(x)) loops.set(x, said);
      return;
    }
    state.set(k, 1);
    for (const r of refs.get(k)!) visit(r, [...stack, k]);
    state.set(k, 2);
  };
  for (const k of refs.keys()) visit(k, []);
  return loops;
}

/** An output's interface: its sliders (the graph's vars, with their declarations) and its inputs (its input nodes). */
function outputInfo(o: FolderOutput): OutputInfo {
  const sliders: Record<string, SliderInfo> = {};
  for (const [k, p] of Object.entries(graphInterface(o.spec).params)) {
    const label = o.spec.params?.[k]?.label;
    sliders[k] = {
      type: p.type, default: p.default,
      ...(p.min !== undefined ? { min: p.min } : {}), ...(p.max !== undefined ? { max: p.max } : {}), ...(p.options ? { options: p.options } : {}),
      ...(typeof label === 'string' && label ? { label } : {}), ...(p.desc ? { desc: p.desc } : {}),
    };
  }
  const inputs: InputInfo[] = [];
  for (const n of Object.values(o.spec.nodes)) {
    if (!n || typeof n.type !== 'string' || getNodeDef(n.type)?.type !== 'input') continue;
    inputs.push({ index: Number(n.params?.index ?? 0), label: String(n.params?.label ?? n.note ?? '') });
  }
  return { graph: o.graph, node: o.node, ...(o.label ? { label: o.label } : {}), sliders, inputs: inputs.sort((a, b) => a.index - b.index) };
}

/** Register a folder's assets/*.json into a scope; an asset that uses one registered later is tried again. */
function registerAssets(engine: Engine, scope: Scope, dir: string, problems: string[]) {
  let pending: { name: string; graph: GraphSpec }[] = [];
  let files: string[] = [];
  try { files = fs.readdirSync(path.join(dir, 'assets')).filter((f) => f.endsWith('.json')).sort(); } catch { /* no assets */ }
  for (const f of files) {
    try { pending.push({ name: f.slice(0, -5), graph: migrateGraph(JSON.parse(fs.readFileSync(path.join(dir, 'assets', f), 'utf8'))) }); }
    catch (e: any) { problems.push(`assets/${f}: ${e.message}`); }
  }
  for (let pass = 0; pending.length; pass++) {
    const failed: { name: string; graph: GraphSpec; error: string }[] = [];
    for (const a of pending) {
      try { engine.registerAsset(a.name, a.graph, { scope }); }
      catch (e: any) { failed.push({ ...a, error: e.message }); }
    }
    if (failed.length === pending.length || pass > 8) { for (const a of failed) problems.push(`assets/${a.name}.json: ${a.error}`); break; }
    pending = failed;
  }
}

// ------------------------------------------------------------------------------------------------------- registry

/** Where a scope's package names lead: the uses it resolves them by and the packages/ folder that holds the copies. */
interface Context {
  /** for messages: "this project", "studio/trees 1.3", "studio/trees (working folder)" */
  label: string;
  uses: Record<string, string>;
  packages: string;
  lock: Lock;
  /** followed packages resolve to their working folders (in the project and in followed folders, never in a version) */
  follows: boolean;
  /** the package the scope is (a version, a working folder, the project that is a package): its own outputs by full name */
  self?: { package: string; get: () => Loaded | PackageIssue };
  /**
   * Update's before/after: versions read where a library holds them ("owner/name@version"), and below them (`apart`)
   * the copies those hold. Each is the project's own copy when it holds that version, else read apart from its copies.
   */
  library?: Map<string, Place>;
  apart?: boolean;
  /**
   * The project as a dry run sees it (ProjectPackages.dryRun): the packages a graph names for the first time are in its
   * uses, read where a library holds them (`library`); this says why the others its first use could not add.
   */
  unavailable?: Map<string, string>;
}

/** A package version (or a followed working folder) loaded into the engine: its scope and its output node types. */
interface Loaded {
  package: string;
  version: string | null;
  dir: string;
  hash: string;
  scope: Scope;
  named: Map<string, NodeDef>;
  default: NodeDef | null;
  /** why it has no default output */
  noDefault?: string;
  /** outputs that name each other in a loop (by name, "" for the default output), and the loop, said */
  loops: Map<string, string>;
}

/** A package's working folder, followed this session. */
interface Followed { package: string; dir: string; library: string; stamp: string }

/** A published version found in one of the project's libraries. */
interface Place { library: string; dir: string; info: VersionInfo }

/** A package in the project's libraries: the libraries that hold it, its working folders and its versions. */
interface Found { package: string; libraries: string[]; working: { library: string; dir: string }[]; versions: Map<string, Place[]> }

/** A package's folder in a library: its versions/, and `working` when it is the package's working folder (a project). */
interface PackageFolder { package: string; library: string; dir: string; working: boolean }

/**
 * The project's libraries and the packages in them, scanned once for several finds: TopoTopo's built-in library first,
 * then the libraries project.json lists.
 */
interface Scanned { libs: { entry: string; root: string }[]; packages: PackageFolder[] }

/**
 * The packages of TopoTopo's built-in library at `dir`: topotopo/<name> for each folder <name> with versions/, a working
 * folder too where it holds that package's project.json (in TopoTopo's repository). Sorted by name.
 */
function builtinPackages(dir: string, problems: Set<string>): PackageFolder[] {
  let names: string[] = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && ID_RE.test(e.name)).map((e) => e.name).sort(); } catch { return []; }
  return names.flatMap((name) => {
    const at = path.join(dir, name), pkg = `${RESERVED_OWNER}/${name}`;
    let working = false;
    if (fs.existsSync(manifestFile(at))) {
      try {
        const m = readManifest(at);
        if (m.package === pkg) working = true;
        else problems.add(`${at} in TopoTopo's built-in library holds the versions of ${pkg}, and its project.json names ${m.package ? `the package ${m.package}` : 'no package'}`);
      } catch (e: any) { problems.add(e.message); }
    }
    return working || fs.existsSync(path.join(at, 'versions')) ? [{ package: pkg, library: BUILTIN_LIBRARY.name, dir: at, working }] : [];
  });
}

export interface UseResult { version: string; copied: string[]; text: string }

/** A package the project uses, and the newer versions its libraries have. */
export interface Outdated {
  package: string;
  /** the version in use */
  version: string;
  /** the newest version with the same big number, when it is newer: a small update */
  small?: string;
  /** the newest version, when its big number is higher: a big update */
  big?: string;
  /** every version after the one in use, oldest first */
  newer: VersionInfo[];
  /** the libraries that hold the package, as project.json lists them ("topotopo": TopoTopo's built-in library) */
  libraries: string[];
  /** its working folders in those libraries (following one needs exactly one; the built-in library has them only in TopoTopo's repository) */
  working: { library: string; dir: string }[];
  /** why its versions could not be looked up */
  error?: string;
}

/** What an Update goes to: the version in use, the version it goes to, the versions between them. */
export interface UpdateTarget {
  package: string;
  from: string;
  to: string;
  /** `to` has another big number than `from` */
  big: boolean;
  /** the record of `from` (its copy's, else its library's; null when neither has it) and of `to` */
  fromInfo: VersionInfo | null;
  toInfo: VersionInfo;
  /** the versions after `from` up to `to`, oldest first; going back to an older `to`, the ones it leaves */
  between: VersionInfo[];
  /** the library that holds `to` (as project.json lists it) and the version's folder there */
  library: string;
  dir: string;
}

export interface UpdateResult { copied: string[]; deleted: string[]; text: string }

/**
 * The packages of one project in one engine: the resolver of the engine's root scope (the project's uses), a scope per
 * copied version (its own assets, graphs, files and uses), adding packages on first use, the session's followed
 * working folders. openPackages attaches one to an engine.
 */
export class ProjectPackages implements WorkspacePackages {
  readonly engine: Engine;
  /** the project folder; null when the folder belongs to no project */
  readonly dir: string | null;
  /** the folder of TopoTopo's built-in library, which every project looks in */
  readonly builtin: string;
  manifest: ProjectManifest | null = null;
  /** why project.json or the lock could not be read */
  error: string | null = null;
  /** copies edited by hand, files a copy cannot read: the CLI prints them, the library tool lists them, cooks warn */
  readonly problems = new Set<string>();
  /** files that versions read apart (Update's before/after) cannot read */
  readonly apartProblems = new Set<string>();
  /** what the engine's root scope resolves package names with */
  readonly resolver: PackageResolver;
  private root: Context;
  private loaded = new Map<string, Loaded | PackageIssue>();
  /** versions read apart from the copies (Context.library), by folder */
  private apart = new Map<string, Loaded | PackageIssue>();
  private loading = new Set<string>();
  private followed = new Map<string, Followed>();
  private followLoaded = new Map<string, Loaded | PackageIssue>();
  /** the hash of every followed folder: what their outputs' results are keyed by */
  private joint = '';
  /** the project's own package, its graphs as they are now ("" until its graphs name one of its outputs) */
  private selfStamp = '';
  private selfLoaded: Loaded | PackageIssue | null = null;
  /** why first use could not add a package, said when a graph names it */
  private unavailable = new Map<string, string>();
  private disk = '';
  private watchers: fs.FSWatcher[] = [];
  private watchTimer: ReturnType<typeof setTimeout> | undefined;
  private onChange: (() => void) | null = null;

  /** `builtin`: the folder of TopoTopo's built-in library (default: the one TopoTopo ships, BUILTIN_LIBRARY) */
  constructor(engine: Engine, dir: string | null, opts: { builtin?: string } = {}) {
    this.engine = engine;
    this.dir = dir === null ? null : path.resolve(dir);
    this.builtin = path.resolve(opts.builtin ?? BUILTIN_LIBRARY.path);
    this.root = { label: 'this project', uses: {}, packages: this.dir ? path.join(this.dir, 'packages') : '', lock: { packages: {} }, follows: true };
    this.resolver = { resolve: (name) => this.resolveIn(this.root, name), names: () => this.namesIn(this.root), offered: () => this.offered() };
    this.reload();
  }

  /** "project lantern (D:/lib/props/lantern)" */
  get label(): string { return this.manifest ? `project ${this.manifest.id}` : 'this folder'; }

  /** Read project.json and the lock again (the tools wrote them, or another process did). */
  private reload() {
    this.disk = this.diskStamp();
    // a version that loaded stays as it is (it is frozen); one that could not load is tried again
    for (const [k, v] of this.loaded) if ('error' in v) this.loaded.delete(k);
    // the project's own package is read again with its uses and lock (its files are hashed again when next named)
    this.selfLoaded = null;
    this.selfStamp = '';
    if (!this.dir) return;
    try {
      this.manifest = readManifest(this.dir);
      const pkg = this.manifest.package;
      // the project that is a package: its graphs name their own outputs, which cook from its graphs as they are now
      this.root = { ...this.root, uses: this.manifest.uses, lock: readLock(this.dir), self: pkg ? { package: pkg, get: () => this.loadSelf(pkg) } : undefined };
      this.error = null;
    } catch (e: any) { this.error = e.message; this.root = { ...this.root, uses: {}, lock: { packages: {} }, self: undefined }; }
  }

  private diskStamp(): string {
    if (!this.dir) return '';
    const st = (f: string) => { const s = fs.statSync(f, { throwIfNoEntry: false }); return s ? `${s.size}:${s.mtimeMs}` : '-'; };
    return `${st(manifestFile(this.dir))}|${st(lockFile(this.dir))}`;
  }

  /**
   * PackageOutput.rootPath: a file as the root names it. Relative to the root's folder (where its relative paths read:
   * the project's, or the folder of a graph file in it) when it lies in the project, as copies do, so exports name no
   * folder of this machine; absolute when it lies elsewhere (a followed working folder in another library).
   */
  private rootPath = (abs: string): string => {
    const inProject = this.dir ? path.relative(this.dir, abs) : '..';
    if (!inProject || inProject.startsWith('..') || path.isAbsolute(inProject)) return abs;
    return path.relative(this.engine.root.files.resolvePath('.'), abs).split(path.sep).join('/');
  };

  /** A path for messages: relative to the project when inside it. */
  private shown(p: string): string {
    if (!this.dir) return p;
    const r = path.relative(this.dir, p);
    return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.split(path.sep).join('/') : p;
  }

  /** The project folder and its manifest; throws when the folder is in no project or project.json is not valid. */
  project(): { dir: string; manifest: ProjectManifest } {
    if (!this.dir) throw new Error(`this folder is in no project: ${MAKE_PROJECT}, whose graphs can use packages`);
    if (!this.manifest) throw new Error(this.error ?? `${manifestFile(this.dir)} cannot be read`);
    return { dir: this.dir, manifest: this.manifest };
  }

  // ---------------------------------------------------------------------------------------------- resolution

  private resolverOf(ctx: Context): PackageResolver {
    return { resolve: (name) => this.resolveIn(ctx, name), names: () => this.namesIn(ctx) };
  }

  private resolveIn(ctx: Context, name: string): NodeDef | PackageIssue {
    const n = parsePackageName(name);
    if (typeof n === 'string') return { error: n };
    const p = this.packageIn(ctx, n.package);
    if ('error' in p) return p;
    const loop = p.loops.get(n.output ?? '');
    if (loop) return { error: `${n.output === null ? `the default output of ${packageAt(p)}` : `${packageAt(p)}: output "${n.output}"`} is in a loop: ${loop}`, hint: 'a package\'s outputs use each other by full name only without a loop: change one of their graphs so that it no longer names the other' };
    if (n.output === null) return p.default ?? { error: `${packageAt(p)} has no default output${p.noDefault ? `: ${p.noDefault}` : ''}`, hint: `name one of its outputs: ${[...p.named.keys()].map((k) => `${n.package}/${k}`).join(', ') || 'it has none'}` };
    const def = p.named.get(n.output);
    if (def) return def;
    const names = [...p.named.keys()], s = didYouMean(n.output, names);
    return {
      error: `${packageAt(p)} has no output "${n.output}"${s.length ? ` — did you mean ${s.join(', ')}?` : ''}`,
      hint: `its outputs: ${names.join(', ') || 'none besides the default'}${p.default ? `; "${n.package}" alone is its default output` : ''}`,
    };
  }

  private namesIn(ctx: Context): string[] {
    const pkgs = new Set(Object.keys(ctx.uses));
    if (ctx.follows) for (const k of this.followed.keys()) pkgs.add(k);
    if (ctx.self) pkgs.add(ctx.self.package);
    const out: string[] = [];
    for (const pkg of pkgs) {
      const p = this.packageIn(ctx, pkg);
      if ('error' in p) continue;
      if (p.default) out.push(pkg);
      for (const k of p.named.keys()) out.push(`${pkg}/${k}`);
    }
    return out;
  }

  private packageIn(ctx: Context, pkg: string): Loaded | PackageIssue {
    // the package's own outputs: the same version (or working folder), with no entry in its uses
    if (ctx.self?.package === pkg) return ctx.self.get();
    if (ctx.follows && this.followed.has(pkg)) return this.loadFollowed(pkg);
    const v = ctx.uses[pkg];
    if (v !== undefined) return this.loadCopy(ctx, pkg, v);
    if (ctx !== this.root && !ctx.unavailable) return { error: `${ctx.label} does not use package ${pkg}`, hint: `its uses: ${Object.keys(ctx.uses).join(', ') || 'none'}` };
    if (!this.dir) return { error: `package ${pkg}: this graph is in no project, and only projects use packages`, hint: `${MAKE_PROJECT}; then a graph of it that names ${pkg} adds the package (or topotopo use ${pkg})` };
    if (this.error) return { error: `package ${pkg}: ${this.error}` };
    const why = (ctx.unavailable ?? this.unavailable).get(pkg);
    return {
      error: `package ${pkg} is not in this project's uses (project.json)${why ? `, and it could not be added: ${why}` : ''}`,
      hint: `topotopo use ${pkg} (MCP: library {action:"use", package:"${pkg}"}) adds its newest version from the libraries the project lists; build and edit add it when a graph first names it`,
    };
  }

  private loadCopy(ctx: Context, pkg: string, v: string): Loaded | PackageIssue {
    const key = `${pkg}@${v}`, dir = copyAt(ctx.packages, pkg, v);
    if (ctx.apart || ctx.library?.has(key)) {
      // Update's before/after: the project's own copy when it holds the version, else the version where it is
      const place = ctx.library?.get(key);
      const own = this.ownCopy(pkg, v, place ? place.info.hash : ctx.lock.packages[pkg]?.[v]?.hash, place ? place.dir : dir);
      return own ?? this.loadApart(ctx, pkg, v);
    }
    const have = this.loaded.get(key);
    if (have) {
      if ('error' in have || path.resolve(have.dir) === path.resolve(dir)) return have;
      // the same version held in a second place (a followed folder's copies) must hold the same files
      let hash = '';
      try { hash = copyHash(dir, ctx.packages); } catch (e: any) { return { error: `${pkg} ${v} in ${dir}: ${e.message}` }; }
      return hash === have.hash ? have : { error: `${pkg} ${v} has different files in ${have.dir} and in ${dir}: one of them was changed after publishing, and TopoTopo never picks one` };
    }
    if (this.loading.has(key)) return { error: `${pkg} ${v} uses itself (through ${[...this.loading].join(' → ')})` };
    this.loading.add(key);
    let r: Loaded | PackageIssue;
    try { r = this.loadCopyNow(ctx, pkg, v, dir); }
    catch (e: any) { r = { error: `${pkg} ${v}: ${e.message}` }; }
    finally { this.loading.delete(key); }
    this.loaded.set(key, r);
    return r;
  }

  private loadCopyNow(ctx: Context, pkg: string, v: string, dir: string): Loaded | PackageIssue {
    if (!fs.existsSync(path.join(dir, 'version.json')))
      return { error: missingCopy(pkg, v, this.shown(dir)), hint: `${ctx.label} uses it, and the copies are kept with the project (commit packages/): restore it, or run topotopo use ${ctx === this.root ? pkg : 'with the package the project uses that needs it'}, which copies what is missing` };
    const info = readVersionInfo(dir);
    const m = readManifest(dir);
    const hash = copyHash(dir, ctx.packages);
    const expected = ctx.lock.packages[pkg]?.[v]?.hash;
    let warning: string | undefined;
    if (expected === undefined) warning = `${this.shown(path.dirname(ctx.packages))}/packages/lock.json does not list ${pkg} ${v}: topotopo use ${pkg} records it`;
    else if (expected !== hash) warning = editedCopy(pkg, v, this.shown(dir));
    if (warning) this.problems.add(warning);
    const vctx: Context = { label: `${pkg} ${v}`, uses: m.uses, packages: ctx.packages, lock: ctx.lock, follows: false };
    return this.build({ pkg, version: v, dir, hash, signature: hash, note: info.note, warning, manifest: m, ctx: vctx, scope: `${pkg}@${v}` });
  }

  /**
   * The project's copy of a version, when it holds one that loads: the same files as the version `elsewhere` (whose
   * hash is `expected`) must be there, TopoTopo never picks between two. null when the project has no such copy.
   */
  private ownCopy(pkg: string, v: string, expected: string | undefined, elsewhere: string): Loaded | PackageIssue | null {
    if (expected === undefined || !this.dir || !this.root.lock.packages[pkg]?.[v] || !fs.existsSync(path.join(copyAt(this.root.packages, pkg, v), 'version.json'))) return null;
    const own = this.loadCopy(this.root, pkg, v);
    if ('error' in own) return null;
    return own.hash === expected ? own : { error: `${pkg} ${v} has different files in ${own.dir} and in ${elsewhere}: one of them was changed after publishing, and TopoTopo never picks one` };
  }

  /**
   * A version where a library holds it (Context.library), or a copy that such a version holds: read there without
   * copying it, apart from the project's copies, in a scope of its own whose results are keyed by its folder.
   */
  private loadApart(ctx: Context, pkg: string, v: string): Loaded | PackageIssue {
    const place = ctx.library?.get(`${pkg}@${v}`);
    const dir = path.resolve(place ? place.dir : copyAt(ctx.packages, pkg, v));
    const have = this.apart.get(dir);
    if (have) return have;
    const key = `${pkg}@${v} in ${dir}`;
    if (this.loading.has(key)) return { error: `${pkg} ${v} uses itself (through ${[...this.loading].join(' → ')})` };
    this.loading.add(key);
    let r: Loaded | PackageIssue;
    try {
      const expected = place ? place.info.hash : ctx.lock.packages[pkg]?.[v]?.hash;
      if (expected === undefined) r = { error: `${ctx.label} uses ${pkg} ${v}, and its packages/lock.json does not list it` };
      else if (!fs.existsSync(path.join(dir, 'version.json'))) r = { error: `${ctx.label} lists ${pkg} ${v} in its packages/lock.json but holds no copy of it (${dir})` };
      else {
        const info = readVersionInfo(dir), m = readManifest(dir);
        const hash = place ? versionHash(dir, true) : copyHash(dir, ctx.packages);
        if (hash !== expected) r = { error: `${pkg} ${v} in ${dir} was changed after publishing: its files do not match the hash it was published with` };
        else {
          const vctx: Context = { label: `${pkg} ${v}`, uses: m.uses, packages: place ? path.join(dir, 'packages') : ctx.packages, lock: place ? readLock(dir) : ctx.lock, follows: false, apart: true };
          r = this.build({ pkg, version: v, dir, hash, signature: `${hash}|${dir}`, note: info.note, manifest: m, ctx: vctx, scope: `${pkg}@${v}|${dir}`, problems: this.apartProblems });
        }
      }
    } catch (e: any) { r = { error: `${pkg} ${v} (${dir}): ${e.message}` }; }
    finally { this.loading.delete(key); }
    this.apart.set(dir, r);
    return r;
  }

  private loadFollowed(pkg: string): Loaded | PackageIssue {
    const have = this.followLoaded.get(pkg);
    if (have) return have;
    const f = this.followed.get(pkg)!, key = `${pkg}@working`;
    if (this.loading.has(key)) return { error: `${pkg} (working folder) uses itself (through ${[...this.loading].join(' → ')})` };
    this.loading.add(key);
    let r: Loaded | PackageIssue;
    try {
      const m = readManifest(f.dir);
      const ctx: Context = { label: `${pkg} (working folder)`, uses: m.uses, packages: path.join(f.dir, 'packages'), lock: readLock(f.dir), follows: true };
      r = this.build({ pkg, version: null, dir: f.dir, hash: f.stamp, signature: this.joint, manifest: m, ctx, scope: `${pkg}@working-${this.joint.slice(0, 16)}` });
    } catch (e: any) { r = { error: `${pkg} (working folder ${f.dir}): ${e.message}` }; }
    finally { this.loading.delete(key); }
    this.followLoaded.set(pkg, r);
    return r;
  }

  /**
   * The project's own package (the project is the package `pkg`) as its graphs are now: its graphs name their own
   * outputs, which cook from the project's folder, as they would from a working folder the session follows.
   */
  private loadSelf(pkg: string): Loaded | PackageIssue {
    if (this.selfLoaded) return this.selfLoaded;
    const key = `${pkg} (this project)`;
    if (this.loading.has(key)) return { error: `${key} uses itself (through ${[...this.loading].join(' → ')})` };
    this.loading.add(key);
    let r: Loaded | PackageIssue;
    try {
      this.selfStamp ||= workingHash(this.dir!);
      // its outputs may use the packages this session follows: their results are keyed by those folders too
      const signature = sha(`${this.selfStamp}|${this.joint}`);
      const ctx: Context = { label: key, uses: this.root.uses, packages: this.root.packages, lock: this.root.lock, follows: true };
      r = this.build({ pkg, version: null, dir: this.dir!, hash: this.selfStamp, signature, manifest: this.manifest!, ctx, scope: `${pkg}@project-${signature.slice(0, 16)}` });
    } catch (e: any) { r = { error: `${key} (${this.dir}): ${e.message}` }; }
    finally { this.loading.delete(key); }
    this.selfLoaded = r;
    return r;
  }

  /**
   * A version's (or working folder's) scope with its graphs, assets and uses, and a node type per output. Its graphs and
   * assets name its own outputs by full name: they resolve to what this builds (Context.self).
   */
  private build(o: { pkg: string; version: string | null; dir: string; hash: string; signature: string; note?: string; warning?: string; manifest: ProjectManifest; ctx: Context; scope: string; problems?: Set<string> }): Loaded {
    const problems: string[] = [];
    const graphs = readGraphs(o.dir, problems);
    const scope = this.engine.createScope(o.scope, { folder: o.dir, graphs: (n) => graphs.get(n), packages: this.resolverOf(o.ctx) });
    const outs = folderOutputs(o.manifest, graphs);
    const def = (x: FolderOutput) => packageOutputDef({
      package: o.pkg, version: o.version, hash: o.hash, signature: o.signature, output: x.name, graph: x.graph, spec: x.spec, node: x.node, scope,
      rootPath: this.rootPath,
      ...(o.note ? { note: o.note } : {}), ...(x.label ? { label: x.label } : {}), ...(o.warning ? { warning: o.warning } : {}),
    });
    const loaded: Loaded = {
      package: o.pkg, version: o.version, dir: o.dir, hash: o.hash, scope,
      named: new Map(outs.named.map((x) => [x.name!, def(x)])),
      default: outs.default ? def(outs.default) : null,
      ...(outs.default ? {} : { noDefault: outs.problems.find((p) => p.startsWith('no default output'))?.replace(/^no default output: /, '') }),
      loops: new Map(),
    };
    // its outputs exist before its assets register: an asset may name one
    o.ctx.self = { package: o.pkg, get: () => loaded };
    registerAssets(this.engine, scope, o.dir, problems);
    loaded.loops = outputLoops(o.pkg, [...outs.named, ...(outs.default ? [outs.default] : [])], scope);
    const at = packageAt({ package: o.pkg, version: o.version });
    for (const p of [...problems, ...outs.problems.filter((p) => !p.startsWith('no default output')), ...new Set(loaded.loops.values())]) (o.problems ?? this.problems).add(`${at}: ${p}`);
    return loaded;
  }

  /** Load every version the project uses (and those they use), so that problems with the copies are known. */
  check(): string[] {
    if (this.dir && this.manifest) {
      for (const pkg of Object.keys(this.root.uses)) {
        const p = this.packageIn(this.root, pkg);
        if ('error' in p) this.problems.add(p.error);
        else p.scope.packages?.names(); // loads the versions it uses
      }
    }
    return [...this.problems];
  }

  /** The copies the project's uses need, checked now: one the lock does not list, one missing, one edited by hand. */
  verifyCopies(): string[] {
    const { dir } = this.project();
    const packages = path.join(dir, 'packages');
    let lock: Lock, closure: [string, string][];
    try { lock = readLock(dir); closure = usesClosure(readManifest(dir).uses, lock); } catch (e: any) { return [e.message]; }
    const out: string[] = [];
    for (const [pkg, v] of closure) {
      const at = copyAt(packages, pkg, v);
      if (!fs.existsSync(path.join(at, 'version.json'))) out.push(missingCopy(pkg, v, this.shown(at)));
      else if (copyHash(at, packages) !== lock.packages[pkg][v].hash) out.push(editedCopy(pkg, v, this.shown(at)));
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------------ first use

  /** WorkspacePackages: add the packages a graph names that the project does not use yet. */
  addFor(graph: GraphSpec): string[] {
    if (!this.dir || !this.manifest) return [];
    const notes: string[] = [];
    for (const pkg of packagesNamedIn(graph)) {
      if (this.root.uses[pkg] !== undefined || this.followed.has(pkg) || pkg === this.manifest.package) continue;
      try { notes.push(this.use(pkg).text); this.unavailable.delete(pkg); }
      catch (e: any) { this.unavailable.set(pkg, e.message); }
    }
    return notes;
  }

  /**
   * Add a package to the project: its newest version in the libraries the project lists, copied in with the versions
   * it uses, recorded in project.json "uses" and in the lock. For a package the project uses already, the copies of the
   * version in use (and of those it uses) that went missing are copied again.
   */
  use(pkg: string): UseResult {
    const { dir } = this.project();
    if (!isPackageName(pkg)) throw new Error(`"${pkg}" is not a package name: write owner/name (lower-case letters, digits, - and _)`);
    const m = readManifest(dir);
    if (pkg === m.package) throw new Error(`this project is the package ${pkg}: its graphs name its own outputs by full name, with no entry in "uses"`);
    const inUse = m.uses[pkg];
    if (inUse !== undefined) {
      const packages = path.join(dir, 'packages');
      let complete = false;
      try { complete = usesClosure({ [pkg]: inUse }, readLock(dir)).every(([p, w]) => fs.existsSync(path.join(copyAt(packages, p, w), 'version.json'))); } catch { /* the lock lacks one: copy again */ }
      if (complete) return { version: inUse, copied: [], text: `${this.label} already uses ${pkg} ${inUse}` };
    }
    const { version: v, place } = this.versionToAdd(pkg, inUse);
    const copied = this.copyIn(pkg, v, place);
    if (inUse === undefined) {
      m.uses = sortKeys({ ...m.uses, [pkg]: v });
      writeManifest(dir, m);
    }
    this.reload();
    const deps = copied.filter((c) => c !== `${pkg} ${v}`);
    return {
      version: v, copied,
      text: inUse === undefined
        ? `added ${pkg} ${v} to ${this.label} from ${libraryText(place.library)}${deps.length ? `, with ${deps.join(', ')}` : ''}: packages/${pkg}/${v}`
        : `copied what was missing of ${pkg} ${v} again from ${libraryText(place.library)}: ${copied.join(', ')}`,
    };
  }

  /**
   * The version of a package the project adds (`v`, else the newest in the libraries it looks in, TopoTopo's built-in
   * library among them) and where a library holds it; throws saying why there is none.
   */
  private versionToAdd(pkg: string, v?: string, scanned?: Scanned): { version: string; place: Place } {
    const found = this.find(pkg, scanned);
    if (!found.versions.size) {
      const w = found.working[0];
      throw new Error(`${pkg} is in library "${w?.library ?? found.libraries[0]}"${w ? ` (${w.dir})` : ''} but has no published version yet: publish one in its folder (topotopo publish --note "...")`);
    }
    const version = v ?? newestOf(found.versions.keys())!;
    const place = found.versions.get(version)?.[0];
    if (!place) throw new Error(`project.json uses ${pkg} ${version}, and no library this project lists has that version (they have ${[...found.versions.keys()].sort(compareVersions).join(', ')})`);
    return { version, place };
  }

  /**
   * WorkspacePackages.dryRun: the packages a graph is checked with where nothing may be written (a dry run, a trial of
   * a person's values). A package it names for the first time is the version its first use would add, the newest in
   * the libraries the project looks in (TopoTopo's built-in library among them), read where that library holds it:
   * nothing is copied, and project.json and the lock stay as they are. The notes say what build or edit add. Outside a
   * project, and for a graph that names nothing new, it is the project's own resolver.
   */
  dryRun(graph: GraphSpec): { resolver: PackageResolver; notes: string[] } {
    if (!this.dir || !this.manifest || this.error) return { resolver: this.resolver, notes: [] };
    const fresh = packagesNamedIn(graph).filter((pkg) => this.root.uses[pkg] === undefined && !this.followed.has(pkg) && pkg !== this.manifest!.package);
    if (!fresh.length) return { resolver: this.resolver, notes: [] };
    const uses = { ...this.root.uses }, library = new Map<string, Place>(), unavailable = new Map<string, string>(), notes: string[] = [];
    let scanned: Scanned | undefined;
    for (const pkg of fresh) {
      try {
        const { version, place } = this.versionToAdd(pkg, undefined, scanned ??= this.scanLibraries());
        uses[pkg] = version;
        library.set(`${pkg}@${version}`, place);
        notes.push(`build or edit adds ${pkg} ${version} to ${this.label} on first use, from ${libraryText(place.library)}: this dry run read it there and copied nothing`);
      } catch (e: any) { unavailable.set(pkg, e.message); }
    }
    const ctx: Context = { ...this.root, uses: sortKeys(uses), library, unavailable };
    return { resolver: { ...this.resolverOf(ctx), offered: () => this.offered() }, notes };
  }

  /** Copy a version as published, and the versions it holds copies of, into the project; record them in the lock. */
  private copyIn(pkg: string, v: string, place: Place): string[] {
    const dir = this.dir!;
    if (versionHash(place.dir) !== place.info.hash)
      throw new Error(`${pkg} ${v} in ${place.dir} (${libraryText(place.library)}) was changed after publishing: its files do not match the hash in its version.json, so it is not copied`);
    type Wanted = { pkg: string; v: string; from: string; hash: string; uses: Record<string, string>; keep?: (rel: string) => boolean };
    const own = readLock(place.dir).packages;
    const byKey = new Map<string, Wanted>([[`${pkg}@${v}`, { pkg, v, from: place.dir, hash: place.info.hash, uses: readManifest(place.dir).uses, keep: (rel) => !nestedCopy(rel) }]]);
    for (const [p, vs] of Object.entries(own)) for (const [w, e] of Object.entries(vs))
      byKey.set(`${p}@${w}`, { pkg: p, v: w, from: copyAt(path.join(place.dir, 'packages'), p, w), hash: e.hash, uses: e.uses });
    // the versions a version uses come before it, so a copy that is there already can be checked with them
    const wanted: Wanted[] = [], placed = new Set<string>();
    const visit = (key: string) => {
      const w = byKey.get(key);
      if (!w || placed.has(key)) return;
      placed.add(key);
      for (const [p, x] of Object.entries(w.uses)) visit(`${p}@${x}`);
      wanted.push(w);
    };
    for (const key of byKey.keys()) visit(key);
    const lock = readLock(dir), packages = path.join(dir, 'packages');
    const copied: string[] = [];
    for (const w of wanted) {
      if (!fs.existsSync(path.join(w.from, 'version.json'))) throw new Error(`${pkg} ${v} in library "${place.library}" lists ${w.pkg} ${w.v} in its packages/lock.json but holds no copy of it (${w.from})`);
      const to = copyAt(packages, w.pkg, w.v), have = lock.packages[w.pkg]?.[w.v];
      if (have && have.hash !== w.hash)
        throw new Error(`${w.pkg} ${w.v} has different files in ${this.shown(to)} (from library "${have.library}") and in ${w.from} (library "${place.library}"): one of them was changed after publishing, and TopoTopo never picks one`);
      if (fs.existsSync(path.join(to, 'version.json'))) {
        // already here (another package uses it too): it must be this version
        if (!have && copyHash(to, packages) !== w.hash) throw new Error(`${this.shown(to)} holds other files than ${w.pkg} ${w.v} as published: move it away, then try again`);
      } else {
        if (fs.existsSync(to)) throw new Error(`${this.shown(to)} is there but holds no version (no version.json): move it away, then try again`);
        copyTree(w.from, to, w.keep);
        copied.push(`${w.pkg} ${w.v}`);
      }
      // the lock keeps the library a copy came from
      if (!have || copied.includes(`${w.pkg} ${w.v}`)) (lock.packages[w.pkg] ??= {})[w.v] = { hash: w.hash, library: place.library, uses: w.uses };
    }
    writeLock(dir, lock);
    return copied;
  }

  /**
   * The libraries the project lists (project.json as it is now): a path relative to the project, or a registered
   * library's name. TopoTopo's built-in library, which every project looks in, is not one of them (listing it by its
   * name changes nothing).
   */
  libraries(): { entry: string; root: string }[] {
    const { dir } = this.project();
    const manifest = readManifest(dir);
    let cfg: GalleryConfig | null = null;
    return manifest.libraries.filter((entry) => entry !== BUILTIN_LIBRARY.name).map((entry) => {
      if (ID_RE.test(entry)) {
        cfg ??= loadConfig();
        const lib = cfg.libraries.find((l) => l.name === entry);
        if (!lib) throw new Error(`project.json lists library "${entry}", which is not registered on this machine (${cfg.file}): topotopo library add ${entry} <folder>, or list the library by its path relative to the project`);
        return { entry, root: lib.path };
      }
      const root = path.resolve(dir, entry);
      if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`project.json lists library "${entry}", and ${root} is not a folder`);
      return { entry, root };
    });
  }

  /** The packages of TopoTopo's built-in library: their versions, and in TopoTopo's repository their working folders. */
  private builtinPackages(): PackageFolder[] {
    return builtinPackages(this.builtin, this.problems);
  }

  /** TopoTopo's built-in library and the project's libraries, and the packages in them (their folders). */
  private scanLibraries(): Scanned {
    const libs = this.libraries();
    const builtin = this.builtinPackages(), seen = new Set(builtin.map((p) => path.resolve(p.dir).toLowerCase()));
    // a library listed that is the built-in library's folder holds nothing more
    const listed = libs.flatMap((lib) => scanLibrary({ name: lib.entry, path: lib.root }).projects.flatMap((p) => (p.manifest.package && !seen.has(path.resolve(p.dir).toLowerCase()) ? [{ package: p.manifest.package, library: lib.entry, dir: p.dir, working: true }] : [])));
    return { libs, packages: [...builtin, ...listed] };
  }

  /** The libraries, working folders and versions of a package in the libraries the project looks in; throws saying where it is not. */
  private find(pkg: string, scanned: Scanned = this.scanLibraries()): Found {
    const { libs } = scanned;
    const found: Found = { package: pkg, libraries: [], working: [], versions: new Map() };
    const others = new Set(scanned.packages.map((p) => p.package));
    for (const p of scanned.packages) {
      if (p.package !== pkg) continue;
      if (!found.libraries.includes(p.library)) found.libraries.push(p.library);
      if (p.working) found.working.push({ library: p.library, dir: p.dir });
      for (const place of readVersions(p.dir, pkg, p.library, this.problems)) {
        const list = found.versions.get(place.info.version) ?? [];
        list.push(place);
        found.versions.set(place.info.version, list);
      }
    }
    // one version number holds the same files everywhere
    for (const [v, places] of found.versions) {
      const other = places.find((p) => p.info.hash !== places[0].info.hash);
      if (other) throw new Error(`${pkg} ${v} has different files in ${places[0].dir} (library "${places[0].library}") and in ${other.dir} (library "${other.library}"): one of them was changed after publishing, and TopoTopo never picks one`);
    }
    if (found.libraries.length) return found;
    // in a registered library the project does not list?
    let cfg: GalleryConfig | null = null;
    try { cfg = loadConfig(); } catch { /* an unreadable config: only the listed libraries count */ }
    const listed = new Set(libs.map((l) => path.resolve(l.root).toLowerCase()));
    for (const lib of cfg?.libraries ?? []) {
      if (listed.has(path.resolve(lib.path).toLowerCase())) continue;
      if (scanLibrary(lib).projects.some((p) => p.manifest.package === pkg))
        throw new Error(`${pkg} is in library "${lib.name}" (${lib.path}), which this project does not list: add "${lib.name}" to "libraries" in its project.json (or the library's path relative to the project, when it is in the same repository)`);
    }
    const s = didYouMean(pkg, [...others]);
    throw new Error(libs.length
      ? `no library this project lists has a package ${pkg}${s.length ? ` (did you mean ${s.join(', ')}?)` : ''}; it looks in ${libs.map((l) => `"${l.entry}" (${l.root})`).join(', ')} and in TopoTopo's built-in library`
      : `this project lists no libraries to find ${pkg} in${s.length ? ` (did you mean ${s.join(', ')}?)` : ''}, and TopoTopo's built-in library, which every project looks in, holds TopoTopo's own packages alone: add "libraries" to its project.json, a path relative to the project or a registered library's name`);
  }

  // ------------------------------------------------------------------------------------------------- following

  /** The packages followed this session, with their working folders. */
  following(): { package: string; dir: string; library: string }[] {
    return [...this.followed.values()].map((f) => ({ package: f.package, dir: f.dir, library: f.library }));
  }

  /**
   * Follow a package's working folder for this session, or stop: while it lasts the package resolves to its working
   * folder in the project's libraries instead of its copy, under a scope that changes whenever its files do. Nothing
   * about it is saved.
   */
  follow(pkg: string, on = true): string {
    this.project();
    if (!isPackageName(pkg)) throw new Error(`"${pkg}" is not a package name: write owner/name`);
    if (!on) {
      if (!this.followed.delete(pkg)) return `${pkg} is not followed`;
      this.restamp();
      this.rewatch();
      const v = this.root.uses[pkg];
      return `stopped following ${pkg}: it resolves to ${v ? `its copy (${v})` : 'nothing in this project (it is not in its uses)'} again`;
    }
    if (pkg === this.manifest?.package) throw new Error(`this project is the package ${pkg}: its own graphs are its working folder already`);
    const found = this.find(pkg);
    if (!found.working.length)
      throw new Error(`${pkg} has no working folder in the libraries this project looks in: ${found.libraries.map((l) => `"${l}"`).join(', ')} ${found.libraries.length === 1 ? 'holds' : 'hold'} its versions alone${found.libraries.includes(BUILTIN_LIBRARY.name) ? ' (an installed TopoTopo ships its own packages without their working folders)' : ''}, and follow needs one`);
    if (found.working.length > 1)
      throw new Error(`${pkg} has a working folder in more than one library this project lists: ${found.working.map((w) => `${w.dir} ("${w.library}")`).join(', ')}; follow needs exactly one`);
    const w = found.working[0];
    this.followed.set(pkg, { package: pkg, dir: w.dir, library: w.library, stamp: '' });
    this.restamp();
    this.rewatch();
    const v = this.root.uses[pkg];
    return `following ${pkg} for this session: its working folder ${w.dir} (${libraryText(w.library)}) instead of ${v ? `the copy of ${v}` : 'a copy (the project does not use it yet)'}; its edits re-cook, exports record it, and publishing this project is refused while it lasts`;
  }

  private restamp(): boolean {
    let changed = false;
    for (const f of this.followed.values()) {
      let s: string;
      try { s = workingHash(f.dir); } catch (e: any) { s = `unreadable: ${e.message}`; }
      if (s !== f.stamp) { f.stamp = s; changed = true; }
    }
    const joint = this.followed.size ? sha([...this.followed.values()].map((f) => `${f.package} ${f.stamp}\n`).sort().join('')) : '';
    if (joint !== this.joint) { this.joint = joint; changed = true; }
    if (changed) { this.followLoaded.clear(); this.selfLoaded = null; }
    return changed;
  }

  /** The project's own package, once its graphs named one of its outputs: true when its files changed since. */
  private restampSelf(): boolean {
    if (!this.selfStamp || !this.dir) return false;
    let s: string;
    try { s = workingHash(this.dir); } catch (e: any) { s = `unreadable: ${e.message}`; }
    if (s === this.selfStamp) return false;
    this.selfStamp = s;
    this.selfLoaded = null;
    return true;
  }

  /**
   * WorkspacePackages: read again what changed on disk: project.json and the lock, followed working folders, and the
   * project's own graphs when they name its own outputs.
   */
  refresh(): boolean {
    let changed = false;
    if (this.diskStamp() !== this.disk) { this.reload(); changed = true; }
    if (this.followed.size && this.restamp()) changed = true;
    if (this.restampSelf()) changed = true;
    return changed;
  }

  /**
   * WorkspacePackages: a stamp of what package names resolve to: project.json and the lock as they are on disk now,
   * and the files of the followed working folders and of the project's own package as refresh() last found them.
   */
  revision(): string {
    return `${this.diskStamp()}|${this.joint}|${this.selfStamp}`;
  }

  /** Call `onChange` after a followed working folder changed on disk (and refresh() has taken it in). */
  watch(onChange: () => void) {
    this.onChange = onChange;
    this.rewatch();
  }

  unwatch() {
    this.onChange = null;
    this.rewatch();
  }

  private rewatch() {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    clearTimeout(this.watchTimer);
    if (!this.onChange) return;
    for (const f of this.followed.values()) {
      try {
        const w = fs.watch(f.dir, { recursive: true }, () => {
          clearTimeout(this.watchTimer);
          this.watchTimer = setTimeout(() => { if (this.refresh()) this.onChange?.(); }, 150);
          this.watchTimer.unref?.();
        });
        w.on('error', () => w.close());
        w.unref();
        this.watchers.push(w);
      } catch { /* not watchable: every cook reads it again (refresh) */ }
    }
  }

  // --------------------------------------------------------------------------------------------- the libraries

  /**
   * Every package in TopoTopo's built-in library and the project's libraries: its folder (a working folder, or for one
   * of TopoTopo's own the folder of its versions), and its versions with their records.
   */
  catalog(): (PackageFolder & { versions: VersionInfo[] })[] {
    return this.scanLibraries().packages
      .map((p) => ({ ...p, versions: readVersions(p.dir, p.package, p.library, this.problems).map((x) => x.info).sort((a, b) => compareVersions(a.version, b.version)) }))
      .sort((a, b) => (a.package < b.package ? -1 : a.package > b.package ? 1 : 0));
  }

  /** For each package the project uses: the version in use, the small and the big update, every version after it. */
  outdated(): Outdated[] {
    const { dir } = this.project();
    const uses = readManifest(dir).uses;
    let scanned: Scanned | null = null, why = '';
    if (Object.keys(uses).length) try { scanned = this.scanLibraries(); } catch (e: any) { why = e.message; }
    return Object.entries(uses).map(([pkg, version]) => {
      const o: Outdated = { package: pkg, version, newer: [], libraries: [], working: [] };
      if (!scanned) return { ...o, error: why };
      try {
        const f = this.find(pkg, scanned);
        const big = versionParts(version)[0];
        const after = [...f.versions.keys()].sort(compareVersions).filter((v) => compareVersions(v, version) > 0);
        const small = after.filter((v) => versionParts(v)[0] === big).at(-1), top = after.at(-1);
        o.newer = after.map((v) => f.versions.get(v)![0].info);
        o.libraries = f.libraries;
        o.working = f.working;
        if (small) o.small = small;
        if (top && versionParts(top)[0] > big) o.big = top;
      } catch (e: any) { o.error = e.message; }
      return o;
    });
  }

  /**
   * What an Update of a package the project uses goes to: `to`, or else the newest version with the same big number. A
   * big version is a step of its own: it is named. Throws saying why there is none.
   */
  updateTarget(pkg: string, to?: string): UpdateTarget {
    const { dir } = this.project();
    if (!isPackageName(pkg)) throw new Error(`"${pkg}" is not a package name: write owner/name`);
    this.refresh();
    const uses = readManifest(dir).uses, from = uses[pkg];
    if (from === undefined) {
      const users = Object.entries(readLock(dir).packages).flatMap(([p, vs]) => Object.entries(vs).filter(([, e]) => e.uses[pkg]).map(([w, e]) => `${p} ${w} uses ${pkg} ${e.uses[pkg]}`));
      throw new Error(users.length
        ? `this project does not use ${pkg} itself (${users.join('; ')}): a version keeps what it uses, so updating the package that uses it can bring another`
        : `this project does not use ${pkg}: its uses are ${Object.keys(uses).join(', ') || 'none'}`);
    }
    if (to !== undefined && !VERSION_RE.test(to)) throw new Error(`"${to}" is not a version: write big.small, such as 1.4`);
    const found = this.find(pkg);
    const all = [...found.versions.keys()].sort(compareVersions);
    const bigOf = (v: string) => versionParts(v)[0];
    let target = to;
    if (target === undefined) {
      target = all.filter((v) => bigOf(v) === bigOf(from) && compareVersions(v, from) > 0).at(-1);
      const big = all.filter((v) => bigOf(v) > bigOf(from)).at(-1);
      if (!target) throw new Error(big
        ? `${pkg} ${from} is the newest ${bigOf(from)}.x in the project's libraries, and ${big} is a big version, a step of its own: name it, --to ${big} (library {action:"update", package:"${pkg}", to:"${big}"})`
        : `${pkg} ${from} is the newest version in the project's libraries: there is nothing to update`);
    } else if (target === from) throw new Error(`this project uses ${pkg} ${from} already`);
    const place = found.versions.get(target)?.[0];
    if (!place) throw new Error(`no library this project lists has ${pkg} ${target}: they have ${all.join(', ') || 'no version of it'}`);
    const [lo, hi] = compareVersions(target, from) > 0 ? [from, target] : [target, from];
    return {
      package: pkg, from, to: target, big: bigOf(target) !== bigOf(from),
      fromInfo: this.copyInfo(pkg, from) ?? found.versions.get(from)?.[0]?.info ?? null, toInfo: place.info,
      between: all.filter((v) => compareVersions(v, lo) > 0 && compareVersions(v, hi) <= 0).map((v) => found.versions.get(v)![0].info),
      library: place.library, dir: place.dir,
    };
  }

  /**
   * The package resolvers of Update's before/after: the project as its copies cook it now (what this session follows
   * plays no part) and as it would after the update, which reads the new version where its library holds it. Nothing
   * is copied. `key` tells pairs apart, for the ids of scopes made with them.
   */
  updateResolvers(t: UpdateTarget): { before: PackageResolver; after: PackageResolver; key: string } {
    const uses = sortKeys({ ...this.root.uses, [t.package]: t.to });
    const before = this.followed.size ? this.resolverOf({ ...this.root, follows: false }) : this.resolver;
    const after = this.resolverOf({
      label: 'this project after the update', uses, packages: this.root.packages, lock: this.root.lock, follows: false, self: this.root.self,
      library: new Map([[`${t.package}@${t.to}`, { library: t.library, dir: t.dir, info: t.toInfo }]]),
    });
    return { before, after, key: sha(JSON.stringify([this.root.uses, uses, t.dir])).slice(0, 16) };
  }

  /**
   * Apply an update: copy the version in with the versions it uses, name it in "uses" and the lock, and delete the
   * copies nothing uses any more (those the project's uses needed before and need no more).
   */
  applyUpdate(t: UpdateTarget): UpdateResult {
    const { dir } = this.project();
    const m = readManifest(dir);
    if (m.uses[t.package] !== t.from) throw new Error(`project.json uses ${t.package} ${m.uses[t.package] ?? 'no more'} now, not ${t.from}: look at the before/after again`);
    const packages = path.join(dir, 'packages');
    let before: [string, string][] = [];
    try { before = usesClosure(m.uses, readLock(dir)); } catch { /* the lock misses a version: nothing is deleted */ }
    const copied = this.copyIn(t.package, t.to, { library: t.library, dir: t.dir, info: t.toInfo });
    m.uses = sortKeys({ ...m.uses, [t.package]: t.to });
    writeManifest(dir, m);
    const lock = readLock(dir);
    let keep: Set<string> | null = null;
    try { keep = new Set(usesClosure(m.uses, lock).map(([p, v]) => `${p}@${v}`)); } catch { /* the lock misses a version: every copy stays */ }
    const deleted: string[] = [];
    for (const [p, v] of keep ? before : []) {
      if (keep!.has(`${p}@${v}`)) continue;
      if (lock.packages[p]) { delete lock.packages[p][v]; if (!Object.keys(lock.packages[p]).length) delete lock.packages[p]; }
      const at = copyAt(packages, p, v);
      fs.rmSync(at, { recursive: true, force: true });
      // the package's and the owner's folders go once they are empty
      for (let d = path.dirname(at); d.length > packages.length; d = path.dirname(d)) { try { fs.rmdirSync(d); } catch { break; } }
      this.loaded.delete(`${p}@${v}`);
      deleted.push(`${p} ${v}`);
    }
    writeLock(dir, lock);
    this.reload();
    return {
      copied, deleted,
      text: [
        `updated ${t.package} ${t.from} → ${t.to} in ${this.label}: project.json uses ${t.package} ${t.to}, from ${libraryText(t.library)}`,
        `  copied into packages/: ${copied.length ? copied.join(', ') : 'nothing (the project held it already)'}; packages/lock.json records them`,
        `  deleted the copies nothing uses any more: ${deleted.length ? deleted.join(', ') : 'none (every other copy is still used)'}`,
      ].join('\n'),
    };
  }

  /**
   * PackageResolver.offered: the outputs of TopoTopo's own packages the project does not use, at the newest version its
   * built-in library holds, read there (nothing is copied): the catalog and help list them, and a graph's first use adds
   * the package. Outside a project as well, where naming one is an error that says how to make the folder a project.
   */
  private offered(): NodeDef[] {
    const out: NodeDef[] = [];
    for (const b of this.builtinPackages()) {
      if (this.root.uses[b.package] !== undefined || this.followed.has(b.package) || b.package === this.root.self?.package) continue;
      const place = readVersions(b.dir, b.package, b.library, this.problems).at(-1);
      if (!place) continue;
      const v = place.info.version;
      const p = this.packageIn({ label: `${b.package} ${v}`, uses: { [b.package]: v }, packages: '', lock: { packages: {} }, follows: false, library: new Map([[`${b.package}@${v}`, place]]) }, b.package);
      if ('error' in p) { this.problems.add(p.error); continue; }
      if (p.default && !p.loops.has('')) out.push(p.default);
      for (const [k, d] of p.named) if (!p.loops.has(k)) out.push(d);
    }
    return out;
  }

  /** The version record of a copy the project holds, null when it is missing. */
  copyInfo(pkg: string, v: string): VersionInfo | null {
    return this.dir ? copyRecord(this.dir, pkg, v) : null;
  }

  /** The lock's entries for the versions the project uses, and those they use. */
  lockEntries(): { package: string; version: string; entry: LockEntry | null; direct: boolean }[] {
    const lock = this.root.lock, out: { package: string; version: string; entry: LockEntry | null; direct: boolean }[] = [];
    const seen = new Set<string>();
    const visit = (pkg: string, v: string, direct: boolean) => {
      if (seen.has(`${pkg}@${v}`)) return;
      seen.add(`${pkg}@${v}`);
      const e = lock.packages[pkg]?.[v] ?? null;
      out.push({ package: pkg, version: v, entry: e, direct });
      for (const [p, w] of Object.entries(e?.uses ?? {})) visit(p, w, false);
    };
    for (const [pkg, v] of Object.entries(this.root.uses)) visit(pkg, v, true);
    return out;
  }
}

/** The records of a package's published versions (its versions/ folder), oldest first; unreadable ones are left out. */
export function publishedVersions(dir: string, pkg: string): VersionInfo[] {
  return readVersions(dir, pkg, '', new Set()).map((p) => p.info);
}

/** The records of the versions TopoTopo's built-in library holds of a package, oldest first (none of a package not TopoTopo's). */
export function builtinVersions(pkg: string, builtin = BUILTIN_LIBRARY.path): VersionInfo[] {
  const [owner, name] = pkg.split('/');
  return owner === RESERVED_OWNER && name && ID_RE.test(name) ? publishedVersions(path.join(builtin, name), pkg) : [];
}

/** The record of a version a project holds a copy of (packages/<owner>/<name>/<version>/), null when it holds none. */
export function copyRecord(dir: string, pkg: string, v: string): VersionInfo | null {
  try { return readVersionInfo(copyAt(path.join(dir, 'packages'), pkg, v)); } catch { return null; }
}

/** The versions in a package's versions/ folder; unreadable records are problems. */
function readVersions(dir: string, pkg: string, library: string, problems: Set<string>): Place[] {
  const out: Place[] = [];
  let names: string[] = [];
  try { names = fs.readdirSync(path.join(dir, 'versions')).filter((v) => VERSION_RE.test(v)); } catch { return out; }
  for (const v of names.sort(compareVersions)) {
    const vdir = path.join(dir, 'versions', v);
    if (!fs.existsSync(path.join(vdir, 'version.json'))) continue;
    try {
      const info = readVersionInfo(vdir);
      if (info.package !== pkg || info.version !== v) { problems.add(`${vdir}: its version.json says ${info.package} ${info.version}`); continue; }
      out.push({ library, dir: vdir, info });
    } catch (e: any) { problems.add(e.message); }
  }
  return out;
}

/**
 * The packages of the project a folder belongs to (the folder itself or the nearest one above with project.json),
 * attached to the engine's root scope, and the working folders to follow this session. `builtin`: the folder of
 * TopoTopo's built-in library (default: the one TopoTopo ships).
 */
export function openPackages(engine: Engine, start: string, opts: { follow?: string[]; builtin?: string } = {}): ProjectPackages {
  const pk = new ProjectPackages(engine, projectDirOf(start), { builtin: opts.builtin });
  engine.root.packages = pk.resolver;
  for (const f of opts.follow ?? []) pk.follow(f, true);
  return pk;
}

/**
 * A project's assets and graphs in a scope (default: the engine's root) as a workspace has them, read without writing
 * anything (a workspace makes its folders): for a command that cooks the project's graphs and leaves the project as it
 * is, or for the viewer of a graph file, whose workspace is not the project. Says what could not be read.
 */
export function loadProject(engine: Engine, dir: string, scope: Scope = engine.root): string[] {
  const problems: string[] = [];
  const graphs = readGraphs(dir, problems);
  scope.graphs = (n) => graphs.get(n);
  registerAssets(engine, scope, dir, problems);
  return problems;
}

// ------------------------------------------------------------------------------------------------------ publishing

/**
 * What a version published from the project folder `dir` holds: project.json without "libraries" (where the working
 * folder looks for packages is not part of the package), graphs/, assets/, inputs/, and the copies its uses need with
 * their lock. Files by path, or bytes for the files written anew.
 */
function versionFiles(dir: string, m: ProjectManifest, lock: Lock): { rel: string; abs?: string; bytes?: Uint8Array }[] {
  const raw = JSON.parse(fs.readFileSync(manifestFile(dir), 'utf8'));
  delete raw.libraries;
  const out: { rel: string; abs?: string; bytes?: Uint8Array }[] = [{ rel: 'project.json', bytes: Buffer.from(JSON.stringify(raw, null, 2) + '\n') }];
  for (const d of ['graphs', 'assets', 'inputs']) for (const f of filesBelow(path.join(dir, d))) out.push({ rel: `${d}/${f.rel}`, abs: f.abs });
  const closure = usesClosure(m.uses, lock);
  if (closure.length) {
    const own: Lock = { packages: {} };
    for (const [pkg, v] of closure) {
      (own.packages[pkg] ??= {})[v] = lock.packages[pkg][v];
      for (const f of filesBelow(copyAt(path.join(dir, 'packages'), pkg, v))) out.push({ rel: `packages/${pkg}/${v}/${f.rel}`, abs: f.abs });
    }
    out.push({ rel: 'packages/lock.json', bytes: Buffer.from(lockText(own)) });
  }
  return out.sort(byRel);
}

/**
 * What changed between two versions' interfaces: what makes a big version (an output, slider or input that goes away
 * or means something else: removed or renamed, another type, a narrower range, a removed option, an input moved), and
 * the rest (added outputs, sliders, options and inputs, wider ranges, changed defaults, labels and descriptions).
 */
export function compareInterfaces(prev: Pick<VersionInfo, 'outputs' | 'default'>, next: Pick<VersionInfo, 'outputs' | 'default'>): { big: string[]; small: string[] } {
  const big: string[] = [], small: string[] = [];
  const range = (s: SliderInfo) => `${s.min ?? ''}..${s.max ?? ''}`;
  const output = (what: string, a: OutputInfo, b: OutputInfo) => {
    if (a.graph !== b.graph || a.node !== b.node) small.push(`${what} now cooks "${b.node}" of graph "${b.graph}" (was "${a.node}" of "${a.graph}")`);
    if ((a.label ?? '') !== (b.label ?? '')) small.push(`${what}: label "${a.label ?? ''}" → "${b.label ?? ''}"`);
    for (const [k, s] of Object.entries(a.sliders)) {
      const t = b.sliders[k];
      if (!t) { big.push(`${what}: slider "${k}" removed`); continue; }
      if (t.type !== s.type) { big.push(`${what}: slider "${k}" is now ${t.type} (was ${s.type})`); continue; }
      const narrower = (t.min !== undefined && (s.min === undefined || t.min > s.min)) || (t.max !== undefined && (s.max === undefined || t.max < s.max));
      const wider = (s.min !== undefined && (t.min === undefined || t.min < s.min)) || (s.max !== undefined && (t.max === undefined || t.max > s.max));
      if (narrower) big.push(`${what}: slider "${k}" range ${range(s)} → ${range(t)} (narrower)`);
      else if (wider) small.push(`${what}: slider "${k}" range ${range(s)} → ${range(t)} (wider)`);
      const gone = s.options && t.options ? s.options.filter((x) => !t.options!.includes(x)) : [];
      if (gone.length) big.push(`${what}: slider "${k}" lost option${gone.length > 1 ? 's' : ''} ${gone.map((x) => JSON.stringify(x)).join(', ')}`);
      const added = t.options && s.options ? t.options.filter((x) => !s.options!.includes(x)) : [];
      if (added.length) small.push(`${what}: slider "${k}" gained option${added.length > 1 ? 's' : ''} ${added.map((x) => JSON.stringify(x)).join(', ')}`);
      if (JSON.stringify(s.default) !== JSON.stringify(t.default)) small.push(`${what}: slider "${k}" default ${JSON.stringify(s.default)} → ${JSON.stringify(t.default)}`);
      if ((s.label ?? '') !== (t.label ?? '') || (s.desc ?? '') !== (t.desc ?? '')) small.push(`${what}: slider "${k}" label or description changed`);
    }
    for (const k of Object.keys(b.sliders)) if (!a.sliders[k]) small.push(`${what}: slider "${k}" added`);
    for (const i of a.inputs) {
      const at = b.inputs.find((x) => x.index === i.index);
      const moved = i.label ? b.inputs.find((x) => x.label === i.label && x.index !== i.index) : undefined;
      if (moved && (!at || at.label !== i.label)) big.push(`${what}: input "${i.label}" moved from ${i.index} to ${moved.index}`);
      else if (!at) big.push(`${what}: input ${i.index}${i.label ? ` ("${i.label}")` : ''} removed`);
      else if (at.label !== i.label) small.push(`${what}: input ${i.index} label "${i.label}" → "${at.label}"`);
    }
    for (const i of b.inputs)
      if (!a.inputs.some((x) => x.index === i.index || (!!i.label && x.label === i.label))) small.push(`${what}: input ${i.index}${i.label ? ` ("${i.label}")` : ''} added`);
  };
  for (const [k, a] of Object.entries(prev.outputs)) {
    if (!next.outputs[k]) big.push(`output "${k}" removed (or renamed, or marked "publish": false)`);
    else output(`output "${k}"`, a, next.outputs[k]);
  }
  for (const k of Object.keys(next.outputs)) if (!prev.outputs[k]) small.push(`output "${k}" added`);
  // a default output that is the same named output in both versions has its changes listed with that output
  const named = (o: OutputInfo, outs: Record<string, OutputInfo>) => Object.keys(outs).find((k) => outs[k].graph === o.graph && outs[k].node === o.node);
  const was = named(prev.default, prev.outputs);
  if (!was || was !== named(next.default, next.outputs)) output('the default output', prev.default, next.default);
  return { big, small };
}

/** Files a version's graphs and assets read that it does not hold: URLs (their content can change) and paths outside it. */
function unheldFiles(sources: Map<string, GraphSpec>): string[] {
  const out: string[] = [];
  const walk = (g: GraphSpec, where: string, depth: number) => {
    if (depth > 64 || !g?.nodes || typeof g.nodes !== 'object') return;
    for (const [name, node] of Object.entries(g.nodes)) {
      if (!node || typeof node !== 'object' || typeof node.type !== 'string' || !node.params || typeof node.params !== 'object') continue;
      const def = getNodeDef(node.type);
      for (const [k, v] of Object.entries(node.params)) {
        if (v && typeof v === 'object' && !Array.isArray(v) && (v as GraphSpec).nodes) { walk(v as GraphSpec, `${where}${name}/`, depth + 1); continue; }
        const pn = def ? resolveParamName(def, k) : null;
        if (!pn || def!.params[pn].type !== 'path' || typeof v !== 'string' || !v || v.startsWith('=')) continue;
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) out.push(`${where}${name} reads ${v}: a version holds no copy of a URL, so what it gives can change after publishing (put the file in inputs/)`);
        else if (!/^(image|embedded):/.test(v) && (path.isAbsolute(v) || /^[A-Za-z]:/.test(v) || path.posix.normalize(v.replace(/\\/g, '/')).startsWith('../')))
          out.push(`${where}${name} reads ${v}, outside the package folder: the version does not hold it (put the file in inputs/)`);
      }
    }
  };
  for (const [where, g] of sources) walk(g, `${where}: `, 0);
  return out;
}

export interface PublishOptions {
  /** the author's one-line note (required) */
  note?: string;
  /** mark the version big though the rule finds nothing that makes it big */
  big?: boolean;
  /**
   * publish one of TopoTopo's own packages: a folder <name> of TopoTopo's built-in library (ProjectPackages.builtin),
   * the package topotopo/<name>. TopoTopo's repository publishes its own packages this way; the tools never do, and the
   * owner "topotopo" is refused for every other project.
   */
  builtin?: boolean;
}

export interface PublishResult {
  ok: boolean;
  package: string;
  /** the version written */
  version?: string;
  /** the version before it */
  previous?: string;
  note: string;
  /** why the number is big: the rule's findings, and the author's mark */
  bigBecause: string[];
  /** the other changes since the previous version */
  changes: string[];
  /** what kept it from being published */
  blocks: string[];
  warnings: string[];
  dir?: string;
  hash?: string;
  files?: number;
  bytes?: number;
}

/**
 * Publish the project of a workspace as the next version of its package: check its name, outputs and default output,
 * cook every published output, number the version by comparing it with the previous one (and the author's `big`), and
 * write versions/<big>.<small>/. Blocks: an output that does not cook, an output name clash, outputs that name each
 * other in a loop, no default output, a copy edited by hand, nothing changed, no note, a package the session follows.
 */
export async function publishPackage(ws: Workspace, pk: ProjectPackages, o: PublishOptions): Promise<PublishResult> {
  const { dir } = pk.project();
  // what its graphs name resolves as its files are now (its own outputs, the copies)
  pk.refresh();
  const m = readManifest(dir);
  // one line: a note says what changed
  const note = (o.note ?? '').replace(/\s+/g, ' ').trim();
  const r: PublishResult = { ok: false, package: m.package ?? '', note, bigBecause: [], changes: [], blocks: [], warnings: [] };
  // TopoTopo's own packages: a folder of its built-in library, named as the package
  const inBuiltin = path.relative(pk.builtin, dir), kit = !!inBuiltin && !inBuiltin.startsWith('..') && !path.isAbsolute(inBuiltin) && !/[\\/]/.test(inBuiltin);
  if (!m.package) r.blocks.push(`project.json has no "package": the author names the package once, e.g. "package": "<owner>/${m.id}" (owner and name: lower-case letters, digits, - and _)`);
  else if (o.builtin) {
    if (!kit) r.blocks.push(`only a folder of TopoTopo's built-in library (${pk.builtin}) publishes one of TopoTopo's own packages, and ${dir} is none`);
    else if (m.package !== `${RESERVED_OWNER}/${inBuiltin}`) r.blocks.push(`the folder ${inBuiltin} of TopoTopo's built-in library holds the package ${RESERVED_OWNER}/${inBuiltin}, and its project.json names ${m.package}`);
  } else if (m.package.split('/')[0] === RESERVED_OWNER) r.blocks.push(`the owner "${RESERVED_OWNER}" is reserved for TopoTopo's own packages, which TopoTopo's repository publishes into its built-in library: publish under your own owner`);
  if (!note) r.blocks.push('a version needs a note, one line on what changed: --note "..." (library {action:"publish", note})');
  for (const f of pk.following()) r.blocks.push(`this session follows ${f.package} from its working folder (${f.dir}): stop following it to publish`);
  let lock: Lock = { packages: {} };
  try { lock = readLock(dir); } catch (e: any) { r.blocks.push(e.message); }
  // a version holds its copies as published: none missing, none edited by hand
  r.blocks.push(...pk.verifyCopies());
  const problems: string[] = [];
  const graphs = readGraphs(dir, problems);
  r.blocks.push(...problems);
  const outs = folderOutputs(m, graphs);
  r.blocks.push(...outs.problems);
  if (r.blocks.length) return r;
  // its outputs name each other only without a loop (the project's assets and graphs are the root scope's)
  r.blocks.push(...new Set(outputLoops(m.package!, [...outs.named, outs.default!], ws.engine.root).values()));
  if (r.blocks.length) return r;

  // every published output cooks
  const all = [...outs.named, outs.default!];
  for (const x of all) {
    const what = x.name === null ? `the default output ("${x.node}" of graph "${x.graph}")` : `output "${x.name}" (graph "${x.graph}")`;
    const c = await ws.engine.cook(x.spec, { target: x.node });
    if (!c.ok || !c.geo) r.blocks.push(`${what} does not cook: ${c.errors.map((e) => `[${e.node}] ${e.message}`).join('; ') || 'no geometry'}`);
    for (const w of c.warnings) r.warnings.push(`${what}: [${w.node}] ${w.message}`);
  }
  if (r.blocks.length) return r;

  const files = versionFiles(dir, m, lock);
  const hashed = files.map((f) => ({ ...f, bytes: f.bytes ?? fs.readFileSync(f.abs!) }));
  const hash = filesHash(hashed.map((f) => ({ rel: f.rel, sha: sha(f.bytes) })));
  const bytes = hashed.reduce((s, f) => s + f.bytes.byteLength, 0);
  const versions = readVersions(dir, m.package!, '', new Set());
  const prev = versions.at(-1)?.info;
  if (prev && prev.hash === hash) { r.blocks.push(`nothing changed since ${prev.version}`); return r; }
  const outputs = Object.fromEntries(outs.named.map((x) => [x.name!, outputInfo(x)]));
  const def = outputInfo(outs.default!);
  let version = '1.0';
  if (prev) {
    const c = compareInterfaces(prev, { outputs, default: def });
    r.bigBecause = [...c.big, ...(o.big ? ['the author marked it big (--big)'] : [])];
    r.changes = c.small;
    const [b, s] = versionParts(prev.version);
    version = r.bigBecause.length ? `${b + 1}.0` : `${b}.${s + 1}`;
    r.previous = prev.version;
  }
  if (bytes > MAX_VERSION_BYTES) r.warnings.push(`the version holds ${(bytes / 2 ** 20).toFixed(0)} MB (above ${MAX_VERSION_BYTES / 2 ** 20} MB): every project that uses it keeps a copy`);
  const sources = new Map<string, GraphSpec>([...[...graphs].map(([k, g]) => [`graphs/${k}.json`, g] as [string, GraphSpec])]);
  try { for (const f of fs.readdirSync(path.join(dir, 'assets')).filter((f) => f.endsWith('.json'))) sources.set(`assets/${f}`, JSON.parse(fs.readFileSync(path.join(dir, 'assets', f), 'utf8'))); } catch { /* no assets */ }
  r.warnings.push(...unheldFiles(sources));

  // write it: through a .part folder renamed into place, never over a version that is there
  const at = path.join(dir, 'versions', version);
  if (fs.existsSync(at)) { r.blocks.push(`${at} is there already: a version is never written over`); return r; }
  const info: VersionInfo = { package: m.package!, version, note, published: new Date().toISOString(), big: !!o.big, hash, outputs, default: def, topotopo: TOPOTOPO_VERSION };
  const part = path.join(dir, 'versions', `.${version}.${process.pid}-${Date.now().toString(36)}.part`);
  try {
    for (const f of hashed) {
      const dest = path.join(part, ...f.rel.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, f.bytes);
    }
    fs.writeFileSync(path.join(part, 'version.json'), JSON.stringify(info, null, 2) + '\n');
    fs.renameSync(part, at);
  } catch (e) { fs.rmSync(part, { recursive: true, force: true }); throw e; }
  return { ...r, ok: true, version, dir: at, hash, files: hashed.length, bytes };
}

/** A publish result as the CLI and the library tool say it. */
export function publishText(r: PublishResult): string {
  if (!r.ok) return [`✗ not published — ${r.blocks.length} problem${r.blocks.length === 1 ? '' : 's'}:`, ...r.blocks.map((b) => `  ${b}`), ...(r.warnings.length ? ['warnings:', ...r.warnings.map((w) => `  ${w}`)] : [])].join('\n');
  const kind = !r.previous ? 'the first version' : r.bigBecause.length ? `big, after ${r.previous}` : `small, after ${r.previous}`;
  return [
    `✓ published ${r.package} ${r.version} (${kind}): "${r.note}"`,
    `  ${r.dir}: ${r.files} files, ${((r.bytes ?? 0) / 1024).toFixed(1)} KB, hash ${r.hash!.slice(0, 16)}…`,
    ...(r.bigBecause.length ? ['big because:', ...r.bigBecause.map((c) => `  ${c}`)] : []),
    ...(r.changes.length ? ['changes:', ...r.changes.map((c) => `  ${c}`)] : []),
    ...(r.warnings.length ? ['warnings:', ...r.warnings.map((w) => `  ${w}`)] : []),
  ].join('\n');
}

/** The project's packages as `topotopo packages` and the library tool list them. */
export function packagesText(pk: ProjectPackages): string {
  if (!pk.dir) return `this folder is in no project: ${MAKE_PROJECT}, whose graphs can use packages`;
  if (!pk.manifest) return `${manifestFile(pk.dir)}: ${pk.error}`;
  const m = pk.manifest, lines: string[] = [`${pk.label} (${pk.dir})${m.package ? `, package ${m.package}` : ''}`];
  const problems = [...new Set([...pk.verifyCopies(), ...pk.check()])];
  const entries = pk.lockEntries();
  lines.push(entries.length ? 'uses:' : 'uses: nothing yet (a graph that names "owner/name/output" adds the package, or topotopo use owner/name)');
  for (const e of entries) {
    const info = pk.copyInfo(e.package, e.version);
    lines.push(`  ${e.package} ${e.version}${e.direct ? '' : ' (used by another package)'}${e.entry ? `  from ${libraryText(e.entry.library)}` : '  (not in packages/lock.json)'}${info ? '' : '  COPY MISSING'}${info?.note ? `  "${info.note}"` : ''}`);
  }
  // the libraries it lists (one that cannot be read is said on the libraries line), and TopoTopo's built-in library
  let libs: { entry: string; root: string }[] | null = null, why = '';
  try { libs = pk.libraries(); } catch (e: any) { why = e.message; }
  if (Object.keys(m.uses).length && libs) {
    const outdated = pk.outdated(), late = outdated.filter((o) => o.small || o.big);
    problems.push(...outdated.flatMap((o) => (o.error ? [`${o.package}: ${o.error}`] : [])));
    lines.push(late.length
      ? `out of date: ${late.map((o) => `${o.package} ${o.version} (${[o.small ? `small update ${o.small}` : '', o.big ? `big update ${o.big}` : ''].filter(Boolean).join(', ')})`).join(', ')}; outdated lists the notes of the newer versions, update owner/name shows the before/after`
      : outdated.some((o) => o.error) ? 'out of date: none of the packages its libraries have (the others are under problems)' : 'out of date: nothing, every package it uses is the newest in its libraries');
  }
  const followed = pk.following();
  if (followed.length) lines.push('following this session:', ...followed.map((f) => `  ${f.package}  ${f.dir} (library "${f.library}")`));
  const builtin = `TopoTopo's built-in library "${BUILTIN_LIBRARY.name}" (${pk.builtin}), which every project looks in`;
  if (!libs) lines.push(`libraries: ${why}`);
  else {
    lines.push(libs.length
      ? `libraries: ${libs.map((l) => `${l.entry} (${l.root})`).join(', ')}, and ${builtin}`
      : `libraries: none listed (add "libraries" to project.json: a path relative to the project, or a registered library's name); ${builtin}`);
    let cat: ReturnType<ProjectPackages['catalog']> = [];
    try { cat = pk.catalog(); } catch (e: any) { lines.push(`  ${e.message}`); }
    lines.push(cat.length ? 'packages in them:' : 'packages in them: none yet (a project becomes a package with "package": "owner/name" in its project.json and topotopo publish)');
    for (const c of cat) {
      const v = c.versions.at(-1);
      const outs = v ? [...Object.keys(v.outputs), ...(Object.values(v.outputs).some((x) => x.graph === v.default.graph && x.node === v.default.node) ? [] : ['(default)'])] : [];
      const used = m.uses[c.package];
      lines.push(`  ${c.package}  ${v ? `${v.version} "${v.note}"` : 'no version published yet'}  [${libraryText(c.library)}]${used ? `  (this project uses ${used})` : ''}`);
      if (v) lines.push(`    outputs: ${outs.join(', ') || '(default)'}; default: "${v.default.node}" of graph "${v.default.graph}"`);
    }
  }
  if (problems.length) lines.push('problems:', ...problems.map((p) => `  ${p}`));
  return lines.join('\n');
}
