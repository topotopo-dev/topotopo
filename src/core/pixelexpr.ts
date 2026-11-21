// Per-sample expressions over images and layers: the compile that heightfield_layer and tex_layers share, and the
// run of several expressions over the pixels of an image on the worker pool.
//
// An expression is a JS expression (or a body with `return`) that reads the sample's values by name and returns a
// number. It runs in the host's script realm (so the wrangle helpers smoothstep, fit, clamp, min, max, pow … are
// there), is parsed on its own first (a complete function body cannot close the wrapper it is pasted into, so
// nothing runs while compiling), and sees the graph vars it names as constants around the function, so a sample
// variable of the same name comes first. compilePixelFunction() is that compile; runPixelExprs() generates one kernel
// source for a set of expressions and runs it in chunks through the wrangle host kernel of the pool (each worker
// compiles the same source in its own realm; on this thread the same kernel runs in one piece), so a result is the
// same bits with or without workers.
import type { Host } from '../host/types.ts';
import { JS_GLOBALS, codeVarDecl, codeVarNames, codeVarValues, deepFreeze, runUserCode, UserCodeError } from './usercode.ts';
import { scriptVarsGuard } from './snippet-lib.ts';
import { CROSS_ELEMENT } from './wrangle.ts';

const IDENT = /^[A-Za-z_$][\w$]*$/;

/** True when `name` appears in `code` as a bare identifier (not a property, not part of a longer name). */
export const usesName = (code: string, name: string): boolean =>
  new RegExp(`(^|[^\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(code);

/** A name an expression can bind as a variable: an identifier, not one of `reserved` and not a JS keyword. */
export const bindableName = (name: string, reserved: ReadonlySet<string> = new Set()): boolean =>
  IDENT.test(name) && !reserved.has(name) && !JS_KEYWORDS.has(name) && !name.startsWith('__') && name !== 'vars';

const JS_KEYWORDS: ReadonlySet<string> = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends',
  'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw',
  'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'await', 'async', 'arguments', 'eval', 'undefined', 'NaN', 'Infinity',
]);

/** The function body an expression stands for: the code itself when it has a `return`, else `return (code);`. */
export const expressionBody = (code: string): string => (/\breturn\b/.test(code) ? code : `return (${code});`);

/** An expression that does not parse; the message says so and, for code of several lines, where. */
export class PixelSyntaxError extends Error {}

/** Parse the expression on its own; throws PixelSyntaxError ("expression syntax error: …"). */
function checkExpression(host: Host, code: string, body: string): void {
  const bad = host.checkSyntax?.(`"use strict";${body}`);
  if (bad) throw new PixelSyntaxError(`expression syntax error: ${bad.message}${code.includes('\n') ? ` (line ${bad.line})` : ''}`);
}

/**
 * The source of the function that makes a per-sample function: `(function(__L, __B, __vars, __varsGuard){ … return
 * function(k, <params>){ <decl> <body> }; })`. `decl` are the declarations that read the sample's values (`const
 * height = __L["height"][k];`) and `varNames` the graph vars the code names (bound once around the function).
 */
export function pixelFunctionSource(code: string, params: string, decl: string[], varNames: string[]): string {
  return `(function(__L, __B, __vars, __varsGuard){ "use strict"; ${codeVarDecl(varNames)}\nreturn function(k${params ? ', ' + params : ''}){ ${decl.join(' ')}\n${expressionBody(code)}\n}; })`;
}

/**
 * Compile an expression into a maker `(L, B, vars, guard) => f(k, …params)`. The code is parsed alone first; a syntax
 * error is a PixelSyntaxError. `decl` and `varNames` as in pixelFunctionSource.
 */
export function compilePixelFunction(host: Host, code: string, params: string, decl: string[], varNames: string[]): (L: any, B: any, vars: any, guard: any) => (...a: any[]) => any {
  checkExpression(host, code, expressionBody(code));
  try {
    return host.compile(pixelFunctionSource(code, params, decl, varNames));
  } catch (e: any) {
    throw new PixelSyntaxError(`expression syntax error: ${e.message}`);
  }
}

// ---------------------------------------------------------------- expressions over image layers

export interface PixelExprJob {
  host: Host;
  /** the expressions, each evaluated for every pixel of the mask; `label` names it in an error */
  exprs: { code: string; label: string }[];
  /** per-pixel values the expressions read, by variable name (a name is bound only in the expressions that use it) */
  inputs: Record<string, Float32Array>;
  /** pixels (the length of every input) */
  count: number;
  /** pixels to evaluate (1 = yes); the others read 0 in the results. null = all */
  mask: Uint8Array | null;
  /** the indices of the mask's pixels, ascending (null = all): the only ones scanned for values that are no number */
  covered?: Uint32Array | null;
  /** the graph vars of the cook (an expression reads the ones it names) */
  vars: Record<string, any>;
  /** the host's script time limit per chunk */
  timeoutMs: number;
}

export interface PixelExprResult {
  /** one array per expression (NaN or infinity written as 0) */
  values: Float32Array[];
  /** per expression: pixels whose value was not a finite number */
  bad: number[];
  /** graph vars the expressions name that an input of the same name hides */
  hidden: string[];
}

/** A run of an expression failed: the expression's index and what its code said (after a ReferenceError, `missing` is the name). */
export class PixelExprError extends Error {
  index: number;
  missing: string | undefined;
  /** the expression is the name of a helper function, used as a value */
  helper: string | undefined;
  timedOut: boolean;
  constructor(index: number, message: string, timedOut = false) {
    super(message);
    this.index = index;
    this.timedOut = timedOut;
    this.missing = /^([A-Za-z_$][\w$]*) is not defined$/.exec(message)?.[1];
    this.helper = /^([A-Za-z_$][\w$]*) is a function, not a value$/.exec(message)?.[1];
  }
}

/** What the kernel throws to name the expression that failed: \u0001 index \u0001 message. */
const MARK = '\u0001';

/** The kernel source for the wrangle host kernel: every expression, compiled once, over the pixels [s, e) of the chunk. */
function kernelSource(job: PixelExprJob, names: string[], decls: string[][], varNames: string[][]): string {
  const m = names.length, e = job.exprs.length;
  const src: string[] = ['(function(__env){', '"use strict";'];
  src.push(`const __L = {}; ${names.map((n, i) => `__L[${JSON.stringify(n)}] = __env.B[${i}].data;`).join(' ')}`);
  job.exprs.forEach((x, i) => src.push(`const __f${i} = ${pixelFunctionSource(x.code, '', decls[i], varNames[i])}(__L, null, __env.vars, __env.varsGuard);`));
  src.push(`const __o = [${job.exprs.map((_, i) => `__env.B[${m + i}].data`).join(', ')}];`);
  src.push('const __s = __env.s | 0, __e = __env.e === undefined ? __env.n : __env.e, __mask = __env.mask;');
  src.push('let __cur = 0;');
  src.push('try {');
  src.push('for (let k = __s; k < __e; k++) {', 'if (__mask && !__mask[k]) continue;');
  for (let i = 0; i < e; i++) {
    const bare = job.exprs[i].code.trim(), label = IDENT.test(bare) ? bare : 'the expression';
    src.push(`__cur = ${i}; { const r = __f${i}(k); if (typeof r === 'function') throw new Error(${JSON.stringify(label + ' is a function, not a value')}); __o[${i}][k] = typeof r === 'number' ? r : typeof r === 'boolean' ? +r : NaN; }`);
  }
  src.push('}');
  src.push(`} catch (__x) { let __m; try { __m = typeof __x === 'object' && __x !== null ? String(__x.message) : String(__x); } catch (__y) { __m = 'an exception that cannot be described'; } throw new Error(${JSON.stringify(MARK)} + __cur + ${JSON.stringify(MARK)} + __m); }`);
  src.push('})');
  return src.join('\n');
}

/** What the wrangle kernel's args carry besides the source (the worker reads these fields of every wrangle job). */
const NO_LINES = 1 << 30;

/**
 * Run the expressions over the masked pixels. `par` runs the job on the pool, or calls `serial` to run it here, as in
 * runWrangleParallel (CookContext.parallelMap('wrangle', job, { serial, minElements })), and returns a promise when
 * the pool took it. Throws PixelSyntaxError before anything runs and PixelExprError for a failing expression.
 */
export function runPixelExprs(
  job: PixelExprJob,
  par: (job: { count: number; args: any; inputs: Record<string, Float32Array | Uint8Array>; results: Record<string, Float32Array> }, serial: () => void) => unknown,
): PixelExprResult | Promise<PixelExprResult> {
  const { host, exprs, count } = job;
  // bind each input only where an expression names it
  const names = Object.keys(job.inputs).filter((n) => bindableName(n, new Set(['k'])) && exprs.some((x) => usesName(x.code, n)));
  const own = new Set(Object.keys(job.inputs));
  own.add('k');
  const hiddenVars = new Set<string>();
  const decls: string[][] = [], varNames: string[][] = [];
  exprs.forEach((x, i) => {
    try { checkExpression(host, x.code, expressionBody(x.code)); } catch (e: any) { throw new PixelSyntaxError(`${x.label}: ${e.message}`); }
    decls[i] = names.filter((n) => usesName(x.code, n)).map((n) => `const ${n} = __L[${JSON.stringify(n)}][k];`);
    varNames[i] = [];
    for (const n of codeVarNames(x.code, job.vars)) {
      if (own.has(n)) hiddenVars.add(n);
      else varNames[i].push(n);
    }
  });
  const allVars = [...new Set(varNames.flat())].sort();
  const source = kernelSource(job, names, decls, varNames);
  try { host.compile(source); } catch (e: any) { throw new PixelSyntaxError(`expression syntax error: ${e.message}`); }
  // results in shared memory are written in place by the workers: no copy back
  const results = exprs.map(() => (typeof SharedArrayBuffer !== 'undefined' ? new Float32Array(new SharedArrayBuffer(count * 4)) : new Float32Array(count)));
  const inputs: Record<string, Float32Array | Uint8Array> = {}, B: { data: Float32Array }[] = [];
  names.forEach((n, i) => { inputs['b' + i] = job.inputs[n]; B.push({ data: job.inputs[n] }); });
  if (job.mask) inputs.mask = job.mask;
  const outs: Record<string, Float32Array> = {};
  results.forEach((r, i) => { outs['b' + (names.length + i)] = r; B.push({ data: r }); });
  const vars = codeVarValues(job.vars, allVars);
  const fail = (e: any): never => {
    const msg = String(e?.message ?? e);
    const m = new RegExp(`^(?:wrangle error: )?${MARK}(\\d+)${MARK}([\\s\\S]*)$`).exec(msg);
    if (m) throw new PixelExprError(Number(m[1]), m[2]);
    if (/^wrangle exceeded/.test(msg) || e?.timedOut) throw new PixelExprError(-1, `expression exceeded ${job.timeoutMs} ms (infinite loop?)`, true);
    throw new Error(msg.replace(/^wrangle error: /, ''));
  };
  const args = {
    source, bindings: B.length, n: count, numpt: 0, numprim: 0, numvtx: 0, frame: 1, time: 0, timeInc: 1 / 24,
    vars, timeoutMs: job.timeoutMs, bodyLine: NO_LINES, code: '',
  };
  const serial = () => {
    const kernel = host.compile(source);
    const env = { n: count, s: 0, e: count, mask: job.mask, B, vars: deepFreeze(structuredClone(vars)), varsGuard: scriptVarsGuard(host) };
    try { runUserCode(host, () => kernel(env), job.timeoutMs, true); } catch (e: any) { if (e instanceof UserCodeError && e.timedOut) throw new PixelExprError(-1, `expression exceeded ${job.timeoutMs} ms (infinite loop?)`, true); return fail(e); }
  };
  const finish = (): PixelExprResult => {
    const cov = job.covered;
    const bad = results.map((r) => {
      let n = 0;
      if (cov) { for (let q = 0; q < cov.length; q++) { const k = cov[q]; if (!Number.isFinite(r[k])) { r[k] = 0; n++; } } }
      else for (let k = 0; k < r.length; k++) if (!Number.isFinite(r[k])) { r[k] = 0; n++; }
      return n;
    });
    return { values: results, bad, hidden: [...hiddenVars].sort() };
  };
  // code that reads shared state (globalThis, this, eval, geometry functions) runs in one piece here, as a wrangle's does
  const crossElement = exprs.some((x) => CROSS_ELEMENT.test(expressionBody(x.code)));
  let run: unknown;
  try { if (crossElement) serial(); else run = par({ count, args, inputs, results: outs }, serial); } catch (e: any) { if (e instanceof PixelExprError) throw e; return fail(e); }
  if (run instanceof Promise) return run.then(finish, fail);
  return finish();
}

const helperCache = new WeakMap<object, ReadonlySet<string>>();

/**
 * The names the script realm of `host` defines as functions (the wrangle helpers: smoothstep, fit, noise …) and the JS
 * globals: a mask variable of one of these names would hide it from the expressions that use it.
 */
export function realmHelperNames(host: Host): ReadonlySet<string> {
  let s = helperCache.get(host);
  if (s) return s;
  const out = new Set<string>(JS_GLOBALS);
  try {
    const g: any = host.compile('globalThis');
    for (const k of Object.getOwnPropertyNames(g)) { try { if (typeof g[k] === 'function') out.add(k); } catch { /* a getter that throws is no helper */ } }
  } catch { /* a host without a readable global has only the JS globals */ }
  helperCache.set(host, (s = out));
  return s;
}
