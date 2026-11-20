// bake_measure (category "texture"): the model measured in 3D at every texel, one named layer per measure. Facing,
// height, distance, 3D noise and group are evaluated per texel sample; occlusion, cavity, shelter, visibility and
// curvature run on a cloud of surface points tied to the texel size and are interpolated to the texels in 3D, so uv
// seams never show. Algorithms: core/surface.ts.
import { Geometry } from '../core/geometry.ts';
import { RayScene } from '../core/analysis.ts';
import { TriBVH } from '../core/spatial.ts';
import { interpolate, memoBake, normalize3 } from '../core/bake.ts';
import { band } from '../core/pcg.ts';
import { hashNumber, hashString } from '../core/random.ts';
import { triangulate } from '../core/topology.ts';
import { runCurvature, runDistance, runInterp, runNoise, runRays, afterRun } from '../core/surface.ts';
import type { ConeMeasure, HemiMeasure, SurfaceRayArgs } from '../core/surface.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import type { CookContext, NodeDef, ParamDef } from '../graph/types.ts';
import { coerce, didYouMean, evalRamp } from '../graph/params.ts';
import { BAKE_DOC, BAKE_PARAMS, cloudOf, finishImage, setup, surfaceOf, surfaceWarnings, texelLayers, wrapImage } from './bake.ts';
import type { Bake } from './bake.ts';
import { mask } from './util.ts';
import { NAMED_BY_NODE } from './texture.ts';

const KINDS = ['facing', 'height', 'distance', 'noise', 'occlusion', 'cavity', 'shelter', 'visibility', 'curvature', 'group'] as const;
type Kind = (typeof KINDS)[number];
const RAY_KINDS: Kind[] = ['occlusion', 'cavity', 'shelter', 'visibility'];
const CLOUD_KINDS: Kind[] = [...RAY_KINDS, 'curvature'];

/** Fields every measure takes, then the fields of each kind. */
const COMMON = ['by', 'name', 'min', 'max', 'falloff', 'ramp', 'invert', 'where'];
const OWN: Record<Kind, string[]> = {
  facing: ['direction'],
  height: ['up'],
  distance: ['target', 'range'],
  noise: ['noise', 'fractal', 'size', 'octaves', 'roughness'],
  occlusion: ['max_distance'],
  cavity: ['max_distance'],
  shelter: ['direction', 'cone', 'max_distance'],
  visibility: ['max_distance'],
  curvature: ['radius', 'side'],
  group: ['pattern'],
};

/** The measure fields, validated like params (they also write the field list in the docs). */
const FIELDS: Record<string, ParamDef> = {
  by: { type: 'enum', options: [...KINDS], default: 'occlusion', desc: 'what is measured' },
  name: { type: 'string', default: '', desc: 'layer name (default: the by value)' },
  min: { type: 'float', default: 0, desc: 'band in the measure\'s units: 1 inside [min, max]' },
  max: { type: 'float', default: 0, desc: 'band in the measure\'s units: 1 inside [min, max]' },
  falloff: { type: 'float', default: 0, min: 0, desc: 'linear fade to 0 outside the band, in the measure\'s units' },
  ramp: { type: 'ramp', default: [[0, 0], [1, 1]], desc: 'reshape the 0..1 value' },
  invert: { type: 'bool', default: false, desc: 'write 1 − value' },
  where: { type: 'group', default: '', desc: 'prims where the measure applies; 0 elsewhere' },
  direction: { type: 'vec3', default: [0, 1, 0], desc: 'facing, shelter: the direction measured against' },
  cone: { type: 'float', default: 45, min: 0, max: 90, desc: 'shelter: half-angle of the cone around direction (degrees)' },
  up: { type: 'vec3', default: [0, 1, 0], desc: 'height: the axis' },
  target: { type: 'string', default: '', desc: 'distance: prims of input 0 ("@name=bolt*") or "input1"' },
  range: { type: 'float', default: 0.05, min: 0, desc: 'distance: metres at which the unbanded value reaches 0' },
  max_distance: { type: 'float', default: 0, min: 0, desc: 'ray measures: hits farther than this do not count (metres; 0 = occlusion 0.25, cavity 0.02, shelter and visibility unlimited)' },
  noise: { type: 'enum', options: ['perlin', 'simplex', 'worley'], default: 'perlin', desc: 'noise: the basis' },
  fractal: { type: 'enum', options: ['fbm', 'ridged', 'turbulence', 'none'], default: 'fbm', desc: 'noise: how octaves combine' },
  size: { type: 'vec3', default: [0.05, 0.05, 0.05], desc: 'noise: feature size in metres per axis ([0.005, 0.15, 0.005] = vertical streaks)' },
  octaves: { type: 'int', default: 4, min: 1, max: 12, desc: 'noise: octaves' },
  roughness: { type: 'float', default: 0.5, min: 0, max: 1, desc: 'noise: amplitude kept per octave' },
  radius: { type: 'float', default: 0.004, min: 0, desc: 'curvature: the scale the shape is measured at (metres)' },
  side: { type: 'enum', options: ['both', 'convex', 'concave'], default: 'both', desc: 'curvature: both (0.5 = flat), convex or concave (0..1)' },
  pattern: { type: 'group', default: '', desc: 'group: prims that read 1' },
};

const RESERVED = ['C', 'mask', 'texel', 'island'];

interface Measure {
  by: Kind;
  name: string;
  /** the band, when min or max is set */
  band: { lo: number; hi: number; fall: number } | null;
  ramp: { pos: number; value: any }[] | null;
  invert: boolean;
  where: string;
  f: Record<string, any>;
}

const T = 'bake_measure';
const fail = (msg: string, hint?: string) => new NodeError(`${T}: ${msg}`, hint);
const isIdentityRamp = (r: { pos: number; value: any }[]) => r.length === 2 && r[0].pos === 0 && r[0].value === 0 && r[1].pos === 1 && r[1].value === 1;
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const mm = (m: number) => `${Number((m * 1000).toPrecision(2))} mm`;

/** The prim names of a mesh, for a hint ("" when it has none). */
function partNames(g: Geometry, max = 8): string {
  const na = g.prims.get('name');
  if (!na || na.type !== 'string') return '';
  const seen: string[] = [];
  for (let p = 0; p < g.numPrims && seen.length <= max; p++) { const s = String(na.get(p) ?? ''); if (s && !seen.includes(s)) seen.push(s); }
  return seen.length > max ? seen.slice(0, max).join(', ') + ', …' : seen.join(', ');
}

/** The measures param, checked: every message names the measure and what to change. */
function parseMeasures(ctx: CookContext): Measure[] {
  let list = ctx.p.measures;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch { throw fail('measures is not valid JSON', 'measures: [{"by": "occlusion"}, {"by": "facing", "name": "top"}]'); }
  }
  if (list && !Array.isArray(list) && typeof list === 'object') list = [list];
  if (!Array.isArray(list) || !list.length) throw fail('measures is empty', 'measures: [{"by": "occlusion"}]');
  const out: Measure[] = [], names = new Set<string>();
  for (const m of list) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) throw fail(`each measure is an object like {"by": "occlusion"}, got ${JSON.stringify(m)?.slice(0, 60)}`);
    const by = String(m.by ?? '');
    if (!(KINDS as readonly string[]).includes(by)) {
      const dym = by ? didYouMean(by, [...KINDS]) : [];
      throw fail(by ? `unknown measure "${by}"` : 'a measure has no "by"', `${dym.length ? `did you mean "${dym[0]}"? ` : ''}measures: ${KINDS.join(', ')}`);
    }
    const kind = by as Kind;
    const name = m.name === undefined || m.name === '' ? kind : String(m.name);
    const allowed = [...COMMON, ...OWN[kind]];
    for (const k of Object.keys(m)) {
      if (allowed.includes(k)) continue;
      if (k in FIELDS) throw fail(`measure "${name}": field "${k}" does not apply to ${kind}`, `fields of ${kind}: ${allowed.join(', ')}`);
      const dym = didYouMean(k, allowed);
      throw fail(`measure "${name}": unknown field "${k}"`, `${dym.length ? `did you mean "${dym[0]}"? ` : ''}fields of ${kind}: ${allowed.join(', ')}`);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw fail(`measure name "${name}" is not a layer name`, 'letters, digits and _, not starting with a digit (it is read as a variable in tex_layers masks)');
    if (RESERVED.includes(name)) throw fail(`measure name "${name}" is reserved`, `${RESERVED.join(', ')} are written by the node; pick another name`);
    if (names.has(name)) throw fail(`two measures write layer "${name}"`, 'give each measure its own "name"');
    names.add(name);
    const f: Record<string, any> = {};
    for (const k of [...COMMON, ...OWN[kind]]) {
      if (k === 'by' || k === 'name') continue;
      const v = m[k];
      if (v === undefined && (k === 'min' || k === 'max')) continue;
      try { f[k] = coerce(k, FIELDS[k], v === undefined ? FIELDS[k].default : v); } catch (e: any) { throw fail(`measure "${name}": ${String(e.message).replace(/^param /, 'field ')}`); }
    }
    for (const k of ['direction', 'up']) {
      if (!f[k]) continue;
      const [x, y, z] = f[k], l = Math.hypot(x, y, z);
      if (!(l > 0)) throw fail(`measure "${name}": ${k} is the zero vector`, `${k}: [0, 1, 0] is up`);
      f[k] = [x / l, y / l, z / l];
    }
    if (kind === 'noise' && !f.size.every((s: number) => s > 0)) throw fail(`measure "${name}": noise size must be above 0 on every axis`, 'size is the feature size in metres per axis, e.g. [0.05, 0.05, 0.05]');
    if (kind === 'curvature' && !(f.radius > 0)) throw fail(`measure "${name}": curvature radius must be above 0`, 'radius: 0.004 measures the shape at 4 mm');
    if (kind === 'distance' && !String(f.target).trim()) throw fail(`measure "${name}": distance needs a target`, 'target: prims of input 0 ("@name=bolt*") or "input1"');
    const hasBand = m.min !== undefined || m.max !== undefined;
    out.push({
      by: kind, name,
      band: hasBand ? { lo: f.min ?? -Infinity, hi: f.max ?? Infinity, fall: f.falloff ?? 0 } : null,
      ramp: f.ramp && !isIdentityRamp(f.ramp) ? f.ramp : null,
      invert: !!f.invert, where: String(f.where ?? '').trim(), f,
    });
  }
  return out;
}

/** The measure's own 0..1 for a raw value in its units (see the description). */
function unit(m: Measure, raw: number, extent: number): number {
  switch (m.by) {
    case 'facing': return 0.5 + 0.5 * Math.cos((raw * Math.PI) / 180);
    case 'height': return clamp01(raw / (extent || 1));
    case 'distance': return Math.max(0, 1 - raw / (m.f.range || 1e-9));
    case 'curvature': return m.f.side === 'convex' ? clamp01(raw) : m.f.side === 'concave' ? clamp01(-raw) : clamp01(0.5 + 0.5 * raw);
    default: return clamp01(raw);
  }
}

/** band (or the own 0..1), ramp, invert. */
function shape(m: Measure, raw: number, extent: number): number {
  let v = m.band ? band(raw, m.band.lo, m.band.hi, m.band.fall) : unit(m, raw, extent);
  if (m.ramp) { const r = evalRamp(m.ramp, v); v = clamp01(Array.isArray(r) ? Number(r[0]) : Number(r)); }
  if (m.invert) v = 1 - v;
  return v;
}

/** shape() as one function per measure, for the loop over every texel (the common cases without a call per step). */
function shaper(m: Measure, extent: number): (raw: number) => number {
  if (m.ramp || m.invert) return (x) => shape(m, x, extent);
  if (m.band) { const { lo, hi, fall } = m.band; return (x) => band(x, lo, hi, fall); }
  switch (m.by) {
    case 'facing': { const k = Math.PI / 180; return (x) => 0.5 + 0.5 * Math.cos(x * k); }
    case 'height': { const e = 1 / (extent || 1); return (x) => { const v = x * e; return v < 0 ? 0 : v > 1 ? 1 : v; }; }
    case 'distance': { const e = 1 / (m.f.range || 1e-9); return (x) => { const v = 1 - x * e; return v > 0 ? v : 0; }; }
    case 'curvature':
      if (m.f.side === 'convex') return (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
      if (m.f.side === 'concave') return (x) => (x > 0 ? 0 : x < -1 ? 1 : -x);
      return (x) => { const v = 0.5 + 0.5 * x; return v < 0 ? 0 : v > 1 ? 1 : v; };
    default: return (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  }
}

/** The raw value of a measure where nothing is there to measure (the open, flat, far reading), for the background. */
const NEUTRAL: Record<Kind, number> = { facing: 90, height: 0, distance: Infinity, noise: 0.5, occlusion: 1, cavity: 0, shelter: 0, visibility: 1, curvature: 0, group: 0 };

type Arr = Float32Array;
const seq = <T>(x: T | Promise<T>, f: (v: T) => any) => afterRun(x as any, f as any);

function cookMeasure(ctx: CookContext) {
  const ms = parseMeasures(ctx);
  const b = setup(ctx), p = ctx.p, g = b.g, s = b.s, n = s.n;
  const sur = ctx.hasInput(1) ? ctx.input(1) : null;
  const surPolys = !!sur && triangulate(sur).tris.length > 0;
  // targets first: refusals before any work
  const targets = new Map<Measure, TriBVH>();
  for (const m of ms) {
    if (m.by !== 'distance') continue;
    const tg = String(m.f.target).trim();
    if (tg === 'input1') {
      if (!surPolys) throw fail(`measure "${m.name}": target "input1" but input 1 is empty`, 'connect the surroundings (a mesh with polygons) to input 1, or target prims of input 0');
      targets.set(m, new TriBVH(sur!));
    } else {
      const sel = mask(g, 'prim', tg);
      let any = false;
      if (sel) for (let i = 0; i < sel.length && !any; i++) any = sel[i] > 0;
      if (sel && !any) { const parts = partNames(g); throw fail(`measure "${m.name}": target "${tg}" matches no prims`, parts ? `parts: ${parts}` : 'input 0 has no prim names; use a group or an expression such as "@P.y>1"'); }
      targets.set(m, new TriBVH(sel ? g.subsetPrims(sel) : g));
    }
  }
  const raw: Arr[] = ms.map(() => new Float32Array(n));
  const extents = ms.map(() => 0);
  const out = () => finishMeasure(ctx, b, ms, raw, extents);
  if (!n) return out();
  // a cold pool runs a job on this thread: start its threads now, so the rays find them ready after the setup
  if (n >= 65536 && ms.some((m) => !['facing', 'height', 'group'].includes(m.by))) void ctx.engine.host.pool?.warm(true);
  const mesh = surfaceOf(b);
  surfaceWarnings(b, mesh);
  const run = (kernel: string, job: any, o?: any) => ctx.parallelMap(kernel, job, o);
  const P = b.P;
  let N: Float64Array | null = null;
  const normals = () => { if (!N) { N = interpolate(s, b.tris, mesh.VN, 3); normalize3(N); } return N; };
  const steps: (() => unknown)[] = [];
  const timed = (label: string, f: () => unknown) => steps.push(() => { const t0 = performance.now(); return seq(f(), () => ctx.stage(label, performance.now() - t0)); });
  ms.forEach((m, j) => {
    const R = raw[j];
    if (m.by === 'facing') timed(`facing ${m.name}`, () => {
      const Nn = normals(), [dx, dy, dz] = m.f.direction;
      for (let i = 0; i < n; i++) {
        const c = Nn[i * 3] * dx + Nn[i * 3 + 1] * dy + Nn[i * 3 + 2] * dz;
        R[i] = (Math.acos(c < -1 ? -1 : c > 1 ? 1 : c) * 180) / Math.PI;
      }
    });
    else if (m.by === 'height') timed(`height ${m.name}`, () => {
      const [ux, uy, uz] = m.f.up;
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < g.numPoints; i++) { const h = g.P[i * 3] * ux + g.P[i * 3 + 1] * uy + g.P[i * 3 + 2] * uz; if (h < lo) lo = h; if (h > hi) hi = h; }
      extents[j] = hi - lo;
      for (let i = 0; i < n; i++) R[i] = P[i * 3] * ux + P[i * 3 + 1] * uy + P[i * 3 + 2] * uz - lo;
    });
    else if (m.by === 'group') timed(`group ${m.name}`, () => {
      const sel = mask(g, 'prim', String(m.f.pattern ?? ''));
      for (let i = 0; i < n; i++) R[i] = !sel || sel[b.triPrim[s.tri[i]]] ? 1 : 0;
    });
    else if (m.by === 'noise') timed(`noise ${m.name}`, () => {
      const seed = hashString(m.name, hashNumber(Number(p.seed) || 0)) & 0x7fffffff;
      return seq(runNoise(run, s, b.tris, mesh.VP, { noise: m.f.noise, fractal: m.f.fractal, octaves: m.f.octaves, roughness: m.f.roughness, size: m.f.size, seed }), (V: Arr) => R.set(V));
    });
    else if (m.by === 'distance') timed(`distance ${m.name}`, () => {
      const hi = m.band ? m.band.hi + m.band.fall : m.f.range;
      return seq(runDistance(run, s, b.tris, mesh.VP, targets.get(m)!, hi === Infinity ? Infinity : Math.max(0, hi)), (V: Arr) => R.set(V));
    });
  });
  // the cloud measures: one ray pass for every ray measure, one curvature pass per radius, one interpolation
  const cloudMs = ms.filter((m) => CLOUD_KINDS.includes(m.by));
  if (cloudMs.length) steps.push(() => {
    const med = mesh.median;
    const h = p.spacing > 0 ? p.spacing : Math.max(0.0005, 4 * med);
    const k = med > 0 ? Math.max(1, h / med) : 1;
    const sc = cloudOf(b, mesh, k);
    for (const m of cloudMs) if (m.by === 'curvature' && m.f.radius < sc.spacing) ctx.warn(`${T}: curvature radius ${mm(m.f.radius)} is below the cloud spacing ${mm(sc.spacing)}; raise radius or lower spacing`);
    const cols = new Map<Measure, { src: 'ray' | 'curv'; col: number; radius?: number }>();
    const hemi: HemiMeasure[] = [], cones: ConeMeasure[] = [];
    const rayMs = cloudMs.filter((m) => m.by !== 'curvature');
    for (const m of rayMs) if (m.by !== 'shelter') {
      cols.set(m, { src: 'ray', col: hemi.length });
      hemi.push({ kind: m.by as HemiMeasure['kind'], maxD: m.f.max_distance > 0 ? m.f.max_distance : m.by === 'occlusion' ? 0.25 : m.by === 'cavity' ? 0.02 : 0 });
    }
    for (const m of rayMs) if (m.by === 'shelter') {
      cols.set(m, { src: 'ray', col: -1 });
      const c = (m.f.cone * Math.PI) / 180;
      cones.push({ dir: m.f.direction, cos: Math.cos(c), maxD: m.f.max_distance });
    }
    let ci = 0;
    for (const m of rayMs) if (m.by === 'shelter') cols.get(m)!.col = hemi.length + ci++;
    const radii = [...new Set(cloudMs.filter((m) => m.by === 'curvature').map((m) => m.f.radius as number))];
    for (const m of cloudMs) if (m.by === 'curvature') cols.set(m, { src: 'curv', col: radii.indexOf(m.f.radius) });
    const nr = hemi.length + cones.length, c = sc.cloud, M = cloudMs.length;
    const CV = new Float32Array(c.n * M);
    const fill = (src: 'ray' | 'curv', col: number, V: Arr, stride: number) => {
      cloudMs.forEach((m, j) => {
        const e = cols.get(m)!;
        if (e.src !== src || e.col !== col) return;
        for (let i = 0; i < c.n; i++) CV[i * M + j] = V[i * stride + col];
      });
    };
    const sub: (() => unknown)[] = [];
    if (nr) sub.push(() => {
      const t0 = performance.now();
      const bias = Math.min(1e-4 * b.diag, 0.001);
      const scene = surPolys ? RayScene.of(Geometry.merge([g, sur!])) : memoBake(g, 'rayscene', () => RayScene.of(g));
      const contact = surPolys ? new TriBVH(sur!) : null;
      const args: SurfaceRayArgs = { samples: Math.round(p.samples), bias, seed: Number(p.seed) || 0, hemi, cones, contact: contact ? 2 * bias : 0 };
      ctx.stat('rays', c.n * args.samples * (1 + cones.length));
      return seq(runRays(run, sc, scene, contact, args), (V: Arr) => {
        for (let col = 0; col < nr; col++) fill('ray', col, V, nr);
        ctx.stage('rays', performance.now() - t0);
      });
    });
    radii.forEach((r, ri) => sub.push(() => {
      const t0 = performance.now();
      return seq(runCurvature(run, sc, r), (V: Arr) => { fill('curv', ri, V, 1); ctx.stage(`curvature ${mm(r)}`, performance.now() - t0); });
    }));
    sub.push(() => {
      const t0 = performance.now();
      return seq(runInterp(run, s, b.tris, mesh, sc, CV, M), (V: Arr) => {
        cloudMs.forEach((m) => {
          const j = ms.indexOf(m), R = raw[j], q = cloudMs.indexOf(m);
          for (let i = 0; i < n; i++) R[i] = V[i * M + q];
        });
        ctx.stage('interpolation', performance.now() - t0);
      });
    });
    return chainSteps(sub);
  });
  return seq(chainSteps(steps), out);
}

/** Run the steps in order, each after the previous one's result (synchronous while every step is). */
function chainSteps(steps: (() => unknown)[]): unknown {
  let x: unknown = undefined;
  for (const st of steps) x = seq(x, () => st());
  return x;
}

function finishMeasure(ctx: CookContext, b: Bake, ms: Measure[], raw: Float32Array[], extents: number[]) {
  const n = b.s.n, g = b.g;
  const layers: Record<string, { vals: Float32Array; ch: number; background: number[] }> = {};
  let first: Float32Array | null = null, firstBg = 0;
  let t0 = performance.now();
  ms.forEach((m, j) => {
    const sel = m.where ? mask(g, 'prim', m.where) : null;
    const R = raw[j], v = new Float32Array(n), ext = extents[j];
    const f = shaper(m, ext);
    for (let i = 0; i < n; i++) v[i] = f(R[i]);
    if (sel) {
      const off = new Uint8Array(b.triPrim.length);
      for (let t = 0; t < off.length; t++) off[t] = sel[b.triPrim[t]] ? 0 : 1;
      for (let i = 0; i < n; i++) if (off[b.s.tri[i]]) v[i] = 0;
    }
    const bg = shape(m, NEUTRAL[m.by], extents[j]);
    layers[m.name] = { vals: v, ch: 1, background: [bg] };
    if (!first) { first = v; firstBg = bg; }
  });
  ctx.stage('shape', performance.now() - t0);
  t0 = performance.now();
  if (n) {
    const mesh = surfaceOf(b);
    const { texel, island } = texelLayers(b, mesh.VP);
    layers.texel = texel; layers.island = island;
  } else {
    layers.texel = { vals: new Float32Array(0), ch: 4, background: [0, 0, 0, 1] };
    layers.island = { vals: new Float32Array(0), ch: 1, background: [-1] };
  }
  ctx.stage('texel and island', performance.now() - t0);
  t0 = performance.now();
  ctx.stat('measures', ms.length);
  const { img } = finishImage(b, first!, 1, [firstBg], layers);
  ctx.stage('image', performance.now() - t0);
  return wrapImage(b, img);
}

const FIELD_DOC = Object.entries(FIELDS).filter(([k]) => k !== 'by').map(([k, d]) => `${k} (${d.desc})`).join('; ');

defineNode({
  type: T,
  category: 'texture',
  usesNodeName: NAMED_BY_NODE,
  summary: 'Measure the model in 3D at every texel into named layers: facing, height, distance to parts, 3D noise, occlusion, cavity, shelter, visibility, curvature at a radius, group. Ray measures share one set of rays; uv seams never show.',
  description:
    BAKE_DOC + 'measures is a list of objects, each {"by": kind, "name": layer, …}; the image gets one layer per measure (C = the first), ' +
    'then "texel" (metres per texel along u and v), "island" (uv island) and "mask". Kinds and their own 0..1: facing (1 toward ' +
    'direction, 0 away; band units: degrees between the normal and direction), height (0 at input 0\'s lowest point, 1 at its ' +
    'highest along up; metres), distance (1 at the target, 0 at range; metres), noise (3D, 0..1, continuous across seams and ' +
    'triangles), occlusion (1 = open, as bake_ao), cavity (1 = in a crevice), shelter (1 = covered from direction within cone; ' +
    'the part of the cone behind the surface counts as covered), visibility (1 = seen from outside: a quarter of the ' +
    'hemisphere escaping the model and input 1 counts as fully seen), curvature (as bake_curvature method surface; band units: ' +
    'the signed value, 1 = a 90° convex edge), group (1 on pattern). Each value is shaped like the point mask node: min/max/' +
    'falloff make a band in the measure\'s units (unset = its own 0..1), then ramp, then invert, then where (0 outside). ' +
    'Facing, height, distance, noise and group are evaluated per texel; occlusion, cavity, shelter, visibility and curvature ' +
    'on a cloud of surface points every `spacing` metres (default 4 texels at this resolution, at least 0.5 mm; denser where ' +
    'the atlas gives more texels) and taken to each texel from the cloud points of its own part within 2 × spacing that face ' +
    'its way, so values do not bleed around edges or onto the far side of a plate. Every ray measure counts over one set of ' +
    '`samples` cosine-weighted rays per cloud point; shelter casts its own cone. Input 1 (surroundings: a wall, the ground) ' +
    'blocks rays, and a face lying flat against it counts as covered. Faces wound against their neighbours are measured turned ' +
    'and reported; a closed part that faces inward is reported, not turned. Fields: ' + FIELD_DOC + '.',
  aliases: ['bake_measures', 'bake_noise', 'bake_distance', 'bake_cavity', 'bake_masks', 'bake_mesh_mask', 'bake_shelter', 'bake_visibility'],
  inputs: [
    { name: 'geo', desc: 'mesh to bake (needs uv without overlaps: uv_unwrap or uv_layout)' },
    { name: 'surroundings', desc: 'optional: geometry that blocks rays (a wall, the ground, neighbours) and can be a distance target ("input1")', optional: true },
  ],
  params: {
    ...BAKE_PARAMS(),
    measures: { type: 'json', default: [{ by: 'occlusion' }], desc: 'the measures: [{"by": "occlusion"}, {"by": "facing", "name": "top", "min": 0, "max": 30, "falloff": 15}, {"by": "noise", "name": "grain", "size": [0.005, 0.15, 0.005]}]', aliases: ['measure', 'masks', 'layers'] },
    samples: { type: 'int', default: 32, min: 4, max: 256, desc: 'rays per cloud point, shared by every ray measure (each texel averages several cloud points)', aliases: ['rays'] },
    spacing: { type: 'float', default: 0, min: 0, desc: 'distance between cloud points for ray and curvature measures (metres; 0 = 4 texels at this resolution, at least 0.5 mm)', aliases: ['cloud_spacing'] },
    seed: { type: 'int', default: 0, desc: 'ray and noise seed' },
  },
  outputs: 'image <name> (default: the node name): C = the first measure, one layer per measure, texel, island, mask',
  example: {
    nodes: {
      box: { type: 'box' },
      pocket: { type: 'poly_extrude', in: ['box'], params: { group: '@P.y>0.4', distance: -0.2, inset: 0.15 } },
      uv: { type: 'uv_unwrap', in: ['pocket'] },
      measure: {
        type: 'bake_measure', in: ['uv'],
        params: {
          resolution: 256, samples: 16,
          measures: [{ by: 'occlusion' }, { by: 'facing', name: 'top', min: 0, max: 30, falloff: 20 }, { by: 'noise', name: 'grain', size: [0.1, 0.1, 0.1] }, { by: 'curvature', name: 'edges', radius: 0.05 }],
        },
      },
    },
    output: 'measure',
  },
  cook: cookMeasure,
} as NodeDef);
