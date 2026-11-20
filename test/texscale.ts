// Texture nodes in metres. Every length a texture node takes is in metres, read against the metres its image covers
// (texture_size on a generator, carried by the image) or, on an atlas a bake wrote (layers "texel" and "island"), against
// the texel size of each island. Checks that the same filter on a 512 and a 2048 bake of one atlas gives the same image
// after resampling (blur, dilate, erode, warp, bevel, height to normal, noise, scratches), that on an atlas whose islands
// have different texel densities a filter has the same real size on each, that nothing reads across an island border,
// that tileable generators still tile at any size, that every old unit gives an error naming the new param, and that
// the worker pool changes no bit.
//   node test/texscale.ts
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { Geometry } from '../src/core/geometry.ts';
import { Image, findImage, resizeLayer } from '../src/core/image.ts';
import { heightfieldsOf } from '../src/core/heightfield.ts';
import { islandsOf, runScaled } from '../src/core/texscale.ts';
import { defineNode } from '../src/graph/registry.ts';
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

async function cook(nodes: Nodes, output: string, engine = serial): Promise<Geometry> {
  const r = await engine.cook({ nodes, output });
  if (!r.ok || !r.geo) throw new Error(`cook failed: ${r.errors.map((x) => `[${x.node}] ${x.message}`).join('; ')}`);
  return r.geo;
}
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
/** Left half = island 0 (T0 metres per texel), right half = island 1 (T1); `value(i, j, island)` fills C. */
function atlas(value: (i: number, j: number, island: number) => number, rgba = false): Image {
  const img = new Image(AW, AH, 'atlas');
  const C = new Float32Array(AW * AH * (rgba ? 4 : 1)), texel = new Float32Array(AW * AH * 4), island = new Float32Array(AW * AH), mask = new Float32Array(AW * AH).fill(1);
  for (let j = 0; j < AH; j++)
    for (let i = 0; i < AW; i++) {
      const k = j * AW + i, isl = i < AW / 2 ? 0 : 1, t = isl ? T1 : T0, v = value(i, j, isl);
      if (rgba) { C[k * 4] = C[k * 4 + 1] = C[k * 4 + 2] = v; C[k * 4 + 3] = v > 0 ? 1 : 0; } else C[k] = v;
      texel[k * 4] = texel[k * 4 + 1] = t; texel[k * 4 + 3] = 1;
      island[k] = isl;
    }
  img.set('C', C).set('texel', texel).set('island', island).set('mask', mask);
  img.size = 0.25;
  return img;
}
const CX = [AW / 4, (3 * AW) / 4], CY = AH / 2; // the centre of each island
/** Second moment (px) along u and the centroid of an island's part of a layer. */
function moments(a: Float32Array, isl: number, ch = 1, c = 0): { sigma: number; cx: number; sum: number; count: number } {
  let sum = 0, mx = 0, mxx = 0, count = 0;
  for (let j = 0; j < AH; j++)
    for (let i = isl * (AW / 2); i < (isl + 1) * (AW / 2); i++) {
      const v = a[(j * AW + i) * ch + c];
      if (v > 1e-4) count++;
      sum += v; mx += v * i; mxx += v * i * i;
    }
  const cx = mx / sum;
  return { sigma: Math.sqrt(Math.max(0, mxx / sum - cx * cx)), cx, sum, count };
}
const impulse = (i: number, j: number, isl: number) => (i === CX[isl] && j === CY ? 1 : 0);

section('islands of different texel sizes: a length in metres is the same on each');
{
  const a0 = atlas(impulse);
  check(a0.layer('island') && islandsOf(a0)!.islands.length === 2 && Math.abs(islandsOf(a0)!.islands[0].texel - T0) < 1e-9 && Math.abs(islandsOf(a0)!.islands[1].texel - T1) < 1e-9, 'the atlas reads as two islands, of 2 mm and 8 mm texels');
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
  // warp: a constant map of 1 moves a texel by the intensity, 0.02 m, which is 10 texels and 2.5
  sources.set('ones', atlas(() => 1));
  const w = await image({ ...src('impulse'), o: { type: '__texscale_source', params: { key: 'ones' } }, w: { type: 'tex_warp', in: ['s', 'o'], params: { mode: 'directional', intensity: 0.02, angle: 0, tileable: false } } }, 'w');
  const w0 = moments(w.layer('C')!, 0), w1 = moments(w.layer('C')!, 1);
  check(Math.abs((w0.cx - CX[0]) * T0 * 1000 - 20) < 2 && Math.abs((w1.cx - CX[1]) * T1 * 1000 - 20) < 4, `warp 0.02 m: the texel moves ${f3(Math.abs(w0.cx - CX[0]) * T0 * 1000)} mm on the fine island, ${f3(Math.abs(w1.cx - CX[1]) * T1 * 1000)} mm on the coarse`);
  // directional blur: a trail of 0.04 m behind a texel
  const db = await image({ ...src('impulse'), b: { type: 'tex_directional_blur', in: ['s'], params: { length: 0.04, angle: 0, symmetric: true, tileable: false } } }, 'b');
  // a line 40 mm long has a spread of 40 / sqrt(12) = 11.5 mm
  const d0 = moments(db.layer('C')!, 0).sigma * T0 * 1000, d1 = moments(db.layer('C')!, 1).sigma * T1 * 1000;
  check(Math.abs(d0 - 11.5) < 3.5 && Math.abs(d1 - 11.5) < 3.5, `directional blur 0.04 m spreads ${f3(d0)} mm on the fine island and ${f3(d1)} mm on the coarse (11.5 mm)`);
  // bevel: a plate of 0.06 m bevelled by 0.01 m: the ramp is 10 mm wide, 5 texels on the fine island and 1.25 on the coarse (read at the middle)
  const plate = (i: number, j: number, isl: number) => (Math.abs(i - CX[isl]) * (isl ? T1 : T0) <= 0.03 && Math.abs(j - CY) * (isl ? T1 : T0) <= 0.03 ? 1 : 0);
  sources.set('plate', atlas(plate));
  const bv = await image({ ...src('plate'), b: { type: 'tex_bevel', in: ['s'], params: { distance: 0.01, profile: 'linear', tileable: false } } }, 'b');
  const ramp = (isl: number) => { let s = 0; for (let i = isl * 128; i < isl * 128 + 128; i++) s += bv.layer('C')![CY * AW + i]; return s * (isl ? T1 : T0); };
  // the sum along the middle row of a plate 0.06 wide with a linear 0.01 ramp at each end: 0.06 - 2 × 0.005
  check(Math.abs(ramp(0) - 0.05) < 0.003 && Math.abs(ramp(1) - 0.05) < 0.006, `bevel 0.01 m: the plate's row sums to ${f3(ramp(0) * 1000)} mm and ${f3(ramp(1) * 1000)} mm (50 mm)`);
  // height to normal: a slope of 5 mm per 100 mm on both islands gives the same tilt
  const slope = (i: number, j: number, isl: number) => 0.5 + (i - CX[isl]) * (isl ? T1 : T0) * 5;
  sources.set('slope', atlas(slope));
  const nm = await image({ ...src('slope'), n: { type: 'tex_normal_from_height', in: ['s'], params: { depth: 0.01, tileable: false } } }, 'n');
  const red = (i: number) => nm.layer('C')![(CY * AW + i) * 4];
  check(Math.abs(red(CX[0]) - red(CX[1])) < 1e-4 && red(CX[0]) < 0.5, `height to normal: the same tilt on both islands (red ${red(CX[0]).toFixed(5)} and ${red(CX[1]).toFixed(5)})`);
}

// ---------------------------------------------------------------- an atlas from a bake: 512 against 2048

const bakeAtlas = (r: number, extra: Nodes = {}, out = 'base'): Nodes => ({
  qa: { type: 'grid', params: { size: [1, 1], divisions: [2, 1] } },
  qb: { type: 'grid', params: { size: [1, 1], divisions: [2, 1] } },
  ua: { type: 'uv_project', in: ['qa'], params: { method: 'planar', axis: 'y', scale: 4, offset: [0.25, 0.5] } },
  ub: { type: 'uv_project', in: ['qb'], params: { method: 'planar', axis: 'y', scale: 2, offset: [0.75, 0.5] } },
  both: { type: 'merge', in: ['ua', 'ub'] },
  m1: { type: 'material', in: ['both'], params: { name: 'a', base_color: '#ff0000', group: '@P.x<0' } },
  m2: { type: 'material', in: ['m1'], params: { name: 'b', base_color: '#00ff00', group: '@P.x>0' } },
  base: { type: 'bake_material', in: ['m2'], params: { resolution: r, padding: r / 64, masks: 'materials' } },
  ...extra,
});
{
  section('the same filter on a 512 and a 2048 bake of one atlas');
  const lo = await image(bakeAtlas(512), 'base'), hi = await image(bakeAtlas(2048), 'base');
  const il = islandsOf(lo)!.islands, ih = islandsOf(hi)!.islands;
  check(il.length === 2 && ih.length === 2 && Math.abs(il[0].texel / il[1].texel - 2) < 0.05 && Math.abs(ih[0].texel * 4 - il[0].texel) / il[0].texel < 0.01, `the bake has two islands of texel ${(il[0].texel * 1000).toFixed(2)} and ${(il[1].texel * 1000).toFixed(2)} mm at 512, ${(ih[0].texel * 1000).toFixed(2)} and ${(ih[1].texel * 1000).toFixed(2)} mm at 2048`);
  check(Math.abs(lo.size - 4 * il[0].texel * 128 / 1) < 4 && lo.size === hi.size, `the bake's size is ${f3(lo.size)} m at both resolutions`);
  // covered texels well inside the islands, to compare where the resampled and the direct result mean the same
  const cov = (img: Image, w: number) => (i: number) => { const m = img.layer('mask')!; return m[i] === 1; };
  const covLo = cov(lo, 512);
  const compare = async (label: string, nodes: (r: number) => Nodes, layer: string, tol: number, ch = 1, out = 'f') => {
    const a = await image({ ...bakeAtlas(512), ...nodes(512) }, out), b = await image({ ...bakeAtlas(2048), ...nodes(2048) }, out);
    const small = resizeLayer(b.layer(layer)!, ch, 2048, 2048, 512, 512, false);
    const d = meanDiff(a.layer(layer)!, small, ch, covLo);
    check(d < tol, `${label}: 512 and 2048 differ by ${d.toFixed(4)} on average (at most ${tol})`);
    return d;
  };
  await compare('blur 0.03 m', () => ({ f: { type: 'tex_blur', in: ['base'], params: { layer: 'mat_a', blur: 0.03 } } }), 'mat_a', 0.01);
  await compare('dilate 0.02 m', () => ({ f: { type: 'tex_dilate', in: ['base', 'base'], params: { layer: 'mat_a', mask_layer: 'mat_a', distance: 0.02, } } }), 'mat_a', 0.01);
  await compare('erode: sdf offset -0.02 m', () => ({
    sd: { type: 'tex_sdf_from_mask', in: ['base'], params: { layer: 'mat_a' } },
    op: { type: 'tex_sdf_op', in: ['sd'], params: { mode: 'offset', amount: -0.02 } },
    f: { type: 'tex_sdf_to_mask', in: ['op'], params: { mode: 'fill' } },
  }), 'mat_a', 0.01);
  await compare('bevel 0.03 m', () => ({ f: { type: 'tex_bevel', in: ['base'], params: { layer: 'mat_a', distance: 0.03, profile: 'smooth' } } }), 'mat_a', 0.01);
  await compare('height to normal (blur 0.03 m, depth 0.01 m)', () => ({
    bl: { type: 'tex_blur', in: ['base'], params: { layer: 'mat_a', blur: 0.03 } },
    f: { type: 'tex_normal_from_height', in: ['bl'], params: { layer: 'mat_a', depth: 0.02 } },
  }), 'mat_a', 0.005, 4);
  await compare('warp 0.02 m by noise', (r) => ({
    n: { type: 'tex_noise', params: { resolution: r, feature: 0.5, octaves: 2, texture_size: 2 } },
    f: { type: 'tex_warp', in: ['base', 'n'], params: { layer: 'mat_a', mode: 'directional', intensity: 0.02, angle: 30 } },
  }), 'mat_a', 0.01);
  await compare('directional blur 0.04 m', () => ({ f: { type: 'tex_directional_blur', in: ['base'], params: { layer: 'mat_a', length: 0.04, angle: 20 } } }), 'mat_a', 0.01);
  await compare('slope blur 0.03 m', (r) => ({
    n: { type: 'tex_noise', params: { resolution: r, feature: 0.5, octaves: 2, texture_size: 2 } },
    f: { type: 'tex_slope_blur', in: ['base', 'n'], params: { layer: 'mat_a', distance: 0.03, mode: 'blur' } },
  }), 'mat_a', 0.02);
  await compare('distance: grow 0.03 m', () => ({ f: { type: 'tex_distance', in: ['base'], params: { layer: 'mat_a', distance: 0.03, mode: 'grow' } } }), 'mat_a', 0.01);

  // generators: the same image at two resolutions after resampling (and, on a tile, a seam-free repeat)
  const gen = async (label: string, node: (r: number) => NodeSpec, tol: number) => {
    const a = await image({ g: node(512) }, 'g'), b = await image({ g: node(2048) }, 'g');
    const d = meanDiff(a.layer('C')!, resizeLayer(b.layer('C')!, 1, 2048, 2048, 512, 512, true), 1);
    check(d < tol && a.size === b.size, `${label}: 512 and 2048 differ by ${d.toFixed(4)} on average (at most ${tol}); the image covers ${a.size} m at both`);
  };
  await gen('noise, feature 0.4 m on 3.2 m', (r) => ({ type: 'tex_noise', params: { resolution: r, feature: 0.4, octaves: 4, texture_size: 3.2 } }), 0.02);
  await gen('scratches, 0.5 to 1.2 m long, 4 mm wide on 3.2 m', (r) => ({ type: 'tex_scratches', params: { resolution: r, count: 60, length: [0.5, 1.2], width: 0.004, texture_size: 3.2 } }), 0.01);
  await gen('splatter, radius 0.1 to 0.3 m on 3.2 m', (r) => ({ type: 'tex_splatter', params: { resolution: r, count: 20, radius: [0.1, 0.3], texture_size: 3.2 } }), 0.01);
  await gen('cells, 0.4 m on 3.2 m', (r) => ({ type: 'tex_cells', params: { resolution: r, cell: 0.4, texture_size: 3.2 } }), 0.02);
  await gen('grunge, feature 0.4 m on 3.2 m', (r) => ({ type: 'tex_grunge', params: { resolution: r, feature: 0.4, texture_size: 3.2 } }), 0.03);
}

// ---------------------------------------------------------------- nothing is read across an island border

section('no filter reads across an island border');
{
  // island A is all 1 (white material) and island B all 0 (black): with anything leaking across, one of the two changes
  const A = (r: number): Nodes => ({
    qa: { type: 'grid', params: { size: [1, 1], divisions: [1, 1] } },
    qb: { type: 'grid', params: { size: [1, 1], divisions: [1, 1] } },
    ua: { type: 'uv_project', in: ['qa'], params: { method: 'planar', axis: 'y', scale: 4, offset: [0.25, 0.5] } },
    ub: { type: 'uv_project', in: ['qb'], params: { method: 'planar', axis: 'y', scale: 2, offset: [0.75, 0.5] } },
    ma: { type: 'material', in: ['ua'], params: { name: 'a', base_color: '#ffffff' } },
    mb: { type: 'material', in: ['ub'], params: { name: 'b', base_color: '#000000' } },
    both: { type: 'merge', in: ['ma', 'mb'] },
    base: { type: 'bake_material', in: ['both'], params: { resolution: r, padding: 4, masks: 'materials' } },
  });
  const r = 256;
  const probe = async (label: string, extra: Nodes, node: NodeSpec, wantA: number, wantB: number, tol = 1e-4, layer = 'mat_a') => {
    const img = await image({ ...A(r), ...extra, f: node }, 'f');
    const island = img.layer('island')!, v = img.layer(layer)!, ch = img.channels(layer);
    // the island of the texel that is white in the source
    const idA = island[(r / 2) * r + Math.round(r * 0.25)], idB = island[(r / 2) * r + Math.round(r * 0.75)];
    let worstA = 0, worstB = 0;
    for (let k = 0; k < r * r; k++) {
      if (island[k] === idA) worstA = Math.max(worstA, Math.abs(v[k * ch] - wantA));
      else if (island[k] === idB) worstB = Math.max(worstB, Math.abs(v[k * ch] - wantB));
    }
    check(idA !== idB && worstA <= tol && worstB <= tol, `${label}: island A stays ${wantA} (off by ${worstA.toExponential(1)}), island B stays ${wantB} (off by ${worstB.toExponential(1)})`);
  };
  const noise = { n: { type: 'tex_noise', params: { resolution: r, feature: 0.3, texture_size: 2 } } };
  await probe('blur 0.5 m', {}, { type: 'tex_blur', in: ['base'], params: { layer: 'mat_a', blur: 0.5 } }, 1, 0);
  await probe('directional blur 0.8 m', {}, { type: 'tex_directional_blur', in: ['base'], params: { layer: 'mat_a', length: 0.8, angle: 0 } }, 1, 0);
  await probe('slope blur 0.5 m', noise, { type: 'tex_slope_blur', in: ['base', 'n'], params: { layer: 'mat_a', distance: 0.5, mode: 'blur' } }, 1, 0);
  await probe('warp 0.4 m', { c: { type: 'tex_constant', in: ['base'], params: { value: 1 } } }, { type: 'tex_warp', in: ['base', 'c'], params: { layer: 'mat_a', mode: 'directional', intensity: 0.4, angle: 0 } }, 1, 0);
  await probe('dilate 1 m (valid where mat_a > 0)', {}, { type: 'tex_dilate', in: ['base', 'base'], params: { layer: 'mat_a', mask_layer: 'mat_a', distance: 1 } }, 1, 0);
  await probe('distance, grow 0.5 m', {}, { type: 'tex_distance', in: ['base'], params: { layer: 'mat_a', distance: 0.5, mode: 'grow' } }, 1, 0);
  await probe('bevel outward 0.5 m', {}, { type: 'tex_bevel', in: ['base'], params: { layer: 'mat_a', distance: -0.5 } }, 1, 0);
  const sd = await image({ ...A(r), f: { type: 'tex_sdf_from_mask', in: ['base'], params: { layer: 'mat_a' } } }, 'f');
  const isl = sd.layer('island')!, d = sd.layer('mat_a')!;
  let negA = true, posB = true;
  for (let k = 0; k < r * r; k++) {
    if (isl[k] === isl[(r / 2) * r + Math.round(r * 0.25)] && !(d[k] < 0)) negA = false;
    if (isl[k] === isl[(r / 2) * r + Math.round(r * 0.75)] && !(d[k] > 0)) posB = false;
  }
  check(negA && posB, 'sdf from mask: every texel of island A is inside, of island B outside (no outline at the border)');
}

// ---------------------------------------------------------------- generators still tile

section('tileable generators tile at any texture_size');
{
  const seam = (img: Image) => {
    const a = img.layer('C')!, w = img.width, h = img.height;
    let across = 0, within = 0;
    for (let j = 0; j < h; j++) { across += Math.abs(a[j * w] - a[j * w + w - 1]); for (let i = 0; i + 1 < w; i++) within += Math.abs(a[j * w + i] - a[j * w + i + 1]); }
    let acrossV = 0;
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
    ['scratches of 0.4 to 1.4 m on 3 m', { type: 'tex_scratches', params: { resolution: 192, count: 40, length: [0.4, 1.4], width: 0.01, texture_size: 3 } }],
  ] as [string, NodeSpec][]) {
    const img = await image({ g: node }, 'g');
    check(img.size === node.params!.texture_size && seam(img) < 2, `${label}: seam jump over neighbour jump ${f3(seam(img))}, the image covers ${img.size} m`);
  }
  // a feature that does not divide the image is rounded to whole cells, so a tile can be repeated
  const a = await image({ g: { type: 'tex_noise', params: { resolution: 64, feature: 0.3, texture_size: 1, tileable: true } } }, 'g');
  const b = await image({ g: { type: 'tex_noise', params: { resolution: 64, feature: 1 / 3, texture_size: 1, tileable: true } } }, 'g');
  check(same(a.layer('C')!, b.layer('C')!), 'a feature of 0.3 m on 1 m is the nearest whole number of cells: the same image as 1/3 m (3 cells)');
}

// ---------------------------------------------------------------- the old units

section('the old units give an error that names the new param');
{
  const cases: [string, Record<string, any>, RegExp, string?][] = [
    ['tex_noise', { scale: 4 }, /feature/], ['tex_noise', { frequency: 4 }, /feature/], ['tex_noise', { offset: [1, 0] }, /shift/], ['tex_noise', { size: 2 }, /texture_size/],
    ['tex_cells', { scale: 8 }, /cell/], ['tex_cells', { count: 8 }, /cell/],
    ['tex_grunge', { scale: 4 }, /feature/],
    ['tex_blur', { radius: 4 }, /blur/, 'tex_noise'], ['tex_blur', { size: 4 }, /blur/, 'tex_noise'],
    ['tex_dilate', { radius: 4 }, /distance/, 'tex_shape'],
    ['tex_edge_detect', { width: 2 }, /grow/, 'tex_noise'],
    ['tex_shape', { size: 0.8 }, /fill/], ['tex_splatter', { size: [0.1, 0.2] }, /radius/], ['tex_text', { size: 0.2 }, /height/],
    ['tex_scratches', { size: 2 }, /texture_size/], ['tex_pattern', { size: 2 }, /texture_size/], ['tex_gradient', { size: 2 }, /texture_size/], ['tex_sdf_shape', { size: 2 }, /texture_size/],
    ['image_file', { size: 2 }, /texture_size/],
    ['tex_normal_from_height', { size: 2 }, /texture_size/, 'tex_noise'], ['tex_directional_blur', { size: 2 }, /texture_size/, 'tex_noise'], ['tex_slope_blur', { size: 2 }, /texture_size/, 'tex_noise'],
    ['tex_bevel', { size: 2 }, /texture_size/, 'tex_noise'], ['tex_distance', { size: 2 }, /texture_size/, 'tex_noise'], ['tex_sdf_from_mask', { size: 2 }, /texture_size/, 'tex_noise'],
    ['tex_ao', { size: 2 }, /texture_size/, 'tex_noise'], ['tex_curvature', { size: 2 }, /texture_size/, 'tex_noise'], ['tex_flood_fill', { size: 2 }, /texture_size/, 'tex_noise'],
  ];
  let bad: string[] = [];
  for (const [type, params, re, from] of cases) {
    const nodes: Nodes = from ? { a: { type: from, params: { resolution: 16 } }, t: { type, in: ['a'], params } } : { t: { type, params } };
    const e = await err(nodes, 't');
    if (!/unknown param/.test(e) || !re.test(e.split('Valid params')[0].split('valid params')[0])) bad.push(`${type} ${Object.keys(params)[0]}: ${e.slice(0, 120) || 'cooked'}`);
  }
  check(!bad.length, `${cases.length} old params fail with their new name in the message${bad.length ? ': ' + bad.join(' | ') : ''}`);
  const e = await err({ t: { type: 'tex_noise', params: { scale: 4 } } }, 't');
  check(/texture_size \/ feature/.test(e) && /0\.25/.test(e), `the message says how to convert (${e.slice(0, 160)})`);
}

// ---------------------------------------------------------------- the worker pool changes no bit

section('the worker pool changes no bit');
{
  const g: Nodes = {
    ...bakeAtlas(256),
    n: { type: 'tex_noise', params: { resolution: 256, feature: 0.21, texture_size: 2.5, octaves: 4 } },
    c: { type: 'tex_cells', params: { resolution: 256, cell: 0.31, texture_size: 2.5, output: 'crystal' } },
    gr: { type: 'tex_grunge', params: { resolution: 256, feature: 0.3, texture_size: 2.5 } },
    sc: { type: 'tex_scratches', params: { resolution: 256, count: 50, texture_size: 2.5 } },
    bl: { type: 'tex_blur', in: ['base'], params: { layer: 'mat_a', blur: 0.03 } },
    wp: { type: 'tex_warp', in: ['bl', 'n'], params: { layer: 'mat_a', mode: 'slope', intensity: 0.02 } },
    nm: { type: 'tex_normal_from_height', in: ['wp'], params: { layer: 'mat_a', depth: 0.01 } },
  };
  for (const out of ['n', 'c', 'gr', 'sc', 'nm']) {
    const a = await image(g, out, out, serial), b = await image(g, out, out, pooled);
    check([...a.layers.keys()].every((k) => same(a.layer(k)!, b.layer(k)!)) && a.size === b.size, `${out}: workers 0 and 4 give the same bits in every layer`);
  }
}

// ---------------------------------------------------------------- an image keeps its size

section('the size follows the image');
{
  const g = await cook({
    n: { type: 'tex_noise', params: { resolution: 64, texture_size: 3, feature: 0.5 } },
    b: { type: 'tex_blur', in: ['n'], params: { blur: 0.05 } },
    c: { type: 'tex_crop', in: ['b'], params: { origin: [0, 0], size: [32, 64], resolution: [16, 32] } },
    k: { type: 'tex_constant', in: ['c'], params: { value: 0.5 } },
    p: { type: 'tex_channel', in: ['n', 'b'], params: { name: 'orm' } },
  }, 'c');
  const c = findImage(g, 'c')!;
  check(Math.abs(c.size - 1.5) < 1e-9, `a crop of half the width covers half the metres (${c.size} m of 3)`);
  check(findImage(await cook({ n: { type: 'tex_noise', params: { resolution: 64, texture_size: 3 } }, k: { type: 'tex_constant', in: ['n'], params: { value: 0.5 } } }, 'k'), 'k')!.size === 3, 'a constant sized from an image covers the same metres');
  check(findImage(await cook({ n: { type: 'tex_noise', params: { resolution: 64, texture_size: 3 } }, p: { type: 'tex_channel', in: ['n', 'n'], params: { name: 'orm' } } }, 'p'), 'orm')!.size === 3, 'a packed channel image covers what its input does');
  // JSON and the disk cache keep it
  const { geoToJSON, geoFromJSON } = await import('../src/io/json.ts');
  const j = geoFromJSON(JSON.parse(JSON.stringify(geoToJSON(g))));
  check(findImage(j, 'c')!.size === c.size, 'the size survives the json format');
  // a heightfield made into an image covers its extent
  const hfNodes: Nodes = { hf: { type: 'heightfield', params: { size: [10, 10], resolution: 0.5 } }, t: { type: 'heightfield_to_tex', in: ['hf'] } };
  const field = heightfieldsOf(await cook(hfNodes, 'hf'))[0], hfImage = await image(hfNodes, 't');
  check(Math.abs(hfImage.size - field.width * field.cellSize) < 1e-9 && hfImage.size > 5, `a heightfield image covers the heightfield's width (${hfImage.size} m for ${field.width} samples of ${field.cellSize} m)`);
  // runScaled on an image without islands runs once at size / width
  const flat = new Image(64, 32, 'x'); flat.size = 2;
  let calls = 0, seen = 0;
  runScaled(flat, [{ data: new Float32Array(64 * 32), ch: 1 }], [1], true, (_p, w, h, texel) => { calls++; seen = texel; return [new Float32Array(w * h)]; });
  check(calls === 1 && Math.abs(seen - 2 / 64) < 1e-12, `an image without islands runs once at size / width (${seen} m)`);
}

console.log(`\ntexscale: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
