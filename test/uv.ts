// UV toolkit behaviour: uv_unwrap (xatlas), uv_flatten (LSCM), uv_layout (packing), uv_autoseam, the uv view.
//   node test/uv.ts
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { Geometry } from '../src/core/geometry.ts';
import { triangulate } from '../src/core/topology.ts';
import { buildCharts, lscm, polygonSides, readUV, uvSeamPairs } from '../src/core/uv.ts';
import { exportGeometry } from '../src/io/export.ts';
import { importGeometry } from '../src/io/import.ts';
import { renderGeometry } from '../src/render/raster.ts';
import { encodePNG } from '../src/render/png.ts';
import zlib from 'node:zlib';
import type { GraphSpec } from '../src/graph/types.ts';

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
  const { geo: u } = await cook({ b: { type: 'box', params: { divisions: [2, 2, 2] } }, out: { type: 'uv_layout', in: ['b'], params: { udims: 3 } } });
  const uvu = readUV(u)!;
  let umax = 0, vmax = 0;
  for (let i = 0; i < uvu.length; i += 2) { umax = Math.max(umax, uvu[i]); vmax = Math.max(vmax, uvu[i + 1]); }
  check(umax > 1 && umax <= 3 && vmax <= 1, `uv_layout udims 3: islands spread over UDIM 1001..1003 (u max ${umax.toFixed(2)}, v max ${vmax.toFixed(2)})`);
}

// ---------------------------------------------------------------- GLB round trip
{
  const { geo: g } = await cook({ b: { type: 'box', params: { divisions: [2, 1, 1] } }, out: { type: 'uv_unwrap', in: ['b'] } });
  const back = importGeometry(exportGeometry(g, 'glb'), 'glb');
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

console.log(fail ? `\n${fail} uv check(s) failed` : '\nuv: all checks passed');
process.exit(fail ? 1 : 0);
