// Where a geometry problem is, in words a person can act on: every warning and inspect finding names the part (prim
// "name" and the groups the element is in) and a world position of its first offending element, never a bare index.
//   primWhere(g, p)   prim 12 of "barrel" (groups front, top) at (0.120, 0.500, -0.300)
//   pointWhere(g, i)  point 7 of "barrel" at (…)
//   edgeWhere(g, a, b, prim)  the edge between points a and b, at its midpoint, in the part of `prim`
// Positions are in metres at millimetre precision.
//
// solidReport(g) says whether a mesh is a closed solid and, when it is not, why: open edges (after welding the vertex
// splits of uv and normal seams, which import and export leave as coincident points), non-manifold edges, winding
// flips between neighbouring polygons, closed pieces facing inward and degenerate faces, each with a count, the first
// one's position and the fix. Seam welding: a boundary edge whose two points coincide (within 1e-7 of the bbox
// diagonal) with those of exactly one other boundary edge is a seam split, not a hole.
import type { Geometry } from './geometry.ts';
import { buildEdges, primArea, triangulate } from './topology.ts';
import type { Triangulation } from './topology.ts';
import { halfEdges } from './halfedge.ts';

/** (x, y, z) in metres at millimetre precision. */
export function posText(p: ArrayLike<number>): string {
  const f = (x: number) => (Number.isFinite(x) ? (Math.abs(x) < 5e-4 ? 0 : x).toFixed(3) : String(x));
  return `(${f(p[0])}, ${f(p[1])}, ${f(p[2])})`;
}

/** The centroid of a prim's points. */
export function primCentroid(g: Geometry, p: number): [number, number, number] {
  const s = g.primStart[p], e = g.primStart[p + 1], P = g.P;
  let x = 0, y = 0, z = 0;
  for (let v = s; v < e; v++) { const i = g.vertexPoint[v] * 3; x += P[i]; y += P[i + 1]; z += P[i + 2]; }
  const n = Math.max(1, e - s);
  return [x / n, y / n, z / n];
}

/** The prim's part: its "name" (prim string attribute), and up to three prim groups holding it. */
export function primPart(g: Geometry, p: number): { name: string; groups: string[] } {
  const na = g.prims.get('name');
  const name = na && na.type === 'string' ? String(na.get(p) ?? '') : '';
  const groups: string[] = [];
  for (const [k, m] of g.primGroups) { if (m[p]) groups.push(k); if (groups.length >= 3) break; }
  return { name, groups };
}

/** The point's part: its point "name", else the name of a prim that uses it; up to three point groups. */
export function pointPart(g: Geometry, i: number, prim = -1): { name: string; groups: string[] } {
  const pa = g.points.get('name');
  let name = pa && pa.type === 'string' ? String(pa.get(i) ?? '') : '';
  if (!name && prim >= 0) name = primPart(g, prim).name;
  const groups: string[] = [];
  for (const [k, m] of g.pointGroups) { if (m[i]) groups.push(k); if (groups.length >= 3) break; }
  return { name, groups };
}

const partText = (pt: { name: string; groups: string[] }) =>
  `${pt.name ? ` of "${pt.name}"` : ''}${pt.groups.length ? ` (group${pt.groups.length > 1 ? 's' : ''} ${pt.groups.join(', ')})` : ''}`;

/** "prim 12 of "barrel" (groups front) at (x, y, z)": the prim's part and its centroid (or `at`, a point on it). */
export function primWhere(g: Geometry, p: number, at?: ArrayLike<number>): string {
  return `prim ${p}${partText(primPart(g, p))} at ${posText(at ?? primCentroid(g, p))}`;
}

/** "point 7 of "barrel" at (x, y, z)". */
export function pointWhere(g: Geometry, i: number, prim = -1): string {
  return `point ${i}${partText(pointPart(g, i, prim))} at ${posText([g.P[i * 3], g.P[i * 3 + 1], g.P[i * 3 + 2]])}`;
}

/** "edge 3–7 of "barrel" (prim 12) at (midpoint)": the part of the prim that holds the edge. */
export function edgeWhere(g: Geometry, a: number, b: number, prim = -1): string {
  const P = g.P, m = [(P[a * 3] + P[b * 3]) / 2, (P[a * 3 + 1] + P[b * 3 + 1]) / 2, (P[a * 3 + 2] + P[b * 3 + 2]) / 2];
  const pt = prim >= 0 ? primPart(g, prim) : { name: '', groups: [] };
  return `edge ${a}–${b}${partText(pt)}${prim >= 0 ? ` (prim ${prim})` : ''} at ${posText(m)}`;
}

/** The parts (names) a set of prims belongs to, most prims first: `"barrel" 12, "stock" 3`. */
export function partsOf(g: Geometry, prims: Iterable<number>, max = 4): string {
  const na = g.prims.get('name');
  if (!na || na.type !== 'string') return '';
  const by = new Map<string, number>();
  for (const p of prims) { const k = String(na.get(p) ?? ''); by.set(k, (by.get(k) ?? 0) + 1); }
  const list = [...by].sort((x, y) => y[1] - x[1]);
  return list.slice(0, max).map(([k, n]) => `"${k}" ${n}`).join(', ') + (list.length > max ? `, … ${list.length - max} more` : '');
}

export interface SolidReport {
  polys: number;
  /** a closed solid as it is: every polygon edge shared by exactly two polygons */
  closed: boolean;
  /** boundary edges of polygons as the points are */
  boundaryEdges: number;
  /** boundary edges that pair with exactly one coincident boundary edge: vertex splits of uv / normal seams */
  seamEdges: number;
  /** boundary edges left after welding seam splits: real holes */
  openEdges: number;
  firstOpen: string | null;
  /** edges shared by 3 or more polygons (after welding seam splits) */
  nonManifoldEdges: number;
  firstNonManifold: string | null;
  /** edges between neighbouring polygons wound in opposite directions */
  flippedEdges: number;
  firstFlipped: string | null;
  /** closed pieces (after welding) whose faces point inward (negative volume), cavity walls excepted */
  inwardPieces: number;
  firstInward: string | null;
  /** polygons with fewer than 3 points or no area */
  degenerate: number;
  firstDegenerate: string | null;
  /** a closed solid once the seam splits are welded */
  closedAfterWeld: boolean;
  /** connected pieces after welding seam splits */
  pieces: number;
  /** each prim's welded piece (-1 for empty prims), and whether that piece is a closed solid */
  primPiece: Int32Array;
  pieceClosed: Uint8Array;
}

export interface SolidReportOptions {
  /** the triangulation, when the caller has it */
  tri?: Triangulation;
  /** look for winding flips (a half-edge structure; default true) */
  flips?: boolean;
}

/** Whether the mesh is a closed solid, and why not (see the file comment). */
export function solidReport(g: Geometry, o: SolidReportOptions = {}): SolidReport {
  const E = buildEdges(g), P = g.P, np = g.numPoints;
  let polys = 0, degenerate = 0, firstDeg = -1;
  for (let p = 0; p < g.numPrims; p++) {
    if (!g.primClosed[p] || g.isPacked(p) || g.isSpline(p)) continue;
    polys++;
    if (g.primSize(p) < 3 || primArea(g, p) < 1e-14) { degenerate++; if (firstDeg < 0) firstDeg = p; }
  }
  // canonical point per position among the points of boundary edges (a seam split always leaves its coincident
  // copies on boundary edges; points elsewhere stay themselves)
  const b = g.bbox();
  const diag = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) || 1;
  const q = diag * 1e-7, canon = Int32Array.from({ length: np }, (_, i) => i), byPos = new Map<string, number>();
  const onBoundary = new Uint8Array(np);
  for (let e = 0; e < E.a.length; e++) if (E.count[e] === 1 && g.primClosed[E.firstPrim[e]]) { onBoundary[E.a[e]] = 1; onBoundary[E.b[e]] = 1; }
  for (let i = 0; i < np; i++) {
    if (!onBoundary[i]) continue;
    const k = `${Math.round(P[i * 3] / q)},${Math.round(P[i * 3 + 1] / q)},${Math.round(P[i * 3 + 2] / q)}`;
    const c = byPos.get(k);
    if (c === undefined) byPos.set(k, i); else canon[i] = c;
  }
  // boundary edges of polygons, grouped by their welded end points
  let boundary = 0, rawNonManifold = 0, firstNM = -1;
  const groups = new Map<string, number[]>();
  for (let e = 0; e < E.a.length; e++) {
    if (!g.primClosed[E.firstPrim[e]]) continue;
    if (E.count[e] > 2) { rawNonManifold++; if (firstNM < 0) firstNM = e; continue; }
    if (E.count[e] !== 1) continue;
    boundary++;
    const ca = canon[E.a[e]], cb = canon[E.b[e]];
    if (ca === cb) continue;
    const k = ca < cb ? `${ca},${cb}` : `${cb},${ca}`;
    let l = groups.get(k);
    if (!l) groups.set(k, (l = []));
    l.push(e);
  }
  let seam = 0, open = 0, firstOpen = -1, nonManifold = rawNonManifold;
  for (const l of groups.values()) {
    if (l.length === 2) seam += 2;
    else if (l.length === 1) { open++; if (firstOpen < 0 || l[0] < firstOpen) firstOpen = l[0]; }
    else { nonManifold += 1; if (firstNM < 0) firstNM = l[0]; }
  }
  // winding flips (as the points are: a seam split separates the two sides anyway)
  const he = o.flips === false ? null : halfEdges(g);
  let firstFlip = -1;
  if (he) for (const e of he.flippedEdges) { if (firstFlip < 0 || e < firstFlip) firstFlip = e; }
  // welded pieces: union of canonical points along polygons
  const parent = Int32Array.from({ length: np }, (_, i) => i);
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let p = 0; p < g.numPrims; p++) {
    const s = g.primStart[p], e = g.primStart[p + 1];
    if (e - s < 1) continue;
    const r0 = find(canon[g.vertexPoint[s]]);
    for (let v = s + 1; v < e; v++) { const r = find(canon[g.vertexPoint[v]]); if (r !== r0) parent[r] = r0; }
  }
  const pieceOf = new Map<number, number>();
  const primPiece = new Int32Array(g.numPrims).fill(-1);
  for (let p = 0; p < g.numPrims; p++) {
    if (g.primStart[p + 1] === g.primStart[p]) continue;
    const r = find(canon[g.vertexPoint[g.primStart[p]]]);
    let k = pieceOf.get(r);
    if (k === undefined) pieceOf.set(r, (k = pieceOf.size));
    primPiece[p] = k;
  }
  // per welded piece: open after welding?, signed volume, bbox
  const n = pieceOf.size;
  const openPiece = new Uint8Array(n), vol = new Float64Array(n), mn = new Float64Array(n * 3).fill(Infinity), mx = new Float64Array(n * 3).fill(-Infinity);
  for (const l of groups.values()) if (l.length !== 2) for (const e of l) openPiece[primPiece[E.firstPrim[e]]] = 1;
  for (let e = 0; e < E.a.length; e++) if (E.count[e] > 2 && g.primClosed[E.firstPrim[e]]) openPiece[primPiece[E.firstPrim[e]]] = 1;
  for (let p = 0; p < g.numPrims; p++) if (!g.primClosed[p] && primPiece[p] >= 0) openPiece[primPiece[p]] = 1;
  const { tris, triPrim } = o.tri ?? triangulate(g);
  for (let t = 0; t < tris.length; t += 3) {
    const k = primPiece[triPrim[t / 3]];
    if (k < 0) continue;
    const a = g.vertexPoint[tris[t]] * 3, c1 = g.vertexPoint[tris[t + 1]] * 3, c2 = g.vertexPoint[tris[t + 2]] * 3;
    vol[k] += (P[a] * (P[c1 + 1] * P[c2 + 2] - P[c1 + 2] * P[c2 + 1]) - P[a + 1] * (P[c1] * P[c2 + 2] - P[c1 + 2] * P[c2]) + P[a + 2] * (P[c1] * P[c2 + 1] - P[c1 + 1] * P[c2])) / 6;
    for (const i of [a, c1, c2]) for (let d = 0; d < 3; d++) { mn[k * 3 + d] = Math.min(mn[k * 3 + d], P[i + d]); mx[k * 3 + d] = Math.max(mx[k * 3 + d], P[i + d]); }
  }
  let inward = 0, firstInwardPrim = -1;
  for (let k = 0; k < n; k++) {
    if (openPiece[k] || !(vol[k] < 0)) continue;
    // the wall of a cavity: inside the bbox of a larger outward-facing closed piece
    let cavity = false;
    for (let j = 0; j < n && !cavity; j++) {
      if (j === k || openPiece[j] || !(vol[j] > -vol[k])) continue;
      cavity = [0, 1, 2].every((d) => mn[j * 3 + d] <= mn[k * 3 + d] && mx[j * 3 + d] >= mx[k * 3 + d]);
    }
    if (cavity) continue;
    inward++;
    if (firstInwardPrim < 0) firstInwardPrim = primPiece.indexOf(k);
  }
  const fe = (e: number) => (e < 0 ? null : edgeWhere(g, E.a[e], E.b[e], E.firstPrim[e]));
  const fl = (e: number) => {
    if (e < 0 || !he) return null;
    const faces = he.edgeFaces(e);
    return edgeWhere(g, he.edgeA[e], he.edgeB[e], faces[0] ?? -1);
  };
  const pieceClosed = new Uint8Array(n);
  for (let k = 0; k < n; k++) pieceClosed[k] = openPiece[k] ? 0 : 1;
  return {
    polys, closed: polys > 0 && boundary === 0 && rawNonManifold === 0,
    boundaryEdges: boundary, seamEdges: seam, openEdges: open, firstOpen: fe(firstOpen),
    nonManifoldEdges: nonManifold, firstNonManifold: fe(firstNM),
    flippedEdges: he ? he.flippedEdges.size : 0, firstFlipped: fl(firstFlip),
    inwardPieces: inward, firstInward: firstInwardPrim >= 0 ? primWhere(g, firstInwardPrim) : null,
    degenerate, firstDegenerate: firstDeg >= 0 ? primWhere(g, firstDeg) : null,
    closedAfterWeld: polys > 0 && open === 0 && nonManifold === 0,
    pieces: n, primPiece, pieceClosed,
  };
}

/** "N open edges (after welding seam splits)", with the seam splits said when there are any. */
export function openEdgesText(r: SolidReport): string {
  const seams = r.seamEdges ? `; ${r.seamEdges} boundary edges are uv/normal seam splits` : '';
  return `${r.openEdges} open edge${r.openEdges === 1 ? '' : 's'} (after welding seam splits${seams})`;
}

/**
 * Why a mesh is not a closed solid, one line per cause with the count, where the first one is and the fix; [] when
 * it is one (after welding seam splits).
 */
export function solidCauses(r: SolidReport): string[] {
  const out: string[] = [];
  if (!r.polys) return ['no polygons: solid operations need a closed polygon mesh'];
  if (r.openEdges) out.push(`${openEdgesText(r)}, first ${r.firstOpen}: fill_holes or fuse (weld points), or cap the open ends`);
  if (r.nonManifoldEdges) out.push(`${r.nonManifoldEdges} non-manifold edge${r.nonManifoldEdges === 1 ? '' : 's'} (shared by 3+ polygons), first ${r.firstNonManifold}: separate the touching parts (boolean union) or remove the duplicate faces (clean)`);
  if (r.flippedEdges) out.push(`${r.flippedEdges} edge${r.flippedEdges === 1 ? '' : 's'} with inconsistent winding between neighbouring polygons (flipped faces), first ${r.firstFlipped}: clean with fix_winding, or reverse the flipped part`);
  if (r.inwardPieces) out.push(`${r.inwardPieces} closed piece${r.inwardPieces === 1 ? '' : 's'} facing inward, first ${r.firstInward}: reverse it`);
  if (r.degenerate) out.push(`${r.degenerate} degenerate face${r.degenerate === 1 ? '' : 's'} (no area), first ${r.firstDegenerate}: clean (remove degenerate) or mesh_repair`);
  return out;
}
