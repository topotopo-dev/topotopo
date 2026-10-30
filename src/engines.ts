// Game engine projects (Godot, Unreal) as TopoTopo meets them: finding the project a workspace builds with (the nearest
// one at or above the workspace, else one below it), whether Unreal sees a workspace (under the project's Content/ or a
// plugin's), the files engines write beside TopoTopo's (never TopoTopo's: left out of versions, hashes, listings and
// bake keys), the .gdignore files that keep TopoTopo's working folders out of Godot's importer, and the Godot export
// presets that would ship TopoTopo's files.
import fs from 'node:fs';
import path from 'node:path';

export type EngineType = 'godot' | 'unreal';
/** The game engine a workspace builds with: its project file, written from the workspace ("game/project.godot", "../Game.uproject"). */
export interface EngineLink { type: EngineType; project: string }

const ENGINE_FILES: [RegExp, EngineType][] = [[/^project\.godot$/, 'godot'], [/\.uproject$/i, 'unreal']];
/** The engine type a project file's name says, or null. */
export const engineTypeOf = (file: string): EngineType | null => ENGINE_FILES.find(([re]) => re.test(path.basename(file)))?.[1] ?? null;
/** Folders an engine search below a folder never enters (besides dot folders). */
const SKIP_BELOW = new Set(['node_modules', 'binaries', 'intermediate', 'saved', 'deriveddatacache', 'versions', 'packages', 'topotopo-packages']);

/**
 * Files an engine writes beside the files it imports, which never count as TopoTopo's: Godot's *.import, *.uid and
 * *.translation, Unreal's *.uasset, and TopoTopo's own .gdignore. Versions, their hashes, input listings, bake keys and
 * the viewer's saved outputs leave them out, so a package inside an engine project publishes what it would elsewhere.
 */
export const isEngineFile = (name: string) => name === '.gdignore' || /\.(import|uid|translation|uasset)$/i.test(name);

const rel = (from: string, to: string) => path.relative(path.resolve(from), path.resolve(to)).split(path.sep).join('/') || '.';

/** The engine project files directly in a folder. */
function projectsIn(dir: string): string[] {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && engineTypeOf(e.name)).map((e) => e.name).sort(); }
  catch { return []; }
}

/**
 * The nearest engine project at or above a folder: project.godot in the folder or above it, a *.uproject the same;
 * null when there is none. A folder holding both answers Godot's (the one a workspace there sees first).
 */
export function engineAbove(dir: string): { file: string; type: EngineType } | null {
  for (let d = path.resolve(dir); ; ) {
    const found = projectsIn(d).sort((a, b) => (engineTypeOf(a) === 'godot' ? -1 : engineTypeOf(b) === 'godot' ? 1 : 0));
    if (found.length) return { file: path.join(d, found[0]), type: engineTypeOf(found[0])! };
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/** The engine projects below a folder (project.godot, *.uproject), nearest first, at most 4 levels down; paths from `dir`. */
export function findEngines(dir: string): EngineLink[] {
  const out: { link: EngineLink; depth: number }[] = [];
  const walk = (d: string, depth: number) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const type = e.isFile() ? engineTypeOf(e.name) : null;
      if (type) out.push({ link: { type, project: rel(dir, path.join(d, e.name)) }, depth });
    }
    if (depth >= 4) return;
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.') && !SKIP_BELOW.has(e.name.toLowerCase())) walk(path.join(d, e.name), depth + 1);
  };
  walk(path.resolve(dir), 0);
  return out.sort((a, b) => a.depth - b.depth || (a.link.project < b.link.project ? -1 : 1)).map((x) => x.link);
}

/**
 * The engine project a workspace at `dir` builds with when none is named: the nearest at or above it (the workspace
 * inside the engine's content folder), else the nearest below it; `found` says how many there were below, when that
 * is where it came from.
 */
export function detectEngine(dir: string): { link: EngineLink; below: EngineLink[] } | null {
  const above = engineAbove(dir);
  if (above) return { link: { type: above.type, project: rel(dir, above.file) }, below: [] };
  const below = findEngines(dir);
  return below.length ? { link: below[0], below } : null;
}

/**
 * Whether Unreal sees a folder of its project: Unreal imports only what lies under the project's Content/ folder or a
 * plugin's (Plugins/…/Content/). `uproject`: the project file.
 */
export function unrealSees(folder: string, uproject: string): boolean {
  const r = path.relative(path.dirname(path.resolve(uproject)), path.resolve(folder));
  if (!r || r.startsWith('..') || path.isAbsolute(r)) return false;
  const parts = r.split(path.sep).map((s) => s.toLowerCase());
  if (parts[0] === 'content') return true;
  return parts[0] === 'plugins' && parts.indexOf('content') > 1;
}

/** The Godot project a folder lies in: the folder holding the nearest project.godot at or above it; null for none. */
export function godotProjectOf(dir: string): string | null {
  for (let d = path.resolve(dir); ; ) {
    if (fs.statSync(path.join(d, 'project.godot'), { throwIfNoEntry: false })?.isFile()) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/** TopoTopo's working folders of a package, which are not game content: Godot imports none of them (a .gdignore in each). */
export const GODOT_IGNORED = ['versions', 'packages', 'inputs'];

/**
 * Inside a Godot project (project.godot at or above the package), keep Godot's importer out of a package's working
 * folders: an empty .gdignore in each of versions/, packages/ and inputs/ that is there, and in the folders of `make`
 * (made when they are not there yet), so the file is in place before the first version or copy lands. Nothing outside a
 * Godot project. Returns the files it added (none when they were all there).
 */
export function godotIgnore(pkgDir: string, make: string[] = []): string[] {
  if (!godotProjectOf(pkgDir)) return [];
  const added: string[] = [];
  for (const d of GODOT_IGNORED) {
    const folder = path.join(pkgDir, d), f = path.join(folder, '.gdignore');
    if (fs.existsSync(f) || (!make.includes(d) && !fs.statSync(folder, { throwIfNoEntry: false })?.isDirectory())) continue;
    try { fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(f, ''); added.push(f); } catch { /* Godot imports them: harmless */ }
  }
  return added;
}

/** The .gdignore files a package inside a Godot project lacks in the working folders it has (godotIgnore adds them); none outside one. */
export function godotIgnoreMissing(pkgDir: string): string[] {
  if (!godotProjectOf(pkgDir)) return [];
  return GODOT_IGNORED.filter((d) => fs.statSync(path.join(pkgDir, d), { throwIfNoEntry: false })?.isDirectory()).map((d) => path.join(pkgDir, d, '.gdignore')).filter((f) => !fs.existsSync(f));
}

/** What a Godot export preset should exclude so that it ships none of TopoTopo's files. */
export const GODOT_EXCLUDES = ['*/attachments/*', '*/graphs/*', '*/inputs/*', '*.topo', '*/exports/*.source.json', '*/exports/exports.json'];

/**
 * The export presets of a Godot project (export_presets.cfg in `projectDir`) that would ship TopoTopo's files: one that
 * exports every resource (export_filter="all_resources", or "exclude": all but the files checked) or includes *.json or
 * *.txt files, with the exclude_filter entries it lacks. Nothing is edited. One line each; none when the file is missing
 * or every preset excludes them.
 */
export function godotPresetReport(projectDir: string): string[] {
  let text: string;
  try { text = fs.readFileSync(path.join(projectDir, 'export_presets.cfg'), 'utf8'); } catch { return []; }
  const out: string[] = [];
  // [preset.N] sections; their keys are key="value" lines
  for (const block of text.split(/^\[preset\.\d+\]\s*$/m).slice(1)) {
    const body = block.split(/^\[/m)[0];
    const key = (k: string) => new RegExp(`^${k}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'm').exec(body)?.[1] ?? '';
    const name = key('name') || '(unnamed)', filter = key('export_filter'), include = key('include_filter'), exclude = key('exclude_filter');
    const includes = include.split(',').map((s) => s.trim()).filter(Boolean);
    // "all_resources": every resource; "exclude": every resource but the files checked in the dialog
    const every = filter === 'all_resources' || filter === 'exclude';
    const ships = every || includes.some((p) => /\*\.(json|txt)$/i.test(p) || p === '*' || p === '*.*');
    if (!ships) continue;
    const have = new Set(exclude.split(',').map((s) => s.trim()).filter(Boolean));
    const missing = GODOT_EXCLUDES.filter((e) => !have.has(e));
    if (!missing.length) continue;
    const why = filter === 'all_resources' ? 'exports every resource' : filter === 'exclude' ? 'exports every resource but the files it leaves out'
      : `includes ${includes.filter((p) => /\*\.(json|txt)$/i.test(p) || p === '*' || p === '*.*').join(', ')}`;
    out.push(`export preset "${name}" ${why}, so it would ship TopoTopo's files: add to its exclude_filter (Project > Export > Resources > Filters to exclude) ${missing.join(', ')}`);
  }
  return out;
}
