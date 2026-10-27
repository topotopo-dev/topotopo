// General image operations. Pixel coordinates start at the top left; values stay in their source encoding.
import { Image, resizeLayer, samplePixelNearest } from './image.ts';
import { distanceTransform } from './heightfield.ts';

export function cropImage(img: Image, x: number, y: number, w: number, h: number, ow: number, oh: number, nearest: boolean, name: string): Image {
  const out = new Image(ow, oh, name);
  for (const [layer, data] of img.layers) {
    const ch = img.channels(layer), crop = new Float32Array(w * h * ch);
    for (let j = 0; j < h; j++) {
      const sy = y + j;
      if (sy < 0 || sy >= img.height) continue;
      const start = Math.max(0, -x), end = Math.min(w, img.width - x);
      if (end > start) crop.set(data.subarray((sy * img.width + x + start) * ch, (sy * img.width + x + end) * ch), (j * w + start) * ch);
    }
    if (w === ow && h === oh) out.set(layer, crop);
    else if (!nearest) out.set(layer, resizeLayer(crop, ch, w, h, ow, oh, false));
    else {
      const resized = new Float32Array(ow * oh * ch), pixel = new Float32Array(ch);
      for (let j = 0; j < oh; j++) for (let i = 0; i < ow; i++) {
        samplePixelNearest(crop, ch, w, h, (i + 0.5) * w / ow, (j + 0.5) * h / oh, pixel, false);
        resized.set(pixel, (j * ow + i) * ch);
      }
      out.set(layer, resized);
    }
  }
  return out;
}

/** Exact nearest-site padding, sharing the distance transform used by wide bake padding.
 * Ties are deterministic (topmost site, then leftmost). Unreached and valid values are untouched.
 */
export function dilateImage(data: Float32Array, ch: number, w: number, h: number, mask: Float32Array, threshold: number, radius: number, preserveAlpha: boolean): Float32Array {
  const out = data.slice();
  if (!radius) return out;
  const valid = Uint8Array.from(mask, (v) => v > threshold ? 1 : 0);
  if (!valid.some(Boolean) || valid.every(Boolean)) return out;
  const { d2, nearest } = distanceTransform(valid, w, h);
  for (let i = 0; i < valid.length; i++) {
    if (valid[i] || nearest[i] < 0 || d2[i] > radius * radius) continue;
    for (let c = 0; c < ch; c++) if (!(ch === 4 && c === 3 && preserveAlpha)) out[i * ch + c] = data[nearest[i] * ch + c];
  }
  return out;
}

