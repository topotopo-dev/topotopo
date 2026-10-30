// The user's config: the libraries and workspaces registered by name (one set of names for both), the web app's
// settings, and TopoTopo's built-in library.
//   ~/.topotopo/config.json (or $TOPOTOPO_CONFIG)   {libraries: [{name, path}], workspaces: [{name, path}], web: {port, cors: [origins]}}
//   $TOPOTOPO_LIBRARIES                              more libraries: name=path entries separated by path.delimiter
// TopoTopo carries a library of its own, its built-in library (BUILTIN_LIBRARY), which every package looks in without
// listing it. A package in a workspace finds packages in the workspace and the libraries its file lists; outside a
// workspace, in every registered library.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ID_RE } from './graph/scope.ts';
import { slugify } from './package.ts';

/** The web app's port when the config names none. */
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
export interface WebConfig {
  /** the config file read (or the one `library add` writes) */
  file: string;
  libraries: LibraryRef[];
  /** the workspaces (games) registered, by name: the web app's front page lists them */
  workspaces: LibraryRef[];
  web: { port: number; cors: string[] };
}

// ---------------------------------------------------------------------------------------------------------- config

export function configFile(): string {
  return path.resolve(process.env.TOPOTOPO_CONFIG ?? path.join(os.homedir(), '.topotopo', 'config.json'));
}

/** The user's config with defaults filled in; libraries from $TOPOTOPO_LIBRARIES come after the file's. */
export function loadConfig(): WebConfig {
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
  const g = raw.web ?? {};
  return {
    file, libraries, workspaces,
    web: {
      port: Number.isInteger(g.port) ? g.port : DEFAULT_PORT,
      cors: Array.isArray(g.cors) ? g.cors.filter((o: unknown) => typeof o === 'string') : [],
    },
  };
}

/** The config file as it is on disk (an object; {} for none), to change and write back keeping its other keys. */
function rawConfig(file: string): any {
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) ?? {}; } catch (e: any) { throw new Error(`${file}: ${e.message}`); }
}

function writeConfig(file: string, raw: any) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n');
}

/** A registered name of the other kind: workspaces and libraries share one set of names (a web app address /p/<name>/<id> means one thing). */
function nameTaken(raw: any, name: string, kind: 'library' | 'workspace'): string | null {
  const other = kind === 'library' ? raw.workspaces : raw.libraries;
  const hit = (Array.isArray(other) ? other : []).find((x: any) => x?.name === name);
  return hit ? `"${name}" is the name of a registered ${kind === 'library' ? 'workspace' : 'library'} (${hit.path}): workspaces and libraries share one set of names; give the ${kind} another name` : null;
}

/** Add (or re-point) a library in the config file, keeping its other keys. */
export function addLibrary(name: string, dir: string): WebConfig {
  if (!ID_RE.test(name)) throw new Error(`library name "${name}" must match ${ID_RE} (e.g. "${slugify(name) || 'game'}")`);
  if (name === BUILTIN_LIBRARY.name) throw new Error(builtinName(name, ''));
  const file = configFile();
  const raw = rawConfig(file);
  const taken = nameTaken(raw, name, 'library');
  if (taken) throw new Error(taken);
  const libs: LibraryRef[] = (Array.isArray(raw.libraries) ? raw.libraries : []).filter((l: LibraryRef) => l?.name !== name);
  libs.push({ name, path: path.resolve(dir) });
  raw.libraries = libs;
  fs.mkdirSync(path.resolve(dir), { recursive: true });
  writeConfig(file, raw);
  return loadConfig();
}

/** Remove a library from the config file (its folder stays as it is); throws for a name not registered. */
export function removeLibrary(name: string): WebConfig {
  const file = configFile();
  const raw = rawConfig(file);
  const libs: LibraryRef[] = Array.isArray(raw.libraries) ? raw.libraries : [];
  if (!libs.some((l) => l?.name === name)) throw new Error(`no library "${name}" is registered in ${file}${libs.length ? ` (it has ${libs.map((l) => l.name).join(', ')})` : ''}`);
  raw.libraries = libs.filter((l) => l?.name !== name);
  writeConfig(file, raw);
  return loadConfig();
}

/** Register (or re-point) a workspace in the config file by its name, keeping the file's other keys. */
export function addWorkspace(name: string, dir: string): WebConfig {
  if (!ID_RE.test(name)) throw new Error(`workspace name "${name}" must match ${ID_RE}`);
  if (name === BUILTIN_LIBRARY.name) throw new Error(`"${name}" is the name of TopoTopo's built-in library: give the workspace another name`);
  const file = configFile();
  const raw = rawConfig(file);
  const taken = nameTaken(raw, name, 'workspace');
  if (taken) throw new Error(taken);
  const list: LibraryRef[] = (Array.isArray(raw.workspaces) ? raw.workspaces : []).filter((w: LibraryRef) => w?.name !== name);
  list.push({ name, path: path.resolve(dir) });
  raw.workspaces = list;
  writeConfig(file, raw);
  return loadConfig();
}
