// Behavioural tests for the particles node (src/nodes/particles.ts, src/core/particles.ts): emission counts and
// lifetimes, attribute carry, determinism, pool parity (bit-identical), floor and mesh collisions, trails (lengths,
// curveu, ages), the max_particles guard, time stepping (frames = one long run, resume, jump back, time-dependent
// inputs), fields (points, heightfield, SDF), forces (wind, attraction, curl noise), and the speed target.
//   node test/particles.ts
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import type { CookReport } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { Geometry } from '../src/core/geometry.ts';
import { KDTree, TriBVH } from '../src/core/spatial.ts';
import { getNodeDef } from '../src/graph/registry.ts';
import type { GraphSpec, NodeSpec } from '../src/graph/types.ts';
import { NEVER, ageAt, deathStep, knnInto, noiseForce, perlinGrad, perlinPerm } from '../src/core/particles.ts';
import { rng } from '../src/core/random.ts';
import { fingerprint } from './fingerprint.ts';

let fail = 0, pass = 0;
const check = (ok: any, msg: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
  if (ok) pass++; else fail++;
};
const section = (s: string) => console.log(`\n== ${s}`);

const off = new Engine(createNodeHost({ workers: 0 }));
await off.init();
const forced = new Engine(createNodeHost({ workers: 4, pool: { minElements: 1 } })); // every kernel run on the pool
await forced.init();

const DT = 1 / 24;
const attr = (g: Geometry, name: string, cls: 'point' | 'prim' = 'point') => g.table(cls).get(name)?.data as Float64Array | Int32Array | undefined;
async function cook(graph: GraphSpec, engine = off, frame?: number): Promise<CookReport> {
  const r = await engine.cook(structuredClone(graph), { frame });
  if (!r.ok) console.log('   cook errors:', JSON.stringify(r.errors));
  return r;
}
/** a graph: an emitter (node "src") and the particles node "sim" with params, optional collision/field nodes */
function sim(src: NodeSpec, params: Record<string, any>, extra: Record<string, NodeSpec> = {}, ins: string[] = []): GraphSpec {
  return { nodes: { src, ...extra, sim: { type: 'particles', in: ['src', ...ins], params } }, output: 'sim' };
}
const grid5 = (y = 1): NodeSpec => ({ type: 'point_grid', params: { counts: [5, 1, 1], size: [4, 0, 0], center: [0, y, 0] } });
const NOG = { gravity: [0, 0, 0] };

/** exact equality of topology, every attribute array and group */
function sameBits(a: Geometry, b: Geometry): string | null {
  const eq = (x: ArrayLike<any>, y: ArrayLike<any>) => {
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (!Object.is(x[i], y[i])) return false;
    return true;
  };
  if (!eq(a.primStart, b.primStart) || !eq(a.vertexPoint, b.vertexPoint) || !eq(a.primClosed, b.primClosed)) return 'topology';
  for (const cls of ['point', 'vertex', 'prim', 'detail'] as const) {
    const ta = a.table(cls), tb = b.table(cls);
    if (ta.names().join() !== tb.names().join()) return `${cls} attribute names ${ta.names()} vs ${tb.names()}`;
    for (const n of ta.names()) if (!eq(ta.get(n)!.data, tb.get(n)!.data)) return `${cls} attribute ${n}`;
  }
  for (const cls of ['point', 'prim'] as const) {
    const ga = a.groups(cls), gb = b.groups(cls);
    if ([...ga.keys()].join() !== [...gb.keys()].join()) return `${cls} groups`;
    for (const [k, m] of ga) if (!eq(m, gb.get(k)!)) return `${cls} group ${k}`;
  }
  return null;
}
const minY = (P: ArrayLike<number>) => { let m = Infinity; for (let i = 1; i < P.length; i += 3) m = Math.min(m, P[i]); return m; };
/** the particle points (no prims) and the trail points of an output "both" */
function split(g: Geometry): { pts: number[]; trailPts: number[] } {
  const used = new Uint8Array(g.numPoints);
  for (const v of g.vertexPoint) used[v] = 1;
  const pts: number[] = [], trailPts: number[] = [];
  for (let i = 0; i < g.numPoints; i++) (used[i] ? trailPts : pts).push(i);
  return { pts, trailPts };
}

// ---------------------------------------------------------------- emission, lifetimes, attributes

section('emission and lifetimes');
{
  const r = await cook(sim(grid5(), { ...NOG, steps: 10, emit_rate: 1, seed: 1 }));
  const g = r.geo!;
  check(g.numPoints === 50 && g.numPrims === 0, `rate 1 × 5 points × 10 steps = 50 particles, no prims (${g.numPoints}, ${g.numPrims} prims)`);
  const id = attr(g, 'id')!, age = attr(g, 'age')!;
  check([...id].every((v, i) => v === i), 'ids are 0..n-1 in birth order');
  check([...age].every((a) => a >= 0 && a <= 10 * DT + 1e-12), 'every age is within the 10 simulated steps');
  const names = g.points.names().sort().join(',');
  check(['P', 'v', 'age', 'life', 'id', 'pscale'].every((k) => g.points.has(k)), `output point attributes P v age life id pscale (${names})`);
  check(g.detail.names().every((k) => !k.startsWith('__')) && g.points.names().every((k) => !k.startsWith('__')), 'no internal attributes leak into the output');

  const burst = await cook(sim(grid5(2), { steps: 0, emit_all: true, emit_rate: 0, seed: 1 }));
  const b = burst.geo!;
  const src = (await cook({ nodes: { src: grid5(2) }, output: 'src' })).geo!;
  check(b.numPoints === 5 && [...b.P].every((v, i) => v === src.P[i]) && [...attr(b, 'age')!].every((a) => a === 0),
    'emit_all with steps 0: one particle per emitter point, at the point, age 0');

  const quarter = await cook(sim(grid5(), { ...NOG, steps: 40, emit_rate: 0.25, seed: 4 }));
  check(quarter.geo!.numPoints >= 45 && quarter.geo!.numPoints <= 55, `rate 0.25 over 40 steps: 9..11 per point (${quarter.geo!.numPoints} for 5 points)`);
  const frac = await cook(sim({ type: 'point_grid', params: { counts: [40, 1, 1], size: [4, 0, 0] } }, { ...NOG, steps: 1, emit_rate: 0.5, seed: 2 }));
  check(frac.geo!.numPoints > 8 && frac.geo!.numPoints < 32, `per-point phases stagger fractional rates (40 points × 0.5 in one step → ${frac.geo!.numPoints})`);

  const L = 0.5;
  const life = await cook(sim(grid5(), { ...NOG, steps: 40, emit_rate: 1, life: L, seed: 3 }));
  const ages = [...attr(life.geo!, 'age')!], lives = [...attr(life.geo!, 'life')!];
  check(ages.every((a) => a < L) && lives.every((l) => l === L), `life ${L}: every live particle is younger than its life`);
  check(Math.max(...ages) > L - DT && life.geo!.numPoints >= 5 * 11 && life.geo!.numPoints <= 5 * 13, `and none died early (oldest ${Math.max(...ages).toFixed(3)}, ${life.geo!.numPoints} alive ≈ 5 × ${L / DT})`);
  const lv = await cook(sim(grid5(), { ...NOG, steps: 60, emit_rate: 1, life: 1, life_var: 0.4, seed: 3 }));
  const la = attr(lv.geo!, 'age')!, ll = attr(lv.geo!, 'life')!;
  check([...ll].every((l) => l >= 0.6 - 1e-12 && l <= 1.4 + 1e-12) && new Set(ll).size > 10 && [...la].every((a, i) => a < ll[i]), 'life_var: lives within life ± life_var, each particle younger than its own life');

  let ok = true;
  const r2 = rng(5);
  for (let i = 0; i < 2000 && ok; i++) {
    const b0 = Math.floor(r2() * 50), u = i % 7 === 0 ? 0 : 1 - r2(), lifeS = r2() * 3 + 1e-3, dt = [DT, 1 / 30, 0.01][i % 3];
    const k = deathStep(b0, u, lifeS, dt);
    ok = k >= b0 && ageAt(k + 1, b0, u, dt) >= lifeS && (k === b0 || ageAt(k, b0, u, dt) < lifeS);
  }
  check(ok && deathStep(3, 0.5, 0, DT) === NEVER, 'deathStep is the first step after which the age reaches the life (2000 random cases); life 0 = never');

  const carry = await cook({
    nodes: {
      a: { type: 'point_grid', params: { counts: [3, 1, 1], size: [2, 0, 0] } },
      c: { type: 'color', in: ['a'], params: { color: [0.9, 0.2, 0.1] } },
      t: { type: 'attrib_create', in: ['c'], params: { name: 'tag', value: 7 } },
      gr: { type: 'group', in: ['t'], params: { name: 'left', class: 'point', expr: '@P.x < 0' } },
      ps: { type: 'attrib_create', in: ['gr'], params: { name: 'pscale', value: 0.3 } },
      sim: { type: 'particles', in: ['ps'], params: { ...NOG, steps: 4, emit_rate: 1, trails: 3 } },
    },
    output: 'sim',
  });
  const cg = carry.geo!;
  const cd = attr(cg, 'Cd')!, tag = attr(cg, 'tag')!, ps = attr(cg, 'pscale')!;
  check(cd && Math.abs(cd[0] - 0.9) < 1e-12 && [...tag].every((v) => v === 7) && [...ps].every((v) => v === 0.3), 'emitter Cd, custom attributes and pscale are carried to particles and trail points');
  const left = cg.pointGroups.get('left');
  check(!!left && [...left].every((m, i) => (m === 1) === (cg.P[i * 3] < 0)) && left.includes(1) && left.includes(0), 'emitter point groups are carried');
}

// ---------------------------------------------------------------- determinism, pool parity

section('determinism and pool parity');
const BUSY: GraphSpec = {
  nodes: {
    src: { type: 'point_grid', params: { counts: [8, 1, 8], size: [3, 0, 3], center: [0, 2.5, 0] } },
    bump: { type: 'sphere', params: { type: 'ico', level: 3, radius: 0.9 } },
    ground: { type: 'grid', params: { size: [8, 8], divisions: [16, 16], center: [0, -1, 0] } },
    coll: { type: 'merge', in: ['bump', 'ground'] },
    fpts: { type: 'point_grid', params: { counts: [4, 2, 4], size: [6, 3, 6] } },
    fv: { type: 'wrangle', in: ['fpts'], params: { code: 'v@v = [Math.sin(@P.z), 0.2, Math.cos(@P.x)];' } },
    sim: {
      type: 'particles', in: ['src', 'coll', 'fv'],
      params: {
        steps: 40, emit_rate: 0.5, emit_all: true, speed: 1, velocity_var: 1.5, life: 1.4, life_var: 0.3, noise: 3, noise_size: 1.5,
        field_sample: 'idw', field_mode: 'air', drag: 0.7, attract: 0.4, attract_to: 'surface', collide: 'bounce', bounce: 0.6,
        friction: 0.3, use_pscale: true, pscale: 0.05, trails: 6, seed: 9, floor: true, floor_height: -1.5,
      },
    },
  },
  output: 'sim',
};
{
  const a = await cook(BUSY), b = await cook(BUSY, new Engine(createNodeHost({ workers: 0 })));
  check(a.ok && JSON.stringify(fingerprint(a.geo!)) === JSON.stringify(fingerprint(b.geo!)) && sameBits(a.geo!, b.geo!) === null, 'same graph, fresh engines: identical output');
  const c = await cook({ ...BUSY, nodes: { ...BUSY.nodes, sim: { ...BUSY.nodes.sim, params: { ...BUSY.nodes.sim.params, seed: 10 } } } });
  check(sameBits(a.geo!, c.geo!) !== null, 'another seed gives another result');
  const before = forced.poolStats.parallel;
  const d = await cook(BUSY, forced);
  check(forced.poolStats.parallel > before && sameBits(a.geo!, d.geo!) === null && JSON.stringify(a.warnings) === JSON.stringify(d.warnings),
    `pool on (forced, ${forced.poolStats.parallel - before} runs) = pool off, bit for bit (noise, idw air field, surface attraction, mesh + floor bounce, spheres, trails)`);
  const variants: [string, Record<string, any>, Record<string, NodeSpec>, string[]][] = [
    ['curl off, slide, nearest force field', { noise: 2, curl: false, collide: 'slide', field_sample: 'nearest', field_mode: 'force' }, {}, []],
    ['die collisions', { collide: 'die' }, {}, []],
    ['heightfield field and collider', { field_scale: 3 }, {
      hf: { type: 'heightfield', params: { size: [6, 6], resolution: 0.25 } },
      hfn: { type: 'heightfield_noise', in: ['hf'], params: { amplitude: 1, element_size: 3, seed: 2 } },
    }, ['hfn', 'hfn']],
    ['SDF field', { field_scale: 2, attract: 0 }, { sd: { type: 'sdf_shape', params: { shape: 'torus', radius: 1, radius2: 0.3 } } }, ['coll', 'sd']],
  ];
  for (const [label, params, extra, ins] of variants) {
    const g: GraphSpec = structuredClone(BUSY);
    Object.assign(g.nodes, extra);
    Object.assign(g.nodes.sim.params!, params);
    if (ins.length) g.nodes.sim.in = ['src', ...ins];
    const x = await cook(g), y = await cook(g, forced);
    check(x.ok && x.geo!.numPoints > 0 && sameBits(x.geo!, y.geo!) === null, `pool parity: ${label} (${x.geo?.numPoints} points)`);
  }
}

// ---------------------------------------------------------------- collisions

section('collisions');
{
  const rain = (params: Record<string, any>, extra: Record<string, NodeSpec> = {}, ins: string[] = []) =>
    sim({ type: 'point_grid', params: { counts: [10, 1, 10], size: [4, 0, 4], center: [0, 2, 0] } }, { steps: 60, emit_rate: 0.3, emit_all: true, velocity_var: 3, trails: 8, seed: 2, ...params }, extra, ins);
  for (const mode of ['bounce', 'slide']) {
    const r = await cook(rain({ floor: true, floor_height: 0.25, collide: mode }));
    check(r.ok && r.geo!.numPoints > 500 && minY(r.geo!.P) >= 0.25, `floor ${mode}: every particle and trail point stays at or above the floor (min y ${minY(r.geo!.P).toFixed(6)})`);
  }
  const sph = await cook(rain({ floor: true, use_pscale: true, pscale: 0.1, output: 'points' }));
  check(minY(sph.geo!.P) >= 0.1 - 1e-12, `use_pscale: sphere centres stay pscale above the floor (min y ${minY(sph.geo!.P).toFixed(6)})`);
  const rest = await cook(rain({ floor: true, collide: 'bounce', bounce: 0.5, friction: 0.5, steps: 200, output: 'points', emit_rate: 0, velocity_var: 0 }));
  const v = attr(rest.geo!, 'v')!;
  let vmax = 0;
  for (let i = 0; i < v.length; i++) vmax = Math.max(vmax, Math.abs(v[i]));
  check(vmax < 1e-9 && minY(rest.geo!.P) === 0, `bounces die out: dropped particles come to rest on the floor (|v| ≤ ${vmax.toExponential(1)})`);
  const die = await cook(rain({ floor: true, collide: 'die', steps: 80, emit_rate: 0, velocity_var: 0.5, output: 'points' }));
  check(die.geo!.numPoints === 0, `collide die: every particle that reaches the floor is removed (${die.geo!.numPoints} left of 100)`);
  const none = await cook(rain({ floor: true, collide: 'none', steps: 30, output: 'points' }));
  check(minY(none.geo!.P) < 0, 'collide none ignores the floor');

  // a bumpy terrain mesh: particles must stay on top of it
  const terrain: Record<string, NodeSpec> = {
    g: { type: 'grid', params: { size: [6, 6], divisions: [30, 30] } },
    t: { type: 'noise_displace', in: ['g'], params: { amplitude: 0.6, frequency: 0.6, mode: 'direction', direction: [0, 1, 0] } },
  };
  const ter = (await cook({ nodes: terrain, output: 't' })).geo!;
  const bvh = new TriBVH(ter);
  const below = (P: ArrayLike<number>, tol: number) => {
    let worst = Infinity, n = 0;
    for (let i = 0; i < P.length; i += 3) {
      if (Math.abs(P[i]) > 2.9 || Math.abs(P[i + 2]) > 2.9) continue;
      const hit = bvh.raycast(P[i], 50, P[i + 2], 0, -1, 0);
      if (!hit) continue;
      n++;
      worst = Math.min(worst, P[i + 1] - hit.pos[1]);
    }
    return { ok: worst >= -tol, worst, n };
  };
  for (const mode of ['slide', 'bounce']) {
    const r = await cook(rain({ collide: mode, friction: 0.2, steps: 72 }, terrain, ['t']));
    const b = below(r.geo!.P, 1e-9);
    check(r.ok && b.n > 500 && b.ok, `mesh ${mode}: ${b.n} particle and trail points over the terrain, none under it (closest ${b.worst.toExponential(2)} m)`);
  }
  const spheres = await cook(rain({ collide: 'slide', use_pscale: true, pscale: 0.08, steps: 72, output: 'points' }, terrain, ['t']));
  const bs = below(spheres.geo!.P, 1e-9);
  check(bs.ok && bs.worst >= 0.08 * (1 - 1e-9), `use_pscale on a mesh: sphere centres stay pscale or more above the surface (closest ${bs.worst.toFixed(6)} m vertically)`);
  // a closed sphere: nothing gets inside
  const ball: Record<string, NodeSpec> = { s: { type: 'sphere', params: { type: 'ico', level: 3, radius: 1.2 } } };
  const sb = (await cook({ nodes: ball, output: 's' })).geo!;
  const sbvh = new TriBVH(sb);
  for (const mode of ['bounce', 'slide']) {
    const r = await cook(rain({ collide: mode, steps: 50, floor: true, floor_height: -2 }, ball, ['s']));
    const P = r.geo!.P;
    let inside = 0;
    for (let i = 0; i < P.length; i += 3) if (sbvh.inside(P[i], P[i + 1], P[i + 2])) inside++;
    check(r.ok && inside === 0, `closed sphere, ${mode}: no particle or trail point inside (${P.length / 3} points)`);
  }
  const absent = await cook(rain({ collide: 'bounce', steps: 4 }, { l: { type: 'line' } }, ['l']));
  check(absent.warnings.some((w) => w.message.includes('nothing to collide with')), 'a collision input without polygons warns');
}

// ---------------------------------------------------------------- trails

section('trails');
{
  const T = 4, S = 10;
  const r = await cook(sim(grid5(), { ...NOG, steps: S, emit_rate: 1, velocity_var: 1, trails: T, seed: 6 }));
  const g = r.geo!;
  const { pts, trailPts } = split(g);
  check(pts.length === 50 && g.numPrims === 50, `output both: 50 particle points then 50 trail polylines (${pts.length}, ${g.numPrims})`);
  const sizes = Array.from({ length: g.numPrims }, (_, p) => g.primSize(p));
  const want = Array.from({ length: 50 }, (_, i) => Math.min(T, S - Math.floor(i / 5) + 1)); // ids: birth step = floor(id / 5)
  const pid = attr(g, 'id', 'prim')!;
  check(sizes.every((s, p) => s === want[pid[p]]) && g.primClosed.every((c) => !c), 'every trail has min(trails, steps lived + 1) points, open');
  const cu = attr(g, 'curveu')!, age = attr(g, 'age')!, id = attr(g, 'id')!;
  let mono = true, ends = true, last = true, ages = true, ids = true;
  for (let p = 0; p < g.numPrims; p++) {
    const s = g.primStart[p], e = g.primStart[p + 1], vs = g.vertexPoint;
    if (cu[vs[s]] !== 0 || cu[vs[e - 1]] !== 1) ends = false;
    for (let k = s + 1; k < e; k++) {
      if (cu[vs[k]] < cu[vs[k - 1]]) mono = false;
      if (!(age[vs[k]] > age[vs[k - 1]] || (age[vs[k - 1]] === 0 && age[vs[k]] === 0))) ages = false;
    }
    const head = vs[e - 1], q = pts[pid[p]];
    for (let c = 0; c < 3; c++) if (g.P[head * 3 + c] !== g.P[q * 3 + c]) last = false;
    if (age[head] !== age[q] || id[head] !== pid[p]) ids = false;
  }
  check(ends && mono, 'curveu runs 0 → 1 along each trail, never decreasing');
  check(ages, 'trail point age increases from tail to head');
  check(last && ids, 'the head of each trail is its particle (same P, age, id; prim id = particle id)');
  check(trailPts.length === sizes.reduce((a, b) => a + b, 0), 'trail points are their own points (one per vertex)');
  const only = await cook(sim(grid5(), { ...NOG, steps: S, emit_rate: 1, trails: T, output: 'trails' }));
  check(only.geo!.numPrims === 50 && only.geo!.numPoints === only.geo!.numVertices, 'output trails: only the polylines');
  const pointsOnly = await cook(sim(grid5(), { ...NOG, steps: S, emit_rate: 1, trails: T, output: 'points' }));
  check(pointsOnly.geo!.numPrims === 0 && pointsOnly.geo!.numPoints === 50, 'output points: no polylines');
  const bad = await cook(sim(grid5(), { steps: S, trails: 1, output: 'trails' }));
  check(!bad.ok && bad.errors[0].message.includes('trails >= 2'), 'output trails without trails >= 2 is an error with a hint');
  const long = await cook(sim(grid5(), { ...NOG, steps: 3, emit_all: true, emit_rate: 0, velocity_var: 1, trails: 50, output: 'trails' }));
  check(long.geo!.numPrims === 5 && Array.from({ length: 5 }, (_, p) => long.geo!.primSize(p)).every((s) => s === 4), 'emit_all particles have trails of steps + 1 points (birth position included)');
}

// ---------------------------------------------------------------- max_particles

section('max_particles');
{
  const capped = await cook(sim({ type: 'point_grid', params: { counts: [10, 1, 1], size: [4, 0, 0] } }, { ...NOG, steps: 50, emit_rate: 2, max_particles: 100 }));
  check(capped.geo!.numPoints === 100 && capped.warnings.some((w) => w.message.includes('max_particles (100) reached: 900 births')),
    `the cap holds (${capped.geo!.numPoints}) and the refused births are reported`);
  const emitter: NodeSpec = { type: 'point_grid', params: { counts: [10, 1, 1], size: [4, 0, 0] } };
  const g = sim(emitter, { ...NOG, steps: 0, emit_rate: 2, life: 0.5, max_particles: 100 });
  let maxSeen = 0, minLate = Infinity;
  const e = new Engine(createNodeHost({ workers: 0 }));
  await e.init();
  await e.cookFrames(g, { start: 1, end: 60 }, (r, f) => {
    maxSeen = Math.max(maxSeen, r.geo!.numPoints);
    if (f > 30) minLate = Math.min(minLate, r.geo!.numPoints);
  });
  check(maxSeen <= 100 && minLate >= 50, `with life 0.5 s the slots free up: never above 100 over 60 frames, still ${minLate}+ alive after frame 30`);
  const zero = await cook(sim(emitter, { steps: 10, max_particles: 0 }));
  check(zero.geo!.numPoints === 0 && zero.geo!.points.has('age'), 'max_particles 0: an empty result with the usual attributes');
  // R-17: refused births are counted per step and point, not looped over one by one (an emit_rate of 1e12 hung the
  // cook), and the count does not wrap at 2^31 (it read -1894967306 here)
  const t0 = performance.now();
  const flood = await cook(sim({ type: 'points', params: { positions: [[0, 1, 0]] } }, { ...NOG, steps: 2, emit_rate: 1.2e9, max_particles: 10 }));
  const floodMs = performance.now() - t0;
  check(flood.geo!.numPoints === 10 && flood.warnings.some((w) => w.message.includes('max_particles (10) reached: 2399999990 births')) && floodMs < 2000,
    `emit_rate 1.2e9 under max_particles 10: 2,399,999,990 refused births counted in ${floodMs.toFixed(0)} ms`);
}

// ---------------------------------------------------------------- time

section('time stepping');
{
  const base = { steps: 6, emit_rate: 0.5, emit_all: true, velocity_var: 2, life: 1.2, trails: 5, floor: true, noise: 1, seed: 8 };
  const anim = sim(grid5(1.5), base);
  const F = 14;
  const atF = await cook(anim, new Engine(createNodeHost({ workers: 0 })), F);
  const flat = await cook(sim(grid5(1.5), { ...base, animate: false, steps: base.steps + (F - 1) }));
  check(atF.ok && sameBits(atF.geo!, flat.geo!) === null, `frame ${F} = one run of steps + ${F - 1} steps (bit for bit)`);
  check(atF.results.get('sim')!.timeDependent && !flat.results.get('sim')!.timeDependent, 'animate makes the node time-dependent; animate false does not');
  const e = new Engine(createNodeHost({ workers: 0 }));
  await e.init();
  let at13: CookReport | null = null, lastR: CookReport | null = null;
  await e.cookFrames(anim, { start: 1, end: F }, (r, f) => { if (f === F - 1) at13 = r; if (f === F) lastR = r; });
  const st = (lastR as unknown as CookReport).results.get('sim')!.stats!;
  check(sameBits((lastR as unknown as CookReport).geo!, atF.geo!) === null && st.resumed_from === base.steps + F - 2 && st.steps === 1,
    `frames 1..${F} one after another: the last frame resumes from frame ${F - 1}'s state, runs 1 step, and equals the direct cook`);
  const back = await e.cook(structuredClone(anim), { frame: 5 });
  const fresh5 = await cook(anim, new Engine(createNodeHost({ workers: 0 })), 5);
  check(sameBits(back.geo!, fresh5.geo!) === null, 'jumping back to frame 5 equals a fresh cook at frame 5');
  check(at13 !== null && sameBits((at13 as unknown as CookReport).geo!, (await cook(anim, new Engine(createNodeHost({ workers: 0 })), F - 1)).geo!) === null, `frame ${F - 1} along the way equals a fresh cook at ${F - 1}`);
  const before = await cook(anim, new Engine(createNodeHost({ workers: 0 })), 0);
  const at1 = await cook(anim, new Engine(createNodeHost({ workers: 0 })), 1);
  check(sameBits(before.geo!, at1.geo!) === null, 'frames before start_frame show the start_frame state');
  const sub = await cook(sim(grid5(1.5), { ...base, substeps: 3 }), new Engine(createNodeHost({ workers: 0 })), 4);
  const subFlat = await cook(sim(grid5(1.5), { ...base, substeps: 3, animate: false, steps: base.steps + 9 }));
  check(sameBits(sub.geo!, subFlat.geo!) === null, 'substeps 3: frame 4 = steps + 9 steps of dt / 3');
  // a moving emitter (time-dependent input): stepped frame by frame either way
  const moving: GraphSpec = {
    nodes: {
      src: { type: 'point_grid', params: { counts: [3, 1, 1], size: [1, 0, 0], center: ['=frame * 0.2', 1, 0] } },
      sim: { type: 'particles', in: ['src'], params: { ...base, trails: 0 } },
    },
    output: 'sim',
  };
  const m1 = new Engine(createNodeHost({ workers: 0 }));
  await m1.init();
  let mLast: CookReport | null = null;
  await m1.cookFrames(moving, { start: 1, end: 10 }, (r) => { mLast = r; });
  const m2 = await cook(moving, new Engine(createNodeHost({ workers: 0 })), 10);
  const m3 = await cook(moving, forced, 10);
  const still = await cook({ ...moving, nodes: { ...moving.nodes, src: { type: 'point_grid', params: { counts: [3, 1, 1], size: [1, 0, 0], center: [0.2, 1, 0] } } } }, off, 10);
  check(sameBits((mLast as unknown as CookReport).geo!, m2.geo!) === null && sameBits(m2.geo!, m3.geo!) === null && sameBits(m2.geo!, still.geo!) !== null,
    'a moving emitter: frames one by one = a direct cook = the pool, and births follow the emitter');
  const xs = attr(m2.geo!, 'id')!;
  check(xs.length > 0, `moving emitter output has ${xs.length} particles`);
}

// ---------------------------------------------------------------- fields and forces

section('fields and forces');
{
  const one: NodeSpec = { type: 'points', params: { positions: [[0, 0, 0]] } };
  const left1: NodeSpec = { type: 'points', params: { positions: [[-1, 0, 0]] } };
  const fieldPts: NodeSpec = { type: 'points', params: { positions: [[-5, 0, 0], [5, 0, 0]], attribs: { v: [[1, 0, 0], [3, 0, 0]] } } };
  const S = 24;
  const push = await cook(sim(left1, { ...NOG, steps: S, emit_all: true, emit_rate: 0 }, { f: fieldPts }, [null as any, 'f']));
  const x = push.geo!.P[0] + 1;
  check(Math.abs(x - 0.5 * (1 + DT)) < 1e-9, `points field (nearest, force): a = v of the nearest point, x after 1 s = ½ a t (t + dt) (${x.toFixed(6)})`);
  const idw = await cook(sim(one, { ...NOG, steps: 1, emit_all: true, emit_rate: 0, field_sample: 'idw', field_neighbours: 2 }, { f: fieldPts }, [null as any, 'f']));
  check(Math.abs(attr(idw.geo!, 'v')![0] - 2 * DT) < 1e-12, 'idw: halfway between v = 1 and v = 3 the field is 2');
  const air = await cook(sim(left1, { ...NOG, steps: 96, emit_all: true, emit_rate: 0, field_mode: 'air', drag: 3 }, { f: { type: 'points', params: { positions: [[0, 0, 0]], attribs: { v: [[1, 0, 0]] } } } }, [null as any, 'f']));
  check(Math.abs(attr(air.geo!, 'v')![0] - 1) < 1e-3, `field_mode air with drag: the velocity approaches the field velocity (${attr(air.geo!, 'v')![0].toFixed(5)})`);
  const far = await cook(sim(left1, { ...NOG, steps: 10, emit_all: true, emit_rate: 0, field_max_distance: 2 }, { f: fieldPts }, [null as any, 'f']));
  check(far.geo!.P[0] === -1, 'field_max_distance: points farther away have no effect');

  const slope: Record<string, NodeSpec> = {
    hf: { type: 'heightfield', params: { size: [10, 10], resolution: 0.5 } },
    tilt: { type: 'heightfield_layer', in: ['hf'], params: { expression: '0.5 * x' } },
  };
  const down = await cook(sim(one, { ...NOG, steps: 24, emit_all: true, emit_rate: 0, field_scale: 2 }, slope, [null as any, 'tilt']));
  const dP = down.geo!.P;
  check(Math.abs(dP[0] + 0.5 * (1 + DT)) < 1e-5 && dP[1] === 0 && Math.abs(dP[2]) < 1e-6, `heightfield field: force = -gradient × scale (downhill along -x, a = 1: x = ${dP[0].toFixed(6)})`);
  const sdfF = await cook(sim({ type: 'points', params: { positions: [[2, 0, 0], [0, 0, -2.5]] } }, { ...NOG, steps: 12, emit_all: true, emit_rate: 0, field_scale: 1 },
    { sd: { type: 'sdf_shape', params: { shape: 'sphere', radius: 0.5 } } }, [null as any, 'sd']));
  const sP = sdfF.geo!.P;
  check(sP[0] < 2 && Math.abs(sP[1]) < 1e-6 && sP[5] > -2.5 && Math.abs(sP[3]) < 1e-6, `SDF field: particles accelerate toward the surface along -gradient (${sP[0].toFixed(3)}, ${sP[5].toFixed(3)})`);
  // R-17: bounds that overflow the sampling grid made its size NaN: the cook succeeded with v = NaN on every particle
  // (and P reset to 0 by the engine's finite check)
  const huge = await cook(sim({ type: 'points', params: { positions: [[0, 1, 0]] } }, { ...NOG, steps: 5, emit_all: true, emit_rate: 0 },
    { sd: { type: 'sdf_shape', params: { shape: 'sphere', radius: 1e308 } } }, [null as any, 'sd']));
  check(!huge.ok && /SDF volume ".*" cannot be sampled: its bounds .* are too large/.test(huge.errors[0]?.message ?? ''), `an SDF field too large to sample fails the node: ${huge.errors[0]?.message ?? 'cooked'}`);
  const att = await cook(sim(one, { ...NOG, steps: 120, emit_all: true, emit_rate: 0, attract: 4, attract_point: [1, 0, 0], drag: 3 }));
  check(Math.abs(att.geo!.P[0] - 1) < 0.02, `attract to a point with drag settles near it (${att.geo!.P[0].toFixed(3)})`);
  const surf = await cook(sim({ type: 'points', params: { positions: [[0, 2, 0], [0.3, -1.6, 0.2]] } }, { ...NOG, steps: 96, emit_all: true, emit_rate: 0, attract: 6, attract_to: 'surface', drag: 3, collide: 'slide' },
    { s: { type: 'sphere', params: { type: 'ico', level: 3, radius: 1 } } }, ['s']));
  const r0 = Math.hypot(surf.geo!.P[0], surf.geo!.P[1], surf.geo!.P[2]), r1 = Math.hypot(surf.geo!.P[3], surf.geo!.P[4], surf.geo!.P[5]);
  check(Math.abs(r0 - 1) < 0.05 && Math.abs(r1 - 1) < 0.05, `attract_to surface pulls particles onto the collision surface (|P| = ${r0.toFixed(3)}, ${r1.toFixed(3)})`);
  const wind = await cook(sim(one, { ...NOG, steps: 96, emit_all: true, emit_rate: 0, wind: [2, 0, 1], drag: 2 }));
  const wv = attr(wind.geo!, 'v')!;
  check(Math.abs(wv[0] - 2) < 1e-3 && Math.abs(wv[2] - 1) < 1e-3, 'wind with drag: the velocity approaches the wind');
  const noDrag = await cook(sim(one, { steps: 2, wind: [2, 0, 0] }));
  check(noDrag.warnings.some((w) => w.message.includes('wind has no effect without drag')), 'wind without drag warns');
  const grav = await cook(sim(one, { steps: 24, emit_all: true, emit_rate: 0 }));
  check(Math.abs(grav.geo!.P[1] + 0.5 * 9.81 * (1 + DT)) < 1e-9 && Math.abs(attr(grav.geo!, 'v')![1] + 9.81) < 1e-9, 'gravity: semi-implicit Euler, v = g t, y = ½ g t (t + dt)');
  const N = await cook(sim({ type: 'points', params: { positions: [[0, 0, 0]], attribs: { N: [[1, 0, 0]], v: [[0, 0, 2]] } } }, { ...NOG, steps: 0, emit_all: true, emit_rate: 0, speed: 3 }));
  const nv = attr(N.geo!, 'v')!;
  check(nv[0] === 3 && nv[1] === 0 && nv[2] === 2, 'initial velocity = emitter v + speed along emitter N');

  // perlinGrad: the analytic gradient agrees with finite differences; curl noise is divergence-free
  const perm = perlinPerm(3), o = new Float64Array(3), t = new Float64Array(3);
  let worst = 0;
  for (let i = 0; i < 500; i++) {
    const X = Math.sin(i) * 9, Y = Math.cos(i * 1.3) * 7, Z = Math.sin(i * 0.7) * 5, h = 1e-5;
    perlinGrad(perm, X, Y, Z, o);
    worst = Math.max(worst,
      Math.abs((perlinGrad(perm, X + h, Y, Z, t) - perlinGrad(perm, X - h, Y, Z, t)) / (2 * h) - o[0]),
      Math.abs((perlinGrad(perm, X, Y + h, Z, t) - perlinGrad(perm, X, Y - h, Z, t)) / (2 * h) - o[1]),
      Math.abs((perlinGrad(perm, X, Y, Z + h, t) - perlinGrad(perm, X, Y, Z - h, t)) / (2 * h) - o[2]));
  }
  check(worst < 1e-6, `Perlin gradient = finite differences (max error ${worst.toExponential(1)})`);
  const perms = [perlinPerm(1), perlinPerm(2), perlinPerm(3)], f = new Float64Array(3), gs = new Float64Array(9);
  const F = (x: number, y: number, z: number, c: number) => { noiseForce(perms, 2, true, 1 / 1.5, 1, x, y, z, f, gs, t); return f[c]; };
  let divMax = 0, gradMax = 0;
  for (let i = 0; i < 300; i++) {
    const X = Math.sin(i * 2.1) * 4, Y = Math.cos(i * 0.9) * 4, Z = Math.sin(i * 1.7) * 4, h = 1e-4;
    const dx = (F(X + h, Y, Z, 0) - F(X - h, Y, Z, 0)) / (2 * h), dy = (F(X, Y + h, Z, 1) - F(X, Y - h, Z, 1)) / (2 * h), dz = (F(X, Y, Z + h, 2) - F(X, Y, Z - h, 2)) / (2 * h);
    divMax = Math.max(divMax, Math.abs(dx + dy + dz));
    gradMax = Math.max(gradMax, Math.abs(dx), Math.abs(dy), Math.abs(dz));
  }
  check(divMax < 1e-5 * Math.max(1, gradMax), `curl noise is divergence-free (|div| ≤ ${divMax.toExponential(1)} against derivatives up to ${gradMax.toFixed(2)})`);

  // knnInto against brute force
  const R = rng(4), pts = Float64Array.from({ length: 3000 }, () => R() * 10);
  const kd = new KDTree(pts).arrays();
  const oi = new Int32Array(8), od = new Float64Array(8), stk = new Int32Array(512), bnd = new Float64Array(256);
  let knnOk = true;
  for (let q = 0; q < 200 && knnOk; q++) {
    const x = R() * 10, y = R() * 10, z = R() * 10, k = 1 + (q % 8), maxD2 = q % 3 === 0 ? 4 : Infinity;
    const m = knnInto(kd.TP, kd.idx, kd.axis, x, y, z, k, maxD2, oi, od, stk, bnd);
    const all = Array.from({ length: 1000 }, (_, i) => (pts[i * 3] - x) ** 2 + (pts[i * 3 + 1] - y) ** 2 + (pts[i * 3 + 2] - z) ** 2).filter((d) => d <= maxD2).sort((a, b) => a - b);
    knnOk = m === Math.min(k, all.length) && Array.from(od.subarray(0, m)).every((d, i) => d === all[i]);
  }
  check(knnOk, 'knnInto finds the k nearest points within the radius (200 queries against brute force)');
}

// ---------------------------------------------------------------- node integration

section('node integration');
{
  check(getNodeDef('pop')?.type === 'particles' && getNodeDef('particles')?.category === 'sim', 'type particles (category sim), alias pop');
  const ex = await cook(getNodeDef('particles')!.example);
  check(ex.ok && ex.geo!.numPoints > 0 && ex.geo!.numPrims > 0, `the node example cooks (${ex.geo?.numPoints} points, ${ex.geo?.numPrims} trails)`);
  const empty = await cook(sim({ type: 'points', params: { positions: [] } }, { steps: 5 }));
  check(empty.ok && empty.geo!.numPoints === 0 && ['v', 'age', 'life', 'id', 'pscale'].every((k) => empty.geo!.points.has(k)), 'an empty emitter gives an empty result with the usual attributes');
}

// ---------------------------------------------------------------- speed

section('speed');
{
  const graph = (seed: number): GraphSpec => sim({ type: 'point_grid', params: { counts: [50, 1, 2000], size: [10, 0, 400], center: [0, 5, 0] } },
    { steps: 200, emit_all: true, emit_rate: 0, velocity_var: 2, floor: true, collide: 'bounce', seed });
  const e = new Engine(createNodeHost({}));
  await e.init();
  await e.cook(graph(0)); // warm the pool
  const t0 = performance.now();
  const r = await e.cook(graph(1));
  const ms = performance.now() - t0;
  check(r.ok && r.geo!.numPoints === 100000 && minY(r.geo!.P) >= 0 && ms < 15000, `100k particles × 200 steps with floor collisions on the pool: ${ms.toFixed(0)} ms (target < 3 s)`);
  console.log(`   (pool ${e.host.pool?.size ?? 0} threads; node ${r.results.get('sim')!.ms.toFixed(0)} ms)`);
}

console.log(`\nparticles: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
