// Deterministic randomness. Every random decision in the engine flows from a seed,
// so the same graph always produces the same geometry.

/** Integer hash (lowbias32 by Chris Wellons). */
export function hash32(x: number): number {
  x = x >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);

/** Hash an arbitrary number (including fractions) to 32 bits. */
export function hashNumber(v: number): number {
  if (Number.isInteger(v) && Math.abs(v) < 2 ** 31) return hash32(v ^ 0x9e3779b9);
  f64[0] = v;
  return hash32(u32[0] ^ hash32(u32[1]));
}

/** Stateless random in [0,1) for a value and seed — like VEX rand(). */
export function rand(v: number, seed = 0): number {
  return hash32(hashNumber(v) ^ hash32(Math.floor(seed * 7919) + 0x632be5ab)) / 4294967296;
}

/** Combine several numbers into one hash-based random in [0,1). */
export function randN(...vals: number[]): number {
  let h = 0x811c9dc5;
  for (const v of vals) h = hash32(h ^ hashNumber(v));
  return h / 4294967296;
}

/** Seeded PRNG (mulberry32) returning floats in [0,1). */
export function rng(seed: number): () => number {
  let a = rngState(seed);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The state rng(seed) starts from (for rngAt). */
export function rngState(seed: number): number {
  return hash32(hashNumber(seed) + 0x6d2b79f5);
}

/**
 * The m-th value (m = 1, 2, ...) that rng(seed) returns, from its start state rngState(seed), in O(1): mulberry32's
 * state only advances by a constant, so draws can be split across threads and give the same numbers.
 */
export function rngAt(state: number, m: number): number {
  const a = (state + Math.imul(m, 0x6d2b79f5)) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Standard normal sample from a uniform rng (Box–Muller). */
export function gaussian(r: () => number): number {
  let u = 0;
  while (u === 0) u = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

/** Uniform direction on the unit sphere. */
export function randomDirection(r: () => number): [number, number, number] {
  const z = r() * 2 - 1, a = r() * Math.PI * 2, s = Math.sqrt(1 - z * z);
  return [s * Math.cos(a), z, s * Math.sin(a)];
}

/** Fast non-cryptographic string hash (cyrb53) → 53-bit number, used for cache keys. */
export function hashString(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
