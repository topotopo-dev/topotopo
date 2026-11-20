// bake_edge_wear. Checks what it promises: on a decimated sphere with a rim, no chips on the facets at a radius of twice
// their edges and chips on the rim; a box chips on its edges only, its flats read 0; a larger amount only adds wear; core
// inside bare inside chip, texel for texel; the focus raises wear on the edges near a handle more than on the flat beside
// it, which never chips; the same wear on both sides of a uv seam and at two texel densities across an edge; a part keeps
// its chips when another part is added or the prims are reordered; seeds differ; the same bits with and without the
// worker pool; a bolt standing on a plate makes the plate concave around it, not chipped; every refusal and the warning;
// the time limit.
//   node test/edgewear.ts
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { findImage } from '../src/core/image.ts';
import type { Image } from '../src/core/image.ts';
import type { Geometry } from '../src/core/geometry.ts';
import type { GraphSpec, NodeSpec } from '../src/graph/types.ts';
import { wearThreshold } from '../src/nodes/surface.ts';

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
const max = (v: number[]) => { let m = -Infinity; for (const x of v) if (x > m) m = x; return m; };
const mean = (v: number[]) => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN);
const share = (v: number[]) => (v.length ? v.filter((x) => x >= 0.5).length / v.length : NaN);

/** The covered texels of a wear bake 'm' with their world position (a bake_position of the same mesh and size). */
interface Texels { idx: number[]; P: Float32Array; im: Image; c: Cooked; at(layer: string, k: number): number; p(k: number): [number, number, number] }
async function texels(nodes: Nodes, mesh: string, wear: Record<string, unknown>, engine = serial, ins: string[] = [mesh]): Promise<Texels> {
  const res = wear.resolution as number;
  const c = await cook({ ...nodes, m: { type: 'bake_edge_wear', in: ins, params: wear }, pos: { type: 'bake_position', in: [mesh], params: { resolution: res, mode: 'world', padding: 0 } }, both: { type: 'merge', in: ['m', 'pos'] } }, 'both', engine, 'm');
  const im = img(c, 'm'), P = img(c, 'pos').layer('C')!, mask = im.layer('mask')!;
  const idx: number[] = [];
  for (let k = 0; k < mask.length; k++) if (mask[k] >= 1) idx.push(k);
  return { c, idx, P, im, at: (layer, k) => im.layer(layer)![k], p: (k) => [P[k * 4], P[k * 4 + 1], P[k * 4 + 2]] };
}
/** Nesting: texels where core > bare or bare > chip, over every image checked so far. */
let nestChecked = 0, nestBad = 0;
const nest = (im: Image) => {
  const ch = im.layer('chip')!, ba = im.layer('bare')!, co = im.layer('core')!, mk = im.layer('mask')!;
  for (let k = 0; k < mk.length; k++) { if (!(mk[k] > 0)) continue; nestChecked++; if (co[k] > ba[k] + 1e-6 || ba[k] > ch[k] + 1e-6) nestBad++; }
};
const named = (name: string, src: string, node: NodeSpec): Nodes => ({
  [src]: node,
  [name]: { type: 'wrangle', in: [src], params: { run_over: 'prims', code: `s@name = '${name}';` } },
});

// the node's example: a 40 × 30 × 30 cm box with 4 mm bevels
const BOX: Nodes = {
  b0: { type: 'box', params: { size: [0.4, 0.3, 0.3] } },
  b1: { type: 'poly_bevel', in: ['b0'], params: { offset: 0.004 } },
  bx: { type: 'uv_unwrap', in: ['b1'] },
};
const HALF = [0.2, 0.15, 0.15];
/** Distance from a point on the box to the nearest edge of its face. */
const toEdge = (p: number[]) => {
  let a = 0;
  for (let i = 1; i < 3; i++) if (Math.abs(p[i]) / HALF[i] > Math.abs(p[a]) / HALF[a]) a = i;
  let d = Infinity;
  for (let i = 0; i < 3; i++) if (i !== a) d = Math.min(d, HALF[i] - Math.abs(p[i]));
  return Math.max(0, d);
};

section('a decimated sphere with a rim: no chips on the facets at radius 2 × edge, chips on the rim');
{
  const nodes: Nodes = {
    s0: { type: 'sphere', params: { radius: 0.5, rows: 48, cols: 96 } },
    s1: { type: 'clip', in: ['s0'], params: { origin: [0, 0.25, 0], keep: 'below', cap: true } },
    s2: { type: 'decimate', in: ['s1'], params: { ratio: 0.25 } },
    s3: { type: 'normal', in: ['s2'], params: { cusp_angle: 45 } },
    sph: { type: 'uv_unwrap', in: ['s3'] },
  };
  const g = (await cook(nodes, 'sph')).geo;
  const L: number[] = [];
  for (let p = 0; p < g.numPrims; p++) {
    const s = g.primStart[p], e = g.primStart[p + 1];
    for (let v = s; v < e; v++) { const a = g.vertexPoint[v] * 3, b = g.vertexPoint[v + 1 < e ? v + 1 : s] * 3; L.push(Math.hypot(g.P[a] - g.P[b], g.P[a + 1] - g.P[b + 1], g.P[a + 2] - g.P[b + 2])); }
  }
  L.sort((x, y) => x - y);
  const edge = L[L.length >> 1], r = 2 * edge, amount = 0.8;
  const t = await texels(nodes, 'sph', { resolution: 512, radius: r, amount });
  nest(t.im);
  const ball: number[] = [], ballC: number[] = [], rim: number[] = [];
  for (const k of t.idx) {
    const p = t.p(k), rr = Math.hypot(p[0], p[2]);
    if (p[1] < 0.25 - 1.2 * r - 0.05 && p[1] > -0.4) { ball.push(t.at('chip', k)); ballC.push(t.at('C', k)); }
    if (Math.hypot(rr - 0.433, p[1] - 0.25) < 0.004) rim.push(t.at('chip', k));
  }
  console.log(`  median edge ${(edge * 1000).toFixed(0)} mm, radius ${(r * 1000).toFixed(0)} mm, amount ${amount}: sphere C max ${f3(max(ballC))} (threshold ${f3(wearThreshold(amount))}), rim chipped ${f3(share(rim))}`);
  check(ball.length > 5000 && max(ball) === 0, `the faceted sphere: no chip on ${ball.length} texels (C at most ${f3(max(ballC))})`);
  check(rim.length > 200 && share(rim) > 0.4, `the rim: ${(share(rim) * 100).toFixed(0)}% of ${rim.length} texels within 4 mm chipped (> 40%)`);
  check(!t.c.warnings.some((w) => w.includes('facet size')), 'no facet warning at radius 2 × edge');
  const small = await cook({ ...nodes, m: { type: 'bake_edge_wear', in: ['sph'], params: { resolution: 64, radius: edge / 4 } } }, 'm');
  check(small.warnings.some((w) => /bake_edge_wear: radius \d+ mm is under twice the facet size of piece \d+ \(\d+ mm\); its facets will read as edges: raise radius to \d+ mm or more/.test(w)), `radius a quarter of an edge: ${small.warnings.find((w) => w.includes('facet')) ?? 'no facet warning'}`);
}

section('a box chips on its edges only; a larger amount only adds wear');
{
  const at: Record<number, Texels> = {};
  for (const amount of [0.3, 0.6, 0.9]) { at[amount] = await texels(BOX, 'bx', { resolution: 512, amount }); nest(at[amount].im); }
  const t = at[0.9];
  const flat: number[] = [], flatC: number[] = [], edge: number[] = [];
  let far = 0;
  for (const k of t.idx) {
    const d = toEdge(t.p(k)), ch = t.at('chip', k);
    if (d > 0.03) { flat.push(ch); flatC.push(t.at('C', k)); }
    if (d < 0.004) edge.push(ch);
    if (ch > 0) far = Math.max(far, d);
  }
  check(flat.length > 10000 && max(flatC) === 0 && max(flat) === 0, `amount 0.9: the flats more than 3 cm from an edge read 0 (${flat.length} texels, C max ${max(flatC)})`);
  check(share(edge) > 0.3, `… ${(share(edge) * 100).toFixed(0)}% of the texels within 4 mm of an edge chipped`);
  check(far < 0.008 + 0.004 + 0.004, `… no chip farther than ${(far * 1000).toFixed(1)} mm from an edge (width + radius + 4 mm = 16 mm)`);
  const C3 = at[0.3].im.layer('C')!, C6 = at[0.6].im.layer('C')!;
  check(same(C3, C6), 'the wear field C does not depend on amount');
  for (const l of ['chip', 'bare', 'core']) {
    const a = at[0.3].im.layer(l)!, b = at[0.6].im.layer(l)!, c = at[0.9].im.layer(l)!;
    let bad = 0;
    for (let k = 0; k < a.length; k++) if (b[k] < a[k] || c[k] < b[k]) bad++;
    const n = [a, b, c].map((x) => x.filter((v) => v >= 0.5).length);
    check(bad === 0 && n[0] < n[1] && n[1] < n[2], `${l}: every texel worn at 0.3 is worn at 0.6 and 0.9 (${n.join(' < ')} texels)`);
  }
  const s = [0.3, 0.6, 0.9].map((a) => at[a].c.stats.chip_share);
  check(s[0] < s[1] && s[1] < s[2], `chip_share ${s.map(f3).join(' < ')}`);
}

section('focus: more wear on the edges near a handle, the flat beside it only rubbed');
{
  // a cabinet door 60 × 80 × 30 cm with a latch 1.5 cm from its edge at x = 0.3
  const nodes: Nodes = {
    ...named('body', 'd0', { type: 'box', params: { size: [0.6, 0.8, 0.3], center: [0, 0.4, 0] } }),
    ...named('latch', 'l0', { type: 'box', params: { size: [0.03, 0.1, 0.03], center: [0.27, 0.45, 0.165] } }),
    dl: { type: 'merge', in: ['body', 'latch'] },
    door: { type: 'uv_unwrap', in: ['dl'] },
  };
  const fa = 0.5, params = { resolution: 1024, amount: 0.5, focus_amount: fa };
  const a = await texels(nodes, 'door', params), b = await texels(nodes, 'door', { ...params, focus: '@name=latch' });
  nest(a.im); nest(b.im);
  const near: number[][] = [[], []], far: number[][] = [[], []], flat: number[][] = [[], []], flatChip: number[] = [], latchCore: number[] = [];
  for (const k of a.idx) {
    const p = a.p(k);
    const onFront = Math.abs(p[2] - 0.15) < 1e-4, onSide = Math.abs(p[0] - 0.3) < 1e-4;
    const atEdge = (onFront && p[0] > 0.296) || (onSide && p[2] > 0.146);
    for (const [i, t] of [[0, a], [1, b]] as const) {
      if (atEdge && Math.abs(p[1] - 0.45) < 0.05) near[i].push(t.at('C', k));
      if (atEdge && Math.abs(p[1] - 0.1) < 0.05) far[i].push(t.at('C', k));
      // the front beside the latch, between 5 mm and 5 cm from it, 8 cm and more from every edge of the door
      if (onFront && p[0] > 0.175 && p[0] < 0.22 && p[1] > 0.4 && p[1] < 0.5) flat[i].push(t.at('C', k));
    }
    if (onFront && p[0] > 0.175 && p[0] < 0.22 && p[1] > 0.4 && p[1] < 0.5) flatChip.push(b.at('chip', k));
    if (p[2] > 0.1501 && Math.abs(p[0] - 0.27) < 0.016 && Math.abs(p[1] - 0.45) < 0.051) latchCore.push(b.at('core', k));
  }
  const dn = mean(near[1]) - mean(near[0]), df = mean(flat[1]) - mean(flat[0]), dfar = Math.abs(mean(far[1]) - mean(far[0]));
  console.log(`  edge by the latch ${f3(mean(near[0]))} → ${f3(mean(near[1]))}; flat beside ${f3(mean(flat[0]))} → ${f3(mean(flat[1]))} (max ${f3(max(flat[1]))}); edge 35 cm away ${f3(mean(far[0]))} → ${f3(mean(far[1]))}`);
  check(near[0].length > 100 && flat[0].length > 1000, `regions: ${near[0].length} edge texels by the latch, ${flat[0].length} on the flat beside it`);
  check(dn > 0.05 && dn > 2 * df, `the focus raises the edge by the latch by ${f3(dn)}, more than twice the flat beside it (${f3(df)})`);
  check(max(flat[1]) <= 0.12 * fa + 1e-6 && max(flatChip) === 0, `the flat beside the latch stays at or under 0.12 × focus_amount = ${f3(0.12 * fa)} (max ${f3(max(flat[1]))}) and never chips`);
  check(dfar < 1e-6, `an edge outside focus_radius is unchanged (${f3(mean(far[0]))} → ${f3(mean(far[1]))})`);
  check(latchCore.length > 100 && max(latchCore) === 0, `no core on the latch itself (hands keep the metal bright; ${latchCore.length} texels)`);
  const hd = b.im.layer('handled')!;
  check(latchCore.length && b.idx.some((k) => hd[k] === 1) && max(a.idx.map((k) => a.at('handled', k))) === 0, 'handled: 1 on the focus prims, 0 everywhere without a focus');
}

section('the same wear across uv seams and at two texel densities across an edge');
{
  // a 1 m cube, one chart per face (16 per side): seams cross every face and run along every edge
  const cube: Nodes = {
    c0: { type: 'box', params: { size: [1, 1, 1], divisions: [4, 4, 4] } },
    // the face of each prim (from its centre), baked beside the wear: a texel's face is its own triangle's
    c1: { type: 'wrangle', in: ['c0'], params: { run_over: 'prims', code: 'i@chart = @primnum; f@face = abs(@P.x) > 0.49 ? (@P.x > 0 ? 1 : 0) : (abs(@P.y) > 0.49 ? (@P.y > 0 ? 3 : 2) : (@P.z > 0 ? 5 : 4));' } },
    cube: { type: 'uv_flatten', in: ['c1'], params: { chart_attrib: 'chart', resolution: 512, padding: 2 } },
  };
  const wear = { resolution: 512, radius: 0.04, width: 0.05, chip_size: 0.03, patch_size: 0.4, amount: 0.6 };
  const t = await texels(cube, 'cube', wear);
  nest(t.im);
  const texel = t.im.layer('texel')!, island = t.im.layer('island')!;
  const sizes = t.idx.map((k) => Math.max(texel[k * 4], texel[k * 4 + 1])).sort((x, y) => x - y);
  const h = 0.25 * sizes[sizes.length >> 1], grid = new Map<string, number[]>();
  const key = (p: number[]) => `${Math.floor(p[0] / h)},${Math.floor(p[1] / h)},${Math.floor(p[2] / h)}`;
  // two texels at an edge on two faces are not a seam pair
  const cf = img(await cook({ ...cube, fm: { type: 'bake_mask', in: ['cube'], params: { resolution: 512, attrib: 'face', padding: 0 } } }, 'fm'), 'fm').layer('C')!;
  for (const k of t.idx) { const s = key(t.p(k)); (grid.get(s) ?? grid.set(s, []).get(s)!).push(k); }
  let pairs = 0, worstC = 0, worstX = 0, flips = 0, nearEdge = 0;
  for (const a of t.idx) {
    const pa = t.p(a), cx = Math.floor(pa[0] / h), cy = Math.floor(pa[1] / h), cz = Math.floor(pa[2] / h);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const b of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
        if (b <= a || island[a] === island[b]) continue;
        const pb = t.p(b);
        if (Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]) > h || cf[a] !== cf[b]) continue;
        pairs++;
        const q = [...pa].map(Math.abs).sort((x, y) => y - x);
        if (q[1] > 0.45) nearEdge++;
        worstC = Math.max(worstC, Math.abs(t.at('C', a) - t.at('C', b)));
        worstX = Math.max(worstX, Math.abs(t.at('convex', a) - t.at('convex', b)));
        if ((t.at('chip', a) >= 0.5) !== (t.at('chip', b) >= 0.5)) flips++;
      }
    }
  }
  check(pairs > 500 && nearEdge > 50, `${pairs} texel pairs across seams within a quarter texel of each other, ${nearEdge} of them within 5 cm of an edge`);
  check(worstC <= 0.03 && worstX <= 0.02, `C differs by at most ${f3(worstC)} (≤ 0.03), convex by ${f3(worstX)} (≤ 0.02) across the seams`);
  check(flips / pairs < 0.01, `chip on one side and not the other: ${flips} of ${pairs} pairs (< 1%, on the soft outline)`);
  // a 1 m box with the +x side at 1, 0.5 and 0.25 of the top's texel density: the top along that edge
  const strip = async (w: number) => {
    const nodes: Nodes = {
      e0: { type: 'box', params: { size: [1, 1, 1], center: [0, 0.5, 0] } },
      e1: { type: 'wrangle', in: ['e0'], params: { run_over: 'prims', code: `f@texel_weight = @P.x > 0.49 ? ${w} : 1;` } },
      ex: { type: 'uv_unwrap', in: ['e1'] },
    };
    const s = await texels(nodes, 'ex', wear);
    nest(s.im);
    const top = s.idx.filter((k) => { const p = s.p(k); return Math.abs(p[1] - 1) < 1e-4 && p[0] > 0.47 && Math.abs(p[2]) < 0.4; });
    return { C: mean(top.map((k) => s.at('C', k))), chip: share(top.map((k) => s.at('chip', k))) };
  };
  const d = [await strip(1), await strip(0.5), await strip(0.25)];
  // the defaults (4 mm radius) on the example's bevelled box, its +x side at 1 and 0.25 of the texel density
  const small = async (w: number) => {
    const nodes: Nodes = { ...BOX, bw: { type: 'wrangle', in: ['b1'], params: { run_over: 'prims', code: `f@texel_weight = @P.x > 0.19 ? ${w} : 1;` } }, bwx: { type: 'uv_unwrap', in: ['bw'] } };
    const s = await texels(nodes, 'bwx', { resolution: 1024, amount: 0.6 });
    nest(s.im);
    const top = s.idx.filter((k) => { const p = s.p(k); return p[1] > 0.1499 && p[0] > 0.19 && Math.abs(p[2]) < 0.12; });
    return { C: mean(top.map((k) => s.at('C', k))), n: top.length };
  };
  const sm = [await small(1), await small(0.25)];
  check(sm[1].n > 1000 && Math.abs(sm[0].C - sm[1].C) < 0.03, `the defaults on a 4 mm bevel: the top within 1 cm of the edge reads C ${f3(sm[0].C)} / ${f3(sm[1].C)} at side densities 1 / 0.25 (within 0.03)`);
  check(d.every((x) => Math.abs(x.C - d[0].C) < 0.03 && Math.abs(x.chip - d[0].chip) < 0.05), `the top within 3 cm of the edge: C ${d.map((x) => f3(x.C)).join(' / ')}, chipped ${d.map((x) => f3(x.chip)).join(' / ')} at side densities 1 / 0.5 / 0.25 (within 0.03 and 0.05)`);
}

section('a part keeps its chips when another part is added or the prims are reordered');
{
  // the example box in the lower-left quarter of the uv square; a copy 1 m away in the upper-right quarter
  const nodes: Nodes = {
    ...BOX,
    a: { type: 'uv_transform', in: ['bx'], params: { scale: [0.5, 0.5], pivot: [0, 0] } },
    mv: { type: 'transform', in: ['bx'], params: { translate: [1, 0, 0] } },
    b: { type: 'uv_transform', in: ['mv'], params: { scale: [0.5, 0.5], pivot: [0, 0], translate: [0.5, 0.5] } },
    ab: { type: 'merge', in: ['a', 'b'] },
    ba: { type: 'merge', in: ['b', 'a'] },
    rev: { type: 'sort', in: ['ab'], params: { class: 'prim', by: 'reverse' } },
  };
  const wear = { resolution: 1024, amount: 0.7 };
  const alone = await texels(nodes, 'a', wear);
  const worst = async (mesh: string) => {
    const t = await texels(nodes, mesh, wear);
    nest(t.im);
    let c = 0, ch = 0, moved = 0;
    for (const k of alone.idx) {
      const d = Math.abs(t.at('C', k) - alone.at('C', k));
      c = Math.max(c, d); ch = Math.max(ch, Math.abs(t.at('chip', k) - alone.at('chip', k)));
      if (d > 1e-6) moved++;
    }
    return { c, ch, moved };
  };
  const chipped = alone.idx.filter((k) => alone.at('chip', k) >= 0.5).length;
  for (const [mesh, label] of [['ab', 'another part added'], ['ba', 'another part added before it']]) {
    const w = await worst(mesh);
    check(chipped > 1000 && w.c === 0 && w.ch === 0, `${label}: the box's wear unchanged, texel for texel (${chipped} chipped texels; C worst ${w.c.toExponential(1)})`);
  }
  // a texel centre exactly on an edge two triangles share goes to the later one (the shared rasterisation of every bake):
  // the box's cloud is the same, a few such texels on its bevel creases read the other triangle
  const r = await worst('rev');
  check(r.moved <= 1e-4 * alone.idx.length, `prims in reverse order: ${r.moved} of ${alone.idx.length} texels differ (at most 0.01%: centres on a shared triangle edge)`);
}

section('seeds differ; the same bits with and without the pool');
{
  const a = img(await cook({ ...BOX, m: { type: 'bake_edge_wear', in: ['bx'], params: { resolution: 256, amount: 0.7, seed: 0 } } }, 'm'), 'm');
  const b = img(await cook({ ...BOX, m: { type: 'bake_edge_wear', in: ['bx'], params: { resolution: 256, amount: 0.7, seed: 7 } } }, 'm'), 'm');
  const ca = a.layer('chip')!, cb = b.layer('chip')!;
  let both = 0, either = 0;
  for (let k = 0; k < ca.length; k++) { const x = ca[k] >= 0.5, y = cb[k] >= 0.5; if (x || y) either++; if (x && y) both++; }
  check(either > 500 && both / either < 0.8, `seed 0 and 7: ${both} of ${either} chipped texels in common (< 80%)`);
  check(same(a.layer('convex')!, b.layer('convex')!) && Math.abs(a.layer('chip')!.filter((v) => v >= 0.5).length / Math.max(1, either) - b.layer('chip')!.filter((v) => v >= 0.5).length / Math.max(1, either)) < 0.25, '… the edges and roughly the amount stay');
  // a door with a latch on the ground, with a focus, cooked on this thread and on the pool
  const nodes: Nodes = {
    ...named('body', 'd0', { type: 'box', params: { size: [0.6, 0.8, 0.3], center: [0, 0.4, 0] } }),
    ...named('latch', 'l0', { type: 'box', params: { size: [0.03, 0.1, 0.03], center: [0.27, 0.45, 0.165] } }),
    dl: { type: 'merge', in: ['body', 'latch'] },
    door: { type: 'uv_unwrap', in: ['dl'] },
    ground: { type: 'box', params: { size: [2, 0.1, 2], center: [0, -0.05, 0] } },
  };
  const layers = ['C', 'chip', 'bare', 'core', 'convex', 'concave', 'handled', 'texel', 'island', 'mask'];
  const bake = (res: number, method = 'surface'): Nodes => ({ ...nodes, m: { type: 'bake_edge_wear', in: ['door', 'ground'], params: { resolution: res, radius: 0.02, width: 0.03, chip_size: 0.02, method, focus: '@name=latch', seed: 3 } } });
  const s = img(await cook(bake(128), 'm', serial), 'm'), p = img(await cook(bake(128), 'm', pooled), 'm');
  check(layers.every((l) => same(s.layer(l)!, p.layer(l)!)), `every layer bit-identical on the cooking thread and on 4 workers (${layers.join(', ')})`);
  const s2 = img(await cook(bake(96), 'm', serial), 'm'), p2 = img(await cook(bake(96), 'm', pooled2), 'm');
  check(layers.every((l) => same(s2.layer(l)!, p2.layer(l)!)), 'at 96 texels on 2 workers');
  const s3 = img(await cook(bake(96, 'dihedral'), 'm', serial), 'm'), p3 = img(await cook(bake(96, 'dihedral'), 'm', pooled), 'm');
  check(layers.every((l) => same(s3.layer(l)!, p3.layer(l)!)), 'method dihedral: the same bits');
  check(JSON.stringify([...s.layers.keys()]) === JSON.stringify(layers), `layers: ${[...s.layers.keys()].join(', ')}`);
  for (const im of [s, s2, s3]) nest(im);
}

section('a bolt standing on a plate: the plate concave around it, not chipped');
{
  const nodes: Nodes = {
    ...named('plate', 'p0', { type: 'box', params: { size: [0.3, 0.02, 0.3], center: [0, 0.01, 0] } }),
    ...named('bolt', 'q0', { type: 'box', params: { size: [0.03, 0.02, 0.03], center: [0, 0.03, 0] } }),
    pq: { type: 'merge', in: ['plate', 'bolt'] },
    kit: { type: 'uv_unwrap', in: ['pq'] },
  };
  const t = await texels(nodes, 'kit', { resolution: 1024, amount: 0.9 });
  nest(t.im);
  const ring: number[] = [], ringCav: number[] = [], top: number[] = [];
  for (const k of t.idx) {
    const p = t.p(k), d = Math.max(Math.abs(p[0]), Math.abs(p[2])) - 0.015;
    if (Math.abs(p[1] - 0.02) < 1e-4 && d > 0.0005 && d < 0.004) { ring.push(t.at('chip', k)); ringCav.push(t.at('concave', k)); }
    if (Math.abs(p[1] - 0.04) < 1e-4 && d > -0.003) top.push(t.at('chip', k));
  }
  console.log(`  plate within 0.5–4 mm of the bolt: concave ${f3(mean(ringCav))}, chip max ${f3(max(ring))}; bolt top within 3 mm of its edges chipped ${f3(share(top))}`);
  check(ring.length > 200 && mean(ringCav) > 0.3 && max(ring) === 0, `the plate around the bolt: concave ${f3(mean(ringCav))} (> 0.3), no chip on ${ring.length} texels`);
  check(share(top) > 0.3, `the bolt's own top edges chip (${(share(top) * 100).toFixed(0)}%)`);
}

section('refusals, warnings, names');
{
  const UV: Nodes = { u0: { type: 'box', params: { size: [1, 1, 1] } }, ub: { type: 'uv_unwrap', in: ['u0'] } };
  const w = (params: Record<string, unknown>, extra: Nodes = UV, src = 'ub') => err({ ...extra, m: { type: 'bake_edge_wear', in: [src], params: { resolution: 32, ...params } } }, 'm');
  const has = async (p: Promise<string>, want: string) => { const e = await p; check(e.includes(want), `"${want}"${e.includes(want) ? '' : ` — got: ${e}`}`); };
  await has(w({ radius: 0 }), 'bake_edge_wear: radius must be above 0 (radius: 0.004 measures edges at 4 mm)');
  await has(w({ width: 0 }), 'bake_edge_wear: width must be above 0 (width: 0.008 lets wear reach 8 mm in from an edge)');
  await has(w({ chip_size: -1 }), 'bake_edge_wear: chip_size must be above 0');
  await has(w({ patch_size: 0 }), 'bake_edge_wear: patch_size must be above 0');
  const kit: Nodes = { ...named('plate', 'p0', { type: 'box', params: { size: [0.3, 0.02, 0.3] } }), ...named('bolt', 'q0', { type: 'box', params: { size: [0.03, 0.02, 0.03], center: [0, 0.02, 0] } }), pq: { type: 'merge', in: ['plate', 'bolt'] }, kit: { type: 'uv_unwrap', in: ['pq'] } };
  await has(w({ focus: '@name=handle' }, kit, 'kit'), 'bake_edge_wear: focus "@name=handle" matches no prims (parts: plate, bolt)');
  await has(w({ focus: '@name=handle' }), 'no prim attribute "name"');
  await has(w({ radius: 1 }), 'bake_edge_wear: radius 1 m is more than half the model\'s size');
  check((await w({ radius: 1, method: 'dihedral' })) === '', 'method dihedral takes any radius');
  check((await w({ radius: 0.8 })) === '', 'a radius just under half the size cooks');
  // the names: edge_wear_bake belongs to this node now
  for (const a of ['edge_wear', 'edge_wear_bake', 'bake_wear', 'bake_chips']) {
    const c = await cook({ ...UV, m: { type: a, in: ['ub'], params: { resolution: 32 } } as any }, 'm');
    check(img(c, 'm').layer('chip'), `"${a}" names bake_edge_wear`);
  }
}

section('the time limit of long-running nodes stops it, on this thread and on the pool');
{
  const nodes: Nodes = { s0: { type: 'sphere', params: { radius: 0.5, rows: 32, cols: 64 } }, su: { type: 'uv_unwrap', in: ['s0'] } };
  for (const [label, engine] of [['on this thread', serial], ['on 4 workers', pooled]] as const) {
    for (const method of ['surface', 'dihedral']) {
      const saved = engine.simTimeoutMs;
      engine.simTimeoutMs = 40;
      const t0 = performance.now();
      const r = await engine.cook({ nodes: { ...nodes, m: { type: 'bake_edge_wear', in: ['su'], params: { resolution: 2048, radius: 0.05, width: 0.05, method, focus: '@P.y>0.3', focus_radius: 0.3 } } }, output: 'm' });
      const ms = performance.now() - t0;
      engine.simTimeoutMs = saved;
      const msg = r.errors.map((e) => e.message).join('; ');
      check(!r.ok && msg.includes('bake_edge_wear: stopped after 40 ms, the time limit of long-running nodes'), `method ${method} ${label}: stopped (${msg || 'cooked'}; ${ms.toFixed(0)} ms)`);
    }
  }
}

section('nesting over every bake above');
check(nestChecked > 1e6 && nestBad === 0, `core inside bare inside chip on ${nestChecked} texels (${nestBad} out of order)`);

console.log(`\n${pass} passed, ${fail} failed`);


process.exit(fail ? 1 : 0);
