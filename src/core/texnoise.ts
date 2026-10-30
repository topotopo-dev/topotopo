// 2D noise for textures: periodic gradient (Perlin), value and cellular (Worley) noise on an integer lattice, so an
// image tiles when the frequency is a whole number of cells, plus 2D simplex and 4D simplex (tileable simplex samples
// the 4D noise on a torus: x, y = R·(cos 2πu, sin 2πu), z, w = R·(cos 2πv, sin 2πv)). Everything is seeded and pure,
// so the texture kernels give the same bits on any thread (core/kernels.ts).
import { hash32, rng } from './random.ts';

export type Noise2 = (x: number, y: number) => number;

const wrap = (i: number, p: number) => (p > 0 ? ((i % p) + p) % p : i);
/** lattice hash of integer cell (x, y) for seed s */
const lat = (x: number, y: number, s: number) => hash32(Math.imul(x, 0x8da6b343) ^ Math.imul(y, 0xd8163841) ^ s);

/** 16 unit gradient directions (angles k·22.5°). */
const GX = new Float64Array(16), GY = new Float64Array(16);
for (let k = 0; k < 16; k++) { GX[k] = Math.cos((k * Math.PI) / 8); GY[k] = Math.sin((k * Math.PI) / 8); }

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/** Gradient noise in about [-1, 1], periodic with period (px, py) cells when > 0. */
export function perlin2(seed: number, px = 0, py = 0): Noise2 {
  const s = hash32(Math.floor(seed * 7919) ^ 0x51ed270b);
  return (x, y) => {
    const xf = Math.floor(x), yf = Math.floor(y);
    const fx = x - xf, fy = y - yf;
    const x0 = wrap(xf, px), x1 = wrap(xf + 1, px), y0 = wrap(yf, py), y1 = wrap(yf + 1, py);
    const g00 = lat(x0, y0, s) & 15, g10 = lat(x1, y0, s) & 15, g01 = lat(x0, y1, s) & 15, g11 = lat(x1, y1, s) & 15;
    const n00 = GX[g00] * fx + GY[g00] * fy;
    const n10 = GX[g10] * (fx - 1) + GY[g10] * fy;
    const n01 = GX[g01] * fx + GY[g01] * (fy - 1);
    const n11 = GX[g11] * (fx - 1) + GY[g11] * (fy - 1);
    const u = fade(fx), v = fade(fy);
    const a = n00 + (n10 - n00) * u, b = n01 + (n11 - n01) * u;
    return (a + (b - a) * v) * 1.41421356;
  };
}

/** Value noise in [-1, 1], periodic with period (px, py) cells when > 0. */
export function value2(seed: number, px = 0, py = 0): Noise2 {
  const s = hash32(Math.floor(seed * 7919) ^ 0x2c1b3c6d);
  const h = (x: number, y: number) => (lat(x, y, s) / 4294967296) * 2 - 1;
  return (x, y) => {
    const xf = Math.floor(x), yf = Math.floor(y);
    const u = fade(x - xf), v = fade(y - yf);
    const x0 = wrap(xf, px), x1 = wrap(xf + 1, px), y0 = wrap(yf, py), y1 = wrap(yf + 1, py);
    const a = h(x0, y0) + (h(x1, y0) - h(x0, y0)) * u, b = h(x0, y1) + (h(x1, y1) - h(x0, y1)) * u;
    return a + (b - a) * v;
  };
}

/**
 * Result of a cellular query: distances to the nearest and second nearest feature point, the nearest cell's hash and
 * (wrapped) lattice cell, and the offset (ex, ey) from the sample to the nearest feature point.
 */
export interface CellHit { f1: number; f2: number; id: number; cx: number; cy: number; ex: number; ey: number }

/**
 * Cellular (Worley) noise: one feature point per lattice cell, jittered by `jitter` (0 = regular grid, 1 = anywhere in
 * the cell); periodic with period (px, py) cells when > 0 (feature points repeat, distances are measured across the
 * seam). metric: 0 euclidean, 1 manhattan, 2 chebyshev. Writes into `out` (id = the cell's 32-bit hash).
 */
export function cellular2(seed: number, px = 0, py = 0, jitter = 1, metric = 0): (x: number, y: number, out: CellHit) => CellHit {
  const s = hash32(Math.floor(seed * 7919) ^ 0x68e31da4);
  const j = Math.max(0, Math.min(1, jitter));
  return (x, y, out) => {
    const xf = Math.floor(x), yf = Math.floor(y);
    let f1 = Infinity, f2 = Infinity, id = 0, bx = 0, by = 0, oex = 0, oey = 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const cx = xf + dx, cy = yf + dy;
        const h = lat(wrap(cx, px), wrap(cy, py), s);
        const h2 = hash32(h ^ 0x9e3779b9);
        const fx = cx + 0.5 + (((h & 0xffff) / 65536) - 0.5) * j, fy = cy + 0.5 + (((h2 & 0xffff) / 65536) - 0.5) * j;
        const ex = fx - x, ey = fy - y;
        const d = metric === 1 ? Math.abs(ex) + Math.abs(ey) : metric === 2 ? Math.max(Math.abs(ex), Math.abs(ey)) : Math.sqrt(ex * ex + ey * ey);
        if (d < f1) { f2 = f1; f1 = d; id = h; bx = wrap(cx, px); by = wrap(cy, py); oex = ex; oey = ey; } else if (d < f2) f2 = d;
      }
    out.f1 = f1; out.f2 = f2; out.id = id; out.cx = bx; out.cy = by; out.ex = oex; out.ey = oey;
    return out;
  };
}

// ---------------------------------------------------------------- simplex (2D and 4D, Gustavson)

function permutation(seed: number): Uint8Array {
  const r = rng(seed * 1.618 + 11);
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) { const k = Math.floor(r() * (i + 1)); const t = p[i]; p[i] = p[k]; p[k] = t; }
  const out = new Uint8Array(512);
  for (let i = 0; i < 512; i++) out[i] = p[i & 255];
  return out;
}

const G2X = [1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0], G2Y = [1, 1, -1, -1, 0, 0, 0, 0, 1, -1, 1, -1];
const F2 = 0.5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6;

/** 2D simplex noise in about [-1, 1] (not periodic). */
export function simplex2(seed: number): Noise2 {
  const perm = permutation(seed);
  return (x, y) => {
    const s = (x + y) * F2;
    const i = Math.floor(x + s), j = Math.floor(y + s);
    const t = (i + j) * G2;
    const x0 = x - (i - t), y0 = y - (j - t);
    const i1 = x0 > y0 ? 1 : 0, j1 = 1 - i1;
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2, x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    let n = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) { const g = perm[ii + perm[jj]] % 12; t0 *= t0; n += t0 * t0 * (G2X[g] * x0 + G2Y[g] * y0); }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) { const g = perm[ii + i1 + perm[jj + j1]] % 12; t1 *= t1; n += t1 * t1 * (G2X[g] * x1 + G2Y[g] * y1); }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) { const g = perm[ii + 1 + perm[jj + 1]] % 12; t2 *= t2; n += t2 * t2 * (G2X[g] * x2 + G2Y[g] * y2); }
    return 70 * n;
  };
}

// 32 gradients: every permutation of (0, ±1, ±1, ±1)
const G4: number[][] = [];
for (let z = 0; z < 4; z++)
  for (let m = 0; m < 8; m++) {
    const v = [m & 4 ? -1 : 1, m & 2 ? -1 : 1, m & 1 ? -1 : 1];
    const g = [0, 0, 0, 0];
    let k = 0;
    for (let c = 0; c < 4; c++) g[c] = c === z ? 0 : v[k++];
    G4.push(g);
  }
const G4F = new Float64Array(G4.flat());
const F4 = (Math.sqrt(5) - 1) / 4, G4C = (5 - Math.sqrt(5)) / 20;

/** 4D simplex noise in about [-1, 1]. */
export function simplex4(seed: number): (x: number, y: number, z: number, w: number) => number {
  const perm = permutation(seed + 0.5);
  const corner = (gi: number, x: number, y: number, z: number, w: number) => {
    let t = 0.6 - x * x - y * y - z * z - w * w;
    if (t <= 0) return 0;
    t *= t;
    const o = gi * 4;
    return t * t * (G4F[o] * x + G4F[o + 1] * y + G4F[o + 2] * z + G4F[o + 3] * w);
  };
  return (x, y, z, w) => {
    const s = (x + y + z + w) * F4;
    const i = Math.floor(x + s), j = Math.floor(y + s), k = Math.floor(z + s), l = Math.floor(w + s);
    const t = (i + j + k + l) * G4C;
    const x0 = x - (i - t), y0 = y - (j - t), z0 = z - (k - t), w0 = w - (l - t);
    let rx = 0, ry = 0, rz = 0, rw = 0;
    if (x0 > y0) rx++; else ry++;
    if (x0 > z0) rx++; else rz++;
    if (x0 > w0) rx++; else rw++;
    if (y0 > z0) ry++; else rz++;
    if (y0 > w0) ry++; else rw++;
    if (z0 > w0) rz++; else rw++;
    const i1 = rx >= 3 ? 1 : 0, j1 = ry >= 3 ? 1 : 0, k1 = rz >= 3 ? 1 : 0, l1 = rw >= 3 ? 1 : 0;
    const i2 = rx >= 2 ? 1 : 0, j2 = ry >= 2 ? 1 : 0, k2 = rz >= 2 ? 1 : 0, l2 = rw >= 2 ? 1 : 0;
    const i3 = rx >= 1 ? 1 : 0, j3 = ry >= 1 ? 1 : 0, k3 = rz >= 1 ? 1 : 0, l3 = rw >= 1 ? 1 : 0;
    const ii = i & 255, jj = j & 255, kk = k & 255, ll = l & 255;
    const g = (a: number, b: number, c: number, d: number) => perm[ii + a + perm[jj + b + perm[kk + c + perm[ll + d]]]] & 31;
    return 27 * (
      corner(g(0, 0, 0, 0), x0, y0, z0, w0) +
      corner(g(i1, j1, k1, l1), x0 - i1 + G4C, y0 - j1 + G4C, z0 - k1 + G4C, w0 - l1 + G4C) +
      corner(g(i2, j2, k2, l2), x0 - i2 + 2 * G4C, y0 - j2 + 2 * G4C, z0 - k2 + 2 * G4C, w0 - l2 + 2 * G4C) +
      corner(g(i3, j3, k3, l3), x0 - i3 + 3 * G4C, y0 - j3 + 3 * G4C, z0 - k3 + 3 * G4C, w0 - l3 + 3 * G4C) +
      corner(g(1, 1, 1, 1), x0 - 1 + 4 * G4C, y0 - 1 + 4 * G4C, z0 - 1 + 4 * G4C, w0 - 1 + 4 * G4C)
    );
  };
}

// ---------------------------------------------------------------- fractal texture noise over (u, v)

export type TexNoiseType = 'perlin' | 'simplex' | 'value' | 'worley';
export type TexFractal = 'none' | 'fbm' | 'ridged' | 'turbulence';

export interface TexNoiseOptions {
  noise: TexNoiseType;
  fractal: TexFractal;
  /** cells (features) across the image width at the first octave */
  scale: number;
  octaves: number;
  /** amplitude gain per octave */
  roughness: number;
  /** frequency gain per octave */
  lacunarity: number;
  seed: number;
  /** whole cells per octave so the image repeats seamlessly */
  tileable: boolean;
  /** offset in cells */
  offset: [number, number];
  /** image aspect height / width (cells stay square) */
  aspect: number;
  /** worley jitter 0..1 */
  jitter?: number;
}

/**
 * A fractal noise over texture coordinates (u, v in 0..1, the whole image), returning about 0..1:
 * fbm and none map [-1, 1] to [0, 1], ridged and turbulence are already 0..1. With tileable, every octave uses a whole
 * number of cells across each axis (rounded from scale · lacunarity^i) and the noise repeats at u, v = 1.
 */
export function texNoise(o: TexNoiseOptions): (u: number, v: number) => number {
  const oct = o.fractal === 'none' ? 1 : Math.max(1, Math.min(12, Math.round(o.octaves)));
  const fns: ((u: number, v: number) => number)[] = [];
  for (let i = 0; i < oct; i++) {
    const f = o.scale * Math.pow(o.lacunarity, i);
    let fx = f, fy = f * o.aspect;
    if (o.tileable) { fx = Math.max(1, Math.round(fx)); fy = Math.max(1, Math.round(fy)); }
    const seed = o.seed * 131 + i * 977;
    const ox = o.offset[0] + i * 17.13, oy = o.offset[1] + i * 9.71;
    const px = o.tileable ? fx : 0, py = o.tileable ? fy : 0;
    if (o.noise === 'simplex' && o.tileable) {
      const n4 = simplex4(seed);
      const rx = fx / (2 * Math.PI), ry = fy / (2 * Math.PI), TAU = 2 * Math.PI;
      // the torus keeps the feature size close to the 2D lattice's (circumference = cells across)
      fns.push((u, v) => n4(rx * Math.cos(TAU * u) + ox, rx * Math.sin(TAU * u) + oy, ry * Math.cos(TAU * v) - ox, ry * Math.sin(TAU * v) - oy) * 1.15);
    } else if (o.noise === 'simplex') {
      const n2 = simplex2(seed);
      fns.push((u, v) => n2(u * fx + ox, v * fy + oy));
    } else if (o.noise === 'worley') {
      const c = cellular2(seed, px, py, o.jitter ?? 1);
      const hit: CellHit = { f1: 0, f2: 0, id: 0, cx: 0, cy: 0, ex: 0, ey: 0 };
      fns.push((u, v) => Math.min(1, c(u * fx + ox, v * fy + oy, hit).f1 / 0.85) * 2 - 1);
    } else {
      const n = o.noise === 'value' ? value2(seed, px, py) : perlin2(seed, px, py);
      fns.push((u, v) => n(u * fx + ox, v * fy + oy));
    }
  }
  const mode = o.fractal;
  let norm = 0;
  for (let i = 0, a = 1; i < oct; i++, a *= o.roughness) norm += a;
  return (u, v) => {
    let sum = 0, amp = 1, prev = 1;
    for (let i = 0; i < oct; i++) {
      const n = fns[i](u, v);
      if (mode === 'ridged') {
        const r = 1 - Math.abs(n);
        const w = r * r * prev;
        prev = Math.min(1, w * 2);
        sum += w * amp;
      } else if (mode === 'turbulence') sum += Math.abs(n) * amp;
      else sum += n * amp;
      amp *= o.roughness;
    }
    const x = sum / norm;
    const out = mode === 'ridged' || mode === 'turbulence' ? x : x * 0.5 + 0.5;
    return out < 0 ? 0 : out > 1 ? 1 : out;
  };
}
