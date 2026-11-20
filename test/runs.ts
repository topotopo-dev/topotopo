// bake_flow and core/runs.ts: runs that flow down a surface under gravity from source parts.
//   core: runs go straight down a box wall, follow a cylinder (standing and lying), stop and pool on a ledge, spill over
//         the edge of a narrow one, drip off an overhang onto the surface below, pool at the bottom of a groove and run on
//         along a sloping one, follow another gravity, ignore authored normals, are the same for a seed, differ for
//         another, and do not depend on the order of the parts or on the parts that are added elsewhere
//   grid: the texel grid gives what testing every segment gives (soft edges are not clipped); the time limit and the
//         segment limit stop a bake
//   node: charts of different texel density across a fold agree with the one-chart surface in 3D, the same bits for one
//         seed, the layers (also with supersample), the same image at ten times the scale, every refusal, the example
//   node test/runs.ts
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { defineNode, getNodeDef } from '../src/graph/registry.ts';
import { GeoBuilder, Geometry } from '../src/core/geometry.ts';
import { findImage } from '../src/core/image.ts';
import { limits, rasterRuns, sampleSources, traceRuns } from '../src/core/runs.ts';
import type { FlowParams, RunSet } from '../src/core/runs.ts';
import type { NodeSpec } from '../src/graph/types.ts';

let fail = 0, pass = 0;
const check = (ok: unknown, msg: string) => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
};
const section = (s: string) => console.log(`\n== ${s}`);

// ---------------------------------------------------------------- geometry helpers

interface Part { name: string; polys: number[][][]; uv?: number[][][] }

/** Closed polygons from corner lists, with a prim name per part and optional per-corner uv. The corners of a part that
 * coincide are one point, so a part is one connected piece (a box is 8 points, not 24). */
function build(parts: Part[], withUv = false): Geometry {
  const b = new GeoBuilder();
  const names: string[] = [], uvs: number[][] = [];
  for (const part of parts) {
    const ids = new Map<string, number>();
    part.polys.forEach((poly, i) => {
      b.addPrim(poly.map((p) => {
        const k = `${p[0]},${p[1]},${p[2]}`;
        let id = ids.get(k);
        if (id === undefined) { id = b.addPoint(p[0], p[1], p[2]); ids.set(k, id); }
        return id;
      }));
      names.push(part.name);
      for (let k = 0; k < poly.length; k++) uvs.push(part.uv?.[i]?.[k] ?? [0, 0]);
    });
  }
  const g = b.build();
  const n = g.prims.add('name', 'string', 1);
  names.forEach((x, p) => n.set(p, x));
  if (withUv) { const a = g.vertices.add('uv', 'float', 3); uvs.forEach((u, v) => a.set(v, [u[0], u[1], 0])); }
  return g;
}

/** A box's six faces, wound outward. */
function boxPolys(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number[][][] {
  return [
    [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]],
    [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]],
    [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]], [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]],
  ];
}

/** A prism around the Y axis (or Z when lying): sides as quads, caps as n-gons. */
function cylPolys(r: number, y0: number, y1: number, sides: number, axis: 'y' | 'z' = 'y'): number[][][] {
  const ring = (h: number) => Array.from({ length: sides }, (_, i) => { const a = (i / sides) * 2 * Math.PI; return axis === 'y' ? [r * Math.cos(a), h, r * Math.sin(a)] : [r * Math.cos(a), r * Math.sin(a), h]; });
  const lo = ring(y0), hi = ring(y1), out: number[][][] = [];
  for (let i = 0; i < sides; i++) { const j = (i + 1) % sides; out.push([lo[i], hi[i], hi[j], lo[j]]); }
  out.push(lo.slice().reverse(), hi);
  // winding: the side quad (lo[i], hi[i], hi[j], lo[j]) points outward for the Y axis, inward for the Z axis
  return axis === 'y' ? out : out.map((p, i) => (i < sides ? p.slice().reverse() : i === sides ? lo : hi.slice().reverse()));
}

const PRM: FlowParams = { density: 40, direction: [0, -1, 0], length: [0.05, 0.25], width: [0.003, 0.01], wobble: 0, breakup: 0, ledge: 30, pool: 1.5, drip: true, step: 0, spill: 0, seed: 0 };
const prm = (o: Partial<FlowParams> = {}): FlowParams => ({ ...PRM, ...o });

/** Trace the parts named "src" over the others. */
function trace(g: Geometry, o: Partial<FlowParams> = {}) {
  const nm = g.prims.get('name')!;
  const keep = Uint8Array.from({ length: g.numPrims }, (_, p) => (nm.get(p) === 'src' ? 1 : 0));
  const src = g.subsetPrims(keep), recv = g.subsetPrims(Uint8Array.from(keep, (x) => 1 - x));
  return traceRuns(recv, src, sampleSources(src, o.seed ?? 0), prm(o));
}

/** The points of each run in order (segments of one run chain; a drip or a pool starts a new piece). */
function runPoints(rs: RunSet): number[][][] {
  const runs: number[][][] = Array.from({ length: rs.count }, () => []);
  for (let k = 0; k < rs.segs; k++) {
    if (rs.POOL[k]) continue;
    const r = runs[rs.ID[k] - 1];
    const a = [rs.A[k * 6], rs.A[k * 6 + 1], rs.A[k * 6 + 2]], b = [rs.A[k * 6 + 3], rs.A[k * 6 + 4], rs.A[k * 6 + 5]];
    if (!r.length || r[r.length - 1].some((v, i) => Math.abs(v - a[i]) > 1e-9)) r.push(a);
    r.push(b);
  }
  return runs.filter((r) => r.length);
}

// ---------------------------------------------------------------- runs go straight down a box wall
section('box wall: straight down');
const wallParts = (extra: Part[] = []): Part[] => [
  { name: 'wall', polys: boxPolys(0, 0, -0.05, 1, 1, 0) },
  { name: 'src', polys: boxPolys(0.4, 0.78, -0.002, 0.46, 0.82, 0.01) },
  ...extra,
];
{
  const { runs, stats } = trace(build(wallParts()), { length: [0.2, 0.2] });
  const pts = runPoints(runs);
  check(runs.count >= 1 && stats.touching > 0, `${runs.count} run(s) from a plate on a wall (${stats.touching} touching candidates)`);
  const straight = pts.every((r) => r.every((p) => Math.abs(p[0] - r[0][0]) < 1e-6 && Math.abs(p[2] - 0) < 1e-6) && r.every((p, i) => i === 0 || p[1] < r[i - 1][1]));
  check(straight, 'every run keeps its x, stays on the wall face and only goes down');
  check(pts.every((r) => r[0][1] < 0.8 && r[0][1] > 0.7) && pts.every((r) => r[0][0] > 0.39 && r[0][0] < 0.47), 'runs begin under the plate, within its width');
  const long = pts.map((r) => r[0][1] - r[r.length - 1][1]);
  check(long.every((l) => Math.abs(l - 0.2) < 0.01), `drawn length is the length asked for (${long.map((l) => l.toFixed(3)).join(' ')})`);
}

// ---------------------------------------------------------------- varied runs, seeds
section('varied length and width, seeds');
{
  const g = build([{ name: 'wall', polys: boxPolys(0, 0, -0.05, 2, 1, 0) }, { name: 'src', polys: boxPolys(0.2, 0.9, -0.002, 1.8, 0.93, 0.01) }]);
  const a = trace(g, { seed: 1 }), b = trace(g, { seed: 1 }), c = trace(g, { seed: 2 });
  const same = (x: RunSet, y: RunSet) => x.segs === y.segs && x.A.every((v, i) => v === y.A[i]) && x.HW.every((v, i) => v === y.HW[i]);
  check(same(a.runs, b.runs) && a.runs.count > 10, `seed 1 twice: the same ${a.runs.count} runs, bit for bit`);
  check(!same(a.runs, c.runs), 'seed 2 gives other runs');
  const lens = Array.from(a.runs.runLen).slice(1);
  const mn = Math.min(...lens), mx = Math.max(...lens);
  check(mx > 2 * mn && mn >= 0.045 && mx <= 0.26, `run lengths vary (${mn.toFixed(3)} to ${mx.toFixed(3)} m over ${lens.length} runs)`);
  const strong = lens.map((l, i) => [a.runs.strength[i + 1], l]).sort((p, q) => p[0] - q[0]);
  const lo = strong.slice(0, strong.length >> 1).reduce((s, p) => s + p[1], 0), hi = strong.slice(strong.length >> 1).reduce((s, p) => s + p[1], 0);
  check(hi > lo, 'the stronger half of the runs is the longer half');
  const half = trace(g, { density: 20, seed: 1 });
  check(half.runs.count < a.runs.count * 0.7, `half the density, fewer runs (${half.runs.count} vs ${a.runs.count})`);
  const wob = trace(g, { seed: 1, wobble: 0.6 });
  const dev = runPoints(wob.runs).map((r) => Math.max(...r.map((p) => Math.abs(p[0] - r[0][0]))));
  check(Math.max(...dev) > 0.003 && Math.max(...dev) < 0.12, `wobble bends runs sideways (largest drift ${Math.max(...dev).toFixed(3)} m) without leaving the wall`);
  const none = trace(g, { density: 0 });
  check(none.runs.count === 0, 'density 0 makes no runs');
}

// ---------------------------------------------------------------- cylinders
section('cylinders');
{
  const R = 0.1, g = build([{ name: 'cyl', polys: cylPolys(R, 0, 1, 24) }, { name: 'src', polys: boxPolys(0.095, 0.78, -0.02, 0.115, 0.82, 0.02) }]);
  const { runs } = trace(g, { length: [0.2, 0.2] });
  const pts = runPoints(runs);
  const ok = pts.every((r) => r.every((p) => { const d = Math.hypot(p[0], p[2]); return d > R * Math.cos(Math.PI / 24) - 1e-6 && d < R + 1e-6; }) && r.every((p) => Math.abs(Math.atan2(p[2], p[0]) - Math.atan2(r[0][2], r[0][0])) < 1e-3));
  check(runs.count > 0 && ok, `${runs.count} runs on a standing cylinder stay on its side and run down its generators`);
  // a drum on its side: the run follows the curve down and off, its lowest point is where the surface turns down (15° below the horizontal)
  const D = 0.2, a0 = (50 * Math.PI) / 180;
  const sx = D * Math.cos(a0), sy = D * Math.sin(a0);
  const drum = build([{ name: 'cyl', polys: cylPolys(D, 0, 1, 72, 'z') }, { name: 'src', polys: boxPolys(sx - 0.004, sy - 0.004, 0.45, sx + 0.004, sy + 0.004, 0.5) }]);
  const dr = trace(drum, { length: [1, 1], density: 5 });
  const dp = runPoints(dr.runs);
  const follows = dp.every((r) => r.every((p) => { const d = Math.hypot(p[0], p[1]); return d > D * 0.99 && d < D * 1.001; }) && r.every((p, i) => i === 0 || p[1] <= r[i - 1][1] + 1e-9));
  const low = Math.min(...dp.map((r) => r[r.length - 1][1]));
  check(dp.length > 0 && follows, `${dp.length} run(s) on a lying cylinder follow its curve downhill`);
  check(Math.abs(low - -D * Math.sin(Math.PI / 12)) < 0.01, `the run leaves the drum where its surface turns down (lowest ${low.toFixed(3)}, expected ${(-D * Math.sin(Math.PI / 12)).toFixed(3)})`);
  check(dr.stats.ended.fell === dr.runs.count, 'nothing is below the drum: its runs end there');
}

// ---------------------------------------------------------------- ledge: stop and pool
section('ledge: stop and pool');
{
  const g = build([...wallParts(), { name: 'shelf', polys: boxPolys(0.2, 0.45, -0.02, 0.7, 0.5, 0.2) }]);
  const { runs, stats } = trace(g, { length: [0.4, 0.4], pool: 3 });
  const pts = runPoints(runs);
  const lowY = Math.min(...pts.map((r) => r[r.length - 1][1]));
  check(runs.count > 0 && stats.ended.ledge === runs.count, `every run stops on the ledge (${stats.ended.ledge} of ${runs.count})`);
  check(Math.abs(lowY - 0.5) < 0.004 && pts.every((r) => r[r.length - 1][1] > 0.49), `no run goes below the shelf top at y 0.5 (lowest end ${lowY.toFixed(4)})`);
  let pool = 0, widest = 0, tail = Infinity;
  for (let k = 0; k < runs.segs; k++) if (runs.POOL[k]) { pool++; widest = Math.max(widest, runs.HW[k * 2]); }
  for (let k = 0; k < runs.segs; k++) if (!runs.POOL[k]) tail = Math.min(tail, runs.HW[k * 2 + 1]);
  check(pool === runs.count && widest > 2 * tail, `a pool lens at each stop, wider than the run (${widest.toFixed(4)} vs ${tail.toFixed(4)} half width)`);
  const cut = trace(g, { length: [0.4, 0.4], ledge: 0 });
  check(cut.stats.ended.ledge === cut.runs.count, 'ledge 0 degrees: a face exactly flat still stops a run');
}

// ---------------------------------------------------------------- overhang: drip onto the surface below
section('overhang: drip');
{
  const parts: Part[] = [
    { name: 'wall', polys: boxPolys(0, 0, -0.05, 1, 1.2, 0) },
    { name: 'block', polys: boxPolys(0, 0.5, -0.01, 1, 1.2, 0.1) },
    { name: 'floor', polys: boxPolys(-0.2, -0.05, -0.05, 1.2, 0, 0.5) },
    { name: 'src', polys: boxPolys(0.4, 0.98, 0.09, 0.46, 1.02, 0.11) },
  ];
  const g = build(parts);
  const { runs, stats } = trace(g, { length: [0.6, 0.6], width: [0.01, 0.01] });
  const lands = Array.from({ length: runs.segs }, (_, k) => k).filter((k) => runs.A[k * 6 + 1] < 0.01 && runs.A[k * 6 + 4] < 0.01);
  check(stats.drips >= 1 && runs.count > 0, `runs drip off the overhang (${stats.drips} drip(s) from ${runs.count} runs)`);
  check(lands.length > 0 && lands.every((k) => Math.abs(runs.A[k * 6 + 2] - 0.1) < 0.02), `they land on the floor below the block's edge (${lands.length} segments at y 0, z about 0.1)`);
  const between = Array.from({ length: runs.segs }, (_, k) => k).filter((k) => !runs.POOL[k] && runs.A[k * 6 + 1] > 0.02 && runs.A[k * 6 + 1] < 0.49 && runs.A[k * 6 + 4] > 0.02 && runs.A[k * 6 + 4] < 0.49);
  check(between.length === 0, 'nothing is drawn in the air between the edge and the floor');
  const off = trace(g, { length: [0.6, 0.6], drip: false });
    check(off.stats.drips === 0 && Array.from({ length: off.runs.segs }, (_, k) => off.runs.A[k * 6 + 1]).every((y) => y > 0.4), 'drip off: the run ends at the edge');
}


// ---------------------------------------------------------------- spill over a narrow ledge
section('ledge: spill over the edge');
const stepped = (ledgeDepth: number, boltZ: number): Geometry => build([
  { name: 'lower', polys: boxPolys(0, 0, -0.05, 1, 0.5, ledgeDepth - 0.02) },
  { name: 'upper', polys: boxPolys(0, 0.5, -0.05, 1, 1, -0.02) },
  { name: 'src', polys: boxPolys(0.4, 0.498, boltZ - 0.006, 0.45, 0.52, boltZ + 0.006) },
]);
/** The paths of the runs (not the pool lenses, whose size follows the width): a count and a hash of the positions. */
const hashA = (rs: RunSet) => { let h = 0, c = 0; for (let k = 0; k < rs.segs; k++) { if (rs.POOL[k]) continue; c++; for (let i = 0; i < 6; i++) h = (Math.imul(h, 31) + Math.round(rs.A[k * 6 + i] * 1e9)) | 0; } return `${rs.segs}:${c}:${h}`; };
{
  const narrow = stepped(0.02, -0.01);
  const segsBelow = (rs: RunSet, z: number) => Array.from({ length: rs.segs }, (_, k) => k).filter((k) => rs.A[k * 6 + 1] < 0.49 && rs.A[k * 6 + 4] < 0.49 && Math.abs(rs.A[k * 6 + 2] - z) < 0.003);
  const none = trace(narrow, { spill: 0 });
  const startsOnLedge = (rs: RunSet) => Array.from({ length: rs.count }, (_, r) => r + 1).filter((id) => { const k = Array.from({ length: rs.segs }, (_, q) => q).find((q) => rs.ID[q] === id)!; return Math.abs(rs.A[k * 6 + 1] - 0.5) < 2e-3; }).length;
  check(none.stats.ledgeRejected > 0 && startsOnLedge(none.runs) === 0, `spill 0: no run starts on the ledge itself, as before spilling existed (${none.stats.ledgeRejected} candidates rejected)`);
  // a run from the wall above the ledge: with the reach at 0 it pools and nothing goes below; the paths are recorded
  const above = build([{ name: 'lower', polys: boxPolys(0, 0, -0.05, 1, 0.5, 0) }, { name: 'upper', polys: boxPolys(0, 0.5, -0.05, 1, 1, -0.02) }, { name: 'src', polys: boxPolys(0.4, 0.6, -0.03, 0.45, 0.62, -0.015) }]);
  const a0 = trace(above, { spill: 0, length: [0.2, 0.2] }), a1 = trace(above, { spill: 0, length: [0.2, 0.2] });
  check(hashA(a0.runs) === hashA(a1.runs) && hashA(a0.runs) === '21:19:1080399545' && segsBelow(a0.runs, 0).length === 0 && a0.stats.ended.ledge > 0, `spill 0: runs from above pool on the ledge and go no further; the paths are the recorded ones (${hashA(a0.runs)})`);
  const sp = trace(narrow, { spill: 0.05 });
  const below = segsBelow(sp.runs, 0);
  check(sp.stats.spills > 0 && below.length > 0 && below.every((k) => sp.runs.AMP[k] < 1 && sp.runs.A[k * 6] > 0.36 && sp.runs.A[k * 6] < 0.49), `a bolt on a narrow ledge: ${sp.stats.spills} spill(s), ${below.length} segments on the wall below it, weaker than the pool (amp ${Math.min(...below.map((k) => sp.runs.AMP[k])).toFixed(2)})`);
  const lensAt = Array.from({ length: sp.runs.segs }, (_, k) => k).filter((k) => sp.runs.POOL[k] && Math.abs(sp.runs.A[k * 6 + 1] - 0.5) < 0.01);
  check(lensAt.length > 0, 'the pool lens stays on the ledge');
  const wide = stepped(0.3, 0.14);
  const wd = trace(wide, { spill: 0.05 });
  check(wd.runs.count > 0 && wd.stats.spills === 0 && segsBelow(wd.runs, 0.28).length === 0 && wd.stats.ended.ledge === wd.runs.count, `a bolt in the middle of a wide shelf pools only (${wd.runs.count} pool run(s), no spill)`);
  const far = trace(wide, { spill: 0.2 });
  check(far.stats.spills > 0, 'a reach of 0.2 m does reach the edge of the same shelf');
}

// ---------------------------------------------------------------- gravity
section('gravity');
{
  const wall = [{ name: 'wall', polys: boxPolys(0, 0, -0.05, 1, 1, 0) }, { name: 'src', polys: boxPolys(0.78, 0.4, -0.002, 0.82, 0.46, 0.01) }];
  const { runs } = trace(build(wall), { direction: [-1, 0, 0], length: [0.2, 0.2] });
  const pts = runPoints(runs);
  check(runs.count > 0 && pts.every((r) => r.every((p) => Math.abs(p[1] - r[0][1]) < 1e-6 && Math.abs(p[2]) < 1e-6) && r.every((p, i) => i === 0 || p[0] < r[i - 1][0])), `gravity along -x: ${runs.count} runs go sideways along the wall, level`);
  const slope = trace(build(wall), { direction: [-1, -1, 0], length: [0.2, 0.2] });
  const sp = runPoints(slope.runs);
  check(sp.length > 0 && sp.every((r) => { const dx = r[r.length - 1][0] - r[0][0], dy = r[r.length - 1][1] - r[0][1]; return Math.abs(dx - dy) < 1e-6 && dx < 0; }), 'gravity (-1, -1, 0): runs go down at 45 degrees');
}

// ---------------------------------------------------------------- per texel: node
section('node: uv seams');
const tmp = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'topotopo-runs-'));
const store = new Map<string, Geometry>();
defineNode({ type: '__runs_source', category: 'test', inputs: [], summary: 'test', params: { key: { type: 'string', default: '', desc: 'geometry key' } }, cook: ({ p }) => store.get(p.key)!.clone() });
const engines = { pool: new Engine(createNodeHost({ baseDir: tmp })) };
await engines.pool.init();
type Nodes = Record<string, NodeSpec>;
async function cookOn(e: Engine, nodes: Nodes, output: string) {
  const r = await e.cook({ nodes, output });
  return { ok: r.ok, geo: r.geo, errors: r.errors.map((x) => x.message + (x.hint ? ` (${x.hint})` : '')), warnings: r.warnings.map((w) => w.message) };
}
const flow = (key: string, params: Record<string, any>, extra: Nodes = {}): Nodes => ({ s: { type: '__runs_source', params: { key } }, f: { type: 'bake_flow', in: ['s', ...(extra.in2 ? ['in2'] : [])], params }, ...extra });

const R = 512, SIDE = 0.6, SPAN = 0.8, K = 4, GAP = 8;
const sheetUv = (x: number, y: number, a = 0, b = 0) => [(x / SIDE) * SPAN + (a * GAP) / R, (y / SIDE) * SPAN + (b * GAP) / R];
/** The wall as one quad (uncut) or K × K quads each with its own shifted uv chart, and a plate on it at a seam. */
function sheet(cut: boolean): Geometry {
  const polys: number[][][] = [], uv: number[][][] = [];
  const n = cut ? K : 1, t = SIDE / n;
  for (let b = 0; b < n; b++)
    for (let a = 0; a < n; a++) {
      const x0 = a * t, x1 = x0 + t, y0 = b * t, y1 = y0 + t;
      const c = [[x0, y0, 0], [x1, y0, 0], [x1, y1, 0], [x0, y1, 0]];
      polys.push(c); uv.push(c.map((p) => sheetUv(p[0], p[1], cut ? a : 0, cut ? b : 0)));
    }
  const plate = boxPolys(0.28, 0.45, 0.0, 0.32, 0.5, 0.01);
  return build([{ name: 'wall', polys, uv }, { name: 'bolt', polys: plate }], true);
}
store.set('uncut', sheet(false));
const eq = (x: Geometry, y: Geometry) => { const u = findImage(x, 'f')!, v = findImage(y, 'f')!; return [...u.layers.keys()].every((k) => v.layers.has(k) && u.layers.get(k)!.every((q, i) => q === v.layers.get(k)![i])); };
{
  const P = { sources: '@name=bolt', resolution: R, density: 200, wobble: 0.2, breakup: 0.5, seed: 3, padding: 0, length: [0.1, 0.2] };
  const A = await cookOn(engines.pool, flow('uncut', P), 'f');
  check(A.ok, `the wall cooks${A.errors.join('; ')}`);
  const ia = findImage(A.geo!, 'f')!;
  const ca = ia.layer('C')!, ma = ia.layer('mask')!;
  // the same seed again: the same bits; another seed: other runs
  const A2 = await cookOn(engines.pool, flow('uncut', P), 'f');
  check(eq(A.geo!, A2.geo!), 'the same seed again: identical bits');
  const O = await cookOn(engines.pool, flow('uncut', { ...P, seed: 4 }), 'f');
  check(!eq(A.geo!, O.geo!), 'another seed: other runs');
  // layers
  const names = [...ia.layers.keys()].sort().join(',');
  check(names === 'C,along,head,id,mask,strength', `layers ${names}`);
  const along = ia.layer('along')!, id = ia.layer('id')!, str = ia.layer('strength')!, head = ia.layer('head')!;
  let okLayers = true, lit = 0; const ids = new Set<number>();
  for (let q = 0; q < R * R; q++) {
    if (ma[q] < 1) continue;
    if (ca[q] > 0) { lit++; ids.add(id[q]); if (!(id[q] >= 1 && along[q] >= 0 && along[q] <= 1 && str[q] > 0 && head[q] <= ca[q] + 1e-6)) okLayers = false; }
    else if (id[q] !== 0 || head[q] !== 0 || along[q] !== 0) okLayers = false;
  }
  check(okLayers && ids.size > 3 && lit > 500, `along, head, strength and id hold where runs are and 0 elsewhere (${ids.size} runs seen, ${lit} texels)`);
  // supersampling: along, strength and id are those of the run that covers the texel most, never a mean with empty samples
  const base = flow('uncut', { ...P, supersample: 1 }), ss = flow('uncut', { ...P, supersample: 3 });
  const s1 = findImage((await cookOn(engines.pool, base, 'f')).geo!, 'f')!, s3 = findImage((await cookOn(engines.pool, ss, 'f')).geo!, 'f')!;
  void s1;
  let bad = 0, seen = 0;
  const i3 = s3.layer('id')!, t3 = s3.layer('strength')!, a3 = s3.layer('along')!, c3 = s3.layer('C')!, strOf = new Map<number, number>();
  for (let q = 0; q < c3.length; q++) {
    if (!(c3[q] > 0)) continue;
    seen++;
    // a run id is a whole number, one run has one strength, along stays in 0..1
    if (!Number.isInteger(i3[q]) || i3[q] < 1 || !(a3[q] >= 0 && a3[q] <= 1) || (strOf.has(i3[q]) && strOf.get(i3[q]) !== t3[q])) bad++;
    strOf.set(i3[q], t3[q]);
  }
  check(seen > 500 && bad === 0, `at supersample 3 every id is a whole run number with its own strength (${bad} of ${seen} covered texels are not: no mean of run ids)`);
  // read the way a layer stack reads it: an expression over `f_id` finds no id that is not a whole run number
  const stack = (mask: string): Nodes => ({ s: { type: '__runs_source', params: { key: 'uncut' } }, f: { type: 'bake_flow', in: ['s'], params: { ...P, supersample: 3 } }, l: { type: 'tex_layers', in: ['f', 'f'], params: { base_roughness: 0.5, base_metallic: 0, padding: 0, layers: [{ name: 'x', mask, color: '#ff0000' }] } } });
  const reds = async (mask: string) => { const r = await cookOn(engines.pool, stack(mask), 'l'); const im = r.geo && findImage(r.geo, 'l_base_color'); if (!im) return -1; const C = im.layer('C')!; let n = 0; for (let i = 0; i < C.length / 4; i++) if (C[i * 4] > 0.99 && C[i * 4 + 1] < 0.01) n++; return n; };
  const withId = await reds('f_id > 0 ? 1 : 0'), notWhole = await reds('f_id > 0 && f_id != floor(f_id) ? 1 : 0');
  check(withId > 500 && notWhole === 0, `an expression over f_id: ${withId} texels carry a run id, ${notWhole} of them are not a whole number`);
}

section('node: straight runs below a source');
{
  const P = { sources: '@name=bolt', resolution: R, density: 100, wobble: 0, breakup: 0, padding: 0, length: [0.1, 0.1], width: [0.006, 0.006] };
  const r = await cookOn(engines.pool, flow('uncut', P), 'f');
  const c = findImage(r.geo!, 'f')!.layer('C')!, m = findImage(r.geo!, 'f')!.layer('mask')!;
  let n = 0, outside = 0;
  for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) {
    if (m[j * R + i] < 1 || c[j * R + i] < 0.5) continue;
    n++;
    const x = ((i + 0.5) / R) / SPAN * SIDE, y = ((R - j - 0.5) / R) / SPAN * SIDE;
    if (x < 0.28 - 0.006 || x > 0.32 + 0.006 || y > 0.45 + 0.002 || y < 0.45 - 0.11) outside++;
  }
  check(n > 100 && outside === 0, `${n} texels on runs, all in the strip straight below the plate (${outside} outside)`);
  const bolt = await cookOn(engines.pool, { ...flow('uncut', { ...P, resolution: 128, keep_mesh: true }) }, 'f');
  check(bolt.ok && !!bolt.geo && bolt.geo.numPrims > 0, 'keep_mesh keeps the mesh');
}

// ---------------------------------------------------------------- refusals
section('refusals');
{
  const base = { resolution: 64 };
  const msg = async (params: Record<string, any>, extra: Nodes = {}, key = 'uncut') => { const r = await cookOn(engines.pool, flow(key, { ...base, ...params }, extra), 'f'); return { text: r.errors.join('; '), warnings: r.warnings }; };
  let m = await msg({ sources: '@name=nothing*' });
  check(m.text.includes('bake_flow: sources "@name=nothing*" match no prims') && m.text.includes('parts: ') && m.text.includes('"wall"'), `no matching sources: ${m.text}`);
  m = await msg({});
  check(m.text.includes('bake_flow: say where runs start: sources (a prim group) or input 1'), `no sources: ${m.text}`);
  m = await msg({ sources: '@name=bolt', direction: [0, 0, 0] });
  check(m.text.includes('bake_flow: direction is the zero vector'), `zero direction: ${m.text}`);
  m = await msg({ sources: '@name=bolt*' }, {}, 'uncut');
  check(m.text === '', 'a matching source cooks');
  const far = build([{ name: 'wall', polys: [[[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]]], uv: [[[0, 0], [1, 0], [1, 1], [0, 1]]] }, { name: 'hinge_l', polys: boxPolys(0.4, 0.4, 0.2, 0.45, 0.45, 0.25) }, { name: 'hinge_r', polys: boxPolys(0.6, 0.4, 0.2, 0.65, 0.45, 0.25) }], true);
  store.set('far', far);
  m = await msg({ sources: '@name=hinge*' }, {}, 'far');
  check(m.text === '' && m.warnings.some((w) => w === 'bake_flow: no source part touches another surface within 1 cm (sources: hinge_l, hinge_r); no runs'), `no touching part warns: ${m.warnings.join(' | ')}`);
  const all = await cookOn(engines.pool, flow('uncut', { ...base, sources: '@P.y>-10' }), 'f');
  check(all.errors.join('').includes('match every prim'), `sources that are every prim: ${all.errors.join('; ')}`);
  const nouv = await cookOn(engines.pool, { b: { type: 'box' }, d: { type: 'attrib_delete', in: ['b'], params: { names: 'uv' } }, f: { type: 'bake_flow', in: ['d'], params: { sources: '@P.y>0.4' } } }, 'f');
  check(nouv.errors.join('').includes('no "uv" attribute'), 'no uv: refused like the other bakes');
  // sources on input 1: points, and a mesh
  store.set('pts', (() => { const b = new GeoBuilder(); b.addPoint(0.1, 0.4, 0.004); return b.build(); })());
  const viaPts = await cookOn(engines.pool, { s: { type: '__runs_source', params: { key: 'uncut' } }, p: { type: '__runs_source', params: { key: 'pts' } }, f: { type: 'bake_flow', in: ['s', 'p'], params: { resolution: 128, density: 40 } } }, 'f');
  const im = viaPts.geo && findImage(viaPts.geo, 'f');
  let lit = 0; if (im) for (const v of im.layer('C')!) if (v > 0.3) lit++;
  check(viaPts.ok && lit > 10, `a point on input 1 starts a run (${lit} texels)`);
}

// ---------------------------------------------------------------- resolution
section('resolution');
{
  const P = { sources: '@name=bolt', density: 200, wobble: 0, breakup: 0, padding: 0, length: [0.1, 0.1], width: [0.008, 0.008] };
  const area = async (res: number) => { const r = await cookOn(engines.pool, flow('uncut', { ...P, resolution: res }), 'f'); const im = findImage(r.geo!, 'f')!; const c = im.layer('C')!, m = im.layer('mask')!; let s = 0; for (let q = 0; q < c.length; q++) if (m[q] > 0) s += c[q]; return (s * (SIDE / SPAN / res) ** 2); };
  const a1 = await area(256), a2 = await area(1024);
  check(Math.abs(a1 - a2) / a2 < 0.1, `the painted area is the same at 256 and 1024 (${(a1 * 1e4).toFixed(1)} and ${(a2 * 1e4).toFixed(1)} cm²)`);
}


// ---------------------------------------------------------------- the texel grid: soft edges, limits, time
section('texel grid and limits');
const rasterScene = () => {
  const g = build(wallParts());
  const { runs } = trace(g, { length: [0.1, 0.1], density: 150, seed: 3 });
  const step = 0.001, xs = 100, ys = 150;
  const P = new Float64Array(xs * ys * 3), N = new Float64Array(xs * ys * 3), tau = new Float32Array(xs * ys).fill(step);
  for (let j = 0; j < ys; j++) for (let i = 0; i < xs; i++) { const k = j * xs + i; P[k * 3] = 0.4 + i * step; P[k * 3 + 1] = 0.66 + j * step; P[k * 3 + 2] = 0; N[k * 3 + 2] = 1; }
  const out = () => ({ C: new Float32Array(xs * ys), along: new Float32Array(xs * ys), head: new Float32Array(xs * ys), strength: new Float32Array(xs * ys), id: new Float32Array(xs * ys) });
  return { runs, inp: { P, N, tau }, out };
};
{
  const { runs, inp, out } = rasterScene();
  for (const br of [0, 0.4]) {
    const a = out(), b = out();
    rasterRuns(runs, inp, br, 3, a);
    rasterRuns(runs, inp, br, 3, b, { brute: true });
    let diff = 0, clipped = 0, lit = 0;
    for (let i = 0; i < a.C.length; i++) { diff = Math.max(diff, Math.abs(a.C[i] - b.C[i])); if (a.C[i] === 0 && b.C[i] > 1e-4) clipped++; if (b.C[i] > 0) lit++; }
    check(lit > 1500 && clipped === 0 && diff < 1e-6, `breakup ${br}: the grid gives what testing every segment gives (${lit} texels on runs, ${clipped} clipped by the grid, largest difference ${diff.toExponential(1)})`);
  }
  // the time limit: the check runs while the grid is built and while the texels are read
  let calls = 0, threw = '';
  try { rasterRuns(runs, inp, 0.4, 3, out(), { check: () => { if (++calls > 2) throw new Error('stop grid'); } }); } catch (e: any) { threw = e.message; }
  check(threw === 'stop grid', 'a time limit stops the raster while it builds the grid');
  calls = 0; threw = '';
  try { rasterRuns(runs, inp, 0.4, 3, out(), { brute: true, check: () => { if (++calls > 2) throw new Error('stop texels'); } }); } catch (e: any) { threw = e.message; }
  check(threw === 'stop texels' && calls === 3, 'a time limit stops the raster while it reads the texels');
  const def = getNodeDef('bake_flow')!;
  check(['density', 'pool', 'length', 'width', 'step', 'spill'].every((k) => def.params[k].max !== undefined), 'density, pool, length, width, step and spill have a maximum');
  // too many segments: the limit is lowered for the test (a bake that hits the real one takes minutes)
  const was = limits.maxSegments;
  limits.maxSegments = 300;
  const lim = await cookOn(engines.pool, flow('uncut', { sources: '@name=bolt', resolution: 64, density: 400 }), 'f');
  limits.maxSegments = was;
  check(lim.errors.join('').includes('bake_flow: the runs would need more than 300 segments') && lim.errors.join('').includes('density'), `too many segments are refused with the params to lower: ${lim.errors.join('; ')}`);
  check(was === 400000, 'the segment limit is 400,000');
}

// ---------------------------------------------------------------- randomness follows where things are
section('order of the parts');
{
  const bolt = (x: number, y = 0.5) => ({ name: 'src', polys: boxPolys(x, y, -0.002, x + 0.04, y + 0.04, 0.01) });
  const wall = { name: 'wall', polys: boxPolys(0, 0, -0.05, 1, 1, 0) };
  const byKey = (rs: RunSet) => {
    const m = new Map<number, string>();
    for (let i = 0; i < rs.count; i++) {
      const segs = Array.from({ length: rs.segs }, (_, k) => k).filter((k) => rs.ID[k] === i + 1);
      m.set(rs.key[i + 1], segs.map((k) => Array.from(rs.A.subarray(k * 6, k * 6 + 6)).map((v) => v.toFixed(9)).join(',')).join(';'));
    }
    return m;
  };
  const four = [0.1, 0.3, 0.5, 0.7].map((x) => bolt(x));
  const a = trace(build([wall, ...four]), { seed: 5 }), b = trace(build([...four.slice().reverse(), wall]), { seed: 5 }), c = trace(build([four[2], wall, four[0], four[3], four[1]]), { seed: 5 });
  const ma = byKey(a.runs), mb = byKey(b.runs), mc = byKey(c.runs);
  const same = (x: Map<number, string>, y: Map<number, string>) => x.size === y.size && [...x].every(([k, v]) => y.get(k) === v);
  check(ma.size >= 4 && same(ma, mb) && same(ma, mc), `four bolts merged in three orders: the same ${ma.size} runs (same ids, same paths)`);
  const five = trace(build([wall, ...four, bolt(0.9)]), { seed: 5 }), mf = byKey(five.runs);
  check([...ma].every(([k, v]) => mf.get(k) === v) && mf.size > ma.size, `a bolt added far away: the other ${ma.size} runs are unchanged (${mf.size - ma.size} new)`);
  check(!same(ma, byKey(trace(build([wall, ...four]), { seed: 6 }).runs)), 'another seed: other runs');
  // at node level: the image
  const sheetBolts = (xs: number[]) => build([{ name: 'wall', polys: [[[0, 0, 0], [SIDE, 0, 0], [SIDE, SIDE, 0], [0, SIDE, 0]]], uv: [[[0, 0], [SPAN, 0], [SPAN, SPAN], [0, SPAN]]] }, ...xs.map((x) => ({ name: 'bolt', polys: boxPolys(x, 0.45, 0, x + 0.03, 0.48, 0.01) }))], true);
  store.set('o1', sheetBolts([0.05, 0.2, 0.35])); store.set('o2', sheetBolts([0.35, 0.05, 0.2])); store.set('o3', sheetBolts([0.05, 0.2, 0.35, 0.55]));
  const P = { sources: '@name=bolt', resolution: 256, seed: 2, padding: 0 };
  const i1 = await cookOn(engines.pool, flow('o1', P), 'f'), i2 = await cookOn(engines.pool, flow('o2', P), 'f'), i3 = await cookOn(engines.pool, flow('o3', P), 'f');
  check(eq(i1.geo!, i2.geo!), 'three bolts merged in another order: the same image, bit for bit');
  const c1 = findImage(i1.geo!, 'f')!.layer('C')!, c3 = findImage(i3.geo!, 'f')!.layer('C')!, id1 = findImage(i1.geo!, 'f')!.layer('id')!, id3 = findImage(i3.geo!, 'f')!.layer('id')!;
  let diff = 0, lit = 0, cmp = 0;
  for (let j = 0; j < 256; j++) for (let i = 0; i < 256; i++) {
    const x = ((i + 0.5) / 256) / SPAN * SIDE;
    if (x > 0.5) continue; // the new bolt is at x 0.55
    const q = j * 256 + i;
    if (c1[q] !== c3[q] || id1[q] !== id3[q]) diff++;
    if (c1[q] > 0) lit++;
    cmp++;
  }
  check(lit > 300 && diff === 0, `a bolt added far away: the texels of the others are unchanged (${cmp} compared, ${lit} on runs, ${diff} differ)`);
}

// ---------------------------------------------------------------- the same look at any scale
section('scale');
{
  const scaled = (k: number): Geometry => build([{ name: 'wall', polys: [[[0, 0, 0], [SIDE * k, 0, 0], [SIDE * k, SIDE * k, 0], [0, SIDE * k, 0]]], uv: [[[0, 0], [SPAN, 0], [SPAN, SPAN], [0, SPAN]]] }, { name: 'bolt', polys: boxPolys(0.28 * k, 0.45 * k, 0, 0.32 * k, 0.5 * k, 0.005 * k) }], true);
  store.set('s1', scaled(1)); store.set('s10', scaled(10));
  const P1 = { sources: '@name=bolt', resolution: 384, density: 120, wobble: 0.3, breakup: 0.5, seed: 4, padding: 0, width: [0.003, 0.01], length: [0.05, 0.25], spill: 0.05 };
  const P10 = { ...P1, density: 12, width: [0.03, 0.1], length: [0.5, 2.5], spill: 0.5 };
  const a = findImage((await cookOn(engines.pool, flow('s1', P1), 'f')).geo!, 'f')!, b = findImage((await cookOn(engines.pool, flow('s10', P10), 'f')).geo!, 'f')!;
  const ca = a.layer('C')!, cb = b.layer('C')!, ma = a.layer('mask')!;
  let sum = 0, mx = 0, lit = 0, bad = 0;
  for (let q = 0; q < ca.length; q++) { if (ma[q] < 1) continue; const d = Math.abs(ca[q] - cb[q]); if (ca[q] > 0.05 || cb[q] > 0.05) { lit++; sum += d; } mx = Math.max(mx, d); if (d > 0.1) bad++; }
  check(lit > 800 && bad / lit < 0.01 && sum / lit < 0.01, `the scene and the params both ten times larger give the same image (${lit} texels on runs, ${bad} differ by more than 0.1, mean difference ${(sum / lit).toExponential(1)}, largest ${mx.toFixed(2)})`);
}

// ---------------------------------------------------------------- the bottom of a groove
section('groove');
{
  /** A quad wound so that its normal points up (+y). */
  const quadUp = (c: number[][]): number[][] => {
    const a = c[0], b = c[1], d = c[2];
    const ny = (b[2] - a[2]) * (d[0] - a[0]) - (b[0] - a[0]) * (d[2] - a[2]);
    return ny >= 0 ? c : c.slice().reverse();
  };
  /** A V groove along z: two faces at `deg` from the horizontal meeting at x 0, y 0; the crease rises `rise` per metre of z. */
  const groove = (deg: number, rise: number, z1 = 1): Geometry => {
    const tan = Math.tan((deg * Math.PI) / 180), h = 0.3 * tan, Y = (y: number, z: number) => y + rise * z;
    const left = quadUp([[-0.3, Y(h, 0), 0], [0, Y(0, 0), 0], [0, Y(0, z1), z1], [-0.3, Y(h, z1), z1]]);
    const right = quadUp([[0.3, Y(h, 0), 0], [0, Y(0, 0), 0], [0, Y(0, z1), z1], [0.3, Y(h, z1), z1]]);
    const zb = z1 * 0.8, sx = -0.22, sy = Y(0.22 * tan, zb);
    return build([{ name: 'a', polys: [left] }, { name: 'b', polys: [right] }, { name: 'src', polys: boxPolys(sx - 0.015, sy - 0.015, zb - 0.015, sx + 0.015, sy + 0.015, zb + 0.015) }]);
  };
  for (const deg of [35, 45, 60]) {
    const { runs, stats } = trace(groove(deg, 0), { length: [0.6, 0.6], density: 80 });
    const ends = runPoints(runs).map((r) => r[r.length - 1]);
    check(runs.count > 0 && stats.ended.ledge === runs.count && stats.ended.lost === 0, `a V groove with sides at ${deg}°: every run pools at the bottom (${stats.ended.ledge} of ${runs.count}, ${stats.ended.lost} lost)`);
    check(ends.every((p) => Math.abs(p[0]) < 0.005 && Math.abs(p[1]) < 0.005), `at ${deg}° they end on the crease (largest offset ${Math.max(...ends.map((p) => Math.hypot(p[0], p[1]))).toFixed(4)} m)`);
  }
  const sloped = trace(groove(45, 0.15), { length: [0.6, 0.6], density: 80 });
  const sp = runPoints(sloped.runs);
  const flatEnds = runPoints(trace(groove(45, 0), { length: [0.6, 0.6], density: 80 }).runs).map((r) => r[r.length - 1][2]);
  check(sloped.runs.count > 0 && sp.every((r) => Math.abs(r[r.length - 1][0]) < 0.005), `a groove that slopes toward z 0: the runs follow its crease (${sp.length} runs, lowest z ${Math.min(...sp.map((r) => r[r.length - 1][2])).toFixed(3)})`);
  check(sp.every((r) => r[r.length - 1][2] < Math.min(...flatEnds) - 0.1), 'the sloping groove carries the water farther along than the level one');
}

// ---------------------------------------------------------------- the geometry decides the flow, not authored normals
section('authored normals');
{
  const g = build([{ name: 'wall', polys: boxPolys(0, 0, -0.05, 1, 1, 0) }, { name: 'src', polys: boxPolys(0.4, 0.2, -0.002, 0.46, 0.24, 0.01) }]);
  // normals smoothed across the box edges, as a sphere would have them: near the bottom of a face they tilt down
  const N = g.points.add('N', 'float', 3);
  for (let i = 0; i < g.numPoints; i++) { const x = g.P[i * 3] - 0.5, y = g.P[i * 3 + 1] - 0.5, z = g.P[i * 3 + 2] + 0.025, l = Math.hypot(x, y, z) || 1; N.set(i, [x / l, y / l, z / l]); }
  const { runs } = trace(g, { length: [0.2, 0.2] });
  const low = Math.min(...runPoints(runs).map((r) => r[r.length - 1][1]));
  check(runs.count > 0 && low < 0.02, `a run goes straight down the face to its bottom edge although the point normals tilt down (lowest ${low.toFixed(3)} m)`);
}

// ---------------------------------------------------------------- connected parts
section('parts');
{
  const wall = { name: 'wall', polys: boxPolys(0, 0, -0.05, 1, 1, 0) };
  const g = build([wall, { name: 'src', polys: boxPolys(0.2, 0.5, -0.002, 0.24, 0.54, 0.01) }, { name: 'src', polys: boxPolys(0.5, 0.5, -0.002, 0.54, 0.54, 0.01) }]);
  const nm = g.prims.get('name')!;
  const keep = Uint8Array.from({ length: g.numPrims }, (_, p) => (nm.get(p) === 'src' ? 1 : 0));
  const c = sampleSources(g.subsetPrims(keep), 0);
  check(new Set(c.part).size === 2, `two bolts of one name are two parts (${new Set(c.part).size}), each box one connected piece`);
  const r = trace(g, { density: 1 });
  check(r.runs.count === 2, `at 1 run per metre each part still gets a run (${r.runs.count})`);
}


// ---------------------------------------------------------------- uv seams on a fold: different texel densities, compared in 3D
section('folded uv seams');
{
  /** Bake `fold` (charts of different texel density) and `ref` (the same surface as one chart) and compare them in 3D. */
  const compare = async (label: string, fold: Geometry, ref: Geometry, posOfFold: (u: number, v: number) => number[] | null, uvOfRef: (p: number[]) => number[], P: Record<string, any>, chartB: (u: number, v: number) => boolean) => {
    store.set(`${label}-f`, fold); store.set(`${label}-r`, ref);
    const RR = 1024;
    const a = await cookOn(engines.pool, flow(`${label}-f`, { ...P, resolution: RR }), 'f'), b = await cookOn(engines.pool, flow(`${label}-r`, { ...P, resolution: RR }), 'f');
    if (!a.ok || !b.ok) { check(false, `${label}: both cook ${a.errors.concat(b.errors).join('; ')}`); return; }
    const ia = findImage(a.geo!, 'f')!, ib = findImage(b.geo!, 'f')!;
    const ca = ia.layer('C')!, ma = ia.layer('mask')!, cb = ib.layer('C')!;
    let sure = 0, bad = 0, litA = 0, litB = 0, litRef = 0;
    for (let j = 0; j < RR; j++) for (let i = 0; i < RR; i++) {
      const q = j * RR + i;
      if (ma[q] < 1) continue;
      const u = (i + 0.5) / RR, v = 1 - (j + 0.5) / RR;
      const p = posOfFold(u, v);
      if (!p) continue;
      const [ru, rv] = uvOfRef(p);
      const ri = Math.min(RR - 1, Math.max(0, Math.floor(ru * RR))), rj = Math.min(RR - 1, Math.max(0, Math.floor((1 - rv) * RR)));
      // a neighbourhood of the reference texel: the texel centres of the two bakes differ by up to a texel
      let rmin = 1, rmax = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const v2 = cb[Math.min(RR - 1, Math.max(0, rj + dj)) * RR + Math.min(RR - 1, Math.max(0, ri + di))]; rmin = Math.min(rmin, v2); rmax = Math.max(rmax, v2); }
      if (ca[q] > 0.9) { sure++; if (rmax < 0.3) bad++; } else if (ca[q] < 0.02) { sure++; if (rmin > 0.7) bad++; }
      if (ca[q] > 0.2) { litA++; if (chartB(u, v)) litB++; }
    }
    for (let q = 0; q < cb.length; q++) if (cb[q] > 0.2) litRef++;
    check(sure > 100000 && bad / sure < 0.002, `${label}: charts of different texel density agree with the one-chart surface in 3D (${sure} texels compared, ${bad} disagree)`);
    check(litA > 300 && litB > 100 && litB < litA - 100, `${label}: runs are painted on both sides of the seam (${litA - litB} texels in the first chart, ${litB} in the second; ${litRef} in the one-chart bake)`);
  };
  const facing = (c: number[][], dir: number[]): number[][] => {
    const a = c[0], b = c[1], d = c[2];
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], wx = d[0] - a[0], wy = d[1] - a[1], wz = d[2] - a[2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    return nx * dir[0] + ny * dir[1] + nz * dir[2] >= 0 ? c : c.slice().reverse();
  };
  const bolt = (x: number, y: number, z: number, hs = 0.015) => ({ name: 'bolt', polys: boxPolys(x - hs, y - hs, z - hs, x + hs, y + hs, z + hs) });
  const base = { sources: '@name=bolt', density: 150, wobble: 0.2, breakup: 0.3, seed: 2, padding: 0, length: [0.5, 0.5], width: [0.006, 0.008] };

  // (1) a fold between a wall and a slope below it (45°), two charts: the wall at 1.5 mm per texel, the slope at 2.9 mm
  {
    const A = (x: number, y: number) => [0.05 + x * (0.4 / 0.6), 0.5 + (y - 0.4) / 1.5];
    const S = 1 / Math.SQRT2;
    const Bq = (x: number, t: number) => [0.5 + x * (0.2 / 0.6), 0.45 - t / 3];
    const wallA = facing([[0, 0.4, 0], [0.6, 0.4, 0], [0.6, 1, 0], [0, 1, 0]], [0, 0, 1]);
    const slope = facing([[0, 0.4, 0], [0.6, 0.4, 0], [0.6, 0.4 - 0.3, 0.3], [0, 0.4 - 0.3, 0.3]], [0, S, S]);
    const uvA = wallA.map((p) => A(p[0], p[1])), uvB = slope.map((p) => Bq(p[0], Math.hypot(p[1] - 0.4, p[2])));
    const fold = build([{ name: 'wall', polys: [wallA, slope], uv: [uvA, uvB] }, bolt(0.3, 0.6, 0.0)], true);
    const refSlopeUv = slope.map((p) => { const t = Math.hypot(p[1] - 0.4, p[2]); return [0.05 + p[0] * (0.4 / 0.6), 0.5 - t / 1.5]; });
    const ref = build([{ name: 'wall', polys: [wallA, slope], uv: [uvA, refSlopeUv] }, bolt(0.3, 0.6, 0.0)], true);
    await compare('wall and slope', fold, ref,
      (u, v) => {
        if (u >= 0.05 && u <= 0.45 && v >= 0.5 && v <= 0.9) return [(u - 0.05) * 1.5, 0.4 + (v - 0.5) * 1.5, 0];
        const t = (0.45 - v) * 3;
        if (u >= 0.5 && u <= 0.7 && t >= 0 && t <= 0.424) return [(u - 0.5) * 3, 0.4 - t * S, t * S];
        return null;
      },
      (p) => (p[2] < 1e-9 ? [0.05 + p[0] * (0.4 / 0.6), 0.5 + (p[1] - 0.4) / 1.5] : [0.05 + p[0] * (0.4 / 0.6), 0.5 - (p[2] * Math.SQRT2) / 1.5]),
      base, (u) => u >= 0.5);
  }

  // (2) a cylinder cut into an upper and a lower ring, the lower at twice the texel density, against the cylinder unrolled as one chart
  {
    const R0 = 0.1, SIDES = 72;
    const ang = (i: number) => (i / SIDES) * 2 * Math.PI;
    const uvTop = (th: number, y: number) => [0.05 + (th / (2 * Math.PI)) * 0.45, 0.5 + (y - 0.5) * 0.8];
    const uvBot = (th: number, y: number) => [0.05 + (th / (2 * Math.PI)) * 0.9, 0.05 + y * 0.8];
    const uvOne = (th: number, y: number) => [0.05 + (th / (2 * Math.PI)) * 0.9, 0.05 + y * 0.9];
    const ring = (y0: number, y1: number, uvf: (th: number, y: number) => number[]) => {
      const polys: number[][][] = [], uv: number[][][] = [];
      for (let i = 0; i < SIDES; i++) {
        const t0 = ang(i), t1 = ang(i + 1);
        const c = [[R0 * Math.cos(t0), y0, R0 * Math.sin(t0)], [R0 * Math.cos(t0), y1, R0 * Math.sin(t0)], [R0 * Math.cos(t1), y1, R0 * Math.sin(t1)], [R0 * Math.cos(t1), y0, R0 * Math.sin(t1)]];
        const uvs = [uvf(t0, y0), uvf(t0, y1), uvf(t1, y1), uvf(t1, y0)];
        polys.push(c); uv.push(uvs);
      }
      return { polys, uv };
    };
    const th0 = (100 * Math.PI) / 180, bx = R0 * Math.cos(th0), bz = R0 * Math.sin(th0);
    const top = ring(0.5, 1, uvTop), bot = ring(0, 0.5, uvBot);
    const fold = build([{ name: 'cyl', polys: [...top.polys, ...bot.polys], uv: [...top.uv, ...bot.uv] }, bolt(bx, 0.75, bz)], true);
    const one = ring(0, 1, uvOne);
    // the single chart is one ring of tall quads: the same surface, no seam across the height
    const ref = build([{ name: 'cyl', polys: one.polys, uv: one.uv }, bolt(bx, 0.75, bz)], true);
    await compare('cylinder', fold, ref,
      (u, v) => {
        if (u >= 0.05 && u <= 0.5 && v >= 0.5 && v <= 0.9) { const th = ((u - 0.05) / 0.45) * 2 * Math.PI; return [R0 * Math.cos(th), 0.5 + (v - 0.5) / 0.8, R0 * Math.sin(th)]; }
        if (u >= 0.05 && u <= 0.95 && v >= 0.05 && v <= 0.45) { const th = ((u - 0.05) / 0.9) * 2 * Math.PI; return [R0 * Math.cos(th), (v - 0.05) / 0.8, R0 * Math.sin(th)]; }
        return null;
      },
      (p) => { let th = Math.atan2(p[2], p[0]); if (th < 0) th += 2 * Math.PI; return uvOne(th, p[1]); },
      { ...base, length: [0.45, 0.45] }, (u, v) => v < 0.5);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
