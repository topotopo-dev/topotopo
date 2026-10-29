// Libraries of projects, as the Gallery shows them: scanning a library for its projects (project.json files only: it
// never creates folders and never cooks), creating a project in one, a project's files, and baking its previews
// (.gallery/: thumb.png, preview.glb, bake.json, all derived). Projects themselves are src/project.ts.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ID_RE } from '../graph/scope.ts';
import { graphFiles } from '../session.ts';
import { loadConfig } from '../config.ts';
import type { GalleryConfig, LibraryRef } from '../config.ts';
import type { ProjectLink, ProjectManifest } from '../project.ts';
import { manifestFile, parseManifest, projectRepoFiles, readManifest, slugify, writeManifest } from '../project.ts';

/** Bumped when the baked files change shape (render options, GLB options), so every project bakes again. */
export const BAKE_VERSION = 1;
/** a library name or project id: lower-case letters, digits, "-" and "_", starting with a letter or digit (the package name rule) */
export { ID_RE };

const MAX_DEPTH = 8;
/**
 * folders a scan never enters (besides dot-folders); a project's own folders are never entered either, nor its
 * published versions and package copies, whose project.json files are not projects
 */
const SKIP = new Set(['node_modules', 'graphs', 'assets', 'inputs', 'exports', 'attachments', 'versions', 'packages']);
const PKG_VERSION = (() => {
  // package.json sits two levels above both src/gallery/library.ts and dist/gallery/library.js
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

export interface Project {
  lib: string;
  id: string;
  /** absolute folder */
  dir: string;
  /** posix path of the folder relative to the library root */
  rel: string;
  /** the parent folders' path ("" at the top), how the gallery groups projects */
  collection: string;
  manifest: ProjectManifest;
  /** newest change to project.json, graphs/ or assets/ (ms) */
  updated: number;
}

export interface LibraryScan { name: string; root: string; projects: Project[]; problems: string[] }

// ------------------------------------------------------------------------------------------------------------ scan

const mtime = (p: string) => fs.statSync(p, { throwIfNoEntry: false })?.mtimeMs ?? 0;
const jsonFiles = (dir: string) => { try { return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch { return []; } };

/** Every project below a library root, sorted by path. Ids used twice: the first path keeps it, the others are problems. */
export function scanLibrary(lib: LibraryRef): LibraryScan {
  const root = path.resolve(lib.path);
  const out: LibraryScan = { name: lib.name, root, projects: [], problems: [] };
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) { out.problems.push(`library "${lib.name}": no folder ${root}`); return out; }
  const seen = new Map<string, string>();
  const walk = (dir: string, rel: string, depth: number) => {
    if (fs.existsSync(manifestFile(dir))) {
      if (!rel) { out.problems.push(`${manifestFile(dir)}: the library folder itself is not a project; put projects in folders below it`); }
      else {
        try {
          const manifest = readManifest(dir);
          const prev = seen.get(manifest.id);
          if (prev !== undefined) out.problems.push(`${rel}: id "${manifest.id}" is already used by ${prev} (change "id" in its project.json)`);
          else {
            seen.set(manifest.id, rel);
            const updated = Math.round(Math.max(mtime(manifestFile(dir)), ...['graphs', 'assets'].flatMap((d) => jsonFiles(path.join(dir, d)).map((f) => mtime(path.join(dir, d, f))))));
            out.projects.push({ lib: lib.name, id: manifest.id, dir, rel, collection: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '', manifest, updated });
          }
        } catch (e: any) { out.problems.push(e.message); }
        return;
      }
    }
    if (depth >= MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP.has(e.name)) continue;
      walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1);
    }
  };
  walk(root, '', 0);
  return out;
}

export function scanAll(cfg: GalleryConfig = loadConfig()): LibraryScan[] {
  return cfg.libraries.map(scanLibrary);
}

// ---------------------------------------------------------------------------------------------------------- create

export interface CreateOptions { title?: string; description?: string; tags?: string[]; links?: ProjectLink[]; graph?: object }

/**
 * A new project at `<library root>/<rel>` ("props/lantern"): project.json, the project folders, attachments/, a
 * .gitignore for the derived files and a .gitattributes that keeps its versions and copies byte for byte. `graph` (a
 * graph spec) becomes graphs/main.json. Fails when the folder holds a project already or the id is taken in the library.
 */
export function createProject(lib: LibraryRef, rel: string, o: CreateOptions = {}): Project {
  const parts = rel.replace(/\\/g, '/').split('/').filter(Boolean);
  if (!parts.length || parts.some((p) => p === '.' || p === '..' || p.startsWith('.') || SKIP.has(p) || /[<>:"|?*\u0000-\u001f]/.test(p)))
    throw new Error(`bad project path "${rel}": give folders below the library, e.g. "props/lantern"`);
  const root = path.resolve(lib.path);
  const dir = path.join(root, ...parts);
  if (fs.existsSync(manifestFile(dir))) throw new Error(`${dir} is a project already`);
  const id = slugify(parts[parts.length - 1]);
  if (!ID_RE.test(id)) throw new Error(`"${parts[parts.length - 1]}" gives no usable id: use letters or digits`);
  const scan = scanLibrary(lib);
  const taken = scan.projects.find((p) => p.id === id);
  if (taken) throw new Error(`id "${id}" is used by ${taken.rel} in library "${lib.name}": pick another folder name`);
  if (scan.projects.some((p) => dir.startsWith(p.dir + path.sep))) throw new Error(`${rel} is inside another project`);
  for (const d of ['graphs', 'assets', 'inputs', 'exports', 'attachments']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  projectRepoFiles(dir);
  const manifest = parseManifest({
    id, title: o.title ?? parts[parts.length - 1], description: o.description ?? '', tags: o.tags ?? [], links: o.links ?? [],
    graph: 'main', created: new Date().toISOString().slice(0, 10),
  }, id);
  writeManifest(dir, manifest);
  if (o.graph) fs.writeFileSync(path.join(dir, 'graphs', 'main.json'), JSON.stringify(o.graph, null, 2));
  return scanLibrary(lib).projects.find((p) => p.id === id)!;
}

// ------------------------------------------------------------------------------------------------------ project files

export interface ProjectFile { path: string; size: number; mtime: number; image: boolean }
const IMAGE_RE = /\.(png|jpe?g|webp|gif|avif)$/i;

/** Files under a project subfolder (attachments/, exports/), recursively: posix paths, dot-files skipped. */
export function listFiles(dir: string): ProjectFile[] {
  const out: ProjectFile[] = [];
  const walk = (d: string, rel: string, depth: number) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(d, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      let st: fs.Stats;
      try { st = fs.statSync(abs); } catch { continue; }
      if (st.isDirectory()) { if (depth < 16) walk(abs, r, depth + 1); }
      else if (st.isFile()) out.push({ path: r, size: st.size, mtime: Math.round(st.mtimeMs), image: IMAGE_RE.test(e.name) });
    }
  };
  walk(dir, '', 0);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** A project's graph names: graphs/ and the graph files beside project.json (graphFiles). */
export const graphNames = (dir: string) => [...graphFiles(dir).keys()];

/** A project's graph file, parsed (null when missing or unreadable). */
export function readGraph(dir: string, name: string): any {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'graphs', name + '.json'), 'utf8')); } catch { return null; }
}

// ------------------------------------------------------------------------------------------------------------ bake

export const galleryDir = (dir: string) => path.join(dir, '.gallery');

/**
 * What a bake depends on: the bake version, the package version, the manifest's graph and bake choice, every graph
 * and asset file's content, each input file's path, size and time, and the package lock (the versions it uses).
 */
export function bakeKey(dir: string, m: ProjectManifest): string {
  const h = createHash('sha256');
  h.update(`${BAKE_VERSION}|${PKG_VERSION}|${m.graph}|${JSON.stringify(m.bake)}\n`);
  // the graphs (graphs/ and those beside project.json) and the assets
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
  try { return JSON.parse(fs.readFileSync(path.join(galleryDir(dir), 'bake.json'), 'utf8')); } catch { return null; }
}

/** The project needs a bake: never baked, or something it depends on changed since. */
export function isStale(p: Project): boolean {
  const s = readBakeState(p.dir);
  return !s || s.key !== bakeKey(p.dir, p.manifest);
}

