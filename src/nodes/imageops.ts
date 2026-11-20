// General-purpose image extraction, contour tracing, padding and atlas assembly.
import { Geometry, GeoBuilder } from '../core/geometry.ts';
import { Image, imagesOf, toGrey, MAX_PIXELS } from '../core/image.ts';
import { cropImage, dilateImage } from '../core/imageops.ts';
import { traceMask } from '../core/traceimage.ts';
import { skylinePack } from '../core/uv.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import type { ParamDef } from '../graph/types.ts';
import { runScaled } from '../core/texscale.ts';
import { NAMED_BY_NODE, imageParam, outName, renameParam, source, withLayer, checkSize, resolutionParam } from './texture.ts';

const layerParam = (): ParamDef => ({ type: 'string', default: '', desc: 'layer name (empty selects the main layer)' });
const channelParam = (def = 'alpha'): ParamDef => ({ type: 'enum', options: ['alpha', 'luminance', 'r', 'g', 'b'], default: def, desc: 'channel to read; alpha requires RGBA, luminance/R/G/B accept grey' });

function channel(data: Float32Array, ch: number, which: string): Float32Array {
  if (which === 'luminance') return toGrey(data, ch);
  if (ch === 1) {
    if (which === 'alpha') throw new NodeError('alpha channel requires RGBA; select luminance for a grey mask');
    return data;
  }
  const c = which === 'alpha' ? 3 : 'rgb'.indexOf(which);
  return Float32Array.from({ length: data.length / 4 }, (_, i) => data[i * 4 + c]);
}

defineNode({
  type: 'tex_crop', category: 'texture', packed: 'keep', usesNodeName: NAMED_BY_NODE,
  summary: 'Extract an exact pixel rectangle, optionally resize it; all image layers stay aligned.',
  description: 'Origin is [x,y] from the top left, in pixels (a crop addresses pixels). Size 0 on an axis means the remaining source extent; resolution 0 keeps the crop size. The result covers the same surface the pixels did: its size in metres is the crop\'s share of the source\'s, and a "texel" layer follows a resize. Outside pixels are zero, never wrapped. Filtered resize uses area averaging down and bilinear up; nearest preserves discrete masks. Values are not colour-converted. The result takes this node\'s name unless name is set; other geometry/images pass through.',
  inputs: [{ name: 'image', desc: 'geometry carrying an image' }],
  params: {
    image: imageParam(), name: renameParam(),
    origin: { type: 'ivec2', default: [0, 0], min: -1000000, max: 1000000, desc: 'crop origin in pixels, from the top left; negative origins add zero padding' },
    size: { type: 'ivec2', default: [0, 0], min: 0, max: 8192, desc: 'crop width/height in pixels; 0 = source extent minus origin' },
    resolution: { type: 'ivec2', default: [0, 0], min: 0, max: 8192, desc: 'output width/height; 0 = cropped size on that axis' },
    filter: { type: 'enum', options: ['filtered', 'nearest'], default: 'filtered', desc: 'resampling filter (no resampling when the crop and output sizes match)' },
  },
  outputs: 'selected image replaced by its cropped/resized layers',
  example: { nodes: { img: { type: 'tex_pattern', params: { resolution: [64, 32] } }, out: { type: 'tex_crop', in: ['img'], params: { origin: [8, 4], size: [32, 16] } } }, output: 'out' },
  cook: (ctx) => {
    const { p } = ctx, s = source(ctx, 0, p.image);
    const [x, y] = p.origin, w = p.size[0] || s.img.width - x, h = p.size[1] || s.img.height - y;
    const ow = p.resolution[0] || w, oh = p.resolution[1] || h;
    checkSize(w, h, ctx.type); checkSize(ow, oh, ctx.type);
    const name = outName(ctx), g = s.g.clone();
    const img = cropImage(s.img, x, y, w, h, ow, oh, p.filter === 'nearest', name);
    g.volumes[s.index] = img;
    g.volumes = g.volumes.filter((v) => v === img || v.kind !== 'image' || v.name !== name);
    return g;
  },
});

defineNode({
  type: 'tex_dilate', category: 'texture', packed: 'keep', usesNodeName: NAMED_BY_NODE,
  summary: 'Extend nearest valid image values into an invalid band, preserving opacity by default.',
  description: 'Validity comes from RGBA alpha or an explicit, same-sized mask. Grey images need a mask input. Valid pixels and pixels beyond distance (metres) are untouched. Nearest-site ties prefer the topmost, then leftmost source. No wrapping or colour conversion. Other layers pass through; preserve_alpha keeps every original RGBA alpha value. Uses the same exact distance transform as wide bake padding. The distance is the same real size at any resolution; on an atlas (the "island" and "texel" layers a bake writes) it is that size on every island and a texel only takes values from its own island. The result takes this node\'s name unless name is set.',
  renamed: { radius: 'it is now distance, in metres (a radius of 8 pixels is 8 × texture_size / width: 0.0156 on a 512 pixel, 1 m image)' },
  inputs: [{ name: 'image', desc: 'image to pad' }, { name: 'mask', desc: 'optional explicit validity mask (same dimensions)', optional: true }],
  params: {
    image: imageParam(), layer: layerParam(), name: renameParam(),
    distance: { type: 'float', default: 0.016, min: 0, desc: 'maximum Euclidean distance in metres from a valid source (on an atlas: on every island, whatever its texel density). The default, 16 mm, is 8 pixels only on 512 pixels over 1 m: on another resolution or size it is another number of pixels' },
    mask_image: imageParam('input 1 (the mask)', []), mask_layer: layerParam(), mask_channel: channelParam('luminance'),
    mask_threshold: { type: 'float', default: 0, desc: 'mask values strictly greater than this are valid' },
    preserve_alpha: { type: 'bool', default: true, desc: 'keep original alpha at every RGBA pixel while padding RGB' },
  },
  outputs: 'selected image layer padded; original mask/alpha preserved',
  example: { nodes: { img: { type: 'tex_shape', params: { resolution: 32, falloff: 0 } }, out: { type: 'tex_dilate', in: ['img', 'img'], params: { distance: 0.09 } } }, output: 'out' },
  cook: (ctx) => {
    const { p } = ctx, s = source(ctx, 0, p.image, p.layer);
    let mask: Float32Array;
    if (ctx.hasInput(1)) {
      const m = source(ctx, 1, p.mask_image, p.mask_layer, 'mask_image');
      if (m.img.width !== s.img.width || m.img.height !== s.img.height) throw new NodeError('tex_dilate: mask dimensions must match the source image');
      mask = channel(m.data, m.ch, p.mask_channel);
    } else {
      if (s.ch !== 4) throw new NodeError('tex_dilate: a grey image requires an explicit mask input');
      mask = channel(s.data, s.ch, 'alpha');
    }
    const [out] = runScaled(s.img, [{ data: s.data, ch: s.ch }, { data: mask, ch: 1 }], [s.ch], false, (pl, r) => [dilateImage(pl[0].data, pl[0].ch, r.w, r.h, pl[1].data, p.mask_threshold, Math.min((p.distance / r.tu) * (1 + 1e-6), 8192), p.preserve_alpha, r.aspect)], { coverage: false, skip: (tu, tv) => { const px = (p.distance / tu) * (1 + 1e-6); return !(p.distance > 0) || (px < 1 && px < tv / tu); } });
    return withLayer(s, out, outName(ctx));
  },
});

defineNode({
  type: 'trace_image', category: 'curve',
  summary: 'Trace a thresholded image into closed XY contours, with holes and disconnected components.',
  description: 'Traces pixel-cell boundaries (not a bounding rectangle). Foreground is 4-connected: diagonal contacts stay separate. Simplification is conservative, topology-preserving, and bounded by tolerance in pixels. min_area filters entire foreground components by pixel area, retaining their holes. The full canvas maps to [0,width] × [0,width*height/widthPixels] in XY, including transparent margins. After fill use uv_project {method:"planar",axis:"z",scale:[width,width*heightPixels/widthPixels]}; fill does not preserve contour attributes. More than 1,000,000 boundary edges fails with a hint.',
  inputs: [{ name: 'image', desc: 'geometry carrying the image to trace' }],
  params: {
    image: imageParam(), layer: layerParam(), channel: channelParam(),
    threshold: { type: 'float', default: 0.5, desc: 'values at least this threshold are foreground' },
    tolerance: { type: 'float', default: 0.5, min: 0, max: 8192, desc: 'maximum contour simplification error in source pixels; 0 only removes collinear points' },
    min_area: { type: 'float', default: 0, min: 0, max: MAX_PIXELS, desc: 'minimum connected foreground component area in pixels; 0 retains all components' },
    extent: { type: 'float', default: 0, min: 0, desc: 'full image canvas width in metres; height follows image aspect (0 = the metres the image states it covers: texture_size set on its generator, or a bake; refused when it states none)' },
  },
  renamed: { width: 'it is now extent, in metres (0, the default, = the metres the image states it covers; a width of 1 is an extent of 1)' },
  outputs: 'closed curves; point uv; prim class (component ID), contour_id and hole (0/1); detail image_size and image_width',
  example: { nodes: { img: { type: 'tex_shape', params: { resolution: [64, 32], texture_size: 1, shape: 'disc', falloff: 0 } }, out: { type: 'trace_image', in: ['img'], params: { channel: 'luminance' } } }, output: 'out' },
  cook: (ctx) => {
    const { p } = ctx, s = source(ctx, 0, p.image, p.layer);
    const loops = traceMask(channel(s.data, s.ch, p.channel), s.img.width, s.img.height, p.threshold, p.min_area, p.tolerance);
    if (!(p.extent > 0) && !s.img.sizeStated) throw new NodeError(`trace_image: extent is not set and image "${s.img.name}" does not say how many metres it covers (nothing set its texture_size)`, 'set extent (metres along the image width), or set texture_size on the generator that made the image (a bake writes its own)');
    const extent = p.extent > 0 ? p.extent : s.img.size, b = new GeoBuilder(), scale = extent / s.img.width;
    for (const loop of loops) {
      // Pixel-space winding is reversed by Y-up, so reverse the sequence as well.
      const points = loop.points.slice().reverse().map(([x, y]) => b.addPoint(x * scale, (s.img.height - y) * scale, 0));
      b.addPrim(points, true);
    }
    const g = b.build(), cls = g.prims.add('class', 'int', 1), hole = g.prims.add('hole', 'int', 1), contour = g.prims.add('contour_id', 'int', 1);
    loops.forEach((l, i) => { cls.set(i, l.component); hole.set(i, l.hole ? 1 : 0); contour.set(i, i); });
    const uv = g.points.add('uv', 'float', 3);
    for (let i = 0; i < g.numPoints; i++) uv.set(i, [g.P[i * 3] / extent, g.P[i * 3 + 1] / (s.img.height * scale), 0]);
    g.detail.add('image_size', 'int', 2).set(0, [s.img.width, s.img.height]);
    g.detail.add('image_width', 'float', 1).set(0, extent);
    return g;
  },
});

interface AtlasItem { name: string; maps: Record<string, string> }

defineNode({
  type: 'tex_pack', category: 'texture', usesNodeName: NAMED_BY_NODE,
  summary: 'Pack named images into aligned atlases and output per-item UV placement attributes.',
  description: 'items is [{name:"leaf",maps:{color:"leaf_color",normal:"leaf_normal"}}]. Empty items packs each input image under the channel C. Every item must have the same map labels; images within an item must match dimensions and images within a channel must have matching channel counts. The selected images use their main layer. Native resolution, no rotation/downscaling, zero gutters. Outputs <name>_<channel> images and placement points in item order. rect is [x,y,width,height] in top-left pixels; atlasUV = localUV * uv_scale + uv_offset (V up). Connect the image output to texture_to_material and read placement attributes with a wrangle; do not merge placement points into your mesh. The atlas images carry a texel layer (the own texel size of each item) and an island layer (one island per item, its gutter included, background between them), so the filters after it work in metres on each item and tex_dilate pads inside it. Padding is separate: tex_dilate. Limits: 4096 items, normal per-image pixel limit, at most 1 GiB of output image layers.',
  inputs: [{ name: 'images', desc: 'geometry carrying named source images (combine with merge)' }],
  params: {
    items: { type: 'json', default: [], desc: 'array of {name, maps:{channel:imageName}}; empty = each image becomes one item in channel C' },
    resolution: resolutionParam(2048),
    padding: { type: 'int', default: 8, min: 0, max: 8192, desc: 'empty gutter on every side of each item, in pixels' },
    name: { type: 'string', default: '', desc: 'atlas image name prefix ("" = this node\'s name); images are named <name>_<channel>' },
  },
  outputs: 'atlas images; points with name, rect, uv_offset and uv_scale; detail atlas_size',
  example: { nodes: { a: { type: 'tex_shape', params: { resolution: 32, name: 'disc' } }, b: { type: 'tex_pattern', params: { resolution: [32, 16], name: 'pattern' } }, images: { type: 'merge', in: ['a', 'b'] }, out: { type: 'tex_pack', in: ['images'], params: { resolution: 128, padding: 4 } } }, output: 'out' },
  cook: (ctx) => {
    const { input, p } = ctx;
    const images = imagesOf(input(0)), pool = new Map<string, Image>();
    for (const im of images) {
      if (pool.has(im.name)) throw new NodeError('tex_pack: duplicate input image name "' + im.name + '"');
      pool.set(im.name, im);
    }
    if (!Array.isArray(p.items)) throw new NodeError('tex_pack: items must be an array of {name,maps}');
    const items: AtlasItem[] = p.items.length ? p.items : images.map((im) => ({ name: im.name, maps: { C: im.name } }));
    if (!items.length || items.length > 4096) throw new NodeError('tex_pack: needs 1..4096 items');
    const prefix = outName(ctx);
    const names = new Set<string>();
    let labels: string[] = [];
    const sources = items.map((item, i) => {
      if (!item || typeof item.name !== 'string' || !item.name.trim() || names.has(item.name)) throw new NodeError('tex_pack: item names must be non-empty and unique');
      names.add(item.name);
      if (!item.maps || typeof item.maps !== 'object' || Array.isArray(item.maps)) throw new NodeError('tex_pack: item "' + item.name + '" needs a maps object');
      const keys = Object.keys(item.maps).sort();
      if (!keys.length || keys.some((k) => !k.trim())) throw new NodeError('tex_pack: map labels must not be empty');
      if (i === 0) labels = keys;
      else if (JSON.stringify(keys) !== JSON.stringify(labels)) throw new NodeError('tex_pack: items must have matching map labels');
      const maps = keys.map((key) => {
        const ref = item.maps[key], img = typeof ref === 'string' ? pool.get(ref) : null;
        if (!img) throw new NodeError('tex_pack: missing image "' + ref + '" for ' + item.name + '.' + key);
        if (!img.channels(img.mainLayer)) throw new NodeError('tex_pack: image "' + ref + '" has no valid main layer');
        return img;
      });
      if (maps.some((im) => im.width !== maps[0].width || im.height !== maps[0].height)) throw new NodeError('tex_pack: map dimensions must match within item "' + item.name + '"');
      return maps;
    });
    const [w, h] = p.resolution;
    checkSize(w, h, 'tex_pack');
    const channels = sources[0].map((im) => im.channels(im.mainLayer));
    for (const maps of sources) if (maps.some((im, i) => im.channels(im.mainLayer) !== channels[i])) throw new NodeError('tex_pack: channel counts must match for each map label');
    if (w * h * channels.reduce<number>((a, b) => a + b, 0) > MAX_PIXELS * 16) throw new NodeError('tex_pack: output layers exceed 1 GiB; reduce resolution or channel count');
    const rects = sources.map((maps, id) => ({ id, w: maps[0].width + p.padding * 2, h: maps[0].height + p.padding * 2 }));
    rects.sort((a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h) || b.w * b.h - a.w * a.h || a.id - b.id);
    const places = skylinePack(rects, w, 1, false, h);
    if (!places) throw new NodeError('tex_pack: items and gutters do not fit ' + w + ' × ' + h + '; increase resolution, reduce padding, or resize inputs with tex_crop');
    const g = new Geometry({ positions: items.flatMap(() => [0, 0, 0]) });
    const name = g.points.add('name', 'string', 1), rect = g.points.add('rect', 'int', 4);
    const offset = g.points.add('uv_offset', 'float', 2), scale = g.points.add('uv_scale', 'float', 2);
    // items keep their pixels, so each keeps its own texel size: the atlas says so per texel (layer "texel") and gives every
    // item, with its gutter, an island of its own; its size is that of a typical texel (weighted by pixels)
    const texelL = new Float32Array(w * h * 4), islandL = new Float32Array(w * h).fill(-1);
    for (let k = 0; k < w * h; k++) texelL[k * 4 + 3] = 1;
    const weights: { d: number; w: number }[] = [];
    const atlases = labels.map((label, i) => new Image(w, h, prefix + '_' + label).set('C', new Float32Array(w * h * channels[i])));
    items.forEach((item, i) => {
      const x = places[i].x + p.padding, y = places[i].y + p.padding, iw = sources[i][0].width, ih = sources[i][0].height;
      name.set(i, item.name); rect.set(i, [x, y, iw, ih]); offset.set(i, [x / w, 1 - (y + ih) / h]); scale.set(i, [iw / w, ih / h]);
      g.P[i * 3] = (x + iw / 2) / w; g.P[i * 3 + 1] = 1 - (y + ih / 2) / h;
      const first = sources[i][0], tu = first.texel, tv = first.texel;
      weights.push({ d: first.texel, w: iw * ih });
      for (let row = -p.padding; row < ih + p.padding; row++)
        for (let col = -p.padding; col < iw + p.padding; col++) {
          const px = x + col, py = y + row;
          if (px < 0 || py < 0 || px >= w || py >= h) continue;
          // an item's own texel layer follows its pixels (the gutter takes the nearest edge pixel's)
          const k = py * w + px, sx = Math.min(iw - 1, Math.max(0, col)), sy = Math.min(ih - 1, Math.max(0, row)), tl = first.layer('texel');
          const own = tl && first.channels('texel') === 4 ? tl : null;
          texelL[k * 4] = own ? own[(sy * iw + sx) * 4] : tu; texelL[k * 4 + 1] = own ? own[(sy * iw + sx) * 4 + 1] : tv;
          islandL[k] = i;
        }
      sources[i].forEach((im, c) => {
        const ch = channels[c], data = im.layer(im.mainLayer)!, dest = atlases[c].layer('C')!;
        for (let row = 0; row < ih; row++) dest.set(data.subarray(row * iw * ch, (row + 1) * iw * ch), ((y + row) * w + x) * ch);
      });
    });
    weights.sort((a, b) => a.d - b.d);
    let total = 0;
    for (const q of weights) total += q.w;
    let run = 0, typical = weights[0].d;
    for (const q of weights) { run += q.w; if (run >= total / 2) { typical = q.d; break; } }
    for (const a of atlases) { a.size = typical * w; a.set('texel', texelL).set('island', islandL); }
    g.volumes = atlases;
    g.detail.add('atlas_size', 'int', 2).set(0, [w, h]);
    return g;
  },
});

