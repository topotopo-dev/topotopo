// General image operations. Pixel coordinates start at the top left; values stay in their source encoding.
import { Image, resizeLayer, samplePixelNearest } from './image.ts';
import { distanceTransform } from './heightfield.ts';

/**
 * The crop of every layer. The result covers w / width of the source's metres (a crop is the same surface, cut out);
 * resized, its texel layer is scaled to the new texels (w / ow along u, h / oh along v) and its island ids are never
 * averaged.
 */
export function cropImage(img: Image, x: number, y: number, w: number, h: number, ow: number, oh: number, nearest: boolean, name: string): Image {
  const out = new Image(ow, oh, name);
  out.size = img.size * (w / img.width);
  for (const [layer, data] of img.layers) {
    const ch = img.channels(layer), crop = new Float32Array(w * h * ch);
    // what lies beyond the source belongs to no island
    if (layer === 'island') crop.fill(-1);
    for (let j = 0; j < h; j++) {
      const sy = y + j;
      if (sy < 0 || sy >= img.height) continue;
      const start = Math.max(0, -x), end = Math.min(w, img.width - x);
      if (end > start) crop.set(data.subarray((sy * img.width + x + start) * ch, (sy * img.width + x + end) * ch), (j * w + start) * ch);
    }
    if (w === ow && h === oh) out.set(layer, crop);
    else if (!nearest && layer !== 'island') {
      const r = resizeLayer(crop, ch, w, h, ow, oh, false);
      // metres per texel follow the texels: a crop shown on fewer pixels has larger ones
      if (layer === 'texel' && ch === 4) for (let k = 0; k < r.length; k += 4) { r[k] *= w / ow; r[k + 1] *= h / oh; }
      out.set(layer, r);
    }
    else {
      const resized = new Float32Array(ow * oh * ch), pixel = new Float32Array(ch);
      for (let j = 0; j < oh; j++) for (let i = 0; i < ow; i++) {
        samplePixelNearest(crop, ch, w, h, (i + 0.5) * w / ow, (j + 0.5) * h / oh, pixel, false);
        resized.set(pixel, (j * ow + i) * ch);
      }
      if (layer === 'texel' && ch === 4) for (let k = 0; k < resized.length; k += 4) { resized[k] *= w / ow; resized[k + 1] *= h / oh; }
      out.set(layer, resized);
    }
  }
  return out;
}

/** Exact nearest-site padding, sharing the distance transform used by wide bake padding.
 * Ties are deterministic (topmost site, then leftmost). Unreached and valid values are untouched.
 */
export function dilateImage(data: Float32Array, ch: number, w: number, h: number, mask: Float32Array, threshold: number, radius: number, preserveAlpha: boolean, aspect = 1): Float32Array {
  const out = data.slice();
  if (!radius) return out;
  const valid = Uint8Array.from(mask, (v) => v > threshold ? 1 : 0);
  if (!valid.some(Boolean) || valid.every(Boolean)) return out;
  const { d2, nearest } = distanceTransform(valid, w, h, aspect);
  for (let i = 0; i < valid.length; i++) {
    if (valid[i] || nearest[i] < 0 || d2[i] > radius * radius) continue;
    for (let c = 0; c < ch; c++) if (!(ch === 4 && c === 3 && preserveAlpha)) out[i * ch + c] = data[nearest[i] * ch + c];
  }
  return out;
}

