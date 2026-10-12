// Material data carried with geometry (not shading): a prim string attribute `material` names a material,
// and a detail string attribute `materials` holds the table as JSON:
//   { "name": { "baseColor": [r,g,b], "metallic": 0, "roughness": 0.5, "emissive": [r,g,b], "alpha": 1,
//               "doubleSided": false, "unlit": false } }
// Exporters turn the table into glTF materials. Houdini's `shop_materialpath` is accepted on import (basename).
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
  doubleSided: boolean;
  unlit: boolean;
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
    doubleSided: typeof m?.doubleSided === 'boolean' ? m.doubleSided : d.doubleSided,
    unlit: typeof m?.unlit === 'boolean' ? m.unlit : d.unlit,
  };
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
