// Packages on disk (the engine side is src/graph/packages.ts): the copies of the package versions a project uses and
// their lock, the libraries a project finds packages in, adding a package on first use, following a package's working
// folder for one session, publishing a version (with the kind, tags and description of each output, and a dry run),
// the newer versions of what a project uses and updating to one (the before/after is src/packages/update.ts), and
// searching the outputs of every library.
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
// the SHA-256 of the file's content ("<sha256>  <path>" lines, hashed again). A text file's content is read with LF line
// ends, so a checkout that turns them into CRLF (core.autocrlf on Windows) keeps every hash; binary files are hashed as
// they are (textContent). A copy is checked against it together with
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
import { KINDS, isKind, outputFieldIssues } from '../graph/outputs.ts';
import type { Kind } from '../graph/outputs.ts';
import { ownOutputsNamed, packageAt, packageOutputDef, packagesNamedIn, varsRead } from '../graph/packages.ts';
import { didYouMean, resolveParamName } from '../graph/params.ts';
import { getNodeDef } from '../graph/registry.ts';
import { ID_RE, parsePackageName } from '../graph/scope.ts';
import type { PackageIssue, PackageResolver, Scope } from '../graph/scope.ts';
import type { GraphSpec, NodeDef } from '../graph/types.ts';
import { TOPOTOPO_VERSION } from '../host/version.ts';
import { kindMismatch, outputKind, publishedKind } from '../io/kinds.ts';
import { readMaterials } from '../core/materials.ts';
import type { Geometry } from '../core/geometry.ts';
import { imageRef, referenceableImages } from '../core/image.ts';
import { graphFiles, registerAssets } from '../session.ts';
import type { Session, SessionPackages } from '../session.ts';
import { BUILTIN_LIBRARY, loadConfig } from '../config.ts';
import { VERSION_RE, WORKSPACE_FILE, WORKSPACE_PACKAGES, copiesFor, isPackageName, locate, parseUses, librariesFor, libraryEntry, manifestFile, program, projectDirOf, readManifest, readUses, renameInto, withProjectLock, withStoreLock, writeAtomic, writeManifest, writeUses } from '../project.ts';
import { scanLibrary } from '../gallery/library.ts';
import { readWorkspace } from '../workspace.ts';
import type { GalleryConfig } from '../config.ts';
import type { CopyStore, Libraries, LibraryAt, ProjectManifest } from '../project.ts';

/** Publishing warns about a version above this size: every project that uses it keeps a copy. */
export const MAX_VERSION_BYTES = 50 * 2 ** 20;
/** The owner of TopoTopo's own packages: nobody else publishes under it. */
export const RESERVED_OWNER = 'topotopo';
/** How a folder becomes a project, said where only a project will do. */
const makeProject = () => `${program()} init <folder> (MCP: library {action:"init"} for the server's folder, when the person says so) makes the folder a project (project.json)`;
/** A library as messages name it: library "game", and TopoTopo's built-in library by its name and what it is. */
export const libraryText = (name: string) => `library "${name}"${name === BUILTIN_LIBRARY.name ? ' (TopoTopo\'s built-in library)' : ''}`;

export interface LockEntry { hash: string; library: string; uses: Record<string, string> }
/** packages/lock.json: every copied version, by package and version. */
export interface Lock { packages: Record<string, Record<string, LockEntry>> }

export interface SliderInfo { type: string; default?: unknown; min?: number; max?: number; options?: (string | number)[]; label?: string; desc?: string }
export interface InputInfo { index: number; label: string }
/**
 * A published output: the graph and node it cooks, what it is (its kind as it cooked, its tags, its description: the
 * output's own or else its graph's, none when neither has one), its params (the graph's vars) and its inputs (its input
 * nodes).
 */
export interface OutputInfo {
  graph: string; node: string; label?: string; kind: Kind; tags: string[]; description?: string;
  sliders: Record<string, SliderInfo>; inputs: InputInfo[];
  /** a material output: per material, the size of each map it carries (slot → [width, height]) */
  maps?: Record<string, Record<string, [number, number]>>;
}

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
  /**
   * every published output, and the default output (the output node of the graph project.json shows; its tags and
   * description are those of the named output it is, if any)
   */
  outputs: Record<string, OutputInfo>;
  default: OutputInfo;
  /** the TopoTopo version that published it */
  topotopo: string;
}

/** Is `o` the version's default output (the graph project.json shows, at its output node)? */
export const isDefaultOutput = (v: Pick<VersionInfo, 'default'>, o: { graph: string; node: string }) => o.graph === v.default.graph && o.node === v.default.node;
/** The named output that is the default one too, or null when the default output is one of its own. */
export const defaultOutputName = (v: Pick<VersionInfo, 'outputs' | 'default'>): string | null =>
  Object.entries(v.outputs).find(([, o]) => isDefaultOutput(v, o))?.[0] ?? null;

// ------------------------------------------------------------------------------------------------------- versions

const versionParts = (v: string) => v.split('.').map(Number);
export const compareVersions = (a: string, b: string) => { const [x, y] = versionParts(a), [u, w] = versionParts(b); return x - u || y - w; };
/** A version that starts a big version: 2.0, 3.0, 10.0 (1.0 is the first one, 1.10 a small one). */
export const startsBigVersion = (v: string) => { const [big, small] = versionParts(v); return small === 0 && big > 1; };
const newestOf = (vs: Iterable<string>) => [...vs].sort(compareVersions).at(-1);

/** A package name "owner/name" (no output). */

function readVersionInfo(dir: string): VersionInfo {
  const file = path.join(dir, 'version.json');
  let raw: any;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e: any) { throw new Error(`${file}: ${e.message}`); }
  if (!raw || typeof raw !== 'object' || typeof raw.package !== 'string' || typeof raw.version !== 'string' || typeof raw.hash !== 'string' || !raw.outputs || typeof raw.outputs !== 'object' || !raw.default)
    throw new Error(`${file} is not a version record: it needs package, version, hash, outputs and default`);
  // every output records what it is: its kind and its tags
  for (const [k, o] of [...Object.entries<any>(raw.outputs), ['(the default output)', raw.default] as [string, any]])
    if (!o || typeof o !== 'object' || !isKind(o.kind) || !Array.isArray(o.tags) || !o.sliders || !Array.isArray(o.inputs))
      throw new Error(`${file} is not a version record: output ${k} needs its kind (${KINDS.join(', ')}), tags, sliders and inputs`);
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

/**
 * What is said about a copy that is missing, and about one edited by hand (a loaded copy warns, publishing blocks).
 * `direct`: the package the project uses that needs it (itself, or the one that uses it), whose `use` copies it again.
 */
const missingCopy = (pkg: string, v: string, at: string, direct?: string) =>
  `the copy of ${pkg} ${v} is missing: ${at}${direct ? `; restore it, or run ${program()} use ${direct}, which copies what is missing` : ''}`;
const editedCopy = (pkg: string, v: string, at: string, direct?: string) =>
  `the copy of ${pkg} ${v} (${at}) was edited by hand: its files no longer match the hash packages/lock.json records; restore it, or delete it and run ${program()} use ${direct ?? pkg}, which copies what is missing`;

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

/** Files that are never text, whatever their bytes: images, meshes, fonts, archives. */
const BINARY = /\.(png|jpe?g|webp|gif|avif|bmp|tga|tiff?|exr|hdr|dds|ktx2?|glb|bin|bgeo|sc|usdc|usdz|fbx|abc|vdb|r16|r32|raw|wasm|ttf|otf|woff2?|zip|gz|7z|pdf|mp4|webm|wav|ogg|mp3)$/i;

/**
 * A file's content as a version's hash reads it: a text file with its CRLF line ends read as LF, so that a checkout that
 * turns LF into CRLF (core.autocrlf) keeps the hash; anything else as it is. Text is what version control takes for
 * text: no NUL byte in the first 8000 bytes, and no binary format by its name.
 */
export function textContent(name: string, bytes: Uint8Array): Uint8Array {
  if (BINARY.test(name)) return bytes;
  const head = Math.min(bytes.length, 8000);
  for (let i = 0; i < head; i++) if (bytes[i] === 0) return bytes;
  let crlf = 0;
  for (let i = 0; i + 1 < bytes.length; i++) if (bytes[i] === 13 && bytes[i + 1] === 10) crlf++;
  if (!crlf) return bytes;
  const out = new Uint8Array(bytes.length - crlf);
  let j = 0;
  for (let i = 0; i < bytes.length; i++) if (!(bytes[i] === 13 && bytes[i + 1] === 10)) out[j++] = bytes[i];
  return out;
}

/** The SHA-256 a version's hash takes of a file: of its text with LF line ends, or of its bytes (textContent). */
export const contentSha = (name: string, bytes: Uint8Array) => sha(textContent(name, bytes));

/**
 * SHA-256 of files kept while their size and time stay the same: copies and followed folders are read again often. A
 * project keeps those of its own files between runs in packages/.cache.json (never committed: init lists it in its
 * .gitignore), so a new process does not read every byte of its copies again.
 */
const shaCache = new Map<string, { stamp: string; sha: string }>();
let shaFresh = false;
function fileSha(abs: string, cached: boolean): string {
  if (!cached) return contentSha(abs, fs.readFileSync(abs));
  const st = fs.statSync(abs), stamp = `${st.size}:${st.mtimeMs}`;
  const c = shaCache.get(abs);
  if (c?.stamp === stamp) return c.sha;
  const h = contentSha(abs, fs.readFileSync(abs));
  shaCache.set(abs, { stamp, sha: h });
  shaFresh = true;
  return h;
}

/**
 * The file that keeps the hashes of a store's files between runs (.cache.json beside its copies; its paths are from
 * the store's folder, the project's or the workspace's), and the shape it is written in.
 */
const shaCacheFile = (store: CopyStore) => path.join(store.packages, '.cache.json');
const SHA_CACHE_FORMAT = 1;
const shaCacheRead = new Set<string>();

/** Take in the hashes a store kept (.cache.json), once per process. */
function readShaCache(store: CopyStore) {
  const dir = store.root;
  if (shaCacheRead.has(dir)) return;
  shaCacheRead.add(dir);
  let raw: any;
  try { raw = JSON.parse(fs.readFileSync(shaCacheFile(store), 'utf8')); } catch { return; }
  if (raw?.format !== SHA_CACHE_FORMAT || !raw.files || typeof raw.files !== 'object') return;
  for (const [rel, s] of Object.entries(raw.files)) {
    const [stamp, h] = String(s).split(' ');
    const abs = path.join(dir, ...rel.split('/'));
    if (stamp && h && !shaCache.has(abs)) shaCache.set(abs, { stamp, sha: h });
  }
}

/** Keep the hashes of the store's files that are still there (.cache.json), when new ones were taken. */
function writeShaCache(store: CopyStore) {
  const dir = store.root;
  if (!shaFresh || !fs.existsSync(store.packages)) return;
  shaFresh = false;
  const files: Record<string, string> = {};
  for (const [abs, c] of shaCache) {
    const rel = path.relative(dir, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !fs.existsSync(abs)) continue;
    files[rel.split(path.sep).join('/')] = `${c.stamp} ${c.sha}`;
  }
  try { writeAtomic(shaCacheFile(store), JSON.stringify({ format: SHA_CACHE_FORMAT, files: sortKeys(files) }) + '\n'); } catch { /* a cache: kept next time */ }
}

/** The hash of a set of files: their sorted posix paths, each with the SHA-256 of its content (contentSha). */
export function filesHash(files: { rel: string; sha: string }[]): string {
  return sha([...files].sort(byRel).map((f) => `${f.sha}  ${f.rel}\n`).join(''));
}

/**
 * The hash a version published from the project folder `dir` now would have, which tells whether a working folder
 * differs from its versions (its files are re-read only when they change).
 */
export function workingHash(dir: string): string {
  const m = readManifest(dir), lock = readLock(dir);
  return filesHash(versionFiles(dir, m, lock).map((f) => ({ rel: f.rel, sha: f.bytes ? contentSha(f.rel, f.bytes) : fileSha(f.abs!, true) })));
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
    renameInto(part, to);
  } catch (e) { fs.rmSync(part, { recursive: true, force: true }); throw e; }
}

// ----------------------------------------------------------------------------------------------------------- lock

export const lockFile = (dir: string) => path.join(dir, 'packages', 'lock.json');

/** A folder's packages/lock.json (empty when there is none); throws naming the file when it is not valid. */
export function readLock(dir: string): Lock {
  return readLockAt(path.join(dir, 'packages'));
}

/** The lock.json of a folder of copies (packages/, a workspace's topotopo-packages/). */
export function readLockAt(packages: string): Lock {
  const file = path.join(packages, 'lock.json');
  if (!fs.existsSync(file)) return { packages: {} };
  let raw: any;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e: any) { throw new Error(`${file}: ${e.message}`); }
  const shape = `${file} must be {"packages": {"owner/name": {"1.3": {"hash", "library", "uses"}}}}`;
  if (!raw || typeof raw !== 'object' || !raw.packages || typeof raw.packages !== 'object' || Array.isArray(raw.packages)) throw new Error(shape);
  const out: Lock = { packages: {} };
  for (const [pkg, vs] of Object.entries<any>(raw.packages)) {
    if (!isPackageName(pkg) || !vs || typeof vs !== 'object' || Array.isArray(vs)) throw new Error(shape);
    for (const [v, e] of Object.entries<any>(vs)) {
      if (!VERSION_RE.test(v) || !e || typeof e.hash !== 'string' || typeof e.library !== 'string') throw new Error(shape);
      (out.packages[pkg] ??= {})[v] = { hash: e.hash, library: e.library, uses: parseUses(e.uses, `${file} ${pkg} ${v}`) };
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

function writeLockAt(packages: string, lock: Lock) {
  fs.mkdirSync(packages, { recursive: true });
  writeAtomic(path.join(packages, 'lock.json'), lockText(lock));
}

/** Every version `uses` needs through the lock (its uses, theirs …), sorted; throws for one the lock does not list. */
function usesClosure(uses: Record<string, string>, lock: Lock): [string, string][] {
  const out = new Map<string, [string, string]>();
  // `top`: the package of `uses` that needs it, whose `use` copies and records what is missing
  const visit = (pkg: string, v: string, by: string, top: string) => {
    const key = `${pkg}@${v}`;
    if (out.has(key)) return;
    const e = lock.packages[pkg]?.[v];
    if (!e) throw new Error(`packages/lock.json does not list ${pkg} ${v} (${by} uses it): ${program()} use ${top} copies it and records it`);
    out.set(key, [pkg, v]);
    for (const [p, w] of Object.entries(e.uses)) visit(p, w, `${pkg} ${v}`, top);
  };
  for (const [pkg, v] of Object.entries(uses)) visit(pkg, v, 'project.json', pkg);
  return [...out.values()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : compareVersions(a[1], b[1])));
}

// -------------------------------------------------------------------------------------------- what a package holds

/** A project's graphs by name (graphs/ and the graph files beside project.json); unreadable ones are problems. */
function readGraphs(dir: string, problems: string[]): Map<string, GraphSpec> {
  const out = new Map<string, GraphSpec>();
  for (const [name, file] of graphFiles(dir)) {
    try { out.set(name, JSON.parse(fs.readFileSync(file, 'utf8'))); }
    catch (e: any) { problems.push(`${path.relative(dir, file).split(path.sep).join('/')}: ${e.message}`); }
  }
  return out;
}

/**
 * A published output of a package folder: the graph and node it cooks, its label, the kind its author pinned, its tags
 * and its description (its own, else its graph's).
 */
interface FolderOutput { name: string | null; graph: string; spec: GraphSpec; node: string; label?: string; kind?: Kind; tags: string[]; description?: string }

/** A graph's description, trimmed ('' without one). */
const describedAs = (g: GraphSpec) => (typeof g.description === 'string' ? g.description.trim() : '');

/**
 * What a package folder publishes: every named output of every graph in graphs/ but those marked "publish": false, and
 * the default output, the output node of the graph project.json shows (with the tags and description of the named
 * output it is, if any). Names that are not ids, clashes, a malformed kind, tag or description and a missing default
 * are problems (publishing blocks on them); a clashing name is left out.
 */
function folderOutputs(m: ProjectManifest, graphs: Map<string, GraphSpec>): { named: FolderOutput[]; default: FolderOutput | null; problems: string[] } {
  const problems: string[] = [];
  const byName = new Map<string, FolderOutput[]>();
  for (const [graph, spec] of graphs) {
    for (const [id, out] of Object.entries(spec.outputs ?? {})) {
      if (!out || typeof out !== 'object' || out.publish === false) continue;
      if (!ID_RE.test(id)) { problems.push(`output "${id}" (graph "${graph}") is not a package output name: lower-case letters, digits, - and _, starting with a letter or digit`); continue; }
      if (typeof out.node !== 'string' || !Object.hasOwn(spec.nodes, out.node)) { problems.push(`output "${id}" (graph "${graph}") names no node of its graph`); continue; }
      const issues = outputFieldIssues(out);
      if (issues.length) { for (const i of issues) problems.push(`output "${id}" (graph "${graph}"): ${i.message} (${i.hint})`); continue; }
      const description = (typeof out.description === 'string' ? out.description.trim() : '') || describedAs(spec);
      const list = byName.get(id) ?? [];
      list.push({
        name: id, graph, spec, node: out.node, ...(typeof out.label === 'string' ? { label: out.label } : {}),
        ...(out.kind ? { kind: out.kind } : {}), tags: out.tags ?? [], ...(description ? { description } : {}),
      });
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
  else {
    const same = named.find((x) => x.graph === m.graph && x.node === shown.output), description = same ? same.description : describedAs(shown);
    def = { name: null, graph: m.graph, spec: shown, node: shown.output, ...(same?.kind ? { kind: same.kind } : {}), tags: same?.tags ?? [], ...(description ? { description } : {}) };
  }
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

/**
 * An output's record: what it is (the kind it cooked to, its tags and description) and its interface, its params (the
 * vars of its graph that its node reads, with their declarations: varsRead) and its inputs (its input nodes).
 */
function outputInfo(o: FolderOutput, kind: Kind, maps?: OutputInfo['maps']): OutputInfo {
  const sliders: Record<string, SliderInfo> = {};
  const read = new Set(varsRead(o.spec, o.node));
  for (const [k, p] of Object.entries(graphInterface(o.spec).params)) {
    if (!read.has(k)) continue;
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
  return {
    graph: o.graph, node: o.node, ...(o.label ? { label: o.label } : {}), kind, tags: o.tags, ...(o.description ? { description: o.description } : {}),
    sliders, inputs: inputs.sort((a, b) => a.index - b.index), ...(maps && Object.keys(maps).length ? { maps } : {}),
  };
}

/** The maps of a material output: per material, each map slot's image size. */
function materialMaps(g: Geometry): OutputInfo['maps'] {
  const table = readMaterials(g), images = referenceableImages(g), out: NonNullable<OutputInfo['maps']> = {};
  for (const [name, m] of Object.entries(table)) {
    const slots: Record<string, [number, number]> = {};
    for (const [slot, ref] of Object.entries(m.textures ?? {})) {
      const im = ref ? images.get(imageRef(ref) ?? '') : undefined;
      if (im) slots[slot] = [im.width, im.height];
    }
    out[name] = slots;
  }
  return out;
}

/** A workspace's name for messages (its folder's when its file cannot be read). */
const workspaceName = (ws: string) => { try { return readWorkspace(ws).name; } catch { return path.basename(ws); } };

/** A workspace's copies are never imported by Godot (a .gdignore in their folder), should the game's root be its project. */
function gdignore(packages: string) {
  const f = path.join(packages, '.gdignore');
  if (!fs.existsSync(f)) try { fs.writeFileSync(f, ''); } catch { /* Godot imports them: harmless */ }
}

/**
 * Move the copies of the projects inside a workspace that keep their own (their project.json "uses", their packages/)
 * into the workspace's one shared copy, as topotopo workspace init does: each package at one version for the whole
 * game (two projects that used different versions get the newer, said), the lock entries merged, the projects' uses
 * and copies removed. A project that is a package keeps its own (its uses are published with it). A project whose
 * copies differ from the workspace's for the same version (edited by hand) is left as it is, said. Returns what it did,
 * a line each.
 */
export function gatherCopies(ws: string): string[] {
  const store = copiesFor(ws);
  if (store.workspace !== path.resolve(ws)) return [];
  const projects = scanLibrary({ name: 'workspace', path: ws }).projects
    .filter((p) => copiesFor(p.dir).workspace === store.workspace && Object.keys(p.manifest.uses).length);
  if (!projects.length) return [];
  return withStoreLock(store, () => {
    const out: string[] = [];
    const uses = readUses(store), lock = readLockAt(store.packages);
    let before: [string, string][] = [];
    try { before = usesClosure(uses, lock); } catch { /* the lock misses a version: nothing is deleted */ }
    for (const p of projects) {
      const own = readLock(p.dir), ownUses = readManifest(p.dir).uses, from = path.join(p.dir, 'packages');
      // a version the project's lock does not list may be one the workspace holds already
      const both: Lock = { packages: {} };
      for (const l of [lock, own]) for (const [pkg, vs] of Object.entries(l.packages)) Object.assign(both.packages[pkg] ??= {}, vs);
      let closure: [string, string][];
      try { closure = usesClosure(ownUses, both); } catch (e: any) { out.push(`left ${p.rel} as it is: ${e.message}`); continue; }
      const clash = closure.find(([pkg, v]) => lock.packages[pkg]?.[v] && own.packages[pkg]?.[v] && lock.packages[pkg][v].hash !== own.packages[pkg][v].hash);
      if (clash) { out.push(`left ${p.rel} as it is: its copy of ${clash[0]} ${clash[1]} differs from the workspace's (edited by hand?)`); continue; }
      const missing = closure.find(([pkg, v]) => ![from, store.packages].some((d) => fs.existsSync(path.join(copyAt(d, pkg, v), 'version.json'))));
      if (missing) { out.push(`left ${p.rel} as it is: its copy of ${missing[0]} ${missing[1]} is missing (${program()} use ${missing[0]} in it copies it again)`); continue; }
      for (const [pkg, v] of closure) {
        const to = copyAt(store.packages, pkg, v);
        if (!fs.existsSync(path.join(to, 'version.json'))) {
          fs.rmSync(to, { recursive: true, force: true });
          copyTree(copyAt(from, pkg, v), to);
        }
        (lock.packages[pkg] ??= {})[v] = both.packages[pkg][v];
      }
      const moved: string[] = [];
      for (const [pkg, v] of Object.entries(ownUses)) {
        const was = uses[pkg];
        if (was === undefined || compareVersions(v, was) > 0) {
          if (was !== undefined) out.push(`${pkg}: ${p.rel} used ${v}, another project ${was}; the workspace uses ${v} now (${program()} update shows the before/after of a version)`);
          uses[pkg] = v;
        } else if (was !== v) out.push(`${pkg}: ${p.rel} used ${v}, another project ${was}; the workspace uses ${was}`);
        moved.push(`${pkg} ${v}`);
      }
      writeManifest(p.dir, { ...readManifest(p.dir), uses: {} });
      fs.rmSync(from, { recursive: true, force: true });
      out.push(`moved the copies of ${p.rel} into the workspace's: ${moved.join(', ')}`);
    }
    writeLockAt(store.packages, lock);
    gdignore(store.packages);
    writeUses(store, uses);
    // the copies an older version needed that the game uses no more
    let keep: Set<string>;
    try { keep = new Set(usesClosure(uses, lock).map(([pkg, v]) => `${pkg}@${v}`)); } catch { return out; }
    const all = Object.entries(lock.packages).flatMap(([pkg, vs]) => Object.keys(vs).map((v) => [pkg, v] as [string, string]));
    const gone: string[] = [];
    for (const [pkg, v] of [...before, ...all]) {
      if (keep.has(`${pkg}@${v}`) || !lock.packages[pkg]?.[v]) continue;
      delete lock.packages[pkg][v];
      if (!Object.keys(lock.packages[pkg]).length) delete lock.packages[pkg];
      const at = copyAt(store.packages, pkg, v);
      fs.rmSync(at, { recursive: true, force: true });
      for (let d = path.dirname(at); d.length > store.packages.length; d = path.dirname(d)) { try { fs.rmdirSync(d); } catch { break; } }
      gone.push(`${pkg} ${v}`);
    }
    if (gone.length) { writeLockAt(store.packages, lock); out.push(`deleted the copies no project uses any more: ${gone.join(', ')}`); }
    return out;
  });
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
export interface Loaded {
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
  /** what loading it found: its copy edited by hand, files it cannot read, loops (each said with the version) */
  problems: string[];
  /** its graphs and assets that cannot be read or registered, said by file ("assets/bark.json: …") */
  fileProblems: string[];
  /** a copy that loaded with a warning (edited by hand, not in the lock): loaded afresh when the project is checked again */
  warned: boolean;
  /** the versions it uses, as its scope resolves them */
  deps: () => (Loaded | PackageIssue)[];
}

/** A package's working folder, followed this session. */
interface Followed { package: string; dir: string; library: string; stamp: string; by: 'name' | 'policy' }

/** Which used packages to follow by their working folder, besides those followed by name (a workspace's opt-in). */
export type FollowPolicy = (working: { package: string; dir: string; library: string }) => boolean;

/** A published version found in one of the project's libraries. */
interface Place { library: string; dir: string; info: VersionInfo }

/** A package in the project's libraries: the libraries that hold it, its working folders and its versions. */
interface Found { package: string; libraries: string[]; working: { library: string; dir: string }[]; versions: Map<string, Place[]> }

/** A package's folder in a library: its versions/, and `working` when it is the package's working folder (a project). */
interface PackageFolder { package: string; library: string; dir: string; working: boolean }

/**
 * The project's libraries and the packages in them, scanned once for several finds: TopoTopo's built-in library first,
 * then the libraries project.json lists; and what is wrong with an entry or a library (the others still count).
 */
interface Scanned { libs: LibraryAt[]; packages: PackageFolder[]; problems: string[] }

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

/** An update asked for when there is none to make (the version in use is the newest of its big number): not a failure. */
export class NothingToUpdate extends Error {
  constructor(message: string) { super(message); this.name = 'NothingToUpdate'; }
}

/**
 * The packages of one project in one engine: the resolver of the engine's root scope (the project's uses), a scope per
 * copied version (its own assets, graphs, files and uses), adding packages on first use, the session's followed
 * working folders. openPackages attaches one to an engine.
 */
export class ProjectPackages implements SessionPackages {
  readonly engine: Engine;
  /** the project folder; null when the folder belongs to no project */
  readonly dir: string | null;
  /** where the project's copies, their lock and its uses are (copiesFor): its own, or its workspace's shared copy */
  readonly store: CopyStore | null;
  /** the folder of TopoTopo's built-in library, which every project looks in */
  readonly builtin: string;
  manifest: ProjectManifest | null = null;
  /** why project.json or the lock could not be read */
  error: string | null = null;
  /**
   * what the last look at TopoTopo's built-in library found wrong with its packages (the catalog's offer of them):
   * replaced by each look
   */
  libraryProblems: string[] = [];
  /** what the engine's root scope resolves package names with */
  readonly resolver: PackageResolver;
  private root: Context;
  private loaded = new Map<string, Loaded | PackageIssue>();
  /** versions read apart from the copies (Context.library), by folder */
  private apart = new Map<string, Loaded | PackageIssue>();
  private loading = new Set<string>();
  private followed = new Map<string, Followed>();
  private policy: FollowPolicy | null = null;
  private followLoaded = new Map<string, Loaded | PackageIssue>();
  /** the hash of every followed folder: what their outputs' results are keyed by */
  private joint = '';
  /** the project's own package, its graphs as they are now ("" until its graphs name one of its outputs) */
  private selfStamp = '';
  private selfLoaded: Loaded | PackageIssue | null = null;
  /** the same, its uses resolving to the published copies whatever this session follows (publishing) */
  private selfPublished: Loaded | PackageIssue | null = null;
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
    this.store = this.dir === null ? null : copiesFor(this.dir);
    this.builtin = path.resolve(opts.builtin ?? BUILTIN_LIBRARY.path);
    this.root = { label: 'this project', uses: {}, packages: this.store ? this.store.packages : '', lock: { packages: {} }, follows: true };
    this.resolver = { resolve: (name) => this.resolveIn(this.root, name), names: () => this.namesIn(this.root), offered: () => this.offered() };
    if (this.store) readShaCache(this.store);
    this.reload();
  }

  /** "project lantern (D:/lib/props/lantern)" */
  get label(): string { return this.manifest ? `project ${this.manifest.id}` : 'this folder'; }

  /** Who holds the uses and copies, for messages: the project, or its workspace (one copy for every project in it). */
  get holder(): string {
    return this.store?.workspace ? `workspace "${workspaceName(this.store.workspace)}"` : this.label;
  }

  /** The file whose "uses" name the versions in use, for messages: "project.json", or the workspace's file. */
  get usesFileName(): string { return this.store?.workspace ? WORKSPACE_FILE : 'project.json'; }

  /** The versions the project uses (its own, or its workspace's), as last read. */
  uses(): Record<string, string> { return this.root.uses; }

  /**
   * What exports and publishing resolve package names with: the published copies, whatever this session follows
   * (following a working folder is for looking: the viewer, renders). The project's own resolver while nothing is
   * followed.
   */
  publishedResolver(): PackageResolver {
    if (!this.followed.size) return this.resolver;
    return { resolve: (name) => this.resolveIn({ ...this.root, follows: false }, name), names: () => this.namesIn({ ...this.root, follows: false }) };
  }

  private publishedAt: Scope | null = null;
  /**
   * SessionPackages.published: while this session follows working folders, the scope exports cook in, like the root
   * (its assets, graphs and folder) but resolving packages to their published copies; null while nothing is followed
   * (exports cook in the root, as everything else).
   */
  published(): Scope | null {
    if (!this.followed.size) return null;
    const root = this.engine.root;
    this.publishedAt ??= this.engine.createScope(`published copies ${sha(this.dir ?? '').slice(0, 12)}`, {
      folder: root.files.resolvePath('.'), assets: root.assets, graphs: (n) => root.graphs?.(n), packages: this.publishedResolver(),
    });
    return this.publishedAt;
  }

  /**
   * What an export of `graph` made while following says (null when the graph names no followed package): the
   * published versions it used, the working folders being for looking only.
   */
  publishedNote(graph: GraphSpec): string | null {
    const named = new Set(packagesNamedIn(graph));
    const live = [...this.followed.values()].filter((f) => named.has(f.package));
    if (!live.length) return null;
    const used = live.map((f) => (this.root.uses[f.package] ? `${f.package} ${this.root.uses[f.package]}` : `${f.package} (no published version in use: publish one, and use it)`));
    return `this session shows ${live.map((f) => f.package).join(', ')} live from ${live.length === 1 ? 'its working folder' : 'their working folders'}, for looking; the export used the published ${used.join(', ')}`;
  }

  /** SessionPackages: why the graphs cannot use packages (a folder in no project, a project.json that is not valid). */
  notice(): string | null {
    if (!this.dir) return `this folder is in no project, so its graphs cannot use packages yet, TopoTopo's own among them: ${makeProject()}`;
    return this.error ? `the project's packages cannot be read: ${this.error}` : null;
  }

  /** Load afresh, when next named, the copies that could not load or loaded with a warning (edited by hand). */
  private forgetWarned() {
    for (const [k, v] of this.loaded) if ('error' in v || v.warned) this.loaded.delete(k);
  }

  /** Read project.json and the lock again (the tools wrote them, or another process did). */
  private reload() {
    this.disk = this.diskStamp();
    // a version that loaded stays as it is (it is frozen); one that could not load, or loaded with a warning, is tried again
    this.forgetWarned();
    // the project's own package is read again with its uses and lock (its files are hashed again when next named)
    this.selfLoaded = null; this.selfPublished = null;
    this.selfStamp = '';
    if (!this.dir) return;
    try {
      this.manifest = readManifest(this.dir);
      const pkg = this.manifest.package, store = this.store!;
      if (store.workspace && Object.keys(this.manifest.uses).length)
        throw new Error(`${manifestFile(this.dir)} lists "uses" (${Object.entries(this.manifest.uses).map(([k, v]) => `${k} ${v}`).join(', ')}), but the project is in the workspace ${store.workspace}, whose ${WORKSPACE_FILE} names the versions every project in it uses, with one copy of each: ${program()} workspace init ${store.workspace} moves them there`);
      // the project that is a package: its graphs name their own outputs, which cook from its graphs as they are now
      this.root = { ...this.root, uses: readUses(store), lock: readLockAt(store.packages), self: pkg ? { package: pkg, get: () => this.loadSelf(pkg) } : undefined };
      this.error = null;
    } catch (e: any) { this.error = e.message; this.root = { ...this.root, uses: {}, lock: { packages: {} }, self: undefined }; }
    if (this.policy) this.applyPolicy();
  }

  private diskStamp(): string {
    if (!this.dir) return '';
    const st = (f: string) => { const s = fs.statSync(f, { throwIfNoEntry: false }); return s ? `${s.size}:${s.mtimeMs}` : '-'; };
    return `${st(manifestFile(this.dir))}|${st(this.store!.usesFile)}|${st(path.join(this.store!.packages, 'lock.json'))}`;
  }

  /**
   * PackageOutput.rootPath: a file as the root names it. Relative to the root's folder (where its relative paths read:
   * the project's, or the folder of a graph file in it) when it lies in the folder of the project's copies (the
   * project's, or its workspace's), as copies do, so exports name no folder of this machine; absolute when it lies
   * elsewhere (a followed working folder in another library).
   */
  private rootPath = (abs: string): string => {
    const inStore = this.store ? path.relative(this.store.root, abs) : '..';
    if (!inStore || inStore.startsWith('..') || path.isAbsolute(inStore)) return abs;
    return path.relative(this.engine.root.files.resolvePath('.'), abs).split(path.sep).join('/');
  };

  /** A path for messages: relative to the project when inside it, else to the workspace that holds its copies. */
  private shown(p: string): string {
    for (const base of [this.dir, this.store?.workspace]) {
      if (!base) continue;
      const r = path.relative(base, p);
      if (r && !r.startsWith('..') && !path.isAbsolute(r)) return r.split(path.sep).join('/');
    }
    return p;
  }

  /** The project folder and its manifest; throws when the folder is in no project or project.json is not valid. */
  project(): { dir: string; manifest: ProjectManifest } {
    if (!this.dir) throw new Error(`this folder is in no project: ${makeProject()}, whose graphs can use packages`);
    if (!this.manifest) throw new Error(this.error ?? `${manifestFile(this.dir)} cannot be read`);
    return { dir: this.dir, manifest: this.manifest };
  }

  /**
   * The project's own package (when it is one) as its graphs are now, loaded as a project that uses it would: its own
   * scope with its graphs, assets, files and copies, a node type per published output. null for a project that names
   * no package.
   */
  ownPackage(published = false): Loaded | PackageIssue | null {
    if (!this.root.self) return null;
    return published && this.followed.size ? this.loadSelf(this.root.self.package, false) : this.root.self.get();
  }

  /** The package of the project's uses that needs version `v` of `pkg`: the package itself, or one that uses it. */
  private directUser(pkg: string, v: string): string | undefined {
    if (this.root.uses[pkg] === v) return pkg;
    for (const [top, w] of Object.entries(this.root.uses)) {
      try { if (usesClosure({ [top]: w }, this.root.lock).some(([p, x]) => p === pkg && x === v)) return top; } catch { /* the lock misses a version */ }
    }
    return undefined;
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
    if (!this.dir) return { error: `package ${pkg}: this graph is in no project, and only projects use packages`, hint: `${makeProject()}; then a graph of it that names ${pkg} adds the package (or ${program()} use ${pkg})` };
    if (this.error) return { error: `package ${pkg}: ${this.error}` };
    const why = (ctx.unavailable ?? this.unavailable).get(pkg);
    return {
      error: `package ${pkg} is not in this project's uses (project.json)${why ? `, and it could not be added: ${why}` : ''}`,
      hint: why
        ? 'a graph that names it adds it once that is solved'
        : `${program()} use ${pkg} (MCP: library {action:"use", package:"${pkg}"}) adds its newest version from the libraries the project lists; build and edit add it when a graph first names it`,
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
    // the package the project uses that needs it, whose `use` copies and records it again
    const direct = ctx.packages === this.root.packages ? this.directUser(pkg, v) : undefined;
    if (!fs.existsSync(path.join(dir, 'version.json')))
      return { error: missingCopy(pkg, v, this.shown(dir)), hint: `${ctx.label} uses it, and the copies are kept with the ${ctx.packages === this.root.packages && this.store?.workspace ? 'workspace' : 'project'} (commit ${this.shown(ctx.packages)}/): restore it, or run ${program()} use ${direct ?? pkg}, which copies what is missing` };
    const info = readVersionInfo(dir);
    const m = readManifest(dir);
    const hash = copyHash(dir, ctx.packages);
    const expected = ctx.lock.packages[pkg]?.[v]?.hash;
    let warning: string | undefined;
    if (expected === undefined) warning = `${this.shown(ctx.packages)}/lock.json does not list ${pkg} ${v}: ${program()} use ${direct ?? pkg} records it`;
    else if (expected !== hash) warning = editedCopy(pkg, v, this.shown(dir), direct);
    const vctx: Context = { label: `${pkg} ${v}`, uses: m.uses, packages: ctx.packages, lock: ctx.lock, follows: false };
    // the scope is the files' too: a copy restored after an edit is another scope, with results of its own
    return this.build({ pkg, version: v, dir, hash, signature: hash, info, warning, manifest: m, ctx: vctx, scope: `${pkg}@${v}${warning ? `#${hash.slice(0, 16)}` : ''}` });
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
          r = this.build({ pkg, version: v, dir, hash, signature: `${hash}|${dir}`, info, manifest: m, ctx: vctx, scope: `${pkg}@${v}|${dir}` });
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
  private loadSelf(pkg: string, follows = true): Loaded | PackageIssue {
    if (!follows) return this.selfPublished ??= this.buildSelf(pkg, false);
    if (this.selfLoaded) return this.selfLoaded;
    return this.selfLoaded = this.buildSelf(pkg, true);
  }

  /** the project's own package from its graphs as they are now, its uses following this session's folders or not */
  private buildSelf(pkg: string, follows: boolean): Loaded | PackageIssue {
    const key = `${pkg} (this project${follows ? '' : ', published copies'})`;
    if (this.loading.has(key)) return { error: `${key} uses itself (through ${[...this.loading].join(' → ')})` };
    this.loading.add(key);
    let r: Loaded | PackageIssue;
    try {
      this.selfStamp ||= workingHash(this.dir!);
      // its outputs may use the packages this session follows: their results are keyed by those folders too
      const signature = sha(`${this.selfStamp}|${follows ? this.joint : ''}`);
      const ctx: Context = { label: key, uses: this.root.uses, packages: this.root.packages, lock: this.root.lock, follows };
      r = this.build({ pkg, version: null, dir: this.dir!, hash: this.selfStamp, signature, manifest: this.manifest!, ctx, scope: `${pkg}@project-${follows ? '' : 'published-'}${signature.slice(0, 16)}` });
    } catch (e: any) { r = { error: `${key} (${this.dir}): ${e.message}` }; }
    finally { this.loading.delete(key); }
    return r;
  }

  /**
   * A version's (or working folder's) scope with its graphs, assets and uses, and a node type per output: what each is
   * as the version's record (`info`) says, or in a working folder as its author pinned and tagged it. Its graphs and
   * assets name its own outputs by full name: they resolve to what this builds (Context.self).
   */
  private build(o: { pkg: string; version: string | null; dir: string; hash: string; signature: string; info?: VersionInfo; warning?: string; manifest: ProjectManifest; ctx: Context; scope: string }): Loaded {
    const problems: string[] = [];
    const graphs = readGraphs(o.dir, problems);
    const scope = this.engine.createScope(o.scope, { folder: o.dir, graphs: (n) => graphs.get(n), packages: this.resolverOf(o.ctx) });
    const outs = folderOutputs(o.manifest, graphs);
    const def = (x: FolderOutput) => {
      const rec = o.info && (x.name === null ? o.info.default : o.info.outputs[x.name]);
      const kind = rec ? rec.kind : x.kind, tags = rec ? rec.tags : x.tags;
      return packageOutputDef({
        package: o.pkg, version: o.version, hash: o.hash, signature: o.signature, output: x.name, graph: x.graph, spec: x.spec, node: x.node, scope,
        rootPath: this.rootPath,
        ...(o.info?.note ? { note: o.info.note } : {}), ...(x.label ? { label: x.label } : {}), ...(kind ? { kind } : {}), ...(tags?.length ? { tags } : {}),
        ...(o.warning ? { warning: o.warning } : {}),
      });
    };
    const loaded: Loaded = {
      package: o.pkg, version: o.version, dir: o.dir, hash: o.hash, scope,
      named: new Map(outs.named.map((x) => [x.name!, def(x)])),
      default: outs.default ? def(outs.default) : null,
      ...(outs.default ? {} : { noDefault: outs.problems.find((p) => p.startsWith('no default output'))?.replace(/^no default output: /, '') }),
      loops: new Map(), problems: [], fileProblems: problems, warned: !!o.warning,
      deps: () => Object.keys(o.ctx.uses).filter((p) => p !== o.pkg).map((p) => this.packageIn(o.ctx, p)),
    };
    // its outputs exist before its assets register: an asset may name one
    o.ctx.self = { package: o.pkg, get: () => loaded };
    registerAssets(this.engine, scope, o.dir, problems);
    loaded.loops = outputLoops(o.pkg, [...outs.named, ...(outs.default ? [outs.default] : [])], scope);
    const at = packageAt({ package: o.pkg, version: o.version });
    loaded.problems = [...(o.warning ? [o.warning] : []), ...[...problems, ...outs.problems.filter((p) => !p.startsWith('no default output')), ...new Set(loaded.loops.values())].map((p) => `${at}: ${p}`)];
    return loaded;
  }

  /**
   * What is wrong with the versions `start` reaches (each loaded as it is used, then those they use): copies edited by
   * hand, files they cannot read, versions that do not load. Each once.
   */
  private problemsOf(start: (Loaded | PackageIssue)[]): string[] {
    const out = new Set<string>(), seen = new Set<Loaded>();
    const visit = (p: Loaded | PackageIssue) => {
      if ('error' in p) { out.add(p.error); return; }
      if (seen.has(p)) return;
      seen.add(p);
      for (const x of p.problems) out.add(x);
      for (const d of p.deps()) visit(d);
    };
    for (const p of start) visit(p);
    return [...out];
  }

  /**
   * Check every version the project uses (and those they use) as the files are now: what is wrong with them, worked out
   * afresh each time (a copy restored by hand, a lock fixed since, shows no more). Also the project's own package and
   * the working folders this session follows. Each problem once.
   */
  check(): string[] {
    if (!this.dir || !this.manifest) return [];
    this.refresh();
    // a copy that loaded with a warning is hashed again: it may have been restored
    this.forgetWarned();
    const start: (Loaded | PackageIssue)[] = Object.keys(this.root.uses).filter((p) => !this.followed.has(p)).map((p) => this.packageIn(this.root, p));
    for (const p of this.followed.keys()) start.push(this.loadFollowed(p));
    if (this.root.self && this.selfStamp) start.push(this.root.self.get());
    const out = this.problemsOf(start);
    writeShaCache(this.store!);
    return out;
  }

  /** The copies the project's uses need, checked now: one the lock does not list, one missing, one edited by hand. */
  verifyCopies(): string[] {
    this.project();
    const store = this.store!, packages = store.packages;
    let lock: Lock, closure: [string, string][];
    try { lock = readLockAt(packages); closure = usesClosure(readUses(store), lock); } catch (e: any) { return [e.message]; }
    const out: string[] = [];
    for (const [pkg, v] of closure) {
      const at = copyAt(packages, pkg, v);
      if (!fs.existsSync(path.join(at, 'version.json'))) out.push(missingCopy(pkg, v, this.shown(at), this.directUser(pkg, v)));
      else if (copyHash(at, packages) !== lock.packages[pkg][v].hash) out.push(editedCopy(pkg, v, this.shown(at), this.directUser(pkg, v)));
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------------ first use

  /**
   * What keeps a graph from cooking with the project exactly as it is (a build machine's --locked): a package it names
   * that the project does not use, a copy missing or edited by hand. Writes nothing.
   */
  locked(graph: GraphSpec): string[] {
    const adds = this.dryRun(graph).adds.map((a) => `the graph names ${a.package}, which project.json does not use: ${program()} use ${a.package} adds it (a cook without --locked adds it)`);
    return [...adds, ...(this.dir && this.manifest ? this.verifyCopies() : [])];
  }

  /** The packages a graph names that the project does not use yet (nor follows, nor is). */
  private freshIn(graph: GraphSpec): string[] {
    if (!this.dir || !this.manifest || this.error) return [];
    return packagesNamedIn(graph).filter((pkg) => this.root.uses[pkg] === undefined && !this.followed.has(pkg) && pkg !== this.manifest!.package);
  }

  /**
   * SessionPackages: add the packages a graph names that the project does not use yet, once the graph is valid as a
   * dry run checks it (dryRun: those packages at the version first use adds, read where their library holds them). A
   * graph that does not validate adds nothing and writes nothing; why a package could not be added is said when the
   * graph names it.
   */
  addFor(graph: GraphSpec): string[] {
    const fresh = this.freshIn(graph);
    if (!fresh.length) return [];
    const d = this.dryRun(graph);
    for (const [pkg, why] of d.unavailable) this.unavailable.set(pkg, why);
    if (this.engine.validate(graph, '', { ...this.engine.root, id: d.id, packages: d.resolver }).errors.length) return [];
    const notes: string[] = [];
    for (const pkg of fresh) {
      try { notes.push(this.use(pkg).text); this.unavailable.delete(pkg); }
      catch (e: any) { this.unavailable.set(pkg, e.message); }
    }
    return notes;
  }

  /**
   * Add a package to the project: its newest version in the libraries the project lists (or `version`), copied in with
   * the versions it uses, recorded in project.json "uses" and in the lock. For a package the project uses already, the
   * copies of the version in use (and of those it uses) that went missing are copied again.
   */
  use(pkg: string, o: { version?: string } = {}): UseResult {
    const { dir } = this.project();
    const at = /^([^@\s]+)@(.*)$/.exec(pkg);
    if (at && isPackageName(at[1])) throw new Error(`"${pkg}" is not a package name: name the version apart, ${program()} use ${at[1]} --version ${at[2] || '<version>'} (MCP: library {action:"use", package:"${at[1]}", version:"${at[2]}"})`);
    if (!isPackageName(pkg)) throw new Error(`"${pkg}" is not a package name: write owner/name (lower-case letters, digits, - and _)`);
    if (o.version !== undefined && !VERSION_RE.test(o.version)) throw new Error(`"${o.version}" is not a version: write big.small, such as ${/^\d+$/.test(o.version) ? `${o.version}.0` : '1.1'}`);
    const store = this.store!;
    return withStoreLock(store, () => {
      const m = readManifest(dir), uses = readUses(store);
      if (pkg === m.package) throw new Error(`this project is the package ${pkg}: its graphs name its own outputs by full name, with no entry in "uses"`);
      const inUse = uses[pkg];
      if (inUse !== undefined && o.version !== undefined && o.version !== inUse)
        throw new Error(`${store.workspace ? `the ${this.holder} (every project in it)` : 'this project'} uses ${pkg} ${inUse}: ${program()} update ${pkg} --to ${o.version} shows the before/after of going to ${o.version}, and applies it when asked`);
      if (inUse !== undefined) {
        let complete = false;
        try { complete = usesClosure({ [pkg]: inUse }, readLockAt(store.packages)).every(([p, w]) => fs.existsSync(path.join(copyAt(store.packages, p, w), 'version.json'))); } catch { /* the lock lacks one: copy again */ }
        if (complete) return { version: inUse, copied: [], text: `${this.holder} already uses ${pkg} ${inUse}` };
      }
      const { version: v, place } = this.versionToAdd(pkg, inUse ?? o.version);
      const copied = this.copyIn(pkg, v, place);
      if (inUse === undefined) writeUses(store, { ...uses, [pkg]: v });
      this.reload();
      writeShaCache(store);
      const deps = copied.filter((c) => c !== `${pkg} ${v}`);
      return {
        version: v, copied,
        text: inUse === undefined
          ? `added ${pkg} ${v} to ${this.holder}${store.workspace ? ' (one copy for every project in it)' : ''} from ${libraryText(place.library)}${deps.length ? `, with ${deps.join(', ')}` : ''}: ${this.shown(copyAt(store.packages, pkg, v))}`
          : `copied what was missing of ${pkg} ${v} again from ${libraryText(place.library)}: ${copied.join(', ')}`,
      };
    });
  }

  /**
   * The version of a package the project adds (`v`, else the newest in the libraries it looks in, TopoTopo's built-in
   * library among them) and where a library holds it; throws saying why there is none.
   */
  private versionToAdd(pkg: string, v?: string, scanned?: Scanned): { version: string; place: Place } {
    const found = this.find(pkg, scanned);
    if (!found.versions.size) {
      const w = found.working[0];
      throw new Error(`${pkg} is in library "${w?.library ?? found.libraries[0]}"${w ? ` (${w.dir})` : ''} but has no published version yet: publish one in its folder (${program()} publish ${w ? `${w.dir} ` : ''}--note "...")`);
    }
    const version = v ?? newestOf(found.versions.keys())!;
    const place = found.versions.get(version)?.[0];
    if (!place) throw new Error(`no library this project lists has ${pkg} ${version}: they have ${[...found.versions.keys()].sort(compareVersions).join(', ')}`);
    return { version, place };
  }

  /**
   * SessionPackages.dryRun: the packages a graph is checked with where nothing may be written (a dry run, a trial of
   * a person's values). A package it names for the first time is the version its first use would add, the newest in
   * the libraries the project looks in (TopoTopo's built-in library among them), read where that library holds it:
   * nothing is copied, and project.json and the lock stay as they are. The notes say what build or edit add, and
   * `unavailable` why the others could not be added; `adds` the versions first use adds. Outside a project, and for a
   * graph that names nothing new, it is the project's own resolver. `id`: the id of a scope that resolves with it, the
   * root's own ("") for the project's resolver, else one for the uses it resolves by.
   */
  dryRun(graph: GraphSpec): { resolver: PackageResolver; notes: string[]; adds: { package: string; version: string }[]; unavailable: Map<string, string>; id: string } {
    const fresh = this.freshIn(graph);
    if (!fresh.length) return { resolver: this.resolver, notes: [], adds: [], unavailable: new Map(), id: this.engine.root.id };
    const uses = { ...this.root.uses }, library = new Map<string, Place>(), unavailable = new Map<string, string>(), notes: string[] = [];
    const adds: { package: string; version: string }[] = [];
    let scanned: Scanned | undefined;
    for (const pkg of fresh) {
      try {
        const { version, place } = this.versionToAdd(pkg, undefined, scanned ??= this.scanLibraries());
        uses[pkg] = version;
        library.set(`${pkg}@${version}`, place);
        adds.push({ package: pkg, version });
        notes.push(`build or edit adds ${pkg} ${version} to ${this.label} on first use, from ${libraryText(place.library)}: this dry run read it there and copied nothing`);
      } catch (e: any) { unavailable.set(pkg, e.message); }
    }
    const ctx: Context = { ...this.root, uses: sortKeys(uses), library, unavailable };
    const id = `dry run ${sha(JSON.stringify([ctx.uses, [...library.values()].map((p) => p.dir)])).slice(0, 16)}`;
    return { resolver: { ...this.resolverOf(ctx), offered: () => this.offered() }, notes, adds, unavailable, id };
  }

  /** Copy a version as published, and the versions it holds copies of, into the project; record them in the lock. */
  private copyIn(pkg: string, v: string, place: Place): string[] {
    const packages = this.store!.packages;
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
    const lock = readLockAt(packages);
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
    writeLockAt(packages, lock);
    if (this.store!.workspace) gdignore(packages);
    return copied;
  }

  /**
   * The libraries the project lists (project.json as it is now): a path relative to the project ("./lib", "../lib"), or
   * a registered library's name; and what is wrong with the entries that do not work (the others still do). TopoTopo's
   * built-in library, which every project looks in, is not one of them (listing it by its name changes nothing).
   */
  libraries(): Libraries {
    return librariesFor(this.project().dir);
  }

  /**
   * Set the libraries the project lists (project.json "libraries"), as the person asks: each a path relative to the
   * project or a registered library's name (libraryEntry). Under the project's lock; says what it lists now and what
   * is wrong with an entry.
   */
  setLibraries(entries: string[]): string {
    const { dir } = this.project();
    if (!Array.isArray(entries) || entries.some((e) => typeof e !== 'string' || !e.trim())) throw new Error('"libraries" is a list of paths relative to the project ("../lib") and registered library names');
    for (const e of entries) { const k = libraryEntry(e); if ('error' in k) throw new Error(`"libraries": ${k.error}`); }
    return withProjectLock(dir, () => {
      const m = readManifest(dir);
      m.libraries = [...new Set(entries.map((e) => e.trim().replace(/\\/g, '/')))];
      writeManifest(dir, m);
      this.reload();
      const { libs, problems } = this.libraries();
      return [
        `${this.label} lists ${m.libraries.length ? m.libraries.map((e) => `"${e}"`).join(', ') : 'no libraries'} in project.json "libraries"${libs.length ? `: ${libs.map((l) => `${l.entry} (${l.root})`).join(', ')}` : ''}; TopoTopo's built-in library is looked in as well`,
        ...problems.map((p) => `problem: ${p}`),
      ].join('\n');
    });
  }

  /** The packages of TopoTopo's built-in library: their versions, and in TopoTopo's repository their working folders. */
  private builtinPackages(problems: string[]): PackageFolder[] {
    const found = new Set<string>(), out = builtinPackages(this.builtin, found);
    problems.push(...found);
    return out;
  }

  /**
   * TopoTopo's built-in library and the project's libraries, and the packages in them (their folders); what is wrong
   * with an entry or a library is a problem, and the others still count.
   */
  private scanLibraries(): Scanned {
    const { libs, problems } = this.libraries();
    const builtin = this.builtinPackages(problems), seen = new Set(builtin.map((p) => path.resolve(p.dir).toLowerCase()));
    // a library listed that is the built-in library's folder holds nothing more
    const listed = libs.flatMap((lib) => {
      const scan = scanLibrary({ name: lib.name, path: lib.root });
      problems.push(...scan.problems.map((p) => `${libraryText(lib.name)}: ${p}`));
      return scan.projects.flatMap((p) => (p.manifest.package && !seen.has(path.resolve(p.dir).toLowerCase()) ? [{ package: p.manifest.package, library: lib.name, dir: p.dir, working: true }] : []));
    });
    return { libs, packages: [...builtin, ...listed], problems };
  }

  /** The libraries, working folders and versions of a package in the libraries the project looks in; throws saying where it is not. */
  private find(pkg: string, scanned: Scanned = this.scanLibraries()): Found {
    const { libs } = scanned;
    const found: Found = { package: pkg, libraries: [], working: [], versions: new Map() };
    const others = new Set(scanned.packages.map((p) => p.package));
    const unread = new Set<string>();
    for (const p of scanned.packages) {
      if (p.package !== pkg) continue;
      if (!found.libraries.includes(p.library)) found.libraries.push(p.library);
      if (p.working) found.working.push({ library: p.library, dir: p.dir });
      for (const place of readVersions(p.dir, pkg, p.library, unread)) {
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
    // in a registered library the project does not list? Then the line that lists it: its path from the project when
    // it is near (the same repository, most likely), else its name
    let cfg: GalleryConfig | null = null;
    try { cfg = loadConfig(); } catch { /* an unreadable config: only the listed libraries count */ }
    const listed = new Set(libs.map((l) => path.resolve(l.root).toLowerCase()));
    const scanProblems = scanned.problems.length ? `; and could not check ${scanned.problems.length}: ${scanned.problems.join('; ')}` : '';
    for (const lib of cfg?.libraries ?? []) {
      if (listed.has(path.resolve(lib.path).toLowerCase())) continue;
      if (scanLibrary(lib).projects.some((p) => p.manifest.package === pkg)) {
        const entry = entryFor(this.dir!, lib.path, lib.name);
        throw new Error(`${pkg} is in library "${lib.name}" (${lib.path}), which this project does not list: ${program()} libraries add ${entry} lists it ("libraries": [${[...(this.manifest?.libraries ?? []), entry].map((e) => JSON.stringify(e)).join(', ')}] in project.json; MCP: library {action:"set", libraries:[...]}, when the person says so)${scanProblems}`);
      }
    }
    const s = didYouMean(pkg, [...others]);
    throw new Error(libs.length
      ? `no library this project lists has a package ${pkg}${s.length ? ` (did you mean ${s.join(', ')}?)` : ''}; it looks in ${libs.map((l) => `"${l.entry}" (${l.root})`).join(', ')} and in TopoTopo's built-in library${scanProblems}`
      : `this project lists no libraries to find ${pkg} in${s.length ? ` (did you mean ${s.join(', ')}?)` : ''}, and TopoTopo's built-in library, which every project looks in, holds TopoTopo's own packages alone: ${program()} libraries add <folder or registered name> lists one (project.json "libraries")${scanProblems}`);
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
    this.followed.set(pkg, { package: pkg, dir: w.dir, library: w.library, stamp: '', by: 'name' });
    this.restamp();
    this.rewatch();
    const v = this.root.uses[pkg];
    return `following ${pkg} for this session: its working folder ${w.dir} (${libraryText(w.library)}) instead of ${v ? `the copy of ${v}` : 'a copy (the project does not use it yet)'}; its edits re-cook, for looking: exports and publishing use the published copy`;
  }

  /**
   * Follow, for this session, every package the project uses whose one working folder the policy accepts (a
   * workspace's "follow my own packages live": the working folders inside the workspace), besides those followed by
   * name; null stops it. Applied again whenever project.json changes (a package added, removed or updated). Returns
   * the packages it follows.
   */
  setFollowPolicy(policy: FollowPolicy | null): string[] {
    this.policy = policy;
    this.applyPolicy();
    return [...this.followed.values()].filter((f) => f.by === 'policy').map((f) => f.package);
  }

  private applyPolicy() {
    // the policy's packages worked out afresh (the policy or the uses may have changed); a folder kept keeps its stamp
    const before = new Map([...this.followed].filter(([, f]) => f.by === 'policy'));
    for (const pkg of before.keys()) this.followed.delete(pkg);
    let changed = false;
    if (this.policy && this.dir) {
      let scanned: Scanned | undefined;
      for (const pkg of Object.keys(this.root.uses)) {
        if (this.followed.has(pkg)) continue;
        let found: Found;
        try { found = this.find(pkg, scanned ??= this.scanLibraries()); } catch { continue; }
        const w = found.working.length === 1 ? found.working[0] : null;
        if (!w || !this.policy({ package: pkg, dir: w.dir, library: w.library })) continue;
        const had = before.get(pkg);
        this.followed.set(pkg, had?.dir === w.dir ? had : { package: pkg, dir: w.dir, library: w.library, stamp: '', by: 'policy' });
        if (had?.dir !== w.dir) changed = true;
      }
    }
    for (const pkg of before.keys()) if (!this.followed.has(pkg)) changed = true;
    if (changed) { this.restamp(); this.rewatch(); }
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
    if (changed) { this.followLoaded.clear(); this.selfLoaded = null; this.selfPublished = null; }
    return changed;
  }

  /** The project's own package, once its graphs named one of its outputs: true when its files changed since. */
  private restampSelf(): boolean {
    if (!this.selfStamp || !this.dir) return false;
    let s: string;
    try { s = workingHash(this.dir); } catch (e: any) { s = `unreadable: ${e.message}`; }
    if (s === this.selfStamp) return false;
    this.selfStamp = s;
    this.selfLoaded = null; this.selfPublished = null;
    return true;
  }

  /**
   * SessionPackages: read again what changed on disk: project.json and the lock, followed working folders, and the
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
   * SessionPackages: a stamp of what package names resolve to: project.json and the lock as they are on disk now,
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

  /**
   * What a change in a followed working folder sets off, without waiting for the file watcher (which a test, or a host
   * that knows a folder changed, calls): refresh, and `onChange` when anything changed. Says whether it did.
   */
  poke(): boolean {
    if (!this.refresh()) return false;
    this.onChange?.();
    return true;
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
          this.watchTimer = setTimeout(() => this.poke(), 150);
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
   * of TopoTopo's own the folder of its versions), and its versions with their records. What is wrong with a library,
   * an entry of "libraries" or a version goes into `problems`.
   */
  catalog(problems: string[] = []): (PackageFolder & { versions: VersionInfo[] })[] {
    const scanned = this.scanLibraries(), unread = new Set<string>();
    const out = scanned.packages
      .map((p) => ({ ...p, versions: readVersions(p.dir, p.package, p.library, unread).map((x) => x.info).sort((a, b) => compareVersions(a.version, b.version)) }))
      .sort((a, b) => (a.package < b.package ? -1 : a.package > b.package ? 1 : 0));
    problems.push(...scanned.problems, ...unread);
    return out;
  }

  /**
   * For each package the project uses: the version in use, the small and the big update, every version after it. What
   * is wrong with a library or an entry of "libraries" goes into `problems`; a package whose versions could not be
   * looked up says why (error).
   */
  outdated(problems: string[] = []): Outdated[] {
    this.project();
    const uses = readUses(this.store!);
    let scanned: Scanned | null = null, why = '';
    if (Object.keys(uses).length) try { scanned = this.scanLibraries(); problems.push(...scanned.problems); } catch (e: any) { why = e.message; }
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
    this.project();
    if (!isPackageName(pkg)) throw new Error(`"${pkg}" is not a package name: write owner/name`);
    this.refresh();
    const uses = readUses(this.store!), from = uses[pkg];
    if (from === undefined) {
      const users = Object.entries(readLockAt(this.store!.packages).packages).flatMap(([p, vs]) => Object.entries(vs).filter(([, e]) => e.uses[pkg]).map(([w, e]) => `${p} ${w} uses ${pkg} ${e.uses[pkg]}`));
      throw new Error(users.length
        ? `this project does not use ${pkg} itself (${users.join('; ')}): a version keeps what it uses, so updating the package that uses it can bring another`
        : `this project does not use ${pkg}: its uses are ${Object.keys(uses).join(', ') || 'none'}`);
    }
    if (to !== undefined && !VERSION_RE.test(to)) throw new Error(`"${to}" is not a version: write big.small, such as ${/^[1-9]\d*$/.test(to) ? `${to}.0` : '1.4'}`);
    const found = this.find(pkg);
    const all = [...found.versions.keys()].sort(compareVersions);
    const bigOf = (v: string) => versionParts(v)[0];
    let target = to;
    if (target === undefined) {
      target = all.filter((v) => bigOf(v) === bigOf(from) && compareVersions(v, from) > 0).at(-1);
      const big = all.filter((v) => bigOf(v) > bigOf(from)).at(-1);
      if (!target) throw new NothingToUpdate(big
        ? `${pkg} ${from} is the newest ${bigOf(from)}.x in the project's libraries, and ${big} is a big version, a step of its own: name it, ${program()} update ${pkg} --to ${big} (library {action:"update", package:"${pkg}", to:"${big}"})`
        : `${pkg} ${from} is the newest version in the project's libraries: there is nothing to update`);
    } else if (target === from) throw new NothingToUpdate(`this project uses ${pkg} ${from} already: there is nothing to update`);
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
   * is copied. `key` tells pairs apart, for the ids of scopes made with them; `problems` says what is wrong with the
   * version the update goes to and those it uses, as they load (worked out when asked, for this update only).
   */
  updateResolvers(t: UpdateTarget): { before: PackageResolver; after: PackageResolver; key: string; problems: () => string[] } {
    const uses = sortKeys({ ...this.root.uses, [t.package]: t.to });
    const before = this.followed.size ? this.resolverOf({ ...this.root, follows: false }) : this.resolver;
    const ctx: Context = {
      label: 'this project after the update', uses, packages: this.root.packages, lock: this.root.lock, follows: false, self: this.root.self,
      library: new Map([[`${t.package}@${t.to}`, { library: t.library, dir: t.dir, info: t.toInfo }]]),
    };
    return { before, after: this.resolverOf(ctx), key: sha(JSON.stringify([this.root.uses, uses, t.dir])).slice(0, 16), problems: () => this.problemsOf([this.packageIn(ctx, t.package)]) };
  }

  /**
   * Apply an update: copy the version in with the versions it uses, name it in "uses" and the lock, and delete the
   * copies nothing uses any more (those the project's uses needed before and need no more).
   */
  applyUpdate(t: UpdateTarget): UpdateResult {
    this.project();
    const store = this.store!;
    const { copied, deleted } = withStoreLock(store, () => {
      const uses = readUses(store);
      if (uses[t.package] !== t.from) throw new Error(`${this.usesFileName} uses ${t.package} ${uses[t.package] ?? 'no more'} now, not ${t.from}: look at the before/after again`);
      let before: [string, string][] = [];
      try { before = usesClosure(uses, readLockAt(store.packages)); } catch { /* the lock misses a version: nothing is deleted */ }
      const copied = this.copyIn(t.package, t.to, { library: t.library, dir: t.dir, info: t.toInfo });
      const now = sortKeys({ ...uses, [t.package]: t.to });
      writeUses(store, now);
      return { copied, deleted: this.dropUnused(before, now) };
    });
    this.reload();
    const folder = `${this.shown(store.packages)}/`;
    return {
      copied, deleted,
      text: [
        `updated ${t.package} ${t.from} → ${t.to} in ${this.holder}${store.workspace ? ', for every project in it' : ''}: ${this.usesFileName} uses ${t.package} ${t.to}, from ${libraryText(t.library)}`,
        `  copied into ${folder}: ${copied.length ? copied.join(', ') : `nothing (the ${store.workspace ? 'workspace' : 'project'} held it already)`}; ${folder}lock.json records them`,
        `  deleted the copies nothing uses any more: ${deleted.length ? deleted.join(', ') : 'none (every other copy is still used)'}`,
      ].join('\n'),
    };
  }

  /**
   * Delete the copies the uses needed `before` and the project's uses (`uses`, as project.json now holds them) need no
   * more, with their entries in the lock; the folders of a package and an owner go once they are empty. Says which.
   * When the lock misses a version, every copy stays.
   */
  private dropUnused(before: [string, string][], uses: Record<string, string>): string[] {
    const packages = this.store!.packages, lock = readLockAt(packages);
    let keep: Set<string>;
    try { keep = new Set(usesClosure(uses, lock).map(([p, v]) => `${p}@${v}`)); } catch { return []; }
    const deleted: string[] = [];
    for (const [p, v] of before) {
      if (keep.has(`${p}@${v}`)) continue;
      if (lock.packages[p]) { delete lock.packages[p][v]; if (!Object.keys(lock.packages[p]).length) delete lock.packages[p]; }
      const at = copyAt(packages, p, v);
      fs.rmSync(at, { recursive: true, force: true });
      for (let d = path.dirname(at); d.length > packages.length; d = path.dirname(d)) { try { fs.rmdirSync(d); } catch { break; } }
      this.loaded.delete(`${p}@${v}`);
      deleted.push(`${p} ${v}`);
    }
    writeLockAt(packages, lock);
    return deleted;
  }

  /**
   * Remove a package the project uses: drop it from "uses", and delete its copy and the copies it needed that nothing
   * else uses, with their entries in the lock. `places`: where the project's graphs still name it (file and node); while
   * one does, it is refused, listing them.
   */
  remove(pkg: string, places: string[]): { deleted: string[]; text: string } {
    this.project();
    if (!isPackageName(pkg)) throw new Error(`"${pkg}" is not a package name: write owner/name`);
    const store = this.store!, who = store.workspace ? `the ${this.holder}` : 'this project';
    const { v, deleted } = withStoreLock(store, () => {
      const uses = readUses(store), v = uses[pkg];
      if (v === undefined) {
        const users = Object.entries(readLockAt(store.packages).packages).flatMap(([p, vs]) => Object.entries(vs).filter(([, e]) => e.uses[pkg]).map(([w]) => `${p} ${w}`));
        throw new Error(users.length
          ? `${who} does not use ${pkg} itself: ${users.join(', ')} ${users.length === 1 ? 'uses' : 'use'} it, and keeps it until ${users.length === 1 ? 'that package goes' : 'those packages go'}`
          : `${who} does not use ${pkg}: its uses are ${Object.keys(uses).join(', ') || 'none'}`);
      }
      const where = store.workspace ? `the workspace's projects` : 'the project';
      if (places.length)
        throw new Error(`${places.length === 1 ? `a graph of ${where} still names` : `${places.length} places in the graphs of ${where} still name`} ${pkg}: ${places.join(', ')}; change or remove ${places.length === 1 ? 'that node' : 'those nodes'} first, then remove the package`);
      let before: [string, string][] = [];
      try { before = usesClosure(uses, readLockAt(store.packages)); } catch { /* the lock misses a version: only the package goes from the uses */ }
      delete uses[pkg];
      writeUses(store, uses);
      return { v, deleted: this.dropUnused(before, uses) };
    });
    this.reload();
    return {
      deleted,
      text: `removed ${pkg} ${v} from ${this.holder}: ${this.usesFileName} no longer uses it; deleted the copies nothing uses any more: ${deleted.length ? deleted.join(', ') : 'none'}`,
    };
  }

  /**
   * PackageResolver.offered: the outputs of TopoTopo's own packages the project does not use, at the newest version its
   * built-in library holds, read there (nothing is copied): the catalog and help list them, and a graph's first use adds
   * the package. Outside a project as well, where naming one is an error that says how to make the folder a project.
   */
  private offered(): NodeDef[] {
    const out: NodeDef[] = [], problems: string[] = [], unread = new Set<string>();
    for (const b of this.builtinPackages(problems)) {
      if (this.root.uses[b.package] !== undefined || this.followed.has(b.package) || b.package === this.root.self?.package) continue;
      const place = readVersions(b.dir, b.package, b.library, unread).at(-1);
      if (!place) continue;
      const p = this.readApart(place);
      if ('error' in p) { problems.push(p.error); continue; }
      problems.push(...p.problems);
      if (p.default && !p.loops.has('')) out.push(p.default);
      for (const [k, d] of p.named) if (!p.loops.has(k)) out.push(d);
    }
    this.libraryProblems = [...new Set([...problems, ...unread])];
    return out;
  }

  /** A published version where its library holds it, read there apart from the project's copies (nothing is copied). */
  private readApart(place: Place): Loaded | PackageIssue {
    const pkg = place.info.package, v = place.info.version;
    return this.packageIn({ label: `${pkg} ${v}`, uses: { [pkg]: v }, packages: '', lock: { packages: {} }, follows: false, library: new Map([[`${pkg}@${v}`, place]]) }, pkg);
  }

  /**
   * The node type of a package output the project does not use (yet), at the newest version in the libraries it looks in,
   * read where its library holds it, nothing copied: what help and the catalog say about an output search found. null
   * when no library it looks in has it (and for a package it uses: those resolve as they cook).
   */
  describe(name: string): NodeDef | null {
    const n = parsePackageName(name);
    if (typeof n === 'string' || !this.dir || !this.manifest || this.root.uses[n.package] !== undefined) return null;
    let found: Found;
    try { found = this.find(n.package); } catch { return null; }
    const newest = newestOf(found.versions.keys());
    const place = newest ? found.versions.get(newest)?.[0] : undefined;
    if (!place) return null;
    const p = this.readApart(place);
    if ('error' in p) return null;
    return (n.output === null ? p.default : p.named.get(n.output)) ?? null;
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
  // a workspace that follows its own packages ("follow": true): the used packages whose working folder is inside it
  const ws = pk.dir ? locate(pk.dir).workspace : null;
  let follow = false;
  if (ws) try { follow = readWorkspace(ws).follow; } catch { /* said by workspace and packages */ }
  if (ws && follow) {
    const inside = (d: string) => { const r = path.relative(ws, d); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };
    pk.setFollowPolicy((w) => inside(w.dir));
  }
  return pk;
}

/**
 * A project's assets and graphs in a scope (default: the engine's root) as a session has them, read without writing
 * anything (a session makes its folders): for a command that cooks the project's graphs and leaves the project as it
 * is, or for the viewer of a graph file, whose session folder is not the project. Says what could not be read.
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

/** The changes of two lists of tags: "tags added conifer, low-poly", "tag removed tree" (none: the same tags). */
const tagChanges = (a: string[], b: string[]) => {
  const added = b.filter((t) => !a.includes(t)), gone = a.filter((t) => !b.includes(t));
  return [added.length ? `tag${added.length > 1 ? 's' : ''} added ${added.join(', ')}` : '', gone.length ? `tag${gone.length > 1 ? 's' : ''} removed ${gone.join(', ')}` : ''].filter(Boolean);
};

/**
 * What changed between two versions' interfaces: what makes a big version (an output, param or input that goes away
 * or means something else: removed or renamed, another type, a narrower range, a removed option, an input moved, an
 * output of another kind), and the rest (added outputs, params, options and inputs, wider ranges, changed defaults,
 * labels, tags and descriptions).
 */
export function compareInterfaces(prev: Pick<VersionInfo, 'outputs' | 'default'>, next: Pick<VersionInfo, 'outputs' | 'default'>): { big: string[]; small: string[] } {
  const big: string[] = [], small: string[] = [];
  const range = (s: SliderInfo) => `${s.min ?? ''}..${s.max ?? ''}`;
  const output = (what: string, a: OutputInfo, b: OutputInfo) => {
    if (a.graph !== b.graph || a.node !== b.node) small.push(`${what} now cooks "${b.node}" of graph "${b.graph}" (was "${a.node}" of "${a.graph}")`);
    if (a.kind !== b.kind) big.push(`${what}: kind ${a.kind} → ${b.kind}`);
    for (const c of tagChanges(a.tags ?? [], b.tags ?? [])) small.push(`${what}: ${c}`);
    if ((a.description ?? '') !== (b.description ?? '')) small.push(`${what}: description ${!a.description ? 'added' : !b.description ? 'removed' : 'changed'}`);
    if ((a.label ?? '') !== (b.label ?? '')) small.push(`${what}: label "${a.label ?? ''}" → "${b.label ?? ''}"`);
    for (const [k, s] of Object.entries(a.sliders)) {
      const t = b.sliders[k];
      if (!t) { big.push(`${what}: param "${k}" removed`); continue; }
      if (t.type !== s.type) { big.push(`${what}: param "${k}" is now ${t.type} (was ${s.type})`); continue; }
      const narrower = (t.min !== undefined && (s.min === undefined || t.min > s.min)) || (t.max !== undefined && (s.max === undefined || t.max < s.max));
      const wider = (s.min !== undefined && (t.min === undefined || t.min < s.min)) || (s.max !== undefined && (t.max === undefined || t.max > s.max));
      if (narrower) big.push(`${what}: param "${k}" range ${range(s)} → ${range(t)} (narrower)`);
      else if (wider) small.push(`${what}: param "${k}" range ${range(s)} → ${range(t)} (wider)`);
      const gone = s.options && t.options ? s.options.filter((x) => !t.options!.includes(x)) : [];
      if (gone.length) big.push(`${what}: param "${k}" lost option${gone.length > 1 ? 's' : ''} ${gone.map((x) => JSON.stringify(x)).join(', ')}`);
      const added = t.options && s.options ? t.options.filter((x) => !s.options!.includes(x)) : [];
      if (added.length) small.push(`${what}: param "${k}" gained option${added.length > 1 ? 's' : ''} ${added.map((x) => JSON.stringify(x)).join(', ')}`);
      if (JSON.stringify(s.default) !== JSON.stringify(t.default)) small.push(`${what}: param "${k}" default ${JSON.stringify(s.default)} → ${JSON.stringify(t.default)}`);
      if ((s.label ?? '') !== (t.label ?? '') || (s.desc ?? '') !== (t.desc ?? '')) small.push(`${what}: param "${k}" label or description changed`);
    }
    for (const k of Object.keys(b.sliders)) if (!a.sliders[k]) small.push(`${what}: param "${k}" added`);
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
  /**
   * a dry run: every check, every output cooked, the number the version would get, its changes, blocks and warnings,
   * and nothing written (the note may still be missing: publishing needs it)
   */
  dryRun?: boolean;
}

export interface PublishResult {
  ok: boolean;
  /** a dry run (PublishOptions.dryRun): ok says it would publish, and nothing was written */
  dryRun: boolean;
  package: string;
  /** the version written, or that a dry run would write (none while something blocks) */
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
  /** the records of the outputs, as version.json holds them (each one's kind, tags and description) */
  outputs?: Record<string, OutputInfo>;
  default?: OutputInfo;
  dir?: string;
  hash?: string;
  files?: number;
  bytes?: number;
}

/** An output as publishing names it: output "pine" (graph "main"), or the default output ("out" of graph "main"). */
const outputWhat = (x: FolderOutput) => (x.name === null ? `the default output ("${x.node}" of graph "${x.graph}")` : `output "${x.name}" (graph "${x.graph}")`);

/**
 * Publish the project as the next version of its package, in steps, each of which stops publishing (and a dry run)
 * when it blocks, so that a problem is said once, at its cause, and a version number only for what would publish:
 *   1. what the project declares: its name, the note, its outputs (names, kinds, tags, descriptions, clashes, the
 *      default output), outputs that name each other in a loop, files it cannot read, its copies (none missing or
 *      edited by hand), a package the session follows, versions/ of another package name;
 *   2. every published output cooked as a project that uses the package cooks it, through the package's own scope
 *      (its graphs, assets, files and copies, as the version will hold them): an output that does not cook, cooks to
 *      nothing or to another kind than its author pinned blocks, and the kind it cooks to is recorded;
 *   3. its files: nothing changed since the previous version blocks;
 *   4. the number, by comparing with the previous version (and the author's `big`), its changes and the warnings: an
 *      output without tags or a description, one whose graph has vars it does not read (they are not its params), an
 *      output of another kind than before, files it reads that the version does not hold, the size;
 *   5. versions/<big>.<small>/ written through a .part folder, never over one that is there.
 * A dry run (o.dryRun) goes through every step and writes nothing.
 */
export async function publishPackage(pk: ProjectPackages, o: PublishOptions): Promise<PublishResult> {
  const { dir } = pk.project();
  // what its graphs name resolves as its files are now (its own outputs, the copies)
  pk.refresh();
  const m = readManifest(dir);
  // one line: a note says what changed
  const note = (o.note ?? '').replace(/\s+/g, ' ').trim();
  const dryRun = !!o.dryRun;
  const r: PublishResult = { ok: false, dryRun, package: m.package ?? '', note, bigBecause: [], changes: [], blocks: [], warnings: [] };
  const done = () => { r.blocks = [...new Set(r.blocks)]; r.warnings = [...new Set(r.warnings)]; return r; };

  // 1. what the project declares
  // TopoTopo's own packages: a folder of its built-in library, named as the package
  const inBuiltin = path.relative(pk.builtin, dir), kit = !!inBuiltin && !inBuiltin.startsWith('..') && !path.isAbsolute(inBuiltin) && !/[\\/]/.test(inBuiltin);
  if (!m.package) r.blocks.push(`project.json has no "package": the author names the package once, "package": "<owner>/${m.id}" (${program()} init --package <owner>/${m.id}; owner and name: lower-case letters, digits, - and _)`);
  else if (o.builtin) {
    if (!kit) r.blocks.push(`only a folder of TopoTopo's built-in library (${pk.builtin}) publishes one of TopoTopo's own packages, and ${dir} is none`);
    else if (m.package !== `${RESERVED_OWNER}/${inBuiltin}`) r.blocks.push(`the folder ${inBuiltin} of TopoTopo's built-in library holds the package ${RESERVED_OWNER}/${inBuiltin}, and its project.json names ${m.package}`);
  } else if (m.package.split('/')[0] === RESERVED_OWNER) r.blocks.push(`the owner "${RESERVED_OWNER}" is reserved for TopoTopo's own packages, which TopoTopo's repository publishes into its built-in library: publish under your own owner`);
  if (!note && !dryRun) r.blocks.push('a version needs a note, one line on what changed: --note "..." (library {action:"publish", note})');
  const live = pk.following();
  if (live.length) r.warnings.push(`this session shows ${live.map((f) => f.package).join(', ')} live from ${live.length === 1 ? 'its working folder' : 'their working folders'}: the version was checked with the published copies the project uses, which it holds`);
  // a package keeps its name: versions/ of another name are not this package's
  if (m.package) {
    const others = new Map<string, string[]>();
    let names: string[] = [];
    try { names = fs.readdirSync(path.join(dir, 'versions')).filter((v) => VERSION_RE.test(v)); } catch { /* none yet */ }
    for (const v of names) {
      try { const info = readVersionInfo(path.join(dir, 'versions', v)); if (info.package !== m.package) others.set(info.package, [...(others.get(info.package) ?? []), v]); } catch { /* said when its versions are read */ }
    }
    for (const [other, vs] of others)
      r.blocks.push(`versions/ holds the versions of ${other} (${vs.sort(compareVersions).join(', ')}), and project.json names the package ${m.package}: a package keeps its name; put "package": "${other}" back, or move versions/ away to publish ${m.package} from 1.0`);
  }
  let lock: Lock = { packages: {} };
  try { lock = readLock(dir); } catch (e: any) { r.blocks.push(e.message); }
  // a version holds its copies as published: none missing, none edited by hand
  r.blocks.push(...pk.verifyCopies());
  const unread: string[] = [];
  const graphs = readGraphs(dir, unread);
  const outs = folderOutputs(m, graphs);
  // the package as a project that uses it cooks it: its own scope, its graphs as they are now
  const self = m.package ? pk.ownPackage(true) : null;
  if (self && 'error' in self) r.blocks.push(self.error);
  r.blocks.push(...(self && !('error' in self) ? self.fileProblems : unread), ...outs.problems);
  if (self && !('error' in self)) r.blocks.push(...self.loops.values());
  if (r.blocks.length || !self || 'error' in self || !outs.default) return done();
  const all = [...outs.named, outs.default];

  // 2. every published output cooks, to something, and to the kind its author pinned; its kind is recorded. A default
  // output that is a named output is that output.
  const sameNamed = (x: FolderOutput) => (x.name === null ? outs.named.find((n) => n.graph === x.graph && n.node === x.node) : undefined);
  const kinds = new Map<FolderOutput, Kind>();
  const maps = new Map<FolderOutput, OutputInfo['maps']>();
  const published = pk.publishedResolver();
  const scope = pk.engine.root.packages === published ? pk.engine.root : { ...pk.engine.root, id: `publish ${m.package}${published === pk.resolver ? '' : ' published copies'}`, packages: published };
  // an output that builds on others of the package (a kit's line-up, a house of the kit's walls) cooks after them, and
  // a warning of theirs is said once, under the output it belongs to, not again under each output that builds on it
  const byName = new Map(all.map((x) => [x.name ?? '', x]));
  const uses = new Map(all.map((x) => [x, ownOutputsNamed(m.package!, x.spec, x.node, self.scope).map((n) => byName.get(n)).filter((y): y is FolderOutput => !!y && y !== x)]));
  const order: FolderOutput[] = [], placed = new Set<FolderOutput>();
  const place = (x: FolderOutput) => { if (placed.has(x)) return; placed.add(x); for (const y of uses.get(x)!) place(y); order.push(x); };
  for (const x of all) place(x);
  const core = (s: string) => s.replace(/^(\[[^\]]*\]\s*)+/, '');
  const said = new Map<FolderOutput, Set<string>>();
  const below = (x: FolderOutput, seen = new Set<FolderOutput>()): Set<string> => {
    const out = new Set<string>();
    for (const y of uses.get(x)!) { if (seen.has(y)) continue; seen.add(y); for (const k of said.get(y) ?? []) out.add(k); for (const k of below(y, seen)) out.add(k); }
    return out;
  };
  for (const x of order) {
    if (sameNamed(x)) continue;
    const what = outputWhat(x), type = x.name === null ? m.package! : `${m.package}/${x.name}`;
    const c = await pk.engine.cook({ nodes: { output: { type } }, output: 'output' }, { scope });
    const theirs = below(x), mine = new Set<string>();
    for (const w of c.warnings) {
      const k = core(w.message);
      if (theirs.has(k) || mine.has(k)) continue;
      mine.add(k);
      r.warnings.push(`${what}: ${w.message}`);
    }
    said.set(x, mine);
    if (!c.ok || !c.geo) { r.blocks.push(`${what} does not cook: ${c.errors.map((e) => e.message.replace(`${type} (${packageAt(self)}) failed: `, '')).join('; ') || 'no geometry'}`); continue; }
    const info = outputKind(c.geo), kind = publishedKind(info);
    if (!kind) { r.blocks.push(`${what} cooks to nothing (no polygons, curves, points, instances, heightfields, images, materials or volumes): there is nothing to publish`); continue; }
    kinds.set(x, kind);
    if (kind === 'material') maps.set(x, materialMaps(c.geo));
    if (x.kind && x.kind !== kind) r.blocks.push(`${what}: ${kindMismatch(x.kind, info)}`);
  }
  for (const x of all) { const same = sameNamed(x); if (same && kinds.has(same)) kinds.set(x, kinds.get(same)!); }
  if (r.blocks.length) return done();

  // 3. its files
  let hashed: { rel: string; bytes: Uint8Array }[] = [], hash = '';
  try {
    hashed = versionFiles(dir, m, lock).map((f) => ({ rel: f.rel, bytes: f.bytes ?? fs.readFileSync(f.abs!) }));
    hash = filesHash(hashed.map((f) => ({ rel: f.rel, sha: contentSha(f.rel, f.bytes) })));
  } catch (e: any) { r.blocks.push(e.message); return done(); }
  const bytes = hashed.reduce((s, f) => s + f.bytes.byteLength, 0);
  const prev = readVersions(dir, m.package!, '', new Set()).at(-1)?.info;
  if (prev && prev.hash === hash) { r.blocks.push(`nothing changed since ${prev.version}`); return done(); }

  // 4. the number, the changes and the warnings
  for (const x of all) {
    if (sameNamed(x)) continue;
    const what = outputWhat(x);
    if (!x.tags.length) r.warnings.push(x.name === null
      ? `${what} has no tags, which search finds an output by: tags go on a named output, so name it in its graph's "outputs" with "tags"`
      : `${what} has no tags, which search finds an output by: "tags": ["conifer", "low-poly"] in its graph's outputs`);
    if (!x.description) r.warnings.push(`${what} has no description: ${x.name === null ? 'describe its graph ("description")' : 'give it "description" in its graph\'s outputs, or describe its graph'}`);
    const read = new Set(varsRead(x.spec, x.node)), idle = Object.keys(x.spec.vars ?? {}).filter((k) => !read.has(k));
    if (idle.length) r.warnings.push(`${what} does not read ${idle.length === 1 ? 'the var' : 'the vars'} ${idle.map((k) => `"${k}"`).join(', ')} of its graph: ${idle.length === 1 ? 'it is not one of its params' : 'they are not its params'} (an output's params are the vars its node reads; move it to a graph of its own to give it params of its own)`);
  }
  const outputs = Object.fromEntries(outs.named.map((x) => [x.name!, outputInfo(x, kinds.get(x)!, maps.get(x) ?? maps.get(sameNamed(x)!))]));
  const def = outputInfo(outs.default, kinds.get(outs.default)!, maps.get(outs.default) ?? maps.get(sameNamed(outs.default)!));
  let version = '1.0';
  if (prev) {
    const c = compareInterfaces(prev, { outputs, default: def });
    r.bigBecause = [...c.big, ...(o.big ? ['the author marked it big (--big)'] : [])];
    r.changes = c.small;
    const [b, s] = versionParts(prev.version);
    version = r.bigBecause.length ? `${b + 1}.0` : `${b}.${s + 1}`;
    r.previous = prev.version;
    // a project may rely on what an output is: an Unreal static mesh is not a level
    const was = (k: string, now: OutputInfo, before: OutputInfo | undefined) => {
      if (before && before.kind !== now.kind) r.warnings.push(`${k} is now ${now.kind} (it was ${before.kind} in ${prev.version}): a project that relies on what it is may have to change, and the version is big`);
    };
    for (const x of outs.named) was(outputWhat(x), outputs[x.name!], prev.outputs[x.name!]);
    if (!sameNamed(outs.default) && defaultOutputName(prev) === null) was(outputWhat(outs.default), def, prev.default);
  }
  Object.assign(r, { version, outputs, default: def });
  if (bytes > MAX_VERSION_BYTES) r.warnings.push(`the version holds ${(bytes / 2 ** 20).toFixed(0)} MB (above ${MAX_VERSION_BYTES / 2 ** 20} MB): every project that uses it keeps a copy`);
  const sources = new Map<string, GraphSpec>([...[...graphs].map(([k, g]) => [`graphs/${k}.json`, g] as [string, GraphSpec])]);
  try { for (const f of fs.readdirSync(path.join(dir, 'assets')).filter((f) => f.endsWith('.json'))) sources.set(`assets/${f}`, JSON.parse(fs.readFileSync(path.join(dir, 'assets', f), 'utf8'))); } catch { /* no assets */ }
  r.warnings.push(...unheldFiles(sources));

  // 5. write it: through a .part folder renamed into place, never over a version that is there
  const at = path.join(dir, 'versions', version);
  if (fs.existsSync(at)) {
    r.blocks.push(`${at} is there already, and a version is never written over: move that folder away (it holds no version.json of ${m.package}), then publish again`);
    delete r.version;
    return done();
  }
  if (dryRun) return { ...done(), ok: true, hash, files: hashed.length, bytes };
  const info: VersionInfo = { package: m.package!, version, note, published: new Date().toISOString(), big: !!o.big, hash, outputs, default: def, topotopo: TOPOTOPO_VERSION };
  const part = path.join(dir, 'versions', `.${version}.${process.pid}-${Date.now().toString(36)}.part`);
  try {
    for (const f of hashed) {
      const dest = path.join(part, ...f.rel.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, f.bytes);
    }
    fs.writeFileSync(path.join(part, 'version.json'), JSON.stringify(info, null, 2) + '\n');
    renameInto(part, at);
  } catch (e) { fs.rmSync(part, { recursive: true, force: true }); throw e; }
  return { ...done(), ok: true, version, dir: at, hash, files: hashed.length, bytes };
}

/**
 * An output's kind and tags, as every listing says them: "mesh [conifer, low-poly]", "instances" without tags. A kind
 * not known (a working folder's output that pins none) is "kind not pinned".
 */
export const kindTagsText = (o: { kind?: Kind; tags?: string[]; maps?: OutputInfo['maps'] }) =>
  `${o.kind ?? 'kind not pinned'}${o.tags?.length ? ` [${o.tags.join(', ')}]` : ''}${o.maps ? `  ${mapsText(o.maps)}` : ''}`;

/** A material output's maps in a few words: "maps baseColor 2048, normal 4096" (with the material when it has several). */
export function mapsText(maps: NonNullable<OutputInfo['maps']>): string {
  const several = Object.keys(maps).length > 1;
  const parts = Object.entries(maps).flatMap(([m, slots]) => Object.entries(slots).map(([slot, [w, h]]) => `${several ? `${m} ` : ''}${slot} ${w === h ? w : `${w}×${h}`}`));
  return parts.length ? `maps ${parts.join(', ')}` : 'no maps';
}

/** The outputs of version `b` whose kind differs from version `a`'s: 'output "pine": mesh → scene'. */
export function kindChanges(a: Pick<VersionInfo, 'outputs' | 'default'>, b: Pick<VersionInfo, 'outputs' | 'default'>): string[] {
  const out: string[] = [];
  const one = (what: string, x: OutputInfo | undefined, y: OutputInfo | undefined) => { if (x && y && x.kind !== y.kind) out.push(`${what}: ${x.kind} → ${y.kind}`); };
  for (const [k, o] of Object.entries(b.outputs)) one(`output "${k}"`, a.outputs[k], o);
  const named = (v: Pick<VersionInfo, 'outputs' | 'default'>) => defaultOutputName(v) !== null;
  if (!named(a) && !named(b)) one('the default output', a.default, b.default);
  return out;
}

/** A publish result as the CLI and the library tool say it; a dry run says what publishing would do. */
export function publishText(r: PublishResult): string {
  const kind = !r.previous ? 'the first version' : r.bigBecause.length ? `big, after ${r.previous}` : `small, after ${r.previous}`;
  const said = [
    ...(r.outputs ? ['outputs:', ...Object.entries(r.outputs).map(([k, o]) => `  ${k}  ${kindTagsText(o)}${o.label ? `  "${o.label}"` : ''}`)] : []),
    ...(r.default && r.outputs && defaultOutputName({ outputs: r.outputs, default: r.default }) === null ? [`  (default: "${r.default.node}" of graph "${r.default.graph}")  ${kindTagsText(r.default)}`] : []),
    ...(r.bigBecause.length ? ['big because:', ...r.bigBecause.map((c) => `  ${c}`)] : []),
    ...(r.changes.length ? ['changes:', ...r.changes.map((c) => `  ${c}`)] : []),
    ...(r.warnings.length ? ['warnings:', ...r.warnings.map((w) => `  ${w}`)] : []),
  ];
  if (r.dryRun) {
    const number = r.version ? `${r.package} ${r.version} (${kind})` : r.package || 'the package';
    const noted = r.note ? `: "${r.note}"` : '; publishing it needs a note, one line on what changed (--note "...")';
    const problems = `${r.blocks.length} problem${r.blocks.length === 1 ? '' : 's'}`;
    return [
      r.ok ? `✓ would publish ${number}${noted}` : `✗ would not publish ${r.package || 'the package'} — ${problems}:`,
      ...(r.ok ? [] : r.blocks.map((b) => `  ${b}`)),
      ...(r.ok && r.hash ? [`  ${r.files} files, ${((r.bytes ?? 0) / 1024).toFixed(1)} KB, hash ${r.hash.slice(0, 16)}…`] : []),
      ...said,
      'a dry run: nothing was written',
    ].join('\n');
  }
  if (!r.ok) return [`✗ not published — ${r.blocks.length} problem${r.blocks.length === 1 ? '' : 's'}:`, ...r.blocks.map((b) => `  ${b}`), ...(r.warnings.length ? ['warnings:', ...r.warnings.map((w) => `  ${w}`)] : [])].join('\n');
  return [
    `✓ published ${r.package} ${r.version} (${kind}): "${r.note}"`,
    `  ${r.dir}: ${r.files} files, ${((r.bytes ?? 0) / 1024).toFixed(1)} KB, hash ${r.hash!.slice(0, 16)}…`,
    ...said,
  ].join('\n');
}

/** How many outputs a version publishes: its named outputs, and its default output when it is none of them. */
const outputCount = (v: Pick<VersionInfo, 'outputs' | 'default'>) => {
  const named = Object.values(v.outputs);
  const n = named.length + (defaultOutputName(v) !== null ? 0 : 1);
  return `${n} output${n === 1 ? '' : 's'}`;
};

/** How a package the project uses stands to its libraries: "up to date", "1.3 is out", "2.0 is out (big)". */
const standing = (o: Outdated) =>
  o.error ? 'could not check' : o.small || o.big ? [o.small ? `${o.small} is out` : '', o.big ? `${o.big} is out (big)` : ''].filter(Boolean).join(', ') : 'up to date';

/**
 * The project's packages as `topotopo packages` and the library tool list them, one line each: those it uses (version,
 * outputs, up to date or the newer version that is out), then the others in the libraries it looks in; the libraries;
 * what could not be checked. `packages owner/name` (packageText) shows one with its outputs.
 */
export function packagesText(pk: ProjectPackages, mcp = false): string {
  if (!pk.dir) return `this folder is in no project: ${makeProject()}, whose graphs can use packages`;
  if (!pk.manifest) return `${manifestFile(pk.dir)}: ${pk.error}`;
  const m = pk.manifest, uses = pk.uses(), lines: string[] = [`${pk.label} (${pk.dir})${m.package ? `, the package ${m.package}` : ''}`];
  if (pk.store?.workspace) lines.push(`in ${pk.holder} (${pk.store.workspace}): its ${WORKSPACE_FILE} names the versions every project in it uses, one copy of each (${WORKSPACE_PACKAGES}/)`);
  const problems: string[] = [...pk.verifyCopies(), ...pk.check()];
  const outdated = Object.keys(uses).length ? pk.outdated(problems) : [];
  for (const o of outdated) if (o.error) problems.push(`${o.package}: ${o.error}`);
  const late = outdated.filter((o) => o.small || o.big).length, unchecked = outdated.filter((o) => o.error).length;
  lines.push(outdated.length
    ? `uses ${outdated.length} package${outdated.length === 1 ? '' : 's'}: ${[late ? `${late} out of date` : '', outdated.length - late - unchecked ? `${outdated.length - late - unchecked} up to date` : '', unchecked ? `could not check ${unchecked}` : ''].filter(Boolean).join(', ')}`
    : `uses no packages yet: a graph that names "owner/name/output" adds the package (${mcp ? 'library {action:"use", package}' : `${program()} use owner/name`} adds one by hand)`);
  const width = Math.max(0, ...outdated.map((o) => `${o.package} ${o.version}`.length));
  for (const o of outdated) {
    const info = pk.copyInfo(o.package, o.version);
    lines.push(`  ${`${o.package} ${o.version}`.padEnd(width)}  ${info ? outputCount(info) : 'COPY MISSING'}  ${standing(o)}`);
  }
  const indirect = pk.lockEntries().filter((e) => !e.direct);
  if (indirect.length) lines.push(`  and, used by those: ${indirect.map((e) => `${e.package} ${e.version}`).join(', ')}`);
  // the others in its libraries
  let cat: ReturnType<ProjectPackages['catalog']> = [];
  try { cat = pk.catalog(problems); } catch (e: any) { problems.push(e.message); }
  const held = new Set(pk.lockEntries().map((e) => e.package));
  const others = cat.filter((c) => !held.has(c.package) && uses[c.package] === undefined && c.package !== m.package);
  if (others.length) {
    lines.push(`in its libraries, not used yet (${others.length}):`);
    const w2 = Math.max(0, ...others.map((c) => `${c.package} ${c.versions.at(-1)?.version ?? ''}`.length));
    for (const c of others) {
      const v = c.versions.at(-1);
      lines.push(`  ${`${c.package} ${v?.version ?? ''}`.padEnd(w2)}  ${v ? outputCount(v) : 'no version published yet'}  [${libraryText(c.library)}]`);
    }
  }
  const followed = pk.following();
  if (followed.length) lines.push('following this session:', ...followed.map((f) => `  ${f.package}  ${f.dir} (library "${f.library}")`));
  let libs: Libraries = { libs: [], problems: [] };
  try { libs = pk.libraries(); } catch (e: any) { problems.push(e.message); }
  lines.push(`libraries: ${libs.libs.length ? libs.libs.map((l) => `${l.entry} (${l.root}${l.name !== l.entry ? `, named "${l.name}"` : ''}${l.from === 'workspace' ? ', listed by the workspace' : ''})`).join(', ') : `none listed (${mcp ? 'library {action:"set", libraries:[...]}' : `${program()} libraries add <folder or registered name>`} lists one)`}; TopoTopo's built-in library is looked in as well`);
  const said = [...new Set(problems)];
  if (said.length) lines.push(`could not check ${said.length}:`, ...said.map((p) => `  ${p}`));
  lines.push(mcp ? 'library {action:"packages", package:"owner/name"} shows one with its outputs; {action:"outdated"} the notes of the newer versions' : `${program()} packages owner/name shows one with its outputs; ${program()} outdated the notes of the newer versions`);
  return lines.join('\n');
}

/**
 * One package of the project's libraries (`topotopo packages owner/name`): where it is, the version the project uses,
 * its versions with their notes, and the outputs of the version in use (else of the newest) with their kinds, tags,
 * params and inputs, by the node type a graph names them with.
 */
export function packageText(pk: ProjectPackages, pkg: string, mcp = false): string {
  const { manifest: m } = pk.project();
  const n = parsePackageName(pkg);
  if (typeof n === 'string' || n.output !== null) throw new Error(`"${pkg}" is not a package name: write owner/name`);
  const problems: string[] = [];
  const c = pk.catalog(problems).find((x) => x.package === pkg);
  const used = pk.uses()[pkg], inUse = used ? pk.copyInfo(pkg, used) : null;
  if (!c && !inUse) {
    const s = didYouMean(pkg, pk.catalog().map((x) => x.package));
    throw new Error(`no library this project looks in has a package ${pkg}${s.length ? ` — did you mean ${s.join(', ')}?` : ''}${problems.length ? `; could not check ${problems.length}: ${problems.join('; ')}` : ''}`);
  }
  const versions = c?.versions ?? [];
  const shown = inUse ?? versions.at(-1);
  const lines = [`${pkg}${c ? ` in ${libraryText(c.library)} (${c.dir})` : ''}${used ? `: ${pk.label} uses ${used}` : `: ${pk.label} does not use it yet (a graph that names one of its outputs adds it)`}`];
  if (versions.length) lines.push('versions:', ...versions.map((v) => `  ${v.version}  "${v.note}"${v.version === used ? '  (in use)' : ''}`));
  else if (!inUse) lines.push('no version published yet');
  if (shown) {
    lines.push(`outputs of ${shown.version}:`);
    const isDefault = (o: OutputInfo) => isDefaultOutput(shown, o);
    const one = (type: string, o: OutputInfo) => {
      const params = Object.keys(o.sliders), inputs = o.inputs.map((i) => i.label || `input ${i.index}`);
      return `  ${type}  ${kindTagsText(o)}${o.label ? `  "${o.label}"` : ''}${params.length ? `  params ${params.join(', ')}` : ''}${inputs.length ? `  inputs ${inputs.join(', ')}` : ''}${isDefault(o) ? `  (also ${pkg}, its default output)` : ''}`;
    };
    if (!Object.values(shown.outputs).some(isDefault)) lines.push(one(pkg, shown.default));
    for (const [k, o] of Object.entries(shown.outputs)) lines.push(one(`${pkg}/${k}`, o));
    const first = Object.keys(shown.outputs)[0], example = first ? `${pkg}/${first}` : pkg;
    lines.push(mcp ? `help {nodes:["${example}"]} gives an output's params and inputs` : `${program()} --help-node ${example} gives an output's params and inputs`);
  }
  if (problems.length) lines.push(`could not check ${problems.length}:`, ...problems.map((p) => `  ${p}`));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------------------- search

export interface SearchQuery {
  /** words, each of which must start a word of the output's full name, label, description or tags, or of its package's title or project tags */
  query?: string;
  /** only outputs of this kind */
  kind?: string;
  /** only outputs with this tag */
  tag?: string;
}

/** An output a search found, in the newest version of its package that a library holds. */
export interface SearchHit {
  /** the node type a graph names it with: "owner/name/output", or "owner/name" for a default output that is no named output */
  type: string;
  /** "owner/name": it is the package's default output as well */
  alias?: string;
  package: string;
  version: string;
  label?: string;
  kind: Kind;
  tags: string[];
  description?: string;
  /** the version of the package the open project uses, when it uses it */
  used?: string;
  /** the open project is the package: its graphs name its outputs */
  self?: boolean;
}

/** A library a search looked in, and how the open project stands to it. */
export interface SearchLibrary {
  /** as project.json lists it, a registered library's name, or "topotopo" for TopoTopo's built-in library */
  name: string;
  root: string;
  /** "builtin": every project can use it; "listed": the open project lists it; "unlisted": its project.json would have to list it */
  standing: 'builtin' | 'listed' | 'unlisted';
  /** an unlisted library: the entry the open project's "libraries" would list it by (its path from the project when near, else its name) */
  entry?: string;
  hits: SearchHit[];
}

export interface SearchResult {
  query: SearchQuery;
  /** the open project ("project forest"), null when the folder is in no project, which uses no package */
  project: string | null;
  /** the libraries looked in: those the project lists, TopoTopo's built-in library, then the other registered ones by name */
  libraries: SearchLibrary[];
  problems: string[];
}

/**
 * Search the outputs of the newest version of every package in TopoTopo's built-in library, the libraries the project
 * folder `dir` lists and every registered library (~/.topotopo/config.json), by words, kind and tag, and say for each
 * library whether the project can use what it holds: TopoTopo's built-in library and the libraries it lists, yes; any
 * other once its project.json lists it, which the person does (the tools never add a library). `dir`: the open
 * project's folder, null for a folder in no project. Throws for a kind that is none.
 */
export function searchPackages(dir: string | null, q: SearchQuery, opts: { builtin?: string } = {}): SearchResult {
  if (q.kind !== undefined && !isKind(q.kind)) throw new Error(`"${q.kind}" is not a kind: ${KINDS.join(', ')}`);
  const problems = new Set<string>();
  const builtin = path.resolve(opts.builtin ?? BUILTIN_LIBRARY.path);
  let manifest: ProjectManifest | null = null, uses: Record<string, string> = {};
  if (dir) { try { manifest = readManifest(dir); uses = readUses(copiesFor(dir)); } catch (e: any) { problems.add(e.message); } }
  // each folder once: what the project lists first, then TopoTopo's built-in library, then the other registered libraries
  const key = (p: string) => path.resolve(p).toLowerCase(), seen = new Set([key(builtin)]);
  const libs: Omit<SearchLibrary, 'hits'>[] = [];
  if (dir && manifest) {
    const listed = librariesFor(dir);
    for (const p of listed.problems) problems.add(p);
    for (const l of listed.libs) if (!seen.has(key(l.root))) { seen.add(key(l.root)); libs.push({ name: l.entry, root: l.root, standing: 'listed' }); }
  }
  libs.push({ name: BUILTIN_LIBRARY.name, root: builtin, standing: 'builtin' });
  try {
    for (const l of [...loadConfig().libraries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)))
      if (!seen.has(key(l.path))) { seen.add(key(l.path)); libs.push({ name: l.name, root: l.path, standing: 'unlisted', ...(dir && manifest ? { entry: entryFor(dir, l.path, l.name) } : {}) }); }
  } catch (e: any) { problems.add(e.message); }
  // each word of the query starts a word of what an output says about itself or of its package's title and project
  // tags: "tree" finds trees, not every output of topotopo/street; a package's description, which lists its contents,
  // would match every output of the package
  const wordsOf = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const words = wordsOf(String(q.query ?? ''));
  // a library that holds TopoTopo's built-in library (its repository, say) holds none of its packages again
  const builtinFolders = builtinPackages(builtin, problems), builtinDirs = new Set(builtinFolders.map((f) => key(f.dir)));
  const libraries: SearchLibrary[] = libs.map((lib) => {
    let folders: PackageFolder[];
    if (lib.standing === 'builtin') folders = builtinFolders;
    else {
      const scan = scanLibrary({ name: lib.name, path: lib.root });
      for (const p of scan.problems) problems.add(`${libraryText(lib.name)}: ${p}`);
      folders = scan.projects.flatMap((p) => (p.manifest.package && !builtinDirs.has(key(p.dir)) ? [{ package: p.manifest.package, library: lib.name, dir: p.dir, working: true }] : []));
    }
    const hits: SearchHit[] = [];
    for (const f of folders) {
      const place = readVersions(f.dir, f.package, lib.name, problems).at(-1);
      if (!place) continue;
      let pm: ProjectManifest | null = null;
      try { pm = readManifest(place.dir); } catch (e: any) { problems.add(e.message); }
      const v = place.info, about = [pm?.title ?? '', ...(pm?.tags ?? [])];
      const isDefault = (o: OutputInfo) => isDefaultOutput(v, o);
      const found: [string, OutputInfo, string | undefined][] = Object.entries(v.outputs).map(([k, o]) => [`${f.package}/${k}`, o, isDefault(o) ? f.package : undefined]);
      if (!Object.values(v.outputs).some(isDefault)) found.unshift([f.package, v.default, undefined]);
      for (const [type, o, alias] of found) {
        const tags = o.tags ?? [];
        if (q.kind !== undefined && o.kind !== q.kind) continue;
        if (q.tag !== undefined && !tags.includes(q.tag)) continue;
        const hay = wordsOf([type, alias ?? '', o.label ?? '', o.description ?? '', ...tags, ...about].join(' '));
        if (!words.every((w) => hay.some((h) => h.startsWith(w)))) continue;
        const used = uses[f.package];
        hits.push({
          type, ...(alias ? { alias } : {}), package: f.package, version: v.version, ...(o.label ? { label: o.label } : {}), kind: o.kind, tags,
          ...(o.description ? { description: o.description } : {}), ...(used ? { used } : {}), ...(manifest?.package === f.package ? { self: true } : {}),
        });
      }
    }
    return { ...lib, hits: hits.sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0)) };
  });
  return { query: q, project: dir && manifest ? `project ${manifest.id}` : null, libraries, problems: [...problems] };
}

/**
 * The entry project.json would list for a registered library at `root` (named `name`): its path from the project when
 * it is near (in the same repository, most likely: every checkout and worktree then reads its own), else its name.
 */
function entryFor(dir: string, root: string, name: string): string {
  const rel = path.relative(dir, root).split(path.sep).join('/');
  const near = !!rel && !path.isAbsolute(rel) && !/^[A-Za-z]:/.test(rel) && rel.split('/').filter((x) => x === '..').length <= 3;
  return near ? (rel.startsWith('.') ? rel : `./${rel}`) : name;
}

/** A search as the CLI (or, `mcp`, the library tool) says it: the hits by library, and whether the project can use them. */
export function searchText(r: SearchResult, mcp = false): string {
  const q = r.query, hits = r.libraries.flatMap((l) => l.hits);
  const asked = [q.query?.trim() ? `"${q.query.trim()}"` : '', q.kind ? `kind ${q.kind}` : '', q.tag ? `tag ${q.tag}` : ''].filter(Boolean).join(', ') || 'everything';
  const lines = [hits.length
    ? `search ${asked}: ${hits.length} output${hits.length === 1 ? '' : 's'} in ${r.libraries.filter((l) => l.hits.length).length} of the ${r.libraries.length} libraries looked in${r.project ? `, for ${r.project}` : ''}`
    : `search ${asked}: no output matches in ${r.libraries.map((l) => libraryText(l.name)).join(', ')}`];
  if (!r.project) lines.push(`this folder is in no project, and only a project's graphs use packages: ${mcp ? "library {action:\"init\"} makes the server's folder one, when the person says so" : makeProject()}`);
  for (const l of r.libraries) {
    if (!l.hits.length) continue;
    const standing = l.standing === 'builtin' ? 'TopoTopo\'s own packages, which every project can use: a graph that names one adds it'
      : l.standing === 'listed' ? `${r.project} lists it: a graph that names one of these adds its package`
      : r.project ? `${r.project} does not list it: to use these, ${mcp ? `library {action:"set", libraries:[…, "${l.entry ?? l.name}"]} lists it, when the person says so (the tools never add a library by themselves)` : `${program()} libraries add ${l.entry ?? l.name} lists it`}`
      : 'a registered library';
    lines.push(`${l.standing === 'builtin' ? `TopoTopo's built-in library "${l.name}"` : `library "${l.name}" (${l.root})`}: ${standing}`);
    for (const h of l.hits) {
      const also = [h.alias ? `also ${h.alias}, its default output` : '', h.self ? 'this project\'s own package' : h.used ? `this project uses ${h.used}` : ''].filter(Boolean).join('; ');
      lines.push(`  ${h.type}  ${kindTagsText(h)}${h.label ? `  "${h.label}"` : ''}  ${h.version}${also ? `  (${also})` : ''}`);
      if (h.description) lines.push(`    ${h.description.length > 300 ? `${h.description.slice(0, 299)}…` : h.description}`);
    }
  }
  if (hits.length && r.libraries.some((l) => !l.hits.length)) lines.push(`nothing matches in ${r.libraries.filter((l) => !l.hits.length).map((l) => libraryText(l.name)).join(', ')}`);
  if (hits.length) lines.push(mcp ? `help {nodes:["${hits[0].type}"]} gives an output's params and inputs` : `${program()} --help-node ${hits[0].type} gives an output's params and inputs`);
  if (r.problems.length) lines.push(`could not check ${r.problems.length}:`, ...r.problems.map((p) => `  ${p}`));
  return lines.join('\n');
}
