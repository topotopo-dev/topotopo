// The example cards (docs/examples.md, src/mcp/examples.ts): every example in examples/ has a card, examples/<name>.md,
// that says in plain words what goes in, what comes out, what it promises and how it looks, and its graph meets it.
// The card is the contract; the graph is today's way to meet it, rebuilt whenever TopoTopo offers a better way, and
// these checks are what tells a rebuilt graph still does the same job.
//   node test/cards.ts [filter]
// Per example (a failure names the card section it breaks: "forest · Promises · slope: …"):
// - Card: the form (title, request, the sections In, Out, Promises, Look and an optional Cook in that order, their items).
// - In: the graph's params are the card's inputs, 3–10 of them, typed and described, a default equal to the var, numbers
//   with a range around it; a range, default or options the card gives are the param's; every one is read by an output.
// - Out: the graph's named outputs are the card's, with the card's kind pinned, a label and at least 3 tags; the
//   graph's default output is one of them.
// - Promises: each key is the label of an assert node (on_fail "error") upstream of an output, so a cook that breaks the
//   promise fails.
// - Cook: every output cooks at the defaults (cold, at meta.frame; together within COOK_SECONDS, or the longer limit,
//   at most MAX_COOK_SECONDS, a simulation's card gives with its reason) without errors or warnings, to its kind; meshes and scenes name every piece and give it a material the material table defines.
// - Sweep: every numeric param at its min and max, every option, every switch flipped: every output cooks without
//   errors (so every promise holds), meshes and scenes still name and dress every piece.
// The examples on EXAMPLES_PENDING (test/fixtures.ts) are skipped until they meet a card (the form of a card they
// already have is checked), and the list only shrinks: a name on it that meets its card, or is no example, fails. A card
// without a graph fails, unless it is on CARDS_WAITING (its graph is being built; its form is checked), a list that
// only shrinks too. The help text names examples by name (help {examples:[…]}), never by a file path, and only
// examples that exist.
// The checks check themselves first: a small example in a temp folder meets its card, and each way of breaking it fails.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { openPackages } from '../src/packages/registry.ts';
import { outputFieldIssues } from '../src/graph/outputs.ts';
import { varsRead } from '../src/graph/packages.ts';
import { outputKind, publishedKind } from '../src/io/kinds.ts';
import { INSTRUCTIONS, TOPICS } from '../src/mcp/docs.ts';
import { COOK_SECONDS, orphanCards, parseCard, readExamples } from '../src/mcp/examples.ts';
import type { Example } from '../src/mcp/examples.ts';
import type { GraphSpec, NodeSpec } from '../src/graph/types.ts';
import { CARDS_WAITING, EXAMPLES_PENDING, ROOT } from './fixtures.ts';
import { NUMERIC, namingProblems, paramProblems, sweepOf } from './asset-checks.ts';

const filter = process.argv.slice(2).find((a) => !a.startsWith('--'));
let fails = 0;
const fail = (msg: string) => { fails++; console.log('FAIL ' + msg); };

/** The node names a node reads from (its "in", in any of its forms). */
function inputsOf(n: NodeSpec): string[] {
  const i = n.in;
  if (!i) return [];
  if (typeof i === 'string') return [i];
  return (Array.isArray(i) ? i : Object.values(i)).filter((x): x is string => typeof x === 'string');
}

/** Every node an output node cooks from, itself among them. */
function upstream(graph: GraphSpec, node: string): Set<string> {
  const seen = new Set<string>(), todo = [node];
  while (todo.length) {
    const n = todo.pop()!;
    if (seen.has(n) || !graph.nodes[n]) continue;
    seen.add(n);
    todo.push(...inputsOf(graph.nodes[n]));
  }
  return seen;
}

/** A card's default as the param's value: on/off for a switch, a number, a word or quoted text. */
function cardDefault(x: string | number, type: string | undefined): unknown {
  if (type === 'bool' && typeof x === 'string') return /^(on|yes|true)$/i.test(x) ? true : /^(off|no|false)$/i.test(x) ? false : x;
  return x;
}

/** What is wrong with an example against its card: messages "Section · item: …" (none: it meets its card). */
async function checkExample(e: Example, engine: Engine): Promise<{ problems: string[]; ms: number; variants: number }> {
  const problems: string[] = [];
  const p = (s: string) => problems.push(s);
  if (!e.card) return { problems: ['Card: there is no card (examples/' + e.name + '.md)'], ms: 0, variants: 0 };
  const card = e.card, graph = e.graph;
  for (const x of e.cardProblems) p(`Card: ${x}`);

  // ---- In: the params
  const vars = graph.vars ?? {}, params = graph.params ?? {};
  for (const x of paramProblems(graph)) p(`In: ${x}`);
  for (const x of card.inputs) {
    const pd = params[x.name];
    if (!pd) { p(`In · ${x.name}: on the card, but the graph has no param of that name`); continue; }
    if (x.min !== undefined && NUMERIC.has(pd.type ?? '') && (pd.min !== x.min || pd.max !== x.max))
      p(`In · ${x.name}: the card says ${x.min}–${x.max}, the param ${pd.min}–${pd.max}`);
    if (x.default !== undefined) {
      const want = cardDefault(x.default, pd.type);
      if (JSON.stringify(want) !== JSON.stringify(pd.default)) p(`In · ${x.name}: the card says default ${JSON.stringify(want)}, the param ${JSON.stringify(pd.default)}`);
    }
    if (x.options && pd.type === 'enum' && JSON.stringify([...x.options].sort()) !== JSON.stringify([...(pd.options ?? [])].map(String).sort()))
      p(`In · ${x.name}: the card says one of ${x.options.join(', ')}, the param ${(pd.options ?? []).join(', ')}`);
  }
  for (const name of Object.keys(vars)) if (!card.inputs.some((x) => x.name === name)) p(`In · ${name}: a param of the graph, not on the card`);

  // ---- Out: the named outputs
  const outs = graph.outputs ?? {};
  for (const x of card.outputs) {
    const o = outs[x.name];
    if (!o) { p(`Out · ${x.name}: on the card, but the graph publishes no output of that name`); continue; }
    if (o.kind !== x.kind) p(`Out · ${x.name}: the card says ${x.kind}, the graph pins ${o.kind ?? 'no kind'}`);
    if (!o.label) p(`Out · ${x.name}: needs a label`);
    if ((o.tags?.length ?? 0) < 3) p(`Out · ${x.name}: needs at least 3 tags (${o.tags?.join(', ') ?? 'none'})`);
    for (const i of outputFieldIssues(o)) p(`Out · ${x.name}: ${i.message}`);
    if (!graph.nodes[o.node]) p(`Out · ${x.name}: its node "${o.node}" is not in the graph`);
  }
  for (const name of Object.keys(outs)) if (!card.outputs.some((x) => x.name === name)) p(`Out · ${name}: published by the graph, not on the card`);
  if (!graph.output || !Object.values(outs).some((o) => o.node === graph.output)) p(`Out: the graph's default output "${graph.output ?? '(none)'}" is not the node of one of its named outputs`);
  const read = new Set(Object.values(outs).flatMap((o) => (graph.nodes[o.node] ? varsRead(graph, o.node) : [])));
  for (const name of Object.keys(vars)) if (card.inputs.some((x) => x.name === name) && !read.has(name)) p(`In · ${name}: no output reads it`);

  // ---- Promises: an assert node each, on the way to an output, failing the cook when broken
  const reach = new Set(Object.values(outs).flatMap((o) => [...upstream(graph, o.node)]));
  for (const x of card.promises) {
    const asserts = Object.entries(graph.nodes).filter(([, n]) => n.type === 'assert' && n.params?.label === x.key);
    if (!asserts.length) { p(`Promises · ${x.key}: no assert node labelled "${x.key}"`); continue; }
    for (const [id, n] of asserts) {
      const on = n.params?.on_fail ?? 'error';
      if (on !== 'error') p(`Promises · ${x.key}: assert "${id}" has on_fail "${on}": a broken promise must fail the cook ("error")`);
      if (!reach.has(id)) p(`Promises · ${x.key}: assert "${id}" is upstream of no output, so no cook checks it`);
    }
  }

  // ---- Cook: the defaults, cold
  const frame = graph.meta?.frame;
  const cookAll = async (over: Record<string, any> | null, where: string, strict: boolean) => {
    for (const x of card.outputs) {
      const o = outs[x.name];
      if (!o || !graph.nodes[o.node]) continue;
      const r = await engine.cook(graph, { target: o.node, vars: over ? { ...vars, ...over } : undefined, frame });
      const at = `${where} · ${x.name}`;
      if (!r.ok || !r.geo) { p(`${at}: ${r.errors.map((i) => `[${i.node}] ${i.message}`).join('; ').slice(0, 400) || 'no geometry'}`); continue; }
      if (strict) for (const w of r.warnings.slice(0, 3)) p(`${at}: warning [${w.node}] ${w.message}`);
      const kind = publishedKind(outputKind(r.geo));
      if (strict && kind !== x.kind) p(`${at}: cooks to ${kind ?? 'nothing'}, the card says ${x.kind}`);
      if (x.kind === 'mesh' || x.kind === 'scene') for (const n of namingProblems(r.geo)) p(`${at}: ${n}`);
    }
  };
  engine.cache.clear();
  const t0 = performance.now();
  await cookAll(null, 'Cook', true);
  const ms = performance.now() - t0;
  const limit = (card.cook?.seconds ?? COOK_SECONDS) * 1000;
  if (ms > limit) p(`Cook: the default cook took ${ms.toFixed(0)} ms (limit ${limit}${card.cook ? ', from the card' : ''}): make the defaults lighter`);

  // ---- Sweep: every param at its ends, every option, every switch flipped
  const sweep = sweepOf(graph);
  for (const [label, over] of sweep) await cookAll(over, `Sweep · ${label}`, false);
  return { problems, ms, variants: sweep.length };
}

// ---- the checks check themselves: a small example meets its card, and each way of breaking it fails as it should
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'topotopo-cards-'));
  const engine = new Engine(createNodeHost({ baseDir: tmp }));
  await engine.init();
  const graph: GraphSpec = {
    description: 'A plain crate: a box of the chosen size, named and given a wood material.',
    params: {
      width: { type: 'float', default: 1, min: 0.3, max: 3, desc: 'width and depth (m)' },
      height: { type: 'float', default: 0.8, min: 0.2, max: 2, desc: 'height (m)' },
      lid: { type: 'bool', default: true, desc: 'a lid on top, 5 cm' },
    },
    vars: { width: 1, height: 0.8, lid: true },
    nodes: {
      body: { type: 'box', params: { size: ['=width', '=height + (lid ? 0.05 : 0)', '=width'], center: [0, '=(height + (lid ? 0.05 : 0)) / 2', 0] } },
      named: { type: 'attrib_create', in: ['body'], params: { name: 'name', class: 'prim', value: 'crate_body' } },
      wood: { type: 'material', in: ['named'], params: { name: 'wood', base_color: '#9a7148' } },
      closed: { type: 'assert', in: ['wood'], params: { label: 'closed', watertight: true } },
      small: { type: 'assert', in: ['closed'], params: { label: 'small', bbox_max: [1.6, 2.1, 1.6] } },
    },
    output: 'small',
    outputs: { crate: { node: 'small', label: 'Crate', kind: 'mesh', tags: ['crate', 'prop', 'wood'] } },
  };
  const card = `# Plain crate

A plain wooden crate of a chosen size.

## In
- width: 0.3–3 m, default 1. Width and depth.
- height: 0.2–2 m, default 0.8. Height of the box.
- lid: on or off, default on. A lid on top.

## Out
- crate (mesh): the crate, one closed piece in wood.

## Promises
- closed: the crate is one closed piece.
- small: it fits within 3.2 × 2.1 × 3.2 m.

## Look
A light brown box standing on the ground.
`;
  let runs = 0;
  const run = async (label: string, g: GraphSpec, c: string, want: RegExp | null, extra?: [string, string]) => {
    runs++;
    for (const f of fs.readdirSync(tmp)) if (/\.(json|md)$/.test(f)) fs.rmSync(path.join(tmp, f));
    fs.writeFileSync(path.join(tmp, 'crate.json'), JSON.stringify(g));
    fs.writeFileSync(path.join(tmp, 'crate.md'), c);
    if (extra) fs.writeFileSync(path.join(tmp, extra[0]), extra[1]);
    const ex = readExamples(tmp).find((x) => x.name === 'crate')!;
    const got = [...(await checkExample(ex, engine)).problems, ...orphanCards(tmp).map((f) => `Card: ${f} has no graph`)];
    if (process.env.CARDS_DEBUG) console.log(`  ${label}: ${got.join(' | ') || '(meets its card)'}`);
    if (want === null) { if (got.length) fail(`self-check "${label}": the small example should meet its card, got: ${got.join(' | ')}`); }
    else if (!got.some((x) => want.test(x))) fail(`self-check "${label}": expected a problem matching ${want}, got: ${got.join(' | ') || 'none'}`);
  };
  const g = () => structuredClone(graph);
  const without = (n: string) => { const x = g(); x.nodes.closed.in = ['named']; delete x.nodes[n]; return x; };
  await run('meets its card', g(), card, null);
  await run('a slider renamed', g(), card.replace('- width:', '- size:'), /^In · size: on the card, but the graph has no param/);
  await run('a range that differs', g(), card.replace('0.3–3 m', '0.5–3 m'), /^In · width: the card says 0\.5–3, the param 0\.3–3/);
  await run('a default that differs', g(), card.replace('default on', 'default off'), /^In · lid: the card says default false/);
  await run('a param not on the card', g(), card.replace(/- lid:.*\n/, ''), /^In · lid: a param of the graph, not on the card/);
  await run('an output of the wrong kind', g(), card.replace('crate (mesh)', 'crate (instances)'), /^Out · crate: the card says instances, the graph pins mesh/);
  await run('an output missing', g(), card.replace('## Promises', '- lid (mesh): the lid.\n\n## Promises'), /^Out · lid: on the card, but the graph publishes no output/);
  await run('a promise without an assert', g(), card.replace('## Look', '- level: the top is level.\n\n## Look'), /^Promises · level: no assert node labelled "level"/);
  await run('a promise that only warns', (() => { const x = g(); x.nodes.small.params!.on_fail = 'warn'; return x; })(), card, /^Promises · small: assert "small" has on_fail "warn"/);
  await run('a broken promise', (() => { const x = g(); x.nodes.small.params!.bbox_max = [0.4, 2.1, 0.4]; return x; })(), card, /^Cook · crate: .*small/);
  await run('a promise broken at a slider end', (() => { const x = g(); x.nodes.small.params!.bbox_max = [1.2, 2.1, 1.2]; return x; })(), card, /^Sweep · width=3 · crate: .*small/);
  await run('a piece without a material', without('wood'), card, /^Cook · crate: no prim string attribute "material"/);
  await run('a warning', (() => { const x = g(); x.nodes.body.params!.divisions = [0, 1, 1]; return x; })(), card, /^Cook · crate: warning /);
  await run('no Look', g(), card.replace(/## Look[\s\S]*$/, ''), /^Card: section "## Look" is missing/);
  await run('a slider without a default', g(), card.replace(', default 0.8', ''), /^Card: In · height: no default/);
  await run('a default outside its range', g(), card.replace('default 1.', 'default 4.'), /^Card: In · width: default 4 is outside 0\.3–3/);
  await run('a longer cook with its reason', g(), card + '\n## Cook\nUp to 6 s: it settles the lid over 40 frames.\n', null);
  await run('a cook limit over the most', g(), card + '\n## Cook\nUp to 12 s: it settles the lid over 400 frames.\n', /^Card: Cook: 12 s, a limit above the usual 3 s and at most 10 s/);
  await run('a longer cook without a reason', g(), card + '\n## Cook\nUp to 6 s.\n', /^Card: Cook: say why/);
  await run('a card without a graph', g(), card, /^Card: lonely\.md has no graph/, ['lonely.md', card]);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`cards: the checks catch what they should (${fails ? 'NOT ALL' : `all ${runs} self-checks`})`);
}

// ---- the examples
const root = path.join(ROOT, 'examples');
const examples = readExamples(root);
const names = new Set(examples.map((e) => e.name));
// cards waiting for their graph: their form now, their graph later
let waiting = 0;
for (const f of orphanCards(root)) {
  const n = f.replace(/\.md$/, '');
  if (!CARDS_WAITING.has(n)) { fail(`examples/${f}: a card without a graph (examples/${n}.json or examples/${n}/; a card whose graph is being built goes on CARDS_WAITING in test/fixtures.ts)`); continue; }
  waiting++;
  for (const x of parseCard(fs.readFileSync(path.join(root, f), 'utf8')).problems) fail(`${n} · Card: ${x}`);
}
for (const n of CARDS_WAITING) {
  if (names.has(n)) fail(`CARDS_WAITING (test/fixtures.ts) names "${n}", which has its graph now: take it off`);
  else if (!fs.existsSync(path.join(root, `${n}.md`))) fail(`CARDS_WAITING (test/fixtures.ts) names "${n}", which has no card: take it off`);
}
for (const n of EXAMPLES_PENDING) if (!names.has(n)) fail(`EXAMPLES_PENDING (test/fixtures.ts) names "${n}", which is no example: take it off`);

const flatEngine = new Engine(createNodeHost({ baseDir: root }));
await flatEngine.init();
openPackages(flatEngine, root);
let met = 0, pending = 0;
for (const e of examples) {
  if (filter && !e.name.includes(filter)) continue;
  const isPending = EXAMPLES_PENDING.has(e.name);
  if (isPending && !e.card) { pending++; continue; }
  let engine = flatEngine;
  if (e.isPackage) {
    engine = new Engine(createNodeHost({ baseDir: e.dir }));
    await engine.init();
    openPackages(engine, e.dir);
  }
  const r = await checkExample(e, engine);
  if (isPending) {
    pending++;
    // the card comes before its graph: its form fails now, the graph's mismatches wait
    for (const x of r.problems.filter((x) => x.startsWith('Card: '))) fail(`${e.name} · ${x}`);
    if (!r.problems.length) fail(`${e.name}: meets its card, so take it off EXAMPLES_PENDING (test/fixtures.ts)`);
    else if (filter) console.log(`pending ${e.name}: ${r.problems.length} problem(s):\n  ${r.problems.join('\n  ')}`);
    else console.log(`pending ${e.name}: ${r.problems.length} problem(s), first: ${r.problems[0]} (node test/cards.ts ${e.name}: all)`);
    continue;
  }
  if (r.problems.length) for (const x of r.problems) fail(`${e.name} · ${x}`);
  else { met++; console.log(`ok   ${e.name}: default cook ${r.ms.toFixed(0)} ms, ${r.variants} variants`); }
}

// ---- the help text names examples by name, and only examples that exist
const help = [INSTRUCTIONS, ...Object.values(TOPICS)].join('\n');
const paths = [...new Set([...help.matchAll(/examples\/[A-Za-z0-9_.-]+\.json/g)].map((m) => m[0]))];
if (paths.length) fail(`the help text points at example files (${paths.join(', ')}): name them, help {examples:["name"]}`);
const named = [...help.matchAll(/help \{examples:\s*\[([^\]]*)\]\}/g)].flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
const unknown = [...new Set(named.filter((n) => n !== 'name' && !names.has(n)))];
if (unknown.length) fail(`the help text names examples that do not exist: ${unknown.join(', ')}`);

console.log(`\ncards: ${examples.length} examples, ${met} meet their card, ${pending} pending, ${waiting} card(s) waiting for a graph, ${fails} failed`);
process.exit(fails ? 1 : 0);
