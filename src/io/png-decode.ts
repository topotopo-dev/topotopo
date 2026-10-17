// Minimal PNG decoder (pure TypeScript, no host APIs): non-interlaced grey, grey+alpha, RGB, RGBA and palette
// images at 1/2/4/8/16 bits per channel, with a small inflate (RFC 1950/1951) so it runs anywhere the core runs.
// Used by heightfield_from_image, attribute_from_map and image_file (io/textures.ts), and the glTF importer.

// ---------------------------------------------------------------- inflate

class Bits {
  data: Uint8Array;
  pos: number;
  buf = 0;
  cnt = 0;
  constructor(data: Uint8Array, pos = 0) { this.data = data; this.pos = pos; }
}

function need(s: Bits, n: number): number {
  while (s.cnt < n) {
    if (s.pos >= s.data.length) throw new Error('inflate: unexpected end of compressed data');
    s.buf |= s.data[s.pos++] << s.cnt;
    s.cnt += 8;
  }
  const v = s.buf & ((1 << n) - 1);
  s.buf >>>= n;
  s.cnt -= n;
  return v;
}

interface Huffman { count: Uint16Array; symbol: Uint16Array }

function huffman(lengths: ArrayLike<number>, n: number): Huffman {
  const count = new Uint16Array(16), symbol = new Uint16Array(n), offs = new Uint16Array(16);
  for (let i = 0; i < n; i++) count[lengths[i]]++;
  count[0] = 0;
  for (let len = 1; len < 15; len++) offs[len + 1] = offs[len] + count[len];
  for (let i = 0; i < n; i++) if (lengths[i]) symbol[offs[lengths[i]]++] = i;
  return { count, symbol };
}

function decodeSym(s: Bits, h: Huffman): number {
  let code = 0, first = 0, index = 0;
  for (let len = 1; len < 16; len++) {
    if (s.cnt === 0) {
      if (s.pos >= s.data.length) throw new Error('inflate: unexpected end of compressed data');
      s.buf = s.data[s.pos++];
      s.cnt = 8;
    }
    code |= s.buf & 1;
    s.buf >>>= 1;
    s.cnt--;
    const c = h.count[len];
    if (code - c < first) return h.symbol[index + (code - first)];
    index += c;
    first += c;
    first <<= 1;
    code <<= 1;
  }
  throw new Error('inflate: invalid Huffman code');
}

const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

let FIXED: { lit: Huffman; dist: Huffman } | null = null;
function fixedTables() {
  if (!FIXED) {
    const l = new Uint8Array(288);
    l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288);
    FIXED = { lit: huffman(l, 288), dist: huffman(new Uint8Array(30).fill(5), 30) };
  }
  return FIXED;
}

/** Inflate a raw DEFLATE stream (RFC 1951). sizeHint pre-sizes the output. */
export function inflateRaw(data: Uint8Array, sizeHint = 0, start = 0): Uint8Array {
  const s = new Bits(data, start);
  let out = new Uint8Array(Math.max(1024, sizeHint));
  let n = 0;
  const grow = (extra: number) => {
    if (n + extra <= out.length) return;
    const bigger = new Uint8Array(Math.max(out.length * 2, n + extra));
    bigger.set(out.subarray(0, n));
    out = bigger;
  };
  let last = 0;
  while (!last) {
    last = need(s, 1);
    const type = need(s, 2);
    if (type === 0) {
      s.buf = 0; s.cnt = 0; // stored: byte aligned
      if (s.pos + 4 > data.length) throw new Error('inflate: truncated stored block');
      const len = data[s.pos] | (data[s.pos + 1] << 8), nlen = data[s.pos + 2] | (data[s.pos + 3] << 8);
      if ((len ^ 0xffff) !== nlen) throw new Error('inflate: corrupt stored block length');
      s.pos += 4;
      if (s.pos + len > data.length) throw new Error('inflate: truncated stored block');
      grow(len);
      out.set(data.subarray(s.pos, s.pos + len), n);
      n += len;
      s.pos += len;
      continue;
    }
    let lit: Huffman, dist: Huffman;
    if (type === 1) ({ lit, dist } = fixedTables());
    else if (type === 2) {
      const nlen = need(s, 5) + 257, ndist = need(s, 5) + 1, ncode = need(s, 4) + 4;
      const cl = new Uint8Array(19);
      for (let i = 0; i < ncode; i++) cl[CLORDER[i]] = need(s, 3);
      const clh = huffman(cl, 19);
      const lengths = new Uint8Array(nlen + ndist);
      for (let i = 0; i < nlen + ndist;) {
        const sym = decodeSym(s, clh);
        if (sym < 16) { lengths[i++] = sym; continue; }
        let rep = 0, val = 0;
        if (sym === 16) { if (i === 0) throw new Error('inflate: repeat with no previous length'); val = lengths[i - 1]; rep = 3 + need(s, 2); }
        else if (sym === 17) rep = 3 + need(s, 3);
        else rep = 11 + need(s, 7);
        if (i + rep > nlen + ndist) throw new Error('inflate: too many code lengths');
        while (rep--) lengths[i++] = val;
      }
      lit = huffman(lengths.subarray(0, nlen), nlen);
      dist = huffman(lengths.subarray(nlen), ndist);
    } else throw new Error('inflate: invalid block type 3');
    for (;;) {
      let sym = decodeSym(s, lit);
      if (sym < 256) { grow(1); out[n++] = sym; continue; }
      if (sym === 256) break;
      sym -= 257;
      if (sym >= 29) throw new Error('inflate: invalid length symbol');
      const len = LBASE[sym] + need(s, LEXT[sym]);
      const ds = decodeSym(s, dist);
      if (ds >= 30) throw new Error('inflate: invalid distance symbol');
      const d = DBASE[ds] + need(s, DEXT[ds]);
      if (d > n) throw new Error('inflate: distance too far back');
      grow(len);
      for (let k = 0; k < len; k++, n++) out[n] = out[n - d];
    }
  }
  return out.subarray(0, n);
}

/** Inflate a zlib stream (RFC 1950: 2-byte header, deflate data, Adler-32 not verified). */
export function inflateZlib(data: Uint8Array, sizeHint = 0): Uint8Array {
  if (data.length < 2) throw new Error('zlib: stream too short');
  const cmf = data[0], flg = data[1];
  if ((cmf & 15) !== 8 || ((cmf << 8) | flg) % 31 !== 0) throw new Error('zlib: bad header');
  if (flg & 32) throw new Error('zlib: preset dictionaries are not supported');
  return inflateRaw(data, sizeHint, 2);
}

// ---------------------------------------------------------------- PNG

export interface PngImage {
  width: number;
  height: number;
  /** channels after palette expansion: 1 grey, 2 grey+alpha, 3 RGB, 4 RGBA */
  channels: 1 | 2 | 3 | 4;
  /** bits per channel in the file (palette images report 8) */
  bitDepth: number;
  /** largest sample value (255, 65535, or 2^bitDepth - 1 for low-depth grey) */
  maxValue: number;
  /** samples, row-major, channels interleaved; row 0 is the top of the image */
  data: Uint16Array;
}

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];

/**
 * Decode a PNG file. Throws a readable Error for unsupported or corrupt files, and for images of more than maxPixels
 * pixels before any pixel memory is allocated.
 */
export function decodePNG(bytes: Uint8Array, maxPixels = Infinity): PngImage {
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIG[i]) throw new Error('not a PNG file (bad signature)');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8, width = 0, height = 0, depth = 0, ctype = -1, interlace = 0;
  let palette: Uint8Array | null = null, trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (pos + 8 <= bytes.length) {
    const len = dv.getUint32(pos), type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const body = bytes.subarray(pos + 8, pos + 8 + len);
    if (body.length < len) throw new Error(`PNG chunk ${type} is truncated`);
    if (type === 'IHDR') {
      width = dv.getUint32(pos + 8); height = dv.getUint32(pos + 12);
      depth = body[8]; ctype = body[9]; interlace = body[12];
      if (body[10] !== 0 || body[11] !== 0) throw new Error('PNG uses an unknown compression or filter method');
    } else if (type === 'PLTE') palette = body.slice();
    else if (type === 'tRNS') trns = body.slice();
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!width || !height || ctype < 0) throw new Error('PNG has no IHDR chunk');
  if (interlace) throw new Error('interlaced (Adam7) PNGs are not supported; re-save the image without interlacing');
  const chanOf: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const fileCh = chanOf[ctype];
  if (!fileCh) throw new Error(`unsupported PNG colour type ${ctype}`);
  const okDepth = ctype === 0 ? [1, 2, 4, 8, 16] : ctype === 3 ? [1, 2, 4, 8] : [8, 16];
  if (!okDepth.includes(depth)) throw new Error(`unsupported PNG bit depth ${depth} for colour type ${ctype}`);
  if (ctype === 3 && !palette) throw new Error('palette PNG without a PLTE chunk');
  if (width * height > maxPixels) {
    const side = Math.floor(Math.sqrt(maxPixels));
    throw new Error(`the image is ${width} × ${height} pixels, more than the ${maxPixels.toLocaleString('en-US')} pixels allowed here (e.g. ${side} × ${side}): scale it down`);
  }
  let total = 0;
  for (const c of idat) total += c.length;
  const z = new Uint8Array(total);
  let o = 0;
  for (const c of idat) { z.set(c, o); o += c.length; }
  const bitsPP = fileCh * depth, bpp = Math.max(1, bitsPP >> 3), stride = Math.ceil((width * bitsPP) / 8);
  const raw = inflateZlib(z, (stride + 1) * height);
  if (raw.length < (stride + 1) * height) throw new Error(`PNG image data is truncated (${raw.length} of ${(stride + 1) * height} bytes)`);
  // unfilter in place into rows
  const rows = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? rows[dst + x - bpp] : 0, b = y > 0 ? rows[dst - stride + x] : 0, c = x >= bpp && y > 0 ? rows[dst - stride + x - bpp] : 0;
      let v = raw[src + x];
      switch (ft) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; break; }
        default: throw new Error(`PNG row ${y} has an invalid filter type ${ft}`);
      }
      rows[dst + x] = v & 255;
    }
  }
  // samples
  const n = width * height;
  if (ctype === 3) {
    const hasA = !!trns;
    const ch = hasA ? 4 : 3;
    const out = new Uint16Array(n * ch);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const bit = x * depth, byte = rows[y * stride + (bit >> 3)];
        const idx = depth === 8 ? byte : (byte >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
        const p = (y * width + x) * ch;
        out[p] = palette![idx * 3]; out[p + 1] = palette![idx * 3 + 1]; out[p + 2] = palette![idx * 3 + 2];
        if (hasA) out[p + 3] = idx < trns!.length ? trns![idx] : 255;
      }
    return { width, height, channels: ch as 3 | 4, bitDepth: 8, maxValue: 255, data: out };
  }
  const out = new Uint16Array(n * fileCh);
  const rowLen = width * fileCh;
  if (depth === 16)
    for (let y = 0; y < height; y++)
      for (let r = 0; r < rowLen; r++) out[y * rowLen + r] = (rows[y * stride + r * 2] << 8) | rows[y * stride + r * 2 + 1];
  else if (depth === 8) for (let y = 0; y < height; y++) out.set(rows.subarray(y * stride, y * stride + width * fileCh), y * width * fileCh);
  else
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const bit = x * depth, byte = rows[y * stride + (bit >> 3)];
        out[y * width + x] = (byte >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
      }
  return { width, height, channels: fileCh as 1 | 2 | 3 | 4, bitDepth: depth, maxValue: (1 << depth) - 1, data: out };
}

export type PngChannel = 'luminance' | 'average' | 'r' | 'g' | 'b' | 'a';

/** One channel of a decoded image as floats 0..1 (luminance = Rec. 709 weights; grey images ignore r/g/b). */
export function pngChannel(img: PngImage, channel: PngChannel = 'luminance'): Float32Array {
  const n = img.width * img.height, ch = img.channels, d = img.data, inv = 1 / img.maxValue;
  const out = new Float32Array(n);
  const grey = ch <= 2;
  const alphaIdx = ch === 2 ? 1 : ch === 4 ? 3 : -1;
  for (let i = 0; i < n; i++) {
    const p = i * ch;
    let v: number;
    if (channel === 'a') v = alphaIdx >= 0 ? d[p + alphaIdx] : img.maxValue;
    else if (grey) v = d[p];
    else if (channel === 'r') v = d[p];
    else if (channel === 'g') v = d[p + 1];
    else if (channel === 'b') v = d[p + 2];
    else if (channel === 'average') v = (d[p] + d[p + 1] + d[p + 2]) / 3;
    else v = 0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2];
    out[i] = v * inv;
  }
  return out;
}
