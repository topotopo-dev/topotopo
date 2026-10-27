// Renderer overlays: every option renders at the expected size, and pixel probes confirm each feature
// (edge overlays, section caps incl. inside-out, clip, glyphs, labels, legends, shading, views, footer).
//   node test/render.ts
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { Geometry } from '../src/core/geometry.ts';
import { parseViews, renderGeometry } from '../src/render/raster.ts';
import type { RenderOptions, RenderResult } from '../src/render/raster.ts';
import { renderArgs } from '../src/render/options.ts';
import { windingGrid } from '../src/render/section.ts';
import { LabelPlacer } from '../src/render/overlay.ts';
import type { GraphSpec } from '../src/graph/types.ts';

const engine = new Engine(createNodeHost());
await engine.init();
let fail = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) fail++; };
const cook = async (nodes: GraphSpec['nodes'], output = 'out') => {
  const r = await engine.cook({ nodes, output });
  if (!r.ok || !r.geo) throw new Error(`cook failed: ${r.errors.map((e) => `[${e.node}] ${e.message}`).join('; ')}`);
  return r.geo;
};
const render = (g: Geometry, o: RenderOptions) => renderGeometry(g, o);
type RGB = [number, number, number];
const px = (r: RenderResult, x: number, y: number): RGB => { const i = (y * r.width + x) * 4; return [r.rgba[i], r.rgba[i + 1], r.rgba[i + 2]]; };
const count = (r: RenderResult, pred: (c: RGB) => boolean, x0 = 0, y0 = 0, x1 = r.width, y1 = r.height) => {
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (pred(px(r, x, y))) n++;
  return n;
};
/** pixels where b differs from a by more than t (sum of channel differences) */
const diff = (a: RenderResult, b: RenderResult, t = 30, x0 = 0, y0 = 0, x1 = a.width, y1 = a.height) => {
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const p = px(a, x, y), q = px(b, x, y);
    if (Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) > t) n++;
  }
  return n;
};
const same = (a: RenderResult, b: RenderResult) => a.width === b.width && a.height === b.height && Buffer.compare(Buffer.from(a.rgba), Buffer.from(b.rgba)) === 0;
const isCut = ([r, g, b]: RGB) => r > 150 && r - g > 60 && r - b > 80 && g - b > 10; // not the grid's red axis
const isFlipCut = ([r, g, b]: RGB) => b > 140 && b - r > 80 && b - g > 50;
const isCyan = ([r, g, b]: RGB) => b > 190 && g > 190 && r < 150;
const isPink = ([r, g, b]: RGB) => r > 200 && g < 140 && b > 110;
const isYellow = ([r, g, b]: RGB) => r > 200 && g > 170 && b < 140;
const note = (r: RenderResult, re: RegExp) => r.notes.some((n) => re.test(n));
const T = 200, FOOT = 22, FOOT2 = 38; // tile size used below; footer height without / with the overlay line

const box = await cook({ out: { type: 'box' } });
const grid = await cook({ out: { type: 'grid', params: { size: [2, 2], divisions: [2, 2] } } });
const sphere = await cook({ s: { type: 'sphere', params: { type: 'ico', level: 2 } }, out: { type: 'normal', in: ['s'], params: { class: 'point' } } });

// ---------------------------------------------------------------- defaults untouched
{
  const a = render(box, { size: 160 });
  const b = render(box, { size: 160, views: 'quad' as any, wireframe: 'auto', shading: 'default', glyphs: 'none', scale: 1, clip: null, labelAttrib: null });
  check(same(a, b) && a.height === 2 * 160 + 2 + FOOT, `defaults: neutral values of the new options give the same bytes (${a.width}×${a.height})`);
  const c = render(box, { views: ['persp'], size: 160, wireframe: false }), d = render(box, { views: ['persp'], size: 160, wireframe: 'none' });
  check(same(c, d), 'wireframe "none" = wireframe false');
  check(!note(a, /overlays:/), 'no overlay footer line without overlay options');
}

// ---------------------------------------------------------------- views, presets, size, scale, ortho_scale, look_at
{
  const tt = render(box, { views: parseViews('turntable'), size: 150 });
  check(tt.width === 302 && tt.height === 302 + FOOT, `turntable: 4 persp tiles (${tt.width}×${tt.height})`);
  const v = parseViews('persp@90,section,quad_uv')!;
  check(v.join(' ') === 'persp@90 section persp uv', `parseViews expands presets inside lists (${v.join(' ')})`);
  let threw = '';
  try { parseViews('sideways'); } catch (e: any) { threw = e.message; }
  check(/unknown view "sideways"/.test(threw), `parseViews rejects unknown views: ${threw.slice(0, 60)}`);
  const s2 = render(box, { views: ['persp'], size: 150, scale: 2 });
  check(s2.width === 300 && s2.height === 300 + 2 * FOOT, `scale 2: 2× tile and footer (${s2.width}×${s2.height})`);
  const s2a = render(box, { views: ['persp'], size: 150, scale: 2, wireframe: 'all' });
  check(s2a.height === 300 + 2 * FOOT2, `scale 2 with an overlay: 2× two-line footer (${s2a.height})`);
  const isObj = (c: RGB) => c[0] > 120 && c[0] - c[2] > 8; // warm grey surface, not the blue-grey background
  const fit = render(box, { views: ['top'], size: T }), wide = render(box, { views: ['top'], size: T, orthoScale: 4 });
  const nf = count(fit, isObj, 0, 0, T, T), nw = count(wide, isObj, 0, 0, T, T);
  check(nf > 3 * nw && nw > 1000, `ortho_scale 4 shows the unit box ~${T / 4} px wide (${nf} → ${nw} pixels)`);
  const look = render(box, { views: ['top'], size: T, target: [0.5, 0, 0] });
  let sx = 0, n = 0;
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) if (isObj(px(look, x, y))) { sx += x; n++; }
  check(n > 0 && sx / n < T / 2 - 20, `look_at [0.5,0,0] moves the box left of centre (mean x ${(sx / n).toFixed(0)})`);
}

// ---------------------------------------------------------------- edge overlays
{
  const none = render(grid, { views: ['top'], size: T, wireframe: 'none' });
  const all = render(grid, { views: ['top'], size: T, wireframe: 'all' });
  check(all.height === T + FOOT2, `wireframe all: overlay footer line (${all.width}×${all.height})`);
  // the grid's middle edge x = 0 runs down the tile centre: darker there than without the overlay
  let darker = 0;
  for (let y = 30; y < T - 30; y++) for (const x of [T / 2 - 1, T / 2]) { const a = px(none, x, y), b = px(all, x, y); if (a[0] - b[0] > 25) darker++; }
  check(darker > 100, `wireframe all: dark 1 px line along the centre edge (${darker} pixels darker)`);
  let side = 0;
  for (let y = 30; y < T - 30; y++) { const a = px(none, T / 2 + 20, y), b = px(all, T / 2 + 20, y); if (a[0] - b[0] > 25) side++; }
  check(side < 5, `wireframe all: lines are crisp, nothing 20 px off the edge (${side})`);
  const hard = render(box, { views: ['persp'], size: T, wireframe: 'hard' });
  const smooth = render(sphere, { views: ['persp'], size: T, wireframe: 'hard' });
  const cyan = (r: RenderResult) => count(r, isCyan, 0, 40, T, T); // below the legend
  check(cyan(hard) > 150 && cyan(smooth) === 0, `wireframe hard: box edges cyan (${cyan(hard)} px), smooth sphere none (${cyan(smooth)})`);
  check(note(hard, /wire hard>30 12 edges/), `wireframe hard counts the 12 box edges: ${hard.notes.find((x) => x.startsWith('overlays'))}`);
  const crease = await cook({ b: { type: 'box' }, out: { type: 'group', in: ['b'], params: { class: 'edge', name: 'crease_main', pattern: 'p0-1' } } });
  const hc = render(crease, { views: ['persp'], size: T, wireframe: 'hard', hardAngle: 120 });
  check(note(hc, /0 edges \+ 1 crease group/), `wireframe hard: crease edge groups drawn above any angle (${hc.notes.find((x) => x.startsWith('overlays'))})`);
  const open = render(grid, { views: ['persp'], size: T, wireframe: 'boundary' });
  const closed = render(box, { views: ['persp'], size: T, wireframe: 'boundary' });
  check(count(open, isPink, 0, 40, T, T) > 100 && count(closed, isPink, 0, 40, T, T) === 0, `wireframe boundary: open grid border pink (${count(open, isPink, 0, 40, T, T)} px), closed box none`);
  check(note(open, /wire boundary 8 open/), 'wireframe boundary: 8 open edges on a 2×2 grid');
  const eg = await cook({ b: { type: 'box' }, out: { type: 'group', in: ['b'], params: { class: 'edge', name: 'seam', pattern: 'p2-3 p3-7' } } });
  const gplain = render(eg, { views: ['persp'], size: T, wireframe: 'none' }), groups = render(eg, { views: ['persp'], size: T, wireframe: 'groups' });
  check(diff(gplain, groups, 60, 0, 30, T, T) > 40 && note(groups, /wire edge groups \(1\)/), `wireframe groups: edge group drawn (${diff(gplain, groups, 60, 0, 30, T, T)} px) with legend`);
  const nog = render(box, { views: ['persp'], size: T, wireframe: 'groups' });
  check(note(nog, /no edge groups/), 'wireframe groups without edge groups: note');
  let bad = '';
  try { render(box, { wireframe: 'diagonal' as any }); } catch (e: any) { bad = e.message; }
  check(/unknown wireframe "diagonal"/.test(bad), `unknown wireframe mode rejected: ${bad.slice(0, 50)}`);
}

// ---------------------------------------------------------------- points by pscale, point / prim numbers
{
  const pts = (ps: number) => {
    const g = new Geometry({ positions: [0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 1] });
    (g.points.add('pscale', 'float', 1).data as Float64Array).fill(ps);
    return g;
  };
  const small = render(pts(0.05), { views: ['top'], size: T, points: true }), big = render(pts(0.2), { views: ['top'], size: T, points: true });
  check(count(big, isYellow) > 3 * count(small, isYellow) && count(small, isYellow) > 20, `points: true sizes markers by pscale (${count(small, isYellow)} → ${count(big, isYellow)} px)`);
  const plain = render(box, { views: ['persp'], size: T });
  const nums = render(box, { views: ['persp'], size: T, pointNumbers: true });
  check(count(nums, isYellow, 0, 24) > 40 && count(plain, isYellow, 0, 24) === 0, `point numbers: yellow labels drawn (${count(nums, isYellow, 0, 24)} px)`);
  const few = render(box, { views: ['persp'], size: T, pointNumbers: true, maxLabels: 3 });
  check(note(few, /point numbers: first 3 of 8 points/) && count(few, isYellow, 0, 24) < count(nums, isYellow, 0, 24), 'max_labels caps point numbers with a note');
  const isLightCyan = ([r, g, b]: RGB) => b > 200 && g > 190 && r > 100 && r < 175;
  const prims = render(box, { views: ['persp'], size: T, primNumbers: true });
  check(count(prims, isLightCyan, 0, 24) > 30, `prim numbers: labels at visible prim centroids (${count(prims, isLightCyan, 0, 24)} px)`);
}

// ---------------------------------------------------------------- section view and clip
{
  const sec = render(box, { views: ['section'], size: T });
  check(sec.width === T && sec.height === T + FOOT2, `section view: ${sec.width}×${sec.height}`);
  check(isCut(px(sec, T / 2, T / 2)), `section: solid box cut colour at the centre ${px(sec, T / 2, T / 2)}`);
  const hollow = await cook({ o: { type: 'box', params: { size: [2, 2, 2] } }, i0: { type: 'box', params: { size: [1.6, 1.6, 1.6] } }, i: { type: 'reverse', in: ['i0'] }, out: { type: 'merge', in: ['o', 'i'] } });
  const hs = render(hollow, { views: ['section'], size: T });
  // section y looks down like the top view: 0.86 × 100 px per unit, the wall spans x 0.8 .. 1.0
  check(!isCut(px(hs, T / 2, T / 2)) && isCut(px(hs, Math.round(T / 2 + 0.9 * 86), T / 2)), `section: hollow box keeps the cavity empty ${px(hs, T / 2, T / 2)} and fills the wall ${px(hs, Math.round(T / 2 + 0.9 * 86), T / 2)}`);
  const inv = await cook({ b: { type: 'box' }, out: { type: 'reverse', in: ['b'] } });
  const is = render(inv, { views: ['section'], size: T });
  check(isFlipCut(px(is, T / 2, T / 2)) && note(is, /inside-out/), `section: inside-out box cut in blue ${px(is, T / 2, T / 2)} with a note`);
  const zsec = render(box, { views: ['section'], size: T, sectionAxis: 'z', sectionOffset: 0.9 });
  check(isCut(px(zsec, T / 2, T / 2)) && note(zsec, /section z=0\.40/), 'section_axis z, section_offset 0.9 → plane z = 0.40');
  const miss = render(box, { views: ['section'], size: T, sectionOffset: 3, sectionAbsolute: true });
  check(!isCut(px(miss, T / 2, T / 2)) && note(miss, /section y=3\.00/), 'section_absolute: plane outside the bbox cuts nothing');
  const pipe = await cook({ out: { type: 'tube', params: { caps: false, height: 2 } } });
  const ps = render(pipe, { views: ['section'], size: T });
  check(!isCut(px(ps, T / 2, T / 2)) && count(ps, isYellow, 0, 24) > 60, `section: open sheet cut drawn as a yellow outline (${count(ps, isYellow, 0, 24)} px), not filled`);
  const two = render(box, { views: ['persp', 'section'], size: T });
  check(two.width === 2 * T + 2 && count(two, isCut, T + 2, 24, 2 * T + 2, T) > 3000 && count(two, isCut, 0, 40, T, T) === 0, 'views persp + section: cut only in the section tile');
  const clip = render(box, { views: ['persp'], size: T, clip: { axis: 'x', offset: 0.5 } });
  const nocap = render(box, { views: ['persp'], size: T, clip: { axis: 'x', offset: 0.5, cap: false } });
  const isBack = ([r, g, b]: RGB) => b - r > 40 && b > 110;
  check(count(clip, isCut) > 1500 && count(nocap, isCut) === 0, `clip: cut capped red (${count(clip, isCut)} px), cap:false leaves it open`);
  check(count(nocap, isBack) > 800, `clip cap:false: the inside shows back faces in blue (${count(nocap, isBack)} px)`);
  const fullBox = render(box, { views: ['persp'], size: T });
  const isSurf = (c: RGB) => c[0] > 100 && c[0] - c[2] > 5;
  check(count(clip, isSurf) < count(fullBox, isSurf), 'clip removes the camera side of the box');
  let ax = '';
  try { render(box, { clip: { axis: 'w' as any } }); } catch (e: any) { ax = e.message; }
  check(/unknown clip axis/.test(ax), 'unknown clip axis rejected');
}

// ---------------------------------------------------------------- glyphs
{
  const plain = render(sphere, { views: ['top'], size: T });
  const n = render(sphere, { views: ['top'], size: T, glyphs: 'N', glyphScale: 0.5 });
  // top view: unit sphere radius ≈ 86 px; normals of the rim stick out to ~1.4 → glyph pixels in the ring 1.1R .. 1.4R
  let ring = 0;
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
    const d = Math.hypot(x + 0.5 - T / 2, y + 0.5 - T / 2) / 86;
    if (d > 1.1 && d < 1.4) { const a = px(plain, x, y), b = px(n, x, y); if (Math.abs(a[2] - b[2]) + Math.abs(a[0] - b[0]) > 40) ring++; }
  }
  check(ring > 40, `glyphs N: normals stick out of the silhouette (${ring} px in the ring)`);
  check(note(n, /glyphs n 162\/162/), `glyphs N: one per point: ${n.notes.find((x) => x.startsWith('overlays'))}`);
  const sub = render(sphere, { views: ['top'], size: T, glyphs: 'N', maxGlyphs: 40 });
  check(note(sub, /40 of 162 points shown/), 'max_glyphs subsamples with a note');
  const nofn = render(box, { views: ['persp'], size: T, glyphs: 'N' });
  check(note(nofn, /computed face normals/), 'glyphs N without N: computed face normals');
  const v = await cook({ g: { type: 'grid', params: { size: [2, 2], divisions: [4, 4] } }, out: { type: 'wrangle', in: ['g'], params: { code: '@v = [@P.x * 3, 0, 0]; @orient = [0, 0.3826834, 0, 0.9238795];' } } });
  const vr = render(v, { views: ['top'], size: T, glyphs: 'v' });
  check(note(vr, /glyphs v 25\/25/) && diff(render(v, { views: ['top'], size: T }), vr, 40, 0, 40) > 30, 'glyphs v: drawn, scaled by magnitude');
  const orient = render(v, { views: ['top'], size: T, glyphs: 'orient' });
  const isRed = ([r, g, b]: RGB) => r > 180 && g < 110 && b < 110;
  const isBlue = ([r, g, b]: RGB) => b > 200 && r < 120 && g < 160;
  check(count(orient, isRed, 0, 24) > 10 && count(orient, isBlue, 0, 24) > 10, `glyphs orient: red X and blue Z axes (${count(orient, isRed, 0, 24)}, ${count(orient, isBlue, 0, 24)} px)`);
  const custom = render(v, { views: ['top'], size: T, glyphAttrib: 'v' });
  check(note(custom, /glyphs v/), 'glyph_attrib alone implies glyphs "custom"');
  const missing = render(v, { views: ['top'], size: T, glyphs: 'up' });
  check(note(missing, /no attribute "up"/), 'glyphs on a missing attribute: note');
}

// ---------------------------------------------------------------- labels and legends
{
  const g = await cook({ b: { type: 'box', params: { divisions: [2, 2, 2] } }, t: { type: 'group', in: ['b'], params: { name: 'lid', normal: [0, 1, 0], spread_angle: 10 } }, out: { type: 'group', in: ['t'], params: { name: 'corner', class: 'point', pattern: '0' } } });
  const plain = render(g, { views: ['persp'], size: T });
  const lab = render(g, { views: ['persp'], size: T, labelGroups: true });
  check(note(lab, /labels groups \(2\)/), 'label_groups: both groups labelled');
  // legend box: translucent dark panel in the top-right corner
  const dark = count(lab, ([r, gg, b]) => r < 45 && gg < 45 && b < 50, T - 70, 4, T - 4, 30);
  check(dark > 300, `label_groups: legend panel in the top-right corner (${dark} dark px)`);
  check(diff(plain, lab, 60, 0, 40, T, T) > 150, `label_groups: names, borders and points drawn (${diff(plain, lab, 60, 0, 40, T, T)} px)`);
  const nog = render(box, { views: ['persp'], size: T, labelGroups: true });
  check(note(nog, /no point or prim groups/), 'label_groups without groups: note');
  const twoBoxes = await cook({ a: { type: 'box', params: { center: [-2, 0, 0] } }, b: { type: 'box', params: { center: [2, 0, 0] } }, out: { type: 'merge', in: ['a', 'b'] } });
  const p0 = render(twoBoxes, { views: ['front'], size: T }), p1 = render(twoBoxes, { views: ['front'], size: T, labelPieces: true });
  check(diff(p0, p1, 60, 0, 24, T / 2, T) > 20 && diff(p0, p1, 60, T / 2, 24, T, T) > 20 && note(p1, /labels pieces \(2\)/), 'label_pieces: a number on each of the two pieces');
  const named = await cook({ g: { type: 'grid', params: { size: [2, 2], divisions: [4, 4] } }, out: { type: 'wrangle', in: ['g'], params: { run_over: 'prims', code: '@name = @P.x > 0 ? "east" : "west";' } } });
  const la = render(named, { views: ['top'], size: T, labelAttrib: 'name' });
  check(note(la, /labels name \(2\)/) && diff(render(named, { views: ['top'], size: T }), la, 60, 0, 24) > 60, 'label_attrib name: one label per distinct value');
  const lbad = render(named, { views: ['top'], size: T, labelAttrib: 'P' });
  check(note(lbad, /use a string or int attribute/), 'label_attrib on a float vector: note');
  // overlapping labels are skipped, never drawn on top of each other
  const crowd = render(sphere, { views: ['persp'], size: 128, pointNumbers: true });
  check(note(crowd, /labels: \d+ not drawn to avoid overlaps/), `crowded point numbers: skipped with a note (${crowd.notes.find((x) => x.startsWith('labels'))})`);
  // colour legend: gradient bar (viridis purple → yellow) for a numeric color_by
  const h = await cook({ g: { type: 'grid', params: { size: [2, 2], divisions: [8, 8] } }, out: { type: 'wrangle', in: ['g'], params: { code: '@height = @P.x;' } } });
  const leg = render(h, { views: ['top'], size: T, colorBy: 'height', legend: true, zoom: 0.5 });
  const purple = count(leg, ([r, gg, b]) => r < 110 && gg < 60 && b > 60, T - 130, 4, T - 4, 40);
  const yellow = count(leg, ([r, gg, b]) => r > 190 && gg > 180 && b < 90, T - 130, 4, T - 4, 40);
  check(purple > 3 && yellow > 3, `legend: gradient bar from purple (${purple} px) to yellow (${yellow} px)`);
  const noLeg = render(h, { views: ['top'], size: T, colorBy: 'height', zoom: 0.5 });
  check(count(noLeg, ([r, gg, b]) => r > 190 && gg > 180 && b < 90, T - 130, 4, T - 4, 40) === 0, 'no legend without legend:true');
  const cat = render(named, { views: ['top'], size: T, colorBy: 'name', legend: true, zoom: 0.5 });
  check(count(cat, ([r, gg, b]) => r < 45 && gg < 45 && b < 50, T - 80, 4, T - 4, 30) > 200, 'legend: categorical swatches for a string color_by');
}

// ---------------------------------------------------------------- shading
{
  const base = render(sphere, { views: ['persp'], size: T });
  const flat = render(sphere, { views: ['persp'], size: T, shading: 'flat' });
  const mat = render(sphere, { views: ['persp'], size: T, shading: 'matcap' });
  check(diff(base, flat, 12, 0, 24) > 500 && diff(base, mat, 12, 0, 24) > 500, `flat (${diff(base, flat, 12, 0, 24)} px) and matcap (${diff(base, mat, 12, 0, 24)} px) shade differently`);
  // flat: neighbouring pixels inside one facet are identical, smooth shading varies
  let flatSame = 0, smoothSame = 0;
  for (let x = 80; x < 120; x++) { if (px(flat, x, 100).join() === px(flat, x + 1, 100).join()) flatSame++; if (px(base, x, 100).join() === px(base, x + 1, 100).join()) smoothSame++; }
  check(flatSame > smoothSame, `flat shading: constant within facets (${flatSame} vs ${smoothSame} equal neighbours)`);
  const L = await cook({ f: { type: 'box', params: { size: [2, 0.2, 2], center: [0, 0.1, 0] } }, w: { type: 'box', params: { size: [0.2, 1.2, 2], center: [-0.9, 0.6, 0] } }, out: { type: 'merge', in: ['f', 'w'] } });
  const plainL = render(L, { views: ['persp'], size: T }), ao = render(L, { views: ['persp'], size: T, shading: 'ao' });
  let darker = 0, brighter = 0;
  for (let y = 24; y < T; y++) for (let x = 0; x < T; x++) { const a = px(plainL, x, y), b = px(ao, x, y); if (a[0] - b[0] > 12) darker++; if (b[0] - a[0] > 2) brighter++; }
  check(darker > 150 && brighter === 0, `ao: darkens the inner corner of an L (${darker} px darker, ${brighter} brighter)`);
  let sh = '';
  try { render(box, { shading: 'toon' as any }); } catch (e: any) { sh = e.message; }
  check(/unknown shading/.test(sh), 'unknown shading rejected');
}

// ---------------------------------------------------------------- footer and notes
{
  const r = render(box, { views: ['persp'], size: T, wireframe: 'hard' });
  const line2 = count(r, ([rr, g, b]) => b > 150 && b > rr + 30, 0, T + FOOT, T, T + FOOT2);
  check(line2 > 30, `footer line 2 names the overlays (${line2} text px): ${r.notes.find((x) => x.startsWith('overlays'))}`);
  check(note(r, /1 piece {2}· {2}no open edges/), 'footer notes pieces and open edges');
  const flipped = await cook({ s: { type: 'sphere', params: { type: 'ico', level: 2 } }, out: { type: 'reverse', in: ['s'] } });
  const fr = render(flipped, { views: ['persp'], size: T, annotate: true });
  check(note(fr, /back faces of closed pieces/) && note(fr, /back-facing \d+\.\d% of pixels/), 'annotate: back-facing pixels of a flipped sphere reported');
  const off = render(box, { views: ['persp'], size: T, wireframe: 'hard', annotate: false });
  check(off.height === T + FOOT, 'annotate:false drops the second footer line');
  // view_labels:false: no view label (top left) and no axis gizmo (bottom left); everything else is the same
  const on = render(box, { views: ['persp'], size: T, shading: 'matcap' });
  const nl = render(box, { ...renderArgs({ views: 'persp', size: T, shading: 'matcap', view_labels: false }) });
  const white = ([rr, g, b]: RGB) => rr > 240 && g > 240 && b > 240;
  check(count(on, white, 0, 0, T, 24) > 30 && count(nl, white, 0, 0, T, 24) === 0, `view_labels:false hides the view label (${count(on, white, 0, 0, T, 24)} → ${count(nl, white, 0, 0, T, 24)} white px)`);
  check(diff(on, nl, 30, 0, T - 64, 64, T) > 20 && diff(on, nl, 30, 0, 24, T, T - 64) === 0 && diff(on, nl, 30, 64, T - 64, T, T) === 0,
    'view_labels:false hides the axis gizmo and leaves the rest of the tile unchanged');
  const quadNl = render(box, { size: 160, viewLabels: false });
  check(quadNl.width === 2 * 160 + 2 && quadNl.height === 2 * 160 + 2 + FOOT && count(quadNl, white, 162, 0, 322, 20) === 0, 'view_labels:false on the quad view: same size, no ortho view labels');
}

// ---------------------------------------------------------------- helpers: tool arguments, winding fill, label placement
{
  const o = renderArgs({ views: 'turntable', section: 'z:0.25', wireframe: 'hard', hard_angle: '40', labels: 'groups,pieces,points,attrib:name', look_at: '1,2,3', clip: 'x:2:abs', shading: 'ao' });
  check(o.views?.length === 5 && o.views[4] === 'section' && o.sectionAxis === 'z' && o.sectionOffset === 0.25 && o.hardAngle === 40, 'renderArgs: section shorthand adds the section view');
  check(!!(o.labelGroups && o.labelPieces && o.pointNumbers && o.labelAttrib === 'name' && o.target?.join() === '1,2,3' && o.clip?.absolute && o.clip.offset === 2), 'renderArgs: labels, look_at and clip shorthands');
  let e1 = '';
  try { renderArgs({ section_axis: 'w' }); } catch (e: any) { e1 = e.message; }
  check(/section_axis expects/.test(e1), 'renderArgs: bad axis rejected');
  let e2 = '';
  try { renderArgs({ heightfield_res: 0 }); } catch (e: any) { e2 = e.message; }
  check(renderArgs({ heightfield_res: 'full' }).heightfieldRes === Infinity && renderArgs({ heightfield_res: '512' }).heightfieldRes === 512 && renderArgs({}).heightfieldRes === undefined
    && /heightfield_res expects quads per side/.test(e2), 'renderArgs: heightfield_res takes quads per side or "full"');
  // winding: a CCW square fills +1, a CW one -1, a CCW square with a CW hole leaves the hole empty
  const sq = (x0: number, y0: number, x1: number, y1: number, ccw: boolean) => {
    const p = ccw ? [x0, y0, x1, y0, x1, y1, x0, y1] : [x0, y0, x0, y1, x1, y1, x1, y0];
    const s: number[] = [];
    for (let i = 0; i < 4; i++) s.push(p[i * 2], p[i * 2 + 1], p[((i + 1) % 4) * 2], p[((i + 1) % 4) * 2 + 1]);
    return s;
  };
  const g1 = windingGrid(Float64Array.from(sq(2, 2, 17, 17, true)), 4, 20, 20);
  const g2 = windingGrid(Float64Array.from(sq(2, 2, 17, 17, false)), 4, 20, 20);
  const g3 = windingGrid(Float64Array.from([...sq(2, 2, 17, 17, true), ...sq(7, 7, 12, 12, false)]), 8, 20, 20);
  check(g1[10 * 20 + 10] === 1 && g1[0] === 0 && g2[10 * 20 + 10] === -1, 'windingGrid: CCW +1 inside, CW -1, outside 0');
  check(g3[10 * 20 + 10] === 0 && g3[4 * 20 + 4] === 1, 'windingGrid: a reversed inner loop leaves a hole');
  const pl = new LabelPlacer(200, 200);
  const rects: number[][] = [];
  for (let i = 0; i < 60; i++) { const s = pl.find(100, 100, 30, 12, 3); if (s) { pl.reserve(s.x, s.y, s.x + 30, s.y + 12); rects.push([s.x, s.y, s.x + 30, s.y + 12]); } }
  let overlaps = 0;
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) { const a = rects[i], b = rects[j]; if (a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]) overlaps++; }
  check(rects.length >= 20 && rects.length < 60 && overlaps === 0, `LabelPlacer: ${rects.length} of 60 labels around one anchor placed without overlap`);
}

console.log(fail ? `\n${fail} render check(s) failed` : '\nrender: all checks passed');
process.exit(fail ? 1 : 0);
