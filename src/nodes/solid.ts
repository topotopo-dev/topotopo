// Solid modelling via manifold-3d (booleans, clipping, Minkowski, smoothing, fracture,
// slicing). Decimation lives in remesh.ts.
import { GeoBuilder, Geometry } from '../core/geometry.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import { M, fromManifold, manifoldId, planeMatrix, polygonsToGeo, propLayout, toManifold } from '../core/manifold.ts';
import { boundaryLoops, triangulate, topologyReport } from '../core/topology.ts';
import { KDTree, TriBVH } from '../core/spatial.ts';
import { rng } from '../core/random.ts';
import { normalize, m4invert } from '../core/math.ts';
import type { Vec3 } from '../core/math.ts';
import { P, mask } from './util.ts';
import { applyMatrix } from './transform.ts';

function withManifolds<T>(fn: (track: (m: any) => any) => T): T {
  const live: any[] = [];
  try {
    return fn((m) => { live.push(m); return m; });
  } finally {
    for (const m of live) try { m.delete(); } catch { /* already freed */ }
  }
}

defineNode({
  type: 'boolean',
  category: 'solid',
  summary: 'Robust mesh boolean (union / subtract / intersect) of closed solids. Without B, unions A’s overlapping pieces.',
  aliases: ['csg', 'bool', 'difference', 'union', 'intersect'],
  inputs: [{ name: 'a', desc: 'solid A' }, { name: 'b', desc: 'solid B (optional)', optional: true }],
  params: {
    operation: { type: 'enum', options: ['union', 'subtract', 'intersect'], default: 'subtract', desc: 'A ∪ B, A − B, or A ∩ B', aliases: ['op', 'mode'] },
  },
  outputs: 'prim groups from_a, from_b (cut faces come from B when subtracting); float point/vertex attributes interpolated',
  example: {
    nodes: {
      box: { type: 'box' },
      ball: { type: 'sphere', params: { type: 'ico', level: 3, radius: 0.65 } },
      cut: { type: 'boolean', in: ['box', 'ball'], params: { operation: 'subtract' } },
    },
    output: 'cut',
  },
  cook: ({ input, hasInput, p }) => withManifolds((track) => {
    const A = input(0), B = hasInput(1) ? input(1) : null;
    const L = propLayout(B ? [A, B] : [A]);
    const mA = track(toManifold(A, L));
    let r;
    const sources = [{ geo: A, id: manifoldId(mA) }];
    if (!B) r = track(M().Manifold.union(mA.decompose().map(track)));
    else {
      const mB = track(toManifold(B, L));
      sources.push({ geo: B, id: manifoldId(mB) });
      r = track(p.operation === 'union' ? mA.add(mB) : p.operation === 'intersect' ? mA.intersect(mB) : mA.subtract(mB));
    }
    const { geo, primSource } = fromManifold(r, L, sources);
    geo.addGroup('prim', 'from_a', Uint8Array.from(primSource, (s) => (s === 0 ? 1 : 0)));
    geo.addGroup('prim', 'from_b', Uint8Array.from(primSource, (s) => (s === 1 ? 1 : 0)));
    return geo;
  }),
});

defineNode({
  type: 'clip',
  category: 'solid',
  summary: 'Cut geometry with a plane; keep one side or both. Works on any polygons; can cap closed solids.',
  aliases: ['cut', 'slice_plane', 'trim'],
  inputs: [{ name: 'geo', desc: 'geometry' }],
  params: {
    origin: { type: 'vec3', default: [0, 0, 0], desc: 'point on the plane' },
    normal: { type: 'vec3', default: [0, 1, 0], desc: 'plane normal; "above" = the side it points to', aliases: ['dir', 'direction'] },
    keep: { type: 'enum', options: ['below', 'above', 'both'], default: 'below', desc: 'which side to keep (both = split, groups above/below)' },
    cap: { type: 'bool', default: false, desc: 'close the cut with faces (prim group "cap")' },
  },
  outputs: 'prim groups above/below (keep=both), cap',
  example: { type: 'clip', params: { origin: [0, 0.2, 0], normal: [0, 1, 0], keep: 'below', cap: true } },
  cook: ({ input, p }) => {
    const g = input(0);
    const n = normalize(p.normal);
    const o = p.origin;
    const Pd = g.P;
    const d = Float64Array.from({ length: g.numPoints }, (_, i) => (Pd[i * 3] - o[0]) * n[0] + (Pd[i * 3 + 1] - o[1]) * n[1] + (Pd[i * 3 + 2] - o[2]) * n[2]);
    const b = new GeoBuilder(g);
    const keepSide = (s: number) => (p.keep === 'both' ? true : p.keep === 'above' ? s > 0 : s < 0);
    const ptMap = [new Int32Array(g.numPoints).fill(-1), new Int32Array(g.numPoints).fill(-1)];
    const getPt = (side: number, i: number) => { const m = ptMap[side]; if (m[i] < 0) m[i] = b.copyPoint(i); return m[i]; };
    const cut = new Map<string, number>();
    const cutPt = (a: number, c: number, side: number) => {
      const k = (a < c ? a + ':' + c : c + ':' + a) + (p.keep === 'both' ? ':' + side : '');
      let id = cut.get(k);
      if (id === undefined) {
        const t = d[a] / (d[a] - d[c]);
        id = b.blendPoint([a, c], [1 - t, t]);
        cut.set(k, id);
      }
      return id;
    };
    const above = b.group('prim', 'above'), below = b.group('prim', 'below');
    for (let pr = 0; pr < g.numPrims; pr++) {
      const s = g.primStart[pr], e = g.primStart[pr + 1];
      const closed = !!g.primClosed[pr];
      for (const side of p.keep === 'both' ? [1, -1] : [p.keep === 'above' ? 1 : -1]) {
        const sideIdx = side > 0 ? 0 : 1;
        const inside = (i: number) => (side > 0 ? d[i] >= 0 : d[i] <= 0);
        const out: number[] = [], vsrc: any[] = [];
        const nv = e - s, last = closed ? nv : nv - 1;
        if (closed) {
          for (let k = 0; k < nv; k++) {
            const va = s + k, vb = s + ((k + 1) % nv);
            const a = g.vertexPoint[va], c = g.vertexPoint[vb];
            if (inside(a)) { out.push(getPt(sideIdx, a)); vsrc.push(va); }
            if ((d[a] > 0 && d[c] < 0) || (d[a] < 0 && d[c] > 0)) {
              const t = d[a] / (d[a] - d[c]);
              out.push(cutPt(a, c, sideIdx)); vsrc.push({ i: [va, vb], w: [1 - t, t] });
            }
          }
          if (out.length >= 3) { const id = b.addPrim(out, true, pr, vsrc); (side > 0 ? above : below).add(id); }
        } else {
          let run: number[] = [], rs: any[] = [];
          const flush = () => { if (run.length >= 2) { const id = b.addPrim(run, false, pr, rs); (side > 0 ? above : below).add(id); } run = []; rs = []; };
          for (let k = 0; k <= last; k++) {
            const va = s + k, a = g.vertexPoint[va];
            if (inside(a)) { run.push(getPt(sideIdx, a)); rs.push(va); }
            if (k < last) {
              const vb = s + k + 1, c = g.vertexPoint[vb];
              if ((d[a] > 0 && d[c] < 0) || (d[a] < 0 && d[c] > 0)) {
                const t = d[a] / (d[a] - d[c]);
                run.push(cutPt(a, c, sideIdx)); rs.push({ i: [va, vb], w: [1 - t, t] });
                if (inside(a)) flush();
              }
            }
          }
          flush();
        }
      }
    }
    let out = b.build();
    if (p.keep === 'both') return out;
    out.primGroups.delete('above'); out.primGroups.delete('below');
    if (p.cap) {
      const loops = boundaryLoops(out);
      const bb = new GeoBuilder(out);
      for (let i = 0; i < out.numPoints; i++) bb.copyPoint(i);
      for (let pr = 0; pr < out.numPrims; pr++) {
        const vs: number[] = [];
        for (let v = out.primStart[pr]; v < out.primStart[pr + 1]; v++) vs.push(v);
        bb.addPrim(vs.map((v) => out.vertexPoint[v]), !!out.primClosed[pr], pr, vs);
      }
      const capG = bb.group('prim', 'cap');
      const OP = out.P;
      for (const l of loops) {
        const onPlane = l.every((i) => Math.abs((OP[i * 3] - o[0]) * n[0] + (OP[i * 3 + 1] - o[1]) * n[1] + (OP[i * 3 + 2] - o[2]) * n[2]) < 1e-6);
        if (onPlane) capG.add(bb.addPrim(l));
      }
      out = bb.build();
    }
    return out;
  },
});

defineNode({
  type: 'minkowski',
  category: 'solid',
  summary: 'Minkowski sum of two solids (e.g. A ⊕ small sphere = rounded/dilated A). Slow for large non-convex inputs.',
  aliases: ['minkowski_sum', 'dilate_solid'],
  inputs: [{ name: 'a', desc: 'solid' }, { name: 'b', desc: 'brush solid (e.g. a small sphere centred at the origin)' }],
  params: {
    operation: { type: 'enum', options: ['sum', 'difference'], default: 'sum', desc: 'sum grows A by B; difference erodes A by B' },
  },
  example: {
    nodes: {
      box: { type: 'box' },
      ball: { type: 'sphere', params: { type: 'ico', level: 1, radius: 0.1 } },
      rounded: { type: 'minkowski', in: ['box', 'ball'] },
    },
    output: 'rounded',
  },
  cook: ({ input, p }) => withManifolds((track) => {
    const L = propLayout([]);
    const a = track(toManifold(input(0), L)), b = track(toManifold(input(1), L));
    const r = track(p.operation === 'sum' ? a.minkowskiSum(b) : a.minkowskiDifference(b));
    return fromManifold(r, L).geo;
  }),
});

defineNode({
  type: 'smooth_solid',
  category: 'solid',
  summary: 'Smooth a closed mesh into curved surfaces and refine it (manifold smoothOut + refine); sharp edges above an angle stay crisp.',
  aliases: ['refine', 'round', 'smooth_out', 'subdivide_solid'],
  inputs: [{ name: 'solid', desc: 'closed mesh' }],
  params: {
    refine: { type: 'int', default: 4, min: 1, max: 32, desc: 'split every edge into this many segments' },
    sharp_angle: { type: 'float', default: 60, min: 0, max: 180, desc: 'edges with a dihedral angle sharper than this stay sharp (180 = smooth everything)' },
    smoothness: { type: 'float', default: 0, min: 0, max: 1, desc: 'smoothness kept on sharp edges (0 = crisp)' },
  },
  example: { type: 'smooth_solid', params: { refine: 4, sharp_angle: 80 } },
  cook: ({ input, p }) => withManifolds((track) => {
    const L = propLayout([input(0)]);
    const m = track(toManifold(input(0), L));
    const s = track(m.smoothOut(p.sharp_angle, p.smoothness));
    const r = track(s.refine(p.refine));
    return fromManifold(r, L, [{ geo: input(0), id: manifoldId(m) }]).geo;
  }),
});

defineNode({
  type: 'voronoi_fracture',
  category: 'solid',
  summary: 'Shatter a closed solid into convex Voronoi pieces (sites from input 2 or scattered inside). Pieces get name/class; inner faces group "inside".',
  aliases: ['fracture', 'shatter', 'voronoi'],
  inputs: [{ name: 'solid', desc: 'closed mesh to fracture' }, { name: 'sites', desc: 'optional fracture points', optional: true }],
  params: {
    count: { type: 'int', default: 12, min: 1, desc: 'number of pieces when no site points are given' },
    seed: P.seed(),
    gap: { type: 'float', default: 0, min: 0, desc: 'shrink each piece toward its centre by this distance (visual separation)' },
    neighbors: { type: 'int', default: 24, min: 4, desc: 'nearest sites considered per cell (raise if cells look wrong)' },
  },
  outputs: 'prim name ("piece0"...), class (int), group inside; point/prim attributes from the source',
  example: { type: 'voronoi_fracture', params: { count: 20, gap: 0.02, seed: 4 } },
  cook: ({ input, hasInput, p }) => withManifolds((track) => {
    const src = input(0);
    const L = propLayout([src]);
    const W = M();
    const mSrc = track(toManifold(src, L));
    const bb = src.bbox();
    let sites: number[][] = [];
    if (hasInput(1)) {
      const s = input(1);
      for (let i = 0; i < s.numPoints; i++) sites.push([s.P[i * 3], s.P[i * 3 + 1], s.P[i * 3 + 2]]);
    } else {
      const bvh = new TriBVH(src);
      const r = rng(p.seed + 3.1);
      let tries = 0;
      while (sites.length < p.count && tries++ < p.count * 500) {
        const q = [0, 1, 2].map((a) => bb.min[a] + r() * (bb.max[a] - bb.min[a]));
        if (bvh.inside(q[0], q[1], q[2])) sites.push(q);
      }
    }
    if (!sites.length) throw new NodeError('no fracture sites (input 2 empty or solid has no interior)');
    const flat = Float64Array.from(sites.flat());
    const kd = new KDTree(flat);
    const pad = Math.max(...[0, 1, 2].map((a) => bb.max[a] - bb.min[a])) * 0.1 + 1e-3;
    const pieces: Geometry[] = [];
    sites.forEach((s, i) => {
      const box = track(W.Manifold.cube([bb.max[0] - bb.min[0] + 2 * pad, bb.max[1] - bb.min[1] + 2 * pad, bb.max[2] - bb.min[2] + 2 * pad], true));
      const cellId = box.originalID();
      let cell = track(box.translate([(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2, (bb.min[2] + bb.max[2]) / 2]));
      for (const j of kd.knn(s[0], s[1], s[2], Math.min(p.neighbors + 1, sites.length))) {
        if (j === i) continue;
        const o = sites[j];
        const n = normalize([s[0] - o[0], s[1] - o[1], s[2] - o[2]] as Vec3);
        const mid = [(s[0] + o[0]) / 2, (s[1] + o[1]) / 2, (s[2] + o[2]) / 2];
        cell = track(cell.trimByPlane(n, n[0] * mid[0] + n[1] * mid[1] + n[2] * mid[2] + p.gap / 2));
        if (cell.isEmpty()) break;
      }
      if (cell.isEmpty()) return;
      const piece = track(mSrc.intersect(cell));
      if (piece.isEmpty()) return;
      const { geo, primSource } = fromManifold(piece, L, [{ geo: src, id: manifoldId(mSrc) }, { geo: new Geometry(), id: cellId }]);
      geo.addGroup('prim', 'inside', Uint8Array.from(primSource, (x) => (x !== 0 ? 1 : 0)));
      (geo.prims.add('class', 'int', 1).data as Int32Array).fill(pieces.length);
      const na = geo.prims.add('name', 'string', 1);
      for (let k = 0; k < geo.numPrims; k++) na.set(k, 'piece' + pieces.length);
      pieces.push(geo);
    });
    return Geometry.merge(pieces);
  }),
});

defineNode({
  type: 'slice',
  category: 'solid',
  summary: 'Contour a closed solid with parallel planes (closed polygons per level) — e.g. topographic lines, layers.',
  aliases: ['contour', 'section', 'cross_section'],
  inputs: [{ name: 'solid', desc: 'closed mesh' }],
  params: {
    count: { type: 'int', default: 10, min: 1, desc: 'number of slices across the bounding box' },
    axis: { type: 'enum', options: ['y', 'x', 'z'], default: 'y', desc: 'slicing axis' },
    margin: { type: 'float', default: 0.001, min: 0, desc: 'keep slices this far inside the bbox ends' },
  },
  outputs: 'prim float height, int slice',
  example: { type: 'slice', params: { count: 12, axis: 'y' } },
  cook: ({ input, p }) => withManifolds((track) => {
    const g = input(0);
    const plane = p.axis === 'y' ? 'xz' : p.axis === 'z' ? 'xy' : 'yz';
    // rotate world so the slicing axis becomes manifold +Z
    const pm = planeMatrix(plane as any);
    const inv = m4invert(Float64Array.from(pm));
    const local = applyMatrix(g, inv);
    const m = track(toManifold(local, propLayout([])));
    const bb = m.boundingBox();
    const out: Geometry[] = [];
    for (let k = 0; k < p.count; k++) {
      const t = p.count === 1 ? 0.5 : k / (p.count - 1);
      const h = bb.min[2] + p.margin + (bb.max[2] - bb.min[2] - 2 * p.margin) * t;
      const cs = m.slice(h);
      const polys = cs.toPolygons();
      cs.delete();
      if (!polys.length) continue;
      const geo = polygonsToGeo(polys, plane as any, h);
      (geo.prims.add('height', 'float', 1).data as Float64Array).fill(h);
      (geo.prims.add('slice', 'int', 1).data as Int32Array).fill(k);
      out.push(geo);
    }
    return Geometry.merge(out);
  }),
});

export { topologyReport };
