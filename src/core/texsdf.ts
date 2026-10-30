// Distance fields and regions for the texture nodes (src/nodes/texture.ts): an exact Euclidean distance transform
// that can wrap at the borders, signed distances from a grey mask to about a tenth of a pixel, SDF shapes, offsets
// and booleans, bevel profiles, mask growth with value propagation, and flood fill of the tiles of a mask.
// Conventions as in core/texture.ts (row-major, row 0 at the top, pixel centres at +0.5). Signed distances are
// negative inside. Functions taking a texel size work in metres (texel = metres per pixel), the others in pixels.
// "wrap" means the image tiles: distances are measured across the opposite border (to the nearest periodic copy),
// so a tileable mask gives a tileable field and regions crossing a border are one region.
import { hash32 } from './random.ts';

const clamp01 = (x: number) => (x > 0 ? (x < 1 ? x : 1) : 0);
const smooth = (e0: number, e1: number, x: number) => {
  if (e1 <= e0) return x < e0 ? 0 : 1;
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const wrapI = (i: number, n: number) => ((i % n) + n) % n;
/** The shortest periodic difference (|result| ≤ n / 2). */
const wrapD = (d: number, n: number) => d - n * Math.round(d / n);

// ---------------------------------------------------------------- distance transform

/** 1D squared distance transform of f (Felzenszwalb & Huttenlocher); Infinity = no site. arg = the nearest site. */
function edt1d(f: Float64Array, n: number, d: Float64Array, arg: Int32Array, v: Int32Array, z: Float64Array): void {
  let k = -1;
  for (let q = 0; q < n; q++) {
    const fq = f[q];
    if (fq === Infinity) continue;
    if (k < 0) { k = 0; v[0] = q; z[0] = -Infinity; z[1] = Infinity; continue; }
    let s: number;
    for (;;) {
      const p = v[k];
      s = (fq + q * q - (f[p] + p * p)) / (2 * (q - p));
      if (s <= z[k]) k--; else break; // z[0] = -Infinity: k never drops below 0
    }
    k++;
    v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  if (k < 0) { d.fill(Infinity, 0, n); arg.fill(-1, 0, n); return; }
  let j = 0;
  for (let q = 0; q < n; q++) {
    while (z[j + 1] < q) j++;
    const p = v[j], dq = q - p;
    d[q] = dq * dq + f[p];
    arg[q] = p;
  }
}

/**
 * Exact Euclidean distance transform of the sites (non-zero entries): d2 = squared distance in pixels to the nearest
 * site, nearest = its index (-1 when there is none). With wrap the image is periodic: each 1D pass runs over three
 * copies of its row or column and keeps the middle one, so the distance is to the nearest periodic copy of a site.
 */
export function edt(sites: ArrayLike<number>, w: number, h: number, wrap: boolean): { d2: Float64Array; nearest: Int32Array } {
  const m = Math.max(w, h) * (wrap ? 3 : 1);
  const f = new Float64Array(m), d = new Float64Array(m), arg = new Int32Array(m), v = new Int32Array(m), z = new Float64Array(m + 1);
  const d1 = new Float64Array(w * h), col = new Int32Array(w * h);
  const pass = (n: number, get: (q: number) => number, put: (q: number, dist: number, a: number) => void) => {
    const len = wrap ? 3 * n : n;
    for (let q = 0; q < len; q++) f[q] = get(q % n);
    edt1d(f, len, d, arg, v, z);
    const o = wrap ? n : 0;
    for (let q = 0; q < n; q++) put(q, d[q + o], arg[q + o] < 0 ? -1 : arg[q + o] % n);
  };
  for (let j = 0; j < h; j++) {
    const row = j * w;
    pass(w, (q) => (sites[row + q] ? 0 : Infinity), (q, dist, a) => { d1[row + q] = dist; col[row + q] = a; });
  }
  const d2 = new Float64Array(w * h), nearest = new Int32Array(w * h);
  for (let i = 0; i < w; i++)
    pass(h, (q) => d1[q * w + i], (q, dist, a) => { d2[q * w + i] = dist; nearest[q * w + i] = a < 0 ? -1 : a * w + col[a * w + i]; });
  return { d2, nearest };
}

/**
 * Signed distance in pixels (negative inside, where value ≥ threshold) to the iso-line value = threshold of a grey
 * layer. The line crosses each pair of 4-neighbours on opposite sides at the linearly interpolated point (exact for
 * the one-pixel ramps of antialiased edges and for wider soft ramps); every pixel takes the distance to the nearest
 * crossing, found around the nearest crossing pixel of an exact distance transform. Sub-pixel accurate, so a field
 * measured in metres is the same at any resolution. Without any crossing every pixel is ±(width + height).
 */
export function signedDistance(a: Float32Array, w: number, h: number, threshold: number, wrap: boolean): Float32Array {
  const n = w * h, inside = new Uint8Array(n);
  for (let k = 0; k < n; k++) inside[k] = a[k] >= threshold ? 1 : 0;
  // crossings: up to four per pixel, as offsets from its centre
  const ox = new Float32Array(n * 4), oy = new Float32Array(n * 4), cnt = new Uint8Array(n);
  const DX = [1, -1, 0, 0], DY = [0, 0, 1, -1];
  let any = false;
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      let c = 0;
      for (let e = 0; e < 4; e++) {
        let ni = i + DX[e], nj = j + DY[e];
        if (ni < 0 || nj < 0 || ni >= w || nj >= h) {
          if (!wrap) continue;
          ni = wrapI(ni, w); nj = wrapI(nj, h);
        }
        const m = nj * w + ni;
        if (inside[m] === inside[k]) continue;
        const t = clamp01((threshold - a[k]) / (a[m] - a[k]));
        ox[k * 4 + c] = DX[e] * t; oy[k * 4 + c] = DY[e] * t; c++;
      }
      cnt[k] = c;
      if (c) any = true;
    }
  const out = new Float32Array(n);
  if (!any) {
    const far = w + h;
    for (let k = 0; k < n; k++) out[k] = inside[k] ? -far : far;
    return out;
  }
  // first guess: the nearest crossing around the nearest crossing pixel; vx, vy = the vector to it
  const { nearest } = edt(cnt, w, h, wrap);
  const vx = new Float32Array(n), vy = new Float32Array(n), vd = new Float64Array(n);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const k = j * w + i, s = nearest[k], si = s % w, sj = (s - si) / w;
      let best = Infinity, bx = 0, by = 0;
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          const qi = si + di, qj = sj + dj;
          if (!wrap && (qi < 0 || qj < 0 || qi >= w || qj >= h)) continue;
          const q = wrapI(qj, h) * w + wrapI(qi, w);
          for (let c = 0; c < cnt[q]; c++) {
            let ex = qi + ox[q * 4 + c] - i, ey = qj + oy[q * 4 + c] - j;
            if (wrap) { ex = wrapD(ex, w); ey = wrapD(ey, h); }
            const dd = ex * ex + ey * ey;
            if (dd < best) { best = dd; bx = ex; by = ey; }
          }
        }
      vx[k] = bx; vy[k] = by; vd[k] = best;
    }
  // pixels on a curved outline have many crossing pixels at nearly the same distance, and the transform's pick may
  // not hold the nearest crossing: a forward and a backward sweep let every pixel take a neighbour's crossing when
  // it is nearer (vector propagation), which brings the error to the crossings' own (about a tenth of a pixel)
  const relax = (i: number, j: number, k: number) => {
    for (let dj = -1; dj <= 1; dj++)
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const qi = i + di, qj = j + dj;
        if (!wrap && (qi < 0 || qj < 0 || qi >= w || qj >= h)) continue;
        const q = wrapI(qj, h) * w + wrapI(qi, w);
        const ex = vx[q] + di, ey = vy[q] + dj, dd = ex * ex + ey * ey;
        if (dd < vd[k] - 1e-9) { vd[k] = dd; vx[k] = ex; vy[k] = ey; }
      }
  };
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) relax(i, j, j * w + i);
  for (let j = h - 1; j >= 0; j--) for (let i = w - 1; i >= 0; i--) relax(i, j, j * w + i);
  for (let k = 0; k < n; k++) out[k] = inside[k] ? -Math.sqrt(vd[k]) : Math.sqrt(vd[k]);
  return out;
}

/** An SDF (metres) as a one-texel antialiased coverage, so signedDistance() can measure it again. */
function coverageOf(d: Float32Array, texel: number): Float32Array {
  const a = new Float32Array(d.length);
  for (let k = 0; k < d.length; k++) a[k] = clamp01(0.5 - d[k] / texel);
  return a;
}

/** Re-measure an SDF in metres (after booleans or offsets that leave it inexact): the distance to its zero line again. */
export function redistance(d: Float32Array, w: number, h: number, texel: number, wrap: boolean): Float32Array {
  const s = signedDistance(coverageOf(d, texel), w, h, 0.5, wrap);
  for (let k = 0; k < s.length; k++) s[k] *= texel;
  return s;
}

// ---------------------------------------------------------------- shapes

export const SDF_SHAPES = ['disc', 'box', 'polygon', 'star', 'capsule', 'cross'];

/** Signed distance from (x, y) to a closed polygon (flat [x0, y0, x1, y1, …]): negative inside. */
function polygonSD(poly: number[], x: number, y: number): number {
  let d = Infinity, inside = false;
  const n = poly.length / 2;
  for (let a = 0, b = n - 1; a < n; b = a++) {
    const ax = poly[a * 2], ay = poly[a * 2 + 1], bx = poly[b * 2], by = poly[b * 2 + 1];
    const ex = bx - ax, ey = by - ay, wx = x - ax, wy = y - ay;
    const t = clamp01((wx * ex + wy * ey) / (ex * ex + ey * ey || 1));
    const qx = wx - ex * t, qy = wy - ey * t;
    d = Math.min(d, qx * qx + qy * qy);
    if ((ay > y) !== (by > y) && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
  }
  return inside ? -Math.sqrt(d) : Math.sqrt(d);
}

/** Signed distance to an axis-aligned box of half extents (hx, hy) with corners rounded by c (metres). */
function boxSD(x: number, y: number, hx: number, hy: number, c: number): number {
  const r = Math.max(0, Math.min(c, hx, hy));
  const qx = Math.abs(x) - (hx - r), qy = Math.abs(y) - (hy - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

export interface SdfShapeOptions {
  shape: string;
  /** disc, polygon and star: (outer) radius in metres */
  radius: number;
  /** box: full width and height; capsule: length and thickness; cross: arm length and thickness (metres) */
  extent: [number, number];
  sides: number;
  /** star: inner radius / outer radius */
  inner: number;
  /** box, polygon and cross: corner rounding radius (metres) */
  corner: number;
  /** degrees, counter-clockwise */
  rotation: number;
  /** centre of the shape in each tile's uv (0.5, 0.5 = the middle) */
  center: [number, number];
  /** repeats along u and v */
  tile: [number, number];
  /** metres the image width covers */
  size: number;
  /** the grid of shapes repeats past the borders (distances measured across them) */
  wrap: boolean;
}

/** The shape's distance function in its own frame (metres, centred, unrotated) and the radius that bounds it. */
function shapeFn(o: SdfShapeOptions): { f: (x: number, y: number) => number; bound: number } {
  const r = Math.max(1e-9, o.radius), c = Math.max(0, o.corner);
  const ex = Math.max(1e-9, o.extent[0]), ey = Math.max(1e-9, o.extent[1]);
  const n = Math.max(3, Math.round(o.sides));
  switch (o.shape) {
    case 'box': return { f: (x, y) => boxSD(x, y, ex / 2, ey / 2, c), bound: Math.hypot(ex, ey) / 2 };
    case 'capsule': {
      const rad = ey / 2, a = Math.max(0, ex / 2 - rad);
      return { f: (x, y) => Math.hypot(Math.max(Math.abs(x) - a, 0), y) - rad, bound: Math.max(ex / 2, rad) };
    }
    case 'cross': return { f: (x, y) => Math.min(boxSD(x, y, ex / 2, ey / 2, c), boxSD(x, y, ey / 2, ex / 2, c)), bound: Math.hypot(ex, ey) / 2 };
    case 'polygon': case 'star': {
      const star = o.shape === 'star';
      const k = star ? 2 * n : n;
      // rounding a polygon: shrink it by the corner radius (along its inradius), then grow its distance back
      const cr = star ? 0 : Math.min(c, r * Math.cos(Math.PI / n));
      const rr = star ? r : r - cr / Math.cos(Math.PI / n);
      const poly: number[] = [];
      for (let i = 0; i < k; i++) {
        const ang = Math.PI / 2 + (i * 2 * Math.PI) / k;
        const ri = star && i & 1 ? rr * Math.max(0.01, Math.min(1, o.inner)) : rr;
        poly.push(ri * Math.cos(ang), ri * Math.sin(ang));
      }
      if (rr <= 1e-9) return { f: (x, y) => Math.hypot(x, y) - cr, bound: r };
      return { f: (x, y) => polygonSD(poly, x, y) - cr, bound: r };
    }
    default: return { f: (x, y) => Math.hypot(x, y) - r, bound: r };
  }
}

/**
 * The cells around a pixel that its shape can reach, along x and y (the shape's bound over a cell, and one more):
 * every pixel measures (2kx + 1) × (2ky + 1) instances.
 */
export function shapeReach(o: SdfShapeOptions, w: number, h: number): { kx: number; ky: number } {
  const nx = Math.max(1, Math.round(o.tile[0])), ny = Math.max(1, Math.round(o.tile[1]));
  const W = Math.max(1e-9, o.size), H = (W * h) / w, { bound } = shapeFn(o);
  return { kx: Math.ceil(bound / (W / nx)) + 1, ky: Math.ceil(bound / (H / ny)) + 1 };
}

/**
 * Signed distance in metres to a shape, or a tile[0] × tile[1] grid of them, on a w × h image whose width covers
 * `size` metres (y up, the image height covers size · h / w). Each pixel takes the nearest instance among the cells
 * around it (as many as the shape's size reaches), so repeats that overlap their cells union correctly; with wrap
 * the grid continues past the borders and the field tiles.
 */
export function sdfShape(o: SdfShapeOptions, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  const nx = Math.max(1, Math.round(o.tile[0])), ny = Math.max(1, Math.round(o.tile[1]));
  const W = Math.max(1e-9, o.size), H = (W * h) / w;
  const cw = W / nx, chh = H / ny;
  const { f, bound } = shapeFn(o);
  const rot = (o.rotation * Math.PI) / 180, cr = Math.cos(-rot), sr = Math.sin(-rot);
  const { kx, ky } = shapeReach(o, w, h);
  for (let j = 0; j < h; j++) {
    const y = (1 - (j + 0.5) / h) * H;
    const cj0 = Math.round(y / chh - o.center[1]);
    for (let i = 0; i < w; i++) {
      const x = ((i + 0.5) / w) * W;
      const ci0 = Math.round(x / cw - o.center[0]);
      let best = Infinity;
      for (let cj = cj0 - ky; cj <= cj0 + ky; cj++) {
        if (!o.wrap && (cj < 0 || cj >= ny)) continue;
        for (let ci = ci0 - kx; ci <= ci0 + kx; ci++) {
          if (!o.wrap && (ci < 0 || ci >= nx)) continue;
          const lx = x - (ci + o.center[0]) * cw, ly = y - (cj + o.center[1]) * chh;
          const d = f(lx * cr - ly * sr, lx * sr + ly * cr);
          if (d < best) best = d;
        }
      }
      out[j * w + i] = best;
    }
  }
  return out;
}

// ---------------------------------------------------------------- operations on fields

export const SDF_OPS = ['offset', 'round', 'fillet', 'stroke', 'invert', 'redistance'];

/**
 * An operation on an SDF in metres:
 *   offset      grow by amount (negative shrinks): d - amount
 *   round       round the convex corners by amount: shrink, re-measure, grow back
 *   fillet      round the concave corners by amount: grow, re-measure, shrink back
 *   stroke      a band amount wide centred on the outline: |d| - amount / 2
 *   invert      inside out: -d
 *   redistance  the distance to the zero line measured again (after smooth booleans or a morph)
 */
export function sdfOp(d: Float32Array, w: number, h: number, mode: string, amount: number, texel: number, wrap: boolean): Float32Array {
  const n = d.length;
  const map = (fn: (x: number) => number) => { const o = new Float32Array(n); for (let k = 0; k < n; k++) o[k] = fn(d[k]); return o; };
  switch (mode) {
    case 'round': case 'fillet': {
      const r = Math.max(0, amount), sgn = mode === 'round' ? 1 : -1;
      if (!r) return d.slice();
      const re = redistance(map((x) => x + sgn * r), w, h, texel, wrap);
      for (let k = 0; k < n; k++) re[k] -= sgn * r;
      return re;
    }
    case 'stroke': { const hw = Math.max(0, amount) / 2; return map((x) => Math.abs(x) - hw); }
    case 'invert': return map((x) => -x);
    case 'redistance': return redistance(d, w, h, texel, wrap);
    default: return map((x) => x - amount);
  }
}

export const SDF_BOOLEANS = ['union', 'subtract', 'intersect', 'xor', 'morph'];

/** Polynomial smooth minimum with a blend width of k (0 = min). */
const smin = (a: number, b: number, k: number) => {
  if (!(k > 0)) return a < b ? a : b;
  const hh = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - (hh * hh * k) / 4;
};

/** Combine two SDFs (same size, metres): union, subtract (a minus b), intersect, xor, or morph (a → b by t); k = blend width. */
export function sdfBoolean(a: Float32Array, b: Float32Array, mode: string, k: number, t: number): Float32Array {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    let v: number;
    switch (mode) {
      case 'subtract': v = -smin(-x, y, k); break;
      case 'intersect': v = -smin(-x, -y, k); break;
      case 'xor': v = Math.max(smin(x, y, k), smin(-x, -y, k)); break; // outside the union or inside the intersection
      case 'morph': v = x + (y - x) * t; break;
      default: v = smin(x, y, k);
    }
    out[i] = v;
  }
  return out;
}

export const BEVEL_PROFILES = ['linear', 'smooth', 'round', 'ramp'];

/** A bevel profile: t = 0 at the outline … 1 at the full bevel width → height 0 … 1. */
export function profileFn(name: string, ramp?: (t: number) => number): (t: number) => number {
  switch (name) {
    case 'smooth': return (t) => t * t * (3 - 2 * t);
    case 'round': return (t) => Math.sqrt(Math.max(0, 1 - (1 - t) * (1 - t)));
    case 'ramp': return ramp ?? ((t) => t);
    default: return (t) => t;
  }
}

export const SDF_RENDER = ['fill', 'outline', 'bevel', 'distance'];

/**
 * A grey image from an SDF in metres:
 *   fill      1 inside, 0 outside; the edge is antialiased over a texel, or a smooth ramp `softness` metres wide
 *   outline   a line `width` metres wide centred on the outline (softness as for fill)
 *   bevel     0 at the outline rising through the profile to 1 at `width` metres inside
 *   distance  the field encoded for export: 0.5 on the outline, 1 at `width` metres inside, 0 at `width` outside
 */
export function sdfToMask(d: Float32Array, mode: string, width: number, softness: number, texel: number, profile: (t: number) => number): Float32Array {
  const out = new Float32Array(d.length);
  const s = Math.max(0, softness);
  const edge = s > texel ? (e: number) => smooth(-s / 2, s / 2, e) : (e: number) => clamp01(0.5 + e / texel);
  const wd = Math.max(1e-12, width);
  for (let k = 0; k < d.length; k++) {
    const x = d[k];
    switch (mode) {
      case 'outline': out[k] = edge(width / 2 - Math.abs(x)); break;
      case 'bevel': out[k] = x < 0 ? clamp01(profile(clamp01(-x / wd))) : 0; break;
      case 'distance': out[k] = clamp01(0.5 - x / (2 * wd)); break;
      default: out[k] = edge(-x);
    }
  }
  return out;
}

export const EDGE_MODES = ['sobel', 'outline', 'inner', 'outer'];

/**
 * A line along an outline from its SDF in metres, `width` metres wide: outline = centred on it, inner = just inside,
 * outer = just outside. roundness 0 = a flat band antialiased over a texel, 1 = a rounded ridge (a quarter circle up
 * from each side of the band, a height for tex_normal_from_height).
 */
export function edgeBand(d: Float32Array, mode: string, width: number, roundness: number, texel: number): Float32Array {
  const out = new Float32Array(d.length);
  const hw = Math.max(0, width) / 2, c = mode === 'inner' ? -hw : mode === 'outer' ? hw : 0, rd = clamp01(roundness);
  for (let k = 0; k < d.length; k++) {
    const e = hw - Math.abs(d[k] - c); // inside the band: distance to its nearer side
    const flat = clamp01(0.5 + e / texel);
    const t = hw > 0 ? clamp01(e / hw) : 0, ridge = Math.sqrt(Math.max(0, 1 - (1 - t) * (1 - t)));
    out[k] = flat + (Math.min(flat, ridge) - flat) * rd;
  }
  return out;
}

/**
 * A bevel height from an SDF in metres: distance > 0 bevels inward (0 on the outline, 1 at `distance` inside),
 * distance < 0 outward (1 inside, falling to 0 at |distance| outside).
 */
export function bevelHeight(d: Float32Array, distance: number, profile: (t: number) => number, texel: number): Float32Array {
  const out = new Float32Array(d.length);
  if (Math.abs(distance) < 1e-12) return sdfToMask(d, 'fill', 0, 0, texel, profile);
  const D = Math.abs(distance);
  for (let k = 0; k < d.length; k++) {
    const x = d[k];
    out[k] = distance > 0 ? (x < 0 ? clamp01(profile(clamp01(-x / D))) : 0) : (x <= 0 ? 1 : clamp01(profile(1 - clamp01(x / D))));
  }
  return out;
}

/**
 * Values of src (ch 1 or 4) carried out from the inside pixels to every pixel within maxPx pixels (each takes the
 * value of its nearest inside pixel; inside pixels keep their own); farther pixels are 0.
 */
export function propagate(src: Float32Array, ch: number, inside: Uint8Array, w: number, h: number, maxPx: number, wrap: boolean): Float32Array {
  const out = new Float32Array(src.length);
  const { d2, nearest } = edt(inside, w, h, wrap);
  const lim = maxPx * maxPx;
  for (let k = 0; k < w * h; k++) {
    const s = nearest[k];
    if (s < 0 || d2[k] > lim) continue;
    for (let c = 0; c < ch; c++) out[k * ch + c] = src[s * ch + c];
  }
  return out;
}

// ---------------------------------------------------------------- flood fill

export const FLOOD_OUTPUTS = ['random', 'color', 'gradient', 'bbox_size', 'position'];

export interface FloodOptions {
  threshold: number;
  /** 4 or 8 */
  connectivity: number;
  output: string;
  /** gradient: direction in degrees (0 = along +u) and random spread ± degrees per tile */
  angle: number;
  angleRandom: number;
  seed: number;
  wrap: boolean;
  /** metres per pixel (bbox_size) */
  texel: number;
}

/**
 * Flood fill: the tiles of a mask (connected pixels with value ≥ threshold; with wrap a tile crossing a border is one
 * tile) and a value per tile in C:
 *   random     a random grey 0..1          color     a random RGB colour (alpha 1 on the tiles, 0 in the gaps)
 *   gradient   0 → 1 across the tile along angle (± angleRandom per tile)
 *   bbox_size  the longer side of the tile's bounding box in metres
 *   position   the tile's centre as (u, v, 0, 1)
 * id = the random grey of each tile (0 in the gaps). Random values hash the tile's centre (area-weighted with the
 * antialiased edge pixels, snapped to a 1/128 grid of the image whose cells are centred where the centres of regular
 * patterns fall), so they do not depend on the resolution or on the order tiles are found in.
 */
export function floodFill(a: Float32Array, w: number, h: number, o: FloodOptions): { C: Float32Array; ch: 1 | 4; id: Float32Array; tiles: number } {
  const n = w * h, th = o.threshold, wrap = o.wrap;
  const label = new Int32Array(n).fill(-1);
  const ux = new Int32Array(n), uy = new Int32Array(n), queue = new Int32Array(n);
  const touched = new Int32Array(n).fill(-1);
  const nb = o.connectivity === 8 ? [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]] : [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const tiles: { x0: number; x1: number; y0: number; y1: number; sw: number; sx: number; sy: number; start: number; count: number }[] = [];
  const order = new Int32Array(n); // tile pixels, tile after tile
  let filled = 0;
  for (let s = 0; s < n; s++) {
    if (label[s] >= 0 || !(a[s] >= th)) continue;
    const t = tiles.length;
    const T = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, sw: 0, sx: 0, sy: 0, start: filled, count: 0 };
    tiles.push(T);
    let head = 0, tail = 0;
    queue[tail++] = s; label[s] = t; ux[s] = s % w; uy[s] = (s - ux[s]) / w;
    while (head < tail) {
      const p = queue[head++], px = ux[p], py = uy[p];
      order[filled++] = p; T.count++;
      if (px < T.x0) T.x0 = px; if (px > T.x1) T.x1 = px; if (py < T.y0) T.y0 = py; if (py > T.y1) T.y1 = py;
      const wp = clamp01(a[p]);
      T.sw += wp; T.sx += wp * (px + 0.5); T.sy += wp * (py + 0.5);
      for (const [dx, dy] of nb) {
        const qx = px + dx, qy = py + dy;
        if (!wrap && (qx < 0 || qy < 0 || qx >= w || qy >= h)) continue;
        const q = wrapI(qy, h) * w + wrapI(qx, w);
        if (a[q] >= th) {
          if (label[q] < 0) { label[q] = t; ux[q] = qx; uy[q] = qy; queue[tail++] = q; }
        } else if (a[q] > 0 && touched[q] !== t && (dx === 0 || dy === 0)) {
          // an antialiased edge pixel outside the tile: its coverage belongs to the tile's area
          touched[q] = t;
          const wq = clamp01(a[q]);
          T.sw += wq; T.sx += wq * (qx + 0.5); T.sy += wq * (qy + 0.5);
        }
      }
    }
  }
  const nt = tiles.length;
  const key = new Uint32Array(nt), cu = new Float64Array(nt), cv = new Float64Array(nt);
  const seedH = hash32(Math.floor(o.seed * 7919) + 0x2545f491);
  for (let t = 0; t < nt; t++) {
    const T = tiles[t];
    let x = T.sx / (T.sw || 1), y = T.sy / (T.sw || 1);
    // a tile that wraps all the way around has no centre along that axis
    if (wrap && T.x1 - T.x0 + 1 >= w) x = 0;
    if (wrap && T.y1 - T.y0 + 1 >= h) y = 0;
    let u = x / w, v = y / h;
    if (wrap) { u -= Math.floor(u); v -= Math.floor(v); }
    cu[t] = u; cv[t] = 1 - v;
    // grid cells centred on multiples of 1/128 (where the centres of regular patterns fall), the index wrapped (a
    // centre on the border reads u 0 or 1)
    const qx = wrapI(Math.floor(u * 128 + 0.5), 128), qy = wrapI(Math.floor(v * 128 + 0.5), 128);
    key[t] = hash32(Math.imul(qx, 0x27d4eb2d) ^ Math.imul(qy, 0x165667b1) ^ seedH);
  }
  // tiles whose centres fall in one cell of the grid (tiles closer than 1/128 of the image, a ring around a disc) are
  // told apart by their order in it: by centre (rounded, so the order holds at any resolution), then by area
  const cells = new Map<number, number[]>();
  for (let t = 0; t < nt; t++) { const l = cells.get(key[t]); if (l) l.push(t); else cells.set(key[t], [t]); }
  const fine = (x: number) => Math.round(x * 2048);
  for (const l of cells.values()) {
    if (l.length < 2) continue;
    l.sort((a, b) => fine(cv[a]) - fine(cv[b]) || fine(cu[a]) - fine(cu[b]) || tiles[a].sw - tiles[b].sw);
    l.forEach((t, k) => { key[t] = hash32(key[t] ^ Math.imul(k + 1, 0x85ebca6b)); });
  }
  const R = (t: number, k: number) => hash32(key[t] ^ Math.imul(k + 1, 0x9e3779b9)) / 4294967296;
  const id = new Float32Array(n);
  const ch: 1 | 4 = o.output === 'color' || o.output === 'position' ? 4 : 1;
  const C = new Float32Array(n * ch);
  for (let t = 0; t < nt; t++) {
    const T = tiles[t], r = R(t, 0);
    let dx = 0, dy = 0, pmin = Infinity, pmax = -Infinity;
    // a tile that wraps all the way round an axis is read at its pixels' own positions along it: its gradient jumps at
    // the border (a full-width band cannot ramp and tile), not in the middle where the fill met itself
    const fx = wrap && T.x1 - T.x0 + 1 >= w, fy = wrap && T.y1 - T.y0 + 1 >= h;
    const X = (p: number) => (fx ? p % w : ux[p]), Y = (p: number) => (fy ? Math.floor(p / w) : uy[p]);
    if (o.output === 'gradient') {
      const ang = ((o.angle + (R(t, 4) * 2 - 1) * o.angleRandom) * Math.PI) / 180;
      dx = Math.cos(ang); dy = -Math.sin(ang); // v up = rows down
      for (let q = T.start; q < T.start + T.count; q++) {
        const p = order[q], pr = (X(p) + 0.5) * dx + (Y(p) + 0.5) * dy;
        if (pr < pmin) pmin = pr; if (pr > pmax) pmax = pr;
      }
      const pad = 0.5 * (Math.abs(dx) + Math.abs(dy)); // pixel centres to pixel edges
      pmin -= pad; pmax += pad;
    }
    const bbox = Math.max(T.x1 - T.x0 + 1, T.y1 - T.y0 + 1) * o.texel;
    const c1 = R(t, 1), c2 = R(t, 2), c3 = R(t, 3);
    for (let q = T.start; q < T.start + T.count; q++) {
      const p = order[q];
      id[p] = r;
      switch (o.output) {
        case 'color': C[p * 4] = c1; C[p * 4 + 1] = c2; C[p * 4 + 2] = c3; C[p * 4 + 3] = 1; break;
        case 'position': C[p * 4] = cu[t]; C[p * 4 + 1] = cv[t]; C[p * 4 + 2] = 0; C[p * 4 + 3] = 1; break;
        case 'gradient': C[p] = clamp01(((X(p) + 0.5) * dx + (Y(p) + 0.5) * dy - pmin) / (pmax - pmin || 1)); break;
        case 'bbox_size': C[p] = bbox; break;
        default: C[p] = r;
      }
    }
  }
  return { C, ch, id, tiles: nt };
}
