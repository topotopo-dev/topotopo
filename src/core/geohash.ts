// Content hashes of geometry, used to deduplicate packed-primitive sources (merge, pack, copy variants).
//
// The hash covers counts, quantised positions, topology, packed instances (recursively) and every attribute and
// group. Positions and float attributes are quantised to a grid relative to the bounding box (1e-7 of its diagonal),
// so pieces that differ only by floating-point noise after being moved to their pivot hash equally. It is a cache
// key, not a fingerprint for tests (test/fingerprint.ts is). Geometry is immutable once cooked, so the hash is
// memoised per object.
import type { Geometry } from './geometry.ts';
import { hashString } from './random.ts';

const memo = new WeakMap<Geometry, string>();
let unique = 0;

/** Two 32-bit FNV-1a lanes over 32-bit words. */
class H {
  a = 0x811c9dc5;
  b = 0x050c5d1f;
  w(x: number) {
    x |= 0;
    this.a = Math.imul(this.a ^ x, 0x01000193);
    this.b = Math.imul(this.b ^ (x >>> 7) ^ 0x5bd1e995, 0x01000193);
  }
  q(v: number, inv: number) {
    if (!Number.isFinite(v)) { this.w(0x7fc00000); return; }
    const r = Math.round(v * inv);
    this.w(r % 4294967296);
    this.w(Math.floor(r / 4294967296));
  }
  s(str: string) { this.w(hashString(str)); this.w(str.length); }
  hex() { return (this.a >>> 0).toString(16).padStart(8, '0') + (this.b >>> 0).toString(16).padStart(8, '0'); }
}

/** Content hash of a geometry (16 hex chars), memoised per object. */
export function geoContentHash(g: Geometry): string {
  const m = memo.get(g);
  if (m) return m;
  const h = new H();
  const P = g.P;
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < P.length; i++) { const v = P[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
  const span = Number.isFinite(mx - mn) && mx > mn ? mx - mn : 1;
  const inv = 1 / (span * 1e-7);
  h.w(g.numPoints); h.w(g.numVertices); h.w(g.numPrims);
  // absolute positions on a grid of 1e-7 of the coordinate span: noise does not matter, a translated copy differs
  for (let i = 0; i < P.length; i++) h.q(P[i], inv);
  for (let i = 0; i < g.primStart.length; i++) h.w(g.primStart[i]);
  for (let i = 0; i < g.vertexPoint.length; i++) h.w(g.vertexPoint[i]);
  for (let i = 0; i < g.primClosed.length; i++) h.w(g.primClosed[i]);
  if (g.primKind) {
    const src = g.packedSources.map(geoContentHash);
    const X = g.packedXform!, S = g.packedSource!;
    for (let p = 0; p < g.numPrims; p++) {
      if (g.primKind[p] !== 1) {
        if (g.primKind[p]) { h.w(p); h.w(g.primKind[p]); } // spline kinds (2 Bezier, 3 NURBS)
        continue;
      }
      h.w(p); h.s(src[S[p]] ?? '');
      for (let k = 0; k < 9; k++) h.q(X[p * 9 + k], 1e9);
    }
  }
  for (const cls of ['point', 'vertex', 'prim', 'detail'] as const) {
    const t = g.table(cls);
    for (const name of [...t.map.keys()].sort()) {
      if (cls === 'point' && name === 'P') continue;
      const a = t.get(name)!;
      h.s(cls + ':' + name + ':' + a.type + ':' + a.size);
      if (a.isArray) {
        a.compact();
        for (const o of a.offsets!) h.w(o);
      }
      const d = a.data;
      if (Array.isArray(d)) for (const s of d) h.s(String(s));
      else if (d instanceof Int32Array) for (let i = 0; i < d.length; i++) h.w(d[i]);
      else for (let i = 0; i < d.length; i++) h.q(d[i], 1e7);
    }
  }
  for (const cls of ['point', 'vertex', 'prim'] as const) {
    for (const name of [...g.groups(cls).keys()].sort()) {
      h.s(cls + ' group ' + name);
      const msk = g.groups(cls).get(name)!;
      for (let i = 0; i < msk.length; i++) if (msk[i]) h.w(i);
    }
  }
  for (const name of [...g.edgeGroups.keys()].sort()) {
    h.s('edge group ' + name);
    for (const k of [...g.edgeGroups.get(name)!.keyIterator()].sort((x, y) => x - y)) { h.w(k % 4294967296); h.w(Math.floor(k / 4294967296)); }
  }
  // SDF volumes are functions and cannot be compared: geometry with volumes is only equal to itself
  if (g.volumes.length) h.w(++unique);
  const out = h.hex();
  memo.set(g, out);
  return out;
}
