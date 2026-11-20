// bake_flow and core/runs.ts: runs that flow down a surface under gravity from source parts.
//   core: runs go straight down a box wall, follow a cylinder (standing and lying), stop and pool on a ledge, drip off an
//         overhang onto the surface below, follow another gravity, are the same for a seed and differ for another
//   node: a wall cut into many charts bakes texel for texel what the uncut wall bakes (runs cross uv seams unbroken), the
//         same bits with and without the worker pool, every refusal message, the layers, the example
//   node test/runs.ts
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { defineNode } from '../src/graph/registry.ts';
import { GeoBuilder, Geometry } from '../src/core/geometry.ts';
import { findImage } from '../src/core/image.ts';
import { sampleSources, traceRuns } from '../src/core/runs.ts';
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

/** Closed polygons from corner lists, with a prim name per part and optional per-corner uv. */
function build(parts: Part[], withUv = false): Geometry {
  const b = new GeoBuilder();
  const names: string[] = [], uvs: number[][] = [];
  for (const part of parts)
    part.polys.forEach((poly, i) => {
      b.addPrim(poly.map((p) => b.addPoint(p[0], p[1], p[2])));
      names.push(part.name);
      for (let k = 0; k < poly.length; k++) uvs.push(part.uv?.[i]?.[k] ?? [0, 0]);
    });
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

const PRM: FlowParams = { density: 40, direction: [0, -1, 0], length: [0.05, 0.25], width: [0.004, 0.012], wobble: 0, breakup: 0, ledge: 30, pool: 1.5, drip: true, step: 0, spill: 0, seed: 0 };
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
  // recorded from the build before spilling existed: with the reach at 0 the result is the same bit for bit
  check(hashA(none.runs) === '15:13:-913485494' && segsBelow(none.runs, 0).length === 0, `spill 0: the runs are those of the build before spilling (${hashA(none.runs)}), nothing below the ledge`);
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
const engines = { pool: new Engine(createNodeHost({ baseDir: tmp })), serial: new Engine(createNodeHost({ baseDir: tmp, workers: 0 })) };
await engines.pool.init(); await engines.serial.init();
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
store.set('uncut', sheet(false)); store.set('cut', sheet(true));
{
  const P = { sources: '@name=bolt', resolution: R, density: 200, wobble: 0.2, breakup: 0.5, seed: 3, padding: 0, length: [0.1, 0.2] };
  const A = await cookOn(engines.pool, flow('uncut', P), 'f'), B = await cookOn(engines.pool, flow('cut', P), 'f');
  check(A.ok && B.ok, `both cook${A.errors.concat(B.errors).join('; ')}`);
  const ia = findImage(A.geo!, 'f')!, ib = findImage(B.geo!, 'f')!;
  const ca = ia.layer('C')!, cb = ib.layer('C')!, ma = ia.layer('mask')!, mb = ib.layer('mask')!;
  let both = 0, bad = 0, maxd = 0, lit = 0;
  for (let b = 0; b < K; b++)
    for (let a = 0; a < K; a++)
      for (let j = 0; j < R; j++)
        for (let i = 0; i < R; i++) {
          const q = j * R + i;
          if (mb[q] < 1) continue;
          // the chart (a, b) is the uncut one shifted by GAP texels per step right and up
          const ja = j + b * GAP, ia2 = i - a * GAP;
          if (ia2 < 0 || ja < 0 || ia2 >= R || ja >= R) continue;
          const qa = ja * R + ia2;
          if (ma[qa] < 1) continue;
          // only the texels whose centre falls in this chart's own tile
          const x = ((ia2 + 0.5) / R) / SPAN * SIDE, y = ((R - ja - 0.5) / R) / SPAN * SIDE, t = SIDE / K;
          if (Math.floor(x / t) !== a || Math.floor(y / t) !== b) continue;
          both++;
          const d = Math.abs(cb[q] - ca[qa]);
          maxd = Math.max(maxd, d);
          if (d > 1e-3) bad++;
          if (ca[qa] > 0.5) lit++;
        }
  check(both > 100000 && lit > 100, `${both} texels compared, ${lit} of them on runs`);
  check(bad === 0, `the wall cut into ${K * K} charts bakes the uncut wall's runs texel for texel (${bad} differ by more than 0.001, largest ${maxd.toExponential(1)})`);
  // the runs really cross the seams: the plate sits on the x = 0.3 seam and the runs below it cross the y seams at 0.15 and 0.3
  let crossing = 0;
  for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) if (mb[j * R + i] >= 1 && cb[j * R + i] > 0.5) { const y = ((R - j - 0.5) / R) * SIDE / SPAN; void y; crossing++; }
  check(crossing > 200, `${crossing} run texels in the cut wall`);
  // the same bits with and without the worker pool, and with the same seed again
  const S = await cookOn(engines.serial, flow('cut', P), 'f');
  const eq = (x: Geometry, y: Geometry) => { const u = findImage(x, 'f')!, v = findImage(y, 'f')!; return [...u.layers.keys()].every((k) => v.layers.has(k) && u.layers.get(k)!.every((q, i) => q === v.layers.get(k)![i])); };
  check(eq(B.geo!, S.geo!), 'TOPOTOPO_WORKERS=0 (no pool): identical bits');
  const B2 = await cookOn(engines.pool, flow('cut', P), 'f');
  check(eq(B.geo!, B2.geo!), 'the same seed again: identical bits');
  const O = await cookOn(engines.pool, flow('cut', { ...P, seed: 4 }), 'f');
  check(!eq(B.geo!, O.geo!), 'another seed: other runs');
  // layers
  const names = [...ib.layers.keys()].sort().join(',');
  check(names === 'C,along,head,id,mask,strength', `layers ${names}`);
  const along = ib.layer('along')!, id = ib.layer('id')!, str = ib.layer('strength')!, head = ib.layer('head')!;
  let okLayers = true, ids = new Set<number>();
  for (let q = 0; q < R * R; q++) {
    if (mb[q] < 1) continue;
    if (cb[q] > 0) { ids.add(id[q]); if (!(id[q] >= 1 && along[q] >= 0 && along[q] <= 1 && str[q] > 0 && head[q] <= cb[q] + 1e-6)) okLayers = false; }
    else if (cb[q] === 0 && (id[q] !== 0 || head[q] !== 0 || along[q] !== 0)) okLayers = false;
  }
  check(okLayers && ids.size > 3, `along, head, strength and id hold where runs are and 0 elsewhere (${ids.size} runs seen)`);
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
