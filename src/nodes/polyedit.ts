// Polygon modelling with topology (Houdini PolySplit, Clip-with-topology, PolyBridge, PolyFill, PolyDissolve,
// Edge Collapse, Edge Divide). The kernels live in src/core/polyedit.ts.
import { GeoBuilder, Geometry } from '../core/geometry.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import type { ParamDef } from '../graph/types.ts';
import { EdgeSet, edgeKey, edgeList, forEachPrimEdge } from '../core/edges.ts';
import { halfEdges } from '../core/halfedge.ts';
import { refreshNormals } from '../core/topology.ts';
import {
  FaceSplitter, PolyEditError, bridgeChains, collapseEdges, dissolveEdges, enclosedFaces, fillPatch, newellOf, orderChain, planeChords, quadRing,
} from '../core/polyedit.ts';
import type { CollapseMode, FillMode } from '../core/polyedit.ts';
import { P, edgeMask, mask } from './util.ts';

/** Run a kernel, turning its PolyEditErrors into NodeErrors prefixed with the node type. */
function run<T>(node: string, f: () => T): T {
  try {
    return f();
  } catch (e: any) {
    if (e instanceof PolyEditError) throw new NodeError(`${node}: ${e.message}`);
    throw e;
  }
}

const edgeParam = (desc: string, extra: Partial<ParamDef> = {}): ParamDef => ({ type: 'group', default: '', groupClass: 'edge', desc, ...extra });

const unit = (v: number[]): number[] => { const l = Math.hypot(v[0], v[1], v[2]); return l > 1e-20 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 0]; };
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// ---------------------------------------------------------------- knife

function parsePlanes(p: Record<string, any>): [number[], number[]][] {
  const list = p.planes;
  if (list === undefined || list === null || (Array.isArray(list) && list.length === 0)) return [[p.origin, p.direction]];
  if (!Array.isArray(list)) throw new NodeError('knife: "planes" must be a list of [origin, normal] pairs', 'e.g. [[[0,0,0],[1,0,0]], [[0,0.5,0],[0,1,0]]]');
  return list.map((e: any, i: number) => {
    const o = Array.isArray(e) ? e[0] : e?.origin, n = Array.isArray(e) ? e[1] : e?.normal ?? e?.direction;
    const vec = (v: any) => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x));
    if (!vec(o) || !vec(n)) throw new NodeError(`knife: planes[${i}] is not [origin, normal] with two 3-vectors`, 'e.g. [[[0,0,0],[1,0,0]], [[0,0.5,0],[0,1,0]]]');
    return [o, n] as [number[], number[]];
  });
}

/** One knife plane: split, group the cut, optionally keep one side. `selName` names a temp prim group of polygons to cut. */
function knifePlane(g: Geometry, o: number[], dir: number[], tol: number, keep: string, selName: string | null, sides: boolean): Geometry {
  const n = unit(dir);
  if (!(Math.abs(n[0]) + Math.abs(n[1]) + Math.abs(n[2]) > 0)) throw new NodeError('knife: plane normal (direction) is zero');
  const Pd = g.P, np = g.numPoints;
  const d = new Float64Array(np);
  for (let i = 0; i < np; i++) {
    const v = (Pd[i * 3] - o[0]) * n[0] + (Pd[i * 3 + 1] - o[1]) * n[1] + (Pd[i * 3 + 2] - o[2]) * n[2];
    d[i] = Math.abs(v) <= tol ? 0 : v;
  }
  const selM = selName ? g.primGroups.get(selName) ?? null : null;
  const isSel = (pr: number) => !selM || !!selM[pr];
  const fs = new FaceSplitter(g);
  forEachPrimEdge(g, (pr, _v0, _v1, a, b) => {
    if (isSel(pr) && d[a] * d[b] < 0) fs.edgePoint(a, b, d[a] / (d[a] - d[b]), 0);
  });
  const signOf = (id: number) => (id < np ? Math.sign(d[id]) : 0); // inserted points lie on the plane
  for (let pr = 0; pr < g.numPrims; pr++) {
    if (!isSel(pr)) continue;
    const ring = fs.ring(pr);
    const sign = ring.map((c) => signOf(c.id));
    if (!g.primClosed[pr]) {
      fs.breakAt(pr, ring.filter((_, k) => sign[k] === 0).map((c) => c.id));
      continue;
    }
    if (ring.length < 3 || !sign.includes(1) || !sign.includes(-1)) continue;
    const pos = ring.map((c) => fs.pos(c.id));
    const axis = cross(n, newellOf(pos).n);
    for (const [i, j] of planeChords(sign, (k) => pos[k], axis)) fs.chord(pr, ring[i].id, ring[j].id);
  }
  const out = fs.build();
  // side of each output prim: the sign of its corner farthest from the plane (0 = lies in the plane)
  const side = new Int8Array(out.numPrims), fromSel = new Uint8Array(out.numPrims);
  for (let q = 0; q < out.numPrims; q++) {
    fromSel[q] = isSel(fs.primSource[q]) ? 1 : 0;
    let best = 0;
    for (let v = out.primStart[q]; v < out.primStart[q + 1]; v++) { const id = out.vertexPoint[v], x = id < np ? d[id] : 0; if (Math.abs(x) > Math.abs(best)) best = x; }
    side[q] = Math.sign(best);
  }
  const zero = (id: number) => id >= np || d[id] === 0;
  const cutE = out.edgeGroups.get('cut') ?? new EdgeSet();
  const cutP = out.pointGroups.get('cut') ?? new Uint8Array(out.numPoints);
  forEachPrimEdge(out, (q, _v0, _v1, a, b) => {
    if (!fromSel[q] || !zero(a) || !zero(b)) return;
    cutE.add(a, b);
    cutP[a] = cutP[b] = 1;
  });
  for (let q = 0; q < out.numPrims; q++) if (fromSel[q]) for (let v = out.primStart[q]; v < out.primStart[q + 1]; v++) if (zero(out.vertexPoint[v])) cutP[out.vertexPoint[v]] = 1;
  out.addEdgeGroup('cut', cutE);
  out.addGroup('point', 'cut', cutP);
  if (keep === 'both') {
    if (sides) {
      out.addGroup('prim', 'above', Uint8Array.from(side, (s, q) => (fromSel[q] && s > 0 ? 1 : 0)));
      out.addGroup('prim', 'below', Uint8Array.from(side, (s, q) => (fromSel[q] && s < 0 ? 1 : 0)));
    }
    return out;
  }
  const drop = keep === 'above' ? -1 : 1;
  return out.subsetPrims(Uint8Array.from(side, (s, q) => (fromSel[q] && s === drop ? 0 : 1)), true);
}

defineNode({
  type: 'knife',
  category: 'topology',
  summary: 'Cut polygons along planes keeping topology: new points on crossed edges, crossed polygons split in two, the cut in edge and point group "cut".',
  description:
    'Unlike clip, both sides stay connected (keep both) and the mesh stays watertight: a point is inserted once per crossed ' +
    'edge, so every polygon using the edge gets it. Concave polygons are split into as many pieces as the plane makes ' +
    '(crossings are paired along the cut line). Points within tolerance of the plane are used as cut points instead of ' +
    'making new ones. Polylines are split at the plane (or trimmed with keep above/below). Several planes ("planes") cut ' +
    'one after another; keep above/below then keeps the region on that side of every plane. The cut edge group holds the ' +
    'edges lying in a cutting plane (new and existing). Polygons outside "group" are not split but gain the new points of ' +
    'shared edges. Point/vertex attributes are interpolated at the cut.',
  aliases: ['polycut_plane', 'plane_cut', 'cut_plane', 'polyknife_plane'],
  inputs: [{ name: 'geo', desc: 'polygons and/or polylines' }],
  params: {
    origin: { type: 'vec3', default: [0, 0, 0], desc: 'a point on the cutting plane', aliases: ['center', 'position', 'pos'] },
    direction: { type: 'vec3', default: [0, 1, 0], desc: 'plane normal; "above" is the side it points to', aliases: ['normal', 'dir', 'n'] },
    keep: { type: 'enum', options: ['both', 'above', 'below'], default: 'both', desc: 'both = split and keep everything (prim groups above/below); above/below = drop the other side, like clip but with the cut grouped' },
    planes: { type: 'json', default: [], desc: 'several cutting planes as [[origin, normal], ...], applied in order (replaces origin/direction when not empty), e.g. [[[0,0,0],[1,0,0]], [[0,0,0],[0,0,1]]]' },
    group: P.group('prim', 'polygons/polylines to cut ("" = all)'),
    tolerance: { type: 'float', default: 1e-6, min: 0, desc: 'points closer than this to a plane count as on it' },
  },
  outputs: 'edge group cut (edges lying in a cutting plane), point group cut; prim groups above/below (keep both, single plane)',
  example: { type: 'knife', params: { origin: [0, 0.1, 0], direction: [0.2, 1, 0] } },
  cook: ({ input, p }) => {
    let g = input(0).clone();
    g.edgeGroups.delete('cut');
    g.pointGroups.delete('cut');
    const planes = parsePlanes(p);
    const sel = mask(g, 'prim', p.group);
    const TMP = '__knife_group';
    if (sel) g.addGroup('prim', TMP, sel.slice());
    for (const [o, n] of planes) g = knifePlane(g, o, n, p.tolerance, p.keep, sel ? TMP : null, planes.length === 1);
    g.primGroups.delete(TMP);
    return refreshNormals(g);
  },
});

// ---------------------------------------------------------------- polysplit

/** Path tokens from a list or a whitespace/comma separated string. */
function pathTokens(v: any): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(/[\s,]+/).filter(Boolean);
  return [];
}

defineNode({
  type: 'polysplit',
  category: 'topology',
  summary: 'Insert edge loops across a ring of quads (loop cut), or split polygons along a path of points. New edges in edge group "split".',
  description:
    'loop mode: the seed edge (first edge matching "edge") defines an edge ring: the opposite sides of successive quads, ' +
    'stopping at non-quads and boundaries (a closed ring goes all the way round). Every quad of the ring is split by "count" ' +
    'parallel loops. count 1: the loop sits at "fraction" along the seed edge, measured from its lower to its higher point ' +
    'number (flip measures from the other end) and at the same fraction along every rung. count > 1: loops evenly spaced at ' +
    'k/(count+1); fraction slides them together (0.5 = even). Faces next to the ring that are not quads get the new points ' +
    'on their shared edges, so the mesh stays watertight. ' +
    'path mode: "points" lists tokens "pN" (existing point N) or "pA-B:t" (new point at fraction t from A to B on edge ' +
    'A-B; t defaults to 0.5). Consecutive tokens must lie on a common polygon (corner or point on one of its edges); the ' +
    'polygon is split between them. Repeat the first token at the end to close the path. New points are shared by every ' +
    'polygon using their edge.',
  aliases: ['edge_loop_insert', 'loopcut', 'loop_cut', 'insert_edge_loop', 'polysplit2'],
  inputs: [{ name: 'geo', desc: 'polygon mesh' }],
  params: {
    mode: { type: 'enum', options: ['loop', 'path'], default: 'loop', desc: 'loop = insert loops across a quad ring; path = split along "points"' },
    edge: edgeParam('loop: seed edge as an edge pattern; the first matching edge is used, e.g. "p3-7" or an edge group name ("" = edge 0)', { aliases: ['seed', 'seed_edge'] }),
    fraction: { type: 'float', default: 0.5, min: 0, max: 1, desc: 'loop: position along the seed edge (lower → higher point number); with count > 1 slides all loops', aliases: ['position', 'slide', 'percent'] },
    count: { type: 'int', default: 1, min: 1, max: 64, desc: 'loop: number of parallel loops', aliases: ['cuts', 'number', 'numloops'] },
    flip: { type: 'bool', default: false, desc: 'loop: measure fraction from the higher-numbered point of the seed edge' },
    points: { type: 'json', default: [], desc: 'path: tokens "pN" (existing point) or "pA-B:t" (point at fraction t on edge A-B), e.g. ["p0", "p5-6:0.5", "p12"]; a string "p0 p5-6:0.5 p12" also works', aliases: ['path'] },
  },
  outputs: 'edge group split (new edges), point group split (new points)',
  example: { type: 'polysplit', params: { edge: 'p0-1', count: 2 } },
  cook: ({ input, p, warn }) => {
    const g = input(0);
    const fs = new FaceSplitter(g);
    if (p.mode === 'path') {
      const toks = pathTokens(p.points);
      if (toks.length < 2) throw new NodeError('polysplit: path mode needs at least two "points" tokens', 'e.g. ["p0", "p5-6:0.5", "p12"]: pN = existing point, pA-B:t = point at fraction t on edge A-B');
      const he = halfEdges(g);
      const L = edgeList(g);
      const locs = toks.map((tok) => {
        let m = /^p(\d+)$/i.exec(tok);
        if (m) {
          const q = +m[1];
          if (q >= g.numPoints) throw new NodeError(`polysplit: point ${q} does not exist (${g.numPoints} points)`);
          return { id: fs.pt[q], prims: he.pointPrims(q) };
        }
        m = /^p(\d+)-(\d+)(?::(.+))?$/i.exec(tok);
        if (m) {
          const a = +m[1], b = +m[2], t = m[3] === undefined ? 0.5 : Number(m[3]);
          if (!Number.isFinite(t) || t < 0 || t > 1) throw new NodeError(`polysplit: bad fraction in "${tok}" (use 0..1)`);
          if (a === b || !L.index.has(edgeKey(a, b))) throw new NodeError(`polysplit: "${tok}": points ${a} and ${b} are not joined by an edge`);
          const e = he.edgeId(a, b);
          return { id: fs.edgePoint(a, b, t), prims: e >= 0 ? he.edgeFaces(e) : [] };
        }
        throw new NodeError(`polysplit: bad path token "${tok}"`, 'tokens: "pN" (existing point N) or "pA-B:t" (point at fraction t on edge A-B)');
      });
      for (let i = 0; i + 1 < locs.length; i++) {
        const u = locs[i], v = locs[i + 1];
        if (u.id === v.id) continue;
        let done = false, isSide = false;
        for (const f of u.prims) {
          if (!v.prims.includes(f)) continue;
          const ring = fs.ring(f), n = ring.length;
          const ia = ring.findIndex((c) => c.id === u.id), ib = ring.findIndex((c) => c.id === v.id);
          if (ia < 0 || ib < 0) continue;
          if ((ia + 1) % n === ib || (ib + 1) % n === ia) { isSide = true; continue; }
          fs.chord(f, u.id, v.id);
          done = true;
          break;
        }
        if (!done && !isSide) throw new NodeError(`polysplit: "${toks[i]}" and "${toks[i + 1]}" do not lie on a common polygon`, 'consecutive path points must share a polygon (a corner, or a point on one of its edges)');
      }
    } else {
      const L = edgeList(g);
      const m = mask(g, 'edge', p.edge);
      let seed = -1;
      for (let i = 0; i < L.count && seed < 0; i++) if (!m || m[i]) seed = i;
      if (seed < 0) throw new NodeError(`polysplit: the edge pattern "${p.edge}" matches no edge`, 'e.g. "p0-1" (edge between points 0 and 1), an edge group name, or "" for edge 0');
      let a = L.a[seed], b = L.b[seed];
      if (p.flip) [a, b] = [b, a];
      const ring = quadRing(halfEdges(g), a, b);
      if (!ring) throw new NodeError(`polysplit: seed edge p${L.a[seed]}-${L.b[seed]} is not a polygon edge`);
      if (!ring.faces.length) { warn(`seed edge p${L.a[seed]}-${L.b[seed]} has no quad on either side: nothing to split`); return g.clone(); }
      const f = Math.min(1, Math.max(0, p.fraction));
      const fracs = p.count <= 1 ? [f] : Array.from({ length: p.count }, (_, k) => (k + 1 + f - 0.5) / (p.count + 1));
      const ids = ring.rungs.map(([x, y]) => fracs.map((t) => fs.edgePoint(x, y, t)));
      ring.faces.forEach((face, i) => {
        const j = (i + 1) % ring.rungs.length;
        for (let k = 0; k < fracs.length; k++) fs.chord(face, ids[i][k], ids[j][k]);
      });
    }
    const out = fs.build();
    out.addEdgeGroup('split', new EdgeSet(fs.created));
    const pm = new Uint8Array(out.numPoints);
    for (const id of fs.inserted) pm[id] = 1;
    out.addGroup('point', 'split', pm);
    return refreshNormals(out);
  },
});

// ---------------------------------------------------------------- edge_divide

defineNode({
  type: 'edge_divide',
  category: 'topology',
  summary: 'Split edges into equal segments (polygons using them gain the new points); optionally connect them across quads like a loop cut.',
  description:
    'Every edge in "group" gets divisions-1 evenly spaced new points; all polygons (and polylines) using the edge gain ' +
    'them, so closed meshes stay closed. connect: a quad whose two opposite sides were divided (and whose other two were ' +
    'not) is split by edges joining their new points, so dividing a ring of parallel edges (e.g. group "ring:p0-1") ' +
    'inserts edge loops, like polysplit.',
  aliases: ['divide_edges', 'edgedivide', 'subdivide_edges', 'split_edges'],
  inputs: [{ name: 'geo', desc: 'polygons and/or polylines' }],
  params: {
    group: edgeParam('edges to divide ("" = all), e.g. "p0-1", "ring:p0-1", "boundary", an edge group'),
    divisions: { type: 'int', default: 2, min: 2, max: 256, desc: 'segments per edge (2 = one new point in the middle)', aliases: ['numdivs', 'segments'] },
    connect: { type: 'bool', default: false, desc: 'join the new points across quads with exactly two opposite sides divided' },
  },
  outputs: 'point group divided (new points); edge group divided (connecting edges, with connect)',
  example: { type: 'edge_divide', params: { group: 'ring:p0-1', divisions: 3, connect: true } },
  cook: ({ input, p }) => {
    const g = input(0);
    const es = edgeMask(g, p.group);
    const fs = new FaceSplitter(g);
    const D = Math.max(2, Math.floor(p.divisions));
    for (const [a, b] of es) for (let k = 1; k < D; k++) fs.edgePoint(a, b, k / D);
    if (p.connect)
      for (let pr = 0; pr < g.numPrims; pr++) {
        if (!g.primClosed[pr] || g.primSize(pr) !== 4) continue;
        const c = g.primPoints(pr);
        const div = [0, 1, 2, 3].map((k) => es.has(c[k], c[(k + 1) % 4]));
        const pair = div[0] && div[2] && !div[1] && !div[3] ? 0 : div[1] && div[3] && !div[0] && !div[2] ? 1 : -1;
        if (pair < 0) continue;
        const A = fs.pointsOn(c[pair], c[pair + 1]), B = fs.pointsOn(c[pair + 2], c[(pair + 3) % 4]);
        if (A.length !== B.length) continue;
        for (let j = 0; j < A.length; j++) fs.chord(pr, A[j].id, B[A.length - 1 - j].id);
      }
    const out = fs.build();
    const pm = new Uint8Array(out.numPoints);
    for (const id of fs.inserted) pm[id] = 1;
    out.addGroup('point', 'divided', pm);
    if (p.connect) out.addEdgeGroup('divided', new EdgeSet(fs.created));
    return refreshNormals(out);
  },
});

// ---------------------------------------------------------------- dissolve

defineNode({
  type: 'dissolve',
  category: 'topology',
  summary: 'Remove edges (or points) and merge the polygons around them into one; inline points of the dissolved edges removed.',
  description:
    'class edge: each set of faces joined by grouped edges becomes one polygon (its outline); edges whose two faces end ' +
    'up in the same polygon vanish too. Boundary and non-manifold edges cannot be dissolved and are skipped, and a region ' +
    'whose outline is not a single loop (a ring of faces, a whole closed surface) is left as it was. remove_inline_points ' +
    'then removes points of the dissolved edges that are left with exactly two edges (e.g. the points of a dissolved edge ' +
    'loop), keeping polygons at three corners or more. class point (Blender "dissolve vertices"): every polygon edge at the ' +
    'selected points is dissolved and the points are removed. Unlike delete (class edge), no hole is left. Merged polygons ' +
    'keep the attributes of their lowest-numbered face; all points are kept 1:1, so groups survive.',
  aliases: ['polydissolve', 'edge_dissolve', 'dissolve_edges', 'dissolve_points'],
  inputs: [{ name: 'geo', desc: 'polygon mesh' }],
  params: {
    group: edgeParam('edges to dissolve ("" = all interior edges); class point: a point pattern', { aliases: ['edges'] }),
    class: { type: 'enum', options: ['edge', 'point'], default: 'edge', desc: 'edge = dissolve the edges; point = dissolve the points (merge all their faces)', aliases: ['type', 'dissolve_class'] },
    remove_inline_points: { type: 'bool', default: true, desc: 'remove points of dissolved edges left with two edges', aliases: ['inline', 'removeinlinepoints'] },
    remove_degenerate: { type: 'bool', default: true, desc: 'drop polygons with fewer than 3 distinct points or no area' },
  },
  outputs: 'prim group dissolved (merged polygons)',
  example: { type: 'dissolve', params: { group: 'loop:p4-5' } },
  cook: ({ input, p, warn }) => {
    const g = input(0);
    let es: EdgeSet, forced: Uint8Array | null = null;
    if (p.class === 'point') {
      const pm = mask(g, 'point', p.group);
      forced = pm ?? new Uint8Array(g.numPoints).fill(1);
      es = new EdgeSet();
      forEachPrimEdge(g, (pr, _v0, _v1, a, b) => { if (g.primClosed[pr] && (forced![a] || forced![b])) es.add(a, b); });
    } else es = edgeMask(g, p.group);
    const r = dissolveEdges(g, es, { removeInline: p.remove_inline_points, removeDegenerate: p.remove_degenerate, removePoints: forced });
    if (es.size && !r.merged && r.boundarySkipped) warn(`nothing dissolved: the ${r.boundarySkipped} selected edges are boundary or non-manifold edges`);
    if (r.regionsSkipped) warn(`${r.regionsSkipped} region(s) left unmerged: their outline is not a single loop (a ring of faces or a whole closed surface)`);
    return refreshNormals(r.geo);
  },
});

// ---------------------------------------------------------------- edge_collapse

defineNode({
  type: 'edge_collapse',
  category: 'topology',
  summary: 'Collapse edges to points (midpoint, or the first/last point); chains collapse to one point; degenerate faces are removed.',
  description:
    'Points joined by grouped edges merge (connected chains and loops become one point at their centroid in center mode, ' +
    'the midpoint for a single edge). Polygons drop repeated corners; polygons left with fewer than three corners ' +
    '(polylines: two) are removed, so collapsing an edge of a triangle removes the triangle and a quad becomes a ' +
    'triangle. Attributes of merged points are averaged (center) or taken from the kept point. Edge groups follow the merge.',
  aliases: ['collapse', 'collapse_edges', 'edgecollapse', 'merge_edges'],
  inputs: [{ name: 'geo', desc: 'polygons and/or polylines' }],
  params: {
    group: edgeParam('edges to collapse ("" = all), e.g. "p0-1", "length<0.05", an edge group'),
    mode: { type: 'enum', options: ['center', 'first', 'last'], default: 'center', desc: 'where merged points go: centre of the merged points, or the lowest / highest point number among them', aliases: ['position', 'collapse_to'] },
  },
  outputs: 'point group collapsed (the merged points)',
  example: { type: 'edge_collapse', params: { group: 'length<0.05' } },
  cook: ({ input, p }) => {
    const g = input(0);
    const r = collapseEdges(g, edgeMask(g, p.group), p.mode as CollapseMode);
    return refreshNormals(r.geo);
  },
});

// ---------------------------------------------------------------- polybridge

defineNode({
  type: 'polybridge',
  category: 'topology',
  summary: 'Connect two edge chains/loops with a strip of quads (divisions, twist, curved blend); optionally removes the faces the loops enclose.',
  description:
    'source and target are edge patterns that must each form one open or closed chain, e.g. "border:hole_a" (the border ' +
    'of a prim group), "boundary" edges selected by group nodes, or "p0-1-2-3-0". Where a chain is a mesh boundary the ' +
    'bridge winds against the existing edges, so the result is consistent and bridging two holes of a closed mesh gives a ' +
    'closed mesh; otherwise the target direction is chosen geometrically. Closed chains are aligned by the rotation with ' +
    'the shortest rungs, then rotated by twist. Chains with different point counts are matched by normalised arc length ' +
    '(intermediate rows take the larger count; the smaller chain is zipped to them with triangles where needed). blend ' +
    'bends the rungs into cubic curves that leave and enter along the openings\' directions (each loop\'s Newell normal, ' +
    'signed to point out of the opening). delete_inner_faces removes the faces each loop cuts off (the smaller side), so ' +
    'selecting the borders of two faces and bridging them punches a tunnel.',
  aliases: ['bridge', 'bridge_loops', 'bridge_edges', 'bridge_edge_loops'],
  inputs: [{ name: 'geo', desc: 'mesh containing both chains' }],
  params: {
    source: edgeParam('first chain as an edge pattern, e.g. "border:hole1", "p0-1-2-3-0", an edge group', { aliases: ['source_group', 'from', 'a'] }),
    target: edgeParam('second chain as an edge pattern', { aliases: ['target_group', 'to', 'b'] }),
    divisions: { type: 'int', default: 1, min: 1, max: 256, desc: 'rows of polygons along the bridge', aliases: ['segments', 'rows'] },
    twist: { type: 'int', default: 0, desc: 'closed chains: rotate the target by this many points', aliases: ['offset', 'pairing_shift'] },
    blend: { type: 'float', default: 0, min: 0, max: 1, desc: '0 = straight rungs; 1 = curves leaving/entering along the openings\' normals', aliases: ['curvature', 'smoothness', 'tangent'] },
    reverse: { type: 'bool', default: false, desc: 'flip the winding of the bridge polygons', aliases: ['flip', 'reverse_winding'] },
    delete_inner_faces: { type: 'bool', default: false, desc: 'remove the faces each closed chain encloses (the smaller side), e.g. to bridge two faces into a tunnel', aliases: ['delete_faces', 'remove_caps'] },
  },
  outputs: 'prim group bridge',
  example: { type: 'polybridge', params: { source: 'border:hole_a', target: 'border:hole_b', divisions: 4, delete_inner_faces: true } },
  cook: ({ input, p }) => {
    const g0 = input(0);
    if (!String(p.source).trim() || !String(p.target).trim())
      throw new NodeError('polybridge: set the "source" and "target" edge patterns', 'e.g. source "border:hole_a", target "border:hole_b" (borders of prim groups), or chains like "p0-1-2-3-0"');
    const es = edgeMask(g0, p.source), et = edgeMask(g0, p.target);
    if (!es.size) throw new NodeError(`polybridge: source "${p.source}" matches no edge`);
    if (!et.size) throw new NodeError(`polybridge: target "${p.target}" matches no edge`);
    const A = run('polybridge (source)', () => orderChain(es)), B = run('polybridge (target)', () => orderChain(et));
    let g = g0;
    if (p.delete_inner_faces) {
      const da = enclosedFaces(g0, es), db = enclosedFaces(g0, et);
      if (da.some((x, i) => x || db[i])) g = g0.subsetPrims(Uint8Array.from(da, (x, i) => (x || db[i] ? 0 : 1)), false);
    }
    const r = run('polybridge', () => bridgeChains(g, A, B, { divisions: p.divisions, twist: p.twist, blend: p.blend, reverse: p.reverse }));
    return refreshNormals(r.geo.numPrims ? r.geo.removeUnusedPoints() : r.geo);
  },
});

// ---------------------------------------------------------------- polyfill

defineNode({
  type: 'polyfill',
  category: 'topology',
  summary: 'Fill boundary loops (holes) with quads, a quad grid, triangles or one n-gon. New faces in prim group "fill".',
  description:
    'quads: loops that are star-shaped around their centroid get a quad fan around a centre point (Houdini "Quadrilateral ' +
    'Fan"; an odd loop keeps one triangle), other loops are ear-clipped and the triangles paired into convex quads by ' +
    'quality (quad-dominant); interior points then get smooth_iterations Laplacian steps projected onto the loop plane. ' +
    'grid (Houdini "Quadrilateral Grid"): loops with an even point count are split into four sides a, b, a, b at their ' +
    'sharpest turns and filled with an a×b Coons-patch grid (smoothed by smooth_iterations); odd loops fall back to quads. ' +
    'triangles: ear clipping. single: one n-gon (fill_holes). New faces wind like the surrounding surface, so filling the ' +
    'holes of a mesh makes it watertight; they take point/vertex attributes from the loop and prim attributes from a ' +
    'neighbouring face.',
  aliases: ['fill_quads', 'quad_fill', 'grid_fill', 'poly_fill', 'cap_quads'],
  inputs: [{ name: 'geo', desc: 'mesh with holes' }],
  params: {
    mode: { type: 'enum', options: ['quads', 'grid', 'triangles', 'single'], default: 'quads', desc: 'quads = quad fan / paired quads; grid = Coons quad grid (even loops); triangles = ear clipping; single = one n-gon', aliases: ['fill_mode', 'fillmode'] },
    group: P.group('point', 'only loops touching these points ("" = every boundary loop)'),
    max_edges: { type: 'int', default: 0, min: 0, desc: 'skip loops with more edges than this (0 = no limit)', aliases: ['max_size'] },
    smooth_iterations: { type: 'int', default: 10, min: 0, max: 1000, desc: 'Laplacian relaxation steps for interior points', aliases: ['smooth', 'iterations', 'relax'] },
  },
  outputs: 'prim group fill',
  example: { type: 'polyfill', params: { mode: 'grid' } },
  cook: ({ input, p, warn }) => {
    const g = input(0);
    const he = halfEdges(g);
    const loops = he.boundaryLoops();
    const pm = mask(g, 'point', p.group);
    const sel = loops.filter((l) => (!p.max_edges || l.length <= p.max_edges) && (!pm || l.some((q) => pm[q])));
    if (!loops.length) warn('no boundary loops: nothing to fill');
    const b = new GeoBuilder(g);
    for (let i = 0; i < g.numPoints; i++) b.copyPoint(i);
    for (let pr = 0; pr < g.numPrims; pr++) {
      const vs: number[] = [];
      for (let v = g.primStart[pr]; v < g.primStart[pr + 1]; v++) vs.push(v);
      b.addPrim(vs.map((v) => g.vertexPoint[v]), !!g.primClosed[pr], pr, vs);
    }
    const grp = b.group('prim', 'fill');
    const notes = new Set<string>();
    const Pd = g.P;
    for (const loop of sel) {
      const patch = fillPatch(loop.map((q) => [Pd[q * 3], Pd[q * 3 + 1], Pd[q * 3 + 2]]), p.mode as FillMode, p.smooth_iterations);
      if (patch.note) notes.add(patch.note);
      // corners of the loop points in the neighbouring faces (boundary half-edges leaving them)
      const vtx = loop.map((q) => { const h = he.pointFirst[q]; return h >= 0 && he.heTwin[h] < 0 ? he.heVertex[h] : -1; });
      const h0 = he.pointFirst[loop[0]];
      const primSrc = h0 >= 0 ? he.heFace[h0] : -1;
      const ids = patch.points.map((pt) => b.addPoint(pt.pos[0], pt.pos[1], pt.pos[2], { i: pt.i.map((k) => loop[k]), w: pt.w }));
      for (const f of patch.faces) {
        const pts = f.map((k) => (k >= 0 ? loop[k] : ids[-k - 1]));
        const vs = f.map((k) => {
          if (k >= 0) return vtx[k] >= 0 ? vtx[k] : null;
          const pt = patch.points[-k - 1];
          return pt.i.every((j) => vtx[j] >= 0) ? { i: pt.i.map((j) => vtx[j]), w: pt.w } : null;
        });
        grp.add(b.addPrim(pts, true, primSrc, vs));
      }
    }
    for (const n of notes) warn(n);
    return refreshNormals(b.build());
  },
});
