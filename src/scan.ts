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
// said, once. Scans are kept per process by root until forgetScans(): a command forgets them when it starts,
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
/** Folders a scan never enters, anywhere (lower case). */
const SKIP = new Set(['node_modules', 'topotopo-packages', 'binaries', 'intermediate', 'saved', 'deriveddatacache', '__externalactors__', '__externalobjects__']);
/** C#'s build folders: skipped beside a *.csproj or *.sln. */
const DOTNET = new Set(['bin', 'obj']);
const WORKSPACE_FILE = 'topotopo-workspace.json';

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

const scans = new Map<string, Scan>();
/** Forget the scans kept: the next one reads the folders again. */
export function forgetScans() { scans.clear(); }

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
    const tops = files.filter((f) => f.endsWith(MANIFEST_EXT) && f.length > MANIFEST_EXT.length);
    if (rel) {
      // another workspace: listed, not scanned
      if (files.includes(WORKSPACE_FILE)) { out.workspaces.push(dir); return; }
      // another engine project than the workspace's own
      const projects = files.filter((f) => engineTypeOf(f));
      if (projects.length && !projects.some((f) => folderKey(path.join(dir, f)) === engine)) return;
      // a TopoTopo checkout (its test fixtures and built-in packages are not the workspace's)
      if (files.includes('package.json')) {
        try { if (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))?.name === 'topotopo') return; } catch { /* not JSON: a folder like any other */ }
      }
      if (tops.length > 1) { out.problems.push(`${rel}: holds ${tops.slice(0, -1).join(', ')} and ${tops.at(-1)}: a package has one ${MANIFEST_EXT} file, whose name is its id`); return; }
      if (tops.length === 1) { addPackage(dir, rel, tops[0]); return; }
      // a folder that holds project.json instead: said, and not entered
      if (files.includes('project.json')) {
        const old = oldManifest(dir);
        if (old) { out.problems.push(old); return; }
      }
    } else if (tops.length) out.problems.push(`${path.join(dir, tops[0])}: the ${name ? `folder of "${name}"` : 'root folder'} itself is not a package; put packages in folders below it`);
    const dotnet = files.some((f) => /\.(csproj|sln)$/i.test(f));
    const below = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name.toLowerCase()) && !(dotnet && DOTNET.has(e.name.toLowerCase())));
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
