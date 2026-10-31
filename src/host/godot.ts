// The Godot flavour of the engine cook (src/host/cook.ts) and the Godot plugin's commands:
//   topotopo cook <.topo | package folder | folder>... --for godot [options]     cook packages into their Godot project
//   topotopo cook --jobs <jobs.json> [--force] [--no-cache] [--progress json]    the plugin's form (integrations/godot/PROTOCOL.md)
//   topotopo godot setup <project> [--no-enable]                                  install the plugin into a project
//   topotopo godot status <project> [--strict] [--json]                           what is current, for people and CI
// The flavour: GLBs Godot 4.7 reads (TopoTopo's glTF defaults, no compression, every required extension one Godot
// supports, EXT_mesh_gpu_instancing for packed instances with the instances' Cd alone as _COLOR), textures outputs as
// PNGs, terrain/material/volume outputs not imported (v1), no .source.json files (a .json in res:// would be imported
// and shipped), output files named by their res:// paths, and Godot's own scan rules (dot names unseen, a folder with
// .gdignore or, below the root, project.godot not entered). Options come from <id>.topo.import [params] (the plugin's
// import options) and flags override them, so a terminal or CI cook writes what the plugin writes.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Geometry } from '../core/geometry.ts';
import type { Kind } from '../graph/outputs.ts';
import { exportGeometryAsync } from '../io/export.ts';
import { exportSource } from '../io/source.ts';
import { resolvedExportOptions } from '../io/targets.ts';
import { texturesExport } from '../io/textures.ts';
import { baseOf } from '../io/common.ts';
import { manifestAt, program, slugify, writeAtomic } from '../package.ts';
import { GODOT_PLUGIN_IGNORED, godotProjectOf } from '../engines.ts';
import { setInstall } from '../config.ts';
import { forgetScans } from '../scan.ts';
import { MANIFEST_EXT } from '../session.ts';
import { TOPOTOPO_VERSION } from './version.ts';
import { COOK_PROTOCOL, cachePrune, closeCookPools, cookPackage, freshness, readRecord } from './cook.ts';
import type { CookJob, CookRecord, EngineOptions, Flavour, Freshness, PackageReport } from './cook.ts';
import { GODOT_COMMANDS } from './godot-commands.ts';
import type { Io } from '../packages/commands.ts';

export { GODOT_COMMANDS };

/**
 * The glTF extensions Godot 4.7's importer reads (GLTFDocument.get_supported_gltf_extensions() of the 4.7.2 editor,
 * its built-in document extensions included). A GLB the cook writes requires none but these, and
 * EXT_mesh_gpu_instancing when instances stay packed (the plugin's glTF extension reads it).
 */
export const GODOT_GLTF_EXTENSIONS = [
  'EXT_texture_webp', 'GODOT_single_root', 'KHR_animation_pointer', 'KHR_lights_punctual', 'KHR_materials_emissive_strength',
  'KHR_materials_pbrSpecularGlossiness', 'KHR_materials_unlit', 'KHR_node_visibility', 'KHR_texture_basisu', 'KHR_texture_transform',
  'OMI_collider', 'OMI_physics_body', 'OMI_physics_shape',
];

/** A package's TopoTopo folders, which Godot should not import (each with an empty .gdignore). */
export const GODOT_HIDDEN = GODOT_PLUGIN_IGNORED;
/** The addon's folder in a project, and its plugin.cfg as project.godot names it. */
export const ADDON_DIR = 'addons/topotopo';
export const PLUGIN_CFG = `res://${ADDON_DIR}/plugin.cfg`;
/** What a project's .gitignore gets: a cook's files being written, and its lock. */
export const GITIGNORE_LINES = ['*.topotopo-part', '**/.topotopo/cook.lock'];
/** What every export preset's exclude_filter gets: Godot's GDScript exporter ships the addon's scripts otherwise. */
export const PRESET_EXCLUDE = `${ADDON_DIR}/*`;
/** The import options' defaults (the plugin's package_importer.gd). */
export const IMPORT_DEFAULTS = { folder: 'outputs', per_output_folders: true, skip: '', mode: 0 };

const ext = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
/** The CLI the plugin runs: src/cli.ts in a checkout, dist/cli.js installed. */
export const CLI_PATH = fileURLToPath(new URL(`../cli.${ext}`, import.meta.url));
/** The addon this TopoTopo carries (integrations/godot/addons/topotopo, shipped in the npm package). */
export const ADDON_SOURCE = fileURLToPath(new URL('../../integrations/godot/addons/topotopo', import.meta.url));

const posix = (p: string) => p.split(path.sep).join('/');
const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const within = (inner: string, outer: string) => { const r = path.relative(path.resolve(outer), path.resolve(inner)); return !r || (!r.startsWith('..') && !path.isAbsolute(r)); };
const isFile = (p: string) => !!fs.statSync(p, { throwIfNoEntry: false })?.isFile();
const isDir = (p: string) => !!fs.statSync(p, { throwIfNoEntry: false })?.isDirectory();

/** A usage, setup or protocol error: exit code 2, nothing written. */
export class SetupError extends Error {}

// ---------------------------------------------------------------------------------------------------------- res://

/** A path in a Godot project as res://… ("res://" for the project folder); throws for a path outside it. */
export function resPath(project: string, abs: string): string {
  const r = path.relative(path.resolve(project), path.resolve(abs));
  if (r.startsWith('..') || path.isAbsolute(r)) throw new SetupError(`${abs} is outside the Godot project ${project}: Godot names files by res:// paths`);
  return `res://${posix(r)}`;
}

/** A res:// path in a project as a path. */
export function fromRes(project: string, res: string): string {
  return path.join(path.resolve(project), ...res.replace(/^res:\/\//, '').split('/').filter(Boolean));
}

/** A res:// path normalised ("." and ".." resolved, no doubled or trailing slash); throws when it leaves the project. */
export function normalRes(res: string): string {
  const parts: string[] = [];
  for (const p of res.replace(/^res:\/\//, '').split(/[\\/]/)) {
    if (!p || p === '.') continue;
    if (p === '..') { if (!parts.length) throw new SetupError(`${res} leaves the Godot project`); parts.pop(); } else parts.push(p);
  }
  return `res://${parts.join('/')}`;
}

// ------------------------------------------------------------------------------------------------ import options

/** A Godot Variant in text: a quoted string (with \" \\ \n \t), true/false, a number; else the text itself. */
function variant(v: string): string | number | boolean {
  const t = v.trim();
  if (t === 'true' || t === 'false') return t === 'true';
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  const m = /^"((?:[^"\\]|\\.)*)"$/.exec(t);
  if (m) return m[1].replace(/\\(.)/g, (_x, c) => ({ n: '\n', t: '\t', r: '\r' } as Record<string, string>)[c] ?? c);
  return t;
}

/** The [params] of a .topo's import file (<id>.topo.import), the plugin's import options; {} when there is none. */
export function readImportParams(topo: string): Record<string, string | number | boolean> {
  let text: string;
  try { text = fs.readFileSync(`${topo}.import`, 'utf8'); } catch { return {}; }
  const out: Record<string, string | number | boolean> = {};
  let inParams = false;
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const s = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (s) { inParams = s[1] === 'params'; continue; }
    if (!inParams) continue;
    const kv = /^\s*([^=\s][^=]*?)\s*=\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = variant(kv[2]);
  }
  return out;
}

/** Options given on the command line or in a job: each overrides the import options. */
export interface GivenOptions {
  /** absolute, or res:// */
  into?: string;
  per_output_folders?: boolean;
  skip?: string[];
  instancing?: 'packed' | 'expand';
}

/**
 * A package's cook options: the import options of its .topo (<id>.topo.import [params]: outputs/folder, relative to
 * the package or res://; outputs/per_output_folders; outputs/skip, comma-separated; instances/mode, 0 MultiMesh or
 * 1 Expand), the defaults where it has none, and `given` over both; the folder as a normalised res:// path.
 */
export function godotOptions(topo: string, project: string, given: GivenOptions = {}): EngineOptions {
  const p = readImportParams(topo), dir = path.dirname(topo);
  const str = (k: string, d: string) => (typeof p[k] === 'string' ? p[k] as string : d);
  const folderText = given.into ?? str('outputs/folder', IMPORT_DEFAULTS.folder);
  let folder: string;
  if (/^res:\/\//.test(folderText)) folder = normalRes(folderText);
  else folder = resPath(project, path.isAbsolute(folderText) ? folderText : path.resolve(dir, folderText));
  folder = normalRes(folder);
  const perOutput = given.per_output_folders ?? (typeof p['outputs/per_output_folders'] === 'boolean' ? p['outputs/per_output_folders'] as boolean : IMPORT_DEFAULTS.per_output_folders);
  const skip = given.skip ?? str('outputs/skip', IMPORT_DEFAULTS.skip).split(',').map((s) => s.trim()).filter(Boolean);
  const mode = p['instances/mode'];
  const instancing = given.instancing ?? (mode === 1 || mode === 'Expand' ? 'expand' : 'packed');
  return { folder, instancing, per_output_folders: perOutput, skip: [...new Set(skip)].sort(byCode) };
}

// ------------------------------------------------------------------------------------------------------- the GLB

/** The JSON chunk of a GLB, or null for bytes that are none. */
export function glbJson(bytes: Uint8Array): any {
  if (bytes.length < 20) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) return null;
  const len = dv.getUint32(12, true), type = dv.getUint32(16, true);
  if (type !== 0x4e4f534a || 20 + len > bytes.length) return null;
  try { return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + len))); } catch { return null; }
}

/** The package a GLB's source block names (asset.extras.source.package), or null. */
export function glbPackage(file: string): string | null {
  if (!/\.glb$/i.test(file)) return null;
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(fs.readFileSync(file)); } catch { return null; }
  const p = glbJson(bytes)?.asset?.extras?.source?.package;
  return typeof p === 'string' ? p : null;
}

/** The keyword of the tEXt chunk that names the package a cooked PNG was made for (PNG has no source block). */
export const PNG_PACKAGE_KEY = 'TopoTopo package';

/** A PNG with a tEXt chunk after its IHDR naming the package it was cooked for (decoders ignore it). */
export function markPng(bytes: Uint8Array, pkg: string): Uint8Array {
  if (bytes.length < 33 || bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return bytes;
  const body = Buffer.concat([Buffer.from('tEXt', 'latin1'), Buffer.from(PNG_PACKAGE_KEY, 'latin1'), Buffer.from([0]), Buffer.from(pkg, 'latin1')]);
  const chunk = Buffer.alloc(body.length + 8);
  chunk.writeUInt32BE(body.length - 4, 0);
  body.copy(chunk, 4);
  chunk.writeUInt32BE(zlib.crc32(body) >>> 0, body.length + 4);
  return new Uint8Array(Buffer.concat([bytes.subarray(0, 33), chunk, bytes.subarray(33)]));
}

/** The package a PNG's tEXt chunk names (markPng), or null. */
export function pngPackage(bytes: Uint8Array): string | null {
  if (bytes.length < 8 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null;
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 8; at + 8 <= b.length; ) {
    const len = b.readUInt32BE(at), type = b.toString('latin1', at + 4, at + 8);
    if (type === 'IDAT' || type === 'IEND') return null;
    if (type === 'tEXt') {
      const data = b.subarray(at + 8, at + 8 + len), z = data.indexOf(0);
      if (z >= 0 && data.toString('latin1', 0, z) === PNG_PACKAGE_KEY) return data.toString('latin1', z + 1);
    }
    at += 12 + len;
  }
  return null;
}

/** The package a cooked file says it was made for: a GLB's source block, a PNG's tEXt chunk; null for other files. */
export function cookedFor(file: string): string | null {
  if (/\.glb$/i.test(file)) return glbPackage(file);
  if (!/\.png$/i.test(file)) return null;
  try { return pngPackage(new Uint8Array(fs.readFileSync(file))); } catch { return null; }
}

/** Why outputs of a kind are not imported (v1), or null. */
export function godotSkipKind(kind: Kind): string | null {
  return kind === 'terrain' || kind === 'material' || kind === 'volume' ? `${kind} outputs are not imported into Godot yet` : null;
}

/** The Godot flavour of the cook for one project. */
export function godotFlavour(project: string): Flavour {
  return {
    for: 'godot',
    project: path.resolve(project),
    skipKind: godotSkipKind,
    outputDir: (o, id) => (o.per_output_folders ? path.join(fromRes(project, o.folder), id) : fromRes(project, o.folder)),
    recordPath: (abs) => resPath(project, abs),
    absolutePath: (res) => fromRes(project, res),
    ownerOf: cookedFor,
    exposed: (dir) => (godotProjectOf(dir) ? GODOT_HIDDEN.filter((d) => isDir(path.join(dir, d)) && !fs.existsSync(path.join(dir, d, '.gdignore'))).map((d) => `${d}/`) : []),
    async write(geo: Geometry, x) {
      const warnings: string[] = [];
      const deflate = (d: Uint8Array) => zlib.deflateSync(d, { level: 6 });
      if (x.kind === 'textures') {
        // one PNG per image, nothing else (materials.json would be a .json in res://)
        const r = texturesExport(geo, '', { deflate });
        return { files: r.files.filter((f) => /\.png$/i.test(f.path)).map((f) => ({ name: baseOf(f.path), bytes: markPng(f.bytes, x.packageName) })), warnings };
      }
      const o = x.output;
      const options = resolvedExportOptions('glb', { instancing: x.options.instancing });
      const source = exportSource({
        graph: o.graph, spec: o.spec, node: o.node, output: o.name, frame: 1, fps: 24, format: 'glb', options, packages: x.packages, package: x.packageName, version: TOPOTOPO_VERSION,
      });
      const bytes = await exportGeometryAsync(geo, 'glb', {
        upAxis: 'y', scale: 1, splitByName: true, custom: false, materials: true, vertexColors: false, compress: 'none', quantize: false, tangents: 'auto',
        instancing: x.options.instancing, instanceColors: true, deflate, readFile: (t) => x.host.readFile(t), warn: (m) => { if (!warnings.includes(m)) warnings.push(m); }, source,
      });
      const required: string[] = glbJson(bytes)?.extensionsRequired ?? [];
      const allowed = new Set([...GODOT_GLTF_EXTENSIONS, ...(x.options.instancing === 'packed' ? ['EXT_mesh_gpu_instancing'] : [])]);
      const unread = required.filter((e) => !allowed.has(e));
      if (unread.length) throw new Error(`the GLB would require ${unread.join(', ')}, which Godot 4.7 does not read; nothing was written for this output`);
      return { files: [{ name: `${x.id}.glb`, bytes }], warnings };
    },
  };
}

// ------------------------------------------------------------------------------------------------ Godot's scan

/**
 * Walk a Godot project as Godot's scan sees it: names starting with "." are not seen, a folder holding .gdignore and a
 * folder below the root holding project.godot are not entered. `visit` gets each folder and its file names; it
 * returns false to leave the folder's subfolders out.
 */
export function godotWalk(root: string, visit: (dir: string, files: string[]) => boolean | void) {
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const files = entries.filter((e) => e.isFile()).map((e) => e.name);
    if (depth > 0 && (files.includes('.gdignore') || files.includes('project.godot'))) return;
    if (visit(dir, files.filter((f) => !f.startsWith('.'))) === false || depth >= 64) return;
    for (const e of entries.sort((a, b) => byCode(a.name, b.name))) if (e.isDirectory() && !e.name.startsWith('.')) walk(path.join(dir, e.name), depth + 1);
  };
  walk(path.resolve(root), 0);
}

const topoIn = (files: string[]) => files.filter((f) => f.endsWith(MANIFEST_EXT) && f.length > MANIFEST_EXT.length).sort(byCode);

/**
 * A .topo that is a published copy, not a package: one beside a version.json, in a topotopo-packages/ folder, or in
 * the versions/ or packages/ folder of a package (a folder holding a .topo).
 */
export function isPublishedCopy(topo: string): boolean {
  const dir = path.dirname(path.resolve(topo));
  if (isFile(path.join(dir, 'version.json'))) return true;
  for (let d = dir; ; ) {
    const up = path.dirname(d);
    if (up === d) return false;
    const name = path.basename(d).toLowerCase();
    if (name === 'topotopo-packages') return true;
    if ((name === 'versions' || name === 'packages') && topoIn(fs.readdirSync(up).filter((f) => isFile(path.join(up, f)))).length) return true;
    d = up;
  }
}

/** Every .topo Godot's scan of a project sees, with whether it is a published copy. */
export function godotTopos(project: string): { topo: string; copy: boolean }[] {
  const out: { topo: string; copy: boolean }[] = [];
  godotWalk(project, (dir, files) => { for (const f of topoIn(files)) out.push({ topo: path.join(dir, f), copy: isPublishedCopy(path.join(dir, f)) }); });
  return out;
}

/**
 * The packages a cook target names: a .topo file, a package folder, or every package below a folder (dot folders,
 * .gdignore folders, folders below it holding project.godot, versions/, packages/ and topotopo-packages/ skipped; a
 * package is not entered). Throws a SetupError for a target that is none of these.
 */
export function cookTargets(target: string): string[] {
  const abs = path.resolve(target);
  if (isFile(abs)) {
    if (!abs.endsWith(MANIFEST_EXT)) throw new SetupError(`${target} is no package manifest (<id>${MANIFEST_EXT}), package folder or folder`);
    return [abs];
  }
  if (!isDir(abs)) throw new SetupError(`no such file or folder: ${target}`);
  const own = topoIn(fs.readdirSync(abs).filter((f) => isFile(path.join(abs, f))));
  if (own.length) return [path.join(abs, own[0])];
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const files = entries.filter((e) => e.isFile()).map((e) => e.name);
    if (depth > 0) {
      if (files.includes('.gdignore') || files.includes('project.godot')) return;
      const t = topoIn(files);
      if (t.length) { out.push(path.join(dir, t[0])); return; }
    }
    if (depth >= 32) return;
    for (const e of entries.sort((a, b) => byCode(a.name, b.name)))
      if (e.isDirectory() && !e.name.startsWith('.') && !['versions', 'packages', 'topotopo-packages', 'node_modules'].includes(e.name.toLowerCase())) walk(path.join(dir, e.name), depth + 1);
  };
  walk(abs, 0);
  return out;
}

/**
 * A package to cook: its manifest (checked: one .topo, an id), not a published copy, inside a Godot project; the
 * options from its import file with `given` over them. Throws a SetupError otherwise.
 */
export function godotJob(topo: string, given: GivenOptions & { adopt?: boolean; report?: string; timeout?: number } = {}): CookJob & { project: string } {
  const abs = path.resolve(topo), dir = path.dirname(abs);
  if (isPublishedCopy(abs)) throw new SetupError(`${abs} is a published copy, not a package: cook its package's working folder; hide copies from Godot with .gdignore (${program()} godot setup <project>)`);
  let at: ReturnType<typeof manifestAt>;
  try { at = manifestAt(dir); } catch (e: any) { throw new SetupError(e.message); }
  if (!at || path.resolve(at.file) !== abs) throw new SetupError(`${abs} is no package manifest`);
  const project = godotProjectOf(dir);
  if (!project) throw new SetupError(`${dir} is in no Godot project (no project.godot at or above it): a cook for Godot names its files by res:// paths`);
  if (path.resolve(project) === dir) throw new SetupError(`${dir} is a package at the root of its Godot project, which is not supported: its assets/ would hide the game's art from Godot; move the package into a folder of the project`);
  const options = godotOptions(abs, project, given);
  return { dir, topo: abs, id: at.id, options, adopt: given.adopt, report: given.report, timeout: given.timeout, project };
}

// ---------------------------------------------------------------------------------------------------- the commands

/** The cook command's usage. */
const cookUsage = () => GODOT_COMMANDS.filter((c) => c.usage.startsWith('cook')).map((c) => `usage: ${program()} ${c.usage}`).join('\n');

/** A command's arguments: valued options, flags, and the rest; an unknown option is a SetupError. */
function parseArgs(argv: string[], valued: string[], flags: string[], usage: () => string) {
  const opts: Record<string, string> = {}, set = new Set<string>(), rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (valued.includes(a)) {
      const v = argv[i + 1];
      if (v === undefined || (v.startsWith('--') && v !== '--')) throw new SetupError(`${a} needs a value\n${usage()}`);
      opts[a] = v; i++;
    } else if (flags.includes(a)) set.add(a);
    else if (a.startsWith('--')) throw new SetupError(`unknown option ${a}\n${usage()}`);
    else rest.push(a);
  }
  return { opts, set, rest };
}

const PER_PACKAGE = ['--into', '--skip', '--instancing', '--timeout', '--report'];

/** A list option ("a,b") as a list. */
const list = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean);

/**
 * topotopo cook … --for godot, and cook --jobs <file>: every package checked first (a usage, setup or protocol error
 * exits 2 and writes nothing), then cooked one after the other in this process; exit 1 when an output or a package
 * failed (records and reports are still written), else 0.
 */
export async function cookCommand(argv: string[], io: Io): Promise<number> {
  let jobs: (CookJob & { project: string })[];
  let flags: { force: boolean; noCache: boolean; json: boolean; quiet: boolean };
  try {
    const { opts, set, rest } = parseArgs(argv, ['--for', '--into', '--skip', '--instancing', '--timeout', '--report', '--progress', '--jobs'], ['--flat', '--adopt', '--force', '--no-cache', '--quiet'], cookUsage);
    const progress = opts['--progress'];
    if (progress !== undefined && progress !== 'json') throw new SetupError(`--progress takes json, got "${progress}"`);
    flags = { force: set.has('--force'), noCache: set.has('--no-cache'), json: progress === 'json', quiet: set.has('--quiet') };
    if (opts['--jobs'] !== undefined) {
      const extra = [...PER_PACKAGE.filter((f) => opts[f] !== undefined), ...['--flat', '--adopt'].filter((f) => set.has(f)), ...(rest.length ? [rest[0]] : [])];
      if (extra.length) throw new SetupError(`--jobs names the packages and their options itself: leave out ${extra.join(', ')}\n${cookUsage()}`);
      if (opts['--for'] !== undefined && opts['--for'] !== 'godot') throw new SetupError(`--for ${opts['--for']}: only godot is supported`);
      jobs = readJobs(opts['--jobs']);
    } else {
      if (opts['--for'] === undefined) throw new SetupError(`cook needs --for godot (the engine to cook into)\n${cookUsage()}`);
      if (opts['--for'] !== 'godot') throw new SetupError(`--for ${opts['--for']}: only godot is supported`);
      if (!rest.length) throw new SetupError(`cook needs a .topo, a package folder or a folder\n${cookUsage()}`);
      const instancing = opts['--instancing'];
      if (instancing !== undefined && instancing !== 'packed' && instancing !== 'expand') throw new SetupError(`--instancing takes packed or expand, got "${instancing}"`);
      const timeout = opts['--timeout'] !== undefined ? Number(opts['--timeout']) : undefined;
      if (timeout !== undefined && !(timeout > 0)) throw new SetupError(`--timeout takes seconds above 0, got "${opts['--timeout']}"`);
      const topos = [...new Set(rest.flatMap(cookTargets))];
      if (opts['--report'] !== undefined && topos.length !== 1) throw new SetupError(`--report names one report file, and the targets hold ${topos.length} packages: cook them one at a time, or use --jobs`);
      const into = opts['--into'] === undefined ? undefined : /^res:\/\//.test(opts['--into']) ? opts['--into'] : path.resolve(opts['--into']);
      jobs = topos.map((t) => godotJob(t, {
        into, per_output_folders: set.has('--flat') ? false : undefined, skip: opts['--skip'] !== undefined ? list(opts['--skip']) : undefined,
        instancing: instancing as 'packed' | 'expand' | undefined, adopt: set.has('--adopt'), report: opts['--report'] !== undefined ? path.resolve(opts['--report']) : undefined, timeout,
      }));
      if (!jobs.length) { io.out(`no package below ${rest.join(', ')}: nothing to cook`); return 0; }
    }
  } catch (e: any) {
    io.err(e instanceof SetupError ? e.message : String(e?.message ?? e));
    return 2;
  }
  const human = (s: string) => { if (!flags.quiet) (flags.json ? io.err : io.out)(s); };
  let ok = true;
  try {
    for (const job of jobs) {
      const rep = await cookPackage(job, godotFlavour(job.project), { force: flags.force, noCache: flags.noCache, progress: flags.json ? (l) => io.out(l) : undefined });
      ok &&= rep.ok;
      human(summary(rep, job.project));
      for (const line of failures(rep)) io.err(line);
    }
  } finally {
    await closeCookPools();
    cachePrune();
  }
  return ok ? 0 : 1;
}

/** A package's cook in a line. */
function summary(rep: PackageReport, project: string): string {
  const where = (() => { try { return resPath(project, rep.package.dir); } catch { return rep.package.dir; } })();
  if (!rep.outputs.length && rep.errors.length) return `${rep.package.id} (${where}): did not cook`;
  const by = (s: string) => rep.outputs.filter((o) => o.state === s).map((o) => o.id);
  const parts = ['written', 'cached', 'unchanged', 'failed', 'skipped'].map((s) => [s, by(s)] as const).filter(([, l]) => l.length).map(([s, l]) => `${s} ${l.join(', ')}`);
  return `${rep.package.id} (${where}): ${rep.outputs.length} output${rep.outputs.length === 1 ? '' : 's'}${parts.length ? `: ${parts.join('; ')}` : ''}; record ${rep.record}${rep.orphans.length ? `; ${rep.orphans.length} orphan file${rep.orphans.length === 1 ? '' : 's'} kept (no longer cooked): ${rep.orphans.join(', ')}` : ''} (${(rep.ms / 1000).toFixed(1)} s)`;
}

/** A package's failures and warnings, a line each, as the plugin's Output says them. */
function failures(rep: PackageReport): string[] {
  const out: string[] = [];
  for (const e of rep.errors) out.push(`TopoTopo: ${rep.package.id}: ${e}`);
  for (const o of rep.outputs) for (const e of o.errors) out.push(`TopoTopo: ${rep.package.id} > ${o.id}: ${e.node ? `[${e.node}] ` : ''}${e.message}${e.hint ? ` (hint: ${e.hint})` : ''}`);
  for (const w of rep.warnings) out.push(`TopoTopo: ${rep.package.id}: warning: ${w}`);
  return out;
}

/** A jobs file read and checked (protocol, flavour, each job's package and options); throws a SetupError. */
export function readJobs(file: string): (CookJob & { project: string })[] {
  let raw: any;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch (e: any) { throw new SetupError(`the jobs file ${file} cannot be read: ${e.message}`); }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.jobs)) throw new SetupError(`${file} is no jobs file: {"for": "godot", "protocol": ${COOK_PROTOCOL}, "jobs": [...]}`);
  const projectOf = () => { const p = raw.jobs.find((j: any) => typeof j?.package === 'string')?.package; const g = p ? godotProjectOf(path.dirname(path.resolve(p))) : null; return g ?? '<project>'; };
  if (raw.protocol !== COOK_PROTOCOL) throw new SetupError(`the jobs file speaks protocol ${JSON.stringify(raw.protocol)} and this TopoTopo ${TOPOTOPO_VERSION} speaks ${COOK_PROTOCOL}: update the Godot addon: ${program()} godot setup ${projectOf()}`);
  if (raw.for !== undefined && raw.for !== 'godot') throw new SetupError(`the jobs file is for ${JSON.stringify(raw.for)}: only godot is supported`);
  return raw.jobs.map((j: any, i: number) => {
    const at = `${file}: job ${i + 1}`;
    if (!j || typeof j.package !== 'string') throw new SetupError(`${at} names no "package" (the .topo's absolute path)`);
    const topo = isDir(j.package) ? cookTargets(j.package)[0] : j.package;
    if (!topo || !isFile(topo)) throw new SetupError(`${at}: no package at ${j.package}`);
    if (j.instancing !== undefined && j.instancing !== 'packed' && j.instancing !== 'expand') throw new SetupError(`${at}: "instancing" is packed or expand`);
    if (j.skip !== undefined && (!Array.isArray(j.skip) || j.skip.some((s: unknown) => typeof s !== 'string'))) throw new SetupError(`${at}: "skip" is a list of output ids`);
    if (j.timeout !== undefined && !(typeof j.timeout === 'number' && j.timeout > 0)) throw new SetupError(`${at}: "timeout" is seconds above 0`);
    if (j.into !== undefined && typeof j.into !== 'string') throw new SetupError(`${at}: "into" is a folder`);
    return godotJob(topo, {
      into: j.into === undefined ? undefined : /^res:\/\//.test(j.into) ? j.into : path.resolve(j.into),
      per_output_folders: typeof j.per_output_folders === 'boolean' ? j.per_output_folders : undefined, skip: j.skip, instancing: j.instancing,
      adopt: j.adopt === true, report: typeof j.report === 'string' ? path.resolve(j.report) : undefined, timeout: j.timeout,
    });
  });
}

// ------------------------------------------------------------------------------------------------------ status

/** A package as godot status sees it. */
export interface PackageStatus {
  /** the .topo as res:// */
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
  /** output folders an LFS pattern does not cover, in a repository that uses LFS */
  lfs: string[];
}

export interface StatusResult {
  project: string;
  packages: PackageStatus[];
  /** published copies Godot sees (res:// of their .topo) */
  copies: string[];
  /** export presets that would ship the addon */
  presets: string[];
  /** a package at the project's root (not supported) */
  root: string[];
  ok: boolean;
}

/** Git in the project's repository: its root and a check-attr runner; null when it is no repository or git is missing. */
function gitOf(project: string): { top: string; lfs: boolean; filter: (abs: string[]) => Map<string, string> } | null {
  const run = (args: string[]) => spawnSync('git', args, { cwd: project, encoding: 'utf8', windowsHide: true });
  const top = run(['rev-parse', '--show-toplevel']);
  if (top.status !== 0 || !top.stdout.trim()) return null;
  const root = path.resolve(top.stdout.trim());
  // a repository uses LFS when a .gitattributes on the way to the project names filter=lfs
  let lfs = false;
  for (let d = path.resolve(project); within(d, root); d = path.dirname(d)) {
    try { if (/filter=lfs/.test(fs.readFileSync(path.join(d, '.gitattributes'), 'utf8'))) { lfs = true; break; } } catch { /* none here */ }
    if (path.resolve(d) === root) break;
  }
  return {
    top: root, lfs,
    filter: (abs) => {
      const out = new Map<string, string>();
      if (!abs.length) return out;
      const rels = abs.map((a) => posix(path.relative(root, a)));
      const r = spawnSync('git', ['check-attr', 'filter', '--', ...rels], { cwd: root, encoding: 'utf8', windowsHide: true });
      for (const line of (r.stdout ?? '').split(/\r?\n/)) {
        const m = /^(.*): filter: (.*)$/.exec(line);
        if (m) out.set(m[1], m[2]);
      }
      return new Map(rels.map((r2, i) => [abs[i], out.get(r2) ?? 'unspecified']));
    },
  };
}

/** The output folders of a package whose GLBs and PNGs no LFS pattern covers (res://), in a repository that uses LFS. */
function lfsGaps(git: ReturnType<typeof gitOf>, project: string, id: string, o: EngineOptions, outputs: string[]): string[] {
  if (!git?.lfs) return [];
  const folders = o.per_output_folders ? (outputs.length ? outputs : [id]).map((x) => path.join(fromRes(project, o.folder), x)) : [fromRes(project, o.folder)];
  const probes = folders.flatMap((f) => [path.join(f, 'probe.glb'), path.join(f, 'probe.png')]);
  const attrs = git.filter(probes);
  return folders.filter((f) => [path.join(f, 'probe.glb'), path.join(f, 'probe.png')].some((p) => attrs.get(p) !== 'lfs')).map((f) => resPath(project, f));
}

/** The export presets (export_presets.cfg) whose exclude_filter does not keep the addon out. */
export function presetsShippingAddon(project: string): string[] {
  let text: string;
  try { text = fs.readFileSync(path.join(project, 'export_presets.cfg'), 'utf8'); } catch { return []; }
  const out: string[] = [];
  for (const block of text.split(/^\[preset\.\d+\]\s*$/m).slice(1)) {
    const body = block.split(/^\[/m)[0];
    const key = (k: string) => new RegExp(`^${k}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'm').exec(body)?.[1] ?? '';
    if (!key('exclude_filter').split(',').map((s) => s.trim()).includes(PRESET_EXCLUDE)) out.push(key('name') || '(unnamed)');
  }
  return out;
}

/** What `topotopo godot status` finds: every .topo Godot sees, checked with the one freshness rule (this TopoTopo installed). */
export function godotStatus(project: string): StatusResult {
  const proj = path.resolve(project);
  if (!isFile(path.join(proj, 'project.godot'))) throw new SetupError(`${project} is no Godot project folder (it holds no project.godot)`);
  const res: StatusResult = { project: proj, packages: [], copies: [], presets: presetsShippingAddon(proj), root: [], ok: true };
  const git = gitOf(proj);
  const flavour = godotFlavour(proj);
  for (const { topo, copy } of godotTopos(proj)) {
    if (copy) { res.copies.push(resPath(proj, topo)); continue; }
    const dir = path.dirname(topo);
    if (dir === proj) { res.root.push(resPath(proj, topo)); continue; }
    let at: ReturnType<typeof manifestAt> = null;
    try { at = manifestAt(dir); } catch { /* two manifests: said below */ }
    const id = at?.id ?? path.basename(topo, MANIFEST_EXT);
    let options: EngineOptions;
    try { options = godotOptions(topo, proj); } catch (e: any) {
      res.packages.push({ topo: resPath(proj, topo), id, state: 'stale', why: 'options', path: '', note: '', text: e.message, outputs: [], skipped: [], exposed: flavour.exposed(dir), lfs: [] });
      continue;
    }
    let record: CookRecord | null = null, f: Freshness;
    try { record = readRecord(dir, 'godot'); f = freshness(dir, record, options, { for: 'godot', absolutePath: flavour.absolutePath, installed: TOPOTOPO_VERSION }); }
    catch (e: any) { f = { state: 'stale', why: 'record', path: '', note: '', text: e.message }; }
    const outputs = Object.entries(record?.outputs ?? {}).sort(([a], [b]) => byCode(a, b)).map(([oid, o]) => ({ id: oid, state: o.state, kind: o.kind, files: Object.keys(o.files ?? {}), errors: o.errors ?? [] }));
    const skipped = Object.entries(record?.skipped ?? {}).sort(([a], [b]) => byCode(a, b)).map(([oid, s]) => ({ id: oid, why: s.why }));
    res.packages.push({
      topo: resPath(proj, topo), id, state: f.state, why: f.why, path: f.path, note: f.note, text: f.text, outputs, skipped,
      exposed: flavour.exposed(dir), lfs: lfsGaps(git, proj, id, options, outputs.map((o) => o.id)),
    });
  }
  res.ok = !res.copies.length && !res.root.length && res.packages.every((p) => p.state === 'ok' && !p.exposed.length);
  return res;
}

/** A status as people read it. */
export function statusText(r: StatusResult): string {
  const lines = [`Godot project ${r.project}: ${r.packages.length} package${r.packages.length === 1 ? '' : 's'}`];
  for (const p of r.packages) {
    const state = p.state === 'never_cooked' ? 'never cooked' : p.state;
    lines.push(`  ${state.padEnd(12)} ${p.topo}${p.state === 'ok' ? '' : `: ${p.text}`}${p.note === 'update_topotopo' ? ' (cooked by a newer TopoTopo: update TopoTopo)' : ''}`);
    for (const o of p.outputs) {
      lines.push(`      ${o.id}: ${o.state}${o.kind ? ` ${o.kind}` : ''}${o.files.length ? ` → ${o.files.join(', ')}` : ''}`);
      for (const e of o.errors) lines.push(`        ${e.node ? `[${e.node}] ` : ''}${e.message}${e.hint ? ` (hint: ${e.hint})` : ''}`);
    }
    for (const s of p.skipped) lines.push(`      ${s.id}: skipped (${s.why})`);
    if (p.exposed.length) lines.push(`      exposed: Godot imports ${p.exposed.join(', ')} (no .gdignore): ${program()} godot setup ${r.project} hides them`);
    for (const f of p.lfs) lines.push(`      LFS: no pattern covers ${f} (*.glb, *.png): add one to .gitattributes`);
  }
  for (const c of r.copies) lines.push(`  copy         ${c}: a published copy Godot sees: hide its folder with .gdignore (${program()} godot setup ${r.project})`);
  for (const t of r.root) lines.push(`  unsupported  ${t}: a package at the project's root (its assets/ would hide the game's art): move it into a folder`);
  for (const p of r.presets) lines.push(`  export preset "${p}" ships the addon: add ${PRESET_EXCLUDE} to its exclude_filter (${program()} godot setup does)`);
  lines.push(r.ok ? 'every package is current' : 'not every package is current (--strict exits 1)');
  return lines.join('\n');
}

// ------------------------------------------------------------------------------------------------------- setup

/** Add lines a text file lacks, at its end. Returns the lines added. */
function addLines(file: string, lines: string[]): string[] {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* new */ }
  const have = new Set(text.split(/\r?\n/).map((l) => l.trim()));
  const missing = lines.filter((l) => !have.has(l));
  if (missing.length) fs.writeFileSync(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
  return missing;
}

/** project.godot with the plugin enabled ([editor_plugins] enabled=PackedStringArray(…)); null when it is enabled already. */
export function enablePlugin(text: string): string | null {
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === '[editor_plugins]');
  const entry = JSON.stringify(PLUGIN_CFG);
  if (start >= 0) {
    let end = lines.findIndex((l, i) => i > start && /^\s*\[/.test(l));
    if (end < 0) end = lines.length;
    const at = lines.findIndex((l, i) => i > start && i < end && /^\s*enabled\s*=/.test(l));
    if (at >= 0) {
      if (lines[at].includes(entry)) return null;
      const m = /PackedStringArray\((.*)\)\s*$/.exec(lines[at]);
      const items = m && m[1].trim() ? `${m[1].trim()}, ${entry}` : entry;
      lines[at] = `enabled=PackedStringArray(${items})`;
    } else lines.splice(start + 1, 0, '', `enabled=PackedStringArray(${entry})`);
    return lines.join(nl);
  }
  // a new section, where Godot sorts it (sections in name order)
  const sections = lines.map((l, i) => [i, /^\[([^\]]+)\]\s*$/.exec(l)?.[1]] as const).filter(([, n]) => n && n !== 'editor_plugins' && !/^(config_version)$/.test(n));
  const after = sections.find(([, n]) => n! > 'editor_plugins');
  const block = ['[editor_plugins]', '', `enabled=PackedStringArray(${entry})`, ''];
  if (after) lines.splice(after[0], 0, ...block);
  else { while (lines.length && lines[lines.length - 1] === '') lines.pop(); lines.push('', ...block); }
  return lines.join(nl);
}

/** export_presets.cfg with addons/topotopo/* in every preset's exclude_filter; null when nothing changes. */
export function excludeAddon(text: string): string | null {
  let changed = false;
  const out = text.replace(/^(\s*exclude_filter\s*=\s*")((?:[^"\\]|\\.)*)("\s*)$/gm, (all, a: string, v: string, b: string) => {
    const items = v.split(',').map((s) => s.trim()).filter(Boolean);
    if (items.includes(PRESET_EXCLUDE)) return all;
    changed = true;
    return `${a}${[...items, PRESET_EXCLUDE].join(', ')}${b}`;
  });
  return changed ? out : null;
}

/** Copy the addon into the project, replacing what an earlier setup copied; the .uid and .import files Godot wrote beside it stay. */
function copyAddon(from: string, to: string): number {
  const files: string[] = [];
  const walk = (d: string, rel: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(path.join(d, e.name), r); else if (e.isFile()) files.push(r); } };
  walk(from, '');
  for (const f of files) {
    const dest = path.join(to, ...f.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(from, ...f.split('/')), dest);
  }
  const keep = new Set(files);
  const clean = (d: string, rel: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { clean(path.join(d, e.name), r); continue; }
      const engineSide = /\.(uid|import)$/i.test(e.name) && keep.has(r.replace(/\.(uid|import)$/i, ''));
      if (!keep.has(r) && !engineSide) fs.rmSync(path.join(d, e.name), { force: true });
    }
  };
  clean(to, '');
  return files.length;
}

export interface SetupOptions {
  /** enable the plugin in project.godot (default true) */
  enable?: boolean;
  /** the addon to copy (default: the one this TopoTopo carries) */
  addon?: string;
  /** what the install record names (default: this node and this CLI) */
  node?: string;
  cli?: string;
}

/**
 * topotopo godot setup: install the plugin into a Godot project, saying each step. Throws a SetupError for a folder
 * that is no Godot project or a TopoTopo without the addon.
 */
export function godotSetup(project: string, o: SetupOptions = {}): string[] {
  const proj = path.resolve(project);
  if (!isFile(path.join(proj, 'project.godot'))) throw new SetupError(`${project} is no Godot project folder (it holds no project.godot)`);
  const addon = o.addon ?? ADDON_SOURCE;
  if (!isFile(path.join(addon, 'plugin.cfg'))) throw new SetupError(`this TopoTopo (${TOPOTOPO_VERSION}) carries no Godot addon at ${addon}`);
  const said: string[] = [];
  const n = copyAddon(addon, path.join(proj, ...ADDON_DIR.split('/')));
  said.push(`copied the addon (${n} files) into ${ADDON_DIR}/`);
  const cfg = setInstall({ node: o.node ?? process.execPath, cli: o.cli ?? CLI_PATH });
  said.push(`recorded where TopoTopo is (node ${o.node ?? process.execPath}, ${o.cli ?? CLI_PATH}) in ${cfg} "install"`);
  // Godot imports none of TopoTopo's working folders: a .gdignore in each a package has
  const hidden: string[] = [];
  for (const { topo, copy } of godotTopos(proj)) {
    if (copy) continue;
    const dir = path.dirname(topo);
    if (dir === proj) { said.push(`not supported: ${path.basename(topo)} makes the project's root a package (its assets/ would hide the game's art from Godot): move the package into a folder; no .gdignore was written for it`); continue; }
    for (const d of GODOT_HIDDEN) {
      const f = path.join(dir, d, '.gdignore');
      if (isDir(path.join(dir, d)) && !fs.existsSync(f)) { fs.writeFileSync(f, ''); hidden.push(resPath(proj, path.join(dir, d))); }
    }
    // a workspace's shared copies
  }
  godotWalk(proj, (dir) => {
    const shared = path.join(dir, 'topotopo-packages');
    if (isDir(shared) && !fs.existsSync(path.join(shared, '.gdignore'))) { fs.writeFileSync(path.join(shared, '.gdignore'), ''); hidden.push(resPath(proj, shared)); }
  });
  forgetScans();
  said.push(hidden.length ? `hid ${hidden.length} TopoTopo folder${hidden.length === 1 ? '' : 's'} from Godot (an empty .gdignore in each): ${hidden.join(', ')}` : 'every TopoTopo folder is hidden from Godot already (.gdignore)');
  if (o.enable !== false) {
    const file = path.join(proj, 'project.godot');
    const text = fs.readFileSync(file, 'utf8'), next = enablePlugin(text);
    if (next !== null) { writeAtomic(file, next); said.push(`enabled the plugin in project.godot ([editor_plugins] ${PLUGIN_CFG}); if Godot has the project open, tick Project > Project Settings > Plugins > TopoTopo instead, or reopen the project`); }
    else said.push('the plugin is enabled in project.godot already');
  } else said.push('left project.godot as it is (--no-enable): enable the plugin in Project > Project Settings > Plugins > TopoTopo');
  const ignored = addLines(path.join(proj, '.gitignore'), GITIGNORE_LINES);
  said.push(ignored.length ? `added to .gitignore: ${ignored.join(', ')}` : '.gitignore has the cook\'s lines already');
  const presets = path.join(proj, 'export_presets.cfg');
  if (isFile(presets)) {
    const next = excludeAddon(fs.readFileSync(presets, 'utf8'));
    if (next !== null) { writeAtomic(presets, next); said.push(`added ${PRESET_EXCLUDE} to the exclude_filter of every export preset (export_presets.cfg): Godot would ship the addon's scripts otherwise`); }
    else said.push(`every export preset excludes ${PRESET_EXCLUDE} already`);
  } else said.push(`no export_presets.cfg yet: when you add an export preset, run setup again (it adds ${PRESET_EXCLUDE} to its exclude_filter)`);
  const git = gitOf(proj);
  if (git?.lfs) for (const { topo, copy } of godotTopos(proj)) {
    if (copy || path.dirname(topo) === proj) continue;
    let options: EngineOptions;
    try { options = godotOptions(topo, proj); } catch { continue; }
    for (const f of lfsGaps(git, proj, path.basename(topo, MANIFEST_EXT), options, Object.keys(readRecord(path.dirname(topo), 'godot')?.outputs ?? {}))) said.push(`warning: the repository uses LFS and no pattern covers ${f} (*.glb, *.png): add one to .gitattributes`);
  }
  return said;
}

/** topotopo godot setup | status. */
export async function godotCommand(argv: string[], io: Io): Promise<number> {
  const usage = () => GODOT_COMMANDS.filter((c) => c.usage.startsWith('godot')).map((c) => `usage: ${program()} ${c.usage}`).join('\n');
  const [sub, ...rest] = argv;
  try {
    if (sub === 'setup') {
      const { set, rest: pos } = parseArgs(rest, [], ['--no-enable'], usage);
      if (pos.length !== 1) throw new SetupError(`godot setup needs the Godot project folder\n${usage()}`);
      for (const l of godotSetup(pos[0], { enable: !set.has('--no-enable') })) io.out(l);
      return 0;
    }
    if (sub === 'status') {
      const { set, rest: pos } = parseArgs(rest, [], ['--strict', '--json'], usage);
      if (pos.length !== 1) throw new SetupError(`godot status needs the Godot project folder\n${usage()}`);
      const r = godotStatus(pos[0]);
      io.out(set.has('--json') ? JSON.stringify(r, null, 2) : statusText(r));
      return set.has('--strict') && !r.ok ? 1 : 0;
    }
    throw new SetupError(sub ? `unknown godot command "${sub}"\n${usage()}` : usage());
  } catch (e: any) {
    io.err(e instanceof SetupError ? e.message : String(e?.message ?? e));
    return 2;
  }
}

/** A package id from a folder name, for messages about folders without a manifest. */
export const idOf = (dir: string) => slugify(path.basename(dir)) || 'package';
