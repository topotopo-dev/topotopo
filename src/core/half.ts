// 16-bit float storage for image layers whose values need about three significant digits (masks 0..1: within 0.0003).
// Values are rounded to the nearest 16-bit float (ties to even, as Float16Array and Math.f16round round) on every
// runtime, so a result is the same number everywhere; where the runtime has Float16Array (Node 24, current browsers)
// they are also stored in one, at half the memory, and elsewhere in a Float32Array holding the same values.
// Whole numbers are exact up to 2048 only, so ids above that are not kept this way.

/** The runtime's Float16Array, when it has one. */
const F16: (new (src: ArrayLike<number>) => ArrayLike<number>) | undefined = (globalThis as any).Float16Array;

/** Whether layers rounded to 16 bits are also stored in 16 bits here. */
export const HALF_STORED = typeof F16 === 'function';

/** Whether an array holds 16-bit floats (a Float16Array). */
export function isHalfArray(a: unknown): boolean {
  return !!F16 && a instanceof F16;
}

const f64 = new Float64Array(1), bits = new DataView(f64.buffer);

/** x rounded to the nearest 16-bit float: ties to even, past 65520 infinite, below 2⁻²⁴ / 2 zero (sign kept). */
export function f16round(x: number): number {
  if (!Number.isFinite(x) || x === 0) return x;
  const ax = Math.abs(x);
  if (ax >= 65520) return x > 0 ? Infinity : -Infinity;
  f64[0] = ax;
  const e = ((bits.getUint32(4, true) >>> 20) & 0x7ff) - 1023;
  // the spacing of 16-bit floats at this magnitude: 2^(e − 10), and 2^−24 among the subnormals
  const ulp = 2 ** (Math.max(e, -14) - 10), q = ax / ulp, f = Math.floor(q), d = q - f;
  const r = (d > 0.5 || (d === 0.5 && f % 2 === 1) ? f + 1 : f) * ulp;
  return x < 0 ? -r : r;
}

/** The values rounded to 16-bit floats: a Float16Array where the runtime has one (typed as a Float32Array, which it
 *  reads like), else a Float32Array of the rounded values. */
export function toHalf(a: ArrayLike<number>): Float32Array {
  if (F16) return new F16(a) as unknown as Float32Array;
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = f16round(a[i]);
  return out;
}
