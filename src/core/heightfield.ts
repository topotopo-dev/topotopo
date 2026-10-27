// Heightfields: Houdini's terrain model. A regular grid of samples in the XZ plane (Y up) with named float layers
// (height, mask, flow, sediment, debris, water and any user layer), carried in Geometry.volumes next to SDFs.
//
//   sample (i, j)  world X = origin[0] + i * cellSize, Z = origin[1] + j * cellSize
//   layers         Float32Array, row-major: index j * width + i; `height` holds absolute world Y
//   extent         (width - 1) * cellSize by (height - 1) * cellSize: samples sit on the grid nodes, which is
//                  how Unreal Landscape counts vertices (a 505 × 505 heightmap = 504 × 504 quads)
//
// Cooked geometry is immutable: Geometry.clone() gives each heightfield its own layer map but shares the arrays,
// so a node writes through `writable(name)` (a private copy) and never into an array it did not allocate.
// This module holds the volume class, sampling (bilinear, or over Unreal Landscape triangles), grid filters (blur,
// distance transforms), rasterising meshes and curves onto the grid, conversion to polygons, the render preview and
// the inspect summary.
import { AttribTable, Geometry } from './geometry.ts';
import type { HeightfieldVolume, Volume } from './geometry.ts';
import type { Vec3 } from './math.ts';
import { triangulate } from './topology.ts';

/** Largest grid a node may create (samples). */
export const MAX_SAMPLES = 4097 * 4097;

/** Layer names with a Houdini meaning; any other name is a user layer. */
export const STANDARD_LAYERS = ['height', 'mask', 'flow', 'sediment', 'debris', 'water', 'fill', 'lake'];

/** Bilinear lookup in a w × h grid at fractional sample coordinates (clamped to the grid). Needs w, h >= 2. */
export function bilinear(a: ArrayLike<number>, w: number, h: number, fx: number, fz: number): number {
  if (!(fx > 0)) fx = 0; else if (fx > w - 1) fx = w - 1;
  if (!(fz > 0)) fz = 0; else if (fz > h - 1) fz = h - 1;
  let i = Math.floor(fx), j = Math.floor(fz);
  if (i > w - 2) i = w - 2;
  if (j > h - 2) j = h - 2;
  const u = fx - i, v = fz - j, k = j * w + i;
  return (a[k] * (1 - u) + a[k + 1] * u) * (1 - v) + (a[k + w] * (1 - u) + a[k + w + 1] * u) * v;
}

/**
 * How a heightfield is read between its samples: 'bilinear' (the default everywhere), or 'unreal_triangles', the
 * surface of an Unreal Landscape imported from the field's heightmap (unrealTriangles).
 */
export type HeightfieldSampling = 'bilinear' | 'unreal_triangles';
export const HEIGHTFIELD_SAMPLING: HeightfieldSampling[] = ['bilinear', 'unreal_triangles'];

/**
 * Piecewise-linear lookup in a w × h grid at fractional sample coordinates (clamped to the grid like bilinear): every
 * cell (i, j)–(i+1, j+1) is split along its (0,0)–(1,1) diagonal in index space, with column i = X and row j = Z. That
 * is how Unreal's Landscape triangulates a heightmap (vertex (x, y) = (column, row), each quad cut from (x, y) to
 * (x+1, y+1)); export png16/r16 writes column = X and row 0 = the field's min Z, and the Landscape maps X → X and
 * Z → Y, so the two surfaces coincide. It equals bilinear() at the samples and along the cell edges and differs inside
 * a cell by at most |h00 + h11 - h10 - h01| / 4 (at the cell centre). Needs w, h >= 2.
 */
export function unrealTriangles(a: ArrayLike<number>, w: number, h: number, fx: number, fz: number): number {
  if (!(fx > 0)) fx = 0; else if (fx > w - 1) fx = w - 1;
  if (!(fz > 0)) fz = 0; else if (fz > h - 1) fz = h - 1;
  let i = Math.floor(fx), j = Math.floor(fz);
  if (i > w - 2) i = w - 2;
  if (j > h - 2) j = h - 2;
  const u = fx - i, v = fz - j, k = j * w + i;
  // triangle (0,0) (1,0) (1,1) below the diagonal (u >= v), (0,0) (0,1) (1,1) above it
  return u >= v
    ? a[k] + (a[k + 1] - a[k]) * u + (a[k + w + 1] - a[k + 1]) * v
    : a[k] + (a[k + w] - a[k]) * v + (a[k + w + 1] - a[k + w]) * u;
}

export class Heightfield implements HeightfieldVolume {
  readonly kind = 'heightfield' as const;
  name: string;
  width: number;
  height: number;
  cellSize: number;
  origin: [number, number];
  layers: Map<string, Float32Array>;

  constructor(width: number, height: number, cellSize: number, origin: [number, number], layers?: Map<string, Float32Array>, name = 'heightfield') {
    if (!(width >= 2 && height >= 2)) throw new Error(`heightfield needs at least 2 × 2 samples (got ${width} × ${height})`);
    if (!(cellSize > 0)) throw new Error(`heightfield cell size must be > 0 (got ${cellSize})`);
    this.width = width;
    this.height = height;
    this.cellSize = cellSize;
    this.origin = [origin[0], origin[1]];
    this.layers = layers ?? new Map();
    this.name = name;
  }

  /** A field covering sizeX × sizeZ metres (rounded up to whole cells) centred on (cx, cz), without layers. */
  static fromSize(sizeX: number, sizeZ: number, cellSize: number, cx = 0, cz = 0, name = 'heightfield'): Heightfield {
    const w = Math.max(2, Math.ceil(sizeX / cellSize - 1e-6) + 1), h = Math.max(2, Math.ceil(sizeZ / cellSize - 1e-6) + 1);
    return new Heightfield(w, h, cellSize, [cx - ((w - 1) * cellSize) / 2, cz - ((h - 1) * cellSize) / 2], undefined, name);
  }

  get count() { return this.width * this.height; }
  /** extent along X (metres) */
  get sizeX() { return (this.width - 1) * this.cellSize; }
  /** extent along Z (metres) */
  get sizeZ() { return (this.height - 1) * this.cellSize; }
  get center(): [number, number] { return [this.origin[0] + this.sizeX / 2, this.origin[1] + this.sizeZ / 2]; }

  get bounds(): { min: Vec3; max: Vec3 } {
    const s = layerStats(this.layers.get('height'));
    const lo = s ? s.min : 0, hi = s ? s.max : 0;
    return { min: [this.origin[0], lo, this.origin[1]], max: [this.origin[0] + this.sizeX, hi, this.origin[1] + this.sizeZ] };
  }

  /** world X of column i */
  x(i: number) { return this.origin[0] + i * this.cellSize; }
  /** world Z of row j */
  z(j: number) { return this.origin[1] + j * this.cellSize; }
  /** fractional column of world X */
  fx(x: number) { return (x - this.origin[0]) / this.cellSize; }
  /** fractional row of world Z */
  fz(z: number) { return (z - this.origin[1]) / this.cellSize; }

  /** A layer (read-only by convention: it may be shared with other cooked geometry). */
  layer(name: string): Float32Array | undefined { return this.layers.get(name); }

  /** A layer for reading, or a new array filled with `fill` when it is missing (not stored). */
  read(name: string, fill = 0): Float32Array {
    return this.layers.get(name) ?? new Float32Array(this.count).fill(fill);
  }

  /** A private copy of a layer (a new one filled with `fill` when missing), stored in this field, ready for writing. */
  writable(name: string, fill = 0): Float32Array {
    const a = this.layers.get(name);
    const c = a ? a.slice() : new Float32Array(this.count).fill(fill);
    this.layers.set(name, c);
    return c;
  }

  /** Value of a layer array at world (x, z): bilinear, or over Unreal's Landscape triangles (unrealTriangles). */
  sampleArray(a: ArrayLike<number>, x: number, z: number, mode: HeightfieldSampling = 'bilinear'): number {
    return (mode === 'unreal_triangles' ? unrealTriangles : bilinear)(a, this.width, this.height, this.fx(x), this.fz(z));
  }

  sample(x: number, z: number, mode: HeightfieldSampling = 'bilinear'): number {
    const a = this.layers.get('height');
    return a ? this.sampleArray(a, x, z, mode) : 0;
  }

  sampleLayer(name: string, x: number, z: number): number {
    const a = this.layers.get(name);
    return a ? this.sampleArray(a, x, z) : 0;
  }

  /** Height gradient (dh/dx, dh/dz) at sample (i, j): central differences, one-sided at the border. */
  gradient(i: number, j: number, h: ArrayLike<number> = this.read('height')): [number, number] {
    const w = this.width, k = j * w + i, c = this.cellSize;
    const il = i > 0 ? k - 1 : k, ir = i < w - 1 ? k + 1 : k;
    const jd = j > 0 ? k - w : k, ju = j < this.height - 1 ? k + w : k;
    const dx = ((i < w - 1 ? 1 : 0) + (i > 0 ? 1 : 0)) * c, dz = ((j < this.height - 1 ? 1 : 0) + (j > 0 ? 1 : 0)) * c;
    return [(h[ir] - h[il]) / dx, (h[ju] - h[jd]) / dz];
  }

  clone(): Heightfield {
    return new Heightfield(this.width, this.height, this.cellSize, this.origin, new Map(this.layers), this.name);
  }

  /** The same grid without layers. */
  emptyLike(): Heightfield {
    return new Heightfield(this.width, this.height, this.cellSize, this.origin, undefined, this.name);
  }
}

export function isHeightfield(v: Volume): v is HeightfieldVolume {
  return v.kind === 'heightfield';
}

/** The Heightfield class behind a heightfield volume (wraps foreign implementations of the interface). */
export function asHeightfield(v: HeightfieldVolume): Heightfield {
  return v instanceof Heightfield ? v : new Heightfield(v.width, v.height, v.cellSize, v.origin, new Map(v.layers), v.name);
}

/** The heightfields of a geometry, in volume order. */
export function heightfieldsOf(g: Geometry): Heightfield[] {
  return g.volumes.filter(isHeightfield).map(asHeightfield);
}

/** min / max / mean of a layer (null for a missing or empty one). */
export function layerStats(a: ArrayLike<number> | undefined): { min: number; max: number; mean: number } | null {
  if (!a || !a.length) return null;
  let lo = Infinity, hi = -Infinity, sum = 0;
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
    sum += v;
  }
  return { min: lo, max: hi, mean: sum / a.length };
}

/** Slope in degrees at every sample. */
export function slopeLayer(hf: Heightfield, h: ArrayLike<number> = hf.read('height')): Float32Array {
  const out = new Float32Array(hf.count);
  for (let j = 0; j < hf.height; j++)
    for (let i = 0; i < hf.width; i++) {
      const [gx, gz] = hf.gradient(i, j, h);
      out[j * hf.width + i] = (Math.atan(Math.hypot(gx, gz)) * 180) / Math.PI;
    }
  return out;
}

// ---------------------------------------------------------------- filters

/** Box blur with integer half-width r (samples), separable running sums, clamped edges. */
export function boxBlur(src: ArrayLike<number>, w: number, h: number, r: number): Float64Array {
  const out = Float64Array.from(src as ArrayLike<number>);
  if (r < 1) return out;
  const n = Math.max(w, h), line = new Float64Array(n), inv = 1 / (2 * r + 1);
  // rows
  for (let j = 0; j < h; j++) {
    const o = j * w;
    for (let i = 0; i < w; i++) line[i] = out[o + i];
    let s = (r + 1) * line[0];
    for (let k = 1; k <= r; k++) s += line[Math.min(k, w - 1)];
    for (let i = 0; i < w; i++) {
      out[o + i] = s * inv;
      s += line[Math.min(i + r + 1, w - 1)] - line[Math.max(i - r, 0)];
    }
  }
  // columns
  for (let i = 0; i < w; i++) {
    for (let j = 0; j < h; j++) line[j] = out[j * w + i];
    let s = (r + 1) * line[0];
    for (let k = 1; k <= r; k++) s += line[Math.min(k, h - 1)];
    for (let j = 0; j < h; j++) {
      out[j * w + i] = s * inv;
      s += line[Math.min(j + r + 1, h - 1)] - line[Math.max(j - r, 0)];
    }
  }
  return out;
}

/** Half-widths of three box passes that approximate a gaussian with standard deviation sigma (samples). */
function gaussBoxes(sigma: number): number[] {
  const n = 3;
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  return Array.from({ length: n }, (_, i) => ((i < m ? wl : wu) - 1) / 2);
}

/**
 * Blur a grid: 'gaussian' (radius = 2 sigma, three box passes) or 'box' (half-width = radius), `radius` in samples,
 * repeated `iterations` times.
 */
export function blurGrid(src: ArrayLike<number>, w: number, h: number, radius: number, mode: 'gaussian' | 'box' = 'gaussian', iterations = 1): Float64Array {
  let a: Float64Array = Float64Array.from(src as ArrayLike<number>);
  for (let it = 0; it < iterations; it++) {
    if (mode === 'box') a = boxBlur(a, w, h, Math.round(radius));
    else for (const r of gaussBoxes(radius / 2)) a = boxBlur(a, w, h, Math.max(0, Math.round(r)));
  }
  return a;
}

/** 1D squared distance transform (Felzenszwalb–Huttenlocher) over finite entries of f; writes d and the argmin. */
function edt1d(f: Float64Array, n: number, d: Float64Array, arg: Int32Array, v: Int32Array, z: Float64Array) {
  let k = -1;
  for (let q = 0; q < n; q++) {
    if (f[q] === Infinity) continue;
    if (k < 0) { k = 0; v[0] = q; z[0] = -Infinity; z[1] = Infinity; continue; }
    let p = v[k];
    let s = (f[q] + q * q - (f[p] + p * p)) / (2 * q - 2 * p);
    while (s <= z[k]) { // z[0] = -Infinity ends the loop at k = 0
      k--;
      p = v[k];
      s = (f[q] + q * q - (f[p] + p * p)) / (2 * q - 2 * p);
    }
    k++;
    v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  if (k < 0) { d.fill(Infinity, 0, n); arg.fill(-1, 0, n); return; }
  let kk = 0;
  for (let q = 0; q < n; q++) {
    while (z[kk + 1] < q) kk++;
    const p = v[kk];
    d[q] = (q - p) * (q - p) + f[p];
    arg[q] = p;
  }
}

/**
 * Exact Euclidean distance transform: squared distance in samples² from every sample to the nearest site
 * (sites[k] != 0) and the index of that site (-1 when there are none).
 */
export function distanceTransform(sites: ArrayLike<number>, w: number, h: number): { d2: Float64Array; nearest: Int32Array } {
  const n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n), arg = new Int32Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  const d1 = new Float64Array(w * h), col = new Int32Array(w * h);
  // rows: distance along X to the nearest site of the same row
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) f[i] = sites[j * w + i] ? 0 : Infinity;
    edt1d(f, w, d, arg, v, z);
    for (let i = 0; i < w; i++) { d1[j * w + i] = d[i]; col[j * w + i] = arg[i]; }
  }
  const d2 = new Float64Array(w * h), nearest = new Int32Array(w * h);
  for (let i = 0; i < w; i++) {
    for (let j = 0; j < h; j++) f[j] = d1[j * w + i];
    edt1d(f, h, d, arg, v, z);
    for (let j = 0; j < h; j++) {
      d2[j * w + i] = d[j];
      const jj = arg[j];
      nearest[j * w + i] = jj < 0 ? -1 : jj * w + col[jj * w + i];
    }
  }
  return { d2, nearest };
}

export function smoothstep(e0: number, e1: number, x: number): number {
  if (e1 === e0) return x < e0 ? 0 : 1;
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------- rasterising geometry onto the grid

/**
 * Visit every sample under a triangle of `g`'s polygons (projected along Y): fn(k, y, prim) with the triangle's Y
 * interpolated at the sample. Vertical triangles are skipped. A sample under several triangles is visited for each.
 */
export function rasterizeMesh(hf: Heightfield, g: Geometry, fn: (k: number, y: number, prim: number) => void) {
  const { tris, triPrim } = triangulate(g);
  const P = g.P, w = hf.width, h = hf.height;
  const eps = 1e-7;
  for (let t = 0; t < tris.length / 3; t++) {
    const a = g.vertexPoint[tris[t * 3]] * 3, b = g.vertexPoint[tris[t * 3 + 1]] * 3, cc = g.vertexPoint[tris[t * 3 + 2]] * 3;
    const ax = hf.fx(P[a]), az = hf.fz(P[a + 2]), bx = hf.fx(P[b]), bz = hf.fz(P[b + 2]), cx = hf.fx(P[cc]), cz = hf.fz(P[cc + 2]);
    const area = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
    if (Math.abs(area) < 1e-12) continue;
    const i0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx) - 1e-6)), i1 = Math.min(w - 1, Math.floor(Math.max(ax, bx, cx) + 1e-6));
    const j0 = Math.max(0, Math.ceil(Math.min(az, bz, cz) - 1e-6)), j1 = Math.min(h - 1, Math.floor(Math.max(az, bz, cz) + 1e-6));
    const inv = 1 / area, ya = P[a + 1], yb = P[b + 1], yc = P[cc + 1];
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const w0 = ((bx - i) * (cz - j) - (bz - j) * (cx - i)) * inv;
        const w1 = ((cx - i) * (az - j) - (cz - j) * (ax - i)) * inv;
        const w2 = 1 - w0 - w1;
        if (w0 < -eps || w1 < -eps || w2 < -eps) continue;
        fn(j * w + i, w0 * ya + w1 * yb + w2 * yc, triPrim[t]);
      }
  }
}

/**
 * Visit every sample within `r` metres (in XZ) of the segment a → b: fn(k, dist, t, side) with the distance, the
 * parameter of the closest point (0..1) and the signed lateral offset (positive to the left of a → b seen from +Y).
 */
export function splatSegment(hf: Heightfield, ax: number, az: number, bx: number, bz: number, r: number, fn: (k: number, dist: number, t: number, side: number) => void) {
  const c = hf.cellSize, w = hf.width, h = hf.height;
  const i0 = Math.max(0, Math.floor(hf.fx(Math.min(ax, bx) - r))), i1 = Math.min(w - 1, Math.ceil(hf.fx(Math.max(ax, bx) + r)));
  const j0 = Math.max(0, Math.floor(hf.fz(Math.min(az, bz) - r))), j1 = Math.min(h - 1, Math.ceil(hf.fz(Math.max(az, bz) + r)));
  const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz, L = Math.sqrt(L2);
  for (let j = j0; j <= j1; j++) {
    const z = hf.origin[1] + j * c;
    for (let i = i0; i <= i1; i++) {
      const x = hf.origin[0] + i * c;
      let t = L2 > 0 ? ((x - ax) * dx + (z - az) * dz) / L2 : 0;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const qx = ax + dx * t - x, qz = az + dz * t - z;
      const dist = Math.hypot(qx, qz);
      if (dist > r) continue;
      // (d × (p - a)).y: positive when p is counter-clockwise from d around +Y, i.e. left of a → b seen from above
      const side = L > 0 ? ((x - ax) * dz - (z - az) * dx) / L : 0;
      fn(j * w + i, dist, t, side);
    }
  }
}

/** Polylines of a geometry (open prims, and closed ones as loops) as XYZ point lists. */
export function curvesOf(g: Geometry): { pts: number[][]; closed: boolean }[] {
  const out: { pts: number[][]; closed: boolean }[] = [];
  const P = g.P;
  for (let p = 0; p < g.numPrims; p++) {
    const pts = g.primPoints(p).map((i) => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]);
    if (pts.length >= 2) out.push({ pts, closed: !!g.primClosed[p] });
  }
  return out;
}

// ---------------------------------------------------------------- transforms

/**
 * Apply an affine matrix (column-major Mat4) to a heightfield. Heightfields stay axis-aligned: the XZ part snaps to
 * the nearest rotation by a multiple of 90° (or mirror) times a uniform scale; Y scale and translation act on the
 * height layer. Returns a new field (layers re-gridded when the XZ part rotates or mirrors).
 */
export function transformHeightfield(src: HeightfieldVolume, m: ArrayLike<number>): Heightfield {
  const hf = asHeightfield(src);
  const a00 = m[0], a01 = m[8], a10 = m[2], a11 = m[10];
  const s = Math.sqrt(Math.abs(a00 * a11 - a01 * a10)) || 1;
  // nearest signed permutation
  const cands: [number, number, number, number][] = [[1, 0, 0, 1], [-1, 0, 0, -1], [1, 0, 0, -1], [-1, 0, 0, 1], [0, 1, 1, 0], [0, -1, -1, 0], [0, -1, 1, 0], [0, 1, -1, 0]];
  let best = cands[0], bv = -Infinity;
  for (const q of cands) { const v = q[0] * a00 + q[1] * a01 + q[2] * a10 + q[3] * a11; if (v > bv) { bv = v; best = q; } }
  const [p00, p01, p10, p11] = best;
  const tx = m[12], tz = m[14], sy = m[5], ty = m[13];
  const swap = p00 === 0;
  const nw = swap ? hf.height : hf.width, nh = swap ? hf.width : hf.height;
  const cell = hf.cellSize * s;
  // transformed corners → new origin
  const xs: number[] = [], zs: number[] = [];
  for (const [i, j] of [[0, 0], [hf.width - 1, 0], [0, hf.height - 1], [hf.width - 1, hf.height - 1]]) {
    const x = hf.x(i), z = hf.z(j);
    xs.push(s * (p00 * x + p01 * z) + tx);
    zs.push(s * (p10 * x + p11 * z) + tz);
  }
  const out = new Heightfield(nw, nh, cell, [Math.min(...xs), Math.min(...zs)], undefined, hf.name);
  const identity = !swap && p00 === 1 && p11 === 1;
  // inverse index map: new (i', j') → old (i, j)
  let map: Int32Array | null = null;
  if (!identity) {
    map = new Int32Array(nw * nh);
    for (let j2 = 0; j2 < nh; j2++)
      for (let i2 = 0; i2 < nw; i2++) {
        const X = (out.x(i2) - tx) / s, Z = (out.z(j2) - tz) / s;
        // inverse of a signed permutation is its transpose
        const x = p00 * X + p10 * Z, z = p01 * X + p11 * Z;
        const i = Math.min(hf.width - 1, Math.max(0, Math.round(hf.fx(x)))), j = Math.min(hf.height - 1, Math.max(0, Math.round(hf.fz(z))));
        map[j2 * nw + i2] = j * hf.width + i;
      }
  }
  for (const [name, a] of hf.layers) {
    let b: Float32Array;
    if (!map) b = name === 'height' && (sy !== 1 || ty !== 0) ? a.slice() : a;
    else { b = new Float32Array(nw * nh); for (let k = 0; k < b.length; k++) b[k] = a[map[k]]; }
    if (name === 'height' && (sy !== 1 || ty !== 0)) for (let k = 0; k < b.length; k++) b[k] = b[k] * sy + ty;
    out.layers.set(name, b);
  }
  return out;
}

// ---------------------------------------------------------------- polygons

export interface ToMeshOptions {
  /** take every step-th sample (1 = full resolution); the last row and column are always included */
  step?: number;
  /** copy every layer to a point float attribute of the same name */
  layers?: boolean;
  /** point N from the field gradient */
  normals?: boolean;
  /** point uv 0..1 over the field */
  uv?: boolean;
  /** point Cd: none, mask (white → red), height (low → high ramp), terrain (grass / rock / sediment / snow / road), preview */
  color?: 'none' | 'mask' | 'height' | 'terrain' | 'preview';
}

const ramp = (stops: [number, number[]][], t: number): number[] => {
  if (t <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [p0, c0] = stops[i - 1], [p1, c1] = stops[i];
      const u = (t - p0) / (p1 - p0 || 1);
      return [0, 1, 2].map((k) => c0[k] + (c1[k] - c0[k]) * u);
    }
  }
  return stops[stops.length - 1][1];
};

const HEIGHT_RAMP: [number, number[]][] = [[0, [0.16, 0.3, 0.42]], [0.25, [0.3, 0.5, 0.36]], [0.55, [0.6, 0.62, 0.4]], [0.8, [0.62, 0.5, 0.4]], [1, [0.95, 0.95, 0.93]]];
const PREVIEW_RAMP: [number, number[]][] = [[0, [0.36, 0.42, 0.3]], [0.5, [0.55, 0.53, 0.42]], [0.85, [0.66, 0.62, 0.56]], [1, [0.9, 0.89, 0.86]]];

/** Sample indices along one axis for a decimation step (the last sample is always included). */
function steps(n: number, step: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n - 1; i += step) out.push(i);
  out.push(n - 1);
  return out;
}

/** The heightfield as a grid of quads facing +Y (points row-major like the layers when step is 1). */
export function heightfieldToMesh(hf: Heightfield, o: ToMeshOptions = {}): Geometry {
  const step = Math.max(1, Math.round(o.step ?? 1));
  const I = steps(hf.width, step), J = steps(hf.height, step);
  const nx = I.length, nz = J.length, np = nx * nz;
  const H = hf.read('height');
  const pos = new Float64Array(np * 3);
  const src = new Int32Array(np);
  for (let b = 0; b < nz; b++)
    for (let a = 0; a < nx; a++) {
      const p = b * nx + a, k = J[b] * hf.width + I[a];
      src[p] = k;
      pos[p * 3] = hf.x(I[a]); pos[p * 3 + 1] = H[k]; pos[p * 3 + 2] = hf.z(J[b]);
    }
  const g = new Geometry({ positions: pos });
  const nq = (nx - 1) * (nz - 1);
  const vp = new Int32Array(nq * 4);
  let q = 0;
  for (let b = 0; b < nz - 1; b++)
    for (let a = 0; a < nx - 1; a++) {
      const p = b * nx + a;
      // (i,j) → (i,j+1) → (i+1,j+1) → (i+1,j): counter-clockwise seen from +Y, so the face normal is +Y
      vp[q++] = p; vp[q++] = p + nx; vp[q++] = p + nx + 1; vp[q++] = p + 1;
    }
  g.vertexPoint = vp;
  g.primStart = Int32Array.from({ length: nq + 1 }, (_, i) => i * 4);
  g.primClosed = new Uint8Array(nq).fill(1);
  g.vertices = new AttribTable(nq * 4);
  g.prims = new AttribTable(nq);
  if (o.layers)
    for (const [name, a] of hf.layers) {
      if (name === 'P' || name === 'N' || name === 'Cd' || name === 'uv') continue;
      const d = g.points.add(name, 'float', 1).data as Float64Array;
      for (let p = 0; p < np; p++) d[p] = a[src[p]];
    }
  if (o.normals !== false) {
    const N = g.points.add('N', 'float', 3).data as Float64Array;
    for (let b = 0; b < nz; b++)
      for (let a = 0; a < nx; a++) {
        const [gx, gz] = hf.gradient(I[a], J[b], H);
        const l = Math.hypot(gx, 1, gz), p = b * nx + a;
        N[p * 3] = -gx / l; N[p * 3 + 1] = 1 / l; N[p * 3 + 2] = -gz / l;
      }
  }
  if (o.uv) {
    const uv = g.points.add('uv', 'float', 3).data as Float64Array;
    for (let b = 0; b < nz; b++) for (let a = 0; a < nx; a++) { const p = b * nx + a; uv[p * 3] = I[a] / (hf.width - 1); uv[p * 3 + 1] = J[b] / (hf.height - 1); }
  }
  const color = o.color ?? 'none';
  if (color !== 'none') {
    const Cd = g.points.add('Cd', 'float', 3).data as Float64Array;
    const st = layerStats(H)!;
    const span = st.max - st.min || 1;
    const mask = hf.layer('mask');
    const mst = layerStats(mask);
    const showMask = !!mask && !!mst && mst.max > 0 && (color === 'mask' || color === 'preview');
    const slope = color === 'terrain' ? slopeLayer(hf, H) : null;
    const sed = hf.layer('sediment'), deb = hf.layer('debris'), flow = hf.layer('flow'), road = hf.layer('path'), water = hf.layer('water');
    for (let p = 0; p < np; p++) {
      const k = src[p], t = (H[k] - st.min) / span;
      let c: number[];
      if (color === 'mask') { const m = mask ? Math.max(0, Math.min(1, mask[k])) : 0; c = [0.85 + 0.1 * m, 0.85 - 0.7 * m, 0.85 - 0.75 * m]; }
      else if (color === 'height') c = ramp(HEIGHT_RAMP, t);
      else if (color === 'preview') {
        c = ramp(PREVIEW_RAMP, t);
        if (showMask) { const m = Math.max(0, Math.min(1, mask![k])) * 0.7; c = [c[0] + (0.9 - c[0]) * m, c[1] + (0.12 - c[1]) * m, c[2] + (0.1 - c[2]) * m]; }
      } else {
        // terrain: grass on gentle slopes, rock on steep ones, sand where sediment/debris settled, darker where water
        // flows, snow on the highest gentle ground, asphalt on a "path" layer
        const s = slope![k];
        const grass = ramp([[0, [0.27, 0.36, 0.16]], [0.6, [0.36, 0.4, 0.2]], [1, [0.45, 0.43, 0.3]]], t);
        const rockW = smoothstep(28, 42, s);
        c = [0, 1, 2].map((i) => grass[i] + ([0.45, 0.42, 0.39][i] - grass[i]) * rockW);
        const loose = (sed ? Math.max(0, sed[k]) : 0) + (deb ? Math.max(0, deb[k]) : 0);
        if (loose > 0) { const u = smoothstep(0.02 * span, 0.08 * span, loose) * 0.7; c = c.map((v, i) => v + ([0.66, 0.58, 0.44][i] - v) * u); }
        const wet = Math.max(flow ? Math.max(0, Math.min(1, flow[k])) : 0, water ? Math.max(0, Math.min(1, water[k])) : 0);
        if (wet > 0) { const u = smoothstep(0.6, 1, wet) * 0.45; c = c.map((v, i) => v + ([0.2, 0.25, 0.28][i] - v) * u); }
        const snow = smoothstep(0.8, 0.95, t) * (1 - smoothstep(30, 45, s));
        if (snow > 0) c = c.map((v) => v + (0.93 - v) * snow);
        if (road) { const u = Math.max(0, Math.min(1, road[k])); if (u > 0) c = c.map((v, i) => v + ([0.24, 0.23, 0.22][i] - v) * u); }
      }
      Cd[p * 3] = c[0]; Cd[p * 3 + 1] = c[1]; Cd[p * 3 + 2] = c[2];
    }
  }
  return g;
}

/**
 * How the preview draws a heightfield with at most maxRes quads per side (Infinity: every sample): every step-th
 * sample (the last one always), `shown` samples along X and Z.
 */
export function heightfieldPreviewStep(hf: HeightfieldVolume, maxRes = 256): { step: number; shown: [number, number] } {
  const step = Math.max(1, Math.ceil((Math.max(hf.width, hf.height) - 1) / Math.max(1, maxRes)));
  return { step, shown: [steps(hf.width, step).length, steps(hf.height, step).length] };
}

/** The render preview of a heightfield: its grid decimated to at most maxRes quads per side, all layers as point attributes, height-ramp Cd with the mask in red. */
export function heightfieldPreviewMesh(hf: HeightfieldVolume, maxRes = 256): Geometry {
  return heightfieldToMesh(asHeightfield(hf), { step: heightfieldPreviewStep(hf, maxRes).step, layers: true, normals: true, color: 'preview' });
}

/**
 * For rendering and viewing: a geometry whose heightfields are replaced by their preview meshes (merged with the
 * rest of the geometry). Returns g itself when it holds no heightfield.
 */
export function withHeightfieldPreview(g: Geometry, maxRes = 256): Geometry {
  if (!g.volumes.some(isHeightfield)) return g;
  const rest = g.clone();
  rest.volumes = rest.volumes.filter((v) => !isHeightfield(v));
  const previews = g.volumes.filter(isHeightfield).map((v) => heightfieldPreviewMesh(v, maxRes));
  return Geometry.merge(rest.numPoints || rest.volumes.length ? [rest, ...previews] : previews);
}

// ---------------------------------------------------------------- inspection

const fmt = (x: number) => {
  if (!Number.isFinite(x)) return String(x);
  const a = Math.abs(x);
  if (a >= 1000) return x.toFixed(0);
  if (a >= 10) return x.toFixed(1);
  if (a >= 0.01 || a === 0) return x.toFixed(2);
  return x.toExponential(1);
};

/** "1 SDF volume, 1 heightfield, 2 images" style counts (empty string when there are no volumes). */
export function volumeCounts(g: Geometry): string {
  const nh = g.volumes.filter(isHeightfield).length, ni = g.volumes.filter((v) => v.kind === 'image').length;
  const ng = g.volumes.filter((v) => v.kind === 'grid').length, ns = g.volumes.length - nh - ni - ng;
  const parts: string[] = [];
  if (ns) parts.push(`${ns} SDF volume(s)`);
  if (ng) parts.push(`${ng} SDF grid(s)`);
  if (nh) parts.push(`${nh} heightfield(s)`);
  if (ni) parts.push(`${ni} image(s)`);
  return parts.join(', ');
}

/** Inspect/summary lines for the heightfields of a geometry: grid, extent and per-layer min/max/mean. */
export function heightfieldSummary(g: Geometry): string[] {
  const out: string[] = [];
  for (const hf of heightfieldsOf(g)) {
    const c = hf.center;
    out.push(`heightfield "${hf.name}": ${hf.width}×${hf.height} samples, cell ${fmt(hf.cellSize)} m, size ${fmt(hf.sizeX)}×${fmt(hf.sizeZ)} m, center (${fmt(c[0])}, ${fmt(c[1])})`);
    const ls = [...hf.layers].map(([n, a]) => { const s = layerStats(a)!; return `${n} [${fmt(s.min)} .. ${fmt(s.max)}, mean ${fmt(s.mean)}]`; });
    out.push(`  layers: ${ls.length ? ls.join(', ') : '(none)'}`);
  }
  return out;
}
