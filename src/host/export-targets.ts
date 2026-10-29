// Writing exports for the CLI, the MCP server and the viewer: serialize with the export tool's options, then write
// each file through a .part beside it, renamed into place. Published targets (io/targets.ts) write inside exports/
// only, and every target is serialized before any file is written, so a failed cook or format changes nothing.
// exports/ is the project's (exportsFolderFor): the folder of the nearest project.json above the graph, so a graph in
// <project>/graphs/ exports into <project>/exports/, from the CLI, the MCP server and the viewer alike; a graph file in
// no project exports beside itself.
// Every export records how it was made (io/source.ts): the caller passes the source block, and a target builds its own
// from the graph it is published from.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { Geometry } from '../core/geometry.ts';
import type { ExportFormat } from '../io/export.ts';
import { exportFilesAsync } from '../io/files.ts';
import type { ExportFile } from '../io/files.ts';
import { exportSource, withExportOptions } from '../io/source.ts';
import { resolvedExportOptions } from '../io/targets.ts';
import type { ExportSource } from '../io/source.ts';
import type { PublishedOutput, ResolvedTarget } from '../io/targets.ts';
import { ArtifactStore } from './artifacts.ts';
import type { Host } from './types.ts';
import { TOPOTOPO_VERSION } from './version.ts';

/** The project a path lies in: the nearest folder holding project.json, the path's own or one above it; null for none. */
export function projectFolderOf(p: string): string | null {
  let d = path.resolve(p);
  if (fs.statSync(d, { throwIfNoEntry: false })?.isFile()) d = path.dirname(d);
  for (;;) {
    if (fs.existsSync(path.join(d, 'project.json'))) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/**
 * Where a graph file's exports go: its project's exports/ folder (the nearest project.json above it), else exports/
 * beside the graph. One rule for the CLI (--export-all, its receipts), `topotopo view` and the MCP server (whose
 * workspace is the project folder).
 */
export function exportsFolderFor(graphFile: string): string {
  const file = path.resolve(graphFile);
  return path.join(projectFolderOf(path.dirname(file)) ?? path.dirname(file), 'exports');
}

/**
 * The files an export writes, nothing written yet; `a` holds the export tool's snake_case options. Every option the
 * format reads is passed explicitly, the given ones over the format's defaults (io/targets.ts exportDefaults), and the
 * source block records exactly those, so the record replays to the same bytes.
 */
export async function serializeExport(geo: Geometry, format: ExportFormat, p: string, given: Record<string, any>, host: Host, source?: ExportSource) {
  const a: Record<string, any> = resolvedExportOptions(format, given);
  if (source) source = withExportOptions(source, a);
  const warnings: string[] = [];
  const outDir = format === 'unreal_landscape' && !/\.json$/i.test(p) ? p : path.dirname(p);
  const res = await exportFilesAsync(geo, format, p, {
    upAxis: a.up_axis, scale: a.scale, splitByName: a.split_by_name ?? true, custom: a.custom_attribs,
    materials: a.materials, compress: a.compress, quantize: a.quantize, tangents: a.tangents, attributes: a.attributes, pcg: a.pcg || a.pcg_struct, pcgStruct: a.pcg_struct,
    precision: a.precision, instancing: a.instancing, instances: a.instances, meshes: a.meshes,
    layer: a.layer, layers: a.layers, heightMin: a.height_min, heightMax: a.height_max, heightfield: a.heightfield, tile_size: a.tile_size,
    deflate: (d) => zlib.deflateSync(d, { level: 6 }),
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

/** Write files, each through a .part renamed into place; with `root`, each must stay inside it. Returns the count. */
export function writeExportFiles(files: ExportFile[], root?: string): number {
  let written = 0;
  try {
    for (const f of files) {
      const abs = root ? insideRoot(root, f.path) : path.resolve(f.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs + '.part', f.bytes);
      fs.renameSync(abs + '.part', abs);
      written++;
    }
  } catch (e) { throw new Error(`export stopped after writing ${written} of ${files.length} files: ${(e as Error).message}`); }
  return written;
}

/** A published output serialized to its target, ready to write. */
export interface PreparedTarget {
  graph: string;
  output: string | null;
  label: string;
  node: string;
  target: ResolvedTarget;
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
export interface TargetCook { frame?: number; fps?: number; packages?: Record<string, string> }

/**
 * Serialize one published output to its target inside `exportsDir` (nothing is written yet). The export records its
 * source: the graph it is published from (p.spec), its vars and seeds, the node, `cook`'s frame and fps, its packages.
 */
export async function prepareTarget(geo: Geometry, graph: string, p: PublishedOutput & { target: ResolvedTarget }, exportsDir: string, host: Host, cook: TargetCook = {}): Promise<PreparedTarget> {
  const dest = insideRoot(exportsDir, path.join(exportsDir, ...p.target.path.split('/')));
  const source = exportSource({
    graph, spec: p.spec, node: p.node, output: p.output, frame: cook.frame, fps: cook.fps,
    format: p.target.format, options: p.target.options, packages: cook.packages, version: TOPOTOPO_VERSION,
  });
  const r = await serializeExport(geo, p.target.format, dest, p.target.options, host, source);
  for (const f of r.files) insideRoot(exportsDir, f.path);
  return {
    graph, output: p.output, label: p.label, node: p.node, target: p.target, files: r.files, summary: r.summary, warnings: r.warnings,
    sourceFile: r.sourceFile, sourceManifest: r.sourceManifest,
  };
}

/** Write prepared targets and record their receipts; two targets writing one file are refused before any write. */
export function writeTargets(prepared: PreparedTarget[], exportsDir: string): number {
  const owner = new Map<string, PreparedTarget>();
  for (const p of prepared) for (const f of p.files) {
    const key = path.resolve(f.path).toLowerCase(), other = owner.get(key);
    // status: the viewer answers 409 (the request conflicts with itself); the CLI and MCP print the message
    if (other && other !== p) throw Object.assign(new Error(`"${other.label}" (${other.graph}) and "${p.label}" (${p.graph}) both write ${path.relative(exportsDir, f.path)}: give one a different export path`), { status: 409 });
    owner.set(key, p);
  }
  const store = new ArtifactStore(exportsDir);
  let written = 0;
  for (const p of prepared) {
    written += writeExportFiles(p.files, exportsDir);
    store.record(p.files.map((f) => f.path), { label: p.target.path, graph: p.graph, node: p.node, format: p.target.format, output: p.output ?? '' });
  }
  return written;
}
