// The editor's buttons and menu items, with shortcuts from the keymap.
import { CAMERA_NAMES, SHADINGS } from './camera.js';
import { heldKey, keyOf } from './keymap.js';
import { SNAP_TARGETS } from './snap.js';

export const TOP_BUTTONS = [
  { id: 'undo', icon: 'undo', label: 'Undo', action: 'undo' },
  { id: 'redo', icon: 'redo', label: 'Redo', action: 'redo' },
  { id: 'help', icon: 'help', label: 'Keys and mouse', action: 'overlay' },
];

export const TOOL_BUTTONS = [
  { id: 'tool-select', icon: 'select', label: 'Select', action: 'selectMode' },
  { id: 'tool-move', icon: 'move', label: 'Move', action: 'moveMode' },
  { id: 'tool-rotate', icon: 'rotate', label: 'Rotate', action: 'rotateMode' },
  { id: 'tool-scale', icon: 'scale', label: 'Scale', action: 'scaleMode' },
  { id: 'tool-add', icon: 'add', label: 'Add a guide', menu: 'create' },
];

export const VIEW_BUTTONS = [
  { id: 'view-camera', icon: 'camera', label: 'Camera', menu: 'camera' },
  { id: 'view-shading', icon: 'shading', label: 'Shading', menu: 'shading' },
  { id: 'step', readout: true, label: 'Grid step of the current view' },
  { id: 'view-snap', icon: 'snap', label: 'Snap', menu: 'snap' },
  { id: 'view-frame', icon: 'frame', label: 'Frame', action: 'frameSelection' },
  { id: 'quad', icon: 'quad', label: 'Single / quad view', action: 'quad' },
];

export function buttonTitle(button) {
  const key = button.action && keyOf(button.action);
  return key ? `${button.label} (${key})` : button.label;
}

const capitalize = (s) => s[0].toUpperCase() + s.slice(1);

export function createItems() {
  return ['Null', 'Curve', 'Area', 'Volume'].map((label) => {
    const action = `place${label}`;
    return { label, icon: label.toLowerCase(), key: keyOf(action), action };
  });
}

export function contextItems(target) {
  const create = [{ heading: 'Create' }, ...createItems().map((item) => ({ ...item, create: true }))];
  const separator = { separator: true };
  const row = (label, action) => ({ label, key: keyOf(action), action });
  if (target === 'other') return [...create, separator, row('Frame all', 'frameAll'), row('Show all', 'showAll')];
  const guide = [row('Frame', 'frameSelection'), row('Hide', 'hide'), row('Delete', 'delete'), separator, ...create];
  if (target === 'cv') return [{ label: 'Remove point', does: 'removePoint' }, separator, ...guide];
  if (target === 'line') return [{ label: 'Add point here', does: 'addPoint' }, separator, ...guide];
  return guide;
}

export function cameraItems({ cam, ortho }) {
  return [
    ...CAMERA_NAMES.map((name) => ({
      label: name === 'persp' ? 'Perspective' : capitalize(name),
      key: keyOf(`view${capitalize(name)}`), radio: true, checked: cam === name, cam: name,
    })),
    { separator: true },
    { label: 'Orthographic', key: keyOf('ortho'), check: true, checked: ortho, action: 'ortho' },
  ];
}

export function shadingItems({ shading, edgeCheck }) {
  const actions = { wire: 'displayWire', shaded: 'displayShaded', shadedWire: 'displayShadedWire' };
  return [
    ...SHADINGS.map(([value, label]) => {
      const action = actions[value];
      return { label: capitalize(label), key: keyOf(action), radio: true, checked: shading === value, action };
    }),
    { separator: true },
    { label: 'Edge check', check: true, checked: edgeCheck, toggle: 'edgeCheck' },
  ];
}

export function snapItems({ on, target }) {
  const labels = { grid: 'Grid', point: 'Point', surface: 'Surface or curve' };
  return [
    { label: 'Snapping', toggle: 'snap', check: true, checked: on },
    { separator: true },
    ...SNAP_TARGETS.map((snapTarget) => ({
      label: labels[snapTarget], snapTarget, radio: true, checked: target === snapTarget, key: heldKey(snapTarget),
    })),
  ];
}

export function menuStep(items, index, key) {
  const rows = items.flatMap((item, i) => item.separator || item.heading ? [] : [i]);
  switch (key) {
    case 'ArrowDown': return rows.find((i) => i > index) ?? rows[0] ?? index;
    case 'ArrowUp': return rows.findLast((i) => i < index) ?? rows.at(-1) ?? index;
    case 'Home': return rows[0] ?? index;
    case 'End': return rows.at(-1) ?? index;
    default: return index;
  }
}
