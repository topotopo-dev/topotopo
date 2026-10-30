// UV toolkit behaviour: uv_unwrap (xatlas), uv_flatten (LSCM), uv_layout (packing), uv_autoseam, the uv view.
//   node test/uv.ts
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { Geometry } from '../src/core/geometry.ts';
import { primNormals, triangulate } from '../src/core/topology.ts';
import { buildCharts, lscm, polygonSides, readUV, uvSeamPairs } from '../src/core/uv.ts';
import { exportGeometryAsync } from '../src/io/export.ts';
import { importGeometryAsync } from '../src/io/import.ts';
import { renderGeometry } from '../src/render/raster.ts';
import { uvReport } from '../src/core/uvreport.ts';
import { encodePNG } from '../src/render/png.ts';
import zlib from 'node:zlib';
import type { GraphSpec } from '../src/graph/types.ts';
import { getNodeDef } from '../src/graph/registry.ts';

const engine = new Engine(createNodeHost());
await engine.init();
let fail = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) fail++; };
const cook = async (nodes: GraphSpec['nodes'], output = 'out') => {
  const r = await engine.cook({ nodes, output });
  if (!r.ok || !r.geo) throw new Error(`cook failed: ${r.errors.map((e) => `[${e.node}] ${e.message}`).join('; ')}`);
  return { geo: r.geo, warnings: r.warnings.map((w) => w.message) };
};

/** Mean absolute difference (degrees) between triangle corner angles in 3D and in uv; and the flipped-triangle count. */
function angleError(g: Geometry) {
  const uv = readUV(g)!;
  const { tris } = triangulate(g);
  const P = g.P, vp = g.vertexPoint;
  let err = 0, n = 0, flipped = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const c = [tris[t], tris[t + 1], tris[t + 2]];
    const p3 = c.map((v) => [P[vp[v] * 3], P[vp[v] * 3 + 1], P[vp[v] * 3 + 2]]);
    const q = c.map((v) => [uv[v * 2], uv[v * 2 + 1]]);
    if ((q[1][0] - q[0][0]) * (q[2][1] - q[0][1]) - (q[1][1] - q[0][1]) * (q[2][0] - q[0][0]) < 0) flipped++;
    for (let k = 0; k < 3; k++) {
      const a = k, b = (k + 1) % 3, d = (k + 2) % 3;
      const e1 = [0, 1, 2].map((i) => p3[b][i] - p3[a][i]), e2 = [0, 1, 2].map((i) => p3[d][i] - p3[a][i]);
      const a3 = Math.acos(Math.max(-1, Math.min(1, (e1[0] * e2[0] + e1[1] * e2[1] + e1[2] * e2[2]) / (Math.hypot(...e1) * Math.hypot(...e2) || 1))));
      const f1 = [q[b][0] - q[a][0], q[b][1] - q[a][1]], f2 = [q[d][0] - q[a][0], q[d][1] - q[a][1]];
      const a2 = Math.acos(Math.max(-1, Math.min(1, (f1[0] * f2[0] + f1[1] * f2[1]) / (Math.hypot(...f1) * Math.hypot(...f2) || 1))));
      err += Math.abs(a3 - a2); n++;
    }
  }
  return { mean: ((err / Math.max(1, n)) * 180) / Math.PI, flipped, tris: tris.length / 3 };
}

/** Rasterise every triangle into a res² grid by its island id; count texels claimed by two different islands. */
function overlapTexels(g: Geometry, islandAttr: string, res = 256) {
  const uv = readUV(g)!;
  const isl = g.prims.get(islandAttr)!.data as Int32Array;
  const vprim = g.vertexPrims();
  const { tris } = triangulate(g);
  const owner = new Int32Array(res * res).fill(-1);
  let covered = 0, clash = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const id = isl[vprim[tris[t]]];
    const xs = [0, 1, 2].map((k) => uv[tris[t + k] * 2] * res), ys = [0, 1, 2].map((k) => uv[tris[t + k] * 2 + 1] * res);
    const area = (xs[1] - xs[0]) * (ys[2] - ys[0]) - (ys[1] - ys[0]) * (xs[2] - xs[0]);
    if (Math.abs(area) < 1e-12) continue;
    for (let y = Math.max(0, Math.floor(Math.min(...ys))); y <= Math.min(res - 1, Math.ceil(Math.max(...ys))); y++)
      for (let x = Math.max(0, Math.floor(Math.min(...xs))); x <= Math.min(res - 1, Math.ceil(Math.max(...xs))); x++) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((xs[1] - px) * (ys[2] - py) - (ys[1] - py) * (xs[2] - px)) / area;
        const w1 = ((xs[2] - px) * (ys[0] - py) - (ys[2] - py) * (xs[0] - px)) / area;
        if (w0 < 0 || w1 < 0 || 1 - w0 - w1 < 0) continue;
        const i = y * res + x;
        if (owner[i] < 0) { owner[i] = id; covered++; }
        else if (owner[i] !== id) { owner[i] = -2 - id; clash++; }
      }
  }
  return { covered, clash };
}

function uvRange(g: Geometry) {
  const uv = readUV(g)!;
  let lo = Infinity, hi = -Infinity, finite = true;
  for (const x of uv) { if (!Number.isFinite(x)) finite = false; lo = Math.min(lo, x); hi = Math.max(hi, x); }
  return { lo, hi, finite };
}

const sameTopology = (a: Geometry, b: Geometry) =>
  a.numPoints === b.numPoints && a.numPrims === b.numPrims && a.numVertices === b.numVertices &&
  a.vertexPoint.every((p, i) => p === b.vertexPoint[i]) && a.primStart.every((s, i) => s === b.primStart[i]);

// ---------------------------------------------------------------- uv_unwrap
{
  const nodes: GraphSpec['nodes'] = {
    box: { type: 'box', params: { divisions: [2, 2, 2] } },
    tube: { type: 'tube', params: { caps: true, cols: 12, center: [2, 0, 0] } },
    torus: { type: 'torus', params: { center: [-2.5, 0, 0] } },
    star: { type: 'shape2d', params: { shape: 'star', sides: 7 } },
    starx: { type: 'extrude', in: ['star'], params: { height: 0.3 } },
    ico: { type: 'sphere', params: { type: 'ico', level: 3, center: [0, 0, 3] } },
    in: { type: 'merge', in: ['box', 'tube', 'torus', 'starx', 'ico'] },
    out: { type: 'uv_unwrap', in: ['in'], params: { padding: 2, resolution: 512 } },
  };
  const src = (await cook(nodes, 'in')).geo;
  const { geo: g, warnings } = await cook(nodes);
  const r = uvRange(g);
  check(r.finite && r.lo >= -1e-9 && r.hi <= 1 + 1e-9, `uv_unwrap: every corner has a finite uv in 0..1 (range ${r.lo.toFixed(4)}..${r.hi.toFixed(4)}; pieces + n-gons)`);
  check(sameTopology(src, g), `uv_unwrap: points, polygons and vertices preserved (${g.numPoints} pts, ${g.numPrims} prims, ${g.numVertices} vtx)`);
  const ch = g.prims.get('chart');
  check(!!ch && ch.type === 'int' && (ch.data as Int32Array).every((c) => c >= 0), `uv_unwrap: prim chart on every polygon (${new Set(ch?.data as Int32Array).size} charts)`);
  const ae = angleError(g);
  check(ae.flipped === 0, `uv_unwrap: no mirrored triangles (${ae.flipped}/${ae.tris}); mean angle error ${ae.mean.toFixed(2)}°`);
  const st = sameTopology(src, g) ? polygonSides(g) : null;
  if (st) {
    // chart borders are uv seams: two charts never share an edge with continuous uv
    const seam = uvSeamPairs(st, readUV(g)!);
    const cd = ch!.data as Int32Array;
    let bad = 0;
    for (let i = 0; i < st.count; i++) if (!seam[i] && cd[st.pA[i]] !== cd[st.pB[i]]) bad++;
    check(bad === 0, `uv_unwrap: different charts never share a continuous uv edge (${bad})`);
  }
  check(!warnings.some((w) => /mirrored/.test(w)), `uv_unwrap: no mirrored-chart warning (warnings: ${warnings.join(' | ') || 'none'})`);
  // islands of the unwrap do not overlap
  const ov = overlapTexels(g, 'chart');
  check(ov.clash <= ov.covered * 0.002, `uv_unwrap: charts do not overlap (${ov.clash} shared texels of ${ov.covered} at 256²)`);
  // seams kept
  const s2 = await cook({ box: { type: 'box', params: { divisions: [2, 2, 2] } }, out: { type: 'uv_unwrap', in: ['box'], params: { use_seams: true } } });
  const bx = (await cook({ box: { type: 'box', params: { divisions: [2, 2, 2] } } }, 'box')).geo;
  const S = polygonSides(bx), inSeam = uvSeamPairs(S, readUV(bx)!), cd = s2.geo.prims.get('chart')!.data as Int32Array;
  let crossing = 0;
  for (let i = 0; i < S.count; i++) if (inSeam[i] && cd[S.pA[i]] === cd[S.pB[i]]) crossing++;
  check(crossing === 0, `uv_unwrap use_seams: no chart crosses an input uv seam (${crossing})`);
  // deterministic
  const e2 = new Engine(createNodeHost());
  await e2.init();
  const g2 = (await e2.cook({ nodes, output: 'out' })).geo!;
  const a = readUV(g)!, b = readUV(g2)!;
  check(a.every((x, i) => x === b[i]), 'uv_unwrap: deterministic across engines');
}

// ---------------------------------------------------------------- uv_flatten (LSCM)
{
  const { geo: g } = await cook({ grid: { type: 'grid', params: { size: [3, 2], divisions: [24, 16] } }, out: { type: 'uv_flatten', in: ['grid'], params: { layout: false } } });
  const ae = angleError(g);
  check(ae.mean < 1 && ae.flipped === 0, `uv_flatten: flat grid is conformal (mean angle error ${ae.mean.toFixed(4)}° < 1°, flipped ${ae.flipped})`);
  const r = uvRange(g);
  check(r.finite && r.lo >= -1e-9 && r.hi <= 1 + 1e-9, `uv_flatten: chart normalised into 0..1 (${r.lo.toFixed(3)}..${r.hi.toFixed(3)})`);
  // curved surface: noise-displaced grid stays nearly conformal
  const { geo: g2 } = await cook({
    grid: { type: 'grid', params: { size: [4, 4], divisions: [30, 30] } },
    n: { type: 'noise_displace', in: ['grid'], params: { amplitude: 0.3 } },
    out: { type: 'uv_flatten', in: ['n'] },
  });
  const ae2 = angleError(g2);
  check(ae2.mean < 2 && ae2.flipped === 0, `uv_flatten: bumpy grid mean angle error ${ae2.mean.toFixed(3)}° < 2°, flipped ${ae2.flipped}`);
  // closed surfaces are cut open; handles too
  for (const [name, spec] of [['sphere', { type: 'sphere', params: { type: 'ico', level: 3 } }], ['torus', { type: 'torus' }]] as const) {
    const { geo } = await cook({ s: spec as any, out: { type: 'uv_flatten', in: ['s'] } });
    const a = angleError(geo);
    const rr = uvRange(geo);
    check(a.flipped <= a.tris * 0.01 && rr.finite, `uv_flatten: closed ${name} cut open and flattened (flipped ${a.flipped}/${a.tris}, mean angle error ${a.mean.toFixed(2)}°)`);
  }
  // manual seams as point pairs: open tube cut along one column becomes one rectangle-like chart
  const pairs = Array.from({ length: 6 }, (_, r) => [r * 16, (r + 1) * 16]);
  const { geo: tube } = await cook({
    t: { type: 'tube', params: { cols: 16, rows: 6, caps: false, height: 2 } },
    d: { type: 'attrib_delete', in: ['t'], params: { names: 'uv' } },
    out: { type: 'uv_flatten', in: ['d'], params: { use_seams: false, seams: pairs, cut_closed: false } },
  });
  const ta = angleError(tube);
  const tch = new Set(tube.prims.get('chart')!.data as Int32Array).size;
  check(ta.mean < 1 && ta.flipped === 0 && tch === 1, `uv_flatten: tube cut by a manual seam unrolls (1 chart: ${tch}, mean angle error ${ta.mean.toFixed(3)}°)`);
  // abf is reserved
  const rr = await engine.cook({ nodes: { g: { type: 'grid' }, out: { type: 'uv_flatten', in: ['g'], params: { method: 'abf' } } }, output: 'out' });
  check(!rr.ok && /not implemented/.test(rr.errors[0]?.message ?? ''), `uv_flatten method abf reports "${rr.errors[0]?.message}"`);
  // 10k-triangle chart speed
  const big = (await cook({ grid: { type: 'grid', params: { size: [4, 4], divisions: [70, 70] } }, n: { type: 'noise_displace', in: ['grid'], params: { amplitude: 0.4 } } }, 'n')).geo;
  const S = polygonSides(big);
  const { charts } = buildCharts(big, S, new Uint8Array(S.count));
  const ch = charts[0];
  const pos = new Float64Array(ch.point.length * 3);
  for (let l = 0; l < ch.point.length; l++) for (let c = 0; c < 3; c++) pos[l * 3 + c] = big.P[ch.point[l] * 3 + c];
  const border: number[] = [];
  ch.border.forEach((b, l) => { if (b) border.push(l); });
  const t0 = performance.now();
  const res = lscm(pos, ch.tris, null, border);
  const ms = performance.now() - t0;
  check(ms < 2000 && res.residual === 0, `lscm: ${ch.tris.length / 3}-triangle chart converged in ${ms.toFixed(0)} ms (${res.iterations} CG iterations)`);
}

// ---------------------------------------------------------------- uv_layout
{
  const { geo: g } = await cook({
    t: { type: 'torus' },
    a: { type: 'uv_autoseam', in: ['t'], params: { method: 'normal', angle: 35 } },
    f: { type: 'uv_flatten', in: ['a'], params: { layout: false } },
    s: { type: 'sphere', params: { type: 'ico', level: 2, center: [3, 0, 0] } },
    sa: { type: 'uv_autoseam', in: ['s'] },
    sf: { type: 'uv_flatten', in: ['sa'], params: { layout: false } },
    m: { type: 'merge', in: ['f', 'sf'] },
    out: { type: 'uv_layout', in: ['m'], params: { padding: 8, resolution: 1024, iterations: 4 } },
  });
  const isl = new Set(g.prims.get('island')!.data as Int32Array).size;
  const r = uvRange(g);
  check(r.finite && r.lo >= -1e-9 && r.hi <= 1 + 1e-9, `uv_layout: ${isl} islands packed into 0..1 (${r.lo.toFixed(4)}..${r.hi.toFixed(4)})`);
  const ov = overlapTexels(g, 'island');
  check(ov.clash === 0, `uv_layout: islands do not overlap (${ov.clash} texels shared by two islands, ${ov.covered} covered at 256², ${((ov.covered / 65536) * 100).toFixed(0)}% used)`);
  // uniform texel density: uv area / 3D area is equal across islands
  const uv = readUV(g)!, isd = g.prims.get('island')!.data as Int32Array;
  const a3 = new Map<number, number>(), a2 = new Map<number, number>();
  for (let p = 0; p < g.numPrims; p++) {
    const s = g.primStart[p], e = g.primStart[p + 1];
    let ar = 0;
    for (let v = s; v < e; v++) { const w = v + 1 < e ? v + 1 : s; ar += uv[v * 2] * uv[w * 2 + 1] - uv[w * 2] * uv[v * 2 + 1]; }
    a2.set(isd[p], (a2.get(isd[p]) ?? 0) + Math.abs(ar) / 2);
    const P = g.P, pts = g.primPoints(p);
    let nx = 0, ny = 0, nz = 0;
    for (let k = 0; k < pts.length; k++) {
      const i = pts[k] * 3, j = pts[(k + 1) % pts.length] * 3;
      nx += (P[i + 1] - P[j + 1]) * (P[i + 2] + P[j + 2]); ny += (P[i + 2] - P[j + 2]) * (P[i] + P[j]); nz += (P[i] - P[j]) * (P[i + 1] + P[j + 1]);
    }
    a3.set(isd[p], (a3.get(isd[p]) ?? 0) + Math.hypot(nx, ny, nz) / 2);
  }
  const ratios = [...a3.keys()].filter((k) => a3.get(k)! > 1e-3).map((k) => a2.get(k)! / a3.get(k)!);
  const spread = Math.max(...ratios) / Math.min(...ratios);
  check(spread < 1.05, `uv_layout: uniform texel density across islands (max/min uv:3D area ratio ${spread.toFixed(3)})`);
  // UDIMs
  const { geo: u } = await cook({ b: { type: 'box', params: { divisions: [2, 2, 2] } }, out: { type: 'uv_layout', in: ['b'], params: { fit: 'udim', udims: 3 } } });
  const uvu = readUV(u)!;
  let umax = 0, vmax = 0;
  for (let i = 0; i < uvu.length; i += 2) { umax = Math.max(umax, uvu[i]); vmax = Math.max(vmax, uvu[i + 1]); }
  check(umax > 1 && umax <= 3 && vmax <= 1, `uv_layout udims 3: islands spread over UDIM 1001..1003 (u max ${umax.toFixed(2)}, v max ${vmax.toFixed(2)})`);
}

// uv_layout never overlaps: many identical thin strips (the skyline packer once stacked equal islands on each other)
{
  const { geo: g, warnings } = await cook({
    strip: { type: 'grid', params: { size: [1, 0.02], divisions: [8, 1] } },
    uvp: { type: 'uv_project', in: ['strip'], params: { method: 'planar', axis: 'y' } },
    copies: { type: 'copy_xform', in: ['uvp'], params: { count: 120, translate: [0, 0, 0.05] } },
    box: { type: 'box', params: { size: [0.3, 0.3, 0.3], center: [0, 0, -1] } },
    boxuv: { type: 'uv_unwrap', in: ['box'] },
    m: { type: 'merge', in: ['copies', 'boxuv'] },
    out: { type: 'uv_layout', in: ['m'], params: { padding: 4, resolution: 1024 } },
  });
  const rep = uvReport(g);
  const isl = new Set(g.prims.get('island')!.data as Int32Array).size;
  check(rep.overlap.pairs === 0 && rep.outOfTile === 0 && warnings.length === 0, `uv_layout: ${isl} islands (120 identical thin strips) never overlap (${rep.overlap.pairs} pairs, ${rep.outOfTile} outside 0..1, warnings: ${warnings.join('; ') || 'none'})`);
  check(rep.utilization.method === 'exact' && rep.utilization.value > 0.5, `uv_layout: thin strips cover ${(rep.utilization.value * 100).toFixed(1)}% of the tile (> 50%)`);
}

// uv_layout with a group: the other prims keep their uv and the packed islands keep clear of them
{
  const nodes: GraphSpec['nodes'] = {
    b: { type: 'box', params: { divisions: [2, 2, 2] } },
    bu: { type: 'uv_unwrap', in: ['b'], params: { padding: 4, resolution: 512 } },
    s: { type: 'sphere', params: { type: 'ico', level: 2, center: [3, 0, 0] } },
    su: { type: 'uv_unwrap', in: ['s'] },
    m: { type: 'merge', in: ['bu', 'su'] },
    out: { type: 'uv_layout', in: ['m'], params: { group: '@P.x>1.5', padding: 8, resolution: 512 } },
  };
  const { geo: g, warnings } = await cook(nodes);
  const { geo: fixed } = await cook(nodes, 'bu');
  const a = readUV(g)!, b0 = readUV(fixed)!;
  let moved = 0;
  for (let i = 0; i < b0.length; i++) if (a[i] !== b0[i]) moved++;
  const rep = uvReport(g);
  check(moved === 0, `uv_layout group: the ${fixed.numVertices} corners outside the group keep their uv (${moved / 2} moved)`);
  check(rep.overlap.pairs === 0 && warnings.length === 0, `uv_layout group: the packed sphere keeps clear of the fixed box charts (${rep.overlap.pairs} overlapping pairs; warnings: ${warnings.join('; ') || 'none'})`);
}

// uv_layout reports overlaps it keeps from the input (pieces joined by island_attrib), naming the part
{
  const { geo: g, warnings } = await cook({
    a: { type: 'grid', params: { size: [1, 1], divisions: [2, 2] } },
    b: { type: 'grid', params: { size: [1, 1], divisions: [2, 2], center: [0, 0.5, 0] } },
    m: { type: 'merge', in: ['a', 'b'] },
    uvp: { type: 'uv_project', in: ['m'], params: { method: 'planar', axis: 'y' } },
    chart: { type: 'attrib_create', in: ['uvp'], params: { name: 'chart', class: 'prim', type: 'int', value: 0 } },
    named: { type: 'attrib_create', in: ['chart'], params: { name: 'name', class: 'prim', value: 'panel' } },
    out: { type: 'uv_layout', in: ['named'], params: { island_attrib: 'chart' } },
  });
  const w = warnings.find((x) => x.includes('already in the input')) ?? '';
  check(w.includes('"panel"') && w.includes('island_attrib "chart"') && /near uv \(/.test(w), `uv_layout: overlaps kept from the input are reported with the part and uv position ("${w.slice(0, 160)}…")`);
  check(uvReport(g).overlap.pairs > 0, 'uv_layout: the joined pieces still overlap (packing moves each island whole)');
}

// ---------------------------------------------------------------- GLB round trip
{
  const { geo: g } = await cook({ b: { type: 'box', params: { divisions: [2, 1, 1] } }, out: { type: 'uv_unwrap', in: ['b'] } });
  const back = await importGeometryAsync(await exportGeometryAsync(g, 'glb'), 'glb');
  const uvA = readUV(g)!, uvB = readUV(back);
  const key = (P: Float64Array, pt: number, u: number, v: number) => [P[pt * 3], P[pt * 3 + 1], P[pt * 3 + 2], u, v].map((x) => Math.round(x * 1e4)).join(',');
  const A = new Set<string>(), B = new Set<string>();
  for (let v = 0; v < g.numVertices; v++) A.add(key(g.P, g.vertexPoint[v], uvA[v * 2], uvA[v * 2 + 1]));
  if (uvB) for (let v = 0; v < back.numVertices; v++) B.add(key(back.P, back.vertexPoint[v], uvB[v * 2], uvB[v * 2 + 1]));
  const missing = [...A].filter((k) => !B.has(k)).length, extra = [...B].filter((k) => !A.has(k)).length;
  check(!!uvB && missing === 0 && extra === 0, `uv round-trips through GLB export/import (${A.size} position+uv corners, missing ${missing}, extra ${extra})`);
}

// ---------------------------------------------------------------- uv view
{
  const { geo: g } = await cook({ b: { type: 'box' }, out: { type: 'uv_unwrap', in: ['b'] } });
  const one = renderGeometry(g, { views: ['uv'], size: 256 });
  check(one.width === 256 && one.height === 256 + 22, `uv view: single tile is 256×278 (got ${one.width}×${one.height})`);
  const two = renderGeometry(g, { views: ['persp', 'uv'], size: 300, checker: true });
  const png = encodePNG(two.rgba, two.width, two.height, (d) => zlib.deflateSync(d));
  const dv = new DataView(png.buffer, png.byteOffset);
  const sig = [137, 80, 78, 71].every((b, i) => png[i] === b);
  check(sig && dv.getUint32(16) === 602 && dv.getUint32(20) === 322, `uv view: persp+uv PNG is 602×322 (got ${dv.getUint32(16)}×${dv.getUint32(20)})`);
  // the uv tile is not empty: some pixels carry chart colours (saturated) inside the square
  let coloured = 0;
  for (let y = 40; y < 300; y++)
    for (let x = 302 + 20; x < 602 - 20; x++) {
      const i = (y * two.width + x) * 4;
      const r = two.rgba[i], gg = two.rgba[i + 1], b = two.rgba[i + 2];
      if (Math.max(r, gg, b) - Math.min(r, gg, b) > 40) coloured++;
    }
  check(coloured > 2000, `uv view draws filled charts (${coloured} coloured pixels)`);
  const none = renderGeometry(new Geometry({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], prims: [[0, 1, 2]] }), { views: ['uv'], size: 128 });
  check(none.notes.some((n) => /no uv/.test(n)), `uv view without uv: note "${none.notes.find((n) => /no uv/.test(n))}"`);
}

// a real-size small part (6 cm, 0.6 mm bevels) unwraps like the same part scaled up (xatlas's absolute epsilons)
{
  const part = (k: number): GraphSpec['nodes'] => ({
    c: { type: 'curve', params: { points: [[0, 0, 0], [0, 0.02, 0], [0, 0.025, -0.03], [0, 0.01, -0.06], [0, -0.01, -0.05], [0, -0.015, -0.02]], closed: true } },
    f: { type: 'fillet_curve', in: ['c'], params: { radius: 0.004, segments: 4 } },
    e: { type: 'extrude', in: ['f'], params: { height: 0.012, center: true, plane: 'yz' } },
    b: { type: 'poly_bevel', in: ['e'], params: { offset: 0.0006, divisions: 2, group: 'angle>40' } },
    s: { type: 'transform', in: ['b'], params: { scale: [k, k, k] } },
    t: { type: 'triangulate', in: ['s'] },
    out: { type: 'uv_unwrap', in: ['t'], params: { padding: 4, resolution: 1024 } },
  });
  const small = uvReport((await cook(part(1))).geo, { resolution: 1024 }), big = uvReport((await cook(part(100))).geo, { resolution: 1024 });
  check(small.overlap.pairs === 0 && small.collapsed === 0, `uv_unwrap at real size (6 cm): ${small.overlap.pairs} overlapping pairs, ${small.collapsed} collapsed triangles`);
  check(small.charts === big.charts, `uv_unwrap: the same charts at 1x and 100x (${small.charts} / ${big.charts})`);
}

// ---------------------------------------------------------------- uv_unwrap robustness (hand-built meshes)
/** Cook one node on a geometry; params over the node's defaults. */
async function cookNode(type: string, g: Geometry, params: Record<string, any> = {}) {
  const def = getNodeDef(type)!;
  const p = { ...Object.fromEntries(Object.entries(def.params).map(([k, v]) => [k, (v as any).default])), ...params };
  const warnings: string[] = [];
  const geo: Geometry = await (def.cook as any)({ input: () => g, inputs: [g], hasInput: () => true, p, warn: (m: string) => warnings.push(m) });
  return { geo, warnings };
}
const named = (g: Geometry, name: string) => { const a = g.prims.add('name', 'string', 1); for (let p = 0; p < g.numPrims; p++) a.set(p, name); return g; };

// a polygon with no area (a sliver filling a T-junction) collapses onto its neighbour's chart instead of spanning the atlas
{
  const pts = [[0, 0, 0], [1, 0, 0], [1, 0, 0.5], [1, 0, 1], [0, 0, 1], [2, 0, 0], [2, 0, 1]];
  const g = named(new Geometry({ positions: pts.flat(), prims: [[0, 4, 3, 2, 1], [1, 3, 6, 5].reverse(), [1, 2, 3]] }), 'plate');
  const { geo, warnings } = await cookNode('uv_unwrap', g);
  const rep = uvReport(geo), uv = readUV(geo)!;
  const sliver = [geo.primStart[2], geo.primStart[2] + 1, geo.primStart[2] + 2].map((v) => [uv[v * 2], uv[v * 2 + 1]]);
  const area = Math.abs((sliver[1][0] - sliver[0][0]) * (sliver[2][1] - sliver[0][1]) - (sliver[2][0] - sliver[0][0]) * (sliver[1][1] - sliver[0][1])) / 2;
  const span = Math.max(...sliver.map((q) => Math.hypot(q[0] - sliver[0][0], q[1] - sliver[0][1])));
  const w = warnings.find((m) => m.includes('no area')) ?? '';
  check(rep.overlap.pairs === 0 && area < 1e-12 && span < 0.6, `uv_unwrap: a no-area sliver collapses onto a neighbour's chart (uv area ${area.toExponential(1)}, span ${span.toFixed(3)}, ${rep.overlap.pairs} overlapping pairs)`);
  check(/prim 2 of "plate"/.test(w), `uv_unwrap: the sliver warning names the part ("${w.slice(0, 120)}")`);
}

// a polygon xatlas cuts across two charts becomes its triangles, every corner kept (collinear corners too)
{
  const r = (120 * Math.PI) / 180;
  const pts = [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0], [3, 0, 1], [3, Math.sin(r), 1 + Math.cos(r)], [0, Math.sin(r), 1 + Math.cos(r)], [0, 0, 1]];
  const g = new Geometry({ positions: pts.flat(), prims: [[0, 1, 2, 3, 4, 5, 6, 7]] });
  const split = await cookNode('uv_unwrap', g);
  const used = new Set<number>();
  for (let v = 0; v < split.geo.numVertices; v++) used.add(split.geo.vertexPoint[v]);
  const rep = uvReport(split.geo);
  check(split.geo.numPrims > 1 && used.size === 8 && rep.overlap.pairs === 0 && split.warnings.some((m) => m.includes('cut across xatlas charts')),
    `uv_unwrap straddling split: the bent 8-gon becomes ${split.geo.numPrims} triangles using all ${used.size} of 8 points, ${rep.overlap.pairs} overlapping pairs`);
  const unfold = await cookNode('uv_unwrap', g, { straddling: 'unfold' });
  check(unfold.geo.numPrims === 1 && unfold.warnings.some((m) => m.includes('mapped onto the main chart')), `uv_unwrap straddling unfold: the polygon stays whole (${unfold.geo.numPrims} prim) and the warning says so`);
}

// a chart xatlas folds (a strip whose low ridges end in open cracks, on a tilted plane) is charted again until none folds
{
  // strip along z, half-width a; n ridges of half-width b, height h, length L, gaps gp, end margins m. Under each ridge end
  // the plane has its own centre point (a crack below the ridge apex), as booleans and bevels leave them
  const n = 3, a = 1, b = 0.6, h = 0.08, L = 1.7, gp = 0.55, m = 0.55, end = 2 * m + n * L + (n - 1) * gp;
  const pos: number[][] = [], prims: number[][] = [];
  const pt = (u: number, y: number, z: number) => { pos.push([(-u + y) * Math.SQRT1_2, (u + y) * Math.SQRT1_2, z]); return pos.length - 1; };
  const S0 = pt(0, 0, 0), Sp = pt(a, 0, 0), Sm = pt(-a, 0, 0), E0 = pt(0, 0, end), Ep = pt(a, 0, end), Em = pt(-a, 0, end);
  const R = Array.from({ length: n }, (_, k) => {
    const w0 = m + k * (L + gp), w1 = w0 + L;
    return { A0: pt(0, h, w0), A1: pt(0, h, w1), P0: pt(b, 0, w0), P1: pt(b, 0, w1), M0: pt(-b, 0, w0), M1: pt(-b, 0, w1), C0: pt(0, 0, w0), C1: pt(0, 0, w1) };
  });
  for (const t of R) prims.push([t.A0, t.P0, t.P1], [t.A0, t.A1, t.M0], [t.A0, t.P1, t.A1], [t.A1, t.M1, t.M0]);
  prims.push([R[0].P0, S0, Sp], [S0, R[0].M0, Sm], [R[0].C0, S0, R[0].P0], [S0, R[0].C0, R[0].M0]);
  for (let k = 0; k < n; k++) {
    // the strip beside ridge k: fans to the strip's corners (the last ridge's minus side closes towards Em below)
    prims.push([R[k].P0, k ? Ep : Sp, R[k].P1]);
    if (k + 1 < n) prims.push([R[k].M1, Sm, R[k].M0]);
    if (k + 1 < n) {
      const t = R[k], u = R[k + 1];
      prims.push([t.P1, u.P0, t.C1], [u.C0, t.C1, u.P0], [t.C1, u.C0, t.M1], [t.M1, u.C0, u.M0], [t.P1, Ep, u.P0], [t.M1, u.M0, Sm]);
    }
  }
  prims.push([R[0].P1, Sp, Ep], [R[n - 1].M0, Em, Sm], [R[n - 1].M0, R[n - 1].M1, Em]);
  const t = R[n - 1];
  prims.push([t.P1, E0, t.C1], [t.C1, E0, t.M1], [t.P1, Ep, E0], [t.M1, E0, Em]);
  const g = new Geometry({ positions: pos.flat(), prims });
  const { geo, warnings } = await cookNode('uv_unwrap', g);
  const rep = uvReport(geo);
  check(rep.overlap.pairs === 0 && rep.charts <= 10 && warnings.some((w) => w.includes('folded onto themselves')), `uv_unwrap: a folding chart is charted again without folds (${rep.overlap.pairs} overlapping pairs, ${rep.charts} charts; warnings: ${warnings.join('; ').slice(0, 200) || 'none'})`);
}

// pieces 1000x apart in size are charted on their own: no overlaps, no collapsed uv, the same texel density
{
  const { geo } = await cook({
    big: { type: 'box', params: { size: [10, 10, 10] } },
    small: { type: 'box', params: { size: [0.01, 0.01, 0.01], center: [20, 0, 0] } },
    sb: { type: 'poly_bevel', in: ['small'], params: { offset: 0.0005, divisions: 2 } },
    m: { type: 'merge', in: ['big', 'sb'] },
    out: { type: 'uv_unwrap', in: ['m'], params: { resolution: 4096, padding: 1 } },
  });
  const rep = uvReport(geo, { resolution: 4096 });
  check(rep.overlap.pairs === 0 && rep.collapsed === 0, `uv_unwrap: a 1 cm bevelled box beside a 10 m box (${rep.charts} charts): ${rep.overlap.pairs} overlapping pairs, ${rep.collapsed} collapsed triangles`);
}

// texels_per_unit with fit: atlas (the default) keeps one tile, udim spills into more tiles, stack puts every atlas in 0..1
const uvMax = (g: Geometry) => { const u = readUV(g)!; let mu = 0, mv = 0; for (let i = 0; i < u.length; i += 2) { mu = Math.max(mu, u[i]); mv = Math.max(mv, u[i + 1]); } return [mu, mv]; };
{
  const nodes = (fit: string): GraphSpec['nodes'] => ({
    s: { type: 'sphere', params: { type: 'ico', level: 2 } },
    out: { type: 'uv_unwrap', in: ['s'], params: { texels_per_unit: 2000, resolution: 512, fit } },
  });
  const ud = await cook(nodes('udim')), sh = await cook(nodes('atlas')), st = await cook(nodes('stack'));
  const [uu] = uvMax(ud.geo), [su, sv] = uvMax(sh.geo), [tu, tv] = uvMax(st.geo);
  check(uu > 1 && ud.warnings.some((w) => w.includes('UDIM tiles')), `uv_unwrap fit udim: charts spill into more tiles (u max ${uu.toFixed(2)})`);
  check(su <= 1 && sv <= 1 && uvReport(sh.geo).overlap.pairs === 0, `uv_unwrap fit atlas: one tile (u max ${su.toFixed(3)}, v max ${sv.toFixed(3)})`);
  const atl = st.geo.prims.get('atlas');
  check(tu <= 1 && tv <= 1 && !!atl && new Set(atl.data as Int32Array).size > 1, `uv_unwrap fit stack: ${atl ? new Set(atl.data as Int32Array).size : 0} atlases, all in 0..1 (prim atlas)`);
}

// uv_layout texels_per_unit: fit atlas lowers a density too high for the tile (and says so); fit udim keeps it over more tiles
{
  const nodes = (fit: string): GraphSpec['nodes'] => ({
    b: { type: 'box', params: { size: [2, 2, 2] } },
    p: { type: 'uv_unwrap', in: ['b'], params: { resolution: 256 } },
    out: { type: 'uv_layout', in: ['p'], params: { texels_per_unit: 200, resolution: 512, fit, udims: 8, island_attrib: 'chart' } },
  });
  const at = await cook(nodes('atlas')), ud = await cook(nodes('udim'));
  const [au, av] = uvMax(at.geo), [uu] = uvMax(ud.geo);
  const dA = uvReport(at.geo, { resolution: 512 }).density!, dU = uvReport(ud.geo, { resolution: 512 }).density!;
  check(au <= 1 && av <= 1 && dA.overall < 200 && at.warnings.some((w) => w.includes('200 texels per unit') && w.includes('fit "udim"')), `uv_layout fit atlas: everything in 0..1 at ${dA.overall.toFixed(0)} texels/m, with a warning`);
  check(uu > 1 && Math.abs(dU.overall - 200) < 200 * 0.02 && uvReport(ud.geo).overlap.pairs === 0, `uv_layout fit udim: the density is kept (${dU.overall.toFixed(1)} texels/m) over tiles up to u ${uu.toFixed(2)}`);
}

// texel_weight: a prim attribute scales the density of its islands (set on a group with attrib_create; 0 elsewhere counts as 1)
for (const node of ['uv_layout', 'uv_unwrap']) {
  const nodes: GraphSpec['nodes'] = {
    a: { type: 'box', params: { center: [-1, 0, 0] } }, an: { type: 'attrib_create', in: ['a'], params: { name: 'name', class: 'prim', value: 'plain' } },
    b: { type: 'box', params: { center: [1, 0, 0] } }, bn: { type: 'attrib_create', in: ['b'], params: { name: 'name', class: 'prim', value: 'detail' } },
    m: { type: 'merge', in: ['an', 'bn'] },
    w: { type: 'attrib_create', in: ['m'], params: { name: 'texel_weight', class: 'prim', value: 2, group: '@name=detail' } },
    p: { type: 'uv_unwrap', in: ['w'], params: { resolution: 256 } },
    out: node === 'uv_layout' ? { type: 'uv_layout', in: ['p'], params: { resolution: 1024, island_attrib: 'chart' } } : { type: 'uv_unwrap', in: ['w'], params: { resolution: 1024 } },
  };
  const { geo } = await cook(nodes);
  const rep = uvReport(geo, { resolution: 1024 }), d = (n: string) => rep.pieces.find((q) => q.name === n)!.texelsPerMetre!;
  const ratio = d('detail') / d('plain');
  check(Math.abs(ratio - 2) < 0.1 && rep.overlap.pairs === 0, `${node} texel_weight 2 on "detail": ${ratio.toFixed(3)}× the texels per metre of "plain", no overlaps`);
}

// orient world: on every side face of a box world up (+Y) points to +v; min_rect may turn them any way
{
  const upAlongV = (g: Geometry) => {
    const uv = readUV(g)!, P = g.P, vp = g.vertexPoint, n = primNormals(g);
    let good = 0, sides = 0;
    for (let p = 0; p < g.numPrims; p++) {
      if (Math.abs(n[p * 3 + 1]) > 0.5) continue;
      sides++;
      // the corner highest in y has the highest v
      let top = -1, topV = -1;
      for (let v = g.primStart[p]; v < g.primStart[p + 1]; v++) { if (top < 0 || P[vp[v] * 3 + 1] > P[vp[top] * 3 + 1] + 1e-9) top = v; }
      for (let v = g.primStart[p]; v < g.primStart[p + 1]; v++) { if (topV < 0 || uv[v * 2 + 1] > uv[topV * 2 + 1] + 1e-9) topV = v; }
      if (Math.abs(P[vp[topV] * 3 + 1] - P[vp[top] * 3 + 1]) < 1e-9) good++;
    }
    return { good, sides };
  };
  for (const node of ['uv_layout', 'uv_unwrap']) {
    const { geo, warnings } = await cook({
      b: { type: 'box', params: { size: [1, 2, 0.5] } }, p: { type: 'uv_project', in: ['b'], params: { method: 'box' } },
      out: node === 'uv_layout' ? { type: 'uv_layout', in: ['p'], params: { orient: 'world' } } : { type: 'uv_unwrap', in: ['b'], params: { orient: 'world' } },
    });
    const u = upAlongV(geo), rep = uvReport(geo);
    check(u.sides > 0 && u.good === u.sides && rep.overlap.pairs === 0 && warnings.length === 0, `${node} orient world: up is +v on ${u.good} of ${u.sides} side faces, no overlaps`);
  }
}

// cut_long: a rail far longer than the tile is cut into parts and the atlas fills (whole, the rail sets the scale)
{
  const nodes = (cut: boolean): GraphSpec['nodes'] => ({
    rail: { type: 'box', params: { size: [8, 0.03, 0.03], center: [0, 1, 0], divisions: [32, 1, 1] } }, crate: { type: 'box' }, m: { type: 'merge', in: ['rail', 'crate'] },
    out: { type: 'uv_unwrap', in: ['m'], params: { cut_long: cut, resolution: 1024 } },
  });
  const whole = await cook(nodes(false)), cut = await cook(nodes(true));
  const rw = uvReport(whole.geo), rc = uvReport(cut.geo);
  check(rc.overlap.pairs === 0 && rc.utilization.value > rw.utilization.value * 2 && rc.charts > rw.charts, `uv_unwrap cut_long: a rail 8× the crate cut into parts (${rw.charts} → ${rc.charts} charts) fills ${(rc.utilization.value * 100).toFixed(0)}% of the tile (whole: ${(rw.utilization.value * 100).toFixed(0)}%)`);
}

// merge_thin: the bevel strips of a bevelled plate (small charts: max_chart_area) join the faces beside them: fewer
// charts, no overlaps, no new folds; and no chart is stretched one way (xatlas widens thin strips; they are flattened again)
{
  /** the worst chart's mean (by 3D area) ratio of the larger to the smaller stretch of the 3D → uv map */
  const worstStretch = (g: Geometry) => {
    const uv = readUV(g)!, { tris, triPrim } = triangulate(g), P = g.P, vp = g.vertexPoint, chart = g.prims.get('chart')!.data as Int32Array;
    const sum = new Map<number, number>(), wsum = new Map<number, number>();
    for (let t = 0; t < triPrim.length; t++) {
      const [a, b, c] = [tris[t * 3], tris[t * 3 + 1], tris[t * 3 + 2]];
      const e1 = [0, 1, 2].map((k) => P[vp[b] * 3 + k] - P[vp[a] * 3 + k]), e2 = [0, 1, 2].map((k) => P[vp[c] * 3 + k] - P[vp[a] * 3 + k]);
      const l1 = Math.hypot(...e1), n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]], nl = Math.hypot(...n);
      if (!(l1 > 0 && nl > 0)) continue;
      const qx = (e2[0] * e1[0] + e2[1] * e1[1] + e2[2] * e1[2]) / l1, qy = nl / l1;
      const du1 = uv[b * 2] - uv[a * 2], dv1 = uv[b * 2 + 1] - uv[a * 2 + 1], du2 = uv[c * 2] - uv[a * 2], dv2 = uv[c * 2 + 1] - uv[a * 2 + 1];
      const j00 = du1 / l1, j10 = dv1 / l1, j01 = (du2 - j00 * qx) / qy, j11 = (dv2 - j10 * qx) / qy;
      const f = j00 ** 2 + j01 ** 2 + j10 ** 2 + j11 ** 2, det = Math.abs(j00 * j11 - j01 * j10);
      if (!(det > 0)) continue;
      const s1 = Math.sqrt((f + Math.sqrt(Math.max(0, f * f - 4 * det * det))) / 2), k = chart[triPrim[t]];
      sum.set(k, (sum.get(k) ?? 0) + (s1 * s1 / det) * nl); wsum.set(k, (wsum.get(k) ?? 0) + nl);
    }
    return Math.max(...[...sum].map(([k, s]) => s / wsum.get(k)!));
  };
  const nodes = (merge: boolean): GraphSpec['nodes'] => ({
    b: { type: 'box', params: { size: [1, 0.06, 0.6], divisions: [8, 1, 6] } }, bv: { type: 'poly_bevel', in: ['b'], params: { offset: 0.008, divisions: 2, group: 'angle>40' } },
    out: { type: 'uv_unwrap', in: ['bv'], params: { merge_thin: merge, resolution: 1024, padding: 4, max_chart_area: 0.002 } },
  });
  const off = await cook(nodes(false)), on = await cook(nodes(true));
  const r0 = uvReport(off.geo), r1 = uvReport(on.geo);
  check(r1.charts < r0.charts && r1.overlap.pairs === 0 && r1.collapsed === 0 && r1.mirrored === 0, `uv_unwrap merge_thin: a bevelled plate in ${r1.charts} charts (${r0.charts} without), 0 overlaps, 0 mirrored; ${(r1.utilization.value * 100).toFixed(0)}% used (${(r0.utilization.value * 100).toFixed(0)}% without)`);
  const s0 = worstStretch(off.geo), s1 = worstStretch(on.geo);
  check(s0 < 1.3 && s1 < 1.3, `uv_unwrap: no chart of the bevelled plate is stretched one way (worst chart ${s0.toFixed(3)}, joined ${s1.toFixed(3)}; xatlas left the strips 8× wider than long)`);
}

// inspect uv: the density of a uniform layout is even across charts
{
  const { geo } = await cook({ b: { type: 'box', params: { divisions: [2, 2, 2] } }, out: { type: 'uv_layout', in: ['b'], params: { fit: 'udim', udims: 3 } } });
  const rep = uvReport(geo, { resolution: 1024 }), d = rep.density!;
  check(!!d && d.charts === rep.charts && d.max / d.min < 1.01 && Math.abs(d.median - d.overall) < d.overall * 0.01 && rep.tileUtilization.length >= 2, `inspect uv after uv_layout: ${d.overall.toFixed(1)} texels/m over ${d.charts} charts (spread ${(d.max / d.min).toFixed(4)}), tiles ${rep.tileUtilization.map((t) => `${t.tile} ${(t.value * 100).toFixed(0)}%`).join(', ')}`);
}

// uv_project box: faces looking along +X, +Y and -Z are mirrored (one projection per axis), -X, -Y and +Z are not
{
  const { geo } = await cook({ b: { type: 'box' }, out: { type: 'uv_project', in: ['b'], params: { method: 'box' } } });
  const uv = readUV(geo)!, n = primNormals(geo), mirrored: string[] = [];
  for (let p = 0; p < geo.numPrims; p++) {
    let a = 0;
    for (let v = geo.primStart[p], e = geo.primStart[p + 1]; v < e; v++) { const w = v + 1 < e ? v + 1 : geo.primStart[p]; a += uv[v * 2] * uv[w * 2 + 1] - uv[w * 2] * uv[v * 2 + 1]; }
    if (a < 0) mirrored.push(['-X', '+X', '-Y', '+Y', '-Z', '+Z'][[0, 1, 2].findIndex((k) => Math.abs(n[p * 3 + k]) > 0.5) * 2 + (n[p * 3 + [0, 1, 2].findIndex((k) => Math.abs(n[p * 3 + k]) > 0.5)] > 0 ? 1 : 0)]);
  }
  check(mirrored.sort().join(' ') === '+X +Y -Z', `uv_project box: mirrored faces ${mirrored.join(' ')} (as documented: +X +Y -Z)`);
}

// decimating after the unwrap: a plain reduction folds the uv of a torus; keep_uv (the default) never does, says where
// it held the reduction back, and reaches the plain count where no fold is in the way
{
  const nodes = (ratio: number, keep: boolean, node = 'decimate'): GraphSpec['nodes'] => ({
    t: { type: 'torus', params: { rows: 24, cols: 48 } },
    n: { type: 'wrangle', in: ['t'], params: { run_over: 'prims', code: 's@name = "ring";' } },
    u: { type: 'uv_unwrap', in: ['n'], params: { resolution: 512 } },
    out: node === 'lod'
      ? { type: 'lod', in: ['u'], params: { mode: 'switch', level: 1, levels: 2, ratios: [1, ratio], keep_uv: keep } }
      : { type: 'decimate', in: ['u'], params: { ratio, max_error: 1, keep_uv: keep } },
  });
  const src = uvReport((await cook({ ...nodes(1, true), out: { type: 'null', in: ['u'] } })).geo);
  for (const ratio of [0.1, 0.05]) {
    const plain = await cook(nodes(ratio, false)), kept = await cook(nodes(ratio, true));
    const rp = uvReport(plain.geo), rk = uvReport(kept.geo);
    check(src.overlap.pairs === 0 && rp.overlap.pairs > 0, `decimate keep_uv off, ratio ${ratio}: a plain reduction folds the clean uv of an unwrapped torus (${rp.overlap.pairs} overlapping pairs, ${plain.geo.numPrims} triangles)`);
    check(rk.overlap.pairs === 0 && rk.mirrored === 0 && rk.collapsed === 0, `decimate keep_uv, ratio ${ratio}: no folds (${rk.overlap.pairs} overlapping pairs, ${rk.mirrored} mirrored), ${kept.geo.numPrims} triangles`);
    const held = kept.warnings.find((w) => w.includes('folds the uv'));
    if (kept.geo.numPrims > plain.geo.numPrims * 1.02 + 2) check(!!held && held.includes('"ring"') && held.includes('largest: prim'), `decimate keep_uv, ratio ${ratio}: the warning names the part and the largest fold: ${held?.slice(0, 160)}`);
    else check(kept.geo.numPrims <= plain.geo.numPrims * 1.02 + 2 && !held, `decimate keep_uv, ratio ${ratio}: reaches the plain count (${kept.geo.numPrims} vs ${plain.geo.numPrims}) without a warning`);
  }
  const lp = await cook(nodes(0.05, false, 'lod')), lk = await cook(nodes(0.05, true, 'lod'));
  check(uvReport(lp.geo).overlap.pairs > 0 && uvReport(lk.geo).overlap.pairs === 0 && lk.warnings.some((w) => w.includes('folds the uv') && w.includes('"ring"')), `lod keep_uv: a level of the unwrapped torus keeps the uv clean (plain: ${uvReport(lp.geo).overlap.pairs} overlapping pairs) and says where it held back`);
}

// a renamed or removed param is refused, and the error says what to write now (NodeDef.renamed)
{
  const v = engine.validate({ nodes: { b: { type: 'box' }, u: { type: 'uv_unwrap', in: ['b'], params: { udim: true, rotate_charts: false } }, l: { type: 'uv_layout', in: ['u'], params: { rotate: false } } }, output: 'l' });
  const said = v.errors.map((e) => e.message).join('\n');
  check(v.errors.length === 3 && /unknown param "udim" for uv_unwrap: it is gone: fit "udim"/.test(said) && /"rotate_charts" for uv_unwrap: it is now orient: "min_rect" \(rotate_charts: true\) or "keep"/.test(said)
    && /"rotate" for uv_layout: it is now orient/.test(said), `the old names are errors that name the new ones:\n${said}`);
}

console.log(fail ? `\n${fail} uv check(s) failed` : '\nuv: all checks passed');
process.exit(fail ? 1 : 0);
