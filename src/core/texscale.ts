// Texture nodes work in metres. The scale an image has comes from two places:
//   - an image with a layer "island" (the uv island of every texel) and, usually, "texel" (metres per texel along u in
//     R and along v in G, as the bakes write them) is an atlas: every island is a surface of its own with its own texel
//     size, so a filter runs once per island, with that island's texel, and never reads across an island border;
//   - any other image (a generator's, a file's) covers `size` metres with its width: one texel is size / width.
// The filters themselves (core/texture.ts, core/texsdf.ts) take one texel size in metres and know nothing of islands;
// runScaled calls them once for the whole image or once per island.
import type { Image } from './image.ts';
import { edt } from './texsdf.ts';

/** One layer (or one input image's layer) a filter reads: 1 or 4 channels per pixel. */
export interface Plane { data: Float32Array; ch: number }

/** An island of an atlas: its bounding box in pixels, its pixel count and its texel size. */
export interface Island { id: number; x0: number; y0: number; x1: number; y1: number; count: number; texel: number }

/** Pixels around an island's box that a filter may read (every pixel there that is not the island's is a copy of its nearest). */
const MARGIN = 2;
/** Texel values read per island to find its median. */
const SAMPLES = 1024;

/**
 * The texel size of a whole image in metres, for the filters that work on it as one: size / width, or, when the image has
 * a "texel" layer but no islands, the median of its texels (geometric mean of u and v, over covered texels).
 */
export function imageTexel(img: Image): number {
  const t = img.layer('texel');
  if (t && img.channels('texel') === 4 && !img.layer('island')) {
    const m = medianTexel(t, img.layer('mask') ?? null, img.count);
    if (m > 0) return m;
  }
  return img.texel;
}

/** The median of sqrt(u texel × v texel) over the covered pixels (coverage > 0 when given), read at an even stride; 0 when there is none. */
function medianTexel(t: Float32Array, coverage: Float32Array | null, n: number): number {
  const vals: number[] = [], stride = Math.max(1, Math.floor(n / SAMPLES));
  for (let i = 0; i < n; i += stride) {
    if (coverage && !(coverage[i] > 0)) continue;
    const u = t[i * 4], v = t[i * 4 + 1];
    if (u > 0 && v > 0) vals.push(Math.sqrt(u * v));
  }
  return medianOf(vals);
}

function medianOf(vals: number[]): number {
  if (!vals.length) return 0;
  vals.sort((p, q) => p - q);
  return vals[vals.length >> 1];
}

/** The islands of an atlas (its ascending ids), or null when the image has no "island" layer. */
export function islandsOf(img: Image): { islands: Island[]; ids: Float32Array; background: number } | null {
  const ids = img.layer('island');
  if (!ids || img.channels('island') !== 1) return null;
  const w = img.width, h = img.height, n = w * h;
  const byId = new Map<number, Island>();
  let background = 0;
  for (let j = 0, k = 0; j < h; j++)
    for (let i = 0; i < w; i++, k++) {
      const id = ids[k];
      if (!(id >= 0)) { background++; continue; }
      let s = byId.get(id);
      if (!s) { s = { id, x0: i, y0: j, x1: i, y1: j, count: 0, texel: 0 }; byId.set(id, s); }
      if (i < s.x0) s.x0 = i;
      if (i > s.x1) s.x1 = i;
      s.y1 = j;
      s.count++;
    }
  const islands = [...byId.values()].sort((a, b) => a.id - b.id);
  const t = img.layer('texel'), tex = t && img.channels('texel') === 4 ? t : null;
  const whole = img.texel;
  if (tex) {
    // the texel size of an island: the median over its texels (its padding included: a padded texel has the size of the
    // island it came from), about SAMPLES of them at an even stride
    const recs = new Map<number, { vals: number[]; stride: number; seen: number }>();
    let last = -2, rec = { vals: [] as number[], stride: 1, seen: 0 };
    for (let k = 0; k < n; k++) {
      const id = ids[k];
      if (!(id >= 0)) continue;
      if (id !== last) {
        last = id;
        let r = recs.get(id);
        if (!r) { r = { vals: [], stride: Math.max(1, Math.floor(byId.get(id)!.count / SAMPLES)), seen: 0 }; recs.set(id, r); }
        rec = r;
      }
      if (rec.seen++ % rec.stride === 0) { const u = tex[k * 4], v = tex[k * 4 + 1]; if (u > 0 && v > 0) rec.vals.push(Math.sqrt(u * v)); }
    }
    for (const s of islands) s.texel = medianOf(recs.get(s.id)?.vals ?? []) || whole;
  } else for (const s of islands) s.texel = whole;
  return { islands, ids, background };
}

/**
 * Run a filter at the image's scale. `fn` gets planes (the inputs, all of the image's size), the size of the region,
 * its texel size in metres and whether it wraps, and returns one array per entry of `outCh` (channels each).
 *   without islands   fn runs once on the whole image, with imageTexel and `wrap`
 *   with islands      fn runs on each island's box (its own texel, no wrap), where the pixels of other islands and the
 *                     background are copies of the nearest pixel of the island, so nothing leaks across a border; its
 *                     result is kept on the island's pixels. The pixels of no island get the result of one run on the
 *                     whole image (only when there are some).
 */
export function runScaled(img: Image, inputs: Plane[], outCh: number[], wrap: boolean, fn: (planes: Plane[], w: number, h: number, texel: number, wrap: boolean) => Float32Array[]): Float32Array[] {
  const w = img.width, h = img.height;
  const found = islandsOf(img);
  if (!found || !found.islands.length) return fn(inputs, w, h, imageTexel(img), wrap);
  const { islands, ids, background } = found;
  const outs = outCh.map((c) => new Float32Array(w * h * c));
  if (background) {
    const base = fn(inputs, w, h, img.texel, false);
    for (let o = 0; o < outs.length; o++) outs[o].set(base[o]);
  }
  for (const s of islands) {
    const x0 = Math.max(0, s.x0 - MARGIN), y0 = Math.max(0, s.y0 - MARGIN), x1 = Math.min(w - 1, s.x1 + MARGIN), y1 = Math.min(h - 1, s.y1 + MARGIN);
    const cw = x1 - x0 + 1, chh = y1 - y0 + 1;
    // which crop pixels are the island's, and for the others the nearest of them
    const mine = new Uint8Array(cw * chh);
    let foreign = 0;
    for (let j = 0; j < chh; j++) for (let i = 0; i < cw; i++) { const own = ids[(y0 + j) * w + x0 + i] === s.id; mine[j * cw + i] = own ? 1 : 0; if (!own) foreign++; }
    const near = foreign ? edt(mine, cw, chh, false).nearest : null;
    const crops: Plane[] = inputs.map((p) => {
      const out = new Float32Array(cw * chh * p.ch);
      for (let j = 0; j < chh; j++)
        for (let i = 0; i < cw; i++) {
          const k = j * cw + i, src = near && !mine[k] && near[k] >= 0 ? near[k] : k;
          const sj = Math.floor(src / cw), si = src - sj * cw, from = ((y0 + sj) * w + x0 + si) * p.ch;
          for (let c = 0; c < p.ch; c++) out[k * p.ch + c] = p.data[from + c];
        }
      return { data: out, ch: p.ch };
    });
    const res = fn(crops, cw, chh, s.texel, false);
    for (let o = 0; o < outs.length; o++) {
      const c = outCh[o], r = res[o];
      for (let j = 0; j < chh; j++)
        for (let i = 0; i < cw; i++) {
          const k = j * cw + i;
          if (!mine[k]) continue;
          const to = ((y0 + j) * w + x0 + i) * c;
          for (let q = 0; q < c; q++) outs[o][to + q] = r[k * c + q];
        }
    }
  }
  return outs;
}
