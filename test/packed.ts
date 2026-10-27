// Packed primitive tests: the Geometry model (clone, subsets, merge dedup, GeoBuilder, bbox), pack/unpack
// round trips, packed copy_to_points against real copies (orient, N+up, pscale, scale, rot, pivot, trans, variants,
// nested), transform/copy_xform composition, auto-unpack with its warning and cache, foreach over instances,
// JSON/GLB/USD IO, exporters that expand, the render hook and its budget, inspect, and every node type fed packed
// prims (keep nodes must keep them valid, the others must unpack with a warning).
//   node test/packed.ts
import { createRequire } from 'node:module';
import '../src/nodes/index.ts';
import { Geometry, GeoBuilder } from '../src/core/geometry.ts';
import { expandForRender, expandPacked, packedFromMatrices, packedInfo } from '../src/core/packed.ts';
import { m4fromQuat, m4mul, m4scale, m4translate, qNormalize } from '../src/core/math.ts';
import type { Mat4 } from '../src/core/math.ts';
import { allNodeDefs } from '../src/graph/registry.ts';
import { geoFromJSON, geoToJSON } from '../src/io/json.ts';
import { exportGeometry, exportGeometryAsync, exportOBJ } from '../src/io/export.ts';
import { importGeometryAsync } from '../src/io/import.ts';
import { renderGeometry } from '../src/render/raster.ts';
import { summarize } from '../src/inspect.ts';
import { fingerprint } from './fingerprint.ts';
import { SKIP, checkGeo, createFixtureEngine, fixtureGraphFor } from './fixtures.ts';
import type { GraphSpec, NodeSpec } from '../src/graph/types.ts';

const require = createRequire(import.meta.url);
const validator = require('gltf-validator');
const { engine, tmp } = await createFixtureEngine();

let fail = 0, pass = 0;
const check = (ok: any, msg: string) => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
};
const eq = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);
const fpEq = (a: Geometry, b: Geometry) => eq(fingerprint(a), fingerprint(b));
const maxDiff = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  if (a.length !== b.length) return Infinity;
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};

async function run(nodes: Record<string, NodeSpec>, output: string) {
  const r = await engine.cook({ nodes, output });
  if (!r.ok || !r.geo) throw new Error(`cook failed: ${r.errors.map((e) => `[${e.node}] ${e.message}`).join('; ')}`);
  return { geo: r.geo, warnings: r.warnings.map((w) => `[${w.node}] ${w.message}`), report: r };
}
const cook = async (nodes: Record<string, NodeSpec>, output: string) => (await run(nodes, output)).geo;
const unpacked = (g: Geometry, transfer = '*') => expandPacked(g, { transfer }).geo;
const valid = (g: Geometry, label: string) => {
  const e = checkGeo(g);
  check(!e.length, `${label}: geometry invariants${e.length ? ' — ' + e.join(', ') : ''}`);
};

// shared building blocks
const PTS: Record<string, NodeSpec> = {
  grid: { type: 'grid', params: { size: [8, 8], divisions: [4, 4] } },
  pts: { type: 'scatter', in: ['grid'], params: { count: 40, seed: 3 } },
};
const SRC: Record<string, NodeSpec> = {
  tree: { type: 'tube', params: { radius: 0.2, radius_top: 0, height: 1, center: [0.1, 0.5, 0], cols: 6 } },
};

// ---------------------------------------------------------------- the geometry model
{
  const src = await cook({ s: { type: 'box', params: { size: [1, 2, 0.5] } } }, 's');
  const mats = [m4translate(1, 0, 0), m4mul(m4translate(0, 3, 0), m4scale(2, 2, 2)), m4mul(m4translate(-2, 0, 1), m4fromQuat(qNormalize([0, 0.3826834, 0, 0.9238795])))];
  const g = packedFromMatrices(src, mats);
  valid(g, 'packedFromMatrices');
  check(g.hasPacked() && g.numPacked === 3 && g.packedSources.length === 1 && g.packedSources[0] === src, 'packedFromMatrices: 3 instances sharing the source object');
  check(maxDiff(g.packedFullTransform(1), mats[1]) < 1e-12, 'packedFullTransform = translate(anchor) · packedXform');
  const c = g.clone();
  c.packedXform![0] = 5;
  check(g.packedXform![0] === 1 && c.packedSources[0] === src, 'clone copies the per-prim arrays and shares the sources');
  // bbox: the instances' transformed source boxes, not the anchors
  const u = unpacked(g);
  const b1 = g.bbox(), b2 = u.bbox();
  check(maxDiff(b1.min, b2.min) < 1e-9 && maxDiff(b1.max, b2.max) < 1e-9, `bbox of packed = bbox of the expanded geometry (${b1.min.map((x) => x.toFixed(3))} .. ${b1.max.map((x) => x.toFixed(3))})`);
  // subsets
  const sp = g.subsetPrims(Uint8Array.from([1, 0, 1]));
  valid(sp, 'subsetPrims');
  check(sp.numPacked === 2 && sp.numPoints === 2 && maxDiff(sp.packedFullTransform(1), mats[2]) < 1e-12, 'subsetPrims keeps the right instances (anchor points follow)');
  const spt = g.subsetPoints(Uint8Array.from([0, 1, 1]));
  check(spt.numPacked === 2 && maxDiff(spt.packedFullTransform(0), mats[1]) < 1e-12, 'subsetPoints: an instance lives while its anchor point does');
  const sv = g.subsetVertices(Uint8Array.from([1, 1, 0]));
  check(sv.numPacked === 2, 'subsetVertices: an instance dies with its vertex');
  const none = g.subsetPrims(new Uint8Array(3));
  check(!none.primKind && none.packedSources.length === 0, 'removing every instance clears the packed arrays and sources');
  // GeoBuilder: a one-vertex prim copied from a packed prim stays packed
  const b = new GeoBuilder(g);
  const p0 = b.copyPoint(2);
  b.addPrim([p0], false, 2);
  const q0 = b.copyPoint(0), q1 = b.copyPoint(1);
  b.addPrim([q0, q1], false, 0);
  const bg = b.build();
  valid(bg, 'GeoBuilder with packed source');
  check(bg.isPacked(0) && !bg.isPacked(1) && maxDiff(bg.packedFullTransform(0), mats[2]) < 1e-12, 'GeoBuilder: copied packed prim keeps kind, source and transform; a two-vertex prim is not packed');
  // merge: sources shared, not copied; mixed with polygons
  const m = Geometry.merge([src, g, g]);
  valid(m, 'merge with polygons');
  check(m.numPacked === 6 && m.packedSources.length === 1 && m.packedSources[0] === src && m.numPrims === src.numPrims + 6, 'merge: instances concatenated, one shared source (not copied)');
  const src2 = src.clone(); // same content, another object
  const m2 = Geometry.merge([g, packedFromMatrices(src2, [m4translate(9, 0, 0)])]);
  check(m2.packedSources.length === 1 && m2.numPacked === 4, 'merge: sources deduplicated by content hash');
  const other = await cook({ s: { type: 'sphere' } }, 's');
  const m3 = Geometry.merge([g, packedFromMatrices(other, [m4translate(9, 0, 0)])]);
  check(m3.packedSources.length === 2 && m3.packedSource![3] === 1, 'merge: different sources stay apart and indices are remapped');
}

// ---------------------------------------------------------------- pack / unpack round trips
{
  const nodes: Record<string, NodeSpec> = {
    a: { type: 'box', params: { divisions: [2, 2, 2] } },
    ac: { type: 'color', in: ['a'], params: { color: '#c04020', class: 'prim' } },
    an: { type: 'attrib_create', in: ['ac'], params: { name: 'name', class: 'prim', value: 'crate' } },
    b: { type: 'sphere', params: { center: [3, 0, 0] } },
    bc: { type: 'color', in: ['b'], params: { mode: 'random' } },
    bn: { type: 'attrib_create', in: ['bc'], params: { name: 'name', class: 'prim', value: 'ball' } },
    c: { type: 'box', params: { center: [0, 0, 4] } },
    cg: { type: 'group', in: ['c'], params: { name: 'lid', expr: '@P.y > 0.4' } },
    m: { type: 'merge', in: ['an', 'bn', 'cg'] },
    pk: { type: 'pack', in: ['m'] },
    un: { type: 'unpack', in: ['pk'] },
  };
  const input = await cook(nodes, 'm');
  const pk = await cook(nodes, 'pk');
  valid(pk, 'pack');
  check(pk.numPacked === 3 && pk.numPoints === 3, `pack by connectivity: 3 instances (${pk.numPacked})`);
  check(pk.prims.has('name') && pk.prims.get('name')!.get(0) === 'crate', 'pack carries the constant prim name onto the packed prim');
  check(fpEq(await cook(nodes, 'un'), input), 'pack → unpack equals the input (fingerprint)');
  for (const pivot of ['origin', 'bbox_min', 'bbox_center_bottom']) {
    const n2 = { ...nodes, pk: { type: 'pack', in: ['m'], params: { pivot } } };
    check(fpEq(await cook(n2, 'un'), input), `pack pivot ${pivot} → unpack equals the input`);
  }
  for (const by of ['name', 'all']) {
    const n2 = { ...nodes, pk: { type: 'pack', in: ['m'], params: { by } } };
    const p = await cook(n2, 'pk');
    check(p.numPacked === (by === 'all' ? 1 : 3) && fpEq(await cook(n2, 'un'), input), `pack by ${by}: ${p.numPacked} instance(s), round trip equals the input`);
  }
  const pieces = await cook({ x: { type: 'box' }, xs: { type: 'copy_xform', in: ['x'], params: { count: 5, translate: [2, 0, 0], copy_attrib: '' } }, pk: { type: 'pack', in: ['xs'] } }, 'pk');
  check(pieces.numPacked === 5 && pieces.packedSources.length === 1, `pack: identical pieces share one source (${pieces.packedSources.length})`);
  const noDedup = await cook({ x: { type: 'box' }, xs: { type: 'copy_xform', in: ['x'], params: { count: 5, translate: [2, 0, 0], copy_attrib: '' } }, pk: { type: 'pack', in: ['xs'], params: { source_dedup: false } } }, 'pk');
  check(noDedup.packedSources.length === 5, 'pack source_dedup:false keeps a source per piece');
  // colour per piece moves onto the anchor: pieces that differ only in colour share a source; unpack restores it
  const tinted = { x: { type: 'box' }, xs: { type: 'copy_xform', in: ['x'], params: { count: 4, translate: [2, 0, 0], copy_attrib: '' } }, col: { type: 'color', in: ['xs'], params: { mode: 'random', class: 'prim', by: 'class' } }, conn: { type: 'connectivity', in: ['xs'] }, col2: { type: 'color', in: ['conn'], params: { mode: 'random', class: 'prim', by: 'class' } }, del: { type: 'attrib_delete', in: ['col2'], params: { names: 'class', class: 'prim' } }, pk: { type: 'pack', in: ['del'] }, un: { type: 'unpack', in: ['pk'] } } as Record<string, NodeSpec>;
  const tp = await cook(tinted, 'pk');
  check(tp.packedSources.length === 1 && tp.prims.has('Cd'), 'pack: constant Cd moves onto the packed prim, the coloured pieces share one source');
  check(fpEq(await cook(tinted, 'un'), await cook(tinted, 'del')), 'pack → unpack restores the per-piece colours');
  // isolated points stay unpacked
  const iso = await cook({ x: { type: 'box' }, p: { type: 'points', params: { positions: [[5, 5, 5], [6, 6, 6]] } }, m: { type: 'merge', in: ['x', 'p'] }, pk: { type: 'pack', in: ['m'] }, un: { type: 'unpack', in: ['pk'] } }, 'pk');
  check(iso.numPacked === 1 && iso.numPoints === 3, `pack: isolated points stay as points (${iso.numPoints} points)`);
  // nested: pack the packed
  const nested = { ...nodes, pk2: { type: 'pack', in: ['pk'], params: { by: 'all' } }, un2: { type: 'unpack', in: ['pk2'] }, un3: { type: 'unpack', in: ['un2'] }, unr: { type: 'unpack', in: ['pk2'], params: { recursive: true } } };
  const pk2 = await cook(nested, 'pk2');
  check(pk2.numPacked === 1 && pk2.packedSources[0].numPacked === 3, 'nested packing: one instance of a packed source');
  const un2 = await cook(nested, 'un2');
  valid(un2, 'unpack one level');
  check(un2.numPacked === 3 && fpEq(un2, pk), 'unpack is one level: the nested instances come back packed (equal to the inner pack)');
  check(fpEq(await cook(nested, 'unr'), input), 'unpack recursive:true expands every level');
  check(fpEq(await cook(nested, 'un3'), input) && fpEq(expandPacked(pk2, { transfer: 'name Cd material piece' }).geo, input), 'nested: unpack twice, or expandPacked once, equals the input');
  // unpack options
  const lim = await run({ ...nodes, u: { type: 'unpack', in: ['pk'], params: { limit: 2, piece_attrib: 'piece' } } }, 'u');
  check(lim.geo.prims.has('piece') && new Set(lim.geo.prims.get('piece')!.data as Int32Array).size === 2 && lim.warnings.some((w) => /limit/.test(w)), 'unpack limit:2 expands two instances (piece attribute, note)');
  const part = await cook({ ...nodes, u: { type: 'unpack', in: ['pk'], params: { group: '0' } } }, 'u');
  valid(part, 'unpack group');
  check(part.numPacked === 2 && part.numPrims === 2 + 6 * 4, 'unpack group "0": the other instances stay packed');
}

// ---------------------------------------------------------------- packed copy_to_points = real copies after unpack
{
  const cases: [string, string][] = [
    ['identity', ''],
    ['orient', '@orient = normalize([rand(@ptnum), rand(@ptnum + 1), rand(@ptnum + 2), 1]);'],
    ['N + up', '@N = [rand(@ptnum) - 0.5, 0.3, rand(@ptnum + 4) - 0.5]; @up = [0.2, 1, 0];'],
    ['N parallel to up', '@N = [0, 1, 0];'],
    ['pscale', '@pscale = 0.5 + rand(@ptnum);'],
    ['scale + rot', '@scale = [1, 2, 0.5]; @rot = normalize([0.3, 0, 0, 1]);'],
    ['pivot + trans', '@pivot = [0, 0.5, 0]; @trans = [0, 1, 0]; @pscale = 2;'],
    ['v', '@v = [1, 0, 1];'],
    ['template Cd', '@Cd = [rand(@ptnum), 0.5, 0.2];'],
  ];
  for (const [label, code] of cases) {
    const nodes: Record<string, NodeSpec> = {
      ...PTS, ...SRC,
      srcc: { type: 'color', in: ['tree'], params: { color: '#4a8040', class: 'prim' } },
      pts0: { type: 'attrib_delete', in: ['pts'], params: { names: 'N', class: 'point' } },
      attrs: code ? { type: 'wrangle', in: ['pts0'], params: { code } } : { type: 'null', in: ['pts0'] },
      real: { type: 'copy_to_points', in: ['srcc', 'attrs'] },
      inst: { type: 'copy_to_points', in: ['srcc', 'attrs'], params: { pack: true } },
      back: { type: 'unpack', in: ['inst'], params: { transfer_attributes: '*' } },
    };
    const real = await cook(nodes, 'real'), inst = await cook(nodes, 'inst'), back = await cook(nodes, 'back');
    valid(inst, `copy_to_points pack (${label})`);
    const d = maxDiff(real.P, back.P);
    check(inst.numPacked === 40 && d <= 1e-9, `packed copy (${label}) = real copy after unpack: P max diff ${d.toExponential(1)}`);
    check(fpEq(real, back), `packed copy (${label}): unpacked fingerprint equals the real copy`);
    // packed bounds are each instance's transformed source box: exact without rotation, a conservative box with it
    const bi = inst.bbox(), br = real.bbox();
    const contains = [0, 1, 2].every((k) => bi.min[k] <= br.min[k] + 1e-9 && bi.max[k] >= br.max[k] - 1e-9);
    const exact = maxDiff(bi.min, br.min) < 1e-9 && maxDiff(bi.max, br.max) < 1e-9;
    check(contains && (exact || /orient|N|rot|v/.test(label)), `packed copy (${label}): bbox includes the instances${exact ? ' (exact)' : ' (conservative under rotation)'}`);
  }
  // variants by name, by piece, by piece_attrib; and nested packed sources
  const VAR: Record<string, NodeSpec> = {
    ...PTS,
    t1: { type: 'tube', params: { radius: 0.2, height: 1, center: [0, 0.5, 0], cols: 5 } },
    t1n: { type: 'attrib_create', in: ['t1'], params: { name: 'name', class: 'prim', value: 'pine' } },
    t2: { type: 'sphere', params: { radius: 0.4, center: [0, 0.6, 0] } },
    t2n: { type: 'attrib_create', in: ['t2'], params: { name: 'name', class: 'prim', value: 'oak' } },
    t3: { type: 'box', params: { size: [0.3, 1.5, 0.3] } },
    t3n: { type: 'attrib_create', in: ['t3'], params: { name: 'name', class: 'prim', value: 'fir' } },
    trees: { type: 'merge', in: ['t1n', 't2n', 't3n'] },
    vs: { type: 'attrib_randomize', in: ['pts'], params: { name: 'variant', distribution: 'choice', values: ['pine', 'oak', 'fir', 'none'] } },
    vi: { type: 'attrib_randomize', in: ['pts'], params: { name: 'variant', distribution: 'choice', values: [0, 1, 2, 5] } },
  };
  for (const [label, pts, params] of [
    ['variants name', 'vs', { variants: 'name' }],
    ['variants piece', 'vi', { variants: 'piece' }],
    ['piece_attrib name, int variant', 'vi', { piece_attrib: 'name' }],
  ] as [string, string, any][]) {
    const nodes = { ...VAR, real: { type: 'copy_to_points', in: ['trees', pts], params }, inst: { type: 'copy_to_points', in: ['trees', pts], params: { ...params, pack: true } }, back: { type: 'unpack', in: ['inst'], params: { transfer_attributes: '*' } } };
    const real = await cook(nodes, 'real'), inst = await cook(nodes, 'inst'), back = await cook(nodes, 'back');
    valid(inst, `copy_to_points pack (${label})`);
    check(inst.packedSources.length === 3 && maxDiff(real.P, back.P) <= 1e-9 && fpEq(real, back), `${label}: ${inst.numPacked} instances of ${inst.packedSources.length} sources = real copies after unpack`);
  }
  // nested: a packed source copied packed and unpacked
  const NEST = { ...VAR, inner: { type: 'copy_to_points', in: ['t1n', 'pts3'], params: { pack: true } }, pts3: { type: 'points', params: { positions: [[0, 0, 0], [0.5, 0, 0], [0, 0, 0.5]] } }, pts4: { type: 'points', params: { positions: [[3, 0, 0], [0, 0, 3]] } }, rot: { type: 'attrib_create', in: ['pts4'], params: { name: 'orient', value: [0, 0.3826834, 0, 0.9238795] } } } as Record<string, NodeSpec>;
  const outerReal = await cook({ ...NEST, o: { type: 'copy_to_points', in: ['inner', 'rot'] } }, 'o');
  const outerPacked = await cook({ ...NEST, o: { type: 'copy_to_points', in: ['inner', 'rot'], params: { pack: true } } }, 'o');
  valid(outerReal, 'copy_to_points of a packed source (pack:false)');
  check(outerReal.numPacked === 6 && outerPacked.numPacked === 2 && outerPacked.packedSources[0].numPacked === 3, 'nested: copying packed geometry repeats its instances (pack:false) or nests them (pack:true)');
  check(maxDiff(unpacked(outerReal).P, unpacked(outerPacked).P) < 1e-9, 'nested: both expand to the same points');
}

// ---------------------------------------------------------------- transforms compose into instance transforms
{
  const base: Record<string, NodeSpec> = {
    ...PTS, ...SRC,
    o: { type: 'attrib_randomize', in: ['pts'], params: { name: 'orient', distribution: 'orient' } },
    treeN: { type: 'normal', in: ['tree'], params: { class: 'vertex' } },
    inst: { type: 'copy_to_points', in: ['treeN', 'o'], params: { pack: true } },
    real: { type: 'copy_to_points', in: ['treeN', 'o'] },
  };
  const xf = { translate: [1, 2, 3], rotate: [10, 40, -20], scale: [1, 2, 0.5], pivot: [0.5, 0, 0] };
  const ti = await cook({ ...base, x: { type: 'transform', in: ['inst'], params: xf } }, 'x');
  const tr = await cook({ ...base, x: { type: 'transform', in: ['real'], params: xf } }, 'x');
  const back = unpacked(ti);
  check(maxDiff(back.P, tr.P) < 1e-9, `transform of instances = transform of real copies (P max diff ${maxDiff(back.P, tr.P).toExponential(1)})`);
  const nb = back.findAttrib('N'), nr = tr.findAttrib('N');
  check(!!nb && !!nr && nb.cls === nr.cls && maxDiff(nb.attr.data as Float64Array, nr.attr.data as Float64Array) < 1e-9, `transform of instances: normals match too (non-uniform scale; ${nb?.cls} N)`);
  const tg = await cook({ ...base, x: { type: 'transform', in: ['inst'], params: { rotate: [0, 90, 0], group: '@P.x>0' } } }, 'x');
  const insts = await cook(base, 'inst');
  let moved = 0, kept = 0;
  for (let p = 0; p < tg.numPrims; p++) {
    const a = tg.vertexPoint[tg.primStart[p]];
    const same = maxDiff(tg.packedXform!.subarray(p * 9, p * 9 + 9), insts.packedXform!.subarray(p * 9, p * 9 + 9)) < 1e-12;
    if (insts.P[a * 3] > 0) moved += same ? 0 : 1; else kept += same ? 1 : 0;
  }
  check(moved + kept === tg.numPrims, `transform with a point group rotates only the selected instances (${moved} rotated, ${kept} untouched)`);
  const cx = await cook({ ...base, x: { type: 'copy_xform', in: ['inst'], params: { count: 3, rotate: [0, 30, 0], translate: [10, 0, 0] } } }, 'x');
  const cxr = await cook({ ...base, x: { type: 'copy_xform', in: ['real'], params: { count: 3, rotate: [0, 30, 0], translate: [10, 0, 0] } } }, 'x');
  check(cx.numPacked === 120 && maxDiff(unpacked(cx).P, cxr.P) < 1e-9, 'copy_xform keeps instances packed and equals copy_xform of real copies');
  const ms = await cook({ ...base, x: { type: 'match_size', in: ['inst'], params: { scale_to_fit: true, target_size: 2 } } }, 'x');
  const msb = ms.bbox();
  check(ms.numPacked === 40 && Math.abs(Math.max(...[0, 1, 2].map((k) => msb.max[k] - msb.min[k])) - 2) < 1e-9, 'match_size fits the instances (bbox of the instances)');
  // deformers that move points move the anchors
  const tw = await run({ ...base, x: { type: 'twist', in: ['inst'], params: { angle: 45 } } }, 'x');
  check(tw.geo.numPacked === 40 && !tw.warnings.some((w) => /unpacked/.test(w)), 'twist moves the instance anchors (instances stay packed)');
}

// ---------------------------------------------------------------- auto-unpack, cache, foreach, subsets
{
  const nodes: Record<string, NodeSpec> = {
    b: { type: 'box' },
    pts: { type: 'points', params: { positions: [[0, 0, 0], [0.5, 0.2, 0], [1, 0, 0.3]] } },
    inst: { type: 'copy_to_points', in: ['b', 'pts'], params: { pack: true } },
    cut: { type: 'sphere', params: { radius: 0.6, center: [0.5, 0.5, 0.5] } },
    bool: { type: 'boolean', in: ['inst', 'cut'], params: { operation: 'subtract' } },
    boolReal: { type: 'boolean', in: ['up', 'cut'], params: { operation: 'subtract' } },
    up: { type: 'unpack', in: ['inst'] },
  };
  const r = await run(nodes, 'bool');
  check(r.warnings.some((w) => /unpacked 3 instances for bool/.test(w)), `boolean auto-unpacks with one warning (${r.warnings.join(' | ')})`);
  check(fpEq(r.geo, await cook(nodes, 'boolReal')), 'auto-unpacked boolean = boolean of the unpacked input');
  const sig = r.report.results.get('inst')!.sig;
  check(!!engine.cache.get('unpack:' + sig), 'the auto-unpacked input is cached under its signature');
  const r2 = await engine.cook({ nodes: { ...nodes, bool: { type: 'boolean', in: ['inst', 'cut'], params: { operation: 'union' } } }, output: 'bool' });
  check(r2.ok && r2.warnings.some((w) => /unpacked/.test(w.message)), 'a second node on the same packed input reuses the cached expansion');
  // foreach by pieces over packed prims: one iteration per instance, results stay packed
  const fe = await run({ ...nodes, fe: { type: 'foreach', in: ['inst'], params: { mode: 'pieces', body: { nodes: { i: { type: 'input', params: { index: 0 } }, t: { type: 'transform', in: ['i'], params: { translate: [0, '=iteration', 0] } } }, output: 't' } } } }, 'fe');
  valid(fe.geo, 'foreach over packed prims');
  check(fe.geo.numPacked === 3 && Math.abs(fe.geo.P[2 * 3 + 1] - 2) < 1e-12, 'foreach pieces: one iteration per instance, instances stay packed and move');
  const fe2 = await cook({ ...nodes, fe: { type: 'foreach', in: ['inst'], params: { mode: 'pieces', body: { nodes: { i: { type: 'input', params: { index: 0 } }, s: { type: 'subdivide', in: ['i'] } }, output: 's' } } } }, 'fe');
  check(!fe2.hasPacked() && fe2.numPrims === 3 * 24, 'foreach body nodes unpack their piece when they need polygons');
  // deletes, sort, groups, wrangles on instances
  const many = { ...nodes, pts: { type: 'point_grid', params: { counts: [6, 1, 6], size: [5, 0, 5] } } };
  for (const [label, spec] of [
    ['delete prims', { type: 'delete', in: ['inst'], params: { group: '@P.x>0' } }],
    ['delete points', { type: 'delete', in: ['inst'], params: { class: 'point', group: '0-9' } }],
    ['delete keep', { type: 'delete', in: ['inst'], params: { group: '3-5', keep: true } }],
    ['sort prims random', { type: 'sort', in: ['inst'], params: { class: 'prim', by: 'random' } }],
    ['sort points x', { type: 'sort', in: ['inst'], params: { class: 'point', by: 'z' } }],
    ['group by expr', { type: 'group', in: ['inst'], params: { name: 'near', expr: '@P.x < 0' } }],
    ['wrangle points', { type: 'wrangle', in: ['inst'], params: { code: '@P.y += @ptnum * 0.1; if (@ptnum == 3) removepoint(0, @ptnum);' } }],
    ['wrangle prims', { type: 'wrangle', in: ['inst'], params: { run_over: 'prims', code: '@Cd = [1, 0, 0]; if (@primnum == 0) { const p = addpoint(0, [9, 9, 9]); addprim(0, "polyline", [p, 0]); }' } }],
    ['attrib_promote', { type: 'attrib_promote', in: ['inst'], params: { name: 'copynum', from: 'prim', to: 'point' } }],
    ['material', { type: 'material', in: ['inst'], params: { name: 'bark', base_color: '#6b4a2f' } }],
  ] as [string, NodeSpec][]) {
    const res = await run({ ...many, x: spec }, 'x');
    valid(res.geo, `${label} on instances`);
    check(res.geo.hasPacked() && !res.warnings.some((w) => /unpacked/.test(w)), `${label}: instances kept (${res.geo.numPacked} of 36)`);
  }
  const sorted = await cook({ ...many, x: { type: 'sort', in: ['inst'], params: { class: 'prim', by: 'reverse' } } }, 'x');
  const orig = await cook(many, 'inst');
  check(maxDiff(sorted.packedFullTransform(0), orig.packedFullTransform(35)) < 1e-12, 'sort prims reorders the instance transforms with the prims');
  const varDel = await cook({ ...many, t2: { type: 'sphere' }, trees: { type: 'merge', in: ['bn', 't2n'] }, bn: { type: 'attrib_create', in: ['b'], params: { name: 'name', class: 'prim', value: 'a' } }, t2n: { type: 'attrib_create', in: ['t2'], params: { name: 'name', class: 'prim', value: 'b' } }, v: { type: 'wrangle', in: ['pts'], params: { code: 'i@variant = @ptnum % 2;' } }, cp: { type: 'copy_to_points', in: ['trees', 'v'], params: { pack: true, variants: 'name' } }, x: { type: 'wrangle', in: ['cp'], params: { run_over: 'prims', code: 'if (@copynum % 2 == 1) removeprim(0, @primnum, 1);' } } }, 'x');
  valid(varDel, 'delete every instance of one variant');
  check(varDel.packedSources.length === 1 && varDel.numPacked === 18, `deleting all instances of a variant drops its source (${varDel.packedSources.length} source left)`);
}

// ---------------------------------------------------------------- IO
{
  const nodes: Record<string, NodeSpec> = {
    ...PTS, ...SRC,
    srcc: { type: 'color', in: ['tree'], params: { color: '#4a8040', class: 'prim' } },
    o: { type: 'attrib_randomize', in: ['pts'], params: { name: 'orient', distribution: 'orient', seed: 2 } },
    s: { type: 'attrib_randomize', in: ['o'], params: { name: 'pscale', min: 0.5, max: 2 } },
    inst: { type: 'copy_to_points', in: ['srcc', 's'], params: { pack: true } },
    poly: { type: 'grid', params: { size: [8, 8] } },
    mixed: { type: 'merge', in: ['poly', 'inst'] },
  };
  const g = await cook(nodes, 'mixed');
  // JSON (lossless)
  const j = geoFromJSON(JSON.parse(JSON.stringify(geoToJSON(g))));
  valid(j, 'json round trip');
  check(fpEq(j, g), 'JSON round trip keeps the instances, sources and transforms (fingerprint)');
  const jb = new TextDecoder().decode(exportGeometry(g, 'json'));
  check((jb.match(/"format":"topotopo-geo"/g) ?? []).length === 2, 'JSON writes the shared source once');
  // GLB: EXT_mesh_gpu_instancing
  for (const opts of [{}, { quantize: true }, { compress: 'meshopt' as const }, { upAxis: 'z' as const }]) {
    const label = JSON.stringify(opts);
    const warns: string[] = [];
    const bytes = await exportGeometryAsync(g, 'glb', { ...opts, warn: (m) => warns.push(m) });
    const report = await validator.validateBytes(bytes, { maxIssues: 20, writeTimestamp: false });
    check(report.issues.numErrors === 0, `glb ${label}: glTF validator ${report.issues.numErrors} errors${report.issues.numErrors ? ' — ' + report.issues.messages.filter((m: any) => m.severity === 0).slice(0, 3).map((m: any) => `${m.code} ${m.message}`).join(' | ') : ''}`);
    const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(12, true))));
    check(json.extensionsUsed?.includes('EXT_mesh_gpu_instancing'), `glb ${label}: uses EXT_mesh_gpu_instancing`);
    const back = await importGeometryAsync(bytes, 'glb');
    valid(back, `glb ${label} import`);
    check(back.numPacked === g.numPacked && back.packedSources.length === 1, `glb ${label}: ${back.numPacked} instances of ${back.packedSources.length} source read back as packed prims`);
    if (!opts.upAxis) {
      // compare the instances' world-space geometry (the source may come back quantised into a different frame)
      const a = unpacked(g.subsetPrims(Uint8Array.from({ length: g.numPrims }, (_, p) => (g.isPacked(p) ? 1 : 0)))), b = unpacked(back.subsetPrims(Uint8Array.from({ length: back.numPrims }, (_, p) => (back.isPacked(p) ? 1 : 0))));
      const tol = opts.quantize || opts.compress ? 2e-3 : 1e-5;
      const ab = a.bbox(), bb = b.bbox();
      check(maxDiff(ab.min, bb.min) < tol * 10 && maxDiff(ab.max, bb.max) < tol * 10, `glb ${label}: instance bbox matches`);
      if (!opts.quantize && !opts.compress) {
        let d = 0;
        for (let i = 0; i < g.numPacked; i++) d = Math.max(d, maxDiff(back.packedFullTransform(back.numPrims - g.numPacked + i), g.packedFullTransform(g.numPrims - g.numPacked + i)));
        check(d < 1e-5, `glb ${label}: instance transforms within 1e-5 (max diff ${d.toExponential(1)})`);
      }
    } else {
      // Z-up: converting back with the file node's up_axis z gives the original instances
      const path = `${tmp}/forest_z.glb`;
      (await import('node:fs')).writeFileSync(path, bytes);
      const fz = await cook({ f: { type: 'file', params: { path, up_axis: 'z' } } }, 'f');
      // the source stays in the file's Z-up frame: F_file · C = F_original, C = (x, y, z) → (x, -z, y)
      const C = Float64Array.from([1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1]);
      let d = 0;
      for (let i = 0; i < g.numPacked; i++) d = Math.max(d, maxDiff(m4mul(fz.packedFullTransform(fz.numPrims - g.numPacked + i), C), g.packedFullTransform(g.numPrims - g.numPacked + i)));
      check(fz.numPacked === g.numPacked && d < 1e-5, `glb Z-up → file up_axis z: the instances land where they were (max diff ${d.toExponential(1)})`);
    }
  }
  const tris = (x: Geometry) => { let t = 0; for (let p = 0; p < x.numPrims; p++) if (x.primClosed[p]) t += Math.max(0, x.primSize(p) - 2); return t; };
  const expBytes = await exportGeometryAsync(g, 'glb', { instancing: 'expand' });
  const expBack = await importGeometryAsync(expBytes, 'glb');
  check(!expBack.hasPacked() && expBack.numPrims === tris(unpacked(g)), `glb instancing:"expand" writes real copies (${expBack.numPrims} triangles)`);
  const flat = await importGeometryAsync(await exportGeometryAsync(g, 'glb'), 'glb', { instancing: 'expand' });
  check(!flat.hasPacked() && flat.numPrims === expBack.numPrims, 'glb import instancing:"expand" expands the instances');
  // shear: a non-uniform scale after a rotation cannot be TRS; warned
  const sheared = await cook({ ...nodes, x: { type: 'transform', in: ['inst'], params: { scale: [1, 3, 1] } } }, 'x');
  const sw: string[] = [];
  await exportGeometryAsync(sheared, 'glb', { warn: (m) => sw.push(m) });
  check(sw.some((w) => /shear/.test(w)), `glb: sheared instance transforms are warned about (${sw[0] ?? 'no warning'})`);
  // USD PointInstancer
  const usd = new TextDecoder().decode(exportGeometry(g, 'usda'));
  const arr = (name: string) => { const m = new RegExp(name + ' = \\[([^\\]]*)\\]').exec(usd); return m ? m[1].split(/,\s*(?![^()]*\))/).filter(Boolean).length : -1; };
  check(/def PointInstancer "instances"/.test(usd) && /rel prototypes = \[<\/root\/instances\/prototypes\/[^>]+>\]/.test(usd), 'usda: a PointInstancer with one prototype');
  check(arr('int\\[\\] protoIndices') === 40 && arr('point3f\\[\\] positions') === 40 && arr('quath\\[\\] orientations') === 40 && arr('float3\\[\\] scales') === 40, `usda: protoIndices/positions/orientations/scales have 40 entries (${arr('int\\[\\] protoIndices')}, ${arr('point3f\\[\\] positions')}, ${arr('quath\\[\\] orientations')}, ${arr('float3\\[\\] scales')})`);
  check(/def Mesh "grid|def Mesh "mesh/.test(usd) && /def Scope "prototypes"/.test(usd) && /def Mesh/.test(usd.slice(usd.indexOf('def Scope "prototypes"'))), 'usda: the grid stays a Mesh, the source is a Mesh under prototypes');
  const usdExp = new TextDecoder().decode(exportGeometry(g, 'usda', { instancing: 'expand' }));
  check(!/PointInstancer/.test(usdExp), 'usda instancing:"expand" writes no PointInstancer');
  // formats without instancing expand, once, with a warning
  const ow: string[] = [];
  const obj = exportOBJ(g, { warn: (m) => ow.push(m) });
  check(obj === exportOBJ(unpacked(g, 'name Cd material piece')) && ow.length === 1 && /expanded/.test(ow[0]), 'obj expands the instances (same text as the unpacked geometry) and warns once');
  // (csv / points.json write instance rows and geo writes PackedGeometry by default: see test/interop.ts)
  for (const [fmt, opt] of [['stl', {}], ['ply', {}], ['csv', { instances: 'expand' }], ['pointsjson', { instances: 'expand' }]] as const) {
    const w: string[] = [];
    const a = exportGeometry(g, fmt, { ...opt, warn: (m) => w.push(m) }), b = exportGeometry(unpacked(g, 'name Cd material piece'), fmt);
    check(eq(Array.from(a), Array.from(b)) && w.length === 1, `${fmt}${Object.keys(opt).length ? ' instances:"expand"' : ''} expands the instances (same bytes as unpacked) with one warning`);
  }
  {
    const w: string[] = [];
    const a = exportGeometry(g, 'geo', { instancing: 'expand', warn: (m) => w.push(m) }), b = exportGeometry(unpacked(g, 'name Cd material piece'), 'geo');
    check(eq(Array.from(a), Array.from(b)) && w.length === 0, 'geo instancing:"expand" writes the expanded geometry (same bytes as unpacked)');
  }
  // GLB written elsewhere (one node, translation-only instances, node transform): packed on import, through the file node too
  const path = `${tmp}/inst.glb`;
  (await import('node:fs')).writeFileSync(path, await exportGeometryAsync(await cook(nodes, 'inst'), 'glb'));
  const viaFile = await cook({ f: { type: 'file', params: { path } } }, 'f');
  const viaFileExp = await cook({ f: { type: 'file', params: { path, instancing: 'expand' } } }, 'f');
  check(viaFile.numPacked === 40 && !viaFileExp.hasPacked() && viaFileExp.numPrims === 40 * tris(await cook(nodes, 'srcc')), 'file node: glb instances packed by default, expanded with instancing:"expand"');
}

// ---------------------------------------------------------------- render hook, inspect
{
  const nodes: Record<string, NodeSpec> = {
    s: { type: 'sphere', params: { type: 'ico', level: 3, radius: 0.3 } },
    pts: { type: 'point_grid', params: { counts: [30, 1, 30], size: [20, 0, 20] } },
    c: { type: 'color', in: ['pts'], params: { mode: 'random' } },
    inst: { type: 'copy_to_points', in: ['s', 'c'], params: { pack: true } },
  };
  const g = await cook(nodes, 'inst');
  const t0 = performance.now();
  const img = renderGeometry(g, { size: 256 });
  const ms = performance.now() - t0;
  check(img.width > 0 && img.rgba.some((v, i) => i % 4 === 1 && v > 120), `render of ${g.numPacked} instances (${packedInfo(g)!.triangles} triangles) gives an image in ${ms.toFixed(0)} ms (${img.notes[0]})`);
  const small = expandForRender(g, { title: 'x' }, 50_000);
  check(small.notes.some((n) => /rendering \d+ of 900 instances/.test(n)) && /of 900 instances/.test(small.opts.title ?? ''), `over the triangle budget a subset is drawn, with a note and a title (${small.notes[1]})`);
  check(small.geo.points.has('Cd') || small.geo.vertices.has('Cd'), 'render expansion carries the anchor colour onto instances without their own');
  const hl = new Uint8Array(g.numPrims);
  hl[5] = 1;
  const hx = expandForRender(g, { highlight: { cls: 'prim', mask: hl } }, 2e6);
  const hm = hx.opts.highlight!.mask;
  check(hm.length === hx.geo.numPrims && hm.reduce((a, b) => a + b, 0) === 1280, 'a prim highlight on an instance maps onto its expanded prims');
  const sum = summarize(g);
  check(/packed: 900 instances of 1 source \(1,152,000 triangles expanded\)/.test(sum) && /= 900 packed/.test(sum), `inspect summary reports the instances (${sum.split('\n')[1]})`);
}

// ---------------------------------------------------------------- every node type fed packed prims
{
  const bad: string[] = [];
  let n = 0, warnedOk = 0, keptOk = 0;
  for (const def of allNodeDefs()) {
    if (SKIP.has(def.type)) continue;
    const graph: GraphSpec = fixtureGraphFor(def.type);
    const target = graph.nodes.target;
    const ins = Array.isArray(target.in) ? (target.in as string[]) : [];
    if (!ins.length) continue;
    // the first input packed (pack by connectivity keeps everything else as it was)
    graph.nodes.__packed = { type: 'pack', in: [ins[0]] };
    target.in = ['__packed', ...ins.slice(1)];
    n++;
    try {
      const r = await engine.cook(graph);
      const params = { ...Object.fromEntries(Object.entries(def.params).map(([k, pd]) => [k, pd.default])), ...(target.params ?? {}) };
      const policy = typeof def.packed === 'function' ? def.packed(params) : def.packed ?? 'unpack';
      const tr = r.results.get('target');
      if (!tr) { bad.push(`${def.type}: no result`); continue; }
      if (tr.error) {
        // a node error is fine when it is a reported one (e.g. a keep node looking for an attribute that lives inside
        // the instances), not an internal failure
        if (/TypeError|RangeError|Cannot read|is not a function|of undefined|of null/.test(tr.error.message)) bad.push(`${def.type}: internal error on packed input: ${tr.error.message}`);
        else console.log(`   (${def.type} on packed input: ${tr.error.message})`);
        continue;
      }
      const errs = checkGeo(tr.geo!);
      if (errs.length) bad.push(`${def.type}: ${errs.join(', ')}`);
      const warned = tr.warnings.some((w) => /^unpacked \d+ instances/.test(w));
      if (policy === 'unpack') { if (warned || !(r.results.get('__packed')!.geo!.hasPacked())) warnedOk++; else bad.push(`${def.type}: unpack node without the warning`); }
      else { if (!warned) keptOk++; else bad.push(`${def.type}: keep node warned`); }
    } catch (e: any) {
      bad.push(`${def.type}: threw ${e?.stack ?? e}`);
    }
  }
  for (const b of bad) console.log('   ' + b);
  check(!bad.length, `every node type with packed input: ${n} types cooked, ${keptOk} kept instances, ${warnedOk} unpacked with a warning`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
