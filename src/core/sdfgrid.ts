// Sampled signed distance volumes. Samples sit at grid nodes, with X varying fastest:
// index = x + nx * (y + ny * z), world = origin + voxel * [x, y, z].
// Negative values are inside. Narrow bands keep signed infinities outside the band.
// Geometry.clone() shares the immutable sample array; call writable() before editing.
import { Geometry } from './geometry.ts';
import type { GridVolume, Volume } from './geometry.ts';
import type { Vec3 } from './math.ts';
import { M, fromManifold, propLayout } from './manifold.ts';

export type GridDims = [number, number, number];
export interface GridBounds { min: Vec3; max: Vec3 }
/** Dense grids are bounded to keep accidental allocations manageable in Node and browsers. */
export const MAX_GRID_SAMPLES = 64 * 1024 * 1024;

export class SdfGrid implements GridVolume {
  readonly kind = 'grid' as const;
  name: string;
  dims: GridDims;
  origin: Vec3;
  voxel: number;
  values: Float32Array;

  constructor(dims: GridDims, origin: Vec3, voxel: number, values?: Float32Array, name = 'grid') {
    if (dims.length !== 3 || dims.some((n) => !Number.isSafeInteger(n) || n < 2)) throw new Error('SDF grid dimensions must be three integers >= 2');
    const count = dims[0] * dims[1] * dims[2];
    if (!Number.isSafeInteger(count) || count > MAX_GRID_SAMPLES) throw new Error(`SDF grid needs ${count} samples; limit is ${MAX_GRID_SAMPLES} (increase voxel_size)`);
    if (!Number.isFinite(voxel) || voxel <= 0) throw new Error('SDF grid voxel size must be finite and > 0');
    if (origin.length !== 3 || origin.some((n) => !Number.isFinite(n))) throw new Error('SDF grid origin must have three finite coordinates');
    if (dims.some((n, a) => !Number.isFinite(origin[a] + (n - 1) * voxel) || (n - 1) * voxel > 3.4028234663852886e38 / 16)) throw new Error('SDF grid bounds overflow; reduce voxel size or origin');
    if (dims.some((n, a) => origin[a] + voxel <= origin[a] || origin[a] + (n - 1) * voxel <= origin[a] + (n - 2) * voxel)) throw new Error('SDF grid voxel spacing is not representable at this origin/extent; increase voxel size or move the grid closer to zero');
    if (values !== undefined && !(values instanceof Float32Array)) throw new Error('SDF grid values must be a Float32Array');
    if (values && values.length !== count) throw new Error(`SDF grid has ${values.length} values; expected ${count}`);
    if (values) for (let i = 0; i < values.length; i++) if (Number.isNaN(values[i])) throw new Error(`SDF grid value ${i} is NaN (signed infinities are allowed)`);
    this.dims = [...dims];
    this.origin = [...origin];
    this.voxel = voxel;
    this.values = values ?? new Float32Array(count).fill(Infinity);
    this.name = name;
  }

  get count(): number { return this.values.length; }
  get bounds(): GridBounds {
    return { min: [...this.origin], max: this.dims.map((n, a) => this.origin[a] + (n - 1) * this.voxel) as Vec3 };
  }
  index(x: number, y: number, z: number): number { return x + this.dims[0] * (y + this.dims[1] * z); }

  /**
   * Trilinear sample in world space; +Infinity outside the sampled domain. Zero-weight corners are ignored.
   * A mixed finite/infinite cell uses a signed domain-diagonal cap for absent distances. An entirely infinite
   * cell of one sign retains its infinity. Sampling does not invent exact distances outside a narrow band.
   */
  sample(x: number, y: number, z: number): number {
    const nx = this.dims[0], ny = this.dims[1], nz = this.dims[2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || x < this.origin[0] || y < this.origin[1] || z < this.origin[2] || x > this.origin[0] + (nx - 1) * this.voxel || y > this.origin[1] + (ny - 1) * this.voxel || z > this.origin[2] + (nz - 1) * this.voxel) return Infinity;
    // Compare world coordinates before clamping: dividing an exact boundary node by voxel can overshoot by an ULP.
    const fx = Math.max(0, Math.min(nx - 1, (x - this.origin[0]) / this.voxel));
    const fy = Math.max(0, Math.min(ny - 1, (y - this.origin[1]) / this.voxel));
    const fz = Math.max(0, Math.min(nz - 1, (z - this.origin[2]) / this.voxel));
    const ix = Math.min(nx - 2, Math.floor(fx)), iy = Math.min(ny - 2, Math.floor(fy)), iz = Math.min(nz - 2, Math.floor(fz));
    const tx = fx - ix, ty = fy - iy, tz = fz - iz;
    let sum = 0, allPositive = true, allNegative = true, allNegativeZero = true, cap = 0;
    for (let c = 0; c < 8; c++) {
      const dx = c & 1, dy = (c >>> 1) & 1, dz = c >>> 2;
      const weight = (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty) * (dz ? tz : 1 - tz);
      if (!weight) continue;
      const value = this.values[ix + dx + nx * (iy + dy + ny * (iz + dz))];
      allPositive &&= value === Infinity;
      allNegative &&= value === -Infinity;
      allNegativeZero &&= Object.is(value, -0);
      if (Number.isFinite(value)) sum += weight * value;
      else {
        if (!cap) {
          const ex = (nx - 1) * this.voxel, ey = (ny - 1) * this.voxel, ez = (nz - 1) * this.voxel;
          cap = Math.sqrt(ex * ex + ey * ey + ez * ez) + this.voxel;
        }
        sum += weight * (value < 0 ? -cap : cap);
      }
    }
    if (allPositive) return Infinity;
    if (allNegative) return -Infinity;
    if (allNegativeZero) return -0;
    return sum;
  }

  clone(): SdfGrid { return new SdfGrid(this.dims, this.origin, this.voxel, this.values, this.name); }
  /** Make this grid's sample array private before modifying it. */
  writable(): Float32Array { this.values = this.values.slice(); return this.values; }
}

export function isSdfGrid(v: Volume): v is GridVolume { return v.kind === 'grid'; }
export function asSdfGrid(v: GridVolume): SdfGrid { return v instanceof SdfGrid ? v : new SdfGrid(v.dims, v.origin, v.voxel, v.values, v.name); }
export function gridsOf(g: Geometry): SdfGrid[] { return g.volumes.filter(isSdfGrid).map(asSdfGrid); }

/** Sample an implicit function at every grid node. Padding is measured in world units. */
export function gridFromImplicit(sample: (x: number, y: number, z: number) => number, bounds: GridBounds, voxel: number, padding = 0, name = 'grid'): SdfGrid {
  if (!Number.isFinite(voxel) || voxel <= 0) throw new Error('SDF grid voxel size must be finite and > 0');
  if (!Number.isFinite(padding) || padding < 0) throw new Error('SDF grid padding must be finite and >= 0');
  if (bounds.min.length !== 3 || bounds.max.length !== 3 || bounds.min.some((v, a) => !Number.isFinite(v) || !Number.isFinite(bounds.max[a]) || bounds.max[a] < v)) throw new Error('SDF grid bounds must be finite and ordered');
  const origin = bounds.min.map((v) => v - padding) as Vec3;
  const dims = bounds.max.map((v, a) => Math.max(2, Math.ceil((v + padding - origin[a]) / voxel) + 1)) as GridDims;
  const grid = new SdfGrid(dims, origin, voxel, undefined, name);
  const [nx, ny, nz] = dims;
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const value = sample(origin[0] + x * voxel, origin[1] + y * voxel, origin[2] + z * voxel);
    if (typeof value !== 'number' || Number.isNaN(value)) throw new Error(`SDF sample is not a number or is NaN at grid node (${x}, ${y}, ${z})`);
    if (Number.isFinite(value) && !Number.isFinite(Math.fround(value))) throw new Error(`SDF sample overflows float32 at grid node (${x}, ${y}, ${z})`);
    grid.values[x + nx * (y + ny * z)] = value;
  }
  return grid;
}

/**
 * Existing manifold level-set path, also used by the renderer. This is the smooth marching-cubes fallback;
 * the optional resolution cap limits preview work. Source attributes are deliberately not transferred.
 */
export function gridToMeshMarchingCubes(volume: GridVolume, iso = 0, maxResolution?: number): Geometry {
  if (!Number.isFinite(iso)) throw new Error('SDF grid isovalue must be finite');
  if (maxResolution !== undefined && (!Number.isFinite(maxResolution) || maxResolution < 1)) throw new Error('SDF grid preview resolution must be >= 1');
  const grid = asSdfGrid(volume), b = grid.bounds;
  const edge = grid.voxel * (maxResolution === undefined ? 1 : Math.max(1, Math.ceil((Math.max(...grid.dims) - 1) / maxResolution)));
  const cap = Math.max(Math.abs(iso) + edge, (Math.hypot(...grid.dims) + 1) * grid.voxel);
  const sample = (q: number[]) => {
    const d = grid.sample(q[0], q[1], q[2]);
    return d === Infinity ? -cap : d === -Infinity ? cap : -d;
  };
  const mesh = M().Manifold.levelSet(sample, { min: b.min.map((v) => v - edge), max: b.max.map((v) => v + edge) }, edge, -iso);
  try { return fromManifold(mesh, propLayout([])).geo; }
  finally { mesh.delete(); }
}

/** Replace only sampled SDF volumes with bounded-resolution surface previews. */
export function withSdfGridPreview(g: Geometry, maxResolution = 64): Geometry {
  if (!g.volumes.some(isSdfGrid)) return g;
  const rest = g.clone();
  rest.volumes = rest.volumes.filter((v) => !isSdfGrid(v));
  const previews = g.volumes.filter(isSdfGrid).map((v) => gridToMeshMarchingCubes(v, 0, maxResolution));
  return Geometry.merge([rest, ...previews]);
}

/** Exact layout transforms: translation, uniform scale, axis mirrors and multiples of 90 degrees. */
export function transformSdfGrid(volume: GridVolume, m: ArrayLike<number>): SdfGrid {
  const grid = asSdfGrid(volume);
  if (m.length !== 16 || Array.from(m).some((v) => !Number.isFinite(v))) throw new Error('SDF grid transform requires a finite 4x4 matrix');
  const scales = [0, 1, 2].map((a) => Math.hypot(m[a * 4], m[a * 4 + 1], m[a * 4 + 2]));
  const scale = scales[0], eps = scale * 1e-8;
  const fail = () => new Error('SDF grids support translation, uniform scale and axis-aligned rotations/mirrors; use grid_to_sdf before an arbitrary rotation or nonuniform scale');
  if (!(scale > 0) || scales.some((s) => Math.abs(s - scale) > eps) || Math.abs(m[3]) > 1e-12 || Math.abs(m[7]) > 1e-12 || Math.abs(m[11]) > 1e-12 || Math.abs(m[15] - 1) > 1e-12) throw fail();
  const axes: number[] = [], signs: number[] = [];
  for (let dst = 0; dst < 3; dst++) {
    let axis = -1, sign = 1;
    for (let src = 0; src < 3; src++) {
      const value = m[src * 4 + dst];
      if (Math.abs(value) <= eps) continue;
      if (axis !== -1 || Math.abs(Math.abs(value) - scale) > eps) throw fail();
      axis = src; sign = value < 0 ? -1 : 1;
    }
    if (axis === -1 || axes.includes(axis)) throw fail();
    axes.push(axis); signs.push(sign);
  }
  const dims = axes.map((a) => grid.dims[a]) as GridDims;
  const origin = axes.map((a, dst) => signs[dst] * scale * (grid.origin[a] + (signs[dst] < 0 ? (grid.dims[a] - 1) * grid.voxel : 0)) + m[12 + dst]) as Vec3;
  if (axes.every((a, dst) => a === dst && signs[dst] === 1) && scale === 1) return new SdfGrid(dims, origin, grid.voxel, grid.values, grid.name);
  const out = new SdfGrid(dims, origin, grid.voxel * scale, undefined, grid.name);
  const source = [0, 0, 0];
  for (let z = 0; z < dims[2]; z++) for (let y = 0; y < dims[1]; y++) for (let x = 0; x < dims[0]; x++) {
    const target = [x, y, z];
    for (let dst = 0; dst < 3; dst++) source[axes[dst]] = signs[dst] > 0 ? target[dst] : dims[dst] - 1 - target[dst];
    const value = grid.values[grid.index(source[0], source[1], source[2])], scaled = value * scale;
    if (Number.isFinite(value) && !Number.isFinite(Math.fround(scaled))) throw new Error('SDF grid transform overflows float32 distances; reduce uniform scale');
    out.values[out.index(x, y, z)] = scaled;
  }
  return out;
}

/** JSON has no infinities and erases -0: explicit sentinels preserve every sample bit exactly. */
export function gridToJSON(v: GridVolume) {
  return { name: v.name, dims: [...v.dims], origin: [...v.origin], voxel: v.voxel, values: Array.from(v.values, (n) => n === Infinity ? '+Infinity' : n === -Infinity ? '-Infinity' : Object.is(n, -0) ? '-0' : n) };
}

export function gridFromJSON(j: any): SdfGrid {
  if (!Array.isArray(j?.dims) || !Array.isArray(j?.origin) || !Array.isArray(j?.values)) throw new Error('SDF grid JSON needs dims, origin and values arrays');
  // Validate the layout before allocating an array supplied by an untrusted file.
  const grid = new SdfGrid(j.dims as GridDims, j.origin as Vec3, j.voxel, undefined, typeof j.name === 'string' ? j.name : 'grid');
  if (j.values.length !== grid.count) throw new Error(`SDF grid JSON has ${j.values.length} values; expected ${grid.count}`);
  for (let i = 0; i < grid.count; i++) {
    const v = j.values[i];
    if (v === '+Infinity') grid.values[i] = Infinity;
    else if (v === '-Infinity') grid.values[i] = -Infinity;
    else if (v === '-0') grid.values[i] = -0;
    else if (typeof v === 'number' && Number.isFinite(v) && Number.isFinite(Math.fround(v))) grid.values[i] = v;
    else throw new Error(`SDF grid JSON value ${i} must be finite or a signed Infinity/-0 string`);
  }
  return grid;
}

export function sdfGridSummary(g: Geometry): string[] {
  return gridsOf(g).map((v) => {
    let finite = 0;
    for (let i = 0; i < v.values.length; i++) if (Number.isFinite(v.values[i])) finite++;
    return `SDF grid "${v.name}": ${v.dims.join(' × ')} samples, voxel ${v.voxel} m, ${finite} finite / ${v.count} total`;
  });
}
