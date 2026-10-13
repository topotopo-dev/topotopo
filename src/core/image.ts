// Images: 2D float grids with named layers (Substance Designer / Houdini COP style textures), carried in
// Geometry.volumes as the volume kind 'image' next to SDFs and heightfields, so they flow through merge, clone,
// subsets, the result cache and fingerprints like any other part of a geometry.
//
//   pixel (i, j)  column i (0 = left), row j (0 = top); layers are row-major: index j * width + i
//   uv            pixel (i, j) covers u in [i/W, (i+1)/W] and v in [1 - (j+1)/H, 1 - j/H]: v points up and row 0 is the
//                 top, so rows go to PNG in order and glTF's flipped texture coordinate (t = 1 - v) needs no flip
//   channels      a layer holds 1 (grey) or 4 (RGBA, interleaved) floats per pixel: length W·H or 4·W·H
//   values        linear floats; maps are 0..1, heights and data may leave that range. Colour is never gamma
//                 encoded in memory: a base colour texture is sRGB-encoded when it is written to a file
//   layers        "C" is the image itself (Houdini COP plane name); nodes add others: "id" (per-cell random value of
//                 patterns and cells), "mask" (bake coverage), "convex" / "concave" (curvature bakes), user layers
//
// Cooked geometry is immutable: clone() gives an image its own layer map but shares the arrays, so a node replaces a
// layer with a new array (set) and never writes into one it did not allocate. This module holds the volume class,
// sampling, resizing, channel conversion, statistics and the inspect summary; generators and filters live in
// core/texture.ts, UV-space baking in core/bake.ts.
import type { Geometry, ImageVolume, Volume } from './geometry.ts';
import type { Vec3 } from './math.ts';

/** Largest image a node may create (pixels). */
export const MAX_PIXELS = 8192 * 8192;
/** The default layer name: the image itself. */
export const MAIN_LAYER = 'C';

const EMPTY_BOUNDS = Object.freeze({
  min: Object.freeze([Infinity, Infinity, Infinity]) as unknown as Vec3,
  max: Object.freeze([-Infinity, -Infinity, -Infinity]) as unknown as Vec3,
});

export class Image implements ImageVolume {
  readonly kind = 'image' as const;
  name: string;
  width: number;
  height: number;
  layers: Map<string, Float32Array>;

  constructor(width: number, height: number, name = 'image', layers?: Map<string, Float32Array>) {
    if (!(Number.isInteger(width) && Number.isInteger(height) && width >= 1 && height >= 1)) throw new Error(`image needs at least 1 × 1 pixels (got ${width} × ${height})`);
    this.width = width;
    this.height = height;
    this.name = name;
    this.layers = layers ?? new Map();
  }

  get count() { return this.width * this.height; }
  /** Images are not placed in space: an empty box, so bbox unions ignore it. */
  get bounds() { return EMPTY_BOUNDS; }

  /** Channels of a layer: 1 or 4 (0 when missing). */
  channels(name: string): 0 | 1 | 4 {
    const a = this.layers.get(name);
    return a ? channelsOf(a, this.count) : 0;
  }

  layer(name: string): Float32Array | undefined { return this.layers.get(name); }

  /** The layer nodes work on by default: "C", else the first layer ("" when there is none). */
  get mainLayer(): string {
    if (this.layers.has(MAIN_LAYER)) return MAIN_LAYER;
    for (const k of this.layers.keys()) return k;
    return '';
  }

  /** Store a layer (1 or 4 channels); throws on a length that is neither. */
  set(name: string, data: Float32Array): this {
    if (!channelsOf(data, this.count)) throw new Error(`image "${this.name}" layer "${name}": ${data.length} values for ${this.width} × ${this.height} pixels (need ${this.count} or ${this.count * 4})`);
    this.layers.set(name, data);
    return this;
  }

  clone(): Image { return new Image(this.width, this.height, this.name, new Map(this.layers)); }

  /** The same size and name without layers. */
  emptyLike(name = this.name): Image { return new Image(this.width, this.height, name); }
}

export function isImage(v: Volume): v is ImageVolume {
  return v.kind === 'image';
}

/** The Image class behind an image volume (wraps foreign implementations of the interface). */
export function asImage(v: ImageVolume): Image {
  return v instanceof Image ? v : new Image(v.width, v.height, v.name, new Map(v.layers));
}

/** The images of a geometry, in volume order. */
export function imagesOf(g: Geometry): Image[] {
  return g.volumes.filter(isImage).map(asImage);
}

/** The image called `name` ("" = the first image), or null. */
export function findImage(g: Geometry, name = ''): Image | null {
  for (const v of g.volumes) if (isImage(v) && (!name || v.name === name)) return asImage(v);
  return null;
}

/** 1 or 4 channels for a layer array of an image with `count` pixels (0 when the length fits neither). */
export function channelsOf(a: ArrayLike<number>, count: number): 0 | 1 | 4 {
  return a.length === count ? 1 : a.length === count * 4 ? 4 : 0;
}

// ---------------------------------------------------------------- colour

/** Linear → sRGB transfer (IEC 61966-2-1), for 8-bit base colour textures. */
export function linearToSrgb(x: number): number {
  if (!(x > 0)) return 0;
  if (x >= 1) return 1;
  return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

/** sRGB → linear transfer. */
export function srgbToLinear(x: number): number {
  if (!(x > 0)) return 0;
  if (x >= 1) return 1;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

/** Rec. 709 luminance weights (grey from RGB). */
export const LUMA = [0.2126, 0.7152, 0.0722];

/** A grey (1-channel) copy of a layer: luminance of RGB for 4 channels, the array itself for 1. */
export function toGrey(a: Float32Array, ch: number): Float32Array {
  if (ch === 1) return a;
  const n = a.length / 4, out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = a[i * 4] * LUMA[0] + a[i * 4 + 1] * LUMA[1] + a[i * 4 + 2] * LUMA[2];
  return out;
}

/** An RGBA (4-channel) copy of a layer: grey becomes (g, g, g, 1); 4 channels are returned as they are. */
export function toRGBA(a: Float32Array, ch: number): Float32Array {
  if (ch === 4) return a;
  const n = a.length, out = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { const v = a[i]; out[i * 4] = v; out[i * 4 + 1] = v; out[i * 4 + 2] = v; out[i * 4 + 3] = 1; }
  return out;
}

/** A layer with `ch` channels (grey ↔ RGBA as needed). */
export function withChannels(a: Float32Array, from: number, to: number): Float32Array {
  return from === to ? a : to === 1 ? toGrey(a, from) : toRGBA(a, from);
}

// ---------------------------------------------------------------- sampling

const wrapI = (i: number, n: number) => ((i % n) + n) % n;
const clampI = (i: number, n: number) => (i < 0 ? 0 : i >= n ? n - 1 : i);

/**
 * Bilinear sample at fractional pixel coordinates (fx, fy) (pixel centres at integer + 0.5 are exact pixels): out
 * receives `ch` values. wrap = true tiles the image (repeat), false clamps to the border.
 */
export function samplePixel(a: Float32Array, ch: number, w: number, h: number, fx: number, fy: number, out: Float32Array | number[], wrap = true): void {
  const x = fx - 0.5, y = fy - 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y), tx = x - x0, ty = y - y0;
  const fix = wrap ? wrapI : clampI;
  const i0 = fix(x0, w), i1 = fix(x0 + 1, w), j0 = fix(y0, h), j1 = fix(y0 + 1, h);
  const k00 = (j0 * w + i0) * ch, k10 = (j0 * w + i1) * ch, k01 = (j1 * w + i0) * ch, k11 = (j1 * w + i1) * ch;
  for (let c = 0; c < ch; c++) {
    const top = a[k00 + c] + (a[k10 + c] - a[k00 + c]) * tx, bot = a[k01 + c] + (a[k11 + c] - a[k01 + c]) * tx;
    out[c] = top + (bot - top) * ty;
  }
}

/** Nearest-pixel sample at fractional pixel coordinates. */
export function samplePixelNearest(a: Float32Array, ch: number, w: number, h: number, fx: number, fy: number, out: Float32Array | number[], wrap = true): void {
  const fix = wrap ? wrapI : clampI;
  const k = (fix(Math.floor(fy), h) * w + fix(Math.floor(fx), w)) * ch;
  for (let c = 0; c < ch; c++) out[c] = a[k + c];
}

/** Bilinear sample at texture coordinates (u, v), v up (v = 1 is row 0). */
export function sampleUV(a: Float32Array, ch: number, w: number, h: number, u: number, v: number, out: Float32Array | number[], wrap = true, nearest = false): void {
  if (nearest) samplePixelNearest(a, ch, w, h, u * w, (1 - v) * h, out, wrap);
  else samplePixel(a, ch, w, h, u * w, (1 - v) * h, out, wrap);
}

/**
 * Resize a layer to nw × nh: bilinear when enlarging, an area average (box filter over the covered source pixels)
 * when shrinking, so a large image scaled down does not alias. wrap: the image tiles (edges blend across).
 */
export function resizeLayer(a: Float32Array, ch: number, w: number, h: number, nw: number, nh: number, wrap = true): Float32Array {
  if (nw === w && nh === h) return a;
  const out = new Float32Array(nw * nh * ch);
  const sx = w / nw, sy = h / nh;
  const tmp = new Float32Array(ch);
  if (sx <= 1 && sy <= 1) {
    for (let j = 0; j < nh; j++)
      for (let i = 0; i < nw; i++) {
        samplePixel(a, ch, w, h, (i + 0.5) * sx, (j + 0.5) * sy, tmp, wrap);
        out.set(tmp, (j * nw + i) * ch);
      }
    return out;
  }
  // area average: each output pixel averages the source pixels its footprint covers (weighted at the borders)
  for (let j = 0; j < nh; j++) {
    const y0 = j * sy, y1 = y0 + Math.max(sy, 1);
    for (let i = 0; i < nw; i++) {
      const x0 = i * sx, x1 = x0 + Math.max(sx, 1);
      let wsum = 0;
      tmp.fill(0);
      for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
        const wy = Math.min(y + 1, y1) - Math.max(y, y0);
        if (wy <= 0) continue;
        const jj = wrap ? wrapI(y, h) : clampI(y, h);
        for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
          const wx = Math.min(x + 1, x1) - Math.max(x, x0);
          if (wx <= 0) continue;
          const k = (jj * w + (wrap ? wrapI(x, w) : clampI(x, w))) * ch, wt = wx * wy;
          for (let c = 0; c < ch; c++) tmp[c] += a[k + c] * wt;
          wsum += wt;
        }
      }
      for (let c = 0; c < ch; c++) out[(j * nw + i) * ch + c] = wsum > 0 ? tmp[c] / wsum : 0;
    }
  }
  return out;
}

// ---------------------------------------------------------------- statistics and summaries

/** Per-channel min / max / mean of a layer (RGBA: four entries). */
export function layerStats(a: Float32Array, ch: number): { min: number[]; max: number[]; mean: number[] } {
  const n = a.length / ch;
  const min = new Array(ch).fill(Infinity), max = new Array(ch).fill(-Infinity), sum = new Array(ch).fill(0);
  for (let i = 0; i < n; i++)
    for (let c = 0; c < ch; c++) {
      const v = a[i * ch + c];
      if (v < min[c]) min[c] = v;
      if (v > max[c]) max[c] = v;
      sum[c] += v;
    }
  return { min, max, mean: sum.map((s) => (n ? s / n : 0)) };
}

const fmt = (x: number) => {
  if (!Number.isFinite(x)) return String(x);
  const a = Math.abs(x);
  if (a >= 1000) return x.toFixed(0);
  if (a >= 10) return x.toFixed(1);
  if (a >= 0.01 || a === 0) return x.toFixed(2);
  return x.toExponential(1);
};

/** One line per image layer description: "C rgba [0.10 .. 0.90]" (RGB range for colour layers, alpha only when not 1). */
export function layerDescription(img: Image, name: string): string {
  const a = img.layers.get(name)!;
  const ch = channelsOf(a, img.count);
  const s = layerStats(a, ch || 1);
  if (ch === 4) {
    const lo = Math.min(s.min[0], s.min[1], s.min[2]), hi = Math.max(s.max[0], s.max[1], s.max[2]);
    const alpha = s.min[3] === 1 && s.max[3] === 1 ? '' : `, alpha ${fmt(s.min[3])} .. ${fmt(s.max[3])}`;
    return `${name} rgba [${fmt(lo)} .. ${fmt(hi)}, mean (${s.mean.slice(0, 3).map(fmt).join(', ')})${alpha}]`;
  }
  return `${name} grey [${fmt(s.min[0])} .. ${fmt(s.max[0])}, mean ${fmt(s.mean[0])}]`;
}

/** Inspect / summary lines for the images of a geometry: size and per-layer channels and ranges. */
export function imageSummary(g: Geometry): string[] {
  const out: string[] = [];
  const imgs = imagesOf(g);
  const max = 16;
  for (const img of imgs.slice(0, max)) {
    const ls = [...img.layers.keys()].map((k) => layerDescription(img, k));
    out.push(`image "${img.name}": ${img.width}×${img.height}, layers: ${ls.length ? ls.join(', ') : '(none)'}`);
  }
  if (imgs.length > max) out.push(`… ${imgs.length - max} more image(s)`);
  return out;
}

/**
 * 8-bit RGBA pixels of an image layer ("" = the main layer): grey → (g, g, g, 255), values clamped to 0..1;
 * srgb encodes RGB with the sRGB transfer (base colour textures), otherwise values are written as they are (data maps).
 */
export function imageToRGBA8(img: Image, layer = '', srgb = false): Uint8Array {
  const name = layer || img.mainLayer;
  const a = img.layers.get(name);
  const n = img.count, out = new Uint8Array(n * 4);
  if (!a) { for (let i = 0; i < n; i++) out[i * 4 + 3] = 255; return out; }
  const ch = channelsOf(a, n);
  const q = (x: number) => (x > 0 ? (x < 1 ? Math.round(x * 255) : 255) : 0);
  const enc = srgb ? (x: number) => q(linearToSrgb(x)) : q;
  // a lookup table for the sRGB curve at 12-bit input precision would be faster; images are written rarely
  for (let i = 0; i < n; i++) {
    if (ch === 4) {
      out[i * 4] = enc(a[i * 4]); out[i * 4 + 1] = enc(a[i * 4 + 1]); out[i * 4 + 2] = enc(a[i * 4 + 2]); out[i * 4 + 3] = q(a[i * 4 + 3]);
    } else {
      const v = enc(a[i]);
      out[i * 4] = v; out[i * 4 + 1] = v; out[i * 4 + 2] = v; out[i * 4 + 3] = 255;
    }
  }
  return out;
}

/** The "image:<name>" texture reference → the image name, or null for a file path. */
export function imageRef(path: string | undefined | null): string | null {
  if (typeof path !== 'string') return null;
  const m = /^image:(.*)$/.exec(path.trim());
  return m ? m[1].trim() : null;
}

/** The images of g and of its packed sources (deduplicated by name, first wins): what a material can reference. */
export function referenceableImages(g: Geometry): Map<string, Image> {
  const out = new Map<string, Image>();
  const add = (x: Geometry) => { for (const img of imagesOf(x)) if (!out.has(img.name)) out.set(img.name, img); };
  add(g);
  for (const s of g.packedSources) add(s);
  return out;
}
