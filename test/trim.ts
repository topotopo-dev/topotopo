// Trim sheets: the sheet description, trim-band uvs on sweep, polywire, tube and extrude, trim_map (strips, courses),
// one convention everywhere (u = distance / period from the path's start, whole repeats on closed paths, v filling
// the band, never mirrored, upright on walls), the sheets carried through merge.
//   node test/trim.ts
import fs from 'node:fs';
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import type { Geometry } from '../src/core/geometry.ts';
import type { GraphSpec } from '../src/graph/types.ts';
import { primNewell, topologyReport } from '../src/core/topology.ts';
import { readTrimSheets } from '../src/core/trim.ts';
import { uvReport } from '../src/core/uvreport.ts';
import { imagesOf } from '../src/core/image.ts';

const engine = new Engine(createNodeHost());
await engine.init();
let fail = 0, pass = 0;
const check = (ok: unknown, msg: string) => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); };
const near = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol;
const cook = async (nodes: GraphSpec['nodes'], output = 'out'): Promise<Geometry> => {
  const r = await engine.cook({ nodes, output });
  if (!r.ok || !r.geo) throw new Error(`cook failed: ${r.errors.map((e) => `[${e.node}] ${e.message}`).join('; ')}`);
  return r.geo;
};
const cookError = async (nodes: GraphSpec['nodes'], output = 'out'): Promise<string> => {
  const r = await engine.cook({ nodes, output });
  return r.ok ? '' : r.errors.map((e) => e.message + ' ' + (e.hint ?? '')).join('; ');
};

const SHEET = {
  type: 'trim_sheet', params: {
    name: 'stone', resolution: [512, 512], texels_per_metre: 256,
    bands: [{ name: 'wall', height: 1 }, { name: 'coping', height: 0.25, kind: 'edge' }, { name: 'cap', height: 0.5, kind: 'cap', tile: false }, { name: 'plain', height: 0.25, tile: false }],
  },
};

const uvOf = (g: Geometry, v: number) => { const a = g.vertices.get('uv')!; const x = a.get(v) as number[]; return [x[0], x[1]]; };
const bandOf = (g: Geometry, p: number) => String(g.prims.get('trim_band')?.get(p) ?? '');
/** Twice the signed uv area of a prim (> 0: counter-clockwise, the same way round as its corners in 3D). */
function uvArea(g: Geometry, p: number) {
  let a = 0;
  const s = g.primStart[p], e = g.primStart[p + 1];
  for (let v = s; v < e; v++) { const [x0, y0] = uvOf(g, v), [x1, y1] = uvOf(g, v + 1 < e ? v + 1 : s); a += x0 * y1 - x1 * y0; }
  return a;
}
/** dP/du and dP/dv of a prim from its first three corners. */
function tangents(g: Geometry, p: number) {
  const s = g.primStart[p], P = (v: number) => { const i = g.vertexPoint[v] * 3; return [g.P[i], g.P[i + 1], g.P[i + 2]]; };
  // a corner pair with a non-degenerate uv triangle
  const e = g.primStart[p + 1];
  for (let k = s + 1; k + 1 < e; k++) {
    const [a, b, c] = [P(s), P(k), P(k + 1)], [ua, ub, uc] = [uvOf(g, s), uvOf(g, k), uvOf(g, k + 1)];
    const e1 = b.map((x, i) => x - a[i]), e2 = c.map((x, i) => x - a[i]);
    const du1 = ub[0] - ua[0], dv1 = ub[1] - ua[1], du2 = uc[0] - ua[0], dv2 = uc[1] - ua[1], det = du1 * dv2 - du2 * dv1;
    if (Math.abs(det) < 1e-12) continue;
    return { dPdu: e1.map((x, i) => (dv2 * x - dv1 * e2[i]) / det), dPdv: e1.map((x, i) => (du1 * e2[i] - du2 * x) / det) };
  }
  return null;
}
const mapped = (g: Geometry) => Array.from({ length: g.numPrims }, (_, p) => p).filter((p) => bandOf(g, p));
const unmirrored = (g: Geometry) => mapped(g).every((p) => uvArea(g, p) > 0);
/** walls (normal within 45° of level) whose band reads upright: v climbs with them */
function upright(g: Geometry, prims = mapped(g)) {
  let walls = 0, ok = 0;
  for (const p of prims) {
    const n = primNewell(g, p), l = Math.hypot(n[0], n[1], n[2]);
    if (!l || Math.abs(n[1] / l) > 0.5) continue;
    const t = tangents(g, p);
    walls++;
    if (t && t.dPdv[1] > 0) ok++;
  }
  return walls > 0 && ok === walls;
}
const bandV = (g: Geometry, name: string) => readTrimSheets(g).stone.bands.find((b) => b.name === name)!.v;
const vRange = (g: Geometry, prims: number[]) => {
  let lo = Infinity, hi = -Infinity;
  for (const p of prims) for (let v = g.primStart[p]; v < g.primStart[p + 1]; v++) { const y = uvOf(g, v)[1]; lo = Math.min(lo, y); hi = Math.max(hi, y); }
  return [lo, hi];
};
const uMax = (g: Geometry, prims: number[]) => Math.max(...prims.flatMap((p) => Array.from({ length: g.primStart[p + 1] - g.primStart[p] }, (_, k) => Math.abs(uvOf(g, g.primStart[p] + k)[0]))));

// ---------------------------------------------------------------- the description
{
  const g = await cook({ out: SHEET });
  const s = readTrimSheets(g).stone;
  check(g.numPrims === 0 && s, 'trim_sheet: no geometry, the sheet on detail trim_sheets');
  check(s.bands[0].rows[0] === 0 && s.bands[0].rows[1] === 256 && near(s.bands[0].v[0], 0.5) && near(s.bands[0].v[1], 1), 'bands stack from the top: wall 1 m = rows 0..256, v 0.5..1');
  check(s.bands[1].rows[0] === 256 && s.bands[1].rows[1] === 320 && near(s.bands[1].v[0], 0.375), 'the next band starts where the last ends: coping rows 256..320');
  check(near(s.bands[0].period, 2) && near(s.size[0], 2), 'the default period is the sheet width in metres (512 px / 256 px/m = 2 m)');
  const gap = readTrimSheets(await cook({ out: { type: 'trim_sheet', params: { ...SHEET.params, bands: SHEET.params.bands.slice(0, 2), gap: 4 } } })).stone;
  check(gap.bands[1].rows[0] === 260, 'gap leaves empty rows between bands');
  const tall = await cookError({ out: { type: 'trim_sheet', params: { ...SHEET.params, bands: [{ name: 'a', height: 3 }] } } });
  check(/768 .*512 px high/.test(tall), `bands taller than the sheet: an error with the rows they need (${tall.slice(0, 90)})`);
  const twice = await cookError({ out: { type: 'trim_sheet', params: { ...SHEET.params, bands: [{ name: 'a', height: 0.5 }], rects: [{ name: 'a', rect: [0, 300, 64, 64] }] } } });
  check(/named twice/.test(twice), 'band and rectangle names are unique');
  const r = readTrimSheets(await cook({ out: { type: 'trim_sheet', params: { ...SHEET.params, rects: [{ name: 'panel', rect: [0, 384, 256, 128] }] } } })).stone.rects[0];
  check(near(r.u[1], 0.5) && near(r.v[0], 0) && near(r.v[1], 0.25) && near(r.size[0], 1) && near(r.size[1], 0.5), 'a rectangle in pixels from the top-left: its uv range and real size');
}

// ---------------------------------------------------------------- sweep
const straight = { type: 'curve', params: { points: [[0, 0, 0], [1.5, 0, 0], [3, 0, 0]] } };
{
  const g = await cook({ sheet: SHEET, path: straight, out: { type: 'sweep', in: ['path', null, 'sheet'], params: { shape: 'rect', size: [0.4, 0.3], trim_band: 'wall' } } });
  const sides = mapped(g).filter((p) => bandOf(g, p) === 'wall'), caps = mapped(g).filter((p) => bandOf(g, p) === 'cap');
  check(sides.length === 8 && caps.length === 2, 'sweep: sides on the wall band, caps on the sheet\'s cap band');
  check(near(uMax(g, sides), 1.5), `u = distance / period: 3 m at a 2 m period ends at u 1.5 (${uMax(g, sides)})`);
  const [lo, hi] = vRange(g, sides), w = bandV(g, 'wall');
  check(near(lo, w[0]) && near(hi, w[1]), 'wrap: the profile fills the band once round');
  check(unmirrored(g), 'sweep: no face is mirrored (uv winds as the face does)');
  const [cl, ch] = vRange(g, caps), c = bandV(g, 'cap');
  check(cl >= c[0] - 1e-9 && ch <= c[1] + 1e-9, 'caps lie inside the cap band');
  const t = tangents(g, caps[1])!;
  check(near(Math.hypot(...t.dPdu), 2, 1e-9) && near(Math.hypot(...t.dPdv), (0.5 / (c[1] - c[0])), 1e-9), 'caps are at real size (one u is 2 m, one v the band\'s 0.5 m over its range)');
  const faces = await cook({ sheet: SHEET, path: straight, out: { type: 'sweep', in: ['path', null, 'sheet'], params: { shape: 'rect', size: [0.4, 0.3], trim_band: 'wall', trim_around: 'faces' } } });
  check(upright(faces) && unmirrored(faces), 'faces: both side walls read upright (v climbs), still unmirrored');
  const fs = mapped(faces).filter((p) => bandOf(faces, p) === 'wall');
  check(fs.every((p) => { const [a, b] = vRange(faces, [p]); return near(a, w[0]) && near(b, w[1]); }), 'faces: every profile segment fills the whole band');
  const list = await cook({ sheet: SHEET, path: straight, out: { type: 'sweep', in: ['path', null, 'sheet'], params: { shape: 'rect', size: [0.4, 0.3], trim_band: 'wall, coping', trim_around: 'faces', caps: false } } });
  check(mapped(list).map((p) => bandOf(list, p)).slice(0, 4).join() === 'wall,coping,wall,coping', 'a band list gives one band per profile segment, cycled');
  const off = await cook({ sheet: SHEET, path: straight, out: { type: 'sweep', in: ['path', null, 'sheet'], params: { shape: 'rect', trim_band: 'wall', trim_offset: 0.5, caps: false } } });
  check(near(uvOf(off, off.primStart[0])[0], 0.25), 'trim_offset shifts u by metres / period');
  // a closed path: whole repeats
  const ring = await cook({ sheet: SHEET, c: { type: 'circle', params: { radius: 1, segments: 32 } }, out: { type: 'sweep', in: ['c', null, 'sheet'], params: { shape: 'square', radius: 0.1, trim_band: 'wall' } } });
  const um = uMax(ring, mapped(ring));
  check(near(um, Math.round(um), 1e-9) && um >= 3, `closed path: the period stretches to a whole number of repeats (u ends at ${um})`);
  const plain = await cook({ sheet: SHEET, path: straight, out: { type: 'sweep', in: ['path', null, 'sheet'], params: { trim_band: 'plain', caps: false } } });
  check(near(uMax(plain, mapped(plain)), 1), 'a band that does not tile fits the path once (u 0..1)');
  const carried = await cook({ sheet: SHEET, path: straight, m: { type: 'merge', in: ['path', 'sheet'] }, out: { type: 'sweep', in: ['m'], params: { shape: 'rect', trim_band: 'coping' } } });
  check(mapped(carried).length === 10, 'without the sheet input the sheet the backbone carries is used');
  const missing = await cookError({ path: straight, out: { type: 'sweep', in: ['path'], params: { trim_band: 'wall' } } });
  check(/needs a trim sheet.*sheet input/.test(missing), 'no sheet: the error says to wire a trim_sheet into the sheet input');
  const unknown = await cookError({ sheet: SHEET, path: straight, out: { type: 'sweep', in: ['path', null, 'sheet'], params: { trim_band: 'roof' } } });
  check(/no band or rectangle "roof".*wall, coping, cap, plain/.test(unknown), 'an unknown band: the error lists the sheet\'s bands');
  const before = await cook({ path: straight, out: { type: 'sweep', in: ['path'], params: { shape: 'rect' } } });
  check(!before.prims.has('trim_band') && !before.detail.has('trim_sheets'), 'trim_band empty: the node\'s own uv, no trim attributes');
}

// ---------------------------------------------------------------- polywire, tube
{
  const g = await cook({ sheet: SHEET, c: { type: 'curve', params: { points: [[0, 0, 0], [1, 0.5, 0], [2, 0.5, 1]] } }, out: { type: 'polywire', in: ['c', 'sheet'], params: { radius: 0.05, divisions: 6, trim_band: 'coping' } } });
  check(mapped(g).length === 2 * 6 + 2 && unmirrored(g), 'polywire: sides and caps mapped, unmirrored');
  const t = await cook({ sheet: SHEET, out: { type: 'tube', in: ['sheet'], params: { radius: 0.1, height: 1.5, cols: 4, rows: 3, trim_band: 'wall', trim_around: 'faces' } } });
  const sides = mapped(t).filter((p) => bandOf(t, p) === 'wall');
  check(sides.length === 12 && near(uMax(t, sides), 0.75), 'tube: u runs up the axis, 1.5 m at a 2 m period');
  const w = bandV(t, 'wall');
  check(sides.every((p) => { const [a, b] = vRange(t, [p]); return near(a, w[0]) && near(b, w[1]); }), 'tube faces: every side fills the band');
  check(unmirrored(t), 'tube: unmirrored, caps too');
  const x = await cook({ sheet: SHEET, out: { type: 'tube', in: ['sheet'], params: { radius: 0.1, axis: 'x', trim_band: 'wall' } } });
  check(unmirrored(x), 'tube along x: unmirrored');
}

// ---------------------------------------------------------------- extrude
{
  const shape = { type: 'shape2d', params: { shape: 'rect', size: [3, 1] } };
  const g = await cook({ sheet: SHEET, s: shape, out: { type: 'extrude', in: ['s', 'sheet'], params: { height: 2, divisions: 2, trim_band: 'wall', trim_around: 'faces' } } });
  const walls = mapped(g).filter((p) => bandOf(g, p) === 'wall'), w = bandV(g, 'wall');
  check(walls.length === 8 && walls.every((p) => { const [a, b] = vRange(g, [p]); return near(a, w[0]) && near(b, w[1]); }), 'extrude faces: every division is a course filling the band');
  check(upright(g) && unmirrored(g), 'extrude: walls upright, nothing mirrored, caps on the cap band');
  check(near(uMax(g, walls), 4), `extrude: u once round the 8 m outline, whole repeats (${uMax(g, walls)})`);
  const neg = await cook({ sheet: SHEET, s: shape, out: { type: 'extrude', in: ['s', 'sheet'], params: { height: -2, trim_band: 'wall' } } });
  check(upright(neg) && unmirrored(neg), 'extrude with a negative height: upright and unmirrored');
  const holes = await cook({ sheet: SHEET, a: shape, b: { type: 'circle', params: { radius: 0.3 } }, m: { type: 'merge', in: ['a', 'b'] }, out: { type: 'extrude', in: ['m', 'sheet'], params: { height: 1, trim_band: 'wall' } } });
  check(upright(holes) && unmirrored(holes), 'extrude with a hole: the hole\'s walls too');
}

// ---------------------------------------------------------------- trim_map
{
  const plan = { type: 'shape2d', params: { shape: 'rect', size: [3, 0.4] } }, box = { type: 'extrude', in: ['plan'], params: { height: 1.6 } };
  const g = await cook({ sheet: SHEET, plan, b: box, out: { type: 'trim_map', in: ['b', 'sheet'], params: { band: 'wall', fit: 'courses', group: 'side' } } });
  const walls = mapped(g), w = bandV(g, 'wall');
  check(walls.length > 0 && walls.every((p) => { const [a, b] = vRange(g, [p]); return a >= w[0] - 1e-9 && b <= w[1] + 1e-9; }), 'courses: every row lies inside the band');
  check(walls.length === 4 * 2, `courses: 1.6 m walls cut into two rows of 1 m (${walls.length} faces)`);
  const topo = topologyReport(g);
  check(topo.boundaryEdges === 0 && topo.nonManifoldEdges === 0, `courses: the cut leaves no open edges (no T-junctions on the top and bottom faces; ${topo.boundaryEdges})`);
  check(upright(g) && unmirrored(g), 'trim_map: walls upright, unmirrored');
  // u runs on round the corners: at a shared corner both faces have the same u (except where the strip closes)
  const s = await cook({ sheet: SHEET, plan, b: box, out: { type: 'trim_map', in: ['b', 'sheet'], params: { band: 'wall', group: 'side' } } });
  const uAt = new Map<string, number[]>();
  for (const p of mapped(s)) for (let v = s.primStart[p]; v < s.primStart[p + 1]; v++) {
    const i = s.vertexPoint[v] * 3, k = `${s.P[i].toFixed(4)},${s.P[i + 1].toFixed(4)},${s.P[i + 2].toFixed(4)}`;
    (uAt.get(k) ?? uAt.set(k, []).get(k)!).push(uvOf(s, v)[0]);
  }
  const corners = [...uAt.values()].filter((l) => l.length === 2), cont = corners.filter((l) => near(l[0], l[1], 1e-9));
  check(corners.length === 8 && cont.length === 6, `stretch: u runs on round three corners, the fourth is the seam (${cont.length}/${corners.length})`);
  check(near(uMax(s, mapped(s)), 6.8 / 2), 'stretch: u = 6.8 m round the wall / 2 m period');
  const st = await cook({ sheet: SHEET, plan, b: box, out: { type: 'trim_map', in: ['b', 'sheet'], params: { band: 'wall', fit: 'courses', stagger: 0.5, group: 'side' } } });
  const corners0 = (p: number) => Array.from({ length: st.primStart[p + 1] - st.primStart[p] }, (_, k) => st.primStart[p] + k);
  const minY = (p: number) => Math.min(...corners0(p).map((v) => st.P[st.vertexPoint[v] * 3 + 1]));
  const front = mapped(st).filter((p) => primNewell(st, p)[2] > 0);
  const lower = front.find((p) => minY(p) < 0.5)!, upper = front.find((p) => minY(p) > 0.5)!;
  const minU = (p: number) => Math.min(...corners0(p).map((v) => uvOf(st, v)[0]));
  check(near(minU(upper) - minU(lower), 0.25, 1e-9), `stagger: the next row starts 0.5 m (0.25 u) further along (${(minU(upper) - minU(lower)).toFixed(4)})`);
  const floor = await cook({ sheet: SHEET, g0: { type: 'grid', params: { size: [4, 1], divisions: [4, 1] } }, out: { type: 'trim_map', in: ['g0', 'sheet'], params: { band: 'coping' } } });
  const fp = mapped(floor);
  check(fp.length === 4 && unmirrored(floor) && near(uMax(floor, fp), 2), 'floors: u along the longest edge (4 m = 2 periods), unmirrored');
  const none = await cookError({ sheet: SHEET, plan, b: box, out: { type: 'trim_map', in: ['b', 'sheet'] } });
  check(/needs a band/.test(none), 'trim_map without a band: an error that says what to give');
}

// ---------------------------------------------------------------- merge carries the sheets
{
  const other = { type: 'trim_sheet', params: { name: 'metal', resolution: [256, 256], texels_per_metre: 256, bands: [{ name: 'strip', height: 0.5 }] } };
  const g = await cook({ a: SHEET, b: other, path: straight, r1: { type: 'sweep', in: ['path', null, 'a'], params: { trim_band: 'wall' } }, r2: { type: 'sweep', in: ['path', null, 'b'], params: { trim_band: 'strip' } }, out: { type: 'merge', in: ['r1', 'r2'] } });
  const t = readTrimSheets(g);
  check(t.stone && t.metal, 'merge: the sheets of both inputs are carried');
}

// ---------------------------------------------------------------- layout, hotspot, the report
{
  const flat = await cook({ sheet: SHEET, out: { type: 'trim_layout', in: ['sheet'] } });
  const wall = mapped(flat).filter((p) => bandOf(flat, p) === 'wall');
  check(wall.length === 1 && near(uMax(flat, wall), 1), 'layout: one strip per band, u 0..1 across its period');
  let z = 0; for (let i = 2; i < flat.P.length; i += 3) z = Math.max(z, flat.P[i]);
  check(z === 0 && flat.primGroups.has('wall') && flat.primGroups.has('coping'), 'layout: flat on z = 0, a group per band');
  const relief = await cook({ sheet: { type: 'trim_sheet', params: { ...SHEET.params, bands: [{ name: 'wall', height: 1, bevel: 0.02 }, { name: 'lip', height: 0.1, kind: 'edge' }] } }, out: { type: 'trim_layout', in: ['sheet'], params: { relief: true } } });
  let zr = 0; for (let i = 2; i < relief.P.length; i += 3) zr = Math.max(zr, relief.P[i]);
  check(zr > 0.05 && mapped(relief).some((p) => bandOf(relief, p) === 'lip'), `relief: the edge band rounds up off the sheet (${zr.toFixed(3)} m)`);
  const fit = await cook({
    sheet: { type: 'trim_sheet', params: { name: 'panels', resolution: [512, 512], texels_per_metre: 256, bands: [{ name: 'edge', height: 0.1 }], rects: [{ name: 'wide', rect: [0, 128, 256, 128] }, { name: 'tall', rect: [256, 128, 128, 256], rotate: false }] } },
    wall: { type: 'box', params: { size: [1, 0.5, 0.02], center: [0, 0.25, 0] } },
    door: { type: 'box', params: { size: [0.5, 1, 0.02], center: [2, 0.5, 0] } },
    parts: { type: 'merge', in: ['wall', 'door'] },
    out: { type: 'hotspot', in: ['parts', 'sheet'], params: { max_stretch: 1.25 } },
  });
  const wide = mapped(fit).filter((p) => bandOf(fit, p) === 'wide').length, tall = mapped(fit).filter((p) => bandOf(fit, p) === 'tall').length;
  check(wide >= 1 && tall >= 1, `hotspot: the wide face takes wide, the tall face takes tall (${wide} / ${tall})`);
  check(unmirrored(fit), 'hotspot: nothing is mirrored');
  const tiny = await cook({
    sheet: SHEET, g0: { type: 'grid', params: { size: [0.05, 0.05], divisions: [1, 1] } },
    out: { type: 'hotspot', in: ['g0', 'sheet'], params: { max_stretch: 1.2 } },
  });
  check(tiny.primGroups.get('hotspot_unmatched')?.[0] === 1, 'an island past max_stretch stays in hotspot_unmatched');
  const rep = uvReport(flat);
  check(!!rep.trim && rep.trim.bands.some((b) => b.band === 'wall' && b.prims === 1) && rep.trim.outside.triangles === 0 && rep.trim.straddle.triangles === 0, 'the uv report lists each band and no face outside or straddling');
  check(rep.resolution?.[0] === 512, 'with one sheet and no resolution given, texel density uses the sheet');
}

// ---------------------------------------------------------------- bake_mask is a union; tiling bakes see past the ends
{
  const mask = await cook({
    a: { type: 'grid', params: { size: [1, 1], divisions: [1, 1] } },
    ag: { type: 'group', in: ['a'], params: { name: 'keep', expr: '@P.y>-1' } },
    b: { type: 'grid', params: { size: [1, 1], divisions: [1, 1], center: [0.3, 0, 0.3] } },
    m: { type: 'merge', in: ['ag', 'b'] },
    out: { type: 'bake_mask', in: ['m'], params: { resolution: 32, padding: 0, mask_group: 'keep' } },
  });
  const C = imagesOf(mask)[0].layer('C')!;
  const on = [...C].filter((x) => x > 0.5).length;
  check(on > 32 * 32 * 0.8, `bake_mask: a group prim hidden under another still masks the texel (${on} of ${C.length})`);
  const bake = (tile: boolean) => cook({
    sheet: { type: 'trim_sheet', params: { name: 'tube', resolution: [64, 64], texels_per_metre: 64, bands: [{ name: 'wall', height: 0.5, period: 1 }] } },
    path: { type: 'line', params: { direction: [1, 0, 0], length: 1, points: 2 } },
    profile: { type: 'curve', params: { points: [[0.15, 0.15, 0], [0.15, -0.15, 0], [-0.15, -0.15, 0], [-0.15, 0.15, 0]], closed: true } },
    tube: { type: 'sweep', in: ['path', 'profile', 'sheet'], params: { trim_band: 'wall', caps: false } },
    out: { type: 'bake_ao', in: ['tube'], params: { resolution: 32, samples: 32, padding: 0, tile, name: 'ao' } },
  }, 'out');
  const open = imagesOf(await bake(false))[0].layer('C')!, shut = imagesOf(await bake(true))[0].layer('C')!;
  const cols = (img: Float32Array, i0: number, i1: number) => { let s = 0, n = 0; for (let j = 0; j < 32; j++) for (let i = i0; i <= i1; i++) { s += img[j * 32 + i]; n++; } return s / n; };
  const openEnds = (cols(open, 0, 1) + cols(open, 30, 31)) / 2, shutEnds = (cols(shut, 0, 1) + cols(shut, 30, 31)) / 2;
  check(shutEnds < openEnds - 0.02, `tiling: the open ends of a tube darken once the next period is there (${openEnds.toFixed(3)} → ${shutEnds.toFixed(3)})`);
}

// ---------------------------------------------------------------- the example meshes have no coplanar overlapping faces
// Two faces in one plane that overlap flicker (z-fight) in an engine, however the faces face. The trim examples are built
// of boxes and tubes that overlap in volume, so a face of one must never lie in a face of another.
{
  const overlapPairs = (g: Geometry) => {
    const faces = Array.from({ length: g.numPrims }, (_, p) => {
      const pts = g.primPoints(p).map((i) => [g.P[i * 3], g.P[i * 3 + 1], g.P[i * 3 + 2]]);
      const n = [0, 0, 0];
      pts.forEach((a, i) => { const b = pts[(i + 1) % pts.length]; n[0] += (a[1] - b[1]) * (a[2] + b[2]); n[1] += (a[2] - b[2]) * (a[0] + b[0]); n[2] += (a[0] - b[0]) * (a[1] + b[1]); });
      const l = Math.hypot(n[0], n[1], n[2]) || 1;
      const u = n.map((x) => x / l);
      return { pts, n: u, d: u[0] * pts[0][0] + u[1] * pts[0][1] + u[2] * pts[0][2] };
    });
    const area = (q: number[][]) => q.reduce((a, p, i) => { const r = q[(i + 1) % q.length]; return a + (p[0] * r[1] - r[0] * p[1]) / 2; }, 0);
    const clip = (subject: number[][], by: number[][]) => {
      let out = subject;
      for (let i = 0; i < by.length && out.length; i++) {
        const a = by[i], b = by[(i + 1) % by.length];
        const side = (p: number[]) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
        const cut = (p: number[], q: number[]) => { const sp = side(p), sq = side(q), t = sp / (sp - sq); return [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]; };
        const from = out; out = [];
        from.forEach((cur, j) => {
          const prev = from[(j + from.length - 1) % from.length];
          if (side(cur) >= 0) { if (side(prev) < 0) out.push(cut(prev, cur)); out.push(cur); } else if (side(prev) >= 0) out.push(cut(prev, cur));
        });
      }
      return out;
    };
    let pairs = 0;
    for (let i = 0; i < faces.length; i++) for (let j = i + 1; j < faces.length; j++) {
      const a = faces[i], b = faces[j], dot = a.n[0] * b.n[0] + a.n[1] * b.n[1] + a.n[2] * b.n[2];
      if (Math.abs(Math.abs(dot) - 1) > 1e-6 || Math.abs(a.d - (dot > 0 ? b.d : -b.d)) > 1e-5) continue;
      const ax = Math.abs(a.n[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0];
      const u = [a.n[1] * ax[2] - a.n[2] * ax[1], a.n[2] * ax[0] - a.n[0] * ax[2], a.n[0] * ax[1] - a.n[1] * ax[0]];
      const ul = Math.hypot(u[0], u[1], u[2]);
      const uu = u.map((x) => x / ul), vv = [a.n[1] * uu[2] - a.n[2] * uu[1], a.n[2] * uu[0] - a.n[0] * uu[2], a.n[0] * uu[1] - a.n[1] * uu[0]];
      const flat = (pts: number[][]) => { const q = pts.map((p) => [p[0] * uu[0] + p[1] * uu[1] + p[2] * uu[2], p[0] * vv[0] + p[1] * vv[1] + p[2] * vv[2]]); return area(q) < 0 ? q.reverse() : q; };
      const o = clip(flat(a.pts), flat(b.pts));
      if (o.length > 2 && Math.abs(area(o)) > 1e-7) pairs++;
    }
    return pairs;
  };
  for (const name of ['stair_flight', 'corridor_panels']) {
    const graph = JSON.parse(fs.readFileSync(new URL(`../examples/${name}.json`, import.meta.url), 'utf8'));
    const ranges: Record<string, any>[] = [{}];
    for (const [k, d] of Object.entries<any>(graph.params ?? {})) if (typeof d.min === 'number' && typeof d.max === 'number') ranges.push({ [k]: d.min }, { [k]: d.max });
    let worstPairs = 0, cooked = 0;
    for (const vars of ranges) {
      const r = await engine.cook(graph, { vars });
      if (!r.ok || !r.geo) continue;
      cooked++;
      worstPairs = Math.max(worstPairs, overlapPairs(r.geo));
    }
    check(cooked === ranges.length && worstPairs === 0, `${name}: no two faces lie in one plane and overlap, at the defaults and at each param's ends (${cooked} cooks, ${worstPairs} pairs)`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
