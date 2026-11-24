import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GeoBuilder } from '../src/core/geometry.ts';
import type { Geometry } from '../src/core/geometry.ts';
import { cross, dot, normalize, sub } from '../src/core/math.ts';
import type { Vec3 } from '../src/core/math.ts';
import { curveParams, evalDerivs, evalPoint, fitSpline, fitSplineTolerance, interpolateSpline, makeSpline, splineFromPrim } from '../src/core/splines.ts';
import { closestSurfacePoint, evalSurface, surfaceFromPrim } from '../src/core/nurbssurface.ts';
import type { NurbsSurface } from '../src/core/nurbssurface.ts';
import { addSurfacePrim, fitSurface, mirrorSection } from '../src/core/surfacefit.ts';
import type { SurfaceFit, SurfaceSection } from '../src/core/surfacefit.ts';
import { getNodeDef } from '../src/graph/registry.ts';
import type { GraphSpec, NodeSpec } from '../src/graph/types.ts';
import { geoToJSON } from '../src/io/json.ts';
import { createFixtureEngine } from './fixtures.ts';

const { engine } = await createFixtureEngine();
let pass = 0, fail = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); pass++; console.log(`PASS ${name}`); }
  catch (error) { fail++; console.log(`FAIL ${name}: ${error instanceof Error ? error.stack : error}`); }
}

const distance = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const z = (j: number, n: number) => 1.2 * (j / (n - 1) - 0.5);
function body(counts: number[]): SurfaceSection[] {
  return counts.map((m, j) => ({
    closed: true,
    pts: Array.from({ length: m }, (_, i) => {
      const a = 2 * Math.PI * i / m, v = j / (counts.length - 1);
      const radius = 0.17 + 0.025 * Math.sin(Math.PI * v);
      return [radius * Math.cos(a), 0.85 * radius * Math.sin(a), z(j, counts.length)];
    }),
  }));
}

/** Independent tensor evaluator reading the surface prim. */
function readSurface(g: Geometry) {
  assert.equal(g.numPrims, 1);
  assert.equal(g.primKind?.[0], 4);
  assert.equal(g.packedSource?.[0], -1);
  assert.deepEqual(Array.from(g.packedXform!), [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  assert.equal(g.prims.get('name')?.get(0), 'surface');
  assert.ok(!g.points.get('Pw'));
  const cols = Number(g.prims.get('surface_cols')!.get(0)), rows = g.numVertices / cols;
  assert.ok(Number.isInteger(rows) && rows >= 2 && cols >= 2);
  const closedU = !!g.primClosed[0], closedV = g.prims.get('closed_v')!.get(0) === 1;
  const orderU = Number(g.prims.get('spline_order')!.get(0)), orderV = Number(g.prims.get('spline_order_v')!.get(0));
  const knotsU = g.prims.get('knots')!.getArray(0) as number[], knotsV = g.prims.get('knots_v')!.getArray(0) as number[];
  assert.equal(knotsU.length, cols + (closedU ? 1 : orderU));
  assert.equal(knotsV.length, rows + (closedV ? 1 : orderV));
  const ids = g.primPoints(0);
  const uRows = Array.from({ length: rows }, (_, j) => {
    const P = ids.slice(j * cols, (j + 1) * cols).flatMap((i) => Array.from(g.P.subarray(i * 3, i * 3 + 3)));
    return makeSpline('nurbs', P, { order: orderU, closed: closedU, knots: knotsU });
  });
  const alongV = (P: number[], v: number) => evalDerivs(makeSpline('nurbs', P, { order: orderV, closed: closedV, knots: knotsV }), v);
  return {
    cols, rows, closedU, closedV, orderU, orderV,
    point: (u: number, v: number) => alongV(uRows.flatMap((s) => evalPoint(s, u)), v).P,
    normal: (u: number, v: number) => {
      const derivs = uRows.map((s) => evalDerivs(s, u));
      return normalize(cross(alongV(derivs.flatMap((d) => d.d1), v).P, alongV(derivs.flatMap((d) => d.P), v).d1));
    },
  };
}

function maxError(surface: ReturnType<typeof readSurface>, fit: SurfaceFit, sections: SurfaceSection[], pinsOnly = false) {
  return Math.max(...sections.flatMap((s, j) => (pinsOnly ? s.pins ?? [] : s.pts.map((_, i) => i)).map((i) =>
    distance(s.pts[i], surface.point(...fit.params[j][i])),
  )));
}

function loftGraph(sections: SurfaceSection[], params: Record<string, unknown> = {}): GraphSpec {
  const nodes: Record<string, NodeSpec> = {};
  const inputs = sections.map((s, i) => {
    const name = `section${i}`;
    nodes[name] = { type: 'curve', params: { points: s.pts, closed: s.closed } };
    return name;
  });
  nodes.parts = { type: 'merge', in: inputs };
  nodes.skin = { type: 'loft', in: ['parts'], params: { output: 'surface', ...params } };
  return { nodes, output: 'skin' };
}

async function cook(graph: GraphSpec) {
  const result = await engine.cook(graph);
  assert.ok(result.ok && result.geo, JSON.stringify(result.errors));
  return { result, geo: result.geo };
}

const line = Array.from({ length: 17 }, (_, i) => [i * 0.1, 0.04 * Math.sin(i * 2.1), 0.01 * Math.cos(i)]);
const Q = line.flat(), pins = [3, 8, 12], fitOpts = { closed: false, order: 4, cvs: 8, smoothing: 2 };
const good = body([9, 9, 9, 9, 9, 9]);

await check('1. Exact curve pins with smoothing and parameter correction', () => {
  const fixed = fitSpline(Q, { ...fitOpts, pins });
  const free = fitSpline(Q, fitOpts);
  const t = curveParams(Q, false, 'centripetal');
  const curve = makeSpline('nurbs', fixed.P, fixed);
  assert.ok(Math.max(...pins.map((i) => distance(line[i], evalPoint(curve, t[i])))) < 1e-9);
  assert.ok(pins.some((i) => distance(line[i], evalPoint(makeSpline('nurbs', free.P, free), t[i])) > 1e-3));
  assert.ok(fixed.params.some((u, i) => !pins.includes(i) && Math.abs(t[i] - u) > 1e-4));
  assert.throws(() => fitSpline(Q, { ...fitOpts, cvs: 4, pins }), /pins: 3 pinned points plus 2 fixed ends need more than 4 CVs/);
  const auto = fitSplineTolerance(Q, { ...fitOpts, tolerance: 1, pins });
  assert.equal(auto.P.length / 3, fitOpts.order + pins.length);
  const s = makeSpline('nurbs', auto.P, auto);
  assert.ok(pins.every((i) => distance(line[i], evalPoint(s, auto.params[i])) < 1e-9));
});

await check('2. spline_fit point group and fit_error', async () => {
  const { geo } = await cook({ nodes: {
    line: { type: 'curve', params: { points: line } },
    fit: { type: 'spline_fit', in: ['line'], params: { cv_count: 8, smoothing: 2, pins: '3 8 12' } },
  }, output: 'fit' });
  const s = splineFromPrim(geo, 0), t = curveParams(Q, false, 'centripetal');
  assert.ok(pins.every((i) => distance(line[i], evalPoint(s, t[i])) < 1e-9));
  const expected = fitSpline(Q, { ...fitOpts, pins });
  assert.equal(geo.prims.get('fit_error')!.get(0), expected.error);
  assert.ok(expected.error > 1e-3);
});

await check('3. Interpolate 6 × 9 and face outward', async () => {
  const fit = fitSurface(good), { geo } = await cook(loftGraph(good));
  const s = readSurface(geo), error = maxError(s, fit, good);
  assert.ok(error < 1e-6, `error ${error} m`);
  assert.deepEqual([s.cols, s.rows], [9, 6]);
  const middle = 3, uv = fit.params[middle][0];
  const radial = sub(s.point(...uv), [0, 0, z(middle, good.length)]);
  assert.ok(dot(s.normal(...uv), radial) > 0);
  assert.ok(Math.abs(Number(geo.detail.get('fit_error')!.get(0)) - error) < 1e-12);
  console.log(`     ${s.cols} × ${s.rows} CVs, max error ${error.toExponential(3)} m`);
});

await check('4. Exact knot insertion for 5, 9 and 7 points', () => {
  for (const [closed, order] of [[false, 4], [true, 4], [true, 3]] as const) {
    const sections = body([5, 9, 7]).map((s) => ({ ...s, closed }));
    const fit = fitSurface(sections, { order: [order, 4] }), surface = readSurface(addSurfacePrim(fit));
    const error = maxError(surface, fit, sections);
    assert.ok(error < 1e-6, `closed=${closed} order=${order}: error ${error} m`);
    console.log(`     ${closed ? 'closed' : 'open'} order ${order}, ${fit.cols} × ${fit.rows} CVs, max error ${error.toExponential(3)} m`);
  }
});

let seed = 10;
const noise = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return 0.003 * (2 * seed / 4294967296 - 1);
};
const noisy = good.map((s) => ({ ...s, pts: s.pts.map((p) => p.map((x) => x + noise())) }));
const approximate = { fit: 'approximate', smoothing: 1, tolerance: 0.005 } as const;
let fairBodies: ReturnType<typeof readSurface>[] = [];

function largestNormalChange(surface: ReturnType<typeof readSurface>) {
  let max = 0;
  for (let i = 0; i < 60; i++) {
    let prev = surface.normal(i / 60, 0);
    for (let j = 1; j < 120; j++) {
      const next = surface.normal(i / 60, j / 119);
      const angle = Math.atan2(Math.hypot(...cross(prev, next)), dot(prev, next));
      max = Math.max(max, angle);
      prev = next;
    }
  }
  return max;
}

await check('5. Approximate within 5 mm with at most half the normal change', () => {
  const fine = fitSurface(noisy), fair = fitSurface(noisy, approximate);
  const surfaces = [fine, fair].map((f) => readSurface(addSurfacePrim(f)));
  fairBodies = surfaces;
  const [a, b] = surfaces.map(largestNormalChange);
  const e = maxError(surfaces[1], fair, noisy);
  console.log(`     max error ${(e * 1000).toFixed(3)} mm, normals ${(a * 180 / Math.PI).toFixed(4)}° → ${(b * 180 / Math.PI).toFixed(4)}°, ${fine.cols} × ${fine.rows} → ${fair.cols} × ${fair.rows} CVs`);
  assert.ok(e <= 0.005 && Math.abs(e - fair.error) < 1e-12);
  assert.ok(b <= a / 2, `normal change ratio ${b / a}`);
});

await check('6. Pin three points on three sections and report their count', async () => {
  const picks = [[1, 2], [2, 4], [4, 7]];
  const sections = noisy.map((s, j) => ({ ...s, pins: picks.filter(([r]) => j === r).map(([, i]) => i) }));
  const fit = fitSurface(sections, approximate);
  const { result, geo } = await cook(loftGraph(sections, { ...approximate, pins: picks.map(([r, i]) => r * 9 + i).join(' ') }));
  const error = maxError(readSurface(geo), fit, sections, true);
  assert.ok(error < 1e-6, `pin error ${error} m`);
  assert.equal(fit.pinnedSections, 3);
  assert.equal(result.results.get('skin')?.stats?.pinned_sections, 3);
  console.log(`     three sections, max pin error ${error.toExponential(3)} m`);
});

function halfBody(counts: number[]) {
  return counts.map((m, j) => ({
    closed: false,
    pts: Array.from({ length: m }, (_, i) => {
      const a = Math.PI * i / (m - 1), r = 0.2 + 0.03 * j;
      return [r * Math.sin(a), -r * Math.cos(a), j * 0.35];
    }),
  }));
}

await check('7. Mirror x, open and closed sections, seam normals and reflected pins', async () => {
  const half = halfBody([5, 5, 5, 5, 5]);
  const full = half.map(mirrorSection);
  const f = fitSurface(full, { mirror: true });
  const { geo } = await cook(loftGraph(half, { mirror: 'x' }));
  const s = readSurface(geo);
  assert.ok(s.closedU);
  assert.equal(full[0].pts.length, 8);
  const verify = (s: ReturnType<typeof readSurface>, f: SurfaceFit, half: SurfaceSection[]) => {
    let reflected = 0, centerNormal = 0;
    for (let j = 0; j < half.length; j++) {
      const m = half[j].pts.length;
      for (let i = 1; i < m - 1; i++) {
        const [x, y, z] = s.point(...f.params[j][i]);
        const q = s.point(...f.params[j][2 * (m - 1) - i]);
        reflected = Math.max(reflected, distance([-x, y, z], q));
      }
      for (const i of [0, m - 1]) centerNormal = Math.max(centerNormal, Math.abs(s.normal(...f.params[j][i])[0]));
    }
    assert.ok(reflected < 1e-9, `mirror error ${reflected}`);
    assert.ok(centerNormal < 1e-9, `normal x ${centerNormal}`);
    console.log(`     reflection ${reflected.toExponential(3)} m, centre normal x ${centerNormal.toExponential(3)}`);
  };
  verify(s, f, half);
  const unequal = halfBody([5, 7, 6, 5, 6]);
  for (const order of [3, 4]) {
    const m = fitSurface(unequal.map(mirrorSection), { mirror: true, order: [order, 4] });
    verify(readSurface(addSurfacePrim(m)), m, unequal);
  }
  const pinHalves = half.map((r, j) => ({ ...r, pins: j === 2 ? [2] : [] }));
  const pinFull = pinHalves.map(mirrorSection);
  const faired = fitSurface(pinFull, { ...approximate, mirror: true });
  const fs = readSurface(addSurfacePrim(faired));
  verify(fs, faired, half);
  assert.deepEqual(pinFull[2].pins, [2, 6]);
  assert.ok(maxError(fs, faired, pinFull, true) < 1e-6);
  const open = half.map((r) => ({ ...r, pts: r.pts.slice(1) }));
  const openFull = open.map(mirrorSection);
  const fo = fitSurface(openFull, { ...approximate, mirror: true });
  const openGeo = (await cook(loftGraph(open, { mirror: 'x', ...approximate }))).geo;
  const os = readSurface(openGeo);
  assert.ok(!os.closedU);
  assert.equal(openFull[0].pts.length, 7);
  const startsOnCenter = { ...half[0], pts: half[0].pts.slice(0, -1) };
  const reordered = mirrorSection(startsOnCenter, 0);
  assert.deepEqual(reordered.pts[0], startsOnCenter.pts.at(-1));
  assert.equal(reordered.pts[3][0], 0);
  assert.equal(reordered.pts.at(-1)![0], -reordered.pts[0][0]);
  const a = os.point(...fo.params[2][1]);
  assert.ok(distance([-a[0], a[1], a[2]], os.point(...fo.params[2][5])) < 1e-9);
  const polys = (await cook(loftGraph(half, { mirror: 'x', output: 'polygons' }))).geo;
  assert.equal(polys.numPrims, 32);
  assert.equal(polys.numPoints, 40);
  assert.throws(() => mirrorSection({ ...half[0], pts: [[0, 0, 0], [-0.1, 1, 0]] }, 1), /mirror x: section 2, point 2 has negative x/);
  assert.throws(() => mirrorSection({ ...half[0], pts: half[0].pts.slice(1, -1) }, 2), /mirror x: section 3 needs an end on x = 0/);
});

await check('8. Periodic v and profile placements have valid storage', async () => {
  const rings = body([9, 9, 9, 9]).map((s, j) => ({
    ...s, pts: s.pts.map(([x, y]) => [(1 + x) * Math.cos(j * Math.PI / 2), y, (1 + x) * Math.sin(j * Math.PI / 2)]),
  }));
  const a = await cook(loftGraph(rings, { closed: true }));
  const closed = readSurface(a.geo), f = fitSurface(rings, { closedV: true });
  assert.ok(closed.closedV);
  assert.ok(maxError(closed, f, rings) < 1e-6);
  const graph = loftGraph([good[0]], { sections: [{}, { offset: [0, 0, 0.6], scale: 1.5 }, { offset: [0, 0, 1.2] }] });
  graph.nodes.section0.type = 'nurbs';
  const b = await cook(graph), placed = readSurface(b.geo);
  assert.equal(placed.rows, 3);
  assert.equal(placed.orderV, 3);
  assert.ok(b.result.warnings.some((w) => w.message.includes('order lowered to [4, 3]')));
});

await check('9. Default polygon cooks match main byte for byte', async () => {
  const example = getNodeDef('loft')!.example as GraphSpec;
  const open = loftGraph([
    { closed: false, pts: [[0, 0, 0], [1, 0.25, 0], [2, 0, 0]] },
    { closed: false, pts: [[0, 0.2, 1], [0.4, 0.6, 1], [1.5, 0.2, 1], [2, 0, 1]] },
  ], { output: 'polygons' });
  for (const [graph, hash] of [
    [example, '5dc683fb907dd8eef6ccb8e0bb09979613c1ce1aca412812313f5618c95d2a63'],
    [open, 'a6e7d4c20faa1123a2cfad4677e749acf8d68b0738060f394354d8419720e5b7'],
  ] as const) {
    const { geo } = await cook(graph);
    assert.equal(createHash('sha256').update(JSON.stringify(geoToJSON(geo))).digest('hex'), hash);
  }
});

await check('10. Invalid parameters give actionable errors', async () => {
  const bad = async (graph: GraphSpec, pattern: RegExp) => {
    const r = await engine.cook(graph);
    assert.ok(!r.ok && r.errors.some((e) => pattern.test(e.message)), JSON.stringify(r.errors));
  };
  await bad(loftGraph(good, { caps: true }), /^loft: caps needs output polygons; a surface has no caps\. Close the ends with sections that shrink to a small loop, or use output polygons\.$/);
  await bad(loftGraph(good.slice(0, 2), { closed: true }), /closed: use at least 3 sections/);
  await bad(loftGraph(good.slice(0, 2), { sections: [{}] }), /sections places copies of one profile/);
  await bad(loftGraph([good[0]]), /loft needs at least 2 curves/);
  await bad(loftGraph([good[0], { ...good[1], closed: false }]), /sections must be all closed or all open/);
  await bad(loftGraph(halfBody([4, 5]), { output: 'polygons', resample: 'none' }), /resample "none" needs every section/);
  await bad(loftGraph([good[0], good[1]], { mirror: 'x' }), /mirror x: section 1, point \d+ has negative x/);
  const far = halfBody([5, 5]).map((r) => ({ ...r, pts: r.pts.slice(1, -1) }));
  await bad(loftGraph(far, { mirror: 'x' }), /mirror x: section 1 needs an end on x = 0/);
  await bad(loftGraph(good, { ...approximate, cvs: [4, 4], pins: '0-4' }), /pins: 5 pinned points need more than 4 CVs/);
  await bad(loftGraph(good, { ...approximate, cvs: [9, 4], pins: '9 18 27' }), /pins: 3 pinned points plus 2 fixed ends need more than 4 CVs/);
  await bad({ nodes: {
    line: { type: 'curve', params: { points: line } },
    fit: { type: 'spline_fit', in: ['line'], params: { cv_count: 4, pins: '3 8 12' } },
  }, output: 'fit' }, /pins: 3 pinned points plus 2 fixed ends need more than 4 CVs/);
  assert.throws(() => fitSpline(Q, { ...fitOpts, pins: [17] }), /pins: point index 17 is outside the 17 input points/);
});

await check('11. Approximate 40 × 24 in under one second', () => {
  const sections = body(Array(40).fill(24));
  const start = performance.now(), fit = fitSurface(sections, approximate);
  const elapsed = performance.now() - start;
  console.log(`     ${elapsed.toFixed(1)} ms, ${fit.cols} × ${fit.rows} CVs, ${(fit.error * 1000).toFixed(3)} mm max error`);
  assert.ok(fit.error <= approximate.tolerance);
  assert.ok(elapsed < 1000, `${elapsed.toFixed(1)} ms`);
});

function railGraph(sections: SurfaceSection[], rails: SurfaceSection[], params: Record<string, unknown> = {}) {
  const graph = loftGraph(sections, { tolerance: 0.00004, ...params });
  const ids = rails.map((rail, i) => {
    const id = `rail${i}`;
    graph.nodes[id] = { type: 'curve', params: { points: rail.pts } };
    return id;
  });
  graph.nodes.rails = { type: 'merge', in: ids };
  graph.nodes.skin.in = ['parts', 'rails'];
  return graph;
}

function network(counts: number[], mirror = false, railCount = 3) {
  const stations = counts.map((_, i) => i / (counts.length - 1));
  const across = Array.from({ length: railCount }, (_, i) => mirror ? i / railCount : i / (railCount - 1));
  const p = (u: number, v: number) => {
    const r = 0.16 + 0.08 * v * (1 - v), a = Math.PI * u;
    return mirror ? [u === 0 || u === 1 ? 0 : r * Math.sin(a), -r * Math.cos(a), v]
      : [0.4 * (u - 0.5), r * (1 - (2 * u - 1) ** 2), v];
  };
  const sections = counts.map((n, i) => {
    const u = [...new Set([...across, 1])];
    while (u.length < n) {
      let widest = 0;
      for (let k = 1; k < u.length - 1; k++) if (u[k + 1] - u[k] > u[widest + 1] - u[widest]) widest = k;
      const f = n % 2 ? 0.49 : 0.51;
      u.splice(widest + 1, 0, u[widest] * f + u[widest + 1] * (1 - f));
    }
    return { pts: u.map((t) => p(t, stations[i])), closed: false };
  });
  const rails = across.map((u) => ({ pts: stations.map((v) => p(u, v)), closed: false }));
  return { sections, rails, crossings: stations.flatMap((v) => across.map((u) => p(u, v))) };
}

function curveDeviation(surface: NurbsSurface, curves: SurfaceSection[]) {
  let max = 0;
  for (const { pts, closed } of curves) {
    const fit = interpolateSpline(pts.flat(), closed, 4), curve = makeSpline('nurbs', fit.P, fit);
    for (let i = 0; i < 50; i++) {
      const q = evalPoint(curve, i / 49) as Vec3;
      max = Math.max(max, Math.sqrt(closestSurfacePoint(surface, q).d2));
    }
  }
  return max;
}

const openNetwork = network([9, 9, 9, 9, 9]);
const halfNetwork = network([13, 13, 13, 13, 13], true);

async function verifyNetwork(data: ReturnType<typeof network>, mirror = false) {
  const { sections, rails, crossings } = data;
  const { geo, result } = await cook(railGraph(sections, rails, mirror ? { mirror: 'x' } : {}));
  const surface = surfaceFromPrim(geo, 0)!;
  assert.ok(surface);
  assert.equal(surface.u.closed, mirror);
  const stats = result.results.get('skin')?.stats;
  assert.equal(stats?.sections, sections.length);
  assert.equal(stats?.rails, mirror ? 5 : rails.length);
  assert.ok(Number(stats?.network_gap_max) < 1e-9);
  assert.ok(Number(geo.detail.get('fit_error')?.get(0)) <= 0.00004);
  const reflections = (qs: number[][]) => qs.map(([x, y, z]) => [-x, y, z]);
  const grid = mirror ? [...crossings, ...reflections(crossings)] : crossings;
  const crossingError = Math.max(...grid.map((q) => Math.sqrt(closestSurfacePoint(surface, q as Vec3).d2)));
  const full = mirror ? [...sections.map(mirrorSection), ...rails, ...rails.slice(1).map((s) => ({ ...s, pts: reflections(s.pts) }))] : [...sections, ...rails];
  const curveError = curveDeviation(surface, full);
  console.log(`     crossings ${crossingError.toExponential(3)} m, 50 samples per curve ${curveError.toExponential(3)} m`);
  assert.ok(crossingError < 1e-9);
  assert.ok(curveError < 1e-4);
  return surface;
}

await check('Rails 1. Five sections and three rails interpolate the network', async () => {
  await verifyNetwork(openNetwork);
  const { sections, rails } = openNetwork;
  const graph = railGraph([sections[0], sections[3], sections[1], sections[2], sections[4]], rails, { smoothing: 1, cvs: [6, 6], pins: '0' });
  const { result } = await cook(graph);
  assert.ok(result.warnings.some((w) => /reordered/.test(w.message)));
  assert.equal(result.warnings.filter((w) => /smoothing, cvs and pins/.test(w.message)).length, 1);
});

await check('Rails 2. A rail controls the shape between sections', async () => {
  const { sections, rails } = openNetwork;
  const bulge: Vec3 = [0, 0.23, 0.375];
  const bowed = rails.map((r, i) => i === 1 ? { ...r, pts: [...r.pts.slice(0, 2), bulge, ...r.pts.slice(2)] } : r);
  const withRails = surfaceFromPrim((await cook(railGraph(sections, bowed))).geo, 0)!;
  const without = surfaceFromPrim((await cook(loftGraph(sections))).geo, 0)!;
  const guided = Math.sqrt(closestSurfacePoint(withRails, bulge).d2);
  const plain = Math.sqrt(closestSurfacePoint(without, bulge).d2);
  console.log(`     bulge distance with rails ${guided.toExponential(3)} m, without rails ${plain.toExponential(3)} m`);
  assert.ok(guided < 1e-4 && plain > 0.03);
});

await check('Rails 3. Sections have seven, twelve and nine uneven samples', async () => {
  await verifyNetwork(network([7, 12, 9]));
});

await check('Rails 4. A centre rail and two side rails mirror smoothly', async () => {
  const surface = await verifyNetwork(halfNetwork, true);
  let symmetry = 0, normalX = 0;
  for (let j = 0; j <= 10; j++) {
    const v = j / 10;
    for (const u of [0, 0.5]) normalX = Math.max(normalX, Math.abs(evalSurface(surface, u, v).N[0]));
    for (let i = 0; i <= 24; i++) {
      const u = i / 24, { P: [x, y, z] } = evalSurface(surface, u, v);
      symmetry = Math.max(symmetry, distance([-x, y, z], evalSurface(surface, 1 - u, v).P));
    }
  }
  console.log(`     symmetry ${symmetry.toExponential(3)} m, largest centre normal x ${normalX.toExponential(3)}`);
  assert.ok(symmetry < 1e-9 && normalX < 1e-9);
});

await check('Rails 5. Misses, inconsistent order and incompatible options give actionable errors', async () => {
  const { sections, rails } = openNetwork;
  const shifted = rails.map((r, i) => i ? r : { ...r, pts: r.pts.map(([x, y, z]) => [x - 0.01, y, z]) });
  const reversed = sections.map((s, i) => i === 1 ? { ...s, pts: s.pts.slice().reverse() } : s);
  const reversedRail = rails.map((r, i) => i === 1 ? { ...r, pts: r.pts.slice().reverse() } : r);
  for (const [graph, pattern] of [
    [railGraph(sections, shifted), /section 1, rail 1.*10.*mm.*move the rail onto the section or raise network_tolerance/i],
    [railGraph(reversed, rails), /section 2.*rails.*out of order/i],
    [railGraph(sections, reversedRail), /section 2.*rails 1 and 2.*out of order/i],
    [railGraph(sections, rails, { output: 'polygons' }), /rails.*output.*surface/i],
    [railGraph(sections, rails, { fit: 'approximate' }), /rails make the surface pass through every curve; fair the curves first \(spline_fit with smoothing, pins on the crossings\) and use fit interpolate\./],
    [railGraph(sections, rails, { closed: true }), /rails need open lofts/i],
  ] as const) {
    const result = await engine.cook(graph);
    assert.ok(!result.ok && result.errors.some((e) => pattern.test(e.message)), JSON.stringify(result.errors));
  }
});

await check('Rails. Closed sections can start at different points and use an even-degree skin', async () => {
  const { sections, rails, crossings } = halfNetwork;
  const full = sections.map(mirrorSection).map((s, i) => ({ ...s, pts: [...s.pts.slice(i * 3), ...s.pts.slice(0, i * 3)] }));
  const graph = railGraph(full, rails, { order: [3, 4] });
  const surface = surfaceFromPrim((await cook(graph)).geo, 0)!;
  assert.ok(surface.u.closed);
  assert.equal(surface.u.order, 3);
  for (const q of crossings) assert.ok(Math.sqrt(closestSurfacePoint(surface, q as Vec3).d2) < 1e-9);
});

await check('Rails. Use the exact rational NURBS sections and Bezier rails', async () => {
  const stations = [0, 0.25, 0.5, 0.75, 1];
  const sections = stations.map((z) => ({ pts: [[-0.2, 0, z], [0, 0.3 * (1 + 0.2 * z), z], [0.2, 0, z]], closed: false }));
  const rails = [-0.2, 0, 0.2].map((x) => ({ pts: [0, 0.1, 0.8, 1].map((z) => [x, x === 0 ? 0.1 * (1 + 0.2 * z) : 0, z]), closed: false }));
  const graph = railGraph(sections, rails);
  sections.forEach(({ pts }, i) => { graph.nodes[`section${i}`] = { type: 'nurbs', params: { points: pts, order: 3, weights: [1, 0.5, 1] } }; });
  rails.forEach(({ pts }, i) => { graph.nodes[`rail${i}`] = { type: 'bezier', params: { points: pts, weights: [1, 1.5, 0.6, 1] } }; });
  const { geo, result } = await cook(graph), surface = surfaceFromPrim(geo, 0)!;
  assert.ok(result.warnings.every((w) => !w.message.includes('converted')));
  let error = 0;
  for (const { pts } of sections) {
    const section = makeSpline('nurbs', pts.flat(), { order: 3, weights: [1, 0.5, 1] });
    for (let i = 0; i < 50; i++) error = Math.max(error, Math.sqrt(closestSurfacePoint(surface, evalPoint(section, i / 49) as Vec3).d2));
  }
  console.log(`     rational source deviation ${error.toExponential(3)} m`);
  assert.ok(error < 1e-4);
});

await check('Rails 7. Smoothing has a stable effect across sample and CV counts', () => {
  const reductions: number[] = [];
  for (const points of [20, 80, 320]) for (const cvs of [10, 40, 160]) {
    const t = Float64Array.from({ length: points }, (_, i) => i / (points - 1));
    const Q = Array.from(t, (u) => [u, 0.08 * Math.sin(2 * Math.PI * u) + 0.008 * Math.sin(3 * Math.PI * u), 0]).flat();
    const fit = (smoothing: number) => fitSpline(Q, { order: 4, closed: false, cvs, params: t, smoothing, corrections: 0 });
    const roughness = (r: ReturnType<typeof fit>) => {
      const curve = makeSpline('nurbs', r.P, r), q = Array.from({ length: 200 }, (_, i) => evalPoint(curve, i / 199));
      return q.slice(1, -1).reduce((sum, b, i) => sum + b.reduce((d, x, k) => d + (q[i][k] - 2 * x + q[i + 2][k]) ** 2, 0), 0);
    };
    const a = fit(0), b = fit(1), before = roughness(a), after = roughness(b);
    reductions.push(1 - after / before);
    console.log(`     ${points} points, ${cvs} requested CVs, ${b.P.length / 3} used, error ${b.error.toExponential(6)} m, roughness ${after.toExponential(8)} (unsmoothed ${before.toExponential(8)})`);
  }
  assert.ok(Math.min(...reductions) > 0 && Math.max(...reductions) <= 2 * Math.min(...reductions), String(reductions));
});

await check('Rails 8. Twelve closed mirrored sections and six input rails in under one second', async () => {
  const { sections, rails } = network(Array(12).fill(15), true, 6);
  const start = performance.now();
  await cook(railGraph(sections, rails, { mirror: 'x' }));
  const elapsed = performance.now() - start;
  console.log(`     ${elapsed.toFixed(1)} ms`);
  assert.ok(elapsed < 1000, `${elapsed.toFixed(1)} ms`);
});

const railPreview = process.env.TOPOTOPO_LOFT_RAILS_PREVIEW;
if (railPreview) writeFileSync(railPreview, JSON.stringify(railGraph(halfNetwork.sections, halfNetwork.rails, { mirror: 'x' }), null, 2));

// Sample the isoparm grid and join it with quads for the zebra renderer.
const preview = process.env.TOPOTOPO_SURFACE_FIT_PREVIEWS;
if (preview && fairBodies.length) for (const [i, name] of ['interpolate', 'approximate'].entries()) {
  const surface = fairBodies[i], b = new GeoBuilder();
  const grid = Array.from({ length: 120 }, (_, j) =>
    Array.from({ length: 60 }, (_, k) => b.addPoint(...surface.point(k / 60, j / 119))),
  );
  for (let j = 0; j < 119; j++) for (let k = 0; k < 60; k++) {
    const next = (k + 1) % 60;
    b.addPrim([grid[j][k], grid[j][next], grid[j + 1][next], grid[j + 1][k]]);
  }
  const samples = `${name}-samples.json`;
  writeFileSync(join(preview, samples), JSON.stringify(geoToJSON(b.build())));
  const graph = { nodes: { body: { type: 'file', params: { path: samples } } }, output: 'body' };
  writeFileSync(join(preview, `${name}.json`), JSON.stringify(graph));
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
