// Writing exports for the CLI, the MCP server and the viewer: serialize with the export tool's options, then write
// each file through a .part beside it, renamed into place. Published targets (io/targets.ts) write inside exports/
// only, and every target is serialized before any file is written, so a failed cook or format changes nothing.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { Geometry } from '../core/geometry.ts';
import type { ExportFormat } from '../io/export.ts';
import { exportFilesAsync } from '../io/files.ts';
import type { ExportFile } from '../io/files.ts';
import type { PublishedOutput, ResolvedTarget } from '../io/targets.ts';
import { ArtifactStore } from './artifacts.ts';
import type { Host } from './types.ts';

/** The files an export writes, nothing written yet; `a` holds the export tool's snake_case options. */
export async function serializeExport(geo: Geometry, format: ExportFormat, p: string, a: Record<string, any>, host: Host) {
  const warnings: string[] = [];
  const outDir = format === 'unreal_landscape' && !/\.json$/i.test(p) ? p : path.dirname(p);
  const res = await exportFilesAsync(geo, format, p, {
    upAxis: a.up_axis, scale: a.scale, splitByName: a.split_by_name ?? true, custom: a.custom_attribs,
    materials: a.materials, compress: a.compress, quantize: a.quantize, attributes: a.attributes, pcg: a.pcg || a.pcg_struct, pcgStruct: a.pcg_struct,
    precision: a.precision, instancing: a.instancing, instances: a.instances, meshes: a.meshes,
    layer: a.layer, layers: a.layers, heightMin: a.height_min, heightMax: a.height_max, heightfield: a.heightfield, tile_size: a.tile_size,
    deflate: (d) => zlib.deflateSync(d, { level: 6 }),
    readFile: (t) => host.readFile(t),
    texturePath: (t) => {
      const abs = host.resolvePath(t);
      return /^[a-z][a-z0-9+.-]*:\/\//i.test(abs) ? abs : path.relative(outDir, abs).split(path.sep).join('/');
    },
    warn: (m) => warnings.push(m),
  });
  return { files: res.files, summary: res.summary, warnings: [...new Set(warnings)], outDir };
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
}

/** Serialize one published output to its target inside `exportsDir` (nothing is written yet). */
export async function prepareTarget(geo: Geometry, graph: string, p: PublishedOutput & { target: ResolvedTarget }, exportsDir: string, host: Host): Promise<PreparedTarget> {
  const dest = insideRoot(exportsDir, path.join(exportsDir, ...p.target.path.split('/')));
  const r = await serializeExport(geo, p.target.format, dest, p.target.options, host);
  for (const f of r.files) insideRoot(exportsDir, f.path);
  return { graph, output: p.output, label: p.label, node: p.node, target: p.target, files: r.files, summary: r.summary, warnings: r.warnings };
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
