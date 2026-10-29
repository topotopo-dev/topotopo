// Libraries of projects. A library is a folder listed in the user's config; a project is any
// folder below it holding a project.json, and holds the folders TopoTopo works with (graphs/ assets/ inputs/ exports/) plus
// attachments/ (concept art, references, source files) and .gallery/ (thumb.png, preview.glb, bake.json: derived).
// A project that is a package also holds its published versions/ and, when it uses packages, their copies in packages/
// (src/gallery/packages.ts).
//   ~/.topotopo/config.json (or $TOPOTOPO_CONFIG)   {libraries: [{name, path}], gallery: {port, cors: [origins]}}
//   $TOPOTOPO_LIBRARIES                              more libraries: name=path entries separated by path.delimiter
// Scanning reads project.json files only: it never creates folders and never cooks. TopoTopo carries a library of its
// own, its built-in library (BUILTIN_LIBRARY), which every project looks in without listing it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ID_RE, parsePackageName } from '../graph/scope.ts';
import { NAME_RE, PROJECT_FOLDERS } from '../session.ts';

/** Bumped when the baked files change shape (render options, GLB options), so every project bakes again. */
export const BAKE_VERSION = 1;
export const DEFAULT_PORT = 7340;
/** a library name or project id: lower-case letters, digits, "-" and "_", starting with a letter or digit (the package name rule) */
export { ID_RE };
/** a package version: big.small, from 1.0 */
export const VERSION_RE = /^[1-9]\d*\.(0|[1-9]\d*)$/;
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

export interface LibraryRef { name: string; path: string }

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

/** How long a project's lock may be held before another process takes it as left behind by one that ended. */
const STALE_LOCK_MS = 120_000;

/**
 * Run `f` holding the project's lock, packages/.lock, a file only one process can create at a time: the CLI, the MCP
 * server and the viewer read, change and write project.json and packages/lock.json under it, so that none loses
 * another's change. Waits up to about ten seconds for another holder; a lock older than two minutes, or whose process
 * has ended, is taken over. Held again by the same process (a nested call), it just runs `f`.
 */
const heldLocks = new Set<string>();
export function withProjectLock<T>(dir: string, f: () => T): T {
  const file = path.join(path.resolve(dir), 'packages', '.lock');
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
      if (waited > 10_000) throw new Error(`${file} is held by another TopoTopo process (the viewer, an MCP server or a command) changing this project's packages; try again when it is done, or delete the file if no such process runs`);
      pause(50);
      waited += 50;
    }
  }
  heldLocks.add(file);
  try { return f(); } finally { heldLocks.delete(file); fs.rmSync(file, { force: true }); }
}

/**
 * TopoTopo's built-in library: TopoTopo's own packages (owner "topotopo"), shipped in library/ beside src/ and dist/.
 * Every project looks in it without listing it, and no other library takes its name. Its folder <name> holds the
 * versions of topotopo/<name> (versions/<version>/); in TopoTopo's repository it is the package's working folder as well,
 * a project, while an installed TopoTopo ships the versions alone (src/gallery/packages.ts reads it).
 */
export const BUILTIN_LIBRARY: LibraryRef = { name: 'topotopo', path: fileURLToPath(new URL('../../library', import.meta.url)) };
const builtinName = (name: string, from: string) => `${from}"${name}" is the name of TopoTopo's built-in library, which every project looks in: give this library another name`;
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
  /** the package the project is, "owner/name": set by the author before the first publish, never derived */
  package?: string;
  /** the packages its graphs use, with the version in use: {"owner/name": "1.3"} (written by the tools) */
  uses: Record<string, string>;
  /** where it finds packages to add: paths relative to the project (a library in the same repository) or registered library names */
  libraries: string[];
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
    if (name === BUILTIN_LIBRARY.name) throw new Error(builtinName(name, `${from}: `));
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
  if (name === BUILTIN_LIBRARY.name) throw new Error(builtinName(name, ''));
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
  const pkg = raw.package === undefined ? undefined : str(raw.package, 'package');
  const isPackage = (s: string) => { const n = parsePackageName(s); return typeof n !== 'string' && n.output === null; };
  if (pkg !== undefined && !isPackage(pkg)) throw new Error(`"package" "${pkg}" must be "owner/name": each part lower-case letters, digits, - and _, starting with a letter or digit`);
  const uses = raw.uses ?? {};
  if (!uses || typeof uses !== 'object' || Array.isArray(uses)) throw new Error('"uses" must be {"owner/name": "1.3"}');
  for (const [k, v] of Object.entries(uses)) {
    if (!isPackage(k)) throw new Error(`"uses": "${k}" is not a package name (owner/name)`);
    if (typeof v !== 'string' || !VERSION_RE.test(v)) throw new Error(`"uses": "${k}" needs a version such as "1.3", got ${JSON.stringify(v)}`);
  }
  // each entry's form is checked where the libraries are looked in (libraryEntry): one that is wrong is said there, and
  // the others still work
  const libraries = raw.libraries ?? [];
  if (!Array.isArray(libraries) || libraries.some((l: unknown) => typeof l !== 'string' || !l.trim())) throw new Error('"libraries" must be a list of registered library names and paths relative to the project ("./lib", "../../art/topotopo")');
  return {
    id, graph, bake,
    title: str(raw.title, 'title', id),
    description: str(raw.description, 'description'),
    tags: [...new Set(tags.map((t: string) => t.trim()).filter(Boolean))] as string[],
    links: links.map((l: any) => ({ label: typeof l.label === 'string' && l.label ? l.label : l.url, url: l.url })),
    created: str(raw.created, 'created'),
    ...(pkg !== undefined ? { package: pkg } : {}),
    uses: Object.fromEntries(Object.entries(uses as Record<string, string>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    libraries: libraries as string[],
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

// ------------------------------------------------------------------------------------- the libraries a project lists

/**
 * What an entry of project.json "libraries" names: a path relative to the project, written "./lib" or "../../art/lib"
 * (a library in the same repository, so every checkout and worktree reads its own), or a registered library's name
 * ("game"). Anything else says how to write it.
 */
export function libraryEntry(entry: string): { path: string } | { name: string } | { error: string } {
  const e = entry.trim();
  if (path.isAbsolute(e) || /^[A-Za-z]:/.test(e))
    return { error: `"${entry}" is an absolute path: list a library in the same repository by its path relative to the project ("../lib"), any other by its registered name` };
  if (e === '.' || e === '..' || /^\.\.?[\\/]/.test(e)) return { path: e };
  if (ID_RE.test(e)) return { name: e };
  return { error: `"${entry}" is neither a path written from the project ("./${e.replace(/\\/g, '/')}") nor a registered library's name (lower-case letters, digits, - and _)` };
}

/**
 * The entry project.json lists for a library a person names (`topotopo libraries add`): a folder (absolute, or relative
 * to `cwd`) as its path relative to the project, "./x" or "../x"; else a registered library's name. Throws for what is
 * neither, and for a folder that is a package rather than a library.
 */
export function libraryEntryFor(projectDir: string, given: string, cwd = process.cwd()): string {
  const abs = path.resolve(cwd, given);
  if (fs.statSync(abs, { throwIfNoEntry: false })?.isDirectory()) {
    if (fs.existsSync(manifestFile(abs)))
      throw new Error(`${abs} is a project (it holds project.json), not a library: list the folder that holds it, ${path.dirname(abs)}`);
    const rel = path.relative(projectDir, abs).split(path.sep).join('/') || '.';
    if (path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) throw new Error(`${abs} is on another drive than the project: register it (topotopo library add <name> ${abs}) and list it by its name`);
    return rel.startsWith('.') ? rel : `./${rel}`;
  }
  if (ID_RE.test(given)) {
    let cfg: GalleryConfig | null = null;
    try { cfg = loadConfig(); } catch { /* an unreadable config registers nothing */ }
    if (cfg?.libraries.some((l) => l.name === given) || given === BUILTIN_LIBRARY.name) return given;
    throw new Error(`"${given}" is no folder here and no registered library (${cfg?.libraries.map((l) => l.name).join(', ') || 'none are registered'}): give the library's folder, or register it first (${program()} library add ${given} <folder>)`);
  }
  throw new Error(`no folder ${abs}: give the library's folder or a registered library's name`);
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
 * What a project's .gitignore holds: files derived from it (previews, caches, the hashes of its copies' files) and the
 * lock its package commands hold while they write.
 */
const IGNORED = ['.gallery/', '.cache/', 'packages/.cache.json', 'packages/.lock'];
/**
 * What a project's .gitattributes holds: its published versions and its package copies are kept byte for byte, their
 * line ends never changed by a checkout (their hashes read text with LF line ends anyway, src/gallery/packages.ts).
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

/** A project's .gitignore and .gitattributes, made or completed. */
function projectRepoFiles(dir: string) {
  addLines(path.join(dir, '.gitignore'), IGNORED);
  addLines(path.join(dir, '.gitattributes'), ATTRIBUTES);
}

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

/**
 * A package name a person gives their project ("owner/name"): checked, and the owner "topotopo", which TopoTopo's own
 * packages have, refused.
 */
export function ownPackageName(pkg: string): string {
  const n = parsePackageName(pkg);
  if (typeof n === 'string' || n.output !== null) throw new Error(`"${pkg}" is not a package name: write "owner/name", each part lower-case letters, digits, - and _, starting with a letter or digit`);
  if (pkg.split('/')[0] === BUILTIN_LIBRARY.name) throw new Error(`the owner "${BUILTIN_LIBRARY.name}" is reserved for TopoTopo's own packages: name the package after its owner, you or your studio ("studio/${pkg.split('/')[1]}")`);
  return pkg;
}

/** The graph a new project starts with (graphs/main.json): a box, so that the graph project.json shows cooks. */
const STARTER = { description: 'A starting point: replace it with the project\'s graph.', nodes: { box: { type: 'box' } }, output: 'box' };

/**
 * Make a folder a project (`topotopo init`), in a library or anywhere: project.json (an id and title from the folder's
 * name, or from `name`; the graph it shows; "libraries": [], where the person lists the libraries it finds packages
 * in; and the package it is, `package`, "owner/name"), graphs/ with a starter graph when it holds none (so that the
 * graph project.json shows is there: graphs/main.json, a box), a .gitignore for the derived files and a .gitattributes
 * that keeps its versions and package copies byte for byte (both completed when they exist). In a folder that is a
 * project already, `package` sets the package it is (when it names none yet); without it, that is an error. Fails for a
 * folder inside another project.
 */
export function initProject(dir: string, o: { package?: string; name?: string } = {}): { dir: string; manifest: ProjectManifest; said: string } {
  const abs = path.resolve(dir);
  if (o.package !== undefined) ownPackageName(o.package);
  if (fs.existsSync(manifestFile(abs))) {
    if (o.package === undefined) throw new Error(`${abs} is a project already (${manifestFile(abs)}); --package owner/name sets the package it is`);
    const m = readManifest(abs);
    if (m.package === o.package) return { dir: abs, manifest: m, said: `project ${m.id} → ${abs} is the package ${m.package} already` };
    if (m.package) throw new Error(`project ${m.id} is the package ${m.package} already: a package keeps its name (to make it another package, change "package" in ${manifestFile(abs)} yourself)`);
    m.package = o.package;
    writeManifest(abs, m);
    projectRepoFiles(abs);
    return { dir: abs, manifest: m, said: `project ${m.id} → ${abs} is the package ${m.package} now` };
  }
  const outer = projectDirOf(path.dirname(abs));
  if (outer) throw new Error(`${abs} is inside the project ${outer}: a project cannot hold another`);
  const named = o.name ?? path.basename(abs);
  const id = slugify(named);
  if (!ID_RE.test(id)) throw new Error(`"${named}" gives no usable project id: name the folder with letters or digits`);
  // the graph it shows: main, unless graphs/ holds others and no main
  const graphs = path.join(abs, 'graphs');
  fs.mkdirSync(graphs, { recursive: true });
  const held = jsonFiles(graphs).map((f) => f.slice(0, -5)).filter((n) => NAME_RE.test(n));
  const graph = held.length && !held.includes('main') ? held[0] : 'main';
  if (!held.length) fs.writeFileSync(path.join(graphs, 'main.json'), JSON.stringify(STARTER, null, 2) + '\n');
  const raw = { id, title: named, graph, created: new Date().toISOString().slice(0, 10), ...(o.package !== undefined ? { package: o.package } : {}), libraries: [] };
  const manifest = parseManifest(raw, id);
  writeAtomic(manifestFile(abs), JSON.stringify(raw, null, 2) + '\n');
  projectRepoFiles(abs);
  return { dir: abs, manifest, said: `project ${id} → ${abs}${manifest.package ? ` (package ${manifest.package})` : ''}` };
}

/** Files an operating system leaves in folders, which say nothing about what a folder holds. */
const SYSTEM_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

/**
 * What a folder holds that TopoTopo does not make itself (its folders graphs/, assets/, exports/, inputs/), by name,
 * a folder's with a slash: none for a folder that holds nothing else, nothing at all, or does not exist yet. Files an
 * operating system leaves in folders do not count.
 */
export function notProjectFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => !(e.isDirectory() && PROJECT_FOLDERS.includes(e.name)) && !SYSTEM_FILES.has(e.name))
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
}

/** Where the MCP server works, and what it says about it (startProject). */
export interface ProjectStart {
  /** the folder to work in: the one given, or the root of the project it lies in */
  dir: string;
  /** what happened, for the server's log */
  log: string;
  /** what its first tool reply tells the agent (null: nothing to tell) */
  note: string | null;
}

/**
 * The MCP server's rule for its folder when it starts, named or not (scripts/preview.ts applies it too). A folder in
 * a project works in that project's root, which holds its graphs, assets and packages. A folder in no project that holds
 * nothing but what TopoTopo makes itself (graphs/, assets/, exports/, inputs/), or nothing at all, becomes a project
 * (initProject; `name`: its id and title, else the folder's name), so that its graphs use packages, TopoTopo's own among
 * them, as they come. A folder with anything else in it (a repository, a folder of the person's) stays as it is:
 * library {action:"init"} makes it a project when the person says so.
 */
export function startProject(dir: string, o: { name?: string } = {}): ProjectStart {
  const abs = path.resolve(dir);
  const outer = projectDirOf(abs);
  if (outer === abs) return { dir: abs, log: `the folder ${abs} is a project`, note: null };
  if (outer) return {
    dir: outer, log: `the folder ${abs} is in the project ${outer}: working in the project's folder`,
    note: `The server works in the project ${outer}, the project that holds the folder it was given (${abs}): a project's graphs, assets, inputs and packages are those of its own folder.`,
  };
  const other = notProjectFiles(abs);
  if (other.length) {
    const held = `${other.slice(0, 3).join(', ')}${other.length > 3 ? ` and ${other.length - 3} more` : ''}`;
    return {
      dir: abs, log: `the folder ${abs} is in no project and holds ${held}, which TopoTopo does not make: left as it is`,
      note: `The folder ${abs} is in no project, so its graphs cannot use packages, TopoTopo's own kits ("topotopo/nature/rock" …) among them: it holds ${held}, which TopoTopo does not make (it makes graphs/, assets/, exports/, inputs/), so the server left it as it is. Ask the person before making it a project; library {action:"init"} then does it (project.json, graphs/, .gitignore, .gitattributes).`,
    };
  }
  let made: ReturnType<typeof initProject>;
  try { made = initProject(abs, { name: o.name }); } catch (e: any) { return { dir: abs, log: `the folder ${abs} could not be made a project: ${e.message}`, note: `The folder ${abs} could not be made a project, so its graphs cannot use packages: ${e.message}` }; }
  return {
    dir: abs, log: `made the folder ${abs} a project (project.json): it held nothing but what TopoTopo makes itself`,
    note: `The folder ${abs} became a project, "${made.manifest.id}", when the server started (project.json, graphs/${made.manifest.graph}.json): it held nothing but TopoTopo's own folders. Its graphs use packages as they come, TopoTopo's own kits ("topotopo/nature/rock" …) among them. Next: build into graph "${made.manifest.graph}"; to publish the project as a package, library {action:"set", package:"<owner>/${made.manifest.id}"}; to use packages from another library, library {action:"set", libraries:[...]} when the person names it.`,
  };
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
 * and asset file's content, each input file's path, size and time, and the package lock (the versions it uses).
 */
export function bakeKey(dir: string, m: ProjectManifest): string {
  const h = createHash('sha256');
  h.update(`${BAKE_VERSION}|${PKG_VERSION}|${m.graph}|${JSON.stringify(m.bake)}\n`);
  for (const d of ['graphs', 'assets']) for (const f of jsonFiles(path.join(dir, d))) {
    h.update(`${d}/${f}\n`);
    try { h.update(fs.readFileSync(path.join(dir, d, f))); } catch { /* removed meanwhile */ }
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
