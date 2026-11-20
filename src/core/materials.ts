// Material data carried with geometry (not shading): a prim string attribute `material` names a material,
// and a detail string attribute `materials` holds the table as JSON:
//   { "name": { "baseColor": [r,g,b], "metallic": 0, "roughness": 0.5, "emissive": [r,g,b], "alpha": 1,
//               "doubleSided": false, "unlit": false,
//               "textures": { "baseColor": "tex/brick.png", "normal": "tex/brick_n.png", "roughness": "tex/brick_r.png" } } }
// Exporters turn the table into glTF / USD materials. Houdini's `shop_materialpath` is accepted on import (basename).
// Texture entries are file paths (as given to the material node; exporters read or reference them) or
// "image:<name>", an image volume carried by the geometry (texture nodes, core/image.ts; exporters encode it); the
// key is absent when a material has no texture, so tables without textures are unchanged. "orm" is a packed
// occlusion (R) / roughness (G) / metallic (B) map, the glTF and Unreal convention. "kind" (optional, one of
// MATERIAL_KINDS) says how the material ages; it is data for the surface nodes and no exporter writes it.
//
// Geometry.merge (every node that merges) unions the tables, after making names distinct: a material or an
// "image:<name>" image that two inputs define differently is renamed in the later input (its table and prim
// `material` follow), so merged package outputs keep their own maps. The exporters and renderers union the tables of a
// geometry and its packed sources with mergeMaterialTables().
import type { Geometry } from './geometry.ts';

export interface Material {
  baseColor: [number, number, number];
  metallic: number;
  roughness: number;
  emissive: [number, number, number];
  alpha: number;
  /** Absent = auto: blend only when the material's own alpha is below 1 (vertex alpha never changes it). */
  alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND';
  alphaCutoff?: number;
  doubleSided: boolean;
  unlit: boolean;
  /**
   * texture file paths or "image:<name>" (absent = none): base colour (sRGB), tangent-space normal map, roughness
   * (grey), orm (occlusion R, roughness G, metallic B)
   */
  textures?: MaterialTextures;
  /**
   * What the material is made of and how it ages (one of MATERIAL_KINDS; absent = not said). Data only: exporters
   * ignore it, and bake_material writes a mask per kind.
   */
  kind?: string;
  /**
   * Metres one repeat of the material's maps covers on a metric uv (1 uv unit = 1 m): the maps are read at uv / tile.
   * Absent = the maps fill 0..1 of the uv. Data for the bakes; exporters write the maps as they are (an engine material
   * tiles them itself).
   */
  tile?: number;
  /**
   * Channel layout of the packed map (textures.orm), one letter per channel R, G, B (and A): o occlusion, r roughness,
   * m metallic, h height, s smoothness (1 − roughness), x unused. Absent = "orm" (glTF, Unreal). See parsePacking.
   */
  packing?: string;
  /** Green-channel convention of the normal map: absent = OpenGL (+Y up); "directx" = the green channel flipped. */
  normalFormat?: 'directx';
}

/**
 * The material kinds: how a surface ages. "keep" marks a part that is left as it is (glass, lights, dark slots).
 * Painted kinds have a coat that comes off (chips, peeling, flaking) over a substrate that then weathers on its own;
 * bare kinds have no coat and only stain, dull, rust or grow over.
 */
export const MATERIAL_KINDS = ['painted_metal', 'cast_metal', 'galvanised', 'bare_steel', 'stainless', 'plastic', 'rubber', 'concrete', 'painted_concrete', 'painted_plaster', 'painted_wood', 'bare_wood', 'asphalt', 'ceramic', 'decal', 'keep'] as const;

/** The channels a packed map can hold (parsePacking). */
export type PackedChannel = 'o' | 'r' | 'm' | 'h' | 's' | 'x';
/** Named channel layouts of a packed map: the glTF / Unreal one, and common others. */
export const PACKINGS: Readonly<Record<string, string>> = { orm: 'orm', arm: 'orm', hro: 'hro', rma: 'rma', mrao: 'mrox', mask_map: 'moxs' };

/**
 * A packed-map layout: one letter per channel (R, G, B and optionally A) from o (occlusion), r (roughness), m (metallic),
 * h (height), s (smoothness = 1 − roughness), x (unused), or a named layout (PACKINGS). Returns the letters, or a
 * message saying what is wrong.
 */
export function parsePacking(code: unknown): PackedChannel[] | string {
  const raw = String(code ?? '').trim().toLowerCase();
  const s = PACKINGS[raw] ?? raw;
  if (!/^[ormhsx]{3,4}$/.test(s)) return `packing "${String(code)}" is not a layout: 3 or 4 letters from o (occlusion), r (roughness), m (metallic), h (height), s (smoothness), x (unused), e.g. "orm" or "hro"; or one of ${Object.keys(PACKINGS).join(', ')}`;
  const letters = s.split('') as PackedChannel[];
  for (const c of 'ormhs') if (letters.filter((x) => x === c).length > 1) return `packing "${String(code)}" names ${c} twice`;
  if (letters.includes('r') && letters.includes('s')) return `packing "${String(code)}" holds both roughness and smoothness`;
  return letters;
}

export interface MaterialTextures { baseColor?: string; normal?: string; roughness?: string; orm?: string }

/** Texture slots in table order. */
export const TEXTURE_SLOTS = ['baseColor', 'normal', 'roughness', 'orm'] as const;

/**
 * The factors a material exports with, as glTF writes them (and materials.json of a textures export): a map replaces
 * its factor (a white base colour under a base colour map, roughness 1 under a separate roughness map); metallic, and
 * both factors beside an orm map, are the material's own. `has` says which maps are there (default: the ones it names).
 */
export function exportFactors(m: Material, has: (slot: keyof MaterialTextures) => boolean = (s) => !!m.textures?.[s]): { baseColor: [number, number, number]; roughness: number; metallic: number } {
  return {
    baseColor: has('baseColor') ? [1, 1, 1] : m.baseColor,
    roughness: has('roughness') && !has('orm') ? 1 : m.roughness,
    metallic: m.metallic,
  };
}

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
    ...(typeof m?.kind === 'string' && m.kind.trim() ? { kind: m.kind.trim() } : {}),
    ...(typeof m?.tile === 'number' && Number.isFinite(m.tile) && m.tile > 0 ? { tile: m.tile } : {}),
    ...(typeof m?.packing === 'string' && m.packing.trim() && m.packing.trim().toLowerCase() !== 'orm' ? { packing: m.packing.trim().toLowerCase() } : {}),
    ...(m?.normalFormat === 'directx' ? { normalFormat: 'directx' as const } : {}),
  };
}

/** Keep auto materials byte-compatible with existing graphs and fingerprints. */
function alphaFields(m: any): Pick<Material, 'alphaMode' | 'alphaCutoff'> {
  const mode = typeof m?.alphaMode === 'string' ? m.alphaMode.toUpperCase() : '';
  if (mode !== 'OPAQUE' && mode !== 'MASK' && mode !== 'BLEND') return {};
  return { alphaMode: mode, ...(mode === 'MASK' ? { alphaCutoff: Math.max(0, Math.min(1, num(m?.alphaCutoff, 0.5))) } : {}) };
}

/** The glTF alpha mode of a material: its own alpha_mode, else BLEND when its scalar alpha is below 1. Vertex alpha is data and never promotes it. */
export function materialAlphaMode(m: Material): 'OPAQUE' | 'MASK' | 'BLEND' {
  return m.alphaMode ?? (m.alpha < 1 ? 'BLEND' : 'OPAQUE');
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

/**
 * The whole names (lower case, as a material is called) that stand for a kind when nothing says it: a material called
 * "painted_steel" or "Paint" is painted metal. Whole names only: "worn_metal" or "dark_iron" could be several kinds.
 */
export const KIND_NAMES: Readonly<Record<string, readonly string[]>> = {
  painted_metal: ['painted_metal', 'painted_steel', 'paint'],
  cast_metal: ['cast_metal', 'cast_iron', 'cast'],
  galvanised: ['galvanised', 'galvanized', 'zinc', 'galvanised_steel'],
  bare_steel: ['bare_steel', 'steel', 'iron', 'bare_metal'],
  stainless: ['stainless', 'stainless_steel'],
  plastic: ['plastic'],
  rubber: ['rubber'],
  concrete: ['concrete', 'bare_concrete', 'precast_concrete'],
  painted_concrete: ['painted_concrete'],
  painted_plaster: ['painted_plaster', 'plaster'],
  painted_wood: ['painted_wood', 'wood_painted'],
  bare_wood: ['bare_wood', 'wood', 'timber'],
  asphalt: ['asphalt', 'roof_felt', 'bitumen'],
  ceramic: ['ceramic', 'tiles', 'ceramic_tiles'],
  decal: ['decal', 'label', 'sticker', 'sign', 'print'],
  keep: ['keep'],
};

export interface ResolvedKind {
  /** the kind ("" = none could be told) */
  kind: string;
  /** where it came from: the `kinds` map, the material's own kind field, or its whole name */
  from: 'kinds' | 'material' | 'name' | 'none';
  /** a kind that was written (kinds map or the material's field) but is not one of MATERIAL_KINDS */
  unknown?: string;
}

/**
 * The kind of a material, in this order: the entry for its name in `kinds`, its own `kind` field, its whole name
 * (case-insensitive) when that is a kind or one of its names (KIND_NAMES); else none. A written kind that is not in
 * MATERIAL_KINDS is reported in `unknown` and not replaced by a guess.
 */
export function resolveKind(name: string, material: Material | undefined, kinds?: Record<string, unknown> | null): ResolvedKind {
  const written = (v: unknown, from: 'kinds' | 'material'): ResolvedKind | null => {
    if (v === undefined || v === null || v === '') return null;
    const s = String(v);
    return (MATERIAL_KINDS as readonly string[]).includes(s) ? { kind: s, from } : { kind: '', from, unknown: s };
  };
  const a = kinds && Object.hasOwn(kinds, name) ? written(kinds[name], 'kinds') : null;
  if (a) return a;
  const b = written(material?.kind, 'material');
  if (b) return b;
  const lower = name.trim().toLowerCase();
  for (const [k, names] of Object.entries(KIND_NAMES)) if (names.includes(lower)) return { kind: k, from: 'name' };
  return { kind: '', from: 'none' };
}
