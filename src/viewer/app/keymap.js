// The keymap's table of actions supplies both the bindings and the overlay text.
import { SELECTION_ROWS } from './pointer.js';

/** In overlay order. `keys` binds key chords and `drag` binds mouse drags (L / M / R with modifiers). */
export const ROWS = [
  { label: 'orbit', text: 'Left drag on a result or empty space · Alt + left drag', drag: { 'Alt+L': 'tumble' } },
  { label: 'pan', text: 'Middle drag · right drag · Alt + middle drag', drag: { M: 'track', R: 'track', 'Alt+M': 'track' } },
  { label: 'zoom', text: 'Wheel, toward the cursor · Alt + right drag', drag: { 'Alt+R': 'dolly' } },
  { label: 'frame the selection (everything when nothing is selected)', text: 'F', keys: { F: 'frameSelection' } },
  { label: 'frame everything', text: 'A', keys: { A: 'frameAll' } },
  { label: 'single / quad view', text: 'Space', keys: { Space: 'quad' } },
  { label: 'perspective / top / front / right', text: '1 / 2 / 3 / 4', keys: { 1: 'viewPersp', 2: 'viewTop', 3: 'viewFront', 4: 'viewRight' } },
  { label: 'orthographic on / off', text: 'O', keys: { O: 'ortho' } },
  { label: 'wire / shaded / shaded + wire', text: '5 / 6 / 7', keys: { 5: 'displayWire', 6: 'displayShaded', 7: 'displayShadedWire' } },
  { label: 'select tool (leaves placing)', text: 'Q', keys: { Q: 'selectMode' } },
  { label: 'move tool (handles on the selection)', text: 'W', keys: { W: 'moveMode' } },
  {
    label: 'make a null / curve / area / volume (also the + button and right click)', text: 'Shift+1 / 2 / 3 / 4',
    keys: { 'Shift+1': 'placeNull', 'Shift+2': 'placeCurve', 'Shift+3': 'placeArea', 'Shift+4': 'placeVolume' },
  },
  { label: 'finish / remove the last point / cancel, while placing', text: 'Enter or double-click / Backspace / Esc', keys: { Enter: 'finish', Backspace: 'removeLast', Esc: 'cancel' } },
  ...SELECTION_ROWS.map(([label, text]) => ({ label, text })),
  { label: 'add a point to a curve or an area / remove one', text: 'double-click its line / the point, or right click' },
  { label: 'delete the selection', text: 'Delete', keys: { Delete: 'delete' } },
  {
    label: 'undo / redo (guides and vars)', text: 'Ctrl+Z / Ctrl+Y, Ctrl+Shift+Z',
    keys: { 'Ctrl+Z': 'undo', 'Ctrl+Y': 'redo', 'Ctrl+Shift+Z': 'redo' },
  },
  { label: 'hide the selection / show all', text: 'H / Shift+H', keys: { H: 'hide', 'Shift+H': 'showAll' } },
  { label: 'keys and mouse', text: '?', keys: { '?': 'overlay' } },
];

/** Every action a binding may name (main.js handles each). */
export const ACTIONS = [
  'tumble', 'track', 'dolly', 'frameSelection', 'frameAll', 'quad', 'viewPersp', 'viewTop', 'viewFront', 'viewRight', 'ortho',
  'selectMode', 'moveMode', 'displayWire', 'displayShaded', 'displayShadedWire',
  'placeNull', 'placeCurve', 'placeArea', 'placeVolume', 'finish', 'removeLast', 'cancel',
  'delete', 'undo', 'redo', 'hide', 'showAll', 'overlay',
];

const MODS = ['Ctrl', 'Alt', 'Shift'];
/** A chord in one spelling: modifiers in MODS order, then the key. */
export function canonical(chord) {
  const parts = String(chord).split('+').map((s) => s.trim()).filter(Boolean);
  const key = parts.pop() ?? '';
  const mods = new Set(parts.map((p) => MODS.find((m) => m.toLowerCase() === p.toLowerCase()) ?? p));
  for (const m of mods) if (!MODS.includes(m)) throw new Error(`unknown modifier "${m}" in "${chord}"`);
  const k = key.length === 1 ? key.toUpperCase() : key;
  return [...MODS.filter((m) => mods.has(m)), k].join('+');
}

/** The table's bindings: chord → action for keys and for drags. */
export function bindings() {
  const keys = new Map(), drag = new Map();
  for (const row of ROWS) {
    for (const [c, a] of Object.entries(row.keys ?? {})) keys.set(canonical(c), a);
    for (const [c, a] of Object.entries(row.drag ?? {})) drag.set(canonical(c), a);
  }
  return { keys, drag };
}
const bound = bindings();

/** The first key for an action, with its spelling in the table. */
export function keyOf(action) {
  for (const row of ROWS) {
    for (const [key, boundAction] of Object.entries(row.keys ?? {})) if (boundAction === action) return key;
  }
  return '';
}

/**
 * The key part of a chord for a keyboard event: letters by the character typed (falling back to the physical key on
 * other alphabets), digits and the numpad by the physical key, "?" whatever it takes to type it.
 */
export function keyToken(e) {
  const code = e.code ?? '', key = e.key ?? '';
  if (code.startsWith('Numpad')) {
    const rest = code.slice(6);
    if (/^\d$/.test(rest)) return 'Numpad' + rest;
    if (rest === 'Decimal') return 'Numpad.';
    if (rest === 'Enter') return 'Enter';
    return null;
  }
  // "?" by the character; Shift with the "/" key gives it on US layouts even when the event names only the key
  if (key === '?' || (code === 'Slash' && e.shiftKey)) return '?';
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^[a-z]$/i.test(key)) return key.toUpperCase();
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (key === ' ' || code === 'Space') return 'Space';
  if (key === 'Escape') return 'Esc';
  if (['Enter', 'Backspace', 'Delete', 'Home', 'Tab'].includes(key)) return key;
  return null;
}

/** The canonical chord of a keyboard event. */
export function chordOf(e) {
  const k = keyToken(e);
  if (!k) return null;
  const mods = [];
  if (e.ctrlKey || e.metaKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  // typing "?" takes Shift on most layouts: the chord is "?" alone
  if (e.shiftKey && k !== '?') mods.push('Shift');
  return [...mods, k].join('+');
}

/** The action a key press means, or null. */
export function matchKey(e) {
  return bound.keys.get(chordOf(e)) ?? null;
}

/** The navigation a mouse drag starts (tumble, track, dolly), or null. `button` 0 / 1 / 2 = L / M / R. */
export function matchDrag({ button, altKey = false, ctrlKey = false, metaKey = false, shiftKey = false }) {
  const b = ['L', 'M', 'R'][button];
  if (!b) return null;
  const mods = [];
  if (ctrlKey || metaKey) mods.push('Ctrl');
  if (altKey) mods.push('Alt');
  if (shiftKey) mods.push('Shift');
  return bound.drag.get([...mods, b].join('+')) ?? null;
}

/** The overlay's table: a label and its binding text for every row. */
export function overlayRows() {
  return ROWS.map(({ label, text }) => ({ label, text }));
}

/** Toggle the keys and mouse overlay over `host`. Returns the overlay element or null. */
export function toggleOverlay(host) {
  const old = host.querySelector('.keymap-overlay');
  if (old) { old.remove(); return null; }
  const doc = host.ownerDocument;
  const box = doc.createElement('div');
  box.className = 'keymap-overlay';
  const panel = doc.createElement('div');
  panel.className = 'km-panel';
  const head = doc.createElement('div');
  head.className = 'km-head';
  head.textContent = 'Keys and mouse';
  const table = doc.createElement('table');
  for (const r of overlayRows()) {
    const tr = doc.createElement('tr');
    const a = doc.createElement('td'), b = doc.createElement('td');
    a.textContent = r.label;
    b.textContent = r.text;
    tr.append(a, b);
    table.append(tr);
  }
  const foot = doc.createElement('div');
  foot.className = 'km-foot';
  foot.textContent = 'results (cooked geometry) never select on a plain click: Shift-click one to read it · guides and CVs win a click within a few pixels, even behind geometry · ? or Esc closes';
  panel.append(head, table, foot);
  box.append(panel);
  box.addEventListener('pointerdown', (e) => { if (e.target === box) box.remove(); });
  host.append(box);
  return box;
}
