// Shelf assets (shelf/*.json): they load as node types, document their params, follow the shelf conventions and cook
// at their defaults and at both ends of every numeric range.
//   node test/shelf.ts [filter]
// Per asset: description, 3–10 params each with type, default (= the var), desc and a range or options; every prim
// carries name and material (packed outputs are unpacked first); the pivot follows meta.pivot ("base" = on y = 0 with
// the origin inside the footprint); meta.watertight promises closed pieces; the default cook (cold cache) takes under
// 1 s. Then every numeric param at its min and max, every enum option and every bool flipped must cook without
// errors (and stay watertight when promised), and curve/surface assets must also cook on their fixture input.
// Also: shelf/index.json, thumbnails and the README table are current; a workspace asset overrides a shelf asset of
// the same name and deleting it restores the shelf version; assets fork/list/get work through the MCP tools.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { Geometry } from '../src/core/geometry.ts';
import { expandPacked } from '../src/core/packed.ts';
import { pieceReport } from '../src/core/analysis.ts';
import { readMaterials } from '../src/core/materials.ts';
import { Workspace } from '../src/workspace.ts';
import { makeTools } from '../src/mcp/tools.ts';
import type { GraphSpec } from '../src/graph/types.ts';
import { GROUPS, checkShelf, readShelfFiles } from '../scripts/gen-shelf.ts';
import { SHELF_INPUTS, checkGeo, shelfFixtureGraph } from './fixtures.ts';

const filter = process.argv.slice(2).find((a) => !a.startsWith('--'));
let fails = 0, checks = 0;
const fail = (msg: string) => { fails++; console.log('FAIL ' + msg); };
const check = (ok: boolean, msg: string) => { checks++; if (!ok) fail(msg); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'topotopo-shelf-'));
const engine = new Engine(createNodeHost({ baseDir: tmp }));
await engine.init();
check(!engine.shelfErrors.length, `shelf loads without errors: ${engine.shelfErrors.join('; ')}`);

const files = readShelfFiles();
check(files.length >= 30, `at least 30 shelf assets (${files.length})`);
if (!filter) for (const p of checkShelf(files)) fail(p);

const NUMERIC = new Set(['float', 'int']);
const MAX_COOK_MS = 1000;

/** Polygons of g, packed instances expanded. */
const flat = (g: Geometry) => (g.hasPacked() ? expandPacked(g).geo : g);

function watertightProblem(g: Geometry): string {
  const pr = pieceReport(g);
  const be = pr.pieces.reduce((s, x) => s + x.boundaryEdges, 0), nme = pr.pieces.reduce((s, x) => s + x.nonManifoldEdges, 0);
  const lines = pr.pieces.reduce((s, x) => s + x.lines, 0);
  return be || nme || lines ? `${be} boundary edges, ${nme} non-manifold edges, ${lines} polylines` : '';
}

/** Conventions every cooked result must keep. */
function conventions(where: string, g0: Geometry, graph: GraphSpec, defaults: boolean) {
  const g = flat(g0);
  const inv = checkGeo(g);
  check(!inv.length, `${where}: geometry invariants: ${inv.join(', ')}`);
  if (!g.numPrims) return;
  const nm = g.prims.get('name'), mt = g.prims.get('material');
  check(!!nm && nm.type === 'string', `${where}: prim string attribute "name"`);
  check(!!mt && mt.type === 'string', `${where}: prim string attribute "material"`);
  if (nm && mt) {
    let missing = 0;
    for (let i = 0; i < g.numPrims; i++) if (!nm.get(i) || !mt.get(i)) missing++;
    check(!missing, `${where}: ${missing} of ${g.numPrims} prims without name or material`);
  }
  if (!g0.hasPacked() && mt) {
    const table = readMaterials(g), used = new Set<string>((mt.data as string[]).filter(Boolean));
    const undefinedMats = [...used].filter((m) => !table[m]);
    check(!undefinedMats.length, `${where}: materials without a table entry: ${undefinedMats.join(', ')}`);
  }
  if (graph.meta?.watertight) {
    const w = watertightProblem(g);
    check(!w, `${where}: promised watertight pieces, found ${w}`);
  }
  if (defaults) {
    const bb = g.bbox(true), pivot = graph.meta?.pivot ?? 'base';
    const inside = bb.min[0] <= 0.011 && bb.max[0] >= -0.011 && bb.min[2] <= 0.011 && bb.max[2] >= -0.011;
    if (pivot === 'base') {
      check(Math.abs(bb.min[1]) <= 0.011, `${where}: pivot "base" but the bbox bottom is at y = ${bb.min[1].toFixed(3)}`);
      check(inside, `${where}: pivot "base" but the origin is outside the XZ footprint`);
    } else if (pivot === 'opening' || pivot === 'wall_top') {
      check(bb.min[1] <= 0.011 && bb.max[1] > 0, `${where}: pivot "${pivot}" should lie within the height range`);
      check(inside, `${where}: pivot "${pivot}" but the origin is outside the XZ footprint`);
    }
  }
}

interface Row { name: string; ms: number; prims: number; variants: number; worst: number; worstAt: string }
const rows: Row[] = [];

for (const f of files) {
  const name = f.name, graph = f.graph;
  if (filter && !name.includes(filter)) continue;
  const where = `shelf/${f.file}`;
  const entry = engine.assets.get(name);
  if (!entry) { fail(`${where}: not registered`); continue; }
  check(entry.def.category === 'shelf', `${where}: category "shelf" (got ${entry.def.category})`);

  // ---- documentation and typed params
  check(typeof graph.description === 'string' && graph.description.length > 40, `${where}: a description`);
  check(GROUPS.includes(graph.meta?.shelf_group), `${where}: meta.shelf_group is one of ${GROUPS.join(', ')}`);
  const vars = graph.vars ?? {}, params = graph.params ?? {};
  const names = Object.keys(vars);
  check(names.length >= 3 && names.length <= 10, `${where}: 3–10 params (${names.length})`);
  check(Object.keys(params).every((k) => k in vars), `${where}: params without a var: ${Object.keys(params).filter((k) => !(k in vars)).join(', ')}`);
  for (const k of names) {
    const pd = params[k];
    if (!pd) { fail(`${where}: var "${k}" has no params entry`); continue; }
    check(!!pd.type && typeof pd.desc === 'string' && pd.desc.length > 3, `${where}: param "${k}" needs type and desc`);
    check(JSON.stringify(pd.default) === JSON.stringify(vars[k]), `${where}: param "${k}" default ${JSON.stringify(pd.default)} differs from the var ${JSON.stringify(vars[k])}`);
    if (NUMERIC.has(pd.type ?? '')) {
      check(typeof pd.min === 'number' && typeof pd.max === 'number' && pd.min <= vars[k] && vars[k] <= pd.max, `${where}: numeric param "${k}" needs min ≤ default ≤ max`);
      if (pd.type === 'int') check(Number.isInteger(vars[k]), `${where}: int param "${k}" default is not an integer`);
    }
    if (pd.type === 'enum') check(Array.isArray(pd.options) && pd.options.includes(vars[k]), `${where}: enum param "${k}" needs options containing the default`);
    const dp = entry.def.params[k];
    check(!!dp && dp.type === pd.type, `${where}: node param "${k}" has type ${dp?.type}, expected ${pd.type}`);
  }
  const nIn = entry.def.inputs.length;
  check(nIn === (graph.meta?.inputs?.length ?? 0), `${where}: meta.inputs lists ${graph.meta?.inputs?.length ?? 0} input(s), the graph has ${nIn}`);
  if (nIn) check(!!SHELF_INPUTS[name], `${where}: takes ${nIn} input(s) but has no fixture in SHELF_INPUTS (test/fixtures.ts)`);

  // ---- defaults, cold cache, standalone (inputs fall back to their built-in default)
  const cookOf = async (p: Record<string, any>, fixture = false) => {
    const g: GraphSpec = fixture ? shelfFixtureGraph(name, p) : { nodes: { target: { type: name, params: p } }, output: 'target' };
    engine.cache.clear();
    const t0 = performance.now();
    const r = await engine.cook(g);
    return { r, ms: performance.now() - t0 };
  };
  const d = await cookOf({});
  if (!d.r.ok || !d.r.geo) { fail(`${where}: default cook failed: ${d.r.errors.map((e) => `[${e.node}] ${e.message}`).join('; ')}`); continue; }
  check(d.r.geo.numPrims > 0, `${where}: default cook is empty`);
  check(d.ms < MAX_COOK_MS, `${where}: default cook took ${d.ms.toFixed(0)} ms (limit ${MAX_COOK_MS})`);
  check(!d.r.warnings.length, `${where}: default cook warnings: ${d.r.warnings.map((w) => `[${w.node}] ${w.message}`).slice(0, 3).join('; ')}`);
  conventions(`${where} (defaults)`, d.r.geo, graph, true);
  const row: Row = { name, ms: d.ms, prims: flat(d.r.geo).numPrims, variants: 0, worst: 0, worstAt: '' };

  // ---- every numeric param at both ends of its range, every enum option, every bool flipped
  const variants: [string, Record<string, any>][] = [];
  for (const k of names) {
    const pd = params[k];
    if (!pd) continue;
    if (NUMERIC.has(pd.type ?? '')) { variants.push([`${k}=${pd.min}`, { [k]: pd.min }], [`${k}=${pd.max}`, { [k]: pd.max }]); }
    else if (pd.type === 'enum') for (const o of pd.options ?? []) { if (o !== vars[k]) variants.push([`${k}=${o}`, { [k]: o }]); }
    else if (pd.type === 'bool') variants.push([`${k}=${!vars[k]}`, { [k]: !vars[k] }]);
  }
  for (const [label, p] of variants) {
    const v = await cookOf(p);
    row.variants++;
    if (v.ms > row.worst) { row.worst = v.ms; row.worstAt = label; }
    if (!v.r.ok || !v.r.geo) { fail(`${where} ${label}: ${v.r.errors.map((e) => `[${e.node}] ${e.message}`).join('; ')}`); continue; }
    conventions(`${where} ${label}`, v.r.geo, graph, false);
  }
  // ---- on the fixture input (curve / surface)
  if (nIn && SHELF_INPUTS[name]) {
    const v = await cookOf({}, true);
    if (!v.r.ok || !v.r.geo) fail(`${where} on its fixture input: ${v.r.errors.map((e) => `[${e.node}] ${e.message}`).join('; ')}`);
    else {
      check(v.r.geo.numPrims > 0, `${where} on its fixture input: empty`);
      conventions(`${where} on its fixture input`, v.r.geo, graph, false);
    }
  }
  rows.push(row);
}

// ---- precedence: a workspace asset overrides the shelf asset of the same name; deleting it restores the shelf one
if (!filter || 'crate'.includes(filter)) {
  const wsDir = path.join(tmp, 'ws');
  fs.mkdirSync(path.join(wsDir, 'assets'), { recursive: true });
  const mine: GraphSpec = { description: 'my crate', vars: { s: 2 }, nodes: { b: { type: 'box', params: { size: ['=s', '=s', '=s'] } } }, output: 'b' };
  fs.writeFileSync(path.join(wsDir, 'assets', 'crate.json'), JSON.stringify(mine));
  const e2 = new Engine(createNodeHost({ baseDir: wsDir }));
  await e2.init();
  const ws = new Workspace(wsDir, e2);
  const loaded = ws.load();
  check(loaded.assets === 1 && loaded.shelf === files.length - 1, `workspace load counts (assets ${loaded.assets}, shelf ${loaded.shelf})`);
  check(e2.assets.get('crate')?.def.category === 'asset' && e2.assets.get('crate')?.def.summary === 'my crate', 'a workspace asset overrides the shelf asset');
  const r1 = await e2.cook({ nodes: { c: { type: 'crate' } } });
  check(!!r1.geo && Math.abs(r1.geo.bbox().max[0] - 1) < 1e-9, 'the override cooks');
  await e2.loadShelf(e2.host.shelfPath!);
  check(e2.assets.get('crate')?.def.category === 'asset', 'reloading the shelf keeps the workspace override');
  const tools = makeTools(ws);
  const tool = (n: string) => tools.find((t) => t.name === n)!;
  const txt = async (n: string, a: any) => { const r = await tool(n).run(a); return { err: !!r.isError, text: r.content.map((c: any) => c.text ?? '').join('\n') }; };
  const list = await txt('assets', { action: 'list' });
  check(list.text.includes('[shelf]') && list.text.includes('stairs') && list.text.includes('crate — my crate'), 'assets list shows shelf and workspace assets');
  const del = await txt('assets', { action: 'delete', name: 'crate' });
  check(!del.err && /restored the shelf/.test(del.text) && e2.assets.get('crate')?.def.category === 'shelf', `deleting the override restores the shelf asset: ${del.text}`);
  let threw = '';
  try { await tool('assets').run({ action: 'delete', name: 'stairs' }); } catch (e: any) { threw = e.message; }
  check(/shelf/.test(threw) && e2.assets.has('stairs'), `shelf assets cannot be deleted: ${threw}`);
  const fork = await txt('assets', { action: 'fork', name: 'stairs', to: 'my_stairs' });
  check(!fork.err && ws.graphs.has('my_stairs') && !!ws.graphs.get('my_stairs')!.params?.steps, `fork copies the asset graph into the workspace: ${fork.text.split('\n')[0]}`);
  const rf = await ws.cook('my_stairs');
  check(rf.ok && !!rf.geo && rf.geo.numPrims > 0, `the forked graph cooks: ${rf.errors.map((e) => `[${e.node}] ${e.message}`).join('; ')}`);
  const cat = await txt('catalog', { category: 'shelf' });
  check(cat.text.includes('[shelf]') && cat.text.includes('wall_segment'), 'catalog lists the shelf category');
  const help = await txt('help', { nodes: ['stairs'] });
  check(help.text.includes('## stairs (shelf)') && help.text.includes('steps int'), 'help documents shelf asset params');
}

fs.rmSync(tmp, { recursive: true, force: true });
rows.sort((a, b) => b.ms - a.ms);
console.log('\nasset            default ms  prims   variants  slowest variant');
for (const r of rows) console.log(`${r.name.padEnd(17)}${r.ms.toFixed(0).padStart(9)}  ${String(r.prims).padStart(6)}  ${String(r.variants).padStart(8)}  ${r.worst.toFixed(0).padStart(5)} ms (${r.worstAt})`);
console.log(`\nshelf: ${rows.length} assets, ${rows.reduce((s, r) => s + r.variants, 0)} variant cooks, ${checks} checks, ${fails} failed`);
process.exit(fails ? 1 : 0);
