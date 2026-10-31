// A small markdown renderer for the notes on the web app's folder pages: front matter (a "---" block of key: value
// lines at the top, shown as a small table of properties), headings (ATX and setext), paragraphs, lists (nested,
// ordered, task items), block quotes, fenced and indented code, thematic breaks, GFM tables, emphasis, strong,
// strikethrough, code spans, links and images (inline, reference and bare http(s) URLs). No raw HTML: every character
// of the source reaches the page escaped. Each link and image goes through a callback that decides how it shows (the
// web app turns them into players, cards and struck-through missing files: src/web/folders.ts), told whether the link
// stands alone in its paragraph; what it returns to show below the paragraph follows it. Without a callback only
// http(s), mailto, relative and #fragment links are links, anything else (javascript:, data: …) stays text.
// Pure: no file system.

export interface MdLink {
  /** the destination as written (angle brackets removed, backslash escapes resolved) */
  href: string;
  /** the link text, or an image's alt, as plain text */
  text: string;
  title: string;
  image: boolean;
}

/**
 * What a link shows as: HTML in the text (phrasing content), or that and a block to show below its paragraph (a card,
 * a picture, a player). A link alone in its paragraph may show only the block, in its place.
 */
export type LinkOut = string | { inline: string; block?: string };

/**
 * The HTML for a link or image, or null for the default rendering. `at.alone`: the link is all its paragraph or list
 * item holds.
 */
export type LinkRender = (l: MdLink, inner: string, at: { alone: boolean }) => LinkOut | null;

export interface MdOptions {
  link?: LinkRender;
  /** put before every heading id and #fragment link, so that two notes on one page keep their anchors apart */
  idPrefix?: string;
}

export const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** A heading's anchor: lower case, letters, digits and dashes. */
export const slug = (s: string) => s.toLowerCase().replace(/<[^>]*>/g, '').replace(/&[a-z#0-9]+;/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/[\s]+/g, '-');

/** Only these destinations become links by default. */
export const safeHref = (href: string) => /^(https?:|mailto:)/i.test(href) || !/^[a-z][a-z0-9+.-]*:/i.test(href);

// ---------------------------------------------------------------------------------------------------------- blocks

type Block =
  | { t: 'p'; text: string }
  | { t: 'h'; level: number; text: string }
  | { t: 'code'; info: string; text: string }
  | { t: 'hr' }
  | { t: 'quote'; blocks: Block[] }
  | { t: 'list'; ordered: boolean; start: number; loose: boolean; items: { task: boolean | null; blocks: Block[] }[] }
  | { t: 'table'; align: ('left' | 'center' | 'right' | null)[]; head: string[]; rows: string[][] };

interface Ref { href: string; title: string }

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`]*)$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+|$)(.*)$/;
const TABLE_DELIM = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const REF_DEF = /^ {0,3}\[([^\]]{1,999})\]:[ \t]*<?([^\s>]+)>?(?:[ \t]+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?[ \t]*$/;
const blank = (s: string) => /^[ \t]*$/.test(s);
const indentOf = (s: string) => s.length - s.replace(/^ +/, '').length;

/** A line that starts a block other than a paragraph (so it ends one). */
const startsBlock = (s: string) => FENCE.test(s) || ATX.test(s) || HR.test(s) || QUOTE.test(s) || ITEM.test(s);

/** Table cells of a row: split on unescaped pipes outside code spans, outer pipes dropped. */
function cells(row: string): string[] {
  let s = row.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const out: string[] = [];
  let cur = '', tick = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (c === '`') tick ^= 1;
    if (c === '|' && !tick) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  out.push(cur.trim());
  return out;
}

function parseBlocks(lines: string[], refs: Map<string, Ref>, depth = 0): Block[] {
  const out: Block[] = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (blank(line)) { i++; continue; }
    if (depth > 24) { out.push({ t: 'p', text: lines.slice(i).join('\n') }); break; }
    // fenced code
    const f = FENCE.exec(line);
    if (f) {
      const fence = f[1], ind = indentOf(line), body: string[] = [];
      i++;
      while (i < n && !new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}[ \\t]*$`).test(lines[i])) {
        body.push(lines[i].replace(new RegExp(`^ {0,${ind}}`), ''));
        i++;
      }
      i++;
      out.push({ t: 'code', info: f[2].trim().split(/\s+/)[0] ?? '', text: body.join('\n') });
      continue;
    }
    const h = ATX.exec(line);
    if (h) { out.push({ t: 'h', level: h[1].length, text: (h[2] ?? '').trim() }); i++; continue; }
    if (HR.test(line)) { out.push({ t: 'hr' }); i++; continue; }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < n && !blank(lines[i])) {
        if (QUOTE.test(lines[i])) body.push(lines[i].replace(QUOTE, ''));
        else if (startsBlock(lines[i])) break;
        else body.push(lines[i]); // a lazy continuation line of its paragraph
        i++;
      }
      out.push({ t: 'quote', blocks: parseBlocks(body, refs, depth + 1) });
      continue;
    }
    const it = ITEM.exec(line);
    if (it) {
      const ordered = /\d/.test(it[2]);
      const kind = ordered ? it[2].slice(-1) : it[2];
      const items: { task: boolean | null; blocks: Block[] }[] = [];
      let loose = false;
      /** an item of this list: the same bullet, or numbers with the same delimiter */
      const same = (l: string | undefined) => {
        const m = l === undefined ? null : ITEM.exec(l);
        return m && /\d/.test(m[2]) === ordered && (ordered ? m[2].slice(-1) : m[2]) === kind ? m : null;
      };
      while (i < n) {
        const m = same(lines[i]);
        if (!m) break;
        // content starts after the marker and its spaces (one space when the item starts with indented code or nothing)
        const spaces = m[3].length;
        const width = m[1].length + m[2].length + (spaces >= 1 && spaces <= 4 && m[4] !== '' ? spaces : 1);
        const body: string[] = [m[4]];
        i++;
        let sawBlank = false;
        while (i < n) {
          const l = lines[i];
          if (blank(l)) { body.push(''); sawBlank = true; i++; continue; }
          if (indentOf(l) >= width) { body.push(l.slice(width)); if (sawBlank) loose = true; sawBlank = false; i++; continue; }
          if (sawBlank) break;
          if (startsBlock(l)) break;
          body.push(l.trim()); // a lazy continuation of the item's paragraph
          i++;
        }
        while (body.length && blank(body[body.length - 1])) body.pop();
        if (sawBlank && same(lines[i])) loose = true;
        let task: boolean | null = null;
        const tm = /^\[([ xX])\][ \t]+/.exec(body[0] ?? '');
        if (tm) { task = tm[1] !== ' '; body[0] = body[0].slice(tm[0].length); }
        items.push({ task, blocks: parseBlocks(body, refs, depth + 1) });
        if (sawBlank && !same(lines[i])) break;
      }
      out.push({ t: 'list', ordered, start: ordered ? Number.parseInt(it[2], 10) : 1, loose, items });
      continue;
    }
    // a table: a row with pipes over a delimiter row with as many cells
    if (line.includes('|') && i + 1 < n && TABLE_DELIM.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = cells(line), delim = cells(lines[i + 1]);
      if (head.length === delim.length) {
        const align = delim.map((d) => (d.startsWith(':') && d.endsWith(':') ? 'center' : d.endsWith(':') ? 'right' : d.startsWith(':') ? 'left' : null));
        const rows: string[][] = [];
        i += 2;
        while (i < n && !blank(lines[i]) && lines[i].includes('|') && !startsBlock(lines[i])) {
          const r = cells(lines[i]);
          rows.push(head.map((_, k) => r[k] ?? ''));
          i++;
        }
        out.push({ t: 'table', align, head, rows });
        continue;
      }
    }
    // indented code
    if (/^( {4}|\t)/.test(line)) {
      const body: string[] = [];
      while (i < n && (/^( {4}|\t)/.test(lines[i]) || blank(lines[i]))) { body.push(lines[i].replace(/^( {4}|\t)/, '')); i++; }
      while (body.length && blank(body[body.length - 1])) body.pop();
      out.push({ t: 'code', info: '', text: body.join('\n') });
      continue;
    }
    // reference definitions at the start of a paragraph
    const d = REF_DEF.exec(line);
    if (d) {
      const key = d[1].trim().toLowerCase().replace(/\s+/g, ' ');
      if (!refs.has(key)) refs.set(key, { href: d[2], title: d[3] ?? d[4] ?? d[5] ?? '' });
      i++;
      continue;
    }
    // a paragraph, which a setext underline makes a heading
    const para: string[] = [line.trim()];
    i++;
    let setext = 0;
    while (i < n && !blank(lines[i])) {
      if (/^ {0,3}=+[ \t]*$/.test(lines[i])) { setext = 1; i++; break; }
      if (/^ {0,3}-+[ \t]*$/.test(lines[i])) { setext = 2; i++; break; }
      if (startsBlock(lines[i])) break;
      if (lines[i].includes('|') && i + 1 < n && TABLE_DELIM.test(lines[i + 1]) && lines[i + 1].includes('-')) break;
      para.push(lines[i].replace(/^[ \t]+/, ''));
      i++;
    }
    const text = para.join('\n');
    out.push(setext ? { t: 'h', level: setext, text: text.trim() } : { t: 'p', text });
  }
  return out;
}

// --------------------------------------------------------------------------------------------------------- inlines

const PUNCT = /[!-/:-@[-`{-~]/;
const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);
const isPunct = (c: string | undefined) => c !== undefined && /[\p{P}\p{S}]/u.test(c);
const isAlnum = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

interface Ctx {
  refs: Map<string, Ref>;
  o: MdOptions;
  inLink: boolean;
  /** a paragraph's text (a link alone in it may stand as its block) */
  para?: boolean;
  /** the blocks the paragraph's links show below it (none in a table) */
  blocks?: string[];
}

/**
 * A text's code spans and brackets, found in one pass and kept for the texts in use: each backtick run that opens a
 * code span with where the span ends (after its closing run of the same length), each "[" with its "]" (nested,
 * escapes and code spans skipped). Scanning again from every "[" or "`" would make a paragraph of thousands quadratic.
 */
interface Marks { code: Int32Array; bracket: Int32Array }
const marksOf = new Map<string, Marks>();
function marks(s: string): Marks {
  const have = marksOf.get(s);
  if (have) return have;
  const n = s.length, code = new Int32Array(n).fill(-1), bracket = new Int32Array(n).fill(-1);
  const runs: [number, number][] = [];
  for (let k = 0; k < n;) {
    if (s[k] !== '`') { k++; continue; }
    let e = k;
    while (s[e] === '`') e++;
    runs.push([k, e - k]);
    k = e;
  }
  // a run closes at the next run of its length
  const next = new Map<number, number>();
  for (let r = runs.length - 1; r >= 0; r--) {
    const [at, len] = runs[r], c = next.get(len);
    if (c !== undefined) code[at] = runs[c][0] + len;
    next.set(len, r);
  }
  const open: number[] = [];
  for (let k = 0; k < n; k++) {
    const c = s[k];
    if (c === '\\') { k++; continue; }
    if (c === '`') { if (code[k] > 0) { k = code[k] - 1; continue; } while (s[k + 1] === '`') k++; continue; }
    if (c === '[') open.push(k);
    else if (c === ']' && open.length) bracket[open.pop()!] = k;
  }
  if (marksOf.size > 512) marksOf.clear();
  const m = { code, bracket };
  marksOf.set(s, m);
  return m;
}

/** The end of a bracketed link text starting at `i` ("[" at i), nested brackets and code spans honoured; -1 for none. */
const closeBracket = (s: string, i: number) => marks(s).bracket[i];

/** Where a code span opened by the backtick run at `i` ends (after its closing run), or -1. */
const codeSpanEnd = (s: string, i: number) => marks(s).code[i];

/** An inline destination "(href "title")" starting at `i` ("(" at i): its parts and where it ends; null when malformed. */
function destination(s: string, i: number): { href: string; title: string; end: number } | null {
  let k = i + 1;
  while (k < s.length && /[ \t\n]/.test(s[k])) k++;
  let href = '';
  if (s[k] === '<') {
    const e = s.indexOf('>', k);
    if (e < 0 || s.slice(k, e).includes('\n')) return null;
    href = s.slice(k + 1, e);
    k = e + 1;
  } else {
    let depth = 0;
    const st = k;
    while (k < s.length && !/[ \t\n]/.test(s[k])) {
      if (s[k] === '\\' && PUNCT.test(s[k + 1] ?? '')) { k += 2; continue; }
      if (s[k] === '(') depth++;
      else if (s[k] === ')') { if (!depth) break; depth--; }
      k++;
    }
    href = s.slice(st, k);
  }
  while (k < s.length && /[ \t\n]/.test(s[k])) k++;
  let title = '';
  const q = s[k];
  if (q === '"' || q === "'" || q === '(') {
    const close = q === '(' ? ')' : q;
    const e = s.indexOf(close, k + 1);
    if (e < 0) return null;
    title = s.slice(k + 1, e);
    k = e + 1;
    while (k < s.length && /[ \t\n]/.test(s[k])) k++;
  }
  if (s[k] !== ')') return null;
  return { href: unescape(href), title: unescape(title), end: k + 1 };
}

const unescape = (s: string) => s.replace(/\\([!-/:-@[-`{-~])/g, '$1');

/** The plain text of inline markdown (an image's alt, a link's text for its callback). */
const plain = (s: string) => unescape(s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_~`]+/g, '')).trim();

function linkHtml(l: MdLink, inner: string, c: Ctx, alone = false): string {
  const custom = c.o.link?.(l, inner, { alone });
  if (typeof custom === 'string') return custom;
  if (custom) {
    // the block follows the paragraph (once); in a table only the link stays
    if (custom.block && c.blocks && !c.blocks.includes(custom.block)) c.blocks.push(custom.block);
    return custom.inline;
  }
  const title = l.title ? ` title="${escHtml(l.title)}"` : '';
  if (l.image) return safeHref(l.href) && !/^(https?:|mailto:)/i.test(l.href) ? `<img src="${escHtml(l.href)}" alt="${escHtml(l.text)}"${title} loading="lazy">` : escHtml(l.text || l.href);
  if (!safeHref(l.href)) return inner;
  if (l.href.startsWith('#')) return `<a href="#${escHtml((c.o.idPrefix ?? '') + slug(decodeSafe(l.href.slice(1))))}"${title}>${inner}</a>`;
  const ext = /^(https?:|mailto:)/i.test(l.href);
  return `<a href="${escHtml(l.href)}"${title}${ext ? ' target="_blank" rel="noopener noreferrer"' : ''}>${inner}</a>`;
}

const decodeSafe = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

function inline(s: string, c: Ctx, depth = 0): string {
  if (depth > 32) return escHtml(s);
  let out = '';
  let i = 0;
  /** the link from `from` to `to` is all the paragraph holds */
  const alone = (from: number, to: number) => !!c.para && depth === 0 && !c.inLink && !s.slice(0, from).trim() && !s.slice(to).trim();
  // a closing run not found from some point is not found from any later point either: a paragraph full of lone "*"
  // stays linear
  const none = new Map<string, number>();
  const closerAt = (from: number, ch: string, size: number) => {
    const k = ch + size;
    if ((none.get(k) ?? Infinity) <= from) return -1;
    const e = closer(s, from, ch, size);
    if (e < 0) none.set(k, Math.min(none.get(k) ?? Infinity, from));
    return e;
  };
  while (i < s.length) {
    const ch = s[i];
    // backslash escapes, and a hard break at the end of a line
    if (ch === '\\') {
      if (s[i + 1] === '\n') { out += '<br>\n'; i += 2; continue; }
      if (PUNCT.test(s[i + 1] ?? '')) { out += escHtml(s[i + 1]); i += 2; continue; }
      out += '\\';
      i++;
      continue;
    }
    if (ch === '\n') {
      out = /  +$/.test(out) ? out.replace(/ +$/, '') + '<br>\n' : out.replace(/ +$/, '') + '\n';
      i++;
      while (s[i] === ' ') i++;
      continue;
    }
    if (ch === '`') {
      const e = codeSpanEnd(s, i);
      if (e > 0) {
        let run = 0;
        while (s[i + run] === '`') run++;
        let code = s.slice(i + run, e - run).replace(/\n/g, ' ');
        if (/^ .*[^ ].* $/.test(code)) code = code.slice(1, -1);
        out += `<code>${escHtml(code)}</code>`;
        i = e;
        continue;
      }
      let run = 0;
      while (s[i + run] === '`') run++;
      out += s.slice(i, i + run);
      i += run;
      continue;
    }
    // images and links: inline "(dest)", full "[ref]", collapsed "[]" or shortcut references
    if ((ch === '!' && s[i + 1] === '[') || (ch === '[' && !c.inLink)) {
      const image = ch === '!';
      const open = image ? i + 1 : i;
      const close = closeBracket(s, open);
      if (close > 0) {
        const raw = s.slice(open + 1, close);
        let target: { href: string; title: string; end: number } | null = null;
        if (s[close + 1] === '(') target = destination(s, close + 1);
        if (!target) {
          let label = raw, end = close + 1;
          const full = /^\[([^\]]*)\]/.exec(s.slice(close + 1));
          if (full) { if (full[1].trim()) label = full[1]; end = close + 1 + full[0].length; }
          const ref = c.refs.get(label.trim().toLowerCase().replace(/\s+/g, ' '));
          if (ref) target = { href: ref.href, title: ref.title, end };
        }
        if (target) {
          const l: MdLink = { href: target.href, text: plain(raw), title: target.title, image };
          const inner = image ? escHtml(l.text) : inline(raw, { ...c, inLink: true }, depth + 1);
          out += linkHtml(l, inner, c, alone(i, target.end));
          i = target.end;
          continue;
        }
      }
      out += escHtml(ch);
      i++;
      continue;
    }
    // autolinks <https://…>, and bare http(s) URLs
    if (ch === '<') {
      const m = /^<((?:https?|mailto):[^\s<>]*)>/i.exec(s.slice(i));
      if (m && !c.inLink) { out += linkHtml({ href: m[1], text: m[1], title: '', image: false }, escHtml(m[1]), c, alone(i, i + m[0].length)); i += m[0].length; continue; }
      out += '&lt;';
      i++;
      continue;
    }
    if ((ch === 'h' || ch === 'H') && !c.inLink && !isAlnum(s[i - 1]) && /^https?:\/\//i.test(s.slice(i, i + 8))) {
      let url = /^https?:\/\/[^\s<>"]+/i.exec(s.slice(i))![0];
      // trailing punctuation ends the sentence, not the URL; so does a ")" without its "("
      while (/[.,:;!?'"*_~]$/.test(url)) url = url.slice(0, -1);
      while (url.endsWith(')') && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) url = url.slice(0, -1);
      out += linkHtml({ href: url, text: url, title: '', image: false }, escHtml(url), c, alone(i, i + url.length));
      i += url.length;
      continue;
    }
    // emphasis, strong and strikethrough
    if (ch === '*' || ch === '_' || ch === '~') {
      let run = 0;
      while (s[i + run] === ch) run++;
      const before = s[i - 1], after = s[i + run];
      const leftFlank = !isSpace(after) && (!isPunct(after) || isSpace(before) || isPunct(before));
      const canOpen = leftFlank && (ch !== '_' || !isAlnum(before)) && (ch !== '~' || run === 2);
      if (canOpen) {
        const sizes = ch === '~' ? [2] : run >= 3 ? [3, 2, 1] : run === 2 ? [2, 1] : [1];
        let done = false;
        for (const size of sizes) {
          const from = i + run;
          const end = closerAt(from, ch, size);
          if (end < 0) continue;
          const lead = s.slice(i, i + run - size);
          const inner = inline(s.slice(from, end), c, depth + 1);
          const wrap = ch === '~' ? `<del>${inner}</del>` : size === 3 ? `<em><strong>${inner}</strong></em>` : size === 2 ? `<strong>${inner}</strong>` : `<em>${inner}</em>`;
          out += escHtml(lead) + wrap;
          i = end + size;
          done = true;
          break;
        }
        if (done) continue;
      }
      out += escHtml(s.slice(i, i + run));
      i += run;
      continue;
    }
    // plain text up to the next character that may start something
    let k = i + 1;
    while (k < s.length && !/[\\\n`!\[<*_~hH]/.test(s[k])) k++;
    out += escHtml(s.slice(i, k));
    i = k;
  }
  return out;
}

/**
 * The start of the run that closes emphasis of `size` characters `ch` opened before `from`: a run of at least `size`
 * that can close (no space before it; for "_" no letter after it), skipping code spans, escapes and links; -1 for none.
 */
function closer(s: string, from: number, ch: string, size: number): number {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') { j++; continue; }
    if (c === '`') { const e = codeSpanEnd(s, j); if (e > 0) { j = e - 1; continue; } }
    if (c === '[') { const e = closeBracket(s, j); if (e > 0) { const d = s[e + 1] === '(' ? destination(s, e + 1) : null; j = d ? d.end - 1 : e; continue; } }
    if (c !== ch) continue;
    let run = 0;
    while (s[j + run] === ch) run++;
    const before = s[j - 1], after = s[j + run];
    const rightFlank = !isSpace(before) && (!isPunct(before) || isSpace(after) || isPunct(after));
    if (j > from && run >= size && rightFlank && (ch !== '_' || !isAlnum(after)) && (ch !== '~' || run === 2)) return j + (run - size);
    j += run - 1;
  }
  return -1;
}

// ---------------------------------------------------------------------------------------------------------- render

/** Blocks the links of a paragraph or heading show below it: cards and pictures side by side, players full width. */
const below = (blocks: string[]) => (blocks.length ? `<div class="lblocks">${blocks.join('')}</div>` : '');

/** Table cells this short keep to one line ("0.92 m", "lod0 tris"): the table scrolls before they break. */
const SHORT_CELL = 12;

function renderBlocks(blocks: Block[], c: Ctx, tight = false): string {
  const used = new Map<string, number>();
  const id = (text: string) => {
    const base = slug(text) || 'section';
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    return (c.o.idPrefix ?? '') + (n ? `${base}-${n}` : base);
  };
  const cell = (tag: string, text: string, style: string) => `<${tag}${style}${plain(text).length <= SHORT_CELL ? ' class="n"' : ''}>${inline(text, { ...c, para: false, blocks: undefined })}</${tag}>`;
  return blocks.map((b) => {
    switch (b.t) {
      case 'p': {
        const after: string[] = [];
        const html = inline(b.text, { ...c, para: true, blocks: after });
        const text = html.trim() ? (tight ? html : `<p>${html}</p>`) : '';
        return text + below(after);
      }
      case 'h': {
        const after: string[] = [];
        const html = inline(b.text, { ...c, para: false, blocks: after });
        return `<h${b.level} id="${escHtml(id(html))}">${html}</h${b.level}>${below(after)}`;
      }
      case 'code': return `<pre><code${b.info ? ` class="language-${escHtml(b.info.replace(/[^\w+-]/g, ''))}"` : ''}>${escHtml(b.text)}</code></pre>`;
      case 'hr': return '<hr>';
      case 'quote': return `<blockquote>${renderBlocks(b.blocks, c)}</blockquote>`;
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        const items = b.items.map((it) => {
          const box = it.task === null ? '' : `<input type="checkbox" disabled${it.task ? ' checked' : ''}> `;
          return `<li${it.task === null ? '' : ' class="task"'}>${box}${renderBlocks(it.blocks, c, !b.loose)}</li>`;
        }).join('');
        return `<${tag}${b.ordered && b.start !== 1 ? ` start="${b.start}"` : ''}>${items}</${tag}>`;
      }
      case 'table': {
        const al = (k: number) => (b.align[k] ? ` style="text-align:${b.align[k]}"` : '');
        return `<div class="table"><table><thead><tr>${b.head.map((h, k) => cell('th', h, al(k))).join('')}</tr></thead>`
          + `<tbody>${b.rows.map((r) => `<tr>${r.map((d, k) => cell('td', d, al(k))).join('')}</tr>`).join('')}</tbody></table></div>`;
      }
    }
  }).join('\n');
}

const toLines = (src: string) => src.replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');

/**
 * Front matter: a first line "---", key: value lines (lists below a key as "- item" lines), and a closing "---" or
 * "..." (as GitHub and Obsidian read it); the properties in order and where the document starts after it, or null.
 */
export function frontMatter(lines: string[]): { props: [string, string][]; next: number } | null {
  if (!/^---[ \t]*$/.test(lines[0] ?? '')) return null;
  const end = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)[ \t]*$/.test(l));
  if (end < 0 || end > 400) return null;
  const body = lines.slice(1, end);
  const first = body.find((l) => l.trim() && !l.trim().startsWith('#'));
  if (first !== undefined && !/^[A-Za-z0-9_][\w .-]*:([ \t]|$)/.test(first)) return null;
  const props: [string, string][] = [];
  const value = (v: string) => {
    v = v.trim().replace(/[ \t]+#.*$/, '');
    const q = /^'(.*)'$/.exec(v) ?? /^"(.*)"$/.exec(v);
    if (q) return v.startsWith("'") ? q[1].replace(/''/g, "'") : q[1].replace(/\\"/g, '"');
    const list = /^\[(.*)\]$/.exec(v);
    return list ? list[1].split(',').map((x) => value(x)).filter(Boolean).join(', ') : v;
  };
  for (const l of body) {
    if (!l.trim() || l.trim().startsWith('#')) continue;
    const kv = /^([A-Za-z0-9_][\w .-]*):(?:[ \t]+(.*))?$/.exec(l);
    if (kv) { props.push([kv[1].trim(), value(kv[2] ?? '')]); continue; }
    // a list item or a continuation below the last key
    const last = props[props.length - 1];
    if (!last) continue;
    const item = value(l.trim().replace(/^-[ \t]*/, ''));
    if (item) last[1] = last[1] ? `${last[1]}, ${item}` : item;
  }
  return { props, next: end + 1 };
}

/** The HTML of a markdown document: escaped throughout, links and images through `o.link`. */
export function renderMarkdown(src: string, o: MdOptions = {}): string {
  const refs = new Map<string, Ref>();
  let lines = toLines(src);
  const fm = frontMatter(lines);
  if (fm) lines = lines.slice(fm.next);
  const blocks = parseBlocks(lines, refs);
  const shown = fm?.props.filter(([, v]) => v) ?? [];
  const props = shown.length ? `<dl class="props">${shown.map(([k, v]) => `<div><dt>${escHtml(k)}</dt><dd>${escHtml(v)}</dd></div>`).join('')}</dl>\n` : '';
  return props + renderBlocks(blocks, { refs, o, inLink: false });
}

/** Every link and image of a markdown document, in order (what renderMarkdown hands its callback). */
export function markdownLinks(src: string): MdLink[] {
  const out: MdLink[] = [];
  renderMarkdown(src, { link: (l) => { out.push(l); return ''; } });
  return out;
}
