// The undo stack of the person's own edits (guides and vars). An entry is {label, undo(), redo(), key?}: undo and
// redo apply a state the page already knows, so they never ask the server for anything first. Consecutive entries
// with the same key within `mergeMs` (typing a radius, nudging one control) merge into one step.
// Plain functions, tested in Node (test/viewer-logic.ts).

export function createUndo({ limit = 200, mergeMs = 1500, now = () => Date.now() } = {}) {
  const done = [], undone = [];
  const listeners = new Set();
  const changed = () => { for (const f of listeners) f(); };
  return {
    /** Record an edit that has been applied already. */
    push(entry) {
      const top = done[done.length - 1], t = now();
      if (entry.key !== undefined && top && top.key === entry.key && t - top.at <= mergeMs && !undone.length) {
        top.redo = entry.redo;
        top.label = entry.label;
        top.at = t;
      } else {
        done.push({ ...entry, at: t });
        if (done.length > limit) done.shift();
      }
      undone.length = 0;
      changed();
    },
    /** Undo the last edit; its label, or null when there is none. */
    undo() {
      const e = done.pop();
      if (!e) return null;
      e.undo();
      undone.push(e);
      changed();
      return e.label;
    },
    redo() {
      const e = undone.pop();
      if (!e) return null;
      e.redo();
      // a redone step never merges with the next edit
      done.push({ ...e, at: -Infinity });
      changed();
      return e.label;
    },
    get canUndo() { return done.length > 0; },
    get canRedo() { return undone.length > 0; },
    get size() { return done.length; },
    clear() { done.length = 0; undone.length = 0; changed(); },
    onChange(f) { listeners.add(f); return () => listeners.delete(f); },
  };
}
