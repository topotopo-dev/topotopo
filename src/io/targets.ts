// Export targets: where a graph's published outputs export to. graph.export is the default output's target and
// graph.outputs[id].export a named output's: a format name ("glb"), or {format, path?, ...the export tool's options},
// with the path inside the project's exports/ folder. The viewer's Export buttons, the MCP export tool and the CLI's
// --export-all resolve targets here, so one target writes the same files everywhere. Pure: no file system.
import type { ExportFormat } from './export.ts';
import type { ExportTarget, GraphSpec } from '../graph/types.ts';

/** Every export format with the label the viewer shows, in the order it offers them (a Record, so none is missing). */
export const FORMAT_LABELS: Record<ExportFormat, string> = {
  glb: 'GLB (one file, textures inside)', gltf: 'glTF (JSON, textures inside)', usda: 'USD (.usda)', obj: 'OBJ', geo: 'Houdini .geo',
  unreal_landscape: 'Unreal Landscape bundle (folder)', csv: 'CSV points (Unreal PCG)', pointsjson: 'Points JSON',
  textures: 'PNG textures (folder)', png16: 'Heightmap, 16-bit PNG', r16: 'Heightmap, RAW .r16', mask_png: 'Masks, PNG',
  ply: 'PLY', stl: 'STL', json: 'TopoTopo JSON',
};
export const TARGET_FORMATS = Object.keys(FORMAT_LABELS) as ExportFormat[];

const EXTENSIONS: Partial<Record<ExportFormat, string>> = { unreal_landscape: '', textures: '', png16: '.png', mask_png: '.png', pointsjson: '.points.json' };
/** The extension a target's file gets: '' for unreal_landscape and textures, which write a folder. */
export const targetExtension = (format: ExportFormat) => EXTENSIONS[format] ?? '.' + format;

/** A format name in canonical form ("USD" → usda), or null. */
export function targetFormat(f: unknown): ExportFormat | null {
  const s = typeof f === 'string' ? f.trim().toLowerCase() : '';
  const c = s === 'usd' ? 'usda' : s;
  return Object.hasOwn(FORMAT_LABELS, c) ? (c as ExportFormat) : null;
}

// the export tool's options (src/mcp/tools.ts), by value type
const BOOLEAN = ['split_by_name', 'materials', 'custom_attribs', 'vertex_colors', 'quantize', 'pcg', 'pcg_struct', 'meshes'];
const CHOICES: Record<string, unknown[]> = { up_axis: ['y', 'z'], compress: ['none', 'meshopt', 'draco'], tangents: ['auto', 'preserve', 'none'], instancing: ['packed', 'expand'], instances: ['rows', 'expand'], precision: [32, 64] };
const NUMBER = ['scale', 'height_min', 'height_max', 'tile_size', 'heightfield'];
const NAMES = ['attributes', 'layers'];
const OPTIONS = [...BOOLEAN, ...Object.keys(CHOICES), ...NUMBER, ...NAMES, 'layer'];

/** The export tool's options among `a` (the tool's arguments), those that are set. */
export function exportToolOptions(a: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(OPTIONS.filter((k) => a[k] !== undefined && a[k] !== null).map((k) => [k, a[k]]));
}

const MESH = { up_axis: 'y', scale: 1, instancing: 'packed' };
const GLTF = { ...MESH, split_by_name: true, custom_attribs: false, vertex_colors: false, materials: true, compress: 'none', quantize: false, tangents: 'auto' };
/** instance rows (csv / points.json of packed prims) write one GLB per source with these */
const ROWS = { instances: 'rows', meshes: true, materials: true, custom_attribs: false };

/**
 * The options a format reads, with the value each takes when it is not given. Every export passes them explicitly
 * (host/export-targets.ts serializeExport) and records them in its source block, so a record replays to the same bytes
 * even when a later version changes a default. Options whose default depends on the data (height_min / height_max:
 * the layer's range; attributes: all; layers) are recorded only when given.
 */
export function exportDefaults(format: ExportFormat, a: Record<string, unknown> = {}): Record<string, unknown> {
  switch (format) {
    case 'glb': case 'gltf': return { ...GLTF };
    case 'usda': return { ...MESH, split_by_name: true, custom_attribs: false, materials: true };
    case 'obj': return { ...MESH, split_by_name: true };
    case 'ply': return { ...MESH, custom_attribs: true };
    case 'stl': return { ...MESH };
    case 'json': return { instancing: 'packed' };
    case 'geo': return { precision: 64, instancing: 'packed' };
    // PCG rows are in Unreal centimetres unless a scale is given
    case 'csv': return { up_axis: 'y', scale: a.pcg || a.pcg_struct ? 100 : 1, pcg: false, pcg_struct: false, instancing: 'packed', ...ROWS };
    case 'pointsjson': return { up_axis: 'y', scale: 1, instancing: 'packed', ...ROWS };
    case 'png16': case 'r16': return { layer: 'height', heightfield: 0 };
    case 'mask_png': return a.layers ? { heightfield: 0 } : { layer: 'mask', heightfield: 0 };
    case 'unreal_landscape': return { layer: 'height', heightfield: 0, tile_size: 0, materials: true, custom_attribs: false };
    case 'textures': return {};
  }
  return {};
}

/** The options an export of `format` uses: the given ones over the format's defaults (keys sorted). */
export function resolvedExportOptions(format: ExportFormat, a: Record<string, unknown>): Record<string, unknown> {
  const o: Record<string, unknown> = { ...exportDefaults(format, a), ...exportToolOptions(a) };
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
}

/** "custom_attribs" → "--custom-attribs" */
const flagOf = (k: string) => '--' + k.replace(/_/g, '-');

/** Export options as CLI flags: booleans as --name / --no-name, lists comma-joined, the rest --name value. */
export function exportOptionFlags(o: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of Object.keys(o).sort()) {
    const v = o[k];
    if (v === undefined || v === null) continue;
    if (BOOLEAN.includes(k)) out.push(v ? flagOf(k) : '--no-' + k.replace(/_/g, '-'));
    else if (Array.isArray(v)) out.push(flagOf(k), v.join(','));
    else out.push(flagOf(k), String(v));
  }
  return out;
}

/**
 * The export options among CLI arguments (the reverse of exportOptionFlags): every option of the export tool as a flag.
 * Throws on a value the option does not take (targetError's checks).
 */
export function exportOptionsFromFlags(argv: string[]): Record<string, unknown> {
  const a: Record<string, unknown> = {};
  const val = (f: string) => { const i = argv.indexOf(f); if (i < 0) return undefined; const v = argv[i + 1]; if (v === undefined || v.startsWith('--')) throw new Error(`${f} needs a value`); return v; };
  for (const k of OPTIONS) {
    const f = flagOf(k);
    if (BOOLEAN.includes(k)) {
      const on = argv.includes(f), off = argv.includes('--no-' + k.replace(/_/g, '-'));
      if (on && off) throw new Error(`use ${f} or --no-${k.replace(/_/g, '-')}, not both`);
      if (on || off) a[k] = on;
      continue;
    }
    const v = val(f);
    if (v === undefined) continue;
    if (NAMES.includes(k)) a[k] = v.split(/[\s,]+/).filter(Boolean);
    else if (NUMBER.includes(k) || k === 'precision') { const n = Number(v); if (!Number.isFinite(n)) throw new Error(`${f} expects a number, got "${v}"`); a[k] = n; }
    else a[k] = v;
  }
  // --pcg-struct implies --pcg (the struct cells are a PCG layout)
  if (a.pcg_struct === true && a.pcg === undefined) a.pcg = true;
  const err = targetError({ format: 'glb', ...a });
  if (err) throw new Error(err.replace(/^export option /, '').replace(/^(\w+)/, (m) => flagOf(m)));
  return a;
}

/** A path segment Windows and POSIX both accept, and that cannot climb out of exports/. */
const segmentOk = (s: string) => !!s && s !== '.' && s !== '..' && !/[<>:"|?*\x00-\x1f]/.test(s) && !/[. ]$/.test(s) && !/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(s);
const pathOk = (p: unknown) => typeof p === 'string' && p.length <= 240 && !/^[A-Za-z]:|^[\\/]/.test(p) && p.replace(/\\/g, '/').split('/').every(segmentOk);

/** Why a target is invalid, or null when it is valid. */
export function targetError(t: unknown): string | null {
  const o: any = typeof t === 'string' ? { format: t } : t;
  if (!o || typeof o !== 'object' || Array.isArray(o)) return 'export must be a format name ("glb") or {format, path?, ...options}';
  if (!targetFormat(o.format)) return `export format "${o.format}" is not one of ${TARGET_FORMATS.join(', ')} (or usd)`;
  if (o.path !== undefined && !pathOk(o.path)) return `export path "${o.path}" must stay inside exports/: relative, without "..", a drive or a leading slash`;
  for (const [k, v] of Object.entries(o)) {
    if (k === 'format' || k === 'path') continue;
    if (!OPTIONS.includes(k)) return `unknown export option "${k}" (options: ${OPTIONS.join(', ')})`;
    if (BOOLEAN.includes(k) && typeof v !== 'boolean') return `export option ${k} must be true or false`;
    if (k in CHOICES && !CHOICES[k].includes(v)) return `export option ${k} must be one of ${CHOICES[k].join(', ')}`;
    if (NUMBER.includes(k) && !(typeof v === 'number' && Number.isFinite(v))) return `export option ${k} must be a number`;
    if (k === 'scale' && !((v as number) > 0)) return 'export option scale must be positive';
    if (NAMES.includes(k) && !(Array.isArray(v) && v.every((s) => typeof s === 'string'))) return `export option ${k} must be a list of names`;
    if (k === 'layer' && typeof v !== 'string') return 'export option layer must be a name';
  }
  return null;
}

export interface ResolvedTarget {
  format: ExportFormat;
  /** posix path inside exports/: a file, or a folder for unreal_landscape and textures */
  path: string;
  /** the export tool's options (up_axis, scale, …) */
  options: Record<string, unknown>;
}

/** A file name stem from an output id or graph name. */
export const fileStem = (s: string) => s.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^\.+|[. ]+$/g, '') || 'output';

/** A valid target with its path filled in: <stem><extension> unless it names one. */
export function resolveTarget(t: ExportTarget, stem: string): ResolvedTarget {
  const { format, path, ...options } = typeof t === 'string' ? { format: t } : t;
  const f = targetFormat(format)!;
  return { format: f, path: (typeof path === 'string' ? path : fileStem(stem) + targetExtension(f)).replace(/\\/g, '/'), options };
}

export interface PublishedOutput {
  /** the id in graph.outputs, or null for a default output that is no named output (its target is graph.export) */
  output: string | null;
  node: string;
  label: string;
  /** the graph's default output (its output node): one entry, a named output when one is that node */
  default: boolean;
  target: ResolvedTarget | null;
  /** the graph it is published from: a target export records it in its source block (io/source.ts) */
  spec: GraphSpec;
}

/**
 * A graph's results, the default output first, each once and with its target if valid. The default output (the graph's
 * output node) is the first named output of that node, when there is one, and keeps its own target (or graph.export,
 * named after the graph, when it has none); otherwise it is an entry of its own, named after the graph, whose target
 * is graph.export.
 */
export function publishedOutputs(graph: string, spec: GraphSpec, defaultNode: string): PublishedOutput[] {
  const valid = (t: unknown) => (t !== undefined && t !== null && !targetError(t) ? (t as ExportTarget) : null);
  const main = valid(spec.export);
  const named = Object.entries(spec.outputs ?? {}), dflt = named.find(([, o]) => o?.node === defaultNode)?.[0];
  const outputs: PublishedOutput[] = named.map(([id, o]) => {
    const own = valid(o?.export), t = own ?? (id === dflt ? main : null);
    return { output: id, node: o.node, label: o.label ?? id, default: id === dflt, target: t ? resolveTarget(t, own ? id : graph) : null, spec };
  });
  if (dflt !== undefined) return [...outputs.filter((p) => p.default), ...outputs.filter((p) => !p.default)];
  return [{ output: null, node: defaultNode, label: graph, default: true, target: main ? resolveTarget(main, graph) : null, spec }, ...outputs];
}
