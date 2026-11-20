// weather and weather_masks. Checks what they promise: two small props (a wall cabinet, a hydrant) weather from mount and
// handled alone; every refusal names the cause and a way out; a kind comes from kinds, then the material, and keep
// leaves a part as it is; exposure and mount move the masks the way they are measured; the sliders move their masks one
// way and the seed moves where, not how much; the masks image holds every mask and an override replaces exactly its
// layer; the masks-only node writes one image per variant in the stated channels and changes no material; the
// material's maps survive at zero weathering, its normal map is carried; an image layer is a function of the surface,
// not of the uv, on a box and a cylinder; leak sources are found on a wall with a sill and a coping; packing and the
// normal convention; route B; the building kinds and growth; a slider re-cooks only the stack; serial and pooled
// results are bit-identical; the time limit stops it.
//   node test/weather.ts
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import type { NodeProgress } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import type { Geometry } from '../src/core/geometry.ts';
import { Image, findImage, sampleUV } from '../src/core/image.ts';
import { MATERIAL_ATTRIB, readMaterials, writeMaterials } from '../src/core/materials.ts';
import { exportGeometry, exportGeometryAsync } from '../src/io/export.ts';
import { importGLTFAsync } from '../src/io/gltf.ts';
import { renderGeometryAsync } from '../src/render/raster.ts';
import { renderArgs } from '../src/render/options.ts';
import { vertexUV } from '../src/core/tangents.ts';
import { triangulate } from '../src/core/topology.ts';
import { WEATHER_MASKS, leakSources } from '../src/core/weather.ts';
import { topicText } from '../src/mcp/docs.ts';
import type { GraphSpec, NodeSpec } from '../src/graph/types.ts';

let fail = 0, pass = 0;
const check = (ok: unknown, msg: string) => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
};
const section = (s: string) => console.log(`\n== ${s}`);

type Nodes = Record<string, NodeSpec>;
const serial = new Engine(createNodeHost({ workers: 0 }));
await serial.init();

interface Cooked { geo: Geometry; stats: Record<string, number>; warnings: string[] }
async function cook(nodes: Nodes, output: string, engine = serial, onNode?: (p: NodeProgress) => void): Promise<Cooked> {
  const graph: GraphSpec = { nodes, output };
  const r = await engine.cook(graph, onNode ? { onNode } : {});
  if (!r.ok || !r.geo) throw new Error(`cook failed: ${r.errors.map((x) => `[${x.node}] ${x.message}`).join('; ')}`);
  return { geo: r.geo, stats: (r.results.get(r.target) as any).stats ?? {}, warnings: r.warnings.map((w) => w.message) };
}
/** The error a cook ends with (message and hint), '' when it cooks. */
async function err(nodes: Nodes, output: string, engine = serial): Promise<{ text: string; hint: string }> {
  const r = await engine.cook({ nodes, output });
  if (r.ok) return { text: '', hint: '' };
  return { text: r.errors.map((e) => e.message).join('; '), hint: r.errors.map((e) => e.hint ?? '').join('; ') };
}
const img = (c: Cooked, name: string): Image => {
  const i = findImage(c.geo, name);
  if (!i) throw new Error(`no image "${name}" (${c.geo.volumes.map((v) => v.name).join(', ')})`);
  return i;
};
/** Mean of a one-channel layer (or one channel of C) over the covered texels. */
function mean(im: Image, layer: string, channel = 0): number {
  const a = im.layer(layer)!, ch = im.channels(layer), m = im.layer('mask');
  let s = 0, k = 0;
  for (let i = 0; i < im.width * im.height; i++) if (!m || m[i] > 0.5) { s += a[i * ch + channel]; k++; }
  return k ? s / k : 0;
}
const same = (a: Float32Array, b: Float32Array) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
const f3 = (v: number) => v.toFixed(3);

// ---------------------------------------------------------------- the props

const FAST = { resolution: 128, samples: 4, padding: 2 };
/** A box part with a name and a material of a kind. */
function part(id: string, box: { size: number[]; center: number[] }, mat: Record<string, unknown>): Nodes {
  return {
    [`${id}_g`]: { type: 'box', params: box },
    [`${id}_n`]: { type: 'wrangle', in: [`${id}_g`], params: { run_over: 'prims', code: `s@name = "${id}";` } },
    [id]: { type: 'material', in: [`${id}_n`], params: mat },
  };
}
// a wall cabinet: painted body, galvanised rain cap, stainless latch on the door
const CAB: Nodes = {
  ...part('body', { size: [0.5, 0.8, 0.3], center: [0, 0.4, 0] }, { name: 'paint', base_color: '#c9c5b8', roughness: 0.45, kind: 'painted_metal' }),
  ...part('cap', { size: [0.56, 0.03, 0.36], center: [0, 0.815, 0.02] }, { name: 'zinc', base_color: '#a4a7a8', metallic: 1, roughness: 0.4, kind: 'galvanised' }),
  ...part('latch', { size: [0.03, 0.1, 0.04], center: [0.19, 0.45, 0.17] }, { name: 'steel', base_color: '#b8b8b8', metallic: 1, roughness: 0.3, kind: 'stainless' }),
  all: { type: 'merge', in: ['body', 'cap', 'latch'] },
  uv: { type: 'uv_unwrap', in: ['all'], params: { resolution: 128, padding: 2 } },
};
const CAB_W = { mount: 'wall', wall_side: '-z', handled: '@name=latch' };
// a hydrant: cast body and bonnet, bare steel bolts (they rust and run), an operating nut on top
const HYD: Nodes = {
  body_g: { type: 'tube', params: { radius: 0.11, height: 0.6, center: [0, 0.3, 0], rows: 2, cols: 16, caps: true } },
  body_n: { type: 'wrangle', in: ['body_g'], params: { run_over: 'prims', code: 's@name = "body";' } },
  body: { type: 'material', in: ['body_n'], params: { name: 'cast', base_color: '#a8352b', roughness: 0.55, kind: 'cast_metal' } },
  ...part('bolt', { size: [0.05, 0.03, 0.05], center: [0.14, 0.12, 0] }, { name: 'bolts', base_color: '#5b5850', metallic: 1, roughness: 0.5, kind: 'bare_steel' }),
  ...part('op_nut', { size: [0.05, 0.05, 0.05], center: [0, 0.625, 0] }, { name: 'nut', base_color: '#5b5850', metallic: 1, roughness: 0.5, kind: 'bare_steel' }),
  all: { type: 'merge', in: ['body', 'bolt', 'op_nut'] },
  uv: { type: 'uv_unwrap', in: ['all'], params: { resolution: 128, padding: 2 } },
};
const HYD_W = { mount: 'ground', handled: '@name=op*' };
const W = (params: Record<string, unknown>, inputs = ['uv']): NodeSpec => ({ type: 'weather', in: inputs, params: { ...FAST, ...params } });

section('both props weather from mount and handled alone');
const cab = await cook({ ...CAB, w: W(CAB_W) }, 'w');
const hyd = await cook({ ...HYD, w: W(HYD_W) }, 'w');
for (const [label, c, kinds] of [['cabinet', cab, ['painted_metal', 'galvanised', 'stainless']], ['hydrant', hyd, ['cast_metal', 'bare_steel']]] as const) {
  const names = c.geo.volumes.map((v) => v.name);
  check(['weathered_base_color', 'weathered_normal', 'weathered_orm', 'weathered_masks'].every((n) => names.includes(n)), `${label}: base colour, normal, packed map and masks (${names.join(', ')})`);
  const t = readMaterials(c.geo).weathered;
  check(!!t?.textures?.baseColor && !!t.textures.normal && !!t.textures.orm, `${label}: material weathered uses them`);
  const ma = c.geo.prims.get(MATERIAL_ATTRIB)!;
  check([...Array(c.geo.numPrims).keys()].every((i) => ma.get(i) === 'weathered'), `${label}: every prim carries it`);
  check(kinds.every((k) => c.stats[`kind_${k}`] === 1), `${label}: kinds read from the material nodes (${Object.keys(c.stats).filter((k) => k.startsWith('kind_')).join(', ')})`);
  check(mean(img(c, 'weathered_masks'), 'handled') > 0, `${label}: handled parts found (handled mean ${f3(mean(img(c, 'weathered_masks'), 'handled'))})`);
  check(c.stats.leak_sources > 0 && c.stats.texels_per_metre > 0, `${label}: ${c.stats.leak_sources} leak sources, ${c.stats.texels_per_metre} texels per metre`);
}
check(mean(img(hyd, 'weathered_masks'), 'runs_rust') > 0, `hydrant: the bare steel bolts run rust (${f3(mean(img(hyd, 'weathered_masks'), 'runs_rust'))})`);
check(mean(img(hyd, 'weathered_masks'), 'splash') > 0, `hydrant: splash at the ground (${f3(mean(img(hyd, 'weathered_masks'), 'splash'))})`);

section('every refusal names the cause and a way out');
{
  const box = { size: [0.4, 0.4, 0.4], center: [0, 0.2, 0] };
  const painted = (extra: Record<string, unknown> = {}): Nodes => ({
    b: { type: 'box', params: box },
    m: { type: 'material', in: ['b'], params: { name: 'paint', kind: 'painted_metal', ...extra } },
    uv: { type: 'uv_unwrap', in: ['m'], params: { resolution: 128, padding: 2 } },
  });
  const cases: [string, Nodes, string, string?][] = [
    ['no polygons', { pts: { type: 'points', params: { positions: [[0, 0, 0]] } }, w: W({}, ['pts']) }, 'has no polygons'],
    ['no materials', { b: { type: 'box' }, uv: { type: 'uv_unwrap', in: ['b'] }, w: W({}) }, 'has no materials', 'material node'],
    ['an unknown kind', { ...painted(), w: W({ kinds: { paint: 'chrome' } }) }, 'unknown kind "chrome" for material "paint"', 'kinds:'],
    ['kinds not an object', { ...painted(), w: W({ kinds: ['galvanised'] }) }, 'kinds must be an object'],
    ['no kind', { b: { type: 'box' }, m: { type: 'material', in: ['b'], params: { name: 'zinc_steel' } }, uv: { type: 'uv_unwrap', in: ['m'] }, w: W({}) }, 'no kind for materials "zinc_steel"', '"zinc_steel":"galvanised"'],
    ['no uv', { ...painted(), nouv: { type: 'attrib_delete', in: ['uv'], params: { names: 'uv' } }, w: W({}, ['nouv']) }, 'has no uv', 'uv_unwrap'],
    ['every part keep', { ...painted({ kind: 'keep' }), w: W({}) }, 'every part is of kind keep'],
    ['a trim-sheet mesh', { ...painted(), t: { type: 'wrangle', in: ['uv'], params: { run_over: 'prims', code: 's@trim_sheet = "facade_trim";' } }, w: W({}, ['t']) }, 'use trim sheet "facade_trim"', 'layout: unwrap'],
    ['handled matching nothing', { ...CAB, w: W({ handled: '@name=handle*' }) }, 'handled "@name=handle*" matches no prims', 'parts:'],
    ['overlapping uv under keep', { b1: { type: 'box' }, b2: { type: 'box', params: { center: [2, 0, 0] } }, mm: { type: 'merge', in: ['b1', 'b2'] }, m: { type: 'material', in: ['mm'], params: { name: 'paint', kind: 'painted_metal' } }, w: W({ layout: 'keep' }, ['m']) }, 'overlap', 'layout: visible'],
    ['an override of a layer the stack lacks', { ...painted(), w: W({ overrides: { moss_layer: { opacity: 0 } } }) }, 'overrides names layer "moss_layer"', 'layers:'],
    ['an override that is not an object', { ...painted(), w: W({ overrides: { grime: 3 } }) }, 'overrides "grime" must be an object', 'fields:'],
    ['an override field that does not exist', { ...painted(), w: W({ overrides: { grime: { colour: '#000000' } } }) }, 'unknown field "colour"', 'fields:'],
    ['an image layer with no image', { ...painted(), w: W({ overrides: { grime: { image: 'oil', size: 0.5 } } }) }, 'image "oil" is not an image of input 3', 'input 3'],
    ['an image layer with no size', { ...painted(), oil: { type: 'tex_noise', params: { resolution: 32 } }, w: { type: 'weather', in: ['uv', null as any, null as any, 'oil'], params: { ...FAST, overrides: { grime: { image: 'oil' } } } } }, 'does not say how many metres it covers', 'size'],
    ['an input 2 layer that is no mask', { ...painted(), soot: { type: 'tex_constant', params: { resolution: 16, value: 1 } }, w: W({}, ['uv', null as any, 'soot']) }, 'layer "soot" is not a weather mask', 'masks:'],
    ['input 2 images of two sizes', { ...painted(), dust: { type: 'tex_constant', params: { resolution: 16, value: 1 } }, grime: { type: 'tex_constant', params: { resolution: 32, value: 1 } }, ov: { type: 'merge', in: ['dust', 'grime'] }, w: W({}, ['uv', null as any, 'ov']) }, 'images differ in size', 'same size'],
    ['a reference with neither colour nor image', { ...painted(), w: W({ reference: { roughness: 0.8 }, match: 0.5 }) }, 'reference says neither color nor image', 'color'],
    ['a reference colour that is no colour', { ...painted(), w: W({ reference: { color: 'brownish' }, match: 0.5 }) }, 'is not a colour', '#6b665c'],
    ['a reference image not connected', { ...painted(), w: W({ reference: { image: 'ref' }, match: 0.5 }) }, 'reference image "ref" is not an image of input 3', 'input 3'],
    ['a packing that is no layout', { ...painted(), w: W({ packing: 'oqz' }) }, 'weather: '],
    ['masks: no uv set', { ...painted(), w: { type: 'weather_masks', in: ['uv'], params: FAST } }, 'has no uv set "uv2"', 'uv_unwrap'],
    ['masks: five channels', { ...painted(), w: { type: 'weather_masks', in: ['uv'], params: { ...FAST, uv: 'uv', channels: 'dirt leaks edges coating grime' } } }, 'packs 1 to 4', 'masks:'],
    ['masks: a channel that is no mask', { ...painted(), w: { type: 'weather_masks', in: ['uv'], params: { ...FAST, uv: 'uv', channels: 'dirt soot' } } }, 'channels: "soot" is not a mask', 'masks:'],
    ['masks: a joint border that does not exist', { ...painted(), w: { type: 'weather_masks', in: ['uv'], params: { ...FAST, uv: 'uv', joints: 'left' } } }, 'joints: "left" is not a border', 'sides, bottom, top'],
    ['masks: a piece attribute that does not exist', { ...painted(), w: { type: 'weather_masks', in: ['uv'], params: { ...FAST, uv: 'uv', piece: 'kit_piece' } } }, 'no prim attribute "kit_piece"', 'prim attributes'],
    ['masks: surroundings with pieces', { ...painted(), pc: { type: 'wrangle', in: ['uv'], params: { run_over: 'prims', code: 's@piece = @primnum < 3 ? "a" : "b";' } }, ground: { type: 'grid', params: { size: [4, 4] } }, w: { type: 'weather_masks', in: ['pc', 'ground'], params: { ...FAST, uv: 'uv', piece: 'piece' } } }, 'each piece is weathered alone', 'single piece'],
    ['masks: no materials and no kind', { b: { type: 'box' }, uv: { type: 'uv_unwrap', in: ['b'] }, w: { type: 'weather_masks', in: ['uv'], params: { ...FAST, uv: 'uv' } } }, 'has no materials', 'kind'],
  ];
  for (const [label, nodes, msg, hint] of cases) {
    const e = await err(nodes, 'w');
    check(e.text.includes(msg) && (!hint || e.hint.includes(hint)), `${label}: ${e.text || 'cooked'}${e.hint ? ` (${e.hint.slice(0, 140)})` : ''}`);
  }
  // the trim sheet is weathered with its own texels when asked
  const trim = await serial.cook({ nodes: { ...painted(), t: { type: 'wrangle', in: ['uv'], params: { run_over: 'prims', code: 's@trim_sheet = "facade_trim";' } }, w: W({ layout: 'unwrap' }, ['t']) }, output: 'w' });
  check(trim.ok, 'a trim-sheet mesh cooks with layout unwrap');
}

section('kind: kinds first, then the material; keep leaves a part as it is');
{
  const two: Nodes = {
    ...part('frame', { size: [0.6, 0.6, 0.1], center: [0, 0.3, 0] }, { name: 'paint', base_color: '#556b2f', kind: 'painted_metal' }),
    ...part('glass', { size: [0.4, 0.4, 0.02], center: [0, 0.3, 0.07] }, { name: 'glass', base_color: '#88aacc', roughness: 0.05 }),
    all: { type: 'merge', in: ['frame', 'glass'] },
    uv: { type: 'uv_unwrap', in: ['all'], params: { resolution: 128, padding: 2 } },
  };
  const a = await cook({ ...two, w: W({ kinds: { glass: 'keep' } }) }, 'w');
  check(a.stats.kind_painted_metal === 1 && !a.stats.kind_concrete, 'the material node\'s kind is used when kinds does not name it');
  const b = await cook({ ...two, w: W({ kinds: { glass: 'keep', paint: 'concrete' } }) }, 'w');
  check(b.stats.kind_concrete === 1 && !b.stats.kind_painted_metal, 'kinds wins over the material node\'s kind');
  const ma = a.geo.prims.get(MATERIAL_ATTRIB)!, na = a.geo.prims.get('name')!;
  let keptOk = true, weatheredOk = true;
  for (let i = 0; i < a.geo.numPrims; i++) {
    if (na.get(i) === 'glass') keptOk &&= ma.get(i) === 'glass';
    else weatheredOk &&= ma.get(i) === 'weathered';
  }
  const t = readMaterials(a.geo);
  check(keptOk && weatheredOk && !!t.glass && !!t.weathered && !t.paint, `a part of kind keep keeps its material, the rest take weathered, unused ones go (${Object.keys(t).join(', ')})`);
}

section('exposure and mount move the masks the measured way');
{
  const m = async (params: Record<string, unknown>, scene = HYD) => img(await cook({ ...scene, w: W(params) }, 'w'), 'weathered_masks');
  const free = await m({ mount: 'free' }), ground = img(hyd, 'weathered_masks');
  check(mean(free, 'splash') === 0 && mean(ground, 'splash') > 0.02, `splash only with mount ground (${f3(mean(free, 'splash'))} free, ${f3(mean(ground, 'splash'))} ground)`);
  const indoor = await m({ ...HYD_W, exposure: 'indoor' });
  check(mean(indoor, 'runs_rust') === 0 && mean(ground, 'runs_rust') > 0, `no rust runs indoors (${f3(mean(indoor, 'runs_rust'))} indoor, ${f3(mean(ground, 'runs_rust'))} outdoor)`);
  check(mean(indoor, 'fade') < mean(ground, 'fade') * 0.5, `sun fade mostly outdoors (${f3(mean(indoor, 'fade'))} indoor, ${f3(mean(ground, 'fade'))} outdoor)`);
  const cabFree = await m({ handled: '@name=latch' }, CAB), cabWall = img(cab, 'weathered_masks');
  check(mean(cabWall, 'occlusion') < mean(cabFree, 'occlusion') - 0.01, `a wall behind it shades it (occlusion ${f3(mean(cabWall, 'occlusion'))} on the wall, ${f3(mean(cabFree, 'occlusion'))} free)`);
  const sheltered = await m({ ...CAB_W, exposure: 'sheltered' }, CAB);
  check(mean(sheltered, 'dust') > mean(cabWall, 'dust'), `dust holds where it is sheltered (${f3(mean(sheltered, 'dust'))} sheltered, ${f3(mean(cabWall, 'dust'))} outdoor)`);
}

section('sliders move their masks one way; the seed moves where, not how much');
{
  const at = async (params: Record<string, unknown>) => img(await cook({ ...HYD, w: W({ ...HYD_W, ...params }) }, 'w'), 'weathered_masks');
  for (const [slider, layer] of [['wear', 'chip'], ['dirt', 'grime'], ['rust', 'rust'], ['age', 'fade']] as const) {
    const v: number[] = [];
    for (const x of [0, 0.5, 1]) v.push(mean(await at({ [slider]: x }), layer));
    check(v[0] < v[1] && v[1] < v[2], `${slider} 0, 0.5, 1 → ${layer} ${v.map(f3).join(' < ')}`);
  }
  const s0 = await at({ wear: 1 }), s1 = await at({ wear: 1, seed: 7 });
  const a = mean(s0, 'chip'), b = mean(s1, 'chip');
  check(!same(s0.layer('chip')!, s1.layer('chip')!) && b > a * 0.6 && b < a * 1.6, `seed 7 chips other stretches, about as much (chips ${f3(a)}, ${f3(b)})`);
}

section('the masks image holds every mask; an override replaces exactly its layer');
{
  const mi = img(cab, 'weathered_masks');
  const missing = WEATHER_MASKS.filter((n) => !mi.layers.has(n));
  check(!missing.length, `weathered_masks has every named mask${missing.length ? ` (missing ${missing.join(', ')})` : ''}`);
  const ov = await cook({ ...CAB, dust: { type: 'tex_constant', params: { resolution: 16, value: 0.7 } }, w: W(CAB_W, ['uv', null as any, 'dust']) }, 'w');
  const oi = img(ov, 'weathered_masks');
  check(Math.abs(mean(oi, 'dust') - 0.7) < 0.01, `an input 2 image named dust replaces the dust mask (${f3(mean(oi, 'dust'))})`);
  check(same(oi.layer('grime')!, mi.layer('grime')!) && same(oi.layer('edge_wear')!, mi.layer('edge_wear')!), 'the other masks are bit for bit the same');
  check(!same(img(ov, 'weathered_base_color').layer('C')!, img(cab, 'weathered_base_color').layer('C')!), 'and the maps show it');
}

section('weather_masks: one packed image per variant, materials unchanged');
{
  const panel: Nodes = {
    p: { type: 'box', params: { size: [1.2, 1, 0.12], center: [0, 0.5, 0] } },
    m: { type: 'material', in: ['p'], params: { name: 'precast', base_color: '#a39e94', kind: 'concrete' } },
    uv2: { type: 'uv_unwrap', in: ['m'], params: { uv_attrib: 'uv2', resolution: 128, padding: 2 } },
  };
  const inp = await cook(panel, 'uv2');
  const one = await cook({ ...panel, w: { type: 'weather_masks', in: ['uv2'], params: { ...FAST, mount: 'ground' } } }, 'w');
  const vols = one.geo.volumes.map((v) => v.name);
  check(vols.length === 1 && vols[0] === 'weather', `one image, weather (${vols.join(', ')})`);
  const w = img(one, 'weather');
  check(w.channels('C') === 4 && ['dirt', 'leaks', 'edges', 'coating'].every((l) => w.layers.has(l)), 'C packs dirt leaks edges coating, each also a layer');
  let packed = true;
  for (const [k, l] of ['dirt', 'leaks', 'edges', 'coating'].entries()) packed &&= Math.abs(mean(w, 'C', k) - mean(w, l)) < 1e-6;
  check(packed, 'R G B A are those layers');
  check(mean(w, 'coating') === 0, 'coating lost is 0 on a bare kind');
  check(JSON.stringify(readMaterials(one.geo)) === JSON.stringify(readMaterials(inp.geo)) && one.geo.P.every((x, i) => x === inp.geo.P[i]), 'materials and points are as they came');
  const two = await cook({ ...panel, w: { type: 'weather_masks', in: ['uv2'], params: { ...FAST, channels: 'edges dirt' } } }, 'w');
  const t = img(two, 'weather');
  check(Math.abs(mean(t, 'C', 0) - mean(t, 'edges')) < 1e-6 && Math.abs(mean(t, 'C', 1) - mean(t, 'dirt')) < 1e-6 && mean(t, 'C', 3) === 1 && !t.layers.has('leaks'), 'channels "edges dirt": R edges, G dirt, A 1');
  const three = await cook({ ...panel, w: { type: 'weather_masks', in: ['uv2'], params: { ...FAST, variants: 3, wear: 1 } } }, 'w');
  const vs = ['weather', 'weather_2', 'weather_3'].map((n) => img(three, n));
  check(three.stats.variants === 3 && !same(vs[0].layer('edges')!, vs[1].layer('edges')!) && !same(vs[1].layer('edges')!, vs[2].layer('edges')!), 'variants 3: weather, weather_2, weather_3, each different');
  // painted concrete loses its coat
  const pc = await cook({ ...panel, m: { ...panel.m, params: { name: 'paint', kind: 'painted_concrete' } }, w: { type: 'weather_masks', in: ['uv2'], params: { ...FAST, wear: 1 } } }, 'w');
  check(mean(img(pc, 'weather'), 'coating') > 0, `painted concrete loses its coat (${f3(mean(img(pc, 'weather'), 'coating'))})`);
  // borders: water from the top edge, joints
  const src = await cook({ ...panel, w: { type: 'weather_masks', in: ['uv2'], params: { ...FAST, above: 'source', channels: 'leaks joints' } } }, 'w');
  const open = await cook({ ...panel, w: { type: 'weather_masks', in: ['uv2'], params: { ...FAST, channels: 'leaks joints' } } }, 'w');
  check(mean(img(src, 'weather'), 'leaks') > mean(img(open, 'weather'), 'leaks'), `above source runs more water down the face (${f3(mean(img(src, 'weather'), 'leaks'))}, open ${f3(mean(img(open, 'weather'), 'leaks'))})`);
  const jn = await cook({ ...panel, w: { type: 'weather_masks', in: ['uv2'], params: { ...FAST, channels: 'leaks joints', joints: 'sides bottom' } } }, 'w');
  check(mean(img(open, 'weather'), 'joints') === 0 && mean(img(jn, 'weather'), 'joints') > 0, `joints "sides bottom" darken their borders (${f3(mean(img(jn, 'weather'), 'joints'))})`);
  // a kit: each piece weathered alone (no shadow from the neighbour)
  const kit: Nodes = {
    a: { type: 'box', params: { size: [1, 1, 0.1], center: [0, 0.5, 0] } },
    b: { type: 'box', params: { size: [1, 0.1, 0.6], center: [0, 1.06, 0.25] } },
    ab: { type: 'merge', in: ['a', 'b'] },
    pc: { type: 'wrangle', in: ['ab'], params: { run_over: 'prims', code: 's@kit_piece = @primnum < 6 ? "wall" : "shelf";' } },
    m: { type: 'material', in: ['pc'], params: { name: 'precast', kind: 'concrete' } },
    uv2: { type: 'uv_unwrap', in: ['m'], params: { uv_attrib: 'uv2', resolution: 128, padding: 2 } },
  };
  const joined = await cook({ ...kit, w: { type: 'weather_masks', in: ['uv2'], params: { ...FAST, channels: 'occlusion' } } }, 'w');
  const alone = await cook({ ...kit, w: { type: 'weather_masks', in: ['uv2'], params: { ...FAST, channels: 'occlusion', piece: 'kit_piece' } } }, 'w');
  check(alone.stats.pieces === 2 && mean(img(alone, 'weather'), 'occlusion') > mean(img(joined, 'weather'), 'occlusion') + 0.005, `piece: each piece is weathered alone, the shelf no longer shades the wall (occlusion ${f3(mean(img(alone, 'weather'), 'occlusion'))}, joined ${f3(mean(img(joined, 'weather'), 'occlusion'))})`);
  const pv = await cook({ ...panel, w: { type: 'weather_masks', in: ['uv2'], params: { ...FAST, preview: true } } }, 'w');
  check(!!findImage(pv.geo, 'weather_preview_base_color') && pv.geo.prims.get(MATERIAL_ATTRIB)?.get(0) === 'weather_preview' && pv.warnings.some((x) => x.includes('for looking')), 'preview adds a material for looking, and says so');
}

section('the material\'s maps survive zero weathering; its normal map is carried');
{
  const ZERO = { wear: 0, dirt: 0, rust: 0, age: 0, leak_density: 0, layout: 'keep' };
  const tiled: Nodes = {
    b: { type: 'box', params: { size: [0.6, 0.6, 0.6], center: [0, 0.3, 0] } },
    look: { type: 'tex_noise', params: { resolution: 64, texture_size: 1, feature: 0.25, tileable: true } },
    hgt: { type: 'tex_noise', params: { resolution: 64, texture_size: 1, feature: 0.1, tileable: true } },
    bump: { type: 'tex_normal_from_height', in: ['hgt'], params: { depth: 0.12 } },
    withimg: { type: 'merge', in: ['b', 'look', 'bump'] },
    m: { type: 'material', in: ['withimg'], params: { name: 'paint', kind: 'painted_metal', base_color_map: 'image:look', normal_map: 'image:bump', tile: 1 } },
    uv: { type: 'uv_unwrap', in: ['m'], params: { resolution: 128, padding: 2 } },
    base: { type: 'bake_material', in: ['uv'], params: { resolution: 128, padding: 2, map_uv: 'uv', name: 'base' } },
  };
  const wz = await cook({ ...tiled, w: W(ZERO) }, 'w');
  const base = img(await cook(tiled, 'base'), 'base');
  const wb = img(wz, 'weathered_base_color');
  const d = [0, 1, 2].map((c) => Math.abs(mean(wb, 'C', c) - mean(base, 'C', c)));
  check(Math.max(...d) < 0.01, `at zero weathering the base colour is the material's map (mean differs by ${d.map(f3).join(', ')})`);
  const nm = img(wz, 'weathered_normal'), a = nm.layer('C')!, msk = nm.layer('mask')!;
  let dev = 0;
  for (let i = 0; i < nm.width * nm.height; i++) if (msk[i] > 0.5) dev = Math.max(dev, Math.abs(a[i * 4] - 0.5));
  check(dev > 0.05, `the material's normal map comes through (largest tilt ${f3(dev)})`);
}

section('an image layer is a function of the surface, not of the uv (box, cylinder)');
{
  // grime's mask forced to 1 by input 2, its colour from a photo in metres: the base colour is the photo, in 3D
  for (const [label, shape] of [['box', { type: 'box', params: { size: [0.6, 0.6, 0.6], center: [0, 0.3, 0] } }], ['cylinder', { type: 'tube', params: { radius: 0.25, height: 0.7, center: [0, 0.35, 0], rows: 2, cols: 24, caps: true } }]] as const) {
    const nodes: Nodes = {
      s: shape as NodeSpec,
      m: { type: 'material', in: ['s'], params: { name: 'paint', kind: 'painted_metal' } },
      uv: { type: 'uv_unwrap', in: ['m'], params: { resolution: 256, padding: 2 } },
      photo: { type: 'tex_noise', params: { resolution: 128, texture_size: 0.5, feature: 0.12, tileable: true } },
      grime: { type: 'tex_constant', params: { resolution: 8, value: 1 } },
    };
    const params = { resolution: 256, samples: 4, padding: 4, wear: 0, dirt: 0, rust: 0, age: 0, leak_density: 0, overrides: { grime: { image: 'photo', opacity: 1 } } };
    const run = async (layout: string) => cook({ ...nodes, w: { type: 'weather', in: ['uv', null as any, 'grime', 'photo'], params: { ...params, layout } } }, 'w');
    const [k, v] = [await run('keep'), await run('visible')];
    const sample = (c: Cooked) => {
      const g = c.geo, uv = vertexUV(g, 'uv')!, t = triangulate(g), im = img(c, 'weathered_base_color'), C = im.layer('C')!, out: number[] = [], px = [0, 0, 0, 0];
      for (let i = 0; i < t.tris.length; i += 3) {
        // the centroid and points a third of the way to each corner: inside the triangle, away from island borders
        for (const w of [[1 / 3, 1 / 3, 1 / 3], [0.6, 0.2, 0.2], [0.2, 0.6, 0.2], [0.2, 0.2, 0.6]]) {
          const u = w[0] * uv[t.tris[i] * 2] + w[1] * uv[t.tris[i + 1] * 2] + w[2] * uv[t.tris[i + 2] * 2];
          const vv = w[0] * uv[t.tris[i] * 2 + 1] + w[1] * uv[t.tris[i + 1] * 2 + 1] + w[2] * uv[t.tris[i + 2] * 2 + 1];
          sampleUV(C, 4, im.width, im.height, u, vv, px, false);
          out.push(px[0]);
        }
      }
      return out;
    };
    const a = sample(k), b = sample(v);
    const diff = a.map((x, i) => Math.abs(x - b[i])).sort((x, y) => x - y);
    const p95 = diff[Math.floor(diff.length * 0.95)];
    let spread = 0;
    for (const x of a) spread = Math.max(spread, Math.abs(x - a[0]));
    check(a.length === b.length && p95 < 0.03 && spread > 0.05, `${label}: the same 3D points agree across two uv layouts (95 % within ${f3(p95)}, the photo spans ${f3(spread)}): no uv seam`);
  }
}

section('leak sources: a wall with a sill and a coping');
{
  const wall: Nodes = {
    w: { type: 'box', params: { size: [3, 2.8, 0.25], center: [0, 1.4, 0] } },
    sill: { type: 'box', params: { size: [1.2, 0.05, 0.14], center: [0, 1.0, 0.195] } },
    coping: { type: 'box', params: { size: [3.1, 0.06, 0.4], center: [0, 2.83, 0] } },
    all: { type: 'merge', in: ['w', 'sill', 'coping'] },
  };
  const g = (await cook(wall, 'all')).geo;
  const l = leakSources(g, { density: 30, seed: 0, rain: true, max: 4000 });
  const P = l.points.P, ys: number[] = [];
  for (let i = 0; i < l.points.numPoints; i++) ys.push(P[i * 3 + 1]);
  const onSill = ys.filter((y) => Math.abs(y - 1.025) < 0.01).length, onCoping = ys.filter((y) => Math.abs(y - 2.86) < 0.01).length;
  check(l.count.ledge > 0 && onSill > 0 && onCoping > 0, `ledges found: ${onSill} on the sill, ${onCoping} on the coping (${l.count.ledge} ledge points)`);
  const underCoping = ys.filter((y) => y > 2.78 && y < 2.8).length, underSill = ys.filter((y) => y > 0.96 && y < 0.975).length;
  check(l.count.under > 0 && underCoping > 0 && underSill > 0, `the wall under the coping and under the sill (separate pieces) is a source: ${underCoping}, ${underSill}`);
  check(!ys.some((y) => y < 0.9), 'nothing on the plain wall below the sill');
  // drip points gather: at the ends of the coping's front edge and around a few spots along it, not evenly spaced
  const xs: number[] = [];
  for (let i = 0; i < l.points.numPoints; i++) if (Math.abs(P[i * 3 + 1] - 2.856) < 0.005 && Math.abs(P[i * 3 + 2] - 0.2) < 0.005) xs.push(P[i * 3]);
  const bins = new Array(31).fill(0);
  for (const x of xs) bins[Math.min(30, Math.max(0, Math.floor((x + 1.55) / 0.1)))]++;
  const meanBin = xs.length / 31, ends = bins[0] + bins[30];
  const empty = bins.filter((b) => b === 0).length, top = Math.max(...bins);
  check(xs.length > 20 && ends > 4 * meanBin && top > 3 * meanBin && empty > 5, `the coping's drips cluster: ${xs.length} along its front edge, ${ends} in the 10 cm at its two ends (${(2 * meanBin).toFixed(1)} if even), the fullest 10 cm holds ${top}, ${empty} of 31 hold none`);
  const w = l.points.points.get('w');
  check(!!w && [...Array(l.points.numPoints).keys()].every((i) => (w.get(i) as number) > 0 && (w.get(i) as number) <= 1), 'each source carries its rain weight w');
}

section('packing and the normal convention');
{
  const hro = await cook({ ...CAB, w: W({ ...CAB_W, packing: 'hro', normal_format: 'directx' }) }, 'w');
  const t = readMaterials(hro.geo).weathered;
  check(!!findImage(hro.geo, 'weathered_hro') && !findImage(hro.geo, 'weathered_orm') && t.packing === 'hro' && t.normalFormat === 'directx', `packing hro writes weathered_hro and says so; normal_format directx (${t.packing}, ${t.normalFormat})`);
  const H = img(hro, 'weathered_hro'), O = img(cab, 'weathered_orm');
  check(Math.abs(mean(H, 'C', 1) - mean(O, 'C', 1)) < 1e-6 && Math.abs(mean(H, 'C', 2) - mean(O, 'C', 0)) < 1e-6, 'G is roughness, B occlusion');
  const dx = img(hro, 'weathered_normal').layer('C')!, gl = img(cab, 'weathered_normal').layer('C')!;
  let flipped = true, tilted = 0;
  for (let i = 1; i < gl.length; i += 4) { flipped &&= Math.abs(dx[i] - (1 - gl[i])) < 1e-6 && dx[i - 1] === gl[i - 1]; if (Math.abs(gl[i] - 0.5) > 0.002) tilted++; }
  check(flipped && tilted > 0, `the directx normal's green is 1 − the opengl one on every texel (${tilted} tilted texels)`);

  // exporters and the preview read the stated layout: glTF holds its own convention, so the maps are rewritten in it
  const glb = async (g: Geometry) => importGLTFAsync(await exportGeometryAsync(g, 'glb'));
  const mrao = await cook({ ...CAB, w: W({ ...CAB_W, packing: 'mrao', normal_format: 'directx' }) }, 'w');
  const [back, ref] = [await glb(mrao.geo), await glb(cab.geo)];
  const bt = readMaterials(back).weathered;
  // within one 8-bit step for the normal: 1 − g rounds the other way at exact halves
  const same = (a: Image | null, b: Image | null, tol = 1e-6) => !!a && !!b && a.layer('C')!.every((v, i) => Math.abs(v - b.layer('C')![i]) < tol);
  check(same(findImage(back, 'weathered_mrox_gltf'), findImage(ref, 'weathered_orm')) && same(findImage(back, 'weathered_normal_gltf'), findImage(ref, 'weathered_normal'), 1.01 / 255)
    && bt.packing === undefined && bt.normalFormat === undefined && bt.textures?.orm === 'image:weathered_mrox_gltf',
  'glb: the mrao map is written as the orm of glTF and the directx normal as opengl, the same maps as the default layout; the material read back names them');
  const usda = new TextDecoder().decode(exportGeometry(hro.geo, 'usda'));
  check(/inputs:roughness\.connect = <[^>]*orm_map\.outputs:g>/.test(usda) && /inputs:occlusion\.connect = <[^>]*orm_map\.outputs:b>/.test(usda) && !/inputs:metallic\.connect/.test(usda)
    && /inputs:scale = \(2, -2, 2, 1\)/.test(usda), 'usda: roughness from G and occlusion from B of the hro map, no metallic channel, the directx normal read with green flipped');
  const smooth = hro.geo.clone();
  writeMaterials(smooth, { ...readMaterials(smooth), weathered: { ...t, packing: 'mask_map' } });
  check(/inputs:roughness\.connect = <[^>]*smoothness_map\.outputs:a>/.test(new TextDecoder().decode(exportGeometry(smooth, 'usda'))), 'usda: smoothness in A is read inverted');
  const shot = async (g: Geometry) => (await renderGeometryAsync(g, renderArgs({ shading: 'pbr', textures: true, views: 'persp', size: 96, grid: false, footer: false }))).rgba;
  const [a, b] = [await shot(mrao.geo), await shot(cab.geo)];
  check(a.every((v, i) => Math.abs(v - b[i]) <= 1), 'the preview of the mrao + directx maps is the preview of the default layout');
}

section('route B: unique maps pulled toward a stated reference');
{
  const ZERO = { wear: 0, dirt: 0, rust: 0, age: 0, leak_density: 0, layout: 'keep' };
  const before = img(await cook({ ...CAB, w: W({ ...CAB_W, ...ZERO }) }, 'w'), 'weathered_base_color');
  const pulled = await cook({ ...CAB, w: W({ ...CAB_W, ...ZERO, reference: { color: '#3a3630', roughness: 0.85 }, match: 1 }) }, 'w');
  const after = img(pulled, 'weathered_base_color');
  const lum = (im: Image) => (mean(im, 'C', 0) + mean(im, 'C', 1) + mean(im, 'C', 2)) / 3;
  const target = ((0x3a / 255) ** 2.2 + (0x36 / 255) ** 2.2 + (0x30 / 255) ** 2.2) / 3;
  check(pulled.stats.match === 1 && Math.abs(lum(after) - target) < Math.abs(lum(before) - target) * 0.5, `the mean colour moves toward the reference (${f3(lum(before))} → ${f3(lum(after))}, reference about ${f3(target)})`);
  check(mean(img(pulled, 'weathered_orm'), 'C', 1) > mean(img(await cook({ ...CAB, w: W({ ...CAB_W, ...ZERO }) }, 'w'), 'weathered_orm'), 'C', 1), 'and the roughness toward its roughness');
}

section('the building kinds; growth');
{
  const slab = (kind: string): Nodes => ({
    s: { type: 'box', params: { size: [1, 1.2, 0.15], center: [0, 0.6, 0] } },
    m: { type: 'material', in: ['s'], params: { name: 'surface', base_color: '#9c978c', kind } },
    uv: { type: 'uv_unwrap', in: ['m'], params: { resolution: 128, padding: 2 } },
  });
  for (const kind of ['concrete', 'painted_concrete', 'painted_plaster', 'painted_wood', 'painted_metal', 'asphalt']) {
    const c = await cook({ ...slab(kind), w: W({ mount: 'ground', age: 1 }) }, 'w');
    check(c.stats[`kind_${kind}`] === 1 && !!findImage(c.geo, 'weathered_base_color'), `${kind} weathers`);
  }
  const out = await cook({ ...slab('concrete'), w: W({ mount: 'ground', age: 1 }) }, 'w');
  const ind = await cook({ ...slab('concrete'), w: W({ mount: 'ground', age: 1, exposure: 'indoor' }) }, 'w');
  check(mean(img(out, 'weathered_masks'), 'growth') > 0 && mean(img(ind, 'weathered_masks'), 'growth') === 0, `growth on concrete outdoors, none indoors (${f3(mean(img(out, 'weathered_masks'), 'growth'))})`);
}

section('a slider re-cooks only the stack');
{
  const e = new Engine(createNodeHost({ workers: 0 }));
  await e.init();
  const ran = async (params: Record<string, unknown>) => {
    const inner = new Set<string>();
    await cook({ ...HYD, w: W({ ...HYD_W, ...params }) }, 'w', e, (p) => { if (p.phase === 'end' && p.within[0] === 'w') inner.add(p.node); });
    return [...inner].sort();
  };
  const first = await ran({});
  check(first.includes('measure') && first.includes('atlas') && first.includes('stack'), `the first cook runs every step (${first.join(', ')})`);
  const wear = await ran({ wear: 0.9 });
  check(wear.length > 0 && wear.every((n) => ['stack', 'out', 'mask_images', 'wear', 'wear_kept'].includes(n)), `wear re-cooks the edge wear threshold, the stack and the material only (${wear.join(', ')})`);
  const seed = await ran({ wear: 0.9, seed: 3 });
  check(seed.includes('noise') && !seed.includes('measure') && !seed.includes('atlas') && !seed.includes('base'), `seed re-cooks the noise and the runs, not the measures or the atlas (${seed.join(', ')})`);
}

section('serial and pooled results are bit-identical');
{
  const pooled = new Engine(createNodeHost({ workers: 4, pool: { minElements: 1 } }));
  await pooled.init();
  const p = await cook({ ...CAB, w: W(CAB_W) }, 'w', pooled);
  check(same(img(p, 'weathered_base_color').layer('C')!, img(cab, 'weathered_base_color').layer('C')!) && same(img(p, 'weathered_orm').layer('C')!, img(cab, 'weathered_orm').layer('C')!) && same(img(p, 'weathered_masks').layer('chip')!, img(cab, 'weathered_masks').layer('chip')!), 'base colour, packed map and masks match bit for bit');
}

section('the help topic: one worked example per mode, each cooks');
{
  const text = topicText('weathering') ?? '';
  const graphs = [...text.matchAll(/^  (\{"nodes": \{[\s\S]*?"output": "\w+"\})/gm)].map((m) => JSON.parse(m[1]) as GraphSpec);
  check(graphs.length === 2, `the topic holds ${graphs.length} graphs`);
  for (const g of graphs) {
    const out = g.nodes[g.output!];
    out.params = { ...out.params, resolution: 128, samples: 4 };
    const r = await serial.cook(g);
    check(r.ok, `${out.type}: the worked example cooks${r.ok ? '' : ` (${r.errors.map((e) => e.message).join('; ')})`}`);
  }
}

section('the time limit stops it');
{
  const e = new Engine(createNodeHost({ workers: 0 }));
  await e.init();
  e.simTimeoutMs = 200;
  const t0 = performance.now();
  const r = await err({ ...CAB, w: { type: 'weather', in: ['uv'], params: { ...CAB_W, resolution: 1024, samples: 64 } } }, 'w', e);
  const ms = performance.now() - t0;
  check(r.text.includes('stopped after') && r.text.includes('time limit') && ms < 30000, `stops with the limit named (${ms.toFixed(0)} ms): ${r.text.slice(0, 160)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
