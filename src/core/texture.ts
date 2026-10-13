// Texture kernels: the generators and filters behind the texture nodes (src/nodes/texture.ts), as pure functions
// over Float32Array layers (core/image.ts conventions: row-major, row 0 at the top, 1 or 4 interleaved channels,
// linear values). Pixel (i, j) is sampled at its centre: u = (i + 0.5) / W, v = 1 - (j + 0.5) / H.
// "wrap" means the image tiles: filters read across the opposite border, so a tileable input stays tileable.
// Generators that cost per pixel (noise, cells) also run in chunks on the worker pool (kernels "tex_noise" and
// "tex_cells" in core/kernels.ts); they compute every pixel independently, so chunked and serial runs are identical.
import { cellular2, texNoise } from './texnoise.ts';
import type { CellHit, TexNoiseOptions } from './texnoise.ts';
import { hash32 } from './random.ts';
import { toGrey } from './image.ts';

const clamp01 = (x: number) => (x > 0 ? (x < 1 ? x : 1) : 0);
const smooth = (e0: number, e1: number, x: number) => {
  if (e1 <= e0) return x < e0 ? 0 : 1;
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const wrapI = (i: number, n: number) => ((i % n) + n) % n;
const clampI = (i: number, n: number) => (i < 0 ? 0 : i >= n ? n - 1 : i);
/** random 0..1 of an integer cell and a seed */
const cellRand = (a: number, b: number, seed: number) => hash32(Math.imul(a, 0x27d4eb2d) ^ Math.imul(b, 0x165667b1) ^ hash32(Math.floor(seed * 7919) + 0x3c6ef372)) / 4294967296;

// ---------------------------------------------------------------- noise and cells (pool kernels)

export interface NoiseJob extends TexNoiseOptions { width: number; height: number }

/** Fractal noise for pixels [start, end) into out (1 channel). */
export function noiseRange(o: NoiseJob, out: Float32Array, start: number, end: number): void {
  const f = texNoise(o);
  const w = o.width, h = o.height;
  for (let k = start; k < end; k++) {
    const i = k % w, j = (k - i) / w;
    out[k] = f((i + 0.5) / w, 1 - (j + 0.5) / h);
  }
}

export interface CellsJob {
  width: number; height: number;
  /** cells across the width */
  scale: number;
  jitter: number;
  seed: number;
  tileable: boolean;
  /** distance, edges, id, crackle */
  output: string;
  /** edges: border width as a fraction of a cell */
  edgeWidth: number;
  metric: number;
}

/**
 * Voronoi cells for pixels [start, end): C (the chosen output) and id (a random 0..1 per cell).
 *  distance: distance to the cell's site (0 at the site, about 1 at a far corner)
 *  edges:    0 on the cell borders rising to 1 at edgeWidth inside (cells as plates)
 *  id:       a random value per cell (flat, for per-cell variation)
 *  crackle:  F2 - F1 (bright ridges between cells), normalised to about 0..1
 */
export function cellsRange(o: CellsJob, C: Float32Array, id: Float32Array, start: number, end: number): void {
  const w = o.width, h = o.height, aspect = h / w;
  let fx = o.scale, fy = o.scale * aspect;
  if (o.tileable) { fx = Math.max(1, Math.round(fx)); fy = Math.max(1, Math.round(fy)); }
  const c = cellular2(o.seed * 131 + 7, o.tileable ? fx : 0, o.tileable ? fy : 0, o.jitter, o.metric);
  const hit: CellHit = { f1: 0, f2: 0, id: 0, cx: 0, cy: 0 };
  const ew = Math.max(1e-6, o.edgeWidth);
  for (let k = start; k < end; k++) {
    const i = k % w, j = (k - i) / w;
    c(((i + 0.5) / w) * fx, (1 - (j + 0.5) / h) * fy, hit);
    const r = hash32(hit.id ^ 0x5bd1e995) / 4294967296;
    id[k] = r;
    let v: number;
    switch (o.output) {
      case 'edges': v = smooth(0, ew, (hit.f2 - hit.f1) * 0.5); break;
      case 'id': v = r; break;
      case 'crackle': v = clamp01((hit.f2 - hit.f1) / 0.7); break;
      default: v = clamp01(hit.f1 / 0.85);
    }
    C[k] = v;
  }
}

// ---------------------------------------------------------------- patterns

export const PATTERNS = ['bricks', 'tiles', 'checker', 'stripes', 'hex', 'dots', 'grid'];

export interface PatternOptions {
  pattern: string;
  /** cells along u (columns) and v (rows) */
  count: [number, number];
  /** bricks / dots / hex: shift of every other row as a fraction of a cell */
  offset: number;
  /** mortar / gap width as a fraction of the smaller cell side */
  gap: number;
  /** bevel width as a fraction of the smaller cell side (0 = hard edge) */
  bevel: number;
  /** random darkening per cell 0..1 */
  variation: number;
  seed: number;
}

/**
 * A tiling pattern: C = height-like profile (1 on the cells, 0 in the gaps, a smooth bevel between) and id = a random
 * 0..1 per cell. Tiles seamlessly when the counts are whole numbers (and the row count is even for bricks / hex with
 * an offset). Distances are measured in image-width units, so gaps stay even on non-square cells.
 */
export function genPattern(o: PatternOptions, w: number, h: number): { C: Float32Array; id: Float32Array } {
  const C = new Float32Array(w * h), id = new Float32Array(w * h);
  const nx = Math.max(1, Math.round(o.count[0])), ny = Math.max(1, Math.round(o.count[1]));
  const aspect = h / w;
  const cw = 1 / nx, chh = aspect / ny, s = Math.min(cw, chh);
  const m = (Math.max(0, Math.min(1, o.gap)) * s) / 2, b = Math.max(0, o.bevel) * s;
  const prof = (d: number) => (d <= m ? 0 : b > 0 ? smooth(m, m + b, d) : 1);
  const pix = 1 / w; // one pixel in width units: antialiasing of hard edges
  const aa = (d: number) => (b > 0 ? prof(d) : clamp01((d - m) / pix + 0.5));
  const vary = (cx: number, cy: number) => 1 - Math.max(0, Math.min(1, o.variation)) * cellRand(cx, cy, o.seed + 17);
  const staggered = o.pattern === 'bricks' || o.pattern === 'dots';
  for (let j = 0; j < h; j++) {
    const y = (j + 0.5) / h; // 0 top .. 1 bottom
    for (let i = 0; i < w; i++) {
      const u = (i + 0.5) / w, k = j * w + i;
      const fyAll = y * ny, cy = Math.min(ny - 1, Math.floor(fyAll)), fy = fyAll - cy;
      const shift = staggered && cy & 1 ? o.offset : 0;
      const fxAll = u * nx + shift, cxu = Math.floor(fxAll), fx = fxAll - cxu, cx = wrapI(cxu, nx);
      const dx = Math.min(fx, 1 - fx) * cw, dy = Math.min(fy, 1 - fy) * chh;
      let v = 0, cid = cellRand(cx, cy, o.seed);
      switch (o.pattern) {
        case 'checker': v = (cx + cy) & 1 ? 1 : 0; break;
        case 'stripes': {
          const sx = u * nx, scx = Math.floor(sx), sf = sx - scx;
          cid = cellRand(wrapI(scx, nx), 0, o.seed);
          v = aa(Math.min(sf, 1 - sf) * cw) * vary(wrapI(scx, nx), 0);
          break;
        }
        case 'grid': v = 1 - aa(Math.min(dx, dy)); break;
        case 'dots': {
          const r = Math.max(0, (1 - Math.max(0, Math.min(1, o.gap))) * s) / 2;
          const d = r - Math.sqrt(((fx - 0.5) * cw) ** 2 + ((fy - 0.5) * chh) ** 2);
          v = (b > 0 ? smooth(0, b, d) : clamp01(d / pix + 0.5)) * vary(cx, cy);
          break;
        }
        case 'hex': {
          // nearest two hex centres (rows offset by `offset`): the bisector distance is the distance to the cell border
          let d1 = Infinity, d2 = Infinity, b1x = 0, b1y = 0, b2x = 0, b2y = 0, bcx = 0, bcy = 0;
          for (let ry = cy - 1; ry <= cy + 1; ry++) {
            const sh = wrapI(ry, ny) & 1 ? o.offset : 0;
            const base = Math.floor(u * nx - sh);
            for (let rx = base - 1; rx <= base + 1; rx++) {
              const px = (rx + 0.5 + sh) * cw, py = (ry + 0.5) * chh;
              const ex = px - u, ey = py - y * aspect, dd = ex * ex + ey * ey;
              if (dd < d1) { d2 = d1; b2x = b1x; b2y = b1y; d1 = dd; b1x = px; b1y = py; bcx = wrapI(rx, nx); bcy = wrapI(ry, ny); }
              else if (dd < d2) { d2 = dd; b2x = px; b2y = py; }
            }
          }
          const sep = Math.hypot(b2x - b1x, b2y - b1y) || 1;
          cid = cellRand(bcx, bcy, o.seed);
          v = aa((d2 - d1) / (2 * sep)) * vary(bcx, bcy);
          break;
        }
        default: // bricks (rows staggered by offset), tiles (a plain grid)
          v = aa(Math.min(dx, dy)) * vary(cx, cy);
      }
      C[k] = v;
      id[k] = cid;
    }
  }
  return { C, id };
}

// ---------------------------------------------------------------- gradient and shapes

export const GRADIENTS = ['linear', 'mirror', 'radial', 'angular', 'diamond'];

/** A grey gradient 0..1: linear / mirror along `angle` (0 = left → right, 90 = bottom → top), radial / diamond from `center` over `radius`, angular around `center`. */
export function genGradient(mode: string, angle: number, center: [number, number], radius: number, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  const a = (angle * Math.PI) / 180, dx = Math.cos(a), dy = Math.sin(a);
  const ext = 0.5 * (Math.abs(dx) + Math.abs(dy)) || 1;
  const r = radius > 0 ? radius : 0.5;
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const u = (i + 0.5) / w, v = 1 - (j + 0.5) / h;
      let t: number;
      switch (mode) {
        case 'radial': t = Math.sqrt((u - center[0]) ** 2 + (v - center[1]) ** 2) / r; break;
        case 'diamond': t = (Math.abs(u - center[0]) + Math.abs(v - center[1])) / r; break;
        case 'angular': t = (((Math.atan2(v - center[1], u - center[0]) - a) / (2 * Math.PI)) % 1 + 1) % 1; break;
        case 'mirror': { const l = ((u - 0.5) * dx + (v - 0.5) * dy) / ext * 0.5 + 0.5; t = 1 - Math.abs(2 * l - 1); break; }
        default: t = ((u - 0.5) * dx + (v - 0.5) * dy) / ext * 0.5 + 0.5;
      }
      out[j * w + i] = clamp01(t);
    }
  return out;
}

export const SHAPES = ['disc', 'square', 'polygon', 'star', 'ring'];

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

export interface ShapeOptions {
  shape: string;
  /** radius as a fraction of half a tile (1 touches the tile border) */
  size: number;
  sides: number;
  /** star: inner radius / outer radius; ring: inner radius / outer radius */
  inner: number;
  /** degrees, counter-clockwise */
  rotation: number;
  /** soft edge as a fraction of the radius (0 = antialiased hard edge, 1 = a cone) */
  falloff: number;
  /** repeats along u and v */
  tile: [number, number];
}

/** A shape (1 inside, 0 outside, falloff ramp inside the edge), repeated tile[0] × tile[1] times. */
export function genShape(o: ShapeOptions, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  const tx = Math.max(1, Math.round(o.tile[0])), ty = Math.max(1, Math.round(o.tile[1]));
  const r = Math.max(1e-6, o.size), rot = (o.rotation * Math.PI) / 180, cr = Math.cos(-rot), sr = Math.sin(-rot);
  const n = Math.max(3, Math.round(o.sides));
  let poly: number[] | null = null;
  if (o.shape === 'polygon' || o.shape === 'star') {
    poly = [];
    const k = o.shape === 'star' ? 2 * n : n;
    for (let i = 0; i < k; i++) {
      const a = Math.PI / 2 + (i * 2 * Math.PI) / k;
      const rr = o.shape === 'star' && i & 1 ? r * Math.max(0.01, Math.min(1, o.inner)) : r;
      poly.push(rr * Math.cos(a), rr * Math.sin(a));
    }
  }
  const px = (2 * tx) / w; // one pixel in tile-local units (a tile spans -1..1)
  const fall = Math.max(0, Math.min(1, o.falloff)) * r;
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const u = (i + 0.5) / w, v = 1 - (j + 0.5) / h;
      const lu = (u * tx) % 1, lv = (v * ty) % 1;
      const x0 = lu * 2 - 1, y0 = lv * 2 - 1;
      const x = x0 * cr - y0 * sr, y = x0 * sr + y0 * cr;
      let sd: number;
      switch (o.shape) {
        case 'square': sd = Math.max(Math.abs(x), Math.abs(y)) - r; break;
        case 'ring': { const ri = r * Math.max(0, Math.min(0.99, o.inner)), d = Math.sqrt(x * x + y * y); sd = Math.max(d - r, ri - d); break; }
        case 'polygon': case 'star': sd = polygonSD(poly!, x, y); break;
        default: sd = Math.sqrt(x * x + y * y) - r;
      }
      out[j * w + i] = fall > 0 ? smooth(0, fall, -sd) : clamp01(0.5 - sd / px);
    }
  return out;
}

// ---------------------------------------------------------------- scatter generators (scratches, splatter)

const prng = (seed: number) => {
  let a = hash32(Math.floor(seed * 7919) ^ 0x6d2b79f5);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Write v into out at unwrapped pixel (x, y): wrap tiles the image, otherwise pixels outside are dropped. */
function splat(out: Float32Array, w: number, h: number, x: number, y: number, v: number, wrap: boolean, add: boolean) {
  if (!wrap && (x < 0 || y < 0 || x >= w || y >= h)) return;
  const k = wrapI(y, h) * w + wrapI(x, w);
  out[k] = add ? out[k] + v : Math.max(out[k], v);
}

export interface ScratchOptions {
  count: number;
  /** stroke length range as fractions of the image width */
  length: [number, number];
  /** stroke width as a fraction of the image width */
  width: number;
  /** mean direction in degrees (0 = along u) and random spread around it */
  angle: number;
  spread: number;
  /** sideways bend as a fraction of the length */
  curvature: number;
  intensity: [number, number];
  seed: number;
  wrap: boolean;
}

/** Thin strokes (scratches, cracks, streaks): tapered, slightly bent segments combined with max. */
export function genScratches(o: ScratchOptions, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  const r = prng(o.seed + 3);
  const halfW = Math.max(0.35, (o.width * w) / 2);
  for (let s = 0; s < o.count; s++) {
    const cx = r() * w, cy = r() * h;
    const ang = ((o.angle + (r() * 2 - 1) * o.spread) * Math.PI) / 180;
    const len = lerp(o.length[0], o.length[1], r()) * w;
    const inten = lerp(o.intensity[0], o.intensity[1], r());
    const bend = (r() * 2 - 1) * o.curvature * len;
    const dx = Math.cos(ang), dy = -Math.sin(ang); // v up = pixel y down
    const ax = cx - (dx * len) / 2, ay = cy - (dy * len) / 2;
    // quadratic bend as a polyline of 6 segments
    const N = 6, pts: number[] = [];
    for (let k = 0; k <= N; k++) {
      const t = k / N, off = bend * 4 * t * (1 - t);
      pts.push(ax + dx * len * t - dy * off, ay + dy * len * t + dx * off);
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k <= N; k++) { x0 = Math.min(x0, pts[k * 2]); x1 = Math.max(x1, pts[k * 2]); y0 = Math.min(y0, pts[k * 2 + 1]); y1 = Math.max(y1, pts[k * 2 + 1]); }
    const pad = halfW + 1;
    for (let y = Math.floor(y0 - pad); y <= Math.ceil(y1 + pad); y++)
      for (let x = Math.floor(x0 - pad); x <= Math.ceil(x1 + pad); x++) {
        const px = x + 0.5, py = y + 0.5;
        let best = Infinity, bt = 0;
        for (let k = 0; k < N; k++) {
          const sx = pts[k * 2], sy = pts[k * 2 + 1], ex = pts[k * 2 + 2] - sx, ey = pts[k * 2 + 3] - sy;
          const t = clamp01(((px - sx) * ex + (py - sy) * ey) / (ex * ex + ey * ey || 1));
          const qx = px - sx - ex * t, qy = py - sy - ey * t, d = qx * qx + qy * qy;
          if (d < best) { best = d; bt = (k + t) / N; }
        }
        const d = Math.sqrt(best);
        const taper = Math.sin(Math.PI * bt); // thin at both ends
        const wloc = halfW * (0.35 + 0.65 * taper);
        const v = clamp01(wloc + 0.5 - d) * inten * (0.4 + 0.6 * taper);
        if (v > 0) splat(out, w, h, x, y, v, o.wrap, false);
      }
  }
  return out;
}

export interface SplatterOptions {
  count: number;
  /** blob radius range as fractions of the image width */
  size: [number, number];
  /** 0 = discs, 1 = very ragged outlines */
  irregularity: number;
  /** soft edge as a fraction of the radius */
  softness: number;
  intensity: [number, number];
  seed: number;
  wrap: boolean;
  /** combine overlapping blobs with max (default) or add (then clamped to 1) */
  add: boolean;
}

/** Blobs (stains, dirt, paint splatter): ragged discs with soft edges. */
export function genSplatter(o: SplatterOptions, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  const r = prng(o.seed + 5);
  for (let s = 0; s < o.count; s++) {
    const cx = r() * w, cy = r() * h;
    const rad = Math.max(0.5, lerp(o.size[0], o.size[1], r()) * w);
    const inten = lerp(o.intensity[0], o.intensity[1], r());
    const ph = [r() * 6.283, r() * 6.283, r() * 6.283, r() * 6.283];
    const irr = Math.max(0, Math.min(1, o.irregularity));
    const rmax = rad * (1 + irr * 0.75);
    const soft = Math.max(0.5, Math.max(0, o.softness) * rad);
    for (let y = Math.floor(cy - rmax - 1); y <= Math.ceil(cy + rmax + 1); y++)
      for (let x = Math.floor(cx - rmax - 1); x <= Math.ceil(cx + rmax + 1); x++) {
        const ex = x + 0.5 - cx, ey = y + 0.5 - cy, d = Math.sqrt(ex * ex + ey * ey), th = Math.atan2(ey, ex);
        const wob = 0.4 * Math.sin(3 * th + ph[0]) + 0.3 * Math.sin(5 * th + ph[1]) + 0.2 * Math.sin(8 * th + ph[2]) + 0.1 * Math.sin(13 * th + ph[3]);
        const rr = rad * (1 + irr * 0.6 * wob);
        const v = smooth(0, soft, rr - d) * inten;
        if (v > 0) splat(out, w, h, x, y, v, o.wrap, o.add);
      }
  }
  if (o.add) for (let k = 0; k < out.length; k++) if (out[k] > 1) out[k] = 1;
  return out;
}

// ---------------------------------------------------------------- per-pixel filters

export const BLEND_MODES = ['normal', 'add', 'subtract', 'multiply', 'screen', 'overlay', 'min', 'max', 'difference', 'divide'];

function blendOp(mode: string, a: number, b: number): number {
  switch (mode) {
    case 'add': return a + b;
    case 'subtract': return a - b;
    case 'multiply': return a * b;
    case 'screen': return 1 - (1 - a) * (1 - b);
    case 'overlay': return a < 0.5 ? 2 * a * b : 1 - 2 * (1 - a) * (1 - b);
    case 'min': return a < b ? a : b;
    case 'max': return a > b ? a : b;
    case 'difference': return Math.abs(a - b);
    case 'divide': return b > 1e-6 ? a / b : a > 0 ? 1 : 0;
    default: return b;
  }
}

/**
 * Blend foreground B over background A (both already the same size; ch 1 or 4 each): result = mix(A, op(A, B), t) with
 * t = opacity × mask × (B's alpha for 4-channel B). The result has max(chA, chB) channels; alpha is A's (1 for grey A).
 */
export function blendLayers(A: Float32Array, chA: number, B: Float32Array, chB: number, M: Float32Array | null, mode: string, opacity: number, clamp: boolean): { data: Float32Array; ch: number } {
  const ch = Math.max(chA, chB), n = A.length / chA;
  const out = new Float32Array(n * ch);
  for (let i = 0; i < n; i++) {
    let t = opacity * (M ? M[i] : 1);
    if (chB === 4) t *= B[i * 4 + 3];
    for (let c = 0; c < (ch === 4 ? 3 : 1); c++) {
      const a = chA === 4 ? A[i * 4 + c] : A[i], b = chB === 4 ? B[i * 4 + c] : B[i];
      let v = a + (blendOp(mode, a, b) - a) * t;
      if (clamp) v = clamp01(v);
      out[i * ch + c] = v;
    }
    if (ch === 4) out[i * 4 + 3] = chA === 4 ? A[i * 4 + 3] : 1;
  }
  return { data: out, ch };
}

/** Apply f to every colour value (RGB of 4-channel layers, alpha untouched). */
export function mapValues(a: Float32Array, ch: number, f: (x: number) => number): Float32Array {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = ch === 4 && (i & 3) === 3 ? a[i] : f(a[i]);
  return out;
}

/** Substance Levels: in range → gamma → out range. */
export function levelsFn(inLo: number, inHi: number, gamma: number, outLo: number, outHi: number, clamp: boolean): (x: number) => number {
  const span = inHi - inLo || 1e-6, g = 1 / Math.max(1e-3, gamma);
  return (x) => {
    let t = (x - inLo) / span;
    if (clamp) t = clamp01(t);
    t = t > 0 ? Math.pow(t, g) : t;
    const v = outLo + (outHi - outLo) * t;
    return clamp ? clamp01(v) : v;
  };
}

/** Substance Histogram Scan: position 0 = black, 1 = white, contrast 1 = a hard threshold at 1 - position. */
export function histogramScanFn(position: number, contrast: number): (x: number) => number {
  const width = Math.max(1e-4, 1 - clamp01(contrast));
  return (x) => clamp01((x - (1 - position)) / width + 0.5);
}

// ---------------------------------------------------------------- neighbourhood filters

/**
 * One box pass of half-width r along rows (horizontal) or columns, every channel, wrapping or clamping at borders:
 * running sums in float64. The vertical pass keeps one running sum per column and walks the rows in memory order.
 */
function boxPass(src: Float32Array, w: number, h: number, ch: number, r: number, horizontal: boolean, wrap: boolean): Float32Array {
  const out = new Float32Array(src.length);
  const fix = wrap ? wrapI : clampI;
  const inv = 1 / (2 * r + 1);
  if (horizontal) {
    const rw = w * ch;
    // source column of window position k (only the first r + 1 and last r + 1 positions need fixing)
    const col = new Int32Array(w + 2 * r + 1);
    for (let k = -r; k <= w + r; k++) col[k + r] = fix(k, w) * ch;
    const sum = new Float64Array(ch);
    for (let y = 0; y < h; y++) {
      const row = y * rw;
      sum.fill(0);
      for (let k = -r; k <= r; k++) { const p = row + col[k + r]; for (let c = 0; c < ch; c++) sum[c] += src[p + c]; }
      for (let x = 0; x < w; x++) {
        const o = row + x * ch, a = row + col[x + 2 * r + 1], s = row + col[x];
        for (let c = 0; c < ch; c++) { out[o + c] = sum[c] * inv; sum[c] += src[a + c] - src[s + c]; }
      }
    }
    return out;
  }
  const rw = w * ch, sums = new Float64Array(rw);
  for (let k = -r; k <= r; k++) { const p = fix(k, h) * rw; for (let q = 0; q < rw; q++) sums[q] += src[p + q]; }
  for (let y = 0; y < h; y++) {
    const o = y * rw, a = fix(y + r + 1, h) * rw, s = fix(y - r, h) * rw;
    for (let q = 0; q < rw; q++) { out[o + q] = sums[q] * inv; sums[q] += src[a + q] - src[s + q]; }
  }
  return out;
}

/** Half-widths of three box passes approximating a gaussian with standard deviation sigma (pixels). */
function gaussBoxes(sigma: number): number[] {
  const n = 3;
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  return Array.from({ length: n }, (_, i) => Math.max(0, ((i < m ? wl : wu) - 1) / 2));
}

/**
 * Blur every channel: 'gaussian' (radius = 2 sigma, three box passes) or 'box' (half-width = radius), separable
 * running sums. With wrap the image is treated as periodic, so the mean of every channel is preserved exactly.
 */
export function blurLayer(a: Float32Array, ch: number, w: number, h: number, radius: number, mode: string, wrap: boolean): Float32Array {
  if (!(radius > 0)) return a.slice();
  const rs = mode === 'box' ? [Math.max(1, Math.round(radius))] : gaussBoxes(radius / 2).map(Math.round);
  let x = a;
  for (const r of rs) {
    if (r < 1) continue;
    x = boxPass(x, w, h, ch, r, true, wrap);
    x = boxPass(x, w, h, ch, r, false, wrap);
  }
  return x === a ? a.slice() : x;
}

/** Sobel scratch: sobel() writes gx, gy here (no allocation per pixel). */
const SB = new Float64Array(2);
/** Height difference across a pixel (Sobel, per pixel) into SB: gx along +i (u), gy along +j (down). */
function sobel(g: Float32Array, w: number, h: number, i: number, j: number, wrap: boolean): void {
  const fix = wrap ? wrapI : clampI;
  const il = fix(i - 1, w), ir = fix(i + 1, w), ju = fix(j - 1, h), jd = fix(j + 1, h);
  const a = g[ju * w + il], b = g[ju * w + i], c = g[ju * w + ir];
  const d = g[j * w + il], f = g[j * w + ir];
  const p = g[jd * w + il], q = g[jd * w + i], s = g[jd * w + ir];
  SB[0] = (c + 2 * f + s - a - 2 * d - p) / 8; SB[1] = (p + 2 * q + s - a - 2 * b - c) / 8;
}

/**
 * Tangent-space normal map (RGBA, 0.5 + 0.5 n) from a grey height: Sobel slopes scaled by strength (1 = a height
 * rise of 1 over 1/64 of the image width tilts the normal 45°, at any resolution). OpenGL convention (+Y up = +v)
 * unless directx.
 */
export function normalFromHeight(g: Float32Array, w: number, h: number, strength: number, directx: boolean, wrap: boolean): Float32Array {
  const out = new Float32Array(w * h * 4);
  const k = (strength * w) / 64; // Sobel / 8 is dh per pixel; a rise of 1 over w/64 pixels then gives slope 1 (45°)
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      sobel(g, w, h, i, j, wrap); const gx = SB[0], gy = SB[1];
      // dh/du = gx per pixel; dh/dv = -gy (rows go down)
      let nx = -gx * k, ny = gy * k;
      if (directx) ny = -ny;
      const l = Math.sqrt(nx * nx + ny * ny + 1);
      const o = (j * w + i) * 4;
      out[o] = 0.5 + (0.5 * nx) / l; out[o + 1] = 0.5 + (0.5 * ny) / l; out[o + 2] = 0.5 + 0.5 / l; out[o + 3] = 1;
    }
  return out;
}

/** Edge detection: Sobel gradient magnitude of a grey layer × strength, clamped, grown by `width` pixels (max filter). */
export function edgeDetect(g: Float32Array, w: number, h: number, strength: number, width: number, wrap: boolean): Float32Array {
  let out: Float32Array = new Float32Array(w * h);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      sobel(g, w, h, i, j, wrap); const gx = SB[0], gy = SB[1];
      out[j * w + i] = clamp01(Math.sqrt(gx * gx + gy * gy) * 2 * strength);
    }
  const r = Math.round(width);
  if (r >= 1) out = maxFilter(out, w, h, r, wrap);
  return out;
}

/** Separable max filter of half-width r (dilation of bright areas). */
export function maxFilter(a: Float32Array, w: number, h: number, r: number, wrap: boolean): Float32Array {
  const fix = wrap ? wrapI : clampI;
  const t = new Float32Array(a.length), out = new Float32Array(a.length);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) { let m = -Infinity; for (let k = -r; k <= r; k++) m = Math.max(m, a[j * w + fix(i + k, w)]); t[j * w + i] = m; }
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) { let m = -Infinity; for (let k = -r; k <= r; k++) m = Math.max(m, t[fix(j + k, h) * w + i]); out[j * w + i] = m; }
  return out;
}

/**
 * Ambient occlusion of a heightmap (horizon based): for `dirs` directions, march `steps` samples out to `radius`
 * (fraction of the image width) and take the highest elevation angle above the pixel; height is scaled by `depth`
 * (height 1 = depth image widths). Returns 1 = open, darker in pits and crevices.
 */
export function heightToAO(g: Float32Array, w: number, h: number, radius: number, depth: number, dirs: number, steps: number, wrap: boolean): Float32Array {
  const out = new Float32Array(w * h);
  const D = Math.max(1, Math.round(dirs)), S = Math.max(1, Math.round(steps));
  const rpx = Math.max(1, radius * w), zs = depth * w; // heights in pixel units
  const fix = wrap ? wrapI : clampI;
  const cs = Array.from({ length: D }, (_, d) => [Math.cos((d * 2 * Math.PI) / D + 0.37), Math.sin((d * 2 * Math.PI) / D + 0.37)]);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const h0 = g[j * w + i] * zs;
      let occ = 0;
      for (const [dx, dy] of cs) {
        let best = 0;
        for (let s = 1; s <= S; s++) {
          const dist = (rpx * s) / S;
          const x = fix(Math.round(i + dx * dist), w), y = fix(Math.round(j + dy * dist), h);
          const e = (g[y * w + x] * zs - h0) / dist;
          if (e > best) best = e;
        }
        occ += best / Math.sqrt(1 + best * best); // sin of the horizon angle
      }
      out[j * w + i] = clamp01(1 - occ / D);
    }
  return out;
}

export const WARP_MODES = ['directional', 'slope', 'vector'];

/**
 * Warp a layer by a second image W (already the same size): each pixel samples the source at an offset (fractions of
 * the image width): directional = intensity × W along `angle`; slope = along the gradient of W, the steepest slope
 * moving intensity; vector = intensity × (R, G) × 2 − 1 of an RGBA W.
 */
export function warpLayer(a: Float32Array, ch: number, w: number, h: number, W: Float32Array, chW: number, mode: string, intensity: number, angle: number, wrap: boolean): Float32Array {
  const out = new Float32Array(a.length);
  const n = w * h, gW = toGrey(W, chW);
  const ox = new Float32Array(n), oy = new Float32Array(n);
  if (mode === 'slope') {
    let mx = 0;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { sobel(gW, w, h, i, j, wrap); const gx = SB[0], gy = SB[1]; ox[j * w + i] = gx; oy[j * w + i] = gy; mx = Math.max(mx, Math.hypot(gx, gy)); }
    const k = mx > 0 ? (intensity * w) / mx : 0;
    for (let i = 0; i < n; i++) { ox[i] *= k; oy[i] *= k; }
  } else if (mode === 'vector') {
    for (let i = 0; i < n; i++) {
      const r = chW === 4 ? W[i * 4] : gW[i], g = chW === 4 ? W[i * 4 + 1] : gW[i];
      ox[i] = (r * 2 - 1) * intensity * w; oy[i] = -(g * 2 - 1) * intensity * w;
    }
  } else {
    const a2 = (angle * Math.PI) / 180, dx = Math.cos(a2), dy = -Math.sin(a2);
    for (let i = 0; i < n; i++) { ox[i] = gW[i] * intensity * w * dx; oy[i] = gW[i] * intensity * w * dy; }
  }
  const tmp = new Float32Array(ch);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      sampleBilinear(a, ch, w, h, i + 0.5 - ox[k], j + 0.5 - oy[k], tmp, wrap);
      out.set(tmp, k * ch);
    }
  return out;
}

/** Bilinear sample at pixel coordinates (centres at +0.5); clamp or wrap at borders. */
export function sampleBilinear(a: Float32Array, ch: number, w: number, h: number, fx: number, fy: number, out: Float32Array, wrap: boolean) {
  const x = fx - 0.5, y = fy - 0.5, x0 = Math.floor(x), y0 = Math.floor(y), tx = x - x0, ty = y - y0;
  const fix = wrap ? wrapI : clampI;
  const i0 = fix(x0, w), i1 = fix(x0 + 1, w), j0 = fix(y0, h), j1 = fix(y0 + 1, h);
  const k00 = (j0 * w + i0) * ch, k10 = (j0 * w + i1) * ch, k01 = (j1 * w + i0) * ch, k11 = (j1 * w + i1) * ch;
  for (let c = 0; c < ch; c++) {
    const t = a[k00 + c] + (a[k10 + c] - a[k00 + c]) * tx, b = a[k01 + c] + (a[k11 + c] - a[k01 + c]) * tx;
    out[c] = t + (b - t) * ty;
  }
}

/**
 * Transform a layer: the result at (u, v) samples the source at the inverse of (repeat `tile` times, scale, rotate
 * by `rotate` degrees about the centre, offset). wrap = repeat the source; otherwise outside the source is 0.
 */
export function transformLayer(a: Float32Array, ch: number, w: number, h: number, offset: [number, number], rotate: number, scale: [number, number], tile: [number, number], wrap: boolean): Float32Array {
  const out = new Float32Array(a.length);
  const th = (-rotate * Math.PI) / 180, c = Math.cos(th), s = Math.sin(th);
  const sx = (scale[0] || 1e-6) / Math.max(1e-6, tile[0] || 1), sy = (scale[1] || 1e-6) / Math.max(1e-6, tile[1] || 1);
  const tmp = new Float32Array(ch);
  const aspect = h / w;
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const u = (i + 0.5) / w, v = 1 - (j + 0.5) / h;
      let x = u - 0.5 - offset[0], y = (v - 0.5 - offset[1]) * aspect;
      const rx = x * c - y * s, ry = x * s + y * c;
      x = rx / sx + 0.5; y = (ry / aspect) / sy + 0.5;
      if (!wrap && (x < 0 || x > 1 || y < 0 || y > 1)) continue;
      sampleBilinear(a, ch, w, h, x * w, (1 - y) * h, tmp, wrap);
      out.set(tmp, (j * w + i) * ch);
    }
  return out;
}

/** Ramp lookup table: n entries over 0..1 of a ramp evaluator (numbers or [r, g, b]). */
export function rampLUT(evalRamp: (t: number) => number | number[], n = 1024): { lut: Float32Array; ch: number } {
  const probe = evalRamp(0);
  const ch = Array.isArray(probe) ? 3 : 1;
  const lut = new Float32Array(n * ch);
  for (let k = 0; k < n; k++) {
    const v = evalRamp(k / (n - 1));
    if (ch === 3) { const c = v as number[]; lut[k * 3] = c[0]; lut[k * 3 + 1] = c[1]; lut[k * 3 + 2] = c[2]; }
    else lut[k] = v as number;
  }
  return { lut, ch };
}

/** Grey → RGBA through a colour ramp LUT (rampLUT with colours; grey ramps give grey RGB). */
export function colorize(g: Float32Array, lut: Float32Array, lch: number): Float32Array {
  const n = g.length, out = new Float32Array(n * 4), m = lut.length / lch - 1;
  for (let i = 0; i < n; i++) {
    const k = Math.round(clamp01(g[i]) * m);
    if (lch === 3) { out[i * 4] = lut[k * 3]; out[i * 4 + 1] = lut[k * 3 + 1]; out[i * 4 + 2] = lut[k * 3 + 2]; }
    else { out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = lut[k]; }
    out[i * 4 + 3] = 1;
  }
  return out;
}

/** Map every colour value through a scalar ramp LUT (tex_curves); alpha untouched. */
export function curvesLayer(a: Float32Array, ch: number, lut: Float32Array): Float32Array {
  const m = lut.length - 1;
  return mapValues(a, ch, (x) => {
    const t = clamp01(x) * m, k = Math.floor(t), f = t - k;
    return k >= m ? lut[m] : lut[k] + (lut[k + 1] - lut[k]) * f;
  });
}

export interface TileSamplerOptions {
  count: [number, number];
  /** instance size range relative to a cell */
  scale: [number, number];
  /** random rotation range in degrees (± around 0) */
  rotation: number;
  /** random position offset as a fraction of a cell */
  jitter: number;
  /** shift of every other row as a fraction of a cell */
  offset: number;
  intensity: [number, number];
  seed: number;
  /** combine overlapping instances with max (default) or add */
  add: boolean;
}

/**
 * Scatter a grey source image (sw × sh) over a w × h grid of count cells: one instance per cell with random offset,
 * rotation, scale and intensity, kept with probability mask(cell centre) when a mask is given. Tiles seamlessly.
 */
export function tileSampler(src: Float32Array, sw: number, sh: number, w: number, h: number, o: TileSamplerOptions, mask: Float32Array | null): Float32Array {
  const out = new Float32Array(w * h);
  const nx = Math.max(1, Math.round(o.count[0])), ny = Math.max(1, Math.round(o.count[1]));
  const cw = w / nx, chh = h / ny;
  const tmp = new Float32Array(1);
  for (let cy = 0; cy < ny; cy++)
    for (let cx = 0; cx < nx; cx++) {
      const R = (k: number) => cellRand(cx * 7 + k, cy * 13 + k * 31, o.seed);
      let px = (cx + 0.5 + (cy & 1 ? o.offset : 0)) * cw + (R(1) - 0.5) * o.jitter * cw;
      let py = (cy + 0.5) * chh + (R(2) - 0.5) * o.jitter * chh;
      px = ((px % w) + w) % w; py = ((py % h) + h) % h;
      if (mask && R(3) >= mask[Math.min(h - 1, Math.floor(py)) * w + Math.min(w - 1, Math.floor(px))]) continue;
      const sc = lerp(o.scale[0], o.scale[1], R(4));
      const rot = ((R(5) * 2 - 1) * o.rotation * Math.PI) / 180;
      const inten = lerp(o.intensity[0], o.intensity[1], R(6));
      const iw = Math.max(1, sc * cw), ih = Math.max(1, sc * chh); // instance footprint in pixels
      const c = Math.cos(rot), s = Math.sin(rot);
      const ext = Math.hypot(iw, ih) / 2 + 1;
      for (let y = Math.floor(py - ext); y <= Math.ceil(py + ext); y++)
        for (let x = Math.floor(px - ext); x <= Math.ceil(px + ext); x++) {
          const dx = x + 0.5 - px, dy = y + 0.5 - py;
          const lx = (dx * c + dy * s) / iw + 0.5, ly = (-dx * s + dy * c) / ih + 0.5;
          if (lx < 0 || lx > 1 || ly < 0 || ly > 1) continue;
          sampleBilinear(src, 1, sw, sh, lx * sw, ly * sh, tmp, false);
          const v = tmp[0] * inten;
          if (v > 0) splat(out, w, h, x, y, v, true, o.add);
        }
    }
  if (o.add) for (let k = 0; k < out.length; k++) if (out[k] > 1) out[k] = 1;
  return out;
}

