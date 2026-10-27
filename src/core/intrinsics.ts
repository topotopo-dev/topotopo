// Primitive intrinsics: read-only values computed from the geometry when asked, never stored (wrangle
// primintrinsic(i, "name", prim), expression primintrinsic('n', prim, 'name')). Bounds are (xmin, xmax, ymin, ymax, zmin,
// zmax). Matrices are row-major for row vectors, p' = p · M + t: a packed prim's "transform" is its 3 × 3 rotation·scale
// and "packedfulltransform" the 4 × 4 with the anchor position as its last row (sources are stored around their pivot,
// so "pivot" is the origin).
import type { Geometry } from './geometry.ts';

type Box = { min: number[]; max: number[]; empty: boolean };
// cooked geometry is immutable, so a source's box can be kept as long as the source lives
const sourceBoxes = new WeakMap<Geometry, Box>();
const sourceBox = (src: Geometry): Box => {
  let b = sourceBoxes.get(src);
  if (!b) { b = src.bbox(true); sourceBoxes.set(src, b); }
  return b;
};
const NONE = () => [0, 0, 0, 0, 0, 0];
const flat = (b: Box) => (b.empty ? NONE() : [b.min[0], b.max[0], b.min[1], b.max[1], b.min[2], b.max[2]]);

/** typename per prim kind (0 polygon or polyline, 1 packed, 2 Bezier, 3 NURBS) */
const TYPE_NAMES = ['Poly', 'PackedGeometry', 'BezierCurve', 'NURBCurve'];
const COMMON = ['bounds', 'typename', 'vertexcount'];
const SHAPE = ['closed'];
const PACKED = ['packedbounds', 'transform', 'packedfulltransform', 'packedlocaltransform', 'pivot'];
/** Every prim intrinsic name. */
export const PRIM_INTRINSICS: readonly string[] = [...COMMON, ...SHAPE, ...PACKED];

/** The intrinsics prim p has. */
export function primIntrinsicNames(g: Geometry, p: number): string[] {
  return g.isPacked(p) ? [...COMMON, ...PACKED] : [...COMMON, ...SHAPE];
}

/** World box of a packed instance: the exact box of its source's box under the instance transform. */
function instanceBounds(g: Geometry, p: number): number[] {
  const src = g.packedSources[g.packedSource![p]], b = src ? sourceBox(src) : null;
  if (!b || b.empty || g.primStart[p + 1] === g.primStart[p]) return NONE();
  const X = g.packedXform!, o = p * 9, a = g.vertexPoint[g.primStart[p]] * 3, P = g.P, out: number[] = [];
  for (let r = 0; r < 3; r++) {
    const m0 = X[o + r], m1 = X[o + 3 + r], m2 = X[o + 6 + r];
    const c = P[a + r] + m0 * (b.min[0] + b.max[0]) / 2 + m1 * (b.min[1] + b.max[1]) / 2 + m2 * (b.min[2] + b.max[2]) / 2;
    const e = (Math.abs(m0) * (b.max[0] - b.min[0]) + Math.abs(m1) * (b.max[1] - b.min[1]) + Math.abs(m2) * (b.max[2] - b.min[2])) / 2;
    out.push(c - e, c + e);
  }
  return out;
}

/** Box of a polygon's or curve's points (a spline's control points). */
function pointBounds(g: Geometry, p: number): number[] {
  const pts = g.primPoints(p), P = g.P;
  if (!pts.length) return NONE();
  const out = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
  for (const q of pts) for (let k = 0; k < 3; k++) {
    const v = P[q * 3 + k];
    if (v < out[k * 2]) out[k * 2] = v;
    if (v > out[k * 2 + 1]) out[k * 2 + 1] = v;
  }
  return out;
}

/** Intrinsic `name` of prim p: a number, a string or an array; throws for an unknown name or one p does not have. */
export function primIntrinsic(g: Geometry, p: number, name: string): number | string | number[] {
  if (!Number.isInteger(p) || p < 0 || p >= g.numPrims) throw new Error(`prim ${p} is out of range (${g.numPrims} prims)`);
  const packed = g.isPacked(p), type = TYPE_NAMES[g.primKind ? g.primKind[p] : 0] ?? 'Poly';
  switch (name) {
    case 'bounds': return packed ? instanceBounds(g, p) : pointBounds(g, p);
    case 'typename': return type;
    case 'vertexcount': return g.primStart[p + 1] - g.primStart[p];
    case 'closed': if (!packed) return g.primClosed[p] ? 1 : 0; break;
    case 'packedbounds': if (packed) { const src = g.packedSources[g.packedSource![p]]; return src ? flat(sourceBox(src)) : NONE(); } break;
    case 'transform': if (packed) return Array.from(g.packedXform!.subarray(p * 9, p * 9 + 9)); break;
    case 'packedfulltransform':
    case 'packedlocaltransform':
      if (packed) {
        const X = g.packedXform!, o = p * 9, P = g.P, has = g.primStart[p + 1] > g.primStart[p], a = has ? g.vertexPoint[g.primStart[p]] * 3 : -1;
        return [X[o], X[o + 1], X[o + 2], 0, X[o + 3], X[o + 4], X[o + 5], 0, X[o + 6], X[o + 7], X[o + 8], 0,
          has ? P[a] : 0, has ? P[a + 1] : 0, has ? P[a + 2] : 0, 1];
      }
      break;
    case 'pivot': if (packed) return [0, 0, 0]; break;
  }
  const have = primIntrinsicNames(g, p).join(', ');
  if (PRIM_INTRINSICS.includes(name)) throw new Error(`prim ${p} is ${type}: "${name}" is only on ${PACKED.includes(name) ? 'packed prims' : 'polygons and curves'} (this prim has ${have})`);
  throw new Error(`no intrinsic "${name}" (this prim has ${have})`);
}
