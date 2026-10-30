// The user's config: the libraries registered by name and the Gallery's settings, and TopoTopo's built-in library.
//   ~/.topotopo/config.json (or $TOPOTOPO_CONFIG)   {libraries: [{name, path}], workspaces: [{name, path}], gallery: {port, cors: [origins]}}
//   $TOPOTOPO_LIBRARIES                              more libraries: name=path entries separated by path.delimiter
// TopoTopo carries a library of its own, its built-in library (BUILTIN_LIBRARY), which every package looks in without
// listing it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ID_RE } from './graph/scope.ts';
import { slugify } from './package.ts';

/** The Gallery's port when the config names none. */
export const DEFAULT_PORT = 7340;

export interface LibraryRef { name: string; path: string }

/**
 * TopoTopo's built-in library: TopoTopo's own packages (owner "topotopo"), shipped in library/ beside src/ and dist/.
 * Every package looks in it without listing it, and no other library takes its name. Its folder <name> holds the
 * versions of topotopo/<name> (versions/<version>/); in TopoTopo's repository it is the package's working folder as well,
 * a package, while an installed TopoTopo ships the versions alone (src/packages/registry.ts reads it).
 */
export const BUILTIN_LIBRARY: LibraryRef = { name: 'topotopo', path: fileURLToPath(new URL('../library', import.meta.url)) };
const builtinName = (name: string, from: string) => `${from}"${name}" is the name of TopoTopo's built-in library, which every package looks in: give this library another name`;
export interface GalleryConfig {
  /** the config file read (or the one `library add` writes) */
  file: string;
  libraries: LibraryRef[];
  /** the workspaces (games) registered, by name: the Gallery's hub lists them */
  workspaces: LibraryRef[];
  gallery: { port: number; cors: string[] };
}

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
  const workspaces: LibraryRef[] = [];
  for (const w of Array.isArray(raw.workspaces) ? raw.workspaces : []) {
    if (!w || typeof w.name !== 'string' || typeof w.path !== 'string' || !ID_RE.test(w.name)) throw new Error(`${file}: each workspace is {"name": "...", "path": "..."} (a name of lower-case letters, digits, - and _)`);
    if (!workspaces.some((x) => x.name === w.name)) workspaces.push({ name: w.name, path: path.resolve(path.dirname(file), w.path) });
  }
  const g = raw.gallery ?? {};
  return {
    file, libraries, workspaces,
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

/** Register (or re-point) a workspace in the config file by its name, keeping the file's other keys. */
export function addWorkspace(name: string, dir: string): GalleryConfig {
  if (!ID_RE.test(name)) throw new Error(`workspace name "${name}" must match ${ID_RE}`);
  const file = configFile();
  let raw: any = {};
  if (fs.existsSync(file)) raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list: LibraryRef[] = (Array.isArray(raw.workspaces) ? raw.workspaces : []).filter((w: LibraryRef) => w?.name !== name);
  list.push({ name, path: path.resolve(dir) });
  raw.workspaces = list;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
  return loadConfig();
}
