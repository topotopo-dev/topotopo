// Headless software renderer: multi-view, smooth-shaded, z-buffered images of geometry.
// Designed as an LLM feedback channel: labelled views, backfaces tinted blue (inverted
// normals stand out), wireframe, curves, points, attribute colour maps, group highlight.
// Opt-in overlays answer specific questions (help topic "render"): crisp 1 px edge overlays
// (all / hard / boundary / edge groups), a section view and a persp clip plane with filled caps,
// vector glyphs (N, up, orient, v), point/prim numbers, group/piece/attribute labels, legends,
// flat/matcap/AO shading and a self-describing annotation footer. With none of them set the
// output is exactly what it always was.
import { readMaterials, primMaterials } from '../core/materials.ts';
import { Geometry } from '../core/geometry.ts';
import { buildEdges, connectivity, primNormals, resolveVertexNormals, triangulate } from '../core/topology.ts';
import { halfEdges } from '../core/halfedge.ts';
import type { HalfEdgeMesh } from '../core/halfedge.ts';
import { drawText, textWidth } from './font.ts';
import { readUV, polygonSides, uvSeamPairs } from '../core/uv.ts';
import { expandForRender } from '../core/packed.ts';
import { qNormalize, qRotate } from '../core/math.ts';
import type { Quat, Vec3 } from '../core/math.ts';
import { PLANE_UV, sliceTriangles, windingGrid } from './section.ts';
import type { Slice } from './section.ts';
import { LabelPlacer, ambientOcclusion, dotOv, drawLabel, drawLegend, lineOv } from './overlay.ts';
import type { DepthTol, LegendItem, RGB } from './overlay.ts';
import { withHeightfieldPreview } from '../core/heightfield.ts';
import { withSdfGridPreview } from '../core/sdfgrid.ts';
import { drawTextureView, textureSampler } from './texview.ts';
import { pbrScene, preparePBR } from './pbr.ts';
import type { PBRScene, PBRTextures } from './pbr.ts';

/**
 * 3D views, 'persp@<azimuth>' (a persp view at that azimuth), 'section' (the cut through the section plane,
 * looking along its axis), plus 'uv': the 0..1 UV square (UDIM tiles) with every polygon drawn at its uv.
 */
export type ViewName = 'persp' | 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'uv' | 'section' | 'texture' | `persp@${number}`;
/** Edge overlays: every polygon edge, edges sharper than hardAngle (+ crease/hard/sharp edge groups), open/non-manifold/flipped edges, edge groups. */
export type WireMode = 'none' | 'all' | 'hard' | 'boundary' | 'groups';
export type GlyphMode = 'none' | 'N' | 'up' | 'orient' | 'v' | 'custom';
export type ShadingMode = 'default' | 'flat' | 'matcap' | 'ao' | 'pbr';
export type Axis = 'x' | 'y' | 'z';
export interface ClipOptions {
  axis: Axis;
  /** plane position as a fraction of the bbox along the axis (default 0.5), or a coordinate with absolute */
  offset?: number;
  absolute?: boolean;
  /** fill the cut with section caps (default true); false shows the inside (back faces, blue) instead */
  cap?: boolean;
}

export interface RenderOptions {
  views?: ViewName[];
  size?: number;
  /** true / 'auto' / false: classic edges (auto = on below 6000 polygons); 'all' | 'hard' | 'boundary' | 'groups': crisp edge overlays; 'none' = off */
  wireframe?: boolean | 'auto' | WireMode;
  colorBy?: string | null;
  highlight?: { cls: 'point' | 'prim'; mask: Uint8Array; label?: string } | null;
  /** true: every point (sized by pscale when present); 'auto': only loose points */
  points?: boolean | 'auto';
  grid?: boolean;
  azimuth?: number;
  elevation?: number;
  zoom?: number;
  /** look-at point (default bbox centre) */
  target?: Vec3 | null;
  ssaa?: number;
  /** packed instances: triangles to draw at most (default RENDER_TRIANGLE_BUDGET, 600k; up to 50M); above it an evenly spread subset */
  maxTriangles?: number;
  title?: string;
  /** shade 3D views with an 8×8 procedural checker from uv (stretch and flips become visible) */
  checker?: boolean;
  /** wireframe 'hard': dihedral angle in degrees above which an edge counts as hard (default 30) */
  hardAngle?: number;
  /** label point numbers / prim numbers (visible ones among the first maxLabels) */
  pointNumbers?: boolean;
  primNumbers?: boolean;
  /** cap on labelled elements per kind (default 200) */
  maxLabels?: number;
  /** 'section' view plane: axis (default 'y'), offset as a bbox fraction (default 0.5) or a coordinate with sectionAbsolute */
  sectionAxis?: Axis;
  sectionOffset?: number;
  sectionAbsolute?: boolean;
  /** cut persp views by a plane, removing the camera's side, and cap the cut */
  clip?: ClipOptions | null;
  /** per-element vector glyphs: N, up, orient (3 axes), v, or custom (glyphAttrib) */
  glyphs?: GlyphMode;
  glyphAttrib?: string | null;
  /** glyph length (default 5% of the bbox diagonal); v and custom vectors scale so the longest has this length */
  glyphScale?: number;
  /** at most this many glyphs, evenly subsampled (default 400) */
  maxGlyphs?: number;
  /** each point/prim group's name at its centroid, its border/points in the label colour, and a legend */
  labelGroups?: boolean;
  /** connected piece numbers at their centroids */
  labelPieces?: boolean;
  /** the distinct values of a string/int attribute at the centroid of each value's elements */
  labelAttrib?: string | null;
  /** legend for color_by (gradient bar / categorical swatches) and highlight */
  legend?: boolean;
  shading?: ShadingMode;
  /** shading 'pbr': exposure in stops (default 0) */
  exposure?: number;
  /** shading 'pbr': texture files read by renderGeometryAsync (preparePBR); image volumes need none */
  pbrTextures?: PBRTextures;
  /** ao sample radius in output pixels (default 10) */
  aoRadius?: number;
  /** ortho views: world width visible across a tile (default: fit the bbox) */
  orthoScale?: number;
  /** 1..4: multiplies tile size, text, lines and markers (2 = a 2× version) */
  scale?: number;
  /** second footer line naming the active overlays plus geometry notes (default: on when any overlay option is used) */
  annotate?: boolean;
  /** each view's name label (top left) and the persp axis gizmo (default true); false for clean thumbnails */
  viewLabels?: boolean;
  /** 3D views sample base colour maps of materials with "image:<name>" textures (needs uv; render/texview.ts) */
  textures?: boolean;
  /** 'texture' view: "" = every image, an image name, "image/layer", or a material name (its maps as a strip) */
  texture?: string;
}

/** View presets accepted by parseViews (MCP render "views", CLI --views). */
export const VIEW_PRESETS: Record<string, ViewName[]> = {
  quad: ['persp', 'front', 'right', 'top'],
  quad_uv: ['persp', 'uv'],
  turntable: ['persp@0', 'persp@90', 'persp@180', 'persp@270'],
};
export const BASE_VIEWS = ['persp', 'front', 'back', 'left', 'right', 'top', 'bottom', 'uv', 'section', 'texture'];

/** Views from a preset name, a comma/space separated list or an array (presets expand inside lists). Throws on unknown names. */
export function parseViews(spec: string | readonly string[] | null | undefined): ViewName[] | undefined {
  if (spec == null) return undefined;
  const list = typeof spec === 'string' ? spec.split(/[\s,]+/).filter(Boolean) : spec;
  if (!list.length) return undefined;
  const out: ViewName[] = [];
  for (const v of list) {
    if (VIEW_PRESETS[v]) { out.push(...VIEW_PRESETS[v]); continue; }
    if (!BASE_VIEWS.includes(v) && !/^persp@-?\d+(\.\d+)?$/.test(v))
      throw new Error(`unknown view "${v}" (use ${BASE_VIEWS.join(', ')}, persp@<azimuth>, or a preset: ${Object.keys(VIEW_PRESETS).join(', ')})`);
    out.push(v as ViewName);
  }
  return out;
}

const AXES: Axis[] = ['x', 'y', 'z'];
const WIRE_MODES = ['none', 'all', 'hard', 'boundary', 'groups'];
const GLYPH_MODES = ['none', 'N', 'up', 'orient', 'v', 'custom'];
const SHADING_MODES = ['default', 'flat', 'matcap', 'ao', 'pbr'];
const CUT_C = [0.93, 0.4, 0.3], CUT_FLIP_C = [0.25, 0.38, 0.9];

export interface RenderResult { width: number; height: number; rgba: Uint8Array; notes: string[] }

interface Cam {
  name: ViewName;
  persp: boolean;
  eye: Vec3; f: Vec3; r: Vec3; u: Vec3; c: Vec3;
  focal: number; scale: number;
}

const ORTHO: Record<string, { f: Vec3; r: Vec3; u: Vec3; label: string }> = {
  front: { f: [0, 0, -1], r: [1, 0, 0], u: [0, 1, 0], label: 'FRONT  X> Y^' },
  back: { f: [0, 0, 1], r: [-1, 0, 0], u: [0, 1, 0], label: 'BACK  -X> Y^' },
  right: { f: [-1, 0, 0], r: [0, 0, -1], u: [0, 1, 0], label: 'RIGHT  -Z> Y^' },
  left: { f: [1, 0, 0], r: [0, 0, 1], u: [0, 1, 0], label: 'LEFT  Z> Y^' },
  top: { f: [0, -1, 0], r: [1, 0, 0], u: [0, 0, -1], label: 'TOP  X> -Z^' },
  bottom: { f: [0, 1, 0], r: [1, 0, 0], u: [0, 0, 1], label: 'BOTTOM  X> Z^' },
};

const dot3 = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm3 = (a: number[]): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross3 = (a: number[], b: number[]): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

const VIRIDIS = [[0.267, 0.005, 0.329], [0.229, 0.322, 0.546], [0.128, 0.567, 0.551], [0.369, 0.789, 0.383], [0.993, 0.906, 0.144]];
function colormap(t: number): number[] {
  t = Math.max(0, Math.min(1, t)) * (VIRIDIS.length - 1);
  const i = Math.min(VIRIDIS.length - 2, Math.floor(t)), f = t - i;
  return [0, 1, 2].map((c) => VIRIDIS[i][c] + (VIRIDIS[i + 1][c] - VIRIDIS[i][c]) * f);
}
function catColor(k: number): number[] {
  const h = ((k * 0.618033988749895) % 1 + 1) % 1, s = 0.65, v = 0.95;
  const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
}
function hashStr(s: string) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }

/** Section views look along the section axis from its + side (same framing as right / top / front). */
const SECTION_CAM = [ORTHO.right, ORTHO.top, ORTHO.front];

function makeCam(name: ViewName, bmin: Vec3, bmax: Vec3, W: number, H: number, o: RenderOptions, kind: string = name, azDeg?: number, secAxis = 1): Cam {
  const c: Vec3 = o.target ?? [(bmin[0] + bmax[0]) / 2, (bmin[1] + bmax[1]) / 2, (bmin[2] + bmax[2]) / 2];
  const ext = [bmax[0] - bmin[0], bmax[1] - bmin[1], bmax[2] - bmin[2]];
  const R = Math.max(1e-6, Math.hypot(ext[0], ext[1], ext[2]) / 2);
  const zoom = Math.max(0.05, Math.min(20, o.zoom ?? 1));
  if (kind === 'persp') {
    const az = ((azDeg ?? o.azimuth ?? 35) * Math.PI) / 180, el = ((o.elevation ?? 25) * Math.PI) / 180;
    const fov = (32 * Math.PI) / 180;
    const dist = (R / Math.sin(fov / 2)) * 1.05 / zoom;
    const dir: Vec3 = [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)];
    const eye: Vec3 = [c[0] + dir[0] * dist, c[1] + dir[1] * dist, c[2] + dir[2] * dist];
    const f = norm3([c[0] - eye[0], c[1] - eye[1], c[2] - eye[2]]);
    let r = cross3(f, [0, 1, 0]);
    if (Math.hypot(...r) < 1e-6) r = [1, 0, 0];
    r = norm3(r);
    const u = cross3(r, f);
    return { name, persp: true, eye, f, r, u, c, focal: Math.min(W, H) / 2 / Math.tan(fov / 2), scale: 1 };
  }
  const v = kind === 'section' ? SECTION_CAM[secAxis] : ORTHO[name];
  const halfW = Math.abs(v.r[0]) * ext[0] / 2 + Math.abs(v.r[1]) * ext[1] / 2 + Math.abs(v.r[2]) * ext[2] / 2;
  const halfH = Math.abs(v.u[0]) * ext[0] / 2 + Math.abs(v.u[1]) * ext[1] / 2 + Math.abs(v.u[2]) * ext[2] / 2;
  const s = (o.orthoScale && o.orthoScale > 0 ? W / o.orthoScale : Math.min((W / 2) * 0.86 / Math.max(halfW, 1e-6), (H / 2) * 0.82 / Math.max(halfH, 1e-6))) * zoom;
  return { name, persp: false, eye: c, f: v.f, r: v.r, u: v.u, c, focal: 0, scale: s };
}

/**
 * Render with the asynchronous preparation shading 'pbr' needs (MikkTSpace, texture files through readFile, usually
 * Host.readFile); every other mode renders exactly as renderGeometry does.
 */
export async function renderGeometryAsync(g: Geometry, o: RenderOptions = {}, readFile?: (path: string) => Promise<Uint8Array>): Promise<RenderResult> {
  if (o.shading === 'pbr' && !o.pbrTextures) o = { ...o, pbrTextures: await preparePBR(g, readFile) };
  return renderGeometry(g, o);
}

/** Render the geometry; returns RGBA pixels. Shading 'pbr' needs renderGeometryAsync first (or MikkTSpace loaded). */
export function renderGeometry(g: Geometry, o: RenderOptions = {}): RenderResult {
  // packed instances are drawn expanded (within a triangle budget), spline curves as polylines, see core/packed.ts
  if (g.hasPacked() || g.hasSplines()) {
    const budget = o.maxTriangles !== undefined && o.maxTriangles > 0 ? Math.min(o.maxTriangles, 50_000_000) : undefined;
    const x = expandForRender(g, o, budget);
    const r = renderGeometry(x.geo, x.opts); r.notes.unshift(...x.notes); return r;
  }
  g = withHeightfieldPreview(g); // heightfields draw as their (decimated) grid mesh with layers as attributes
  g = withSdfGridPreview(g); // sampled SDFs draw through the existing level-set mesher at preview resolution
  const vlist = typeof (o.views as unknown) === 'string' ? parseViews(o.views as unknown as string) : o.views;
  // images and nothing else to draw in 3D: the texture view (render/texview.ts)
  const onlyImages = !g.numPoints && g.volumes.length > 0 && g.volumes.every((v) => v.kind === 'image');
  const views: ViewName[] = vlist?.length ? vlist : onlyImages ? ['texture'] : ['persp', 'front', 'right', 'top'];
  const ui = Math.max(1, Math.min(4, Math.round(o.scale ?? 1)));
  const tile = Math.max(128, Math.min(1600, Math.round(o.size ?? (views.length === 1 ? 800 : 512)))) * ui;
  let ss = Math.max(1, Math.min(3, Math.round(o.ssaa ?? 2)));
  if (ui > 1) ss = Math.max(1, Math.min(ss, Math.floor(4096 / tile)));
  const cols = views.length === 1 ? 1 : views.length <= 4 ? 2 : 3;
  const rows = Math.ceil(views.length / cols);
  // opt-in overlay options (validated: they arrive from MCP/CLI as free strings)
  const wm = o.wireframe;
  if (typeof wm === 'string' && wm !== 'auto' && !WIRE_MODES.includes(wm)) throw new Error(`unknown wireframe "${wm}" (use ${WIRE_MODES.join(', ')}, or true/false/"auto")`);
  const wireMode = wm === 'all' || wm === 'hard' || wm === 'boundary' || wm === 'groups' ? wm : null;
  if (o.glyphs && !GLYPH_MODES.includes(o.glyphs)) throw new Error(`unknown glyphs "${o.glyphs}" (use ${GLYPH_MODES.join(', ')})`);
  const glyphMode = o.glyphs && o.glyphs !== 'none' ? o.glyphs : o.glyphAttrib && o.glyphs !== 'none' ? 'custom' : null;
  if (o.shading && !SHADING_MODES.includes(o.shading)) throw new Error(`unknown shading "${o.shading}" (use ${SHADING_MODES.join(', ')})`);
  const shadingMode = o.shading && o.shading !== 'default' ? o.shading : null;
  const hasSection = views.includes('section');
  const secK = AXES.indexOf(o.sectionAxis ?? 'y');
  if (secK < 0) throw new Error(`unknown section_axis "${o.sectionAxis}" (use x, y or z)`);
  const clipK = o.clip ? AXES.indexOf(o.clip.axis) : -1;
  if (o.clip && clipK < 0) throw new Error(`unknown clip axis "${o.clip.axis}" (use x, y or z)`);
  const annotate = o.annotate ?? !!(wireMode || o.pointNumbers || o.primNumbers || hasSection || clipK >= 0 || glyphMode || o.labelGroups || o.labelPieces || o.labelAttrib || o.legend || shadingMode);
  const footerH = 22 * ui + (annotate ? 16 * ui : 0);
  const viewLabels = o.viewLabels ?? true;
  const outW = cols * tile + (cols - 1) * 2, outH = rows * tile + (rows - 1) * 2 + footerH;
  const notes: string[] = [];

  // --- scene data shared by all views
  const Pd = g.P, np = g.numPoints;
  const bb = g.bbox(true);
  const bmin = bb.min, bmax = bb.max;
  const { tris, triPrim } = triangulate(g);
  const nTri = tris.length / 3;
  if (nTri > 4e6) notes.push(`large mesh (${nTri} triangles) — render may be slow`);
  const vnorm = nTri ? resolveVertexNormals(g, 50) : new Float64Array(0);
  const nrmOf = (v: number, out: number[]) => { out[0] = vnorm[v * 3]; out[1] = vnorm[v * 3 + 1]; out[2] = vnorm[v * 3 + 2]; };
  // back faces are only suspicious on closed pieces; open sheets/cards are shaded two-sided
  const conn = nTri ? connectivity(g) : null;
  const closedPiece = new Uint8Array(conn ? conn.count : 0).fill(1);
  let openEdges = 0, nonManifoldEdges = 0;
  if (conn && nTri) {
    const E0 = buildEdges(g);
    for (let e = 0; e < E0.a.length; e++) if (E0.count[e] !== 2) closedPiece[conn.primClass[E0.firstPrim[e]]] = 0;
    if (annotate)
      for (let e = 0; e < E0.a.length; e++) {
        if (E0.count[e] === 1 && g.primClosed[E0.firstPrim[e]]) openEdges++;
        else if (E0.count[e] > 2) nonManifoldEdges++;
      }
  }

  // --- colours per vertex (Cd, colour-by, highlight)
  const vprim = g.vertexPrims();
  const BASE = [0.78, 0.74, 0.68];
  let colorOf: (v: number) => number[] = () => BASE;
  let pointColorOf: (p: number) => number[] | null = () => null;
  let legend = '';
  let cbLegend: LegendItem[] = [];
  const resolveAttr = (name: string) => g.findAttrib(name, ['vertex', 'point', 'prim', 'detail']);
  const elemIndex = (cls: string, v: number) => (cls === 'vertex' ? v : cls === 'point' ? g.vertexPoint[v] : cls === 'prim' ? vprim[v] : 0);
  if (o.colorBy) {
    const [aname, comp] = o.colorBy.split('.');
    const f = resolveAttr(aname);
    if (!f) notes.push(`colorBy: no attribute "${aname}"`);
    else {
      const a = f.attr;
      const ci = comp ? 'xyzwrgb'.indexOf(comp) % 4 : -1;
      if (a.type === 'string' || (a.type === 'int' && a.size === 1)) {
        const seen = new Set<any>();
        for (let i = 0; i < a.count; i++) seen.add(a.get(i));
        const toKey = (x: any) => (typeof x === 'string' ? hashStr(x) : x);
        colorOf = (v) => catColor(toKey(a.get(elemIndex(f.cls, v))));
        pointColorOf = f.cls === 'point' ? (p) => catColor(toKey(a.get(p))) : () => null;
        legend = `COLOR BY ${aname} (${seen.size} VALUES)`;
        if (o.legend) cbLegend = categoryLegend(`COLOR BY ${aname}`, seen, (x) => catColor(toKey(x)));
      } else {
        const scalar = (i: number) => {
          if (a.isArray) return a.arrayLength(i); // array attributes (float[]/int[]/string[]) colour by their length
          const x = a.get(i);
          if (!Array.isArray(x)) return x as number;
          return ci >= 0 ? x[ci] : Math.hypot(...x);
        };
        const rgb = a.size === 3 && ci < 0 && (aname === 'Cd' || aname === 'N' || aname.toLowerCase().includes('color'));
        if (rgb && aname === 'N') {
          colorOf = (v) => (a.get(elemIndex(f.cls, v)) as number[]).map((x) => x * 0.5 + 0.5);
          pointColorOf = f.cls === 'point' ? (p) => (a.get(p) as number[]).map((x) => x * 0.5 + 0.5) : () => null;
          legend = 'COLOR BY N (XYZ AS RGB)';
          if (o.legend) cbLegend = [{ text: 'COLOR BY N: XYZ AS RGB' }];
        } else if (rgb) {
          colorOf = (v) => a.get(elemIndex(f.cls, v)) as number[];
          pointColorOf = f.cls === 'point' ? (p) => a.get(p) as number[] : () => null;
          legend = `COLOR BY ${aname} (RGB)`;
          if (o.legend) cbLegend = [{ text: `COLOR BY ${aname}: RGB` }];
        } else {
          let lo = Infinity, hi = -Infinity;
          for (let i = 0; i < a.count; i++) { const s = scalar(i); if (s < lo) lo = s; if (s > hi) hi = s; }
          const span = hi > lo ? hi - lo : 1;
          colorOf = (v) => colormap((scalar(elemIndex(f.cls, v)) - lo) / span);
          pointColorOf = f.cls === 'point' ? (p) => colormap((scalar(p) - lo) / span) : () => null;
          legend = `COLOR BY ${o.colorBy} [${fmtNum(lo)} .. ${fmtNum(hi)}]`;
          if (o.legend) cbLegend = [{ text: `COLOR BY ${o.colorBy}`, gradient: { map: colormap, lo: fmtNum(lo), hi: fmtNum(hi) } }];
        }
      }
    }
  } else {
    const f = resolveAttr('Cd');
    if (f && f.attr.type === 'float') {
      const a = f.attr;
      const get = (i: number) => { const x = a.get(i); return Array.isArray(x) ? x : [x as number, x as number, x as number]; };
      colorOf = (v) => get(elemIndex(f.cls, v));
      if (f.cls === 'point') pointColorOf = (p) => get(p);
    }
    // material base colours where there is no colour (no Cd, or Houdini's default white), as glTF export does
    const pm = primMaterials(g), table = pm ? readMaterials(g) : null;
    if (pm && table && Object.keys(table).length) {
      const cd = colorOf, hasCd = !!(f && f.attr.type === 'float');
      colorOf = (v) => {
        const m = table[pm[vprim[v]]];
        if (!m) return cd(v);
        if (!hasCd) return m.baseColor;
        const c = cd(v);
        return c[0] === 1 && c[1] === 1 && c[2] === 1 ? m.baseColor : c;
      };
    }
  }
  const hl = o.highlight;
  if (hl) {
    const inner = colorOf;
    const HC = [1, 0.55, 0.1];
    colorOf = (v) => {
      const on = hl.cls === 'prim' ? hl.mask[vprim[v]] : hl.mask[g.vertexPoint[v]];
      const c = inner(v);
      return on ? HC : [c[0] * 0.35 + 0.25, c[1] * 0.35 + 0.25, c[2] * 0.35 + 0.25];
    };
    let n = 0;
    for (let i = 0; i < hl.mask.length; i++) if (hl.mask[i]) n++;
    legend = (legend ? legend + '  ' : '') + `HIGHLIGHT ${hl.label ?? 'GROUP'}: ${n} ${hl.cls.toUpperCase()}S`;
    if (o.legend) cbLegend.push({ color: HC, text: `${hl.label ?? 'GROUP'} (${n} ${hl.cls}s)` });
  }

  const colorByActive = !!o.colorBy || !!hl;

  // isolated points + polylines
  const used = new Uint8Array(np);
  for (let v = 0; v < g.numVertices; v++) used[g.vertexPoint[v]] = 1;
  let isolated = 0;
  for (let i = 0; i < np; i++) if (!used[i]) isolated++;
  const showAllPts = o.points === true;
  const drawPts = showAllPts || (o.points !== false && isolated > 0);
  const closedPrims = g.primClosed.reduce((s, c) => s + c, 0);
  // the classic auto wireframe; the new edge overlays (wireMode) replace it
  const wire = !wireMode && o.wireframe !== 'none' && (o.wireframe === true || (o.wireframe !== false && closedPrims > 0 && closedPrims <= 6000));
  const edges = wire ? buildEdges(g) : null;
  // triangle-dominant meshes (boolean/remesh output): hide edges between coplanar faces so the
  // wireframe shows shape, not triangulation slivers
  let edgeVisible: Uint8Array | null = null;
  if (edges) {
    let triCount = 0;
    for (let p = 0; p < g.numPrims; p++) if (g.primClosed[p] && g.primSize(p) === 3) triCount++;
    if (triCount > closedPrims * 0.5) {
      const fn = primNormals(g);
      edgeVisible = new Uint8Array(edges.a.length).fill(1);
      for (let e = 0; e < edges.a.length; e++) {
        const p1 = edges.firstPrim[e], p2 = edges.secondPrim[e];
        if (edges.count[e] === 2 && p2 >= 0 && fn[p1 * 3] * fn[p2 * 3] + fn[p1 * 3 + 1] * fn[p2 * 3 + 1] + fn[p1 * 3 + 2] * fn[p2 * 3 + 2] > 0.9995) edgeVisible[e] = 0;
      }
    }
  }
  const ptRadius = (np > 50000 ? 1 : np > 5000 ? 1.5 : 2.6) * ss * ui;
  // points: true sizes markers by pscale when the geometry has it
  const psA = showAllPts ? g.points.get('pscale') : undefined;
  const pscale = psA && psA.type === 'float' && psA.size === 1 ? (psA.data as Float64Array) : null;

  // --- output buffer (final res, RGB float) and per-tile SSAA buffers
  const out = new Float32Array(outW * outH * 3);
  for (let i = 0; i < out.length; i += 3) { out[i] = 0.12; out[i + 1] = 0.12; out[i + 2] = 0.13; }

  // --- uv data (uv view, checker shading)
  const uvd = views.includes('uv') || o.checker || o.textures ? readUV(g) : null;
  const checkerOn = !!(o.checker && uvd);
  if (o.checker && !uvd) notes.push('checker: no uv attribute (run uv_project, uv_unwrap or uv_flatten first)');
  // base colour maps (image textures) on the mesh: texture × Cd (as glTF multiplies COLOR_0), off under checker / colour-by
  const texS = o.textures && uvd && !checkerOn && !o.colorBy && !o.highlight ? textureSampler(g, notes) : null;
  if (o.textures && !uvd && nTri) notes.push('textures: no uv attribute, maps not shown');
  else if (o.textures && uvd && !texS && !checkerOn) notes.push('textures: no material with an image base colour (texture_to_material)');
  const texCd = !!(texS && g.findAttrib('Cd', ['vertex', 'point', 'prim', 'detail']));
  const texRGB = [0, 0, 0];

  // ---------------------------------------------------------------- opt-in overlays, shared by all views
  const ovDesc: string[] = []; // footer line 2: what is switched on
  if (pscale) ovDesc.push('POINTS BY PSCALE');
  const legendItems: LegendItem[] = [...cbLegend];
  const diag = np ? Math.hypot(bmax[0] - bmin[0], bmax[1] - bmin[1], bmax[2] - bmin[2]) : 0;
  const maxLabels = Math.max(1, Math.round(o.maxLabels ?? 200));
  let hem: HalfEdgeMesh | null = null;
  const getHE = () => (hem ??= halfEdges(g));
  let primCent: Float64Array | null = null;
  const centroids = () => {
    if (primCent) return primCent;
    const c = (primCent = new Float64Array(g.numPrims * 3));
    for (let p = 0; p < g.numPrims; p++) {
      const s = g.primStart[p], e = g.primStart[p + 1];
      let x = 0, y = 0, z = 0;
      for (let v = s; v < e; v++) { const i = g.vertexPoint[v] * 3; x += Pd[i]; y += Pd[i + 1]; z += Pd[i + 2]; }
      const n = Math.max(1, e - s);
      c[p * 3] = x / n; c[p * 3 + 1] = y / n; c[p * 3 + 2] = z / n;
    }
    return c;
  };
  // shading
  const flatN = shadingMode === 'flat' && nTri ? primNormals(g) : null;
  const matcap = shadingMode === 'matcap';
  let pbrS: PBRScene | null = null;
  if (shadingMode === 'pbr' && nTri) {
    const ev = o.exposure ?? 0;
    if (!Number.isFinite(ev)) throw new Error(`render: exposure expects a number of stops, got ${o.exposure}`);
    pbrS = pbrScene(g, tris, triPrim, o.pbrTextures, ev, notes);
    if (o.colorBy || o.highlight || o.checker) notes.push('pbr: color_by, highlight and checker are not shown under shading "pbr"');
    ovDesc.push(`SHADING PBR STUDIO EV ${fmtNum(ev)} (${pbrS.summary.toUpperCase()})`);
  } else if (shadingMode) ovDesc.push(`SHADING ${shadingMode.toUpperCase()}`);
  // section / clip planes
  const planeAt = (k: number, off: number | undefined, abs: boolean | undefined) => (abs ? off ?? 0 : bmin[k] + (bmax[k] - bmin[k]) * (off ?? 0.5));
  const secC = planeAt(secK, o.sectionOffset, o.sectionAbsolute);
  const clipC = clipK >= 0 ? planeAt(clipK, o.clip!.offset, o.clip!.absolute) : 0;
  const capOn = o.clip?.cap !== false;
  const slices = new Map<string, Slice>();
  const sliceAt = (k: number, c: number): Slice => {
    const key = `${k}:${c}`;
    let s = slices.get(key);
    if (!s) {
      s = nTri && conn ? sliceTriangles(Pd, g.vertexPoint, tris, (t) => conn.primClass[triPrim[t]], k, c) : { n: 0, seg: new Float64Array(0), piece: new Int32Array(0) };
      slices.set(key, s);
    }
    return s;
  };
  const planeDesc = (k: number, c: number) => `${'XYZ'[k]}=${fmtNum(c)}`;
  if (hasSection) ovDesc.push(`SECTION ${planeDesc(secK, secC)}`);
  if (clipK >= 0) ovDesc.push(`CLIP ${planeDesc(clipK, clipC)}${capOn ? '' : ' (NO CAP)'}`);
  if (hasSection || (clipK >= 0 && capOn)) legendItems.push({ color: CUT_C, text: 'CUT (SOLID)' }, { color: CUT_FLIP_C, text: 'CUT INSIDE-OUT' });
  let capCells = 0, capFlipCells = 0;

  // edge overlays: point pairs with a style
  const oeA: number[] = [], oeB: number[] = [], oeS: number[] = [];
  const styles: { c: RGB; a: number }[] = [];
  const addStyle = (c: RGB, a: number) => styles.push({ c, a }) - 1;
  if (wireMode) {
    const he = getHE();
    const valence = (e: number) => he.edgeHalfStart[e + 1] - he.edgeHalfStart[e];
    if (wireMode === 'all') {
      const st = addStyle([0.04, 0.04, 0.06], 0.6);
      for (let e = 0; e < he.numEdges; e++) { oeA.push(he.edgeA[e]); oeB.push(he.edgeB[e]); oeS.push(st); }
      ovDesc.push(`WIRE ALL ${he.numEdges} EDGES`);
    } else if (wireMode === 'hard') {
      const ang = o.hardAngle ?? 30, cosA = Math.cos((ang * Math.PI) / 180);
      const fn = primNormals(g);
      const st = addStyle([0.25, 0.95, 1], 1);
      let n = 0;
      for (let e = 0; e < he.numEdges; e++) {
        if (valence(e) !== 2) continue;
        const s = he.edgeHalfStart[e], h1 = he.edgeHalves[s], h2 = he.edgeHalves[s + 1];
        const f1 = he.heFace[h1] * 3, f2 = he.heFace[h2] * 3;
        let d = fn[f1] * fn[f2] + fn[f1 + 1] * fn[f2 + 1] + fn[f1 + 2] * fn[f2 + 2];
        if (he.heOrigin[h1] === he.heOrigin[h2]) d = -d; // inconsistent winding: compare as if fixed
        if (d < cosA) { oeA.push(he.edgeA[e]); oeB.push(he.edgeB[e]); oeS.push(st); n++; }
      }
      legendItems.push({ color: [0.25, 0.95, 1], text: `HARD > ${ang} DEG (${n})` });
      let gi = 0;
      for (const [name, set] of g.edgeGroups) {
        if (!/crease|hard|sharp/i.test(name)) continue;
        const c = catColor(gi++ + 5), sg = addStyle(c, 1);
        for (const [a, b] of set) { oeA.push(a); oeB.push(b); oeS.push(sg); }
        legendItems.push({ color: c, text: `${name} (${set.size})` });
      }
      ovDesc.push(`WIRE HARD>${ang} ${n} EDGES${gi ? ` + ${gi} CREASE GROUP${gi > 1 ? 'S' : ''}` : ''}`);
    } else if (wireMode === 'boundary') {
      const C1 = [1, 0.3, 0.62], C2 = [1, 0.92, 0.2], C3 = [0.72, 0.45, 1];
      const s1 = addStyle(C1, 1), s2 = addStyle(C2, 1), s3 = addStyle(C3, 1);
      let n1 = 0, n2 = 0;
      for (let e = 0; e < he.numEdges; e++) {
        const val = valence(e);
        if (val === 1) { oeA.push(he.edgeA[e]); oeB.push(he.edgeB[e]); oeS.push(s1); n1++; }
        else if (val > 2) { oeA.push(he.edgeA[e]); oeB.push(he.edgeB[e]); oeS.push(s2); n2++; }
      }
      for (const e of he.flippedEdges) { oeA.push(he.edgeA[e]); oeB.push(he.edgeB[e]); oeS.push(s3); }
      legendItems.push({ color: C1, text: `OPEN EDGES (${n1})` });
      if (n2) legendItems.push({ color: C2, text: `NON-MANIFOLD (${n2})` });
      if (he.flippedEdges.size) legendItems.push({ color: C3, text: `WINDING FLIPS (${he.flippedEdges.size})` });
      ovDesc.push(`WIRE BOUNDARY ${n1} OPEN${n2 ? ` ${n2} NON-MANIFOLD` : ''}${he.flippedEdges.size ? ` ${he.flippedEdges.size} FLIPPED` : ''}`);
    } else {
      let gi = 0;
      for (const [name, set] of g.edgeGroups) {
        const c = catColor(gi++ + 1), st = addStyle(c, 1);
        for (const [a, b] of set) { oeA.push(a); oeB.push(b); oeS.push(st); }
        legendItems.push({ color: c, text: `${name} (${set.size})` });
      }
      if (!gi) notes.push('wireframe groups: the geometry has no edge groups');
      ovDesc.push(`WIRE EDGE GROUPS (${gi})`);
    }
  }

  // world-space labels: kind 0 = names (always drawn; anchored on the visible member nearest the
  // projected centroid, mem = sampled member positions), 1 = element numbers (visible ones only)
  interface WLabel { x: number; y: number; z: number; text: string; c: RGB; kind: number; mem?: Float64Array }
  const wl: WLabel[] = [];
  const memFrom = (idx: ArrayLike<number>, src: Float64Array, max = 300): Float64Array => {
    const n = Math.min(idx.length, max), m = new Float64Array(n * 3);
    for (let k = 0; k < n; k++) { const i = idx[Math.floor((k * idx.length) / n)] * 3; m[k * 3] = src[i]; m[k * 3 + 1] = src[i + 1]; m[k * 3 + 2] = src[i + 2]; }
    return m;
  };
  const nameLabel = (idx: number[], src: Float64Array, text: string, c: RGB) => {
    let x = 0, y = 0, z = 0;
    for (const i of idx) { x += src[i * 3]; y += src[i * 3 + 1]; z += src[i * 3 + 2]; }
    const n = Math.max(1, idx.length);
    wl.push({ x: x / n, y: y / n, z: z / n, text, c, kind: 0, mem: memFrom(idx, src) });
  };
  const dotPts: number[] = [], dotSt: number[] = []; // point-group member markers
  if (o.labelGroups) {
    const tag: string[] = [];
    let gi = 0;
    const pc = g.primGroups.size ? centroids() : null;
    for (const [name, m] of g.primGroups) {
      const idx: number[] = [];
      for (let p = 0; p < m.length; p++) if (m[p]) idx.push(p);
      if (!idx.length || gi >= maxLabels) continue;
      const c = catColor(gi++ + 2);
      nameLabel(idx, pc!, name, c);
      legendItems.push({ color: c, text: `${name} (${idx.length} PRIMS)` });
      // the group's border edges in its colour show its extent
      const he = getHE(), st = addStyle(c, 0.95);
      for (let e = 0; e < he.numEdges; e++) {
        const s = he.edgeHalfStart[e], val = he.edgeHalfStart[e + 1] - s;
        let sel = 0;
        for (let k = 0; k < val; k++) sel += m[he.heFace[he.edgeHalves[s + k]]] ? 1 : 0;
        if (sel > 0 && (sel < val || val === 1)) { oeA.push(he.edgeA[e]); oeB.push(he.edgeB[e]); oeS.push(st); }
      }
      tag.push(name);
    }
    for (const [name, m] of g.pointGroups) {
      const idx: number[] = [];
      for (let i = 0; i < m.length; i++) if (m[i]) idx.push(i);
      if (!idx.length || gi >= maxLabels) continue;
      const c = catColor(gi++ + 2), st = addStyle(c, 1);
      nameLabel(idx, Pd, name, c);
      legendItems.push({ color: c, text: `${name} (${idx.length} PTS)` });
      const n = Math.min(idx.length, 1500);
      for (let k = 0; k < n; k++) { dotPts.push(idx[Math.floor((k * idx.length) / n)]); dotSt.push(st); }
      tag.push(name);
    }
    if (!tag.length) notes.push('label_groups: the geometry has no point or prim groups');
    ovDesc.push(`LABELS GROUPS (${tag.length})`);
  }
  if (o.labelAttrib) {
    const f = g.findAttrib(o.labelAttrib, ['prim', 'point', 'vertex']);
    if (!f) notes.push(`label_attrib: no attribute "${o.labelAttrib}"`);
    else if (!(f.attr.type === 'string' || (f.attr.type === 'int' && f.attr.size === 1))) notes.push(`label_attrib: "${o.labelAttrib}" is ${f.attr.type}${f.attr.size > 1 ? f.attr.size : ''}; use a string or int attribute`);
    else {
      const a = f.attr, groups = new Map<string | number, number[]>();
      const src = f.cls === 'prim' ? centroids() : Pd;
      let more = false;
      for (let i = 0; i < a.count; i++) {
        const v = a.get(i) as string | number;
        let s = groups.get(v);
        if (!s) { if (groups.size >= maxLabels) { more = true; continue; } groups.set(v, (s = [])); }
        s.push(f.cls === 'vertex' ? g.vertexPoint[i] : i);
      }
      for (const [v, idx] of groups) nameLabel(idx, src, v === '' ? '""' : String(v), catColor(typeof v === 'string' ? hashStr(v) : v));
      if (more) notes.push(`label_attrib: only the first ${maxLabels} distinct values of "${o.labelAttrib}" are labelled`);
      ovDesc.push(`LABELS ${o.labelAttrib.toUpperCase()} (${groups.size}${more ? '+' : ''})`);
    }
  }
  if (o.labelPieces && np) {
    const cn = conn ?? connectivity(g);
    const n = Math.min(cn.count, maxLabels);
    const idx: number[][] = Array.from({ length: n }, () => []);
    for (let i = 0; i < np; i++) if (cn.ptClass[i] < n) idx[cn.ptClass[i]].push(i);
    for (let k = 0; k < n; k++) nameLabel(idx[k], Pd, `#${k}`, [0.8, 1, 0.5]);
    if (cn.count > maxLabels) notes.push(`label_pieces: first ${maxLabels} of ${cn.count} pieces labelled`);
    ovDesc.push(`LABELS PIECES (${cn.count})`);
  }
  if (o.primNumbers) {
    const pc = centroids(), n = Math.min(g.numPrims, maxLabels);
    for (let p = 0; p < n; p++) wl.push({ x: pc[p * 3], y: pc[p * 3 + 1], z: pc[p * 3 + 2], text: String(p), c: [0.55, 0.9, 1], kind: 1 });
    if (g.numPrims > maxLabels) notes.push(`prim numbers: first ${maxLabels} of ${g.numPrims} prims (max_labels)`);
    ovDesc.push('PRIM NUMBERS');
  }
  if (o.pointNumbers) {
    const n = Math.min(np, maxLabels);
    for (let i = 0; i < n; i++) wl.push({ x: Pd[i * 3], y: Pd[i * 3 + 1], z: Pd[i * 3 + 2], text: String(i), c: [1, 0.88, 0.35], kind: 1 });
    if (np > maxLabels) notes.push(`point numbers: first ${maxLabels} of ${np} points (max_labels)`);
    ovDesc.push('POINT NUMBERS');
  }
  const bigLabels = wl.filter((l) => l.kind === 0).length;
  const nameFs = tile >= 400 * ui && bigLabels <= 40 ? 2 * ui : ui;

  // glyphs: world segments (start = anchor) with a base and a tip colour
  const glSeg: number[] = [], glCol: number[] = [];
  const glPal: RGB[][] = [];
  if (glyphMode && np) {
    const L = o.glyphScale && o.glyphScale > 0 ? o.glyphScale : Math.max(1e-6, diag * 0.05);
    const name = glyphMode === 'custom' ? o.glyphAttrib ?? '' : glyphMode;
    const f = name ? g.findAttrib(name, name === 'N' ? ['point', 'vertex', 'prim'] : ['point', 'prim', 'vertex', 'detail']) : null;
    const maxG = Math.max(1, Math.round(o.maxGlyphs ?? 400));
    const pos = (cls: string, i: number, out: number[]) => {
      if (cls === 'prim') { const c = centroids(); out[0] = c[i * 3]; out[1] = c[i * 3 + 1]; out[2] = c[i * 3 + 2]; return; }
      if (cls === 'detail') { out[0] = (bmin[0] + bmax[0]) / 2; out[1] = (bmin[1] + bmax[1]) / 2; out[2] = (bmin[2] + bmax[2]) / 2; return; }
      const p = cls === 'vertex' ? g.vertexPoint[i] : i;
      out[0] = Pd[p * 3]; out[1] = Pd[p * 3 + 1]; out[2] = Pd[p * 3 + 2];
    };
    let cls = '', count = 0, size = 0;
    let get: (i: number, out: number[]) => void = () => {};
    if (f && f.attr.type === 'float' && (f.attr.size === 3 || f.attr.size === 4)) {
      const d = f.attr.data as Float64Array, sz = f.attr.size;
      cls = f.cls; count = f.attr.count; size = sz;
      get = (i, out) => { for (let c = 0; c < sz; c++) out[c] = d[i * sz + c]; };
    } else if (name === 'N' && !f && g.numPrims) {
      // no N: computed face normals at polygon centroids
      const fnN = primNormals(g);
      cls = 'prim'; count = g.numPrims; size = 3;
      get = (i, out) => { out[0] = fnN[i * 3]; out[1] = fnN[i * 3 + 1]; out[2] = fnN[i * 3 + 2]; };
      notes.push('glyphs N: no N attribute, showing computed face normals at polygon centroids');
    } else if (!name) notes.push('glyphs custom: set glyph_attrib to a vector (3 floats) or quaternion (4 floats) attribute');
    else if (!f) notes.push(`glyphs: no attribute "${name}"`);
    else notes.push(`glyphs: "${name}" is ${f.attr.type}${f.attr.size > 1 ? f.attr.size : ''}; glyphs need 3 floats (vector) or 4 floats (quaternion)`);
    if (count) {
      const shown = Math.min(count, maxG), v = [0, 0, 0, 0], p = [0, 0, 0];
      const pick = (k: number) => Math.min(count - 1, Math.floor((k * count) / shown));
      const normalised = name === 'N' || name === 'up';
      let maxLen = 0;
      if (size === 3 && !normalised) for (let k = 0; k < shown; k++) { get(pick(k), v); maxLen = Math.max(maxLen, Math.hypot(v[0], v[1], v[2])); }
      const pal: Record<string, RGB[]> = { N: [[0.3, 0.7, 1], [0.85, 0.97, 1]], up: [[0.35, 0.95, 0.4], [0.85, 1, 0.8]], v: [[1, 0.55, 0.15], [1, 0.95, 0.7]] };
      const base = pal[name] ?? [[1, 0.4, 1], [1, 0.85, 1]];
      glPal.push(base, [[0.9, 0.2, 0.2], [1, 0.55, 0.5]], [[0.25, 0.85, 0.25], [0.6, 1, 0.55]], [[0.25, 0.45, 1], [0.6, 0.75, 1]]);
      const seg = (x: number, y: number, z: number, dx: number, dy: number, dz: number, c: number) => { glSeg.push(x, y, z, x + dx, y + dy, z + dz); glCol.push(c); };
      for (let k = 0; k < shown; k++) {
        const i = pick(k);
        get(i, v); pos(cls, i, p);
        if (size === 4) {
          const q = qNormalize([v[0], v[1], v[2], v[3]] as Quat);
          for (let ax = 0; ax < 3; ax++) {
            const d = qRotate(q, [ax === 0 ? 1 : 0, ax === 1 ? 1 : 0, ax === 2 ? 1 : 0]);
            const l = L * (ax === 2 ? 1 : 0.6);
            seg(p[0], p[1], p[2], d[0] * l, d[1] * l, d[2] * l, ax + 1);
          }
        } else {
          const len = Math.hypot(v[0], v[1], v[2]);
          if (!(len > 1e-12)) continue;
          const s = normalised ? L / len : L / Math.max(maxLen, 1e-12);
          seg(p[0], p[1], p[2], v[0] * s, v[1] * s, v[2] * s, 0);
        }
      }
      const label = `${name}${size === 4 ? ' AXES' : ''}`;
      if (size === 4) legendItems.push({ color: glPal[1][0], text: `${name} X` }, { color: glPal[2][0], text: `${name} Y` }, { color: glPal[3][0], text: `${name} Z` });
      else legendItems.push({ color: base[0], text: `${name}${normalised ? '' : ` (LONGEST ${fmtNum(maxLen)})`}` });
      ovDesc.push(`GLYPHS ${label} ${shown}/${count}${shown < count ? ' SAMPLED' : ''}`);
      if (shown < count) notes.push(`glyphs ${name}: ${shown} of ${count} ${cls}s shown (max_glyphs)`);
    }
  }
  if (o.legend && !cbLegend.length) notes.push('legend: nothing to explain (use with color_by or highlight)');
  const hasOverlay = oeA.length > 0 || dotPts.length > 0 || wl.length > 0 || glCol.length > 0 || legendItems.length > 0 || hasSection || clipK >= 0;
  const legendView = views.findIndex((v) => v !== 'uv' && v !== 'texture');
  const backView = annotate ? views.findIndex((v) => v !== 'uv' && v !== 'texture' && v !== 'section' && !(clipK >= 0 && v.startsWith('persp'))) : -1;
  let backPix = 0, shadedPix = 0;
  let labelsSkipped = 0;

  views.forEach((vname, vi) => {
    const W = tile * ss, H = tile * ss;
    const col = new Float32Array(W * H * 3);
    const tx = (vi % cols) * (tile + 2), ty = Math.floor(vi / cols) * (tile + 2);
    // downsample a finished tile into the output, draw the output-resolution overlays (post), label it
    const blit = (label: string, post?: () => void) => {
      const inv = 1 / (ss * ss);
      for (let y = 0; y < tile; y++)
        for (let x = 0; x < tile; x++) {
          let r = 0, gg = 0, b = 0;
          for (let j = 0; j < ss; j++) for (let i = 0; i < ss; i++) { const k = ((y * ss + j) * W + x * ss + i) * 3; r += col[k]; gg += col[k + 1]; b += col[k + 2]; }
          const k = ((ty + y) * outW + tx + x) * 3;
          out[k] = r * inv; out[k + 1] = gg * inv; out[k + 2] = b * inv;
        }
      if (post) post();
      if (viewLabels) drawText(out, outW, outH, tx + 6 * ui, ty + 6 * ui, label, [1, 1, 1], 2 * ui);
    };
    if (vname === 'uv') {
      blit(drawUVView(g, col, W, H, ss * ui, uvd, tris, colorOf, colorByActive, notes));
      return;
    }
    if (vname === 'texture') {
      blit(drawTextureView(g, col, W, H, ss * ui, o.texture ?? '', notes));
      return;
    }
    const kind = vname.startsWith('persp') ? 'persp' : vname;
    const azDeg = vname.startsWith('persp@') ? Number(vname.slice(6)) : undefined;
    const zb = new Float32Array(W * H).fill(-Infinity);
    for (let y = 0; y < H; y++) {
      const t = y / H;
      const r = 0.44 - t * 0.2, gg = 0.46 - t * 0.2, b = 0.5 - t * 0.2;
      for (let x = 0; x < W; x++) { const i = (y * W + x) * 3; col[i] = r; col[i + 1] = gg; col[i + 2] = b; }
    }
    const cam = makeCam(vname, bmin, bmax, W, H, o, kind, azDeg, secK);
    if (pbrS) pbrS.camera(cam.r, cam.u, cam.f);
    // project points
    const sx = new Float32Array(np), sy = new Float32Array(np), cz = new Float32Array(np), vz = new Float32Array(np);
    const project = (x: number, y: number, z: number, outp: number[]) => {
      const dx = x - cam.eye[0], dy = y - cam.eye[1], dz = z - cam.eye[2];
      const X = dx * cam.r[0] + dy * cam.r[1] + dz * cam.r[2];
      const Y = dx * cam.u[0] + dy * cam.u[1] + dz * cam.u[2];
      const Z = dx * cam.f[0] + dy * cam.f[1] + dz * cam.f[2];
      if (cam.persp) { outp[0] = W / 2 + (X / Z) * cam.focal; outp[1] = H / 2 - (Y / Z) * cam.focal; outp[2] = Z > 1e-6 ? 1 / Z : -Infinity; outp[3] = Z; }
      else { outp[0] = W / 2 + X * cam.scale; outp[1] = H / 2 - Y * cam.scale; outp[2] = -Z; outp[3] = Z; }
    };
    const tmp = [0, 0, 0, 0];
    for (let i = 0; i < np; i++) { project(Pd[i * 3], Pd[i * 3 + 1], Pd[i * 3 + 2], tmp); sx[i] = tmp[0]; sy[i] = tmp[1]; cz[i] = tmp[2]; vz[i] = tmp[3]; }
    const sceneR = Math.max(1e-6, Math.hypot(bmax[0] - bmin[0], bmax[1] - bmin[1], bmax[2] - bmin[2]) / 2);

    // clip plane of this view: the section view drops the camera side of the section plane, persp views
    // with clip drop the eye's side of the clip plane (cS = +1: coordinates above cC are removed)
    const cK = kind === 'section' ? secK : kind === 'persp' ? clipK : -1;
    const cC = kind === 'section' ? secC : clipC;
    const cS = kind === 'section' || cK < 0 || cam.eye[cK] >= cC ? 1 : -1;
    const clipOn = cK >= 0;
    const q0 = [0, 0, 0, 0], q1 = [0, 0, 0, 0];
    /** World segment clipped to the kept side, projected (SSAA px) into q0 / q1; false when nothing is left. */
    const clipProj = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean => {
      if (clipOn) {
        const s0 = ((cK === 0 ? x0 : cK === 1 ? y0 : z0) - cC) * cS, s1 = ((cK === 0 ? x1 : cK === 1 ? y1 : z1) - cC) * cS;
        if (s0 > 0 && s1 > 0) return false;
        if (s0 > 0 || s1 > 0) {
          const t = s0 / (s0 - s1), mx = x0 + (x1 - x0) * t, my = y0 + (y1 - y0) * t, mz = z0 + (z1 - z0) * t;
          if (s0 > 0) { x0 = mx; y0 = my; z0 = mz; } else { x1 = mx; y1 = my; z1 = mz; }
        }
      }
      project(x0, y0, z0, q0); project(x1, y1, z1, q1);
      return !(cam.persp && (q0[3] < 1e-4 || q1[3] < 1e-4));
    };
    const keptPt = (i: number) => !clipOn || (Pd[i * 3 + cK] - cC) * cS <= 0;

    // ground grid (persp only), drawn first without depth
    if (kind === 'persp' && o.grid !== false) {
      const step = Math.pow(10, Math.floor(Math.log10(sceneR * 0.5)));
      const ext = Math.ceil((sceneR * 1.6) / step) * step;
      const cx = Math.round(cam.c[0] / step) * step, czz = Math.round(cam.c[2] / step) * step;
      const p0 = [0, 0, 0, 0], p1 = [0, 0, 0, 0];
      for (let k = -ext; k <= ext + 1e-9; k += step) {
        const major = Math.abs(Math.round((k + (0 * cx)) / step) % 10) === 0;
        for (const dir of [0, 1]) {
          const a = dir ? [cx + k, 0, czz - ext] : [cx - ext, 0, czz + k];
          const b = dir ? [cx + k, 0, czz + ext] : [cx + ext, 0, czz + k];
          project(a[0], a[1], a[2], p0); project(b[0], b[1], b[2], p1);
          if (p0[3] <= 0 || p1[3] <= 0) continue;
          const isAxis = Math.abs((dir ? cx + k : czz + k)) < step * 1e-6;
          const color = isAxis ? (dir ? [0.35, 0.45, 0.85] : [0.85, 0.35, 0.35]) : [0.62, 0.64, 0.68];
          drawLine(col, null, W, H, p0[0], p0[1], 0, p1[0], p1[1], 0, color, isAxis ? 0.55 : major ? 0.28 : 0.16, ss * ui, false, 0);
        }
      }
    }

    // triangles
    const L1 = norm3([-0.45, 0.65, 0.6]), L2 = norm3([0.7, 0.15, 0.5]);
    const H1 = norm3([L1[0], L1[1], L1[2] + 1]);
    // matcap: clay lit from the camera's upper left, wrapped diffuse, sky/ground fill, strong rim
    const M1 = norm3([-0.35, 0.45, 0.82]), HM = norm3([M1[0], M1[1], M1[2] + 1]);
    const na = [0, 0, 0], nb = [0, 0, 0], nc = [0, 0, 0];
    const tn = [0, 0, 0];
    const chk = [0, 0, 0];
    const pbrUV0 = [0, 0], pbrUV1 = [0, 0], pbrUV2 = [0, 0], pbrV = [0, 0, 0], pbrRGB = [0, 0, 0];
    const bf = vi === backView ? new Uint8Array(W * H) : null;
    for (let t = 0; t < nTri; t++) {
      const va = tris[t * 3], vb = tris[t * 3 + 1], vc = tris[t * 3 + 2];
      const a = g.vertexPoint[va], b = g.vertexPoint[vb], c = g.vertexPoint[vc];
      if (cam.persp && (vz[a] < 1e-4 || vz[b] < 1e-4 || vz[c] < 1e-4)) continue;
      let partial = false, qa = 0, qb = 0, qc = 0;
      if (clipOn) {
        qa = Pd[a * 3 + cK]; qb = Pd[b * 3 + cK]; qc = Pd[c * 3 + cK];
        const ra = (qa - cC) * cS > 0, rb = (qb - cC) * cS > 0, rc = (qc - cC) * cS > 0;
        if (ra && rb && rc) continue;
        partial = ra || rb || rc;
      }
      const ax = sx[a], ay = sy[a], bx = sx[b], by = sy[b], cx = sx[c], cy = sy[c];
      const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (Math.abs(area) < 1e-12) continue;
      let minX = Math.max(0, Math.floor(Math.min(ax, bx, cx))), maxX = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
      let minY = Math.max(0, Math.floor(Math.min(ay, by, cy))), maxY = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)));
      if (minX > maxX || minY > maxY) continue;
      // facing (world space)
      const e1 = [Pd[b * 3] - Pd[a * 3], Pd[b * 3 + 1] - Pd[a * 3 + 1], Pd[b * 3 + 2] - Pd[a * 3 + 2]];
      const e2 = [Pd[c * 3] - Pd[a * 3], Pd[c * 3 + 1] - Pd[a * 3 + 1], Pd[c * 3 + 2] - Pd[a * 3 + 2]];
      const fnw = cross3(e1, e2);
      const toCam = cam.persp ? [cam.eye[0] - Pd[a * 3], cam.eye[1] - Pd[a * 3 + 1], cam.eye[2] - Pd[a * 3 + 2]] : [-cam.f[0], -cam.f[1], -cam.f[2]];
      const back = dot3(fnw, toCam) < 0;
      const suspicious = back && conn !== null && closedPiece[conn.primClass[triPrim[t]]] === 1;
      if (flatN) {
        const p = triPrim[t] * 3;
        na[0] = nb[0] = nc[0] = flatN[p]; na[1] = nb[1] = nc[1] = flatN[p + 1]; na[2] = nb[2] = nc[2] = flatN[p + 2];
      } else { nrmOf(va, na); nrmOf(vb, nb); nrmOf(vc, nc); }
      // camera-space normals
      const toCamSpace = (n: number[], o2: number[]) => { const x = dot3(n, cam.r), y = dot3(n, cam.u), z = -dot3(n, cam.f); o2[0] = x; o2[1] = y; o2[2] = z; };
      const ca = [0, 0, 0], cb = [0, 0, 0], cc = [0, 0, 0];
      toCamSpace(na, ca); toCamSpace(nb, cb); toCamSpace(nc, cc);
      let colA = colorOf(va), colB = colorOf(vb), colC = colorOf(vc);
      if (suspicious) {
        const tint = (q: number[]) => [q[0] * 0.35 + 0.12, q[1] * 0.35 + 0.22, q[2] * 0.35 + 0.6];
        colA = tint(colA); colB = tint(colB); colC = tint(colC);
      }
      const za = cz[a], zb2 = cz[b], zc = cz[c];
      const inv = 1 / area;
      // shading 'pbr': screen-space gradients of the affine weights (uv derivatives for the texture level of detail)
      const g0x = (by - cy) * inv, g0y = (cx - bx) * inv, g1x = (cy - ay) * inv, g1y = (ax - cx) * inv;
      // base colour map: mip level from the triangle's texels per screen pixel (render/texview.ts)
      const texP = texS && texS.has(triPrim[t]) ? triPrim[t] : -1;
      let texLod = 0;
      if (texP >= 0) {
        const uvA = Math.abs((uvd![vb * 2] - uvd![va * 2]) * (uvd![vc * 2 + 1] - uvd![va * 2 + 1]) - (uvd![vb * 2 + 1] - uvd![va * 2 + 1]) * (uvd![vc * 2] - uvd![va * 2]));
        texLod = Math.max(0, 0.5 * Math.log2(Math.max(1e-30, (uvA * texS!.texelArea(texP)) / Math.abs(area))));
      }
      for (let py = minY; py <= maxY; py++) {
        const yy = py + 0.5;
        for (let px = minX; px <= maxX; px++) {
          const xx = px + 0.5;
          let w0 = ((bx - xx) * (cy - yy) - (by - yy) * (cx - xx)) * inv;
          let w1 = ((cx - xx) * (ay - yy) - (cy - yy) * (ax - xx)) * inv;
          let w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const depth = w0 * za + w1 * zb2 + w2 * zc;
          const zi = py * W + px;
          if (depth <= zb[zi]) continue;
          if (partial) {
            // per-pixel clip test on the perspective-correct world coordinate along the clip axis
            let p0 = w0, p1 = w1, p2 = w2;
            if (cam.persp) { const s = w0 * za + w1 * zb2 + w2 * zc; p0 = (w0 * za) / s; p1 = (w1 * zb2) / s; p2 = 1 - p0 - p1; }
            if ((p0 * qa + p1 * qb + p2 * qc - cC) * cS > 0) continue;
          }
          zb[zi] = depth;
          if (bf) bf[zi] = suspicious ? 1 : 0;
          const aw0 = w0, aw1 = w1;
          if (cam.persp) { const s = w0 * za + w1 * zb2 + w2 * zc; w0 = (w0 * za) / s; w1 = (w1 * zb2) / s; w2 = 1 - w0 - w1; }
          if (pbrS) {
            let dudx = 0, dvdx = 0, dudy = 0, dvdy = 0;
            if (pbrS.hasUV) {
              const at = (q0: number, q1: number, out: number[]) => {
                let p0 = q0, p1 = q1;
                if (cam.persp) { const s = q0 * za + q1 * zb2 + (1 - q0 - q1) * zc; p0 = (q0 * za) / s; p1 = (q1 * zb2) / s; }
                pbrS!.uvAt(t, p0, p1, 1 - p0 - p1, out);
              };
              at(aw0, aw1, pbrUV0); at(aw0 + g0x, aw1 + g1x, pbrUV1); at(aw0 + g0y, aw1 + g1y, pbrUV2);
              dudx = pbrUV1[0] - pbrUV0[0]; dvdx = pbrUV1[1] - pbrUV0[1]; dudy = pbrUV2[0] - pbrUV0[0]; dvdy = pbrUV2[1] - pbrUV0[1];
            }
            if (cam.persp) {
              const px3 = Pd[a * 3] * w0 + Pd[b * 3] * w1 + Pd[c * 3] * w2, py3 = Pd[a * 3 + 1] * w0 + Pd[b * 3 + 1] * w1 + Pd[c * 3 + 1] * w2, pz3 = Pd[a * 3 + 2] * w0 + Pd[b * 3 + 2] * w1 + Pd[c * 3 + 2] * w2;
              const vx = cam.eye[0] - px3, vy = cam.eye[1] - py3, vz2 = cam.eye[2] - pz3, vl = Math.hypot(vx, vy, vz2) || 1;
              pbrV[0] = vx / vl; pbrV[1] = vy / vl; pbrV[2] = vz2 / vl;
            } else { pbrV[0] = -cam.f[0]; pbrV[1] = -cam.f[1]; pbrV[2] = -cam.f[2]; }
            pbrS.shade(t, w0, w1, w2, dudx, dvdx, dudy, dvdy, pbrV, back, pbrRGB);
            const ci = zi * 3;
            if (suspicious) { pbrRGB[0] = pbrRGB[0] * 0.35 + 0.12; pbrRGB[1] = pbrRGB[1] * 0.35 + 0.22; pbrRGB[2] = pbrRGB[2] * 0.35 + 0.6; }
            col[ci] = pbrRGB[0]; col[ci + 1] = pbrRGB[1]; col[ci + 2] = pbrRGB[2];
            continue;
          }
          tn[0] = ca[0] * w0 + cb[0] * w1 + cc[0] * w2;
          tn[1] = ca[1] * w0 + cb[1] * w1 + cc[1] * w2;
          tn[2] = ca[2] * w0 + cb[2] * w1 + cc[2] * w2;
          const l = Math.hypot(tn[0], tn[1], tn[2]) || 1;
          let nx = tn[0] / l, ny = tn[1] / l, nz = tn[2] / l;
          if (back) { nx = -nx; ny = -ny; nz = -nz; }
          let k: number, spec: number, rim: number;
          if (matcap) {
            // clay: view-facing falloff darkens towards silhouettes, a soft key from the upper left,
            // a thin bright rim at the very edge; form reads from the gradient, not from the light direction
            const facing = Math.max(0, nz), key = Math.max(0, nx * M1[0] + ny * M1[1] + nz * M1[2]);
            k = 0.05 + 0.42 * Math.pow(key, 1.3) + 0.4 * facing * Math.sqrt(facing) + 0.1 * (ny * 0.5 + 0.5);
            spec = Math.pow(Math.max(0, nx * HM[0] + ny * HM[1] + nz * HM[2]), 30) * 0.12;
            rim = Math.pow(1 - facing, 5) * 0.4;
          } else {
            const dif1 = Math.max(0, nx * L1[0] + ny * L1[1] + nz * L1[2]);
            const dif2 = Math.max(0, nx * L2[0] + ny * L2[1] + nz * L2[2]);
            spec = Math.pow(Math.max(0, nx * H1[0] + ny * H1[1] + nz * H1[2]), 40) * 0.18;
            const amb = 0.22 + 0.13 * (ny * 0.5 + 0.5);
            rim = Math.pow(1 - Math.max(0, nz), 3) * 0.12;
            k = amb + dif1 * 0.62 + dif2 * 0.22;
          }
          const ci = zi * 3;
          let fr = colA[0] * w0 + colB[0] * w1 + colC[0] * w2, fg = colA[1] * w0 + colB[1] * w1 + colC[1] * w2, fb = colA[2] * w0 + colB[2] * w1 + colC[2] * w2;
          if (checkerOn) {
            checkerColor(uvd![va * 2] * w0 + uvd![vb * 2] * w1 + uvd![vc * 2] * w2, uvd![va * 2 + 1] * w0 + uvd![vb * 2 + 1] * w1 + uvd![vc * 2 + 1] * w2, chk);
            fr = chk[0]; fg = chk[1]; fb = chk[2];
            if (suspicious) { fr = fr * 0.35 + 0.12; fg = fg * 0.35 + 0.22; fb = fb * 0.35 + 0.6; }
          } else if (texP >= 0) {
            texS!.sample(texP, uvd![va * 2] * w0 + uvd![vb * 2] * w1 + uvd![vc * 2] * w2, uvd![va * 2 + 1] * w0 + uvd![vb * 2 + 1] * w1 + uvd![vc * 2 + 1] * w2, texLod, texRGB);
            if (texCd) { fr *= texRGB[0]; fg *= texRGB[1]; fb *= texRGB[2]; } else { fr = texRGB[0]; fg = texRGB[1]; fb = texRGB[2]; }
            if (suspicious) { fr = fr * 0.35 + 0.12; fg = fg * 0.35 + 0.22; fb = fb * 0.35 + 0.6; }
          }
          col[ci] = aces(fr * k + spec + rim);
          col[ci + 1] = aces(fg * k + spec + rim);
          col[ci + 2] = aces(fb * k + spec + rim);
        }
      }
    }
    if (bf) for (let i = 0; i < W * H; i++) if (zb[i] > -Infinity) { shadedPix++; backPix += bf[i]; }

    // screen-space ambient occlusion on the shaded surface (before lines and points, which stay crisp)
    if (shadingMode === 'ao' && nTri) {
      const T = tile, lin = new Float32Array(T * T);
      for (let y = 0; y < T; y++)
        for (let x = 0; x < T; x++) {
          let m = -Infinity;
          for (let j = 0; j < ss; j++) for (let i = 0; i < ss; i++) { const z = zb[(y * ss + j) * W + x * ss + i]; if (z > m) m = z; }
          lin[y * T + x] = m === -Infinity ? Infinity : cam.persp ? 1 / m : -m;
        }
      const aoF = ambientOcclusion(lin, T, T, (o.aoRadius ?? 10) * ui, cam.persp ? (z) => (z * ss) / cam.focal : () => ss / cam.scale);
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const zi = y * W + x;
          if (zb[zi] === -Infinity) continue;
          const f = aoF[Math.floor(y / ss) * T + Math.floor(x / ss)];
          col[zi * 3] *= f; col[zi * 3 + 1] *= f; col[zi * 3 + 2] *= f;
        }
    }

    const tol = (d: number) => (cam.persp ? Math.abs(d) * 0.004 + 1e-6 : sceneR * 0.004);
    // wireframe (polygon edges, depth-tested)
    if (edges) {
      for (let e = 0; e < edges.a.length; e++) {
        if (edgeVisible && !edgeVisible[e]) continue;
        const a = edges.a[e], b = edges.b[e];
        if (clipOn) {
          if (clipProj(Pd[a * 3], Pd[a * 3 + 1], Pd[a * 3 + 2], Pd[b * 3], Pd[b * 3 + 1], Pd[b * 3 + 2]))
            drawLine(col, zb, W, H, q0[0], q0[1], q0[2], q1[0], q1[1], q1[2], [0.06, 0.06, 0.08], 0.55, Math.max(1, ss * 0.75 * ui), true, tol(q0[2]));
          continue;
        }
        if (cam.persp && (vz[a] < 1e-4 || vz[b] < 1e-4)) continue;
        drawLine(col, zb, W, H, sx[a], sy[a], cz[a], sx[b], sy[b], cz[b], [0.06, 0.06, 0.08], 0.55, Math.max(1, ss * 0.75 * ui), true, tol(cz[a]));
      }
    }
    // polylines
    for (let pr = 0; pr < g.numPrims; pr++) {
      if (g.primClosed[pr]) continue;
      const s = g.primStart[pr], e = g.primStart[pr + 1];
      for (let v = s; v < e - 1; v++) {
        const a = g.vertexPoint[v], b = g.vertexPoint[v + 1];
        const ccol = colorOf(v);
        const c0 = ccol === BASE ? [0.2, 0.6, 1.0] : ccol;
        if (clipOn) {
          if (clipProj(Pd[a * 3], Pd[a * 3 + 1], Pd[a * 3 + 2], Pd[b * 3], Pd[b * 3 + 1], Pd[b * 3 + 2]))
            drawLine(col, zb, W, H, q0[0], q0[1], q0[2], q1[0], q1[1], q1[2], c0, 1, 2 * ss * ui, true, tol(q0[2]), true);
          continue;
        }
        if (cam.persp && (vz[a] < 1e-4 || vz[b] < 1e-4)) continue;
        drawLine(col, zb, W, H, sx[a], sy[a], cz[a], sx[b], sy[b], cz[b], c0, 1, 2 * ss * ui, true, tol(cz[a]), true);
      }
    }
    // points
    if (drawPts) {
      for (let i = 0; i < np; i++) {
        if (!showAllPts && used[i]) continue;
        if (cam.persp && vz[i] < 1e-4) continue;
        if (clipOn && !keptPt(i)) continue;
        const pc = pointColorOf(i) ?? (hl && hl.cls === 'point' ? (hl.mask[i] ? [1, 0.55, 0.1] : [0.5, 0.5, 0.5]) : [1, 0.85, 0.25]);
        const rad = pscale ? Math.max(ss * 0.75, Math.min(40 * ss * ui, pscale[i] * (cam.persp ? cam.focal / vz[i] : cam.scale))) : ptRadius;
        drawDisc(col, zb, W, H, sx[i], sy[i], cz[i], rad, pc, tol(cz[i]));
      }
    }
    // volumes without polygons: draw their bounds (images live in uv space: the texture view shows them)
    if (g.volumes.some((v) => v.kind !== 'image') && !nTri) {
      for (const vol of g.volumes) {
        if (vol.kind === 'image') continue;
        const bmn = vol.bounds.min, bmx = vol.bounds.max;
        const corners: number[][] = [];
        for (let k = 0; k < 8; k++) { const q = [0, 0, 0, 0]; project(k & 1 ? bmx[0] : bmn[0], k & 2 ? bmx[1] : bmn[1], k & 4 ? bmx[2] : bmn[2], q); corners.push(q); }
        for (const [i, j] of [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]])
          drawLine(col, null, W, H, corners[i][0], corners[i][1], 0, corners[j][0], corners[j][1], 0, [0.4, 1, 0.6], 0.9, ss * ui, false, 0);
      }
      if (vi === 0) notes.push('geometry holds only SDF volumes (drawn as green boxes); add sdf_to_mesh to see the surface');
    }

    // section view: ghost what lies beyond the plane, then fill the cut; persp clip: fill the cut (caps)
    let cut: Slice | null = null;
    if (clipOn) {
      cut = sliceAt(cK, cC);
      if (kind === 'section') {
        if (!nTri) notes.push('section: no polygons to cut');
        for (let y = 0; y < H; y++) {
          const t = y / H, r = 0.44 - t * 0.2, gg = 0.46 - t * 0.2, b = 0.5 - t * 0.2;
          for (let x = 0; x < W; x++) { const i = (y * W + x) * 3; col[i] = r + (col[i] - r) * 0.32; col[i + 1] = gg + (col[i + 1] - gg) * 0.32; col[i + 2] = b + (col[i + 2] - b) * 0.32; }
        }
      }
      if (kind === 'section' || capOn) {
        const hatchP = 7 * ss * ui, hatchW = ss * ui;
        const paint = (zi: number, px: number, py: number, w: number, z: number, shade: number) => {
          const c = w > 0 ? CUT_C : CUT_FLIP_C;
          const k = shade * ((px + py) % hatchP < hatchW ? 0.72 : 1);
          col[zi * 3] = c[0] * k; col[zi * 3 + 1] = c[1] * k; col[zi * 3 + 2] = c[2] * k;
          zb[zi] = z;
          if (w > 0) capCells++; else capFlipCells++;
        };
        const seg2 = new Float64Array(cut.n * 4);
        let m = 0;
        if (kind === 'section') {
          // screen space: cell (i, j) = pixel (i, H-1-j); the section camera keeps the plane frame's handedness
          for (let s = 0; s < cut.n; s++) {
            if (!closedPiece[cut.piece[s]]) continue;
            const o6 = s * 6;
            project(cut.seg[o6], cut.seg[o6 + 1], cut.seg[o6 + 2], q0); project(cut.seg[o6 + 3], cut.seg[o6 + 4], cut.seg[o6 + 5], q1);
            seg2[m * 4] = q0[0] - 0.5; seg2[m * 4 + 1] = H - 0.5 - q0[1]; seg2[m * 4 + 2] = q1[0] - 0.5; seg2[m * 4 + 3] = H - 0.5 - q1[1];
            m++;
          }
          const grid = windingGrid(seg2, m, W, H);
          const pp = [cam.c[0], cam.c[1], cam.c[2]];
          pp[cK] = cC;
          project(pp[0], pp[1], pp[2], q0);
          for (let py = 0; py < H; py++) {
            const row = (H - 1 - py) * W;
            for (let px = 0; px < W; px++) { const w = grid[row + px]; if (w) paint(py * W + px, px, py, w, q0[2], 1); }
          }
        } else {
          // persp: winding grid in plane coordinates, looked up where each pixel's ray meets the plane
          const [ua, va] = PLANE_UV[cK];
          const extU = bmax[ua] - bmin[ua], extV = bmax[va] - bmin[va];
          const cell = Math.max(extU, extV, 1e-9) / Math.min(2048, W);
          const gx = Math.ceil(extU / cell) + 3, gy = Math.ceil(extV / cell) + 3;
          const ou = bmin[ua] - cell, ov = bmin[va] - cell;
          for (let s = 0; s < cut.n; s++) {
            if (!closedPiece[cut.piece[s]]) continue;
            const o6 = s * 6;
            seg2[m * 4] = (cut.seg[o6 + ua] - ou) / cell - 0.5; seg2[m * 4 + 1] = (cut.seg[o6 + va] - ov) / cell - 0.5;
            seg2[m * 4 + 2] = (cut.seg[o6 + 3 + ua] - ou) / cell - 0.5; seg2[m * 4 + 3] = (cut.seg[o6 + 3 + va] - ov) / cell - 0.5;
            m++;
          }
          if (m) {
            const grid = windingGrid(seg2, m, gx, gy);
            const e = cam.eye, f = cam.f, r = cam.r, u = cam.u;
            for (let py = 0; py < H; py++) {
              const dy = (H / 2 - (py + 0.5)) / cam.focal;
              for (let px = 0; px < W; px++) {
                const dx = (px + 0.5 - W / 2) / cam.focal;
                const dk = f[cK] + r[cK] * dx + u[cK] * dy;
                const t = (cC - e[cK]) / dk;
                if (!(t > 1e-6)) continue;
                const i = Math.floor((e[ua] + t * (f[ua] + r[ua] * dx + u[ua] * dy) - ou) / cell);
                const j = Math.floor((e[va] + t * (f[va] + r[va] * dx + u[va] * dy) - ov) / cell);
                if (i < 0 || j < 0 || i >= gx || j >= gy) continue;
                const w = grid[j * gx + i];
                if (!w) continue;
                const zi = py * W + px;
                if (1 / t <= zb[zi]) continue;
                paint(zi, px, py, w, 1 / t, 0.62 + 0.38 * Math.abs(dk) / Math.hypot(1, dx, dy));
              }
            }
          }
        }
      }
    }

    // axis gizmo
    if (kind === 'persp' && viewLabels) {
      const ox = 34 * ss * ui, oy = H - 34 * ss * ui, len = 22 * ss * ui;
      for (const [ax, colr, lab] of [[[1, 0, 0], [0.95, 0.3, 0.3], 'X'], [[0, 1, 0], [0.4, 0.9, 0.4], 'Y'], [[0, 0, 1], [0.4, 0.6, 1], 'Z']] as [number[], number[], string][]) {
        const ex = ox + dot3(ax, cam.r) * len, ey = oy - dot3(ax, cam.u) * len;
        drawLine(col, null, W, H, ox, oy, 0, ex, ey, 0, colr, 1, 2 * ss * ui, false, 0);
        drawText(col, W, H, Math.round(ex + 2 * ss * ui), Math.round(ey - 4 * ss * ui), lab, colr, ss * ui, true);
      }
    }
    const viewLabel = (kind === 'persp' ? `PERSP  AZ ${Math.round(azDeg ?? o.azimuth ?? 35)} EL ${Math.round(o.elevation ?? 25)}`
      : kind === 'section' ? `SECTION ${planeDesc(secK, secC)}  ${SECTION_CAM[secK].label.split('  ')[1]}`
      : ORTHO[vname].label) + (checkerOn ? '  CHECKER' : '') + (clipOn && kind === 'persp' ? `  CLIP ${planeDesc(cK, cC)}` : '');

    // output-resolution overlays: crisp 1 px lines, glyphs, cut outlines, labels, legend
    const post = !hasOverlay ? undefined : () => {
      const T = tile, inv = 1 / ss;
      const zt = new Float32Array(T * T); // nearest depth per output pixel
      for (let y = 0; y < T; y++)
        for (let x = 0; x < T; x++) {
          let m = -Infinity;
          for (let j = 0; j < ss; j++) for (let i = 0; i < ss; i++) { const z = zb[(y * ss + j) * W + x * ss + i]; if (z > m) m = z; }
          zt[y * T + x] = m;
        }
      const tb = new Float32Array(T * T * 3);
      for (let y = 0; y < T; y++) tb.set(out.subarray(((ty + y) * outW + tx) * 3, ((ty + y) * outW + tx + T) * 3), y * T * 3);
      const dtol: DepthTol = cam.persp ? { abs: 1e-7, rel: 0.006 } : { abs: sceneR * 0.006, rel: 0 };
      const hidden = (z: number, x: number, y: number) => {
        const xi = Math.floor(x), yi = Math.floor(y);
        if (xi < 0 || yi < 0 || xi >= T || yi >= T) return true;
        return z < zt[yi * T + xi] - 2 * (dtol.abs + Math.abs(z) * dtol.rel);
      };
      const dim = kind === 'section' ? 0.45 : 1;
      // edge overlays (wireframe modes, group borders)
      for (let e = 0; e < oeA.length; e++) {
        const a = oeA[e], b = oeB[e];
        if (a >= np || b >= np) continue;
        const st = styles[oeS[e]];
        if (clipOn) {
          if (clipProj(Pd[a * 3], Pd[a * 3 + 1], Pd[a * 3 + 2], Pd[b * 3], Pd[b * 3 + 1], Pd[b * 3 + 2]))
            lineOv(tb, T, T, q0[0] * inv, q0[1] * inv, q0[2], q1[0] * inv, q1[1] * inv, q1[2], st.c, st.a * dim, ui, zt, dtol);
          continue;
        }
        if (cam.persp && (vz[a] < 1e-4 || vz[b] < 1e-4)) continue;
        lineOv(tb, T, T, sx[a] * inv, sy[a] * inv, cz[a], sx[b] * inv, sy[b] * inv, cz[b], st.c, st.a * dim, ui, zt, dtol);
      }
      // point-group members and glyphs (not in the section view, where they would float over the cut)
      const flat2d = kind === 'section';
      for (let k = 0; k < (flat2d ? 0 : dotPts.length); k++) {
        const i = dotPts[k];
        if (!keptPt(i) || (cam.persp && vz[i] < 1e-4) || hidden(cz[i], sx[i] * inv, sy[i] * inv)) continue;
        dotOv(tb, T, T, sx[i] * inv, sy[i] * inv, 2 * ui, styles[dotSt[k]].c);
      }
      // glyphs: anchored on visible surface points, parts behind the surface dimmed, brighter tip
      const m3 = [0, 0, 0, 0];
      for (let k = 0; k < (flat2d ? 0 : glCol.length); k++) {
        const o6 = k * 6, x0 = glSeg[o6], y0 = glSeg[o6 + 1], z0 = glSeg[o6 + 2], x1 = glSeg[o6 + 3], y1 = glSeg[o6 + 4], z1 = glSeg[o6 + 5];
        if (clipOn && ((cK === 0 ? x0 : cK === 1 ? y0 : z0) - cC) * cS > 0) continue;
        project(x0, y0, z0, m3);
        if ((cam.persp && m3[3] < 1e-4) || hidden(m3[2], m3[0] * inv, m3[1] * inv)) continue;
        const pal = glPal[glCol[k]];
        const mx = x0 + (x1 - x0) * 0.62, my = y0 + (y1 - y0) * 0.62, mz = z0 + (z1 - z0) * 0.62;
        if (clipProj(x0, y0, z0, mx, my, mz)) lineOv(tb, T, T, q0[0] * inv, q0[1] * inv, q0[2], q1[0] * inv, q1[1] * inv, q1[2], pal[0], 0.95 * dim, ui, zt, dtol, 0.3 * dim);
        if (clipProj(mx, my, mz, x1, y1, z1)) lineOv(tb, T, T, q0[0] * inv, q0[1] * inv, q0[2], q1[0] * inv, q1[1] * inv, q1[2], pal[1], dim, ui, zt, dtol, 0.35 * dim);
      }
      // cut outlines: solid pieces dark, open sheets (no cap) yellow
      if (cut)
        for (let s = 0; s < cut.n; s++) {
          const o6 = s * 6;
          project(cut.seg[o6], cut.seg[o6 + 1], cut.seg[o6 + 2], q0); project(cut.seg[o6 + 3], cut.seg[o6 + 4], cut.seg[o6 + 5], q1);
          if (cam.persp && (q0[3] < 1e-4 || q1[3] < 1e-4)) continue;
          const solid = closedPiece[cut.piece[s]] === 1;
          lineOv(tb, T, T, q0[0] * inv, q0[1] * inv, 0, q1[0] * inv, q1[1] * inv, 0, solid ? [0.1, 0.02, 0.02] : [1, 0.85, 0.3], solid ? 0.9 : 1, ui, null, dtol);
        }
      // legend, then labels placed around it and around the view label / axis gizmo
      const pl = new LabelPlacer(T, T);
      const vlRight = 6 * ui + textWidth(viewLabel, 2 * ui) + 4 * ui;
      pl.reserve(0, 0, vlRight, 22 * ui);
      if (kind === 'persp') pl.reserve(0, T - 64 * ui, 64 * ui, T);
      if (vi === legendView && legendItems.length) drawLegend(tb, T, T, legendItems, T >= 700 * ui ? 2 * ui : ui, pl, 6 * ui, [vlRight, 22 * ui]);
      if (kind !== 'section') {
        const m4 = [0, 0, 0, 0];
        const clipped = (x: number, y: number, z: number) => clipOn && ((cK === 0 ? x : cK === 1 ? y : z) - cC) * cS > 0;
        for (const lb of wl) {
          project(lb.x, lb.y, lb.z, m4);
          const behind = cam.persp && m4[3] < 1e-4;
          let ax = m4[0] * inv, ay = m4[1] * inv;
          if (lb.mem) {
            // the visible member closest (on screen) to the centroid; else the centroid itself
            let best = Infinity, bx = 0, by = 0;
            const mem = lb.mem;
            for (let k = 0; k < mem.length; k += 3) {
              if (clipped(mem[k], mem[k + 1], mem[k + 2])) continue;
              project(mem[k], mem[k + 1], mem[k + 2], m4);
              if (cam.persp && m4[3] < 1e-4) continue;
              const x = m4[0] * inv, y = m4[1] * inv;
              if (hidden(m4[2], x, y)) continue;
              const d = behind ? 0 : (x - ax) * (x - ax) + (y - ay) * (y - ay);
              if (d < best) { best = d; bx = x; by = y; }
            }
            if (best < Infinity) { ax = bx; ay = by; }
            else if (behind || clipped(lb.x, lb.y, lb.z)) continue;
          } else {
            if (behind || clipped(lb.x, lb.y, lb.z)) continue;
            if (lb.kind === 1 && hidden(m4[2], ax, ay)) continue;
          }
          if (ax < 0 || ay < 0 || ax >= T || ay >= T) continue;
          drawLabel(tb, T, T, pl, ax, ay, lb.text, lb.c, lb.kind === 0 ? nameFs : ui);
        }
        if (vi === legendView) labelsSkipped = pl.skipped;
      }
      for (let y = 0; y < T; y++) out.set(tb.subarray(y * T * 3, (y + 1) * T * 3), ((ty + y) * outW + tx) * 3);
    };
    blit(viewLabel, post);
  });

  // footer
  const fy = outH - footerH + 4 * ui;
  const ext = [bmax[0] - bmin[0], bmax[1] - bmin[1], bmax[2] - bmin[2]];
  const stats = `${np} PTS  ${g.numPrims} PRIMS  BBOX ${fmtNum(ext[0])}×${fmtNum(ext[1])}×${fmtNum(ext[2])}  CENTER ${fmtNum((bmin[0] + bmax[0]) / 2)},${fmtNum((bmin[1] + bmax[1]) / 2)},${fmtNum((bmin[2] + bmax[2]) / 2)}`;
  drawText(out, outW, outH, 6 * ui, fy, (o.title ? o.title.toUpperCase() + '  ' : '') + stats, [0.85, 0.85, 0.85], 2 * ui, false);
  if (legend) {
    const lx = outW - textWidth(legend, 2 * ui) - 8 * ui;
    // drawn when it fits; the note below reports it either way (once)
    if (lx > textWidth(stats, 2 * ui) + 30 * ui) drawText(out, outW, outH, lx, fy, legend, [1, 0.85, 0.4], 2 * ui, false);
  }
  if (labelsSkipped) notes.push(`labels: ${labelsSkipped} not drawn to avoid overlaps (raise size, zoom in, or lower max_labels)`);
  if (annotate) {
    // second line: active overlays, then up to three geometry notes
    const gn: string[] = [];
    if (np) { const pieces = conn ? conn.count : connectivity(g).count; gn.push(`${pieces} PIECE${pieces === 1 ? '' : 'S'}`); }
    if (closedPrims) gn.push(openEdges ? `${openEdges} OPEN EDGES` : nonManifoldEdges ? `${nonManifoldEdges} NON-MANIFOLD EDGES` : 'NO OPEN EDGES');
    const capAll = capCells + capFlipCells;
    const bp = shadedPix ? (backPix / shadedPix) * 100 : 0;
    if (capFlipCells && capAll) {
      const pct = (capFlipCells / capAll) * 100;
      gn.push(`CUT ${pct.toFixed(1)}% INSIDE-OUT`);
      notes.push(`section: ${pct.toFixed(1)}% of the cut area is inside-out (blue): flipped normals`);
    } else if (bp >= 0.05) gn.push(`BACK-FACING ${bp.toFixed(1)}% OF PIXELS`);
    if (bp >= 0.05) notes.push(`${bp.toFixed(1)}% of the shaded pixels in the ${views[backView]} view are back faces of closed pieces (blue): flipped normals?`);
    const line = [...ovDesc, ...gn.slice(0, 3)].join('  ·  ');
    const maxW = outW - 12 * ui;
    let fs2 = 2 * ui, txt = line;
    if (textWidth(txt, fs2) > maxW) fs2 = ui;
    while (txt.length > 4 && textWidth(txt, fs2) > maxW) txt = txt.slice(0, -4) + '..';
    drawText(out, outW, outH, 6 * ui, fy + 18 * ui + (fs2 < 2 * ui ? 3 * ui : 0), txt, [0.62, 0.84, 1], fs2, false);
    notes.push('overlays: ' + line.toLowerCase());
  }
  const rgba = new Uint8Array(outW * outH * 4);
  for (let i = 0, j = 0; i < out.length; i += 3, j += 4) {
    rgba[j] = toSRGB(out[i]); rgba[j + 1] = toSRGB(out[i + 1]); rgba[j + 2] = toSRGB(out[i + 2]); rgba[j + 3] = 255;
  }
  if (legend) notes.push(legend.toLowerCase());
  return { width: outW, height: outH, rgba, notes };
}

/** Legend lines for categorical colours: up to 12 values in sorted order. */
function categoryLegend(head: string, seen: Set<any>, color: (x: any) => number[]): LegendItem[] {
  const vals = [...seen].sort((a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0));
  const items: LegendItem[] = [{ text: head }];
  for (const v of vals.slice(0, 12)) items.push({ color: color(v), text: v === '' ? '""' : String(v) });
  if (vals.length > 12) items.push({ text: `+${vals.length - 12} MORE` });
  return items;
}

/** Filmic tone curve (Narkowicz ACES fit) so light colours keep detail instead of clipping. */
function aces(x: number) {
  x *= 1.1;
  return Math.max(0, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14));
}

function toSRGB(x: number) {
  return Math.max(0, Math.min(255, Math.round(x * 255)));
}

export function fmtNum(x: number) {
  if (!Number.isFinite(x)) return String(x);
  const a = Math.abs(x);
  if (a >= 1000) return x.toFixed(0);
  if (a >= 10) return x.toFixed(1);
  if (a >= 0.01 || a === 0) return x.toFixed(2);
  return x.toExponential(1);
}

function drawLine(
  col: Float32Array, zb: Float32Array | null, W: number, H: number,
  x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
  c: number[], alpha: number, width: number, depthTest: boolean, tol: number, writeDepth = false,
) {
  const dx = x1 - x0, dy = y1 - y0;
  const steps = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)));
  if (!Number.isFinite(steps) || steps > 1e5) return;
  const hw = Math.max(0.5, width / 2);
  for (let s = 0; s <= steps; s++) {
    const t = steps ? s / steps : 0;
    const x = x0 + dx * t, y = y0 + dy * t, z = z0 + (z1 - z0) * t;
    const xa = Math.floor(x - hw + 0.5), xb = Math.floor(x + hw - 0.5), ya = Math.floor(y - hw + 0.5), yb = Math.floor(y + hw - 0.5);
    for (let py = ya; py <= yb; py++) {
      if (py < 0 || py >= H) continue;
      for (let px = xa; px <= xb; px++) {
        if (px < 0 || px >= W) continue;
        const zi = py * W + px;
        if (depthTest && zb && z < zb[zi] - tol) continue;
        if (writeDepth && zb) zb[zi] = Math.max(zb[zi], z);
        const i = zi * 3;
        col[i] += (c[0] - col[i]) * alpha; col[i + 1] += (c[1] - col[i + 1]) * alpha; col[i + 2] += (c[2] - col[i + 2]) * alpha;
      }
    }
  }
}

function drawDisc(col: Float32Array, zb: Float32Array, W: number, H: number, x: number, y: number, z: number, r: number, c: number[], tol: number) {
  const x0 = Math.floor(x - r), x1 = Math.ceil(x + r), y0 = Math.floor(y - r), y1 = Math.ceil(y + r);
  for (let py = Math.max(0, y0); py <= Math.min(H - 1, y1); py++)
    for (let px = Math.max(0, x0); px <= Math.min(W - 1, x1); px++) {
      const d = Math.hypot(px + 0.5 - x, py + 0.5 - y);
      if (d > r) continue;
      const zi = py * W + px;
      if (z < zb[zi] - tol) continue;
      zb[zi] = Math.max(zb[zi], z);
      const i = zi * 3;
      const edge = d > r - 1.2 ? 0.35 : 1;
      col[i] = c[0] * edge; col[i + 1] = c[1] * edge; col[i + 2] = c[2] * edge;
    }
}

/** Procedural 8×8 uv checker; light cells are tinted by the position inside the tile (red = u, green = v). */
function checkerColor(u: number, v: number, out: number[]) {
  if (!Number.isFinite(u) || !Number.isFinite(v)) { out[0] = 1; out[1] = 0; out[2] = 1; return; }
  const fu = u - Math.floor(u), fv = v - Math.floor(v);
  if ((Math.floor(u * 8) + Math.floor(v * 8)) & 1) { out[0] = 0.5 + 0.45 * fu; out[1] = 0.5 + 0.45 * fv; out[2] = 0.78; }
  else { out[0] = 0.1 + 0.2 * fu; out[1] = 0.1 + 0.2 * fv; out[2] = 0.22; }
}

/**
 * The UV view: the 0..1 square (or the UDIM tiles in use) with a 0.1 grid, every polygon filled at its uv
 * (chart/island colours, else the 3D face colour), overlaps in red, polygon edges, and island borders in yellow.
 * Draws into col (W×H, SSAA scale ss) and returns the tile label.
 */
function drawUVView(
  g: Geometry, col: Float32Array, W: number, H: number, ss: number, uv: Float64Array | null, tris: Uint32Array,
  colorOf: (v: number) => number[], useColorOf: boolean, notes: string[],
): string {
  for (let i = 0; i < col.length; i += 3) { col[i] = 0.11; col[i + 1] = 0.115; col[i + 2] = 0.13; }
  let u0 = 0, v0 = 0, span = 1;
  if (uv) {
    let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
    for (let i = 0; i < uv.length; i += 2) {
      const x = uv[i], y = uv[i + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < a) a = x; if (x > b) b = x; if (y < c) c = y; if (y > d) d = y;
    }
    if (a <= b) {
      u0 = Math.min(0, Math.floor(a)); v0 = Math.min(0, Math.floor(c));
      const u1 = Math.max(1, Math.ceil(b - 1e-9)), v1 = Math.max(1, Math.ceil(d - 1e-9));
      span = Math.max(u1 - u0, v1 - v0);
      if (span > 10) { notes.push(`uv view: uv spans ${span} tiles; showing 10×10 tiles from (${u0}, ${v0})`); span = 10; }
    }
  }
  const sz = Math.min(W - 24 * ss, H - 44 * ss), ox = (W - sz) / 2, oy = 32 * ss;
  const X = (u: number) => ox + ((u - u0) / span) * sz, Y = (v: number) => oy + sz - ((v - v0) / span) * sz;
  // tiles, grid, borders, UDIM labels
  const tilePx = sz / span;
  for (let tv = v0; tv < v0 + span; tv++)
    for (let tu = u0; tu < u0 + span; tu++) {
      const udim = tu >= 0 && tu < 10 && tv >= 0;
      const x0 = Math.round(X(tu)), x1 = Math.round(X(tu + 1)), y0 = Math.round(Y(tv + 1)), y1 = Math.round(Y(tv));
      const bg = udim ? [0.2, 0.205, 0.225] : [0.15, 0.15, 0.165];
      for (let y = Math.max(0, y0); y < Math.min(H, y1); y++)
        for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) { const i = (y * W + x) * 3; col[i] = bg[0]; col[i + 1] = bg[1]; col[i + 2] = bg[2]; }
      if (tilePx * 0.1 >= 5 * ss)
        for (let k = 1; k < 10; k++) {
          const gx = X(tu + k / 10), gy = Y(tv + k / 10);
          drawLine(col, null, W, H, gx, y0, 0, gx, y1, 0, [0.6, 0.62, 0.68], k === 5 ? 0.22 : 0.12, ss * 0.75, false, 0);
          drawLine(col, null, W, H, x0, gy, 0, x1, gy, 0, [0.6, 0.62, 0.68], k === 5 ? 0.22 : 0.12, ss * 0.75, false, 0);
        }
    }
  for (let k = 0; k <= span; k++) {
    drawLine(col, null, W, H, X(u0 + k), Y(v0), 0, X(u0 + k), Y(v0 + span), 0, [0.85, 0.87, 0.92], 0.55, ss, false, 0);
    drawLine(col, null, W, H, X(u0), Y(v0 + k), 0, X(u0 + span), Y(v0 + k), 0, [0.85, 0.87, 0.92], 0.55, ss, false, 0);
  }
  const tileLabels = () => {
    const labelScale = tilePx > 160 * ss ? 2 * ss : ss;
    for (let tv = v0; tv < v0 + span; tv++)
      for (let tu = u0; tu < u0 + span; tu++)
        if (tu >= 0 && tu < 10 && tv >= 0) drawText(col, W, H, Math.round(X(tu) + 4 * ss), Math.round(Y(tv + 1) + 4 * ss), String(1001 + tu + 10 * tv), [0.75, 0.78, 0.85], labelScale, true);
  };
  if (!uv) {
    tileLabels();
    notes.push('uv view: no uv attribute (run uv_project, uv_unwrap or uv_flatten)');
    return 'UV  (NO UV ATTRIBUTE)';
  }
  // filled polygons, with per-pixel coverage by distinct prims (overlaps)
  const vprim = g.vertexPrims();
  const chartA = g.prims.get('island') ?? g.prims.get('chart');
  const chartOf = !useColorOf && chartA && chartA.type === 'int' && chartA.size === 1 ? (chartA.data as Int32Array) : null;
  const owner = new Int32Array(W * H).fill(-1);
  const cnt = new Uint8Array(W * H);
  for (let t = 0; t < tris.length; t += 3) {
    const va = tris[t], vb = tris[t + 1], vc = tris[t + 2];
    const prim = vprim[va];
    const ax = X(uv[va * 2]), ay = Y(uv[va * 2 + 1]), bx = X(uv[vb * 2]), by = Y(uv[vb * 2 + 1]), cx = X(uv[vc * 2]), cy = Y(uv[vc * 2 + 1]);
    if (![ax, ay, bx, by, cx, cy].every(Number.isFinite)) continue;
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-12) continue;
    let c: number[];
    if (chartOf) c = chartOf[prim] >= 0 ? catColor(chartOf[prim]) : [0.5, 0.5, 0.5];
    else { const A = colorOf(va), B = colorOf(vb), C = colorOf(vc); c = [(A[0] + B[0] + C[0]) / 3, (A[1] + B[1] + C[1]) / 3, (A[2] + B[2] + C[2]) / 3]; }
    const inv = 1 / area;
    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx))), maxX = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy))), maxY = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let py = minY; py <= maxY; py++) {
      const yy = py + 0.5;
      for (let px = minX; px <= maxX; px++) {
        const xx = px + 0.5;
        const w0 = ((bx - xx) * (cy - yy) - (by - yy) * (cx - xx)) * inv;
        const w1 = ((cx - xx) * (ay - yy) - (cy - yy) * (ax - xx)) * inv;
        if (w0 <= 0 || w1 <= 0 || 1 - w0 - w1 <= 0) continue;
        const zi = py * W + px;
        if (owner[zi] === prim) continue;
        owner[zi] = prim;
        if (cnt[zi] < 255) cnt[zi]++;
        const i = zi * 3;
        col[i] += (c[0] * 0.85 - col[i]) * 0.7; col[i + 1] += (c[1] * 0.85 - col[i + 1]) * 0.7; col[i + 2] += (c[2] * 0.85 - col[i + 2]) * 0.7;
      }
    }
  }
  let covered = 0, overlap = 0;
  for (let i = 0; i < cnt.length; i++) {
    if (!cnt[i]) continue;
    covered++;
    if (cnt[i] < 2) continue;
    overlap++;
    col[i * 3] += (1 - col[i * 3]) * 0.8; col[i * 3 + 1] += (0.12 - col[i * 3 + 1]) * 0.8; col[i * 3 + 2] += (0.12 - col[i * 3 + 2]) * 0.8;
  }
  // polygon edges, then island borders (uv seams and open borders) on top
  if (g.numPrims <= 60000) {
    const ew = Math.max(1, ss * 0.6);
    for (let p = 0; p < g.numPrims; p++) {
      if (!g.primClosed[p]) continue;
      const s = g.primStart[p], e = g.primStart[p + 1];
      for (let v = s; v < e; v++) {
        const w = v + 1 < e ? v + 1 : s;
        drawLine(col, null, W, H, X(uv[v * 2]), Y(uv[v * 2 + 1]), 0, X(uv[w * 2]), Y(uv[w * 2 + 1]), 0, [0.04, 0.04, 0.06], 0.45, ew, false, 0);
      }
    }
  }
  const S = polygonSides(g);
  const seam = uvSeamPairs(S, uv);
  const BC = [1, 0.84, 0.3], bw = Math.max(1, ss * 1.3);
  const edge = (a: number, b: number) => drawLine(col, null, W, H, X(uv[a * 2]), Y(uv[a * 2 + 1]), 0, X(uv[b * 2]), Y(uv[b * 2 + 1]), 0, BC, 0.95, bw, false, 0);
  for (let i = 0; i < S.count; i++) if (seam[i]) { edge(S.a1[i], S.b1[i]); edge(S.a2[i], S.b2[i]); }
  for (let i = 0; i < S.bv.length; i++) edge(S.bv[i], S.bw[i]);
  tileLabels();
  const tiles = span === 1 && u0 === 0 && v0 === 0 ? '0..1' : `${span}×${span} TILES FROM ${u0},${v0}`;
  const ov = covered ? (overlap / covered) * 100 : 0;
  if (ov >= 0.05) notes.push(`uv view: ${ov.toFixed(1)}% of the covered uv area overlaps (red)`);
  return `UV  ${tiles}${ov >= 0.05 ? `  OVERLAP ${ov.toFixed(1)}%` : ''}`;
}
