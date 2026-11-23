// TopoTopo's own packages, the built-in packages of its built-in library (library/<name>/, scripts/gen-builtin.ts): every output, cooked
// as a package that uses the built-in package cooks it, documents its params, follows the built-in packages' conventions and cooks at its defaults
// and at both ends of every numeric range.
//   node test/builtin.ts [filter]
// Per output: description, 3–10 params each with type, default (= the var), desc and a range or options; every prim
// carries name and material (packed outputs are unpacked first); the pivot follows meta.pivot ("base" = on y = 0 with
// the origin inside the footprint); meta.watertight promises closed pieces; the default cook (cold cache) takes under
// 1 s. Then every numeric param at its min and max, every enum option and every bool flipped must cook without errors
// (and stay watertight when promised), and curve/surface outputs must also cook on their fixture input.
// Per built-in package: topotopo/<folder>, one output per graph named as its file with a pinned kind and tags (which its newest
// version records, the line-up "lineup" among them), the graph it shows lines its outputs up (its default output cooks),
// and its working folder is its newest version; the thumbnails and the README table are current
// (gen-builtin --check). Also: the assets tool forks an output's graph into the package's assets, which keeps list, get,
// save and delete for its own; the catalog and help list the outputs with their descriptions.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { Geometry } from '../src/core/geometry.ts';
import { initPackage, readManifest } from '../src/package.ts';
import { openPackages } from '../src/packages/registry.ts';
import { Session } from '../src/session.ts';
import { makeTools } from '../src/mcp/tools.ts';
import type { GraphSpec } from '../src/graph/types.ts';
import { SHOWN, checkBuiltin, lineupGraph, lineupText, readBuiltin } from '../scripts/gen-builtin.ts';
import { BUILTIN_INPUTS, checkGeo, builtinFixtureGraph, useBuiltin } from './fixtures.ts';
import { flat, namingProblems, paramProblems, sweepOf, watertightProblem } from './asset-checks.ts';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;

const filter = process.argv.slice(2).find((a) => !a.startsWith('--'));
let fails = 0, checks = 0;
const fail = (msg: string) => { fails++; console.log('FAIL ' + msg); };
const check = (ok: boolean, msg: string) => { checks++; if (!ok) fail(msg); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'topotopo-builtin-'));
const packageDir = path.join(tmp, 'package');
const engine = new Engine(createNodeHost({ baseDir: tmp }));
await engine.init();
const pk = useBuiltin(engine, packageDir);
check(!pk.check().length, `the built-in packages load without problems: ${pk.check().join('; ')}`);

const all = readBuiltin();
const outputs = all.flatMap((k) => k.outputs);
check(all.length >= 4 && outputs.length >= 30, `at least 4 built-in packages and 30 outputs (${all.length}, ${outputs.length})`);
if (!filter) for (const p of checkBuiltin(all)) fail(p);

const MAX_COOK_MS = 1000;

async function timeCook(engine: Engine, graph: GraphSpec) {
  const t0 = performance.now();
  const r = await engine.cook(graph);
  return { r, ms: performance.now() - t0 };
}

/** Conventions every cooked result must keep. */
function conventions(where: string, g0: Geometry, graph: GraphSpec, defaults: boolean) {
  const g = flat(g0);
  const inv = checkGeo(g);
  check(!inv.length, `${where}: geometry invariants: ${inv.join(', ')}`);
  if (!g.numPrims) return;
  const naming = namingProblems(g0);
  check(!naming.length, `${where}: ${naming.join('; ')}`);
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

for (const k of all) {
  if (filter && !k.outputs.some((o) => o.type.includes(filter))) continue;
  // ---- the built-in package: its package, one output per graph, the graph it shows, its default output
  check(k.manifest.name === k.package && k.manifest.graph === SHOWN && fs.existsSync(path.join(k.dir, `${k.name}.topo`)), `library/${k.name}/${k.name}.topo: name ${k.package}, graph "${SHOWN}"`);
  for (const o of k.outputs) {
    const outs = Object.keys(o.graph.outputs ?? {});
    check(outs.length === 1 && outs[0] === o.name && o.graph.outputs![o.name].node === o.graph.output, `${o.file}: one output, named as its file, its graph's output node (${outs.join(', ')})`);
    const out = o.graph.outputs?.[o.name];
    check(!!out?.kind && (out.tags?.length ?? 0) >= 3, `${o.file}: a pinned kind and at least 3 tags (${out?.kind}; ${out?.tags?.join(', ')})`);
  }
  // what the newest version records: every output's kind and tags, the line-up ("lineup") among them
  const newest = k.versions.at(-1);
  const recorded = newest ? Object.entries(newest.outputs) : [];
  check(recorded.length === k.outputs.length + 1 && recorded.every(([, x]) => !!x.kind && !!x.tags?.length) && !!newest?.outputs.lineup && newest.default.kind === newest.outputs.lineup.kind,
    `${k.package} ${newest?.version}: every output with its kind and tags, the line-up "lineup" its default output (${recorded.filter(([, x]) => !x.kind || !x.tags?.length).map(([n]) => n).join(', ') || 'all recorded'})`);
  const sizes = new Map<string, [number, number]>();
  for (const o of k.outputs) {
    const r = await engine.cook({ nodes: { o: { type: o.type } }, output: 'o' });
    if (r.ok && r.geo) { const bb = r.geo.bbox(true); sizes.set(o.name, [bb.min[0], bb.max[0]]); }
  }
  if (sizes.size === k.outputs.length) {
    const shown = fs.readFileSync(path.join(k.dir, 'graphs', `${SHOWN}.json`), 'utf8').replace(/\r\n/g, '\n');
    check(shown === lineupText(lineupGraph(k, sizes)), `library/${k.name}/graphs/${SHOWN}.json lines up the outputs as they cook: run npm run builtin`);
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
    const params = graph.params ?? {};
    const names = Object.keys(graph.vars ?? {});
    for (const p of paramProblems(graph)) fail(`${where}: ${p}`);
    checks++;
    for (const p of names) {
      const pd = params[p], dp = def.params[p];
      if (pd) check(!!dp && dp.type === pd.type, `${where}: node param "${p}" has type ${dp?.type}, expected ${pd.type}`);
    }
    const nIn = def.inputs.length;
    check(nIn === (graph.meta?.inputs?.length ?? 0), `${where}: meta.inputs lists ${graph.meta?.inputs?.length ?? 0} input(s), the graph has ${nIn}`);
    if (nIn) check(!!BUILTIN_INPUTS[name], `${where}: takes ${nIn} input(s) but has no fixture in BUILTIN_INPUTS (test/fixtures.ts)`);

    // ---- defaults, cold cache, standalone (inputs fall back to their built-in default)
    const standalone = (p: Record<string, any>): GraphSpec => ({ nodes: { target: { type: name, params: p } }, output: 'target' });
    const cookOf = (p: Record<string, any>, fixture = false) => {
      const g = fixture ? builtinFixtureGraph(name, p) : standalone(p);
      engine.cache.clear();
      return timeCook(engine, g);
    };
    const cookDefaults = async (engine: Engine) => {
      const g = standalone({});
      engine.cache.clear();
      gc();
      await engine.host.pool?.warm();
      return timeCook(engine, g);
    };
    const dc = await cookDefaults(engine);
    let ms = dc.ms;
    let times = `${ms.toFixed(0)} ms`;
    if (ms >= MAX_COOK_MS) {
      engine.cache.clear();
      const fresh = new Engine(createNodeHost({ baseDir: tmp }));
      await fresh.init();
      openPackages(fresh, packageDir);
      const again = await cookDefaults(fresh);
      fresh.cache.clear();
      times += `, again ${again.ms.toFixed(0)} ms`;
      ms = Math.min(ms, again.ms);
      if (ms < MAX_COOK_MS) console.log(`${name}: the first cook took ${dc.ms.toFixed(0)} ms, the second ${again.ms.toFixed(0)} ms`);
      if (!again.r.ok || !again.r.geo || !again.r.geo.numPrims || again.r.warnings.length)
        fail(`${where}: default cook retry: ${[...again.r.errors, ...again.r.warnings].map((e) => `[${e.node}] ${e.message}`).join('; ') || 'no geometry'}`);
    }
    check(ms < MAX_COOK_MS, `${where}: default cook took ${times} (limit ${MAX_COOK_MS})`);
    if (!dc.r.ok || !dc.r.geo) { fail(`${where}: default cook failed: ${dc.r.errors.map((e) => `[${e.node}] ${e.message}`).join('; ')}`); continue; }
    check(dc.r.geo.numPrims > 0, `${where}: default cook is empty`);
    check(!dc.r.warnings.length, `${where}: default cook warnings: ${dc.r.warnings.map((w) => `[${w.node}] ${w.message}`).slice(0, 3).join('; ')}`);
    conventions(`${where} (defaults)`, dc.r.geo, graph, true);
    const row: Row = { name, ms, prims: flat(dc.r.geo).numPrims, variants: 0, worst: 0, worstAt: '' };

    // ---- every numeric param at both ends of its range, every enum option, every bool flipped
    for (const [label, p] of sweepOf(graph)) {
      const v = await cookOf(p);
      row.variants++;
      if (v.ms > row.worst) { row.worst = v.ms; row.worstAt = label; }
      if (!v.r.ok || !v.r.geo) { fail(`${where} ${label}: ${v.r.errors.map((e) => `[${e.node}] ${e.message}`).join('; ')}`); continue; }
      conventions(`${where} ${label}`, v.r.geo, graph, false);
    }
    // ---- on the fixture input (curve / surface)
    if (nIn && BUILTIN_INPUTS[name]) {
      const v = await cookOf({}, true);
      if (!v.r.ok || !v.r.geo) fail(`${where} on its fixture input: ${v.r.errors.map((e) => `[${e.node}] ${e.message}`).join('; ')}`);
      else {
        check(v.r.geo.numPrims > 0, `${where} on its fixture input: empty`);
        conventions(`${where} on its fixture input`, v.r.geo, graph, false);
      }
    }
    engine.cache.clear();
    rows.push(row);
  }
}

// ---- the tools: the package's own assets, a fork of an output's graph into them, the catalog and help
if (!filter || 'stairs house'.includes(filter)) {
  const wsDir = path.join(tmp, 'ws');
  initPackage(wsDir);
  const e2 = new Engine(createNodeHost({ baseDir: wsDir }));
  await e2.init();
  const ws = new Session(wsDir, e2);
  ws.packages = openPackages(e2, wsDir);
  ws.load();
  const tools = makeTools(ws);
  const tool = (n: string) => tools.find((t) => t.name === n)!;
  const txt = async (n: string, a: any) => { try { const r = await tool(n).run(a); return { err: !!r.isError, text: r.content.map((c: any) => c.text ?? '').join('\n') }; } catch (e: any) { return { err: true, text: String(e.message) }; } };
  check(/^no assets yet/.test((await txt('assets', { action: 'list' })).text), 'a new package has no assets of its own');
  const fork = await txt('assets', { action: 'fork', name: 'topotopo/architecture/stairs', to: 'my_stairs' });
  const forked = path.join(wsDir, 'assets', 'my_stairs.json');
  check(!fork.err && fs.existsSync(forked) && e2.asset('my_stairs')?.def.category === 'asset' && !!JSON.parse(fs.readFileSync(forked, 'utf8')).params?.steps, `fork copies the output's graph into the package's assets: ${fork.text.split('\n')[0]}`);
  const rf = await e2.cook({ nodes: { s: { type: 'my_stairs', params: { steps: 9 } } } });
  check(rf.ok && !!rf.geo && rf.geo.numPrims > 0, `the forked asset cooks: ${rf.errors.map((e) => `[${e.node}] ${e.message}`).join('; ')}`);
  const house = await txt('assets', { action: 'fork', name: 'topotopo/architecture/house' });
  check(!house.err && !!e2.asset('house') && readManifest(wsDir).uses['topotopo/architecture'] === all.find((x) => x.name === 'architecture')!.versions.at(-1)!.version && /added topotopo\/architecture/.test(house.text),
    `a fork whose graph names the package's other outputs adds the built-in package to the package (first use): ${house.text.split('\n').slice(0, 2).join(' | ')}`);
  check((await e2.cook({ nodes: { h: { type: 'house', params: { floors: 1 } } } })).ok, 'and it cooks with the built-in package\'s walls and roof');
  const list = await txt('assets', { action: 'list' });
  check(/my_stairs — Straight stairs/.test(list.text) && /house — House built from a footprint polygon/.test(list.text), `assets list shows the package's assets: ${list.text.split('\n').slice(0, 3).join(' | ')}`);
  const get = await txt('assets', { action: 'get', name: 'my_stairs' });
  check(/## my_stairs \(asset\)/.test(get.text) && /"steps"/.test(get.text), 'assets get shows one with its graph');
  const del = await txt('assets', { action: 'delete', name: 'my_stairs' });
  check(!del.err && !e2.asset('my_stairs') && !fs.existsSync(forked), `assets delete removes it: ${del.text}`);
  const bare = await txt('assets', { action: 'fork', name: 'stairs' });
  check(bare.err && /fork copies a package output's graph/.test(bare.text), `fork names a package output: ${bare.text}`);
  const unknown = await txt('assets', { action: 'fork', name: 'topotopo/architecture/stair' });
  check(unknown.err && /did you mean .*topotopo\/architecture\/stairs/.test(unknown.text), `fork of an output the built-in package does not have: ${unknown.text}`);
  const cat = await txt('catalog', { category: 'package' });
  check(/\[package\]/.test(cat.text) && /topotopo\/architecture\/wall_segment ◦ — Straight wall from x = 0 to x = wall_length/.test(cat.text) && /topotopo\/nature\/rock ◦ — Low-poly rock/.test(cat.text),
    'catalog lists the built-in packages\' outputs with their descriptions');
  const help = await txt('help', { nodes: ['topotopo/architecture/stairs', 'topotopo/nature/rock'] });
  check(help.text.includes('## topotopo/architecture/stairs (package)') && help.text.includes('steps int') && /in this package: package topotopo\/nature is not in this package's uses/.test(help.text),
    'help documents an output, and says when the package does not use it yet');
  check(/\ntopotopo\/nature\/rock ◦ — Low-poly rock[^\n]* {2}\(mesh \[rock, stone, boulder, low-poly\]\)\n/.test(`\n${cat.text.split('\n').map((l) => l.trim()).join('\n')}\n`) && /\nwhat it is: instances \[forest, trees, conifer/.test((await txt('help', { nodes: ['topotopo/nature/forest_patch'] })).text)
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
  check(/^unknown node type "stairs" — did you mean topotopo\/architecture\/stairs[,?]/.test(outside), `outside a package as well: ${outside}`);
}

fs.rmSync(tmp, { recursive: true, force: true });
rows.sort((a, b) => b.ms - a.ms);
console.log('\noutput                                default ms  prims   variants  slowest variant');
for (const r of rows) console.log(`${r.name.padEnd(38)}${r.ms.toFixed(0).padStart(9)}  ${String(r.prims).padStart(6)}  ${String(r.variants).padStart(8)}  ${r.worst.toFixed(0).padStart(5)} ms (${r.worstAt})`);
console.log(`\nbuilt-in packages: ${all.length} packages, ${rows.length} outputs, ${rows.reduce((s, r) => s + r.variants, 0)} variant cooks, ${checks} checks, ${fails} failed`);
process.exit(fails ? 1 : 0);
