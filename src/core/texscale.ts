// Texture nodes work in metres. The scale an image has comes from two places:
//   - an image with a layer "island" (the uv island of every texel) and, usually, "texel" (metres per texel along u in
//     R and along v in G, as the bakes write them) is an atlas: every island is a surface of its own with its own texel
//     size, so a filter runs once per island, with that island's texel, and never reads across an island border;
//   - any other image (a generator's, a file's) covers `size` metres across and size × height / width down: one texel
//     is size / width along both axes.
// The filters themselves (core/texture.ts, core/texsdf.ts) take texel sizes in metres and know nothing of islands;
// runScaled calls them once for the whole image or once per island.
import type { Image } from './image.ts';
import { gradientMagnitudes } from './texture.ts';

/** One layer (or one input image's layer) a filter reads: 1 or 4 channels per pixel. */
export interface Plane { data: Float32Array; ch: number }

/** The part of an image a filter runs on: the whole image, or one island's box. */
export interface Region {
  w: number; h: number;
  /** the box's top left corner in the whole image, and the whole image's size (positions and hashes are in these) */
  x0: number; y0: number; fullW: number; fullH: number;
  /** metres one texel covers along u and along v, and their geometric mean */
  tu: number; tv: number; texel: number;
  /** tv / tu: how much taller a row is than a column is wide */
  aspect: number;
  /** the region wraps at its borders (only a whole image, never an island) */
  wrap: boolean;
  /** the pixels of the box that belong to the island (null: all of them) */
  own: Uint8Array | null;
}

/** An island of an atlas: its bounding box in pixels, its pixel count and its texel sizes along u and v. */
export interface Island { id: number; x0: number; y0: number; x1: number; y1: number; count: number; tu: number; tv: number }

/** Texel values read per island to find its median. */
const SAMPLES = 1024;

function medianOf(vals: number[]): number {
  if (!vals.length) return 0;
  vals.sort((p, q) => p - q);
  return vals[vals.length >> 1];
}

/**
 * The texel sizes of a whole image in metres along u and v, for the filters that work on it as one: size / width on
 * both axes, or, when the image has a "texel" layer but no islands, the medians of its covered texels.
 */
export function imageTexels(img: Image): { tu: number; tv: number } {
  const t = img.layer('texel');
  if (t && img.channels('texel') === 4 && !img.layer('island')) {
    const cov = img.layer('mask'), n = img.count, stride = Math.max(1, Math.floor(n / (SAMPLES * 4))), us: number[] = [], vs: number[] = [];
    for (let i = 0; i < n; i += stride) {
      if (cov && !(cov[i] > 0)) continue;
      if (t[i * 4] > 0 && t[i * 4 + 1] > 0) { us.push(t[i * 4]); vs.push(t[i * 4 + 1]); }
    }
    const tu = medianOf(us), tv = medianOf(vs);
    if (tu > 0 && tv > 0) return { tu, tv };
  }
  return { tu: img.texel, tv: img.texel };
}

/** The mean texel size (the geometric mean of u and v) of a whole image. */
export function imageTexel(img: Image): number {
  const { tu, tv } = imageTexels(img);
  return Math.sqrt(tu * tv);
}

interface Atlas { islands: Island[]; ids: Float32Array; background: number; index: Int32Array }
const atlasCache = new WeakMap<Float32Array, { texel: Float32Array | undefined; value: Atlas }>();

/** The islands of an atlas (its ascending ids), or null when the image has no "island" layer. */
export function islandsOf(img: Image): Atlas | null {
  const ids = img.layer('island');
  if (!ids || img.channels('island') !== 1) return null;
  const tl = img.layer('texel'), tex = tl && img.channels('texel') === 4 ? tl : undefined;
  const hit = atlasCache.get(ids);
  if (hit && hit.texel === tex) return hit.value;
  const w = img.width, h = img.height, n = w * h;
  let maxId = -1;
  for (let k = 0; k < n; k++) if (ids[k] > maxId) maxId = ids[k];
  if (maxId > 1 << 24) return null;
  // slot of every id: islands in ascending order of id
  const slot = new Int32Array(maxId + 1).fill(-1);
  for (let k = 0; k < n; k++) { const id = ids[k]; if (id >= 0 && slot[id] < 0) slot[id] = 0; }
  const islands: Island[] = [];
  for (let id = 0; id <= maxId; id++) if (slot[id] === 0) { slot[id] = islands.length; islands.push({ id, x0: w, y0: h, x1: -1, y1: -1, count: 0, tu: 0, tv: 0 }); }
  let background = 0;
  for (let j = 0, k = 0; j < h; j++)
    for (let i = 0; i < w; i++, k++) {
      const id = ids[k];
      if (!(id >= 0)) { background++; continue; }
      const s = islands[slot[id]];
      if (i < s.x0) s.x0 = i;
      if (i > s.x1) s.x1 = i;
      if (j < s.y0) s.y0 = j;
      s.y1 = j;
      s.count++;
    }
  const whole = img.texel;
  if (tex) {
    // the texel sizes of an island: the medians over its texels (its padding included: a padded texel has the size of the
    // island it came from), about SAMPLES of them at an even stride
    const us = islands.map(() => [] as number[]), vs = islands.map(() => [] as number[]), seen = new Int32Array(islands.length);
    const stride = islands.map((s) => Math.max(1, Math.floor(s.count / SAMPLES)));
    for (let k = 0; k < n; k++) {
      const id = ids[k];
      if (!(id >= 0)) continue;
      const q = slot[id];
      if (seen[q]++ % stride[q]) continue;
      const u = tex[k * 4], v = tex[k * 4 + 1];
      if (u > 0 && v > 0) { us[q].push(u); vs[q].push(v); }
    }
    islands.forEach((s, q) => { s.tu = medianOf(us[q]) || whole; s.tv = medianOf(vs[q]) || whole; });
  } else for (const s of islands) { s.tu = whole; s.tv = whole; }
  const value = { islands, ids, background, index: slot };
  atlasCache.set(ids, { texel: tex, value });
  return value;
}

/**
 * For each pixel of an island's box, the index in the whole image (width `full`) of the pixel to read: itself for the
 * island's own, else the nearest of its own along its row, else along the nearest row that has any (-1 when it has none).
 */
function sweepSource(own: Uint8Array, w: number, h: number, x0: number, y0: number, full: number): Int32Array {
  const src = new Int32Array(w * h).fill(-1), rowHas = new Uint8Array(h);
  for (let j = 0; j < h; j++) {
    const row = j * w, abs = (y0 + j) * full + x0;
    let last = -1;
    for (let i = 0; i < w; i++) { if (own[row + i]) { last = i; rowHas[j] = 1; } src[row + i] = last < 0 ? -1 : abs + last; }
    let next = -1;
    for (let i = w - 1; i >= 0; i--) {
      if (own[row + i]) next = i;
      else if (next >= 0 && (src[row + i] < 0 || next - i < i - (src[row + i] - abs))) src[row + i] = abs + next;
    }
  }
  // rows with no pixel of the island take the nearest row that has some
  let up = -1;
  const from = new Int32Array(h).fill(-1);
  for (let j = 0; j < h; j++) { if (rowHas[j]) up = j; from[j] = up; }
  let down = -1;
  for (let j = h - 1; j >= 0; j--) {
    if (rowHas[j]) down = j;
    else if (down >= 0 && (from[j] < 0 || down - j < j - from[j])) from[j] = down;
  }
  for (let j = 0; j < h; j++) if (!rowHas[j] && from[j] >= 0) for (let i = 0; i < w; i++) src[j * w + i] = src[from[j] * w + i];
  return src;
}

/**
 * Run a filter at the image's scale. `fn` gets planes (the inputs, all of the image's size) and the Region they are
 * (its size, texel sizes along u and v, whether it wraps, which pixels are its own) and returns one array per entry of
 * `outCh` (channels each).
 *   without islands   fn runs once on the whole image
 *   with islands      fn runs on each island's box (its own texels, no wrap); its result is kept on the island's pixels,
 *                     so nothing is read across a border. The pixels of other islands and of the background in the box
 *                     are copies of the nearest pixel of the island (fill; `fill: false` leaves them 0: the filter then
 *                     weighs by region.own, as a blur does to stay mean-preserving), and a filter that costs per pixel
 *                     skips the ones region.own does not set. Pixels of no island keep the first input's values (when
 *                     the outputs have its channels) or are 0: nothing reads them. `skip` says an island of those texel
 *                     sizes is passed over (the filter would change nothing there): it keeps the first input's values.
 */
export function runScaled(img: Image, inputs: Plane[], outCh: number[], wrap: boolean, fn: (planes: Plane[], r: Region) => Float32Array[], opts: { fill?: boolean; skip?: (tu: number, tv: number) => boolean } = {}): Float32Array[] {
  const w = img.width, h = img.height;
  const found = islandsOf(img);
  if (!found || !found.islands.length) {
    const { tu, tv } = imageTexels(img);
    return fn(inputs, { w, h, x0: 0, y0: 0, fullW: w, fullH: h, tu, tv, texel: tu === tv ? tu : Math.sqrt(tu * tv), aspect: tv / tu, wrap, own: null });
  }
  const { islands, ids, background } = found;
  const fill = opts.fill !== false;
  // a pixel no island takes, or an island `skip` passes over, keeps the first input's values when the outputs have its channels
  const outs = outCh.map((c) => (inputs[0] && inputs[0].ch === c && (background || opts.skip) ? inputs[0].data.slice() : new Float32Array(w * h * c)));
  for (const s of islands) {
    if (opts.skip && opts.skip(s.tu, s.tv)) continue;
    const x0 = s.x0, y0 = s.y0, cw = s.x1 - s.x0 + 1, chh = s.y1 - s.y0 + 1;
    const own = new Uint8Array(cw * chh);
    let foreign = 0;
    for (let j = 0; j < chh; j++) { const row = (y0 + j) * w + x0; for (let i = 0; i < cw; i++) if (ids[row + i] === s.id) own[j * cw + i] = 1; else foreign++; }
    const src = foreign && fill ? sweepSource(own, cw, chh, x0, y0, w) : null;
    const crops: Plane[] = inputs.map((p) => {
      const out = new Float32Array(cw * chh * p.ch), ch = p.ch, d = p.data;
      if (!foreign) { for (let j = 0; j < chh; j++) out.set(d.subarray(((y0 + j) * w + x0) * ch, ((y0 + j) * w + x0 + cw) * ch), j * cw * ch); return { data: out, ch }; }
      if (src) {
        if (ch === 1) for (let k = 0; k < cw * chh; k++) { const q = src[k]; if (q >= 0) out[k] = d[q]; }
        else for (let k = 0; k < cw * chh; k++) { const q = src[k]; if (q >= 0) for (let c = 0; c < ch; c++) out[k * ch + c] = d[q * ch + c]; }
      } else {
        // foreign pixels stay 0: the island's own are copied
        for (let j = 0; j < chh; j++) for (let i = 0; i < cw; i++) { const k = j * cw + i; if (own[k]) { const q = (y0 + j) * w + x0 + i; for (let c = 0; c < ch; c++) out[k * ch + c] = d[q * ch + c]; } }
      }
      return { data: out, ch };
    });
    const res = fn(crops, { w: cw, h: chh, x0, y0, fullW: w, fullH: h, tu: s.tu, tv: s.tv, texel: s.tu === s.tv ? s.tu : Math.sqrt(s.tu * s.tv), aspect: s.tv / s.tu, wrap: false, own: foreign ? own : null });
    for (let o = 0; o < outs.length; o++) {
      const c = outCh[o], r = res[o], out = outs[o];
      for (let j = 0; j < chh; j++) {
        const row = (y0 + j) * w + x0;
        if (!foreign) { out.set(r.subarray(j * cw * c, (j + 1) * cw * c), row * c); continue; }
        const rk = j * cw;
        if (c === 1) { for (let i = 0; i < cw; i++) if (own[rk + i]) out[row + i] = r[rk + i]; }
        else for (let i = 0; i < cw; i++) if (own[rk + i]) { const to = (row + i) * c, k = (rk + i) * c; for (let q = 0; q < c; q++) out[to + q] = r[k + q]; }
      }
    }
  }
  return outs;
}

/**
 * The steepest and the mean slope of a grey layer over the whole image, in value per metre (each texel measured with the
 * texel size of its island), so a warp or a slope blur normalises once for the image, not once per island.
 */
export function slopeFacts(img: Image, grey: Float32Array, wrap: boolean): { max: number; mean: number; px: { max: number; mean: number } | null } {
  const w = img.width, h = img.height, n = w * h;
  const mag = gradientMagnitudes(grey, w, h, wrap);
  const found = islandsOf(img);
  let max = 0, sum = 0, count = 0, maxPx = 0, sumPx = 0;
  const base = imageTexel(img);
  for (let j = 0, k = 0; j < h; j++)
    for (let i = 0; i < w; i++, k++) {
      let t = base;
      if (found) {
        const id = found.ids[k];
        if (!(id >= 0)) continue;
        // the step from one island to the next is no slope of either
        let edge = false;
        for (let dj = -1; dj <= 1 && !edge; dj++) for (let di = -1; di <= 1; di++) { const x = i + di, y = j + dj; if (x >= 0 && y >= 0 && x < w && y < h && found.ids[y * w + x] !== id) { edge = true; break; } }
        if (edge) continue;
        const s = found.islands[found.index[id]];
        t = Math.sqrt(s.tu * s.tv);
      }
      const m = mag[k] / t;
      if (m > max) max = m;
      sum += m; count++;
      if (mag[k] > maxPx) maxPx = mag[k];
      sumPx += mag[k];
    }
  // without islands the image is one region: its own steepest and mean slope in texels, with no conversion to metres and back
  return { max, mean: count ? sum / count : 0, px: found ? null : { max: maxPx, mean: count ? sumPx / count : 0 } };
}
