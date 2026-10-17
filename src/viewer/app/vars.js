// The Controls section's rules (docs/design/viewer.md section 8): which widget a var gets, a slider's range and step,
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
