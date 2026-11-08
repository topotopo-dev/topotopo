// Export sources: how an export was made, so it can be made again. Every export written through the CLI (--export,
// --export-all), the MCP export tool and graph export targets (the viewer's Export buttons) records a "source" block:
//   graph          the graph's name (for the CLI, the graph file's name without .json)
//   graph_sha256   SHA-256 of the graph JSON as cooked: vars after overrides, format version stamped, keys sorted,
//                  no whitespace (canonicalJSON), so a reformatted file hashes the same
//   nodes_sha256   SHA-256 of the part of the graph the node's cook reads (nodesRead: the node, the nodes its inputs
//                  and its params' strings name, theirs in turn; without their ui and note) and the graph's strict, so
//                  an edit to another output's nodes leaves it as it was
//   files_sha256   only for a graph in a package: SHA-256 of the package files its cook may read besides the graph
//                  file (its other graphs, assets/ and inputs/: src/packages/registry.ts packageFilesHash)
//   output         the named output exported (graph.outputs), or null (a node, or the default output)
//   node           the node that was cooked
//   frame, fps     the cook time
//   vars           every var of the graph after overrides (CLI --var), keys sorted
//   seeds          the seed params the graph sets, by node ("loop/pts" inside a nested graph), as written
//   packages       only when the graph uses packages (src/graph/packages.ts packagesUsed): "owner/name@version" → the
//                  version's hash for every package version it uses, directly or through other packages (an export
//                  made while following a working folder cooks with the published copies, so it names those), and
//                  "owner/name@working" → the hash of a working folder an export was told to follow (CLI --follow,
//                  MCP export follow)
//   followed       only when it used working folders ("owner/name@working" under packages): those packages, sorted.
//                  They are no published version: the export is made again only from those folders as they were
//                  (their hash says whether they still are), replay passes --follow for each
//   export         {format, options}: the export options given (the export tool's names)
//   package        only on a package's outputs cooked for an engine (topotopo cook --for godot, src/host/cook.ts): the
//                  package's publish name, else its id; the cook replaces a file at an output path only when it names
//                  this package (or the cook record lists the file)
//   topotopo       the version that wrote it
//   engine_sha256  SHA-256 of the engine's own code that wrote it (src/host/engine-code.ts: its src/ or dist/ tree,
//                  kernels, fonts and package.json), as a source checkout keeps one version through many changes;
//                  the Node host records it, and an export is never kept as unchanged without it
// Formats that write a sidecar or manifest carry the block there (png16 / r16: <name>.json; csv / points.json instance
// rows: <name>.meshes.json; unreal_landscape: its landscape.json); every other export gets <file>.source.json next to
// it (textures, a folder: source.json inside it), and glb / gltf also carry it in asset.extras.source. Nothing in the
// block depends on the time or the machine: the same graph and values give the same bytes. Pure: no file system.
import { isGraph } from '../graph/types.ts';
import type { GraphSpec } from '../graph/types.ts';
import { norm } from '../graph/params.ts';
import { sha256Hex } from '../core/sha256.ts';
import { dirOf } from './common.ts';

export interface ExportSource {
  graph: string;
  graph_sha256: string;
  nodes_sha256: string;
  /** the package files the cook may read (absent for a graph in no package) */
  files_sha256?: string;
  output: string | null;
  node: string;
  frame: number;
  fps: number;
  vars: Record<string, unknown>;
  seeds: Record<string, unknown>;
  /** the package versions the graph uses (absent when it uses none) */
  packages?: Record<string, string>;
  /** the packages exported from their working folders, no published version (absent when none) */
  followed?: string[];
  export: { format: string; options: Record<string, unknown> };
  /** the package an engine cook made it for: its publish name, else its id (absent elsewhere) */
  package?: string;
  topotopo: string;
  /** the engine's code hash (absent when the host did not give it) */
  engine_sha256?: string;
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
  /** an engine cook: the package it cooks for (ExportSource.package) */
  package?: string;
  /** the hash of the package files the cook may read besides the graph (ExportSource.files_sha256), if in a package */
  files?: string;
  /** the TopoTopo version */
  version: string;
  /** the engine's code hash (src/host/engine-code.ts engineSha256) */
  engine?: string;
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

/** SHA-256 of a graph document (canonicalJSON). */
export function graphSha256(spec: GraphSpec): string {
  return sha256Hex(canonicalJSON(spec));
}


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

/** The packages a packagesUsed record names by working folder ("owner/name@working"), sorted. */
const followedIn = (packages: Record<string, string> | undefined) =>
  Object.keys(packages ?? {}).filter((k) => k.endsWith('@working')).map((k) => k.slice(0, -'@working'.length)).sort();

/** The source block of an export. */
export function exportSource(i: SourceInput): ExportSource {
  const spec = i.spec;
  return {
    graph: i.graph,
    graph_sha256: sha256Hex(canonicalJSON(spec)),
    nodes_sha256: nodesSha256(spec, i.node),
    ...(i.files ? { files_sha256: i.files } : {}),
    output: i.output ?? null,
    node: i.node,
    frame: i.frame ?? 1,
    fps: i.fps ?? 24,
    vars: sorted(spec.vars ?? {}),
    seeds: graphSeeds(spec),
    ...(i.packages && Object.keys(i.packages).length ? { packages: sorted(i.packages) } : {}),
    ...(followedIn(i.packages).length ? { followed: followedIn(i.packages) } : {}),
    export: { format: i.format, options: sorted(i.options ?? {}) },
    ...(i.package ? { package: i.package } : {}),
    topotopo: i.version,
    ...(i.engine ? { engine_sha256: i.engine } : {}),
  };
}

/**
 * The nodes of a graph a cook of `node` may read: the node, the nodes its inputs name and those any string of its
 * params names as a word (an "=expr" reference such as ch("../box/size"), a nested graph's), then theirs in turn.
 * What the engine pulls, and maybe more. Sorted.
 */
export function nodesRead(spec: GraphSpec, node: string): string[] {
  const nodes = spec.nodes ?? {}, seen = new Set<string>(), todo = [node];
  const words = (v: unknown, out: Set<string>, depth: number) => {
    if (depth > 64) return;
    if (typeof v === 'string') {
      for (const w of v.match(/[\w.-]+/g) ?? []) { out.add(w); for (const part of w.split(/[.-]+/)) out.add(part); }
    } else if (v && typeof v === 'object') for (const x of Object.values(v)) words(x, out, depth + 1);
  };
  while (todo.length) {
    const n = todo.pop()!;
    if (seen.has(n) || !Object.hasOwn(nodes, n)) continue;
    seen.add(n);
    const named = new Set<string>();
    words(nodes[n]?.in, named, 0);
    words(nodes[n]?.params, named, 0);
    for (const w of named) if (!seen.has(w) && Object.hasOwn(nodes, w)) todo.push(w);
  }
  return [...seen].sort();
}

/** nodes_sha256: the nodes a cook of `node` reads (nodesRead) without their ui and note, and the graph's strict. */
export function nodesSha256(spec: GraphSpec, node: string): string {
  const nodes: Record<string, unknown> = {};
  for (const n of nodesRead(spec, node)) {
    const { ui: _ui, note: _note, ...rest } = spec.nodes[n] ?? {};
    nodes[n] = rest;
  }
  return sha256Hex(canonicalJSON({ nodes, strict: spec.strict ?? false }));
}

/**
 * Whether an export recorded with the block `prev` would be made the same now, as `now`: every field the same but the
 * whole graph's hash and seeds (an edit to other nodes of the graph; its own nodes and seeds are in nodes_sha256).
 * Never without files_sha256 (a graph in no package, whose files are not known) or engine_sha256 (the engine's code,
 * which may have changed under the same version).
 */
export function sameSource(prev: unknown, now: ExportSource): boolean {
  if (!now.files_sha256 || !now.engine_sha256 || !prev || typeof prev !== 'object') return false;
  const key = (s: object) => { const { graph_sha256: _g, seeds: _s, ...rest } = s as ExportSource; return canonicalJSON(rest); };
  return key(prev) === key(now);
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
    ...(s.followed ?? []).flatMap((p) => ['--follow', p]),
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
  // a file beside or below the manifest by its path from there; one elsewhere (a shared maps folder) climbs with ".."
  const rel = (p: string) => {
    const q = p.replace(/\\/g, '/');
    if (!dir) return q;
    if (q.startsWith(dir + '/')) return q.slice(dir.length + 1);
    const a = dir.split('/'), b = q.split('/');
    let i = 0;
    while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
    return i ? [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/') : b[b.length - 1];
  };
  return new TextEncoder().encode(JSON.stringify({ format: 'topotopo-export-source', version: 1, files: files.map(rel), source }, null, 2) + '\n');
}
