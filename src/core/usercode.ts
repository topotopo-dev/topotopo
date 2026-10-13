// Running user code (wrangle kernels, code params) under the host's time limit. Host.runGuarded stops code that runs
// too long, but what the code throws is user code too: an object whose `message` or `stack` getter (or toString) never
// returns, or an error of a realm whose Error.prepareStackTrace loops (reading `stack` calls it), hung the process when
// the error was read after the guarded call had returned. runUserCode reads whatever is thrown inside the same limit
// and hands back plain strings.
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
