import assert from 'node:assert/strict';
import { GeoBuilder, Geometry } from '../src/core/geometry.ts';
import { geoContentHash } from '../src/core/geohash.ts';
import { cross, dot, sub } from '../src/core/math.ts';
import type { Vec3 } from '../src/core/math.ts';
import { appendSurfaceMesh, closestSurfacePoint, evalSurface, sampleTrimSegment, surfaceFromPrim, surfacePoint, surfaceTrims } from '../src/core/nurbssurface.ts';
import type { GraphSpec } from '../src/graph/types.ts';
import { createFixtureEngine } from './fixtures.ts';

const { engine } = await createFixtureEngine();
const size = 0.05, tolerance = 0.001;
const bands = [{ width: 0.01, depth: -0.006, group: 'seal' }, { width: 0.02, group: 'frame' }];
let pass = 0, fail = 0;
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); pass++; console.log(`PASS ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}: ${e}`); }
}
function run(type: string, sources: Geometry[], params: Record<string, unknown> = {}) {
  const nodes: GraphSpec['nodes'] = Object.fromEntries(sources.map((_, index) => [`in${index}`, { type: 'input', params: { index } }]));
  nodes.result = { type, in: Object.keys(nodes), params };
  return engine.cook({ nodes, output: 'result' }, { inputs: sources.map((geo) => ({ geo, sig: geoContentHash(geo) })) });
}
function profile(points: [number, number][]) {
  return new Geometry({ positions: points.flatMap(([y, z]) => [0, y, z]), prims: [points.map((_, i) => i)], closed: true });
}
function rect(y0: number, y1: number, z0: number, z1: number) {
  return profile([[y0, z0], [y1, z0], [y1, z1], [y0, z1]]);
}
async function loft(length = 4, wide = false) {
  const scales = [1, 1.1, 1.05, 0.95, 0.9];
  const r = await engine.cook({
    nodes: {
      ring: { type: 'circle', params: { plane: 'xy', segments: 16 } },
      ...(wide ? { ellipse: { type: 'transform', in: ['ring'], params: { scale: [0.73, 0.515, 1] } } } : {}),
      body: { type: 'loft', in: [wide ? 'ellipse' : 'ring'], params: { output: 'surface', parameterization: 'uniform',
        sections: scales.map((scale, i) => ({ scale, offset: [0, 0, i * length / 4] })) } },
    },
    output: 'body',
  });
  assert.ok(r.ok && r.geo, JSON.stringify(r.errors));
  return r.geo;
}
const body = await loft(), exact = surfaceFromPrim(body, 0)!;
const window = rect(0.2, 0.6, 0.65, 1.45);
async function trim(outlines: Geometry[] = [window], source = body, hits = 'all') {
  const r = await run('trim_surface', [source, Geometry.merge(outlines)], { direction: [1, 0, 0], hits, edges: false });
  assert.ok(r.ok && r.geo, JSON.stringify(r.errors));
  return r.geo;
}
async function mesh(g: Geometry, params = {}) {
  const r = await run('surface_to_mesh', [g], { size, tolerance, ...params });
  assert.ok(r.ok && r.geo, JSON.stringify(r.errors));
  return { g: r.geo, stats: r.results.get('result')!.stats! };
}
const point = (g: Geometry, i: number): Vec3 => [g.P[i * 3], g.P[i * 3 + 1], g.P[i * 3 + 2]];
const dist = (a: Vec3, b: Vec3) => Math.hypot(...sub(a, b));
const quality = (stats: Record<string, number>) => `minimum ${stats.min_angle.toFixed(3)} degrees, ${stats.thin_faces} thin faces`;
function segmentDistance(q: Vec3, a: Vec3, b: Vec3) {
  const d = sub(b, a), p = sub(q, a);
  const t = Math.max(0, Math.min(1, dot(p, d) / (dot(d, d) || 1)));
  return Math.hypot(...p.map((x, i) => x - t * d[i]));
}
function faceAngle(g: Geometry, ids: number[]) {
  const points = ids.map((p) => point(g, p));
  const normal = points.slice(2).reduce((n, p, i) => {
    const a = cross(sub(points[i + 1], points[0]), sub(p, points[0]));
    return n.map((x, k) => x + a[k]) as Vec3;
  }, [0, 0, 0] as Vec3);
  return Math.min(...points.map((p, i) => {
    const a = sub(points[(i + points.length - 1) % points.length], p), b = sub(points[(i + 1) % points.length], p), c = cross(b, a);
    const angle = Math.atan2(Math.hypot(...c), dot(a, b)) * 180 / Math.PI;
    return dot(c, normal) < 0 ? 360 - angle : angle;
  }));
}
function checkTransition(g: Geometry, ring: number[], stats: Record<string, number>, corners: number[] = []) {
  const outer = new Set(ring), band = g.prims.get('band')!, grid = new Set<number>();
  const links = new Map(corners.map((p) => [p, new Set<number>()]));
  const thin: { angle: number; ids: number[] }[] = [];
  let count = 0;
  for (let f = 0; f < g.numPrims; f++) {
    const ids = g.primPoints(f);
    if (Number(band.get(f)) >= 0 || !ids.some((p) => outer.has(p))) continue;
    count++;
    for (let i = 0; i < ids.length; i++) {
      if (!outer.has(ids[i])) grid.add(ids[i]);
      const adjacent = [ids[(i + 1) % ids.length], ids[(i + ids.length - 1) % ids.length]];
      const linked = links.get(ids[i]);
      if (linked) for (const p of adjacent) if (!outer.has(p)) linked.add(p);
    }
    const angle = faceAngle(g, ids);
    if (angle < 15) thin.push({ angle, ids });
  }
  assert.ok(count);
  assert.equal(stats.thin_faces, thin.length);
  console.log(`  ${thin.length} thin faces / ${count} transition faces`);
  for (const { angle, ids } of thin.sort((a, b) => a.angle - b.angle).slice(0, 5)) {
    console.log(`  ${angle.toFixed(3)} degrees at ${ids.map((p) => point(g, p).map((x) => x.toFixed(6)).join(', ')).join(' / ')}`);
  }
  assert.equal(thin.length, 0);
  for (const [p, linked] of links) {
    const q = point(g, p);
    const nearest = Math.min(...[...grid].map((i) => dist(q, point(g, i))));
    assert.ok([...linked].some((i) => dist(q, point(g, i)) <= nearest + 1e-9), 'corner links to the nearest grid vertex');
  }
}
function nearestCut(g: Geometry, loop: number[], y: number, z: number) {
  const candidates = loop.map((p) => {
    const { P } = closestSurfacePoint(exact, point(g, p));
    return { p, d: Math.hypot(P[1] - y, P[2] - z) };
  }).sort((a, b) => a.d - b.d);
  assert.ok(candidates[0].d < tolerance);
  return candidates[0].p;
}
function bandFacesAt(g: Geometry, group: string, p: number) {
  const mask = g.primGroups.get(group)!;
  return Array.from(mask).flatMap((yes, f) => {
    const ids = yes ? g.primPoints(f) : [];
    return ids.includes(p) ? [ids] : [];
  });
}
function mitreEnd(g: Geometry, group: string, start: number, outer: Set<number>) {
  const [a, b, ...more] = bandFacesAt(g, group, start);
  assert.ok(a && b && !more.length, `two ${group} faces meet at the corner`);
  const shared = a.filter((p) => p !== start && b.includes(p));
  assert.equal(shared.length, 1);
  assert.ok(outer.has(shared[0]));
  for (const ids of [a, b]) {
    const k = ids.indexOf(start);
    assert.ok(ids[(k + 1) % ids.length] === shared[0] || ids[(k + ids.length - 1) % ids.length] === shared[0]);
  }
  return shared[0];
}
function boundary(g: Geometry, group?: string) {
  const use = new Map<number, [number, number, number]>();
  const mask = group ? g.primGroups.get(group) : null;
  if (group) assert.ok(mask?.includes(1), group);
  for (let p = 0; p < g.numPrims; p++) {
    if (mask && !mask[p]) continue;
    const pts = g.primPoints(p);
    assert.equal(new Set(pts).size, pts.length);
    for (let k = 0; k < pts.length; k++) {
      const a = pts[k], b = pts[(k + 1) % pts.length], key = Math.min(a, b) * g.numPoints + Math.max(a, b);
      const edge = use.get(key);
      if (edge) { assert.equal(edge[2], 1); assert.equal(edge[0], b, 'opposite edge winding'); edge[2]++; }
      else use.set(key, [a, b, 1]);
    }
  }
  const next = new Map<number, number>();
  const incoming = new Set<number>();
  for (const [a, b, n] of use.values()) if (n === 1) {
    assert.ok(!next.has(a) && !incoming.has(b), `branched boundary at ${a}, ${b}`);
    next.set(a, b); incoming.add(b);
  }
  const loops: number[][] = [];
  while (next.size) {
    const start = next.keys().next().value!;
    const loop: number[] = [];
    let i = start;
    do {
      loop.push(i);
      const j = next.get(i);
      assert.notEqual(j, undefined, 'open boundary');
      next.delete(i);
      i = j!;
    } while (i !== start);
    loops.push(loop);
  }
  return loops;
}
function holes(g: Geometry, count: number) {
  const loops = boundary(g);
  const cuts = loops.filter((loop) => loop.some((p) => g.P[p * 3 + 2] > 1e-6 && g.P[p * 3 + 2] < 4 - 1e-6));
  assert.equal(loops.length, count + 2);
  assert.equal(cuts.length, count);
  return cuts;
}
function trimChords(g: Geometry) {
  return surfaceTrims(g, 0)!.filter((loop) => loop.every(([, v]) => v > 0 && v < 1)).flatMap((loop) =>
    loop.flatMap((a, k) => {
      const b = loop[(k + 1) % loop.length], samples = [a, ...sampleTrimSegment(exact, a, b, 1e-6), b].map((uv) => surfacePoint(exact, uv));
      return samples.slice(1).map((q, i) => [samples[i], q] as const);
    }));
}
const cut = await trim();

await check('Untrimmed grid, edge size, chord error and metre UVs', async () => {
  const { g, stats } = await mesh(body);
  assert.equal(stats.triangles, 0);
  assert.equal(stats.quads, g.numPrims);
  assert.ok(Number(stats.max_chord_error) <= tolerance);
  const uv = g.vertices.get('uv')!;
  assert.ok(g.points.has('N'));
  let circumference = 0;
  for (let i = 0; i < 1024; i++) circumference += dist(surfacePoint(exact, [i / 1024, 0.5]), surfacePoint(exact, [(i + 1) / 1024, 0.5]));
  const meters = Array.from({ length: g.numVertices }, (_, v) => uv.get(v) as number[]);
  const uSpan = meters.reduce((max, p) => Math.max(max, p[0]), 0);
  const vSpan = meters.reduce((max, p) => Math.max(max, p[1]), 0);
  assert.ok(Math.abs(uSpan / circumference - 1) < 0.01);
  const middle = [uSpan / 2, vSpan / 2].map((m, axis) =>
    meters.reduce((nearest, p) => Math.min(nearest, Math.abs(p[axis] - m)), Infinity));
  const ranges = [[Infinity, 0], [Infinity, 0]];
  for (let p = 0; p < g.numPrims; p++) {
    const a = g.primStart[p], b = g.primStart[p + 1];
    for (let i = a; i < b; i++) {
      const j = i + 1 === b ? a : i + 1;
      const axis = meters[i][0] === meters[j][0] ? 1 : 0;
      const across = 1 - axis;
      if (Math.abs(meters[i][across] - (across ? vSpan : uSpan) / 2) > middle[across] + 1e-9) continue;
      const length = dist(point(g, g.vertexPoint[i]), point(g, g.vertexPoint[j]));
      ranges[axis][0] = Math.min(ranges[axis][0], length);
      ranges[axis][1] = Math.max(ranges[axis][1], length);
    }
  }
  for (const [min, max] of ranges) assert.ok(min >= size * 0.7 && max <= size * 1.3 && min <= max, `${min} to ${max} m`);
  console.log(`  ${stats.quads} quads, u/v edges ${ranges.map((r) => r.map((x) => x.toFixed(5)).join(' to ')).join(' / ')} m, UV span ${uSpan.toFixed(5)} m vs ${circumference.toFixed(5)} m, chord error ${stats.max_chord_error} m`);
});

await check('Rectangular openings without bands', async () => {
  const { g, stats } = await mesh(cut);
  const chords = trimChords(cut);
  let deviation = 0;
  const cuts = holes(g, 2);
  for (const loop of cuts) for (let i = 0; i < loop.length; i++) {
    const a = point(g, loop[i]), b = point(g, loop[(i + 1) % loop.length]);
    for (const q of [a, a.map((x, k) => (x + b[k]) / 2) as Vec3]) {
      deviation = Math.max(deviation, Math.min(...chords.map(([x, y]) => segmentDistance(q, x, y))));
    }
  }
  assert.ok(deviation <= tolerance, `${deviation} m to trim`);
  const builder = new GeoBuilder(cut);
  appendSurfaceMesh(builder, cut, 0, surfaceFromPrim(cut, 0)!, { tolerance });
  const plain = builder.build();
  const triangles = Array.from({ length: plain.numPrims }, (_, p) => Number(plain.primSize(p) === 3)).reduce((a, b) => a + b, 0);
  console.log(`  ${stats.triangles} triangles vs ${triangles} plain, quad share ${stats.quad_share}, trim deviation ${deviation} m, ${quality(stats)}`);
  assert.ok(Number(stats.quad_share) >= 0.95 && Number(stats.triangles) < triangles);
  checkTransition(g, cuts.flat(), stats, cuts.flatMap((loop) =>
    [0.2, 0.6].flatMap((y) => [0.65, 1.45].map((z) => nearestCut(g, loop, y, z)))));
});

await check('Seal and frame width, depth and connectivity', async () => {
  const { g, stats } = await mesh(cut, { bands });
  const cuts = holes(g, 2), chords = trimChords(cut);
  const seal = new Set(boundary(g, 'seal').flat());
  const frame = boundary(g, 'frame').flat().filter((p) => !seal.has(p));
  const frameOuter = new Set(frame), sealOuter = new Set([...seal].filter((p) => !cuts.some((loop) => loop.includes(p))));
  for (const p of cuts.flat()) assert.ok(seal.has(p));
  const mitres = new Map<number, [Vec3, Vec3, Vec3]>();
  for (const loop of cuts) for (const y of [0.2, 0.6]) for (const z of [0.65, 1.45]) {
    const p = nearestCut(g, loop, y, z), k = loop.indexOf(p);
    const mid = mitreEnd(g, 'seal', p, sealOuter);
    const outer = mitreEnd(g, 'frame', mid, frameOuter);
    const onSurface = (i: number) => closestSurfacePoint(exact, point(g, i)).P;
    mitres.set(outer, [onSurface(loop[(k + loop.length - 1) % loop.length]), onSurface(p), onSurface(loop[(k + 1) % loop.length])]);
  }
  assert.equal(mitres.size, 8);
  const band = g.prims.get('band')!;
  let bandAngle = 180;
  for (let f = 0; f < g.numPrims; f++) if (Number(band.get(f)) >= 0) bandAngle = Math.min(bandAngle, faceAngle(g, g.primPoints(f)));
  assert.ok(bandAngle >= 30, `${bandAngle} degree band angle`);
  let surfaceError = 0, widthError = 0, depthError = 0;
  for (const p of frame) {
    const q = point(g, p);
    surfaceError = Math.max(surfaceError, Math.sqrt(closestSurfacePoint(exact, q).d2));
    const mitre = mitres.get(p);
    if (mitre) {
      // The ends of the trim edges are behind the mitre. Measure to each extended edge.
      const [a, b, c] = mitre;
      for (const d of [sub(a, b), sub(c, b)]) {
        const width = Math.hypot(...cross(sub(q, b), d)) / Math.hypot(...d);
        widthError = Math.max(widthError, Math.abs(width - 0.03));
      }
    } else widthError = Math.max(widthError, Math.abs(Math.min(...chords.map(([x, y]) => segmentDistance(q, x, y))) - 0.03));
  }
  for (const p of cuts.flat()) {
    const q = point(g, p), c = closestSurfacePoint(exact, q), e = evalSurface(exact, c.u, c.v);
    depthError = Math.max(depthError, Math.abs(dot(sub(q, c.P), e.N) + 0.006));
  }
  console.log(`  outer ring error ${surfaceError} m, width error ${widthError} m, depth error ${depthError} m, quad share ${stats.quad_share}, ${quality(stats)}`);
  console.log(`  ${mitres.size} corners with one shared diagonal per row, minimum band angle ${bandAngle.toFixed(3)} degrees`);
  assert.ok(surfaceError <= 1e-6 && widthError <= 0.03 * 0.02 && depthError <= 0.006 * 0.02);
  assert.ok(Number(stats.quad_share) >= 0.95);
  checkTransition(g, frame, stats, [...mitres.keys()]);
});

await check('Oval and rounded rectangle have all-quad bands', async () => {
  const oval = profile(Array.from({ length: 72 }, (_, i) => {
    const a = i * Math.PI / 36;
    return [0.45 + 0.22 * Math.cos(a), 1.25 + 0.4 * Math.sin(a)];
  }));
  const rounded = profile(Array.from({ length: 4 }, (_, i) => {
    const y = [0.52, 0.3, 0.3, 0.52][i], z = [1.55, 1.55, 0.95, 0.95][i];
    return Array.from({ length: 13 }, (_, k): [number, number] => {
      const a = (i + k / 12) * Math.PI / 2;
      return [y + 0.08 * Math.cos(a), z + 0.08 * Math.sin(a)];
    });
  }).flat());
  for (const [name, shape] of [['oval', oval], ['rounded rectangle', rounded]] as const) {
    const { g, stats } = await mesh(await trim([shape], body, 'front'), { bands });
    holes(g, 1);
    const band = g.prims.get('band')!;
    let inBands = 0;
    for (let i = 0; i < g.numPrims; i++) if (g.primSize(i) === 3 && Number(band.get(i)) >= 0) inBands++;
    console.log(`  ${name}, ${inBands} band triangles, ${stats.triangles} total, ${quality(stats)}`);
    assert.equal(inBands, 0);
    const seal = new Set(boundary(g, 'seal').flat());
    checkTransition(g, boundary(g, 'frame').flat().filter((p) => !seal.has(p)), stats);
  }
});

await check('Triangle opening and sharp notch close around the bands', async () => {
  const triangle = profile([[0.24, 0.65], [0.24, 1.32], [0.78, 0.985]]);
  const t = await mesh(await trim([triangle], body, 'front'), { bands });
  holes(t.g, 1);
  console.log(`  triangle opening, ${t.stats.triangles} triangles, ${quality(t.stats)}`);
  const notch = profile([[0.18, 0.65], [0.45, 0.65], [0.45, 1.03], [0.78, 1.12], [0.45, 1.21], [0.45, 1.57], [0.18, 1.57]]);
  const { g, stats } = await mesh(await trim([notch], body, 'front'), { bands });
  const [loop] = holes(g, 1), tip = nearestCut(g, loop, 0.78, 1.12);
  const faces = bandFacesAt(g, 'seal', tip), triangles = faces.filter((ids) => ids.length === 3);
  assert.equal(triangles.length, 4, 'sharp fan shares one cut apex');
  assert.equal(faces.length, 6);
  for (const ids of triangles) assert.ok(faceAngle(g, ids) >= 15);
  const k = loop.indexOf(tip), toSurface = (i: number) => closestSurfacePoint(exact, point(g, i)).P;
  const p = toSurface(tip), a = sub(toSurface(loop[(k + loop.length - 1) % loop.length]), p), b = sub(toSurface(loop[(k + 1) % loop.length]), p);
  const turn = 180 - Math.atan2(Math.hypot(...cross(a, b)), dot(a, b)) * 180 / Math.PI;
  assert.ok(turn > 140 && turn < 165);
  console.log(`  notch tip turns ${turn.toFixed(2)} degrees, ${faces.length} first-row faces with ${triangles.length} fan triangles sharing one apex, ${stats.triangles} total triangles`);
});

await check('Opening across the periodic seam', async () => {
  const { g, stats } = await mesh(await trim([rect(-0.23, 0.22, 0.65, 1.45)], body, 'front'), { bands });
  assert.ok(holes(g, 1)[0].some((p) => g.P[p * 3 + 1] < 0));
  console.log(`  three boundary loops, ${stats.triangles} triangles`);
});

await check('Overlapping bands name both loops and the gap', async () => {
  const close = await trim([rect(0.2, 0.6, 0.65, 1.45), rect(0.2, 0.6, 1.46, 2.25)], body, 'front');
  const r = await run('surface_to_mesh', [close], { bands: [{ width: 0.02 }] });
  const message = r.errors.map((e) => e.message).join('\n');
  console.log(`  ${message}`);
  assert.ok(!r.ok);
  assert.match(message, /loops?\s+\d+\s+and\s+\d+.*gap.*\bm\b/i);
  assert.match(message, /narrower.*further apart/i);
});

await check('Polygon box passes through', async () => {
  const boxResult = await engine.cook({ nodes: { box: { type: 'box' } }, output: 'box' });
  assert.ok(boxResult.geo);
  const box = boxResult.geo.clone();
  box.prims.add('tag', 'string', 1).set(0, 'original');
  box.primGroups.set('surface', new Uint8Array(box.numPrims).fill(1));
  const { g } = await mesh(Geometry.merge([box, body]));
  assert.equal(g.prims.get('tag')!.get(0), 'original');
  assert.deepEqual(g.P.slice(0, box.P.length), box.P);
  for (let p = 0; p < box.numPrims; p++) {
    assert.deepEqual(g.primPoints(p), box.primPoints(p));
    assert.equal(g.primClosed[p], box.primClosed[p]);
    assert.equal(g.primGroups.get('surface')![p], 1);
  }
});

await check('Six openings at 0.02 m', async () => {
  const source = await loft(4.5, true);
  const trimmed = await trim([rect(0.09, 0.3, 0.5, 1.15), rect(0.1, 0.29, 1.7, 2.55), rect(0.08, 0.25, 3.08, 3.87)], source);
  const start = performance.now();
  const { g, stats } = await mesh(trimmed, { size: 0.02, bands });
  const elapsed = performance.now() - start;
  const equivalent = 2 * Number(stats.quads) + Number(stats.triangles);
  const bounds = source.bbox();
  console.log(`  ${elapsed.toFixed(1)} ms, ${g.numPrims} faces, ${equivalent} triangle equivalents, quad share ${stats.quad_share}, bounds ${JSON.stringify(bounds)}, ${quality(stats)}`);
  assert.ok(elapsed < 3000 && equivalent <= 150000 && Number(stats.quad_share) >= 0.95);
  assert.equal(boundary(g).length, 8);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = Number(fail > 0);
