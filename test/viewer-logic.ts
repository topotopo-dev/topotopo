// The viewer page's browser-free logic (src/viewer/app/*.js, docs/design/viewer.md section 10): the keymap presets,
// guide (marker) rules shared with the server, the grid step, selection set operations, the undo stack, mesh
// topology (welding, pieces, the render tool's edge classes), the Controls rules and the status line. Also checks
// that the page's modules only import each other and the served three.js.
//   node test/viewer-logic.ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../src/nodes/index.ts';
import { markersGeometry, MARKER_KINDS as SERVER_KINDS } from '../src/viewer/server.ts';
import * as km from '../src/viewer/app/keymap.js';
import * as mk from '../src/viewer/app/markers.js';
import * as units from '../src/viewer/app/units.js';
import * as sel from '../src/viewer/app/selection.js';
import { createUndo } from '../src/viewer/app/undo.js';
import * as mesh from '../src/viewer/app/mesh.js';
import * as vars from '../src/viewer/app/vars.js';
import * as status from '../src/viewer/app/status.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0, passes = 0;
const check = (cond: any, msg: string) => {
  if (cond) passes++;
  else failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`);
};
const section = (s: string) => console.log(`\n== ${s}`);
const throws = (f: () => unknown) => { try { f(); return null; } catch (e: any) { return e; } };

section('keymap presets (section 9)');
{
  check(km.PRESETS.map((p: any) => p.id).join() === 'topotopo,maya,houdini,blender' && km.DEFAULT_PRESET === 'topotopo', 'four presets, TopoTopo the default');
  const ids = km.PRESETS.map((p: any) => p.id);
  check(km.ROWS.length === 22 && km.ROWS.every((r: any) => ids.every((p: string) => typeof r[p]?.[0] === 'string' && r[p][0].length > 0)),
    `every row of the table has binding text in every preset (${km.ROWS.length} rows)`);
  const later = km.ROWS.filter((r: any) => r.phase === 2);
  check(later.map((r: any) => r.label).join(' | ') === 'move / rotate / scale | snap to grid (held) | snap to surface or curve (held) | snap to point (held) | snapping on / off'
    && later.every((r: any) => ids.every((p: string) => r[p].length === 1)), 'transform and snapping rows ship their text and no bindings (phase 2)');
  // no chord means two things in one preset, and every bound action exists
  const clashes: string[] = [], unknown: string[] = [];
  for (const p of ids) {
    const seen = new Map<string, string>();
    for (const r of km.ROWS as any[]) {
      const b = r[p][1];
      if (!b) continue;
      for (const kind of ['keys', 'drag']) for (const [c, a] of Object.entries(b[kind] ?? {}) as [string, string][]) {
        const k = `${kind}:${km.canonical(c)}`;
        if (seen.has(k) && seen.get(k) !== a) clashes.push(`${p} ${k}: ${seen.get(k)} / ${a}`);
        seen.set(k, a);
        if (!km.ACTIONS.includes(a)) unknown.push(`${p} ${c} → ${a}`);
      }
    }
  }
  check(!clashes.length && !unknown.length, `no chord is bound twice in a preset, every action is known (${[...clashes, ...unknown].join('; ') || 'ok'})`);
  const ev = (key: string, code: string, mods: Record<string, boolean> = {}) => ({ key, code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });
  const m = (p: string, e: any, space = false) => km.matchKey(p, e, space);
  check(m('maya', ev('f', 'KeyF')) === 'frameSelection' && m('maya', ev('a', 'KeyA')) === 'frameAll' && m('maya', ev(' ', 'Space')) === 'quad'
    && m('maya', ev('2', 'Digit2', { altKey: true })) === 'viewTop' && m('maya', ev('o', 'KeyO')) === 'ortho' && m('maya', ev('q', 'KeyQ')) === 'selectMode',
    'Maya: F, A, Space tap, Alt+2, O, Q');
  check(m('maya', ev('4', 'Digit4')) === 'displayWire' && m('maya', ev('6', 'Digit6')) === 'displayShadedWire' && m('maya', ev('z', 'KeyZ')) === 'undo'
    && m('maya', ev('Z', 'KeyZ', { shiftKey: true })) === 'redo' && m('maya', ev('y', 'KeyY', { ctrlKey: true })) === 'redo' && m('maya', ev('H', 'KeyH', { shiftKey: true })) === 'showAll',
    'Maya: 4 / 6 display, Z / Shift+Z / Ctrl+Y undo and redo, Shift+H shows all');
  check(m('maya', ev('w', 'KeyW')) === null && m('maya', ev('x', 'KeyX')) === null && m('houdini', ev('t', 'KeyT')) === null && m('blender', ev('g', 'KeyG')) === null,
    'transform and snap keys stay unbound (W, X in Maya, T in Houdini, G in Blender)');
  check(m('houdini', ev('g', 'KeyG'), true) === 'frameSelection' && m('houdini', ev('h', 'KeyH'), true) === 'frameAll' && m('houdini', ev('h', 'KeyH')) === 'hide'
    && m('houdini', ev('b', 'KeyB'), true) === 'quad' && m('houdini', ev('3', 'Digit3'), true) === 'viewFront' && m('houdini', ev(' ', 'Space')) === null
    && m('houdini', ev('s', 'KeyS')) === 'selectMode' && m('houdini', ev('w', 'KeyW')) === 'displayCycle',
    'Houdini: Space+G / Space+H / Space+B / Space+3, H alone hides, a Space tap does nothing, S selects, W cycles display');
  check(m('blender', ev('Delete', 'NumpadDecimal')) === 'frameSelection' && m('blender', ev('.', 'NumpadDecimal')) === 'frameSelection' && m('blender', ev('Home', 'Home')) === 'frameAll'
    && m('blender', ev('Home', 'Numpad7')) === 'viewTop' && m('blender', ev('1', 'Numpad1')) === 'viewFront' && m('blender', ev('5', 'Numpad5')) === 'ortho'
    && m('blender', ev('q', 'KeyQ', { ctrlKey: true, altKey: true })) === 'quad' && m('blender', ev('x', 'KeyX')) === 'delete' && m('blender', ev('h', 'KeyH', { altKey: true })) === 'showAll'
    && m('blender', ev('z', 'KeyZ', { ctrlKey: true, shiftKey: true })) === 'redo' && m('blender', ev('Z', 'KeyZ', { shiftKey: true })) === 'wireToggle',
    'Blender: numpad keys by position (NumLock on or off), Home, Ctrl+Alt+Q, X deletes, Alt+H, Ctrl+Shift+Z, Shift+Z');
  const shift1 = ev('!', 'Digit1', { shiftKey: true }), shift4 = ev('$', 'Digit4', { shiftKey: true });
  check(ids.every((p: string) => m(p, shift1) === 'placeNull' && m(p, shift4) === 'placeVolume' && m(p, ev('?', 'Slash', { shiftKey: true })) === 'overlay'
    && m(p, ev('Enter', 'Enter')) === 'finish' && m(p, ev('Backspace', 'Backspace')) === 'removeLast' && m(p, ev('Escape', 'Escape')) === 'cancel'),
    'every preset: Shift+1..4 place guides, ? opens the overlay, Enter / Backspace / Esc for curves');
  check(m('maya', ev('й', 'KeyQ')) === 'selectMode' && m('maya', ev('F', 'KeyF', { shiftKey: true })) === null, 'letters fall back to the physical key on other alphabets; Shift+F is not F');
  check(m('maya', ev('/', 'Slash', { shiftKey: true })) === 'overlay' && m('maya', ev('/', 'Slash')) === null, 'Shift with the "/" key opens the overlay even when the event names only the key');
  const d = (p: string, o: any) => km.matchDrag(p, o);
  check(d('maya', { button: 0, altKey: true }) === 'tumble' && d('maya', { button: 1, altKey: true }) === 'track' && d('maya', { button: 2, altKey: true }) === 'dolly' && d('maya', { button: 0 }) === null
    && d('houdini', { button: 0, space: true }) === 'tumble' && d('houdini', { button: 0, altKey: true }) === null
    && d('blender', { button: 1 }) === 'tumble' && d('blender', { button: 1, shiftKey: true }) === 'track' && d('blender', { button: 1, ctrlKey: true }) === 'dolly' && d('blender', { button: 0 }) === null,
    'drags: Alt + L / M / R (Maya), Space + L (Houdini), M, Shift + M, Ctrl + M (Blender); a plain left drag navigates nowhere');
  check(km.spaceIsModifier('houdini') && !km.spaceIsModifier('maya') && !km.spaceIsModifier('blender'), 'Space is a held modifier only in Houdini');
  check(km.overlayRows('blender').length === km.ROWS.length && km.overlayRows('blender').find((r: any) => r.label === 'frame all')?.text === 'Home'
    && km.overlayRows('maya').filter((r: any) => !r.built).length === 5, 'the overlay lists the active preset\'s whole table, the phase 2 rows marked');
  check(km.canonical('shift+ctrl+z') === 'Ctrl+Shift+Z' && !!throws(() => km.canonical('Hyper+A')), 'chords have one spelling; unknown modifiers are refused');
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
  check(vars.snapTo({ lo: 0.1, step: 0.01 } as any, 0.12345) === 0.12 && vars.blank({ type: 'vec3' }).join() === '0,0,0' && vars.controlList({ s: {} }, { s: 1, extra: 2 }).other.join() === 'extra',
    'snapping to steps, blank vectors, undeclared vars listed apart');
}

section('status line (section 4)');
{
  check(status.graphsLine('', 0) === status.NO_GRAPHS_LINE && status.graphsLine(status.LIVE_LINE, 0) === status.NO_GRAPHS_LINE,
    'no graph: the hint, whatever was shown');
  check(status.graphsLine(status.NO_GRAPHS_LINE, 1) === status.LIVE_LINE, 'the first graph replaces the hint with the live line');
  check(status.graphsLine(status.LIVE_LINE, 3) === null && status.graphsLine('undid guide', 2) === null && status.graphsLine('keymap: Maya (? shows it)', 1) === null,
    'with graphs, any other line stays');
  check(status.connectedLine(0) === status.NO_GRAPHS_LINE && status.connectedLine(2) === status.LIVE_LINE,
    'connecting shows the hint without graphs and the live line with them');
  // startup runs the graph fetch and the stream's open in either order; both orders end on the same line
  const ends = (n: number) => {
    const fetchFirst = status.connectedLine(n), openFirst = status.graphsLine(status.connectedLine(0), n) ?? status.connectedLine(0);
    return [fetchFirst, openFirst];
  };
  check(ends(0).every((l) => l === status.NO_GRAPHS_LINE) && ends(1).every((l) => l === status.LIVE_LINE), 'either startup order ends on the line that fits the workspace');
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
    // embed.js is the gallery's embed page, not the editor: the one module allowed a model viewer's orbit camera
    if (f !== 'embed.js' && /OrbitControls\.js|new\s+OrbitControls/.test(src)) problems.push(`${f} uses OrbitControls (section 3: our own camera controller)`);
    if (f !== 'embed.js' && /from\s+['"]\.\/embed\.js['"]/.test(src)) problems.push(`${f} imports the embed page's module`);
  }
  const shell = fs.readFileSync(path.join(root, 'src', 'viewer', 'index.html'), 'utf8');
  check(!problems.length && files.includes('style.css') && /src="\/app\/main\.js"/.test(shell) && /href="\/app\/style\.css"/.test(shell) && !/<script(?![^>]*src)[^>]*>[^<]{200,}/.test(shell),
    `index.html is a shell loading /app/main.js and /app/style.css; modules import only each other and three (${problems.join('; ') || `${files.length} files`})`);
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
