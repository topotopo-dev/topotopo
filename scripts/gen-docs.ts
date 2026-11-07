// Generate docs/nodes.md (the node reference) from the registered NodeDefs and the outputs of TopoTopo's own packages,
// and docs/examples.md (the house rules of the examples, the card format and the list of examples) from the cards.
//   node scripts/gen-docs.ts            write both
//   node scripts/gen-docs.ts --check    exit 1 if either is stale
// test/docs.ts runs the same checks inside `npm test`: the reference cannot drift from the registry, nor the list from the cards.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../src/nodes/index.ts';
import { CATEGORY_ORDER, allNodeDefs } from '../src/graph/registry.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { PackageUses } from '../src/packages/registry.ts';
import { readExamples } from '../src/mcp/examples.ts';
import type { NodeDef, ParamDef } from '../src/graph/types.ts';

export const NODES_MD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'nodes.md');
export const EXAMPLES_MD = path.join(path.dirname(NODES_MD), 'examples.md');

/** Escape text for a Markdown table cell. */
const cell = (s: string) => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');

/** Inline code span that survives backticks in the content; pipes escaped for tables. */
function code(s: string): string {
  const fence = s.includes('`') ? '``' : '`';
  const pad = s.startsWith('`') || s.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${s.replace(/\|/g, '\\|')}${pad}${fence}`;
}

function defaultText(pd: ParamDef): string {
  if (pd.type === 'graph') return '{nodes, output}';
  if (pd.default === undefined) return '—';
  return code(JSON.stringify(pd.default));
}

function rangeText(pd: ParamDef): string {
  if (pd.min === undefined && pd.max === undefined) return '';
  return `${pd.min ?? ''}..${pd.max ?? ''}`;
}

function typeText(pd: ParamDef): string {
  let t = pd.type as string;
  if (pd.type === 'group' && pd.groupClass) t += ` (${pd.groupClass})`;
  return t;
}

function categoriesOf(defs: NodeDef[]): string[] {
  const extra = [...new Set(defs.map((d) => d.category))].filter((c) => !CATEGORY_ORDER.includes(c)).sort();
  return [...CATEGORY_ORDER, ...extra].filter((c) => defs.some((d) => d.category === c));
}

/** The anchor GitHub gives a heading: lower case, punctuation but - and _ dropped ("topotopo/nature/rock" → "topotoponaturerock"). */
export const anchorOf = (heading: string) => heading.toLowerCase().trim().replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '').replace(/ /g, '-');

/** The thumbnail of an output of one of TopoTopo's own packages, library/<name>/thumbs/<output>.png (repository path), or null. */
export function thumbOf(type: string): string | null {
  const m = /^topotopo\/([a-z0-9_-]+)\/([a-z0-9_-]+)$/.exec(type);
  return m ? `library/${m[1]}/thumbs/${m[2]}.png` : null;
}

function nodeSection(def: NodeDef): string[] {
  const out: string[] = [`### ${def.type}`, ''];
  const meta = [`category: ${code(def.category)}`];
  if (def.aliases?.length) meta.push(`aliases: ${def.aliases.map(code).join(', ')}`);
  // a package output: what it is and its tags, as its version records them
  if (def.package?.kind) meta.push(`kind: ${code(def.package.kind)}`);
  if (def.package?.tags?.length) meta.push(`tags: ${def.package.tags.map(code).join(', ')}`);
  out.push(meta.join(' · '), '', def.summary, '');
  const thumb = thumbOf(def.type);
  if (thumb && fs.existsSync(path.join(path.dirname(NODES_MD), '..', thumb))) out.push(`![${def.type}](../${thumb})`, '');
  if (def.description) out.push(def.description, '');

  out.push('**Inputs**', '');
  if (!def.inputs.length) out.push('None (generator).', '');
  else {
    out.push('| # | name | optional | multi | description |', '|---|---|---|---|---|');
    def.inputs.forEach((inp, i) => out.push(`| ${i} | ${code(inp.name)} | ${inp.optional ? 'yes' : 'no'} | ${inp.multi ? 'yes' : 'no'} | ${cell(inp.desc)} |`));
    out.push('');
  }

  out.push('**Parameters**', '');
  const params = Object.entries(def.params);
  if (!params.length) out.push('None.', '');
  else {
    out.push('| name | type | default | min..max | options | aliases | description |', '|---|---|---|---|---|---|---|');
    for (const [name, pd] of params) {
      const opts = pd.options?.length ? pd.options.map((o) => code(String(o))).join(', ') : '';
      const al = pd.aliases?.length ? pd.aliases.map(code).join(', ') : '';
      const desc = cell(pd.desc) + (pd.advanced ? ' *(advanced)*' : '');
      out.push(`| ${code(name)} | ${typeText(pd)} | ${defaultText(pd)} | ${rangeText(pd)} | ${opts} | ${al} | ${desc} |`);
    }
    out.push('');
  }

  if (def.outputs) out.push(`**Writes:** ${def.outputs}`, '');
  if (def.example) out.push('**Example**', '', '```json', JSON.stringify(def.example, null, 2), '```', '');
  return out;
}

/**
 * The outputs of TopoTopo's own packages as node definitions (category "package"): every output and each package's default
 * output, at the newest version TopoTopo's built-in library holds, as the catalog offers them outside a package.
 */
export async function builtinDefs(): Promise<NodeDef[]> {
  const engine = new Engine(createNodeHost({ workers: 0 }));
  await engine.init();
  const pk = new PackageUses(engine, null);
  engine.root.packages = pk.resolver;
  const defs = engine.packageDefs();
  if (pk.libraryProblems.length) throw new Error(`TopoTopo's own packages: ${pk.libraryProblems.join('; ')}`);
  return defs;
}

/** docs/nodes.md as it should be: every node type and every output of TopoTopo's own packages. */
export async function referenceMarkdown(): Promise<string> {
  return renderNodeReference(allNodeDefs(), await builtinDefs());
}

/**
 * The full Markdown reference for the given node definitions (default: every registered node type), followed by the
 * outputs of TopoTopo's own packages (category "package") when given.
 */
export function renderNodeReference(nodes: NodeDef[] = allNodeDefs(), packages: NodeDef[] = []): string {
  const defs = [...nodes, ...packages];
  const cats = categoriesOf(defs);
  // a fixed collation: localeCompare without a locale follows the machine's LANG (cs puts "ch" after "h")
  const byCat = new Map(cats.map((c) => [c, defs.filter((d) => d.category === c).sort((a, b) => a.type.localeCompare(b.type, 'en'))]));
  const out: string[] = [
    '<!-- Generated by scripts/gen-docs.ts from the node definitions. Do not edit by hand: run `npm run docs`. -->',
    '',
    '# TopoTopo node reference',
    '',
    `${nodes.length} node types${packages.length ? ` and ${packages.length} outputs of TopoTopo's own packages` : ''}. Node types and parameter names are case- and underscore-insensitive and accept the listed`,
    'aliases. Every parameter can also be an `"=expr"` string evaluated with the graph vars. The same definitions drive',
    'validation, the MCP `catalog`/`help` tools and this page.',
    '',
    '## Contents',
    '',
  ];
  for (const c of cats) out.push(`- [${c}](#${c}-nodes): ${byCat.get(c)!.map((d) => `[${d.type}](#${anchorOf(d.type)})`).join(' · ')}`);
  out.push('');
  for (const c of cats) {
    out.push(`## ${c} nodes`, '');
    if (c === 'package') {
      out.push('The outputs of TopoTopo\'s own packages, the packages of its built-in library ([library/](../library); see the README',
        'section "TopoTopo\'s own packages"), by full name; a built-in package\'s name alone is its default output, which lines its outputs up.',
        'A package\'s graph names one like any node, and its first use copies the built-in package\'s version into the package. Their',
        'parameters are the outputs\' typed vars; their inputs are the graphs\' `input` nodes. `assets {action: "fork"}`',
        'copies one\'s graph into the package\'s assets to edit.', '');
    }
    for (const def of byCat.get(c)!) out.push(...nodeSection(def));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/** A file's content with line endings normalised, or null when missing. */
export function readDoc(file: string): string | null {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : null;
}
export const readNodesMd = () => readDoc(NODES_MD);

/** docs/examples.md: what an example is, its house rules, the card format, what the tests check, and every example. */
export function examplesMarkdown(): string {
  const all = readExamples();
  const carded = all.filter((e) => e.card), bare = all.filter((e) => !e.card);
  const first = (s: string) => (/^(.+?[.!?])(\s|$)/s.exec(s.trim())?.[1] ?? s.trim()).replace(/\s+/g, ' ');
  const out = [
    '# Examples',
    '',
    '<!-- Generated by scripts/gen-docs.ts from the example cards (examples/*.md): edit a card or the generator, then run npm run docs. -->',
    '',
    'An example is a worked answer to a real request, complete from what goes in to a finished, exportable result. People',
    'and agents start from the examples (the MCP `help` tool: topic `examples` lists them, `{examples: ["name"]}` gives',
    'one; `topotopo --help-example name` on the command line), so each one is something to build on, not a demo.',
    '',
    'Each example is a pair in [examples/](../examples):',
    '',
    '- `<name>.md`, its **card**: what it does, in plain words. The card is the contract and changes only when we decide',
    '  the example should do something else.',
    '- `<name>.json`, its **graph**: today\'s way to meet the card (an example with input files of its own is a package',
    '  folder, `<name>/`, whose `.topo` names the graph). Anyone may rebuild the graph when TopoTopo offers a better way,',
    '  as long as the card\'s checks still pass.',
    '',
    '## House rules',
    '',
    '1. An example answers one real request, from start to a finished, exportable result.',
    '2. **In** lists the sliders a person would tune: 3 to 10 of them, each explained, with its range and default.',
    '3. **Out** lists named results, each with its kind (mesh, instances, terrain, …), ready to export: every piece is',
    '   named and has a material.',
    '4. Every **Promise** is checked by the graph itself, so a rewrite that breaks one fails right away.',
    '5. **Look** is judged by eye from the render after every change.',
    '6. The card is the contract and the graph is replaceable. Change the graph whenever TopoTopo offers a better way;',
    '   change the card only when the example should do something else.',
    '7. Adding an example means writing the card first, then building the graph. Removing one means deleting its card,',
    '   graph, render and golden fingerprint together.',
    '',
    '## The card',
    '',
    'A card has a title, the request in a sentence or two, and four sections in this order. It says *what*, never *how*: no',
    'node names and no technique, so the graph can change underneath it.',
    '',
    '```markdown',
    '# Forest on terrain',
    '',
    'A forest with rocks on rolling terrain, ready for a game engine.',
    '',
    '## In',
    '- seed: 0–9999, default 1. Changes the layout, not the look.',
    '- size: 50–500 m, default 200. Side of the square terrain.',
    '- tree_density: 0–1, default 0.6. How full the forest is.',
    '- max_slope: 10–60°, default 30. Steeper ground stays bare.',
    '',
    '## Out',
    '- terrain (terrain): the ground, with a ground material.',
    '- trees (instances): pine and birch trees, packed.',
    '- rocks (instances): rocks, packed.',
    '',
    '## Promises',
    '- slope: no tree or rock stands on ground steeper than max_slope.',
    '- inside: everything stays within the terrain.',
    '- full: at least 500 trees at the defaults.',
    '',
    '## Look',
    'A dense forest with clearings and rocks gathered on slopes. Nothing floats.',
    '```',
    '',
    '- **In**: `- name: what it changes`, with its range (`2–40 m`, `0 to 1`) or its options (`one of grass, sand or',
    '  snow`) and `default x` (a number, an option, `on` or `off`). Each name is one of the graph\'s params.',
    '- **Out**: `- name (kind): what it is`. Each name is one of the graph\'s named outputs; the kind is one of mesh,',
    '  instances, points, curves, terrain, textures, material, volume or scene.',
    '- **Promises**: `- key: what always holds`. Each key is the `label` of an `assert` node in the graph, upstream of an',
    '  output, that stops the cook when the promise breaks.',
    '- **Look**: a few sentences on what the render shows.',
    '',
    '## What the tests check',
    '',
    '`npm test` runs `test/cards.ts`, which reads every card and checks its graph against it:',
    '',
    '- every graph has a card and every card a graph;',
    '- **In**: the card\'s names are the graph\'s params, 3 to 10, each typed and described, with the range, default and',
    '  options the card gives; every param is read by an output;',
    '- **Out**: the card\'s names are the graph\'s named outputs, each with the kind the card gives, a label, three or',
    '  more tags and a description;',
    '- **Promises**: each key is an `assert` node that stops the cook (`on_fail: error`) and sits upstream of an output;',
    '- each output cooks at the defaults to its kind, with no errors and no warnings, and every mesh or scene piece has a',
    '  name and a material;',
    '- each output cooks again with every numeric param at its min and its max, every other option and every switch',
    '  flipped.',
    '',
    'The golden fingerprints (`test/golden.ts`) then say whether the geometry changed. After a graph is rebuilt or an',
    'algorithm improves, a changed fingerprint is expected: when the card checks pass, run `npm run test:update`, look at',
    'the render (`npm run showcase`, then `examples/renders/`) against the card\'s Look, and commit both. When they fail,',
    'the example no longer does its job.',
    '',
    '## The examples',
    '',
  ];
  for (const e of carded) {
    const c = e.card!;
    out.push(`### [${c.title}](../examples/${e.name}.md) (\`${e.name}\`)`, '', c.request, '',
      `- In: ${c.inputs.map((x) => `\`${x.name}\``).join(', ')}`,
      `- Out: ${c.outputs.map((x) => `\`${x.name}\` (${x.kind})`).join(', ')}`, '');
  }
  if (bare.length) {
    out.push(carded.length ? '### Without a card yet' : 'No example has its card yet. The graphs, until they do:', '');
    for (const e of bare) {
      const file = e.isPackage ? `${e.name}/` : `${e.name}.json`;
      const d = e.graph.description ?? e.graph.meta?.description;
      out.push(`- [\`${e.name}\`](../examples/${file})${d ? `: ${first(String(d))}` : ''}`);
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

// realpath on both sides: started through a symlinked path, argv[1] keeps the link while the module URL does not
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const docs: [string, string][] = [[NODES_MD, await referenceMarkdown()], [EXAMPLES_MD, examplesMarkdown()]];
  const rel = (f: string) => `docs/${path.basename(f)}`;
  if (process.argv.includes('--check')) {
    const stale = docs.filter(([f, md]) => readDoc(f) !== md).map(([f]) => rel(f));
    console.log(stale.length ? `${stale.join(', ')} stale: run npm run docs` : 'docs/nodes.md and docs/examples.md are up to date');
    process.exit(stale.length ? 1 : 0);
  }
  for (const [f, md] of docs) {
    const changed = readDoc(f) !== md;
    if (changed) fs.writeFileSync(f, md);
    console.log(`${changed ? 'wrote' : 'unchanged'} ${rel(f)} (${md.length} bytes)`);
  }
  console.log(`  ${allNodeDefs().length} node types + the outputs of TopoTopo's own packages; ${readExamples().length} examples`);
}
