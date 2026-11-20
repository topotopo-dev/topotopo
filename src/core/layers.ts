// The layer stack behind tex_layers: a base (colour, roughness, metallic) and layers composed over it, each a mask with
// a colour (or a ramp read at another value), roughness, metallic and height. Everything is composed on the covered
// texels only (the texels of the uv islands, the base's coverage layer): the others are never read or written until the
// maps are padded from the covered ones at the end, so nothing a mask holds outside the islands reaches the result.
//
//   colour modes   normal: mix(below, c, a)   multiply: mix(below, below × c, a)   lighten: mix(below, max(below, c), a)
//                  overlay: mix(below, overlay(below, c), a), overlay as in tex_blend; a = clamp(mask, 0, 1) × opacity
//   roughness      replaced by mix(below, roughness, a), then offset by roughness_offset × a; clamped to 0..1 after each layer
//   metallic       replaced by mix(below, metallic, a)
//   height         metres: height × a is added (a negative height is a step down); the normal map is made from the sum
//   signed         a layer with signed reads its mask as -1..1 for roughness_offset and height only (a stronger or weaker
//                  roughness, a bump or a dent, from one mask); colour, roughness and metallic still read it as 0..1
// Expressions that make the masks run elsewhere (core/pixelexpr.ts); this module only composes their values.
import { applyPadding, paddingMap } from './bake.ts';

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
  /** the mask is read as -1..1 for roughness_offset and height */
  signed: boolean;
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
  /** tangent-space normal (RGBA, OpenGL) under the height: the base's normal map and the layers' image normals, or null when none */
  normal: Float32Array | null;
}

/** Per-texel values a layer takes from an image instead of its constants (each of the base's size, or null). */
export interface LayerSource {
  /** RGBA colour */
  color: Float32Array | null;
  roughness: Float32Array | null;
  /** RGBA tangent-space normal (OpenGL) */
  normal: Float32Array | null;
}

const clamp01 = (x: number) => (x > 0 ? (x < 1 ? x : 1) : 0);

/** The indices of the pixels where coverage > 0 (all pixels when coverage is null). */
export function coveredIndices(coverage: Float32Array | null, n: number): Uint32Array {
  let count = 0;
  if (coverage) for (let i = 0; i < n; i++) { if (coverage[i] > 0) count++; } else count = n;
  const covered = new Uint32Array(count);
  let c = 0;
  for (let i = 0; i < n; i++) if (!coverage || coverage[i] > 0) covered[c++] = i;
  return covered;
}

/**
 * A stack over the base: colour (RGBA or grey, as the layer's channels say), roughness and metallic (1 channel, or a
 * constant when a number) on the covered pixels. Values outside the coverage stay 0.
 */
export function startStack(w: number, h: number, base: Float32Array, baseCh: number, roughness: Float32Array | number, metallic: Float32Array | number, covered: Uint32Array, normal: Float32Array | null = null): Stack {
  const n = w * h, count = covered.length;
  const color = new Float32Array(n * 4), rough = new Float32Array(n), metal = new Float32Array(n), relief = new Float32Array(n);
  for (let q = 0; q < count; q++) {
    const i = covered[q];
    if (baseCh === 4) { color[i * 4] = base[i * 4]; color[i * 4 + 1] = base[i * 4 + 1]; color[i * 4 + 2] = base[i * 4 + 2]; color[i * 4 + 3] = base[i * 4 + 3]; }
    else { const v = base[i]; color[i * 4] = v; color[i * 4 + 1] = v; color[i * 4 + 2] = v; color[i * 4 + 3] = 1; }
    rough[i] = typeof roughness === 'number' ? roughness : roughness[i];
    metal[i] = typeof metallic === 'number' ? metallic : metallic[i];
  }
  let nrm: Float32Array | null = null;
  if (normal) {
    nrm = new Float32Array(n * 4);
    for (let q = 0; q < count; q++) { const o = covered[q] * 4; nrm[o] = normal[o]; nrm[o + 1] = normal[o + 1]; nrm[o + 2] = normal[o + 2]; nrm[o + 3] = 1; }
  }
  return { width: w, height: h, color, roughness: rough, metallic: metal, relief, covered, normal: nrm };
}

/**
 * Compose one layer. `mask` is its mask expression's value per pixel (read on covered pixels only; clamped to 0..1, or
 * -1..1 for roughness_offset and height of a signed layer) and `colorBy` the value that picks the ramp position (null
 * when the colour is not a ramp).
 */
export function applyLayer(s: Stack, L: LayerSpec, mask: Float32Array, colorBy: Float32Array | null, src: LayerSource | null = null): void {
  const { color, roughness, metallic, relief, covered } = s;
  const srcC = src?.color ?? null, srcR = L.roughness === null ? src?.roughness ?? null : null, srcN = src?.normal ?? null, nrm = s.normal;
  const col = L.color;
  const lut = col && !Array.isArray(col) ? col.lut : null, lutMax = col && !Array.isArray(col) ? col.n - 1 : 0;
  const flat = col && Array.isArray(col) ? col : null;
  const fr = flat ? flat[0] : 0, fg = flat ? flat[1] : 0, fb = flat ? flat[2] : 0;
  const rough = L.roughness, off = L.roughnessOffset, metal = L.metallic, hgt = L.height, op = L.opacity, signed = L.signed;
  const mode = L.mode === 'multiply' ? 1 : L.mode === 'lighten' ? 2 : L.mode === 'overlay' ? 3 : 0;
  const hasRough = rough !== null || !!srcR, hasMetal = metal !== null, offsets = off !== 0 || hgt !== 0, count = covered.length;
  for (let q = 0; q < count; q++) {
    const i = covered[q];
    const m = mask[i];
    const a = (m > 0 ? (m < 1 ? m : 1) : 0) * op;
    // a signed layer reads its mask as -1..1 for the offset and the height
    const sa = signed ? (m > -1 ? (m < 1 ? m : 1) : -1) * op : a;
    if (!(a > 0)) { if (!(signed && offsets && sa !== 0)) continue; }
    else {
      if (col || srcC) {
        let r = fr, g = fg, b = fb;
        if (srcC) { r = srcC[i * 4]; g = srcC[i * 4 + 1]; b = srcC[i * 4 + 2]; }
        else if (lut) {
          const t = colorBy ? colorBy[i] : 0, k = Math.round((t > 0 ? (t < 1 ? t : 1) : 0) * lutMax) * 3;
          r = lut[k]; g = lut[k + 1]; b = lut[k + 2];
        }
        const o = i * 4, br = color[o], bg = color[o + 1], bb = color[o + 2];
        let tr: number, tg: number, tb: number;
        switch (mode) {
          case 1: tr = br * r; tg = bg * g; tb = bb * b; break;
          case 2: tr = br > r ? br : r; tg = bg > g ? bg : g; tb = bb > b ? bb : b; break;
          case 3:
            tr = br < 0.5 ? 2 * br * r : 1 - 2 * (1 - br) * (1 - r);
            tg = bg < 0.5 ? 2 * bg * g : 1 - 2 * (1 - bg) * (1 - g);
            tb = bb < 0.5 ? 2 * bb * b : 1 - 2 * (1 - bb) * (1 - b);
            break;
          default: tr = r; tg = g; tb = b;
        }
        color[o] = br + (tr - br) * a; color[o + 1] = bg + (tg - bg) * a; color[o + 2] = bb + (tb - bb) * a;
      }
      if (hasRough) roughness[i] += ((srcR ? srcR[i] : rough!) - roughness[i]) * a;
      if (hasMetal) metallic[i] += (metal - metallic[i]) * a;
      if (srcN && nrm) {
        // the normal turns toward the image's by the mask (renormalised)
        const o = i * 4;
        let x = nrm[o] * 2 - 1, y = nrm[o + 1] * 2 - 1, z = nrm[o + 2] * 2 - 1;
        x += (srcN[o] * 2 - 1 - x) * a; y += (srcN[o + 1] * 2 - 1 - y) * a; z += (srcN[o + 2] * 2 - 1 - z) * a;
        const l = Math.hypot(x, y, z) || 1;
        nrm[o] = 0.5 + (0.5 * x) / l; nrm[o + 1] = 0.5 + (0.5 * y) / l; nrm[o + 2] = 0.5 + (0.5 * z) / l;
      }
    }
    if (off !== 0) roughness[i] += off * sa;
    if (hgt !== 0) relief[i] += hgt * sa;
    if (hasRough || off !== 0) { const v = roughness[i]; roughness[i] = v > 0 ? (v < 1 ? v : 1) : 0; }
  }
}

export interface FinishOptions {
  /** occlusion per pixel (ORM red), or null = 1 */
  occlusion: Float32Array | null;
  coverage: Float32Array | null;
  /** texels to pad from the coverage */
  padding: number;
  /** metres one texel covers along u and v, per texel (bake_material's layer "texel"), or null */
  texel: { u: Float32Array; v: Float32Array } | null;
  /** without a texel layer: metres the image width covers (one texel is size / width along both axes) */
  size: number;
  /** the uv island of every texel: the normal only reads neighbours of its own island (null = one island) */
  island: Float32Array | null;
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
 * Tangent-space normal map (RGBA, OpenGL unless directx) of the covered texels from a height in metres: the Sobel step
 * of the height per texel divided by the metres one texel covers there (along u for the column step, along v for the
 * row step). A neighbour that is not covered, or lies on another island, reads as the texel's own height, so a step on
 * one island leaves its neighbour in the atlas flat. Other texels are (0.5, 0.5, 1).
 */
export function normalFromRelief(relief: Float32Array, w: number, h: number, covered: Uint32Array, o: { coverage: Float32Array | null; island: Float32Array | null; texel: { u: Float32Array; v: Float32Array } | null; size: number; directx: boolean }): Float32Array {
  const out = new Float32Array(w * h * 4);
  for (let i = 0; i < out.length; i += 4) { out[i] = 0.5; out[i + 1] = 0.5; out[i + 2] = 1; out[i + 3] = 1; }
  const { coverage, island } = o;
  const fallback = o.size > 0 ? o.size / w : 0;
  const sd = o.directx ? -1 : 1;
  const nb = new Float64Array(9);
  for (let q = 0; q < covered.length; q++) {
    const k = covered[q], i = k % w, j = (k - i) / w;
    const h0 = relief[k], isl = island ? island[k] : 0;
    let any = false;
    for (let dj = -1; dj <= 1; dj++) {
      const jj = j + dj < 0 ? 0 : j + dj >= h ? h - 1 : j + dj;
      for (let di = -1; di <= 1; di++) {
        const ii = i + di < 0 ? 0 : i + di >= w ? w - 1 : i + di;
        const m = jj * w + ii;
        const ok = m === k || ((!coverage || coverage[m] > 0) && (!island || island[m] === isl));
        const v = ok ? relief[m] : h0;
        if (v !== h0) any = true;
        nb[(dj + 1) * 3 + di + 1] = v;
      }
    }
    if (!any) continue;
    const gx = (nb[2] + 2 * nb[5] + nb[8] - nb[0] - 2 * nb[3] - nb[6]) / 8, gy = (nb[6] + 2 * nb[7] + nb[8] - nb[0] - 2 * nb[1] - nb[2]) / 8;
    const tu = o.texel ? o.texel.u[k] : fallback, tv = o.texel ? o.texel.v[k] : fallback;
    const nx = tu > 0 ? -gx / tu : 0, ny = tv > 0 ? (gy / tv) * sd : 0;
    const l = Math.sqrt(nx * nx + ny * ny + 1), p = k * 4;
    out[p] = 0.5 + (0.5 * nx) / l; out[p + 1] = 0.5 + (0.5 * ny) / l; out[p + 2] = 0.5 + 0.5 / l;
  }
  return out;
}

/**
 * The relief's normal laid over a normal map (both RGBA, OpenGL, tangent space) on the covered texels, by the whiteout
 * blend: n = normalize(b.xy + r.xy, b.z · r.z), so a flat relief keeps the map exactly and a chip tilts the detail
 * with it. directx flips the green channel of the result. Writes into `relief` and returns it.
 */
export function overlayNormals(base: Float32Array, relief: Float32Array, covered: Uint32Array, directx: boolean): Float32Array {
  for (let q = 0; q < covered.length; q++) {
    const o = covered[q] * 4;
    const bx = base[o] * 2 - 1, by = base[o + 1] * 2 - 1, bz = base[o + 2] * 2 - 1;
    const rx = relief[o] * 2 - 1, ry = relief[o + 1] * 2 - 1, rz = relief[o + 2] * 2 - 1;
    const x = bx + rx, y = by + ry, z = bz * rz, l = Math.hypot(x, y, z) || 1;
    relief[o] = 0.5 + (0.5 * x) / l; relief[o + 1] = 0.5 + (0.5 * y * (directx ? -1 : 1)) / l; relief[o + 2] = 0.5 + (0.5 * z) / l;
  }
  return relief;
}

/**
 * The maps of a composed stack: base colour, normal (from the summed height, see normalFromRelief), ORM and height,
 * each padded from the covered texels through one padding map (the nearest covered texel within `padding`, a neutral
 * background beyond).
 */
export function finishStack(s: Stack, o: FinishOptions): FinishedMaps {
  const { width: w, height: h, covered } = s, n = w * h;
  const pad = Math.max(0, Math.round(o.padding));
  const baseColor = new Float32Array(n * 4);
  const orm = new Float32Array(n * 4);
  for (let q = 0; q < covered.length; q++) {
    const i = covered[q];
    const c = i * 4;
    baseColor[c] = clamp01(s.color[c]); baseColor[c + 1] = clamp01(s.color[c + 1]); baseColor[c + 2] = clamp01(s.color[c + 2]); baseColor[c + 3] = 1;
    orm[c] = o.occlusion ? clamp01(o.occlusion[i]) : 1; orm[c + 1] = clamp01(s.roughness[i]); orm[c + 2] = clamp01(s.metallic[i]); orm[c + 3] = 1;
  }
  let normal = normalFromRelief(s.relief, w, h, covered, { coverage: o.coverage, island: o.island, texel: o.texel, size: o.size, directx: s.normal ? false : o.directx });
  if (s.normal) normal = overlayNormals(s.normal, normal, covered, o.directx);
  const height = s.relief;
  if (o.coverage) {
    const map = paddingMap(o.coverage, w, h, pad);
    applyPadding(baseColor, 4, map, [0, 0, 0, 1]);
    applyPadding(orm, 4, map, [1, 0.5, 0, 1]);
    applyPadding(normal, 4, map, [0.5, 0.5, 1, 1]);
    applyPadding(height, 1, map, [0]);
  }
  return { baseColor, normal, orm, height };
}
