// Golden tests: every node type (on its fixture), every example graph, every test scene (test/scenes/: graphs kept for
// their coverage, not examples) and every output of TopoTopo's own packages is
// cooked and fingerprinted (counts, bbox, attribute schema, groups, quantised hashes of positions, topology and
// attributes). Fingerprints live in test/golden/<name>.json, one file per node, example or output, so changes show up in
// git diffs. An example that meets its card (test/cards.ts; every example not on EXAMPLES_PENDING) must also cook
// cleanly, without errors or warnings, so none is frozen into its golden. An example's golden is a review aid, not its
// contract: when its graph is rebuilt or the engine improves, its card checks say whether it still does the same job,
// and an intended change is updated here and looked at in its render (npm run showcase).
//
//   node test/golden.ts             compare against test/golden/*.json, print a per-field diff on mismatch
//   node test/golden.ts --update    rewrite the golden files (and remove orphaned ones when no filter is given)
//   node test/golden.ts <filter>    only names containing <filter> (e.g. "node.sweep", "example.", "sdf")
import fs from 'node:fs';
import path from 'node:path';
import { Engine } from '../src/graph/engine.ts';
import { allNodeDefs } from '../src/graph/registry.ts';
import { createNodeHost } from '../src/host/node.ts';
import { openPackages } from '../src/packages/registry.ts';
import type { GraphSpec } from '../src/graph/types.ts';
import { EXAMPLES_PENDING, ROOT, SKIP, checkGeo, createFixtureEngine, fixtureGraphFor, graphIsEnvDependent, builtinFixtureGraph, examplePackageGraphs } from './fixtures.ts';
import { diffFields, fingerprint, formatDiff, sortedJSON } from './fingerprint.ts';

const args = process.argv.slice(2);
const update = args.includes('--update');
const filter = args.find((a) => !a.startsWith('--'));
const goldenDir = path.join(ROOT, 'test', 'golden');
const examplesDir = path.join(ROOT, 'examples');

const { engine } = await createFixtureEngine();
// the examples are a package: they cook TopoTopo's own packages from its copies
const exampleEngine = new Engine(createNodeHost({ baseDir: examplesDir }));
await exampleEngine.init();
openPackages(exampleEngine, examplesDir);

/** clean: an example that meets its card, which must cook without errors or warnings */
interface Case { name: string; graph: GraphSpec; engine: Engine; source: string; clean?: boolean }
const cases: Case[] = [];
for (const def of allNodeDefs()) {
  if (SKIP.has(def.type)) continue;
  cases.push({ name: `node.${def.type}`, graph: fixtureGraphFor(def.type), engine, source: `fixture for node type "${def.type}" (test/fixtures.ts)` });
}
for (const f of fs.readdirSync(examplesDir).filter((x) => x.endsWith('.json')).sort()) {
  const graph = JSON.parse(fs.readFileSync(path.join(examplesDir, f), 'utf8'));
  cases.push({ name: `example.${path.basename(f, '.json')}`, graph, engine: exampleEngine, source: `examples/${f}`, clean: !EXAMPLES_PENDING.has(path.basename(f, '.json')) });
}
// the example packages (examples/<name>/ with its own .topo, inputs/ and copies of TopoTopo's packages)
for (const ex of examplePackageGraphs()) {
  const e = new Engine(createNodeHost({ baseDir: ex.dir }));
  await e.init();
  openPackages(e, ex.dir);
  cases.push({ name: `example.${ex.name}`, graph: JSON.parse(fs.readFileSync(ex.file, 'utf8')), engine: e, source: path.relative(ROOT, ex.file).split(path.sep).join('/'), clean: !EXAMPLES_PENDING.has(ex.name) });
}
// test scenes: graphs kept for their coverage that are not examples (test/scenes/*.json)
const scenesDir = path.join(ROOT, 'test', 'scenes');
for (const f of fs.readdirSync(scenesDir).filter((x) => x.endsWith('.json')).sort()) {
  cases.push({ name: `scene.${path.basename(f, '.json')}`, graph: JSON.parse(fs.readFileSync(path.join(scenesDir, f), 'utf8')), engine, source: `test/scenes/${f}`, clean: true });
}
// the outputs of TopoTopo's own packages at their defaults (curve/surface outputs on their fixture inputs), and each
// each built-in package's default output, its line-up
for (const type of engine.packageDefs().map((d) => d.type).sort()) {
  cases.push({ name: `package.${type.replace(/\//g, '.')}`, graph: builtinFixtureGraph(type), engine, source: `${type} at its defaults (test/fixtures.ts)` });
}

/** The machine-dependent inputs a graph's output depends on (currently: the default system font). */
function envOf(c: Case): Record<string, string> | undefined {
  if (!graphIsEnvDependent(c.graph)) return undefined;
  const font = c.engine.host.findFont();
  return { font: font ? path.basename(font) : '(none)' };
}

async function record(c: Case) {
  const env = envOf(c);
  let r;
  try {
    r = await c.engine.cook(c.graph);
  } catch (e: any) {
    return { rec: null, problem: `engine threw: ${e?.stack ?? e}` };
  }
  const rec: any = {
    name: c.name,
    source: c.source,
    ok: r.ok,
    errors: r.errors.map((e) => `[${e.node}] ${e.message}`),
    warnings: r.warnings.map((w) => `[${w.node}] ${w.message}`),
    fingerprint: r.geo ? fingerprint(r.geo) : null,
  };
  if (env) rec.env = env;
  const inv = r.geo ? checkGeo(r.geo) : [];
  if (c.clean && (!r.ok || r.warnings.length)) inv.push(`an example that meets its card cooks without errors or warnings: ${[...rec.errors, ...rec.warnings].slice(0, 3).join('; ')}`);
  return { rec, problem: inv.length ? `invariants: ${inv.join(', ')}` : '' };
}

const selected = cases.filter((c) => !filter || c.name.includes(filter));
if (!selected.length) {
  console.log(`no golden cases match "${filter}"`);
  process.exit(1);
}
fs.mkdirSync(goldenDir, { recursive: true });

let pass = 0, fail = 0, skipped = 0, written = 0, unchanged = 0;
const t0 = performance.now();
for (const c of selected) {
  const file = path.join(goldenDir, `${c.name}.json`);
  const { rec, problem } = await record(c);
  if (!rec) { fail++; console.log(`FAIL ${c.name}: ${problem}`); continue; }
  if (problem) { fail++; console.log(`FAIL ${c.name}: ${problem}`); continue; }
  const text = sortedJSON(rec) + '\n';
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : null;

  if (update) {
    if (old === text) unchanged++;
    else {
      fs.writeFileSync(file, text);
      written++;
      console.log(`${old === null ? 'new ' : 'upd '} ${c.name}${old ? '\n' + formatDiff(diffFields(JSON.parse(old), rec), 10).join('\n') : ''}`);
    }
    continue;
  }
  if (old === null) {
    fail++;
    console.log(`FAIL ${c.name}: no golden file ${path.relative(ROOT, file)} (run: npm run test:update)`);
    continue;
  }
  const want = JSON.parse(old);
  if (want.env || rec.env) {
    const a = JSON.stringify(want.env ?? {}), b = JSON.stringify(rec.env ?? {});
    if (a !== b) {
      skipped++;
      console.log(`skip ${c.name}: machine-dependent output (golden made with ${a}, this machine has ${b})`);
      continue;
    }
  }
  const d = diffFields(want, rec);
  if (!d.length) { pass++; continue; }
  fail++;
  console.log(`FAIL ${c.name}: ${d.length} field(s) changed (golden → now)`);
  console.log(formatDiff(d).join('\n'));
}

// orphaned golden files (node removed or renamed) — only meaningful for unfiltered runs
if (!filter) {
  const live = new Set(cases.map((c) => `${c.name}.json`));
  for (const f of fs.readdirSync(goldenDir).filter((x) => x.endsWith('.json') && !live.has(x))) {
    if (update) { fs.unlinkSync(path.join(goldenDir, f)); console.log(`del  ${f}`); }
    else { fail++; console.log(`FAIL ${f}: golden file has no matching node type or example (run: npm run test:update)`); }
  }
}

const secs = ((performance.now() - t0) / 1000).toFixed(1);
if (update) console.log(`\ngolden: ${written} written, ${unchanged} unchanged, ${fail} failed (${selected.length} cases, ${secs}s)`);
else console.log(`\ngolden: ${pass} passed, ${fail} failed, ${skipped} skipped (${selected.length} cases, ${secs}s)${fail ? '\nIf the change is intended: npm run test:update, then review git diff test/golden (an example: its card checks, node test/cards.ts, say whether it still does the same job; look at its render, npm run showcase)' : ''}`);
process.exit(fail ? 1 : 0);
