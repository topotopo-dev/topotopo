// Cloth and pressure simulation, Vellum-lite (category "sim"): drape (cloth over colliders, pinned banners in the wind)
// and inflate (a closed mesh under a volume constraint: cushions, balloons, sacks). Both run the XPBD solver of
// src/core/xpbd.ts from the input positions for `steps` steps and output the last state with the input's topology and
// attributes: P moved, v the final velocity, rest_P the input positions, N refreshed, `pinned` when anything is pinned.
// The cook is not time-dependent: it always simulates from the input (drive `steps` with "=frame" to animate, or use a
// solver for frame-to-frame feedback).
//
// What runs where: the constraint solve runs on the cooking thread in a fixed order (colour-sorted point constraints,
// stretch chains in build order); the per-step collider queries run through ctx.parallelMap (kernel "cloth_collide",
// pure per point, so bit-identical in chunks), so a result is the same with and without the worker pool.
import type { Geometry } from '../core/geometry.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import type { CookContext, ParamDef } from '../graph/types.ts';
import { KDTree } from '../core/spatial.ts';
import { pointNormals, refreshNormals } from '../core/topology.ts';
import { rand } from '../core/random.ts';
import { XpbdCloth, buildCloth, buildCollider, colliderArrays, collideRange } from '../core/xpbd.ts';
import type { Collider, SimOptions } from '../core/xpbd.ts';
import { hashArrays } from '../core/kernels.ts';
import { P, mask, simBudget } from './util.ts';

interface Defaults {
  steps: number; gravity: number[]; floor: boolean; stretch: number; shear: number; bend: number; damping: number; drag: number; tethers: boolean;
}

/** The params drape and inflate share (defaults differ). */
function simParams(d: Defaults): Record<string, ParamDef> {
  return {
    steps: { type: 'int', default: d.steps, min: 0, max: 100000, desc: 'simulation steps of 1/fps s each; the output is the state after the last one (settle time = steps / fps)', aliases: ['frames'] },
    substeps: { type: 'int', default: 4, min: 1, max: 100, desc: 'substeps per step: more = stiffer cloth and fewer missed contacts (cost grows linearly)', aliases: ['sub_steps'] },
    iterations: { type: 'int', default: 1, min: 1, max: 100, desc: 'constraint sweeps per substep (stretch chains solved exactly, the rest Gauss-Seidel); substeps help more than iterations', aliases: ['constraint_iterations'] },
    fps: { type: 'float', default: 24, min: 1, desc: 'steps per simulated second (step length 1/fps s)', advanced: true },
    gravity: { type: 'vec3', default: d.gravity, desc: 'gravity acceleration in m/s²' },
    stretch_stiffness: { type: 'float', default: d.stretch, min: 0, desc: 'stretch stiffness of the polygon edges in N/m (≈ the sheet\'s 2D Young\'s modulus); 1e4+ is practically inextensible, 100 is rubbery; 0 = no stretch constraints', aliases: ['stretch', 'stiffness'] },
    shear_stiffness: { type: 'float', default: d.shear, min: 0, desc: 'shear stiffness of the quad diagonals (and inner polygon edges) in N/m; low = fabric that drapes on the bias; 0 = none', aliases: ['shear'] },
    bend_stiffness: { type: 'float', default: d.bend, min: 0, desc: 'bending rigidity in N·m (resolution independent): 1e-5 silk, 1e-4 cotton, 1e-3 canvas, 1e-2 tarp/leather; 0 = no bend constraints', aliases: ['bend', 'bending'] },
    density: { type: 'float', default: 0.2, min: 0, desc: 'surface density in kg/m² for the point masses (a point float `mass` attribute overrides it); only matters relative to the stiffnesses and the wind', advanced: true },
    damping: { type: 'float', default: d.damping, min: 0, desc: 'velocity damping rate in 1/s (velocities shrink by e^(-damping·t)); higher settles sooner', aliases: ['velocity_damping'] },
    drag: { type: 'float', default: d.drag, min: 0, desc: 'air drag ½·ρ·Cd in kg/m³ on each triangle against the wind (normal component, quadratic); 0 = vacuum', aliases: ['air_drag'] },
    wind: { type: 'vec3', default: [0, 0, 0], desc: 'wind velocity in m/s (acts through drag)' },
    thickness: { type: 'float', default: 0.02, min: 0, desc: 'collision offset in m: points stay this far from colliders and the floor (and 2× apart with self_collision, which works best with about half the edge length)', aliases: ['collision_thickness', 'pscale'] },
    friction: { type: 'float', default: 0.4, min: 0, desc: 'Coulomb friction coefficient against colliders and the floor (0 = slippery)' },
    floor: { type: 'bool', default: d.floor, desc: 'collide with the ground plane y = floor_height', aliases: ['ground', 'ground_plane'] },
    floor_height: { type: 'float', default: 0, desc: 'height of the ground plane', aliases: ['ground_height'] },
    self_collision: { type: 'bool', default: false, desc: 'point-point self collision (spatial hash, pairs found per step); effective when thickness is about half the edge length', aliases: ['selfcollision'] },
    rest_scale: { type: 'float', default: 1, min: 0.01, desc: 'multiplies the stretch and shear rest lengths: < 1 tightens the cloth (a taut tarp, a cushion that pulls in its seams), > 1 slackens it', aliases: ['restlength_scale'] },
    seed: { type: 'int', default: 0, desc: 'seed of a tiny deterministic jitter of the start positions (10⁻³ of the edge length) that breaks perfect symmetry' },
    pin_group: P.group('point', 'points pinned in place ("" = none); a point attribute `pin` != 0 and the nearest cloth point to each point of the `pins` input are pinned too'),
    pin_snap: { type: 'bool', default: false, desc: 'move the cloth points pinned by the `pins` input onto those pin points first (hang a cloth from hooks)' },
    tethers: { type: 'bool', default: d.tethers, desc: 'long-range attachments: no point gets farther from its nearest pin than along the cloth at rest, so pinned cloth does not stretch under its weight or the wind', advanced: true },
    keep_rest: { type: 'bool', default: true, desc: 'write the input positions to the point attribute rest_P' },
    max_points: { type: 'int', default: 100000, min: 1, max: 10000000, desc: 'refuse inputs with more points than this (cost grows with points × steps × substeps × iterations)', advanced: true },
  };
}

const INPUTS = [
  { name: 'cloth', desc: 'the cloth: any polygon mesh (quads are triangulated internally for the constraints; the output keeps the topology), polylines become strings' },
  { name: 'collider', desc: 'static collision geometry (its polygons; closed pieces push out points that end up inside)', optional: true },
  { name: 'pins', desc: 'pin points: the nearest cloth point to each is pinned (see pin_snap)', optional: true },
];

/** Undirected edges of the triangulation used by fewer or more than two triangles (holes, non-manifold seams). */
function openEdges(tris: Int32Array, n: number): number {
  const cnt = new Map<number, number>();
  for (let t = 0; t < tris.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = tris[t + k], b = tris[t + ((k + 1) % 3)];
      const key = a < b ? a * n + b : b * n + a;
      cnt.set(key, (cnt.get(key) ?? 0) + 1);
    }
  let open = 0;
  for (const c of cnt.values()) if (c !== 2) open++;
  return open;
}

async function simulate(ctx: CookContext, mode: 'drape' | 'inflate'): Promise<Geometry> {
  const { p, warn, stat } = ctx;
  const src = ctx.input(0);
  const n = src.numPoints;
  if (n > p.max_points)
    throw new NodeError(`${mode}: the cloth has ${n} points, over max_points (${p.max_points})`,
      'raise max_points if you mean it (cost grows with points × steps × substeps × iterations), or decimate / remesh the input first');
  const g = src.clone();
  if (!n) return g;
  const massAttr = g.points.get('mass');
  const model = buildCloth(g, {
    density: p.density, stretch: p.stretch_stiffness, shear: p.shear_stiffness, bend: p.bend_stiffness, restScale: p.rest_scale,
    mass: massAttr && massAttr.type === 'float' && massAttr.size === 1 ? (massAttr.data as Float64Array) : null,
    // inflate solves stretch point by point: exactly solved chains are inextensible hoops that buckle (lumps) when the
    // volume pushes outwards; the point-wise sweep lets the skin stretch evenly
    chains: mode !== 'inflate',
  });
  if (mode === 'inflate') {
    if (!model.tris.length) throw new NodeError('inflate: the input has no polygons', 'inflate needs a closed polygon mesh (box, sphere, a closed sack)');
    const open = openEdges(model.tris, n);
    if (open) warn(`the mesh is not closed (${open} open or non-manifold edges): its volume is measured as if the holes were capped`);
  } else if (!model.dA.length && g.numPrims === 0) warn('no polygons or curves: the points fall as free particles');

  // pins: pin_group, a `pin` attribute, the nearest cloth points to input 3's points
  const pinned = new Uint8Array(n);
  if (p.pin_group) {
    const m = mask(g, 'point', p.pin_group);
    if (m) for (let i = 0; i < n; i++) if (m[i]) pinned[i] = 1;
  }
  const pinAttr = g.points.get('pin');
  if (pinAttr && pinAttr.type !== 'string' && !pinAttr.isArray) {
    const d = pinAttr.data as Float64Array | Int32Array, s = pinAttr.size;
    for (let i = 0; i < n; i++) if (d[i * s] !== 0) pinned[i] = 1;
  }
  const x0 = Float64Array.from(g.P);
  if (ctx.hasInput(2)) {
    const pg = ctx.input(2);
    if (pg.numPoints) {
      const kd = new KDTree(g.P), PP = pg.P;
      for (let j = 0; j < pg.numPoints; j++) {
        const { index } = kd.nearest(PP[j * 3], PP[j * 3 + 1], PP[j * 3 + 2]);
        if (index < 0) continue;
        pinned[index] = 1;
        if (p.pin_snap) { x0[index * 3] = PP[j * 3]; x0[index * 3 + 1] = PP[j * 3 + 1]; x0[index * 3 + 2] = PP[j * 3 + 2]; }
      }
    } else warn('the pin input has no points: nothing pinned by it');
  }
  let nPinned = 0;
  for (let i = 0; i < n; i++) nPinned += pinned[i];
  if (nPinned === n && n > 0) warn('every point is pinned: nothing moves');

  // a tiny deterministic jitter of the free points breaks perfect symmetry (a cloth centred on a box)
  const jit = 1e-3 * (model.meanEdge || 0.01);
  for (let i = 0; i < n; i++)
    if (!pinned[i]) for (let c = 0; c < 3; c++) x0[i * 3 + c] += (rand(i * 3 + c, p.seed) - 0.5) * 2 * jit;

  const vAttr = g.points.get('v');
  const v0 = vAttr && vAttr.type === 'float' && vAttr.size === 3 ? (vAttr.data as Float64Array) : null;
  const opts: SimOptions = {
    dt: 1 / p.fps, substeps: p.substeps, iterations: p.iterations, gravity: p.gravity, damping: p.damping, drag: p.drag,
    wind: p.wind, thickness: p.thickness, friction: p.friction, floor: !!p.floor, floorHeight: p.floor_height,
    selfCollision: !!p.self_collision, tethers: !!p.tethers,
  };
  if (mode === 'inflate') { opts.pressure = p.pressure; opts.pressureStiffness = p.pressure_stiffness; opts.pressureRamp = Math.ceil(p.steps / 2); }
  const sim = new XpbdCloth(model, opts, x0, v0, pinned);

  let collider: Collider | null = null;
  if (ctx.hasInput(1)) {
    collider = buildCollider(ctx.input(1));
    if (!collider) warn('the collider has no polygons: only the floor collides');
  }
  const R = new Float64Array(n);
  const shared = collider ? colliderArrays(collider) : null;
  // the collider is the same every step: hash it once, so the pool reuses its shared copy
  const sharedKey = shared ? hashArrays(shared) : '';
  const detect = () => {
    sim.queryRadius(R);
    const c = collider!;
    return ctx.parallelMap('cloth_collide', {
      count: n, inputs: { X: sim.x, R }, outputs: { CP: sim.cp, CN: sim.cn, CF: sim.cf, CT: sim.ct, QD: sim.qd }, shared: shared!, sharedKey,
    }, { serial: () => collideRange(c, sim.x, R, sim.cp, sim.cn, sim.cf, sim.ct, sim.qd, 0, n) });
  };

  // the wall-clock limit of long-running nodes, checked every step (steps × substeps × iterations can reach 10^9 sweeps)
  const budget = simBudget(ctx, 'fewer steps, substeps or iterations, or a coarser cloth (decimate / remesh); or raise the limit');
  sim.settleFloor();
  for (let s = 0; s < p.steps; s++) {
    budget.check();
    if (collider) {
      const r = detect();
      if (r instanceof Promise) await r;
      sim.afterQuery(R);
      if (s === 0) sim.settleContacts();
      sim.findCornerContacts(collider);
    }
    if (opts.selfCollision) sim.findSelfPairs();
    sim.step();
  }
  if (!sim.finite())
    throw new NodeError(`${mode}: the simulation diverged (non-finite positions)`, 'lower the stiffnesses or the wind, or raise substeps');

  // outputs
  g.P.set(sim.x);
  (g.points.add('v', 'float', 3).data as Float64Array).set(sim.v);
  if (p.keep_rest) (g.points.add('rest_P', 'float', 3).data as Float64Array).set(model.X);
  if (nPinned) {
    const a = g.points.add('pinned', 'int', 1).data as Int32Array;
    for (let i = 0; i < n; i++) a[i] = pinned[i];
  }
  if (g.points.has('N') || g.vertices.has('N') || g.prims.has('N')) refreshNormals(g);
  else if (model.tris.length) (g.points.add('N', 'float', 3).data as Float64Array).set(pointNormals(g));
  let contacts = 0;
  const y0 = p.floor_height + p.thickness * 1.01;
  for (let i = 0; i < n; i++) if (!pinned[i] && ((collider && sim.cf[i]) || (p.floor && sim.x[i * 3 + 1] <= y0))) contacts++;
  stat('substeps', p.steps * p.substeps);
  stat('constraints', model.dA.length + model.bRest.length + model.iAlpha.length + (sim.tA ? n - nPinned : 0));
  stat('contacts', contacts);
  if (mode === 'inflate' && sim.vRest > 0) stat('volume_ratio', sim.volume() / sim.vRest);
  return g;
}

defineNode({
  type: 'drape',
  category: 'sim',
  summary: 'Cloth simulation (XPBD, Vellum-lite): drape a mesh over colliders and the floor, hang it from pins, blow it in the wind.',
  description:
    'Simulates the `cloth` input for `steps` steps and outputs the final state (same points, prims and attributes; P moved, ' +
    'v, rest_P, N, pinned). Constraints in compliance form, so stiffnesses are physical and independent of the step size: ' +
    'stretch on the polygon edges (rows and columns solved as whole chains, so hanging cloth does not sag), shear on the ' +
    'quad diagonals, bending across edges (isometric where flat at rest, dihedral towards the rest angle of the input elsewhere), tethers to the nearest pin. Collides ' +
    'with the `collider` input (a static mesh; points stay `thickness` away; closed pieces push out points that get ' +
    'inside) and the floor plane, with friction; sharp collider corners get extra corner contacts, but a sharp collider ' +
    'edge can still pass between the points of a coarse cloth (use a finer cloth there). Pins: `pin_group`, a `pin` point attribute, or the nearest cloth points to ' +
    'the `pins` input. Typical graphs: grid above a box → drape(grid, box); grid with a pinned top edge + wind → a banner. ' +
    'Deterministic (bit-identical with and without the worker pool). Houdini: Vellum Cloth + Vellum Solver, run to a ' +
    'settled frame.',
  aliases: ['cloth', 'vellum_cloth', 'vellum', 'cloth_sim'],
  inputs: INPUTS,
  params: simParams({ steps: 100, gravity: [0, -9.81, 0], floor: true, stretch: 1e5, shear: 1e3, bend: 1e-3, damping: 0.2, drag: 0.5, tethers: true }),
  outputs: 'point v, rest_P (keep_rest), N, pinned (int, when anything is pinned)',
  example: {
    nodes: {
      cloth: { type: 'grid', params: { size: [2, 2], divisions: [24, 24], center: [0, 1.3, 0] } },
      table: { type: 'box', params: { size: [1, 1, 1], center: [0, 0.5, 0] } },
      out: { type: 'drape', in: ['cloth', 'table'], params: { steps: 48, thickness: 0.03 } },
    },
    output: 'out',
  },
  cook: (ctx) => simulate(ctx, 'drape'),
});

defineNode({
  type: 'inflate',
  category: 'sim',
  summary: 'Inflate a closed mesh with an XPBD volume constraint (Vellum pressure): cushions, balloons, bulging sacks.',
  description:
    'Simulates the `geo` input as a closed cloth bag whose volume is driven towards `pressure` × its rest volume, against the ' +
    'same stretch, shear and bend constraints as drape (and the same collider, floor, pins and wind). pressure 1 keeps ' +
    'the volume, 1.5 puffs a box into a cushion, < 1 deflates it; pressure_stiffness sets how hard the volume pushes ' +
    'against the cloth (a stiff cloth caps the volume: a sphere needs a soft stretch_stiffness to grow, a box bulges into a ' +
    'pillow). The pressure rises smoothly over the first half of the steps, and the skin is solved edge by edge so it ' +
    'stretches evenly. Gravity and the floor are off by default (the shape inflates in place); turn them on to rest a ' +
    'cushion on the ground. Houdini: Vellum Pressure constraint.',
  aliases: ['vellum_pressure', 'pressure', 'balloon'],
  inputs: [{ ...INPUTS[0], name: 'geo', desc: 'a closed polygon mesh (box, sphere, a sewn sack)' }, INPUTS[1], INPUTS[2]],
  params: {
    pressure: { type: 'float', default: 1.5, min: 0, desc: 'target volume / rest volume (1 = keep, 1.5 = cushion, 3 = balloon if the cloth can stretch)', aliases: ['volume_scale'] },
    pressure_stiffness: { type: 'float', default: 1e4, min: 0, desc: 'stiffness of the volume constraint in N/m (compared with stretch_stiffness: equal values split the difference); 0 = no pressure' },
    ...simParams({ steps: 60, gravity: [0, 0, 0], floor: false, stretch: 1e4, shear: 1e3, bend: 1e-3, damping: 1, drag: 0, tethers: false }),
  },
  outputs: 'point v, rest_P (keep_rest), N, pinned (int, when anything is pinned)',
  example: {
    nodes: {
      bag: { type: 'box', params: { size: [1, 0.3, 1], divisions: [8, 3, 8] } },
      out: { type: 'inflate', in: ['bag'], params: { pressure: 1.6, steps: 30 } },
    },
    output: 'out',
  },
  cook: (ctx) => simulate(ctx, 'inflate'),
});
