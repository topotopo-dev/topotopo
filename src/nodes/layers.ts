// tex_layers (category "texture"): a layer stack over a base. The base is the bake_material image (base colour, with
// roughness, metallic, coverage, texel size and island as layers); each layer is a mask expression with a colour (or a
// ramp), roughness, metallic and height. The stack writes base colour, normal (from the summed height in metres),
// occlusion-roughness-metallic and height together, on the covered texels only, and pads them from the islands at the
// end. The compose is core/layers.ts; the mask expressions are compiled once (identical texts once per cook) and run in
// chunks on the worker pool, all the expressions of a group of layers in one call (core/pixelexpr.ts).
import { Geometry } from '../core/geometry.ts';
import { Image, MAIN_LAYER, imagesOf, resizeLayer, toGrey, toRGBA } from '../core/image.ts';
import { COLOR_MODES, applyLayer, coveredIndices, finishStack, padMaps, startStack } from '../core/layers.ts';
import type { ColorLUT, ColorMode, LayerSource, LayerSpec, StackJobArgs, StackJobLayer } from '../core/layers.ts';
import type { TypedArray } from '../core/kernels.ts';
import { paddingMap } from '../core/bake.ts';
import { PixelExprError, PixelSyntaxError, bindableName, realmHelperNames, runPixelExprs, usesName } from '../core/pixelexpr.ts';
import { rampLUT } from '../core/texture.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import { didYouMean, evalRamp, parseColor } from '../graph/params.ts';
import { NAMED_BY_NODE, imageParam, nameParam, outName, source } from './texture.ts';

const FIELDS = ['name', 'mask', 'opacity', 'color', 'color_by', 'color_mode', 'roughness', 'roughness_offset', 'metallic', 'height', 'signed', 'image'];

/** The results of the expressions in flight at once (bytes): past it the layers are composed in groups. */
export const stackLimits = { resultBytes: 768e6 };

/** Cap on the names a hint lists. */
const listNames = (names: string[], max = 14) => names.slice(0, max).join(', ') + (names.length > max ? `, … ${names.length - max} more` : '');

interface ParsedLayer extends LayerSpec {
  mask: string;
  colorBy: string;
  /** an image the layer takes its colour (C), roughness and normal (its layers of those names) from, per texel */
  image: string | null;
}

/** The named masks param: [{name, mask}], each an expression; checked like layers. */
function parseMasks(raw: unknown): { name: string; mask: string; write: boolean }[] {
  if (raw === undefined || raw === null || (Array.isArray(raw) && !raw.length)) return [];
  if (!Array.isArray(raw)) throw new NodeError('tex_layers: masks must be a list of {"name", "mask"} objects', 'e.g. [{"name": "dust", "mask": "smoothstep(0.4, 0.8, top) * grain"}]; a layer then reads it as dust');
  const seen = new Set<string>();
  return raw.map((m, i) => {
    if (!m || typeof m !== 'object' || Array.isArray(m)) throw new NodeError(`tex_layers: mask ${i + 1} is not an object`, 'fields: name, mask');
    const o = m as Record<string, unknown>;
    for (const k of Object.keys(o)) if (k !== 'name' && k !== 'mask' && k !== 'write') throw new NodeError(`tex_layers: mask ${i + 1}: unknown field "${k}"`, 'fields: name, mask, write');
    if (o.write !== undefined && typeof o.write !== 'boolean') throw new NodeError(`tex_layers: mask ${show(o.name)}: write must be true or false`, 'write: false computes the mask for what follows without writing it to the masks image');
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    if (!bindableName(name, new Set(['k']))) throw new NodeError(`tex_layers: mask name ${show(o.name)} is not a name an expression can read`, 'letters, digits and _, not starting with a digit');
    if (seen.has(name)) throw new NodeError(`tex_layers: two masks are called "${name}"`, 'mask names must be unique');
    seen.add(name);
    if (typeof o.mask !== 'string' || !o.mask.trim()) throw new NodeError(`tex_layers: mask "${name}" has no expression`, 'e.g. {"name": "dust", "mask": "smoothstep(0.4, 0.8, top)"}');
    return { name, mask: o.mask, write: o.write !== false };
  });
}

const show = (v: unknown) => (typeof v === 'string' ? `"${v}"` : JSON.stringify(v));

/** One colour: "#rrggbb", a name, or [r, g, b]; null when it is none of these. */
function colorOf(v: unknown): [number, number, number] | null {
  if (typeof v === 'string') return parseColor(v);
  if (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x))) return [v[0], v[1], v[2]];
  return null;
}

/** A ramp [[t, colour], …] as a lookup table, or null when v is not a ramp (a single colour, or nothing like one). */
function rampOf(v: unknown, who: string): ColorLUT | null {
  if (!Array.isArray(v) || !v.length || !v.every((k) => Array.isArray(k) && k.length === 2 && typeof k[0] === 'number')) return null;
  const keys = (v as [number, unknown][]).map(([pos, c]) => {
    const col = colorOf(c);
    if (!col) throw new NodeError(`tex_layers: ${who}: color ${show(c)} is not a colour`, 'a colour is "#rrggbb", a name such as "orange", or [r, g, b] in 0..1; a ramp is [[0, "#5c2a14"], [1, "#9a4a20"]]');
    return { pos: pos as number, value: col };
  }).sort((a, b) => a.pos - b.pos);
  const { lut } = rampLUT((t) => evalRamp(keys, t) as number[], 1024);
  return { lut, n: 1024 };
}

function parseLayers(raw: unknown): ParsedLayer[] {
  if (raw === undefined || raw === null || (Array.isArray(raw) && !raw.length)) return [];
  if (!Array.isArray(raw)) throw new NodeError('tex_layers: layers must be a list of layer objects', 'e.g. [{"name": "dust", "mask": "smoothstep(0.4, 0.8, top)", "color": "#a69d8b", "roughness": 0.95}]');
  const seen = new Set<string>();
  return raw.map((l, i) => {
    if (!l || typeof l !== 'object' || Array.isArray(l)) throw new NodeError(`tex_layers: layer ${i + 1} is not an object`, `fields: ${FIELDS.join(', ')}`);
    const o = l as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    if (!name) throw new NodeError(`tex_layers: layer ${i + 1} has no name`, 'every layer needs a unique name');
    const who = `layer "${name}"`;
    if (seen.has(name)) throw new NodeError(`tex_layers: two layers are called "${name}"`, 'layer names must be unique');
    seen.add(name);
    for (const k of Object.keys(o)) {
      if (!FIELDS.includes(k)) {
        const near = didYouMean(k, FIELDS, 1);
        throw new NodeError(`tex_layers: ${who}: unknown field "${k}"`, `fields: ${FIELDS.join(', ')}${near.length ? `; did you mean "${near[0]}"?` : ''}`);
      }
    }
    if (typeof o.mask !== 'string' || !o.mask.trim()) throw new NodeError(`tex_layers: ${who} has no mask`, 'mask is an expression over the mask images, e.g. "smoothstep(0.3, 0.6, ao)" or just a layer name');
    const num = (field: string, def: number, lo = -Infinity, hi = Infinity): number => {
      const v = o[field];
      if (v === undefined) return def;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw new NodeError(`tex_layers: ${who}: ${field} ${show(v)} is not a number${hi !== Infinity ? ` in ${lo}..${hi}` : ''}`);
      return v;
    };
    const orNull = (field: string): number | null => (o[field] === undefined || o[field] === null ? null : num(field, 0, 0, 1));
    const mode = o.color_mode === undefined ? 'normal' : o.color_mode;
    if (typeof mode !== 'string' || !(COLOR_MODES as readonly string[]).includes(mode)) throw new NodeError(`tex_layers: ${who}: color_mode ${show(mode)} is not one of ${COLOR_MODES.join(', ')}`);
    if (o.signed !== undefined && typeof o.signed !== 'boolean') throw new NodeError(`tex_layers: ${who}: signed must be true or false`);
    let color: LayerSpec['color'] = null;
    if (o.color !== undefined && o.color !== null) {
      color = rampOf(o.color, who) ?? colorOf(o.color);
      if (!color) throw new NodeError(`tex_layers: ${who}: color ${show(o.color)} is not a colour`, 'a colour is "#rrggbb", a name such as "orange", or [r, g, b] in 0..1; a ramp is [[0, "#5c2a14"], [1, "#9a4a20"]]');
    }
    const colorBy = o.color_by === undefined ? '0' : o.color_by;
    if (typeof colorBy !== 'string' || !colorBy.trim()) throw new NodeError(`tex_layers: ${who}: color_by must be an expression`, 'e.g. "grain" or "0.5"');
    if (o.image !== undefined && o.image !== null && (typeof o.image !== 'string' || !o.image.trim())) throw new NodeError(`tex_layers: ${who}: image must name an image`, 'the name of an image in input 1 (e.g. a bake_triplanar result): the layer takes its colour from C, its roughness and normal from its layers of those names');
    if (o.image && o.color !== undefined && o.color !== null) throw new NodeError(`tex_layers: ${who} has both color and image`, 'a layer takes its colour from one of them');
    return {
      image: typeof o.image === 'string' ? o.image.trim() : null,
      name, mask: o.mask, colorBy, color, mode: mode as ColorMode, opacity: num('opacity', 1, 0, 1),
      roughness: orNull('roughness'), roughnessOffset: num('roughness_offset', 0), metallic: orNull('metallic'), height: num('height', 0), signed: o.signed === true,
    };
  });
}

/** The expression text of the params, so a graph var the code names keys the node's cache. */
function expressionText(p: Record<string, any>): string {
  const parts: string[] = [String(p.occlusion ?? '')];
  if (Array.isArray(p.layers)) for (const l of p.layers) if (l && typeof l === 'object') parts.push(String((l as any).mask ?? ''), String((l as any).color_by ?? ''));
  if (Array.isArray(p.masks)) for (const m of p.masks) if (m && typeof m === 'object') parts.push(String((m as any).mask ?? ''));
  return parts.join('\n');
}

/** A layer of an image an expression can read: the layer as grey (luminance for colour), or one channel of a colour layer. */
interface Entry { img: Image; layer: string; ch: -1 | 0 | 1 | 2 | 3 }

/**
 * Results of earlier cooks, kept for the next: an expression's values over the covered texels, a variable's grey copy
 * of an image layer and a padded mask, each keyed by what it is made from (the expression, the identity of the arrays
 * it reads, the graph vars it reads, the coverage). Moving one slider then evaluates only the expressions that read
 * it, and what they feed. Arrays are never written once kept. Within the budget, what the latest cooks used stays:
 * entries of older cooks go first, and a cook that does not fit keeps what it made first (the named masks the rest
 * read).
 */
export const stackMemoLimits = { bytes: 2 * 1024 * 1024 * 1024 };
interface MemoEntry { value: Float32Array; gen: number; bad: number; hidden: string[] }
const stackMemo = new Map<string, MemoEntry>();
let stackMemoBytes = 0, stackMemoGen = 0;
const arrayIds = new WeakMap<object, number>();
let nextArrayId = 1;
const idOf = (a: object): number => { let i = arrayIds.get(a); if (i === undefined) { i = nextArrayId++; arrayIds.set(a, i); } return i; };
/** what a coverage layer gives every cook: its covered texels (shared memory when there is any) and padding maps */
interface CoverageInfo { covered: Uint32Array; mask: Uint8Array | null; padding: Map<number, Int32Array> }
const coverageInfo = new WeakMap<object, CoverageInfo>();
const fullCoverage = new Map<number, CoverageInfo>();
const inShared = (bytes: number) => (typeof SharedArrayBuffer !== 'undefined' ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes));
function coverageOf(coverage: Float32Array | null, n: number): CoverageInfo {
  let c = coverage ? coverageInfo.get(coverage) : fullCoverage.get(n);
  if (c) return c;
  const idx = coveredIndices(coverage, n), covered = new Uint32Array(inShared(idx.byteLength));
  covered.set(idx);
  let mask: Uint8Array | null = null;
  if (coverage) { mask = new Uint8Array(n); for (let q = 0; q < covered.length; q++) mask[covered[q]] = 1; }
  c = { covered, mask, padding: new Map() };
  if (coverage) coverageInfo.set(coverage, c);
  else { fullCoverage.clear(); fullCoverage.set(n, c); }
  return c;
}
const texelOf = new WeakMap<object, { u: Float32Array; v: Float32Array }>();
/** a read-only array in shared memory: itself, or a copy kept as long as the array lives (the workers read it without a copy per cook) */
const sharedCopies = new WeakMap<object, TypedArray>();
function sharedOf<T extends TypedArray>(a: T): T {
  if (typeof SharedArrayBuffer === 'undefined' || a.buffer instanceof SharedArrayBuffer) return a;
  let c = sharedCopies.get(a) as T | undefined;
  if (!c) { c = new (a.constructor as any)(new SharedArrayBuffer(a.byteLength)) as T; c.set(a as any); sharedCopies.set(a, c); }
  return c;
}

function memoGet(key: string, gen: number): MemoEntry | undefined {
  const e = stackMemo.get(key);
  if (e) { e.gen = gen; stackMemo.delete(key); stackMemo.set(key, e); }
  return e;
}
function memoPut(key: string, gen: number, value: Float32Array, bad = 0, hidden: string[] = []): void {
  const bytes = value.byteLength;
  if (bytes > stackMemoLimits.bytes) return;
  if (stackMemoBytes + bytes > stackMemoLimits.bytes) {
    for (const [k, e] of stackMemo) {
      if (stackMemoBytes + bytes <= stackMemoLimits.bytes) break;
      if (e.gen >= gen) continue;
      stackMemo.delete(k); stackMemoBytes -= e.value.byteLength;
    }
    if (stackMemoBytes + bytes > stackMemoLimits.bytes) return;
  }
  const had = stackMemo.get(key);
  if (had) stackMemoBytes -= had.value.byteLength;
  stackMemo.set(key, { value, gen, bad, hidden });
  stackMemoBytes += bytes;
}

defineNode({
  type: 'tex_layers',
  category: 'texture',
  usesNodeName: NAMED_BY_NODE,
  renamed: Object.fromEntries(['size', 'texture_size', 'world_size'].map((k) => [k, 'the base image carries its size now: a bake writes it, a generator sets it with texture_size, and without a texel layer this node reads it from the base (inspect shows it)'])),
  summary: 'A layer stack over a base: each layer is a mask expression with a colour or ramp, roughness, metallic and height; writes base colour, normal, ORM and height together on the covered texels, then pads.',
  description:
    'Input 0 is the base: an image whose C is the base colour and whose layers "roughness" and "metallic" hold the base values ' +
    '(bake_material gives exactly this), or any colour image with base_roughness / base_metallic set; its layer "mask" is the ' +
    'coverage (coverage param), its layers "texel" (metres per texel along u and v) and "island" give the normal map its slopes and ' +
    'keep it on one island. Input 1 holds the mask images (merge the bakes). A layer\'s mask is an expression over the ' +
    'layers of the images in both inputs: an image\'s main layer is a variable named like the image, each other layer ' +
    '<image>_<layer> (an image "edges" with layers convex and concave gives edges, edges_convex, edges_concave; the base ' +
    'image\'s own layers too: base_kind_painted_metal); a grey layer is its value, a colour layer its luminance and its channels ' +
    '<name>_r, <name>_g, <name>_b, <name>_a; the wrangle helpers (smoothstep, fit, clamp, min, max, pow …) and the graph vars are ' +
    'there, and a bare layer name is an expression too. Layer names that are no identifier cannot be read: a warning lists them. ' +
    'A name two layers share is an error only where an expression uses it, as is an image called like a helper function ' +
    '(noise, fit …). Layers run bottom to top; a = clamp(mask, 0, 1) × opacity. color is "#rrggbb", a name, [r, g, b] or a ramp ' +
    '[[t, colour], …] read at the expression color_by (0..1; a noise image for varied rust); color_mode normal replaces, multiply ' +
    'darkens by the colour, overlay overlays it, lighten keeps the lighter of the two (a fade toward a pale colour). ' +
    'roughness and metallic replace the values below where the mask is, roughness_offset adds to roughness (clamped to 0..1 after ' +
    'every layer); height is metres added where the mask is (negative = a step down: chips). A layer with signed true reads its ' +
    'mask as -1..1 for roughness_offset and height alone (one mask makes both bumps and dents, rougher and smoother). The normal ' +
    'map is made from the summed height at the texel size of every texel (the base\'s "texel" layer; without one, the metres ' +
    'the base image covers: its size, which a bake writes and a generator sets with texture_size), so a 0.15 mm step has the same slope at 1024 and ' +
    '2048 and on a non-square image, and a texel only reads neighbours of its own island, so a chip never leaves a ridge on the island ' +
    'next to it. Only covered texels are composed and expressions run on them only, so nothing a mask holds outside the islands ' +
    'reaches the maps; at the end every map is padded from the covered texels by padding texels (a neutral value beyond). Mask images of ' +
    'another size than the base are resized, with a warning. Expressions are compiled once per distinct text and run in chunks on ' +
    'the worker pool for large images (code that reads globalThis, this or geometry functions runs in one piece), with identical results ' +
    'without it. Outputs: images <name>_base_color, <name>_normal, <name>_orm (R occlusion, G roughness, B metallic) and ' +
    '<name>_height (metres), each keeping the coverage as layer "mask"; texture_to_material makes a material of the first three.',
  aliases: ['layers', 'material_layers', 'texture_layers', 'layer_stack'],
  inputs: [
    { name: 'base', desc: 'the base: colour in C, layers roughness, metallic, texel, island and mask (bake_material)' },
    { name: 'masks', desc: 'geometry holding the images the mask expressions name (merge the bake outputs)', optional: true },
  ],
  params: {
    layers: { type: 'json', default: [], desc: 'the layers, bottom to top: [{"name": "dust", "mask": "smoothstep(0.4, 0.8, top)", "opacity": 1, "color": "#a69d8b" | [r, g, b] | [[0, "#5c2a14"], [1, "#9a4a20"]], "color_by": "0", "color_mode": "normal" | "multiply" | "overlay" | "lighten", "roughness": 0.95, "roughness_offset": 0, "metallic": 0, "height": 0.0003, "signed": false}]; name and mask are required, the rest optional (a field left out leaves that channel alone)', aliases: ['stack'] },
    masks: { type: 'json', default: [], desc: 'named masks, computed first in order: [{"name": "dust", "mask": "smoothstep(0.4, 0.8, top) * grain"}]; every later mask, layer mask, color_by and the occlusion read each by its name (computed once however many read it), and they are written as the layers of image <name>_masks (clamped to 0..1; "write": false leaves one out: a step between masks)', aliases: ['named_masks'] },
    outputs: { type: 'enum', options: ['both', 'maps', 'masks'], default: 'both', desc: 'what to write: the maps, the masks image (when masks are named), or both', aliases: ['output'] },
    occlusion: { type: 'code', default: '', desc: 'expression for ORM red (occlusion 0..1) over the same variables ("" = 1)', aliases: ['ao', 'occlusion_expression'] },
    base_roughness: { type: 'float', default: -1, min: -1, max: 1, desc: 'roughness of the whole base, 0..1 (-1 = read the base\'s layer "roughness"; an error when it has none)', aliases: ['roughness'] },
    base_metallic: { type: 'float', default: -1, min: -1, max: 1, desc: 'metallic of the whole base, 0..1 (-1 = read the base\'s layer "metallic"; an error when it has none)', aliases: ['metallic'] },
    coverage: { type: 'string', default: 'mask', desc: 'the base layer that holds the coverage (texels above 0 are composed and padded from; "" = every texel counts)', aliases: ['coverage_layer'] },
    padding: { type: 'int', default: 8, min: 0, max: 256, desc: 'texels to pad from the coverage at the end (the nearest covered texel; a neutral value beyond)', aliases: ['dilation', 'margin'] },
    normal_format: { type: 'enum', options: ['opengl', 'directx'], default: 'opengl', desc: 'green channel convention of the normal map (glTF and Blender read OpenGL, Unreal DirectX)', aliases: ['format', 'convention'] },
    image: imageParam('input 0 (the base)'),
    name: nameParam('prefix of the output images ("" = this node\'s name): <name>_base_color, <name>_normal, <name>_orm, <name>_height'),
  },
  usesVars: expressionText,
  outputs: 'images <name>_base_color (RGBA), <name>_normal (RGBA, tangent space), <name>_orm (R occlusion, G roughness, B metallic) and <name>_height (grey, metres), each with layer mask (the coverage)',
  example: {
    nodes: {
      box: { type: 'box' },
      paint: { type: 'material', in: ['box'], params: { name: 'paint', base_color: '#6f8fae', roughness: 0.55, kind: 'painted_metal' } },
      uv: { type: 'uv_unwrap', in: ['paint'] },
      base: { type: 'bake_material', in: ['uv'], params: { resolution: 256 } },
      curv: { type: 'bake_curvature', in: ['uv'], params: { resolution: 256 } },
      stack: {
        type: 'tex_layers', in: ['base', 'curv'],
        params: {
          layers: [
            { name: 'chips', mask: 'smoothstep(0.15, 0.4, curv_convex)', color: '#9a9a96', roughness: 0.4, metallic: 1, height: -0.0005 },
            { name: 'grime', mask: 'smoothstep(0.1, 0.5, curv_concave)', color: '#3d3529', color_mode: 'multiply', roughness: 0.9, opacity: 0.8 },
          ],
        },
      },
    },
    output: 'stack',
  },
  cook: async (ctx) => {
    const gen = ++stackMemoGen;
    const { p, type } = ctx;
    const layers = parseLayers(p.layers);
    const named = parseMasks(p.masks);
    const base = source(ctx, 0, p.image, '', 'image');
    const w = base.img.width, h = base.img.height, n = w * h;
    const covName = String(p.coverage ?? '').trim();
    let coverage: Float32Array | null = null;
    if (covName) {
      const c = base.img.layer(covName);
      if (!c) throw new NodeError(`${type}: the base has no coverage layer "${covName}"`, `layers: ${listNames([...base.img.layers.keys()])}; bake the base with bake_material, or set coverage to "" to compose every texel`);
      coverage = base.img.channels(covName) === 4 ? toGrey(c, 4) : c;
    }
    const layerOrValue = (field: 'roughness' | 'metallic', value: number): Float32Array | number => {
      if (value >= 0) return value;
      const a = base.img.layer(field);
      if (!a) throw new NodeError(`${type}: the base has no "${field}" layer`, `bake the base with bake_material, or set base_${field}`);
      return base.img.channels(field) === 4 ? toGrey(a, 4) : a;
    };
    const rough = layerOrValue('roughness', p.base_roughness), metal = layerOrValue('metallic', p.base_metallic);
    // texel size and islands of the base
    let texel: { u: Float32Array; v: Float32Array } | null = null;
    const tl = base.img.layer('texel');
    if (tl) {
      texel = texelOf.get(tl) ?? null;
      if (!texel) {
        const ch = base.img.channels('texel'), u = new Float32Array(inShared(n * 4)), v = new Float32Array(inShared(n * 4));
        for (let i = 0; i < n; i++) { u[i] = ch === 4 ? tl[i * 4] : tl[i]; v[i] = ch === 4 ? tl[i * 4 + 1] : tl[i]; }
        texel = { u, v };
        texelOf.set(tl, texel);
      }
    }
    const il = base.img.layer('island');
    const island = il && base.img.channels('island') === 1 ? il : null;
    const heightLayer = layers.find((l) => l.height !== 0);
    // the variables the expressions read: every layer of every image of both inputs, and the channels of colour layers
    const entries = new Map<string, Entry[]>();
    const unnamed = new Set<string>();
    const maskImgs = ctx.hasInput(1) ? imagesOf(ctx.input(1)) : [];
    const addVar = (name: string, e: Entry) => {
      if (!bindableName(name, new Set(['k']))) { unnamed.add(name); return; }
      const list = entries.get(name) ?? [];
      if (!list.some((x) => x.img.name === e.img.name && x.layer === e.layer && x.ch === e.ch)) list.push(e);
      entries.set(name, list);
    };
    for (const img of [...maskImgs, ...(maskImgs.some((m) => m.name === base.img.name) ? [] : [base.img])]) {
      const main = img.mainLayer;
      for (const layer of img.layers.keys()) {
        const name = layer === main ? img.name : `${img.name}_${layer}`;
        addVar(name, { img, layer, ch: -1 });
        if (img.channels(layer) === 4) (['r', 'g', 'b', 'a'] as const).forEach((c, k) => addVar(`${name}_${c}`, { img, layer, ch: k as 0 | 1 | 2 | 3 }));
      }
    }
    if (unnamed.size) ctx.warn(`${type}: mask layers that an expression cannot name, because they are no identifiers: ${[...unnamed].slice(0, 8).map((x) => `"${x}"`).join(', ')}${unnamed.size > 8 ? `, … ${unnamed.size - 8} more` : ''}; rename the image or the layer`);
    for (const m of named) {
      const e = entries.get(m.name);
      if (e) throw new NodeError(`${type}: mask "${m.name}" has the name of image layer ${e[0].img.name}/${e[0].layer}`, 'rename the mask so an expression knows which one it reads');
    }
    const namedSet = new Set(named.map((m) => m.name));
    const varNames = [...entries.keys(), ...named.map((m) => m.name)];
    const hint = () => `variables: ${listNames(varNames) || '(no mask images: connect them to input 1)'}`;
    // the distinct expression texts of the stack: each is evaluated once per cook, whoever uses it
    interface Code { code: string; label: string; subject: string; last: number; vars: string[] }
    const codes: Code[] = [], codeIndex = new Map<string, number>();
    const codeOf = (code: string, label: string, subject: string, layer: number): number => {
      let i = codeIndex.get(code);
      if (i === undefined) { i = codes.length; codeIndex.set(code, i); codes.push({ code, label, subject, last: layer, vars: varNames.filter((v) => usesName(code, v)) }); }
      else codes[i].last = Math.max(codes[i].last, layer);
      return i;
    };
    // a named mask reads only the masks before it
    const maskCodes = named.map((m, j) => {
      const i = codes.length, before = new Set(named.slice(0, j).map((x) => x.name));
      codes.push({ code: m.mask, label: `mask "${m.name}"`, subject: `mask "${m.name}"`, last: -1, vars: varNames.filter((v) => (!namedSet.has(v) || before.has(v)) && usesName(m.mask, v)) });
      return i;
    });
    const masksOnly = p.outputs === 'masks';
    const occCode = !masksOnly && String(p.occlusion ?? '').trim() ? codeOf(String(p.occlusion), 'occlusion', 'occlusion', -1) : -1;
    // a mask that is one variable's name is that variable, with nothing to evaluate
    const layerCodes = (masksOnly ? [] : layers).map((L, li) => {
      const ramp = L.color && !Array.isArray(L.color);
      const t = L.mask.trim();
      const direct = varNames.includes(t) ? t : null;
      return {
        direct,
        mask: direct ? -1 : codeOf(L.mask, `layer "${L.name}" mask`, `layer "${L.name}": its mask`, li),
        by: ramp ? codeOf(L.colorBy, `layer "${L.name}" color_by`, `layer "${L.name}": its color_by`, li) : -1,
      };
    });
    // names the expressions use must be unambiguous and must not hide a helper function
    const helpers = realmHelperNames(ctx.engine.host);
    for (const name of new Set([...codes.flatMap((c) => c.vars), ...layerCodes.map((c) => c.direct).filter((x): x is string => !!x)])) {
      if (namedSet.has(name)) {
        if (helpers.has(name)) throw new NodeError(`${type}: mask "${name}" is called like the helper function ${name}, so an expression cannot read both`, 'rename the mask');
        continue;
      }
      const list = entries.get(name)!;
      if (list.length > 1) throw new NodeError(`${type}: two mask layers are called "${name}" (${list.map((e) => `${e.img.name}/${e.layer}`).join(', ')})`, 'rename an image or a layer so a name an expression uses belongs to one');
      if (helpers.has(name)) throw new NodeError(`${type}: the image "${list[0].img.name}" is called like the helper function ${name}, so an expression cannot read both`, 'rename the image: the name param of the node that made it, or the node itself');
    }
    // one variable as a grey array of the base's size, in shared memory when there is any
    const arrays = new Map<string, Float32Array>(), warned = new Set<string>(), hiddenWarned = new Set<string>();
    const namedArrays = new Map<string, Float32Array>();
    const variable = (name: string): Float32Array => {
      const nm = namedArrays.get(name);
      if (nm) return nm;
      let a = arrays.get(name);
      if (a) return a;
      const { img, layer, ch } = entries.get(name)![0];
      const raw = img.layer(layer)!, chs = img.channels(layer);
      const resized = img.width !== w || img.height !== h;
      if (resized && !warned.has(img.name)) {
        warned.add(img.name);
        ctx.warn(`${type}: mask image "${img.name}" is ${img.width} × ${img.height}, the base ${w} × ${h}; it is resized`);
      }
      const vkey = `var|${idOf(raw)}|${ch}|${chs}|${img.width}x${img.height}|${w}x${h}`;
      const kept = memoGet(vkey, gen);
      if (kept) { arrays.set(name, kept.value); return kept.value; }
      let g: Float32Array;
      if (ch >= 0) { g = new Float32Array(img.count); for (let i = 0; i < g.length; i++) g[i] = raw[i * 4 + ch]; } else g = toGrey(raw, chs === 4 ? 4 : 1);
      if (resized) g = resizeLayer(g, 1, img.width, img.height, w, h, false);
      if (typeof SharedArrayBuffer !== 'undefined') {
        a = new Float32Array(new SharedArrayBuffer(n * 4));
        a.set(g);
      } else a = g;
      arrays.set(name, a);
      memoPut(vkey, gen, a);
      return a;
    };
    const cov = coverageOf(coverage, n), covered = cov.covered, coveredMask = cov.mask;
    const padMap = (): Int32Array | null => {
      if (!coverage) return null;
      const pad = Math.max(0, Math.round(p.padding));
      let m = cov.padding.get(pad);
      if (!m) { m = paddingMap(coverage, w, h, pad); cov.padding.set(pad, m); }
      return m;
    };
    /** evaluate the expressions `idxs` in one call; the results in the same order */
    const covId = coverage ? idOf(coverage) : 'all';
    const graphVars = Object.keys(ctx.vars ?? {});
    const keyOf = (c: Code): string => {
      const src = c.vars.map((v) => { const nm = namedArrays.get(v); return `${v}:${nm ? idOf(nm) : idOf(variable(v))}`; }).join(',');
      const gv = graphVars.filter((k) => usesName(c.code, k)).map((k) => `${k}=${JSON.stringify((ctx.vars as Record<string, unknown>)[k])}`).join(',');
      return `expr|${idOf(ctx.engine.host)}|${n}|${covId}|${c.code}|${src}|${gv}`;
    };
    const evaluate = async (all: number[]): Promise<Float32Array[]> => {
      const keys = all.map((i) => keyOf(codes[i])), got: (Float32Array | null)[] = all.map(() => null);
      all.forEach((_, k) => {
        const e = memoGet(keys[k], gen);
        if (!e) return;
        got[k] = e.value;
        if (e.bad) ctx.warn(`${type}: ${codes[all[k]].label}: ${e.bad} texel(s) gave NaN, infinity or no number; written as 0`);
        const fresh = e.hidden.filter((v) => !hiddenWarned.has(v));
        if (fresh.length) { for (const v of fresh) hiddenWarned.add(v); ctx.warn(`${type}: ${fresh.join(', ')} in an expression ${fresh.length === 1 ? 'is' : 'are'} a mask variable, not the graph var of that name; rename the var to read it here`); }
      });
      const idxs = all.filter((_, k) => !got[k]);
      if (!idxs.length) return got as Float32Array[];
      const vals = await evaluateFresh(idxs);
      let j = 0;
      all.forEach((_, k) => { if (!got[k]) got[k] = vals[j++]; });
      return got as Float32Array[];
    };
    const evaluateFresh = async (idxs: number[]): Promise<Float32Array[]> => {
      const exprs = idxs.map((i) => codes[i]);
      const inputs: Record<string, Float32Array> = {};
      for (const c of exprs) for (const v of c.vars) if (!inputs[v]) inputs[v] = variable(v);
      await ctx.checkpoint();
      try {
        const r = await runPixelExprs({ host: ctx.engine.host, exprs, inputs, count: n, mask: coveredMask, covered, vars: ctx.vars, timeoutMs: ctx.engine.scriptTimeoutMs },
          (job, serial) => ctx.parallelMap('wrangle', job, { serial, minElements: 65536, timeoutMs: ctx.engine.scriptTimeoutMs + 10000 }));
        r.bad.forEach((c, i) => { if (c) ctx.warn(`${type}: ${exprs[i].label}: ${c} texel(s) gave NaN, infinity or no number; written as 0`); });
        r.values.forEach((v, i) => memoPut(keyOf(exprs[i]), gen, v, r.bad[i] ?? 0, r.hidden));
        const fresh = r.hidden.filter((v) => !hiddenWarned.has(v));
        if (fresh.length) {
          for (const v of fresh) hiddenWarned.add(v);
          ctx.warn(`${type}: ${fresh.join(', ')} in an expression ${fresh.length === 1 ? 'is' : 'are'} a mask variable, not the graph var of that name; rename the var to read it here`);
        }
        return r.values;
      } catch (e: any) {
        if (e instanceof PixelSyntaxError) throw new NodeError(`${type}: ${e.message}`);
        if (e instanceof PixelExprError) {
          const label = e.index >= 0 ? exprs[e.index].label : exprs.map((x) => x.label).join(' / ');
          if (e.timedOut) throw new NodeError(`${type}: ${label}: ${e.message}`);
          const who = e.index >= 0 ? exprs[e.index].subject : label;
          if (e.missing) throw new NodeError(`${type}: ${who} names "${e.missing}", which no image in input 1 holds`, hint());
          if (e.helper) throw new NodeError(`${type}: ${who} names "${e.helper}", which is a helper function, not a layer of any image in input 1`, hint());
          throw new NodeError(`${type}: ${label}: ${e.message}`);
        }
        throw e;
      }
    };
    // the named masks first, in order: each becomes a variable for what follows. Masks in a row that read none of each
    // other are evaluated in one call
    const t0 = performance.now();
    for (let j = 0; j < named.length;) {
      // a mask that is one variable it may read is that variable; a number is that number everywhere: nothing to evaluate
      const t = named[j].mask.trim(), c = codes[maskCodes[j]];
      if (c.vars.length === 1 && c.vars[0] === t) {
        // as evaluating it would give, so only when it is a finite number on every covered texel (else it warns and writes 0)
        const a = variable(t);
        let finite = true;
        for (let q = 0; q < covered.length && finite; q++) finite = Number.isFinite(a[covered[q]]);
        if (finite) { namedArrays.set(named[j].name, a); j++; continue; }
      }
      if (/^-?\d+(\.\d+)?$/.test(t)) {
        const ckey = `const|${n}|${coverage ? idOf(coverage) : 'all'}|${t}`, kept = memoGet(ckey, gen);
        if (kept) { namedArrays.set(named[j].name, kept.value); j++; continue; }
        const a = typeof SharedArrayBuffer !== 'undefined' ? new Float32Array(new SharedArrayBuffer(n * 4)) : new Float32Array(n);
        if (Number(t) !== 0) for (let q = 0; q < covered.length; q++) a[covered[q]] = Number(t);
        memoPut(ckey, gen, a);
        namedArrays.set(named[j].name, a); j++; continue;
      }
      const group = new Set([named[j].name]);
      let end = j + 1;
      while (end < named.length && !codes[maskCodes[end]].vars.some((v) => group.has(v))) group.add(named[end++].name);
      const vals = await evaluate(maskCodes.slice(j, end));
      for (let k = j; k < end; k++) namedArrays.set(named[k].name, vals[k - j]);
      j = end;
    }
    if (named.length) ctx.stage('masks', performance.now() - t0);
    const prefix = outName(ctx);
    const make = (suffix: string, data: Float32Array) => {
      const img = new Image(w, h, `${prefix}_${suffix}`).set(MAIN_LAYER, data);
      img.takeSize(base.img);
      if (coverage) img.set('mask', coverage);
      // the maps keep the texel size and the islands of the base, so a filter after this node stays on one island
      for (const l of ['texel', 'island']) { const a = base.img.layer(l); if (a) img.set(l, a); }
      return img;
    };
    const out = new Geometry();
    if (!masksOnly) {
      // per-texel colour, roughness and normal of the layers that take them from an image
      const imgOf = (L: ParsedLayer): Image => {
        const im = [...maskImgs, base.img].find((x) => x.name === L.image);
        if (!im) throw new NodeError(`${type}: layer "${L.name}": image "${L.image}" is not in input 1`, `images: ${listNames([...new Set([...maskImgs, base.img].map((x) => x.name))])}`);
        return im;
      };
      const fit = (im: Image, a: Float32Array, ch: number) => (im.width === w && im.height === h ? a : resizeLayer(a, ch, im.width, im.height, w, h, false));
      const sourceOf = (L: ParsedLayer): LayerSource | null => {
        if (!L.image) return null;
        const im = imgOf(L), c = im.layer(im.mainLayer)!, r = im.layer('roughness'), nm = im.layer('normal');
        return {
          color: fit(im, toRGBA(c, im.channels(im.mainLayer)), 4),
          roughness: r ? fit(im, toGrey(r, im.channels('roughness')), 1) : null,
          normal: nm && im.channels('normal') === 4 ? fit(im, nm, 4) : null,
        };
      };
      for (const L of layers) if (L.image) imgOf(L);
      const bn = base.img.layer('normal'), baseNormal = bn && base.img.channels('normal') === 4 ? bn : null;
      const imageNormals = layers.some((L) => L.image && imgOf(L).channels('normal') === 4);
      let flat: Float32Array | null = null;
      if (!baseNormal && imageNormals) { flat = new Float32Array(n * 4); for (let i = 0; i < n; i++) { flat[i * 4] = 0.5; flat[i * 4 + 1] = 0.5; flat[i * 4 + 2] = 1; flat[i * 4 + 3] = 1; } }
      const occ = occCode >= 0 ? (await evaluate([occCode]))[0] : null;
      const cap = Math.max(2, Math.floor(stackLimits.resultBytes / (n * 4)));
      const directx = p.normal_format === 'directx', stackNormal = baseNormal ?? flat;
      const need = [...new Set(layerCodes.flatMap((lc) => [lc.mask, lc.by]).filter((c) => c >= 0))];
      if (need.length <= cap) {
        // every layer's arrays at once: the whole stack of each texel in one pass, on the worker threads in ranges of
        // the covered texels (each texel's stack is its own), then the normal from the summed height the same way
        const vals = await evaluate(need), A: Record<string, TypedArray> = { covered, base: base.data };
        need.forEach((c, i) => { A[`e${c}`] = vals[i]; });
        if (typeof rough !== 'number') A.roughness = rough;
        if (typeof metal !== 'number') A.metallic = metal;
        if (stackNormal) A.bnormal = stackNormal;
        if (occ) A.occlusion = occ;
        const jl: StackJobLayer[] = layers.map((L, k) => {
          const lc = layerCodes[k], src = sourceOf(L);
          const put = (a: Float32Array | null | undefined, tag: string) => { if (!a) return null; A[`${tag}${k}`] = a; return `${tag}${k}`; };
          let mask = `e${lc.mask}`;
          if (lc.direct) { mask = `v_${lc.direct}`; A[mask] = variable(lc.direct); }
          const { name, color, mode, opacity, roughness, roughnessOffset, metallic, height, signed } = L;
          return { spec: { name, color, mode, opacity, roughness, roughnessOffset, metallic, height, signed }, mask, by: lc.by >= 0 ? `e${lc.by}` : null, color: put(src?.color, 'sc'), roughness: put(src?.roughness, 'sr'), normal: put(src?.normal, 'sn') };
        });
        const f32 = (k: number) => new Float32Array(inShared(n * k * 4));
        const R: Record<string, Float32Array> = { color: f32(4), sroughness: f32(1), smetallic: f32(1), relief: f32(1), baseColor: f32(4), orm: f32(4) };
        if (stackNormal) R.snormal = f32(4);
        const args: StackJobArgs = { w, h, baseCh: base.ch, roughness: typeof rough === 'number' ? rough : null, metallic: typeof metal === 'number' ? metal : null, layers: jl, normal: !!stackNormal, occlusion: !!occ };
        // the inputs in shared memory, kept with their arrays, so a cook after a slider moved copies only what changed
        for (const [k, a] of Object.entries(A)) A[k] = sharedOf(a);
        await ctx.parallelMap('layer_stack', { count: covered.length, args, inputs: A, results: R });
        const NA: Record<string, TypedArray> = { relief: R.relief, covered };
        if (coverage) NA.coverage = sharedOf(coverage);
        if (island) NA.island = sharedOf(island);
        if (texel) { NA.texu = texel.u; NA.texv = texel.v; }
        if (stackNormal) NA.snormal = R.snormal;
        const normal = f32(4);
        await ctx.parallelMap('layer_normal', { count: covered.length, args: { w, h, size: base.img.size, directx, texel: !!texel, overlay: !!stackNormal, coverage: !!coverage, island: !!island }, inputs: NA, results: { normal } });
        const maps = padMaps({ baseColor: R.baseColor, normal, orm: R.orm, height: R.relief }, w, h, padMap());
        out.volumes.push(make('base_color', maps.baseColor), make('normal', maps.normal), make('orm', maps.orm), make('height', maps.height));
      } else {
        const stack = startStack(w, h, base.data, base.ch, rough, metal, covered, stackNormal);
        // more arrays than the memory budget holds at once: the layers in groups whose expressions fit it, each group's
        // distinct expressions in one call
        const results = new Map<number, Float32Array>();
        const lastUse = (name: string) => codes.reduce((m, c, i) => (c.vars.includes(name) && i !== occCode ? Math.max(m, c.last) : m), -1);
        let li = 0;
        while (li < layers.length) {
          const fresh = new Set<number>();
          let end = li;
          while (end < layers.length) {
            const need = [layerCodes[end].mask, layerCodes[end].by].filter((c) => c >= 0 && !results.has(c) && !fresh.has(c));
            if (end > li && results.size + fresh.size + need.length > cap) break;
            need.forEach((c) => fresh.add(c));
            end++;
          }
          if (fresh.size) {
            const idxs = [...fresh], vals = await evaluate(idxs);
            idxs.forEach((c, i) => results.set(c, vals[i]));
          }
          for (let k = li; k < end; k++) {
            const lc = layerCodes[k];
            applyLayer(stack, layers[k], lc.direct ? variable(lc.direct) : results.get(lc.mask)!, lc.by >= 0 ? results.get(lc.by)! : null, sourceOf(layers[k]));
          }
          // what no later layer reads is dropped
          for (const c of [...results.keys()]) if (codes[c].last < end) results.delete(c);
          for (const v of [...arrays.keys()]) if (lastUse(v) < end && !layerCodes.slice(end).some((x) => x.direct === v)) arrays.delete(v);
          li = end;
        }
        const maps = finishStack(stack, { occlusion: occ, coverage, padding: p.padding, texel, size: base.img.size, island, directx, paddingMap: padMap() ?? undefined });
        out.volumes.push(make('base_color', maps.baseColor), make('normal', maps.normal), make('orm', maps.orm), make('height', maps.height));
      }
    }
    if (named.length && p.outputs !== 'maps') {
      // the named masks as layers of one image, clamped to 0..1 and padded from the coverage like the maps
      const img = new Image(w, h, `${prefix}_masks`).takeSize(base.img);
      // the texels padding writes (those not covered) and where each copies from: one list for every mask
      let pads: Int32Array | null | undefined;
      const padList = () => {
        const map = padMap();
        if (!map) return null;
        let c = 0;
        for (let k = 0; k < map.length; k++) if (map[k] !== k) c++;
        const list = new Int32Array(c * 2);
        c = 0;
        for (let k = 0; k < map.length; k++) if (map[k] !== k) { list[c++] = k; list[c++] = map[k]; }
        return list;
      };
      for (const m of named) {
        if (!m.write) continue;
        const src = namedArrays.get(m.name)!, pkey = `pad|${idOf(src)}|${covId}|${Math.round(p.padding)}`;
        const kept = memoGet(pkey, gen);
        if (kept) { img.set(m.name, kept.value); continue; }
        const a = new Float32Array(n);
        for (let q = 0; q < covered.length; q++) { const i = covered[q], v = src[i]; a[i] = v > 0 ? (v < 1 ? v : 1) : 0; }
        if (pads === undefined) pads = padList();
        if (pads) for (let q = 0; q < pads.length; q += 2) { const s = pads[q + 1]; a[pads[q]] = s >= 0 ? a[s] : 0; }
        memoPut(pkey, gen, a);
        img.set(m.name, a);
      }
      for (const l of ['texel', 'island']) { const a = base.img.layer(l); if (a) img.set(l, a); }
      if (coverage) img.set('mask', coverage);
      out.volumes.push(img);
    }
    ctx.stat('layers', layers.length);
    ctx.stat('masks', named.length);
    ctx.stat('texels', covered.length);
    return out;
  },
});
