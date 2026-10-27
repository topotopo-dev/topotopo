// Graph var names, and var overrides for one cook without editing the graph (the CLI's --var name=value).
//
// Names: "=expr" params and code (wrangle, script, sdf_expr, heightfield_layer …) read a graph var by its bare name
// (`height`), so a graph cannot declare a var that code could not read by name or that would hide one of code's own
// names: a keyword, a helper (noise, rand, length …), a JavaScript built-in (Math, Number …), the cook time (frame,
// time …) or a wrangle's @ptnum … names. Engine.validate reports such names.
//
// Overrides: values are parsed from text, and a name the graph does not know is an error that lists the ones it
// does. An export's source block (io/source.ts) records the vars as cooked, so passing them back as overrides cooks
// the same graph again.
import type { GraphSpec } from './types.ts';
import { didYouMean } from './params.ts';
import { EXPR_HELPERS, REF_FUNCS, TIME_KEYS } from './expr.ts';
import { SNIPPET_LIB_NAMES } from '../core/snippet-lib.ts';
import { JS_GLOBALS, RESERVED_WORDS } from '../core/usercode.ts';
import { WRANGLE_NAMES } from '../core/wrangle.ts';

const HELPERS = new Set([...EXPR_HELPERS, ...REF_FUNCS, ...SNIPPET_LIB_NAMES]);

/** What a var-name error says about reading vars (the hint of the validation error). */
export const VAR_NAME_HINT = 'expressions and code read graph vars by their bare name ("=height * 0.5", @P.y += height), so a var needs a name of its own';

/** Why a graph cannot declare a var of this name, or null when it can. */
export function varNameError(name: string): string | null {
  const rename = 'rename the var';
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return `var "${name}" is not a name code can read: use letters, digits and _ (not starting with a digit)`;
  if (name.startsWith('__')) return `var "${name}": names starting with __ belong to the engine; ${rename}`;
  if (name === 'vars') return 'var "vars": code reads graph vars by their bare name and has no vars object; rename the var';
  if (RESERVED_WORDS.has(name)) return `var "${name}" is a JavaScript keyword, which code cannot read as a name; ${rename}`;
  if (TIME_KEYS.has(name)) return `var "${name}" would hide the cook time (frame, time, fps, timeInc) from expressions; ${rename}`;
  if (HELPERS.has(name)) return `var "${name}" would hide the helper ${name} from expressions and code; ${rename}`;
  if (WRANGLE_NAMES.has(name)) return `var "${name}" would hide @${name} in wrangles; ${rename}`;
  if (JS_GLOBALS.has(name)) return `var "${name}" would hide JavaScript's ${name} from code; ${rename}`;
  return null;
}

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
