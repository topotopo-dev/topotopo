// Var overrides for one cook without editing the graph (the CLI's --var name=value): values are parsed from text, and
// a name the graph does not know is an error that lists the ones it does. An export's source block (io/source.ts)
// records the vars as cooked, so passing them back as overrides cooks the same graph again.
import type { GraphSpec } from './types.ts';
import { didYouMean } from './params.ts';

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

/**
 * A var value from text: a number ("8", "-0.5", "1e3"), true / false, JSON (null, [1, 2], {"a": 1}, "quoted"), or
 * else the text itself as a string. Text that starts like JSON but does not parse is an error.
 */
export function parseVarValue(text: string): unknown {
  const t = text.trim();
  if (NUMBER.test(t)) return Number(t);
  if (t === 'true' || t === 'false') return t === 'true';
  if (t === 'null' || /^[[{"]/.test(t)) {
    try { return JSON.parse(t); } catch (e) { throw new Error(`${JSON.stringify(text)} is not valid JSON (${(e as Error).message})`); }
  }
  return text;
}

/** "name=value" → [name, value]; the value is parsed by parseVarValue. */
export function parseVarArg(arg: string): [string, unknown] {
  const i = arg.indexOf('=');
  const name = i > 0 ? arg.slice(0, i).trim() : '';
  if (!name) throw new Error(`expects name=value (e.g. relief=8), got ${JSON.stringify(arg)}`);
  try { return [name, parseVarValue(arg.slice(i + 1))]; } catch (e) { throw new Error(`${name}: ${(e as Error).message}`); }
}

/** The vars a graph knows: those it sets and those it declares as params. */
export function knownVars(spec: GraphSpec): string[] {
  return [...new Set([...Object.keys(spec.vars ?? {}), ...Object.keys(spec.params ?? {})])];
}

/** The graph with these vars set (a new object; the input is not changed). An unknown var throws, naming the known ones. */
export function withVars(spec: GraphSpec, vars: [string, unknown][]): GraphSpec {
  if (!vars.length) return spec;
  const known = knownVars(spec);
  for (const [name] of vars) {
    if (known.includes(name)) continue;
    const s = didYouMean(name, known);
    throw new Error(`unknown var "${name}"${s.length ? ` (did you mean ${s.join(', ')}?)` : ''}; ${known.length ? `the graph's vars: ${known.join(', ')}` : 'the graph has no vars'}`);
  }
  return { ...spec, vars: { ...(spec.vars ?? {}), ...Object.fromEntries(vars) } };
}
