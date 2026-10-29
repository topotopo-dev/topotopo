// What a cooked output is, and the export formats that fit it. Everything that shows an output (the viewer's cards and
// Properties, the Packages tab, the Gallery, search and help) says what it is with one word, its kind: mesh, instances,
// points, curves, terrain, textures, material, volume, or scene for several of these (graph/outputs.ts KINDS). The viewer decides
// it from the cooked geometry (OutputInfo.published) and says its size in a line beside it: "2,400 polygons, 1,204
// points", "1,200 instances of 3 sources", "2049 × 2049 samples, 2 m apart", "1024 × 1024 px", a scene's parts each by
// kind ("terrain 2049 × 2049, 2 m + 1,200 instances of 3 sources"), and the bounding size. Internally an output is made
// of parts (heightfield, mesh, instances, curves, points, image, material, volume): format menus offer only the formats that write
// them, PART_FORMATS listing the formats that write each part, best first, as the exporters do (test/viewer-outputs.ts
// exports every part in every format to check it), and a format that needs a heightfield or an image is offered only
// with one. A package records the same kind for each output it publishes (publishedKind). Pure: no file system.
import type { Geometry } from '../core/geometry.ts';
import type { Kind } from '../graph/outputs.ts';
import { heightfieldsOf, layerStats } from '../core/heightfield.ts';
import { referenceableImages } from '../core/image.ts';
import { readMaterials } from '../core/materials.ts';
import type { ExportFormat } from './export.ts';
import { FORMAT_LABELS, targetExtension } from './targets.ts';
import { SOURCE_INSIDE, formatWrites } from './files.ts';

/** What an output can hold, in the order a mixed output names them (its main part first). */
export const OUTPUT_PARTS = ['heightfield', 'mesh', 'instances', 'curves', 'points', 'image', 'material', 'volume'] as const;
export type OutputPart = (typeof OUTPUT_PARTS)[number];
/** One part, several (mixed), or nothing. */
export type OutputKind = OutputPart | 'mixed' | 'empty';

/**
 * The formats that write each part, best first. json (TopoTopo JSON, lossless) writes everything except analytic
 * SDFs; obj, ply and stl write packed instances expanded into geometry; unreal_landscape writes the prims (meshes,
 * curves, instances) beside the heightfield it needs. Images here are image outputs: glb, gltf and usda also write the
 * textures their materials use.
 */
export const PART_FORMATS: Record<OutputPart, readonly ExportFormat[]> = {
  heightfield: ['png16', 'r16', 'mask_png', 'unreal_landscape', 'json'],
  instances: ['glb', 'usda', 'csv', 'pointsjson', 'gltf', 'geo', 'unreal_landscape', 'obj', 'ply', 'stl', 'json'],
  mesh: ['glb', 'gltf', 'usda', 'obj', 'ply', 'stl', 'geo', 'unreal_landscape', 'json'],
  curves: ['glb', 'gltf', 'usda', 'obj', 'geo', 'unreal_landscape', 'json'],
  points: ['csv', 'pointsjson', 'ply', 'geo', 'glb', 'gltf', 'usda', 'json'],
  image: ['textures', 'json'],
  material: ['textures', 'json'],
  volume: ['json'],
};

export interface HeightfieldInfo {
  name: string;
  /** samples along X and Z */
  width: number;
  height: number;
  /** sample spacing (metres) */
  cell: number;
  /** every layer with its range */
  layers: { name: string; min: number; max: number }[];
}

export interface OutputInfo {
  kind: OutputKind;
  /** its kind in the words everything shows (graph/outputs.ts KINDS: terrain, textures, scene …), null when empty */
  published: Kind | null;
  /** the parts it holds, main first (OUTPUT_PARTS order) */
  parts: OutputPart[];
  /** its size in a few words, beside its kind: "2049 × 2049 samples, 2 m apart"; a scene's parts each by kind */
  text: string;
  /** bounding box size (x, y, z) in metres; null for images alone and for nothing */
  size: [number, number, number] | null;
  /** the first heightfield, and how many there are */
  heightfield?: HeightfieldInfo;
  heightfields: number;
  /** the images it carries (its own and its packed sources'), as an image output or as textures of its parts */
  images: number;
  /** the materials of a material output (none for the other kinds: their materials belong to their parts) */
  materials: number;
  /** sampled SDF grids (TopoTopo JSON stores them; analytic SDFs are functions, which no format writes) */
  grids: number;
}

const n = (x: number) => String(Math.round(x)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const count = (x: number, one: string, many = one + 's') => `${n(x)} ${x === 1 ? one : many}`;
/** A length with decimals that suit it: 0.25, 2, 12.5, 4096. */
const len = (m: number) => { const a = Math.abs(m); return String(+m.toFixed(a === 0 || a >= 1000 ? 0 : a >= 100 ? 1 : a >= 1 ? 2 : 3)); };

/** What a cooked geometry is. */
export function outputKind(g: Geometry): OutputInfo {
  let polygons = 0, polylines = 0, splines = 0, packed = 0;
  const used = new Uint8Array(g.numPoints);
  for (let p = 0; p < g.numPrims; p++) {
    const k = g.primKind ? g.primKind[p] : 0;
    if (k === 1) packed++;
    else if (k === 2 || k === 3) splines++;
    else if (g.primClosed[p]) polygons++;
    else polylines++;
  }
  for (let v = 0; v < g.numVertices; v++) used[g.vertexPoint[v]] = 1;
  let loose = 0;
  for (let i = 0; i < g.numPoints; i++) if (!used[i]) loose++;
  const fields = heightfieldsOf(g), images = [...referenceableImages(g).values()];
  // materials and their maps with no geometry: a material output (its images are its maps, not an image output)
  const mats = !g.numPoints ? Object.keys(readMaterials(g)) : [];
  const sdfs = g.volumes.filter((v) => v.kind === 'sdf' || v.kind === 'grid'), grids = sdfs.filter((v) => v.kind === 'grid');
  const curves = polylines + splines;
  const has: Record<OutputPart, boolean> = {
    heightfield: fields.length > 0, instances: packed > 0, mesh: polygons > 0, curves: curves > 0,
    // loose points beside prims are an output's sockets or strays, not a part of their own
    points: loose > 0 && !g.numPrims,
    // images beside other parts are their textures
    image: images.length > 0 && !g.numPoints && !fields.length && !sdfs.length && !mats.length,
    material: mats.length > 0 && !fields.length && !sdfs.length,
    volume: sdfs.length > 0,
  };
  const parts = OUTPUT_PARTS.filter((p) => has[p]);
  const alone = parts.length === 1;
  const hf = fields[0];
  const heightfield: HeightfieldInfo | undefined = hf && {
    name: hf.name, width: hf.width, height: hf.height, cell: hf.cellSize,
    layers: [...hf.layers].map(([name, a]) => { const s = layerStats(a); return { name, min: s?.min ?? 0, max: s?.max ?? 0 }; }),
  };
  const more = (k: number) => (k > 1 ? ` (+${n(k - 1)} more)` : '');
  // each part's size: alone, beside its kind; in a scene, named by its kind
  const text: Record<OutputPart, () => string> = {
    heightfield: () => (alone ? `${hf.width} × ${hf.height} samples, ${len(hf.cellSize)} m apart` : `terrain ${hf.width} × ${hf.height}, ${len(hf.cellSize)} m`) + more(fields.length),
    instances: () => `${count(packed, 'instance')} of ${count(g.packedSources.length, 'source')}`,
    mesh: () => (alone ? `${count(polygons, 'polygon')}, ${count(g.numPoints, 'point')}` : `mesh ${count(polygons, 'polygon')}`),
    curves: () => (alone ? `${count(curves, 'curve')}, ${count(g.numPoints, 'point')}` : count(curves, 'curve')),
    points: () => count(loose, 'point'),
    image: () => `${images[0].width} × ${images[0].height} px${more(images.length)}`,
    material: () => `${count(mats.length, 'material')}${images.length ? `, ${count(images.length, 'map')} (${[...new Set(images.map((im) => `${im.width} × ${im.height}`))].join(', ')} px)` : ''}`,
    volume: () => {
      const v = grids[0];
      return v ? `SDF grid ${v.dims.join(' × ')}${more(sdfs.length)}` : `${count(sdfs.length, 'SDF volume')}`;
    },
  };
  const b = g.bbox(true);
  const size = b.empty || has.image || has.material ? null : [0, 1, 2].map((a) => b.max[a] - b.min[a]) as [number, number, number];
  const kind: OutputKind = parts.length === 0 ? 'empty' : alone ? parts[0] : 'mixed';
  return {
    kind, published: publishedKind({ kind }),
    parts, text: parts.length ? parts.map((p) => text[p]()).join(' + ') : 'empty', size,
    ...(heightfield ? { heightfield } : {}), heightfields: fields.length, images: images.length, materials: has.material ? mats.length : 0, grids: grids.length,
  };
}

/**
 * The kind a published output records (src/graph/outputs.ts KINDS): its one part as named, a heightfield a terrain and
 * an image textures; scene for several parts; null for an empty output, which is no kind (publishing blocks it).
 */
export function publishedKind(o: Pick<OutputInfo, 'kind'>): Kind | null {
  switch (o.kind) {
    case 'empty': return null;
    case 'mixed': return 'scene';
    case 'heightfield': return 'terrain';
    case 'image': return 'textures';
    default: return o.kind;
  }
}

/**
 * What an output whose author pinned its kind (graph.outputs[id].kind) says when it cooks to another kind or to
 * nothing (null: it is the kind pinned). Build and the viewer warn with it; publishing blocks.
 */
export function kindMismatch(pinned: string, o: OutputInfo): string | null {
  const k = publishedKind(o);
  if (k === pinned) return null;
  return `its "kind" is "${pinned}", and it cooks to ${k ? `${k} (${o.text})` : 'nothing'}: change what it cooks, or its "kind" in the graph's outputs`;
}

/** A bounding size in words: "4096 × 312 × 4096 m". */
export const sizeText = (s: readonly number[]) => `${s.map(len).join(' × ')} m`;

export interface FormatFit {
  format: ExportFormat;
  label: string;
  /** the target file's extension ('' for the folder formats) */
  extension: string;
  /** what it writes, in a line */
  writes: string;
  /** the parts of the output it does not write (none: all of it) */
  leaves: OutputPart[];
  /** a download is the file itself (it carries how it was made); otherwise a zip of the files */
  oneFile: boolean;
}

/** What a format needs of the output to export at all (io/heightmap.ts, io/unreal.ts, io/textures.ts). */
function hasWhatItNeeds(format: ExportFormat, o: OutputInfo): boolean {
  const layers = new Set(o.heightfield?.layers.map((l) => l.name));
  if (format === 'png16' || format === 'r16' || format === 'unreal_landscape') return layers.has('height');
  // mask_png writes the "mask" layer unless the export names its layers
  if (format === 'mask_png') return layers.has('mask');
  if (format === 'textures') return o.images > 0;
  return true;
}

/**
 * The formats that write some of the output, best first: those that write all of it, in the order of its main part,
 * then those that write a part, part by part; json (lossless, for TopoTopo itself) last. Nothing for an empty output,
 * or one of analytic SDFs alone (sdf_to_mesh makes them a mesh).
 */
export function fittingFormats(o: OutputInfo): FormatFit[] {
  // what there is to write: the parts, and textures beside them (the textures format writes those)
  const present = new Set<OutputPart>(o.parts);
  if (o.images) present.add('image');
  const writes = (f: ExportFormat) => [...present].filter((p) => PART_FORMATS[p].includes(f) && !(p === 'volume' && !o.grids));
  const ordered: ExportFormat[] = [];
  const add = (f: ExportFormat) => { if (!ordered.includes(f) && f !== 'json' && hasWhatItNeeds(f, o) && writes(f).length) ordered.push(f); };
  const parts = o.parts.length ? o.parts : [...present];
  for (const f of PART_FORMATS[parts[0]] ?? []) if (parts.every((p) => writes(f).includes(p))) add(f);
  for (const p of [...parts, ...present]) for (const f of PART_FORMATS[p]) add(f);
  if (writes('json').length) ordered.push('json');
  const instances = o.parts.includes('instances');
  return ordered.map((format) => {
    const w = writes(format);
    return {
      format, label: FORMAT_LABELS[format], extension: targetExtension(format),
      writes: formatWrites(format, { instances, images: o.images > 0 }), leaves: o.parts.filter((p) => !w.includes(p)),
      oneFile: SOURCE_INSIDE.includes(format),
    };
  });
}
