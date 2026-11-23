// Writing exports for the CLI, the MCP server and the viewer: serialize with the export tool's options, then write
// each file through a .part beside it, renamed into place. Published targets (io/targets.ts) write inside exports/
// only, and every target is serialized before any file is written, so a failed cook or format changes nothing.
// exports/ is the package's (exportsFolderFor): the folder of the nearest .topo file above the graph, so a graph in
// <package>/graphs/ exports into <package>/exports/, from the CLI, the MCP server and the viewer alike; a graph file in
// no package exports beside itself.
// Every export records how it was made (io/source.ts): the caller passes the source block, and a target builds its own
// from the graph it is published from.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { Geometry } from '../core/geometry.ts';
import { sha256Hex } from '../core/sha256.ts';
import type { ExportFormat } from '../io/export.ts';
import { exportFilesAsync } from '../io/files.ts';
import type { ExportFile, ExportFiles } from '../io/files.ts';
import { exportSource, sameSource, withExportOptions } from '../io/source.ts';
import { prefixGone, resolvedExportOptions } from '../io/targets.ts';
import type { ExportSource } from '../io/source.ts';
import type { PublishedOutput, ResolvedTarget } from '../io/targets.ts';
import { packageFilesHash } from '../packages/registry.ts';
import { topoFiles } from '../session.ts';
import { ArtifactStore } from './artifacts.ts';
import type { Host } from './types.ts';
import { TOPOTOPO_VERSION } from './version.ts';
import { engineSha256 } from './engine-code.ts';

/** The package a path lies in: the nearest folder holding a .topo file, the path's own or one above it; null for none. */
export function packageFolderOf(p: string): string | null {
  let d = path.resolve(p);
  if (fs.statSync(d, { throwIfNoEntry: false })?.isFile()) d = path.dirname(d);
  for (;;) {
    if (topoFiles(d).length) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/**
 * Where a graph file's exports go: its package's exports/ folder (the nearest .topo file above it), else exports/
 * beside the graph. One rule for the CLI (--export-all, its receipts), `topotopo view` and the MCP server (whose
 * folder is the package folder).
 */
export function exportsFolderFor(graphFile: string): string {
  const file = path.resolve(graphFile);
  return path.join(packageFolderOf(path.dirname(file)) ?? path.dirname(file), 'exports');
}

/**
 * files_sha256 of an export of the graph in `graphFile` (io/source.ts): the files of its package a cook may read besides
 * it (src/packages/registry.ts packageFilesHash); undefined for a graph in no package, or none read from a file.
 */
export function filesShaFor(graphFile: string | undefined): string | undefined {
  if (!graphFile) return undefined;
  const dir = packageFolderOf(path.dirname(path.resolve(graphFile)));
  return dir ? packageFilesHash(dir, graphFile) : undefined;
}

/** PNG compression for the images exports encode (one function, so encoded images are found again: io/textures.ts) */
const deflate = (d: Uint8Array) => zlib.deflateSync(d, { level: 6 });

/**
 * The files an export writes, nothing written yet; `a` holds the export tool's snake_case options. Every option the
 * format reads is passed explicitly, the given ones over the format's defaults (io/targets.ts exportDefaults), and the
 * source block records exactly those, so the record replays to the same bytes. glb / gltf with maps "external" write
 * their images into `mapsDir` (default: maps/ beside the export; export targets share exports/maps/).
 */
export async function serializeExport(geo: Geometry, format: ExportFormat, p: string, given: Record<string, any>, host: Host, source?: ExportSource, mapsDir?: string) {
  const a: Record<string, any> = resolvedExportOptions(format, given);
  if (source) source = withExportOptions(source, a);
  const warnings: string[] = [];
  const outDir = format === 'unreal_landscape' && !/\.json$/i.test(p) ? p : path.dirname(p);
  const maps = mapsDir ?? path.join(path.dirname(p), 'maps');
  const res = await exportFilesAsync(geo, format, p, {
    upAxis: a.up_axis, scale: a.scale, splitByName: a.split_by_name ?? true, custom: a.custom_attribs,
    materials: a.materials, vertexColors: a.vertex_colors, compress: a.compress, quantize: a.quantize, tangents: a.tangents, attributes: a.attributes, pcg: a.pcg || a.pcg_struct, pcgStruct: a.pcg_struct,
    precision: a.precision, instancing: a.instancing, instances: a.instances, meshes: a.meshes,
    layer: a.layer, layers: a.layers, heightMin: a.height_min, heightMax: a.height_max, heightfield: a.heightfield, tile_size: a.tile_size,
    maps: a.maps, mapsDir: maps, mapsURI: path.relative(path.dirname(p), maps).split(path.sep).join('/'),
    deflate,
    readFile: (t) => host.readFile(t),
    texturePath: (t) => {
      const abs = host.resolvePath(t);
      return /^[a-z][a-z0-9+.-]*:\/\//i.test(abs) ? abs : path.relative(outDir, abs).split(path.sep).join('/');
    },
    warn: (m) => warnings.push(m),
    source,
  });
  return { files: res.files, summary: res.summary, warnings: [...new Set(warnings)], outDir, sourceFile: res.sourceFile, sourceManifest: res.sourceManifest };
}

/** `p` resolved inside `root`, crossing no symbolic link or junction on the way; throws otherwise. */
export function insideRoot(root: string, p: string): string {
  const abs = path.resolve(p), rel = path.relative(path.resolve(root), abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${p} is outside ${root}`);
  let current = path.resolve(root);
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`export paths cannot pass through the link ${current}`);
  }
  return abs;
}

type RecordedExport = Pick<ExportFiles, 'files' | 'sourceFile'>;
interface ExportRecord { source: ExportSource; files?: unknown; sha256?: Record<string, unknown> }
interface WriteOptions { overwrite?: boolean; packageDir?: string; hint?: string }

function readExportRecord(file: string | undefined): ExportRecord | null {
  if (!file) return null;
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof record?.source?.graph_sha256 === 'string' ? record : null;
  } catch { return null; }
}

function matchesHash(file: string, hash: unknown): boolean {
  if (typeof hash !== 'string') return false;
  try { return sha256Hex(fs.readFileSync(file)) === hash; } catch { return false; }
}

export class ExportConflict extends Error {
  readonly status = 409;
  readonly changed: string[];

  constructor(conflicts: Map<string, string>, hint: string) {
    super([...conflicts.values(), hint].join('\n'));
    this.changed = [...conflicts.keys()];
  }
}

/** Refuse every occupied path whose record cannot vouch for it, before writing any of the exports. */
export function checkExportFiles(exports: RecordedExport[], { overwrite, packageDir, hint = 'Choose another export path or allow this export to replace the file.' }: WriteOptions = {}): void {
  if (overwrite) return;
  const conflicts = new Map<string, string>();
  for (const { files, sourceFile } of exports) {
    const at = sourceFile && path.resolve(sourceFile);
    const record = readExportRecord(at);
    for (const f of files) {
      const abs = path.resolve(f.path);
      if (f.shared || abs === at || !fs.lstatSync(abs, { throwIfNoEntry: false })) continue;
      const name = at ? path.relative(path.dirname(at), abs).split(path.sep).join('/') : '';
      const listed = record?.sha256 && Object.hasOwn(record.sha256, name);
      if (listed && matchesHash(abs, record!.sha256![name])) continue;
      // a record written before records held hashes: its file list vouches for the files it names, and a format's own
      // sidecar, which lists none, for every file of its export
      if (record && !('sha256' in record) && (!Array.isArray(record.files) || record.files.includes(name))) continue;
      const rel = packageDir ? path.relative(packageDir, abs) : '';
      const display = rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : abs;
      conflicts.set(display, `${display} ${listed ? 'was changed after TopoTopo wrote it' : 'was not written by TopoTopo'}`);
    }
  }
  if (conflicts.size) throw new ExportConflict(conflicts, hint);
}

/** Write through .part files. A shared map already there with its size is left as it is. */
function writeFiles(files: ExportFile[], root?: string): number {
  let written = 0;
  try {
    for (const f of files) {
      const abs = root ? insideRoot(root, f.path) : path.resolve(f.path);
      if (f.shared && fs.statSync(abs, { throwIfNoEntry: false })?.size === f.bytes.byteLength) { written++; continue; }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs + '.part', f.bytes);
      fs.renameSync(abs + '.part', abs);
      written++;
    }
  } catch (e) { throw new Error(`export stopped after writing ${written} of ${files.length} files: ${(e as Error).message}`); }
  return written;
}

export function writeExportFiles(output: RecordedExport, options: WriteOptions = {}): number {
  checkExportFiles([output], options);
  return writeFiles(output.files);
}

/** A published output serialized to its target, ready to write. */
export interface PreparedTarget {
  graph: string;
  output: string | null;
  label: string;
  node: string;
  target: ResolvedTarget;
  /** the folder its files are written inside: the package's exports/ */
  root: string;
  files: ExportFile[];
  summary: string;
  warnings: string[];
  /** the file that records the export's source (a sidecar, the bundle manifest or <file>.source.json) */
  sourceFile?: string;
  /** the standalone <file>.source.json among files, when the format has no sidecar of its own */
  sourceManifest?: string;
}

/**
 * When a target's output was cooked: the engine's defaults (frame 1, 24 fps) unless the cook used others, and the
 * package versions the graph uses (src/graph/packages.ts packagesUsed).
 */
export interface TargetCook { frame?: number; fps?: number; packages?: Record<string, string>; files?: string }

/**
 * Serialize one published output to its target inside `exportsDir` (nothing is written yet); a target still written
 * with the export prefix that is gone is refused, saying what to write. The export records its source: the graph it is
 * published from (p.spec), its vars and seeds, the node, `cook`'s frame and fps, its packages.
 */
export async function prepareTarget(geo: Geometry, graph: string, p: PublishedOutput & { target: ResolvedTarget }, exportsDir: string, host: Host, cook: TargetCook = {}): Promise<PreparedTarget> {
  if (p.target.refused) throw Object.assign(new Error(`"${p.label}" (${graph}): ${prefixGone(p.target.refused)}`), { status: 400 });
  const root = exportsDir;
  const dest = insideRoot(root, path.join(root, ...p.target.path.split('/')));
  const source = exportSource({
    graph, spec: p.spec, node: p.node, output: p.output, frame: cook.frame, fps: cook.fps,
    format: p.target.format, options: p.target.options, packages: cook.packages, files: cook.files, version: TOPOTOPO_VERSION, engine: engineSha256(),
  });
  // every target of the package shares exports/maps/ (maps "external")
  const r = await serializeExport(geo, p.target.format, dest, p.target.options, host, source, path.join(root, 'maps'));
  for (const f of r.files) insideRoot(root, f.path);
  return {
    graph, output: p.output, label: p.label, node: p.node, target: p.target, root, files: r.files, summary: r.summary, warnings: r.warnings,
    sourceFile: r.sourceFile, sourceManifest: r.sourceManifest,
  };
}

/**
 * Whether a published output's last export into `exportsDir` would be made the same now (io/source.ts sameSource):
 * its receipt there, every file it wrote still in place, and the source block its record holds the same as the one an
 * export would record now (`cook`: its frame, fps, packages and files). Nothing is cooked.
 */
export function unchangedTarget(graph: string, p: PublishedOutput & { target: ResolvedTarget }, exportsDir: string, cook: TargetCook): boolean {
  if (p.target.refused || !cook.files) return false;
  const last = new ArtifactStore(exportsDir).records().filter((a) => a.label === p.target.path && a.graph === graph && (a.output ?? '') === (p.output ?? '')).pop();
  if (!last || !last.files.every((f) => fs.statSync(f, { throwIfNoEntry: false })?.isFile())) return false;
  const now = withExportOptions(exportSource({
    graph, spec: p.spec, node: p.node, output: p.output, frame: cook.frame, fps: cook.fps,
    format: p.target.format, options: p.target.options, packages: cook.packages, files: cook.files, version: TOPOTOPO_VERSION, engine: engineSha256(),
  }), resolvedExportOptions(p.target.format, p.target.options));
  // the record: the file among them that holds a source block (<file>.source.json or the format's sidecar)
  for (const f of last.files) {
    if (!/\.json$/i.test(f)) continue;
    const record = readExportRecord(f);
    if (!record) continue;
    return sameSource(record.source, now) && (!('sha256' in record) || !!record.sha256 && typeof record.sha256 === 'object' && !Array.isArray(record.sha256)
      && Object.entries(record.sha256).every(([name, hash]) => matchesHash(path.resolve(path.dirname(f), name), hash)));
  }
  return false;
}

/**
 * Write prepared targets and record the receipts of those inside `exportsDir` (the viewer lists that folder); two
 * targets writing one file are refused before any write.
 */
export function writeTargets(prepared: PreparedTarget[], exportsDir: string, options: WriteOptions = {}): number {
  const owner = new Map<string, PreparedTarget>(), shared = new Set<string>();
  for (const p of prepared) for (const f of p.files) {
    const key = path.resolve(f.path).toLowerCase(), other = owner.get(key);
    // a shared map is named by its content: the targets that use it write it once
    if (f.shared) { if (!other || other.files.some((x) => x.shared && path.resolve(x.path).toLowerCase() === key)) { owner.set(key, other ?? p); continue; } }
    // status: the viewer answers 409 (the request conflicts with itself); the CLI and MCP print the message
    if (other && other !== p) throw Object.assign(new Error(`"${other.label}" (${other.graph}) and "${p.label}" (${p.graph}) both write ${path.relative(p.root, f.path)}: give one a different export path`), { status: 409 });
    owner.set(key, p);
  }
  checkExportFiles(prepared, { packageDir: path.dirname(exportsDir), ...options });
  const store = new ArtifactStore(exportsDir);
  let written = 0;
  for (const p of prepared) {
    const files = p.files.filter((f) => { if (!f.shared) return true; const key = path.resolve(f.path).toLowerCase(); if (shared.has(key)) return false; shared.add(key); return true; });
    written += writeFiles(files, p.root);
    if (path.resolve(p.root) !== path.resolve(exportsDir)) continue;
    store.record(p.files.map((f) => f.path), { label: p.target.path, graph: p.graph, node: p.node, format: p.target.format, output: p.output ?? '' });
  }
  return written;
}
