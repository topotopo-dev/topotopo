// Triangles back into polygons. Booleans and 2D fills come out of the mesh kernel as triangles; a face that was one
// polygon going in should be one polygon coming out, so bevels, insets and edge selections see the real edges and
// exports keep their triangle counts. Merging never moves a point and keeps every point a neighbour uses, so a
// watertight mesh stays watertight.
import type { Geometry } from './geometry.ts';

export interface MergeOptions {
  /** Neighbouring triangles join only while their normals agree to this cosine (default about 0.5°). */
  planarCos?: number;
}

/**
 * Merge edge-connected flat triangles with the same key (≥ 0) into polygons. A region whose outline is one loop becomes
 * one polygon. A region with holes is cut along straight diagonals between its own points, two per hole, into simple
 * polygons (the shortest pair of cuts, so the pieces stay well shaped). A region whose outline touches itself, or that
 * no clean cut splits, is grown into polygons triangle by triangle instead. Zero-area triangles join any neighbour.
 * Prims that are not triangles, or have key -1, are kept as they are. Prim attributes and groups come from the
 * region's first triangle; vertex attributes from the triangle that brought each corner.
 */
export function mergeTriangles(g: Geometry, key: ArrayLike<number>, o: MergeOptions = {}): Geometry {
  if (g.primKind) return g;
  const n = g.numPrims, vp = g.vertexPoint, ps = g.primStart, P = g.P;
  const cosTol = o.planarCos ?? 0.99996;
  const isTri = (t: number) => !!g.primClosed[t] && ps[t + 1] - ps[t] === 3 && key[t] >= 0;
  const nrm = new Float64Array(n * 3), area = new Float64Array(n);
  for (let t = 0; t < n; t++) {
    if (!isTri(t)) continue;
    const a = vp[ps[t]] * 3, b = vp[ps[t] + 1] * 3, c = vp[ps[t] + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const wx = P[c] - P[a], wy = P[c + 1] - P[a + 1], wz = P[c + 2] - P[a + 2];
    const x = uy * wz - uz * wy, y = uz * wx - ux * wz, z = ux * wy - uy * wx, l = Math.hypot(x, y, z);
    area[t] = l / 2;
    if (l > 0) { nrm[t * 3] = x / l; nrm[t * 3 + 1] = y / l; nrm[t * 3 + 2] = z / l; }
  }
  const np = g.numPoints;
  const hk = (a: number, b: number) => a * np + b;
  const half = new Map<number, number>();
  for (let t = 0; t < n; t++) {
    if (!isTri(t)) continue;
    for (let k = 0; k < 3; k++) half.set(hk(vp[ps[t] + k], vp[ps[t] + ((k + 1) % 3)]), t);
  }
  const flatWith = (t: number, u: number) =>
    area[t] === 0 || area[u] === 0 || nrm[t * 3] * nrm[u * 3] + nrm[t * 3 + 1] * nrm[u * 3 + 1] + nrm[t * 3 + 2] * nrm[u * 3 + 2] >= cosTol;
  // regions: same key, flat across the shared edge
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let t = 0; t < n; t++) {
    if (!isTri(t)) continue;
    for (let k = 0; k < 3; k++) {
      const u = half.get(hk(vp[ps[t] + ((k + 1) % 3)], vp[ps[t] + k]));
      if (u === undefined || u <= t || key[u] !== key[t] || !flatWith(t, u)) continue;
      const a = find(t), b = find(u);
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
    }
  }
  const members = new Map<number, number[]>();
  for (let t = 0; t < n; t++) if (isTri(t)) { const r = find(t); let l = members.get(r); if (!l) members.set(r, l = []); l.push(t); }
  const outPrims: number[] = [], outVerts: number[] = [], outStart: number[] = [0];
  const emit = (prim: number, verts: number[]) => { outPrims.push(prim); for (const v of verts) outVerts.push(v); outStart.push(outVerts.length); };
  for (let t = 0; t < n; t++) {
    if (!isTri(t)) { const vs: number[] = []; for (let v = ps[t]; v < ps[t + 1]; v++) vs.push(v); emit(t, vs); continue; }
    const tris = members.get(t);
    if (!tris) continue; // not the region's first triangle
    if (tris.length === 1) { emit(t, [ps[t], ps[t] + 1, ps[t] + 2]); continue; }
    for (const poly of regionPolygons(tris)) emit(t, poly);
  }
  if (outPrims.length === n) return g;
  const out = g.clone();
  out.prims = g.prims.gather(outPrims);
  out.vertices = g.vertices.gather(outVerts);
  out.primStart = Int32Array.from(outStart);
  out.vertexPoint = Int32Array.from(outVerts, (v) => vp[v]);
  out.primClosed = Uint8Array.from(outPrims, (p) => g.primClosed[p]);
  out.primGroups = new Map([...g.primGroups].map(([k, m]) => [k, Uint8Array.from(outPrims, (p) => m[p])]));
  out.vertexGroups = new Map([...g.vertexGroups].map(([k, m]) => [k, Uint8Array.from(outVerts, (v) => m[v])]));
  return out;

  /** Polygons (as source vertex lists) covering one flat region. */
  function regionPolygons(tris: number[]): number[][] {
    const inRegion = new Set(tris);
    // boundary half-edges a → b, with the source vertex of a in its triangle
    const next = new Map<number, number>(), vtxAt = new Map<number, number>();
    let pinched = false;
    for (const t of tris)
      for (let k = 0; k < 3; k++) {
        const a = vp[ps[t] + k], b = vp[ps[t] + ((k + 1) % 3)];
        const u = half.get(hk(b, a));
        if (u !== undefined && inRegion.has(u)) continue;
        if (next.has(a)) pinched = true;
        next.set(a, b); vtxAt.set(a, ps[t] + k);
      }
    if (!pinched) {
      const loops: number[][] = [], seen = new Set<number>();
      for (const s of next.keys()) {
        if (seen.has(s)) continue;
        const loop: number[] = [];
        for (let a = s; !seen.has(a); a = next.get(a)!) {
          seen.add(a); loop.push(a);
          if (!next.has(next.get(a)!)) { pinched = true; break; }
        }
        loops.push(loop);
      }
      if (!pinched && loops.length === 1) return [loops[0].map((a) => vtxAt.get(a)!)];
      if (!pinched) {
        const cut = cutHoles(loops, tris);
        if (cut) return cut.map((poly) => poly.map((a) => vtxAt.get(a)!));
      }
    }
    return grow(tris);
  }

  /** A region with holes cut into simple polygons along diagonals; null when it cannot be done cleanly. */
  function cutHoles(loops: number[][], tris: number[]): number[][] | null {
    // 2D frame in the region's plane
    let nx = 0, ny = 0, nz = 0;
    for (const t of tris) { nx += nrm[t * 3] * area[t]; ny += nrm[t * 3 + 1] * area[t]; nz += nrm[t * 3 + 2] * area[t]; }
    const l = Math.hypot(nx, ny, nz);
    if (!(l > 0)) return null;
    nx /= l; ny /= l; nz /= l;
    const ax = Math.abs(nx) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    let ux = ny * ax[2] - nz * ax[1], uy = nz * ax[0] - nx * ax[2], uz = nx * ax[1] - ny * ax[0];
    const ul = Math.hypot(ux, uy, uz); ux /= ul; uy /= ul; uz /= ul;
    const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;
    const xy = new Map<number, [number, number]>();
    for (const loop of loops)
      for (const a of loop) xy.set(a, [P[a * 3] * ux + P[a * 3 + 1] * uy + P[a * 3 + 2] * uz, P[a * 3] * vx + P[a * 3 + 1] * vy + P[a * 3 + 2] * vz]);
    const outer = loops.filter((q) => signedArea(q, xy) > 0);
    if (outer.length !== 1) return null;
    return splitHoles(xy, outer[0], loops.filter((q) => q !== outer[0]));
  }

  /** Fallback: polygons grown triangle by triangle while the outline stays one simple loop. */
  function grow(tris: number[]): number[][] {
    const free = new Set(tris), polys: number[][] = [];
    const corner = (t: number, pt: number) => (vp[ps[t]] === pt ? ps[t] : vp[ps[t] + 1] === pt ? ps[t] + 1 : ps[t] + 2);
    for (const seed of tris) {
      if (!free.has(seed)) continue;
      free.delete(seed);
      const pts = [vp[ps[seed]], vp[ps[seed] + 1], vp[ps[seed] + 2]], src = [ps[seed], ps[seed] + 1, ps[seed] + 2];
      const on = new Set(pts);
      for (let grew = true; grew;) {
        grew = false;
        for (let i = 0; i < pts.length; i++) {
          const m = pts.length, a = pts[i], b = pts[(i + 1) % m];
          const u = half.get(hk(b, a));
          if (u === undefined || !free.has(u)) continue;
          let c = -1;
          for (let k = 0; k < 3; k++) { const q = vp[ps[u] + k]; if (q !== a && q !== b) c = q; }
          if (c < 0) continue;
          if (!on.has(c)) { pts.splice(i + 1, 0, c); src.splice(i + 1, 0, corner(u, c)); on.add(c); }
          else if (m > 3 && pts[(i + 2) % m] === c) { const j = (i + 1) % m; pts.splice(j, 1); src.splice(j, 1); on.delete(b); i--; }
          else if (m > 3 && pts[(i - 1 + m) % m] === c) { pts.splice(i, 1); src.splice(i, 1); on.delete(a); i = Math.max(-1, i - 2); }
          else continue;
          free.delete(u); grew = true;
        }
      }
      polys.push(src);
    }
    return polys;
  }
}

function signedArea(loop: number[], xy: Map<number, [number, number]>): number {
  let a = 0;
  for (let i = 0; i < loop.length; i++) { const p = xy.get(loop[i])!, q = xy.get(loop[(i + 1) % loop.length])!; a += p[0] * q[1] - q[0] * p[1]; }
  return a / 2;
}

/**
 * Cut an outline (counter-clockwise) with holes (clockwise) into simple polygons over the same points: for one hole,
 * two diagonals from its two extreme points (along x or along y, whichever pair is shorter) to the nearest outline
 * points they reach without crossing anything split the shape in two; the other holes go with the piece they lie in,
 * and each piece is cut again. Null when no clean pair of cuts exists.
 */
export function splitHoles(xy: Map<number, [number, number]>, outer: number[], holes: number[][]): number[][] | null {
  if (!holes.length) return [outer];
  const edges: [number, number][] = [];
  for (const loop of [outer, ...holes]) for (let i = 0; i < loop.length; i++) edges.push([loop[i], loop[(i + 1) % loop.length]]);
  const at = (a: number) => xy.get(a)!;
  const inPoly = (pt: [number, number], loop: number[]) => {
    let inside = false;
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      const [xi, yi] = at(loop[i]), [xj, yj] = at(loop[j]);
      if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  const clear = (a: number, b: number) => {
    const A = at(a), B = at(b);
    for (const [c, d] of edges) {
      if (c === a || c === b || d === a || d === b) continue;
      if (segmentsMeet(A, B, at(c), at(d))) return false;
    }
    const mid: [number, number] = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
    return inPoly(mid, outer) && !holes.some((h) => inPoly(mid, h));
  };
  const reach = (h: number) => {
    const H = at(h);
    const order = outer.map((o, i) => ({ i, d: Math.hypot(at(o)[0] - H[0], at(o)[1] - H[1]) })).sort((x, y) => x.d - y.d);
    for (const { i, d } of order) if (clear(h, outer[i])) return { i, d };
    return null;
  };
  const walk = (loop: number[], from: number, to: number) => {
    const out: number[] = [];
    for (let i = from; ; i = (i + 1) % loop.length) { out.push(loop[i]); if (i === to) break; }
    return out;
  };
  for (let hi = 0; hi < holes.length; hi++) {
    const H = holes[hi];
    let best: { oL: number; oR: number; hL: number; hR: number; len: number } | null = null;
    for (const axis of [0, 1]) {
      let hL = 0, hR = 0;
      for (let k = 1; k < H.length; k++) {
        if (at(H[k])[axis] < at(H[hL])[axis]) hL = k;
        if (at(H[k])[axis] > at(H[hR])[axis]) hR = k;
      }
      if (hL === hR) continue;
      const L = reach(H[hL]), R = reach(H[hR]);
      if (!L || !R || L.i === R.i) continue;
      if (segmentsMeet(at(H[hL]), at(outer[L.i]), at(H[hR]), at(outer[R.i]))) continue;
      if (!best || L.d + R.d < best.len) best = { oL: L.i, oR: R.i, hL, hR, len: L.d + R.d };
    }
    if (!best) continue;
    const p1 = [...walk(outer, best.oL, best.oR), ...walk(H, best.hR, best.hL)];
    const p2 = [...walk(outer, best.oR, best.oL), ...walk(H, best.hL, best.hR)];
    const rest = holes.filter((_, j) => j !== hi);
    const in1 = rest.filter((h) => inPoly(at(h[0]), p1)), in2 = rest.filter((h) => !in1.includes(h));
    const a = splitHoles(xy, p1, in1), b = a && splitHoles(xy, p2, in2);
    if (a && b) return [...a, ...b];
  }
  return null;
}

/** Do segments ab and cd touch or cross (collinear overlaps included)? */
function segmentsMeet(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): boolean {
  const o = (p: [number, number], q: [number, number], r: [number, number]) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const on = (p: [number, number], q: [number, number], r: [number, number]) =>
    Math.min(p[0], q[0]) <= r[0] && r[0] <= Math.max(p[0], q[0]) && Math.min(p[1], q[1]) <= r[1] && r[1] <= Math.max(p[1], q[1]);
  return (d1 === 0 && on(c, d, a)) || (d2 === 0 && on(c, d, b)) || (d3 === 0 && on(a, b, c)) || (d4 === 0 && on(a, b, d));
}
