// weather and weather_masks: one node each for weathering a model, built from the bakes and the layer stack. Both
// prepare the mesh here (kinds, parts, the planes a stated mount or border adds, where water leaks from) and cook the
// graph src/core/weather.ts builds with ctx.subcook, so every inner node is cached by its own signature: a slider
// (dirt, rust, age) reaches only tex_layers and re-cooks only it; wear also re-cooks the chip threshold of the edge wear
// bake (its wear field is kept); seed also re-cooks the noise bake, the edge wear and the runs.
//
//   weather         the maps: base colour, normal and a packed map on one material over every weathered part, the
//                   masks image beside them; parts of kind keep keep their own material
//   weather_masks   one packed mask image (dirt, leaks, worn edges, coating lost by default) per variant on a uv set
//                   the user lays out, materials unchanged: for an engine material that blends its own tiling
//                   textures; pieces of a kit are weathered each as if alone
import { Geometry } from '../core/geometry.ts';
import { Image, findImage, imagesOf, referenceableImages } from '../core/image.ts';
import { MATERIAL_ATTRIB, normalizeMaterial, parsePacking, readMaterials, resolveKind, writeMaterials } from '../core/materials.ts';
import type { Material, PackedChannel } from '../core/materials.ts';
import { hashString } from '../core/random.ts';
import { vertexUV } from '../core/tangents.ts';
import { connectivity, triangulate } from '../core/topology.ts';
import { uvOverlapCheck } from '../core/uvoverlap.ts';
import { EXPOSURE, OVERRIDE_FIELDS, PACKABLE, PACKED_MASKS, WEATHER_KINDS, WEATHER_MASKS, coverPlane, jointPlanes, kindLayers, leakSources, mountPlane, sharedLayers, suggestKind, weatherGraph, weatherScale, weatherVars } from '../core/weather.ts';
import type { Box, Exposure, GraphOptions, PhotoLayer } from '../core/weather.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import type { CookContext, GraphSpec, ParamDef } from '../graph/types.ts';
import type { CookReport, SubInput } from '../graph/engine.ts';
import { P, mask, simBudget } from './util.ts';

import { RUSTING_KINDS } from '../core/weather.ts';
const RUST_SOURCES: readonly string[] = RUSTING_KINDS;

/** The params both nodes share. */
const SHARED = (): Record<string, ParamDef> => ({
  wear: { type: 'float', default: 0.5, min: 0, max: 1, desc: 'chipped and worn edges, wear where hands and tools touch', aliases: ['edge_wear', 'chips'] },
  dirt: { type: 'float', default: 0.5, min: 0, max: 1, desc: 'grime in cavities, dust on tops, splash at the ground, dirt runs below ledges', aliases: ['grime'] },
  rust: { type: 'float', default: 0.5, min: 0, max: 1, desc: 'rust in chips and on bare steel, rust runs below rusting parts', aliases: ['corrosion'] },
  age: { type: 'float', default: 0.5, min: 0, max: 1, desc: '0 new, 0.5 about ten years, 1 decades: sun fade, chalking, zinc dulling, greying wood, moss; it also scales the other three', aliases: ['years'] },
  seed: { type: 'int', default: 0, min: 0, max: 2147483647, desc: 'changes where things happen (which stretches of an edge chip, where runs start, the patches), not how much' },
  exposure: { type: 'enum', options: ['outdoor', 'sheltered', 'indoor'], default: 'outdoor', desc: 'outdoor: rain runs, sun fade, washed tops, splash, moss; sheltered: dust holds, little rain; indoor: no rain or rust runs, dust, more handling (water marks only below windows and at ceiling corners)' },
  mount: { type: 'enum', options: ['free', 'ground', 'wall'], default: 'free', desc: 'what the object stands on, stated, never guessed: ground = a plane at the lowest point (splash band, contact grime); wall = a plane at the wall_side of the bounding box (the back is hidden: few texels, no wear; dust gathers against it); input 1 replaces the plane' },
  wall_side: { type: 'enum', options: ['-z', '+z', '-x', '+x'], default: '-z', desc: 'mount wall: the side of the bounding box on the wall' },
  kinds: { type: 'json', default: {}, desc: 'kind per material name, e.g. {"zinc_steel": "galvanised", "glass": "keep"}; wins over the material\'s own kind (kinds: ' + WEATHER_KINDS.join(', ') + ')', aliases: ['material_kinds'] },
  handled: P.group('prim', 'parts hands and tools touch ("@name=handle*"): they wear more and stainless smudges there; "" = none (never guessed from names)'),
  sun: { type: 'vec3', default: [0, 1, 0], desc: 'where the sun comes from (fade, chalk, greying): straight up by default, a model does not know where south is' },
  padding: { type: 'int', default: 4, min: 0, max: 64, desc: 'texels the islands are padded by', aliases: ['dilation'] },
  samples: { type: 'int', default: 32, min: 4, max: 256, desc: 'rays per cloud point of the occlusion, cavity, shelter and visibility bake' },
  leak_density: { type: 'float', default: 120, min: 0, max: 500, desc: 'run starts per metre of ledge, sill, coping or overhang edge, and per metre where a rusting part meets the surface (0 = no runs): most runs are faint, a few strong, and under a long edge they merge into a wash', aliases: ['runs_per_metre'] },
});

// ---------------------------------------------------------------- preparation

interface Prepared {
  /** the weathered prims, with uv_maps (the uv the maps use), wpart (a 0..1 hash per part) and wrust (1 on rust sources) */
  mesh: Geometry;
  /** the prims of kind keep, as they are */
  kept: Geometry | null;
  kinds: Record<string, string>;
  present: string[];
  bbox: Box;
  scale: ReturnType<typeof weatherScale>;
  rustSources: boolean;
  partsHint: string;
}

const T_W = 'weather', T_M = 'weather_masks';
const list = (a: string[], max = 10) => a.slice(0, max).map((x) => `"${x}"`).join(', ') + (a.length > max ? `, … ${a.length - max} more` : '');

function bboxOf(g: Geometry): Box {
  const b = g.bbox();
  return { min: [...b.min], max: [...b.max] };
}

/** Part name per prim: its name attribute, else its connected piece. */
function partsOf(g: Geometry): { id: string[]; names: string[] } {
  const na = g.prims.get('name');
  const id: string[] = [];
  if (na && na.type === 'string') for (let p = 0; p < g.numPrims; p++) id.push(String(na.get(p) ?? ''));
  else { const c = connectivity(g); for (let p = 0; p < g.numPrims; p++) id.push(`piece ${c.primClass[p]}`); }
  return { id, names: [...new Set(id)] };
}

function prepare(ctx: CookContext, T: string, o: { uv: string; layout: string; fallbackKind?: string }): Prepared {
  const { p } = ctx;
  const g = ctx.input(0);
  if (!g.numPrims) throw new NodeError(`${T}: input 0 has no polygons`);
  const table = readMaterials(g), matA = g.prims.get(MATERIAL_ATTRIB);
  const kindsParam = p.kinds && typeof p.kinds === 'object' && !Array.isArray(p.kinds) ? (p.kinds as Record<string, unknown>) : null;
  if (p.kinds && !kindsParam) throw new NodeError(`${T}: kinds must be an object of material name → kind`, `e.g. {"zinc_steel": "galvanised"}; kinds: ${WEATHER_KINDS.join(', ')}`);
  const names = new Set<string>();
  if (matA) for (let i = 0; i < g.numPrims; i++) { const n = String(matA.get(i) ?? ''); if (n) names.add(n); }
  if (!names.size && !o.fallbackKind) throw new NodeError(`${T}: the input has no materials; it reads each part's material to choose how it ages`, `assign materials (material node, with its kind param)${T === T_M ? ', or say the kind of every part with kind' : ''}`);
  // a kind per material, never guessed
  const kinds: Record<string, string> = {}, missing: string[] = [];
  for (const n of names) {
    const r = resolveKind(n, table[n], kindsParam);
    if (r.unknown) throw new NodeError(`${T}: unknown kind "${r.unknown}" for material "${n}"`, `kinds: ${WEATHER_KINDS.join(', ')}`);
    if (r.kind) kinds[n] = r.kind;
    else if (o.fallbackKind) kinds[n] = o.fallbackKind;
    else missing.push(n);
  }
  if (missing.length) {
    const sug: Record<string, string> = {};
    for (const n of missing) sug[n] = suggestKind(n);
    throw new NodeError(`${T}: no kind for materials ${list(missing)}; it does not guess from names`, `kinds: ${JSON.stringify(sug)} (suggested from the names: check them), or set kind on the material node, or "keep" to leave a part as it is`);
  }
  const kindOf = (prim: number) => (matA ? kinds[String(matA.get(prim) ?? '')] : undefined) ?? o.fallbackKind ?? 'keep';
  if (!vertexUV(g, o.uv)) throw new NodeError(`${T}: input 0 has no ${o.uv === 'uv' ? 'uv' : `uv set "${o.uv}"`}`, o.uv === 'uv' ? 'uv_unwrap first' : `lay out the uv the masks go on as "${o.uv}" (uv_unwrap or uv_layout, then attrib_rename uv → ${o.uv}), or set uv`);
  const parts = partsOf(g);
  const partsHint = `parts: ${list(parts.names, 14)}`;
  const weathered = new Uint8Array(g.numPrims);
  let nw = 0;
  for (let i = 0; i < g.numPrims; i++) if (kindOf(i) !== 'keep') { weathered[i] = 1; nw++; }
  if (!nw) throw new NodeError(`${T}: every part is of kind keep: nothing to weather`, 'give the parts that age a kind (kinds or the material node)');
  // trim-sheet prims share the sheet's texels: they cannot each get their own weathering on it
  const trim = g.prims.get('trim_sheet');
  if (trim && o.layout !== 'unwrap') {
    const sheets = new Set<string>(), onIt = new Set<string>();
    for (let i = 0; i < g.numPrims; i++) { const s = String(trim.get(i) ?? ''); if (s && weathered[i]) { sheets.add(s); onIt.add(parts.id[i]); } }
    if (sheets.size) {
      const mats = [...new Set([...Array(g.numPrims).keys()].filter((i) => weathered[i] && String(trim.get(i) ?? '')).map((i) => String(matA?.get(i) ?? '')))];
      throw new NodeError(`${T}: prims of parts ${list([...onIt])} use trim sheet ${list([...sheets])} and share its texels`, `kinds: {${mats.map((m) => `"${m}": "keep"`).join(', ')}} leaves them on the sheet, or layout: unwrap gives them their own texels`);
    }
  }
  const handled = String(p.handled ?? '').trim();
  if (handled) {
    const sel = mask(g, 'prim', handled);
    if (sel && !sel.some((v) => v)) throw new NodeError(`${T}: handled "${handled}" matches no prims`, partsHint);
  }
  const mesh = g.subsetPrims(weathered);
  const kept = nw < g.numPrims ? g.subsetPrims(weathered.map((v) => 1 - v)) : null;
  // uv overlaps in the bake uv: every texel is painted once
  if (o.layout === 'keep') {
    const uv = vertexUV(mesh, o.uv)!, tri = triangulate(mesh);
    const chk = uvOverlapCheck(uv, tri.tris, tri.triPrim, new Int32Array(mesh.numPrims));
    const n = chk.within + chk.across;
    if (n) {
      const mp = partsOf(mesh), hit = new Set<string>();
      for (const f of [chk.firstWithin, chk.firstAcross]) if (f) for (const t of f.t) hit.add(mp.id[tri.triPrim[t]]);
      throw new NodeError(`${T}: uv of parts ${list([...hit])} overlap (${n} triangle pairs); every texel is painted once`, T === T_W ? 'layout: visible re-packs separate islands; folds inside an island need layout: unwrap' : `lay out ${o.uv} without overlaps (uv_layout, or uv_unwrap)`);
    }
  }
  // the uv the maps use travels as uv_maps; per part a hash and whether it sources rust runs
  const src = mesh.findAttrib(o.uv === 'uv' ? 'uv' : 'uv', ['vertex', 'point']);
  if (src) mesh.table(src.cls).set('uv_maps', src.attr.clone());
  const mp = partsOf(mesh), mm = mesh.prims.get(MATERIAL_ATTRIB);
  const wpart = mesh.prims.add('wpart', 'float', 1), wrust = mesh.prims.add('wrust', 'float', 1);
  const present = new Set<string>();
  let rusting = 0;
  for (let i = 0; i < mesh.numPrims; i++) {
    wpart.set(i, (hashString(mp.id[i]) >>> 0) / 4294967296);
    const k = (mm ? kinds[String(mm.get(i) ?? '')] : undefined) ?? o.fallbackKind ?? 'keep';
    present.add(k);
    const r = RUST_SOURCES.includes(k) || (k === 'galvanised' && Number(p.rust) > 0.6) ? 1 : 0;
    wrust.set(i, r);
    rusting += r;
  }
  if (!matA || !names.size) {
    // masks mode with a stated kind and no materials: one material for the bakes to read
    const t = readMaterials(mesh);
    t.weather_part = normalizeMaterial({ kind: o.fallbackKind });
    writeMaterials(mesh, t);
    const a = mesh.prims.add(MATERIAL_ATTRIB, 'string', 1);
    for (let i = 0; i < mesh.numPrims; i++) a.set(i, 'weather_part');
    kinds.weather_part = o.fallbackKind!;
  }
  const bbox = bboxOf(mesh);
  const ext = [0, 1, 2].map((i) => bbox.max[i] - bbox.min[i]);
  const diag = Math.hypot(ext[0], ext[1], ext[2]);
  const area = (() => { let a = 0; const t = triangulate(mesh), P = mesh.P, vp = mesh.vertexPoint; for (let k = 0; k < t.tris.length; k += 3) { const i = vp[t.tris[k]] * 3, j = vp[t.tris[k + 1]] * 3, l = vp[t.tris[k + 2]] * 3; const ux = P[j] - P[i], uy = P[j + 1] - P[i + 1], uz = P[j + 2] - P[i + 2], wx = P[l] - P[i], wy = P[l + 1] - P[i + 1], wz = P[l + 2] - P[i + 2]; a += Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) / 2; } return a; })();
  const res = Number(p.resolution) || 1024;
  // texel estimate: the area spread over about 60 % of the square
  const texel = Math.sqrt(area / (0.6 * res * res));
  return { mesh, kept, kinds, present: [...present].filter((k) => k !== 'keep').sort(), bbox, scale: weatherScale(diag, ext[1], texel), rustSources: rusting > 0 && rusting < mesh.numPrims, partsHint };
}

/** Input 2: images whose layers replace weather masks. Returns one image "ov" holding them, and their names. */
function overridesOf(ctx: CookContext, T: string, index: number, masks: readonly string[]): { image: Image | null; names: string[] } {
  if (!ctx.hasInput(index)) return { image: null, names: [] };
  const ims = imagesOf(ctx.input(index));
  if (!ims.length) return { image: null, names: [] };
  // an empty C first: it is the main layer, so every mask layer reads as ov_<name>
  const out = new Image(ims[0].width, ims[0].height, 'ov').set('C', new Float32Array(ims[0].width * ims[0].height)).takeSize(ims[0]);
  const names: string[] = [];
  for (const im of ims) for (const l of im.layers.keys()) {
    if (['mask', 'texel', 'island'].includes(l)) continue;
    const name = l === 'C' ? im.name : l;
    if (!(masks as readonly string[]).includes(name)) throw new NodeError(`${T}: input ${index} layer "${name}" is not a weather mask`, `masks: ${masks.join(', ')} (a layer, or an image of that name)`);
    let a = im.layer(l)!;
    const ch = im.channels(l);
    if (ch !== 1) { const g = new Float32Array(im.width * im.height); for (let i = 0; i < g.length; i++) g[i] = a[i * ch]; a = g; }
    if (im.width !== out.width || im.height !== out.height) throw new NodeError(`${T}: input ${index} images differ in size (${im.width}×${im.height}, ${out.width}×${out.height})`, 'make every override image the same size (they are resampled to the maps)');
    out.set(name, a);
    names.push(name);
  }
  return { image: out, names };
}

/** The signature of a prepared input: what it was made from and how. */
const sigOf = (ctx: CookContext, what: string, extra: unknown) => `${what}:${hashString(JSON.stringify([ctx.inputSigs, extra]))}`;

/**
 * The inputs of the last nested cooks by signature: an input made again the same way is handed over as the object it was
 * before, so what the bakes keep per geometry (the edge wear's buried points and wear field per surroundings) is found
 * again when only a slider moved.
 */
const lastInputs = new Map<string, Geometry>();
const LAST_INPUTS = 32;
function sameInputs(inputs: SubInput[]): SubInput[] {
  return inputs.map((x) => {
    // images (photos, overrides, the preview's masks) are not held: only the prepared meshes, planes and points
    if (x.geo.volumes.length) return x;
    const had = lastInputs.get(x.sig);
    if (had) { lastInputs.delete(x.sig); lastInputs.set(x.sig, had); return { ...x, geo: had }; }
    lastInputs.set(x.sig, x.geo);
    if (lastInputs.size > LAST_INPUTS) lastInputs.delete(lastInputs.keys().next().value!);
    return x;
  });
}

async function cookNested(ctx: CookContext, T: string, graph: GraphSpec, inputs: SubInput[], vars: Record<string, number>, target?: string): Promise<CookReport> {
  const r = await ctx.subcook(graph, { inputs: sameInputs(inputs), vars, ...(target ? { target } : {}) });
  for (const w of r.warnings) ctx.warn(`[${w.node}] ${w.message}`);
  if (!r.ok || !r.geo) {
    const e = r.errors[0];
    throw new NodeError(`${T}: ${e ? `${e.node}: ${e.message}` : 'the nested graph failed'}`, e?.hint);
  }
  return r;
}

const PACK_LETTER: Record<string, string> = { o: 'occlusion', r: 'roughness', m: 'metallic', h: 'height', s: 'smoothness', x: 'unused' };

// ---------------------------------------------------------------- weather

async function cookWeather(ctx: CookContext): Promise<Geometry> {
  const { p } = ctx;
  const budget = simBudget(ctx, 'a lower resolution, fewer samples, or raise the limit');
  const layout = String(p.layout) as 'keep' | 'visible' | 'unwrap';
  const prep = prepare(ctx, T_W, { uv: 'uv', layout });
  const material = String(p.material || 'weathered').trim();
  const packing = parsePacking(String(p.packing || 'orm'));
  if (typeof packing === 'string') throw new NodeError(`${T_W}: ${packing}`);
  // overrides: per layer, by its name in the stack
  const known = [...kindLayers(prep.present), ...sharedLayers({ exposure: p.exposure, kinds: prep.present, joints: false })].map((L) => L.name);
  const ov = p.overrides && typeof p.overrides === 'object' && !Array.isArray(p.overrides) ? (p.overrides as Record<string, Record<string, unknown>>) : {};
  const photosIn = ctx.hasInput(3) ? ctx.input(3) : null;
  const photoNames = photosIn ? [...referenceableImages(photosIn).keys()] : [];
  const photos: PhotoLayer[] = [];
  for (const [name, o] of Object.entries(ov)) {
    if (!known.includes(name)) throw new NodeError(`${T_W}: overrides names layer "${name}", which this model's stack does not have`, `layers: ${known.join(', ')}`);
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new NodeError(`${T_W}: overrides "${name}" must be an object`, `fields: ${OVERRIDE_FIELDS.join(', ')}`);
    for (const k of Object.keys(o)) if (!(OVERRIDE_FIELDS as readonly string[]).includes(k)) throw new NodeError(`${T_W}: overrides "${name}": unknown field "${k}"`, `fields: ${OVERRIDE_FIELDS.join(', ')}`);
    if (o.image !== undefined) {
      for (const f of ['image', 'normal', 'roughness_image'] as const) if (o[f] !== undefined && !photoNames.includes(String(o[f]))) throw new NodeError(`${T_W}: overrides "${name}": ${f} "${o[f]}" is not an image of input 3`, photoNames.length ? `images: ${photoNames.join(', ')}` : 'connect the photographs (image_file) to input 3');
      const im = referenceableImages(photosIn!).get(String(o.image))!;
      const size = Number(o.size) > 0 ? Number(o.size) : im.sizeStated ? im.size : 0;
      if (!(size > 0)) throw new NodeError(`${T_W}: overrides "${name}": image "${o.image}" does not say how many metres it covers`, 'set size in the override (metres one repeat covers), or texture_size where the image is made');
      photos.push({ layer: name, image: String(o.image), size, normal: String(o.normal ?? ''), roughness: String(o.roughness_image ?? '') });
    }
  }
  const over = overridesOf(ctx, T_W, 2, WEATHER_MASKS);
  // route B: the stack starts from the base pulled toward a stated reference
  const ref = p.reference && typeof p.reference === 'object' && !Array.isArray(p.reference) ? (p.reference as Record<string, unknown>) : {};
  const amount = Math.max(0, Math.min(1, Number(p.match) || 0));
  const env = ctx.hasInput(1) && ctx.input(1).numPrims ? ctx.input(1) : mountPlane(prep.bbox, p.mount, p.wall_side);
  const leaks = Number(p.leak_density) > 0 ? leakSources(prep.mesh, { density: Number(p.leak_density), seed: Number(p.seed) || 0, rain: p.exposure !== 'indoor', blockers: env, max: 20000 }) : null;
  const nLeaks = leaks?.points.numPoints ?? 0;
  const imgs: Image[] = [...(over.image ? [over.image] : []), ...(photosIn ? imagesOf(photosIn) : [])];
  const sig = (what: string, extra: unknown) => sigOf(ctx, what, extra);
  const prepKey = [p.kinds, p.handled, layout, p.rust > 0.6];
  const inputs: SubInput[] = [
    { geo: prep.mesh, sig: sig('mesh', prepKey) },
    { geo: env ?? new Geometry(), sig: sig('env', [p.mount, p.wall_side]) },
    { geo: leaks?.points ?? new Geometry(), sig: sig('leaks', [prepKey, p.leak_density, p.seed, p.exposure, p.mount, p.wall_side]) },
    { geo: new Geometry(), sig: 'none' },
  ];
  const opts: GraphOptions = {
    mode: 'maps', resolution: Number(p.resolution), padding: Number(p.padding), layout, uv: 'uv', mapUV: 'uv_maps',
    kinds: prep.kinds, kindsPresent: prep.present, exposure: p.exposure as Exposure, handled: String(p.handled ?? '').trim(),
    sun: p.sun, seed: Number(p.seed) || 0, scale: prep.scale, samples: Number(p.samples), env: !!env, leaks: nLeaks > 0,
    images: false, joints: false, rustSources: prep.rustSources, runDensity: Number(p.leak_density) || 0, mountWall: p.mount === 'wall', replaced: over.names,
    photos, overrides: ov, match: null, material,
  };
  const vars = weatherVars({ wear: p.wear, dirt: p.dirt, rust: p.rust, age: p.age, seed: Number(p.seed) || 0, exposure: p.exposure, mount: p.mount });
  const withImages = (extra: Image[]) => {
    const all = [...imgs, ...extra];
    if (!all.length) return;
    const g = new Geometry();
    g.volumes.push(...all);
    opts.images = true;
    inputs[3] = { geo: g, sig: sig('images', all.map((i) => `${i.name}:${i.width}x${i.height}:${hashString(Array.from(i.layer(i.mainLayer)!.subarray(0, 4096)).join(','))}`)) };
  };
  if (Object.keys(ref).length && amount > 0) {
    // stage 1: the base alone (cached for the full cook), its mean colour and roughness on the covered texels
    withImages([]);
    const g1 = weatherGraph(opts);
    const r1 = await cookNested(ctx, T_W, g1, inputs, vars, 'base');
    const base = findImage(r1.geo!, 'base')!;
    budget.check();
    ctx.stat('match', amount);
    withImages([matchImage(ctx, base, ref, photosIn)]);
    opts.match = { image: 'match', amount };
  } else withImages([]);
  const graph = weatherGraph(opts);
  const r = await cookNested(ctx, T_W, graph, inputs, vars);
  budget.check();
  // the stack's own result (its masks and height) from the same cook
  const stackGeo = r.results.get('stack')?.geo ?? null;
  let out = r.geo!.clone();
  const masksImg = stackGeo ? findImage(stackGeo, `${material}_masks`) : null;
  if (masksImg) out.volumes.push(masksImg);
  // the packed map in the stated layout, the normal in the stated convention
  const table = readMaterials(out);
  const entry: Material = { ...(table[material] ?? {}) };
  if (packing.join('') !== 'orm') {
    const orm = findImage(out, `${material}_orm`)!, hgt = findImage(out, `${material}_height`) ?? findImage(stackGeo!, `${material}_height`)!;
    const im = repack(orm, hgt, packing as PackedChannel[], `${material}_${packing.join('')}`);
    out.volumes = out.volumes.filter((v) => v.name !== orm.name);
    out.volumes.push(im);
    entry.textures = { ...(entry.textures ?? {}), orm: `image:${im.name}` };
    entry.packing = packing.join('');
  }
  if (p.normal_format === 'directx') {
    const i = out.volumes.findIndex((v) => v.name === `${material}_normal`);
    // clone shares the layer arrays: the flipped one is a copy (the cached map stays as it is)
    const im = (out.volumes[i] as Image).clone(), a = Float32Array.from(im.layer('C')!);
    for (let k = 1; k < a.length; k += 4) a[k] = 1 - a[k];
    im.set('C', a);
    out.volumes[i] = im;
    entry.normalFormat = 'directx';
  }
  table[material] = entry;
  // helper attributes off, the kept parts back in, unused materials dropped
  for (const a of ['wpart', 'wrust']) out.prims.delete?.(a);
  if (prep.kept) out = Geometry.merge([out, prep.kept]);
  const t2 = { ...readMaterials(out), ...table };
  const used = new Set<string>();
  const ma = out.prims.get(MATERIAL_ATTRIB);
  if (ma) for (let i = 0; i < out.numPrims; i++) used.add(String(ma.get(i) ?? ''));
  for (const k of Object.keys(t2)) if (!used.has(k)) delete t2[k];
  writeMaterials(out, t2);
  for (const k of prep.present) ctx.stat(`kind_${k}`, 1);
  ctx.stat('leak_sources', nLeaks);
  ctx.stat('parts', new Set(partsOf(prep.mesh).id).size);
  if (masksImg) ctx.stat('texels_per_metre', texelsPerMetre(masksImg));
  return out;
}

/** Median texels per metre over the covered texels (the texel layer: metres per texel along u). */
function texelsPerMetre(im: Image): number {
  const t = im.layer('texel'), m = im.layer('mask');
  if (!t) return 0;
  const ch = im.channels('texel'), v: number[] = [];
  for (let i = 0; i < im.width * im.height; i += 7) if ((!m || m[i] > 0.5) && t[i * ch] > 0) v.push(1 / t[i * ch]);
  v.sort((a, b) => a - b);
  return v.length ? Math.round(v[v.length >> 1]) : 0;
}

/** The ORM and height of the stack in another channel layout (o r m h s x). */
function repack(orm: Image, hgt: Image, letters: PackedChannel[], name: string): Image {
  const n = orm.width * orm.height, o = orm.layer('C')!, h = hgt.layer('C')!, out = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    letters.forEach((l, c) => {
      out[i * 4 + c] = l === 'o' ? o[i * 4] : l === 'r' ? o[i * 4 + 1] : l === 'm' ? o[i * 4 + 2] : l === 's' ? 1 - o[i * 4 + 1] : l === 'h' ? Math.max(0, Math.min(1, 0.5 + h[i] / 0.005)) : 0;
    });
    if (letters.length < 4) out[i * 4 + 3] = 1;
  }
  const im = new Image(orm.width, orm.height, name).set('C', out).takeSize(orm);
  for (const l of ['mask', 'texel', 'island']) { const a = orm.layer(l); if (a) im.set(l, a); }
  return im;
}

/**
 * Route B: the base colour and roughness pulled toward a stated reference. The mean colour of the covered texels is
 * multiplied toward the reference's (so the variation stays), the roughness shifted by the difference of the means.
 */
function matchImage(ctx: CookContext, base: Image, ref: Record<string, unknown>, photos: Geometry | null): Image {
  const n = base.width * base.height, C = base.layer('C')!, R = base.layer('roughness'), M = base.layer('mask');
  let sr = 0, sg = 0, sb = 0, sR = 0, k = 0;
  for (let i = 0; i < n; i++) if (!M || M[i] > 0.5) { sr += C[i * 4]; sg += C[i * 4 + 1]; sb += C[i * 4 + 2]; sR += R ? R[i] : 0.5; k++; }
  const mean = [sr / k, sg / k, sb / k], meanR = sR / k;
  let target: number[], targetR: number | null = typeof ref.roughness === 'number' ? ref.roughness : null;
  if (typeof ref.image === 'string') {
    const im = photos ? referenceableImages(photos).get(ref.image) : undefined;
    if (!im) throw new NodeError(`${T_W}: reference image "${ref.image}" is not an image of input 3`, 'connect the reference (image_file) to input 3');
    const a = im.layer(im.mainLayer)!, ch = im.channels(im.mainLayer), m = im.width * im.height;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < m; i++) { r += a[i * ch]; g += a[i * ch + (ch === 4 ? 1 : 0)]; b += a[i * ch + (ch === 4 ? 2 : 0)]; }
    target = [r / m, g / m, b / m];
    const rl = im.layer('roughness');
    if (targetR === null && rl) { let s = 0; for (let i = 0; i < m; i++) s += rl[i]; targetR = s / m; }
  } else if (ref.color !== undefined) {
    const c = ref.color;
    const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    if (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)) target = [1, 3, 5].map((j) => lin(parseInt(c.slice(j, j + 2), 16) / 255));
    else if (Array.isArray(c) && c.length >= 3) target = c.slice(0, 3).map((v) => lin(Number(v)));
    else throw new NodeError(`${T_W}: reference color ${JSON.stringify(c)} is not a colour`, 'e.g. {"color": "#6b665c", "roughness": 0.85}');
  } else throw new NodeError(`${T_W}: reference says neither color nor image`, 'e.g. {"color": "#6b665c", "roughness": 0.85} or {"image": "concrete_ref"} (an image of input 3)');
  const f = target.map((t, i) => (mean[i] > 1e-5 ? t / mean[i] : 1));
  const out = new Float32Array(n * 4), rough = new Float32Array(n);
  const dR = targetR === null ? 0 : targetR - meanR;
  for (let i = 0; i < n; i++) {
    out[i * 4] = C[i * 4] * f[0]; out[i * 4 + 1] = C[i * 4 + 1] * f[1]; out[i * 4 + 2] = C[i * 4 + 2] * f[2]; out[i * 4 + 3] = 1;
    rough[i] = Math.max(0, Math.min(1, (R ? R[i] : 0.5) + dR));
  }
  ctx.stat('match_mean_before', Math.round(((mean[0] + mean[1] + mean[2]) / 3) * 1000) / 1000);
  const im = new Image(base.width, base.height, 'match').set('C', out).set('roughness', rough).takeSize(base);
  return im;
}

// ---------------------------------------------------------------- weather_masks

async function cookMasks(ctx: CookContext): Promise<Geometry> {
  const { p } = ctx;
  const budget = simBudget(ctx, 'a lower resolution, fewer variants or samples, or raise the limit');
  const uv = String(p.uv || 'uv').trim();
  const name = String(p.name || 'weather').trim();
  const fallback = String(p.kind ?? '').trim();
  const prep = prepare(ctx, T_M, { uv, layout: 'keep', fallbackKind: fallback || undefined });
  // the channel map, R G B (A)
  const channels = String(p.channels ?? '').trim().split(/[\s,]+/).filter(Boolean);
  if (channels.length < 1 || channels.length > 4) throw new NodeError(`${T_M}: channels names ${channels.length} masks; it packs 1 to 4 (R, G, B, A)`, `e.g. "dirt leaks edges coating"; masks: ${PACKABLE.join(', ')}`);
  for (const c of channels) if (!(PACKABLE as readonly string[]).includes(c)) throw new NodeError(`${T_M}: channels: "${c}" is not a mask`, `masks: ${PACKABLE.join(', ')}`);
  const joints = String(p.joints ?? '').trim().split(/[\s,]+/).filter(Boolean);
  for (const j of joints) if (!['sides', 'bottom', 'top'].includes(j)) throw new NodeError(`${T_M}: joints: "${j}" is not a border`, 'joints names borders of each piece: sides, bottom, top (e.g. "sides bottom")');
  // pieces: weathered each as if alone, moved apart for the bakes (rays, runs and height see one piece)
  const pieceAttr = String(p.piece ?? '').trim();
  const mesh = prep.mesh.clone();
  let pieceOf: string[] = [];
  if (pieceAttr) {
    const a = mesh.prims.get(pieceAttr);
    if (!a) throw new NodeError(`${T_M}: no prim attribute "${pieceAttr}" to tell the pieces apart`, `prim attributes: ${[...mesh.prims.names()].filter((x) => !['wpart', 'wrust'].includes(x)).join(', ')}`);
    for (let i = 0; i < mesh.numPrims; i++) pieceOf.push(String(a.get(i) ?? ''));
  } else pieceOf = new Array(mesh.numPrims).fill('');
  const pieces = [...new Set(pieceOf)];
  const ptPiece = new Int32Array(mesh.numPoints).fill(-1);
  for (let pr = 0; pr < mesh.numPrims; pr++) for (let v = mesh.primStart[pr]; v < mesh.primStart[pr + 1]; v++) ptPiece[mesh.vertexPoint[v]] = pieces.indexOf(pieceOf[pr]);
  const boxes = pieces.map(() => ({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }));
  const PP = mesh.P;
  for (let i = 0; i < mesh.numPoints; i++) { const b = boxes[ptPiece[i]]; if (!b) continue; for (let c = 0; c < 3; c++) { b.min[c] = Math.min(b.min[c], PP[i * 3 + c]); b.max[c] = Math.max(b.max[c], PP[i * 3 + c]); } }
  const maxDiag = Math.max(...boxes.map((b) => Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2])));
  const cols = Math.ceil(Math.sqrt(pieces.length)), gap = pieces.length > 1 ? maxDiag * 50 : 0;
  const shift = boxes.map((b, k) => [((k % cols) * gap) - (b.min[0] + b.max[0]) / 2 * (pieces.length > 1 ? 1 : 0), pieces.length > 1 ? -b.min[1] : 0, (Math.floor(k / cols) * gap) - (b.min[2] + b.max[2]) / 2 * (pieces.length > 1 ? 1 : 0)]);
  if (pieces.length > 1) for (let i = 0; i < mesh.numPoints; i++) { const s = shift[ptPiece[i]]; if (!s) continue; PP[i * 3] += s[0]; PP[i * 3 + 1] += s[1]; PP[i * 3 + 2] += s[2]; }
  const moved = boxes.map((b, k) => ({ min: b.min.map((v, c) => v + shift[k][c]), max: b.max.map((v, c) => v + shift[k][c]) }));
  // the surroundings: input 1 (moved with the pieces when there is one piece), else per piece the stated mount and cover
  const env: Geometry[] = [];
  if (ctx.hasInput(1) && ctx.input(1).numPrims) {
    if (pieces.length > 1) throw new NodeError(`${T_M}: input 1 with ${pieces.length} pieces: each piece is weathered alone`, 'connect surroundings for a single piece, or state mount and above per kit');
    env.push(ctx.input(1));
  } else for (const b of moved) {
    const m = mountPlane(b, p.mount, p.wall_side);
    if (m) env.push(m);
    if (p.above === 'covered') env.push(coverPlane(b));
  }
  const envGeo = env.length ? Geometry.merge(env) : null;
  const jointGeo = joints.length ? Geometry.merge(moved.flatMap((b) => jointPlanes(b, joints))) : null;
  const leakParts = Number(p.leak_density) > 0 ? moved.map((b, k) => {
    const sel = new Uint8Array(mesh.numPrims);
    for (let i = 0; i < mesh.numPrims; i++) sel[i] = pieceOf[i] === pieces[k] ? 1 : 0;
    return leakSources(mesh, { density: Number(p.leak_density), seed: (Number(p.seed) || 0) + k * 7919, rain: p.exposure !== 'indoor', blockers: envGeo, prims: sel, topEdge: p.above === 'source' ? b : null, max: 8000 });
  }) : [];
  const leakGeo = leakParts.length ? Geometry.merge(leakParts.map((l) => l.points)) : null;
  const over = overridesOf(ctx, T_M, 2, [...WEATHER_MASKS, ...PACKED_MASKS]);
  const sig = (what: string, extra: unknown) => sigOf(ctx, what, extra);
  const prepKey = [p.kinds, p.kind, p.handled, uv, pieceAttr, p.rust > 0.6];
  const inputs: SubInput[] = [
    { geo: mesh, sig: sig('mesh', prepKey) },
    { geo: envGeo ?? new Geometry(), sig: sig('env', [prepKey, p.mount, p.wall_side, p.above]) },
    { geo: leakGeo ?? new Geometry(), sig: 'none' },
    { geo: new Geometry(), sig: 'none' },
    { geo: jointGeo ?? new Geometry(), sig: sig('joints', [prepKey, joints]) },
  ];
  if (over.image) { const g = new Geometry(); g.volumes.push(over.image); inputs[3] = { geo: g, sig: sig('overrides', over.names) }; }
  const jw = Math.max(1e-4, Number(p.joint_width) || 0.03);
  const variants = Math.max(1, Math.min(8, Math.round(Number(p.variants) || 1)));
  const out = ctx.input(0).clone();
  const packedImgs: Image[] = [];
  for (let v = 0; v < variants; v++) {
    const seed = (Number(p.seed) || 0) + v * 1013;
    // the leak points move with the seed: thinned and jittered again
    if (leakParts.length && v > 0) {
      const lp = moved.map((b, k) => {
        const sel = new Uint8Array(mesh.numPrims);
        for (let i = 0; i < mesh.numPrims; i++) sel[i] = pieceOf[i] === pieces[k] ? 1 : 0;
        return leakSources(mesh, { density: Number(p.leak_density), seed: seed + k * 7919, rain: p.exposure !== 'indoor', blockers: envGeo, prims: sel, topEdge: p.above === 'source' ? b : null, max: 8000 }).points;
      });
      inputs[2] = { geo: Geometry.merge(lp), sig: sig('leaks', [prepKey, p.leak_density, seed, p.exposure, p.mount, p.above]) };
    } else if (leakGeo) inputs[2] = { geo: leakGeo, sig: sig('leaks', [prepKey, p.leak_density, seed, p.exposure, p.mount, p.above]) };
    const opts: GraphOptions = {
      mode: 'masks', resolution: Number(p.resolution), padding: Number(p.padding), layout: 'keep', uv, mapUV: 'uv',
      kinds: prep.kinds, kindsPresent: prep.present, exposure: p.exposure as Exposure, handled: String(p.handled ?? '').trim(),
      sun: p.sun, seed, scale: prep.scale, samples: Number(p.samples), env: !!envGeo, leaks: !!leakGeo && leakGeo.numPoints > 0,
      images: !!over.image, joints: !!jointGeo, rustSources: prep.rustSources, runDensity: Number(p.leak_density) || 0, mountWall: p.mount === 'wall', replaced: over.names,
      photos: [], overrides: {}, match: null, material: name,
    };
    const graph = weatherGraph(opts);
    // joints: 1 at the border, 0 at joint_width (a distance measure with range 1 is reshaped here)
    if (jointGeo) (graph.nodes.joints.params as any).measures = [{ by: 'distance', name: 'joint', target: 'input1', range: jw }];
    const vars = weatherVars({ wear: p.wear, dirt: p.dirt, rust: p.rust, age: p.age, seed, exposure: p.exposure, mount: p.mount });
    const r = await cookNested(ctx, T_M, graph, inputs, vars);
    budget.check();
    const mi = findImage(r.geo!, `${name}_masks`)!;
    const im = new Image(mi.width, mi.height, v ? `${name}_${v + 1}` : name).takeSize(mi);
    const n = mi.width * mi.height, C = new Float32Array(n * 4);
    channels.forEach((c, k) => { const a = mi.layer(c)!; for (let i = 0; i < n; i++) C[i * 4 + k] = a[i]; im.set(c, a); });
    if (channels.length < 4) for (let i = 0; i < n; i++) C[i * 4 + 3] = 1;
    im.set('C', C);
    for (const l of ['texel', 'island', 'mask']) { const a = mi.layer(l); if (a) im.set(l, a); }
    packedImgs.push(im);
    if (v === 0) {
      ctx.stat('leak_sources', inputs[2].geo.numPoints);
      if (r.results) ctx.stat('texels_per_metre', texelsPerMetre(mi));
    }
  }
  out.volumes.push(...packedImgs);
  ctx.stat('pieces', pieces.length);
  ctx.stat('variants', variants);
  ctx.stat('channels', channels.length);
  if (p.preview) {
    // for looking only: the tiling material on the mask uv, blended with the first variant like a simple engine material
    const pv = previewGraph(name, uv, Number(p.resolution), channels, p.under);
    const g = new Geometry();
    g.volumes.push(packedImgs[0]);
    const r = await cookNested(ctx, T_M, pv, [{ geo: ctx.input(0), sig: sig('preview_mesh', [uv]) }, { geo: g, sig: sig('preview_masks', [p.seed, p.wear, p.dirt, p.rust, p.age, p.exposure, p.mount, p.above, joints, jw, p.channels, p.kinds, p.kind, p.leak_density]) }], {});
    const pm = r.geo!;
    const pimgs = pm.volumes.filter((v) => v.name.startsWith(`${name}_preview`));
    out.volumes.push(...pimgs);
    const t = readMaterials(out);
    t[`${name}_preview`] = readMaterials(pm)[`${name}_preview`];
    writeMaterials(out, t);
    const a = out.prims.add(MATERIAL_ATTRIB, 'string', 1);
    for (let i = 0; i < out.numPrims; i++) a.set(i, `${name}_preview`);
    // the preview's maps lie on the mask uv: it becomes uv (the tiling uv is kept as uv_tiling)
    if (uv !== 'uv') {
      const f = out.findAttrib(uv, ['vertex', 'point'])!, t = out.findAttrib('uv', ['vertex', 'point']);
      if (t) out.table(t.cls).set('uv_tiling', t.attr.clone());
      if (t && t.cls !== f.cls) out.table(t.cls).delete?.('uv');
      out.table(f.cls).set('uv', f.attr.clone());
    }
    ctx.warn(`${T_M}: preview assigns material "${name}_preview" and shows it on uv "${uv}" (the tiling uv is kept as uv_tiling) for looking; export the masks, not the preview`);
  }
  return out;
}

/** The preview: the tiling material baked on the mask uv, then dirt darkens and roughens, leaks tint, worn edges lighten, coating lost shows `under`. */
function previewGraph(name: string, uv: string, res: number, channels: string[], under: unknown): GraphSpec {
  const ch = (c: string) => { const i = channels.indexOf(c); return i < 0 ? '0' : `${name}_${'rgba'[i]}`; };
  return {
    nodes: {
      mesh: { type: 'input', params: { index: 0 } },
      masks: { type: 'input', params: { index: 1 } },
      base: { type: 'bake_material', in: ['mesh'], params: { resolution: res, uv_attrib: uv, map_uv: 'uv', name: 'pbase' } },
      look: {
        type: 'tex_layers', in: ['base', 'masks'], params: {
          name: `${name}_preview`, layers: [
            { name: 'coating_lost', mask: ch('coating'), color: under ?? '#9a958c', roughness: 0.9 },
            { name: 'edges', mask: ch('edges'), color: '#d8d4cc', color_mode: 'lighten', opacity: 0.6 },
            { name: 'dirt', mask: ch('dirt'), color: [0.45, 0.42, 0.38], color_mode: 'multiply', roughness_offset: 0.2 },
            { name: 'leaks', mask: ch('leaks'), color: [0.5, 0.44, 0.36], color_mode: 'multiply', opacity: 0.8 },
          ],
        },
      },
      out: { type: 'texture_to_material', in: ['mesh', 'look'], params: { material: `${name}_preview`, base_color: `${name}_preview_base_color`, normal: `${name}_preview_normal`, orm: `${name}_preview_orm` } },
    },
    output: 'out',
  };
}

// ---------------------------------------------------------------- the graph for the defaults (help)

function defaultGraph(mode: 'maps' | 'masks'): string {
  const g = weatherGraph({
    mode, resolution: mode === 'maps' ? 1024 : 2048, padding: 4, layout: mode === 'maps' ? 'visible' : 'keep', uv: mode === 'maps' ? 'uv' : 'uv2', mapUV: mode === 'maps' ? 'uv_maps' : 'uv',
    kinds: { paint: 'painted_metal' }, kindsPresent: ['painted_metal'], exposure: 'outdoor', handled: '', sun: [0, 1, 0], seed: 0,
    scale: weatherScale(1.2, 1, 0.001), samples: 32, env: true, leaks: true, images: false, joints: false, rustSources: false, runDensity: 120,
    mountWall: false, replaced: [], photos: [], overrides: {}, match: null, material: mode === 'maps' ? 'weathered' : 'weather',
  });
  return JSON.stringify(g);
}

const KIND_DOC = 'Kinds (the material node\'s kind, or kinds here; never guessed from names): painted ones lose their coat (painted_metal: chips to primer, bare steel, rust in the chip cores; cast_metal: larger chips, pitting, iron, heavier rust; painted_concrete: chips to concrete; painted_plaster: peels in larger sheets, water marks; painted_wood: flakes to wood that greys; decal: fades and scratches), bare ones stain, darken or grey through the whole surface and only wear lighter at edges (concrete: damp, stains, efflorescence below runs, worn arrises, moss; bare_steel: mill scale, flash and heavy rust, and it sources rust runs onto what is below; galvanised: dulls, white bloom, red rust on edges above rust 0.6; stainless: smudges where handled, tea stain; plastic: chalks in the sun, scuffs; rubber: greys; bare_wood: greys in the sun, damp low down; asphalt: fades, stains pool on flats; ceramic: chips to bisque); keep leaves a part as it is. Shared over every kind: film (sheltered paint duller), grime, dust, splash (mount ground), dirt runs, rust runs, moss on growing kinds outdoors, and blotch and grain on roughness.';

const LEAK_DOC = 'Dirt runs start where the shape sheds water, measured, not named: the outer edge of every face turned up that meets a steep face below at a convex edge (copings, parapets, sills, ledges, plate and canopy tops) and the wall under a face turned down that meets it at a concave edge (under a balcony slab or canopy), or, when the wall is a separate piece, the wall that short level rays from just below the lip of an overhang reach (under a coping or sill that is its own box), one point every 1 / leak_density metres, kept with the chance of the rain that reaches its ledge (rays up against the model and its surroundings; indoors a fixed chance, as water below windows). Named parts add to them: handled parts wear, rust sources (bare_steel, and galvanised above rust 0.6) run rust onto what is below. mount and exposure scale them.';

defineNode({
  type: T_W,
  category: 'texture',
  summary: 'Weather a model in one node: paint chips on edges and where hands go, grime in cavities, dust on tops, splash at the ground, rain and rust runs from where the shape sheds water, sun fade and moss, each by the material kind of the part. Out come base colour, normal and a packed map on one material, every mask in one image.',
  description:
    'Input 0: a mesh with uv and materials, each with a kind. The maps of the materials (base colour, roughness, packed, normal; ' +
    'tiling in metres with the material\'s tile) are read with the uv as it comes (kept as uv_maps) and baked onto the atlas, so ' +
    'their look survives: at zero weathering the maps are the material\'s. layout visible re-packs the islands with more texels ' +
    'where they show (uv_layout visibility_weight), keep bakes on the uv as it is (it must not overlap), unwrap charts it again ' +
    '(tiling uv that folds, trim sheets). Input 1: surroundings (a wall, the ground: they block rays and catch drips); with none, ' +
    'mount adds a plane. Input 2: images whose layers, named like the masks, replace them before the stack. Input 3: photographs ' +
    'for image layers (overrides {"<layer>": {"image": "rust_photo", "size": 0.5}}: colour, roughness and normal projected in ' +
    'world metres from three axes, bake_triplanar, so no uv seam shows) and a route B reference. ' + KIND_DOC + ' ' + LEAK_DOC + ' ' +
    'Route B (a prop with its own unique maps): layout keep, and reference {"color": "#6b665c", "roughness": 0.85} or {"image": ' +
    '"name"} with match pulls the mean colour and roughness toward it before the weathering (the variation stays). Out: the mesh ' +
    'with material `material` on every weathered prim (parts of kind keep keep theirs), images <material>_base_color, _normal (in ' +
    'normal_format), the packed map (_orm, or _<packing> in the stated layout, h = height around 0.5 at 5 mm per unit) and ' +
    '_masks holding every mask as a layer: ' + WEATHER_MASKS.join(', ') + ' (and the steps between them). Built from bakes ' +
    '(uv_layout, bake_material, bake_measure twice: rays and shape, then seeded noise; bake_edge_wear, bake_mask, bake_flow ' +
    'for rust and dirt runs, bake_triplanar per photo) and one tex_layers stack, cooked as a nested graph: each step is cached ' +
    'by its own signature, so dirt, rust and age re-cook only the stack, wear also the chip threshold of the edge wear (its ' +
    'wear field is kept), and seed also the noise, the edge wear and the runs. Worn edges are bake_edge_wear: its amount is ' +
    'the wear slider after age and exposure, its focus the handled parts, and chip, bare and core (nested, capped per face: at ' +
    'most about a third of any face chips) are the masks of the same names; edge_wear is its raw wear field. Runs are a dark ' +
    'narrow core in a broad faint stain (bake_flow stain), nearly straight on flat faces; their drip points gather at the ends ' +
    'of a ledge, at its joints and low end and around a few spots along it. Splash is densest at the ground and thins upward ' +
    'into spatter with a ragged top, lighter under an overhang. The graph for the defaults, to copy and take ' +
    'over any step (vars k_* are the sliders after age and exposure, x_* the exposure weights): ' + defaultGraph('maps'),
  aliases: ['weathering', 'age_material', 'wear_and_tear', 'grunge_material', 'smart_material'],
  inputs: [
    { name: 'geo', desc: 'mesh with uv and materials (each with a kind)' },
    { name: 'surroundings', desc: 'what it stands on or hangs from: blocks rays, catches drips (replaces the mount plane)', optional: true },
    { name: 'overrides', desc: 'images whose layers, named like the masks, replace those masks', optional: true },
    { name: 'photos', desc: 'images for image layers (overrides "image") and the route B reference', optional: true },
  ],
  params: {
    ...SHARED(),
    resolution: { type: 'int', default: 1024, min: 64, max: 8192, desc: 'map size: 1024 is about 10 s, 2048 for hero props', aliases: ['res', 'size'] },
    layout: { type: 'enum', options: ['visible', 'keep', 'unwrap'], default: 'visible', desc: 'visible: re-pack the uv islands, more texels where they show; keep: bake on the uv as it is (route B, no overlaps); unwrap: chart again (tiling uv that folds, trim sheets)' },
    material: { type: 'string', default: 'weathered', desc: 'name of the output material and prefix of its images', aliases: ['name'] },
    overrides: { type: 'json', default: {}, desc: 'per layer of the stack: {"painted_metal_rust": {"color": "#5a2a14"}, "dust": {"opacity": 0}, "grime": {"image": "oil_photo", "size": 0.6}}; fields ' + OVERRIDE_FIELDS.join(', '), aliases: ['override'] },
    reference: { type: 'json', default: {}, desc: 'route B: what the base is pulled toward before weathering: {"color": "#6b665c", "roughness": 0.85} or {"image": "name"} (input 3); {} = none', aliases: ['target_look'] },
    match: { type: 'float', default: 0.6, min: 0, max: 1, desc: 'route B: how far toward the reference (0 = not at all)', aliases: ['pull'] },
    packing: { type: 'string', default: 'orm', desc: 'channel layout of the packed map: letters o occlusion, r roughness, m metallic, h height, s smoothness, x unused; orm (glTF, Unreal), hro (R height, G roughness, B occlusion), rma, mrox; glTF and usda exports read it by this layout', aliases: ['packed_layout'] },
    normal_format: { type: 'enum', options: ['opengl', 'directx'], default: 'opengl', desc: 'green channel of the normal map: opengl (glTF, Blender) or directx (Unreal)' },
  },
  outputs: 'the mesh with the weathered material; images <material>_base_color, _normal, the packed map, _height, _masks',
  example: {
    nodes: {
      body: { type: 'box', params: { size: [0.5, 0.8, 0.3], center: [0, 0.4, 0] } },
      top: { type: 'box', params: { size: [0.6, 0.04, 0.4], center: [0, 0.82, 0] } },
      parts: { type: 'merge', in: ['body', 'top'] },
      paint: { type: 'material', in: ['parts'], params: { name: 'paint', base_color: '#4f6b48', roughness: 0.45, kind: 'painted_metal' } },
      uv: { type: 'uv_unwrap', in: ['paint'] },
      weather: { type: 'weather', in: ['uv'], params: { resolution: 256, samples: 8, mount: 'ground' } },
    },
    output: 'weather',
  },
  cook: cookWeather,
});

defineNode({
  type: T_M,
  category: 'texture',
  summary: 'Weathering as packed masks for an engine material: dirt, leaks and runs, worn edges, coating lost (by default) in one RGBA image per seeded variant, on a uv set you laid out; materials unchanged. Kit pieces are weathered each as if alone; borders (water from above, joints, ground) are stated, never guessed.',
  description:
    'For buildings and kits whose engine material blends its own tiling textures: the masks go on a second uv set (uv, ' +
    'e.g. "uv2": an atlas without overlaps, one island per piece or more), the materials keep their tiling uv. Each variant is ' +
    'one image <name>, <name>_2, …: C packs channels (R G B A; default dirt leaks edges coating), and each channel is also a ' +
    'layer by its name. The variants share the structure (edges, shelter, where water can run) and differ in which stretches ' +
    'wear, where runs start and where the patches lie. piece names a prim attribute that tells the pieces of a merged kit ' +
    'apart: each is moved apart for the bakes, so it is weathered as if alone (no shadow or stain from a neighbour), and the ' +
    'mount and borders apply per piece. Borders, as stated: above open (rain on its own tops, as measured), covered (something ' +
    'sits on it: no rain or sky from above), source (water arrives along its top edge: runs from the whole top); joints ' +
    '"sides bottom top" darken a band joint_width wide along those borders of each piece (the joint lines of precast panels); ' +
    'mount ground adds splash and moss at the bottom. Worn edges (edges) is the chip layer of bake_edge_wear (everywhere the ' +
    'top coat is gone, the primer ring included) with a faint rub along the edges; coating lost (coating) is its bare layer ' +
    '(down to the substrate) on painted kinds, with the larger peeling of age. ' + KIND_DOC + ' Coating lost is 0 on bare kinds. kind gives ' +
    'the kind of prims whose material says none (or of a mesh with no materials). ' + LEAK_DOC + ' preview bakes the ' +
    'material of the mesh on the mask uv and blends the first variant over it like a simple engine material (dirt darkens ' +
    'and roughens, leaks tint, worn edges lighten, coating lost shows under): material <name>_preview, for looking only. ' +
    'Input 2: images whose layers, named like the masks, replace them. The graph for one variant: ' + defaultGraph('masks'),
  aliases: ['weather_mask', 'weathering_masks', 'grunge_masks', 'mask_pack'],
  inputs: [
    { name: 'geo', desc: 'mesh with the mask uv set (and materials with kinds, or kind)' },
    { name: 'surroundings', desc: 'what one piece stands on or against (replaces the mount plane)', optional: true },
    { name: 'overrides', desc: 'images whose layers, named like the masks, replace those masks', optional: true },
  ],
  params: {
    ...SHARED(),
    uv: { type: 'string', default: 'uv2', desc: 'the uv set the masks go on (no overlaps)', aliases: ['uv_attrib', 'mask_uv'] },
    resolution: { type: 'int', default: 2048, min: 64, max: 8192, desc: 'mask size (2048 or 4096 for a kit atlas)', aliases: ['res', 'size'] },
    channels: { type: 'string', default: 'dirt leaks edges coating', desc: 'the mask in each channel R G B (A): ' + PACKABLE.join(', '), aliases: ['channel_map', 'layout'] },
    variants: { type: 'int', default: 1, min: 1, max: 8, desc: 'seeded variants on the same uv, one image each', aliases: ['count'] },
    kind: { type: 'enum', options: ['', ...WEATHER_KINDS.filter((k) => k !== 'keep')], default: '', desc: 'kind of the prims whose material says none ("" = refuse them)' },
    piece: { type: 'string', default: '', desc: 'prim attribute naming the pieces of a kit, each weathered alone ("" = one piece)', aliases: ['piece_attrib', 'pieces'] },
    above: { type: 'enum', options: ['open', 'covered', 'source'], default: 'open', desc: 'what is above each piece: open (rain on its tops), covered (nothing from above), source (water arrives along its top edge)', aliases: ['top_edge'] },
    joints: { type: 'string', default: '', desc: 'borders of each piece that are joints, darkened: "sides", "bottom", "top" ("" = none)', aliases: ['joint_edges'] },
    joint_width: { type: 'float', default: 0.03, min: 0.001, max: 1, desc: 'width of the joint band on each piece (metres)' },
    preview: { type: 'bool', default: false, desc: 'add a preview material on the mask uv (for looking only)' },
    under: { type: 'color', default: '#9a958c', desc: 'preview: the colour coating lost shows' },
    name: { type: 'string', default: 'weather', desc: 'name of the mask images' },
  },
  outputs: 'the mesh as it came with images <name> (and <name>_2 …): C packed, a layer per channel, texel, island, mask',
  example: {
    nodes: {
      panel: { type: 'box', params: { size: [1.2, 1, 0.12], center: [0, 0.5, 0] } },
      concrete: { type: 'material', in: ['panel'], params: { name: 'precast', base_color: '#a39e94', roughness: 0.9, kind: 'concrete' } },
      uv2: { type: 'uv_unwrap', in: ['concrete'], params: { uv_attrib: 'uv2' } },
      masks: { type: 'weather_masks', in: ['uv2'], params: { resolution: 256, samples: 8, mount: 'ground', joints: 'sides bottom' } },
    },
    output: 'masks',
  },
  cook: cookMasks,
});

export { EXPOSURE };
