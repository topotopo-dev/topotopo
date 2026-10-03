// Minimal PNG encoder (RGBA8). The deflate function is injected so the same code works
// with node:zlib (sync) or a browser CompressionStream wrapper.

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

export function encodePNG(rgba: Uint8Array, w: number, h: number, deflate: (data: Uint8Array) => Uint8Array): Uint8Array {
  const raw = new Uint8Array((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  }
  const idat = deflate(raw);
  const chunks: [string, Uint8Array][] = [];
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  chunks.push(['IHDR', ihdr], ['IDAT', idat], ['IEND', new Uint8Array(0)]);
  const total = 8 + chunks.reduce((s, [, d]) => s + 12 + d.length, 0);
  const out = new Uint8Array(total);
  out.set([137, 80, 78, 71, 13, 10, 26, 10]);
  let o = 8;
  const odv = new DataView(out.buffer);
  for (const [type, data] of chunks) {
    odv.setUint32(o, data.length);
    for (let i = 0; i < 4; i++) out[o + 4 + i] = type.charCodeAt(i);
    out.set(data, o + 8);
    odv.setUint32(o + 8 + data.length, crc32(out, o + 4, o + 8 + data.length));
    o += 12 + data.length;
  }
  return out;
}
