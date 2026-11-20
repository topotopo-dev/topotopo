// tex_layers (category "texture"): a layer stack over a base. The base is the bake_material image (base colour, with
// roughness, metallic and coverage as layers); each layer is a mask expression with a colour (or a ramp), roughness,
// metallic and height. The stack writes base colour, normal (from the summed height in metres), occlusion-roughness-
// metallic and height together, on the covered texels only, and pads them from the islands at the end. The compose is
// core/layers.ts; the mask expressions are compiled once and run in chunks on the worker pool (core/pixelexpr.ts).
import { Geometry } from '../core/geometry.ts';
import { Image, MAIN_LAYER, imagesOf, resizeLayer, toGrey } from '../core/image.ts';
import { COLOR_MODES, applyLayer, finishStack, startStack } from '../core/layers.ts';
import type { ColorLUT, ColorMode, LayerSpec } from '../core/layers.ts';
import { PixelExprError, PixelSyntaxError, bindableName, runPixelExprs, usesName } from '../core/pixelexpr.ts';
import { rampLUT } from '../core/texture.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import type { CookContext } from '../graph/types.ts';
import { didYouMean, evalRamp, parseColor } from '../graph/params.ts';
import { NAMED_BY_NODE, imageParam, nameParam, outName, source } from './texture.ts';

const FIELDS = ['name', 'mask', 'opacity', 'color', 'color_by', 'color_mode', 'roughness', 'roughness_offset', 'metallic', 'height'];

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
    let color: LayerSpec['color'] = null;
    if (o.color !== undefined && o.color !== null) {
      color = rampOf(o.color, who) ?? colorOf(o.color);
      if (!color) throw new NodeError(`tex_layers: ${who}: color ${show(o.color)} is not a colour`, 'a colour is "#rrggbb", a name such as "orange", or [r, g, b] in 0..1; a ramp is [[0, "#5c2a14"], [1, "#9a4a20"]]');
    }
    const colorBy = o.color_by === undefined ? '0' : o.color_by;
    if (typeof colorBy !== 'string' || !colorBy.trim()) throw new NodeError(`tex_layers: ${who}: color_by must be an expression`, 'e.g. "noise_a" or "0.5"');
    return {
      name, mask: o.mask, colorBy, color, mode: mode as ColorMode, opacity: num('opacity', 1, 0, 1),
      roughness: orNull('roughness'), roughnessOffset: num('roughness_offset', 0), metallic: orNull('metallic'), height: num('height', 0),
    };
  });
}

/** The expression text of the params, so a graph var the code names keys the node's cache. */
function expressionText(p: Record<string, any>): string {
  const parts: string[] = [String(p.occlusion ?? '')];
  if (Array.isArray(p.layers)) for (const l of p.layers) if (l && typeof l === 'object') parts.push(String((l as any).mask ?? ''), String((l as any).color_by ?? ''));
  return parts.join('\n');
}

defineNode({
  type: 'tex_layers',
  category: 'texture',
  usesNodeName: NAMED_BY_NODE,
  summary: 'A layer stack over a base: each layer is a mask expression with a colour or ramp, roughness, metallic and height; writes base colour, normal, ORM and height together on the covered texels, then pads.',
  description:
    'Input 0 is the base: an image whose C is the base colour and whose layers "roughness" and "metallic" hold the base values ' +
    '(bake_material gives exactly this), or any colour image with base_roughness / base_metallic set; its layer "mask" is the ' +
    'coverage (coverage param). Input 1 holds the mask images (merge the bakes). A layer\'s mask is an expression over the ' +
    'layers of the images in both inputs: an image\'s main layer is a variable named like the image, each other layer ' +
    '<image>_<layer> (an image "edges" with layers convex and concave gives edges, edges_convex, edges_concave; the base ' +
    'image\'s own layers too: base_kind_painted_metal); a grey layer is its value, a colour layer its luminance; the wrangle ' +
    'helpers (smoothstep, fit, clamp, min, max, pow …) and the graph vars are there, and a bare layer name is an expression ' +
    'too. Layers run bottom to top; a = clamp(mask, 0, 1) × opacity. color is "#rrggbb", a name, [r, g, b] or a ramp ' +
    '[[t, colour], …] read at the expression color_by (0..1; noise for varied rust); color_mode normal replaces, multiply ' +
    'darkens by the colour, overlay overlays it, lighten keeps the lighter of the two (a fade toward a pale colour). ' +
    'roughness and metallic replace the values below where the mask is, roughness_offset adds to roughness; height is ' +
    'metres added where the mask is (negative = a step down: chips). The normal map is made from the summed height at the ' +
    'texel size, so a 0.15 mm step looks the same at 1024 and 2048 (size: the metres the image width covers; bake_material ' +
    'reports it as its stat size). Only covered texels are composed and expressions run on them only, so nothing a mask ' +
    'holds outside the islands reaches the maps; at the end every map is padded from the covered texels by padding texels ' +
    '(a neutral value beyond). Mask images of another size than the base are resized, with a warning. Expressions are ' +
    'compiled once per layer and run in chunks on the worker pool for large images, with identical results without it. ' +
    'Outputs: images <name>_base_color, <name>_normal, <name>_orm (R occlusion, G roughness, B metallic) and <name>_height ' +
    '(metres), each keeping the coverage as layer "mask"; texture_to_material makes a material of the first three.',
  aliases: ['layers', 'material_layers', 'texture_layers', 'layer_stack'],
  inputs: [
    { name: 'base', desc: 'the base: colour in C, layers roughness and metallic (bake_material), coverage in layer mask' },
    { name: 'masks', desc: 'geometry holding the images the mask expressions name (merge the bake outputs)', optional: true },
  ],
  params: {
    layers: { type: 'json', default: [], desc: 'the layers, bottom to top: [{"name": "dust", "mask": "smoothstep(0.4, 0.8, top)", "opacity": 1, "color": "#a69d8b" | [r, g, b] | [[0, "#5c2a14"], [1, "#9a4a20"]], "color_by": "0", "color_mode": "normal" | "multiply" | "overlay" | "lighten", "roughness": 0.95, "roughness_offset": 0, "metallic": 0, "height": 0.0003}]; name and mask are required, the rest optional (a field left out leaves that channel alone)', aliases: ['stack'] },
    occlusion: { type: 'code', default: '', desc: 'expression for ORM red (occlusion 0..1) over the same variables ("" = 1)', aliases: ['ao', 'occlusion_expression'] },
    base_roughness: { type: 'float', default: -1, min: -1, max: 1, desc: 'roughness of the whole base, 0..1 (-1 = read the base\'s layer "roughness"; an error when it has none)', aliases: ['roughness'] },
    base_metallic: { type: 'float', default: -1, min: -1, max: 1, desc: 'metallic of the whole base, 0..1 (-1 = read the base\'s layer "metallic"; an error when it has none)', aliases: ['metallic'] },
    coverage: { type: 'string', default: 'mask', desc: 'the base layer that holds the coverage (texels above 0 are composed and padded from; "" = every texel counts)', aliases: ['coverage_layer'] },
    padding: { type: 'int', default: 8, min: 0, max: 256, desc: 'texels to pad from the coverage at the end (the nearest covered texel; a neutral value beyond)', aliases: ['dilation', 'margin'] },
    size: { type: 'float', default: 1, min: 1e-6, desc: 'metres the image width covers on the model (one texel is size / width; bake_material reports it as its stat size); sets the slope of the normal map made from the height', aliases: ['texture_size', 'world_size'] },
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
          size: 1,
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
    // the variables the expressions read: every layer of every image of both inputs
    const vars = new Map<string, { img: Image; layer: string }>();
    const maskImgs = ctx.hasInput(1) ? imagesOf(ctx.input(1)) : [];
    const warned = new Set<string>(), hiddenWarned = new Set<string>();
    for (const img of [...maskImgs, ...(maskImgs.some((m) => m.name === base.img.name) ? [] : [base.img])]) {
      const main = img.mainLayer;
      for (const layer of img.layers.keys()) {
        const name = layer === main ? img.name : `${img.name}_${layer}`;
        if (!bindableName(name, new Set(['k']))) continue;
        const had = vars.get(name);
        if (had && (had.img !== img || had.layer !== layer)) throw new NodeError(`${type}: two mask layers are called "${name}"`, 'rename an image or a layer so every variable name is used once');
        vars.set(name, { img, layer });
      }
    }
    const varNames = [...vars.keys()];
    const hint = () => `variables: ${listNames(varNames) || '(no mask images: connect them to input 1)'}`;
    const arrays = new Map<string, Float32Array>();
    /** one variable as a grey array of the base's size, in shared memory when there is any */
    const variable = (name: string): Float32Array => {
      let a = arrays.get(name);
      if (a) return a;
      const { img, layer } = vars.get(name)!;
      const raw = img.layer(layer)!;
      let g = toGrey(raw, img.channels(layer) === 4 ? 4 : 1);
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
    // the expressions of the stack, with what they are called in an error
    const covered = coverage ? Uint8Array.from(coverage, (c) => (c > 0 ? 1 : 0)) : null;
    const run = async (exprs: { code: string; label: string; subject: string }[]) => {
      const inputs: Record<string, Float32Array> = {};
      for (const nme of varNames) if (exprs.some((x) => usesName(x.code, nme))) inputs[nme] = variable(nme);
      await ctx.checkpoint();
      try {
        const r = await runPixelExprs({ host: ctx.engine.host, exprs, inputs, count: n, mask: covered, vars: ctx.vars, timeoutMs: ctx.engine.scriptTimeoutMs },
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
          if (e.missing) throw new NodeError(`${type}: ${e.index >= 0 ? exprs[e.index].subject : label} names "${e.missing}", which no image in input 1 holds`, hint());
          throw new NodeError(`${type}: ${label}: ${e.message}`);
        }
        throw e;
      }
    };
    const stack = startStack(w, h, base.data, base.ch, rough, metal, coverage);
    const occ = String(p.occlusion ?? '').trim() ? (await run([{ code: String(p.occlusion), label: 'occlusion', subject: 'occlusion' }]))[0] : null;
    for (const L of layers) {
      const exprs = [{ code: L.mask, label: `layer "${L.name}" mask`, subject: `layer "${L.name}": its mask` }];
      const ramp = L.color && !Array.isArray(L.color);
      if (ramp) exprs.push({ code: L.colorBy, label: `layer "${L.name}" color_by`, subject: `layer "${L.name}": its color_by` });
      const v = await run(exprs);
      applyLayer(stack, L, v[0], ramp ? v[1] : null);
    }
    const maps = finishStack(stack, { occlusion: occ, coverage, padding: p.padding, size: p.size, directx: p.normal_format === 'directx' });
    const prefix = outName(ctx);
    const make = (suffix: string, data: Float32Array) => {
      const img = new Image(w, h, `${prefix}_${suffix}`).set(MAIN_LAYER, data);
      if (coverage) img.set('mask', coverage);
      return img;
    };
    const out = new Geometry();
    out.volumes = [make('base_color', maps.baseColor), make('normal', maps.normal), make('orm', maps.orm), make('height', maps.height)];
    ctx.stat('layers', layers.length);
    ctx.stat('texels', stack.covered.length);
    return out;
  },
});
