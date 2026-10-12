// Shared export options and helpers (axis/scale conversion, splitting by name).
import type { Geometry } from '../core/geometry.ts';

export interface ExportOptions {
  /** multiply positions (e.g. 100 for metres → centimetres) */
  scale?: number;
  /** 'y' (default) or 'z' to convert to a Z-up convention */
  upAxis?: 'y' | 'z';
  /** split into separate meshes/objects by the prim string attribute "name" */
  splitByName?: boolean;
  /** cusp angle for computed normals */
  cuspAngle?: number;
  /**
   * include extra numeric attributes (glTF `_NAME` accessors, PLY properties, USD primvars).
   * glTF default: true; PLY default: true; USD default: false.
   */
  custom?: boolean;
  /** glTF: write NORMAL (N if present, else computed with cuspAngle). false = only when N exists. Default true. */
  normals?: boolean;
  /** glTF: 'none' (default), 'meshopt' (EXT_meshopt_compression + KHR_mesh_quantization), 'draco' (needs draco3dgltf) */
  compress?: 'none' | 'meshopt' | 'draco';
  /** glTF: KHR_mesh_quantization (16-bit positions, 8-bit normals, 16-bit uv/colour) without compression */
  quantize?: boolean;
  /** glTF: write materials from the prim "material" attribute and the detail table (default true) */
  materials?: boolean;
  /** glTF: polylines as one LINE_STRIP per curve ('strip', default) or one LINES primitive ('lines') */
  lineMode?: 'strip' | 'lines';
  /** csv / points JSON: point attributes to write (names or a comma/space separated list; default all) */
  attributes?: string[] | string;
  /** csv: Unreal PCG columns (Position/Rotation/Scale/Density/Color/Seed) in Unreal space (Z-up, left-handed, cm) */
  pcg?: boolean;
  /** csv with pcg: one Unreal struct-text cell per vector ("(X=…,Y=…,Z=…)"), for DataTable import with a row struct */
  pcgStruct?: boolean;
  /** geo: float storage, 64 (fpreal64, lossless, default) or 32 (fpreal32, Houdini's default) */
  precision?: 32 | 64;
}

/** Position conversion for export: scale, then optional Y-up → Z-up (right-handed: x, -z, y). */
export function xf(x: number, y: number, z: number, o: ExportOptions): [number, number, number] {
  const s = o.scale ?? 1;
  return o.upAxis === 'z' ? [x * s, -z * s, y * s] : [x * s, y * s, z * s];
}

/** Direction conversion (no scale). */
export function xfDir(x: number, y: number, z: number, o: ExportOptions): [number, number, number] {
  return o.upAxis === 'z' ? [x, -z, y] : [x, y, z];
}

/** Points not referenced by any primitive (1 = isolated). */
export function isolatedMask(g: Geometry): Uint8Array {
  const used = new Uint8Array(g.numPoints);
  for (let v = 0; v < g.numVertices; v++) used[g.vertexPoint[v]] = 1;
  return used.map((u) => (u ? 0 : 1));
}

/** Split by the prim string attribute "name" (when splitByName); isolated points become a "points" piece. */
export function pieces(g: Geometry, o: ExportOptions): { name: string; geo: Geometry }[] {
  const na = g.prims.get('name');
  if (!o.splitByName || !na || na.type !== 'string') return [{ name: 'mesh', geo: g }];
  const names = [...new Set(na.data as string[])];
  if (names.length <= 1) return [{ name: names[0] || 'mesh', geo: g }];
  const out = names.map((n) => ({ name: n || 'unnamed', geo: g.subsetPrims(Uint8Array.from(na.data as string[], (x) => (x === n ? 1 : 0))) }));
  const iso = isolatedMask(g);
  if (iso.some((u) => u)) out.push({ name: 'points', geo: g.subsetPoints(iso) });
  return out;
}

/** Normalise an attribute list option to names (empty = all). */
export function attributeList(a: string[] | string | undefined): string[] {
  if (!a) return [];
  const list = Array.isArray(a) ? a : String(a).split(/[\s,]+/);
  return list.map((s) => String(s).trim()).filter(Boolean);
}
