// The examples (examples/ in the TopoTopo package) and their cards. An example is a worked answer to a real request,
// complete from what goes in to a finished result. Its card, examples/<name>.md, says in plain words what it does: the
// request it answers, what goes in (its params, the sliders a person tunes), what comes out (its named outputs and their
// kinds), what it promises (each promise guarded by an assert node of that label in its graph) and how it should look.
// The card is the contract; the graph beside it (examples/<name>.json, or the graph an example package examples/<name>/
// shows) is today's way to meet it, and may be rebuilt whenever TopoTopo offers a better way. test/cards.ts checks every
// graph against its card; help {topic:"examples"} lists the examples and help {examples:[name]} gives one.
//
// Card format (docs/examples.md):
//   # Title
//   The request, in a sentence or two.
//   ## In
//   - name: what it changes, its range ("2–40 m", "one of grass, sand"), "default x".
//   ## Out
//   - name (kind): what it is.
//   ## Promises
//   - key: what always holds.
//   ## Look
//   What the render shows.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GraphSpec } from '../graph/types.ts';
import { KINDS } from '../graph/outputs.ts';
import { didYouMean } from '../graph/params.ts';
import { graphLines } from './graphlines.ts';

export interface CardIn {
  name: string;
  text: string;
  /** the range the line gives ("2–40 m"), if any */
  min?: number;
  max?: number;
  /** the default the line gives: a number, a word (an option, on/off) or a quoted string */
  default?: number | string;
  /** the options the line gives ("one of grass, sand or snow") */
  options?: string[];
}
export interface CardOut { name: string; kind: string; text: string }
export interface CardPromise { key: string; text: string }
export interface Card { title: string; request: string; inputs: CardIn[]; outputs: CardOut[]; promises: CardPromise[]; look: string }

/** The sections of a card, in order. */
export const CARD_SECTIONS = ['In', 'Out', 'Promises', 'Look'] as const;
/** How many inputs a card lists (house rule 2; test/asset-checks.ts MIN_PARAMS, MAX_PARAMS hold the graph to the same). */
export const MIN_INPUTS = 3, MAX_INPUTS = 10;
const NAME = '[a-z][a-z0-9_]*';

/** A card's parts and what is wrong with its form (a problem names the section it is in). */
export function parseCard(source: string): { card: Card; problems: string[] } {
  const problems: string[] = [];
  const card: Card = { title: '', request: '', inputs: [], outputs: [], promises: [], look: '' };
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  const t = /^# (.+)$/.exec(lines[i] ?? '');
  if (!t) problems.push('the first line is the title: "# Title"');
  else { card.title = t[1].trim(); i++; }
  // the request: everything up to the first section
  const request: string[] = [];
  for (; i < lines.length && !lines[i].startsWith('## '); i++) request.push(lines[i]);
  card.request = request.join('\n').trim().replace(/\s*\n\s*/g, ' ');
  if (!card.request) problems.push('the request, a sentence or two under the title, is missing');
  // the sections, each its lines
  const sections = new Map<string, string[]>();
  let cur: string[] | null = null;
  for (; i < lines.length; i++) {
    const h = /^## (.+)$/.exec(lines[i]);
    if (h) {
      const name = h[1].trim();
      if (!(CARD_SECTIONS as readonly string[]).includes(name)) { problems.push(`unknown section "## ${name}": the sections are ${CARD_SECTIONS.map((s) => `## ${s}`).join(', ')}`); cur = null; continue; }
      if (sections.has(name)) problems.push(`section "## ${name}" twice`);
      sections.set(name, cur = []);
      continue;
    }
    if (/^# /.test(lines[i])) { problems.push(`a second title: "${lines[i]}"`); continue; }
    cur?.push(lines[i]);
  }
  const order = [...sections.keys()];
  if (order.join() !== CARD_SECTIONS.filter((s) => sections.has(s)).join()) problems.push(`the sections go in the order ${CARD_SECTIONS.join(', ')}`);
  for (const s of CARD_SECTIONS) if (!sections.has(s)) problems.push(`section "## ${s}" is missing`);

  /** The "- " items of a section, a line that continues an item (indented) joined to it. */
  const items = (s: string): string[] => {
    const out: string[] = [];
    for (const l of sections.get(s) ?? []) {
      if (l.startsWith('- ')) out.push(l.slice(2).trim());
      else if (/^\s+\S/.test(l) && out.length) out[out.length - 1] += ' ' + l.trim();
      else if (l.trim()) problems.push(`${s}: "${l.trim().slice(0, 60)}" is not an item ("- …")`);
    }
    return out;
  };
  const seen = (s: string, name: string, list: { name?: string; key?: string }[]) => {
    if (list.some((x) => (x.name ?? x.key) === name)) problems.push(`${s}: "${name}" twice`);
  };

  for (const it of items('In')) {
    const m = new RegExp(`^(${NAME}): (.+)$`).exec(it);
    if (!m) { problems.push(`In: "${it.slice(0, 60)}" is not "name: what it changes, range, default"`); continue; }
    seen('In', m[1], card.inputs);
    const x: CardIn = { name: m[1], text: m[2] };
    const r = /(-?\d+(?:\.\d+)?)\s*(?:–|—|\bto\b)\s*(-?\d+(?:\.\d+)?)/.exec(m[2]);
    if (r) { x.min = Number(r[1]); x.max = Number(r[2]); }
    const d = /\bdefault\s+(?:"([^"]*)"|(-?\d+(?:\.\d+)?)(?![\w])|([A-Za-z_][A-Za-z0-9_-]*))/.exec(m[2]);
    if (d) x.default = d[1] ?? (d[2] !== undefined ? Number(d[2]) : d[3]);
    const o = /\bone of (.+?)(?:,?\s+default\b|[.;]|$)/.exec(m[2]);
    if (o) x.options = o[1].split(/,\s*|\s+or\s+/).map((s) => s.trim()).filter(Boolean);
    // house rule 2: every slider has a default, inside its range or among its options
    if (x.default === undefined) problems.push(`In · ${x.name}: no default ("default 2", "default grass", "default on")`);
    else if (typeof x.default === 'number' && x.min !== undefined && (x.default < x.min || x.default > x.max!)) problems.push(`In · ${x.name}: default ${x.default} is outside ${x.min}–${x.max}`);
    else if (x.options && !x.options.includes(String(x.default))) problems.push(`In · ${x.name}: default ${x.default} is not one of ${x.options.join(', ')}`);
    card.inputs.push(x);
  }
  if (card.inputs.length && (card.inputs.length < MIN_INPUTS || card.inputs.length > MAX_INPUTS))
    problems.push(`In: ${MIN_INPUTS} to ${MAX_INPUTS} inputs, the sliders a person tunes (${card.inputs.length})`);
  for (const it of items('Out')) {
    const m = new RegExp(`^(${NAME}) \\(([a-z]+)\\): (.+)$`).exec(it);
    if (!m) { problems.push(`Out: "${it.slice(0, 60)}" is not "name (kind): what it is"`); continue; }
    if (!(KINDS as readonly string[]).includes(m[2])) problems.push(`Out: ${m[1]}: "${m[2]}" is not a kind (${KINDS.join(', ')})`);
    seen('Out', m[1], card.outputs);
    card.outputs.push({ name: m[1], kind: m[2], text: m[3] });
  }
  for (const it of items('Promises')) {
    const m = new RegExp(`^(${NAME}): (.+)$`).exec(it);
    if (!m) { problems.push(`Promises: "${it.slice(0, 60)}" is not "key: what always holds"`); continue; }
    seen('Promises', m[1], card.promises);
    card.promises.push({ key: m[1], text: m[2] });
  }
  card.look = (sections.get('Look') ?? []).join('\n').trim().replace(/\s*\n\s*/g, ' ');
  if (sections.has('In') && !card.inputs.length) problems.push('In: no inputs');
  if (sections.has('Out') && !card.outputs.length) problems.push('Out: no outputs');
  if (sections.has('Promises') && !card.promises.length) problems.push('Promises: no promises');
  if (sections.has('Look') && !card.look) problems.push('Look: empty');
  return { card, problems };
}

export interface Example {
  name: string;
  /** the folder the graph's relative paths read from: examples/, or the example package's own folder */
  dir: string;
  graphFile: string;
  graph: GraphSpec;
  /** examples/<name>.md, when there is one */
  cardFile: string | null;
  card: Card | null;
  cardProblems: string[];
  /** an example package (examples/<name>/ with its own .topo, graphs/ and inputs/) */
  isPackage: boolean;
}

/** The examples folder of this TopoTopo (beside src/ or dist/). */
export function examplesRoot(): string {
  return fileURLToPath(new URL('../../examples/', import.meta.url));
}

/**
 * Every example in a folder: each <name>.json graph, and each example package <name>/ (a .topo file and graphs/) by the
 * graph its manifest shows; each with its card <name>.md when there is one. Sorted by name.
 */
export function readExamples(root = examplesRoot()): Example[] {
  if (!fs.existsSync(root)) return [];
  const out: Example[] = [];
  const add = (name: string, dir: string, graphFile: string, isPackage: boolean) => {
    const cardFile = path.join(root, `${name}.md`);
    const has = fs.existsSync(cardFile);
    const parsed = has ? parseCard(fs.readFileSync(cardFile, 'utf8')) : null;
    let graph: GraphSpec;
    try { graph = JSON.parse(fs.readFileSync(graphFile, 'utf8')); } catch { return; }
    out.push({ name, dir, graphFile, graph, cardFile: has ? cardFile : null, card: parsed?.card ?? null, cardProblems: parsed?.problems ?? [], isPackage });
  };
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith('.json')) add(e.name.slice(0, -5), root, path.join(root, e.name), false);
    else if (e.isDirectory() && e.name !== 'packages' && e.name !== 'renders') {
      const dir = path.join(root, e.name);
      const topo = fs.readdirSync(dir).find((f) => f.endsWith('.topo'));
      if (!topo) continue;
      let shown = '';
      try { shown = String(JSON.parse(fs.readFileSync(path.join(dir, topo), 'utf8')).graph ?? ''); } catch { continue; }
      const file = path.join(dir, 'graphs', `${shown}.json`);
      if (shown && fs.existsSync(file)) add(e.name, dir, file, true);
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

/** The cards in a folder that no example graph has: examples/<name>.md without <name>.json or <name>/. */
export function orphanCards(root = examplesRoot()): string[] {
  if (!fs.existsSync(root)) return [];
  const names = new Set(readExamples(root).map((e) => e.name));
  return fs.readdirSync(root).filter((f) => f.endsWith('.md') && !names.has(f.slice(0, -3))).sort();
}

/** The first sentence of a text. */
const firstSentence = (s: string) => (/^(.+?[.!?])(\s|$)/s.exec(s.trim())?.[1] ?? s.trim()).replace(/\s+/g, ' ');

/** One example in a line or two: its request, what goes in and what comes out (its graph's description without a card). */
export function exampleSummary(e: Example): string {
  if (!e.card) return `- ${e.name} — ${firstSentence(e.graph.description ?? e.graph.meta?.description ?? '(no description)')}`;
  const ins = e.card.inputs.map((x) => x.name).join(', ');
  const outs = e.card.outputs.map((x) => `${x.name} (${x.kind})`).join(', ');
  return `- ${e.name} — ${e.card.request}\n    in: ${ins} · out: ${outs}`;
}

/** Help topic "examples": every example, those with a card first. */
export function examplesIndexText(root = examplesRoot()): string {
  const all = readExamples(root);
  const carded = all.filter((e) => e.card), bare = all.filter((e) => !e.card);
  const out = [
    'EXAMPLES: complete worked answers to real requests, from what goes in to a finished result.',
    'Each has a card (the request; In: the params a person tunes, with ranges and defaults; Out: its named outputs and',
    'their kinds; Promises: what always holds, each guarded by an assert node of that label; Look: what it shows) and',
    'its graph, today\'s way to meet the card. Starting something bigger than a node or two: take the closest example,',
    'help {examples:["name"]} gives its card and graph; build the graph as it is, then tune its params or rebuild parts.',
    '',
  ];
  if (carded.length) out.push(...carded.map(exampleSummary));
  if (bare.length) out.push('', `Without a card yet (graph and description only):`, ...bare.map(exampleSummary));
  if (!all.length) out.push('(no examples in this installation)');
  return out.join('\n');
}

/** help {examples:[name]}: an example's card, then its graph, one node per line; unknown names get a did-you-mean. */
export function exampleText(name: string, root = examplesRoot()): string {
  const all = readExamples(root);
  const e = all.find((x) => x.name === name);
  if (!e) {
    const s = didYouMean(name, all.map((x) => x.name));
    return `unknown example "${name}"${s.length ? ` — did you mean ${s.join(', ')}?` : ''} (help topic "examples" lists them)`;
  }
  const out = [`## ${e.name} (example)`];
  if (e.cardFile) out.push(fs.readFileSync(e.cardFile, 'utf8').replace(/\r\n/g, '\n').trim());
  else out.push(`No card yet. ${e.graph.description ?? e.graph.meta?.description ?? ''}`.trim());
  if (e.isPackage) {
    const inputs = path.join(e.dir, 'inputs');
    const files = fs.existsSync(inputs) ? fs.readdirSync(inputs).filter((f) => !f.startsWith('.')).sort() : [];
    out.push(`FOLDER: this example is a package of its own (examples/${e.name}/)${files.length ? `; its graph reads ${files.join(', ')} from its inputs/ folder: copy ${files.length === 1 ? 'that file' : 'those files'} into the package's inputs/ to cook it there` : ''}.`);
  }
  out.push('GRAPH (today\'s way to meet the card: build it as it is, then tune its params or rebuild parts):', graphLines(e.graph));
  return out.join('\n\n');
}
