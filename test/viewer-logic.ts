// The viewer page's browser-free logic (src/viewer/app/*.js): the keys and mouse bindings,
// guide (marker) rules shared with the server, the grid step, selection set operations, the undo stack, mesh
// topology (welding, pieces, the render tool's edge classes), the Controls rules, the status and cook state lines,
// the output cards (kind line, heightfield layers, formats offered, download names), the Packages tab (a package's
// state, the Scene tree's mark, a before/after's places) and the minimal edits the viewer makes to a graph file
// (src/viewer/json-edit.ts), and packed instances as the page loads them (scene.js: drawn and framed at their places).
// Also checks that the page's modules only import each other and the served three.js.
//   node test/viewer-logic.ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../src/nodes/index.ts';
import { markersFromGeometry, markersGeometry, MARKER_KINDS as SERVER_KINDS } from '../src/viewer/server.ts';
import * as km from '../src/viewer/app/keymap.js';
import * as tb from '../src/viewer/app/toolbar.js';
import { ICONS, icon } from '../src/viewer/app/icons.js';
import * as mk from '../src/viewer/app/markers.js';
import * as units from '../src/viewer/app/units.js';
import * as sel from '../src/viewer/app/selection.js';
import * as pt from '../src/viewer/app/pointer.js';
import * as tr from '../src/viewer/app/transform.js';
import * as snap from '../src/viewer/app/snap.js';
import { createUndo } from '../src/viewer/app/undo.js';
import { createGuides } from '../src/viewer/app/guides.js';
import { api, coalesce } from '../src/viewer/app/api.js';
import * as THREE from 'three';
import * as mesh from '../src/viewer/app/mesh.js';
import * as vars from '../src/viewer/app/vars.js';
import * as status from '../src/viewer/app/status.js';
import * as cooking from '../src/viewer/app/cooking.js';
import * as info from '../src/viewer/app/output-info.js';
import * as pop from '../src/viewer/app/export-popover.js';
import * as pkgs from '../src/viewer/app/packages.js';
import { heightfieldPreviewStep } from '../src/core/heightfield.ts';
import { HEIGHTFIELD_PREVIEW_RES, previewGLB } from '../src/render/preview.ts';
import { MeshObject, parseGLB } from '../src/viewer/app/scene.js';
import { Geometry, GeoBuilder } from '../src/core/geometry.ts';
import { packedFromMatrices } from '../src/core/packed.ts';
import { m4euler, m4fromQuat, m4translate } from '../src/core/math.ts';
import type { Vec3 } from '../src/core/math.ts';
import { applyJSONEdits, editJSONText } from '../src/viewer/json-edit.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0, passes = 0;
const check = (cond: any, msg: string) => {
  if (cond) passes++;
  else failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`);
};
const section = (s: string) => console.log(`\n== ${s}`);
const throws = (f: () => unknown) => { try { f(); return null; } catch (e: any) { return e; } };

section('keys and mouse (section 9)');
{
  check(km.ROWS.length === 21 + pt.SELECTION_ROWS.length
    && km.ROWS.every((r: any) => typeof r.label === 'string' && r.label.length > 0 && typeof r.text === 'string' && r.text.length > 0),
    'every row has a label and binding text');
  const seen = new Set<string>();
  const clashes: string[] = [], unknown: string[] = [];
  for (const row of km.ROWS) {
    for (const [kind, chords] of [['key', row.keys], ['drag', row.drag]] as const) {
      for (const [chord, action] of Object.entries(chords ?? {}) as [string, string][]) {
        const id = `${kind}:${km.canonical(chord)}`;
        if (seen.has(id)) clashes.push(id);
        seen.add(id);
        if (!km.ACTIONS.includes(action)) unknown.push(`${chord} → ${action}`);
      }
    }
  }
  check(!clashes.length && !unknown.length, `no chord is bound twice and every bound action exists (${[...clashes, ...unknown].join(', ') || 'ok'})`);
  const { keys, drag } = km.bindings();
  const keyActions = new Set(keys.values()), dragActions = new Set(drag.values());
  const navigation = ['tumble', 'track', 'dolly'];
  check(navigation.every((a) => km.ACTIONS.includes(a))
    && km.ACTIONS.every((a: string) => navigation.includes(a) ? dragActions.has(a) && !keyActions.has(a) : keyActions.has(a) && !dragActions.has(a)),
    'tumble, track and dolly are bound to drags, and every other action has a key');

  const ev = (key: string, code: string, mods: Record<string, boolean> = {}) => ({ key, code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });
  const m = km.matchKey;
  const shift = { shiftKey: true }, ctrl = { ctrlKey: true };
  check(m(ev('f', 'KeyF')) === 'frameSelection' && m(ev('a', 'KeyA')) === 'frameAll' && m(ev(' ', 'Space')) === 'quad'
    && m(ev('o', 'KeyO')) === 'ortho' && m(ev('q', 'KeyQ')) === 'selectMode',
    'F frames the selection, A frames everything, Space switches views, O toggles ortho and Q selects the select tool');
  check(m(ev('1', 'Digit1')) === 'viewPersp' && m(ev('2', 'Digit2')) === 'viewTop' && m(ev('3', 'Digit3')) === 'viewFront' && m(ev('4', 'Digit4')) === 'viewRight',
    '1 / 2 / 3 / 4 choose the perspective, top, front and right views');
  check(m(ev('5', 'Digit5')) === 'displayWire' && m(ev('6', 'Digit6')) === 'displayShaded' && m(ev('7', 'Digit7')) === 'displayShadedWire',
    '5 / 6 / 7 choose wire, shaded and shaded with wire');
  check(m(ev('!', 'Digit1', shift)) === 'placeNull' && m(ev('@', 'Digit2', shift)) === 'placeCurve'
    && m(ev('#', 'Digit3', shift)) === 'placeArea' && m(ev('$', 'Digit4', shift)) === 'placeVolume',
    'Shift+1 / 2 / 3 / 4 place a null, curve, area and volume');
  check(m(ev('Enter', 'Enter')) === 'finish' && m(ev('Backspace', 'Backspace')) === 'removeLast' && m(ev('Escape', 'Escape')) === 'cancel',
    'Enter finishes, Backspace removes the last point and Esc cancels');
  check(m(ev('Delete', 'Delete')) === 'delete' && m(ev('h', 'KeyH')) === 'hide' && m(ev('H', 'KeyH', shift)) === 'showAll',
    'Delete removes the selection, H hides it and Shift+H shows all');
  check(m(ev('z', 'KeyZ', ctrl)) === 'undo' && m(ev('y', 'KeyY', ctrl)) === 'redo' && m(ev('Z', 'KeyZ', { ...ctrl, ...shift })) === 'redo',
    'Ctrl+Z undoes and Ctrl+Y and Ctrl+Shift+Z redo');
  check(m(ev('?', 'Slash', shift)) === 'overlay' && m(ev('/', 'Slash', shift)) === 'overlay' && m(ev('/', 'Slash')) === null,
    'Shift with the slash key opens the overlay whether the event says "?" or "/"');
  check(['X', 'C', 'V', 'Z'].every((k) => m(ev(k.toLowerCase(), 'Key' + k)) === null)
    && m(ev('2', 'Digit2', { altKey: true })) === null,
    'X, C, V, Z and Alt+2 are unbound');
  check(Array.from({ length: 10 }, (_, n) => m(ev(String(n), 'Numpad' + n))).every((a) => a === null)
    && m(ev('Home', 'Numpad7')) === null && m(ev('Delete', 'NumpadDecimal')) === null,
    'numpad digits and decimal are unbound with NumLock on or off');
  check(m(ev('й', 'KeyQ')) === 'selectMode' && m(ev('F', 'KeyF', shift)) === null,
    'letters fall back to the physical key on other alphabets and Shift+F is unbound');

  const d = km.matchDrag;
  check(d({ button: 0 }) === null && d({ button: 1 }) === 'track' && d({ button: 2 }) === 'track',
    'plain left goes to selection or placement, middle and right pan');
  check(d({ button: 0, altKey: true }) === 'tumble' && d({ button: 1, altKey: true }) === 'track' && d({ button: 2, altKey: true }) === 'dolly',
    'Alt with left, middle or right orbits, pans or zooms');
  check(d({ button: 1, shiftKey: true }) === null && d({ button: 2, ctrlKey: true }) === null,
    'Shift+middle and Ctrl+right are unbound');
  check(JSON.stringify(km.overlayRows()) === JSON.stringify(km.ROWS.map(({ label, text }) => ({ label, text }))),
    'the overlay lists every label and its binding text in table order');
  check(km.canonical('shift+ctrl+z') === 'Ctrl+Shift+Z' && !!throws(() => km.canonical('Hyper+A')) && !!throws(() => km.canonical('Space+G')),
    'chords have one spelling and unknown modifiers including Space are refused');
  check(['PRESETS', 'DEFAULT_PRESET', 'surfacePivot', 'spaceIsModifier'].every((name) => !(name in km)),
    'the keymap exports one table and its binding helpers');
}

section('toolbars and menus (section 2)');
{
  const buttons = [...tb.TOP_BUTTONS, ...tb.TOOL_BUTTONS, ...tb.VIEW_BUTTONS];
  const create = tb.createItems();
  const camera = tb.cameraItems({ cam: 'front', ortho: true });
  const shading = tb.shadingItems({ shading: 'shadedWire', edgeCheck: false });
  check(buttons.every((b) => !b.icon || Object.hasOwn(ICONS, b.icon)) && create.every((i) => Object.hasOwn(ICONS, i.icon)),
    'the buttons and Create items use known icons');
  check(icon('move').startsWith('<svg') && icon('move').includes('viewBox="0 0 24 24"') && !!throws(() => icon('nope')),
    'icon renders an SVG and rejects unknown names');
  check([...buttons, ...create, ...camera, ...shading].every((i) => !('action' in i) || i.action === undefined || km.ACTIONS.includes(i.action)),
    'every toolbar and menu action is known to the keymap');
  check(new Set(buttons.map((b) => b.id)).size === buttons.length, 'toolbar button ids are unique');

  const keys = [['frameSelection', 'F'], ['placeNull', 'Shift+1'], ['undo', 'Ctrl+Z'], ['quad', 'Space'], ['overlay', '?'], ['tumble', ''], ['nope', '']];
  check(keys.every(([action, key]) => km.keyOf(action) === key), 'keyOf returns the first chord or an empty string');
  const titles = [
    ['view-frame', 'Frame (F)'], ['undo', 'Undo (Ctrl+Z)'], ['quad', 'Single / quad view (Space)'],
    ['tool-select', 'Select (Q)'], ['help', 'Keys and mouse (?)'], ['view-camera', 'Camera'], ['step', 'Grid step of the current view'],
  ];
  check(titles.every(([id, title]) => tb.buttonTitle(buttons.find((b) => b.id === id)!) === title),
    'the toolbar titles include the key for actions with shortcuts');

  check(create.length === 4 && create.map((i) => i.key).join() === 'Shift+1,Shift+2,Shift+3,Shift+4',
    'Create lists the four guide shortcuts in order');
  const checkedCameras = camera.filter((i) => i.radio && i.checked);
  check(camera.length === 9 && camera[7].separator && checkedCameras.length === 1 && checkedCameras[0].cam === 'front',
    'the Camera menu checks only the current camera in its radio group');
  check(camera.slice(0, 4).map((i) => i.key).join() === '1,2,3,4' && camera.slice(4, 7).every((i) => i.key === ''),
    'only the first four cameras have shortcuts');
  check(camera[8].label === 'Orthographic' && camera[8].key === 'O' && camera[8].check && camera[8].checked
    && !tb.cameraItems({ cam: 'persp', ortho: false })[8].checked,
    'the Orthographic check follows the camera and shows its shortcut');
  check(shading.length === 5 && shading[3].separator && shading[2].radio && shading[2].checked
    && shading.filter((i) => i.radio && i.checked).length === 1 && shading[4].label === 'Edge check' && shading[4].check && !shading[4].checked,
    'the Shading menu checks Shaded + wire and shows Edge check turned off');

  const moves = [
    [-1, 'ArrowDown', 0], [-1, 'ArrowUp', 8], [6, 'ArrowDown', 8], [8, 'ArrowUp', 6], [8, 'ArrowDown', 0],
    [0, 'ArrowUp', 8], [4, 'Home', 0], [4, 'End', 8], [4, 'F', 4],
  ] as const;
  check(moves.every(([index, key, next]) => tb.menuStep(camera, index, key) === next),
    'menu focus skips separators, wraps, and handles Home and End');

  const contextCreate = ['Create', 'Null', 'Curve', 'Area', 'Volume'];
  const contextGuide = ['Frame', 'Hide', 'Delete', '|', ...contextCreate];
  const contextRows = [
    ['guide', contextGuide],
    ['cv', ['Remove point', '|', ...contextGuide]],
    ['line', ['Add point here', '|', ...contextGuide]],
    ['other', [...contextCreate, '|', 'Frame all', 'Show all']],
  ] as const;
  const actionKeys = new Map([['frameSelection', 'F'], ['hide', 'H'], ['delete', 'Delete'], ['frameAll', 'A'], ['showAll', 'Shift+H']]);
  for (const [target, expected] of contextRows) {
    const items: any[] = tb.contextItems(target);
    check(items.map((i) => i.heading ?? i.label ?? (i.separator ? '|' : '')).join() === expected.join(),
      `the ${target} context menu lists the expected rows in order`);
    check(items.filter((i) => i.create === true).map(({ create: _create, ...item }) => JSON.stringify(item)).join() === create.map((i) => JSON.stringify(i)).join()
      && items.filter((i) => !i.create && i.label && !i.does).every((i) => actionKeys.get(i.action) === i.key),
      `the ${target} context menu marks four Create rows and gives the action rows their shortcuts`);
  }
  check(tb.contextItems('cv')[0].does === 'removePoint' && tb.contextItems('line')[0].does === 'addPoint',
    'the point and line context rows name the corresponding point edits');
  check(tb.menuStep(tb.contextItems('guide'), 2, 'ArrowDown') === 5 && tb.menuStep(tb.contextItems('guide'), 5, 'ArrowUp') === 2
    && tb.menuStep(tb.contextItems('other'), -1, 'Home') === 1, 'menu focus skips a heading and a separator in either direction');
  check(contextRows.flatMap(([target]) => tb.contextItems(target)).every((i) => !('action' in i) || km.ACTIONS.includes(i.action)),
    'every context menu action is known to the keymap');
}

section('guides: dragging, adding and removing points');
{
  const curve = { id: 'c', kind: 'path', name: 'road', points: [[0, 0, 0], [10, 0, 0], [10, 0, 10]] };
  const area = { id: 'a', kind: 'zone', name: 'park', points: [[0, 0, 0], [4, 0, 0], [4, 0, 4]] };
  const box = { id: 'v', kind: 'volume', name: 'clear', points: [[0, 1, 0], [4, 1, 2]], height: 3 };
  const moved = mk.movePoint(curve, 1, [10.0004, 0.5, -2.1234]);
  check(JSON.stringify(moved.points) === '[[0,0,0],[10,0.5,-2.123],[10,0,10]]' && JSON.stringify(curve.points[1]) === '[10,0,0]' && moved.name === 'road',
    'movePoint moves one point, to the millimetre, leaving the marker it was given alone');
  check(mk.movePoint(curve, 3, [0, 0, 0]) === null && mk.movePoint(box, 1, [0, 5, 2]) === null, 'movePoint refuses a point that is not there, and a volume whose corners would share an x or a z');
  check(JSON.stringify(mk.translateMarker(curve, [1, 2, 3]).points) === '[[1,2,3],[11,2,3],[11,2,13]]', 'translateMarker moves every point');
  check(JSON.stringify(mk.segmentsOf(curve)) === '[[0,1],[1,2]]' && JSON.stringify(mk.segmentsOf(area)) === '[[0,1],[1,2],[2,0]]' && mk.segmentsOf(box).length === 0,
    'segmentsOf: a curve\'s CV to CV, an area\'s also its closing edge; volumes none');
  check(JSON.stringify(mk.insertPoint(curve, 0, [5, 0, 0]).points) === '[[0,0,0],[5,0,0],[10,0,0],[10,0,10]]'
    && JSON.stringify(mk.insertPoint(area, 2, [2, 0, 2]).points) === '[[0,0,0],[4,0,0],[4,0,4],[2,0,2]]' && mk.insertPoint(curve, 2, [0, 0, 0]) === null,
    'insertPoint lands between the segment\'s ends (an area\'s closing edge at the end); no segment, no point');
  check(JSON.stringify(mk.removePoint(curve, 1).points) === '[[0,0,0],[10,0,10]]' && mk.removePoint(mk.removePoint(curve, 1), 0) === null
    && mk.removePoint(area, 0) === null && mk.removePoint(box, 0) === null,
    'removePoint keeps a curve at 2 CVs and an area at 3 corners; volumes have no CVs to remove');
  const c = mk.volumeCorners(box);
  check(JSON.stringify(c) === '[[0,1,0],[4,1,0],[4,1,2],[0,1,2]]', 'volumeCorners walks the four ground corners at the lower y');
  const r = mk.resizeVolume(box, 2, [6, 9, 5]);
  check(JSON.stringify(r.points) === '[[0,1,0],[6,1,5]]' && r.height === 3 && JSON.stringify(mk.resizeVolume(box, 0, [-2, 0, -1]).points) === '[[4,1,2],[-2,1,-1]]'
    && mk.resizeVolume(box, 2, [0, 0, 7]) === null,
    'resizeVolume drags a ground corner in x and z, the opposite corner and the height stay; a flat box is refused');
  check(mk.parseMarkers({ markers: [moved, mk.insertPoint(area, 1, [5, 0, 2]), r] }).length === 3, 'every edit gives a marker the server takes');
}

section('guides: perspective insertion and drag cancellation');
{
  const camera = new THREE.PerspectiveCamera(90, 1, 0.1, 1000);
  camera.updateMatrixWorld();
  const project = (_slot: number, p: THREE.Vector3) => { const q = p.clone().project(camera); return { x: (q.x + 1) * 500, y: (1 - q.y) * 500 }; };
  const events: string[] = [], undo: any[] = [];
  const ctx: any = {
    store: { get: (_k: string, fallback: unknown) => fallback, set: () => {} },
    objects: new Map(), guidesRoot: new THREE.Group(), hover: null, isolated: false,
    selection: sel.createSelection(() => 0),
    pxWorld: () => 0.01, requestRender: () => {}, message: () => {},
    coalesce: () => () => {}, emit: (event: string) => events.push(event), undo: { push: (step: any) => undo.push(step) },
    views: {
      camera: () => camera, project,
      ray: (_slot: number, x: number, y: number) => { const r = new THREE.Raycaster(); r.setFromCamera(new THREE.Vector2(x / 500 - 1, 1 - y / 500), camera); return r; },
    },
  };
  const guides = createGuides(ctx), curve = { id: 'persp', kind: 'path', name: 'curve1', points: [[-1, 0, -2], [5, 0, -20]] };
  guides.list = [curve];
  const a = project(0, new THREE.Vector3(...curve.points[0])), b = project(0, new THREE.Vector3(...curve.points[1]));
  const x = (a.x + b.x) / 2, y = (a.y + b.y) / 2;
  const hit = guides.handleAt(0, x, y), p = project(0, new THREE.Vector3(...hit.at));
  check(hit.part === 'body' && Math.hypot(p.x - x, p.y - y) < 1e-6, 'perspective guide picking uses the world point under the click, with unequal endpoint depths');
  guides.doubleClick(0, x, y);
  const cv = project(0, new THREE.Vector3(...guides.list[0].points[1]));
  check(guides.list[0].points.length === 3 && Math.hypot(cv.x - x, cv.y - y) < 1 && undo.length === 1, 'double-click inserts the CV at the clicked perspective location as one undo step');
  const original = mk.cloneMarkers(guides.list)[0], live = mk.translateMarker(original, [4, 0, 0]);
  guides.list[0] = live;
  guides.dragging = { start: original, live, moved: true, h: { id: original.id, part: 'body' } };
  events.length = 0;
  guides.dragEnd(true);
  check(JSON.stringify(guides.list[0]) === JSON.stringify(original) && events.includes('guides') && undo.length === 1, 'cancelling a live drag restores geometry and notifies Properties without saving or adding undo');
}

section('guides: cancellation while a prior save is queued');
{
  check(mk.shouldReloadGuides(false, false) && !mk.shouldReloadGuides(true, false) && !mk.shouldReloadGuides(false, true) && !mk.shouldReloadGuides(true, true),
    'an inputs event reloads guides only with no save pending and no edit under way');
  const originalSave = api.saveMarkers, pending: ((r: any) => void)[] = [], bodies: any[] = [];
  let persisted: any = null;
  api.saveMarkers = (body: string) => {
    const snapshot = JSON.parse(body);
    bodies.push(snapshot);
    return new Promise((resolve) => pending.push((result) => { persisted = snapshot; resolve(result); }));
  };
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const finishSave = async () => { const resolve = pending.shift(); if (resolve) resolve({ ok: true, count: 1, points: 1, prims: 0 }); await tick(); };
  try {
    const ctx: any = {
      store: { get: (_k: string, fallback: unknown) => fallback, set: () => {} }, guidesRoot: new THREE.Group(), objects: new Map(),
      selection: sel.createSelection(() => 0), undo: { push: () => {} }, requestRender: () => {},
      message: () => {}, emit: () => {}, pxWorld: () => 0.01, layers: {}, surfacePoint: () => null, coalesce,
      views: { cam: () => ({ name: 'top' }), ray: (_s: number, x: number, y: number) => new THREE.Raycaster(new THREE.Vector3(x, 10, y), new THREE.Vector3(0, -1, 0)) },
    };
    const guides = createGuides(ctx);
    guides.list = [{ id: 'n', kind: 'site', name: 'null1', points: [[0, 0, 0]], radius: 5 }];
    guides.saved = mk.markersBody(guides.list);
    guides.setSize('n', 'radius', 6); // this save is in flight
    guides.setSize('n', 'radius', 7); // this save waits behind it
    guides.dragStart(0, 0, 0, { id: 'n', part: 'point', k: 0, at: [0, 0, 0] });
    guides.dragMove(0, 10, 0);
    await finishSave(); // the queued save now captures the preview at x=10
    check(bodies.length === 2 && bodies[1].markers[0].points[0][0] === 10, 'the deferred-save fixture reaches a live drag preview captured by an earlier queued edit');
    guides.dragEnd(true);
    await finishSave(); // the preview reaches disk after cancellation
    check(bodies.length === 3 && bodies[2].markers[0].points[0][0] === 0, 'cancel queues the original point behind a preview already being saved');
    await finishSave();
    check(persisted.markers[0].points[0][0] === 0 && persisted.markers[0].radius === 7 && !guides.saving(), 'after deferred saves drain, disk and the cancelled local guide agree and the earlier size edit is kept');
    const writes = bodies.length;
    const idle = createGuides(ctx);
    idle.list = mk.cloneMarkers(guides.list); idle.saved = mk.markersBody(idle.list);
    idle.dragStart(0, 0, 0, { id: 'n', part: 'point', k: 0, at: [0, 0, 0] });
    idle.dragMove(0, 10, 0);
    idle.dragEnd(true);
    await tick();
    check(bodies.length === writes && !idle.saving(), 'cancelling an ordinary drag with no pending save performs no network write');
  } finally { api.saveMarkers = originalSave; }
}

section('revert the guides to the tab opening');
{
  const originalRead = api.markers, originalSave = api.saveMarkers;
  const first = [{ id: 'a', kind: 'site', name: 'camp', points: [[0, 0, 0]], radius: 5 }];
  const later = [{ ...first[0], name: 'well' }, { ...first[0], id: 'b', name: 'hill' }];
  let stored = first;
  api.markers = async () => ({ markers: stored });
  api.saveMarkers = async (body: string) => {
    stored = JSON.parse(body).markers;
    return { ok: true, count: stored.length, savedAt: Date.now() };
  };
  try {
    const opening = { at: Date.now(), guides: null };
    const ctx: any = {
      store: { get: (_k: string, fallback: unknown) => fallback, set: () => {} }, guidesRoot: new THREE.Group(), objects: new Map(),
      selection: sel.createSelection(() => 0), undo: createUndo(), requestRender: () => {}, pxWorld: () => 0.01,
      message: () => {}, emit: () => {}, layers: {}, coalesce, packageEdits: { opening },
    };
    const guides = ctx.guides = createGuides(ctx);
    await guides.load();
    stored = later;
    await guides.load();
    check(guides.list === later && mk.markersBody(opening.guides!) === mk.markersBody(first), 'a second read updates the guides and keeps the opening list');
    const diff = vars.revertDiff(opening, new Map(), guides.list);
    vars.revertPackage(ctx, diff, () => { throw new Error('no values to revert'); });
    await new Promise<void>((resolve) => setImmediate(resolve));
    check(diff.guideCount === 2 && ctx.undo.size === 1 && mk.markersBody(stored) === mk.markersBody(first), 'revert saves the whole opening list in one undo step');
    ctx.undo.undo();
    await new Promise<void>((resolve) => setImmediate(resolve));
    check(mk.markersBody(stored) === mk.markersBody(later), 'undo saves the later list again');

    const writes: string[] = [];
    let finish = (_result: any) => {};
    api.saveMarkers = async (body: string) => {
      writes.push(body);
      if (writes.length > 1) return { ok: true, savedAt: Date.now() };
      return new Promise((resolve) => { finish = resolve; });
    };
    guides.replace(first);
    guides.replace(later);
    ctx.packageEdits = { opening: {} };
    guides.resetPackage();
    stored = [{ ...first[0], name: 'bridge' }];
    await guides.load();
    finish({ ok: true, savedAt: Date.now() });
    await new Promise<void>((resolve) => setImmediate(resolve));
    check(writes.length === 1 && guides.list === stored && mk.markersBody(ctx.packageEdits.opening.guides) === mk.markersBody(stored),
      'a package switch reads a new opening list and a queued save from the old package leaves it alone');
  } finally { api.markers = originalRead; api.saveMarkers = originalSave; }
}

section('guides: placing while the scene loads');
{
  // a heavy terrain still cooking: a click that finds no surface would put the null on the grid (y = 0) under it
  const originalSave = api.saveMarkers;
  api.saveMarkers = async () => ({ ok: true });
  try {
    let hit: any = { point: new THREE.Vector3(5, 0, 5), surface: false };
    const ctx: any = {
      store: { get: (_k: string, fallback: unknown) => fallback, set: () => {} }, guidesRoot: new THREE.Group(), objects: new Map(),
      selection: sel.createSelection(() => 0), undo: { push: () => {} }, requestRender: () => {},
      message: () => {}, emit: () => {}, pxWorld: () => 0.01, coalesce, surfacePoint: () => hit,
      output: { loading: true }, layers: { loading: () => false },
      views: { cam: () => ({ name: 'persp' }), ray: (_s: number, x: number, y: number) => new THREE.Raycaster(new THREE.Vector3(x, 10, y), new THREE.Vector3(0, -1, 0)) },
    };
    const guides = createGuides(ctx);
    const click = (x = 10, y = 10) => { guides.pointerDown(0, x, y); guides.pointerUp(0, x, y); };
    guides.setMode('site');
    click();
    check(guides.list.length === 0 && guides.hintState()?.note === 'the scene is still loading: place it once it is drawn',
      'a null clicked on no surface while the output loads stays unplaced and the placement hint says why');
    hit = { point: new THREE.Vector3(5, 7, 5), surface: true };
    click();
    check(guides.list.length === 1 && guides.list[0].points[0][1] === 7, 'on a surface already drawn it is placed while loading');
    guides.setMode('site');
    ctx.output.loading = false; ctx.layers.loading = () => true;
    hit = { point: new THREE.Vector3(1, 0, 1), surface: false };
    click();
    check(guides.list.length === 1, 'a shown reference layer still loading holds it back too');
    ctx.layers.loading = () => false;
    click();
    check(guides.list.length === 2 && guides.list[1].points[0][1] === 0, 'once the scene is drawn, a click on no surface places it on the grid as before');
    guides.setMode('volume');
    ctx.output.loading = true;
    click();
    check(guides.list.length === 2 && guides.draft === null && guides.hintState()?.note === 'the scene is still loading: place it once it is drawn',
      'a click on no surface while loading does not start a volume and the placement hint says why');
  } finally { api.saveMarkers = originalSave; }
}

section('placing: one guide, then back (section 7)');
{
  const messages: [string, string, number, number][] = [];
  const ctx: any = {
    store: { get: (_k: string, fallback: unknown) => fallback, set: () => {} }, guidesRoot: new THREE.Group(), objects: new Map(),
    selection: sel.createSelection(() => 0), undo: { push: () => {} }, requestRender: () => {},
    message: (text: string, kind: string, hold: number, duration: number) => messages.push([text, kind, hold, duration]), emit: () => {}, pxWorld: () => 0.01,
    coalesce: () => () => {},
    surfacePoint: (_slot: number, x: number, y: number) => x < 0 ? null : { point: new THREE.Vector3(x / 10, 2, y / 10), surface: true },
    planePoint: (_slot: number, x: number, y: number, level: number) => new THREE.Vector3(x / 10, level, y / 10),
    views: { project: (_slot: number, p: THREE.Vector3) => ({ x: p.x * 10, y: p.z * 10 }) },
  };
  const guides = createGuides(ctx);
  let t = 0;
  const click = (x: number, y: number, delay = 500) => {
    t += delay;
    guides.pointerDown(0, x, y); guides.pointerUp(0, x, y, t);
  };
  const hint = (text: string, finish: boolean | null, removeLast: boolean | null, note = '') => {
    const h = guides.hintState();
    return h?.text === text && h.finish === finish && h.removeLast === removeLast && h.note === note;
  };
  const placed = (count: number, kind: string, points: number[][]) => {
    const marker = guides.list.at(-1);
    return guides.list.length === count && guides.mode === null && guides.draft === null && guides.hintState() === null
      && marker?.kind === kind && JSON.stringify(marker.points) === JSON.stringify(points)
      && ctx.selection.items.join() === `guide:${marker.id}`;
  };

  ctx.selection.apply(['out']);
  guides.setMode('site');
  check(hint('Null: click the ground or the geometry', null, null), 'the null hint has no Finish or Remove last button');
  click(10, 10);
  check(placed(1, 'site', [[1, 2, 1]]), 'one null click makes a null, ends placing and selects the null alone');
  check(messages.length === 1 && messages[0].join() === `added ${guides.list[0].name},ok,1500,1500`,
    'placing a null only sends its added message in the success style for 1.5 seconds');

  guides.setMode('path');
  check(hint('Curve: click to add a CV', false, false), 'a new curve has disabled Finish and Remove last buttons');
  click(-10, 10);
  check(hint('Curve: click to add a CV', false, false, 'nothing under the pointer'), 'a click on nothing gives a note in the hint');
  click(10, 10);
  check(hint('Curve: 1 CV · click to add one', false, true), 'the first curve CV clears the note and enables only Remove last');
  click(30, 10); click(40, 30);
  check(hint('Curve: 3 CVs · click to add one', true, true), 'a curve with enough CVs can be finished');
  guides.key('finish');
  check(placed(2, 'path', [[1, 2, 1], [3, 2, 1], [4, 2, 3]]), 'Finish makes the three-point curve, ends placing and selects the curve alone');

  guides.setMode('zone');
  check(hint('Area: click to add a corner', false, false), 'a new area has disabled Finish and Remove last buttons');
  click(10, 10);
  check(hint('Area: 1 corner · click to add one, or click the first corner to close it', false, true), 'the first area corner enables only Remove last');
  click(30, 10); click(30, 30);
  check(hint('Area: 3 corners · click to add one, or click the first corner to close it', true, true), 'an area with enough corners can be finished');
  click(10, 10);
  check(placed(3, 'zone', [[1, 2, 1], [3, 2, 1], [3, 2, 3]]), 'clicking the first corner closes the area, ends placing and selects the area alone');

  guides.setMode('volume');
  check(hint('Volume: click one corner', null, null), 'a new volume asks for its first corner and offers only Cancel');
  click(10, 10);
  check(hint('Volume: click the opposite corner · 0 × 0 m, 10.0 m high', null, null), 'the first volume click starts a box at one corner');
  guides.pointerMove(0, 52, 41);
  check(hint('Volume: click the opposite corner · 4.20 × 3.10 m, 10.0 m high', null, null), 'the volume follows the pointer with no button held and shows its dimensions');
  click(60, 45);
  check(placed(4, 'volume', [[1, 2, 1], [6, 2, 4.5]]) && guides.list.at(-1)?.height === mk.DEFAULT_HEIGHT,
    'the second volume click makes the volume at the first corner level, ends placing and selects it alone');
  guides.setMode('volume');
  click(10, 10); click(10, 10);
  check(guides.list.length === 4 && guides.mode === 'volume' && guides.hintState()?.note === 'the volume needs a size',
    'the second click at the same corner makes no volume and the placement hint says why');

  const first = { x: 10, y: 10, t: 100 };
  check(!pt.isDoubleClick(null, first), 'a double-click needs a previous click');
  check(pt.isDoubleClick(first, { x: 13, y: 10, t: 400 }), 'a click 300 ms and 3 px from the last one is a double-click');
  check(!pt.isDoubleClick(first, { x: 13, y: 10, t: 600 }), 'a click 500 ms from the last one is too late');
  check(!pt.isDoubleClick(first, { x: 18, y: 10, t: 400 }), 'a click 8 px from the last one is too far away');
  guides.setMode('path');
  click(10, 10); click(13, 10, 300);
  check(hint('Curve: 1 CV · click to add one', false, true, 'a curve needs 2 points'), 'a double-click with too few CVs leaves the draft and shows why it cannot finish');
  click(30, 10); click(33, 10, 300);
  check(placed(5, 'path', [[1, 2, 1], [3, 2, 1]]), 'a double-click finishes the two-point curve without adding a third point');

  guides.setMode('zone');
  click(10, 10);
  const selection = ctx.selection.items.join();
  check(guides.key('cancel') && guides.mode === null && guides.draft === null && guides.hintState() === null
    && ctx.selection.items.join() === selection, 'Esc with a draft ends placing in one step and keeps the selection');

  const spot = new THREE.Vector3(4, 2, 5);
  for (const kind of ['site', 'path', 'zone', 'volume']) {
    guides.startAt(kind, null);
    check(guides.mode === kind && guides.draft === null && guides.list.length === 5, `starting ${kind} without a spot enters an empty placement mode`);
  }
  guides.startAt('site', spot);
  check(placed(6, 'site', [[4, 2, 5]]), 'starting a null at a spot places and selects it immediately');
  for (const kind of ['path', 'zone']) {
    guides.startAt(kind, spot);
    check(guides.mode === kind && guides.draft?.kind === kind && JSON.stringify(guides.draft.points) === '[[4,2,5]]'
      && guides.list.length === 6, `starting ${kind} at a spot sets the first draft point`);
  }
  guides.startAt('volume', spot);
  check(guides.mode === 'volume' && guides.draft?.a.equals(spot) && guides.draft.b.equals(spot) && guides.list.length === 6,
    'starting a volume at a spot sets its first corner');

  let anyDragPlaced = false;
  for (const kind of ['site', 'path', 'zone', 'volume']) {
    guides.setMode(kind);
    guides.pointerDown(0, 10, 10); guides.pointerUp(0, 30, 30);
    if (guides.draft || guides.mode !== kind || guides.list.length !== 6) anyDragPlaced = true;
  }
  check(!anyDragPlaced, 'a travelling left press places nothing in any guide mode');
}

section('guides: a markers.json written as geometry reads back as guides');
{
  const kinds = [
    { id: 'a', kind: 'site', name: 'village', points: [[10, 2, -5]], radius: 7 },
    { id: 'b', kind: 'path', name: 'road', points: [[0, 0, 0], [20, 1, 0], [20, 2, 30]] },
    { id: 'c', kind: 'zone', name: 'keep empty', points: [[0, 0, 0], [0, 0, 10], [10, 0, 10], [10, 0, 0]] },
    { id: 'd', kind: 'volume', name: 'no trees', points: [[20, 1, 30], [30, 1, 40]], height: 8 },
  ];
  const back = mk.parseMarkers({ markers: markersFromGeometry(markersGeometry(kinds as any)) });
  const by = (k: string) => back.find((m: any) => m.kind === k);
  const zone = by('zone');
  check(back.length === 4 && JSON.stringify(by('site').points) === '[[10,2,-5]]' && by('site').radius === 7 && JSON.stringify(by('path').points) === JSON.stringify(kinds[1].points)
    && by('volume').height === 8 && JSON.stringify(by('volume').points) === JSON.stringify(kinds[3].points) && zone.points.length === 4 && zone.name === 'keep empty',
    `markersFromGeometry(markersGeometry(list)) gives the guides back: names, points, radius, height (${back.map((m: any) => m.name).join(', ')})`);
  const other = new GeoBuilder(new Geometry());
  other.addPrim([other.addPoint(0, 0, 0), other.addPoint(1, 0, 0)], false);
  check(markersFromGeometry(other.build()).length === 0, 'elements without a guide role are not guides');
}

section('guides: the marker rules the server uses');
{
  check(JSON.stringify(SERVER_KINDS) === JSON.stringify(mk.MARKER_KINDS), 'the server\'s MARKER_KINDS are the shared module\'s');
  const list = mk.parseMarkers({ markers: [{ kind: 'site', name: ' camp ', points: [[1, 2, 3]] }, { kind: 'volume', name: 'box', points: [[0, 0, 0], [2, 1, 3]] }] });
  check(list[0].name === 'camp' && list[0].radius === 5 && list[0].id === 'm1' && list[1].height === 10 && list[1].id === 'm2', 'names trimmed, defaults filled in, ids given');
  const e = throws(() => mk.parseMarkers({ markers: [{ kind: 'path', name: 'x', points: [[0, 0, 0]] }] }));
  check(e instanceof mk.MarkerError && /markers\[0\]: a path needs 2 or more points/.test(e.message), `rule breaks are MarkerErrors naming the marker (${e?.message})`);
  check(mk.nextName([{ name: 'null1' }, { name: 'NULL 4' }, { name: 'curve1' }] as any, 'site') === 'null5' && mk.nextName([], 'zone') === 'area1' && mk.nextName([], 'path') === 'curve1',
    'new guides are named as Houdini names objects: null5, area1, curve1');
  const named = [{ id: 'a', name: 'Road' }, { id: 'b', name: 'camp' }] as any;
  check(mk.checkName(named, 'b', ' road ').error?.includes('taken') && mk.checkName(named, 'a', 'road ').name === 'road' && !!mk.checkName(named, 'a', '  ').error && !!mk.checkName(named, 'a', 'x\u0001').error,
    'renames: unique ignoring case (a guide may change its own case), not empty, printable');
  const kinds = [
    { id: 'a', kind: 'site', name: 'village', points: [[10, 2, -5]], radius: 7 },
    { id: 'b', kind: 'path', name: 'road', points: [[0, 0, 0], [20, 1, 0], [20, 2, 30]] },
    { id: 'c', kind: 'zone', name: 'keep empty', points: [[0, 0, 0], [10, 0, 0], [10, 0, 10], [0, 0, 10]] },
    { id: 'd', kind: 'volume', name: 'no trees', points: [[30, 1, 30], [20, 2, 40]], height: 8 },
  ];
  // what the properties panel says the LLM reads is what the server writes
  const agree = kinds.map((m) => {
    const g = markersGeometry([m as any]);
    const rows = mk.markerAttributes(m);
    const el = mk.markerElements(m);
    const ok = rows.every((r: any) => {
      const a = (r.cls === 'point' ? g.points : g.prims).get(r.name);
      return !!a && (r.cls === 'point' ? [0] : [...Array(g.numPrims).keys()]).every((i) => JSON.stringify(a.get(i)) === JSON.stringify(r.value));
    });
    const names = (cls: 'point' | 'prim') => [...(cls === 'point' ? g.points : g.prims).map.keys()].filter((n) => n !== 'P').sort().join();
    const listed = (cls: string) => rows.filter((r: any) => r.cls === cls).map((r: any) => r.name).sort().join();
    return ok && names('point') === listed('point') && names('prim') === listed('prim') && el.points === g.numPoints && el.prims === g.numPrims;
  });
  check(agree.every(Boolean), `markerAttributes and markerElements match markersGeometry for a null, a curve, an area and a volume (${agree.join()})`);
  const box = mk.boxOf(kinds[3]);
  check(box.lo.join() === '20,1,30' && box.hi.join() === '30,9,40' && mk.pivotOf(kinds[3]).join() === '25,5,35' && mk.pivotOf(kinds[0]).join() === '10,2,-5',
    'a volume\'s box rises from its lower corner; pivots: box centre, null point');
  const b0 = mk.boundsOf(kinds[0]);
  check(b0.lo[0] === 3 && b0.hi[2] === 2 && mk.topArea(kinds[2].points) === 100 && mk.pathLength([[0, 0, 0], [3, 4, 0]]) === 5 && mk.halfway([[0, 0, 0], [10, 0, 0]]).join() === '5,0,0',
    'bounds of a null include its radius; area, length and halfway point');
  const sq = [[0, 0, 0], [10, 0, 0], [10, 0, 10], [0, 0, 10]];
  const h = mk.hatchSegments(sq, 1);
  const inside = h.every(([a, b]: number[][]) => [a, b].every((p) => p[0] >= -1e-9 && p[0] <= 10 + 1e-9 && p[2] >= -1e-9 && p[2] <= 10 + 1e-9));
  const diagonal = h.every(([a, b]: number[][]) => Math.abs(Math.abs(b[0] - a[0]) - Math.abs(b[2] - a[2])) < 1e-9);
  const slope = [[0, 0, 0], [10, 10, 0], [10, 10, 10], [0, 0, 10]];
  const hy = mk.hatchSegments(slope, 1);
  check(h.length === 19 && inside && diagonal && hy.every(([a, b]: number[][]) => Math.abs(a[1] - a[0]) < 1e-9 && Math.abs(b[1] - b[0]) < 1e-9),
    `an area's hatch: 45° lines clipped to the polygon (${h.length} in a 10 m square at 1 m), ends at the height of their edges`);
  const concave = [[0, 0, 0], [10, 0, 0], [10, 0, 10], [5, 0, 2], [0, 0, 10]];
  check(mk.hatchSegments(concave, 0.5).every(([a, b]: number[][]) => mk.insideTop((a[0] + b[0]) / 2, (a[2] + b[2]) / 2, concave)), 'a concave area\'s hatch stays inside it');
  check(mk.markersBody([{ id: 'a', kind: 'site', name: 'x', points: [[0, 0, 0]], radius: 2, height: 9 }] as any) === '{"markers":[{"id":"a","kind":"site","name":"x","points":[[0,0,0]],"radius":2}]}',
    'the POST body keeps the stored key order and only the kind\'s own fields');
}

section('stored rotation');
{
  const near = (a: ArrayLike<number>, b: ArrayLike<number>, eps: number) =>
    a.length === b.length && Array.from(a).every((v, i) => Math.abs(v - b[i]) <= eps);
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const samples: [Vec3, number[]][] = [
    [[0, 90, 0], [0, 0.7071068, 0, 0.7071068]],
    [[90, 0, 0], [0.7071068, 0, 0, 0.7071068]],
    [[90, 90, 0], [0.5, 0.5, -0.5, 0.5]],
  ];
  for (const [r, q] of samples) check(near(mk.quatOfRotate(r), q, 1e-6), 'quaternion for ' + r.join(', '));
  const rotations: Vec3[] = [[10, 20, 30], [-170, 45, 90], [0, 90, 0], [90, 90, 0]];
  for (const r of rotations) {
    check(near(m4fromQuat(mk.quatOfRotate(r)), m4euler(r, 'xyz'), 1e-12), 'quaternion follows the engine matrix for ' + r.join(', '));
  }
  for (const r of [...rotations.slice(0, 3), [30, 90, 0]]) {
    const q = mk.quatOfRotate(r);
    check(same(mk.rotateOfQuat(q), r) && same(mk.rotateOfQuat(q.map((v: number) => -3 * v)), r), 'normalised quaternion reads back ' + r.join(', '));
  }
  const beyondPole: Vec3 = [0, 100, 0];
  const canonical: Vec3 = mk.rotateOfQuat(mk.quatOfRotate(beyondPole));
  check(Math.abs(canonical[1]) <= 90 && near(m4euler(canonical, 'xyz'), m4euler(beyondPole, 'xyz'), 1e-9), 'pitch over 90 degrees reads back as an equivalent rotation');

  const site = { id: 's', kind: 'site', name: 'null1', points: [[0, 0, 0]], radius: 5 };
  const box = { id: 'v', kind: 'volume', name: 'volume1', points: [[0, 0, 0], [4, 0, 2]], height: 3 };
  const curve = { id: 'c', kind: 'path', name: 'curve1', points: [[0, 0, 0], [2, 0, 0]] };
  const parse = (m: unknown) => mk.parseMarkers({ markers: [m] })[0];
  const turnedSite = parse({ ...site, rotate: [0, 90, 0] });
  check(same(turnedSite.rotate, [0, 90, 0]) && same(parse({ ...site, rotate: [0, 90.0004, 0] }).rotate, [0, 90, 0]), 'the list keeps rotation to 0.001 degrees');
  check(!('rotate' in parse(site)) && !('rotate' in parse({ ...site, rotate: [0, 0, 0] })), 'missing and zero rotation are omitted');
  for (const rotate of [[1, 2], [0, 'a', 0]]) {
    check(/rotate must be \[rx, ry, rz\] in degrees/.test(throws(() => parse({ ...site, rotate }))?.message ?? ''), 'invalid rotation is refused: ' + JSON.stringify(rotate));
  }
  check(/a volume turns about Y only/.test(throws(() => parse({ ...box, rotate: [10, 0, 0] }))?.message ?? ''), 'volume rotation is limited to Y');
  check(!('rotate' in parse({ ...curve, rotate: [0, 90, 0] })), 'a curve drops rotation');
  const body = JSON.parse(mk.markersBody([turnedSite, box])).markers;
  check(Object.keys(body[0]).join() === 'id,kind,name,points,rotate,radius' && Object.keys(body[1]).join() === 'id,kind,name,points,height',
    'the POST body writes rotation just after points when present');
  const [copy] = mk.cloneMarkers([turnedSite]);
  check(same(copy.rotate, turnedSite.rotate) && copy.rotate !== turnedSite.rotate, 'undo snapshots copy the rotation array');

  const turned = { ...box, rotate: [0, 90, 0] };
  const corners = [[1, 0, 3], [1, 0, -1], [3, 0, -1], [3, 0, 3]];
  check(near(mk.volumeCorners(turned).flat(), corners.flat(), 1e-9), 'the ground corners turn about the box centre');
  const bounds = mk.boundsOf(turned);
  check(near(bounds.lo, [1, 0, -1], 1e-9) && near(bounds.hi, [3, 3, 3], 1e-9) && near(mk.pivotOf(turned), [2, 1.5, 1], 1e-9), 'world bounds turn and the pivot stays');
  check(same(mk.volumeCorners(box), [[0, 0, 0], [4, 0, 0], [4, 0, 2], [0, 0, 2]])
    && same(mk.boundsOf(box), { lo: [0, 0, 0], hi: [4, 3, 2] }) && same(mk.pivotOf(box), [2, 1.5, 1]), 'the unturned volume keeps its corners, bounds and pivot');
  const resized = mk.resizeVolume(turned, 2, [5, 0, -3]);
  check(resized && same(resized.points, [[0, 0, -2], [6, 0, 2]]) && same(resized.rotate, turned.rotate), 'resizing stores the inverse-turned corners and keeps the turn');
  const moved = mk.volumeCorners(resized);
  check(near(moved[0], [1, 0, 3], 1e-9) && near(moved[2], [5, 0, -3], 1e-9), 'the dragged world corner follows the pointer and the opposite one stays');

  const rotated = mk.setRotate(site, 1, 45);
  check(rotated && same(rotated.rotate, [0, 45, 0]) && !('rotate' in mk.setRotate(rotated, 1, 0)!), 'setting a null rotation and clearing it');
  check(mk.setRotate(curve, 1, 45) === null && mk.setRotate(box, 0, 45) === null, 'setting an unsupported angle is refused');
  const yawed = { ...box, rotate: [0, 30, 0] };
  check(same(mk.setVolumeSize(yawed, 0, 6)?.points, [[-1, 0, 0], [5, 0, 2]]) && same(mk.setVolumeSize(yawed, 2, 4)?.points, [[0, 0, -1], [4, 0, 3]]),
    'typed X and Z sizes resize the volume in its own axes about the centre');
  const taller = mk.setVolumeSize(yawed, 1, 7);
  check(taller?.height === 7 && same(taller.points, box.points) && same(taller.rotate, yawed.rotate) && mk.setVolumeSize(yawed, 1, 0) === null, 'typed height keeps the floor and turn and refuses zero');
  check(same(mk.markerAttributes(turnedSite).find((a: any) => a.name === 'orient').value, [0, 0.7071, 0, 0.7071]), 'Properties shows the rounded null quaternion');

  const undo = createUndo();
  const guides = createGuides({
    store: { get: (_k: string, fallback: unknown) => fallback, set: () => {} },
    objects: new Map(), guidesRoot: new THREE.Group(), selection: sel.createSelection(() => 1),
    pxWorld: () => 0.01, requestRender: () => {}, message: () => {}, coalesce: () => () => {}, emit: () => {}, undo,
  });
  guides.list = [site, box];
  check(guides.setRotate('s', 1, 45) && same(guides.byId('s').rotate, [0, 45, 0]) && !guides.setRotate('s', 1, 45)
    && undo.size === 1 && undo.undo() === 'rotate null1' && !('rotate' in guides.byId('s')), 'a typed rotation has one named undo step');
  check(guides.setVolumeSize('v', 1, 7) && guides.byId('v').height === 7 && guides.defaults.height === 7 && !guides.setVolumeSize('v', 1, 7)
    && undo.size === 1 && undo.undo() === 'size of volume1' && guides.byId('v').height === 3, 'a typed size has one named undo step and remembers the new height');
}

section('grid step and readouts (section 4)');
{
  check(units.GRID_STEPS.join() === '0.01,0.1,1,10,100,1000' && units.MAJOR_EVERY === 10, 'steps 0.01 … 1000 m, major lines every 10');
  check(units.gridStep(0.05) === 1 && units.gridStep(0.0005) === 0.01 && units.gridStep(0.005) === 0.1 && units.gridStep(2) === 100 && units.gridStep(500) === 1000 && units.gridStep(1e-9) === 0.01,
    'the step is the smallest whose cells are at least 8 px: 5 cm/px → 1 m, 0.5 mm/px → 1 cm, 2 m/px → 100 m, clamped at both ends');
  check(units.gridStep(1 / 8) === 1 && units.gridStep(1 / 7.9) === 10 && units.gridStep(NaN) === 1, 'a 1 m cell at exactly 8 px still takes 1 m; a bad scale gives 1 m');
  check(units.fmtStep(0.01) === '0.01 m' && units.fmtStep(1000) === '1000 m' && units.fmtSize([1.2, 0.8, 12.25]) === '1.20 × 0.800 × 12.3 m' && units.fmtNum(-0.0001, 2) === '0.00'
    && units.fmtPoint([1.234, 0, -3.456], 1) === '(1.23, 0.00, -3.46)' && units.fmtPoint([1.234, 0, -3.456], 0.01) === '(1.2340, 0.0000, -3.4560)' && units.fmtCount(1234567) === '1,234,567',
    'printing: "grid 0.01 m", sizes, coordinates to a hundredth of the step, no "-0", counts');
}

section('selection (section 5)');
{
  check(sel.opOf({}) === 'replace' && sel.opOf({ shiftKey: true }) === 'add' && sel.opOf({ ctrlKey: true }) === 'remove' && sel.opOf({ ctrlKey: true, shiftKey: true }) === 'add',
    'click replaces, Shift adds, Ctrl removes, Ctrl+Shift adds');
  check(sel.combine(['a', 'b'], ['c', 'a'], 'add').join() === 'b,c,a' && sel.combine(['a', 'b'], ['a'], 'remove').join() === 'b' && sel.combine(['a', 'b'], ['b', 'c'], 'toggle').join() === 'a,c'
    && sel.combine(['a'], ['b', 'b'], 'replace').join() === 'b', 'add moves the added to the end (the lead), remove, toggle, replace without duplicates');
  const p = sel.parseId('layer:scans/a#b.obj#12');
  check(p.obj === 'layer:scans/a#b.obj' && p.piece === 12 && sel.parseId('out').piece === null && sel.parseId('layer:x#y').piece === null && sel.pieceId('out', 3) === 'out#3',
    'piece ids: the number after the last "#"; a "#" inside a file name is not a piece');
  const pieces = (o: string) => (o === 'out' ? 12 : o === 'layer:one' ? 1 : 0);
  check(sel.normalize(['out#3', 'layer:one#0', 'out', 'out#4'], pieces).join() === 'layer:one,out' && sel.normalize(['out#2', 'out#2'], pieces).join() === 'out#2',
    'a piece of a one-piece object is the object; pieces of an object selected whole drop out');
  const s = sel.createSelection(pieces);
  let calls = 0;
  s.onChange(() => calls++);
  s.apply(['guide:a']);
  s.apply(['out#1', 'out#2'], 'add');
  s.apply(['out#2'], 'add');
  check(s.items.join() === 'guide:a,out#1,out#2' && s.lead === 'out#2' && s.touches('out') && !s.touches('layer:one') && calls === 2, `a selection with a lead and change events (${s.items.join()}, ${calls} changes)`);
  s.apply(['guide:a'], 'remove');
  s.prune((id: string) => id !== 'out#1');
  check(s.items.join() === 'out#2' && (s.clear(), s.size === 0), 'remove, prune of vanished objects, clear');
}

section('selection model (section 5, G-4): what a left press does');
{
  const P = (target: string, mods: Record<string, boolean> = {}, movable = target === 'edit') => pt.pressPlan({ target, movable, ...mods });
  const plan = (p: any) => `${p.click}/${p.drag}${p.box ? ':' + p.box : ''}`;
  // the table, row by row: things you edit | results | empty space
  check(plan(P('edit')) === 'replace/move' && plan(P('result')) === 'none/tumble' && plan(P('empty')) === 'clear/tumble',
    'plain: a click selects what you edit, selects nothing on a result, clears on empty space; a drag moves what you edit, else tumbles');
  check(plan(P('edit', {}, false)) === 'replace/tumble', 'an input (no move until the gizmo) selects on a click and tumbles on a drag');
  const shift = { shiftKey: true }, ctrl = { ctrlKey: true };
  check(plan(P('edit', shift)) === 'add/box:add' && plan(P('result', shift)) === 'add/box:add' && plan(P('empty', shift)) === 'none/box:add',
    'Shift: a click adds what you edit and adds a result (to read it); empty space does nothing; a drag box-selects wherever it starts');
  check(plan(P('edit', ctrl)) === 'remove/box:remove' && plan(P('result', ctrl)) === 'remove/box:remove' && plan(P('empty', ctrl)) === 'none/box:remove',
    'Ctrl: a click takes out, a drag box-subtracts wherever it starts');
  check(plan(P('result', { ctrlKey: true, shiftKey: true })) === 'add/box:add' && plan(P('edit', { metaKey: true })) === 'remove/box:remove',
    'Ctrl+Shift adds (Shift wins, as opOf); Cmd is Ctrl');
  check(pt.targetKind('guide:m1') === 'edit' && pt.targetKind('guide:m1#2') === 'edit' && pt.targetKind('layer:scans/a#b.obj#3') === 'edit'
    && pt.targetKind('out') === 'result' && pt.targetKind('out#4') === 'result' && pt.targetKind(null) === 'empty',
    'target kinds: guides, their CVs and input layers are things you edit; "out" and its pieces are results; no id is empty space');
  // a click from a selection of a guide, per target and modifier
  const after = (target: string, id: string | null, mods: Record<string, boolean> = {}, start = ['guide:a', 'out#1']) => {
    const s = sel.createSelection(() => 9);
    s.apply(start);
    const c = pt.clickChange(P(target, mods).click, id);
    if (c) s.apply(c.ids, c.op);
    return s.items.join();
  };
  check(after('result', 'out#2') === 'guide:a,out#1' && after('empty', null) === '' && after('edit', 'guide:b') === 'guide:b',
    'clicks: on a result the selection stays as it is, on empty space it clears, on a guide it becomes that guide');
  check(after('result', 'out#2', shift) === 'guide:a,out#1,out#2' && after('result', 'out#1', ctrl) === 'guide:a' && after('empty', null, shift) === 'guide:a,out#1'
    && after('edit', 'guide:c#3', shift) === 'guide:a,out#1,guide:c#3' && after('edit', 'guide:a', ctrl) === 'out#1',
    'Shift-click adds a result (the lead, which Properties shows) or a CV; Ctrl-click takes either out; Shift on empty space changes nothing');
  check(pt.clickChange('none', 'out') === null && !!throws(() => pt.clickChange('toggle', 'out')), 'no click change for "none"; unknown clicks are refused');
  check(pt.boxTakes('add', 'edit') && !pt.boxTakes('add', 'result') && pt.boxTakes('remove', 'result') && pt.boxTakes('remove', 'edit'),
    'a Shift box takes things you edit, never results; a Ctrl box takes out results too');
  const g = { id: 'guide:a' }, l = { id: 'layer:t.obj', dist: 20 }, r = { id: 'out', dist: 12 }, far = { id: 'out', dist: 30 };
  check(pt.pickWinner(g, l, r) === g && pt.pickWinner(null, l, r) === r && pt.pickWinner(null, l, far) === l && pt.pickWinner(null, l, { id: 'out', dist: 20 }) === l
    && pt.pickWinner(null, null, r) === r && pt.pickWinner(null, l, null) === l && pt.pickWinner(null, null, null) === null,
    'picking: a guide or CV within its pixels beats an input and a result in front of it; between an input and a result the nearer wins (the input on a tie)');
  check(!pt.isDrag(3, 2) && pt.isDrag(4, 3) && pt.DRAG_PX === 4, 'a press is a click until it travels more than 4 px');
  check(pt.dragSelects(['out'], 'guide:a') && !pt.dragSelects(['guide:a', 'out'], 'guide:a') && !pt.dragSelects(['guide:a'], 'guide:a#2') && pt.dragSelects(['guide:a#1'], 'guide:a#2'),
    'a drag selects what it moves, unless it is selected already or its guide is selected whole');
  check(km.matchDrag({ button: 0 }) === null && km.matchDrag({ button: 0, shiftKey: true }) === null && km.matchDrag({ button: 0, ctrlKey: true }) === null,
    'plain, Shift and Ctrl left presses go to the selection model');
  const rows = km.overlayRows();
  check(pt.SELECTION_ROWS.every(([label, text]) => rows.some((r) => r.label === label && r.text === text)), 'the keymap overlay prints the selection model\'s rows');
  check(pt.SELECTION_ROWS.some(([label, text]) => label === 'orbit with the left button' && text === 'L drag a result or empty space'),
    'the selection model names the left drag on a result or empty space as orbit');
}

section('selection model: result info');
{
  check(info.resultName({ output: 'Rotor', node: 'rotor_final' }) === 'Rotor' && info.resultName({ node: 'house', part: 'roof' }) === 'house › roof'
    && info.resultName({ output: 'house', part: 'house' }) === 'house' && info.resultName({}) === 'result',
    'a hovered result shows its output\'s name, else its node\'s, and a part\'s own name after it');
  check(info.partName('mesh_3', 'mesh') === null && info.partName('source_0_1', 'source_0') === null && info.partName('bush', 'scene') === 'bush'
    && info.partName('house_2', 'house') === 'house' && info.partName('roof.v2_1', 'roof.v2') === 'roof.v2' && info.partName('', 'x') === null,
    'a part\'s own name: a numbered primitive goes by its mesh, the preview\'s names for unnamed parts are none');
  check(info.countsLine('1,234 points, 56 prims: 56 polygons\nattributes …') === '1,234 points, 56 prims: 56 polygons' && info.countsLine(undefined) === '',
    'a result\'s counts are its summary\'s first line');
}

section('selection model: CVs, boxes and the guides');
{
  // a top view: x right, z down, 10 px a metre, centred at (500, 500)
  const project = (_slot: number, p: THREE.Vector3) => ({ x: 500 + p.x * 10, y: 500 + p.z * 10 });
  const undo: any[] = [];
  const ctx: any = {
    store: { get: (_k: string, fallback: unknown) => fallback, set: () => {} }, objects: new Map(), guidesRoot: new THREE.Group(), hover: null, isolated: false,
    pxWorld: () => 0.01, requestRender: () => {}, message: () => {}, coalesce: () => () => {}, emit: () => {}, undo: { push: (step: any) => undo.push(step) },
    views: {
      camera: () => null, project,
      ray: (_s: number, x: number, y: number) => new THREE.Raycaster(new THREE.Vector3((x - 500) / 10, 100, (y - 500) / 10), new THREE.Vector3(0, -1, 0)),
    },
  };
  const guides = createGuides(ctx);
  ctx.selection = sel.createSelection((obj: string) => (obj.startsWith('guide:') ? guides.pieceCount(obj.slice(6)) : 0));
  guides.list = [
    { id: 'c', kind: 'path', name: 'road', points: [[0, 0, 0], [10, 0, 0], [20, 0, 0]] },
    { id: 'z', kind: 'zone', name: 'park', points: [[0, 0, 10], [4, 0, 10], [4, 0, 14]] },
    { id: 'n', kind: 'site', name: 'village', points: [[30, 0, 0]], radius: 5 },
    { id: 'v', kind: 'volume', name: 'keep', points: [[40, 0, 0], [44, 0, 4]], height: 3 },
  ];
  const at = (p: number[]) => project(0, new THREE.Vector3(...p));
  const idAt = (p: number[]) => { const h = guides.handleAt(0, at(p).x, at(p).y); return h && guides.idOf(h); };
  check(idAt([10, 0, 0]) === 'guide:c#1' && idAt([5, 0, 0]) === 'guide:c' && idAt([30, 0, 0]) === 'guide:n' && idAt([40, 0, 0]) === 'guide:v' && idAt([4, 0, 14]) === 'guide:z#2',
    'a click on a CV of a curve or an area selects that CV, on a line the guide; a null and a volume select whole');
  check(guides.pieceCount('c') === 3 && guides.pieceCount('n') === 1 && guides.pieceCount('v') === 1 && sel.normalize(['guide:n#0', 'guide:c#1'], (o: string) => guides.pieceCount(o.slice(6))).join() === 'guide:n,guide:c#1',
    'a guide\'s pieces are its CVs (curves and areas), one for a null or a volume');
  const box = (x0: number, x1: number, z0: number, z1: number) => guides.boxSelect((pts: THREE.Vector3[]) => pts.every((p) => p.x >= x0 && p.x <= x1 && p.z >= z0 && p.z <= z1)).join();
  check(box(-1, 11, -1, 1) === 'guide:c#0,guide:c#1' && box(-1, 21, -1, 15) === 'guide:c,guide:z' && box(29, 45, -1, 5) === 'guide:n,guide:v',
    'a box takes the CVs inside it, a guide wholly inside it whole, nulls and volumes whole');
  check(!!guides.cvBounds(guides.list[0], 2) && guides.cvBounds(guides.list[0], 2).min.x === 20 && guides.cvBounds(guides.list[2], 0) === null, 'a CV has bounds (F frames it); a null has no CVs');
  // a change of the list keeps the CVs that are still there
  ctx.selection.apply(['guide:c#2', 'guide:z#0']);
  guides.change('move', (list: any[]) => { list[0].points[2] = [21, 0, 0]; });
  check(ctx.selection.items.join() === 'guide:c#2,guide:z#0', 'an edit of a guide keeps its selected CVs');
  const steps = undo.length, r = guides.removeCVs(new Map([['c', [2, 0]], ['z', [0]]]));
  check(r.removed === 1 && r.kept === 2 && JSON.stringify(guides.list[0].points) === '[[0,0,0],[10,0,0]]' && guides.list[1].points.length === 3 && undo.length === steps + 1,
    'Delete on CVs removes them as one undo step; a curve keeps 2 and an area 3 (those are kept and counted)');
  check(ctx.selection.items.join() === 'guide:z#0', 'the CVs of a changed curve leave the selection (they renumber); those of an unchanged area stay');
  guides.remove(['z']);
  check(ctx.selection.size === 0 && !guides.byId('z'), 'the CVs of a deleted guide leave the selection');

  section('the move tool');
  const site = guides.byId('n');
  const curve = { id: 'c', kind: 'path', name: 'curve1', points: [[1, 0, 0], [3, 0, 4]] };
  const area = { id: 'z', kind: 'zone', name: 'area1', points: [[0, 0, 0], [4, 0, 0], [4, 0, 4], [0, 0, 4]] };
  const list = [site, curve, area], original = JSON.stringify(list);
  const hidden = new Set<string>();
  const wholeNull = tr.transformTargets(list, ['guide:n'], hidden)!;
  const wholeCurve = tr.transformTargets(list, ['guide:c#1', 'guide:c'], hidden)!;
  const delta = [2, 1, -1], movedCurve = wholeCurve.move(delta);
  check(wholeNull.pivot.join() === '30,0,0' && wholeNull.guides === 1 && wholeNull.cvs === 0 && wholeNull.name === site.name
    && wholeNull.move(delta)[0].points[0].join() === '32,1,-1', 'a selected null moves as a whole');
  check(wholeCurve.pivot.join() === '2,0,2' && wholeCurve.guides === 1 && wholeCurve.cvs === 0
    && JSON.stringify(movedCurve[1].points) === '[[3,1,-1],[5,1,3]]', 'a whole curve moves every point even if a CV is also selected');
  const corners = tr.transformTargets(list, ['guide:z#0', 'guide:z#2'], hidden)!;
  const movedArea = corners.move(delta);
  check(corners.pivot.join() === '2,0,2' && corners.guides === 1 && corners.cvs === 2
    && JSON.stringify(movedArea[2].points) === '[[2,1,-1],[4,0,0],[6,1,3],[0,0,4]]',
    'two selected area CVs pivot about their mean and leave the other CVs where they are');
  const mixed = tr.transformTargets(list, ['guide:c', 'guide:z#1', 'guide:z#2'], hidden)!;
  check(mixed.guides === 2 && mixed.cvs === 2 && mixed.pivot.join() === '3.333,0,2',
    'a whole guide and two CVs count as two guides and three positions');
  check(['guide:n', 'out#2', 'guide:unknown'].every((id) => tr.transformTargets(list, [id], new Set(['n'])) === null),
    'a hidden guide, result or unknown guide gives no move target');
  check(JSON.stringify(list) === original && movedCurve !== list && movedCurve[0] === site && movedCurve[2] === area,
    'moving leaves the original list alone and shares untouched guides');

  const center = { x: 0, y: 0 };
  const axes = { x: { x: 90, y: 0 }, y: { x: 0, y: -90 }, z: { x: -54, y: 72 } };
  const shapes = tr.moveGizmo(center, axes, 90);
  const arrows = shapes.filter((shape) => shape.kind === 'arrow');
  check(arrows.length === 3 && arrows.every(({ to }) => Math.hypot(to!.x, to!.y) === 90)
    && shapes.filter((shape) => shape.kind === 'square').length === 3, 'three projected 90 px axes give three arrows and three squares');
  check(tr.moveGizmo(center, { ...axes, z: { x: -3, y: 4 } }, 90).map((shape) => shape.id).join() === 'x,y,xy',
    'an axis pointing towards the camera loses its arrow and its two squares');
  check(JSON.stringify(shapes.find((shape) => shape.id === 'xy')?.corners) === '[{"x":27,"y":-27},{"x":45,"y":-27},{"x":45,"y":-45},{"x":27,"y":-45}]',
    'plane square corners are at 0.3 and 0.5 along each axis');
  check(tr.hitGizmo(shapes, 50, 0) === 'x' && tr.hitGizmo(shapes, 50, 3) === 'x' && tr.hitGizmo(shapes, 10, 0) === null,
    'an arrow takes hits on and beside it while the pivot stays free');
  check(tr.hitGizmo(shapes, 36, -36) === 'xy' && tr.hitGizmo(shapes, 100, 100) === null,
    'a square takes a hit inside it and distant points hit nothing');
  const closeArrows = tr.moveGizmo(center, { ...axes, y: { x: 90, y: 9 } }, 90);
  check(tr.hitGizmo(closeArrows, 50, 4) === 'y', 'the nearer of two arrows wins');
  const stacked = (x: number, y: number) => tr.moveGizmo(center, { x: { x: 90, y: 0, depth: x }, y: { x: 90, y: 9, depth: y }, z: { ...axes.z, depth: 7 } }, 90);
  check(stacked(5, 9).filter((shape) => shape.kind === 'arrow').map((shape) => shape.id).join() === 'y,z,x'
    && stacked(9, 5).filter((shape) => shape.kind === 'arrow').map((shape) => shape.id).join() === 'x,z,y',
    'arrows are listed far to near, so the nearest one is drawn last');
  check(tr.hitGizmo(stacked(5, 9), 50, 3) === 'x' && tr.hitGizmo(stacked(9, 5), 50, 3) === 'y' && tr.hitGizmo(stacked(5, 9), 50, 5) === 'y',
    'of two arrows under the pointer the one in front wins, and beside both the nearer one');

  const down = (x: number, z: number) => ({ origin: [x, 10, z], direction: [0, -1, 0] });
  const zero = [0, 0, 0], xAxis = [1, 0, 0], yAxis = [0, 1, 0];
  const parallel = { origin: [0, 10, 0], direction: xAxis };
  check(tr.axisMove(down(2.5, 0), zero, xAxis) === 2.5 && tr.axisMove(parallel, zero, xAxis) === null,
    'the closest point to a down ray on X is at 2.5 m, a parallel ray has no move');
  check(tr.planeMove(down(1, 1), zero, yAxis)?.join() === '1,0,1'
    && tr.planeMove(parallel, zero, yAxis) === null
    && tr.planeMove({ ...down(1, 1), direction: yAxis }, zero, yAxis) === null, 'plane intersection needs a forward hit');
  check(tr.moveDelta('xz', down(1, 1), down(3, 2), zero)?.join() === '2,0,1'
    && tr.moveDelta('x', down(1, 1), down(3, 2), zero)?.join() === '2,0,0', 'a down ray moves in XZ or along X as constrained');
  check(tr.moveDelta('xz', down(1, 1), down(1.1236, 0.9996), zero)?.join() === '0.124,0,0'
    && tr.moveDelta('x', down(1, 1), down(3.1234, 2), zero)?.join() === '2.123,0,0', 'drag deltas round to the millimetre');

  check(tr.moveText('x', [2.5, 0, 0]) === 'move X 2.50 m'
    && tr.moveText('xz', [1.2, 0, -0.8]) === 'move X 1.20 m · Z -0.80 m', 'the hint shows only moved axes at two decimals');
  check(tr.transformLabel('move', wholeCurve) === 'move curve1' && tr.transformLabel('move', corners) === 'move 2 CVs of area1'
    && tr.transformLabel('move', tr.transformTargets(list, ['guide:z#0'], hidden)!) === 'move CV of area1'
    && tr.transformLabel('move', mixed) === 'move 2 guides', 'undo names a guide, its CVs or the number of guides');
  check(tr.typedValue('2.5', 3) === 2.5 && tr.typedValue('-1', 3) === -1 && tr.typedValue(',5', 3) === 0.5
    && tr.typedValue('+2', 3) === 5 && tr.typedValue('+-2', 3) === 1 && tr.typedValue('*0.5', 3) === 1.5
    && tr.typedValue('/2', 3) === 1.5 && ['/0', 'abc', ''].every((s) => tr.typedValue(s, 3) === null),
    'typed values accept signed numbers, a comma decimal and relative operations, and refuse invalid input');

  const plan = pt.pressPlan({ target: 'gizmo' });
  check(plan.click === 'none' && plan.drag === 'gizmo', 'a plain press on a handle reserves the drag and does nothing on a click');
  check(pt.pressPlan({ target: 'edit', shiftKey: true }).box === 'add'
    && pt.pressPlan({ target: 'edit', ctrlKey: true }).box === 'remove'
    && km.matchDrag({ button: 0, altKey: true }) === 'tumble', 'modified presses use the underlying target or Alt navigation');
  check(km.matchKey({ key: 'w', code: 'KeyW' }) === 'moveMode'
    && km.ROWS.some((row) => row.label === 'move tool (handles on the selection)' && row.text === 'W')
    && tb.buttonTitle(tb.TOOL_BUTTONS[1]) === 'Move (W)', 'W is the move tool and its button follows Select');

  ctx.tool = 'move';
  ctx.selection.apply(['guide:n']);
  undo.length = 0;
  const ray = (x: number) => ctx.views.ray(0, x, 500).ray;
  guides.gizmoStart({ id: 'x' }, ray(850), 90);
  guides.gizmoMove(ray(875));
  const hint = guides.hintState();
  check(JSON.stringify(hint) === '{"text":"move X 2.50 m","finish":null,"removeLast":null,"cancel":null,"note":""}'
    && guides.byId('n').points[0][0] === 32.5 && undo.length === 0, 'the live drag moves the null and shows a hint with no buttons');
  guides.gizmoEnd();
  check(guides.byId('n').points[0][0] === 32.5 && undo.length === 1 && undo[0].label === `move ${site.name}`
    && guides.hintState() === null && ctx.selection.lead === 'guide:n', 'release keeps the move as one labelled undo step and keeps the selection');
  guides.gizmoStart({ id: 'x' }, ray(875), 90);
  guides.gizmoMove(ray(900));
  guides.gizmoEnd(true);
  check(guides.byId('n').points[0][0] === 32.5 && undo.length === 1 && guides.hintState() === null,
    'cancelling restores the point and clears the hint with no new undo step');

  section('the rotate and scale tools');
  const ringSamples = {
    x: [[0, 1, 0], [0, 0, 1], [0, -1, 0], [0, 0, -1]],
    y: [[0, 0, 1], [1, 0, 0], [0, 0, -1], [-1, 0, 0]],
    z: [[1, 0, 0], [0, 1, 0], [-1, 0, 0], [0, -1, 0]],
  };
  for (const [axis, expected] of Object.entries(ringSamples)) {
    const points = tr.ringPoints(zero, axis, 1, 4);
    check(points.length === 4 && points.every((p, k) => p.every((v, i) => Math.abs(v - expected[k][i]) < 1e-12)),
      `the ${axis.toUpperCase()} ring runs in the direction of a positive turn`);
  }

  const pointsAre = (m: { points: number[][] }, points: number[][]) => JSON.stringify(m.points) === JSON.stringify(points);
  const short = { ...curve, points: [[0, 0, 0], [2, 0, 0]] };
  const n0 = { ...site, points: [[0, 0, 0]] }, n4 = { ...site, id: 'n4', points: [[4, 0, 0]] };
  const volume = { id: 'v', kind: 'volume', name: 'volume1', points: [[0, 0, 0], [4, 0, 2]], height: 3 };
  const turned = { ...volume, rotate: [0, 30, 0] };
  const curveTarget = tr.transformTargets([short], ['guide:c'], hidden)!;
  const cvTarget = tr.transformTargets([short], ['guide:c#0'], hidden)!;
  const nullTarget = tr.transformTargets([n0], ['guide:n'], hidden)!;
  const pairTarget = tr.transformTargets([n0, n4], ['guide:n', 'guide:n4'], hidden)!;
  const volumeTarget = tr.transformTargets([volume], ['guide:v'], hidden)!;
  const turnedTarget = tr.transformTargets([turned], ['guide:v'], hidden)!;
  const volumeGroup = tr.transformTargets([turned, n0], ['guide:n', 'guide:v'], hidden)!;
  check(pointsAre(curveTarget.rotate('y', 90)[0], [[1, 0, 1], [1, 0, -1]]), 'a curve turns about the midpoint of its CVs');
  const turnedNull = nullTarget.rotate('y', 90)[0];
  check(pointsAre(turnedNull, [[0, 0, 0]]) && turnedNull.rotate?.join() === '0,90,0', 'a null turns in place');
  const turnedAgain = tr.transformTargets([turnedNull], ['guide:n'], hidden)!.rotate('x', 90)[0];
  check(turnedAgain.rotate?.join() === '90,0,90', 'a second world turn composes with the null orientation');
  const turnedVolume = volumeTarget.rotate('y', 30)[0];
  check(pointsAre(turnedVolume, volume.points) && turnedVolume.rotate?.join() === '0,30,0', 'a volume turns at its own centre with its stored corners in place');
  const turnedPair = pairTarget.rotate('y', 90);
  check(pointsAre(turnedPair[0], [[2, 0, 2]]) && pointsAre(turnedPair[1], [[2, 0, -2]])
    && turnedPair.every((m) => m.rotate?.join() === '0,90,0'), 'two nulls turn around their shared pivot and change orientation');
  check(cvTarget.rings.length === 0 && nullTarget.rings.join() === 'x,y,z' && volumeGroup.rings.join() === 'y',
    'a single CV has no rings, a null has three, and a selection with a volume has Y only');
  check(cvTarget.scales === 'none' && nullTarget.scales === 'all' && pairTarget.scales === 'all'
    && [curveTarget, corners, volumeTarget].every((t) => t.scales === 'axes'), 'scale offers no handles, the centre only, or all handles by selection');
  check(turnedTarget.frame === 30 && [curveTarget, cvTarget, nullTarget, corners, volumeGroup].every((t) => t.frame === 0),
    'a single volume supplies the local frame for scale');

  check(pointsAre(curveTarget.scale([2, 1, 1])[0], [[-1, 0, 0], [3, 0, 0]]), 'a curve scales about its pivot on one axis');
  check(nullTarget.scale([2, 2, 2])[0].radius === 10, 'scaling a null doubles its radius');
  const wider = turnedTarget.scale([2, 1, 1])[0], higher = turnedTarget.scale([1, 2, 1])[0], smaller = turnedTarget.scale([0.5, 0.5, 0.5])[0];
  check(pointsAre(wider, [[-2, 0, 0], [6, 0, 2]]) && wider.rotate?.join() === '0,30,0', 'a volume scales along local X about its centre');
  check(higher.height === 6 && pointsAre(higher, volume.points), 'scaling the volume height keeps its floor');
  check(smaller.height === 1.5 && pointsAre(smaller, [[1, 0, 0.5], [3, 0, 1.5]]), 'uniform scale changes all three of the volume dimensions');
  const scaledPair = pairTarget.scale([2, 2, 2]);
  check(pointsAre(scaledPair[0], [[-2, 0, 0]]) && pointsAre(scaledPair[1], [[6, 0, 0]])
    && scaledPair.every((m) => m.radius === 10), 'scaling two nulls scales their radii and their distance from the pivot');

  check(tr.ringTurn('y', zero, down(0, 1), down(1, 0)) === 90 && tr.ringTurn('y', zero, down(1, 0), down(0, 1)) === -90
    && tr.ringTurn('y', zero, down(0, 1), down(0, -1)) === 180, 'a ring face gives a signed right-handed angle');
  check(tr.ringTurn('y', zero, down(0, 1), parallel) === null, 'a parallel ray has no face turn');
  check(tr.unwrapTurn(170, -170) === 190 && tr.unwrapTurn(-170, 170) === -190 && tr.unwrapTurn(10, 30) === 30, 'turns unwrap in either direction');
  check(tr.tangentTurn({ x: 1, y: 0 }, 90, 0, 90) === 57.3 && tr.tangentTurn({ x: 1, y: 0 }, 0, 50, 90) === 0,
    'an edge turn needs one radius of travel per radian along the tangent');

  const rings = tr.rotateGizmo({
    x: [{ x: -10, y: 0, depth: 5 }, { x: 10, y: 0, depth: 5 }, null],
    z: [{ x: 0, y: -10, depth: 9 }, { x: 0, y: 10, depth: 9 }, null],
  });
  check(tr.hitRing(rings, 8, 0)?.k === 0 && tr.hitRing(rings, 8, 0)?.id === 'x'
    && tr.hitRing(rings, 8, 5)?.id === 'x' && tr.hitRing(rings, 8, 10) === null, 'a ring segment can be hit on its line and up to six pixels away');
  check(tr.hitRing(rings, 0, 0)?.id === 'x', 'the front ring wins at a crossing');

  const scaleShapes = tr.scaleGizmo(center, axes, 90, 'axes');
  const [stem] = scaleShapes, centre = scaleShapes.at(-1)!;
  check(scaleShapes.map((s) => s.kind).join() === 'stem,stem,stem,centre'
    && tr.scaleGizmo(center, axes, 90, 'all').map((s) => s.id).join() === 'all'
    && tr.scaleGizmo(center, axes, 90, 'none').length === 0, 'the scale gizmo draws its offered stems and centre');
  check(tr.hitScale(scaleShapes, 0, 0) === 'all' && tr.hitScale(scaleShapes, 50, 0) === 'x'
    && tr.hitScale(scaleShapes, 100, 100) === null, 'the centre and stem of the scale gizmo take hits');
  check(tr.scaleFactor(stem, 45, 0, 90) === 1.5 && tr.scaleFactor(stem, -90, 0, 90) === 0.01
    && tr.scaleFactor(centre, 30, -60, 90) === 2, 'scale follows the stem or the diagonal and has a positive minimum');
  check(tr.rotateText('y', 35) === 'rotate Y 35.0°' && tr.scaleText('x', 1.25) === 'scale X 1.250'
    && tr.scaleText('all', 1.25) === 'scale 1.250', 'rotate and scale hints show the axis when used and the value at the tool precision');
  check(tr.transformLabel('rotate', nullTarget) === `rotate ${site.name}` && tr.transformLabel('scale', corners) === 'scale 2 CVs of area1'
    && tr.transformLabel('move', mixed) === 'move 2 guides', 'transform labels use the verb and selection name or count');

  const yRing = tr.rotateGizmo({ y: [
    { x: 825, y: 590, depth: 100 }, { x: 915, y: 500, depth: 100 },
    { x: 825, y: 410, depth: 100 }, { x: 735, y: 500, depth: 100 },
  ] })[0];
  const pressRing = { id: 'y', shape: yRing, k: 0 };
  const ringStart = ctx.views.ray(0, 825, 590).ray;
  const hintIs = (text: string) => JSON.stringify(guides.hintState()) === JSON.stringify({ text, finish: null, removeLast: null, cancel: null, note: '' });
  ctx.tool = 'rotate';
  undo.length = 0;
  guides.gizmoStart(pressRing, ringStart, 90);
  guides.gizmoMove(ray(915), 90, -90);
  check(guides.byId('n').rotate?.join() === '0,90,0' && hintIs('rotate Y 90.0°') && undo.length === 0,
    'a ring drag turns the null live and shows a hint with no buttons');
  guides.gizmoEnd();
  check(undo.length === 1 && undo[0].label === `rotate ${site.name}`, 'one ring release records one named undo step');
  guides.gizmoStart(pressRing, ringStart, 90);
  guides.gizmoMove(ray(915), 90, -90);
  guides.gizmoEnd(true);
  check(guides.byId('n').rotate?.join() === '0,90,0' && undo.length === 1 && guides.hintState() === null,
    'cancelling a ring drag restores the turn and records nothing');

  ctx.tool = 'scale';
  undo.length = 0;
  const pressScale = { id: 'all', shape: centre };
  guides.gizmoStart(pressScale, ray(825), 90);
  guides.gizmoMove(ray(855), 30, -60);
  check(guides.byId('n').radius === 10 && hintIs('scale 2.000') && undo.length === 0, 'a centre drag scales the null live and shows a hint with no buttons');
  guides.gizmoEnd();
  check(undo.length === 1 && undo[0].label === `scale ${site.name}`, 'one scale release records one named undo step');
  guides.gizmoStart(pressScale, ray(825), 90);
  guides.gizmoMove(ray(780), -45, 0);
  guides.gizmoEnd(true);
  check(guides.byId('n').radius === 10 && undo.length === 1 && guides.hintState() === null,
    'cancelling a scale drag restores the radius and records nothing');

  check(km.matchKey({ key: 'e', code: 'KeyE' }) === 'rotateMode' && km.matchKey({ key: 'r', code: 'KeyR' }) === 'scaleMode'
    && km.ROWS.some((r) => r.label === 'rotate tool (rings on the selection)' && r.text === 'E')
    && km.ROWS.some((r) => r.label === 'scale tool (handles on the selection)' && r.text === 'R'), 'E and R choose rotate and scale and are listed in the key table');
  check(tb.TOOL_BUTTONS.map((button) => tb.buttonTitle(button)).join() === 'Select (Q),Move (W),Rotate (E),Scale (R),Add a guide',
    'the tool strip lists Select, Move, Rotate, Scale and Add in order');

  section('snapping');
  check(snap.snapMode({ on: false, target: 'grid', held: 'point' }) === 'point'
    && snap.snapMode({ on: true, target: 'surface', held: null }) === 'surface'
    && snap.snapMode({ on: false, target: 'grid', held: null }) === null, 'the held key takes priority over the saved snap state');
  check(snap.snapTo(1.26, 0.5) === 1.5 && Object.is(snap.snapTo(-0.2, 0.5), 0)
    && snap.snapTo(0.123, 0.01) === 0.12, 'grid steps round to millimetres and zero stays positive');
  check(snap.gridPoint([1.26, 0.7, -2.6], 0.5, 'xz').join() === '1.5,0.7,-2.5', 'grid points snap only in the named axes');
  check(snap.gridMove('x', [0.3, 1, 2], [1.1, 0, 0], 0.5).join() === '1.2,0,0'
    && snap.gridMove('xz', [0.3, 1, 2.3], [1.1, 0, -0.95], 0.5).join() === '1.2,0,-0.8',
    'one- and two-axis grid moves land the pivot on grid lines');
  check(snap.landMove('xy', [0, 0, 0], [3, 4, 5]).join() === '3,4,0'
    && snap.landMove('z', [1, 1, 1], [9, 9, 4]).join() === '0,0,3', 'target moves use only the handle axes');
  check(snap.snapTurn(52) === 45 && Object.is(snap.snapTurn(-7), 0) && snap.snapTurn(188) === 195
    && snap.snapTurn(-100) === -105 && snap.snapTurn(7.5) === 15, 'turns snap to 15 degrees without wrapping');
  check(snap.snapScale(1.26) === 1.3 && snap.snapScale(0.02) === 0.1 && snap.snapScale(2.04) === 2,
    'scale snaps in tenths with a minimum of one tenth');

  const candidates = [8, -5, 12].map((x) => ({ point: [x, 0, 0] }));
  const screen = ([x, y, z]: number[]) => z < 0 ? null : { x, y };
  const nearest = snap.nearestOnScreen(candidates, screen, 0, 0);
  check(nearest?.point === candidates[1].point && nearest.d === 5
    && snap.nearestOnScreen(candidates, screen, 0, 13) === null, 'the nearest point must be inside the pixel radius');
  const tied = snap.nearestOnScreen([{ point: [0, 0, -1] }, ...candidates], screen, 10, 0);
  check(tied?.point === candidates[0].point && tied.d === 2, 'a missing projection is skipped and the first point wins a tie');
  check(snap.snapText('grid', 0.1) === 'snap to grid 0.1 m' && snap.snapText('point', 1) === 'snap to point'
    && snap.snapText('surface', 1) === 'snap to surface' && snap.snapText(null, 1) === '', 'the snap hint names the active target');

  const vertexRay = { origin: [0, 0, 0], direction: [0, 0, 1] }, pixel = () => 0.01;
  const vertices = [0.2, 0, 5, 0.08, 0, 5, 1.08, 0, 5, 1.08, 1, 5, 0.08, 1, 5];
  const vertex = snap.nearestVertexOnRay(vertices, null, vertexRay, pixel);
  check(vertex?.point.join() === '0.08,0,5' && vertex.depth === 5 && vertex.away === 8
    && snap.nearestVertexOnRay([0.13, 0, 5], null, vertexRay, pixel) === null,
    'a vertex must be inside the pixel radius and the nearest wins');
  const raised = vertices.map((v, i) => i % 3 === 2 ? v + 5 : v);
  const matrix = new THREE.Matrix4().makeTranslation(0, 0, -5).elements;
  check(JSON.stringify(snap.nearestVertexOnRay(raised, matrix, vertexRay, pixel)) === JSON.stringify(vertex)
    && snap.nearestVertexOnRay([0, 0, -5], null, vertexRay, pixel) === null,
    'vertex snapping uses world coordinates and skips points behind the ray origin');

  const snapEvents = ['x', 'c', 'v'].map((key) => ({ key, code: `Key${key.toUpperCase()}` }));
  check(snapEvents.map(km.heldTarget).join() === 'grid,surface,point' && km.heldKey('point') === 'V'
    && snapEvents.every((e) => km.matchKey(e) === null), 'the three held keys are separate from key actions');
  check(snapEvents.every((e) => ['ctrlKey', 'altKey', 'shiftKey', 'metaKey'].every((key) => km.heldTarget({ ...e, [key]: true }) === null))
    && km.overlayRows().some((r) => r.label === 'snap to grid / surface or curve / point, while held' && r.text === 'X / C / V'),
    'only bare keys hold a target and the overlay explains them');
  check(tb.VIEW_BUTTONS.map(({ id }) => id).join() === 'view-camera,view-shading,step,view-snap,view-frame,quad',
    'the snap button follows the grid step in the view strip');
  const [snapToggle, separator, ...snapRadios] = tb.snapItems({ on: true, target: 'point' });
  check(snapToggle.label === 'Snapping' && snapToggle.toggle === 'snap' && snapToggle.check && snapToggle.checked && separator.separator
    && snapRadios.every((item) => item.radio) && snapRadios.filter((item) => item.checked).map((item) => item.label).join() === 'Point'
    && snapRadios.map(({ label, key }) => `${label} ${key}`).join() === 'Grid X,Point V,Surface or curve C',
    'the snap menu has a toggle and three exclusive targets with their held keys');

  let mode = 'grid', target: number[] | null = null, marked: number[] | null = null, excluded: string[] = [];
  ctx.snap = {
    mode: () => mode, step: () => 0.5, text: () => snap.snapText(mode, 0.5),
    at: (_slot: number, _x: number, _y: number, _mode: string, ids = []) => { excluded = ids; return target && { point: target }; },
    mark: (_slot: number, point: number[] | null) => { marked = point; },
  };
  ctx.tool = 'move';
  guides.gizmoStart({ id: 'x' }, ray(825), 90, 0);
  guides.gizmoMove(ray(841), 16, 0, 841, 500);
  check(guides.byId('n').points[0].join() === '34,0,0' && guides.hintState().note === 'snap to grid 0.5 m',
    'the X handle snaps the null to the grid and shows the grid step');
  guides.gizmoEnd(true);

  ctx.tool = 'rotate';
  guides.gizmoStart(pressRing, ringStart, 90, 0);
  guides.gizmoMove(ctx.views.ray(0, 895, 550).ray, 70, -40, 895, 550);
  check(guides.gizmoDrag.value === 60 && guides.hintState().note === 'snap to grid 0.5 m', 'the ring drag uses a 15 degree step');
  guides.gizmoEnd(true);
  ctx.tool = 'scale';
  guides.gizmoStart(pressScale, ray(825), 90, 0);
  guides.gizmoMove(ray(848), 23, -23, 848, 477);
  check(guides.gizmoDrag.value === 1.5 && guides.byId('n').radius === 15, 'the centre handle uses a scale step of one tenth');
  guides.gizmoEnd(true);

  ctx.tool = 'move';
  mode = 'point';
  target = [4, 0, 0];
  guides.gizmoStart({ id: 'x' }, ray(825), 90, 0);
  guides.gizmoMove(ray(841), 16, 0, 841, 500);
  check(guides.byId('n').points[0].join() === '4,0,0' && excluded.join() === 'n' && marked === target,
    'the X handle lands on and marks a point from outside the moved guides');
  guides.gizmoEnd(true);
  target = [4, 9, 6];
  guides.gizmoStart({ id: 'xz' }, ray(825), 90, 0);
  guides.gizmoMove(ray(841), 16, 0, 841, 500);
  check(guides.byId('n').points[0].join() === '4,0,6', 'the plane square lands on the point along its two axes');
  guides.gizmoEnd(true);
  target = null;
  guides.gizmoStart({ id: 'x' }, ray(825), 90, 0);
  guides.gizmoMove(ray(841), 16, 0, 841, 500);
  check(guides.byId('n').points[0].join() === '34.1,0,0' && marked === null, 'without a point target, the handle follows the free ray');
  guides.gizmoEnd(true);

  ctx.views.cam = () => ({ name: 'top' });
  ctx.surfacePoint = (_slot: number, x: number, y: number, { planeOnly = false } = {}) => {
    const p = new THREE.Vector3((x - 500) / 10, planeOnly ? 0 : 9, (y - 500) / 10);
    return planeOnly ? { point: p, surface: false, axes: 'xz' } : { point: p, surface: true };
  };
  const elevated = { ...curve, points: [[1, 1.25, 0], [3, 1.25, 4]] };
  guides.list = [guides.byId('n'), elevated];
  mode = 'grid';
  guides.dragStart(0, 510, 500, { id: 'c', part: 'point', k: 0, at: elevated.points[0] });
  guides.dragMove(0, 512.6, 515.1);
  check(guides.byId('c').points[0].join() === '1.5,1.25,1.5' && guides.hintState().note === 'snap to grid 0.5 m',
    'a top-view CV drag snaps X and Z in its own plane despite a reference layer under the pointer');
  guides.dragEnd(true);

  mode = 'point';
  target = [4, 2, 6];
  guides.dragStart(0, 825, 500, { id: 'n', part: 'point', k: 0, at: guides.byId('n').points[0] });
  guides.dragMove(0, 840, 500);
  check(guides.byId('n').points[0].join() === target.join() && excluded.join() === 'n', 'a free null drag takes all three axes from the snap target');
  guides.dragEnd(true);

  mode = 'grid';
  const click = (x: number, y: number) => { guides.pointerDown(0, x, y); guides.pointerUp(0, x, y); };
  guides.startAt('site', null);
  click(512.6, 515.1);
  check(guides.list.at(-1).kind === 'site' && guides.list.at(-1).points[0].join() === '1.5,0,1.5',
    'placing a null with grid snap uses the construction plane through a surface hit');
  guides.startAt('path', null);
  click(512.6, 515.1);
  guides.pointerMove(0, 525.1, 532.6);
  check(guides.cursor?.toArray().join() === '2.5,0,3.5' && guides.hintState().note === 'snap to grid 0.5 m',
    'a curve shows the snapped rubber-band point before the click');
  click(525.1, 532.6);
  check(guides.draft?.points[1].join() === '2.5,0,3.5', 'the placement click lands at the rubber-band point');
  guides.key('cancel');
}

section('undo stack');
{
  let t = 0, value = 0;
  // read through a function: the edits change it behind TypeScript's back
  const val = () => value;
  const u = createUndo({ now: () => t, limit: 3 });
  const edit = (to: number, key?: string) => { const from = value; value = to; u.push({ label: `set ${to}`, undo: () => { value = from; }, redo: () => { value = to; }, key }); };
  edit(1); edit(2);
  check(u.undo() === 'set 2' && val() === 1 && u.redo() === 'set 2' && val() === 2 && u.undo() && u.undo() && val() === 0 && u.undo() === null, 'undo and redo walk the edits; nothing left is null');
  u.redo(); edit(5);
  check(!u.canRedo && val() === 5 && u.size === 2, 'a new edit drops the redo history');
  u.clear(); value = 0;
  edit(1, 'r'); t += 500; edit(2, 'r'); t += 500; edit(3, 'r'); t += 2000; edit(4, 'r');
  check(u.size === 2 && u.undo() === 'set 4' && u.undo() === 'set 3' && val() === 0, 'edits of one key within 1.5 s merge into one step (typing a radius)');
  u.clear(); value = 0;
  for (const v of [1, 2, 3, 4, 5]) { t += 5000; edit(v); }
  check(u.size === 3, 'the stack keeps its limit');
}

section('mesh topology: welding, pieces, the render tool\'s edges');
{
  // two unit quads side by side (one sharing an edge only through duplicated vertices), and a separate triangle
  const P = new Float32Array([
    0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, // quad A: 0 1 2 3
    1, 0, 0, 2, 0, 0, 2, 1, 0, 1, 1, 0, // quad B: 4 5 6 7 (4 = 1, 7 = 2 by position)
    5, 5, 5, 6, 5, 5, 5, 6, 5, // triangle C: 8 9 10
  ]);
  const I = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 9, 10]);
  const w = mesh.weld(P);
  check(w[4] === 1 && w[7] === 2 && w[5] === 5 && w[0] === 0, 'welding by exact position: split vertices map to the first one');
  const pc = mesh.pieces(I, 11, w);
  check(pc.count === 2 && [...pc.elem].join() === '0,0,0,0,1' && pc.vert[4] === 0 && pc.vert[8] === 1, 'two pieces: the welded quads, the triangle');
  const b = mesh.pieceBounds(P, pc.vert, pc.count);
  check([...b.slice(0, 6)].join() === '0,0,0,2,1,0' && [...b.slice(6)].join() === '5,5,5,6,6,5', 'piece bounds');
  const e = mesh.edgeClasses(I, 11, w);
  // the strip's outline (6 edges) and the triangle's 3 are open; the welded middle edge and the diagonals are shared
  check(e.open.length / 2 === 9 && e.nonManifold.length === 0 && e.flipped.length === 0, `open edges: the outline only (${e.open.length / 2})`);
  const flip = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6]); // quad B wound the other way
  const ef = mesh.edgeClasses(flip, 8, w);
  check(ef.flipped.length / 2 === 1 && ef.open.length / 2 === 6, 'a quad wound the other way: its shared edge is a winding flip');
  const fin = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1]);
  const en = mesh.edgeClasses(new Uint32Array([0, 1, 2, 1, 0, 3, 0, 1, 4]), 5, mesh.weld(fin));
  check(en.nonManifold.length / 2 === 1 && [...en.nonManifold].sort().join() === '0,1', 'three triangles on one edge: non-manifold');
  const sub = mesh.subsetIndex(I, 11, pc.elem, new Set([1]));
  check([...sub].join() === '8,9,10' && mesh.edgePairs(I.subarray(0, 12), w).length / 2 === 9, 'the triangles of chosen pieces; the distinct edges of two quads (6 outline, 1 shared, 2 diagonals)');
  const seg = mesh.pieces(new Uint32Array([0, 1, 1, 2, 3, 4]), 5, new Uint32Array([0, 1, 2, 3, 4]), 2);
  check(seg.count === 2 && [...seg.elem].join() === '0,0,1', 'line segments: connected polylines are pieces');
  check(mesh.pieces(null, 6, new Uint32Array([0, 1, 2, 0, 4, 5])).count === 1, 'unindexed triangles that share a welded vertex are one piece');
  check(JSON.stringify(mesh.EDGE_COLORS) === JSON.stringify({ open: [1, 0.3, 0.62], nonManifold: [1, 0.92, 0.2], flipped: [0.72, 0.45, 1] }), 'the render tool\'s colours: pink open, yellow non-manifold, violet flips');
}

section('Controls rules (section 8)');
{
  check(vars.kindOf({ type: 'float' }, 2) === 'number' && vars.kindOf({ options: ['a', 'b'] }, 'a') === 'select' && vars.kindOf({ type: 'color' }, [1, 0, 0]) === 'color'
    && vars.kindOf({ type: 'bool' }, 1) === 'bool' && vars.kindOf(null, [1, 2, 3]) === 'vector' && vars.kindOf(null, { a: 1 }) === 'json' && vars.kindOf(null, '#ff0000') === 'color',
    'widgets: number, select, colour from a vector, bool from 0/1, vector, json, hex colour');
  const r = vars.rangeOf({ min: 0.1, max: 10 }, 1, false);
  check(r.lo === 0.1 && r.hi === 10 && r.step === 0.01 && vars.rangeOf({ default: 5 }, 5, true).hi === 20 && vars.rangeOf({}, 0, false).lo === -1,
    'slider ranges: declared, 0..4×default, −1..1 around 0');
  // min/max are the slider's range, not a limit on the person: 5 typed into 0.3..3 stays 5 and the slider widens to it;
  // ↺ builds the declared range again (rangeOf)
  const wide = vars.widenRange(vars.rangeOf({ min: 0.3, max: 3 }, 1, false), 5), low = vars.widenRange(vars.rangeOf({ min: 1, max: 10 }, 2, true), -2.5);
  check(wide.lo === 0.3 && wide.hi === 5 && wide.step === 0.01 && low.lo === -3 && low.hi === 10 && low.step === 1 && vars.rangeOf({ min: 0.3, max: 3 }, 5, false).hi === 3
    && vars.widenRange(vars.rangeOf({ min: 0, max: 1, step: 0.25 }, 0, false), 40).step === 0.25 && vars.widenRange(vars.rangeOf({ min: 0, max: 1 }, 0, false), 40).step === 0.1,
    'a value past a declared end widens the slider to it (an int range to whole numbers; the step follows unless declared); the declared range comes back');
  check(vars.pastDeclared({ min: 0.3, max: 3 }, 5) && vars.pastDeclared({ min: 0.3 }, 0.1) && !vars.pastDeclared({ min: 0.3, max: 3 }, 3) && !vars.pastDeclared({}, 1e9) && !vars.pastDeclared({ max: 3 }, 'x'),
    'a value past a declared end is marked; inside the range or with no declared end it is not');
  check(vars.snapTo({ lo: 0.1, step: 0.01 } as any, 0.12345) === 0.12 && vars.blank({ type: 'vec3' }).join() === '0,0,0' && vars.controlList({ s: {} }, { s: 1, extra: 2 }).other.join() === 'extra',
    'snapping to steps, blank vectors, undeclared vars listed apart');
  // param groups: a heading per group in the order of its first param, ungrouped params first, undeclared vars closed
  const secs = vars.controlSections(
    { count: { group: 'Scatter' }, size: { group: 'Rocks' }, seed: {}, gap: { group: 'Rocks' }, jitter: { group: ' Scatter ' }, blank: { group: '' } },
    { count: 1, size: 1, seed: 1, gap: 1, jitter: 1, blank: 1, smallest: 0.2 });
  check(JSON.stringify(secs.map((s: any) => [s.group, s.keys.join()])) === JSON.stringify([[null, 'seed,blank'], ['Scatter', 'count,jitter'], ['Rocks', 'size,gap'], ['other vars', 'smallest']]),
    `sections: ungrouped first, then groups in declaration order holding their params, then "other vars" (${JSON.stringify(secs.map((s: any) => s.group))})`);
  const otherSec = secs[3], rocks = secs[2], loose = vars.controlSections({}, { a: 1 });
  check(vars.sectionClosed(otherSec) && !vars.sectionClosed(rocks) && vars.sectionClosed(rocks, { 'g:Rocks': true }) && !vars.sectionClosed(otherSec, { other: false })
    && loose.length === 1 && loose[0].group === null && loose[0].other && !vars.sectionClosed(loose[0], { other: true }),
    'the undeclared vars start closed when the graph declares params, groups open; the remembered state wins; with nothing declared they are listed as they are');
  // a menu of numbers wrote the picked entry as text ("8"): an entry stands for its option
  const nums = vars.menuOf({ options: [4, 8, 16] }, 8), texts = vars.menuOf({ options: ['low', 'high'] }, 'low'), idx = vars.menuOf({ options: ['low', 'high'] }, 1);
  check(vars.kindOf({ type: 'enum', options: [4, 8, 16] }, 8) === 'select' && nums.valueOf('16') === 16 && nums.textOf(8) === '8' && !nums.byIndex && nums.valueOf('5') === undefined
    && texts.valueOf('high') === 'high' && idx.byIndex && idx.valueOf('high') === 1 && idx.textOf(0) === 'low' && vars.blank({ type: 'enum', options: [4, 8] }) === 4,
    'menus: numeric options give numbers (16, not "16"), text options their text, a number var with text options the index');
  // over a graph file ↺ goes back to the file's value; in a package to the declared default
  check(vars.baseValue('file', { default: 1 }, { s: 3 }, 's') === 3 && vars.baseValue('file', { default: 1 }, {}, 's') === 1 && vars.baseValue('file', { type: 'bool' }, {}, 'b') === false
    && vars.baseValue('package', { default: 1 }, { s: 3 }, 's') === 1 && vars.baseValue('package', null, { s: 3 }, 's') === undefined,
    'what ↺ goes back to: the graph file\'s value (else the default, else a blank), in a package the declared default');
  check(vars.rowShape({ type: 'float', min: 0, max: 10 }, 2) === vars.rowShape({ type: 'float', min: 0, max: 10 }, 7) && vars.rowShape({ type: 'float', min: 0, max: 10 }, 2) !== vars.rowShape({ type: 'float', min: 0, max: 20 }, 2)
    && vars.rowShape(null, [1, 2]) !== vars.rowShape(null, [1, 2, 3]) && vars.rowShape(null, 'a') !== vars.rowShape(null, '#ff0000'),
    'a row keeps its element while its shape stays: a new value keeps it, a new range, vector length or widget builds it again');
  // the reset that a stale graph list caused: values sent after the list was read stand
  const st = { pending: {}, unacked: new Map(), ackAt: new Map([['amp', 500]]), active: null, typing: () => false };
  check(!vars.serverValueWins(st, 'amp', 400) && vars.serverValueWins(st, 'amp', 600) && vars.serverValueWins(st, 'seed', 400),
    'a graph list read before an answer about a var does not replace it; one read after does; other vars follow the list');
  check(!vars.serverValueWins({ ...st, pending: { seed: 2 } }, 'seed', 1e9) && !vars.serverValueWins({ ...st, unacked: new Map([['seed', 1]]) }, 'seed', 1e9)
    && !vars.serverValueWins({ ...st, active: 'seed' }, 'seed', 1e9) && !vars.serverValueWins({ ...st, typing: (k: string) => k === 'seed' }, 'seed', 1e9),
    'nor while a change is on the way (pending, unanswered), dragged or typed');
  check(vars.sessionText(0, 'terrain.json') === 'values as in terrain.json' && vars.sessionText(1, 'terrain.json') === '1 value differs from terrain.json' && vars.sessionText(3, null) === '3 values differ from the graph',
    'the line above the Controls over a graph file');
}

section('package save line and revert');
{
  const at = new Date(2026, 0, 1, 13, 40).getTime(), savedAt = at + 22 * 60_000;
  const state = { pending: false, error: '', savedAt: null as number | null };
  check(vars.packageSaveText(state) === '' && vars.packageSaveText({ ...state, pending: true }) === 'Saving…', 'the save line starts empty and says when a save is on its way');
  vars.finishPackageSave(state, undefined, 'file is locked', at + 1);
  check(vars.packageSaveText(state) === 'Not saved: file is locked' && vars.packageSaveText({ ...state, pending: true }) === 'Saving…', 'a failure stands while idle, and a new save shows its progress');
  vars.finishPackageSave(state, at, '');
  check(vars.packageSaveText(state) === 'Not saved: file is locked', 'an earlier save that answers late does not clear a later failure');
  vars.finishPackageSave(state, savedAt, '');
  vars.finishPackageSave(state, at, '');
  check(vars.packageSaveText(state) === 'Saved 14:02', 'a successful save clears the failure and keeps the latest write time');
  check(vars.revertTitle(at) === 'Put back the values and guides as they were when you opened this tab (13:40)', 'the Revert button explains when its values and guides were read');
  const ask = (values: number, guides: number, added: string[] = []) => vars.revertAsk(at, values, guides, added);
  const end = 'as they were at 13:40, when you opened this tab? Undo brings your changes back.';
  check(ask(1, 0) === `Put back 1 value ${end}` && ask(0, 2) === `Put back 2 guides ${end}`
    && ask(2, 1) === `Put back 2 values and 1 guide ${end}` && ask(1, 0, ['stones']) === `Put back 1 value ${end} stones is new since then and stays.`,
  'the ask counts values, guides or both and names new graphs');

  const graphs = new Map([['road', { width: 3, tint: [1, 0, 0], curb: true }], ['path', { radius: 5 }]]);
  const opening = { at, graphs: null };
  vars.rememberOpening(opening, 'graphs', graphs);
  const current = new Map([['road', { width: 8, tint: [1, 0, 0], detail: 2 }], ['path', { radius: 7 }], ['stones', { size: 10 }]]);
  vars.rememberOpening(opening, 'graphs', current);
  const diff = vars.revertDiff(opening, current, []);
  check(diff.values === 4 && diff.newGraphs.join() === 'stones' && JSON.stringify(diff.edits) === JSON.stringify([
    { name: 'road', before: { width: 8, curb: null, detail: 2 }, after: { width: 3, curb: true, detail: null } },
    { name: 'path', before: { radius: 7 }, after: { radius: 5 } },
  ]), 'revert uses the first values across graphs, restores missing values, removes additions and leaves the new graph alone');
  check(vars.pastRangeText('road_width', { min: 3, max: 14 }, -50) === 'road_width = -50 is past its range 3 to 14: kept. Undo or ↺ brings it back.'
    && vars.pastRangeText('road_width', { max: 14 }, 15).includes('past its maximum of 14')
    && vars.pastRangeText('road_width', { min: 3 }, 2).includes('past its minimum of 3')
    && !vars.pastRangeText('road_width', { default: 3 }, 100) && !vars.pastRangeText('road_width', { min: 3, max: 14 }, 14),
  'a typed value beyond a declared bound is kept and names the range or bound, with no warning for a derived bound');
}

section('cook state line');
{
  const run = (o: any) => ({ running: { cooks: 1, kinds: ['edit'], elapsed: 2000, node: 'eroded', nodeElapsed: 1500, inner: null, stopping: false, superseded: false, ...o }, last: { ok: true, ms: 13200, at: 0 } });
  check(cooking.fmtDuration(850) === '850 ms' && cooking.fmtDuration(4210) === '4.21 s' && cooking.fmtDuration(12345) === '12.3 s' && cooking.fmtDuration(125000) === '2 min 05 s',
    'durations: ms, s, min');
  const l1 = cooking.cookLine(run({}), 500);
  check(l1.kind === 'running' && l1.text === 'cooking eroded · 2.50 s' && /eroded has cooked for 2\.00 s/.test(l1.title), `running: the node and the time, counted on between events (${l1.text})`);
  check(cooking.cookLine(run({ inner: 'copy', node: 'loop' })).text === 'cooking loop › copy · 2.00 s' && cooking.cookLine(run({ kinds: ['export'] })).text.startsWith('exporting eroded'),
    'a nested node beside its loop; an export says so');
  const l2 = cooking.cookLine(run({ stopping: true }));
  check(l2.kind === 'stopping' && l2.text === 'stopping after eroded · 2.00 s' && /cannot be interrupted mid-way/.test(l2.title), `a stop on its way says the node runs to its end (${l2.text})`);
  check(/the new value follows/.test(cooking.cookLine(run({ superseded: true })).text), 'a newer value waiting for the node to end says so');
  check(cooking.cookLine(run({ elapsed: 40 }), 20).text === 'cooked in 13.2 s' && cooking.cookLine(run({ elapsed: 40 }), 200).kind === 'running',
    `a cook shows as running once it has run ${cooking.SHOW_AFTER} ms (short ones do not flicker)`);
  const fail = cooking.cookLine({ running: null, last: { ok: false, ms: 30, error: { node: 'scatter', message: 'no points to scatter on\nsecond line' } } });
  check(fail.kind === 'failed' && fail.text === 'failed at scatter: no points to scatter on' && /second line/.test(fail.title), `a failure: the node and the message (${fail.text})`);
  const stopped = cooking.cookLine({ running: null, last: { ok: false, ms: 30, stopped: 'eroded' } });
  check(stopped.kind === 'stopped' && /stopped at eroded · the view shows the last finished cook/.test(stopped.text) && cooking.cookLine(null).kind === 'none',
    'a stop: where, and that the view shows the last finished cook');
  // a result that cooked but could not be shown: a failure line; a failed or stopped cook, or one running, says more
  const ok = { running: null, last: { ok: true, ms: 30 } };
  const pv = cooking.cookLine(ok, 0, 'preview failed: offset is out of bounds\nat line 2');
  check(pv.kind === 'failed' && pv.text === 'preview failed: offset is out of bounds' && /keeps the last result/.test(pv.title) && cooking.cookLine(null, 0, 'preview failed: x').kind === 'failed',
    `a preview that failed after a good cook shows as a failure (${pv.text})`);
  check(cooking.cookLine({ running: null, last: { ok: false, ms: 30, error: { node: 'scatter', message: 'no points' } } }, 0, 'preview failed: x').text === 'failed at scatter: no points'
    && cooking.cookLine({ running: null, last: { ok: false, ms: 30, stopped: 'eroded' } }, 0, 'preview failed: x').kind === 'stopped' && cooking.cookLine(run({}), 0, 'preview failed: x').kind === 'running',
    'a failed cook, a stop and a running cook keep their own lines over a failed preview');
  const cmp = { package: 'studio/trees', from: '1.1', to: '1.3', done: 2, total: 8, what: 'graphs/main.json pine with studio/trees 1.3', elapsed: 1500, stopping: false };
  const c1 = cooking.compareLine(cmp, 500);
  check(c1.kind === 'running' && c1.text === 'before/after studio/trees 1.1 → 1.3 · 3/8 graphs/main.json pine with studio/trees 1.3 · 2.00 s' && /Stop ends it at the next node/.test(c1.title),
    `a package update's before/after: the versions, the cook it is on, the time (${c1.text})`);
  const c2 = cooking.compareLine({ ...cmp, stopping: true });
  check(c2.kind === 'stopping' && c2.text === 'stopping the before/after of studio/trees 1.1 → 1.3 · 1.50 s' && cooking.compareLine({ ...cmp, total: 0, what: 'starting' }).text === 'before/after studio/trees 1.1 → 1.3 · starting · 1.50 s',
    'stopping, and before the first cook');
}

section('output cook progress');
{
  const progress = { total: 735, ready: 312, failed: 0, waiting: 422, cooking: 'Ridge', left_ms: 181000 };
  const line = cooking.progressLine(progress);
  check(line.text === '312 of 735 ready · cooking Ridge · about 4 min left' && line.done === 312 && line.total === 735 && !line.hidden,
    'output progress names the running cook and rounds the minutes up');
  const seconds = cooking.progressLine({ ...progress, failed: 3, left_ms: 39150 });
  check(seconds.text === '312 of 735 ready · cooking Ridge · about 40 s left · 3 failed' && seconds.done === 315,
    'output progress rounds the seconds up and counts failures as done');
  check(cooking.progressLine({ ...progress, left_ms: 60000 }).text === '312 of 735 ready · cooking Ridge · about 1 min left',
    'a minute left is shown in minutes');
  check(cooking.progressLine({ ...progress, cooking: null }).text === '312 of 735 ready · about 4 min left', 'the name is omitted between cooks');
  check(cooking.progressLine({ ...progress, left_ms: null }).text === '312 of 735 ready · cooking Ridge', 'the time is omitted until there is an estimate');
  check(cooking.progressLine({ ...progress, cooking: null, left_ms: null }).text === '312 of 735 ready', 'the ready count shows without a name or estimate');
  const failed = cooking.progressLine({ ...progress, ready: 732, failed: 3, waiting: 0, cooking: null, left_ms: null });
  check(failed.text === '732 ready · 3 failed' && failed.done === 735 && !failed.hidden, 'finished progress with failures shows both counts');
  check(cooking.progressLine({ ...progress, ready: 735 }).hidden, 'finished progress without failures is hidden');
  check(cooking.progressLine({ total: 1, ready: 0, failed: 0, cooking: 'Ridge' }).hidden
    && cooking.progressLine({ total: 0, ready: 0, failed: 0 }).hidden, 'progress is hidden for one result or none');
  check(cooking.waitLine({ line: 0 }) === 'cooking…', 'a running output says cooking');
  check(cooking.waitLine({ line: 1 }) === 'waiting · next', 'the first waiting output says it is next');
  check(cooking.waitLine({ line: 5 }) === 'waiting · 5 before it', 'a waiting output says how many cooks come before it');
  check(cooking.waitLine({}) === 'cooking…', 'a loading output without a position says cooking');
}

section('the Packages tab: a package\'s state and source, the Scene tree\'s mark, an update\'s places');
{
  const p = (o: any) => ({ package: 'studio/trees', version: '1.1', newer: [], working: [{ place: 'library "lib"', dir: '/lib/trees' }], followed: null, ...o });
  const cur = pkgs.packageState(p({})), small = pkgs.packageState(p({ small: '1.3', big: '2.0' })), big = pkgs.packageState(p({ big: '2.0' }));
  check(cur.kind === 'current' && cur.text === 'up to date' && small.kind === 'update' && small.text === 'update available' && /1\.3 is the newest 1\.x; 2\.0 is a big version, a step of its own/.test(small.title) && big.kind === 'update',
    'the badge: up to date, or update available (a small one, a big one)');
  const fol = pkgs.packageState(p({ small: '1.3', followed: { place: 'library "lib"', dir: '/lib/trees' } }));
  check(fol.kind === 'live' && fol.text === 'live' && /shows the edits of \/lib\/trees \(library "lib"\) instead of the published copy of 1\.1/.test(fol.title) && /1\.3 is the newest/.test(fol.title),
    `live: said even when an update exists (${fol.text})`);
  check(pkgs.packageState(p({ error: 'no place this package looks in has a package studio/trees' })).kind === 'error', 'a package no place has: the error');
  check(pkgs.placesText(['the workspace "valley"', 'library "lib"']) === 'the workspace "valley", library "lib"' && pkgs.packageState(p({ package: 'topotopo/nature', places: ['TopoTopo\'s built-in library'] })).title === '1.1 is the newest version in TopoTopo\'s built-in library'
    && cur.title === '1.1 is the newest version in the places the package looks in', 'the badge names the place that has its package, TopoTopo\'s built-in library by what it is');
  check(/published copy of 1\.1: it changes only when you update/.test(pkgs.sourceText(p({}))) && /showing edits from lib\/trees as they are saved · exports use the published version · this session only/.test(pkgs.sourceText(p({ followed: { place: 'library "lib"', dir: '/lib/trees' } }))),
    'the source switch says what each state means');
  check(!/you are editing|I'm editing/.test(pkgs.savedOffer('studio/trees')) && /new edits in its working folder that are not published yet/.test(pkgs.savedOffer('studio/trees')), 'the offer after a save does not assume the reader is its author');
  const named = pkgs.outputLine('studio/trees', { type: 'studio/trees/pine', kind: 'mesh', tags: ['conifer'], used: true }), dflt = pkgs.outputLine('studio/trees', { type: 'studio/trees', tags: [] });
  check(JSON.stringify(named) === '{"name":"pine","kind":"mesh","tags":["conifer"],"used":true}' && JSON.stringify(dflt) === '{"name":"(default)","kind":"","tags":[],"used":false}', 'an output in a box: its name in the package, its kind, tags and whether the package uses it');
  const rows = new Map([['studio/trees', p({ small: '1.3' })], ['studio/rocks', p({ package: 'studio/rocks', small: '1.2', followed: { library: '../lib', dir: '/lib/rocks' } })], ['nordic/moss', p({ package: 'nordic/moss' })]]);
  const late = pkgs.nodeMark(['studio/trees'], rows), fm = pkgs.nodeMark(['studio/rocks'], rows);
  check(late?.kind === 'update' && late.text === '↑ 1.3' && late.package === 'studio/trees' && /studio\/trees 1\.1 is in use: 1\.3 is a small update \(click: its box in the Packages tab\)/.test(late.title) && fm?.text === 'live' && fm.kind === 'live' && fm.package === 'studio/rocks' && /1\.2 is out/.test(fm.title),
    'the Scene tree marks a node of a package with an update (↑ and the version) and one shown live ("live", also when an update exists)');
  check(pkgs.nodeMark(['nordic/moss'], rows) === null && pkgs.nodeMark(undefined, rows) === null && pkgs.nodeMark(['studio/rocks', 'studio/trees'], rows)?.text === 'live',
    'none for a package up to date or a node of no package; live first');
  check(pkgs.fmtChange(1.618) === '1.62 m' && pkgs.fmtChange(0.36) === '36 cm' && pkgs.fmtChange(0.004) === 'under 1 cm' && pkgs.fmtChange(12) === '12 m', 'changes in metres, centimetres under 1 m');
  const t = { package: 'studio/trees', from: '1.1', to: '1.3' };
  const place = (o: any) => ({ before: { ok: true, errors: [] }, after: { ok: true, errors: [] }, diff: { identical: false, verdict: 'shape changed by up to 50 cm (5.025% of the bbox diagonal)', hausdorff: 0.5 }, views: { a: true, b: true, overlay: true }, ...o });
  check(pkgs.placeVerdict(place({}), t).text === 'shape changed by up to 50 cm' && pkgs.placeVerdict(place({ diff: { identical: false, verdict: 'shape changed by up to 1.618 m (9% of the bbox diagonal), and the topology differs', hausdorff: 1.618 } }), t).text === 'shape changed by up to 1.62 m, and its faces differ'
    && pkgs.placeVerdict(place({ diff: { identical: true, verdict: 'no geometric change (…)' } }), t).text === 'no change'
    && pkgs.placeVerdict(place({ after: { ok: false } }), t).text === 'does not cook with 1.3' && pkgs.placeVerdict(place({ after: { ok: false }, before: { ok: false } }), t).kind === 'failed',
    'a place says what changed in one line, in metres or centimetres; or which version it does not cook with');
  check(pkgs.firstView(place({})) === 'overlay' && pkgs.firstView(place({ diff: { identical: true } })) === 'b' && pkgs.firstView(place({ views: { a: true, b: false, overlay: false } })) === 'a'
    && pkgs.firstView(place({ views: { a: false, b: false, overlay: false } })) === null, 'a place shows the overlay where it changed, else b, else a');
  check(pkgs.shortText({ target: t, places: [place({}), place({ diff: { identical: true } }), place({ after: { ok: false }, diff: null })] }) === '3 places: 1 does not cook with 1.3, 1 changes, 1 stays the same'
    && pkgs.shortText({ target: t, places: [place({ diff: { identical: true } })] }) === 'nothing changes in the place the package uses it' && /no graph of the package uses studio\/trees/.test(pkgs.shortText({ target: t, places: [] }))
    && pkgs.stepText({ big: true, up: true }) === 'a big update' && pkgs.stepText({ big: false, up: false }) === 'back to an older version' && pkgs.day('2026-10-28T03:12:50.931Z') === '2026-10-28',
    'an update in a line; the kind of step; a version\'s day');
  check(pkgs.agentLine({ target: { package: 'ux/crates', to: '2.0' }, mustChange: ['graphs/main.json row: sets slider "count"'] }, 'game') === 'update ux/crates to 2.0 in game and fix: graphs/main.json row: sets slider "count"',
    'a big update gives a line to copy for the agent');
  check(pkgs.usedByText([{ graph: 'main', node: 'row' }, { graph: 'main', node: 'one' }], true) === 'row, one' && pkgs.usedByText([{ graph: 'a', node: 'x' }], false) === 'a › x', 'the nodes that use a package');
}

section('graph file edits (json-edit.ts): only what changes');
{
  const text = '{\n  "nodes": { "b": { "type": "box", "params": { "size": "=s" } } },\n  "vars": { "s": 2.0, "t": 1.50, "label": "a\\u2026b" },\n  "output": "b"\n}\n';
  const add = editJSONText(text, [{ path: ['export'], value: 'glb' }]);
  check(add === text.replace('"output": "b"\n}', '"output": "b",\n  "export": "glb"\n}'), 'a new member goes after the last one, on its own line with its indent');
  const set = editJSONText(text, [{ path: ['vars', 's'], value: 5 }, { path: ['vars', 't'], value: 1.5 }, { path: ['vars', 'label'], value: 'a…b' }]);
  check(set === text.replace('"s": 2.0', '"s": 5'), 'a changed value is written in place; equal ones keep their spelling (1.50, \\u2026)');
  const inline = editJSONText(text, [{ path: ['vars', 'u'], value: [1, 2] }]);
  check(inline === text.replace('"label": "a\\u2026b" }', '"label": "a\\u2026b", "u": [1, 2] }'), 'inline objects stay inline, with the separators they use');
  const nested = editJSONText(text, [{ path: ['outputs', 'rock', 'export'], value: { format: 'obj', path: 'parts/rock.obj' } }]);
  check(JSON.parse(nested).outputs.rock.export.path === 'parts/rock.obj' && nested.startsWith(text.slice(0, text.lastIndexOf('\n}'))), 'missing objects on the way are made');
  const removed = editJSONText(add, [{ path: ['export'] }]);
  const middle = editJSONText(text, [{ path: ['vars', 't'] }]);
  check(removed === text && middle === text.replace('"t": 1.50, ', ''), 'removing a member takes its comma and space with it');
  const crlf = text.replace(/\n/g, '\r\n'), crlfAdd = editJSONText(crlf, [{ path: ['export'], value: 'glb' }]);
  check(crlfAdd === add.replace(/\n/g, '\r\n'), 'Windows line ends stay');
  const ascii = '{"vars":{"label":"x\\u00e9"}}';
  check(editJSONText(ascii, [{ path: ['vars', 'k'], value: 'é…' }]) === '{"vars":{"label":"x\\u00e9","k":"\\u00e9\\u2026"}}', 'a file written with \\u escapes only gets escapes, and no spaces where it has none');
  check(editJSONText(text, [{ path: ['vars', 's'], value: 2 }]) === text, 'an equal value changes nothing');
  const bad = (() => { try { editJSONText('{"a": 1,}', [{ path: ['b'], value: 1 }]); return null; } catch (e) { return e; } })();
  check(bad instanceof SyntaxError, 'text that is not JSON is refused (SyntaxError), not rewritten');
  check(JSON.stringify(applyJSONEdits({ a: { b: 1 }, c: 2 }, [{ path: ['a', 'd'], value: 3 }, { path: ['c'] }])) === '{"a":{"b":1,"d":3}}', 'applyJSONEdits: the value the edited text must read as');
}

section('the tab\'s title, the welcome, and messages that clear themselves (section 4)');
{
  const welcome = await import('../src/viewer/app/welcome.js');
  const builtin = [{ name: 'topotopo/street', title: 'Street', description: '…', version: '1.1', outputs: '7 outputs: bench' }];
  const proj = { package: { id: 'lantern', title: 'Lantern', graph: 'main', name: null }, folder: 'C:\\work\\lantern', file: null, builtin };
  const loose = { package: null, folder: '/home/me/stuff', file: null, builtin };
  check(welcome.pageTitle(proj) === 'Lantern · TopoTopo' && welcome.pageTitle(loose) === 'stuff · TopoTopo' && welcome.pageTitle({ package: null, folder: '/tmp/x', file: 'house.json' }) === 'house.json · TopoTopo',
    'the tab is titled after the package (a graph file, a folder)');
  check(welcome.defaultGraph(proj, ['a', 'main']) === 'main' && welcome.defaultGraph(proj, ['a', 'b']) === 'a' && welcome.defaultGraph(loose, []) === null, 'the package\'s default graph is shown first');
  const wp = welcome.welcomeOf(proj), wf = welcome.welcomeOf(loose);
  check(wp.kind === 'package' && wp.title === 'Lantern' && wp.lead === 'This package has no graphs yet.' && wp.builtin.length === 1
    && wp.steps.join('\n') === [
      'A graph is built by an AI agent connected to TopoTopo, such as Claude Code. Ask it, for example: "Build a street with two houses, lamp posts and trees from TopoTopo\'s built-in packages."',
      'It shows here as soon as it is built, and so does every change after that.',
    ].join('\n'), 'a package without graphs says how a graph gets built and lists TopoTopo\'s built-in packages');
  check(wf.kind === 'folder' && wf.lead === 'This folder is not a TopoTopo package.' && wf.steps.join('\n') === [
    'A package keeps its graphs, the packages they use and their exports together, and shows in the web app.',
    'To make this folder a package, run: topotopo init "/home/me/stuff"',
    'An AI agent connected to TopoTopo, such as Claude Code, can also build a graph here as it is: it shows here at once.',
  ].join('\n'), 'a folder that is no package says how to make it one and how a graph gets built');
  const connect = 'claude mcp add topotopo -- "node" "cli.js" mcp --package "C:/p"';
  const cp = welcome.welcomeOf({ ...proj, connect }), cf = welcome.welcomeOf({ ...loose, connect });
  const connectStep = 'No agent connected yet? For Claude Code, run: ' + connect;
  check(cp.steps.at(-1) === connectStep, 'a package without graphs ends with its exact connection command');
  check(cf.steps.at(-1) === connectStep, 'a folder without graphs ends with its exact connection command');
  check([wp, wf].every(({ steps }) => steps.every((s: string) => !s.includes('No agent connected'))),
    'with no connection command, neither welcome offers one');
  check([wp, wf, cp, cf].every(({ steps }) => steps.every((s: string) => !/your agent|the agent/i.test(s))),
    'neither welcome uses the old wording');
  const unread = [{ file: 'graphs/main.json', error: 'Unexpected token' }, { file: 'graphs/other.json', error: 'Unexpected end of JSON input' }];
  const damaged = welcome.welcomeOf({ ...proj, unread, connect });
  check(damaged.lead === 'A graph file of this package cannot be read.' && damaged.steps.join('\n') === [
    'graphs/main.json: Unexpected token', 'graphs/other.json: Unexpected end of JSON input',
    'Fix the file (or put back an earlier copy of it) and it shows here at once.',
  ].join('\n'), 'the welcome lists unreadable graph files and how to make them show');
  const line = 'graphs/main.json cannot be read (Unexpected token): the editor shows the last version it could read';
  check(welcome.unreadMessage([]) === '' && welcome.unreadMessage(unread.slice(0, 1), ['main']) === line && welcome.unreadMessage(unread, ['main', 'town']) === `${line} · and 1 more`,
    'with a graph to show, the message names the unreadable file and counts the rest');
  check(welcome.unreadMessage(unread.slice(0, 1), ['town']) === 'graphs/main.json cannot be read (Unexpected token): it shows here when the file is fixed'
    && welcome.welcomeOf({ package: null, folder: '/home/me/stuff', builtin: [], unread }).lead === 'A graph file of this folder cannot be read.',
    'a file that was never read is not called a last version, and a folder is not called a package');
  const fileUnread = [{ file: 'my rock.json', error: 'Unexpected token', graph: 'my_rock' }];
  check(welcome.unreadMessage(fileUnread, ['my_rock']) === 'my rock.json cannot be read (Unexpected token): the editor shows the last version it could read',
    'the file viewer uses the graph name supplied with the notice');
  const fileWelcome = welcome.welcomeOf({ ...loose, file: 'my rock.json', unread: fileUnread, connect });
  check(fileWelcome.title === 'my rock.json' && fileWelcome.lead === 'This graph file cannot be read.' && fileWelcome.steps.some((s: string) => s.includes('Unexpected token'))
    && fileWelcome.steps.every((s: string) => !s.includes('topotopo init')), 'the file viewer explains the unreadable file without offering to make a package');
  check(status.messageLife('saved 2 values', 'ok') === 6000 && status.messageLife('no such node', 'err') === 12000 && status.messageLife('undid move', '', 2000) === 6000 && status.messageLife('x', '', 9000) === 9000,
    'a message clears itself: 6 s, an error 12 s, longer when held');
  check(status.messageLife('exporting crate…', 'busy') === Infinity && status.messageLife(status.DISCONNECTED_LINE, 'err') === Infinity && status.messageLife('', 'err') === 0,
    'work in progress stays until its result replaces it; so does the disconnected line, until the page reconnects');
  const reopen = 'http://127.0.0.1:7340/p/parts/crate/edit';
  const offline = status.disconnectedNotice(reopen), standalone = status.disconnectedNotice(null);
  check(offline.text === 'The editor is not answering. It stops by itself 10 minutes after its last tab is closed.'
    && offline.links.length === 1 && offline.links[0].text === 'Open it again' && offline.links[0].href === reopen,
    'an editor started by the web app explains its idle stop and offers to open it again');
  check(standalone.text === 'the viewer server is not answering (stopped?): this page reconnects when it runs again'
    && standalone.links.length === 0, 'a standalone viewer keeps its disconnected line');
  const other = status.otherPackageNotice('Crate', 'Shelf', reopen);
  check(other.text === 'This tab was for Crate. The editor at this address now shows Shelf.'
    && JSON.stringify(other.links) === JSON.stringify([{ text: 'Open Crate again', href: reopen }, { text: 'Show Shelf', href: null }])
    && status.otherPackageNotice('Crate', 'Shelf', null).links.length === 1,
    'the other-package line names both packages and offers only the available actions');
}

section('output cards: what an output is, its formats and downloads');
{
  const hf = { name: 'heightfield', width: 21, height: 21, cell: 1, layers: [{ name: 'height', min: -1, max: 2 }, { name: 'flow', min: 0, max: 3.25 }, { name: 'mask', min: 0, max: 1 }] };
  check(info.kindLine({ kind: 'terrain', about: '21 × 21 samples, 1 m apart', size: [20, 3, 20] }) === 'terrain · 21 × 21 samples, 1 m apart · 20.0 × 3.00 × 20.0 m' && info.kindLine({ view: 'file' }) === 'file'
    && info.kindLine({ kind: 'metadata' }) === 'metadata', 'a card says what it is and its size');
  check(info.kindTagsLine({ kind: 'mesh', tags: ['crate', 'wood'] }) === 'mesh [crate, wood]' && info.kindTagsLine({ kind: 'terrain', tags: [] }) === 'terrain' && info.kindTagsLine({ tags: ['x'] }) === 'kind not pinned [x]',
    'kind and tags in words, as the CLI says them');
  check(info.kindBadge({ kind: 'scene' }) === 'scene' && info.kindBadge({ kind: 'metadata' }) === '' && info.kindBadge({}) === ''
    && info.detailLine({ kind: 'terrain', about: '21 × 21 samples, 1 m apart', size: [20, 3, 20] }) === '21 × 21 samples, 1 m apart · 20.0 × 3.00 × 20.0 m', 'the kind is a badge, the size the line beside it');
  check(JSON.stringify(info.layerChoices(hf)) === JSON.stringify([{ value: 'mask', label: 'mask' }, { value: 'flow', label: 'flow (0 .. 3.25)' }, { value: 'none', label: 'none' }]),
    'the layers a terrain shows in red: the mask first, others with their range, then none (never the height itself)');
  check(info.shownLayer(hf, undefined) === 'mask' && info.shownLayer(hf, 'flow') === 'flow' && info.shownLayer(hf, 'gone') === 'mask' && info.shownLayer(hf, 'none') === 'none'
    && info.shownLayer({ layers: [{ name: 'height', min: 0, max: 1 }] }, undefined) === 'none', 'the layer shown: the chosen one while the field has it, else the mask, else none');
  // terrain detail: the page's step and triangle count agree with the server's preview mesh; choices that draw the same
  // are listed once, one that draws every sample is "full", one too heavy for a browser tab is disabled
  check(info.PREVIEW_RES === HEIGHTFIELD_PREVIEW_RES, 'the page and the server agree on the preview budget');
  for (const [w, h, res] of [[1001, 1001, 512], [4001, 2001, 1024], [130, 70, 64], [4001, 4001, Infinity]] as const) {
    const fake = { width: w, height: h } as any, a = info.previewStep(fake, res), b = heightfieldPreviewStep(fake, res);
    check(a.step === b.step && a.triangles === 2 * (b.shown[0] - 1) * (b.shown[1] - 1), `step and triangles of ${w} × ${h} at ${res}: ${a.step}, ${a.triangles}`);
  }
  const two = info.detailChoices({ width: 1001, height: 1001, cell: 2 }), eight = info.detailChoices({ width: 4001, height: 4001, cell: 2 });
  check(JSON.stringify(two.map((c: any) => c.label)) === JSON.stringify(['preview (4 m, 500k triangles)', 'full (every sample, 2M triangles)'])
    && JSON.stringify(eight.map((c: any) => [c.value, c.disabled])) === JSON.stringify([['preview', false], ['1024', false], ['2048', false], ['full', true]])
    && /too many for the viewer/.test(eight[3].label) && info.detailChoices({ width: 129, height: 129, cell: 1 }).length === 1,
    `terrain detail choices: a 2 km field at 2 m (${two.map((c: any) => c.label).join(' | ')}), an 8 km one (full disabled), a small one (only the preview)`);
  const formats = [{ format: 'glb', label: 'GLB', extension: '.glb' }, { format: 'png16', label: 'Heightmap', extension: '.png' }];
  const glb = { format: 'glb', label: 'GLB', extension: '.glb', writes: 'binary glTF', leaves: [], oneFile: true };
  const png = { format: 'png16', label: 'Heightmap', extension: '.png', writes: '16-bit PNG + JSON sidecar', leaves: ['instances'], oneFile: false };
  const card = { label: 'Main output', graph: 'land', output: null, formats: [glb], target: null };
  check(pop.offeredFormats(card, formats).length === 1 && pop.offeredFormats({ ...card, target: { format: 'png16', path: 'land.png' } }, formats).at(-1).misfit
    && pop.offeredFormats({ ...card, formats: undefined }, formats).length === 2, 'a card offers the formats that write it, and marks its target\'s format when that one does not (all of them before a first cook)');
  check(pop.writesLine(png) === '16-bit PNG + JSON sidecar · not the instances' && pop.writesLine(glb) === 'binary glTF', 'a format\'s line: what it writes, and what it leaves out');
  const inside = { ...glb, writes: 'binary glTF with its textures and how it was made inside (+ .source.json in exports/)' };
  check(pop.writesLine(inside, true) === 'binary glTF with its textures and how it was made inside' && /in exports\//.test(pop.writesLine(inside)), 'a download does not say what an export adds in exports/');
  check(typeof pop.exportPathError === 'function' && /the "engine:" prefix is gone: write the path inside exports\/ \("props\/crate\.glb"\)/.test(pop.exportPathError('engine:props/crate.glb'))
    && pop.exportPathError('props/crate.glb') === '' && /without "\.\." or a drive/.test(pop.exportPathError('../x.glb'))
    && pop.targetPathShown('engine:props/crate.glb') === 'props/crate.glb' && pop.targetPathShown('a.glb') === 'a.glb',
    'the Export popover refuses an "engine:" path, saying the path without it, and shows a refused target\'s path without the prefix');
  const saveCopy = 'To save a copy anywhere else, use Download. It saves where your browser saves files.';
  check(['C:/x.glb', 'C:\\x.glb', '/x.glb', '\\\\server\\share\\x.glb'].every((p) => pop.exportPathError(p) === saveCopy),
    `absolute export paths point to Download (${pop.exportPathError('C:/x.glb')})`);
  const warning = 'glTF: tangent attribute skipped';
  const receipt = { file: 'exports/crate.glb', files: 2, warnings: [warning] };
  const notice = status.exportNotice(receipt);
  check(notice?.text === 'Exported exports/crate.glb (2 files)' && notice?.kind === 'warn'
    && notice?.warnings?.[0] === warning && !notice?.text.includes(warning)
    && status.exportNotice({ ...receipt, warnings: [] }).kind === 'ok',
    `an export that wrote files has an Exported message with separate warnings (${notice?.kind ?? 'no warning notice'})`);
  check(pop.downloadName(card, glb) === 'land.glb' && pop.downloadName(card, png) === 'land.zip' && pop.downloadName({ ...card, target: { format: 'glb', path: 'parts/rock.glb' } }, glb) === 'rock.glb'
    && pop.downloadName({ ...card, output: 'trees', target: { format: 'csv', path: 'pcg/trees.points.json' } }, { ...png, format: 'csv' }) === 'trees.zip', 'download names: the target\'s file, else the output\'s stem; a zip unless one file');
  check(pop.downloadSpec({ target: { format: 'obj', path: 'a/b.obj', options: { up_axis: 'z' } } }, 'obj').up_axis === 'z' && pop.downloadSpec({ target: { format: 'obj', path: 'a.obj', options: {} } }, 'glb') === 'glb',
    'a download in the target\'s format keeps its path and options; another format is the format alone');
  check(pop.filenameOf("attachment; filename*=UTF-8''terrain%20v2.zip") === 'terrain v2.zip' && pop.filenameOf(null) === null && pop.stemOf('pcg/trees.points.json') === 'trees' && pop.stemOf('level/') === 'level',
    'file names from the server\'s Content-Disposition, stems as the server names its zips');
  check(pop.inFolder('C:\\proj\\exports', 'parts/a.obj') === 'C:\\proj\\exports\\parts\\a.obj' && pop.inFolder('/home/p/exports/', 'a.glb') === '/home/p/exports/a.glb',
    'where an export goes, in the exports folder\'s own separators');
}

section('the page\'s modules');
{
  const app = path.join(root, 'src', 'viewer', 'app');
  const files = fs.readdirSync(app);
  const problems: string[] = [];
  for (const f of files.filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(app, f), 'utf8');
    for (const m of src.matchAll(/^\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm)) {
      const spec = m[1];
      if (spec.startsWith('./')) { if (!files.includes(spec.slice(2))) problems.push(`${f} imports missing ${spec}`); }
      else if (spec !== 'three' && !spec.startsWith('three/addons/')) problems.push(`${f} imports ${spec}`);
      else if (spec.startsWith('three/addons/') && !fs.existsSync(path.join(path.dirname(fileURLToPath(import.meta.resolve('three'))), '..', 'examples', 'jsm', spec.slice('three/addons/'.length))))
        problems.push(`${f} imports ${spec}, which three does not ship`);
    }
    // embed.js is the web app's embed page, not the editor: the one module allowed a model viewer's orbit camera
    if (f !== 'embed.js' && /OrbitControls\.js|new\s+OrbitControls/.test(src)) problems.push(`${f} uses OrbitControls (section 3: our own camera controller)`);
    if (f !== 'embed.js' && /from\s+['"]\.\/embed\.js['"]/.test(src)) problems.push(`${f} imports the embed page's module`);
  }
  const shell = fs.readFileSync(path.join(root, 'src', 'viewer', 'index.html'), 'utf8');
  check(!problems.length && files.includes('style.css') && /src="\/app\/main\.js"/.test(shell) && /href="\/app\/style\.css"/.test(shell) && !/<script(?![^>]*src)[^>]*>[^<]{200,}/.test(shell),
    `index.html is a shell loading /app/main.js and /app/style.css; modules import only each other and three (${problems.join('; ') || `${files.length} files`})`);
}

section('packed instances in the viewer: drawn where they are, framed where they are');
{
  // a source of a triangle with no material, a polyline and a loose point, packed twice far from the origin, loaded the
  // way the viewer loads /api/geo: three.js instances triangle meshes only, so a points or lines primitive in the
  // instanced mesh made it draw one copy at the origin and no instance, and frame all took in the origin
  const b = new GeoBuilder(new Geometry());
  b.addPrim([b.addPoint(0, 0, 0), b.addPoint(1, 0, 0), b.addPoint(1, 1, 0)], true);
  b.addPrim([b.addPoint(0, 2, 0), b.addPoint(0, 3, 0)], false);
  b.addPoint(0, 4, 0);
  const g = packedFromMatrices(b.build(), [m4translate(-834, 0, 2567), m4translate(-800, 0, 2600)]);
  const bytes = await previewGLB(g);
  const obj = new MeshObject('out', await parseGLB(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
  const inst = obj.parts.filter((p: any) => p.type === 'inst'), box = obj.bounds();
  check(inst.length === 1 && inst[0].obj.count === 2 && !obj.parts.some((p: any) => p.type === 'mesh'), `the triangle is one instanced mesh of 2 instances (parts: ${obj.parts.map((p: any) => p.type).join(', ')})`);
  check(!box.isEmpty() && box.min.x > -835 && box.max.x < -798 && box.min.z > 2566 && box.max.z < 2601 && !box.containsPoint(new THREE.Vector3()),
    `frame all's bounds hold the instances alone, far from the origin (${box.min.toArray().join(', ')} to ${box.max.toArray().join(', ')})`);
  const k = obj.parts.indexOf(inst[0]) >= 0 ? (obj.pieceCount(), inst[0].offset) : -1;
  const pb = [k, k + 1].map((i) => obj.bounds(i));
  check(k >= 0 && pb.every((x: any) => !x.isEmpty()) && pb[0].min.x > -835 && pb[0].max.x < -832 && pb[1].min.x > -801 && pb[1].max.x < -798,
    `frame selection: each picked instance has its own bounds at its place (${pb.map((x: any) => x.min.x).join(', ')})`);
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
