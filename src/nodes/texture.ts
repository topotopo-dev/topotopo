// Texture nodes (category "texture"): a Substance Designer / Houdini COP style image family. Images are volumes of
// kind 'image' carried in the geometry (core/image.ts): generators make a geometry holding one image, filters
// process one layer of one image of their first input and pass everything else through, texture_to_material attaches
// images to a material ("image:<name>" texture slots), and exporters embed them (glTF) or write them next to the file
// (USD, the "textures" format). Bakes from meshes live in nodes/bake.ts.
import { Geometry } from '../core/geometry.ts';
import { Image, MAIN_LAYER, MAX_PIXELS, channelsOf, findImage, imagesOf, isImage, resizeLayer, toGrey } from '../core/image.ts';
import {
  BLEND_MODES, GRADIENTS, PATTERNS, SHAPES, WARP_MODES, blendLayers, blurLayer, colorize, curvesLayer, edgeDetect, genGradient,
  genPattern, genScratches, genShape, genSplatter, heightToAO, histogramScanFn, levelsFn, mapValues, normalFromHeight, rampLUT,
  tileSampler, transformLayer, warpLayer,
} from '../core/texture.ts';
import type { CellsJob, NoiseJob } from '../core/texture.ts';
import { Heightfield, heightfieldsOf } from '../core/heightfield.ts';
import { MATERIAL_ATTRIB, normalizeMaterial, readMaterials, writeMaterials } from '../core/materials.ts';
import { readUV } from '../core/uv.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import type { CookContext, ParamDef } from '../graph/types.ts';
import { evalRamp } from '../graph/params.ts';
import { then } from '../graph/parallel.ts';
import { P, mask } from './util.ts';

// ---------------------------------------------------------------- shared params and helpers

export const NO_IMAGE = 'make one with a generator (tex_noise, tex_pattern, tex_shape, tex_cells …), a bake (bake_ao, bake_curvature …) or heightfield_to_tex';

export const resolutionParam = (def = 512): ParamDef => ({
  type: 'ivec2', default: [def, def], min: 1, max: 8192,
  desc: `image size in pixels [width, height] (one number = square; at most ${MAX_PIXELS.toLocaleString('en-US')} pixels); powers of two suit GPUs`,
  aliases: ['res', 'output_size', 'dimensions', 'image_size'],
});
export const nameParam = (def: string, desc = 'image name (materials reference it as "image:<name>")'): ParamDef => ({ type: 'string', default: def, desc, aliases: ['image_name', 'output_name'] });
const imageParam = (): ParamDef => ({ type: 'string', default: '', desc: 'which image of the input to process ("" = the first)', aliases: ['input_image', 'source_image'] });
const layerParam = (): ParamDef => ({ type: 'string', default: '', desc: 'layer to process ("" = the main layer "C"; others: "id", "mask", …)', aliases: ['plane', 'channel_layer'] });
const renameParam = (): ParamDef => ({ type: 'string', default: '', desc: 'rename the result ("" = keep the input image name)', aliases: ['image_name', 'output_name'] });
const tileParam = (desc = 'the image tiles: filters read across the opposite border (keep a tileable texture tileable)'): ParamDef => ({ type: 'bool', default: true, desc, aliases: ['wrap', 'tiling', 'seamless'] });

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

/** The image (by name, "" = first) and layer ("" = main) a node reads from input i. */
export function source(ctx: CookContext, i: number, imageName = '', layerName = ''): Source {
  const g = ctx.input(i);
  let index = -1;
  for (let k = 0; k < g.volumes.length; k++) {
    const v = g.volumes[k];
    if (isImage(v) && (!imageName || v.name === imageName)) { index = k; break; }
  }
  if (index < 0) {
    const names = imagesOf(g).map((x) => x.name);
    if (imageName && names.length) throw new NodeError(`${ctx.type}: input ${i} has no image "${imageName}"`, `images: ${names.join(', ')}`);
    throw new NodeError(`${ctx.type}: input ${i} has no image`, NO_IMAGE);
  }
  const img = findImage(g, (g.volumes[index] as Image).name)!;
  const layer = layerName || img.mainLayer;
  const data = img.layer(layer);
  if (!data) throw new NodeError(`${ctx.type}: image "${img.name}" has no layer "${layer}"`, `layers: ${[...img.layers.keys()].join(', ') || 'none'}`);
  const ch = channelsOf(data, img.count);
  if (!ch) throw new NodeError(`${ctx.type}: image "${img.name}" layer "${layer}" has ${data.length} values for ${img.width} × ${img.height} pixels`);
  return { g, img, index, layer, data, ch };
}

/** Input i's image layer resized to w × h (or null when the input is not connected). */
function sourceAt(ctx: CookContext, i: number, w: number, h: number, imageName = '', layerName = '', wrap = true): { data: Float32Array; ch: 1 | 4 } | null {
  if (!ctx.hasInput(i)) return null;
  const s = source(ctx, i, imageName, layerName);
  return { data: resizeLayer(s.data, s.ch, s.img.width, s.img.height, w, h, wrap), ch: s.ch };
}

/** The input geometry with the source image's layer replaced (and the image renamed when `rename` is set). */
export function withLayer(s: Source, data: Float32Array, rename = '', extra?: Record<string, Float32Array>): Geometry {
  const g = s.g.clone();
  const img = s.img.clone();
  img.set(s.layer, data);
  if (extra) for (const [k, v] of Object.entries(extra)) img.set(k, v);
  const name = String(rename ?? '').trim();
  if (name) img.name = name;
  g.volumes[s.index] = img;
  return g;
}

export const size2 = (p: any, node: string): [number, number] => {
  const w = Math.round(p.resolution[0]), h = Math.round(p.resolution[1]);
  checkSize(w, h, node);
  return [w, h];
};

export const imgName = (p: any, def: string) => String(p.name ?? '').trim() || def;

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
    name: nameParam('noise'),
  },
  outputs: 'image <name>: C grey 0..1',
  example: { type: 'tex_noise', params: { resolution: 512, scale: 6, fractal: 'ridged', seed: 2 } },
  cook: ({ p, type, parallelMap }) => {
    const [w, h] = size2(p, type);
    const job: NoiseJob = {
      noise: p.noise, fractal: p.fractal, scale: p.scale, octaves: p.octaves, roughness: p.roughness, lacunarity: p.lacunarity,
      seed: p.seed, tileable: !!p.tileable, offset: [p.offset[0], p.offset[1]], aspect: h / w, jitter: p.jitter, width: w, height: h,
    };
    const C = new Float32Array(w * h);
    return then(parallelMap('tex_noise', { count: w * h, args: job, results: { C } }), () => imageGeo(new Image(w, h, imgName(p, 'noise')).set(MAIN_LAYER, C)));
  },
});

defineNode({
  type: 'tex_pattern',
  category: 'texture',
  summary: 'Tiling pattern image: bricks, tiles, checker, stripes, hex, dots or grid lines, with gap (mortar), bevel and per-cell random id.',
  description:
    'Substance: Tile Generator / Bricks / Checker; Houdini COP: Pattern. C is a height-like profile: 1 on the cells, 0 in ' +
    'the gaps, a smooth bevel between (feed tex_normal_from_height for bricks with depth). Layer "id" holds a random 0..1 ' +
    'per cell (tex_colorize it with layer "id" for per-brick colour). count = cells along u (columns) and v (rows); ' +
    'bricks and dots shift every other row by offset (keep the row count even for seamless tiling); hex uses offset for ' +
    'its staggered rows. gap and bevel are fractions of the smaller cell side; variation darkens cells randomly.',
  aliases: ['tile_generator', 'bricks', 'brick', 'checker', 'tiles_pattern', 'cop_pattern'],
  inputs: [],
  params: {
    resolution: resolutionParam(),
    pattern: { type: 'enum', options: PATTERNS, default: 'bricks', desc: 'pattern', aliases: ['type', 'mode'] },
    count: { type: 'ivec2', default: [4, 8], min: 1, max: 4096, desc: 'cells along u (columns) and v (rows)', aliases: ['tiles', 'repeat', 'cells'] },
    offset: { type: 'float', default: 0.5, min: 0, max: 1, desc: 'bricks / hex / dots: shift of every other row (fraction of a cell)', aliases: ['row_offset', 'stagger'] },
    gap: { type: 'float', default: 0.06, min: 0, max: 1, desc: 'mortar / gap width as a fraction of the smaller cell side (dots: 1 - diameter)', aliases: ['mortar', 'spacing'] },
    bevel: { type: 'float', default: 0.08, min: 0, max: 1, desc: 'bevel width as a fraction of the smaller cell side (0 = hard antialiased edge)', aliases: ['smooth', 'roundness'] },
    variation: { type: 'float', default: 0, min: 0, max: 1, desc: 'random darkening per cell (0 = all cells 1)', aliases: ['height_variation', 'luminance_random'] },
    seed: P.seed(),
    name: nameParam('pattern'),
  },
  outputs: 'image <name>: C grey profile, id grey random per cell',
  example: { type: 'tex_pattern', params: { pattern: 'bricks', count: [4, 8], gap: 0.05, bevel: 0.1 } },
  cook: ({ p, type }) => {
    const [w, h] = size2(p, type);
    const r = genPattern({ pattern: p.pattern, count: [p.count[0], p.count[1]], offset: p.offset, gap: p.gap, bevel: p.bevel, variation: p.variation, seed: p.seed }, w, h);
    return imageGeo(new Image(w, h, imgName(p, 'pattern')).set(MAIN_LAYER, r.C).set('id', r.id));
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
    name: nameParam('gradient'),
  },
  outputs: 'image <name>: C grey 0..1',
  cook: ({ p, type }) => {
    const [w, h] = size2(p, type);
    return imageGeo(new Image(w, h, imgName(p, 'gradient')).set(MAIN_LAYER, genGradient(p.mode, p.angle, [p.center[0], p.center[1]], p.radius, w, h)));
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
    name: nameParam('shape'),
  },
  outputs: 'image <name>: C grey 0..1',
  example: { type: 'tex_shape', params: { shape: 'star', sides: 5, falloff: 0.3, tile: [4, 4] } },
  cook: ({ p, type }) => {
    const [w, h] = size2(p, type);
    const C = genShape({ shape: p.shape, size: p.size, sides: p.sides, inner: p.inner_radius, rotation: p.rotation, falloff: p.falloff, tile: [p.tile[0], p.tile[1]] }, w, h);
    return imageGeo(new Image(w, h, imgName(p, 'shape')).set(MAIN_LAYER, C));
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
    name: nameParam('cells'),
  },
  outputs: 'image <name>: C grey (the chosen output), id grey random per cell',
  example: { type: 'tex_cells', params: { output: 'edges', scale: 10, edge_width: 0.08 } },
  cook: ({ p, type, parallelMap }) => {
    const [w, h] = size2(p, type);
    const job: CellsJob = {
      width: w, height: h, scale: p.scale, jitter: p.jitter, seed: p.seed, tileable: !!p.tileable, output: p.output, edgeWidth: p.edge_width,
      metric: ['euclidean', 'manhattan', 'chebyshev'].indexOf(p.metric),
    };
    const C = new Float32Array(w * h), id = new Float32Array(w * h);
    return then(parallelMap('tex_cells', { count: w * h, args: job, results: { C, id } }), () => imageGeo(new Image(w, h, imgName(p, 'cells')).set(MAIN_LAYER, C).set('id', id)));
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
    name: nameParam('scratches'),
  },
  outputs: 'image <name>: C grey 0..1',
  cook: ({ p, type }) => {
    const [w, h] = size2(p, type);
    const C = genScratches({ count: p.count, length: [p.length[0], p.length[1]], width: p.width, angle: p.angle, spread: p.spread, curvature: p.curvature, intensity: [p.intensity[0], p.intensity[1]], seed: p.seed, wrap: !!p.tileable }, w, h);
    return imageGeo(new Image(w, h, imgName(p, 'scratches')).set(MAIN_LAYER, C));
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
    name: nameParam('splatter'),
  },
  outputs: 'image <name>: C grey 0..1',
  cook: ({ p, type }) => {
    const [w, h] = size2(p, type);
    const C = genSplatter({ count: p.count, size: [p.size[0], p.size[1]], irregularity: p.irregularity, softness: p.softness, intensity: [p.intensity[0], p.intensity[1]], seed: p.seed, wrap: !!p.tileable, add: p.combine === 'add' }, w, h);
    return imageGeo(new Image(w, h, imgName(p, 'splatter')).set(MAIN_LAYER, C));
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
    text: { type: 'string', default: 'POLYFORGE', desc: 'text (use \\n for new lines)' },
    font: { type: 'string', default: '', desc: 'font file or family ("" = the bundled DejaVu Sans)' },
    size: { type: 'float', default: 0.2, min: 0.001, desc: 'height of the text block as a fraction of the image height (shrunk to fit the width)', aliases: ['height', 'font_size'] },
    position: { type: 'vec2', default: [0.5, 0.5], desc: 'centre of the text in uv', aliases: ['center'] },
    align: { type: 'enum', options: ['left', 'center', 'right'], default: 'center', desc: 'horizontal alignment of lines' },
    name: nameParam('text'),
  },
  outputs: 'image <name>: C grey 0..1',
  async cook(ctx) {
    const { p, type } = ctx;
    const [w, h] = size2(p, type);
    const r = await ctx.subcook({ nodes: { t: { type: 'text', params: { text: p.text, font: p.font, size: 1, align: p.align, valign: 'center', output: 'outlines' } } }, output: 't' });
    if (!r.ok || !r.geo) throw new NodeError(`${type}: ${r.errors.map((e) => e.message).join('; ') || 'text failed'}`);
    const g = r.geo;
    const img = new Image(w, h, imgName(p, 'text'));
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

// ---------------------------------------------------------------- filters

const FILTER_INPUT = [{ name: 'image', desc: 'geometry holding the image to process (everything else passes through)' }];

defineNode({
  type: 'tex_blend',
  category: 'texture',
  summary: 'Blend a foreground image over a background with a mode (normal, add, multiply, screen, overlay, min, max, difference …), opacity and an optional mask.',
  description: 'Substance: Blend; Houdini COP: Blend / Composite. result = mix(background, mode(background, foreground), opacity × mask × foreground alpha). The foreground and mask are resized to the background. A grey and an RGBA input give RGBA; alpha is the background\'s. clamp keeps the result in 0..1.',
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
    image: imageParam(), layer: layerParam(),
    foreground_image: { type: 'string', default: '', desc: 'image of input 1 ("" = first)' },
    foreground_layer: { type: 'string', default: '', desc: 'layer of the foreground ("" = main)' },
    mask_layer: { type: 'string', default: '', desc: 'layer of the mask image ("" = main)' },
    tileable: tileParam('resizing wraps at the borders'),
    name: renameParam(),
  },
  outputs: 'the background image with the blended layer',
  example: {
    nodes: {
      a: { type: 'tex_noise', params: { resolution: 256 } },
      b: { type: 'tex_pattern', params: { resolution: 256 } },
      out: { type: 'tex_blend', in: ['a', 'b'], params: { mode: 'multiply' } },
    },
    output: 'out',
  },
  cook: (ctx) => {
    const { p } = ctx;
    const A = source(ctx, 0, p.image, p.layer);
    const w = A.img.width, h = A.img.height, wrap = !!p.tileable;
    const B = sourceAt(ctx, 1, w, h, p.foreground_image, p.foreground_layer, wrap);
    if (!B) throw new NodeError(`${ctx.type}: connect a foreground image to input 1`);
    const M = sourceAt(ctx, 2, w, h, '', p.mask_layer, wrap);
    const r = blendLayers(A.data, A.ch, B.data, B.ch, M ? toGrey(M.data, M.ch) : null, p.mode, p.opacity, !!p.clamp);
    return withLayer(A, r.data, p.name);
  },
});

defineNode({
  type: 'tex_levels',
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
  cook: (ctx) => {
    const { p } = ctx;
    const s = source(ctx, 0, p.image, p.layer);
    return withLayer(s, mapValues(s.data, s.ch, levelsFn(p.in_low, p.in_high, p.gamma, p.out_low, p.out_high, !!p.clamp)), p.name);
  },
});

defineNode({
  type: 'tex_curves',
  category: 'texture',
  summary: 'Curves: map every value through a ramp (a tone curve).',
  description: 'Substance: Curve; Houdini COP: Lookup. ramp keys [[in, out], …] interpolated linearly (input clamped to 0..1). Applies to grey or RGB (alpha untouched); a colour ramp maps through its luminance.',
  aliases: ['tone_curve', 'cop_lookup', 'lookup_texture', 'texture_curve'],
  inputs: FILTER_INPUT,
  params: {
    ramp: { type: 'ramp', default: [[0, 0], [0.5, 0.5], [1, 1]], desc: 'tone curve [[in, out], …]', aliases: ['curve', 'lut'] },
    image: imageParam(), layer: layerParam(), name: renameParam(),
  },
  example: { type: 'tex_curves', params: { ramp: [[0, 0], [0.4, 0.1], [0.6, 0.9], [1, 1]] } },
  cook: (ctx) => {
    const { p } = ctx;
    const s = source(ctx, 0, p.image, p.layer);
    const { lut, ch } = rampLUT((t) => evalRamp(p.ramp, t));
    const grey = ch === 1 ? lut : Float32Array.from({ length: lut.length / 3 }, (_, k) => lut[k * 3] * 0.2126 + lut[k * 3 + 1] * 0.7152 + lut[k * 3 + 2] * 0.0722);
    return withLayer(s, curvesLayer(s.data, s.ch, grey), p.name);
  },
});

defineNode({
  type: 'tex_blur',
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
  cook: (ctx) => {
    const { p } = ctx;
    const s = source(ctx, 0, p.image, p.layer);
    return withLayer(s, blurLayer(s.data, s.ch, s.img.width, s.img.height, p.radius, p.mode, !!p.tileable), p.name);
  },
});

defineNode({
  type: 'tex_warp',
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
    warp_layer: { type: 'string', default: '', desc: 'layer of the warp image ("" = main)' },
    name: renameParam(),
  },
  cook: (ctx) => {
    const { p } = ctx;
    const s = source(ctx, 0, p.image, p.layer);
    const w = s.img.width, h = s.img.height;
    const W = sourceAt(ctx, 1, w, h, '', p.warp_layer, !!p.tileable);
    if (!W) throw new NodeError(`${ctx.type}: connect a warp image to input 1`);
    return withLayer(s, warpLayer(s.data, s.ch, w, h, W.data, W.ch, p.mode, p.intensity, p.angle, !!p.tileable), p.name);
  },
});

defineNode({
  type: 'tex_transform',
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
  cook: (ctx) => {
    const { p } = ctx;
    const s = source(ctx, 0, p.image, p.layer);
    return withLayer(s, transformLayer(s.data, s.ch, s.img.width, s.img.height, [p.offset[0], p.offset[1]], p.rotate, [p.scale[0], p.scale[1]], [p.tile[0], p.tile[1]], !!p.tileable), p.name);
  },
});

defineNode({
  type: 'tex_edge_detect',
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
  cook: (ctx) => {
    const { p } = ctx;
    const s = source(ctx, 0, p.image, p.layer);
    return withLayer(s, edgeDetect(toGrey(s.data, s.ch), s.img.width, s.img.height, p.strength, p.width, !!p.tileable), p.name);
  },
});

defineNode({
  type: 'tex_invert',
  category: 'texture',
  summary: 'Invert: 1 - value (grey or RGB; alpha untouched).',
  aliases: ['invert', 'cop_invert', 'negate'],
  inputs: FILTER_INPUT,
  params: { image: imageParam(), layer: layerParam(), name: renameParam() },
  cook: (ctx) => {
    const s = source(ctx, 0, ctx.p.image, ctx.p.layer);
    return withLayer(s, mapValues(s.data, s.ch, (x) => 1 - x), ctx.p.name);
  },
});

defineNode({
  type: 'tex_threshold',
  category: 'texture',
  summary: 'Threshold: grey 1 where the value (luminance) is above threshold, else 0, with an optional soft band.',
  aliases: ['threshold', 'cop_threshold', 'binarize'],
  inputs: FILTER_INPUT,
  params: {
    threshold: { type: 'float', default: 0.5, desc: 'cut value', aliases: ['level', 'value'] },
    softness: { type: 'float', default: 0, min: 0, max: 1, desc: 'width of the smooth transition around threshold', aliases: ['smooth', 'falloff'] },
    image: imageParam(), layer: layerParam(), name: renameParam(),
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
    return withLayer(s, out, p.name);
  },
});

defineNode({
  type: 'tex_histogram_scan',
  category: 'texture',
  summary: 'Histogram scan: slide a threshold through a grey image (position) with adjustable hardness (contrast); the classic mask maker.',
  description: 'Substance: Histogram Scan. position 0 = black, 1 = white, 0.5 with contrast 0 = unchanged; contrast 1 = a hard cut at 1 - position. Use on noise or a curvature bake to grow wear or dirt masks.',
  aliases: ['histogram_scan', 'histogramscan', 'scan'],
  inputs: FILTER_INPUT,
  params: {
    position: { type: 'float', default: 0.5, min: 0, max: 1, desc: 'how much is white (0 = none, 1 = all)' },
    contrast: { type: 'float', default: 0.5, min: 0, max: 1, desc: 'hardness of the transition (1 = hard cut)' },
    image: imageParam(), layer: layerParam(), name: renameParam(),
  },
  cook: (ctx) => {
    const { p } = ctx;
    const s = source(ctx, 0, p.image, p.layer);
    const f = histogramScanFn(p.position, p.contrast), g = toGrey(s.data, s.ch);
    const out = new Float32Array(g.length);
    for (let i = 0; i < g.length; i++) out[i] = f(g[i]);
    return withLayer(s, out, p.name);
  },
});

defineNode({
  type: 'tex_normal_from_height',
  category: 'texture',
  summary: 'Normal map from a height image (Sobel): tangent-space RGBA, OpenGL (+Y up) or DirectX (Y down).',
  description: 'Substance: Normal (from height); Houdini COP: Bump to Normal. strength 1 tilts the normal 45° where the height rises by 1 over 1/64 of the image width (the same look at any resolution). A flat image gives (0.5, 0.5, 1). glTF and Blender use OpenGL; Unreal uses DirectX (or flip green on import).',
  aliases: ['normal_from_height', 'height_to_normal', 'normal_map', 'bump_to_normal', 'cop_bumptonormal'],
  inputs: FILTER_INPUT,
  params: {
    strength: { type: 'float', default: 1, desc: 'slope scale (negative inverts the relief)', aliases: ['intensity', 'height_scale'] },
    format: { type: 'enum', options: ['opengl', 'directx'], default: 'opengl', desc: 'green channel convention', aliases: ['convention'] },
    tileable: tileParam(),
    image: imageParam(), layer: layerParam(), name: renameParam(),
  },
  cook: (ctx) => {
    const { p } = ctx;
    const s = source(ctx, 0, p.image, p.layer);
    return withLayer(s, normalFromHeight(toGrey(s.data, s.ch), s.img.width, s.img.height, p.strength, p.format === 'directx', !!p.tileable), p.name);
  },
});

defineNode({
  type: 'tex_height_to_ao',
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
  cook: (ctx) => {
    const { p } = ctx;
    const s = source(ctx, 0, p.image, p.layer);
    return withLayer(s, heightToAO(toGrey(s.data, s.ch), s.img.width, s.img.height, p.radius, p.depth, p.directions, p.steps, !!p.tileable), p.name);
  },
});

defineNode({
  type: 'tex_channel',
  category: 'texture',
  summary: 'Pack grey images into the R, G, B, A channels of one RGBA image (e.g. ORM for glTF/Unreal: occlusion, roughness, metallic), or extract one channel as grey.',
  description: 'Substance: RGBA Merge / RGBA Split / Channel Shuffle; Houdini COP: Channel Copy. pack: inputs 0..3 fill R, G, B, A (their luminance); unconnected channels take fill (default [1, 0.5, 0, 1]: occlusion 1, roughness 0.5, metallic 0, alpha 1, the ORM convention of glTF and Unreal). The size is the first connected input\'s; others are resized. extract: one channel of input 0 as a grey image (keeps the input, replacing the layer).',
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
    name: nameParam('', 'pack: the new image\'s name ("" = "packed"); extract: rename the result ("" = keep)'),
  },
  outputs: 'pack: a new RGBA image <name> (default "packed"); extract: input 0 with the channel as its layer',
  example: {
    nodes: {
      ao: { type: 'tex_noise', params: { resolution: 256, scale: 3 } },
      rough: { type: 'tex_cells', params: { resolution: 256 } },
      orm: { type: 'tex_channel', in: ['ao', 'rough'], params: { name: 'orm', fill: [1, 0.5, 0, 1] } },
    },
    output: 'orm',
  },
  cook: (ctx) => {
    const { p, type } = ctx;
    if (p.mode === 'extract') {
      const s = source(ctx, 0);
      const k = ['r', 'g', 'b', 'a'].indexOf(p.channel);
      const n = s.img.count, out = new Float32Array(n);
      if (s.ch === 1) out.set(p.channel === 'a' ? new Float32Array(n).fill(1) : s.data);
      else if (k < 0) out.set(toGrey(s.data, 4));
      else for (let i = 0; i < n; i++) out[i] = s.data[i * 4 + k];
      return withLayer(s, out, p.name);
    }
    const first = [0, 1, 2, 3].find((i) => ctx.hasInput(i));
    if (first === undefined) throw new NodeError(`${type}: connect at least one input (R, G, B or A)`);
    const ref = source(ctx, first);
    const w = ref.img.width, h = ref.img.height, n = w * h;
    const out = new Float32Array(n * 4);
    for (let c = 0; c < 4; c++) {
      const s = sourceAt(ctx, c, w, h);
      const g = s ? toGrey(s.data, s.ch) : null;
      for (let i = 0; i < n; i++) out[i * 4 + c] = g ? g[i] : p.fill[c];
    }
    return imageGeo(new Image(w, h, imgName(p, 'packed')).set(MAIN_LAYER, out));
  },
});

defineNode({
  type: 'tex_colorize',
  category: 'texture',
  summary: 'Colorize: map a grey image through a colour ramp (gradient map) into RGBA.',
  description: 'Substance: Gradient Map; Houdini COP: Ramp lookup. ramp keys [[pos, colour], …] with colours as [r, g, b] or "#hex"; the image holds those numbers as they are, so a "#a5462e" key comes out of the PNG as #a5462e. RGBA input uses its luminance.',
  aliases: ['colorize', 'gradient_map', 'colourize', 'color_ramp', 'tint'],
  inputs: FILTER_INPUT,
  params: {
    ramp: { type: 'ramp', default: [[0, '#000000'], [1, '#ffffff']], desc: 'colour ramp [[pos, colour], …]', aliases: ['gradient', 'colors', 'colours'] },
    image: imageParam(), layer: layerParam(), name: renameParam(),
  },
  example: { type: 'tex_colorize', params: { ramp: [[0, '#3b2316'], [0.5, '#8a4b2a'], [1, '#c9845a']] } },
  cook: (ctx) => {
    const { p } = ctx;
    const s = source(ctx, 0, p.image, p.layer);
    const { lut, ch } = rampLUT((t) => evalRamp(p.ramp, t));
    return withLayer(s, colorize(toGrey(s.data, s.ch), lut, ch), p.name);
  },
});

defineNode({
  type: 'tex_tile_sampler',
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
    image: imageParam(), layer: layerParam(),
    name: nameParam('tiles'),
  },
  outputs: 'a new image <name>: C grey',
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
    const m = sourceAt(ctx, 1, w, h);
    const C = tileSampler(toGrey(s.data, s.ch), s.img.width, s.img.height, w, h, {
      count: [p.count[0], p.count[1]], scale: [p.scale[0], p.scale[1]], rotation: p.rotation, jitter: p.jitter, offset: p.offset,
      intensity: [p.intensity[0], p.intensity[1]], seed: p.seed, add: p.combine === 'add',
    }, m ? toGrey(m.data, m.ch) : null);
    return imageGeo(new Image(w, h, imgName(p, 'tiles')).set(MAIN_LAYER, C));
  },
});

// ---------------------------------------------------------------- output, materials and bridges

defineNode({
  type: 'tex_output',
  category: 'texture',
  summary: 'Name an image (rename), or copy one of its layers out as a new image (e.g. the "id" layer of a pattern).',
  description: 'Substance: Output node; Houdini COP: Null / Output. With layer "" the image is renamed to `name`; with a layer, a new image `name` holds that layer as C and the original stays. An image already called `name` is replaced. keep_only drops every other image (and the mesh) from the output.',
  aliases: ['texture_output', 'rename_image', 'image_output', 'cop_null'],
  inputs: FILTER_INPUT,
  params: {
    name: { type: 'string', default: 'image', desc: 'the image name (materials reference it as "image:<name>")', aliases: ['image_name', 'output_name'] },
    image: imageParam(),
    layer: { type: 'string', default: '', desc: 'copy this layer out as a new image ("" = rename the whole image)' },
    keep_only: { type: 'bool', default: false, desc: 'output only this image' },
  },
  cook: (ctx) => {
    const { p, type } = ctx;
    const name = String(p.name ?? '').trim();
    if (!name) throw new NodeError(`${type}: name is empty`);
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
    'of input 1 (or input 0); it is copied into the output and the material table entry gets "image:<name>" in that slot. ' +
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
      bricks: { type: 'tex_pattern', params: { resolution: 256, name: 'brick_height' } },
      color: { type: 'tex_colorize', in: ['bricks'], params: { ramp: [[0, '#6b6b66'], [0.5, '#7a3424'], [1, '#a5462e']], name: 'brick_color' } },
      nrm: { type: 'tex_normal_from_height', in: ['bricks'], params: { strength: 2, name: 'brick_normal' } },
      maps: { type: 'merge', in: ['color', 'nrm'] },
      out: { type: 'texture_to_material', in: ['uv', 'maps'], params: { material: 'brick', base_color: 'brick_color', normal: 'brick_normal' } },
    },
    output: 'out',
  },
  cook: (ctx) => {
    const { p, type } = ctx;
    const mat = String(p.material ?? '').trim();
    if (!mat) throw new NodeError(`${type}: material name is empty`);
    const g = ctx.input(0).clone();
    const pool = new Map<string, Image>();
    for (const im of imagesOf(ctx.input(0))) if (!pool.has(im.name)) pool.set(im.name, im);
    if (ctx.hasInput(1)) for (const im of imagesOf(ctx.input(1))) if (!pool.has(im.name)) pool.set(im.name, im);
    const need = (param: string): Image | null => {
      const n = String(p[param] ?? '').trim().replace(/^image:/, '');
      if (!n) return null;
      const im = pool.get(n);
      if (!im) throw new NodeError(`${type}: no image "${n}" for ${param}`, pool.size ? `images: ${[...pool.keys()].join(', ')}` : NO_IMAGE);
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
  category: 'texture',
  summary: 'Bridge: a heightfield layer becomes a grey image of the same sample count (normalised to 0..1 by default).',
  description: 'Sample (i, j) → pixel (i, j) (the −Z row at the top). normalize fits the layer\'s min..max to 0..1 (the range is recorded as the stats range_min / range_max); off writes raw values. Feed tex_normal_from_height or tex_height_to_ao for terrain maps, or bake terrain masks into textures.',
  aliases: ['heightfield_to_image', 'hf2tex', 'heightfield_texture'],
  inputs: [{ name: 'heightfield', desc: 'geometry with a heightfield' }],
  params: {
    layer: { type: 'string', default: 'height', desc: 'heightfield layer' },
    normalize: { type: 'bool', default: true, desc: 'fit min..max to 0..1', aliases: ['fit'] },
    keep: { type: 'bool', default: false, desc: 'keep the input (heightfield and all) and add the image; off outputs only the image' },
    name: nameParam('', 'image name ("" = the layer name)'),
  },
  outputs: 'image <name> (default: the layer name): C grey',
  cook: (ctx) => {
    const { p, type } = ctx;
    const hfs = heightfieldsOf(ctx.input(0));
    if (!hfs.length) throw new NodeError(`${type}: input has no heightfield`, 'create one with heightfield, heightfield_from_mesh or tex_to_heightfield');
    const hf = hfs[0];
    const a = hf.layer(p.layer);
    if (!a) throw new NodeError(`${type}: heightfield "${hf.name}" has no layer "${p.layer}"`, `layers: ${[...hf.layers.keys()].join(', ')}`);
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < a.length; k++) { if (a[k] < lo) lo = a[k]; if (a[k] > hi) hi = a[k]; }
    const out = new Float32Array(a.length);
    const span = hi - lo;
    for (let k = 0; k < a.length; k++) out[k] = p.normalize ? (span > 0 ? (a[k] - lo) / span : 0) : a[k];
    const img = new Image(hf.width, hf.height, imgName(p, p.layer)).set(MAIN_LAYER, out);
    if (p.normalize) { ctx.stat('range_min', lo); ctx.stat('range_max', hi); }
    if (!p.keep) return imageGeo(img);
    const g = ctx.input(0).clone();
    g.volumes.push(img);
    return g;
  },
});
