// Render options from tool arguments: the snake_case keys of the MCP render tool, an example's
// meta.render and the CLI flags all map to RenderOptions here, so the three stay in sync.
// Only keys that are present are set (renderGeometry's defaults apply to the rest).
import { parseViews } from './raster.ts';
import type { Axis, ClipOptions, RenderOptions } from './raster.ts';

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

/** Map tool-style arguments (snake_case; camelCase also accepted) to RenderOptions. */
export function renderArgs(a: Record<string, any>): RenderOptions {
  const o: RenderOptions = {};
  const has = (k: string) => a[k] !== undefined && a[k] !== null;
  const pick = (snake: string, camel = snake) => (has(snake) ? a[snake] : has(camel) ? a[camel] : undefined);
  if (has('views')) o.views = parseViews(a.views);
  for (const [s, c] of [['size', 'size'], ['azimuth', 'azimuth'], ['elevation', 'elevation'], ['zoom', 'zoom'], ['hard_angle', 'hardAngle'], ['max_labels', 'maxLabels'],
    ['glyph_scale', 'glyphScale'], ['max_glyphs', 'maxGlyphs'], ['ao_radius', 'aoRadius'], ['ortho_scale', 'orthoScale'], ['scale', 'scale'], ['ssaa', 'ssaa']] as const) {
    const v = pick(s, c);
    if (v !== undefined) (o as any)[c] = num(v, s);
  }
  const wf = pick('wireframe');
  if (wf !== undefined) o.wireframe = wf === 'true' ? true : wf === 'false' ? false : wf;
  const pts = pick('points');
  if (pts !== undefined) o.points = pts === 'auto' ? 'auto' : bool(pts);
  for (const [s, c] of [['point_numbers', 'pointNumbers'], ['prim_numbers', 'primNumbers'], ['label_groups', 'labelGroups'], ['label_pieces', 'labelPieces'],
    ['legend', 'legend'], ['checker', 'checker'], ['grid', 'grid'], ['annotate', 'annotate'], ['section_absolute', 'sectionAbsolute'], ['textures', 'textures']] as const) {
    const v = pick(s, c);
    if (v !== undefined) (o as any)[c] = bool(v);
  }
  for (const [s, c] of [['color_by', 'colorBy'], ['label_attrib', 'labelAttrib'], ['glyph_attrib', 'glyphAttrib'], ['glyphs', 'glyphs'], ['shading', 'shading'], ['title', 'title'], ['texture', 'texture']] as const) {
    const v = pick(s, c);
    if (v !== undefined) (o as any)[c] = String(v);
  }
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
