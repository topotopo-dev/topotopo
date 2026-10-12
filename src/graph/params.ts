// Parameter schema handling: name resolution (aliases, case/underscore-insensitive,
// did-you-mean), "=expression" evaluation against graph vars, time and upstream
// geometry, static scanning of expression references, and type coercion.
import type { NodeDef, ParamDef } from './types.ts';
import { rand } from '../core/random.ts';
import { clamp, fit, lerp, smoothstep } from '../core/math.ts';

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

const EXPR_LIB: Record<string, any> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  atan2: Math.atan2, sqrt: Math.sqrt, pow: Math.pow, exp: Math.exp, log: Math.log, abs: Math.abs,
  floor: Math.floor, ceil: Math.ceil, round: Math.round, min: Math.min, max: Math.max, sign: Math.sign,
  hypot: Math.hypot, PI: Math.PI, E: Math.E, TAU: Math.PI * 2,
  clamp, fit, lerp, smoothstep,
  frac: (x: number) => x - Math.floor(x),
  mod: (a: number, b: number) => ((a % b) + b) % b,
  radians: (d: number) => (d * Math.PI) / 180,
  degrees: (r: number) => (r * 180) / Math.PI,
  rand: (x: number, seed = 0) => rand(x, seed),
  pick: (arr: any[], i: number) => arr[((Math.floor(i) % arr.length) + arr.length) % arr.length],
};

const exprCache = new Map<string, Function>();

export class ExprError extends Error {}
/** Thrown by reference functions while validating without cooking (dry run): the value is only known at cook time. */
export class DeferredExpr extends Error {}

/** The time a graph is cooked at. frame 1 = time 0 (Houdini convention). */
export interface TimeState { frame: number; time: number; fps: number; timeInc: number }
export const TIME_KEYS = new Set(['frame', 'time', 'fps', 'timeInc']);
export const DEFAULT_TIME: TimeState = { frame: 1, time: 0, fps: 24, timeInc: 1 / 24 };

/** Functions of "=expr" params that read other nodes: upstream geometry, or another node's parameter. */
export const REF_FUNCS = ['npoints', 'nprims', 'nvertices', 'bbox', 'centroid', 'detail', 'point', 'prim', 'ch'];

/** Per-evaluation context for expressions: the cook time and node-reference functions. */
export interface ExprEnv {
  time?: TimeState;
  /** implementations of REF_FUNCS bound to the current cook */
  fns?: Record<string, (...a: any[]) => any>;
  /** called when an expression reads frame, time, fps or timeInc (and no var of that name shadows it) */
  onTime?: () => void;
}

const NO_COOK_FNS: Record<string, (...a: any[]) => any> = Object.fromEntries(
  REF_FUNCS.map((f) => [f, () => { throw new ExprError(`${f}() only works in node params of a cooked graph`); }]),
);

/** Evaluate "=..." expressions. Identifiers resolve to graph vars, then time (frame, time, fps, timeInc), then helpers. */
export function evalExpr(src: string, vars: Record<string, any>, env: ExprEnv = {}): any {
  let fn = exprCache.get(src);
  if (!fn) {
    try {
      // sloppy-mode Function so `with` can expose vars and helpers by bare name
      fn = new Function('__s', `with (__s) { return (${src}); }`);
    } catch (e: any) {
      throw new ExprError(`syntax error in expression "=${src}": ${e.message}`);
    }
    exprCache.set(src, fn);
  }
  const base: Record<string, any> = { ...EXPR_LIB, ...(env.fns ?? NO_COOK_FNS), ...vars };
  const time = env.time ?? DEFAULT_TIME;
  // time identifiers are read lazily so that a read can be recorded (it makes the node time-dependent)
  const scope = new Proxy(base, {
    has: (t, k) => typeof k === 'string' && (k in t || TIME_KEYS.has(k)),
    get: (t, k) => {
      if (typeof k === 'string' && !(k in t) && TIME_KEYS.has(k)) {
        env.onTime?.();
        return (time as any)[k];
      }
      return (t as any)[k];
    },
  });
  try {
    return fn(scope);
  } catch (e: any) {
    if (e instanceof DeferredExpr) throw e;
    const names = Object.keys(vars);
    throw new ExprError(
      `expression "=${src}" failed: ${e.message}. Vars in scope: ${names.length ? names.join(', ') : '(none)'}`,
    );
  }
}

/** Recursively evaluate "=expr" strings inside a param value (arrays/objects too). */
export function evalDeep(v: any, vars: Record<string, any>, env?: ExprEnv): any {
  if (typeof v === 'string' && v.length > 1 && v[0] === '=') return evalExpr(v.slice(1), vars, env);
  if (Array.isArray(v)) return v.map((x) => evalDeep(x, vars, env));
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
  if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) return Number(v);
  return null;
}

export class ParamError extends Error {}

export function coerce(name: string, pd: ParamDef, v: any): any {
  const bad = (expect: string) =>
    new ParamError(`param "${name}" expects ${expect}, got ${JSON.stringify(v)?.slice(0, 80)}`);
  switch (pd.type) {
    case 'float':
    case 'int': {
      const n = toNum(v);
      if (n === null) throw bad(pd.type === 'int' ? 'an integer' : 'a number');
      let x = pd.type === 'int' ? Math.round(n) : n;
      if (pd.min !== undefined && x < pd.min) x = pd.min;
      if (pd.max !== undefined && x > pd.max) x = pd.max;
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
        if (pd.min !== undefined && r < pd.min) r = pd.min;
        if (pd.max !== undefined && r > pd.max) r = pd.max;
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
  /** an expression read frame, time, fps or timeInc */
  usesTime: boolean;
  /** params whose value is only known at cook time (dry run with reference functions) */
  deferred: string[];
}

/** Validate names, evaluate expressions and coerce types. */
export function resolveParams(def: NodeDef, raw: Record<string, any> | undefined, vars: Record<string, any>, env: ExprEnv = {}): ResolvedParams {
  const values: Record<string, any> = {};
  const errors: string[] = [], notes: string[] = [], deferred: string[] = [];
  let usesTime = false;
  const ev: ExprEnv = { ...env, onTime: () => { usesTime = true; env.onTime?.(); } };
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
  for (const [name, pd] of Object.entries(def.params)) {
    let v = name in given ? given[name] : pd.default;
    try {
      if (pd.type !== 'code' && pd.type !== 'graph') v = evalDeep(v, vars, ev);
      values[name] = v === undefined ? undefined : coerce(name, pd, v);
    } catch (e: any) {
      if (e instanceof DeferredExpr) deferred.push(name);
      else errors.push(e.message);
      values[name] = pd.default;
    }
  }
  return { values, errors, notes, usesTime, deferred };
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
