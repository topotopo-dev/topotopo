// Export sources: how an export was made, so it can be made again. Every export written through the CLI (--export,
// --export-all), the MCP export tool and graph export targets (the viewer's Export buttons) records a "source" block:
//   graph          the graph's name (for the CLI, the graph file's name without .json)
//   graph_sha256   SHA-256 of the graph JSON as cooked: vars after overrides, format version stamped, keys sorted,
//                  no whitespace (canonicalJSON), so a reformatted file hashes the same
//   output         the named output exported (graph.outputs), or null (a node, or the default output)
//   node           the node that was cooked
//   frame, fps     the cook time
//   vars           every var of the graph after overrides (CLI --var), keys sorted
//   seeds          the seed params the graph sets, by node ("loop/pts" inside a nested graph), as written
//   packages       only when the graph uses packages (src/graph/packages.ts packagesUsed): "owner/name@version" → the
//                  version's hash for every package version it uses, directly or through other packages, and
//                  "owner/name@working" → the hash of the files of a working folder followed this session
//   export         {format, options}: the export options given (the export tool's names)
//   topotopo       the version that wrote it
// Formats that write a sidecar or manifest carry the block there (png16 / r16: <name>.json; csv / points.json instance
// rows: <name>.meshes.json; unreal_landscape: its landscape.json); every other export gets <file>.source.json next to
// it (textures, a folder: source.json inside it), and glb / gltf also carry it in asset.extras.source. Nothing in the
// block depends on the time or the machine: the same graph and values give the same bytes. Pure: no file system.
import type { GraphSpec } from '../graph/types.ts';
import { migrateGraph } from '../graph/migrate.ts';
import { norm } from '../graph/params.ts';
import { sha256Hex } from '../core/sha256.ts';
import { dirOf } from './common.ts';

export interface ExportSource {
  graph: string;
  graph_sha256: string;
  output: string | null;
  node: string;
  frame: number;
  fps: number;
  vars: Record<string, unknown>;
  seeds: Record<string, unknown>;
  /** the package versions the graph uses (absent when it uses none) */
  packages?: Record<string, string>;
  export: { format: string; options: Record<string, unknown> };
  topotopo: string;
}

export interface SourceInput {
  /** the graph's name */
  graph: string;
  /** the graph as cooked (vars after overrides) */
  spec: GraphSpec;
  /** the node that was cooked */
  node: string;
  /** the named output exported, if one was */
  output?: string | null;
  /** cook time (the engine's defaults: frame 1, 24 fps) */
  frame?: number;
  fps?: number;
  format: string;
  /** the export options given, by the export tool's names (up_axis, scale, …) */
  options?: Record<string, unknown>;
  /** the package versions the cooked graph uses (packagesUsed) */
  packages?: Record<string, string>;
  /** the TopoTopo version */
  version: string;
}

/** The name of a standalone source manifest: next to the export file it describes. */
export const SOURCE_SUFFIX = '.source.json';

/** JSON with every object's keys in sorted order and no whitespace: equal content gives equal text. */
export function canonicalJSON(v: unknown): string {
  return JSON.stringify(v, (_k, x) => {
    if (!x || typeof x !== 'object' || Array.isArray(x) || ArrayBuffer.isView(x)) return x;
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(x).sort()) o[k] = (x as Record<string, unknown>)[k];
    return o;
  }) ?? 'null';
}

/** A deep copy with sorted keys (undefined dropped), as plain JSON data. */
const sorted = <T>(v: T): T => JSON.parse(canonicalJSON(v));

/** SHA-256 of a graph document (migrated, then canonicalJSON). */
export function graphSha256(spec: GraphSpec): string {
  return sha256Hex(canonicalJSON(migrateGraph(spec)));
}

const isGraph = (v: unknown): v is GraphSpec => !!v && typeof v === 'object' && !Array.isArray(v) && !!(v as GraphSpec).nodes && typeof (v as GraphSpec).nodes === 'object';

/** The seed params a graph sets (param names compared as the engine does), by node path, keys sorted. */
export function graphSeeds(spec: GraphSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (g: GraphSpec, prefix: string, depth: number) => {
    if (depth > 64) return;
    for (const [name, node] of Object.entries(g.nodes ?? {})) {
      if (!node || typeof node !== 'object' || !node.params || typeof node.params !== 'object') continue;
      for (const [k, v] of Object.entries(node.params)) {
        if (norm(k) === 'seed') out[prefix + name] = v;
        else if (isGraph(v)) walk(v, `${prefix}${name}/`, depth + 1);
      }
    }
  };
  walk(spec, '', 0);
  return sorted(out);
}

/** The source block of an export. */
export function exportSource(i: SourceInput): ExportSource {
  const spec = migrateGraph(i.spec);
  return {
    graph: i.graph,
    graph_sha256: sha256Hex(canonicalJSON(spec)),
    output: i.output ?? null,
    node: i.node,
    frame: i.frame ?? 1,
    fps: i.fps ?? 24,
    vars: sorted(spec.vars ?? {}),
    seeds: graphSeeds(spec),
    ...(i.packages && Object.keys(i.packages).length ? { packages: sorted(i.packages) } : {}),
    export: { format: i.format, options: sorted(i.options ?? {}) },
    topotopo: i.version,
  };
}

/** The source block with these export options (an export records the options it used, defaults included). */
export function withExportOptions(s: ExportSource, options: Record<string, unknown>): ExportSource {
  return { ...s, export: { format: s.export.format, options: sorted(options) } };
}

/**
 * The command line that makes an export again from its source block: the output (or node), frame, fps, every var as
 * JSON, the format and every export option as its flag (io/targets.ts exportOptionFlags), then --export <path>.
 * Run it on the graph file the block names (its graph_sha256 says whether the file still is the one exported).
 */
export function replayArgs(s: ExportSource, exportPath: string, flags: (o: Record<string, unknown>) => string[]): string[] {
  return [
    ...(s.output ? ['--output', s.output] : ['--node', s.node]),
    '--frame', String(s.frame), '--fps', String(s.fps),
    ...Object.entries(s.vars).flatMap(([k, v]) => ['--var', `${k}=${JSON.stringify(v)}`]),
    '--format', s.export.format, ...flags(s.export.options), '--export', exportPath,
  ];
}

/**
 * A standalone source manifest: the files of the export (relative to the manifest's folder, "/" separated) and the
 * source block.
 */
export function sourceManifestBytes(source: ExportSource, manifestPath: string, files: string[]): Uint8Array {
  const dir = dirOf(manifestPath).replace(/\\/g, '/');
  const rel = (p: string) => {
    const q = p.replace(/\\/g, '/');
    return dir && q.startsWith(dir + '/') ? q.slice(dir.length + 1) : dir ? q.slice(q.lastIndexOf('/') + 1) : q;
  };
  return new TextEncoder().encode(JSON.stringify({ format: 'topotopo-export-source', version: 1, files: files.map(rel), source }, null, 2) + '\n');
}
