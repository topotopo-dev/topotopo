// Parameter schema handling: name resolution (aliases, case/underscore-insensitive,
// did-you-mean), "=expression" evaluation against graph vars, time and upstream
// geometry, static scanning of expression references, and type coercion.
import type { NodeDef, ParamDef } from './types.ts';
import { DeferredExpr, ExprError, REF_FUNCS, evalIn, exprScope, precompileExprs } from './expr.ts';
import type { ExprEnv, ExprScope } from './expr.ts';

export const norm = (s: string) => s.toLowerCase().replace(/[\s_\-]/g, '');

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

export function didYouMean(word: string, candidates: string[], max = 3): string[] {
  const w = norm(word);
  const scored = candidates
    .map((c) => {
      const nc = norm(c);
      let d = levenshtein(w, nc);
      if (nc.includes(w) || w.includes(nc)) d = Math.min(d, 1);
      return { c, d };
    })
    .filter((x) => x.d <= Math.max(2, Math.floor(w.length / 3)))
    .sort((a, b) => a.d - b.d);
  return [...new Set(scored.map((x) => x.c))].slice(0, max);
}

/** Map a user-supplied param key to the canonical name. */
export function resolveParamName(def: NodeDef, key: string): string | null {
  if (def.params[key]) return key;
  const nk = norm(key);
  for (const [name, pd] of Object.entries(def.params)) {
    if (norm(name) === nk) return name;
    if (pd.aliases?.some((a) => norm(a) === nk)) return name;
  }
  return null;
}

// ---------------------------------------------------------------- expressions

// Compilation and evaluation live in expr.ts (the sandbox); these re-exports keep the old import paths working.
export { DEFAULT_TIME, DeferredExpr, EXPR_HELPERS, ExprError, REF_FUNCS, TIME_KEYS, evalExpr } from './expr.ts';
export type { ExprEnv, TimeState } from './expr.ts';

/** Recursively evaluate "=expr" strings inside a param value (arrays too). */
export function evalDeep(v: any, vars: Record<string, any>, env?: ExprEnv): any {
  let scope: ExprScope | undefined;
  return evalValue(v, () => (scope ??= exprScope(vars, env)), '');
}

/**
 * evalDeep with a lazily created scope (one per node: vars are copied into the sandbox once) and a label for errors:
 * `param "translate"[1]: expression "=…" failed: …`.
 */
function evalValue(v: any, scope: () => ExprScope, label: string): any {
  if (typeof v === 'string' && v.length > 1 && v[0] === '=') {
    try {
      return evalIn(scope(), v.slice(1));
    } catch (e) {
      if (label && e instanceof ExprError) throw new ExprError(`param ${label}: ${e.message}`);
      throw e;
    }
  }
  if (Array.isArray(v)) return v.map((x, i) => evalValue(x, scope, label && `${label}[${i}]`));
  return v;
}

// ---------------------------------------------------------------- reference scanning

export interface ExprRefs {
  /** nodes whose cooked geometry is read (npoints, bbox, point, ...) */
  geo: string[];
  /** other nodes' params read with ch() */
  ch: { node: string; param: string }[];
  /** problems found while scanning (dynamic names, malformed ch paths) */
  errors: string[];
}

// a string literal without escapes or ${} interpolation: '...' "..." `...`
const STR = String.raw`(?:'([^'\\]*)'|"([^"\\]*)"|\x60([^\x60\\$]*)\x60)`;
const REF_CALL = new RegExp(String.raw`(?<![\w$.])(${REF_FUNCS.join('|')})\s*\(\s*(?:${STR}\s*(?:(\))|,\s*(?:${STR})?))?`, 'g');

/** Find node references in one expression string (without the leading "="). No evaluation needed. */
export function scanExpr(src: string, into: ExprRefs = { geo: [], ch: [], errors: [] }): ExprRefs {
  for (const m of src.matchAll(REF_CALL)) {
    const fn = m[1];
    const first = m[2] ?? m[3] ?? m[4];
    if (first === undefined) {
      into.errors.push(`${fn}(...) in "=${src}" needs the node name as a string literal, e.g. ${fn}("box1"${fn === 'ch' ? ', "size"' : ''}) (dynamic node names are not supported)`);
      continue;
    }
    if (fn !== 'ch') {
      if (!into.geo.includes(first)) into.geo.push(first);
      continue;
    }
    const second = m[6] ?? m[7] ?? m[8];
    let node: string, param: string;
    if (m[5] !== undefined) {
      // ch("node/param")
      const i = first.lastIndexOf('/');
      if (i <= 0 || i === first.length - 1) {
        into.errors.push(`ch("${first}") in "=${src}": use ch("node/param") or ch("node", "param")`);
        continue;
      }
      node = first.slice(0, i);
      param = first.slice(i + 1);
    } else if (second !== undefined) {
      node = first;
      param = second;
    } else {
      into.errors.push(`ch("${first}", ...) in "=${src}" needs the param name as a string literal (dynamic names are not supported)`);
      continue;
    }
    if (!into.ch.some((c) => c.node === node && c.param === param)) into.ch.push({ node, param });
  }
  return into;
}

/** Walk a param value the way evalDeep does and scan every "=expr" string in it. */
export function scanValue(v: any, into: ExprRefs = { geo: [], ch: [], errors: [] }): ExprRefs {
  if (typeof v === 'string' && v.length > 1 && v[0] === '=') scanExpr(v.slice(1), into);
  else if (Array.isArray(v)) for (const x of v) scanValue(x, into);
  return into;
}

/** All node references in a node's params (code and graph params are not expressions and are skipped). */
export function scanNodeRefs(def: NodeDef, raw: Record<string, any> | undefined): ExprRefs {
  const into: ExprRefs = { geo: [], ch: [], errors: [] };
  if (!raw || typeof raw !== 'object') return into;
  for (const [k, v] of Object.entries(raw)) {
    const name = resolveParamName(def, k);
    const pd = name ? def.params[name] : undefined;
    if (!pd || pd.type === 'code' || pd.type === 'graph') continue;
    scanValue(v, into);
  }
  return into;
}

export const hasRefs = (r: ExprRefs) => r.geo.length > 0 || r.ch.length > 0;

const FIRST_ARG = new RegExp(String.raw`((?<![\w$.])(?:${REF_FUNCS.join('|')})\s*\(\s*)(['"\x60])([^'"\x60\\$]*)\2`, 'g');

/** Rewrite references to node `from` as `to` inside a param value's "=expr" strings (used by rename edits). */
export function renameExprRefs(v: any, from: string, to: string): any {
  if (typeof v === 'string' && v.length > 1 && v[0] === '=') {
    return '=' + v.slice(1).replace(FIRST_ARG, (m, head: string, q: string, lit: string) => {
      if (lit === from) return head + q + to + q;
      if (/^ch\s*\(/.test(head) && lit.startsWith(from + '/')) return head + q + to + lit.slice(from.length) + q;
      return m;
    });
  }
  if (Array.isArray(v)) return v.map((x) => renameExprRefs(x, from, to));
  return v;
}

/** Give a numeric array .x .y .z .w accessors (non-enumerable, so hashing and JSON see a plain array). */
export function vecOut<T extends any[]>(a: T): T {
  ['x', 'y', 'z', 'w'].forEach((k, i) => {
    if (i < a.length) Object.defineProperty(a, k, { get: () => a[i], enumerable: false, configurable: true });
  });
  return a;
}

// ---------------------------------------------------------------- coercion

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;
const NAMED_COLORS: Record<string, [number, number, number]> = {
  white: [1, 1, 1], black: [0, 0, 0], red: [1, 0, 0], green: [0, 1, 0], blue: [0, 0, 1],
  yellow: [1, 1, 0], cyan: [0, 1, 1], magenta: [1, 0, 1], orange: [1, 0.5, 0], purple: [0.5, 0, 1],
  gray: [0.5, 0.5, 0.5], grey: [0.5, 0.5, 0.5], brown: [0.45, 0.28, 0.12], pink: [1, 0.6, 0.75],
};

export function parseColor(v: any): [number, number, number] | null {
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (NAMED_COLORS[s]) return NAMED_COLORS[s].slice() as any;
    const m = HEX.exec(s);
    if (m) {
      let h = m[1];
      if (h.length === 3) h = h.split('').map((c) => c + c).join('');
      return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
    }
    return null;
  }
  return null;
}

function toNum(v: any): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  // finite, like numbers: "Infinity" and "1e999" are how a non-finite number arrives in JSON
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export class ParamError extends Error {}

/**
 * Coerce a raw value to the param's type. Numbers outside the declared min/max are clamped, and `note` (when given)
 * is told, so a cook can warn: a silent clamp hides mistakes such as an asset range narrower than its caller's.
 */
export function coerce(name: string, pd: ParamDef, v: any, note?: (msg: string) => void): any {
  const bad = (expect: string) =>
    new ParamError(`param "${name}" expects ${expect}, got ${JSON.stringify(v)?.slice(0, 80)}`);
  const range = () => `${pd.min ?? '…'}..${pd.max ?? '…'}`;
  switch (pd.type) {
    case 'float':
    case 'int': {
      const n = toNum(v);
      if (n === null) throw bad(pd.type === 'int' ? 'an integer' : 'a number');
      let x = pd.type === 'int' ? Math.round(n) : n;
      if (pd.min !== undefined && x < pd.min) { note?.(`param "${name}" ${x} clamped to ${pd.min} (range ${range()})`); x = pd.min; }
      if (pd.max !== undefined && x > pd.max) { note?.(`param "${name}" ${x} clamped to ${pd.max} (range ${range()})`); x = pd.max; }
      return x;
    }
    case 'bool': {
      if (typeof v === 'boolean') return v;
      if (typeof v === 'number') return v !== 0;
      if (typeof v === 'string') {
        const s = v.toLowerCase();
        if (['true', 'on', 'yes', '1'].includes(s)) return true;
        if (['false', 'off', 'no', '0', ''].includes(s)) return false;
      }
      throw bad('true/false');
    }
    case 'string':
    case 'path':
    case 'group':
      if (v === null || v === undefined) return '';
      if (typeof v === 'object') throw bad('a string');
      return String(v);
    case 'code':
      if (Array.isArray(v)) return v.join('\n'); // allow code as array of lines
      if (typeof v !== 'string') throw bad('a code string');
      return v;
    case 'enum': {
      const s = String(v);
      const opts = pd.options ?? [];
      const hit = opts.find((o) => o === s) ?? opts.find((o) => norm(o) === norm(s));
      if (hit) return hit;
      if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < opts.length) return opts[v];
      throw new ParamError(`param "${name}" must be one of: ${opts.join(' | ')} (got ${JSON.stringify(v)})`);
    }
    case 'vec2': case 'vec3': case 'vec4': case 'ivec2': case 'ivec3': case 'color': {
      const n = pd.type === 'vec2' || pd.type === 'ivec2' ? 2 : pd.type === 'vec4' ? 4 : 3;
      const isInt = pd.type.startsWith('i');
      let arr: any[];
      if (pd.type === 'color') {
        const c = parseColor(v);
        if (c) return c;
      }
      if (typeof v === 'number' || (typeof v === 'string' && toNum(v) !== null)) arr = new Array(n).fill(toNum(v));
      else if (Array.isArray(v)) arr = v;
      else if (v && typeof v === 'object' && 'x' in v) arr = [v.x, v.y, v.z, v.w].slice(0, n);
      else throw bad(`${n} numbers like [${new Array(n).fill(0).join(', ')}]${pd.type === 'color' ? ' or "#rrggbb"' : ''}`);
      if (arr.length !== n) {
        if (arr.length === 1) arr = new Array(n).fill(arr[0]);
        else throw bad(`exactly ${n} numbers`);
      }
      return arr.map((x, i) => {
        const nn = toNum(x);
        if (nn === null) throw new ParamError(`param "${name}"[${i}] is not a number: ${JSON.stringify(x)}`);
        let r = isInt ? Math.round(nn) : nn;
        if (pd.min !== undefined && r < pd.min) { note?.(`param "${name}"[${i}] ${r} clamped to ${pd.min} (range ${range()})`); r = pd.min; }
        if (pd.max !== undefined && r > pd.max) { note?.(`param "${name}"[${i}] ${r} clamped to ${pd.max} (range ${range()})`); r = pd.max; }
        return r;
      });
    }
    case 'ramp': {
      // [[pos, value], ...] or [{pos, value}] ; value may be a number or [r,g,b]
      if (!Array.isArray(v) || v.length === 0) throw bad('a ramp like [[0, 0], [1, 1]]');
      const keys = v.map((k: any) => {
        if (Array.isArray(k) && k.length >= 2) return { pos: Number(k[0]), value: k.length > 2 ? k.slice(1) : k[1] };
        if (k && typeof k === 'object') return { pos: Number(k.pos ?? k.t ?? k.x), value: k.value ?? k.v ?? k.c };
        throw bad('ramp keys [pos, value]');
      });
      for (const k of keys) {
        const c = parseColor(k.value);
        if (c) k.value = c;
      }
      return keys.sort((a: any, b: any) => a.pos - b.pos);
    }
    case 'json':
    case 'graph':
      return v;
  }
  return v;
}

export interface ResolvedParams {
  values: Record<string, any>;
  errors: string[];
  notes: string[];
  /** values changed on the way in (clamped to the param range); a cook reports them as node warnings */
  warnings: string[];
  /** an expression read frame, time, fps or timeInc */
  usesTime: boolean;
  /** params whose value is only known at cook time (dry run with reference functions) */
  deferred: string[];
}

/** Validate names, evaluate expressions and coerce types. */
export function resolveParams(def: NodeDef, raw: Record<string, any> | undefined, vars: Record<string, any>, env: ExprEnv = {}): ResolvedParams {
  const values: Record<string, any> = {};
  const errors: string[] = [], notes: string[] = [], warnings: string[] = [], deferred: string[] = [];
  let usesTime = false;
  const ev: ExprEnv = { ...env, onTime: () => { usesTime = true; env.onTime?.(); } };
  let scope: ExprScope | undefined;
  const getScope = () => (scope ??= exprScope(vars, ev));
  const given: Record<string, any> = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    const name = resolveParamName(def, k);
    if (!name) {
      const sugg = didYouMean(k, Object.keys(def.params));
      errors.push(
        `unknown param "${k}"` + (sugg.length ? ` — did you mean ${sugg.map((s) => `"${s}"`).join(' or ')}?` : '') +
        ` Valid params: ${Object.keys(def.params).join(', ') || '(none)'}`,
      );
      continue;
    }
    if (name !== k) notes.push(`"${k}" → "${name}"`);
    given[name] = v;
  }
  // compile this node's new expressions in one go
  const srcs: string[] = [];
  const collect = (v: any) => {
    if (typeof v === 'string') { if (v.length > 1 && v[0] === '=') srcs.push(v.slice(1)); }
    else if (Array.isArray(v)) for (const x of v) collect(x);
  };
  for (const [name, pd] of Object.entries(def.params)) if (pd.type !== 'code' && pd.type !== 'graph') collect(name in given ? given[name] : pd.default);
  if (srcs.length > 1) precompileExprs(env.host, srcs);
  for (const [name, pd] of Object.entries(def.params)) {
    let v = name in given ? given[name] : pd.default;
    try {
      if (pd.type !== 'code' && pd.type !== 'graph') v = evalValue(v, getScope, `"${name}"`);
      values[name] = v === undefined ? undefined : coerce(name, pd, v, (m) => warnings.push(m));
    } catch (e: any) {
      if (e instanceof DeferredExpr) deferred.push(name);
      else errors.push(e.message);
      values[name] = pd.default;
    }
  }
  return { values, errors, notes, warnings, usesTime, deferred };
}

/** Evaluate a ramp at t. Values may be numbers or arrays. */
export function evalRamp(keys: { pos: number; value: any }[], t: number): any {
  if (!keys.length) return 0;
  if (t <= keys[0].pos) return keys[0].value;
  const last = keys[keys.length - 1];
  if (t >= last.pos) return last.value;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (t >= a.pos && t <= b.pos) {
      const u = b.pos === a.pos ? 0 : (t - a.pos) / (b.pos - a.pos);
      if (Array.isArray(a.value)) return a.value.map((x: number, c: number) => x + (b.value[c] - x) * u);
      return a.value + (b.value - a.value) * u;
    }
  }
  return last.value;
}
