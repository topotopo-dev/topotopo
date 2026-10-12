// UV toolkit: automatic unwrap (xatlas), LSCM flattening, island layout/packing, automatic seams.
// UVs are the vertex attribute `uv` (u, v, 0); charts/islands are reported as prim int attributes.
import type { Geometry } from '../core/geometry.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import { primArea, primNormals } from '../core/topology.ts';
import {
  buildCharts, chartNeedsCut, cutGraph, edgeGroupTest, findIslands, lscm, normaliseCharts, packIslands,
  pairsWhere, pointPairTest, polygonSides, primComponents, cornerClasses, readUV, uvSeamPairs, writeUV,
} from '../core/uv.ts';
import type { Island, Sides } from '../core/uv.ts';
import { loadXatlas, runXatlas } from '../core/xatlas.ts';
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

function paddingUV(padding: number, units: string, resolution: number) {
  const pad = units === 'uv' ? padding : padding / Math.max(1, resolution);
  return Math.max(0, Math.min(0.2, pad));
}

const LAYOUT_PARAMS = {
  padding: { type: 'float' as const, default: 4, min: 0, desc: 'gap between islands, in texels at `resolution` (or uv units with units:"uv")' },
  units: { type: 'enum' as const, options: ['texels', 'uv'], default: 'texels', desc: 'unit of padding' },
  resolution: { type: 'int' as const, default: 1024, min: 16, max: 16384, desc: 'texture size the padding is measured against' },
};

// ---------------------------------------------------------------- uv_unwrap

defineNode({
  type: 'uv_unwrap',
  category: 'uv',
  summary: 'Automatic UV unwrap with xatlas: cut into charts, flatten each, pack into the 0..1 square. Polygons are kept.',
  description:
    'Charts grow over faces of similar orientation (weights below); each chart is flattened (LSCM, planar or ortho) and packed. ' +
    'Polygons are triangulated for xatlas internally; the output keeps the original polygons, with per-corner uv (seams split vertices, not points). ' +
    'Big smooth meshes chart slowly: max_chart_area -1 (auto) limits chart size above ~1000 triangles. Writes prim chart (and atlas when several atlases are made).',
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
    padding: { type: 'int', default: 2, min: 0, max: 64, desc: 'texels between charts' },
    resolution: { type: 'int', default: 0, min: 0, max: 16384, desc: 'atlas size in texels; 0 = automatic from texels_per_unit (or about 1024 when both are 0). With texels_per_unit set, charts that do not fit spill into more atlases' },
    texels_per_unit: { type: 'float', default: 0, min: 0, desc: 'texel density (texels per world unit); 0 = derived from resolution' },
    bruteforce: { type: 'bool', default: false, desc: 'slower, tighter packing' },
    rotate_charts: { type: 'bool', default: true, desc: 'rotate charts to pack tighter (and to the axis of their convex hull)' },
    block_align: { type: 'bool', default: false, desc: 'align charts to 4×4 texel blocks (faster packing, for block-compressed textures)' },
    udim: { type: 'bool', default: true, desc: 'when xatlas makes several atlases, place atlas k in UDIM tile 1001+k (u offset k); off = all atlases overlap in 0..1 (see prim atlas)' },
  },
  outputs: 'vertex uv, prim chart, prim atlas (several atlases only)',
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
      textureSeamWeight: p.texture_seam_weight, maxCost: p.max_cost, maxIterations: Math.max(1, Math.min(16, p.max_iterations)),
    };
    const resolution = p.resolution > 0 ? Math.max(16, p.resolution) : 0;
    const res = runXatlas(X, g, chart, {
      padding: Math.max(0, p.padding), resolution, texelsPerUnit: Math.max(0, p.texels_per_unit),
      bruteForce: p.bruteforce, rotateCharts: p.rotate_charts, rotateChartsToAxis: p.rotate_charts, blockAlign: p.block_align,
    }, { vertexKey, faceGroup });
    // ---- map triangles back to polygon corners
    const norm = Math.max(1, res.width, res.height);
    const uv = readUV(g) ?? new Float64Array(nv * 2);
    const assigned = new Uint8Array(nv);
    const primChart = new Int32Array(g.numPrims).fill(-1), primAtlas = new Int32Array(g.numPrims).fill(-1);
    const Pd = g.P, vp = g.vertexPoint;
    const triArea = (t: number) => {
      const a = vp[res.tris[t * 3]] * 3, b = vp[res.tris[t * 3 + 1]] * 3, c = vp[res.tris[t * 3 + 2]] * 3;
      const ux = Pd[b] - Pd[a], uy = Pd[b + 1] - Pd[a + 1], uz = Pd[b + 2] - Pd[a + 2];
      const wx = Pd[c] - Pd[a], wy = Pd[c + 1] - Pd[a + 1], wz = Pd[c + 2] - Pd[a + 2];
      return Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx);
    };
    const tileOf = (atlas: number) => (p.udim && res.atlasCount > 1 && atlas > 0 ? atlas : 0);
    const nt = res.triPrim.length;
    let straddled = 0;
    for (let t0 = 0; t0 < nt;) {
      const prim = res.triPrim[t0];
      let t1 = t0;
      while (t1 < nt && res.triPrim[t1] === prim) t1++;
      // dominant chart by area
      const acc = new Map<number, number>();
      for (let t = t0; t < t1; t++) if (res.triChart[t] >= 0) acc.set(res.triChart[t], (acc.get(res.triChart[t]) ?? 0) + triArea(t) + 1e-30);
      let best = -1, bw = -1;
      for (const [c, a] of acc) if (a > bw) { bw = a; best = c; }
      if (acc.size > 1) straddled++;
      if (best >= 0) {
        primChart[prim] = best;
        for (let t = t0; t < t1; t++) {
          if (res.triChart[t] !== best) continue;
          primAtlas[prim] = res.triAtlas[t];
          const du = tileOf(res.triAtlas[t]);
          for (let k = 0; k < 3; k++) {
            const i = t * 3 + k, v = res.tris[i];
            uv[v * 2] = res.cornerUV[i * 2] / norm + du;
            uv[v * 2 + 1] = res.cornerUV[i * 2 + 1] / norm;
            assigned[v] = 1;
          }
        }
        // corners only in triangles of other charts: unfold across an assigned edge (similarity transform)
        for (let pass = 0; pass < t1 - t0; pass++) {
          let progress = false;
          for (let t = t0; t < t1; t++) {
            const cs = [res.tris[t * 3], res.tris[t * 3 + 1], res.tris[t * 3 + 2]];
            const un = cs.filter((v) => !assigned[v]);
            if (un.length !== 1) continue;
            const ks = [0, 1, 2].filter((k) => assigned[cs[k]]), ku = [0, 1, 2].find((k) => !assigned[cs[k]])!;
            const [ka, kb] = ks;
            const sax = res.cornerUV[(t * 3 + ka) * 2], say = res.cornerUV[(t * 3 + ka) * 2 + 1];
            const sbx = res.cornerUV[(t * 3 + kb) * 2], sby = res.cornerUV[(t * 3 + kb) * 2 + 1];
            const scx = res.cornerUV[(t * 3 + ku) * 2], scy = res.cornerUV[(t * 3 + ku) * 2 + 1];
            const va = cs[ka], vb = cs[kb], vc = cs[ku];
            const dx = sbx - sax, dy = sby - say, d2 = dx * dx + dy * dy;
            if (d2 < 1e-20) continue;
            const tx = uv[vb * 2] - uv[va * 2], ty = uv[vb * 2 + 1] - uv[va * 2 + 1];
            // complex ratio (tx + i ty) / (dx + i dy)
            const cr = (tx * dx + ty * dy) / d2, ci = (ty * dx - tx * dy) / d2;
            const qx = scx - sax, qy = scy - say;
            uv[vc * 2] = uv[va * 2] + qx * cr - qy * ci;
            uv[vc * 2 + 1] = uv[va * 2 + 1] + qx * ci + qy * cr;
            assigned[vc] = 1;
            progress = true;
          }
          if (!progress) break;
        }
      }
      t0 = t1;
    }
    // corners xatlas ignored (zero-area faces): take the uv of another corner on the same point
    const ptUV = new Map<number, number>();
    for (let v = 0; v < nv; v++) if (assigned[v] && !ptUV.has(vp[v])) ptUV.set(vp[v], v);
    let unplaced = 0;
    for (let pr = 0; pr < g.numPrims; pr++) {
      if (!g.primClosed[pr] || g.primSize(pr) < 3) continue;
      for (let v = g.primStart[pr]; v < g.primStart[pr + 1]; v++) {
        if (assigned[v]) continue;
        const o = ptUV.get(vp[v]);
        if (o !== undefined) { uv[v * 2] = uv[o * 2]; uv[v * 2 + 1] = uv[o * 2 + 1]; }
        else { uv[v * 2] = 0; uv[v * 2 + 1] = 0; unplaced++; }
      }
    }
    writeUV(g, uv);
    writePrimInt(g, 'chart', primChart);
    g.prims.delete('atlas');
    if (res.atlasCount > 1) writePrimInt(g, 'atlas', primAtlas);
    let open = 0;
    for (let pr = 0; pr < g.numPrims; pr++) if (!g.primClosed[pr]) open++;
    if (open) warn(`${open} polylines skipped (only polygons are unwrapped)`);
    if (straddled) warn(`${straddled} polygons were split across xatlas charts; their extra corners were unfolded onto the main chart (may overlap a neighbour slightly; uv_layout repacks)`);
    if (unplaced) warn(`${unplaced} corners of degenerate (zero-area) polygons were placed at uv 0,0`);
    if (res.atlasCount > 1) warn(`${res.atlasCount} atlases (charts did not fit one ${res.width}×${res.height} atlas)${p.udim ? '; placed in UDIM tiles 1001..' : ''}`);
    return g;
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
      out = packIslands(uv, fresh, { rotate: true, scaleMode: 'uniform', padding: paddingUV(p.padding, p.units, p.resolution), udims: 1, iterations: 4, seed: 0 });
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
  summary: 'Pack UV islands into the 0..1 square (or UDIM tiles): rotate to minimal bounds, equalise texel density, skyline packing.',
  description:
    'Islands are polygon regions whose uv is continuous across shared edges, or the values of island_attrib. Each island is rotated to its ' +
    'minimum-area bounding rectangle (rotate), scaled so texel density is uniform (scale_mode uniform: uv area ∝ 3D area) and packed bottom-left ' +
    'on a skyline; iterations tries perturbed orders and keeps the tightest. UDIM tiles fill 1001, 1002, … (u offset), ten per row.',
  aliases: ['uvlayout', 'uvpack', 'uv_pack', 'pack_uv'],
  inputs: [{ name: 'geo', desc: 'geometry with uv' }],
  params: {
    island_attrib: { type: 'string', default: '', desc: 'prim attribute defining islands (e.g. "chart"); "" = connected uv regions' },
    group: P.group('prim', 'prims to lay out (others keep their uv)'),
    rotate: { type: 'bool', default: true, desc: 'rotate islands to their minimum bounding rectangle and allow 90° turns' },
    scale_mode: { type: 'enum', options: ['uniform', 'keep'], default: 'uniform', desc: 'uniform = same texel density on every island (by 3D area); keep = keep the relative uv scale' },
    ...LAYOUT_PARAMS,
    udims: { type: 'int', default: 1, min: 1, max: 100, desc: 'number of UDIM tiles to fill (1 = the 0..1 square)' },
    iterations: { type: 'int', default: 4, min: 1, max: 64, desc: 'packing orders tried (the first is sorted by size); the tightest wins' },
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
    const out = packIslands(uv, islands, {
      rotate: p.rotate, scaleMode: p.scale_mode, padding: paddingUV(p.padding, p.units, p.resolution),
      udims: p.udims, iterations: p.iterations, seed: Math.floor(Number(p.seed) || 0),
    });
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
