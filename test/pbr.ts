// PBR preview (render shading "pbr"): each material input changes the response it should and nothing else, maps match
// their factors, unlit / emissive / exposure, honest notes for what is not evaluated, external PNG textures, and
// byte-identical repeats.
//   node test/pbr.ts
import '../src/nodes/index.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { renderGeometry, renderGeometryAsync } from '../src/render/raster.ts';
import type { RenderOptions, RenderResult } from '../src/render/raster.ts';
import { encodePNG } from '../src/render/png.ts';
import { Image } from '../src/core/image.ts';
import { normalizeMaterial, writeMaterials } from '../src/core/materials.ts';
import { Geometry } from '../src/core/geometry.ts';
import { renderArgs } from '../src/render/options.ts';

const engine = new Engine(createNodeHost());
await engine.init();

let fail = 0, pass = 0;
const check = (ok: unknown, msg: string) => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
};

const sphere = (await engine.cook({ nodes: { s: { type: 'sphere', params: { rows: 32, cols: 48, radius: 1 } }, uv: { type: 'uv_project', in: ['s'], params: { method: 'spherical' } } }, output: 'uv' })).geo!;
if (!sphere.findAttrib('uv', ['vertex', 'point'])) throw new Error('fixture sphere has no uv');
/** The sphere with one material (and image volumes for "image:<name>" maps). */
function withMaterial(m: Record<string, any>, images: Image[] = [], g: Geometry = sphere): Geometry {
  const out = g.clone();
  const a = out.prims.add('material', 'string', 1);
  for (let p = 0; p < out.numPrims; p++) a.set(p, 'm');
  writeMaterials(out, { m: normalizeMaterial(m) });
  out.volumes = [...out.volumes, ...images];
  return out;
}
const constImage = (name: string, rgba: number[], n = 8) => new Image(n, n, name).set('C', Float32Array.from({ length: n * n * 4 }, (_, i) => rgba[i % 4]));
const OPTS: RenderOptions = { views: ['front'], shading: 'pbr', size: 160, grid: false, viewLabels: false, annotate: false, wireframe: false };
const shot = (g: Geometry, o: RenderOptions = {}) => renderGeometryAsync(g, { ...OPTS, ...o });
/** Luminance stats over the pixels that differ from the empty background render. */
const bg = await shot(new Geometry());
function stats(r: RenderResult) {
  let n = 0, sum = 0, max = 0, maxAt = 0, r0 = 0, g0 = 0;
  for (let i = 0; i < r.rgba.length; i += 4) {
    if (r.rgba[i] === bg.rgba[i] && r.rgba[i + 1] === bg.rgba[i + 1] && r.rgba[i + 2] === bg.rgba[i + 2]) continue;
    const l = 0.2126 * r.rgba[i] + 0.7152 * r.rgba[i + 1] + 0.0722 * r.rgba[i + 2];
    n++; sum += l; r0 += r.rgba[i]; g0 += r.rgba[i + 1];
    if (l > max) { max = l; maxAt = i; }
  }
  return { n, mean: sum / Math.max(1, n), max, peak: [r.rgba[maxAt], r.rgba[maxAt + 1], r.rgba[maxAt + 2]], tint: g0 / Math.max(1, r0) };
}
/**
 * G/R of the brightest 5% of the sphere's pixels inside 70% of its screen radius: the key light's specular response
 * (the silhouette is left out: there every material turns white by Fresnel at grazing angles).
 */
function highlightTint(r: RenderResult) {
  const obj: number[] = [];
  for (let i = 0; i < r.rgba.length; i += 4) if (r.rgba[i] !== bg.rgba[i] || r.rgba[i + 1] !== bg.rgba[i + 1] || r.rgba[i + 2] !== bg.rgba[i + 2]) obj.push(i);
  let cx = 0, cy = 0;
  for (const i of obj) { cx += (i / 4) % r.width; cy += Math.floor(i / 4 / r.width); }
  cx /= obj.length; cy /= obj.length;
  const rad = Math.sqrt(obj.length / Math.PI);
  const px: number[][] = [];
  for (const i of obj) if (Math.hypot((i / 4) % r.width - cx, Math.floor(i / 4 / r.width) - cy) < 0.7 * rad) px.push([r.rgba[i], r.rgba[i + 1], 0.2126 * r.rgba[i] + 0.7152 * r.rgba[i + 1] + 0.0722 * r.rgba[i + 2]]);
  px.sort((a, b) => b[2] - a[2]);
  const top = px.slice(0, Math.max(1, Math.floor(px.length * 0.05)));
  return top.reduce((t, p) => t + p[1], 0) / top.reduce((t, p) => t + p[0], 0);
}
const maxDiff = (a: RenderResult, b: RenderResult) => { let d = 0; for (let i = 0; i < a.rgba.length; i++) d = Math.max(d, Math.abs(a.rgba[i] - b.rgba[i])); return d; };
const centre = (r: RenderResult) => { const i = ((r.height >> 1) * r.width + (r.width >> 1)) * 4; return [r.rgba[i], r.rgba[i + 1], r.rgba[i + 2]]; };
const RED = [0.8, 0.25, 0.2];

// ---------------------------------------------------------------- one input at a time
{
  const smooth = stats(await shot(withMaterial({ baseColor: RED, roughness: 0.15 }))), rough = stats(await shot(withMaterial({ baseColor: RED, roughness: 0.85 })));
  check(smooth.max > rough.max + 25, `roughness 0.15 → 0.85: the highlight peak drops (${smooth.max.toFixed(0)} → ${rough.max.toFixed(0)})`);
  const plasticR = await shot(withMaterial({ baseColor: RED, roughness: 0.25, metallic: 0 })), metalR = await shot(withMaterial({ baseColor: RED, roughness: 0.25, metallic: 1 }));
  const plastic = stats(plasticR), metal = stats(metalR), tp = highlightTint(plasticR), tm = highlightTint(metalR);
  check(tm < tp - 0.15, `metallic 0 → 1: the highlight takes the base colour instead of staying white (G/R of the brightest 5% ${tp.toFixed(2)} → ${tm.toFixed(2)})`);
  check(metal.mean < plastic.mean, `metallic 1 loses the diffuse term under the studio rig (mean ${plastic.mean.toFixed(1)} → ${metal.mean.toFixed(1)})`);
  const ao1 = stats(await shot(withMaterial({ baseColor: RED, textures: { orm: 'image:orm' } }, [constImage('orm', [1, 0.5, 0, 1])])));
  const ao0 = stats(await shot(withMaterial({ baseColor: RED, textures: { orm: 'image:orm' } }, [constImage('orm', [0.1, 0.5, 0, 1])])));
  check(ao0.mean < ao1.mean - 3 && ao0.max > ao1.max - 8, `orm occlusion 1 → 0.1 darkens the indirect light only (mean ${ao1.mean.toFixed(1)} → ${ao0.mean.toFixed(1)}, key-lit peak ${ao1.max.toFixed(0)} → ${ao0.max.toFixed(0)})`);
  const ormRough = await shot(withMaterial({ baseColor: RED, roughness: 0.9, metallic: 0.7, textures: { orm: 'image:orm' } }, [constImage('orm', [1, 0.3, 0, 1])]));
  const factorRough = await shot(withMaterial({ baseColor: RED, roughness: 0.3, metallic: 0 }));
  check(maxDiff(ormRough, factorRough) <= 1, 'an orm map replaces the roughness and metallic factors (G 0.3 / B 0 = factors 0.3 / 0)');
  const flatN = await shot(withMaterial({ baseColor: RED, textures: { normal: 'image:n' } }, [constImage('n', [0.5, 0.5, 1, 1])]));
  const noN = await shot(withMaterial({ baseColor: RED }));
  check(maxDiff(flatN, noN) <= 1, `a flat normal map (0.5, 0.5, 1) shades like no normal map (max difference ${maxDiff(flatN, noN)})`);
  const tilted = stats(await shot(withMaterial({ baseColor: RED, textures: { normal: 'image:n' } }, [constImage('n', [0.5, 0.85, 0.75, 1])])));
  check(Math.abs(tilted.mean - stats(noN).mean) > 3, `a tilted normal map changes the shading (mean ${stats(noN).mean.toFixed(1)} → ${tilted.mean.toFixed(1)})`);
}

// ---------------------------------------------------------------- maps equal their factors; colour spaces
{
  const map = await shot(withMaterial({ baseColor: [0.2, 0.9, 0.1], textures: { baseColor: 'image:bc' } }, [constImage('bc', [0.5, 0.5, 0.5, 1])]));
  const factor = await shot(withMaterial({ baseColor: [0.5, 0.5, 0.5] }));
  check(maxDiff(map, factor) <= 1, 'a base colour map replaces the factor and decodes as sRGB exactly like a factor of the same value');
  const rmap = await shot(withMaterial({ roughness: 0.9, textures: { roughness: 'image:r' } }, [new Image(8, 8, 'r').set('C', new Float32Array(64).fill(0.25))]));
  const rfac = await shot(withMaterial({ roughness: 0.25 }));
  check(maxDiff(rmap, rfac) <= 1, 'a grey roughness map replaces the roughness factor and is read as linear data');
  const cd = withMaterial({ baseColor: [0.1, 0.1, 0.9], textures: { baseColor: 'image:bc' } }, [constImage('bc', [1, 1, 1, 1])]);
  const cda = cd.points.add('Cd', 'float', 3);
  for (let i = 0; i < cd.numPoints; i++) cda.set(i, [0.5, 0.5, 0.5]);
  check(maxDiff(await shot(cd, { vertexColors: 'multiply' }), factor) <= 1, 'cd "multiply": vertex colour × a white base colour map = the same colour as a factor (glTF COLOR_0 × map)');
}

// ---------------------------------------------------------------- vertex colour: a named material wins (glTF export rule)
{
  const GREEN = [0.2, 0.7, 0.3];
  const paint = (g: Geometry, c: number[]) => { const out = g.clone(), a = out.points.add('Cd', 'float', 3); for (let i = 0; i < out.numPoints; i++) a.set(i, c); return out; };
  const red = await shot(withMaterial({ baseColor: RED }));
  const redCd = await shot(paint(withMaterial({ baseColor: RED }), GREEN));
  check(maxDiff(redCd, red) === 0, `a named material wins over Cd: the prims show the material's base colour (max difference ${maxDiff(redCd, red)})`);
  check(redCd.notes.some((n) => /pbr: Cd on prims with a named material is not shown/.test(n)), 'a note says the Cd of material prims is not shown');
  const mapped = withMaterial({ baseColor: [1, 1, 1], textures: { baseColor: 'image:bc' } }, [constImage('bc', [0.8, 0.25, 0.2, 1])]);
  check(maxDiff(await shot(paint(mapped, GREEN)), await shot(mapped)) === 0, 'a named material\'s base colour map wins over Cd as well');
  const bare = await shot(paint(sphere, GREEN)), asFactor = await shot(withMaterial({ baseColor: GREEN }));
  check(maxDiff(bare, asFactor) <= 1 && !bare.notes.some((n) => /Cd on prims/.test(n)), 'prims without a material show their Cd (like a factor of that colour)');
  const ign = await shot(paint(sphere, GREEN), { vertexColors: 'ignore' }), plain = await shot(sphere);
  check(maxDiff(ign, plain) === 0, 'cd "ignore": Cd is never shown (the default material)');
  const mul = stats(await shot(paint(withMaterial({ baseColor: [1, 1, 1] }), GREEN), { vertexColors: 'multiply' })), green = stats(asFactor);
  check(Math.abs(mul.tint - green.tint) < 0.02, `cd "multiply": a white material × Cd reads as the Cd colour (G/R ${mul.tint.toFixed(2)} vs ${green.tint.toFixed(2)})`);
  check(renderArgs({ cd: 'multiply' }).vertexColors === 'multiply' && renderArgs({ vertexColors: 'ignore' }).vertexColors === 'ignore', 'render args: cd maps to vertexColors');
  let threw = '';
  try { renderArgs({ cd: 'tint' }); } catch (e: any) { threw = e.message; }
  check(/cd expects auto, ignore, multiply/.test(threw), `an unknown cd mode is refused (${threw})`);
}

// ---------------------------------------------------------------- alpha: a cutout grate and a blend glass pane in front of an opaque box
{
  const scene = (await engine.cook({
    nodes: {
      wall: { type: 'box', params: { size: [4, 2, 0.5], center: [0, 0, -1] } },
      grate: { type: 'grid', params: { plane: 'xy', size: [1.6, 1.6], divisions: [1, 1], center: [-1, 0, 0.5] } },
      glass: { type: 'grid', params: { plane: 'xy', size: [1.6, 1.6], divisions: [1, 1], center: [1, 0, 0.5] } },
      all: { type: 'merge', in: ['wall', 'grate', 'glass'] },
    },
    output: 'all',
  })).geo!;
  // 16 × 16 grate map: dark bars 4 texels wide, transparent gaps between them
  const grateMap = new Image(16, 16, 'grate').set('C', Float32Array.from({ length: 16 * 16 * 4 }, (_, i) => (i % 4 === 3 ? (Math.floor(((i >> 2) % 16) / 4) % 2 === 0 ? 1 : 0) : 0.15)));
  const WALL = { baseColor: [0.9, 0.7, 0.25] };
  const build = (grate: Record<string, any> | null, glass: Record<string, any> | null, wall = true) => {
    const g = scene.clone(), a = g.prims.add('material', 'string', 1);
    const keep = new Uint8Array(g.numPrims);
    for (let p = 0; p < g.numPrims; p++) {
      let x = 0, z = 0;
      const s = g.primStart[p], e = g.primStart[p + 1];
      for (let v = s; v < e; v++) { x += g.P[g.vertexPoint[v] * 3]; z += g.P[g.vertexPoint[v] * 3 + 2]; }
      x /= e - s; z /= e - s;
      const m = z < 0 ? 'wall' : x < 0 ? 'grate' : 'glass';
      a.set(p, m);
      keep[p] = (m === 'wall' ? wall : m === 'grate' ? !!grate : !!glass) ? 1 : 0;
    }
    const table: Record<string, any> = { wall: normalizeMaterial(WALL) };
    if (grate) table.grate = normalizeMaterial(grate);
    if (glass) table.glass = normalizeMaterial(glass);
    writeMaterials(g, table);
    g.volumes = [...g.volumes, grateMap];
    return keep.every((k) => k) ? g : g.subsetPrims(keep);
  };
  const GRATE = { baseColor: [1, 1, 1], alphaMode: 'mask', alphaCutoff: 0.5, doubleSided: true, textures: { baseColor: 'image:grate' } };
  const GLASS = { baseColor: [0.1, 0.4, 0.95], alphaMode: 'blend', alpha: 0.4, roughness: 0.1, doubleSided: true };
  const o: RenderOptions = { views: ['front'], size: [320, 160], bounds: [[-2, -1, -1.25], [2, 1, 0.5]], footer: false };
  const full = await shot(build(GRATE, GLASS), o), wallOnly = await shot(build(null, null), o);
  const opaqueGlass = await shot(build(GRATE, { ...GLASS, alphaMode: 'opaque' }), o), opaqueGrate = await shot(build({ ...GRATE, alphaMode: 'opaque' }, GLASS), o);
  const px = (r: RenderResult, x: number, y: number) => { const i = (y * r.width + x) * 4; return [r.rgba[i], r.rgba[i + 1], r.rgba[i + 2]]; };
  const dist = (p: number[], q: number[]) => Math.max(...p.map((v, k) => Math.abs(v - q[k])));
  // the grate (screen x 50..135): the wall shows through the gaps exactly, the bars cover it
  let holes = 0, bars = 0, n = 0;
  for (let y = 40; y <= 120; y += 2) for (let x = 50; x <= 135; x++) {
    n++;
    const d = dist(px(full, x, y), px(wallOnly, x, y));
    if (d <= 2) holes++; else if (d > 30) bars++;
  }
  check(holes > n * 0.3 && bars > n * 0.3, `cutout grate: the box is visible through the holes (${holes} of ${n} pixels equal the box alone) and hidden by the bars (${bars})`);
  check(maxDiff(opaqueGrate, full) > 30, 'the same grate rendered opaque hides the box (the cutout is what shows it)');
  // the glass (screen x 185..270): the box seen through it, tinted blue
  const mean = (r: RenderResult) => { const s = [0, 0, 0]; let k = 0; for (let y = 50; y <= 110; y += 2) for (let x = 190; x <= 265; x += 2) { const c = px(r, x, y); s[0] += c[0]; s[1] += c[1]; s[2] += c[2]; k++; } return s.map((v) => v / k); };
  const gl = mean(full), wl = mean(wallOnly), og = mean(opaqueGlass);
  check(gl[2] / gl[0] > wl[2] / wl[0] + 0.15, `blend glass tints the box behind it blue (B/R ${(wl[2] / wl[0]).toFixed(2)} → ${(gl[2] / gl[0]).toFixed(2)})`);
  check(gl[0] > og[0] + 25 && gl[0] < wl[0] - 10, `blend glass shows the box through it (R: opaque glass ${og[0].toFixed(0)} < glass ${gl[0].toFixed(0)} < box alone ${wl[0].toFixed(0)})`);
  check(full.notes.every((n) => !/transparency/.test(n)), 'no note that transparency is not evaluated');
  // on a transparent background the glass alone covers 40%
  const alone = await shot(build(null, GLASS, false), { ...o, transparent: true });
  const ai = (80 * alone.width + 228) * 4;
  check(Math.abs(alone.rgba[ai + 3] - 102) <= 3, `transparent background: blend glass alone has alpha ${alone.rgba[ai + 3]} (40% of 255 = 102)`);
  // the inspection views keep drawing the glass as a surface
  const dflt = renderGeometry(build(GRATE, GLASS), { ...o, shading: undefined });
  check(dist(px(dflt, 228, 80), px(renderGeometry(build(GRATE, { ...GLASS, alphaMode: 'opaque' }), { ...o, shading: undefined }), 228, 80)) === 0, 'default shading draws blend materials as before (opaque surface)');
}

// ---------------------------------------------------------------- emissive, unlit, exposure
{
  const lit = await shot(withMaterial({ baseColor: [0.2, 0.2, 0.2] })), glow = await shot(withMaterial({ baseColor: [0.2, 0.2, 0.2], emissive: [1, 0, 0] }));
  const sr = stats(lit), sg = stats(glow);
  check(sg.peak[0] >= sr.peak[0] && sg.mean > sr.mean + 10, `emissive adds light (mean ${sr.mean.toFixed(1)} → ${sg.mean.toFixed(1)})`);
  const unlit = centre(await shot(withMaterial({ baseColor: [0.5, 0.25, 1], unlit: true })));
  check(Math.abs(unlit[0] - 128) <= 1 && Math.abs(unlit[1] - 64) <= 1 && unlit[2] === 255, `unlit shows the base colour as it is (centre ${unlit.join(', ')})`);
  const ev1 = stats(await shot(withMaterial({ baseColor: RED }), { exposure: 1 }));
  check(ev1.mean > stats(await shot(withMaterial({ baseColor: RED }))).mean + 10, 'exposure +1 brightens');
}

// ---------------------------------------------------------------- notes for what is not evaluated; external PNGs
{
  const t = await shot(withMaterial({ alpha: 0.5 })), t1 = await shot(withMaterial({ alpha: 1 }));
  check(maxDiff(t, t1) > 20 && !t.notes.some((n) => /transparency/.test(n)), 'material alpha < 1 (alpha_mode auto) is blended, as exported (BLEND), not shaded opaque');
  const om = await shot(withMaterial({ textures: { baseColor: 'image:bc' } }, [constImage('bc', [0.5, 0.5, 0.5, 0.2])]));
  check(maxDiff(om, await shot(withMaterial({ textures: { baseColor: 'image:bc' } }, [constImage('bc', [0.5, 0.5, 0.5, 1])]))) === 0
    && om.notes.some((n) => /material "m" has a base colour map with alpha below 1 but is opaque/.test(n)), 'an opaque material ignores its map\'s alpha (as glTF OPAQUE) and a note says alpha_mode uses it');
  const missing = await shot(withMaterial({ textures: { normal: 'tex/missing.png' } }));
  check(missing.notes.some((n) => /material "m" normal "tex\/missing.png" no file access in this render/.test(n)), 'external map without readFile: named in the notes');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topotopo-pbr-'));
  // a 2 × 2 RGBA PNG, every pixel (128, 128, 128)
  const png = encodePNG(new Uint8Array(16).fill(128).map((x, i) => (i % 4 === 3 ? 255 : x)), 2, 2, (d) => zlib.deflateSync(d));
  fs.writeFileSync(path.join(dir, 'grey.png'), png);
  fs.writeFileSync(path.join(dir, 'photo.jpg'), Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]));
  const read = async (p: string) => new Uint8Array(fs.readFileSync(path.join(dir, p)));
  const ext = await renderGeometryAsync(withMaterial({ baseColor: [0.2, 0.9, 0.1], textures: { baseColor: 'grey.png' } }), OPTS, read);
  const ref = await shot(withMaterial({ baseColor: [128 / 255, 128 / 255, 128 / 255] }));
  check(maxDiff(ext, ref) <= 1 && !ext.notes.some((n) => n.startsWith('pbr:')), 'an external PNG base colour map is read through readFile and shaded like its factor');
  const jpg = await renderGeometryAsync(withMaterial({ textures: { baseColor: 'photo.jpg', roughness: 'nope.png' } }), OPTS, read);
  check(jpg.notes.some((n) => /"photo.jpg" is not a PNG/.test(n)) && jpg.notes.some((n) => /"nope.png" cannot be read/.test(n)), 'non-PNG and unreadable maps are reported, not silently dropped');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- determinism, sync entry, other modes untouched
{
  const g = withMaterial({ baseColor: RED, textures: { normal: 'image:n', orm: 'image:orm' } }, [constImage('n', [0.6, 0.4, 0.9, 1]), constImage('orm', [0.8, 0.4, 1, 1])]);
  const a = await shot(g, { views: ['persp', 'front'] }), b = await shot(g, { views: ['persp', 'front'] });
  const enc = (r: RenderResult) => Buffer.from(encodePNG(r.rgba, r.width, r.height, (d) => zlib.deflateSync(d)));
  check(enc(a).equals(enc(b)), 'two renders of the same geometry are byte-identical PNGs');
  check(maxDiff(renderGeometry(g, { ...OPTS, views: ['persp', 'front'] }), a) === 0, 'renderGeometry (sync) gives the same pixels once MikkTSpace is loaded');
  const d0 = renderGeometry(g, { views: ['front'], size: 160 }), d1 = await renderGeometryAsync(g, { views: ['front'], size: 160 });
  check(maxDiff(d0, d1) === 0, 'other shading modes are identical through the async entry');
  let threw = '';
  try { renderGeometry(g, { shading: 'shiny' as any }); } catch (e: any) { threw = e.message; }
  check(threw.includes('pbr'), `unknown shading lists pbr among the modes (${threw})`);
}

// ---------------------------------------------------------------- automatic polygon edges, color_by as a tint
{
  // a sphere of 1,536 quads: the automatic wireframe would draw its edges, but not over the material
  const g = withMaterial({ baseColor: [0.8, 0.8, 0.8] });
  const auto = await shot(g, { wireframe: undefined, annotate: undefined }), off = await shot(g, { wireframe: false, annotate: undefined });
  check(maxDiff(auto, off) === 0 && !auto.notes.some((n) => /wireframe auto/.test(n)), 'shading "pbr": the automatic wireframe draws no polygon edges');
  const tex = renderGeometry(g, { views: ['front'], size: 160, textures: true }), texOff = renderGeometry(g, { views: ['front'], size: 160, textures: true, wireframe: false });
  check(maxDiff(tex, texOff) === 0, 'textures: the automatic wireframe draws no polygon edges');
  const plain = renderGeometry(g, { views: ['front'], size: 160 }), plainOff = renderGeometry(g, { views: ['front'], size: 160, wireframe: false });
  check(maxDiff(plain, plainOff) > 0 && plain.notes.some((n) => /wireframe auto: polygon edges drawn/.test(n)), 'default shading: the automatic wireframe draws edges and says so');
  const forced = await shot(g, { wireframe: true });
  check(maxDiff(forced, off) > 0, 'wireframe true still draws edges under pbr');
  // color_by under pbr: the attribute colours tint the shaded material
  const hot = g.clone();
  const t = hot.points.add('t', 'float', 1);
  for (let i = 0; i < hot.numPoints; i++) t.set(i, hot.P[i * 3] > 0 ? 1 : 0);
  const tinted = await shot(hot, { colorBy: 't' }), untinted = await shot(hot);
  const side = (r: RenderResult, right: boolean) => { const y = 80, x = right ? 110 : 50, i = (y * r.width + x) * 4; return [r.rgba[i], r.rgba[i + 1], r.rgba[i + 2]]; };
  const [lr, lg, lb] = side(tinted, false), [rr, rg, rb] = side(tinted, true);
  check(maxDiff(tinted, untinted) > 40 && rr + rg > 2 * rb && lb > lr, `color_by under pbr tints the material: left (${lr},${lg},${lb}) low = viridis purple, right (${rr},${rg},${rb}) high = yellow`);
  check(!tinted.notes.some((n) => /not shown/.test(n) && /color_by/.test(n)), 'no note that color_by is dropped');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
