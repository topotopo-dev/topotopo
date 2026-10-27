// Running user code (wrangle kernels, code params) under the host's time limit, and the graph vars it reads by name.
// Host.runGuarded stops code that runs too long, but what the code throws is user code too: an object whose `message`
// or `stack` getter (or toString) never returns, or an error of a realm whose Error.prepareStackTrace loops (reading
// `stack` calls it), hung the process when the error was read after the guarded call had returned. runUserCode reads
// whatever is thrown inside the same limit and hands back plain strings.
import type { Host } from '../host/types.ts';

/** What user code threw, read as strings. */
export interface Thrown {
  /** String(e.message ?? e), as error messages have always read it */
  message: string;
  /** String(e.stack ?? ''); '' when there is none or it cannot be read */
  stack: string;
}

/** The message of a thrown value whose message cannot be read (its getter or toString throws). */
export const UNDESCRIBABLE = 'an exception that cannot be described';

/**
 * Read a thrown value as strings (the stack only when `withStack`). This runs user code (getters, toString, a realm's
 * Error.prepareStackTrace): call it inside the time limit.
 */
export function describeThrown(e: any, withStack = true): Thrown {
  let message: string, stack = '';
  try { message = String(e?.message ?? e); } catch { message = UNDESCRIBABLE; }
  if (withStack) try { stack = String(e?.stack ?? ''); } catch { stack = ''; }
  return { message, stack };
}

/**
 * The error runUserCode throws: the code's own error (message and stack read inside the limit, so reading them again
 * runs nothing), or the host's "timed out" error when the limit stopped the code (`timedOut`).
 */
export class UserCodeError extends Error {
  /** the host's time limit stopped the code (a user error that merely says "timed out" is not one) */
  timedOut: boolean;
  constructor(t: Thrown, timedOut: boolean) {
    super(t.message);
    this.timedOut = timedOut;
    this.stack = t.stack;
  }
}

/**
 * Run fn (which runs user code) under the host's time limit. What it throws is read inside the limit (its stack only
 * when `withStack`) and rethrown as a UserCodeError; anything that escapes the guarded call itself is the host stopping
 * it, a UserCodeError with timedOut.
 */
export function runUserCode<T>(host: Host, fn: () => T, timeoutMs: number, withStack = false): T {
  const box: { thrown?: Thrown } = {};
  let value: T;
  try {
    value = host.runGuarded(() => {
      try { return fn(); } catch (e) { box.thrown = describeThrown(e, withStack); return undefined as T; }
    }, timeoutMs);
  } catch (e: any) {
    // The host's own error. Only its message is read: a vm timeout error is created in the script realm, so formatting
    // its stack would call that realm's Error.prepareStackTrace, which user code may have replaced.
    let message: string;
    try { message = typeof e?.message === 'string' ? e.message : String(e); } catch { message = UNDESCRIBABLE; }
    throw new UserCodeError({ message, stack: '' }, /timed out/i.test(message));
  }
  if (box.thrown) throw new UserCodeError(box.thrown, false);
  return value;
}

/**
 * describeThrown under the host's time limit, for a value thrown outside any guarded call (the rejection of an async
 * run of user code). null when reading it did not finish within timeoutMs.
 */
export function describeGuarded(host: Host, e: any, timeoutMs: number, withStack = false): Thrown | null {
  const box: { t?: Thrown } = {};
  try {
    host.runGuarded(() => { box.t = describeThrown(e, withStack); }, timeoutMs);
  } catch {
    return null;
  }
  return box.t ?? null;
}

// ---------------------------------------------------------------- graph vars in user code
//
// Code reads graph vars the way "=expr" params do: by their bare name (`height`, not `vars.height`). A node binds the
// vars its code names once per cook, as constants of a function around the code, so the code's own names (its locals,
// the node's per-element names such as @ptnum or a heightfield layer) come first. Only the vars the code names are
// bound, and only they key the node's cache (NodeDef.usesVars). `vars` itself is bound to a guard whose every use
// fails with what to write instead.

/** JavaScript's reserved words (and the names strict code cannot bind): a var with one of these names cannot be read. */
export const RESERVED_WORDS: ReadonlySet<string> = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum',
  'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'implements', 'import', 'in', 'instanceof',
  'interface', 'let', 'new', 'null', 'package', 'private', 'protected', 'public', 'return', 'static', 'super', 'switch',
  'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'arguments', 'eval',
]);

/**
 * The standard globals of a JavaScript realm. Code sees them (the scripting realm has these, the snippet library and
 * console); a var of the same name would hide one. test/engine.ts checks the list against the scripting realm.
 */
export const JS_GLOBALS: ReadonlySet<string> = new Set([
  'globalThis', 'Infinity', 'NaN', 'undefined', 'eval', 'isFinite', 'isNaN', 'parseFloat', 'parseInt', 'decodeURI',
  'decodeURIComponent', 'encodeURI', 'encodeURIComponent', 'escape', 'unescape', 'AggregateError', 'Array', 'ArrayBuffer',
  'AsyncDisposableStack', 'Atomics', 'BigInt', 'BigInt64Array', 'BigUint64Array', 'Boolean', 'DataView', 'Date',
  'DisposableStack', 'Error', 'EvalError', 'FinalizationRegistry', 'Float16Array', 'Float32Array', 'Float64Array',
  'Function', 'Int8Array', 'Int16Array', 'Int32Array', 'Intl', 'Iterator', 'JSON', 'Map', 'Math', 'Number', 'Object',
  'Promise', 'Proxy', 'RangeError', 'ReferenceError', 'Reflect', 'RegExp', 'Set', 'SharedArrayBuffer', 'String',
  'SuppressedError', 'Symbol', 'SyntaxError', 'TypeError', 'Uint8Array', 'Uint8ClampedArray', 'Uint16Array',
  'Uint32Array', 'URIError', 'WeakMap', 'WeakRef', 'WeakSet', 'WebAssembly', 'console',
]);

// an identifier not preceded by ".", "@" (wrangle attributes), "#" (private names) or a backslash
const CODE_NAME = /(?<![\w$.@#\\])[A-Za-z_$][\w$]*/g;
const BINDABLE = /^[A-Za-z_$][\w$]*$/;

/**
 * The graph vars `code` reads by their bare name: the names of `vars` that appear in it as identifiers (anywhere, also
 * in strings and comments: a superset of what it can read), sorted. Names no binding can carry (keywords, `vars`,
 * names starting with "__") are left out: code cannot read them.
 */
export function codeVarNames(code: string, vars: Record<string, any> | undefined): string[] {
  if (!vars || typeof code !== 'string' || !code) return [];
  const out = new Set<string>();
  for (const m of code.matchAll(CODE_NAME)) {
    const n = m[0];
    if (Object.hasOwn(vars, n) && BINDABLE.test(n) && !RESERVED_WORDS.has(n) && n !== 'vars' && !n.startsWith('__')) out.add(n);
  }
  return [...out].sort();
}

/** The vars of `names`, for a cache key (missing ones are left out). */
export function pickVars(vars: Record<string, any>, names: string[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const n of names) if (Object.hasOwn(vars, n)) out[n] = vars[n];
  return out;
}

/** Freeze a value and everything in it (typed arrays, which cannot be frozen, stay as they are). */
export function deepFreeze<T>(v: T): T {
  if (v === null || typeof v !== 'object' || ArrayBuffer.isView(v) || Object.isFrozen(v)) return v;
  Object.freeze(v);
  for (const k of Object.keys(v)) deepFreeze((v as any)[k]);
  return v;
}

/**
 * What code gets for the vars `names`: frozen copies (writing a var fails as writing a constant does, and nothing the
 * code does reaches the graph's own values or the next node).
 */
export function codeVarValues(vars: Record<string, any>, names: string[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const n of names) {
    try { out[n] = deepFreeze(structuredClone(vars[n])); } catch (e: any) { throw new Error(`var "${n}" cannot be read by code: ${e?.message ?? e}`); }
  }
  return Object.freeze(out);
}

/**
 * The declarations that bind the vars `names` from the object `values` and `vars` to the guard `guard` (source text
 * for the function around the code): `const vars = __varsGuard, height = __vars["height"];`.
 */
export function codeVarDecl(names: string[], values = '__vars', guard = '__varsGuard'): string {
  return `const vars = ${guard}${names.map((n) => `, ${n} = ${values}[${JSON.stringify(n)}]`).join('')};`;
}
