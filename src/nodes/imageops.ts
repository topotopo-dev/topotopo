// General-purpose image extraction, contour tracing, padding and atlas assembly.
import { Geometry, GeoBuilder } from '../core/geometry.ts';
import { Image, imagesOf, toGrey, MAX_PIXELS } from '../core/image.ts';
import { cropImage, dilateImage } from '../core/imageops.ts';
import { traceMask } from '../core/traceimage.ts';
import { skylinePack } from '../core/uv.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import type { ParamDef } from '../graph/types.ts';
import { source, withLayer, checkSize, resolutionParam } from './texture.ts';

const imageParam = (): ParamDef => ({ type: 'string', default: '', desc: 'image name (empty selects the first image)' });
const layerParam = (): ParamDef => ({ type: 'string', default: '', desc: 'layer name (empty selects the main layer)' });
const nameParam = (): ParamDef => ({ type: 'string', default: '', desc: 'output image name (empty keeps the source name)' });
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
  type: 'tex_crop', category: 'texture', packed: 'keep',
  summary: 'Extract an exact pixel rectangle, optionally resize it; all image layers stay aligned.',
  description: 'Origin is [x,y] from the top left. Size 0 on an axis means the remaining source extent; resolution 0 keeps the crop size. Outside pixels are zero, never wrapped. Filtered resize uses area averaging down and bilinear up; nearest preserves discrete masks. Values are not colour-converted. Other geometry/images pass through.',
  inputs: [{ name: 'image', desc: 'geometry carrying an image' }],
  params: {
    image: imageParam(), name: nameParam(),
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
    const name = p.name.trim() || s.img.name, g = s.g.clone();
    const img = cropImage(s.img, x, y, w, h, ow, oh, p.filter === 'nearest', name);
    g.volumes[s.index] = img;
    g.volumes = g.volumes.filter((v) => v === img || v.kind !== 'image' || v.name !== name);
    return g;
  },
});

defineNode({
  type: 'tex_dilate', category: 'texture', packed: 'keep',
  summary: 'Extend nearest valid image values into an invalid band, preserving opacity by default.',
  description: 'Validity comes from RGBA alpha or an explicit, same-sized mask. Grey images need a mask input. Valid pixels and pixels beyond radius are untouched. Nearest-site ties prefer the topmost, then leftmost source. No wrapping or colour conversion. Other layers pass through; preserve_alpha keeps every original RGBA alpha value. Uses the same exact distance transform as wide bake padding.',
  inputs: [{ name: 'image', desc: 'image to pad' }, { name: 'mask', desc: 'optional explicit validity mask (same dimensions)', optional: true }],
  params: {
    image: imageParam(), layer: layerParam(), name: nameParam(),
    radius: { type: 'int', default: 8, min: 0, max: 8192, desc: 'maximum Euclidean distance in pixels from a valid source' },
    mask_image: imageParam(), mask_layer: layerParam(), mask_channel: channelParam('luminance'),
    mask_threshold: { type: 'float', default: 0, desc: 'mask values strictly greater than this are valid' },
    preserve_alpha: { type: 'bool', default: true, desc: 'keep original alpha at every RGBA pixel while padding RGB' },
  },
  outputs: 'selected image layer padded; original mask/alpha preserved',
  example: { nodes: { img: { type: 'tex_shape', params: { resolution: 32, falloff: 0 } }, out: { type: 'tex_dilate', in: ['img', 'img'], params: { radius: 3 } } }, output: 'out' },
  cook: (ctx) => {
    const { p } = ctx, s = source(ctx, 0, p.image, p.layer);
    let mask: Float32Array;
    if (ctx.hasInput(1)) {
      const m = source(ctx, 1, p.mask_image, p.mask_layer);
      if (m.img.width !== s.img.width || m.img.height !== s.img.height) throw new NodeError('tex_dilate: mask dimensions must match the source image');
      mask = channel(m.data, m.ch, p.mask_channel);
    } else {
      if (s.ch !== 4) throw new NodeError('tex_dilate: a grey image requires an explicit mask input');
      mask = channel(s.data, s.ch, 'alpha');
    }
    return withLayer(s, dilateImage(s.data, s.ch, s.img.width, s.img.height, mask, p.mask_threshold, p.radius, p.preserve_alpha), p.name);
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
    width: { type: 'float', default: 1, min: 0.000001, desc: 'full image canvas width in metres; height follows image aspect' },
  },
  outputs: 'closed curves; point uv; prim class (component ID), contour_id and hole (0/1); detail image_size and image_width',
  example: { nodes: { img: { type: 'tex_shape', params: { resolution: [64, 32], shape: 'disc', falloff: 0 } }, out: { type: 'trace_image', in: ['img'], params: { channel: 'luminance' } } }, output: 'out' },
  cook: (ctx) => {
    const { p } = ctx, s = source(ctx, 0, p.image, p.layer);
    const loops = traceMask(channel(s.data, s.ch, p.channel), s.img.width, s.img.height, p.threshold, p.min_area, p.tolerance);
    const b = new GeoBuilder(), scale = p.width / s.img.width;
    for (const loop of loops) {
      // Pixel-space winding is reversed by Y-up, so reverse the sequence as well.
      const points = loop.points.slice().reverse().map(([x, y]) => b.addPoint(x * scale, (s.img.height - y) * scale, 0));
      b.addPrim(points, true);
    }
    const g = b.build(), cls = g.prims.add('class', 'int', 1), hole = g.prims.add('hole', 'int', 1), contour = g.prims.add('contour_id', 'int', 1);
    loops.forEach((l, i) => { cls.set(i, l.component); hole.set(i, l.hole ? 1 : 0); contour.set(i, i); });
    const uv = g.points.add('uv', 'float', 3);
    for (let i = 0; i < g.numPoints; i++) uv.set(i, [g.P[i * 3] / p.width, g.P[i * 3 + 1] / (s.img.height * scale), 0]);
    g.detail.add('image_size', 'int', 2).set(0, [s.img.width, s.img.height]);
    g.detail.add('image_width', 'float', 1).set(0, p.width);
    return g;
  },
});

interface AtlasItem { name: string; maps: Record<string, string> }

defineNode({
  type: 'tex_pack', category: 'texture',
  summary: 'Pack named images into aligned atlases and output per-item UV placement attributes.',
  description: 'items is [{name:"leaf",maps:{color:"leaf_color",normal:"leaf_normal"}}]. Empty items packs each input image under the channel C. Every item must have the same map labels; images within an item must match dimensions and images within a channel must have matching channel counts. The selected images use their main layer. Native resolution, no rotation/downscaling, zero gutters. Outputs <name>_<channel> images and placement points in item order. rect is [x,y,width,height] in top-left pixels; atlasUV = localUV * uv_scale + uv_offset (V up). Connect the image output to texture_to_material and read placement attributes with a wrangle; do not merge placement points into your mesh. Padding is separate: tex_dilate. Limits: 4096 items, normal per-image pixel limit, at most 1 GiB of output image layers.',
  inputs: [{ name: 'images', desc: 'geometry carrying named source images (combine with merge)' }],
  params: {
    items: { type: 'json', default: [], desc: 'array of {name, maps:{channel:imageName}}; empty = each image becomes one item in channel C' },
    resolution: resolutionParam(2048),
    padding: { type: 'int', default: 8, min: 0, max: 8192, desc: 'empty gutter on every side of each item, in pixels' },
    name: { type: 'string', default: 'atlas', desc: 'atlas image name prefix; images are named <name>_<channel>' },
  },
  outputs: 'atlas images; points with name, rect, uv_offset and uv_scale; detail atlas_size',
  example: { nodes: { a: { type: 'tex_shape', params: { resolution: 32, name: 'disc' } }, b: { type: 'tex_pattern', params: { resolution: [32, 16], name: 'pattern' } }, images: { type: 'merge', in: ['a', 'b'] }, out: { type: 'tex_pack', in: ['images'], params: { resolution: 128, padding: 4 } } }, output: 'out' },
  cook: ({ input, p }) => {
    const images = imagesOf(input(0)), pool = new Map<string, Image>();
    for (const im of images) {
      if (pool.has(im.name)) throw new NodeError('tex_pack: duplicate input image name "' + im.name + '"');
      pool.set(im.name, im);
    }
    if (!Array.isArray(p.items)) throw new NodeError('tex_pack: items must be an array of {name,maps}');
    const items: AtlasItem[] = p.items.length ? p.items : images.map((im) => ({ name: im.name, maps: { C: im.name } }));
    if (!items.length || items.length > 4096) throw new NodeError('tex_pack: needs 1..4096 items');
    const prefix = p.name.trim();
    if (!prefix) throw new NodeError('tex_pack: name must not be empty');
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
    const atlases = labels.map((label, i) => new Image(w, h, prefix + '_' + label).set('C', new Float32Array(w * h * channels[i])));
    items.forEach((item, i) => {
      const x = places[i].x + p.padding, y = places[i].y + p.padding, iw = sources[i][0].width, ih = sources[i][0].height;
      name.set(i, item.name); rect.set(i, [x, y, iw, ih]); offset.set(i, [x / w, 1 - (y + ih) / h]); scale.set(i, [iw / w, ih / h]);
      g.P[i * 3] = (x + iw / 2) / w; g.P[i * 3 + 1] = 1 - (y + ih / 2) / h;
      sources[i].forEach((im, c) => {
        const ch = channels[c], data = im.layer(im.mainLayer)!, dest = atlases[c].layer('C')!;
        for (let row = 0; row < ih; row++) dest.set(data.subarray(row * iw * ch, (row + 1) * iw * ch), ((y + row) * w + x) * ch);
      });
    });
    g.volumes = atlases;
    g.detail.add('atlas_size', 'int', 2).set(0, [w, h]);
    return g;
  },
});

