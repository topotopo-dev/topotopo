// Libraries of projects (docs/design/gallery.md). A library is a folder listed in the user's config; a project is any
// folder below it holding a project.json, and is itself a TopoTopo workspace (graphs/ assets/ inputs/ exports/) plus
// attachments/ (concept art, references, source files) and .gallery/ (thumb.png, preview.glb, bake.json: derived).
//   ~/.topotopo/config.json (or $TOPOTOPO_CONFIG)   {libraries: [{name, path}], gallery: {port, cors: [origins]}}
//   $TOPOTOPO_LIBRARIES                              more libraries: name=path entries separated by path.delimiter
// Scanning reads project.json files only: it never creates folders and never cooks.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { NAME_RE } from '../workspace.ts';

/** Bumped when the baked files change shape (render options, GLB options), so every project bakes again. */
export const BAKE_VERSION = 1;
export const DEFAULT_PORT = 7340;
/** a library name or project id: lower-case letters, digits, "-" and "_", starting with a letter or digit */
export const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_DEPTH = 8;
/** folders a scan never enters (besides dot-folders); a project's own folders are never entered either */
const SKIP = new Set(['node_modules', 'graphs', 'assets', 'inputs', 'exports', 'attachments']);
const PKG_VERSION = (() => {
  // package.json sits two levels above both src/gallery/library.ts and dist/gallery/library.js
  try { return String(JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version); } catch { return '0'; }
})();

export interface LibraryRef { name: string; path: string }
export interface GalleryConfig {
  /** the config file read (or the one `library add` writes) */
  file: string;
  libraries: LibraryRef[];
  gallery: { port: number; cors: string[] };
}

export interface ProjectLink { label: string; url: string }
export interface ProjectManifest {
  id: string;
  title: string;
  description: string;
  tags: string[];
  /** the graph the gallery shows and bakes */
  graph: string;
  /** what to bake instead of the graph's output: another graph, a node, a frame (simulations settle after frame 1) */
  bake: { graph?: string; node?: string; frame?: number };
  /** links back to the board, concept pages, tickets */
  links: ProjectLink[];
  /** ISO date */
  created: string;
}

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

export const slugify = (s: string) =>
  s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 64);

// ---------------------------------------------------------------------------------------------------------- config

export function configFile(): string {
  return path.resolve(process.env.TOPOTOPO_CONFIG ?? path.join(os.homedir(), '.topotopo', 'config.json'));
}

/** The user's config with defaults filled in; libraries from $TOPOTOPO_LIBRARIES come after the file's. */
export function loadConfig(): GalleryConfig {
  const file = configFile();
  let raw: any = {};
  if (fs.existsSync(file)) {
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e: any) { throw new Error(`${file}: ${e.message}`); }
  }
  const libraries: LibraryRef[] = [];
  const add = (name: string, p: string, from: string) => {
    if (!ID_RE.test(name)) throw new Error(`${from}: library name "${name}" must match ${ID_RE}`);
    if (libraries.some((l) => l.name === name)) return;
    libraries.push({ name, path: path.resolve(path.dirname(file), p) });
  };
  for (const l of Array.isArray(raw.libraries) ? raw.libraries : []) {
    if (!l || typeof l.name !== 'string' || typeof l.path !== 'string') throw new Error(`${file}: each library is {"name": "...", "path": "..."}`);
    add(l.name, l.path, file);
  }
  for (const entry of (process.env.TOPOTOPO_LIBRARIES ?? '').split(path.delimiter).filter(Boolean)) {
    const i = entry.indexOf('=');
    // "name=path", or a bare path named after its folder ("C:\x" has no "=" before the drive colon)
    if (i > 0) add(entry.slice(0, i), entry.slice(i + 1), 'TOPOTOPO_LIBRARIES');
    else add(slugify(path.basename(path.resolve(entry))) || 'library', entry, 'TOPOTOPO_LIBRARIES');
  }
  const g = raw.gallery ?? {};
  return {
    file, libraries,
    gallery: {
      port: Number.isInteger(g.port) ? g.port : DEFAULT_PORT,
      cors: Array.isArray(g.cors) ? g.cors.filter((o: unknown) => typeof o === 'string') : [],
    },
  };
}

/** Add (or re-point) a library in the config file, keeping its other keys. */
export function addLibrary(name: string, dir: string): GalleryConfig {
  if (!ID_RE.test(name)) throw new Error(`library name "${name}" must match ${ID_RE} (e.g. "${slugify(name) || 'game'}")`);
  const file = configFile();
  let raw: any = {};
  if (fs.existsSync(file)) raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const libs: LibraryRef[] = (Array.isArray(raw.libraries) ? raw.libraries : []).filter((l: LibraryRef) => l?.name !== name);
  libs.push({ name, path: path.resolve(dir) });
  raw.libraries = libs;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(path.resolve(dir), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n');
  return loadConfig();
}

// ------------------------------------------------------------------------------------------------------- manifests

const str = (v: unknown, key: string, def = ''): string => {
  if (v === undefined || v === null) return def;
  if (typeof v !== 'string') throw new Error(`"${key}" must be a string`);
  return v;
};

/** project.json checked and normalised; throws naming the problem. `fallbackId` is used when it has no id. */
export function parseManifest(raw: any, fallbackId: string): ProjectManifest {
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
  const bake: ProjectManifest['bake'] = {};
  if (b.graph !== undefined) { bake.graph = str(b.graph, 'bake.graph'); if (!NAME_RE.test(bake.graph)) throw new Error(`"bake.graph" must be a graph name`); }
  if (b.node !== undefined) bake.node = str(b.node, 'bake.node');
  if (b.frame !== undefined) { if (!Number.isFinite(b.frame)) throw new Error('"bake.frame" must be a number'); bake.frame = b.frame; }
  return {
    id, graph, bake,
    title: str(raw.title, 'title', id),
    description: str(raw.description, 'description'),
    tags: [...new Set(tags.map((t: string) => t.trim()).filter(Boolean))] as string[],
    links: links.map((l: any) => ({ label: typeof l.label === 'string' && l.label ? l.label : l.url, url: l.url })),
    created: str(raw.created, 'created'),
  };
}

export const manifestFile = (dir: string) => path.join(dir, 'project.json');

export function readManifest(dir: string): ProjectManifest {
  const file = manifestFile(dir);
  let raw: any;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e: any) { throw new Error(`${file}: ${e.message}`); }
  try { return parseManifest(raw, slugify(path.basename(dir)) || 'project'); } catch (e: any) { throw new Error(`${file}: ${e.message}`); }
}

/** Write a manifest (atomically), keeping keys of the file this version does not know. */
export function writeManifest(dir: string, m: ProjectManifest) {
  const file = manifestFile(dir);
  let raw: any = {};
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new or unreadable: replaced */ }
  writeAtomic(file, JSON.stringify({ ...raw, ...m }, null, 2) + '\n');
}

/** Written as a dot-file next to the target and renamed, so readers never see half a file. */
export function writeAtomic(file: string, data: string | Uint8Array) {
  const part = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}-${Date.now().toString(36)}.part`);
  try { fs.writeFileSync(part, data); fs.renameSync(part, file); } catch (e) { fs.rmSync(part, { force: true }); throw e; }
}

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

/** The project a folder belongs to (the folder itself, or the nearest parent with a project.json), or null. */
export function projectDirOf(start: string): string | null {
  let d = path.resolve(start);
  for (;;) {
    if (fs.existsSync(manifestFile(d))) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

// ---------------------------------------------------------------------------------------------------------- create

export interface CreateOptions { title?: string; description?: string; tags?: string[]; links?: ProjectLink[]; graph?: object }

/**
 * A new project at `<library root>/<rel>` ("props/lantern"): project.json, the workspace folders, attachments/, and a
 * .gitignore for the derived files. `graph` (a graph spec) becomes graphs/main.json. Fails when the folder holds a
 * project already or the id is taken in the library.
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
  const gi = path.join(dir, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '.gallery/\n.cache/\n');
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

export const graphNames = (dir: string) => jsonFiles(path.join(dir, 'graphs')).map((f) => f.slice(0, -5)).filter((n) => NAME_RE.test(n));

/** A project's graph file, parsed (null when missing or unreadable). */
export function readGraph(dir: string, name: string): any {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'graphs', name + '.json'), 'utf8')); } catch { return null; }
}

// ------------------------------------------------------------------------------------------------------------ bake

export const galleryDir = (dir: string) => path.join(dir, '.gallery');

/**
 * What a bake depends on: the bake version, the package version, the manifest's graph and bake choice, every graph
 * and asset file's content, and each input file's path, size and time.
 */
export function bakeKey(dir: string, m: ProjectManifest): string {
  const h = createHash('sha256');
  h.update(`${BAKE_VERSION}|${PKG_VERSION}|${m.graph}|${JSON.stringify(m.bake)}\n`);
  for (const d of ['graphs', 'assets']) for (const f of jsonFiles(path.join(dir, d))) {
    h.update(`${d}/${f}\n`);
    try { h.update(fs.readFileSync(path.join(dir, d, f))); } catch { /* removed meanwhile */ }
  }
  for (const f of listFiles(path.join(dir, 'inputs'))) h.update(`inputs/${f.path}|${f.size}|${f.mtime}\n`);
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
