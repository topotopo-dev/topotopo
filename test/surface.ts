// bake_measure, the surface cloud, bake_curvature method surface, the shared rasterisation and bake_mask's attribute
// list. Checks what each promises: every measure the same on both sides of every uv seam (a cube and a cylinder cut into
// one chart per face, compared at the same 3D place); each measure against a known answer (facing on a box, height on
// a column, distance to a named part, shelter under a ledge, cavity in a groove, occlusion in a corner, 3D noise that
// does not change when the mesh is re-triangulated); surface curvature on a decimated sphere with a rim against the
// dihedral bake; islands smaller than a texel and hidden faces; inconsistent windings and normals; every refusal; the
// same bits with and without the worker pool and for a seed; one rasterisation shared by the bakes of one mesh.
//   node test/surface.ts
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { findImage } from '../src/core/image.ts';
import type { Image } from '../src/core/image.ts';
import { bakeMemoStats } from '../src/core/bake.ts';
import { CURVATURE_SCALE, OPEN_SHARE, runRays, surfaceCloud, surfaceMesh } from '../src/core/surface.ts';
import { KERNELS } from '../src/core/kernels.ts';
import { Geometry as Geo } from '../src/core/geometry.ts';
import { RayScene } from '../src/core/analysis.ts';
import { TriBVH } from '../src/core/spatial.ts';
import { triangulate } from '../src/core/topology.ts';
import type { GraphSpec, NodeSpec } from '../src/graph/types.ts';

let fail = 0, pass = 0;
const check = (ok: unknown, msg: string) => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
};
const section = (s: string) => console.log(`\n== ${s}`);
const f3 = (x: number) => x.toFixed(3);

type Nodes = Record<string, NodeSpec>;
const serial = new Engine(createNodeHost({ workers: 0 }));
await serial.init();
const pooled = new Engine(createNodeHost({ workers: 4, pool: { minElements: 1 } }));
await pooled.init();

type Geometry = Geo;
const Geometry = Geo;
interface Cooked { geo: Geometry; stats: Record<string, number>; warnings: string[] }
async function cook(nodes: Nodes, output: string, engine = serial, statsOf = output): Promise<Cooked> {
  const graph: GraphSpec = { nodes, output };
  const r = await engine.cook(graph);
  if (!r.ok || !r.geo) throw new Error(`cook failed: ${r.errors.map((x) => `[${x.node}] ${x.message}`).join('; ')}`);
  return { geo: r.geo, stats: (r.results.get(statsOf) as any)?.stats ?? {}, warnings: r.warnings.map((w) => w.message) };
}
/** The text of the error a cook ends with (message and hint), '' when it cooks. */
async function err(nodes: Nodes, output: string): Promise<string> {
  const r = await serial.cook({ nodes, output });
  return r.ok ? '' : r.errors.map((e) => e.message + (e.hint ? ` (${e.hint})` : '')).join('; ');
}
const img = (c: Cooked, name: string): Image => {
  const i = findImage(c.geo, name);
  if (!i) throw new Error(`no image "${name}"`);
  return i;
};
const same = (a: Float32Array, b: Float32Array) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
const layerNames = (im: Image) => [...im.layers.keys()];
/** A kernel runner on this thread (the core functions without the engine). */
const runHere = (kernel: string, job: any) => { KERNELS[kernel].run(job.args, { ...job.shared, ...job.inputs, ...job.results }, 0, job.count, { sharedKey: '', memo: (_k: string, make: () => any) => make() }); return null; };

/**
 * The covered texels of a bake with their world position (a bake_position of the same mesh and size): per texel index
 * its position and the values of the named layers.
 */
interface Texels { idx: number[]; P: Float32Array; im: Image; at(layer: string, k: number): number }
async function texels(nodes: Nodes, mesh: string, measure: NodeSpec, engine = serial): Promise<Texels & { c: Cooked }> {
  const res = (measure.params as any).resolution;
  const c = await cook({ ...nodes, m: measure, pos: { type: 'bake_position', in: [mesh], params: { resolution: res, mode: 'world', padding: 0 } }, both: { type: 'merge', in: ['m', 'pos'] } }, 'both', engine, 'm');
  const im = img(c, 'm'), pos = img(c, 'pos').layer('C')!, mask = im.layer('mask')!;
  const idx: number[] = [];
  for (let k = 0; k < mask.length; k++) if (mask[k] >= 1) idx.push(k);
  return { c, idx, P: pos, im, at: (layer, k) => im.layer(layer)![k] };
}
const pAt = (t: Texels, k: number): [number, number, number] => [t.P[k * 4], t.P[k * 4 + 1], t.P[k * 4 + 2]];

const named = (name: string, src: string, node: NodeSpec): Nodes => ({
  [src]: node,
  [name]: { type: 'wrangle', in: [src], params: { run_over: 'prims', code: `s@name = '${name}';` } },
});

// ---------------------------------------------------------------- seams

const ALL = (target: string): any[] => [
  { by: 'facing', name: 'facing' },
  { by: 'height', name: 'height' },
  { by: 'distance', name: 'dist', target, range: 0.6 },
  { by: 'noise', name: 'grain', size: [0.25, 0.25, 0.25] },
  { by: 'occlusion', name: 'occ', max_distance: 0.5 },
  { by: 'cavity', name: 'cav', max_distance: 0.1 },
  { by: 'shelter', name: 'shelter' },
  { by: 'visibility', name: 'vis' },
  { by: 'curvature', name: 'curv', radius: 0.08 },
];

/**
 * Pairs of covered texels on different islands within a quarter of the median texel of each other in 3D, on the same smooth region
 * (`region`, null = near an edge): the largest difference of every layer across them.
 */
function seamDiffs(t: Texels, layers: string[], region: (p: number[]) => number | null) {
  const texel = t.im.layer('texel')!, island = t.im.layer('island')!;
  const sizes = t.idx.map((k) => Math.max(texel[k * 4], texel[k * 4 + 1])).sort((x, y) => x - y);
  const size = sizes[sizes.length >> 1], h = 0.25 * size, grid = new Map<string, number[]>();
  const key = (x: number, y: number, z: number) => `${Math.floor(x / h)},${Math.floor(y / h)},${Math.floor(z / h)}`;
  for (const k of t.idx) { const p = pAt(t, k), s = key(p[0], p[1], p[2]); (grid.get(s) ?? grid.set(s, []).get(s)!).push(k); }
  const worst: Record<string, number> = Object.fromEntries(layers.map((l) => [l, 0]));
  let pairs = 0;
  for (const a of t.idx) {
    const pa = pAt(t, a), ra = region(pa);
    if (ra === null) continue;
    const cx = Math.floor(pa[0] / h), cy = Math.floor(pa[1] / h), cz = Math.floor(pa[2] / h);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const b of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
        if (b <= a || island[a] === island[b]) continue;
        const pb = pAt(t, b);
        if (Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]) > h || region(pb) !== ra) continue;
        pairs++;
        for (const l of layers) worst[l] = Math.max(worst[l], Math.abs(t.at(l, a) - t.at(l, b)));
      }
    }
  }
  return { pairs, worst, size };
}

section('seams: every measure the same on both sides of a uv seam');
{
  const ground = { type: 'box', params: { size: [3, 0.1, 3], center: [0, -0.05, 0] } } as NodeSpec;
  // a cube on the ground, one chart per face (16 per side), so seams run across every flat face
  const cube: Nodes = {
    c0: { type: 'box', params: { size: [1, 1, 1], center: [0, 0.5, 0], divisions: [4, 4, 4] } },
    c1: { type: 'wrangle', in: ['c0'], params: { run_over: 'prims', code: 'i@chart = @primnum;' } },
    cube: { type: 'uv_flatten', in: ['c1'], params: { chart_attrib: 'chart', resolution: 256, padding: 2 } },
    ground,
  };
  const t = await texels(cube, 'cube', { type: 'bake_measure', in: ['cube', 'ground'], params: { resolution: 256, padding: 0, samples: 32, measures: ALL('@P.y>0.99') } });
  // the face a point is on, null within 3 cm of an edge (values change fast there)
  const face = (p: number[]) => {
    const q = [p[0], p[1] - 0.5, p[2]].map(Math.abs), m = Math.max(...q), i = q.indexOf(m);
    return q.filter((x, j) => j !== i && x > 0.47).length ? null : i * 2 + ((i === 1 ? p[1] - 0.5 : p[i]) > 0 ? 1 : 0);
  };
  const layers = ALL('').map((m) => m.name);
  const d = seamDiffs(t, layers, face);
  check(d.pairs > 500, `cube: ${d.pairs} texel pairs across seams within a quarter texel (${(d.size * 250).toFixed(1)} mm) of each other`);
  for (const l of layers) check(d.worst[l] <= 0.02, `cube: ${l} differs by at most ${f3(d.worst[l])} across the seams (≤ 0.02)`);

  const cyl: Nodes = {
    y0: { type: 'tube', params: { radius: 0.4, height: 1, rows: 6, cols: 24, center: [0, 0.5, 0] } },
    y1: { type: 'wrangle', in: ['y0'], params: { run_over: 'prims', code: 'i@chart = @primnum;' } },
    cyl: { type: 'uv_flatten', in: ['y1'], params: { chart_attrib: 'chart', resolution: 256, padding: 2 } },
    ground,
  };
  const u = await texels(cyl, 'cyl', { type: 'bake_measure', in: ['cyl', 'ground'], params: { resolution: 256, padding: 0, samples: 32, measures: ALL('@P.y>0.99') } });
  // side, top cap; null near the rims and on the bottom (on the ground)
  const part = (p: number[]) => {
    const r = Math.hypot(p[0], p[2]);
    if (p[1] > 0.03 && p[1] < 0.97 && r > 0.36) return 0;
    if (p[1] > 0.99 && r < 0.36) return 1;
    return null;
  };
  const e = seamDiffs(u, layers, part);
  check(e.pairs > 500, `cylinder: ${e.pairs} texel pairs across seams`);
  for (const l of layers) check(e.worst[l] <= 0.02, `cylinder: ${l} differs by at most ${f3(e.worst[l])} across the seams (≤ 0.02)`);
}

// ---------------------------------------------------------------- known answers

const UVBOX: Nodes = {
  b0: { type: 'box', params: { size: [1, 1, 1], center: [0, 0.5, 0], divisions: [2, 2, 2] } },
  ubox: { type: 'uv_unwrap', in: ['b0'] },
};

section('facing on a box');
{
  const t = await texels(UVBOX, 'ubox', { type: 'bake_measure', in: ['ubox'], params: { resolution: 64, measures: [{ by: 'facing', name: 'up' }, { by: 'facing', name: 'flat', min: 0, max: 10 }] } });
  const by = (f: (p: number[]) => boolean, l: string) => t.idx.filter((k) => f(pAt(t, k))).map((k) => t.at(l, k));
  const top = by((p) => p[1] > 0.999, 'up'), side = by((p) => Math.abs(p[0]) > 0.499 && p[1] > 0.1 && p[1] < 0.9, 'up'), bot = by((p) => p[1] < 0.001, 'up');
  check(top.length && top.every((v) => Math.abs(v - 1) < 1e-3), `top reads 1 (${top.length} texels)`);
  check(side.length && side.every((v) => Math.abs(v - 0.5) < 1e-3), 'sides read 0.5');
  check(bot.length && bot.every((v) => v < 1e-3), 'bottom reads 0');
  const ft = by((p) => p[1] > 0.999, 'flat'), fs = by((p) => Math.abs(p[0]) > 0.499 && p[1] > 0.1 && p[1] < 0.9, 'flat');
  check(ft.every((v) => v === 1) && fs.every((v) => v === 0), 'a band of 0..10 degrees: 1 on the top, 0 on the sides');
}

section('height on a column');
{
  const col: Nodes = { c0: { type: 'tube', params: { radius: 0.1, height: 2, rows: 8, center: [0, 1, 0] } }, col: { type: 'uv_unwrap', in: ['c0'] } };
  const t = await texels(col, 'col', { type: 'bake_measure', in: ['col'], params: { resolution: 128, measures: [{ by: 'height' }, { by: 'height', name: 'band', min: 0.5, max: 1, falloff: 0.5 }] } });
  let worst = 0, bandWorst = 0;
  for (const k of t.idx) {
    const y = pAt(t, k)[1];
    worst = Math.max(worst, Math.abs(t.at('height', k) - y / 2));
    const want = y < 0.5 ? Math.max(0, 1 - (0.5 - y) / 0.5) : y > 1 ? Math.max(0, 1 - (y - 1) / 0.5) : 1;
    bandWorst = Math.max(bandWorst, Math.abs(t.at('band', k) - want));
  }
  check(worst < 1e-4, `height = y / 2 on a 2 m column (worst ${worst.toExponential(1)})`);
  check(bandWorst < 1e-4, `a band 0.5..1 m with 0.5 m falloff in metres (worst ${bandWorst.toExponential(1)})`);
}

// a 2 × 2 m plate with a 10 cm bolt standing on it at x = 0.3
const PLATE: Nodes = {
  ...named('plate', 'p0', { type: 'grid', params: { size: [2, 2], divisions: [8, 8] } }),
  ...named('bolt', 'q0', { type: 'box', params: { size: [0.1, 0.1, 0.1], center: [0.3, 0.05, 0] } }),
  pb: { type: 'merge', in: ['plate', 'bolt'] },
  pbuv: { type: 'uv_unwrap', in: ['pb'] },
};

section('distance to a named part');
{
  const t = await texels(PLATE, 'pbuv', { type: 'bake_measure', in: ['pbuv'], params: { resolution: 128, measures: [{ by: 'distance', name: 'near', target: '@name=bolt', range: 0.5 }] } });
  let worst = 0, n = 0;
  for (const k of t.idx) {
    const [x, y, z] = pAt(t, k);
    if (Math.abs(y) > 1e-4) continue;
    const dx = Math.max(0.25 - x, 0, x - 0.35), dz = Math.max(-0.05 - z, 0, z - 0.05), d = Math.hypot(dx, dz);
    if (d === 0) continue;
    n++;
    worst = Math.max(worst, Math.abs(t.at('near', k) - Math.max(0, 1 - d / 0.5)));
  }
  check(n > 1000 && worst < 1e-3, `1 − distance / range to the bolt's box on ${n} plate texels (worst ${worst.toExponential(1)})`);
}

section('shelter under a ledge');
{
  const nodes: Nodes = {
    f0: { type: 'grid', params: { size: [2, 2], divisions: [8, 8] } },
    floor: { type: 'uv_unwrap', in: ['f0'] },
    // a ledge 0.475 m up from x = -1.2 to 0.2: a 45° cone from under its middle stays under it
    ledge: { type: 'box', params: { size: [1.4, 0.05, 3], center: [-0.5, 0.5, 0] } },
  };
  const t = await texels(nodes, 'floor', { type: 'bake_measure', in: ['floor', 'ledge'], params: { resolution: 64, measures: [{ by: 'shelter', cone: 45 }] } });
  const under = t.idx.filter((k) => { const p = pAt(t, k); return p[0] > -0.6 && p[0] < -0.4 && Math.abs(p[2]) < 0.4; }).map((k) => t.at('shelter', k));
  const open = t.idx.filter((k) => pAt(t, k)[0] > 0.75).map((k) => t.at('shelter', k));
  check(under.length && Math.min(...under) > 0.97, `under the ledge: covered (min ${f3(Math.min(...under))})`);
  check(open.length && Math.max(...open) < 0.03, `beside it: open (max ${f3(Math.max(...open))})`);
  const wall = await texels({ w0: { type: 'grid', params: { size: [1, 1], plane: 'xy', center: [0, 0.5, 0] } }, wall: { type: 'uv_unwrap', in: ['w0'] } }, 'wall', { type: 'bake_measure', in: ['wall'], params: { resolution: 32, measures: [{ by: 'shelter' }] } });
  const wv = wall.idx.map((k) => wall.at('shelter', k));
  check(wv.every((v) => Math.abs(v - 0.5) < 0.002), `an open vertical wall: half the cone is behind it, without ray noise (${f3(Math.min(...wv))}..${f3(Math.max(...wv))}, 0.5)`);
}

section('a coarse faceted sphere is open (no shadow terminator)');
{
  // 8 × 16 facets with smooth normals: rays in front of the normal but behind a facet must not hit its neighbours
  const nodes: Nodes = { c0: { type: 'sphere', params: { radius: 0.5, rows: 8, cols: 16 } }, c1: { type: 'normal', in: ['c0'], params: { cusp_angle: 180 } }, cs: { type: 'uv_unwrap', in: ['c1'] } };
  const t = await texels(nodes, 'cs', { type: 'bake_measure', in: ['cs'], params: { resolution: 128, measures: [{ by: 'occlusion', max_distance: 0 }, { by: 'shelter', cone: 60, direction: [1, 0, 0] }] } });
  const occ = t.idx.map((k) => t.at('occlusion', k));
  check(Math.min(...occ) > 0.999, `occlusion reads open everywhere (min ${f3(Math.min(...occ))})`);
  // facing the shelter direction square on, the whole cone is in front and nothing covers it
  const front = t.idx.filter((k) => { const p = pAt(t, k); return p[0] > 0.45 && Math.hypot(p[1], p[2]) < 0.1; }).map((k) => t.at('shelter', k));
  check(front.length && Math.max(...front) < 0.001, `shelter facing its direction reads 0 (max ${f3(Math.max(...front))})`);
}

section('cavity in a groove');
{
  const nodes: Nodes = {
    a: { type: 'box', params: { size: [0.5, 0.2, 1], center: [-0.255, 0.1, 0] } },
    b: { type: 'box', params: { size: [0.5, 0.2, 1], center: [0.255, 0.1, 0] } },
    ab: { type: 'merge', in: ['a', 'b'] },
    gr: { type: 'uv_unwrap', in: ['ab'] },
  };
  const t = await texels(nodes, 'gr', { type: 'bake_measure', in: ['gr'], params: { resolution: 256, measures: [{ by: 'cavity', max_distance: 0.02 }] } });
  const walls = t.idx.filter((k) => { const p = pAt(t, k); return Math.abs(Math.abs(p[0]) - 0.005) < 1e-4 && p[1] > 0.03 && p[1] < 0.17 && Math.abs(p[2]) < 0.45; }).map((k) => t.at('cavity', k));
  const tops = t.idx.filter((k) => { const p = pAt(t, k); return p[1] > 0.199 && Math.abs(p[0]) > 0.1 && Math.abs(p[0]) < 0.4 && Math.abs(p[2]) < 0.4; }).map((k) => t.at('cavity', k));
  const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
  // a wall 1 cm from a parallel wall, limit 2 cm: the rays within 60° of the normal hit at 1 cm / cos θ, so the
  // cosine-weighted mean of 1 − t / 2 cm is ∫ from 0.5 to 1 of (2c − 1) dc = 0.25
  check(walls.length > 50 && Math.abs(mean(walls) - 0.25) < 0.03, `the groove's walls: ${f3(mean(walls))} (0.25 between two endless walls; ${walls.length} texels)`);
  check(tops.length && Math.max(...tops) < 0.01, `the open top reads 0 (max ${f3(Math.max(...tops))})`);
}

section('occlusion in a corner');
{
  const nodes: Nodes = {
    fl: { type: 'grid', params: { size: [2, 2], divisions: [8, 8] } },
    fluv: { type: 'uv_unwrap', in: ['fl'] },
    wall: { type: 'grid', params: { size: [2, 2], plane: 'yz', center: [-1, 1, 0], divisions: [4, 4] } },
  };
  const t = await texels(nodes, 'fluv', { type: 'bake_measure', in: ['fluv', 'wall'], params: { resolution: 128, samples: 64, measures: [{ by: 'occlusion', max_distance: 100 }] } });
  const along = (x0: number, x1: number) => { const v = t.idx.filter((k) => { const p = pAt(t, k); return p[0] >= x0 && p[0] < x1 && Math.abs(p[2]) < 0.3; }).map((k) => t.at('occlusion', k)); return v.reduce((s, x) => s + x, 0) / v.length; };
  const corner = along(-1, -0.95), mid = along(-0.2, 0), far = along(0.8, 1);
  // at the foot of a wall 2 m high and 2 m wide, about half the cosine-weighted hemisphere is behind it
  check(corner > 0.45 && corner < 0.6, `at the corner about half is open (${f3(corner)})`);
  check(corner < mid && mid < far && far > 0.85, `opens up away from the wall (${f3(corner)} < ${f3(mid)} < ${f3(far)})`);
}

section('3D noise: continuous and the same on a re-triangulated mesh');
{
  const base: Nodes = { n0: { type: 'box', params: { size: [1, 1, 1] } }, nuv: { type: 'uv_unwrap', in: ['n0'] }, sub: { type: 'subdivide', in: ['nuv'], params: { method: 'linear', levels: 2 } }, tri: { type: 'triangulate', in: ['sub'] } };
  const m = (src: string): NodeSpec => ({ type: 'bake_measure', in: [src], params: { resolution: 128, measures: [{ by: 'noise', size: [0.2, 0.2, 0.2] }] } });
  const a = img(await cook({ ...base, m: m('nuv') }, 'm'), 'm'), b = img(await cook({ ...base, m: m('tri') }, 'm'), 'm');
  const ma = a.layer('mask')!, mb = b.layer('mask')!, va = a.layer('noise')!, vb = b.layer('noise')!;
  let worst = 0, n = 0;
  for (let k = 0; k < ma.length; k++) if (ma[k] >= 1 && mb[k] >= 1) { n++; worst = Math.max(worst, Math.abs(va[k] - vb[k])); }
  check(n > 1000 && worst < 1e-4, `a box and the same box subdivided and triangulated (same uv): equal on ${n} texels (worst ${worst.toExponential(1)})`);
}

// ---------------------------------------------------------------- surface curvature

section('surface curvature on a decimated sphere with a rim');
{
  const nodes: Nodes = {
    s0: { type: 'sphere', params: { radius: 0.5, rows: 48, cols: 96 } },
    s1: { type: 'clip', in: ['s0'], params: { origin: [0, 0.25, 0], keep: 'below', cap: true } },
    s2: { type: 'decimate', in: ['s1'], params: { ratio: 0.25 } },
    s3: { type: 'normal', in: ['s2'], params: { cusp_angle: 45 } },
    sph: { type: 'uv_unwrap', in: ['s3'] },
  };
  const g = (await cook(nodes, 'sph')).geo;
  // median edge length of the decimated sphere
  const L: number[] = [];
  for (let p = 0; p < g.numPrims; p++) {
    const s = g.primStart[p], e = g.primStart[p + 1];
    for (let v = s; v < e; v++) { const a = g.vertexPoint[v] * 3, b = g.vertexPoint[v + 1 < e ? v + 1 : s] * 3; L.push(Math.hypot(g.P[a] - g.P[b], g.P[a + 1] - g.P[b + 1], g.P[a + 2] - g.P[b + 2])); }
  }
  L.sort((x, y) => x - y);
  const edge = L[L.length >> 1];
  const read = async (method: string, r: number) => {
    const t = await texels(nodes, 'sph', { type: 'bake_curvature', in: ['sph'], params: { resolution: 512, radius: r, method } });
    const ball: number[] = [], rim: number[] = [];
    for (const k of t.idx) {
      const p = pAt(t, k), rr = Math.hypot(p[0], p[2]);
      // the sphere well away from the rim (y = 0.25, horizontal radius 0.433), the rim within 3 mm
      if (p[1] < 0.25 - 1.2 * r - 0.05 && p[1] > -0.4) ball.push(t.im.layer('C')![k]);
      if (Math.abs(p[1] - 0.25) < 0.003 && Math.abs(rr - 0.433) < 0.006) rim.push(t.im.layer('C')![k]);
    }
    const mean = ball.reduce((s, x) => s + x, 0) / ball.length;
    const sd = Math.sqrt(ball.reduce((s, x) => s + (x - mean) ** 2, 0) / ball.length);
    return { mean, sd, rim: rim.reduce((s, x) => s + x, 0) / rim.length };
  };
  const r = 2 * edge, rs = edge / 2;
  const sf = await read('surface', r), dh = await read('dihedral', r), sfs = await read('surface', rs), dhs = await read('dihedral', rs);
  console.log(`  median edge ${(edge * 1000).toFixed(0)} mm. radius ${(r * 1000).toFixed(0)} mm: surface sphere ${f3(sf.mean)} ± ${f3(sf.sd)}, rim ${f3(sf.rim)}; dihedral sphere ${f3(dh.mean)} ± ${f3(dh.sd)}, rim ${f3(dh.rim)}. radius ${(rs * 1000).toFixed(0)} mm: surface ${f3(sfs.mean)} ± ${f3(sfs.sd)}, dihedral ${f3(dhs.mean)} ± ${f3(dhs.sd)}`);
  // a sphere of radius R: (n_q − n)·(q − p) = |q − p|² / R, so the value is c · M · r / R with M the weighted mean of
  // d² / (d² + ε²) over the disc
  const e2 = 1 / 36;
  let M = 0, W = 0;
  for (let i = 0; i < 4000; i++) { const x = (i + 0.5) / 4000, w = (1 - x * x) ** 2 * x; M += w * x * x / (x * x + e2); W += w; }
  const want = (rr: number) => 0.5 + 0.5 * CURVATURE_SCALE * (M / W) * (rr / 0.5);
  check(Math.abs(sf.mean - want(r)) < 0.04, `surface, radius 2 × edge: the sphere reads its curvature (${f3(sf.mean)}, expected ${f3(want(r))})`);
  check(sf.sd < 0.03, `surface, radius 2 × edge: no facets on the sphere (spread ${f3(sf.sd)})`);
  check(sf.rim > sf.mean + 0.08, `surface, radius 2 × edge: the rim reads as an edge (${f3(sf.rim)} against ${f3(sf.mean)})`);
  check(sfs.sd < 0.03 && Math.abs(sfs.mean - want(rs)) < 0.04, `surface, radius half an edge: smooth and its curvature (${f3(sfs.mean)} ± ${f3(sfs.sd)}, expected ${f3(want(rs))})`);
  check(dhs.sd > 2 * sfs.sd, `dihedral, radius half an edge: the facets show as lines (spread ${f3(dhs.sd)}, more than twice the surface method's ${f3(sfs.sd)})`);
  check(CURVATURE_SCALE > 1.5 && CURVATURE_SCALE < 1.65, `the calibration: a 90° edge reads 1 (scale ${f3(CURVATURE_SCALE)})`);
  // a 90° box edge reads 1 at the edge, as the dihedral bake
  const t = await texels(UVBOX, 'ubox', { type: 'bake_curvature', in: ['ubox'], params: { resolution: 256, radius: 0.05, method: 'surface' } });
  const at = t.idx.filter((k) => { const p = pAt(t, k); return Math.abs(p[1] - 1) < 1e-4 && Math.abs(Math.abs(p[0]) - 0.5) < 0.002 && Math.abs(p[2]) < 0.3; }).map((k) => t.im.layer('convex')![k]);
  const flat = t.idx.filter((k) => { const p = pAt(t, k); return Math.abs(p[1] - 1) < 1e-4 && Math.abs(p[0]) < 0.3 && Math.abs(p[2]) < 0.3; }).map((k) => t.im.layer('C')![k]);
  const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
  check(at.length && mean(at) > 0.85, `a 90° box edge reads about 1 at the edge (${f3(mean(at))})`);
  check(flat.length && flat.every((v) => Math.abs(v - 0.5) < 0.01), 'the middle of a box face reads 0.5 (flat)');
  // a post through the box's top: its buried faces are another part and do not bend the top around it
  const post = await texels({ ...UVBOX, p0: { type: 'box', params: { size: [0.1, 1, 0.1], center: [0, 1, 0] } }, pb: { type: 'merge', in: ['ubox', 'p0'] }, pbu: { type: 'uv_unwrap', in: ['pb'] } }, 'pbu',
    { type: 'bake_curvature', in: ['pbu'], params: { resolution: 256, radius: 0.05, method: 'surface' } });
  const ring = post.idx.filter((k) => { const p = pAt(post, k); const d = Math.max(Math.abs(p[0]), Math.abs(p[2])); return Math.abs(p[1] - 1) < 1e-4 && d > 0.06 && d < 0.1; }).map((k) => post.im.layer('C')![k]);
  check(ring.length > 20 && ring.every((v) => Math.abs(v - 0.5) < 0.01), `a post through the top: the top around it stays flat (${ring.length} texels, ${f3(Math.min(...ring))}..${f3(Math.max(...ring))})`);
  check((await err({ ...UVBOX, hi: { type: 'sphere' }, c: { type: 'bake_curvature', in: ['ubox', 'hi'], params: { resolution: 32, method: 'surface' } } }, 'c')).includes('method surface reads the mesh\'s own shading normals; a high-res input 1 is not read'), 'method surface refuses a high-res input');
}

// ---------------------------------------------------------------- small islands, hidden faces, normals

section('islands smaller than a texel and hidden faces');
{
  const nodes: Nodes = {
    h0: { type: 'box', params: { size: [1, 1, 1], center: [0, 0.5, 0], divisions: [3, 3, 3] } },
    h1: { type: 'wrangle', in: ['h0'], params: { run_over: 'prims', code: 'f@texel_weight = @P.y < 0.01 ? 0.00001 : 1;' } },
    hb: { type: 'uv_unwrap', in: ['h1'] },
    ground: { type: 'box', params: { size: [3, 0.1, 3], center: [0, -0.05, 0] } },
  };
  const t = await texels(nodes, 'hb', { type: 'bake_measure', in: ['hb', 'ground'], params: { resolution: 128, measures: [{ by: 'visibility' }, { by: 'occlusion' }, { by: 'curvature', radius: 0.05 }] } });
  // the core: every triangle has cloud points, and the bottom's read hidden from the cloud itself
  const g = (await cook(nodes, 'hb')).geo, { tris, triPrim } = triangulate(g);
  const uv = new Float64Array(g.numVertices * 2), ua = g.vertices.get('uv') ?? g.points.get('uv')!;
  for (let v = 0; v < g.numVertices; v++) { const i = (g.vertices.get('uv') ? v : g.vertexPoint[v]) * ua.size; uv[v * 2] = (ua.data as any)[i]; uv[v * 2 + 1] = (ua.data as any)[i + 1]; }
  const mesh = surfaceMesh(g, tris, triPrim, uv, null, 128, 128), sc = surfaceCloud(mesh, tris, uv, null, 128, 128, 4);
  const nt = tris.length / 3, tiny: number[] = [];
  for (let t = 0; t < nt; t++) if (Math.max(mesh.triTexel[t * 2], mesh.triTexel[t * 2 + 1]) > 0.33 || mesh.triTexel[t * 2] === 0) tiny.push(t);
  let everyTri = true;
  for (let t = 0; t < nt; t++) if (sc.cloud.start[t + 1] <= sc.cloud.start[t]) everyTri = false;
  check(tiny.length >= 18 && everyTri, `${tiny.length} triangles get less than a texel; every one of the ${nt} triangles has cloud points (${sc.cloud.n} in all)`);
  const ground = (await cook(nodes, 'ground')).geo;
  const scene = RayScene.of(Geometry.merge([g, ground]));
  const rays = await runRays(runHere, sc, scene, new TriBVH(ground), { samples: 16, bias: 1e-4, seed: 0, hemi: [{ kind: 'visibility', maxD: 0 }], cones: [], contact: 2e-4 });
  let hidden = true, pts = 0;
  for (const t of tiny) for (let k = sc.cloud.start[t]; k < sc.cloud.start[t + 1]; k++) { pts++; if (rays[sc.cloud.pts[k]] > 0.05) hidden = false; }
  check(pts > 0 && hidden, `their ${pts} cloud points, flat on the ground, read hidden`);
  const bottom = t.idx.filter((k) => { const p = pAt(t, k); return p[1] < 0.001 && Math.abs(p[0]) < 0.49 && Math.abs(p[2]) < 0.49; });
  check(bottom.every((k) => t.at('visibility', k) < 0.05 && t.at('occlusion', k) < 0.05), `the bottom's texels, where it got any (${bottom.length}), read hidden`);
  let finite = true;
  for (const l of ['visibility', 'occlusion', 'curvature', 'C', 'texel', 'island']) for (const v of t.im.layer(l)!) if (!Number.isFinite(v)) finite = false;
  check(finite, 'every value is finite');
  const sides = t.idx.filter((k) => { const p = pAt(t, k); return Math.abs(p[0]) > 0.499 && p[1] > 0.3; });
  check(sides.every((k) => t.at('visibility', k) > 0.99), 'the sides read seen');
  check(t.c.stats.cloud_points > 0, `stat cloud_points (${t.c.stats.cloud_points})`);
}

section('inconsistent windings and normals');
{
  const ms = [{ by: 'facing' }, { by: 'occlusion' }, { by: 'curvature', radius: 0.1 }];
  const bake = (src: string): NodeSpec => ({ type: 'bake_measure', in: [src], params: { resolution: 64, measures: ms } });
  const ok = await cook({ ...UVBOX, m: bake('ubox') }, 'm');
  const turned = await cook({ ...UVBOX, rv: { type: 'reverse', in: ['ubox'], params: { group: '@P.y>0.99' } }, m: bake('rv') }, 'm');
  const a = img(ok, 'm'), b = img(turned, 'm');
  let worst = 0;
  for (const l of ['facing', 'occlusion', 'curvature']) { const x = a.layer(l)!, y = b.layer(l)!; for (let i = 0; i < x.length; i++) worst = Math.max(worst, Math.abs(x[i] - y[i])); }
  check(worst < 1e-6, `a box with its top faces reversed measures as the box (worst ${worst.toExponential(1)})`);
  check(turned.warnings.some((w) => /^bake_measure: 4 face\(s\) are wound against their neighbours or their normals; they are measured turned$/.test(w)), `reported: ${turned.warnings.join(' | ')}`);
  const inside = await cook({ ...UVBOX, rv: { type: 'reverse', in: ['ubox'] }, m: bake('rv') }, 'm');
  check(inside.warnings.some((w) => w.includes('1 closed piece(s) face inward (normals into the solid)')), `a box turned inside out is reported, not turned: ${inside.warnings.join(' | ')}`);
  const fi = img(inside, 'm').layer('facing')!, fo = a.layer('facing')!, mk = a.layer('mask')!;
  let flipped = true;
  for (let i = 0; i < fi.length; i++) if (mk[i] >= 1 && Math.abs(fi[i] - (1 - fo[i])) > 1e-5) flipped = false;
  check(flipped, 'the inside-out box is measured as it faces (facing reads 1 − the box\'s)');
  // authored normals against the faces: the normals win (the box is measured inward and reported)
  const nAgainst = await cook({ ...UVBOX, nn: { type: 'normal', in: ['ubox'] }, nf: { type: 'wrangle', in: ['nn'], params: { run_over: 'vertices', code: 'v@N = set(-v@N.x, -v@N.y, -v@N.z);' } }, m: bake('nf') }, 'm');
  check(nAgainst.warnings.some((w) => w.includes('face inward')), 'normals that point into a box turn it with them, and it is reported');
  // two parts, one inside the other (an inner shell facing inward on purpose) is not reported
  const nested = await cook({
    o0: { type: 'box', params: { size: [1, 1, 1] } }, i0: { type: 'box', params: { size: [0.5, 0.5, 0.5] } }, i1: { type: 'reverse', in: ['i0'] },
    nb: { type: 'merge', in: ['o0', 'i1'] }, nuv: { type: 'uv_unwrap', in: ['nb'] }, m: bake('nuv'),
  }, 'm');
  check(!nested.warnings.some((w) => w.includes('face inward')), 'an inward shell inside an outward one is not reported');
}

// ---------------------------------------------------------------- refusals

section('refusals');
{
  const bm = (measures: any, extra: Nodes = {}, ins = ['ubox']) => err({ ...UVBOX, ...extra, m: { type: 'bake_measure', in: ins, params: { resolution: 32, measures } } }, 'm');
  const has = async (p: Promise<string>, want: string) => { const e = await p; check(e.includes(want), `"${want}"${e.includes(want) ? '' : ` — got: ${e}`}`); };
  await has(bm([{ by: 'slope' }]), 'bake_measure: unknown measure "slope"');
  await has(bm([{ by: 'slope' }]), 'measures: facing, height, distance, noise, occlusion, cavity, shelter, visibility, curvature, group');
  await has(err({ ...PLATE, m: { type: 'bake_measure', in: ['pbuv'], params: { resolution: 32, measures: [{ by: 'distance', name: 'near_bolts', target: '@name=bolt*x' }] } } }, 'm'), 'bake_measure: measure "near_bolts": target "@name=bolt*x" matches no prims (parts: plate, bolt)');
  await has(bm([{ by: 'distance', name: 'near_wall', target: 'input1' }]), 'bake_measure: measure "near_wall": target "input1" but input 1 is empty');
  await has(bm([{ by: 'facing', name: 'top' }, { by: 'height', name: 'top' }]), 'bake_measure: two measures write layer "top"');
  await has(bm([{ by: 'facing', name: 'top', direction: [0, 0, 0] }]), 'bake_measure: measure "top": direction is the zero vector');
  await has(bm([{ by: 'noise', name: 'grain', size: [0.1, 0, 0.1] }]), 'bake_measure: measure "grain": noise size must be above 0 on every axis');
  await has(bm([{ by: 'facing', radius: 2 }]), 'bake_measure: measure "facing": field "radius" does not apply to facing');
  await has(bm([{ by: 'facing', directon: [0, 1, 0] }]), 'bake_measure: measure "facing": unknown field "directon" (did you mean "direction"?');
  await has(bm([{ by: 'occlusion', name: 'mask' }]), 'bake_measure: measure name "mask" is reserved');
  await has(bm([{ by: 'occlusion', name: 'my layer' }]), 'bake_measure: measure name "my layer" is not a layer name');
  await has(bm([{ by: 'distance' }]), 'bake_measure: measure "distance": distance needs a target');
  await has(bm([]), 'bake_measure: measures is empty');
  await has(bm([{ by: 'occlusion', samples: 3 }]), 'unknown field "samples"');
  await has(bm([{ by: 'facing', min: 'low' }]), 'bake_measure: measure "facing": field "min" expects a number');
  const small: Nodes = { s0: { type: 'box', params: { size: [0.1, 0.1, 0.1] } }, sb: { type: 'uv_unwrap', in: ['s0'] } };
  const w = await cook({ ...small, m: { type: 'bake_measure', in: ['sb'], params: { resolution: 256, spacing: 0.003, measures: [{ by: 'curvature', radius: 0.002 }] } } }, 'm');
  check(w.warnings.includes('bake_measure: curvature radius 2 mm is below the cloud spacing 3 mm; raise radius or lower spacing'), `warning: ${w.warnings.join(' | ')}`);
}

// ---------------------------------------------------------------- determinism, outputs, sharing

section('the same bits with and without the pool, for a seed');
{
  const nodes: Nodes = { ...PLATE, ground: { type: 'box', params: { size: [3, 0.1, 3], center: [0, -0.06, 0] } } };
  const ms = [...ALL('@name=bolt'), { by: 'group', name: 'part', pattern: '@name=bolt' }];
  const bake = (seed: number): Nodes => ({ ...nodes, m: { type: 'bake_measure', in: ['pbuv', 'ground'], params: { resolution: 128, samples: 16, seed, measures: ms } } });
  const a = img(await cook(bake(3), 'm', serial), 'm'), b = img(await cook(bake(3), 'm', pooled), 'm'), c = img(await cook(bake(4), 'm', serial), 'm');
  const layers = ['C', ...ms.map((m) => m.name), 'texel', 'island', 'mask'];
  check(layers.every((l) => same(a.layer(l)!, b.layer(l)!)), `every layer bit-identical on the cooking thread and on 4 workers (${layers.join(', ')})`);
  check(!same(a.layer('occ')!, c.layer('occ')!) && !same(a.layer('grain')!, c.layer('grain')!), 'another seed moves the rays and the noise');
  check(same(a.layer('facing')!, c.layer('facing')!) && same(a.layer('dist')!, c.layer('dist')!), '… and not facing or distance');
  check(same(a.layer('C')!, a.layer('facing')!), 'C is the first measure');
  check(JSON.stringify(layerNames(a)) === JSON.stringify(['C', ...ms.map((m) => m.name), 'texel', 'island', 'mask']), 'layers: C, one per measure in order, texel, island, mask');
  check(OPEN_SHARE === 0.25, 'visibility: a quarter of the hemisphere open counts as fully seen');
}

section('one rasterisation shared by the bakes of a mesh; bake_mask attribute list');
{
  const nodes: Nodes = {
    ...UVBOX,
    w1: { type: 'attrib_create', in: ['ubox'], params: { name: 'wear', class: 'prim', value: 0.25 } },
    w2: { type: 'attrib_create', in: ['w1'], params: { name: 'dirt', class: 'prim', value: 0.75 } },
    ao: { type: 'bake_ao', in: ['w2'], params: { resolution: 64, samples: 4 } },
    mk: { type: 'bake_mask', in: ['w2'], params: { resolution: 64, attrib: 'wear, dirt' } },
    one: { type: 'bake_mask', in: ['w2'], params: { resolution: 64, attrib: 'dirt' } },
    m: { type: 'bake_measure', in: ['w2'], params: { resolution: 64, measures: [{ by: 'facing' }] } },
    all: { type: 'merge', in: ['ao', 'mk', 'one', 'm'] },
  };
  const before = { ...bakeMemoStats };
  const c = await cook(nodes, 'all');
  check(bakeMemoStats.reused - before.reused >= 3, `four bakes of one mesh at one size rasterise it once (${bakeMemoStats.made - before.made} made, ${bakeMemoStats.reused - before.reused} reused)`);
  const mk = img(c, 'mk'), one = img(c, 'one'), msk = mk.layer('mask')!;
  let ok = true;
  for (let i = 0; i < msk.length; i++) if (msk[i] >= 1 && (mk.layer('wear')![i] !== 0.25 || mk.layer('dirt')![i] !== 0.75 || mk.layer('C')![i] !== 0.25)) ok = false;
  check(ok, 'bake_mask attrib "wear, dirt": a layer per attribute, C = the first');
  const names = layerNames(one);
  check(JSON.stringify(names) === JSON.stringify(['C', 'mask']), `one attribute is unchanged: layers ${names.join(', ')}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
