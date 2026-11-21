// tex_layers (category "texture"): a layer stack over a base. The base is the bake_material image (base colour, with
// roughness, metallic, coverage, texel size and island as layers); each layer is a mask expression with a colour (or a
// ramp), roughness, metallic and height. The stack writes base colour, normal (from the summed height in metres),
// occlusion-roughness-metallic and height together, on the covered texels only, and pads them from the islands at the
// end. The compose is core/layers.ts; the mask expressions are compiled once (identical texts once per cook) and run in
// chunks on the worker pool, all the expressions of a group of layers in one call (core/pixelexpr.ts).
import { Geometry } from '../core/geometry.ts';
import { Image, MAIN_LAYER, imagesOf, resizeLayer, toGrey } from '../core/image.ts';
import { COLOR_MODES, applyLayer, coveredIndices, finishStack, startStack } from '../core/layers.ts';
import type { ColorLUT, ColorMode, LayerSpec } from '../core/layers.ts';
import { PixelExprError, PixelSyntaxError, bindableName, realmHelperNames, runPixelExprs, usesName } from '../core/pixelexpr.ts';
import { rampLUT } from '../core/texture.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import { didYouMean, evalRamp, parseColor } from '../graph/params.ts';
import { NAMED_BY_NODE, imageParam, nameParam, outName, source } from './texture.ts';

const FIELDS = ['name', 'mask', 'opacity', 'color', 'color_by', 'color_mode', 'roughness', 'roughness_offset', 'metallic', 'height', 'signed'];

/** The results of the expressions in flight at once (bytes): past it the layers are composed in groups. */
const RESULT_BUDGET = 768e6;

/** Cap on the names a hint lists. */
const listNames = (names: string[], max = 14) => names.slice(0, max).join(', ') + (names.length > max ? `, … ${names.length - max} more` : '');

interface ParsedLayer extends LayerSpec {
  mask: string;
  colorBy: string;
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
    return {
      name, mask: o.mask, colorBy, color, mode: mode as ColorMode, opacity: num('opacity', 1, 0, 1),
      roughness: orNull('roughness'), roughnessOffset: num('roughness_offset', 0), metallic: orNull('metallic'), height: num('height', 0), signed: o.signed === true,
    };
  });
}

/** The expression text of the params, so a graph var the code names keys the node's cache. */
function expressionText(p: Record<string, any>): string {
  const parts: string[] = [String(p.occlusion ?? '')];
  if (Array.isArray(p.layers)) for (const l of p.layers) if (l && typeof l === 'object') parts.push(String((l as any).mask ?? ''), String((l as any).color_by ?? ''));
  return parts.join('\n');
}

/** A layer of an image an expression can read: the layer as grey (luminance for colour), or one channel of a colour layer. */
interface Entry { img: Image; layer: string; ch: -1 | 0 | 1 | 2 | 3 }

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
    const { p, type } = ctx;
    const layers = parseLayers(p.layers);
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
      const ch = base.img.channels('texel'), u = new Float32Array(n), v = new Float32Array(n);
      for (let i = 0; i < n; i++) { u[i] = ch === 4 ? tl[i * 4] : tl[i]; v[i] = ch === 4 ? tl[i * 4 + 1] : tl[i]; }
      texel = { u, v };
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
    const varNames = [...entries.keys()];
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
    const occCode = String(p.occlusion ?? '').trim() ? codeOf(String(p.occlusion), 'occlusion', 'occlusion', -1) : -1;
    const layerCodes = layers.map((L, li) => {
      const ramp = L.color && !Array.isArray(L.color);
      return {
        mask: codeOf(L.mask, `layer "${L.name}" mask`, `layer "${L.name}": its mask`, li),
        by: ramp ? codeOf(L.colorBy, `layer "${L.name}" color_by`, `layer "${L.name}": its color_by`, li) : -1,
      };
    });
    // names the expressions use must be unambiguous and must not hide a helper function
    const helpers = realmHelperNames(ctx.engine.host);
    for (const name of new Set(codes.flatMap((c) => c.vars))) {
      const list = entries.get(name)!;
      if (list.length > 1) throw new NodeError(`${type}: two mask layers are called "${name}" (${list.map((e) => `${e.img.name}/${e.layer}`).join(', ')})`, 'rename an image or a layer so a name an expression uses belongs to one');
      if (helpers.has(name)) throw new NodeError(`${type}: the image "${list[0].img.name}" is called like the helper function ${name}, so an expression cannot read both`, 'rename the image: the name param of the node that made it, or the node itself');
    }
    // one variable as a grey array of the base's size, in shared memory when there is any
    const arrays = new Map<string, Float32Array>(), warned = new Set<string>(), hiddenWarned = new Set<string>();
    const variable = (name: string): Float32Array => {
      let a = arrays.get(name);
      if (a) return a;
      const { img, layer, ch } = entries.get(name)![0];
      const raw = img.layer(layer)!, chs = img.channels(layer);
      let g: Float32Array;
      if (ch >= 0) { g = new Float32Array(img.count); for (let i = 0; i < g.length; i++) g[i] = raw[i * 4 + ch]; } else g = toGrey(raw, chs === 4 ? 4 : 1);
      if (img.width !== w || img.height !== h) {
        if (!warned.has(img.name)) {
          warned.add(img.name);
          ctx.warn(`${type}: mask image "${img.name}" is ${img.width} × ${img.height}, the base ${w} × ${h}; it is resized`);
        }
        g = resizeLayer(g, 1, img.width, img.height, w, h, false);
      }
      if (typeof SharedArrayBuffer !== 'undefined') {
        a = new Float32Array(new SharedArrayBuffer(n * 4));
        a.set(g);
      } else a = g;
      arrays.set(name, a);
      return a;
    };
    const covered = coveredIndices(coverage, n);
    let coveredMask: Uint8Array | null = null;
    if (coverage) { coveredMask = new Uint8Array(n); for (let q = 0; q < covered.length; q++) coveredMask[covered[q]] = 1; }
    /** evaluate the expressions `idxs` in one call; the results in the same order */
    const evaluate = async (idxs: number[]): Promise<Float32Array[]> => {
      const exprs = idxs.map((i) => codes[i]);
      const inputs: Record<string, Float32Array> = {};
      for (const c of exprs) for (const v of c.vars) if (!inputs[v]) inputs[v] = variable(v);
      await ctx.checkpoint();
      try {
        const r = await runPixelExprs({ host: ctx.engine.host, exprs, inputs, count: n, mask: coveredMask, covered, vars: ctx.vars, timeoutMs: ctx.engine.scriptTimeoutMs },
          (job, serial) => ctx.parallelMap('wrangle', job, { serial, minElements: 65536, timeoutMs: ctx.engine.scriptTimeoutMs + 10000 }));
        r.bad.forEach((c, i) => { if (c) ctx.warn(`${type}: ${exprs[i].label}: ${c} texel(s) gave NaN, infinity or no number; written as 0`); });
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
    const stack = startStack(w, h, base.data, base.ch, rough, metal, covered);
    const occ = occCode >= 0 ? (await evaluate([occCode]))[0] : null;
    // the layers in groups whose expressions fit the memory budget: each group's distinct expressions in one call
    const cap = Math.max(2, Math.floor(RESULT_BUDGET / (n * 4)));
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
      for (let k = li; k < end; k++) applyLayer(stack, layers[k], results.get(layerCodes[k].mask)!, layerCodes[k].by >= 0 ? results.get(layerCodes[k].by)! : null);
      // what no later layer reads is dropped
      for (const c of [...results.keys()]) if (codes[c].last < end) results.delete(c);
      for (const v of [...arrays.keys()]) if (lastUse(v) < end) arrays.delete(v);
      li = end;
    }
    const maps = finishStack(stack, { occlusion: occ, coverage, padding: p.padding, texel, size: base.img.size, island, directx: p.normal_format === 'directx' });
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
    out.volumes = [make('base_color', maps.baseColor), make('normal', maps.normal), make('orm', maps.orm), make('height', maps.height)];
    ctx.stat('layers', layers.length);
    ctx.stat('texels', stack.covered.length);
    return out;
  },
});
