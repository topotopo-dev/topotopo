// Edges as unordered point pairs (Houdini edge groups) and a unique-edge list.
//
// An edge is identified by its two point indices, independent of direction and of which
// primitives use it. The canonical key packs (min, max) into one safe integer:
//   edgeKey(a, b) = min * 2^26 + max          (valid for point indices < 2^26 = 67,108,864)
// so EdgeSet is a Set<number> underneath and needs no string building.
import type { Geometry } from './geometry.ts';

/** Point indices must stay below this for edgeKey to be exact (2^26 · 2^26 = 2^52 < 2^53). */
export const EDGE_KEY_LIMIT = 2 ** 26;

/** Canonical key of the unordered edge {a, b}. Throws for negative or too-large indices. */
export function edgeKey(a: number, b: number): number {
  if (a > b) { const t = a; a = b; b = t; }
  if (a < 0 || b >= EDGE_KEY_LIMIT) throw new RangeError(`edge (${a}, ${b}): point indices must be in 0..${EDGE_KEY_LIMIT - 1}`);
  return a * EDGE_KEY_LIMIT + b;
}

/** Inverse of edgeKey: [min, max]. */
export function edgeFromKey(k: number): [number, number] {
  const a = Math.floor(k / EDGE_KEY_LIMIT);
  return [a, k - a * EDGE_KEY_LIMIT];
}

/**
 * A set of undirected edges (point pairs). Iteration yields [a, b] with a < b in insertion order;
 * toPairs() is sorted (deterministic regardless of how the set was built). Self-edges (a == b)
 * are never stored.
 */
export class EdgeSet {
  private keys = new Set<number>();

  constructor(pairs?: Iterable<readonly [number, number]>) {
    if (pairs) for (const [a, b] of pairs) this.add(a, b);
  }

  /** Build from a flat [a0, b0, a1, b1, ...] array. */
  static fromPairs(pairs: ArrayLike<number>): EdgeSet {
    const s = new EdgeSet();
    for (let i = 0; i + 1 < pairs.length; i += 2) s.add(pairs[i], pairs[i + 1]);
    return s;
  }

  static fromKeys(keys: Iterable<number>): EdgeSet {
    const s = new EdgeSet();
    for (const k of keys) s.keys.add(k);
    return s;
  }

  get size() { return this.keys.size; }
  has(a: number, b: number): boolean {
    if (a === b || a < 0 || b < 0 || a >= EDGE_KEY_LIMIT || b >= EDGE_KEY_LIMIT) return false;
    return this.keys.has(edgeKey(a, b));
  }
  hasKey(k: number) { return this.keys.has(k); }
  /** Adds the edge; returns false for self-edges (a == b), which are ignored. */
  add(a: number, b: number): boolean {
    if (a === b) return false;
    this.keys.add(edgeKey(a, b));
    return true;
  }
  addKey(k: number) { this.keys.add(k); }
  delete(a: number, b: number): boolean {
    if (a === b) return false;
    return this.keys.delete(edgeKey(a, b));
  }
  deleteKey(k: number) { return this.keys.delete(k); }
  clear() { this.keys.clear(); }

  *[Symbol.iterator](): IterableIterator<[number, number]> {
    for (const k of this.keys) yield edgeFromKey(k);
  }
  keyIterator(): IterableIterator<number> { return this.keys.values(); }

  /** Flat sorted pairs [a0, b0, a1, b1, ...] with a < b. */
  toPairs(): Int32Array {
    const ks = [...this.keys].sort((x, y) => x - y);
    const out = new Int32Array(ks.length * 2);
    ks.forEach((k, i) => { const [a, b] = edgeFromKey(k); out[i * 2] = a; out[i * 2 + 1] = b; });
    return out;
  }

  clone(): EdgeSet { return EdgeSet.fromKeys(this.keys); }

  /**
   * Map endpoints through pointMap (old index → new index, < 0 = removed). Edges whose endpoint
   * vanished or whose endpoints collapse onto one point are dropped.
   */
  remap(pointMap: ArrayLike<number>): EdgeSet {
    const out = new EdgeSet();
    for (const k of this.keys) {
      const [a, b] = edgeFromKey(k);
      const na = a < pointMap.length ? pointMap[a] : -1, nb = b < pointMap.length ? pointMap[b] : -1;
      if (na < 0 || nb < 0 || na === nb) continue;
      out.add(na, nb);
    }
    return out;
  }

  /** Every endpoint shifted by `offset` (used when merging geometries). */
  shifted(offset: number): EdgeSet {
    if (offset === 0) return this.clone();
    const out = new EdgeSet();
    for (const k of this.keys) { const [a, b] = edgeFromKey(k); out.add(a + offset, b + offset); }
    return out;
  }

  /** Keep only edges for which keep(a, b) is true. */
  filter(keep: (a: number, b: number) => boolean): EdgeSet {
    const out = new EdgeSet();
    for (const k of this.keys) { const [a, b] = edgeFromKey(k); if (keep(a, b)) out.keys.add(k); }
    return out;
  }

  union(o: EdgeSet): EdgeSet { const s = this.clone(); for (const k of o.keys) s.keys.add(k); return s; }
}

/**
 * Unique undirected edges of a geometry, in order of first occurrence while walking prims in
 * order and each prim's vertices in order (closed polygons wrap last→first, polylines don't).
 * Polyline segments are included. Degenerate segments (a == b) are skipped.
 * This order is what edge index ranges ("0-10") address in edge group patterns, and it equals
 * the half-edge structure's edge ids for meshes made only of polygons.
 */
export interface EdgeList {
  count: number;
  a: Int32Array; // lower point index
  b: Int32Array; // higher point index
  /** number of closed-polygon sides using the edge (0 = polyline-only, 1 = boundary, 2 = shared, >2 non-manifold) */
  polyCount: Int32Array;
  index: Map<number, number>; // edgeKey → edge index
}

export function edgeList(g: Geometry): EdgeList {
  const index = new Map<number, number>();
  const A: number[] = [], B: number[] = [], C: number[] = [];
  for (let p = 0; p < g.numPrims; p++) {
    const s = g.primStart[p], e = g.primStart[p + 1], closed = g.primClosed[p];
    const last = closed ? e : e - 1;
    for (let v = s; v < last; v++) {
      const a = g.vertexPoint[v], b = g.vertexPoint[v + 1 < e ? v + 1 : s];
      if (a === b) continue;
      const k = edgeKey(a, b);
      let ei = index.get(k);
      if (ei === undefined) { ei = A.length; index.set(k, ei); A.push(Math.min(a, b)); B.push(Math.max(a, b)); C.push(0); }
      if (closed && e - s >= 3) C[ei]++;
    }
  }
  return { count: A.length, a: Int32Array.from(A), b: Int32Array.from(B), polyCount: Int32Array.from(C), index };
}

/** Call cb for every prim side (closed wrap, polylines open), skipping degenerate a == b sides. */
export function forEachPrimEdge(g: Geometry, cb: (prim: number, v0: number, v1: number, a: number, b: number) => void) {
  for (let p = 0; p < g.numPrims; p++) {
    const s = g.primStart[p], e = g.primStart[p + 1];
    const last = g.primClosed[p] ? e : e - 1;
    for (let v = s; v < last; v++) {
      const v1 = v + 1 < e ? v + 1 : s;
      const a = g.vertexPoint[v], b = g.vertexPoint[v1];
      if (a !== b) cb(p, v, v1, a, b);
    }
  }
}

/** EdgeSet → mask over an EdgeList (pairs that are not edges of any prim are ignored). */
export function edgeSetToMask(list: EdgeList, set: EdgeSet): Uint8Array {
  const m = new Uint8Array(list.count);
  if (set.size === 0) return m;
  for (let i = 0; i < list.count; i++) if (set.hasKey(list.a[i] * EDGE_KEY_LIMIT + list.b[i])) m[i] = 1;
  return m;
}

/** Mask over an EdgeList (null = all) → EdgeSet. */
export function maskToEdgeSet(list: EdgeList, mask: Uint8Array | null): EdgeSet {
  const s = new EdgeSet();
  for (let i = 0; i < list.count; i++) if (!mask || mask[i]) s.addKey(list.a[i] * EDGE_KEY_LIMIT + list.b[i]);
  return s;
}
