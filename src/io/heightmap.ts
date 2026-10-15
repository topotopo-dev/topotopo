// Heightmap export for game engines (Unreal Landscape first): a heightfield layer as a 16-bit grey PNG or a RAW
// little-endian uint16 file (.r16), weight/mask layers as 8-bit grey PNGs, and a JSON sidecar with the height range
// and the Unreal import numbers. Pure TypeScript: the PNG encoder writes stored (uncompressed) zlib blocks unless
// the caller passes a deflate function (the Node CLI and MCP server pass zlib.deflateSync).
//
// Layout: pixel (column, row) = sample (i, j): column along +X, row along +Z, row 0 at the field's min Z (the top
// of the image). Unreal mapping (the axis swap Unreal's glTF importer uses): Unreal X = X, Unreal Y = Z,
// Unreal Z = Y, centimetres. A 16-bit value v encodes h = height_min + v / 65535 × (height_max − height_min);
// Unreal reads v as Z = location.z + (v − 32768) × scale.z / 128 cm, so scale.z = range_m × 12800 / 65535
// (≈ range_m / 512 × 100: Z scale 100 spans 512 m) and location.z = 100 × (height_min + 32768 / 65535 × range_m).
import type { Geometry } from '../core/geometry.ts';
import { heightfieldsOf, layerStats } from '../core/heightfield.ts';
import type { Heightfield } from '../core/heightfield.ts';

export type HeightmapFormat = 'png16' | 'r16' | 'mask_png';
export const HEIGHTMAP_FORMATS: HeightmapFormat[] = ['png16', 'r16', 'mask_png'];

export interface HeightmapOptions {
  /** png16/r16: the layer to write (default "height"); mask_png: the layer when `layers` is not given (default "mask"); unreal_landscape: the height layer */
  layer?: string;
  /** mask_png: layers to write, one 8-bit PNG each */
  layers?: string[];
  /** fixed range for png16/r16 (default: the layer's min/max), e.g. to share one range across tiles */
  heightMin?: number;
  heightMax?: number;
  /** which heightfield of the geometry (index, default 0) */
  heightfield?: number;
  /** zlib compressor for PNG data (default: stored, uncompressed blocks) */
  deflate?: (data: Uint8Array) => Uint8Array;
}

export interface HeightmapFile { kind: 'main' | 'sidecar' | 'layer'; layer?: string; bytes: Uint8Array }
export interface HeightmapResult { files: HeightmapFile[]; info: Record<string, any>; summary: string }

// ---------------------------------------------------------------- PNG encoding

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array, start: number, end: number) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zlib stream of stored (uncompressed) deflate blocks: valid everywhere, no compressor needed. */
export function zlibStored(data: Uint8Array): Uint8Array {
  const nblocks = Math.max(1, Math.ceil(data.length / 65535));
  const out = new Uint8Array(2 + data.length + nblocks * 5 + 4);
  out[0] = 0x78; out[1] = 0x01;
  let o = 2;
  for (let b = 0; b < nblocks; b++) {
    const s = b * 65535, len = Math.min(65535, data.length - s);
    out[o++] = b === nblocks - 1 ? 1 : 0;
    out[o++] = len & 255; out[o++] = len >>> 8; out[o++] = ~len & 255; out[o++] = (~len >>> 8) & 255;
    out.set(data.subarray(s, s + len), o);
    o += len;
  }
  let a = 1, bb = 0;
  for (let i = 0; i < data.length; i++) { a = (a + data[i]) % 65521; bb = (bb + a) % 65521; }
  out[o++] = (bb >>> 8) & 255; out[o++] = bb & 255; out[o++] = (a >>> 8) & 255; out[o++] = a & 255;
  return out;
}

/** Encode a grey PNG (colour type 0) from 8- or 16-bit samples (row-major, row 0 = top). */
export function encodeGreyPNG(samples: Uint8Array | Uint16Array, w: number, h: number, bitDepth: 8 | 16, deflate?: (d: Uint8Array) => Uint8Array): Uint8Array {
  const bps = bitDepth / 8, stride = w * bps;
  const raw = new Uint8Array((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (stride + 1) + 1;
    if (bitDepth === 16) for (let x = 0; x < w; x++) { const v = samples[y * w + x]; raw[o + x * 2] = v >>> 8; raw[o + x * 2 + 1] = v & 255; }
    else raw.set((samples as Uint8Array).subarray(y * w, y * w + w), o);
  }
  const idat = deflate ? deflate(raw) : zlibStored(raw);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h);
  ihdr[8] = bitDepth; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const chunks: [string, Uint8Array][] = [['IHDR', ihdr], ['IDAT', idat], ['IEND', new Uint8Array(0)]];
  const out = new Uint8Array(8 + chunks.reduce((s, [, d]) => s + 12 + d.length, 0));
  out.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const odv = new DataView(out.buffer);
  let o = 8;
  for (const [type, data] of chunks) {
    odv.setUint32(o, data.length);
    for (let i = 0; i < 4; i++) out[o + 4 + i] = type.charCodeAt(i);
    out.set(data, o + 8);
    odv.setUint32(o + 8 + data.length, crc32(out, o + 4, o + 8 + data.length));
    o += 12 + data.length;
  }
  return out;
}

// ---------------------------------------------------------------- values

/** Quantise a layer to 16 bits over [min, max] (a flat range writes 32768 everywhere). */
export function quantize16(a: ArrayLike<number>, min: number, max: number): Uint16Array {
  const out = new Uint16Array(a.length);
  const span = max - min;
  if (!(span > 0)) return out.fill(32768);
  const s = 65535 / span;
  for (let i = 0; i < a.length; i++) {
    const v = Math.round((a[i] - min) * s);
    out[i] = v < 0 ? 0 : v > 65535 ? 65535 : v;
  }
  return out;
}

/** Common landscape resolutions Unreal suggests (vertices per side). */
export const UNREAL_SIZES = [127, 253, 505, 1009, 2017, 4033, 8129];

/** Unreal Landscape import settings for a heightfield written over [min, max] metres. */
export function unrealLandscapeInfo(hf: Heightfield, min: number, max: number): Record<string, any> {
  const range = max - min;
  const zScale = range > 0 ? (range * 12800) / 65535 : 100;
  const locZ = 100 * (range > 0 ? min + (32768 / 65535) * range : min);
  const r = (x: number, d = 4) => +x.toFixed(d);
  const nearest = (n: number) => UNREAL_SIZES.reduce((b, s) => (Math.abs(s - n) < Math.abs(b - n) ? s : b), UNREAL_SIZES[0]);
  return {
    axes: 'Unreal X = X, Unreal Y = Z, Unreal Z = Y (centimetres); heightmap column = X, row = Z, row 0 at min Z',
    resolution: [hf.width, hf.height],
    location_cm: [r(hf.origin[0] * 100), r(hf.origin[1] * 100), r(locZ)],
    scale: [r(hf.cellSize * 100), r(hf.cellSize * 100), r(zScale, 6)],
    z_scale_formula: 'scale.z = (height_max - height_min) * 12800 / 65535 (about range_m / 512 * 100; Z scale 100 spans 512 m)',
    world_z_formula: 'Z_cm = location.z + (value - 32768) * scale.z / 128',
    recommended_resolution: hf.width === hf.height && UNREAL_SIZES.includes(hf.width)
      ? 'ok'
      : `Unreal pads or crops other sizes; resample to a recommended size, e.g. heightfield_resample samples [${nearest(hf.width)}, ${nearest(hf.height)}] (sizes: ${UNREAL_SIZES.join(', ')})`,
  };
}

function pickField(g: Geometry, o: HeightmapOptions, format: string): Heightfield {
  const hfs = heightfieldsOf(g);
  if (!hfs.length) throw new Error(`export ${format}: the geometry has no heightfield (create one with heightfield, heightfield_from_mesh or heightfield_from_image; export meshes as glb/obj/usda)`);
  const i = o.heightfield ?? 0;
  if (!(i >= 0 && i < hfs.length)) throw new Error(`export ${format}: heightfield index ${i} out of range (${hfs.length} heightfield(s))`);
  return hfs[i];
}

function needLayer(hf: Heightfield, name: string, format: string): Float32Array {
  const a = hf.layer(name);
  if (!a) throw new Error(`export ${format}: heightfield "${hf.name}" has no layer "${name}" (layers: ${[...hf.layers.keys()].join(', ') || 'none'})`);
  return a;
}

const fmtN = (x: number) => +x.toFixed(4);

/** Export a heightfield as png16 / r16 (+ JSON sidecar) or mask_png (one 8-bit PNG per layer). */
export function heightmapExport(g: Geometry, format: HeightmapFormat, o: HeightmapOptions = {}): HeightmapResult {
  const hf = pickField(g, o, format);
  if (format === 'mask_png') {
    const names = o.layers?.length ? o.layers : [o.layer || 'mask'];
    const files: HeightmapFile[] = names.map((name) => {
      const a = needLayer(hf, name, format);
      const v = new Uint8Array(a.length);
      for (let i = 0; i < a.length; i++) { const x = a[i]; v[i] = !(x > 0) ? 0 : x >= 1 ? 255 : Math.round(x * 255); }
      return { kind: 'layer', layer: name, bytes: encodeGreyPNG(v, hf.width, hf.height, 8, o.deflate) };
    });
    return {
      files,
      info: { format, layers: names, resolution: [hf.width, hf.height], encoding: 'value = round(clamp(layer, 0, 1) * 255)' },
      summary: `${names.length} layer(s) ${names.join(', ')} as 8-bit grey PNG, ${hf.width}×${hf.height} (Unreal: import as landscape weight layers)`,
    };
  }
  const layer = o.layer || 'height';
  const a = needLayer(hf, layer, format);
  const st = layerStats(a)!;
  const min = o.heightMin ?? st.min, max = o.heightMax ?? st.max;
  if (!(max >= min)) throw new Error(`export ${format}: height_max (${max}) is below height_min (${min})`);
  const q = quantize16(a, min, max);
  let bytes: Uint8Array;
  if (format === 'png16') bytes = encodeGreyPNG(q, hf.width, hf.height, 16, o.deflate);
  else {
    bytes = new Uint8Array(q.length * 2);
    for (let i = 0; i < q.length; i++) { bytes[i * 2] = q[i] & 255; bytes[i * 2 + 1] = q[i] >>> 8; }
  }
  const unreal = unrealLandscapeInfo(hf, min, max);
  const info = {
    format, layer, heightfield: hf.name,
    resolution: [hf.width, hf.height], cell_size: hf.cellSize,
    origin: [fmtN(hf.origin[0]), fmtN(hf.origin[1])], size: [fmtN(hf.sizeX), fmtN(hf.sizeZ)],
    height_min: min, height_max: max,
    encoding: format === 'png16'
      ? '16-bit grey PNG; h = height_min + value / 65535 * (height_max - height_min)'
      : 'RAW little-endian uint16, row-major, no header; h = height_min + value / 65535 * (height_max - height_min)',
    clipped: min > st.min || max < st.max,
    unreal,
  };
  const sidecar = new TextEncoder().encode(JSON.stringify(info, null, 2) + '\n');
  return {
    files: [{ kind: 'main', bytes }, { kind: 'sidecar', bytes: sidecar }],
    info,
    summary: `${layer} ${hf.width}×${hf.height}, cell ${fmtN(hf.cellSize)} m, range ${fmtN(min)} .. ${fmtN(max)} m` +
      `; Unreal: scale (${unreal.scale.join(', ')}), location (${unreal.location_cm.join(', ')}) cm` +
      (unreal.recommended_resolution === 'ok' ? '' : `; note: ${unreal.recommended_resolution}`),
  };
}

/** The main file of a heightmap export (exportGeometry's single-file path; the sidecar needs heightmapExport). */
export function heightmapBytes(g: Geometry, format: HeightmapFormat, opts: object = {}): Uint8Array {
  return heightmapExport(g, format, opts as HeightmapOptions).files[0].bytes;
}

/** Output paths for the files of a heightmap export written to `path` (sidecar = same name with .json). */
export function heightmapPaths(path: string, files: HeightmapFile[]): string[] {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const dot = path.lastIndexOf('.');
  const base = dot > cut ? path.slice(0, dot) : path, ext = dot > cut ? path.slice(dot) : '';
  const layerFiles = files.filter((f) => f.kind === 'layer').length;
  return files.map((f) => {
    if (f.kind === 'sidecar') return base + '.json';
    if (f.kind === 'layer' && layerFiles > 1) return `${base}_${(f.layer ?? 'layer').replace(/[^A-Za-z0-9_.-]/g, '_')}${ext || '.png'}`;
    return path;
  });
}
