// Shared export options and helpers (axis/scale conversion, splitting by name, packed instances).
import type { Geometry } from '../core/geometry.ts';
import { DEFAULT_TRANSFER, expandPacked } from '../core/packed.ts';
import { qFromMat } from '../core/math.ts';
import type { Quat } from '../core/math.ts';

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
  /**
   * packed instances: 'packed' (default) writes native instancing where the format has it (glTF
   * EXT_mesh_gpu_instancing, USD PointInstancer; json keeps them losslessly) and expands them elsewhere;
   * 'expand' always writes real geometry.
   */
  instancing?: 'packed' | 'expand';
  /** receives non-fatal notes (instances expanded for a format without instancing, shear dropped, …) */
  warn?: (msg: string) => void;
}

/** A packed prim's 3×3 (9 numbers at X[o..]) in export space: C·X·Cᵀ with C the axis conversion (scale excluded). */
export function xfLinear(X: ArrayLike<number>, o: number, opt: ExportOptions): number[] {
  const m = Array.from({ length: 9 }, (_, k) => X[o + k]);
  if (opt.upAxis !== 'z') return m;
  // C: (x, y, z) → (x, -z, y). C·X maps each column the same way; ·Cᵀ then sets col1 = -col2, col2 = col1.
  const c = [0, 1, 2].map((j) => [m[j * 3], -m[j * 3 + 2], m[j * 3 + 1]]);
  return [...c[0], ...c[2].map((x) => -x), ...c[1]];
}

/** The geometry to write for a format without instancing: packed instances expanded, with one warning. */
export function expandForExport(g: Geometry, o: ExportOptions, format: string): Geometry {
  if (!g.hasPacked()) return g;
  if (o.instancing !== 'expand') o.warn?.(`${format}: ${g.numPacked} packed instances were expanded into geometry (${format} has no instancing; glb, gltf and usda keep instances)`);
  return expandPacked(g, { transfer: DEFAULT_TRANSFER }).geo;
}

/**
 * Split a 3×3 (column-major) into translation-free rotation (unit quaternion x, y, z, w) and per-axis scale, for
 * TRS instance formats. A mirrored matrix gets a negative x scale. Shear cannot be represented: the rotation is
 * then the nearest one (polar decomposition by iteration) and `shear` is true.
 */
export function decomposeXform(X: ArrayLike<number>, o = 0): { q: Quat; s: [number, number, number]; shear: boolean } {
  const c = [0, 1, 2].map((j) => [X[o + j * 3], X[o + j * 3 + 1], X[o + j * 3 + 2]]);
  const s = c.map((v) => Math.hypot(v[0], v[1], v[2])) as [number, number, number];
  const det = c[0][0] * (c[1][1] * c[2][2] - c[1][2] * c[2][1]) - c[1][0] * (c[0][1] * c[2][2] - c[0][2] * c[2][1]) + c[2][0] * (c[0][1] * c[1][2] - c[0][2] * c[1][1]);
  if (det < 0) s[0] = -s[0];
  const R = c.map((v, j) => (s[j] ? v.map((x) => x / s[j]) : [j === 0 ? 1 : 0, j === 1 ? 1 : 0, j === 2 ? 1 : 0]));
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const shear = Math.abs(dot(R[0], R[1])) > 1e-6 || Math.abs(dot(R[0], R[2])) > 1e-6 || Math.abs(dot(R[1], R[2])) > 1e-6;
  let M = R;
  if (shear) {
    // polar decomposition: M ← (M + M⁻ᵀ) / 2 converges to the closest rotation
    for (let it = 0; it < 30; it++) {
      const [a, b, d] = M;
      const cr = (u: number[], v: number[]) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const dt = dot(a, cr(b, d)) || 1;
      const inv = [cr(b, d), cr(d, a), cr(a, b)].map((v) => v.map((x) => x / dt)); // columns of M⁻ᵀ
      M = M.map((v, j) => v.map((x, k) => (x + inv[j][k]) / 2));
    }
  }
  const m = new Float64Array(16);
  for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) m[j * 4 + k] = M[j][k];
  m[15] = 1;
  return { q: qFromMat(m), s, shear };
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
