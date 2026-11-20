// bake_flow (category "texture"): runs that flow down a surface under gravity from source parts (rust under bolts, rain
// streaks under a ledge), traced in 3D over edges and across uv seams, stopped by ledges, then stored per texel.
// Algorithms: core/runs.ts. Rasterisation into uv space, padding and the layers work as in the other bakes (nodes/bake.ts).
import { Image, MAIN_LAYER } from '../core/image.ts';
import { bakeSamples, dilate, interpolate, normalize3, resolve, vertexPositions } from '../core/bake.ts';
import type { Geometry } from '../core/geometry.ts';
import { partsOf } from '../core/report.ts';
import { markGutter } from '../core/texscale.ts';
import { CREASE, FlowLimit, limits, MAX_RUNS, REF_WIDTH, TOUCH, rasterRuns, sampleSources, scales, traceRuns, triTexelSizes } from '../core/runs.ts';
import type { FlowParams } from '../core/runs.ts';
import { triangulate, vertexNormals } from '../core/topology.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import type { CookContext } from '../graph/types.ts';
import { P, mask, simBudget } from './util.ts';
import { bakedImageSize } from '../core/texelsize.ts';
import { texelLayers } from './bake.ts';
import type { Bake } from './bake.ts';
import { NAMED_BY_NODE, imageGeo, nameParam, outName, resolutionParam, size2 } from './texture.ts';

/** Most samples a bake may rasterise (output texels × supersample²), as in the other bakes. */
const MAX_SAMPLES = 4096 * 4096;

/** The names of source parts for a message: the first few, then a count. */
const listNames = (names: string[], max = 6) => names.slice(0, max).join(', ') + (names.length > max ? `, … ${names.length - max} more` : '');

function readUV(g: Geometry, name: string): Float64Array | null {
  const f = g.findAttrib(name || 'uv', ['vertex', 'point']);
  if (!f || f.attr.type !== 'float') return null;
  const a = f.attr, d = a.data as Float64Array, s = a.size;
  const out = new Float64Array(g.numVertices * 2);
  for (let v = 0; v < g.numVertices; v++) {
    const i = (f.cls === 'vertex' ? v : g.vertexPoint[v]) * s;
    out[v * 2] = d[i];
    out[v * 2 + 1] = s > 1 ? d[i + 1] : 0;
  }
  return out;
}

function cook(ctx: CookContext): Geometry {
  const { p, type } = ctx;
  const g = ctx.input(0);
  const [W, H] = size2(p, type);
  const S = Math.max(1, Math.min(4, Math.round(p.supersample)));
  if (W * H * S * S > MAX_SAMPLES) throw new NodeError(`${type}: ${W} × ${H} at supersample ${S} is ${(W * H * S * S).toLocaleString('en-US')} samples (at most ${MAX_SAMPLES.toLocaleString('en-US')})`, 'lower resolution or supersample');
  const dir = (p.direction as number[]).map(Number);
  if (!(Math.hypot(dir[0], dir[1], dir[2]) > 0)) throw new NodeError(`${type}: direction is the zero vector`, 'gravity as a vector, e.g. [0, -1, 0] (straight down)');
  const { tris, triPrim } = triangulate(g);
  if (!tris.length) throw new NodeError(`${type}: input 0 has no polygons to bake`, 'bakes need a mesh with uv (e.g. box → uv_unwrap → bake_flow)');
  const uv = readUV(g, p.uv_attrib);
  if (!uv) throw new NodeError(`${type}: input 0 has no "${p.uv_attrib || 'uv'}" attribute`, 'unwrap it first: uv_unwrap (xatlas), uv_flatten + uv_layout, or uv_project for simple shapes; islands must not overlap');

  // sources: a prim group of input 0, else input 1 (points or a mesh)
  const pattern = String(p.sources ?? '').trim();
  let srcMask: Uint8Array | null = null, srcGeo: Geometry, recv: Geometry;
  if (pattern) {
    const m = mask(g, 'prim', pattern);
    let n = 0;
    if (m) for (let i = 0; i < m.length; i++) n += m[i] ? 1 : 0;
    if (!m || !n) {
      const parts = partsOf(g, Array.from({ length: g.numPrims }, (_, i) => i), 12);
      throw new NodeError(`${type}: sources "${pattern}" match no prims`, parts ? `parts: ${parts}` : 'the mesh has no prim "name" attribute: name the parts (attrib_create name, class prim) or use a group like "0-5"');
    }
    if (n === g.numPrims) throw new NodeError(`${type}: sources "${pattern}" match every prim of input 0`, 'runs need a surface to flow on: select only the parts they start from');
    srcMask = m;
    srcGeo = g.subsetPrims(m);
    recv = g.subsetPrims(Uint8Array.from(m, (x) => (x ? 0 : 1)));
  } else if (ctx.hasInput(1)) {
    srcGeo = ctx.input(1);
    recv = g;
  } else throw new NodeError(`${type}: say where runs start: sources (a prim group) or input 1`, 'e.g. sources "@name=bolt* @name=hinge*", or connect points or a mesh to input 1');
  if (!triangulate(recv).tris.length) throw new NodeError(`${type}: no polygons are left for the runs to flow on`, 'sources must leave some surface of input 0');

  // trace
  const prm: FlowParams = {
    density: Math.max(0, Number(p.density)), direction: [dir[0], dir[1], dir[2]], length: [Number(p.length[0]), Number(p.length[1])], width: [Number(p.width[0]), Number(p.width[1])],
    wobble: Number(p.wobble), breakup: Number(p.breakup), ledge: Number(p.ledge), pool: Number(p.pool), drip: !!p.drip, step: Number(p.step), spill: Number(p.spill), seed: Number(p.seed),
  };
  const budget = simBudget(ctx, 'fewer runs (a lower density), shorter lengths or a larger step; or raise the limit');
  const { kw } = scales(prm);
  const cands = sampleSources(srcGeo, prm.seed, REF_WIDTH * 1e-3 * kw, kw);
  if (!cands.part.length) throw new NodeError(`${type}: the sources have no polygons or points`, pattern ? 'sources select prims that are polygons' : 'connect points or a polygon mesh to input 1');
  let traced;
  const tTrace = performance.now();
  try { traced = traceRuns(recv, srcGeo, cands, prm, () => budget.check()); } catch (e) {
    if (e instanceof FlowLimit) throw new NodeError(`${type}: the runs would need more than ${limits.maxSegments.toLocaleString('en-US')} segments`, 'lower density or length, or raise step (a run has about length / step segments)');
    throw e;
  }
  const { runs, stats } = traced;
  ctx.stat('trace_ms', Math.round(performance.now() - tTrace));
  const srcNames = pattern ? [...new Set(cands.names)] : ['input 1'];
  if (!stats.touching) ctx.warn(`${type}: no source part touches another surface within ${+(TOUCH * kw * 100).toPrecision(2)} cm (sources: ${listNames(srcNames)}); no runs`);
  else if (stats.touching === stats.ledgeRejected) ctx.warn(`${type}: every source part that touches a surface sits on a ledge (within ${p.ledge}° of flat) or under an overhang, where no run starts (sources: ${listNames(stats.touchingParts)}); no runs`);
  if (stats.capped) ctx.warn(`${type}: density ${p.density} would start more than ${MAX_RUNS.toLocaleString('en-US')} runs; the first ${MAX_RUNS.toLocaleString('en-US')} (in random order) are traced`);
  ctx.stat('runs', runs.count);
  ctx.stat('segments', runs.segs);
  ctx.stat('drips', stats.drips);
  ctx.stat('spills', stats.spills);
  ctx.stat('candidates', stats.candidates);
  ctx.stat('started', stats.started);
  ctx.stat('touching', stats.touching);
  ctx.stat('ledge_rejected', stats.ledgeRejected);
  ctx.stat('ended_ledge', stats.ended.ledge);
  ctx.stat('ended_length', stats.ended.length);
  ctx.stat('ended_fell', stats.ended.fell);
  ctx.stat('ended_lost', stats.ended.lost);

  // rasterise: per covered sample position, normal and size
  const sel = mask(g, 'prim', p.group);
  let skip: Uint8Array | null = null;
  if (sel) { skip = new Uint8Array(triPrim.length); for (let t = 0; t < triPrim.length; t++) skip[t] = sel[triPrim[t]] ? 0 : 1; }
  const s = bakeSamples(uv, tris, W, H, S, skip);
  if (s.outside) ctx.warn(`${type}: ${s.outside} triangle(s) reach outside the 0..1 uv square (clipped; UDIM tiles are not baked)`);
  if (!s.n) ctx.warn(`${type}: no texel is covered (uv collapsed or outside 0..1)`);
  const pos = vertexPositions(g);
  const SP = interpolate(s, tris, pos, 3);
  const SN = interpolate(s, tris, vertexNormals(g, CREASE), 3);
  normalize3(SN);
  const triTau = triTexelSizes(pos, uv, tris, W, H);
  const fin: number[] = [];
  for (const t of triTau) if (t === t && t > 0) fin.push(t);
  fin.sort((a, b) => a - b);
  const fallback = fin.length ? fin[fin.length >> 1] : 1e-3;
  const tau = new Float32Array(s.n);
  for (let k = 0; k < s.n; k++) { const t = triTau[s.tri[k]]; tau[k] = (t === t && t > 0 ? t : fallback) / S; }
  let skipSamples: Uint8Array | null = null;
  if (srcMask) { skipSamples = new Uint8Array(s.n); for (let k = 0; k < s.n; k++) skipSamples[k] = srcMask[triPrim[s.tri[k]]]; }
  const C = new Float32Array(s.n), along = new Float32Array(s.n), head = new Float32Array(s.n), strength = new Float32Array(s.n), id = new Float32Array(s.n);
  const stainK = Math.max(0, Number(p.stain) || 0), stain = stainK > 0 ? new Float32Array(s.n) : undefined;
  // texel sizes and islands, as every bake writes them (the stain's lattice keeps to the islands)
  const tl = texelLayers({ s, uv, tris, g } as unknown as Bake, pos);
  // the stain is smooth: drawn exactly on a lattice of samples a third of its narrowest half width apart, between them
  // interpolated
  const medTau = (() => { const t: number[] = []; for (let k = 0; k < s.n; k += Math.max(1, Math.floor(s.n / 4096))) t.push(tau[k]); t.sort((a, b) => a - b); return t[t.length >> 1] || 1; })();
  const latStep = Math.max(1, Math.min(8, Math.floor((stainK * 0.5 * Math.min(prm.width[0], prm.width[1])) / (3 * medTau))));
  const stainLattice = stain && latStep > 1 ? { pix: s.pix, gw: W * S, gh: H * S, step: latStep, island: tl.island.vals } : undefined;
  const tRaster = performance.now();
  try { rasterRuns(runs, { P: SP, N: SN, tau, skip: skipSamples }, prm.breakup, prm.seed, { C, along, head, strength, id, stain }, { check: () => budget.check(), stain: stainK, stainSkew: Math.max(0, Number(p.stain_skew) || 0), stainLattice }); } catch (e) {
    if (e instanceof FlowLimit) throw new NodeError(`${type}: the runs cover too many texel cells (${e.count.toLocaleString('en-US')} registrations)`, 'lower pool or width, or density');
    throw e;
  }

  ctx.stat('raster_ms', Math.round(performance.now() - tRaster));
  // layers: C, along, head, strength, id, mask. C and head are means over the texel's samples (an empty sample counts 0);
  // along, strength and id are those of the run that covers the texel most: never a mean with empty samples or other runs;
  // stain (when asked for) a mean as C
  const NL = stain ? 6 : 5, NM = stain ? 3 : 2;
  const CH = new Float32Array(s.n * NM);
  for (let k = 0; k < s.n; k++) { CH[k * NM] = C[k]; CH[k * NM + 1] = head[k]; if (stain) CH[k * NM + 2] = stain[k]; }
  const first = resolve(s, CH, NM);
  const bestK = new Int32Array(W * H).fill(-1), bestC = new Float32Array(W * H).fill(-1);
  for (let k = 0; k < s.n; k++) { const t = s.texel[k]; if (C[k] > bestC[t]) { bestC[t] = C[k]; bestK[t] = k; } }
  const data = new Float32Array(W * H * NL);
  for (let t = 0; t < W * H; t++) {
    data[t * NL] = first.data[t * NM]; data[t * NL + 3] = first.data[t * NM + 1];
    if (stain) data[t * NL + 5] = first.data[t * NM + 2];
    const k = bestK[t];
    if (k >= 0 && C[k] > 0) { data[t * NL + 1] = along[k]; data[t * NL + 2] = strength[k]; data[t * NL + 4] = id[k]; }
  }
  const img = new Image(W, H, outName(ctx));
  img.setSize(bakedImageSize(pos, uv, tris, W, H, skip)); // as every bake
  const pad = Math.max(0, Math.round(p.padding));
  dilate(data, NL, W, H, first.coverage, pad, new Array(NL).fill(0));
  // channel order in `data`: C, along, strength, head, id (, stain)
  ['C', 'along', 'strength', 'head', 'id', ...(stain ? ['stain'] : [])].forEach((name, c) => {
    const out = new Float32Array(W * H);
    for (let i = 0; i < out.length; i++) out[i] = data[i * NL + c];
    img.set(name === 'C' ? MAIN_LAYER : name, out);
  });
  const T = resolve(s, tl.texel.vals, 4).data, I = resolve(s, tl.island.vals, 1).data;
  dilate(T, 4, W, H, first.coverage, pad, tl.texel.background);
  dilate(I, 1, W, H, first.coverage, pad, tl.island.background);
  markGutter(I, first.coverage);
  img.set('texel', T).set('island', I);
  img.set('mask', first.coverage);
  let covered = 0;
  for (let i = 0; i < first.coverage.length; i++) if (first.coverage[i] > 0) covered++;
  ctx.stat('texels', covered);
  ctx.stat('coverage', covered / first.coverage.length);
  if (!p.keep_mesh) return imageGeo(img);
  const out = ctx.input(0).clone();
  out.volumes.push(img);
  return out;
}

defineNode({
  type: 'bake_flow',
  category: 'texture',
  summary: 'Bake runs that flow down the surface under gravity from source parts (rust under bolts, rain streaks under a ledge): traced in 3D across uv seams, varied in length and width, thin, breaking up, pooling on ledges.',
  description:
    'Runs start at the source parts (sources: a prim group of input 0, e.g. "@name=bolt* @name=hinge*"; or points or a mesh on input 1) where they touch another surface within 1 cm, ' +
    'one every 1 / density metres along each part (at least one per part), and walk down the receiving surface (every prim that is not a source): gravity projected onto the surface, bent sideways by 3D noise (wobble), ' +
    'snapped back onto the mesh, over edges and across uv seams, around bosses and over the underside of a lip. A surface whose normal is within ledge degrees of up stops the run, where it pools; ' +
    'a pool whose ledge has an edge within the spill reach (metres) spills over the edge nearest to it and the run goes on below with less strength; a source standing on a ledge starts a pool and does the same; ' +
    'at an overhang (a face turned down) it drips along gravity onto the surface below and goes on. A run is drawn from where it comes out from under its source part. ' +
    'Each run has its own length (length range; a random strength 0..1 makes the stronger ones the longer), width (width range: a little wider at the head, tapering to 30 % at the tail) and a strength that dies away along it so the end is soft (unless the run ends in a pool), gaps (breakup) and wander. ' +
    'Image layers: C = the run mask 0..1 (box-filtered over the texel, so thin runs stay thin at any resolution); along = 0 at the source to 1 at the tail; head = strong near the source (stain heads: (1 - along / 0.35)² × C); ' +
    'strength = the run\'s random 0..1 (a threshold picks how many runs show, without tracing again); id = a number that names the run (a hash of where it starts, so it stays when other parts are added or reordered; 0 = none); stain (with stain above 0) = a broad faint stain around the runs, a mean like C; mask = coverage; with supersample along, strength and id are those of the run that covers the texel most, never a mean. The source parts themselves bake 0. ' +
    'Water goes down the geometry, not down authored normals: the flow direction comes from face normals, smoothed only between faces that meet within 40°, so a face wound the wrong way reads as turned down and lets water through. The bottom of a groove whose sides are steeper than ledge pools, and runs on along it when it slopes. ' +
    'The metre constants of a run (gaps, wander, the swell at its head) follow the width and length ranges, so a run looks the same at any scale. ' +
    'Everything is measured in 3D at the texel, so no uv seam shows; the same seed gives the same runs, and another seed moves them. Input 0 needs non-overlapping uv in 0..1 (uv_unwrap).',
  aliases: ['flow_bake', 'bake_runs', 'bake_drips', 'bake_streaks', 'bake_rust_runs'],
  inputs: [
    { name: 'geo', desc: 'mesh with uv; its prims that are not sources are the surface the runs flow on' },
    { name: 'sources', desc: 'where runs start (points or a mesh) when sources is empty', optional: true },
  ],
  params: {
    resolution: resolutionParam(1024),
    supersample: { type: 'int', default: 1, min: 1, max: 4, desc: 'samples per texel along each axis (2 = 4 samples averaged: smoother edges, 4× the work)', aliases: ['ssaa', 'antialiasing', 'subsampling'] },
    padding: { type: 'int', default: 4, min: 0, max: 256, desc: 'dilate islands by this many texels (no background bleeding in mipmaps)', aliases: ['dilation', 'margin', 'edge_padding'] },
    uv_attrib: { type: 'string', default: 'uv', desc: 'vertex or point uv attribute to bake into', aliases: ['uv_name', 'uvattrib'] },
    group: P.group('prim', 'prims to bake ("" = all); the others leave their texels empty'),
    keep_mesh: { type: 'bool', default: false, desc: 'output the input mesh with the image added (off: only the image)', aliases: ['keep_input', 'keep'] },
    name: nameParam(),
    sources: P.group('prim', 'prims of input 0 the runs start from, e.g. "@name=bolt* @name=hinge*" ("" = input 1); they bake 0 and the runs flow on every other prim'),
    density: { type: 'float', default: 40, min: 0, max: 2000, desc: 'runs per metre of source part where it meets the surface (40 = one every 2.5 cm: a bolt gets one or two, a hinge four or five)', aliases: ['count', 'runs_per_metre', 'frequency'] },
    direction: { type: 'vec3', default: [0, -1, 0], desc: 'gravity: the way the runs flow', aliases: ['gravity', 'dir'] },
    length: { type: 'vec2', default: [0.05, 0.25], min: 0, max: 100, desc: 'range of the drawn length per run in metres, from where it comes out from under its source (the longer runs are the stronger)', aliases: ['run_length', 'length_range'] },
    width: { type: 'vec2', default: [0.003, 0.01], min: 0, max: 5, desc: 'range of the run width at the head in metres; runs taper to 30 % at the tail', aliases: ['run_width', 'width_range'] },
    wobble: { type: 'float', default: 0.3, min: 0, max: 1, desc: 'sideways wander of a run (3D noise on its walking direction); 0 = ruler-straight', aliases: ['meander', 'wander', 'spread'] },
    breakup: { type: 'float', default: 0.4, min: 0, max: 1, desc: 'gaps along a run and a wandering width (3D noise); the gaps grow toward the tail; 0 = unbroken', aliases: ['break_up', 'gaps', 'raggedness'] },
    ledge: { type: 'float', default: 30, min: 0, max: 90, desc: 'a surface whose normal is within this many degrees of up stops the run, which pools there (a 30° slope still sheds water)', aliases: ['ledge_angle', 'stop_angle'] },
    pool: { type: 'float', default: 1.5, min: 1, max: 10, desc: 'width multiplier of the pool where a run stops on a ledge', aliases: ['pool_width', 'puddle'] },
    drip: { type: 'bool', default: true, desc: 'a run reaching an overhang (a face turned down) falls along the direction to the next surface below and goes on; off: it ends there', aliases: ['drips'] },
    step: { type: 'float', default: 0, min: 0, max: 5, desc: 'walking step in metres (0 = half the smallest width)', aliases: ['step_size'] },
    spill: { type: 'float', default: 0.05, min: 0, max: 50, desc: 'a pool on a ledge (or a source standing on one) whose nearest edge is within this many metres spills over that edge and runs on down the surface below with 65 % of the strength; a ledge wider than this keeps the pool; 0 = pools stay where they are', aliases: ['spill_reach', 'overflow'] },
    seed: { type: 'int', default: 0, min: 0, max: 2147483647, desc: 'seed of the run starts, lengths, widths, wander and gaps' },
    stain: { type: 'float', default: 0, min: 0, max: 20, desc: 'a broad faint stain around each run, its half width this many times the run\'s head width (0 = none): layer stain, widest at the head and narrowing to under half down the run, no gaps, fading sideways and to nothing at the tail; where stains meet they add up (1 − Π(1 − v)), so many runs under an edge merge into a wash', aliases: ['stain_width', 'halo'] },
    stain_skew: { type: 'float', default: 0, min: 0, max: 8, desc: 'each run\'s stain times its strength (0..1; the longer runs are the stronger) to this power: 0 = every stain alike, 2 = most faint and a few strong', aliases: ['stain_contrast'] },
  },
  outputs: 'image <name> (default: the node name): C run mask 0..1, along, head, strength, id, mask (and stain when asked for)',
  usesNodeName: NAMED_BY_NODE,
  example: {
    nodes: {
      wall: { type: 'box', params: { size: [0.6, 0.6, 0.05] } },
      wall_named: { type: 'attrib_create', in: ['wall'], params: { name: 'name', class: 'prim', value: 'wall' } },
      bolt: { type: 'box', params: { size: [0.03, 0.03, 0.012], center: [0, 0.1, 0.03] } },
      bolt_named: { type: 'attrib_create', in: ['bolt'], params: { name: 'name', class: 'prim', value: 'bolt' } },
      parts: { type: 'merge', in: ['wall_named', 'bolt_named'] },
      uv: { type: 'uv_unwrap', in: ['parts'] },
      runs: { type: 'bake_flow', in: ['uv'], params: { sources: '@name=bolt', resolution: 256 } },
    },
    output: 'runs',
  },
  cook,
});
