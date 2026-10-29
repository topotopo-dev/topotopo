// Render options from tool arguments: the snake_case keys of the MCP render tool, an example's
// meta.render and the CLI flags all map to RenderOptions here, so the three stay in sync.
// Only keys that are present are set (renderGeometry's defaults apply to the rest).
import { UNDERLAY_FITS, parseViews } from './raster.ts';
import type { Axis, ClipOptions, RenderOptions, UnderlayFit } from './raster.ts';

const num = (v: unknown, key: string): number => {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error(`render: ${key} expects a number, got ${JSON.stringify(v)}`);
  return n;
};
const bool = (v: unknown) => v === true || v === 'true' || v === 1;
const axis = (v: unknown, key: string): Axis => {
  const s = String(v).toLowerCase();
  if (s !== 'x' && s !== 'y' && s !== 'z') throw new Error(`render: ${key} expects "x", "y" or "z", got ${JSON.stringify(v)}`);
  return s;
};

/** "y:0.5" or "y" (offset 0.5) or "x:2.5:abs" → plane spec. */
export function parsePlane(s: string, key: string): { axis: Axis; offset: number; absolute: boolean } {
  const [a, off, abs] = s.split(':');
  return { axis: axis(a, key), offset: off === undefined || off === '' ? 0.5 : num(off, key), absolute: abs === 'abs' || abs === 'absolute' };
}

/** Pixels per view: 800, "800", "1600x900" (also 1600×900 or 1600,900) or [1600, 900]. */
export function parseSize(v: unknown): number | [number, number] {
  const bad = () => new Error(`render: size expects pixels per view, n or "WxH" (e.g. 800 or "1600x900"), got ${JSON.stringify(v)}`);
  if (Array.isArray(v)) {
    if (v.length !== 2 || !v.every((x) => Number.isFinite(+x) && +x > 0)) throw bad();
    return [+v[0], +v[1]];
  }
  if (typeof v === 'string' && /[x×,]/i.test(v)) {
    const m = /^\s*(\d+(?:\.\d+)?)\s*[x×,]\s*(\d+(?:\.\d+)?)\s*$/i.exec(v);
    if (!m) throw bad();
    return [Number(m[1]), Number(m[2])];
  }
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) throw bad();
  return n;
}

/** Map tool-style arguments (snake_case; camelCase also accepted) to RenderOptions. */
export function renderArgs(a: Record<string, any>): RenderOptions {
  const o: RenderOptions = {};
  const has = (k: string) => a[k] !== undefined && a[k] !== null;
  const pick = (snake: string, camel = snake) => (has(snake) ? a[snake] : has(camel) ? a[camel] : undefined);
  if (has('views')) o.views = parseViews(a.views);
  if (has('size')) o.size = parseSize(a.size);
  for (const [s, c] of [['azimuth', 'azimuth'], ['elevation', 'elevation'], ['zoom', 'zoom'], ['hard_angle', 'hardAngle'], ['max_labels', 'maxLabels'],
    ['glyph_scale', 'glyphScale'], ['max_glyphs', 'maxGlyphs'], ['ao_radius', 'aoRadius'], ['ortho_scale', 'orthoScale'], ['scale', 'scale'], ['ssaa', 'ssaa'],
    ['max_triangles', 'maxTriangles'], ['exposure', 'exposure'], ['underlay_opacity', 'underlayOpacity']] as const) {
    const v = pick(s, c);
    if (v !== undefined) (o as any)[c] = num(v, s);
  }
  const wf = pick('wireframe');
  if (wf !== undefined) o.wireframe = wf === 'true' ? true : wf === 'false' ? false : wf;
  const pts = pick('points');
  if (pts !== undefined) o.points = pts === 'auto' ? 'auto' : bool(pts);
  for (const [s, c] of [['point_numbers', 'pointNumbers'], ['prim_numbers', 'primNumbers'], ['label_groups', 'labelGroups'], ['label_pieces', 'labelPieces'],
    ['legend', 'legend'], ['checker', 'checker'], ['grid', 'grid'], ['annotate', 'annotate'], ['section_absolute', 'sectionAbsolute'], ['textures', 'textures'], ['view_labels', 'viewLabels'],
    ['transparent', 'transparent'], ['sockets', 'sockets']] as const) {
    const v = pick(s, c);
    if (v !== undefined) (o as any)[c] = bool(v);
  }
  for (const [s, c] of [['color_by', 'colorBy'], ['label_attrib', 'labelAttrib'], ['glyph_attrib', 'glyphAttrib'], ['glyphs', 'glyphs'], ['shading', 'shading'], ['title', 'title'], ['texture', 'texture'],
    ['heightfield_layer', 'heightfieldLayer'], ['underlay', 'underlay']] as const) {
    const v = pick(s, c);
    if (v !== undefined) (o as any)[c] = String(v);
  }
  // heightfields: quads per side (default 256), or "full" for every sample
  const hr = pick('heightfield_res', 'heightfieldRes');
  if (hr !== undefined) {
    const v = hr === 'full' || hr === Infinity ? Infinity : typeof hr === 'string' || typeof hr === 'number' ? Number(hr) : NaN;
    if (!(v >= 1)) throw new Error(`render: heightfield_res expects quads per side (1 or more) or "full", got ${JSON.stringify(hr)}`);
    o.heightfieldRes = v;
  }
  const uf = pick('underlay_fit', 'underlayFit');
  if (uf !== undefined) {
    if (!UNDERLAY_FITS.includes(uf)) throw new Error(`render: underlay_fit expects ${UNDERLAY_FITS.join(', ')}, got ${JSON.stringify(uf)}`);
    o.underlayFit = uf as UnderlayFit;
  }
  if (o.underlayOpacity !== undefined && !(o.underlayOpacity >= 0 && o.underlayOpacity <= 1)) throw new Error(`render: underlay_opacity expects 0..1, got ${o.underlayOpacity}`);
  const sa = pick('section_axis', 'sectionAxis');
  if (sa !== undefined) o.sectionAxis = axis(sa, 'section_axis');
  const so = pick('section_offset', 'sectionOffset');
  if (so !== undefined) o.sectionOffset = num(so, 'section_offset');
  // shorthand section: "y:0.5" (also adds the section view when views are not given)
  if (typeof a.section === 'string') {
    const p = parsePlane(a.section, 'section');
    o.sectionAxis = p.axis; o.sectionOffset = p.offset; o.sectionAbsolute = p.absolute;
    if (!o.views) o.views = ['persp', 'section'];
    else if (!o.views.includes('section')) o.views = [...o.views, 'section'];
  }
  // texture: "<image>" | "<material>" | "image/layer" names what the texture view shows (and adds the view)
  if (typeof a.texture === 'string') {
    if (!o.views) o.views = ['texture'];
    else if (!o.views.includes('texture')) o.views = [...o.views, 'texture'];
  }
  const cl = a.clip;
  if (typeof cl === 'string' && cl) o.clip = parsePlane(cl, 'clip');
  else if (cl && typeof cl === 'object') {
    const c: ClipOptions = { axis: axis(cl.axis ?? 'x', 'clip.axis') };
    if (cl.offset !== undefined) c.offset = num(cl.offset, 'clip.offset');
    if (cl.absolute !== undefined) c.absolute = bool(cl.absolute);
    if (cl.cap !== undefined) c.cap = bool(cl.cap);
    o.clip = c;
  }
  const look = pick('look_at', 'lookAt') ?? pick('target');
  if (look !== undefined) {
    const v = typeof look === 'string' ? look.split(',').map(Number) : look;
    if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => Number.isFinite(+x))) throw new Error(`render: look_at expects [x, y, z], got ${JSON.stringify(look)}`);
    o.target = [+v[0], +v[1], +v[2]];
  }
  // shorthand labels: "groups,pieces,points,prims,attrib:name"
  if (typeof a.labels === 'string') {
    for (const t of a.labels.split(/[\s,]+/).filter(Boolean)) {
      if (t === 'groups') o.labelGroups = true;
      else if (t === 'pieces') o.labelPieces = true;
      else if (t === 'points' || t === 'point_numbers') o.pointNumbers = true;
      else if (t === 'prims' || t === 'prim_numbers') o.primNumbers = true;
      else if (/^(attrib|attr)[:=]/.test(t)) o.labelAttrib = t.replace(/^(attrib|attr)[:=]/, '');
      else if (t === 'name') o.labelAttrib = 'name';
      else throw new Error(`render: unknown label kind "${t}" (use groups, pieces, points, prims, attrib:<name>)`);
    }
  }
  return o;
}
