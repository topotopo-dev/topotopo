// Minimal edits to JSON text: set or remove values at key paths and leave every other character as it was, so the
// formatting, key order, number spellings (2.0) and string escapes (…) a person or a tool wrote survive. The live
// viewer writes a graph file this way when it sets an export target or saves tuned values (graph-file.ts).
//   editJSONText('{\n  "vars": { "s": 2.0 }\n}', [{ path: ['vars', 's'], value: 5 }]) → '{\n  "vars": { "s": 5 }\n}'
// A value equal to the one in the text keeps its spelling. A new member goes after the object's last one, laid out
// like its siblings (one per line with their indent, or inline). The result is checked against the same edits applied
// to the parsed value: editJSONText never returns text that means something else.

export type JSONPath = readonly (string | number)[];
/** Set `value` at `path` (objects on the way are made); `value` undefined removes the member. */
export interface JSONEdit { path: JSONPath; value?: unknown }

interface Span { start: number; end: number }
interface Member { key: string; keyStart: number; value: JNode }
type JNode = Span & ({ kind: 'object'; members: Member[] } | { kind: 'array'; items: JNode[] } | { kind: 'scalar' });

/** The value spans of a JSON text (positions of every object member and array item). Throws SyntaxError. */
function parseSpans(text: string): JNode {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const fail = (what: string): never => { throw new SyntaxError(`${what} at position ${i}`); };
  const space = () => { for (let c = text.charCodeAt(i); c === 32 || c === 9 || c === 10 || c === 13; c = text.charCodeAt(++i)); };
  const string = () => {
    for (i++; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 34) { i++; return; }
      if (c === 92) i++;
      else if (c < 32) fail('control character in a string');
    }
    fail('unterminated string');
  };
  const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const value = (): JNode => {
    space();
    const start = i, c = text[i];
    if (c === '{') {
      const members: Member[] = [];
      i++; space();
      if (text[i] === '}') { i++; return { kind: 'object', start, end: i, members }; }
      for (;;) {
        space();
        if (text[i] !== '"') fail('expected a key');
        const keyStart = i;
        string();
        const key = JSON.parse(text.slice(keyStart, i));
        space();
        if (text[i] !== ':') fail('expected ":"');
        i++;
        members.push({ key, keyStart, value: value() });
        space();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return { kind: 'object', start, end: i, members }; }
        fail('expected "," or "}"');
      }
    }
    if (c === '[') {
      const items: JNode[] = [];
      i++; space();
      if (text[i] === ']') { i++; return { kind: 'array', start, end: i, items }; }
      for (;;) {
        items.push(value());
        space();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; return { kind: 'array', start, end: i, items }; }
        fail('expected "," or "]"');
      }
    }
    if (c === '"') { string(); return { kind: 'scalar', start, end: i }; }
    NUMBER.lastIndex = i;
    const n = NUMBER.exec(text);
    if (n?.[0]) { i += n[0].length; return { kind: 'scalar', start, end: i }; }
    for (const lit of ['true', 'false', 'null']) if (text.startsWith(lit, i)) { i += lit.length; return { kind: 'scalar', start, end: i }; }
    return fail(i < text.length ? `unexpected "${c}"` : 'unexpected end');
  };
  const root = value();
  space();
  if (i < text.length) fail('unexpected text after the value');
  return root;
}

/** Equal as JSON values (key order ignored). */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && same((a as any)[k], (b as any)[k]));
}

/** How the text writes things: line ending, indent step, a space after ":" and ",", \u escapes for non-ASCII. */
function styleOf(text: string, root: JNode) {
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  let unit = '  ';
  if (root.kind === 'object' && root.members.length) {
    const before = text.slice(0, root.members[0].keyStart), line = before.lastIndexOf('\n');
    if (line >= 0) unit = before.slice(line + 1) || unit;
  }
  const colons = text.match(/"\s*:( ?)/g) ?? [];
  const spaced = colons.filter((m) => m.endsWith(' ')).length >= colons.length / 2;
  // only escapes, never raw: keep writing them (a tool that writes ASCII-only JSON)
  const escapes = /\\u00[89a-f][0-9a-f]|\\u0[1-9a-f][0-9a-f]{2}|\\u[1-9a-f][0-9a-f]{3}/i.test(text) && !/[^\u0000-\u007f]/.test(text);
  return { nl, unit, colon: spaced ? ': ' : ':', comma: spaced ? ', ' : ',', escapes };
}
type Style = ReturnType<typeof styleOf>;

/** A value written inline in the text's style. */
function write(v: unknown, st: Style): string {
  if (v === null || typeof v !== 'object') {
    const s = JSON.stringify(v) ?? 'null';
    return st.escapes && typeof v === 'string' ? s.replace(/[\u0080-￿]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0')) : s;
  }
  if (Array.isArray(v)) return '[' + v.map((x) => write(x === undefined ? null : x, st)).join(st.comma) + ']';
  const entries = Object.entries(v).filter(([, x]) => x !== undefined);
  return '{' + entries.map(([k, x]) => write(k, st) + st.colon + write(x, st)).join(st.comma) + '}';
}

/** The indent of the line `pos` is on. */
function lineIndent(text: string, pos: number): string {
  const line = text.lastIndexOf('\n', pos - 1) + 1;
  return /^[ \t]*/.exec(text.slice(line, pos))![0];
}

const splice = (text: string, s: Span, by: string) => text.slice(0, s.start) + by + text.slice(s.end);

/** Text with `key: value` set in object `o` (replaced in place, or added after its last member). */
function setMember(text: string, o: JNode & { kind: 'object' }, key: string, value: unknown, st: Style): string {
  const m = o.members.findLast((x) => x.key === key);
  if (m) {
    if (same(JSON.parse(text.slice(m.value.start, m.value.end)), value)) return text;
    return splice(text, m.value, write(value, st));
  }
  const member = write(key, st) + st.colon + write(value, st);
  if (!o.members.length) {
    // an empty object: one member on its own line when the text spreads over lines, else inline
    if (!text.includes('\n')) return splice(text, o, `{${member}}`);
    const indent = lineIndent(text, o.start);
    return splice(text, o, `{${st.nl}${indent}${st.unit}${member}${st.nl}${indent}}`);
  }
  const first = o.members[0], last = o.members[o.members.length - 1];
  const gap = text.slice(o.start + 1, first.keyStart);
  const at = last.value.end;
  if (gap.includes('\n')) return text.slice(0, at) + ',' + st.nl + lineIndent(text, first.keyStart) + member + text.slice(at);
  // inline: the separator the members use (", " or ",")
  const sep = o.members.length > 1 ? /,(\s*)$/.exec(text.slice(o.members[0].value.end, o.members[1].keyStart))?.[1] ?? '' : gap;
  return text.slice(0, at) + ',' + sep + member + text.slice(at);
}

/** Text without member `key` of object `o` (its comma and the space before the next member go with it). */
function removeMember(text: string, o: JNode & { kind: 'object' }, key: string): string {
  const j = o.members.findLastIndex((x) => x.key === key);
  if (j < 0) return text;
  const m = o.members[j];
  if (o.members.length === 1) return splice(text, { start: o.start + 1, end: o.end - 1 }, '');
  if (j < o.members.length - 1) return splice(text, { start: m.keyStart, end: o.members[j + 1].keyStart }, '');
  return splice(text, { start: o.members[j - 1].value.end, end: m.value.end }, '');
}

/** One edit on the text. */
function editOnce(text: string, e: JSONEdit): string {
  const root = parseSpans(text), st = styleOf(text, root);
  if (!e.path.length) return e.value === undefined ? text : (same(JSON.parse(text.replace(/^﻿/, '')), e.value) ? text : splice(text, root, write(e.value, st)));
  let node = root;
  for (let d = 0; d < e.path.length; d++) {
    const k = e.path[d], lastStep = d === e.path.length - 1;
    // what to put at k: the value, or (when the rest of the path is missing) objects holding it
    const nested = () => e.path.slice(d + 1).reduceRight<unknown>((v, key) => ({ [key]: v }), e.value);
    if (node.kind === 'object') {
      const m = node.members.findLast((x) => x.key === String(k));
      if (lastStep || !m || (m.value.kind !== 'object' && m.value.kind !== 'array')) {
        if (e.value === undefined) return lastStep ? removeMember(text, node, String(k)) : text;
        return setMember(text, node, String(k), lastStep ? e.value : nested(), st);
      }
      node = m.value;
    } else if (node.kind === 'array') {
      const idx = typeof k === 'number' ? k : Number.NaN;
      if (!Number.isInteger(idx) || idx < 0 || idx > node.items.length) throw new Error(`JSON edit: no item ${k} in the array at ${JSON.stringify(e.path.slice(0, d))}`);
      if (e.value === undefined) throw new Error('JSON edit: removing array items is not supported');
      const item = node.items[idx];
      if (!item) {
        // one past the end: appended
        const add = write(lastStep ? e.value : nested(), st);
        return node.items.length ? text.slice(0, node.items[node.items.length - 1].end) + st.comma + add + text.slice(node.items[node.items.length - 1].end) : splice(text, node, `[${add}]`);
      }
      if (lastStep || (item.kind !== 'object' && item.kind !== 'array')) {
        const v = lastStep ? e.value : nested();
        return same(JSON.parse(text.slice(item.start, item.end)), v) ? text : splice(text, item, write(v, st));
      }
      node = item;
    } else throw new Error(`JSON edit: ${JSON.stringify(e.path.slice(0, d))} is not an object or an array`);
  }
  return text;
}

/** `value` with the edits applied, the way JSON.parse of the edited text must read. */
export function applyJSONEdits(value: unknown, edits: readonly JSONEdit[]): unknown {
  let root = structuredClone(value);
  for (const e of edits) {
    if (!e.path.length) { if (e.value !== undefined) root = structuredClone(e.value); continue; }
    let o: any = root;
    for (let d = 0; d < e.path.length - 1; d++) {
      const k = e.path[d];
      if (o[k] === null || typeof o[k] !== 'object') { if (e.value === undefined) { o = null; break; } o[k] = {}; }
      o = o[k];
    }
    if (!o) continue;
    const last = e.path[e.path.length - 1];
    if (e.value === undefined) { if (!Array.isArray(o)) delete o[last]; } else o[last] = structuredClone(e.value);
  }
  return root;
}

/**
 * The JSON text with the edits made, every other character kept. Throws SyntaxError when the text is not JSON, and
 * Error for an edit it cannot make (a key inside a number, removing an array item).
 */
export function editJSONText(text: string, edits: readonly JSONEdit[]): string {
  const want = applyJSONEdits(JSON.parse(text.replace(/^﻿/, '')), edits);
  let out = text;
  for (const e of edits) out = editOnce(out, e);
  if (!same(JSON.parse(out.replace(/^﻿/, '')), want)) throw new Error('JSON edit: the edited text does not read back as the edited value');
  return out;
}
