// The Controls section's rules: which widget a var gets, a slider's range and step,
// how values print. Plain functions, tested in Node (test/viewer-logic.ts); props.js builds the widgets.

export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const HEX = /^#[0-9a-f]{6}$/i, HEX3 = /^#[0-9a-f]{3}$/i;
export const decimals = (x) => { const s = String(x); return s.includes('e-') ? Number(s.split('e-')[1]) : (s.split('.')[1] ?? '').length; };
export const fmt = (v) => (isNum(v) ? String(+v.toPrecision(10)) : String(v));
export const short = (v) => { const s = typeof v === 'string' ? v : JSON.stringify(v) ?? String(v); return s.length > 24 ? s.slice(0, 23) + '…' : s; };

/** The widget a value's JSON type asks for. */
export function jsonKind(v) {
  if (typeof v === 'boolean') return 'bool';
  if (isNum(v)) return 'number';
  if (typeof v === 'string') return HEX.test(v) ? 'color' : 'text';
  if (Array.isArray(v) && v.length >= 2 && v.length <= 4 && v.every(isNum)) return 'vector';
  return 'json';
}

/** The widget for a var: the declared type when the value fits it, else the value's JSON type. */
export function kindOf(vd, v) {
  const t = vd?.type, k = jsonKind(v);
  if (Array.isArray(vd?.options) && vd.options.length && (k === 'text' || k === 'number' || k === 'color')) return 'select';
  if (t === 'color' && (k === 'color' || (k === 'text' && HEX3.test(v)) || (k === 'vector' && v.length >= 3))) return 'color';
  if (t === 'bool' && k === 'number') return 'bool';
  return k;
}

/**
 * A menu's entries (a var with options): their texts, and the value an entry stands for: the option itself, so
 * numeric options give numbers ([4, 8, 16] → 8, not "8"). A number var with text options only holds the option's
 * index (byIndex). valueOf gives undefined for a text that is no option (an entry shown for a value outside them).
 */
export function menuOf(vd, value) {
  const opts = vd.options, texts = opts.map(String);
  const byIndex = isNum(value) && opts.every((o) => typeof o === 'string') && !texts.includes(String(value));
  const valueOf = (text) => { const i = texts.indexOf(text); return byIndex ? (i >= 0 ? i : undefined) : i >= 0 ? opts[i] : undefined; };
  return { texts, byIndex, valueOf, textOf: (v) => (byIndex ? texts[v] : String(v)) };
}

/** A value to show for a declared param that has neither a var nor a default. */
export function blank(vd) {
  const t = vd?.type ?? '';
  if (t === 'bool') return false;
  if (t === 'color') return '#ffffff';
  if (/vec(\d)$/.test(t)) return new Array(Number(/vec(\d)$/.exec(t)[1])).fill(0);
  if (t === 'string' || t === 'enum' || vd?.options?.length) return vd?.options?.[0] ?? '';
  return 0;
}

/** Slider range: the VarDef's min/max, else derived from the default (0..4×default, −1..1 for 0); derived ends widen. */
export function rangeOf(vd, v, int) {
  let lo = isNum(vd.min) ? vd.min : undefined, hi = isNum(vd.max) ? vd.max : undefined;
  const fixLo = lo !== undefined, fixHi = hi !== undefined;
  const base = isNum(vd.default) ? vd.default : v;
  if (lo === undefined && hi === undefined) [lo, hi] = base === 0 ? [-1, 1] : base > 0 ? [0, 4 * base] : [4 * base, -4 * base];
  else if (lo === undefined) lo = hi > 0 && base >= 0 ? 0 : Math.min(base, hi) - Math.max(1, 4 * Math.abs(base));
  else if (hi === undefined) hi = base > lo ? lo + 4 * (base - lo) : lo + Math.max(1, 4 * Math.abs(lo));
  if (int) { lo = Math.floor(lo); hi = Math.ceil(hi); }
  if (!(hi > lo)) hi = lo + 1;
  const fixStep = isNum(vd.step) && vd.step > 0;
  const r = { lo, hi, fixLo, fixHi, fixStep, int, step: 1 };
  r.step = fixStep ? vd.step : autoStep(r);
  return r;
}
export function autoStep(r) {
  const s = 10 ** Math.floor(Math.log10((r.hi - r.lo) / 100));
  return r.int ? Math.max(1, s) : s;
}
/** A slider value snapped to its range's steps. */
export const snapTo = (r, v) => +(r.lo + Math.round((v - r.lo) / r.step) * r.step).toFixed(Math.min(12, Math.max(decimals(r.step), decimals(r.lo))));

/** The controls a graph draws: declared params in order, then the undeclared vars ("other vars"). */
export function controlList(params = {}, vars = {}) {
  return { declared: Object.keys(params), other: Object.keys(vars).filter((k) => !(k in params)) };
}

/**
 * What a control's ↺ goes back to. Over a graph file ("file" mode) the graph's own value (graphVars), else its
 * declared default, else a blank of its type; in a project the declared default (undefined: no reset).
 */
export function baseValue(mode, vd, graphVars, k) {
  if (mode !== 'file') return vd?.default;
  if (graphVars && Object.hasOwn(graphVars, k)) return graphVars[k];
  return vd?.default !== undefined ? vd.default : blank(vd);
}

/**
 * A control's shape: its widget and what the widget is built from (the declaration, the value's kind and length). A
 * row keeps its element while its shape stays; a new shape builds the row again.
 */
export function rowShape(vd, value) {
  return JSON.stringify([kindOf(vd, value), vd ?? null, jsonKind(value), Array.isArray(value) ? value.length : 0]);
}

/**
 * Whether a value the server reported for var k may replace what its control shows. `issued`: when the report was
 * asked for (a graph list read earlier stays as old as it was). Not while the person has a change of k on the way
 * (pending, sent and not answered), is dragging it or typing in it, nor when an answer about k came after the report.
 * st: {pending: {k: v}, unacked: Map, ackAt: Map(k → time), active: k | null, typing: (k) => bool}.
 */
export function serverValueWins(st, k, issued) {
  return !(k in st.pending) && !st.unacked.has(k) && !((st.ackAt.get(k) ?? -1e9) > issued) && st.active !== k && !st.typing(k);
}

/** The line above the Controls over a graph file: how many values differ from it. */
export function sessionText(changed, file) {
  const where = file ?? 'the graph';
  if (!changed) return `values as in ${where}`;
  return `${changed} value${changed === 1 ? '' : 's'} differ${changed === 1 ? 's' : ''} from ${where}`;
}
