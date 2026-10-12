// Converting selections between the four group classes (point, vertex, prim, edge).
//
// Every pair of classes is related by incidence ("touches"):
//   point – vertex   the vertex references the point
//   point – prim     the prim uses the point
//   vertex – prim    the vertex is a corner of the prim
//   point – edge     the point is an endpoint of the edge
//   prim – edge      the edge is a side of the prim (polyline segments included)
//   vertex – edge    the vertex starts or ends that side of its prim
// Converting a selection S of class X to class Y selects y when
//   include 'any': at least one X element touching y is in S
//   include 'all': every X element touching y is in S (and y touches at least one)
// This gives the Houdini group-promote semantics: prim → point = all points of the prims,
// point → prim = prims with any / all of their points, edge → point = endpoints,
// edge → prim = prims containing any / all-sides-of grouped edges, prim → edge = all sides, etc.
// Edge selections are EdgeSets (or masks over edgeList(g)); results for edges are EdgeSets.
import type { Geometry, GroupClass } from './geometry.ts';
import { EdgeSet, edgeKey, edgeList, edgeSetToMask, maskToEdgeSet } from './edges.ts';
import type { EdgeList } from './edges.ts';

export type Include = 'any' | 'all';
export type Selection = Uint8Array | EdgeSet;

const ORDER: Record<GroupClass, number> = { point: 0, vertex: 1, prim: 2, edge: 3 };

function countOf(g: Geometry, cls: GroupClass, list: EdgeList | null): number {
  return cls === 'point' ? g.numPoints : cls === 'vertex' ? g.numVertices : cls === 'prim' ? g.numPrims : list!.count;
}

/** Enumerate incidence pairs (x of class c1, y of class c2), c1 before c2 in ORDER. */
function incidence(g: Geometry, c1: GroupClass, c2: GroupClass, list: EdgeList | null, cb: (x: number, y: number) => void) {
  const vp = g.vertexPoint;
  const sides = (f: (prim: number, v0: number, v1: number, e: number) => void) => {
    for (let p = 0; p < g.numPrims; p++) {
      const s = g.primStart[p], e = g.primStart[p + 1];
      const last = g.primClosed[p] ? e : e - 1;
      for (let v = s; v < last; v++) {
        const v1 = v + 1 < e ? v + 1 : s;
        const a = vp[v], b = vp[v1];
        if (a === b) continue;
        const ei = list!.index.get(edgeKey(a, b));
        if (ei !== undefined) f(p, v, v1, ei);
      }
    }
  };
  const key = `${c1}-${c2}`;
  switch (key) {
    case 'point-vertex': for (let v = 0; v < g.numVertices; v++) cb(vp[v], v); break;
    case 'point-prim': for (let p = 0; p < g.numPrims; p++) for (let v = g.primStart[p]; v < g.primStart[p + 1]; v++) cb(vp[v], p); break;
    case 'vertex-prim': for (let p = 0; p < g.numPrims; p++) for (let v = g.primStart[p]; v < g.primStart[p + 1]; v++) cb(v, p); break;
    case 'point-edge': for (let i = 0; i < list!.count; i++) { cb(list!.a[i], i); cb(list!.b[i], i); } break;
    case 'prim-edge': sides((p, _v0, _v1, e) => cb(p, e)); break;
    case 'vertex-edge': sides((_p, v0, v1, e) => { cb(v0, e); cb(v1, e); }); break;
    default: throw new Error(`no incidence ${key}`);
  }
}

/** Selection → mask over the class's elements (edges: over the edge list). null = everything. */
function toMask(g: Geometry, cls: GroupClass, sel: Selection | null, list: EdgeList | null): Uint8Array {
  const n = countOf(g, cls, list);
  if (!sel) return new Uint8Array(n).fill(1);
  if (sel instanceof EdgeSet) return edgeSetToMask(list!, sel);
  return sel;
}

/**
 * Convert a selection of class `from` to class `to` (see the module comment for the rules).
 * Point/vertex/prim results are masks; edge results are EdgeSets. `sel` null = all elements.
 */
export function convertSelection(g: Geometry, from: GroupClass, to: GroupClass, sel: Selection | null, include: Include = 'any', list?: EdgeList): Selection {
  const L = from === 'edge' || to === 'edge' ? list ?? edgeList(g) : null;
  const src = toMask(g, from, sel, L);
  let out: Uint8Array;
  if (from === to) out = src.slice();
  else {
    const n = countOf(g, to, L);
    const total = new Int32Array(n), hit = new Int32Array(n);
    const swap = ORDER[from] > ORDER[to];
    const [c1, c2] = swap ? [to, from] : [from, to];
    incidence(g, c1, c2, L, swap ? (y, x) => { total[y]++; if (src[x]) hit[y]++; } : (x, y) => { total[y]++; if (src[x]) hit[y]++; });
    out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = include === 'all' ? (total[i] > 0 && hit[i] === total[i] ? 1 : 0) : hit[i] > 0 ? 1 : 0;
  }
  return to === 'edge' ? maskToEdgeSet(L!, out) : out;
}

/** Points touched by a selection (any = default; all = every touching element selected). */
export function pointsOf(g: Geometry, from: GroupClass, sel: Selection | null, include: Include = 'any'): Uint8Array {
  return convertSelection(g, from, 'point', sel, include) as Uint8Array;
}
export function verticesOf(g: Geometry, from: GroupClass, sel: Selection | null, include: Include = 'any'): Uint8Array {
  return convertSelection(g, from, 'vertex', sel, include) as Uint8Array;
}
export function primsOf(g: Geometry, from: GroupClass, sel: Selection | null, include: Include = 'any'): Uint8Array {
  return convertSelection(g, from, 'prim', sel, include) as Uint8Array;
}
export function edgesOf(g: Geometry, from: GroupClass, sel: Selection | null, include: Include = 'any'): EdgeSet {
  return convertSelection(g, from, 'edge', sel, include) as EdgeSet;
}
