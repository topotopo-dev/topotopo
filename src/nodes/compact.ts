// tex_compact: keep only the layers of an image that something reads, and store those that need about three
// significant digits (masks 0..1) as 16-bit floats (core/half.ts), so bakes that stay in memory between cooks take
// less of it.
import { Geometry } from '../core/geometry.ts';
import { Image, asImage, isImage } from '../core/image.ts';
import { toHalf } from '../core/half.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';

/** Layer name patterns: names separated by spaces, * any run of characters, !pattern leaves those out. */
function matcher(text: string): ((name: string) => boolean) | null {
  const words = text.split(/[\s,]+/).filter(Boolean);
  if (!words.length) return null;
  const re = (w: string) => new RegExp(`^${w.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  const take = words.filter((w) => !w.startsWith('!')).map(re), drop = words.filter((w) => w.startsWith('!')).map((w) => re(w.slice(1)));
  return (name) => take.some((r) => r.test(name)) && !drop.some((r) => r.test(name));
}

/** The 16-bit copy of each array, so layers that several images share (texel, island, mask of one mesh's bakes) stay
 *  shared; cooked arrays never change, so a copy made once holds. */
const halves = new WeakMap<Float32Array, Float32Array>();
const half = (a: Float32Array): Float32Array => {
  let h = halves.get(a);
  if (!h) { h = toHalf(a); halves.set(a, h); }
  return h;
};

defineNode({
  type: 'tex_compact',
  category: 'texture',
  summary: 'Keep only the named layers of images and store the 0..1 ones as 16-bit floats: less memory for bakes that stay cached between cooks.',
  description:
    'For every image of input 0 (or the one named by image), keeps the layers keep names ("" = all) and stores those half ' +
    'names as 16-bit floats: about three significant digits, so 0..1 masks come back within 0.0003 and whole numbers ' +
    'exactly up to 2048 (ids above that, such as island, are left out of half by default). The values are rounded the same ' +
    'way on every runtime; where it has Float16Array (Node 24, current browsers) they also take half the memory, elsewhere ' +
    'they stay 32-bit arrays. Names are separated by spaces; * matches any run of characters and !name leaves a name out ' +
    '("* !island"). An image that loses its main layer C has its first kept layer as the main one (the layer filters read, ' +
    'and the one tex_layers names after the image), so keep C when other nodes read the layers by name. A keep name that ' +
    'matches no layer of any image is reported. Nodes after it read the layers as usual ' +
    '(texture filters take a 32-bit copy). Stats: layers (kept), dropped, half, and mb (megabytes the images take after it, a shared layer once).',
  aliases: ['image_compact', 'keep_layers', 'layers_keep'],
  inputs: [{ name: 'images', desc: 'geometry with images (bakes)' }],
  params: {
    keep: { type: 'string', default: '', desc: 'layers to keep, by name ("" = all; e.g. "C occ cav kind_*")', aliases: ['layers'] },
    half: { type: 'string', default: '* !island', desc: 'kept layers stored as 16-bit floats (names, * and !name; "" = none)', aliases: ['half_layers', 'f16'] },
    image: { type: 'string', default: '', desc: 'the image to compact ("" = every image of input 0)', aliases: ['input_image'] },
  },
  outputs: 'input 0 with each image holding the kept layers, those named by half at 16 bits',
  example: {
    nodes: {
      box: { type: 'box', params: { size: [1, 1, 1] } },
      uv: { type: 'uv_unwrap', in: ['box'], params: { resolution: 64 } },
      bake: { type: 'bake_measure', in: ['uv'], params: { resolution: 64, name: 'm', measures: [{ by: 'facing', name: 'top' }, { by: 'height', name: 'ht' }, { by: 'noise', name: 'grain', size: [0.2, 0.2, 0.2] }] } },
      compact: { type: 'tex_compact', in: ['bake'], params: { keep: 'top ht texel island mask' } },
    },
    output: 'compact',
  },
  cook: (ctx) => {
    const { p, type } = ctx;
    const g = ctx.input(0);
    const keep = matcher(String(p.keep ?? '')), halfOf = matcher(String(p.half ?? ''));
    const only = String(p.image ?? '').trim();
    const imgs = g.volumes.filter(isImage);
    if (!imgs.length) throw new NodeError(`${type}: input 0 has no image`, 'connect a bake or a texture node');
    if (only && !imgs.some((v) => v.name === only)) throw new NodeError(`${type}: input 0 has no image "${only}"`, `images: ${imgs.map((v) => v.name).join(', ')}`);
    const out: Geometry = g.clone();
    let kept = 0, dropped = 0, halved = 0, bytes = 0;
    const counted = new Set<Float32Array>();
    const count = (a: Float32Array) => { if (!counted.has(a)) { counted.add(a); bytes += a.byteLength; } };
    const matched = new Set<string>();
    out.volumes = out.volumes.map((v) => {
      if (!isImage(v)) return v;
      const src = asImage(v);
      if (only && src.name !== only) { for (const a of src.layers.values()) count(a); return v; }
      const img = new Image(src.width, src.height, src.name).takeSize(src);
      for (const [name, a] of src.layers) {
        if (keep && !keep(name)) { dropped++; continue; }
        matched.add(name);
        const h = halfOf?.(name) ?? false;
        const stored = h ? half(a) : a;
        img.set(name, stored);
        kept++;
        if (h) halved++;
        count(stored);
      }
      return img;
    });
    // a name keep asks for that no image has is a typo or a layer that is not baked: say so
    if (keep) {
      const missing = String(p.keep).split(/[\s,]+/).filter((w) => w && !w.startsWith('!') && !w.includes('*') && !matched.has(w));
      if (missing.length) ctx.warn(`${type}: keep names ${missing.map((m) => `"${m}"`).join(', ')}, which no image holds`);
    }
    ctx.stat('layers', kept);
    ctx.stat('dropped', dropped);
    ctx.stat('half', halved);
    ctx.stat('mb', Math.round(bytes / 1e5) / 10);
    return out;
  },
});
