// The cook state the page shows in the status bar and above the Controls: what is cooking (the node, the time), how
// the last cook ended (its time, the failing node and message, where it was stopped), and the progress of a package
// update's before/after. The server sends the state ({cook} and {compare} events, /api/graphs); between events the
// page counts the time itself. Plain functions, tested in Node (test/viewer-logic.ts).

/** "850 ms", "12.3 s", "2 min 05 s". */
export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}

const firstLine = (s) => String(s ?? '').split('\n')[0];

/** A cook shows as running once it has run this long (ms): shorter ones do not flicker. */
export const SHOW_AFTER = 150;

/**
 * The line for a graph's cook state: {kind, text, title}. kind: "running", "stopping", "ok", "failed", "stopped" or
 * "none". `state`: {running: {cooks, kinds, elapsed, node, nodeElapsed, inner, stopping} | null, last: {ok, ms,
 * stopped?, error?: {node, message}} | null}; `since`: ms since it arrived, added to the running times.
 */
export function cookLine(state, since = 0) {
  const r = state?.running;
  if (r && (r.elapsed + since >= SHOW_AFTER || r.stopping)) {
    const where = r.node ? `${r.node}${r.inner ? ` › ${r.inner}` : ''}` : '';
    const total = fmtDuration(r.elapsed + since);
    const node = r.node ? `${r.node} has cooked for ${fmtDuration(r.nodeElapsed + since)}` : 'between nodes';
    if (r.stopping) {
      return {
        kind: 'stopping', text: `stopping${where ? ` after ${where}` : ''} · ${total}`,
        title: `${node}. A node cannot be interrupted mid-way: the cook stops when it has finished, and the view keeps the last finished cook.`,
      };
    }
    const verb = r.kinds?.length && r.kinds.every((k) => k === 'export') ? 'exporting' : 'cooking';
    if (r.superseded && where) {
      return {
        kind: 'running', text: `${verb} ${where} · the new value follows · ${total}`,
        title: `${node}. A node cannot be interrupted mid-way: the newest value cooks once it has finished (values in between are skipped).`,
      };
    }
    return { kind: 'running', text: `${verb}${where ? ` ${where}` : ''} · ${total}`, title: `${node}${r.cooks > 1 ? ` (${r.cooks} cooks of this graph)` : ''}. Stop ends it at the next node; changing a value starts over with the new value.` };
  }
  const l = state?.last;
  if (!l) return { kind: 'none', text: '', title: '' };
  if (l.stopped) return { kind: 'stopped', text: `stopped at ${l.stopped} · the view shows the last finished cook`, title: 'change a value (or save the graph file) to cook again' };
  if (!l.ok) {
    const msg = l.error?.message ?? 'failed';
    return { kind: 'failed', text: `failed at ${l.error?.node ?? 'the graph'}: ${firstLine(msg)}`, title: `${l.error?.node ?? ''}: ${msg}` };
  }
  return { kind: 'ok', text: `cooked in ${fmtDuration(l.ms)}`, title: `the last cook of the whole graph took ${fmtDuration(l.ms)}` };
}

/** True while a cook state shows a cook in progress (the page then ticks its time). */
export const isRunning = (state) => !!state?.running;

/**
 * The line for the before/after of a package update in progress (src/viewer/packages.ts): {kind, text, title}, kind
 * "running" or "stopping". `state`: {package, from, to, done, total, what, elapsed, stopping}; `since`: ms since it
 * arrived, added to the time.
 */
export function compareLine(state, since = 0) {
  const total = fmtDuration(state.elapsed + since);
  const head = `${state.package}${state.from && state.to ? ` ${state.from} → ${state.to}` : ''}`;
  if (state.stopping) {
    return {
      kind: 'stopping', text: `stopping the before/after of ${head} · ${total}`,
      title: 'A node cannot be interrupted mid-way: the before/after stops when it has finished, and keeps the places it compared.',
    };
  }
  const step = state.total ? `${Math.min(state.done + 1, state.total)}/${state.total} ` : '';
  return {
    kind: 'running', text: `before/after ${head} · ${step}${state.what} · ${total}`,
    title: 'Every place the project uses the package cooks with the version in use and with the new one. Stop ends it at the next node; the places compared stay.',
  };
}
