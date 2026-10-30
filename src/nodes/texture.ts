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
  BLEND_MODES, GRADIENTS, GRUNGE_STYLES, NORMAL_BLEND_MODES, PATTERNS, QUANTIZE_MODES, SHAPES, SLOPE_BLUR_MODES, TILE_SAMPLER_OUTPUTS, WARP_MODES,
  blendLayers, blendNormals, blurLayer, colorize, curvatureFromNormal, curvesLayer, directionalBlur, edgeDetect, flipNormals, genGradient, genGrunge,
  coverageCut, genPattern, genScratches, genShape, genSplatter, heightAO, heightFromNormal, heightToAO, histogramRangeFn, histogramScanFn,
  histogramSelectFn, levelsFn, makeTile, mapValues, normalFromHeight, normalizeNormals, quantizeFn, rampLUT, slopeBlur, tileSampler,
  transformLayer, valueRange, warpLayer,
} from '../core/texture.ts';
import type { CellsJob, NoiseJob, Stamp } from '../core/texture.ts';
import {
  BEVEL_PROFILES, EDGE_MODES, FLOOD_OUTPUTS, SDF_BOOLEANS, SDF_OPS, SDF_RENDER, SDF_SHAPES, bevelHeight, edgeBand, floodFill, profileFn, propagate,
  sdfBoolean, sdfOp, sdfShape, sdfToMask, shapeReach, signedDistance,
} from '../core/texsdf.ts';
import { texNoise } from '../core/texnoise.ts';
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
/** Physical scale: the metres the image width covers, as in tex_normal_from_height (one texel is size / width metres). */
const sizeParam = (): ParamDef => ({ type: 'float', default: 1, min: 1e-6, desc: 'metres the image width covers on the model (one texel is size / width metres); the distances of this node are in metres', aliases: ['texture_size', 'world_size', 'tile_size'] });
const NORMAL_MAPS = 'normal maps are RGBA images (tex_normal_from_height, bake_normal, image_file of a normal map)';
/** A normal-map source: RGBA, or an error that says how to make one. */
function normalSource(ctx: CookContext, s: Source, what = 'input 0'): Source {
  if (s.ch !== 4) throw new NodeError(`${ctx.type}: ${what} "${s.img.name}" is a grey image, not a normal map`, `${NORMAL_MAPS}; turn a height into one with tex_normal_from_height`);
  return s;
}
/** Signed distance in metres (negative inside) of a grey source's mask at threshold. */
function maskSDF(s: Source, threshold: number, size: number, wrap: boolean): Float32Array {
  const d = signedDistance(toGrey(s.data, s.ch), s.img.width, s.img.height, threshold, wrap), texel = size / s.img.width;
  for (let k = 0; k < d.length; k++) d[k] *= texel;
  return d;
}
const SDF_INPUT = [{ name: 'sdf', desc: 'geometry holding an SDF image (signed distance in metres: tex_sdf_shape, tex_sdf_from_mask); everything else passes through' }];
const SDF_NOTE = 'An SDF image holds the signed distance in metres in C (negative inside, 0 on the outline), as tex_sdf_shape and tex_sdf_from_mask make it';

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
  description: 'Substance: Cells / Voronoi / Crystal; Houdini COP: Worley Noise. Layer C holds the chosen output and layer "id" a random 0..1 per cell (per-cell colour or height). edges is 0 on the cell borders rising to 1 at edge_width (a fraction of a cell): stones, scales, cracked mud. crackle (F2 - F1) is bright along the borders. crystal gives every cell a flat facet with a random tilt and level (Substance Crystal: shards, faceted stone, a per-facet roughness or normal). Runs in chunks on the worker pool for large images.',
  aliases: ['voronoi_texture', 'cells', 'worley', 'cellular', 'crystals', 'cop_worley'],
  inputs: [],
  params: {
    resolution: resolutionParam(),
    output: { type: 'enum', options: ['distance', 'edges', 'id', 'crackle', 'crystal'], default: 'edges', desc: 'what C holds (crystal = a tilted flat facet per cell)', aliases: ['mode', 'type'] },
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

defineNode({
  type: 'tex_sdf_shape',
  category: 'texture',
  summary: 'SDF shape image: the signed distance in metres to a disc, box, polygon, star, capsule or cross (or a grid of them), for SDF offsets, booleans, bevels and outlines.',
  description:
    'Houdini COP: SDF Shape; Substance: Shape (as a distance field). C holds the signed distance in metres (negative ' +
    'inside, 0 on the outline) on an image whose width covers `size` metres, so every distance node downstream ' +
    '(tex_sdf_op, tex_sdf_boolean, tex_sdf_to_mask) works in metres and gives the same result at any resolution. ' +
    'radius sizes disc, polygon and star; extent sizes box (width, height), capsule (length, thickness) and cross (arm ' +
    'length, thickness); corner rounds box, polygon and cross. tile repeats the shape (center places it in each tile, ' +
    'in the tile\'s uv); with tileable the grid continues past the borders, so the field tiles and shapes cut by a ' +
    'border continue on the other side. Panels, plates, rivets, slots, vents, decals. See it with tex_sdf_to_mask.',
  aliases: ['sdf_shape_texture', 'cop_sdfshape', 'shape_sdf', 'distance_shape'],
  inputs: [],
  params: {
    resolution: resolutionParam(),
    shape: { type: 'enum', options: SDF_SHAPES, default: 'box', desc: 'shape', aliases: ['type'] },
    radius: { type: 'float', default: 0.3, min: 0, desc: 'disc, polygon, star: (outer) radius in metres' },
    extent: { type: 'vec2', default: [0.6, 0.4], min: 0, desc: 'box: width and height; capsule: length and thickness; cross: arm length and thickness (metres)', aliases: ['box_size', 'shape_size'] },
    corner: { type: 'float', default: 0, min: 0, desc: 'corner rounding radius in metres (box, polygon, cross)', aliases: ['corner_radius', 'rounding'] },
    sides: { type: 'int', default: 6, min: 3, max: 64, desc: 'polygon: sides; star: points' },
    inner_radius: { type: 'float', default: 0.5, min: 0.01, max: 1, desc: 'star: inner radius / outer radius', aliases: ['inner'] },
    rotation: { type: 'float', default: 0, desc: 'rotation in degrees (counter-clockwise)', aliases: ['angle', 'rotate'] },
    center: { type: 'vec2', default: [0.5, 0.5], desc: 'centre in each tile\'s uv (0.5, 0.5 = the middle)', aliases: ['position'] },
    tile: { type: 'ivec2', default: [1, 1], min: 1, max: 512, desc: 'repeats along u and v', aliases: ['tiling', 'repeat', 'count'] },
    size: sizeParam(),
    tileable: tileParam('the grid of shapes continues past the borders (the field tiles)'),
    name: nameParam(),
  },
  usesNodeName: NAMED_BY_NODE,
  outputs: 'image <name> (default: the node name): C grey signed distance in metres (negative inside)',
  example: { type: 'tex_sdf_shape', params: { resolution: 256, shape: 'box', extent: [0.4, 0.4], corner: 0.06, tile: [2, 2] } },
  cook: (ctx) => {
    const { p, type } = ctx;
    const [w, h] = size2(p, type);
    const o = {
      shape: p.shape, radius: p.radius, extent: [p.extent[0], p.extent[1]] as [number, number], sides: p.sides, inner: p.inner_radius, corner: p.corner,
      rotation: p.rotation, center: [p.center[0], p.center[1]] as [number, number], tile: [p.tile[0], p.tile[1]] as [number, number], size: p.size, wrap: !!p.tileable,
    };
    const { kx, ky } = shapeReach(o, w, h), per = (2 * kx + 1) * (2 * ky + 1);
    if (per > 289) ctx.warn(`${type}: each shape reaches over ${2 * kx + 1} × ${2 * ky + 1} cells of the tile grid, so every pixel measures ${per} instances (slow at high resolutions): fewer tiles, or a smaller shape`);
    const C = sdfShape(o, w, h);
    return imageGeo(new Image(w, h, outName(ctx)).set(MAIN_LAYER, C));
  },
});

defineNode({
  type: 'tex_grunge',
  category: 'texture',
  summary: 'Grunge mask: dirt patches, vertical leaks or scattered spots, with a set coverage and edge hardness; tileable.',
  description:
    'Substance: Grunge Map / Dirt / Leaks / Rust spots. dirt is blotchy domain-warped noise with speckle; leaks are ' +
    'vertical runs streaking down from random sources (rain marks, rust runs under bolts: mask them with an AO or ' +
    'cavity map); spots are round stains and pits of random size. coverage is the fraction of the image that turns ' +
    'white, measured on the mask\'s own histogram like tex_histogram_scan, so 0.2 is a fifth whatever the style or ' +
    'seed; contrast is the edge hardness (1 = hard); detail mixes in fine breakup. scale = features across the image ' +
    'width. Built from noise over uv, so the same at any resolution.',
  aliases: ['grunge_generator', 'dirt_texture', 'leaks', 'rust_spots', 'grunge_map'],
  inputs: [],
  params: {
    resolution: resolutionParam(),
    style: { type: 'enum', options: GRUNGE_STYLES, default: 'dirt', desc: 'dirt patches, vertical leaks or round spots', aliases: ['type', 'mode'] },
    scale: { type: 'float', default: 4, min: 0.1, max: 256, desc: 'features across the image width', aliases: ['frequency'] },
    coverage: { type: 'float', default: 0.35, min: 0, max: 1, desc: 'fraction of the image that turns white', aliases: ['amount', 'density'] },
    contrast: { type: 'float', default: 0.6, min: 0, max: 1, desc: 'edge hardness (1 = hard)', aliases: ['hardness'] },
    detail: { type: 'float', default: 0.4, min: 0, max: 1, desc: 'fine breakup mixed in (0 = smooth shapes)', aliases: ['breakup'] },
    tileable: { type: 'bool', default: true, desc: 'repeat seamlessly at the image borders', aliases: ['tile', 'tiling', 'seamless'] },
    seed: P.seed(),
    name: nameParam(),
  },
  usesNodeName: NAMED_BY_NODE,
  outputs: 'image <name> (default: the node name): C grey 0..1 (white = grime)',
  example: { type: 'tex_grunge', params: { resolution: 256, style: 'leaks', scale: 6, coverage: 0.3, seed: 2 } },
  cook: (ctx) => {
    const { p, type } = ctx;
    const [w, h] = size2(p, type);
    const C = genGrunge({ style: p.style, scale: p.scale, coverage: p.coverage, contrast: p.contrast, detail: p.detail, seed: p.seed, tileable: !!p.tileable }, w, h);
    return imageGeo(new Image(w, h, outName(ctx)).set(MAIN_LAYER, C));
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
    path: { type: 'path', default: '', desc: 'PNG file (relative to the project folder, e.g. "inputs/brick.png") or URL', aliases: ['file', 'filename'] },
    name: nameParam(),
    layers: { type: 'enum', options: [...PNG_LAYERS], default: 'auto', desc: 'auto = grey for grey PNGs (1–2 channels), RGBA for colour ones; grey = the luminance of a colour file; rgba = always four channels', aliases: ['channels'] },
    srgb: { type: 'bool', default: true, desc: 'the file holds display (sRGB) values: kept as stored, like every colour in the engine (masks and data maps load unchanged too); off = it holds linear-light colour, encoded to display values on load (alpha never)' },
  },
  // relative paths read the scope's folder
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
    if (!String(p.path ?? '').trim()) throw new NodeError(`${type}: path is empty`, 'a PNG relative to the project folder (people drop theirs into inputs/) or a URL');
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
  type: 'tex_directional_blur',
  usesNodeName: NAMED_BY_NODE,
  category: 'texture',
  summary: 'Directional (motion) blur along an angle, length in metres: brushed metal from noise, streaks, rain and speed lines.',
  description:
    'Substance: Directional Blur / Motion Blur; Houdini COP: Blur (directional). Every pixel averages the image along ' +
    'a line `length` metres long at angle (0 = +u, 90 = +v): centred on the pixel when symmetric, else trailing behind ' +
    'it, so bright marks streak along the angle. length is in metres of an image `size` metres wide, so a blur looks ' +
    'the same at any resolution. Brushed metal: tex_noise {scale: 60} → tex_directional_blur {length: 0.2} → ' +
    'tex_levels. Grey or RGBA (alpha blurs too).',
  aliases: ['directional_blur', 'motion_blur', 'blur_directional', 'anisotropic_blur', 'streak_blur'],
  inputs: FILTER_INPUT,
  params: {
    length: { type: 'float', default: 0.05, min: 0, desc: 'blur length in metres', aliases: ['distance', 'intensity'] },
    angle: { type: 'float', default: 0, desc: 'direction in degrees (0 = +u, 90 = +v)', aliases: ['direction', 'rotation'] },
    symmetric: { type: 'bool', default: true, desc: 'blur both ways around each pixel (off = a one-sided trail along angle)', aliases: ['centered'] },
    size: sizeParam(),
    tileable: tileParam(),
    image: imageParam(), layer: layerParam(), name: renameParam(),
  },
  example: {
    nodes: {
      grain: { type: 'tex_noise', params: { resolution: 256, scale: 60, octaves: 3, seed: 4 } },
      brushed: { type: 'tex_directional_blur', in: ['grain'], params: { length: 0.15, angle: 0 } },
    },
    output: 'brushed',
  },
  cook: (ctx) => {
    const { p } = ctx;
    const s = source(ctx, 0, p.image, p.layer);
    const w = s.img.width, h = s.img.height;
    return withLayer(s, directionalBlur(s.data, s.ch, w, h, (p.length / p.size) * w, p.angle, !!p.symmetric, !!p.tileable), outName(ctx));
  },
});

defineNode({
  type: 'tex_slope_blur',
  usesNodeName: NAMED_BY_NODE,
  category: 'texture',
  summary: 'Slope blur: smear an image along the slopes of a second grey image (blur, min or max): flowing edges, melted and eroded looks, organic paint wear.',
  description:
    'Substance: Slope Blur Grayscale / Color. Every pixel walks down (or up) the slope of the grey map on input 1 for ' +
    '`distance` metres in `samples` steps, re-reading the slope at each step, and combines what it meets: blur (the ' +
    'mean: flowing smears), min (eats bright areas along the flow: eroded, chipped edges) or max (grows them). Where ' +
    'the map is flatter than half its average slope the steps shrink in proportion, so flat areas stay put. Distances ' +
    'in metres of an image `size` metres wide, so the same at any resolution. Typical: ' +
    'a histogram_scan wear mask slope-blurred by tex_noise for ragged paint edges. Grey or RGBA (alpha is kept).',
  aliases: ['slope_blur', 'slopeblur', 'slope_blur_grayscale', 'flow_blur'],
  inputs: [
    { name: 'image', desc: 'image to blur (its geometry passes through)' },
    { name: 'slope', desc: 'grey map whose slopes the blur follows (noise, a height)' },
  ],
  params: {
    distance: { type: 'float', default: 0.02, min: 0, desc: 'how far each pixel follows the slope, in metres', aliases: ['intensity', 'length'] },
    samples: { type: 'int', default: 16, min: 1, max: 64, desc: 'steps along the slope (more = smoother)', aliases: ['steps'] },
    mode: { type: 'enum', options: SLOPE_BLUR_MODES, default: 'blur', desc: 'blur = mean, min = erode bright areas, max = grow them', aliases: ['type'] },
    direction: { type: 'enum', options: ['downhill', 'uphill'], default: 'downhill', desc: 'follow the slope down (default) or up' },
    size: sizeParam(),
    tileable: tileParam(),
    image: imageParam(), layer: layerParam(),
    slope_image: imageParam('input 1 (the slope map)', []),
    slope_layer: { type: 'string', default: '', desc: 'layer of the slope map ("" = main)' },
    name: renameParam(),
  },
  example: {
    nodes: {
      mask: { type: 'tex_sdf_shape', params: { resolution: 256, shape: 'disc', radius: 0.3 } },
      fill: { type: 'tex_sdf_to_mask', in: ['mask'] },
      flow: { type: 'tex_noise', params: { resolution: 256, scale: 8, seed: 3 } },
      out: { type: 'tex_slope_blur', in: ['fill', 'flow'], params: { distance: 0.04, mode: 'min' } },
    },
    output: 'out',
  },
  cook: (ctx) => {
    const { p, type } = ctx;
    const s = source(ctx, 0, p.image, p.layer);
    const w = s.img.width, h = s.img.height, wrap = !!p.tileable;
    const S = sourceAt(ctx, 1, w, h, p.slope_image, p.slope_layer, wrap, 'slope_image');
    if (!S) throw new NodeError(`${type}: connect a slope map to input 1`, 'a grey image whose slopes the blur follows: tex_noise, tex_grunge, a height');
    return withLayer(s, slopeBlur(s.data, s.ch, w, h, toGrey(S.data, S.ch), (p.distance / p.size) * w, p.samples, p.mode, p.direction === 'uphill', wrap), outName(ctx));
  },
});

defineNode({
  type: 'tex_warp',
  usesNodeName: NAMED_BY_NODE,
  category: 'texture',
  summary: 'Warp an image by a second image: directional, along its slope, by an RG vector map, with a per-pixel angle map (non-uniform), or in several directions at once.',
  description:
    'Substance: Warp / Directional Warp / Vector Warp / Non-Uniform Directional Warp / Multi-Directional Warp; Houdini ' +
    'COP: Displace. intensity is the largest offset as a fraction of the image width (metres when the image spans one ' +
    'metre), so a warp looks the same at any resolution. directional moves each pixel by intensity × warp value along ' +
    'angle; slope along the warp image\'s gradient (normalised so the steepest slope moves intensity); vector by ' +
    '(R, G) × 2 − 1 of an RGBA warp image; nonuniform like directional, with the angle map on input 2 (grey 0..1 = ' +
    '0..360°) added to angle per pixel (flow along a pattern: wood grain around knots, fibres, brushed swirls); multi ' +
    'averages `directions` directional warps whose angles split the circle evenly from angle (a soft, direction-free ' +
    'smear: melted edges, worn paint borders).',
  aliases: ['warp', 'directional_warp', 'vector_warp', 'cop_displace', 'distort', 'non_uniform_directional_warp', 'multi_directional_warp'],
  inputs: [
    { name: 'image', desc: 'image to warp (its geometry passes through)' },
    { name: 'warp', desc: 'grey (directional, slope, nonuniform, multi) or RGBA (vector) warp image' },
    { name: 'angle', desc: 'nonuniform: grey angle map (0..1 = 0..360°, added to angle)', optional: true },
  ],
  params: {
    mode: { type: 'enum', options: WARP_MODES, default: 'slope', desc: 'how the warp image moves pixels', aliases: ['type'] },
    intensity: { type: 'float', default: 0.02, desc: 'largest offset as a fraction of the image width', aliases: ['amount', 'strength'] },
    angle: { type: 'float', default: 0, desc: 'directional, nonuniform, multi: direction in degrees (0 = +u)' },
    directions: { type: 'int', default: 4, min: 1, max: 32, desc: 'multi: number of directions averaged' },
    tileable: tileParam(),
    image: imageParam(), layer: layerParam(),
    warp_image: imageParam('input 1 (the warp image)', []),
    warp_layer: { type: 'string', default: '', desc: 'layer of the warp image ("" = main)' },
    angle_image: imageParam('input 2 (the angle map)', []),
    angle_layer: { type: 'string', default: '', desc: 'layer of the angle map ("" = main)' },
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
    if (!W) throw new NodeError(`${ctx.type}: connect a warp image to input 1`, 'a grey image whose values set how far each pixel moves (tex_noise, tex_cells …)');
    const A = p.mode === 'nonuniform' ? sourceAt(ctx, 2, w, h, p.angle_image, p.angle_layer, !!p.tileable, 'angle_image') : null;
    if (p.mode === 'nonuniform' && !A) throw new NodeError(`${ctx.type}: mode nonuniform needs an angle map on input 2`, 'a grey image: 0..1 turns the direction by 0..360° (tex_noise for swirls, tex_gradient angular for a vortex); for one direction use mode directional');
    return withLayer(s, warpLayer(s.data, s.ch, w, h, W.data, W.ch, p.mode, p.intensity, p.angle, !!p.tileable, A ? toGrey(A.data, A.ch) : null, p.directions), outName(ctx));
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
  summary: 'Edge detection: Sobel gradient magnitude, or lines of a set width in metres along a mask\'s outline (centred, inside or outside), flat or rounded.',
  description:
    'Substance: Edge Detect; Houdini COP: Edge Detect. sobel: the gradient magnitude of the (grey) image; a 0 → 1 step ' +
    'gives about 1 at strength 1, and width grows the lines by that many pixels (max filter). outline, inner and outer ' +
    'draw a line line_width metres wide along where the image crosses threshold (centred on it, just inside, just ' +
    'outside), from its signed distance to a tenth of a pixel, so the line is the same width in metres at any ' +
    'resolution: panel seams, grout lines, the rim of a decal, edge wear bands. roundness 0 gives a flat antialiased ' +
    'line, 1 a rounded ridge (a height: feed tex_normal_from_height).',
  aliases: ['edge_detect', 'edges_texture', 'sobel', 'cop_edge'],
  inputs: FILTER_INPUT,
  params: {
    mode: { type: 'enum', options: EDGE_MODES, default: 'sobel', desc: 'sobel = gradient magnitude; outline / inner / outer = a line of line_width metres along the mask\'s outline', aliases: ['type', 'method'] },
    strength: { type: 'float', default: 1, min: 0, desc: 'sobel: multiplier of the gradient magnitude', aliases: ['intensity', 'contrast'] },
    width: { type: 'float', default: 0, min: 0, max: 64, desc: 'sobel: thicken the edges by this many pixels' },
    line_width: { type: 'float', default: 0.01, min: 0, desc: 'outline / inner / outer: line width in metres', aliases: ['edge_width', 'thickness'] },
    roundness: { type: 'float', default: 0, min: 0, max: 1, desc: 'outline / inner / outer: 0 = flat line, 1 = rounded ridge', aliases: ['edge_roundness'] },
    threshold: { type: 'float', default: 0.5, desc: 'outline / inner / outer: the value where the outline runs', aliases: ['tolerance'] },
    size: sizeParam(),
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
    if (p.mode !== 'sobel') return withLayer(s, edgeBand(maskSDF(s, p.threshold, p.size, !!p.tileable), p.mode, p.line_width, p.roundness, p.size / s.img.width), outName(ctx));
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
  type: 'tex_histogram_range',
  usesNodeName: NAMED_BY_NODE,
  category: 'texture',
  summary: 'Histogram range: squeeze the values toward a position (range 1 = unchanged, 0 = flat at position); a contrast and level control in one.',
  description: 'Substance: Histogram Range. value = position + (value - 0.5) × range, clamped to 0..1: range scales the contrast around the middle grey, position moves the result\'s centre (0.5 keeps it). Narrow a mask to a subtle variation (range 0.2, position 0.6: a roughness that varies between 0.5 and 0.7). Grey or RGB (alpha untouched).',
  aliases: ['histogram_range', 'histogramrange', 'range_texture'],
  inputs: FILTER_INPUT,
  params: {
    range: { type: 'float', default: 0.5, min: 0, max: 1, desc: 'contrast kept (1 = unchanged, 0 = flat)', aliases: ['contrast', 'amount'] },
    position: { type: 'float', default: 0.5, min: 0, max: 1, desc: 'where the middle grey lands', aliases: ['center', 'level'] },
    image: imageParam(), layer: layerParam(), name: renameParam(),
  },
  example: {
    nodes: {
      n: { type: 'tex_noise', params: { resolution: 256 } },
      out: { type: 'tex_histogram_range', in: ['n'], params: { range: 0.3, position: 0.65 } },
    },
    output: 'out',
  },
  cook: (ctx) => {
    const { p } = ctx;
    const s = source(ctx, 0, p.image, p.layer);
    return withLayer(s, mapValues(s.data, s.ch, histogramRangeFn(p.range, p.position)), outName(ctx));
  },
});

defineNode({
  type: 'tex_histogram_select',
  usesNodeName: NAMED_BY_NODE,
  category: 'texture',
  summary: 'Histogram select: a mask of the values within a band (position ± range / 2), with soft or hard edges.',
  description: 'Substance: Histogram Select. White where the (grey, or luminance) value lies within range / 2 of position, black beyond; contrast 1 is a hard band, lower values soften both edges around the same half-way points (0 = a tent that peaks at position). Pick one height band of a terrain or heightmap, one id range of tex_flood_fill, the mid-tones of a noise.',
  aliases: ['histogram_select', 'histogramselect', 'value_band', 'band_select'],
  inputs: FILTER_INPUT,
  params: {
    position: { type: 'float', default: 0.5, desc: 'centre of the selected band', aliases: ['center', 'value'] },
    range: { type: 'float', default: 0.25, min: 0, desc: 'width of the band', aliases: ['width'] },
    contrast: { type: 'float', default: 0.5, min: 0, max: 1, desc: 'edge hardness (1 = hard)', aliases: ['hardness'] },
    image: imageParam(), layer: layerParam(), name: renameParam(),
  },
  outputs: 'the mask (grey) named <name> (default: the node name)',
  example: {
    nodes: {
      g: { type: 'tex_gradient', params: { resolution: 256 } },
      out: { type: 'tex_histogram_select', in: ['g'], params: { position: 0.5, range: 0.2, contrast: 0.8 } },
    },
    output: 'out',
  },
  cook: (ctx) => {
    const { p } = ctx;
    const s = source(ctx, 0, p.image, p.layer);
    const f = histogramSelectFn(p.position, p.range, p.contrast), g = toGrey(s.data, s.ch), out = new Float32Array(g.length);
    for (let i = 0; i < g.length; i++) out[i] = f(g[i]);
    return withLayer(s, out, outName(ctx));
  },
});

defineNode({
  type: 'tex_auto_levels',
  usesNodeName: NAMED_BY_NODE,
  category: 'texture',
  summary: 'Auto levels: stretch the image\'s own value range to 0..1, optionally ignoring a fraction of outliers at each end.',
  description: 'Substance: Auto Levels; Houdini COP: Normalize. The darkest value becomes 0 and the brightest 1 (RGB together, so colours keep their hue, or each channel by itself with per_channel). clip ignores that fraction of the values at each end (0.01 = the darkest and brightest 1 %), so a few outliers do not keep the rest grey. The stats range_min and range_max report the range used. Good after blends, AO and curvature that land in a narrow band. Alpha untouched.',
  aliases: ['auto_levels', 'autolevels', 'normalize_range', 'cop_normalize', 'stretch_levels'],
  inputs: FILTER_INPUT,
  params: {
    clip: { type: 'float', default: 0, min: 0, max: 0.49, desc: 'fraction of the values ignored at each end (outliers)', aliases: ['percentile', 'cutoff'] },
    per_channel: { type: 'bool', default: false, desc: 'stretch R, G and B each by its own range (shifts hues)' },
    image: imageParam(), layer: layerParam(), name: renameParam(),
  },
  outputs: 'the image stretched to 0..1, named <name> (default: the node name); stats range_min, range_max',
  example: {
    nodes: {
      n: { type: 'tex_noise', params: { resolution: 256 } },
      dim: { type: 'tex_levels', in: ['n'], params: { out_low: 0.3, out_high: 0.5 } },
      out: { type: 'tex_auto_levels', in: ['dim'] },
    },
    output: 'out',
  },
  cook: (ctx) => {
    const { p, type } = ctx;
    const s = source(ctx, 0, p.image, p.layer);
    const stretch = (lo: number, hi: number) => (hi > lo ? (x: number) => (x - lo) / (hi - lo) : (x: number) => x - lo + 0.5);
    let out: Float32Array;
    if (p.per_channel && s.ch === 4) {
      out = s.data.slice();
      let low = Infinity, high = -Infinity, flat = 0;
      for (let c = 0; c < 3; c++) {
        const [lo, hi] = valueRange(s.data, 4, p.clip, c), f = stretch(lo, hi);
        if (!(hi > lo)) flat++;
        low = Math.min(low, lo); high = Math.max(high, hi);
        for (let i = c; i < out.length; i += 4) out[i] = f(s.data[i]);
      }
      if (flat) ctx.warn(`${type}: ${flat === 3 ? 'every channel' : `${flat} channel${flat > 1 ? 's' : ''}`} of the image ${flat > 1 ? 'are' : 'is'} flat; ${flat > 1 ? 'they are' : 'it is'} set to 0.5`);
      ctx.stat('range_min', low); ctx.stat('range_max', high);
    } else {
      const [lo, hi] = valueRange(s.data, s.ch, p.clip);
      if (!(hi > lo)) ctx.warn(`${type}: the image is flat (every value ${lo.toFixed(4)}); it is set to 0.5`);
      ctx.stat('range_min', lo); ctx.stat('range_max', hi);
      out = mapValues(s.data, s.ch, stretch(lo, hi));
    }
    if (p.clip > 0) out = mapValues(out, s.ch, (x) => (x < 0 ? 0 : x > 1 ? 1 : x));
    return withLayer(s, out, outName(ctx));
  },
});

defineNode({
  type: 'tex_clamp',
  usesNodeName: NAMED_BY_NODE,
  category: 'texture',
  summary: 'Clamp values to a range (default 0..1): cut overshoots after add, subtract or levels without clamping.',
  description: 'Substance: Clamp; Houdini COP: Clamp. Every value below min becomes min and above max becomes max (grey or RGB; alpha untouched). Unclamped blends and levels, SDF images and heights can run outside 0..1; PNGs clamp anyway, a material input may not.',
  aliases: ['clamp_texture', 'cop_clamp', 'clamp_values'],
  inputs: FILTER_INPUT,
  params: {
    min: { type: 'float', default: 0, desc: 'lowest value kept', aliases: ['low', 'minimum'] },
    max: { type: 'float', default: 1, desc: 'highest value kept', aliases: ['high', 'maximum'] },
    image: imageParam(), layer: layerParam(), name: renameParam(),
  },
  example: {
    nodes: {
      n: { type: 'tex_noise', params: { resolution: 256 } },
      out: { type: 'tex_clamp', in: ['n'], params: { min: 0.3, max: 0.7 } },
    },
    output: 'out',
  },
  cook: (ctx) => {
    const { p, type } = ctx;
    if (p.min > p.max) throw new NodeError(`${type}: min (${p.min}) is above max (${p.max})`, 'swap them; to invert an image use tex_invert');
    const s = source(ctx, 0, p.image, p.layer);
    return withLayer(s, mapValues(s.data, s.ch, (x) => (x < p.min ? p.min : x > p.max ? p.max : x)), outName(ctx));
  },
});

defineNode({
  type: 'tex_quantize',
  usesNodeName: NAMED_BY_NODE,
  category: 'texture',
  summary: 'Quantize (posterize): reduce the values to a few even levels: terraces, stepped masks, toon bands, palette ids.',
  description: 'Substance: Quantize / Posterize; Houdini COP: Quantize. levels evenly spaced values 0 … 1 (2 = black and white). round snaps every value to the nearest level; floor cuts 0..1 into `levels` equal bands (posterize: as many pixels per band as the input has in that range). Grey or RGB per channel (alpha untouched).',
  aliases: ['quantize', 'posterize', 'cop_quantize', 'quantize_grayscale', 'posterize_texture', 'steps_texture'],
  inputs: FILTER_INPUT,
  params: {
    levels: { type: 'int', default: 4, min: 2, max: 256, desc: 'number of output values', aliases: ['steps', 'count'] },
    mode: { type: 'enum', options: QUANTIZE_MODES, default: 'round', desc: 'round = nearest level, floor = equal bands (posterize)', aliases: ['method', 'type'] },
    image: imageParam(), layer: layerParam(), name: renameParam(),
  },
  example: {
    nodes: {
      n: { type: 'tex_noise', params: { resolution: 256 } },
      out: { type: 'tex_quantize', in: ['n'], params: { levels: 5 } },
    },
    output: 'out',
  },
  cook: (ctx) => {
    const { p } = ctx;
    const s = source(ctx, 0, p.image, p.layer);
    return withLayer(s, mapValues(s.data, s.ch, quantizeFn(p.levels, p.mode)), outName(ctx));
  },
});

defineNode({
  type: 'tex_normal_from_height',
  usesNodeName: NAMED_BY_NODE,
  category: 'texture',
  renamed: { strength: 'it is now depth, the relief in metres for a height of 1, with size, the texture\'s width in metres (strength k matches depth k/64 with size 1)' },
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
  type: 'tex_normal_normalize',
  usesNodeName: NAMED_BY_NODE,
  category: 'texture',
  summary: 'Normalize a normal map: scale every vector back to unit length after blurs, resizes, blends or hand edits.',
  description: 'Substance: Normal Normalize. Blurring, resizing, tex_blend or levels on a normal map leave vectors shorter than 1 (flatter shading, wrong reflections); this rescales each to length 1 and lifts any below the surface (z < 0) to it. Alpha is kept. A grey input is an error: it is not a normal map.',
  aliases: ['normal_normalize', 'normalize_normal', 'renormalize_normals'],
  inputs: FILTER_INPUT,
  params: { image: imageParam(), layer: layerParam(), name: renameParam() },
  example: {
    nodes: {
      bricks: { type: 'tex_pattern', params: { resolution: 256 } },
      n: { type: 'tex_normal_from_height', in: ['bricks'], params: { depth: 0.015 } },
      soft: { type: 'tex_blur', in: ['n'], params: { radius: 3 } },
      out: { type: 'tex_normal_normalize', in: ['soft'] },
    },
    output: 'out',
  },
  cook: (ctx) => {
    const { p } = ctx;
    const s = normalSource(ctx, source(ctx, 0, p.image, p.layer));
    return withLayer(s, normalizeNormals(s.data), outName(ctx));
  },
});

defineNode({
  type: 'tex_normal_invert',
  usesNodeName: NAMED_BY_NODE,
  category: 'texture',
  summary: 'Invert a normal map\'s green (OpenGL ↔ DirectX) or red channel, or both (turn the relief inside out).',
  description: 'Substance: Normal Invert. green flips the Y convention: OpenGL (glTF, Blender, TopoTopo) ↔ DirectX (Unreal), the usual fix for normal maps lit from below. red flips X; both inverts the relief (bumps become dents). Alpha is kept.',
  aliases: ['normal_invert', 'invert_normal', 'flip_green', 'normal_flip', 'directx_to_opengl'],
  inputs: FILTER_INPUT,
  params: {
    channel: { type: 'enum', options: ['green', 'red', 'both'], default: 'green', desc: 'channel(s) to flip (green = OpenGL ↔ DirectX)', aliases: ['flip', 'axis'] },
    image: imageParam(), layer: layerParam(), name: renameParam(),
  },
  example: {
    nodes: {
      bricks: { type: 'tex_pattern', params: { resolution: 256 } },
      gl: { type: 'tex_normal_from_height', in: ['bricks'], params: { depth: 0.015 } },
      dx: { type: 'tex_normal_invert', in: ['gl'], params: { channel: 'green' } },
    },
    output: 'dx',
  },
  cook: (ctx) => {
    const { p } = ctx;
    const s = normalSource(ctx, source(ctx, 0, p.image, p.layer));
    return withLayer(s, flipNormals(s.data, p.channel !== 'green', p.channel !== 'red'), outName(ctx));
  },
});

defineNode({
  type: 'tex_height_from_normal',
  usesNodeName: NAMED_BY_NODE,
  category: 'texture',
  summary: 'Height from a normal map: integrate its slopes back into a height in physical units (the inverse of tex_normal_from_height).',
  description:
    'Substance: Normal to Height; Houdini COP: Normal to Height. The slopes of the normals are integrated by solving a ' +
    'Poisson equation over the whole image (FFT when tileable, else with mirrored borders), so the height is the one ' +
    'whose normal map best matches, in metres of an image `size` metres wide: tex_normal_from_height {depth, size} ' +
    'then this node with the same depth and size gives the height back (up to an offset). range depth writes (height − ' +
    'lowest) / depth (0 at the lowest point; a relief deeper than depth runs past 1); normalize fits lowest..highest to ' +
    '0..1. The stat relief is the height range in metres. Use it for AO and curvature from a baked or downloaded normal ' +
    'map, or to blend normals as heights.',
  aliases: ['height_from_normal', 'normal_to_height', 'normal_integrate', 'cop_normaltoheight'],
  inputs: FILTER_INPUT,
  params: {
    depth: { type: 'float', default: 0.01, min: 1e-9, desc: 'metres a height value of 1 stands for', aliases: ['height', 'height_scale', 'relief'] },
    size: { type: 'float', default: 1, min: 1e-6, desc: 'metres the image width covers on the model (the texel size is size / width)', aliases: ['texture_size', 'world_size', 'tile_size'] },
    format: { type: 'enum', options: ['opengl', 'directx'], default: 'opengl', desc: 'green channel convention of the input', aliases: ['convention'] },
    range: { type: 'enum', options: ['depth', 'normalize'], default: 'depth', desc: 'depth = (height − lowest) / depth; normalize = lowest..highest to 0..1', aliases: ['fit'] },
    tileable: tileParam('the normal map tiles (integrated as periodic)'),
    image: imageParam(), layer: layerParam(), name: renameParam(),
  },
  outputs: 'the height (grey) named <name> (default: the node name); stat relief (metres)',
  example: {
    nodes: {
      bumps: { type: 'tex_noise', params: { resolution: 256, scale: 6, octaves: 3 } },
      n: { type: 'tex_normal_from_height', in: ['bumps'], params: { depth: 0.02 } },
      back: { type: 'tex_height_from_normal', in: ['n'], params: { depth: 0.02 } },
    },
    output: 'back',
  },
  cook: (ctx) => {
    const { p } = ctx;
    const s = normalSource(ctx, source(ctx, 0, p.image, p.layer));
    const w = s.img.width, h = s.img.height;
    const hm = heightFromNormal(s.data, w, h, p.size / w, p.format === 'directx', !!p.tileable);
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < hm.length; k++) { if (hm[k] < lo) lo = hm[k]; if (hm[k] > hi) hi = hm[k]; }
    ctx.stat('relief', hi - lo);
    const span = p.range === 'normalize' ? hi - lo : p.depth, out = new Float32Array(hm.length);
    for (let k = 0; k < hm.length; k++) out[k] = span > 0 ? (hm[k] - lo) / span : 0;
    return withLayer(s, out, outName(ctx));
  },
});

defineNode({
  type: 'tex_curvature',
  usesNodeName: NAMED_BY_NODE,
  category: 'texture',
  summary: 'Curvature from a normal map in physical units: 0.5 flat, bright on convex edges and bumps, dark in creases; layers convex and concave.',
  description:
    'Substance: Curvature / Curvature Smooth; Houdini COP: Curvature. The mean curvature (the divergence of the ' +
    'normals, in 1/metres of an image `size` metres wide): C = 0.5 + 0.5 × curvature × radius, so bends of radius ' +
    '`radius` metres or tighter read full white (convex) or black (concave), the same at any resolution. blur (metres) ' +
    'smooths the normals first to measure broader curvature (Curvature Smooth). Layers convex and concave hold the two ' +
    'sides 0..1, like bake_curvature: tex_output {layer: "convex"} → tex_histogram_scan gives edge wear, concave gives ' +
    'dirt. Needs a normal map (tex_normal_from_height of a height, bake_normal).',
  aliases: ['curvature_texture', 'curvature_from_normal', 'normal_to_curvature', 'curvature_smooth', 'cop_curvature'],
  inputs: [{ name: 'normal', desc: 'geometry holding a tangent-space normal map (RGBA); everything else passes through' }],
  params: {
    radius: { type: 'float', default: 0.02, min: 1e-6, desc: 'bend radius in metres that reads full white / black (larger = more contrast)', aliases: ['range', 'intensity'] },
    blur: { type: 'float', default: 0, min: 0, desc: 'smooth the normals over this many metres first (broader curvature)', aliases: ['smooth', 'smoothing'] },
    format: { type: 'enum', options: ['opengl', 'directx'], default: 'opengl', desc: 'green channel convention of the normal map', aliases: ['convention'] },
    size: sizeParam(),
    tileable: tileParam(),
    image: imageParam(), layer: layerParam(), name: renameParam(),
  },
  outputs: 'the curvature (grey, 0.5 = flat) named <name> (default: the node name); layers convex and concave (0..1)',
  example: {
    nodes: {
      plates: { type: 'tex_pattern', params: { resolution: 256, pattern: 'tiles', count: [4, 4], bevel: 0.1 } },
      n: { type: 'tex_normal_from_height', in: ['plates'], params: { depth: 0.01 } },
      out: { type: 'tex_curvature', in: ['n'], params: { radius: 0.02 } },
    },
    output: 'out',
  },
  cook: (ctx) => {
    const { p } = ctx;
    const s = normalSource(ctx, source(ctx, 0, p.image, p.layer));
    const w = s.img.width, h = s.img.height, texel = p.size / w;
    // a blur wider than the image changes nothing more (and the box passes' tables grow with the radius)
    const N = p.blur > 0 ? blurLayer(s.data, 4, w, h, Math.min(p.blur / texel, 2 * Math.max(w, h)), 'gaussian', !!p.tileable) : s.data;
    const r = curvatureFromNormal(N, w, h, texel, p.radius, p.format === 'directx', !!p.tileable);
    return withLayer(s, r.C, outName(ctx), { convex: r.convex, concave: r.concave });
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
  type: 'tex_ao',
  usesNodeName: NAMED_BY_NODE,
  category: 'texture',
  summary: 'Ambient occlusion of a height image in physical units (ground-truth style, cosine-weighted): 1 on any plane, dark in pits, gaps and at the foot of walls; the same at any resolution.',
  description:
    'Substance: Ambient Occlusion (RTAO / HBAO); Houdini COP: Ambient Occlusion. A value of 1 stands `depth` metres ' +
    'high on an image `size` metres wide (as in tex_normal_from_height), and the search reaches `radius` metres: ' +
    'for each of `directions` slices through a pixel the highest horizon on both sides is found from bilinear samples ' +
    '(closer together near the pixel, fading out over the last 40 % of the radius) and the cosine-weighted sky between ' +
    'them is integrated exactly. Unlike tex_height_to_ao (image-width units, nearest samples, any slope reads as ' +
    'shadow) a tilted plane stays white and the result does not change with the resolution. strength scales the ' +
    'darkening (1 = as measured). More directions and steps = smoother, slower.',
  aliases: ['ao_texture', 'gtao', 'height_ao', 'ambient_occlusion_texture', 'cop_ambientocclusion'],
  inputs: FILTER_INPUT,
  params: {
    radius: { type: 'float', default: 0.05, min: 1e-6, desc: 'how far occluders count, in metres', aliases: ['distance', 'search_radius'] },
    depth: { type: 'float', default: 0.01, min: 0, desc: 'metres a height value of 1 stands', aliases: ['height', 'height_scale', 'relief'] },
    directions: { type: 'int', default: 8, min: 1, max: 32, desc: 'slices per pixel (each looks both ways)', aliases: ['dirs', 'slices'] },
    steps: { type: 'int', default: 8, min: 1, max: 32, desc: 'samples along each way' },
    strength: { type: 'float', default: 1, min: 0, max: 4, desc: 'darkening multiplier (0 = none, 1 = as measured)', aliases: ['intensity', 'amount'] },
    size: sizeParam(),
    tileable: tileParam(),
    image: imageParam(), layer: layerParam(), name: renameParam(),
  },
  example: {
    nodes: {
      bricks: { type: 'tex_pattern', params: { resolution: 256, bevel: 0.1 } },
      out: { type: 'tex_ao', in: ['bricks'], params: { radius: 0.04, depth: 0.015, name: 'brick_ao' } },
    },
    output: 'out',
  },
  cook: (ctx) => {
    const { p } = ctx;
    const s = source(ctx, 0, p.image, p.layer);
    const w = s.img.width, h = s.img.height;
    const ao = heightAO(toGrey(s.data, s.ch), w, h, { texel: p.size / w, depth: p.depth, radius: p.radius, directions: p.directions, steps: p.steps, strength: p.strength, wrap: !!p.tileable });
    return withLayer(s, ao, outName(ctx));
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
  summary: 'Tile sampler: scatter an image (a shape, a brick, a pebble; or several, picked at random) N × M times with random offset, rotation, scale and intensity; masks and per-instance maps; grey, id or colour output.',
  description:
    'Substance: Tile Sampler / Splatter Circular. One instance per grid cell: position jitter (fraction of a cell), ' +
    'rotation ± degrees, scale range relative to a cell, intensity range. With a mask (input 1) a cell keeps its ' +
    'instance with probability mask(cell centre). The maps on inputs 2–4 are read at each instance\'s centre: scale ' +
    'map × scale, rotation map × 360° added to the rotation, intensity map × intensity (bigger stones where a gradient ' +
    'is bright, scales that follow a flow, studs that fade out). stamps random uses every image in input 0 and picks one ' +
    'per instance (several pebbles, leaves, bolts). Instances wrap at the borders when tileable and combine with max or ' +
    'add. output grey is the stamps\' luminance; id gives each instance a flat random 0..1 and color a random RGB (alpha = ' +
    'the stamps), both taken from the strongest instance at a pixel, with the grey stamps in layer "mask" (tex_colorize ' +
    'an id for a palette, or tex_blend a colour over a base: its alpha masks it).',
  aliases: ['tile_sampler', 'tilesampler', 'scatter_texture', 'stamp_scatter'],
  inputs: [
    { name: 'pattern', desc: 'image to scatter (e.g. tex_shape); with stamps random, every image here' },
    { name: 'mask', desc: 'grey mask: probability of a cell keeping its instance', optional: true },
    { name: 'scale_map', desc: 'grey: multiplies each instance\'s scale (read at its centre)', optional: true },
    { name: 'rotation_map', desc: 'grey: 0..1 adds 0..360° to each instance\'s rotation', optional: true },
    { name: 'intensity_map', desc: 'grey: multiplies each instance\'s intensity', optional: true },
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
    output: { type: 'enum', options: TILE_SAMPLER_OUTPUTS, default: 'grey', desc: 'grey = the stamps; id = a random grey per instance; color = a random colour per instance (alpha = the stamps)', aliases: ['mode', 'output_type'] },
    stamps: { type: 'enum', options: ['one', 'random'], default: 'one', desc: 'one = the image picked by image; random = every image of input 0, one at random per instance', aliases: ['pattern_input', 'pattern_select'] },
    tileable: tileParam('instances wrap at the borders (the result tiles)'),
    seed: P.seed(),
    image: imageParam('input 0 (the pattern)'), layer: layerParam(),
    mask_image: imageParam('input 1 (the mask)', []),
    scale_map_image: imageParam('input 2 (the scale map)', []),
    rotation_map_image: imageParam('input 3 (the rotation map)', []),
    intensity_map_image: imageParam('input 4 (the intensity map)', []),
    name: nameParam(),
  },
  outputs: 'a new image <name> (default: the node name): C grey (or the id grey, or the RGBA colour); mask grey (the stamps; id and color only)',
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
    const wrap = !!p.tileable;
    const stamps: Stamp[] = [];
    if (p.stamps === 'random') {
      const imgs = imagesOf(ctx.input(0));
      if (!imgs.length) throw new NodeError(`${type}: input 0 has no image`, NO_IMAGE);
      for (const im of imgs) {
        const l = p.layer || im.mainLayer, a = im.layer(l);
        if (!a) throw new NodeError(`${type}: image "${im.name}" has no layer "${l}"`, `layers: ${[...im.layers.keys()].join(', ') || 'none'}`);
        stamps.push({ data: toGrey(a, channelsOf(a, im.count) || 1), w: im.width, h: im.height });
      }
    } else {
      const s = source(ctx, 0, p.image, p.layer);
      stamps.push({ data: toGrey(s.data, s.ch), w: s.img.width, h: s.img.height });
    }
    const grey = (i: number, img: string, param: string) => {
      const m = sourceAt(ctx, i, w, h, img, '', wrap, param);
      return m ? toGrey(m.data, m.ch) : null;
    };
    const r = tileSampler(stamps, w, h, {
      count: [p.count[0], p.count[1]], scale: [p.scale[0], p.scale[1]], rotation: p.rotation, jitter: p.jitter, offset: p.offset,
      intensity: [p.intensity[0], p.intensity[1]], seed: p.seed, add: p.combine === 'add', wrap, output: p.output,
      scaleMap: grey(2, p.scale_map_image, 'scale_map_image'), rotationMap: grey(3, p.rotation_map_image, 'rotation_map_image'),
      intensityMap: grey(4, p.intensity_map_image, 'intensity_map_image'),
    }, grey(1, p.mask_image, 'mask_image'));
    const img = new Image(w, h, outName(ctx)).set(MAIN_LAYER, r.C);
    if (p.output !== 'grey') img.set('mask', r.mask);
    return imageGeo(img);
  },
});

// ---------------------------------------------------------------- distance fields, bevels and regions

const thresholdParam = (): ParamDef => ({ type: 'float', default: 0.5, desc: 'the value where the mask\'s outline runs (inside = at or above it)', aliases: ['level', 'cut'] });

defineNode({
  type: 'tex_sdf_from_mask',
  usesNodeName: NAMED_BY_NODE,
  category: 'texture',
  summary: 'SDF from a mask: the signed distance in metres (negative inside) to where a grey image crosses threshold, accurate to about a tenth of a pixel.',
  description:
    'Houdini COP: SDF from Mono; Substance: Distance / SDF. The outline is found between pixels by interpolation, so ' +
    'antialiased masks (tex_pattern, tex_shape, tex_text, a threshold with softness) give smooth distances that are ' +
    'the same in metres at any resolution; an exact distance transform carries them across the image. With tileable ' +
    'distances are measured across the borders. A mask without any outline (all inside or all outside) gives ± the ' +
    'image\'s width + height in texels. Feed tex_sdf_op, tex_sdf_boolean and tex_sdf_to_mask.',
  aliases: ['sdf_from_mask', 'mask_to_sdf', 'sdf_from_mono', 'cop_sdffrommono', 'distance_field'],
  inputs: FILTER_INPUT,
  params: {
    threshold: thresholdParam(),
    size: sizeParam(),
    tileable: tileParam(),
    image: imageParam(), layer: layerParam(), name: renameParam(),
  },
  outputs: 'the SDF (grey, metres, negative inside) named <name> (default: the node name)',
  example: {
    nodes: {
      word: { type: 'tex_text', params: { resolution: [256, 128], text: 'SDF', size: 0.6 } },
      sdf: { type: 'tex_sdf_from_mask', in: ['word'], params: { size: 1, tileable: false } },
    },
    output: 'sdf',
  },
  cook: (ctx) => {
    const { p } = ctx;
    const s = source(ctx, 0, p.image, p.layer);
    return withLayer(s, maskSDF(s, p.threshold, p.size, !!p.tileable), outName(ctx));
  },
});

defineNode({
  type: 'tex_sdf_op',
  usesNodeName: NAMED_BY_NODE,
  category: 'texture',
  summary: 'Operate on an SDF image in metres: offset (grow or shrink), round convex corners, fillet concave ones, stroke (an outline band), invert, redistance.',
  description:
    `Houdini COP: SDF Offset / Round; Substance: SDF operations. ${SDF_NOTE}. offset grows the shape by amount metres ` +
    '(negative shrinks); round rounds its convex corners with radius amount and fillet its concave ones (shrink or ' +
    'grow, measure again, return); stroke turns it into a band amount wide centred on the outline (rings from discs, ' +
    'frames from boxes, then tex_sdf_to_mask); invert swaps inside and outside; redistance measures the distance ' +
    'to the outline again after smooth booleans or a morph. Distances are metres of an image `size` metres wide.',
  aliases: ['sdf_op', 'sdf_operation', 'sdf_texture_offset', 'cop_sdfoffset', 'sdf_round'],
  inputs: SDF_INPUT,
  params: {
    mode: { type: 'enum', options: SDF_OPS, default: 'offset', desc: 'operation', aliases: ['operation', 'type'] },
    amount: { type: 'float', default: 0.01, desc: 'offset distance, corner radius or stroke width in metres', aliases: ['distance', 'radius', 'width'] },
    size: sizeParam(),
    tileable: tileParam(),
    image: imageParam(), layer: layerParam(), name: renameParam(),
  },
  example: {
    nodes: {
      star: { type: 'tex_sdf_shape', params: { resolution: 256, shape: 'star', radius: 0.4, sides: 5 } },
      soft: { type: 'tex_sdf_op', in: ['star'], params: { mode: 'round', amount: 0.04 } },
      ring: { type: 'tex_sdf_op', in: ['soft'], params: { mode: 'stroke', amount: 0.03 } },
      out: { type: 'tex_sdf_to_mask', in: ['ring'] },
    },
    output: 'out',
  },
  cook: (ctx) => {
    const { p } = ctx;
    const s = source(ctx, 0, p.image, p.layer);
    const w = s.img.width, h = s.img.height;
    return withLayer(s, sdfOp(toGrey(s.data, s.ch), w, h, p.mode, p.amount, p.size / w, !!p.tileable), outName(ctx));
  },
});

defineNode({
  type: 'tex_sdf_boolean',
  usesNodeName: NAMED_BY_NODE,
  category: 'texture',
  summary: 'Combine two SDF images: union, subtract, intersect or xor, hard or smooth (blend width in metres), or morph from one to the other.',
  description:
    `Houdini COP: SDF Blend; Substance: SDF Boolean. ${SDF_NOTE}. union = either shape, subtract = input 0 minus input ` +
    '1, intersect = both, xor = one but not both. smoothness blends the seam over that many metres (a fillet where ' +
    'shapes meet: welded plates, melted blobs); 0 is a hard cut. morph mixes the two fields by amount (0 = input 0, ' +
    '1 = input 1). Input 1 is resized to input 0. Smooth results and morphs are not exact distances away from the ' +
    'outline: follow with tex_sdf_op redistance before offsets.',
  aliases: ['sdf_boolean_texture', 'sdf_combine_texture', 'cop_sdfblend', 'sdf_union'],
  inputs: [
    { name: 'a', desc: 'SDF image A (its geometry passes through)' },
    { name: 'b', desc: 'SDF image B' },
  ],
  params: {
    mode: { type: 'enum', options: SDF_BOOLEANS, default: 'union', desc: 'how the shapes combine', aliases: ['operation', 'type'] },
    smoothness: { type: 'float', default: 0, min: 0, desc: 'width of the smooth blend in metres (0 = hard)', aliases: ['smooth', 'blend', 'radius'] },
    amount: { type: 'float', default: 0.5, min: 0, max: 1, desc: 'morph: 0 = A, 1 = B', aliases: ['mix', 't'] },
    tileable: tileParam('resizing B wraps at the borders'),
    image: imageParam('input 0 (A)'), layer: layerParam(),
    b_image: imageParam('input 1 (B)', []),
    b_layer: { type: 'string', default: '', desc: 'layer of B ("" = main)' },
    name: renameParam(),
  },
  example: {
    nodes: {
      plate: { type: 'tex_sdf_shape', params: { resolution: 256, shape: 'box', extent: [0.7, 0.5], corner: 0.05 } },
      hole: { type: 'tex_sdf_shape', params: { resolution: 256, shape: 'disc', radius: 0.12 } },
      cut: { type: 'tex_sdf_boolean', in: ['plate', 'hole'], params: { mode: 'subtract', smoothness: 0.03 } },
      out: { type: 'tex_sdf_to_mask', in: ['cut'], params: { mode: 'bevel', width: 0.04 } },
    },
    output: 'out',
  },
  cook: (ctx) => {
    const { p, type } = ctx;
    const A = source(ctx, 0, p.image, p.layer);
    const w = A.img.width, h = A.img.height;
    const B = sourceAt(ctx, 1, w, h, p.b_image, p.b_layer, !!p.tileable, 'b_image');
    if (!B) throw new NodeError(`${type}: connect a second SDF image to input 1`, 'an SDF image: tex_sdf_shape, or tex_sdf_from_mask of a mask');
    return withLayer(A, sdfBoolean(toGrey(A.data, A.ch), toGrey(B.data, B.ch), p.mode, p.smoothness, p.amount), outName(ctx));
  },
});

defineNode({
  type: 'tex_sdf_to_mask',
  usesNodeName: NAMED_BY_NODE,
  category: 'texture',
  summary: 'Render an SDF image: an antialiased fill, an outline of a set width, a bevel profile (a height), or the field encoded 0..1 for export.',
  description:
    `Houdini COP: SDF to Mono; Substance: SDF to mask. ${SDF_NOTE}. fill: 1 inside, 0 outside, antialiased over one ` +
    'texel or softened over softness metres. outline: a line width metres wide centred on the outline. bevel: 0 on the ' +
    'outline rising through the profile (linear, smooth, round = a quarter circle, ramp = your curve) to 1 at width ' +
    'metres inside: a height for tex_normal_from_height. distance: 0.5 on the outline, 1 at width metres inside, 0 at ' +
    'width outside (the usual encoding of distance-field textures for decals and text in shaders).',
  aliases: ['sdf_to_mask', 'sdf_to_mono', 'sdf_render', 'cop_sdftomono', 'sdf_fill'],
  inputs: SDF_INPUT,
  params: {
    mode: { type: 'enum', options: SDF_RENDER, default: 'fill', desc: 'what to draw', aliases: ['type', 'output'] },
    width: { type: 'float', default: 0.02, min: 0, desc: 'outline width, bevel width or distance range in metres', aliases: ['distance', 'bevel_width'] },
    softness: { type: 'float', default: 0, min: 0, desc: 'fill and outline: edge softness in metres (0 = antialiased over a texel)', aliases: ['falloff', 'blur'] },
    profile: { type: 'enum', options: BEVEL_PROFILES, default: 'smooth', desc: 'bevel: profile from the outline inward', aliases: ['curve_type'] },
    ramp: { type: 'ramp', default: [[0, 0], [1, 1]], desc: 'bevel with profile ramp: height [[t, value], …] from the outline (t 0) to width inside (t 1)', aliases: ['curve'] },
    size: sizeParam(),
    image: imageParam(), layer: layerParam(), name: renameParam(),
  },
  outputs: 'the grey result named <name> (default: the node name)',
  example: {
    nodes: {
      rivets: { type: 'tex_sdf_shape', params: { resolution: 256, shape: 'disc', radius: 0.04, tile: [6, 6] } },
      out: { type: 'tex_sdf_to_mask', in: ['rivets'], params: { mode: 'bevel', width: 0.04, profile: 'round' } },
    },
    output: 'out',
  },
  cook: (ctx) => {
    const { p } = ctx;
    const s = source(ctx, 0, p.image, p.layer);
    const prof = profileFn(p.profile, (t) => Number(evalRamp(p.ramp, t)));
    return withLayer(s, sdfToMask(toGrey(s.data, s.ch), p.mode, p.width, p.softness, p.size / s.img.width, prof), outName(ctx));
  },
});

defineNode({
  type: 'tex_bevel',
  usesNodeName: NAMED_BY_NODE,
  category: 'texture',
  summary: 'Bevel a mask into a height: 0 on the outline rising to 1 at a distance in metres inside (or outward), through a linear, smooth, round or custom profile.',
  description:
    'Substance: Bevel; Houdini COP: Bevel. The mask\'s outline (where it crosses threshold) is measured to a tenth of ' +
    'a pixel, so the bevel is `distance` metres wide at any resolution. A positive distance bevels inward (0 on the ' +
    'outline, 1 on the plateau); a negative one bevels outward (1 inside, falling to 0 at |distance| outside). round ' +
    'is a quarter circle (a rolled edge), smooth an S-curve, linear a chamfer, ramp your curve. Inner corners stay ' +
    'sharp, outer corners of an outward bevel round off. Feed tex_normal_from_height (with the same size) and ' +
    'tex_curvature or tex_ao.',
  aliases: ['bevel_texture', 'texture_bevel', 'cop_bevel', 'mask_bevel', 'chamfer_texture'],
  inputs: FILTER_INPUT,
  params: {
    distance: { type: 'float', default: 0.02, desc: 'bevel width in metres (> 0 inward, < 0 outward)', aliases: ['width', 'bevel_width'] },
    profile: { type: 'enum', options: BEVEL_PROFILES, default: 'smooth', desc: 'profile from the outline to the plateau', aliases: ['curve_type'] },
    ramp: { type: 'ramp', default: [[0, 0], [1, 1]], desc: 'profile ramp: height [[t, value], …] from the outline (t 0) to the full distance (t 1)', aliases: ['curve'] },
    threshold: thresholdParam(),
    size: sizeParam(),
    tileable: tileParam(),
    image: imageParam(), layer: layerParam(), name: renameParam(),
  },
  outputs: 'the bevel height (grey 0..1) named <name> (default: the node name)',
  example: {
    nodes: {
      tiles: { type: 'tex_pattern', params: { resolution: 256, pattern: 'tiles', count: [4, 4], gap: 0.08, bevel: 0 } },
      out: { type: 'tex_bevel', in: ['tiles'], params: { distance: 0.03, profile: 'round' } },
    },
    output: 'out',
  },
  cook: (ctx) => {
    const { p } = ctx;
    const s = source(ctx, 0, p.image, p.layer);
    const prof = profileFn(p.profile, (t) => Number(evalRamp(p.ramp, t)));
    return withLayer(s, bevelHeight(maskSDF(s, p.threshold, p.size, !!p.tileable), p.distance, prof, p.size / s.img.width), outName(ctx));
  },
});

defineNode({
  type: 'tex_distance',
  usesNodeName: NAMED_BY_NODE,
  category: 'texture',
  summary: 'Grow a mask by a distance in metres: a falloff gradient or a hard grown mask; with a source, carry its values (colours, ids) out into the grown area.',
  description:
    'Substance: Distance. gradient: 1 inside the mask (value ≥ threshold) falling linearly to 0 at `distance` metres ' +
    'outside (glows, soft dirt around shapes, fall-off masks). grow: the mask grown by `distance` metres, antialiased. ' +
    'With a source image on input 1, C is instead the source\'s value at the nearest mask pixel, carried out to ' +
    '`distance` (0 beyond, inside the mask the source itself): per-tile colours or ids bled into the gaps, texture ' +
    'padding in metres; layer "mask" holds the gradient or grown mask. Distances in metres of an image `size` metres ' +
    'wide, so the same at any resolution; with tileable they cross the borders.',
  aliases: ['distance_texture', 'grow_mask', 'mask_distance', 'mask_grow', 'expand_mask'],
  inputs: [
    { name: 'mask', desc: 'grey mask to grow (its geometry passes through)' },
    { name: 'source', desc: 'optional: an image whose values are carried out from the mask', optional: true },
  ],
  params: {
    distance: { type: 'float', default: 0.05, min: 0, desc: 'how far the mask grows, in metres', aliases: ['radius', 'grow'] },
    mode: { type: 'enum', options: ['gradient', 'grow'], default: 'gradient', desc: 'gradient = linear falloff to 0 at distance; grow = hard edge at distance', aliases: ['type'] },
    threshold: thresholdParam(),
    size: sizeParam(),
    tileable: tileParam(),
    image: imageParam('input 0 (the mask)', ['input_image']), layer: layerParam(),
    source_image: imageParam('input 1 (the source)', []),
    source_layer: { type: 'string', default: '', desc: 'layer of the source ("" = main)' },
    name: renameParam(),
  },
  outputs: 'the grown mask (grey), or with a source its carried values (grey or RGBA) and layer mask; named <name> (default: the node name)',
  example: {
    nodes: {
      dots: { type: 'tex_sdf_shape', params: { resolution: 256, shape: 'disc', radius: 0.05, tile: [4, 4] } },
      mask: { type: 'tex_sdf_to_mask', in: ['dots'] },
      glow: { type: 'tex_distance', in: ['mask'], params: { distance: 0.06 } },
    },
    output: 'glow',
  },
  cook: (ctx) => {
    const { p } = ctx;
    const s = source(ctx, 0, p.image, p.layer);
    const w = s.img.width, h = s.img.height, texel = p.size / w, wrap = !!p.tileable;
    const d = maskSDF(s, p.threshold, p.size, wrap), D = Math.max(0, p.distance);
    const mask = new Float32Array(w * h);
    for (let k = 0; k < mask.length; k++) {
      const x = d[k];
      mask[k] = p.mode === 'grow' ? Math.max(0, Math.min(1, 0.5 - (x - D) / texel)) : x <= 0 ? 1 : D > 0 ? Math.max(0, 1 - x / D) : 0;
    }
    const src = sourceAt(ctx, 1, w, h, p.source_image, p.source_layer, wrap, 'source_image');
    if (!src) return withLayer(s, mask, outName(ctx));
    const inside = Uint8Array.from(d, (x) => (x <= 0 ? 1 : 0));
    return withLayer(s, propagate(src.data, src.ch, inside, w, h, D / texel, wrap), outName(ctx), { mask });
  },
});

defineNode({
  type: 'tex_flood_fill',
  usesNodeName: NAMED_BY_NODE,
  category: 'texture',
  summary: 'Flood fill: find the separate tiles of a mask (bricks, planks, stones, panels) and give each a random grey or colour, a gradient across it, its size or its position.',
  description:
    'Substance: Flood Fill + Flood Fill to Random Grayscale / Random Color / Gradient / BBox Size / Position. A tile ' +
    'is a connected area at or above threshold (4- or 8-connected); with tileable a tile cut by a border is one tile. ' +
    'random: a random grey per tile; color: a random RGB (alpha 1 on tiles, 0 in the gaps); gradient: 0 → 1 across ' +
    'each tile along angle, turned by up to ± angle_random per tile (directional wear, per-plank shading); bbox_size: ' +
    'the longer side of the tile\'s bounding box in metres (bigger stones darker, small chips brighter); position: ' +
    'the tile\'s centre as (u, v, 0, 1) (feed per-tile offsets). Layer "id" holds the random grey. Random values come ' +
    'from each tile\'s centre (area-weighted with its antialiased edge), so they stay with the tile whatever the ' +
    'resolution or the order tiles are found in. The gaps are 0. Stat tiles = the number of tiles.',
  aliases: ['flood_fill', 'floodfill', 'flood_fill_to_random', 'flood_fill_to_color', 'flood_fill_to_gradient', 'tile_id', 'connected_components'],
  inputs: FILTER_INPUT,
  params: {
    output: { type: 'enum', options: FLOOD_OUTPUTS, default: 'random', desc: 'what each tile gets in C', aliases: ['mode', 'type'] },
    threshold: thresholdParam(),
    connectivity: { type: 'enum', options: [4, 8], default: 4, desc: 'pixels touching at corners join (8) or not (4)', aliases: ['neighbours'] },
    angle: { type: 'float', default: 0, desc: 'gradient: direction in degrees (0 = +u, 90 = +v)', aliases: ['direction'] },
    angle_random: { type: 'float', default: 0, min: 0, max: 180, desc: 'gradient: random turn per tile, ± degrees', aliases: ['angle_variation'] },
    seed: P.seed(),
    size: sizeParam(),
    tileable: tileParam('tiles continue across the borders'),
    image: imageParam(), layer: layerParam(), name: renameParam(),
  },
  outputs: 'the per-tile values (grey, or RGBA for color and position) named <name> (default: the node name); layer id (random grey per tile); stat tiles',
  example: {
    nodes: {
      bricks: { type: 'tex_pattern', params: { resolution: 256, pattern: 'bricks', count: [4, 8], bevel: 0 } },
      out: { type: 'tex_flood_fill', in: ['bricks'], params: { output: 'gradient', angle: 0, angle_random: 20 } },
    },
    output: 'out',
  },
  cook: (ctx) => {
    const { p, type } = ctx;
    const s = source(ctx, 0, p.image, p.layer);
    const w = s.img.width, h = s.img.height;
    const r = floodFill(toGrey(s.data, s.ch), w, h, {
      threshold: p.threshold, connectivity: Number(p.connectivity), output: p.output, angle: p.angle, angleRandom: p.angle_random,
      seed: p.seed, wrap: !!p.tileable, texel: p.size / w,
    });
    ctx.stat('tiles', r.tiles);
    if (!r.tiles) ctx.warn(`${type}: no pixel of "${s.img.name}" reaches threshold ${p.threshold}: no tiles`);
    return withLayer(s, r.C, outName(ctx), { id: r.id });
  },
});

defineNode({
  type: 'tex_make_tile',
  usesNodeName: NAMED_BY_NODE,
  category: 'texture',
  summary: 'Make it tile: blend an image (a photo, a non-tileable noise) with copies shifted by half, so its borders meet seamlessly.',
  description:
    'Substance: Make It Tile Photo / Patch. Along u, then along v, the image is blended with a copy shifted by half ' +
    'the image: near the borders the copy shows (it runs on across them), from `blend` (a fraction of the image) ' +
    'inward the original does (covering the copy\'s seam). noise 0 is a smooth cross-fade over the band; toward 1 the ' +
    'hand-over becomes a narrow edge that wanders with a noise of noise_scale cells (a patch edge hides the blend ' +
    'better on photos and coarse noise). The result always tiles; the middle of the image is untouched.',
  aliases: ['make_tile', 'make_it_tile', 'makeittile', 'make_tileable', 'seamless_texture'],
  inputs: FILTER_INPUT,
  params: {
    blend: { type: 'float', default: 0.25, min: 0.01, max: 0.5, desc: 'width of the blended band at each border (fraction of the image)', aliases: ['band', 'mask_size'] },
    noise: { type: 'float', default: 0.5, min: 0, max: 1, desc: '0 = smooth cross-fade, 1 = a narrow edge wandering with noise', aliases: ['patch', 'warp'] },
    noise_scale: { type: 'float', default: 6, min: 1, max: 64, desc: 'cells of the edge noise across the image', aliases: ['frequency'] },
    seed: P.seed(),
    image: imageParam(), layer: layerParam(), name: renameParam(),
  },
  example: {
    nodes: {
      n: { type: 'tex_noise', params: { resolution: 256, scale: 5.5, tileable: false } },
      out: { type: 'tex_make_tile', in: ['n'], params: { blend: 0.2, noise: 0.6 } },
    },
    output: 'out',
  },
  cook: (ctx) => {
    const { p } = ctx;
    const s = source(ctx, 0, p.image, p.layer);
    const w = s.img.width, h = s.img.height;
    const nz = (k: number) => texNoise({ noise: 'perlin', fractal: 'fbm', scale: p.noise_scale, octaves: 3, roughness: 0.5, lacunarity: 2, seed: p.seed * 3 + k, tileable: true, offset: [0, 0], aspect: h / w });
    return withLayer(s, makeTile(s.data, s.ch, w, h, p.blend, nz(1), nz(2), p.noise), outName(ctx));
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
    '{textures: true} shows base colour maps on the mesh; views "texture" shows the images. With nothing in input 0 the ' +
    'result is the material alone with the maps it uses: a material output (kind material), which other projects ' +
    'assign through input 1 of the material node.',
  aliases: ['texture_material', 'material_textures', 'attach_textures', 'apply_textures'],
  inputs: [
    { name: 'geo', desc: 'mesh to texture (needs uv); none: the material alone, for a material output', optional: true },
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
    const g = ctx.hasInput(0) ? ctx.input(0).clone() : new Geometry();
    // images by name; two different images under one name are ambiguous (reported when a slot names them)
    const pool = new Map<string, Image>(), clash = new Set<string>();
    const add = (im: Image) => {
      const had = pool.get(im.name);
      if (!had) pool.set(im.name, im);
      else if (!sameImage(had, im)) clash.add(im.name);
    };
    if (ctx.hasInput(0)) for (const im of imagesOf(ctx.input(0))) add(im);
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
    if (g.numPrims && (isNew || groupSet)) {
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
