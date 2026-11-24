import assert from 'node:assert/strict';
import { edgeKey, forEachPrimEdge } from '../src/core/edges.ts';
import type { Geometry } from '../src/core/geometry.ts';
import { halfEdges } from '../src/core/halfedge.ts';
import type { Vec3 } from '../src/core/math.ts';
import { newellOf } from '../src/core/polyedit.ts';
import { evalBasis, splineFromPrim } from '../src/core/splines.ts';
import { buildEdges, primNormals, signedVolume } from '../src/core/topology.ts';
import { getNodeDef } from '../src/graph/registry.ts';
import type { GraphSpec, NodeSpec } from '../src/graph/types.ts';
import { creaseSharpness, subdivideLevel } from '../src/nodes/topology.ts';
import { checkGeo, createFixtureEngine } from './fixtures.ts';
import { fingerprint } from './fingerprint.ts';

const { engine } = await createFixtureEngine();

const section: Vec3[] = [[0, -0.14, 0], [0.12, -0.11, 0], [0.19, 0, 0], [0.12, 0.11, 0], [0, 0.14, 0]];
const names = ['keel', 'sill', 'belt', 'shoulder', 'roof'];
const ring = (z: number, s = 1) => section.map(([x, y]) => [s * x, s * y, z] as Vec3);
const lengths = [ring(-0.5, 0.55), ring(-0.28, 0.9), ring(0.05), ring(0.31, 0.87), ring(0.5, 0.5)];
const pod = Object.fromEntries(names.map((name, i) => [name, lengths.map((r) => r[i])]));
const base = { lines: pod, stations: 10, fit_levels: 0 };

let pass = 0, fail = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); pass++; console.log(`ok   ${name}`); }
  catch (error) { fail++; console.log(`FAIL ${name}: ${error instanceof Error ? error.stack : error}`); }
}

function run(params: Record<string, unknown>, nodes: Record<string, NodeSpec> = {}, input?: string, smooth = false) {
  return engine.cook({ nodes: {
    ...nodes, cage: { type: 'lines_plan', in: input, params },
    ...(smooth ? { smooth: { type: 'subdivide', in: ['cage'], params: { levels: 2 } } } : {}),
  }, output: smooth ? 'smooth' : 'cage' });
}

async function cook(params: Record<string, unknown>, nodes?: Record<string, NodeSpec>, input?: string, smooth = false) {
  const result = await run(params, nodes, input, smooth);
  assert.ok(result.ok && result.geo, JSON.stringify(result.errors));
  assert.deepEqual(checkGeo(result.geo), []);
  return { geo: result.geo, result };
}

const point = (g: Geometry, i: number): Vec3 => [g.P[i * 3], g.P[i * 3 + 1], g.P[i * 3 + 2]];
const distance = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const pts = (g: Geometry) => Array.from({ length: g.numPoints }, (_, i) => point(g, i));
function maxValence(g: Geometry) {
  const edges = buildEdges(g), valence = new Uint32Array(g.numPoints);
  edges.a.forEach((a, i) => { valence[a]++; valence[edges.b[i]]++; });
  return valence.reduce((max, n) => Math.max(max, n), 0);
}
const onLine = (g: Geometry, name: string, station: number) => {
  const i = (g.points.get('line')!.data as string[]).findIndex((s, i) => s === name && g.points.get('station')!.get(i) === station);
  assert.ok(i >= 0, `${name} at ${station}`);
  return point(g, i);
};

function assertSymmetry(g: Geometry) {
  const positions = pts(g);
  for (let i = 0; i < positions.length; i++) {
    const [x, y, z] = positions[i];
    const reflected = positions.findIndex((q) => distance(q, [-x, y, z]) <= 1e-9);
    assert.ok(reflected >= 0, `missing mirror of ${positions[i]}`);
    if (Math.abs(x) <= 1e-9) {
      assert.equal(reflected, i);
      assert.ok(!positions.slice(i + 1).some((q) => distance(positions[i], q) <= 1e-9), `duplicate on x = 0 at ${positions[i]}`);
    }
  }
}

function assertArea(g: Geometry) {
  for (let i = 0; i < g.numPrims; i++) assert.ok(Math.hypot(...newellOf(g.primPoints(i).map((j) => point(g, j))).n) > 0, `prim ${i} has zero area`);
}

await check('mirrored capped cage is symmetric, watertight, outward and all quads', async () => {
  for (const fit_levels of [0, 2]) {
    const { geo } = await cook({ ...base, fit_levels });
    assertSymmetry(geo);
    assertArea(geo);
    assert.ok(signedVolume(geo) > 0);
    const edges = buildEdges(geo);
    const counts = new Uint8Array(edges.a.length);
    for (let pr = 0; pr < geo.numPrims; pr++) {
      const q = geo.primPoints(pr);
      assert.equal(q.length, 4);
      q.forEach((a, k) => counts[edges.find(a, q[(k + 1) % q.length])]++);
    }
    assert.ok(counts.every((n) => n === 2));
  }
});

// Independent shape-preserving cubic in Bezier form for an interior span.
function pchip(x: number[], y: number[], i: number, z: number) {
  const slope = (j: number) => (y[j + 1] - y[j]) / (x[j + 1] - x[j]);
  const tangent = (j: number) => {
    const h0 = x[j] - x[j - 1], h1 = x[j + 1] - x[j];
    const a = slope(j - 1), b = slope(j);
    if (Math.sign(a) !== Math.sign(b) || a === 0) return 0;
    const alpha = (1 + h1 / (h0 + h1)) / 3;
    return 1 / (alpha / a + (1 - alpha) / b);
  };
  const h = x[i + 1] - x[i], t = (z - x[i]) / h, u = 1 - t;
  const a = y[i], b = y[i + 1];
  return u ** 3 * a + 3 * u ** 2 * t * (a + h * tangent(i) / 3) + 3 * u * t ** 2 * (b - h * tangent(i + 1) / 3) + t ** 3 * b;
}

await check('uneven lines with 3, 5 and 8 points use PCHIP or straight segments', async () => {
  const z = [0, 0.08, 0.19, 0.53, 0.64, 0.8, 0.95, 1];
  const y = [0.1, 0.16, 0.26, 0.32, 0.48, 0.5, 0.52, 0.55];
  const lines = {
    keel: [[0, -0.15, 0], [0, -0.2, 0.5], [0, -0.25, 1]],
    belt: [0, 0.25, 0.5, 0.75, 1].map((v) => [0.2 + 0.05 * v, 0, v]).reverse(),
    roof: z.map((v, i) => [0, y[i], v]),
  };
  const stations = [0, 0.22, 0.37, 0.5, 1];
  for (const interpolation of ['smooth', 'linear']) {
    const { geo } = await cook({ lines, stations, interpolation, fit_levels: 0, ends: 'open' });
    stations.forEach((v, i) => {
      assert.ok(distance(onLine(geo, 'keel', i), [0, -0.15 - 0.1 * v, v]) < 1e-12);
      assert.ok(distance(onLine(geo, 'belt', i), [0.2 + 0.05 * v, 0, v]) < 1e-12);
      assert.equal(onLine(geo, 'roof', i)[2], v);
      if (i === 0 || i === stations.length - 1) return;
      const expected = interpolation === 'smooth' ? pchip(z, y, 2, v) : y[2] + (y[3] - y[2]) * (v - z[2]) / (z[3] - z[2]);
      assert.ok(Math.abs(onLine(geo, 'roof', i)[1] - expected) < 1e-12);
    });
  }
});

await check('PCHIP stays between the points of a steep rise', async () => {
  const { geo } = await cook({ ...base, stations: 81, lines: { ...pod, roof: [[0, 0.2, -0.5], [0, 0.2, 0], [0, 0.6, 0.1], [0, 0.6, 0.5]] } });
  for (let i = 0; i < 81; i++) {
    const [, y, z] = onLine(geo, 'roof', i);
    if (z >= 0 && z <= 0.1) assert.ok(y >= 0.2 && y <= 0.6);
  }
});

await check('fit reaches the corresponding subdivision vertices with and without creases', async () => {
  for (const creases of [{}, { belt: 2.5 }]) {
    const params = { ...base, stations: lengths.map((r) => r[0][2]), rows_between: 1, creases };
    const { geo: targets } = await cook(params);
    assert.equal(targets.detail.get('fit_error')!.get(0), 0);
    for (let i = 0; i < lengths.length; i++) names.forEach((name, k) => assert.deepEqual(onLine(targets, name, i), lengths[i][k]));
    const { geo: surface, result } = await cook({ ...params, fit_levels: 2 }, undefined, undefined, true);
    const cage = result.results.get('cage')!.geo!;
    const a = subdivideLevel(cage, true, 'smooth', creaseSharpness(cage, '', 10, 'creaseweight')?.sharp ?? null);
    const b = subdivideLevel(a.geo, true, 'smooth', a.sharp);
    let max = 0;
    for (let i = 0; i < targets.numPoints && targets.points.get('station')!.get(i) !== -1; i++) {
      max = Math.max(max, distance(point(targets, i), point(surface, b.vtxPt[a.vtxPt[i]])));
    }
    assert.ok(max < 0.0001, `${max} m`);
    assert.ok(Math.abs(Number(cage.detail.get('fit_error')!.get(0)) - max) < 1e-11);
  }
});

await check('creases are written only on along-line half-edges and can fade', async () => {
  const params = { ...base, ends: 'open', stations: [-0.5, -0.25, 0, 0.25, 0.5], rows_between: 1,
    creases: { belt: 2.5, sill: [[-0.25, 1], [0.25, 3]] } };
  const { geo } = await cook(params);
  const crease = geo.vertices.get('creaseweight')!;
  const station = geo.points.get('station')!;
  const sharp = creaseSharpness(geo, '', 0, 'creaseweight')!.sharp;
  forEachPrimEdge(geo, (_, v, __, a, b) => {
    const s = Math.min(Number(station.get(a)), Number(station.get(b)));
    const expected = geo.edgeGroups.get('line_belt')!.has(a, b) ? 2.5
      : geo.edgeGroups.get('line_sill')!.has(a, b) ? [0, 1, 2, 0][s] : 0;
    assert.equal(crease.get(v), expected);
    assert.equal(sharp.get(edgeKey(a, b)) ?? 0, expected);
  });
});

await check('groups snap to stations and propagate on both halves', async () => {
  const params = { ...base, stations: [-0.5, -0.25, 0, 0.25, 0.5], rows_between: [0, 0, 2, 0],
    groups: { window: { between: ['belt', 'shoulder'], from: -0.2, to: 0.21 } } };
  const { geo } = await cook(params);
  const expected: number[] = [];
  for (let i = 0; i < geo.numPrims; i++) {
    const row = Number(geo.prims.get('row')!.get(i)), st = Number(geo.prims.get('station')!.get(i));
    if (((row >= 2 && row <= 4) || (row >= 7 && row <= 9)) && st >= 1 && st <= 2) expected.push(i);
  }
  assert.equal(expected.length, 12);
  assert.deepEqual([...geo.primGroups.get('window')!].flatMap((member, i) => member ? [i] : []), expected);
  const { geo: smooth } = await cook(params, undefined, undefined, true);
  assert.equal(smooth.primGroups.get('window')!.reduce((a, b) => a + b, 0), expected.length * 16);
});

await check('point ends use one tip, open ends leave loops, and caps require closed sections', async () => {
  const lines = Object.fromEntries(names.map((name, i) => [name, [[0, 0.03, -0.5], lengths[2][i], lengths[4][i]]]));
  const { geo } = await cook({ ...base, lines, ends: 'point' });
  const byStation = (i: number) => pts(geo).filter((_, j) => geo.points.get('station')!.get(j) === i);
  assert.deepEqual(byStation(0), [[0, 0.03, -0.5]]);
  assert.equal(byStation(9).length, 1);
  assert.equal(halfEdges(geo).boundaryLoops().length, 0);
  assert.equal(Array.from({ length: geo.numPrims }, (_, i) => geo.primPoints(i)).filter((p) => p.length === 3).length, 16);
  assertArea(geo);
  const open = await cook({ ...base, ends: 'open' });
  assert.equal(halfEdges(open.geo).boundaryLoops().length, 2);
  const sheet = await cook({ ...base, lines: { keel: pod.keel, belt: pod.belt, shoulder: pod.shoulder }, closed: false, ends: ['point', 'open'] });
  assertArea(sheet.geo);
  assert.match((await run({ ...base, closed: false })).errors[0].message, /ends.*closed/);
});

await check('edge groups contain exactly the longitudinal edges of each line', async () => {
  const { geo } = await cook(base);
  const edges = buildEdges(geo), line = geo.points.get('line')!, station = geo.points.get('station')!, row = geo.points.get('row')!;
  for (const [i, name] of names.entries()) {
    const group = geo.edgeGroups.get(`line_${name}`)!;
    let n = 0;
    for (let e = 0; e < edges.a.length; e++) {
      const a = edges.a[e], b = edges.b[e];
      const expected = line.get(a) === name && line.get(b) === name && row.get(a) === row.get(b) && Number(station.get(b)) - Number(station.get(a)) === 1;
      assert.equal(group.has(a, b), expected);
      n += Number(expected);
    }
    assert.equal(n, i === 0 || i === 4 ? 9 : 18);
  }
});

function curves(lines: Record<string, Vec3[]>, names = Object.keys(lines), closed = false) {
  const nodes: Record<string, NodeSpec> = {};
  names.forEach((name, i) => {
    nodes[`c${i}`] = { type: 'curve', params: { points: lines[name], closed } };
    nodes[`n${i}`] = { type: 'wrangle', in: [`c${i}`], params: { run_over: 'prims', code: `s@name = ${JSON.stringify(name)};` } };
  });
  nodes.src = { type: 'merge', in: names.map((_, i) => `n${i}`) };
  return nodes;
}

await check('invalid input and parameters name the problem', async () => {
  const cases: [Record<string, unknown>, RegExp, Record<string, NodeSpec>?, string?][] = [
    [{ lines: {} }, /lines.*at least/],
    [{ lines: { sill: [[0, 0, 0]] } }, /lines.*sill.*at least 2/],
    [{ fit_levels: 0 }, /lines.*closed/, curves(pod, ['keel'], true), 'src'],
    [{ lines: { 'bad-name': pod.sill } }, /lines.*bad-name.*letter/],
    [{ fit_levels: 0 }, /lines.*keel.*twice/, curves(pod, ['keel', 'keel']), 'src'],
    [{ lines: { sill: [[0, 0, 0], [0, 0, 1.12], [0, 0, 0.5]] } }, /lines.*sill.*turns back.*z = 1.12/],
    [{ ...base, stations: [-0.7, 0] }, /stations.*-0.7.*keel.*-0.5.*0.5/],
    [{ ...base, stations: [0, 0] }, /stations.*ascending/],
    [{ ...base, stations: 1 }, /stations.*at least 2/],
    [{ lines: { sill: [[0, 0, 0], [-0.1, 0, 1]] } }, /mirror.*sill.*point 1/],
    [{ ...base, rows_between: [1] }, /rows_between.*4/],
    [{ ...base, ends: ['cap', 'nose'] }, /ends.*nose/],
    [{ ...base, closed: false }, /ends.*closed/],
    [{ ...base, creases: { missing: 1 } }, /creases.*missing.*keel.*sill/],
    [{ ...base, groups: { window: { between: ['belt', 'missing'] } } }, /groups.*missing.*keel/],
    [{ ...base, creases: { belt: [[0.1, 2], [0, 1]] } }, /creases.*belt.*ascending/],
    [base, /lines.*input 0/, curves(pod), 'src'],
  ];
  for (const [params, message, nodes, input] of cases) {
    const r = await run(params, nodes, input);
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].node, 'cage');
    assert.match(r.errors[0].message, message);
  }
  const { result } = await cook({ ...base, lines: { ...pod, sill: [[0.06, -0.06, -0.6], ...pod.sill] } });
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0].message, /stations.*sill/);
});

await check('named curve input matches JSON and a NURBS uses exact curve samples', async () => {
  const a = await cook(base);
  const b = await cook({ fit_levels: 0, stations: 10 }, curves(pod), 'src');
  assert.deepEqual(fingerprint(b.geo), fingerprint(a.geo));
  const points = [[0, 0.1, -0.5], [0, 0.22, -0.25], [0, 0.2, 0.18], [0, 0.08, 0.5]];
  const nodes = curves(pod, names.slice(0, -1));
  nodes.nurb = { type: 'nurbs', params: { points, order: 4, weights: [1, 1.5, 1.5, 1] } };
  nodes.src.in = [...(nodes.src.in as string[]), 'nurb'];
  const spline = (await engine.cook({ nodes: { nurb: nodes.nurb } })).geo!;
  const sample = evalBasis(splineFromPrim(spline, 0), 0.5).P as Vec3;
  const c = await cook({ fit_levels: 0, stations: [-0.5, sample[2], 0.5] }, nodes, 'src');
  assert.ok(distance(onLine(c.geo, 'line4', 1), sample) < 1e-9);
});

await check('30 stations by 16 rows fit in under one second', async () => {
  const t0 = performance.now();
  const { geo } = await cook({ ...base, stations: 30, rows_between: 1, fit_levels: 2 });
  const ms = performance.now() - t0;
  assert.equal(geo.primGroups.get('sides')!.reduce((a, b) => a + b, 0), 29 * 16);
  assert.ok(Number(geo.detail.get('fit_error')!.get(0)) < 0.0001);
  assert.ok(ms < 1000, `${ms.toFixed(1)} ms`);
  console.log(`     30 × 16 fit took ${ms.toFixed(1)} ms`);
});

await check('nested expressions set line coordinates, group limits and crease keys', async () => {
  const graph: GraphSpec = { nodes: {
    cage: { type: 'lines_plan', params: {
      lines: { bottom: [[0, -0.2, -1], [0, -0.2, 1]], belt: [[0.3, 0, -1], [0.3, 0, 1]], top: [[0, '=h', -1], [0, '=h*0.5', 1]] },
      ends: 'open', fit_levels: 0, stations: [-1, -0.5, 0, 0.5, 1],
      groups: { door: { between: ['belt', 'top'], from: '=-bodyLength/4', to: '=bodyLength/4' } },
      creases: { top: [[-1, '=h*5'], [1, '=h*5']] },
    } },
  } };
  for (const h of [0.2, 0.4]) {
    const result = await engine.cook({ ...graph, vars: { h, bodyLength: 2 } });
    assert.ok(result.ok && result.geo, JSON.stringify(result.errors));
    assert.equal(onLine(result.geo, 'top', 0)[1], h);
    assert.equal(onLine(result.geo, 'top', 4)[1], h * 0.5);
    assert.equal(result.geo.primGroups.get('door')!.reduce((a, b) => a + b, 0), 4);
    assert.deepEqual([...new Set(creaseSharpness(result.geo, '', 0, 'creaseweight')?.sharp.values())], [h * 5]);
  }
});

await check('point attributes evaluate object values and discover node dependencies', async () => {
  const result = await engine.cook({ nodes: {
    sample: { type: 'points', params: { attribs: { '=label': ['=h'], count: ["=npoints('guide')"] } } },
    guide: { type: 'points', params: { positions: [[0, 0, 0], [1, 0, 0]] } },
  }, output: 'sample', vars: { h: 0.25 } });
  assert.ok(result.ok && result.geo, JSON.stringify(result.errors));
  assert.equal(result.geo.points.get('=label')!.get(0), 0.25);
  assert.equal(result.geo.points.get('count')!.get(0), 2);
});

function maxGroupAngle(g: Geometry, name: string) {
  const normals = primNormals(g);
  const he = halfEdges(g);
  const group = g.edgeGroups.get(name)!;
  let max = 0, count = 0;
  for (let e = 0; e < he.numEdges; e++) {
    const h = he.edgeHalf[e], twin = he.heTwin[h];
    if (!group.has(he.edgeA[e], he.edgeB[e]) || twin < 0) continue;
    const u = he.heFace[h] * 3, v = he.heFace[twin] * 3;
    const dot = normals[u] * normals[v] + normals[u + 1] * normals[v + 1] + normals[u + 2] * normals[v + 2];
    max = Math.max(max, Math.acos(Math.min(1, Math.max(-1, dot))) * 180 / Math.PI);
    count++;
  }
  assert.ok(count > 0, name);
  return max;
}

await check('neighbouring line creases leave the cross edges smooth', async () => {
  const stations = [-0.5, -0.25, 0, 0.25, 0.5];
  const params = { ...base, stations, ends: 'open' };
  const angles = async (creases: Record<string, number>) => {
    const cageParams = { ...params, creases };
    const { geo: cage, result } = await cook(cageParams);
    const st = cage.points.get('station')!, line = cage.points.get('line')!;
    const patterns = { cross: [] as string[], sill: [] as string[], belt: [] as string[] };
    const edges = buildEdges(cage);
    edges.a.forEach((a, i) => {
      const b = edges.b[i], s = Number(st.get(a)), t = Number(st.get(b));
      const edge = `p${a}-${b}`;
      if (s === 2 && t === 2 && line.get(a) === 'sill' && line.get(b) === 'belt') patterns.cross.push(edge);
      if (s === 2 && t === 3 && line.get(a) === line.get(b)) {
        if (line.get(a) === 'sill') patterns.sill.push(edge);
        if (line.get(a) === 'belt') patterns.belt.push(edge);
      }
    });
    const nodes: Record<string, NodeSpec> = { cage: { type: 'lines_plan', params: cageParams } };
    let input = 'cage';
    for (const [name, pattern] of Object.entries(patterns)) {
      assert.ok(pattern.length, name);
      nodes[name] = { type: 'group', in: [input], params: { class: 'edge', name, pattern: pattern.join(' ') } };
      input = name;
    }
    nodes.surface = { type: 'subdivide', in: [input], params: { levels: 2 } };
    const refined = await engine.cook({ nodes, output: 'surface' });
    assert.ok(refined.ok && refined.geo, JSON.stringify(refined.errors));
    const g = refined.geo;
    return { cross: maxGroupAngle(g, 'cross'), sill: maxGroupAngle(g, 'sill'), belt: maxGroupAngle(g, 'belt'), warnings: result.warnings.length };
  };
  const smooth = await angles({});
  const creased = await angles({ sill: 3, belt: 3 });
  console.log('     crease angles (degrees)', { smooth, creased });
  assert.ok(creased.sill > smooth.sill + 15 && creased.belt > smooth.belt + 15);
  assert.ok(creased.cross < smooth.cross + 2, `cross edge bent by ${creased.cross} degrees`);
  assert.equal(creased.warnings, 0);
});

const noisyLines = {
  bottom: [[0, -0.14, -0.5], [0, -0.14, 0.5]],
  belt: [[0.24, 0, -0.5], [0.24, 0, 0.5]],
  top: Array.from({ length: 7 }, (_, i) => {
    const z = i / 6 - 0.5;
    const noise = i > 0 && i < 6 ? (i % 2 ? 0.005 : -0.005) : 0;
    return [0, 0.28 - 0.4 * z * z + noise, z];
  }),
};

await check('CV reading smooths a noisy arc and keeps its endpoints', async () => {
  const readings = async (interpolation: string) => {
    const { geo } = await cook({ lines: noisyLines, stations: 129, ends: 'open', fit_levels: 0, interpolation });
    const samples = Array.from({ length: 129 }, (_, i) => onLine(geo, 'top', i));
    assert.deepEqual(samples[0], noisyLines.top[0]);
    assert.deepEqual(samples.at(-1), noisyLines.top.at(-1));
    const signs = samples.slice(1, -1).map((p, i) => Math.sign(samples[i][1] - 2 * p[1] + samples[i + 2][1]));
    return signs.filter((sign, i) => i && sign !== signs[i - 1]).length;
  };
  const smooth = await readings('smooth');
  assert.ok(smooth > 0, 'the noisy interpolated arc must flip curvature');
  const cv = await readings('cv');
  console.log(`     curvature sign flips: ${smooth} smooth, ${cv} cv`);
  assert.equal(cv, 0);
});

await check('round ends fit both tips without the valence of the point fans', async () => {
  const example = getNodeDef('lines_plan')!.example as GraphSpec;
  const params = example.nodes.cage.params!;
  const tips: Vec3[] = [params.lines.keel[0], params.lines.keel.at(-1)];
  for (const ends of ['point', 'round']) {
    const { geo, result } = await cook({ ...params, ends }, undefined, undefined, true);
    const cage = result.results.get('cage')!.geo!;
    const max = maxValence(cage);
    const misses = tips.map((tip) => pts(geo).reduce((min, p) => Math.min(min, distance(p, tip)), Infinity));
    console.log(`     ${ends}: max valence ${max}, tip errors ${misses.map((v) => (v * 1000).toFixed(3)).join(', ')} mm`);
    assert.ok(misses.every((v) => v < 0.00005));
    assert.ok(ends === 'point' ? max > 5 : max <= 5);
    assert.equal(halfEdges(cage).boundaryLoops().length, 0);
    assertSymmetry(cage);
    assert.equal(result.warnings.length, 0);
  }
});

await check('round caps close small and odd mirrored sections', async () => {
  for (const rows of [3, 4, 5, 6, 9, 10, 12]) {
    const lines = Object.fromEntries(Array.from({ length: Math.floor(rows / 2) + 1 }, (_, i) => {
      const a = i * 2 * Math.PI / rows;
      const x = i === 0 || 2 * i === rows ? 0 : 0.24 * Math.sin(a);
      const y = 0.18 * Math.cos(a);
      return [`line${i}`, [[0, -0.01, -0.5], [x, y, 0], [0, 0.015, 0.5]]];
    }));
    const { geo, result } = await cook({ lines, stations: 3, ends: 'round' }, undefined, undefined, true);
    const cage = result.results.get('cage')!.geo!;
    const he = halfEdges(cage);
    assert.equal(he.boundaryLoops().length, 0, `${rows} rows`);
    assert.ok(he.isManifold && maxValence(cage) <= 5, `${rows} rows`);
    assertSymmetry(cage);
    assert.equal(result.warnings.length, 0, `${rows} rows`);
    for (const tip of [lines.line0[0], lines.line0[2]] as Vec3[]) {
      const miss = pts(geo).reduce((min, p) => Math.min(min, distance(p, tip)), Infinity);
      assert.ok(miss < 0.00005, `${rows} rows: ${miss} m`);
    }
  }
});

const capStations = [-0.5, -0.445, 0, 0.445, 0.5];
function flatCapLines(rows: number) {
  return Object.fromEntries(Array.from({ length: rows / 2 + 1 }, (_, i) => {
    const a = i * 2 * Math.PI / rows;
    return [`line${i}`, capStations.map((z, j) => {
      const radius = [0.64, 0.73, 1.0, 0.85, 0.79][j];
      return [i === 0 || i === rows / 2 ? 0 : radius * 0.25 * Math.sin(a), radius * 0.21 * Math.cos(a), z];
    })];
  }));
}

await check('eight- and twelve-row subdivided caps keep the rim and cap planar', async () => {
  const deviations: number[] = [];
  for (const rows of [8, 12]) {
    const lines = flatCapLines(rows);
    const { geo, result } = await cook({ lines, stations: capStations, ends: 'cap', fit_levels: 2 }, undefined, undefined, true);
    const positions = pts(geo), cage = result.results.get('cage')!.geo!;
    const flags = geo.primGroups.get('caps')!;
    let max = 0;
    flags.forEach((cap, pr) => {
      if (cap) for (const id of geo.primPoints(pr)) max = Math.max(max, Math.abs(Math.abs(positions[id][2]) - 0.5));
    });
    deviations.push(max);
    const targets = Object.values(lines).flatMap((line) => [line[0], line.at(-1)!]) as Vec3[];
    const miss = Math.max(...targets.map((p) => positions.reduce((d, q) => Math.min(d, distance(p, q)), Infinity)));
    console.log(`     ${rows} rows: cap deviation ${(max * 1000).toFixed(3)} mm, rim fit ${(miss * 1000).toFixed(3)} mm`);
    assert.ok(miss < 0.00005);
    assert.equal(result.warnings.length, 0);
    assertSymmetry(cage);
  }
  assert.ok(deviations.every((v) => v <= 0.0005), `cap deviations: ${deviations} m`);
});

await check('a repeated mirror boundary name selects only its centre-crossing strip', async () => {
  const lines = { front: pod.sill, side: pod.belt, back: pod.shoulder };
  const params = { ...base, lines, ends: 'open', stations: [-0.5, -0.25, 0, 0.25, 0.5],
    groups: { panel: { between: ['front', 'front'], from: -0.25, to: 0.25 } } };
  const { geo } = await cook(params);
  const expected = Array.from({ length: geo.numPrims }, (_, i) => {
    const station = Number(geo.prims.get('station')!.get(i));
    const corners = geo.primPoints(i);
    return Number(station >= 1 && station < 3
      && corners.every((p) => geo.points.get('line')!.get(p) === 'front')
      && corners.some((p) => geo.P[3 * p] < 0) && corners.some((p) => geo.P[3 * p] > 0));
  });
  assert.equal(expected.reduce((a, b) => a + b, 0), 2);
  assert.deepEqual([...geo.primGroups.get('panel')!], expected);
  assert.match((await run({ ...params, mirror: 'none' })).errors[0].message, /two different lines.*mirror/);
  assert.match((await run({ ...params, groups: { panel: { between: ['side', 'side'] } } })).errors[0].message, /first or last/);
});

await check('an extruded face beside a creased line adds no crease across the body or down its walls', async () => {
  const params = { ...base, ends: 'open', creases: { belt: 3 }, groups: { intake: { between: ['belt', 'shoulder'], from: -0.1, to: 0.15 } } };
  const extrude = { inset: { type: 'poly_extrude', in: ['cage'], params: { group: 'intake', distance: -0.02, inset: 0.01 } } };
  const result = await engine.cook({ nodes: { cage: { type: 'lines_plan', params }, ...extrude }, output: 'inset' });
  assert.ok(result.ok && result.geo, JSON.stringify(result.errors));
  const geo = result.geo, sharp = creaseSharpness(geo, '', 0, 'creaseweight')!.sharp;
  const seen = new Set<number>();
  let along = 0;
  forEachPrimEdge(geo, (_pr, _v0, _v1, a, b) => {
    const key = edgeKey(a, b);
    if (seen.has(key) || !sharp.get(key)) return;
    seen.add(key);
    const d = distance(point(geo, a), point(geo, b));
    assert.ok(Math.abs(geo.P[3 * b + 2] - geo.P[3 * a + 2]) > 0.5 * d, `edge ${a}-${b} is creased but does not run along the body`);
    along++;
  });
  assert.ok(along > 0);
});

console.log(`lines: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
