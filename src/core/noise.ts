// Noise library: Perlin (improved), simplex (via simplex-noise), Worley/cellular,
// value noise, fractal layering (fBm / ridged / turbulence), domain warp and curl noise.
// All generators are seeded and return values roughly in [-1, 1] (worley: [0, ~1]).
import { createNoise3D } from 'simplex-noise';
import { rng, hash32 } from './random.ts';

export type Noise3 = (x: number, y: number, z: number) => number;
export type NoiseType = 'perlin' | 'simplex' | 'value' | 'worley' | 'worley_f2f1';

// ---------------------------------------------------------------- Perlin (improved, 2002)

function makePerlin(seed: number): Noise3 {
  const r = rng(seed);
  const p = new Uint8Array(512);
  const perm = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  for (let i = 0; i < 512; i++) p[i] = perm[i & 255];
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const grad = (h: number, x: number, y: number, z: number) => {
    const hh = h & 15;
    const u = hh < 8 ? x : y;
    const v = hh < 4 ? y : hh === 12 || hh === 14 ? x : z;
    return ((hh & 1) === 0 ? u : -u) + ((hh & 2) === 0 ? v : -v);
  };
  return (x, y, z) => {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
    x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
    const u = fade(x), v = fade(y), w = fade(z);
    const A = p[X] + Y, AA = p[A] + Z, AB = p[A + 1] + Z;
    const B = p[X + 1] + Y, BA = p[B] + Z, BB = p[B + 1] + Z;
    const l = (a: number, b: number, t: number) => a + t * (b - a);
    return l(
      l(l(grad(p[AA], x, y, z), grad(p[BA], x - 1, y, z), u), l(grad(p[AB], x, y - 1, z), grad(p[BB], x - 1, y - 1, z), u), v),
      l(l(grad(p[AA + 1], x, y, z - 1), grad(p[BA + 1], x - 1, y, z - 1), u), l(grad(p[AB + 1], x, y - 1, z - 1), grad(p[BB + 1], x - 1, y - 1, z - 1), u), v),
      w,
    ) * 0.97;
  };
}

// ---------------------------------------------------------------- Value noise

function makeValue(seed: number): Noise3 {
  const s = hash32(seed * 977 + 13);
  const h = (x: number, y: number, z: number) =>
    (hash32(Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791) ^ s) / 4294967296) * 2 - 1;
  const sm = (t: number) => t * t * (3 - 2 * t);
  return (x, y, z) => {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const u = sm(x - xi), v = sm(y - yi), w = sm(z - zi);
    const l = (a: number, b: number, t: number) => a + t * (b - a);
    return l(
      l(l(h(xi, yi, zi), h(xi + 1, yi, zi), u), l(h(xi, yi + 1, zi), h(xi + 1, yi + 1, zi), u), v),
      l(l(h(xi, yi, zi + 1), h(xi + 1, yi, zi + 1), u), l(h(xi, yi + 1, zi + 1), h(xi + 1, yi + 1, zi + 1), u), v),
      w,
    );
  };
}

// ---------------------------------------------------------------- Worley / cellular

/** Returns [F1, F2] distances to the nearest feature points (one jittered point per cell). */
export function makeWorleyF(seed: number) {
  const s = hash32(seed * 31 + 7);
  const cell = (x: number, y: number, z: number, k: number) =>
    hash32(Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791) ^ s ^ Math.imul(k, 2654435761)) / 4294967296;
  return (x: number, y: number, z: number): [number, number] => {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    let f1 = 1e9, f2 = 1e9;
    for (let dz = -1; dz <= 1; dz++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const cx = xi + dx, cy = yi + dy, cz = zi + dz;
          const px = cx + cell(cx, cy, cz, 1), py = cy + cell(cx, cy, cz, 2), pz = cz + cell(cx, cy, cz, 3);
          const d = Math.hypot(px - x, py - y, pz - z);
          if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
        }
    return [f1, f2];
  };
}

// ---------------------------------------------------------------- factory

export function makeNoise(type: NoiseType | string = 'perlin', seed = 0): Noise3 {
  switch (type) {
    case 'simplex': {
      return createNoise3D(rng(seed));
    }
    case 'value':
      return makeValue(seed);
    case 'worley': {
      const w = makeWorleyF(seed);
      return (x, y, z) => w(x, y, z)[0];
    }
    case 'worley_f2f1': {
      const w = makeWorleyF(seed);
      return (x, y, z) => { const f = w(x, y, z); return f[1] - f[0]; };
    }
    case 'perlin':
    default:
      return makePerlin(seed);
  }
}

export interface FractalOpts {
  octaves?: number;
  lacunarity?: number;
  roughness?: number; // gain per octave
  fractal?: 'fbm' | 'ridged' | 'turbulence' | 'none';
}

/** Layer a base noise into a fractal. Output is normalised back to roughly the base range. */
export function fractal(base: Noise3, o: FractalOpts = {}): Noise3 {
  const oct = Math.max(1, Math.min(12, Math.round(o.octaves ?? 4)));
  const lac = o.lacunarity ?? 2.01;
  const gain = o.roughness ?? 0.5;
  const mode = o.fractal ?? 'fbm';
  if (mode === 'none' || oct === 1 && mode === 'fbm') return base;
  let norm = 0;
  for (let i = 0, a = 1; i < oct; i++, a *= gain) norm += a;
  return (x, y, z) => {
    let sum = 0, amp = 1, f = 1, prev = 1;
    for (let i = 0; i < oct; i++) {
      // offset each octave so lattice artefacts don't line up
      const n = base(x * f + i * 17.13, y * f + i * 9.71, z * f + i * 3.37);
      if (mode === 'ridged') {
        const r = 1 - Math.abs(n);
        const v = r * r * prev;
        prev = Math.min(1, v * 2);
        sum += v * amp;
      } else if (mode === 'turbulence') sum += Math.abs(n) * amp;
      else sum += n * amp;
      amp *= gain;
      f *= lac;
    }
    const v = sum / norm;
    return mode === 'ridged' || mode === 'turbulence' ? v * 2 - 1 : v;
  };
}

/**
 * Domain warp: two decorrelated fBm simplex noises, roughly in [-1, 1] (at most 1 in magnitude), for the X and Z offsets
 * of another noise's lookup: n(p + amplitude × (warp.x(q), warp.z(q))) with q = p × frequency bends straight
 * features into meanders. Deterministic per seed.
 */
export function makeWarp(seed = 0, octaves = 3): { x: Noise3; z: Noise3 } {
  const n = fractal(makeNoise('simplex', seed), { octaves, roughness: 0.5, lacunarity: 2.01, fractal: 'fbm' });
  return { x: n, z: (x, y, z) => n(x + 71.37, y + 23.11, z - 47.21) };
}

/** Divergence-free curl noise from three decorrelated potentials. */
export function makeCurl(n: Noise3, eps = 1e-3) {
  const pA = (x: number, y: number, z: number) => n(x, y, z);
  const pB = (x: number, y: number, z: number) => n(x + 31.416, y - 47.853, z + 12.793);
  const pC = (x: number, y: number, z: number) => n(x - 93.5, y + 15.4, z - 63.1);
  return (x: number, y: number, z: number): [number, number, number] => {
    const i = 1 / (2 * eps);
    const dCdy = (pC(x, y + eps, z) - pC(x, y - eps, z)) * i;
    const dBdz = (pB(x, y, z + eps) - pB(x, y, z - eps)) * i;
    const dAdz = (pA(x, y, z + eps) - pA(x, y, z - eps)) * i;
    const dCdx = (pC(x + eps, y, z) - pC(x - eps, y, z)) * i;
    const dBdx = (pB(x + eps, y, z) - pB(x - eps, y, z)) * i;
    const dAdy = (pA(x, y + eps, z) - pA(x, y - eps, z)) * i;
    return [dCdy - dBdz, dAdz - dCdx, dBdx - dAdy];
  };
}
