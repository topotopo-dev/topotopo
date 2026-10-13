// Behavioural tests for the XPBD cloth nodes: drape (pins, colliders, floor, wind, self collision) and inflate.
//   node test/cloth.ts
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { TriBVH } from '../src/core/spatial.ts';
import { buildCloth, colourConstraints, dihedralAngle, fastAtan2, meshVolume, stretchChains } from '../src/core/xpbd.ts';
import type { Geometry } from '../src/core/geometry.ts';
import type { NodeSpec } from '../src/graph/types.ts';

const engine = new Engine(createNodeHost({ workers: 0 }));
await engine.init();

let fail = 0, pass = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
  if (ok) pass++; else fail++;
};

async function cook(nodes: Record<string, NodeSpec>, output = 'out', e = engine) {
  return e.cook({ nodes, output });
}
async function geo(nodes: Record<string, NodeSpec>, output = 'out', e = engine): Promise<Geometry> {
  const r = await cook(nodes, output, e);
  if (!r.ok || !r.geo) throw new Error(`cook failed: ${r.errors.map((x) => `[${x.node}] ${x.message}`).join('; ')}`);
  return r.geo;
}
/** |strain| of every polygon side against rest_P, sorted ascending by value. */
function strains(g: Geometry): number[] {
  const rest = g.points.get('rest_P')!.data as Float64Array, P = g.P, out: number[] = [];
  for (let p = 0; p < g.numPrims; p++) {
    const s = g.primStart[p], e = g.primStart[p + 1];
    for (let v = s; v < e; v++) {
      const a = g.vertexPoint[v], b = g.vertexPoint[v + 1 < e ? v + 1 : s];
      const l0 = Math.hypot(rest[a * 3] - rest[b * 3], rest[a * 3 + 1] - rest[b * 3 + 1], rest[a * 3 + 2] - rest[b * 3 + 2]);
      const l = Math.hypot(P[a * 3] - P[b * 3], P[a * 3 + 1] - P[b * 3 + 1], P[a * 3 + 2] - P[b * 3 + 2]);
      out.push(l / l0 - 1);
    }
  }
  return out.sort((x, y) => x - y);
}
const finite = (a: ArrayLike<number>) => { for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false; return true; };
const sameBits = (a: Float64Array, b: Float64Array) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

// ---------------------------------------------------------------- core helpers
{
  let worst = 0;
  for (let k = 0; k < 2000; k++) {
    const t = (k / 2000) * 2 * Math.PI - Math.PI, r = 0.3 + (k % 7);
    worst = Math.max(worst, Math.abs(fastAtan2(r * Math.sin(t), r * Math.cos(t)) - Math.atan2(r * Math.sin(t), r * Math.cos(t))) % (2 * Math.PI));
  }
  check(worst < 2e-5, `fastAtan2 within 2e-5 rad of Math.atan2 (worst ${worst.toExponential(2)})`);

  // dihedral angle: 0 flat, ±90° folded either way (x1, x2 wings; x3 → x4 the shared edge)
  const flat = [0.5, 1, 0, 0.5, -1, 0, 0, 0, 0, 1, 0, 0];
  const up = [0.5, 0, 1, 0.5, -1, 0, 0, 0, 0, 1, 0, 0], down = [0.5, 0, -1, 0.5, -1, 0, 0, 0, 0, 1, 0, 0];
  const a0 = dihedralAngle(flat, 0, 1, 2, 3), a1 = dihedralAngle(up, 0, 1, 2, 3), a2 = dihedralAngle(down, 0, 1, 2, 3);
  check(Math.abs(a0) < 1e-12 && Math.abs(Math.abs(a1) - Math.PI / 2) < 1e-4 && Math.abs(a1 + a2) < 1e-9, `dihedralAngle: flat 0, folds ±90° (${a1.toFixed(5)}, ${a2.toFixed(5)})`);

  // stretch chains of a grid are its rows and columns, every edge in exactly one chain
  const grid = await geo({ out: { type: 'grid', params: { size: [4, 3], divisions: [4, 3] } } });
  const m = buildCloth(grid, { density: 0.2, stretch: 1e4, shear: 1e3, bend: 1e-3, restScale: 1 });
  const chains = m.cStart.length - 1, seen = new Int32Array(m.nStretch);
  for (const c of m.cCons) seen[c]++;
  check(chains === (3 + 1) + (4 + 1) && m.cPts.length === 4 * 5 + 5 * 4 && seen.every((v) => v === 1),
    `stretchChains: a 4×3 grid gives 9 chains (its rows and columns) covering every edge once (got ${chains})`);
  const again = stretchChains(m.X, m.dA, m.dB, m.nStretch, m.n);
  check(sameBits(Float64Array.from(again.cPts), Float64Array.from(m.cPts)), 'stretchChains is deterministic');

  // colouring: no two constraints of one colour share a point
  let clash = false;
  for (let c = 0; c + 1 < m.dColours.length && !clash; c++) {
    const used = new Set<number>();
    for (let j = m.dColours[c]; j < m.dColours[c + 1]; j++) {
      if (used.has(m.dA[j]) || used.has(m.dB[j])) clash = true;
      used.add(m.dA[j]); used.add(m.dB[j]);
    }
  }
  check(!clash && m.dColours[m.dColours.length - 1] === m.dA.length, `colourConstraints: ${m.dColours.length - 1} colours, none shares a point`);
  const tiny = colourConstraints(2, Int32Array.of(0, 1, 1, 2, 2, 0), 3, 3);
  check(tiny.starts.length - 1 === 3, 'colourConstraints: a triangle of edges needs three colours');
  const box = await geo({ out: { type: 'box', params: { size: [2, 1, 1] } } });
  const bm = buildCloth(box, { density: 0.2, stretch: 1e4, shear: 0, bend: 0, restScale: 1 });
  check(Math.abs(meshVolume(bm.X, bm.tris) - 2) < 1e-12, 'meshVolume of a 2×1×1 box is 2');
}

// ---------------------------------------------------------------- pinned cloth hangs
const hangNodes = (extra: Record<string, any> = {}): Record<string, NodeSpec> => ({
  g: { type: 'grid', params: { size: [1, 1], divisions: [20, 20], plane: 'xy', center: [0, 2, 0] } },
  out: { type: 'drape', in: ['g'], params: { steps: 60, pin_group: '@P.y>2.49', floor: false, ...extra } },
});
{
  const g = await geo(hangNodes());
  const pinned = g.points.get('pinned')!.data as Int32Array, P = g.P;
  let pinY = Infinity, low = Infinity, pinsStay = true;
  const rest = g.points.get('rest_P')!.data as Float64Array;
  for (let i = 0; i < g.numPoints; i++) {
    if (pinned[i]) {
      pinY = Math.min(pinY, P[i * 3 + 1]);
      if (Math.hypot(P[i * 3] - rest[i * 3], P[i * 3 + 1] - rest[i * 3 + 1], P[i * 3 + 2] - rest[i * 3 + 2]) !== 0) pinsStay = false;
    } else low = Math.min(low, P[i * 3 + 1]);
  }
  const s = strains(g);
  check(finite(P) && finite(g.points.get('v')!.data as Float64Array), 'pinned cloth: no NaN in P or v');
  check(low < pinY - 0.9, `pinned cloth hangs: lowest point ${low.toFixed(3)} below the pins at ${pinY.toFixed(3)}`);
  check(pinsStay && pinned.reduce((a, b) => a + b, 0) === 21, 'pinned cloth: the 21 pinned points do not move');
  check(s[0] > -0.02 && s[s.length - 1] < 0.01, `pinned cloth keeps its rest lengths (strain ${(s[0] * 100).toFixed(2)}% .. ${(s[s.length - 1] * 100).toFixed(2)}%)`);
  // without tethers the stretch chains alone hold it too
  const nt = strains(await geo(hangNodes({ tethers: false })));
  check(nt[nt.length - 1] < 0.03, `without tethers the stretch chains keep the hanging cloth within 3% (max ${(nt[nt.length - 1] * 100).toFixed(2)}%)`);
}

// ---------------------------------------------------------------- drape over a box and the floor
const T = 0.03;
const drapeNodes = (extra: Record<string, any> = {}): Record<string, NodeSpec> => ({
  g: { type: 'grid', params: { size: [2.4, 2.4], divisions: [32, 32], center: [0, 1.2, 0] } },
  table: { type: 'box', params: { size: [1, 0.8, 1], center: [0, 0.4, 0] } },
  out: { type: 'drape', in: ['g', 'table'], params: { steps: 90, thickness: T, ...extra } },
});
{
  const g = await geo(drapeNodes());
  const table = await geo(drapeNodes(), 'table');
  const bvh = new TriBVH(table), P = g.P;
  let minD = Infinity, minY = Infinity, inside = 0, resting = 0, onTop = 0, topDev = 0;
  for (let i = 0; i < g.numPoints; i++) {
    const h = bvh.closest(P[i * 3], P[i * 3 + 1], P[i * 3 + 2])!;
    if (bvh.inside(P[i * 3], P[i * 3 + 1], P[i * 3 + 2])) inside++;
    minD = Math.min(minD, h.dist);
    if (h.dist < T * 1.05) resting++;
    if (P[i * 3 + 1] > 0.8 && Math.abs(P[i * 3]) < 0.4 && Math.abs(P[i * 3 + 2]) < 0.4) { onTop++; topDev = Math.max(topDev, Math.abs(P[i * 3 + 1] - (0.8 + T))); }
    minY = Math.min(minY, P[i * 3 + 1]);
  }
  check(inside === 0 && minD > T * 0.98, `drape: no point inside the box, all at least the thickness away (min ${minD.toFixed(4)}, thickness ${T})`);
  check(resting > 100 && onTop > 50 && topDev < 0.005, `drape: the cloth rests on the box (${resting} points within the thickness; ${onTop} on the top within ${(topDev * 1000).toFixed(2)} mm of 0.8 + thickness)`);
  check(minY > T - 1e-9 && minY < T + 1e-6, `drape: the hanging cloth reaches the floor and stays above it (min y ${minY.toFixed(5)})`);
  // the box's sharp top corners stay under the cloth (corner contacts): a ray down onto each corner meets the cloth above it
  const clothBvh = new TriBVH(g);
  let covered = 0;
  for (const [cx, cz] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) {
    const hit = clothBvh.raycast(cx, 5, cz, 0, -1, 0);
    if (hit && hit.pos[1] > 0.8 + 0.5 * T) covered++;
  }
  check(covered === 4, `drape: the four sharp top corners of the box stay under the cloth (${covered}/4)`);
  const s = strains(g), mean = s.reduce((a, b) => a + Math.abs(b), 0) / s.length, med = Math.abs(s[s.length >> 1]);
  check(mean < 0.015 && med < 0.005, `drape: rest lengths kept after settling (mean |strain| ${(mean * 100).toFixed(2)}%, median ${(med * 100).toFixed(3)}%)`);
  const stiff = strains(await geo(drapeNodes({ stretch_stiffness: 1e7, substeps: 6 })));
  const stiffMean = stiff.reduce((a, b) => a + Math.abs(b), 0) / stiff.length;
  check(stiffMean < 0.01, `drape with a high stretch stiffness: mean |strain| ${(stiffMean * 100).toFixed(2)}% < 1%`);
  // output keeps the input's topology and attributes
  const src = await geo(drapeNodes(), 'g');
  const same = g.numPoints === src.numPoints && g.numPrims === src.numPrims && sameBits(Float64Array.from(g.vertexPoint), Float64Array.from(src.vertexPoint));
  const rest = g.points.get('rest_P')!.data as Float64Array;
  check(same && sameBits(rest, src.P), 'drape keeps points, prims and vertices; rest_P is the input P');
  check(['v', 'N', 'uv'].every((n) => g.points.has(n) || g.vertices.has(n)) && !g.points.has('pinned'), 'drape writes v and N, keeps uv, no pinned attribute without pins');
  const noRest = await geo(drapeNodes({ keep_rest: false, steps: 2 }));
  check(!noRest.points.has('rest_P'), 'keep_rest: false leaves rest_P out');
}

// ---------------------------------------------------------------- an open collider (a table top sheet) collides from either side
{
  const nodes: Record<string, NodeSpec> = {
    g: { type: 'grid', params: { size: [1, 1], divisions: [16, 16], center: [0, 1, 0] } },
    top: { type: 'grid', params: { size: [3, 3], divisions: [3, 3], center: [0, 0.5, 0] } },
    flipped: { type: 'reverse', in: ['top'] },
    out: { type: 'drape', in: ['g', 'top'], params: { steps: 40, floor: false, thickness: 0.02 } },
    out2: { type: 'drape', in: ['g', 'flipped'], params: { steps: 40, floor: false, thickness: 0.02 } },
  };
  for (const o of ['out', 'out2']) {
    const g = await geo(nodes, o);
    let lo = Infinity;
    for (let i = 0; i < g.numPoints; i++) lo = Math.min(lo, g.P[i * 3 + 1]);
    check(Math.abs(lo - 0.52) < 1e-6, `open collider (${o === 'out' ? 'normals up' : 'normals down'}): the cloth lands on the sheet (min y ${lo.toFixed(5)})`);
  }
}

// ---------------------------------------------------------------- determinism and pool parity
{
  const a = await geo(drapeNodes({ steps: 40, self_collision: true }));
  engine.cache.clear();
  const b = await geo(drapeNodes({ steps: 40, self_collision: true }));
  check(sameBits(a.P, b.P), 'drape is deterministic (two cooks, the same bits)');
  const pooled = new Engine(createNodeHost({ workers: 3, pool: { minElements: 1 } }));
  await pooled.init();
  const c = await geo(drapeNodes({ steps: 40, self_collision: true }), 'out', pooled);
  check(sameBits(a.P, c.P) && sameBits(a.points.get('v')!.data as Float64Array, c.points.get('v')!.data as Float64Array), 'drape: the same bits with the collider queries on the worker pool');
  check(pooled.poolStats.parallel > 0, `the pooled cook ran the collision kernel on worker threads (${pooled.poolStats.parallel} jobs, ${pooled.poolStats.chunks} chunks)`);
  const seeded = await geo(drapeNodes({ steps: 40, self_collision: true, seed: 7 }));
  check(!sameBits(a.P, seeded.P), 'seed changes the start jitter (a different result)');
  await pooled.host.pool?.close();
}

// ---------------------------------------------------------------- max_points guard
{
  const r = await cook({ g: { type: 'grid', params: { divisions: [20, 20] } }, out: { type: 'drape', in: ['g'], params: { max_points: 100 } } });
  check(!r.ok && /max_points/.test(r.errors[0]?.message ?? ''), `max_points refuses a 441-point cloth (${r.errors[0]?.message})`);
}

// ---------------------------------------------------------------- pins input and pin_snap, wind
{
  const nodes: Record<string, NodeSpec> = {
    g: { type: 'grid', params: { size: [1, 1], divisions: [10, 10], plane: 'xy', center: [0, 2, 0] } },
    hooks: { type: 'points', params: { points: [[-0.6, 2.6, 0], [0.6, 2.6, 0]] } },
    out: { type: 'drape', in: ['g', null, 'hooks'], params: { steps: 30, pin_snap: true, floor: false } },
  };
  const g = await geo(nodes);
  const pinned = g.points.get('pinned')!.data as Int32Array, P = g.P;
  const at: number[][] = [];
  for (let i = 0; i < g.numPoints; i++) if (pinned[i]) at.push([P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]);
  at.sort((x, y) => x[0] - y[0]);
  check(at.length === 2 && Math.hypot(at[0][0] + 0.6, at[0][1] - 2.6) < 1e-12 && Math.hypot(at[1][0] - 0.6, at[1][1] - 2.6) < 1e-12,
    'pins input + pin_snap: the two nearest cloth corners hang exactly from the hooks');
  const calm = await geo(hangNodes({ steps: 40 }));
  const windy = await geo(hangNodes({ steps: 40, wind: [0, 0, 4] }));
  let zc = 0, zw = 0;
  for (let i = 0; i < calm.numPoints; i++) { zc += calm.P[i * 3 + 2]; zw += windy.P[i * 3 + 2]; }
  check(zw / windy.numPoints > zc / calm.numPoints + 0.1, `wind +z blows the pinned banner downwind (mean z ${(zc / calm.numPoints).toFixed(3)} → ${(zw / windy.numPoints).toFixed(3)})`);
  const attr: Record<string, NodeSpec> = {
    g: { type: 'grid', params: { size: [1, 1], divisions: [6, 6], plane: 'xy', center: [0, 2, 0] } },
    w: { type: 'wrangle', in: ['g'], params: { code: 'i@pin = @P.y > 2.49 ? 1 : 0;' } },
    out: { type: 'drape', in: ['w'], params: { steps: 20, floor: false } },
  };
  const ga = await geo(attr);
  const pa = ga.points.get('pinned')!.data as Int32Array;
  check(pa.reduce((s, v) => s + v, 0) === 7 && ga.points.has('pin'), 'a `pin` point attribute pins its points and is kept');
}

// ---------------------------------------------------------------- self collision keeps layers apart
{
  const nodes = (self: boolean): Record<string, NodeSpec> => ({
    lower: { type: 'grid', params: { size: [1, 1], divisions: [20, 20], center: [0, 0.3, 0] } },
    upper: { type: 'grid', params: { size: [0.8, 0.8], divisions: [16, 16], center: [0.012, 0.6, 0.017] } },
    both: { type: 'merge', in: ['lower', 'upper'] },
    out: { type: 'drape', in: ['both'], params: { steps: 50, thickness: 0.025, self_collision: self, friction: 0.8 } },
  });
  // the upper layer's lowest point: resting on the lower layer (more than a thickness above it) with self collision, on the floor without
  const upperLow = (g: Geometry) => {
    let m = Infinity;
    for (let i = 21 * 21; i < g.numPoints; i++) m = Math.min(m, g.P[i * 3 + 1]);
    return m;
  };
  const on = upperLow(await geo(nodes(true))), off = upperLow(await geo(nodes(false)));
  check(on > 0.05 && off < 0.026, `self_collision stacks the upper layer on the lower one (its lowest point at ${on.toFixed(4)}; without: ${off.toFixed(4)}, on the floor)`);
}

// ---------------------------------------------------------------- inflate
{
  const ratios: number[] = [];
  for (const pressure of [1, 1.25, 1.5, 2, 3]) {
    const r = await cook({ bag: { type: 'box', params: { size: [1, 0.3, 1], divisions: [8, 3, 8] } }, out: { type: 'inflate', in: ['bag'], params: { pressure, steps: 40 } } });
    const g = r.geo!, rest = g.points.get('rest_P')!.data as Float64Array;
    const m = buildCloth(g, { density: 0.2, stretch: 1, shear: 0, bend: 0, restScale: 1 });
    ratios.push(meshVolume(g.P, m.tris) / meshVolume(rest, m.tris));
    if (pressure === 1.5) check(Math.abs((r.results.get('out')?.stats?.volume_ratio ?? 0) - ratios[ratios.length - 1]) < 1e-9, 'inflate reports the volume ratio it reached');
  }
  check(Math.abs(ratios[0] - 1) < 0.01, `inflate with pressure 1 keeps the volume (ratio ${ratios[0].toFixed(4)})`);
  check(ratios.every((v, i) => i === 0 || v > ratios[i - 1] + 0.05), `inflate: the volume grows monotonically with pressure (${ratios.map((v) => v.toFixed(3)).join(' < ')})`);
  const open = await cook({ g: { type: 'grid', params: { divisions: [4, 4] } }, out: { type: 'inflate', in: ['g'] } });
  check(open.ok && open.warnings.some((w) => /not closed/.test(w.message)), 'inflate warns about an open mesh');
  const none = await cook({ p: { type: 'points', params: { points: [[0, 0, 0], [1, 0, 0]] } }, out: { type: 'inflate', in: ['p'] } });
  check(!none.ok && /no polygons/.test(none.errors[0]?.message ?? ''), 'inflate refuses an input without polygons');
}

// ---------------------------------------------------------------- the node examples cook
{
  const { getNodeDef } = await import('../src/graph/registry.ts');
  for (const t of ['drape', 'inflate']) {
    const r = await engine.cook(getNodeDef(t)!.example);
    check(r.ok && !!r.geo && finite(r.geo.P), `${t} example cooks`);
  }
}

console.log(`\ncloth: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
