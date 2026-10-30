// Cook scopes (src/graph/scope.ts): a cook in a scope of its own resolves that scope's assets, graph_ref graphs and
// relative file paths, also in its nested cooks (assets, foreach and solver bodies, lib.run); the root scope is
// unaffected; and the shared cache never hands one scope a result of another, while built-in nodes with the same
// params and inputs share theirs. The fixtures sit in a temp folder: the host's own (the root scope's) and the folders
// of scopes a and b, with the same file names in each.
//   node test/scopes.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import type { CookOptions, CookReport } from '../src/graph/engine.ts';
import { defineNode } from '../src/graph/registry.ts';
import type { Scope } from '../src/graph/scope.ts';
import { NodeError } from '../src/graph/types.ts';
import type { GraphSpec } from '../src/graph/types.ts';
import { createNodeHost } from '../src/host/node.ts';
import { encodePNG } from '../src/render/png.ts';
import { fingerprint } from './fingerprint.ts';
import { ROOT } from './fixtures.ts';

let failures = 0, passes = 0;
const check = (cond: any, msg: string) => {
  if (cond) passes++;
  else failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`);
};
const section = (s: string) => console.log(`\n== ${s}`);

// ------------------------------------------------------------------ fixtures
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'topotopo-scopes-'));
const dirs = { root: tmp, a: path.join(tmp, 'a'), b: path.join(tmp, 'b') };
// one mtime for every fixture and files of one size: equal stamps (mtime and size) in all three folders
const when = new Date('2026-01-01T00:00:00Z');
const write = (file: string, data: string | Uint8Array) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  fs.utimesSync(file, when, when);
};
// mesh.obj: a triangle of width 1 (root), 2 (a) and 3 (b); img.png: a 2 × 2 grey image, darker to lighter
const triangle = (s: number) => `v 0 0 0\nv ${s} 0 0\nv 0 ${s} 0\nf 1 2 3\n`;
const grey = (v: number) => encodePNG(new Uint8Array(16).map((_, i) => (i % 4 === 3 ? 255 : v)), 2, 2, (d) => zlib.deflateSync(d, { level: 0 }));
for (const [k, s, v] of [['root', 1, 60], ['a', 2, 130], ['b', 3, 200]] as const) {
  write(path.join(dirs[k], 'mesh.obj'), triangle(s));
  write(path.join(dirs[k], 'img.png'), grey(v));
}
// a font only scope a has
fs.mkdirSync(path.join(dirs.a, 'fonts'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'assets', 'fonts', 'DejaVuSans.ttf'), path.join(dirs.a, 'fonts', 'scope.ttf'));

const host = createNodeHost({ baseDir: tmp });
const engine = new Engine(host);
await engine.init();

const graphsOf = (gs: Record<string, GraphSpec>) => (n: string) => gs[n];
const box = (s: number): GraphSpec => ({ nodes: { b: { type: 'box', params: { size: [s, s, s] } } }, output: 'b' });
const rootGraphs: Record<string, GraphSpec> = { g: box(1) };
// scope a by a folder relative to the host's own, scope b by an absolute one
const a = engine.createScope('test/a@1', { folder: 'a', graphs: graphsOf({ g: box(2), uses_part: { nodes: { p: { type: 'part' } }, output: 'p' } }) });
const b = engine.createScope('test/b@1', { folder: dirs.b, graphs: graphsOf({ g: box(3), uses_part: { nodes: { p: { type: 'part' } }, output: 'p' } }) });
const scopes: Record<string, Scope> = { a, b };

const cook = (g: GraphSpec, o: CookOptions = {}, e = engine): Promise<CookReport> => e.cook(g, o);
const res = (r: CookReport, n: string) => r.results.get(n)!;
const width = (r: CookReport) => (r.ok && r.geo ? +(r.geo.bbox().max[0] - r.geo.bbox().min[0]).toFixed(6) : NaN);
const fp = (r: CookReport) => (r.ok && r.geo ? JSON.stringify(fingerprint(r.geo)) : `failed: ${r.errors.map((e) => e.message).join('; ')}`);
const errorOf = (r: CookReport) => r.errors.map((e) => e.message).join('; ');

// test only: cooks its graph in the scope its param names (its result depends on that scope, not on its own: no
// usesScope), as a node that uses a nested cook in another scope does
defineNode({
  type: 'test_in_scope', category: 'flow', summary: 'test only: cooks a graph in scope a or b',
  inputs: [], params: { scope: { type: 'string', default: 'a', desc: 'a or b' }, graph: { type: 'json', default: {}, desc: 'the graph' } },
  async cook(ctx) {
    const r = await ctx.subcook(ctx.p.graph, { scope: scopes[ctx.p.scope] });
    if (!r.ok || !r.geo) throw new NodeError(errorOf(r));
    return r.geo;
  },
});

// a root graph cooked before any scoped cook, and again at the end; its asset is a root asset (scopes register their own
// of the same name below)
const sampleBox: GraphSpec = { nodes: { b: { type: 'box', params: { size: [0.4, 0.6, 0.8] } } }, output: 'b' };
engine.registerAsset('sample_box', sampleBox);
const rootSample: GraphSpec = {
  nodes: {
    f: { type: 'file', params: { path: 'mesh.obj' } },
    i: { type: 'image_file', params: { path: 'img.png' } },
    c: { type: 'sample_box' },
    m: { type: 'merge', in: ['f', 'i', 'c'] },
  },
  output: 'm',
};
const rootBefore = await cook(rootSample);
check(rootBefore.ok, `the root sample cooks: ${errorOf(rootBefore)}`);

// ------------------------------------------------------------------ scopes
section('creating scopes');
{
  let threw = '';
  try { engine.createScope(''); } catch (e: any) { threw = e.message; }
  check(/needs an id/.test(threw), `the empty id is the root's: ${threw}`);
  check(engine.root.id === '' && engine.root.files === host, 'the root scope reads the host\'s own files');
  check(a.files.resolvePath('mesh.obj') === path.join(dirs.a, 'mesh.obj') && b.files.resolvePath('mesh.obj') === path.join(dirs.b, 'mesh.obj'),
    'a scope\'s relative paths resolve against its folder (relative to the host\'s, or absolute)');
  check(a.files.resolvePath(path.join(dirs.b, 'x.obj')) === path.join(dirs.b, 'x.obj'), 'absolute paths stay as they are');
  const plain = new Engine({ ...host, filesAt: undefined });
  threw = '';
  try { plain.createScope('x', { folder: 'a' }); } catch (e: any) { threw = e.message; }
  check(/filesAt/.test(threw), `a host without filesAt cannot give a scope a folder: ${threw}`);
  check(plain.createScope('x').files === plain.host, 'a scope without a folder reads the host\'s files');
}

section('files: the same relative path reads the scope\'s own file');
{
  check(host.fileStamp('mesh.obj') === a.files.fileStamp('mesh.obj') && a.files.fileStamp('mesh.obj') === b.files.fileStamp('mesh.obj'),
    'the three mesh.obj files have the same stamp (mtime and size)');
  const g: GraphSpec = { nodes: { f: { type: 'file', params: { path: 'mesh.obj' } } } };
  const ra = await cook(g, { scope: a }), rb = await cook(g, { scope: b }), rr = await cook(g);
  check(width(rr) === 1 && width(ra) === 2 && width(rb) === 3, `file reads root, a and b's own mesh.obj (widths ${width(rr)}, ${width(ra)}, ${width(rb)})`);
  check(new Set([res(rr, 'f').sig, res(ra, 'f').sig, res(rb, 'f').sig]).size === 3, 'their results are cached apart');
  const again = await cook(g, { scope: a });
  check(res(again, 'f').cached && width(again) === 2, 'a cache hit in a is a\'s');
  for (const [type, params, input] of [
    ['image_file', {}, null],
    ['heightfield_from_image', { size: [2, 2] }, null],
    ['attribute_from_map', { projection: 'xz', size: [2, 2] }, 'box'],
  ] as const) {
    const at = (p: string): GraphSpec => ({
      nodes: { ...(input ? { src: { type: input } } : {}), n: { type, ...(input ? { in: ['src'] } : {}), params: { ...params, path: p } } },
      output: 'n',
    });
    const sa = await cook(at('img.png'), { scope: a }), sb = await cook(at('img.png'), { scope: b }), sr = await cook(at('img.png'));
    check(fp(sa) === fp(await cook(at(path.join(dirs.a, 'img.png')))) && fp(sb) === fp(await cook(at(path.join(dirs.b, 'img.png')))) && fp(sr) === fp(await cook(at(path.join(tmp, 'img.png')))),
      `${type} reads the scope's own img.png`);
    check(new Set([fp(sa), fp(sb), fp(sr)]).size === 3, `${type}: three different images`);
  }
  const font: GraphSpec = { nodes: { t: { type: 'text', params: { text: 'A', font: 'fonts/scope.ttf' } } } };
  const ta = await cook(font, { scope: a }), tb = await cook(font, { scope: b });
  check(ta.ok && !!ta.geo?.numPrims, `text reads a font in the scope's folder: ${errorOf(ta)}`);
  check(!tb.ok && /font "fonts\/scope\.ttf" not found/.test(errorOf(tb)), `another scope does not have it: ${errorOf(tb)}`);
}

section('assets: the scope\'s own, then built-in nodes');
{
  // part is a box of width 1 in the root, 2 in a and 3 in b; piece is the same graph in a and b and names part
  engine.registerAsset('part', box(1));
  engine.registerAsset('part', box(2), { scope: a });
  engine.registerAsset('part', box(3), { scope: b });
  const piece: GraphSpec = { nodes: { p: { type: 'part' }, t: { type: 'transform', in: ['p'], params: { translate: [0, 1, 0] } } }, output: 't' };
  engine.registerAsset('piece', piece, { scope: a });
  engine.registerAsset('piece', piece, { scope: b });
  const g: GraphSpec = { nodes: { x: { type: 'piece' } } };
  const ra = await cook(g, { scope: a }), rb = await cook(g, { scope: b });
  check(width(ra) === 2 && width(rb) === 3, `one asset graph in two scopes resolves each scope's part (widths ${width(ra)}, ${width(rb)})`);
  check(res(ra, 'x').sig !== res(rb, 'x').sig && !res(rb, 'x').cached, 'assets of the same name and graph in two scopes never share a cache entry');
  const rr = await cook(g);
  check(!rr.ok && /unknown node type "piece"/.test(errorOf(rr)), `a scope's assets are invisible to the root: ${errorOf(rr)}`);
  const pr = await cook({ nodes: { x: { type: 'part' } } });
  check(width(pr) === 1, 'the root resolves its own part');
  engine.registerAsset('root_only', box(5));
  const ro = await cook({ nodes: { x: { type: 'root_only' } } }, { scope: a });
  check(!ro.ok && /unknown node type "root_only"/.test(errorOf(ro)), `the root's assets are invisible to a scope: ${errorOf(ro)}`);
  check(engine.resolveDef('piece', a) === a.assets.get('piece')?.def && !engine.resolveDef('piece'), 'resolveDef resolves in the scope it is given (the root by default)');
  check(engine.allTypeNames(a).includes('piece') && !engine.allTypeNames().includes('piece') && !engine.allTypeNames(a).includes('root_only'), 'allTypeNames lists the scope\'s own assets');
  // built-in nodes: seen by both; a built-in node with the same params shares its cache entry
  const plainBox = { nodes: { x: { type: 'box', params: { size: [7, 7, 7] } } } };
  const br = await cook(plainBox), ba = await cook(plainBox, { scope: a }), bb = await cook(plainBox, { scope: b });
  check(res(ba, 'x').sig === res(br, 'x').sig && res(ba, 'x').cached && res(bb, 'x').cached, 'a built-in node with the same params is one cache entry in every scope');
  // an asset of the same name in two scopes: each sees its own, nothing else
  engine.registerAsset('sample_box', box(4), { scope: a });
  const sr = await cook({ nodes: { s: { type: 'sample_box' } } }), sa = await cook({ nodes: { s: { type: 'sample_box' } } }, { scope: a }), sb = await cook({ nodes: { s: { type: 'sample_box' } } }, { scope: b });
  check(width(sr) === 0.4 && width(sa) === 4 && !sb.ok, `a name resolves to the scope's own asset, and no other scope's (widths ${width(sr)}, ${width(sa)}; ${errorOf(sb)})`);
  check(engine.asset('sample_box')?.def === engine.resolveDef('sample_box') && engine.asset('sample_box', a)?.def === engine.resolveDef('sample_box', a) && !engine.asset('sample_box', b), 'asset() looks in the scope it is given');
  check(engine.assetsIn(a).some((x) => x.name === 'sample_box') && engine.assetsIn(a).some((x) => x.name === 'piece') && !engine.assetsIn(a).some((x) => x.name === 'root_only'), 'assetsIn lists a scope\'s own assets');
  // registering validates in the target scope
  engine.registerAsset('b_thing', box(1), { scope: b });
  let threw = '';
  try { engine.registerAsset('uses_b_thing', { nodes: { t: { type: 'b_thing' } }, output: 't' }); } catch (e: any) { threw = e.message; }
  check(/unknown node type "b_thing"/.test(threw), `an asset graph is validated in the scope it is registered into: ${threw}`);
  check(!!engine.registerAsset('uses_b_thing', { nodes: { t: { type: 'b_thing' } }, output: 't' }, { scope: b }), 'and registers where it validates');
}

section('graph_ref: the scope\'s own graphs');
{
  const ref = (graph: string): GraphSpec => ({ nodes: { r: { type: 'graph_ref', params: { graph } } } });
  const none = await cook(ref('g'));
  check(!none.ok && errorOf(none) === 'graph_ref needs a project (not available in this host)', `without a project: ${errorOf(none)}`);
  engine.root.graphs = graphsOf(rootGraphs);
  const rr = await cook(ref('g')), ra = await cook(ref('g'), { scope: a }), rb = await cook(ref('g'), { scope: b });
  check(width(rr) === 1 && width(ra) === 2 && width(rb) === 3, `graph_ref "g" reads root, a and b's own graph (widths ${width(rr)}, ${width(ra)}, ${width(rb)})`);
  check(new Set([res(rr, 'r').sig, res(ra, 'r').sig, res(rb, 'r').sig]).size === 3, 'their results are cached apart');
  const pa = await cook(ref('uses_part'), { scope: a }), pb = await cook(ref('uses_part'), { scope: b });
  check(width(pa) === 2 && width(pb) === 3, 'the same referenced graph resolves its node types in each scope');
  const missRoot = await cook(ref('nope')), missA = await cook(ref('nope'), { scope: a });
  check(errorOf(missRoot) === 'no graph named "nope" in the project', `the root names the project: ${errorOf(missRoot)}`);
  check(errorOf(missA) === 'no graph named "nope" in "test/a@1"', `a scope names itself: ${errorOf(missA)}`);
  const c = engine.createScope('test/c@1');
  const missC = await cook(ref('g'), { scope: c });
  check(errorOf(missC) === 'no graph named "g" in "test/c@1"', `a scope without graphs: ${errorOf(missC)}`);
}

section('nested cooks run in the scope: foreach and solver bodies, scripts');
{
  const loop: GraphSpec = { nodes: { f: { type: 'foreach', params: { mode: 'count', count: 2, body: { nodes: { p: { type: 'part' } }, output: 'p' } } } } };
  const la = await cook(loop, { scope: a }), lb = await cook(loop, { scope: b }), lr = await cook(loop);
  check(width(la) === 2 && width(lb) === 3 && width(lr) === 1, `a foreach body resolves in the scope (widths ${width(la)}, ${width(lb)}, ${width(lr)})`);
  // the solver caches each frame's state by its own chain of signatures: each scope's chain is its own
  const solve: GraphSpec = {
    nodes: {
      seed: { type: 'box', params: { size: [0.1, 0.1, 0.1] } },
      s: { type: 'solver', in: ['seed'], params: { body: { nodes: { prev: { type: 'input', params: { index: 0 } }, p: { type: 'part' }, m: { type: 'merge', in: ['prev', 'p'] } }, output: 'm' } } },
    },
    output: 's',
  };
  const sa = await cook(solve, { scope: a, frame: 3 }), sb = await cook(solve, { scope: b, frame: 3 }), sr = await cook(solve, { frame: 3 });
  check(width(sa) === 2 && width(sb) === 3 && width(sr) === 1, `a solver body resolves in the scope (widths ${width(sa)}, ${width(sb)}, ${width(sr)})`);
  check(res(sb, 's').stats?.resumed_from === 0 && res(sb, 's').stats?.body_runs === 3, 'a solver in another scope does not resume from the first scope\'s states');
  // lib.run resolves node types in the script's scope, and the nodes it runs read the scope's files
  const script = (code: string): GraphSpec => ({ nodes: { s: { type: 'script', params: { code } } } });
  const runPart = script("return await lib.run('part');"), runFile = script("return await lib.run('file', { path: 'mesh.obj' });");
  const pa = await cook(runPart, { scope: a }), pb = await cook(runPart, { scope: b }), pr = await cook(runPart);
  check(width(pa) === 2 && width(pb) === 3 && width(pr) === 1, `lib.run resolves the asset in the script's scope (widths ${width(pa)}, ${width(pb)}, ${width(pr)})`);
  const fa = await cook(runFile, { scope: a }), fb = await cook(runFile, { scope: b });
  check(width(fa) === 2 && width(fb) === 3, 'lib.run\'s file node reads the scope\'s folder');
  const bad = await cook(script("return await lib.run('b_thing');"), { scope: a });
  check(!bad.ok && /lib\.run: unknown node type "b_thing"/.test(errorOf(bad)), `lib.run does not see another scope's assets: ${errorOf(bad)}`);
}

section('two scopes in one cook');
{
  const inner: GraphSpec = { nodes: { x: { type: 'piece' }, f: { type: 'file', params: { path: 'mesh.obj' } }, m: { type: 'merge', in: ['x', 'f'] } }, output: 'm' };
  const g: GraphSpec = {
    nodes: {
      A: { type: 'test_in_scope', params: { scope: 'a', graph: inner } },
      B: { type: 'test_in_scope', params: { scope: 'b', graph: inner } },
      m: { type: 'merge', in: ['A', 'B'] },
    },
    output: 'm',
  };
  const r = await cook(g);
  check(r.ok, `a graph with nested cooks in two scopes cooks: ${errorOf(r)}`);
  const da = await cook(inner, { scope: a }), db = await cook(inner, { scope: b });
  check(fp(da) !== fp(db) && JSON.stringify(fingerprint(res(r, 'A').geo!)) === fp(da) && JSON.stringify(fingerprint(res(r, 'B').geo!)) === fp(db),
    'each nested cook gives its scope\'s result');
}

section('changing an asset in a scope');
{
  engine.registerAsset('part', box(5), { scope: a });
  const g: GraphSpec = { nodes: { x: { type: 'piece' } } };
  const ra = await cook(g, { scope: a }), rb = await cook(g, { scope: b });
  check(width(ra) === 5 && width(rb) === 3, `results that used the old definition are not reused (widths ${width(ra)}, ${width(rb)})`);
}

section('the root scope is unaffected');
{
  const after = await cook(rootSample);
  check(after.ok && fp(after) === fp(rootBefore), 'the root sample cooks as before the scoped cooks');
  check([...rootBefore.results.keys()].every((n) => res(after, n).sig === res(rootBefore, n).sig), 'with the same signatures');
  const fresh = new Engine(createNodeHost({ baseDir: tmp }));
  await fresh.init();
  fresh.registerAsset('sample_box', sampleBox);
  const other = await cook(rootSample, {}, fresh);
  check(fp(other) === fp(rootBefore) && [...rootBefore.results.keys()].every((n) => res(other, n).sig === res(rootBefore, n).sig),
    'and as an engine without scopes cooks it');
}

console.log(`\n${passes} passed, ${failures} failed — temp ${tmp}`);
process.exit(failures ? 1 : 0);
