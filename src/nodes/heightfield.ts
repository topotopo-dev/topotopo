// Heightfield nodes (Houdini's HeightField SOPs): create, noise, import from meshes and images, filters, masks,
// erosion, stamping, roads, scattering, conversion to polygons and SDFs. Heightfields are volumes carried in
// Geometry.volumes (core/heightfield.ts): a grid in XZ with named float layers. Every node clones its input and
// writes new layer arrays (Heightfield.writable), never into arrays it did not allocate.
import { Geometry } from '../core/geometry.ts';
import type { SdfVolume } from '../core/geometry.ts';
import {
  Heightfield, MAX_SAMPLES, asHeightfield, bilinear, blurGrid, cropHeightfield, curvesOf, distanceTransform, heightfieldToMesh,
  heightfieldsOf, isHeightfield, layerStats, rasterizeMesh, slopeLayer, smoothstep, splatSegment, transformHeightfield,
} from '../core/heightfield.ts';
import { dropletParams, erodeStep, makeErosionField } from '../core/erosion.ts';
import type { DropletSettings } from '../core/erosion.ts';
import { fractal, makeNoise, makeWarp } from '../core/noise.ts';
import { rng } from '../core/random.ts';
import { decodePNG, pngChannel } from '../io/png-decode.ts';
import type { PngChannel } from '../io/png-decode.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import type { CookContext, ParamDef } from '../graph/types.ts';
import { evalRamp } from '../graph/params.ts';
import { sampleEliminate } from './copy.ts';
import { connectivity } from '../core/topology.ts';
import { minDistanceSelect } from '../core/pcg.ts';
import { P, simBudget } from './util.ts';
import { wasmCallUnderBudget } from './wasmcall.ts';
import { codeVarDecl, codeVarNames, codeVarValues } from '../core/usercode.ts';
import { scriptVarsGuard } from '../core/snippet-lib.ts';
import { getLoadedKernels, loadHostKernels } from '../wasm/kernels.ts';
import type { ErosionResult, FillSinksResult, FlowAccumulationResult, Kernels } from '../wasm/kernels.ts';

// ---------------------------------------------------------------- shared

const NO_FIELD = 'create one with heightfield, heightfield_from_mesh or heightfield_from_image';
/** Samples × iterations from which a kernel erosion runs on a pool worker, under the time limit (about a second of work). */
const WORKER_SAMPLE_ITERATIONS = 20_000_000;
/** A global flood cannot be split into independent tiles; large calls run intact on one worker. */
const FLOOD_WORKER_SAMPLES = 1_000_000;
const clamp01 = (x: number) => (x > 0 ? (x < 1 ? x : 1) : 0);

/** Clone the input and run fn on each heightfield (each has its own layer map); fn may return a replacement. */
function eachField(ctx: CookContext, fn: (hf: Heightfield) => Heightfield | void): Geometry {
  const g = ctx.input(0).clone();
  let n = 0;
  for (let k = 0; k < g.volumes.length; k++) {
    const v = g.volumes[k];
    if (!isHeightfield(v)) continue;
    const hf = asHeightfield(v);
    g.volumes[k] = fn(hf) ?? hf;
    n++;
  }
  if (!n) throw new NodeError(`${ctx.type}: input has no heightfield`, NO_FIELD);
  return g;
}

/** eachField for an async fn (one field at a time). */
async function eachFieldAsync(ctx: CookContext, fn: (hf: Heightfield) => Promise<Heightfield | void>): Promise<Geometry> {
  const g = ctx.input(0).clone();
  let n = 0;
  for (let k = 0; k < g.volumes.length; k++) {
    const v = g.volumes[k];
    if (!isHeightfield(v)) continue;
    const hf = asHeightfield(v);
    g.volumes[k] = (await fn(hf)) ?? hf;
    n++;
  }
  if (!n) throw new NodeError(`${ctx.type}: input has no heightfield`, NO_FIELD);
  return g;
}

function layerOf(hf: Heightfield, name: string, node: string): Float32Array {
  const a = hf.layer(name);
  if (!a) throw new NodeError(`${node}: heightfield "${hf.name}" has no layer "${name}"`, `layers: ${[...hf.layers.keys()].join(', ') || 'none'}`);
  return a;
}

/** The blend mask layer ('' = none). */
const maskOf = (hf: Heightfield, name: string, node: string): Float32Array | null => (name ? layerOf(hf, name, node) : null);

function checkName(name: string, node: string, what = 'layer') {
  if (!name || !String(name).trim()) throw new NodeError(`${node}: ${what} name is empty`);
}

function checkGrid(w: number, h: number, node: string) {
  if (!(w >= 2 && h >= 2)) throw new NodeError(`${node}: a heightfield needs at least 2 × 2 samples (got ${w} × ${h})`);
  if (w * h > MAX_SAMPLES) throw new NodeError(`${node}: ${w} × ${h} samples is too large (max ${MAX_SAMPLES.toLocaleString('en-US')}); raise the resolution (cell size)`);
}

const COMBINE = ['replace', 'add', 'subtract', 'multiply', 'max', 'min'];
function combine(mode: string, a: number, b: number): number {
  switch (mode) {
    case 'add': return a + b;
    case 'subtract': return a - b;
    case 'multiply': return a * b;
    case 'max': return a > b ? a : b;
    case 'min': return a < b ? a : b;
    default: return b;
  }
}

/** Write fn(k, old) into a layer, blended by an optional 0..1 mask layer. */
function writeLayer(hf: Heightfield, name: string, mask: Float32Array | null, fn: (k: number, old: number) => number, fill = 0) {
  const old = hf.read(name, fill);
  const out = hf.writable(name, fill);
  for (let k = 0; k < out.length; k++) {
    const v = fn(k, old[k]);
    out[k] = mask ? old[k] + (v - old[k]) * clamp01(mask[k]) : v;
  }
}

const layerParam = (def = 'height', desc = 'layer to modify'): ParamDef => ({ type: 'string', default: def, desc });
const maskParam = (): ParamDef => ({ type: 'string', default: '', desc: 'optional 0..1 layer that blends the result in ("" = everywhere), e.g. "mask"', aliases: ['mask'] });
const centerParam = (): ParamDef => ({ type: 'vec3', default: [0, 0, 0], desc: 'field centre: X and Z place the grid, Y is added to the initial height', aliases: ['t', 'translate', 'position', 'pos'] });

/** Squared-distance transform result in metres. */
function distancesTo(sites: Uint8Array, hf: Heightfield): { dist: Float64Array; nearest: Int32Array } {
  const { d2, nearest } = distanceTransform(sites, hf.width, hf.height);
  const dist = new Float64Array(d2.length);
  for (let k = 0; k < d2.length; k++) dist[k] = Math.sqrt(d2[k]) * hf.cellSize;
  return { dist, nearest };
}

// ---------------------------------------------------------------- create

defineNode({
  type: 'heightfield',
  category: 'heightfield',
  summary: 'Create a flat heightfield: a terrain grid in XZ (Y up) with height and mask layers. Start of every terrain workflow.',
  description: 'Houdini: HeightField. A heightfield is a volume carried in the geometry (like an SDF), not polygons: a regular grid of samples with named float layers (height = world Y, mask 0..1, plus flow, sediment, debris, water and any user layer). Samples sit on the grid nodes, so size 20 at resolution 0.1 gives 201 × 201 samples, the way Unreal counts landscape vertices. render draws it as a shaded grid (mask in red, color_by any layer); heightfield_to_mesh makes polygons; export png16/r16 writes an Unreal Landscape heightmap.',
  aliases: ['heightfield_create', 'hf', 'height_field'],
  inputs: [],
  params: {
    size: { type: 'vec2', default: [20, 20], desc: 'extent in X and Z (metres), rounded up to whole cells' },
    resolution: { type: 'float', default: 0.1, min: 0.001, desc: 'cell size: distance between samples (metres)', aliases: ['grid_spacing', 'cell_size', 'spacing', 'voxel_size', 'divsize'] },
    samples: { type: 'ivec2', default: [0, 0], min: 0, max: MAX_SAMPLES, desc: 'sample counts [nx, nz]; when nx > 1 they override resolution (cell = size.x / (nx - 1), depth = (nz - 1) × cell), e.g. [505, 505] for Unreal' },
    center: centerParam(),
    height: { type: 'float', default: 0, desc: 'initial height (world Y)', aliases: ['initial_height', 'elevation'] },
    name: { type: 'string', default: 'heightfield', desc: 'heightfield name (shown by inspect)' },
  },
  outputs: 'heightfield volume with layers height, mask',
  example: { type: 'heightfield', params: { size: [20, 20], resolution: 0.1 } },
  cook: ({ p, type }) => {
    let w: number, h: number, cell: number;
    if (p.samples[0] > 1) {
      w = p.samples[0];
      cell = p.size[0] / (w - 1);
      h = p.samples[1] > 1 ? p.samples[1] : Math.max(2, Math.ceil(p.size[1] / cell - 1e-6) + 1);
    } else {
      cell = p.resolution;
      w = Math.max(2, Math.ceil(p.size[0] / cell - 1e-6) + 1);
      h = Math.max(2, Math.ceil(p.size[1] / cell - 1e-6) + 1);
    }
    if (!(cell > 0)) throw new NodeError(`${type}: size must be > 0`);
    checkGrid(w, h, type);
    const hf = new Heightfield(w, h, cell, [p.center[0] - ((w - 1) * cell) / 2, p.center[2] - ((h - 1) * cell) / 2], undefined, p.name || 'heightfield');
    hf.layers.set('height', new Float32Array(w * h).fill(p.height + p.center[1]));
    hf.layers.set('mask', new Float32Array(w * h));
    const g = new Geometry();
    g.volumes = [hf];
    return g;
  },
});

// ---------------------------------------------------------------- noise

const NOISE_PARAMS: Record<string, ParamDef> = {
  noise: { type: 'enum', options: ['perlin', 'simplex', 'value', 'worley'], default: 'simplex', desc: 'base noise', aliases: ['basis', 'noise_type'] },
  fractal: { type: 'enum', options: ['fbm', 'ridged', 'turbulence', 'none'], default: 'fbm', desc: 'layering: fbm = rolling hills, ridged = mountain ridges, turbulence = billowy' },
  amplitude: { type: 'float', default: 1, desc: 'noise height (metres for the height layer)', aliases: ['amp', 'height', 'scale'] },
  element_size: { type: 'float', default: 5, min: 0.001, desc: 'size of the largest features (metres); frequency = 1 / element_size', aliases: ['elementsize', 'feature_size', 'wavelength'] },
  frequency: { type: 'float', default: 0, min: 0, desc: 'features per metre; > 0 overrides element_size', aliases: ['freq'] },
  octaves: { type: 'int', default: 6, min: 1, max: 12, desc: 'fractal octaves (detail levels)' },
  roughness: { type: 'float', default: 0.5, min: 0, max: 1, desc: 'amplitude gain per octave (higher = rougher)', aliases: ['gain', 'persistence'] },
  lacunarity: { type: 'float', default: 2.01, min: 1, desc: 'frequency gain per octave' },
  range: { type: 'enum', options: ['zero_centered', 'positive'], default: 'zero_centered', desc: 'zero_centered: noise in [-amplitude, amplitude]; positive: [0, amplitude]' },
  offset: { type: 'vec3', default: [0, 0, 0], desc: 'noise-space offset (scrolls the pattern; Y picks another slice)', aliases: ['translate_noise', 'noise_offset'] },
  seed: P.seed(),
  warp_amplitude: { type: 'float', default: 0, min: 0, desc: 'domain warp: how far (metres) a second noise moves each sample\'s lookup along X and Z, bending ridges, valleys and contours into meanders (0 = off)', aliases: ['warp', 'warp_amount'] },
  warp_element_size: { type: 'float', default: 10, min: 0.001, desc: 'domain warp: size of the bends (metres); frequency = 1 / warp_element_size' },
  warp_frequency: { type: 'float', default: 0, min: 0, desc: 'domain warp: bends per metre; > 0 overrides warp_element_size' },
  warp_octaves: { type: 'int', default: 3, min: 1, max: 8, desc: 'domain warp: fractal octaves of the warp noise (more = wigglier bends)' },
  warp_seed: { ...P.seed(), desc: 'domain warp: seed of the warp noise (independent of seed)' },
};

function noiseValues(hf: Heightfield, p: any): Float32Array {
  const base = makeNoise(p.noise, p.seed);
  const n = fractal(base, { octaves: p.octaves, roughness: p.roughness, lacunarity: p.lacunarity, fractal: p.fractal });
  const f = p.frequency > 0 ? p.frequency : 1 / Math.max(1e-6, p.element_size);
  const out = new Float32Array(hf.count);
  const [ox, oy, oz] = p.offset as number[];
  const worley = p.noise === 'worley' && (p.fractal === 'fbm' || p.fractal === 'none');
  const positive = p.range === 'positive';
  // domain warp: the lookup at world (x, z) moves by amplitude × the warp noise there, both in world metres, so it is
  // the same at any resolution and on any tile of a map
  const A = p.warp_amplitude > 0 ? p.warp_amplitude : 0;
  const warp = A ? makeWarp(p.warp_seed, p.warp_octaves) : null;
  const fw = p.warp_frequency > 0 ? p.warp_frequency : 1 / Math.max(1e-6, p.warp_element_size);
  const qy = oy * fw;
  for (let j = 0; j < hf.height; j++) {
    const zw = hf.z(j) + oz, z = zw * f, qz = zw * fw;
    for (let i = 0; i < hf.width; i++) {
      let v: number;
      if (warp) {
        const x = hf.x(i) + ox, qx = x * fw;
        v = n((x + A * warp.x(qx, qy, qz)) * f, oy * f, (zw + A * warp.z(qx, qy, qz)) * f);
      } else v = n((hf.x(i) + ox) * f, oy * f, z);
      if (worley) v = v * 2 - 1;
      if (positive) v = v * 0.5 + 0.5;
      out[j * hf.width + i] = v * p.amplitude;
    }
  }
  return out;
}

defineNode({
  type: 'heightfield_noise',
  category: 'heightfield',
  summary: 'Add (or multiply, replace, max, min) fractal noise on a heightfield layer: mountains, hills, dunes, mask variation.',
  description: 'Houdini: HeightField Noise. Noise is sampled at each sample\'s world X/Z, so it is resolution-independent and a tile of a map gets the map\'s values. For mountains use fractal ridged, amplitude a few metres, element_size about a third of the field. Domain warp (warp_amplitude > 0) moves each lookup by a second noise, in metres: ridges, escarpments and valleys meander instead of running straight (warp_element_size a few times element_size for broad bends, smaller for wiggles; terrace the result for meandering cliff bands). mask_layer blends the result in by a 0..1 layer.',
  aliases: ['hf_noise', 'heightfield_mountain'],
  inputs: [{ name: 'heightfield', desc: 'geometry with a heightfield' }],
  params: {
    layer: layerParam(),
    mode: { type: 'enum', options: COMBINE, default: 'add', desc: 'how the noise combines with the layer', aliases: ['combine', 'operation', 'method'] },
    ...NOISE_PARAMS,
    mask_layer: maskParam(),
  },
  outputs: 'the layer (created if missing)',
  example: { nodes: { hf: { type: 'heightfield', params: { size: [20, 20], resolution: 0.1 } }, mtn: { type: 'heightfield_noise', in: ['hf'], params: { fractal: 'ridged', amplitude: 4, element_size: 8, range: 'positive', warp_amplitude: 2.5, warp_element_size: 12 } } }, output: 'mtn' },
  cook: (ctx) => {
    const { p } = ctx;
    checkName(p.layer, ctx.type);
    return eachField(ctx, (hf) => {
      const n = noiseValues(hf, p), mask = maskOf(hf, p.mask_layer, ctx.type);
      writeLayer(hf, p.layer, mask, (k, old) => combine(p.mode, old, n[k]));
    });
  },
});

defineNode({
  type: 'heightfield_mask_noise',
  category: 'heightfield',
  summary: 'Noise into a mask layer (clamped 0..1): break up masks, vary scatter density and materials.',
  description: 'Houdini: HeightField Mask Noise. Same noise as heightfield_noise (domain warp included) with mask defaults: range positive, mode replace; use mode multiply to break up an existing mask. A band around 0.5 of a warped mask noise traces meandering lines: rivers, paths, strata.',
  aliases: ['hf_mask_noise'],
  inputs: [{ name: 'heightfield', desc: 'geometry with a heightfield' }],
  params: {
    layer: layerParam('mask', 'mask layer to write'),
    mode: { type: 'enum', options: COMBINE, default: 'replace', desc: 'how the noise combines with the mask', aliases: ['combine', 'operation', 'method'] },
    ...NOISE_PARAMS,
    range: { ...NOISE_PARAMS.range, default: 'positive' },
    element_size: { ...NOISE_PARAMS.element_size, default: 3 },
    octaves: { ...NOISE_PARAMS.octaves, default: 4 },
    contrast: { type: 'float', default: 1, min: 0, desc: 'sharpen (> 1) or soften (< 1) the noise around 0.5 before combining' },
  },
  outputs: 'the mask layer (0..1)',
  example: { nodes: { hf: { type: 'heightfield' }, m: { type: 'heightfield_mask_noise', in: ['hf'], params: { element_size: 4, contrast: 2 } } }, output: 'm' },
  cook: (ctx) => {
    const { p } = ctx;
    checkName(p.layer, ctx.type);
    return eachField(ctx, (hf) => {
      const n = noiseValues(hf, p);
      writeLayer(hf, p.layer, null, (k, old) => clamp01(combine(p.mode, old, clamp01((n[k] - 0.5) * p.contrast + 0.5))));
    });
  },
});

// ---------------------------------------------------------------- from mesh / image

defineNode({
  type: 'heightfield_from_mesh',
  category: 'heightfield',
  summary: 'Make a heightfield from polygons by projecting them along Y: height = highest (or lowest) surface, mask = 1 where hit.',
  description: 'Houdini: HeightField Project onto a new HeightField. Every sample takes the Y of the mesh surface straight above/below it (exact: the triangles are rasterised onto the grid, same result as a vertical ray per sample). The field covers the mesh\'s XZ bounds plus padding unless size is set. Samples that miss get the mesh\'s lowest Y (miss "min"), 0, or background.',
  aliases: ['heightfield_project_mesh', 'mesh_to_heightfield', 'hf_from_mesh'],
  inputs: [{ name: 'mesh', desc: 'polygons (terrain scans, sculpted meshes, building footprints)' }],
  params: {
    resolution: { type: 'float', default: 0.1, min: 0.001, desc: 'cell size (metres)', aliases: ['grid_spacing', 'cell_size', 'spacing', 'voxel_size'] },
    padding: { type: 'float', default: 0, min: 0, desc: 'extra border around the mesh bounds (metres)' },
    size: { type: 'vec2', default: [0, 0], desc: 'field extent in X and Z; 0 = the mesh bounds (+ padding)' },
    center: { type: 'vec3', default: [0, 0, 0], desc: 'field centre when size is set' },
    direction: { type: 'enum', options: ['down', 'up'], default: 'down', desc: 'down = the highest surface (looking from above), up = the lowest' },
    miss: { type: 'enum', options: ['min', 'zero', 'background'], default: 'min', desc: 'height where nothing is hit: the mesh\'s lowest Y, 0, or the background value' },
    background: { type: 'float', default: 0, desc: 'height for misses when miss = background' },
    mask: { type: 'bool', default: true, desc: 'write mask = 1 where the mesh was hit, 0 elsewhere' },
    name: { type: 'string', default: 'heightfield', desc: 'heightfield name' },
  },
  outputs: 'heightfield volume with layers height, mask',
  example: { nodes: { g: { type: 'grid', params: { size: [10, 10] } }, n: { type: 'noise_displace', in: ['g'], params: { amplitude: 1 } }, hf: { type: 'heightfield_from_mesh', in: ['n'], params: { resolution: 0.1 } } }, output: 'hf' },
  cook: ({ input, p, type }) => {
    const g = input(0);
    let closed = 0;
    for (let k = 0; k < g.numPrims; k++) closed += g.primClosed[k];
    if (!closed) throw new NodeError(`${type}: input has no polygons to project`, 'use heightfield_project with curves, or heightfield_mask_by_object for points');
    const bb = g.bbox();
    const cell = p.resolution;
    const sx = p.size[0] > 0 ? p.size[0] : bb.max[0] - bb.min[0] + 2 * p.padding;
    const sz = p.size[1] > 0 ? p.size[1] : bb.max[2] - bb.min[2] + 2 * p.padding;
    const cx = p.size[0] > 0 ? p.center[0] : (bb.min[0] + bb.max[0]) / 2, cz = p.size[1] > 0 ? p.center[2] : (bb.min[2] + bb.max[2]) / 2;
    const w = Math.max(2, Math.ceil(sx / cell - 1e-6) + 1), h = Math.max(2, Math.ceil(sz / cell - 1e-6) + 1);
    checkGrid(w, h, type);
    const hf = new Heightfield(w, h, cell, [cx - ((w - 1) * cell) / 2, cz - ((h - 1) * cell) / 2], undefined, p.name || 'heightfield');
    const up = p.direction === 'up';
    const H = new Float32Array(w * h).fill(up ? Infinity : -Infinity);
    const hit = new Uint8Array(w * h);
    rasterizeMesh(hf, g, (k, y) => {
      hit[k] = 1;
      if (up ? y < H[k] : y > H[k]) H[k] = y;
    });
    const missH = p.miss === 'zero' ? 0 : p.miss === 'background' ? p.background : bb.min[1];
    const M = new Float32Array(w * h);
    for (let k = 0; k < H.length; k++) { if (hit[k]) M[k] = 1; else H[k] = missH; }
    hf.layers.set('height', H);
    if (p.mask) hf.layers.set('mask', M);
    const out = new Geometry();
    out.volumes = [hf];
    return out;
  },
});

defineNode({
  type: 'heightfield_from_image',
  category: 'heightfield',
  summary: 'Load a heightmap or mask from an 8/16-bit PNG (grey or colour) into a heightfield layer.',
  description: 'Houdini: HeightField File. One sample per pixel; image column = X, row = Z with row 0 at the field\'s min Z (the layout export png16 writes, so a round trip lines up). Values 0..1 map to height_min..height_max (use the numbers from the export sidecar; 0 and 1 for masks). The image covers size.x metres along X (or (pixels − 1) × resolution) around center, Z following its aspect. With a heightfield connected, the image is written into `layer` of that field instead of creating one: placed in the world the same way (fit world: every sample reads the image at its own X/Z, bilinear, so a tile reads the same values as the whole map; samples outside the image keep the layer), or stretched over the connected field (fit field, which depends on that field\'s extent).',
  aliases: ['heightfield_file', 'heightmap_import', 'hf_from_image', 'heightfield_image'],
  inputs: [{ name: 'heightfield', desc: 'optional: write the image into this field', optional: true }],
  params: {
    path: { type: 'path', default: '', desc: 'PNG file or URL; a relative path reads from the project folder (nearest project.json), else the graph\'s folder', aliases: ['file', 'filename'] },
    layer: layerParam('height', 'layer to write'),
    height_min: { type: 'float', default: 0, desc: 'value for black (0)', aliases: ['min', 'low'] },
    height_max: { type: 'float', default: 10, desc: 'value for white (1)', aliases: ['max', 'high'] },
    channel: { type: 'enum', options: ['luminance', 'average', 'r', 'g', 'b', 'a'], default: 'luminance', desc: 'which channel of a colour image' },
    size: { type: 'vec2', default: [20, 20], desc: 'image extent along X (metres; Z follows the image aspect): a new field\'s size, or where the image lies over a connected field (fit world)' },
    resolution: { type: 'float', default: 0, min: 0, desc: 'pixel spacing (metres); > 0 overrides size (extent = (pixels - 1) × resolution)' },
    center: centerParam(),
    fit: { type: 'enum', options: ['world', 'field'], default: 'world', desc: 'with a heightfield connected: world = the image lies at center/size in the world and each sample reads it at its X/Z; field = stretch the image over the connected field (depends on its extent)', aliases: ['placement'] },
    flip_z: { type: 'bool', default: false, desc: 'image row 0 at max Z instead of min Z' },
    name: { type: 'string', default: 'heightfield', desc: 'new field name' },
  },
  // relative paths read the scope's folder
  usesScope: true,
  signatureExtra: (p, scope) => scope.files.fileStamp(p.path),
  outputs: 'the layer (a new field also gets height and mask)',
  example: { type: 'heightfield_from_image', params: { path: 'terrain.png', size: [100, 100], height_min: 0, height_max: 25 } },
  async cook(ctx) {
    const { hasInput, input, p, scope, type } = ctx;
    if (!p.path) throw new NodeError(`${type}: path is empty`);
    checkName(p.layer, type);
    const bytes = await scope.files.readFile(p.path).catch((e: any) => { throw new NodeError(`${type}: cannot read "${p.path}": ${e.message}`); });
    let img;
    try { img = decodePNG(bytes); } catch (e: any) { throw new NodeError(`${type}: ${e.message}`); }
    const v = pngChannel(img, p.channel as PngChannel);
    const lo = p.height_min, hi = p.height_max;
    const iw = img.width, ih = img.height;
    const at = (fx: number, fz: number) => lo + (hi - lo) * bilinear(v, iw, ih, fx, p.flip_z ? ih - 1 - fz : fz);
    if (iw < 2 || ih < 2) throw new NodeError(`${type}: image is ${iw} × ${ih}; need at least 2 × 2 pixels`);
    // where the image lies in the world: pixel (0, 0) at x0, z0, pixels `cell` metres apart (a new field's grid)
    const cell = p.resolution > 0 ? p.resolution : p.size[0] / (iw - 1);
    if (!(cell > 0)) throw new NodeError(`${type}: size must be > 0`);
    const x0 = p.center[0] - ((iw - 1) * cell) / 2, z0 = p.center[2] - ((ih - 1) * cell) / 2;
    if (hasInput(0)) {
      const g = input(0).clone();
      let n = 0, missed = 0;
      const eps = 1e-6;
      for (let k = 0; k < g.volumes.length; k++) {
        const vol = g.volumes[k];
        if (!isHeightfield(vol)) continue;
        const hf = asHeightfield(vol);
        const out = hf.writable(p.layer);
        let inside = 0;
        for (let j = 0; j < hf.height; j++)
          for (let i = 0; i < hf.width; i++) {
            if (p.fit === 'field') { out[j * hf.width + i] = at((i / (hf.width - 1)) * (iw - 1), (j / (hf.height - 1)) * (ih - 1)); continue; }
            const fx = (hf.x(i) - x0) / cell, fz = (hf.z(j) - z0) / cell;
            if (fx < -eps || fz < -eps || fx > iw - 1 + eps || fz > ih - 1 + eps) continue;
            out[j * hf.width + i] = at(fx, fz);
            inside++;
          }
        if (p.fit !== 'field' && !inside) missed++;
        g.volumes[k] = hf;
        n++;
      }
      if (!n) throw new NodeError(`${type}: input has no heightfield`, NO_FIELD);
      const m = (x: number) => +x.toPrecision(6);
      if (missed) ctx.warn(`the image (${m((iw - 1) * cell)} × ${m((ih - 1) * cell)} m around ${m(p.center[0])}, ${m(p.center[2])}) does not overlap ${missed === n ? 'the heightfield' : `${missed} of ${n} heightfields`}; set size/center to where it lies, or fit field to stretch it over the field`);
      return g;
    }
    checkGrid(iw, ih, type);
    const hf = new Heightfield(iw, ih, cell, [x0, z0], undefined, p.name || 'heightfield');
    const out = new Float32Array(iw * ih);
    for (let j = 0; j < ih; j++) for (let i = 0; i < iw; i++) out[j * iw + i] = at(i, j) + (p.layer === 'height' ? p.center[1] : 0);
    hf.layers.set('height', p.layer === 'height' ? out : new Float32Array(iw * ih).fill(p.center[1]));
    hf.layers.set('mask', new Float32Array(iw * ih));
    if (p.layer !== 'height') hf.layers.set(p.layer, out);
    const g = new Geometry();
    g.volumes = [hf];
    return g;
  },
});

// ---------------------------------------------------------------- conversion

/** The input without its heightfields (other volumes, points and prims stay). */
function withoutFields(g: Geometry): Geometry {
  const r = g.clone();
  r.volumes = r.volumes.filter((v) => !isHeightfield(v));
  return r;
}

defineNode({
  type: 'heightfield_to_mesh',
  category: 'heightfield',
  summary: 'Convert heightfields to a quad grid mesh (height as Y) with layers as point attributes, N, uv and optional colours.',
  description: 'Houdini: HeightField Convert to polygons. Points are row-major like the layers (point = j × width + i at step 1), quads face +Y. Every layer becomes a point float attribute of the same name (mask, flow, sediment …) for attribute-driven shading, scattering or export. color writes Cd: mask (white → red), height (ramp), terrain (grass, rock on slopes, sand where sediment/debris settled, darker where water flows, snow on high flat ground, asphalt on a "path" layer).',
  aliases: ['heightfield_convert', 'hf_to_mesh', 'heightfield_to_polygons', 'convert_heightfield'],
  inputs: [{ name: 'heightfield', desc: 'geometry with heightfields' }],
  params: {
    step: { type: 'int', default: 1, min: 1, max: 64, desc: 'use every Nth sample (2 = a quarter of the quads)', aliases: ['decimate', 'lod'] },
    layers: { type: 'bool', default: true, desc: 'copy every layer to a point float attribute' },
    normals: { type: 'bool', default: true, desc: 'point N from the field gradient' },
    uv: { type: 'bool', default: true, desc: 'point uv 0..1 over the field (over its own extent: a tile gets its own 0..1)' },
    color: { type: 'enum', options: ['none', 'mask', 'height', 'terrain'], default: 'none', desc: 'point Cd from the layers' },
    keep_heightfield: { type: 'bool', default: false, desc: 'keep the heightfield volume alongside the mesh' },
  },
  outputs: 'quads; point N, uv, Cd and one float attribute per layer',
  example: { nodes: { hf: { type: 'heightfield' }, n: { type: 'heightfield_noise', in: ['hf'], params: { amplitude: 2 } }, m: { type: 'heightfield_to_mesh', in: ['n'], params: { color: 'terrain' } } }, output: 'm' },
  cook: ({ input, p, type }) => {
    const g = input(0);
    const hfs = heightfieldsOf(g);
    if (!hfs.length) throw new NodeError(`${type}: input has no heightfield`, NO_FIELD);
    const meshes = hfs.map((hf) => heightfieldToMesh(hf, { step: p.step, layers: p.layers, normals: p.normals, uv: p.uv, color: p.color }));
    const rest = p.keep_heightfield ? g.clone() : withoutFields(g);
    return rest.numPoints || rest.volumes.length ? Geometry.merge([rest, ...meshes]) : meshes.length === 1 ? meshes[0] : Geometry.merge(meshes);
  },
});

defineNode({
  type: 'heightfield_to_sdf',
  category: 'heightfield',
  summary: 'Turn a heightfield into an SDF volume (solid ground below the surface) for sdf_combine / sdf_to_mesh: caves, overhangs, closed terrain blocks.',
  description: 'Houdini: Convert HeightField to VDB (SDF). Distance = (y − h(x, z)) / sqrt(1 + |∇h|²), negative below the surface. closed caps the sides and the bottom (depth below the lowest point), so sdf_to_mesh gives a watertight terrain block; subtract SDF shapes from it to carve caves and overhangs.',
  aliases: ['heightfield_convert_sdf', 'hf_to_sdf', 'sdf_from_heightfield'],
  inputs: [{ name: 'heightfield', desc: 'geometry with heightfields' }],
  params: {
    depth: { type: 'float', default: 1, min: 0, desc: 'solid thickness below the field\'s lowest point (metres; that point depends on the field\'s extent, so tiles get their own bottoms)', aliases: ['thickness'] },
    closed: { type: 'bool', default: true, desc: 'cap the sides and the bottom (a finite block); false = an infinite slab clipped by the bounds' },
    keep_heightfield: { type: 'bool', default: false, desc: 'keep the heightfield volume' },
    name: { type: 'string', default: 'terrain_sdf', desc: 'SDF volume name' },
  },
  outputs: 'one SDF volume per heightfield',
  example: { nodes: { hf: { type: 'heightfield', params: { size: [10, 10], resolution: 0.1 } }, n: { type: 'heightfield_noise', in: ['hf'], params: { amplitude: 1.5 } }, s: { type: 'heightfield_to_sdf', in: ['n'] }, m: { type: 'sdf_to_mesh', in: ['s'], params: { divisions: 100 } } }, output: 'm' },
  cook: ({ input, p, type }) => {
    const g = input(0);
    const hfs = heightfieldsOf(g);
    if (!hfs.length) throw new NodeError(`${type}: input has no heightfield`, NO_FIELD);
    const out = p.keep_heightfield ? g.clone() : withoutFields(g);
    for (const hf of hfs) out.volumes.push(heightfieldSdf(hf, p.depth, p.closed, p.name || 'terrain_sdf'));
    return out;
  },
});

function heightfieldSdf(hf: Heightfield, depth: number, closed: boolean, name: string): SdfVolume {
  const H = hf.read('height'), W = hf.width, Hn = hf.height, c = hf.cellSize, inv = 1 / c;
  const x0 = hf.origin[0], z0 = hf.origin[1], x1 = x0 + hf.sizeX, z1 = z0 + hf.sizeZ;
  const st = layerStats(H)!;
  const bottom = st.min - depth;
  const sample = (x: number, y: number, z: number) => {
    let fx = (x - x0) * inv, fz = (z - z0) * inv;
    if (!(fx > 0)) fx = 0; else if (fx > W - 1) fx = W - 1;
    if (!(fz > 0)) fz = 0; else if (fz > Hn - 1) fz = Hn - 1;
    let i = Math.floor(fx), j = Math.floor(fz);
    if (i > W - 2) i = W - 2;
    if (j > Hn - 2) j = Hn - 2;
    const u = fx - i, v = fz - j, k = j * W + i;
    const h00 = H[k], h10 = H[k + 1], h01 = H[k + W], h11 = H[k + W + 1];
    const h = (h00 * (1 - u) + h10 * u) * (1 - v) + (h01 * (1 - u) + h11 * u) * v;
    const gx = ((h10 - h00) * (1 - v) + (h11 - h01) * v) * inv, gz = ((h01 - h00) * (1 - u) + (h11 - h10) * u) * inv;
    let d = (y - h) / Math.sqrt(1 + gx * gx + gz * gz);
    if (closed) d = Math.max(d, bottom - y, x0 - x, x - x1, z0 - z, z - z1);
    return d;
  };
  return { name, kind: 'sdf', bounds: { min: [x0, bottom, z0], max: [x1, st.max + c, z1] }, sample };
}

// ---------------------------------------------------------------- layer filters

defineNode({
  type: 'heightfield_remap',
  category: 'heightfield',
  summary: 'Remap a layer\'s values: fit an input range to an output range through a ramp (invert, shape heights or masks).',
  description: 'Houdini: HeightField Remap. t = (value − input_min) / (input_max − input_min), then value = output_min + ramp(t) × (output_max − output_min). The input range is absolute, so a tile remaps exactly like the same area of the whole map; auto_range uses the layer\'s own min/max instead, which depend on the field\'s extent (a tile or a cropped field remaps differently). A ramp like [[0,0],[0.5,0.2],[1,1]] flattens valleys and sharpens peaks.',
  aliases: ['hf_remap'],
  inputs: [{ name: 'heightfield', desc: 'geometry with a heightfield' }],
  params: {
    layer: layerParam(),
    input_min: { type: 'float', default: 0, desc: 'input value for t = 0 (e.g. the lowest height in metres)' },
    input_max: { type: 'float', default: 1, desc: 'input value for t = 1' },
    auto_range: { type: 'bool', default: false, desc: 'use the layer\'s own min/max as the input range instead (depends on the field\'s extent)' },
    output_min: { type: 'float', default: 0, desc: 'output for t = 0', aliases: ['min'] },
    output_max: { type: 'float', default: 1, desc: 'output for t = 1', aliases: ['max'] },
    ramp: { type: 'ramp', default: [[0, 0], [1, 1]], desc: 'shape: [[t, value], ...] with t and value 0..1' },
    clamp: { type: 'bool', default: true, desc: 'clamp t to 0..1 before the ramp' },
    mask_layer: maskParam(),
  },
  outputs: 'the layer',
  example: { nodes: { hf: { type: 'heightfield' }, n: { type: 'heightfield_noise', in: ['hf'], params: { amplitude: 3 } }, r: { type: 'heightfield_remap', in: ['n'], params: { input_min: -3, input_max: 3, output_min: 0, output_max: 6, ramp: [[0, 0], [0.6, 0.25], [1, 1]] } } }, output: 'r' },
  cook: (ctx) => {
    const { p } = ctx;
    return eachField(ctx, (hf) => {
      const a = layerOf(hf, p.layer, ctx.type);
      const st = p.auto_range ? layerStats(a)! : null;
      const lo = st ? st.min : p.input_min, hi = st ? st.max : p.input_max;
      const span = hi - lo;
      const mask = maskOf(hf, p.mask_layer, ctx.type);
      writeLayer(hf, p.layer, mask, (_k, old) => {
        let t = span !== 0 ? (old - lo) / span : 0;
        if (p.clamp) t = clamp01(t);
        const r = evalRamp(p.ramp, t);
        const rv = Array.isArray(r) ? Number(r[0]) : Number(r);
        return p.output_min + (Number.isFinite(rv) ? rv : t) * (p.output_max - p.output_min);
      });
    });
  },
});

const BLUR_PARAMS = (layer: string): Record<string, ParamDef> => ({
  layer: layerParam(layer, 'layer to blur'),
  radius: { type: 'float', default: 1, min: 0, desc: 'blur radius (metres)', aliases: ['size', 'distance'] },
  mode: { type: 'enum', options: ['gaussian', 'box'], default: 'gaussian', desc: 'gaussian (smooth, radius = 2 sigma) or box (flat average)', aliases: ['filter', 'type'] },
  iterations: { type: 'int', default: 1, min: 1, max: 50, desc: 'repeat the blur' },
  mask_layer: maskParam(),
});

function blurCook(ctx: CookContext) {
  const { p } = ctx;
  return eachField(ctx, (hf) => {
    const a = layerOf(hf, p.layer, ctx.type);
    const r = p.radius / hf.cellSize;
    if (r <= 0) return;
    const b = blurGrid(a, hf.width, hf.height, r, p.mode, p.iterations);
    writeLayer(hf, p.layer, maskOf(hf, p.mask_layer, ctx.type), (k) => b[k]);
  });
}

defineNode({
  type: 'heightfield_blur',
  category: 'heightfield',
  summary: 'Blur a heightfield layer (gaussian or box, radius in metres): soften terrain, smooth masks before scattering.',
  description: 'Houdini: HeightField Blur. Separable running-sum boxes (gaussian = three box passes), clamped at the borders, so any radius costs the same.',
  aliases: ['hf_blur', 'heightfield_smooth'],
  inputs: [{ name: 'heightfield', desc: 'geometry with a heightfield' }],
  params: BLUR_PARAMS('height'),
  outputs: 'the layer',
  example: { nodes: { hf: { type: 'heightfield' }, n: { type: 'heightfield_noise', in: ['hf'], params: { amplitude: 2, element_size: 1 } }, b: { type: 'heightfield_blur', in: ['n'], params: { radius: 0.5 } } }, output: 'b' },
  cook: blurCook,
});

defineNode({
  type: 'heightfield_mask_blur',
  category: 'heightfield',
  summary: 'Blur a mask layer (radius in metres): soft mask edges for blending and scattering.',
  description: 'Houdini: HeightField Blur on the mask layer. Same filter as heightfield_blur with layer "mask".',
  aliases: ['hf_mask_blur'],
  inputs: [{ name: 'heightfield', desc: 'geometry with a heightfield' }],
  params: BLUR_PARAMS('mask'),
  outputs: 'the mask layer',
  example: { nodes: { hf: { type: 'heightfield' }, m: { type: 'heightfield_mask_noise', in: ['hf'] }, b: { type: 'heightfield_mask_blur', in: ['m'], params: { radius: 0.5 } } }, output: 'b' },
  cook: blurCook,
});

defineNode({
  type: 'heightfield_terrace',
  category: 'heightfield',
  summary: 'Terrace a heightfield: quantise heights into flat steps at absolute levels (rice terraces, mesas, strata), with rounded risers.',
  description: 'Houdini: HeightField Terrace. levels step (default): terraces at base + n × step_height, absolute heights, so a tile gets the same levels as the whole map. levels range: steps equal terraces from range_min to range_max (also absolute). levels layer: steps terraces between the layer\'s own min and max, which depend on the field\'s extent (a tile or a cropped field gets other levels than the whole map). rounding 0 = flat steps with vertical risers, 1 = smooth S-shaped risers across the whole step.',
  aliases: ['hf_terrace'],
  inputs: [{ name: 'heightfield', desc: 'geometry with a heightfield' }],
  params: {
    layer: layerParam(),
    levels: { type: 'enum', options: ['step', 'range', 'layer'], default: 'step', desc: 'where the terraces sit: step = base + n × step_height; range = steps terraces from range_min to range_max; layer = steps terraces between the layer\'s own min and max (depends on the field\'s extent)', aliases: ['mode'] },
    step_height: { type: 'float', default: 1, min: 0, desc: 'levels step: terrace height (metres)', aliases: ['height', 'spacing'] },
    base: { type: 'float', default: 0, desc: 'levels step: the height of one terrace level (metres); the others are base ± n × step_height' },
    steps: { type: 'int', default: 8, min: 1, max: 1000, desc: 'levels range and layer: number of terraces', aliases: ['count'] },
    range_min: { type: 'float', default: 0, desc: 'levels range: height of the lowest terrace level (metres)' },
    range_max: { type: 'float', default: 10, desc: 'levels range: height the steps reach (metres)' },
    rounding: { type: 'float', default: 0.2, min: 0, max: 1, desc: 'riser width as a fraction of the step: 0 = sharp, 1 = smooth', aliases: ['smoothness', 'sharpness'] },
    mask_layer: maskParam(),
  },
  outputs: 'the layer',
  example: { nodes: { hf: { type: 'heightfield' }, n: { type: 'heightfield_noise', in: ['hf'], params: { amplitude: 3, range: 'positive' } }, t: { type: 'heightfield_terrace', in: ['n'], params: { step_height: 0.5, rounding: 0.3 } } }, output: 't' },
  cook: (ctx) => {
    const { p } = ctx;
    return eachField(ctx, (hf) => {
      const a = layerOf(hf, p.layer, ctx.type);
      let base: number, step: number;
      if (p.levels === 'layer') {
        const st = layerStats(a)!;
        base = st.min; step = (st.max - st.min) / p.steps;
      } else if (p.levels === 'range') {
        base = p.range_min; step = (p.range_max - p.range_min) / p.steps;
      } else {
        base = p.base; step = p.step_height;
      }
      if (!(step > 0)) {
        if (p.levels !== 'layer') ctx.warn(p.levels === 'range' ? `range_max (${p.range_max}) must be above range_min (${p.range_min}); the layer is unchanged` : 'step_height is 0; the layer is unchanged');
        return;
      }
      const w = p.rounding;
      writeLayer(hf, p.layer, maskOf(hf, p.mask_layer, ctx.type), (_k, old) => {
        const s = (old - base) / step, f = Math.floor(s), t = s - f;
        const tt = w <= 0 ? 0 : smoothstep(1 - w, 1, t);
        return base + (f + tt) * step;
      });
    });
  },
});

defineNode({
  type: 'heightfield_clip',
  category: 'heightfield',
  summary: 'Clamp a heightfield layer below and/or above a value (flat lake beds, plateaus, sea level).',
  description: 'Houdini: HeightField Clip.',
  aliases: ['hf_clip', 'heightfield_clamp'],
  inputs: [{ name: 'heightfield', desc: 'geometry with a heightfield' }],
  params: {
    layer: layerParam(),
    min: { type: 'float', default: 0, desc: 'lowest value kept (when clip_min)', aliases: ['low', 'floor'] },
    max: { type: 'float', default: 10, desc: 'highest value kept (when clip_max)', aliases: ['high', 'ceiling'] },
    clip_min: { type: 'bool', default: true, desc: 'raise values below min to min' },
    clip_max: { type: 'bool', default: true, desc: 'lower values above max to max' },
    mask_layer: maskParam(),
  },
  outputs: 'the layer',
  example: { nodes: { hf: { type: 'heightfield' }, n: { type: 'heightfield_noise', in: ['hf'], params: { amplitude: 3 } }, c: { type: 'heightfield_clip', in: ['n'], params: { min: -0.5, clip_max: false } } }, output: 'c' },
  cook: (ctx) => {
    const { p } = ctx;
    return eachField(ctx, (hf) => {
      layerOf(hf, p.layer, ctx.type);
      writeLayer(hf, p.layer, maskOf(hf, p.mask_layer, ctx.type), (_k, v) => {
        if (p.clip_min && v < p.min) v = p.min;
        if (p.clip_max && v > p.max) v = p.max;
        return v;
      });
    });
  },
});

defineNode({
  type: 'heightfield_cutout',
  category: 'heightfield',
  summary: 'Set a layer to a value outside a mask or outside a shape\'s footprint (cut terrain to a shape, flatten around a plot).',
  description: 'Houdini: HeightField Cutout by Object. With a shape connected (closed polygons, projected along Y), samples outside its footprint get `value`; without one, the mask layer decides (soft: result = value + (layer − value) × mask). invert cuts inside instead; feather softens the edge (metres). write_mask stores the keep-mask in a layer.',
  aliases: ['heightfield_cutoutbyobject', 'hf_cutout', 'heightfield_cut'],
  inputs: [{ name: 'heightfield', desc: 'geometry with a heightfield' }, { name: 'shape', desc: 'optional closed polygons whose footprint is kept', optional: true }],
  params: {
    layer: layerParam(),
    value: { type: 'float', default: 0, desc: 'value written outside', aliases: ['height'] },
    mask_layer: { type: 'string', default: 'mask', desc: 'mask that keeps the layer (when no shape is connected)' },
    invert: { type: 'bool', default: false, desc: 'cut inside the shape/mask instead' },
    feather: { type: 'float', default: 0, min: 0, desc: 'soft edge width (metres)', aliases: ['blend', 'falloff'] },
    write_mask: { type: 'string', default: '', desc: 'also store the keep-mask in this layer ("" = no)' },
  },
  outputs: 'the layer (and write_mask)',
  example: { nodes: { hf: { type: 'heightfield' }, n: { type: 'heightfield_noise', in: ['hf'], params: { amplitude: 2 } }, c: { type: 'circle', params: { radius: 8, plane: 'xz', segments: 48 } }, cut: { type: 'heightfield_cutout', in: ['n', 'c'], params: { value: -1, feather: 1 } } }, output: 'cut' },
  cook: (ctx) => {
    const { p, hasInput, input } = ctx;
    const shape = hasInput(1) ? input(1) : null;
    return eachField(ctx, (hf) => {
      layerOf(hf, p.layer, ctx.type);
      let m: Float64Array = new Float64Array(hf.count);
      if (shape) {
        let closed = 0;
        for (let k = 0; k < shape.numPrims; k++) closed += shape.primClosed[k];
        if (!closed) throw new NodeError(`${ctx.type}: the shape input has no polygons (close curves with fill or use polygons)`);
        rasterizeMesh(hf, shape, (k) => { m[k] = 1; });
      } else {
        const a = layerOf(hf, p.mask_layer, ctx.type);
        for (let k = 0; k < m.length; k++) m[k] = clamp01(a[k]);
      }
      if (p.feather > 0) m = blurGrid(m, hf.width, hf.height, p.feather / hf.cellSize, 'gaussian');
      if (p.invert) for (let k = 0; k < m.length; k++) m[k] = 1 - m[k];
      writeLayer(hf, p.layer, null, (k, old) => p.value + (old - p.value) * clamp01(m[k]));
      if (p.write_mask) { const wm = hf.writable(p.write_mask); for (let k = 0; k < wm.length; k++) wm[k] = clamp01(m[k]); }
    });
  },
});

defineNode({
  type: 'heightfield_layer',
  category: 'heightfield',
  summary: 'Layer operations: compute a layer from an expression over layers ("height * mask + 2"), copy, rename, delete or fill.',
  description: 'Houdini: HeightField Layer / Copy Layer / Layer Clear, plus a volume wrangle for heightfields. Expression variables: every layer by name (height, mask, flow …), value (the target layer\'s current value), x z (world position), i j (sample indices), u v (0..1 over the field), cell (cell size), b_<layer> = a layer of the heightfield in input 1 sampled at x, z, the graph vars by their bare name (a layer or sample variable of the same name comes first, with a warning), and all wrangle helpers (clamp fit smoothstep noise min max pow …). A body with "return" works too. Write expressions in x z (and layers) to get the same values on a tile as on the whole map: i j u v count from the field\'s own corner and extent.',
  aliases: ['heightfield_copylayer', 'heightfield_layerclear', 'hf_layer', 'heightfield_wrangle', 'heightfield_expr'],
  inputs: [{ name: 'heightfield', desc: 'geometry with a heightfield' }, { name: 'other', desc: 'optional second heightfield: its layers as b_<name>', optional: true }],
  params: {
    operation: { type: 'enum', options: ['expression', 'copy', 'rename', 'delete', 'fill'], default: 'expression', desc: 'expression: layer = expression; copy/rename: layer ← source; delete: remove layer; fill: layer = value', aliases: ['op', 'mode'] },
    layer: layerParam('height', 'target layer (created if missing)'),
    expression: { type: 'code', default: 'height', desc: 'JS expression per sample (or a body with return)', aliases: ['expr', 'code'] },
    source: { type: 'string', default: 'mask', desc: 'source layer for copy/rename' },
    value: { type: 'float', default: 0, desc: 'fill value' },
    mask_layer: maskParam(),
  },
  usesVars: (p) => (p.operation === 'expression' ? String(p.expression ?? '') : ''),
  outputs: 'the target layer',
  example: { nodes: { hf: { type: 'heightfield' }, n: { type: 'heightfield_noise', in: ['hf'], params: { amplitude: 2, range: 'positive' } }, l: { type: 'heightfield_layer', in: ['n'], params: { layer: 'snow', expression: 'smoothstep(1.2, 1.8, height)' } } }, output: 'l' },
  cook: (ctx) => {
    const { p, engine, vars, hasInput, input } = ctx;
    checkName(p.layer, ctx.type);
    const other = hasInput(1) ? heightfieldsOf(input(1))[0] ?? null : null;
    if (hasInput(1) && !other) throw new NodeError(`${ctx.type}: input 1 has no heightfield`, NO_FIELD);
    const hiddenVars = new Set<string>();
    const out = eachField(ctx, (hf) => {
      const mask = maskOf(hf, p.mask_layer, ctx.type);
      switch (p.operation) {
        case 'delete':
          if (p.layer === 'height') throw new NodeError(`${ctx.type}: the height layer cannot be deleted (fill it instead)`);
          hf.layers.delete(p.layer);
          return;
        case 'fill':
          writeLayer(hf, p.layer, mask, () => p.value);
          return;
        case 'copy': case 'rename': {
          const src = layerOf(hf, p.source, ctx.type);
          writeLayer(hf, p.layer, mask, (k) => src[k]);
          if (p.operation === 'rename' && p.source !== p.layer) {
            if (p.source === 'height') throw new NodeError(`${ctx.type}: the height layer cannot be renamed (copy it instead)`);
            hf.layers.delete(p.source);
          }
          return;
        }
      }
      const code = String(p.expression ?? '');
      if (!code.trim()) throw new NodeError(`${ctx.type}: expression is empty`);
      const ident = /^[A-Za-z_$][\w$]*$/;
      const used = (name: string) => new RegExp(`(^|[^\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(code);
      const reserved = new Set(['value', 'x', 'z', 'i', 'j', 'u', 'v', 'cell', 'vars', 'k']);
      const decl: string[] = [];
      const L: Record<string, Float32Array> = {}, B: Record<string, (x: number, z: number) => number> = {};
      for (const [name, a] of hf.layers) if (ident.test(name) && !reserved.has(name) && used(name)) { L[name] = a; decl.push(`const ${name} = __L[${JSON.stringify(name)}][k];`); }
      if (other) for (const [name, a] of other.layers) {
        const id = 'b_' + name;
        if (ident.test(id) && used(id)) { const o = other; B[name] = (x, z) => o.sampleArray(a, x, z); decl.push(`const ${id} = __B[${JSON.stringify(name)}](x, z);`); }
      }
      // the graph vars the expression names: constants around the per-sample function, so a layer or a sample
      // variable of the same name comes first (and the cook says so)
      const own = new Set([...reserved, ...Object.keys(L), ...Object.keys(B).map((n) => 'b_' + n)]);
      const varNames: string[] = [];
      for (const n of codeVarNames(code, vars)) {
        if (own.has(n)) hiddenVars.add(n);
        else varNames.push(n);
      }
      const body = /\breturn\b/.test(code) ? code : `return (${code});`;
      // run like a wrangle: the body is parsed on its own first (a complete function body cannot close the wrapper
      // it is pasted into, so nothing runs while compiling), and the whole layer is computed under the host's time
      // limit, which also covers async continuations and reading the message of whatever the code throws
      const syntax = engine.host.checkSyntax?.(`"use strict";${body}`);
      if (syntax) throw new NodeError(`${ctx.type}: expression syntax error: ${syntax.message}${code.includes('\n') ? ` (line ${syntax.line})` : ''}`);
      let make;
      try {
        make = engine.host.compile(`(function(__L, __B, __vars, __varsGuard){ "use strict"; ${codeVarDecl(varNames)}\nreturn function(k, i, j, x, z, u, v, cell, value){ ${decl.join(' ')}\n${body}\n}; })`);
      } catch (e: any) {
        throw new NodeError(`${ctx.type}: expression syntax error: ${e.message}`);
      }
      const f = make(L, B, codeVarValues(vars, varNames), scriptVarsGuard(engine.host));
      const old = hf.read(p.layer);
      const res = new Float32Array(hf.count);
      let bad = 0, failed: string | undefined;
      try {
        engine.host.runGuarded(() => {
          try {
            for (let j = 0; j < hf.height; j++)
              for (let i = 0; i < hf.width; i++) {
                const k = j * hf.width + i;
                const r = f(k, i, j, hf.x(i), hf.z(j), i / (hf.width - 1), j / (hf.height - 1), hf.cellSize, old[k]);
                const n = typeof r === 'number' ? r : typeof r === 'boolean' ? +r : NaN;
                if (!Number.isFinite(n)) { if (!bad && typeof r !== 'number') throw new Error(`expression returned ${Array.isArray(r) ? 'an array' : typeof r}, expected a number`); bad++; res[k] = 0; }
                else res[k] = n;
              }
          } catch (e: any) {
            try { const m = e?.message; failed = typeof m === 'string' ? m : String(e); } catch { failed = 'an exception that cannot be described'; }
          }
        }, engine.scriptTimeoutMs);
      } catch (e: any) {
        if (/timed out/i.test(String(e?.message))) throw new NodeError(`${ctx.type}: expression exceeded ${engine.scriptTimeoutMs} ms (infinite loop?)`);
        throw new NodeError(`${ctx.type}: ${e?.message ?? e}`);
      }
      if (failed !== undefined) {
        const missing = /^(\w+) is not defined$/.exec(failed);
        if (missing) throw new NodeError(`${ctx.type}: "${missing[1]}" is not a layer of this heightfield (layers: ${[...hf.layers.keys()].join(', ')}), a graph var or an expression variable`, 'Compute the layer upstream, or connect the heightfield that has it as input 1 and read it as b_' + missing[1] + '.');
        throw new NodeError(`${ctx.type}: ${failed}`);
      }
      if (bad) ctx.warn(`${bad} sample(s) gave NaN or infinity; written as 0`);
      writeLayer(hf, p.layer, mask, (k) => res[k]);
    });
    if (hiddenVars.size) {
      const n = [...hiddenVars].sort(), one = n.length === 1;
      ctx.warn(`${n.join(', ')} in the expression ${one ? 'is' : 'are'} this node's own (a layer or a sample variable), not the graph var${one ? '' : 's'} of that name; rename the var to read it here`);
    }
    return out;
  },
});

// ---------------------------------------------------------------- masks

defineNode({
  type: 'heightfield_mask_by_feature',
  category: 'heightfield',
  summary: 'Mask terrain by a feature: slope angle, height range, curvature (valleys/ridges), facing direction, flow, or ambient occlusion.',
  description: 'Houdini: HeightField Mask by Feature. Computes a 0..1 mask from one feature, shapes it with ramp, then combines it with the existing mask layer (mode). Chain several to combine features (mode multiply = and, max = or). slope: 1 between min_angle and max_angle, fading over angle_falloff degrees. height: absolute Y range. curvature: concave = valleys (the surface is below its blurred self by curvature_threshold), convex = ridges. direction: downhill facing, 0° = +X, 90° = +Z, within direction_spread. flow: a flow layer (from heightfield_erode) above min_flow. occlusion: horizon-based ambient occlusion over occlusion_radius (8-direction sweep), 1 = enclosed.',
  aliases: ['heightfield_maskbyfeature', 'hf_mask_by_feature', 'heightfield_mask_slope'],
  inputs: [{ name: 'heightfield', desc: 'geometry with a heightfield' }],
  params: {
    feature: { type: 'enum', options: ['slope', 'height', 'curvature', 'direction', 'flow', 'occlusion'], default: 'slope', desc: 'what to mask by' },
    layer: layerParam('mask', 'mask layer to write'),
    mode: { type: 'enum', options: COMBINE, default: 'replace', desc: 'combine with the existing mask', aliases: ['combine', 'operation'] },
    min_angle: { type: 'float', default: 30, min: 0, max: 90, desc: 'slope: lowest angle in the mask (degrees)', aliases: ['min_slope'] },
    max_angle: { type: 'float', default: 90, min: 0, max: 90, desc: 'slope: highest angle in the mask (degrees)', aliases: ['max_slope'] },
    angle_falloff: { type: 'float', default: 5, min: 0, desc: 'slope: soft edge (degrees)', aliases: ['slope_falloff'] },
    min_height: { type: 'float', default: 0, desc: 'height: lowest Y in the mask' },
    max_height: { type: 'float', default: 1000, desc: 'height: highest Y in the mask' },
    height_falloff: { type: 'float', default: 0.5, min: 0, desc: 'height: soft edge (metres)' },
    curvature_type: { type: 'enum', options: ['concave', 'convex'], default: 'concave', desc: 'curvature: concave = valleys and creases, convex = ridges and peaks' },
    curvature_radius: { type: 'float', default: 1, min: 0, desc: 'curvature: feature scale (metres)' },
    curvature_threshold: { type: 'float', default: 0.05, min: 0, desc: 'curvature: depth (metres) below/above the blurred surface for a full mask' },
    direction: { type: 'float', default: 0, desc: 'direction: downhill facing in degrees (0 = +X, 90 = +Z, 180 = −X, 270 = −Z)', aliases: ['facing', 'aspect'] },
    direction_spread: { type: 'float', default: 45, min: 0, max: 180, desc: 'direction: half-width of the facing band (degrees)' },
    flow_layer: { type: 'string', default: 'flow', desc: 'flow: layer to read' },
    min_flow: { type: 'float', default: 0.5, desc: 'flow: value where the mask starts (erode\'s flow: ~0.3 sheet flow, > 0.6 channels)' },
    flow_falloff: { type: 'float', default: 0.2, min: 0, desc: 'flow: soft edge above min_flow' },
    occlusion_radius: { type: 'float', default: 5, min: 0, desc: 'occlusion: how far to look for the horizon (metres)' },
    ramp: { type: 'ramp', default: [[0, 0], [1, 1]], desc: 'reshape the feature mask (0..1 → 0..1) before combining' },
    invert: { type: 'bool', default: false, desc: 'invert the feature mask' },
    blur: { type: 'float', default: 0, min: 0, desc: 'blur the feature mask (metres) before combining' },
  },
  outputs: 'the mask layer',
  example: { nodes: { hf: { type: 'heightfield' }, n: { type: 'heightfield_noise', in: ['hf'], params: { amplitude: 4, fractal: 'ridged', element_size: 6 } }, m: { type: 'heightfield_mask_by_feature', in: ['n'], params: { feature: 'slope', min_angle: 35 } } }, output: 'm' },
  cook: (ctx) => {
    const { p } = ctx;
    checkName(p.layer, ctx.type);
    return eachField(ctx, (hf) => {
      let m = featureMask(hf, p, ctx.type);
      if (p.blur > 0) m = Float32Array.from(blurGrid(m, hf.width, hf.height, p.blur / hf.cellSize, 'gaussian'));
      const linear = p.ramp.length === 2 && p.ramp[0].pos === 0 && p.ramp[0].value === 0 && p.ramp[1].pos === 1 && p.ramp[1].value === 1;
      for (let k = 0; k < m.length; k++) {
        let v = clamp01(m[k]);
        if (p.invert) v = 1 - v;
        if (!linear) { const r = evalRamp(p.ramp, v); v = clamp01(Array.isArray(r) ? Number(r[0]) : Number(r)); }
        m[k] = v;
      }
      writeLayer(hf, p.layer, null, (k, old) => clamp01(combine(p.mode, old, m[k])));
    });
  },
});

function band(v: number, lo: number, hi: number, fall: number): number {
  if (v < lo) return fall > 0 ? smoothstep(lo - fall, lo, v) : 0;
  if (v > hi) return fall > 0 ? 1 - smoothstep(hi, hi + fall, v) : 0;
  return 1;
}

function featureMask(hf: Heightfield, p: any, node: string): Float32Array {
  const H = layerOf(hf, 'height', node);
  const n = hf.count, out = new Float32Array(n);
  switch (p.feature) {
    case 'slope': {
      const s = slopeLayer(hf, H);
      for (let k = 0; k < n; k++) out[k] = band(s[k], p.min_angle, p.max_angle, p.angle_falloff);
      return out;
    }
    case 'height':
      for (let k = 0; k < n; k++) out[k] = band(H[k], p.min_height, p.max_height, p.height_falloff);
      return out;
    case 'curvature': {
      const b = blurGrid(H, hf.width, hf.height, Math.max(1, p.curvature_radius / hf.cellSize), 'gaussian');
      const t = Math.max(1e-9, p.curvature_threshold), sgn = p.curvature_type === 'convex' ? -1 : 1;
      for (let k = 0; k < n; k++) out[k] = clamp01((sgn * (b[k] - H[k])) / t);
      return out;
    }
    case 'direction': {
      const target = p.direction, spread = Math.max(1e-6, p.direction_spread);
      for (let j = 0; j < hf.height; j++)
        for (let i = 0; i < hf.width; i++) {
          const [gx, gz] = hf.gradient(i, j, H);
          const ang = (Math.atan2(-gz, -gx) * 180) / Math.PI;
          const d = Math.abs(((((ang - target) % 360) + 540) % 360) - 180);
          const flat = smoothstep(0, 0.035, Math.hypot(gx, gz)); // fades out below ~2°
          out[j * hf.width + i] = (1 - smoothstep(spread * 0.5, spread, d)) * flat;
        }
      return out;
    }
    case 'flow': {
      const f = layerOf(hf, p.flow_layer, node);
      for (let k = 0; k < n; k++) out[k] = p.flow_falloff > 0 ? smoothstep(p.min_flow, p.min_flow + p.flow_falloff, f[k]) : f[k] >= p.min_flow ? 1 : 0;
      return out;
    }
    case 'occlusion':
      return occlusion(hf, H, p.occlusion_radius);
  }
  throw new NodeError(`${node}: unknown feature "${p.feature}"`);
}

/** Horizon-based ambient occlusion: mean over 8 directions of sin(horizon elevation angle) within radius metres. */
function occlusion(hf: Heightfield, H: Float32Array, radius: number): Float32Array {
  const W = hf.width, Hn = hf.height, c = hf.cellSize, out = new Float32Array(W * Hn);
  const maxSteps = Math.max(1, Math.floor(radius / c));
  const stepsList: number[] = [];
  for (let s = 1; s <= maxSteps; s = Math.max(s + 1, Math.round(s * 1.35))) stepsList.push(s);
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  for (let j = 0; j < Hn; j++)
    for (let i = 0; i < W; i++) {
      const k = j * W + i, h0 = H[k];
      let sum = 0;
      for (const [dx, dz] of dirs) {
        const len = Math.hypot(dx, dz) * c;
        let best = 0;
        for (const s of stepsList) {
          const x = i + dx * s, z = j + dz * s;
          if (x < 0 || x >= W || z < 0 || z >= Hn) break;
          const t = (H[z * W + x] - h0) / (s * len);
          if (t > best) best = t;
        }
        sum += best / Math.sqrt(1 + best * best);
      }
      out[k] = sum / 8;
    }
  return out;
}

defineNode({
  type: 'heightfield_mask_by_object',
  category: 'heightfield',
  summary: 'Mask terrain by geometry: under a mesh\'s footprint, or within a distance of curves or points (roads, rivers, building plots).',
  description: 'Houdini: HeightField Mask by Object. footprint: samples under the polygons (projected along Y), grown by distance; distance: samples within distance of the curves/points (XZ). Both fade to 0 over falloff metres. Exact: polygons are rasterised onto the grid and curve segments measured per sample.',
  aliases: ['heightfield_maskbyobject', 'hf_mask_by_object'],
  inputs: [{ name: 'heightfield', desc: 'geometry with a heightfield' }, { name: 'object', desc: 'polygons, curves or points' }],
  params: {
    by: { type: 'enum', options: ['auto', 'footprint', 'distance'], default: 'auto', desc: 'auto = footprint for polygons, distance for curves and points', aliases: ['method', 'source'] },
    distance: { type: 'float', default: 1, min: 0, desc: 'full-mask distance from the curves/points, or growth of the footprint (metres)', aliases: ['radius', 'width'] },
    falloff: { type: 'float', default: 1, min: 0, desc: 'soft edge beyond distance (metres)' },
    layer: layerParam('mask', 'mask layer to write'),
    mode: { type: 'enum', options: COMBINE, default: 'replace', desc: 'combine with the existing mask', aliases: ['combine', 'operation'] },
    invert: { type: 'bool', default: false, desc: 'invert the object mask' },
  },
  outputs: 'the mask layer',
  example: { nodes: { hf: { type: 'heightfield' }, c: { type: 'curve', params: { points: [[-8, 0, -6], [0, 0, 2], [8, 0, 4]], smooth: true } }, m: { type: 'heightfield_mask_by_object', in: ['hf', 'c'], params: { distance: 1.5, falloff: 2 } } }, output: 'm' },
  cook: (ctx) => {
    const { p, input } = ctx;
    checkName(p.layer, ctx.type);
    const obj = input(1);
    let closed = 0;
    for (let k = 0; k < obj.numPrims; k++) closed += obj.primClosed[k];
    const by = p.by === 'auto' ? (closed ? 'footprint' : 'distance') : p.by;
    if (by === 'footprint' && !closed) throw new NodeError(`${ctx.type}: footprint needs polygons; the object input has none`, 'use by: "distance" for curves and points');
    if (!obj.numPoints) throw new NodeError(`${ctx.type}: the object input is empty`);
    return eachField(ctx, (hf) => {
      const m = objectMask(hf, obj, by, p.distance, p.falloff);
      writeLayer(hf, p.layer, null, (k, old) => clamp01(combine(p.mode, old, p.invert ? 1 - m[k] : m[k])));
    });
  },
});

/** 0..1 mask: footprint of polygons (grown by `dist`) or proximity to curves/points, fading over `fall` metres. */
function objectMask(hf: Heightfield, obj: Geometry, mode: string, dist: number, fall: number): Float32Array {
  const n = hf.count, m = new Float32Array(n);
  const weight = (d: number) => (d <= dist ? 1 : fall > 0 ? 1 - smoothstep(dist, dist + fall, d) : 0);
  if (mode === 'footprint') {
    const sites = new Uint8Array(n);
    rasterizeMesh(hf, obj, (k) => { sites[k] = 1; });
    const { dist: d } = distancesTo(sites, hf);
    for (let k = 0; k < n; k++) m[k] = d[k] === Infinity ? 0 : weight(d[k]);
    return m;
  }
  const best = new Float64Array(n).fill(Infinity);
  const r = dist + fall;
  const used = new Uint8Array(obj.numPoints);
  for (const c of curvesOf(obj)) {
    const pts = c.closed ? [...c.pts, c.pts[0]] : c.pts;
    for (let s = 0; s + 1 < pts.length; s++)
      splatSegment(hf, pts[s][0], pts[s][2], pts[s + 1][0], pts[s + 1][2], r, (k, d) => { if (d < best[k]) best[k] = d; });
  }
  for (let v = 0; v < obj.numVertices; v++) used[obj.vertexPoint[v]] = 1;
  const P = obj.P;
  for (let i = 0; i < obj.numPoints; i++) if (!used[i]) splatSegment(hf, P[i * 3], P[i * 3 + 2], P[i * 3], P[i * 3 + 2], r, (k, d) => { if (d < best[k]) best[k] = d; });
  for (let k = 0; k < n; k++) m[k] = best[k] === Infinity ? 0 : weight(best[k]);
  return m;
}

defineNode({
  type: 'heightfield_mask_expand',
  category: 'heightfield',
  summary: 'Grow (dilate) or shrink (erode) a mask by a distance in metres, with a soft edge.',
  description: 'Houdini: HeightField Mask Expand / Shrink. The mask is thresholded, an exact Euclidean distance transform measures the distance to the region, and the result fades over falloff. Growing keeps the original values inside (max), shrinking never adds (min).',
  aliases: ['heightfield_maskexpand', 'heightfield_mask_shrink', 'hf_mask_expand', 'heightfield_mask_dilate'],
  inputs: [{ name: 'heightfield', desc: 'geometry with a heightfield' }],
  params: {
    layer: layerParam('mask', 'mask layer'),
    distance: { type: 'float', default: 1, desc: 'grow (+) or shrink (−) distance (metres)', aliases: ['amount', 'radius'] },
    falloff: { type: 'float', default: 0.5, min: 0, desc: 'soft edge (metres)' },
    threshold: { type: 'float', default: 0.5, min: 0, max: 1, desc: 'mask values at or above this count as inside' },
  },
  outputs: 'the mask layer',
  example: { nodes: { hf: { type: 'heightfield' }, m: { type: 'heightfield_mask_noise', in: ['hf'], params: { contrast: 4 } }, e: { type: 'heightfield_mask_expand', in: ['m'], params: { distance: 0.5 } } }, output: 'e' },
  cook: (ctx) => {
    const { p } = ctx;
    return eachField(ctx, (hf) => {
      const a = layerOf(hf, p.layer, ctx.type);
      const grow = p.distance >= 0, r = Math.abs(p.distance);
      const sites = new Uint8Array(hf.count);
      for (let k = 0; k < sites.length; k++) sites[k] = (a[k] >= p.threshold) === grow ? 1 : 0;
      const { dist } = distancesTo(sites, hf);
      writeLayer(hf, p.layer, null, (k, old) => {
        const d = dist[k];
        if (grow) {
          const v = d <= r ? 1 : p.falloff > 0 && d !== Infinity ? 1 - smoothstep(r, r + p.falloff, d) : 0;
          return Math.max(old, v);
        }
        const v = d === Infinity ? 1 : d <= r ? 0 : p.falloff > 0 ? smoothstep(r, r + p.falloff, d) : 1;
        return Math.min(old, v);
      });
    });
  },
});

// ---------------------------------------------------------------- erosion

/** Accumulation → 0..1: log scale relative to the mean, saturating at the 99th percentile. */
function normalizeAccum(a: Float64Array | Float32Array): Float32Array {
  const n = a.length, out = new Float32Array(n);
  let sum = 0;
  for (let k = 0; k < n; k++) sum += a[k];
  if (!(sum > 0)) return out;
  const mean = sum / n;
  const sorted = Float64Array.from(a).sort();
  let top = sorted[Math.floor(0.99 * (n - 1))];
  if (!(top > 0)) top = sorted[n - 1];
  const den = Math.log1p(top / mean) || 1;
  for (let k = 0; k < n; k++) out[k] = Math.min(1, Math.log1p(Math.max(0, a[k]) / mean) / den);
  return out;
}

defineNode({
  type: 'heightfield_erode',
  category: 'heightfield',
  summary: 'Droplet or virtual-pipe hydraulic erosion with thermal talus relaxation and optional stream-power incision.',
  description: 'Houdini: HeightField Erode. method droplet (the default; backend js, or kernel for the same model in WASM): seeded droplets erode below their carrying capacity and deposit as they slow or dry; each iteration also relaxes slopes above thermal_talus_angle. Droplet settings are in metres, so the same params erode the same terrain alike at any spacing (an 8 m preview like the 2 m map, finer detail aside): rain_density counts droplets per m² per iteration, max_distance and erosion_radius are metres, and erosion_rate, deposition_rate, evaporation, inertia, gravity and thermal_rate act per droplet step of a third of erosion_radius, with sediment_capacity a volume in those steps cubed; the node converts them to the field\'s cells (a cell of a third of the radius takes them as given: the defaults at 0.1 m). For a terrain λ times larger keep the rest and multiply erosion_radius and max_distance by λ and divide rain_density by λ² (a 4 km map at 2 m: erosion_radius 6, max_distance 60, rain_density 0.005). Erosion is not local: droplets and water cross tile borders and start at seeded positions over the whole field, so a tile with a margin erodes like the same area of the map only statistically. Pipe uses four-direction shallow-water flux, velocity-based carrying capacity, sediment transport, rainfall and evaporation, with a CFL-limited timestep; stream_power adds K × drainage^m × slope^n incision. Pipe methods require backend kernel, or auto after the kernels have been loaded; their rates are per second, and their iterations are time steps that the cell size limits (CFL), so finer fields simulate less time per iteration unless time_step is below the limit of every spacing. Closed boundaries conserve terrain material. Open boundaries let water leave; droplet also loses carried sediment, while pipe retains sediment and settles it on return. Layers: height, nonnegative deposited sediment and thermal debris (added to existing layers), flow (0..1, normalised over the field: droplet on a log scale against its mean and 99th percentile, pipe by its maximum). Droplet water is a normalised resting-water mask; pipe water is remaining depth in metres. An existing lake layer supplies initial standing water to pipe/stream_power; lake is updated to the same final depth within its original footprint, while water includes every wet sample. Kernel backends also write cumulative wear (eroded depth). Pipe rainfall is uniform and deterministic; its seed is reserved for API consistency. Use flow/sediment/debris with heightfield_mask_by_feature or heightfield_to_mesh color terrain.',
  aliases: ['hf_erode', 'erosion', 'heightfield_erosion', 'heightfield_hydro_erode'],
  inputs: [{ name: 'heightfield', desc: 'geometry with a heightfield' }],
  params: {
    method: { type: 'enum', options: ['droplet', 'pipe', 'stream_power'], default: 'droplet', desc: 'droplet = seeded particles; pipe = shallow-water grid; stream_power = pipe plus drainage-driven incision' },
    backend: { type: 'enum', options: ['auto', 'kernel', 'js'], default: 'js', desc: 'js preserves the original droplet result; kernel loads WASM; auto uses WASM only if already loaded, otherwise js (pipe methods require WASM)' },
    iterations: { type: 'int', default: 50, min: 0, max: 5000, desc: 'rain passes; pipe methods use thermal_interval to schedule thermal passes', aliases: ['iter', 'steps'] },
    seed: P.seed(),
    erosion_rate: { type: 'float', default: 0.3, min: 0, max: 1, desc: 'droplet: fraction of the free capacity picked up per droplet step (a third of erosion_radius); pipe: erosion rate per second', aliases: ['erodability', 'erode_rate', 'erosion'] },
    deposition_rate: { type: 'float', default: 0.3, min: 0, max: 1, desc: 'droplet: fraction of the excess sediment dropped per droplet step; pipe: deposition rate per second', aliases: ['deposit_rate', 'deposition'] },
    sediment_capacity: { type: 'float', default: 1, min: 0, desc: 'how much sediment fast, steep water can carry (higher = deeper gullies, bigger fans); droplet: a volume in droplet steps cubed, the same in metres at any spacing', aliases: ['capacity'] },
    evaporation: { type: 'float', default: 0.1, min: 0, max: 1, desc: 'droplet: water fraction lost per droplet step; pipe: evaporation rate per second', aliases: ['evaporation_rate'] },
    rain_amount: { type: 'float', default: 1, min: 0, desc: 'water per droplet; pipe rainfall depth in metres per second, multiplied by rain_layer if set', aliases: ['rain', 'water_amount'] },
    rain_density: { type: 'float', default: 2, min: 0, desc: 'droplet only: droplets per square metre per iteration (at most one per sample: coarse fields cap it)', aliases: ['droplets'] },
    inertia: { type: 'float', default: 0.1, min: 0, max: 1, desc: 'droplet only: share of its heading a droplet keeps per droplet step; 0 = always steepest descent, higher = smoother, longer channels' },
    gravity: { type: 'float', default: 4, min: 0, desc: 'acceleration on slopes (droplet: speed² gained per droplet step of drop at slope 1; pipe: m/s²)' },
    min_slope: { type: 'float', default: 0.01, min: 0, desc: 'droplet only: minimum capacity (as a slope), keeps flats eroding a little' },
    erosion_radius: { type: 'float', default: 0.3, min: 0.001, desc: 'droplet only: erosion brush radius in metres (about a gully\'s half-width; at least one sample); a third of it is the droplet step the per-step settings refer to', aliases: ['brush_radius'] },
    max_distance: { type: 'float', default: 3, min: 0, desc: 'droplet only: how far a droplet travels at most (metres; at least one step)', aliases: ['travel_distance', 'droplet_distance'] },
    thermal_talus_angle: { type: 'float', default: 40, min: 0, max: 89, desc: 'thermal: angle of repose in degrees (steeper slopes shed material)', aliases: ['talus_angle', 'repose_angle', 'cut_angle'] },
    thermal_rate: { type: 'float', default: 0.1, min: 0, max: 1, desc: 'thermal: fraction of the excess moved per thermal pass (droplet: on cells of a droplet step, scaled to the spacing; 0 = no thermal erosion)', aliases: ['thermal'] },
    thermal_interval: { type: 'int', default: 1, min: 1, max: 10000, desc: 'pipe/stream_power only: thermal pass every N iterations and on the final iteration; skips intervening relaxations without multiplying thermal_rate (1 preserves the default result)' },
    hardness_layer: { type: 'string', default: '', desc: 'optional 0..1 layer: 1 = rock that does not erode' },
    freeze_layer: { type: 'string', default: '', desc: 'optional 0..1 layer: 1 = frozen (unchanged), e.g. under buildings or roads' },
    rain_layer: { type: 'string', default: '', desc: 'pipe only: optional nonnegative layer multiplying uniform rain_amount (0 = dry)' },
    time_step: { type: 'float', default: 0, min: 0, desc: 'pipe only: maximum timestep in seconds; 0 chooses it automatically from cell size, gravity and water velocity (CFL)' },
    stream_power_k: { type: 'float', default: 0.01, min: 0, desc: 'stream_power only: incision coefficient K in K × drainage^m × slope^n', aliases: ['incision_k'] },
    stream_power_m: { type: 'float', default: 0.5, min: 0, desc: 'stream_power only: exponent m of contributing drainage area', aliases: ['incision_m'] },
    stream_power_n: { type: 'float', default: 1, min: 0, desc: 'stream_power only: exponent n of downhill slope', aliases: ['incision_n'] },
    fill_sinks: { type: 'bool', default: false, desc: 'stream_power only: route incision over a depression-filled surface each iteration without raising the ground; fully hard/frozen cells stay protected' },
    boundary: { type: 'enum', options: ['closed', 'open'], default: 'closed', desc: 'closed: water remains inside (material conserved); open: water exits, carrying sediment for droplet, while pipe retains sediment' },
  },
  outputs: 'layers height, flow, sediment, debris, water; kernel backends also write wear',
  // Loading kernels changes auto's selected algorithm, so invalidate an earlier cached JS fallback.
  signatureExtra: p => p.backend === 'auto' ? (getLoadedKernels() ? 'kernel' : 'js') : '',
  example: { nodes: { hf: { type: 'heightfield', params: { size: [20, 20], resolution: 0.1 } }, n: { type: 'heightfield_noise', in: ['hf'], params: { fractal: 'ridged', amplitude: 4, element_size: 8, range: 'positive' } }, e: { type: 'heightfield_erode', in: ['n'], params: { iterations: 60 } } }, output: 'e' },
  cook: async (ctx) => {
    const { p } = ctx;
    let kernels: Kernels | undefined;
    if (p.backend === 'kernel') {
      try { kernels = await loadHostKernels(ctx.engine.host); }
      catch (error) { throw new NodeError(`${ctx.type}: kernel backend could not be loaded: ${error instanceof Error ? error.message : String(error)}`, 'Build or install kernels/pkg with npm run kernels:build, or use method droplet with backend js.'); }
    } else if (p.backend === 'auto') kernels = getLoadedKernels();
    if (p.method !== 'droplet' && !kernels)
      throw new NodeError(`${ctx.type}: method ${p.method} requires the kernel backend`, 'Set backend to kernel to load WASM; backend js supports only droplet, and auto requires kernels to be loaded already.');
    let droplets = 0;
    // the time limit of long-running nodes: checked every iteration of the JS path; a big kernel run goes to a pool
    // worker that the limit can stop
    const budget = simBudget(ctx, 'fewer iterations, a lower rain_density or max_distance, or a coarser field (heightfield_resample); or raise the limit');
    // droplet settings in metres; dropletParams converts them to the kernels' per-sample params for each field's cells
    const settings: DropletSettings = {
      rainDensity: p.rain_density, rainAmount: p.rain_amount, erosionRate: p.erosion_rate, depositionRate: p.deposition_rate,
      sedimentCapacity: p.sediment_capacity, evaporation: p.evaporation, inertia: p.inertia, gravity: p.gravity,
      minSlope: p.min_slope, erosionRadius: p.erosion_radius, maxDistance: p.max_distance,
      talusAngle: p.thermal_talus_angle, thermalRate: p.thermal_rate, boundary: p.boundary,
    };
    const m = (x: number) => +x.toPrecision(4);
    const out = await eachFieldAsync(ctx, async (hf) => {
      const H = layerOf(hf, 'height', ctx.type);
      const hard = maskOf(hf, p.hardness_layer, ctx.type), frz = maskOf(hf, p.freeze_layer, ctx.type);
      const { params, limited } = dropletParams(settings, hf.cellSize);
      if (p.method === 'droplet') {
        const c = hf.cellSize, on = `on "${hf.name}" (${m(c)} m cells)`;
        if (limited.radius) ctx.warn(`erosion_radius ${m(p.erosion_radius)} m is more than 64 samples ${on}: the brush uses 64 samples (${m(64 * c)} m)`);
        if (limited.steps) ctx.warn(`max_distance ${m(p.max_distance)} m is more than 4096 steps ${on}: droplets stop after ${m(4096 * c)} m`);
        if (limited.density) ctx.warn(`rain_density ${m(p.rain_density)} per m² is more than one droplet per sample ${on}: using one per sample (${m(1 / (c * c))} per m²)`);
        const work = hf.count * params.rainDensity * p.iterations * params.maxLifetime;
        if (work > 4e9) throw new NodeError(`${ctx.type}: ~${(work / 1e9).toFixed(1)}G droplet steps is too much; lower iterations, rain_density or max_distance, or resample the field`);
      }
      if (kernels) {
        const grid = { w: hf.width, h: hf.height, cell: hf.cellSize, seed: p.seed };
        const result: ErosionResult = await wasmCallUnderBudget(ctx, kernels, p.method === 'droplet'
          ? { fn: 'erode_droplet', ...grid, params: { ...params, talusAngle: p.thermal_talus_angle * Math.PI / 180, iterations: p.iterations } }
          : {
            fn: 'erode_pipe', ...grid, params: {
              iterations: p.iterations, rainAmount: p.rain_amount, evaporation: p.evaporation,
              sedimentCapacity: p.sediment_capacity, erosionRate: p.erosion_rate, depositionRate: p.deposition_rate,
              gravity: p.gravity, talusAngle: p.thermal_talus_angle * Math.PI / 180, thermalRate: p.thermal_rate, thermalInterval: p.thermal_interval,
              timeStep: p.time_step, boundary: p.boundary, streamPowerK: p.method === 'stream_power' ? p.stream_power_k : 0,
              streamPowerM: p.stream_power_m, streamPowerN: p.stream_power_n, fillSinks: p.method === 'stream_power' && p.fill_sinks,
            },
          },
        { height: H, hardness: hard, freeze: frz, rain: p.method === 'droplet' ? null : maskOf(hf, p.rain_layer, ctx.type), initialWater: p.method === 'droplet' ? null : hf.layer('lake') },
        hf.count * Math.max(1, p.iterations), WORKER_SAMPLE_ITERATIONS, budget);
        hf.layers.set('height', result.height);
        for (const name of ['sediment', 'debris', 'wear'] as const) {
          const prev = hf.layer(name), delta = result[name], out = new Float32Array(hf.count);
          for (let k = 0; k < out.length; k++) out[k] = Math.max(0, (prev ? prev[k] : 0) + delta[k]);
          hf.layers.set(name, out);
        }
        hf.layers.set('flow', p.method === 'droplet' ? normalizeAccum(result.flow) : result.flow);
        hf.layers.set('water', p.method === 'droplet' ? normalizeAccum(result.water) : result.water);
        if (p.method !== 'droplet' && hf.layer('lake')) {
          const previous = hf.layer('lake')!, lake = new Float32Array(hf.count);
          for (let k = 0; k < lake.length; k++) if (previous[k] > 0) lake[k] = result.water[k];
          hf.layers.set('lake', lake);
        }
        if (p.method === 'droplet') droplets += Math.round(params.rainDensity * hf.count) * p.iterations;
        return;
      }
      const field = makeErosionField(hf.width, hf.height, hf.cellSize, H, hard, frz);
      const r = rng(p.seed);
      // a stopped cook stops between iterations
      for (let it = 0; it < p.iterations; it++) { budget.check(); await ctx.checkpoint(); erodeStep(field, params, r); }
      droplets += Math.round(params.rainDensity * hf.count) * p.iterations;
      hf.layers.set('height', Float32Array.from(field.h));
      for (const [name, delta] of [['sediment', field.sediment], ['debris', field.debris]] as const) {
        const prev = hf.layer(name), o = new Float32Array(hf.count);
        for (let k = 0; k < o.length; k++) o[k] = Math.max(0, (prev ? prev[k] : 0) + delta[k]);
        hf.layers.set(name, o);
      }
      hf.layers.set('flow', normalizeAccum(field.flow));
      hf.layers.set('water', normalizeAccum(field.water));
    });
    ctx.stat('droplets', droplets);
    return out;
  },
});

defineNode({
  type: 'heightfield_fill_sinks',
  category: 'heightfield',
  summary: 'Fill closed terrain depressions for drainage, retaining deep lakes when requested.',
  description: 'Deterministic eight-neighbour priority flood (Barnes et al., 2014). Raises terrain to its lowest spill elevation so every unmasked cell has a route to the border; epsilon adds a minimum rise per receiver step so ordinary downhill flow can cross filled flats. With epsilon 0 the filled surface may be flat: use heightfield_flow fill_sinks to resolve its receivers. max_depth retains an entire connected depression when its deepest required fill exceeds the limit. Retained beds stay unchanged and lake stores standing-water depth in metres up to the spill surface, not a 0..1 mask; fill stores only actual added terrain thickness. Pipe and stream_power erosion use lake as initial water and update its depths inside the retained footprint; their water layer is the same depth quantity across the whole field. Droplet water remains a legacy normalised activity mask. A 0..1 mask_layer protects hard/frozen samples with value 1 as unchanged outlets; protected outlets and retained lakes are exceptions to border drainage. Loads the WASM kernel.',
  aliases: ['hf_fill_sinks'],
  inputs: [{ name: 'heightfield', desc: 'geometry with a height layer' }],
  params: {
    epsilon: { type: 'float', default: 0, min: 0, desc: 'minimum elevation rise in metres per receiver step; 0 fills to the spill level, positive values give strictly descending routes (at least one Float32 step)' },
    max_depth: { type: 'float', default: 0, min: 0, desc: 'retain whole connected depressions deeper than this many metres as lakes; 0 fills every depression' },
    mask_layer: { type: 'string', default: '', desc: 'optional 0..1 hardness/frozen layer: value 1 remains unchanged and acts as a drainage outlet; lower values may be filled' },
    write_fill: { type: 'bool', default: true, desc: 'write fill: actual added terrain thickness in metres, nonnegative' },
    write_lake: { type: 'bool', default: true, desc: 'write lake: retained standing-water depth in metres above the unchanged bed, zero outside lakes' },
  },
  outputs: 'filled height; optional fill and lake depth layers; other layers preserved',
  example: { nodes: { hf: { type: 'heightfield', params: { size: [8, 8], resolution: 0.5 } }, bowl: { type: 'heightfield_layer', in: ['hf'], params: { expression: 'min(2, (x*x + z*z) / 8)' } }, fill: { type: 'heightfield_fill_sinks', in: ['bowl'], params: { epsilon: 0.001 } } }, output: 'fill' },
  cook: async ctx => {
    let kernels: Kernels;
    try { kernels = await loadHostKernels(ctx.engine.host); }
    catch (error) { throw new NodeError(`${ctx.type}: kernel could not be loaded: ${error instanceof Error ? error.message : String(error)}`, 'Build or install kernels/pkg with npm run kernels:build.'); }
    const budget = simBudget(ctx, 'a coarser field (heightfield_resample), or raise the limit');
    return eachFieldAsync(ctx, async hf => {
      const result: FillSinksResult = await wasmCallUnderBudget(ctx, kernels, {
        fn: 'fill_sinks', w: hf.width, h: hf.height, options: { epsilon: ctx.p.epsilon, maxDepth: ctx.p.max_depth },
      }, { height: layerOf(hf, 'height', ctx.type), mask: maskOf(hf, ctx.p.mask_layer, ctx.type) }, hf.count, FLOOD_WORKER_SAMPLES, budget);
      hf.layers.set('height', result.height);
      if (ctx.p.write_fill) hf.layers.set('fill', result.fill);
      if (ctx.p.write_lake) hf.layers.set('lake', result.lake);
    });
  },
});

defineNode({
  type: 'heightfield_flow',
  category: 'heightfield',
  summary: 'Compute downhill drainage accumulation and flow direction for river masks.',
  description: 'Routes contributing cell area downhill without modifying height. D8 sends it to the steepest of eight neighbours; D-infinity splits flow between receivers on the steepest triangular facet. By default local minima retain drainage. fill_sinks routes over a priority-flood filled surface and resolves flats with stable receivers, without modifying the stored height or lake layers. The direction layer records the dominant receiver: E, SE, S, SW, W, NW, N, NE = 0..7, and 255 for a sink. Drainage is contributing area in square metres, ln(1 + area) with log_scale (the default), so thresholds are absolute; normalise divides by the field\'s largest value instead, which depends on the field\'s extent. Drainage only counts area inside the field: a tile sees rivers that enter it as starting at its border, so route the whole map (or a tile with a margin that holds the catchments) and crop. Loads the erosion WASM kernel.',
  aliases: ['hf_flow', 'heightfield_drainage'],
  inputs: [{ name: 'heightfield', desc: 'geometry with a height layer' }],
  params: {
    method: { type: 'enum', options: ['d8', 'dinf'], default: 'dinf', desc: 'D8 chooses one steepest receiver; D-infinity splits contributing area between two downslope receivers' },
    fill_sinks: { type: 'bool', default: false, desc: 'route over a priority-flood filled surface with stable flat receivers, preserving the original height; false leaves local minima as sinks' },
    normalise: { type: 'bool', default: false, desc: 'divide drainage by its largest value on the field (0..1, after log_scale); depends on the field\'s extent', aliases: ['normalize'] },
    log_scale: { type: 'bool', default: true, desc: 'write ln(1 + area in m²) to reveal small tributaries alongside main rivers' },
  },
  outputs: 'layers drainage and direction; all existing layers preserved',
  example: { nodes: { hf: { type: 'heightfield', params: { size: [20, 20], resolution: 0.5 } }, n: { type: 'heightfield_noise', in: ['hf'], params: { fractal: 'ridged', amplitude: 4 } }, f: { type: 'heightfield_flow', in: ['n'] } }, output: 'f' },
  cook: async (ctx) => {
    let kernels: Kernels;
    try { kernels = await loadHostKernels(ctx.engine.host); }
    catch (error) { throw new NodeError(`${ctx.type}: kernel could not be loaded: ${error instanceof Error ? error.message : String(error)}`, 'Build or install kernels/pkg with npm run kernels:build.'); }
    const budget = simBudget(ctx, 'a coarser field (heightfield_resample), or raise the limit');
    return eachFieldAsync(ctx, async hf => {
      const result: FlowAccumulationResult = await wasmCallUnderBudget(ctx, kernels, {
        fn: 'flow_accumulation', w: hf.width, h: hf.height, cell: hf.cellSize, method: ctx.p.method, fillSinks: ctx.p.fill_sinks,
      }, { height: layerOf(hf, 'height', ctx.type) }, hf.count, FLOOD_WORKER_SAMPLES, budget);
      const drainage = result.drainage;
      let maximum = 0;
      for (let k = 0; k < drainage.length; k++) {
        if (ctx.p.log_scale) drainage[k] = Math.log1p(drainage[k]);
        maximum = Math.max(maximum, drainage[k]);
      }
      if (ctx.p.normalise && maximum > 0) for (let k = 0; k < drainage.length; k++) drainage[k] /= maximum;
      hf.layers.set('drainage', drainage);
      hf.layers.set('direction', Float32Array.from(result.direction));
    });
  },
});

// ---------------------------------------------------------------- stamping, roads

defineNode({
  type: 'heightfield_project',
  category: 'heightfield',
  summary: 'Stamp meshes or curves onto a heightfield: replace, raise (max), lower (min), add or subtract, blended over a radius.',
  description: 'Houdini: HeightField Project. Polygons stamp the Y of their surface straight above/below each sample; open curves stamp their own height within width/2 of the curve. Outside the stamp the effect fades over radius metres towards the terrain (the nearest stamped height is used). level mean sets each connected polygon piece to the average terrain height under it instead of its own Y: building pads, plazas and car parks sit where cut and fill balance, so slopes get the smallest embankments. mask_layer stores the blend weight (e.g. to freeze it during erosion or to texture it).',
  aliases: ['hf_project', 'heightfield_stamp'],
  inputs: [{ name: 'heightfield', desc: 'geometry with a heightfield' }, { name: 'stamp', desc: 'polygons (plateaus, platforms, rocks) and/or curves (ridges, dykes)' }],
  params: {
    mode: { type: 'enum', options: ['replace', 'max', 'min', 'add', 'subtract'], default: 'replace', desc: 'replace = set to the stamp, max = only raise, min = only lower, add/subtract = add/remove the stamp height', aliases: ['combine', 'operation', 'method'] },
    layer: layerParam(),
    radius: { type: 'float', default: 1, min: 0, desc: 'blend distance outside the stamp (metres)', aliases: ['blend', 'falloff'] },
    offset: { type: 'float', default: 0, desc: 'added to the stamped height (metres)' },
    width: { type: 'float', default: 1, min: 0, desc: 'curves: stamp width (metres)' },
    direction: { type: 'enum', options: ['down', 'up'], default: 'down', desc: 'polygons: stamp the highest (down) or lowest (up) surface' },
    level: { type: 'enum', options: ['stamp', 'mean'], default: 'stamp', desc: 'polygons: stamp height = the polygon surface (stamp), or the mean terrain height under each connected piece (mean: building pads that balance cut and fill; offset still applies)', aliases: ['pad', 'flatten_to'] },
    mask_layer: { type: 'string', default: '', desc: 'store the stamp weight in this layer ("" = no)' },
  },
  outputs: 'the layer (and mask_layer)',
  example: { nodes: { hf: { type: 'heightfield' }, n: { type: 'heightfield_noise', in: ['hf'], params: { amplitude: 2 } }, b: { type: 'box', params: { size: [4, 1, 4], center: [3, 1.5, 0] } }, s: { type: 'heightfield_project', in: ['n', 'b'], params: { mode: 'replace', radius: 2 } } }, output: 's' },
  cook: (ctx) => {
    const { p, input } = ctx;
    checkName(p.layer, ctx.type);
    const st = input(1);
    let closed = 0;
    for (let k = 0; k < st.numPrims; k++) closed += st.primClosed[k];
    if (!st.numPrims) throw new NodeError(`${ctx.type}: the stamp input has no polygons or curves`);
    return eachField(ctx, (hf) => {
      const n = hf.count, up = p.direction === 'up';
      const SH = new Float64Array(n).fill(NaN), sites = new Uint8Array(n);
      const levelMean = p.level === 'mean' && closed > 0;
      const primPiece = levelMean ? connectivity(st).primClass : null, pieceOf = levelMean ? new Int32Array(n).fill(-1) : null;
      if (closed) rasterizeMesh(hf, st, (k, y, prim) => {
        if (!sites[k] || (up ? y < SH[k] : y > SH[k])) { SH[k] = y; if (pieceOf) pieceOf[k] = primPiece![prim]; }
        sites[k] = 1;
      });
      if (pieceOf) {
        // each piece at the mean of the terrain it covers (the layer before this stamp)
        const cur = hf.read(p.layer), sum = new Map<number, number>(), cnt = new Map<number, number>();
        for (let k = 0; k < n; k++) { const c = pieceOf[k]; if (c >= 0) { sum.set(c, (sum.get(c) ?? 0) + cur[k]); cnt.set(c, (cnt.get(c) ?? 0) + 1); } }
        for (let k = 0; k < n; k++) { const c = pieceOf[k]; if (c >= 0) SH[k] = sum.get(c)! / cnt.get(c)!; }
      }
      const best = new Float64Array(n).fill(Infinity);
      for (const c of curvesOf(st)) {
        if (c.closed) continue;
        for (let s = 0; s + 1 < c.pts.length; s++) {
          const a = c.pts[s], b = c.pts[s + 1];
          splatSegment(hf, a[0], a[2], b[0], b[2], p.width / 2, (k, d, t) => {
            if (sites[k] === 1 && best[k] === Infinity) return; // polygons win
            if (d < best[k]) { best[k] = d; SH[k] = a[1] + (b[1] - a[1]) * t; sites[k] = 2; }
          });
        }
      }
      let any = 0;
      for (let k = 0; k < n; k++) if (sites[k]) { any = 1; break; }
      if (!any) { ctx.warn(`stamp does not overlap heightfield "${hf.name}"`); return; }
      const { dist, nearest } = distancesTo(sites, hf);
      const W = new Float32Array(n), T = new Float64Array(n);
      for (let k = 0; k < n; k++) {
        const d = dist[k];
        W[k] = d === 0 ? 1 : p.radius > 0 ? 1 - smoothstep(0, p.radius, d) : 0;
        T[k] = (nearest[k] >= 0 ? SH[nearest[k]] : 0) + p.offset;
      }
      writeLayer(hf, p.layer, null, (k, v) => {
        const w = W[k];
        if (!w) return v;
        const t = T[k];
        const target = p.mode === 'max' ? Math.max(v, t) : p.mode === 'min' ? Math.min(v, t) : p.mode === 'add' ? v + t : p.mode === 'subtract' ? v - t : t;
        return v + (target - v) * w;
      });
      if (p.mask_layer) { const old = hf.read(p.mask_layer); const o = hf.writable(p.mask_layer); for (let k = 0; k < n; k++) o[k] = Math.max(old[k], W[k]); }
    });
  },
});

/** Resample a polyline at a fixed spacing; returns points and the arc length at each. */
function resamplePolyline(pts: number[][], step: number): number[][] {
  const out: number[][] = [pts[0].slice()];
  let carry = 0;
  for (let s = 0; s + 1 < pts.length; s++) {
    const a = pts[s], b = pts[s + 1];
    const L = Math.hypot(b[0] - a[0], b[2] - a[2]);
    if (L <= 0) continue;
    let t = step - carry;
    while (t <= L + 1e-12) {
      const u = t / L;
      out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u]);
      t += step;
    }
    carry = L - (t - step);
  }
  const last = pts[pts.length - 1], tail = out[out.length - 1];
  if (Math.hypot(last[0] - tail[0], last[2] - tail[2]) > step * 1e-3) out.push(last.slice());
  return out;
}

/** Moving average over a window of `win` samples (two passes ≈ triangle filter); wraps for closed loops. */
function smoothSeries(v: number[], win: number, closed: boolean): number[] {
  const n = v.length, r = Math.floor(win / 2);
  if (r < 1 || n < 3) return v.slice();
  let cur = v.slice();
  for (let pass = 0; pass < 2; pass++) {
    const next = new Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0, c = 0;
      for (let d = -r; d <= r; d++) {
        let j = i + d;
        if (closed) j = ((j % n) + n) % n;
        else if (j < 0 || j >= n) continue;
        s += cur[j]; c++;
      }
      next[i] = s / c;
    }
    cur = next;
  }
  return cur;
}

defineNode({
  type: 'heightfield_path',
  category: 'heightfield',
  summary: 'Cut a road or path along curves: flatten the terrain to a smooth profile across `width`, blend shoulders, bank in bends; writes a path mask.',
  description: 'Houdini: HeightField Project of a road profile / Path tools. The road height follows the terrain under the curve smoothed over `smooth` metres (height_mode terrain), or the curve\'s own Y (curve). Across the road the surface is flat (tilted by up to `bank` degrees in tight bends, outer edge up); beyond width/2 it blends back to the terrain over `shoulder` metres, cutting through hills and filling dips. mask_layer (default "path") marks the road surface for texturing, scattering exclusion or freezing erosion.',
  aliases: ['hf_path', 'heightfield_road', 'road_cut'],
  inputs: [{ name: 'heightfield', desc: 'geometry with a heightfield' }, { name: 'curves', desc: 'polylines (draw them flat at y = 0 for height_mode terrain)' }],
  params: {
    width: { type: 'float', default: 4, min: 0, desc: 'flat road width (metres)' },
    shoulder: { type: 'float', default: 2, min: 0, desc: 'blend distance from the road edge back to the terrain (metres)', aliases: ['falloff', 'blend', 'embankment'] },
    bank: { type: 'float', default: 0, min: 0, max: 45, desc: 'maximum bank angle in tight bends (degrees; full bank at a radius of 5 × width)', aliases: ['banking', 'superelevation'] },
    height_mode: { type: 'enum', options: ['terrain', 'curve'], default: 'terrain', desc: 'terrain: follow the ground under the curve (smoothed); curve: use the curve\'s Y' },
    smooth: { type: 'float', default: 5, min: 0, desc: 'smoothing of the road profile along the curve (metres)', aliases: ['smoothing', 'smooth_distance'] },
    offset: { type: 'float', default: 0, desc: 'raise (+) or sink (−) the road surface (metres)' },
    layer: layerParam(),
    mask_layer: { type: 'string', default: 'path', desc: 'layer marking the road surface ("" = no)' },
  },
  outputs: 'the layer and the mask layer ("path")',
  example: { nodes: { hf: { type: 'heightfield' }, n: { type: 'heightfield_noise', in: ['hf'], params: { amplitude: 2 } }, c: { type: 'curve', params: { points: [[-9, 0, -4], [-2, 0, 1], [4, 0, -1], [9, 0, 5]], smooth: true } }, r: { type: 'heightfield_path', in: ['n', 'c'], params: { width: 3, shoulder: 2 } } }, output: 'r' },
  cook: (ctx) => {
    const { p, input } = ctx;
    checkName(p.layer, ctx.type);
    const curves = curvesOf(input(1));
    if (!curves.length) throw new NodeError(`${ctx.type}: the curves input has no polylines`, 'draw the road with curve or line');
    const half = p.width / 2, reach = half + p.shoulder;
    return eachField(ctx, (hf) => {
      const H0 = layerOf(hf, p.layer, ctx.type);
      const n = hf.count, c = hf.cellSize;
      const bestD = new Float64Array(n).fill(Infinity), bestH = new Float64Array(n), core = new Float32Array(n);
      const step = Math.max(c * 0.5, 1e-3);
      for (const cv of curves) {
        const src = cv.closed ? [...cv.pts, cv.pts[0]] : cv.pts;
        const pts = resamplePolyline(src, step);
        const m = pts.length;
        if (m < 2) continue;
        const raw = pts.map((q) => (p.height_mode === 'curve' ? q[1] : hf.sampleArray(H0, q[0], q[2])));
        const win = Math.round(p.smooth / step);
        const hs = smoothSeries(raw, win, cv.closed);
        // signed curvature (1/m, + = turning left seen from above) for banking
        const tilt = new Array(m).fill(0);
        if (p.bank > 0) {
          const kap = pts.map((_, i) => {
            const a = pts[Math.max(0, i - 1)], b = pts[i], d = pts[Math.min(m - 1, i + 1)];
            const t1 = Math.atan2(b[2] - a[2], b[0] - a[0]), t2 = Math.atan2(d[2] - b[2], d[0] - b[0]);
            let da = t2 - t1;
            while (da > Math.PI) da -= 2 * Math.PI;
            while (da < -Math.PI) da += 2 * Math.PI;
            const ds = Math.hypot(d[0] - a[0], d[2] - a[2]) / 2 || step;
            // atan2(z, x) grows from +X towards +Z, which is clockwise seen from +Y: negate for counter-clockwise = left
            return -da / ds;
          });
          const ks = smoothSeries(kap, Math.max(3, win), cv.closed);
          const full = 1 / (5 * Math.max(p.width, 1e-3));
          for (let i = 0; i < m; i++) tilt[i] = Math.tan((p.bank * Math.PI) / 180) * Math.max(-1, Math.min(1, ks[i] / full));
        }
        for (let s = 0; s + 1 < m; s++) {
          const a = pts[s], b = pts[s + 1];
          splatSegment(hf, a[0], a[2], b[0], b[2], reach, (k, d, t, side) => {
            if (d >= bestD[k]) return;
            bestD[k] = d;
            // left turn (tilt > 0): the right side (side < 0) is the outer edge and goes up
            bestH[k] = hs[s] + (hs[s + 1] - hs[s]) * t - (tilt[s] + (tilt[s + 1] - tilt[s]) * t) * side + p.offset;
          });
        }
      }
      for (let k = 0; k < n; k++) {
        const d = bestD[k];
        core[k] = d === Infinity ? 0 : 1 - smoothstep(half - c * 0.5, half + c * 0.5, d);
      }
      writeLayer(hf, p.layer, null, (k, v) => {
        const d = bestD[k];
        if (d === Infinity) return v;
        const w = d <= half ? 1 : p.shoulder > 0 ? 1 - smoothstep(half, reach, d) : 0;
        return v + (bestH[k] - v) * w;
      });
      if (p.mask_layer) { const old = hf.read(p.mask_layer); const o = hf.writable(p.mask_layer); for (let k = 0; k < n; k++) o[k] = Math.max(old[k], core[k]); }
    });
  },
});

// ---------------------------------------------------------------- scatter

defineNode({
  type: 'heightfield_scatter',
  category: 'heightfield',
  summary: 'Scatter points on a heightfield by a mask layer\'s density: P on the surface, N from the slope (or straight up), height/slope/mask attributes, optional minimum distance. Feed copy_to_points.',
  description: 'Houdini: HeightField Scatter. Count = density × area weighted by the mask (or count). Candidates are drawn by the mask (seeded), then thinned to even blue-noise spacing with relax (weighted sample elimination, as scatter, in chunks on the worker pool). Points sit exactly on the field\'s surface: bilinear between the samples (default), or with sample unreal_triangles the surface of an Unreal Landscape imported from this field\'s heightmap (export png16/r16): each cell split along its (0,0)–(1,1) diagonal in heightmap index space, column = X, row = Z (row 0 = min Z), which is how the Landscape triangulates its quads (vertex (x, y) = (column, row), Unreal Y = our Z), so instance bases land on the Landscape exactly. The modes agree at the samples and along cell edges and differ inside a cell by up to a quarter of its twist |h00 + h11 − h10 − h01|. N and slope come from central differences over one cell of the same surface; mask stays bilinear (Unreal samples weightmaps as textures). Attributes: height (Y), slope (degrees), mask (the density layer value at the point). N is the surface normal, and copy_to_points aims a copy\'s +Z along N (Houdini convention), which lays a Y-up tree down: align upright writes orient = identity so trees, houses and posts stand as modelled, align slope writes an orient that turns +Y onto the normal so rocks and shrubs lean with the terrain (orient wins over N in copy_to_points; random yaw goes on top with copy_to_points rotate_attrib). min_distance keeps every pair of points at least that far apart in XZ (exact dart throwing over the drawn candidates, replacing relax): building lots that never overlap; the count can come out lower when the masked area is full. Points are drawn over the whole field (density is per m², but the seeded draw, relax and min_distance see every sample), so a tile gets other points than the same area of the whole map: scatter on the whole map and keep the points inside the tile when tiles must match.',
  aliases: ['hf_scatter', 'heightfield_scatter_points'],
  inputs: [{ name: 'heightfield', desc: 'geometry with a heightfield' }],
  params: {
    density: { type: 'float', default: 0.5, min: 0, desc: 'points per square metre at mask 1', aliases: ['density_per_m2'] },
    count: { type: 'int', default: 0, min: 0, max: 2000000, desc: 'exact number of points; > 0 overrides density', aliases: ['npts', 'points'] },
    mask_layer: { type: 'string', default: 'mask', desc: 'density layer (0..1); "" = uniform everywhere', aliases: ['mask', 'density_layer'] },
    relax: { type: 'bool', default: true, desc: 'even (blue-noise) spacing' },
    seed: P.seed(),
    keep_heightfield: { type: 'bool', default: false, desc: 'also keep the heightfield (default: points only)' },
    align: { type: 'enum', options: ['none', 'upright', 'slope'], default: 'none', desc: 'instance orientation for copy_to_points: none = only N (the surface normal; copy_to_points then aims a copy\'s +Z along it, the Houdini convention, which lays Y-up models down); upright = orient identity, models stand as authored (trees, buildings, posts); slope = orient turns a model\'s +Y onto the surface normal (rocks, shrubs leaning with the terrain). N stays the surface normal', aliases: ['orientation', 'upright'] },
    min_distance: { type: 'float', default: 0, min: 0, desc: 'exact minimum distance between points in XZ (metres; 0 = off), e.g. lot spacing so buildings never overlap; replaces relax, and the count can come out lower', aliases: ['mindist', 'min_dist', 'spacing'] },
    sample: {
      type: 'enum', options: ['bilinear', 'unreal_triangles'], default: 'bilinear', aliases: ['sampling', 'sample_mode'],
      desc: 'surface between samples: bilinear, or unreal_triangles = Unreal Landscape\'s triangles (each cell cut along its (0,0)–(1,1) diagonal in heightmap index space, column = X, row = Z), so points land exactly on a Landscape imported from this field\'s png16/r16 export',
    },
  },
  outputs: 'points: N, height, slope, mask; orient with align upright or slope',
  example: { nodes: { hf: { type: 'heightfield' }, n: { type: 'heightfield_noise', in: ['hf'], params: { amplitude: 3 } }, m: { type: 'heightfield_mask_by_feature', in: ['n'], params: { feature: 'slope', min_angle: 20 } }, s: { type: 'heightfield_scatter', in: ['m'], params: { density: 0.3 } } }, output: 's' },
  cook: async (ctx) => {
    const { p, input } = ctx;
    const g = input(0);
    const hfs = heightfieldsOf(g);
    if (!hfs.length) throw new NodeError(`${ctx.type}: input has no heightfield`, NO_FIELD);
    const parts: Geometry[] = [];
    const r = rng(p.seed + 0.5);
    for (const hf of hfs) {
      const mask = p.mask_layer ? layerOf(hf, p.mask_layer, ctx.type) : null;
      const W = hf.width, Hn = hf.height, c = hf.cellSize, n = hf.count;
      const cdf = new Float64Array(n);
      let total = 0;
      for (let j = 0; j < Hn; j++)
        for (let i = 0; i < W; i++) {
          const k = j * W + i;
          const area = c * c * (i === 0 || i === W - 1 ? 0.5 : 1) * (j === 0 || j === Hn - 1 ? 0.5 : 1);
          total += area * (mask ? clamp01(mask[k]) : 1);
          cdf[k] = total;
        }
      const count = p.count > 0 ? Math.round(p.count / hfs.length) : Math.round(p.density * total);
      if (!(total > 0) || count <= 0) { if (!(total > 0)) ctx.warn(`mask "${p.mask_layer}" is 0 everywhere on "${hf.name}"`); continue; }
      if (count > 2e6) throw new NodeError(`${ctx.type}: ${count.toLocaleString('en-US')} points is too many (max 2,000,000); lower density`);
      const md = Math.max(0, p.min_distance || 0);
      const ncand = md > 0 ? Math.min(Math.max(count * 8, 64), 8e6) : p.relax ? Math.min(count * 4, 8e6) : count;
      const pos = new Float64Array(ncand * 3);
      const x0 = hf.origin[0], z0 = hf.origin[1], x1 = x0 + hf.sizeX, z1 = z0 + hf.sizeZ;
      for (let q = 0; q < ncand; q++) {
        const t = r() * total;
        let lo = 0, hi = n - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] < t) lo = mid + 1; else hi = mid; }
        const i = lo % W, j = (lo - i) / W;
        pos[q * 3] = Math.min(x1, Math.max(x0, hf.x(i) + (r() - 0.5) * c));
        pos[q * 3 + 2] = Math.min(z1, Math.max(z0, hf.z(j) + (r() - 0.5) * c));
      }
      // candidates are drawn in mask-weighted random order, so greedy dart throwing over them keeps the density
      const keep = md > 0
        ? minDistanceSelect(pos, Int32Array.from({ length: ncand }, (_, i) => i), md, count)
        : p.relax && ncand > count
        ? await sampleEliminate(pos, count, Math.sqrt(total / (2 * Math.sqrt(3) * count)), undefined, ctx.parallelMap)
        : Int32Array.from({ length: Math.min(ncand, count) }, (_, i) => i);
      if (md > 0 && keep.length < count) ctx.warn(`min_distance ${md} m fits ${keep.length} of ${count} points on "${hf.name}"`);
      const np = keep.length;
      const out = new Geometry({ positions: new Float64Array(np * 3) });
      const Pd = out.P;
      const N = out.points.add('N', 'float', 3).data as Float64Array;
      const ha = out.points.add('height', 'float', 1).data as Float64Array;
      const sa = out.points.add('slope', 'float', 1).data as Float64Array;
      const ma = out.points.add('mask', 'float', 1).data as Float64Array;
      const OR = p.align === 'upright' || p.align === 'slope' ? (out.points.add('orient', 'float', 4).data as Float64Array) : null;
      // height, N and slope from the chosen surface (bilinear or Unreal's triangles); the mask always bilinear
      const H = hf.read('height'), e = c * 0.5, s = p.sample === 'unreal_triangles' ? 'unreal_triangles' : 'bilinear';
      keep.forEach((q, o) => {
        const x = pos[q * 3], z = pos[q * 3 + 2], y = hf.sampleArray(H, x, z, s);
        Pd[o * 3] = x; Pd[o * 3 + 1] = y; Pd[o * 3 + 2] = z;
        const gx = (hf.sampleArray(H, x + e, z, s) - hf.sampleArray(H, x - e, z, s)) / (2 * e);
        const gz = (hf.sampleArray(H, x, z + e, s) - hf.sampleArray(H, x, z - e, s)) / (2 * e);
        const l = Math.hypot(gx, 1, gz);
        N[o * 3] = -gx / l; N[o * 3 + 1] = 1 / l; N[o * 3 + 2] = -gz / l;
        if (OR) {
          // upright: identity; slope: the shortest rotation taking +Y onto N, q = normalise((Y × N), 1 + Y·N)
          if (p.align === 'upright') { OR[o * 4] = 0; OR[o * 4 + 1] = 0; OR[o * 4 + 2] = 0; OR[o * 4 + 3] = 1; }
          else {
            const nx = N[o * 3], ny = N[o * 3 + 1], nz = N[o * 3 + 2], ql = Math.hypot(nz, nx, 1 + ny);
            OR[o * 4] = nz / ql; OR[o * 4 + 1] = 0; OR[o * 4 + 2] = -nx / ql; OR[o * 4 + 3] = (1 + ny) / ql;
          }
        }
        ha[o] = y;
        sa[o] = (Math.atan(Math.hypot(gx, gz)) * 180) / Math.PI;
        ma[o] = mask ? hf.sampleArray(mask, x, z) : 1;
      });
      parts.push(out);
    }
    if (p.keep_heightfield) parts.unshift(g.clone());
    return parts.length ? (parts.length === 1 ? parts[0] : Geometry.merge(parts)) : new Geometry();
  },
});

// ---------------------------------------------------------------- resample, transform

defineNode({
  type: 'heightfield_resample',
  category: 'heightfield',
  summary: 'Change a heightfield\'s resolution over the same extent (all layers, bilinear; pre-blurred when shrinking), e.g. to an Unreal size like 505 × 505.',
  description: 'Houdini: HeightField Resample. Give the new cell size (resolution), exact sample counts (samples), or a factor on the sample count (2 = twice as many per side). The X extent is kept exactly; Z follows the new cell size. The new grid starts at the field\'s corner and its cell is the X extent divided evenly, so tiles of a map resample onto one shared grid only when the resolution divides each tile\'s extent (heightfield_crop tiles of equal size do); shrinking pre-blurs, which needs a margin at tile borders.',
  aliases: ['hf_resample', 'heightfield_resize'],
  inputs: [{ name: 'heightfield', desc: 'geometry with a heightfield' }],
  params: {
    resolution: { type: 'float', default: 0, min: 0, desc: 'new cell size (metres); 0 = use samples or factor', aliases: ['cell_size', 'grid_spacing'] },
    samples: { type: 'ivec2', default: [0, 0], min: 0, max: MAX_SAMPLES, desc: 'new sample counts [nx, nz]; nx > 1 overrides resolution (nz 0 = keep the extent)' },
    factor: { type: 'float', default: 1, min: 0.01, max: 16, desc: 'multiply the samples per side (when resolution and samples are 0)', aliases: ['scale'] },
  },
  outputs: 'all layers at the new resolution',
  example: { nodes: { hf: { type: 'heightfield', params: { size: [50, 50], resolution: 0.25 } }, r: { type: 'heightfield_resample', in: ['hf'], params: { samples: [253, 253] } } }, output: 'r' },
  cook: (ctx) => {
    const { p } = ctx;
    return eachField(ctx, (hf) => {
      let nw: number, cell: number;
      if (p.samples[0] > 1) { nw = p.samples[0]; cell = hf.sizeX / (nw - 1); }
      else if (p.resolution > 0) { nw = Math.max(2, Math.round(hf.sizeX / p.resolution) + 1); cell = hf.sizeX / (nw - 1); }
      else { nw = Math.max(2, Math.round((hf.width - 1) * p.factor) + 1); cell = hf.sizeX / (nw - 1); }
      const nh = p.samples[1] > 1 ? p.samples[1] : Math.max(2, Math.round(hf.sizeZ / cell) + 1);
      checkGrid(nw, nh, ctx.type);
      if (nw === hf.width && nh === hf.height) return;
      const out = new Heightfield(nw, nh, cell, hf.origin, undefined, hf.name);
      const ratio = cell / hf.cellSize;
      for (const [name, a] of hf.layers) {
        const src = ratio > 1.5 ? blurGrid(a, hf.width, hf.height, ratio, 'gaussian') : a;
        const b = new Float32Array(nw * nh);
        for (let j = 0; j < nh; j++)
          for (let i = 0; i < nw; i++) b[j * nw + i] = bilinear(src, hf.width, hf.height, (i * cell) / hf.cellSize, (j * cell) / hf.cellSize);
        out.layers.set(name, b);
      }
      return out;
    });
  },
});

/** Column-major affine matrix: about pivot, scale (s, sy, s), rotate about Y (degrees), then translate. */
function fieldMatrix(t: number[], s: number, sy: number, rotDeg: number, pv: number[]): Float64Array {
  const a = (rotDeg * Math.PI) / 180, c = Math.cos(a), sn = Math.sin(a);
  // R_y: x' = c x + s z, z' = -s x + c z
  const m = new Float64Array(16);
  m[0] = c * s; m[2] = -sn * s; m[8] = sn * s; m[10] = c * s; m[5] = sy; m[15] = 1;
  m[12] = pv[0] + t[0] - (m[0] * pv[0] + m[8] * pv[2]);
  m[13] = pv[1] + t[1] - sy * pv[1];
  m[14] = pv[2] + t[2] - (m[2] * pv[0] + m[10] * pv[2]);
  return m;
}

defineNode({
  type: 'heightfield_transform',
  category: 'heightfield',
  summary: 'Move, scale, raise or turn (by 90° steps) heightfields: translate X/Z moves the grid, Y raises the heights; scale resizes the cells.',
  description: 'Houdini: HeightField Transform. Heightfields stay axis-aligned grids: rotation snaps to multiples of 90°, scale is uniform in X/Z (it changes the cell size), height_scale multiplies heights about pivot Y. Scale and rotation turn about pivot, a world point, so the tiles of a map move together; pivot_at_center turns each field about its own centre instead. The generic transform node applies the same rules.',
  aliases: ['heightfield_xform', 'hf_transform', 'heightfield_move'],
  inputs: [{ name: 'heightfield', desc: 'geometry with a heightfield' }],
  params: {
    translate: { type: 'vec3', default: [0, 0, 0], desc: 'move: X/Z shift the grid, Y raises the height layer', aliases: ['t', 'move', 'offset'] },
    scale: { type: 'float', default: 1, min: 0.0001, desc: 'uniform X/Z scale of the grid (cell size × scale)', aliases: ['s', 'uniform_scale'] },
    height_scale: { type: 'float', default: 1, desc: 'multiply heights about pivot Y', aliases: ['scale_y', 'vertical_scale'] },
    rotate: { type: 'float', default: 0, desc: 'rotation about Y in degrees (snapped to 90° steps)', aliases: ['r', 'rot'] },
    pivot: { type: 'vec3', default: [0, 0, 0], desc: 'pivot for scale and rotation (X/Z ignored when pivot_at_center)' },
    pivot_at_center: { type: 'bool', default: false, desc: 'use the field\'s own centre as the X/Z pivot (depends on its extent: a tile turns about its own centre)' },
  },
  outputs: 'transformed heightfields',
  example: { nodes: { hf: { type: 'heightfield' }, n: { type: 'heightfield_noise', in: ['hf'] }, t: { type: 'heightfield_transform', in: ['n'], params: { translate: [20, 0, 0], height_scale: 2 } } }, output: 't' },
  cook: (ctx) => {
    const { p } = ctx;
    const snapped = Math.round(p.rotate / 90) * 90;
    if (Math.abs(snapped - p.rotate) > 1e-6) ctx.warn(`rotate ${p.rotate}° snapped to ${snapped}° (heightfields stay axis-aligned)`);
    return eachField(ctx, (hf) => {
      const c = hf.center;
      const pv = p.pivot_at_center ? [c[0], p.pivot[1], c[1]] : p.pivot;
      return transformHeightfield(hf, fieldMatrix(p.translate, p.scale, p.height_scale, snapped, pv));
    });
  },
});

// ---------------------------------------------------------------- crop

/** Inclusive sample range of tile t of n along an axis of `samples` samples: the cells split evenly, borders shared. */
function tileRange(samples: number, n: number, t: number): [number, number] {
  const cells = samples - 1;
  return [Math.floor((t * cells) / n), Math.floor(((t + 1) * cells) / n)];
}

defineNode({
  type: 'heightfield_crop',
  category: 'heightfield',
  summary: 'Crop heightfields (every layer) to world bounds or to one tile of a grid, with an optional margin; the samples stay exactly where they were (no resampling).',
  description: 'Cut a tile out of a whole map to preview or process it at full resolution, then build on the tile: nodes that work at world positions (noise, terrace, remap, masks by height or slope …) give the tile the same values as the same area of the map. mode tile: the field\'s cells are split evenly into tiles (nx, nz), tile (i, j) counting from min X / min Z, and neighbouring tiles share their border samples (as Unreal landscape tiles do). mode bounds: the samples covering min..max in X and Z (bounds between samples grow to the next sample; parts outside the field are dropped). margin keeps extra samples on every side (metres, rounded up to whole samples, or samples; less at the field\'s own border) for filters that read neighbours, such as blur, curvature, path and project. The crop is recorded in detail attributes: crop_core_min / crop_core_max (world X, Z of the tile or bounds without the margin: crop to them in mode bounds to drop the margin again), crop_margin (samples kept beyond the core on the −X, +X, −Z, +Z sides), crop_offset (the first sample\'s index in the input grid), crop_source_samples (the input\'s sample counts) and, in mode tile, crop_tile and crop_tiles (bounds mode keeps those of an earlier tile crop). With several heightfields each is cropped (tiles by its own grid) and the attributes describe the first. Other geometry passes through.',
  aliases: ['hf_crop', 'heightfield_tile', 'heightfield_cut_tile'],
  inputs: [{ name: 'heightfield', desc: 'geometry with a heightfield' }],
  params: {
    mode: { type: 'enum', options: ['tile', 'bounds'], default: 'tile', desc: 'tile = one tile of a tiles grid over the field; bounds = the samples covering min..max' },
    tiles: { type: 'ivec2', default: [2, 2], min: 1, max: 4096, desc: 'tile mode: number of tiles along X and Z', aliases: ['grid', 'tile_count'] },
    tile: { type: 'ivec2', default: [0, 0], min: 0, max: 4095, desc: 'tile mode: tile index [column along X, row along Z], counting from 0 at min X / min Z', aliases: ['index', 'tile_index'] },
    min: { type: 'vec2', default: [-5, -5], desc: 'bounds mode: world X and Z of the min corner (metres)', aliases: ['bounds_min'] },
    max: { type: 'vec2', default: [5, 5], desc: 'bounds mode: world X and Z of the max corner (metres)', aliases: ['bounds_max'] },
    margin: { type: 'float', default: 0, min: 0, desc: 'extra border kept on every side, in margin_unit (less at the field\'s own border): the reach of the filters that follow', aliases: ['padding', 'overlap'] },
    margin_unit: { type: 'enum', options: ['metres', 'samples'], default: 'metres', desc: 'margin in metres (rounded up to whole samples) or in samples', aliases: ['margin_units'] },
  },
  outputs: 'the cropped heightfields with all their layers; detail crop_core_min, crop_core_max, crop_margin, crop_offset, crop_source_samples (tile mode also crop_tile, crop_tiles)',
  example: {
    nodes: {
      map: { type: 'heightfield', params: { size: [40, 40], resolution: 0.25 } },
      tile: { type: 'heightfield_crop', in: ['map'], params: { tiles: [4, 4], tile: [1, 2], margin: 2 } },
      hills: { type: 'heightfield_noise', in: ['tile'], params: { amplitude: 3, element_size: 12 } },
      core: { type: 'heightfield_crop', in: ['hills'], params: { mode: 'bounds', min: [-10, 0], max: [0, 10] } },
    },
    output: 'core',
  },
  cook: (ctx) => {
    const { p, type } = ctx;
    const g = ctx.input(0).clone();
    const eps = 1e-6;
    let first: { i0: number; i1: number; j0: number; j1: number; c: number[]; hf: Heightfield } | null = null;
    for (let k = 0; k < g.volumes.length; k++) {
      const v = g.volumes[k];
      if (!isHeightfield(v)) continue;
      const hf = asHeightfield(v);
      // the core (tile or bounds) as inclusive sample ranges
      let i0: number, i1: number, j0: number, j1: number;
      if (p.mode === 'bounds') {
        if (!(p.max[0] > p.min[0] && p.max[1] > p.min[1])) throw new NodeError(`${type}: max [${p.max.join(', ')}] must be above min [${p.min.join(', ')}] in X and Z`);
        i0 = Math.max(0, Math.floor(hf.fx(p.min[0]) + eps)); i1 = Math.min(hf.width - 1, Math.ceil(hf.fx(p.max[0]) - eps));
        j0 = Math.max(0, Math.floor(hf.fz(p.min[1]) + eps)); j1 = Math.min(hf.height - 1, Math.ceil(hf.fz(p.max[1]) - eps));
        if (i1 - i0 < 1 || j1 - j0 < 1) {
          const b = hf.bounds, f = (x: number) => +x.toPrecision(6);
          throw new NodeError(`${type}: bounds [${p.min.join(', ')}] .. [${p.max.join(', ')}] cover ${i1 < i0 || j1 < j0 ? 'no' : 'fewer than 2 × 2'} samples of heightfield "${hf.name}"`, `the field spans X ${f(b.min[0])} .. ${f(b.max[0])}, Z ${f(b.min[2])} .. ${f(b.max[2])}`);
        }
      } else {
        const [nx, nz] = p.tiles as number[], [ti, tj] = p.tile as number[];
        if (nx > hf.width - 1 || nz > hf.height - 1) throw new NodeError(`${type}: tiles [${nx}, ${nz}] are more than the ${hf.width - 1} × ${hf.height - 1} cells of heightfield "${hf.name}"`, 'every tile needs at least one cell');
        if (ti >= nx || tj >= nz) throw new NodeError(`${type}: tile [${ti}, ${tj}] is outside the ${nx} × ${nz} tiles (indices count from 0)`);
        [i0, i1] = tileRange(hf.width, nx, ti);
        [j0, j1] = tileRange(hf.height, nz, tj);
      }
      const m = p.margin > 0 ? Math.ceil((p.margin_unit === 'samples' ? p.margin : p.margin / hf.cellSize) - eps) : 0;
      const c = [Math.max(0, i0 - m), Math.min(hf.width - 1, i1 + m), Math.max(0, j0 - m), Math.min(hf.height - 1, j1 + m)];
      g.volumes[k] = cropHeightfield(hf, c[0], c[1], c[2], c[3]);
      if (!first) first = { i0, i1, j0, j1, c, hf };
    }
    if (!first) throw new NodeError(`${type}: input has no heightfield`, NO_FIELD);
    const { i0, i1, j0, j1, c, hf } = first;
    g.detail.add('crop_core_min', 'float', 2).set(0, [hf.x(i0), hf.z(j0)]);
    g.detail.add('crop_core_max', 'float', 2).set(0, [hf.x(i1), hf.z(j1)]);
    g.detail.add('crop_margin', 'int', 4).set(0, [i0 - c[0], c[1] - i1, j0 - c[2], c[3] - j1]);
    g.detail.add('crop_offset', 'int', 2).set(0, [c[0], c[2]]);
    g.detail.add('crop_source_samples', 'int', 2).set(0, [hf.width, hf.height]);
    if (p.mode === 'tile') {
      g.detail.add('crop_tile', 'int', 2).set(0, p.tile);
      g.detail.add('crop_tiles', 'int', 2).set(0, p.tiles);
    }
    return g;
  },
});
