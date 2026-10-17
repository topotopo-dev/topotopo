// Image volumes as texture files, without touching a file system: PNG bytes encoded in memory, PNG files read into
// image volumes (image_file, the file node), the "image:<name>" references of material tables, the PNGs a USD export
// writes next to the .usda, and the "textures" export format (every image of a geometry as PNG files in a folder).
// Values are written as round(value × 255) and read as sample / max: see core/image.ts for why no transfer curve is
// applied (colour layers already hold display values; data maps are linear).
import type { Geometry } from '../core/geometry.ts';
import { Image, LUMA, MAX_PIXELS, channelsOf, imageRef, imageToBytes, opaque, referenceableImages } from '../core/image.ts';
import { TEXTURE_SLOTS, mergeMaterialTables } from '../core/materials.ts';
import type { MaterialTable } from '../core/materials.ts';
import { encodePNG } from '../render/png.ts';
import { encodeGreyPNG, zlibStored } from './heightmap.ts';
import { decodePNG } from './png-decode.ts';
import type { PngImage } from './png-decode.ts';
import { baseOf, dirOf, joinPath } from './common.ts';

/**
 * PNG bytes of an image layer ("" = the main layer): 8-bit grey for 1-channel layers, RGBA for 4-channel ones (8 bits
 * per channel). deflate compresses (Node: zlib.deflateSync); without it the PNG uses stored (uncompressed) blocks.
 */
export function imagePNG(img: Image, layer = '', deflate?: (d: Uint8Array) => Uint8Array): Uint8Array {
  const { bytes, channels } = imageToBytes(img, layer, true);
  if (channels === 1) return encodeGreyPNG(bytes, img.width, img.height, 8, deflate);
  return encodePNG(bytes, img.width, img.height, deflate ?? zlibStored);
}

/** How a PNG's channels become layers: see ImageFromPNGOptions. */
export const PNG_LAYERS = ['auto', 'grey', 'rgba'] as const;
export type PngLayers = (typeof PNG_LAYERS)[number];

export interface ImageFromPNGOptions {
  /**
   * 'auto' (default): grey files (1 or 2 channels) give a grey layer C, colour files an RGBA one; 'grey': a grey C
   * (Rec. 709 luminance of a colour file); 'rgba': an RGBA C (grey g as g, g, g). A grey C puts the file's alpha, when
   * it has one, in the grey layer "A" (Houdini's alpha plane).
   */
  layers?: PngLayers;
  /**
   * true (default): the samples are display (sRGB-encoded) values, which colour layers hold too, so they are kept as
   * they are; false: they are linear light, and grey and RGB are encoded to display values (alpha never is).
   */
  srgb?: boolean;
}

/** Display (sRGB-encoded) value of a linear one (io/gltf.ts converts back and forth for glTF's linear factors). */
const toDisplay = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

/** An image volume from a decoded PNG: values = samples / maxValue (16-bit files keep their precision). */
export function imageFromPNG(png: PngImage, name: string, o: ImageFromPNGOptions = {}): Image {
  const n = png.width * png.height, ch = png.channels, d = png.data, max = png.maxValue || 255, k = 1 / max;
  // samples are integers 0..max: tables give every value once (alpha is never converted)
  const lin = new Float32Array(max + 1);
  for (let s = 0; s <= max; s++) lin[s] = s * k;
  const col = o.srgb === false ? Float32Array.from(lin, (_, s) => toDisplay(s * k)) : lin;
  const img = new Image(png.width, png.height, name);
  const mode = o.layers ?? 'auto';
  if (mode === 'grey' || (mode === 'auto' && ch <= 2)) {
    const C = new Float32Array(n);
    if (ch <= 2) for (let i = 0; i < n; i++) C[i] = col[d[i * ch]];
    else for (let i = 0; i < n; i++) { const p = i * ch; C[i] = col[d[p]] * LUMA[0] + col[d[p + 1]] * LUMA[1] + col[d[p + 2]] * LUMA[2]; }
    img.set('C', C);
    if (ch === 2 || ch === 4) {
      const A = new Float32Array(n);
      for (let i = 0; i < n; i++) A[i] = lin[d[i * ch + ch - 1]];
      img.set('A', A);
    }
    return img;
  }
  const a = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const p = i * ch, q = i * 4;
    if (ch <= 2) a[q] = a[q + 1] = a[q + 2] = col[d[p]];
    else { a[q] = col[d[p]]; a[q + 1] = col[d[p + 1]]; a[q + 2] = col[d[p + 2]]; }
    a[q + 3] = ch === 2 || ch === 4 ? lin[d[p + ch - 1]] : 1;
  }
  return img.set('C', a);
}

/** The image name a file gives: its name without folders and extension ("inputs/brick.png" → "brick"). */
export function imageNameOf(path: string): string {
  let p = String(path);
  if (/^\w+:\/\//.test(p)) p = p.split(/[?#]/)[0];
  return baseOf(p.replace(/[\\/]+$/, '')).replace(/\.[^.]*$/, '') || 'image';
}

/**
 * An image volume from the bytes of the PNG file `path` (the image_file node and the file node's .png path), named
 * `name` or after the file (imageNameOf). Errors name the file; images over MAX_PIXELS are refused before decoding.
 */
export function imageFromPNGFile(bytes: Uint8Array, path: string, o: ImageFromPNGOptions & { name?: string } = {}): Image {
  let png: PngImage;
  try { png = decodePNG(bytes, MAX_PIXELS); } catch (e: any) { throw new Error(`"${path}" cannot be read as a PNG image: ${e?.message ?? e}`); }
  return imageFromPNG(png, o.name || imageNameOf(path), o);
}

/** imageFromPNGFile on a file read through `readFile` (usually Host.readFile). */
export async function readImageFile(readFile: (path: string) => Promise<Uint8Array>, path: string, o: ImageFromPNGOptions & { name?: string } = {}): Promise<Image> {
  const bytes = await readFile(path).catch((e: any) => { throw new Error(`cannot read "${path}": ${e?.message ?? e}`); });
  return imageFromPNGFile(bytes, path, o);
}

/** A file-name-safe version of an image name ("" → "image"). */
export function safeFileName(name: string): string {
  return String(name).replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^\.+/, '') || 'image';
}

/** The images a material table references ("image:<name>"), with the slots using each. */
export function referencedImages(t: MaterialTable): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const m of Object.values(t))
    for (const k of TEXTURE_SLOTS) {
      const n = imageRef(m.textures?.[k]);
      if (n === null) continue;
      let s = out.get(n);
      if (!s) out.set(n, (s = new Set()));
      s.add(k);
    }
  return out;
}

/**
 * PNG bytes for every "image:<name>" texture of g's material tables (also those of packed sources), keyed by the
 * texture path as the table writes it; null (with a warning) for a name no image of the geometry carries.
 */
export function imageTextureData(g: Geometry, deflate?: (d: Uint8Array) => Uint8Array, warn?: (msg: string) => void, format = 'export'): Map<string, Uint8Array | null> {
  const table = mergeMaterialTables([g, ...g.packedSources]);
  const refs = referencedImages(table);
  const out = new Map<string, Uint8Array | null>();
  if (!refs.size) return out;
  const imgs = referenceableImages(g);
  for (const name of refs.keys()) {
    const img = imgs.get(name);
    if (!img) {
      warn?.(`${format}: a material references "image:${name}" but the geometry carries no image of that name (${imgs.size ? `images: ${[...imgs.keys()].join(', ')}` : 'no images'}); material exported without it`);
      out.set(`image:${name}`, null);
      continue;
    }
    out.set(`image:${name}`, imagePNG(img, '', deflate));
  }
  return out;
}

export interface TextureFile { path: string; bytes: Uint8Array }

/**
 * PNG files for the "image:<name>" textures of a USD export to `usdPath`: <base>_textures/<name>.png next to it, and
 * the asset path (relative to the .usda) each texture path maps to.
 */
export function usdTextureFiles(g: Geometry, usdPath: string, deflate?: (d: Uint8Array) => Uint8Array, warn?: (msg: string) => void): { files: TextureFile[]; assetPath: Map<string, string> } {
  const data = imageTextureData(g, deflate, warn, 'usda');
  const files: TextureFile[] = [], assetPath = new Map<string, string>();
  if (!data.size) return { files, assetPath };
  const base = baseOf(usdPath).replace(/\.[^.]*$/, '');
  const folder = `${base}_textures`;
  const used = new Set<string>();
  for (const [ref, bytes] of data) {
    if (!bytes) continue;
    let f = safeFileName(ref.slice(6)), k = 1;
    while (used.has(f.toLowerCase())) f = `${safeFileName(ref.slice(6))}_${k++}`;
    used.add(f.toLowerCase());
    files.push({ path: joinPath(dirOf(usdPath), folder, f + '.png'), bytes });
    assetPath.set(ref, `${folder}/${f}.png`);
  }
  return { files, assetPath };
}

export interface TexturesExportOptions {
  deflate?: (d: Uint8Array) => Uint8Array;
  /** also write these layers (or every layer: "*" / "all") as <image>_<layer>.png */
  layers?: string[];
}

/**
 * The "textures" export: every image of g (and of its packed sources, first of each name) as <dir>/<name>.png, plus the
 * requested extra layers. RGBA layers whose alpha is all 1 are still written as RGBA (engines read them either way).
 */
export function texturesExport(g: Geometry, dir: string, o: TexturesExportOptions = {}): { files: TextureFile[]; summary: string } {
  const imgs = referenceableImages(g);
  if (!imgs.size) throw new Error('textures: the geometry holds no image (texture nodes: tex_noise, tex_pattern, bake_ao …)');
  const all = !!o.layers?.some((l) => l === '*' || l === 'all');
  const files: TextureFile[] = [];
  const used = new Set<string>();
  const add = (stem: string, bytes: Uint8Array) => {
    let f = safeFileName(stem), k = 1;
    while (used.has(f.toLowerCase())) f = `${safeFileName(stem)}_${k++}`;
    used.add(f.toLowerCase());
    files.push({ path: joinPath(dir, f + '.png'), bytes });
  };
  const lines: string[] = [];
  for (const [name, img] of imgs) {
    add(name, imagePNG(img, '', o.deflate));
    const main = img.mainLayer;
    const a = img.layer(main);
    const ch = a ? channelsOf(a, img.count) : 1;
    lines.push(`${name} ${img.width}×${img.height} ${ch === 4 ? (opaque(a!, 4) ? 'rgb' : 'rgba') : 'grey'}`);
    for (const l of img.layers.keys()) {
      if (l === main || !(all || o.layers?.includes(l))) continue;
      add(`${name}_${l}`, imagePNG(img, l, o.deflate));
    }
  }
  return { files, summary: `${files.length} PNG file(s) in ${dir}: ${lines.join(', ')}` };
}
