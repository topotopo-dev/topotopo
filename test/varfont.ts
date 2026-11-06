// A minimal variable TrueType font for tests, built byte by byte so it needs no font file in the repository: one glyph
// "I", a bar 100 units wide at the default weight 400, whose width follows a wght axis 100..900 (20 units at 100, 300
// at 900; linear in between on each side). It has the tables opentype.js reads (cmap, glyf, head, hhea, hmtx, loca,
// maxp, name, post) and fvar + gvar for the axis.

class Bytes {
  b: number[] = [];
  u8(v: number) { this.b.push(v & 255); return this; }
  u16(v: number) { return this.u8(v >> 8).u8(v); }
  i16(v: number) { return this.u16(v & 0xffff); }
  u32(v: number) { return this.u16((v >>> 16) & 0xffff).u16(v & 0xffff); }
  fixed(v: number) { return this.u32(Math.round(v * 65536) >>> 0); }
  f2dot14(v: number) { return this.i16(Math.round(v * 16384)); }
  tag(s: string) { for (const c of s) this.u8(c.charCodeAt(0)); return this; }
  utf16(s: string) { for (const c of s) this.u16(c.charCodeAt(0)); return this; }
  pad4() { while (this.b.length % 4) this.u8(0); return this; }
}

/** Glyph width in font units (of 1000 per em) at a weight, as the test font draws it. */
export function varFontBarWidth(weight: number): number {
  const w = Math.min(Math.max(weight, 100), 900);
  return w >= 400 ? 100 + ((w - 400) / 500) * 200 : 100 - ((400 - w) / 300) * 80;
}

export function variableTestFont(): Uint8Array {
  const t: Record<string, Bytes> = {};
  // head: 1000 units per em, long loca offsets
  t.head = new Bytes().u32(0x00010000).u32(0x00010000).u32(0).u32(0x5f0f3cf5).u16(0).u16(1000).u32(0).u32(0).u32(0).u32(0)
    .i16(0).i16(0).i16(350).i16(700).u16(0).u16(8).i16(2).i16(1).i16(0);
  t.hhea = new Bytes().u32(0x00010000).i16(800).i16(-200).i16(0).u16(500).i16(0).i16(0).i16(350).i16(1).i16(0).i16(0)
    .i16(0).i16(0).i16(0).i16(0).i16(0).u16(2);
  t.maxp = new Bytes().u32(0x00005000).u16(2);
  t.hmtx = new Bytes().u16(500).i16(0).u16(400).i16(50);
  // cmap: format 4, "I" (0x49) → glyph 1
  t.cmap = new Bytes().u16(0).u16(1).u16(3).u16(1).u32(12)
    .u16(4).u16(32).u16(0).u16(4).u16(4).u16(1).u16(0)
    .u16(0x49).u16(0xffff).u16(0).u16(0x49).u16(0xffff).i16(1 - 0x49).u16(1).u16(0).u16(0);
  // glyf: glyph 0 empty, glyph 1 the bar (50,0) (50,700) (150,700) (150,0), on-curve points with 16-bit deltas
  const bar = new Bytes().i16(1).i16(50).i16(0).i16(150).i16(700).u16(3).u16(0).u8(1).u8(1).u8(1).u8(1)
    .i16(50).i16(0).i16(100).i16(0).i16(0).i16(700).i16(0).i16(-700).pad4();
  t.glyf = bar;
  t.loca = new Bytes().u32(0).u32(0).u32(bar.b.length);
  const names: [number, string][] = [[1, 'Test Var'], [2, 'Regular'], [256, 'Weight']];
  t.name = new Bytes().u16(0).u16(names.length).u16(6 + 12 * names.length);
  let off = 0;
  for (const [id, s] of names) { t.name.u16(3).u16(1).u16(0x409).u16(id).u16(s.length * 2).u16(off); off += s.length * 2; }
  for (const [, s] of names) t.name.utf16(s);
  t.post = new Bytes().u32(0x00030000).fixed(0).i16(-100).i16(50).u32(0).u32(0).u32(0).u32(0).u32(0);
  // fvar: one axis, wght 100..900, default 400
  t.fvar = new Bytes().u16(1).u16(0).u16(16).u16(2).u16(1).u16(20).u16(0).u16(8).tag('wght').fixed(100).fixed(400).fixed(900).u16(0).u16(256);
  // gvar: glyph 1 has two tuples with embedded peaks (wght +1 and -1) over all points (4 outline + 4 phantom): the two
  // right-hand points move +200 / -80 units in x
  const tuple = (dx: number) => new Bytes().u8(0x47).i16(0).i16(0).i16(dx).i16(dx).i16(0).i16(0).i16(0).i16(0).u8(0x87);
  const up = tuple(200), down = tuple(-80);
  const gv = new Bytes().u16(2).u16(4 + 2 * 6)
    .u16(up.b.length).u16(0x8000).f2dot14(1)
    .u16(down.b.length).u16(0x8000).f2dot14(-1);
  gv.b.push(...up.b, ...down.b);
  gv.pad4();
  t.gvar = new Bytes().u16(1).u16(0).u16(1).u16(0).u32(32).u16(2).u16(1).u32(32).u32(0).u32(0).u32(gv.b.length);
  t.gvar.b.push(...gv.b);

  const tags = Object.keys(t).sort();
  const n = tags.length, es = Math.floor(Math.log2(n)), sr = 16 * 2 ** es;
  const out = new Bytes().u32(0x00010000).u16(n).u16(sr).u16(es).u16(n * 16 - sr);
  let offset = 12 + 16 * n;
  const body: number[] = [];
  for (const tag of tags) {
    const data = t[tag].b, len = data.length;
    const padded = data.concat(new Array((4 - (len % 4)) % 4).fill(0));
    let sum = 0;
    for (let i = 0; i < padded.length; i += 4) sum = (sum + ((padded[i] << 24) | (padded[i + 1] << 16) | (padded[i + 2] << 8) | padded[i + 3])) >>> 0;
    out.tag(tag).u32(sum).u32(offset).u32(len);
    body.push(...padded);
    offset += padded.length;
  }
  return Uint8Array.from([...out.b, ...body]);
}
