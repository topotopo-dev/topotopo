// Mesh repair (the mesh_repair node): diagnose and fix polygon meshes. Steps, in order, each optional:
//   1. fuse points closer than a tolerance
//   2. degenerate faces: repeated points are dropped from polygons, polygons with < 3 distinct points removed;
//      zero-area triangles (three collinear points) are removed and their middle point is inserted into the
//      neighbour across their long side, so a closed mesh stays closed (no slit is left behind)
//   3. duplicate faces (same point set, either winding) removed
//   4. non-manifold edges (> 2 faces): keep, remove the extra faces, or split. Faces around such an edge are
//      sorted by angle and paired with an angular neighbour of opposite direction that encloses material with
//      them; split then duplicates every point whose corners fall into several fans (also bowtie points), so
//      each fan is manifold. remove keeps the first pair and deletes the other faces.
//   5. winding: orientation is propagated across manifold edges (BFS per piece); each piece keeps the
//      orientation most of its area already had
//   6. small holes: boundary loops with at most max_hole_edges edges are ear-clipped (no new points); the caps
//      take the attributes of the neighbouring faces and go to prim group "filled"
//   7. outward: closed pieces with negative signed volume are flipped
//   8. self-intersections (optional): triangle pairs that cross (sharing no edge) are found through a BVH;
//      report puts their faces in prim group "self_intersecting", remove_faces deletes them and fills the holes
//   9. points no prim uses are removed
import earcut from 'earcut';
import { GeoBuilder } from './geometry.ts';
import type { Geometry, Src } from './geometry.ts';
import { EDGE_KEY_LIMIT } from './edges.ts';
import { topologyReport } from './topology.ts';
import { ClosestBVH } from './remesh.ts';

export type NonManifoldMode = 'keep' | 'remove' | 'split';
export type SelfIntersectMode = 'off' | 'report' | 'remove_faces';

export interface RepairOptions {
  fuse: boolean;
  tolerance: number;
  degenerate: boolean;
  duplicates: boolean;
  nonManifold: NonManifoldMode;
  winding: boolean;
  outward: boolean;
  fillHoles: boolean;
  /** 0 = any size */
  maxHoleEdges: number;
  isolated: boolean;
  selfIntersections: SelfIntersectMode;
}

export interface RepairReport {
  input: TopoSummary;
  output: TopoSummary;
  fused_points: number;
  degenerate_faces: number;
  slivers_merged: number;
  duplicate_faces: number;
  non_manifold_edges: number;
  non_manifold_faces_removed: number;
  split_points: number;
  flipped_faces: number;
  flipped_pieces: number;
  holes_filled: number;
  holes_left: number;
  self_intersecting_faces: number;
  self_intersecting_removed: number;
  isolated_points: number;
}

export interface TopoSummary { points: number; prims: number; boundary_edges: number; non_manifold_edges: number; degenerate: number; pieces: number; closed: boolean }

function summary(g: Geometry): TopoSummary {
  const r = topologyReport(g);
  return { points: g.numPoints, prims: g.numPrims, boundary_edges: r.boundaryEdges, non_manifold_edges: r.nonManifoldEdges, degenerate: r.degenerate, pieces: r.pieces, closed: r.closed };
}

interface Poly {
  pts: number[];
  vtx: Src[];
  prim: number;
  closed: boolean;
  dead: boolean;
  filled: boolean;
}

const ekey = (a: number, b: number) => (a < b ? a * EDGE_KEY_LIMIT + b : b * EDGE_KEY_LIMIT + a);

/** Linear blend of two provenance records. */
function mixSrc(a: Src, b: Src, t: number): Src {
  const acc = new Map<number, number>();
  const add = (s: Src, w: number) => {
    if (s === null || s === undefined) return;
    if (typeof s === 'number') { if (s >= 0) acc.set(s, (acc.get(s) ?? 0) + w); return; }
    for (let k = 0; k < s.i.length; k++) acc.set(s.i[k], (acc.get(s.i[k]) ?? 0) + s.w[k] * w);
  };
  add(a, 1 - t); add(b, t);
  return { i: [...acc.keys()], w: [...acc.values()] };
}

class Repair {
  g: Geometry;
  P: Float64Array;
  /** working point → source point (split copies share their source) */
  ptSrc: number[];
  polys: Poly[] = [];
  rep: RepairReport;
  areaEps: number;

  constructor(g: Geometry) {
    this.g = g;
    this.P = g.P;
    this.ptSrc = Array.from({ length: g.numPoints }, (_, i) => i);
    for (let p = 0; p < g.numPrims; p++) {
      const pts: number[] = [], vtx: Src[] = [];
      for (let v = g.primStart[p]; v < g.primStart[p + 1]; v++) { pts.push(g.vertexPoint[v]); vtx.push(v); }
      this.polys.push({ pts, vtx, prim: p, closed: !!g.primClosed[p], dead: false, filled: false });
    }
    const bb = g.bbox(), diag = Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) || 1;
    this.areaEps = (diag * 1e-7) ** 2;
    const s = summary(g);
    this.rep = {
      input: s, output: s, fused_points: 0, degenerate_faces: 0, slivers_merged: 0, duplicate_faces: 0, non_manifold_edges: 0,
      non_manifold_faces_removed: 0, split_points: 0, flipped_faces: 0, flipped_pieces: 0, holes_filled: 0, holes_left: 0,
      self_intersecting_faces: 0, self_intersecting_removed: 0, isolated_points: 0,
    };
  }

  pos(i: number): [number, number, number] {
    const s = this.ptSrc[i] * 3, P = this.P;
    return [P[s], P[s + 1], P[s + 2]];
  }

  /** Alive closed polygons with >= 3 corners (the ones repair works on). */
  faces(): number[] {
    const out: number[] = [];
    this.polys.forEach((q, i) => { if (!q.dead && q.closed && q.pts.length >= 3) out.push(i); });
    return out;
  }

  newell(pts: number[]): [number, number, number] {
    let nx = 0, ny = 0, nz = 0;
    for (let k = 0; k < pts.length; k++) {
      const a = this.pos(pts[k]), b = this.pos(pts[(k + 1) % pts.length]);
      nx += (a[1] - b[1]) * (a[2] + b[2]);
      ny += (a[2] - b[2]) * (a[0] + b[0]);
      nz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    return [nx, ny, nz];
  }

  area(pts: number[]) { const n = this.newell(pts); return Math.hypot(n[0], n[1], n[2]) / 2; }

  /** Sides of alive faces per undirected edge: flat [poly, k, poly, k, ...] (side k runs pts[k] → pts[k + 1]). */
  sides(): Map<number, number[]> {
    const m = new Map<number, number[]>();
    for (const f of this.faces()) {
      const q = this.polys[f].pts, n = q.length;
      for (let k = 0; k < n; k++) {
        const a = q[k], b = q[(k + 1) % n];
        if (a === b) continue;
        const key = ekey(a, b);
        let l = m.get(key);
        if (!l) { l = []; m.set(key, l); }
        l.push(f, k);
      }
    }
    return m;
  }

  /** Reverse the winding, keeping the first corner (Houdini convention). */
  reverse(q: Poly) {
    q.pts = [q.pts[0], ...q.pts.slice(1).reverse()];
    q.vtx = [q.vtx[0], ...q.vtx.slice(1).reverse()];
  }

  // ------------------------------------------------------------ 1. fuse

  fuse(tol: number) {
    const n = this.ptSrc.length, P = this.P, repr = new Int32Array(n);
    for (let i = 0; i < n; i++) repr[i] = i;
    if (tol > 0) {
      const cell = tol, grid = new Map<string, number[]>();
      for (let i = 0; i < n; i++) {
        const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
        const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
        let found = -1;
        for (let dx = -1; dx <= 1 && found < 0; dx++)
          for (let dy = -1; dy <= 1 && found < 0; dy++)
            for (let dz = -1; dz <= 1 && found < 0; dz++) {
              const l = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
              if (l) for (const j of l) if (Math.hypot(P[j * 3] - x, P[j * 3 + 1] - y, P[j * 3 + 2] - z) <= tol) { found = j; break; }
            }
        if (found >= 0) repr[i] = found;
        else { const k = `${cx},${cy},${cz}`; const l = grid.get(k); if (l) l.push(i); else grid.set(k, [i]); }
      }
    } else {
      const seen = new Map<string, number>();
      for (let i = 0; i < n; i++) {
        const k = `${P[i * 3]},${P[i * 3 + 1]},${P[i * 3 + 2]}`;
        const j = seen.get(k);
        if (j === undefined) seen.set(k, i); else repr[i] = j;
      }
    }
    // only points used by prims count as fused (unused duplicates are dropped as isolated points)
    const used = new Uint8Array(n);
    for (const q of this.polys) if (!q.dead) for (const p of q.pts) used[p] = 1;
    for (let i = 0; i < n; i++) if (repr[i] !== i && used[i]) this.rep.fused_points++;
    for (const q of this.polys) q.pts = q.pts.map((p) => repr[p]);
  }

  // ------------------------------------------------------------ 2. degenerate faces

  degenerate() {
    for (const q of this.polys) {
      if (q.dead || !q.closed) continue;
      const pts: number[] = [], vtx: Src[] = [];
      for (let k = 0; k < q.pts.length; k++) {
        if (pts.length && pts[pts.length - 1] === q.pts[k]) continue;
        pts.push(q.pts[k]); vtx.push(q.vtx[k]);
      }
      while (pts.length > 1 && pts[0] === pts[pts.length - 1]) { pts.pop(); vtx.pop(); }
      q.pts = pts; q.vtx = vtx;
      if (pts.length < 3) { q.dead = true; this.rep.degenerate_faces++; }
    }
    // zero-area polygons; triangles hand their middle point to the neighbour across their long side
    const side = this.sides();
    const drop = (f: number) => {
      const q = this.polys[f], n = q.pts.length;
      for (let k = 0; k < n; k++) {
        const l = side.get(ekey(q.pts[k], q.pts[(k + 1) % n]));
        if (!l) continue;
        for (let i = 0; i < l.length; i += 2) if (l[i] === f) { l.splice(i, 2); break; }
      }
      q.dead = true;
    };
    for (const f of this.faces()) {
      const q = this.polys[f];
      if (q.dead || this.area(q.pts) >= this.areaEps) continue;
      this.rep.degenerate_faces++;
      if (q.pts.length !== 3) { drop(f); continue; }
      // longest side (a, c); b is the middle point
      let best = -1, bl = -1;
      for (let k = 0; k < 3; k++) {
        const a = this.pos(q.pts[k]), c = this.pos(q.pts[(k + 1) % 3]);
        const l = Math.hypot(a[0] - c[0], a[1] - c[1], a[2] - c[2]);
        if (l > bl) { bl = l; best = k; }
      }
      const a = q.pts[best], c = q.pts[(best + 1) % 3], b = q.pts[(best + 2) % 3];
      const l = (side.get(ekey(a, c)) ?? []).filter((_, i, arr) => i % 2 === 0 && arr[i] !== f);
      drop(f);
      if (l.length !== 1 || !(bl > 0)) continue;
      const F = this.polys[l[0]], n = F.pts.length;
      let k = -1;
      for (let j = 0; j < n; j++) { const x = F.pts[j], y = F.pts[(j + 1) % n]; if ((x === a && y === c) || (x === c && y === a)) { k = j; break; } }
      if (k < 0) continue;
      const x = F.pts[k], y = F.pts[(k + 1) % n], px = this.pos(x), pb = this.pos(b);
      const t = Math.min(1, Math.max(0, Math.hypot(pb[0] - px[0], pb[1] - px[1], pb[2] - px[2]) / bl));
      const at = k + 1;
      F.pts.splice(at, 0, b);
      F.vtx.splice(at, 0, mixSrc(F.vtx[k], F.vtx[(k + 1) % n], t));
      // update the side lists of F: {x, y} → {x, b}, {b, y}
      const lxy = side.get(ekey(x, y));
      if (lxy) for (let i = 0; i < lxy.length; i += 2) if (lxy[i] === l[0]) { lxy.splice(i, 2); break; }
      for (const [u, w] of [[x, b], [b, y]]) {
        const key = ekey(u, w);
        let lst = side.get(key);
        if (!lst) { lst = []; side.set(key, lst); }
        lst.push(l[0], -1); // side index is not needed here any more
      }
      this.rep.slivers_merged++;
    }
  }

  // ------------------------------------------------------------ 3. duplicates

  duplicates() {
    const seen = new Set<string>();
    for (const f of this.faces()) {
      const q = this.polys[f];
      const k = q.pts.slice().sort((x, y) => x - y).join(',');
      if (seen.has(k)) { q.dead = true; this.rep.duplicate_faces++; } else seen.add(k);
    }
  }

  // ------------------------------------------------------------ 4. non-manifold edges

  /**
   * Pair the sides around a non-manifold edge (flat [poly, k, ...]): sorted by angle around the edge, each side is
   * paired with an angular neighbour running the other way, choosing the offset whose pairs enclose material
   * (both normals point away from the wedge between them). Returns index pairs into the side list.
   */
  pairSides(a: number, b: number, l: number[]): [number, number][] {
    const n = l.length / 2;
    const pa = this.pos(a), pb = this.pos(b);
    let dx = pb[0] - pa[0], dy = pb[1] - pa[1], dz = pb[2] - pa[2];
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl; dy /= dl; dz /= dl;
    // reference direction perpendicular to the edge
    const ax = Math.abs(dx) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    let rx = ax[1] * dz - ax[2] * dy, ry = ax[2] * dx - ax[0] * dz, rz = ax[0] * dy - ax[1] * dx;
    const rl = Math.hypot(rx, ry, rz) || 1;
    rx /= rl; ry /= rl; rz /= rl;
    const sx = dy * rz - dz * ry, sy = dz * rx - dx * rz, sz = dx * ry - dy * rx; // d × r
    const info = [] as { i: number; ang: number; dir: number; up: boolean }[];
    for (let i = 0; i < n; i++) {
      const q = this.polys[l[i * 2]], k = l[i * 2 + 1], m = q.pts.length;
      // centroid of the face as its wing
      let cx = 0, cy = 0, cz = 0;
      for (const p of q.pts) { const x = this.pos(p); cx += x[0]; cy += x[1]; cz += x[2]; }
      cx = cx / m - pa[0]; cy = cy / m - pa[1]; cz = cz / m - pa[2];
      const along = cx * dx + cy * dy + cz * dz;
      const wx = cx - dx * along, wy = cy - dy * along, wz = cz - dz * along;
      const ang = Math.atan2(wx * sx + wy * sy + wz * sz, wx * rx + wy * ry + wz * rz);
      // tangent of increasing angle at the wing: d × w
      const tx = dy * wz - dz * wy, ty = dz * wx - dx * wz, tz = dx * wy - dy * wx;
      const nrm = this.newell(q.pts);
      const dir = q.pts[k] === a ? 1 : -1;
      info.push({ i, ang, dir, up: nrm[0] * tx + nrm[1] * ty + nrm[2] * tz > 0 });
    }
    info.sort((x, y) => x.ang - y.ang || x.i - y.i);
    let best: [number, number][] = [], bestScore = -1;
    for (let off = 0; off < 2; off++) {
      const pairs: [number, number][] = [];
      let score = 0;
      for (let j = off; j + 1 < n + off && pairs.length < Math.floor(n / 2); j += 2) {
        const s1 = info[j % n], s2 = info[(j + 1) % n];
        if (s1.dir === s2.dir) continue;
        pairs.push([s1.i, s2.i]);
        score += 2;
        // material between s1 (lower angle) and s2: s1's normal points down, s2's up
        if (!s1.up && s2.up) score += 1;
      }
      if (score > bestScore) { bestScore = score; best = pairs; }
    }
    return best;
  }

  nonManifold(mode: NonManifoldMode) {
    const side = this.sides();
    const pairsOf = new Map<number, [number, number][]>();
    for (const [key, l] of side) {
      if (l.length <= 4) continue;
      this.rep.non_manifold_edges++;
      if (mode === 'keep') continue;
      const a = Math.floor(key / EDGE_KEY_LIMIT), b = key - a * EDGE_KEY_LIMIT;
      pairsOf.set(key, this.pairSides(a, b, l));
    }
    if (mode === 'keep' || !pairsOf.size) {
      if (mode === 'split') this.splitFans(side, pairsOf);
      return;
    }
    if (mode === 'remove') {
      for (const [key, pairs] of pairsOf) {
        const l = side.get(key)!, keepI = new Set<number>(pairs.length ? pairs[0] : [0, 1]);
        for (let i = 0; i < l.length / 2; i++) {
          const q = this.polys[l[i * 2]];
          if (keepI.has(i) || q.dead) continue;
          q.dead = true;
          this.rep.non_manifold_faces_removed++;
        }
      }
      return;
    }
    this.splitFans(side, pairsOf);
  }

  /** Give every fan of corners around a point its own point (fans connect across 2-sided edges and paired sides). */
  splitFans(side: Map<number, number[]>, pairsOf: Map<number, [number, number][]>) {
    const faces = this.faces(), base = new Map<number, number>();
    let nc = 0;
    for (const f of faces) { base.set(f, nc); nc += this.polys[f].pts.length; }
    const parent = new Int32Array(nc);
    for (let i = 0; i < nc; i++) parent[i] = i;
    const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const join = (x: number, y: number) => { const a = find(x), b = find(y); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); };
    const corner = (f: number, k: number, p: number) => {
      const q = this.polys[f], n = q.pts.length;
      return base.get(f)! + (q.pts[k] === p ? k : (k + 1) % n);
    };
    const link = (f1: number, k1: number, f2: number, k2: number) => {
      const q = this.polys[f1], a = q.pts[k1], b = q.pts[(k1 + 1) % q.pts.length];
      join(corner(f1, k1, a), corner(f2, k2, a));
      join(corner(f1, k1, b), corner(f2, k2, b));
    };
    for (const [key, l] of side) {
      if (l.length === 4) { link(l[0], l[1], l[2], l[3]); continue; }
      const pairs = pairsOf.get(key);
      if (pairs) for (const [i, j] of pairs) link(l[i * 2], l[i * 2 + 1], l[j * 2], l[j * 2 + 1]);
    }
    // per point: the first fan (lowest corner) keeps the point, every other fan gets a copy
    const fanPoint = new Map<number, number>(), firstRoot = new Map<number, number>();
    for (const f of faces) {
      const q = this.polys[f];
      for (let k = 0; k < q.pts.length; k++) {
        const p = q.pts[k], root = find(base.get(f)! + k);
        if (!firstRoot.has(p)) { firstRoot.set(p, root); fanPoint.set(root, p); }
        let np = fanPoint.get(root);
        if (np === undefined) {
          np = this.ptSrc.length;
          this.ptSrc.push(this.ptSrc[p]);
          fanPoint.set(root, np);
          this.rep.split_points++;
        }
        q.pts[k] = np;
      }
    }
  }

  // ------------------------------------------------------------ 5. winding

  /** Faces in pieces connected across 2-sided edges: piece id per face index (-1 for others). */
  pieces(side: Map<number, number[]>): { piece: Map<number, number>; adj: Map<number, number[]>; count: number } {
    const adj = new Map<number, number[]>();
    for (const f of this.faces()) adj.set(f, []);
    for (const [, l] of side) {
      if (l.length !== 4) continue;
      adj.get(l[0])!.push(l[2], l[1], l[3]);
      adj.get(l[2])!.push(l[0], l[3], l[1]);
    }
    const piece = new Map<number, number>();
    let count = 0;
    for (const f of this.faces()) {
      if (piece.has(f)) continue;
      const st = [f];
      piece.set(f, count);
      while (st.length) {
        const x = st.pop()!;
        const a = adj.get(x)!;
        for (let i = 0; i < a.length; i += 3) if (!piece.has(a[i])) { piece.set(a[i], count); st.push(a[i]); }
      }
      count++;
    }
    return { piece, adj, count };
  }

  winding() {
    const side = this.sides();
    const { adj } = this.pieces(side);
    const flip = new Map<number, number>();
    for (const f of this.faces()) {
      if (flip.has(f)) continue;
      const comp: number[] = [f];
      flip.set(f, 0);
      for (let qi = 0; qi < comp.length; qi++) {
        const x = comp[qi], fx = flip.get(x)!, a = adj.get(x)!;
        for (let i = 0; i < a.length; i += 3) {
          const y = a[i], kx = a[i + 1], ky = a[i + 2];
          if (flip.has(y)) continue;
          // consistent when the shared edge runs opposite ways in the two faces (after x's own flip)
          const px = this.polys[x].pts, py = this.polys[y].pts;
          const sameDir = px[kx] === py[ky];
          flip.set(y, sameDir ? 1 - fx : fx);
          comp.push(y);
        }
      }
      // keep the orientation most of the piece's area already has
      let keepA = 0, flipA = 0;
      for (const x of comp) { const ar = this.area(this.polys[x].pts); if (flip.get(x)) flipA += ar; else keepA += ar; }
      const invert = flipA > keepA;
      for (const x of comp) {
        const fl = flip.get(x)! ^ (invert ? 1 : 0);
        if (fl) { this.reverse(this.polys[x]); this.rep.flipped_faces++; }
      }
    }
  }

  // ------------------------------------------------------------ 6. holes

  /** Closed boundary loops as [point, provenance of the neighbouring corner, its poly] lists, in cap orientation. */
  boundaryLoops(): { pts: number[]; vtx: Src[]; prim: number }[] {
    const side = this.sides();
    // cap edges b → a for every boundary side a → b
    const next = new Map<number, { to: number; vtx: Src; prim: number; used: boolean }[]>();
    for (const [, l] of side) {
      if (l.length !== 2) continue;
      const q = this.polys[l[0]], k = l[1], n = q.pts.length;
      const a = q.pts[k], b = q.pts[(k + 1) % n];
      let lst = next.get(b);
      if (!lst) { lst = []; next.set(b, lst); }
      lst.push({ to: a, vtx: q.vtx[(k + 1) % n], prim: q.prim, used: false });
    }
    const loops: { pts: number[]; vtx: Src[]; prim: number }[] = [];
    const starts = [...next.keys()].sort((x, y) => x - y);
    for (const s of starts) {
      for (const e0 of next.get(s)!) {
        if (e0.used) continue;
        const pts = [s], vtx: Src[] = [e0.vtx];
        e0.used = true;
        let cur = e0.to, ok = false;
        for (let guard = 0; guard < 1e6; guard++) {
          if (cur === s) { ok = true; break; }
          const cand = next.get(cur)?.find((e) => !e.used);
          if (!cand) break;
          cand.used = true;
          pts.push(cur); vtx.push(cand.vtx);
          cur = cand.to;
        }
        if (ok && pts.length >= 3) loops.push({ pts, vtx, prim: e0.prim });
      }
    }
    return loops;
  }

  /** Ear-clip a loop into triangles (indices into the loop), facing like the loop's Newell normal. */
  capTriangles(pts: number[]): number[][] {
    if (pts.length === 3) return [[0, 1, 2]];
    const n = this.newell(pts), ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
    const [u, w] = ax >= ay && ax >= az ? [1, 2] : ay >= az ? [2, 0] : [0, 1];
    const flat: number[] = [];
    for (const p of pts) { const x = this.pos(p); flat.push(x[u], x[w]); }
    const idx = earcut(flat);
    const out: number[][] = [];
    for (let i = 0; i < idx.length; i += 3) {
      let t = [idx[i], idx[i + 1], idx[i + 2]];
      const tn = this.newell(t.map((j) => pts[j]));
      if (tn[0] * n[0] + tn[1] * n[1] + tn[2] * n[2] < 0) t = [t[0], t[2], t[1]];
      out.push(t);
    }
    if (!out.length) for (let k = 1; k < pts.length - 1; k++) out.push([0, k, k + 1]);
    return out;
  }

  fillHoles(maxEdges: number, touching: Set<number> | null) {
    for (const loop of this.boundaryLoops()) {
      const wanted = touching ? loop.pts.some((p) => touching.has(p)) : !maxEdges || loop.pts.length <= maxEdges;
      if (!wanted || this.area(loop.pts) < this.areaEps) { if (!touching) this.rep.holes_left++; continue; }
      for (const t of this.capTriangles(loop.pts)) {
        this.polys.push({ pts: t.map((j) => loop.pts[j]), vtx: t.map((j) => loop.vtx[j]), prim: loop.prim, closed: true, dead: false, filled: true });
      }
      this.rep.holes_filled++;
    }
  }

  // ------------------------------------------------------------ 7. outward

  outward() {
    const side = this.sides();
    const { piece, count } = this.pieces(side);
    const closed = new Array(count).fill(true);
    for (const [, l] of side) if (l.length !== 4) for (let i = 0; i < l.length; i += 2) { const pc = piece.get(l[i]); if (pc !== undefined) closed[pc] = false; }
    const members: number[][] = Array.from({ length: count }, () => []);
    for (const [f, pc] of piece) members[pc].push(f);
    for (let pc = 0; pc < count; pc++) {
      if (!closed[pc]) continue;
      // signed volume around the piece's centroid
      let cx = 0, cy = 0, cz = 0, n = 0;
      for (const f of members[pc]) for (const p of this.polys[f].pts) { const x = this.pos(p); cx += x[0]; cy += x[1]; cz += x[2]; n++; }
      cx /= n; cy /= n; cz /= n;
      let vol = 0;
      for (const f of members[pc]) {
        const q = this.polys[f].pts, a = this.pos(q[0]);
        for (let k = 1; k + 1 < q.length; k++) {
          const b = this.pos(q[k]), c = this.pos(q[k + 1]);
          const ax = a[0] - cx, ay = a[1] - cy, az = a[2] - cz, bx = b[0] - cx, by = b[1] - cy, bz = b[2] - cz, qx = c[0] - cx, qy = c[1] - cy, qz = c[2] - cz;
          vol += ax * (by * qz - bz * qy) - ay * (bx * qz - bz * qx) + az * (bx * qy - by * qx);
        }
      }
      if (vol < 0) {
        for (const f of members[pc]) this.reverse(this.polys[f]);
        this.rep.flipped_pieces++;
      }
    }
  }

  // ------------------------------------------------------------ 8. self-intersections

  selfIntersections(): Set<number> {
    const tri: number[] = [], triFace: number[] = [], triPts: number[] = [];
    for (const f of this.faces()) {
      const q = this.polys[f].pts;
      for (let k = 1; k + 1 < q.length; k++) {
        for (const p of [q[0], q[k], q[k + 1]]) { tri.push(...this.pos(p)); triPts.push(p); }
        triFace.push(f);
      }
    }
    const nt = triFace.length, T = Float64Array.from(tri), bvh = new ClosestBVH(T, 3);
    const hit = new Set<number>(), cand: number[] = [];
    for (let i = 0; i < nt; i++) {
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (let k = 0; k < 3; k++) {
        const x = T[i * 9 + k * 3], y = T[i * 9 + k * 3 + 1], z = T[i * 9 + k * 3 + 2];
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
      }
      cand.length = 0;
      bvh.overlapping(x0, y0, z0, x1, y1, z1, cand);
      for (const j of cand) {
        if (j <= i || triFace[j] === triFace[i]) continue;
        let shared = 0, sp = -1;
        for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) if (triPts[i * 3 + a] === triPts[j * 3 + b]) { shared++; sp = triPts[i * 3 + a]; }
        if (shared >= 2) continue;
        if (trianglesCross(T, i, j, shared ? this.pos(sp) : null)) { hit.add(triFace[i]); hit.add(triFace[j]); }
      }
    }
    return hit;
  }

  // ------------------------------------------------------------ output

  build(isolated: boolean, intersecting: Set<number> | null): Geometry {
    const g = this.g, b = new GeoBuilder(g);
    for (let i = 0; i < this.ptSrc.length; i++) b.copyPoint(this.ptSrc[i]);
    const filled = b.group('prim', 'filled');
    const self = intersecting ? b.group('prim', 'self_intersecting') : null;
    this.polys.forEach((q, f) => {
      if (q.dead) return;
      const id = b.addPrim(q.pts, q.closed, q.prim, q.vtx);
      if (q.filled) filled.add(id);
      if (self && intersecting!.has(f)) self.add(id);
    });
    let out = b.build();
    if (isolated && out.numPrims > 0) {
      const before = out.numPoints;
      out = out.removeUnusedPoints();
      this.rep.isolated_points = before - out.numPoints - this.rep.fused_points;
      if (this.rep.isolated_points < 0) this.rep.isolated_points = 0;
    }
    return out;
  }
}

const EPS = 1e-12;

/**
 * Do triangles i and j (9 floats each in T) cross? Tested as segment–triangle intersections of each triangle's sides
 * against the other triangle. When they share a point s, hits at s are ignored. Coplanar overlaps are not reported.
 */
function trianglesCross(T: Float64Array, i: number, j: number, s: [number, number, number] | null): boolean {
  for (const [p, q] of [[i, j], [j, i]]) {
    for (let k = 0; k < 3; k++) {
      const a = p * 9 + k * 3, b = p * 9 + ((k + 1) % 3) * 3;
      const h = segTri(T, a, b, q * 9);
      if (!h) continue;
      if (s && Math.hypot(h[0] - s[0], h[1] - s[1], h[2] - s[2]) <= 1e-9 * (1 + Math.abs(s[0]) + Math.abs(s[1]) + Math.abs(s[2]))) continue;
      return true;
    }
  }
  return false;
}

/** Segment T[a]..T[b] against triangle T[o..o+9] (Möller–Trumbore); the hit point or null. */
function segTri(T: Float64Array, a: number, b: number, o: number): [number, number, number] | null {
  const ox = T[a], oy = T[a + 1], oz = T[a + 2], dx = T[b] - ox, dy = T[b + 1] - oy, dz = T[b + 2] - oz;
  const e1x = T[o + 3] - T[o], e1y = T[o + 4] - T[o + 1], e1z = T[o + 5] - T[o + 2];
  const e2x = T[o + 6] - T[o], e2y = T[o + 7] - T[o + 1], e2z = T[o + 8] - T[o + 2];
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  const scale = Math.hypot(dx, dy, dz) * Math.hypot(e1x, e1y, e1z) * Math.hypot(e2x, e2y, e2z);
  if (Math.abs(det) <= 1e-9 * scale) return null;
  const inv = 1 / det, tx = ox - T[o], ty = oy - T[o + 1], tz = oz - T[o + 2];
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < -EPS || u > 1 + EPS) return null;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < -EPS || u + v > 1 + EPS) return null;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  if (t < -EPS || t > 1 + EPS) return null;
  return [ox + dx * t, oy + dy * t, oz + dz * t];
}

/** Run the repair steps on g (see the header). */
export function repairMesh(g: Geometry, o: RepairOptions): { geo: Geometry; report: RepairReport } {
  const r = new Repair(g);
  if (o.fuse) r.fuse(Math.max(0, o.tolerance));
  if (o.degenerate) r.degenerate();
  if (o.duplicates) r.duplicates();
  r.nonManifold(o.nonManifold);
  if (o.winding) r.winding();
  if (o.fillHoles) r.fillHoles(Math.max(0, o.maxHoleEdges), null);
  if (o.winding && o.outward) r.outward();
  let inter: Set<number> | null = null;
  if (o.selfIntersections !== 'off') {
    inter = r.selfIntersections();
    r.rep.self_intersecting_faces = inter.size;
    if (o.selfIntersections === 'remove_faces' && inter.size) {
      const touched = new Set<number>();
      for (const f of inter) { r.polys[f].dead = true; for (const p of r.polys[f].pts) touched.add(p); }
      r.rep.self_intersecting_removed = inter.size;
      r.fillHoles(0, touched);
      inter = null;
    }
  }
  const geo = r.build(o.isolated, o.selfIntersections === 'report' ? inter : null);
  r.rep.output = summary(geo);
  return { geo, report: r.rep };
}

/** One line naming what repairMesh changed or found ('' when the mesh was clean). */
export function repairSummary(rep: RepairReport): string {
  const parts: string[] = [];
  const add = (n: number, s: string) => { if (n) parts.push(`${n} ${s}`); };
  add(rep.fused_points, 'points fused');
  add(rep.degenerate_faces, 'degenerate faces removed');
  add(rep.slivers_merged, 'slivers merged into neighbours');
  add(rep.duplicate_faces, 'duplicate faces removed');
  add(rep.non_manifold_edges, 'non-manifold edges');
  add(rep.non_manifold_faces_removed, 'faces removed at non-manifold edges');
  add(rep.split_points, 'points split');
  add(rep.flipped_faces, 'faces flipped');
  add(rep.flipped_pieces, 'pieces turned outward');
  add(rep.holes_filled, 'holes filled');
  add(rep.holes_left, 'holes left open');
  add(rep.self_intersecting_faces, 'self-intersecting faces');
  add(rep.self_intersecting_removed, 'self-intersecting faces removed');
  add(rep.isolated_points, 'isolated points removed');
  return parts.join(', ');
}
