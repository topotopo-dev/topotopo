// Array attribute tests (float[], int[], string[]): storage, clone/gather/subset/merge, GeoBuilder
// propagation, wrangle syntax and helpers, the attrib_array node, attribute nodes carrying arrays,
// JSON round trip, inspect output, fingerprints, exporters, and every node type fed array attributes.
//   node test/arrays.ts
import '../src/nodes/index.ts';
import { Attribute, AttribTable, Geometry, GeoBuilder } from '../src/core/geometry.ts';
import { allNodeDefs } from '../src/graph/registry.ts';
import { geoFromJSON, geoToJSON } from '../src/io/json.ts';
import { exportGeometryAsync } from '../src/io/export.ts';
import { summarize, inspect } from '../src/inspect.ts';
import { renderGeometry } from '../src/render/raster.ts';
import { fingerprint } from './fingerprint.ts';
import { SKIP, checkGeo, createFixtureEngine, fixtureGraphFor } from './fixtures.ts';
import type { NodeSpec } from '../src/graph/types.ts';

const { engine } = await createFixtureEngine();

let fail = 0, pass = 0;
const check = (ok: any, msg: string) => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
};
const throws = (f: () => any, re?: RegExp) => { try { f(); return false; } catch (e: any) { return re ? re.test(String(e?.message)) : true; } };
const eq = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);
const all = (a: Attribute) => Array.from({ length: a.count }, (_, i) => a.getArray(i));

async function cook(nodes: Record<string, NodeSpec>, output?: string): Promise<Geometry> {
  const r = await engine.cook({ nodes, output });
  if (!r.ok || !r.geo) throw new Error(`cook failed: ${r.errors.map((e) => `[${e.node}] ${e.message}`).join('; ')}`);
  return r.geo;
}
async function cookErr(nodes: Record<string, NodeSpec>, output?: string): Promise<string> {
  const r = await engine.cook({ nodes, output });
  return r.ok ? '' : r.errors.map((e) => e.message + (e.hint ? ' | ' + e.hint : '')).join('; ');
}

/** Wrangle code adding arrays of every kind and class (point lengths vary with ptnum). */
const ADD_ARRAYS = [
  'i[]@nbrs = neighbours(0, @ptnum);',
  'f[]@w = []; for (let k = 0; k < @ptnum % 4; k++) @w.push(k * 0.5 + @ptnum);',
  's[]@tags = @ptnum % 3 ? ["a", "p" + @ptnum] : [];',
].join('\n');
const WITH_ARRAYS = (input: string): Record<string, NodeSpec> => ({
  [input + '_pa']: { type: 'wrangle', in: [input], params: { code: ADD_ARRAYS } },
  [input + '_pr']: { type: 'wrangle', in: [input + '_pa'], params: { run_over: 'prims', code: 'i[]@pp = primpoints(0, @primnum); s[]@names = ["prim" + @primnum];' } },
  [input + '_vx']: { type: 'wrangle', in: [input + '_pr'], params: { run_over: 'vertices', code: 'f[]@vv = [@vtxnum, @ptnum];' } },
  [input + '_arr']: { type: 'wrangle', in: [input + '_vx'], params: { run_over: 'detail', code: 'f[]@hist = [1, 2, 3];' } },
});

// ---------------------------------------------------------------- core storage
{
  const a = Attribute.create('float[]', 1, 4);
  check(a.isArray && a.count === 4 && a.size === 1 && eq(a.get(2), []) && eq(a.def, []), 'create: empty arrays, size 1, default []');
  a.set(0, [1, 2, 3]); a.set(1, 7); a.set(2, null as any); a.set(3, new Float64Array([4.5, 5.5]) as any);
  check(eq(all(a), [[1, 2, 3], [7], [], [4.5, 5.5]]), 'set: arrays, scalar = one entry, null = empty, typed arrays');
  a.set(0, [9]); a.set(2, [1, 1, 1, 1, 1]); a.set(1, []);
  check(eq(all(a), [[9], [], [1, 1, 1, 1, 1], [4.5, 5.5]]) && a.arrayLength(2) === 5, 'set: lengths change in place (loose layout)');
  a.compact();
  check(eq(Array.from(a.offsets!), [0, 1, 1, 6, 8]) && a.data.length === 8 && eq(Array.from(a.data as Float64Array), [9, 1, 1, 1, 1, 1, 4.5, 5.5]), 'compact: canonical CSR');
  const ia = Attribute.create('int[]', 1, 2);
  ia.set(0, [1.9, -2.7, '3' as any]);
  check(eq(ia.get(0), [1, -2, 3]), 'int[]: entries truncated to integers');
  const sa = Attribute.fromArrays('string[]', [['x', 'y'], [], [3 as any]]);
  check(eq(all(sa), [['x', 'y'], [], ['3']]) && sa.type === 'string[]', 'fromArrays string[]: entries stringified');
  const c = sa.clone();
  c.set(0, ['changed']);
  check(eq(sa.get(0), ['x', 'y']) && eq(c.get(0), ['changed']), 'clone is independent');
  const gth = sa.gather([2, -1, 0, 0]);
  check(eq(all(gth), [['3'], [], ['x', 'y'], ['x', 'y']]), 'gather: index -1 = empty array');
  const r = sa.getArray(0, ['stale', 'entries', 'here']);
  check(eq(r, ['x', 'y']), 'getArray(i, out) fills the given array');
  check(throws(() => new Attribute('int[]', 1, new Int32Array(0))), 'constructor: array type without offsets throws');
  check(a.bytes() > 0 && sa.bytes() > 0, 'bytes() for cache accounting');

  // amortised growth: 200k elements written in order with varying lengths, then rewritten in reverse
  const n = 200000, big = Attribute.create('int[]', 1, n);
  const t0 = performance.now();
  for (let i = 0; i < n; i++) big.set(i, i % 3 === 0 ? [] : i % 3 === 1 ? [i] : [i, i + 1, i + 2]);
  for (let i = n - 1; i >= 0; i -= 7) big.set(i, [i, -i]);
  big.compact();
  const ms = performance.now() - t0;
  let ok = true;
  for (let i = 0; i < n && ok; i++) {
    const want = (n - 1 - i) % 7 === 0 ? [i, -i] : i % 3 === 0 ? [] : i % 3 === 1 ? [i] : [i, i + 1, i + 2];
    if (!eq(big.get(i), want)) ok = false;
  }
  check(ok && ms < 3000, `amortised set: 200k varying-length writes + 29k rewrites in ${ms.toFixed(0)} ms`);
  const strs = Attribute.create('string[]', 1, n);
  const t1 = performance.now();
  for (let i = 0; i < n; i++) strs.set(i, i % 2 ? ['a' + i, 'b'] : []);
  for (let i = 0; i < n; i += 5) strs.set(i, ['x', 'y', 'z']);
  const ms2 = performance.now() - t1;
  const sOk = eq(strs.get(1), ['a1', 'b']) && eq(strs.get(5), ['x', 'y', 'z']) && eq(strs.get(2), []) && eq(strs.clone().get(n - 1), ['a' + (n - 1), 'b']);
  check(sOk && ms2 < 3000, `amortised set: 200k string[] writes + 40k rewrites in ${ms2.toFixed(0)} ms`);
}

// ---------------------------------------------------------------- tables, add conversions
{
  const t = new AttribTable(3);
  const a = t.add('x', 'int[]');
  a.set(0, [1, 2]); a.set(2, [3]);
  check(t.add('x', 'int[]') === a, 'add: same array type returns the existing attribute');
  const f = t.add('x', 'float[]');
  check(f.type === 'float[]' && eq(all(f), [[1, 2], [], [3]]), 'add: int[] → float[] converts entries');
  const tup = t.add('v', 'float', 3); tup.set(1, [1, 2, 3]);
  const va = t.add('v', 'float[]');
  check(eq(all(va), [[0, 0, 0], [1, 2, 3], [0, 0, 0]]), 'add: float tuple → float[] keeps the components');
  const s = t.add('v', 'string');
  check(s.type === 'string' && s.get(1) === '1,2,3', 'add: array → string joins with commas');
  check(t.add('q', 'float[]', 3).size === 1, 'add: array types always have size 1');
}

// ---------------------------------------------------------------- subset, merge
{
  const g = new Geometry({ positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 2, 0, 0], prims: [[0, 1, 2, 3], [1, 4, 2]] });
  g.points.set('nb', Attribute.fromArrays('int[]', [[1, 3], [0, 2, 4], [1, 3, 4], [0, 2], [1, 2]]));
  g.prims.set('tags', Attribute.fromArrays('string[]', [['quad'], ['tri', 'small']]));
  const sp = g.subsetPoints([1, 1, 1, 1, 0]);
  check(sp.numPrims === 1 && eq(all(sp.points.get('nb')!), [[1, 3], [0, 2, 4], [1, 3, 4], [0, 2]]) && eq(all(sp.prims.get('tags')!), [['quad']]), 'subsetPoints carries point and prim arrays');
  const spr = g.subsetPrims([0, 1]);
  check(spr.numPoints === 3 && eq(all(spr.points.get('nb')!), [[0, 2, 4], [1, 3, 4], [1, 2]]) && eq(all(spr.prims.get('tags')!), [['tri', 'small']]), 'subsetPrims carries arrays (unused points dropped)');

  const plain = new Geometry({ positions: [5, 5, 5, 6, 5, 5] });
  const m = Geometry.merge([plain, g]);
  check(eq(all(m.points.get('nb')!), [[], [], [1, 3], [0, 2, 4], [1, 3, 4], [0, 2], [1, 2]]) && m.prims.get('tags')!.count === 2, 'merge: input without the array gets empty arrays');
  const other = new Geometry({ positions: [0, 0, 0] });
  other.points.set('nb', Attribute.fromArrays('float[]', [[0.5]]));
  const m2 = Geometry.merge([g, other]);
  check(m2.points.get('nb')!.type === 'float[]' && eq(m2.points.get('nb')!.get(5), [0.5]) && eq(m2.points.get('nb')!.get(0), [1, 3]), 'merge: int[] + float[] → float[]');
  const fixed = new Geometry({ positions: [0, 0, 0] });
  fixed.points.add('nb', 'string').set(0, 'hello');
  const m3 = Geometry.merge([g, fixed]);
  check(m3.points.get('nb')!.type === 'string[]' && eq(m3.points.get('nb')!.get(5), ['hello']) && eq(m3.points.get('nb')!.get(1), ['0', '2', '4']), 'merge: array + fixed string → string[] (fixed value becomes one entry)');
  const det = Geometry.merge([plain, g]);
  check(!det.detail.has('nb'), 'merge: unrelated detail untouched');
}

// ---------------------------------------------------------------- GeoBuilder rules
{
  const src = new Geometry({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], prims: [[0, 1, 2]] });
  src.points.set('a', Attribute.fromArrays('int[]', [[10], [20, 21], []]));
  src.prims.set('pa', Attribute.fromArrays('string[]', [['face']]));
  const b = new GeoBuilder(src);
  b.copyPoint(1);
  b.blendPoint([0, 1], [0.3, 0.7]);
  b.blendPoint([0, 1], [0.5, 0.5]);
  b.addPoint(9, 9, 9);
  b.addPrim([0, 1, 2], true, 0);
  b.addPrim([1, 2, 3], true, -1);
  b.attrib('point', 'made', 1, 'float[]').set(3, [1, 2]);
  const out = b.build();
  check(eq(all(out.points.get('a')!), [[20, 21], [20, 21], [10], []]), 'builder: single source copies, blend takes heaviest (first on ties), no source = []');
  check(eq(all(out.prims.get('pa')!), [['face'], []]), 'builder: prim arrays follow prim provenance');
  check(eq(all(out.points.get('made')!), [[], [], [], [1, 2]]) && out.points.get('made')!.type === 'float[]', 'builder: attrib() with an array type');
}

// ---------------------------------------------------------------- arrays through nodes using GeoBuilder
{
  const ext = await cook({ b: { type: 'box' }, ...WITH_ARRAYS('b'), x: { type: 'poly_extrude', in: ['b_arr'], params: { distance: 0.2 } } }, 'x');
  const base = await cook({ b: { type: 'box' }, ...WITH_ARRAYS('b') }, 'b_arr');
  const srcPP = new Set(all(base.prims.get('pp')!).map((v) => JSON.stringify(v)));
  check(ext.prims.get('pp')!.count === ext.numPrims && all(ext.prims.get('pp')!).every((v) => srcPP.has(JSON.stringify(v))), 'poly_extrude: prim arrays copied from source prims');
  check(checkGeo(ext).length === 0 && ext.detail.get('hist') && eq(ext.detail.get('hist')!.get(0), [1, 2, 3]), 'poly_extrude: invariants, detail array kept');
  const sub = await cook({ b: { type: 'box' }, ...WITH_ARRAYS('b'), s: { type: 'subdivide', in: ['b_arr'], params: { levels: 1 } } }, 's');
  const srcW = new Set(all(base.points.get('w')!).map((v) => JSON.stringify(v)));
  check(sub.points.get('w')!.count === sub.numPoints && all(sub.points.get('w')!).every((v) => srcW.has(JSON.stringify(v))), 'subdivide: every new point carries one source point\'s array');
  check(sub.vertices.get('vv')!.count === sub.numVertices && sub.points.get('tags')!.type === 'string[]', 'subdivide: vertex and string arrays survive');
  const ctp = await cook({
    b: { type: 'box', params: { size: 0.1 } }, ...WITH_ARRAYS('b'),
    pts: { type: 'point_grid', params: { counts: [2, 1, 2] } },
    pa: { type: 'attrib_create', in: ['pts'], params: { name: 'ids', type: 'int[]', value: [7, 8] } },
    pw: { type: 'wrangle', in: ['pa'], params: { code: 'i[]@ids = append(@ids, @ptnum);' } },
    c: { type: 'copy_to_points', in: ['b_arr', 'pw'] },
  }, 'c');
  const ids = ctp.points.get('ids')!;
  check(eq(ids.get(0), [7, 8, 0]) && eq(ids.get(ctp.numPoints - 1), [7, 8, 3]), 'copy_to_points: template point arrays copied onto each copy');
  check(eq(all(ctp.points.get('nbrs')!).slice(0, 8), all(base.points.get('nbrs')!)) && ctp.prims.get('pp')!.count === ctp.numPrims, 'copy_to_points: source arrays repeated per copy');
}

// ---------------------------------------------------------------- wrangle
{
  const g = await cook({ g: { type: 'grid', params: { size: [3, 3], divisions: [3, 3] } }, ...WITH_ARRAYS('g') }, 'g_arr');
  const nb = g.points.get('nbrs')!;
  check(nb.type === 'int[]' && eq(nb.get(0), [1, 4]) && eq(nb.get(5), [1, 4, 6, 9]), 'wrangle i[]@ = neighbours(): point neighbour lists');
  check(g.points.get('w')!.type === 'float[]' && eq(g.points.get('w')!.get(3), [3, 3.5, 4]) && eq(g.points.get('w')!.get(4), []), 'wrangle f[]@: @arr.push() after a read persists');
  check(eq(g.points.get('tags')!.get(0), []) && eq(g.points.get('tags')!.get(1), ['a', 'p1']), 'wrangle s[]@');
  check(eq(g.prims.get('pp')!.get(0), g.primPoints(0)) && g.vertices.get('vv')!.type === 'float[]' && eq(g.detail.get('hist')!.get(0), [1, 2, 3]), 'wrangle arrays in prims, vertices and detail mode');

  const h = await cook({
    g: { type: 'grid', params: { size: [3, 3], divisions: [3, 3] } }, ...WITH_ARRAYS('g'),
    w: {
      type: 'wrangle', in: ['g_arr'], params: {
        code: [
          'i[]@near = nearpoints(0, @P, 1.01);',
          'i@n = len(@nbrs); i@nn = len(@near);',
          'f@s = sum(@w); f@a = avg(@w); f@lo = min(@w); f@hi = max(@w);',
          'i[]@srt = sort(reverse(@nbrs)); i[]@arg = argsort([3, 1, 2]);',
          'i[]@app = append(@nbrs, 99); i[]@cat = concat(@nbrs, [5, 5]); i[]@uq = unique(concat(@nbrs, @nbrs));',
          'i[]@sl = slice(@nbrs, 1, 3); i@f = find(@nbrs, 4); i@miss = find(@nbrs, -5);',
          'i@valid = isvalidindex(@nbrs, 1) ? 1 : 0; s[]@uv = uniquevals(["b", "a", "b"]);',
          'f@l3 = len([1, 2, 3]); f@ls = len("abcd"); f@vmin = min([3, 1, 2]); f@pair = min(2, 5);',
          '@nbrs = @nbrs.filter((x) => x % 2 == 0);',
        ].join('\n'),
      },
    },
  }, 'w');
  const P = (k: string, i: number) => h.points.get(k)!.get(i);
  check(P('n', 0) === 2 && P('nn', 5) === 5, 'helpers: len of arrays; nearpoints assigned to i[]@ (includes itself, like VEX)');
  check(P('s', 3) === 10.5 && P('a', 3) === 3.5 && P('lo', 3) === 3 && P('hi', 3) === 4 && P('s', 4) === 0 && P('a', 4) === 0, 'helpers: sum avg min max over arrays (empty → 0)');
  check(eq(P('srt', 5), [1, 4, 6, 9]) && eq(P('arg', 0), [1, 2, 0]), 'helpers: sort reverse argsort');
  check(eq(P('app', 0), [1, 4, 99]) && eq(P('cat', 0), [1, 4, 5, 5]) && eq(P('uq', 0), [1, 4]), 'helpers: append concat unique');
  check(eq(P('sl', 5), [4, 6]) && P('f', 0) === 1 && P('miss', 0) === -1 && P('valid', 0) === 1 && eq(P('uv', 0), ['a', 'b']), 'helpers: slice find isvalidindex uniquevals');
  check(P('l3', 0) === 3 && P('ls', 0) === 4 && P('vmin', 0) === 1 && P('pair', 0) === 2, 'helpers: len of vector/string, min of one array vs two values');
  check(eq(P('nbrs', 5), [4, 6]) && h.points.get('nbrs')!.type === 'int[]', 'plain @arr binds the existing array attribute; assignment replaces it');

  const v = await cook({
    g: { type: 'grid', params: { size: [3, 3], divisions: [3, 3] } }, ...WITH_ARRAYS('g'),
    vw: { type: 'wrangle', in: ['g_arr'], params: { run_over: 'vertices', code: 'i@cnt = len(@nbrs) + len(@pp);' } },
    two: { type: 'wrangle', in: ['vw', 'g_arr'], params: { code: 'f[]@w2 = @opinput1_w; i@k = len(point(1, "nbrs", @ptnum)); f@hl = len(detail(1, "hist"));\nsetpointattrib(0, "tags", @ptnum, ["set", "by", "fn"]);' } },
  }, 'two');
  check(v.vertices.get('cnt')!.get(0) === 2 + 4, 'vertex wrangle reads point and prim arrays');
  check(eq(v.points.get('w2')!.get(3), [3, 3.5, 4]) && v.points.get('k')!.get(5) === 4 && v.points.get('hl')!.get(0) === 3, 'opinput1_arr, point() and detail() return arrays');
  check(eq(v.points.get('tags')!.get(2), ['set', 'by', 'fn']), 'setpointattrib writes an existing array attribute');

  const sc = await cook({
    g: { type: 'grid', params: { divisions: [2, 2] } },
    s: {
      type: 'script', in: ['g'], params: {
        code: "const a = geo.points.add('ring', 'float[]');\nfor (let i = 0; i < geo.numPoints; i++) a.set(i, Array.from({ length: i % 3 }, (_, k) => k));\n" +
          "const n = geo.points.add('n', 'int');\nfor (let i = 0; i < geo.numPoints; i++) n.set(i, a.get(i).length + a.arrayLength(i));\nreturn geo;",
      },
    },
  }, 's');
  check(sc.points.get('ring')!.isArray && eq(sc.points.get('ring')!.get(2), [0, 1]) && sc.points.get('n')!.get(4) === 2, 'script: array attributes through the same Attribute API');
  const err = await cookErr({ g: { type: 'grid' }, w: { type: 'wrangle', in: ['g'], params: { code: 'v[]@pts = [];' } } }, 'w');
  check(/vector arrays are not supported/.test(err), 'v[]@ gives a clear error');
  const conv = await cook({ g: { type: 'grid', params: { divisions: [3, 3] } }, ...WITH_ARRAYS('g'), w: { type: 'wrangle', in: ['g_arr'], params: { code: 'f[]@nbrs = append(@nbrs, 0.5);' } } }, 'w');
  check(conv.points.get('nbrs')!.type === 'float[]' && eq(conv.points.get('nbrs')!.get(0), [1, 4, 0.5]), 'f[]@ on an existing int[] converts it to float[]');
  const sp = await cook({ g: { type: 'grid', params: { divisions: [2, 2] } }, w: { type: 'wrangle', in: ['g'], params: { code: 'setpointattrib(0, "foo", @ptnum, @ptnum * 2); setdetailattrib(0, "total", 7);' } } }, 'w');
  check(sp.points.get('foo')?.get(4) === 8 && sp.detail.get('total')?.get(0) === 7 && !sp.points.has('0' as any), 'setpointattrib / setdetailattrib argument order (was creating attributes named by the element number)');
  const r = await engine.cook({ nodes: { g: { type: 'grid' }, w: { type: 'wrangle', in: ['g'], params: { code: '@x = @ptnum % 2 ? [1, 2] : [1];' } } }, output: 'w' });
  check(r.ok && r.warnings.some((w) => /declare it f\[\]@x/.test(w.message)), 'untyped @x assigned arrays of different lengths: warning suggests f[]@');
}

// ---------------------------------------------------------------- attrib_array node
{
  const grid = { g: { type: 'grid', params: { size: [3, 3], divisions: [3, 3] } } } as Record<string, NodeSpec>;
  const c = await cook({ ...grid, a: { type: 'attrib_array', in: ['g'] } }, 'a');
  const nb = c.points.get('nbrs')!;
  check(nb.type === 'int[]' && eq(nb.get(0), [1, 4]) && eq(nb.get(5), [1, 4, 6, 9]), 'from_neighbours connectivity: sorted edge neighbours');
  const rr = await cook({ ...grid, a: { type: 'attrib_array', in: ['g'], params: { method: 'radius', radius: 1.5, max_count: 3, name: 'near' } } }, 'a');
  const near5 = rr.points.get('near')!.getArray(5) as number[];
  check(near5.length === 3 && near5.every((j) => [1, 4, 6, 9].includes(j)), 'from_neighbours radius: nearest first (distance 1 before the diagonals), max_count, self excluded');
  const rs = await cook({ ...grid, a: { type: 'attrib_array', in: ['g'], params: { method: 'radius', radius: 0.5, include_self: true } } }, 'a');
  check(eq(rs.points.get('nbrs')!.get(7), [7]), 'from_neighbours radius: include_self');
  const gp = await cook({ ...grid, a: { type: 'attrib_array', in: ['g'], params: { mode: 'from_group_points', group: '0-3' } } }, 'a');
  check(eq(gp.prims.get('pts')!.get(2), gp.primPoints(2)) && eq(gp.prims.get('pts')!.get(5), []), 'from_group_points: prim point lists, group limits');
  const pk = await cook({
    ...grid,
    w: { type: 'wrangle', in: ['g'], params: { code: 'f@w_10 = 10; f@w_2 = 2; f@w_1 = 1; i@k = @ptnum;' } },
    a: { type: 'attrib_array', in: ['w'], params: { mode: 'from_attributes', attribs: 'w_* k P', name: 'packed', delete_source: true } },
  }, 'a');
  check(eq(pk.points.get('packed')!.get(1), [1, 2, 10, 1, ...(pk.points.get('P')!.get(1) as number[])]) && pk.points.get('packed')!.type === 'float[]' && !pk.points.has('w_1') && !pk.points.has('k') && pk.points.has('P'), 'from_attributes: natural wildcard order, tuples expanded, sources deleted (never P)');
  const un = await cook({
    ...grid,
    a: { type: 'attrib_array', in: ['g'] },
    u: { type: 'attrib_array', in: ['a'], params: { mode: 'to_attributes', name: 'nbrs', delete_source: true } },
    l: { type: 'attrib_array', in: ['a'], params: { mode: 'length', name: 'nbrs' } },
    m: { type: 'merge', in: ['u', 'l'] },
  }, 'm');
  check(un.points.get('nbrs_3')!.get(5) === 9 && un.points.get('nbrs_3')!.get(0) === 0 && un.points.get('nbrs_0')!.type === 'int', 'to_attributes: name_0..name_k, shorter arrays keep defaults');
  check(un.points.get('nbrs_len')!.get(16 + 5) === 4 && un.points.get('nbrs_len')!.get(16) === 2, 'length: int attribute with the array length');
  const e1 = await cookErr({ ...grid, a: { type: 'attrib_array', in: ['g'], params: { mode: 'length', name: 'P' } } }, 'a');
  const e2 = await cookErr({ ...grid, a: { type: 'attrib_array', in: ['g'], params: { mode: 'to_attributes' } } }, 'a');
  check(/not an array/.test(e1) && /needs "name"/.test(e2), 'attrib_array: clear errors for a non-array or missing name');
}

// ---------------------------------------------------------------- attribute nodes and other nodes carrying arrays
{
  const base: Record<string, NodeSpec> = { b: { type: 'box', params: { divisions: [2, 2, 2] } }, ...WITH_ARRAYS('b') };
  const ac = await cook({ b: { type: 'box' }, t: { type: 'attrib_create', in: ['b'], params: { name: 'x', value: [1, 2, 3] } }, a: { type: 'attrib_create', in: ['t'], params: { name: 'y', value: [1, 2, 3], type: 'float[]' } }, s: { type: 'attrib_create', in: ['a'], params: { name: 'z', value: ['u', 'v'], class: 'prim' } } }, 's');
  check(ac.points.get('x')!.type === 'float' && ac.points.get('x')!.size === 3 && ac.points.get('y')!.type === 'float[]' && eq(ac.points.get('y')!.get(4), [1, 2, 3]), 'attrib_create: [1,2,3] is a tuple, with type float[] an array');
  check(ac.prims.get('z')!.type === 'string[]' && eq(ac.prims.get('z')!.get(0), ['u', 'v']), 'attrib_create: a list of strings becomes string[]');
  const pv = await cook({ ...base, p: { type: 'attrib_promote', in: ['b_arr'], params: { name: 'w', from: 'point', to: 'vertex' } } }, 'p');
  const srcG = await cook(base, 'b_arr');
  const pw = pv.vertices.get('w')!;
  const perVertex = Array.from({ length: pv.numVertices }, (_, v) => eq(pw.get(v), srcG.points.get('w')!.get(pv.vertexPoint[v])));
  check(pw.type === 'float[]' && !pv.points.has('w') && perVertex.every(Boolean), 'attrib_promote point → vertex copies arrays');
  const pf = await cook({ ...base, p: { type: 'attrib_promote', in: ['b_arr'], params: { name: 'pp', from: 'prim', to: 'point', method: 'last', keep_original: true } } }, 'p');
  check(pf.points.get('pp')!.type === 'int[]' && pf.points.get('pp')!.count === pf.numPoints && pf.prims.has('pp'), 'attrib_promote prim → point with method last');
  const pe = await cookErr({ ...base, p: { type: 'attrib_promote', in: ['b_arr'], params: { name: 'nbrs', from: 'point', to: 'prim' } } }, 'p');
  check(/array attribute.*first or last/.test(pe), 'attrib_promote: averaging an array is a clear error');
  const cp = await cook({ ...base, e: { type: 'box', params: { divisions: [2, 2, 2] } }, c: { type: 'attrib_copy', in: ['e', 'b_arr'], params: { names: 'nbrs tags' } } }, 'c');
  check(eq(all(cp.points.get('nbrs')!), all(srcG.points.get('nbrs')!)) && eq(all(cp.points.get('tags')!), all(srcG.points.get('tags')!)), 'attrib_copy copies arrays by index');
  const tr = await cook({ ...base, e: { type: 'box', params: { divisions: [2, 2, 2] } }, t: { type: 'attrib_transfer', in: ['e', 'b_arr'], params: { names: 'nbrs w' } }, s: { type: 'attrib_transfer', in: ['e', 'b_arr'], params: { names: 'tags', method: 'surface' } }, m: { type: 'merge', in: ['t', 's'] } }, 'm');
  check(eq(tr.points.get('nbrs')!.get(3), srcG.points.get('nbrs')!.get(3)) && tr.points.get('tags')!.type === 'string[]', 'attrib_transfer nearest_point and surface copy arrays');
  const dr = await cook({ ...base, d: { type: 'attrib_delete', in: ['b_arr'], params: { names: 'w tag*' } }, r: { type: 'attrib_rename', in: ['d'], params: { from: 'nbrs', to: 'adj' } } }, 'r');
  check(!dr.points.has('w') && !dr.points.has('tags') && dr.points.get('adj')!.type === 'int[]', 'attrib_delete and attrib_rename on arrays');
  const so = await cook({ ...base, s: { type: 'sort', in: ['b_arr'], params: { by: 'reverse' } } }, 's');
  check(eq(so.points.get('w')!.get(0), srcG.points.get('w')!.get(srcG.numPoints - 1)), 'sort reorders arrays with their points');
  const sa = await cook({ ...base, s: { type: 'sort', in: ['b_arr'], params: { by: 'attribute', attrib: 'w' } } }, 's');
  check(checkGeo(sa).length === 0, 'sort by an array attribute does not crash');
  const fu = await cook({ ...base, f: { type: 'facet', in: ['b_arr'] }, u: { type: 'fuse', in: ['f'], params: { distance: 0.001 } } }, 'u');
  check(fu.numPoints === srcG.numPoints && fu.points.get('nbrs')!.count === fu.numPoints, 'fuse keeps arrays (first wins)');
  const xf = await cook({ ...base, t: { type: 'transform', in: ['b_arr'], params: { translate: [1, 2, 3], rotate: [0, 45, 0] } } }, 't');
  check(eq(all(xf.points.get('w')!), all(srcG.points.get('w')!)), 'transform leaves arrays untouched');
  const dl = await cook({ ...base, d: { type: 'delete', in: ['b_arr'], params: { group: '@P.y>0', class: 'point' } } }, 'd');
  check(checkGeo(dl).length === 0 && dl.points.get('nbrs')!.count === dl.numPoints, 'delete carries arrays');
}

// ---------------------------------------------------------------- JSON, inspect, fingerprints, exporters
{
  const g = await cook({ b: { type: 'box', params: { divisions: [2, 2, 2] } }, ...WITH_ARRAYS('b') }, 'b_arr');
  const back = geoFromJSON(JSON.parse(JSON.stringify(geoToJSON(g))));
  let same = true;
  for (const cls of ['point', 'vertex', 'prim', 'detail'] as const)
    for (const [k, a] of g.table(cls).map) {
      const b = back.table(cls).get(k);
      if (!b || b.type !== a.type || b.isArray !== a.isArray || !eq(all(a), all(b))) { same = false; console.log(`  mismatch ${cls}.${k}`); }
    }
  check(same && eq(fingerprint(g), fingerprint(back)), 'JSON round trip of point/prim/vertex/detail arrays is lossless');
  const j = geoToJSON(g) as any;
  j.points.attribs.nbrs.offsets[1] = 999;
  check(throws(() => geoFromJSON(j), /offsets/), 'JSON: inconsistent offsets are rejected');

  const s = summarize(g);
  check(/nbrs int\[\] \(len 3–\d+, avg [\d.]+\)/.test(s) && /tags string\[\] \(len 0–2/.test(s) && /hist float\[\] = \[1\.00, 2\.00, 3\.00\]/.test(s), 'summary shows "name int[] (len a–b, avg x)" and detail arrays');
  const ins = inspect(g, { detail: 'all', cls: 'point', count: 3 });
  check(/point nbrs int\[\]: len 3–\d+, avg [\d.]+; entries min 0 max/.test(ins) && /tags=\[\]/.test(ins) && /nbrs=\[/.test(ins), 'inspect: array stats and element listing');

  const fp = (lists: any[][]) => {
    const x = new Geometry({ positions: [0, 0, 0, 1, 0, 0] });
    x.points.set('a', Attribute.fromArrays('int[]', lists));
    return JSON.stringify(fingerprint(x));
  };
  check(fp([[1], [2, 3]]) !== fp([[1, 2], [3]]) && fp([[1], [2, 3]]) !== fp([[1], [2, 4]]) && fp([[1], [2, 3]]) === fp([[1], [2, 3]]), 'fingerprints: array content and split both matter');
  const t = (lists: any[][]) => { const x = new Geometry({ positions: [0, 0, 0, 1, 0, 0] }); const a = Attribute.create('float[]', 1, 2); lists.forEach((l, i) => a.set(i, l)); x.points.set('a', a); return JSON.stringify(fingerprint(x)); };
  check(t([[0.5], [2, 3]]) === JSON.stringify(fingerprint((() => { const x = new Geometry({ positions: [0, 0, 0, 1, 0, 0] }); x.points.set('a', Attribute.fromArrays('float[]', [[0.5], [2, 3]])); return x; })())), 'fingerprints: loose and compact layouts hash the same');

  const plain = await cook({ b: { type: 'box', params: { divisions: [2, 2, 2] } } }, 'b');
  let ok = true;
  for (const fmt of ['glb', 'obj', 'usda', 'ply', 'stl'] as const) for (const custom of [false, true]) {
    try {
      const a = await exportGeometryAsync(g, fmt, { custom }), b = await exportGeometryAsync(plain, fmt, { custom });
      if (fmt === 'ply' || fmt === 'glb' || fmt === 'stl') if (a.byteLength !== b.byteLength) { ok = false; console.log(`  ${fmt} custom=${custom}: ${a.byteLength} vs ${b.byteLength} bytes`); }
    } catch (e: any) { ok = false; console.log(`  ${fmt} custom=${custom} threw ${e.message}`); }
  }
  check(ok, 'exporters skip array attributes (glb/obj/usda/ply/stl, custom on and off)');
  let notes: string[] = [];
  try { for (const cb of ['nbrs', 'tags', 'w.x', 'hist']) notes = notes.concat(renderGeometry(g, { colorBy: cb, size: 96, views: ['persp'] } as any).notes); } catch (e: any) { notes = ['threw ' + e.message]; }
  check(notes.some((n) => /color by tags \[0\.00 \.\. 2\.00\]/.test(n)) && !notes.some((n) => /threw/.test(n)), 'render color_by an array attribute colours by its length');
}

// ---------------------------------------------------------------- every node type with array inputs
{
  const bad: string[] = [];
  let n = 0;
  for (const def of allNodeDefs()) {
    if (SKIP.has(def.type)) continue;
    const graph = fixtureGraphFor(def.type);
    const target = graph.nodes.target;
    const ins = Array.isArray(target.in) ? (target.in as string[]) : [];
    if (!ins.length) continue;
    // feed array-carrying versions of the fixture inputs
    target.in = ins.map((k) => {
      Object.assign(graph.nodes, WITH_ARRAYS(k));
      return k + '_arr';
    });
    n++;
    try {
      const r = await engine.cook(graph);
      if (!r.ok || !r.geo) { bad.push(`${def.type}: ${r.errors.map((e) => e.message).join('; ').slice(0, 160)}`); continue; }
      const errs = checkGeo(r.geo);
      for (const cls of ['point', 'vertex', 'prim', 'detail'] as const)
        for (const [k, a] of r.geo.table(cls).map) if (a.isArray) {
          a.compact();
          const o = a.offsets!;
          if (o[0] !== 0 || o[o.length - 1] !== a.data.length) errs.push(`${cls}.${k} offsets`);
        }
      if (errs.length) bad.push(`${def.type}: ${errs.join(', ')}`);
    } catch (e: any) {
      bad.push(`${def.type}: threw ${e?.message ?? e}`);
    }
  }
  for (const b of bad) console.log('  ' + b);
  check(!bad.length, `all ${n} node types with inputs cook with array attributes on their inputs`);
}

console.log(`\narrays: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
