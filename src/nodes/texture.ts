// Texture nodes (category "texture"): a Substance Designer / Houdini COP style image family. Images are volumes of
// kind 'image' carried in the geometry (core/image.ts): generators make a geometry holding one image, image_file loads
// a PNG, filters process one layer of one image of their first input and pass everything else through,
// texture_to_material attaches images to a material ("image:<name>" texture slots), and exporters embed them (glTF) or
// write them next to the file (USD, the "textures" format). Bakes from meshes live in nodes/bake.ts.
// Names: every image a node makes or filters is named after that node unless its name param says otherwise, so the
// default names in a graph never collide. A node reading an input that holds several images needs to be told which
// one (its image param): it never picks the first silently.
import { Geometry, sameImage } from '../core/geometry.ts';
import type { Volume } from '../core/geometry.ts';
import { Image, MAIN_LAYER, MAX_PIXELS, asImage, channelsOf, imagesOf, isImage, resizeLayer, toGrey } from '../core/image.ts';
import {
  BLEND_MODES, GRADIENTS, NORMAL_BLEND_MODES, PATTERNS, SHAPES, WARP_MODES, blendLayers, blendNormals, blurLayer, colorize, curvesLayer, edgeDetect, genGradient,
  coverageCut, genPattern, genScratches, genShape, genSplatter, heightToAO, histogramScanFn, levelsFn, mapValues, normalFromHeight, rampLUT,
  tileSampler, transformLayer, warpLayer,
} from '../core/texture.ts';
import type { CellsJob, NoiseJob } from '../core/texture.ts';
import { Heightfield, heightfieldsOf } from '../core/heightfield.ts';
import { MATERIAL_ATTRIB, normalizeMaterial, readMaterials, writeMaterials } from '../core/materials.ts';
import { readUV } from '../core/uv.ts';
import { PNG_LAYERS, readImageFile } from '../io/textures.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import type { CookContext, ParamDef } from '../graph/types.ts';
import { evalRamp } from '../graph/params.ts';
import { andThen } from '../graph/parallel.ts';
import { P, mask } from './util.ts';

// ---------------------------------------------------------------- shared params and helpers

export const NO_IMAGE = 'make one with a generator (tex_noise, tex_pattern, tex_shape, tex_cells …), a bake (bake_ao, bake_curvature …) or heightfield_to_tex, or load a PNG with image_file';

export const resolutionParam = (def = 512): ParamDef => ({
  type: 'ivec2', default: [def, def], min: 1, max: 8192,
  desc: `image size in pixels [width, height] (one number = square; at most ${MAX_PIXELS.toLocaleString('en-US')} pixels); powers of two suit GPUs`,
  aliases: ['res', 'output_size', 'dimensions', 'image_size'],
});
/** The name of the image a node makes: "" = the node's own name (unique in its graph). */
export const nameParam = (desc = 'image name ("" = this node\'s name); materials reference it as "image:<name>"'): ParamDef => ({ type: 'string', default: '', desc, aliases: ['image_name', 'output_name'] });
/** Which image of an input to read: "" = its only image (an input holding several is an error that lists them). */
export const imageParam = (of = 'the input', aliases: string[] = ['input_image', 'source_image']): ParamDef => ({ type: 'string', default: '', desc: `which image of ${of} to use ("" = its only image; needed when it holds several)`, aliases });
const layerParam = (): ParamDef => ({ type: 'string', default: '', desc: 'layer to process ("" = the main layer "C"; others: "id", "mask", …)', aliases: ['plane', 'channel_layer'] });
/** A filter's result name: "" = the filter node's name (the processed image is renamed; one already so called is replaced). */
export const renameParam = (): ParamDef => nameParam('name of the result ("" = this node\'s name; an image already so called is replaced); materials reference it as "image:<name>"');
/** usesNodeName for nodes whose image takes the node's name when the name param is empty. */
export const NAMED_BY_NODE = (p: Record<string, any>) => !String(p.name ?? '').trim();
/** The name of the image a node outputs: its name param, else the node's own name. */
export const outName = (ctx: CookContext): string => String(ctx.p.name ?? '').trim() || ctx.node;
const tileParam = (desc = 'the image tiles: filters read across the opposite border (keep a tileable texture tileable)'): ParamDef => ({ type: 'bool', default: true, desc, aliases: ['wrap', 'seamless'] });

export function checkSize(w: number, h: number, node: string): void {
  if (!(w >= 1 && h >= 1)) throw new NodeError(`${node}: image size must be at least 1 × 1 (got ${w} × ${h})`);
  if (w * h > MAX_PIXELS) throw new NodeError(`${node}: ${w} × ${h} pixels is too large (at most ${MAX_PIXELS.toLocaleString('en-US')} pixels, e.g. 4096 × 4096)`);
}

/** A geometry holding only this image. */
export function imageGeo(img: Image): Geometry {
  const g = new Geometry();
  g.volumes = [img];
  return g;
}

export interface Source {
  g: Geometry;
  img: Image;
  /** index of the image in g.volumes */
  index: number;
  layer: string;
  data: Float32Array;
  ch: 1 | 4;
}

/**
 * The image (by name; "" = the input's only image) and layer ("" = main) a node reads from input i. `param` names the
 * param that picks the image of this input, for the error when the input holds several and none is named ("" = the
 * node has none: keep one image in that input).
 */
export function source(ctx: CookContext, i: number, imageName = '', layerName = '', param = 'image'): Source {
  const g = ctx.input(i);
  const found: number[] = [];
  for (let k = 0; k < g.volumes.length; k++) if (isImage(g.volumes[k])) found.push(k);
  const nameOf = (k: number) => (g.volumes[k] as Volume & { name: string }).name;
  const names = found.map(nameOf);
  if (!found.length) throw new NodeError(`${ctx.type}: input ${i} has no image`, NO_IMAGE);
  let index: number;
  if (imageName) {
    const hits = found.filter((k) => nameOf(k) === imageName);
    if (!hits.length) throw new NodeError(`${ctx.type}: input ${i} has no image "${imageName}"`, `images: ${names.join(', ')}`);
    if (hits.length > 1) throw new NodeError(`${ctx.type}: input ${i} holds ${hits.length} different images named "${imageName}"`, 'give them different names (an image takes the name of the node that made it unless its name param is set; tex_output renames one)');
    index = hits[0];
  } else if (found.length > 1) {
    const list = names.map((n) => `"${n}"`).join(', ');
    throw new NodeError(
      `${ctx.type}: input ${i} holds ${found.length} images (${list}); it does not guess which one to use`,
      param ? `set ${param} to one of them, e.g. ${param}: "${names[0]}"` : `keep one image in input ${i}: tex_output {image: "${names[0]}", keep_only: true}`,
    );
  } else index = found[0];
  const img = asImage(g.volumes[index] as Image);
  const layer = layerName || img.mainLayer;
  const data = img.layer(layer);
  if (!data) throw new NodeError(`${ctx.type}: image "${img.name}" has no layer "${layer}"`, `layers: ${[...img.layers.keys()].join(', ') || 'none'}`);
  const ch = channelsOf(data, img.count);
  if (!ch) throw new NodeError(`${ctx.type}: image "${img.name}" layer "${layer}" has ${data.length} values for ${img.width} × ${img.height} pixels`);
  return { g, img, index, layer, data, ch };
}

/** Input i's image layer resized to w × h (or null when the input is not connected); `param` as in source(). */
function sourceAt(ctx: CookContext, i: number, w: number, h: number, imageName = '', layerName = '', wrap = true, param = ''): { data: Float32Array; ch: 1 | 4 } | null {
  if (!ctx.hasInput(i)) return null;
  const s = source(ctx, i, imageName, layerName, param);
  return { data: resizeLayer(s.data, s.ch, s.img.width, s.img.height, w, h, wrap), ch: s.ch };
}

/**
 * The input geometry with the source image's layer replaced and the image named `name` (outName: the filter node's
 * name by default); another image already called `name` is replaced by it.
 */
export function withLayer(s: Source, data: Float32Array, name: string, extra?: Record<string, Float32Array>): Geometry {
  const g = s.g.clone();
  const img = s.img.clone();
  img.set(s.layer, data);
  if (extra) for (const [k, v] of Object.entries(extra)) img.set(k, v);
  img.name = name;
  g.volumes[s.index] = img;
  g.volumes = g.volumes.filter((v) => v === img || !(isImage(v) && v.name === name));
  return g;
}

export const size2 = (p: any, node: string): [number, number] => {
  const w = Math.round(p.resolution[0]), h = Math.round(p.resolution[1]);
  checkSize(w, h, node);
  return [w, h];
};


// ---------------------------------------------------------------- generators

defineNode({
  type: 'tex_noise',
  category: 'texture',
  summary: 'Noise image: perlin, simplex, value or worley, layered as fbm, ridged or turbulence; tileable by default.',
  description:
    'Substance: Perlin Noise / Clouds / Fractal Sum; Houdini COP: Noise. Grey 0..1 in layer C. scale = cells across the ' +
    'image width at the first octave; each octave multiplies the frequency by lacunarity and the amplitude by roughness. ' +
    'tileable rounds every octave to whole cells (simplex samples 4D noise on a torus) so the image repeats seamlessly. ' +
    'Runs in chunks on the worker pool for large images.',
  aliases: ['noise_texture', 'perlin_noise', 'clouds', 'fractal_sum', 'cop_noise', 'fractalnoise'],
  inputs: [],
  params: {
    resolution: resolutionParam(),
    noise: { type: 'enum', options: ['perlin', 'simplex', 'value', 'worley'], default: 'perlin', desc: 'base noise', aliases: ['type', 'basis', 'noise_type'] },
    fractal: { type: 'enum', options: ['none', 'fbm', 'ridged', 'turbulence'], default: 'fbm', desc: 'octave layering (ridged = sharp crests, turbulence = billows)' },
    scale: { type: 'float', default: 4, min: 0.01, desc: 'cells across the image width at the first octave (whole numbers when tileable)', aliases: ['frequency', 'freq', 'element_size'] },
    octaves: { type: 'int', default: 5, min: 1, max: 12, desc: 'number of octaves' },
    roughness: { type: 'float', default: 0.5, min: 0, max: 1, desc: 'amplitude gain per octave (persistence)', aliases: ['persistence', 'gain'] },
    lacunarity: { type: 'float', default: 2, min: 1, max: 4, desc: 'frequency gain per octave' },
    jitter: { type: 'float', default: 1, min: 0, max: 1, desc: 'worley: randomness of the feature points (0 = regular grid)' },
    offset: { type: 'vec2', default: [0, 0], desc: 'shift in cells (vary or animate without changing the seed)' },
    tileable: { type: 'bool', default: true, desc: 'repeat seamlessly at the image borders', aliases: ['tile', 'tiling', 'seamless'] },
    seed: P.seed(),
    name: nameParam(),
  },
  usesNodeName: NAMED_BY_NODE,
  outputs: 'image <name> (default: the node name): C grey 0..1',
  example: { type: 'tex_noise', params: { resolution: 512, scale: 6, fractal: 'ridged', seed: 2 } },
  cook: (ctx) => {
    const { p, type, parallelMap } = ctx;
    const [w, h] = size2(p, type);
    const job: NoiseJob = {
      noise: p.noise, fractal: p.fractal, scale: p.scale, octaves: p.octaves, roughness: p.roughness, lacunarity: p.lacunarity,
      seed: p.seed, tileable: !!p.tileable, offset: [p.offset[0], p.offset[1]], aspect: h / w, jitter: p.jitter, width: w, height: h,
    };
    const C = new Float32Array(w * h);
    return andThen(parallelMap('tex_noise', { count: w * h, args: job, results: { C } }), () => imageGeo(new Image(w, h, outName(ctx)).set(MAIN_LAYER, C)));
  },
});

defineNode({
  type: 'tex_pattern',
  category: 'texture',
  summary: 'Tiling pattern image: bricks, tiles, checker, stripes, hex, dots, or a grid line mask, with gap (mortar), bevel and per-cell random id.',
  description:
    'Substance: Tile Generator / Bricks / Checker; Houdini COP: Pattern. For bricks, tiles, stripes, hex and dots C is ' +
    'a height-like profile: 1 on the cells, 0 in the gaps, a smooth bevel between (feed tex_normal_from_height for ' +
    'bricks with depth). grid is the opposite, a line mask: 1 on the lines (gap is their width), 0 inside the cells, so ' +
    'multiplying a material by it darkens all but the lines; for cells separated by grooves use tiles (grid is 1 - tiles ' +
    'without variation). checker alternates 1 and 0. Layer "id" holds a random 0..1 per cell (tex_colorize it with layer ' +
    '"id" for per-brick colour). count = cells along u (columns) and v (rows); bricks and dots shift every other row by ' +
    'offset (keep the row count even for seamless tiling); hex uses offset for its staggered rows. gap and bevel are ' +
    'fractions of the smaller cell side; variation darkens cells randomly.',
  aliases: ['tile_generator', 'bricks', 'brick', 'checker', 'tiles_pattern', 'cop_pattern'],
  inputs: [],
  params: {
    resolution: resolutionParam(),
    pattern: { type: 'enum', options: PATTERNS, default: 'bricks', desc: 'pattern', aliases: ['type', 'mode'] },
    count: { type: 'ivec2', default: [4, 8], min: 1, max: 4096, desc: 'cells along u (columns) and v (rows)', aliases: ['tiles', 'repeat', 'cells'] },
    offset: { type: 'float', default: 0.5, min: 0, max: 1, desc: 'bricks / hex / dots: shift of every other row (fraction of a cell)', aliases: ['row_offset', 'stagger'] },
    gap: { type: 'float', default: 0.06, min: 0, max: 1, desc: 'mortar / gap width as a fraction of the smaller cell side (dots: 1 - diameter)', aliases: ['mortar', 'spacing'] },
    bevel: { type: 'float', default: 0.08, min: 0, max: 1, desc: 'bevel width as a fraction of the smaller cell side (0 = hard antialiased edge)', aliases: ['smooth', 'roundness'] },
    variation: { type: 'float', default: 0, min: 0, max: 1, desc: 'random darkening per cell (0 = all cells 1; not grid or checker)', aliases: ['height_variation', 'luminance_random'] },
    seed: P.seed(),
    name: nameParam(),
  },
  usesNodeName: NAMED_BY_NODE,
  outputs: 'image <name> (default: the node name): C grey profile (1 on the cells; grid: 1 on the lines), id grey random per cell',
  example: { type: 'tex_pattern', params: { pattern: 'bricks', count: [4, 8], gap: 0.05, bevel: 0.1 } },
  cook: (ctx) => {
    const { p, type } = ctx;
    const [w, h] = size2(p, type);
    const r = genPattern({ pattern: p.pattern, count: [p.count[0], p.count[1]], offset: p.offset, gap: p.gap, bevel: p.bevel, variation: p.variation, seed: p.seed }, w, h);
    return imageGeo(new Image(w, h, outName(ctx)).set(MAIN_LAYER, r.C).set('id', r.id));
  },
});

defineNode({
  type: 'tex_gradient',
  category: 'texture',
  summary: 'Gradient image: linear, mirror, radial, angular or diamond, 0..1.',
  description: 'Substance: Gradient Linear / Radial / Axial; Houdini COP: Ramp. linear runs along angle (0 = left → right, 90 = bottom → top) and spans the image corner to corner; mirror rises to 1 in the middle; radial and diamond grow from center over radius (uv units); angular sweeps once around center.',
  aliases: ['gradient', 'ramp_texture', 'gradient_linear', 'gradient_radial', 'cop_ramp'],
  inputs: [],
  params: {
    resolution: resolutionParam(),
    mode: { type: 'enum', options: GRADIENTS, default: 'linear', desc: 'gradient shape', aliases: ['type'] },
    angle: { type: 'float', default: 0, desc: 'direction in degrees (linear, mirror) or start angle (angular)', aliases: ['rotation', 'direction'] },
    center: { type: 'vec2', default: [0.5, 0.5], desc: 'centre in uv (radial, diamond, angular)' },
    radius: { type: 'float', default: 0.5, min: 0.001, desc: 'radial / diamond: distance (uv) where the gradient reaches 1' },
    name: nameParam(),
  },
  usesNodeName: NAMED_BY_NODE,
  outputs: 'image <name> (default: the node name): C grey 0..1',
  example: { type: 'tex_gradient', params: { resolution: 256, mode: 'radial', radius: 0.5 } },
  cook: (ctx) => {
    const { p, type } = ctx;
    const [w, h] = size2(p, type);
    return imageGeo(new Image(w, h, outName(ctx)).set(MAIN_LAYER, genGradient(p.mode, p.angle, [p.center[0], p.center[1]], p.radius, w, h)));
  },
});

defineNode({
  type: 'tex_constant',
  category: 'texture',
  summary: 'Constant image: one grey value or one RGBA colour everywhere, sized by resolution or by an input image.',
  description:
    'Substance: Uniform Color; Houdini COP: Constant. channels grey fills layer C with value (a flat roughness, ' +
    'metallic or height, a mask of 1); rgba with color (display values like every colour param: "#a5462e" comes out ' +
    'of the PNG as #a5462e) and alpha. With input 0 connected the image takes the size of an image there (image picks ' +
    'one when it holds several) and resolution is ignored; the output holds only the new image either way. Blend over ' +
    'it, pack it into an ORM channel, or give a material a flat map.',
  aliases: ['constant_texture', 'uniform_color', 'solid_color', 'flat_color', 'fill_image', 'cop_constant'],
  inputs: [{ name: 'size_from', desc: 'optional: an image whose size the constant takes', optional: true }],
  params: {
    resolution: resolutionParam(),
    channels: { type: 'enum', options: ['grey', 'rgba'], default: 'grey', desc: 'grey = one value (value), rgba = a colour (color, alpha)', aliases: ['mode', 'type'] },
    value: { type: 'float', default: 0.5, desc: 'grey: the value of every pixel', aliases: ['grey', 'level'] },
    color: { type: 'color', default: [0.5, 0.5, 0.5], desc: 'rgba: the colour of every pixel', aliases: ['rgb', 'colour'] },
    alpha: { type: 'float', default: 1, min: 0, max: 1, desc: 'rgba: the alpha of every pixel' },
    image: imageParam('input 0 (the size source)'),
    name: nameParam(),
  },
  usesNodeName: NAMED_BY_NODE,
  outputs: 'image <name> (default: the node name): C grey or RGBA, one value everywhere',
  example: {
    nodes: {
      noise: { type: 'tex_noise', params: { resolution: 128 } },
      roughness: { type: 'tex_constant', in: ['noise'], params: { value: 0.65 } },
      paint: { type: 'tex_constant', params: { resolution: 64, channels: 'rgba', color: '#a5462e' } },
      out: { type: 'merge', in: ['roughness', 'paint'] },
    },
    output: 'out',
  },
  cook: (ctx) => {
    const { p, type } = ctx;
    let w: number, h: number;
    if (ctx.hasInput(0)) { const s = source(ctx, 0, p.image); w = s.img.width; h = s.img.height; } else [w, h] = size2(p, type);
    const rgba = p.channels === 'rgba';
    const C = new Float32Array(w * h * (rgba ? 4 : 1));
    if (!rgba) C.fill(p.value);
    else for (let i = 0; i < C.length; i += 4) { C[i] = p.color[0]; C[i + 1] = p.color[1]; C[i + 2] = p.color[2]; C[i + 3] = p.alpha; }
    return imageGeo(new Image(w, h, outName(ctx)).set(MAIN_LAYER, C));
  },
});

defineNode({
  type: 'tex_shape',
  category: 'texture',
  summary: 'Shape image: disc, square, polygon, star or ring with a soft falloff, optionally repeated in a grid.',
  description: 'Substance: Shape; Houdini COP: Shape. 1 inside, 0 outside; falloff (fraction of the radius) ramps the edge inward, so falloff 1 gives a cone or pyramid usable as a height stamp. size is the radius relative to half a tile. tile repeats the shape (a tileable stud or rivet grid). Use as a mask, a stamp for tex_tile_sampler, or a bump through tex_normal_from_height.',
  aliases: ['shape_texture', 'cop_shape', 'polygon_shape', 'disc_texture'],
  inputs: [],
  params: {
    resolution: resolutionParam(),
    shape: { type: 'enum', options: SHAPES, default: 'disc', desc: 'shape', aliases: ['type'] },
    size: { type: 'float', default: 0.8, min: 0.001, max: 2, desc: 'radius as a fraction of half a tile (1 touches the tile border)', aliases: ['radius', 'scale'] },
    sides: { type: 'int', default: 6, min: 3, max: 64, desc: 'polygon / star: sides or points' },
    inner_radius: { type: 'float', default: 0.5, min: 0, max: 1, desc: 'star: inner / outer radius; ring: hole / outer radius', aliases: ['inner'] },
    rotation: { type: 'float', default: 0, desc: 'rotation in degrees (counter-clockwise)', aliases: ['angle', 'rotate'] },
    falloff: { type: 'float', default: 0, min: 0, max: 1, desc: 'soft edge as a fraction of the radius (0 = antialiased hard edge, 1 = a cone)', aliases: ['softness', 'blur'] },
    tile: { type: 'ivec2', default: [1, 1], min: 1, max: 512, desc: 'repeats along u and v', aliases: ['tiling', 'repeat', 'count'] },
    name: nameParam(),
  },
  usesNodeName: NAMED_BY_NODE,
  outputs: 'image <name> (default: the node name): C grey 0..1',
  example: { type: 'tex_shape', params: { shape: 'star', sides: 5, falloff: 0.3, tile: [4, 4] } },
  cook: (ctx) => {
    const { p, type } = ctx;
    const [w, h] = size2(p, type);
    const C = genShape({ shape: p.shape, size: p.size, sides: p.sides, inner: p.inner_radius, rotation: p.rotation, falloff: p.falloff, tile: [p.tile[0], p.tile[1]] }, w, h);
    return imageGeo(new Image(w, h, outName(ctx)).set(MAIN_LAYER, C));
  },
});

defineNode({
  type: 'tex_cells',
  category: 'texture',
  summary: 'Voronoi cells image: distance to the cell site, cell edges, random id per cell or crackle; tileable.',
  description: 'Substance: Cells / Voronoi / Crystal; Houdini COP: Worley Noise. Layer C holds the chosen output and layer "id" a random 0..1 per cell (per-cell colour or height). edges is 0 on the cell borders rising to 1 at edge_width (a fraction of a cell): stones, scales, cracked mud. crackle (F2 - F1) is bright along the borders. Runs in chunks on the worker pool for large images.',
  aliases: ['voronoi_texture', 'cells', 'worley', 'cellular', 'crystals', 'cop_worley'],
  inputs: [],
  params: {
    resolution: resolutionParam(),
    output: { type: 'enum', options: ['distance', 'edges', 'id', 'crackle'], default: 'edges', desc: 'what C holds', aliases: ['mode', 'type'] },
    scale: { type: 'float', default: 8, min: 0.01, desc: 'cells across the image width (whole numbers when tileable)', aliases: ['frequency', 'freq', 'count'] },
    jitter: { type: 'float', default: 1, min: 0, max: 1, desc: 'randomness of the sites (0 = square grid)', aliases: ['randomness', 'disorder'] },
    edge_width: { type: 'float', default: 0.1, min: 0.001, max: 1, desc: 'edges: border width (fraction of a cell)', aliases: ['width', 'border'] },
    metric: { type: 'enum', options: ['euclidean', 'manhattan', 'chebyshev'], default: 'euclidean', desc: 'distance metric (manhattan = diamond cells, chebyshev = square cells)' },
    tileable: { type: 'bool', default: true, desc: 'repeat seamlessly at the image borders', aliases: ['tile', 'tiling', 'seamless'] },
    seed: P.seed(),
    name: nameParam(),
  },
  usesNodeName: NAMED_BY_NODE,
  outputs: 'image <name> (default: the node name): C grey (the chosen output), id grey random per cell',
  example: { type: 'tex_cells', params: { output: 'edges', scale: 10, edge_width: 0.08 } },
  cook: (ctx) => {
    const { p, type, parallelMap } = ctx;
    const [w, h] = size2(p, type);
    const job: CellsJob = {
      width: w, height: h, scale: p.scale, jitter: p.jitter, seed: p.seed, tileable: !!p.tileable, output: p.output, edgeWidth: p.edge_width,
      metric: ['euclidean', 'manhattan', 'chebyshev'].indexOf(p.metric),
    };
    const C = new Float32Array(w * h), id = new Float32Array(w * h);
    return andThen(parallelMap('tex_cells', { count: w * h, args: job, results: { C, id } }), () => imageGeo(new Image(w, h, outName(ctx)).set(MAIN_LAYER, C).set('id', id)));
  },
});

defineNode({
  type: 'tex_scratches',
  category: 'texture',
  summary: 'Seeded scratches: thin tapered strokes along a direction with random spread, length and intensity.',
  description: 'Substance: Scratches Generator / Directional Scratches. Strokes are slightly bent, thin at both ends, combined with max; they wrap at the borders (tileable). length and width are fractions of the image width. Blend over a roughness or base colour map with tex_blend.',
  aliases: ['scratches', 'scratch_generator', 'directional_scratches', 'strokes', 'cracks'],
  inputs: [],
  params: {
    resolution: resolutionParam(),
    count: { type: 'int', default: 200, min: 0, max: 100000, desc: 'number of strokes', aliases: ['number', 'amount'] },
    length: { type: 'vec2', default: [0.05, 0.25], min: 0, desc: 'stroke length range (fractions of the image width)' },
    width: { type: 'float', default: 0.003, min: 0, desc: 'stroke width (fraction of the image width; at least about one pixel)' },
    angle: { type: 'float', default: 20, desc: 'mean direction in degrees (0 = along u)' },
    spread: { type: 'float', default: 30, min: 0, max: 180, desc: 'random deviation from angle in degrees' },
    curvature: { type: 'float', default: 0.1, min: 0, max: 1, desc: 'sideways bend as a fraction of the length' },
    intensity: { type: 'vec2', default: [0.4, 1], min: 0, desc: 'intensity range of a stroke' },
    tileable: { type: 'bool', default: true, desc: 'strokes wrap at the borders', aliases: ['tile', 'wrap'] },
    seed: P.seed(),
    name: nameParam(),
  },
  usesNodeName: NAMED_BY_NODE,
  outputs: 'image <name> (default: the node name): C grey 0..1',
  example: { type: 'tex_scratches', params: { resolution: 512, count: 150, angle: 45, seed: 3 } },
  cook: (ctx) => {
    const { p, type } = ctx;
    const [w, h] = size2(p, type);
    const C = genScratches({ count: p.count, length: [p.length[0], p.length[1]], width: p.width, angle: p.angle, spread: p.spread, curvature: p.curvature, intensity: [p.intensity[0], p.intensity[1]], seed: p.seed, wrap: !!p.tileable }, w, h);
    return imageGeo(new Image(w, h, outName(ctx)).set(MAIN_LAYER, C));
  },
});

defineNode({
  type: 'tex_splatter',
  category: 'texture',
  summary: 'Seeded splatter: ragged soft blobs (stains, dirt, paint drops) scattered over the image.',
  description: 'Substance: Splatter / Dirt / Grunge Map. irregularity makes the outlines ragged (0 = discs); softness is the edge blur as a fraction of the radius; blobs wrap at the borders (tileable) and combine with max, or add (clamped to 1). For strokes use tex_scratches.',
  aliases: ['splatter', 'blobs', 'stains', 'dirt_map', 'grunge'],
  inputs: [],
  params: {
    resolution: resolutionParam(),
    count: { type: 'int', default: 60, min: 0, max: 100000, desc: 'number of blobs', aliases: ['number', 'amount'] },
    size: { type: 'vec2', default: [0.02, 0.08], min: 0, desc: 'radius range (fractions of the image width)', aliases: ['radius'] },
    irregularity: { type: 'float', default: 0.6, min: 0, max: 1, desc: 'ragged outline (0 = discs)', aliases: ['roughness', 'disorder'] },
    softness: { type: 'float', default: 0.4, min: 0, max: 1, desc: 'edge blur as a fraction of the radius', aliases: ['falloff', 'blur'] },
    intensity: { type: 'vec2', default: [0.5, 1], min: 0, desc: 'intensity range of a blob' },
    combine: { type: 'enum', options: ['max', 'add'], default: 'max', desc: 'how overlapping blobs combine', aliases: ['blend'] },
    tileable: { type: 'bool', default: true, desc: 'blobs wrap at the borders', aliases: ['tile', 'wrap'] },
    seed: P.seed(),
    name: nameParam(),
  },
  usesNodeName: NAMED_BY_NODE,
  outputs: 'image <name> (default: the node name): C grey 0..1',
  example: { type: 'tex_splatter', params: { resolution: 512, count: 40, size: [0.03, 0.1], seed: 2 } },
  cook: (ctx) => {
    const { p, type } = ctx;
    const [w, h] = size2(p, type);
    const C = genSplatter({ count: p.count, size: [p.size[0], p.size[1]], irregularity: p.irregularity, softness: p.softness, intensity: [p.intensity[0], p.intensity[1]], seed: p.seed, wrap: !!p.tileable, add: p.combine === 'add' }, w, h);
    return imageGeo(new Image(w, h, outName(ctx)).set(MAIN_LAYER, C));
  },
});

/** Even-odd fill of closed contours (pixel coordinates) with 4 sub-scanlines per pixel row and exact horizontal coverage. */
function fillContours(contours: number[][], w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  const S = 4;
  const xs: number[] = [];
  for (let j = 0; j < h; j++)
    for (let s = 0; s < S; s++) {
      const y = j + (s + 0.5) / S;
      xs.length = 0;
      for (const c of contours) {
        const n = c.length / 2;
        for (let a = 0, b = n - 1; a < n; b = a++) {
          const ay = c[a * 2 + 1], by = c[b * 2 + 1];
          if ((ay > y) === (by > y)) continue;
          xs.push(c[a * 2] + ((y - ay) / (by - ay)) * (c[b * 2] - c[a * 2]));
        }
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const x0 = Math.max(0, xs[k]), x1 = Math.min(w, xs[k + 1]);
        if (x1 <= x0) continue;
        for (let i = Math.floor(x0); i < Math.ceil(x1) && i < w; i++) {
          const cov = Math.min(i + 1, x1) - Math.max(i, x0);
          if (cov > 0) out[j * w + i] += cov / S;
        }
      }
    }
  for (let k = 0; k < out.length; k++) if (out[k] > 1) out[k] = 1;
  return out;
}

defineNode({
  type: 'tex_text',
  category: 'texture',
  summary: 'Text image: a line (or lines) of text from the bundled font (or a named one), filled and antialiased.',
  description: 'Substance: Text. Uses the text node\'s glyph outlines (bundled DejaVu Sans by default, identical on every machine), fits the text block\'s height to `size` (a fraction of the image height, shrunk to fit the width) and places its centre at `position` (uv). Labels, stencils, decals, serial numbers.',
  aliases: ['text_texture', 'label_texture', 'stencil'],
  inputs: [],
  params: {
    resolution: resolutionParam(),
    text: { type: 'string', default: 'TOPOTOPO', desc: 'text (use \\n for new lines)' },
    font: { type: 'string', default: '', desc: 'font file or family ("" = the bundled DejaVu Sans)' },
    size: { type: 'float', default: 0.2, min: 0.001, desc: 'height of the text block as a fraction of the image height (shrunk to fit the width)', aliases: ['height', 'font_size'] },
    position: { type: 'vec2', default: [0.5, 0.5], desc: 'centre of the text in uv', aliases: ['center'] },
    align: { type: 'enum', options: ['left', 'center', 'right'], default: 'center', desc: 'horizontal alignment of lines' },
    name: nameParam(),
  },
  outputs: 'image <name> (default: the node name): C grey 0..1',
  // it cooks a text node, which reads its font through the scope
  usesScope: true,
  usesNodeName: NAMED_BY_NODE,
  example: { type: 'tex_text', params: { resolution: [512, 128], text: 'EXIT', size: 0.7 } },
  async cook(ctx) {
    const { p, type } = ctx;
    const [w, h] = size2(p, type);
    const r = await ctx.subcook({ nodes: { t: { type: 'text', params: { text: p.text, font: p.font, size: 1, align: p.align, valign: 'center', output: 'outlines' } } }, output: 't' });
    if (!r.ok || !r.geo) throw new NodeError(`${type}: ${r.errors.map((e) => e.message).join('; ') || 'text failed'}`);
    const g = r.geo;
    const img = new Image(w, h, outName(ctx));
    if (!g.numPrims) return imageGeo(img.set(MAIN_LAYER, new Float32Array(w * h)));
    const b = g.bbox();
    const tw = b.max[0] - b.min[0], th = b.max[1] - b.min[1];
    // pixels per text unit: the block's height is size × image height, shrunk to fit 98% of the width
    const k = Math.min((p.size * h) / Math.max(th, 1e-9), (0.98 * w) / Math.max(tw, 1e-9));
    const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2;
    const ox = p.position[0] * w, oy = (1 - p.position[1]) * h;
    const contours: number[][] = [];
    for (let q = 0; q < g.numPrims; q++) {
      const c: number[] = [];
      for (const pt of g.primPoints(q)) c.push(ox + (g.P[pt * 3] - cx) * k, oy - (g.P[pt * 3 + 1] - cy) * k);
      if (c.length >= 6) contours.push(c);
    }
    return imageGeo(img.set(MAIN_LAYER, fillContours(contours, w, h)));
  },
});

// ---------------------------------------------------------------- files

defineNode({
  type: 'image_file',
  category: 'texture',
  packed: 'keep',
  summary: 'Load a PNG (8 or 16 bit, grey or colour) as an image: your own textures and masks into the texture nodes and materials.',
  description:
    'Houdini COP: File; Substance: Bitmap. The image is named after this node, like every image a node makes, unless ' +
    'name is set; layer C holds it, grey or RGBA (layers), and a grey image keeps the file\'s alpha, when it has one, in layer ' +
    '"A". Values are samples / 255 (16-bit files / 65535: their precision is kept). Colour layers hold display values, as ' +
    'every colour in the engine does ("#a5462e" is 0.65, 0.27, 0.18), so srgb (on by default) keeps the numbers the file ' +
    'stores: a PNG this engine wrote reads back unchanged, and masks, heights, normal and roughness maps load as they are. ' +
    'Turn srgb off only for a file holding linear-light colour (a linear render): grey and RGB are then encoded to display ' +
    'values, alpha never (unlike Unreal\'s sRGB checkbox, off does not mean "data"). With input 0 connected the image is ' +
    'added to that geometry, replacing an image of the same name, so image_file nodes chain. The file node reads .png ' +
    'files the same way (with these defaults), naming the image after the file.',
  aliases: ['image_read', 'png_read', 'texture_file'],
  inputs: [{ name: 'geo', desc: 'optional: add the image to this geometry (chain image_file nodes, or carry a mesh); else the output holds only the image', optional: true }],
  params: {
    path: { type: 'path', default: '', desc: 'PNG file (relative to the workspace, e.g. "inputs/brick.png") or URL', aliases: ['file', 'filename'] },
    name: nameParam(),
    layers: { type: 'enum', options: [...PNG_LAYERS], default: 'auto', desc: 'auto = grey for grey PNGs (1–2 channels), RGBA for colour ones; grey = the luminance of a colour file; rgba = always four channels', aliases: ['channels'] },
    srgb: { type: 'bool', default: true, desc: 'the file holds display (sRGB) values: kept as stored, like every colour in the engine (masks and data maps load unchanged too); off = it holds linear-light colour, encoded to display values on load (alpha never)' },
  },
  // relative paths read the scope's folder
  usesScope: true,
  usesNodeName: NAMED_BY_NODE,
  signatureExtra: (p, scope) => scope.files.fileStamp(p.path),
  outputs: 'image <name> (default: the node name): C grey or RGBA 0..1; A grey (the file\'s alpha, for a grey image of a file with alpha)',
  example: {
    nodes: {
      brick_color: { type: 'image_file', params: { path: 'inputs/brick_color.png' } },
      brick_rough: { type: 'image_file', in: ['brick_color'], params: { path: 'inputs/brick_rough.png', layers: 'grey' } },
      box: { type: 'box' },
      uv: { type: 'uv_project', in: ['box'], params: { method: 'box' } },
      out: { type: 'texture_to_material', in: ['uv', 'brick_rough'], params: { material: 'brick', base_color: 'brick_color', roughness: 'brick_rough' } },
    },
    output: 'out',
  },
  async cook(ctx) {
    const { p, type, scope } = ctx;
    if (!String(p.path ?? '').trim()) throw new NodeError(`${type}: path is empty`, 'a PNG relative to the workspace (people drop theirs into inputs/) or a URL');
    let img: Image;
    try {
      img = await readImageFile((f) => scope.files.readFile(f), p.path, { name: outName(ctx), layers: p.layers, srgb: !!p.srgb });
    } catch (e: any) { throw new NodeError(`${type}: ${e?.message ?? e}`); }
    const g = ctx.hasInput(0) ? ctx.input(0).clone() : new Geometry();
    const before = g.volumes.length;
    g.volumes = g.volumes.filter((v) => !(isImage(v) && v.name === img.name));
    if (g.volumes.length < before) ctx.warn(`${type}: replaced the input's image "${img.name}" (set name to keep both)`);
    g.volumes.push(img);
    return g;
  },
});

// ---------------------------------------------------------------- filters

const FILTER_INPUT = [{ name: 'image', desc: 'geometry holding the image to process (everything else passes through; with several images, image names the one)' }];

defineNode({
  type: 'tex_blend',
  usesNodeName: NAMED_BY_NODE,
  category: 'texture',
  summary: 'Blend a foreground image over a background with a mode (normal, add, multiply, screen, overlay, min, max, difference …), opacity and an optional mask.',
  description: 'Substance: Blend; Houdini COP: Blend / Composite. result = mix(background, mode(background, foreground), opacity × mask × foreground alpha). The foreground and mask are resized to the background. A grey and an RGBA input give RGBA; alpha is the background\'s. clamp keeps the result in 0..1. For normal maps use tex_normal_blend (overlay flattens them).',
  aliases: ['blend', 'composite', 'cop_blend', 'layer_blend', 'mix_images'],
  inputs: [
    { name: 'background', desc: 'image A (its geometry passes through)' },
    { name: 'foreground', desc: 'image B' },
    { name: 'mask', desc: 'grey mask: where B applies (optional)', optional: true },
  ],
  params: {
    mode: { type: 'enum', options: BLEND_MODES, default: 'normal', desc: 'blend mode', aliases: ['blend_mode', 'operation'] },
    opacity: { type: 'float', default: 1, min: 0, max: 1, desc: 'strength of the foreground', aliases: ['amount', 'alpha', 'weight'] },
    clamp: { type: 'bool', default: true, desc: 'clamp the result to 0..1' },
    image: imageParam('input 0 (the background)'), layer: layerParam(),
    foreground_image: imageParam('input 1 (the foreground)', []),
    foreground_layer: { type: 'string', default: '', desc: 'layer of the foreground ("" = main)' },
    mask_image: imageParam('input 2 (the mask)', []),
    mask_layer: { type: 'string', default: '', desc: 'layer of the mask image ("" = main)' },
    tileable: tileParam('resizing wraps at the borders'),
    name: renameParam(),
  },
  outputs: 'the background image with the blended layer, named <name> (default: the node name)',
  example: {
    nodes: {
      paint: { type: 'tex_noise', params: { resolution: 256, scale: 3 } },
      metal: { type: 'tex_pattern', params: { resolution: 256 } },
      wear: { type: 'tex_cells', params: { resolution: 256, output: 'edges' } },
      out: { type: 'tex_blend', in: ['paint', 'metal', 'wear'], params: { mode: 'normal', opacity: 0.8 } },
    },
    output: 'out',
  },
  cook: (ctx) => {
    const { p } = ctx;
    const A = source(ctx, 0, p.image, p.layer);
    const w = A.img.width, h = A.img.height, wrap = !!p.tileable;
    const B = sourceAt(ctx, 1, w, h, p.foreground_image, p.foreground_layer, wrap, 'foreground_image');
    if (!B) throw new NodeError(`${ctx.type}: connect a foreground image to input 1`);
    const M = sourceAt(ctx, 2, w, h, p.mask_image, p.mask_layer, wrap, 'mask_image');
    const r = blendLayers(A.data, A.ch, B.data, B.ch, M ? toGrey(M.data, M.ch) : null, p.mode, p.opacity, !!p.clamp);
    return withLayer(A, r.data, outName(ctx));
  },
});

defineNode({
  type: 'tex_levels',
  usesNodeName: NAMED_BY_NODE,
  category: 'texture',
  summary: 'Levels: remap the input range, apply gamma, remap to the output range (contrast, brightness, inversion).',
  description: 'Substance: Levels; Houdini COP: Levels. value = out_low + (out_high - out_low) × ((value - in_low) / (in_high - in_low))^(1/gamma). Applies to grey or RGB (alpha untouched).',
  aliases: ['levels', 'cop_levels', 'remap_texture', 'contrast'],
  inputs: FILTER_INPUT,
  params: {
    in_low: { type: 'float', default: 0, desc: 'input black point' },
    in_high: { type: 'float', default: 1, desc: 'input white point' },
    gamma: { type: 'float', default: 1, min: 0.01, max: 10, desc: 'midtones (> 1 brightens)', aliases: ['mid'] },
    out_low: { type: 'float', default: 0, desc: 'output black' },
    out_high: { type: 'float', default: 1, desc: 'output white' },
    clamp: { type: 'bool', default: true, desc: 'clamp to 0..1' },
    image: imageParam(), layer: layerParam(), name: renameParam(),
  },
  example: {
    nodes: {
      n: { type: 'tex_noise', params: { resolution: 256 } },
      out: { type: 'tex_levels', in: ['n'], params: { in_low: 0.3, in_high: 0.7, gamma: 1.2 } },
    },
    output: 'out',
  },
  cook: (ctx) => {
    const { p } = ctx;
    const s = source(ctx, 0, p.image, p.layer);
    return withLayer(s, mapValues(s.data, s.ch, levelsFn(p.in_low, p.in_high, p.gamma, p.out_low, p.out_high, !!p.clamp)), outName(ctx));
  },
});

defineNode({
  type: 'tex_curves',
  usesNodeName: NAMED_BY_NODE,
  category: 'texture',
  summary: 'Curves: map every value through a ramp (a tone curve).',
  description: 'Substance: Curve; Houdini COP: Lookup. ramp keys [[in, out], …] interpolated linearly (input clamped to 0..1). Applies to grey or RGB (alpha untouched); a colour ramp maps through its luminance.',
  aliases: ['tone_curve', 'cop_lookup', 'lookup_texture', 'texture_curve'],
  inputs: FILTER_INPUT,
  params: {
    ramp: { type: 'ramp', default: [[0, 0], [0.5, 0.5], [1, 1]], desc: 'tone curve [[in, out], …]', aliases: ['curve', 'lut'] },
    image: imageParam(), layer: layerParam(), name: renameParam(),
  },
  example: { nodes: { n: { type: 'tex_noise', params: { resolution: 256 } }, out: { type: 'tex_curves', in: ['n'], params: { ramp: [[0, 0], [0.4, 0.1], [0.6, 0.9], [1, 1]] } } }, output: 'out' },
  cook: (ctx) => {
    const { p } = ctx;
    const s = source(ctx, 0, p.image, p.layer);
    const { lut, ch } = rampLUT((t) => evalRamp(p.ramp, t));
    const grey = ch === 1 ? lut : Float32Array.from({ length: lut.length / 3 }, (_, k) => lut[k * 3] * 0.2126 + lut[k * 3 + 1] * 0.7152 + lut[k * 3 + 2] * 0.0722);
    return withLayer(s, curvesLayer(s.data, s.ch, grey), outName(ctx));
  },
});

defineNode({
  type: 'tex_blur',
  usesNodeName: NAMED_BY_NODE,
  category: 'texture',
  summary: 'Blur an image: gaussian or box, separable; tileable images blur across their borders (the mean is preserved).',
  description: 'Substance: Blur HQ; Houdini COP: Blur. radius in pixels (gaussian: radius = 2 sigma, three box passes of running sums, so the cost does not depend on the radius).',
  aliases: ['blur', 'cop_blur', 'blur_hq', 'gaussian_blur'],
  inputs: FILTER_INPUT,
  params: {
    radius: { type: 'float', default: 4, min: 0, desc: 'blur radius in pixels', aliases: ['intensity', 'size'] },
    mode: { type: 'enum', options: ['gaussian', 'box'], default: 'gaussian', desc: 'filter shape', aliases: ['type', 'filter'] },
    tileable: tileParam(),
    image: imageParam(), layer: layerParam(), name: renameParam(),
  },
  example: {
    nodes: {
      bricks: { type: 'tex_pattern', params: { resolution: 256 } },
      out: { type: 'tex_blur', in: ['bricks'], params: { radius: 2 } },
    },
    output: 'out',
  },
  cook: (ctx) => {
    const { p } = ctx;
    const s = source(ctx, 0, p.image, p.layer);
    return withLayer(s, blurLayer(s.data, s.ch, s.img.width, s.img.height, p.radius, p.mode, !!p.tileable), outName(ctx));
  },
});

defineNode({
  type: 'tex_warp',
  usesNodeName: NAMED_BY_NODE,
  category: 'texture',
  summary: 'Warp an image by a second image: directional, along its slope, or by an RG vector map.',
  description: 'Substance: Warp / Directional Warp / Vector Warp; Houdini COP: Displace. intensity is the largest offset as a fraction of the image width: directional moves each pixel by intensity × warp value along angle; slope along the warp image\'s gradient (normalised so the steepest slope moves intensity); vector by (R, G) × 2 − 1 of an RGBA warp image.',
  aliases: ['warp', 'directional_warp', 'vector_warp', 'cop_displace', 'distort'],
  inputs: [
    { name: 'image', desc: 'image to warp (its geometry passes through)' },
    { name: 'warp', desc: 'grey (directional, slope) or RGBA (vector) warp image' },
  ],
  params: {
    mode: { type: 'enum', options: WARP_MODES, default: 'slope', desc: 'how the warp image moves pixels', aliases: ['type'] },
    intensity: { type: 'float', default: 0.02, desc: 'largest offset as a fraction of the image width', aliases: ['amount', 'strength'] },
    angle: { type: 'float', default: 0, desc: 'directional: direction in degrees (0 = +u)' },
    tileable: tileParam(),
    image: imageParam(), layer: layerParam(),
    warp_image: imageParam('input 1 (the warp image)', []),
    warp_layer: { type: 'string', default: '', desc: 'layer of the warp image ("" = main)' },
    name: renameParam(),
  },
  example: {
    nodes: {
      bricks: { type: 'tex_pattern', params: { resolution: 256 } },
      n: { type: 'tex_noise', params: { resolution: 256, scale: 4 } },
      out: { type: 'tex_warp', in: ['bricks', 'n'], params: { mode: 'slope', intensity: 0.03 } },
    },
    output: 'out',
  },
  cook: (ctx) => {
    const { p } = ctx;
    const s = source(ctx, 0, p.image, p.layer);
    const w = s.img.width, h = s.img.height;
    const W = sourceAt(ctx, 1, w, h, p.warp_image, p.warp_layer, !!p.tileable, 'warp_image');
    if (!W) throw new NodeError(`${ctx.type}: connect a warp image to input 1`);
    return withLayer(s, warpLayer(s.data, s.ch, w, h, W.data, W.ch, p.mode, p.intensity, p.angle, !!p.tileable), outName(ctx));
  },
});

defineNode({
  type: 'tex_transform',
  usesNodeName: NAMED_BY_NODE,
  category: 'texture',
  summary: 'Offset, rotate, scale and tile an image (2D transform with wrap).',
  description: 'Substance: Transformation 2D; Houdini COP: Transform. The content is repeated `tile` times, scaled by `scale` (> 1 enlarges), rotated about the centre and shifted by offset (uv). With tileable the source repeats, else the outside is 0. Whole-number tiling and offsets keep a tileable image tileable; other rotations generally do not.',
  aliases: ['transform_texture', 'transformation_2d', 'offset_texture', 'tile_texture', 'cop_transform'],
  inputs: FILTER_INPUT,
  params: {
    offset: { type: 'vec2', default: [0, 0], desc: 'shift in uv (0.5 = half the image)', aliases: ['translate', 't'] },
    rotate: { type: 'float', default: 0, desc: 'rotation in degrees (counter-clockwise)', aliases: ['rotation', 'r', 'angle'] },
    scale: { type: 'vec2', default: [1, 1], desc: 'zoom (> 1 enlarges the content)', aliases: ['s', 'zoom'] },
    tile: { type: 'vec2', default: [1, 1], min: 0.001, desc: 'repeats of the content along u and v', aliases: ['tiling', 'repeat'] },
    tileable: tileParam('repeat the source outside 0..1 (else black)'),
    image: imageParam(), layer: layerParam(), name: renameParam(),
  },
  example: {
    nodes: {
      star: { type: 'tex_shape', params: { resolution: 256, shape: 'star' } },
      out: { type: 'tex_transform', in: ['star'], params: { rotate: 45, tile: [4, 4] } },
    },
    output: 'out',
  },
  cook: (ctx) => {
    const { p } = ctx;
    const s = source(ctx, 0, p.image, p.layer);
    return withLayer(s, transformLayer(s.data, s.ch, s.img.width, s.img.height, [p.offset[0], p.offset[1]], p.rotate, [p.scale[0], p.scale[1]], [p.tile[0], p.tile[1]], !!p.tileable), outName(ctx));
  },
});

defineNode({
  type: 'tex_edge_detect',
  usesNodeName: NAMED_BY_NODE,
  category: 'texture',
  summary: 'Edge detection: Sobel gradient magnitude of the (grey) image, scaled and optionally thickened.',
  description: 'Substance: Edge Detect; Houdini COP: Edge Detect. A 0 → 1 step gives about 1 at strength 1; width grows the lines by that many pixels (max filter).',
  aliases: ['edge_detect', 'edges_texture', 'sobel', 'cop_edge'],
  inputs: FILTER_INPUT,
  params: {
    strength: { type: 'float', default: 1, min: 0, desc: 'multiplier of the gradient magnitude', aliases: ['intensity', 'contrast'] },
    width: { type: 'float', default: 0, min: 0, max: 64, desc: 'thicken the edges by this many pixels' },
    tileable: tileParam(),
    image: imageParam(), layer: layerParam(), name: renameParam(),
  },
  example: {
    nodes: {
      bricks: { type: 'tex_pattern', params: { resolution: 256 } },
      out: { type: 'tex_edge_detect', in: ['bricks'], params: { width: 1 } },
    },
    output: 'out',
  },
  cook: (ctx) => {
    const { p } = ctx;
    const s = source(ctx, 0, p.image, p.layer);
    return withLayer(s, edgeDetect(toGrey(s.data, s.ch), s.img.width, s.img.height, p.strength, p.width, !!p.tileable), outName(ctx));
  },
});

defineNode({
  type: 'tex_invert',
  usesNodeName: NAMED_BY_NODE,
  category: 'texture',
  summary: 'Invert: 1 - value (grey or RGB; alpha untouched).',
  aliases: ['invert', 'cop_invert', 'negate'],
  inputs: FILTER_INPUT,
  params: { image: imageParam(), layer: layerParam(), name: renameParam() },
  example: { nodes: { n: { type: 'tex_noise', params: { resolution: 256 } }, out: { type: 'tex_invert', in: ['n'] } }, output: 'out' },
  cook: (ctx) => {
    const s = source(ctx, 0, ctx.p.image, ctx.p.layer);
    return withLayer(s, mapValues(s.data, s.ch, (x) => 1 - x), outName(ctx));
  },
});

defineNode({
  type: 'tex_threshold',
  usesNodeName: NAMED_BY_NODE,
  category: 'texture',
  summary: 'Threshold: grey 1 where the value (luminance) is above threshold, else 0, with an optional soft band.',
  aliases: ['threshold', 'cop_threshold', 'binarize'],
  inputs: FILTER_INPUT,
  params: {
    threshold: { type: 'float', default: 0.5, desc: 'cut value', aliases: ['level', 'value'] },
    softness: { type: 'float', default: 0, min: 0, max: 1, desc: 'width of the smooth transition around threshold', aliases: ['smooth', 'falloff'] },
    image: imageParam(), layer: layerParam(), name: renameParam(),
  },
  example: {
    nodes: {
      n: { type: 'tex_noise', params: { resolution: 256 } },
      out: { type: 'tex_threshold', in: ['n'], params: { threshold: 0.55, softness: 0.05 } },
    },
    output: 'out',
  },
  cook: (ctx) => {
    const { p } = ctx;
    const s = source(ctx, 0, p.image, p.layer);
    const g = toGrey(s.data, s.ch), out = new Float32Array(g.length);
    const lo = p.threshold - p.softness / 2, hi = p.threshold + p.softness / 2;
    for (let i = 0; i < g.length; i++) {
      const x = g[i];
      if (hi <= lo) out[i] = x >= p.threshold ? 1 : 0;
      else { const t = Math.max(0, Math.min(1, (x - lo) / (hi - lo))); out[i] = t * t * (3 - 2 * t); }
    }
    return withLayer(s, out, outName(ctx));
  },
});

defineNode({
  type: 'tex_histogram_scan',
  usesNodeName: NAMED_BY_NODE,
  category: 'texture',
  summary: 'Histogram scan: turn a grey image into a mask with a set white coverage (or a threshold position) and hardness (contrast); the classic mask maker.',
  description:
    'Substance: Histogram Scan. coverage is the fraction of the image that turns white, measured on its own histogram: ' +
    '0.3 makes the brightest 30 % of the pixels white whatever the input\'s range (a noise of 0..0.48, a curvature bake), ' +
    'so a value read off a wear reference works on any input. With coverage -1, position sets a value cut instead: the ' +
    'cut sits at 1 - position (0 = black, 1 = white; 0.5 with contrast 0 = unchanged), so how much turns white depends ' +
    'on the input. contrast is the hardness of the transition around the cut (1 = hard; softer edges blend around the ' +
    'same cut). The stat coverage reports the fraction of the result above 0.5. Use on noise or a curvature bake to ' +
    'grow wear or dirt masks.',
  aliases: ['histogram_scan', 'histogramscan', 'scan'],
  inputs: FILTER_INPUT,
  params: {
    coverage: { type: 'float', default: -1, min: -1, max: 1, desc: 'fraction of the pixels that turn white (0.3 = the brightest 30 %), from the image\'s own histogram; -1 = use position', aliases: ['white_fraction', 'amount'] },
    position: { type: 'float', default: 0.5, min: 0, max: 1, desc: 'coverage -1: value cut at 1 - position (higher = more white; how much depends on the input\'s range)' },
    contrast: { type: 'float', default: 0.5, min: 0, max: 1, desc: 'hardness of the transition (1 = hard cut)' },
    image: imageParam(), layer: layerParam(), name: renameParam(),
  },
  outputs: 'the mask (grey) named <name> (default: the node name); stat coverage = its fraction above 0.5',
  example: {
    nodes: {
      n: { type: 'tex_noise', params: { resolution: 256, scale: 4 } },
      out: { type: 'tex_histogram_scan', in: ['n'], params: { coverage: 0.3, contrast: 0.8 } },
    },
    output: 'out',
  },
  cook: (ctx) => {
    const { p } = ctx;
    const s = source(ctx, 0, p.image, p.layer);
    const g = toGrey(s.data, s.ch);
    const f = p.coverage >= 0 ? histogramScanFn(1 - coverageCut(g, p.coverage, p.contrast), p.contrast) : histogramScanFn(p.position, p.contrast);
    const out = new Float32Array(g.length);
    let white = 0;
    for (let i = 0; i < g.length; i++) { out[i] = f(g[i]); if (out[i] > 0.5) white++; }
    ctx.stat('coverage', white / Math.max(1, g.length));
    return withLayer(s, out, outName(ctx));
  },
});

defineNode({
  type: 'tex_normal_from_height',
  usesNodeName: NAMED_BY_NODE,
  category: 'texture',
  summary: 'Normal map from a height image (Sobel) in physical units (relief depth and texture size in metres): tangent-space RGBA, OpenGL (+Y up) or DirectX (Y down).',
  description:
    'Substance: Normal (from height); Houdini COP: Bump to Normal. The slope is real: a value of 1 stands `depth` metres ' +
    'high and the image spans `size` metres on the model, so one texel is size / width metres and the normal tilts by ' +
    'atan(height step × depth / texel size). The same graph gives the same normals at any resolution, and a value you ' +
    'can measure picks the strength: 0.0003 for paint and cast grain, 0.002 for hammered metal, 0.01 to 0.02 for brick ' +
    'and mortar. For bake_height\'s "distance" layer (metres already) use depth 1 and the size the uv square covers. ' +
    'Steps narrower than a texel (hard pattern edges, thresholds) stay steeper at higher resolutions, as a finer step is ' +
    'physically steeper; give them a bevel or blur them in uv units. A flat image gives (0.5, 0.5, 1). glTF and Blender ' +
    'use OpenGL; Unreal uses DirectX (or flip green on import). Combine with another normal map in tex_normal_blend.',
  aliases: ['normal_from_height', 'height_to_normal', 'normal_map', 'bump_to_normal', 'cop_bumptonormal'],
  inputs: FILTER_INPUT,
  params: {
    depth: { type: 'float', default: 0.01, desc: 'relief: metres a height value of 1 stands above 0 (negative inverts the relief)', aliases: ['height', 'height_scale', 'bump_depth', 'relief'] },
    size: { type: 'float', default: 1, min: 1e-6, desc: 'metres the image width covers on the model (the texel size is size / width)', aliases: ['texture_size', 'world_size', 'tile_size'] },
    format: { type: 'enum', options: ['opengl', 'directx'], default: 'opengl', desc: 'green channel convention', aliases: ['convention'] },
    tileable: tileParam(),
    image: imageParam(), layer: layerParam(), name: renameParam(),
  },
  example: {
    nodes: {
      bricks: { type: 'tex_pattern', params: { resolution: 256 } },
      brick_normal: { type: 'tex_normal_from_height', in: ['bricks'], params: { depth: 0.015, size: 1 } },
    },
    output: 'brick_normal',
  },
  cook: (ctx) => {
    const { p } = ctx;
    const s = source(ctx, 0, p.image, p.layer);
    return withLayer(s, normalFromHeight(toGrey(s.data, s.ch), s.img.width, s.img.height, p.depth, p.size, p.format === 'directx', !!p.tileable), outName(ctx));
  },
});

defineNode({
  type: 'tex_normal_blend',
  usesNodeName: NAMED_BY_NODE,
  category: 'texture',
  summary: 'Combine two normal maps: a detail (micro grain, a tiling pattern) over a base (a baked normal map), reoriented (RNM) by default, with strength and an optional mask.',
  description:
    'Substance: Normal Combine / Normal Blend; Unreal: BlendAngleCorrectedNormals. The detail\'s tilt is scaled by ' +
    'strength (0 = no detail, 2 = twice as steep), then: rnm (reoriented normal mapping) rotates the detail onto the ' +
    'base normal, so the baked shapes and the detail both keep their depth; udn adds the detail\'s x and y to the base ' +
    '(cheaper, flattens strong detail on steep base slopes); linear normalises the sum (softens both, even the base). ' +
    'The mask (input 2, grey) fades from the base where it is 0 to the blend where it is 1. The detail and mask are ' +
    'resized to the base; the base\'s alpha is kept. Both maps must use the same green convention (OpenGL or DirectX). ' +
    'tex_blend overlay is no substitute: it flattens and skews normal maps.',
  aliases: ['normal_blend', 'blend_normals', 'normal_combine', 'rnm', 'detail_normal', 'combine_normals'],
  inputs: [
    { name: 'base', desc: 'base normal map (RGBA; its geometry passes through)' },
    { name: 'detail', desc: 'detail normal map (RGBA) laid over the base' },
    { name: 'mask', desc: 'grey mask: where the detail applies (optional)', optional: true },
  ],
  params: {
    mode: { type: 'enum', options: NORMAL_BLEND_MODES, default: 'rnm', desc: 'rnm = reoriented (keeps both reliefs), udn = add x and y (cheaper), linear = normalised sum (softens both)', aliases: ['method', 'blend_mode'] },
    strength: { type: 'float', default: 1, min: 0, desc: 'detail tilt multiplier (0 = base only, 1 = as baked, 2 = twice as steep)', aliases: ['intensity', 'detail_strength', 'amount'] },
    image: imageParam('input 0 (the base)'), layer: layerParam(),
    detail_image: imageParam('input 1 (the detail)', []),
    detail_layer: { type: 'string', default: '', desc: 'layer of the detail ("" = main)' },
    mask_image: imageParam('input 2 (the mask)', []),
    mask_layer: { type: 'string', default: '', desc: 'layer of the mask ("" = main)' },
    tileable: tileParam('resizing the detail and mask wraps at the borders'),
    name: renameParam(),
  },
  outputs: 'the base image with the combined normal map (RGBA), named <name> (default: the node name)',
  example: {
    nodes: {
      bricks: { type: 'tex_pattern', params: { resolution: 256, count: [4, 8] } },
      base: { type: 'tex_normal_from_height', in: ['bricks'], params: { depth: 0.015 } },
      grain: { type: 'tex_noise', params: { resolution: 256, scale: 40, octaves: 3 } },
      detail: { type: 'tex_normal_from_height', in: ['grain'], params: { depth: 0.0004 } },
      out: { type: 'tex_normal_blend', in: ['base', 'detail'], params: { mode: 'rnm', strength: 1 } },
    },
    output: 'out',
  },
  cook: (ctx) => {
    const { p, type } = ctx;
    const A = source(ctx, 0, p.image, p.layer);
    const w = A.img.width, h = A.img.height, wrap = !!p.tileable;
    const B = sourceAt(ctx, 1, w, h, p.detail_image, p.detail_layer, wrap, 'detail_image');
    if (!B) throw new NodeError(`${type}: connect a detail normal map to input 1`);
    const rgba = 'normal maps are RGBA images (tex_normal_from_height, bake_normal, image_file of a normal map)';
    if (A.ch !== 4) throw new NodeError(`${type}: the base "${A.img.name}" is a grey image, not a normal map`, rgba);
    if (B.ch !== 4) throw new NodeError(`${type}: the detail on input 1 is a grey image, not a normal map`, `${rgba}; turn a height into one with tex_normal_from_height`);
    const M = sourceAt(ctx, 2, w, h, p.mask_image, p.mask_layer, wrap, 'mask_image');
    return withLayer(A, blendNormals(A.data, B.data, M ? toGrey(M.data, M.ch) : null, p.mode, Math.max(0, p.strength)), outName(ctx));
  },
});

defineNode({
  type: 'tex_height_to_ao',
  usesNodeName: NAMED_BY_NODE,
  category: 'texture',
  summary: 'Ambient occlusion of a height image (horizon based): white = open, dark in pits, gaps and mortar.',
  description: 'Substance: Ambient Occlusion (HBAO). For each pixel, `directions` rays march `steps` samples up to radius (a fraction of the image width) and keep the highest horizon; depth sets how tall a height of 1 is (in image widths).',
  aliases: ['height_to_ao', 'hbao', 'ao_from_height', 'texture_ao'],
  inputs: FILTER_INPUT,
  params: {
    radius: { type: 'float', default: 0.05, min: 0.0001, max: 1, desc: 'search radius as a fraction of the image width' },
    depth: { type: 'float', default: 0.05, min: 0, desc: 'height of a value of 1 in image widths (larger = deeper shadows)', aliases: ['height_depth'] },
    directions: { type: 'int', default: 8, min: 1, max: 32, desc: 'directions per pixel', aliases: ['dirs'] },
    steps: { type: 'int', default: 6, min: 1, max: 64, desc: 'samples along each direction' },
    tileable: tileParam(),
    image: imageParam(), layer: layerParam(), name: renameParam(),
  },
  example: {
    nodes: {
      bricks: { type: 'tex_pattern', params: { resolution: 256 } },
      out: { type: 'tex_height_to_ao', in: ['bricks'], params: { radius: 0.03, name: 'brick_ao' } },
    },
    output: 'out',
  },
  cook: (ctx) => {
    const { p } = ctx;
    const s = source(ctx, 0, p.image, p.layer);
    return withLayer(s, heightToAO(toGrey(s.data, s.ch), s.img.width, s.img.height, p.radius, p.depth, p.directions, p.steps, !!p.tileable), outName(ctx));
  },
});

defineNode({
  type: 'tex_channel',
  usesNodeName: NAMED_BY_NODE,
  category: 'texture',
  summary: 'Pack grey images into the R, G, B, A channels of one RGBA image (e.g. ORM for glTF/Unreal: occlusion, roughness, metallic), or extract one channel as grey.',
  description: 'Substance: RGBA Merge / RGBA Split / Channel Shuffle; Houdini COP: Channel Copy. pack: inputs 0..3 fill R, G, B, A (their luminance; each input holds one image); unconnected channels take fill (default [1, 0.5, 0, 1]: occlusion 1, roughness 0.5, metallic 0, alpha 1, the ORM convention of glTF and Unreal). The size is the first connected input\'s; others are resized. extract: one channel of an image of input 0 as a grey image (keeps the input, replacing the layer).',
  aliases: ['channel_pack', 'pack_channels', 'rgba_merge', 'rgba_split', 'channel_shuffle', 'orm_pack', 'cop_channelcopy'],
  inputs: [
    { name: 'r', desc: 'red source (pack) or the image to split (extract)', optional: true },
    { name: 'g', desc: 'green source', optional: true },
    { name: 'b', desc: 'blue source', optional: true },
    { name: 'a', desc: 'alpha source', optional: true },
  ],
  params: {
    mode: { type: 'enum', options: ['pack', 'extract'], default: 'pack', desc: 'pack inputs into RGBA, or extract a channel of input 0' },
    channel: { type: 'enum', options: ['r', 'g', 'b', 'a', 'luminance'], default: 'r', desc: 'extract: which channel' },
    fill: { type: 'vec4', default: [1, 0.5, 0, 1], desc: 'pack: values of unconnected channels' },
    image: imageParam('input 0 (extract)'),
    name: nameParam('pack: the new image\'s name, extract: the result\'s ("" = this node\'s name)'),
  },
  outputs: 'pack: a new RGBA image <name> (default: the node name); extract: input 0 with the channel as its layer, renamed <name>',
  example: {
    nodes: {
      ao: { type: 'tex_noise', params: { resolution: 256, scale: 3 } },
      rough: { type: 'tex_cells', params: { resolution: 256 } },
      orm: { type: 'tex_channel', in: ['ao', 'rough'], params: { fill: [1, 0.5, 0, 1] } },
    },
    output: 'orm',
  },
  cook: (ctx) => {
    const { p, type } = ctx;
    if (p.mode === 'extract') {
      const s = source(ctx, 0, p.image);
      const k = ['r', 'g', 'b', 'a'].indexOf(p.channel);
      const n = s.img.count, out = new Float32Array(n);
      if (s.ch === 1) out.set(p.channel === 'a' ? new Float32Array(n).fill(1) : s.data);
      else if (k < 0) out.set(toGrey(s.data, 4));
      else for (let i = 0; i < n; i++) out[i] = s.data[i * 4 + k];
      return withLayer(s, out, outName(ctx));
    }
    const first = [0, 1, 2, 3].find((i) => ctx.hasInput(i));
    if (first === undefined) throw new NodeError(`${type}: connect at least one input (R, G, B or A)`);
    const ref = source(ctx, first, '', '', '');
    const w = ref.img.width, h = ref.img.height, n = w * h;
    const out = new Float32Array(n * 4);
    for (let c = 0; c < 4; c++) {
      const s = sourceAt(ctx, c, w, h);
      const g = s ? toGrey(s.data, s.ch) : null;
      for (let i = 0; i < n; i++) out[i * 4 + c] = g ? g[i] : p.fill[c];
    }
    return imageGeo(new Image(w, h, outName(ctx)).set(MAIN_LAYER, out));
  },
});

defineNode({
  type: 'tex_colorize',
  usesNodeName: NAMED_BY_NODE,
  category: 'texture',
  summary: 'Colorize: map a grey image through a colour ramp (gradient map) into RGBA.',
  description: 'Substance: Gradient Map; Houdini COP: Ramp lookup. ramp keys [[pos, colour], …] with colours as [r, g, b] or "#hex"; the image holds those numbers as they are, so a "#a5462e" key comes out of the PNG as #a5462e. RGBA input uses its luminance.',
  aliases: ['colorize', 'gradient_map', 'colourize', 'color_ramp', 'tint'],
  inputs: FILTER_INPUT,
  params: {
    ramp: { type: 'ramp', default: [[0, '#000000'], [1, '#ffffff']], desc: 'colour ramp [[pos, colour], …]', aliases: ['gradient', 'colors', 'colours'] },
    image: imageParam(), layer: layerParam(), name: renameParam(),
  },
  example: { nodes: { n: { type: 'tex_cells', params: { resolution: 256, output: 'distance' } }, out: { type: 'tex_colorize', in: ['n'], params: { ramp: [[0, '#3b2316'], [0.5, '#8a4b2a'], [1, '#c9845a']] } } }, output: 'out' },
  cook: (ctx) => {
    const { p } = ctx;
    const s = source(ctx, 0, p.image, p.layer);
    const { lut, ch } = rampLUT((t) => evalRamp(p.ramp, t));
    return withLayer(s, colorize(toGrey(s.data, s.ch), lut, ch), outName(ctx));
  },
});

defineNode({
  type: 'tex_tile_sampler',
  usesNodeName: NAMED_BY_NODE,
  category: 'texture',
  summary: 'Tile sampler: scatter an image (a shape, a brick, a pebble) N × M times with random offset, rotation, scale and intensity; optional mask.',
  description: 'Substance: Tile Sampler / Splatter Circular. One instance per grid cell: position jitter (fraction of a cell), rotation ± degrees, scale range relative to a cell, intensity range; with a mask (input 1), a cell keeps its instance with probability mask(cell centre). Instances wrap at the borders (tileable) and combine with max or add. Output grey (the source\'s luminance).',
  aliases: ['tile_sampler', 'tilesampler', 'scatter_texture', 'stamp_scatter'],
  inputs: [
    { name: 'pattern', desc: 'image to scatter (e.g. tex_shape)' },
    { name: 'mask', desc: 'grey mask: probability of a cell keeping its instance', optional: true },
  ],
  params: {
    resolution: resolutionParam(),
    count: { type: 'ivec2', default: [8, 8], min: 1, max: 1024, desc: 'grid cells along u and v (one instance each)', aliases: ['tiles', 'x_y_amount'] },
    scale: { type: 'vec2', default: [0.8, 1], min: 0, desc: 'instance size range relative to a cell', aliases: ['instance_size'] },
    rotation: { type: 'float', default: 180, min: 0, max: 180, desc: 'random rotation ± degrees', aliases: ['rotation_random'] },
    jitter: { type: 'float', default: 0.5, min: 0, max: 2, desc: 'random position offset (fraction of a cell)', aliases: ['position_random'] },
    offset: { type: 'float', default: 0, min: 0, max: 1, desc: 'shift of every other row (fraction of a cell)' },
    intensity: { type: 'vec2', default: [0.6, 1], min: 0, desc: 'intensity range per instance', aliases: ['luminance_random'] },
    combine: { type: 'enum', options: ['max', 'add'], default: 'max', desc: 'how overlapping instances combine', aliases: ['blend'] },
    seed: P.seed(),
    image: imageParam('input 0 (the pattern)'), layer: layerParam(),
    mask_image: imageParam('input 1 (the mask)', []),
    name: nameParam(),
  },
  outputs: 'a new image <name> (default: the node name): C grey',
  example: {
    nodes: {
      stamp: { type: 'tex_shape', params: { resolution: 128, shape: 'disc', falloff: 0.6 } },
      out: { type: 'tex_tile_sampler', in: ['stamp'], params: { count: [12, 12], scale: [0.3, 0.9] } },
    },
    output: 'out',
  },
  cook: (ctx) => {
    const { p, type } = ctx;
    const [w, h] = size2(p, type);
    const s = source(ctx, 0, p.image, p.layer);
    const m = sourceAt(ctx, 1, w, h, p.mask_image, '', true, 'mask_image');
    const C = tileSampler(toGrey(s.data, s.ch), s.img.width, s.img.height, w, h, {
      count: [p.count[0], p.count[1]], scale: [p.scale[0], p.scale[1]], rotation: p.rotation, jitter: p.jitter, offset: p.offset,
      intensity: [p.intensity[0], p.intensity[1]], seed: p.seed, add: p.combine === 'add',
    }, m ? toGrey(m.data, m.ch) : null);
    return imageGeo(new Image(w, h, outName(ctx)).set(MAIN_LAYER, C));
  },
});

// ---------------------------------------------------------------- output, materials and bridges

defineNode({
  type: 'tex_output',
  usesNodeName: NAMED_BY_NODE,
  category: 'texture',
  summary: 'Name an image (rename), or copy one of its layers out as a new image (e.g. the "id" layer of a pattern).',
  description: 'Substance: Output node; Houdini COP: Null / Output. With layer "" the image is renamed to `name` (default: this node\'s name); with a layer, a new image `name` holds that layer as C and the original stays. An image already called `name` is replaced. keep_only drops every other image (and the mesh) from the output: the way to isolate one image of a stack.',
  aliases: ['texture_output', 'rename_image', 'image_output', 'cop_null'],
  inputs: FILTER_INPUT,
  params: {
    name: nameParam(),
    image: imageParam(),
    layer: { type: 'string', default: '', desc: 'copy this layer out as a new image ("" = rename the whole image)' },
    keep_only: { type: 'bool', default: false, desc: 'output only this image' },
  },
  outputs: 'the image renamed <name> (default: the node name), or with layer set a new image <name> holding that layer',
  example: {
    nodes: {
      bricks: { type: 'tex_pattern', params: { resolution: 256 } },
      brick_id: { type: 'tex_output', in: ['bricks'], params: { layer: 'id' } },
    },
    output: 'brick_id',
  },
  cook: (ctx) => {
    const { p } = ctx;
    const name = outName(ctx);
    const s = source(ctx, 0, p.image, p.layer);
    let img: Image;
    const g = s.g.clone();
    if (p.layer) {
      img = new Image(s.img.width, s.img.height, name).set(MAIN_LAYER, s.data);
      g.volumes.push(img);
    } else {
      img = s.img.clone();
      img.name = name;
      g.volumes[s.index] = img;
    }
    // a rename onto an existing name replaces that image
    g.volumes = g.volumes.filter((v) => !(isImage(v) && v.name === name && v !== img));
    if (p.keep_only) return imageGeo(img);
    return g;
  },
});

const SLOTS: [param: string, slot: 'baseColor' | 'normal' | 'roughness' | 'orm'][] = [['base_color', 'baseColor'], ['normal', 'normal'], ['roughness', 'roughness'], ['orm', 'orm']];

defineNode({
  type: 'texture_to_material',
  category: 'texture',
  summary: 'Attach images as texture maps (base colour, normal, roughness, ORM) to a named material and assign it; the images travel with the geometry and exporters embed them.',
  description:
    'Input 0 is the mesh (with uv), input 1 the images (merge several texture branches first). Each slot names an image ' +
    'of input 1 (or input 0), by default the name of the node that made it; it is copied into the output and the ' +
    'material table entry gets "image:<name>" in that slot (two different images under the named one are an error). ' +
    'orm is a packed occlusion (R) / roughness (G) / metallic (B) map (tex_channel pack), written to glTF as the ' +
    'metallicRoughness and occlusion textures and to USD through the r/g/b outputs; occlusion and metallic images given ' +
    'separately are packed into "<material>_orm" (missing channels from the material: occlusion 1, its roughness and ' +
    'metallic; a roughness image goes in too). The material is created with defaults when missing (or updated) and ' +
    'assigned to the prims of `group` ("" = every prim when the material is new, none when it exists). render ' +
    '{textures: true} shows base colour maps on the mesh; views "texture" shows the images.',
  aliases: ['texture_material', 'material_textures', 'attach_textures', 'apply_textures'],
  inputs: [
    { name: 'geo', desc: 'mesh to texture (needs uv)' },
    { name: 'images', desc: 'geometry holding the images (merge texture branches)', optional: true },
  ],
  params: {
    material: { type: 'string', default: 'material', desc: 'material name (created when missing)', aliases: ['material_name', 'shop_materialpath'] },
    base_color: { type: 'string', default: '', desc: 'image for the base colour (written as sRGB)', aliases: ['basecolor', 'albedo', 'diffuse', 'color'] },
    normal: { type: 'string', default: '', desc: 'image for the tangent-space normal map (OpenGL convention)', aliases: ['normal_map'] },
    roughness: { type: 'string', default: '', desc: 'image for roughness (grey)', aliases: ['roughness_map', 'rough'] },
    metallic: { type: 'string', default: '', desc: 'image for metallic (grey; packed into the ORM map)', aliases: ['metalness'] },
    occlusion: { type: 'string', default: '', desc: 'image for ambient occlusion (grey; packed into the ORM map)', aliases: ['ao'] },
    orm: { type: 'string', default: '', desc: 'packed occlusion / roughness / metallic image (R, G, B)', aliases: ['orm_map', 'packed'] },
    group: P.group('prim', 'prims that get the material ("" = all prims when the material is new, else none)'),
    base_color_tint: { type: 'color', default: [1, 1, 1], desc: 'base colour factor of a new material (glTF writes white under a base colour map)', aliases: ['tint'] },
    roughness_value: { type: 'float', default: 0.8, min: 0, max: 1, desc: 'roughness of a new material (the ORM green channel when no roughness image is given)' },
    metallic_value: { type: 'float', default: 0, min: 0, max: 1, desc: 'metallic of a new material (the ORM blue channel when no metallic image is given)' },
  },
  outputs: 'prim "material", detail "materials" with image:<name> texture slots, the referenced images as image volumes',
  example: {
    nodes: {
      box: { type: 'box' },
      uv: { type: 'uv_project', in: ['box'], params: { method: 'box' } },
      bricks: { type: 'tex_pattern', params: { resolution: 256 } },
      brick_color: { type: 'tex_colorize', in: ['bricks'], params: { ramp: [[0, '#6b6b66'], [0.5, '#7a3424'], [1, '#a5462e']] } },
      brick_normal: { type: 'tex_normal_from_height', in: ['bricks'], params: { depth: 0.02 } },
      maps: { type: 'merge', in: ['brick_color', 'brick_normal'] },
      out: { type: 'texture_to_material', in: ['uv', 'maps'], params: { material: 'brick', base_color: 'brick_color', normal: 'brick_normal' } },
    },
    output: 'out',
  },
  cook: (ctx) => {
    const { p, type } = ctx;
    const mat = String(p.material ?? '').trim();
    if (!mat) throw new NodeError(`${type}: material name is empty`);
    const g = ctx.input(0).clone();
    // images by name; two different images under one name are ambiguous (reported when a slot names them)
    const pool = new Map<string, Image>(), clash = new Set<string>();
    const add = (im: Image) => {
      const had = pool.get(im.name);
      if (!had) pool.set(im.name, im);
      else if (!sameImage(had, im)) clash.add(im.name);
    };
    for (const im of imagesOf(ctx.input(0))) add(im);
    if (ctx.hasInput(1)) for (const im of imagesOf(ctx.input(1))) add(im);
    const need = (param: string): Image | null => {
      const n = String(p[param] ?? '').trim().replace(/^image:/, '');
      if (!n) return null;
      const im = pool.get(n);
      if (!im) throw new NodeError(`${type}: no image "${n}" for ${param}`, pool.size ? `images: ${[...pool.keys()].join(', ')}` : NO_IMAGE);
      if (clash.has(n)) throw new NodeError(`${type}: ${param}: the inputs hold different images named "${n}"`, 'give them different names (an image takes the name of the node that made it unless its name param is set; tex_output renames one)');
      return im;
    };
    const table = readMaterials(g);
    const isNew = !table[mat];
    const entry = normalizeMaterial(table[mat] ?? { baseColor: p.base_color_tint, roughness: p.roughness_value, metallic: p.metallic_value });
    const tex: Record<string, string> = { ...(entry.textures ?? {}) };
    const used: Image[] = [];
    for (const [param, slot] of SLOTS) {
      const im = need(param);
      if (im) { tex[slot] = `image:${im.name}`; used.push(im); }
    }
    const occ = need('occlusion'), met = need('metallic');
    if ((occ || met) && !String(p.orm ?? '').trim()) {
      // pack occlusion / roughness / metallic into one RGBA map (glTF / Unreal ORM)
      const rough = need('roughness');
      const ref = (occ ?? met)!;
      const w = ref.width, h = ref.height, n = w * h;
      const grey = (im: Image | null) => {
        if (!im) return null;
        const a = im.layer(im.mainLayer)!, ch = channelsOf(a, im.count);
        return toGrey(resizeLayer(a, ch, im.width, im.height, w, h), ch);
      };
      const O = grey(occ), R = grey(rough), M = grey(met);
      const out = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) { out[i * 4] = O ? O[i] : 1; out[i * 4 + 1] = R ? R[i] : entry.roughness; out[i * 4 + 2] = M ? M[i] : entry.metallic; out[i * 4 + 3] = 1; }
      const orm = new Image(w, h, `${mat}_orm`).set(MAIN_LAYER, out);
      used.push(orm);
      tex.orm = `image:${orm.name}`;
      delete tex.roughness;
    }
    if (!used.length) ctx.warn(`${type}: no image named in any slot (base_color, normal, roughness, metallic, occlusion, orm)`);
    table[mat] = normalizeMaterial({ ...entry, textures: tex });
    writeMaterials(g, table);
    // assign
    const groupSet = String(p.group ?? '').trim();
    if (isNew || groupSet) {
      const sel = groupSet ? mask(g, 'prim', groupSet) : null;
      const a = g.prims.add(MATERIAL_ATTRIB, 'string', 1);
      for (let i = 0; i < g.numPrims; i++) if (!sel || sel[i]) a.set(i, mat);
    }
    // carry the images (replacing same-named ones)
    const names = new Set(used.map((u) => u.name));
    g.volumes = g.volumes.filter((v) => !(isImage(v) && names.has(v.name)));
    const seen = new Set<string>();
    for (const im of used) if (!seen.has(im.name)) { seen.add(im.name); g.volumes.push(im.clone()); }
    if (g.numPrims && !readUV(g)) ctx.warn(`${type}: the geometry has no uv attribute; textures need uv (uv_unwrap, uv_project, uv_layout)`);
    return g;
  },
});

defineNode({
  type: 'tex_to_heightfield',
  category: 'texture',
  summary: 'Bridge: an image (grey or luminance) becomes a heightfield of the same sample count (u → +X, v → −Z).',
  description: 'Both are 2D grids: image pixel (i, j) becomes heightfield sample (i, j) (row 0 = the image top = −Z side), height = value × height_scale + height_offset + center.y. size sets the extent in metres along X (Z follows the image aspect). Use texture generators as terrain stamps, or heightfield_to_tex to go back. Writing another layer (layer_name "mask") keeps height at center.y + height_offset.',
  aliases: ['image_to_heightfield', 'texture_to_heightfield', 'tex2hf'],
  inputs: FILTER_INPUT,
  params: {
    size: { type: 'float', default: 20, min: 0.001, desc: 'extent along X in metres' },
    height_scale: { type: 'float', default: 1, desc: 'metres per unit of image value', aliases: ['amplitude'] },
    height_offset: { type: 'float', default: 0, desc: 'added height (metres)' },
    center: P.center(),
    layer_name: { type: 'string', default: 'height', desc: 'heightfield layer to write ("height" or a mask layer)', aliases: ['hf_layer'] },
    image: imageParam(), layer: layerParam(),
  },
  outputs: 'heightfield volume (layers height, mask)',
  example: {
    nodes: {
      n: { type: 'tex_noise', params: { resolution: 129, fractal: 'ridged', scale: 3 } },
      hf: { type: 'tex_to_heightfield', in: ['n'], params: { size: 40, height_scale: 6 } },
    },
    output: 'hf',
  },
  cook: (ctx) => {
    const { p, type } = ctx;
    const s = source(ctx, 0, p.image, p.layer);
    const w = s.img.width, h = s.img.height;
    if (w < 2 || h < 2) throw new NodeError(`${type}: a heightfield needs at least 2 × 2 samples (image is ${w} × ${h})`);
    const cell = p.size / (w - 1);
    const hf = new Heightfield(w, h, cell, [p.center[0] - ((w - 1) * cell) / 2, p.center[2] - ((h - 1) * cell) / 2], undefined, s.img.name);
    const gr = toGrey(s.data, s.ch);
    const ln = String(p.layer_name || 'height');
    const out = new Float32Array(w * h);
    for (let k = 0; k < out.length; k++) out[k] = ln === 'height' ? gr[k] * p.height_scale + p.height_offset + p.center[1] : gr[k];
    hf.layers.set(ln, out);
    if (!hf.layers.has('height')) hf.layers.set('height', new Float32Array(w * h).fill(p.center[1] + p.height_offset));
    if (!hf.layers.has('mask')) hf.layers.set('mask', new Float32Array(w * h));
    const g = new Geometry();
    g.volumes = [hf];
    return g;
  },
});

defineNode({
  type: 'heightfield_to_tex',
  usesNodeName: NAMED_BY_NODE,
  category: 'texture',
  summary: 'Bridge: a heightfield layer becomes a grey image of the same sample count (input_min..input_max fitted to 0..1 by default).',
  description: 'Sample (i, j) → pixel (i, j) (the −Z row at the top). normalize fits input_min..input_max to 0..1 (absolute, so every tile of a map gets the same grey for the same height; values outside the range fall outside 0..1); auto_range fits the layer\'s own min..max instead, which depend on the field\'s extent; off writes raw values. The range used is recorded as the stats range_min / range_max. Feed tex_normal_from_height or tex_height_to_ao for terrain maps, or bake terrain masks into textures.',
  aliases: ['heightfield_to_image', 'hf2tex', 'heightfield_texture'],
  inputs: [{ name: 'heightfield', desc: 'geometry with a heightfield' }],
  params: {
    layer: { type: 'string', default: 'height', desc: 'heightfield layer' },
    normalize: { type: 'bool', default: true, desc: 'fit the input range to 0..1 (off writes raw values)', aliases: ['fit'] },
    input_min: { type: 'float', default: 0, desc: 'layer value that becomes 0 (e.g. the lowest height in metres)' },
    input_max: { type: 'float', default: 1, desc: 'layer value that becomes 1' },
    auto_range: { type: 'bool', default: false, desc: 'use the layer\'s own min..max as the input range instead (depends on the field\'s extent)' },
    keep: { type: 'bool', default: false, desc: 'keep the input (heightfield and all) and add the image; off outputs only the image' },
    name: nameParam(),
  },
  outputs: 'image <name> (default: the node name): C grey',
  example: {
    nodes: {
      hf: { type: 'heightfield' },
      hills: { type: 'heightfield_noise', in: ['hf'], params: { amplitude: 3 } },
      height: { type: 'heightfield_to_tex', in: ['hills'], params: { input_min: -3, input_max: 3 } },
    },
    output: 'height',
  },
  cook: (ctx) => {
    const { p, type } = ctx;
    const hfs = heightfieldsOf(ctx.input(0));
    if (!hfs.length) throw new NodeError(`${type}: input has no heightfield`, 'create one with heightfield, heightfield_from_mesh or tex_to_heightfield');
    const hf = hfs[0];
    const a = hf.layer(p.layer);
    if (!a) throw new NodeError(`${type}: heightfield "${hf.name}" has no layer "${p.layer}"`, `layers: ${[...hf.layers.keys()].join(', ')}`);
    let lo = p.input_min, hi = p.input_max;
    if (p.auto_range) {
      lo = Infinity; hi = -Infinity;
      for (let k = 0; k < a.length; k++) { if (a[k] < lo) lo = a[k]; if (a[k] > hi) hi = a[k]; }
    }
    const out = new Float32Array(a.length);
    const span = hi - lo;
    for (let k = 0; k < a.length; k++) out[k] = p.normalize ? (span !== 0 ? (a[k] - lo) / span : 0) : a[k];
    const img = new Image(hf.width, hf.height, outName(ctx)).set(MAIN_LAYER, out);
    if (p.normalize) { ctx.stat('range_min', lo); ctx.stat('range_max', hi); }
    if (!p.keep) return imageGeo(img);
    const g = ctx.input(0).clone();
    g.volumes.push(img);
    return g;
  },
});
