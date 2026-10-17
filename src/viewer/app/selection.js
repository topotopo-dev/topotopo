// The selection the outliner and the viewport share (docs/design/viewer.md section 5): an ordered set of ids, the
// last one the lead (the properties panel shows it). Ids name objects ("out", "layer:<path>", "guide:<id>") or a
// connected piece of a mesh object ("out#12", "layer:<path>#3").
// Plain functions, tested in Node (test/viewer-logic.ts).

export const pieceId = (obj, k) => `${obj}#${k}`;
/** {obj, piece}: piece is the piece number, or null for the whole object. */
export function parseId(id) {
  const i = id.lastIndexOf('#');
  if (i < 0 || !/^\d+$/.test(id.slice(i + 1))) return { obj: id, piece: null };
  return { obj: id.slice(0, i), piece: Number(id.slice(i + 1)) };
}

/** How a click or a box combines with the selection: Shift adds, Ctrl removes (Ctrl+Shift adds), else replaces. */
export function opOf({ shiftKey = false, ctrlKey = false, metaKey = false } = {}) {
  if (shiftKey) return 'add';
  if (ctrlKey || metaKey) return 'remove';
  return 'replace';
}

/** The ids after combining `ids` into `current` with op ('replace' | 'add' | 'remove' | 'toggle'). */
export function combine(current, ids, op) {
  const seen = new Set();
  const uniq = (list) => list.filter((x) => !seen.has(x) && seen.add(x));
  if (op === 'replace') return uniq([...ids]);
  if (op === 'add') {
    // an added id becomes the lead: it moves to the end
    const add = new Set(ids);
    return uniq([...current.filter((x) => !add.has(x)), ...ids]);
  }
  if (op === 'remove') { const drop = new Set(ids); return current.filter((x) => !drop.has(x)); }
  if (op === 'toggle') {
    const cur = new Set(current), flip = new Set(ids);
    return uniq([...current.filter((x) => !flip.has(x)), ...ids.filter((x) => !cur.has(x))]);
  }
  throw new Error(`unknown selection op "${op}"`);
}

/**
 * Normalise ids: a piece of an object that has one piece is the object; a piece whose object is selected whole adds
 * nothing. `pieces(obj)` gives an object's piece count; without it pieces stay as they are.
 */
export function normalize(ids, pieces = () => Infinity) {
  const whole = new Set(ids.filter((x) => parseId(x).piece === null));
  const out = [];
  for (const id of ids) {
    const { obj, piece } = parseId(id);
    if (piece === null) { out.push(id); continue; }
    if (whole.has(obj)) continue;
    if (pieces(obj) <= 1) { if (!out.includes(obj)) out.push(obj); whole.add(obj); continue; }
    out.push(id);
  }
  return [...new Set(out)];
}

/** A selection with change listeners; `pieces(obj)` as for normalize. */
export function createSelection(pieces) {
  let items = [];
  const listeners = new Set();
  const set = (next) => {
    if (next.length === items.length && next.every((x, i) => x === items[i])) return false;
    items = next;
    for (const f of listeners) f(items);
    return true;
  };
  return {
    get items() { return items; },
    get lead() { return items[items.length - 1] ?? null; },
    get size() { return items.length; },
    has: (id) => items.includes(id),
    /** true when the object or any of its pieces is selected */
    touches: (obj) => items.some((x) => x === obj || parseId(x).obj === obj),
    apply(ids, op = 'replace') { return set(normalize(combine(items, ids, op), pieces)); },
    clear() { return set([]); },
    /** drop ids whose object is gone (`exists(id)` false) */
    prune(exists) { return set(items.filter(exists)); },
    onChange(f) { listeners.add(f); return () => listeners.delete(f); },
  };
}
