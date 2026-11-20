// bake_measure, the surface cloud, bake_curvature method surface, the shared rasterisation and bake_mask's attribute
// list. Checks what each promises: every measure the same on both sides of every uv seam (a cube and a cylinder cut into
// one chart per face, compared at the same 3D place); each measure against a known answer (facing on a box, height on
// a column, distance to a named part, shelter under a ledge, cavity in a groove, occlusion in a corner, 3D noise that
// does not change when the mesh is re-triangulated); occlusion up to a concave crease and a contact line against
// bake_ao; points inside another part (buried) never reaching a texel that is seen; the contact rule one-sided; surface
// curvature on a decimated sphere with a rim against the dihedral bake, the same at any texel density, concave where
// parts meet, thinned within tolerance; islands smaller than a texel, triangles with no uv area and hidden faces;
// inconsistent windings and normals; every refusal and the time limit; the same bits with and without the worker pool,
// at two sizes and worker counts, for a seed, from the memo and for two prim orders; one rasterisation shared by the
// bakes of one mesh; the memo's limits; a time bound that catches rays per texel.
//   node test/surface.ts
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { findImage } from '../src/core/image.ts';
import type { Image } from '../src/core/image.ts';
import { bakeMemoLimits, bakeMemoStats, bakeMemoUsage, memoBake } from '../src/core/bake.ts';
import { CURVATURE_SCALE, CURVATURE_THIN, OPEN_SHARE, runCurvature, runRays, surfaceCloud, surfaceMesh } from '../src/core/surface.ts';
import { KERNELS } from '../src/core/kernels.ts';
import { Geometry as Geo } from '../src/core/geometry.ts';
import { RayScene } from '../src/core/analysis.ts';
import { TriBVH } from '../src/core/spatial.ts';
import { triangulate } from '../src/core/topology.ts';
import type { GraphSpec, NodeSpec } from '../src/graph/types.ts';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

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
const pooled2 = new Engine(createNodeHost({ workers: 2, pool: { minElements: 1 } }));
await pooled2.init();

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
const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
/** The mean of the values whose key falls in each [edges[i], edges[i + 1]). */
const bins = (vals: [number, number][], edges: number[]) => edges.slice(0, -1).map((lo, i) => mean(vals.filter(([d]) => d >= lo && d < edges[i + 1]).map(([, x]) => x)));
const fmt = (v: number[]) => v.map(f3).join(' / ');
/** Several bakes of one mesh and a bake_position of it, cooked together: name → image ('pos' the positions). */
async function bakes(nodes: Nodes, mesh: string, res: number, list: Record<string, NodeSpec>, engine = serial): Promise<Record<string, Image>> {
  const names = Object.keys(list);
  const all: Nodes = { ...nodes, ...list, pos: { type: 'bake_position', in: [mesh], params: { resolution: res, mode: 'world', padding: 0 } }, all: { type: 'merge', in: ['pos', ...names] } };
  const c = await cook(all, 'all', engine);
  return Object.fromEntries(['pos', ...names].map((k) => [k, img(c, k)]));
}
/** The cloud of a cooked mesh at `res` and grid step k (the core functions without a node). */
function cloudOfGeo(g: Geometry, res: number, k: number) {
  const { tris, triPrim } = triangulate(g);
  const uv = new Float64Array(g.numVertices * 2), ua = g.vertices.get('uv') ?? g.points.get('uv')!;
  for (let v = 0; v < g.numVertices; v++) { const i = (g.vertices.get('uv') ? v : g.vertexPoint[v]) * ua.size; uv[v * 2] = (ua.data as any)[i]; uv[v * 2 + 1] = (ua.data as any)[i + 1]; }
  const mesh = surfaceMesh(g, tris, triPrim, uv, null, res, res);
  return { tris, uv, mesh, sc: surfaceCloud(mesh, tris, uv, null, res, res, k) };
}

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
 * (`region` of a texel's position and index, null = left out): the largest difference of every layer across them.
 */
function seamDiffs(t: Texels, layers: string[], region: (p: number[], k: number) => number | null) {
  const texel = t.im.layer('texel')!, island = t.im.layer('island')!;
  const sizes = t.idx.map((k) => Math.max(texel[k * 4], texel[k * 4 + 1])).sort((x, y) => x - y);
  const size = sizes[sizes.length >> 1], h = 0.25 * size, grid = new Map<string, number[]>();
  const key = (x: number, y: number, z: number) => `${Math.floor(x / h)},${Math.floor(y / h)},${Math.floor(z / h)}`;
  for (const k of t.idx) { const p = pAt(t, k), s = key(p[0], p[1], p[2]); (grid.get(s) ?? grid.set(s, []).get(s)!).push(k); }
  const worst: Record<string, number> = Object.fromEntries(layers.map((l) => [l, 0]));
  let pairs = 0;
  for (const a of t.idx) {
    const pa = pAt(t, a), ra = region(pa, a);
    if (ra === null) continue;
    const cx = Math.floor(pa[0] / h), cy = Math.floor(pa[1] / h), cz = Math.floor(pa[2] / h);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const b of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
        if (b <= a || island[a] === island[b]) continue;
        const pb = pAt(t, b);
        if (Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]) > h || region(pb, b) !== ra) continue;
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
    // the face of each prim (from its centre), baked beside the measures: a texel's face is its own triangle's
    c1: { type: 'wrangle', in: ['c0'], params: { run_over: 'prims', code: 'i@chart = @primnum; f@face = abs(@P.x) > 0.49 ? (@P.x > 0 ? 1 : 0) : (abs(@P.y - 0.5) > 0.49 ? (@P.y > 0.5 ? 3 : 2) : (@P.z > 0 ? 5 : 4));' } },
    cube: { type: 'uv_flatten', in: ['c1'], params: { chart_attrib: 'chart', resolution: 256, padding: 2 } },
    ground,
  };
  const faceOf = async (nodes: Nodes, mesh: string) => img(await cook({ ...nodes, fm: { type: 'bake_mask', in: [mesh], params: { resolution: 256, attrib: 'face', padding: 0 } } }, 'fm'), 'fm').layer('C')!;
  const t = await texels(cube, 'cube', { type: 'bake_measure', in: ['cube', 'ground'], params: { resolution: 256, padding: 0, samples: 32, measures: ALL('@P.y>0.99') } });
  const cf = await faceOf(cube, 'cube');
  const layers = ALL('').map((m) => m.name);
  // every pair on one face, right up to its edges (two texels at an edge on two faces are not a seam pair)
  const d = seamDiffs(t, layers, (_p, k) => cf[k]);
  check(d.pairs > 500, `cube: ${d.pairs} texel pairs across seams within a quarter texel (${(d.size * 250).toFixed(1)} mm) of each other, edges included`);
  const edgePairs = seamDiffs(t, layers, (p, k) => { const q = [p[0], p[1] - 0.5, p[2]].map(Math.abs).sort((x, y) => y - x); return q[1] > 0.49 ? cf[k] : null; });
  check(edgePairs.pairs > 20, `… ${edgePairs.pairs} of them within 1 cm of a cube edge`);
  for (const l of layers) check(d.worst[l] <= 0.02, `cube: ${l} differs by at most ${f3(d.worst[l])} across the seams (≤ 0.02)`);

  const cyl: Nodes = {
    y0: { type: 'tube', params: { radius: 0.4, height: 1, rows: 6, cols: 24, center: [0, 0.5, 0] } },
    y1: { type: 'wrangle', in: ['y0'], params: { run_over: 'prims', code: 'i@chart = @primnum; f@face = @P.y > 0.999 ? 1 : (@P.y < 0.001 ? 2 : 0);' } },
    cyl: { type: 'uv_flatten', in: ['y1'], params: { chart_attrib: 'chart', resolution: 256, padding: 2 } },
    ground,
  };
  const u = await texels(cyl, 'cyl', { type: 'bake_measure', in: ['cyl', 'ground'], params: { resolution: 256, padding: 0, samples: 32, measures: ALL('@P.y>0.99') } });
  // side, top cap, bottom cap (on the ground), right up to the rims
  const yf = await faceOf(cyl, 'cyl');
  const e = seamDiffs(u, layers, (_p, k) => yf[k]);
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
  const t = await texels(nodes, 'fluv', { type: 'bake_measure', in: ['fluv', 'wall'], params: { resolution: 256, spacing: 0.01, samples: 64, measures: [{ by: 'occlusion', max_distance: 100 }] } });
  // the open share of a floor point: 1 − the form factor to the wall's rectangle (x = −1, y 0..2, z −1..1), by the
  // contour formula F = Σ θᵢ (n · uᵢ) / 2π over its edges
  const wallV = [[-1, 0, -1], [-1, 2, -1], [-1, 2, 1], [-1, 0, 1]];
  const open = (p: number[]) => {
    let F = 0;
    for (let i = 0; i < 4; i++) {
      const a = wallV[i].map((x, j) => x - p[j]), b = wallV[(i + 1) % 4].map((x, j) => x - p[j]);
      const c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]], cl = Math.hypot(...c);
      if (!(cl > 0)) continue;
      const th = Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(...a) * Math.hypot(...b)))));
      F += (th * c[1]) / cl;
    }
    return 1 - Math.abs(F) / (2 * Math.PI);
  };
  const along = (x0: number, x1: number) => {
    const ks = t.idx.filter((k) => { const p = pAt(t, k); return p[0] >= x0 && p[0] < x1 && Math.abs(p[2]) < 0.3; });
    return { got: mean(ks.map((k) => t.at('occlusion', k))), want: mean(ks.map((k) => open(pAt(t, k)))) };
  };
  const corner = along(-0.9995, -0.99), near = along(-0.99, -0.95), mid = along(-0.2, 0), far = along(0.8, 1);
  for (const [label, v] of [['within 1 cm of the wall', corner], ['1–5 cm from it', near], ['0.8–1 m from it', mid], ['1.8–2 m from it', far]] as const)
    check(Math.abs(v.got - v.want) < 0.02, `${label}: ${f3(v.got)}, the wall's form factor gives ${f3(v.want)} (± 0.02)`);
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
  // a post through the box's top reads as a post standing on it: the junction concave, the buried part adds nothing
  const ring = async (post: NodeSpec) => {
    const t = await texels({ ...UVBOX, p0: post, pb: { type: 'merge', in: ['ubox', 'p0'] }, pbu: { type: 'uv_unwrap', in: ['pb'] } }, 'pbu',
      { type: 'bake_curvature', in: ['pbu'], params: { resolution: 512, radius: 0.05, method: 'surface' } });
    const v: [number, number][] = [];
    // the top beside the post (a standing post's bottom edge, at d = 0, is its bottom face's)
    for (const k of t.idx) { const p = pAt(t, k), d = Math.max(Math.abs(p[0]), Math.abs(p[2])) - 0.05; if (Math.abs(p[1] - 1) < 1e-4 && d > 2e-4 && Math.min(Math.abs(p[0]), Math.abs(p[2])) < 0.03) v.push([d, t.im.layer('C')![k]]); }
    return bins(v, [0, 0.01, 0.02, 0.03, 0.05, 0.08]);
  };
  // the same 1 m post half sunk through the top and standing on it: one uv layout, so one cloud on the top
  const through = await ring({ type: 'box', params: { size: [0.1, 1, 0.1], center: [0, 1, 0] } });
  const standing = await ring({ type: 'box', params: { size: [0.1, 1, 0.1], center: [0, 1.5, 0] } });
  const rd = Math.max(...through.map((x, i) => Math.abs(x - standing[i])));
  check(through[0] < 0.3 && through[0] < through[2] && through[2] < through[4] + 1e-3, `a post through the top: the top reads concave at the junction, flat further out (${fmt(through)} at 0–1 / 1–2 / 2–3 / 3–5 / 5–8 cm)`);
  check(rd < 0.05, `… as the post standing on the top (${fmt(standing)}; worst ${f3(rd)} ≤ 0.05 with the cloud a quarter of the radius apart): the buried half adds nothing`);
  check((await err({ ...UVBOX, hi: { type: 'sphere' }, c: { type: 'bake_curvature', in: ['ubox', 'hi'], params: { resolution: 32, method: 'surface' } } }, 'c')).includes('method surface reads the mesh\'s own shading normals; a high-res input 1 is not read'), 'method surface refuses a high-res input');
}

section('surface curvature does not depend on texel density');
{
  // a box edge at radius 4 cm, with the side's texels at 1, 0.5 and 0.25 of the top's
  const at = async (w: number, node: 'bake_curvature' | 'bake_measure') => {
    const nodes: Nodes = {
      b0: { type: 'box', params: { size: [1, 1, 1], center: [0, 0.5, 0] } },
      b1: { type: 'wrangle', in: ['b0'], params: { run_over: 'prims', code: `f@texel_weight = @P.x > 0.49 ? ${w} : 1;` } },
      bx: { type: 'uv_unwrap', in: ['b1'] },
    };
    const spec: NodeSpec = node === 'bake_curvature'
      ? { type: 'bake_curvature', in: ['bx'], params: { resolution: 512, radius: 0.04, method: 'surface' } }
      : { type: 'bake_measure', in: ['bx'], params: { resolution: 512, measures: [{ by: 'curvature', radius: 0.04, name: 'convex' }] } };
    const t = await texels(nodes, 'bx', spec);
    return mean(t.idx.filter((k) => { const p = pAt(t, k); return Math.abs(p[1] - 1) < 1e-4 && p[0] > 0.498 && Math.abs(p[2]) < 0.3; }).map((k) => t.at('convex', k)));
  };
  const v = [await at(1, 'bake_curvature'), await at(0.5, 'bake_curvature'), await at(0.25, 'bake_curvature')];
  check(v.every((x) => Math.abs(x - v[0]) < 0.05) && Math.min(...v) > 0.85, `bake_curvature: the top within 2 mm of the edge reads ${fmt(v)} at side densities 1 / 0.5 / 0.25 (within 0.05, above 0.85)`);
  const m = [await at(1, 'bake_measure'), await at(0.25, 'bake_measure')];
  check(Math.abs(m[0] - m[1]) < 0.05 && Math.min(...m) > 0.85, `bake_measure: ${fmt(m)} at side densities 1 / 0.25`);
}

section('curvature thinned at a large radius stays within tolerance');
{
  const g = (await cook({ s0: { type: 'sphere', params: { radius: 0.5, rows: 24, cols: 48 } }, s1: { type: 'clip', in: ['s0'], params: { origin: [0, 0.2, 0], keep: 'below', cap: true } }, su: { type: 'uv_unwrap', in: ['s1'] } }, 'su')).geo;
  const { sc } = cloudOfGeo(g, 512, 1);
  for (const r of [0.08, 0.2]) {
    const thin = await runCurvature(runHere as any, sc, r, null, 0, CURVATURE_THIN), fine = await runCurvature(runHere as any, sc, r, null, 0, 1e9);
    let worst = 0, sum = 0;
    for (let i = 0; i < fine.length; i++) { const d = Math.abs(thin[i] - fine[i]); worst = Math.max(worst, d); sum += d; }
    const thinned = r / CURVATURE_THIN > 1.5 * sc.spacing;
    check(thinned && sum / fine.length < 0.01 && worst < 0.05, `radius ${r * 100} cm over a ${(sc.spacing * 1000).toFixed(1)} mm cloud: thinned to clusters of ${(r / CURVATURE_THIN * 100).toFixed(1)} cm, mean difference ${(sum / fine.length).toExponential(1)} (< 0.01), worst ${f3(worst)} (< 0.05) on ${fine.length} points`);
  }
}

section('occlusion up to a concave crease and a contact line, as bake_ao');
{
  const res = 1024;
  // a pit 20 cm deep in a 1 m plate, one piece
  const pit: Nodes = { g0: { type: 'grid', params: { size: [1, 1], divisions: [3, 3] } }, g1: { type: 'poly_extrude', in: ['g0'], params: { group: '@primnum==4', distance: -0.2 } }, pit: { type: 'uv_unwrap', in: ['g1'] } };
  const im = await bakes(pit, 'pit', res, {
    m: { type: 'bake_measure', in: ['pit'], params: { resolution: res, samples: 64, measures: [{ by: 'occlusion', max_distance: 100 }] } },
    ao: { type: 'bake_ao', in: ['pit'], params: { resolution: res, samples: 64, max_distance: 0 } },
  });
  const P = im.pos.layer('C')!, mk = im.m.layer('mask')!, am = im.ao.layer('mask')!, M = im.m.layer('occlusion')!, A = im.ao.layer('C')!;
  const vm: [number, number][] = [], va: [number, number][] = [];
  for (let k = 0; k < mk.length; k++) {
    const x = P[k * 4], y = P[k * 4 + 1], z = P[k * 4 + 2];
    if (Math.abs(y + 0.2) > 1e-4 || Math.abs(x) > 1 / 6 || Math.abs(z) > 1 / 6 || Math.min(Math.abs(x), Math.abs(z)) > 0.1) continue;
    const d = Math.min(1 / 6 - Math.abs(x), 1 / 6 - Math.abs(z));
    if (mk[k] >= 1) vm.push([d, M[k]]);
    if (am[k] >= 1) va.push([d, A[k]]);
  }
  const E = [0, 0.003, 0.01, 0.03, 0.08], bm = bins(vm, E), ba = bins(va, E);
  const pw = Math.max(...bm.map((x, i) => Math.abs(x - ba[i])));
  check(pw < 0.015, `a pit 20 cm deep, one piece, ${res}: the floor up to the wall's foot ${fmt(bm)}, bake_ao ${fmt(ba)} at 0–3 / 3–10 / 10–30 / 30–80 mm (worst ${f3(pw)} ≤ 0.015)`);

  // a post standing on a plate, two parts of one mesh; then sunk 10 cm into it (the same above the plate)
  const post = (sunk: boolean): Nodes => ({
    plate: { type: 'box', params: { size: [0.6, 0.05, 0.6], center: [0, -0.025, 0] } },
    post: { type: 'box', params: sunk ? { size: [0.1, 0.5, 0.1], center: [0, 0.15, 0] } : { size: [0.1, 0.4, 0.1], center: [0, 0.2, 0] } },
    mg: { type: 'merge', in: ['plate', 'post'] }, pp: { type: 'uv_unwrap', in: ['mg'] },
  });
  const H = [0, 0.003, 0.006, 0.009, 0.012, 0.03];
  const side = async (sunk: boolean) => {
    const b = await bakes(post(sunk), 'pp', res, {
      m: { type: 'bake_measure', in: ['pp'], params: { resolution: res, samples: 64, measures: [{ by: 'occlusion', max_distance: 0.25 }, { by: 'visibility' }, { by: 'curvature', radius: 0.01 }] } },
      ao: { type: 'bake_ao', in: ['pp'], params: { resolution: res, samples: 64, max_distance: 0.25 } },
    });
    const P = b.pos.layer('C')!, mk = b.m.layer('mask')!, am = b.ao.layer('mask')!;
    const o: [number, number][] = [], v: [number, number][] = [], c: [number, number][] = [], a: [number, number][] = [];
    for (let k = 0; k < mk.length; k++) {
      const x = P[k * 4], y = P[k * 4 + 1], z = P[k * 4 + 2];
      // the post's side above the plate (its bottom edge, at y = 0, is the bottom face's)
      if (Math.abs(x - 0.05) > 1e-4 || Math.abs(z) > 0.03 || y < 1e-4) continue;
      if (mk[k] >= 1) { o.push([y, b.m.layer('occlusion')![k]]); v.push([y, b.m.layer('visibility')![k]]); c.push([y, b.m.layer('curvature')![k]]); }
      if (am[k] >= 1) a.push([y, b.ao.layer('C')![k]]);
    }
    return { occ: bins(o, H), vis: bins(v, H), curv: bins(c, H), ao: bins(a, H) };
  };
  const st = await side(false), sk = await side(true);
  const sw = Math.max(...st.occ.map((x, i) => Math.abs(x - st.ao[i])));
  check(sw < 0.015, `a post standing on a plate: its side by height ${fmt(st.occ)}, bake_ao ${fmt(st.ao)} at 0–3 / 3–6 / 6–9 / 9–12 / 12–30 mm (worst ${f3(sw)} ≤ 0.015)`);
  check(Math.abs(st.occ[0] - 0.5) < 0.03, `… at the contact about half is open (${f3(st.occ[0])}; 0.5 for an endless plate)`);
  check(st.vis.every((x) => x > 0.99), `… and it is seen right down to the plate (visibility ${fmt(st.vis)})`);
  check(sk.vis.every((x) => x > 0.99), `a post sunk 10 cm: seen right down to the plate (visibility ${fmt(sk.vis)}; its buried part never reaches these texels)`);
  const kw = Math.max(...sk.occ.map((x, i) => Math.abs(x - st.occ[i])));
  check(kw < 0.015, `… its occlusion as the standing post's (${fmt(sk.occ)}; worst ${f3(kw)} ≤ 0.015)`);
  check(st.curv[0] < 0.4 && sk.curv[0] < 0.4 && st.curv[0] < st.curv[3] && sk.curv[0] < sk.curv[3], `curvature at 1 cm: the junction with the plate reads concave, standing ${fmt(st.curv)}, sunk ${fmt(sk.curv)}`);

  // the post on its own, the plate as surroundings (input 1): the contact rule, as the two parts of one mesh
  const lone: Nodes = { ...post(false), pu: { type: 'uv_unwrap', in: ['post'] } };
  const lb = await bakes(lone, 'pu', res, { m: { type: 'bake_measure', in: ['pu', 'plate'], params: { resolution: res, samples: 64, measures: [{ by: 'occlusion', max_distance: 0.25 }] } } });
  const lo: [number, number][] = [];
  { const P = lb.pos.layer('C')!, mk = lb.m.layer('mask')!; for (let k = 0; k < mk.length; k++) { const x = P[k * 4], y = P[k * 4 + 1], z = P[k * 4 + 2]; if (mk[k] >= 1 && Math.abs(x - 0.05) < 1e-4 && Math.abs(z) < 0.03 && y >= 1e-4) lo.push([y, lb.m.layer('occlusion')![k]]); } }
  const lv = bins(lo, H), lw = Math.max(...lv.map((x, i) => Math.abs(x - st.ao[i])));
  check(lw < 0.015, `the post alone on the plate as surroundings: ${fmt(lv)} (worst ${f3(lw)} from bake_ao ≤ 0.015)`);
}

section('only closed solids that face outward bury: open containers, canopies, rooms, pipes and sheets do not');
{
  const res = 512;
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-4;
  /** bake_measure (occlusion within 0.25 m, visibility) and bake_ao on one mesh: buried points, and the region's means */
  const probe = async (nodes: Nodes, mesh: string, sur: string | null, region: (p: number[]) => boolean) => {
    const c = await cook({
      ...nodes,
      m: { type: 'bake_measure', in: sur ? [mesh, sur] : [mesh], params: { resolution: res, samples: 64, measures: [{ by: 'occlusion', max_distance: 0.25 }, { by: 'visibility' }] } },
      ao: { type: 'bake_ao', in: [mesh], params: { resolution: res, samples: 64, max_distance: 0.25 } },
      pos: { type: 'bake_position', in: [mesh], params: { resolution: res, mode: 'world', padding: 0 } },
      all: { type: 'merge', in: ['m', 'ao', 'pos'] },
    }, 'all', serial, 'm');
    const st = c.stats, b = { m: img(c, 'm'), ao: img(c, 'ao'), pos: img(c, 'pos') };
    const P = b.pos.layer('C')!, mk = b.m.layer('mask')!, am = b.ao.layer('mask')!;
    const o: number[] = [], v: number[] = [], a: number[] = [];
    for (let k = 0; k < mk.length; k++) {
      if (!region([P[k * 4], P[k * 4 + 1], P[k * 4 + 2]])) continue;
      if (mk[k] >= 1) { o.push(b.m.layer('occlusion')![k]); v.push(b.m.layer('visibility')![k]); }
      if (am[k] >= 1) a.push(b.ao.layer('C')![k]);
    }
    return { buried: st.buried_points ?? 0, points: st.cloud_points, n: o.length, occ: mean(o), ao: mean(a), vis: mean(v) };
  };
  const like = (label: string, r: Awaited<ReturnType<typeof probe>>) =>
    check(r.points > 0 && r.buried === 0 && r.n > 100 && Math.abs(r.occ - r.ao) < 0.015, `${label}: no point buried (of ${r.points}); occlusion ${f3(r.occ)}, bake_ao ${f3(r.ao)} on ${r.n} texels (± 0.015)`);
  // a box standing in an open-top bin: the bin is open, so it buries nothing; the box's sides read as bake_ao
  const bin = await probe({
    bin0: { type: 'box', params: { size: [1, 0.5, 1], center: [0, 0.25, 0] } }, bin: { type: 'delete', in: ['bin0'], params: { group: '@P.y>0.49', class: 'prim' } },
    bx: { type: 'box', params: { size: [0.3, 0.3, 0.3], center: [0, 0.15, 0] } }, mg: { type: 'merge', in: ['bin', 'bx'] }, mu: { type: 'uv_unwrap', in: ['mg'] },
  }, 'mu', null, (p) => near(Math.abs(p[0]), 0.15) && p[1] > 0.02 && p[1] < 0.28 && Math.abs(p[2]) < 0.13);
  like('a box standing in an open-top bin, its sides', bin);
  check(bin.vis > 0.4, `… and they are seen over the bin's rim (visibility ${f3(bin.vis)})`);
  // a slab under a one-sided canopy 0.3 m up, beyond the reach: the same mesh, then the canopy as surroundings
  const slab: Nodes = { slab0: { type: 'box', params: { size: [1, 0.1, 1], center: [0, 0.05, 0] } }, canopy: { type: 'grid', params: { size: [3, 3], center: [0, 0.4, 0] } } };
  const top = (p: number[]) => near(p[1], 0.1) && Math.abs(p[0]) < 0.45 && Math.abs(p[2]) < 0.45;
  like('a slab under a one-sided canopy (one mesh), its top', await probe({ ...slab, mg: { type: 'merge', in: ['slab0', 'canopy'] }, mu: { type: 'uv_unwrap', in: ['mg'] } }, 'mu', null, top));
  like('… the canopy as surroundings', await probe({ ...slab, su: { type: 'uv_unwrap', in: ['slab0'] } }, 'su', 'canopy', top));
  // a prop inside a closed box room given as surroundings: the room holds the whole model, so it is a room, not a solid
  like('a prop inside a closed room (surroundings), its top', await probe({ p0: { type: 'box', params: { size: [0.4, 0.4, 0.4], center: [0, 0.2, 0] } }, pu: { type: 'uv_unwrap', in: ['p0'] }, room: { type: 'box', params: { size: [4, 3, 4], center: [0, 1.5, 0] } } }, 'pu', 'room',
    (p) => near(p[1], 0.4) && Math.abs(p[0]) < 0.18 && Math.abs(p[2]) < 0.18));
  // a part inside a closed part: buried, read covered
  const inner = (p: number[]) => near(p[1], 0.6) && Math.abs(p[0]) < 0.09 && Math.abs(p[2]) < 0.09;
  const nested = await probe({ o0: { type: 'box', params: { size: [1, 1, 1], center: [0, 0.5, 0] } }, i0: { type: 'box', params: { size: [0.2, 0.2, 0.2], center: [0, 0.5, 0] } }, mg: { type: 'merge', in: ['o0', 'i0'] }, mu: { type: 'uv_unwrap', in: ['mg'] } }, 'mu', null, inner);
  check(nested.buried > 300 && nested.n > 100 && nested.occ === 0 && nested.vis === 0, `a part entirely inside a closed part: ${nested.buried} points buried, its top reads covered (occlusion ${f3(nested.occ)}, visibility ${f3(nested.vis)})`);
  // the same outer box wound inward (a shell seen from inside) buries nothing
  like('… the outer box wound inward', await probe({ o0: { type: 'box', params: { size: [1, 1, 1], center: [0, 0.5, 0] } }, o1: { type: 'reverse', in: ['o0'] }, i0: { type: 'box', params: { size: [0.2, 0.2, 0.2], center: [0, 0.5, 0] } }, mg: { type: 'merge', in: ['o1', 'i0'] }, mu: { type: 'uv_unwrap', in: ['mg'] } }, 'mu', null, inner));
  // a part inside an open pipe
  like('a part inside an open pipe, its top', await probe({ o0: { type: 'tube', params: { radius: 0.5, height: 1, cols: 32, caps: false, center: [0, 0.5, 0] } }, i0: { type: 'box', params: { size: [0.2, 0.2, 0.2], center: [0, 0.5, 0] } }, mg: { type: 'merge', in: ['o0', 'i0'] }, mu: { type: 'uv_unwrap', in: ['mg'] } }, 'mu', null, inner));
  // a one-sided sheet resting on a solid: its seen side is not buried
  like('a one-sided sheet resting on a solid, its top', await probe({ b0: { type: 'box', params: { size: [1, 0.1, 1], center: [0, 0.05, 0] } }, s0: { type: 'grid', params: { size: [0.4, 0.4], center: [0, 0.1, 0] } }, mg: { type: 'merge', in: ['b0', 's0'] }, mu: { type: 'uv_unwrap', in: ['mg'] } }, 'mu', null,
    (p) => near(p[1], 0.1) && Math.abs(p[0]) < 0.18 && Math.abs(p[2]) < 0.18));
}

section('the contact rule is one-sided');
{
  // a plate 0.2 mm above the ground (inside the contact distance): facing away from the ground it is open; facing it, covered
  const nodes: Nodes = { u0: { type: 'grid', params: { size: [1, 1], center: [0, 0.0002, 0] } }, up: { type: 'uv_unwrap', in: ['u0'] }, dn: { type: 'reverse', in: ['up'] }, ground: { type: 'box', params: { size: [3, 0.1, 3], center: [0, -0.05, 0] } } };
  const ms = [{ by: 'occlusion' }, { by: 'visibility' }];
  const up = await texels(nodes, 'up', { type: 'bake_measure', in: ['up', 'ground'], params: { resolution: 32, measures: ms } });
  const dn = await texels(nodes, 'dn', { type: 'bake_measure', in: ['dn', 'ground'], params: { resolution: 32, measures: ms } });
  const all = (t: Texels, l: string) => t.idx.map((k) => t.at(l, k));
  check(Math.min(...all(up, 'occlusion')) > 0.99 && Math.min(...all(up, 'visibility')) > 0.99, `facing away from the ground: open (occlusion ≥ ${f3(Math.min(...all(up, 'occlusion')))})`);
  check(Math.max(...all(dn, 'occlusion')) < 0.01 && Math.max(...all(dn, 'visibility')) < 0.01, `facing the ground: covered (occlusion ≤ ${f3(Math.max(...all(dn, 'occlusion')))})`);
}

section('triangles with no uv area get no cloud points');
{
  const nodes: Nodes = { ...UVBOX, z0: { type: 'wrangle', in: ['ubox'], params: { run_over: 'vertices', code: 'if (@P.y > 0.99) v@uv = set(0.5, 0.5, 0);' } } };
  const g = (await cook(nodes, 'z0')).geo, { tris, uv, sc } = cloudOfGeo(g, 64, 1);
  let zero = 0, withPts = 0;
  for (let t = 0; t < tris.length / 3; t++) {
    const a = tris[t * 3] * 2, b = tris[t * 3 + 1] * 2, c = tris[t * 3 + 2] * 2;
    if (Math.abs((uv[b] - uv[a]) * (uv[c + 1] - uv[a + 1]) - (uv[c] - uv[a]) * (uv[b + 1] - uv[a + 1])) > 1e-18) continue;
    zero++;
    if (sc.cloud.start[t + 1] > sc.cloud.start[t]) withPts++;
  }
  check(zero >= 8 && withPts === 0, `${zero} triangles with no uv area (the top collapsed to a point): ${withPts} of them have cloud points`);
  const t = await texels(nodes, 'z0', { type: 'bake_measure', in: ['z0'], params: { resolution: 64, measures: [{ by: 'occlusion' }, { by: 'curvature', radius: 0.1 }] } });
  check(t.idx.every((k) => Number.isFinite(t.at('occlusion', k)) && Number.isFinite(t.at('curvature', k))), 'the bake cooks and every value is finite');
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
  // a curvature radius past half the model's size
  await has(bm([{ by: 'curvature', name: 'wide', radius: 1 }]), 'bake_measure: measure "wide": curvature radius 1 m is more than half the model\'s size (bounding-box diagonal 1.73 m)');
  await has(err({ ...UVBOX, c: { type: 'bake_curvature', in: ['ubox'], params: { resolution: 32, method: 'surface', radius: 1 } } }, 'c'), 'bake_curvature: radius 1 m is more than half the model\'s size');
  check((await err({ ...UVBOX, c: { type: 'bake_curvature', in: ['ubox'], params: { resolution: 32, method: 'surface', radius: 0.8 } } }, 'c')) === '', 'a radius just under half the size cooks');
  // aliases
  for (const a of ['bake_masks', 'bake_mesh_mask']) check((await err({ ...UVBOX, m: { type: a, in: ['ubox'], params: { resolution: 32, measures: [{ by: 'facing' }] } } as any }, 'm')) !== '', `"${a}" is not a name of bake_measure`);
  for (const a of ['bake_measures', 'bake_noise', 'bake_distance', 'bake_cavity', 'bake_shelter', 'bake_visibility']) check((await err({ ...UVBOX, m: { type: a, in: ['ubox'], params: { resolution: 32, measures: [{ by: 'facing' }] } } as any }, 'm')) === '', `"${a}" names bake_measure`);
}

section('the time limit of long-running nodes stops the surface measures, on this thread and on the pool');
{
  const nodes: Nodes = { s0: { type: 'sphere', params: { radius: 0.5, rows: 32, cols: 64 } }, su: { type: 'uv_unwrap', in: ['s0'] }, ground: { type: 'box', params: { size: [3, 0.1, 3], center: [0, -0.6, 0] } } };
  for (const [label, engine] of [['on this thread', serial], ['on 4 workers', pooled]] as const) {
    const saved = engine.simTimeoutMs;
    engine.simTimeoutMs = 40;
    const t0 = performance.now();
    const r = await engine.cook({ nodes: { ...nodes, m: { type: 'bake_measure', in: ['su', 'ground'], params: { resolution: 1024, samples: 256, seed: 977, measures: [{ by: 'occlusion' }, { by: 'cavity' }, { by: 'curvature', radius: 0.2 }] } } }, output: 'm' });
    const ms = performance.now() - t0;
    const r2 = await engine.cook({ nodes: { ...nodes, c: { type: 'bake_curvature', in: ['su'], params: { resolution: 1024, radius: 0.3, method: 'surface', padding: 1 } } }, output: 'c' });
    engine.simTimeoutMs = saved;
    const msg = r.errors.map((e) => e.message).join('; '), msg2 = r2.errors.map((e) => e.message).join('; ');
    check(!r.ok && msg.includes('bake_measure: stopped after 40 ms, the time limit of long-running nodes'), `bake_measure ${label}: stopped (${msg || 'cooked'}; ${ms.toFixed(0)} ms)`);
    check(!r2.ok && msg2.includes('bake_curvature: stopped after 40 ms'), `bake_curvature method surface ${label}: stopped (${msg2 || 'cooked'})`);
  }
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
  // another size (not a power of two) and another worker count; then the memo's path (a second bake of the same mesh)
  const at = (res: number, name = 'm'): Nodes => ({ ...nodes, [name]: { type: 'bake_measure', in: ['pbuv', 'ground'], params: { resolution: res, samples: 16, seed: 3, measures: ms } } });
  const d = img(await cook(at(96), 'm', serial), 'm'), e = img(await cook(at(96), 'm', pooled2), 'm');
  check(layers.every((l) => same(d.layer(l)!, e.layer(l)!)), 'at 96 texels: bit-identical on the cooking thread and on 2 workers');
  const before = bakeMemoStats.reused;
  const twice = await cook({ ...at(96), ...at(96, 'm2'), both: { type: 'merge', in: ['m', 'm2'] } }, 'both', pooled2);
  const f = img(twice, 'm2');
  check(bakeMemoStats.reused > before && layers.every((l) => same(d.layer(l)!, f.layer(l)!)), `from the memo (${bakeMemoStats.reused - before} values reused): the same bits`);
}

section('results do not depend on prim order');
{
  const nodes: Nodes = { ...PLATE, ground: { type: 'box', params: { size: [3, 0.1, 3], center: [0, -0.06, 0] } }, rev: { type: 'sort', in: ['pbuv'], params: { class: 'prim', by: 'reverse' } } };
  const ms = ALL('@name=bolt');
  const bake = (src: string): NodeSpec => ({ type: 'bake_measure', in: [src, 'ground'], params: { resolution: 128, samples: 16, measures: ms } });
  const a = img(await cook({ ...nodes, m: bake('pbuv') }, 'm'), 'm'), b = img(await cook({ ...nodes, m: bake('rev') }, 'm'), 'm');
  const c = img(await cook({ ...nodes, m: { type: 'bake_curvature', in: ['pbuv'], params: { resolution: 128, radius: 0.08, method: 'surface' } } }, 'm'), 'm');
  const d = img(await cook({ ...nodes, m: { type: 'bake_curvature', in: ['rev'], params: { resolution: 128, radius: 0.08, method: 'surface' } } }, 'm'), 'm');
  let worst = 0, wl = '';
  for (const l of ms.map((m) => m.name)) { const x = a.layer(l)!, y = b.layer(l)!; for (let i = 0; i < x.length; i++) if (Math.abs(x[i] - y[i]) > worst) { worst = Math.abs(x[i] - y[i]); wl = l; } }
  check(worst < 1e-5, `the plate and bolt with their prims in reverse order: every measure equal (worst ${worst.toExponential(1)}${wl ? ` in ${wl}` : ''} < 1e-5)`);
  let cw = 0;
  const cx = c.layer('C')!, cy = d.layer('C')!;
  for (let i = 0; i < cx.length; i++) cw = Math.max(cw, Math.abs(cx[i] - cy[i]));
  check(cw < 1e-5, `bake_curvature method surface: equal (worst ${cw.toExponential(1)})`);
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

section('the bake memo keeps at most its limits and releases the oldest values');
{
  const saved = { ...bakeMemoLimits };
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc') as () => void;
  bakeMemoLimits.bytes = 10 * 2 ** 20;
  bakeMemoLimits.entries = 3;
  const meshes: object[] = [], refs: WeakRef<Float64Array>[] = [];
  // 4 MB a value: two fit the 10 MB
  for (let i = 0; i < 5; i++) { const g = {}; meshes.push(g); memoBake(g, 'v', () => { const a = new Float64Array(2 ** 19); refs.push(new WeakRef(a)); return a; }); }
  const u = bakeMemoUsage();
  check(u.entries === 2 && u.bytes === 8 * 2 ** 20, `five 4 MB values against 10 MB: ${u.entries} kept, ${(u.bytes / 2 ** 20).toFixed(0)} MB`);
  let made = bakeMemoStats.made;
  memoBake(meshes[4], 'v', () => new Float64Array(1));
  check(bakeMemoStats.made === made, 'the newest is reused');
  // the memory itself is released: the oldest values are collected while their meshes live
  await new Promise((r) => setTimeout(r, 20));
  gc();
  check(refs.slice(0, 3).every((r) => r.deref() === undefined) && refs.slice(3).every((r) => r.deref() !== undefined), 'the three oldest values are garbage collected while their meshes live; the two newest stay');
  made = bakeMemoStats.made;
  memoBake(meshes[0], 'v', () => new Float64Array(8));
  check(bakeMemoStats.made === made + 1, 'asked again, a released value is made again');
  for (let i = 0; i < 4; i++) memoBake({}, `n${i}`, () => new Float64Array(8));
  check(bakeMemoUsage().entries === 3, `small values: at most ${bakeMemoLimits.entries} kept (${bakeMemoUsage().entries})`);
  // six versions of a mesh baked at 512: the memo stays within 10 MB, releasing as it goes
  bakeMemoLimits.bytes = 10 * 2 ** 20;
  bakeMemoLimits.entries = 8;
  let peak = 0;
  const made0 = bakeMemoStats.made;
  for (let i = 0; i < 6; i++) {
    await cook({ b0: { type: 'box', params: { size: [1 + i * 0.01, 1, 1], center: [0, 0.5, 0] } }, bu: { type: 'uv_unwrap', in: ['b0'] }, m: { type: 'bake_measure', in: ['bu'], params: { resolution: 512, samples: 8, measures: [{ by: 'occlusion' }, { by: 'curvature', radius: 0.05 }] } } }, 'm');
    peak = Math.max(peak, bakeMemoUsage().bytes);
  }
  const madeN = bakeMemoStats.made - made0;
  check(peak <= 10 * 2 ** 20 && bakeMemoUsage().entries < madeN, `six mesh versions at 512: ${madeN} values made, ${bakeMemoUsage().entries} kept, at most ${(peak / 2 ** 20).toFixed(1)} MB (limit 10 MB)`);
  Object.assign(bakeMemoLimits, saved);
  check(saved.bytes === 512 * 2 ** 20 && saved.entries === 8, 'the limits: 512 MB and 8 values (about two versions of a mesh)');
}

section('a time bound: every measure on a mid-size model, rays per cloud point');
{
  const nodes: Nodes = {
    s0: { type: 'sphere', params: { radius: 0.4, rows: 48, cols: 96, center: [0, 0.4, 0] } },
    t0: { type: 'tube', params: { radius: 0.05, height: 1.2, rows: 12, cols: 24, center: [0.6, 0.6, 0] } },
    b0: { type: 'box', params: { size: [2, 0.1, 2], center: [0, -0.05, 0], divisions: [16, 2, 16] } },
    mm: { type: 'merge', in: ['s0', 't0', 'b0'] }, mu: { type: 'uv_unwrap', in: ['mm'] },
  };
  const g = (await cook(nodes, 'mu')).geo;
  const ms = [...ALL('@P.y<0'), { by: 'curvature', name: 'curv2', radius: 0.02 }];
  const t0 = performance.now();
  const c = await cook({ ...nodes, m: { type: 'bake_measure', in: ['mu'], params: { resolution: 512, samples: 32, measures: ms } } }, 'm', pooled);
  const ms0 = performance.now() - t0, st = c.stats;
  check(st.rays > 0 && st.rays < (st.texels * 32) / 4, `${g.numPrims} prims at 512, ${ms.length} measures, 32 samples: ${st.rays} rays for ${st.texels} texels (< texels × samples / 4: rays go per cloud point, not per texel)`);
  check(ms0 < 20000, `cooked in ${(ms0 / 1000).toFixed(1)} s (< 20 s)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
