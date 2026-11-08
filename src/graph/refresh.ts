// Refreshing a generated graph: a generator (a script, an LLM) rewrites a graph that a person has been tuning. The
// generator owns the structure (nodes and wiring, output, outputs, the vars it declares, their types, ranges, options and
// defaults); the person owns the var values they changed, the labels and steps of their controls, the controls they
// added for the generator's vars, node "ui" and the meta keys the generator does not set.
//
// A var value is the person's when it differs from what the generator gave last time: each refresh records the
// generator's var values in meta.generated_vars, so a value nobody touched follows the generator's new value. Without
// that record (the first refresh) every saved value counts as the person's. A kept value must still fit the new
// declaration (same kind of value, an int for an int, one of the options); one that no longer fits takes the
// generator's value and is reported. min/max are no fit: they are the slider's range, and a person may go past it.
import type { GraphSpec, VarDef } from './types.ts';

/** meta key holding the var values the last refresh took from the generator */
export const GENERATED_VARS = 'generated_vars';

export interface RefreshResult {
  graph: GraphSpec;
  /** var values kept from the current graph, as "name=value (generator: value)" */
  kept: string[];
  /** saved values that no longer fit the generator's declaration, with the reason */
  reset: string[];
  /** vars the generator no longer has */
  dropped: string[];
  /** controls, node ui and meta keys kept from the current graph */
  carried: string[];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const show = (v: unknown) => JSON.stringify(v);
const kindOf = (v: unknown) => (Array.isArray(v) ? `a ${v.length}-vector` : v === null ? 'null' : typeof v === 'number' ? 'a number' : typeof v === 'string' ? 'a string' : typeof v === 'boolean' ? 'a boolean' : typeof v);
const has = (o: object | undefined, k: string) => !!o && Object.hasOwn(o, k);

/** The var names a graph declares: its vars and its params. */
function declared(g: GraphSpec): string[] {
  return [...new Set([...Object.keys(g.vars ?? {}), ...Object.keys(g.params ?? {})])];
}

/** The value a graph gives var k: its vars entry, else its params default. */
function valueOf(g: GraphSpec, k: string): unknown {
  return has(g.vars, k) ? g.vars![k] : g.params?.[k]?.default;
}

/** Why `v` does not fit as var k next to the generator's value `gv` and declaration `vd`, or null when it fits. */
function misfit(v: unknown, gv: unknown, vd: VarDef | undefined): string | null {
  if (gv !== undefined && kindOf(v) !== kindOf(gv)) return `${kindOf(v)} where the generator gives ${kindOf(gv)}`;
  if (vd?.options?.length && !vd.options.some((o) => same(o, v))) return `not one of the options ${vd.options.map(show).join(', ')}`;
  const nums = typeof v === 'number' ? [v] : Array.isArray(v) ? v.filter((x) => typeof x === 'number') : [];
  if (vd?.type === 'int' && nums.some((x) => !Number.isInteger(x))) return 'not a whole number (the var is an int)';
  return null;
}

/** The generated graph with the person's work on the current graph carried over (see the top of this file). */
export function refreshGraph(current: GraphSpec, generated: GraphSpec): RefreshResult {
  const g: GraphSpec = structuredClone(generated);
  const kept: string[] = [], reset: string[] = [], dropped: string[] = [], carried: string[] = [];
  const names = declared(generated), base = current.meta?.[GENERATED_VARS] as Record<string, unknown> | undefined;

  // controls: the generator's declarations; a label or step the person set when the generator gives none; the person's
  // control for a var the generator declares without one
  for (const k of names) {
    const cur = current.params?.[k], gen = generated.params?.[k];
    if (!cur) continue;
    if (!gen) { (g.params ??= {})[k] = structuredClone(cur); carried.push(`control ${k}`); continue; }
    for (const f of ['label', 'step'] as const) {
      if (cur[f] !== undefined && gen[f] === undefined) { g.params![k] = { ...g.params![k], [f]: cur[f] }; carried.push(`${k} ${f}`); }
    }
  }

  // var values
  for (const k of names) {
    if (!has(current.vars, k)) continue;
    const v = current.vars![k], gv = valueOf(generated, k);
    if (has(base, k) && same(v, base![k])) continue; // untouched since the last refresh: the generator's value
    if (same(v, gv)) continue;
    const why = misfit(v, gv, g.params?.[k]);
    if (why) { reset.push(`${k}=${show(v)} → ${show(gv)}: ${why}`); continue; }
    (g.vars ??= {})[k] = structuredClone(v);
    kept.push(`${k}=${show(v)} (generator: ${show(gv)})`);
  }
  for (const k of declared(current)) if (!names.includes(k)) dropped.push(k);

  // node ui, and the meta keys the generator does not set
  for (const [n, spec] of Object.entries(g.nodes ?? {})) {
    const ui = current.nodes?.[n]?.ui;
    if (ui !== undefined && spec.ui === undefined) { spec.ui = structuredClone(ui); carried.push(`${n} ui`); }
  }
  for (const [k, v] of Object.entries(current.meta ?? {})) {
    if (k === GENERATED_VARS || has(generated.meta, k)) continue;
    (g.meta ??= {})[k] = structuredClone(v);
    carried.push(`meta.${k}`);
  }
  // what the generator gave this time, so the next refresh can tell the person's changes from its own
  if (names.length) (g.meta ??= {})[GENERATED_VARS] = Object.fromEntries(names.map((k) => [k, structuredClone(valueOf(generated, k)) ?? null]));
  else if (g.meta) delete g.meta[GENERATED_VARS];
  return { graph: g, kept, reset, dropped, carried };
}

/** The refresh as note lines (empty when nothing was kept, reset or dropped). */
export function refreshNotes(r: RefreshResult): string[] {
  const out: string[] = [];
  if (r.kept.length) out.push(`refresh kept ${r.kept.length} value(s) the person changed: ${r.kept.join(', ')}`);
  if (r.reset.length) out.push(`refresh reset ${r.reset.length} value(s) that no longer fit: ${r.reset.join('; ')}`);
  if (r.dropped.length) out.push(`refresh dropped var(s) the generator no longer has: ${r.dropped.join(', ')}`);
  if (r.carried.length) out.push(`refresh carried over: ${r.carried.join(', ')}`);
  return out;
}
