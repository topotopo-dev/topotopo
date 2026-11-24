import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { Geometry } from '../src/core/geometry.ts';
import { Image } from '../src/core/image.ts';
import { evalDerivs, evalPoint, spanBreaks, splineFromPrim, toPolyline } from '../src/core/splines.ts';
import { Engine } from '../src/graph/engine.ts';
import { defineNode } from '../src/graph/registry.ts';
import { createNodeHost } from '../src/host/node.ts';
import { encodeGreyPNG } from '../src/io/heightmap.ts';
import '../src/nodes/index.ts';

type Box = [number, number, number, number];
type Sheet = { w: number; h: number; pixels: Float32Array };
type Point = [number, number];
type Field = (x: number, y: number) => number;

const side: Box = [18, 15, 640, 240];
const top: Box = [18, 255, 640, 420];
const front: Box = [670, 15, 835, 240];
const rear: Box = [850, 15, 1015, 240];
const seed = [328, 200];
const erase = [[99, 155, 101, 220], [555, 155, 557, 220], [99, 219, 557, 221]];
const body: Field = (x, y) => 60 * (Math.hypot(Math.max(0, Math.abs(x - 328) - 220) / 80, (y - 95) / 60) - 1);
const discs: Field[] = [185, 475].map((cx) => (x, y) => Math.hypot(x - cx, y - 149) - 34);
const profile: Field = (x, y) => Math.min(body(x, y), ...discs.map((d) => d(x, y)));
const rounded = (cx: number, cy: number, w: number, h: number, r: number): Field => (x, y) => {
  const dx = Math.abs(x - cx) - w / 2 + r, dy = Math.abs(y - cy) - h / 2 + r;
  return Math.hypot(Math.max(0, dx), Math.max(0, dy)) + Math.min(Math.max(dx, dy), 0) - r;
};

function paper(w: number, h: number): Sheet {
  return { w, h, pixels: new Float32Array(w * h).fill(1) };
}

function draw(sheet: Sheet, box: Box, ink: (x: number, y: number) => boolean) {
  const [x0, y0, x1, y1] = box;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    if (ink(x + 0.5, y + 0.5)) sheet.pixels[y * sheet.w + x] = 0;
  }
}

function drawing({ dimension = true, gaps = false, scribble = false, shorten = 0, large = false, defects = false } = {}): Sheet {
  const sheet = large ? paper(2000, 1400) : paper(1030, 440);
  const line = (d: number) => d <= 0 && d >= -2;
  draw(sheet, side, (x, y) => line(body(x, y)) || discs.some((d, i) => line(d(x, y)) && !(gaps && y > 180 && Math.abs(x - [185, 475][i]) < 9)));
  if (defects) {
    for (let y = 35; y < 37; y++) sheet.pixels.fill(1, y * sheet.w + 300, y * sheet.w + 302);
    draw(sheet, [330, 153, 331, side[3]], () => true);
  }
  if (dimension) for (const box of [[99, 153, 101, 220], [555, 153, 557, 220], [99, 219, 557, 221]] as Box[]) draw(sheet, box, () => true);
  const plan = rounded(328, 335, 600 - shorten, 128, 36);
  draw(sheet, top, (x, y) => line(plan(x, y)));
  if (scribble) draw(sheet, [100, 352, 610, 418], (x, y) => y > 390 || (Math.floor((x + y) / 7) % 2 === 0));
  draw(sheet, front, (x, y) => line(rounded(752, 109, 128, 148, 35)(x, y)));
  draw(sheet, rear, (x, y) => line(rounded(932, 109, 128, 148, 42)(x, y)));
  return sheet;
}

const engine = new Engine(createNodeHost({ workers: 0 }));
let input: Geometry;
let id = 0;
defineNode({
  type: '__blueprint_test_sheet', category: 'test', summary: 'Supply a drawing sheet.',
  inputs: [], params: { id: { type: 'int', default: 0, desc: 'distinguish sheets' } },
  cook: () => input,
});
const views = { side: { box: side, seeds: [seed] }, top: { box: top, front: 'left' }, front: { box: front }, rear: { box: rear } };

async function run(sheet: Sheet, params: Record<string, unknown>) {
  input = new Geometry();
  input.volumes.push(new Image(sheet.w, sheet.h, 'sheet').set('C', sheet.pixels));
  return engine.cook({ nodes: {
    sheet: { type: '__blueprint_test_sheet', params: { id: ++id } },
    out: { type: 'blueprint', in: ['sheet'], params },
  }, output: 'out' });
}

async function cook(sheet: Sheet, params: Record<string, unknown>) {
  const result = await run(sheet, params);
  assert.ok(result.ok && result.geo, JSON.stringify(result.errors));
  return { geo: result.geo, stats: result.results.get('out')!.stats!, messages: result.results.get('out')!.warnings };
}

function outline(g: Geometry, name: string) {
  for (let p = 0; p < g.numPrims; p++) {
    if (g.prims.get('name')!.get(p) !== name) continue;
    assert.ok(g.primClosed[p]);
    const s = splineFromPrim(g, p);
    assert.equal(s.type, 'nurbs');
    assert.equal(s.order, 4);
    return s;
  }
  throw new Error('Missing outline ' + name);
}

function shape(g: Geometry, name: string, fn: (p: number[]) => Point): Point[] {
  const { P } = toPolyline(outline(g, name), { tolerance: 0.000025 });
  return Array.from({ length: P.length / 3 }, (_, i) => fn(Array.from(P.subarray(i * 3, i * 3 + 3))));
}

function contains(points: Point[], x: number, y: number) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [ax, ay] = points[i], [bx, by] = points[j];
    if ((ay > y) !== (by > y) && x < ax + (bx - ax) * (y - ay) / (by - ay)) inside = !inside;
  }
  return inside;
}

const length = 6;
const scale = length / 600;
const sidePixels = (g: Geometry) => shape(g, 'side', ([, y, z]) => [328 - z / scale, side[3] - y / scale]);
const detail = (g: Geometry, name: string) => Number(g.detail.get(name)!.get(0));
const near = (a: number, b: number, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} differs from ${b} by more than ${tol}`);

function distanceToOutline([x, y]: Point, points: Point[]) {
  let best = Infinity;
  for (let i = 0; i < points.length; i++) {
    const [ax, ay] = points[i], [bx, by] = points[(i + 1) % points.length];
    const dx = bx - ax, dy = by - ay, sq = dx * dx + dy * dy;
    const t = sq ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / sq)) : 0;
    best = Math.min(best, (x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2);
  }
  return Math.sqrt(best);
}

function trueSide(): Point[] {
  const points: Point[] = [];
  for (let x = 108; x <= 548; x += 0.5) points.push([x, 35], [x, 155]);
  for (let i = 0; i < 720; i++) {
    const t = i * Math.PI / 360, x = Math.cos(t), y = Math.sin(t);
    points.push([328 + Math.sign(x) * 220 + x * 80, 95 + y * 60], [185 + x * 34, 149 + y * 34], [475 + x * 34, 149 + y * 34]);
  }
  return points.filter(([x, y]) => profile(x, y) >= -1e-9);
}

function longitudinalBounds(curve: ReturnType<typeof outline>) {
  let min = Infinity, max = -Infinity;
  const visit = (u: number) => {
    const z = evalPoint(curve, u)[2];
    min = Math.min(min, z); max = Math.max(max, z);
  };
  const derivative = (u: number) => evalDerivs(curve, u).d1[2];
  const breaks = spanBreaks(curve);
  visit(0);
  for (let i = 1; i < breaks.length; i++) {
    const a = breaks[i - 1], b = breaks[i];
    visit(b);
    for (let j = 0; j < 16; j++) {
      let lo = a + (b - a) * j / 16, hi = a + (b - a) * (j + 1) / 16;
      const sign = Math.sign(derivative(lo));
      if (!sign) visit(lo);
      if (sign === Math.sign(derivative(hi))) continue;
      for (let k = 0; k < 40; k++) {
        const mid = (lo + hi) / 2;
        if (Math.sign(derivative(mid)) === sign) lo = mid;
        else hi = mid;
      }
      visit((lo + hi) / 2);
    }
  }
  return [min, max];
}

let passed = 0, failed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log('PASS ' + name); }
  catch (error) { failed++; console.log('FAIL ' + name + '\n' + (error instanceof Error ? error.stack : error)); }
}

function sideError(points: Point[]) {
  let maxError = 0;
  for (let i = 0; i < points.length; i++) {
    const [a, b] = [points[i], points[(i + 1) % points.length]];
    const steps = Math.ceil(Math.hypot(a[0] - b[0], a[1] - b[1]) * 4);
    for (let j = 0; j < steps; j++) {
      const t = j / steps;
      // The ellipse field is scaled by its short radius. The ratio bounds radial distance.
      maxError = Math.max(maxError, (80 / 60) * Math.abs(profile(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)));
    }
  }
  for (const p of trueSide()) maxError = Math.max(maxError, distanceToOutline(p, points));
  return maxError;
}

await check('Seed removes the dimension region and the side follows its true outline', async () => {
  const sheet = drawing();
  const { geo } = await cook(sheet, { views: { side: views.side }, length });
  const points = sidePixels(geo);
  const maxError = sideError(points);
  console.log(`  Side outline error at most ${maxError.toFixed(3)} px (${(maxError * scale).toFixed(6)} m) in the sampled comparison`);
  assert.ok(maxError <= 1.5, String(maxError));
  const unseeded = await cook(sheet, { views: { side: { box: side } }, length });
  assert.ok(!contains(points, seed[0], seed[1]));
  assert.ok(contains(sidePixels(unseeded.geo), seed[0], seed[1]));
});

await check('Closing repairs a two-pixel break and thinning removes an attached extension line', async () => {
  const sheet = drawing({ dimension: false, defects: true });
  const params = { views: { side: { box: side } }, metres_per_pixel: scale };
  const cleaned = await cook(sheet, params);
  const cleanPoints = sidePixels(cleaned.geo), error = sideError(cleanPoints);
  console.log(`  Repaired side outline error at most ${error.toFixed(3)} px in the sampled comparison`);
  assert.ok(error <= 1.5, String(error));
  assert.ok(contains(cleanPoints, 300, 90));
  const open = await cook(sheet, { ...params, close: 0 });
  assert.ok(!contains(sidePixels(open.geo), 300, 90));
  const unthinned = await cook(sheet, { ...params, thin: 0 });
  assert.ok(Math.max(...sidePixels(unthinned.geo).map((p) => p[1])) >= side[3] - 0.01);
  const overrides = await cook(sheet, { ...params, close: 0, thin: 0, views: { side: { box: side, close: 2, thin: 2 } } });
  assert.deepEqual(overrides.geo.P, cleaned.geo.P);
});

await check('Erase opens the dimension region', async () => {
  const { geo } = await cook(drawing(), { views: { side: { box: side, erase } }, length });
  const points = sidePixels(geo);
  assert.ok(!contains(points, seed[0], seed[1]));
  assert.ok(Math.max(...points.map((p) => p[1])) < 185);
});

await check('Solid discs restore both gapped outlines', async () => {
  const sheet = drawing({ dimension: false, gaps: true });
  const solid = [185, 475].map((cx) => ['disc', cx, 149, 34]);
  const fixed = await cook(sheet, { views: { side: { box: side, solid } }, length });
  const raw = await cook(sheet, { views: { side: { box: side } }, length });
  for (const cx of [185, 475]) {
    assert.ok(contains(sidePixels(fixed.geo), cx, 181));
    assert.ok(!contains(sidePixels(raw.geo), cx, 181));
  }
  const extra = await cook(sheet, {
    views: { side: { box: side, solid: [...solid, ['rect', 29, 200, 35, 206]] } }, length,
  });
  assert.equal(extra.stats.parts_dropped, fixed.stats.parts_dropped + 1);
  assert.deepEqual(extra.geo.P, fixed.geo.P);
  assert.equal(extra.stats.parts_dropped_large, 0);
  assert.ok(!extra.messages.some((s) => s.includes('dropped')));
  const large = await cook(sheet, {
    views: { side: { box: side, solid: [...solid, ['rect', 40, 194, 90, 230]] } }, length,
  });
  assert.equal(large.stats.parts_dropped_large, 1);
  assert.match(large.messages.join('\n'), /side dropped 1/);
});

await check('One scale, four planes and front orientation', async () => {
  const { geo, stats } = await cook(drawing(), { views, length });
  assert.equal(geo.numPrims, 4);
  assert.equal(stats.views, 4);
  near(detail(geo, 'metres_per_pixel'), scale);
  near(detail(geo, 'length'), length);
  near(detail(geo, 'width'), 1.28);
  near(detail(geo, 'height'), 1.48);
  const [min, max] = longitudinalBounds(outline(geo, 'side'));
  near(max - min, length);
  const px = geo.points.get('blueprint_px')!;
  assert.equal(px.size, 2);
  for (let p = 0; p < geo.numPrims; p++) {
    const name = geo.prims.get('name')!.get(p);
    assert.equal(stats[`${name}_cvs`], geo.primPoints(p).length);
    for (const i of geo.primPoints(p)) {
      const [x, y, z] = geo.P.subarray(i * 3, i * 3 + 3);
      const [sx, sy] = px.get(i) as Point;
      if (name === 'side') { near(x, 0); near(z, (328 - sx) * scale); near(y, (240 - sy) * scale); }
      if (name === 'top') { near(y, 0); near(z, (328 - sx) * scale); near(x, (sy - 335) * scale); }
      if (name === 'front') { near(z, max); near(x, (sx - 752) * scale); }
      if (name === 'rear') { near(z, min); near(x, (932 - sx) * scale); }
    }
  }
  for (const name of ['side', 'top']) for (const direction of ['left', 'right', 'up', 'down']) {
    const box: Box = [3, 4, 105, 106];
    const sheet = paper(110, 110);
    const along = (x: number, y: number) => direction === 'left' ? 55 - x : direction === 'right' ? x - 55 : direction === 'up' ? 55 - y : y - 55;
    draw(sheet, box, (x, y) => {
      const u = along(x, y), v = direction === 'left' || direction === 'right' ? y - 55 : x - 55;
      return u >= -30 && u < 37 && Math.abs(v) < (u + 45) / 3;
    });
    const { geo: oriented } = await cook(sheet, { views: { [name]: { box, front: direction } }, metres_per_pixel: scale });
    const coords = oriented.points.get('blueprint_px')!;
    const [x, y] = coords.get(0) as Point;
    const expected = along(x, y) - 3.5;
    near(oriented.P[2], expected * scale);
  }
  console.log(`  Side curve length ${(max - min).toFixed(12)} m, front/rear planes ${max.toFixed(12)} m / ${min.toFixed(12)} m`);
});

await check('Upper half mirrors over scribbles', async () => {
  const clean = await cook(drawing(), { views: { top: views.top }, metres_per_pixel: scale });
  const mirrored = await cook(drawing({ scribble: true }), {
    views: { top: { ...views.top, centre: 335, mirror: 'upper' } }, metres_per_pixel: scale,
  });
  assert.deepEqual(mirrored.geo.P, clean.geo.P);
  assert.deepEqual(mirrored.geo.prims.get('knots')!.getArray(0), clean.geo.prims.get('knots')!.getArray(0));
});

await check('A 3% shorter top names both lengths in the warning', async () => {
  const { messages, stats } = await cook(drawing({ shorten: 18 }), { views, length });
  near(stats.extent_mismatch, 0.03);
  const warning = messages.find((s) => /side.*6\.000.*top.*5\.820/.test(s));
  assert.ok(warning, messages.join('\n'));
  console.log('  ' + warning);
  const atThreshold = await cook(drawing({ shorten: 6 }), { views, length });
  near(atThreshold.stats.extent_mismatch, 0.01);
  assert.ok(!atThreshold.messages.some((s) => s.includes('differs')));
});

await check('Invalid scale, view keys and silhouettes give actionable errors', async () => {
  const box: Box = [0, 0, 20, 20], sheet = paper(20, 20);
  const allInk = paper(20, 20);
  allInk.pixels.fill(0);
  const valid = { views: { side: { box } }, length };
  const cases: [Sheet, Record<string, unknown>, RegExp][] = [
    [sheet, { ...valid, metres_per_pixel: scale }, /set exactly one.*length.*metres_per_pixel/],
    [sheet, { ...valid, length: 0 }, /set exactly one.*length.*metres_per_pixel/],
    [sheet, { ...valid, views: { side: { box, typo: true } } }, /side.*typo.*box.*ground.*centre.*front.*mirror.*erase.*seeds.*solid/],
    [sheet, { ...valid, views: { side: { box, close: -1 } } }, /side.*close.*whole pixels/],
    [sheet, { ...valid, views: { side: { box, thin: 1.5 } } }, /side.*thin.*whole pixels/],
    [sheet, { ...valid, views: { underside: { box } } }, /underside.*side.*top.*front.*rear/],
    [sheet, valid, /side.*empty.*box.*ink.*seeds/],
    [allInk, valid, /side.*all four.*box.*ink.*seeds/],
  ];
  for (const [image, params, message] of cases) {
    const r = await run(image, params);
    assert.equal(r.ok, false);
    assert.match(r.errors.map((e) => e.message).join('\n'), message);
  }
});

await check('Four views on a 2000 × 1400 sheet cook in under two seconds', async () => {
  const sheet = drawing({ large: true });
  const wide = {
    side: { ...views.side, box: [0, 0, 660, 250], ground: 239 },
    top: { ...views.top, box: [0, 250, 660, 1400] },
    front: { box: [660, 0, 840, 1400], ground: 239 },
    rear: { box: [840, 0, 2000, 1400], ground: 239 },
  };
  const start = performance.now();
  const { geo } = await cook(sheet, { views: wide, length });
  const elapsed = performance.now() - start;
  console.log(`  Four-view cook ${elapsed.toFixed(1)} ms`);
  assert.equal(geo.numPrims, 4);
  assert.ok(elapsed < 2000, String(elapsed));
});

const evidence = process.argv[2];
if (evidence) {
  const { w, h, pixels } = drawing();
  writeFileSync(join(evidence, 'sheet.png'), encodeGreyPNG(Uint8Array.from(pixels, (p) => p * 255), w, h, 8, deflateSync));
  writeFileSync(join(evidence, 'blueprint.json'), JSON.stringify({ nodes: {
    sheet: { type: 'image_file', params: { path: 'sheet.png' } },
    outlines: { type: 'blueprint', in: ['sheet'], params: { views, length } },
  }, output: 'outlines' }, null, 2) + '\n');
}

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
