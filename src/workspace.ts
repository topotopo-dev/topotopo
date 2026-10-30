// A workspace: a game (or any 3D project) that holds TopoTopo packages. topotopo-workspace.json at its root names the
// libraries every package inside looks in (after the package's own), the engine project the game is built with,
// whether the game's own packages are followed live for looking, and the one version of each package the whole game
// uses: its packages share one copy of it, in topotopo-packages/ beside the file (a package that publishes versions keeps
// its own copies: its uses are published with it).
//   {"name": "raven-hunt", "libraries": ["./art/topotopo"],
//    "engine": {"type": "godot", "project": "game/project.godot", "assets": "game/assets/topotopo"}, "follow": false,
//    "uses": {"topotopo/props": "1.1"}}
// Paths are written from the workspace's folder. package.ts finds the workspace around a package (locate), the
// libraries it lists (librariesFor) and where its copies are (copiesFor).
import fs from 'node:fs';
import path from 'node:path';
import { ID_RE } from './graph/scope.ts';
import { WORKSPACE_FILE, WORKSPACE_PACKAGES, copiesFor, libraryEntry, locate, parseUses, program, resolveLibraries, slugify, workspaceRepoFiles, writeAtomic } from './package.ts';
import { gatherCopies } from './packages/registry.ts';
import { scanLibrary } from './gallery/library.ts';

export { WORKSPACE_FILE };

/** The game engine a workspace builds with: its project file, and the folder exports may go to. */
export interface EngineLink {
  type: 'godot' | 'unreal';
  /** the engine's project file, from the workspace (game/project.godot, Game.uproject) */
  project: string;
  /** where exports may land in the engine project, from the workspace ("" = not set) */
  assets: string;
}

export interface WorkspaceManifest {
  name: string;
  /** where its packages look for packages after their own libraries: paths from the workspace, or registered names */
  libraries: string[];
  engine: EngineLink | null;
  /** follow the workspace's own packages live (their working folders inside the workspace), for looking */
  follow: boolean;
  /** the version of each package its packages use: one shared copy for the whole game (topotopo-packages/) */
  uses: Record<string, string>;
}

const ENGINE_FILES: [RegExp, EngineLink['type']][] = [[/^project\.godot$/, 'godot'], [/\.uproject$/i, 'unreal']];
/** Folders an engine search never enters. */
const SKIP = new Set(['node_modules', '.git', '.godot', '.import', 'Binaries', 'Intermediate', 'Saved', 'DerivedDataCache', 'versions', 'packages']);

/** topotopo-workspace.json checked and normalised; throws naming the problem. */
export function parseWorkspace(raw: any, fallbackName: string): WorkspaceManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${WORKSPACE_FILE} must be an object`);
  const name = raw.name === undefined ? fallbackName : raw.name;
  if (typeof name !== 'string' || !ID_RE.test(name)) throw new Error(`${WORKSPACE_FILE}: "name" must be lower-case letters, digits, - and _ ("raven-hunt"), got ${JSON.stringify(name)}`);
  const libraries = raw.libraries ?? [];
  if (!Array.isArray(libraries) || libraries.some((l: unknown) => typeof l !== 'string')) throw new Error(`${WORKSPACE_FILE}: "libraries" must be a list of paths from the workspace ("./art/topotopo") and registered library names`);
  let engine: EngineLink | null = null;
  if (raw.engine !== undefined && raw.engine !== null) {
    const e = raw.engine;
    if (!e || typeof e !== 'object' || (e.type !== 'godot' && e.type !== 'unreal') || typeof e.project !== 'string' || !e.project)
      throw new Error(`${WORKSPACE_FILE}: "engine" must be {"type": "godot" | "unreal", "project": "game/project.godot", "assets": "game/assets/topotopo"}`);
    if (e.assets !== undefined && typeof e.assets !== 'string') throw new Error(`${WORKSPACE_FILE}: "engine.assets" must be a folder from the workspace`);
    engine = { type: e.type, project: e.project, assets: e.assets ?? '' };
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
  if (m.engine) out.engine = { type: m.engine.type, project: m.engine.project, ...(m.engine.assets ? { assets: m.engine.assets } : {}) };
  if (m.follow) out.follow = true;
  if (Object.keys(m.uses).length) out.uses = m.uses;
  writeAtomic(path.join(dir, WORKSPACE_FILE), JSON.stringify(out, null, 2) + '\n');
}

/** The engine projects below a folder (project.godot, *.uproject), nearest first, at most 4 levels down. */
export function findEngines(dir: string): EngineLink[] {
  const out: { link: EngineLink; depth: number }[] = [];
  const walk = (d: string, depth: number) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isFile()) for (const [re, type] of ENGINE_FILES) if (re.test(e.name)) out.push({ link: { type, project: rel(dir, path.join(d, e.name)), assets: '' }, depth });
    }
    if (depth >= 4) return;
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name)) walk(path.join(d, e.name), depth + 1);
  };
  walk(path.resolve(dir), 0);
  return out.sort((a, b) => a.depth - b.depth || (a.link.project < b.link.project ? -1 : 1)).map((x) => x.link);
}

const rel = (from: string, to: string) => path.relative(path.resolve(from), path.resolve(to)).split(path.sep).join('/') || '.';

/**
 * The folder "engine:" export paths write into, for a folder inside a workspace: the engine project's assets folder its
 * file names (engine.assets). Throws saying how to set one.
 */
export function engineAssetsFor(start: string): string {
  const ws = locate(start).workspace;
  const how = (at: string) => `${program()} workspace init ${at} --engine godot:<path to project.godot> --assets <folder inside the engine project>`;
  const what = '"engine:" export paths write into the game engine\'s assets folder';
  if (!ws) throw new Error(`${what}, and ${path.resolve(start)} is in no workspace: ${how('<the game\'s folder>')} makes one`);
  const m = readWorkspace(ws);
  if (!m.engine) throw new Error(`${what}, and the workspace "${m.name}" names no engine project: ${how(ws)}`);
  if (!m.engine.assets) throw new Error(`${what}, and the workspace "${m.name}" names none for ${m.engine.project}: ${program()} workspace init ${ws} --assets <folder inside ${path.posix.dirname(m.engine.project)}>`);
  return path.resolve(ws, m.engine.assets);
}

/** Where an engine project imports a folder from: "res://assets/topotopo" for Godot, "Content/TopoTopo" for Unreal. */
export function engineAddress(e: EngineLink, folder: string): string {
  const rel = path.posix.relative(path.posix.dirname(e.project), folder.replace(/\\/g, '/'));
  return e.type === 'godot' ? `res://${rel}` : rel;
}

/** "godot:game/project.godot" (or a bare path whose file name says the engine) as an engine link. */
export function parseEngineArg(arg: string, dir: string): EngineLink {
  const m = /^(godot|unreal):(.+)$/i.exec(arg.trim());
  const file = (m ? m[2] : arg).trim().replace(/\\/g, '/');
  const type = m ? (m[1].toLowerCase() as EngineLink['type']) : ENGINE_FILES.find(([re]) => re.test(path.basename(file)))?.[1];
  if (!type) throw new Error(`--engine "${arg}": write godot:<path to project.godot> or unreal:<path to the .uproject>`);
  const abs = path.resolve(dir, file);
  if (!fs.statSync(abs, { throwIfNoEntry: false })?.isFile()) throw new Error(`--engine "${arg}": no file ${abs}`);
  return { type, project: rel(dir, abs), assets: '' };
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

export interface InitWorkspaceOptions { name?: string; engine?: string | 'none'; libraries?: string[]; assets?: string; follow?: boolean }

/**
 * Make `dir` (a game's root) a workspace: topotopo-workspace.json with its name, the libraries given and the engine
 * package (given, or the one found below the folder; "none" for none). A folder that is a workspace already is changed
 * only where an option says so. Returns what it wrote and says it.
 */
export function initWorkspace(dir: string, o: InitWorkspaceOptions = {}): { dir: string; manifest: WorkspaceManifest; text: string } {
  const abs = path.resolve(dir);
  if (!fs.statSync(abs, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${abs} is no folder`);
  const had = fs.existsSync(path.join(abs, WORKSPACE_FILE));
  const m: WorkspaceManifest = had ? readWorkspace(abs) : { name: slugify(path.basename(abs)) || 'workspace', libraries: [], engine: null, follow: false, uses: {} };
  if (o.name !== undefined) {
    if (!ID_RE.test(o.name)) throw new Error(`--name "${o.name}": lower-case letters, digits, - and _ ("raven-hunt")`);
    m.name = o.name;
  }
  for (const l of o.libraries ?? []) {
    const k = libraryEntry(l.trim());
    if ('error' in k) throw new Error(`--library: ${k.error}`);
    if (!m.libraries.includes(l.trim())) m.libraries.push(l.trim());
  }
  let found = '';
  if (o.engine === 'none') m.engine = null;
  else if (o.engine) m.engine = parseEngineArg(o.engine, abs);
  else if (!had || !m.engine) {
    const all = findEngines(abs);
    if (all.length) { m.engine = all[0]; found = all.length > 1 ? ` (found ${all.length}: ${all.map((e) => e.project).join(', ')}; --engine picks another)` : ' (found)'; }
  }
  // a new workspace is named after its engine project when that has a name (a checkout's folder may be named otherwise)
  if (!had && o.name === undefined && m.engine) m.name = engineProjectName(abs, m.engine) ?? m.name;
  if (o.assets !== undefined) {
    if (!m.engine) throw new Error('--assets needs an engine project: --engine godot:<path to project.godot>');
    const assets = o.assets.trim().replace(/\\/g, '/').replace(/\/+$/, '');
    // the engine imports only what lies inside its project's folder
    const home = path.posix.dirname(m.engine.project), rel = path.posix.relative(home, assets);
    if (!assets || rel.startsWith('..') || path.posix.isAbsolute(rel)) throw new Error(`--assets "${o.assets}" must be a folder inside the engine project's folder (${home === '.' ? 'the workspace' : home}), written from the workspace: ${m.engine.type === 'godot' ? 'Godot' : 'Unreal'} imports only what lies there`);
    m.engine.assets = assets;
  }
  if (o.follow !== undefined) m.follow = o.follow;
  writeWorkspace(abs, m);
  workspaceRepoFiles(abs);
  // the packages inside that kept their own copies share the workspace's now
  const gathered = gatherCopies(abs);
  const text = [
    `${had ? 'updated' : 'made'} the workspace "${m.name}" (${path.join(abs, WORKSPACE_FILE)})`,
    `engine: ${m.engine ? `${m.engine.type} ${m.engine.project}${found}${m.engine.assets ? `, "engine:" exports go to ${m.engine.assets} (${engineAddress(m.engine, m.engine.assets)})` : ''}` : 'none'}`,
    `libraries: ${m.libraries.length ? m.libraries.join(', ') : 'none yet (topotopo workspace init --library <folder or name>)'}; every package inside looks in them after its own`,
    `follow its own packages live: ${m.follow ? 'on (their working folders inside the workspace show in the viewer and renders, for looking; exports use the published versions)' : 'off'}`,
    ...gathered,
  ].join('\n');
  return { dir: abs, manifest: m, text };
}

/**
 * The workspace around a folder in a few lines: its name and file, its engine project, the libraries it lists (and what
 * is wrong with an entry), whether it follows its own packages, and the packages inside it with the packages they are
 * and use. Throws when the folder is in no workspace, saying how one is made.
 */
export function workspaceText(start: string): string {
  const ws = locate(start).workspace;
  if (!ws) throw new Error(`${path.resolve(start)} is in no workspace: ${program()} workspace init <the game's folder> makes one (${WORKSPACE_FILE} at the game's root, naming the libraries every package inside looks in)`);
  const m = readWorkspace(ws);
  const libs = resolveLibraries([{ file: path.join(ws, WORKSPACE_FILE), base: ws, entries: m.libraries, from: 'workspace' }]);
  const scan = scanLibrary({ name: m.name, path: ws });
  const lines = [
    `workspace "${m.name}" (${path.join(ws, WORKSPACE_FILE)})`,
    `engine: ${m.engine ? `${m.engine.type} ${m.engine.project}${m.engine.assets ? `, exports to ${m.engine.assets}` : ' (no assets folder for exports set)'}` : 'none'}`,
    `libraries: ${libs.libs.length ? libs.libs.map((l) => `${l.entry} (${l.root}${l.name !== l.entry ? `, named "${l.name}"` : ''})`).join(', ') : 'none'}; every package inside looks in them after its own, and in TopoTopo's built-in library`,
    `follow its own packages live: ${m.follow ? 'on (the working folders of its own packages, for looking; exports use the published versions)' : 'off'}`,
    `uses: ${Object.keys(m.uses).length ? Object.entries(m.uses).map(([k, v]) => `${k} ${v}`).join(', ') : 'nothing yet'}; one copy for every package inside (${WORKSPACE_PACKAGES}/), the packages among them keep their own`,
    `packages: ${scan.packages.length}`,
    ...scan.packages.slice(0, 40).map((p) => {
      const own = copiesFor(path.join(ws, p.rel)).workspace === null;
      const uses = Object.entries(p.manifest.uses);
      const listed = uses.map(([k, v]) => `${k} ${v}`).join(', ');
      return `  ${p.rel}${p.manifest.package ? `  package ${p.manifest.package}` : ''}${!uses.length ? '' : own ? `  uses ${listed} (its own copies)` : `  its project.json still uses ${listed}: ${program()} workspace init ${ws} moves them into the workspace's`}`;
    }),
    ...(scan.packages.length > 40 ? [`  … ${scan.packages.length - 40} more`] : []),
  ];
  const problems = [...libs.problems, ...scan.problems];
  if (problems.length) lines.push(`problems: ${problems.length}`, ...problems.map((x) => `  ${x}`));
  return lines.join('\n');
}
