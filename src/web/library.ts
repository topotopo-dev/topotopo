// Libraries and workspaces of packages, as the web app shows them: scanning one for its packages (the one scan,
// src/scan.ts: .topo files only; it never creates folders and never cooks), creating a package in one, a package's
// files, and baking its previews (.web/: thumb.png, preview.glb, bake.json, all derived). Packages themselves are
// src/package.ts.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ID_RE } from '../graph/scope.ts';
import { graphFiles } from '../session.ts';
import { loadConfig } from '../config.ts';
import type { WebConfig, LibraryRef } from '../config.ts';
import type { PackageLink, PackageManifest } from '../package.ts';
import { manifestAt, parseManifest, packageRepoFiles, slugify, within, writeManifest } from '../package.ts';
import { folderKey, forgetScans, scanTree } from '../scan.ts';
import type { Package, Scan } from '../scan.ts';
import { readWorkspace, scanWorkspace } from '../workspace.ts';
import { godotIgnore, isEngineFile } from '../engines.ts';

export type { Package };

/** Bumped when the baked files change shape (render options, GLB options), so every package bakes again. */
export const BAKE_VERSION = 1;
/** a library name or package id: lower-case letters, digits, "-" and "_", starting with a letter or digit (the package name rule) */
export { ID_RE };

/** Folder names a scan never enters (src/scan.ts), which no package path may hold. */
const SKIPPED = new Set(['node_modules', 'topotopo-packages', 'binaries', 'intermediate', 'saved', 'deriveddatacache', '__externalactors__', '__externalobjects__']);
const jsonFiles = (dir: string) => { try { return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch { return []; } };
const PKG_VERSION = (() => {
  // package.json sits two levels above both src/web/library.ts and dist/web/library.js
  try { return String(JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version); } catch { return '0'; }
})();

export interface BakeState {
  key: string;
  /** ms since the epoch */
  at: number;
  ok: boolean;
  error?: string;
  ms?: number;
  /** preview.glb was written (false: too large, or the bake failed before it) */
  glb?: boolean;
  points?: number;
  prims?: number;
  warnings?: string[];
}

/** A library's or workspace's packages (src/scan.ts); `workspace`: it is a registered workspace. */
export type LibraryScan = Scan & { workspace?: boolean };

/** A registered library or workspace: its name and folder (a workspace's packages are scanned as its file says). */
export type PlaceRef = LibraryRef & { workspace?: boolean };

// ------------------------------------------------------------------------------------------------------------ scan

/** Every package below a library's (or, `workspace`, a workspace's) root, sorted by path (src/scan.ts). */
export function scanLibrary(lib: PlaceRef): LibraryScan {
  if (!lib.workspace) return scanTree(lib.name, lib.path);
  try { return { ...scanWorkspace(path.resolve(lib.path)), name: lib.name, workspace: true }; }
  catch (e: any) { return { name: lib.name, root: path.resolve(lib.path), packages: [], problems: [e.message], workspaces: [], workspace: true }; }
}

/**
 * The registered libraries and workspaces, scanned: the libraries first, then the workspaces; a library inside a
 * registered workspace is left out (its packages are the workspace's).
 */
export function scanAll(cfg: WebConfig = loadConfig()): LibraryScan[] {
  const libs = cfg.libraries.filter((l) => !cfg.workspaces.some((w) => within(l.path, w.path)));
  return [...libs.map((l) => scanLibrary(l)), ...cfg.workspaces.map((w) => scanLibrary({ ...w, workspace: true }))];
}

// ---------------------------------------------------------------------------------------------------------- create

export interface CreateOptions { title?: string; description?: string; tags?: string[]; links?: PackageLink[]; graph?: object }

/**
 * A new package at `<root>/<rel>` ("props/lantern") of a library or a workspace: <id>.topo, the package folders,
 * attachments/, a .gitignore for the derived files and a .gitattributes that keeps its versions and copies byte for
 * byte (inside a Godot project, a .gdignore in inputs/). `graph` (a graph spec) becomes graphs/main.json. Fails when
 * the folder holds a package already, lies inside one, the path holds a folder the scan never enters, or the id is
 * taken in the library or workspace.
 */
export function createPackage(lib: PlaceRef, rel: string, o: CreateOptions = {}): Package {
  const parts = rel.replace(/\\/g, '/').split('/').filter(Boolean);
  if (!parts.length || parts.some((p) => p === '.' || p === '..' || p.startsWith('.') || SKIPPED.has(p.toLowerCase()) || /[<>:"|?*\u0000-\u001f]/.test(p)))
    throw new Error(`bad package path "${rel}": give folders below the ${lib.workspace ? 'workspace' : 'library'}, e.g. "props/lantern" (no dot folders, node_modules, topotopo-packages or engine build folders)`);
  const root = path.resolve(lib.path);
  const dir = path.join(root, ...parts);
  if (manifestAt(dir)) throw new Error(`${dir} is a package already`);
  const id = slugify(parts[parts.length - 1]);
  if (!ID_RE.test(id)) throw new Error(`"${parts[parts.length - 1]}" gives no usable id: use letters or digits`);
  const scan = scanLibrary(lib);
  const taken = scan.packages.find((p) => p.id === id);
  if (taken) throw new Error(`id "${id}" is used by ${taken.rel} in ${lib.workspace ? 'the workspace' : 'library'} "${lib.name}": pick another folder name`);
  if (scan.packages.some((p) => dir.startsWith(p.dir + path.sep))) throw new Error(`${rel} is inside another package`);
  for (const d of ['graphs', 'assets', 'inputs', 'exports', 'attachments']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  packageRepoFiles(dir);
  const manifest = parseManifest({
    title: o.title ?? parts[parts.length - 1], description: o.description ?? '', tags: o.tags ?? [], links: o.links ?? [],
    graph: 'main', created: new Date().toISOString().slice(0, 10),
  }, id);
  writeManifest(dir, manifest, id);
  godotIgnore(dir);
  if (o.graph) fs.writeFileSync(path.join(dir, 'graphs', 'main.json'), JSON.stringify(o.graph, null, 2));
  forgetScans();
  return scanLibrary(lib).packages.find((p) => folderKey(p.dir) === folderKey(dir))!;
}

/** A registered workspace's name as a place of the web app (and createPackage), or null when its file cannot be read. */
export function workspaceRef(w: LibraryRef): PlaceRef {
  let name = w.name;
  try { name = readWorkspace(w.path).name; } catch { /* its registered name */ }
  return { name, path: w.path, workspace: true };
}

// ------------------------------------------------------------------------------------------------------ package files

export interface PackageFile { path: string; size: number; mtime: number; image: boolean }
const IMAGE_RE = /\.(png|jpe?g|webp|gif|avif)$/i;

/**
 * Files under a package subfolder (attachments/, exports/, inputs/), recursively: posix paths; dot-files and the files
 * an engine writes beside ours (*.import, *.uid, *.uasset …) skipped.
 */
export function listFiles(dir: string): PackageFile[] {
  const out: PackageFile[] = [];
  const walk = (d: string, rel: string, depth: number) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(d, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      let st: fs.Stats;
      try { st = fs.statSync(abs); } catch { continue; }
      if (st.isDirectory()) { if (depth < 16) walk(abs, r, depth + 1); }
      else if (st.isFile() && !isEngineFile(e.name)) out.push({ path: r, size: st.size, mtime: Math.round(st.mtimeMs), image: IMAGE_RE.test(e.name) });
    }
  };
  walk(dir, '', 0);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** A package's graph names: graphs/ and the graph files beside its manifest (graphFiles). */
export const graphNames = (dir: string) => [...graphFiles(dir).keys()];

/** A package's graph file, parsed (null when missing or unreadable). */
export function readGraph(dir: string, name: string): any {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'graphs', name + '.json'), 'utf8')); } catch { return null; }
}

// ------------------------------------------------------------------------------------------------------------ bake

export const webDir = (dir: string) => path.join(dir, '.web');

/**
 * What a bake depends on: the bake version, the package version, the manifest's graph and bake choice, every graph
 * and asset file's content, each input file's path, size and time, and the package lock (the versions it uses).
 */
export function bakeKey(dir: string, m: PackageManifest): string {
  const h = createHash('sha256');
  h.update(`${BAKE_VERSION}|${PKG_VERSION}|${m.graph}|${JSON.stringify(m.bake)}\n`);
  // the graphs (graphs/ and those beside the manifest) and the assets
  const files = [...graphFiles(dir).values(), ...jsonFiles(path.join(dir, 'assets')).map((f) => path.join(dir, 'assets', f))];
  for (const f of files) {
    h.update(`${path.relative(dir, f).split(path.sep).join('/')}\n`);
    try { h.update(fs.readFileSync(f)); } catch { /* removed meanwhile */ }
  }
  for (const f of listFiles(path.join(dir, 'inputs'))) h.update(`inputs/${f.path}|${f.size}|${f.mtime}\n`);
  const lock = path.join(dir, 'packages', 'lock.json');
  if (fs.existsSync(lock)) { h.update('packages/lock.json\n'); try { h.update(fs.readFileSync(lock)); } catch { /* removed meanwhile */ } }
  return h.digest('hex').slice(0, 32);
}

export function readBakeState(dir: string): BakeState | null {
  try { return JSON.parse(fs.readFileSync(path.join(webDir(dir), 'bake.json'), 'utf8')); } catch { return null; }
}

/** The package needs a bake: never baked, or something it depends on changed since. */
export function isStale(p: Package): boolean {
  const s = readBakeState(p.dir);
  return !s || s.key !== bakeKey(p.dir, p.manifest);
}

