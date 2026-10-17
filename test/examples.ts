// Node examples: every built-in node type carries an `example` (shown by `help` and in docs/nodes.md) and it cooks.
//   node test/examples.ts [filter]
// An example is either one node spec ({type, in?, params}) or a small graph ({nodes, output}).
// - A node spec documents params: it cooks as the node under test on its fixture inputs (test/fixtures.ts), with the
//   example's params on top of the node's defaults. Its `in` names are illustrative and are not wired.
// - A graph cooks as it is and must contain the node type (directly or in a nested body graph).
// Either way the cook must succeed without errors or warnings and the result must pass the geometry invariants (an
// example is what `help` shows: it must not teach a graph that warns). Files the examples
// name (images, meshes) are written to the engine's temp dir from the test fixtures, and graph_ref resolves every
// workspace graph name to a small terrain graph. Shelf assets are covered by test/shelf.ts.
import fs from 'node:fs';
import path from 'node:path';
import { allNodeDefs, getNodeDef } from '../src/graph/registry.ts';
import type { GraphSpec, NodeDef, NodeSpec } from '../src/graph/types.ts';
import { checkGeo, createFixtureEngine, fixtureGraphFor } from './fixtures.ts';

const filter = process.argv.slice(2).find((a) => !a.startsWith('--'));
const { engine, tmp, objPath } = await createFixtureEngine();

// files the examples read, by node type: the fixture file of the same kind
const FIXTURE_FILES: Record<string, string> = {
  file: objPath,
  heightfield_from_image: path.join(tmp, 'height16.png'),
  attribute_from_map: path.join(tmp, 'colormap.png'),
  image_file: path.join(tmp, 'colormap.png'),
};
// graph_ref: any workspace graph name resolves to this graph (node "ground" is its output)
const REF_GRAPH: GraphSpec = {
  vars: { seed: 1 },
  nodes: { ground: { type: 'terrain', params: { size: [10, 10], divisions: [20, 20], seed: '=seed' } } },
  output: 'ground',
};
(engine as any).graphResolver = () => structuredClone(REF_GRAPH);

const isGraph = (x: any): x is GraphSpec => !!x && typeof x === 'object' && !!x.nodes && typeof x.nodes === 'object';

/** Every node spec of a graph, including those of nested body graphs (foreach, solver). */
function specsOf(g: GraphSpec): NodeSpec[] {
  const out: NodeSpec[] = [];
  for (const s of Object.values(g.nodes)) {
    out.push(s);
    for (const v of Object.values(s?.params ?? {})) if (isGraph(v)) out.push(...specsOf(v));
  }
  return out;
}

/** Copy the fixture file to the relative path an example names (absolute paths and URLs are left alone). */
function provideFiles(specs: NodeSpec[]) {
  for (const s of specs) {
    const type = getNodeDef(s.type)?.type ?? '';
    const p = s.params?.path;
    if (!FIXTURE_FILES[type] || typeof p !== 'string' || !p || path.isAbsolute(p) || /^\w+:\/\//.test(p)) continue;
    const dst = path.join(tmp, p);
    if (fs.existsSync(dst)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(FIXTURE_FILES[type], dst);
  }
}

/** The graph that cooks def's example, or a problem. */
function exampleGraph(def: NodeDef): GraphSpec | string {
  const ex = def.example;
  if (ex === undefined || ex === null) return 'no example';
  if (typeof ex !== 'object' || Array.isArray(ex)) return 'example must be a node spec or a graph';
  if (JSON.stringify(ex) !== JSON.stringify(structuredClone(ex))) return 'example is not plain JSON';
  if (isGraph(ex)) {
    const g = structuredClone(ex);
    if (!specsOf(g).some((s) => getNodeDef(s.type)?.type === def.type)) return `example graph has no ${def.type} node`;
    if (g.output !== undefined && !g.nodes[g.output]) return `example graph output "${g.output}" is not a node`;
    return g;
  }
  if (getNodeDef(ex.type)?.type !== def.type) return `example type "${ex.type}" is not ${def.type}`;
  const g = fixtureGraphFor(def.type);
  g.nodes.target.params = structuredClone(ex.params ?? {});
  return g;
}

let pass = 0, fail = 0;
for (const def of allNodeDefs()) {
  if (filter && !def.type.includes(filter)) continue;
  const g = exampleGraph(def);
  if (typeof g === 'string') { fail++; console.log(`FAIL ${def.type}: ${g}`); continue; }
  provideFiles(specsOf(g));
  try {
    const r = await engine.cook(g);
    if (!r.ok || !r.geo) { fail++; console.log(`FAIL ${def.type}: ${r.errors.map((e) => `[${e.node}] ${e.message}`).join('; ')}`); continue; }
    const inv = checkGeo(r.geo);
    if (inv.length) { fail++; console.log(`FAIL ${def.type}: invariants: ${inv.join(', ')}`); continue; }
    if (r.warnings.length) {
      fail++;
      // every shipped example cooks without warnings since R-12; node types added later (the phase 3 simulation
      // nodes and any other) must keep it that way
      console.log(`FAIL ${def.type}: the example cooks with warnings; every node's example must cook without warnings, new node types included (change the example's params or inputs, or the node): ${r.warnings.map((w) => `[${w.node}] ${w.message}`).join('; ')}`);
      continue;
    }
    pass++;
    console.log(`ok   ${def.type.padEnd(26)} ${String(r.geo.numPoints).padStart(7)} pts ${String(r.geo.numPrims).padStart(7)} prims${r.geo.volumes.length ? ` ${r.geo.volumes.length} vol` : ''}`);
  } catch (e: any) {
    fail++;
    console.log(`FAIL ${def.type}: threw ${e?.stack ?? e}`);
  }
}
console.log(`\nexamples: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
