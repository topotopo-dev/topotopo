// Dense sampled distance fields; all heavy operations use the shared WASM kernel.
import { AttribTable, Geometry } from '../core/geometry.ts';
import type { SdfVolume } from '../core/geometry.ts';
import type { Vec3 } from '../core/math.ts';
import { SdfGrid, gridsOf, gridFromImplicit, gridToMeshMarchingCubes } from '../core/sdfgrid.ts';
import { TriBVH } from '../core/spatial.ts';
import { triangulate } from '../core/topology.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import type { ParamDef } from '../graph/types.ts';
import { loadHostKernels } from '../wasm/kernels.ts';
import { evalSdf } from './sdf.ts';
import type { KernelGrid, Kernels, DualContourResult } from '../wasm/kernels.ts';

const voxelParam: ParamDef = { type: 'float', default: 0.05, min: 0.000001, desc: 'grid spacing in world units; smaller voxels need more memory' };
const distanceParam: ParamDef = { type: 'float', default: 0.05, desc: 'distance in world units; positive grows the solid', aliases: ['d', 'amount'] };
const gridInput = [{ name: 'grid', desc: 'sampled SDF grid(s)' }];
const fromKernel = (g: KernelGrid, name: string) => new SdfGrid(Array.from(g.dims) as Vec3, Array.from(g.origin) as Vec3, g.voxel, g.values, name);
function requireGrids(g: Geometry): SdfGrid[] {
  const grids = gridsOf(g);
  if (!grids.length) throw new NodeError('input has no sampled SDF grid; use sdf_grid first');
  return grids;
}
function meshGrid(g: Geometry, k: Kernels, voxel: number, band: number, padding: number, fill: boolean): SdfGrid {
  const { tris } = triangulate(g);
  const points = Uint32Array.from(tris, v => g.vertexPoint[v]);
  return fromKernel(k.sdf_from_mesh(g.P, points, voxel, band, padding, fill), 'grid');
}
function contourGeometry(m: DualContourResult): Geometry {
  const g = new Geometry({ positions: m.positions });
  g.primStart = Int32Array.from(m.prim_start);
  g.vertexPoint = Int32Array.from(m.vertex_point);
  g.primClosed = new Uint8Array(m.prim_start.length - 1).fill(1);
  g.prims = new AttribTable(g.numPrims); g.vertices = new AttribTable(g.numVertices);
  (g.points.add('grid_cell', 'int', 1).data as Int32Array).set(m.cell_index);
  return g;
}

defineNode({
  type: 'sdf_grid', category: 'sdf',
  summary: 'Sample implicit SDF volumes or a polygon mesh into a regular 3D distance grid.',
  description: 'SDF volumes are unioned before sampling; if none exist, polygons are sampled using a triangle BVH and generalized winding-number sign. Values outside the narrow band are signed infinity unless fill is enabled. Grid bounds include padding in voxels. Mesh attributes are dropped. A field that runs user code (an sdf_expr upstream, also through transform, sdf_modify or sdf_combine) is sampled under the script timeout (TOPOTOPO_SCRIPT_TIMEOUT_MS, default 30 s): the whole grid must be sampled within it, else this node fails with "SDF code (sdf_expr) exceeded N ms" (raise voxel_size or the timeout). Implicit analytic volumes and meshes have no limit.',
  inputs: [{ name: 'source', desc: 'implicit SDF volume(s), or a polygon mesh' }],
  params: {
    voxel_size: voxelParam,
    band: { type: 'float', default: 3, min: 2, desc: 'exact narrow-band half width in voxels (at least 2 for gradients)' },
    padding: { type: 'float', default: 4, min: 1, desc: 'bounding-box padding in voxels; allow room for growth' },
    fill: { type: 'bool', default: true, desc: 'fill distances outside the exact band (fast sweeping for mesh inputs)' },
    name: { type: 'string', default: 'grid', desc: 'volume name' },
  },
  example: { type: 'sdf_grid', in: ['shape'], params: { voxel_size: 0.05, band: 3, fill: true } },
  cook: async (ctx) => {
    const { input, p, engine } = ctx;
    const src = input(0), sdfs = src.volumes.filter((v): v is SdfVolume => v.kind === 'sdf');
    let grid: SdfGrid;
    if (sdfs.length) {
      const bounds = { min: [0, 1, 2].map(a => Math.min(...sdfs.map(v => v.bounds.min[a]))) as Vec3,
        max: [0, 1, 2].map(a => Math.max(...sdfs.map(v => v.bounds.max[a]))) as Vec3 };
      const union = (x: number, y: number, z: number) => {
        let d = Infinity;
        for (const v of sdfs) d = Math.min(d, v.sample(x, y, z));
        return d;
      };
      // user code (sdf_expr) is sampled under the script timeout
      const field: SdfVolume = { name: p.name, kind: 'sdf', bounds, sample: union, scripted: sdfs.some(v => v.scripted) };
      grid = evalSdf(ctx, field, (sample) => gridFromImplicit(sample, bounds, p.voxel_size, p.padding * p.voxel_size, p.name));
      if (!p.fill) for (let i = 0; i < grid.values.length; i++) {
        const d = grid.values[i];
        if (Math.abs(d) > p.band * grid.voxel) grid.values[i] = d < 0 ? -Infinity : Infinity;
      }
    } else grid = meshGrid(src, await loadHostKernels(engine.host), p.voxel_size, p.band, p.padding, p.fill);
    grid.name = p.name;
    const out = new Geometry(); out.volumes = [grid]; return out;
  },
});

defineNode({
  type: 'grid_combine', category: 'sdf', summary: 'Boolean or smooth CSG on sampled SDF grids; B is resampled onto A.',
  description: 'The result keeps A\'s layout and clips to its bounds. Pad A before sampling if a union must include distant B. The first grid from each input is used; without B all A grids are combined.',
  inputs: [{ name: 'a', desc: 'grid A defines output layout' }, { name: 'b', desc: 'grid B', optional: true }],
  params: {
    operation: { type: 'enum', options: ['union', 'intersect', 'subtract', 'smooth_union', 'smooth_intersect', 'smooth_subtract'], default: 'union', desc: 'CSG operation', aliases: ['op'] },
    smooth: { type: 'float', default: 0.1, min: 0, desc: 'smooth CSG blend distance in world units', aliases: ['k'] },
  },
  example: { type: 'grid_combine', in: ['a', 'b'], params: { operation: 'smooth_union', smooth: 0.1 } },
  cook: async ({ input, hasInput, p, engine }) => {
    const a = requireGrids(input(0));
    const operands = hasInput(1) ? [a[0], requireGrids(input(1))[0]] : a;
    if (operands.length < 2) throw new NodeError('grid_combine needs input B or at least two grids in A');
    const k = await loadHostKernels(engine.host);
    let result = operands[0];
    for (const b of operands.slice(1)) result = fromKernel(k.grid_csg(result, b, p.operation, p.smooth), result.name);
    const out = new Geometry(); out.volumes = [result]; return out;
  },
});

// The definitions share the immutable volume adapter; each remains its own registry entry.
for (const type of ['grid_offset', 'grid_blur', 'grid_dilate', 'grid_erode', 'grid_resample'] as const) {
  const blur = type === 'grid_blur', resample = type === 'grid_resample';
  defineNode({
    type, category: 'sdf', inputs: gridInput,
    summary: { grid_offset: 'Offset sampled distances (positive grows the solid).', grid_blur: 'Separable box blur of sampled distances.', grid_dilate: 'Dilate the solid by subtracting a distance.', grid_erode: 'Erode the solid by adding a distance.', grid_resample: 'Resample distance grids at a new voxel spacing.' }[type],
    description: 'Creates new value arrays and preserves other input geometry. Offset/morphology/blur preserve bounds: use sufficient padding. Narrow-band infinities are distance sentinels; fill the source for large edits.',
    params: blur ? { radius: { type: 'int', default: 1, min: 0, max: 1024, desc: 'box-filter radius in voxels' } }
      : resample ? { voxel_size: voxelParam }
      : { distance: type === 'grid_offset' ? distanceParam : { ...distanceParam, min: 0, desc: 'nonnegative morphology distance in world units' } },
    example: { type, in: ['grid'], params: blur ? { radius: 1 } : resample ? { voxel_size: 0.08 } : { distance: 0.05 } },
    cook: async ({ input, p, engine }) => {
      const src = input(0); requireGrids(src);
      const k = await loadHostKernels(engine.host), out = src.clone();
      out.volumes = out.volumes.map(v => v.kind !== 'grid' ? v : fromKernel(k[type](v, blur ? p.radius : resample ? p.voxel_size : p.distance), v.name));
      return out;
    },
  });
}

defineNode({
  type: 'grid_to_mesh', category: 'sdf', summary: 'Extract sharp dual-contour triangles or smooth marching-cubes triangles from sampled grids.',
  description: 'No source attributes are transferred. Dual contouring records the lower-corner sample index as point grid_cell. Extraction is uniform: adaptive=true is currently unsupported. Closed surfaces must fit inside the grid with a positive boundary; increase source padding for offsets. Subvoxel features cannot be recovered.',
  inputs: gridInput,
  params: {
    method: { type: 'enum', options: ['dual_contouring', 'marching_cubes'], default: 'dual_contouring', desc: 'surface extraction method' },
    iso: { type: 'float', default: 0, desc: 'iso distance (+ grows)' },
    sharp: { type: 'bool', default: true, desc: 'QEF feature fitting (false uses Hermite intersection centroids)' },
    adaptive: { type: 'bool', default: false, desc: 'adaptive octree extraction (not implemented; true reports an error)' },
    qef_tolerance: { type: 'float', default: 0.000001, min: 1e-12, max: 1, desc: 'relative rank tolerance of the QEF solver' },
    clamp_to_cell: { type: 'bool', default: true, desc: 'constrain fitted points to their source cells' },
  },
  example: { type: 'grid_to_mesh', in: ['grid'], params: { method: 'dual_contouring', sharp: true } },
  cook: async ({ input, p, engine }) => {
    if (p.adaptive) throw new NodeError('grid_to_mesh: adaptive octree extraction is not implemented; use adaptive=false');
    const grids = requireGrids(input(0));
    if (p.method === 'marching_cubes') return Geometry.merge(grids.map(g => gridToMeshMarchingCubes(g, p.iso)));
    const k = await loadHostKernels(engine.host);
    return Geometry.merge(grids.map(g => contourGeometry(k.dual_contour(g, p.iso, p.qef_tolerance, p.sharp, p.clamp_to_cell))));
  },
});

defineNode({
  type: 'grid_to_sdf', category: 'sdf', summary: 'Expose each sampled grid as a lazy trilinear implicit SDF.',
  inputs: gridInput, params: {}, example: { type: 'grid_to_sdf', in: ['grid'] },
  cook: ({ input }) => {
    const src = input(0); requireGrids(src);
    const out = src.clone();
    out.volumes = out.volumes.map(v => v.kind !== 'grid' ? v : {
      kind: 'sdf' as const, name: v.name, bounds: v.bounds, sample: (x: number, y: number, z: number) => v.sample(x, y, z),
    });
    return out;
  },
});

/** Colour barycentrics on the nearest source triangle; material from the nearest face to each new face centre. */
function transferAttributes(source: Geometry, out: Geometry): void {
  const bvh = new TriBVH(source), color = source.findAttrib('Cd');
  if (color && color.attr.type === 'float' && color.attr.size === 3) {
    const dest = out.points.add('Cd', 'float', 3), a = color.attr.data as Float64Array;
    for (let i = 0; i < out.numPoints; i++) {
      const hit = bvh.closest(out.P[i * 3], out.P[i * 3 + 1], out.P[i * 3 + 2]);
      if (!hit) continue;
      const c = [0, 0, 0];
      for (let j = 0; j < 3; j++) {
        const idx = color.cls === 'vertex' ? bvh.triVtx[hit.tri * 3 + j] : color.cls === 'point' ? bvh.triPt[hit.tri * 3 + j] : color.cls === 'prim' ? hit.prim : 0;
        for (let axis = 0; axis < 3; axis++) c[axis] += a[idx * 3 + axis] * hit.bary[j];
      }
      dest.set(i, c);
    }
  }
  const mat = source.prims.get('material');
  if (mat) {
    const dest = out.prims.add('material', mat.type, mat.size);
    for (let p = 0; p < out.numPrims; p++) {
      const center = [0, 0, 0], start = out.primStart[p], end = out.primStart[p + 1];
      for (let v = start; v < end; v++) for (let a = 0; a < 3; a++) center[a] += out.P[out.vertexPoint[v] * 3 + a] / (end - start);
      const hit = bvh.closest(center[0], center[1], center[2]);
      if (hit) dest.set(p, mat.get(hit.prim));
    }
    const table = source.detail.get('materials');
    if (table) out.detail.add('materials', table.type, table.size).set(0, table.get(0));
    // Preserve embedded image references used by transferred material tables.
    out.volumes = source.volumes.filter(v => v.kind === 'image').map(v => v.clone());
  }
}

defineNode({
  type: 'voxel_remesh', category: 'sdf', summary: 'Mesh to sampled grid to sharp dual contouring in one operation.',
  description: 'Unions overlapping consistently oriented polygon shells by winding number. Uniform QEF contouring preserves resolved features. With transfer_attributes, Cd is interpolated on the nearest source triangle and material is chosen at each output face centre. Other attributes are dropped; UVs and exact seams are not retained.',
  inputs: [{ name: 'mesh', desc: 'polygon mesh (open shells use generalized winding-number sign)' }],
  params: {
    voxel_size: voxelParam,
    offset: { ...distanceParam, default: 0 },
    smooth_iterations: { type: 'int', default: 0, min: 0, max: 32, desc: 'passes of radius-1 distance-grid blur before contouring' },
    transfer_attributes: { type: 'bool', default: false, desc: 'transfer source Cd and material using nearest source triangles' },
  },
  example: { type: 'voxel_remesh', in: ['mesh'], params: { voxel_size: 0.05, transfer_attributes: true } },
  cook: async ({ input, p, engine }) => {
    const src = input(0), k = await loadHostKernels(engine.host);
    const pad = 4 + Math.ceil(Math.abs(p.offset) / p.voxel_size) + p.smooth_iterations;
    let grid = meshGrid(src, k, p.voxel_size, 3, pad, true);
    if (p.offset) grid = fromKernel(k.grid_offset(grid, p.offset), grid.name);
    for (let i = 0; i < p.smooth_iterations; i++) grid = fromKernel(k.grid_blur(grid, 1), grid.name);
    const out = contourGeometry(k.dual_contour(grid));
    if (p.transfer_attributes) transferAttributes(src, out);
    return out;
  },
});
