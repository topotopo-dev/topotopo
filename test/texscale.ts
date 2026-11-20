// Texture nodes in metres. Every length a texture node takes is in metres, read against the metres its image covers
// (texture_size on a generator, carried by the image) or, on an atlas a bake wrote (layers "texel" and "island"), against
// the texel size of each island. Checks, on atlases with real content, background, islands of three densities and a round
// island, that the same filter on a 512 and a 2048 bake matches after resampling (blur, dilate, erode, bevel, distance, edge
// lines, warp, directional and slope blur, height to normal, curvature, ao, flood fill, noise, scratches, cells, grunge),
// that a metre-sized filter has the same real size on islands of different density and on texels that are not square, that
// nothing is read across an island border and a blur keeps the mean up to it, that images that are not square are metres
// down as well as across, that tileable generators tile, that every old name errors with the new one, that the size and the
// layers follow the image through every node that makes one, and that the worker pool changes no bit.
//   node test/texscale.ts
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { Geometry } from '../src/core/geometry.ts';
import { Image, findImage, resizeLayer, toGrey } from '../src/core/image.ts';
import { heightfieldsOf } from '../src/core/heightfield.ts';
import { islandsOf, runScaled, slopeFacts } from '../src/core/texscale.ts';
import { defineNode, getNodeDef } from '../src/graph/registry.ts';
import type { NodeSpec } from '../src/graph/types.ts';

let fail = 0, pass = 0;
const check = (ok: unknown, msg: string) => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
};
const section = (s: string) => console.log(`\n== ${s}`);
const f3 = (x: number) => x.toFixed(3);
type Nodes = Record<string, NodeSpec>;

const serial = new Engine(createNodeHost({ workers: 0 }));
await serial.init();
const pooled = new Engine(createNodeHost({ workers: 4, pool: { minElements: 1 } }));
await pooled.init();

interface Cooked { geo: Geometry; stats: Record<string, number>; warnings: string[] }
async function cookAll(nodes: Nodes, output: string, engine = serial): Promise<Cooked> {
  const r = await engine.cook({ nodes, output });
  if (!r.ok || !r.geo) throw new Error(`cook failed: ${r.errors.map((x) => `[${x.node}] ${x.message}`).join('; ')}`);
  return { geo: r.geo, stats: (r.results.get(r.target) as any).stats ?? {}, warnings: r.warnings.map((w) => w.message) };
}
const cook = async (nodes: Nodes, output: string, engine = serial) => (await cookAll(nodes, output, engine)).geo;
async function image(nodes: Nodes, output: string, name = output, engine = serial): Promise<Image> {
  const img = findImage(await cook(nodes, output, engine), name);
  if (!img) throw new Error(`no image "${name}" in the output of ${output}`);
  return img;
}
async function err(nodes: Nodes, output: string): Promise<string> {
  const r = await serial.cook({ nodes, output });
  return r.ok ? '' : r.errors.map((e) => e.message + (e.hint ? ` (${e.hint})` : '')).join('; ');
}
const same = (a: Float32Array, b: Float32Array) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
/** Mean absolute difference of two layers over the pixels where `keep` is set. */
function meanDiff(a: Float32Array, b: Float32Array, ch: number, keep?: (i: number) => boolean): number {
  let s = 0, n = 0;
  for (let i = 0; i < a.length / ch; i++) {
    if (keep && !keep(i)) continue;
    for (let c = 0; c < ch; c++) s += Math.abs(a[i * ch + c] - b[i * ch + c]);
    n += ch;
  }
  return n ? s / n : 0;
}

// a source of hand-made images for the filters under test
const sources = new Map<string, Image>();
defineNode({ type: '__texscale_source', category: 'test', inputs: [], summary: 'test', params: { key: { type: 'string', default: '', desc: 'image key' } }, cook: ({ p }) => { const g = new Geometry(); g.volumes = [sources.get(p.key)!.clone()]; return g; } });
const src = (key: string): Nodes => ({ s: { type: '__texscale_source', params: { key } } });

// ---------------------------------------------------------------- an atlas by hand: two islands, texels of 2 mm and 8 mm

const AW = 256, AH = 128, T0 = 0.002, T1 = 0.008;
/** Left half = island 0 (2 mm texels along u, `v0` along v), right half = island 1 (8 mm, `v1`); `value(i, j, island)` fills C. */
function atlas(value: (i: number, j: number, island: number) => number, rgba = false, v0 = T0, v1 = T1): Image {
  const img = new Image(AW, AH, 'atlas');
  const C = new Float32Array(AW * AH * (rgba ? 4 : 1)), texel = new Float32Array(AW * AH * 4), island = new Float32Array(AW * AH), mask = new Float32Array(AW * AH).fill(1);
  for (let j = 0; j < AH; j++)
    for (let i = 0; i < AW; i++) {
      const k = j * AW + i, isl = i < AW / 2 ? 0 : 1, v = value(i, j, isl);
      if (rgba) { C[k * 4] = C[k * 4 + 1] = C[k * 4 + 2] = v; C[k * 4 + 3] = v > 0 ? 1 : 0; } else C[k] = v;
      texel[k * 4] = isl ? T1 : T0; texel[k * 4 + 1] = isl ? v1 : v0; texel[k * 4 + 3] = 1;
      island[k] = isl;
    }
  img.set('C', C).set('texel', texel).set('island', island).set('mask', mask);
  img.size = 0.25;
  return img;
}
const CX = [AW / 4, (3 * AW) / 4], CY = AH / 2; // the centre of each island
/** Spread (px) along u and v and the centroid along u of an island's part of a layer. */
function moments(a: Float32Array, isl: number, ch = 1, c = 0): { sigma: number; sigmaV: number; cx: number; sum: number; count: number } {
  let sum = 0, mx = 0, mxx = 0, my = 0, myy = 0, count = 0;
  for (let j = 0; j < AH; j++)
    for (let i = isl * (AW / 2); i < (isl + 1) * (AW / 2); i++) {
      const v = a[(j * AW + i) * ch + c];
      if (v > 1e-4) count++;
      sum += v; mx += v * i; mxx += v * i * i; my += v * j; myy += v * j * j;
    }
  const cx = mx / sum, cy = my / sum;
  return { sigma: Math.sqrt(Math.max(0, mxx / sum - cx * cx)), sigmaV: Math.sqrt(Math.max(0, myy / sum - cy * cy)), cx, sum, count };
}
const impulse = (i: number, j: number, isl: number) => (i === CX[isl] && j === CY ? 1 : 0);

section('islands of different texel sizes: a length in metres is the same on each');
{
  const a0 = atlas(impulse);
  const isl = islandsOf(a0)!.islands;
  check(isl.length === 2 && Math.abs(isl[0].tu - T0) < 1e-9 && Math.abs(isl[1].tu - T1) < 1e-9, 'the atlas reads as two islands, of 2 mm and 8 mm texels');
  sources.set('impulse', a0);
  // blur: 0.04 m is a sigma of 20 mm, 10 texels on the fine island and 2.5 on the coarse one
  const b = await image({ ...src('impulse'), b: { type: 'tex_blur', in: ['s'], params: { blur: 0.04, tileable: false } } }, 'b');
  const m0 = moments(b.layer('C')!, 0), m1 = moments(b.layer('C')!, 1);
  const mm0 = m0.sigma * T0 * 1000, mm1 = m1.sigma * T1 * 1000;
  check(Math.abs(mm0 - 20) < 4 && Math.abs(mm1 - 20) < 4 && Math.abs(mm0 / mm1 - 1) < 0.15, `blur 0.04 m: sigma ${f3(mm0)} mm on the 2 mm island (${f3(m0.sigma)} px), ${f3(mm1)} mm on the 8 mm one (${f3(m1.sigma)} px)`);
  check(Math.abs(m0.sum - 1) < 1e-4 && Math.abs(m1.sum - 1) < 1e-4, 'the blur keeps each island\'s mass');
  // dilate: a valid texel grows to a disc of 0.02 m: the same area in m² on both
  sources.set('valid', atlas(impulse, true));
  const d = await image({ ...src('valid'), d: { type: 'tex_dilate', in: ['s'], params: { distance: 0.02 } } }, 'd');
  const alpha = (isl: number) => { let n = 0; for (let j = 0; j < AH; j++) for (let i = isl * 128; i < isl * 128 + 128; i++) if (d.layer('C')![(j * AW + i) * 4] > 0) n++; return n; };
  const area0 = alpha(0) * T0 * T0, area1 = alpha(1) * T1 * T1;
  check(Math.abs(area0 / (Math.PI * 4e-4) - 1) < 0.15 && Math.abs(area1 / (Math.PI * 4e-4) - 1) < 0.2 && alpha(0) > 8 * alpha(1), `dilate 0.02 m: ${alpha(0)} texels (${f3(area0 * 1e4)} cm²) and ${alpha(1)} texels (${f3(area1 * 1e4)} cm²) of a 12.6 cm² disc`);
  // warp: a constant map of 1 moves a texel by the distance, 0.02 m, which is 10 texels and 2.5
  sources.set('ones', atlas(() => 1));
  const w = await image({ ...src('impulse'), o: { type: '__texscale_source', params: { key: 'ones' } }, w: { type: 'tex_warp', in: ['s', 'o'], params: { mode: 'directional', distance: 0.02, angle: 0, tileable: false } } }, 'w');
  const w0 = moments(w.layer('C')!, 0), w1 = moments(w.layer('C')!, 1);
  check(Math.abs((w0.cx - CX[0]) * T0 * 1000 - 20) < 2 && Math.abs((w1.cx - CX[1]) * T1 * 1000 - 20) < 4, `warp 0.02 m: the texel moves ${f3(Math.abs(w0.cx - CX[0]) * T0 * 1000)} mm on the fine island, ${f3(Math.abs(w1.cx - CX[1]) * T1 * 1000)} mm on the coarse`);
  // slope warp: a ramp of the same slope per metre on both islands moves a texel by the same metres, whatever the island's own steepest slope
  const ramp = (i: number, _j: number, isl2: number) => 0.5 + (i - CX[isl2]) * (isl2 ? T1 : T0) * 4;
  sources.set('ramp', atlas(ramp));
  const sw = await image({ ...src('impulse'), o: { type: '__texscale_source', params: { key: 'ramp' } }, w: { type: 'tex_warp', in: ['s', 'o'], params: { mode: 'slope', distance: 0.02, tileable: false } } }, 'w');
  const s0 = moments(sw.layer('C')!, 0), s1 = moments(sw.layer('C')!, 1);
  check(Math.abs((s0.cx - CX[0]) * T0 - (s1.cx - CX[1]) * T1) < 0.004 && Math.abs(s0.cx - CX[0]) > 3, `slope warp: ${f3((s0.cx - CX[0]) * T0 * 1000)} mm and ${f3((s1.cx - CX[1]) * T1 * 1000)} mm on the two islands (one slope normaliser for the image)`);
  const facts = slopeFacts(sources.get('ramp')!, sources.get('ramp')!.layer('C')!, false);
  check(Math.abs(facts.max - 4) < 0.3, `the steepest slope of the image is read in metres (${f3(facts.max)} per m, 4)`);
  // directional blur: a line 40 mm long has a spread of 40 / sqrt(12) = 11.5 mm
  const db = await image({ ...src('impulse'), b: { type: 'tex_directional_blur', in: ['s'], params: { length: 0.04, angle: 0, symmetric: true, tileable: false } } }, 'b');
  const d0 = moments(db.layer('C')!, 0).sigma * T0 * 1000, d1 = moments(db.layer('C')!, 1).sigma * T1 * 1000;
  check(Math.abs(d0 - 11.5) < 3.5 && Math.abs(d1 - 11.5) < 3.5, `directional blur 0.04 m spreads ${f3(d0)} mm on the fine island and ${f3(d1)} mm on the coarse (11.5 mm)`);
  // bevel: a plate of 0.06 m bevelled by 0.01 m: the plate's row sums to 0.06 - 2 × 0.005
  const plate = (i: number, j: number, isl2: number) => (Math.abs(i - CX[isl2]) * (isl2 ? T1 : T0) <= 0.03 && Math.abs(j - CY) * (isl2 ? T1 : T0) <= 0.03 ? 1 : 0);
  sources.set('plate', atlas(plate));
  const bv = await image({ ...src('plate'), b: { type: 'tex_bevel', in: ['s'], params: { distance: 0.01, profile: 'linear', tileable: false } } }, 'b');
  const rampSum = (isl2: number) => { let s = 0; for (let i = isl2 * 128; i < isl2 * 128 + 128; i++) s += bv.layer('C')![CY * AW + i]; return s * (isl2 ? T1 : T0); };
  check(Math.abs(rampSum(0) - 0.05) < 0.003 && Math.abs(rampSum(1) - 0.05) < 0.006, `bevel 0.01 m: the plate's row sums to ${f3(rampSum(0) * 1000)} mm and ${f3(rampSum(1) * 1000)} mm (50 mm)`);
  // height to normal: a slope of 5 mm per 100 mm on both islands gives the same tilt
  const slope = (i: number, _j: number, isl2: number) => 0.5 + (i - CX[isl2]) * (isl2 ? T1 : T0) * 5;
  sources.set('slope', atlas(slope));
  const nm = await image({ ...src('slope'), n: { type: 'tex_normal_from_height', in: ['s'], params: { depth: 0.01, tileable: false } } }, 'n');
  const red = (i: number) => nm.layer('C')![(CY * AW + i) * 4];
  check(Math.abs(red(CX[0]) - red(CX[1])) < 1e-4 && red(CX[0]) < 0.5, `height to normal: the same tilt on both islands (red ${red(CX[0]).toFixed(5)} and ${red(CX[1]).toFixed(5)})`);
}

section('texels that are not square: a circle in metres');
{
  // 2 mm along u and 1 mm along v on the left island, 8 and 2 mm on the right
  sources.set('impulse-ns', atlas(impulse, false, 0.001, 0.002));
  sources.set('valid-ns', atlas(impulse, true, 0.001, 0.002));
  const b = await image({ ...src('impulse-ns'), b: { type: 'tex_blur', in: ['s'], params: { blur: 0.04, tileable: false } } }, 'b');
  const m0 = moments(b.layer('C')!, 0), m1 = moments(b.layer('C')!, 1);
  const su0 = m0.sigma * T0, sv0 = m0.sigmaV * 0.001, su1 = m1.sigma * T1, sv1 = m1.sigmaV * 0.002;
  check(Math.abs(su0 / sv0 - 1) < 0.15 && Math.abs(su1 / sv1 - 1) < 0.15, `blur: a circle in metres (sigma ${f3(su0 * 1000)} × ${f3(sv0 * 1000)} mm, ${f3(su1 * 1000)} × ${f3(sv1 * 1000)} mm)`);
  const d = await image({ ...src('valid-ns'), d: { type: 'tex_dilate', in: ['s'], params: { distance: 0.02 } } }, 'd');
  const extent = (isl2: number) => { let wu = 0, hv = 0; for (let i = isl2 * 128; i < isl2 * 128 + 128; i++) if (d.layer('C')![(CY * AW + i) * 4] > 0) wu++; for (let j = 0; j < AH; j++) if (d.layer('C')![(j * AW + CX[isl2]) * 4] > 0) hv++; return [wu * (isl2 ? T1 : T0), hv * (isl2 ? 0.002 : 0.001)]; };
  const e0 = extent(0), e1 = extent(1);
  check(Math.abs(e0[0] / e0[1] - 1) < 0.15 && Math.abs(e1[0] / e1[1] - 1) < 0.35, `dilate: a disc in metres (${f3(e0[0] * 1000)} × ${f3(e0[1] * 1000)} mm, ${f3(e1[0] * 1000)} × ${f3(e1[1] * 1000)} mm)`);
  const dd = await image({ ...src('impulse-ns'), o: { type: 'tex_sdf_from_mask', in: ['s'], params: { threshold: 0.5, tileable: false } } }, 'o');
  const dv = dd.layer('C')![(CY + 12) * AW + CX[0]], du = dd.layer('C')![CY * AW + CX[0] + 6];
  // 12 mm is 12 rows of 1 mm and 6 columns of 2 mm, less half the texel's own size along that axis
  check(Math.abs(dv - 0.0115) < 0.0004 && Math.abs(du - 0.011) < 0.0004, `distance: 12 mm is 12 rows and 6 columns (${f3(dv * 1000)} and ${f3(du * 1000)} mm)`);
  const dr = await image({ ...src('impulse-ns'), d: { type: 'tex_directional_blur', in: ['s'], params: { length: 0.03, angle: 90, symmetric: true, tileable: false } } }, 'd');
  check(Math.abs(moments(dr.layer('C')!, 0).sigmaV * 0.001 * 1000 - 30 / Math.sqrt(12)) < 3.5, 'directional blur along v is measured in the metres of the rows');
}

// ---------------------------------------------------------------- an atlas from a bake, with content, background and a round island

/** Three islands (4, 2 and 3 m per uv unit) and a round one, at world positions that tell them apart; content = noise. */
const SCENE = (r: number): Nodes => ({
  qa: { type: 'grid', params: { size: [1, 1], divisions: [2, 1], center: [-2.5, 0, 0] } },
  qb: { type: 'grid', params: { size: [1, 1], divisions: [2, 1], center: [2.5, 0, 0] } },
  disc: { type: 'circle', params: { radius: 0.5, divisions: 24, plane: 'xz' } },
  filled: { type: 'fill', in: ['disc'], params: {} },
  ua: { type: 'uv_project', in: ['qa'], params: { method: 'planar', axis: 'y', scale: 4, offset: [0.825, 0.5] } },
  ub: { type: 'uv_project', in: ['qb'], params: { method: 'planar', axis: 'y', scale: 2, offset: [-0.55, 0.5] } },
  ud: { type: 'uv_project', in: ['filled'], params: { method: 'planar', axis: 'y', scale: 3, offset: [0.2, 0.82] } },
  all: { type: 'merge', in: ['ua', 'ub', 'ud'] },
  pos: { type: 'bake_position', in: ['all'], params: { resolution: r, mode: 'world', padding: r / 64 } },
  noise: { type: 'tex_noise', params: { resolution: r, feature: 0.4, octaves: 3, texture_size: 3, seed: 5 } },
  smooth: { type: 'tex_blend', in: ['pos', 'noise'], params: { mode: 'normal', layer: 'C', clamp: true } },
  hard: { type: 'tex_threshold', in: ['smooth'], params: { threshold: 0.5, softness: 0 } },
});
{
  section('the same filter on a 512 and a 2048 bake of one atlas');
  const lo = await image(SCENE(512), 'smooth'), hi = await image(SCENE(2048), 'smooth');
  const il = islandsOf(lo)!, ih = islandsOf(hi)!;
  const tex = il.islands.map((s) => s.tu).sort((a, b) => a - b);
  check(il.islands.length === 3 && ih.islands.length === 3 && il.background > 0 && tex[2] / tex[0] > 1.8 && Math.abs(ih.islands[0].tu * 4 - il.islands[0].tu) / il.islands[0].tu < 0.02,
    `the bake has ${il.islands.length} islands of texel ${tex.map((t) => (t * 1000).toFixed(2)).join(', ')} mm at 512 and background around them`);
  check(lo.size > 0 && Math.abs(lo.size - hi.size) / lo.size < 0.01 && lo.layers.has('texel') && lo.layers.has('island'), `a bake of positions writes texel and island, and its size is ${f3(lo.size)} m at both resolutions`);
  const roundIsland = il.islands.find((s) => s.count < (s.x1 - s.x0 + 1) * (s.y1 - s.y0 + 1) * 0.9);
  check(!!roundIsland, 'one island is not a rectangle (the round one fills about 79% of its box)');
  const keepLo = (i: number) => lo.layer('mask')![i] === 1;
  const compare = async (label: string, nodes: (r: number) => Nodes, layer: string, tol: number, ch = 1, out = 'f') => {
    const a = await image({ ...SCENE(512), ...nodes(512) }, out), b = await image({ ...SCENE(2048), ...nodes(2048) }, out);
    const small = resizeLayer(b.layer(layer)!, ch, 2048, 2048, 512, 512, false);
    const d = meanDiff(a.layer(layer)!, small, ch, keepLo);
    check(d < tol, `${label}: 512 and 2048 differ by ${d.toFixed(4)} on average (at most ${tol})`);
  };
  await compare('blur 0.03 m', () => ({ f: { type: 'tex_blur', in: ['hard'], params: { blur: 0.03 } } }), 'C', 0.012);
  await compare('dilate 0.02 m', () => ({ f: { type: 'tex_dilate', in: ['hard', 'hard'], params: { distance: 0.02, mask_channel: 'luminance' } } }), 'C', 0.012);
  await compare('erode: sdf offset -0.02 m', () => ({
    sd: { type: 'tex_sdf_from_mask', in: ['hard'], params: {} },
    op: { type: 'tex_sdf_op', in: ['sd'], params: { mode: 'offset', amount: -0.02 } },
    f: { type: 'tex_sdf_to_mask', in: ['op'], params: { mode: 'fill' } },
  }), 'C', 0.015);
  await compare('bevel 0.03 m', () => ({ f: { type: 'tex_bevel', in: ['hard'], params: { distance: 0.03, profile: 'smooth' } } }), 'C', 0.012);
  await compare('distance: grow 0.03 m', () => ({ f: { type: 'tex_distance', in: ['hard'], params: { distance: 0.03, mode: 'grow' } } }), 'C', 0.012);
  await compare('edge lines 0.01 m', () => ({ f: { type: 'tex_edge_detect', in: ['hard'], params: { mode: 'outline', line_width: 0.01 } } }), 'C', 0.015);
  await compare('height to normal (blur 0.03 m, depth 0.02 m)', () => ({
    bl: { type: 'tex_blur', in: ['smooth'], params: { blur: 0.03 } },
    f: { type: 'tex_normal_from_height', in: ['bl'], params: { depth: 0.02 } },
  }), 'C', 0.006, 4);
  await compare('curvature of that normal map (radius 0.05 m)', () => ({
    bl: { type: 'tex_blur', in: ['smooth'], params: { blur: 0.04 } },
    nm: { type: 'tex_normal_from_height', in: ['bl'], params: { depth: 0.02 } },
    f: { type: 'tex_curvature', in: ['nm'], params: { radius: 0.05 } },
  }), 'C', 0.012);
  await compare('ao (radius 0.05 m, depth 0.02 m)', () => ({
    bl: { type: 'tex_blur', in: ['smooth'], params: { blur: 0.02 } },
    f: { type: 'tex_ao', in: ['bl'], params: { radius: 0.05, depth: 0.02, directions: 4, steps: 4 } },
  }), 'C', 0.02);
  await compare('warp 0.02 m by noise', (r) => ({
    n: { type: 'tex_noise', params: { resolution: r, feature: 0.5, octaves: 2, texture_size: 2 } },
    f: { type: 'tex_warp', in: ['hard', 'n'], params: { mode: 'directional', distance: 0.02, angle: 30 } },
  }), 'C', 0.012);
  await compare('slope warp 0.02 m by noise', (r) => ({
    n: { type: 'tex_noise', params: { resolution: r, feature: 0.5, octaves: 2, texture_size: 2 } },
    f: { type: 'tex_warp', in: ['hard', 'n'], params: { mode: 'slope', distance: 0.02 } },
  }), 'C', 0.03);
  await compare('directional blur 0.04 m', () => ({ f: { type: 'tex_directional_blur', in: ['hard'], params: { length: 0.04, angle: 20 } } }), 'C', 0.012);
  await compare('slope blur 0.03 m', (r) => ({
    n: { type: 'tex_noise', params: { resolution: r, feature: 0.5, octaves: 2, texture_size: 2 } },
    f: { type: 'tex_slope_blur', in: ['hard', 'n'], params: { distance: 0.03, mode: 'blur' } },
  }), 'C', 0.02);
  await compare('flood fill (the size of each tile)', () => ({ f: { type: 'tex_flood_fill', in: ['hard'], params: { output: 'bbox_size' } } }), 'C', 0.02);

  // generators: the same image at two resolutions after resampling
  const gen = async (label: string, node: (r: number) => NodeSpec, tol: number) => {
    const a = await image({ g: node(512) }, 'g'), b = await image({ g: node(2048) }, 'g');
    const d = meanDiff(a.layer('C')!, resizeLayer(b.layer('C')!, 1, 2048, 2048, 512, 512, true), 1);
    check(d < tol && a.size === b.size, `${label}: 512 and 2048 differ by ${d.toFixed(4)} on average (at most ${tol}); the image covers ${a.size} m at both`);
  };
  await gen('noise, feature 0.4 m on 3.2 m', (r) => ({ type: 'tex_noise', params: { resolution: r, feature: 0.4, octaves: 4, texture_size: 3.2 } }), 0.02);
  await gen('scratches, 0.5 to 1.2 m long, 4 mm wide on 3.2 m', (r) => ({ type: 'tex_scratches', params: { resolution: r, count: 60, stroke_length: [0.5, 1.2], stroke_width: 0.004, texture_size: 3.2 } }), 0.01);
  await gen('splatter, radius 0.1 to 0.3 m on 3.2 m', (r) => ({ type: 'tex_splatter', params: { resolution: r, count: 20, blob_radius: [0.1, 0.3], texture_size: 3.2 } }), 0.01);
  await gen('cells, 0.4 m on 3.2 m', (r) => ({ type: 'tex_cells', params: { resolution: r, cell: 0.4, texture_size: 3.2 } }), 0.02);
  await gen('grunge, feature 0.4 m on 3.2 m', (r) => ({ type: 'tex_grunge', params: { resolution: r, feature: 0.4, texture_size: 3.2 } }), 0.03);
}

// ---------------------------------------------------------------- flood fill on an atlas

section('flood fill on an atlas: positions and values in the whole image, tiles counted once');
{
  const r = 512;
  const g = await cookAll({ ...SCENE(r), f: { type: 'tex_flood_fill', in: ['hard'], params: { output: 'position' } } }, 'f');
  const randomGeo = await cook({ ...SCENE(r), v: { type: 'tex_flood_fill', in: ['hard'], params: { output: 'random' } } }, 'v');
  const fill = findImage(g.geo, 'f')!, hard = await image(SCENE(r), 'hard');
  const isl = hard.layer('island')!, m = hard.layer('C')!, P = fill.layer('C')!;
  // components of the mask inside each island, labelled by hand
  const label = new Int32Array(r * r).fill(-1);
  let tiles = 0;
  const stats: { sx: number; sy: number; n: number; isl: number }[] = [];
  for (let s = 0; s < r * r; s++) {
    if (label[s] >= 0 || !(m[s] >= 0.5) || isl[s] < 0) continue;
    const q = [s]; label[s] = tiles;
    const T = { sx: 0, sy: 0, n: 0, isl: isl[s] };
    while (q.length) {
      const k = q.pop()!, x = k % r, y = (k - x) / r;
      T.sx += x + 0.5; T.sy += y + 0.5; T.n++;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= r || ny >= r) continue; const o = ny * r + nx; if (label[o] < 0 && m[o] >= 0.5 && isl[o] === T.isl) { label[o] = tiles; q.push(o); } }
    }
    stats.push(T); tiles++;
  }
  check(g.stats.tiles === tiles, `the tiles stat counts every tile of every island once (${g.stats.tiles} of ${tiles})`);
  // the position of the biggest tiles is their centre in the whole image
  const big = stats.map((t, i) => ({ t, i })).filter((x) => x.t.n > 300).slice(0, 12);
  let worst = 0;
  for (const { t, i } of big) {
    const k = label.indexOf(i), cu = t.sx / t.n / r, cv = 1 - t.sy / t.n / r;
    worst = Math.max(worst, Math.abs(P[k * 4] - cu), Math.abs(P[k * 4 + 1] - cv));
  }
  check(big.length >= 3 && worst < 0.03, `position is the tile's centre in the whole image (${big.length} tiles checked, off by at most ${worst.toFixed(4)} of the image)`);
  // the random values hash where a tile is in the whole image: no two tiles share one
  const vals = findImage(randomGeo, 'v')!.layer('C')!;
  const seen = new Set<string>();
  for (const { i } of big) seen.add(vals[label.indexOf(i)].toFixed(5));
  check(seen.size === big.length, `the random values of ${big.length} tiles are all different`);
}

// ---------------------------------------------------------------- nothing is read across an island border

section('no filter reads across an island border; a blur keeps the mean up to it');
{
  const r = 256;
  const nodes = SCENE(r);
  const base = await image(nodes, 'smooth');
  const isl = base.layer('island')!;
  const ranges = new Map<number, [number, number]>();
  const lum = toGrey(base.layer('C')!, 4);
  for (let k = 0; k < r * r; k++) { const id = isl[k]; if (id < 0) continue; const e = ranges.get(id) ?? [Infinity, -Infinity]; e[0] = Math.min(e[0], lum[k]); e[1] = Math.max(e[1], lum[k]); ranges.set(id, e); }
  check([...ranges.values()].length === 3, 'three islands with their own value ranges');
  const inRange = (img: Image) => {
    const a = img.channels('C') === 4 ? toGrey(img.layer('C')!, 4) : img.layer('C')!;
    let bad = 0;
    for (let k = 0; k < r * r; k++) { const id = isl[k]; if (id < 0) continue; const [lo, hi] = ranges.get(id)!; if (a[k] < lo - 1e-4 || a[k] > hi + 1e-4) bad++; }
    return bad;
  };
  const probe = async (label: string, extra: Nodes, node: NodeSpec) => {
    const out = await image({ ...nodes, ...extra, f: node }, 'f');
    const bad = inRange(out);
    check(bad === 0, `${label}: every texel stays within the values of its own island (${bad} outside)`);
  };
  const noise = { n: { type: 'tex_noise', params: { resolution: r, feature: 0.3, texture_size: 2 } } };
  await probe('blur 0.5 m', {}, { type: 'tex_blur', in: ['smooth'], params: { blur: 0.5 } });
  await probe('directional blur 0.8 m', {}, { type: 'tex_directional_blur', in: ['smooth'], params: { length: 0.8, angle: 0 } });
  await probe('slope blur 0.5 m', noise, { type: 'tex_slope_blur', in: ['smooth', 'n'], params: { distance: 0.5, mode: 'blur' } });
  await probe('warp 0.4 m', { c: { type: 'tex_constant', in: ['smooth'], params: { value: 1 } } }, { type: 'tex_warp', in: ['smooth', 'c'], params: { mode: 'directional', distance: 0.4, angle: 0 } });
  await probe('dilate 1 m', { m: { type: 'tex_threshold', in: ['smooth'], params: { threshold: 0.5 } } }, { type: 'tex_dilate', in: ['smooth', 'm'], params: { distance: 1, mask_channel: 'luminance' } });
  await probe('distance carrying values 0.5 m', {}, { type: 'tex_distance', in: ['hard', 'smooth'], params: { distance: 0.5, mode: 'grow' } });
  // a blur is mean-preserving up to an island's border: a ramp stays a ramp where the border is near
  const rampAt = (i: number, _j: number, isl2: number) => 0.5 + (i - CX[isl2]) * (isl2 ? T1 : T0) * 4;
  sources.set('ramp2', atlas(rampAt));
  const bl = await image({ ...src('ramp2'), b: { type: 'tex_blur', in: ['s'], params: { blur: 0.02, tileable: false } } }, 'b');
  let worst = 0;
  for (let j = 0; j < AH; j++) for (let i = 0; i < AW; i++) worst = Math.max(worst, Math.abs(bl.layer('C')![j * AW + i] - rampAt(i, j, i < 128 ? 0 : 1)) / (4 * (i < 128 ? T0 : T1)));
  // a ramp blurred with the missing pixels left out of the average stays a ramp (off by a texel's step at most); copies of the edge pixel would flatten it
  check(worst < 4, `a blurred ramp stays near its ramp up to the island's border (off by at most ${worst.toFixed(2)} texel steps; the weights of the missing pixels are left out)`);
  const half = await image({ ...src('ramp2'), b: { type: 'tex_blur', in: ['s'], params: { blur: 0.3, tileable: false } } }, 'b');
  let mean0 = 0, mean0b = 0;
  for (let j = 0; j < AH; j++) for (let i = 0; i < 128; i++) { mean0 += sources.get('ramp2')!.layer('C')![j * AW + i]; mean0b += half.layer('C')![j * AW + i]; }
  check(Math.abs(mean0 - mean0b) / mean0 < 1e-3, `a blur wider than an island keeps its mean (${(mean0 / (AH * 128)).toFixed(5)} → ${(mean0b / (AH * 128)).toFixed(5)})`);
}

// ---------------------------------------------------------------- images that are not square

section('images that are not square: metres down as well as across');
{
  const at = (img: Image, i: number, j: number) => img.layer('C')![j * img.width + i];
  // 64 × 128 px covering 1 m across, so 2 m down
  const g = await image({ g: { type: 'tex_gradient', params: { resolution: [64, 128], mode: 'radial', reach: 0.3, texture_size: 1 } } }, 'g');
  // the centre is (32, 64): 0.3 m along u is 19.2 px, along v is 0.3 m / (1/64 m) = 19.2 rows
  check(Math.abs(at(g, 32 + 19, 64) - at(g, 32, 64 + 19)) < 0.06 && at(g, 32 + 19, 64) > 0.9 && at(g, 32, 64 + 10) < 0.6, `a radial gradient is a circle in metres (${f3(at(g, 51, 64))} across, ${f3(at(g, 32, 83))} down at 0.3 m)`);
  const r0 = await image({ r: { type: 'tex_gradient', params: { resolution: [64, 128], angle: 90, texture_size: 1 } } }, 'r');
  const sh = await image({ r: { type: 'tex_gradient', params: { resolution: [64, 128], angle: 90, texture_size: 1 } }, t: { type: 'tex_transform', in: ['r'], params: { shift: [0, 0.5], tileable: true } } }, 't');
  // 0.5 m of the 2 m height is a quarter of it: 32 rows, up or down
  let offA = 0, offB = 0;
  for (let j = 0; j < 128; j++) { offA = Math.max(offA, Math.abs(at(sh, 10, j) - at(r0, 10, (j + 32) % 128))); offB = Math.max(offB, Math.abs(at(sh, 10, j) - at(r0, 10, (j + 96) % 128))); }
  check(Math.min(offA, offB) < 0.02, `tex_transform shift [0, 0.5] m on a 1 m wide, 2 m tall image moves a quarter of its height (off by ${Math.min(offA, offB).toFixed(3)})`);
  const cells = await image({ c: { type: 'tex_cells', params: { resolution: [64, 128], cell: 0.25, jitter: 0, output: 'distance', texture_size: 1, tileable: false } } }, 'c');
  let periodic = 0;
  for (let j = 0; j < 100; j++) for (let i = 0; i < 40; i++) periodic = Math.max(periodic, Math.abs(at(cells, i, j) - at(cells, i, j + 16)), Math.abs(at(cells, i, j) - at(cells, i + 16, j)));
  check(periodic < 1e-4, `cells are square in metres: the same period of 0.25 m (16 px) across and down (off by ${periodic.toExponential(1)})`);
  const sdf = await image({ s: { type: 'tex_sdf_shape', params: { resolution: [64, 128], shape: 'disc', radius: 0.2, texture_size: 1, tileable: false } } }, 's');
  check(Math.abs(at(sdf, 32 + 12, 64) - at(sdf, 32, 64 + 12)) < 0.003, `an sdf disc is round in metres (${f3(at(sdf, 44, 64))} across, ${f3(at(sdf, 32, 76))} down)`);
  const noiseImg = await image({ n: { type: 'tex_noise', params: { resolution: [64, 128], feature: 0.25, texture_size: 1, tileable: false, octaves: 1 } } }, 'n');
  let gu = 0, gv = 0;
  for (let j = 1; j < 127; j++) for (let i = 1; i < 63; i++) { gu += Math.abs(at(noiseImg, i + 1, j) - at(noiseImg, i - 1, j)); gv += Math.abs(at(noiseImg, i, j + 1) - at(noiseImg, i, j - 1)); }
  check(Math.abs(gu / gv - 1) < 0.15, `noise has the same detail across and down (gradient ratio ${f3(gu / gv)})`);
  const sf = await image({ g: { type: 'tex_gradient', params: { resolution: [64, 128], angle: 90, texture_size: 1 } }, n: { type: 'tex_normal_from_height', in: ['g'], params: { depth: 1, tileable: false } } }, 'n');
  // height rises 1 over the 2 m of height: a slope of 0.5
  const nyv = sf.layer('C')![(64 * 64 + 32) * 4 + 1] * 2 - 1;
  check(Math.abs(Math.abs(nyv) - Math.sin(Math.atan(0.5))) < 0.02, `height to normal reads the rows in metres too (tilt ${f3(Math.abs(nyv))}, ${f3(Math.sin(Math.atan(0.5)))})`);
  const txt = await image({ t: { type: 'tex_text', params: { resolution: [128, 128], text: 'I', text_height: 0.5, texture_size: 2 } } }, 't');
  let rows = 0;
  for (let j = 0; j < 128; j++) { let any = false; for (let i = 0; i < 128; i++) if (txt.layer('C')![j * 128 + i] > 0.5) any = true; if (any) rows++; }
  check(Math.abs(rows - 32) < 4, `text_height is metres: 0.5 m on a 2 m image is ${rows} of 128 rows (32)`);
}

// ---------------------------------------------------------------- generators still tile

section('tileable generators tile at any texture_size');
{
  const seam = (img: Image) => {
    const a = img.layer('C')!, w = img.width, h = img.height;
    let across = 0, within = 0, acrossV = 0;
    for (let j = 0; j < h; j++) { across += Math.abs(a[j * w] - a[j * w + w - 1]); for (let i = 0; i + 1 < w; i++) within += Math.abs(a[j * w + i] - a[j * w + i + 1]); }
    for (let i = 0; i < w; i++) acrossV += Math.abs(a[i] - a[(h - 1) * w + i]);
    within /= h * (w - 1); across /= h; acrossV /= w;
    return Math.max(across, acrossV) / Math.max(within, 1e-9);
  };
  for (const [label, node] of [
    ['noise (fbm, 3 octaves) with a feature of 0.37 m on 2.9 m', { type: 'tex_noise', params: { resolution: 192, feature: 0.37, octaves: 3, texture_size: 2.9 } }],
    ['simplex noise with a feature of 0.9 m on 2.9 m', { type: 'tex_noise', params: { resolution: 192, noise: 'simplex', feature: 0.9, texture_size: 2.9 } }],
    ['worley noise with a feature of 0.45 m on 5 m', { type: 'tex_noise', params: { resolution: 192, noise: 'worley', feature: 0.45, texture_size: 5 } }],
    ['cells of 0.33 m on 2.9 m', { type: 'tex_cells', params: { resolution: 192, cell: 0.33, output: 'distance', texture_size: 2.9 } }],
    ['grunge with a feature of 0.6 m on 3 m', { type: 'tex_grunge', params: { resolution: 192, feature: 0.6, texture_size: 3 } }],
    ['scratches of 0.4 to 1.4 m on 3 m', { type: 'tex_scratches', params: { resolution: 192, count: 40, stroke_length: [0.4, 1.4], stroke_width: 0.01, texture_size: 3 } }],
  ] as [string, NodeSpec][]) {
    const img = await image({ g: node }, 'g');
    check(img.size === node.params!.texture_size && seam(img) < 1.6, `${label}: seam jump over neighbour jump ${f3(seam(img))} (under 1.6), the image covers ${img.size} m`);
  }
  const a = await image({ g: { type: 'tex_noise', params: { resolution: 64, feature: 0.3, texture_size: 1, tileable: true } } }, 'g');
  const b = await image({ g: { type: 'tex_noise', params: { resolution: 64, feature: 1 / 3, texture_size: 1, tileable: true } } }, 'g');
  check(same(a.layer('C')!, b.layer('C')!), 'a feature of 0.3 m on 1 m is the nearest whole number of cells: the same image as 1/3 m (3 cells)');
  const w1 = await cookAll({ g: { type: 'tex_noise', params: { resolution: 32, feature: 0.7, texture_size: 1, tileable: true } } }, 'g');
  check(w1.warnings.some((m) => /0\.7 m/.test(m) && /1 m/.test(m) && /whole number/.test(m)), `a tileable feature that rounds by more than 10 % says so: ${w1.warnings[0]?.slice(0, 140)}`);
  const w2 = await cookAll({ g: { type: 'tex_noise', params: { resolution: 32, feature: 3, texture_size: 1, tileable: true } } }, 'g');
  check(w2.warnings.some((m) => /1 across/.test(m)), 'a feature larger than the tile becomes one cell, and says so');
  const w3 = await cookAll({ g: { type: 'tex_noise', params: { resolution: 32, feature: 0.34, texture_size: 1, tileable: true } } }, 'g');
  check(!w3.warnings.length, 'a feature that rounds by less than 10 % says nothing');
  const w4 = await cookAll({ g: { type: 'tex_grunge', params: { resolution: 32, feature: 0.001, texture_size: 1 } } }, 'g');
  check(w4.warnings.some((m) => /256/.test(m)), `grunge says when it clamps the feature: ${w4.warnings[0]?.slice(0, 120)}`);
  const w5 = await cookAll({ g: { type: 'tex_cells', params: { resolution: 32, cell: 0.7, texture_size: 1 } } }, 'g');
  check(w5.warnings.some((m) => /whole number/.test(m)), 'cells say it too');
}

// ---------------------------------------------------------------- the old units

section('the old units give an error that names the new param');
{
  // every old name and alias of a param whose unit changed or that was renamed: [node, old param, value, what the error must name, a node to feed it]
  const cases: [string, string, any, RegExp, string?][] = [
    ['tex_noise', 'scale', 4, /feature/], ['tex_noise', 'frequency', 4, /feature/], ['tex_noise', 'freq', 4, /feature/], ['tex_noise', 'element_size', 6, /feature/], ['tex_noise', 'offset', [1, 0], /shift/],
    ['tex_cells', 'scale', 8, /cell/], ['tex_cells', 'frequency', 8, /cell/], ['tex_cells', 'freq', 8, /cell/], ['tex_cells', 'count', 8, /cell/],
    ['tex_grunge', 'scale', 4, /feature/], ['tex_grunge', 'frequency', 4, /feature/],
    ['tex_blur', 'radius', 4, /blur/, 'tex_noise'], ['tex_blur', 'size', 4, /blur/, 'tex_noise'], ['tex_blur', 'intensity', 4, /blur/, 'tex_noise'],
    ['tex_dilate', 'radius', 4, /distance/, 'tex_shape'],
    ['tex_edge_detect', 'width', 2, /grow/, 'tex_noise'],
    ['tex_shape', 'size', 0.8, /fill/], ['tex_shape', 'radius', 0.8, /fill/],
    ['tex_splatter', 'size', [0.1, 0.2], /blob_radius/], ['tex_splatter', 'radius', [0.1, 0.2], /blob_radius/],
    ['tex_text', 'size', 0.2, /text_height/], ['tex_text', 'height', 0.2, /text_height/], ['tex_text', 'font_size', 0.2, /text_height/],
    ['tex_scratches', 'length', [0.1, 0.2], /stroke_length/], ['tex_scratches', 'width', 0.01, /stroke_width/],
    ['tex_gradient', 'radius', 0.5, /reach/],
    ['tex_warp', 'intensity', 0.02, /distance/, 'tex_noise'], ['tex_warp', 'amount', 0.02, /distance/, 'tex_noise'], ['tex_warp', 'strength', 0.02, /distance/, 'tex_noise'],
    ['tex_transform', 'offset', [0.5, 0], /shift/, 'tex_noise'], ['tex_transform', 'translate', [0.5, 0], /shift/, 'tex_noise'], ['tex_transform', 't', [0.5, 0], /shift/, 'tex_noise'],
    ['tex_height_to_ao', 'radius', 0.05, /reach/, 'tex_noise'], ['tex_height_to_ao', 'depth', 0.05, /relief_depth/, 'tex_noise'], ['tex_height_to_ao', 'height_depth', 0.05, /relief_depth/, 'tex_noise'],
    ['tex_to_heightfield', 'size', 20, /extent/, 'tex_noise'], ['trace_image', 'width', 1, /extent/, 'tex_shape'],
    ['tex_layers', 'size', 2, /texture_size/, 'tex_constant'],
  ];
  for (const gen of ['tex_noise', 'tex_pattern', 'tex_gradient', 'tex_constant', 'tex_cells', 'tex_scratches', 'tex_sdf_shape', 'tex_grunge', 'tex_tile_sampler', 'image_file']) cases.push([gen, 'size', 2, /texture_size/]);
  for (const f of ['tex_normal_from_height', 'tex_height_from_normal', 'tex_directional_blur', 'tex_slope_blur', 'tex_bevel', 'tex_distance', 'tex_sdf_from_mask', 'tex_sdf_op', 'tex_sdf_to_mask', 'tex_ao', 'tex_curvature', 'tex_flood_fill', 'tex_edge_detect', 'tex_height_to_ao'])
    for (const k of ['size', 'texture_size', 'world_size', 'tile_size']) cases.push([f, k, 2, /texture_size/, 'tex_noise']);
  const bad: string[] = [];
  for (const [type, param, value, re, from] of cases) {
    const nodes: Nodes = from ? { a: { type: from, params: { resolution: 16 } }, t: { type, in: type === 'tex_warp' ? ['a', 'a'] : ['a'], params: { [param]: value } } } : { t: { type, params: { [param]: value } } };
    const e = await err(nodes, 't');
    const head = e.split('valid params')[0].split('Valid params')[0];
    if (!/unknown param/.test(head) || !re.test(head)) bad.push(`${type} ${param}: ${e.slice(0, 100) || 'cooked'}`);
  }
  check(!bad.length, `${cases.length} old names and aliases fail with the new name in the message${bad.length ? ': ' + bad.slice(0, 4).join(' | ') : ''}`);
  const e = await err({ t: { type: 'tex_noise', params: { scale: 4 } } }, 't');
  check(/texture_size \/ feature/.test(e) && /0\.25/.test(e), `the message says how to convert (${e.slice(0, 160)})`);
  const t = await err({ t: { type: 'tex_text', params: { size: 0.2 } } }, 't');
  check(/size × texture_size × image height \/ image width/.test(t), 'tex_text says how to convert its size: ' + t.slice(0, 120));
  // a name that stays means what it meant: nothing that was a fraction or a pixel count keeps its name or an alias of it
  const stale = ['tex_warp.intensity', 'tex_height_to_ao.radius', 'tex_height_to_ao.depth', 'tex_transform.offset', 'tex_scratches.length', 'tex_scratches.width', 'tex_gradient.radius', 'tex_splatter.size', 'tex_splatter.radius', 'tex_text.size', 'tex_text.height', 'tex_noise.scale', 'tex_noise.element_size', 'tex_blur.radius', 'tex_dilate.radius', 'tex_edge_detect.width'];
  const kept = stale.filter((k) => { const [n, p] = k.split('.'); return !!getNodeDef(n)!.params[p] || Object.values(getNodeDef(n)!.params).some((q) => q.aliases?.includes(p)); });
  check(!kept.length, `no param whose unit changed keeps its old name or an alias of it${kept.length ? ': ' + kept.join(', ') : ''}`);
  const ce = await err({ n: { type: 'tex_noise', params: {} }, m: { type: 'tex_blur', in: ['n'], params: { blur: '=ch("n/scale")' } } }, 'm');
  check(/feature/.test(ce) && /ch\("n\/scale"\)/.test(ce), 'ch("node/old_param") names the new param: ' + ce.slice(0, 140));
}

// ---------------------------------------------------------------- the size follows the image

section('the size and the layers follow the image');
{
  const g = await cook({
    n: { type: 'tex_noise', params: { resolution: 64, texture_size: 3, feature: 0.5 } },
    b: { type: 'tex_blur', in: ['n'], params: { blur: 0.05 } },
    c: { type: 'tex_crop', in: ['b'], params: { origin: [0, 0], size: [32, 64], resolution: [16, 32] } },
  }, 'c');
  const c = findImage(g, 'c')!;
  check(Math.abs(c.size - 1.5) < 1e-9, `a crop of half the width covers half the metres (${c.size} m of 3)`);
  check(findImage(await cook({ n: { type: 'tex_noise', params: { resolution: 64, texture_size: 3 } }, k: { type: 'tex_constant', in: ['n'], params: { value: 0.5 } } }, 'k'), 'k')!.size === 3, 'a constant sized from an image covers the same metres');
  const pk = await cookAll({ n: { type: 'tex_noise', params: { resolution: 64, texture_size: 3 } }, m: { type: 'tex_noise', params: { resolution: 64, texture_size: 1 } }, p: { type: 'tex_channel', in: ['n', 'm'], params: { name: 'orm' } } }, 'p');
  check(findImage(pk.geo, 'orm')!.size === 3 && pk.warnings.some((m) => /covers 1 m/.test(m) && /largest/.test(m)), `a packed image covers what its largest input does, and warns when another disagrees: ${pk.warnings[0]?.slice(0, 120)}`);
  const bl = await cookAll({ n: { type: 'tex_noise', params: { resolution: 64, texture_size: 3 } }, m: { type: 'tex_noise', params: { resolution: 64, texture_size: 1 } }, p: { type: 'tex_blend', in: ['n', 'm'], params: {} } }, 'p');
  check(bl.warnings.some((m) => /input 1/.test(m) && /keeps input 0's size/.test(m)), `tex_blend says which size wins when two inputs disagree: ${bl.warnings[0]?.slice(0, 140)}`);
  // json and the disk cache keep it
  const { geoToJSON, geoFromJSON } = await import('../src/io/json.ts');
  const j = geoFromJSON(JSON.parse(JSON.stringify(geoToJSON(g))));
  check(findImage(j, 'c')!.size === c.size, 'the size survives the json format');
  // (the disk cache keeps it: test/diskcache.ts round-trips an image that covers 0.37 m)
  // a heightfield made into an image covers its extent
  const hfNodes: Nodes = { hf: { type: 'heightfield', params: { size: [10, 10], resolution: 0.5 } }, t: { type: 'heightfield_to_tex', in: ['hf'] } };
  const field = heightfieldsOf(await cook(hfNodes, 'hf'))[0], hfImage = await image(hfNodes, 't');
  check(Math.abs(hfImage.size - field.width * field.cellSize) < 1e-9 && hfImage.size > 5, `a heightfield image covers the heightfield's width (${hfImage.size} m for ${field.width} samples of ${field.cellSize} m)`);
  const th = heightfieldsOf(await cook({ n: { type: 'tex_noise', params: { resolution: 33, texture_size: 3 } }, h: { type: 'tex_to_heightfield', in: ['n'] } }, 'h'))[0];
  check(Math.abs((th.width - 1) * th.cellSize - 3) < 1e-9, `tex_to_heightfield reads the image's size (${(th.width - 1) * th.cellSize} m)`);
  const tr = await cook({ s: { type: 'tex_shape', params: { resolution: [64, 32], shape: 'disc', falloff: 0, texture_size: 3 } }, t: { type: 'trace_image', in: ['s'], params: { channel: 'luminance' } } }, 't');
  const bb = tr.bbox();
  check(bb.max[0] - bb.min[0] > 1.5 && bb.max[0] - bb.min[0] <= 3, `trace_image reads the image's size (a disc ${f3(bb.max[0] - bb.min[0])} m wide on a 3 m image)`);
  // tex_pack: one island per item with its gutter, each item's texel size per texel
  const pkd = await cook({
    a: { type: 'tex_noise', params: { resolution: 32, texture_size: 0.5, name: 'a' } },
    b: { type: 'tex_noise', params: { resolution: 32, texture_size: 2, name: 'b' } },
    m: { type: 'merge', in: ['a', 'b'] },
    p: { type: 'tex_pack', in: ['m'], params: { resolution: 128, padding: 4, name: 'atl' } },
  }, 'p');
  const atl = findImage(pkd, 'atl_C')!;
  const ia = islandsOf(atl)!;
  check(ia.islands.length === 2 && Math.abs(Math.min(ia.islands[0].tu, ia.islands[1].tu) - 0.5 / 32) < 1e-9 && Math.abs(Math.max(ia.islands[0].tu, ia.islands[1].tu) - 2 / 32) < 1e-9 && ia.background > 0, `tex_pack writes an island and the texel size of each item (${(ia.islands[0].tu * 1000).toFixed(2)} and ${(ia.islands[1].tu * 1000).toFixed(2)} mm), background between them`);
  check(ia.islands.every((s) => s.x1 - s.x0 + 1 === 40 && s.y1 - s.y0 + 1 === 40), 'an item\'s island covers its pixels and its gutter');
  // tex_crop beyond the source belongs to no island
  const posSize = (await image(SCENE(64), 'pos')).size;
  const cr = await image({ ...SCENE(64), c: { type: 'tex_crop', in: ['pos'], params: { origin: [-8, -8], size: [80, 80], resolution: [80, 80] } } }, 'c');
  check(cr.layer('island')![0] === -1 && Math.abs(cr.size - (posSize * 80) / 64) < 1e-9, 'a crop beyond the source fills island with -1 (background) and keeps the share of the metres');
  // texture_to_material: the packed orm map keeps the size
  const tm = await cook({
    box: { type: 'box', params: {} }, uv: { type: 'uv_project', in: ['box'], params: { method: 'box' } },
    o: { type: 'tex_noise', params: { resolution: 16, texture_size: 2.5, name: 'occ' } },
    mt: { type: 'texture_to_material', in: ['uv', 'o'], params: { material: 'm', occlusion: 'occ' } },
  }, 'mt');
  check(findImage(tm, 'm_orm')?.size === 2.5, 'texture_to_material packs an orm map of the size of its inputs');
  // bakes: every one writes texel and island, with the same size function
  const bk = await cook({ ...SCENE(64), c: { type: 'bake_curvature', in: ['all'], params: { resolution: 64 } } }, 'c');
  const bc = findImage(bk, 'c')!;
  check(bc.layers.has('texel') && bc.layers.has('island') && Math.abs(bc.size - posSize) < 1e-9, 'bake_curvature writes texel and island and the same size as every bake');
  const ao = await image({ ...SCENE(64), a: { type: 'bake_ao', in: ['all'], params: { resolution: 64 } } }, 'a');
  check(ao.layers.has('texel') && ao.layers.has('island'), 'bake_ao writes them too');
  const sameArrays = await cook({ ...SCENE(64), a: { type: 'bake_ao', in: ['all'], params: { resolution: 64, padding: 4 } }, b: { type: 'bake_thickness', in: ['all'], params: { resolution: 64, padding: 4 } }, m: { type: 'merge', in: ['a', 'b'] } }, 'm');
  const ia2 = findImage(sameArrays, 'a')!, ib2 = findImage(sameArrays, 'b')!;
  check(ia2.layer('texel') === ib2.layer('texel') && ia2.layer('island') === ib2.layer('island'), 'two bakes of one mesh share one copy of the texel and island layers (no memory per bake)');
  // runScaled on an image without islands runs once at size / width, and with the metres down as well
  const flat = new Image(64, 32, 'x'); flat.size = 2;
  let calls = 0, seen = 0, seenV = 0;
  runScaled(flat, [{ data: new Float32Array(64 * 32), ch: 1 }], [1], true, (_p, r) => { calls++; seen = r.tu; seenV = r.tv; return [new Float32Array(r.w * r.h)]; });
  check(calls === 1 && Math.abs(seen - 2 / 64) < 1e-12 && seenV === seen, `an image without islands runs once at size / width (${seen} m, square texels)`);
}

// ---------------------------------------------------------------- tex_layers keeps the scale

section('tex_layers reads the base image\'s size and keeps texel and island');
{
  const bakeNodes = (r: number): Nodes => ({ ...SCENE(r), mat: { type: 'material', in: ['all'], params: { name: 'm1', base_color: '#808080' } }, base: { type: 'bake_material', in: ['mat'], params: { resolution: r } }, nz: { type: 'tex_noise', params: { resolution: r, feature: 0.4, texture_size: 3 } }, masks: { type: 'merge', in: ['nz'] },
    st: { type: 'tex_layers', in: ['base', 'masks'], params: { layers: [{ name: 'a', mask: 'nz', color: '#ff0000', height: 0.001 }], padding: 2 } } });
  const out = await cook(bakeNodes(64), 'st');
  const n = findImage(out, 'st_normal')!;
  check(n.layers.has('texel') && n.layers.has('island') && n.size > 0 && n.size !== 1, `the normal map keeps the texel and island layers and the size (${f3(n.size)} m)`);
  const flatBase = await cookAll({ b: { type: 'tex_constant', params: { resolution: 16, channels: 'rgba', color: '#808080', texture_size: 2 } }, n: { type: 'tex_noise', params: { resolution: 16 } }, m: { type: 'merge', in: ['n'] },
    st: { type: 'tex_layers', in: ['b', 'm'], params: { base_roughness: 0.5, base_metallic: 0, coverage: '', layers: [{ name: 'a', mask: 'n', height: 0.01 }] } } }, 'st');
  check(findImage(flatBase.geo, 'st_normal')!.size === 2, 'on a base without a texel layer the slope is read against the base image\'s size');
}

// ---------------------------------------------------------------- the worker pool changes no bit

section('the worker pool changes no bit');
{
  const g: Nodes = {
    ...SCENE(256),
    c: { type: 'tex_cells', params: { resolution: 256, cell: 0.31, texture_size: 2.5, output: 'crystal' } },
    gr: { type: 'tex_grunge', params: { resolution: 256, feature: 0.3, texture_size: 2.5 } },
    sc: { type: 'tex_scratches', params: { resolution: 256, count: 50, texture_size: 2.5 } },
    bl: { type: 'tex_blur', in: ['hard'], params: { blur: 0.03 } },
    wp: { type: 'tex_warp', in: ['bl', 'noise'], params: { mode: 'slope', distance: 0.02 } },
    nm: { type: 'tex_normal_from_height', in: ['wp'], params: { depth: 0.01 } },
    ff: { type: 'tex_flood_fill', in: ['hard'], params: { output: 'position' } },
  };
  for (const out of ['noise', 'c', 'gr', 'sc', 'nm', 'ff']) {
    const a = await image(g, out, out, serial), b = await image(g, out, out, pooled);
    check([...a.layers.keys()].every((k) => same(a.layer(k)!, b.layer(k)!)) && a.size === b.size, `${out}: workers 0 and 4 give the same bits in every layer`);
  }
}

console.log(`\ntexscale: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
