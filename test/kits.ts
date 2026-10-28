// TopoTopo's own packages, the kits of its built-in library (library/<kit>/, scripts/gen-kits.ts): every output, cooked
// as a project that uses the kit cooks it, documents its params, follows the kits' conventions and cooks at its defaults
// and at both ends of every numeric range.
//   node test/kits.ts [filter]
// Per output: description, 3–10 params each with type, default (= the var), desc and a range or options; every prim
// carries name and material (packed outputs are unpacked first); the pivot follows meta.pivot ("base" = on y = 0 with
// the origin inside the footprint); meta.watertight promises closed pieces; the default cook (cold cache) takes under
// 1 s. Then every numeric param at its min and max, every enum option and every bool flipped must cook without errors
// (and stay watertight when promised), and curve/surface outputs must also cook on their fixture input.
// Per kit: topotopo/<folder>, one output per graph named as its file with a pinned kind and tags (which its newest
// version records, the line-up "kit" among them), the graph it shows lines its outputs up (its default output cooks),
// and its working folder is its newest version; the thumbnails and the README table are current
// (gen-kits --check). Also: the assets tool forks an output's graph into the project's assets, which keeps list, get,
// save and delete for its own; the catalog and help list the outputs with their descriptions.
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
import { initProject, readManifest } from '../src/gallery/library.ts';
import { openPackages } from '../src/gallery/packages.ts';
import { Workspace } from '../src/workspace.ts';
import { makeTools } from '../src/mcp/tools.ts';
import type { GraphSpec } from '../src/graph/types.ts';
import { SHOWN, checkKits, lineupGraph, lineupText, readKits } from '../scripts/gen-kits.ts';
import { KIT_INPUTS, checkGeo, kitFixtureGraph, useKits } from './fixtures.ts';

const filter = process.argv.slice(2).find((a) => !a.startsWith('--'));
let fails = 0, checks = 0;
const fail = (msg: string) => { fails++; console.log('FAIL ' + msg); };
const check = (ok: boolean, msg: string) => { checks++; if (!ok) fail(msg); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'topotopo-kits-'));
const engine = new Engine(createNodeHost({ baseDir: tmp }));
await engine.init();
const pk = useKits(engine, path.join(tmp, 'project'));
check(!pk.check().length, `the kits load without problems: ${pk.check().join('; ')}`);

const kits = readKits();
const outputs = kits.flatMap((k) => k.outputs);
check(kits.length >= 4 && outputs.length >= 30, `at least 4 kits and 30 outputs (${kits.length}, ${outputs.length})`);
if (!filter) for (const p of checkKits(kits)) fail(p);

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

for (const k of kits) {
  if (filter && !k.outputs.some((o) => o.type.includes(filter))) continue;
  // ---- the kit: its package, one output per graph, the graph it shows, its default output
  check(k.manifest.package === k.package && k.manifest.graph === SHOWN, `library/${k.name}/project.json: package ${k.package}, graph "${SHOWN}"`);
  for (const o of k.outputs) {
    const outs = Object.keys(o.graph.outputs ?? {});
    check(outs.length === 1 && outs[0] === o.name && o.graph.outputs![o.name].node === o.graph.output, `${o.file}: one output, named as its file, its graph's output node (${outs.join(', ')})`);
    const out = o.graph.outputs?.[o.name];
    check(!!out?.kind && (out.tags?.length ?? 0) >= 3, `${o.file}: a pinned kind and at least 3 tags (${out?.kind}; ${out?.tags?.join(', ')})`);
  }
  // what the newest version records: every output's kind and tags, the line-up ("kit") among them
  const newest = k.versions.at(-1);
  const recorded = newest ? Object.entries(newest.outputs) : [];
  check(recorded.length === k.outputs.length + 1 && recorded.every(([, x]) => !!x.kind && !!x.tags?.length) && !!newest?.outputs.kit && newest.default.kind === newest.outputs.kit.kind,
    `${k.package} ${newest?.version}: every output with its kind and tags, the line-up "kit" its default output (${recorded.filter(([, x]) => !x.kind || !x.tags?.length).map(([n]) => n).join(', ') || 'all recorded'})`);
  const sizes = new Map<string, [number, number]>();
  for (const o of k.outputs) {
    const r = await engine.cook({ nodes: { o: { type: o.type } }, output: 'o' });
    if (r.ok && r.geo) { const bb = r.geo.bbox(true); sizes.set(o.name, [bb.min[0], bb.max[0]]); }
  }
  if (sizes.size === k.outputs.length) {
    const shown = fs.readFileSync(path.join(k.dir, 'graphs', `${SHOWN}.json`), 'utf8').replace(/\r\n/g, '\n');
    check(shown === lineupText(lineupGraph(k, sizes)), `library/${k.name}/graphs/${SHOWN}.json lines up the outputs as they cook: run npm run kits`);
  }
  const d = await engine.cook({ nodes: { k: { type: k.package } }, output: 'k' });
  check(d.ok && !!d.geo && d.geo.numPrims >= k.outputs.length && !d.warnings.length, `${k.package}, the default output, lines the outputs up: ${d.errors.map((e) => e.message).join('; ')}${d.warnings.map((w) => w.message).join('; ')}`);

  for (const o of k.outputs) {
    const name = o.type, graph = o.graph;
    if (filter && !name.includes(filter)) continue;
    const where = o.file;
    const def = engine.resolveDef(name);
    if (!def) { fail(`${where}: ${name} does not resolve: ${engine.packageIssue(name).error}`); continue; }
    check(def.category === 'package' && def.package?.version === k.versions.at(-1)?.version, `${where}: category "package", the newest version (got ${def.category} ${def.package?.version})`);

    // ---- documentation and typed params
    check(typeof graph.description === 'string' && graph.description.length > 40 && def.summary === /^(.+?[.!?])\s/s.exec(graph.description)?.[1], `${where}: a description, whose first sentence is the catalog's summary`);
    const vars = graph.vars ?? {}, params = graph.params ?? {};
    const names = Object.keys(vars);
    check(names.length >= 3 && names.length <= 10, `${where}: 3–10 params (${names.length})`);
    check(Object.keys(params).every((p) => p in vars), `${where}: params without a var: ${Object.keys(params).filter((p) => !(p in vars)).join(', ')}`);
    for (const p of names) {
      const pd = params[p];
      if (!pd) { fail(`${where}: var "${p}" has no params entry`); continue; }
      check(!!pd.type && typeof pd.desc === 'string' && pd.desc.length > 3, `${where}: param "${p}" needs type and desc`);
      check(JSON.stringify(pd.default) === JSON.stringify(vars[p]), `${where}: param "${p}" default ${JSON.stringify(pd.default)} differs from the var ${JSON.stringify(vars[p])}`);
      if (NUMERIC.has(pd.type ?? '')) {
        check(typeof pd.min === 'number' && typeof pd.max === 'number' && pd.min <= vars[p] && vars[p] <= pd.max, `${where}: numeric param "${p}" needs min ≤ default ≤ max`);
        if (pd.type === 'int') check(Number.isInteger(vars[p]), `${where}: int param "${p}" default is not an integer`);
      }
      if (pd.type === 'enum') check(Array.isArray(pd.options) && pd.options.includes(vars[p]), `${where}: enum param "${p}" needs options containing the default`);
      const dp = def.params[p];
      check(!!dp && dp.type === pd.type, `${where}: node param "${p}" has type ${dp?.type}, expected ${pd.type}`);
    }
    const nIn = def.inputs.length;
    check(nIn === (graph.meta?.inputs?.length ?? 0), `${where}: meta.inputs lists ${graph.meta?.inputs?.length ?? 0} input(s), the graph has ${nIn}`);
    if (nIn) check(!!KIT_INPUTS[name], `${where}: takes ${nIn} input(s) but has no fixture in KIT_INPUTS (test/fixtures.ts)`);

    // ---- defaults, cold cache, standalone (inputs fall back to their built-in default)
    const cookOf = async (p: Record<string, any>, fixture = false) => {
      const g: GraphSpec = fixture ? kitFixtureGraph(name, p) : { nodes: { target: { type: name, params: p } }, output: 'target' };
      engine.cache.clear();
      const t0 = performance.now();
      const r = await engine.cook(g);
      return { r, ms: performance.now() - t0 };
    };
    const dc = await cookOf({});
    if (!dc.r.ok || !dc.r.geo) { fail(`${where}: default cook failed: ${dc.r.errors.map((e) => `[${e.node}] ${e.message}`).join('; ')}`); continue; }
    check(dc.r.geo.numPrims > 0, `${where}: default cook is empty`);
    check(dc.ms < MAX_COOK_MS, `${where}: default cook took ${dc.ms.toFixed(0)} ms (limit ${MAX_COOK_MS})`);
    check(!dc.r.warnings.length, `${where}: default cook warnings: ${dc.r.warnings.map((w) => `[${w.node}] ${w.message}`).slice(0, 3).join('; ')}`);
    conventions(`${where} (defaults)`, dc.r.geo, graph, true);
    const row: Row = { name, ms: dc.ms, prims: flat(dc.r.geo).numPrims, variants: 0, worst: 0, worstAt: '' };

    // ---- every numeric param at both ends of its range, every enum option, every bool flipped
    const variants: [string, Record<string, any>][] = [];
    for (const p of names) {
      const pd = params[p];
      if (!pd) continue;
      if (NUMERIC.has(pd.type ?? '')) { variants.push([`${p}=${pd.min}`, { [p]: pd.min }], [`${p}=${pd.max}`, { [p]: pd.max }]); }
      else if (pd.type === 'enum') for (const x of pd.options ?? []) { if (x !== vars[p]) variants.push([`${p}=${x}`, { [p]: x }]); }
      else if (pd.type === 'bool') variants.push([`${p}=${!vars[p]}`, { [p]: !vars[p] }]);
    }
    for (const [label, p] of variants) {
      const v = await cookOf(p);
      row.variants++;
      if (v.ms > row.worst) { row.worst = v.ms; row.worstAt = label; }
      if (!v.r.ok || !v.r.geo) { fail(`${where} ${label}: ${v.r.errors.map((e) => `[${e.node}] ${e.message}`).join('; ')}`); continue; }
      conventions(`${where} ${label}`, v.r.geo, graph, false);
    }
    // ---- on the fixture input (curve / surface)
    if (nIn && KIT_INPUTS[name]) {
      const v = await cookOf({}, true);
      if (!v.r.ok || !v.r.geo) fail(`${where} on its fixture input: ${v.r.errors.map((e) => `[${e.node}] ${e.message}`).join('; ')}`);
      else {
        check(v.r.geo.numPrims > 0, `${where} on its fixture input: empty`);
        conventions(`${where} on its fixture input`, v.r.geo, graph, false);
      }
    }
    rows.push(row);
  }
}

// ---- the tools: the project's own assets, a fork of an output's graph into them, the catalog and help
if (!filter || 'stairs house'.includes(filter)) {
  const wsDir = path.join(tmp, 'ws');
  initProject(wsDir);
  const e2 = new Engine(createNodeHost({ baseDir: wsDir }));
  await e2.init();
  const ws = new Workspace(wsDir, e2);
  ws.packages = openPackages(e2, wsDir);
  ws.load();
  const tools = makeTools(ws);
  const tool = (n: string) => tools.find((t) => t.name === n)!;
  const txt = async (n: string, a: any) => { try { const r = await tool(n).run(a); return { err: !!r.isError, text: r.content.map((c: any) => c.text ?? '').join('\n') }; } catch (e: any) { return { err: true, text: String(e.message) }; } };
  check(/^no assets yet/.test((await txt('assets', { action: 'list' })).text), 'a new project has no assets of its own');
  const fork = await txt('assets', { action: 'fork', name: 'topotopo/architecture/stairs', to: 'my_stairs' });
  const forked = path.join(wsDir, 'assets', 'my_stairs.json');
  check(!fork.err && fs.existsSync(forked) && e2.asset('my_stairs')?.def.category === 'asset' && !!JSON.parse(fs.readFileSync(forked, 'utf8')).params?.steps, `fork copies the output's graph into the project's assets: ${fork.text.split('\n')[0]}`);
  const rf = await e2.cook({ nodes: { s: { type: 'my_stairs', params: { steps: 9 } } } });
  check(rf.ok && !!rf.geo && rf.geo.numPrims > 0, `the forked asset cooks: ${rf.errors.map((e) => `[${e.node}] ${e.message}`).join('; ')}`);
  const house = await txt('assets', { action: 'fork', name: 'topotopo/architecture/house' });
  check(!house.err && !!e2.asset('house') && readManifest(wsDir).uses['topotopo/architecture'] === kits.find((x) => x.name === 'architecture')!.versions.at(-1)!.version && /added topotopo\/architecture/.test(house.text),
    `a fork whose graph names the kit's other outputs adds the kit to the project (first use): ${house.text.split('\n').slice(0, 2).join(' | ')}`);
  check((await e2.cook({ nodes: { h: { type: 'house', params: { floors: 1 } } } })).ok, 'and it cooks with the kit\'s walls and roof');
  const list = await txt('assets', { action: 'list' });
  check(/my_stairs — Straight stairs/.test(list.text) && /house — House built from a footprint polygon/.test(list.text), `assets list shows the project's assets: ${list.text.split('\n').slice(0, 3).join(' | ')}`);
  const get = await txt('assets', { action: 'get', name: 'my_stairs' });
  check(/## my_stairs \(asset\)/.test(get.text) && /"steps"/.test(get.text), 'assets get shows one with its graph');
  const del = await txt('assets', { action: 'delete', name: 'my_stairs' });
  check(!del.err && !e2.asset('my_stairs') && !fs.existsSync(forked), `assets delete removes it: ${del.text}`);
  const bare = await txt('assets', { action: 'fork', name: 'stairs' });
  check(bare.err && /fork copies a package output's graph/.test(bare.text), `fork names a package output: ${bare.text}`);
  const unknown = await txt('assets', { action: 'fork', name: 'topotopo/architecture/stair' });
  check(unknown.err && /did you mean .*topotopo\/architecture\/stairs/.test(unknown.text), `fork of an output the kit does not have: ${unknown.text}`);
  const cat = await txt('catalog', { category: 'package' });
  check(/\[package\]/.test(cat.text) && /topotopo\/architecture\/wall_segment ◦ — Straight wall from x = 0 to x = wall_length/.test(cat.text) && /topotopo\/nature\/rock ◦ — Low-poly rock/.test(cat.text),
    'catalog lists the kits\' outputs with their descriptions');
  const help = await txt('help', { nodes: ['topotopo/architecture/stairs', 'topotopo/nature/rock'] });
  check(help.text.includes('## topotopo/architecture/stairs (package)') && help.text.includes('steps int') && /in this workspace: package topotopo\/nature is not in this project's uses/.test(help.text),
    'help documents an output, and says when the project does not use its kit yet');
  check(/\ntopotopo\/nature\/rock ◦ — Low-poly rock[^\n]* \[kind mesh · tags rock, stone, boulder, lowpoly\]\n/.test(`\n${cat.text.split('\n').map((l) => l.trim()).join('\n')}\n`) && /\nkind instances · tags forest, trees, conifer/.test((await txt('help', { nodes: ['topotopo/nature/forest_patch'] })).text)
    && /topotopo\/nature\/forest_patch/.test((await txt('catalog', { search: 'conifer' })).text), 'the catalog and help give an output\'s kind and tags, and the catalog\'s search finds a tag');
  // a bare name is no node type, and nothing makes it one: the error names the output of that name, used or not
  const bareType = (await e2.cook({ nodes: { r: { type: 'rock' } }, output: 'r' })).errors.map((e) => e.message).join('; ');
  check(/^unknown node type "rock" — did you mean topotopo\/nature\/rock[,?]/.test(bareType), `a bare name suggests the output of that name first: ${bareType}`);
  const helpBare = await txt('help', { nodes: ['crate'] });
  check(/unknown node "crate" — did you mean topotopo\/props\/crate[,?]/.test(helpBare.text), `and so does help: ${helpBare.text.split('\n')[0]}`);
  const looseDir = path.join(tmp, 'loose');
  fs.mkdirSync(looseDir);
  const loose = new Engine(createNodeHost({ baseDir: looseDir, workers: 0 }));
  await loose.init();
  openPackages(loose, looseDir);
  const outside = (await loose.cook({ nodes: { s: { type: 'stairs' } }, output: 's' })).errors.map((e) => e.message).join('; ');
  check(/^unknown node type "stairs" — did you mean topotopo\/architecture\/stairs[,?]/.test(outside), `outside a project as well: ${outside}`);
}

fs.rmSync(tmp, { recursive: true, force: true });
rows.sort((a, b) => b.ms - a.ms);
console.log('\noutput                                default ms  prims   variants  slowest variant');
for (const r of rows) console.log(`${r.name.padEnd(38)}${r.ms.toFixed(0).padStart(9)}  ${String(r.prims).padStart(6)}  ${String(r.variants).padStart(8)}  ${r.worst.toFixed(0).padStart(5)} ms (${r.worstAt})`);
console.log(`\nkits: ${kits.length} kits, ${rows.length} outputs, ${rows.reduce((s, r) => s + r.variants, 0)} variant cooks, ${checks} checks, ${fails} failed`);
process.exit(fails ? 1 : 0);
