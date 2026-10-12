// Behavioural tests for the deformers: soft_transform, lattice, path_deform, point_deform, rest (+ rest-aware noise).
//   node test/deform.ts
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { falloffWeight } from '../src/nodes/util.ts';
import { hornRotation, nearestRotation } from '../src/nodes/deform.ts';
import { m4euler, qRotate } from '../src/core/math.ts';
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
const maxDiff = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  if (a.length !== b.length) return Infinity;
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};
const pt = (g: Geometry, i: number) => [g.P[i * 3], g.P[i * 3 + 1], g.P[i * 3 + 2]];
const near = (a: number[], b: number[], tol = 1e-9) => maxDiff(a, b) <= tol;

// ---------------------------------------------------------------- helpers
{
  for (const k of ['smooth', 'linear', 'ease_in', 'ease_out', 'sharp']) {
    let prev = 2, mono = true;
    for (let d = 0; d <= 1.0001; d += 0.05) { const w = falloffWeight(k, d); if (w > prev + 1e-12) mono = false; prev = w; }
    check(falloffWeight(k, 0) === 1 && falloffWeight(k, 1) === 0 && mono, `falloff ${k}: 1 at the group, 0 at the radius, monotone`);
  }
  check(Math.abs(falloffWeight('smooth', 0.5) - 0.5) < 1e-12, 'falloff smooth is smoothstep');
  check(Math.abs(falloffWeight('ramp', 0.25, [{ pos: 0, value: 1 }, { pos: 0.5, value: 0 }]) - 0.5) < 1e-12, 'falloff ramp evaluates the ramp at d');

  // Horn: recover a rotation from point pairs (full rank and planar), nearest rotation of a scaled rotation
  const R = m4euler([25, -40, 70]);
  const rot = (v: number[]) => [R[0] * v[0] + R[4] * v[1] + R[8] * v[2], R[1] * v[0] + R[5] * v[1] + R[9] * v[2], R[2] * v[0] + R[6] * v[1] + R[10] * v[2]];
  for (const pts of [[[1, 0.2, 0], [0, 1, 0.3], [0.1, 0, 1], [-1, 0.5, 0.2]], [[1, 0, 0], [0, 1, 0], [1, 1, 0], [-0.5, 0.3, 0]]]) {
    const S = new Array(9).fill(0);
    for (const a of pts) { const b = rot(a); for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) S[r * 3 + c] += a[r] * b[c]; }
    const q = hornRotation(S);
    const v = [0.3, -0.7, 0.5];
    check(near(qRotate(q, v as any), rot(v), 1e-9), `hornRotation recovers the rotation (${pts[0][2] === 0 && pts[2][2] === 0 ? 'planar' : 'full-rank'} set)`);
  }
  const L = [R[0] * 2, R[4] * 3, R[8] * 0.5, R[1] * 2, R[5] * 3, R[9] * 0.5, R[2] * 2, R[6] * 3, R[10] * 0.5]; // R · diag(2, 3, 0.5)
  check(near(qRotate(nearestRotation(L), [0.3, -0.7, 0.5]), rot([0.3, -0.7, 0.5]), 1e-9), 'nearestRotation strips the stretch');
}

// ---------------------------------------------------------------- soft_transform
{
  const grid: NodeSpec = { type: 'grid', params: { size: [4, 4], divisions: [40, 40] } };
  const base = await geo({ g: grid });
  let c = -1;
  for (let i = 0; i < base.numPoints; i++) if (Math.hypot(base.P[i * 3], base.P[i * 3 + 2]) < 1e-9) c = i;
  const out = await geo({ g: grid, s: { type: 'soft_transform', in: ['g'], params: { group: String(c), translate: [0, 1, 0], radius: 1, weight_attrib: 'w' } } });
  const w = out.points.get('w')!.data as Float64Array;
  let okFar = true, okW = true, okY = true;
  for (let i = 0; i < out.numPoints; i++) {
    const d = Math.hypot(base.P[i * 3], base.P[i * 3 + 2]);
    const want = d >= 1 ? 0 : falloffWeight('smooth', d);
    if (Math.abs(w[i] - want) > 1e-9) okW = false;
    if (Math.abs(out.P[i * 3 + 1] - want) > 1e-9) okY = false;
    if (d >= 1 && maxDiff(pt(out, i), pt(base, i)) > 1e-12) okFar = false;
  }
  check(Math.abs(out.P[c * 3 + 1] - 1) < 1e-12, 'soft_transform: the group gets the full translate');
  check(okW && okY, 'soft_transform: weights and lift follow the smooth falloff of the distance');
  check(okFar, 'soft_transform: points beyond the radius do not move');

  // surface distance does not jump across a gap; euclidean does
  const two: Record<string, NodeSpec> = {
    a: grid,
    b: { type: 'grid', params: { size: [4, 4], divisions: [40, 40], center: [0, 0.2, 0] } },
    m: { type: 'merge', in: ['a', 'b'] },
  };
  const eu = await geo({ ...two, s: { type: 'soft_transform', in: ['m'], params: { group: String(c), translate: [0, 1, 0], radius: 1 } } });
  const su = await geo({ ...two, s: { type: 'soft_transform', in: ['m'], params: { group: String(c), translate: [0, 1, 0], radius: 1, distance: 'surface' } } });
  const cb = base.numPoints + c;
  check(eu.P[cb * 3 + 1] > 1, 'soft_transform euclidean: reaches the other piece across the gap');
  check(Math.abs(su.P[cb * 3 + 1] - 0.2) < 1e-12, 'soft_transform surface: the other piece stays put');
  const along = c + 10; // 10 cells (1 m) along the row: at the radius
  check(Math.abs(su.P[(c + 5) * 3 + 1] - 0.5) < 1e-9 && Math.abs(su.P[along * 3 + 1]) < 1e-12, 'soft_transform surface: edge distance along the grid');

  // empty group = rigid transform about the centroid; vectors rotate
  const pts: NodeSpec = { type: 'points', params: { positions: [[1, 0, 0], [3, 0, 0]], attribs: { N: [[1, 0, 0], [0, 1, 0]], orient: [[0, 0, 0, 1], [0, 0, 0, 1]] } } };
  const rr = await geo({ p: pts, s: { type: 'soft_transform', in: ['p'], params: { rotate: [0, 0, 90] } } });
  check(near(pt(rr, 0), [2, -1, 0]) && near(pt(rr, 1), [2, 1, 0]), 'soft_transform: empty group rotates everything about the centroid');
  const N = rr.points.get('N')!.data as Float64Array, O = rr.points.get('orient')!.data as Float64Array;
  check(near([N[0], N[1], N[2]], [0, 1, 0]) && near([N[3], N[4], N[5]], [-1, 0, 0]), 'soft_transform: N rotates with the transform');
  check(near([O[0], O[1], O[2], O[3]], [0, 0, Math.SQRT1_2, Math.SQRT1_2]), 'soft_transform: orient rotates with the transform');
}

// ---------------------------------------------------------------- lattice
{
  const ball: NodeSpec = { type: 'sphere', params: { type: 'ico', level: 3, radius: 1 } };
  const affine = { translate: [0.3, -0.1, 0.2], rotate: [10, 20, 30], scale: [1.2, 0.8, 1.1], pivot: [0.1, 0, 0] };
  const want = await geo({ b: ball, t: { type: 'transform', in: ['b'], params: affine } });
  const restGrid: NodeSpec = { type: 'point_grid', params: { counts: [4, 3, 5], size: [1.2, 1, 1.4] } }; // smaller than the ball
  const ident = await geo({ b: ball, r: restGrid, d: restGrid, l: { type: 'lattice', in: ['b', 'r', 'd'] } }, 'l');
  const src = await geo({ b: ball });
  check(maxDiff(ident.P, src.P) < 1e-12, 'lattice: undeformed lattice leaves the geometry unchanged');
  for (const interp of ['trilinear', 'bernstein']) {
    const g = await geo({ b: ball, r: restGrid, d: { type: 'transform', in: ['r'], params: affine }, l: { type: 'lattice', in: ['b', 'r', 'd'], params: { interp } } }, 'l');
    check(maxDiff(g.P, want.P) < 1e-9, `lattice ${interp}: an affine lattice gives the affine map, inside and outside (max err ${maxDiff(g.P, want.P).toExponential(1)})`);
  }
  // two-input form: bound(divisions) → deform → lattice; the box lacks interior nodes (harmonic fill)
  const two: Record<string, NodeSpec> = {
    b: ball,
    cage: { type: 'bound', in: ['b'], params: { divisions: [2, 3, 2] } },
    d: { type: 'transform', in: ['cage'], params: affine },
  };
  const g2 = await geo({ ...two, l: { type: 'lattice', in: ['b', 'd'], params: { divisions: [2, 3, 2] } } }, 'l');
  check(maxDiff(g2.P, want.P) < 1e-8, `lattice two-input (bound, interior filled): affine exact (max err ${maxDiff(g2.P, want.P).toExponential(1)})`);
  const r3 = await cook({ ...two, l: { type: 'lattice', in: ['b', 'd'], params: { divisions: [4, 4, 4] } } }, 'l');
  check(r3.ok && r3.warnings.some((w) => /using divisions \[2, 3, 2\]/.test(w.message)) && maxDiff(r3.geo!.P, want.P) < 1e-8, 'lattice: mismatched divisions are inferred with a warning');
  const r4 = await cook({ ...two, rest: { type: 'rest', in: ['cage'] }, d: { type: 'transform', in: ['rest'], params: affine }, l: { type: 'lattice', in: ['b', 'd'], params: { divisions: [7, 7, 7] } } }, 'l');
  check(r4.ok && !r4.warnings.length && maxDiff(r4.geo!.P, want.P) < 1e-8, 'lattice: a "rest" attribute on the deformed lattice is its rest');
  const pg = await geo({ b: ball, pgd: { type: 'point_grid', params: { counts: [3, 3, 3], size: [2, 2, 2] } }, d: { type: 'transform', in: ['pgd'], params: affine }, l: { type: 'lattice', in: ['b', 'd'] } }, 'l');
  check(maxDiff(pg.P, want.P) < 1e-8, 'lattice two-input with a point-only lattice uses point_grid order');
  // bent column: bottom stays, top leans
  const col: Record<string, NodeSpec> = {
    c: { type: 'tube', params: { radius: 0.2, height: 2, rows: 20, center: [0, 1, 0] } },
    cage: { type: 'bound', in: ['c'], params: { divisions: [1, 4, 1] } },
    bent: { type: 'bend', in: ['cage'], params: { angle: 60 } },
    l: { type: 'lattice', in: ['c', 'bent'], params: { divisions: [1, 4, 1] } },
  };
  const bc = await geo(col, 'l'), c0 = await geo(col, 'c');
  let bottom = 0, topShift = 0;
  for (let i = 0; i < bc.numPoints; i++) {
    if (c0.P[i * 3 + 1] < 1e-9) bottom = Math.max(bottom, maxDiff(pt(bc, i), pt(c0, i)));
    if (c0.P[i * 3 + 1] > 2 - 1e-9) topShift = Math.max(topShift, bc.P[i * 3]);
  }
  check(bottom < 1e-9 && topShift > 0.5, `lattice: bent cage bends the column (bottom fixed, top x up to ${topShift.toFixed(2)})`);
  const bad = await cook({ b: ball, r: restGrid, d: { type: 'point_grid', params: { counts: [2, 2, 2] } }, l: { type: 'lattice', in: ['b', 'r', 'd'] } }, 'l');
  check(!bad.ok && /must match/.test(bad.errors[0]?.message ?? ''), 'lattice: rest/deformed count mismatch is a node error');
  const rot = await cook({ b: ball, r: { type: 'transform', in: ['g'], params: { rotate: [0, 30, 0] } }, g: restGrid, l: { type: 'lattice', in: ['b', 'r', 'r'] } }, 'l');
  check(!rot.ok && /axis-aligned/.test(rot.errors[0]?.message ?? ''), 'lattice: a rotated rest lattice is reported, not silently wrong');
}

// ---------------------------------------------------------------- path_deform
{
  const bar: NodeSpec = { type: 'box', params: { size: [0.2, 0.3, 2], center: [0, 0, 1], divisions: [1, 1, 8] } };
  const b0 = await geo({ b: bar });
  const idZ = await geo({ b: bar, c: { type: 'line', params: { direction: [0, 0, 1], length: 3 } }, d: { type: 'path_deform', in: ['b', 'c'] } }, 'd');
  check(maxDiff(idZ.P, b0.P) < 1e-12, 'path_deform: a straight path along +Z from the origin is the identity');
  const barX: NodeSpec = { type: 'box', params: { size: [2, 0.3, 0.2], center: [1, 0, 0], divisions: [8, 1, 1] } };
  const bx0 = await geo({ b: barX });
  const idX = await geo({ b: barX, c: { type: 'line', params: { direction: [1, 0, 0], length: 3, points: 5 } }, d: { type: 'path_deform', in: ['b', 'c'], params: { axis: 'x' } } }, 'd');
  check(maxDiff(idX.P, bx0.P) < 1e-12, 'path_deform axis x: a straight path along +X is the identity');
  const idY = await geo({ b: bar, t: { type: 'transform', in: ['b'], params: { rotate: [-90, 0, 0] } }, c: { type: 'line', params: { direction: [0, 1, 0], length: 3 } }, d: { type: 'path_deform', in: ['t', 'c'], params: { axis: 'y' } } }, 'd');
  const ty = await geo({ b: bar, t: { type: 'transform', in: ['b'], params: { rotate: [-90, 0, 0] } } }, 't');
  check(maxDiff(idY.P, ty.P) < 1e-12, 'path_deform axis y: a straight path along +Y is the identity');

  // around a circle: the axis line lands on the circle, arc length preserved
  const R = 2;
  const line: NodeSpec = { type: 'points', params: { positions: Array.from({ length: 11 }, (_, i) => [0, 0, i * 0.5]) } };
  const circ: NodeSpec = { type: 'circle', params: { radius: R, segments: 512 } };
  const oc = await geo({ l: line, c: circ, d: { type: 'path_deform', in: ['l', 'c'] } }, 'd');
  let onCircle = true;
  for (let i = 0; i < oc.numPoints; i++) if (Math.abs(Math.hypot(oc.P[i * 3], oc.P[i * 3 + 2]) - R) > 1e-4 || Math.abs(oc.P[i * 3 + 1]) > 1e-9) onCircle = false;
  const chord = Math.hypot(oc.P[30] - oc.P[0], oc.P[32] - oc.P[2]); // point 10 is 5 m along the circle
  check(onCircle && Math.abs(chord - 2 * R * Math.sin(5 / (2 * R))) < 1e-3, 'path_deform: points on the axis follow a circular path at the right arc length');

  // stretch maps the bbox onto the whole curve
  const seg: NodeSpec = { type: 'points', params: { positions: [[0, 0, 0.5], [0, 0, 1], [0, 0, 1.5]] } };
  const st = await geo({ s: seg, c: { type: 'line', params: { direction: [1, 0, 0], length: 4 } }, d: { type: 'path_deform', in: ['s', 'c'], params: { stretch: true } } }, 'd');
  check(near(pt(st, 0), [0, 0, 0]) && near(pt(st, 1), [2, 0, 0]) && near(pt(st, 2), [4, 0, 0]), 'path_deform stretch: the extent covers the curve');
  const st2 = await geo({ s: seg, c: { type: 'line', params: { direction: [1, 0, 0], length: 4 } }, d: { type: 'path_deform', in: ['s', 'c'], params: { stretch: true, length: 1, offset: 0.5 } } }, 'd');
  check(near(pt(st2, 0), [0.5, 0, 0]) && near(pt(st2, 2), [1.5, 0, 0]), 'path_deform stretch with length and offset');

  // the frame rotates positions and vectors: a path along +X is a 90° turn about Y for Z-aligned geometry
  const one: NodeSpec = { type: 'points', params: { positions: [[0.1, 0.2, 0.5]], attribs: { N: [[1, 0, 0]], up: [[0, 0, 1]], orient: [[0, 0, 0, 1]] } } };
  const fr = await geo({ o: one, c: { type: 'line', params: { direction: [1, 0, 0], length: 2 } }, d: { type: 'path_deform', in: ['o', 'c'] } }, 'd');
  const fN = fr.points.get('N')!.data as Float64Array, fU = fr.points.get('up')!.data as Float64Array, fO = fr.points.get('orient')!.data as Float64Array;
  check(near(pt(fr, 0), [0.5, 0.2, -0.1]), 'path_deform: positions follow the curve frame');
  check(near([fN[0], fN[1], fN[2]], [0, 0, -1]) && near([fU[0], fU[1], fU[2]], [1, 0, 0]), 'path_deform: N and up rotate with the frame');
  check(near(qRotate([fO[0], fO[1], fO[2], fO[3]], [0, 0, 1]), [1, 0, 0]), 'path_deform: orient rotates with the frame');

  // twist accumulates along the curve
  const tip: NodeSpec = { type: 'points', params: { positions: [[0.1, 0, 2]] } };
  const tw = await geo({ t: tip, c: { type: 'line', params: { direction: [0, 0, 1], length: 2 } }, d: { type: 'path_deform', in: ['t', 'c'], params: { twist: 90 } } }, 'd');
  check(near(pt(tw, 0), [0, 0.1, 2]), 'path_deform: twist rotates the cross-section about the path');

  // rest curve: geometry modelled along a rest curve gives the same result as the straight reference
  const rc = await geo({ b: bar, c: circ, r: { type: 'line', params: { direction: [0, 0, 1], length: 2, points: 9 } }, d: { type: 'path_deform', in: ['b', 'c', 'r'] } }, 'd');
  const nr = await geo({ b: bar, c: circ, d: { type: 'path_deform', in: ['b', 'c'] } }, 'd');
  check(maxDiff(rc.P, nr.P) < 1e-9, `path_deform rest curve: matches the straight reference (max err ${maxDiff(rc.P, nr.P).toExponential(1)})`);
  const noCurve = await cook({ b: bar, c: { type: 'points', params: { positions: [[0, 0, 0]] } }, d: { type: 'path_deform', in: ['b', 'c'] } }, 'd');
  check(!noCurve.ok && /no curve/.test(noCurve.errors[0]?.message ?? ''), 'path_deform: a missing curve is a node error');
}

// ---------------------------------------------------------------- point_deform
{
  const tubeG: NodeSpec = { type: 'tube', params: { radius: 0.3, height: 2, rows: 16, center: [0, 1, 0] } };
  const proxy: NodeSpec = { type: 'point_grid', params: { counts: [3, 6, 3], size: [0.8, 2, 0.8], center: [0, 1, 0] } };
  const g0 = await geo({ g: tubeG });
  const id = await geo({ g: tubeG, r: proxy, d: proxy, o: { type: 'point_deform', in: ['g', 'r', 'd'] } }, 'o');
  check(maxDiff(id.P, g0.P) < 1e-12, 'point_deform: an undeformed proxy leaves the geometry unchanged');
  const rigid = { translate: [0.5, 0.2, -0.3], rotate: [15, 40, -20], pivot: [0, 1, 0] };
  const wantR = await geo({ g: tubeG, t: { type: 'transform', in: ['g'], params: rigid } }, 't');
  for (const mode of ['rigid', 'affine']) {
    const o = await geo({ g: tubeG, r: proxy, d: { type: 'transform', in: ['r'], params: rigid }, o: { type: 'point_deform', in: ['g', 'r', 'd'], params: { mode } } }, 'o');
    check(maxDiff(o.P, wantR.P) < 1e-7, `point_deform ${mode}: a rigidly moved proxy moves the geometry rigidly (max err ${maxDiff(o.P, wantR.P).toExponential(1)})`);
  }
  const scaled = { ...rigid, scale: 1.5 };
  const wantS = await geo({ g: tubeG, t: { type: 'transform', in: ['g'], params: scaled } }, 't');
  const af = await geo({ g: tubeG, r: proxy, d: { type: 'transform', in: ['r'], params: scaled }, o: { type: 'point_deform', in: ['g', 'r', 'd'], params: { mode: 'affine' } } }, 'o');
  check(maxDiff(af.P, wantS.P) < 1e-7, `point_deform affine: a scaled proxy scales the geometry (max err ${maxDiff(af.P, wantS.P).toExponential(1)})`);
  const tr = await geo({ g: tubeG, r: proxy, d: { type: 'transform', in: ['r'], params: { translate: [1, 2, 3] } }, o: { type: 'point_deform', in: ['g', 'r', 'd'], params: { mode: 'translate' } } }, 'o');
  let okT = true;
  for (let i = 0; i < tr.numPoints; i++) if (!near(pt(tr, i), [g0.P[i * 3] + 1, g0.P[i * 3 + 1] + 2, g0.P[i * 3 + 2] + 3], 1e-9)) okT = false;
  check(okT, 'point_deform translate: a translated proxy translates the geometry');
  const two = await geo({ g: tubeG, r: proxy, rest: { type: 'rest', in: ['r'] }, d: { type: 'transform', in: ['rest'], params: rigid }, o: { type: 'point_deform', in: ['g', 'd'] } }, 'o');
  check(maxDiff(two.P, wantR.P) < 1e-7, 'point_deform two-input: the proxy\'s "rest" attribute is the rest');
  // bending the proxy bends the geometry smoothly: no point jumps relative to its neighbours along the tube
  const bent = await geo({ g: tubeG, r: proxy, d: { type: 'bend', in: ['r'], params: { angle: 90 } }, o: { type: 'point_deform', in: ['g', 'r', 'd'] } }, 'o');
  let maxEdge = 0;
  for (let p = 0; p < bent.numPrims; p++) {
    const ids = bent.primPoints(p);
    for (let k = 0; k < ids.length; k++) maxEdge = Math.max(maxEdge, Math.hypot(...[0, 1, 2].map((c) => bent.P[ids[k] * 3 + c] - bent.P[ids[(k + 1) % ids.length] * 3 + c])));
  }
  check(maxEdge < 0.3, `point_deform: a bent proxy gives a continuous result (longest edge ${maxEdge.toFixed(3)})`);
  const vec = await geo({ p: { type: 'points', params: { positions: [[0.1, 1, 0]], attribs: { N: [[1, 0, 0]] } } }, r: proxy, d: { type: 'transform', in: ['r'], params: { rotate: [0, 90, 0], pivot: [0, 1, 0] } }, o: { type: 'point_deform', in: ['p', 'r', 'd'] } }, 'o');
  const vN = vec.points.get('N')!.data as Float64Array;
  check(near([vN[0], vN[1], vN[2]], [0, 0, -1], 1e-6), 'point_deform: N rotates with the proxy');
  const bad = await cook({ g: tubeG, r: proxy, d: { type: 'point_grid', params: { counts: [2, 2, 2] } }, o: { type: 'point_deform', in: ['g', 'r', 'd'] } }, 'o');
  check(!bad.ok && /must match/.test(bad.errors[0]?.message ?? ''), 'point_deform: rest/deformed count mismatch is a node error');
  const norest = await cook({ g: tubeG, r: proxy, o: { type: 'point_deform', in: ['g', 'r'] } }, 'o');
  check(!norest.ok && /rest/.test(norest.errors[0]?.message ?? ''), 'point_deform: two inputs without a rest attribute is a node error');
}

// ---------------------------------------------------------------- rest + rest-aware noise
{
  const ball: NodeSpec = { type: 'sphere', params: { type: 'ico', level: 3 } };
  const r = await geo({ b: ball, r: { type: 'rest', in: ['b'], params: { normals: true } } }, 'r');
  check(maxDiff(r.points.get('rest')!.data as Float64Array, r.P) === 0 && r.points.has('rnml'), 'rest: copies P (and rnml)');
  const r2 = await geo({ b: ball, t: { type: 'transform', in: ['b'], params: { translate: [1, 0, 0] } }, r: { type: 'rest', in: ['b', 't'], params: { name: 'pref' } } }, 'r');
  const b0 = await geo({ b: ball });
  check(maxDiff(r2.points.get('pref')!.data as Float64Array, b0.P.map((v, i) => (i % 3 === 0 ? v + 1 : v))) < 1e-12, 'rest: from the second input, custom name');
  const mm = await cook({ b: ball, x: { type: 'box' }, r: { type: 'rest', in: ['b', 'x'] } }, 'r');
  check(!mm.ok, 'rest: point count mismatch is a node error');

  const noise = { amplitude: 0.3, frequency: 2 };
  const moveThenNoise = await geo({ b: ball, r: { type: 'rest', in: ['b'] }, t: { type: 'transform', in: ['r'], params: { translate: [3, 1, 0] } }, n: { type: 'noise_displace', in: ['t'], params: noise } }, 'n');
  const noiseThenMove = await geo({ b: ball, n: { type: 'noise_displace', in: ['b'], params: noise }, t: { type: 'transform', in: ['n'], params: { translate: [3, 1, 0] } } }, 't');
  check(maxDiff(moveThenNoise.P, noiseThenMove.P) < 1e-9, 'noise_displace samples at "rest": the pattern sticks to moved geometry');
  const ignore = await geo({ b: ball, r: { type: 'rest', in: ['b'] }, t: { type: 'transform', in: ['r'], params: { translate: [3, 1, 0] } }, n: { type: 'noise_displace', in: ['t'], params: { ...noise, rest_attrib: '' } } }, 'n');
  const plain = await geo({ b: ball, t: { type: 'transform', in: ['b'], params: { translate: [3, 1, 0] } }, n: { type: 'noise_displace', in: ['t'], params: noise } }, 'n');
  check(maxDiff(ignore.P, plain.P) === 0, 'noise_displace rest_attrib "": samples at P as before');
  const an1 = await geo({ b: ball, r: { type: 'rest', in: ['b'] }, t: { type: 'transform', in: ['r'], params: { rotate: [0, 45, 0] } }, n: { type: 'attrib_noise', in: ['t'], params: { name: 'm' } } }, 'n');
  const an0 = await geo({ b: ball, n: { type: 'attrib_noise', in: ['b'], params: { name: 'm' } } }, 'n');
  check(maxDiff(an1.points.get('m')!.data as Float64Array, an0.points.get('m')!.data as Float64Array) === 0, 'attrib_noise samples at "rest"');
}

console.log(`deform: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
