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
 *  crystal:  a flat facet per cell: a random tilt (a planar gradient through the site) on a random level
 */
export function cellsRange(o: CellsJob, C: Float32Array, id: Float32Array, start: number, end: number): void {
  const w = o.width, h = o.height, aspect = h / w;
  let fx = o.scale, fy = o.scale * aspect;
  if (o.tileable) { fx = Math.max(1, Math.round(fx)); fy = Math.max(1, Math.round(fy)); }
  const c = cellular2(o.seed * 131 + 7, o.tileable ? fx : 0, o.tileable ? fy : 0, o.jitter, o.metric);
  const hit: CellHit = { f1: 0, f2: 0, id: 0, cx: 0, cy: 0, ex: 0, ey: 0 };
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
      case 'crystal': {
        const a = (hash32(hit.id ^ 0x2f6b9a17) / 4294967296) * 2 * Math.PI;
        // ex, ey run from the pixel to the site: the facet rises along (cos a, sin a) through the site
        v = clamp01(0.5 + (r - 0.5) * 0.5 - 0.8 * (hit.ex * Math.cos(a) + hit.ey * Math.sin(a)));
        break;
      }
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

/**
 * The value cut that leaves `coverage` (0..1) of the samples above it: the (1 - coverage) quantile, midway between the
 * two sorted samples it separates. Coverage 0 and 1 put it a transition width (from contrast) beyond the range, so
 * nothing or everything turns white. Equal samples straddling the cut read 0.5 (not white).
 */
export function coverageCut(a: Float32Array, coverage: number, contrast: number): number {
  const n = a.length;
  if (!n) return 0.5;
  const s = Float32Array.from(a).sort();
  const width = Math.max(1e-4, 1 - clamp01(contrast));
  const black = n - Math.round(clamp01(coverage) * n);
  if (black >= n) return s[n - 1] + width;
  if (black <= 0) return s[0] - width;
  return (s[black - 1] + s[black]) / 2;
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
 * Tangent-space normal map (RGBA, 0.5 + 0.5 n) from a grey height in physical units: a value of 1 stands `depth`
 * metres high and the image width spans `size` metres, so the slope is the Sobel height step per texel × depth /
 * (size / w), the same at any resolution for the same relief. OpenGL convention (+Y up = +v) unless directx.
 */
export function normalFromHeight(g: Float32Array, w: number, h: number, depth: number, size: number, directx: boolean, wrap: boolean): Float32Array {
  const out = new Float32Array(w * h * 4);
  const k = (depth * w) / Math.max(1e-12, size); // Sobel / 8 is the value step per texel; × depth / texel size = metres per metre
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

export const NORMAL_BLEND_MODES = ['rnm', 'udn', 'linear'];

/**
 * A detail normal map over a base one (tangent space, RGBA holding 0.5 + 0.5 n; the base's alpha is kept). The
 * detail's tilt is scaled by `strength` (its x and y; 0 = flat, 2 = twice as steep), then:
 *   rnm     reoriented normal mapping (Barré-Brisebois and Hill, 2012): the detail is rotated onto the base normal, so
 *           both reliefs keep their full depth (a flat detail returns the base exactly)
 *   udn     (base.xy + detail.xy, base.z) normalised: cheaper, flattens a strong detail on steep base slopes
 *   linear  (base + detail) normalised: softens both (a flat detail halves the base's tilt)
 * The mask (0..1 per pixel, or none = 1) mixes from the base to that result. Both maps must use the same green
 * convention (OpenGL or DirectX): every mode treats x and y alike, so the result keeps it.
 */
export function blendNormals(A: Float32Array, B: Float32Array, M: Float32Array | null, mode: string, strength: number): Float32Array {
  const n = A.length / 4, out = new Float32Array(A.length);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    let bx = A[o] * 2 - 1, by = A[o + 1] * 2 - 1, bz = A[o + 2] * 2 - 1;
    const bl = Math.hypot(bx, by, bz) || 1;
    bx /= bl; by /= bl; bz /= bl;
    let dx = (B[o] * 2 - 1) * strength, dy = (B[o + 1] * 2 - 1) * strength, dz = Math.max(1e-4, B[o + 2] * 2 - 1);
    const dl = Math.hypot(dx, dy, dz);
    dx /= dl; dy /= dl; dz /= dl;
    let rx: number, ry: number, rz: number;
    if (mode === 'udn') { rx = bx + dx; ry = by + dy; rz = bz; }
    else if (mode === 'linear') { rx = bx + dx; ry = by + dy; rz = bz + dz; }
    else {
      // t = base + (0, 0, 1), u = detail × (-1, -1, 1), r = t (t · u) / t.z - u
      const tx = bx, ty = by, tz = bz + 1, ux = -dx, uy = -dy, uz = dz;
      const k = (tx * ux + ty * uy + tz * uz) / Math.max(1e-6, tz);
      rx = tx * k - ux; ry = ty * k - uy; rz = tz * k - uz;
    }
    let rl = Math.hypot(rx, ry, rz) || 1;
    rx /= rl; ry /= rl; rz /= rl;
    const m = M ? Math.max(0, Math.min(1, M[i])) : 1;
    if (m < 1) {
      rx = bx + (rx - bx) * m; ry = by + (ry - by) * m; rz = bz + (rz - bz) * m;
      rl = Math.hypot(rx, ry, rz) || 1;
      rx /= rl; ry /= rl; rz /= rl;
    }
    out[o] = 0.5 + 0.5 * rx; out[o + 1] = 0.5 + 0.5 * ry; out[o + 2] = 0.5 + 0.5 * rz; out[o + 3] = A[o + 3];
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

export const WARP_MODES = ['directional', 'slope', 'vector', 'nonuniform', 'multi'];

/**
 * Warp a layer by a second image W (already the same size): each pixel samples the source at an offset (fractions of
 * the image width): directional = intensity × W along `angle`; slope = along the gradient of W, the steepest slope
 * moving intensity; vector = intensity × (R, G) × 2 − 1 of an RGBA W; nonuniform = intensity × W along angle plus
 * angleMap × 360° per pixel (a grey map the same size); multi = the mean of `directions` directional warps whose
 * angles split the circle evenly from `angle` (a smeared, direction-free warp).
 */
export function warpLayer(a: Float32Array, ch: number, w: number, h: number, W: Float32Array, chW: number, mode: string, intensity: number, angle: number, wrap: boolean, angleMap: Float32Array | null = null, directions = 4): Float32Array {
  const out = new Float32Array(a.length);
  const n = w * h, gW = toGrey(W, chW);
  const tmp = new Float32Array(ch);
  if (mode === 'multi') {
    const D = Math.max(1, Math.round(directions));
    const acc = new Float64Array(ch);
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        const k = j * w + i, len = gW[k] * intensity * w;
        acc.fill(0);
        for (let d = 0; d < D; d++) {
          const t = ((angle + (d * 360) / D) * Math.PI) / 180;
          sampleBilinear(a, ch, w, h, i + 0.5 - len * Math.cos(t), j + 0.5 + len * Math.sin(t), tmp, wrap);
          for (let c = 0; c < ch; c++) acc[c] += tmp[c];
        }
        for (let c = 0; c < ch; c++) out[k * ch + c] = acc[c] / D;
      }
    return out;
  }
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
  } else if (mode === 'nonuniform') {
    for (let i = 0; i < n; i++) {
      const t = ((angle + (angleMap ? angleMap[i] : 0) * 360) * Math.PI) / 180;
      ox[i] = gW[i] * intensity * w * Math.cos(t); oy[i] = -gW[i] * intensity * w * Math.sin(t);
    }
  } else {
    const a2 = (angle * Math.PI) / 180, dx = Math.cos(a2), dy = -Math.sin(a2);
    for (let i = 0; i < n; i++) { ox[i] = gW[i] * intensity * w * dx; oy[i] = gW[i] * intensity * w * dy; }
  }
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      sampleBilinear(a, ch, w, h, i + 0.5 - ox[k], j + 0.5 - oy[k], tmp, wrap);
      out.set(tmp, k * ch);
    }
  return out;
}

/** sampleBilinear of a grey layer, returning the value (the same arithmetic, without the output array). */
function bilinear1(a: Float32Array, w: number, h: number, fx: number, fy: number, wrap: boolean): number {
  const x = fx - 0.5, y = fy - 0.5, x0 = Math.floor(x), y0 = Math.floor(y), tx = x - x0, ty = y - y0;
  let i0: number, i1: number, j0: number, j1: number;
  if (wrap) {
    i0 = ((x0 % w) + w) % w; i1 = i0 + 1 === w ? 0 : i0 + 1;
    j0 = ((y0 % h) + h) % h; j1 = j0 + 1 === h ? 0 : j0 + 1;
  } else {
    i0 = clampI(x0, w); i1 = clampI(x0 + 1, w); j0 = clampI(y0, h); j1 = clampI(y0 + 1, h);
  }
  const r0 = j0 * w, r1 = j1 * w;
  const t = a[r0 + i0] + (a[r0 + i1] - a[r0 + i0]) * tx, b = a[r1 + i0] + (a[r1 + i1] - a[r1 + i0]) * tx;
  return t + (b - t) * ty;
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
  /** instances wrap at the borders (default true) */
  wrap?: boolean;
  /** what C holds: grey (default: the stamps' values), id (a random 0..1 per instance), color (a random RGB per instance) */
  output?: string;
  /** maps sampled at each instance's centre (w × h grey): scale × value, rotation + value × 360°, intensity × value */
  scaleMap?: Float32Array | null;
  rotationMap?: Float32Array | null;
  intensityMap?: Float32Array | null;
}

/** A grey stamp image for the tile sampler. */
export interface Stamp { data: Float32Array; w: number; h: number }

export const TILE_SAMPLER_OUTPUTS = ['grey', 'id', 'color'];

/**
 * Scatter grey stamps over a w × h grid of count cells: one instance per cell with random offset, rotation, scale and
 * intensity (times the scale, rotation and intensity maps at its centre when given), kept with probability
 * mask(cell centre) when a mask is given; with several stamps each instance picks one at random. Tiles seamlessly
 * when wrap (the default). C is the combined stamps (grey), or, for output id / color, the random value / colour of
 * the instance that is strongest at each pixel (colour with the combined stamps as alpha); mask = the combined stamps.
 */
export function tileSampler(stamps: Stamp[], w: number, h: number, o: TileSamplerOptions, mask: Float32Array | null): { C: Float32Array; ch: 1 | 4; mask: Float32Array } {
  const out = new Float32Array(w * h);
  const wrap = o.wrap ?? true, output = o.output ?? 'grey';
  const best = output === 'grey' ? null : new Float32Array(w * h);
  const ids = best ? new Float32Array(w * h) : null, cols = output === 'color' ? new Float32Array(w * h * 3) : null;
  const nx = Math.max(1, Math.round(o.count[0])), ny = Math.max(1, Math.round(o.count[1]));
  const cw = w / nx, chh = h / ny;
  const tmp = new Float32Array(1);
  for (let cy = 0; cy < ny; cy++)
    for (let cx = 0; cx < nx; cx++) {
      const R = (k: number) => cellRand(cx * 7 + k, cy * 13 + k * 31, o.seed);
      let px = (cx + 0.5 + (cy & 1 ? o.offset : 0)) * cw + (R(1) - 0.5) * o.jitter * cw;
      let py = (cy + 0.5) * chh + (R(2) - 0.5) * o.jitter * chh;
      px = ((px % w) + w) % w; py = ((py % h) + h) % h;
      const at = Math.min(h - 1, Math.floor(py)) * w + Math.min(w - 1, Math.floor(px));
      if (mask && R(3) >= mask[at]) continue;
      let sc = lerp(o.scale[0], o.scale[1], R(4));
      if (o.scaleMap) sc *= Math.max(0, o.scaleMap[at]);
      let rot = ((R(5) * 2 - 1) * o.rotation * Math.PI) / 180;
      if (o.rotationMap) rot += o.rotationMap[at] * 2 * Math.PI;
      let inten = lerp(o.intensity[0], o.intensity[1], R(6));
      if (o.intensityMap) inten *= o.intensityMap[at];
      const st = stamps.length > 1 ? stamps[Math.min(stamps.length - 1, Math.floor(R(7) * stamps.length))] : stamps[0];
      const iw = Math.max(1, sc * cw), ih = Math.max(1, sc * chh); // instance footprint in pixels
      const c = Math.cos(rot), s = Math.sin(rot);
      const ext = Math.hypot(iw, ih) / 2 + 1;
      const rid = best ? R(8) : 0, r1 = cols ? R(9) : 0, r2 = cols ? R(10) : 0, r3 = cols ? R(11) : 0;
      for (let y = Math.floor(py - ext); y <= Math.ceil(py + ext); y++)
        for (let x = Math.floor(px - ext); x <= Math.ceil(px + ext); x++) {
          const dx = x + 0.5 - px, dy = y + 0.5 - py;
          const lx = (dx * c + dy * s) / iw + 0.5, ly = (-dx * s + dy * c) / ih + 0.5;
          if (lx < 0 || lx > 1 || ly < 0 || ly > 1) continue;
          sampleBilinear(st.data, 1, st.w, st.h, lx * st.w, ly * st.h, tmp, false);
          const v = tmp[0] * inten;
          if (!(v > 0)) continue;
          splat(out, w, h, x, y, v, wrap, o.add);
          if (!best || (!wrap && (x < 0 || y < 0 || x >= w || y >= h))) continue;
          const k = wrapI(y, h) * w + wrapI(x, w);
          if (v > best[k]) {
            best[k] = v; ids![k] = rid;
            if (cols) { cols[k * 3] = r1; cols[k * 3 + 1] = r2; cols[k * 3 + 2] = r3; }
          }
        }
    }
  if (o.add) for (let k = 0; k < out.length; k++) if (out[k] > 1) out[k] = 1;
  if (output === 'id') return { C: ids!, ch: 1, mask: out };
  if (cols) {
    const C = new Float32Array(w * h * 4);
    for (let k = 0; k < w * h; k++) { C[k * 4] = cols[k * 3]; C[k * 4 + 1] = cols[k * 3 + 1]; C[k * 4 + 2] = cols[k * 3 + 2]; C[k * 4 + 3] = clamp01(out[k]); }
    return { C, ch: 4, mask: out };
  }
  return { C: out, ch: 1, mask: out };
}

// ---------------------------------------------------------------- histogram

/** Substance Histogram Range: the values squeezed around their middle by range and centred on position: position + (x - 0.5) × range. */
export function histogramRangeFn(range: number, position: number): (x: number) => number {
  return (x) => clamp01(position + (x - 0.5) * range);
}

/**
 * Substance Histogram Select: 1 for values within range / 2 of position, 0 beyond. contrast 1 is a hard band; lower
 * contrast softens both edges around the same half-way points (0 = a tent that peaks at position).
 */
export function histogramSelectFn(position: number, range: number, contrast: number): (x: number) => number {
  const half = Math.max(0, range) / 2, s = (1 - clamp01(contrast)) * half;
  return (x) => {
    const d = Math.abs(x - position);
    return s > 1e-9 ? 1 - smooth(half - s, half + s, d) : d <= half ? 1 : 0;
  };
}

/**
 * The range of a layer's colour values (grey, or the RGB values of an RGBA layer; alpha never) with `clip` (0..0.5)
 * of them cut off at each end (0 = min..max; a 65536-bin histogram finds the cuts). channel 0..2 reads one RGB
 * channel, -1 all three together.
 */
export function valueRange(a: Float32Array, ch: number, clip: number, channel = -1): [number, number] {
  const take = (i: number) => ch === 1 || (channel < 0 ? (i & 3) !== 3 : (i & 3) === channel);
  let lo = Infinity, hi = -Infinity, n = 0;
  for (let i = 0; i < a.length; i++) {
    if (!take(i)) continue;
    const x = a[i];
    if (!(x === x)) continue;
    if (x < lo) lo = x;
    if (x > hi) hi = x;
    n++;
  }
  if (!n) return [0, 1];
  if (!(clip > 0) || !(hi > lo)) return [lo, hi];
  const B = 65536, hist = new Uint32Array(B), k = (B - 1) / (hi - lo);
  for (let i = 0; i < a.length; i++) if (take(i) && a[i] === a[i]) hist[Math.floor((a[i] - lo) * k)]++;
  const cut = Math.min(0.5, clip) * n;
  let acc = 0, b0 = 0, b1 = B - 1;
  for (let b = 0; b < B; b++) { acc += hist[b]; if (acc > cut) { b0 = b; break; } }
  acc = 0;
  for (let b = B - 1; b >= 0; b--) { acc += hist[b]; if (acc > cut) { b1 = b; break; } }
  return b1 > b0 ? [lo + b0 / k, lo + (b1 + 1) / k] : [lo + b0 / k, lo + (b0 + 1) / k];
}

export const QUANTIZE_MODES = ['round', 'floor'];

/** Quantize to `levels` evenly spaced values 0, 1/(n-1) … 1: round = the nearest level, floor = equal-width bands (posterize). */
export function quantizeFn(levels: number, mode: string): (x: number) => number {
  const n = Math.max(2, Math.round(levels));
  return mode === 'floor' ? (x) => Math.min(n - 1, Math.max(0, Math.floor(x * n))) / (n - 1) : (x) => Math.round(clamp01(x) * (n - 1)) / (n - 1);
}

// ---------------------------------------------------------------- directional and slope blur

/**
 * Motion blur: every pixel averages samples along a line `lengthPx` pixels long at `angle` degrees (0 = +u, 90 = +v):
 * centred on the pixel when symmetric, else behind it (so a bright dot trails along the angle). One sample per pixel
 * of length (at most 1024), bilinear.
 */
export function directionalBlur(a: Float32Array, ch: number, w: number, h: number, lengthPx: number, angle: number, symmetric: boolean, wrap: boolean): Float32Array {
  if (!(lengthPx > 0)) return a.slice();
  const N = Math.min(1024, Math.max(2, Math.ceil(lengthPx) + 1));
  const t = (angle * Math.PI) / 180, dx = Math.cos(t), dy = -Math.sin(t);
  const offs = new Float64Array(N);
  for (let s = 0; s < N; s++) offs[s] = symmetric ? (s / (N - 1) - 0.5) * lengthPx : -(s / (N - 1)) * lengthPx;
  const out = new Float32Array(a.length), tmp = new Float32Array(ch), acc = new Float64Array(ch);
  const ox = offs.map((t) => dx * t), oy = offs.map((t) => dy * t);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      if (ch === 1) {
        let sum = 0;
        for (let s = 0; s < N; s++) sum += bilinear1(a, w, h, i + 0.5 + ox[s], j + 0.5 + oy[s], wrap);
        out[j * w + i] = sum / N;
        continue;
      }
      acc.fill(0);
      for (let s = 0; s < N; s++) {
        sampleBilinear(a, ch, w, h, i + 0.5 + ox[s], j + 0.5 + oy[s], tmp, wrap);
        for (let c = 0; c < ch; c++) acc[c] += tmp[c];
      }
      for (let c = 0; c < ch; c++) out[(j * w + i) * ch + c] = acc[c] / N;
    }
  return out;
}

export const SLOPE_BLUR_MODES = ['blur', 'min', 'max'];

/**
 * Slope blur: every pixel follows the slope of a grey map (downhill, or uphill) for `distancePx` pixels in `samples`
 * steps, re-reading the slope at each step, and combines the source values met on the way: blur (mean), min or max.
 * Where the map is flatter than half its average slope the steps shrink in proportion, so flat areas stay put. The
 * walk is in image space and the average slope is the map's own, so the result is the same in metres at any
 * resolution.
 */
export function slopeBlur(a: Float32Array, ch: number, w: number, h: number, slope: Float32Array, distancePx: number, samples: number, mode: string, uphill: boolean, wrap: boolean): Float32Array {
  const n = w * h, S = Math.max(1, Math.round(samples));
  const G = new Float32Array(n * 2);
  let sum = 0;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { sobel(slope, w, h, i, j, wrap); G[(j * w + i) * 2] = SB[0]; G[(j * w + i) * 2 + 1] = SB[1]; sum += Math.hypot(SB[0], SB[1]); }
  const out = new Float32Array(a.length), tmp = new Float32Array(ch), g = new Float32Array(2), acc = new Float64Array(ch);
  const sgn = uphill ? 1 : -1, stepMax = distancePx / S, full = (0.5 * sum) / n; // slopes from half the mean take full steps
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      for (let c = 0; c < ch; c++) acc[c] = a[k * ch + c];
      let x = i + 0.5, y = j + 0.5, m = 1;
      for (let s = 0; s < S && stepMax > 0; s++) {
        sampleBilinear(G, 2, w, h, x, y, g, wrap);
        const mag = Math.hypot(g[0], g[1]);
        if (mag < 1e-9 || !(full > 1e-12)) break;
        const step = stepMax * Math.min(1, mag / full);
        x += (sgn * g[0] / mag) * step; y += (sgn * g[1] / mag) * step;
        sampleBilinear(a, ch, w, h, x, y, tmp, wrap);
        for (let c = 0; c < ch; c++) acc[c] = mode === 'min' ? Math.min(acc[c], tmp[c]) : mode === 'max' ? Math.max(acc[c], tmp[c]) : acc[c] + tmp[c];
        m++;
      }
      for (let c = 0; c < ch; c++) out[k * ch + c] = mode === 'min' || mode === 'max' ? acc[c] : acc[c] / m;
      if (ch === 4) out[k * 4 + 3] = a[k * 4 + 3];
    }
  return out;
}

// ---------------------------------------------------------------- curvature and occlusion

/**
 * Curvature from a tangent-space normal map (RGBA 0.5 + 0.5 n): the mean curvature H = div(n.xy) / 2 in 1/metres
 * (texel = metres per pixel; 1/R on a sphere of radius R; positive on convex bumps). C = 0.5 + 0.5 · H · radius
 * clamped: bends of radius `radius` metres or tighter read full white (convex) or black (concave); convex and concave
 * hold the two sides 0..1 (as bake_curvature's layers).
 */
export function curvatureFromNormal(N: Float32Array, w: number, h: number, texel: number, radius: number, directx: boolean, wrap: boolean): { C: Float32Array; convex: Float32Array; concave: Float32Array } {
  const n = w * h, nx = new Float32Array(n), ny = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const x = N[k * 4] * 2 - 1, y = (N[k * 4 + 1] * 2 - 1) * (directx ? -1 : 1), z = N[k * 4 + 2] * 2 - 1;
    const l = Math.hypot(x, y, z) || 1;
    nx[k] = x / l; ny[k] = y / l;
  }
  const C = new Float32Array(n), convex = new Float32Array(n), concave = new Float32Array(n);
  const fix = wrap ? wrapI : clampI;
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const il = wrap ? i - 1 : Math.max(0, i - 1), ir = wrap ? i + 1 : Math.min(w - 1, i + 1);
      const ju = wrap ? j - 1 : Math.max(0, j - 1), jd = wrap ? j + 1 : Math.min(h - 1, j + 1);
      // x grows with i, y (up) grows against j
      const dnx = ir > il ? (nx[j * w + fix(ir, w)] - nx[j * w + fix(il, w)]) / ((ir - il) * texel) : 0;
      const dny = jd > ju ? (ny[fix(ju, h) * w + i] - ny[fix(jd, h) * w + i]) / ((jd - ju) * texel) : 0;
      const v = 0.5 * (dnx + dny) * radius, k = j * w + i;
      C[k] = clamp01(0.5 + 0.5 * v); convex[k] = clamp01(v); concave[k] = clamp01(-v);
    }
  return { C, convex, concave };
}

export interface AOOptions {
  /** metres per pixel */
  texel: number;
  /** metres a height of 1 stands */
  depth: number;
  /** search radius in metres */
  radius: number;
  /** slices through the pixel (each looks both ways) */
  directions: number;
  /** samples along each way */
  steps: number;
  /** 0 = no occlusion, 1 = as measured, 2 = twice as dark */
  strength: number;
  wrap: boolean;
}

/**
 * Ambient occlusion of a height in metres, ground-truth style (GTAO, Jimenez et al. 2016, seen from straight above):
 * for each slice through the pixel the highest horizon on both sides is found from bilinear samples out to `radius`
 * metres (spaced closer near the pixel, fading out over the last 40 % of the radius), and the slice's
 * cosine-weighted visibility between the two horizons and the surface's own tangent plane is integrated in closed
 * form. The result is that visibility over the open value of the same tilted surface: 1 on any plane, darker in pits,
 * gaps and at the foot of walls. Sample positions are in metres, so the result is the same at any resolution.
 */
export function heightAO(g: Float32Array, w: number, h: number, o: AOOptions): Float32Array {
  const out = new Float32Array(w * h);
  const D = Math.max(1, Math.round(o.directions)), S = Math.max(1, Math.round(o.steps));
  const rpx = Math.max(1e-6, o.radius / o.texel), z = o.depth; // heights in metres; distances in pixels × texel
  const dirs: [number, number][] = [];
  for (let d = 0; d < D; d++) { const a = ((d + 0.5) * Math.PI) / D + 0.37; dirs.push([Math.cos(a), Math.sin(a)]); }
  const rs = Array.from({ length: S }, (_, s) => rpx * ((s + 1) / S) ** 2);
  const fade = rs.map((r) => smooth(0.6, 1, r / rpx)); // samples count fully up to 60 % of the radius, then fade out
  const rms = rs.map((r) => r * o.texel);
  // samples that do not fade only need the steepest tangent; the angle is taken once (atan is monotonic)
  const offs = dirs.map(([dx, dy]) => rs.map((r) => [dx * r, -dy * r]));
  const slice = (h1: number, h2: number, gm: number) =>
    0.25 * (-Math.cos(2 * h1 - gm) + Math.cos(gm) + 2 * h1 * Math.sin(gm)) + 0.25 * (-Math.cos(2 * h2 - gm) + Math.cos(gm) + 2 * h2 * Math.sin(gm));
  const HALF = Math.PI / 2;
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const h0 = g[j * w + i] * z;
      sobel(g, w, h, i, j, o.wrap);
      const sx = (SB[0] * z) / o.texel, sy = (-SB[1] * z) / o.texel; // dh/dx, dh/dy (y up), metres per metre
      let vis = 0, open = 0;
      for (let d = 0; d < D; d++) {
        const [dx, dy] = dirs[d], off = offs[d];
        const sd = sx * dx + sy * dy; // slope along the slice
        const gm = -Math.atan(sd); // the normal's angle from straight up, toward +dir
        const len = Math.sqrt(1 + sd * sd) / Math.sqrt(1 + sx * sx + sy * sy);
        let e1 = -HALF, e2 = -HALF, t1 = -Infinity, t2 = -Infinity;
        const px = i + 0.5, py = j + 0.5;
        for (let s = 0; s < S; s++) {
          const f = fade[s];
          if (f >= 1) continue;
          const ox = off[s][0], oy = off[s][1], rm = rms[s];
          const v2 = (bilinear1(g, w, h, px + ox, py + oy, o.wrap) * z - h0) / rm;
          const v1 = (bilinear1(g, w, h, px - ox, py - oy, o.wrap) * z - h0) / rm;
          if (f <= 0) { if (v2 > t2) t2 = v2; if (v1 > t1) t1 = v1; continue; }
          const a2 = Math.atan(v2) * (1 - f) - HALF * f, a1 = Math.atan(v1) * (1 - f) - HALF * f;
          if (a2 > e2) e2 = a2;
          if (a1 > e1) e1 = a1;
        }
        if (t2 > -Infinity) e2 = Math.max(e2, Math.atan(t2));
        if (t1 > -Infinity) e1 = Math.max(e1, Math.atan(t1));
        // horizon angles from straight up (h2 toward +dir, h1 toward -dir), never below the tangent plane
        const h2 = Math.min(HALF - e2, gm + HALF), h1 = Math.max(-(HALF - e1), gm - HALF);
        vis += len * slice(h1, h2, gm);
        open += len * slice(gm - HALF, gm + HALF, gm);
      }
      const ao = open > 0 ? vis / open : 1;
      out[j * w + i] = clamp01(1 - o.strength * (1 - clamp01(ao)));
    }
  return out;
}

// ---------------------------------------------------------------- make it tile

/**
 * Make an image tile: first along u, then along v. Each pass blends the image with a copy shifted by half the image,
 * whose own border seam sits in the middle: the mask is 0 at the borders (the shifted copy, continuous across them)
 * and 1 from `blend` (a fraction of the image) inward (the original, covering the copy's seam). noiseAmount 0 is a
 * smooth cross-fade over the band; toward 1 the hand-over becomes a narrow edge that wanders with the noise (a patch
 * edge hides the blend better on photos). noiseU / noiseV: tileable 0..1 noise over (u, v), one per pass.
 */
export function makeTile(a: Float32Array, ch: number, w: number, h: number, blend: number, noiseU: ((u: number, v: number) => number) | null, noiseV: ((u: number, v: number) => number) | null, noiseAmount: number): Float32Array {
  const b = Math.max(1e-4, Math.min(0.5, blend)), na = clamp01(noiseAmount);
  const mask = (e: number, nz: number) => {
    let s = (b / 2) * (1 - 0.85 * na), c = b / 2 + (nz - 0.5) * b * na;
    s = Math.min(s, 0.25);
    c = Math.max(s, Math.min(0.5 - s, c));
    return smooth(c - s, c + s, e);
  };
  const pass = (src: Float32Array, alongU: boolean, noise: ((u: number, v: number) => number) | null) => {
    const out = new Float32Array(src.length), tmp = new Float32Array(ch);
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        const u = (i + 0.5) / w, v = 1 - (j + 0.5) / h, k = (j * w + i) * ch;
        const e = 0.5 - Math.abs((alongU ? u : v) - 0.5);
        const m = mask(e, noise ? noise(u, v) : 0.5);
        sampleBilinear(src, ch, w, h, i + 0.5 + (alongU ? w / 2 : 0), j + 0.5 + (alongU ? 0 : h / 2), tmp, true);
        for (let c = 0; c < ch; c++) out[k + c] = tmp[c] + (src[k + c] - tmp[c]) * m;
      }
    return out;
  };
  return pass(pass(a, true, noiseU), false, noiseV);
}

// ---------------------------------------------------------------- normal maps

/** Normal map vectors scaled back to unit length (after blurs, resizes, blends or painting); z below 0 is lifted to 0; alpha kept. */
export function normalizeNormals(N: Float32Array): Float32Array {
  const out = new Float32Array(N.length);
  for (let k = 0; k < N.length; k += 4) {
    const x = N[k] * 2 - 1, y = N[k + 1] * 2 - 1, z = Math.max(0, N[k + 2] * 2 - 1);
    const l = Math.hypot(x, y, z);
    if (l < 1e-9) { out[k] = 0.5; out[k + 1] = 0.5; out[k + 2] = 1; }
    else { out[k] = 0.5 + (0.5 * x) / l; out[k + 1] = 0.5 + (0.5 * y) / l; out[k + 2] = 0.5 + (0.5 * z) / l; }
    out[k + 3] = N[k + 3];
  }
  return out;
}

/** Flip the red (x) and / or green (y) channel of a normal map: green converts OpenGL ↔ DirectX; alpha kept. */
export function flipNormals(N: Float32Array, flipX: boolean, flipY: boolean): Float32Array {
  const out = N.slice();
  for (let k = 0; k < N.length; k += 4) {
    if (flipX) out[k] = 1 - N[k];
    if (flipY) out[k + 1] = 1 - N[k + 1];
  }
  return out;
}

/** In-place complex FFT of any length: iterative radix 2, or Bluestein's chirp z-transform for other lengths. */
class FFT {
  readonly n: number;
  private cos: Float64Array; private sin: Float64Array; private rev: Uint32Array | null = null;
  private blue: { sub: FFT; m: number; wr: Float64Array; wi: Float64Array; br: Float64Array; bi: Float64Array; ar: Float64Array; ai: Float64Array } | null = null;
  constructor(n: number) {
    this.n = n;
    const pow2 = (n & (n - 1)) === 0;
    const m = pow2 ? n : 1 << Math.ceil(Math.log2(2 * n - 1));
    if (pow2) {
      this.cos = new Float64Array(n / 2); this.sin = new Float64Array(n / 2);
      for (let k = 0; k < n / 2; k++) { this.cos[k] = Math.cos((2 * Math.PI * k) / n); this.sin[k] = Math.sin((2 * Math.PI * k) / n); }
      this.rev = new Uint32Array(n);
      const bits = Math.round(Math.log2(n));
      for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); this.rev[i] = r; }
      return;
    }
    this.cos = new Float64Array(0); this.sin = new Float64Array(0);
    const sub = new FFT(m);
    const wr = new Float64Array(n), wi = new Float64Array(n);
    for (let k = 0; k < n; k++) { const t = (Math.PI * ((k * k) % (2 * n))) / n; wr[k] = Math.cos(t); wi[k] = -Math.sin(t); }
    const br = new Float64Array(m), bi = new Float64Array(m);
    br[0] = wr[0]; bi[0] = -wi[0];
    for (let k = 1; k < n; k++) { br[k] = br[m - k] = wr[k]; bi[k] = bi[m - k] = -wi[k]; }
    sub.forward(br, bi);
    this.blue = { sub, m, wr, wi, br, bi, ar: new Float64Array(m), ai: new Float64Array(m) };
  }
  /** Forward transform X_k = Σ x_j e^(−2πi jk / n), unscaled. */
  forward(re: Float64Array, im: Float64Array): void {
    const n = this.n;
    if (this.rev) {
      const rev = this.rev;
      for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
      }
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1, step = n / size;
        for (let i = 0; i < n; i += size)
          for (let k = 0; k < half; k++) {
            const tr = this.cos[k * step], ti = -this.sin[k * step];
            const a = i + k, b = a + half;
            const xr = re[b] * tr - im[b] * ti, xi = re[b] * ti + im[b] * tr;
            re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
          }
      }
      return;
    }
    const B = this.blue!, { m, wr, wi, ar, ai } = B;
    ar.fill(0); ai.fill(0);
    for (let k = 0; k < n; k++) { ar[k] = re[k] * wr[k] - im[k] * wi[k]; ai[k] = re[k] * wi[k] + im[k] * wr[k]; }
    B.sub.forward(ar, ai);
    for (let k = 0; k < m; k++) { const xr = ar[k] * B.br[k] - ai[k] * B.bi[k], xi = ar[k] * B.bi[k] + ai[k] * B.br[k]; ar[k] = xr; ai[k] = -xi; }
    B.sub.forward(ar, ai); // inverse by conjugation: conj(F(conj(x)))
    for (let k = 0; k < n; k++) {
      const cr = ar[k] / m, ci = -ai[k] / m;
      re[k] = cr * wr[k] - ci * wi[k]; im[k] = cr * wi[k] + ci * wr[k];
    }
  }
  /** Inverse transform, scaled by 1 / n. */
  inverse(re: Float64Array, im: Float64Array): void {
    const n = this.n;
    for (let k = 0; k < n; k++) im[k] = -im[k];
    this.forward(re, im);
    for (let k = 0; k < n; k++) { re[k] /= n; im[k] = -im[k] / n; }
  }
}

/** DCT-II X_k = Σ x_j cos(πk(2j + 1) / 2n) of x into x, and its inverse, through one complex FFT of length n (Makhoul). */
function dct(x: Float64Array, f: FFT, re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = f.n;
  if (!inverse) {
    for (let j = 0; 2 * j < n; j++) re[j] = x[2 * j];
    for (let j = 0; 2 * j + 1 < n; j++) re[n - 1 - j] = x[2 * j + 1];
    im.fill(0, 0, n);
    f.forward(re, im);
    for (let k = 0; k < n; k++) { const t = (Math.PI * k) / (2 * n); x[k] = re[k] * Math.cos(t) + im[k] * Math.sin(t); }
    return;
  }
  // V_k = e^(iπk/2n) (X_k − i X_(n−k)), X_n = 0; v = IFFT(V); x_2j = v_j, x_2j+1 = v_(n−1−j): dct then idct is the identity
  for (let k = 0; k < n; k++) {
    const t = (Math.PI * k) / (2 * n), c = Math.cos(t), s = Math.sin(t);
    const a = x[k], b = k ? -x[n - k] : 0;
    re[k] = a * c - b * s; im[k] = a * s + b * c;
  }
  f.inverse(re, im);
  for (let j = 0; 2 * j < n; j++) x[2 * j] = re[j];
  for (let j = 0; 2 * j + 1 < n; j++) x[2 * j + 1] = re[n - 1 - j];
}

/**
 * Solve the 5-point Laplacian ∇²u = f on a w × h grid: periodic (wrap, by FFT) or with mirrored borders (zero normal
 * gradient, by DCT). The solution with mean 0.
 */
export function poisson(f: Float64Array, w: number, h: number, wrap: boolean): Float64Array {
  const fw = new FFT(w), fh = new FFT(h);
  const m = Math.max(w, h), re = new Float64Array(m), im = new Float64Array(m), line = new Float64Array(m);
  const u = Float64Array.from(f);
  if (wrap) {
    const ui = new Float64Array(w * h);
    const rows = (inv: boolean) => {
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) { re[i] = u[j * w + i]; im[i] = ui[j * w + i]; }
        if (inv) fw.inverse(re, im); else fw.forward(re, im);
        for (let i = 0; i < w; i++) { u[j * w + i] = re[i]; ui[j * w + i] = im[i]; }
      }
    };
    const cols = (inv: boolean) => {
      for (let i = 0; i < w; i++) {
        for (let j = 0; j < h; j++) { re[j] = u[j * w + i]; im[j] = ui[j * w + i]; }
        if (inv) fh.inverse(re, im); else fh.forward(re, im);
        for (let j = 0; j < h; j++) { u[j * w + i] = re[j]; ui[j * w + i] = im[j]; }
      }
    };
    rows(false); cols(false);
    for (let l = 0; l < h; l++)
      for (let k = 0; k < w; k++) {
        const lam = 2 * Math.cos((2 * Math.PI * k) / w) - 2 + 2 * Math.cos((2 * Math.PI * l) / h) - 2;
        const q = l * w + k;
        if (Math.abs(lam) < 1e-12) { u[q] = 0; ui[q] = 0; } else { u[q] /= lam; ui[q] /= lam; }
      }
    cols(true); rows(true);
    return u;
  }
  const rows = (inv: boolean) => {
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) line[i] = u[j * w + i];
      dct(line, fw, re, im, inv);
      for (let i = 0; i < w; i++) u[j * w + i] = line[i];
    }
  };
  const cols = (inv: boolean) => {
    for (let i = 0; i < w; i++) {
      for (let j = 0; j < h; j++) line[j] = u[j * w + i];
      dct(line, fh, re, im, inv);
      for (let j = 0; j < h; j++) u[j * w + i] = line[j];
    }
  };
  rows(false); cols(false);
  for (let l = 0; l < h; l++)
    for (let k = 0; k < w; k++) {
      const lam = 2 * Math.cos((Math.PI * k) / w) - 2 + 2 * Math.cos((Math.PI * l) / h) - 2;
      const q = l * w + k;
      u[q] = Math.abs(lam) < 1e-12 ? 0 : u[q] / lam;
    }
  cols(true); rows(true);
  return u;
}

/**
 * Height in metres from a tangent-space normal map (texel = metres per pixel): the slopes −n.xy / n.z are integrated
 * by solving a Poisson equation (least squares over every pair of neighbouring pixels), periodic when wrap, else with
 * mirrored borders. Mean height 0. Slopes are capped at about 87° (n.z ≥ 0.05).
 */
export function heightFromNormal(N: Float32Array, w: number, h: number, texel: number, directx: boolean, wrap: boolean): Float64Array {
  const n = w * h, p = new Float64Array(n), q = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const x = N[k * 4] * 2 - 1, y = (N[k * 4 + 1] * 2 - 1) * (directx ? -1 : 1), z = Math.max(0.05, N[k * 4 + 2] * 2 - 1);
    p[k] = -x / z; // dh/dx (x along +i)
    q[k] = y / z; // dh/dy_row = -dh/dv (rows go down)
  }
  // height steps between neighbouring pixel centres (metres), and their divergence
  const div = new Float64Array(n);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      const stepX = (a: number) => (wrap || (a >= 0 && a < w - 1) ? ((p[j * w + wrapI(a, w)] + p[j * w + wrapI(a + 1, w)]) / 2) * texel : 0);
      const stepY = (b: number) => (wrap || (b >= 0 && b < h - 1) ? ((q[wrapI(b, h) * w + i] + q[wrapI(b + 1, h) * w + i]) / 2) * texel : 0);
      div[k] = stepX(i) - stepX(i - 1) + stepY(j) - stepY(j - 1);
    }
  return poisson(div, w, h, wrap);
}

// ---------------------------------------------------------------- grunge

export const GRUNGE_STYLES = ['dirt', 'leaks', 'spots'];

export interface GrungeOptions {
  style: string;
  /** features across the image width */
  scale: number;
  /** fraction of the image that turns white (from the result's own histogram) */
  coverage: number;
  /** hardness of the edges (1 = hard) */
  contrast: number;
  /** 0..1 fine breakup mixed in */
  detail: number;
  seed: number;
  tileable: boolean;
}

/**
 * Grunge masks (grey 0..1, white = grime) built from tileable noise in uv, so the same at any resolution:
 *   dirt   blotchy patches of domain-warped fbm with speckle
 *   leaks  vertical streaks running down from random sources (rain marks, rust runs)
 *   spots  scattered round spots of random size (rust pits, drops, stains); coverage grows them
 * coverage sets the fraction of the image above 0.5 (measured on the field, like tex_histogram_scan), contrast the edge.
 */
export function genGrunge(o: GrungeOptions, w: number, h: number): Float32Array {
  const aspect = h / w, sc = Math.max(0.01, o.scale), det = clamp01(o.detail);
  const base = { noise: 'perlin' as const, fractal: 'fbm' as const, roughness: 0.55, lacunarity: 2, tileable: o.tileable, offset: [0, 0] as [number, number], aspect };
  const nz = (scale: number, octaves: number, k: number, extra: Partial<TexNoiseOptions> = {}) => texNoise({ ...base, scale, octaves, seed: o.seed * 7 + k, ...extra });
  const fine = nz(sc * 8, 3, 5);
  let field: (u: number, v: number) => number;
  if (o.style === 'leaks') {
    // long vertical cells: few rows, many columns; a coarse noise picks where runs start and how strong they are
    const streak = nz(sc * 3, 4, 1, { aspect: aspect * 0.08 });
    const source = nz(sc * 0.75, 3, 2);
    const drip = nz(sc * 6, 2, 3, { aspect: aspect * 0.25 });
    field = (u, v) => {
      const s = streak(u, v), d = drip(u, v);
      return (s * 0.7 + d * 0.3) * (0.35 + 0.65 * source(u, v));
    };
  } else if (o.style === 'spots') {
    // one spot per lattice cell at a random point with a random size; the field falls from 1 at each site with the
    // distance relative to that spot's size, and the strongest of the surrounding sites wins (spots overlap their
    // cells), so a higher coverage grows every spot, the big ones most
    let fx = sc, fy = sc * aspect;
    if (o.tileable) { fx = Math.max(1, Math.round(fx)); fy = Math.max(1, Math.round(fy)); }
    const sh = hash32(Math.floor(o.seed * 7919) ^ 0x68e31da4);
    const rough = nz(sc * 4, 3, 4);
    field = (u, v) => {
      const x = u * fx, y = v * fy, xf = Math.floor(x), yf = Math.floor(y), k = 1.6 + 0.8 * rough(u, v);
      let best = -Infinity;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const cx = xf + dx, cy = yf + dy;
          const wx = o.tileable ? wrapI(cx, fx) : cx, wy = o.tileable ? wrapI(cy, fy) : cy;
          const hh = hash32(Math.imul(wx, 0x8da6b343) ^ Math.imul(wy, 0xd8163841) ^ sh);
          const px = cx + (hh & 0xffff) / 65536, py = cy + (hash32(hh ^ 0x9e3779b9) & 0xffff) / 65536;
          const r = hash32(hh ^ 0x3b9ac9fb) / 4294967296, rad = 0.06 + 0.3 * r * r; // cell units
          const f = 1 - Math.hypot(px - x, py - y) / (rad * k);
          if (f > best) best = f;
        }
      return best;
    };
  } else {
    const n1 = nz(sc, 6, 1), wx = nz(sc * 0.5, 3, 2), wy = nz(sc * 0.5, 3, 3);
    const k = 0.6 / sc; // warp by up to about half a feature
    field = (u, v) => n1(u + (wx(u, v) - 0.5) * k, v + (wy(u, v) - 0.5) * k);
  }
  const val = new Float32Array(w * h);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const u = (i + 0.5) / w, v = 1 - (j + 0.5) / h;
      val[j * w + i] = field(u, v) * (1 + det * 1.4 * (fine(u, v) - 0.5)); // breakup scales the field: empty stays empty
    }
  // stretch the field to its own range first (noise spans a narrow band), so contrast means the same for every style
  const [lo, hi] = valueRange(val, 1, 0.002), k = hi > lo ? 1 / (hi - lo) : 1;
  for (let i = 0; i < val.length; i++) val[i] = (val[i] - lo) * k;
  const scan = histogramScanFn(1 - coverageCut(val, o.coverage, o.contrast), o.contrast);
  for (let i = 0; i < val.length; i++) val[i] = scan(val[i]);
  return val;
}
