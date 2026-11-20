// The material kind, bake_material, tex_layers and the shared per-sample expression compile. Checks what each promises:
// the kind field kept through the material table (and absent when not said), bake_material's colours, roughness,
// metallic and 0/1 masks per material and per kind, its maps and its stats; tex_layers' colour modes, ramps, heights, the
// normal map that does not depend on the resolution, composition on covered texels only (nothing outside the islands
// survives padding), expressions that run the same with and without the worker pool, every refusal with its hint, the
// size warning for mask images; and tex_channel packing to the largest input.
//   node test/layers.ts
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import type { Geometry } from '../src/core/geometry.ts';
import { Image, findImage, resizeLayer } from '../src/core/image.ts';
import { MATERIAL_KINDS, normalizeMaterial, readMaterials } from '../src/core/materials.ts';
import { medianTexelSize } from '../src/core/texelsize.ts';
import { HALF_STORED, f16round, toHalf } from '../src/core/half.ts';
import type { GraphSpec, NodeSpec } from '../src/graph/types.ts';

let fail = 0, pass = 0;
const check = (ok: unknown, msg: string) => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
};
const section = (s: string) => console.log(`\n== ${s}`);
const near = (a: number, b: number, tol = 1e-4) => Math.abs(a - b) <= tol;

type Nodes = Record<string, NodeSpec>;
const serial = new Engine(createNodeHost({ workers: 0 }));
await serial.init();
const pooled = new Engine(createNodeHost({ workers: 4, pool: { minElements: 1 } }));
await pooled.init();

interface Cooked { geo: Geometry; stats: Record<string, number>; warnings: string[] }
async function cook(nodes: Nodes, output: string, engine = serial, vars?: Record<string, any>): Promise<Cooked> {
  const graph: GraphSpec = { nodes, output, ...(vars ? { vars } : {}) };
  const r = await engine.cook(graph);
  if (!r.ok || !r.geo) throw new Error(`cook failed: ${r.errors.map((x) => `[${x.node}] ${x.message}`).join('; ')}`);
  return { geo: r.geo, stats: (r.results.get(r.target) as any).stats ?? {}, warnings: r.warnings.map((w) => w.message) };
}
/** The text of the error a cook ends with (message and hint), '' when it cooks. */
async function err(nodes: Nodes, output: string): Promise<string> {
  const r = await serial.cook({ nodes, output });
  return r.ok ? '' : r.errors.map((e) => e.message + (e.hint ? ` (${e.hint})` : '')).join('; ');
}
const img = (c: Cooked, name: string): Image => {
  const i = findImage(c.geo, name);
  if (!i) throw new Error(`no image "${name}"`);
  return i;
};
/** Pixel (i, j) of a layer: its channels. */
const px = (im: Image, layer: string, i: number, j: number): number[] => {
  const ch = im.channels(layer), a = im.layer(layer)!, o = (j * im.width + i) * ch;
  return Array.from(a.subarray(o, o + ch));
};
const same = (a: Float32Array, b: Float32Array) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

// ---------------------------------------------------------------- the model: a 2 × 2 m grid, two materials, uv over the middle quarter

const SCENE: Nodes = {
  quad: { type: 'grid', params: { size: [2, 2], divisions: [2, 2] } },
  m1: { type: 'material', in: ['quad'], params: { name: 'paint', base_color: '#ff0000', roughness: 0.7, kind: 'painted_metal', group: '@P.x<0' } },
  m2: { type: 'material', in: ['m1'], params: { name: 'brushed', base_color: '#00ff00', metallic: 1, roughness: 0.3, group: '@P.x>0' } },
  uv: { type: 'uv_project', in: ['m2'], params: { method: 'planar', axis: 'y', scale: 4, offset: [0.5, 0.5] } },
};
const RES = 64;
const bakeNodes = (params: Record<string, any> = {}): Nodes => ({ ...SCENE, base: { type: 'bake_material', in: ['uv'], params: { resolution: RES, padding: 2, ...params } } });

section('material kind');
{
  check(normalizeMaterial({ kind: ' painted_metal ' }).kind === 'painted_metal', 'normalizeMaterial keeps a kind, trimmed');
  check(!('kind' in normalizeMaterial({})) && !('kind' in normalizeMaterial({ kind: '' })) && !('kind' in normalizeMaterial({ kind: 3 })), 'an absent, empty or non-text kind is not written, so tables and fingerprints stay the same');
  check(JSON.stringify(normalizeMaterial({ baseColor: '#ff0000' as any })) === JSON.stringify({ baseColor: [0.8, 0.8, 0.8], metallic: 0, roughness: 0.8, emissive: [0, 0, 0], alpha: 1, doubleSided: false, unlit: false }), 'a material without a kind serialises as it always did');
  check(MATERIAL_KINDS.length === 16 && MATERIAL_KINDS.includes('keep'), 'sixteen kinds, keep among them');
  const g = (await cook(SCENE, 'uv')).geo;
  const t = readMaterials(g);
  check(t.paint.kind === 'painted_metal' && !('kind' in t.brushed), 'the material node writes its kind param into the table, and nothing when it is empty');
  const copy = await cook({ ...SCENE, tab: { type: 'material', in: ['quad', 'm1'], params: { from: 'paint', name: 'copy' } } }, 'tab');
  check(readMaterials(copy.geo).copy.kind === 'painted_metal', 'a material copied from input 1 keeps its kind');
  const over = await cook({ ...SCENE, tab: { type: 'material', in: ['quad', 'm1'], params: { from: 'paint', name: 'copy', kind: 'rubber' } } }, 'tab');
  check(readMaterials(over.geo).copy.kind === 'rubber', 'a kind on the material node applies to a copied material too');
  check(/kind/.test(await err({ m: { type: 'material', params: { kind: 'galvanized' } } }, 'm')), 'a kind outside the list is refused by the material node');
}

section('bake_material');
{
  const c = await cook(bakeNodes(), 'base');
  const b = img(c, 'base');
  check(eq(Array.from(b.layers.keys()), ['C', 'roughness', 'metallic', 'texel', 'island', 'mat_paint', 'mat_brushed', 'kind_painted_metal', 'mask']), `layers C, roughness, metallic, texel, island, mat_paint, mat_brushed, kind_painted_metal, mask (${[...b.layers.keys()].join(', ')})`);
  // the grid covers x, z in [-1, 1]; uv = position / 4 + 0.5, so texels 16..47 are covered; x < 0 is the left half
  const left = px(b, 'C', 20, 32), right = px(b, 'C', 43, 32);
  check(near(left[0], 1) && near(left[1], 0) && near(left[3], 1), 'the paint half bakes its base colour');
  check(near(right[0], 0) && near(right[1], 1), 'the brushed half bakes its base colour');
  check(near(px(b, 'roughness', 20, 32)[0], 0.7) && near(px(b, 'roughness', 43, 32)[0], 0.3), 'roughness bakes per material');
  check(near(px(b, 'metallic', 20, 32)[0], 0) && near(px(b, 'metallic', 43, 32)[0], 1), 'metallic bakes per material');
  check(px(b, 'mat_paint', 20, 32)[0] === 1 && px(b, 'mat_paint', 43, 32)[0] === 0 && px(b, 'mat_brushed', 43, 32)[0] === 1, 'a 0/1 mask per material');
  check(px(b, 'kind_painted_metal', 20, 32)[0] === 1 && px(b, 'kind_painted_metal', 43, 32)[0] === 0, 'a 0/1 mask per kind present; a material without a kind has none');
  const cov = b.layer('mask')!, mp = b.layer('mat_paint')!, ms = b.layer('mat_brushed')!;
  let ok = true, covered = 0;
  for (let i = 0; i < cov.length; i++) if (cov[i] > 0) { covered++; if (mp[i] + ms[i] !== 1) ok = false; }
  check(ok && covered === 34 * 34, `every covered texel belongs to exactly one material (${covered} covered)`);
  check(near(c.stats.size, 4) && near(c.stats.texel_mm, 4 / RES * 1000), `stat size is the metres the image width covers (${c.stats.size} m, ${c.stats.texel_mm} mm per texel)`);
  const hi = await cook(bakeNodes({ resolution: 128 }), 'base');
  check(near(hi.stats.size, c.stats.size), 'the size stat is the same at twice the resolution');

  const kinds = await cook(bakeNodes({ kinds: { brushed: 'bare_steel', paint: 'cast_metal' } }), 'base');
  const kl = [...img(kinds, 'base').layers.keys()].filter((k) => k.startsWith('kind_'));
  check(eq(kl.sort(), ['kind_bare_steel', 'kind_cast_metal']), `the kinds param wins over the material's own kind (${kl.join(', ')})`);
  for (const [masks, want] of [['materials', ['mat_paint', 'mat_brushed']], ['kinds', ['kind_painted_metal']], ['none', []]] as const) {
    const r = await cook(bakeNodes({ masks }), 'base');
    const ls = [...img(r, 'base').layers.keys()].filter((k) => k.startsWith('mat_') || k.startsWith('kind_'));
    check(eq(ls, want), `masks ${masks}: ${ls.join(', ') || 'no mask layers'}`);
  }
  const ss = await cook(bakeNodes({ supersample: 2 }), 'base');
  const sb = img(ss, 'base');
  check(Array.from(sb.layer('mat_paint')!).every((v) => v === 0 || v === 1) && Array.from(sb.layer('kind_painted_metal')!).every((v) => v === 0 || v === 1), 'with supersampling the labels stay 0 or 1 (the first sample of a texel decides)');

  // maps: an image the geometry carries is read at the texel's uv
  const mapped: Nodes = {
    tint: { type: 'tex_constant', params: { resolution: 16, channels: 'rgba', color: '#336699' } },
    ramp: { type: 'tex_gradient', params: { resolution: 64 } },
    quad: SCENE.quad,
    withmaps: { type: 'merge', in: ['quad', 'tint', 'ramp'] },
    mat: { type: 'material', in: ['withmaps'], params: { name: 'tile', base_color_map: 'image:tint', roughness_map: 'image:ramp' } },
    uv: SCENE.uv && { type: 'uv_project', in: ['mat'], params: { method: 'planar', axis: 'y', scale: 4, offset: [0.5, 0.5] } },
    base: { type: 'bake_material', in: ['uv'], params: { resolution: RES, padding: 2 } },
  };
  const m = img(await cook(mapped, 'base'), 'base');
  const col = px(m, 'C', 30, 30);
  check(near(col[0], 0.2, 0.01) && near(col[1], 0.4, 0.01) && near(col[2], 0.6, 0.01), `a base colour map bakes its colour (${col.slice(0, 3).map((x) => x.toFixed(3)).join(', ')})`);
  const r1 = px(m, 'roughness', 18, 32)[0], r2 = px(m, 'roughness', 45, 32)[0];
  check(r1 !== r2 && Math.abs(r1 - r2) > 0.05, `a roughness map is read at the texel's uv (${r1.toFixed(2)} at the left, ${r2.toFixed(2)} at the right)`);
}

section('bake_material refusals');
{
  const bare: Nodes = { quad: SCENE.quad, uv: { type: 'uv_project', in: ['quad'], params: { method: 'planar', axis: 'y', scale: 4, offset: [0.5, 0.5] } }, base: { type: 'bake_material', in: ['uv'], params: { resolution: 32 } } };
  let e = await err(bare, 'base');
  check(e.includes('bake_material: input 0 has no prim attribute "material"') && e.includes('assign materials first (material node); colours carried as Cd bake with bake_vertex_color'), 'no material attribute: ' + e);
  const ghost: Nodes = { ...SCENE, bad: { type: 'attrib_create', in: ['uv'], params: { name: 'material', class: 'prim', type: 'string', value: 'ghost', group: '@P.x<0' } }, base: { type: 'bake_material', in: ['bad'], params: { resolution: 32 } } };
  e = await err(ghost, 'base');
  check(e.includes('bake_material: prims use material "ghost", which the material table does not define') && e.includes('materials: brushed, paint'), 'a material the table does not define: ' + e);
  const file: Nodes = { quad: SCENE.quad, mat: { type: 'material', in: ['quad'], params: { name: 'brick', base_color_map: 'tex/brick.png' } }, uv: { type: 'uv_project', in: ['mat'], params: { method: 'planar', axis: 'y', scale: 4, offset: [0.5, 0.5] } }, base: { type: 'bake_material', in: ['uv'], params: { resolution: 32 } } };
  e = await err(file, 'base');
  check(e.includes('bake_material: material "brick" has its base colour map in a file ("tex/brick.png"); bakes read only images the geometry carries') && e.includes('load it with image_file and set the map to "image:<name>"'), 'a base colour map in a file: ' + e);
  e = await err(bakeNodes({ kinds: { brushed: 'galvanized' } }), 'base');
  check(e.includes('bake_material: unknown kind "galvanized" for material "brushed"') && e.includes('kinds: painted_metal, cast_metal') && e.includes('did you mean "galvanised"?'), 'an unknown kind, with the near one: ' + e);
  e = await err(bakeNodes({ kinds: { ghost: 'rubber' } }), 'base');
  check(e.includes('bake_material: kinds names material "ghost", which the material table does not define'), 'kinds naming a material the table lacks: ' + e);
  const half: Nodes = { ...SCENE, base: { type: 'bake_material', in: ['uv'], params: { resolution: 32 } } };
  delete (half as any).m2;
  half.uv = { type: 'uv_project', in: ['m1'], params: { method: 'planar', axis: 'y', scale: 4, offset: [0.5, 0.5] } };
  e = await err(half, 'base');
  check(e.includes('bake_material: 2 prims have no material'), 'prims without a material: ' + e);
  check(!(await err({ ...half, base: { type: 'bake_material', in: ['uv'], params: { resolution: 32, group: '@P.x<0' } } }, 'base')), 'a group that leaves the unassigned prims out bakes');
}

// ---------------------------------------------------------------- tex_layers

/** A base image of one colour (RGBA) and every texel covered; masks are separate images. */
const flat = (color = '#808080', res = 32, size = 1): Nodes => ({
  base: { type: 'tex_constant', params: { resolution: res, channels: 'rgba', color, texture_size: size } },
  ones: { type: 'tex_constant', params: { resolution: res, value: 1 } },
  grad: { type: 'tex_gradient', params: { resolution: res } },
  masks: { type: 'merge', in: ['ones', 'grad'] },
});
const stackOf = (nodes: Nodes, params: Record<string, any>): Nodes => ({ ...nodes, stack: { type: 'tex_layers', in: ['base', 'masks'], params: { base_roughness: 0.5, base_metallic: 0, coverage: '', ...params } } });

section('tex_layers: colour modes');
{
  const below = [0.5, 0.4, 0.2], c = [0.8, 0.2, 0.6], a = 0.5;
  const hex = (v: number[]) => '#' + v.map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
  const bb = [0.5, 0.4, 0.2].map((x) => Math.round(x * 255) / 255), cc = c.map((x) => Math.round(x * 255) / 255);
  const mix = (x: number, y: number) => x + (y - x) * a;
  const expect: Record<string, (x: number, y: number) => number> = {
    normal: (x, y) => mix(x, y),
    multiply: (x, y) => mix(x, x * y),
    lighten: (x, y) => mix(x, Math.max(x, y)),
    overlay: (x, y) => mix(x, x < 0.5 ? 2 * x * y : 1 - 2 * (1 - x) * (1 - y)),
  };
  for (const mode of Object.keys(expect)) {
    const r = await cook(stackOf(flat(hex(below)), { layers: [{ name: 'l', mask: 'ones', color: hex(c), color_mode: mode, opacity: a }] }), 'stack');
    const got = px(img(r, 'stack_base_color'), 'C', 7, 9);
    const want = bb.map((x, i) => expect[mode](x, cc[i]));
    check(got.slice(0, 3).every((v, i) => near(v, want[i], 2e-6)) && got[3] === 1, `colour mode ${mode}: ${got.slice(0, 3).map((x) => x.toFixed(3)).join(', ')} = ${want.map((x) => x.toFixed(3)).join(', ')}`);
  }
  const r = await cook(stackOf(flat('#808080'), { layers: [{ name: 'zero', mask: '0', color: '#ff0000' }] }), 'stack');
  check(near(px(img(r, 'stack_base_color'), 'C', 3, 3)[0], 128 / 255), 'a layer with an empty mask leaves the base');
}

section('tex_layers: ramps');
{
  const nodes = flat('#000000');
  const r = await cook(stackOf(nodes, { layers: [{ name: 'ramp', mask: 'ones', color: [[0, '#ff0000'], [0.5, '#00ff00'], [1, '#0000ff']], color_by: 'grad' }] }), 'stack');
  const out = img(r, 'stack_base_color'), g = img(await cook(nodes, 'grad'), 'grad').layer('C')!;
  let worst = 0;
  for (let k = 0; k < g.length; k++) {
    const t = g[k], e = t < 0.5 ? [1 - 2 * t, 2 * t, 0] : [0, 1 - 2 * (t - 0.5), 2 * (t - 0.5)];
    for (let ch = 0; ch < 3; ch++) worst = Math.max(worst, Math.abs(out.layer('C')![k * 4 + ch] - e[ch]));
  }
  check(worst < 0.01, `a three-key ramp reads its colours along color_by (largest difference ${worst.toFixed(4)})`);
  const lo = Array.from(g).indexOf(Math.min(...g)), hi = Array.from(g).indexOf(Math.max(...g));
  const a = out.layer('C')!;
  check(a[lo * 4] > 0.95 && a[hi * 4 + 2] > 0.95, 'the ends of the ramp are its first and last colour');
  const flatRamp = await cook(stackOf(nodes, { layers: [{ name: 'ramp', mask: 'ones', color: [[0, '#336699'], [1, '#ffffff']] }] }), 'stack');
  const fr = px(img(flatRamp, 'stack_base_color'), 'C', 1, 1);
  check(near(fr[0], 0.2, 0.002) && near(fr[1], 0.4, 0.002) && near(fr[2], 0.6, 0.002), 'color_by defaults to 0: the first colour');
}

section('tex_layers: roughness, metallic, occlusion, graph vars');
{
  const r = await cook(stackOf(flat(), {
    occlusion: 'amount * grad',
    layers: [
      { name: 'a', mask: 'ones', roughness: 0.9, metallic: 1, opacity: 0.5 },
      { name: 'b', mask: 'ones', roughness_offset: 0.1 },
    ],
  }), 'stack', serial, { amount: 0.5 });
  const orm = img(r, 'stack_orm'), g = img(await cook(flat(), 'grad'), 'grad').layer('C')!;
  const o = px(orm, 'C', 5, 5), k = 5 * 32 + 5;
  check(near(o[0], 0.5 * g[k], 1e-6) && near(o[1], 0.5 + (0.9 - 0.5) * 0.5 + 0.1, 1e-6) && near(o[2], 0.5, 1e-6) && o[3] === 1, `ORM: occlusion from its expression and a graph var, roughness replaced then offset, metallic replaced at half opacity (${o.map((x) => x.toFixed(3)).join(', ')})`);
  const r2 = await cook(stackOf(flat(), { occlusion: 'amount * grad', layers: [] }), 'stack', serial, { amount: 1 });
  const r3 = await cook(stackOf(flat(), { occlusion: 'amount * grad', layers: [] }), 'stack', serial, { amount: 0.25 });
  check(!same(img(r2, 'stack_orm').layer('C')!, img(r3, 'stack_orm').layer('C')!), 'a graph var the expressions name changes the result (and re-cooks)');
  const roughRead = await cook({ ...flat(), stack: { type: 'tex_layers', in: ['base', 'masks'], params: { base_roughness: 0.3, base_metallic: 0.1, coverage: '', layers: [] } } }, 'stack');
  const ro = px(img(roughRead, 'stack_orm'), 'C', 0, 0);
  check(near(ro[1], 0.3) && near(ro[2], 0.1), 'base_roughness and base_metallic set the whole base');
}

section('tex_layers: height and normal');
{
  const sceneAt = (res: number): Nodes => stackOf(flat('#808080', res), { layers: [{ name: 'step', mask: 'smoothstep(0.3, 0.7, grad)', height: 0.3 }] });
  const lo = await cook(sceneAt(128), 'stack'), hi = await cook(sceneAt(256), 'stack');
  const nLo = img(lo, 'stack_normal'), nHi = img(hi, 'stack_normal');
  const down = resizeLayer(nHi.layer('C')!, 4, 256, 256, 128, 128, false);
  let diff = 0, tilt = 0, count = 0;
  for (let i = 0; i < 128 * 128; i++) for (let c = 0; c < 2; c++) { diff += Math.abs(down[i * 4 + c] - nLo.layer('C')![i * 4 + c]); tilt += Math.abs(nLo.layer('C')![i * 4 + c] - 0.5); count++; }
  check(tilt / count > 0.05, `the step tilts the normal (mean tilt ${(tilt / count).toFixed(3)})`);
  check(diff / count < 0.01, `the same step at 128 and 256 gives the same normal after resampling (mean difference ${(diff / count).toFixed(4)})`);
  const wide = await cook(stackOf(flat('#808080', 128, 2), { layers: [{ name: 'step', mask: 'smoothstep(0.3, 0.7, grad)', height: 0.3 }] }), 'stack');
  const tilt2 = Array.from(img(wide, 'stack_normal').layer('C')!).reduce((s, v, i) => s + (i % 4 < 2 ? Math.abs(v - 0.5) : 0), 0) / count;
  check(tilt2 < (tilt / count) * 0.75, `a larger size (metres per image) gives a gentler slope (${tilt2.toFixed(3)} < ${(tilt / count).toFixed(3)})`);
  const h = img(lo, 'stack_height').layer('C')!;
  check(near(Math.max(...h), 0.3, 1e-4) && near(Math.min(...h), 0, 1e-4), 'the height image holds metres');
  const dx = await cook(stackOf(flat('#808080', 128), { normal_format: 'directx', layers: [{ name: 'step', mask: 'smoothstep(0.3, 0.7, grad)', height: 0.3 }] }), 'stack');
  const a = img(lo, 'stack_normal'), b = img(dx, 'stack_normal');
  check(near(a.layer('C')![(64 * 128 + 64) * 4 + 1] + b.layer('C')![(64 * 128 + 64) * 4 + 1], 1, 1e-4), 'directx flips the green channel');
}

section('tex_layers: covered texels only, then padding');
{
  // the grid's uv covers the middle quarter; a mask that is 1 everywhere, outside the islands too
  const nodes: Nodes = {
    ...bakeNodes(),
    ones: { type: 'tex_constant', params: { resolution: RES, value: 1 } },
    masks: { type: 'merge', in: ['ones'] },
    stack: {
      type: 'tex_layers', in: ['base', 'masks'],
      params: { padding: 3, layers: [{ name: 'all', mask: 'ones', color: '#0000ff', roughness: 0.2, metallic: 1, height: 0.01 }], occlusion: '0.5' },
    },
  };
  const r = await cook(nodes, 'stack');
  const col = img(r, 'stack_base_color'), orm = img(r, 'stack_orm'), nrm = img(r, 'stack_normal'), hei = img(r, 'stack_height');
  const cov = col.layer('mask')!;
  check(!!cov && [orm, nrm, hei].every((i) => i.layer('mask') === cov || same(i.layer('mask')!, cov)), 'every output keeps the base\'s coverage as layer mask');
  // the squared distance of every texel to the nearest covered one
  const cx: number[] = [], cy: number[] = [];
  for (let k = 0; k < cov.length; k++) if (cov[k] > 0) { cx.push(k % RES); cy.push(Math.floor(k / RES)); }
  const d2of = (i: number, j: number) => { let m = Infinity; for (let q = 0; q < cx.length; q++) m = Math.min(m, (cx[q] - i) ** 2 + (cy[q] - j) ** 2); return m; };
  let farOk = true, nearOk = true, coveredOk = true, flatOk = true, farCount = 0, nearCount = 0;
  for (let j = 0; j < RES; j++) for (let i = 0; i < RES; i++) {
    const d2 = d2of(i, j);
    const c = px(col, 'C', i, j), o = px(orm, 'C', i, j), n = px(nrm, 'C', i, j), h = px(hei, 'C', i, j)[0];
    if (cov[j * RES + i] > 0) {
      if (!(c[2] === 1 && c[0] === 0 && near(o[1], 0.2) && o[2] === 1 && near(o[0], 0.5) && near(h, 0.01, 1e-6))) coveredOk = false;
      if (!(near(n[0], 0.5, 1e-4) && near(n[1], 0.5, 1e-4) && n[2] > 0.999)) flatOk = false;
    } else if (d2 > 9) {
      farCount++;
      if (!(c[0] === 0 && c[1] === 0 && c[2] === 0 && c[3] === 1 && o[0] === 1 && o[1] === 0.5 && o[2] === 0 && n[0] === 0.5 && n[1] === 0.5 && n[2] === 1 && h === 0)) farOk = false;
    } else {
      nearCount++;
      if (!(c[2] === 1 && near(o[1], 0.2) && near(h, 0.01, 1e-6))) nearOk = false;
    }
  }
  check(coveredOk, 'covered texels hold the composed values');
  check(flatOk, 'a constant height gives a flat normal on every covered texel, also at the border of an island');
  check(nearOk && nearCount > 0, `texels within the padding copy the nearest covered texel (${nearCount} texels)`);
  check(farOk && farCount > 0, `no value from outside the coverage survives: every texel beyond the padding is the neutral background (${farCount} texels)`);
  const noPad = await cook({ ...nodes, stack: { ...nodes.stack, params: { ...nodes.stack.params, padding: 0 } } }, 'stack');
  const cp = img(noPad, 'stack_base_color'), cc = cp.layer('mask')!;
  let bg = true;
  for (let k = 0; k < cc.length; k++) if (cc[k] === 0 && !(cp.layer('C')![k * 4] === 0 && cp.layer('C')![k * 4 + 2] === 0)) bg = false;
  check(bg, 'padding 0 leaves every uncovered texel at the background');
}

section('tex_layers: workers');
{
  const layers = [
    { name: 'a', mask: 'smoothstep(0.2, 0.8, grad) * amount', color: [[0, '#5c2a14'], [1, '#9a4a20']], color_by: 'grad', roughness: 0.9, metallic: 0, height: -0.001 },
    { name: 'b', mask: 'ones - grad', color: '#a69d8b', color_mode: 'lighten', opacity: 0.6, roughness_offset: 0.05, height: 0.0005 },
    { name: 'c', mask: 'fit(grad, 0, 1, 0, 1) * 0.5', color: '#222222', color_mode: 'overlay' },
  ];
  const nodes = stackOf(flat('#6f8fae', 128), { layers, occlusion: 'ones * 0.75 + grad * 0.25' });
  const before = pooled.poolStats.parallel;
  const a = await cook(nodes, 'stack', serial, { amount: 0.8 }), b = await cook(nodes, 'stack', pooled, { amount: 0.8 });
  check(pooled.poolStats.parallel > before, 'the expressions ran on the worker pool');
  for (const nm of ['base_color', 'normal', 'orm', 'height']) check(same(img(a, `stack_${nm}`).layer('C')!, img(b, `stack_${nm}`).layer('C')!), `${nm} is bit-identical with the pool and without it`);
  const again = await cook(nodes, 'stack', serial, { amount: 0.8 });
  check(same(img(a, 'stack_orm').layer('C')!, img(again, 'stack_orm').layer('C')!), 'a second cook gives the same bits');
}

section('tex_layers: refusals and warnings');
{
  const base = flat();
  let e = await err(stackOf(base, { layers: [{ name: 'rust', mask: 'smoothstep(0.2, 0.5, runs_rust)' }] }), 'stack');
  check(e.includes('tex_layers: layer "rust": its mask names "runs_rust", which no image in input 1 holds') && e.includes('variables: ') && e.includes('grad') && e.includes('ones'), 'a mask naming a missing layer, with the variables: ' + e);
  e = await err(stackOf(base, { layers: [{ name: 'rust', mask: '1', color: [[0, '#fff'], [1, '#000']], color_by: 'noise_a' }] }), 'stack');
  check(e.includes('layer "rust": its color_by names "noise_a"'), 'color_by naming a missing layer: ' + e);
  e = await err(stackOf(base, { occlusion: 'ao_missing' }), 'stack');
  check(e.includes('occlusion names "ao_missing", which no image in input 1 holds'), 'occlusion naming a missing layer: ' + e);
  e = await err(stackOf(base, { layers: [{ name: 'dust', mask: '1' }, { name: 'dust', mask: '1' }] }), 'stack');
  check(e.includes('tex_layers: two layers are called "dust"'), 'two layers with one name: ' + e);
  e = await err({ ...base, stack: { type: 'tex_layers', in: ['base', 'masks'], params: { coverage: '', layers: [] } } }, 'stack');
  check(e.includes('tex_layers: the base has no "roughness" layer') && e.includes('bake the base with bake_material, or set base_roughness'), 'a base without roughness: ' + e);
  e = await err({ ...base, stack: { type: 'tex_layers', in: ['base', 'masks'], params: { coverage: '', base_roughness: 0.5, layers: [] } } }, 'stack');
  check(e.includes('tex_layers: the base has no "metallic" layer') && e.includes('set base_metallic'), 'a base without metallic: ' + e);
  e = await err(stackOf(base, { layers: [{ name: 'fade', mask: '1', color: '#zzz' }] }), 'stack');
  check(e.includes('tex_layers: layer "fade": color "#zzz" is not a colour'), 'a colour that is none: ' + e);
  e = await err(stackOf(base, { layers: [{ name: 'fade', mask: '1', color: [[0, '#fff'], [1, 'zzz']] }] }), 'stack');
  check(e.includes('layer "fade": color "zzz" is not a colour'), 'a ramp key that is none: ' + e);
  e = await err(stackOf(base, { layers: [{ name: 'fade', mask: '1', colour: '#fff' }] }), 'stack');
  check(e.includes('layer "fade": unknown field "colour"') && e.includes('did you mean "color"?'), 'an unknown field: ' + e);
  e = await err(stackOf(base, { layers: [{ name: 'fade' }] }), 'stack');
  check(e.includes('layer "fade" has no mask'), 'a layer without a mask: ' + e);
  e = await err(stackOf(base, { layers: [{ mask: '1' }] }), 'stack');
  check(e.includes('layer 1 has no name'), 'a layer without a name: ' + e);
  e = await err(stackOf(base, { layers: [{ name: 'x', mask: '1 +* 2' }] }), 'stack');
  check(e.includes('layer "x" mask: expression syntax error'), 'a syntax error names the layer: ' + e);
  e = await err(stackOf(base, { layers: [{ name: 'x', mask: '1', color_mode: 'dodge' }] }), 'stack');
  check(e.includes('color_mode "dodge" is not one of normal, multiply, overlay, lighten'), 'a colour mode that is none: ' + e);
  e = await err(stackOf(base, { layers: [{ name: 'x', mask: '1', roughness: 3 }] }), 'stack');
  check(e.includes('layer "x": roughness 3 is not a number in 0..1'), 'a roughness outside 0..1: ' + e);
  e = await err(stackOf(base, { coverage: 'nothing', layers: [] }), 'stack');
  check(e.includes('the base has no coverage layer "nothing"'), 'a coverage layer the base lacks: ' + e);
  const small: Nodes = { ...flat(), tiny: { type: 'tex_constant', params: { resolution: 16, value: 1, name: 'ao' } }, masks: { type: 'merge', in: ['ones', 'tiny'] } };
  const w = await cook(stackOf(small, { layers: [{ name: 'a', mask: 'ao * 0.5', color: '#ff0000' }] }), 'stack');
  check(w.warnings.some((m) => m.includes('tex_layers: mask image "ao" is 16 × 16, the base 32 × 32; it is resized')), 'a mask image of another size is resized with a warning');
  check(near(px(img(w, 'stack_base_color'), 'C', 10, 10)[0], 128 / 255 + (1 - 128 / 255) * 0.5, 0.01), 'the resized mask still composes');
  const hidden = await cook(stackOf(base, { layers: [{ name: 'a', mask: 'grad * 0.5' }, { name: 'b', mask: 'grad * 0.5' }] }), 'stack', serial, { grad: 3 });
  check(hidden.warnings.filter((m) => m.includes('grad in an expression is a mask variable, not the graph var of that name')).length === 1, 'a graph var that a mask image hides is said once, and the image wins');
  const none = await cook(stackOf(base, { layers: [] }), 'stack');
  check(['base_color', 'normal', 'orm', 'height'].every((s) => !!findImage(none.geo, `stack_${s}`)), 'with no layers the base comes through as four images');
  const nan = await cook(stackOf(base, { layers: [{ name: 'n', mask: 'sqrt(-1)', color: '#ff0000' }] }), 'stack');
  check(nan.warnings.some((m) => m.includes('layer "n" mask: 1024 texel(s) gave NaN')), 'NaN is written as 0 with a warning');
}

section('tex_layers: a stop on a runaway expression');
{
  const limited = new Engine(createNodeHost({ workers: 0 }));
  limited.scriptTimeoutMs = 300;
  await limited.init();
  const r = await limited.cook({ nodes: stackOf(flat(), { layers: [{ name: 'loop', mask: 'while (true) {} return 1;' }] }), output: 'stack' });
  check(!r.ok && r.errors.some((x) => /layer "loop" mask: expression exceeded 300 ms/.test(x.message)), 'an endless expression stops at the script time limit: ' + r.errors.map((x) => x.message).join('; '));
}

section('tex_channel: inputs of different sizes');
{
  const nodes: Nodes = {
    ao: { type: 'tex_constant', params: { resolution: 32, value: 0.25, name: 'ao' } },
    rough: { type: 'tex_constant', params: { resolution: 64, value: 0.75, name: 'rough' } },
    orm: { type: 'tex_channel', in: ['ao', 'rough'] },
  };
  const r = await cook(nodes, 'orm');
  const o = img(r, 'orm');
  check(o.width === 64 && o.height === 64, `the pack takes the largest input's size, not the first's (${o.width} × ${o.height})`);
  check(near(px(o, 'C', 3, 3)[0], 0.25) && near(px(o, 'C', 3, 3)[1], 0.75), 'both channels keep their values after the resize');
  check(r.warnings.some((m) => m.includes('tex_channel: input 0 "ao" is 32 × 32, the largest is 64 × 64; it is resized')), 'the resize is a warning: ' + r.warnings.join('; '));
  const same2 = await cook({ ...nodes, rough: { type: 'tex_constant', params: { resolution: 32, value: 0.75, name: 'rough' } } }, 'orm');
  check(same2.warnings.length === 0 && img(same2, 'orm').width === 32, 'inputs of one size pack without a warning');
}

section('texel size');
{
  // a 1 m square covering the whole uv square at 100 × 100 texels: 1 cm per texel
  const pos = [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1];
  const uv = [0, 0, 1, 0, 1, 1, 0, 1];
  const t = medianTexelSize(pos, uv, [0, 1, 2, 0, 2, 3], 100, 100);
  check(near(t, 0.01, 1e-9), `a 1 m square over 100 texels is 1 cm per texel (${t})`);
  check(medianTexelSize(pos, uv, [0, 1, 2, 0, 2, 3], 100, 100, Uint8Array.of(1, 1)) === 0, 'no triangle left: 0');
}

// ---------------------------------------------------------------- second review: packed maps, uv, texel size, names, signed, pool

/** A 2 m square grid, uv over the middle quarter, one material: a carrier for a few of the tests below. */
const plane = (size: [number, number] = [2, 2], res: number | [number, number] = RES, scale: [number, number] = [4, 4], extra: Record<string, any> = {}): Nodes => ({
  quad: { type: 'grid', params: { size, divisions: [2, 2] } },
  mat: { type: 'material', in: ['quad'], params: { name: 'plain', base_color: '#808080', roughness: 0.5 } },
  uv: { type: 'uv_project', in: ['mat'], params: { method: 'planar', axis: 'y', scale, offset: [0.5, 0.5] } },
  base: { type: 'bake_material', in: ['uv'], params: { resolution: res, padding: 2, ...extra } },
});

/** A flat 2 m grid with a constant tangent-space normal map (0.6, 2g − 1, 0.8) on uv = (x, z) / 4 + 0.5, baked on bakeUV. */
const tilted = (format: string, g: number, bakeUV: string): Nodes => ({
  r: { type: 'tex_constant', params: { resolution: 8, value: 0.8 } },
  nm: { type: 'tex_channel', in: ['r'], params: { fill: [0, g, 0.9, 1] } },
  quad: { type: 'grid', params: { size: [2, 2], divisions: [2, 2] } },
  withmap: { type: 'merge', in: ['quad', 'nm'] },
  mat: { type: 'material', in: ['withmap'], params: { name: 'bumpy', normal_map: 'image:nm', normal_format: format } },
  uv: { type: 'uv_project', in: ['mat'], params: { method: 'planar', axis: 'y', scale: 4, offset: [0.5, 0.5] } },
  uv2: { type: 'wrangle', in: ['uv'], params: { run_over: 'points', code: 'v@uv2 = set(@P.z / 2 + 0.5, -@P.x / 2 + 0.5, 0);' } },
  base: { type: 'bake_material', in: ['uv2'], params: { resolution: RES, padding: 2, uv_attrib: bakeUV } },
});
/** a unit-vector component as a normal map stores it */
const enc = (v: number) => 0.5 + 0.5 * v;

section('bake_material: packed maps, uv, names');
{
  // texture_to_material packs roughness and metallic into <material>_orm and sets both factors to 1
  const packed: Nodes = {
    quad: SCENE.quad,
    occ: { type: 'tex_constant', params: { resolution: 8, value: 1 } },
    rgh: { type: 'tex_constant', params: { resolution: 8, value: 0.2 } },
    met: { type: 'tex_constant', params: { resolution: 8, value: 0 } },
    imgs: { type: 'merge', in: ['occ', 'rgh', 'met'] },
    pk: { type: 'texture_to_material', in: ['quad', 'imgs'], params: { material: 'pk', occlusion: 'occ', roughness: 'rgh', metallic: 'met' } },
    uv: { type: 'uv_project', in: ['pk'], params: { method: 'planar', axis: 'y', scale: 4, offset: [0.5, 0.5] } },
    base: { type: 'bake_material', in: ['uv'], params: { resolution: RES, padding: 2 } },
  };
  const pb = img(await cook(packed, 'base'), 'base');
  check(near(px(pb, 'roughness', 30, 30)[0], 0.2, 1e-5) && near(px(pb, 'metallic', 30, 30)[0], 0, 1e-5), `a packed orm map gives its roughness and metallic, not the factors (${px(pb, 'roughness', 30, 30)[0].toFixed(3)}, ${px(pb, 'metallic', 30, 30)[0].toFixed(3)})`);
  const only: Nodes = { ...packed, pk: { type: 'texture_to_material', in: ['quad', 'imgs'], params: { material: 'pk', roughness: 'rgh' } } };
  const ob = img(await cook(only, 'base'), 'base');
  check(near(px(ob, 'roughness', 30, 30)[0], 0.2, 1e-5), 'a roughness map alone gives its value');
  // a normal map is carried, re-expressed in the tangent frame of the bake's uv. Known case: a flat grid (N = +y), maps
  // on uv = (x, z) / 4 + 0.5 (tangent +x, bitangent +z), a constant map tilted toward its tangent: (0.6, 0, 0.8), so the
  // world normal is (0.6, 0.8, 0). Baked on the same uv it comes back as it was; baked on uv2 = (z, −x) / 2 + 0.5
  // (tangent +z, bitangent −x) it reads (0, −0.6, 0.8); a DirectX map (green down) tilts the other way along v.
  const nAt = async (nodes: Nodes) => { const c = await cook(nodes, 'base'); return { n: px(img(c, 'base'), 'normal', 32, 32), warnings: c.warnings }; };
  const sameUV = await nAt(tilted('opengl', 0.5, 'uv'));
  check(near(sameUV.n[0], enc(0.6), 0.01) && near(sameUV.n[1], enc(0), 0.01) && near(sameUV.n[2], enc(0.8), 0.01), `a normal map baked on its own uv comes back as it was (${sameUV.n.slice(0, 3).map((v) => v.toFixed(3)).join(', ')})`);
  check(!sameUV.warnings.some((m) => m.includes('normal')), 'and no warning about it: ' + sameUV.warnings.join('; '));
  const turned = await nAt(tilted('opengl', 0.5, 'uv2'));
  check(near(turned.n[0], enc(0), 0.01) && near(turned.n[1], enc(-0.6), 0.01) && near(turned.n[2], enc(0.8), 0.01), `on a turned uv it is re-expressed in that frame: (0, −0.6, 0.8) (${turned.n.slice(0, 3).map((v) => v.toFixed(3)).join(', ')})`);
  const dx = await nAt(tilted('directx', 0.2, 'uv'));
  const k = 0.6 / Math.hypot(0.6, 0.6, 0.8); // (0.6, 0.6, 0.8) normalised
  check(near(dx.n[0], enc(k), 0.01) && near(dx.n[1], enc(k), 0.01), `a DirectX map has its green flipped: (0.6, −0.6) reads (0.6, 0.6), normalised (${dx.n.slice(0, 3).map((v) => v.toFixed(3)).join(', ')})`);
  const noMap = img(await cook(packed, 'base'), 'base');
  check(!noMap.layers.has('normal'), 'no material with a normal map: no normal layer');

  // maps on "uv", a bake laid out on "uv2"
  const two: Nodes = {
    ramp: { type: 'tex_gradient', params: { resolution: 64 } },
    quad: SCENE.quad,
    withmap: { type: 'merge', in: ['quad', 'ramp'] },
    mat: { type: 'material', in: ['withmap'], params: { name: 'tile', roughness_map: 'image:ramp' } },
    uv: { type: 'uv_project', in: ['mat'], params: { method: 'planar', axis: 'y', scale: 4, offset: [0.5, 0.5] } },
    uv2: { type: 'wrangle', in: ['uv'], params: { run_over: 'points', code: 'v@uv2 = set(@P.x / 2 + 0.5, @P.z / 2 + 0.5, 0);' } },
    base: { type: 'bake_material', in: ['uv2'], params: { resolution: RES, padding: 2, uv_attrib: 'uv2' } },
  };
  const tb = img(await cook(two, 'base'), 'base');
  // the texel at u2 reads the map where the mesh's uv puts it: u = x / 4 + 0.5 with x = 2 (u2 - 0.5)
  const probe = (i: number) => { const u2 = (i + 0.5) / RES; return (u2 - 0.5) / 2 + 0.5; };
  const g = img(await cook({ ramp: two.ramp }, 'ramp'), 'ramp');
  const r16 = px(tb, 'roughness', 16, 32)[0], r48 = px(tb, 'roughness', 48, 32)[0];
  const expect = (i: number) => px(g, 'C', Math.min(g.width - 1, Math.floor(probe(i) * g.width)), 32)[0];
  check(Math.abs(r16 - expect(16)) < 0.03 && Math.abs(r48 - expect(48)) < 0.03 && r48 - r16 > 0.2, `maps on uv are read with uv when the bake lies on uv2 (${r16.toFixed(2)}, ${r48.toFixed(2)} for ${expect(16).toFixed(2)}, ${expect(48).toFixed(2)})`);

  // names an expression can read
  const odd: Nodes = {
    quad: SCENE.quad,
    m1: { type: 'material', in: ['quad'], params: { name: 'Paint.001', base_color: '#ff0000', group: '@P.x<0' } },
    m2: { type: 'material', in: ['m1'], params: { name: 'label-print', base_color: '#00ff00', group: '@P.x>0' } },
    uv: SCENE.uv && { type: 'uv_project', in: ['m2'], params: { method: 'planar', axis: 'y', scale: 4, offset: [0.5, 0.5] } },
    base: { type: 'bake_material', in: ['uv'], params: { resolution: RES, padding: 2 } },
  };
  const oc = await cook(odd, 'base'), ob2 = img(oc, 'base');
  check(ob2.layers.has('mat_Paint_001') && ob2.layers.has('mat_label_print') && ob2.layers.has('kind_decal') === false, `material names become identifiers (${[...ob2.layers.keys()].filter((k) => k.startsWith('mat_')).join(', ')})`);
  check(oc.warnings.some((m) => m.includes('material "Paint.001" is mat_Paint_001') && m.includes('material "label-print" is mat_label_print')), 'the renames are reported: ' + oc.warnings.join('; '));
  const clash: Nodes = { ...odd, m1: { ...odd.m1, params: { ...odd.m1.params, name: 'a.b' } }, m2: { ...odd.m2, params: { ...odd.m2.params, name: 'a_b' } } };
  const cl = img(await cook(clash, 'base'), 'base');
  check(cl.layers.has('mat_a_b') && cl.layers.has('mat_a_b_2'), `two materials that would collide get distinct names (${[...cl.layers.keys()].filter((k) => k.startsWith('mat_')).join(', ')})`);
  const reach: Nodes = { ...odd, ones: { type: 'tex_constant', params: { resolution: RES, value: 1 } }, masks: { type: 'merge', in: ['ones'] }, stack: { type: 'tex_layers', in: ['base', 'masks'], params: { layers: [{ name: 'p', mask: 'base_mat_Paint_001', color: '#0000ff' }, { name: 'l', mask: 'base_mat_label_print', color: '#ffffff' }] } } };
  const rc = img(await cook(reach, 'stack'), 'stack_base_color');
  const lp = px(rc, 'C', 20, 32), rp = px(rc, 'C', 43, 32);
  check(near(lp[2], 1) && near(lp[0], 0) && near(rp[0], 1) && near(rp[1], 1), 'a material called Paint.001 or label-print is reachable from an expression');
  // kind from a whole name
  const named: Nodes = { ...plane(), mat: { type: 'material', in: ['quad'], params: { name: 'Rubber', base_color: '#202020' } } };
  const nk = img(await cook(named, 'base'), 'base');
  check(nk.layers.has('kind_rubber'), 'a material called Rubber is rubber by its whole name');
  // overlapping uv: warned once
  const over: Nodes = { ...plane(), copy: { type: 'merge', in: ['mat', 'mat'] }, uv: { type: 'uv_project', in: ['copy'], params: { method: 'planar', axis: 'y', scale: 4, offset: [0.5, 0.5] } } };
  const ow = await cook(over, 'base');
  check(ow.warnings.filter((m) => m.includes('triangles overlap')).length === 1, 'overlapping uv are warned about once: ' + ow.warnings.filter((m) => m.includes('overlap')).join('; ').slice(0, 160));
  check((await cook(plane(), 'base')).warnings.length === 0, 'a clean unwrap bakes without a warning');
}

section('resolveKind');
{
  const { resolveKind } = await import('../src/core/materials.ts');
  const m = (kind?: string) => normalizeMaterial({ kind });
  check(resolveKind('Paint', m(), null).kind === 'painted_metal' && resolveKind('Paint', m(), null).from === 'name', 'a whole name that is a kind name');
  check(resolveKind('worn_metal', m(), null).kind === '' && resolveKind('dark_iron', m(), null).from === 'none', 'part of a name tells nothing');
  check(resolveKind('Paint', m('rubber'), null).kind === 'rubber' && resolveKind('Paint', m('rubber'), null).from === 'material', 'the material\'s own kind wins over its name');
  check(resolveKind('Paint', m('rubber'), { Paint: 'decal' }).kind === 'decal' && resolveKind('Paint', m('rubber'), { Paint: 'decal' }).from === 'kinds', 'the kinds map wins over both');
  check(resolveKind('x', m('galvanized'), null).unknown === 'galvanized' && resolveKind('x', m(), { x: 'nope' }).unknown === 'nope', 'a written kind that is none is reported, not guessed');
  check(resolveKind('GALVANIZED', m(), null).kind === 'galvanised', 'a name spelled the other way still names its kind');
}

section('tex_layers: texel size, slopes, islands');
{
  const rampBase = (size: [number, number], res: [number, number], scale: [number, number], angle: number): Nodes => ({
    ...plane(size, res, scale),
    grad: { type: 'tex_gradient', params: { resolution: res, angle } },
    masks: { type: 'merge', in: ['grad'] },
    stack: { type: 'tex_layers', in: ['base', 'masks'], params: { padding: 2, layers: [{ name: 'ramp', mask: 'grad', height: 0.1 }] } },
  });
  /** the normal's tilt along u and v at the middle, against the slope the height ramp has in metres */
  async function slopes(size: [number, number], res: [number, number], scale: [number, number], angle: number) {
    const nodes = rampBase(size, res, scale, angle);
    const c = await cook(nodes, 'stack'), bk = img(await cook(nodes, 'base'), 'base'), gr = img(await cook(nodes, 'grad'), 'grad');
    const nm = img(c, 'stack_normal'), [W, H] = res, i = W >> 1, j = H >> 1;
    const tex = px(bk, 'texel', i, j);
    const gx = (gr.layer('C')![j * W + i + 1] - gr.layer('C')![j * W + i - 1]) / 2, gy = (gr.layer('C')![(j - 1) * W + i] - gr.layer('C')![(j + 1) * W + i]) / 2; // per texel, +v up
    const sx = (0.1 * gx) / tex[0], sy = (0.1 * gy) / tex[1];
    const n = px(nm, 'C', i, j), nx = (n[0] - 0.5) * 2, ny = (n[1] - 0.5) * 2, nz = (n[2] - 0.5) * 2;
    return { tex, sx, sy, mx: -nx / nz, my: -ny / nz };
  }
  for (const [label, size, res, scale, angle] of [['square', [2, 2], [64, 64], [4, 4], 0], ['non-square along u', [2, 1], [128, 64], [4, 2], 0], ['non-square along v', [2, 1], [128, 64], [4, 2], 90]] as const) {
    const r = await slopes([...size], [...res], [...scale], angle);
    check(Math.abs(r.mx - r.sx) < 2e-3 && Math.abs(r.my - r.sy) < 2e-3 && (Math.abs(r.sx) > 0.01 || Math.abs(r.sy) > 0.01), `${label}: the normal's slope is the ramp's slope in metres (u ${r.mx.toFixed(4)} for ${r.sx.toFixed(4)}, v ${r.my.toFixed(4)} for ${r.sy.toFixed(4)}; texel ${(r.tex[0] * 1000).toFixed(2)} × ${(r.tex[1] * 1000).toFixed(2)} mm)`);
  }
  // the texel layer: a 2 × 1 m grid mapped over the whole uv square at 128 × 64
  const bk = img(await cook(rampBase([2, 1], [128, 64], [4, 2], 0), 'base'), 'base');
  const t = px(bk, 'texel', 64, 32);
  // uv = position / [4, 2]: 4 m per uv unit along u over 128 texels, 2 m along v over 64
  check(near(t[0], 4 / 128, 1e-6) && near(t[1], 2 / 64, 1e-6), `the texel layer is metres per texel along u and v (${(t[0] * 1000).toFixed(3)} × ${(t[1] * 1000).toFixed(3)} mm)`);
  check(bk.channels('texel') === 4 && bk.layers.has('island'), 'bake_material writes texel and island');

  // a base without a texel layer reads its own size (a generator's texture_size); the old size param says where the size is now
  const noSize: Nodes = { ...flat('#808080', 32, 2), stack: { type: 'tex_layers', in: ['base', 'masks'], params: { base_roughness: 0.5, base_metallic: 0, coverage: '', layers: [{ name: 'step', mask: 'grad', height: 0.01 }] } } };
  check(!(await err(noSize, 'stack')), 'a height on a base without texel layer is made against the size of the base image');
  const e = await err({ ...noSize, stack: { ...noSize.stack, params: { ...noSize.stack.params, size: 2 } } }, 'stack');
  check(/texture_size/.test(e) && /base image/.test(e), 'the old size param errors and says where the size is now: ' + e.slice(0, 120));
  check(!(await err({ ...noSize, stack: { ...noSize.stack, params: { ...noSize.stack.params, layers: [{ name: 'c', mask: 'grad', color: '#ff0000' }] } } }, 'stack')), 'a stack without heights needs no size');

  // two islands that touch: a ramp on one leaves the other flat
  const two = (left: number): Nodes => ({
    ga: { type: 'grid', params: { size: [1, 2], divisions: [1, 1], center: [-0.5, 0, 0] } },
    gb: { type: 'grid', params: { size: [1, 2], divisions: [1, 1], center: [0.5, 0, 0] } },
    both: { type: 'merge', in: ['ga', 'gb'] },
    mat: { type: 'material', in: ['both'], params: { name: 'plain', base_color: '#808080' } },
    uv: { type: 'uv_project', in: ['mat'], params: { method: 'planar', axis: 'y', scale: [2, 2], offset: [0.5, 0.5] } },
    base: { type: 'bake_material', in: ['uv'], params: { resolution: 64, padding: 2 } },
    grad: { type: 'tex_gradient', params: { resolution: 64 } },
    masks: { type: 'merge', in: ['grad'] },
    stack: { type: 'tex_layers', in: ['base', 'masks'], params: { padding: 2, layers: [{ name: 'chip', mask: `grad * (Math.abs(base_island - ${left}) < 0.5 ? 1 : 0)`, height: 0.2 }] } },
  });
  const probeBase = img(await cook(two(0), 'base'), 'base');
  const idLeft = px(probeBase, 'island', 10, 32)[0], idRight = px(probeBase, 'island', 54, 32)[0];
  check(idLeft !== idRight, `two separate quads are two islands (${idLeft}, ${idRight})`);
  const tc = await cook(two(idLeft), 'stack');
  const nrm = img(tc, 'stack_normal'), isl = probeBase.layer('island')!, cov = probeBase.layer('mask')!;
  let rightFlat = true, leftTilt = 0, nRight = 0;
  for (let j = 0; j < 64; j++) for (let i = 0; i < 64; i++) {
    const k = j * 64 + i;
    if (!(cov[k] > 0)) continue;
    const n = nrm.layer('C')!.subarray(k * 4, k * 4 + 3);
    if (isl[k] === idRight) { nRight++; if (!(n[0] === 0.5 && n[1] === 0.5 && n[2] === 1)) rightFlat = false; } else leftTilt += Math.abs(n[0] - 0.5);
  }
  check(rightFlat && nRight > 100 && leftTilt > 1, `a ramp on one island leaves the island next to it flat (${nRight} texels, left tilt ${leftTilt.toFixed(2)})`);
}

section('tex_layers: coverage with a mask that differs outside the islands');
{
  const nodes: Nodes = {
    ...bakeNodes(),
    masks: { type: 'merge', in: ['base'] },
    // 1 outside the islands, 0 inside: an expression that ran outside would colour and lift the empty texels
    stack: {
      type: 'tex_layers', in: ['base', 'masks'],
      params: { padding: 3, layers: [{ name: 'outside', mask: '1 - base_mask', color: '#ffffff', roughness: 0.9, height: 0.2 }] },
    },
  };
  const r = await cook(nodes, 'stack');
  const col = img(r, 'stack_base_color').layer('C')!, hei = img(r, 'stack_height').layer('C')!, nrm = img(r, 'stack_normal').layer('C')!, orm = img(r, 'stack_orm').layer('C')!;
  let lit = 0, high = 0, tilt = 0, metal = 0;
  for (let k = 0; k < RES * RES; k++) {
    if (Math.min(col[k * 4], col[k * 4 + 1], col[k * 4 + 2]) > 0.01) lit++;
    if (hei[k] !== 0) high++;
    if (nrm[k * 4] !== 0.5 || nrm[k * 4 + 1] !== 0.5) tilt++;
    if (Math.abs(orm[k * 4 + 1] - 0.9) < 0.01) metal++;
  }
  check(lit === 0 && high === 0 && tilt === 0 && metal === 0, `a mask that is 1 only outside the islands reaches nothing (white ${lit}, height ${high}, tilted ${tilt}, rough ${metal})`);
}

section('tex_layers: names, helpers, signed layers, channels, once per text');
{
  const base = flat();
  // a layer that cannot be named is listed, not skipped
  const oddNames: Nodes = { ...base, odd: { type: 'tex_constant', params: { resolution: 32, value: 1, name: 'odd-name' } }, masks: { type: 'merge', in: ['ones', 'odd'] } };
  const ow = await cook(stackOf(oddNames, { layers: [{ name: 'a', mask: 'ones' }] }), 'stack');
  check(ow.warnings.some((m) => m.includes('cannot name') && m.includes('"odd-name"')), 'a mask layer an expression cannot name is warned about: ' + ow.warnings.join('; '));
  // two layers with one name: only where an expression uses it
  // image "a" with a layer "id" and an image called "a_id" both make the variable a_id
  const twin: Nodes = {
    ...base,
    a: { type: 'tex_cells', params: { resolution: 32, name: 'a' } },
    aid: { type: 'tex_constant', params: { resolution: 32, value: 1, name: 'a_id' } },
    masks: { type: 'merge', in: ['ones', 'a', 'aid'] },
  };
  check(!(await err(stackOf(twin, { layers: [{ name: 'x', mask: 'ones' }] }), 'stack')), 'two mask layers of one name are no problem while no expression uses it');
  let e = await err(stackOf(twin, { layers: [{ name: 'x', mask: 'a_id' }] }), 'stack');
  check(e.includes('two mask layers are called "a_id"'), 'they are an error where an expression uses it: ' + e);
  // an image called like a helper
  const noiseImg: Nodes = { ...base, nz: { type: 'tex_constant', params: { resolution: 32, value: 0.5, name: 'noise' } }, masks: { type: 'merge', in: ['ones', 'nz'] } };
  e = await err(stackOf(noiseImg, { layers: [{ name: 'a', mask: 'noise * 0.5' }] }), 'stack');
  check(e.includes('the image "noise" is called like the helper function noise') && e.includes('rename the image'), 'an image called like a helper is refused with a sentence: ' + e);
  check(!(await err(stackOf(noiseImg, { layers: [{ name: 'a', mask: 'ones * 0.5' }] }), 'stack')), 'an image called like a helper is fine while no expression names it');
  // a helper name used as a value
  e = await err(stackOf(base, { layers: [{ name: 'a', mask: '1', color: [[0, '#fff'], [1, '#000']], color_by: 'noise' }] }), 'stack');
  check(e.includes('layer "a": its color_by names "noise", which is a helper function') && e.includes('variables:'), 'a helper used as a value is a missing-name error: ' + e);
  // colour channels
  const rgb: Nodes = { ...flat('#336699'), };
  const ch = await cook(stackOf(rgb, { layers: [{ name: 'c', mask: 'base_b', color: '#ffffff' }, { name: 'd', mask: 'base_r', color: '#000000', opacity: 0.5 }] }), 'stack');
  const cc = px(img(ch, 'stack_base_color'), 'C', 3, 3);
  const b1 = [0.2, 0.4, 0.6].map((x) => x + (1 - x) * 0.6);
  check(near(cc[0], b1[0] * (1 - 0.1)) && near(cc[1], b1[1] * (1 - 0.1)) , `a colour image's channels are variables (${cc.slice(0, 3).map((x) => x.toFixed(3)).join(', ')})`);
  // signed
  const sg = await cook(stackOf(base, { layers: [{ name: 's', mask: 'grad * 2 - 1', roughness_offset: 0.2, height: 0.01, signed: true }] }), 'stack', serial);
  const g = img(await cook(base, 'grad'), 'grad').layer('C')!, o = img(sg, 'stack_orm').layer('C')!, hh = img(sg, 'stack_height').layer('C')!;
  let ok = true, lo = Infinity, hi = -Infinity;
  for (let k = 0; k < g.length; k++) { if (!near(o[k * 4 + 1], 0.5 + 0.2 * (2 * g[k] - 1), 1e-5)) ok = false; lo = Math.min(lo, hh[k]); hi = Math.max(hi, hh[k]); }
  check(ok && lo < -0.005 && hi > 0.005, `a signed layer makes the roughness offset and the height of either sign (height ${lo.toFixed(4)} .. ${hi.toFixed(4)})`);
  const un = await cook(stackOf(base, { layers: [{ name: 's', mask: 'grad * 2 - 1', roughness_offset: 0.2, height: 0.01 }] }), 'stack');
  const uo = img(un, 'stack_orm').layer('C')!, uh = img(un, 'stack_height').layer('C')!;
  check(Math.min(...Array.from({ length: g.length }, (_, k) => uo[k * 4 + 1])) >= 0.5 - 1e-6 && Math.min(...uh) >= 0, 'an unsigned layer still reads its mask as 0..1');
  // roughness is clamped per layer
  const cl = await cook(stackOf(base, { layers: [{ name: 'up', mask: '1', roughness_offset: 0.9 }, { name: 'down', mask: '1', roughness_offset: -0.2 }] }), 'stack');
  check(near(px(img(cl, 'stack_orm'), 'C', 0, 0)[1], 0.8, 1e-6), 'roughness is clamped after each layer (0.5 + 0.9 clamps to 1, then - 0.2)');
  // identical texts once per cook, and code that reads globalThis runs in one piece: the same with and without the pool
  const counter = '(globalThis.__calls = (globalThis.__calls || 0) + 1, (globalThis.__calls % 7) / 7)';
  const counting = stackOf(base, { layers: [{ name: 'one', mask: counter, color: '#ff0000' }, { name: 'two', mask: counter, color: '#00ff00', opacity: 0.5 }] });
  const run = async (e: Engine) => { (e.host.compile('globalThis') as any).__calls = 0; const r = await cook(counting, 'stack', e); return { r, calls: (e.host.compile('globalThis') as any).__calls as number }; };
  const s1 = await run(serial), p1 = await run(pooled);
  check(s1.calls === 32 * 32 && p1.calls === 32 * 32, `identical mask texts run once (${s1.calls} and ${p1.calls} calls for ${32 * 32} texels)`);
  check(same(img(s1.r, 'stack_base_color').layer('C')!, img(p1.r, 'stack_base_color').layer('C')!), 'code that reads globalThis gives the same with and without the pool');
}

section('tex_layers: the pool\'s limits and errors');
{
  const limited = new Engine(createNodeHost({ workers: 4, pool: { minElements: 1 } }));
  await limited.init();
  limited.scriptTimeoutMs = 400;
  const run = async (mask: string) => {
    const r = await limited.cook({ nodes: stackOf(flat(), { layers: [{ name: 'x', mask }] }), output: 'stack' });
    return r.ok ? '' : r.errors.map((x) => x.message + (x.hint ? ` (${x.hint})` : '')).join('; ');
  };
  let e = await run('while (true) {} return 1;');
  check(/layer "x" mask: expression exceeded 400 ms/.test(e), 'the time limit stops a runaway expression on the pool: ' + e);
  e = await run("(() => { throw new Error('boom'); })()");
  check(e.includes('layer "x" mask: boom'), 'an error thrown on the pool names the layer and says what it threw: ' + e);
  e = await run('no_such_layer');
  check(e.includes('layer "x": its mask names "no_such_layer"') && e.includes('variables:'), 'a missing name on the pool is the same error with the hint: ' + e);
  e = await run('1 +* 2');
  check(e.includes('layer "x" mask: expression syntax error'), 'a syntax error is found before the pool is used');
  check(limited.poolStats.parallel >= 0, 'pool stats exist');
}

section('tex_layers: named masks, the masks image, image layers, the base normal');
{
  const base = plane();
  const masks = [{ name: 'a', mask: '0.25' }, { name: 'b', mask: 'a * 2' }];
  const named: Nodes = { ...base, stack: { type: 'tex_layers', in: ['base'], params: { masks, layers: [{ name: 'red', mask: 'b', color: '#ff0000' }] } } };
  const nc = await cook(named, 'stack');
  const mi = img(nc, 'stack_masks');
  check(near(px(mi, 'a', 32, 32)[0], 0.25) && near(px(mi, 'b', 32, 32)[0], 0.5), `named masks are written as layers of <name>_masks, a later one reading an earlier one (${px(mi, 'a', 32, 32)[0]}, ${px(mi, 'b', 32, 32)[0]})`);
  const grey = px(img(await cook({ ...base, stack: { type: 'tex_layers', in: ['base'], params: { layers: [] } } }, 'stack'), 'stack_base_color'), 'C', 32, 32);
  const half = px(img(nc, 'stack_base_color'), 'C', 32, 32);
  check(near(half[0], (grey[0] + 1) / 2, 1e-4) && near(half[1], grey[1] / 2, 1e-4), `a layer mask that names a mask uses it (${half.slice(0, 3).map((v) => v.toFixed(3)).join(', ')})`);
  check(mi.layers.has('mask') && mi.layers.has('texel') && mi.layers.has('island'), 'the masks image keeps coverage, texel and island');
  const quiet = img(await cook({ ...base, stack: { type: 'tex_layers', in: ['base'], params: { masks: [{ name: 'a', mask: '0.25', write: false }, { name: 'b', mask: 'a * 2' }], layers: [] } } }, 'stack'), 'stack_masks');
  check(!quiet.layers.has('a') && Math.abs(px(quiet, 'b', 32, 32)[0] - 0.5) < 1e-6, 'write false: a mask is read by the next without being written');
  const only = await cook({ ...named, stack: { ...named.stack, params: { ...named.stack.params, outputs: 'masks' } } }, 'stack');
  check(only.geo.volumes.length === 1 && only.geo.volumes[0].name === 'stack_masks', `outputs masks writes the masks image alone (${only.geo.volumes.map((v) => v.name).join(', ')})`);
  const maps = await cook({ ...named, stack: { ...named.stack, params: { ...named.stack.params, outputs: 'maps' } } }, 'stack');
  check(!maps.geo.volumes.some((v) => v.name === 'stack_masks'), 'outputs maps leaves it out');
  const ser = img(await cook(named, 'stack', serial), 'stack_masks'), poo = img(await cook(named, 'stack', pooled), 'stack_masks');
  check(same(ser.layer('b')!, poo.layer('b')!), 'named masks are bit-identical with the pool and without it');
  const bad = async (m: unknown, layers: unknown[] = []) => err({ ...base, stack: { type: 'tex_layers', in: ['base'], params: { masks: m, layers } } }, 'stack');
  let e = await bad([{ name: 'a', mask: '1' }, { name: 'a', mask: '0' }]);
  check(e.includes('"a"') && /twice|more than once|unique/.test(e), 'two masks of one name are refused: ' + e);
  e = await bad([{ name: 'fit', mask: '1' }, { name: 'b', mask: 'fit * 2' }]);
  check(e.includes('mask "fit" is called like the helper function'), 'a mask named like a helper is refused where an expression reads it: ' + e);
  e = await bad([{ name: 'a' }]);
  check(e.includes('"a"'), 'a mask without an expression is refused: ' + e);

  // an image layer: colour and roughness from a projected image, mixed in by its mask
  const tex: Nodes = {
    ...base,
    n: { type: 'tex_noise', params: { resolution: 64, texture_size: 0.5 } },
    rg: { type: 'tex_constant', params: { resolution: 8, value: 0.35 } },
    imgs: { type: 'merge', in: ['n', 'rg'] },
    proj: { type: 'bake_triplanar', in: ['uv', 'imgs'], params: { resolution: RES, padding: 2, color: 'n', roughness: 'rg' } },
    stack: { type: 'tex_layers', in: ['base', 'proj'], params: { layers: [{ name: 'photo', mask: '1', image: 'proj' }] } },
  };
  const tc = await cook(tex, 'stack'), pr = img(await cook(tex, 'proj'), 'proj');
  const c1 = px(img(tc, 'stack_base_color'), 'C', 20, 40), p1 = px(pr, 'C', 20, 40);
  check(near(c1[0], p1[0], 1e-4) && near(c1[1], p1[1], 1e-4), `an image layer at mask 1 takes the image's colour (${c1[0].toFixed(3)} for ${p1[0].toFixed(3)})`);
  check(near(px(img(tc, 'stack_orm'), 'C', 20, 40)[1], 0.35, 1e-4), 'and its roughness');
  e = await err({ ...tex, stack: { ...tex.stack, params: { layers: [{ name: 'photo', mask: '1', image: 'nope' }] } } }, 'stack');
  check(e.includes('image "nope"') && e.includes('proj'), 'an image layer naming no image is refused with the images listed: ' + e);
  e = await err({ ...tex, stack: { ...tex.stack, params: { layers: [{ name: 'photo', mask: '1', image: 'proj', color: '#ff0000' }] } } }, 'stack');
  check(e.includes('photo'), 'a layer with both color and image is refused: ' + e);

  // the base normal (a carried normal map) is kept under the stack's own relief
  const nb: Nodes = { ...tilted('opengl', 0.5, 'uv'), stack: { type: 'tex_layers', in: ['base'], params: { layers: [] } } };
  const sn = px(img(await cook(nb, 'stack'), 'stack_normal'), 'C', 32, 32);
  check(near(sn[0], enc(0.6), 0.01) && near(sn[2], enc(0.8), 0.01), `the base normal comes through the stack (${sn.slice(0, 3).map((v) => v.toFixed(3)).join(', ')})`);
  const flatBase = px(img(await cook({ ...base, stack: { type: 'tex_layers', in: ['base'], params: { layers: [] } } }, 'stack'), 'stack_normal'), 'C', 32, 32);
  check(near(flatBase[0], 0.5, 1e-4) && near(flatBase[1], 0.5, 1e-4), 'without a base normal the normal stays flat');
}

section('tex_compact: the layers something reads, 0..1 ones in 16 bits');
{
  // the rounding is the runtime's own where it has one, and the same numbers where it does not
  const edge = [0, -0, 1, 0.1, 1 / 3, 2047, 2049, 65504, 65519, 65520, -65520, 6.1e-5, 5.96e-8, 2.98e-8, 2.99e-8, 1e-9, 0.99951171875, 1.00048828125, NaN, Infinity];
  const rnd = Array.from({ length: 20000 }, (_, i) => (Math.sin(i * 12.9898) * 43758.5453 % 1) * 10 ** ((i % 13) - 8));
  const f16 = (Math as any).f16round as ((x: number) => number) | undefined;
  if (f16) check([...edge, ...rnd].every((x) => Object.is(f16round(x), f16(x))), 'f16round is Math.f16round on every edge case and 20000 values');
  else console.log('SKIP f16round against Math.f16round: this runtime has none');
  const src = Float32Array.from([...edge, ...rnd]), h = toHalf(src);
  check(Array.from(h).every((v, i) => Object.is(v, f16round(src[i]))) && (HALF_STORED ? h.BYTES_PER_ELEMENT === 2 : h instanceof Float32Array), `toHalf holds the rounded values${HALF_STORED ? ', in 16 bits' : ' (in 32 bits: this runtime has no Float16Array)'}`);

  const nodes: Nodes = {
    box: { type: 'box', params: { size: [1, 1, 1] } },
    uv: { type: 'uv_unwrap', in: ['box'], params: { resolution: 64 } },
    a: { type: 'bake_measure', in: ['uv'], params: { resolution: 64, name: 'a', measures: [{ by: 'facing', name: 'top' }, { by: 'height', name: 'ht' }] } },
    b: { type: 'bake_measure', in: ['uv'], params: { resolution: 64, name: 'b', measures: [{ by: 'noise', name: 'grain', size: [0.2, 0.2, 0.2] }] } },
    ab: { type: 'merge', in: ['a', 'b'] },
    k: { type: 'tex_compact', in: ['ab'], params: { keep: 'C top grain texel island' } },
  };
  const before = await cook(nodes, 'ab'), after = await cook(nodes, 'k');
  const A0 = img(before, 'a'), A = img(after, 'a'), B = img(after, 'b');
  check([...A.layers.keys()].join(' ') === 'C top texel island' && !A.layer('ht') && !A.layer('mask'), `only the kept layers stay (${[...A.layers.keys()].join(' ')})`);
  const top = A.layer('top')!, top0 = A0.layer('top')!;
  check(top.every((v, i) => Math.abs(v - top0[i]) <= 3e-4 && Object.is(v, f16round(top0[i]))), 'a 0..1 layer comes back within 0.0003, rounded to 16 bits');
  const twice = await cook({ ...nodes, k2: { type: 'tex_compact', in: ['ab'], params: { keep: 'C ht texel' } } }, 'k2');
  check(A.layer('island') === A0.layer('island') && img(twice, 'a').layer('texel') === A.layer('texel'), 'island stays as it was (ids above 2048 are not exact in 16 bits), and one array made 16-bit twice is one array');
  check(after.stats.layers === 8 && after.stats.dropped === 3 && after.stats.half === 6, `stats: kept ${after.stats.layers}, dropped ${after.stats.dropped}, half ${after.stats.half}`);
  const typo = await cook({ ...nodes, k: { type: 'tex_compact', in: ['ab'], params: { keep: 'C tpo' } } }, 'k');
  check(typo.warnings.some((w) => w.includes('"tpo"')), 'a keep name no image holds is reported');
  // a filter after it works in 32 bits
  const blur = await cook({ ...nodes, k: { ...nodes.k, params: { keep: 'C top', image: 'a' } }, bl: { type: 'tex_blur', in: ['k'], params: { image: 'a', layer: 'top', blur: 0.02 } } }, 'bl');
  check(findImage(blur.geo, 'bl')?.layer('top') instanceof Float32Array, 'a filter reading a 16-bit layer writes a 32-bit one');
  // tex_layers reads compacted masks as it reads the originals, within the 16-bit rounding
  const stack = (from: string): Nodes => ({ ...nodes, mat: { type: 'material', in: ['uv'], params: { name: 'grey', base_color: '#808080' } }, base: { type: 'bake_material', in: ['mat'], params: { resolution: 64 } }, st: { type: 'tex_layers', in: ['base', from], params: { layers: [{ name: 'dust', mask: 'smoothstep(0.2, 0.8, a_top) * b_grain', color: '#a69d8b' }] } } });
  const s0 = img(await cook(stack('ab'), 'st'), 'st_base_color').layer('C')!, s1 = img(await cook(stack('k'), 'st'), 'st_base_color').layer('C')!;
  check(s0.every((v, i) => Math.abs(v - s1[i]) < 2e-3), 'a stack reading the compacted bakes makes the same maps within 0.002');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

function eq(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
