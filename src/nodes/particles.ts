// Simulation-lite: the `particles` node (Houdini POP network in one node). The simulation itself (emission, the
// per-particle integration kernel, state, output) lives in src/core/particles.ts; this file resolves params and inputs,
// runs the steps (one kernel run per run of steps, on the worker pool when it is worth it) and caches per-frame states
// the way the solver does.
import { Geometry } from '../core/geometry.ts';
import { RayScene, bboxDiagonal } from '../core/analysis.ts';
import { KDTree } from '../core/spatial.ts';
import { heightfieldToMesh, heightfieldsOf } from '../core/heightfield.ts';
import { pointNormals } from '../core/topology.ts';
import { hashString } from '../core/random.ts';
import {
  COLLIDE_MODES, MAX_STEPS, compactState, emitSteps, fieldFrom, particlePoints, particleTrails, stateSkipped, stateSkippedBirths,
  stateStep,
} from '../core/particles.ts';
import type { ColliderData, EmitParams, EmitterData, FieldData, StepArgs } from '../core/particles.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import type { CookContext } from '../graph/types.ts';
import { stableStringify } from '../graph/engine.ts';
import { evalSdf } from './sdf.ts';

/** Particle-steps below which a run stays on the cooking thread. */
const POOL_WORK = 200_000;

// Inputs are cooked, immutable geometry: what the simulation derives from them is kept per geometry object.
const emitterMemo = new WeakMap<Geometry, EmitterData>();
const colliderMemo = new WeakMap<Geometry, ColliderData>();
const fieldMemo = new WeakMap<Geometry, Map<number, FieldData>>();

function emitterOf(g: Geometry): EmitterData {
  let e = emitterMemo.get(g);
  if (e) return e;
  const n = g.numPoints;
  const pn = g.points.get('N'), vn = g.vertices.get('N');
  let N: Float64Array | null = null;
  if (pn && pn.type === 'float' && pn.size === 3) N = (pn.data as Float64Array).slice();
  else if (vn && vn.type === 'float' && vn.size === 3) {
    N = new Float64Array(n * 3);
    for (let v = 0; v < g.numVertices; v++) for (let c = 0; c < 3; c++) N[g.vertexPoint[v] * 3 + c] += (vn.data as Float64Array)[v * 3 + c];
  } else if (g.numPrims) N = pointNormals(g).slice();
  if (N)
    for (let i = 0; i < n; i++) {
      const l = Math.hypot(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]);
      if (l > 0) { N[i * 3] /= l; N[i * 3 + 1] /= l; N[i * 3 + 2] /= l; } else { N[i * 3] = 0; N[i * 3 + 1] = 1; N[i * 3 + 2] = 0; }
    }
  const v = g.points.get('v'), ps = g.points.get('pscale'), id = g.points.get('id');
  e = {
    geo: g, count: n, P: g.P, N,
    V: v && v.type === 'float' && v.size === 3 ? (v.data as Float64Array) : null,
    pscale: ps && ps.type === 'float' && ps.size === 1 ? (ps.data as Float64Array) : null,
    key: id && id.type !== 'string' && !id.isArray && id.size === 1 ? (id.data as Int32Array | Float64Array) : null,
  };
  emitterMemo.set(g, e);
  return e;
}

/** Collision surface: the polygons of the input plus its heightfields as meshes. */
function colliderOf(g: Geometry): ColliderData {
  let c = colliderMemo.get(g);
  if (c) return c;
  const parts: Geometry[] = [];
  let polys = false;
  for (let p = 0; p < g.numPrims && !polys; p++) if (g.primClosed[p] && g.primSize(p) >= 3) polys = true;
  if (polys) parts.push(g);
  for (const hf of heightfieldsOf(g)) if (hf.layers.has('height')) parts.push(heightfieldToMesh(hf));
  if (!parts.length) c = { scene: null, skin: 0 };
  else {
    const mesh = parts.length > 1 ? Geometry.merge(parts) : parts[0];
    const scene = RayScene.of(mesh);
    c = { scene: scene.empty ? null : scene, skin: Math.max(1e-7, 1e-5 * (bboxDiagonal(mesh) || 1)) };
  }
  colliderMemo.set(g, c);
  return c;
}

function fieldOf(ctx: CookContext, g: Geometry, res: number): FieldData {
  let m = fieldMemo.get(g);
  if (!m) fieldMemo.set(g, (m = new Map()));
  let f = m.get(res);
  if (f) return f;
  const opts = { sdfResolution: res, heightfields: heightfieldsOf(g) };
  // a field that runs user code (sdf_expr upstream) is sampled under the script timeout, like sdf_to_mesh does
  const vol = g.volumes.find((v) => v.kind === 'sdf' || v.kind === 'grid');
  f = vol && vol.kind === 'sdf' && vol.scripted ? evalSdf(ctx, vol, (sample) => fieldFrom(g, { ...opts, sdfSample: sample })) : fieldFrom(g, opts);
  if (f.type === 1) {
    const kd = new KDTree(g.P).arrays();
    f.shared = { ...f.shared, fTP: kd.TP, fIdx: kd.idx, fAxis: kd.axis };
  }
  m.set(res, f);
  return f;
}

interface Prepared { emitter: EmitterData; collider: ColliderData | null; field: FieldData | null }

function prepare(ctx: CookContext, geos: (Geometry | null)[], p: Record<string, any>): Prepared {
  const [e, c, f] = geos;
  const collide = p.collide !== 'none' || p.attract_to === 'surface';
  return {
    emitter: emitterOf(e ?? new Geometry()),
    collider: c && collide && (c.numPrims || c.volumes.length) ? colliderOf(c) : null,
    field: f && (f.numPoints || f.volumes.length) ? fieldOf(ctx, f, p.field_resolution) : null,
  };
}

const vec = (v: any, d: number[]): number[] => (Array.isArray(v) ? [0, 1, 2].map((k) => Number(v[k] ?? d[k])) : d);

defineNode({
  type: 'particles',
  category: 'sim',
  summary: 'Particle simulation (Houdini POPs in one node): emit from points, gravity, drag, wind, curl noise, velocity fields, attraction, floor and mesh collisions (die/slide/bounce), trails as polylines. Deterministic, steps with the frame.',
  description:
    'Steps of dt = 1 / (fps × substeps). Each step, every emitter point (input 0: points, or the points of any geometry) gives birth to emit_rate ' +
    'particles (fractions accumulate with a random phase per point; emit_all also emits one particle per point at time 0). A particle starts at its ' +
    'emitter point with the point\'s v, plus speed along the point\'s N (+Y without N), plus a random velocity up to velocity_var, and carries the point\'s ' +
    'attributes and groups (Cd, pscale, …; a point id seeds its randomness, so reordering points keeps each one\'s stream). ' +
    'Each step: acceleration = gravity + noise (curl: divergence-free) + field force + attraction; drag pulls the velocity toward the air ' +
    'velocity (wind + air fields) at rate drag; then the particle moves and collides with the floor plane and with the polygons (and heightfields) of ' +
    'input 1: die removes it, slide keeps the tangential motion, bounce reflects it with restitution bounce; friction is Coulomb (μ). Points collide ' +
    'as points unless use_pscale (spheres of radius pscale). Input 2 is a field: points with v (nearest or inverse-distance weighted), a heightfield ' +
    '(force = -gradient of height × field_scale: downhill) or an SDF (force = -gradient of the distance: toward the surface; sampled on a grid). ' +
    'Particles die when age reaches life (0 = never) or on a die collision; the output has the live ones: P, v, age, life, id (birth order), pscale ' +
    'and the carried attributes; trails > 1 keeps the last positions as one polyline per particle (point age at that position, curveu 0..1 tail to head, prim id). ' +
    'Time: a cook at start_frame (or any cook with animate false) runs `steps` steps; with animate, frame f runs steps + (f - start_frame) × substeps, ' +
    'reading the inputs at each frame, and every frame\'s state is cached like the solver\'s (stepping 10 → 11 runs one frame; jumping back re-simulates ' +
    'from the latest cached frame before it, or from the start). The result is the same bit for bit however the steps are split into frames and with or ' +
    'without the worker pool. max_particles counts a particle from birth to the end of its life, also when a collision removed it earlier.',
  aliases: ['pop', 'pop_network', 'popnet', 'particle', 'particle_system'],
  inputs: [
    { name: 'emitter', desc: 'points that emit (any geometry: its points); point v, N, pscale, Cd, id and other attributes are used and carried' },
    { name: 'collision', desc: 'polygons (and heightfields) to collide with; also the surface for attract_to surface', optional: true },
    { name: 'field', desc: 'velocity field: points with v, a heightfield (downhill gradient) or an SDF volume (gradient toward the surface)', optional: true },
  ],
  params: {
    steps: { type: 'int', default: 48, min: 0, max: 100000, desc: 'steps simulated at start_frame (a plain cook); with animate, later frames add substeps steps each' },
    fps: { type: 'float', default: 24, min: 0.001, desc: 'simulation frames per second; dt = 1 / (fps × substeps)' },
    substeps: { type: 'int', default: 1, min: 1, max: 100, desc: 'steps per frame' },
    animate: { type: 'bool', default: true, desc: 'advance with the cook frame (frame f > start_frame runs (f - start_frame) × substeps more steps, cached per frame); false = always `steps` steps, not time-dependent' },
    start_frame: { type: 'int', default: 1, desc: 'frame that shows the state after `steps` steps (earlier frames show it too)' },
    emit_rate: { type: 'float', default: 1, min: 0, desc: 'particles born per step per emitter point (0.25 = one every 4 steps)', aliases: ['rate', 'birth_rate'] },
    emit_all: { type: 'bool', default: false, desc: 'also emit one particle from every emitter point at time 0 (with emit_rate 0: a single burst)' },
    speed: { type: 'float', default: 0, desc: 'initial speed (m/s) along the emitter point normal N (+Y without N), added to the point v' },
    velocity_var: { type: 'float', default: 0, min: 0, desc: 'random initial velocity, uniform in a ball of this radius (m/s)', aliases: ['spread', 'velocity_variance'] },
    life: { type: 'float', default: 0, min: 0, desc: 'lifetime in seconds (0 = forever)', aliases: ['lifetime', 'life_expectancy'] },
    life_var: { type: 'float', default: 0, min: 0, desc: 'random ± variation of the lifetime (s)', aliases: ['life_variance'] },
    pscale: { type: 'float', default: 0.05, min: 0, desc: 'pscale of particles whose emitter point has none' },
    gravity: { type: 'vec3', default: [0, -9.81, 0], desc: 'acceleration (m/s²)' },
    drag: { type: 'float', default: 0, min: 0, desc: 'air resistance (1/s): the velocity approaches the air velocity (wind, air fields) at this rate; wind needs drag > 0', aliases: ['air_resistance'] },
    wind: { type: 'vec3', default: [0, 0, 0], desc: 'air velocity (m/s); acts through drag' },
    noise: { type: 'float', default: 0, desc: 'noise force amplitude (m/s²); 0 = off', aliases: ['noise_amplitude', 'turbulence'] },
    noise_size: { type: 'float', default: 1, min: 0.001, desc: 'noise element size (m)', aliases: ['element_size'] },
    curl: { type: 'bool', default: true, desc: 'curl noise (divergence-free swirls, no sinks) instead of three independent noises' },
    noise_octaves: { type: 'int', default: 2, min: 1, max: 8, desc: 'fractal octaves of the noise (each costs one more evaluation)' },
    attract: { type: 'float', default: 0, desc: 'attraction strength (1/s²: acceleration per metre of distance to the target); negative repels' },
    attract_to: { type: 'enum', options: ['point', 'surface'], default: 'point', desc: 'target: attract_point, or the closest point of the collision surface (input 1)' },
    attract_point: { type: 'vec3', default: [0, 0, 0], desc: 'target of attract_to point' },
    collide: { type: 'enum', options: COLLIDE_MODES, default: 'bounce', desc: 'response to the floor and the collision input: none, die (removed), slide (normal velocity removed), bounce' },
    bounce: { type: 'float', default: 0.5, min: 0, max: 1, desc: 'restitution of bounce (0 = no rebound, 1 = elastic)', aliases: ['elasticity', 'restitution'] },
    friction: { type: 'float', default: 0.2, min: 0, desc: 'Coulomb friction coefficient on contact (tangential speed lost = friction × normal speed lost)' },
    floor: { type: 'bool', default: false, desc: 'collide with the plane y = floor_height', aliases: ['ground_plane'] },
    floor_height: { type: 'float', default: 0, desc: 'height of the floor plane' },
    use_pscale: { type: 'bool', default: false, desc: 'collide as spheres of radius pscale (rest on surfaces) instead of as points' },
    field_mode: { type: 'enum', options: ['force', 'air'], default: 'force', desc: 'how the field (input 2) acts: force = added to the acceleration (× field_scale); air = added to the air velocity (acts through drag, like wind)' },
    field_scale: { type: 'float', default: 1, desc: 'multiplier of the field vector' },
    field_sample: { type: 'enum', options: ['nearest', 'idw'], default: 'nearest', desc: 'points field: the nearest point\'s v, or inverse-distance weighted v of field_neighbours points' },
    field_neighbours: { type: 'int', default: 6, min: 2, max: 32, desc: 'points field, idw: points averaged', aliases: ['field_neighbors'] },
    field_max_distance: { type: 'float', default: 0, min: 0, desc: 'points field: ignore points farther than this (0 = unlimited)' },
    field_resolution: { type: 'int', default: 64, min: 4, max: 256, desc: 'SDF field: samples along the longest side of the grid the distance is sampled on', advanced: true },
    seed: { type: 'float', default: 0, desc: 'random seed (emission phases, birth offsets, lifetimes, velocities, noise)' },
    max_particles: { type: 'int', default: 1000000, min: 0, desc: 'births are refused while this many particles hold a slot (from birth to the end of their life)' },
    max_births: { type: 'int', default: 1000000, min: 1, max: 10000000, desc: 'guard: most particles born in one step (the rest of the step\'s births are refused, with a warning). Steps are also simulated in batches of about this many births, so memory stays bounded however many particles are born and die over a run (the result does not depend on it otherwise)' },
    trails: { type: 'int', default: 0, min: 0, max: 10000, desc: 'positions kept per particle and output as a polyline (0 = no trails; 2 or more)', aliases: ['trail_length'] },
    output: { type: 'enum', options: ['both', 'points', 'trails'], default: 'both', desc: 'points (the particles), trails (one polyline per particle) or both (points first; no trails when trails < 2)' },
  },
  outputs: 'points: P, v, age, life, id, pscale + emitter attributes and groups; trails: polylines with point age, curveu and the particle attributes, prim id',
  example: {
    nodes: {
      ground: { type: 'grid', params: { size: [6, 6], divisions: [12, 12] } },
      nozzle: { type: 'points', params: { positions: [[0, 0.2, 0]] } },
      fountain: {
        type: 'particles', in: ['nozzle', 'ground'],
        params: { steps: 60, emit_rate: 4, speed: 5, velocity_var: 1.2, life: 2.5, seed: 1, collide: 'bounce', bounce: 0.4, trails: 6 },
      },
      tint: { type: 'color', in: ['fountain'], params: { mode: 'ramp', attrib: 'age', range: [0, 2.5] } },
      out: { type: 'merge', in: ['ground', 'tint'] },
    },
    output: 'out',
  },
  async cook(ctx) {
    const { p, warn } = ctx;
    const T = p.trails >= 2 ? Math.floor(p.trails) : 0;
    if (p.output === 'trails' && !T) throw new NodeError('output "trails" needs trails >= 2 (positions kept per particle)', '"trails": 16');
    const dt = 1 / (p.fps * p.substeps);
    const ep: EmitParams = {
      dt, seed: p.seed, rate: p.emit_rate, emitAll: !!p.emit_all, life: p.life, lifeVar: p.life_var, speed: p.speed,
      velocityVar: p.velocity_var, pscale: p.pscale, maxParticles: Math.max(0, Math.floor(p.max_particles)),
      maxBirths: Math.max(1, Math.floor(p.max_births)), trail: T,
    };
    const g3 = vec(p.gravity, [0, -9.81, 0]);
    const collideIdx = Math.max(0, COLLIDE_MODES.indexOf(p.collide));
    const base: Omit<StepArgs, 's0' | 's1' | 'mesh' | 'skin' | 'field'> = {
      dt, trail: T, gravity: g3, drag: p.drag, wind: vec(p.wind, [0, 0, 0]),
      noise: p.noise, noiseSize: p.noise_size, curl: !!p.curl, octaves: p.noise_octaves, seed: p.seed,
      attract: p.attract, attractMode: !p.attract ? 0 : p.attract_to === 'surface' ? 2 : 1, attractPoint: vec(p.attract_point, [0, 0, 0]),
      collide: collideIdx, bounce: p.bounce, friction: p.friction, floor: !!p.floor && collideIdx > 0, floorY: p.floor_height,
      restSpeed: Math.max(1e-6, 1.5 * Math.hypot(g3[0], g3[1], g3[2]) * dt),
      fieldAir: p.field_mode === 'air', fieldScale: p.field_scale,
      fieldK: p.field_sample === 'idw' ? Math.max(2, Math.floor(p.field_neighbours)) : 1, fieldMaxD: p.field_max_distance,
    };
    if (p.drag <= 0 && (base.wind.some((w) => w !== 0))) warn('wind has no effect without drag (set drag > 0: the rate at which particles take the wind speed)');
    if (p.drag <= 0 && base.fieldAir && ctx.hasInput(2)) warn('field_mode "air" acts through drag, which is 0: the field has no effect (set drag > 0 or field_mode "force")');

    let contacts = 0, simulated = 0, batches = 0;
    /**
     * Run steps [s0, s1) after `state` (null = the start) with the inputs `prep`: in batches that end where the births
     * reach max_births (emitSteps), so a run never holds more births at once; same result as one batch.
     */
    const advance = async (state: Geometry | null, s0: number, s1: number, prep: Prepared): Promise<Geometry> => {
      for (;;) {
        const { geo: st, end } = emitSteps(state, prep.emitter, s0, s1, ep);
        batches++;
        state = await integrate(st, s0, end, prep);
        if (end >= s1) return state;
        s0 = end;
      }
    };
    /** Integrate the particles of `st` (births included) through steps [s0, s1). */
    const integrate = async (st: Geometry, s0: number, s1: number, prep: Prepared): Promise<Geometry> => {
      const n = st.numPoints;
      if (s1 <= s0 || !n) return compactState(st, null, s1);
      const coll = prep.collider, fld = prep.field;
      const meshArrays = coll?.scene ? coll.scene.toArrays() : null;
      const args: StepArgs = {
        ...base, ...(fld?.args ?? {}), s0, s1,
        mesh: !!meshArrays && collideIdx > 0, skin: coll?.skin ?? 0, field: fld?.type ?? 0,
        attractMode: base.attractMode === 2 && !meshArrays ? 0 : base.attractMode,
      };
      const pts = st.points;
      const dead = new Uint8Array(n);
      const TR = T ? (pts.get('__ptrail')!.data as Float64Array) : undefined;
      const run = await ctx.parallelMap('particles', {
        count: n, args,
        inputs: {
          b: pts.get('__pb')!.data as Int32Array, u: pts.get('__pu')!.data as Float64Array, kd: pts.get('__pkd')!.data as Int32Array,
          rad: p.use_pscale ? (pts.get('pscale')!.data as Float64Array) : null,
        },
        outputs: { P: st.P, V: pts.get('v')!.data as Float64Array, CN: pts.get('__pcn')!.data as Float64Array, ...(TR ? { TR } : {}) },
        results: { dead },
        shared: { ...(meshArrays ?? {}), ...(fld?.type ? fld.shared : {}) },
      }, { minElements: Math.max(2, Math.ceil(POOL_WORK / (s1 - s0))) });
      for (const c of run.values) contacts += Number(c) || 0;
      simulated += s1 - s0;
      return compactState(st, dead, s1);
    };

    // the inputs as cooked now (at the cook frame): the run without animate, and the notes either way
    const now = prepare(ctx, [ctx.input(0), ctx.inputs[1], ctx.inputs[2]], p);
    let state: Geometry;
    let S: number;
    if (!p.animate) {
      S = p.steps;
      state = await advance(null, 0, S, now);
      ctx.stat('resumed_from', 0);
    } else {
      ({ state, S } = await animated(ctx, p, advance));
    }
    if (now.collider && !now.collider.scene) warn('the collision input has no polygons or heightfields: nothing to collide with');
    if (p.attract && p.attract_to === 'surface' && !now.collider?.scene) warn('attract_to surface needs polygons in the collision input (input 1)');
    if (now.field && !now.field.type) warn('the field input has no v attribute and no heightfield or SDF volume: ignored');
    const skipped = stateSkipped(state);
    if (skipped) warn(`max_particles (${p.max_particles}) reached: ${skipped} births were refused`);
    const skippedBirths = stateSkippedBirths(state);
    if (skippedBirths) warn(`max_births (${p.max_births}) reached: ${skippedBirths} births were refused (more particles were due in one step than max_births allows; raise it, or lower emit_rate)`);
    ctx.stat('steps', simulated);
    ctx.stat('batches', batches);
    ctx.stat('particles', state.numPoints);
    ctx.stat('contacts', contacts);
    const pts = p.output !== 'trails' ? particlePoints(state, S, dt) : null;
    const trails = T && p.output !== 'points' ? particleTrails(state, S, dt, T) : null;
    if (pts && trails) return Geometry.merge([pts, trails]);
    return (pts ?? trails)!;
  },
});

type Advance = (state: Geometry | null, s0: number, s1: number, prep: Prepared) => Promise<Geometry>;

/**
 * The animated cook (the solver idiom): the state after frame f is cached under S(f), chained from
 * S(start_frame) = hash(params, inputs at start_frame) by S(f) = hash(S(f-1), f, inputs at f). The latest cached frame
 * at or before the cooked one is resumed; static inputs run the remaining steps in one go (only the final state is
 * cached), time-dependent inputs one frame at a time with each frame's inputs (every frame cached).
 */
async function animated(ctx: CookContext, p: Record<string, any>, advance: Advance): Promise<{ state: Geometry; S: number }> {
  const start: number = p.start_frame;
  const frame = Math.max(start, Math.floor(ctx.frame + 1e-9));
  const stepsAt = (f: number) => p.steps + (f - start) * p.substeps;
  if (stepsAt(frame) > MAX_STEPS)
    throw new NodeError(`particles: frame ${frame} needs ${stepsAt(frame)} steps, more than ${MAX_STEPS}`, 'lower steps or substeps, or move start_frame');
  const inputsAt = (f: number) => Promise.all([0, 1, 2].map((i) => ctx.inputAt(i, f)));
  const chain: string[] = [];
  const ins: Awaited<ReturnType<typeof inputsAt>>[] = [];
  let timeDep = false, sig = '';
  for (let f = start; f <= frame; f++) {
    const r = await inputsAt(f);
    const sigs = r.map((x) => x.sig).join('|');
    sig = f === start ? String(hashString('particles|' + stableStringify(p) + '|' + sigs)) : String(hashString(sig + '|' + f + '|' + sigs));
    chain.push(sig);
    ins.push(r);
    timeDep ||= r.some((x) => x.timeDependent);
  }
  const cache = ctx.engine.cache;
  let k = chain.length - 1;
  let state: Geometry | undefined;
  for (; k >= 0; k--) {
    state = cache.get('particles:' + chain[k]);
    if (state) break;
  }
  ctx.stat('resumed_from', k >= 0 ? stateStep(state!) : 0);
  const geos = (j: number) => ins[j].map((r, i) => (i === 0 || ctx.hasInput(i) ? r.geo : null));
  const last = chain.length - 1;
  if (k < last) {
    if (!timeDep) {
      // static inputs: the remaining steps in one run
      state = await advance(k >= 0 ? state! : null, k >= 0 ? stepsAt(start + k) : 0, stepsAt(frame), prepare(ctx, geos(last), p));
      cache.set('particles:' + chain[last], state);
    } else {
      for (let j = k + 1; j <= last; j++) {
        state = await advance(j === 0 ? null : state!, j === 0 ? 0 : stepsAt(start + j - 1), stepsAt(start + j), prepare(ctx, geos(j), p));
        cache.set('particles:' + chain[j], state);
      }
    }
  }
  return { state: state!, S: stepsAt(frame) };
}
