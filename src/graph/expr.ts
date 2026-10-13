// "=expr" parameter expressions: compiled in the host's expression sandbox and evaluated against graph vars, the
// cook time and node references (npoints, bbox, ch …).
//
// A graph is code, so an expression runs like a wrangle: syntax-checked, sandboxed, time-limited.
// - Compilation: a host with `exprSandbox` (the Node host: a vm realm used by nothing else) compiles each distinct
//   expression there once (cached per host). The library an expression sees is built INSIDE that realm
//   (exprRealmSetup, compiled from its source text), after the realm was locked down: every built-in frozen, the
//   Function constructors disabled. Graph vars and the results of npoints()/bbox()/… are copied into the realm,
//   results and error messages are copied out, so an expression never holds an object of the engine's realm (whose
//   `.constructor.constructor` would be the engine's Function, i.e. process, require, fetch …).
// - Scope: every free identifier resolves through a proxy that claims every name, so nothing reaches the realm's
//   global scope. Names are looked up in graph vars, then the helpers (sin … pick, Math, the reference functions),
//   then frame/time/fps/timeInc; anything else is a ReferenceError naming it. The expression itself runs in a
//   strict function whose `this` throws when read, and `import` is rejected before compiling.
// - Time limit: an expression that isSimpleExpr() cannot prove short (function literals, loops, regular
//   expressions, method calls, object literals, templates, assignments) runs inside a timed host call
//   (Host.exprSandbox.run, engine.scriptTimeoutMs). The others are straight-line arithmetic over vars and up to
//   32 calls of the helpers and Math: they cannot loop, and run without the timer, which costs ~0.15 ms per call
//   (a watchdog thread per vm timeout). A timed expression's result is remembered with everything it read (vars,
//   time, reference calls); a re-cook whose reads all give the same values reuses it without a timed call.
// - Cost: straight-line expressions of a node are compiled in one script (precompileExprs); compiled functions
//   are cached per host by source text.
// - Without `exprSandbox` (e.g. a browser host that provides none) the same wrapper and scope are compiled with
//   `new Function` in the engine's own realm: the same names are hidden, but there is NO timeout and NO realm
//   isolation (an expression can reach the engine realm's Function through any function's .constructor).
import type { Host } from '../host/types.ts';

export class ExprError extends Error {}
/** Thrown by reference functions while validating without cooking (dry run): the value is only known at cook time. */
export class DeferredExpr extends Error {}

/** The time a graph is cooked at. frame 1 = time 0 (Houdini convention). */
export interface TimeState { frame: number; time: number; fps: number; timeInc: number }
export const TIME_KEYS = new Set(['frame', 'time', 'fps', 'timeInc']);
export const DEFAULT_TIME: TimeState = { frame: 1, time: 0, fps: 24, timeInc: 1 / 24 };

/** Functions of "=expr" params that read other nodes: upstream geometry, or another node's parameter. */
export const REF_FUNCS = ['npoints', 'nprims', 'nvertices', 'bbox', 'centroid', 'detail', 'point', 'prim', 'ch'];

/** The helper names every expression can use besides graph vars, time and REF_FUNCS (documented in topic "expressions"). */
export const EXPR_HELPERS = [
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'sqrt', 'pow', 'exp', 'log', 'abs', 'floor', 'ceil', 'round',
  'min', 'max', 'sign', 'hypot', 'PI', 'E', 'TAU', 'clamp', 'fit', 'lerp', 'smoothstep', 'frac', 'mod', 'radians',
  'degrees', 'rand', 'pick', 'Math', 'NaN', 'Infinity', 'undefined',
];

/** Per-evaluation context for expressions: the cook time, node-reference functions and where they run. */
export interface ExprEnv {
  time?: TimeState;
  /** implementations of REF_FUNCS bound to the current cook */
  fns?: Record<string, (...a: any[]) => any>;
  /** called when an expression reads frame, time, fps or timeInc (and no var of that name shadows it) */
  onTime?: () => void;
  /** the host whose expression sandbox compiles and runs the expressions (absent: the new Function fallback) */
  host?: Host;
  /** wall-clock limit for expressions that run timed (default 30000 ms, the engine passes scriptTimeoutMs) */
  timeoutMs?: number;
}

const NO_COOK_FNS: Record<string, (...a: any[]) => any> = Object.fromEntries(
  REF_FUNCS.map((f) => [f, () => { throw new ExprError(`${f}() only works in node params of a cooked graph`); }]),
);

// ---------------------------------------------------------------- the library, built inside the sandbox realm

/**
 * Builds the expression library INSIDE the realm that runs expressions. It is compiled there from its source text
 * (like installSnippetLib), so it must stay self-contained: no imports, no outer references, no syntax a bundler would
 * rewrite into helper calls, built-ins taken from this realm's globalThis.
 * `bridge.isolated` (the realm belongs to the expression sandbox alone): first lock the realm down, i.e. disable the
 * Function constructors (fn.constructor would compile code in the realm's global scope) and freeze every built-in
 * object reachable from the global object and from the hidden intrinsics (iterator and generator prototypes), so
 * one expression cannot change what the next one, or the engine, sees. `bridge.ref(name, args)` calls the engine's
 * node-reference functions: the wrappers built here pass only primitives out and copy results and errors in.
 */
export function exprRealmSetup(bridge: any): any {
  'use strict';
  const G: any = globalThis;
  const O = G.Object, R = G.Reflect, M = G.Math;
  if (bridge.isolated) {
    const tamed = function () { throw new G.TypeError('the Function constructor is not available in expressions'); };
    for (const f of [function () {}, async function () {}, function* () {}, async function* () {}]) {
      O.defineProperty(O.getPrototypeOf(f), 'constructor', { value: tamed, writable: false, enumerable: false, configurable: false });
    }
    const S = G.Symbol;
    const todo: any[] = [
      G, tamed, ([] as any)[S.iterator](), ('' as any)[S.iterator](), new G.Map().entries(), new G.Set().values(), /x/[S.matchAll](''),
      (function* () {})(), (async function* () {})(),
    ];
    if (typeof G.Iterator === 'function') todo.push(G.Iterator.from([0]).map((x: any) => x));
    const seen = new G.Set();
    while (todo.length) {
      const o = todo.pop();
      if (o === null || (typeof o !== 'object' && typeof o !== 'function') || seen.has(o)) continue;
      seen.add(o);
      for (const k of R.ownKeys(o)) {
        const d = R.getOwnPropertyDescriptor(o, k);
        if (!d) continue;
        if ('value' in d) todo.push(d.value);
        else todo.push(d.get, d.set);
      }
      todo.push(O.getPrototypeOf(o));
      O.freeze(o);
    }
  }

  const isArray = G.Array.isArray;
  const hasOwn = (o: any, k: string) => O.prototype.hasOwnProperty.call(o, k);
  const define = (o: any, k: string, value: any) => O.defineProperty(o, k, { value, enumerable: true, writable: true, configurable: true });
  // copies of vecOut() vectors keep their .x .y .z .w accessors through this prototype
  const VecProto = O.create(G.Array.prototype);
  ['x', 'y', 'z', 'w'].forEach((k, i) => O.defineProperty(VecProto, k, { get() { return this[i]; }, enumerable: false, configurable: false }));
  O.freeze(VecProto);
  /**
   * Copy a value of the engine's realm into this one: arrays, typed arrays (as arrays) and plain data; functions
   * are dropped. `seen` (a Map) keeps shared and circular references; null for engine results, which are trees.
   */
  const copyIn = (v: any, seen: any, depth: number): any => {
    if (v === null || typeof v !== 'object') return typeof v === 'function' ? undefined : v;
    if (seen) { const o = seen.get(v); if (o !== undefined) return o; }
    if (depth > 100) throw new G.Error('value nested too deeply');
    let out: any;
    if (isArray(v) || G.ArrayBuffer.isView(v)) {
      const n = typeof v.length === 'number' ? v.length : 0;
      out = new G.Array(n);
      if (n <= 4 && hasOwn(v, 'x')) O.setPrototypeOf(out, VecProto);
      if (seen) seen.set(v, out);
      for (let i = 0; i < n; i++) out[i] = copyIn(v[i], seen, depth + 1);
    } else {
      out = {};
      if (seen) seen.set(v, out);
      for (const k of O.keys(v)) {
        const x = copyIn(v[k], seen, depth + 1);
        if (k === '__proto__' || k in out) define(out, k, x); // inherited names: the frozen Object.prototype rejects plain assignment
        else out[k] = x;
      }
    }
    return out;
  };
  const freezeAll = (v: any, seen: any) => {
    if (v === null || typeof v !== 'object' || seen.has(v)) return v;
    seen.add(v);
    for (const k of O.keys(v)) freezeAll(v[k], seen);
    return O.freeze(v);
  };
  const errorIn = (e: any) => {
    let msg;
    try { msg = e !== null && typeof e === 'object' && typeof e.message === 'string' ? e.message : G.String(e); } catch { msg = 'error'; }
    return new G.Error(msg);
  };

  // helpers: the same functions as src/core/math.ts clamp/fit/lerp/smoothstep and src/core/random.ts rand
  // (test/engine.ts compares them)
  const f64 = new G.Float64Array(1), u32 = new G.Uint32Array(f64.buffer);
  const hash32 = (x: number) => {
    x = x >>> 0; x ^= x >>> 16; x = M.imul(x, 0x7feb352d); x ^= x >>> 15; x = M.imul(x, 0x846ca68b); x ^= x >>> 16;
    return x >>> 0;
  };
  const hashNumber = (v: number) => {
    if (G.Number.isInteger(v) && M.abs(v) < 2 ** 31) return hash32(v ^ 0x9e3779b9);
    f64[0] = v;
    return hash32(u32[0] ^ hash32(u32[1]));
  };
  const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
  const lib: any = O.create(null);
  const helpers: any = {
    sin: M.sin, cos: M.cos, tan: M.tan, asin: M.asin, acos: M.acos, atan: M.atan,
    atan2: M.atan2, sqrt: M.sqrt, pow: M.pow, exp: M.exp, log: M.log, abs: M.abs,
    floor: M.floor, ceil: M.ceil, round: M.round, min: M.min, max: M.max, sign: M.sign,
    hypot: M.hypot, PI: M.PI, E: M.E, TAU: M.PI * 2,
    clamp,
    fit: (x: number, a: number, b: number, c: number, d: number) => (b === a ? c : c + ((clamp(x, M.min(a, b), M.max(a, b)) - a) / (b - a)) * (d - c)),
    lerp: (a: number, b: number, t: number) => a + (b - a) * t,
    smoothstep: (e0: number, e1: number, x: number) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); },
    frac: (x: number) => x - M.floor(x),
    mod: (a: number, b: number) => ((a % b) + b) % b,
    radians: (d: number) => (d * M.PI) / 180,
    degrees: (r: number) => (r * 180) / M.PI,
    rand: (x: number, seed = 0) => hash32(hashNumber(x) ^ hash32(M.floor(seed * 7919) + 0x632be5ab)) / 4294967296,
    pick: (arr: any, i: number) => arr[((M.floor(i) % arr.length) + arr.length) % arr.length],
    Math: M, NaN: NaN, Infinity: Infinity, undefined: undefined,
  };
  for (const k of O.keys(helpers)) lib[k] = helpers[k];
  // node references: primitives out, a copy of the result (or the error message) in
  const ref = bridge.ref;
  const prim = (x: any) => (x !== null && (typeof x === 'object' || typeof x === 'function') ? G.String(x) : x);
  for (const name of bridge.refNames) {
    lib[name] = {
      [name](...args: any[]) {
        const a: any[] = [];
        for (let i = 0; i < args.length; i++) a.push(prim(args[i]));
        try { return copyIn(ref(name, a), null, 0); } catch (e) { throw errorIn(e); }
      },
    }[name];
  }
  O.freeze(lib);
  // `this` of an expression: reading anything from it fails with a message saying so
  const noThis = new G.Proxy(O.freeze(O.create(null)), {
    get() { throw new G.TypeError('this is not available in expressions'); },
  });
  return O.freeze({
    lib,
    noThis,
    /** a frozen copy of an engine value (graph vars) */
    copyIn: (v: any) => freezeAll(copyIn(v, new G.Map(), 0), new G.Set()),
    /** an error object of this realm (thrown by the scope proxy) */
    error: (kind: string, msg: string) => new (kind === 'TypeError' ? G.TypeError : kind === 'ReferenceError' ? G.ReferenceError : G.Error)(msg),
  });
}

// ---------------------------------------------------------------- static check

const RESERVED = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum',
  'export', 'extends', 'finally', 'for', 'function', 'if', 'implements', 'import', 'in', 'instanceof', 'interface',
  'let', 'new', 'package', 'private', 'protected', 'public', 'return', 'static', 'super', 'switch', 'this', 'throw',
  'try', 'var', 'void', 'while', 'with', 'yield', 'async', 'of', 'get', 'set', 'arguments', 'eval',
]);
const LITERAL_WORDS = new Set(['true', 'false', 'null']);
const SIMPLE_PUNCT = new Set([
  '(', ')', '[', ']', ',', '.', '?.', '?', ':', '+', '-', '*', '/', '%', '**', '<', '>', '<=', '>=', '==', '!=', '===',
  '!==', '&&', '||', '??', '!', '~', '&', '|', '^', '<<', '>>', '>>>',
]);
// whitespace | number | identifier | 'string' | "string" | punctuator; anything else (templates, comments, regular
// expressions, escapes, non-ASCII names) does not match and makes the expression "not simple"
const TOKEN = new RegExp([
  String.raw`(\s+)`,
  String.raw`(0[xXoObB][\da-fA-F_]+n?|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?n?)`,
  String.raw`([A-Za-z_$][\w$]*)`,
  String.raw`('(?:[^'\\\r\n\u2028\u2029]|\\[^\r\n\u2028\u2029])*'|"(?:[^"\\\r\n\u2028\u2029]|\\[^\r\n\u2028\u2029])*")`,
  String.raw`(>>>=?|>>=?|<<=?|===?|!==?|\*\*=?|\?\?=?|&&=?|\|\|=?|=>|\+\+|--|\.\.\.|\?\.(?!\d)|[-+*/%&|^<>!=]=?|[()[\],.?:~;{}])`,
].join('|'), 'y');
const SIMPLE_MAX_LENGTH = 1000;
const SIMPLE_MAX_CALLS = 32;

/**
 * True when an expression is straight-line code that cannot run long, so it may run without the host's timer:
 * numbers, plain strings, names, operators, member reads, array literals, and up to SIMPLE_MAX_CALLS calls whose
 * callee is a bare name (a helper or reference function; vars hold data) or Math.<name>. Anything else (function
 * literals, loops and other statements, regular expressions, templates, comments, object literals, assignments,
 * spread, `new`, method calls, longer sources) is "not simple" and runs timed.
 */
export function isSimpleExpr(src: string): boolean {
  if (src.length > SIMPLE_MAX_LENGTH) return false;
  const prev: string[] = []; // significant tokens so far ('#' stands for a number or string)
  let operand = false, calls = 0;
  for (let i = 0; i < src.length;) {
    TOKEN.lastIndex = i;
    const m = TOKEN.exec(src);
    if (!m) return false;
    i = TOKEN.lastIndex;
    if (m[1] !== undefined) continue;
    const before = prev[prev.length - 1];
    const member = before === '.' || before === '?.';
    let tok: string;
    if (m[2] !== undefined || m[4] !== undefined) { tok = '#'; operand = true; }
    else if (m[3] !== undefined) {
      tok = m[3];
      if (!member) {
        if (tok === 'typeof') { prev.push(tok); operand = false; continue; }
        if (RESERVED.has(tok)) return false;
      }
      operand = true;
    } else {
      tok = m[5];
      if (!SIMPLE_PUNCT.has(tok)) return false;
      if (member) return false; // ?.( ?.[ and friends
      if (tok === '/' && (!operand || src[i] === '/' || src[i] === '*')) return false; // regular expression or comment
      if (tok === '(' && operand) {
        // a call: only of a bare name, or of Math.<name>
        const callee = before, p2 = prev[prev.length - 2], p3 = prev[prev.length - 3], p4 = prev[prev.length - 4];
        const bare = /^[A-Za-z_$]/.test(callee) && !LITERAL_WORDS.has(callee) && p2 !== '.' && p2 !== '?.';
        const math = /^[A-Za-z_$]/.test(callee) && p2 === '.' && p3 === 'Math' && p4 !== '.' && p4 !== '?.';
        if (!(bare || math) || ++calls > SIMPLE_MAX_CALLS) return false;
      }
      operand = tok === ')' || tok === ']';
    }
    prev.push(tok);
  }
  return true;
}

// ---------------------------------------------------------------- runtimes (one per host)

/** fn(scope) returns the expression's function (strict, no parameters), created inside `with (scope)` */
interface Compiled { fn: (scope: any) => () => any; simple: boolean }

interface ScopeState {
  rt: Runtime;
  vars: Record<string, any>;
  /** realm copies of the object-valued vars read so far */
  copies: Map<string, any>;
  time: TimeState;
  onTime?: () => void;
  fns?: Record<string, (...a: any[]) => any>;
  /** the last error a reference function threw during the current evaluation (DeferredExpr in a dry run) */
  refError?: unknown;
  /** what the current timed evaluation reads, in order (null: not recording) */
  reads: Read[] | null;
  readNames: Set<string>;
  /** the evaluation read something its result may not be a function of (Math, for Math.random): no memo */
  impure: boolean;
}

/** One input of a timed evaluation: a var, a helper name, a time value or a reference call, with a fingerprint. */
interface Read { kind: 'var' | 'lib' | 'time' | 'ref'; name: string; args?: any[]; fp?: string | null }
/** A remembered result of a timed expression and everything it read. */
interface Memo { reads: Read[]; value: any }

interface Runtime {
  lib: any;
  /** the `this` expressions run with */
  noThis: any;
  copyIn: (v: any) => any;
  error: (kind: string, msg: string) => any;
  compileSource: (source: string) => any;
  checkBody: (body: string) => { message: string; line: number } | null;
  /** run a job: timed in the sandbox, or a plain call in the fallback */
  run: (job: () => void, timeoutMs: number) => void;
  compiled: Map<string, Compiled | ExprError>;
  /** results of timed expressions by source text, newest first, with the reads they depend on */
  memo: Map<string, Memo[]>;
  /** the scope whose evaluation is running (reference functions dispatch to its fns) */
  current: ScopeState | null;
}

const runtimes = new WeakMap<object, Runtime>();
const NO_HOST = {};

function runtimeFor(host: Host | undefined): Runtime {
  const key = host ?? NO_HOST;
  let rt = runtimes.get(key);
  if (rt) return rt;
  const sb = host?.exprSandbox;
  const bridge = {
    isolated: !!sb,
    refNames: REF_FUNCS.slice(),
    ref: (name: string, args: any[]) => {
      const s = rt!.current;
      const f = (s?.fns ?? NO_COOK_FNS)[name] ?? NO_COOK_FNS[name];
      try {
        const out = f.apply(undefined, args); // args: a realm array of primitives (read by index, no iterator)
        if (s?.reads && !s.impure) {
          if (s.reads.length >= MEMO_MAX_READS) s.impure = true;
          else {
            const a: any[] = [];
            for (let i = 0; i < args.length; i++) a.push(args[i]);
            s.reads.push({ kind: 'ref', name, args: a, fp: fingerprint(out) });
          }
        }
        return out;
      } catch (e) {
        if (s) s.refError = e;
        throw e;
      }
    },
  };
  const realm = sb ? sb.compile(`(${exprRealmSetup.toString()})`)(bridge) : exprRealmSetup(bridge);
  rt = {
    lib: realm.lib, noThis: realm.noThis, copyIn: realm.copyIn, error: realm.error,
    compileSource: sb ? (s) => sb.compile(s) : (s) => new Function(`return ${s}`)(),
    checkBody: sb ? (b) => sb.checkSyntax(b) : fallbackCheck,
    run: sb ? (job, ms) => sb.run(job, ms) : (job) => job(),
    compiled: new Map(),
    memo: new Map(),
    current: null,
  };
  runtimes.set(key, rt);
  return rt;
}

function fallbackCheck(body: string): { message: string; line: number } | null {
  try {
    new Function(body);
    return null;
  } catch (e: any) {
    if (e?.name !== 'SyntaxError') throw e;
    return { message: String(e.message), line: 1 };
  }
}

const IMPORT = /(?<![\w$])import(?![\w$])/;

/**
 * The function body an expression becomes, and the sloppy wrapper around it: `with` puts the scope proxy in front of
 * the global scope, and the wrapper returns the expression's strict function, which the evaluation calls with
 * `this` = noThis. The body starts on line 2 of the wrapper.
 */
const exprBody = (src: string) => `"use strict"; return (\n${src}\n);`;
const wrapper = (body: string) => `(function (__s) { with (__s) {\nreturn function () { ${body} }; } })`;

function compileNew(rt: Runtime, src: string): Compiled | ExprError {
  if (IMPORT.test(src)) return new ExprError(`expression "=${src}" cannot be used: import is not available in expressions`);
  // The strict function body the expression becomes. Unless the static check found only expression tokens (no
  // braces, semicolons, comments or templates, so it cannot close the wrapper), the body is parsed on its own first,
  // as wrangle snippets are: it is then complete and cannot close the wrapper it is pasted into.
  const body = exprBody(src);
  const simple = isSimpleExpr(src);
  // body line 1 is `"use strict"; return (`, so the expression's line n is body line n + 1
  const where = (bodyLine: number) => (src.includes('\n') ? ` (line ${Math.max(1, bodyLine - 1)})` : '');
  try {
    if (!simple) {
      const bad = rt.checkBody(body);
      if (bad) return new ExprError(`syntax error in expression "=${src}": ${bad.message}${where(bad.line)}`);
    }
    const fn = rt.compileSource(wrapper(body));
    return { fn, simple };
  } catch (e: any) {
    const line = /expression\.js:(\d+)/.exec(String(e?.stack ?? ''));
    return new ExprError(`syntax error in expression "=${src}": ${e?.message ?? e}${line ? where(Number(line[1]) - 1) : ''}`);
  }
}

/**
 * Compile the not yet compiled straight-line expressions among `srcs` in one script (about half the cost of one
 * script each; resolveParams passes all expressions of a node). They cannot contain braces, so none can leave its
 * wrapper; when the batch does not compile (a syntax error in one of them) they are compiled one by one when used.
 */
export function precompileExprs(host: Host | undefined, srcs: string[]) {
  const rt = runtimeFor(host);
  const todo = [...new Set(srcs)].filter((x) => !rt.compiled.has(x) && !IMPORT.test(x) && isSimpleExpr(x));
  if (todo.length < 2) return;
  let fns: any;
  try {
    fns = rt.compileSource(`[${todo.map((x) => wrapper(exprBody(x))).join(',\n')}]`);
  } catch {
    return;
  }
  if (rt.compiled.size + todo.length >= 10000) rt.compiled.clear();
  todo.forEach((x, i) => rt.compiled.set(x, { fn: fns[i], simple: true }));
}

function compiled(rt: Runtime, src: string): Compiled {
  let c = rt.compiled.get(src);
  if (c === undefined) {
    c = compileNew(rt, src);
    if (rt.compiled.size >= 10000) rt.compiled.clear();
    rt.compiled.set(src, c);
  }
  if (c instanceof ExprError) throw c;
  return c;
}

// ---------------------------------------------------------------- scope

/** Names that exist in a JS host but not in expressions get a message saying so (instead of "is not defined"). */
const HOST_NAMES = new Set([
  'process', 'require', 'module', 'exports', '__dirname', '__filename', 'globalThis', 'global', 'window', 'self',
  'document', 'fetch', 'import', 'eval', 'Function', 'Deno', 'Bun',
]);

function unknownName(k: string): string {
  if (HOST_NAMES.has(k) || k in globalThis) {
    return `${k} is not available in expressions (they can use graph vars, frame/time/fps/timeInc, Math, the helpers and ${REF_FUNCS.join('/')})`;
  }
  return `${k} is not defined`;
}

const isEnumerable = Object.prototype.propertyIsEnumerable;

/** Note a name read by a timed evaluation (once per evaluation), with what it resolves to now. */
function record(s: ScopeState, k: string) {
  s.readNames.add(k);
  if (s.impure) return;
  if (s.reads!.length >= MEMO_MAX_READS) { s.impure = true; return; }
  if (isEnumerable.call(s.vars, k)) s.reads!.push({ kind: 'var', name: k, fp: fingerprint(s.vars[k]) });
  else if (k in s.rt.lib) {
    if (k === 'Math') s.impure = true;
    s.reads!.push({ kind: 'lib', name: k });
  } else if (TIME_KEYS.has(k)) s.reads!.push({ kind: 'time', name: k, fp: fingerprint((s.time as any)[k]) });
  else s.impure = true; // an unknown name: the evaluation fails anyway
}

/** Limits of the memo: reads per evaluation, length of one fingerprint (longer: not remembered), entries. */
const MEMO_MAX_READS = 256, MEMO_MAX_FP = 4096, MEMO_MAX_SOURCES = 5000, MEMO_PER_SOURCE = 8;

/**
 * A string that is equal for equal engine values (key order, -0, undefined, NaN and vecOut accessors included), or
 * null for values that should not be memoized on (symbols, very large, deep or circular data).
 */
function fingerprint(v: any, depth = 0): string | null {
  switch (typeof v) {
    case 'number': return Object.is(v, -0) ? '-0' : String(v);
    case 'string': return JSON.stringify(v);
    case 'boolean': return v ? 'T' : 'F';
    case 'undefined': return 'U';
    case 'bigint': return v + 'n';
    case 'function': return 'fn';
    case 'symbol': return null;
  }
  if (v === null) return 'N';
  if (depth > 64) return null;
  const parts: string[] = [];
  if (Array.isArray(v) || ArrayBuffer.isView(v)) {
    const n = (v as any).length ?? 0;
    if (n > MEMO_MAX_FP) return null;
    for (let i = 0; i < n; i++) { const p = fingerprint((v as any)[i], depth + 1); if (p === null) return null; parts.push(p); }
    return (Object.prototype.hasOwnProperty.call(v, 'x') ? 'V[' : '[') + parts.join(',') + ']';
  }
  const keys = Object.keys(v);
  if (keys.length > MEMO_MAX_FP) return null;
  for (const k of keys) { const p = fingerprint(v[k], depth + 1); if (p === null) return null; parts.push(JSON.stringify(k) + ':' + p); }
  return '{' + parts.join(',') + '}';
}

const NO_HIT = Symbol('no memo hit');

/**
 * A remembered result of a timed expression whose reads all give the same values now. Evaluation is deterministic
 * given its reads (the realm holds no other state: built-ins and the library are frozen, vars are copies, Math, the
 * one source of randomness, is never memoized), so the result is the same and the timed call can be skipped.
 */
function memoHit(s: ScopeState, src: string): any {
  const list = s.rt.memo.get(src);
  if (!list) return NO_HIT;
  next: for (const m of list) {
    for (const r of m.reads) {
      const isVar = isEnumerable.call(s.vars, r.name);
      if (r.kind === 'var') {
        if (!isVar || fingerprint(s.vars[r.name]) !== r.fp) continue next;
      } else if (r.kind === 'ref') {
        let out;
        try { out = ((s.fns ?? NO_COOK_FNS)[r.name] ?? NO_COOK_FNS[r.name]).apply(undefined, r.args!); } catch { continue next; }
        if (fingerprint(out) !== r.fp) continue next;
      } else if (isVar) continue next; // a var now shadows the helper or time name
      else if (r.kind === 'time' && fingerprint((s.time as any)[r.name]) !== r.fp) continue next;
    }
    for (const r of m.reads) if (r.kind === 'time') s.onTime?.();
    return m.value !== null && typeof m.value === 'object' ? structuredClone(m.value) : m.value;
  }
  return NO_HIT;
}

function remember(s: ScopeState, src: string, value: any) {
  const memo = s.rt.memo;
  if (memo.size >= MEMO_MAX_SOURCES) memo.clear();
  const list = memo.get(src) ?? [];
  list.unshift({ reads: s.reads!, value: value !== null && typeof value === 'object' ? structuredClone(value) : value });
  if (list.length > MEMO_PER_SOURCE) list.length = MEMO_PER_SOURCE;
  memo.set(src, list);
}

/** The `with` scope of an expression: claims every name, so no lookup reaches the realm's global scope. */
const SCOPE: ProxyHandler<ScopeState> = {
  has: (_s, k) => typeof k === 'string',
  get(s, k) {
    if (typeof k !== 'string') return undefined; // Symbol.unscopables
    if (s.reads && !s.readNames.has(k)) record(s, k);
    if (isEnumerable.call(s.vars, k)) {
      const v = s.vars[k];
      if (v === null || (typeof v !== 'object' && typeof v !== 'function')) return v;
      let c = s.copies.get(k);
      if (c === undefined && !s.copies.has(k)) {
        try { c = s.rt.copyIn(v); } catch (e: any) { throw s.rt.error('Error', `var "${k}" cannot be read: ${String(e?.message ?? e)}`); }
        s.copies.set(k, c);
      }
      return c;
    }
    const lib = s.rt.lib;
    if (k in lib) return lib[k];
    if (TIME_KEYS.has(k)) {
      s.onTime?.();
      return (s.time as any)[k];
    }
    throw s.rt.error('ReferenceError', unknownName(k));
  },
  set(s, k) {
    throw s.rt.error('TypeError', `expressions cannot assign to "${String(k)}" (graph vars are read-only)`);
  },
};

/** One scope serves all expressions of a node (resolveParams) or one evalExpr call. */
export interface ExprScope { rt: Runtime; state: ScopeState; proxy: any; timeoutMs: number }

export function exprScope(vars: Record<string, any>, env: ExprEnv = {}): ExprScope {
  const rt = runtimeFor(env.host);
  const state: ScopeState = {
    rt, vars: vars ?? {}, copies: new Map(), time: env.time ?? DEFAULT_TIME, onTime: env.onTime, fns: env.fns,
    reads: null, readNames: new Set(), impure: false,
  };
  return { rt, state, proxy: new Proxy(state, SCOPE), timeoutMs: env.timeoutMs ?? 30000 };
}

// ---------------------------------------------------------------- evaluation

const NO_ARGS: any[] = [];

/** Copy an expression's result out of the sandbox realm: primitives, arrays and plain data. */
function toMain(v: any, up: any[]): any {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'function') throw new Error('the expression gives a function, not a value');
    return v;
  }
  if (up.includes(v)) throw new Error('the expression gives a circular structure');
  if (up.length > 100) throw new Error('the expression gives a structure nested too deeply');
  up.push(v);
  let out: any;
  if (Array.isArray(v)) {
    const n = v.length;
    out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = toMain(v[i], up);
  } else {
    out = {};
    for (const k of Object.keys(v)) Object.defineProperty(out, k, { value: toMain(v[k], up), enumerable: true, writable: true, configurable: true });
  }
  up.pop();
  return out;
}

/** The message of whatever an expression threw (read inside the evaluation's time limit: it may run user code). */
function describe(e: any): string {
  try {
    if (e !== null && typeof e === 'object') {
      const m = e.message;
      if (typeof m === 'string') return m;
    }
    return String(e);
  } catch {
    return 'an exception that cannot be described';
  }
}

/** Evaluate one expression (without the leading "=") in a scope. */
export function evalIn(scope: ExprScope, src: string): any {
  const { rt, state } = scope;
  const c = compiled(rt, src);
  let value: any, failed: string | undefined;
  const job = () => {
    try { value = toMain(Reflect.apply(c.fn(scope.proxy), rt.noThis, NO_ARGS), []); } catch (e) { failed = describe(e); }
  };
  const prev = rt.current;
  rt.current = state;
  state.refError = undefined;
  try {
    if (c.simple) job();
    else {
      // timed: unless a remembered result still holds, run under the timer and record what the expression reads
      const hit = memoHit(state, src);
      if (hit !== NO_HIT) return hit;
      state.reads = [];
      state.readNames.clear();
      state.impure = false;
      rt.run(job, scope.timeoutMs);
      if (failed === undefined && state.refError === undefined && !state.impure && state.reads.every((r) => r.fp !== null && (r.fp === undefined || r.fp.length <= MEMO_MAX_FP))) remember(state, src, value);
    }
  } catch (e: any) {
    // the host stopped the job (timeout), or the host call itself failed
    const msg = String(e?.message ?? e);
    if (/timed out/i.test(msg)) throw new ExprError(`expression "=${src}" exceeded ${scope.timeoutMs} ms (infinite loop?)`);
    throw new ExprError(`expression "=${src}" failed: ${msg}`);
  } finally {
    rt.current = prev;
    state.reads = null;
  }
  if (failed !== undefined) {
    if (state.refError instanceof DeferredExpr) throw state.refError;
    const names = Object.keys(state.vars);
    throw new ExprError(`expression "=${src}" failed: ${failed}. Vars in scope: ${names.length ? names.join(', ') : '(none)'}`);
  }
  return value;
}

/**
 * Evaluate an expression (without the leading "="). Identifiers resolve to graph vars, then the helpers and
 * reference functions, then time (frame, time, fps, timeInc). Pass env.host to run it in that host's sandbox.
 */
export function evalExpr(src: string, vars: Record<string, any>, env: ExprEnv = {}): any {
  return evalIn(exprScope(vars, env), src);
}
