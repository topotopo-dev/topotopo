// The layer stack behind tex_layers: a base (colour, roughness, metallic) and layers composed over it, each a mask with
// a colour (or a ramp read at another value), roughness, metallic and height. Everything is composed on the covered
// texels only (the texels of the uv islands, the base's coverage layer): the others are never read or written until the
// maps are padded from the covered ones at the end, so nothing a mask holds outside the islands reaches the result.
//
//   colour modes   normal: mix(below, c, a)   multiply: mix(below, below × c, a)   lighten: mix(below, max(below, c), a)
//                  overlay: mix(below, overlay(below, c), a), overlay as in tex_blend; a = clamp(mask, 0, 1) × opacity
//   roughness      replaced by mix(below, roughness, a), then offset by roughness_offset × a; clamped to 0..1 at the end
//   metallic       replaced by mix(below, metallic, a)
//   height         metres: height × a is added (a negative height is a step down); the normal map is made from the sum
// Expressions that make the masks run elsewhere (core/pixelexpr.ts); this module only composes their values.
import { dilate } from './bake.ts';
import { normalFromHeight } from './texture.ts';

export const COLOR_MODES = ['normal', 'multiply', 'overlay', 'lighten'] as const;
export type ColorMode = (typeof COLOR_MODES)[number];

/** A colour ramp lookup: `n` entries of r, g, b over 0..1 of the position. */
export interface ColorLUT { lut: Float32Array; n: number }

/** One layer, parsed: what to compose where its mask is. */
export interface LayerSpec {
  name: string;
  /** a constant colour, a ramp read at the colour_by value, or none */
  color: [number, number, number] | ColorLUT | null;
  mode: ColorMode;
  opacity: number;
  /** replace roughness / metallic (null = leave), offset roughness, add height (metres) */
  roughness: number | null;
  roughnessOffset: number;
  metallic: number | null;
  height: number;
}

/** The maps under composition, per pixel of the image (only the covered pixels hold meaningful values). */
export interface Stack {
  width: number;
  height: number;
  /** RGBA, 4 per pixel */
  color: Float32Array;
  roughness: Float32Array;
  metallic: Float32Array;
  /** metres */
  relief: Float32Array;
  /** indices of the covered pixels, ascending */
  covered: Uint32Array;
}

const clamp01 = (x: number) => (x > 0 ? (x < 1 ? x : 1) : 0);

/**
 * A stack over the base: colour (RGBA or grey, as the layer's channels say), roughness and metallic (1 channel, or a
 * constant when the array is null) on the pixels where coverage > 0 (all pixels when coverage is null). Values outside
 * the coverage stay 0.
 */
export function startStack(w: number, h: number, base: Float32Array, baseCh: number, roughness: Float32Array | number, metallic: Float32Array | number, coverage: Float32Array | null): Stack {
  const n = w * h;
  let count = 0;
  if (coverage) for (let i = 0; i < n; i++) { if (coverage[i] > 0) count++; } else count = n;
  const covered = new Uint32Array(count);
  let c = 0;
  for (let i = 0; i < n; i++) if (!coverage || coverage[i] > 0) covered[c++] = i;
  const color = new Float32Array(n * 4), rough = new Float32Array(n), metal = new Float32Array(n), relief = new Float32Array(n);
  for (let q = 0; q < count; q++) {
    const i = covered[q];
    if (baseCh === 4) { color[i * 4] = base[i * 4]; color[i * 4 + 1] = base[i * 4 + 1]; color[i * 4 + 2] = base[i * 4 + 2]; color[i * 4 + 3] = base[i * 4 + 3]; }
    else { const v = base[i]; color[i * 4] = v; color[i * 4 + 1] = v; color[i * 4 + 2] = v; color[i * 4 + 3] = 1; }
    rough[i] = typeof roughness === 'number' ? roughness : roughness[i];
    metal[i] = typeof metallic === 'number' ? metallic : metallic[i];
  }
  return { width: w, height: h, color, roughness: rough, metallic: metal, relief, covered };
}

/**
 * Compose one layer. `mask` is its mask expression's value per pixel (read on covered pixels only; clamped to 0..1) and
 * `colorBy` the value that picks the ramp position (null when the colour is not a ramp).
 */
export function applyLayer(s: Stack, L: LayerSpec, mask: Float32Array, colorBy: Float32Array | null): void {
  const { color, roughness, metallic, relief, covered } = s;
  const col = L.color;
  const ramp = col && !Array.isArray(col) ? col : null;
  const flat = col && Array.isArray(col) ? col : null;
  const rough = L.roughness, off = L.roughnessOffset, metal = L.metallic, hgt = L.height, mode = L.mode;
  for (let q = 0; q < covered.length; q++) {
    const i = covered[q];
    const a = clamp01(mask[i]) * L.opacity;
    if (!(a > 0)) continue;
    if (col) {
      let r: number, g: number, b: number;
      if (flat) { r = flat[0]; g = flat[1]; b = flat[2]; }
      else {
        const t = colorBy ? clamp01(colorBy[i]) : 0, k = Math.round(t * (ramp!.n - 1)) * 3;
        r = ramp!.lut[k]; g = ramp!.lut[k + 1]; b = ramp!.lut[k + 2];
      }
      const o = i * 4;
      for (let c = 0; c < 3; c++) {
        const below = color[o + c], v = c === 0 ? r : c === 1 ? g : b;
        let t: number;
        switch (mode) {
          case 'multiply': t = below * v; break;
          case 'lighten': t = below > v ? below : v; break;
          case 'overlay': t = below < 0.5 ? 2 * below * v : 1 - 2 * (1 - below) * (1 - v); break;
          default: t = v;
        }
        color[o + c] = below + (t - below) * a;
      }
    }
    if (rough !== null) roughness[i] += (rough - roughness[i]) * a;
    if (off !== 0) roughness[i] += off * a;
    if (metal !== null) metallic[i] += (metal - metallic[i]) * a;
    if (hgt !== 0) relief[i] += hgt * a;
  }
}

export interface FinishOptions {
  /** occlusion per pixel (ORM red), or null = 1 */
  occlusion: Float32Array | null;
  coverage: Float32Array | null;
  /** texels to pad from the coverage */
  padding: number;
  /** metres the image width covers (one texel is size / width) */
  size: number;
  directx: boolean;
}

export interface FinishedMaps {
  /** RGBA */
  baseColor: Float32Array;
  /** RGBA, tangent space */
  normal: Float32Array;
  /** R occlusion, G roughness, B metallic, A 1 */
  orm: Float32Array;
  /** metres */
  height: Float32Array;
}

/**
 * The maps of a composed stack: base colour, normal (from the summed height at the texel size), ORM and height, each
 * padded from the covered texels (dilate: the nearest covered texel within `padding`, a neutral background beyond).
 * The normal is read from a height padded by at least one texel, so a covered texel at the border of an island does not
 * see the empty ones beside it as a cliff.
 */
export function finishStack(s: Stack, o: FinishOptions): FinishedMaps {
  const { width: w, height: h, covered } = s, n = w * h;
  const cov = o.coverage ?? new Float32Array(n).fill(1);
  const pad = Math.max(0, Math.round(o.padding));
  const baseColor = new Float32Array(n * 4);
  const orm = new Float32Array(n * 4);
  for (let q = 0; q < covered.length; q++) {
    const i = covered[q];
    const c = i * 4;
    baseColor[c] = clamp01(s.color[c]); baseColor[c + 1] = clamp01(s.color[c + 1]); baseColor[c + 2] = clamp01(s.color[c + 2]); baseColor[c + 3] = 1;
    orm[c] = o.occlusion ? clamp01(o.occlusion[i]) : 1; orm[c + 1] = clamp01(s.roughness[i]); orm[c + 2] = clamp01(s.metallic[i]); orm[c + 3] = 1;
  }
  const height = s.relief.slice();
  // the relief outside the islands is 0; pad it from the islands first so no border texel is measured against that
  dilate(height, 1, w, h, cov, Math.max(1, pad), [0]);
  const normal = normalFromHeight(height, w, h, 1, o.size, o.directx, false);
  dilate(baseColor, 4, w, h, cov, pad, [0, 0, 0, 1]);
  dilate(orm, 4, w, h, cov, pad, [1, 0.5, 0, 1]);
  dilate(normal, 4, w, h, cov, pad, [0.5, 0.5, 1, 1]);
  // beyond the padding the height was only a helper for the normal
  const out = s.relief.slice();
  dilate(out, 1, w, h, cov, pad, [0]);
  return { baseColor, normal, orm, height: out };
}
