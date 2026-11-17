// The Windows file icons, from their SVG sources: assets/icons/topotopo-package.ico (.topo packages) and
// assets/icons/topotopo-workspace.ico (.topows workspaces), each with 16, 24, 32, 48, 64, 128 and 256 px images.
//   node scripts/gen-icons.ts             (npm run icons) writes both .ico files
//   node scripts/gen-icons.ts --check     fails when a committed .ico differs from what its sources make (npm test)
//   node scripts/gen-icons.ts --png <dir> also writes every image as <icon>-<size>.png into dir, to look at
//
// Sources, in assets/icons/src: <icon>.svg is the drawing for 64 px and up; <icon>-16.svg, <icon>-24.svg and
// <icon>-32.svg (also used for 48 px) are drawn on those pixel grids so small icons stay sharp. A missing small
// drawing falls back to <icon>.svg. resvg (WebAssembly) renders them the same on every OS. Images up to 64 px are stored
// as 32-bit bitmaps, 128 and 256 px as PNG, the layout Windows reads everywhere.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { initWasm, Resvg } from '@resvg/resvg-wasm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'assets', 'icons');
const SRC = path.join(DIR, 'src');
const ICONS = [
  { name: 'package', file: 'topotopo-package.ico' },
  { name: 'workspace', file: 'topotopo-workspace.ico' },
];
const SIZES = [16, 24, 32, 48, 64, 128, 256];
/** the drawing each size uses, before falling back to <icon>.svg */
const DRAWN_FOR: Record<number, string> = { 16: '-16', 24: '-24', 32: '-32', 48: '-32' };
const PNG_FROM = 128;

const check = process.argv.includes('--check');
const pngAt = process.argv.indexOf('--png');
const pngDir = pngAt > 0 ? path.resolve(process.argv[pngAt + 1]) : null;

await initWasm(fs.readFileSync(createRequire(import.meta.url).resolve('@resvg/resvg-wasm/index_bg.wasm')));

function sourceFor(icon: string, size: number): string {
  const drawn = DRAWN_FOR[size] && path.join(SRC, `${icon}${DRAWN_FOR[size]}.svg`);
  return drawn && fs.existsSync(drawn) ? drawn : path.join(SRC, `${icon}.svg`);
}

/** One image: its PNG and its straight-alpha RGBA pixels. */
function render(file: string, size: number): { png: Buffer; rgba: Uint8Array } {
  const r = new Resvg(fs.readFileSync(file, 'utf8'), { fitTo: { mode: 'width', value: size } });
  const img = r.render();
  if (img.width !== size || img.height !== size) throw new Error(`${path.relative(ROOT, file)} is not square: ${img.width}x${img.height} at ${size} px`);
  const png = Buffer.from(img.asPng());
  const rgba = Uint8Array.from(img.pixels);
  img.free(); r.free();
  // resvg's pixels are premultiplied; an icon bitmap is not
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3];
    if (a && a < 255) for (let c = 0; c < 3; c++) rgba[i + c] = Math.min(255, Math.round(rgba[i + c] * 255 / a));
  }
  return { png, rgba };
}

/** A 32-bit icon bitmap: BITMAPINFOHEADER (height doubled for the mask), BGRA rows bottom-up, an all-clear AND mask. */
function bitmap(rgba: Uint8Array, size: number): Buffer {
  const maskRow = Math.ceil(size / 32) * 4;
  const out = Buffer.alloc(40 + size * size * 4 + maskRow * size);
  out.writeUInt32LE(40, 0); out.writeInt32LE(size, 4); out.writeInt32LE(size * 2, 8);
  out.writeUInt16LE(1, 12); out.writeUInt16LE(32, 14); out.writeUInt32LE(size * size * 4 + maskRow * size, 20);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4, d = 40 + ((size - 1 - y) * size + x) * 4;
      out[d] = rgba[s + 2]; out[d + 1] = rgba[s + 1]; out[d + 2] = rgba[s]; out[d + 3] = rgba[s + 3];
    }
  }
  return out;
}

function ico(images: { size: number; data: Buffer }[]): Buffer {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    head[e] = size >= 256 ? 0 : size; head[e + 1] = size >= 256 ? 0 : size;
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(data.length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...images.map((i) => i.data)]);
}

const stale: string[] = [];
if (pngDir) fs.mkdirSync(pngDir, { recursive: true });
for (const { name, file } of ICONS) {
  const images = SIZES.map((size) => {
    const { png, rgba } = render(sourceFor(name, size), size);
    if (pngDir) fs.writeFileSync(path.join(pngDir, `${name}-${size}.png`), png);
    return { size, data: size >= PNG_FROM ? png : bitmap(rgba, size) };
  });
  const bytes = ico(images);
  const target = path.join(DIR, file);
  if (check) {
    if (!fs.existsSync(target) || !fs.readFileSync(target).equals(bytes)) stale.push(`assets/icons/${file}`);
  } else {
    fs.writeFileSync(target, bytes);
    console.log(`wrote assets/icons/${file}: ${SIZES.join(', ')} px, ${bytes.length} bytes`);
  }
}
if (check) {
  if (stale.length) { console.error(`stale icons: ${stale.join(', ')}: run npm run icons`); process.exit(1); }
  console.log(`icons are up to date (${ICONS.map((i) => i.file).join(', ')})`);
}
