// A workspace: a folder tree (a game, an archviz job) whose folders holding a .topo file are its packages, found by
// scanning it (src/scan.ts). topotopo-workspace.json at its root names it, lists the shared libraries its packages use
// (registered names, or paths to folders outside the workspace), names the engine project the game is built with,
// whether its own packages are followed live for looking, and the one version of each package the whole workspace
// uses: its packages share one copy of it, in topotopo-packages/ beside the file (a package that publishes versions keeps
// its own copies: its uses are published with it).
//   {"name": "my-game", "libraries": ["props", "../shared/materials"],
//    "engine": {"type": "godot", "project": "../project.godot"}, "follow": false, "uses": {"topotopo/props": "1.1"}}
// Paths are written from the workspace's folder. Its preferred place is inside the engine's content folder (the Godot
// project folder or a folder in it, Unreal's Content/ or a folder in it), so Explorer, the engine and the web app show
// one tree and the engine imports each package's exports/ where they are. package.ts finds the workspace around a
// package (locate), the places it finds packages in (librariesFor) and where its copies are (copiesFor).
import fs from 'node:fs';
import path from 'node:path';
import { ID_RE } from './graph/scope.ts';
import { BUILTIN_LIBRARY, addWorkspace, loadConfig } from './config.ts';
import { WORKSPACE_FILE, WORKSPACE_PACKAGES, workspaceFlag, copiesFor, libraryEntry, locate, manifestAt, parseUses, program, resolveListed, slugify, within, workspaceRepoFiles, writeAtomic } from './package.ts';
import { gatherCopies } from './packages/registry.ts';
import { folderKey, forgetScans, scanTree } from './scan.ts';
import type { Scan } from './scan.ts';
import { detectEngine, engineTypeOf, godotIgnore, godotPresetReport, unrealSees } from './engines.ts';
import type { EngineLink } from './engines.ts';

export { WORKSPACE_FILE };
export type { EngineLink };

export interface WorkspaceManifest {
  name: string;
  /** the shared libraries its packages find packages in after the workspace itself: registered names, or paths from the workspace to folders outside it */
  libraries: string[];
  /** the engine project; "none": the person said there is none (init does not look for one again); null: none found yet */
  engine: EngineLink | 'none' | null;
  /** follow the workspace's own packages live (their working folders inside the workspace), for looking */
  follow: boolean;
  /** the version of each package its packages use: one shared copy for the whole game (topotopo-packages/) */
  uses: Record<string, string>;
}

/** What an "engine.assets" or --assets is told: the "engine:" export folder is gone. */
export const assetsGone = (what: string) =>
  `${what} is gone: an export stays in its package's exports/ folder; put the workspace inside the engine project (Godot: the project folder or a folder in it; Unreal: Content/ or a folder in it) and the engine imports the exports from there`;

/** topotopo-workspace.json checked and normalised; throws naming the problem. */
export function parseWorkspace(raw: any, fallbackName: string): WorkspaceManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${WORKSPACE_FILE} must be an object`);
  const name = raw.name === undefined ? fallbackName : raw.name;
  if (typeof name !== 'string' || !ID_RE.test(name)) throw new Error(`${WORKSPACE_FILE}: "name" must be lower-case letters, digits, - and _ ("my-game"), got ${JSON.stringify(name)}`);
  const libraries = raw.libraries ?? [];
  if (!Array.isArray(libraries) || libraries.some((l: unknown) => typeof l !== 'string')) throw new Error(`${WORKSPACE_FILE}: "libraries" must be a list of registered library names and paths from the workspace to folders outside it ("../shared/props")`);
  let engine: WorkspaceManifest['engine'] = null;
  if (raw.engine === 'none') engine = 'none';
  else if (raw.engine !== undefined && raw.engine !== null) {
    const e = raw.engine;
    if (e && typeof e === 'object' && e.assets !== undefined) throw new Error(`${WORKSPACE_FILE}: ${assetsGone('"engine.assets"')}; remove "assets"`);
    if (!e || typeof e !== 'object' || (e.type !== 'godot' && e.type !== 'unreal') || typeof e.project !== 'string' || !e.project)
      throw new Error(`${WORKSPACE_FILE}: "engine" must be {"type": "godot" | "unreal", "project": "../project.godot"} or "none"`);
    engine = { type: e.type, project: e.project };
  }
  if (raw.follow !== undefined && typeof raw.follow !== 'boolean') throw new Error(`${WORKSPACE_FILE}: "follow" must be true or false`);
  const uses = parseUses(raw.uses, WORKSPACE_FILE);
  return { name, libraries: [...new Set(libraries.map((l: string) => l.trim().replace(/\\/g, '/')))], engine, follow: raw.follow === true, uses };
}

/** The workspace file of `dir` (the workspace's folder), checked. */
export function readWorkspace(dir: string): WorkspaceManifest {
  const file = path.join(dir, WORKSPACE_FILE);
  let raw: any;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e: any) { throw new Error(`${file}: ${e.message}`); }
  try { return parseWorkspace(raw, slugify(path.basename(path.resolve(dir))) || 'workspace'); } catch (e: any) { throw new Error(`${file}: ${e.message.replace(`${WORKSPACE_FILE}: `, '')}`); }
}

export function writeWorkspace(dir: string, m: WorkspaceManifest) {
  const out: Record<string, unknown> = { name: m.name, libraries: m.libraries };
  if (m.engine) out.engine = m.engine === 'none' ? 'none' : { type: m.engine.type, project: m.engine.project };
  if (m.follow) out.follow = true;
  if (Object.keys(m.uses).length) out.uses = m.uses;
  writeAtomic(path.join(dir, WORKSPACE_FILE), JSON.stringify(out, null, 2) + '\n');
  forgetScans();
}

/** The engine project file a workspace names, absolute; null for none. */
export const engineFile = (ws: string, m: WorkspaceManifest) => (m.engine && m.engine !== 'none' ? path.resolve(ws, m.engine.project) : null);

/** The packages of a workspace (src/scan.ts), the folder of its own engine project scanned like any other. */
export function scanWorkspace(ws: string, m: WorkspaceManifest = readWorkspace(ws)): Scan {
  return scanTree(m.name, ws, { engine: engineFile(ws, m) });
}

const rel = (from: string, to: string) => path.relative(path.resolve(from), path.resolve(to)).split(path.sep).join('/') || '.';

/** "godot:game/project.godot" (or a bare path whose file name says the engine) as an engine link; the path may lead upward ("../project.godot"). */
export function parseEngineArg(arg: string, dir: string): EngineLink {
  const m = /^(godot|unreal):(.+)$/i.exec(arg.trim());
  const file = (m ? m[2] : arg).trim().replace(/\\/g, '/');
  const type = m ? (m[1].toLowerCase() as EngineLink['type']) : engineTypeOf(file);
  if (!type) throw new Error(`--engine "${arg}": write godot:<path to project.godot>, unreal:<path to the .uproject> or none`);
  const abs = path.resolve(dir, file);
  if (!fs.statSync(abs, { throwIfNoEntry: false })?.isFile()) throw new Error(`--engine "${arg}": no file ${abs}`);
  return { type, project: rel(dir, abs) };
}

/**
 * The name an engine project gives itself, as a workspace name: project.godot's config/name, a .uproject's file name;
 * null when it has none.
 */
export function engineProjectName(dir: string, e: EngineLink): string | null {
  const file = path.resolve(dir, e.project);
  if (e.type === 'unreal') return slugify(path.basename(file).replace(/\.uproject$/i, '')) || null;
  try {
    const m = /^config\/name\s*=\s*"([^"]*)"/m.exec(fs.readFileSync(file, 'utf8'));
    return m ? slugify(m[1]) || null : null;
  } catch { return null; }
}

/**
 * A name a workspace takes: refused when it is TopoTopo's built-in library's or a registered library's (workspaces and
 * libraries share one set of names, so a web app address /p/<name>/<id> means one thing).
 */
export function checkWorkspaceName(name: string, how = '--name <another name>', dir?: string) {
  if (name === BUILTIN_LIBRARY.name) throw new Error(`"${name}" is the name of TopoTopo's built-in library: give the workspace another name (${how})`);
  let cfg;
  try { cfg = loadConfig(); } catch { return; }
  const lib = cfg.libraries.find((l) => l.name === name);
  if (lib) throw new Error(`"${name}" is the name of a registered library (${lib.path}): workspaces and libraries share one set of names; give the workspace another name (${how})`);
  const other = dir ? cfg.workspaces.find((w) => w.name === name && folderKey(w.path) !== folderKey(dir)) : undefined;
  if (other) throw new Error(`"${name}" is the name of another registered workspace (${other.path}): give the workspace another name (${how})`);
}

/**
 * The entry a workspace's "libraries" gets for a library a person names (workspace library add, workspace init
 * --library): a folder, as the person sees it (relative to `cwd`), written as its path from the workspace ("../shared");
 * else a registered library's name. Refuses, worded for the workspace file: a folder inside the workspace or holding it
 * (its packages are found by themselves), a package's folder, a folder on another drive, a name not registered.
 */
export function workspaceLibraryEntry(ws: string, given: string, cwd = process.cwd()): string {
  const file = path.join(ws, WORKSPACE_FILE);
  const g = given.trim();
  if (g === BUILTIN_LIBRARY.name) throw new Error(`TopoTopo's built-in library is looked in by every package without being listed: ${file} "libraries" lists shared libraries only`);
  const abs = path.resolve(cwd, g);
  const isFolder = !!fs.statSync(abs, { throwIfNoEntry: false })?.isDirectory();
  if (isFolder && (!ID_RE.test(g) || !registeredLibrary(g))) {
    let at: ReturnType<typeof manifestAt> = null;
    try { at = manifestAt(abs); } catch { /* two manifests: a package's folder all the same */ }
    if (at) throw new Error(`${abs} is a package's folder (${path.basename(at.file)}), not a library: ${file} "libraries" lists the folders of shared libraries; give the library's folder, or its registered name`);
    if (within(abs, ws)) throw new Error(`${abs} is inside the workspace (${ws}): its packages are found by themselves; ${file} "libraries" lists shared libraries outside it`);
    if (within(ws, abs)) throw new Error(`${abs} holds the workspace (${ws}): ${file} "libraries" lists shared libraries outside it, and the workspace's own packages are found by themselves`);
    const r = path.relative(ws, abs).split(path.sep).join('/');
    if (path.isAbsolute(r) || /^[A-Za-z]:/.test(r)) throw new Error(`${abs} is on another drive than the workspace: register it (${program()} library add <name> ${abs}) and list it by its name`);
    return r.startsWith('.') ? r : `./${r}`;
  }
  const k = libraryEntry(g);
  if ('error' in k) throw new Error(`${isFolder ? '' : `no folder ${abs}, and `}${k.error}`);
  if ('path' in k) throw new Error(`no folder ${abs}: give the library's folder, or its registered name`);
  const lib = registeredLibrary(g);
  if (!lib) {
    let names = 'none are registered';
    try { names = loadConfig().libraries.map((l) => l.name).join(', ') || names; } catch { /* said as none */ }
    throw new Error(`"${g}" is no folder here and no registered library (${names}): ${file} "libraries" lists a registered library by its name; register it first (${program()} library add ${g} <folder>), or give the library's folder`);
  }
  if (within(lib.path, ws)) throw new Error(`library "${g}" (${lib.path}) is inside the workspace: its packages are found by themselves; ${file} "libraries" lists shared libraries outside it`);
  if (within(ws, lib.path)) throw new Error(`library "${g}" (${lib.path}) holds the workspace: ${file} "libraries" lists shared libraries outside it`);
  return g;
}

const registeredLibrary = (name: string) => { try { return loadConfig().libraries.find((l) => l.name === name) ?? null; } catch { return null; } };

/** The workspace around a folder, or an error saying there is none and how one is made. */
function workspaceOf(start: string): string {
  const at = locate(start);
  if (at.outside) throw new Error(`${path.resolve(start)} is in no workspace: the workspace ${at.outside.workspace} does not look in it (${at.outside.why}); outside a workspace every registered library counts`);
  if (!at.workspace) throw new Error(`${path.resolve(start)} is in no workspace: ${program()} workspace init <folder> makes one; outside a workspace every registered library counts`);
  return at.workspace;
}

/**
 * Add a shared library to the workspace's "libraries", or remove one (`topotopo workspace library add|remove`, MCP
 * workspace {action:"libraries"}): the workspace around `at` (default: the current folder). A library is given as a
 * folder, as the person sees it from `cwd`, or by its registered name. Changes the list only. Says what it lists now.
 */
export function workspaceLibrary(op: 'add' | 'remove', given: string, o: { at?: string; cwd?: string } = {}): string {
  const cwd = o.cwd ?? process.cwd();
  const ws = workspaceOf(o.at ?? cwd);
  const m = readWorkspace(ws), file = path.join(ws, WORKSPACE_FILE);
  // entries are one library when they name one folder: a registered name and a path to its folder alike
  const folderOf = (e: string): string | null => {
    const k = libraryEntry(e);
    return 'path' in k ? folderKey(path.resolve(ws, k.path)) : 'name' in k && registeredLibrary(e) ? folderKey(registeredLibrary(e)!.path) : null;
  };
  if (op === 'add') {
    const entry = workspaceLibraryEntry(ws, given, cwd), at = folderOf(entry);
    const have = m.libraries.find((e) => e === entry || (at !== null && folderOf(e) === at));
    if (have) return `${file} lists "${entry}" already${have !== entry ? ` (as "${have}", the same folder)` : ''}\n${librariesLine(ws, m)}`;
    m.libraries.push(entry);
  } else {
    const g = given.trim(), reg = ID_RE.test(g) ? registeredLibrary(g) : null;
    const at = folderKey(reg ? reg.path : path.resolve(cwd, g));
    const gone = m.libraries.filter((e) => e === g || e === g.replace(/\\/g, '/') || folderOf(e) === at);
    if (!gone.length) throw new Error(`${file} does not list "${given}": it lists ${m.libraries.map((e) => `"${e}"`).join(', ') || 'no libraries'}`);
    m.libraries = m.libraries.filter((e) => !gone.includes(e));
  }
  writeWorkspace(ws, m);
  return `the workspace "${m.name}" lists ${m.libraries.length ? m.libraries.map((e) => `"${e}"`).join(', ') : 'no libraries'} in ${file} "libraries" now\n${librariesLine(ws, m)}`;
}

/**
 * The shared libraries the workspace around a folder lists and where its packages find packages (MCP workspace
 * {action:"libraries"}); outside a workspace, that every registered library counts.
 */
export function workspaceLibrariesText(start: string): string {
  const ws = locate(start).workspace;
  if (!ws) {
    let names = 'none is registered';
    try { names = loadConfig().libraries.map((l) => `"${l.name}"`).join(', ') || names; } catch { /* said as none */ }
    return `${path.resolve(start)} is in no workspace: its package finds packages in every registered library (${names}), then in TopoTopo's built-in library; ${program()} workspace init <folder> makes a workspace, whose ${WORKSPACE_FILE} lists the shared libraries its packages use`;
  }
  const m = readWorkspace(ws);
  return `the workspace "${m.name}" lists ${m.libraries.length ? m.libraries.map((e) => `"${e}"`).join(', ') : 'no libraries'} in ${path.join(ws, WORKSPACE_FILE)} "libraries"
${librariesLine(ws, m)}`;
}

/** Where a workspace's packages find packages, in a line, and what is wrong with its list. */
function librariesLine(ws: string, m: WorkspaceManifest): string {
  const libs = resolveListed(ws, m.libraries);
  return [
    `its packages find packages in the workspace itself, then in ${libs.libs.length ? libs.libs.map((l) => `library "${l.name}" (${l.root})`).join(', ') : 'no shared library'}, then in TopoTopo's built-in library`,
    ...libs.problems.map((p) => `problem: ${p}`),
  ].join('\n');
}

export interface InitWorkspaceOptions {
  name?: string;
  /** "godot:<path>", "unreal:<path>" or "none" (default: the engine project at or above the folder, else below it) */
  engine?: string;
  /** shared libraries to list when the workspace is made: folders (from `cwd`) or registered names */
  libraries?: string[];
  follow?: boolean;
  /** refused: the "engine:" export folder is gone */
  assets?: string;
  /** where folders given in `libraries` are read from (default: the current folder) */
  cwd?: string;
}

/**
 * Make `dir` a workspace: topotopo-workspace.json with its name (the engine project's, else the folder's), the shared
 * libraries given and the engine project (given, or found: the nearest at or above the folder, else below it; "none"
 * for none, kept). A folder that is a workspace already is changed only where an option says so (its name, engine and
 * follow; --library is for making one). It then says what Unreal will not see, the packages outside the engine
 * project's folder, the Godot export presets that would ship TopoTopo's files; keeps Godot's importer out of the
 * packages' working folders (.gdignore); and moves the copies of the packages inside into the workspace's one copy.
 */
export function initWorkspace(dir: string, o: InitWorkspaceOptions = {}): { dir: string; manifest: WorkspaceManifest; text: string } {
  const abs = path.resolve(dir);
  if (o.assets !== undefined) throw new Error(assetsGone('--assets'));
  if (!fs.statSync(abs, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${abs} is no folder`);
  const had = fs.existsSync(path.join(abs, WORKSPACE_FILE));
  const m: WorkspaceManifest = had ? readWorkspace(abs) : { name: slugify(path.basename(abs)) || 'workspace', libraries: [], engine: null, follow: false, uses: {} };
  if (had && o.libraries?.length) throw new Error(`--library is for making a workspace, and ${abs} is the workspace "${m.name}" already: ${program()} workspace library add <name or folder>${workspaceFlag(abs, o.cwd)} lists a library for it`);
  if (o.name !== undefined) {
    if (!ID_RE.test(o.name)) throw new Error(`--name "${o.name}": lower-case letters, digits, - and _ ("my-game")`);
    m.name = o.name;
  }
  let found = '';
  if (o.engine === 'none') m.engine = 'none';
  else if (o.engine) m.engine = parseEngineArg(o.engine, abs);
  else if (!had || m.engine === null) {
    const d = detectEngine(abs);
    if (d) {
      m.engine = d.link;
      found = d.below.length ? (d.below.length > 1 ? ` (found below the workspace, ${d.below.length}: ${d.below.map((e) => e.project).join(', ')}; --engine picks another)` : ' (found below the workspace)') : ' (found at or above the workspace)';
    }
  }
  // a new workspace is named after its engine project when that has a name (a checkout's folder may be named otherwise)
  if (!had && o.name === undefined && m.engine && m.engine !== 'none') m.name = engineProjectName(abs, m.engine) ?? m.name;
  if (!had || o.name !== undefined) checkWorkspaceName(m.name, o.name === undefined ? `--name <another name>: it took "${m.name}" from ${m.engine && m.engine !== 'none' ? 'its engine project' : 'its folder'}` : '--name <another name>', abs);
  for (const l of o.libraries ?? []) {
    const entry = workspaceLibraryEntry(abs, l, o.cwd);
    if (!m.libraries.includes(entry)) m.libraries.push(entry);
  }
  if (o.follow !== undefined) m.follow = o.follow;
  writeWorkspace(abs, m);
  workspaceRepoFiles(abs);
  // a registered workspace renamed is registered again under its new name (the old one would name nothing)
  let registered = '';
  try {
    const was = loadConfig().workspaces.find((w) => folderKey(w.path) === folderKey(abs));
    if (was && was.name !== m.name) { addWorkspace(m.name, abs); registered = `registered again under its new name "${m.name}" (it was "${was.name}")`; }
  } catch (e: any) { registered = `still registered under its old name: ${e.message}`; }
  const scan = scanWorkspace(abs, m);
  const engineLines: string[] = [];
  const project = engineFile(abs, m);
  if (m.engine && m.engine !== 'none' && project) {
    if (m.engine.type === 'unreal' && !unrealSees(abs, project))
      engineLines.push(`  Unreal will not see this workspace: it imports only what lies under the project's Content/ folder (or a plugin's Content/); move the workspace there, so the engine imports each package's exports/`);
    const home = path.dirname(project);
    if (within(home, abs) && path.resolve(home) !== abs) {
      const outside = scan.packages.filter((p) => !within(p.dir, home)).map((p) => p.rel);
      if (outside.length) engineLines.push(`  packages outside the engine project's folder (${rel(abs, home)}/), whose exports the engine does not import: ${outside.slice(0, 20).join(', ')}${outside.length > 20 ? ` and ${outside.length - 20} more` : ''}`);
    }
    if (m.engine.type === 'godot') engineLines.push(...godotPresetReport(home).map((l) => `  ${l}`));
  }
  // Godot imports none of TopoTopo's working folders (versions/, packages/, inputs/)
  const ignored = scan.packages.flatMap((p) => godotIgnore(p.dir));
  // the packages inside that kept their own copies share the workspace's now
  const gathered = gatherCopies(abs);
  const libs = resolveListed(abs, m.libraries);
  const text = [
    `${had ? 'updated' : 'made'} the workspace "${m.name}" (${path.join(abs, WORKSPACE_FILE)})${registered ? `; ${registered}` : ''}`,
    `engine: ${m.engine === 'none' ? 'none (kept: --engine godot:<path> or unreal:<path> names one)' : m.engine ? `${m.engine.type} ${m.engine.project}${found}` : `none found (--engine godot:<path>|unreal:<path>|none)`}`,
    ...engineLines,
    `shared libraries: ${libs.libs.length ? libs.libs.map((l) => l.entry).join(', ') : `none yet (${program()} workspace library add <name or folder>${workspaceFlag(abs, o.cwd)} lists one)`}; its packages find each other by themselves, then look in these, then in TopoTopo's built-in library`,
    ...libs.problems.map((p) => `  problem: ${p}`),
    `packages: ${scan.packages.length}${scan.workspaces.length ? `; other workspaces inside, not scanned: ${scan.workspaces.map((w) => rel(abs, w)).join(', ')}` : ''}`,
    `follow its own packages live: ${m.follow ? 'on (their working folders inside the workspace show in the viewer and renders, for looking; exports use the published versions)' : 'off'}`,
    ...(ignored.length ? [`kept Godot's importer out of the packages' working folders: added ${ignored.length} .gdignore file${ignored.length === 1 ? '' : 's'} (versions/, packages/, inputs/)`] : []),
    ...gathered,
  ].join('\n');
  return { dir: abs, manifest: m, text };
}

/**
 * The workspace around a folder in a few lines: its name and file, its engine project, the shared libraries it lists
 * (and what is wrong with an entry), whether it follows its own packages, and the packages inside it (scanned) with
 * what they publish and use. Throws when the folder is in no workspace, saying how one is made.
 */
export function workspaceText(start: string): string {
  const ws = workspaceOf(start);
  const m = readWorkspace(ws);
  const libs = resolveListed(ws, m.libraries);
  const scan = scanWorkspace(ws, m);
  const lines = [
    `workspace "${m.name}" (${path.join(ws, WORKSPACE_FILE)})`,
    `engine: ${m.engine === 'none' ? 'none' : m.engine ? `${m.engine.type} ${m.engine.project}` : 'none found'}`,
    `shared libraries: ${libs.libs.length ? libs.libs.map((l) => `${l.entry} (${l.root}${l.name !== l.entry ? `, named "${l.name}"` : ''})`).join(', ') : 'none'}; its packages find each other by themselves, then look in these, then in TopoTopo's built-in library`,
    `follow its own packages live: ${m.follow ? 'on (the working folders of its own packages, for looking; exports use the published versions)' : 'off'}`,
    `uses: ${Object.keys(m.uses).length ? Object.entries(m.uses).map(([k, v]) => `${k} ${v}`).join(', ') : 'nothing yet'}; one copy for every package inside (${WORKSPACE_PACKAGES}/), the packages that publish keep their own`,
    `packages: ${scan.packages.length}`,
    ...scan.packages.slice(0, 40).map((p) => {
      const own = copiesFor(p.dir).workspace === null;
      const uses = Object.entries(p.manifest.uses);
      const listed = uses.map(([k, v]) => `${k} ${v}`).join(', ');
      return `  ${p.rel}${p.manifest.name ? `  package ${p.manifest.name}` : ''}${!uses.length ? '' : own ? `  uses ${listed} (its own copies)` : `  its manifest still uses ${listed}: ${program()} workspace init ${ws} moves them into the workspace's`}`;
    }),
    ...(scan.packages.length > 40 ? [`  … ${scan.packages.length - 40} more`] : []),
    ...(scan.workspaces.length ? [`other workspaces inside, not scanned: ${scan.workspaces.map((w) => rel(ws, w)).join(', ')}`] : []),
  ];
  const problems = [...libs.problems, ...scan.problems];
  if (problems.length) lines.push(`problems: ${problems.length}`, ...problems.map((x) => `  ${x}`));
  return lines.join('\n');
}
