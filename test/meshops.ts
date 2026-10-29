// Mesh operations: booleans give back closed polygon solids (no slivers, inside-out cutters turned outward), bevels
// after them stay small, an offset at half the thickness closes up, clean keeps solids closed, extrude and boolean2d
// with holes, straps from open paths, rounded curve corners, capsule shapes, multi-section loft, revolve about any
// axis, sweep caps with uv, copy_xform's default, remove_interior. Also the triangle merge and flip kernels.
//   node test/meshops.ts
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { Geometry } from '../src/core/geometry.ts';
import type { NodeSpec } from '../src/graph/types.ts';
import { primArea, signedVolume, topologyReport, triangleReport, triangulate } from '../src/core/topology.ts';
import { mergeTriangles } from '../src/core/polymerge.ts';
import { removeSmallFaces } from '../src/nodes/topology.ts';
import { selfIntersections } from '../src/core/analysis.ts';
import { topologyLines } from '../src/inspect.ts';

const engine = new Engine(createNodeHost());
await engine.init();

let fail = 0, pass = 0;
const check = (ok: unknown, msg: string) => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
};
async function cook(nodes: Record<string, NodeSpec>, output: string) {
  const r = await engine.cook({ nodes, output });
  if (!r.ok || !r.geo) throw new Error(`cook failed: ${r.errors.map((e) => `[${e.node}] ${e.message}`).join('; ')}`);
  return { geo: r.geo, warnings: (r.warnings ?? []).map((w: any) => (typeof w === 'string' ? w : w.message)).join(' | ') };
}
async function cookError(nodes: Record<string, NodeSpec>, output: string) {
  const r = await engine.cook({ nodes, output });
  return r.ok ? '' : r.errors.map((e) => e.message).join('; ');
}
const grp = (g: Geometry, cls: 'prim' | 'point', name: string) => { const m = (cls === 'prim' ? g.primGroups : g.pointGroups).get(name); return m ? m.reduce((s, x) => s + x, 0) : 0; };
const solid = (g: Geometry) => { const r = topologyReport(g); return r.closed && r.degenerate === 0 && r.nonManifoldEdges === 0; };
const triangles = (g: Geometry) => triangulate(g).tris.length / 3;
const area = (g: Geometry) => { let a = 0; for (let p = 0; p < g.numPrims; p++) a += primArea(g, p); return a; };

// ---------------------------------------------------------------- boolean: polygons, closed, few triangles

const SLIDE: Record<string, NodeSpec> = {
  slide: { type: 'box', params: { size: [0.2, 0.03, 0.025] } },
  c1: { type: 'tube', params: { radius: 0.004, height: 0.05, cols: 24, caps: true } },
  c1m: { type: 'transform', in: ['c1'], params: { translate: [0.05, 0, 0] } },
  slot: { type: 'box', params: { size: [0.06, 0.0101, 0.03], center: [-0.04, 0.01, 0] } },
  cut: { type: 'merge', in: ['c1m', 'slot'] },
  poly: { type: 'boolean', in: ['slide', 'cut'], params: { operation: 'subtract' } },
  tri: { type: 'boolean', in: ['slide', 'cut'], params: { operation: 'subtract', output: 'triangles' } },
  bevPoly: { type: 'poly_bevel', in: ['poly'], params: { offset: 0.0005 } },
  bevTri: { type: 'poly_bevel', in: ['tri'], params: { offset: 0.0005 } },
};
{
  const poly = (await cook(SLIDE, 'poly')).geo, tri = (await cook(SLIDE, 'tri')).geo;
  check(solid(poly) && solid(tri), 'boolean: polygons and triangles both closed solids');
  check(tri.numPrims === triangles(tri) && poly.numPrims < tri.numPrims / 2, `boolean: polygons ${poly.numPrims} prims vs ${tri.numPrims} triangles`);
  check(Math.abs(signedVolume(poly) - signedVolume(tri)) < 1e-12, 'boolean: polygon output has the same volume as the triangles');
  check(Math.abs(area(poly) - area(tri)) < 1e-9, 'boolean: polygon output has the same area');
  check(grp(poly, 'prim', 'from_a') > 0 && grp(poly, 'prim', 'from_b') > 0 && grp(poly, 'prim', 'from_a') + grp(poly, 'prim', 'from_b') === poly.numPrims, 'boolean: from_a/from_b cover every polygon');
  const tr = triangleReport(poly);
  check(tr.degenerate === 0 && tr.nearDegenerate === 0, `boolean: no slivers in the export triangles (min quality ${tr.minQuality.toExponential(2)})`);
  const bp = (await cook(SLIDE, 'bevPoly')).geo, bt = (await cook(SLIDE, 'bevTri')).geo;
  check(solid(bp), 'bevel after boolean: closed');
  check(triangles(bp) < triangles(bt), `bevel after boolean: ${triangles(bp)} triangles on polygons vs ${triangles(bt)} on triangles (the polygons have no split edges to bevel)`);
}
{
  // a face with a hole comes back as two polygons sharing two cut edges, not a fan of triangles
  const { geo } = await cook({
    plate: { type: 'box', params: { size: [1, 0.1, 1] } },
    pin: { type: 'tube', params: { radius: 0.1, height: 1, cols: 16, caps: true } },
    b: { type: 'boolean', in: ['plate', 'pin'], params: { operation: 'subtract' } },
  }, 'b');
  const top = Array.from({ length: geo.numPrims }, (_, p) => p).filter((p) => geo.primPoints(p).every((i) => Math.abs(geo.P[i * 3 + 1] - 0.05) < 1e-9));
  check(solid(geo) && top.length === 2, `boolean: the top face around a hole is ${top.length} polygons (2 expected)`);
  check(Math.abs(top.reduce((s, p) => s + primArea(geo, p), 0) - (1 - Math.PI * 0.01 * Math.sin(Math.PI / 8) * 8 / Math.PI)) < 1e-6, 'boolean: the two halves cover the face minus the hole');
}
{
  // a mirrored cutter (winding inward) is turned outward first, so subtract still cuts
  const nodes: Record<string, NodeSpec> = {
    box: { type: 'box' },
    cut: { type: 'box', params: { size: [0.3, 2, 0.3], center: [0.3, 0, 0] } },
    inside: { type: 'reverse', in: ['cut'] },
    b: { type: 'boolean', in: ['box', 'inside'], params: { operation: 'subtract' } },
  };
  const { geo, warnings } = await cook(nodes, 'b');
  check(Math.abs(signedVolume(geo) - (1 - 0.09)) < 1e-6 && solid(geo), `boolean: an inside-out cutter still subtracts (volume ${signedVolume(geo).toFixed(4)})`);
  check(/B: 1 piece\(s\) were inside out .* first prim \d+ at \(/.test(warnings), `boolean: warns about the inside-out piece and says where (${warnings})`);
}
{
  // hollow solid: the inner wall faces inward on purpose and is kept
  const { geo, warnings } = await cook({
    outer: { type: 'box', params: { size: [2, 2, 2] } },
    inner: { type: 'box', params: { size: [1, 1, 1] } },
    hole: { type: 'reverse', in: ['inner'] },
    shell: { type: 'merge', in: ['outer', 'hole'] },
    cut: { type: 'box', params: { size: [3, 0.5, 0.5], center: [0, 0.9, 0] } },
    b: { type: 'boolean', in: ['shell', 'cut'], params: { operation: 'subtract' } },
  }, 'b');
  check(!/inside out/.test(warnings) && Math.abs(signedVolume(geo) - (8 - 1 - 3 * 0.25 * 0.6 + 0)) < 0.2, `boolean: a cavity's inner wall is not flipped (volume ${signedVolume(geo).toFixed(3)})`);
}

// ---------------------------------------------------------------- poly_bevel: half the thickness, flat edges

{
  const plate: NodeSpec = { type: 'box', params: { size: [0.2, 0.004, 0.1] } };
  for (const offset of [0.002, 0.003]) {
    const { geo, warnings } = await cook({ plate, bev: { type: 'poly_bevel', in: ['plate'], params: { offset } } }, 'bev');
    const tr = triangleReport(geo);
    check(solid(geo) && tr.degenerate === 0 && tr.nearDegenerate === 0, `bevel offset ${offset} on a 4 mm plate: closed, no slivers (min quality ${tr.minQuality.toExponential(2)})`);
    check(/reaches half the width of 4 face\(s\).*first prim \d+ at \(/.test(warnings), `bevel offset ${offset}: warns that the side faces closed up`);
  }
  const { geo, warnings } = await cook({ plate, bev: { type: 'poly_bevel', in: ['plate'], params: { offset: 0.001 } } }, 'bev');
  check(solid(geo) && !/half the width/.test(warnings) && geo.numPrims === 26, 'bevel below half the thickness: a flat band stays, no warning');
  // a box split into a grid: the default selection bevels the 12 box edges, not the flat grid lines
  const grid = (await cook({ box: { type: 'box', params: { divisions: [3, 3, 3] } }, bev: { type: 'poly_bevel', in: ['box'], params: { offset: 0.05 } } }, 'bev')).geo;
  const plain = (await cook({ box: { type: 'box' }, bev: { type: 'poly_bevel', in: ['box'], params: { offset: 0.05 } } }, 'bev')).geo;
  // 12 box edges of 3 segments each (36 strips) and 8 corners; the flat grid lines inside the faces stay
  check(grp(grid, 'prim', 'bevel') === 44 && grp(plain, 'prim', 'bevel') === 20, `bevel default: flat edges skipped (${grp(grid, 'prim', 'bevel')} bevel prims on the grid box, ${grp(plain, 'prim', 'bevel')} on the plain box)`);
}

{
  // a frame whose top rim is a 1.5 mm band, bevelled 0.8 mm on both of its edges: the bevels meet, never cross
  const nodes: Record<string, NodeSpec> = {
    outer: { type: 'shape2d', params: { shape: 'rect', size: [0.04, 0.03], plane: 'xy' } },
    inner: { type: 'shape2d', params: { shape: 'rect', size: [0.03, 0.0255], plane: 'xy', center: [0, -0.00075, 0] } },
    both: { type: 'merge', in: ['outer', 'inner'] },
    frame: { type: 'extrude', in: ['both'], params: { height: 0.0135, center: true } },
    bev: { type: 'poly_bevel', in: ['frame'], params: { group: 'angle>35', offset: 0.0008, divisions: 3 } },
    self: { type: 'boolean', in: ['bev'] },
    wild: { type: 'poly_bevel', in: ['frame'], params: { group: 'angle>35', offset: 0.0009, divisions: 3, clamp: false } },
    selfWild: { type: 'boolean', in: ['wild'] },
  };
  const { geo, warnings } = await cook(nodes, 'bev');
  check(solid(geo) && selfIntersections(geo).pairs === 0, 'bevel: the two rims of a thin band are clamped to meet, no faces cross');
  check(/facing each other across a narrow face/.test(warnings), `bevel: says it reduced the facing pairs (${warnings})`);
  check(solid((await cook(nodes, 'self')).geo), 'bevel of a thin band: a boolean takes it');
  check(/its faces cross each other: \d+\+? pair\(s\), first prim \d+/.test(await cookError(nodes, 'selfWild')), 'boolean on a mesh crossing itself: says where the faces cross');
  check(/pair\(s\) of faces CROSS each other, first prim/.test(topologyLines((await cook(nodes, 'wild')).geo).join(' ')), 'inspect topology: a closed mesh that crosses itself says so');
}
{
  const { warnings } = await cook({ b: { type: 'box' }, c: { type: 'copy_xform', in: ['b'], params: { count: 3 } } }, 'c');
  const ring = await cook({ b: { type: 'box' }, c: { type: 'copy_xform', in: ['b'], params: { count: 6, rotate: [0, 60, 0] } } }, 'c');
  check(/the 3 copies stack in place/.test(warnings) && !ring.warnings, 'copy_xform: copies that stack in place warn; a rotate-only ring does not');
}

// ---------------------------------------------------------------- clean keeps a closed mesh closed

{
  // a box whose top face is A + B1 + B2 + a zero-area cap C (m on the diagonal p0–p2)
  const pos = [
    -1, -1, -1, 1, -1, -1, 1, -1, 1, -1, -1, 1, // bottom 0..3
    -1, 1, -1, 1, 1, -1, 1, 1, 1, -1, 1, 1, // top 4..7 (p0 = 4, p1 = 5, p2 = 6, p3 = 7)
    0, 1, 0, // m = 8, middle of 4–6
  ];
  const prims = [
    [0, 1, 2, 3], [0, 4, 5, 1], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 4, 0],
    [4, 6, 5], // A: p0 p2 p1 (outward +y)
    [6, 4, 8], // C: zero area
    [8, 7, 6], [4, 7, 8], // B1, B2
  ];
  const g = new Geometry({ positions: pos, prims });
  check(topologyReport(g).closed && topologyReport(g).degenerate === 1, 'clean fixture: closed box with one zero-area cap triangle');
  const out = removeSmallFaces(g, 1e-9);
  check(solid(out) && out.numPrims === g.numPrims - 1, `clean min_area: the cap gives its middle point to its neighbour; still closed (${out.numPrims} prims)`);
}
{
  // the same through a graph: a tiny compact triangle at a truncated corner collapses into a point
  const { geo } = await cook({
    box: { type: 'box' },
    corner: { type: 'clip', in: ['box'], params: { origin: [0.49995, 0.49995, 0.49995], normal: [1, 1, 1], keep: 'below', cap: true } },
    c: { type: 'clean', in: ['corner'], params: { min_area: 1e-6 } },
  }, 'c');
  check(solid(geo) && geo.numPrims === 6, `clean min_area: a tiny corner face collapses into a point and the box stays closed (${geo.numPrims} prims)`);
}

// ---------------------------------------------------------------- extrude / boolean2d with holes

{
  const nodes: Record<string, NodeSpec> = {
    plate: { type: 'shape2d', params: { shape: 'rounded_rect', size: [3, 1.5], corner_radius: 0.2 } },
    hole: { type: 'circle', params: { radius: 0.4, segments: 32 } },
    m: { type: 'merge', in: ['plate', 'hole'] },
    e: { type: 'extrude', in: ['m'], params: { height: 0.3, divisions: 2 } },
    tw: { type: 'extrude', in: ['m'], params: { height: 0.3, twist: 15, scale_top: [0.8, 0.8] } },
    f: { type: 'boolean2d', in: ['m'], params: { operation: 'union' } },
  };
  const e = (await cook(nodes, 'e')).geo, tw = (await cook(nodes, 'tw')).geo;
  check(solid(e) && solid(tw), 'extrude with a hole: closed (straight and twisted/tapered)');
  check(grp(e, 'prim', 'top') === 2 && grp(e, 'prim', 'bottom') === 2 && grp(e, 'prim', 'side') === e.numPrims - 4, `extrude with a hole keeps top/bottom/side (${grp(e, 'prim', 'top')}/${grp(e, 'prim', 'bottom')}/${grp(e, 'prim', 'side')})`);
  check(signedVolume(e) > 0 && Math.abs(signedVolume(e) - 0.3 * area((await cook(nodes, 'f')).geo)) < 1e-9, 'extrude with a hole: volume = height × the face with the hole');
  const f = (await cook(nodes, 'f')).geo;
  const plateArea = area((await cook(nodes, 'plate')).geo), holeArea = area((await cook(nodes, 'hole')).geo);
  check(Math.abs(area(f) - (plateArea - holeArea)) < 1e-6 && f.numPrims === 2, `boolean2d: a circle merged inside a plate is a hole (${f.numPrims} polygons, area ${area(f).toFixed(4)})`);
  const two = (await cook({
    a: { type: 'shape2d', params: { shape: 'rect', size: [1, 1] } },
    b: { type: 'shape2d', params: { shape: 'rect', size: [1, 1], center: [0.5, 0, 0] } },
    m: { type: 'merge', in: ['a', 'b'] },
    u: { type: 'boolean2d', in: ['m'] },
  }, 'u')).geo;
  check(Math.abs(area(two) - 1.5) < 1e-6, 'boolean2d: shapes that only overlap still join');
}

// ---------------------------------------------------------------- straps, corners, capsules

{
  const nodes: Record<string, NodeSpec> = {
    path: { type: 'curve', params: { points: [[0, 0, 0], [1, 0, 0], [1, 0, 1]] } },
    butt: { type: 'offset_curve', in: ['path'], params: { distance: 0.05, join: 'miter', output: 'faces' } },
    round: { type: 'offset_curve', in: ['path'], params: { distance: 0.05, cap: 'round', segments: 64, output: 'faces' } },
    band: { type: 'extrude', in: ['butt'], params: { height: 0.01 } },
  };
  const butt = (await cook(nodes, 'butt')).geo, round = (await cook(nodes, 'round')).geo, band = (await cook(nodes, 'band')).geo;
  check(Math.abs(area(butt) - 0.2) < 1e-6, `strap: an L path 2 m long, 0.1 m wide, mitred, cut square: area ${area(butt).toFixed(5)} (0.2)`);
  // two 1 × 0.1 rectangles overlapping in a 0.05 square, a quarter disc filling the outer corner, two half-disc ends
  const roundArea = 0.1975 + (Math.PI * 0.0025) / 4 + Math.PI * 0.0025;
  check(Math.abs(area(round) - roundArea) < 2e-4, `strap: round caps and join (area ${area(round).toFixed(5)} ≈ ${roundArea.toFixed(5)})`);
  check(solid(band) && Math.abs(signedVolume(band) - 0.002) < 1e-8, 'strap extruded: a closed band');
}
{
  const nodes: Record<string, NodeSpec> = {
    c: { type: 'curve', params: { points: [[0, 0, 0], [2, 0, 0], [2, 0, 1], [0, 0, 1]], closed: true, corner_radius: [0.2, 0, 0.4, 0.1] } },
    nan: { type: 'curve', params: { points: [[0, 0, 0], [1, null, 0], [2, 0, 0]] } },
    count: { type: 'curve', params: { points: [[0, 0, 0], [1, 0, 0]], corner_radius: [0.1] } },
  };
  const c = (await cook(nodes, 'c')).geo;
  const has = (x: number, z: number) => Array.from({ length: c.numPoints }, (_, i) => i).some((i) => Math.abs(c.P[i * 3] - x) < 1e-12 && Math.abs(c.P[i * 3 + 2] - z) < 1e-12);
  check(has(2, 0) && !has(0, 0) && !has(2, 1) && !has(0, 1), 'curve corner_radius: the 0 corner stays sharp, the others are rounded');
  const full = 2 * 1 - (4 - Math.PI) * (0.04 + 0.16 + 0.01) / 4 * 1;
  check(Math.abs(area(c) - full) < 0.01, `curve corner_radius: area ${area(c).toFixed(4)} ≈ ${full.toFixed(4)}`);
  check(/point 1 is not three numbers/.test(await cookError(nodes, 'nan')), 'curve: a null coordinate is an error naming the point');
  check(/corner_radius has 1 entries for 2 points/.test(await cookError(nodes, 'count')), 'curve: a radius list of the wrong length is an error');
  const cap = (await cook({ s: { type: 'shape2d', params: { shape: 'capsule', size: [2, 0.5], corner_segments: 8 } } }, 's')).geo;
  const b = cap.bbox();
  check(Math.abs(b.max[0] - 1) < 1e-12 && Math.abs(b.max[2] - 0.25) < 1e-12 && Math.abs(area(cap) - (1.5 * 0.5 + Math.PI * 0.0625)) < 2e-3, `shape2d capsule: 2 × 0.5 stadium (area ${area(cap).toFixed(4)})`);
  const slot = (await cook({ s: { type: 'shape2d', params: { shape: 'slot', size: [0.5, 2], corner_segments: 8 } } }, 's')).geo;
  check(Math.abs(area(slot) - area(cap)) < 1e-9, 'shape2d slot: the same stadium, standing up');
}

// ---------------------------------------------------------------- loft

{
  const nodes: Record<string, NodeSpec> = {
    a: { type: 'circle', params: { radius: 1, segments: 32 } },
    b: { type: 'circle', params: { radius: 0.5, segments: 32, center: [0, 1, 0] } },
    c: { type: 'circle', params: { radius: 0.8, segments: 32, center: [0, 2, 0] } },
    rb: { type: 'reverse', in: ['b'] },
    rings: { type: 'merge', in: ['a', 'rb', 'c'] },
    skin: { type: 'loft', in: ['rings'], params: { caps: true } },
    prof: { type: 'shape2d', params: { shape: 'rounded_rect', size: [0.06, 0.03], corner_radius: 0.006, plane: 'xy' } },
    inset: { type: 'shape2d', params: { shape: 'rounded_rect', size: [0.05, 0.02], corner_radius: 0.003, plane: 'xy', center: [0, 0, 0.1] } },
    pair: { type: 'merge', in: ['prof', 'inset'] },
    keep: { type: 'loft', in: ['pair'], params: { caps: true } },
    sec: { type: 'loft', in: ['prof'], params: { caps: true, sections: [{ offset: 0 }, { offset: 0.05, scale: [0.9, 0.8] }, { offset: [0, 0.01, 0.2], scale: 0.7, rotate: [0, 0, 10] }] } },
    bad: { type: 'loft', in: ['pair'], params: { sections: [{ offset: 0 }, { offset: 1 }] } },
  };
  const skin = (await cook(nodes, 'skin')).geo;
  check(solid(skin) && signedVolume(skin) > 0, 'loft: a section wound the other way is turned; closed, faces outward');
  check(grp(skin, 'prim', 'caps') === 2 && grp(skin, 'prim', 'sides') === 64, 'loft: caps/sides groups');
  const keep = (await cook(nodes, 'keep')).geo, inset = (await cook(nodes, 'inset')).geo;
  // same point count: the inset's own points are used, not resampled ones
  const insetPts = new Set(Array.from({ length: inset.numPoints }, (_, i) => `${inset.P[i * 3].toFixed(9)},${inset.P[i * 3 + 1].toFixed(9)}`));
  let found = 0;
  for (let i = 0; i < keep.numPoints; i++) if (Math.abs(keep.P[i * 3 + 2] - 0.1) < 1e-12 && insetPts.has(`${keep.P[i * 3].toFixed(9)},${keep.P[i * 3 + 1].toFixed(9)}`)) found++;
  check(found === inset.numPoints && solid(keep), `loft resample auto: sections with equal counts keep their own points (${found}/${inset.numPoints})`);
  const sec = (await cook(nodes, 'sec')).geo, sb = sec.bbox();
  check(solid(sec) && signedVolume(sec) > 0 && Math.abs(sb.max[2] - 0.2) < 1e-9 && Math.abs(sb.min[2]) < 1e-9, 'loft sections: one profile placed three times, closed, 0..0.2 along its normal');
  check(/sections places copies of one profile, but the input has 2 curves/.test(await cookError(nodes, 'bad')), 'loft sections: needs exactly one input curve');
}

// ---------------------------------------------------------------- revolve, sweep, polywire, copy_xform, remove_interior

{
  const nodes: Record<string, NodeSpec> = {
    prof: { type: 'curve', params: { points: [[0, 0, 0], [0, 0.4, 0], [0.6, 0.25, 0], [1.2, 0.45, 0], [1.2, 0, 0]] } },
    rx: { type: 'revolve', in: ['prof'], params: { axis: [1, 0, 0], segments: 24 } },
    off: { type: 'revolve', in: ['prof'], params: { axis: [1, 0, 0], origin: [0, 0, 2], segments: 24 } },
  };
  const rx = (await cook(nodes, 'rx')).geo, b = rx.bbox();
  check(solid(rx) && signedVolume(rx) > 0 && Math.abs(b.min[0]) < 1e-12 && Math.abs(b.max[0] - 1.2) < 1e-12 && Math.abs(b.max[1] - 0.45) < 1e-9, 'revolve axis x: profile in XY turns about X; closed, outward');
  const off = (await cook(nodes, 'off')).geo;
  // the profile lies about 2 m from an axis through (0, 0, 2): a ring around that axis
  const ob = off.bbox();
  check(Math.abs((ob.max[2] + ob.min[2]) / 2 - 2) < 1e-6 && Math.abs((ob.max[1] + ob.min[1]) / 2) < 1e-6 && ob.max[2] - ob.min[2] > 4, 'revolve origin: the axis passes through origin');
}
{
  const nodes: Record<string, NodeSpec> = {
    path: { type: 'line', params: { direction: [1, 0, 0], length: 2, points: 3 } },
    sw: { type: 'sweep', in: ['path'], params: { shape: 'rect', size: [0.3, 0.1] } },
    pw: { type: 'polywire', in: ['path'], params: { radius: 0.1, divisions: 12 } },
  };
  const sw = (await cook(nodes, 'sw')).geo, b = sw.bbox();
  check(solid(sw) && signedVolume(sw) > 0 && Math.abs(b.max[2] - b.min[2] - 0.3) < 1e-9 && Math.abs(b.max[1] - b.min[1] - 0.1) < 1e-9, 'sweep rect: 0.3 wide (sideways), 0.1 high (up), closed, outward');
  const pw = (await cook(nodes, 'pw')).geo;
  const uv = pw.vertices.get('uv')!, caps = pw.primGroups.get('caps')!;
  let distinct = true;
  for (let p = 0; p < pw.numPrims; p++) {
    if (!caps[p]) continue;
    const seen = new Set<string>();
    for (let v = pw.primStart[p]; v < pw.primStart[p + 1]; v++) seen.add((uv.get(v) as number[]).slice(0, 2).map((x) => x.toFixed(6)).join(','));
    if (seen.size !== pw.primSize(p)) distinct = false;
  }
  check(distinct && grp(pw, 'prim', 'caps') === 2, 'polywire caps: every corner has its own uv (a disc, not collapsed)');
}
{
  const { geo } = await cook({ box: { type: 'box' }, c: { type: 'copy_xform', in: ['box'], params: { count: 2 } } }, 'c');
  const b = geo.bbox();
  check(b.max[0] === 0.5 && geo.numPrims === 12, 'copy_xform: translate 0 by default (copies in place)');
}
{
  const nodes: Record<string, NodeSpec> = {
    body: { type: 'box', params: { size: [1, 0.4, 0.4] } },
    boss: { type: 'tube', params: { radius: 0.1, height: 0.3, caps: true } },
    place: { type: 'transform', in: ['boss'], params: { rotate: [0, 0, 90], translate: [0.5, 0, 0] } },
    parts: { type: 'merge', in: ['body', 'place'] },
    tidy: { type: 'remove_interior', in: ['parts'] },
    mark: { type: 'remove_interior', in: ['parts'], params: { output: 'group' } },
    ball: { type: 'sphere', params: { radius: 0.05 } },
    both: { type: 'merge', in: ['body', 'ball'] },
    gone: { type: 'remove_interior', in: ['both'] },
  };
  const parts = (await cook(nodes, 'parts')).geo, tidy = (await cook(nodes, 'tidy')).geo, mark = (await cook(nodes, 'mark')).geo;
  check(tidy.numPrims === parts.numPrims - 1 && grp(mark, 'prim', 'interior') === 1, 'remove_interior: the boss cap buried in the body goes; its walls, half outside, stay');
  const gone = (await cook(nodes, 'gone')).geo;
  check(gone.numPrims === 6, 'remove_interior: a ball wholly inside the body goes entirely');
}

// ---------------------------------------------------------------- kernels

{
  // a square split into a fan of 8 triangles with mixed keys: one key region merges, the other stays apart
  const pos = [0, 0, 0, 1, 0, 0, 2, 0, 0, 2, 0, 1, 2, 0, 2, 1, 0, 2, 0, 0, 2, 0, 0, 1, 1, 0, 1];
  const ring = [0, 1, 2, 3, 4, 5, 6, 7];
  const prims = ring.map((a, k) => [8, ring[(k + 1) % 8], a]);
  const g = new Geometry({ positions: pos, prims });
  const one = mergeTriangles(g, new Float64Array(8));
  check(one.numPrims === 1 && one.primSize(0) === 8 && Math.abs(primArea(one, 0) - 4) < 1e-12, 'mergeTriangles: a flat fan becomes one polygon on its outline');
  const half = mergeTriangles(g, Float64Array.from([0, 0, 0, 0, 1, 1, 1, 1]));
  check(half.numPrims === 2 && Math.abs(area(half) - 4) < 1e-12, 'mergeTriangles: keys keep regions apart');
  // nearly collinear corners: the flat n-gon triangulates without slivers
  const sl = new Geometry({ positions: [0, 0, 0, 1, 0, 1e-7, 2, 0, 0, 3, 0, 1e-7, 4, 0, 0, 4, 0, 1, 0, 0, 1], prims: [[6, 5, 4, 3, 2, 1, 0]] });
  const tr = triangleReport(sl);
  check(tr.triangles === 5 && tr.degenerate === 0, `triangulate: a flat n-gon with nearly collinear corners keeps every corner (min quality ${tr.minQuality.toExponential(2)})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
