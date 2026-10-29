// UV island packing on a raster: islands never overlap and keep `padding` texels apart, by construction.
//
// Each island is rasterised conservatively (every cell its uv triangles touch) on a grid of G × G cells per tile,
// G = the texture resolution clamped to 256..2048. Per grid column an island keeps one run of cells, from its lowest to
// its highest occupied row (gaps inside a column are filled), so its shape is a column profile. The atlas keeps, per
// column, the sorted runs of the islands placed so far, each dilated by floor(padding / 2) cells; an island to place is
// dilated by ceil(padding / 2), so two islands are at least `padding` cells apart (Chebyshev) and an island keeps
// ceil(padding / 2) cells from the tile border. Runs closer than the smallest island could use are merged.
//
// Placement is bottom-left fill with holes: the lowest position, then the leftmost, at which the island's runs miss
// every run in the atlas. A candidate column is solved by a fixed-point search (raise the island past the first run it
// hits, column after column, until every column is clear); candidate columns are scanned at a quarter of the island's
// width, refined around the best by halving steps, then slid left. With turns, 0° and 90° are both tried and the lower
// top wins. The scale (cells per island unit) is the largest at which every island fits the tiles: from an area
// estimate, bracketed by packs that report their height, then bisected to 0.5 %. Other orderings are tried at the
// found scale and continue the search when they fit more.
//
// Islands outside the packed set (prims outside a group) are fixed obstacles: their cells are taken before packing.
// The uv written is exactly the rasterised geometry moved by whole cells, so no two islands share a cell and none
// overlap; callers still check the result exactly (core/uvoverlap.ts).
import { convexHull2D, minAreaRectAngle } from './uv.ts';
import { rng } from './random.ts';

export interface PackIsland {
  /** distinct vertices (corners) of the island; their uv is rewritten */
  verts: ArrayLike<number>;
  /** triangles as vertex index triples: the shapes rasterised (use the triangulation the result is checked with) */
  tris: ArrayLike<number>;
  /** 3D surface area and uv area (scale_mode uniform: uv area ∝ 3D area) */
  area3: number;
  areaUV: number;
}

export interface PackOptions {
  /** texture size in texels per tile side; padding is in its texels */
  resolution: number;
  /** texels between islands (half of it, rounded up, to the tile border) */
  padding: number;
  /** allow 90° turns while packing */
  turns: boolean;
  /** orientation before packing: min_rect = the island's minimum-area bounding rectangle, keep = as it is */
  orient: 'min_rect' | 'keep';
  /** uniform: equal texel density (uv area ∝ 3D area); keep: the islands' relative uv scale */
  scaleMode: 'uniform' | 'keep';
  /** UDIM tiles to fill (1 = the unit tile), right then up, ten per row; islands go to the first tile they fit */
  tiles: number;
  /** island orderings tried (longest side first, then tallest, largest bounding box, largest area, then shuffles of the first) */
  iterations: number;
  seed?: number;
  /** per island texel weight: its scale is multiplied by this (2 = twice the texels per metre); null = 1 */
  weights?: ArrayLike<number> | null;
  /** per island fixed rotation in radians before packing (NaN = by orient); null = by orient */
  angles?: ArrayLike<number> | null;
  /** fixed uv triangles (6 numbers each) the packed islands keep clear of, with padding (e.g. prims outside a group) */
  obstacles?: Float64Array | null;
  /**
   * > 0: islands at this density (texels per island unit: per metre with scale_mode uniform), filling the tiles first-fit;
   * when they do not fit `tiles`, or an island is larger than a tile, the density drops until they do
   */
  texelsPerUnit?: number;
  /** > 0: the densest the search may go (texels per island unit) */
  maxTexelsPerUnit?: number;
}

export interface PackResult {
  uv: Float64Array;
  /** false when there was nothing to pack, or the islands did not fit at any scale (uv unchanged) */
  packed: boolean;
  /** raster cells per tile side, and the padding in cells */
  grid: number;
  padCells: number;
  /** tiles holding islands */
  tilesUsed: number;
  /** summed uv area of the packed islands (their share of one tile; over several tiles it can exceed 1) */
  uvArea: number;
  /** packs run by the scale search */
  packs: number;
  /** share of the used tiles' cells covered by the islands' rasters, and by the rasters grown by half the padding */
  cells: { island: number; padded: number };
  /** the island whose size capped the scale (it spans a tile), or -1 when the tiles' area set the scale */
  cappedBy: number;
}

/** Rasteriser margin: a cell an island touches within EPS counts as taken (conservative). */
const EPS = 1e-6;
/** Islands sit OFFSET cells off the cell grid, so an island edge never falls exactly on a cell border (which the margin would round out to a whole extra row or column). */
const OFFSET = 1 + 1e-4;

/** An island shape at one scale: runs of taken cells, sorted by column then row (column c, rows lo..hi). */
interface Profile { w: number; top: number; n: number; c: Int32Array; lo: Int32Array; hi: Int32Array }

/** Add run [s, e] to a sorted flat run list (start, end pairs), merging runs fewer than gap + 1 free cells apart. */
function addRun(r: number[], s: number, e: number, gap: number): void {
  const n = r.length;
  let i = 0;
  while (i < n && r[i + 1] < s - gap - 1) i += 2;
  if (i === n) { r.push(s, e); return; }
  if (r[i] > e + gap + 1) { r.splice(i, 0, s, e); return; }
  const ns = r[i] < s ? r[i] : s;
  let ne = e, j = i;
  while (j < n && r[j] <= ne + gap + 1) { if (r[j + 1] > ne) ne = r[j + 1]; j += 2; }
  if (j - i === 2) { r[i] = ns; r[i + 1] = ne; return; }
  r.splice(i, j - i, ns, ne);
}

/**
 * Runs per column while a profile is built: a column with one run keeps it in lo/hi (the common case); a column with
 * more keeps a sorted run list (hi = -2). Runs fewer than gap + 1 free cells apart merge.
 */
class RunCols {
  w: number;
  gap: number;
  lo: Int32Array;
  hi: Int32Array;
  more: (number[] | undefined)[] | null = null;
  constructor(w: number, gap: number) {
    this.w = w; this.gap = gap;
    this.lo = new Int32Array(w);
    this.hi = new Int32Array(w).fill(-1);
  }
  add(c: number, s: number, e: number): void {
    const h = this.hi[c], g = this.gap;
    if (h === -1) { this.lo[c] = s; this.hi[c] = e; return; }
    if (h >= 0) {
      const l = this.lo[c];
      if (s <= h + g + 1 && e >= l - g - 1) { if (s < l) this.lo[c] = s; if (e > h) this.hi[c] = e; return; }
      (this.more ??= new Array(this.w))[c] = l < s ? [l, h, s, e] : [s, e, l, h];
      this.hi[c] = -2;
      return;
    }
    addRun(this.more![c]!, s, e, g);
  }
  profile(): Profile {
    const w = this.w, lo = this.lo, hi = this.hi;
    let n = 0, top = 0;
    for (let c = 0; c < w; c++) {
      if (hi[c] >= 0) { n++; if (hi[c] + 1 > top) top = hi[c] + 1; }
      else if (hi[c] === -2) { const r = this.more![c]!; n += r.length / 2; if (r[r.length - 1] + 1 > top) top = r[r.length - 1] + 1; }
    }
    const C = new Int32Array(n), L = new Int32Array(n), H = new Int32Array(n);
    for (let c = 0, k = 0; c < w; c++) {
      if (hi[c] >= 0) { C[k] = c; L[k] = lo[c]; H[k] = hi[c]; k++; }
      else if (hi[c] === -2) { const r = this.more![c]!; for (let i = 0; i < r.length; i += 2, k++) { C[k] = c; L[k] = r[i]; H[k] = r[i + 1]; } }
    }
    return { w, top, n, c: C, lo: L, hi: H };
  }
}

/** Conservative raster of triangles as runs per column; px holds cell coordinates (2 per local vertex), all >= 0. */
function rasterise(px: Float64Array, tris: Int32Array, gap: number): Profile {
  let maxX = 0;
  for (let i = 0; i < px.length; i += 2) if (px[i] > maxX) maxX = px[i];
  const w = Math.floor(maxX + EPS) + 1;
  const cols = new RunCols(w, gap);
  for (let t = 0; t < tris.length; t += 3) {
    const ax = px[tris[t] * 2], ay = px[tris[t] * 2 + 1], bx = px[tris[t + 1] * 2], by = px[tris[t + 1] * 2 + 1], cx = px[tris[t + 2] * 2], cy = px[tris[t + 2] * 2 + 1];
    const c0 = Math.max(0, Math.floor(Math.min(ax, bx, cx) - EPS)), c1 = Math.min(w - 1, Math.floor(Math.max(ax, bx, cx) + EPS));
    for (let c = c0; c <= c1; c++) {
      const s0 = c - EPS, s1 = c + 1 + EPS;
      let y0 = Infinity, y1 = -Infinity;
      if (ax >= s0 && ax <= s1) { if (ay < y0) y0 = ay; if (ay > y1) y1 = ay; }
      if (bx >= s0 && bx <= s1) { if (by < y0) y0 = by; if (by > y1) y1 = by; }
      if (cx >= s0 && cx <= s1) { if (cy < y0) y0 = cy; if (cy > y1) y1 = cy; }
      // edges crossing the slab borders
      for (let e = 0; e < 3; e++) {
        const px0 = e === 0 ? ax : e === 1 ? bx : cx, py0 = e === 0 ? ay : e === 1 ? by : cy;
        const px1 = e === 0 ? bx : e === 1 ? cx : ax, py1 = e === 0 ? by : e === 1 ? cy : ay;
        for (let k = 0; k < 2; k++) {
          const X = k ? s1 : s0;
          if ((px0 - X) * (px1 - X) < 0) {
            const y = py0 + ((X - px0) * (py1 - py0)) / (px1 - px0);
            if (y < y0) y0 = y; if (y > y1) y1 = y;
          }
        }
      }
      if (!(y0 <= y1)) continue;
      cols.add(c, Math.max(0, Math.floor(y0 - EPS)), Math.floor(y1 + EPS));
    }
  }
  return cols.profile();
}

/** Chebyshev dilation by d cells; the result's origin is d cells left of and below the input's. */
function dilate(p: Profile, d: number, gap: number): Profile {
  if (d <= 0) return p;
  const cols = new RunCols(p.w + 2 * d, gap);
  for (let i = 0; i < p.n; i++) for (let k = 0; k <= 2 * d; k++) cols.add(p.c[i] + k, p.lo[i], p.hi[i] + 2 * d);
  return cols.profile();
}

function cellsOf(p: Profile): number {
  let n = 0;
  for (let i = 0; i < p.n; i++) n += p.hi[i] - p.lo[i] + 1;
  return n;
}

/** Per column the sorted, disjoint runs [start, end] of taken cells. */
class Atlas {
  G: number;
  mergeGap: number;
  starts: number[][];
  ends: number[][];
  constructor(G: number, mergeGap: number, from?: Atlas) {
    this.G = G;
    this.mergeGap = mergeGap;
    this.starts = from ? from.starts.map((a) => a.slice()) : Array.from({ length: G }, () => []);
    this.ends = from ? from.ends.map((a) => a.slice()) : Array.from({ length: G }, () => []);
  }
  /** Take rows s..e of column c (runs closer than mergeGap free cells merge: no island fits between them). */
  take(c: number, s: number, e: number): void {
    if (c < 0 || c >= this.G) return;
    const S = this.starts[c], E = this.ends[c], g = this.mergeGap;
    let a = 0, b = E.length;
    while (a < b) { const m = (a + b) >> 1; if (E[m] < s - g - 1) a = m + 1; else b = m; }
    let z = a;
    while (z < S.length && S[z] <= e + g + 1) z++;
    if (z > a) { if (S[a] < s) s = S[a]; if (E[z - 1] > e) e = E[z - 1]; }
    S.splice(a, z - a, s);
    E.splice(a, z - a, e);
  }
  /** The lowest y (<= maxY) at which profile T, its column 0 at column X, misses every run; -1 when there is none. */
  lowest(T: Profile, X: number, maxY: number): number {
    const n = T.n;
    if (!n) return 0;
    let y = 0, ok = 0, i = 0;
    while (ok < n) {
      const S = this.starts[X + T.c[i]], E = this.ends[X + T.c[i]];
      const need0 = y + T.lo[i];
      let a = 0, b = E.length;
      while (a < b) { const m = (a + b) >> 1; if (E[m] < need0) a = m + 1; else b = m; }
      if (a < E.length && S[a] <= y + T.hi[i]) {
        y = E[a] + 1 - T.lo[i];
        if (y > maxY) return -1;
        ok = 0;
        continue;
      }
      ok++;
      i = i + 1 === n ? 0 : i + 1;
    }
    return y;
  }
  /** Bottom-left position of T with y <= maxY: { x, y } or null. */
  place(T: Profile, maxY: number): { x: number; y: number } | null {
    const maxX = this.G - T.w;
    if (maxX < 0 || maxY < 0) return null;
    let bx = -1, by = maxY + 1;
    const tryX = (x: number) => {
      if (x < 0 || x > maxX || x === bx) return;
      const lim = bx < 0 || x < bx ? by : by - 1;
      if (lim < 0) return;
      const y = this.lowest(T, x, Math.min(lim, maxY));
      if (y >= 0 && (y < by || (y === by && x < bx))) { by = y; bx = x; }
    };
    const st = Math.max(1, Math.floor(T.w / 4), Math.floor(this.G / 256));
    for (let x = 0; x <= maxX; x += st) tryX(x);
    tryX(maxX);
    if (bx < 0) return null;
    for (let step = st >> 1; step >= 1; step >>= 1) { const c = bx; tryX(c - step); tryX(c + step); }
    // slide left at the same height (bisection: a leftward position that fits, not always the leftmost there is)
    let l = Math.max(0, bx - st), r = bx;
    if (l < r) {
      const yl = this.lowest(T, l, by);
      if (yl >= 0) { bx = l; by = yl; }
      else while (r - l > 1) {
        const m = (l + r) >> 1, y = this.lowest(T, m, by);
        if (y >= 0) { r = m; bx = m; by = y; } else l = m;
      }
    }
    return { x: bx, y: by };
  }
}

interface Prepared {
  /** local coordinates per island and turn (2 per local vertex), in island units, min corner at 0 */
  local: [Float64Array, Float64Array | null][];
  tris: Int32Array[];
  /** bounding box (turn 0) and summed triangle area, in island units */
  w: Float64Array;
  h: Float64Array;
  area: Float64Array;
}

/** One pack at scale s: placements, or null when an island found no place under hardTop in the last tile. */
interface Packed { ok: boolean; H: number; tile: Int32Array; x: Int32Array; y: Int32Array; turn: Uint8Array; tilesUsed: number }

/** Pack islands into the unit tile (or UDIM tiles); returns new per-vertex uv (other vertices keep theirs). */
export function packCharts(uv: Float64Array, islands: PackIsland[], o: PackOptions): PackResult {
  const out = uv.slice();
  const res = Math.max(1, o.resolution || 1024);
  const G = Math.max(256, Math.min(2048, Math.round(res)));
  const padCells = Math.max(0, Math.ceil((Math.max(0, o.padding) * G) / res - 1e-9));
  const a = Math.floor(padCells / 2), b = padCells - a;
  // free gaps of 2b cells or fewer hold no island (every island to place is at least 1 + 2b cells tall): merged away
  const gap = 2 * b;
  const tiles = Math.max(1, Math.min(100, Math.floor(o.tiles || 1)));
  const result: PackResult = { uv: out, packed: false, grid: G, padCells, tilesUsed: 0, uvArea: 0, packs: 0, cells: { island: 0, padded: 0 }, cappedBy: -1 };
  const nI = islands.length;
  if (!nI) return result;
  const prep = prepare(uv, islands, o);
  // obstacle runs (fixed uv triangles), per tile, dilated by a when taken
  const base: Atlas[] = [];
  for (let ti = 0; ti < tiles; ti++) {
    const A = new Atlas(G, gap);
    if (o.obstacles && o.obstacles.length) takeObstacles(A, o.obstacles, ti % 10, Math.floor(ti / 10), G, a, gap);
    base.push(A);
  }
  const turnsOf = o.turns ? [0, 1] : [0];
  const packAt = (s: number, order: Int32Array, hardTop: number): Packed => {
    const atlases = base.map((A) => new Atlas(G, gap, A));
    const H = new Int32Array(tiles);
    const r: Packed = { ok: false, H: 0, tile: new Int32Array(nI), x: new Int32Array(nI), y: new Int32Array(nI), turn: new Uint8Array(nI), tilesUsed: 0 };
    for (const k of order) {
      let best: { ti: number; x: number; y: number; top: number; turn: number; S: Profile } | null = null;
      for (const turn of turnsOf) {
        const loc = prep.local[k][turn];
        if (!loc) continue;
        const px = new Float64Array(loc.length);
        for (let i = 0; i < loc.length; i++) px[i] = loc[i] * s + OFFSET;
        const R = rasterise(px, prep.tris[k], gap);
        const T = dilate(R, b, gap);
        if (T.w > G) continue;
        for (let ti = 0; ti < tiles; ti++) {
          const limit = ti === tiles - 1 ? hardTop : G;
          const p = atlases[ti].place(T, limit - T.top);
          if (!p) continue;
          const top = p.y + T.top;
          if (!best || ti < best.ti || (ti === best.ti && top < best.top)) best = { ti, x: p.x, y: p.y, top, turn, S: dilate(R, a, gap) };
          break;
        }
      }
      if (!best) return r;
      const A = atlases[best.ti], S = best.S, ox = best.x + b - a, oy = best.y + b - a;
      for (let i = 0; i < S.n; i++) A.take(ox + S.c[i], oy + S.lo[i], oy + S.hi[i]);
      if (best.top > H[best.ti]) H[best.ti] = best.top;
      r.tile[k] = best.ti; r.x[k] = best.x; r.y[k] = best.y; r.turn[k] = best.turn;
    }
    r.H = H[tiles - 1];
    r.ok = r.H <= G;
    for (let ti = 0; ti < tiles; ti++) if (H[ti] > 0) r.tilesUsed = ti + 1;
    return r;
  };
  // scale bounds: every island must fit a tile; start from the area
  let maxDim = 0, area = 0, largest = -1;
  for (let k = 0; k < nI; k++) { if (Math.max(prep.w[k], prep.h[k]) > maxDim) { maxDim = Math.max(prep.w[k], prep.h[k]); largest = k; } area += prep.area[k]; }
  const sFix = (o.texelsPerUnit ?? 0) > 0 ? (o.texelsPerUnit! * G) / res : 0;
  const sMax = (o.maxTexelsPerUnit ?? 0) > 0 ? (o.maxTexelsPerUnit! * G) / res : Infinity;
  const sCap = Math.min(sMax, maxDim > 0 ? (G - 2 * b - 3) / maxDim : sFix > 0 ? sFix : 1);
  if (!(sCap > 0)) return result;
  let s0 = area > 0 ? Math.sqrt((0.55 * tiles * G * G) / area) : sCap;
  s0 = Math.min(sCap, s0);
  const orders = orderings(prep, nI, Math.max(1, Math.min(64, Math.floor(o.iterations || 1))), o.seed ?? 0);
  let bestS = 0, best: Packed | null = null;
  const hardTop = Math.ceil(G * 1.6);
  const search = (order: Int32Array, sStart: number, lo: number, hi: number, maxPacks: number) => {
    let s = sStart;
    for (let i = 0; i < maxPacks; i++) {
      const r = packAt(s, order, lo > 0 && hi < Infinity ? G : hardTop);
      result.packs++;
      if (r.ok) { lo = s; if (s > bestS) { bestS = s; best = r; } } else hi = s;
      if (lo > 0 && hi < Infinity && hi / lo < 1.005) break;
      if (lo >= sCap) break;
      const full = r.H > 0 && r.tile.length ? r.H : 0;
      if (hi === Infinity) s = Math.min(sCap, s * Math.min(1.5, Math.max(1.01, full > 0 ? Math.sqrt(G / full) * 0.998 : 1.5)));
      else if (lo === 0) s = s * (r.H > 0 && r.H < hardTop ? Math.max(0.5, Math.min(0.98, Math.sqrt(G / r.H))) : 0.75);
      else s = Math.sqrt(lo * hi);
    }
    return { lo, hi };
  };
  if (sFix > 0) {
    // a fixed density: one pack over the tiles; only when it does not fit does the density drop
    const s = Math.min(sFix, sCap);
    const r = packAt(s, orders[0], G);
    result.packs++;
    if (r.ok) { bestS = s; best = r; }
    else search(orders[0], s * 0.97, 0, s, 24);
  }
  const first = sFix > 0 ? { lo: bestS, hi: Infinity } : search(orders[0], s0, 0, Infinity, 24);
  // other orderings at the scale found: one that fits there too continues the search upwards
  for (let i = 1; i < orders.length && bestS > 0 && bestS < sCap && !(sFix > 0); i++) {
    const s = Math.min(sCap, bestS * 1.004);
    const r = packAt(s, orders[i], G);
    result.packs++;
    if (!r.ok) continue;
    bestS = s; best = r;
    search(orders[i], Math.min(sCap, s * 1.01), s, first.hi > s * 1.01 ? first.hi : Infinity, 8);
  }
  if (!best || !(bestS > 0)) return result;
  const P = best as Packed;
  // write: uv = (local · s + OFFSET + b + cell offset) / G + tile, exactly the rasterised shape moved by whole cells
  let cellsIsland = 0, cellsPadded = 0;
  for (let k = 0; k < nI; k++) {
    const isl = islands[k], loc = prep.local[k][P.turn[k]]!;
    const px = new Float64Array(loc.length);
    for (let i = 0; i < loc.length; i++) px[i] = loc[i] * bestS + OFFSET;
    const R = rasterise(px, prep.tris[k], gap);
    cellsIsland += cellsOf(R); cellsPadded += cellsOf(dilate(R, b, gap));
    const tu = P.tile[k] % 10, tv = Math.floor(P.tile[k] / 10);
    for (let i = 0; i < isl.verts.length; i++) {
      const v = isl.verts[i];
      out[v * 2] = (px[i * 2] + b + P.x[k]) / G + tu;
      out[v * 2 + 1] = (px[i * 2 + 1] + b + P.y[k]) / G + tv;
    }
    result.uvArea += (prep.area[k] * bestS * bestS) / (G * G);
  }
  result.packed = true;
  result.tilesUsed = P.tilesUsed;
  if (bestS >= sCap * 0.999) result.cappedBy = largest;
  const tileCells = G * G * Math.max(1, P.tilesUsed);
  result.cells = { island: cellsIsland / tileCells, padded: cellsPadded / tileCells };
  return result;
}

/** Orient and scale each island into its own units; local coordinates for turn 0 and (with turns) turn 90°. */
function prepare(uv: Float64Array, islands: PackIsland[], o: PackOptions): Prepared {
  const nI = islands.length;
  const prep: Prepared = { local: [], tris: [], w: new Float64Array(nI), h: new Float64Array(nI), area: new Float64Array(nI) };
  let densSum = 0, densN = 0;
  for (const isl of islands) if (isl.areaUV > 1e-18 && isl.area3 > 1e-18) { densSum += Math.sqrt(isl.area3 / isl.areaUV); densN++; }
  const meanDens = densN ? densSum / densN : 1;
  const localOf = new Map<number, number>();
  for (let k = 0; k < nI; k++) {
    const isl = islands[k], nv = isl.verts.length;
    localOf.clear();
    for (let i = 0; i < nv; i++) localOf.set(isl.verts[i], i);
    const tl: number[] = [];
    for (let t = 0; t + 2 < isl.tris.length; t += 3) {
      const p = localOf.get(isl.tris[t]), q = localOf.get(isl.tris[t + 1]), r = localOf.get(isl.tris[t + 2]);
      if (p !== undefined && q !== undefined && r !== undefined) tl.push(p, q, r);
    }
    if (!tl.length) for (let i = 0; i < nv; i++) tl.push(i, i, i);
    prep.tris.push(Int32Array.from(tl));
    const pts = new Float64Array(nv * 2);
    for (let i = 0; i < nv; i++) {
      const v = isl.verts[i], u = uv[v * 2], w = uv[v * 2 + 1];
      pts[i * 2] = Number.isFinite(u) ? u : 0; pts[i * 2 + 1] = Number.isFinite(w) ? w : 0;
    }
    const fixed = o.angles ? Number(o.angles[k]) : NaN;
    const ang = Number.isFinite(fixed) ? fixed : o.orient === 'min_rect' && nv >= 2 ? minAreaRectAngle(convexHull2D(pts)) : 0;
    let sc = o.scaleMode === 'uniform' ? (isl.areaUV > 1e-18 && isl.area3 > 1e-18 ? Math.sqrt(isl.area3 / isl.areaUV) : meanDens) : 1;
    const wt = o.weights ? Number(o.weights[k]) : 1;
    if (Number.isFinite(wt) && wt > 0) sc *= wt;
    const c = Math.cos(ang), s = Math.sin(ang);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    const L = new Float64Array(nv * 2);
    for (let i = 0; i < nv; i++) {
      const x = (pts[i * 2] * c - pts[i * 2 + 1] * s) * sc, y = (pts[i * 2] * s + pts[i * 2 + 1] * c) * sc;
      L[i * 2] = x; L[i * 2 + 1] = y;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (!(x0 <= x1)) { x0 = x1 = y0 = y1 = 0; }
    for (let i = 0; i < nv; i++) { L[i * 2] = Math.max(0, L[i * 2] - x0); L[i * 2 + 1] = Math.max(0, L[i * 2 + 1] - y0); }
    const w = x1 - x0, h = y1 - y0;
    let T: Float64Array | null = null;
    if (o.turns) {
      // 90° counter-clockwise: (x, y) -> (h - y, x); a rotation, so the uv winding is kept
      T = new Float64Array(nv * 2);
      for (let i = 0; i < nv; i++) { T[i * 2] = Math.max(0, h - L[i * 2 + 1]); T[i * 2 + 1] = L[i * 2]; }
    }
    prep.local.push([L, T]);
    prep.w[k] = w; prep.h[k] = h;
    let ar = 0;
    const tr = prep.tris[k];
    for (let t = 0; t < tr.length; t += 3) {
      const p = tr[t] * 2, q = tr[t + 1] * 2, r = tr[t + 2] * 2;
      ar += Math.abs((L[q] - L[p]) * (L[r + 1] - L[p + 1]) - (L[r] - L[p]) * (L[q + 1] - L[p + 1])) / 2;
    }
    prep.area[k] = ar;
  }
  return prep;
}

/** Island orders, largest first: by longest side, height, bounding-box area, area, then shuffles of the first. */
function orderings(prep: Prepared, nI: number, count: number, seed: number): Int32Array[] {
  const idx = () => Array.from({ length: nI }, (_, i) => i);
  const { w, h } = prep;
  const keys: ((k: number) => number)[] = [(k) => Math.max(w[k], h[k]), (k) => h[k], (k) => w[k] * h[k], (k) => prep.area[k]];
  const out: Int32Array[] = [];
  for (let i = 0; i < Math.min(count, keys.length); i++) {
    const key = keys[i];
    out.push(Int32Array.from(idx().sort((p, q) => key(q) - key(p) || p - q)));
  }
  const R = rng((seed | 0) * 7919 + 17);
  while (out.length < count) {
    const o = Array.from(out[0]);
    for (let s = 0; s < nI; s++) {
      const i = Math.floor(R() * nI), j = Math.min(nI - 1, i + 1 + Math.floor(R() * Math.max(1, nI * 0.05)));
      [o[i], o[j]] = [o[j], o[i]];
    }
    out.push(Int32Array.from(o));
  }
  return out;
}

/** Take the cells of fixed uv triangles inside tile (tu, tv), dilated by a. */
function takeObstacles(A: Atlas, tri: Float64Array, tu: number, tv: number, G: number, a: number, gap: number): void {
  const px = new Float64Array(6), one = Int32Array.from([0, 1, 2]);
  for (let t = 0; t + 5 < tri.length; t += 6) {
    let finite = true;
    for (let k = 0; k < 3; k++) {
      px[k * 2] = (tri[t + k * 2] - tu) * G; px[k * 2 + 1] = (tri[t + k * 2 + 1] - tv) * G;
      if (!Number.isFinite(px[k * 2]) || !Number.isFinite(px[k * 2 + 1])) finite = false;
    }
    if (!finite) continue;
    const u0 = Math.min(px[0], px[2], px[4]), u1 = Math.max(px[0], px[2], px[4]), v0 = Math.min(px[1], px[3], px[5]), v1 = Math.max(px[1], px[3], px[5]);
    if (u1 < -a - 1 || u0 > G + a + 1 || v1 < -a - 1 || v0 > G + a + 1) continue;
    if (u1 - u0 > 4 * G || v1 - v0 > 4 * G) {
      // a huge (tiling) triangle: take its bounding box inside the tile
      const c0 = Math.max(0, Math.floor(u0) - a), c1 = Math.min(G - 1, Math.floor(u1) + a);
      for (let c = c0; c <= c1; c++) A.take(c, Math.floor(v0) - a, Math.floor(v1) + a);
      continue;
    }
    // rasterise from a whole-cell origin at the triangle's lower corner, then move the cells back to the tile
    const ox = Math.floor(u0), oy = Math.floor(v0);
    for (let k = 0; k < 3; k++) { px[k * 2] -= ox; px[k * 2 + 1] -= oy; }
    const R = dilate(rasterise(px, one, gap), a, gap);
    for (let i = 0; i < R.n; i++) A.take(R.c[i] - a + ox, R.lo[i] - a + oy, R.hi[i] - a + oy);
  }
}
