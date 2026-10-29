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

/** The export tool's options among `a` (the tool's arguments), those that are set: what an export's source records. */
export function exportToolOptions(a: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(OPTIONS.filter((k) => a[k] !== undefined && a[k] !== null).map((k) => [k, a[k]]));
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
  /** null for the graph's default output (graph.export), else the id in graph.outputs */
  output: string | null;
  node: string;
  label: string;
  target: ResolvedTarget | null;
  /** the graph it is published from: a target export records it in its source block (io/source.ts) */
  spec: GraphSpec;
}

/** A graph's default output (its files named after the graph) and its named outputs, each with its target if valid. */
export function publishedOutputs(graph: string, spec: GraphSpec, defaultNode: string): PublishedOutput[] {
  const valid = (t: unknown) => (t !== undefined && t !== null && !targetError(t) ? (t as ExportTarget) : null);
  const main = valid(spec.export);
  return [
    { output: null, node: defaultNode, label: 'Main output', target: main ? resolveTarget(main, graph) : null, spec },
    ...Object.entries(spec.outputs ?? {}).map(([id, o]) => {
      const t = valid(o?.export);
      return { output: id, node: o.node, label: o.label ?? id, target: t ? resolveTarget(t, id) : null, spec };
    }),
  ];
}
