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
import { cutLongCharts, islandWeights, packsDenser, worldAngles } from '../core/uvislands.ts';
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
  /** min_rect: minimum bounding rectangle, with 90° turns; world: world up to +v; keep: as the islands are */
  orient: 'min_rect' | 'world' | 'keep';
  scaleMode: 'uniform' | 'keep';
  /** texels, and the texture size they are measured at */
  padding: number;
  resolution: number;
  /** atlas: one tile, a texelsPerUnit too high for it is lowered; udim: up to `tiles` tiles, texelsPerUnit kept */
  fit: 'atlas' | 'udim';
  tiles: number;
  /** texels per island unit (world unit with scale_mode uniform); 0 = the largest at which the islands fit */
  texelsPerUnit: number;
  iterations: number;
  seed: number;
  /** prim attribute with texel weights ("" = none); cut long and hollow islands into parts */
  texelWeight: string;
  cutLong: boolean;
  /** names for messages: the node, and island_attrib when islands come from it */
  node: string;
  islandAttrib?: string;
}

interface LayoutOut {
  uv: Float64Array;
  /** island per prim after cutting, and the island count */
  labels: Int32Array;
  count: number;
  /** islands cut into parts; the texel weight attribute was found */
  cut: number;
  weighted: boolean;
}

/**
 * Lay islands out with the raster packer (core/uvpack.ts); prims in no island keep their uv and are obstacles. Texel
 * weights, world angles and cuts come from core/uvislands.ts. The result is checked exactly (core/uvoverlap.ts):
 * overlaps between islands (never expected: a packing bug) and overlaps inside islands (kept from the input) are
 * reported with the parts they are in.
 */
function layoutIslands(g: Geometry, uv: Float64Array, islands: Island[], islandOfPrim: Int32Array, o: LayoutRun, warn: (m: string) => void): LayoutOut {
  const res: LayoutOut = { uv, labels: islandOfPrim, count: islands.length, cut: 0, weighted: false };
  if (!islands.length) return res;
  const tiles = o.fit === 'udim' ? Math.max(1, Math.floor(o.tiles)) : 1;
  const tpu = Math.max(0, o.texelsPerUnit), fixed = tpu > 0 ? tpu / Math.max(1, o.resolution) : 0, spill = fixed > 0 && o.fit === 'udim';
  const tri = triangulate(g);
  const pack = (labels: Int32Array, isls: Island[]) => {
    const per: number[][] = isls.map(() => []);
    const obstacles: number[] = [];
    for (let t = 0; t < tri.triPrim.length; t++) {
      const k = labels[tri.triPrim[t]];
      if (k >= 0) per[k].push(tri.tris[t * 3], tri.tris[t * 3 + 1], tri.tris[t * 3 + 2]);
      else for (let c = 0; c < 3; c++) { const v = tri.tris[t * 3 + c]; obstacles.push(uv[v * 2], uv[v * 2 + 1]); }
    }
    const weights = o.texelWeight ? islandWeights(g, labels, isls.length, o.texelWeight) : null;
    const angles = o.orient === 'world' ? worldAngles(g, uv, labels, isls.length) : null;
    const r = packCharts(uv, isls.map((isl, k) => ({ verts: isl.verts, tris: per[k], area3: isl.area3, areaUV: isl.areaUV })), {
      resolution: o.resolution, padding: o.padding, turns: o.orient === 'min_rect', orient: o.orient === 'min_rect' ? 'min_rect' : 'keep', scaleMode: o.scaleMode,
      tiles, iterations: o.iterations, seed: o.seed, weights, angles, obstacles: obstacles.length ? Float64Array.from(obstacles) : null,
      texelsPerUnit: spill ? tpu : 0, maxTexelsPerUnit: spill ? 0 : tpu,
    });
    return { labels, isls, r, weights, obstacles: obstacles.length > 0 };
  };
  let best = pack(islandOfPrim, islands);
  res.weighted = !!best.weights;
  if (o.cutLong) {
    const c = cutLongCharts(g, uv, islandOfPrim, islands.length, { scaleMode: o.scaleMode, weights: best.weights, tiles, tileScale: spill ? fixed : 0, maxTileScale: spill ? 0 : fixed });
    if (c.cut) {
      // the parts only when they pack denser: a ring's hole often takes the small islands well enough
      const alt = pack(c.labels, islandsFrom(g, uv, c.labels, c.count));
      if (packsDenser(alt.r, best.r)) { best = alt; res.labels = c.labels; res.count = c.count; res.cut = c.cut; }
    }
  }
  const { labels, isls, r } = best;
  if (!r.packed) {
    const why = best.obstacles ? 'the prims outside the group and the padding leave no room' : `${o.padding} texels of padding at resolution ${o.resolution} leave no room`;
    warn(`${o.node}: the ${isls.length} islands do not fit ${tiles > 1 ? `${tiles} tiles` : 'the tile'} at any scale (${why}); uv unchanged`);
    return res;
  }
  res.uv = r.uv;
  const chk = uvOverlapCheck(r.uv, tri.tris, tri.triPrim, labels);
  if (chk.across && chk.firstAcross) warn(`${o.node}: ${chk.across} triangle pairs of different islands overlap after packing; this is a bug, please report it with the graph. Largest: ${uvPairText(g, r.uv, tri.tris, tri.triPrim, chk.firstAcross.t[0], chk.firstAcross.t[1])}`);
  if (chk.within && chk.firstWithin) warn(`${o.node}: ${chk.within} overlapping triangle pairs inside islands were already in the input (folds${o.islandAttrib ? `, or pieces joined by island_attrib "${o.islandAttrib}"` : ''}); packing moves each island whole, so they stay. Largest: ${uvPairText(g, r.uv, tri.tris, tri.triPrim, chk.firstWithin.t[0], chk.firstWithin.t[1])}`);
  const used = r.uvArea / Math.max(1, r.tilesUsed);
  if (r.cappedBy >= 0 && used < 0.5) warn(`${o.node}: islands cover ${(used * 100).toFixed(0)}% of the tile because the longest island (${primWhere(g, isls[r.cappedBy].prims[0])}) spans the tile and sets the scale; ${o.cutLong ? 'cut it with seams' : 'cut_long cuts it'} for a denser layout`);
  if (tpu > 0 && r.texelsPerUnit < tpu * 0.999) warn(`${o.node}: at ${tpu} texels per unit the islands do not fit ${tiles > 1 ? `${tiles} tiles` : 'the tile'}; packed at ${+r.texelsPerUnit.toPrecision(4)} texels per unit${o.fit === 'atlas' ? ' (fit "udim" keeps the density over more tiles)' : ' (raise udims for more tiles)'}`);
  return res;
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
    'folds onto itself is charted again (xatlas at a lower cost, then a conformal map) and, if it still folds, cut where it overlaps. Thin ' +
    'charts (bevel strips) join a neighbouring chart where their seam lines up (merge_thin); charts longer than the tile, rings and arcs are ' +
    'cut into parts when that packs denser (cut_long). The charts are packed like uv_layout: oriented (orient), on the texel grid of ' +
    '`resolution`, `padding` texels apart, uniform texel density times the texel_weight attribute, never overlapping, into the 0..1 tile ' +
    '(fit atlas) or more tiles at a fixed texels_per_unit (fit udim or stack); the result is checked and every warning names the part. Big ' +
    'smooth meshes chart slowly: max_chart_area -1 (auto) limits chart size above ~1000 triangles; a higher max_cost makes fewer, larger ' +
    'charts (less padding). Writes prim chart (and atlas with fit stack).',
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
    fit: { type: 'enum', options: ['atlas', 'udim', 'stack'], default: 'atlas', desc: 'charts that do not fit one tile at texels_per_unit: atlas = a lower density so they fit the 0..1 tile, udim = keep the density and fill more tiles to the right (1002, 1003, …), stack = more atlases all in 0..1 (prim atlas tells them apart)' },
    orient: { type: 'enum', options: ['min_rect', 'world', 'keep'], default: 'min_rect', desc: 'chart orientation: min_rect = turned to its minimum bounding rectangle, with 90° turns while packing (densest); world = world up (+Y) points to +v (horizontal charts: +X to +u), no turns; keep = as charted. Rotations keep the uv winding' },
    merge_thin: { type: 'bool', default: true, desc: 'join thin charts (bevel strips, narrow bands: narrower than three paddings) onto a neighbouring chart where their shared seam lines up and nothing overlaps, so fewer charts lose space to padding (and fewer seams); off = the charts as cut' },
    cut_long: { type: 'bool', default: true, desc: 'cut charts longer than the tile, and rings and arcs whose hull is mostly empty, across their length into parts, when that packs denser (each cut is a seam); off = charts stay whole' },
    texel_weight: { type: 'string', default: 'texel_weight', desc: 'prim attribute scaling the texel density of each chart (mean over its polygons by area; 2 = twice the texels per metre, values <= 0 count as 1, so attrib_create with a group weights those parts); missing = all 1' },
    iterations: { type: 'int', default: 4, min: 1, max: 64, desc: 'chart orders the packer tries; the densest wins' },
  },
  outputs: 'vertex uv, prim chart, prim atlas (fit stack with several atlases)',
  example: { type: 'uv_unwrap', in: ['geo'], params: { padding: 4, resolution: 1024 } },
  cook: async ({ input, p, warn, stat }) => {
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
      padding: Math.max(0, p.padding), texelsPerUnit: Math.max(0, p.texels_per_unit), fit: p.fit, orient: p.orient, cutLong: !!p.cut_long, mergeThin: !!p.merge_thin,
      texelWeight: String(p.texel_weight ?? ''), iterations: Math.max(1, Math.min(64, Math.floor(p.iterations) || 1)),
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
    if (r.tiles > 1) warn(`uv_unwrap: at ${p.texels_per_unit} texels per unit the charts fill ${r.tiles} ${p.fit === 'stack' ? 'atlases, stacked in 0..1 (see prim atlas)' : 'UDIM tiles (1001..)'}; fit "atlas" keeps one tile`);
    if (r.cappedBy >= 0 && r.coverage < 0.5) { const q = firstOf(r.cappedBy); if (q >= 0) warn(`uv_unwrap: charts cover ${(r.coverage * 100).toFixed(0)}% of the tile because the longest chart (${at(q)}) spans the tile and sets the scale; ${p.cut_long ? 'lower max_chart_area or max_boundary_length to cut it' : 'cut_long cuts it'}`); }
    if (p.texel_weight && p.texel_weight !== 'texel_weight' && !r.weighted) warn(`uv_unwrap: texel_weight "${p.texel_weight}" is not a numeric prim attribute; every chart has weight 1`);
    if (r.cut) stat('charts cut', r.cut);
    if (r.merged) stat('thin charts joined', r.merged);
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
        orient: 'min_rect', scaleMode: 'uniform', padding: paddingTexels(p.padding, p.units, p.resolution), resolution: p.resolution,
        fit: 'atlas', tiles: 1, texelsPerUnit: 0, iterations: 4, seed: 0, texelWeight: 'texel_weight', cutLong: false, node: 'uv_flatten',
      }, warn).uv;
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
  summary: 'Pack UV islands into the 0..1 square (or UDIM tiles) without overlaps: rotate to minimal bounds (or keep, or align to the world), equalise texel density, fill every gap.',
  description:
    'Islands are polygon regions whose uv is continuous across shared edges, or the values of island_attrib. Each island is oriented ' +
    '(orient: its minimum-area bounding rectangle, as it is, or world up to +v), scaled so texel density is uniform (scale_mode uniform: uv ' +
    'area ∝ 3D area, times the texel_weight attribute) and placed on the texel grid of `resolution`: bottom-left, into any gap its shape ' +
    'fits (inside rings, between the arms of other islands), `padding` texels from every other island and half of it from the tile border, ' +
    'so islands never overlap. The scale is the largest at which every island fits (or texels_per_unit); iterations tries other island ' +
    'orders and keeps the densest. fit atlas keeps everything in the 0..1 tile; fit udim fills UDIM tiles 1001, 1002, … (u offset, ten per ' +
    'row; an island goes to the first tile it fits), up to udims. cut_long cuts islands longer than the tile, and rings and arcs, into parts ' +
    'when the parts pack denser (each cut is a seam). Prims outside `group` keep their uv and the islands keep clear of them. The result is checked: overlaps ' +
    'inside an island (folds, or pieces joined by island_attrib) come from the input and are reported with the part they are in; islands ' +
    'that do not fit at any scale leave the uv unchanged, with a warning.',
  aliases: ['uvlayout', 'uvpack', 'uv_pack', 'pack_uv'],
  inputs: [{ name: 'geo', desc: 'geometry with uv' }],
  params: {
    island_attrib: { type: 'string', default: '', desc: 'prim attribute defining islands (e.g. "chart"); "" = connected uv regions' },
    group: P.group('prim', 'prims to lay out; the others keep their uv and the islands keep clear of them (with padding)'),
    orient: { type: 'enum', options: ['min_rect', 'keep', 'world'], default: 'min_rect', desc: 'island orientation: min_rect = turned to its minimum bounding rectangle, with 90° turns while packing (densest); keep = as it is, no turns; world = world up (+Y) points to +v (horizontal islands: +X to +u), no turns. Rotations keep the uv winding' },
    scale_mode: { type: 'enum', options: ['uniform', 'keep'], default: 'uniform', desc: 'uniform = same texel density on every island (by 3D area); keep = keep the relative uv scale' },
    texel_weight: { type: 'string', default: 'texel_weight', desc: 'prim attribute scaling the texel density of each island (mean over its polygons by area; 2 = twice the texels per metre, values <= 0 count as 1, so attrib_create with a group weights those parts); missing = all 1' },
    ...LAYOUT_PARAMS,
    texels_per_unit: { type: 'float', default: 0, min: 0, desc: 'texel density at `resolution` (texels per world unit with scale_mode uniform); 0 = the largest at which every island fits' },
    fit: { type: 'enum', options: ['atlas', 'udim'], default: 'atlas', desc: 'atlas = everything in the 0..1 tile (a texels_per_unit too high for it is lowered, with a warning); udim = UDIM tiles 1001, 1002, …: the islands keep texels_per_unit and spill into more tiles (up to udims), or fill udims tiles at the largest scale' },
    udims: { type: 'int', default: 1, min: 1, max: 100, desc: 'fit udim: the most UDIM tiles to fill' },
    cut_long: { type: 'bool', default: true, desc: 'cut islands longer than the tile, and rings and arcs whose hull is mostly empty, across their length into parts, when that packs denser (each cut is a seam; prim island tells the parts apart); off = islands stay whole' },
    iterations: { type: 'int', default: 4, min: 1, max: 64, desc: 'island orders tried (longest side first, then tallest, largest box, largest area, then shuffles by seed); the densest wins' },
    seed: P.seed(),
    write_island: { type: 'bool', default: true, desc: 'write prim int attribute island' },
  },
  outputs: 'vertex uv, prim island',
  example: { type: 'uv_layout', in: ['geo'], params: { padding: 8, resolution: 2048 } },
  cook: ({ input, p, warn, stat }) => {
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
      orient: p.orient, scaleMode: p.scale_mode, padding: paddingTexels(p.padding, p.units, p.resolution), resolution: p.resolution,
      fit: p.fit, tiles: p.udims, texelsPerUnit: Math.max(0, p.texels_per_unit), iterations: p.iterations, seed: Math.floor(Number(p.seed) || 0),
      texelWeight: String(p.texel_weight ?? ''), cutLong: !!p.cut_long, node: 'uv_layout', islandAttrib: attr ? p.island_attrib : undefined,
    }, warn);
    if (p.texel_weight && p.texel_weight !== 'texel_weight' && !out.weighted) warn(`uv_layout: texel_weight "${p.texel_weight}" is not a numeric prim attribute; every island has weight 1`);
    if (out.cut) stat('islands cut', out.cut);
    writeUV(g, out.uv);
    if (p.write_island) writePrimInt(g, 'island', out.labels);
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
