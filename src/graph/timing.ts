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

/** The timing lines of a cook report ([] when no node cooked for minMs). */
export function timingLines(r: CookReport, scriptLimitMs: number, o: TimingOptions = {}): string[] {
  const min = o.minMs ?? 50, max = o.nodes ?? 5;
  const slow = [...r.results.values()].filter((x) => !x.cached && x.ms >= min).sort((a, b) => b.ms - a.ms);
  if (!slow.length) return [];
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
  return lines;
}
