// The Unreal flavour of the engine cook (src/host/cook.ts) and the Unreal plugin's commands (the plugin is
// integrations/unreal/TopoTopoImport, the contract integrations/unreal/PROTOCOL.md):
//   topotopo cook <.topo | package folder | folder>... --for unreal [options]   cook packages inside Content/ (cook-command.ts)
//   topotopo unreal setup <project> [--no-enable] [--with-pcg]                  install the plugin into a project
//   topotopo unreal status <project> [--strict] [--json]                        what is current, for people and CI
// A package lives in the project's Content/ (or a plugin's); what a level uses are the .uasset files the plugin makes, and
// those are what a repository commits. So the cooked files are the plugin's intermediate files, kept out of Content/ under
// Saved/TopoTopo/<the output folder's content path>/, where Auto Reimport does not see them; a checkout without them is
// still current (cook.ts freshness, localOutputs). The flavour:
//   mesh           <id>.glb, one static mesh; _lod<n> pieces go to <id>_lod<n>.glb (its LODs), sockets to <id>.sockets.json
//   instances      one GLB per packed source in <id>_meshes/, the rows as <id>.instances.csv (Unreal centimetres, the
//                  PCG columns), plus <id>.glb when it also has plain meshes; with instancing expand one GLB
//   points         <id>.points.csv (the PCG columns)
//   textures       one PNG per image
//   terrain        the unreal_landscape bundle of src/io/unreal.ts, which TopoTopoPCG places in a level
//   curves, material, volume   not imported yet: listed as skipped, with why
//   scene          by what it holds: a heightfield makes it a terrain bundle, else as mesh + instances
// Options come from <id>.topo.import [params], written by the plugin, as in Godot; folder is a content path (/Game/...).
// A report's outputs carry the steps the plugin takes (`import`, unrealPlan below), so what each kind becomes in Unreal
// is decided and tested here and the plugin only carries them out.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import type { Geometry } from '../core/geometry.ts';
import type { Kind } from '../graph/outputs.ts';
import { heightfieldsOf } from '../core/heightfield.ts';
import { flattenSource, stripPacked } from '../core/packed.ts';
import { sceneEmpties } from '../core/scene.ts';
import { m4fromQuat } from '../core/math.ts';
import { exportGeometryAsync } from '../io/export.ts';
import { exportFilesAsync } from '../io/files.ts';
import { exportCSV, instanceMeshesJSON, unrealRotator } from '../io/points.ts';
import { exportSource } from '../io/source.ts';
import { resolvedExportOptions } from '../io/targets.ts';
import { texturesExport } from '../io/textures.ts';
import { baseOf, packedSourceNames } from '../io/common.ts';
import type { ExportOptions } from '../io/common.ts';
import { manifestAt, program, writeAtomic } from '../package.ts';
import { unrealSees } from '../engines.ts';
import { setInstall } from '../config.ts';
import { MANIFEST_EXT } from '../session.ts';
import { TOPOTOPO_VERSION } from './version.ts';
import { freshness, readRecord } from './cook.ts';
import type { CookJob, CookRecord, EngineOptions, Flavour, Freshness } from './cook.ts';
import { CLI_PATH, IMPORT_DEFAULTS, SetupError, addLines, cookTargets, cookedFor, glbJson, isPublishedCopy, markPng, parseArgs, readImportParams } from './godot.ts';
import type { GivenOptions } from './godot.ts';
import { UNREAL_COMMANDS } from './unreal-commands.ts';
import type { Io } from '../packages/commands.ts';

export { UNREAL_COMMANDS };

/** The plugin's name, its folder in a project, and what this TopoTopo carries (shipped in the npm package). */
export const PLUGIN_NAME = 'TopoTopoImport';
export const PLUGIN_SOURCE = fileURLToPath(new URL(`../../integrations/unreal/${PLUGIN_NAME}`, import.meta.url));
/** The older plugin that places terrain bundles and reads point streams in PCG graphs: --with-pcg installs it. */
export const PCG_PLUGIN_NAME = 'TopoTopoPCG';
export const PCG_PLUGIN_SOURCE = fileURLToPath(new URL(`../../integrations/unreal/${PCG_PLUGIN_NAME}`, import.meta.url));
/** Where cooked files go, below the project. */
export const COOKED_DIR = 'Saved/TopoTopo';
/** The glTF extensions Interchange's glTF translator reads (UE 5.8, GLTFAsset.h); a cooked GLB requires none but these. */
export const UNREAL_GLTF_EXTENSIONS = [
  'KHR_materials_pbrSpecularGlossiness', 'KHR_materials_unlit', 'KHR_materials_clearcoat', 'KHR_materials_transmission', 'KHR_materials_sheen',
  'KHR_materials_variants', 'KHR_materials_ior', 'KHR_materials_specular', 'KHR_materials_emissive_strength', 'KHR_materials_iridescence',
  'KHR_materials_anisotropy', 'KHR_materials_volume', 'KHR_texture_transform', 'KHR_lights_punctual', 'KHR_mesh_quantization',
];
/**
 * What Auto Reimport must not import from a package inside Content/ (relative to the monitored folder; * also matches
 * "/"): TopoTopo's working folders, a workspace's shared copies and its manifest. The .topo stays seen.
 */
export const UNREAL_EXCLUDES = [
  '*/graphs/*', '*/assets/*', '*/inputs/*', '*/exports/*', '*/versions/*', '*/packages/*', '*/attachments/*', '*/.topotopo/*',
  '*/topotopo-packages/*', 'topotopo-packages/*', '*topotopo-workspace.json',
];
/** The folders of a package that would be imported if Auto Reimport saw them. */
const HIDDEN_FOLDERS = ['graphs', 'assets', 'inputs', 'exports', 'versions', 'packages', 'attachments'];
/** The ini file and section of Auto Reimport's settings, and the entry a project starts from (BaseEditorPerProjectUserSettings.ini). */
export const REIMPORT_INI = 'Config/DefaultEditorPerProjectUserSettings.ini';
const REIMPORT_SECTION = '[/Script/UnrealEd.EditorLoadingSavingSettings]';
const DEFAULT_WILDCARD = 'Localization/*';
/** What a project's .gitignore gets: a cook's files being written, its lock, and the cooked files. */
export const GITIGNORE_LINES = ['*.topotopo-part', '**/.topotopo/cook.lock', `${COOKED_DIR}/`];

const posix = (p: string) => p.split(path.sep).join('/');
const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const isFile = (p: string) => !!fs.statSync(p, { throwIfNoEntry: false })?.isFile();
const isDir = (p: string) => !!fs.statSync(p, { throwIfNoEntry: false })?.isDirectory();

// ------------------------------------------------------------------------------------------------- content paths

/** The folder holding the nearest *.uproject at or above a folder, or null. */
export function unrealProjectOf(dir: string): string | null {
  for (let d = path.resolve(dir); ; ) {
    let names: string[] = [];
    try { names = fs.readdirSync(d); } catch { /* unreadable */ }
    if (names.some((n) => /\.uproject$/i.test(n) && isFile(path.join(d, n)))) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/** A project's .uproject (absolute); throws a SetupError for a folder that holds none. */
export function uprojectOf(project: string): string {
  let names: string[] = [];
  try { names = fs.readdirSync(project); } catch { /* said below */ }
  const found = names.filter((n) => /\.uproject$/i.test(n)).sort(byCode);
  if (!found.length) throw new SetupError(`${project} is no Unreal project folder (it holds no .uproject)`);
  return path.join(path.resolve(project), found[0]);
}

/** A folder of a project as its content path: Content/props is /Game/props, Plugins/Kit/Content/props is /Kit/props; throws outside them. */
export function contentPathOf(project: string, abs: string): string {
  const parts = path.relative(path.resolve(project), path.resolve(abs)).split(path.sep);
  const low = parts.map((s) => s.toLowerCase());
  const below = (at: number, mount: string) => [`/${mount}`, ...parts.slice(at + 1)].join('/');
  if (low[0] === 'content') return below(0, 'Game');
  if (low[0] === 'plugins') {
    const at = low.indexOf('content');
    if (at > 1) return below(at, parts[at - 1]);
  }
  throw new SetupError(`${abs} is outside the Unreal project's Content/ folder: Unreal imports only what lies under Content/ or a plugin's Content/`);
}

/** A content path normalised ("." and ".." resolved, no doubled or trailing slash); throws for one Unreal refuses. */
export function normalContentPath(p: string): string {
  const parts: string[] = [];
  for (const s of p.split(/[\\/]/)) {
    if (!s || s === '.') continue;
    if (s === '..') { if (parts.length < 2) throw new SetupError(`${p} leaves its content folder`); parts.pop(); } else parts.push(s);
  }
  // Unreal's FPackageName::IsValidLongPackageName refuses these in a package path
  if (parts.length < 1 || parts.some((s) => /[\\:*?"<>|' ,.&!~\n\r\t@#]/.test(s))) throw new SetupError(`"${p}" is no Unreal content path: a folder name cannot hold spaces or any of \\ : * ? " < > | ' , . & ! ~ @ #`);
  return `/${parts.join('/')}`;
}

/** A name as an asset gets it (ObjectTools::SanitizeObjectName's characters become _). */
export const assetName = (s: string) => s.replace(/["' ,.:|&!~\n\r\t@#(){}[\]=;^%$`/\\]/g, '_');

/** The folder of an output's assets, and of its cooked files below the project (posix). */
export const assetFolder = (o: EngineOptions, id: string) => (o.per_output_folders ? `${o.folder}/${assetName(id)}` : o.folder);
export const cookedFolder = (o: EngineOptions, id: string) => `${COOKED_DIR}${assetFolder(o, id)}`;

// ------------------------------------------------------------------------------------------------ import options

/**
 * A package's cook options, from the same <id>.topo.import [params] Godot's addon uses (the plugin writes it: outputs/folder,
 * relative to the package or a content path; outputs/per_output_folders; outputs/skip, comma-separated; instances/mode, 0
 * packed or 1 expand), the defaults where it has none, and `given` over both.
 */
export function unrealOptions(topo: string, project: string, given: GivenOptions = {}): EngineOptions {
  const p = readImportParams(topo), dir = path.dirname(topo);
  const str = (k: string, d: string) => (typeof p[k] === 'string' ? p[k] as string : d);
  const text = given.into ?? str('outputs/folder', IMPORT_DEFAULTS.folder);
  const folder = /^\/[^/]/.test(text) ? normalContentPath(text)
    : path.isAbsolute(text) ? normalContentPath(contentPathOf(project, text))
    : normalContentPath(`${contentPathOf(project, dir)}/${text.split(/[\\/]/).join('/')}`);
  const perOutput = given.per_output_folders ?? (typeof p['outputs/per_output_folders'] === 'boolean' ? p['outputs/per_output_folders'] as boolean : IMPORT_DEFAULTS.per_output_folders);
  const skip = given.skip ?? str('outputs/skip', IMPORT_DEFAULTS.skip).split(',').map((s) => s.trim()).filter(Boolean);
  const mode = p['instances/mode'];
  const instancing = given.instancing ?? (mode === 1 || mode === 'Expand' ? 'expand' : 'packed');
  return { folder, instancing, per_output_folders: perOutput, skip: [...new Set(skip)].sort(byCode) };
}

// ------------------------------------------------------------------------------------------------------ the plan

/** One thing the plugin does with a cooked output's files. Paths are as the record names them, below the project. */
export interface ImportStep {
  /** a static mesh from a GLB, a texture from a PNG, an instances asset and PCG points from a CSV, a terrain bundle */
  as: 'static_mesh' | 'texture' | 'instances' | 'points' | 'landscape';
  file: string;
  /** the content folder of the asset, and its name */
  folder: string;
  name: string;
  /** static_mesh: its LODs from the second on, as GLBs, in order */
  lods?: string[];
  /** static_mesh: the file of its sockets */
  sockets?: string;
  /** instances, points: the asset of each value of the Mesh column */
  meshes?: Record<string, string>;
}

/** What the plugin does with an output's files (the kinds at the top of this file). `files`: as the record names them. */
export function unrealPlan(o: { id: string; kind: string; files: string[] }, options: EngineOptions): ImportStep[] {
  const name = assetName(o.id), folder = assetFolder(options, o.id), at = cookedFolder(options, o.id);
  const rel = (f: string) => (f.startsWith(`${at}/`) ? f.slice(at.length + 1) : f);
  const sorted = [...o.files].sort(byCode);
  const find = (r: string) => sorted.find((f) => rel(f) === r);
  const steps: ImportStep[] = [];
  const bundle = find('landscape.json');
  if (bundle) return [{ as: 'landscape', file: bundle, folder, name }];
  if (o.kind === 'textures') return sorted.filter((f) => /\.png$/i.test(f)).map((f) => ({ as: 'texture' as const, file: f, folder, name: assetName(baseOf(f).replace(/\.png$/i, '')) }));
  const mesh = find(`${o.id}.glb`);
  if (mesh) {
    const lods = sorted.filter((f) => new RegExp(`^${o.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_lod\\d+\\.glb$`).test(rel(f)))
      .sort((a, b) => Number(/_lod(\d+)\.glb$/.exec(a)![1]) - Number(/_lod(\d+)\.glb$/.exec(b)![1]));
    const sockets = find(`${o.id}.sockets.json`);
    steps.push({ as: 'static_mesh', file: mesh, folder, name, ...(lods.length ? { lods } : {}), ...(sockets ? { sockets } : {}) });
  }
  const meshesAt = options.per_output_folders ? `${folder}/Meshes` : `${folder}/${name}_Meshes`;
  const protos = sorted.filter((f) => rel(f).startsWith(`${o.id}_meshes/`) && /\.glb$/i.test(f));
  const meshes: Record<string, string> = {};
  for (const f of protos) {
    const source = baseOf(f).replace(/\.glb$/i, ''), asset = assetName(source);
    meshes[source] = `${meshesAt}/${asset}.${asset}`;
    steps.push({ as: 'static_mesh', file: f, folder: meshesAt, name: asset });
  }
  const rows = find(`${o.id}.instances.csv`);
  if (rows) {
    steps.push({ as: 'instances', file: rows, folder, name: `${name}_Instances`, meshes });
    steps.push({ as: 'points', file: rows, folder, name: `${name}_Points`, meshes });
  }
  const points = find(`${o.id}.points.csv`);
  if (points) steps.push({ as: 'points', file: points, folder, name: `${name}_Points` });
  return steps;
}

// ------------------------------------------------------------------------------------------------------- flavour

/** Why outputs of a kind are not imported, or null. */
export function unrealSkipKind(kind: Kind): string | null {
  return kind === 'curves' || kind === 'material' || kind === 'volume' ? `${kind} outputs are not imported into Unreal yet` : null;
}

const LOD_NAME = /_lod(\d+)$/i;

/**
 * A mesh by its levels of detail: prims named *_lod<n> at each level, the first level found with every prim of no level.
 * One entry when it has fewer than two levels.
 */
function splitLods(g: Geometry): { level: number; geo: Geometry }[] {
  const names = g.prims.get('name');
  if (!names || names.type !== 'string') return [{ level: 0, geo: g }];
  const of = new Int32Array(g.numPrims).fill(-1), levels = new Set<number>();
  for (let p = 0; p < g.numPrims; p++) {
    const m = LOD_NAME.exec(String(names.get(p) ?? ''));
    if (m) { of[p] = Number(m[1]); levels.add(of[p]); }
  }
  if (levels.size < 2) return [{ level: 0, geo: g }];
  const order = [...levels].sort((a, b) => a - b);
  return order.map((level, i) => ({ level, geo: g.subsetPrims(Uint8Array.from(of, (l) => (l === level || (i === 0 && l < 0) ? 1 : 0)), true) }));
}

/**
 * The sockets of a mesh (scene_null) as the plugin adds them to its static mesh: in Unreal axes and centimetres, with
 * the rotator src/io/points.ts gives instances. null when it has none.
 */
function socketsFile(g: Geometry): string | null {
  const empties = sceneEmpties(g);
  if (!empties.length) return null;
  const r = (x: number) => +x.toFixed(6);
  const sockets = empties.map((e) => {
    const rot = unrealRotator(m4fromQuat(e.orient));
    return { name: e.name, location: [r(e.P[0] * 100), r(e.P[2] * 100), r(e.P[1] * 100)], rotation: { pitch: r(rot.pitch), yaw: r(rot.yaw), roll: r(rot.roll) }, scale: [r(e.scale[0]), r(e.scale[2]), r(e.scale[1])] };
  }).sort((a, b) => byCode(a.name, b.name));
  return JSON.stringify({ format: 'topotopo-sockets', version: 1, units: 'centimetres, Unreal axes X = x, Y = z, Z = y', sockets }, null, 2) + '\n';
}

/** Files of an output's own folders the flavour may cook over: everything below Saved/TopoTopo/ belongs to the cook. */
function unrealExposed(project: string, dir: string): string[] {
  const missing = missingExcludes(project);
  if (!missing.length) return [];
  return HIDDEN_FOLDERS.filter((d) => isDir(path.join(dir, d))).map((d) => `${d}/`);
}

/** The Unreal flavour of the cook for one project. */
export function unrealFlavour(project: string): Flavour {
  const proj = path.resolve(project);
  return {
    for: 'unreal',
    project: proj,
    localOutputs: true,
    skipKind: unrealSkipKind,
    outputDir: (o, id) => path.join(proj, ...cookedFolder(o, id).split('/')),
    recordPath: (abs) => posix(path.relative(proj, abs)),
    absolutePath: (rec) => path.join(proj, ...rec.split('/')),
    ownerOf: cookedFor,
    exposed: (dir) => unrealExposed(proj, dir),
    plan: (o, options) => unrealPlan(o, options),
    async write(geo: Geometry, x) {
      const warnings: string[] = [];
      const warn = (m: string) => { if (!warnings.includes(m)) warnings.push(m); };
      const deflate = (d: Uint8Array) => zlib.deflateSync(d, { level: 6 });
      const readFile = (t: string) => x.host.readFile(t);
      if (x.kind === 'textures') {
        const r = texturesExport(geo, '', { deflate });
        return { files: r.files.filter((f) => /\.png$/i.test(f.path)).map((f) => ({ name: baseOf(f.path), bytes: markPng(f.bytes, x.packageName) })), warnings };
      }
      const o = x.output;
      const sourceFor = (format: 'glb' | 'csv' | 'unreal_landscape', extra: Record<string, unknown> = {}) => exportSource({
        graph: o.graph, spec: o.spec, node: o.node, output: o.name, frame: 1, fps: 24, format, options: resolvedExportOptions(format, { instancing: x.options.instancing, ...extra }), packages: x.packages, package: x.packageName, version: TOPOTOPO_VERSION,
      });
      if (x.kind === 'terrain' || (x.kind === 'scene' && heightfieldsOf(geo).length)) {
        const bundle = await exportFilesAsync(geo, 'unreal_landscape', 'bundle', { materials: true, custom: false, deflate, readFile, warn, source: sourceFor('unreal_landscape') });
        return { files: bundle.files.map((f) => ({ name: f.path.replace(/^bundle\//, ''), bytes: f.bytes })), warnings };
      }
      const glb = async (g: Geometry, instancing: 'packed' | 'expand'): Promise<Uint8Array> => {
        const opts: ExportOptions = {
          upAxis: 'y', scale: 1, splitByName: true, custom: false, materials: true, vertexColors: false, materialColorWins: true, compress: 'none', quantize: false, tangents: 'auto',
          instancing, instanceColors: false, deflate, readFile, warn, source: sourceFor('glb'),
        } as ExportOptions;
        const bytes = await exportGeometryAsync(g, 'glb', opts);
        const required: string[] = glbJson(bytes)?.extensionsRequired ?? [];
        const unread = required.filter((e) => !UNREAL_GLTF_EXTENSIONS.includes(e));
        if (unread.length) throw new Error(`the GLB would require ${unread.join(', ')}, which Unreal's Interchange does not read; nothing was written for this output`);
        return bytes;
      };
      const files: { name: string; bytes: Uint8Array }[] = [];
      const addMesh = async (g: Geometry, instancing: 'packed' | 'expand') => {
        const levels = splitLods(g);
        files.push({ name: `${x.id}.glb`, bytes: await glb(levels[0].geo, instancing) });
        for (let i = 1; i < levels.length; i++) files.push({ name: `${x.id}_lod${i}.glb`, bytes: await glb(levels[i].geo, instancing) });
        const sockets = socketsFile(g);
        if (sockets) files.push({ name: `${x.id}.sockets.json`, bytes: new TextEncoder().encode(sockets) });
      };
      if (x.kind === 'points') {
        files.push({ name: `${x.id}.points.csv`, bytes: new TextEncoder().encode(exportCSV(geo, { pcg: true, scale: 100, warn })) });
        return { files, warnings };
      }
      if (geo.hasPacked() && x.options.instancing === 'packed') {
        const stream = `${x.id}.instances.csv`, meshDir = `${x.id}_meshes`;
        files.push({ name: stream, bytes: new TextEncoder().encode(exportCSV(geo, { pcg: true, scale: 100, warn })) });
        files.push({ name: `${x.id}.instances.meshes.json`, bytes: new TextEncoder().encode(instanceMeshesJSON(geo, { meshDir, stream, source: sourceFor('csv') })) });
        const names = packedSourceNames(geo);
        for (let s = 0; s < geo.packedSources.length; s++) files.push({ name: `${meshDir}/${names[s]}.glb`, bytes: await glb(flattenSource(geo.packedSources[s]), 'expand') });
        const plain = stripPacked(geo);
        if (plain.numPrims) await addMesh(plain, 'expand');
        return { files, warnings };
      }
      await addMesh(geo, x.options.instancing);
      return { files, warnings };
    },
  };
}

// -------------------------------------------------------------------------------------------------------- the job

/**
 * A package to cook: its manifest (checked: one .topo, an id), not a published copy, under an Unreal project's Content/ or
 * a plugin's, in a folder of its own; the options from its import file with `given` over them. Throws a SetupError
 * otherwise. Files below Saved/TopoTopo/ belong to the cook, so it takes them over as they are.
 */
export function unrealJob(topo: string, given: GivenOptions & { adopt?: boolean; report?: string; timeout?: number } = {}): CookJob & { project: string } {
  const abs = path.resolve(topo), dir = path.dirname(abs);
  if (isPublishedCopy(abs)) throw new SetupError(`${abs} is a published copy, not a package: cook its package's working folder`);
  let at: ReturnType<typeof manifestAt>;
  try { at = manifestAt(dir); } catch (e: any) { throw new SetupError(e.message); }
  if (!at || path.resolve(at.file) !== abs) throw new SetupError(`${abs} is no package manifest`);
  const project = unrealProjectOf(dir);
  if (!project) throw new SetupError(`${dir} is in no Unreal project (no .uproject at or above it): a cook for Unreal names its assets by their content paths`);
  if (!unrealSees(dir, uprojectOf(project))) throw new SetupError(`${dir} is outside the Unreal project's Content/ folder: Unreal imports only what lies under Content/ or a plugin's Content/; move the package there`);
  const content = contentPathOf(project, dir);
  if (content.split('/').length < 3) throw new SetupError(`${dir} is a package directly in Content/, which is not supported: its graphs/ and assets/ would be seen by Auto Reimport; move the package into a folder of its own`);
  normalContentPath(content);
  const options = unrealOptions(abs, project, given);
  return { dir, topo: abs, id: at.id, options, adopt: true, report: given.report, timeout: given.timeout, project };
}

// ------------------------------------------------------------------------------------------------------ status

/** A package as unreal status sees it. */
export interface UnrealPackageStatus {
  /** the package's content path */
  content: string;
  topo: string;
  id: string;
  state: Freshness['state'];
  why: string;
  path: string;
  note: string;
  text: string;
  outputs: { id: string; state: string; kind: string; files: string[]; errors: { node: string; message: string; hint: string }[] }[];
  skipped: { id: string; why: string }[];
  exposed: string[];
}

export interface UnrealStatus {
  project: string;
  packages: UnrealPackageStatus[];
  /** whether the plugin is installed in the project */
  plugin: boolean;
  /** the Auto Reimport exclusions the project lacks */
  excludes: string[];
  /** a package directly in Content/ (not supported) */
  root: string[];
  ok: boolean;
}

/** The project's Content/ and every plugin's. */
function contentFolders(project: string): string[] {
  const out = [path.join(project, 'Content')];
  const plugins = path.join(project, 'Plugins');
  const walk = (d: string, depth: number) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.isFile() && /\.uplugin$/i.test(e.name))) { out.push(path.join(d, 'Content')); return; }
    if (depth < 4) for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.')) walk(path.join(d, e.name), depth + 1);
  };
  walk(plugins, 0);
  return out.filter(isDir);
}

/** What `topotopo unreal status` finds: every package under Content/, checked with the one freshness rule (this TopoTopo installed). */
export function unrealStatus(project: string): UnrealStatus {
  const proj = projectFolder(project);
  const flavour = unrealFlavour(proj);
  const res: UnrealStatus = { project: proj, packages: [], plugin: isFile(path.join(proj, 'Plugins', PLUGIN_NAME, `${PLUGIN_NAME}.uplugin`)), excludes: missingExcludes(proj), root: [], ok: true };
  const topos = contentFolders(proj).flatMap((c) => {
    const direct = fs.readdirSync(c).filter((f) => f.endsWith(MANIFEST_EXT) && f.length > MANIFEST_EXT.length).map((f) => path.join(c, f));
    res.root.push(...direct.map((t) => posix(path.relative(proj, t))));
    return direct.length ? [] : cookTargets(c);
  });
  for (const topo of topos.sort(byCode)) {
    const dir = path.dirname(topo);
    let at: ReturnType<typeof manifestAt> = null;
    try { at = manifestAt(dir); } catch { /* two manifests: said by the cook */ }
    const id = at?.id ?? path.basename(topo, MANIFEST_EXT);
    const content = contentPathOf(proj, dir);
    const base = { content, topo: posix(path.relative(proj, topo)), id, exposed: flavour.exposed(dir) };
    let options: EngineOptions;
    try { options = unrealOptions(topo, proj); } catch (e: any) {
      res.packages.push({ ...base, state: 'stale', why: 'options', path: '', note: '', text: e.message, outputs: [], skipped: [] });
      continue;
    }
    let record: CookRecord | null = null, f: Freshness;
    try { record = readRecord(dir, 'unreal'); f = freshness(dir, record, options, { for: 'unreal', absolutePath: flavour.absolutePath, installed: TOPOTOPO_VERSION, localOutputs: true }); }
    catch (e: any) { f = { state: 'stale', why: 'record', path: '', note: '', text: e.message }; }
    const outputs = Object.entries(record?.outputs ?? {}).sort(([a], [b]) => byCode(a, b)).map(([oid, o]) => ({ id: oid, state: o.state, kind: o.kind, files: Object.keys(o.files ?? {}), errors: o.errors ?? [] }));
    const skipped = Object.entries(record?.skipped ?? {}).sort(([a], [b]) => byCode(a, b)).map(([oid, s]) => ({ id: oid, why: s.why }));
    res.packages.push({ ...base, state: f.state, why: f.why, path: f.path, note: f.note, text: f.text, outputs, skipped });
  }
  res.ok = !res.root.length && res.packages.every((p) => p.state === 'ok' && !p.exposed.length);
  return res;
}

/** A status as people read it. */
export function unrealStatusText(r: UnrealStatus): string {
  const lines = [`Unreal project ${r.project}: ${r.packages.length} package${r.packages.length === 1 ? '' : 's'}${r.plugin ? '' : ` (no ${PLUGIN_NAME} plugin: ${program()} unreal setup ${r.project})`}`];
  for (const p of r.packages) {
    const state = p.state === 'never_cooked' ? 'never cooked' : p.state;
    lines.push(`  ${state.padEnd(12)} ${p.content}${p.state === 'ok' ? '' : `: ${p.text}`}${p.note === 'update_topotopo' ? ' (cooked by a newer TopoTopo: update TopoTopo)' : ''}`);
    for (const o of p.outputs) {
      lines.push(`      ${o.id}: ${o.state}${o.kind ? ` ${o.kind}` : ''}`);
      for (const e of o.errors) lines.push(`        ${e.node ? `[${e.node}] ` : ''}${e.message}${e.hint ? ` (hint: ${e.hint})` : ''}`);
    }
    for (const s of p.skipped) lines.push(`      ${s.id}: skipped (${s.why})`);
    if (p.exposed.length) lines.push(`      exposed: Auto Reimport sees ${p.exposed.join(', ')}: ${program()} unreal setup ${r.project} excludes them`);
  }
  for (const t of r.root) lines.push(`  unsupported  ${t}: a package directly in Content/: move it into a folder of its own`);
  lines.push(r.ok ? 'every package is current' : 'not every package is current (--strict exits 1)');
  return lines.join('\n');
}

// -------------------------------------------------------------------------------------------------- auto reimport

/** The wildcards an AutoReimportDirectorySettings entry of the ini names. */
const wildcardsOf = (line: string) => [...line.matchAll(/Wildcard="([^"]*)"/g)].map((m) => m[1]);
const isGameEntry = (line: string) => /^[+.]?AutoReimportDirectorySettings=/.test(line.trim()) && /SourceDirectory="\/Game\/?"/.test(line);
const wildcard = (w: string) => `(Wildcard="${w}",bInclude=False)`;

/** The exclusions a project's ini lacks: all of them when no entry for /Game/ is there. */
export function missingExcludes(project: string): string[] {
  let text = '';
  try { text = fs.readFileSync(path.join(project, ...REIMPORT_INI.split('/')), 'utf8'); } catch { return [...UNREAL_EXCLUDES]; }
  const line = text.split(/\r?\n/).find(isGameEntry);
  if (!line) return [...UNREAL_EXCLUDES];
  const have = new Set(wildcardsOf(line));
  return UNREAL_EXCLUDES.filter((w) => !have.has(w));
}

/**
 * The ini text with the exclusions in Auto Reimport's /Game/ entry, its other wildcards kept; null when nothing changes.
 * An ini without an entry clears the array (the engine's default entry would stay beside this one) and adds one that
 * keeps the default's wildcard.
 */
export function withExcludes(text: string): string | null {
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex(isGameEntry);
  if (at >= 0) {
    const have = new Set(wildcardsOf(lines[at]));
    const missing = UNREAL_EXCLUDES.filter((w) => !have.has(w));
    if (!missing.length) return null;
    const add = missing.map(wildcard).join(',');
    const m = /Wildcards=\(/.exec(lines[at]);
    if (m) {
      const open = m.index + m[0].length;
      lines[at] = `${lines[at].slice(0, open)}${have.size ? `${add},` : add}${lines[at].slice(open)}`;
    } else lines[at] = lines[at].replace(/\)\s*$/, `,Wildcards=(${add}))`);
    return lines.join(nl);
  }
  const entry = `+AutoReimportDirectorySettings=(SourceDirectory="/Game/",MountPoint="",Wildcards=(${[DEFAULT_WILDCARD, ...UNREAL_EXCLUDES].map(wildcard).join(',')}))`;
  const block = ['!AutoReimportDirectorySettings=ClearArray', entry];
  const section = lines.findIndex((l) => l.trim() === REIMPORT_SECTION);
  if (section >= 0) {
    lines.splice(section + 1, 0, ...block);
    return lines.join(nl);
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return [...lines, ...(lines.length ? [''] : []), REIMPORT_SECTION, ...block, ''].join(nl);
}

// ------------------------------------------------------------------------------------------------------- setup

/** A project folder from a folder or its .uproject; throws a SetupError for anything else. */
function projectFolder(given: string): string {
  const abs = path.resolve(given);
  const proj = /\.uproject$/i.test(abs) && isFile(abs) ? path.dirname(abs) : abs;
  uprojectOf(proj);
  return proj;
}

/** The folders of a plugin the build fills: never copied, never cleaned. */
const BUILT = new Set(['binaries', 'intermediate', 'saved']);

/** Copy a plugin into a project, replacing what an earlier setup copied; what the build wrote beside it stays. Returns the files copied. */
function copyPlugin(from: string, to: string): number {
  const files: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (!rel && BUILT.has(e.name.toLowerCase())) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r); else if (e.isFile()) files.push(r);
    }
  };
  walk(from, '');
  for (const f of files) {
    const dest = path.join(to, ...f.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const bytes = fs.readFileSync(path.join(from, ...f.split('/')));
    // only changed bytes, so the build does not rebuild a plugin whose source is the same
    let same = false;
    try { same = fs.readFileSync(dest).equals(bytes); } catch { /* new */ }
    if (!same) fs.writeFileSync(dest, bytes);
  }
  const keep = new Set(files);
  const clean = (d: string, rel: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!rel && BUILT.has(e.name.toLowerCase())) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) clean(path.join(d, e.name), r);
      else if (!keep.has(r)) fs.rmSync(path.join(d, e.name), { force: true });
    }
  };
  clean(to, '');
  return files.length;
}

/**
 * A .uproject's text with a plugin enabled in its "Plugins" list, in the file's own indent; null when it is enabled
 * already. Throws a SetupError for a file that is no JSON object.
 */
export function enableInUproject(text: string, name: string): string | null {
  let raw: any;
  try { raw = JSON.parse(text.replace(/^﻿/, '')); } catch (e: any) { throw new SetupError(`the .uproject is no JSON: ${e.message}`); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SetupError('the .uproject is no JSON object');
  const plugins: any[] = Array.isArray(raw.Plugins) ? raw.Plugins : (raw.Plugins = []);
  const have = plugins.find((p) => String(p?.Name).toLowerCase() === name.toLowerCase());
  if (have?.Enabled === true) return null;
  if (have) have.Enabled = true; else plugins.push({ Name: name, Enabled: true });
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  return JSON.stringify(raw, null, '\t').replace(/\n/g, nl) + nl;
}

export interface UnrealSetupOptions {
  /** enable the plugin in the .uproject (default true) */
  enable?: boolean;
  /** also install TopoTopoPCG */
  pcg?: boolean;
  /** the plugins to copy (default: the ones this TopoTopo carries) */
  plugin?: string;
  pcgPlugin?: string;
  /** what the install record names (default: this node and this CLI) */
  node?: string;
  cli?: string;
}

/** topotopo unreal setup: install the plugin into a project, saying each step. Throws a SetupError for a folder that is no project. */
export function unrealSetup(project: string, o: UnrealSetupOptions = {}): string[] {
  const proj = projectFolder(project);
  const uproject = uprojectOf(proj);
  const source = o.plugin ?? PLUGIN_SOURCE;
  if (!isFile(path.join(source, `${PLUGIN_NAME}.uplugin`))) throw new SetupError(`this TopoTopo (${TOPOTOPO_VERSION}) carries no Unreal plugin at ${source}`);
  const said: string[] = [];
  const n = copyPlugin(source, path.join(proj, 'Plugins', PLUGIN_NAME));
  said.push(`copied the plugin (${n} files) into Plugins/${PLUGIN_NAME}/`);
  const names = [PLUGIN_NAME];
  if (o.pcg) {
    const pcg = o.pcgPlugin ?? PCG_PLUGIN_SOURCE;
    if (!isFile(path.join(pcg, `${PCG_PLUGIN_NAME}.uplugin`))) throw new SetupError(`this TopoTopo (${TOPOTOPO_VERSION}) carries no ${PCG_PLUGIN_NAME} plugin at ${pcg}`);
    said.push(`copied ${PCG_PLUGIN_NAME} (${copyPlugin(pcg, path.join(proj, 'Plugins', PCG_PLUGIN_NAME))} files) into Plugins/${PCG_PLUGIN_NAME}/: it places terrain outputs in a level`);
    names.push(PCG_PLUGIN_NAME);
  }
  const node = o.node ?? process.execPath, cli = o.cli ?? CLI_PATH;
  const cfg = setInstall({ node, cli });
  said.push(`recorded where TopoTopo is (node ${node}, ${cli}) in ${cfg} "install"`);
  if (o.enable !== false) {
    for (const name of names) {
      const text = fs.readFileSync(uproject, 'utf8'), next = enableInUproject(text, name);
      if (next !== null) { writeAtomic(uproject, next); said.push(`enabled ${name} in ${path.basename(uproject)}`); }
      else said.push(`${name} is enabled in ${path.basename(uproject)} already`);
    }
  } else said.push(`left ${path.basename(uproject)} as it is (--no-enable): enable the plugin in Edit > Plugins > TopoTopo Import`);
  const iniFile = path.join(proj, ...REIMPORT_INI.split('/'));
  let ini = '';
  try { ini = fs.readFileSync(iniFile, 'utf8'); } catch { /* new */ }
  const next = withExcludes(ini);
  if (next !== null) {
    fs.mkdirSync(path.dirname(iniFile), { recursive: true });
    writeAtomic(iniFile, next);
    said.push(`excluded TopoTopo's folders from Auto Reimport in ${REIMPORT_INI}: ${UNREAL_EXCLUDES.join(', ')}`);
  } else said.push(`${REIMPORT_INI} excludes TopoTopo's folders from Auto Reimport already`);
  const ignored = addLines(path.join(proj, '.gitignore'), GITIGNORE_LINES);
  said.push(ignored.length ? `added to .gitignore: ${ignored.join(', ')}` : '.gitignore has the cook\'s lines already');
  said.push('the plugin is C++ source: open the project and let Unreal build it when it asks (Visual Studio with its C++ toolchain); close the editor first if it has the project open');
  return said;
}

/** topotopo unreal setup | status. */
export async function unrealCommand(argv: string[], io: Io): Promise<number> {
  const usage = () => UNREAL_COMMANDS.filter((c) => c.usage.startsWith('unreal')).map((c) => `usage: ${program()} ${c.usage}`).join('\n');
  const [sub, ...rest] = argv;
  try {
    if (sub === 'setup') {
      const { set, rest: pos } = parseArgs(rest, [], ['--no-enable', '--with-pcg'], usage);
      if (pos.length !== 1) throw new SetupError(`unreal setup needs the Unreal project folder\n${usage()}`);
      for (const l of unrealSetup(pos[0], { enable: !set.has('--no-enable'), pcg: set.has('--with-pcg') })) io.out(l);
      return 0;
    }
    if (sub === 'status') {
      const { set, rest: pos } = parseArgs(rest, [], ['--strict', '--json'], usage);
      if (pos.length !== 1) throw new SetupError(`unreal status needs the Unreal project folder\n${usage()}`);
      const r = unrealStatus(pos[0]);
      io.out(set.has('--json') ? JSON.stringify(r, null, 2) : unrealStatusText(r));
      return set.has('--strict') && !r.ok ? 1 : 0;
    }
    throw new SetupError(sub ? `unknown unreal command "${sub}"\n${usage()}` : usage());
  } catch (e: any) {
    io.err(e instanceof SetupError ? e.message : String(e?.message ?? e));
    return 2;
  }
}
