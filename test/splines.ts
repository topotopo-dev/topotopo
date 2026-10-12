// Spline toolkit tests (P2-D): the evaluation core (Bezier against its closed form, a rational NURBS circle, de Boor =
// de Casteljau, arc length, closest point, exact conversions, fitting), the Geometry model (clone, merge, subsets,
// JSON round trip, GeoBuilder), the engine's auto-conversion and its warning, the nodes (bezier, nurbs, convert_curve,
// spline_fit, fillet_curve, offset_curve_3d, project_curve, curve_attribs, resample on splines), rendering and export,
// and every node type fed spline prims (keep nodes keep them valid, the others convert with a warning).
//   node test/splines.ts
import '../src/nodes/index.ts';
import { Geometry } from '../src/core/geometry.ts';
import {
  arcLength, bezierToNurbs, closestPoint, curvatureAt, evalPoint, fitSplineTolerance, interpolateSpline, makeSpline,
  nurbsToBezier, setSplinePrim, splineFromPrim, splinesToPolylines, toPolyline,
} from '../src/core/splines.ts';
import { allNodeDefs } from '../src/graph/registry.ts';
import { geoFromJSON, geoToJSON } from '../src/io/json.ts';
import { exportGeometry, exportGeometryAsync } from '../src/io/export.ts';
import { renderGeometry } from '../src/render/raster.ts';
import { inspect, summarize } from '../src/inspect.ts';
import { fingerprint } from './fingerprint.ts';
import { SKIP, checkGeo, createFixtureEngine, fixtureGraphFor } from './fixtures.ts';
import type { GraphSpec, NodeSpec } from '../src/graph/types.ts';

const { engine } = await createFixtureEngine();

let fail = 0, pass = 0;
const check = (ok: any, msg: string) => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
};
const e = (x: number) => x.toExponential(1);
async function run(nodes: Record<string, NodeSpec>, output: string) {
  const r = await engine.cook({ nodes, output });
  if (!r.ok || !r.geo) throw new Error(`cook failed: ${r.errors.map((x) => `[${x.node}] ${x.message}`).join('; ')}`);
  return { geo: r.geo, warnings: r.warnings.map((w) => `[${w.node}] ${w.message}`) };
}
const cook = async (nodes: Record<string, NodeSpec>, output: string) => (await run(nodes, output)).geo;
const valid = (g: Geometry, label: string) => {
  const errs = checkGeo(g);
  check(!errs.length, `${label}: geometry invariants${errs.length ? ' — ' + errs.join(', ') : ''}`);
};
/** Distance from q to a polyline (3 numbers per point). */
function distToPolyline(q: ArrayLike<number>, P: ArrayLike<number>, closed = false): number {
  const n = P.length / 3;
  let best = Infinity;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const j = (i + 1) % n;
    const a = [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]], b = [P[j * 3], P[j * 3 + 1], P[j * 3 + 2]];
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], l2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
    let t = l2 > 0 ? ((q[0] - a[0]) * ab[0] + (q[1] - a[1]) * ab[1] + (q[2] - a[2]) * ab[2]) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(a[0] + ab[0] * t - q[0], a[1] + ab[1] * t - q[1], a[2] + ab[2] * t - q[2]));
  }
  return best;
}
const primPos = (g: Geometry, p: number) => {
  const pts = g.primPoints(p), out: number[] = [];
  for (const i of pts) out.push(g.P[i * 3], g.P[i * 3 + 1], g.P[i * 3 + 2]);
  return out;
};

// ---------------------------------------------------------------- evaluation core

{
  const B = [0, 0, 0, 1, 2, 0.5, 3, 2, 1, 4, 0, -1];
  const bz = makeSpline('bezier', B, { order: 4 });
  let d = 0;
  for (let i = 0; i < 20; i++) {
    const t = i / 19, s = 1 - t;
    const c = [0, 1, 2].map((k) => s * s * s * B[k] + 3 * s * s * t * B[3 + k] + 3 * s * t * t * B[6 + k] + t * t * t * B[9 + k]);
    const p = evalPoint(bz, t);
    d = Math.max(d, ...p.map((v, k) => Math.abs(v - c[k])));
  }
  check(d < 1e-12, `4-CV cubic Bezier = closed form at 20 samples (max diff ${e(d)})`);
  const nb = makeSpline('nurbs', B, { order: 4, knots: [0, 0, 0, 0, 1, 1, 1, 1] });
  d = 0;
  for (let i = 0; i <= 64; i++) d = Math.max(d, ...evalPoint(bz, i / 64).map((v, k) => Math.abs(v - evalPoint(nb, i / 64)[k])));
  check(d < 1e-12, `de Boor (NURBS with a Bezier knot vector) = de Casteljau (max diff ${e(d)})`);

  // Houdini-style multi-segment Bezier: 7 CVs of order 4 = two cubic segments meeting on CV 3
  const two = makeSpline('bezier', [0, 0, 0, 1, 1, 0, 2, 1, 0, 3, 0, 0, 4, -1, 0, 5, -1, 0, 6, 0, 0], { order: 4 });
  const mid = evalPoint(two, 0.5);
  check(two.pieces.length === 2 && !two.notes.length && Math.hypot(mid[0] - 3, mid[1], mid[2]) < 1e-12, '7 CVs of order 4: two segments, u = 0.5 is CV 3');
  const odd = makeSpline('bezier', [0, 0, 0, 1, 1, 0, 2, 1, 0, 3, 0, 0, 4, -1, 0], { order: 4 });
  check(odd.pieces.length === 2 && odd.notes.length === 1 && Math.abs(evalPoint(odd, 1)[0] - 4) < 1e-12, `5 CVs of order 4: a short last segment with a note (${odd.notes[0]})`);

  // rational NURBS circle: 9 CVs, weights 1, √½ alternating, double interior knots
  const r = 2, h = Math.SQRT1_2;
  const C = [r, 0, 0, r, 0, r, 0, 0, r, -r, 0, r, -r, 0, 0, -r, 0, -r, 0, 0, -r, r, 0, -r, r, 0, 0];
  const circ = makeSpline('nurbs', C, { order: 3, weights: [1, h, 1, h, 1, h, 1, h, 1], knots: [0, 0, 0, 0.25, 0.25, 0.5, 0.5, 0.75, 0.75, 1, 1, 1] });
  d = 0;
  for (let i = 0; i <= 500; i++) { const p = evalPoint(circ, i / 500); d = Math.max(d, Math.abs(Math.hypot(p[0], p[2]) - r), Math.abs(p[1])); }
  check(d < 1e-9, `NURBS circle (9 weighted CVs) lies on the circle (max radial error ${e(d)})`);
  let kd = 0;
  for (let i = 0; i <= 50; i++) kd = Math.max(kd, Math.abs(curvatureAt(circ, i / 50) - 1 / r));
  check(kd < 1e-9, `NURBS circle curvature = 1/r (max error ${e(kd)})`);
  const L = arcLength(circ);
  check(Math.abs(L - 2 * Math.PI * r) < 1e-9, `NURBS circle arc length = 2πr (${L.toFixed(12)})`);
  const q1 = closestPoint(circ, [5, 0.3, 1]), q2 = closestPoint(circ, [0.3, 0, -0.2]);
  const want1 = Math.hypot(Math.hypot(5, 1) - r, 0.3), want2 = r - Math.hypot(0.3, 0.2);
  check(Math.abs(q1.dist - want1) < 1e-9 && Math.abs(q2.dist - want2) < 1e-9, `closest point on the circle: distance = |radius - |q|| outside and inside (${e(Math.abs(q1.dist - want1))}, ${e(Math.abs(q2.dist - want2))})`);
  const st = makeSpline('nurbs', [0, 0, 0, 0.1, 0, 0, 0.5, 0, 0, 2, 0, 0, 3, 0, 0], { order: 4, knots: [0, 0, 0, 0, 0.3, 1, 1, 1, 1] });
  check(Math.abs(arcLength(st) - 3) < 1e-12, `arc length of a straight NURBS with uneven CVs and knots = 3 (${arcLength(st)})`);
  const poly = toPolyline(circ, { tolerance: 1e-3 });
  let worst = 0;
  for (let i = 0; i < 200; i++) { const p = evalPoint(circ, (i + 0.5) / 200); worst = Math.max(worst, distToPolyline(p, poly.P)); }
  check(worst <= 1e-3 + 1e-12, `adaptive polyline of the circle within its tolerance 1e-3 (${poly.u.length} points, worst ${e(worst)})`);

  // exact conversions
  const bn = bezierToNurbs(two);
  const asN = makeSpline('nurbs', bn.cvs.flatMap((c) => c.P), { order: bn.order, knots: bn.knots });
  d = 0;
  for (let i = 0; i <= 64; i++) d = Math.max(d, ...evalPoint(two, i / 64).map((v, k) => Math.abs(v - evalPoint(asN, i / 64)[k])));
  check(d < 1e-12, `Bezier → NURBS is exact (max diff ${e(d)})`);
  const cb = nurbsToBezier(circ);
  const asB = makeSpline('bezier', cb.cvs.flatMap((c) => c.P), { order: cb.order, weights: cb.cvs.map((c) => c.w) });
  d = 0;
  for (let i = 0; i <= 200; i++) d = Math.max(d, Math.abs(Math.hypot(evalPoint(asB, i / 200)[0], evalPoint(asB, i / 200)[2]) - r));
  check(d < 1e-12 && cb.cvs.length === 9, `NURBS circle → rational Bezier (4 quadratic segments) stays on the circle (${e(d)})`);
  const per = makeSpline('nurbs', [1, 0, 0, 0, 0, 1, -1, 0, 0, 0, 0, -1, 0.5, 0, -0.5], { order: 4, closed: true });
  const pb = nurbsToBezier(per);
  const perB = makeSpline('bezier', pb.cvs.flatMap((c) => c.P), { order: pb.order, closed: true });
  d = 0;
  for (let i = 0; i <= 100; i++) d = Math.max(d, closestPoint(perB, evalPoint(per, i / 100)).dist);
  check(d < 1e-9 && pb.cvs.length === 15, `closed (periodic) NURBS → closed Bezier is exact (${e(d)})`);

  // fitting
  const Q: number[] = [];
  for (let i = 0; i < 40; i++) { const a = (i / 39) * Math.PI * 1.5; Q.push(Math.cos(a) * 3, Math.sin(a * 2) * 0.5, Math.sin(a) * 3); }
  const it = interpolateSpline(Q, false, 4);
  check(it.error < 1e-9 && it.P.length === Q.length, `global interpolation passes through all 40 points (${e(it.error)})`);
  const ft = fitSplineTolerance(Q, { closed: false, order: 4, tolerance: 0.01 });
  check(ft.error <= 0.01 && ft.P.length / 3 < 20, `least-squares fit within 0.01 with ${ft.P.length / 3} CVs (error ${ft.error.toFixed(4)})`);
  const Qc: number[] = [];
  for (let i = 0; i < 30; i++) { const a = (i / 30) * Math.PI * 2; Qc.push(Math.cos(a) * 3, 0, Math.sin(a) * 2); }
  const ic = interpolateSpline(Qc, true, 4), ic3 = interpolateSpline(Qc, true, 3);
  check(ic.error < 1e-9 && ic3.error < 1e-9, `closed (periodic) interpolation, cubic and quadratic (${e(ic.error)}, ${e(ic3.error)})`);
}

// ---------------------------------------------------------------- geometry model

{
  const g = await cook({ a: { type: 'nurbs', params: { points: [[0, 0, 0], [1, 1, 0], [2, 0, 0], [3, 1, 0], [4, 0, 0]] } }, b: { type: 'bezier' }, l: { type: 'line' }, m: { type: 'merge', in: ['a', 'l', 'b'] } }, 'm');
  valid(g, 'merge of nurbs + line + bezier');
  check(g.primKind?.[0] === 3 && g.primKind?.[1] === 0 && g.primKind?.[2] === 2 && g.numSplines === 2 && !g.hasPacked() && g.numPacked === 0, 'merge keeps the kinds (3, 0, 2); splines are not packed');
  const c = g.clone();
  check(c.primKind !== g.primKind && c.primKind![2] === 2 && c.hasSplines(), 'clone copies the kind array');
  const sub = g.subsetPrims([1, 1, 0]);
  check(sub.primKind?.[0] === 3 && sub.primKind?.[1] === 0 && sub.numSplines === 1 && !checkGeo(sub).length, 'subsetPrims keeps the NURBS prim');
  const none = g.subsetPrims([0, 1, 0]);
  check(!none.primKind && !none.hasSplines(), 'removing every spline clears the kind arrays');
  const keepPts = new Uint8Array(g.numPoints).fill(1);
  keepPts[0] = 0;
  const sp = g.subsetPoints(keepPts);
  check(sp.primKind?.[0] === 3 && sp.primSize(0) === 4 && !checkGeo(sp).length && splineFromPrim(sp, 0).notes.length === 1, 'subsetPoints: an open spline loses the CV (its knot vector no longer fits: replaced with a note)');
  const back = geoFromJSON(JSON.parse(JSON.stringify(geoToJSON(g))));
  check(JSON.stringify(fingerprint(back)) === JSON.stringify(fingerprint(g)) && back.primKind?.[2] === 2, 'JSON round trip keeps spline kinds, orders and knots');
  const fp = fingerprint(g);
  check(fp.splines?.bezier === 1 && fp.splines?.nurbs === 1, 'fingerprints record spline kinds');
  const s = summarize(g);
  check(/1 Bezier curve/.test(s) && /1 NURBS curve/.test(s), `inspect summary names the curves (${s.split('\n')[0]})`);
  const listing = inspect(g, { detail: 'elements', cls: 'prim' });
  check(/nurbs order 4 cvs\[/.test(listing) && /bezier order 4 cvs\[/.test(listing), 'inspect element listing shows spline prims');
  // GeoBuilder does not propagate spline kinds; packed prims next to splines stay packed
  const pk = await cook({ a: { type: 'nurbs' }, bx: { type: 'box' }, pk: { type: 'pack', in: ['bx'] }, m: { type: 'merge', in: ['a', 'pk'] } }, 'm');
  check(pk.primKind?.[0] === 3 && pk.primKind?.[1] === 1 && pk.numPacked === 1 && pk.numSplines === 1 && !checkGeo(pk).length, 'packed and spline prims side by side (kinds 3 and 1)');
  const both = geoFromJSON(JSON.parse(JSON.stringify(geoToJSON(pk))));
  check(both.numPacked === 1 && both.numSplines === 1 && !checkGeo(both).length, 'JSON round trip of packed + spline prims');
}

// ---------------------------------------------------------------- engine: auto-conversion

{
  const r = await run({ a: { type: 'nurbs', params: { closed: true } }, x: { type: 'poly_extrude', in: ['a'], params: { distance: 0.5 } } }, 'x');
  check(r.warnings.some((w) => /converted 1 spline curve to polylines for x \(poly_extrude/.test(w)) && !r.geo.hasSplines(), `poly_extrude on a spline converts it with one warning (${r.warnings[0]})`);
  const r2 = await run({ a: { type: 'nurbs', params: { closed: true } }, x: { type: 'poly_extrude', in: ['a'], params: { distance: 0.6 } } }, 'x');
  check(r2.warnings.length === 1, 'the conversion is cached and warned once per node');
  const rs = await run({ a: { type: 'nurbs', params: { points: [[0, 0, 0], [1, 2, 0], [3, -1, 1], [4, 1, 0]] } }, r: { type: 'resample', in: ['a'], params: { length: 0.05 } } }, 'r');
  const s = makeSpline('nurbs', [0, 0, 0, 1, 2, 0, 3, -1, 1, 4, 1, 0], { order: 4 });
  let d = 0;
  for (let i = 0; i < rs.geo.numPoints; i++) d = Math.max(d, closestPoint(s, [rs.geo.P[i * 3], rs.geo.P[i * 3 + 1], rs.geo.P[i * 3 + 2]]).dist);
  const segs: number[] = [];
  const pts = rs.geo.primPoints(0);
  for (let k = 1; k < pts.length; k++) segs.push(Math.hypot(...[0, 1, 2].map((c) => rs.geo.P[pts[k] * 3 + c] - rs.geo.P[pts[k - 1] * 3 + c])));
  const spread = Math.max(...segs) - Math.min(...segs);
  check(!rs.warnings.length && !rs.geo.hasSplines() && d < 1e-9 && spread < 1e-3, `resample keeps splines (no warning) and samples the exact curve (on-curve ${e(d)}, segment spread ${e(spread)})`);
  const cu = rs.geo.points.get('curveu')!.data as Float64Array;
  check(cu[0] === 0 && Math.abs(cu[cu.length - 1] - 1) < 1e-12, 'resample on a spline writes curveu 0..1');
  const cp = await run({ a: { type: 'nurbs' }, r: { type: 'resample', in: ['a'], params: { treat_splines: 'control_polygon', length: 0.2 } } }, 'r');
  const cv = await cook({ a: { type: 'nurbs' } }, 'a');
  let dc = 0;
  for (let i = 0; i < cp.geo.numPoints; i++) dc = Math.max(dc, distToPolyline([cp.geo.P[i * 3], cp.geo.P[i * 3 + 1], cp.geo.P[i * 3 + 2]], cv.P));
  check(dc < 1e-9 && !cp.geo.hasSplines(), 'resample treat_splines "control_polygon" samples the CV hull');
  // keep nodes: transform moves the CVs and the curve stays a spline (affine invariance)
  const t = await run({ a: { type: 'nurbs' }, t: { type: 'transform', in: ['a'], params: { translate: [1, 2, 3], rotate: [10, 20, 30], scale: [2, 1, 0.5] } } }, 't');
  check(!t.warnings.length && t.geo.numSplines === 1 && t.geo.numPoints === 6, 'transform keeps the NURBS (moves its CVs, no warning)');
  const cp2 = await run({ a: { type: 'bezier' }, pts: { type: 'point_grid', params: { counts: [2, 1, 2] } }, c: { type: 'copy_to_points', in: ['a', 'pts'] } }, 'c');
  check(!cp2.warnings.length && cp2.geo.numSplines === 4 && !checkGeo(cp2.geo).length, 'copy_to_points copies spline prims as splines');
  const pac = await run({ a: { type: 'nurbs' }, p: { type: 'points_along_curve', in: ['a'], params: { spacing: 0.5 } } }, 'p');
  const sn = splineFromPrim(await cook({ a: { type: 'nurbs' } }, 'a'), 0);
  let pd = 0;
  for (let i = 0; i < pac.geo.numPoints; i++) pd = Math.max(pd, closestPoint(sn, [pac.geo.P[i * 3], pac.geo.P[i * 3 + 1], pac.geo.P[i * 3 + 2]]).dist);
  check(!pac.warnings.length && pac.geo.numPoints > 8 && pd < 5e-3, `points_along_curve samples a NURBS itself (no warning; ${pac.geo.numPoints} points within ${e(pd)} of the curve)`);
  const sw = await run({ a: { type: 'nurbs' }, s: { type: 'sweep', in: ['a'] } }, 's');
  check(!sw.warnings.length && sw.geo.numPrims > 100, 'sweep samples a NURBS backbone itself (no warning)');
}

// ---------------------------------------------------------------- nodes

{
  // bezier / nurbs generators
  const w = await run({ a: { type: 'nurbs', params: { points: [[0, 0, 0], [1, 1, 0], [2, 0, 0]], order: 3, weights: [1, 5, 1] } }, b: { type: 'nurbs', params: { points: [[0, 0, 0], [1, 1, 0], [2, 0, 0]], order: 3 } } }, 'a');
  const plain = await cook({ b: { type: 'nurbs', params: { points: [[0, 0, 0], [1, 1, 0], [2, 0, 0]], order: 3 } } }, 'b');
  const yw = evalPoint(splineFromPrim(w.geo, 0), 0.5)[1], yp = evalPoint(splineFromPrim(plain, 0), 0.5)[1];
  check(w.geo.points.has('Pw') && Math.abs(yp - 0.5) < 1e-12 && Math.abs(yw - 5 / 6) < 1e-12, `weights (Pw) pull the curve toward the CV (y at u = 0.5: ${yp} → ${yw.toFixed(6)})`);
  const fitn = await cook({ a: { type: 'nurbs', params: { points: [[0, 0, 0], [2, 1, 0], [4, 0, 1], [6, 2, 1]], fit: true } } }, 'a');
  const sf = splineFromPrim(fitn, 0);
  const through = [[0, 0, 0], [2, 1, 0], [4, 0, 1], [6, 2, 1]].every((q) => closestPoint(sf, q).dist < 1e-9);
  check(through, 'nurbs fit:true passes through every point');
  const kn = await run({ a: { type: 'nurbs', params: { points: [[0, 0, 0], [1, 1, 0], [2, 0, 0], [3, 1, 0]], order: 3, knots: [0, 0, 0, 0.8, 1, 1, 1] } } }, 'a');
  check(!kn.warnings.length && Math.abs((kn.geo.prims.get('knots')!.getArray(0) as number[])[3] - 0.8) < 1e-12, 'explicit knots are stored');
  const bad = await run({ a: { type: 'nurbs', params: { knots: [0, 1, 2] } } }, 'a');
  check(bad.warnings.some((x) => /knots: 3 values/.test(x)), `invalid knots are replaced with a warning (${bad.warnings[0]})`);
  const fromIn = await cook({ c: { type: 'circle', params: { segments: 8 } }, b: { type: 'bezier', in: ['c'], params: { order: 3 } } }, 'b');
  check(fromIn.numSplines === 1 && fromIn.primClosed[0] === 1 && fromIn.numPoints === 8, 'bezier from an input polygon: its points become the CVs of a closed curve');

  // convert round trip: polyline → nurbs fit → polyline within tolerance
  const conv = await cook({
    c: { type: 'curve', params: { points: [[0, 0, 0], [1, 0.5, 0.2], [2, 0, 0.6], [3, 0.6, 0.3], [4, 0, 0]] } },
    n: { type: 'convert_curve', in: ['c'], params: { to: 'nurbs', fit: true } },
    p: { type: 'convert_curve', in: ['n'], params: { to: 'polyline', tolerance: 1e-3 } },
  }, 'p');
  const orig = [0, 0, 0, 1, 0.5, 0.2, 2, 0, 0.6, 3, 0.6, 0.3, 4, 0, 0];
  let d = 0;
  for (let k = 0; k < 5; k++) d = Math.max(d, distToPolyline(orig.slice(k * 3, k * 3 + 3), conv.P));
  check(d <= 1e-3 && !conv.hasSplines() && conv.numPrims === 1, `polyline → nurbs (fit) → polyline passes the original points within the tolerance (${e(d)}, ${conv.numPoints} points)`);
  // bezier → nurbs → bezier through the node is exact
  const bnb = await cook({ b: { type: 'bezier' }, n: { type: 'convert_curve', in: ['b'], params: { to: 'nurbs' } }, z: { type: 'convert_curve', in: ['n'], params: { to: 'bezier' } } }, 'z');
  const bz0 = await cook({ b: { type: 'bezier' } }, 'b');
  d = 0;
  const sa = splineFromPrim(bz0, 0), sb = splineFromPrim(bnb, 0);
  for (let i = 0; i <= 50; i++) d = Math.max(d, ...evalPoint(sa, i / 50).map((v, k) => Math.abs(v - evalPoint(sb, i / 50)[k])));
  check(d < 1e-12 && bnb.primKind![0] === 2, `convert_curve bezier → nurbs → bezier is exact (${e(d)})`);
  const bfit = await cook({ c: { type: 'curve', params: { points: [[0, 0, 0], [1, 1, 0], [2, 0, 0], [3, 1, 0]] } }, b: { type: 'convert_curve', in: ['c'], params: { to: 'bezier', fit: true } } }, 'b');
  const sbz = splineFromPrim(bfit, 0);
  check(bfit.numPoints === 10 && [[0, 0, 0], [1, 1, 0], [2, 0, 0], [3, 1, 0]].every((q) => closestPoint(sbz, q).dist < 1e-9), 'convert_curve polyline → bezier with fit: cubic segments through every point');

  // spline_fit on a noisy helix
  const sfit = await run({
    h: { type: 'spiral', params: { turns: 1.5, points_per_turn: 60 } },
    n: { type: 'jitter', in: ['h'], params: { amount: 0.01, seed: 4 } },
    f: { type: 'spline_fit', in: ['n'], params: { tolerance: 0.03 } },
  }, 'f');
  const fe = sfit.geo.prims.get('fit_error')!.get(0) as number;
  check(sfit.geo.numSplines === 1 && sfit.geo.numPoints < 30 && fe <= 0.03 && !sfit.warnings.length, `spline_fit compresses a 91-point noisy helix to ${sfit.geo.numPoints} CVs within 0.03 (error ${fe.toFixed(4)})`);

  // fillet of a right angle: tangent points at the radius from the corner, arc points at the radius from the centre
  const fl = await cook({ c: { type: 'curve', params: { points: [[-2, 0, 0], [0, 0, 0], [0, 0, 2]] } }, f: { type: 'fillet_curve', in: ['c'], params: { radius: 0.5, segments: 8 } } }, 'f');
  const grp = fl.pointGroups.get('fillet')!;
  let arc = 0, cnt = 0;
  for (let i = 0; i < fl.numPoints; i++) if (grp[i]) { cnt++; arc = Math.max(arc, Math.abs(Math.hypot(fl.P[i * 3] + 0.5, fl.P[i * 3 + 1], fl.P[i * 3 + 2] - 0.5) - 0.5)); }
  const ends = fl.primPoints(0);
  const t1 = ends[1], t2 = ends[ends.length - 2];
  const tdist = [t1, t2].map((i) => Math.hypot(fl.P[i * 3], fl.P[i * 3 + 1], fl.P[i * 3 + 2]));
  check(cnt === 9 && arc < 1e-12 && tdist.every((x) => Math.abs(x - 0.5) < 1e-12), `fillet of a right angle: 9 arc points at r = 0.5 from the centre (${e(arc)}), tangent points 0.5 from the corner`);
  const ch = await cook({ c: { type: 'curve', params: { points: [[-2, 0, 0], [0, 0, 0], [0, 0, 2]] } }, f: { type: 'fillet_curve', in: ['c'], params: { radius: 0.5, type: 'chamfer' } } }, 'f');
  check(ch.numPoints === 4, 'chamfer cuts the corner with two points');
  const clamp = await cook({ c: { type: 'curve', params: { points: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [2, 0, 1]] } }, f: { type: 'fillet_curve', in: ['c'], params: { radius: 5 } } }, 'f');
  valid(clamp, 'fillet with a radius clamped between neighbouring corners');
  const sq = await cook({ s: { type: 'shape2d' }, f: { type: 'fillet_curve', in: ['s'], params: { radius: 0.1, segments: 4 } } }, 'f');
  check(sq.numPoints === 20 && sq.primClosed[0] === 1, 'fillet of a closed square: 4 corners × 5 points, still closed');

  // 3D offset along a helix keeps the distance
  const helix = await cook({ h: { type: 'spiral', params: { radius: 2, height: 3, turns: 2, points_per_turn: 96 } } }, 'h');
  const off = await cook({ h: { type: 'spiral', params: { radius: 2, height: 3, turns: 2, points_per_turn: 96 } }, o: { type: 'offset_curve_3d', in: ['h'], params: { distance: 0.3 } } }, 'o');
  let od = 0;
  for (let i = 0; i < off.numPoints; i++) od = Math.max(od, Math.abs(distToPolyline([off.P[i * 3], off.P[i * 3 + 1], off.P[i * 3 + 2]], helix.P) - 0.3));
  check(od < 1e-3, `offset_curve_3d along a helix keeps distance 0.3 (max deviation ${e(od)})`);
  const rails = await cook({ h: { type: 'spiral', params: { radius: 2, height: 3, turns: 1 } }, o: { type: 'offset_curve_3d', in: ['h'], params: { distance: 0.4, both: true, frame: 'plane', lift: 1 } } }, 'o');
  const side = rails.prims.get('side')!.data as Int32Array;
  check(rails.numPrims === 2 && side[0] === 1 && side[1] === -1, 'both:true writes two rails with prim side ±1');
  const nOff = await run({ a: { type: 'nurbs' }, o: { type: 'offset_curve_3d', in: ['a'], params: { distance: 0.2 } } }, 'o');
  check(!nOff.warnings.length && !nOff.geo.hasSplines() && nOff.geo.numPoints > 20, 'offset_curve_3d samples a NURBS itself');
  const mit = await cook({ c: { type: 'curve', params: { points: [[0, 0, 0], [2, 0, 0], [2, 0, 2]] } }, o: { type: 'offset_curve_3d', in: ['c'], params: { distance: -0.5, frame: 'plane' } } }, 'o');
  // the mitre point lies 0.5 from both edge lines: (2.5, 0, -0.5) (positive = right of travel = direction × up, so -0.5 is the outer side)
  const mp = [mit.P[3], mit.P[4], mit.P[5]];
  const md = Math.hypot(mp[0] - 2.5, mp[1], mp[2] + 0.5);
  check(mit.numPoints === 3 && md < 1e-12, `mitre corner of a right angle: the offset edges meet at (2.5, 0, -0.5) (${e(md)})`);
  const rnd = await cook({ c: { type: 'curve', params: { points: [[0, 0, 0], [2, 0, 0], [2, 0, 2]] } }, o: { type: 'offset_curve_3d', in: ['c'], params: { distance: -0.5, frame: 'plane', corner: 'round' } } }, 'o');
  let rd = 0;
  for (let i = 1; i < rnd.numPoints - 1; i++) rd = Math.max(rd, Math.abs(Math.hypot(rnd.P[i * 3] - 2, rnd.P[i * 3 + 1], rnd.P[i * 3 + 2]) - 0.5));
  check(rnd.numPoints === 7 && rd < 1e-12, `round corner: an arc of radius 0.5 around the corner (${rnd.numPoints} points)`);

  // project onto the plane y = 1
  const pr = await cook({
    pl: { type: 'grid', params: { size: [10, 10], center: [0, 1, 0] } },
    c: { type: 'nurbs', params: { points: [[-3, 4, -2], [0, -3, 0], [2, 6, 3], [4, 2, -1]] } },
    p: { type: 'project_curve', in: ['c', 'pl'], params: { spacing: 0.2 } },
  }, 'p');
  const ys = Array.from({ length: pr.numPoints }, (_, i) => pr.P[i * 3 + 1]);
  const hit = pr.points.get('hit')!.data as Int32Array, N = pr.points.get('N')!.data as Float64Array;
  check(ys.every((y) => Math.abs(y - 1) < 1e-12) && hit.every((h) => h === 1) && Math.abs(N[1] - 1) < 1e-12 && pr.numPoints > 30, `project_curve onto the plane y = 1: every point at y = 1, hit 1, N up (${pr.numPoints} points)`);
  const hf = await cook({
    hf: { type: 'heightfield', params: { size: [8, 8], resolution: 0.25 } },
    n: { type: 'heightfield_noise', in: ['hf'], params: { amplitude: 1 } },
    c: { type: 'curve', params: { points: [[-3, 5, -3], [3, 5, 3]] } },
    p: { type: 'project_curve', in: ['c', 'n'], params: { spacing: 0.5 } },
  }, 'p');
  const hfn = await cook({ hf: { type: 'heightfield', params: { size: [8, 8], resolution: 0.25 } }, n: { type: 'heightfield_noise', in: ['hf'], params: { amplitude: 1 } } }, 'n');
  const field = hfn.volumes[0] as any;
  let hd = 0;
  for (let i = 0; i < hf.numPoints; i++) hd = Math.max(hd, Math.abs(hf.P[i * 3 + 1] - field.sample(hf.P[i * 3], hf.P[i * 3 + 2])));
  check(hd < 1e-12 && hf.numPoints === 18, `project_curve onto a heightfield samples it exactly (${e(hd)})`);
  const miss = await cook({ pl: { type: 'grid', params: { size: [2, 2] } }, c: { type: 'line', params: { origin: [0, 1, 0], direction: [1, 0, 0], length: 4, points: 5 } }, p: { type: 'project_curve', in: ['c', 'pl'], params: { misses: 'delete' } } }, 'p');
  check(miss.numPoints === 2, 'project_curve misses:"delete" removes points beyond the surface');

  // curve attributes
  const ca = await cook({ a: { type: 'nurbs' }, r: { type: 'resample', in: ['a'], params: { length: 0.1 } }, c: { type: 'curve_attribs', in: ['r'], params: { frame: true, curvature: true, segment: true, ramp_attrib: 'width', ramp: [[0, 0.4], [1, 0.1]] } } }, 'c');
  const u = ca.points.get('curveu')!.data as Float64Array, al = ca.points.get('arclength')!.data as Float64Array, wd = ca.points.get('width')!.data as Float64Array;
  let mono = true;
  for (let i = 1; i < u.length; i++) if (!(u[i] > u[i - 1])) mono = false;
  check(mono && u[0] === 0 && Math.abs(u[u.length - 1] - 1) < 1e-12 && al[0] === 0, 'curveu is monotonic from 0 to 1, arclength starts at 0');
  check(Math.abs(wd[0] - 0.4) < 1e-12 && Math.abs(wd[wd.length - 1] - 0.1) < 1e-12, 'ramp_attrib evaluates the ramp along curveu into "width"');
  const Nn = ca.points.get('N')!.data as Float64Array, up = ca.points.get('up')!.data as Float64Array;
  let orth = 0;
  for (let i = 0; i < ca.numPoints; i++) orth = Math.max(orth, Math.abs(Nn[i * 3] * up[i * 3] + Nn[i * 3 + 1] * up[i * 3 + 1] + Nn[i * 3 + 2] * up[i * 3 + 2]));
  check(orth < 1e-9, `frames: N (tangent) ⟂ up (${e(orth)})`);
  const cc = await cook({ c: { type: 'circle', params: { radius: 2, segments: 64 } }, a: { type: 'curve_attribs', in: ['c'], params: { curvature: true } } }, 'a');
  const kv = cc.points.get('curvature')!.data as Float64Array;
  check(kv.every((k) => Math.abs(k - 0.5) < 1e-9), 'curvature of a polygon circle of radius 2 is 0.5 at every point');
  const cs = await run({ a: { type: 'nurbs' }, c: { type: 'curve_attribs', in: ['a'], params: { curvature: true } } }, 'c');
  const ucv = cs.geo.points.get('curveu')!.data as Float64Array;
  check(!cs.warnings.length && cs.geo.numSplines === 1 && ucv[0] === 0 && Math.abs(ucv[5] - 1) < 1e-12 && ucv.every((x, i) => !i || x > ucv[i - 1]), 'curve_attribs on a NURBS writes its CVs (Greville parameters), the curve stays a spline');
}

// ---------------------------------------------------------------- render and export

{
  const g = await cook({ a: { type: 'nurbs' }, b: { type: 'bezier', params: { closed: true, points: [[0, 0, 0], [0, 0, 1], [1, 0, 1], [1, 0, 0], [1, 0, -1], [0, 0, -1]] } }, m: { type: 'merge', in: ['a', 'b'] } }, 'm');
  const img = renderGeometry(g, { width: 200, height: 150, views: ['top'] } as any);
  check(img.notes.some((n) => /1 Bezier \+ 1 NURBS curves drawn as polylines/.test(n)) && img.rgba.some((v, i) => i % 4 === 2 && v > 200), `render draws splines as polylines (${img.notes.join('; ')})`);
  const notes: string[] = [];
  const obj = new TextDecoder().decode(exportGeometry(g, 'obj', { warn: (m) => notes.push(m) }));
  const lines = obj.split('\n').filter((l) => l.startsWith('l ') || l.startsWith('f '));
  check(lines.length === 2 && lines[0].split(' ').length > 20 && notes.some((n) => /2 spline curves/.test(n)), `obj writes the evaluated curves (${lines[0].split(' ').length - 1} points) with a note`);
  const glb = await exportGeometryAsync(g, 'glb', {});
  check(glb.length > 500, 'glb export of spline prims (as line strips / a polygon)');
  const geo = new TextDecoder().decode(exportGeometry(g, 'geo', {}));
  check(/PolygonCurve_run/.test(geo) && !/NURB|Bezier/.test(geo), 'Houdini .geo writes the evaluated polylines');
  const json = JSON.parse(new TextDecoder().decode(exportGeometry(g, 'json', {})));
  check(json.splines?.kind?.join() === '3,2', 'json export keeps the spline prims (lossless)');
  // packed instances of a spline: exporters and the renderer evaluate the curve inside the source too
  const pk = await cook({ a: { type: 'nurbs' }, pts: { type: 'point_grid', params: { counts: [2, 1, 1] } }, c: { type: 'copy_to_points', in: ['a', 'pts'], params: { pack: true } } }, 'c');
  const pkNotes: string[] = [];
  const objp = new TextDecoder().decode(exportGeometry(pk, 'obj', { warn: (m) => pkNotes.push(m) }));
  const lp = objp.split('\n').filter((l) => l.startsWith('l '));
  check(pk.numPacked === 2 && lp.length === 2 && lp[0].split(' ').length > 20 && pkNotes.some((m) => /inside packed instances/.test(m)), `packed instances of a NURBS export their evaluated curves (${lp[0]?.split(' ').length - 1} points each)`);
  const pimg = renderGeometry(pk, { width: 160, height: 120, views: ['top'] } as any);
  check(pimg.notes.some((m) => /2 NURBS curves drawn as polylines/.test(m)), `render of packed splines draws their curves (${pimg.notes.join('; ')})`);
  // splinesToPolylines keeps other prims and their points
  const mixed = await cook({ a: { type: 'nurbs' }, bx: { type: 'box' }, m: { type: 'merge', in: ['bx', 'a'] } }, 'm');
  const conv = splinesToPolylines(mixed).geo;
  check(conv.numPrims === 7 && !conv.hasSplines() && conv.primSize(0) === 4 && !conv.prims.has('knots') && !checkGeo(conv).length, 'splinesToPolylines: the box keeps its faces and points, spline attributes are dropped');
  // a hand-built spline prim through setSplinePrim
  const hb = new Geometry({ positions: [0, 0, 0, 1, 1, 0, 2, 0, 0], prims: [[0, 1, 2]], closed: false });
  setSplinePrim(hb, 0, 'nurbs', 3, null);
  check(hb.isSpline(0) && splineFromPrim(hb, 0).order === 3 && Math.abs(evalPoint(splineFromPrim(hb, 0), 0.5)[1] - 0.5) < 1e-12, 'setSplinePrim makes a NURBS of an existing prim');
}

// ---------------------------------------------------------------- every node type fed spline prims

{
  const bad: string[] = [];
  let n = 0, kept = 0, converted = 0;
  for (const def of allNodeDefs()) {
    if (SKIP.has(def.type)) continue;
    const graph: GraphSpec = fixtureGraphFor(def.type);
    const target = graph.nodes.target;
    const ins = Array.isArray(target.in) ? (target.in as string[]) : [];
    if (!ins.length) continue;
    // the first input plus a NURBS and a closed Bezier, merged
    graph.nodes.__n = { type: 'nurbs', params: { points: [[0, 0, 0], [0.5, 0.4, 0.3], [1, 0, 0.6], [1.5, 0.3, 0]] } };
    graph.nodes.__b = { type: 'bezier', params: { closed: true, points: [[0, 0, 0], [0, 0, 0.5], [0.5, 0, 0.5], [0.5, 0, 0], [0.5, 0, -0.5], [0, 0, -0.5]] } };
    graph.nodes.__s = { type: 'merge', in: [ins[0], '__n', '__b'] };
    target.in = ['__s', ...ins.slice(1)];
    n++;
    try {
      const r = await engine.cook(graph);
      const tr = r.results.get('target');
      if (!tr) { bad.push(`${def.type}: no result`); continue; }
      if (tr.error) {
        if (/TypeError|RangeError|Cannot read|is not a function|of undefined|of null/.test(tr.error.message)) bad.push(`${def.type}: internal error on spline input: ${tr.error.message}`);
        else console.log(`   (${def.type} on spline input: ${tr.error.message})`);
        continue;
      }
      const errs = checkGeo(tr.geo!);
      if (errs.length) bad.push(`${def.type}: ${errs.join(', ')}`);
      const params = { ...Object.fromEntries(Object.entries(def.params).map(([k, pd]) => [k, pd.default])), ...(target.params ?? {}) };
      const pk = typeof def.packed === 'function' ? def.packed(params) : def.packed ?? 'unpack';
      const policy = typeof def.splines === 'function' ? def.splines(params) : def.splines ?? (pk === 'keep' ? 'keep' : 'polyline');
      const warned = tr.warnings.some((w) => /^converted \d+ spline curves? to polylines/.test(w));
      if (policy === 'polyline') { if (warned) converted++; else bad.push(`${def.type}: converting node without the warning`); }
      else { if (!warned) kept++; else bad.push(`${def.type}: keep node warned`); }
    } catch (err: any) {
      bad.push(`${def.type}: threw ${err?.stack ?? err}`);
    }
  }
  for (const b of bad) console.log('   ' + b);
  check(!bad.length, `every node type with spline input: ${n} types cooked, ${kept} kept splines, ${converted} converted with a warning`);
}

console.log(`\nsplines: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
