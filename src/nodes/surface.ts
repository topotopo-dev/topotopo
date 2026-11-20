// bake_measure and bake_edge_wear (category "texture"). bake_measure: the model measured in 3D at every texel, one named
// layer per measure. Facing, height, distance, 3D noise and group are evaluated per texel sample; occlusion, cavity,
// shelter, visibility and curvature run on a cloud of surface points tied to the texel size and are interpolated to the
// texels in 3D, so uv seams never show. bake_edge_wear: paint wear on edges from surface curvature on the same cloud,
// broken up by 3D noise per texel. Algorithms: core/surface.ts.
import { Geometry } from '../core/geometry.ts';
import { RayScene } from '../core/analysis.ts';
import { TriBVH } from '../core/spatial.ts';
import { bakeMemoDrop, curvatureEdges, edgeGrid, interpolate, memoBake, normalize3 } from '../core/bake.ts';
import type { CurvatureArgs } from '../core/bake.ts';
import { band } from '../core/pcg.ts';
import { hashNumber, hashString } from '../core/random.ts';
import { triangulate } from '../core/topology.ts';
import { bendSamples, CONTACT_GAP, contactBuried, denseEstimate, edgeField, late, PAST_DEADLINE, facetSizes, wearRegions, MAX_DENSE, rayBias, refineCloud, runBuried, TOO_DENSE, runCurvature, runDistance, runEdgeWear, runInterp, runNoise, runRays, runSpread, afterRun } from '../core/surface.ts';
import type { ConeMeasure, EdgeWearArgs, HemiMeasure, RefinedCloud, SurfaceCloud, SurfaceMesh, SurfaceRayArgs } from '../core/surface.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import type { CookContext, NodeDef, ParamDef } from '../graph/types.ts';
import { coerce, didYouMean, evalRamp } from '../graph/params.ts';
import { BAKE_DOC, BAKE_PARAMS, buriedOf, checkSurfaceRadius, cloudOf, finishImage, setup, surfaceOf, surfaceRunner, surfaceWarnings, texelLayers, wrapImage } from './bake.ts';
import type { Bake } from './bake.ts';
import { P, mask } from './util.ts';
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
  for (const m of ms) if (m.by === 'curvature') checkSurfaceRadius(b, m.f.radius, `measure "${m.name}": curvature radius`);
  const raw: Arr[] = ms.map(() => new Float32Array(n));
  const extents = ms.map(() => 0);
  const out = () => finishMeasure(ctx, b, ms, raw, extents);
  if (!n) return out();
  // a cold pool runs a job on this thread: start its threads now, so the rays find them ready after the setup
  if (n >= 65536 && ms.some((m) => !['facing', 'height', 'group'].includes(m.by))) void ctx.engine.host.pool?.warm(true);
  const mesh = surfaceOf(b);
  surfaceWarnings(b, mesh);
  const { run, deadline, check, guard } = surfaceRunner(ctx, 'fewer measures, fewer samples, a smaller curvature radius or a lower resolution; or raise the limit');
  const P = b.P;
  let N: Float64Array | null = null;
  const normals = () => { if (!N) { N = interpolate(s, b.tris, mesh.VN, 3); normalize3(N); } return N; };
  const steps: (() => unknown)[] = [];
  const timed = (label: string, f: () => unknown) => steps.push(() => { check(); const t0 = performance.now(); return seq(f(), () => ctx.stage(label, performance.now() - t0)); });
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
      return seq(runNoise(run, s, b.tris, mesh.VP, { noise: m.f.noise, fractal: m.f.fractal, octaves: m.f.octaves, roughness: m.f.roughness, size: m.f.size, seed, deadline }), (V: Arr) => R.set(V));
    });
    else if (m.by === 'distance') timed(`distance ${m.name}`, () => {
      const hi = m.band ? m.band.hi + m.band.fall : m.f.range;
      return seq(runDistance(run, s, b.tris, mesh.VP, targets.get(m)!, hi === Infinity ? Infinity : Math.max(0, hi), deadline), (V: Arr) => R.set(V));
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
    // the mesh first, then the surroundings: the buried test reads the mesh's triangles by their index
    let sceneMade: RayScene | null = null;
    const scene = () => (sceneMade ??= surPolys ? RayScene.of(Geometry.merge([g, sur!])) : memoBake(g, 'rayscene', () => RayScene.of(g)));
    let CB: Uint8Array | null = null;
    sub.push(() => seq(buriedShared(b, mesh, sc, scene, surPolys ? sur : null, run, deadline), (B: Uint8Array | null) => { CB = B; }));
    if (nr) sub.push(() => {
      const t0 = performance.now();
      const bias = rayBias(b.diag);
      const contact = surPolys ? new TriBVH(sur!) : null;
      const args: SurfaceRayArgs = { samples: Math.round(p.samples), bias, seed: Number(p.seed) || 0, hemi, cones, contact: contact ? 2 * bias : 0, deadline };
      ctx.stat('rays', c.n * args.samples * (1 + cones.length));
      return seq(runRays(run, sc, scene(), contact, args, CB), (V: Arr) => {
        for (let col = 0; col < nr; col++) fill('ray', col, V, nr);
        ctx.stage('rays', performance.now() - t0);
      });
    });
    radii.forEach((r, ri) => sub.push(() => {
      const t0 = performance.now();
      return seq(curvatureShared(sc, r, surPolys ? sur : null, CB, run, deadline), (V: Arr) => { fill('curv', ri, V, 1); ctx.stage(`curvature ${mm(r)}`, performance.now() - t0); });
    }));
    sub.push(() => {
      const t0 = performance.now();
      return seq(runInterp(run, s, b.tris, mesh, sc, CV, M, CB, deadline), (V: Arr) => {
        cloudMs.forEach((m) => {
          const j = ms.indexOf(m), R = raw[j], q = cloudMs.indexOf(m);
          for (let i = 0; i < n; i++) R[i] = V[i * M + q];
        });
        ctx.stage('interpolation', performance.now() - t0);
      });
    });
    return chainSteps(sub);
  });
  return guard(() => seq(chainSteps(steps), out));
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
    'the signed value, 1 = a 90° convex edge; radius at most half the model\'s size), group (1 on pattern). Each value is ' +
    'shaped like the point mask node: min/max/falloff make a band in the measure\'s units (unset = its own 0..1), then ramp, ' +
    'then invert, then where (0 outside). Facing, height, distance, noise and group are evaluated per texel; occlusion, ' +
    'cavity, shelter, visibility and curvature on a cloud of surface points every `spacing` metres (default 4 texels at this ' +
    'resolution, at least 0.5 mm; denser where the atlas gives more texels, never sparser than spacing where it gives fewer) ' +
    'and taken to each texel from the cloud points of its own part within 2 × spacing that face its way, so values do not ' +
    'bleed around edges or onto the far side of a plate. A point inside another part (a post sunk into a plate) is buried: ' +
    'it reads covered and no texel that is seen takes its value; curvature counts the points of every part that are not ' +
    'buried, so a junction between parts reads concave. Every ray measure counts over one set of `samples` cosine-weighted ' +
    'rays per cloud point; shelter casts its own cone. Input 1 (surroundings: a wall, the ground) blocks rays, and a face ' +
    'lying flat against it and facing it counts as covered. Results do not depend on prim order. Faces wound against their ' +
    'neighbours are measured turned and reported; a closed part that faces inward is reported, not turned. Stops at the time ' +
    'limit of long-running nodes. Fields: ' + FIELD_DOC + '.',
  aliases: ['bake_measures', 'bake_noise', 'bake_distance', 'bake_cavity', 'bake_shelter', 'bake_visibility'],
  inputs: [
    { name: 'geo', desc: 'mesh to bake (needs uv without overlaps: uv_unwrap or uv_layout)' },
    { name: 'surroundings', desc: 'optional: geometry that blocks rays (a wall, the ground, neighbours) and can be a distance target ("input1")', optional: true },
  ],
  params: {
    ...BAKE_PARAMS(),
    measures: { type: 'json', default: [{ by: 'occlusion' }], desc: 'the measures: [{"by": "occlusion"}, {"by": "facing", "name": "top", "min": 0, "max": 30, "falloff": 15}, {"by": "noise", "name": "grain", "size": [0.005, 0.15, 0.005]}]', aliases: ['measure', 'masks', 'layers'] },
    samples: { type: 'int', default: 32, min: 4, max: 256, desc: 'rays per cloud point, shared by every ray measure (each texel averages several cloud points)', aliases: ['rays'] },
    spacing: { type: 'float', default: 0, min: 0, desc: 'distance between cloud points for ray and curvature measures (metres; 0 = 4 texels at this resolution, at least 0.5 mm)', aliases: ['cloud_spacing'] },
    seed: { ...P.seed(), desc: 'ray and noise seed' },
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

// ---------------------------------------------------------------- results shared by the surface bakes of one cloud

/**
 * Buried points (per surroundings) and curvature (per radius and surroundings) of one cloud, made once for every
 * bake_measure and bake_edge_wear of the mesh: kept in the bake memo, owned by the cloud, so they count against its
 * byte budget with everything else, are released oldest first and die with the cloud.
 */
/** A number per surroundings geometry (0: none), for the keys. */
const surIds = new WeakMap<Geometry, number>();
let surNext = 1;
const surId = (sur: Geometry | null) => { if (!sur) return 0; let i = surIds.get(sur); if (i === undefined) surIds.set(sur, i = surNext++); return i; };

function perCloudMemo<T>(sc: object, key: string, make: () => T | Promise<T>): T | Promise<T> {
  return memoBake(sc, `cloud|${key}`, make);
}

/** The key each perCloudLatest slot holds now, per cloud. */
const latestKey = new WeakMap<object, Map<string, string>>();

/** perCloudMemo with one slot: the value for `key`, made anew (and the old one let go) when the key changes. */
function perCloudLatest<T>(sc: object, slot: string, key: string, make: () => T | Promise<T>): T | Promise<T> {
  let m = latestKey.get(sc);
  if (!m) latestKey.set(sc, (m = new Map()));
  const had = m.get(slot);
  if (had !== undefined && had !== key) bakeMemoDrop(sc, `latest|${slot}|${had}`);
  m.set(slot, key);
  return memoBake(sc, `latest|${slot}|${key}`, make);
}

/** Buried cloud points with these surroundings (null: the mesh alone), shared per cloud. */
function buriedShared(b: Bake, mesh: SurfaceMesh, sc: SurfaceCloud, scene: () => RayScene, sur: Geometry | null, run: (kernel: string, job: any, o?: any) => any, deadline: number): Uint8Array | null | Promise<Uint8Array | null> {
  return seq(perCloudMemo(sc, `buried|${surId(sur)}`, () => buriedOf(b, mesh, sc, scene, sur, run, deadline)), (B: Uint8Array | null) => {
    if (B) { let k = 0; for (let i = 0; i < B.length; i++) if (B[i]) k++; b.ctx.stat('buried_points', k); }
    return B;
  }) as Uint8Array | null | Promise<Uint8Array | null>;
}

/** Surface curvature per cloud point at radius r, shared per cloud and buried set. */
const curvatureShared = (sc: SurfaceCloud, r: number, sur: Geometry | null, CB: Uint8Array | null, run: (kernel: string, job: any, o?: any) => any, deadline: number) =>
  perCloudMemo(sc, `curvature|${r}|${surId(sur)}`, () => runCurvature(run, sc, r, CB, deadline));

// ---------------------------------------------------------------- bake_edge_wear

const TW = 'bake_edge_wear';
/** What bake_edge_wear builds per texel sample: the wear field W, the layers it publishes, and from the spread the proximity PX (near, far) and DD (distance to the nearest edge and to the one across; null for method dihedral). */
interface WearLayers { W: Float32Array; convex: Float32Array; concave: Float32Array; handled: Float32Array; PX: Float32Array; DD: Float32Array | null }
const failW = (msg: string, hint?: string) => new NodeError(`${TW}: ${msg}`, hint);
/** Near the focus, wear reaches up to 1 + FOCUS_REACH × focus_amount times reach in from an edge. */
const FOCUS_REACH = 1.5;
/** Softness of the chip, bare and core outlines, in units of the wear field. */
const WEAR_EDGE = 0.03;

/** The chip threshold of the wear field for an amount (0 = nothing wears; larger amounts only add wear). */
export const wearThreshold = (amount: number) => 1 - 0.85 * Math.max(0, Math.min(1, amount));

function cookEdgeWear(ctx: CookContext) {
  const p = ctx.p;
  for (const [k, h] of [['radius', 'radius: 0.004 measures edges at 4 mm'], ['reach', 'reach: 0.008 lets wear reach 8 mm in from an edge'], ['chip_size', 'chip_size: 0.006 breaks the outline up at 6 mm'], ['patch_size', 'patch_size: 0.15 decides which stretches of edge wear at 15 cm']] as const)
    if (!(p[k] > 0)) throw failW(`${k} must be above 0`, h);
  const b = setup(ctx), g = b.g, s = b.s, n = s.n;
  const sur = ctx.hasInput(1) ? ctx.input(1) : null;
  const surPolys = !!sur && triangulate(sur).tris.length > 0;
  const focus = String(p.focus ?? '').trim();
  let focusSel: Uint8Array | null = null;
  if (focus) {
    const sel = mask(g, 'prim', focus);
    let any = false;
    if (sel) for (let i = 0; i < sel.length && !any; i++) any = sel[i] > 0;
    if (sel && !any) { const parts = partNames(g); throw failW(`focus "${focus}" matches no prims`, parts ? `parts: ${parts}` : 'input 0 has no prim names; use a group or an expression such as "@P.y>1"'); }
    focusSel = sel;
  }
  const surface = p.method !== 'dihedral';
  if (surface) checkSurfaceRadius(b, p.radius, 'radius');
  const amount = p.amount, t = wearThreshold(amount), bareStep = Math.max(0, p.bare_step), coreStep = Math.max(bareStep, p.core_step);
  const L: WearLayers = { W: new Float32Array(n), convex: new Float32Array(n), concave: new Float32Array(n), handled: new Float32Array(n), PX: new Float32Array(n * 2), DD: null };
  // near the focus wear reaches farther in from the edges, up to this
  const far = p.reach * (1 + FOCUS_REACH * (focusSel ? p.focus_amount : 0));
  let stopAt = 0;
  const out = () => finishEdgeWear(ctx, b, L, amount, t, bareStep, coreStep, p.radius, stopAt);
  if (!n) return out();
  if (n >= 65536) void ctx.engine.host.pool?.warm(true);
  const mesh = surfaceOf(b);
  surfaceWarnings(b, mesh);
  facetWarning(b, mesh, p.radius);
  const { run, deadline, check, guard } = surfaceRunner(ctx, 'a smaller radius or reach, or a lower resolution; or raise the limit');
  stopAt = deadline;
  const steps: (() => unknown)[] = [];
  const timed = (label: string, f: () => unknown) => steps.push(() => { check(); const t0 = performance.now(); return seq(f(), () => ctx.stage(label, performance.now() - t0)); });
  let focusTree: TriBVH | null = null;
  const focusBVH = () => (focusTree ??= new TriBVH(g.subsetPrims(focusSel!)));
  if (focusSel) timed('focus', () => {
    const R = Math.max(0, p.focus_radius), reach = Math.max(R, 1e-6 * b.diag);
    // per texel, shared by the cooks of this raster that keep the focus
    const H = perCloudMemo(s, `handled|${focus}|${R}`, (): any => seq(runDistance(run, s, b.tris, mesh.VP, focusBVH(), reach, deadline), (D: Float32Array) => {
      const H = new Float32Array(n);
      for (let i = 0; i < n; i++) { const d = D[i]; H[i] = !(d < reach) ? 0 : R > 0 ? (1 - d / R) ** 2 : 1; }
      return H;
    }));
    return seq(H, (H: Float32Array) => { L.handled = H; });
  });
  if (surface) steps.push(() => {
    const med = mesh.median, r = p.radius;
    // bake_measure's cloud (every 4 texels, the same key), shared with it; where it is too coarse for the radius (under
    // four spacings across it) it is refined near the bends only (refinedOf)
    const kM = med > 0 ? Math.max(1, Math.max(0.0005, 4 * med) / med) : 1;
    const sc0 = cloudOf(b, mesh, kM);
    const surG = surPolys ? sur! : null;
    let sceneV: RayScene | null = null;
    const scene = () => (sceneV ??= surG ? RayScene.of(Geometry.merge([g, surG])) : memoBake(g, 'rayscene', () => RayScene.of(g)));
    return seq(buriedShared(b, mesh, sc0, scene, surG, run, deadline), (CB0: Uint8Array | null) => {
      const got: any = refinedOf(b, mesh, sc0, CB0, r, Math.min(r / 3, sc0.spacing), surG, scene, run, deadline);
      return seq(got, ({ sc, CB }: { sc: SurfaceCloud; CB: Uint8Array | null }) => {
        b.ctx.stat('cloud_points', sc.cloud.n);
        let t0 = performance.now();
        return seq(curvatureShared(sc, r, surG, CB, run, deadline), (CV: Float32Array) => {
          ctx.stage('curvature', performance.now() - t0);
          const c = sc.cloud;
          t0 = performance.now();
          // convex and concave at the texels, kept for the last radius (as large as the raster)
          const M = () => {
            const M = new Float32Array(c.n * 2);
            for (let i = 0; i < c.n; i++) { const v = CV[i]; M[i * 2] = v > 0 ? Math.min(1, v) : 0; M[i * 2 + 1] = v < 0 ? Math.min(1, -v) : 0; }
            return M;
          };
          const E = () => {
            const E = new Float32Array(c.n);
            for (let i = 0; i < c.n; i++) E[i] = edgeField(CV[i]);
            return E;
          };
          // the proximity at the texels does not depend on amount, seed or the noise: kept for the last reach
          const key = `${r}|${p.reach}|${far}|${focus}|${p.focus_radius}|${surId(surG)}`;
          const HD = focusSel ? L.handled : null;
          // convex, concave and the proximity in one pass over the texels
          const V = perCloudLatest(sc, 'texels', key, () => runSpread(run, s, b.tris, mesh, sc, E(), HD, p.reach, far, r, CB, deadline, M()));
          return seq(V, (V: Float32Array) => {
            const PX = new Float32Array(n * 2), DD = new Float32Array(n * 2);
            for (let i = 0; i < n; i++) {
              PX[i * 2] = V[i * 6]; PX[i * 2 + 1] = V[i * 6 + 1]; DD[i * 2] = V[i * 6 + 2]; DD[i * 2 + 1] = V[i * 6 + 3];
              L.convex[i] = V[i * 6 + 4]; L.concave[i] = V[i * 6 + 5];
            }
            L.PX = PX;
            L.DD = DD;
            ctx.stage('spread', performance.now() - t0);
          });
        });
      });
    });
  });
  else timed('dihedral', () => {
    // the mesh's edge angles near each texel, reaching max(radius, reach)
    const r = Math.max(p.radius, p.reach);
    const edges = curvatureEdges(g, 1e-6 * b.diag, 0.5, true);
    const grid = edgeGrid(edges, r);
    const args: CurvatureArgs = { radius: r, facing: 0.25, origin: grid.origin, cell: grid.cell, dims: grid.dims };
    const V = new Float64Array(n);
    return seq(run('bake_curvature', { count: n, args, inputs: { P: b.P, N: b.N }, results: { V }, shared: { E: edges.E, D: edges.D, K: edges.K, FN: edges.FN, start: grid.start, items: grid.items } }), () => {
      for (let i = 0; i < n; i++) { const v = V[i]; L.convex[i] = v > 0 ? Math.min(1, v) : 0; L.concave[i] = v < 0 ? Math.min(1, -v) : 0; L.PX[i * 2] = L.PX[i * 2 + 1] = edgeField(v); }
    });
  });
  timed('wear', () => {
    const args: EdgeWearArgs = { seed: Number(p.seed) || 0, chipSize: p.chip_size, patchSize: p.patch_size, raggedness: p.raggedness, patchiness: p.patchiness, focusAmount: focusSel ? p.focus_amount : 0, deadline };
    // the wear field does not depend on amount: kept for the last everything else, so a cook that changes only amount
    // settles the kept field again
    const key = JSON.stringify([p.method, p.radius, p.reach, far, focus, p.focus_radius, surPolys ? surId(sur) : 0, { ...args, deadline: 0 }]);
    const W = perCloudLatest(s, 'wear', key, () => runEdgeWear(run, s, b.tris, mesh.VP, L.PX, focusSel ? L.handled : null, args));
    return seq(W, (W: Float32Array) => { L.W = W; });
  });
  return guard(() => seq(chainSteps(steps), out));
}

/**
 * bake_measure's cloud refined near the bends for edge wear at radius r: the bends come from the mesh (bendSamples), and
 * space within r of them gets points `step` apart (refineCloud), where the curvature is measured at the full density;
 * the edge points come from it, and the wear spreads from them to the texels. Kept with the ordinary cloud (in the bake
 * memo, owned by it), with its buried points: the ordinary cloud's, and for each dense point that of the nearest
 * ordinary point of its part (rays where none is near).
 */
function refinedOf(b: Bake, mesh: SurfaceMesh, sc0: SurfaceCloud, CB0: Uint8Array | null, r: number, step: number, sur: Geometry | null, scene: () => RayScene, run: (kernel: string, job: any, o?: any) => any, deadline: number) {
  const ctx = b.ctx, s0 = sc0.spacing;
  {
    const t0 = performance.now(), made = { now: false };
    let R: RefinedCloud;
    try {
      R = perCloudMemo(sc0, `refine|${r}|${step}`, () => {
        made.now = true;
        const Z = bendSamples(b.g, mesh, b.tris, b.skip, r, step, deadline);
        // refused before the work when it would plainly pass the bound (refineCloud stops at it too)
        if (denseEstimate(Z, r + Z.gap, step) > MAX_DENSE) throw new Error(TOO_DENSE);
        return refineCloud(sc0, mesh, b.tris, b.skip, Z.P, r + Z.gap, step, deadline, Math.max(step, r / 2));
      }) as RefinedCloud;
    } catch (e) {
      if (e instanceof Error && e.message === TOO_DENSE) throw failW(`radius ${mm(r)} would make more than ${MAX_DENSE / 1e6} million points along the bends`, 'raise radius, or bake the parts separately');
      throw e;
    }
    if (made.now) ctx.stage('refine', performance.now() - t0);
    ctx.stat('dense_points', R.sc.cloud.n - R.kept);
    const t1 = performance.now();
    const CB = perCloudMemo(R.sc, `buried|${surId(sur)}`, () => {
      const c = R.sc.cloud, k = R.kept, B = new Uint8Array(c.n);
      // every dense point tests contact itself (a face pressed against another: sharp at any spacing)
      const PC = contactBuried(R.sc, mesh, b.tris, scene(), CONTACT_GAP, deadline);
      if (PC) for (let i = k; i < c.n; i++) B[i] = PC[i] << 1;
      if (!CB0) return PC ? B : null;
      for (let j = 0; j < k; j++) B[j] = CB0[R.of[j]];
      // and takes being inside another part from the nearest ordinary point of its part facing its way (within 1.25
      // spacings: the outline of a part sunk into another is as sharp as bake_measure's; the nearest of any facing
      // where none does), rays where there is none
      const near = 1.25 * s0, n2 = near * near, G = sc0.grid, c0 = sc0.cloud, ask: number[] = [];
      const ox = G.GH[0], oy = G.GH[1], oz = G.GH[2], h = G.GH[3], gx = G.GH[4], gy = G.GH[5], gz = G.GH[6];
      for (let i = k; i < c.n; i++) {
        const x = c.P[i * 3], y = c.P[i * 3 + 1], z = c.P[i * 3 + 2];
        const x0 = Math.max(0, Math.floor((x - near - ox) / h)), x1 = Math.min(gx - 1, Math.floor((x + near - ox) / h));
        const y0 = Math.max(0, Math.floor((y - near - oy) / h)), y1 = Math.min(gy - 1, Math.floor((y + near - oy) / h));
        const z0 = Math.max(0, Math.floor((z - near - oz) / h)), z1 = Math.min(gz - 1, Math.floor((z + near - oz) / h));
        const nx = c.N[i * 3], ny = c.N[i * 3 + 1], nz = c.N[i * 3 + 2];
        let bd = n2, bq = -1, ad = n2, aq = -1;
        for (let cz = z0; cz <= z1; cz++) for (let cy = y0; cy <= y1; cy++) {
          const row = (cz * gy + cy) * gx;
          for (let q = G.GS[row + x0], qe = G.GS[row + x1 + 1]; q < qe; q++) {
            const dx = G.GP[q * 3] - x, dy = G.GP[q * 3 + 1] - y, dz = G.GP[q * 3 + 2] - z, d2 = dx * dx + dy * dy + dz * dz, j = G.GI[q];
            if (d2 >= ad || c0.piece[j] !== c.piece[i]) continue;
            if (d2 < bd) { bd = d2; bq = j; }
            if (c0.N[j * 3] * nx + c0.N[j * 3 + 1] * ny + c0.N[j * 3 + 2] * nz > 0.7) { ad = d2; aq = j; }
          }
        }
        if (aq >= 0) B[i] |= CB0[aq] & 1;
        else if (bq >= 0) B[i] |= CB0[bq] & 1;
        else ask.push(i);
      }
      ctx.stat('dense_rays', ask.length);
      if (!ask.length) return B;
      const pick = (A: Float64Array | Float32Array | Int32Array, m: number) => { const o = new (A.constructor as any)(ask.length * m); ask.forEach((i, j) => { for (let q = 0; q < m; q++) o[j * m + q] = A[i * m + q]; }); return o; };
      const sub = { cloud: { n: ask.length, P: pick(c.P, 3), N: pick(c.N, 3), piece: pick(c.piece, 1) }, FN: pick(R.sc.FN, 3) } as unknown as SurfaceCloud;
      return seq(runBuried(run, sub, mesh, scene(), sur, deadline), (BF: Uint8Array | null) => {
        if (BF) ask.forEach((i, j) => { B[i] |= BF[j] & 1; });
        ctx.stage('buried', performance.now() - t1);
        return B;
      });
    }) as Uint8Array | null | Promise<Uint8Array | null>;
    return seq(CB, (B: Uint8Array | null) => ({ sc: R.sc, CB: B }));
  }
}

/** Hard facets bending this much (degrees) or more take chips when the radius is under twice their size. */
const FACET_CHIP = 24;

/**
 * The warning when the facets of curved parts would chip: where the shading is hard across them (facetSizes) and the
 * radius is under twice their size, a facet edge reads as an edge of its own bend (about 0.85 sin(bend); a 90° edge
 * reads 1), which chips at full amount from about FACET_CHIP. Once per bake: how many pieces, the three with the
 * sharpest facets.
 */
function facetWarning(b: Bake, mesh: SurfaceMesh, r: number) {
  const o = mesh.orient, f = facetSizes(b.g, b.tris, b.triPrim, o.piece, o.pieces, mesh.VN);
  const hit: number[] = [];
  for (let c = 0; c < o.pieces; c++) if (f.size[c] > 0 && r < 2 * f.size[c] && f.angle[c] >= FACET_CHIP) hit.push(c);
  if (!hit.length) return;
  hit.sort((x, y) => f.angle[y] - f.angle[x] || f.size[y] - f.size[x]);
  const na = b.g.prims.get('name'), names = new Map<number, string>();
  if (na && na.type === 'string') for (let pr = 0; pr < o.piece.length; pr++) { const c = o.piece[pr]; if (!names.has(c)) names.set(c, String(na.get(pr) ?? '')); }
  const label = (c: number) => (names.get(c) ? `part "${names.get(c)}"` : `piece ${c}`);
  const worst = hit.slice(0, 3).map((c) => `${label(c)} (facets ${mm(f.size[c])}, ${Math.round(f.angle[c])}°)`).join(', ');
  let need = 0;
  for (const c of hit) need = Math.max(need, Math.ceil(2 * f.size[c] * 1000) / 1000);
  b.ctx.warn(`${TW}: ${hit.length} faceted piece(s) will chip along their facets at radius ${mm(r)}: ${worst}${hit.length > 3 ? ` and ${hit.length - 3} more` : ''}; raise radius to ${mm(need)} or more, smooth their normals or give them more polygons`);
}

/** On any face, chips never cover this share of its area or more, however much it wears (amount, focus). */
export const WEAR_CAP = 1 / 3;
/** The most of a face's area that chips at an amount: WEAR_CAP from amount 0.8, less below (a third at 0.8, a sixth at 0.4). */
export const wearCap = (amount: number) => WEAR_CAP * Math.max(0, Math.min(1, amount / 0.8));
/**
 * The chipped share a face keeps for the share s its wear field would give, under the cap of its amount: up to half the
 * cap unchanged, above that bending smoothly toward the cap, never reaching it.
 */
export const cappedShare = (s: number, cap: number) => {
  const knee = cap / 2;
  return s <= knee ? s : knee + (cap - knee) * (1 - Math.exp(-(s - knee) / (cap - knee)));
};
/** Once a face's cap binds, amount from here to 1 brings bare and core up to the chip level, down to this much of their steps. */
const DEEPEN_FROM = 0.6, DEEPEN_TO = 0.25;

/**
 * Per face (wearRegions) the level its chips start at: the threshold t of the amount, or where the wear field passes t
 * on more than half the cap of the amount (wearCap) of the face's area, the field value above which the area is
 * cappedShare of it, so its most worn texels (the edges, the corners first) chip and its middle keeps paint; a larger
 * amount never raises it. With it, how far the cap binds (0 at half the cap, 1 at the cap), which brings bare and core
 * closer to the chip level as amount rises past DEEPEN_FROM: wear still grows on a face held at its cap. Area per sample
 * from its triangle's texel size.
 */
function faceLevels(b: Bake, mesh: SurfaceMesh, R: { triRegion: Int32Array; count: number }, Wu: Float32Array, t: number, amount: number, deadline = 0): { level: Float64Array; bind: Float64Array; capped: number } {
  const s = b.s, n = s.n, nr = R.count, tt = mesh.triTexel, reg = R.triRegion;
  const area = new Float64Array(nr), over = new Float64Array(nr);
  for (let i = 0; i < n; i++) {
    if (late(deadline, i)) throw new Error(PAST_DEADLINE);
    const tr = s.tri[i], c = reg[tr];
    if (c < 0) continue;
    const a = tt[tr * 2] * tt[tr * 2 + 1];
    area[c] += a;
    if (Wu[i] >= t) over[c] += a;
  }
  const level = new Float64Array(nr).fill(t), bind = new Float64Array(nr), cap = wearCap(amount);
  const lists: number[][] = [];
  let capped = 0;
  if (cap > 0) for (let c = 0; c < nr; c++) if (area[c] > 0 && over[c] > (cap / 2) * area[c]) { lists[c] = []; capped++; }
  if (capped) {
    for (let i = 0; i < n; i++) { const c = reg[s.tri[i]]; if (c >= 0 && lists[c] && Wu[i] >= t) lists[c].push(i); }
    for (let c = 0; c < nr; c++) {
      const L = lists[c];
      if (!L) continue;
      const sh = over[c] / area[c], keep = cappedShare(sh, cap) * area[c];
      bind[c] = Math.min(1, (sh - cap / 2) / (cap / 2));
      L.sort((x, y) => Wu[y] - Wu[x] || x - y);
      // the level where the area at or above it reaches the share kept
      let acc = 0, lv = Wu[L[0]];
      for (const i of L) { const tr = s.tri[i], a = tt[tr * 2] * tt[tr * 2 + 1]; if (acc + a > keep) break; acc += a; lv = Wu[i]; }
      level[c] = Math.max(t, lv);
    }
  }
  return { level, bind, capped };
}

function finishEdgeWear(ctx: CookContext, b: Bake, L: WearLayers, amount: number, t: number, bareStep: number, coreStep: number, radius: number, deadline: number) {
  const n = b.s.n;
  let t0 = performance.now();
  const chip = new Float32Array(n), bare = new Float32Array(n), core = new Float32Array(n), C = new Float32Array(n);
  let nc = 0, nb = 0, nk = 0;
  if (n) {
    const mesh = surfaceOf(b);
    const R = perCloudMemo(b.s, `regions|${radius}`, () => wearRegions(b.g, mesh, b.tris, b.skip, radius, deadline)) as ReturnType<typeof wearRegions>;
    const F = faceLevels(b, mesh, R, L.W, t, amount, deadline);
    ctx.stat('capped_faces', F.capped);
    ctx.stage('settle', performance.now() - t0);
    t0 = performance.now();
    const deepen = Math.max(0, Math.min(1, (amount - DEEPEN_FROM) / (1 - DEEPEN_FROM))) * (1 - DEEPEN_TO), reg = R.triRegion;
    for (let i = 0; i < n; i++) {
      if (late(deadline, i)) throw new Error(PAST_DEADLINE);
      const w = L.W[i], c = reg[b.s.tri[i]], lv = c >= 0 ? F.level[c] : t, q = c >= 0 ? 1 - deepen * F.bind[c] : 1;
      C[i] = w <= 0 ? 0 : w >= 1 ? 1 : w;
      // hands keep the metal bright: no core where the part is handled
      const x = (w - lv) / WEAR_EDGE, y = (w - lv - bareStep * q) / WEAR_EDGE, z = (w - lv - coreStep * q - L.handled[i]) / WEAR_EDGE;
      chip[i] = x <= 0 ? 0 : x >= 1 ? 1 : x;
      bare[i] = y <= 0 ? 0 : y >= 1 ? 1 : y;
      core[i] = z <= 0 ? 0 : z >= 1 ? 1 : z;
      if (chip[i] >= 0.5) nc++;
      if (bare[i] >= 0.5) nb++;
      if (core[i] >= 0.5) nk++;
    }
  }
  ctx.stat('chip_share', n ? nc / n : 0);
  ctx.stat('bare_share', n ? nb / n : 0);
  ctx.stat('core_share', n ? nk / n : 0);
  const one = (vals: Float32Array) => ({ vals, ch: 1, background: [0] });
  const layers: Record<string, { vals: Float32Array; ch: number; background: number[] }> = {
    chip: one(chip), bare: one(bare), core: one(core), convex: one(L.convex), concave: one(L.concave), handled: one(L.handled),
  };
  if (n) {
    // the same for every cook of this raster (finishImage copies them)
    const { texel, island } = perCloudMemo(b.s, 'texelLayers', () => texelLayers(b, surfaceOf(b).VP)) as ReturnType<typeof texelLayers>;
    layers.texel = texel; layers.island = island;
  } else {
    layers.texel = { vals: new Float32Array(0), ch: 4, background: [0, 0, 0, 1] };
    layers.island = { vals: new Float32Array(0), ch: 1, background: [-1] };
  }
  ctx.stage('masks', performance.now() - t0);
  t0 = performance.now();
  const { img } = finishImage(b, C, 1, [0], layers);
  ctx.stage('image', performance.now() - t0);
  return wrapImage(b, img);
}

defineNode({
  type: TW,
  category: 'texture',
  usesNodeName: NAMED_BY_NODE,
  summary: 'Paint wear on edges into uv space: edges measured on the shape at a radius, broken up in 3D into worn stretches and ragged chips, with nested chip, bare and core layers and more wear on the edges near handled parts.',
  description:
    BAKE_DOC + 'C is the wear field 0..1 (continuous), as the shape gives it: amount and the cap below never change it, ' +
    'so a mask can read it as a stable field. The layers chip (the top coat is gone: 1 where C passes the threshold set by ' +
    'amount), bare (down to the substrate, bare_step deeper into the field) and core (the deepest part of each chip, ' +
    'core_step deeper: where rust starts) lie inside one another texel for texel (the primer ring is chip − bare); ' +
    'convex and concave (curvature at radius, 0..1: 1 = a 90° edge or crease; with method surface gentle bends, under ' +
    'about 0.2, may read 0), handled (the focus field, 1 on the focus prims fading to 0 at focus_radius), texel, ' +
    'island and mask. A larger amount only adds wear. Edges come from method surface (how the shading normals turn ' +
    'within radius, on a cloud of surface points as bake_measure curvature, made denser along the bends the mesh itself ' +
    'shows, so the result does not depend on the uv layout or the texel density: smooth-shaded facets read as the round ' +
    'they stand for, hard edges count, a junction between parts reads concave and gets no chips) or dihedral (the ' +
    "mesh's edge angles within max(radius, reach), as bake_curvature; there reach only widens that radius, with no " +
    'falloff, and the focus does not extend it). With method surface wear reaches reach in from an edge inside its ' +
    'part, never past halfway to the edge across from it, fading out smoothly; large 3D patches (patch_size, ' +
    'patchiness) decide which stretches of edge wear, and a 3D noise at chip_size, its outline warped by raggedness, ' +
    'breaks them into chips, so the outlines follow the shape in 3D, never the triangles, and are the same on both ' +
    'sides of a uv seam and wherever the part is placed. No face wears through: on every face (the surface between hard ' +
    'edges or bends of 20° or more; a bevel or round belongs to the face it leads to; a piece with no face at all, a bar ' +
    'a few radii across, counts as one) chips cover at most a third of its area from amount 0.8 (a sixth at 0.4; held ' +
    'at the sample points, so counted in texels a face can read a few hundredths more, up to about 0.36), ' +
    'its most worn texels: corners first, then the edges, so a small feature (a boss, a nut, a bar) keeps paint on its ' +
    'faces while a large body is never held back. Where that cap holds, more amount still wears deeper: bare and core ' +
    'grow toward the chip outline inside the same share. C is the raw wear field and is never capped (a small part ' +
    'can read about 0.96 all over it), so a preset or layer stack takes the cap from chip, bare and core. ' +
    'Faces pressed flush against another face (lying on each other within 0.1 mm, facing opposite ways: stacked boxes, a ' +
    'part on a plate; never the front and back of a sheet) are buried and take no wear, so the seam between them is no edge. focus multiplies the edge wear near the ' +
    'focus prims (focus_amount, within focus_radius), makes the chip outlines there more ragged, lets wear reach up to ' +
    '(1 + 1.5 × focus_amount) × reach in from the edges there, and adds only a light rub (0.12 × focus_amount in C) ' +
    'to flats, which never chip. Input 1 (surroundings) buries the points inside it, as in bake_measure, and lets the ' +
    'two bakes share their work. Warns once when hard-shaded facets of curved parts would chip (bending 24° or more, at ' +
    'a radius under twice their size), naming the worst three. Refuses a radius that would place more than 6 million ' +
    'points along the bends. Stats chip_share, bare_share, core_share (covered samples at 0.5 or more), capped_faces ' +
    '(faces held under the cap), dense_points. Stops at the time limit of long-running nodes, counted from the end of the ' +
    'setup every bake shares (sampling the atlas, which always finishes: at 2048 a few hundred ms); a cook that changes only ' +
    'amount reuses the wear field.',
  aliases: ['edge_wear', 'edge_wear_bake', 'bake_wear', 'bake_chips'],
  inputs: [
    { name: 'geo', desc: 'mesh to bake (needs uv without overlaps: uv_unwrap or uv_layout)' },
    { name: 'surroundings', desc: 'optional: geometry around the mesh (a wall, the ground); points inside it are buried and do not wear', optional: true },
  ],
  params: {
    ...BAKE_PARAMS(),
    amount: { type: 'float', default: 0.5, min: 0, max: 1, desc: 'how much of the edge length wears (moves the chip threshold: 0 none, 1 every edge out to reach; at most about a third of any face chips)', aliases: ['wear', 'strength'] },
    radius: { type: 'float', default: 0.004, min: 0, desc: 'the scale edges are measured at (metres): 4 mm catches 1 to 3 mm bevels on sheet metal; cast parts want 6 to 8 mm', aliases: ['edge_radius'] },
    method: { type: 'enum', options: ['surface', 'dihedral'], default: 'surface', desc: 'surface: from the shading normals over radius (smooth-shaded facets do not count; decimated, isosurface and clean meshes); dihedral: the mesh\'s edge angles, as bake_curvature', aliases: ['mode', 'curvature_method'] },
    reach: { type: 'float', default: 0.008, min: 0, desc: 'how far wear reaches in from an edge at amount 1 (metres; with method dihedral it only widens the radius the edge angles are read over)', aliases: ['wear_reach'] },
    chip_size: { type: 'float', default: 0.006, min: 0, desc: 'size of the chips that break the wear up (metres)', aliases: ['chip_scale', 'breakup_size'] },
    raggedness: { type: 'float', default: 0.5, min: 0, max: 1, desc: 'how ragged the chip outlines are (domain warp)', aliases: ['ragged', 'warp'] },
    patchiness: { type: 'float', default: 0.5, min: 0, max: 1, desc: 'how strongly large patches decide which stretches of edge wear (0: every edge alike)', aliases: ['patches'] },
    patch_size: { type: 'float', default: 0.15, min: 0, desc: 'size of those patches (metres)', aliases: ['patch_scale'] },
    bare_step: { type: 'float', default: 0.12, min: 0, max: 1, desc: 'how much deeper into the wear field bare starts (a thin primer ring around it)' },
    core_step: { type: 'float', default: 0.3, min: 0, max: 1, desc: 'how much deeper core starts (at least bare_step: small cores inside the bare metal)' },
    focus: P.group('prim', 'prims touched by hands or tools ("@name=latch"): edges near them wear more'),
    focus_radius: { type: 'float', default: 0.1, min: 0, desc: 'reach of the focus (metres; 0 = the focus prims only)' },
    focus_amount: { type: 'float', default: 0.5, min: 0, max: 1, desc: 'extra wear near the focus: edges there wear up to 1 + focus_amount times as much' },
    seed: { ...P.seed(), desc: 'changes the patches and chips, not the amount' },
  },
  outputs: 'image <name> (default: the node name): C = wear field, chip, bare, core, convex, concave, handled, texel, island, mask',
  example: {
    nodes: {
      box: { type: 'box', params: { size: [0.4, 0.3, 0.3] } },
      bevel: { type: 'poly_bevel', in: ['box'], params: { offset: 0.004 } },
      uv: { type: 'uv_unwrap', in: ['bevel'] },
      wear: { type: 'bake_edge_wear', in: ['uv'], params: { resolution: 256, amount: 0.6 } },
    },
    output: 'wear',
  },
  cook: cookEdgeWear,
} as NodeDef);
