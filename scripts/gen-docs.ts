// Generate docs/nodes.md (the node reference) from the registered NodeDefs and the outputs of TopoTopo's own packages.
//   node scripts/gen-docs.ts            write docs/nodes.md
//   node scripts/gen-docs.ts --check    exit 1 if docs/nodes.md is stale
// test/docs.ts runs the same check inside `npm test`, so the reference cannot drift from the registry.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../src/nodes/index.ts';
import { CATEGORY_ORDER, allNodeDefs } from '../src/graph/registry.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { ProjectPackages } from '../src/packages/registry.ts';
import type { NodeDef, ParamDef } from '../src/graph/types.ts';

export const NODES_MD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'nodes.md');

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

/** The thumbnail of an output of one of TopoTopo's own packages, library/<kit>/thumbs/<output>.png (repository path), or null. */
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
 * The outputs of TopoTopo's own packages as node definitions (category "package"): every output and each kit's default
 * output, at the newest version TopoTopo's built-in library holds, as the catalog offers them outside a project.
 */
export async function kitDefs(): Promise<NodeDef[]> {
  const engine = new Engine(createNodeHost({ workers: 0 }));
  await engine.init();
  const pk = new ProjectPackages(engine, null);
  engine.root.packages = pk.resolver;
  const defs = engine.packageDefs();
  if (pk.libraryProblems.length) throw new Error(`TopoTopo's own packages: ${pk.libraryProblems.join('; ')}`);
  return defs;
}

/** docs/nodes.md as it should be: every node type and every output of TopoTopo's own packages. */
export async function referenceMarkdown(): Promise<string> {
  return renderNodeReference(allNodeDefs(), await kitDefs());
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
      out.push('The outputs of TopoTopo\'s own packages, the kits in its built-in library ([library/](../library); see the README',
        'section "TopoTopo\'s own packages"), by full name; a kit\'s name alone is its default output, which lines its outputs up.',
        'A project\'s graph names one like any node, and its first use copies the kit\'s version into the project. Their',
        'parameters are the outputs\' typed vars; their inputs are the graphs\' `input` nodes. `assets {action: "fork"}`',
        'copies one\'s graph into the project\'s assets to edit.', '');
    }
    for (const def of byCat.get(c)!) out.push(...nodeSection(def));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/** Current file content with line endings normalised, or null when missing. */
export function readNodesMd(): string | null {
  return fs.existsSync(NODES_MD) ? fs.readFileSync(NODES_MD, 'utf8').replace(/\r\n/g, '\n') : null;
}

// realpath on both sides: started through a symlinked path, argv[1] keeps the link while the module URL does not
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const md = await referenceMarkdown();
  if (process.argv.includes('--check')) {
    const ok = readNodesMd() === md;
    console.log(ok ? 'docs/nodes.md is up to date' : 'docs/nodes.md is stale: run npm run docs');
    process.exit(ok ? 0 : 1);
  }
  const changed = readNodesMd() !== md;
  if (changed) fs.writeFileSync(NODES_MD, md);
  console.log(`${changed ? 'wrote' : 'unchanged'} docs/nodes.md (${allNodeDefs().length} node types + the outputs of TopoTopo's own packages, ${md.length} bytes)`);
}
