// The Windows file icons (assets/icons/*.ico, from assets/icons/src/*.svg by scripts/gen-icons.ts).
//   node test/icons.ts      (part of npm test)
// - Each .ico holds 16, 24, 32, 48, 64, 128 and 256 px images, 32-bit, the small ones as bitmaps of the right size
//   and the large ones as PNG of the right size, all inside the file.
// - The committed .ico files are what their SVG sources make (npm run icons after changing a drawing).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from './fixtures.ts';

let fail = 0, pass = 0;
const check = (ok: unknown, msg: string) => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
};
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

for (const file of ['topotopo-package.ico', 'topotopo-workspace.ico']) {
  const at = path.join(ROOT, 'assets', 'icons', file);
  if (!fs.existsSync(at)) { check(false, `assets/icons/${file} exists`); continue; }
  const b = fs.readFileSync(at);
  const count = b.readUInt16LE(4);
  const problems: string[] = [];
  if (b.readUInt16LE(0) !== 0 || b.readUInt16LE(2) !== 1) problems.push('not an icon file');
  const sizes: number[] = [];
  for (let i = 0; i < count && !problems.length; i++) {
    const e = 6 + 16 * i;
    const size = b[e] || 256, bits = b.readUInt16LE(e + 6), len = b.readUInt32LE(e + 8), off = b.readUInt32LE(e + 12);
    sizes.push(size);
    if (b[e + 1] !== b[e] || bits !== 32) problems.push(`${size} px is not square or not 32-bit`);
    if (off + len > b.length) { problems.push(`${size} px runs past the end`); continue; }
    const img = b.subarray(off, off + len);
    if (img.subarray(0, 8).equals(PNG)) {
      if (img.readUInt32BE(16) !== size || img.readUInt32BE(20) !== size) problems.push(`${size} px PNG is ${img.readUInt32BE(16)}x${img.readUInt32BE(20)}`);
    } else if (img.readUInt32LE(0) !== 40 || img.readInt32LE(4) !== size || img.readInt32LE(8) !== 2 * size || img.readUInt16LE(14) !== 32) {
      problems.push(`${size} px bitmap header does not match`);
    }
  }
  check(!problems.length && sizes.join() === SIZES.join(), `${file}: ${sizes.join(', ')} px, 32-bit${problems.length ? `; ${problems.join('; ')}` : ''}`);
}

let out = '';
try { out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'gen-icons.ts'), '--check'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e: any) { out = `${e.stdout ?? ''}${e.stderr ?? ''}`; }
check(/icons are up to date/.test(out), `the .ico files are what assets/icons/src makes (${out.trim()})`);

console.log(`\nicons: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
