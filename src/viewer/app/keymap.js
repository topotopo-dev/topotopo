// The keymap of docs/design/viewer.md section 9: one table of actions, three presets (Maya, the default; Houdini;
// Blender). Each row carries the text the overlay prints per preset and, for the actions phase 1 builds, the bindings:
// chord → action. Transform and snapping rows (phase 2) ship their text but no bindings, so a preset never changes
// shape later. Plain data and functions: the overlay is the only DOM code, and it runs only when called.

export const PRESETS = [
  { id: 'maya', label: 'Maya' },
  { id: 'houdini', label: 'Houdini' },
  { id: 'blender', label: 'Blender' },
];
export const DEFAULT_PRESET = 'maya';

const place = { 'Shift+1': 'placeNull', 'Shift+2': 'placeCurve', 'Shift+3': 'placeArea', 'Shift+4': 'placeVolume' };
const curve = { Enter: 'finish', Backspace: 'removeLast', Esc: 'cancel' };

/**
 * The rows of section 9 in order. `keys` binds key chords, `drag` mouse drags (L / M / R with modifiers); a row
 * without bindings for a preset is not built yet (phase 2) or has none in that application.
 */
export const ROWS = [
  { label: 'tumble', maya: ['Alt + L drag', { drag: { 'Alt+L': 'tumble' } }], houdini: ['Space + L drag', { drag: { 'Space+L': 'tumble' } }], blender: ['M drag', { drag: { M: 'tumble' } }] },
  { label: 'track', maya: ['Alt + M drag', { drag: { 'Alt+M': 'track' } }], houdini: ['Space + M drag', { drag: { 'Space+M': 'track' } }], blender: ['Shift + M drag', { drag: { 'Shift+M': 'track' } }] },
  { label: 'dolly', maya: ['Alt + R drag, wheel', { drag: { 'Alt+R': 'dolly' } }], houdini: ['Space + R drag, wheel', { drag: { 'Space+R': 'dolly' } }], blender: ['Ctrl + M drag, wheel', { drag: { 'Ctrl+M': 'dolly' } }] },
  { label: 'frame selection', maya: ['F', { keys: { F: 'frameSelection' } }], houdini: ['Space+G', { keys: { 'Space+G': 'frameSelection' } }], blender: ['Numpad .', { keys: { 'Numpad.': 'frameSelection' } }] },
  { label: 'frame all', maya: ['A', { keys: { A: 'frameAll' } }], houdini: ['Space+H', { keys: { 'Space+H': 'frameAll' } }], blender: ['Home', { keys: { Home: 'frameAll' } }] },
  { label: 'single / quad view', maya: ['Space (tap)', { keys: { Space: 'quad' } }], houdini: ['Space+B', { keys: { 'Space+B': 'quad' } }], blender: ['Ctrl+Alt+Q', { keys: { 'Ctrl+Alt+Q': 'quad' } }] },
  { label: 'perspective', maya: ['Alt+1', { keys: { 'Alt+1': 'viewPersp' } }], houdini: ['Space+1', { keys: { 'Space+1': 'viewPersp' } }], blender: ['Numpad 5 (toggles with ortho)', { keys: { Numpad5: 'ortho' } }] },
  {
    label: 'top / front / right',
    maya: ['Alt+2 / Alt+3 / Alt+4', { keys: { 'Alt+2': 'viewTop', 'Alt+3': 'viewFront', 'Alt+4': 'viewRight' } }],
    houdini: ['Space+2 / Space+3 / Space+4', { keys: { 'Space+2': 'viewTop', 'Space+3': 'viewFront', 'Space+4': 'viewRight' } }],
    blender: ['Numpad 7 / 1 / 3', { keys: { Numpad7: 'viewTop', Numpad1: 'viewFront', Numpad3: 'viewRight' } }],
  },
  { label: 'orthographic toggle', maya: ['O', { keys: { O: 'ortho' } }], houdini: ['O', { keys: { O: 'ortho' } }], blender: ['Numpad 5', { keys: { Numpad5: 'ortho' } }] },
  { label: 'select mode', maya: ['Q', { keys: { Q: 'selectMode' } }], houdini: ['S', { keys: { S: 'selectMode' } }], blender: ['W', { keys: { W: 'selectMode' } }] },
  { label: 'move / rotate / scale', phase: 2, maya: ['W / E / R'], houdini: ['T / R / E'], blender: ['G / R / S'] },
  { label: 'snap to grid (held)', phase: 2, maya: ['X'], houdini: ['X'], blender: ['Ctrl (held, with the snap target set to grid)'] },
  { label: 'snap to surface or curve (held)', phase: 2, maya: ['C'], houdini: ['C'], blender: ['Ctrl (target: surface)'] },
  { label: 'snap to point (held)', phase: 2, maya: ['V'], houdini: ['V'], blender: ['Ctrl (target: point)'] },
  { label: 'snapping on / off', phase: 2, maya: ['toolbar'], houdini: ['toolbar'], blender: ['Shift+Tab'] },
  {
    label: 'wire / shaded / shaded + wire',
    maya: ['4 / 5 / 6', { keys: { 4: 'displayWire', 5: 'displayShaded', 6: 'displayShadedWire' } }],
    houdini: ['W (cycles)', { keys: { W: 'displayCycle' } }],
    blender: ['Shift+Z (wire toggle), Z (cycles)', { keys: { 'Shift+Z': 'wireToggle', Z: 'displayCycle' } }],
  },
  { label: 'place a null / curve / area / volume', maya: ['Shift+1 / 2 / 3 / 4', { keys: place }], houdini: ['Shift+1 / 2 / 3 / 4', { keys: place }], blender: ['Shift+1 / 2 / 3 / 4', { keys: place }] },
  { label: 'finish a curve / remove its last point / cancel', maya: ['Enter / Backspace / Esc', { keys: curve }], houdini: ['Enter / Backspace / Esc', { keys: curve }], blender: ['Enter / Backspace / Esc', { keys: curve }] },
  { label: 'delete the selection', maya: ['Delete', { keys: { Delete: 'delete' } }], houdini: ['Delete', { keys: { Delete: 'delete' } }], blender: ['X, Delete', { keys: { X: 'delete', Delete: 'delete' } }] },
  {
    label: 'undo / redo (guides and vars)',
    maya: ['Ctrl+Z / Ctrl+Y (also Z / Shift+Z)', { keys: { 'Ctrl+Z': 'undo', 'Ctrl+Y': 'redo', Z: 'undo', 'Shift+Z': 'redo' } }],
    houdini: ['Ctrl+Z / Ctrl+Y', { keys: { 'Ctrl+Z': 'undo', 'Ctrl+Y': 'redo' } }],
    blender: ['Ctrl+Z / Ctrl+Shift+Z', { keys: { 'Ctrl+Z': 'undo', 'Ctrl+Shift+Z': 'redo' } }],
  },
  { label: 'hide the selection / show all', maya: ['H / Shift+H', { keys: { H: 'hide', 'Shift+H': 'showAll' } }], houdini: ['H / Shift+H', { keys: { H: 'hide', 'Shift+H': 'showAll' } }], blender: ['H / Alt+H', { keys: { H: 'hide', 'Alt+H': 'showAll' } }] },
  { label: 'keymap overlay', maya: ['?', { keys: { '?': 'overlay' } }], houdini: ['?', { keys: { '?': 'overlay' } }], blender: ['?', { keys: { '?': 'overlay' } }] },
];

/** Every action a binding may name (main.js handles each). */
export const ACTIONS = [
  'tumble', 'track', 'dolly', 'frameSelection', 'frameAll', 'quad', 'viewPersp', 'viewTop', 'viewFront', 'viewRight', 'ortho',
  'selectMode', 'displayWire', 'displayShaded', 'displayShadedWire', 'displayCycle', 'wireToggle',
  'placeNull', 'placeCurve', 'placeArea', 'placeVolume', 'finish', 'removeLast', 'cancel',
  'delete', 'undo', 'redo', 'hide', 'showAll', 'overlay',
];

const MODS = ['Ctrl', 'Alt', 'Shift', 'Space'];
/** A chord written as in ROWS ("ctrl+alt+q", "Space+G") in one spelling: modifiers in MODS order, then the key. */
export function canonical(chord) {
  const parts = String(chord).split('+').map((s) => s.trim()).filter(Boolean);
  // "Space" alone is the key (a tap); before another part it is the held modifier
  const key = parts.pop() ?? '';
  const mods = new Set(parts.map((p) => MODS.find((m) => m.toLowerCase() === p.toLowerCase()) ?? p));
  for (const m of mods) if (!MODS.includes(m)) throw new Error(`unknown modifier "${m}" in "${chord}"`);
  const k = key.length === 1 ? key.toUpperCase() : key;
  return [...MODS.filter((m) => mods.has(m)), k].join('+');
}

/** The bindings of one preset: chord → action for keys and for drags. */
export function bindings(presetId) {
  const keys = new Map(), drag = new Map();
  for (const row of ROWS) {
    const b = row[presetId]?.[1];
    if (!b) continue;
    for (const [c, a] of Object.entries(b.keys ?? {})) keys.set(canonical(c), a);
    for (const [c, a] of Object.entries(b.drag ?? {})) drag.set(canonical(c), a);
  }
  return { keys, drag };
}
const cache = new Map();
const bound = (presetId) => { if (!cache.has(presetId)) cache.set(presetId, bindings(presetId)); return cache.get(presetId); };

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

/** The canonical chord of a keyboard event; `space` is true while Space is held (Houdini's modifier). */
export function chordOf(e, space = false) {
  const k = keyToken(e);
  if (!k) return null;
  const mods = [];
  if (e.ctrlKey || e.metaKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  // typing "?" takes Shift on most layouts: the chord is "?" alone
  if (e.shiftKey && k !== '?') mods.push('Shift');
  if (space && k !== 'Space') mods.push('Space');
  return [...mods, k].join('+');
}

/** The action a key press means in a preset, or null. */
export function matchKey(presetId, e, space = false) {
  const c = chordOf(e, space);
  return c ? bound(presetId).keys.get(c) ?? null : null;
}

/** The navigation a mouse drag starts in a preset (tumble, track, dolly), or null. `button` 0 / 1 / 2 = L / M / R. */
export function matchDrag(presetId, { button, altKey = false, ctrlKey = false, metaKey = false, shiftKey = false, space = false }) {
  const b = ['L', 'M', 'R'][button];
  if (!b) return null;
  const mods = [];
  if (ctrlKey || metaKey) mods.push('Ctrl');
  if (altKey) mods.push('Alt');
  if (shiftKey) mods.push('Shift');
  if (space) mods.push('Space');
  return bound(presetId).drag.get([...mods, b].join('+')) ?? null;
}

/** True when Space acts as a held modifier in the preset (Houdini) rather than as a key of its own. */
export const spaceIsModifier = (presetId) => [...bound(presetId).keys.keys(), ...bound(presetId).drag.keys()].some((c) => c.startsWith('Space+') || c.includes('+Space+'));

/** The overlay's table for a preset: [action label, binding text, built] per row of section 9. */
export function overlayRows(presetId) {
  return ROWS.map((r) => ({ label: r.label, text: r[presetId]?.[0] ?? '', built: !r.phase }));
}

/** Show (or hide, when shown) the keymap overlay for a preset over `host`. Returns the overlay element or null. */
export function toggleOverlay(host, presetId) {
  const old = host.querySelector('.keymap-overlay');
  if (old) { old.remove(); return null; }
  const doc = host.ownerDocument;
  const box = doc.createElement('div');
  box.className = 'keymap-overlay';
  const panel = doc.createElement('div');
  panel.className = 'km-panel';
  const head = doc.createElement('div');
  head.className = 'km-head';
  head.textContent = `Keymap — ${PRESETS.find((p) => p.id === presetId)?.label ?? presetId}`;
  const table = doc.createElement('table');
  for (const r of overlayRows(presetId)) {
    const tr = doc.createElement('tr');
    if (!r.built) tr.className = 'later';
    const a = doc.createElement('td'), b = doc.createElement('td');
    a.textContent = r.label;
    b.textContent = r.text + (r.built ? '' : '  (phase 2)');
    tr.append(a, b);
    table.append(tr);
  }
  const foot = doc.createElement('div');
  foot.className = 'km-foot';
  foot.textContent = 'click selects, Shift-click adds, Ctrl-click removes, a drag selects what lies wholly inside its box, Esc clears · ? or Esc closes';
  panel.append(head, table, foot);
  box.append(panel);
  box.addEventListener('pointerdown', (e) => { if (e.target === box) box.remove(); });
  host.append(box);
  return box;
}
