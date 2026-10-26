// Measurement and verification nodes: curvature, occlusion (ambient occlusion / thickness / cavity),
// distance (to a surface, curves or points) and assert (in-graph checks an agent can rely on).
// The algorithms live in core/analysis.ts, shared with the explain / diff MCP tools.
import { Geometry } from '../core/geometry.ts';
import type { AttribClass } from '../core/geometry.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import { evalExpr, vecOut } from '../graph/params.ts';
import { pointNormals, primArea } from '../core/topology.ts';
import { halfEdges } from '../core/halfedge.ts';
import {
  CURVATURE_TYPES, RayScene, SurfaceQuery, bboxDiagonal, fmt, curvatureOfType, discreteCurvature, duplicatePoints,
  fillFromNearestValid, newNearest, nonManifoldPoints, percentileFit, pieceReport, rayMeasure, selfIntersections,
  shortEdges, smoothPointValues,
} from '../core/analysis.ts';
import type { PieceReport, RayMode } from '../core/analysis.ts';
import { P, getPointNormals, mask } from './util.ts';
import { andThen } from '../graph/parallel.ts';

const hasPolygons = (g: Geometry) => {
  for (let p = 0; p < g.numPrims; p++) if (g.primClosed[p] && g.primSize(p) >= 3) return true;
  return false;
};

// ---------------------------------------------------------------- curvature

defineNode({
  type: 'curvature',
  category: 'measure',
  summary: 'Per-point discrete curvature of a polygon mesh: mean, Gaussian, principal min/max or convexity.',
  description:
    'mean: signed mean curvature in 1/m from the cotangent Laplacian over the mixed Voronoi area (1 on a unit sphere, ' +
    'positive where the surface bulges along its normals, negative in creases). gaussian: angle deficit over the mixed ' +
    'area in 1/m² (positive on domes and bowls, negative on saddles). principal_min/max: H ∓ √(H² − K). convexity: ' +
    'sign of the mean curvature (1 convex, -1 concave, 0 flat). n-gons are measured through their triangulation. ' +
    'Boundary and non-manifold points take the value of the nearest interior point (a warning says how many). ' +
    'Typical use: colour or mask by curvature (wear on convex edges, dirt in concave creases).',
  aliases: ['measure_curvature'],
  inputs: [{ name: 'geo', desc: 'polygon mesh' }],
  params: {
    type: { type: 'enum', options: CURVATURE_TYPES, default: 'mean', desc: 'which curvature to write', aliases: ['curvature_type', 'mode'] },
    smooth_iterations: { type: 'int', default: 0, min: 0, max: 200, desc: 'Laplacian smoothing passes over the values (not the geometry)', aliases: ['smooth', 'blur'] },
    normalize: { type: 'bool', default: false, desc: 'fit the values to 0..1 between the clip_percent and 100 - clip_percent percentiles (constant values become 0.5)', aliases: ['fit'] },
    clip_percent: { type: 'float', default: 2, min: 0, max: 49, desc: 'normalize: percent of values clamped at each end before fitting (ignores spikes)' },
    name: { type: 'string', default: 'curvature', desc: 'output point attribute (float)', aliases: ['attrib', 'attribute'] },
  },
  outputs: 'point float <name> (default "curvature")',
  example: {
    nodes: {
      ball: { type: 'sphere', params: { type: 'ico', level: 4 } },
      rough: { type: 'noise_displace', in: ['ball'], params: { amplitude: 0.25, frequency: 2 } },
      k: { type: 'curvature', in: ['rough'], params: { type: 'mean', smooth_iterations: 2, normalize: true } },
      out: { type: 'color', in: ['k'], params: { mode: 'ramp', attrib: 'curvature', range: [0, 1] } },
    },
    output: 'out',
  },
  cook: ({ input, p, warn }) => {
    const g = input(0).clone();
    const out = g.points.add(p.name || 'curvature', 'float', 1).data as Float64Array;
    if (!hasPolygons(g)) {
      if (g.numPoints) warn('no polygons: curvature is 0 everywhere');
      return g;
    }
    const c = discreteCurvature(g, pointNormals(g));
    const unreached = fillFromNearestValid(g, c.valid, [c.mean, c.gaussian]);
    const v = curvatureOfType(p.type, c.mean, c.gaussian, bboxDiagonal(g));
    smoothPointValues(g, v, p.smooth_iterations);
    if (p.normalize) percentileFit(v, p.clip_percent);
    out.set(v);
    const parts: string[] = [];
    if (c.boundary) parts.push(`${c.boundary} boundary`);
    if (c.nonManifold) parts.push(`${c.nonManifold} non-manifold`);
    if (c.isolated) parts.push(`${c.isolated} polygon-free`);
    if (parts.length) warn(`${parts.join(', ')} point(s) have no complete one-ring: they took the value of the nearest interior point${unreached ? ` (${unreached} with none in reach got 0)` : ''}`);
    return g;
  },
});

// ---------------------------------------------------------------- occlusion / thickness / cavity

const RAY_NAMES: Record<RayMode, string> = { occlusion: 'ao', thickness: 'thickness', cavity: 'cavity' };

defineNode({
  type: 'occlusion',
  category: 'measure',
  summary: 'Ray-cast per-point measures: ambient occlusion (0 open … 1 enclosed), thickness in metres, or cavity (0..1).',
  description:
    'Casts `samples` stratified, seeded, cosine-weighted rays per point inside a cone around the point normal and tests ' +
    'them against the geometry itself plus the optional occluder input (a triangle BVH). occlusion → "ao": fraction of ' +
    'rays blocked within max_distance. cavity → "cavity": occlusion over a short range where near walls count most ' +
    '(crevices and inner corners light up, flat and convex areas are 0). thickness → "thickness": mean distance to the ' +
    'opposite wall along rays cast inward (against the normal) in metres, so it needs closed or double-walled geometry ' +
    'with outward normals; normalize divides by max_distance. The alias "thickness" still defaults to mode occlusion: ' +
    'set mode. Points outside `group` keep their values.',
  aliases: ['ambient_occlusion', 'ao', 'thickness'],
  inputs: [
    { name: 'geo', desc: 'points to measure (normals from N, else computed from the polygons)' },
    { name: 'occluder', desc: 'extra geometry the rays can hit (e.g. the ground under scattered rocks)', optional: true },
  ],
  params: {
    mode: { type: 'enum', options: ['occlusion', 'thickness', 'cavity'], default: 'occlusion', desc: 'what to measure' },
    samples: { type: 'int', default: 32, min: 1, max: 1024, desc: 'rays per point (stratified; more = smoother)', aliases: ['rays', 'count'] },
    max_distance: { type: 'float', default: 0, min: 0, desc: 'hits farther than this are ignored; 0 = auto (occlusion: unlimited, cavity: 5% of the scene diagonal, thickness: the scene diagonal)', aliases: ['maxdist', 'distance', 'radius'] },
    bias: { type: 'float', default: 0, min: 0, desc: 'ray start offset along the normal against self-hits; 0 = auto (1e-4 of the scene diagonal)' },
    cone_angle: { type: 'float', default: 0, min: 0, max: 90, desc: 'half-angle of the ray cone in degrees; 0 = auto (90 = hemisphere for occlusion and cavity, 15 for thickness: a slab reads within 2%)', aliases: ['angle', 'spread'] },
    seed: P.seed(),
    invert: { type: 'bool', default: false, desc: 'write 1 - value (thickness: max_distance - value), e.g. exposure instead of occlusion' },
    normalize: { type: 'bool', default: false, desc: 'thickness: divide by max_distance to get 0..1 (occlusion and cavity are always 0..1)' },
    group: P.group('point', 'points to measure ("" = all); the others keep their values'),
    name: { type: 'string', default: '', desc: 'output point attribute ("" = ao, thickness or cavity by mode)', aliases: ['attrib', 'attribute'] },
  },
  outputs: 'point float ao | thickness | cavity (or <name>)',
  example: {
    nodes: {
      rock: { type: 'sphere', params: { type: 'ico', level: 4 } },
      shape: { type: 'noise_displace', in: ['rock'], params: { amplitude: 0.35, frequency: 1.6 } },
      ao: { type: 'occlusion', in: ['shape'], params: { samples: 32 } },
      out: { type: 'color', in: ['ao'], params: { mode: 'ramp', attrib: 'ao', range: [0, 1], ramp: [[0, '#f2e6d0'], [1, '#2b2118']] } },
    },
    output: 'out',
  },
  cook: ({ input, hasInput, p, warn, stat, parallelMap }) => {
    const src = input(0);
    const g = src.clone();
    const mode = p.mode as RayMode;
    const occluders = hasInput(1) && input(1).numPrims ? Geometry.merge([src, input(1)]) : src;
    const scene = RayScene.of(occluders);
    const diag = bboxDiagonal(occluders) || bboxDiagonal(g) || 1;
    const maxD = p.max_distance > 0 ? p.max_distance : mode === 'cavity' ? 0.05 * diag : mode === 'thickness' ? diag : 0;
    const bias = p.bias > 0 ? p.bias : 1e-4 * diag;
    const cone = p.cone_angle > 0 ? p.cone_angle : mode === 'thickness' ? 15 : 90;
    const sel = mask(g, 'point', p.group);
    const a = g.points.add(p.name || RAY_NAMES[mode], 'float', 1).data as Float64Array;
    if (scene.empty) warn(`nothing for the rays to hit: geo has no polygons${hasInput(1) ? ' and neither has the occluder' : ' (connect an occluder as the second input)'}`);
    const opts = { mode, samples: p.samples, maxDistance: maxD, bias, coneAngle: cone, seed: p.seed };
    const finish = (v: Float64Array) => {
      const range = mode === 'thickness' ? maxD : 1;
      let measured = 0;
      for (let i = 0; i < g.numPoints; i++) {
        if (sel && !sel[i]) continue;
        measured++;
        let x = v[i];
        if (mode === 'thickness' && p.normalize) x = Math.min(1, x / maxD);
        if (p.invert) x = (mode === 'thickness' && !p.normalize ? range : 1) - x;
        a[i] = x;
      }
      stat('rays', measured * p.samples);
      return g;
    };
    if (scene.empty) return finish(rayMeasure(g.P, getPointNormals(g), scene, opts, sel));
    // kernel "occlusion": the points in chunks on the worker pool, the BVH shared with the workers as arrays
    const v = new Float64Array(g.numPoints);
    const run = parallelMap('occlusion', {
      count: g.numPoints, args: opts,
      inputs: { P: g.P, N: getPointNormals(g), sel }, results: { out: v }, shared: scene.toArrays(),
    }, { minElements: Math.ceil(32768 / Math.max(1, p.samples)) });
    return andThen(run, () => finish(v));
  },
});

// ---------------------------------------------------------------- distance

defineNode({
  type: 'distance',
  category: 'measure',
  summary: 'Distance from each point to a target: mesh surface (BVH), polylines, or points (KD-tree); optionally signed and with the nearest prim, uv and position.',
  description:
    'The target (second input) is measured as polygons (closest point on the surface), polylines (closest point on the ' +
    'segments) and, when it has no prims at all, its points. signed makes points inside a closed target negative ' +
    '(ray-parity inside test). extra also writes nearest_prim (int, -1 = none), nearest_uv (prim uv: triangle ' +
    'barycentrics like Houdini primuv, quad bilinear, polyline u 0..1) and nearest_P. Points farther than ' +
    'max_distance get max_distance and nearest_prim -1 (Houdini xyzdist with a max distance).',
  aliases: ['measure_distance', 'xyzdist'],
  inputs: [
    { name: 'geo', desc: 'points to measure from' },
    { name: 'target', desc: 'geometry to measure to (mesh, curves or points)' },
  ],
  params: {
    signed: { type: 'bool', default: false, desc: 'negative inside a closed polygon target' },
    max_distance: { type: 'float', default: 0, min: 0, desc: 'search radius (0 = unlimited); points beyond it get this value', aliases: ['maxdist', 'radius'] },
    extra: { type: 'bool', default: false, desc: 'also write nearest_prim, nearest_uv and nearest_P' },
    group: P.group('point', 'points to measure ("" = all); the others keep their values'),
    name: { type: 'string', default: 'dist', desc: 'output point attribute (float)', aliases: ['attrib', 'attribute'] },
  },
  outputs: 'point float dist (or <name>); with extra: int nearest_prim, vec3 nearest_uv, vec3 nearest_P',
  example: {
    nodes: {
      ground: { type: 'grid', params: { size: [6, 6], divisions: [60, 60] } },
      path: { type: 'curve', params: { points: [[-3, 0, -2], [-1, 0, 1], [1, 0, -1], [3, 0, 2]], smooth: true } },
      d: { type: 'distance', in: ['ground', 'path'] },
      out: { type: 'color', in: ['d'], params: { mode: 'ramp', attrib: 'dist', range: [0, 1.5] } },
    },
    output: 'out',
  },
  cook: ({ input, hasInput, p, warn }) => {
    if (!hasInput(1)) throw new NodeError('distance needs a target as its second input (a mesh, curves or points)', '"in": ["points", "target"]');
    const tgt = input(1);
    const q = new SurfaceQuery(tgt);
    if (q.empty) throw new NodeError(`the target (second input) is empty (${tgt.numPoints} points, ${tgt.numPrims} prims): nothing to measure to`);
    const g = input(0).clone();
    const d = g.points.add(p.name || 'dist', 'float', 1).data as Float64Array;
    const ex = p.extra
      ? { prim: g.points.add('nearest_prim', 'int', 1).data as Int32Array, uv: g.points.add('nearest_uv', 'float', 3).data as Float64Array, P: g.points.add('nearest_P', 'float', 3).data as Float64Array }
      : null;
    const signed = p.signed && q.hasPolygons;
    if (p.signed && !q.hasPolygons) warn(`signed needs a polygon target (the target is ${q.kind}): distances are unsigned`);
    if (signed) {
      const he = halfEdges(tgt);
      let open = 0;
      for (let e = 0; e < he.numEdges; e++) if (he.edgeValence(e) !== 2) open++;
      if (open) warn(`the target surface is not closed (${open} boundary or non-manifold edges): inside/outside may be wrong`);
    }
    const sel = mask(g, 'point', p.group);
    const maxD = p.max_distance > 0 ? p.max_distance : Infinity;
    const out = newNearest(), Pd = g.P;
    for (let i = 0; i < g.numPoints; i++) {
      if (sel && !sel[i]) continue;
      const x = Pd[i * 3], y = Pd[i * 3 + 1], z = Pd[i * 3 + 2];
      const found = q.nearest(x, y, z, maxD, out);
      const sign = signed && q.inside(x, y, z) ? -1 : 1;
      d[i] = sign * (found ? out.dist : maxD);
      if (!ex) continue;
      ex.prim[i] = found ? out.prim : -1;
      ex.uv[i * 3] = found ? out.u : 0; ex.uv[i * 3 + 1] = found ? out.v : 0; ex.uv[i * 3 + 2] = 0;
      ex.P[i * 3] = found ? out.x : x; ex.P[i * 3 + 1] = found ? out.y : y; ex.P[i * 3 + 2] = found ? out.z : z;
    }
    return g;
  },
});

// ---------------------------------------------------------------- assert

const v3 = (a: ArrayLike<number>) => `(${Array.from(a, (x) => fmt(x)).join(', ')})`;

/** A json param that is off (null/"") or a vec3 (a number broadcasts). */
function optVec3(name: string, v: any): number[] | null {
  if (v === null || v === undefined || v === '' || v === false) return null;
  if (typeof v === 'number') return [v, v, v];
  if (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x))) return v;
  throw new NodeError(`param "${name}" expects [x, y, z], a number, or null (off); got ${JSON.stringify(v)}`);
}

function optNumber(name: string, v: any): number | null {
  if (v === null || v === undefined || v === '' || v === false) return null;
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n === 'number' && Number.isFinite(n)) return n;
  throw new NodeError(`param "${name}" expects a number or null (off); got ${JSON.stringify(v)}`);
}

/** Names of the groups of every class, for messages. */
function groupList(g: Geometry): string {
  const out: string[] = [];
  for (const cls of ['point', 'vertex', 'prim', 'edge'] as const) for (const k of g.groupNames(cls)) out.push(`${cls} ${k}`);
  return out.join(', ') || 'none';
}

function attribList(g: Geometry): string {
  const out: string[] = [];
  for (const cls of ['point', 'vertex', 'prim', 'detail'] as AttribClass[]) { const n = g.table(cls).names(); if (n.length) out.push(`${cls} ${n.join(' ')}`); }
  return out.join('; ') || 'none';
}

/** The values assert's expr can read. */
export function assertScope(g: Geometry, pr: PieceReport): Record<string, any> {
  let polys = 0, lines = 0;
  for (let p = 0; p < g.numPrims; p++) if (g.primClosed[p]) polys++; else lines++;
  const b = g.bbox();
  const sum = (f: (x: PieceReport['pieces'][number]) => number) => pr.pieces.reduce((s, x) => s + f(x), 0);
  return {
    npoints: g.numPoints, nprims: g.numPrims, nvertices: g.numVertices, npolys: polys, nlines: lines,
    bbox: {
      min: vecOut(b.min.slice()), max: vecOut(b.max.slice()),
      size: vecOut([0, 1, 2].map((i) => b.max[i] - b.min[i])), center: vecOut([0, 1, 2].map((i) => (b.min[i] + b.max[i]) / 2)),
      empty: b.empty,
    },
    volume: sum((x) => x.volume), area: sum((x) => x.area), pieces: pr.pieces.length,
    open_pieces: pr.pieces.filter((x) => !x.closed).length, genus: sum((x) => x.genus),
    closed: pr.pieces.length > 0 && pr.pieces.every((x) => x.closed), boundary_edges: sum((x) => x.boundaryEdges),
  };
}

const EXPR_NAMES = 'npoints nprims nvertices npolys nlines bbox (.min .max .size .center, each with .x .y .z) volume area pieces open_pieces genus closed boundary_edges';

defineNode({
  type: 'assert',
  category: 'measure',
  packed: 'keep',
  summary: 'Check the geometry (watertight, counts, bbox, edge lengths, degenerate faces, self-intersections, attributes, groups, an expression) and fail, warn or mark when a check fails. Passes the geometry through.',
  description:
    'Every check is off by default; enable the ones that express what the graph must produce. on_fail error makes the ' +
    'node (and the graph) fail with one message listing each failed check and the measured value, so a build or edit ' +
    'reports a broken invariant right away. warn passes through with that message as a warning. mark passes through ' +
    'and writes detail assert_failed (number of failed checks) and assert_report (the message), plus point / prim ' +
    'groups assert_fail on the offending elements where a check can localise them (render {highlight:"assert_fail"}). ' +
    `expr is a JS expression over ${EXPR_NAMES}. Each cook records stats checks and failed.`,
  aliases: ['expect', 'check', 'verify'],
  inputs: [{ name: 'geo', desc: 'geometry to check (passed through)' }],
  params: {
    on_fail: { type: 'enum', options: ['error', 'warn', 'mark'], default: 'error', desc: 'error = fail the node; warn = pass through with a warning; mark = pass through and write assert_failed / assert_report / group assert_fail', aliases: ['onfail', 'action'] },
    label: { type: 'string', default: '', desc: 'what this assert guards, prefixed to the message', aliases: ['message', 'msg'] },
    watertight: { type: 'bool', default: false, desc: 'closed surface: only polygons, every edge shared by exactly two of them', aliases: ['closed'] },
    manifold: { type: 'bool', default: false, desc: 'no edge shared by 3+ polygons and no bowtie points (fans touching at a point)' },
    no_flipped: { type: 'bool', default: false, desc: 'neighbouring polygons wound consistently, and closed pieces face outward (positive volume; the walls of a cavity inside a hollow solid may face inward)', aliases: ['outward', 'consistent_winding'] },
    min_points: { type: 'int', default: -1, min: -1, max: 2147483647, desc: 'at least this many points (-1 = off)' },
    max_points: { type: 'int', default: -1, min: -1, max: 2147483647, desc: 'at most this many points (-1 = off)' },
    min_prims: { type: 'int', default: -1, min: -1, max: 2147483647, desc: 'at least this many prims (-1 = off)' },
    max_prims: { type: 'int', default: -1, min: -1, max: 2147483647, desc: 'at most this many prims (-1 = off)' },
    bbox_min: { type: 'json', default: null, desc: '[x, y, z] (or one number): no point may lie below it (null = off)' },
    bbox_max: { type: 'json', default: null, desc: '[x, y, z] (or one number): no point may lie above it (null = off)' },
    min_edge_length: { type: 'float', default: 0, min: 0, desc: 'no edge shorter than this (0 = off)' },
    no_degenerate: { type: 'bool', default: false, desc: 'no zero-area polygons (area <= tolerance²) and no two points within tolerance of each other' },
    no_self_intersections: { type: 'bool', default: false, desc: 'no two non-adjacent triangles cross each other (BVH search, capped at max_tests)', aliases: ['no_intersections'] },
    strict_intersections: { type: 'bool', default: false, desc: 'no_self_intersections also fails on touching contacts, coplanar overlaps and triangles folding through a shared corner or onto a shared edge', aliases: ['strict'] },
    max_tests: { type: 'int', default: 2000000, min: 1000, max: 1000000000, desc: 'self-intersections: candidate triangle pairs to test before stopping (the message says when it stopped)', advanced: true },
    attrib: { type: 'string', default: '', desc: 'attribute that must exist ("" = off)', aliases: ['attribute'] },
    attrib_class: { type: 'enum', options: ['auto', 'point', 'vertex', 'prim', 'detail'], default: 'auto', desc: 'where attrib must live (auto = any class: vertex, point, prim, detail)' },
    attrib_min: { type: 'json', default: null, desc: 'attrib: smallest allowed value of its first component (null = off)' },
    attrib_max: { type: 'json', default: null, desc: 'attrib: largest allowed value of its first component (null = off)' },
    group: { type: 'string', default: '', desc: 'group name (any class) that must exist and be non-empty ("" = off)' },
    expr: { type: 'code', default: '', desc: `JS expression that must be true ("" = off) over ${EXPR_NAMES}; e.g. "volume > 1 && pieces == 1"`, aliases: ['expression', 'condition'] },
    tolerance: { type: 'float', default: 1e-6, min: 0, desc: 'distance tolerance for bbox_min/max and duplicate points', advanced: true },
  },
  outputs: 'passes geometry through; mark: detail int assert_failed, detail string assert_report, point/prim group assert_fail',
  example: {
    nodes: {
      body: { type: 'box', params: { size: [1, 2, 1], center: [0, 1, 0] } },
      check: { type: 'assert', in: ['body'], params: { watertight: true, no_flipped: true, bbox_min: [-1, 0, -1], bbox_max: [1, 2.5, 1], expr: 'volume > 1.5 && pieces == 1' } },
    },
    output: 'check',
  },
  cook: ({ input, p, warn, stat, engine }) => {
    const src = input(0);
    const g = src;
    const fails: string[] = [];
    const ptFail = new Uint8Array(g.numPoints), primFail = new Uint8Array(g.numPrims);
    let checks = 0;
    let prCache: PieceReport | null = null;
    const pieces = () => prCache ?? (prCache = pieceReport(g));
    const fail = (name: string, msg: string) => fails.push(`${name}: ${msg}`);
    const tol = p.tolerance;

    if (p.watertight) {
      checks++;
      const pr = pieces();
      const polys = pr.pieces.reduce((s, x) => s + x.polys, 0), lines = pr.pieces.reduce((s, x) => s + x.lines, 0);
      const be = pr.pieces.reduce((s, x) => s + x.boundaryEdges, 0), nme = pr.pieces.reduce((s, x) => s + x.nonManifoldEdges, 0);
      const loops = pr.pieces.reduce((s, x) => s + x.boundaryLoops, 0);
      if (!polys) fail('watertight', `no polygons (${g.numPoints} points, ${lines} polylines)`);
      else if (be || nme || lines) {
        const open = pr.pieces.filter((x) => !x.closed).length;
        const bits: string[] = [];
        if (be) bits.push(`${be} boundary edges in ${loops} hole(s)`);
        if (nme) bits.push(`${nme} edges shared by 3+ polygons`);
        if (lines) bits.push(`${lines} polylines`);
        fail('watertight', `${bits.join(', ')}; ${open} of ${pr.pieces.length} piece(s) open`);
        const he = halfEdges(g);
        for (let e = 0; e < he.numEdges; e++) if (he.edgeValence(e) !== 2) for (const f of he.edgeFaces(e)) primFail[f] = 1;
        for (let q = 0; q < g.numPrims; q++) if (!g.primClosed[q]) primFail[q] = 1;
      }
    }
    if (p.manifold) {
      checks++;
      const he = halfEdges(g);
      let multi = 0;
      for (let e = 0; e < he.numEdges; e++) if (he.edgeValence(e) > 2) { multi++; for (const f of he.edgeFaces(e)) primFail[f] = 1; }
      const bow = nonManifoldPoints(g);
      for (const q of bow) ptFail[q] = 1;
      if (multi || bow.length) fail('manifold', `${multi} edges shared by 3+ polygons, ${bow.length} bowtie point(s)`);
    }
    if (p.no_flipped) {
      checks++;
      const pr = pieces();
      const inward = pr.pieces.map((x, k) => ({ x, k })).filter(({ x }) => x.closed && x.volume < 0 && !x.cavity);
      if (pr.flippedEdges || inward.length) {
        const bits: string[] = [];
        if (pr.flippedEdges) bits.push(`${pr.flippedEdges} edges between oppositely wound polygons`);
        if (inward.length) bits.push(`${inward.length} closed piece(s) facing inward (volume ${inward.slice(0, 3).map(({ x }) => fmt(x.volume)).join(', ')}${inward.length > 3 ? ', …' : ''}; use reverse)`);
        fail('no_flipped', bits.join('; '));
        for (let q = 0; q < g.numPrims; q++) {
          const pc = pr.primPiece[q] >= 0 ? pr.pieces[pr.primPiece[q]] : null;
          if (pr.flippedPrims[q] || (pc && pc.closed && pc.volume < 0 && !pc.cavity)) primFail[q] = 1;
        }
      }
    }
    const count = (label: string, have: number, lim: number, atLeast: boolean) => {
      if (lim < 0) return;
      checks++;
      if (atLeast ? have < lim : have > lim) fail(label, `${have.toLocaleString('en-US')} ${label.endsWith('points') ? 'points' : 'prims'} (want ${atLeast ? '>=' : '<='} ${lim.toLocaleString('en-US')})`);
    };
    count('min_points', g.numPoints, p.min_points, true);
    count('max_points', g.numPoints, p.max_points, false);
    count('min_prims', g.numPrims, p.min_prims, true);
    count('max_prims', g.numPrims, p.max_prims, false);
    const bmin = optVec3('bbox_min', p.bbox_min), bmax = optVec3('bbox_max', p.bbox_max);
    if (bmin || bmax) {
      checks++;
      const P = g.P;
      let outside = 0;
      for (let i = 0; i < g.numPoints; i++) {
        let out = false;
        for (let c = 0; c < 3; c++) {
          const x = P[i * 3 + c];
          if ((bmin && x < bmin[c] - tol) || (bmax && x > bmax[c] + tol)) out = true;
        }
        if (out) { outside++; ptFail[i] = 1; }
      }
      if (outside) {
        const b = g.bbox();
        fail('bbox', `${outside} point(s) outside${bmin ? ` min ${v3(bmin)}` : ''}${bmax ? ` max ${v3(bmax)}` : ''}; geometry spans ${v3(b.min)} .. ${v3(b.max)}`);
      }
    }
    if (p.min_edge_length > 0) {
      checks++;
      const r = shortEdges(g, p.min_edge_length);
      if (r.count) {
        fail('min_edge_length', `${r.count} edge(s) shorter than ${fmt(p.min_edge_length)} (shortest ${fmt(r.shortest)})`);
        for (let q = 0; q < g.numPrims; q++) if (r.prims[q]) primFail[q] = 1;
      }
    }
    if (p.no_degenerate) {
      checks++;
      let zero = 0;
      const amin = tol * tol;
      for (let q = 0; q < g.numPrims; q++) {
        if (!g.primClosed[q]) continue;
        if (g.primSize(q) < 3 || primArea(g, q) <= amin) { zero++; primFail[q] = 1; }
      }
      const dup = duplicatePoints(g, tol);
      for (let i = 0; i < g.numPoints; i++) if (dup.mask[i]) ptFail[i] = 1;
      if (zero || dup.count) fail('no_degenerate', `${zero} zero-area polygon(s), ${dup.count} point(s) within ${fmt(tol)} of another${dup.count ? ' (fuse them)' : ''}`);
    }
    if (p.no_self_intersections) {
      checks++;
      const r = selfIntersections(g, p.max_tests, { strict: p.strict_intersections });
      const capped = r.capped ? ` (search stopped after ${r.tested.toLocaleString('en-US')} candidate pairs: there may be more)` : '';
      if (r.pairs) {
        fail('no_self_intersections', `${r.pairs} pair(s) of ${p.strict_intersections ? 'intersecting or touching' : 'crossing'} triangles${capped}`);
        for (let q = 0; q < g.numPrims; q++) if (r.prims[q]) primFail[q] = 1;
      } else if (r.capped) warn(`no_self_intersections: none found, but the search stopped after ${r.tested.toLocaleString('en-US')} candidate pairs (raise max_tests to check everything)`);
    }
    if (p.attrib) {
      checks++;
      const order: AttribClass[] = p.attrib_class === 'auto' ? ['vertex', 'point', 'prim', 'detail'] : [p.attrib_class];
      const f = g.findAttrib(p.attrib, order);
      const lo = optNumber('attrib_min', p.attrib_min), hi = optNumber('attrib_max', p.attrib_max);
      if (!f) fail('attrib', `"${p.attrib}" does not exist${p.attrib_class !== 'auto' ? ` on ${p.attrib_class}` : ''} (attributes: ${attribList(g)})`);
      else if (lo !== null || hi !== null) {
        if (f.attr.type === 'string') fail('attrib', `"${p.attrib}" is a string attribute: attrib_min/max need numbers`);
        else {
          const a = f.attr, d = a.data as Float64Array, s = a.size, n = a.count;
          let bad = 0, mn = Infinity, mx = -Infinity;
          const vp = f.cls === 'vertex' ? g.vertexPrims() : null;
          for (let i = 0; i < n; i++) {
            const x = d[i * s];
            if (x < mn) mn = x;
            if (x > mx) mx = x;
            if ((lo !== null && !(x >= lo)) || (hi !== null && !(x <= hi))) {
              bad++;
              if (f.cls === 'point') ptFail[i] = 1;
              else if (f.cls === 'prim') primFail[i] = 1;
              else if (vp) primFail[vp[i]] = 1;
            }
          }
          if (bad) fail('attrib', `${bad} ${f.cls} value(s) of "${p.attrib}"${s > 1 ? '[0]' : ''} outside ${lo !== null ? fmt(lo) : '-inf'} .. ${hi !== null ? fmt(hi) : 'inf'} (range ${fmt(mn)} .. ${fmt(mx)})`);
        }
      }
    }
    if (p.group) {
      checks++;
      const name = String(p.group);
      let found: string | null = null, size = 0;
      for (const cls of ['point', 'prim', 'vertex'] as const) {
        const m = g.groups(cls).get(name);
        if (m) { found = cls; size = m.reduce((s, x) => s + x, 0); break; }
      }
      if (!found && g.edgeGroups.has(name)) { found = 'edge'; size = g.edgeGroups.get(name)!.size; }
      if (!found) fail('group', `"${name}" does not exist (groups: ${groupList(g)})`);
      else if (!size) fail('group', `${found} group "${name}" is empty`);
    }
    if (String(p.expr ?? '').trim()) {
      checks++;
      const src = String(p.expr).trim();
      const scope = assertScope(g, pieces());
      let res: any;
      try { res = evalExpr(src, scope, { host: engine.host, timeoutMs: engine.scriptTimeoutMs }); }
      catch (e: any) {
        // evalExpr's message names the "=expr" and lists the scope; keep the cause, the hint lists the names
        const why = /failed: ([\s\S]*?)\. Vars in scope/.exec(e.message)?.[1] ?? /: ([^:]*)$/.exec(e.message)?.[1] ?? e.message;
        throw new NodeError(`assert expr "${src}" cannot be evaluated: ${why}`, `expr can read ${EXPR_NAMES}`);
      }
      if (!res) {
        const used = Object.keys(scope).filter((k) => new RegExp(`\\b${k}\\b`).test(src));
        const val = (k: string) => {
          const x = scope[k];
          if (k === 'bbox') return `bbox ${v3(x.min)} .. ${v3(x.max)}`;
          return `${k} ${typeof x === 'number' ? fmt(x) : String(x)}`;
        };
        fail('expr', `"${src}" is false${used.length ? ` (${used.map(val).join(', ')})` : ''}`);
      }
    }

    stat('checks', checks);
    stat('failed', fails.length);
    if (!checks) warn('no checks enabled: set e.g. watertight, max_points, bbox_max, min_edge_length or expr');
    const msg = fails.length ? `${p.label ? p.label + ': ' : ''}${fails.length} of ${checks} check(s) failed — ${fails.join('; ')}` : '';
    if (p.on_fail === 'mark') {
      const out = src.clone();
      out.detail.add('assert_failed', 'int', 1).set(0, fails.length);
      out.detail.add('assert_report', 'string', 1).set(0, msg);
      if (ptFail.some((x) => x)) out.addGroup('point', 'assert_fail', ptFail);
      if (primFail.some((x) => x)) out.addGroup('prim', 'assert_fail', primFail);
      return out;
    }
    if (!fails.length) return src;
    if (p.on_fail === 'warn') { warn(msg); return src; }
    throw new NodeError(msg, 'fix the geometry, or use on_fail "mark" and render {highlight: "assert_fail"} to see where');
  },
});
