// Textures in the renderer: the "texture" view (images drawn flat, labelled, several as a grid: every image, one image's
// layers, or a material's maps as a strip) and the sampler persp/ortho views use with `textures: true` to show base
// colour maps on meshes with uv. Pixels are drawn with the numbers they hold (as the PNG export writes them); RGBA
// layers sit over a checkerboard where alpha < 1.
import type { Geometry } from '../core/geometry.ts';
import { Image, channelsOf, imageRef, referenceableImages, resizeLayer } from '../core/image.ts';
import { primMaterials, readMaterials } from '../core/materials.ts';
import { drawText, textWidth } from './font.ts';

interface Entry { label: string; img: Image; layer: string }

const SLOT_LABEL: Record<string, string> = { baseColor: 'BASE COLOR', normal: 'NORMAL', roughness: 'ROUGHNESS', orm: 'ORM' };

/**
 * What the texture view shows for a spec: "" = every image (at most 16); an image name = that image (all its layers
 * when it has several); "image/layer" = one layer; a material name (or "material:<name>") = its maps in slot order.
 */
function entriesFor(g: Geometry, spec: string, notes: string[]): Entry[] {
  const imgs = referenceableImages(g);
  const s = String(spec ?? '').trim();
  const table = readMaterials(g);
  const matName = s.startsWith('material:') ? s.slice(9) : !imgs.has(s.split('/')[0]) && table[s] ? s : '';
  if (matName) {
    const m = table[matName];
    if (!m) { notes.push(`texture view: no material "${matName}" (materials: ${Object.keys(table).join(', ') || 'none'})`); return []; }
    const out: Entry[] = [];
    for (const [slot, path] of Object.entries(m.textures ?? {})) {
      const n = imageRef(path);
      const img = n !== null ? imgs.get(n) : undefined;
      if (img) out.push({ label: `${SLOT_LABEL[slot] ?? slot}: ${img.name}`, img, layer: img.mainLayer });
      else notes.push(`texture view: material "${matName}" ${slot} is ${n !== null ? `image "${n}", which the geometry does not carry` : `the file "${path}" (only image volumes are drawn)`}`);
    }
    return out;
  }
  if (s) {
    const [name, layer] = s.split('/');
    const img = imgs.get(name);
    if (!img) { notes.push(`texture view: no image "${name}" (images: ${[...imgs.keys()].join(', ') || 'none'})`); return []; }
    if (layer) {
      if (!img.layers.has(layer)) { notes.push(`texture view: image "${name}" has no layer "${layer}" (layers: ${[...img.layers.keys()].join(', ')})`); return []; }
      return [{ label: `${name}/${layer}`, img, layer }];
    }
    return [...img.layers.keys()].map((l) => ({ label: l === img.mainLayer ? name : `${name}/${l}`, img, layer: l }));
  }
  const all = [...imgs.values()];
  if (all.length > 16) notes.push(`texture view: ${all.length} images, showing the first 16 (name one with texture: "<image>")`);
  return all.slice(0, 16).map((img) => ({ label: img.name, img, layer: img.mainLayer }));
}

/**
 * Draw the texture view into col (W × H RGB floats at SSAA scale ss). Returns the tile label. `spec` is the render
 * option `texture` (see entriesFor).
 */
export function drawTextureView(g: Geometry, col: Float32Array, W: number, H: number, ss: number, spec: string, notes: string[]): string {
  for (let i = 0; i < col.length; i += 3) { col[i] = 0.11; col[i + 1] = 0.115; col[i + 2] = 0.13; }
  const entries = entriesFor(g, spec, notes);
  if (!entries.length) {
    if (!referenceableImages(g).size) notes.push('texture view: the geometry holds no image (texture nodes tex_*, bakes bake_*, heightfield_to_tex)');
    return 'TEXTURE  (NO IMAGE)';
  }
  const n = entries.length, cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols);
  const pad = 6 * ss, labelH = 12 * ss, top = 30 * ss;
  const cw = (W - pad * (cols + 1)) / cols, chh = (H - top - pad * rows - labelH * rows) / rows;
  const scale = n > 4 ? ss : Math.min(2 * ss, Math.max(ss, Math.floor(ss * 1.5)));
  const ranges: string[] = [];
  entries.forEach((e, k) => {
    const cx = pad + (k % cols) * (cw + pad), cy = top + Math.floor(k / cols) * (chh + labelH + pad);
    const a = e.img.layer(e.layer)!, ch = channelsOf(a, e.img.count) || 1;
    // fit the image into the cell keeping its aspect
    const s = Math.min(cw / e.img.width, chh / e.img.height);
    const tw = Math.max(1, Math.floor(e.img.width * s)), th = Math.max(1, Math.floor(e.img.height * s));
    const ox = Math.round(cx + (cw - tw) / 2), oy = Math.round(cy + labelH + (chh - th) / 2);
    const px = resizeLayer(a, ch, e.img.width, e.img.height, tw, th, true);
    let lo = Infinity, hi = -Infinity;
    for (let j = 0; j < th; j++)
      for (let i = 0; i < tw; i++) {
        const x = ox + i, y = oy + j;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const o = (y * W + x) * 3, q = (j * tw + i) * ch;
        let r: number, gg: number, b: number;
        if (ch === 4) {
          const al = Math.max(0, Math.min(1, px[q + 3]));
          const bg = ((Math.floor(i / (8 * ss)) + Math.floor(j / (8 * ss))) & 1) ? 0.42 : 0.3;
          r = px[q] * al + bg * (1 - al); gg = px[q + 1] * al + bg * (1 - al); b = px[q + 2] * al + bg * (1 - al);
          lo = Math.min(lo, px[q], px[q + 1], px[q + 2]); hi = Math.max(hi, px[q], px[q + 1], px[q + 2]);
        } else { r = gg = b = px[q]; lo = Math.min(lo, r); hi = Math.max(hi, r); }
        col[o] = Math.max(0, Math.min(1, r)); col[o + 1] = Math.max(0, Math.min(1, gg)); col[o + 2] = Math.max(0, Math.min(1, b));
      }
    if (lo < -1e-3 || hi > 1 + 1e-3) ranges.push(`${e.label} ${lo.toPrecision(3)}..${hi.toPrecision(3)}`);
    // thin frame and label: name, size, channels
    const fr = [0.55, 0.57, 0.62];
    for (let i = ox - 1; i <= ox + tw; i++) for (const y of [oy - 1, oy + th]) if (i >= 0 && i < W && y >= 0 && y < H) { const o = (y * W + i) * 3; col[o] = fr[0]; col[o + 1] = fr[1]; col[o + 2] = fr[2]; }
    for (let j = oy - 1; j <= oy + th; j++) for (const x of [ox - 1, ox + tw]) if (x >= 0 && x < W && j >= 0 && j < H) { const o = (j * W + x) * 3; col[o] = fr[0]; col[o + 1] = fr[1]; col[o + 2] = fr[2]; }
    let label = `${e.label.toUpperCase()}  ${e.img.width}×${e.img.height} ${ch === 4 ? 'RGBA' : 'GREY'}`;
    while (label.length > 4 && textWidth(label, scale) > cw) label = label.slice(0, -2);
    drawText(col, W, H, Math.round(cx), Math.round(cy), label, [0.9, 0.9, 0.95], scale, true);
  });
  if (ranges.length) notes.push(`texture view: values outside 0..1 are shown clamped (${ranges.slice(0, 4).join(', ')})`);
  return n === 1 ? `TEXTURE  ${entries[0].label.toUpperCase()}` : `TEXTURES  ${n} MAPS`;
}

// ---------------------------------------------------------------- base colour maps on meshes

interface Mip { w: number; h: number; ch: number; data: Float32Array }

/** Base colour maps per prim for persp/ortho views: sample(prim, u, v, lod, out) fills out with RGB and returns true. */
export interface TextureSampler {
  /** true when prim p shows a base colour map */
  has(p: number): boolean;
  /** texels per uv unit² of prim p's map at level 0 (for the per-triangle mip level) */
  texelArea(p: number): number;
  sample(p: number, u: number, v: number, lod: number, out: number[]): void;
  /** number of textured materials */
  materials: number;
}

/** A mip chain of a layer (area-averaged halves, wrapping) down to 1 × 1. */
function mipChain(img: Image, layer: string): Mip[] {
  const a = img.layer(layer)!, ch = channelsOf(a, img.count) || 1;
  const out: Mip[] = [{ w: img.width, h: img.height, ch, data: a }];
  let m = out[0];
  while (m.w > 1 || m.h > 1) {
    const w = Math.max(1, m.w >> 1), h = Math.max(1, m.h >> 1);
    m = { w, h, ch, data: resizeLayer(m.data, ch, m.w, m.h, w, h, true) };
    out.push(m);
  }
  return out;
}

/** The base colour map sampler of g's materials, or null when no prim has an image base colour. */
export function textureSampler(g: Geometry, notes: string[]): TextureSampler | null {
  const pm = primMaterials(g);
  if (!pm) return null;
  const table = readMaterials(g), imgs = referenceableImages(g);
  const byMat = new Map<string, Mip[]>();
  for (const [name, m] of Object.entries(table)) {
    const n = imageRef(m.textures?.baseColor);
    if (n === null) continue;
    const img = imgs.get(n);
    if (!img) { notes.push(`textures: material "${name}" base colour "image:${n}" is not carried by the geometry`); continue; }
    byMat.set(name, mipChain(img, img.mainLayer));
  }
  if (!byMat.size) return null;
  const perPrim: (Mip[] | null)[] = pm.map((m) => byMat.get(m) ?? null);
  const wrap = (i: number, n: number) => ((i % n) + n) % n;
  return {
    materials: byMat.size,
    has: (p) => !!perPrim[p],
    texelArea: (p) => { const m = perPrim[p]![0]; return m.w * m.h; },
    sample(p, u, v, lod, out) {
      const chain = perPrim[p]!;
      const m = chain[Math.max(0, Math.min(chain.length - 1, Math.round(lod)))];
      const x = u * m.w - 0.5, y = (1 - v) * m.h - 0.5;
      const x0 = Math.floor(x), y0 = Math.floor(y), tx = x - x0, ty = y - y0;
      const i0 = wrap(x0, m.w), i1 = wrap(x0 + 1, m.w), j0 = wrap(y0, m.h), j1 = wrap(y0 + 1, m.h);
      const d = m.data, ch = m.ch;
      for (let c = 0; c < 3; c++) {
        const cc = ch === 4 ? c : 0;
        const a = d[(j0 * m.w + i0) * ch + cc], b = d[(j0 * m.w + i1) * ch + cc], e = d[(j1 * m.w + i0) * ch + cc], f = d[(j1 * m.w + i1) * ch + cc];
        const t = a + (b - a) * tx, s = e + (f - e) * tx;
        out[c] = t + (s - t) * ty;
      }
    },
  };
}
