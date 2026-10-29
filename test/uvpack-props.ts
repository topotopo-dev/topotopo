// Property checks of uv packing, run by test/property.ts (layer 1 of npm test):
//  - skylinePack (image atlases): random rect sets with identical, nearly identical (1e-10 apart) and thin rects, widths
//    that sum exactly to the bin, rotation on and off: every rect inside its bin, no two rects in a bin overlap;
//  - packCharts (uv_layout, uv_flatten): random island sets (rectangles, thin strips, identical and nearly identical
//    copies, L shapes, rings, fans) with random padding, resolution, turns, tiles and fixed obstacles: no two islands and
//    no island and obstacle overlap (exact clipping, core/uvoverlap.ts), every island inside a tile and ceil(padding / 2)
//    texels from its border, and the Euclidean distance between triangles of different islands (and obstacles) is at
//    least the padding.
import { skylinePack } from '../src/core/uv.ts';
import type { Rect } from '../src/core/uv.ts';
import { packCharts } from '../src/core/uvpack.ts';
import type { PackIsland } from '../src/core/uvpack.ts';
import { trianglesUV, uvOverlapPairs, uvTriangleAreas } from '../src/core/uvoverlap.ts';
import { rng } from '../src/core/random.ts';

type Rand = () => number;
type Check = (cond: boolean, msg: string) => void;

function rectSet(r: Rand, W: number): Rect[] {
  const out: Rect[] = [];
  const n = 1 + Math.floor(r() * 60);
  while (out.length < n) {
    const kind = r();
    let w: number, h: number;
    if (kind < 0.25) { w = W * (0.2 + r() * 0.6); h = W * (0.001 + r() * 0.01); } // thin
    else if (kind < 0.35) { const k = 1 + Math.floor(r() * 4); w = W / k; h = W * (0.01 + r() * 0.1); } // widths summing to W
    else { w = W * (0.01 + r() * 0.3); h = W * (0.01 + r() * 0.3); }
    const copies = r() < 0.4 ? 2 + Math.floor(r() * 4) : 1;
    for (let c = 0; c < copies; c++) out.push({ w: c && r() < 0.5 ? w * (1 + 1e-10 * (r() - 0.5)) : w, h: c && r() < 0.5 ? h + W * 1e-10 * r() : h, id: out.length });
  }
  return out;
}

function skylineProps(r: Rand, check: Check, round: number): void {
  const W = [1, 3.3061862680810608, 1024, 0.37][Math.floor(r() * 4)], H = r() < 0.5 ? W : W * (0.5 + r());
  const rects = rectSet(r, W), rotate = r() < 0.5, bins = 1 + Math.floor(r() * 3);
  if (r() < 0.5) rects.sort((a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h));
  rects.forEach((q, i) => (q.id = i));
  const pl = skylinePack(rects, W, bins, rotate, H);
  if (!pl) { check(true, `skylinePack #${round}: ${rects.length} rects do not fit ${bins} bins (allowed)`); return; }
  let outside = 0, overlaps = 0;
  const dims = rects.map((q, i) => (pl[i].rot ? [q.h, q.w] : [q.w, q.h]));
  for (let i = 0; i < rects.length; i++) {
    const p = pl[i];
    if (p.x < 0 || p.y < 0 || p.x + dims[i][0] > W || p.y + dims[i][1] > H) outside++;
    for (let j = i + 1; j < rects.length; j++) {
      const q = pl[j];
      if (p.bin !== q.bin) continue;
      const ox = Math.min(p.x + dims[i][0], q.x + dims[j][0]) - Math.max(p.x, q.x), oy = Math.min(p.y + dims[i][1], q.y + dims[j][1]) - Math.max(p.y, q.y);
      if (ox > 0 && oy > 0) overlaps++;
    }
  }
  check(outside === 0 && overlaps === 0, `skylinePack #${round}: ${rects.length} rects (rotate ${rotate}, ${bins} bins): ${outside} outside, ${overlaps} overlapping pairs`);
}

/** Random islands: each a list of uv triangles (6 numbers) and 3D area. */
function islandSet(r: Rand): { tris: number[][]; area3: number }[] {
  const out: { tris: number[][]; area3: number }[] = [];
  const n = 1 + Math.floor(r() * 40);
  const quad = (x0: number, y0: number, x1: number, y1: number) => [[x0, y0, x1, y0, x1, y1], [x0, y0, x1, y1, x0, y1]];
  while (out.length < n) {
    const kind = r(), ox = r() * 3 - 1, oy = r() * 3 - 1;
    let tris: number[][] = [];
    if (kind < 0.25) { const w = 0.2 + r(), h = w * (0.005 + r() * 0.04); tris = quad(ox, oy, ox + w, oy + h); } // thin strip
    else if (kind < 0.45) { const w = 0.05 + r() * 0.4, h = 0.05 + r() * 0.4; tris = quad(ox, oy, ox + w, oy + h); }
    else if (kind < 0.6) { const s = 0.1 + r() * 0.4, t = s * (0.1 + r() * 0.3); tris = [...quad(ox, oy, ox + s, oy + t), ...quad(ox, oy + t, ox + t, oy + s)]; } // L
    else if (kind < 0.75) { // ring of quads
      const R = 0.1 + r() * 0.4, w = R * (0.05 + r() * 0.3), m = 8 + Math.floor(r() * 24);
      for (let i = 0; i < m; i++) {
        const a0 = (2 * Math.PI * i) / m, a1 = (2 * Math.PI * (i + 1)) / m;
        const p = (a: number, rad: number) => [ox + rad * Math.cos(a), oy + rad * Math.sin(a)];
        const A = p(a0, R), B = p(a1, R), C = p(a1, R - w), D = p(a0, R - w);
        tris.push([...A, ...B, ...C], [...A, ...C, ...D]);
      }
    } else { // fan of random triangles around a centre
      const m = 3 + Math.floor(r() * 10), rad = 0.05 + r() * 0.3;
      let a = 0;
      for (let i = 0; i < m; i++) {
        const da = (2 * Math.PI) / m * (0.5 + r()), r0 = rad * (0.5 + r()), r1 = rad * (0.5 + r());
        tris.push([ox, oy, ox + r0 * Math.cos(a), oy + r0 * Math.sin(a), ox + r1 * Math.cos(a + da), oy + r1 * Math.sin(a + da)]);
        a += da;
      }
    }
    if (r() < 0.5) tris = tris.map((t) => [t[0], t[1], t[4], t[5], t[2], t[3]]); // mirrored winding
    let au = 0;
    for (const t of tris) au += Math.abs((t[2] - t[0]) * (t[5] - t[1]) - (t[4] - t[0]) * (t[3] - t[1])) / 2;
    const area3 = r() < 0.7 ? au * (1 + r() * 3) : au * (0.1 + r() * 10);
    const copies = r() < 0.35 ? 2 + Math.floor(r() * 4) : 1;
    for (let c = 0; c < copies; c++) out.push({ tris: tris.map((t) => (c && r() < 0.5 ? t.map((x) => x * (1 + 1e-9 * r())) : t.slice())), area3 });
  }
  return out;
}

/** Euclidean distance between two 2D triangles that do not overlap (0 when they touch or cross). */
function triDistance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const seg = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
    const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
    const t = l > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)) : 0;
    return Math.hypot(px - ax - t * dx, py - ay - t * dy);
  };
  const cross = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number) => {
    const o = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) => Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
    return o(ax, ay, bx, by, cx, cy) * o(ax, ay, bx, by, dx, dy) < 0 && o(cx, cy, dx, dy, ax, ay) * o(cx, cy, dx, dy, bx, by) < 0;
  };
  let d = Infinity;
  for (let i = 0; i < 3; i++) {
    const ax = a[i * 2], ay = a[i * 2 + 1], bx = a[((i + 1) % 3) * 2], by = a[((i + 1) % 3) * 2 + 1];
    for (let j = 0; j < 3; j++) {
      const cx = b[j * 2], cy = b[j * 2 + 1], dx = b[((j + 1) % 3) * 2], dy = b[((j + 1) % 3) * 2 + 1];
      if (cross(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
      d = Math.min(d, seg(ax, ay, cx, cy, dx, dy), seg(bx, by, cx, cy, dx, dy), seg(cx, cy, ax, ay, bx, by), seg(dx, dy, ax, ay, bx, by));
    }
  }
  return d;
}

function packProps(r: Rand, check: Check, round: number): void {
  const set = islandSet(r);
  const resolution = [64, 256, 1024, 1024, 2048, 4096][Math.floor(r() * 6)];
  const padding = [0, 1, 2, 4, 4, 7, 16][Math.floor(r() * 7)];
  const turns = r() < 0.6, tiles = r() < 0.75 ? 1 : 2 + Math.floor(r() * 2);
  // vertices: one per triangle corner (islands are triangle soups; shared corners are not needed for packing)
  const uv: number[] = [], islands: PackIsland[] = [], islandOfTri: number[] = [], triVerts: number[] = [];
  set.forEach((isl, k) => {
    const verts: number[] = [], tris: number[] = [];
    for (const t of isl.tris) {
      for (let c = 0; c < 3; c++) { const v = uv.length / 2; uv.push(t[c * 2], t[c * 2 + 1]); verts.push(v); tris.push(v); triVerts.push(v); }
      islandOfTri.push(k);
    }
    let au = 0;
    for (const t of isl.tris) au += Math.abs((t[2] - t[0]) * (t[5] - t[1]) - (t[4] - t[0]) * (t[3] - t[1])) / 2;
    islands.push({ verts, tris, area3: isl.area3, areaUV: au });
  });
  // fixed obstacles: a few triangles in the first tile
  const obst: number[] = [];
  if (r() < 0.4) for (let i = 0, m = 1 + Math.floor(r() * 6); i < m; i++) {
    const cx = r(), cy = r(), s = 0.02 + r() * 0.2;
    obst.push(cx, cy, cx + s * r(), cy + s * (0.2 + r()), cx - s * r(), cy + s * r());
  }
  const res = packCharts(Float64Array.from(uv), islands, {
    resolution, padding, turns, orient: turns ? 'min_rect' : 'keep', scaleMode: r() < 0.8 ? 'uniform' : 'keep', tiles,
    iterations: 1 + Math.floor(r() * 3), seed: round, obstacles: obst.length ? Float64Array.from(obst) : null,
  });
  const label = `packCharts #${round}: ${islands.length} islands, res ${resolution}, padding ${padding}, turns ${turns}, ${tiles} tile(s), ${obst.length / 6} obstacles`;
  if (!res.packed) {
    // allowed when obstacles take room, or the padding alone needs a large share of the tiles
    const padShare = (islands.length * (1 + res.padCells) ** 2) / (tiles * res.grid * res.grid);
    check(obst.length > 0 || padShare > 0.25, `${label}: not packed (padding needs ${(padShare * 100).toFixed(0)}% of the tiles)`);
    return;
  }
  // all triangles (islands, then obstacles as group -1)
  const nIslandTris = islandOfTri.length;
  const allUV = Array.from(res.uv), allTris = triVerts.slice(), group = islandOfTri.slice();
  for (let t = 0; t < obst.length / 6; t++) { for (let c = 0; c < 3; c++) { allTris.push(allUV.length / 2); allUV.push(obst[t * 6 + c * 2], obst[t * 6 + c * 2 + 1]); } group.push(-1); }
  const U = trianglesUV(allUV, allTris), nt = U.length / 6;
  const { ok, signed } = uvTriangleAreas(U, nt);
  const valid: number[] = [];
  for (let t = 0; t < nt; t++) if (ok[t]) valid.push(t);
  let overlaps = 0;
  uvOverlapPairs(U, valid, signed, (a, b) => { if (group[a] !== group[b]) overlaps++; }, { skip: (a, b) => group[a] === group[b] });
  // inside a tile, ceil(padding / 2) cells from its border
  const G = res.grid, half = Math.ceil(res.padCells / 2) / G - 1e-9;
  let outside = 0;
  for (let t = 0; t < nIslandTris; t++) {
    const tu = Math.floor(U[t * 6]), tv = Math.floor(U[t * 6 + 1]);
    if (tu < 0 || tv < 0 || tv * 10 + tu >= tiles) { outside++; continue; }
    for (let c = 0; c < 3; c++) {
      const u = U[t * 6 + c * 2] - tu, v = U[t * 6 + c * 2 + 1] - tv;
      if (u < half || u > 1 - half || v < half || v > 1 - half) outside++;
    }
  }
  // padding: triangles of different islands (and islands and obstacles) are at least padCells / G apart
  const gap = (res.padCells / G) * (1 - 1e-6);
  let close = 0;
  if (gap > 0) {
    const bb = (t: number) => [Math.min(U[t * 6], U[t * 6 + 2], U[t * 6 + 4]), Math.min(U[t * 6 + 1], U[t * 6 + 3], U[t * 6 + 5]), Math.max(U[t * 6], U[t * 6 + 2], U[t * 6 + 4]), Math.max(U[t * 6 + 1], U[t * 6 + 3], U[t * 6 + 5])];
    const boxes = Array.from({ length: nt }, (_, t) => bb(t));
    for (let a = 0; a < nIslandTris; a++) for (let b = a + 1; b < nt; b++) {
      if (group[a] === group[b]) continue;
      const A = boxes[a], B = boxes[b];
      if (A[0] - gap > B[2] || B[0] - gap > A[2] || A[1] - gap > B[3] || B[1] - gap > A[3]) continue;
      if (triDistance(U.subarray(a * 6, a * 6 + 6), U.subarray(b * 6, b * 6 + 6)) < gap) close++;
    }
  }
  check(overlaps === 0 && outside === 0 && close === 0, `${label}: ${overlaps} overlapping pairs, ${outside} corners outside the tiles' padded area, ${close} pairs closer than the padding (${res.packs} packs, ${(res.uvArea * 100 / Math.max(1, res.tilesUsed)).toFixed(0)}% used)`);
}

export function uvPackProperties(seed: number, count: number, check: Check): void {
  const r = rng(seed * 7717 + 3);
  for (let i = 0; i < count; i++) skylineProps(r, check, i);
  for (let i = 0; i < count; i++) packProps(r, check, i);
}
