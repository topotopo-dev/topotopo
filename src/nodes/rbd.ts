// Rigid-body settling (category "sim"): rbd_settle drops pieces and lets them come to rest, rbd_stack drops them one
// at a time so they pile up instead of starting inside each other. Physics by Rapier (src/core/rbd.ts, loaded lazily
// through src/wasm/rapier.ts on the first cook).
import type { Geometry } from '../core/geometry.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import type { CookContext, ParamDef } from '../graph/types.ts';
import { RBD_PIECE_MODES, RBD_SHAPES, RbdSim, applyRbd, collectRbdScene, staticMesh } from '../core/rbd.ts';
import type { RbdScene, RbdSimOptions, RbdStackOptions } from '../core/rbd.ts';
import { DEFAULT_TRANSFER, expandPacked } from '../core/packed.ts';
import { loadRapier } from '../wasm/rapier.ts';

const COMMON: Record<string, ParamDef> = {
  pieces: { type: 'enum', options: [...RBD_PIECE_MODES], default: 'auto', desc: 'how polygons form pieces (packed prims are always one piece each): auto = prim attribute piece, else copynum (unpacked copy_to_points), else name, else connected parts; connectivity; name; attrib (piece_attrib)' },
  piece_attrib: { type: 'string', default: '', desc: 'pieces = attrib: the prim (or point) attribute whose values name the pieces, e.g. "class" from connectivity' },
  collision_shape: { type: 'enum', options: [...RBD_SHAPES], default: 'convex_hull', aliases: ['shape', 'collision'], desc: 'shape the pieces collide with: convex_hull (computed once per packed source, scaled per instance), box (bounding box in the piece frame), sphere (bounding sphere), mesh = the exact triangles, only for static pieces (active = 0; moving pieces fall back to convex_hull). The collision input is always used as exact triangles' },
  hull_points: { type: 'int', default: 64, min: 0, max: 4096, aliases: ['max_hull_points', 'hull_vertices'], desc: 'convex_hull: most vertices per hull (0 = the exact hull). Collision cost grows with hull size; a smooth piece with more hull vertices is reduced to the ones that matter most, so pieces can sink into each other by a few % of their radius at cut corners' },
  duration: { type: 'float', default: 8, min: 0, max: 120, aliases: ['time', 'seconds'], desc: 'simulated seconds at most; the simulation stops earlier once every piece has settled' },
  steps_per_second: { type: 'int', default: 60, min: 10, max: 1000, aliases: ['steps', 'rate', 'hz'], desc: 'solver steps per simulated second (time step 1 / steps_per_second); raise it for small or fast pieces' },
  gravity: { type: 'vec3', default: [0, -9.81, 0], desc: 'gravity (m/s²)' },
  friction: { type: 'float', default: 0.7, min: 0, max: 2, desc: 'friction coefficient of every collider (pieces, collision geometry, ground)' },
  restitution: { type: 'float', default: 0, min: 0, max: 1, aliases: ['bounce', 'bounciness'], desc: 'bounciness (0 = no bounce, settles fastest)' },
  density: { type: 'float', default: 1000, min: 1, max: 100000, desc: 'density of the pieces (kg/m³); with one density for all pieces only the shapes matter' },
  linear_damping: { type: 'float', default: 0, min: 0, max: 10, advanced: true, desc: 'linear velocity damping (1/s)' },
  angular_damping: { type: 'float', default: 0.5, min: 0, max: 10, desc: 'angular velocity damping (1/s): stops round pieces rolling forever; 0 = free rolling' },
  rest_damping: { type: 'float', default: 5, min: 0, max: 100, desc: 'extra angular damping (linear: 40 % of it) for a piece that has been nearly at rest (below 4 × sleep_threshold) for 0.5 s, so slow wobbling and creeping end; released when the piece speeds up again. 0 = plain physics' },
  sleep_threshold: { type: 'float', default: 0.05, min: 0.0001, max: 10, aliases: ['settle_threshold'], desc: 'a piece counts as settled below this speed (m/s; spin: angular speed × piece radius); the simulation ends when every piece has stayed below it for 0.5 s. Lower it for small pieces' },
  ground_plane: { type: 'enum', options: ['auto', 'on', 'off'], default: 'auto', desc: 'infinite ground at y = ground: auto = only when input 1 (collision geometry) is not connected (a connected input without polygons or heightfields gives nothing to land on, with a warning); on = also with input 1' },
  ground: { type: 'float', default: 0, aliases: ['ground_height'], desc: 'height of the ground plane' },
  ccd: { type: 'bool', default: true, advanced: true, desc: 'continuous collision detection, so fast pieces do not pass through thin collision geometry' },
  solver_iterations: { type: 'int', default: 4, min: 1, max: 32, advanced: true, desc: 'Rapier solver iterations per step (more = stiffer stacks, slower)' },
  max_pieces: { type: 'int', default: 5000, min: 1, max: 1000000, desc: 'guard: fail instead of simulating more pieces than this (1,000 convex pieces take about 1–3 s)' },
  seed: { type: 'int', default: 0, desc: 'seed of the jitter' },
  jitter: { type: 'float', default: 0.001, min: 0, max: 0.1, desc: 'random start offset (fraction of each piece radius, horizontal) and tilt (radians), so perfectly symmetric stacks still topple deterministically; 0 = none' },
  keep_packed: { type: 'bool', default: true, desc: 'packed input stays packed with updated instance transforms (false = unpack the result)' },
  delete_fallen: { type: 'bool', default: false, desc: 'remove pieces that fell off the collision geometry (otherwise they stay where they were stopped, in point group "fallen")' },
  animate: { type: 'bool', default: false, desc: 'false: every frame shows the settled result (the node does not depend on time). true: the frame shows the simulation at (frame - start_frame) / fps seconds, for viewing the drop' },
  start_frame: { type: 'int', default: 1, desc: 'animate: the frame the simulation starts at' },
};

const STACK: Record<string, ParamDef> = {
  interval: { type: 'int', default: 15, min: 1, max: 10000, desc: 'solver steps between two drops (15 at 60 steps/s = four pieces per second)' },
  order: { type: 'enum', options: ['input', 'height', 'random'], default: 'input', desc: 'drop order: input = prim order, height = lowest first (equal heights in the input-independent spatial order), random = seeded shuffle' },
  lift: { type: 'bool', default: true, desc: 'raise each piece above whatever already lies under its drop position (a shape cast from above), so pieces given the same position stack' },
  clearance: { type: 'float', default: 0.02, min: 0, max: 10, desc: 'lift: gap left between a dropped piece and the pile under it (m)' },
};

// Animated cooks resume the world of the previous frame instead of simulating from the start (frame 11 after 10 runs
// only the steps in between). One world per node signature, the last few kept.
const worlds = new Map<string, { sim: RbdSim; scene: RbdScene }>();
const MAX_WORLDS = 2;
function keepWorld(key: string, sim: RbdSim, scene: RbdScene) {
  const old = worlds.get(key);
  if (old && old.sim !== sim) old.sim.free();
  worlds.delete(key);
  worlds.set(key, { sim, scene });
  while (worlds.size > MAX_WORLDS) {
    const [k, v] = worlds.entries().next().value!;
    worlds.delete(k);
    v.sim.free();
  }
}

const OUTPUTS = 'pieces moved to their settled transforms (packed: anchor P and the instance transform; unpacked: P, N, up, orient), ' +
  'point attributes on the moved points (packed: the anchors) v (velocity, m/s), w (angular velocity, rad/s), settled (int 0/1), contacts (int: colliders touching the piece); ' +
  'point group fallen (pieces that fell off the collision geometry); stats steps, sim_time, pieces, settled, fallen';

async function cookRbd(ctx: CookContext, stack: boolean): Promise<Geometry> {
  const { p } = ctx;
  const src = ctx.input(0);
  if (!src.numPrims) return src;
  let scene: RbdScene;
  try {
    scene = collectRbdScene(src, { pieces: p.pieces, pieceAttrib: String(p.piece_attrib ?? ''), shape: p.collision_shape });
  } catch (e: any) {
    throw new NodeError(e?.message ?? String(e), 'pieces: auto | connectivity | name | attrib (with piece_attrib); pack the pieces with pack or copy_to_points {pack: true}');
  }
  for (const n of scene.notes) ctx.warn(n);
  const n = scene.pieces.length;
  if (!n) return src;
  if (n > p.max_pieces) throw new NodeError(`${n} pieces is more than max_pieces (${p.max_pieces})`, 'raise max_pieces (about 1–3 s per 1,000 pieces), or check how the pieces are split (pieces param)');
  const notes: string[] = [];
  const statics = ctx.hasInput(1) ? staticMesh(ctx.input(1), notes) : null;
  for (const m of notes) ctx.warn(m);
  // auto: the ground plane stands in for a collision input that is not connected (R-17 N6: it was also added when the
  // input was connected but had no triangles, unlike the param says)
  const ground = p.ground_plane === 'on' || (p.ground_plane === 'auto' && !ctx.hasInput(1)) ? Number(p.ground) : null;
  if (ctx.hasInput(1) && !statics && ground === null)
    ctx.warn('the collision input (input 1) has no polygons or heightfields: there is nothing to land on (ground_plane auto adds the ground only when input 1 is not connected; set ground_plane on, or disconnect it)');
  const rate = Math.max(1, Math.round(p.steps_per_second));
  const dt = 1 / rate;
  const dynamic = scene.pieces.filter((x) => !x.fixed).length;
  const stackOpts: RbdStackOptions | null = stack ? { interval: Math.max(1, Math.round(p.interval)), lift: !!p.lift, clearance: Math.max(0, p.clearance), order: p.order } : null;
  // drops take (pieces - 1) intervals; duration counts from the last drop
  const dropSteps = stackOpts ? Math.max(0, dynamic - 1) * stackOpts.interval : 0;
  const maxSteps = dropSteps + Math.ceil(Math.max(0, p.duration) * rate - 1e-9);
  const opts: RbdSimOptions = {
    gravity: p.gravity, friction: p.friction, restitution: p.restitution, density: p.density,
    linearDamping: p.linear_damping, angularDamping: p.angular_damping, dt, maxSteps, solverIterations: p.solver_iterations,
    sleepThreshold: p.sleep_threshold, ccd: !!p.ccd, hullPoints: p.hull_points, restDamping: p.rest_damping, ground, seed: p.seed, jitter: p.jitter, stack: stackOpts,
  };
  let R;
  try {
    R = await loadRapier();
  } catch (e: any) {
    throw new NodeError(`could not load the Rapier physics engine: ${e?.message ?? e}`, 'reinstall the package (@dimforge/rapier3d-compat is a dependency)');
  }
  let res;
  if (p.animate) {
    const elapsed = Math.max(0, (ctx.frame - p.start_frame) / ctx.fps);
    const target = Math.min(maxSteps, Math.round(elapsed * rate + 1e-9));
    const key = `${ctx.type}|${ctx.inputSigs.join('|')}|${JSON.stringify(p)}`;
    const cached = worlds.get(key);
    let sim: RbdSim;
    if (cached && cached.sim.step <= target) ({ sim, scene } = cached);
    else sim = new RbdSim(R, scene, statics, opts);
    keepWorld(key, sim, scene);
    sim.advance(target);
    res = sim.read();
  } else {
    const sim = new RbdSim(R, scene, statics, opts);
    try {
      sim.advance(maxSteps);
      res = sim.read();
    } finally {
      sim.free();
    }
  }
  let out = applyRbd(scene, res, { deleteFallen: !!p.delete_fallen, hideUnspawned: !!p.animate && stack });
  if (!p.keep_packed && out.hasPacked()) out = expandPacked(out, { transfer: `${DEFAULT_TRANSFER} v w settled contacts` }).geo;
  let settled = 0, fallen = 0, moving = 0;
  scene.pieces.forEach((piece, k) => {
    if (res.fallen[k]) fallen++;
    else if (res.settled[k]) settled++;
    else if (!piece.fixed && res.spawned[k]) moving++;
  });
  ctx.stat('pieces', n);
  ctx.stat('steps', res.steps);
  ctx.stat('sim_time', +(res.steps * dt).toFixed(4));
  ctx.stat('settled', settled);
  ctx.stat('fallen', fallen);
  if (res.startOverlaps) ctx.warn(`${res.startOverlaps} piece${res.startOverlaps === 1 ? '' : 's'} started inside another piece or the collision geometry and ${res.startOverlaps === 1 ? 'was' : 'were'} pushed out; space the pieces, raise them, or use rbd_stack`);
  if (fallen) ctx.warn(`${fallen} piece${fallen === 1 ? '' : 's'} fell off the collision geometry (point group "fallen"${p.delete_fallen ? ', deleted' : '; delete_fallen removes them'})`);
  if (moving && res.reason === 'steps') ctx.warn(`${moving} of ${n} pieces still moving after ${(res.steps * dt).toFixed(2)} s; raise duration or angular_damping`);
  return out;
}

defineNode({
  type: 'rbd_settle',
  category: 'sim',
  summary: 'Drop pieces (packed instances or polygon pieces) onto a terrain, container or ground plane and let them come to rest (Houdini RBD drop / settle), with the Rapier physics engine.',
  aliases: ['rbd', 'rigid_body', 'rigidbody', 'settle', 'drop', 'rbd_drop', 'physics_settle', 'rbdbulletsolver'],
  description:
    'For procedural assembly: scatter pieces above a surface, settle them, and they rest in contact instead of floating or intersecting. ' +
    'Input 0 = the pieces: every packed prim (copy_to_points {pack: true}, pack) is one piece whose convex hull is computed once per source and ' +
    'shared by all its instances; polygons are grouped into pieces by the pieces param. Input 1 = static collision geometry (terrain mesh, ' +
    'heightfield, container; exact triangles; packed input is unpacked); without it a ground plane at y = ground. Pieces with a prim or point ' +
    'attribute active = 0 stay put and others collide with them (active defaults to 1, so geometry merged without it moves); point (or prim) ' +
    'attributes v (m/s) and w (rad/s) give initial velocities. ' +
    'The output is the input with each piece moved rigidly (packed input stays packed: only anchors and instance transforms change), plus v, w, ' +
    'settled and contacts on the moved points. Pieces must not start inside each other (they are pushed apart violently; a warning says how many ' +
    'did): space them, or use rbd_stack, which drops them one at a time. Same inputs and seed give the same result (Rapier\'s WASM build is ' +
    'deterministic; bodies are inserted in a spatial order, so the input order does not matter). By default the node ignores time and shows the ' +
    'settled state on every frame; animate shows the fall frame by frame (cooking frame 11 after 10 resumes the simulation).',
  inputs: [
    { name: 'pieces', desc: 'pieces to drop: packed instances and/or polygon pieces' },
    { name: 'collision', desc: 'static collision geometry (polygons and heightfields); none = ground plane', optional: true },
  ],
  params: { ...COMMON },
  packed: 'keep',
  splines: 'polyline',
  outputs: OUTPUTS,
  example: {
    nodes: {
      rock: { type: 'sphere', params: { type: 'ico', level: 1, radius: 0.25, scale: [1, 0.6, 0.85] } },
      rock_shape: { type: 'noise_displace', in: ['rock'], params: { amplitude: 0.06, frequency: 3 } },
      spots: { type: 'point_grid', params: { counts: [4, 1, 4], size: [3, 0, 3], center: [0, 2, 0] } },
      spin: { type: 'attrib_randomize', in: ['spots'], params: { name: 'orient', distribution: 'orient', seed: 3 } },
      rocks: { type: 'copy_to_points', in: ['rock_shape', 'spin'], params: { pack: true } },
      ground: { type: 'terrain', params: { size: [6, 6], divisions: [24, 24], height: 0.6, frequency: 0.3, seed: 2 } },
      settle: { type: 'rbd_settle', in: ['rocks', 'ground'] },
    },
    output: 'settle',
  },
  cook: (ctx) => cookRbd(ctx, false),
});

defineNode({
  type: 'rbd_stack',
  category: 'sim',
  summary: 'Drop pieces one at a time (every interval steps), each lifted above what already lies under it, so crates stack and rocks pile up instead of starting inside each other.',
  aliases: ['rbd_pile', 'stack_pieces', 'pile', 'rbd_fill'],
  description:
    'rbd_settle for pieces that overlap where they are: give every crate the same position (or a few spawn points) and they come down one after ' +
    'another onto the pile. Each piece keeps its input X/Z and rotation; with lift its drop height is raised until it clears whatever is under it ' +
    '(a downward shape cast through the pieces already dropped and the collision geometry), plus clearance. Pieces drop in the order param\'s order, ' +
    'one every interval steps; duration counts from the last drop. Same inputs, outputs and parameters as rbd_settle (see there); with animate, ' +
    'pieces that have not dropped yet are not in the output.',
  inputs: [
    { name: 'pieces', desc: 'pieces to drop: packed instances and/or polygon pieces, possibly overlapping' },
    { name: 'collision', desc: 'static collision geometry (polygons and heightfields); none = ground plane', optional: true },
  ],
  params: { ...STACK, ...COMMON },
  packed: 'keep',
  splines: 'polyline',
  outputs: OUTPUTS,
  example: {
    nodes: {
      crate: { type: 'box', params: { size: [0.5, 0.4, 0.4] } },
      spots: { type: 'point_grid', params: { counts: [2, 1, 1], size: [0.3, 0, 0] } },
      many: { type: 'copy_xform', in: ['spots'], params: { count: 5, translate: [0, 0, 0.05] } },
      crates: { type: 'copy_to_points', in: ['crate', 'many'], params: { pack: true } },
      pile: { type: 'rbd_stack', in: ['crates'], params: { interval: 10, duration: 3 } },
    },
    output: 'pile',
  },
  cook: (ctx) => cookRbd(ctx, true),
});
