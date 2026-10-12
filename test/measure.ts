// Behavioural tests for the measure nodes (curvature, occlusion, distance, assert) and the explain / diff text.
//   node test/measure.ts
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { diffGeometry, explainGeometry } from '../src/explain.ts';
import { RayScene, pieceReport, selfIntersections, symmetricEigen3 } from '../src/core/analysis.ts';
import type { Geometry } from '../src/core/geometry.ts';
import type { NodeSpec } from '../src/graph/types.ts';

const engine = new Engine(createNodeHost());
await engine.init();

let fail = 0, pass = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
  if (ok) pass++; else fail++;
};

async function cook(nodes: Record<string, NodeSpec>, output?: string) {
  return engine.cook({ nodes, output });
}
async function geo(nodes: Record<string, NodeSpec>, output?: string): Promise<Geometry> {
  const r = await cook(nodes, output);
  if (!r.ok || !r.geo) throw new Error(`cook failed: ${r.errors.map((e) => `[${e.node}] ${e.message}`).join('; ')}`);
  return r.geo;
}
const values = (g: Geometry, name: string) => Array.from(g.points.get(name)!.data as Float64Array);
const range = (v: number[]) => [Math.min(...v), Math.max(...v)];
const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
const f = (x: number) => (Math.abs(x) < 1e-3 && x !== 0 ? x.toExponential(2) : x.toFixed(4));

// ---------------------------------------------------------------- curvature
{
  const sphere = { s: { type: 'sphere', params: { type: 'ico', level: 3 } } };
  const H = values(await geo({ ...sphere, k: { type: 'curvature', in: ['s'] } }), 'curvature');
  const errH = Math.max(...H.map((x) => Math.abs(x - 1)));
  check(errH < 0.05, `unit ico sphere (level 3): mean curvature ≈ 1 everywhere (max error ${f(errH)})`);
  const K = values(await geo({ ...sphere, k: { type: 'curvature', in: ['s'], params: { type: 'gaussian' } } }), 'curvature');
  const errK = Math.max(...K.map((x) => Math.abs(x - 1)));
  check(errK < 0.05, `unit ico sphere: Gaussian curvature ≈ 1 (max error ${f(errK)})`);
  const R2 = values(await geo({ s: { type: 'sphere', params: { type: 'ico', level: 4, radius: 2 } }, k: { type: 'curvature', in: ['s'], params: { type: 'principal_max' } } }), 'curvature');
  check(Math.abs(mean(R2) - 0.5) < 0.02, `sphere of radius 2: principal curvature ≈ 1/2 (mean ${f(mean(R2))})`);
  const rev = values(await geo({ ...sphere, r: { type: 'reverse', in: ['s'] }, k: { type: 'curvature', in: ['r'] } }, 'k'), 'curvature');
  check(Math.abs(mean(rev) + 1) < 0.05, `reversed sphere: mean curvature ≈ -1 (sign follows the normals; mean ${f(mean(rev))})`);

  const plane = await cook({ g: { type: 'grid', params: { size: [3, 3], divisions: [12, 12] } }, k: { type: 'curvature', in: ['g'] } });
  const P = values(plane.geo!, 'curvature');
  check(Math.max(...P.map(Math.abs)) < 1e-9, `flat grid: mean curvature 0 (max |H| ${f(Math.max(...P.map(Math.abs)))})`);
  check(plane.warnings.some((w) => /48 boundary point/.test(w.message)), `boundary points are filled with a note: ${plane.warnings[0]?.message}`);
  const PK = values(await geo({ g: { type: 'grid', params: { size: [3, 3], divisions: [12, 12] } }, k: { type: 'curvature', in: ['g'], params: { type: 'gaussian' } } }), 'curvature');
  check(Math.max(...PK.map(Math.abs)) < 1e-9, 'flat grid: Gaussian curvature 0');

  const noisy = { s: { type: 'sphere', params: { type: 'ico', level: 4 } }, n: { type: 'noise_displace', in: ['s'], params: { amplitude: 0.3, frequency: 2 } } };
  const conv = values(await geo({ ...noisy, k: { type: 'curvature', in: ['n'], params: { type: 'convexity' } } }), 'curvature');
  check(conv.every((x) => x === 1 || x === -1 || x === 0) && conv.includes(1) && conv.includes(-1), 'convexity is the sign of the mean curvature (both signs on a noisy sphere)');
  const norm = values(await geo({ ...noisy, k: { type: 'curvature', in: ['n'], params: { normalize: true, clip_percent: 5 } } }), 'curvature');
  const [lo, hi] = range(norm);
  check(lo === 0 && hi === 1, `normalize fits to 0..1 (got ${f(lo)}..${f(hi)})`);
  const raw = values(await geo({ ...noisy, k: { type: 'curvature', in: ['n'] } }), 'curvature');
  const smooth = values(await geo({ ...noisy, k: { type: 'curvature', in: ['n'], params: { smooth_iterations: 10 } } }), 'curvature');
  const sd = (v: number[]) => Math.sqrt(mean(v.map((x) => (x - mean(v)) ** 2)));
  check(sd(smooth) < sd(raw) * 0.8, `smooth_iterations reduces the spread (sd ${f(sd(raw))} → ${f(sd(smooth))})`);
  const box = await geo({ b: { type: 'box', params: { divisions: [4, 4, 4] } }, k: { type: 'curvature', in: ['b'], params: { name: 'kk' } } });
  const kk = values(box, 'kk'), bp = box.P;
  let faceMax = 0, edgeMin = Infinity;
  for (let i = 0; i < box.numPoints; i++) {
    const onEdge = [0, 1, 2].filter((c) => Math.abs(Math.abs(bp[i * 3 + c]) - 0.5) < 1e-9).length >= 2;
    if (onEdge) edgeMin = Math.min(edgeMin, kk[i]); else faceMax = Math.max(faceMax, Math.abs(kk[i]));
  }
  check(faceMax < 1e-9 && edgeMin > 0, `box: 0 on the faces, positive on edges and corners (name param writes "kk")`);
  const pts = await cook({ g: { type: 'grid' }, s: { type: 'scatter', in: ['g'], params: { count: 20 } }, k: { type: 'curvature', in: ['s'] } }, 'k');
  check(pts.ok && pts.warnings.some((w) => /no polygons/.test(w.message)), 'points only: curvature 0 with a warning');
}

// ---------------------------------------------------------------- occlusion / thickness / cavity
{
  const grid = await geo({ g: { type: 'grid', params: { size: [4, 4], divisions: [20, 20] } }, ao: { type: 'occlusion', in: ['g'] } });
  check(Math.max(...values(grid, 'ao')) === 0, 'occlusion of a flat grid is 0');
  const inside = await geo({ g: { type: 'grid', params: { size: [1, 1], divisions: [6, 6] } }, b: { type: 'box', params: { size: 3 } }, ao: { type: 'occlusion', in: ['g', 'b'] } }, 'ao');
  check(Math.min(...values(inside, 'ao')) === 1, 'occlusion of a grid inside a closed box (occluder input) is 1');
  const inv = await geo({ g: { type: 'grid', params: { size: [1, 1], divisions: [6, 6] } }, b: { type: 'box', params: { size: 3 } }, ao: { type: 'occlusion', in: ['g', 'b'], params: { invert: true, name: 'open' } } }, 'ao');
  check(Math.max(...values(inv, 'open')) === 0, 'invert + name: exposure "open" is 0 inside the box');
  // a grid with a wall: points near the wall are partly occluded, far ones are not
  const wall = { g: { type: 'grid', params: { size: [4, 4], divisions: [40, 40] } }, w: { type: 'box', params: { size: [0.2, 2, 4], center: [0, 1, 0] } } };
  const half = await geo({ ...wall, ao: { type: 'occlusion', in: ['g', 'w'], params: { samples: 64 } } }, 'ao');
  const ao = values(half, 'ao'), hp = half.P;
  const near = ao.filter((_, i) => Math.abs(hp[i * 3]) > 0.15 && Math.abs(hp[i * 3]) < 0.3 && Math.abs(hp[i * 3 + 2]) < 1);
  const far = ao.filter((_, i) => Math.abs(hp[i * 3]) > 1.8);
  check(mean(near) > 0.3 && mean(near) < 0.75 && mean(far) < mean(near), `next to a wall about half the sky is blocked (near ${f(mean(near))}, far ${f(mean(far))})`);
  const again = await geo({ ...wall, ao: { type: 'occlusion', in: ['g', 'w'], params: { samples: 64 } } }, 'ao');
  check(values(again, 'ao').every((x, i) => x === ao[i]), 'occlusion is deterministic');
  const reseed = await geo({ ...wall, ao: { type: 'occlusion', in: ['g', 'w'], params: { samples: 64, seed: 5 } } }, 'ao');
  const vr = values(reseed, 'ao');
  check(vr.some((x, i) => x !== ao[i]) && Math.abs(mean(vr) - mean(ao)) < 0.02, `seed changes the samples, not the result (mean ${f(mean(ao))} vs ${f(mean(vr))})`);

  const slab = await geo({ s: { type: 'box', params: { size: [4, 0.2, 4], divisions: [10, 1, 10] } }, t: { type: 'occlusion', in: ['s'], params: { mode: 'thickness' } } });
  const th = values(slab, 'thickness'), sp = slab.P;
  const interior = th.filter((_, i) => Math.abs(sp[i * 3]) < 1.5 && Math.abs(sp[i * 3 + 2]) < 1.5);
  const errT = Math.max(...interior.map((x) => Math.abs(x - 0.2) / 0.2));
  check(errT < 0.05, `thickness of a 0.2 m slab is 0.2 m within 5% away from its rim (max error ${(errT * 100).toFixed(1)}%, ${interior.length} points)`);
  const ball = await geo({ s: { type: 'sphere', params: { type: 'ico', level: 4, radius: 0.5 } }, t: { type: 'occlusion', in: ['s'], params: { mode: 'thickness', normalize: true, max_distance: 2 } } });
  const bt = values(ball, 'thickness');
  check(Math.abs(mean(bt) - 0.5) < 0.03, `thickness of a sphere ≈ its diameter, normalize divides by max_distance (mean ${f(mean(bt))} ≈ 1/2)`);

  const corner = await geo({ g: { type: 'grid', params: { size: [2, 2], divisions: [20, 20] } }, w: { type: 'box', params: { size: [0.2, 1, 2], center: [-1.1, 0.5, 0] } }, c: { type: 'occlusion', in: ['g', 'w'], params: { mode: 'cavity', max_distance: 0.5 } } }, 'c');
  const cv = values(corner, 'cavity'), cp = corner.P;
  const atWall = cv.filter((_, i) => cp[i * 3] < -0.9), open = cv.filter((_, i) => cp[i * 3] > 0);
  check(mean(atWall) > 0.05 && Math.max(...open) === 0, `cavity: inner corner by the wall ${f(mean(atWall))}, open floor 0`);
  const grp = await geo({ ...wall, ao: { type: 'occlusion', in: ['g', 'w'], params: { group: '@P.x>0' } } }, 'ao');
  check(values(grp, 'ao').every((x, i) => grp.P[i * 3] > 0 || x === 0), 'group: points outside the group are not measured');

  // performance target: 50k points × 32 samples (informational: the machine may be busy)
  const rock = { s: { type: 'sphere', params: { rows: 199, cols: 251 } }, n: { type: 'noise_displace', in: ['s'], params: { amplitude: 0.3, frequency: 2 } } };
  const big = await geo(rock);
  const r = await cook({ ...rock, ao: { type: 'occlusion', in: ['n'], params: { samples: 32 } } }, 'ao');
  const ms = r.results.get('ao')!.ms;
  console.log(`info occlusion ${big.numPoints} points × 32 samples: ${ms.toFixed(0)} ms incl. BVH build (target: 50k × 32 < 2 s on an idle machine)`);
  check(r.ok && mean(values(r.geo!, 'ao')) > 0 && mean(values(r.geo!, 'ao')) < 0.2, `occlusion on ${big.numPoints} points cooks (mean ao ${f(mean(values(r.geo!, 'ao')))})`);
}

// ---------------------------------------------------------------- distance
{
  const sphere = { s: { type: 'sphere', params: { type: 'ico', level: 5 } } };
  const pts = { p: { type: 'point_grid', params: { counts: [6, 6, 6], size: [3, 3, 3] } } };
  const g = await geo({ ...sphere, ...pts, d: { type: 'distance', in: ['p', 's'] } }, 'd');
  const d = values(g, 'dist'), P = g.P;
  let err = 0;
  for (let i = 0; i < g.numPoints; i++) err = Math.max(err, Math.abs(d[i] - Math.abs(Math.hypot(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]) - 1)));
  check(err < 2e-3, `distance from points to a unit sphere surface = |r - 1| (max error ${f(err)}, facets)`);
  const sg = await geo({ ...sphere, ...pts, d: { type: 'distance', in: ['p', 's'], params: { signed: true, extra: true } } }, 'd');
  const sd = values(sg, 'dist');
  let signOk = true, serr = 0;
  for (let i = 0; i < sg.numPoints; i++) {
    const r = Math.hypot(sg.P[i * 3], sg.P[i * 3 + 1], sg.P[i * 3 + 2]);
    if (Math.abs(r - 1) > 0.01 && Math.sign(sd[i]) !== Math.sign(r - 1)) signOk = false;
    serr = Math.max(serr, Math.abs(sd[i] - (r - 1)));
  }
  check(signOk && serr < 2e-3, `signed: negative inside, positive outside (max error ${f(serr)})`);
  const np = sg.points.get('nearest_P')!.data as Float64Array, prim = sg.points.get('nearest_prim')!.data as Int32Array;
  let onSurf = true;
  for (let i = 0; i < sg.numPoints; i++) if (Math.abs(Math.hypot(np[i * 3], np[i * 3 + 1], np[i * 3 + 2]) - 1) > 2e-3 || prim[i] < 0) onSurf = false;
  check(onSurf && !!sg.points.get('nearest_uv'), 'extra: nearest_P lies on the surface, nearest_prim is set, nearest_uv exists');
  // uv on a single triangle and a quad
  const tri = await geo({ t: { type: 'curve', params: { points: [[0, 0, 0], [1, 0, 0], [0, 0, 1]], closed: true } }, p: { type: 'points', params: { points: [[0.25, 1, 0.5]] } }, d: { type: 'distance', in: ['p', 't'], params: { extra: true } } }, 'd');
  const uv = tri.points.get('nearest_uv')!.get(0) as number[];
  check(Math.abs(uv[0] - 0.25) < 1e-9 && Math.abs(uv[1] - 0.5) < 1e-9 && Math.abs(values(tri, 'dist')[0] - 1) < 1e-9, `nearest_uv on a triangle is Houdini's primuv (${uv.map(f).join(', ')})`);
  const curve = await geo({ c: { type: 'line', params: { origin: [0, 0, 0], direction: [1, 0, 0], length: 2, points: 3 } }, p: { type: 'points', params: { points: [[0.5, 1, 0], [3, 0, 0]] } }, d: { type: 'distance', in: ['p', 'c'], params: { extra: true } } }, 'd');
  const cd = values(curve, 'dist'), cu = curve.points.get('nearest_uv')!.data as Float64Array;
  check(Math.abs(cd[0] - 1) < 1e-9 && Math.abs(cd[1] - 1) < 1e-9 && Math.abs(cu[0] - 0.25) < 1e-9 && Math.abs(cu[3] - 1) < 1e-9, 'distance to a polyline: segment distance, uv u along the curve');
  const cloud = await geo({ c: { type: 'points', params: { points: [[0, 0, 0], [5, 0, 0]] } }, p: { type: 'points', params: { points: [[1, 0, 0], [4, 1, 0]] } }, d: { type: 'distance', in: ['p', 'c'], params: { max_distance: 1.2, extra: true } } }, 'd');
  const kd = values(cloud, 'dist'), kp = cloud.points.get('nearest_prim')!.data as Int32Array;
  check(Math.abs(kd[0] - 1) < 1e-9 && Math.abs(kd[1] - 1.2) < 1e-9 && kp[1] === -1, 'point targets via the KD-tree; beyond max_distance → max_distance and nearest_prim -1');
  const none = await cook({ p: { type: 'points', params: { points: [[0, 0, 0]] } }, d: { type: 'distance', in: ['p'] } }, 'd');
  check(!none.ok && /target/.test(none.errors[0]?.message ?? ''), `missing target is a node error: ${none.errors[0]?.message}`);
}

// ---------------------------------------------------------------- assert
{
  const box = { b: { type: 'box', params: { size: [1, 2, 1], center: [0, 1, 0] } } };
  const ok = await cook({ ...box, a: { type: 'assert', in: ['b'], params: { watertight: true, manifold: true, no_flipped: true, no_degenerate: true, no_self_intersections: true, min_points: 8, max_points: 8, min_prims: 6, max_prims: 6, bbox_min: [-0.5, 0, -0.5], bbox_max: [0.5, 2, 0.5], min_edge_length: 0.9, attrib: 'P', group: '', expr: 'volume > 1.9 && pieces == 1 && genus == 0 && bbox.size.y == 2' } } });
  const st = ok.results.get('a')?.stats;
  check(ok.ok && st?.checks === 13 && st?.failed === 0, `assert passes on a box with 13 checks (stats ${JSON.stringify(st)})`);
  check(ok.geo === ok.results.get('b')!.geo, 'assert passes the geometry through unchanged (same object)');

  const grid = await cook({ g: { type: 'grid' }, a: { type: 'assert', in: ['g'], params: { watertight: true, max_points: 50, expr: 'volume > 1', label: 'floor' } } });
  const msg = grid.errors[0]?.message ?? '';
  check(!grid.ok && /^floor: 3 of 3 check/.test(msg) && /watertight: 40 boundary edges/.test(msg) && /max_points: 121 points/.test(msg) && /volume 0/.test(msg), `assert fails on a grid listing each check: ${msg}`);
  const warn = await cook({ g: { type: 'grid' }, a: { type: 'assert', in: ['g'], params: { watertight: true, on_fail: 'warn' } } });
  check(warn.ok && warn.warnings.some((w) => /watertight/.test(w.message)), 'on_fail warn: passes with a warning');
  const mark = await cook({ g: { type: 'grid', params: { divisions: [4, 4] } }, a: { type: 'assert', in: ['g'], params: { watertight: true, bbox_max: [1, 1, 1], on_fail: 'mark' } } });
  const mg = mark.geo!;
  const primCount = mg.primGroups.get('assert_fail')?.reduce((s, x) => s + x, 0), ptCount = mg.pointGroups.get('assert_fail')?.reduce((s, x) => s + x, 0);
  check(mark.ok && mg.detail.get('assert_failed')?.get(0) === 2 && primCount === 12 && ptCount === 9 && /watertight/.test(String(mg.detail.get('assert_report')?.get(0))),
    `on_fail mark: detail assert_failed = 2, prim group assert_fail = the 12 rim quads (${primCount}), point group = the 9 points outside the bbox (${ptCount})`);
  const markOk = await geo({ ...box, a: { type: 'assert', in: ['b'], params: { watertight: true, on_fail: 'mark' } } });
  check(markOk.detail.get('assert_failed')?.get(0) === 0 && !markOk.primGroups.has('assert_fail'), 'on_fail mark on a pass: assert_failed 0, no group');
  const exprF = await cook({ ...box, a: { type: 'assert', in: ['b'], params: { expr: 'pieces == 2 || npoints > 100' } } });
  check(!exprF.ok && /"pieces == 2 \|\| npoints > 100" is false \(npoints 8, pieces 1\)/.test(exprF.errors[0]?.message ?? ''), `expr false lists the values it read: ${exprF.errors[0]?.message}`);
  const exprBad = await cook({ ...box, a: { type: 'assert', in: ['b'], params: { expr: 'volme > 1' } } });
  check(!exprBad.ok && /volme is not defined/.test(exprBad.errors[0]?.message ?? '') && /volume/.test(exprBad.errors[0]?.hint ?? ''), `bad expr is a node error with the names in the hint: ${exprBad.errors[0]?.message}`);
  const rev = await cook({ ...box, r: { type: 'reverse', in: ['b'] }, a: { type: 'assert', in: ['r'], params: { no_flipped: true } } });
  check(!rev.ok && /facing inward/.test(rev.errors[0]?.message ?? ''), 'no_flipped catches an inside-out box');
  const hollow = await cook({ o: { type: 'box' }, i: { type: 'box', params: { size: 0.8 } }, h: { type: 'boolean', in: ['o', 'i'], params: { operation: 'subtract' } }, a: { type: 'assert', in: ['h'], params: { no_flipped: true, watertight: true, expr: 'pieces == 2 && volume > 0.48 && volume < 0.49' } } }, 'a');
  check(hollow.ok, `no_flipped accepts the inward-facing wall of a cavity (hollow box: ${hollow.errors[0]?.message ?? 'ok'})`);
  const flipOne = await cook({ g: { type: 'grid', params: { divisions: [2, 2] } }, r: { type: 'reverse', in: ['g'], params: { group: '0' } }, a: { type: 'assert', in: ['r'], params: { no_flipped: true } } }, 'a');
  check(!flipOne.ok && /oppositely wound/.test(flipOne.errors[0]?.message ?? ''), 'no_flipped catches one reversed quad in a grid');
  const overlap = await cook({ ...box, b2: { type: 'transform', in: ['b'], params: { translate: [0.3, 0.3, 0.3] } }, m: { type: 'merge', in: ['b', 'b2'] }, a: { type: 'assert', in: ['m'], params: { no_self_intersections: true } } }, 'a');
  check(!overlap.ok && /crossing triangles/.test(overlap.errors[0]?.message ?? ''), `self-intersections between two overlapping boxes: ${overlap.errors[0]?.message}`);
  const sphereOk = await cook({ s: { type: 'sphere', params: { type: 'ico', level: 3 } }, a: { type: 'assert', in: ['s'], params: { no_self_intersections: true } } });
  check(sphereOk.ok, 'a sphere does not intersect itself');
  const capped = await cook({ s1: { type: 'sphere', params: { type: 'ico', level: 4 } }, s2: { type: 'transform', in: ['s1'], params: { translate: [1.5, 0, 0] } }, m: { type: 'merge', in: ['s1', 's2'] }, a: { type: 'assert', in: ['m'], params: { no_self_intersections: true, max_tests: 1000, on_fail: 'warn' } } }, 'a');
  check(capped.warnings.some((w) => /stopped after 1,000/.test(w.message) || /there may be more/.test(w.message)), 'self-intersection search says when it was capped');
  const dup = await cook({ ...box, m: { type: 'merge', in: ['b', 'b'] }, a: { type: 'assert', in: ['m'], params: { no_degenerate: true } } }, 'a');
  check(!dup.ok && /16 point\(s\) within/.test(dup.errors[0]?.message ?? ''), `no_degenerate finds coincident points: ${dup.errors[0]?.message}`);
  const attr = await cook({ ...box, c: { type: 'attrib_create', in: ['b'], params: { name: 'h', value: 2 } }, a: { type: 'assert', in: ['c'], params: { attrib: 'h', attrib_class: 'point', attrib_max: 1.5, group: 'nope' } } }, 'a');
  const am = attr.errors[0]?.message ?? '';
  check(!attr.ok && /8 point value\(s\) of "h" outside -inf \.\. 1\.5/.test(am) && /group: "nope" does not exist/.test(am), `attrib range and missing group: ${am}`);
  const short = await cook({ ...box, a: { type: 'assert', in: ['b'], params: { min_edge_length: 1.5 } } });
  check(!short.ok && /8 edge\(s\) shorter than 1\.5 \(shortest 1\)/.test(short.errors[0]?.message ?? ''), `min_edge_length: ${short.errors[0]?.message}`);
  const none = await cook({ ...box, a: { type: 'assert', in: ['b'] } });
  check(none.ok && none.warnings.some((w) => /no checks enabled/.test(w.message)), 'an assert without checks warns');
  const badBox = await cook({ ...box, a: { type: 'assert', in: ['b'], params: { bbox_max: [1, 2] } } });
  check(!badBox.ok && /bbox_max/.test(badBox.errors[0]?.message ?? ''), 'malformed bbox_max is a param error');
  const alias = await cook({ ...box, a: { type: 'expect', in: ['b'], params: { closed: true } } });
  check(alias.ok && alias.results.get('a')?.stats?.checks === 1, 'aliases: expect, closed → watertight');
}

// ---------------------------------------------------------------- core helpers
{
  const { values: ev, vectors } = symmetricEigen3([2, 0, 0, 0, 5, 0, 0, 0, 1]);
  check(ev[0] === 5 && Math.abs(vectors[0][1]) === 1, 'symmetricEigen3 sorts eigenvalues (largest first)');
  const tb = await geo({ t: { type: 'torus' } });
  const pr = pieceReport(tb);
  check(pr.pieces.length === 1 && pr.pieces[0].genus === 1 && pr.pieces[0].closed, 'pieceReport: a torus is one closed piece of genus 1');
  const scene = RayScene.of(await geo({ b: { type: 'box' } }));
  check(scene.inside(0, 0, 0) && !scene.inside(0.6, 0, 0) && Math.abs(scene.nearest(0, 0, 0, 1, 0, 0) - 0.5) < 1e-12 && scene.occluded(0, 0, 0, 0, 1, 0, 1) && !scene.occluded(0, 0, 0, 0, 1, 0, 0.4), 'RayScene: inside test, nearest hit, occluded within a distance');
  const si = selfIntersections(await geo({ b: { type: 'box', params: { divisions: [3, 3, 3] } } }));
  check(si.pairs === 0 && !si.capped, 'selfIntersections: none on a subdivided box (adjacent triangles excluded)');
}

// ---------------------------------------------------------------- explain / diff
{
  const box = await geo({ b: { type: 'box' } });
  const ex = explainGeometry(box, 'box');
  console.log(ex.split('\n').map((l) => '     ' + l).join('\n'));
  check(/reads as: one closed piece/.test(ex) && /mirror-symmetric across x \(plane x=0\), y \(plane y=0\), z \(plane z=0\)/.test(ex), 'explain(box): one closed piece and three symmetry planes');
  check(/box-like/.test(ex) && /watertight/.test(ex) && /genus 0/.test(ex) && ex.split('\n').length <= 40, 'explain(box): box-like, watertight, genus 0, at most 40 lines');
  const ring = explainGeometry(await geo({ t: { type: 'torus' } }));
  check(/torus-like/.test(ring) && /1 hole through it/.test(ring), 'explain(torus): ring with one hole');
  const shell = explainGeometry(await geo({ o: { type: 'box' }, i: { type: 'box', params: { size: 0.9 } }, h: { type: 'boolean', in: ['o', 'i'], params: { operation: 'subtract' } } }));
  const wall = Number(/([\d.]+) cm thin walls/.exec(shell)?.[1]);
  check(/inner cavity \(hollow\)/.test(shell) && Math.abs(wall - 5) < 0.25,`explain(hollow box): cavity and 5 cm walls: ${shell.split('\n')[0]}`);
  const lean = explainGeometry(await geo({ b: { type: 'box', params: { size: [4, 1, 0.5] } }, r: { type: 'transform', in: ['b'], params: { rotate: [0, 0, 30] } } }, 'r'));
  check(/principal axis \(0\.866, 0\.5, 0\)/.test(lean) && /aspect 8 : 2 : 1/.test(lean), 'explain: principal axis and aspect ratio of a rotated bar');
  const cloud = explainGeometry(await geo({ g: { type: 'grid' }, s: { type: 'scatter', in: ['g'], params: { count: 50 } } }));
  check(/point cloud of 50 points/.test(cloud), 'explain(points): point cloud');

  const scaled = await geo({ b: { type: 'box' }, s: { type: 'transform', in: ['b'], params: { scale: [1.2, 1, 1] } } });
  const d = diffGeometry(box, scaled, ['box', 'scaled']);
  console.log(d.text.split('\n').map((l) => '     ' + l).join('\n'));
  check(/bbox delta: min \(-0\.1, 0, 0\) max \(\+0\.1, 0, 0\) size \(\+0\.2, 0, 0\)/.test(d.text), 'diff: bbox delta of a box scaled 1.2 in x');
  check(Math.abs(d.hausdorff - 0.1) < 1e-9 && /Hausdorff 10 cm/.test(d.text), `diff: Hausdorff = the 0.1 offset (${d.hausdorff})`);
  const uni = diffGeometry(box, await geo({ b: { type: 'box' }, s: { type: 'transform', in: ['b'], params: { scale: 1.2 } } }));
  check(Math.abs(uni.hausdorff - 0.1 * Math.sqrt(3)) < 1e-9, `diff: uniform scale → corner offset 0.1·√3 (${f(uni.hausdorff)})`);
  const same = diffGeometry(box, box);
  check(same.identical && same.hausdorff < 1e-12 &&/no geometric change/.test(same.text), 'diff: identical geometry');
  const colored = await geo({ b: { type: 'box' }, c: { type: 'color', in: ['b'], params: { color: 'red' } }, g: { type: 'group', in: ['c'], params: { name: 'top', expr: '@P.y>0' } } }, 'g');
  const dc = diffGeometry(box, colored);
  check(/\+ point Cd f3/.test(dc.text) && /\+ prim top \(1\)/.test(dc.text) && /only attributes\/groups differ/.test(dc.text), 'diff: attribute and group changes');
}

console.log(`\nmeasure: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
