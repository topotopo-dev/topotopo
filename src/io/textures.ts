// Image volumes as texture files, without touching a file system: PNG bytes encoded in memory, the "image:<name>"
// references of material tables, the PNGs a USD export writes next to the .usda, and the "textures" export format
// (every image of a geometry as PNG files in a folder). Values are written as round(value × 255): see core/image.ts
// for why no transfer curve is applied (colour layers already hold display values; data maps are linear).
import type { Geometry } from '../core/geometry.ts';
import { Image, channelsOf, imageRef, imageToBytes, opaque, referenceableImages } from '../core/image.ts';
import { TEXTURE_SLOTS, mergeMaterialTables } from '../core/materials.ts';
import type { MaterialTable } from '../core/materials.ts';
import { encodePNG } from '../render/png.ts';
import { encodeGreyPNG, zlibStored } from './heightmap.ts';
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
