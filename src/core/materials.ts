// Material data carried with geometry (not shading): a prim string attribute `material` names a material,
// and a detail string attribute `materials` holds the table as JSON:
//   { "name": { "baseColor": [r,g,b], "metallic": 0, "roughness": 0.5, "emissive": [r,g,b], "alpha": 1,
//               "doubleSided": false, "unlit": false,
//               "textures": { "baseColor": "tex/brick.png", "normal": "tex/brick_n.png", "roughness": "tex/brick_r.png" } } }
// Exporters turn the table into glTF / USD materials. Houdini's `shop_materialpath` is accepted on import (basename).
// Texture entries are file paths (as given to the material node; exporters read or reference them) or
// "image:<name>", an image volume carried by the geometry (texture nodes, core/image.ts; exporters encode it); the
// key is absent when a material has no texture, so tables without textures are unchanged. "orm" is a packed
// occlusion (R) / roughness (G) / metallic (B) map, the glTF and Unreal convention.
//
// Geometry.merge keeps the first detail value of each name, so the table of the first input wins there.
// The `merge` node and the exporters union tables with mergeMaterialTables() instead; other nodes that merge
// internally (copy_to_points, foreach, boolean…) keep the table of their first input.
import type { Geometry } from './geometry.ts';

export interface Material {
  baseColor: [number, number, number];
  metallic: number;
  roughness: number;
  emissive: [number, number, number];
  alpha: number;
  /** Absent = legacy auto (blend only for scalar / vertex opacity). */
  alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND';
  alphaCutoff?: number;
  doubleSided: boolean;
  unlit: boolean;
  /**
   * texture file paths or "image:<name>" (absent = none): base colour (sRGB), tangent-space normal map, roughness
   * (grey), orm (occlusion R, roughness G, metallic B)
   */
  textures?: MaterialTextures;
}

export interface MaterialTextures { baseColor?: string; normal?: string; roughness?: string; orm?: string }

/** Texture slots in table order. */
export const TEXTURE_SLOTS = ['baseColor', 'normal', 'roughness', 'orm'] as const;

export type MaterialTable = Record<string, Material>;

export const MATERIAL_ATTRIB = 'material';
export const MATERIALS_DETAIL = 'materials';

export const DEFAULT_MATERIAL: Readonly<Material> = Object.freeze({
  baseColor: [0.8, 0.8, 0.8] as [number, number, number],
  metallic: 0,
  roughness: 0.8,
  emissive: [0, 0, 0] as [number, number, number],
  alpha: 1,
  doubleSided: false,
  unlit: false,
});

const num = (v: any, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const vec3 = (v: any, d: readonly number[]): [number, number, number] =>
  Array.isArray(v) ? [num(v[0], d[0]), num(v[1], d[1]), num(v[2], d[2])] : typeof v === 'number' ? [v, v, v] : [d[0], d[1], d[2]];

/** Fill missing fields with defaults and coerce types (tolerant of hand-written tables). */
export function normalizeMaterial(m: any): Material {
  const d = DEFAULT_MATERIAL;
  return {
    baseColor: vec3(m?.baseColor, d.baseColor),
    metallic: num(m?.metallic, d.metallic),
    roughness: num(m?.roughness, d.roughness),
    emissive: vec3(m?.emissive, d.emissive),
    alpha: num(m?.alpha, d.alpha),
    ...alphaFields(m),
    doubleSided: typeof m?.doubleSided === 'boolean' ? m.doubleSided : d.doubleSided,
    unlit: typeof m?.unlit === 'boolean' ? m.unlit : d.unlit,
    ...textureField(m?.textures),
  };
}

/** Keep auto materials byte-compatible with existing graphs and fingerprints. */
function alphaFields(m: any): Pick<Material, 'alphaMode' | 'alphaCutoff'> {
  const mode = typeof m?.alphaMode === 'string' ? m.alphaMode.toUpperCase() : '';
  if (mode !== 'OPAQUE' && mode !== 'MASK' && mode !== 'BLEND') return {};
  return { alphaMode: mode, ...(mode === 'MASK' ? { alphaCutoff: Math.max(0, Math.min(1, num(m?.alphaCutoff, 0.5))) } : {}) };
}

export function materialAlphaMode(m: Material, vertexAlpha = false): 'OPAQUE' | 'MASK' | 'BLEND' {
  return m.alphaMode ?? (m.alpha < 1 || vertexAlpha ? 'BLEND' : 'OPAQUE');
}

/** { textures } with the non-empty string slots, or {} when there is none (keeps texture-free tables unchanged). */
function textureField(t: any): { textures?: MaterialTextures } {
  if (!t || typeof t !== 'object') return {};
  const out: MaterialTextures = {};
  for (const k of TEXTURE_SLOTS) if (typeof t[k] === 'string' && t[k].trim()) out[k] = t[k].trim();
  return Object.keys(out).length ? { textures: out } : {};
}

/** Every texture path used by a table (deduplicated, table order). */
export function texturePaths(t: MaterialTable): string[] {
  const out = new Set<string>();
  for (const m of Object.values(t)) for (const k of TEXTURE_SLOTS) { const p = m.textures?.[k]; if (p) out.add(p); }
  return [...out];
}

/** The material table stored on the geometry (empty when there is none or it does not parse). */
export function readMaterials(g: Geometry): MaterialTable {
  const a = g.detail.get(MATERIALS_DETAIL);
  if (!a || a.type !== 'string') return {};
  let raw: any;
  try { raw = JSON.parse(String(a.get(0) || '{}')); } catch { return {}; }
  const out: MaterialTable = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) for (const [k, v] of Object.entries(raw)) out[k] = normalizeMaterial(v);
  return out;
}

/** Store a table on the geometry (mutates g: clone cooked geometry first). An empty table removes the attribute. */
export function writeMaterials(g: Geometry, t: MaterialTable): void {
  const names = Object.keys(t).sort();
  if (!names.length) { g.detail.delete(MATERIALS_DETAIL); return; }
  const sorted: MaterialTable = {};
  for (const n of names) sorted[n] = normalizeMaterial(t[n]);
  g.detail.add(MATERIALS_DETAIL, 'string', 1).set(0, JSON.stringify(sorted));
}

/** A texture path that names a file relative to a folder: not "image:<name>", "embedded:<name>", a URL or an absolute path. */
const relativeTexture = (p: string | undefined): p is string => !!p && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(p) && !/^[\\/]/.test(p);
/** An absolute file path: "/x", "\\server\x" or a drive ("C:/x", "C:\x"). */
const absoluteTexture = (p: string | undefined): p is string => !!p && (/^[\\/]/.test(p) || /^[A-Za-z]:[\\/]/.test(p));

/**
 * The geometry with the file paths of its material textures (its own and its packed sources') rewritten by `resolve`,
 * cloned where something changes; g itself when nothing does. `resolve` sees every texture path that names a file,
 * relative (`relative` true) or absolute, never "image:<name>", "embedded:<name>" or a URL. A package output's result
 * names its textures in the version's folder this way, so exports and renders read them wherever the result goes.
 */
export function rebaseTexturePaths(g: Geometry, resolve: (path: string, relative: boolean) => string, done = new Map<Geometry, Geometry>()): Geometry {
  const seen = done.get(g);
  if (seen) return seen;
  let out = g;
  const table = readMaterials(g);
  let changed = false;
  for (const m of Object.values(table)) for (const k of TEXTURE_SLOTS) {
    const p = m.textures?.[k];
    const relative = relativeTexture(p);
    if (!relative && !absoluteTexture(p)) continue;
    const to = resolve(p!, relative);
    if (to !== p) { m.textures![k] = to; changed = true; }
  }
  if (changed) { out = g.clone(); writeMaterials(out, table); }
  // packed sources are shared and never modified: a rewritten source is a new one
  if (g.primKind) {
    const sources = g.packedSources.map((s) => rebaseTexturePaths(s, resolve, done));
    if (sources.some((s, i) => s !== g.packedSources[i])) {
      if (out === g) out = g.clone();
      out.packedSources = sources;
    }
  }
  done.set(g, out);
  return out;
}

/** Union of the tables of several geometries; the first definition of a name wins. */
export function mergeMaterialTables(geos: (Geometry | null | undefined)[]): MaterialTable {
  const out: MaterialTable = {};
  for (const g of geos) {
    if (!g) continue;
    for (const [k, m] of Object.entries(readMaterials(g))) if (!(k in out)) out[k] = m;
  }
  return out;
}

/** Basename of a Houdini material path ("/mat/brick" → "brick"). */
export function materialBasename(path: string): string {
  const s = String(path ?? '').replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

/**
 * Per-prim material names: the `material` prim attribute, else Houdini's `shop_materialpath` (basename),
 * else null. Empty strings mean "no material".
 */
export function primMaterials(g: Geometry): string[] | null {
  const a = g.prims.get(MATERIAL_ATTRIB);
  if (a && a.type === 'string') return (a.data as string[]).map((s) => s ?? '');
  const h = g.prims.get('shop_materialpath');
  if (h && h.type === 'string') return (h.data as string[]).map(materialBasename);
  return null;
}
