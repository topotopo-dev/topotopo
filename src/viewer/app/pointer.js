// The selection model of design/viewer.md section 5 (G-4): what a left press in the viewport does, decided by the
// kind of target under it and the modifier held. Navigation chords (keymap.js) take priority. Plain data and
// functions, tested in Node (test/viewer-logic.ts).
//
//   input        things you edit (guides, CVs, inputs)   results (cooked geometry)     empty space
//   click        selects it                              selects nothing               clears the selection
//   drag         moves it at once                        tumbles                       tumbles
//   Shift click  adds it                                 adds it, to read its info     nothing
//   Shift drag   box-selects things you edit, never results (wherever it starts)
//   Ctrl click   takes it out                            takes it out                  nothing
//   Ctrl drag    box: takes what lies inside out of the selection (wherever it starts)
import { parseId } from './selection.js';

/** Pixels a press may travel and still be a click. */
export const DRAG_PX = 4;

/** The kind of target an id names: 'edit' (a guide, a CV of one, an input layer), 'result' (cooked geometry), 'empty'. */
export function targetKind(id) {
  if (!id) return 'empty';
  const { obj } = parseId(id);
  return obj.startsWith('guide:') || obj.startsWith('layer:') ? 'edit' : 'result';
}

/**
 * What a left press means: {click, drag, box?}. `click` is 'replace' | 'add' | 'remove' | 'clear' | 'none' (what a
 * release without a drag does with the target); `drag` is 'move' (the target follows the pointer), 'tumble' (the
 * camera) or 'box' (a box with op `box`, 'add' or 'remove'). `movable`: the target can be dragged (a guide or a CV; an
 * input has no move until the gizmo, so a drag on it tumbles). Shift wins over Ctrl, as opOf does.
 */
export function pressPlan({ target = 'empty', shiftKey = false, ctrlKey = false, metaKey = false, movable = false } = {}) {
  if (shiftKey) return { click: target === 'empty' ? 'none' : 'add', drag: 'box', box: 'add' };
  if (ctrlKey || metaKey) return { click: target === 'empty' ? 'none' : 'remove', drag: 'box', box: 'remove' };
  if (target === 'edit') return { click: 'replace', drag: movable ? 'move' : 'tumble' };
  if (target === 'result') return { click: 'none', drag: 'tumble' };
  return { click: 'clear', drag: 'tumble' };
}

/** Whether a click follows the last point closely enough to finish the draft. */
export function isDoubleClick(prev, now) {
  return prev !== null && now.t >= prev.t && now.t - prev.t <= 400 && Math.hypot(now.x - prev.x, now.y - prev.y) <= 5;
}

/** The selection change a click makes: {ids, op} for selection.apply, or null for none. */
export function clickChange(click, id) {
  if (click === 'clear') return { ids: [], op: 'replace' };
  if (!id || click === 'none') return null;
  if (click === 'replace' || click === 'add' || click === 'remove') return { ids: [id], op: click };
  throw new Error(`unknown click "${click}"`);
}

/** Whether a box with op 'add' or 'remove' takes targets of a kind: an adding box never takes results. */
export const boxTakes = (op, kind) => kind === 'edit' || (op === 'remove' && kind === 'result');

/** True once a press has travelled far enough to be a drag. */
export const isDrag = (dx, dy, px = DRAG_PX) => Math.hypot(dx, dy) > px;

/**
 * What wins a pick: a guide or CV within its few pixels, even with cooked geometry in front (they draw on top); else
 * the nearer of an input layer and a result along the ray (`dist`), the input on a tie. An input does not win through
 * a result in front of it: an input under the whole scene (a terrain the graph builds on) would hide every result from
 * hover and Shift-click. Each argument is a hit or null.
 */
export function pickWinner(guide, layer, result) {
  if (guide) return guide;
  if (layer && result) return layer.dist <= result.dist ? layer : result;
  return layer ?? result ?? null;
}

/**
 * Whether a drag that moves `id` changes the selection to it first: yes unless the selection already holds it, or
 * holds its guide whole (dragging a CV of a selected curve keeps the curve selected).
 */
export function dragSelects(items, id) {
  if (items.includes(id)) return false;
  const { obj, piece } = parseId(id);
  return !(piece !== null && items.includes(obj));
}

/** The selection and context menu rows the keymap overlay prints: [action, input]. */
export const SELECTION_ROWS = [
  ['select a guide, a CV or an input', 'L click it'],
  ['move a guide or one of its points', 'L drag it'],
  ['orbit with the left button', 'L drag a result or empty space'],
  ['read a result\'s info', 'Shift + L click it'],
  ['add to / take out of the selection', 'Shift + L click / Ctrl + L click'],
  ['box-select guides and CVs / take out', 'Shift + L drag / Ctrl + L drag'],
  ['clear the selection', 'L click empty space, Esc'],
  ['menu for what is under the pointer', 'Right click'],
];
