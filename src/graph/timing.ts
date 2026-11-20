// Where a cook's time went, as text for the CLI and the MCP tools: the slowest nodes (each node's own cook; its inputs
// count at their own nodes) and, under each, the stages its time went to (CookContext.stage: a script's lib.run calls
// by node type), with the script time limit when the slowest node came near it.
import type { CookReport } from './engine.ts';

/** Milliseconds below a second, else seconds. */
export function duration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 100000 ? 0 : 1)} s` : `${Math.round(ms)} ms`;
}

export interface TimingOptions {
  /** nodes that cooked at least this long are listed (default 50 ms) */
  minMs?: number;
  /** at most this many nodes (default 5; Infinity for all) */
  nodes?: number;
}

/**
 * The nodes the cook loaded from the disk cache (Host.persist), as one line: each with the time loading took and the time
 * its cook took when it was stored. [] when there were none.
 */
export function diskCacheLines(r: CookReport): string[] {
  const from = [...r.results.values()].filter((x) => x.disk).sort((a, b) => (b.savedMs ?? 0) - (a.savedMs ?? 0));
  if (!from.length) return [];
  const saved = from.reduce((t, x) => t + (x.savedMs ?? 0), 0);
  const list = from.slice(0, 5).map((x) => `${x.node} ${duration(x.ms)} (cooked in ${duration(x.savedMs ?? 0)})`).join(', ');
  return [`disk cache: ${from.length} node${from.length === 1 ? '' : 's'} loaded instead of cooked, saving about ${duration(Math.max(0, saved - from.reduce((t, x) => t + x.ms, 0)))}: ${list}${from.length > 5 ? `, +${from.length - 5} more` : ''}`];
}

/** The timing lines of a cook report ([] when no node cooked for minMs and none came from the disk cache). */
export function timingLines(r: CookReport, scriptLimitMs: number, o: TimingOptions = {}): string[] {
  const min = o.minMs ?? 50, max = o.nodes ?? 5;
  const slow = [...r.results.values()].filter((x) => !x.cached && x.ms >= min).sort((a, b) => b.ms - a.ms);
  if (!slow.length) return diskCacheLines(r);
  const top = slow.slice(0, max);
  const near = top[0].ms >= scriptLimitMs / 2;
  const more = slow.length > top.length ? `, +${slow.length - top.length} more over ${duration(min)}` : '';
  const limit = near ? `; the script time limit is ${duration(scriptLimitMs)} (TOPOTOPO_SCRIPT_TIMEOUT_MS)` : '';
  const lines = [`timing (${duration(r.ms)} in all): ${top.map((x) => `${x.node} ${duration(x.ms)}${x.error ? ' (failed)' : ''}`).join(', ')}${more}${limit}`];
  for (const x of top) {
    if (!x.stages) continue;
    const st = Object.entries(x.stages).sort((a, b) => b[1].ms - a[1].ms);
    const shown = st.slice(0, 6).map(([k, v]) => `${k} ${v.calls > 1 ? `${v.calls}× ` : ''}${duration(v.ms)}`);
    lines.push(`  ${x.node}: ${shown.join(', ')}${st.length > shown.length ? `, +${st.length - shown.length} more` : ''}`);
  }
  lines.push(...diskCacheLines(r));
  return lines;
}
