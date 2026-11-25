// The graphs printed in the recipes help topic cook as written.
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { getNodeDef } from '../src/graph/registry.ts';
import type { GraphSpec } from '../src/graph/types.ts';
import { exportGeometryAsync } from '../src/io/export.ts';
import { topicText } from '../src/mcp/docs.ts';
import { readExamples } from '../src/mcp/examples.ts';
import { RECIPES, recipesText } from '../src/mcp/recipes.ts';
import { checkGeo, createFixtureEngine } from './fixtures.ts';

let pass = 0, fail = 0;
function check(ok: boolean, text: string) {
  if (ok) pass++;
  else { fail++; console.log(`FAIL ${text}`); }
}

function* graphAndBodies(graph: GraphSpec): Generator<GraphSpec> {
  yield graph;
  for (const node of Object.values(graph.nodes)) {
    for (const value of Object.values(node.params ?? {})) {
      if (value && typeof value === 'object' && 'nodes' in value) yield* graphAndBodies(value as GraphSpec);
    }
  }
}

const { engine, tmp } = await createFixtureEngine();
async function writePlacementFiles() {
  fs.mkdirSync(path.join(tmp, 'pieces'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'inputs'), { recursive: true });
  const pieces: GraphSpec['nodes'] = {
    crate: { type: 'box', params: { size: [0.7, 0.6, 0.7], center: [0, 0.3, 0] } },
    barrel: { type: 'tube', params: { radius: 0.3, height: 0.85, center: [0, 0.425, 0] } },
  };
  for (const [name, node] of Object.entries(pieces)) {
    const result = await engine.cook({ nodes: { [name]: node }, output: name });
    if (!result.ok || !result.geo) throw new Error(`could not cook the ${name} fixture`);
    fs.writeFileSync(path.join(tmp, 'pieces', `${name}.glb`), await exportGeometryAsync(result.geo, 'glb'));
  }
  fs.writeFileSync(path.join(tmp, 'inputs', 'placements.json'), JSON.stringify([
    { P: [0, 0, 0], yaw: 15, pscale: 1, name: 'crate' },
    { P: [2, 0, 0], yaw: 45, pscale: 1.2, name: 'barrel' },
    { P: [0.8, 0, 1.2], yaw: -30, pscale: 0.8, name: 'crate' },
  ]));
}

const examples = new Set(readExamples().map((example) => example.name));
const exampleOnly = ['clean_asset_pipeline', 'weather_a_prop', 'street_from_packages'];
check(new Set(RECIPES.map((recipe) => recipe.name)).size === RECIPES.length, 'recipe names are unique');
check(isDeepStrictEqual(RECIPES.filter((recipe) => !recipe.graph).map((recipe) => recipe.name), exampleOnly), 'only the three full examples have no inline graph');
for (const { name, title, in: inputs, out, graph, example } of RECIPES) {
  check(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(name), `${name}: name is in snake_case`);
  for (const [label, line] of Object.entries({ title, in: inputs, out })) {
    check(!!line?.trim() && !/[\r\n]/.test(line), `${name}: ${label} is one non-empty line`);
  }
  check(!!(graph || example), `${name}: has a graph or an example`);
  if (example) check(examples.has(example), `${name}: example ${example} exists`);
  if (!graph) continue;

  const graphs = [...graphAndBodies(graph)];
  const nodes = graphs.flatMap((part) => Object.values(part.nodes));
  check(graphs.every((part) => !!part.output && Object.hasOwn(part.nodes, part.output)), `${name}: every graph has an output node`);
  check(nodes.length <= 12, `${name}: at most 12 nodes including body graphs (got ${nodes.length})`);
  const unknown = nodes.filter((node) => !getNodeDef(node.type)).map((node) => node.type);
  check(!unknown.length, `${name}: unknown node types: ${unknown.join(', ')}`);

  try {
    if (name === 'instance_a_placement_list') await writePlacementFiles();
    const result = await engine.cook(graph);
    const { geo } = result;
    check(result.ok && !!geo && !result.errors.length, `${name}: cooks without errors: ${result.errors.map((error) => `[${error.node}] ${error.message}`).join('; ')}`);
    check(!result.warnings.length, `${name}: cooks without warnings: ${result.warnings.map((warning) => `[${warning.node}] ${warning.message}`).join('; ')}`);
    if (!geo) continue;
    const problems = checkGeo(geo);
    check(!problems.length, `${name}: geometry invariants: ${problems.join(', ')}`);
    check(geo.numPoints > 0, `${name}: result has points`);
    if (name === 'instance_a_placement_list') check(geo.numPacked === 3, `${name}: three packed instances (got ${geo.numPacked})`);
    console.log(`${name}: ${nodes.length} nodes, ${geo.numPoints} points, ${geo.numPrims} primitives, ${result.ms.toFixed(1)} ms`);
  } catch (error) {
    check(false, `${name}: ${error}`);
  }
}

const rendered = recipesText();
const [intro, ...sections] = rendered.split(/\n(?=\d+\) )/);
check(intro === 'RECIPES (copy, then adapt)', 'the topic starts with the recipes heading');
check(topicText('recipes') === rendered, 'help returns the rendered topic');
check(sections.length === RECIPES.length, 'the topic has one numbered heading per recipe');
for (const [, names] of rendered.matchAll(/help \{examples:\[([^\]]*)\]\}/g)) {
  for (const [, example] of names.matchAll(/"([^"]+)"/g)) {
    check(examples.has(example), `the topic names an existing example: ${example}`);
  }
}
for (const [index, recipe] of RECIPES.entries()) {
  const [heading, inputs, output, ...rest] = (sections[index] ?? '').split('\n');
  check(heading === `${index + 1}) ${recipe.title}`, `${recipe.name}: numbered heading is in order`);
  check(inputs === ` in:  ${recipe.in}`, `${recipe.name}: in line is printed`);
  check(output === ` out: ${recipe.out}`, `${recipe.name}: out line is printed`);
  const metadata = rest.findIndex((line) => /^ (?:files:|whole graph:|- )/.test(line));
  const printed = (metadata < 0 ? rest : rest.slice(0, metadata)).join('\n');
  if (!recipe.graph) {
    check(!printed, `${recipe.name}: no inline graph is printed`);
    continue;
  }
  try {
    check(isDeepStrictEqual(JSON.parse(printed), recipe.graph), `${recipe.name}: printed graph matches the recipe data`);
  } catch (error) {
    check(false, `${recipe.name}: printed graph is not JSON: ${error}`);
  }
}

// Check what the prop recipe promises beyond a successful default cook.
const prop = RECIPES.find((recipe) => recipe.name === 'prop_variants_and_lods')?.graph;
check(!!prop, 'prop_variants_and_lods: has a complete recipe graph');
if (prop) {
  const { geo: instances } = await engine.cook(prop);
  const variants = instances?.packedSource && Array.from(instances.packedSource, (source) =>
    instances.packedSources[source]?.prims.get('name')?.get(0));
  check(isDeepStrictEqual(variants, ['wide', 'tall', 'wide']), 'prop_variants_and_lods: packed sources follow the point strings');

  const output = prop.outputs?.lods;
  const lods = output && await engine.cook(prop, { target: output.node });
  check(!!lods?.ok && !!lods.geo && !lods.warnings.length, 'prop_variants_and_lods: the named LOD output cooks without warnings');
  if (lods?.geo) {
    const triangles = lods.geo.detail.get('lod_tris')?.get(0) as number[] | undefined;
    check(triangles?.length === 3 && triangles[0] > triangles[1] && triangles[1] > triangles[2],
      'prop_variants_and_lods: each level has fewer triangles than the last');

    const { NodeIO } = await import('@gltf-transform/core');
    const bytes = await exportGeometryAsync(lods.geo, 'glb');
    const document = await new NodeIO().readBinary(bytes);
    const names = document.getRoot().listMeshes().map((mesh) => mesh.getName()).sort();
    check(isDeepStrictEqual(names, ['lamp_lod0', 'lamp_lod1', 'lamp_lod2']), 'prop_variants_and_lods: GLB has one mesh per level');
  }
}

console.log(`recipes: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
