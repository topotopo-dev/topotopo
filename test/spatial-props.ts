// Property checks of the spatial structures, run by test/property.ts (layer 1 of npm test):
//  - TriBVH (SAH build) and RayScene against the same per-triangle tests over a single leaf that holds every triangle
//    (no culling: brute force) on random triangle soups, closed noisy spheres and grids hit through their vertices and
//    edges (grazing and watertight cases): nearest hit distance, any-hit, crossing counts, all hits, parity inside,
//    closest point and 32-ray packets must agree; the tree must be well formed (every triangle once, leaves of at most
//    4, boxes containing their children and triangles, bounded depth);
//  - hypot3 = Math.hypot bit for bit; pointNormals = the per-prim Newell accumulation bit for bit.
import { Geometry } from '../src/core/geometry.ts';
import { TriBVH } from '../src/core/spatial.ts';
import { RayScene } from '../src/core/analysis.ts';
import { hypot3 } from '../src/core/math.ts';
import { pointNormals, primNewell } from '../src/core/topology.ts';
import { rng } from '../src/core/random.ts';

type Rand = () => number;

function soup(r: Rand): Geometry {
  const nt = 1 + Math.floor(r() * 300), pos: number[] = [], prims: number[][] = [];
  for (let t = 0; t < nt; t++) {
    const c = [r() * 2 - 1, r() * 2 - 1, r() * 2 - 1], s = 0.01 + r() * 0.5, b = pos.length / 3;
    for (let k = 0; k < 3; k++) pos.push(c[0] + (r() - 0.5) * s, c[1] + (r() - 0.5) * s, c[2] + (r() - 0.5) * s);
    if (r() < 0.05) pos.splice(pos.length - 3, 3, pos[pos.length - 6], pos[pos.length - 5], pos[pos.length - 4]); // zero area
    prims.push([b, b + 1, b + 2]);
    if (r() < 0.05) prims.push([b, b + 1, b + 2]); // duplicate
  }
  return new Geometry({ positions: pos, prims });
}

/** Closed UV sphere with welded points and a noisy radius (quads and triangle caps). */
function sphere(r: Rand): Geometry {
  const rows = 3 + Math.floor(r() * 18), cols = 3 + Math.floor(r() * 22), pos: number[] = [], prims: number[][] = [];
  const amp = r() < 0.5 ? 0 : 0.2;
  pos.push(0, 1, 0);
  for (let i = 1; i < rows; i++)
    for (let j = 0; j < cols; j++) {
      const th = (Math.PI * i) / rows, ph = (2 * Math.PI * j) / cols, rad = 1 + amp * (r() - 0.5);
      pos.push(rad * Math.sin(th) * Math.cos(ph), rad * Math.cos(th), rad * Math.sin(th) * Math.sin(ph));
    }
  pos.push(0, -1, 0);
  const at = (i: number, j: number) => 1 + (i - 1) * cols + (j % cols), bottom = pos.length / 3 - 1;
  for (let j = 0; j < cols; j++) prims.push([0, at(1, j + 1), at(1, j)]);
  for (let i = 1; i < rows - 1; i++) for (let j = 0; j < cols; j++) prims.push([at(i, j), at(i, j + 1), at(i + 1, j + 1), at(i + 1, j)]);
  for (let j = 0; j < cols; j++) prims.push([at(rows - 1, j), at(rows - 1, j + 1), bottom]);
  return new Geometry({ positions: pos, prims });
}

/** Grid of quads in XZ (flat or with integer-step heights), welded. */
function grid(r: Rand): Geometry {
  const nx = 1 + Math.floor(r() * 16), nz = 1 + Math.floor(r() * 16), bumpy = r() < 0.5, pos: number[] = [], prims: number[][] = [];
  for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) pos.push(i * 0.25 - 1, bumpy ? Math.floor(r() * 3) * 0.125 : 0, j * 0.25 - 1);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) { const a = j * (nx + 1) + i; prims.push([a, a + nx + 1, a + nx + 2, a + 1]); }
  return new Geometry({ positions: pos, prims });
}

/** A BVH over the same triangles with one leaf holding them all (every query tests every triangle). */
function flat(bvh: TriBVH): TriBVH {
  const nt = bvh.numTris;
  return TriBVH.fromArrays({
    T: bvh.T, triPt: bvh.triPt, triPrim: bvh.triPrim, order: Int32Array.from({ length: nt }, (_, i) => i),
    nodes: Float64Array.of(-Infinity, -Infinity, -Infinity, Infinity, Infinity, Infinity), child: Int32Array.of(-1, nt),
  });
}

/** Structural invariants of a TriBVH; returns problems. */
function wellFormed(bvh: TriBVH): string[] {
  const out: string[] = [], nt = bvh.numTris, seen = new Uint8Array(nt), N = bvh.nodes, C = bvh.child, T = bvh.T;
  if (!nt) return out;
  let maxDepth = 0;
  const visit = (n: number, depth: number) => {
    maxDepth = Math.max(maxDepth, depth);
    const c0 = C[n * 2], c1 = C[n * 2 + 1];
    const inside = (x: number, y: number, z: number) => !(x < N[n * 6] || y < N[n * 6 + 1] || z < N[n * 6 + 2] || x > N[n * 6 + 3] || y > N[n * 6 + 4] || z > N[n * 6 + 5]);
    if (c0 < 0) {
      if (c1 < 1 || c1 > 4) out.push(`leaf ${n} holds ${c1} triangles`);
      for (let i = -1 - c0; i < -1 - c0 + c1; i++) {
        const t = bvh.order[i];
        if (seen[t]++) out.push(`triangle ${t} in two leaves`);
        for (let k = 0; k < 3; k++) if (!inside(T[t * 9 + k * 3], T[t * 9 + k * 3 + 1], T[t * 9 + k * 3 + 2])) out.push(`triangle ${t} outside leaf ${n}`);
        if (i > -1 - c0 && bvh.order[i - 1] > t) out.push(`leaf ${n} not in index order`);
      }
      return;
    }
    if (c0 <= n || c1 <= n) out.push(`node ${n}: children ${c0}, ${c1} not after it`);
    for (const c of [c0, c1]) {
      if (!inside(N[c * 6], N[c * 6 + 1], N[c * 6 + 2]) || !inside(N[c * 6 + 3], N[c * 6 + 4], N[c * 6 + 5])) out.push(`child ${c} box outside node ${n}`);
      visit(c, depth + 1);
    }
  };
  visit(0, 0);
  for (let t = 0; t < nt; t++) if (!seen[t]) out.push(`triangle ${t} in no leaf`);
  if (maxDepth > 48 + Math.ceil(Math.log2(nt + 1)) + 1) out.push(`depth ${maxDepth} for ${nt} triangles`);
  if (bvh.nodeCount * 6 !== N.length || bvh.nodeCount > 2 * nt - 1) out.push(`node count ${bvh.nodeCount} for ${nt} triangles`);
  return out;
}

const close = (a: number, b: number) => a === b || Math.abs(a - b) <= 1e-9 * (1 + Math.abs(a) + Math.abs(b));

/** Run the checks; `check(cond, msg)` reports each. Returns the number of comparisons made. */
export function spatialProperties(seed: number, meshes: number, check: (cond: boolean, msg: string) => void): number {
  let compared = 0;
  const r = rng(seed + 0.125);
  const counts = { soup: 0, sphere: 0, grid: 0 };
  const problems: string[] = [];
  const note = (m: string) => { if (problems.length < 12) problems.push(m); };
  for (let m = 0; m < meshes; m++) {
    const kind = m % 3 === 0 ? 'soup' : m % 3 === 1 ? 'sphere' : 'grid';
    counts[kind]++;
    const g = kind === 'soup' ? soup(r) : kind === 'sphere' ? sphere(r) : grid(r);
    const bvh = new TriBVH(g), ref = flat(bvh), rs = new RayScene(bvh), rf = new RayScene(ref);
    for (const p of wellFormed(bvh)) note(`${kind} #${m}: ${p}`);
    const P = g.P, np = g.numPoints;
    const D = new Float64Array(96), ID = new Float64Array(96), best = new Float64Array(32), bestRef = new Float64Array(32);
    for (let q = 0; q < 120; q++) {
      // origin: random, or a point of the mesh lifted; direction: random, axis-aligned, or aimed at a vertex / edge point
      const o = [r() * 4 - 2, r() * 4 - 2, r() * 4 - 2];
      let d = [r() - 0.5, r() - 0.5, r() - 0.5];
      const mode = q % 5;
      // axis-aligned, the zero components +0 or -0 (a negated direction): slab tests must not cull boxes the ray lies on
      if (mode === 1) {
        const a = Math.floor(r() * 3);
        d = [r() < 0.5 ? -0 : 0, r() < 0.5 ? -0 : 0, r() < 0.5 ? -0 : 0];
        d[a] = r() < 0.5 ? -1 : 1;
      }
      if (mode === 2 || mode === 3) {
        const i = Math.floor(r() * np), j = Math.floor(r() * np), f = mode === 2 ? 0 : 0.5;
        const tx = P[i * 3] * (1 - f) + P[j * 3] * f, ty = P[i * 3 + 1] * (1 - f) + P[j * 3 + 1] * f, tz = P[i * 3 + 2] * (1 - f) + P[j * 3 + 2] * f;
        d = [tx - o[0], ty - o[1], tz - o[2]];
      }
      // vertical rays through grid vertices (on leaf box faces), from above or below, zero components of either sign
      if (mode === 4 && kind === 'grid') {
        const i = Math.floor(r() * np), up = r() < 0.5;
        o[0] = P[i * 3]; o[1] = up ? -2 : 2; o[2] = P[i * 3 + 2];
        d = [r() < 0.5 ? -0 : 0, up ? 1 : -1, r() < 0.5 ? -0 : 0];
      }
      if (!(Math.hypot(d[0], d[1], d[2]) > 0)) continue;
      const tmax = r() < 0.3 ? 0.5 + r() * 3 : Infinity;
      const [ox, oy, oz] = o, [dx, dy, dz] = d;
      const tn = rs.nearest(ox, oy, oz, dx, dy, dz, tmax), tr = rf.nearest(ox, oy, oz, dx, dy, dz, tmax);
      if (!close(tn, tr)) note(`${kind} #${m} ray ${q}: nearest ${tn} vs brute force ${tr}`);
      if (tn < Infinity && rs.lastTri >= 0) {
        const th = (rs as any).hitTri(rs.lastTri, ox, oy, oz, dx, dy, dz);
        if (th !== tn) note(`${kind} #${m} ray ${q}: lastTri ${rs.lastTri} hits at ${th}, not ${tn}`);
      }
      if (rs.occluded(ox, oy, oz, dx, dy, dz, tmax) !== rf.occluded(ox, oy, oz, dx, dy, dz, tmax)) note(`${kind} #${m} ray ${q}: occluded differs`);
      if (rs.countHits(ox, oy, oz, dx, dy, dz) !== rf.countHits(ox, oy, oz, dx, dy, dz)) note(`${kind} #${m} ray ${q}: countHits differs`);
      const a = bvh.raycast(ox, oy, oz, dx, dy, dz, tmax, 0), b = ref.raycast(ox, oy, oz, dx, dy, dz, tmax, 0);
      if (!!a !== !!b || (a && b && !close(a.t, b.t))) note(`${kind} #${m} ray ${q}: raycast ${a?.t} vs brute force ${b?.t}`);
      const ha = bvh.raycastAll(ox, oy, oz, dx, dy, dz), hb = ref.raycastAll(ox, oy, oz, dx, dy, dz);
      if (ha.length !== hb.length || ha.some((t, k) => !close(t, hb[k]))) note(`${kind} #${m} ray ${q}: raycastAll ${ha.length} vs ${hb.length} hits`);
      if (bvh.inside(ox, oy, oz) !== ref.inside(ox, oy, oz)) note(`${kind} #${m} point ${q}: inside differs`);
      const md = r() < 0.3 ? r() : Infinity;
      const ca = bvh.closest(ox, oy, oz, md), cb = ref.closest(ox, oy, oz, md);
      // the closest distance must agree; the point may differ where it is not unique, but lies at that distance
      if (!!ca !== !!cb || (ca && cb && (!close(ca.dist, cb.dist) || !close(Math.hypot(ca.pos[0] - ox, ca.pos[1] - oy, ca.pos[2] - oz), ca.dist)))) note(`${kind} #${m} point ${q}: closest ${ca?.dist} vs brute force ${cb?.dist}`);
      // a packet of 32 rays from o
      if (q % 10 === 0) {
        for (let k = 0; k < 32; k++) {
          const x = r() - 0.5, y = r() - 0.5, z = r() - 0.5;
          D[k * 3] = x; D[k * 3 + 1] = y; D[k * 3 + 2] = z;
          ID[k * 3] = 1 / (x || 1e-300); ID[k * 3 + 1] = 1 / (y || 1e-300); ID[k * 3 + 2] = 1 / (z || 1e-300);
        }
        const pt = tmax === Infinity ? 10 : tmax;
        if (rs.occludedPacket(ox, oy, oz, D, ID, 32, pt) !== rf.occludedPacket(ox, oy, oz, D, ID, 32, pt)) note(`${kind} #${m} packet ${q}: occludedPacket differs`);
        rs.nearestPacket(ox, oy, oz, D, ID, 32, pt, best); rf.nearestPacket(ox, oy, oz, D, ID, 32, pt, bestRef);
        for (let k = 0; k < 32; k++) if (!close(best[k], bestRef[k])) { note(`${kind} #${m} packet ${q}: nearestPacket ray ${k} ${best[k]} vs ${bestRef[k]}`); break; }
      }
      compared++;
    }
  }
  check(!problems.length, `TriBVH/RayScene = brute force on ${meshes} random meshes (${counts.soup} soups, ${counts.sphere} spheres, ${counts.grid} grids), ${compared} rays/points each compared 9 ways${problems.length ? ':\n  ' + problems.join('\n  ') : ''}`);

  // arrays from a BVH (as a worker receives them) answer like the BVH
  {
    const g = sphere(r), bvh = new TriBVH(g), w = RayScene.fromArrays(new RayScene(bvh).toArrays()), s = new RayScene(bvh);
    let same = true;
    for (let q = 0; q < 200; q++) {
      const o = [r() * 4 - 2, r() * 4 - 2, r() * 4 - 2], d = [r() - 0.5, r() - 0.5, r() - 0.5];
      if (!Object.is(w.nearest(o[0], o[1], o[2], d[0], d[1], d[2]), s.nearest(o[0], o[1], o[2], d[0], d[1], d[2])) || w.lastTri !== s.lastTri) same = false;
    }
    check(same, 'RayScene.fromArrays(toArrays()) gives the same hits and triangles as the scene it came from');
  }

  // hypot3 = Math.hypot bit for bit (the engine's algorithm), including zeros, infinities, NaN and extreme exponents
  {
    const special = [0, -0, 1, -1, Infinity, -Infinity, NaN, 1e-310, -5e-324, 1e308, -1e308, 0.1, 3, 4];
    let bad = 0, n = 0;
    const t = (x: number, y: number, z: number) => { n++; if (!Object.is(Math.hypot(x, y, z), hypot3(x, y, z))) bad++; };
    for (const x of special) for (const y of special) for (const z of special) t(x, y, z);
    for (let i = 0; i < 200000; i++) {
      const e = () => (r() - 0.5) * Math.pow(10, Math.floor(r() * 40) - 20);
      t(e(), e(), e()); t(r() - 0.5, r() - 0.5, r() - 0.5);
    }
    check(bad === 0, `hypot3 = Math.hypot bit for bit (${n} triples, ${bad} differ)`);
  }

  // pointNormals = Newell per prim accumulated onto its points, normalised with Math.hypot
  {
    let bad = 0;
    for (const g of [sphere(r), grid(r), soup(r)]) {
      const ref = new Float64Array(g.numPoints * 3), t = [0, 0, 0];
      for (let p = 0; p < g.numPrims; p++) {
        if (!g.primClosed[p]) continue;
        primNewell(g, p, t);
        for (let v = g.primStart[p]; v < g.primStart[p + 1]; v++) { const i = g.vertexPoint[v] * 3; ref[i] += t[0]; ref[i + 1] += t[1]; ref[i + 2] += t[2]; }
      }
      for (let i = 0; i < ref.length; i += 3) {
        const l = Math.hypot(ref[i], ref[i + 1], ref[i + 2]);
        if (l > 1e-20) { ref[i] /= l; ref[i + 1] /= l; ref[i + 2] /= l; } else { ref[i] = 0; ref[i + 1] = 1; ref[i + 2] = 0; }
      }
      const N = pointNormals(g);
      for (let i = 0; i < N.length; i++) if (!Object.is(N[i], ref[i])) bad++;
    }
    check(bad === 0, `pointNormals = per-prim Newell accumulation, bit for bit (${bad} components differ)`);
  }
  return compared;
}
