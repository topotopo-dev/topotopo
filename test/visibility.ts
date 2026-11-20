// Texel weight by visibility: uv_layout and uv_unwrap `visibility_weight` with a surroundings input, the per face
// ray measure behind it (core faceVisibility) and the occlusion node's `class: prim`.
//   node test/visibility.ts
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { Geometry } from '../src/core/geometry.ts';
import { RayScene, faceSamples, faceVisibility } from '../src/core/analysis.ts';
import { triangulate } from '../src/core/topology.ts';
import { readUV } from '../src/core/uv.ts';
import { uvReport } from '../src/core/uvreport.ts';
import type { GraphSpec } from '../src/graph/types.ts';

let fail = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) fail++; };

const serial = new Engine(createNodeHost({ workers: 0 }));
const pooled = new Engine(createNodeHost({ workers: 3, pool: { minElements: 1 } })); // every kernel goes to the threads
await serial.init();
await pooled.init();

const cook = async (nodes: GraphSpec['nodes'], output = 'out', engine = serial) => {
  const r = await engine.cook({ nodes, output });
  if (!r.ok || !r.geo) throw new Error(`cook failed: ${r.errors.map((e) => `[${e.node}] ${e.message}`).join('; ')}`);
  return { geo: r.geo, warnings: r.warnings.map((w) => w.message) };
};

const RES = 1024;
/** texels per metre of every prim at RES, and the prim areas */
function density(g: Geometry): { tpm: Float64Array; area: Float64Array } {
  const uv = readUV(g)!, tpm = new Float64Array(g.numPrims), area = new Float64Array(g.numPrims), uva = new Float64Array(g.numPrims);
  const { tris, triPrim } = triangulate(g), P = g.P, vp = g.vertexPoint;
  for (let t = 0; t < triPrim.length; t++) {
    const [a, b, c] = [tris[t * 3], tris[t * 3 + 1], tris[t * 3 + 2]], A = vp[a] * 3, B = vp[b] * 3, C = vp[c] * 3;
    const ux = P[B] - P[A], uy = P[B + 1] - P[A + 1], uz = P[B + 2] - P[A + 2], wx = P[C] - P[A], wy = P[C + 1] - P[A + 1], wz = P[C + 2] - P[A + 2];
    area[triPrim[t]] += Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) / 2;
    uva[triPrim[t]] += Math.abs((uv[b * 2] - uv[a * 2]) * (uv[c * 2 + 1] - uv[a * 2 + 1]) - (uv[c * 2] - uv[a * 2]) * (uv[b * 2 + 1] - uv[a * 2 + 1])) / 2;
  }
  for (let p = 0; p < g.numPrims; p++) tpm[p] = Math.sqrt((uva[p] * RES * RES) / Math.max(1e-30, area[p]));
  return { tpm, area };
}
const vis = (g: Geometry) => g.prims.get('visibility')!.data as Float64Array;
const sameArray = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a as ArrayLike<number>).every((x, i) => Object.is(x, b[i]));

// ---- a box against a wall (surroundings)
// box x -0.5..0.5, y 0..1, z 0..1 (prims: 0 front -z? found below by normal); the wall plane a millimetre behind it (z = -0.001)
const wallBox: GraphSpec['nodes'] = {
  box: { type: 'box', params: { size: [1, 1, 1], center: [0, 0.5, 0.5] } },
  wall: { type: 'grid', params: { size: [8, 8], divisions: [1, 1], plane: 'xy', center: [0, 0.5, -0.001] } },
};
const layout = (w: number, extra: Record<string, unknown> = {}, wired = true): GraphSpec['nodes'] => ({
  ...wallBox, out: { type: 'uv_layout', in: wired ? ['box', 'wall'] : ['box'], params: { resolution: RES, visibility_weight: w, ...extra } },
});
{
  const off = await cook(layout(0)), on = await cook(layout(1));
  const g = on.geo, v = vis(g), d = density(g), d0 = density(off.geo);
  // which prim is which: by the normal's z (the box node's prim order is not part of this test)
  const nz = (p: number) => { const s = g.primStart[p]; const A = g.vertexPoint[s] * 3, B = g.vertexPoint[s + 1] * 3, C = g.vertexPoint[s + 2] * 3; const ux = g.P[B] - g.P[A], uy = g.P[B + 1] - g.P[A + 1], wx = g.P[C] - g.P[A], wy = g.P[C + 1] - g.P[A + 1]; return ux * wy - uy * wx; };
  const back = Array.from({ length: g.numPrims }, (_, p) => p).find((p) => nz(p) < -0.5)!;
  const others = Array.from({ length: g.numPrims }, (_, p) => p).filter((p) => p !== back);
  check(v[back] < 0.01, `box on a wall: the face against the wall sees ${v[back].toFixed(4)} of its hemisphere`);
  check(others.every((p) => v[p] > 0.95), `box on a wall: the other faces read open, ${others.map((p) => v[p].toFixed(2)).join(', ')} (the wall covers half the hemisphere of the sides, which makes them no less visible)`);
  const rel = d.tpm[back] / d.tpm[others.find((p) => v[p] > 0.95)!];
  check(Math.abs(rel - 0.05) < 0.003, `box on a wall: the face against the wall gets the minimum weight, ${rel.toFixed(4)} of the density of the open front`);
  check(others.every((p) => d.tpm[p] >= d0.tpm[p] * 0.999), `box on a wall: the other faces keep their texel density or gain (${others.map((p) => (d.tpm[p] / d0.tpm[p]).toFixed(2)).join(', ')} times; six equal squares or five fill the tile alike)`);
  const rep = uvReport(g, { resolution: RES });
  check(rep.overlap.pairs === 0 && !on.warnings.length, `box on a wall: no uv overlaps after re-packing (${rep.overlap.pairs}), warnings: ${on.warnings.join('; ') || 'none'}`);
  check(!off.geo.prims.has('visibility'), 'visibility_weight 0 writes no visibility attribute');
  // half of the weight: halfway between
  const half = await cook(layout(0.5)), dh = density(half.geo);
  const relH = dh.tpm[back] / dh.tpm[others.find((p) => v[p] > 0.95)!];
  check(Math.abs(relH - 0.525) < 0.01, `weight 0.5: the face against the wall gets lerp(1, 0.05, 0.5) = 0.525 of the open density (${relH.toFixed(4)})`);
}

// ---- a slab on the wall (half its area is its hidden back): the faces that show gain
{
  const slab: GraphSpec['nodes'] = {
    ...wallBox,
    box: { type: 'box', params: { size: [1, 1, 0.05], center: [0, 0.5, 0.025] } },
    top: { type: 'box', params: { size: [0.3, 0.3, 0.2], center: [0.2, 0.65, 0.15] } },
    both: { type: 'merge', in: ['box', 'top'] },
  };
  const on = (await cook({ ...slab, out: { type: 'uv_layout', in: ['both', 'wall'], params: { resolution: RES, visibility_weight: 1 } } })).geo;
  const off = (await cook({ ...slab, out: { type: 'uv_layout', in: ['both', 'wall'], params: { resolution: RES } } })).geo;
  const v = vis(on), d = density(on), d0 = density(off);
  const open = Array.from({ length: on.numPrims }, (_, p) => p).filter((p) => v[p] > 0.9), shut = Array.from({ length: on.numPrims }, (_, p) => p).filter((p) => v[p] < 0.02);
  const mean = (g: { tpm: Float64Array; area: Float64Array }, ps: number[]) => ps.reduce((s, p) => s + g.tpm[p] * g.area[p], 0) / ps.reduce((s, p) => s + g.area[p], 0);
  check(shut.length >= 1 && open.length >= 8, `slab on a wall: ${shut.length} hidden face(s), ${open.length} open`);
  const gain = mean(d, open) / mean(d0, open);
  check(gain > 1.3, `slab on a wall: the faces that show gain texel density ${gain.toFixed(2)} times (${mean(d0, open).toFixed(0)} → ${mean(d, open).toFixed(0)} per metre), the hidden back ${(mean(d, shut) / mean(d, open)).toFixed(3)} of that`);
}

// ---- weight 0 is today's layout, bit for bit, wired or not, set or left alone
{
  const plain = (await cook({ ...wallBox, out: { type: 'uv_layout', in: ['box'], params: { resolution: RES } } })).geo;
  const zero = (await cook(layout(0))).geo, unwired = (await cook(layout(0, {}, false))).geo;
  check(sameArray(readUV(plain)!, readUV(zero)!) && sameArray(readUV(plain)!, readUV(unwired)!), 'visibility_weight 0 (with or without surroundings) gives the layout of the node without the param, bit for bit');
  check(sameArray(plain.prims.get('island')!.data as Int32Array, zero.prims.get('island')!.data as Int32Array) && plain.prims.names().join() === zero.prims.names().join(), 'weight 0: the same prim attributes');
}

// ---- a large quad half covered by another part: between the two, from the whole face and not its corners
const covered: GraphSpec['nodes'] = {
  quad: { type: 'grid', params: { size: [2, 2], divisions: [1, 1], plane: 'xz' } }, // one quad, facing +Y
  plate: { type: 'box', params: { size: [1, 0.05, 2.4], center: [-0.4, 0.055, 0] } }, // covers x -0.9..0.1: half of the quad, none of its corners (x = -1 and 1)
  both: { type: 'merge', in: ['quad', 'plate'] },
};
{
  const L = await cook({ ...covered, out: { type: 'uv_layout', in: ['both'], params: { resolution: RES, visibility_weight: 1 } } });
  const g = L.geo, v = vis(g);
  const quad = Array.from({ length: g.numPrims }, (_, p) => p).find((p) => g.primSize(p) === 4 && g.P[g.vertexPoint[g.primStart[p]] * 3 + 1] === 0)!;
  const top = Array.from({ length: g.numPrims }, (_, p) => p).find((p) => p !== quad && g.P[g.vertexPoint[g.primStart[p]] * 3 + 1] > 0.07 && v[p] > 0.9)!;
  const d = density(g);
  check(v[quad] > 0.3 && v[quad] < 0.85, `a quad half covered by a plate reads ${v[quad].toFixed(3)} open: neither open nor enclosed`);
  const rel = d.tpm[quad] / d.tpm[top];
  check(rel > 0.2 && rel < 0.9, `a quad half covered: its density is ${rel.toFixed(3)} of the open top of the plate, between the minimum (0.05) and 1`);
  // the point based measure reads the four corners, which are all uncovered
  const pts = await cook({ ...covered, out: { type: 'occlusion', in: ['both'], params: { samples: 32, group: '@P.y<0.01' } } });
  const ao = pts.geo.points.get('ao')!.data as Float64Array;
  const corners = Array.from({ length: pts.geo.numPoints }, (_, i) => i).filter((i) => pts.geo.P[i * 3 + 1] === 0);
  check(corners.length === 4 && corners.every((i) => ao[i] < 0.25), `the same quad measured at its 4 corners reads open (ao ${corners.map((i) => ao[i].toFixed(2)).join(', ')}): the misreading of the point measure`);
  // class prim reads it right
  const pr = await cook({ ...covered, out: { type: 'occlusion', in: ['both'], params: { class: 'prim', samples: 32 } } });
  const pao = pr.geo.prims.get('ao')!.data as Float64Array;
  check(pao[quad] > 0.3 && pao[quad] < 0.7 && !pr.geo.points.has('ao'),
    `occlusion class prim: the quad reads ao ${pao[quad].toFixed(3)}, a prim attribute, no point attribute`);
}

// ---- a closed box inside another closed box: the minimum everywhere
{
  const nested: GraphSpec['nodes'] = {
    inner: { type: 'box', params: { size: [1, 1, 1], center: [0, 2, 0] } },
    outer: { type: 'box', params: { size: [4, 4, 4], center: [0, 2, 0] } },
    both: { type: 'merge', in: ['outer', 'inner'] },
  };
  const a = await cook({ ...nested, out: { type: 'uv_layout', in: ['inner', 'outer'], params: { resolution: RES, visibility_weight: 1 } } });
  check(Array.from(vis(a.geo)).every((x) => x < 0.001), `a closed box inside another (outer box as surroundings): every face sees ${Math.max(...vis(a.geo)).toFixed(5)} at most`);
  const b = await cook({ ...nested, out: { type: 'uv_layout', in: ['both'], params: { resolution: RES, visibility_weight: 1 } } });
  const g = b.geo, v = vis(g), d = density(g);
  // the first 6 prims are the outer box (merge order), the last 6 the inner
  const outerP = [0, 1, 2, 3, 4, 5], innerP = [6, 7, 8, 9, 10, 11];
  check(outerP.every((p) => v[p] > 0.99) && innerP.every((p) => v[p] < 0.001), 'both boxes in one mesh: the outer faces are open, every inner face is enclosed');
  const rel = d.tpm[innerP[0]] / d.tpm[outerP[0]];
  check(innerP.every((p) => Math.abs(d.tpm[p] / d.tpm[outerP[0]] - 0.05) < 0.003) && uvReport(g, { resolution: RES }).overlap.pairs === 0,
    `both boxes in one mesh: every inner face has the minimum weight (${rel.toFixed(4)} of the outer density), no overlaps`);
}

// ---- the same bits with and without worker threads
{
  const nodesL = layout(1, { padding: 6 });
  const a = (await cook(nodesL, 'out', serial)).geo, b = (await cook(nodesL, 'out', pooled)).geo;
  check(sameArray(readUV(a)!, readUV(b)!) && sameArray(vis(a), vis(b)), 'uv_layout with visibility_weight: identical bits with the worker pool and with TOPOTOPO_WORKERS=0 (every kernel forced onto the threads)');
  const prim: GraphSpec['nodes'] = { ...covered, out: { type: 'occlusion', in: ['both'], params: { class: 'prim', samples: 24, seed: 5 } } };
  const c = (await cook(prim, 'out', serial)).geo, d = (await cook(prim, 'out', pooled)).geo;
  check(sameArray(c.prims.get('ao')!.data as Float64Array, d.prims.get('ao')!.data as Float64Array), 'occlusion class prim: identical bits with the worker pool and without');
  check(pooled.poolStats.parallel > 0, `the pooled engine did run on its threads (${pooled.poolStats.parallel} parallel jobs)`);
}

// ---- uv_unwrap: the same weight, the surroundings input, prim visibility through splits
{
  const body: GraphSpec['nodes'] = {
    ...wallBox,
    top: { type: 'box', params: { size: [0.4, 0.2, 0.4], center: [0, 1.1, 0.5] } },
    both: { type: 'merge', in: ['box', 'top'] },
  };
  const mk = (w: number | undefined, wired = true): GraphSpec['nodes'] => ({
    ...body, out: { type: 'uv_unwrap', in: wired ? ['both', 'wall'] : ['both'], params: { resolution: RES, padding: 4, ...(w === undefined ? {} : { visibility_weight: w }) } },
  });
  const base = await cook(mk(undefined)), zero = await cook(mk(0)), one = await cook(mk(1));
  check(sameArray(readUV(base.geo)!, readUV(zero.geo)!) && !zero.geo.prims.has('visibility'), 'uv_unwrap visibility_weight 0: the same uv as without the param, bit for bit, no visibility attribute');
  const g = one.geo, v = vis(g), d = density(g), d0 = density(zero.geo);
  const sum = (f: (p: number) => boolean, x: Float64Array) => { let s = 0, a = 0; for (let p = 0; p < g.numPrims; p++) if (f(p)) { s += x[p] * d.area[p]; a += d.area[p]; } return s / a; };
  const hidden = (p: number) => v[p] < 0.02, open = (p: number) => v[p] > 0.9, all = Array.from({ length: g.numPrims }, (_, p) => p);
  check(g.prims.has('visibility') && all.some(hidden) && all.some(open), `uv_unwrap: prim visibility written (${all.filter(hidden).length} hidden, ${all.filter(open).length} open polygons)`);
  const ratio = sum(hidden, d.tpm) / sum(open, d.tpm);
  check(ratio > 0.04 && ratio < 0.12, `uv_unwrap: hidden faces get ${ratio.toFixed(3)} of the density of open ones`);
  check(sum(open, d.tpm) > sum(open, d0.tpm) * 1.05, `uv_unwrap: open faces gain texels (${sum(open, d0.tpm).toFixed(0)} → ${sum(open, d.tpm).toFixed(0)} per metre)`);
  check(uvReport(g, { resolution: RES }).overlap.pairs === 0, 'uv_unwrap with visibility_weight: no uv overlaps');
  const a = (await cook(mk(1), 'out', serial)).geo, b = (await cook(mk(1), 'out', pooled)).geo;
  check(sameArray(readUV(a)!, readUV(b)!), 'uv_unwrap with visibility_weight: identical bits with and without worker threads');
}

// ---- the measure itself: faceSamples and faceVisibility
{
  const mesh = (await cook({ ...covered, out: { type: 'null', in: ['both'] } })).geo;
  const s = faceSamples(mesh, 4), again = faceSamples(mesh, 4);
  const count = new Int32Array(mesh.numPrims);
  for (const f of s.face) count[f]++;
  const quad = Array.from({ length: mesh.numPrims }, (_, p) => p).find((p) => mesh.primSize(p) === 4 && mesh.P[mesh.vertexPoint[mesh.primStart[p]] * 3 + 1] === 0)!;
  check(Array.from(count).every((c) => c >= 4) && count[quad] > 8 && sameArray(s.P, again.P), `faceSamples: at least 4 points per face, ${count[quad]} on the large quad (the faces of the plate: ${Math.min(...Array.from(count).filter((_, p) => p !== quad))}), the same on every call`);
  // every sample lies on its face's plane
  let off = 0;
  for (let i = 0; i < s.face.length; i++) {
    const p = s.face[i], c = mesh.vertexPoint[mesh.primStart[p]] * 3;
    off = Math.max(off, Math.abs((s.P[i * 3] - mesh.P[c]) * s.N[i * 3] + (s.P[i * 3 + 1] - mesh.P[c + 1]) * s.N[i * 3 + 1] + (s.P[i * 3 + 2] - mesh.P[c + 2]) * s.N[i * 3 + 2]));
  }
  check(off < 1e-9, `faceSamples: every point lies on its face (largest distance from the plane ${off.toExponential(1)})`);
  const v = faceVisibility(mesh, RayScene.of(mesh));
  check(v.length === mesh.numPrims && v[quad] > 0.3 && v[quad] < 0.85, `faceVisibility: ${v[quad].toFixed(3)} for the half covered quad`);
  const lines = new Geometry({ positions: [0, 0, 0, 1, 0, 0], prims: [[0, 1]], closed: false });
  check(faceVisibility(lines, RayScene.of(lines))[0] === 1, 'faceVisibility: a polyline reads 1');
}

// ---- occlusion class prim: group, invert, other modes
{
  const g = (await cook({ ...covered, out: { type: 'occlusion', in: ['both'], params: { class: 'prim', group: '0', samples: 16 } } })).geo;
  const ao = g.prims.get('ao')!.data as Float64Array;
  check(ao.length === g.numPrims && Array.from(ao).slice(1).every((x) => x === 0), 'occlusion class prim with a prim group: the prims outside keep 0');
  const inv = (await cook({ ...covered, out: { type: 'occlusion', in: ['both'], params: { class: 'prim', samples: 16, invert: true, name: 'open' } } })).geo;
  const plain = (await cook({ ...covered, out: { type: 'occlusion', in: ['both'], params: { class: 'prim', samples: 16 } } })).geo;
  const a = plain.prims.get('ao')!.data as Float64Array, b = inv.prims.get('open')!.data as Float64Array;
  check(Array.from(a).every((x, i) => Math.abs(x + b[i] - 1) < 1e-12), 'occlusion class prim: invert and name');
  const th = (await cook({ ...covered, out: { type: 'occlusion', in: ['both'], params: { class: 'prim', mode: 'thickness', samples: 16 } } })).geo;
  check(th.prims.has('thickness'), 'occlusion class prim: the other modes write their prim attribute too');
}

console.log(fail ? `\n${fail} visibility check(s) failed` : '\nvisibility: all checks passed');
process.exit(fail ? 1 : 0);
