// The one scan: the packages of a workspace or a library, which the lookup, gathering copies, update, check, the
// workspace text, the MCP server and the web app all read. A package is a folder holding exactly one <id>.topo file;
// the scan never enters one (a package holds no other), and the root of a workspace or library is no package. It
// lists each folder once (spotting .topo files, project.json, engine projects and subfolders in that one listing),
// reads a manifest only for a package, and stats nothing. What it skips, anywhere (names compared without case):
//   dot folders, node_modules, topotopo-packages (a workspace's copies);
//   Unreal's Binaries, Intermediate, Saved, DerivedDataCache, __ExternalActors__, __ExternalObjects__;
//   C#'s bin and obj beside a *.csproj or *.sln;
//   a folder holding an engine project (project.godot, *.uproject) other than the workspace's own;
//   a folder holding another topotopo-workspace.json: another workspace, listed as such and not scanned;
//   a TopoTopo checkout (a package.json named "topotopo").
// Plain folders named assets, graphs, inputs, exports, attachments, versions or packages are scanned like any other
// outside a package (a Godot project keeps its content in assets/). It goes 16 folders deep; a folder cut off there is
// said, once. A root that holds a .topo file is a package: said, and not entered either. unscanned() says why a scan
// never reaches a folder, by the same rules: the workspace a package belongs to (package.ts locate) and where a new
// package may go (web/library.ts createPackage) follow it. Scans are kept per process by root until forgetScans(): a command forgets them when it starts,
// TopoTopo forgets them when it writes a manifest or a workspace file, and a long-running process (the MCP server, the
// viewer, the web app) when it refreshes or when a lookup does not find a name.
import fs from 'node:fs';
import path from 'node:path';
import { ID_RE } from './graph/scope.ts';
import { MANIFEST_EXT } from './session.ts';
import { engineTypeOf } from './engines.ts';
import { oldManifest, readManifestFile, slugify } from './package.ts';
import type { PackageManifest } from './package.ts';

/** How deep below its root a scan looks. */
export const SCAN_DEPTH = 16;
/** Folders a scan never enters, anywhere (lower case). The web app hides the same folders (src/web/folders.ts). */
export const SKIP = new Set(['node_modules', 'topotopo-packages', 'binaries', 'intermediate', 'saved', 'deriveddatacache', '__externalactors__', '__externalobjects__']);
/** C#'s build folders: skipped beside a *.csproj or *.sln. */
const DOTNET = new Set(['bin', 'obj']);
export const WORKSPACE_FILE = 'topotopo-workspace.json';

export interface Package {
  /** the name of the workspace or library it was found in */
  lib: string;
  id: string;
  /** absolute folder */
  dir: string;
  /** posix path of the folder relative to the root of its workspace or library */
  rel: string;
  /** the parent folders' path ("" at the top), how the web app groups packages */
  collection: string;
  manifest: PackageManifest;
  /** newest change to its manifest, graphs/ or assets/ (ms), read when asked */
  readonly updated: number;
}

export interface Scan {
  /** the workspace's or library's name */
  name: string;
  root: string;
  /** every package below the root, sorted by path */
  packages: Package[];
  /** what is wrong: a manifest that cannot be read, two .topo files, an id used twice, a folder too deep */
  problems: string[];
  /** other workspaces below the root (a folder holding topotopo-workspace.json): listed, not scanned */
  workspaces: string[];
}

export interface ScanOptions {
  /** the engine project file of the workspace being scanned (absolute): the folder holding it is scanned */
  engine?: string | null;
}

const mtime = (p: string) => fs.statSync(p, { throwIfNoEntry: false })?.mtimeMs ?? 0;
const jsonFiles = (dir: string) => { try { return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch { return []; } };
const byName = (a: fs.Dirent, b: fs.Dirent) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
/** A folder as a key: its absolute path, without case on Windows and macOS. */
export const folderKey = (p: string) => (process.platform === 'linux' ? path.resolve(p) : path.resolve(p).toLowerCase());

/** A folder holding a package.json named "topotopo": a TopoTopo checkout. */
export function isCheckout(dir: string): boolean {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))?.name === 'topotopo'; } catch { return false; /* not JSON: a folder like any other */ }
}

/**
 * Why the scan never enters a folder named `name` whose parent holds the files `parentFiles` (or a function that lists
 * them, called only when they matter); null when it may. The web app hides the same folders.
 */
export function skippedName(name: string, parentFiles: string[] | (() => string[])): string | null {
  const lower = name.toLowerCase();
  if (name.startsWith('.')) return 'a dot folder';
  if (SKIP.has(lower)) return `a ${name} folder`;
  if (DOTNET.has(lower) && (typeof parentFiles === 'function' ? parentFiles() : parentFiles).some((f) => /\.(csproj|sln)$/i.test(f))) return `C#'s ${name} folder beside a .csproj or .sln`;
  return null;
}

/**
 * Why the scan does not look into a folder below its root that holds `files` (`engine`: the folderKey of the
 * workspace's own engine project file); null when it does.
 */
function skippedFolder(dir: string, files: string[], engine: string | null): string | null {
  if (files.includes(WORKSPACE_FILE)) return `another workspace (it holds ${WORKSPACE_FILE})`;
  const projects = files.filter((f) => engineTypeOf(f));
  if (projects.length && !projects.some((f) => folderKey(path.join(dir, f)) === engine)) return `another engine project (it holds ${projects[0]})`;
  if (files.includes('package.json') && isCheckout(dir)) return 'a TopoTopo checkout';
  return null;
}

const filesIn = (dir: string) => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name); } catch { return []; } };
const isTopo = (f: string) => f.endsWith(MANIFEST_EXT) && f.length > MANIFEST_EXT.length;

/**
 * Why a scan of `root` never reaches `dir`, a folder below it, by the scan's own rules: the first folder on the way it
 * does not enter, said ("tool/bin: C#'s bin folder beside a .csproj or .sln, which the scan never enters"); null when
 * the scan reaches it, or `dir` is `root` or not below it. Folders that are not there yet are judged by their names and
 * the files of those that are (a new package's path is asked before it is made). `dir` itself may hold a .topo file (a
 * package the scan finds); a folder above it that holds one, the root included, is a package the scan never enters.
 */
export function unscanned(root: string, dir: string, o: ScanOptions = {}): string | null {
  const top = path.resolve(root), r = path.relative(top, path.resolve(dir));
  if (!r || r.startsWith('..') || path.isAbsolute(r)) return null;
  const parts = r.split(path.sep), engine = o.engine ? folderKey(o.engine) : null;
  let files = filesIn(top);
  if (files.some(isTopo)) return `${top} is a package itself (${files.find(isTopo)}), and the scan enters no package`;
  for (let i = 0, d = top; i < parts.length; i++) {
    const rel = parts.slice(0, i + 1).join('/'), name = skippedName(parts[i], files);
    if (name) return `${rel}: ${name}, which the scan never enters`;
    if (i + 1 > SCAN_DEPTH) return `${rel}: more than ${SCAN_DEPTH} folders below ${top}, deeper than the scan looks`;
    d = path.join(d, parts[i]);
    files = filesIn(d);
    const folder = skippedFolder(d, files, engine);
    if (folder) return `${rel}: ${folder}, which the scan does not enter`;
    if (i < parts.length - 1 && files.some(isTopo)) return `${rel}: a package (${files.find(isTopo)}), which the scan never enters`;
  }
  return null;
}

const scans = new Map<string, Scan>();
/** Forget the scans kept: the next one reads the folders again. */
export function forgetScans() { scans.clear(); }
/** Forget the scans kept of one root (a workspace's or library's folder): the others stay. */
export function forgetScansOf(root: string) {
  const k = `|${folderKey(root)}|`;
  for (const key of [...scans.keys()]) if (key.includes(k)) scans.delete(key);
}

/**
 * The packages below a workspace's or library's root (see the top of this file), kept until forgetScans(). `name`:
 * the workspace's or library's name, which each package carries (Package.lib).
 */
export function scanTree(name: string, root: string, o: ScanOptions = {}): Scan {
  const key = `${name}|${folderKey(root)}|${o.engine ? folderKey(o.engine) : ''}`;
  const have = scans.get(key);
  if (have) return have;
  const s = scanNow(name, root, o);
  scans.set(key, s);
  return s;
}

function scanNow(name: string, rootDir: string, o: ScanOptions): Scan {
  const root = path.resolve(rootDir);
  const out: Scan = { name, root, packages: [], problems: [], workspaces: [] };
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) { out.problems.push(`no folder ${root}`); return out; }
  const engine = o.engine ? folderKey(o.engine) : null;
  const ids = new Map<string, string>();
  const walk = (dir: string, rel: string, depth: number) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }).sort(byName); } catch { return; }
    const files = entries.filter((e) => e.isFile()).map((e) => e.name);
    const tops = files.filter(isTopo);
    if (rel) {
      // another workspace (listed, not scanned), another engine project than the workspace's own, a TopoTopo checkout
      // (its test fixtures and built-in packages are not the workspace's)
      if (skippedFolder(dir, files, engine)) { if (files.includes(WORKSPACE_FILE)) out.workspaces.push(dir); return; }
      if (tops.length > 1) { out.problems.push(`${rel}: holds ${tops.slice(0, -1).join(', ')} and ${tops.at(-1)}: a package has one ${MANIFEST_EXT} file, whose name is its id`); return; }
      if (tops.length === 1) { addPackage(dir, rel, tops[0]); return; }
      // a folder that holds project.json instead: said, and not entered
      if (files.includes('project.json')) {
        const old = oldManifest(dir);
        if (old) { out.problems.push(old); return; }
      }
    } else if (tops.length) {
      // a package is never entered: its versions/ and packages/ hold copies of packages, not packages of the root's
      out.problems.push(`${path.join(dir, tops[0])}: the ${name ? `folder of "${name}"` : 'root folder'} is a package itself, and a package holds no other: nothing below it is looked in for packages; keep the packages in folders below a root that is no package`);
      return;
    }
    const below = entries.filter((e) => e.isDirectory() && !skippedName(e.name, files));
    if (!below.length) return;
    if (depth >= SCAN_DEPTH) { out.problems.push(`${rel || '.'}: its folders are more than ${SCAN_DEPTH} below ${root} and were not looked in for packages`); return; }
    for (const e of below) walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1);
  };
  const addPackage = (dir: string, rel: string, file: string) => {
    const id = file.slice(0, -MANIFEST_EXT.length), abs = path.join(dir, file);
    if (!ID_RE.test(id)) { out.problems.push(`${abs}: the file's name is the package id: lower-case letters, digits, - and _, starting with a letter or digit ("${slugify(id) || 'package'}${MANIFEST_EXT}")`); return; }
    let manifest: PackageManifest;
    try { manifest = readManifestFile(abs, id); } catch (e: any) { out.problems.push(e.message); return; }
    const prev = ids.get(id);
    if (prev !== undefined) out.problems.push(`${rel}: id "${id}" is also used by ${prev} (rename its ${file}): the web app shows ${prev}`);
    else ids.set(id, rel);
    let updated: number | undefined;
    out.packages.push({
      lib: name, id, dir, rel, collection: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '', manifest,
      get updated() {
        return updated ??= Math.round(Math.max(mtime(abs), ...['graphs', 'assets'].flatMap((d) => jsonFiles(path.join(dir, d)).map((f) => mtime(path.join(dir, d, f))))));
      },
    });
  };
  walk(root, '', 0);
  return out;
}
