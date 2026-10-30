// Rigid-body settling: rbd_settle and rbd_stack on Rapier.
//   node test/rbd.ts            (add --perf for the 1,000-piece timing only)
// Pieces end up resting: above the ground or terrain, not inside each other (checked here on exact convex hulls,
// independently of Rapier's contacts), settled, touching something. Deterministic across cooks, engines and the
// worker pool; independent of the input order; packed and unpacked input; static pieces, initial velocities,
// heightfield collision, fallen pieces, ground_plane auto, animate (frames resume), the max_pieces guard, stacking, and the 1,000-piece
// timing (target 3 s, reported; fails only beyond a generous limit because the machine may be loaded).
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { Geometry } from '../src/core/geometry.ts';
import { expandPacked } from '../src/core/packed.ts';
import { TriBVH } from '../src/core/spatial.ts';
import { loadRapier } from '../src/wasm/rapier.ts';
import type { GraphSpec, NodeSpec } from '../src/graph/types.ts';
import { openPackages } from '../src/packages/registry.ts';
import { checkGeo, useBuiltin } from './fixtures.ts';

const perfOnly = process.argv.includes('--perf');
let fail = 0, pass = 0;
const check = (ok: any, msg: string) => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
};
const engine = new Engine(createNodeHost({ baseDir: '.', workers: 0 }));
await engine.init();
// the rocks are TopoTopo's own (topotopo/nature/rock): one package that uses them, for every engine here
const builtin = useBuiltin(engine).dir!;
const R = await loadRapier();

async function cook(nodes: Record<string, NodeSpec>, output: string, e = engine, frame?: number) {
  const r = await e.cook({ nodes, output } as GraphSpec, frame !== undefined ? { frame } : {});
  if (!r.ok || !r.geo) throw new Error(`cook failed: ${r.errors.map((x) => `[${x.node}] ${x.message}`).join('; ')}`);
  return { geo: r.geo, warnings: r.warnings.filter((w) => w.node === output).map((w) => w.message), stats: r.results.get(output)?.stats ?? {} };
}
const same = (a: ArrayLike<number> | undefined, b: ArrayLike<number> | undefined) => {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
};
const ints = (g: Geometry, name: string) => Array.from((g.points.get(name)?.data as Int32Array) ?? []);

// ------------------------------------------------------------------ independent geometry checks

interface Hull { V: Float64Array; planes: Float64Array; lo: number[]; hi: number[]; radius: number }

/** The exact convex hull of every piece of a settled result (packed: per instance; unpacked: per prim attribute). */
function pieceHulls(g: Geometry, pieceAttr = 'piece'): Hull[] {
  const flat = g.hasPacked() ? expandPacked(g, { pieceAttrib: pieceAttr }).geo : g;
  const key = flat.prims.get(pieceAttr) ?? flat.prims.get('copynum');
  const groups = new Map<number, Set<number>>();
  for (let p = 0; p < flat.numPrims; p++) {
    const k = key ? (key.data as Int32Array)[p] : 0;
    let s = groups.get(k);
    if (!s) groups.set(k, (s = new Set()));
    for (let v = flat.primStart[p]; v < flat.primStart[p + 1]; v++) s.add(flat.vertexPoint[v]);
  }
  const world = new R.World({ x: 0, y: 0, z: 0 });
  const hulls: Hull[] = [];
  for (const pts of groups.values()) {
    const P = new Float32Array(pts.size * 3);
    let i = 0;
    for (const pt of pts) { P[i++] = flat.P[pt * 3]; P[i++] = flat.P[pt * 3 + 1]; P[i++] = flat.P[pt * 3 + 2]; }
    // hull of points relative to their centre (float32 precision), back to world
    const c = [0, 0, 0];
    for (let k = 0; k < P.length; k += 3) { c[0] += P[k]; c[1] += P[k + 1]; c[2] += P[k + 2]; }
    for (let a = 0; a < 3; a++) c[a] /= pts.size;
    const L = new Float32Array(P.length);
    for (let k = 0; k < P.length; k += 3) { L[k] = P[k] - c[0]; L[k + 1] = P[k + 1] - c[1]; L[k + 2] = P[k + 2] - c[2]; }
    const col = world.createCollider(R.ColliderDesc.convexHull(L)!);
    const HV = col.vertices(), HI = col.indices()!;
    const V = new Float64Array(HV.length);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    let radius = 0;
    for (let k = 0; k < HV.length; k += 3) {
      for (let a = 0; a < 3; a++) { V[k + a] = HV[k + a] + c[a]; lo[a] = Math.min(lo[a], V[k + a]); hi[a] = Math.max(hi[a], V[k + a]); }
      radius = Math.max(radius, Math.hypot(HV[k], HV[k + 1], HV[k + 2]));
    }
    const nf = HI.length / 3, planes = new Float64Array(nf * 4);
    for (let f = 0; f < nf; f++) {
      const a = HI[f * 3] * 3, b = HI[f * 3 + 1] * 3, d = HI[f * 3 + 2] * 3;
      const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2], vx = V[d] - V[a], vy = V[d + 1] - V[a + 1], vz = V[d + 2] - V[a + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      planes.set([nx, ny, nz, nx * V[a] + ny * V[a + 1] + nz * V[a + 2]], f * 4);
    }
    hulls.push({ V, planes, lo, hi, radius });
  }
  world.free();
  return hulls;
}

/** How deep the vertices of a reach into b (0 = none): the largest min-distance inside b's face planes. */
function depthInto(a: Hull, b: Hull): number {
  let worst = 0;
  for (let k = 0; k < a.V.length; k += 3) {
    let inside = Infinity;
    for (let f = 0; f < b.planes.length; f += 4) {
      const d = b.planes[f + 3] - (b.planes[f] * a.V[k] + b.planes[f + 1] * a.V[k + 1] + b.planes[f + 2] * a.V[k + 2]);
      if (d < inside) inside = d;
      if (inside <= 0) break;
    }
    if (inside > worst) worst = inside;
  }
  return worst;
}

/** Deepest vertex penetration between any two pieces, relative to the smaller piece's radius. */
function worstOverlap(hulls: Hull[]): { depth: number; rel: number } {
  let depth = 0, rel = 0;
  for (let i = 0; i < hulls.length; i++)
    for (let j = i + 1; j < hulls.length; j++) {
      const a = hulls[i], b = hulls[j];
      if (a.hi[0] < b.lo[0] || b.hi[0] < a.lo[0] || a.hi[1] < b.lo[1] || b.hi[1] < a.lo[1] || a.hi[2] < b.lo[2] || b.hi[2] < a.lo[2]) continue;
      const d = Math.max(depthInto(a, b), depthInto(b, a));
      if (d > depth) depth = d;
      const r = d / Math.min(a.radius, b.radius);
      if (r > rel) rel = r;
    }
  return { depth, rel };
}

/** Largest distance a hull vertex lies below the surface (ground plane height, or a mesh hit by a ray from above). */
function worstBelow(hulls: Hull[], ground: number | TriBVH, relative = false): number {
  let worst = 0;
  for (const h of hulls)
    for (let k = 0; k < h.V.length; k += 3) {
      let y: number;
      if (typeof ground === 'number') y = ground;
      else {
        const hit = ground.raycast(h.V[k], 1e3, h.V[k + 2], 0, -1, 0);
        if (!hit) continue;
        y = hit.pos[1];
      }
      worst = Math.max(worst, (y - h.V[k + 1]) / (relative ? h.radius : 1));
    }
  return worst;
}

// ------------------------------------------------------------------ scenes

const ROCKS = (n: number, extra: Record<string, any> = {}, spread = 1.6): Record<string, NodeSpec> => {
  const side = Math.ceil(Math.sqrt(n));
  return {
    rock: { type: 'topotopo/nature/rock', params: { seed: 4, size: 0.8 } },
    grid: { type: 'point_grid', params: { counts: [side, 1, side], size: [(side - 1) * spread, 0, (side - 1) * spread], center: [0, 1.2, 0] } },
    some: { type: 'delete', in: ['grid'], params: { class: 'point', group: `${n}-1000000` } },
    lift: { type: 'wrangle', in: ['some'], params: { code: '@P.y += rand(@ptnum, 5) * 0.8;\n@pscale = 0.6 + rand(@ptnum, 6) * 0.6;' } },
    spin: { type: 'attrib_randomize', in: ['lift'], params: { name: 'orient', distribution: 'orient', seed: 2 } },
    pieces: { type: 'copy_to_points', in: ['rock', 'spin'], params: { pack: true } },
    settle: { type: 'rbd_settle', in: ['pieces'], params: { ...extra } },
  };
};

if (!perfOnly) {
  // ---------------------------------------------------------------- resting on the ground plane, exact hulls
  {
    const r = await cook(ROCKS(36, { hull_points: 0 }), 'settle');
    const g = r.geo;
    check(!checkGeo(g).length && g.numPacked === 36, `36 packed rocks settle and stay packed (${g.numPacked} instances)`);
    check(ints(g, 'settled').every((x) => x === 1), `every rock settled (${r.stats.steps} steps, ${r.stats.sim_time} s simulated)`);
    check(ints(g, 'contacts').every((x) => x >= 1), `every rock touches something (contacts ${Math.min(...ints(g, 'contacts'))}..${Math.max(...ints(g, 'contacts'))})`);
    const hulls = pieceHulls(g);
    const below = worstBelow(hulls, 0);
    check(below < 0.005, `no rock below the ground plane by more than 5 mm (worst ${(below * 1000).toFixed(2)} mm)`);
    const ov = worstOverlap(hulls);
    check(ov.depth < 0.01, `no two rocks overlap by more than 1 cm (worst ${(ov.depth * 1000).toFixed(2)} mm, ${(ov.rel * 100).toFixed(2)} % of a radius)`);
    const v = g.points.get('v')!.data as Float64Array;
    let vmax = 0;
    for (let i = 0; i < v.length; i += 3) vmax = Math.max(vmax, Math.hypot(v[i], v[i + 1], v[i + 2]));
    check(vmax < 0.06, `final speeds are near zero (max ${vmax.toFixed(4)} m/s)`);
    check(r.warnings.length === 0, `no warnings (${r.warnings.join(' | ')})`);
  }
  // reduced hulls (the default): pieces may sink in by a few % of their radius at most (6 % allowed)
  {
    const g = (await cook(ROCKS(36), 'settle')).geo;
    const hulls = pieceHulls(g);
    const below = worstBelow(hulls, 0), rel = worstBelow(hulls, 0, true), ov = worstOverlap(hulls);
    check(rel < 0.06 && ov.rel < 0.1, `hull_points 64 (the default): rocks sink into the ground by at most ${(rel * 100).toFixed(1)} % of their radius (limit 6 %) (${(below * 1000).toFixed(1)} mm) and into each other by ${(ov.rel * 100).toFixed(1)} %`);
  }

  // ---------------------------------------------------------------- terrain (input 1), heightfield (input 1)
  {
    const nodes: Record<string, NodeSpec> = {
      ...ROCKS(25, {}, 1.3),
      terrain: { type: 'terrain', params: { size: [12, 12], divisions: [48, 48], height: 0.8, frequency: 0.15, seed: 4 } },
    };
    nodes.onto = { type: 'ray', in: ['spin', 'terrain'], params: { direction: [0, -1, 0] } } as NodeSpec;
    nodes.up = { type: 'transform', in: ['onto'], params: { translate: [0, 1, 0] } };
    nodes.pieces = { type: 'copy_to_points', in: ['rock', 'up'], params: { pack: true } };
    nodes.settle = { type: 'rbd_settle', in: ['pieces', 'terrain'], params: { hull_points: 0 } };
    const r = await cook(nodes, 'settle');
    const terrain = (await cook(nodes, 'terrain')).geo;
    const hulls = pieceHulls(r.geo);
    const below = worstBelow(hulls, new TriBVH(terrain));
    check(hulls.length === 25 && below < 0.005, `25 rocks dropped onto a terrain mesh rest on it (deepest vertex ${(below * 1000).toFixed(2)} mm below the surface)`);
    check(ints(r.geo, 'settled').every((x) => x === 1) && !r.geo.pointGroups.has('fallen'), `all settled, none fell (${r.stats.steps} steps)`);
    check(worstOverlap(hulls).depth < 0.01, 'no two rocks overlap on the terrain');
    // the same terrain as a heightfield volume
    nodes.hf = { type: 'heightfield_from_mesh', in: ['terrain'], params: { resolution: 0.25 } };
    nodes.settle_hf = { type: 'rbd_settle', in: ['pieces', 'hf'], params: { hull_points: 0 } };
    nodes.hf_mesh = { type: 'heightfield_to_mesh', in: ['hf'] };
    const h = await cook(nodes, 'settle_hf');
    const hfMesh = (await cook(nodes, 'hf_mesh')).geo;
    const belowHf = worstBelow(pieceHulls(h.geo), new TriBVH(hfMesh));
    check(belowHf < 0.005 && ints(h.geo, 'settled').every((x) => x === 1), `rocks on a heightfield rest on its surface (deepest ${(belowHf * 1000).toFixed(2)} mm below)`);
  }

  // ---------------------------------------------------------------- determinism: cooks, engines, pool on/off
  {
    const nodes = ROCKS(30);
    const a = (await cook(nodes, 'settle')).geo;
    const e2 = new Engine(createNodeHost({ baseDir: '.', workers: 0 }));
    await e2.init();
    openPackages(e2, builtin);
    await cook({ x: { type: 'rbd_stack', in: ['y'] }, y: { type: 'copy_xform', in: ['z'], params: { count: 4, translate: [0, 0, 0] } }, z: { type: 'box' } }, 'x', e2);
    const b = (await cook(nodes, 'settle', e2)).geo;
    check(same(a.P, b.P) && same(a.packedXform, b.packedXform), 'two cooks in two engines (another simulation in between) are bit-identical');
    const pooled = new Engine(createNodeHost({ baseDir: '.', workers: 3, pool: { minElements: 1 } }));
    await pooled.init();
    openPackages(pooled, builtin);
    const c = (await cook(nodes, 'settle', pooled)).geo;
    check(same(a.P, c.P) && same(a.packedXform, c.packedXform), 'pool on (3 workers, every kernel forced onto it) gives the same bits as pool off');
    await pooled.host.pool?.close();
    const s1 = (await cook({ ...nodes, settle: { type: 'rbd_settle', in: ['pieces'], params: { seed: 1 } } }, 'settle')).geo;
    check(!same(a.P, s1.P), 'another seed jitters differently');
  }

  // ---------------------------------------------------------------- input order, packed vs unpacked, keep_packed
  {
    const base: Record<string, NodeSpec> = {
      crate: { type: 'box', params: { size: [0.5, 0.4, 0.4] } },
      grid: { type: 'point_grid', params: { counts: [6, 1, 4], size: [3.5, 0, 2.1], center: [0, 1, 0] } },
      copies: { type: 'copy_to_points', in: ['crate', 'grid'] },
      packed: { type: 'copy_to_points', in: ['crate', 'grid'], params: { pack: true } },
      rev: { type: 'sort', in: ['copies'], params: { class: 'prim', by: 'reverse' } },
      a: { type: 'rbd_settle', in: ['copies'], params: { jitter: 0 } },
      b: { type: 'rbd_settle', in: ['rev'], params: { jitter: 0 } },
      p: { type: 'rbd_settle', in: ['packed'], params: { jitter: 0 } },
      pu: { type: 'rbd_settle', in: ['packed'], params: { jitter: 0, keep_packed: false } },
    };
    const a = (await cook(base, 'a')).geo, b = (await cook(base, 'b')).geo;
    // compare per piece: copynum keeps the piece identity through the reversal
    const centres = (g: Geometry) => {
      const m = new Map<number, number[]>();
      const cn = g.prims.get('copynum')!.data as Int32Array;
      for (let p = 0; p < g.numPrims; p++) {
        const c = m.get(cn[p]) ?? [0, 0, 0, 0];
        for (let v = g.primStart[p]; v < g.primStart[p + 1]; v++) { const pt = g.vertexPoint[v]; c[0] += g.P[pt * 3]; c[1] += g.P[pt * 3 + 1]; c[2] += g.P[pt * 3 + 2]; c[3]++; }
        m.set(cn[p], c);
      }
      return [...m.entries()].sort((x, y) => x[0] - y[0]).map(([, c]) => [c[0] / c[3], c[1] / c[3], c[2] / c[3]]);
    };
    const ca = centres(a), cb = centres(b);
    let dmax = ca.length === cb.length ? 0 : Infinity;
    for (let i = 0; i < ca.length && i < cb.length; i++) for (let k = 0; k < 3; k++) dmax = Math.max(dmax, Math.abs(ca[i][k] - cb[i][k]));
    check(ca.length === 24 && dmax < 1e-9, `reversing the input prim and point order gives the same settled pieces (bodies in spatial order, hull points sorted; largest difference ${dmax.toExponential(1)})`);
    const hulls = pieceHulls(a, 'copynum');
    check(hulls.length === 24 && worstBelow(hulls, 0) < 0.005 && worstOverlap(hulls).depth < 0.01, `24 unpacked crates (pieces by copynum) rest on the ground without overlapping`);
    const p = (await cook(base, 'p')).geo;
    const cp = pieceHulls(p).map((h) => [(h.lo[0] + h.hi[0]) / 2, (h.lo[1] + h.hi[1]) / 2, (h.lo[2] + h.hi[2]) / 2]);
    const ua = pieceHulls(a, 'copynum').map((h) => [(h.lo[0] + h.hi[0]) / 2, (h.lo[1] + h.hi[1]) / 2, (h.lo[2] + h.hi[2]) / 2]);
    let d = 0;
    for (let i = 0; i < cp.length; i++) d = Math.max(d, Math.hypot(cp[i][0] - ua[i][0], cp[i][1] - ua[i][1], cp[i][2] - ua[i][2]));
    check(p.numPacked === 24 && d < 1e-4, `packed and unpacked crates settle to the same places (largest difference ${(d * 1000).toFixed(4)} mm)`);
    const pu = (await cook(base, 'pu')).geo;
    const ex = expandPacked(p).geo;
    check(!pu.hasPacked() && pu.numPrims === ex.numPrims && same(pu.P, ex.P), 'keep_packed false returns the unpacked result');
  }
  {
    // Pieces at the same position were ordered by input index, so permuting coincident pieces of different
    // shapes changed the result (bodies and jitter follow that order). Ties now go by a hash of the piece's content.
    const tag = (n: number) => ({ type: 'attrib_create', params: { name: 'tag', class: 'prim', type: 'int', value: n } });
    const nodes: Record<string, NodeSpec> = {
      a: { type: 'box', params: { size: [0.4, 0.4, 0.4], center: [0, 0.6, 0] } },
      b: { type: 'box', params: { size: [0.7, 0.2, 0.3], center: [0, 0.6, 0] } },
      c: { type: 'sphere', params: { type: 'ico', level: 1, radius: 0.25, center: [0, 0.6, 0] } },
      d: { type: 'tube', params: { radius: 0.15, height: 0.5, center: [0, 0.6, 0], cols: 12 } },
      ta: { ...tag(1), in: ['a'] }, tb: { ...tag(2), in: ['b'] }, tc: { ...tag(3), in: ['c'] }, td: { ...tag(4), in: ['d'] },
      m: { type: 'merge', in: ['ta', 'tb', 'tc', 'td'] },
      r: { type: 'sort', in: ['m'], params: { class: 'prim', by: 'reverse' } },
      r2: { type: 'merge', in: ['tc', 'ta', 'td', 'tb'] },
    };
    const perTag = (g: Geometry) => {
      const t = g.prims.get('tag')!.data as Int32Array, s = new Map<number, number[]>();
      for (let p = 0; p < g.numPrims; p++) {
        const c = s.get(t[p]) ?? [0, 0, 0, 0];
        for (let v = g.primStart[p]; v < g.primStart[p + 1]; v++) { const pt = g.vertexPoint[v]; c[0] += g.P[pt * 3]; c[1] += g.P[pt * 3 + 1]; c[2] += g.P[pt * 3 + 2]; c[3]++; }
        s.set(t[p], c);
      }
      return [...s.entries()].sort((x, y) => x[0] - y[0]).map(([, c]) => c);
    };
    for (const [type, params] of [['rbd_settle', {}], ['rbd_stack', { order: 'height', interval: 20 }], ['rbd_stack', { order: 'random', interval: 20 }]] as const) {
      const run = (input: string) => cook({ ...nodes, s: { type, in: [input], params: { pieces: 'attrib', piece_attrib: 'tag', duration: 4, ...params } } }, 's');
      const [x, y, z] = [await run('m'), await run('r'), await run('r2')];
      const px = perTag(x.geo), py = perTag(y.geo), pz = perTag(z.geo);
      // (centroids summed in point order, which the permutation changes: compared to 1e-9 m)
      let dmax = px.length === py.length && px.length === pz.length ? 0 : Infinity;
      for (let i = 0; i < px.length && dmax < Infinity; i++) for (let k = 0; k < 3; k++) dmax = Math.max(dmax, Math.abs(px[i][k] / px[i][3] - py[i][k] / py[i][3]), Math.abs(px[i][k] / px[i][3] - pz[i][k] / pz[i][3]));
      check(px.length === 4 && dmax < 1e-9, `${type}${'order' in params ? ` order ${params.order}` : ''}: four coincident pieces of different shapes settle the same in any input order (largest difference ${dmax.toExponential(1)} m)`);
    }
  }

  // ---------------------------------------------------------------- pieces: name, connectivity, shared points, static, velocity
  {
    // two quads sharing an edge, named differently: split into two pieces that move apart
    const nodes: Record<string, NodeSpec> = {
      quads: { type: 'grid', params: { size: [2, 1], divisions: [2, 1], center: [0, 1, 0] } },
      thick: { type: 'wrangle', in: ['quads'], params: { run_over: 'prims', code: "s@name = @primnum == 0 ? 'a' : 'b';" } },
      s: { type: 'rbd_settle', in: ['thick'], params: { pieces: 'name' } },
    };
    let ok = true, msg = '';
    try {
      const r = await cook(nodes, 's');
      const t = (await cook(nodes, 'thick')).geo;
      msg = `${t.numPoints} → ${r.geo.numPoints} points`;
      ok = r.geo.numPoints > t.numPoints && ints(r.geo, 'settled').every((x) => x === 1);
    } catch (e: any) { ok = false; msg = e.message; }
    check(ok, `pieces by name split points the pieces share (${msg})`);
    const c = await cook({ ...nodes, s: { type: 'rbd_settle', in: ['thick'], params: { pieces: 'connectivity' } } }, 's').catch((e) => ({ geo: null, warnings: [e.message], stats: {} as any }));
    check(c.geo && c.stats.pieces === 1, `pieces by connectivity keeps them together (${c.stats.pieces} piece)`);
    const bad = await engine.cook({ nodes: { ...nodes, s: { type: 'rbd_settle', in: ['thick'], params: { pieces: 'attrib', piece_attrib: 'nope' } } }, output: 's' });
    check(!bad.ok && /no prim attribute "nope"/.test(bad.errors[0]?.message ?? ''), `a missing piece attribute is a node error (${bad.errors[0]?.message})`);
  }
  {
    // a static table (active = 0) in input 0 holds a crate; a crate thrown sideways (v) lands further away
    const nodes: Record<string, NodeSpec> = {
      table: { type: 'box', params: { size: [2, 0.2, 2], center: [0, 1, 0] } },
      fixed: { type: 'attrib_create', in: ['table'], params: { name: 'active', class: 'prim', type: 'int', value: 0 } },
      crate: { type: 'box', params: { size: [0.4, 0.4, 0.4], center: [0, 1.6, 0] } },
      thrown: { type: 'box', params: { size: [0.4, 0.4, 0.4], center: [5, 1.6, 0] } },
      vel: { type: 'attrib_create', in: ['thrown'], params: { name: 'v', class: 'point', value: [3, 0, 0] } },
      all: { type: 'merge', in: ['fixed', 'crate', 'vel'] },
      s: { type: 'rbd_settle', in: ['all'], params: { pieces: 'connectivity', jitter: 0 } },
    };
    const r = await cook(nodes, 's');
    const g = r.geo, bb = (lo: number, hi: number) => {
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let p = lo; p < hi; p++) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], g.P[p * 3 + a]); max[a] = Math.max(max[a], g.P[p * 3 + a]); }
      return { min, max };
    };
    const t = bb(0, 8), c = bb(8, 16), th = bb(16, 24);
    check(Math.abs(t.max[1] - 1.1) < 1e-9 && Math.abs(t.min[0] + 1) < 1e-9, 'the static table (active = 0) does not move');
    check(Math.abs(c.min[1] - 1.1) < 0.005, `the crate rests on the table (bottom at ${c.min[1].toFixed(4)}, table top 1.1)`);
    check(th.min[0] > 6.5 && Math.abs(th.min[1]) < 0.005, `the crate with v = (3, 0, 0) slid away along +x and rests on the ground (x from ${th.min[0].toFixed(2)})`);
  }

  // ---------------------------------------------------------------- fallen pieces, overlap warning, guard
  {
    const nodes: Record<string, NodeSpec> = {
      ledge: { type: 'box', params: { size: [2, 0.2, 2] } },
      a: { type: 'box', params: { size: [0.3, 0.3, 0.3], center: [0, 1, 0] } },
      b: { type: 'box', params: { size: [0.3, 0.3, 0.3], center: [4, 1, 0] } },
      ab: { type: 'merge', in: ['a', 'b'] },
      keep: { type: 'rbd_settle', in: ['ab', 'ledge'], params: { duration: 4 } },
      del: { type: 'rbd_settle', in: ['ab', 'ledge'], params: { duration: 4, delete_fallen: true } },
    };
    const k = await cook(nodes, 'keep');
    const f = k.geo.pointGroups.get('fallen');
    check(!!f && f.reduce((s, x) => s + x, 0) === 8 && k.warnings.some((w) => /1 piece fell off/.test(w)), `a piece beside the ledge falls: group "fallen" and a warning (${k.warnings.join(' | ')})`);
    const d = await cook(nodes, 'del');
    check(d.geo.numPrims === 6 && d.stats.fallen === 1, `delete_fallen removes it (${d.geo.numPrims} prims left)`);
    const o = await cook({ a: nodes.a, a2: { type: 'box', params: { size: [0.3, 0.3, 0.3], center: [0.1, 1.05, 0] } }, m: { type: 'merge', in: ['a', 'a2'] }, s: { type: 'rbd_settle', in: ['m'] } }, 's');
    check(o.warnings.some((w) => /started inside/.test(w)), `pieces that start inside each other are reported (${o.warnings.join(' | ')})`);
    const many = await engine.cook({ nodes: { ...ROCKS(12, { max_pieces: 5 }) }, output: 'settle' });
    check(!many.ok && /12 pieces is more than max_pieces \(5\)/.test(many.errors[0]?.message ?? ''), `max_pieces guards the cook (${many.errors[0]?.message})`);
    // ground_plane auto adds the ground only when input 1 is not connected (as the param says); a connected
    // input without triangles (points only here) leaves nothing to land on, with a warning; on adds the ground anyway
    const pts = { type: 'points', params: { positions: [[0, 0, 0], [1, 0, 0]] } };
    const none = await cook({ a: nodes.a, pts, s: { type: 'rbd_settle', in: ['a', 'pts'], params: { duration: 3 } } }, 's');
    check(none.stats.fallen === 1 && none.warnings.some((w) => /input 1\) has no polygons or heightfields: there is nothing to land on/.test(w)),
      `auto with a connected input without triangles: no ground, the piece falls (${none.stats.fallen} fallen) and a warning says why`);
    const on = await cook({ a: nodes.a, pts, s: { type: 'rbd_settle', in: ['a', 'pts'], params: { duration: 3, ground_plane: 'on' } } }, 's');
    check(on.stats.fallen === 0 && on.stats.settled === 1 && Math.abs(on.geo.bbox().min[1]) < 0.01 && !on.warnings.some((w) => /nothing to land on/.test(w)),
      `ground_plane on: the piece rests on the ground (lowest point ${on.geo.bbox().min[1].toFixed(4)} m)`);
    const off = await cook({ a: nodes.a, s: { type: 'rbd_settle', in: ['a'], params: { duration: 3 } } }, 's');
    check(off.stats.settled === 1 && Math.abs(off.geo.bbox().min[1]) < 0.01, 'auto without input 1: the ground plane');
  }

  // ---------------------------------------------------------------- rbd_stack: a pile keeps every crate
  {
    const nodes: Record<string, NodeSpec> = {
      crate: { type: 'box', params: { size: [0.6, 0.4, 0.5], center: [0, 0.2, 0] } },
      spot: { type: 'points', params: { positions: [[0, 0, 0]] } },
      many: { type: 'copy_xform', in: ['spot'], params: { count: 12, translate: [0, 0, 0] } },
      spread: { type: 'jitter', in: ['many'], params: { scale: [0.35, 0, 0.35], seed: 2 } },
      turned: { type: 'orient', in: ['spread'], params: { mode: 'direction', align_axis: 'y', direction: [0, 0, 1], random_yaw: [0, 360], seed: 3 } },
      crates: { type: 'copy_to_points', in: ['crate', 'turned'], params: { pack: true } },
      pile: { type: 'rbd_stack', in: ['crates'], params: { interval: 20 } },
    };
    const r = await cook(nodes, 'pile');
    const g = r.geo;
    const hulls = pieceHulls(g);
    const top = Math.max(...hulls.map((h) => h.hi[1]));
    let far = 0;
    for (const h of hulls) far = Math.max(far, Math.hypot((h.lo[0] + h.hi[0]) / 2, (h.lo[2] + h.hi[2]) / 2));
    check(g.numPacked === 12 && hulls.length === 12 && !g.pointGroups.has('fallen'), 'rbd_stack keeps all 12 crates (none fell)');
    check(ints(g, 'settled').every((x) => x === 1), `every crate settled (${r.stats.steps} steps)`);
    check(top > 0.8, `the crates pile up (top at ${top.toFixed(2)} m, two crates are 0.8 m)`);
    check(far < 2.5, `the pile stays together (farthest crate ${far.toFixed(2)} m from the drop spot)`);
    const ov = worstOverlap(hulls);
    check(ov.depth < 0.01 && worstBelow(hulls, 0) < 0.005, `no crate inside another or the ground (worst overlap ${(ov.depth * 1000).toFixed(2)} mm)`);
    // without lift every crate starts inside the previous ones
    const nolift = await cook({ ...nodes, pile: { type: 'rbd_stack', in: ['crates'], params: { interval: 20, lift: false } } }, 'pile');
    check(nolift.geo.numPacked === 12, 'lift off still cooks');
  }

  // ---------------------------------------------------------------- animate: frames, resume, the end equals the settled cook
  {
    const nodes = ROCKS(9, { duration: 3, animate: true });
    const settled = (await cook({ ...nodes, settle: { type: 'rbd_settle', in: ['pieces'], params: { duration: 3 } } }, 'settle')).geo;
    const input = (await cook(nodes, 'pieces')).geo;
    const f1 = (await cook(nodes, 'settle', engine, 1)).geo;
    let moved = 0;
    for (let i = 0; i < input.P.length; i++) moved = Math.max(moved, Math.abs(input.P[i] - f1.P[i]));
    check(moved < 0.01, `frame 1 shows the start (largest offset ${moved.toExponential(1)} m: the jitter)`);
    const f12a = (await cook(nodes, 'settle', engine, 12)).geo;
    const f30 = (await cook(nodes, 'settle', engine, 30)).geo; // resumes the world of frame 12
    const fresh = new Engine(createNodeHost({ baseDir: '.', workers: 0 }));
    await fresh.init();
    openPackages(fresh, builtin);
    const f30b = (await cook(nodes, 'settle', fresh, 30)).geo;
    check(same(f30.P, f30b.P) && same(f30.packedXform, f30b.packedXform), 'frame 30 after frame 12 (resumed) equals frame 30 cooked fresh');
    check(f12a.P[1] < input.P[1], 'pieces fall between frames');
    const end = (await cook(nodes, 'settle', engine, 1 + 24 * 3)).geo;
    check(same(end.P, settled.P) && same(end.packedXform, settled.packedXform), 'the last frame equals the settled (non-animated) result');
    const stackAnim = await cook({ ...nodes, settle: { type: 'rbd_stack', in: ['pieces'], params: { animate: true, interval: 30 } } }, 'settle', engine, 2);
    check(stackAnim.geo.numPacked === 1, `animated rbd_stack shows only the pieces dropped so far (${stackAnim.geo.numPacked} at frame 2)`);
  }

  // ---------------------------------------------------------------- shapes
  {
    for (const shape of ['box', 'sphere', 'mesh']) {
      const r = await cook(ROCKS(9, { collision_shape: shape }), 'settle');
      const ok = r.geo.numPacked === 9 && ints(r.geo, 'settled').every((x) => x === 1);
      const warned = r.warnings.some((w) => /for static pieces/.test(w));
      check(ok && (shape === 'mesh') === warned, `collision_shape ${shape}: settles${shape === 'mesh' ? ', warns that moving pieces use convex_hull' : ''}`);
    }
  }
}

// ---------------------------------------------------------------- performance: 1,000 convex pieces
{
  const nodes = ROCKS(1000, {}, 1.4);
  await cook(nodes, 'pieces');
  const t0 = performance.now();
  const r = await cook(nodes, 'settle');
  const ms = performance.now() - t0;
  console.log(`     1,000 packed rocks (64-vertex hulls) dropped onto the ground: ${ms.toFixed(0)} ms, ${r.stats.steps} steps (${r.stats.sim_time} s simulated), ${r.stats.settled} settled`);
  if (ms > 3000) console.log('     (over the 3 s target: the machine may be loaded)');
  check(r.stats.settled === 1000 && ms < 12000, `1,000 convex pieces settle (${(ms / 1000).toFixed(2)} s; target 3 s, fails above 12 s)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
