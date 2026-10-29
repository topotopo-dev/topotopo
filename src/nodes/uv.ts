// UV toolkit: automatic unwrap (xatlas), LSCM flattening, island layout/packing, automatic seams.
// UVs are the vertex attribute `uv` (u, v, 0); charts/islands are reported as prim int attributes.
import type { Geometry } from '../core/geometry.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import { primArea, primNormals, triangulate } from '../core/topology.ts';
import {
  buildCharts, chartNeedsCut, cutGraph, edgeGroupTest, findIslands, lscm, normaliseCharts,
  pairsWhere, pointPairTest, polygonSides, primComponents, cornerClasses, readUV, uvSeamPairs, writeUV,
} from '../core/uv.ts';
import type { Island, Sides } from '../core/uv.ts';
import { packCharts } from '../core/uvpack.ts';
import { uvOverlapCheck, uvPairText } from '../core/uvoverlap.ts';
import { primWhere } from '../core/report.ts';
import { loadXatlas, runXatlas } from '../core/xatlas.ts';
import { unwrapMesh } from '../core/unwrap.ts';
import type { XatlasChartOptions } from '../core/xatlas.ts';
import { mask, P } from './util.ts';

const SEAM_GROUP = 'seams';

/** Total polygon area and triangle count estimate (for the automatic chart-size limit). */
function areaAndTris(g: Geometry, primMask?: ArrayLike<number> | null) {
  let area = 0, tris = 0;
  for (let p = 0; p < g.numPrims; p++) {
    if (!g.primClosed[p] || (primMask && !primMask[p])) continue;
    const n = g.primSize(p);
    if (n < 3) continue;
    area += primArea(g, p);
    tris += n - 2;
  }
  return { area, tris };
}

/** Seam pairs from existing uv discontinuities, the `seams` edge group, extra point pairs and a chart attribute. */
function seamPairs(g: Geometry, S: Sides, o: { uvSeams: boolean; pairs?: any; chartAttrib?: string }): Uint8Array {
  const cut = new Uint8Array(S.count);
  if (o.uvSeams) {
    const uv = readUV(g);
    if (uv) cut.set(uvSeamPairs(S, uv));
  }
  const eg = edgeGroupTest(g, SEAM_GROUP);
  if (eg) pairsWhere(g, S, eg, cut);
  const pp = pointPairTest(o.pairs);
  if (pp) pairsWhere(g, S, pp, cut);
  if (o.chartAttrib) {
    const a = g.prims.get(o.chartAttrib);
    if (a && a.type !== 'string') {
      const d = a.data as Float64Array | Int32Array, s = a.size;
      for (let i = 0; i < S.count; i++) if (d[S.pA[i] * s] !== d[S.pB[i] * s]) cut[i] = 1;
    }
  }
  return cut;
}

function writePrimInt(g: Geometry, name: string, vals: ArrayLike<number>) {
  if (!name) return;
  g.prims.delete(name);
  (g.prims.add(name, 'int', 1).data as Int32Array).set(vals);
}

/** Islands (vertex lists, 3D and UV area) for a per-prim component labelling. */
function islandsFrom(g: Geometry, uv: Float64Array, comp: Int32Array, count: number): Island[] {
  const out: Island[] = Array.from({ length: count }, () => ({ prims: [], verts: [], area3: 0, areaUV: 0 }));
  for (let p = 0; p < g.numPrims; p++) {
    const c = comp[p];
    if (c < 0) continue;
    const isl = out[c];
    isl.prims.push(p);
    isl.area3 += primArea(g, p);
    const s = g.primStart[p], e = g.primStart[p + 1];
    let a = 0;
    for (let v = s; v < e; v++) {
      isl.verts.push(v);
      const w = v + 1 < e ? v + 1 : s;
      a += uv[v * 2] * uv[w * 2 + 1] - uv[w * 2] * uv[v * 2 + 1];
    }
    isl.areaUV += Math.abs(a) / 2;
  }
  return out;
}

/** Padding in texels of `resolution` (units "uv": a fraction of the tile), at most a fifth of the tile. */
function paddingTexels(padding: number, units: string, resolution: number) {
  const res = Math.max(1, resolution);
  const pad = units === 'uv' ? padding * res : padding;
  return Math.max(0, Math.min(0.2 * res, pad));
}

const LAYOUT_PARAMS = {
  padding: { type: 'float' as const, default: 4, min: 0, desc: 'gap between islands, in texels at `resolution` (or uv units with units:"uv"); half of it, rounded up, to the tile border' },
  units: { type: 'enum' as const, options: ['texels', 'uv'], default: 'texels', desc: 'unit of padding' },
  resolution: { type: 'int' as const, default: 1024, min: 16, max: 16384, desc: 'texture size: padding is in its texels, and islands are placed on its texel grid (at most 2048 cells per tile)' },
};

interface LayoutRun {
  rotate: boolean;
  scaleMode: 'uniform' | 'keep';
  /** texels, and the texture size they are measured at */
  padding: number;
  resolution: number;
  tiles: number;
  iterations: number;
  seed: number;
  /** per island texel weight and fixed angle (radians, NaN = by rotate), or null */
  weights?: ArrayLike<number> | null;
  angles?: ArrayLike<number> | null;
  /** names for messages: the node, and island_attrib when islands come from it */
  node: string;
  islandAttrib?: string;
}

/**
 * Lay islands out with the raster packer (core/uvpack.ts); prims in no island keep their uv and are obstacles. The
 * result is checked exactly (core/uvoverlap.ts): overlaps between islands (never expected: a packing bug) and overlaps
 * inside islands (kept from the input) are reported with the parts they are in.
 */
function layoutIslands(g: Geometry, uv: Float64Array, islands: Island[], islandOfPrim: Int32Array, o: LayoutRun, warn: (m: string) => void): Float64Array {
  if (!islands.length) return uv;
  const tri = triangulate(g);
  const per: number[][] = islands.map(() => []);
  const obstacles: number[] = [];
  for (let t = 0; t < tri.triPrim.length; t++) {
    const k = islandOfPrim[tri.triPrim[t]];
    if (k >= 0) per[k].push(tri.tris[t * 3], tri.tris[t * 3 + 1], tri.tris[t * 3 + 2]);
    else for (let c = 0; c < 3; c++) { const v = tri.tris[t * 3 + c]; obstacles.push(uv[v * 2], uv[v * 2 + 1]); }
  }
  const r = packCharts(uv, islands.map((isl, k) => ({ verts: isl.verts, tris: per[k], area3: isl.area3, areaUV: isl.areaUV })), {
    resolution: o.resolution, padding: o.padding, turns: o.rotate, orient: o.rotate ? 'min_rect' : 'keep', scaleMode: o.scaleMode,
    tiles: o.tiles, iterations: o.iterations, seed: o.seed, weights: o.weights ?? null, angles: o.angles ?? null,
    obstacles: obstacles.length ? Float64Array.from(obstacles) : null,
  });
  if (!r.packed) {
    const why = obstacles.length ? 'the prims outside the group and the padding leave no room' : `${o.padding} texels of padding at resolution ${o.resolution} leave no room`;
    warn(`${o.node}: the ${islands.length} islands do not fit ${o.tiles > 1 ? `${o.tiles} tiles` : 'the tile'} at any scale (${why}); uv unchanged`);
    return uv;
  }
  const chk = uvOverlapCheck(r.uv, tri.tris, tri.triPrim, islandOfPrim);
  if (chk.across && chk.firstAcross) warn(`${o.node}: ${chk.across} triangle pairs of different islands overlap after packing; this is a bug, please report it with the graph. Largest: ${uvPairText(g, r.uv, tri.tris, tri.triPrim, chk.firstAcross.t[0], chk.firstAcross.t[1])}`);
  if (chk.within && chk.firstWithin) warn(`${o.node}: ${chk.within} overlapping triangle pairs inside islands were already in the input (folds${o.islandAttrib ? `, or pieces joined by island_attrib "${o.islandAttrib}"` : ''}); packing moves each island whole, so they stay. Largest: ${uvPairText(g, r.uv, tri.tris, tri.triPrim, chk.firstWithin.t[0], chk.firstWithin.t[1])}`);
  const used = r.uvArea / Math.max(1, r.tilesUsed);
  if (r.cappedBy >= 0 && used < 0.5) warn(`${o.node}: islands cover ${(used * 100).toFixed(0)}% of the tile because the longest island (${primWhere(g, islands[r.cappedBy].prims[0])}) spans the tile and sets the scale; cut it with seams for a denser layout`);
  return r.uv;
}

// ---------------------------------------------------------------- uv_unwrap

defineNode({
  type: 'uv_unwrap',
  category: 'uv',
  summary: 'Automatic UV unwrap: xatlas cuts and flattens charts per connected piece; they are packed without overlaps into the 0..1 square. Polygons are kept.',
  description:
    'Charts grow over faces of similar orientation (weights below); each chart is flattened (LSCM, planar or ortho). Every connected piece is ' +
    'charted on its own, so a small part of a merged model unwraps as it would alone. Polygons are triangulated for xatlas; the output keeps the ' +
    'polygons, with per-corner uv (seams split vertices, not points). A polygon xatlas cuts across two charts becomes its triangles ' +
    '(straddling split), so its uv stays exact. Faces with no area are not charted: their uv collapses onto a neighbour\'s chart. A chart that ' +
    'folds onto itself is charted again (lower cost, then per polygon, then per triangle). The charts are packed like uv_layout: on the texel ' +
    'grid of `resolution`, `padding` texels apart, uniform texel density, never overlapping; the result is checked and every warning names ' +
    'the part. Big smooth meshes chart slowly: max_chart_area -1 (auto) limits chart size above ~1000 triangles. Writes prim chart (and atlas ' +
    'with overflow stack).',
  aliases: ['uvunwrap', 'autouv', 'xatlas', 'uv_auto', 'unwrap'],
  inputs: [{ name: 'geo', desc: 'polygon geometry (polylines are skipped)' }],
  params: {
    use_seams: { type: 'bool', default: false, desc: 'keep existing seams: edges where uv is discontinuous, and a "seams" edge group, become chart borders xatlas never crosses (seams that do not cut a region apart are hints only)' },
    max_chart_area: { type: 'float', default: -1, min: -1, desc: 'largest chart area in world units²; 0 = unlimited (xatlas default), -1 = auto (unlimited below ~1000 triangles, then total area * 1000 / triangles to keep charting fast)' },
    max_boundary_length: { type: 'float', default: 0, min: 0, desc: 'longest chart boundary in world units (0 = unlimited)' },
    normal_deviation: { type: 'float', default: 2, min: 0, desc: 'weight of the angle between a face and the chart average normal', aliases: ['normal_deviation_weight'] },
    roundness: { type: 'float', default: 0.01, min: 0, desc: 'weight of chart roundness', aliases: ['roundness_weight'] },
    straightness: { type: 'float', default: 6, min: 0, desc: 'weight of straight chart boundaries', aliases: ['straightness_weight'] },
    normal_seam_weight: { type: 'float', default: 4, min: 0, desc: 'weight of normal seams (hard edges); > 1000 always cuts there' },
    texture_seam_weight: { type: 'float', default: 0.5, min: 0, desc: 'weight of existing texture seams' },
    max_cost: { type: 'float', default: 2, min: 0.01, desc: 'a chart stops growing when the weighted cost exceeds this; lower = more, flatter charts' },
    max_iterations: { type: 'int', default: 1, min: 1, max: 16, desc: 'chart growing/seeding iterations (higher = better charts, slower)' },
    straddling: { type: 'enum', options: ['split', 'unfold'], default: 'split', desc: 'a polygon xatlas cuts across charts: split = it becomes its triangles, each with its chart\'s exact uv; unfold = it stays one polygon, its other corners mapped onto its main chart (can overlap a neighbour)' },
    padding: { type: 'int', default: 2, min: 0, max: 64, desc: 'texels between charts (half of it, rounded up, to the tile border)' },
    resolution: { type: 'int', default: 1024, min: 16, max: 16384, desc: 'texture size: padding is in its texels and charts are placed on its texel grid' },
    texels_per_unit: { type: 'float', default: 0, min: 0, desc: 'texel density (texels per world unit); 0 = the largest density at which every chart fits one tile' },
    overflow: { type: 'enum', options: ['udim', 'shrink', 'stack'], default: 'udim', desc: 'charts that do not fit one tile at texels_per_unit: udim = more tiles to the right (1002, 1003, …), shrink = a lower density so they fit the tile, stack = more atlases all in 0..1 (prim atlas tells them apart)' },
    rotate_charts: { type: 'bool', default: true, desc: 'rotate each chart to its minimum bounding rectangle and allow 90° turns when packing (rotations keep the uv winding)' },
    iterations: { type: 'int', default: 4, min: 1, max: 64, desc: 'chart orders the packer tries; the densest wins' },
  },
  outputs: 'vertex uv, prim chart, prim atlas (overflow stack with several atlases)',
  example: { type: 'uv_unwrap', in: ['geo'], params: { padding: 4, resolution: 1024 } },
  cook: async ({ input, p, warn }) => {
    const src = input(0);
    const g = src.clone();
    if (!g.numPrims) return g;
    const X = await loadXatlas();
    const nv = g.numVertices;
    let vertexKey: Int32Array | null = null, faceGroup: Int32Array | null = null;
    if (p.use_seams) {
      const S = polygonSides(g);
      const cut = seamPairs(g, S, { uvSeams: true });
      faceGroup = primComponents(g, S, cut).comp;
      const uf = cornerClasses(g, S, cut);
      vertexKey = Int32Array.from({ length: nv }, (_, v) => uf.find(v));
    }
    const { area, tris } = areaAndTris(g);
    let maxChartArea = p.max_chart_area;
    if (maxChartArea < 0) maxChartArea = tris > 1000 ? (area * 1000) / tris : 0;
    const chart: XatlasChartOptions = {
      maxChartArea, maxBoundaryLength: p.max_boundary_length, normalDeviationWeight: p.normal_deviation,
      roundnessWeight: p.roundness, straightnessWeight: p.straightness, normalSeamWeight: p.normal_seam_weight,
      textureSeamWeight: p.texture_seam_weight, maxCost: p.max_cost, maxIterations: Math.max(1, Math.min(16, p.max_iterations)), fixWinding: true,
    };
    const r = unwrapMesh(X, g, {
      chart, vertexKey, faceGroup, straddling: p.straddling === 'unfold' ? 'unfold' : 'split', resolution: Math.max(16, p.resolution || 1024),
      padding: Math.max(0, p.padding), texelsPerUnit: Math.max(0, p.texels_per_unit), overflow: p.overflow, rotate: !!p.rotate_charts,
      iterations: Math.max(1, Math.min(64, Math.floor(p.iterations) || 1)),
    });
    const out = r.geo;
    writeUV(out, r.uv);
    writePrimInt(out, 'chart', r.chart);
    out.prims.delete('atlas');
    if (r.atlas) writePrimInt(out, 'atlas', r.atlas);
    const at = (prim: number) => primWhere(out, prim);
    const firstOf = (k: number) => { for (let q = 0; q < out.numPrims; q++) if (r.chart[q] === k) return q; return -1; };
    let open = 0;
    for (let pr = 0; pr < g.numPrims; pr++) if (!g.primClosed[pr]) open++;
    if (open) warn(`uv_unwrap: ${open} polylines skipped (only polygons are unwrapped)`);
    if (r.degenerate || r.isolated) warn(`uv_unwrap: ${r.degenerate + r.isolated} polygons have no area (xatlas cannot chart them); their uv is collapsed${r.degenerate ? ' onto a neighbour\'s chart' : ''}${r.isolated ? ` (${r.isolated} with no charted neighbour, each piece's on a spot of its own)` : ''}. First: ${primWhere(src, r.firstDegenerate)}`);
    if (r.straddled) warn(`uv_unwrap: ${r.straddled} polygons were cut across xatlas charts; ${p.straddling === 'unfold' ? 'their other corners were mapped onto the main chart (may overlap a neighbour)' : 'each became its triangles, which keep their charts\' uv'}. First: ${primWhere(src, r.firstStraddled)}`);
    const [rc, , rs] = r.refolded;
    if (rs) warn(`uv_unwrap: ${rc} charts folded onto themselves and were charted again (xatlas at a lower cost, then a conformal map); ${rs} still folded (a crack or a cone no flat map avoids) and were cut where they overlap, into ${r.splitInto} charts`);
    if (r.folds && r.foldPair) warn(`uv_unwrap: ${r.folds} triangle pairs overlap inside charts (folds). Largest: ${uvPairText(out, r.uv, r.tris, r.triPrim, r.foldPair[0], r.foldPair[1])}`);
    if (r.across && r.acrossPair) warn(`uv_unwrap: ${r.across} triangle pairs of different charts overlap; this is a bug, please report it with the graph. Largest: ${uvPairText(out, r.uv, r.tris, r.triPrim, r.acrossPair[0], r.acrossPair[1])}`);
    if (r.collapsed) warn(`uv_unwrap: ${r.collapsed} triangles with area got no uv area (collapsed: bakes and normal maps have no direction there)`);
    if (r.tiles > 1) warn(`uv_unwrap: at ${p.texels_per_unit} texels per unit the charts fill ${r.tiles} ${p.overflow === 'stack' ? 'atlases, stacked in 0..1 (see prim atlas)' : 'UDIM tiles (1001..)'}; overflow "shrink" keeps one tile`);
    if (r.cappedBy >= 0 && r.coverage < 0.5) { const q = firstOf(r.cappedBy); if (q >= 0) warn(`uv_unwrap: charts cover ${(r.coverage * 100).toFixed(0)}% of the tile because the longest chart (${at(q)}) spans the tile and sets the scale; lower max_chart_area or max_boundary_length to cut it`); }
    return out;
  },
});

// ---------------------------------------------------------------- uv_flatten

defineNode({
  type: 'uv_flatten',
  category: 'uv',
  summary: 'Flatten charts with LSCM (least squares conformal maps): angle-preserving UVs per chart, then pack them.',
  description:
    'Charts are the polygon regions bounded by seams: edges where the input uv is discontinuous (use_seams), the "seams" edge group, ' +
    'extra point pairs (seams param), changes of a prim chart attribute (e.g. from uv_autoseam or uv_unwrap), and the border of the group. ' +
    'Each chart is pinned at two far-apart border points (or the pins param) and solved by conjugate gradients. Closed charts (no border) and ' +
    'charts with handles are opened by a cut graph first (cut_closed). Each chart is scaled into 0..1, then laid out with uv_layout rules when layout is on.',
  aliases: ['uvflatten', 'lscm', 'uv_lscm', 'flatten_uv'],
  inputs: [{ name: 'geo', desc: 'polygon geometry, optionally with uv seams or a chart attribute' }],
  params: {
    method: { type: 'enum', options: ['lscm', 'abf'], default: 'lscm', desc: 'parameterisation: lscm (conformal, implemented); abf (angle-based flattening) is reserved and not implemented yet' },
    group: P.group('prim', 'prims to flatten (others keep their uv); the group border is a seam'),
    use_seams: { type: 'bool', default: true, desc: 'cut where the input uv is discontinuous' },
    seams: { type: 'json', default: [], desc: 'extra seam edges as point pairs [[a, b], ...]' },
    chart_attrib: { type: 'string', default: 'chart', desc: 'prim attribute whose changes are seams (ignored when missing; "" = off)' },
    pins: { type: 'json', default: [], desc: 'two point numbers to pin in every chart that contains both, e.g. [0, 12]; [] = the two farthest-apart border points' },
    cut_closed: { type: 'bool', default: true, desc: 'open closed charts and charts with handles with a cut graph (otherwise they fold)' },
    layout: { type: 'bool', default: true, desc: 'pack the charts into the 0..1 square (uniform texel density); off = every chart fills 0..1 on its own' },
    ...LAYOUT_PARAMS,
  },
  outputs: 'vertex uv, prim chart',
  example: { type: 'uv_flatten', in: ['geo'], params: { seams: [[0, 1], [1, 2]] } },
  cook: ({ input, p, warn }) => {
    if (p.method === 'abf') throw new NodeError('uv_flatten method "abf" is not implemented yet', 'use method "lscm" (conformal) or uv_unwrap (xatlas)');
    const g = input(0).clone();
    if (!g.numPrims) return g;
    const gm = p.group ? mask(g, 'prim', p.group) : null;
    const S = polygonSides(g, gm);
    const cut = seamPairs(g, S, { uvSeams: p.use_seams, pairs: p.seams, chartAttrib: p.chart_attrib });
    let { charts, chartOfPrim } = buildCharts(g, S, cut, gm);
    if (p.cut_closed) {
      let added = 0;
      charts.forEach((ch, c) => {
        if (!ch.prims.length || !chartNeedsCut(ch)) return;
        for (const i of cutGraph(g, S, cut, chartOfPrim, c, ch)) { if (!cut[i]) added++; cut[i] = 1; }
      });
      if (added) ({ charts, chartOfPrim } = buildCharts(g, S, cut, gm));
    } else {
      const closed = charts.filter((ch) => ch.prims.length && chartNeedsCut(ch)).length;
      if (closed) warn(`${closed} charts are closed or have handles and will fold; turn cut_closed on or add seams`);
    }
    const uv = readUV(g) ?? new Float64Array(g.numVertices * 2);
    const Pd = g.P;
    const pinPts = Array.isArray(p.pins) && p.pins.length >= 2 ? [Number(p.pins[0]), Number(p.pins[1])] : null;
    let worst = 0;
    for (const ch of charts) {
      const n = ch.point.length;
      if (!n) continue;
      const pos = new Float64Array(n * 3);
      for (let l = 0; l < n; l++) { const pt = ch.point[l]; pos[l * 3] = Pd[pt * 3]; pos[l * 3 + 1] = Pd[pt * 3 + 1]; pos[l * 3 + 2] = Pd[pt * 3 + 2]; }
      let pins: [number, number] | null = null;
      if (pinPts) {
        const a = ch.point.indexOf(pinPts[0]), b = ch.point.indexOf(pinPts[1]);
        if (a >= 0 && b >= 0 && a !== b) pins = [a, b];
      }
      const border: number[] = [];
      for (let l = 0; l < n; l++) if (ch.border[l]) border.push(l);
      const r = lscm(pos, ch.tris, pins, border);
      if (r.residual > worst) worst = r.residual;
      for (const [v, l] of ch.local) { uv[v * 2] = r.uv[l * 2]; uv[v * 2 + 1] = r.uv[l * 2 + 1]; }
    }
    const comp = chartOfPrim;
    const islands = islandsFrom(g, uv, comp, charts.length);
    normaliseCharts(uv, islands);
    let out = uv;
    if (p.layout && islands.length) {
      const fresh = islandsFrom(g, uv, comp, charts.length);
      out = layoutIslands(g, uv, fresh, comp, {
        rotate: true, scaleMode: 'uniform', padding: paddingTexels(p.padding, p.units, p.resolution), resolution: p.resolution,
        tiles: 1, iterations: 4, seed: 0, node: 'uv_flatten',
      }, warn);
    }
    writeUV(g, out);
    if (gm) {
      // prims outside the group keep their chart value (if any); flattened ones get new ids after the existing maximum
      const old = g.prims.get('chart');
      const base = old && old.type === 'int' ? Math.max(-1, ...Array.from(old.data as Int32Array)) + 1 : 0;
      const vals = new Int32Array(g.numPrims).fill(-1);
      for (let pr = 0; pr < g.numPrims; pr++) vals[pr] = comp[pr] >= 0 ? comp[pr] + base : old && old.type === 'int' ? (old.data as Int32Array)[pr] : -1;
      writePrimInt(g, 'chart', vals);
    } else writePrimInt(g, 'chart', comp);
    if (worst > 1e-3) warn(`LSCM solver stopped early (relative residual ${worst.toExponential(1)}); UVs may be slightly distorted`);
    return g;
  },
});

// ---------------------------------------------------------------- uv_layout

defineNode({
  type: 'uv_layout',
  category: 'uv',
  summary: 'Pack UV islands into the 0..1 square (or UDIM tiles) without overlaps: rotate to minimal bounds, equalise texel density, fill every gap.',
  description:
    'Islands are polygon regions whose uv is continuous across shared edges, or the values of island_attrib. Each island is rotated to its ' +
    'minimum-area bounding rectangle (rotate), scaled so texel density is uniform (scale_mode uniform: uv area ∝ 3D area) and placed on the ' +
    'texel grid of `resolution`: bottom-left, into any gap its shape fits (inside rings, between the arms of other islands), `padding` texels ' +
    'from every other island and half of it from the tile border, so islands never overlap. The scale is the largest at which every island ' +
    'fits; iterations tries other island orders and keeps the densest. Prims outside `group` keep their uv and the islands keep clear of them. ' +
    'The result is checked: overlaps inside an island (folds, or pieces joined by island_attrib) come from the input and are reported with the ' +
    'part they are in. UDIM tiles fill 1001, 1002, … (u offset), ten per row; an island goes to the first tile it fits.',
  aliases: ['uvlayout', 'uvpack', 'uv_pack', 'pack_uv'],
  inputs: [{ name: 'geo', desc: 'geometry with uv' }],
  params: {
    island_attrib: { type: 'string', default: '', desc: 'prim attribute defining islands (e.g. "chart"); "" = connected uv regions' },
    group: P.group('prim', 'prims to lay out; the others keep their uv and the islands keep clear of them (with padding)'),
    rotate: { type: 'bool', default: true, desc: 'rotate islands to their minimum bounding rectangle and allow 90° turns' },
    scale_mode: { type: 'enum', options: ['uniform', 'keep'], default: 'uniform', desc: 'uniform = same texel density on every island (by 3D area); keep = keep the relative uv scale' },
    ...LAYOUT_PARAMS,
    udims: { type: 'int', default: 1, min: 1, max: 100, desc: 'number of UDIM tiles to fill (1 = the 0..1 square)' },
    iterations: { type: 'int', default: 4, min: 1, max: 64, desc: 'island orders tried (longest side first, then tallest, largest box, largest area, then shuffles by seed); the densest wins' },
    seed: P.seed(),
    write_island: { type: 'bool', default: true, desc: 'write prim int attribute island' },
  },
  outputs: 'vertex uv, prim island',
  example: { type: 'uv_layout', in: ['geo'], params: { padding: 8, resolution: 2048 } },
  cook: ({ input, p, warn }) => {
    const g = input(0).clone();
    const uv = readUV(g);
    if (!uv) throw new NodeError('uv_layout: no uv attribute', 'run uv_project, uv_flatten or uv_unwrap first');
    const gm = p.group ? mask(g, 'prim', p.group) : null;
    let attr: Int32Array | Float64Array | null = null;
    if (p.island_attrib) {
      const a = g.prims.get(p.island_attrib);
      if (a && a.type !== 'string' && a.size === 1) attr = a.data as Int32Array | Float64Array;
      else warn(`island_attrib "${p.island_attrib}" is not a numeric prim attribute; using uv connectivity`);
    }
    const { islands, islandOfPrim } = findIslands(g, uv, attr, gm);
    const out = layoutIslands(g, uv, islands, islandOfPrim, {
      rotate: p.rotate, scaleMode: p.scale_mode, padding: paddingTexels(p.padding, p.units, p.resolution), resolution: p.resolution,
      tiles: p.udims, iterations: p.iterations, seed: Math.floor(Number(p.seed) || 0), node: 'uv_layout', islandAttrib: attr ? p.island_attrib : undefined,
    }, warn);
    writeUV(g, out);
    if (p.write_island) writePrimInt(g, 'island', islandOfPrim);
    return g;
  },
});

// ---------------------------------------------------------------- uv_autoseam

defineNode({
  type: 'uv_autoseam',
  category: 'uv',
  summary: 'Experimental: propose UV seams. Writes prim chart (disk-like regions) and point seam = 1 on chart borders, for uv_flatten.',
  description:
    'method xatlas uses the xatlas chart segmentation (same weights as uv_unwrap); method normal grows charts over faces within `angle` of the ' +
    'chart seed normal. Charts without a border (closed) or with handles are split by growing two halves from far-apart faces, so every chart can ' +
    'be flattened. Also writes the "seams" edge group when the geometry supports edge groups. Follow with uv_flatten (chart_attrib "chart").',
  aliases: ['uvautoseam', 'autoseam', 'uv_seams'],
  inputs: [{ name: 'geo', desc: 'polygon geometry' }],
  params: {
    method: { type: 'enum', options: ['xatlas', 'normal'], default: 'xatlas', desc: 'xatlas = chart segmentation by cost; normal = normal clustering by angle' },
    angle: { type: 'float', default: 45, min: 1, max: 180, desc: 'normal method: max angle between a face and its chart seed normal (degrees)' },
    max_chart_area: { type: 'float', default: -1, min: -1, desc: 'xatlas method: as in uv_unwrap (-1 auto, 0 unlimited)' },
    normal_deviation: { type: 'float', default: 2, min: 0, desc: 'xatlas method: weight of normal deviation' },
    max_cost: { type: 'float', default: 2, min: 0.01, desc: 'xatlas method: lower = more charts' },
  },
  outputs: 'prim chart, point seam, edge group seams (when available)',
  example: { type: 'uv_autoseam', in: ['geo'], params: { method: 'normal', angle: 50 } },
  cook: async ({ input, p, warn }) => {
    const g = input(0).clone();
    if (!g.numPrims) return g;
    let chart: Int32Array = new Int32Array(g.numPrims).fill(-1);
    const S = polygonSides(g);
    if (p.method === 'xatlas') {
      const X = await loadXatlas();
      const { area, tris } = areaAndTris(g);
      let mca = p.max_chart_area;
      if (mca < 0) mca = tris > 1000 ? (area * 1000) / tris : 0;
      const res = runXatlas(X, g, { maxChartArea: mca, normalDeviationWeight: p.normal_deviation, maxCost: p.max_cost }, null);
      const acc = new Map<number, Map<number, number>>();
      for (let t = 0; t < res.triPrim.length; t++) {
        const pr = res.triPrim[t], c = res.triChart[t];
        if (c < 0) continue;
        let m = acc.get(pr);
        if (!m) { m = new Map(); acc.set(pr, m); }
        m.set(c, (m.get(c) ?? 0) + 1);
      }
      for (const [pr, m] of acc) { let b = -1, bc = -1; for (const [c, n] of m) if (n > bc) { bc = n; b = c; } chart[pr] = b; }
      // prims xatlas ignored join a neighbour's chart
      for (let i = 0; i < S.count; i++) {
        if (chart[S.pA[i]] < 0 && chart[S.pB[i]] >= 0) chart[S.pA[i]] = chart[S.pB[i]];
        else if (chart[S.pB[i]] < 0 && chart[S.pA[i]] >= 0) chart[S.pB[i]] = chart[S.pA[i]];
      }
    } else {
      chart = normalCharts(g, S, p.angle);
    }
    // relabel to connected components (a chart id that is not connected becomes several charts)
    const cutOf = () => { const c = new Uint8Array(S.count); for (let i = 0; i < S.count; i++) if (chart[S.pA[i]] !== chart[S.pB[i]]) c[i] = 1; return c; };
    let split = 0;
    for (let round = 0; round < 4; round++) {
      const cut = cutOf();
      const built = buildCharts(g, S, cut);
      chart = built.chartOfPrim.slice();
      let next = built.charts.length, changed = false;
      built.charts.forEach((ch, c) => {
        if (ch.prims.length < 2 || !chartNeedsCut(ch)) return;
        // split in two by growing from two far-apart faces
        const halves = splitChart(g, S, cut, built.chartOfPrim, c, ch.prims);
        for (const pr of halves) chart[pr] = next;
        next++; split++; changed = true;
      });
      if (!changed) break;
    }
    writePrimInt(g, 'chart', chart);
    const seam = new Int32Array(g.numPoints);
    const cut = cutOf();
    const vp = g.vertexPoint;
    const seamEdges: [number, number][] = [];
    for (let i = 0; i < S.count; i++) if (cut[i]) { seam[vp[S.a1[i]]] = 1; seam[vp[S.b1[i]]] = 1; seamEdges.push([vp[S.a1[i]], vp[S.b1[i]]]); }
    g.points.delete('seam');
    (g.points.add('seam', 'int', 1).data as Int32Array).set(seam);
    const addEdgeGroup = (g as any).addEdgeGroup;
    if (typeof addEdgeGroup === 'function') {
      const set = addEdgeGroup.call(g, SEAM_GROUP);
      if (set && typeof set.add === 'function') for (const [a, b] of seamEdges) set.add(a, b);
    }
    if (split) warn(`${split} closed or handled charts were split in two`);
    return g;
  },
});

/** Region growing by normal angle from seed faces (prim order). */
function normalCharts(g: Geometry, S: Sides, angleDeg: number): Int32Array {
  const fn = primNormals(g);
  const cosT = Math.cos((Math.max(1, Math.min(180, angleDeg)) * Math.PI) / 180);
  const nb: number[][] = Array.from({ length: g.numPrims }, () => []);
  for (let i = 0; i < S.count; i++) { nb[S.pA[i]].push(S.pB[i]); nb[S.pB[i]].push(S.pA[i]); }
  const chart = new Int32Array(g.numPrims).fill(-1);
  let next = 0;
  for (let seed = 0; seed < g.numPrims; seed++) {
    if (chart[seed] >= 0 || !g.primClosed[seed] || g.primSize(seed) < 3) continue;
    const c = next++;
    chart[seed] = c;
    const nx = fn[seed * 3], ny = fn[seed * 3 + 1], nz = fn[seed * 3 + 2];
    const queue = [seed];
    for (let qi = 0; qi < queue.length; qi++) {
      for (const q of nb[queue[qi]]) {
        if (chart[q] >= 0) continue;
        if (fn[q * 3] * nx + fn[q * 3 + 1] * ny + fn[q * 3 + 2] * nz < cosT) continue;
        chart[q] = c;
        queue.push(q);
      }
    }
  }
  return chart;
}

/** Split a chart's prims into two halves grown (BFS) from two far-apart prims; returns the second half. */
function splitChart(g: Geometry, S: Sides, cut: Uint8Array, chartOfPrim: Int32Array, c: number, prims: number[]): number[] {
  const nb = new Map<number, number[]>();
  for (let i = 0; i < S.count; i++) {
    if (cut[i] || chartOfPrim[S.pA[i]] !== c) continue;
    if (!nb.has(S.pA[i])) nb.set(S.pA[i], []);
    if (!nb.has(S.pB[i])) nb.set(S.pB[i], []);
    nb.get(S.pA[i])!.push(S.pB[i]); nb.get(S.pB[i])!.push(S.pA[i]);
  }
  const bfs = (from: number[]) => {
    const d = new Map<number, number>();
    const q = [...from];
    for (const f of from) d.set(f, 0);
    for (let i = 0; i < q.length; i++) for (const w of nb.get(q[i]) ?? []) if (!d.has(w)) { d.set(w, d.get(q[i])! + 1); q.push(w); }
    return d;
  };
  const farthest = (d: Map<number, number>) => { let b = prims[0], bd = -1; for (const [k, v] of d) if (v > bd) { bd = v; b = k; } return b; };
  const a = farthest(bfs([prims[0]])), b = farthest(bfs([a]));
  const da = bfs([a]), db = bfs([b]);
  const half: number[] = [];
  for (const pr of prims) if ((db.get(pr) ?? Infinity) < (da.get(pr) ?? Infinity)) half.push(pr);
  // keep the second half connected to b (it is, by BFS ties going to a); guard empty halves
  if (!half.length) half.push(b);
  return half;
}
