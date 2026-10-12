// Remeshing, decimation, repair and LOD nodes: remesh_isotropic, decimate, mesh_repair, lod.
// Kernels: core/remesh.ts (isotropic remeshing), core/decimate.ts (meshoptimizer), core/repair.ts.
import { Attribute, Geometry } from '../core/geometry.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import { RemeshError, isotropicRemesh } from '../core/remesh.ts';
import { DecimateError, decimateMesh, decimatePoints, parseSteerAttribs } from '../core/decimate.ts';
import type { DecimateOptions } from '../core/decimate.ts';
import { repairMesh, repairSummary } from '../core/repair.ts';
import type { NonManifoldMode, SelfIntersectMode } from '../core/repair.ts';
import { P, edgeMask, mask } from './util.ts';

/** Run a kernel and turn its own errors into node errors. */
function guard<T>(fn: () => T, hint?: string): T {
  try {
    return fn();
  } catch (e: any) {
    if (e instanceof RemeshError || e instanceof DecimateError) throw new NodeError(e.message, hint);
    throw e;
  }
}

/** Point mask for a point group param where "" means none (mask() treats "" as all). */
function pointMaskOrNone(g: Geometry, pattern: string): Uint8Array | null {
  return pattern ? mask(g, 'point', pattern) ?? new Uint8Array(g.numPoints).fill(1) : null;
}

// ---------------------------------------------------------------- remesh_isotropic

defineNode({
  type: 'remesh_isotropic',
  category: 'topology',
  summary: 'Isotropic remesh (Botsch–Kobbelt): even triangles of a target edge length on the input surface; keeps sharp edges, seams, boundaries and attributes.',
  description:
    'Houdini: Remesh SOP (Target Size, Iterations, Hard Edges, adaptive sizing). Each iteration splits edges longer ' +
    'than 4/3·L, collapses edges shorter than 4/5·L, flips edges toward valence 6, relaxes points tangentially and ' +
    'projects them back onto the input with a BVH. Polygons are triangulated first; the output is triangles. ' +
    'Feature edges (dihedral angle above feature_angle, uv/vertex-attribute seams, borders between prims with ' +
    'different string attributes or prim groups, the edge_groups) are never flipped, are resampled along themselves ' +
    'and keep their points on the input feature curve; corners where 3+ features meet stay fixed. Boundaries are ' +
    'resampled along themselves unless preserve_boundary. With group, only those prims are remeshed and the border ' +
    'of the group stays exactly as it was. Adaptive: target_attrib is a point float attribute with the wanted edge ' +
    'length per point (e.g. from measure curvature or a distance), interpolated on the surface. Attributes: point ' +
    'attributes are interpolated at each new point\'s closest location on the input, vertex attributes (uv) the same ' +
    'way per side of each seam, prim attributes and groups come from the input prim under each face. ' +
    'Which remesh? remesh_isotropic keeps the surface, its sharp edges, boundaries and attributes (use it before ' +
    'uv_unwrap, decimate/lod, simulation); remesh (voxel) rebuilds a closed, possibly self-intersecting or broken ' +
    'mesh through an SDF: always watertight, but sharp edges round off and attributes are dropped.',
  aliases: ['remesh_iso', 'isotropic_remesh'],
  inputs: [{ name: 'geo', desc: 'polygon mesh' }],
  params: {
    target_length: { type: 'float', default: 0, min: 0, desc: 'target edge length L (0 = mean edge length of the input or group)', aliases: ['edge_length', 'target_size', 'length', 'size'] },
    iterations: { type: 'int', default: 6, min: 0, max: 50, desc: 'split / collapse / flip / relax rounds (more = more even; 5–10 is typical)', aliases: ['iters'] },
    target_attrib: { type: 'string', default: '', desc: 'point float attribute giving the target edge length per point (adaptive density); "" = uniform target_length', aliases: ['size_attrib', 'adaptive_attrib'] },
    feature_angle: { type: 'float', default: 45, min: 0, max: 180, desc: 'edges whose faces meet at more than this angle (degrees) are kept as sharp features (0 = no automatic features)', aliases: ['hard_angle', 'sharp_angle'] },
    preserve_boundary: { type: 'bool', default: false, desc: 'keep boundary points and edges exactly (off = resample the boundary along itself; corners stay)' },
    group: P.group('prim', 'prims to remesh ("" = all); the border of the group stays fixed'),
    edge_groups: { type: 'group', default: '', groupClass: 'edge', desc: 'edge group(s) or pattern to keep as feature edges ("" = none), e.g. "creases" or "seam*"; named groups follow the new feature edges', aliases: ['hard_edges', 'features'] },
    keep_prim_borders: { type: 'bool', default: true, desc: 'keep borders between prims with different string attributes (name, material) or prim groups as feature edges' },
    relax_passes: { type: 'int', default: 1, min: 1, max: 10, desc: 'relaxation + projection passes per iteration', advanced: true },
    max_triangles: { type: 'int', default: 4000000, min: 1000, desc: 'refuse to run when the estimated output has more triangles than this', advanced: true },
  },
  outputs: 'triangles; point/vertex/prim attributes and groups by provenance; feature edge groups (edge_groups) follow the new edges',
  example: { type: 'remesh_isotropic', params: { target_length: 0.05, iterations: 8, feature_angle: 40 } },
  cook: ({ input, p, stat }) => {
    const g = input(0);
    const sel = mask(g, 'prim', p.group);
    const featureEdges = p.edge_groups ? edgeMask(g, p.edge_groups) : null;
    const featureGroups = p.edge_groups ? g.groupNames('edge').filter((n) => String(p.edge_groups).split(/[\s,]+/).some((t: string) => globMatch(t, n))) : [];
    const r = guard(() => isotropicRemesh(g, {
      iterations: p.iterations, targetLength: p.target_length, targetAttrib: p.target_attrib, featureAngle: p.feature_angle,
      preserveBoundary: p.preserve_boundary, group: sel, featureEdges, featureGroups, keepPrimBorders: p.keep_prim_borders,
      relaxPasses: p.relax_passes, maxTriangles: p.max_triangles,
    }), 'set target_length (scene units) or iterations; the input needs polygons');
    stat('triangles', r.outputTriangles);
    stat('target_length', r.targetLength);
    stat('feature_edges', r.stats.features);
    return r.geo;
  },
});

/** Houdini-style glob ("*", "?") match of a group name against one pattern token. */
function globMatch(tok: string, name: string): boolean {
  if (!tok || /[^\w*?]/.test(tok)) return false;
  const re = new RegExp('^' + tok.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  return re.test(name);
}

// ---------------------------------------------------------------- decimate

defineNode({
  type: 'decimate',
  category: 'topology',
  summary: 'Reduce triangle count while preserving shape, uv seams and attributes (meshoptimizer). Output is triangles; also thins point clouds.',
  description:
    'Houdini: PolyReduce SOP. Polygons are triangulated first and the result is triangles. meshoptimizer ' +
    'simplifyWithAttributes collapses edges by quadric error: corners whose vertex attributes differ (uv seams, hard ' +
    'normals) and borders between prims with different string attributes or prim groups stay intact, and the ' +
    '"attributes" (float point or vertex attributes with weights) steer which edges go. Points keep their exact ' +
    'positions and attributes (meshoptimizer only removes points); corners copy the corner they stand for. ' +
    'max_error stops early (relative to the mesh extent, or in scene units with error_absolute); the achieved error ' +
    'is written to detail "error" (and "error_abs" in scene units). prune lets whole small pieces vanish; ' +
    'aggressive (sloppy) ignores topology and seams to reach any target. group decimates only those prims (points ' +
    'shared with other prims stay; sparse speeds up small groups of big meshes). mode points (or auto on a point ' +
    'cloud) thins points with simplifyPoints, keeping an even spread and the point_attributes (Cd, pscale).',
  aliases: ['polyreduce', 'simplify', 'reduce', 'decimate_points'],
  inputs: [{ name: 'geo', desc: 'polygon mesh or point cloud' }],
  params: {
    ratio: { type: 'float', default: 0.25, min: 0, max: 1, desc: 'target fraction of triangles (or points) to keep', aliases: ['percentage', 'keep'] },
    target_count: { type: 'int', default: 0, min: 0, desc: 'target number of triangles (points in points mode); > 0 overrides ratio', aliases: ['count', 'target', 'final_count'] },
    max_error: { type: 'float', default: 0.05, min: 0, desc: 'stop when the deviation reaches this (relative to the mesh extent, or scene units with error_absolute)', aliases: ['error', 'target_error'] },
    error_absolute: { type: 'bool', default: false, desc: 'max_error (and detail "error") in scene units instead of relative to the mesh size' },
    lock_border: { type: 'bool', default: true, desc: 'keep open borders fixed (tiles and pieces still stitch)' },
    attributes: { type: 'string', default: 'uv N Cd', desc: 'float point/vertex attributes that steer the reduction, with optional weights: "uv:2 N:0.5 Cd" (weight 1 ≈ a change of 1 costs like moving across the whole mesh); missing ones are skipped', aliases: ['attribs', 'weights'] },
    prune: { type: 'bool', default: false, desc: 'allow small disconnected pieces to disappear entirely' },
    sparse: { type: 'bool', default: false, desc: 'faster when the group is a small part of a big mesh (use error_absolute for consistent errors)', advanced: true },
    regularize: { type: 'bool', default: false, desc: 'favour evenly sized triangles over exact shape', advanced: true },
    aggressive: { type: 'bool', default: false, desc: 'sloppy mode: ignores topology and seams, reaches any target', aliases: ['sloppy'] },
    group: P.group('prim', 'prims to decimate ("" = all); points shared with other prims stay'),
    lock: { type: 'group', default: '', groupClass: 'point', desc: 'point group that must not move or disappear ("" = none)', aliases: ['lock_points'] },
    mode: { type: 'enum', options: ['auto', 'mesh', 'points'], default: 'auto', desc: 'auto = points when the input has no polygons; points thins a point cloud' },
    point_attributes: { type: 'string', default: 'Cd pscale', desc: 'points mode: float point attributes kept apart (up to 3 components in total, with optional weights)' },
  },
  outputs: 'triangles; detail float error, error_abs; points mode keeps the chosen points with all attributes',
  example: { type: 'decimate', params: { ratio: 0.2, attributes: 'uv:1 N:0.5' } },
  cook: ({ input, p, warn, stat }) => {
    const g = input(0);
    let hasPolys = false;
    for (let pr = 0; pr < g.numPrims && !hasPolys; pr++) if (g.primClosed[pr] && g.primSize(pr) >= 3) hasPolys = true;
    if (p.mode === 'points' || (p.mode === 'auto' && !hasPolys)) {
      const attrs = guard(() => parseSteerAttribs(p.point_attributes));
      const r = decimatePoints(g, { ratio: p.ratio, targetCount: p.target_count, attributes: attrs });
      stat('points', r.kept);
      return r.geo;
    }
    const opts: DecimateOptions = {
      ratio: p.ratio, targetCount: p.target_count, maxError: p.max_error, errorAbsolute: p.error_absolute,
      lockBorder: p.lock_border, prune: p.prune, sparse: p.sparse, regularize: p.regularize, sloppy: p.aggressive,
      attributes: guard(() => parseSteerAttribs(p.attributes)), group: mask(g, 'prim', p.group), lockPoints: pointMaskOrNone(g, p.lock),
    };
    const r = guard(() => decimateMesh(g, opts));
    if (r.skipped.length) warn(`decimate: attributes ${r.skipped.join(', ')} cannot steer (only float point/vertex attributes, 32 floats in total)`);
    const out = r.geo;
    (out.detail.add('error', 'float', 1).data as Float64Array)[0] = r.error;
    (out.detail.add('error_abs', 'float', 1).data as Float64Array)[0] = r.errorAbs;
    stat('triangles', r.trisOut);
    return out;
  },
});

// ---------------------------------------------------------------- mesh_repair

defineNode({
  type: 'mesh_repair',
  category: 'topology',
  summary: 'Diagnose and fix meshes: fuse duplicates, degenerate/duplicate faces, non-manifold edges, winding, small holes, self-intersections.',
  description:
    'Houdini: PolyDoctor SOP (plus Clean). Steps run in this order, each can be switched off: fuse points within ' +
    'tolerance; drop repeated points and faces with < 3 distinct points, zero-area triangles hand their middle point ' +
    'to the neighbour across their long side (no slit is left); duplicate faces (same points, either winding); ' +
    'non-manifold edges (3+ faces): keep, remove the extra faces, or split (faces around the edge are paired by ' +
    'angle and orientation, then every point whose corners form several fans (also bowtie points) is duplicated so ' +
    'each fan is manifold); winding made consistent across manifold edges (each piece keeps its majority ' +
    'orientation); holes with at most max_hole_edges edges ear-clipped (no new points, attributes from the ' +
    'neighbouring faces, prim group "filled"); closed pieces turned outward (signed volume); optional ' +
    'self-intersection test (BVH, triangle pairs that cross; report → prim group "self_intersecting", ' +
    'remove_faces → delete them and fill the holes); points no prim uses removed. Detail string "repair_report" ' +
    'holds the counts as JSON (with input/output topology summaries); the node warns with a summary when it changed ' +
    'or found something. Polylines pass through. For a quick tidy without topology changes use clean; for meshes ' +
    'beyond repair, remesh (voxel) rebuilds a watertight surface.',
  aliases: ['repair', 'polydoctor', 'mesh_doctor', 'fix_mesh'],
  inputs: [{ name: 'geo', desc: 'polygon mesh' }],
  params: {
    fuse: { type: 'bool', default: true, desc: 'weld points within tolerance' },
    tolerance: { type: 'float', default: 1e-5, min: 0, desc: 'fuse distance (0 = exactly coincident points only)', aliases: ['distance', 'fuse_distance'] },
    remove_degenerate: { type: 'bool', default: true, desc: 'remove faces with repeated points or zero area (collinear triangles merge into their neighbour)' },
    remove_duplicates: { type: 'bool', default: true, desc: 'remove faces that use the same points as an earlier face' },
    non_manifold: { type: 'enum', options: ['split', 'remove', 'keep'], default: 'split', desc: 'edges with 3+ faces: split = duplicate points so every fan is manifold; remove = delete the extra faces; keep' },
    fix_winding: { type: 'bool', default: true, desc: 'make face winding consistent across shared edges' },
    outward: { type: 'bool', default: true, desc: 'turn closed pieces so their normals face outward (needs fix_winding)' },
    fill_holes: { type: 'bool', default: true, desc: 'cap small holes' },
    max_hole_edges: { type: 'int', default: 8, min: 0, desc: 'only fill holes with at most this many edges (0 = any size)' },
    self_intersections: { type: 'enum', options: ['off', 'report', 'remove_faces'], default: 'off', desc: 'find faces that cross other faces: report (prim group self_intersecting) or remove them and fill the holes' },
    remove_isolated: { type: 'bool', default: true, desc: 'remove points no prim uses (only when the geometry has prims)' },
  },
  outputs: 'detail string repair_report (JSON counts); prim groups filled, self_intersecting (report mode)',
  example: { type: 'mesh_repair', params: { tolerance: 0.001, max_hole_edges: 12, self_intersections: 'report' } },
  cook: ({ input, p, warn }) => {
    const g = input(0);
    const { geo, report } = repairMesh(g, {
      fuse: p.fuse, tolerance: p.tolerance, degenerate: p.remove_degenerate, duplicates: p.remove_duplicates,
      nonManifold: p.non_manifold as NonManifoldMode, winding: p.fix_winding, outward: p.outward, fillHoles: p.fill_holes,
      maxHoleEdges: p.max_hole_edges, isolated: p.remove_isolated, selfIntersections: p.self_intersections as SelfIntersectMode,
    });
    (geo.detail.add('repair_report', 'string', 1).data as string[])[0] = JSON.stringify(report);
    const s = repairSummary(report);
    if (s) warn(`mesh_repair: ${s}`);
    return geo;
  },
});

// ---------------------------------------------------------------- lod

const DEFAULT_RATIOS = [1, 0.5, 0.25, 0.125];

defineNode({
  type: 'lod',
  category: 'topology',
  summary: 'Levels of detail in one go: decimated copies tagged with prim lod and name suffix _LOD0, _LOD1 … (merged), or one level (switch).',
  description:
    'Houdini: PolyReduce per level + a name per level (LOD Create). Each level is decimated from the input with the ' +
    'decimate kernel (attribute steering, uv seams kept, optional lock_border, prune small pieces); level 0 with ' +
    'ratio 1 is the triangulated input. Levels come from ratios (fractions of the triangle count; missing entries keep ' +
    'halving) or, when screen_sizes is given, from screen sizes (fraction of the screen height the object covers, ' +
    'like Unreal LOD screen size): each such level reduces as far as an error of pixel_error pixels at screen_height ' +
    'allows. merge outputs all levels together with prim int "lod" and prim "name" = input name (or base_name) + ' +
    '"_LOD<k>", so exporters that split by name (export split_by_name, glTF/USD) write one mesh per level; spacing ' +
    'offsets level k by k·spacing for side-by-side previews. switch outputs only level "level". Detail "lod" is a ' +
    'JSON list of {level, ratio | screen_size, triangles, error}; detail int[] "lod_tris" the triangle counts.',
  aliases: ['lod_tree', 'polyreduce_lod', 'lod_create', 'lods'],
  inputs: [{ name: 'geo', desc: 'polygon mesh' }],
  params: {
    levels: { type: 'int', default: 4, min: 1, max: 12, desc: 'number of levels (LOD0 … LODn-1)', aliases: ['count', 'num_levels'] },
    ratios: { type: 'json', default: DEFAULT_RATIOS, desc: 'triangle fraction per level, e.g. [1, 0.5, 0.25, 0.125]; missing entries keep halving' },
    screen_sizes: { type: 'json', default: [], desc: 'error-driven levels instead: screen size per level, e.g. [1, 0.5, 0.25, 0.1] (fraction of screen height); [] = use ratios' },
    pixel_error: { type: 'float', default: 1, min: 0, desc: 'screen_sizes: allowed error in pixels', advanced: true },
    screen_height: { type: 'int', default: 1080, min: 1, desc: 'screen_sizes: screen height in pixels', advanced: true },
    max_error: { type: 'float', default: 1, min: 0, desc: 'ratio levels: stop early at this relative error (1 = reach the ratio)', aliases: ['error'] },
    attributes: { type: 'string', default: 'uv N Cd', desc: 'float point/vertex attributes that steer the reduction, with optional weights ("uv:2 N:0.5")' },
    lock_border: { type: 'bool', default: false, desc: 'keep open borders fixed in every level' },
    prune: { type: 'bool', default: true, desc: 'let small disconnected pieces (leaves, bolts) vanish in coarse levels' },
    mode: { type: 'enum', options: ['merge', 'switch'], default: 'merge', desc: 'merge = all levels in one geometry; switch = only "level"' },
    level: { type: 'int', default: 0, min: 0, desc: 'switch mode: the level to output' },
    base_name: { type: 'string', default: 'mesh', desc: 'name for prims without a "name" attribute (becomes mesh_LOD0 …)', aliases: ['name'] },
    spacing: { type: 'vec3', default: [0, 0, 0], desc: 'offset of level k = k * spacing (side-by-side previews; keep 0 for export)', aliases: ['offset'] },
  },
  outputs: 'prim int lod, prim string name (…_LOD<k>); detail string lod (JSON per level), detail int[] lod_tris',
  example: { type: 'lod', params: { levels: 4, ratios: [1, 0.5, 0.25, 0.1], spacing: [2.5, 0, 0] } },
  cook: ({ input, p, stat }) => {
    const g = input(0);
    const steer = guard(() => parseSteerAttribs(p.attributes));
    const sizes = Array.isArray(p.screen_sizes) ? p.screen_sizes.map(Number).filter((x: number) => x > 0) : [];
    const n = sizes.length ? sizes.length : Math.max(1, Math.floor(p.levels));
    if (!Array.isArray(p.ratios)) throw new NodeError('lod: ratios must be a list of numbers, e.g. [1, 0.5, 0.25]');
    const ratios: number[] = [];
    for (let k = 0; k < n; k++) {
      const r = Number(p.ratios[k]);
      ratios.push(Number.isFinite(r) && r >= 0 ? Math.min(1, r) : k ? ratios[k - 1] / 2 : 1);
    }
    const levels = p.mode === 'switch' ? [Math.min(n - 1, Math.max(0, Math.floor(p.level)))] : Array.from({ length: n }, (_, k) => k);
    const info: any[] = [], tris: number[] = [], geos: Geometry[] = [];
    const nameAttr = g.prims.get('name');
    const baseNames = nameAttr && nameAttr.type === 'string' ? (nameAttr.data as string[]) : null;
    for (const k of levels) {
      const bySize = sizes.length > 0;
      const opts: DecimateOptions = {
        ratio: bySize ? (k === 0 && sizes[0] >= 1 ? 1 : 0) : ratios[k], targetCount: 0,
        maxError: bySize ? p.pixel_error / (sizes[k] * p.screen_height) : p.max_error, errorAbsolute: false,
        lockBorder: p.lock_border, prune: p.prune && !(bySize ? false : ratios[k] >= 1), sparse: false, regularize: false, sloppy: false,
        attributes: steer, group: null, lockPoints: null,
      };
      const r = guard(() => decimateMesh(g, opts));
      const lg = r.geo;
      // tag the level: prim lod + name suffix
      const lod = lg.prims.add('lod', 'int', 1);
      (lod.data as Int32Array).fill(k);
      const names = new Array<string>(lg.numPrims);
      const srcName = lg.prims.get('name');
      for (let pr = 0; pr < lg.numPrims; pr++) {
        const base = baseNames && srcName && srcName.type === 'string' ? (srcName.data as string[])[pr] || p.base_name : p.base_name;
        names[pr] = `${base}_LOD${k}`;
      }
      lg.prims.set('name', new Attribute('string', 1, names, ''));
      const off = p.spacing as number[];
      if (k && (off[0] || off[1] || off[2])) {
        const Pd = lg.P;
        for (let i = 0; i < lg.numPoints; i++) { Pd[i * 3] += off[0] * k; Pd[i * 3 + 1] += off[1] * k; Pd[i * 3 + 2] += off[2] * k; }
      }
      info.push({ level: k, ...(bySize ? { screen_size: sizes[k] } : { ratio: ratios[k] }), triangles: r.trisOut, error: +r.error.toPrecision(4) });
      tris.push(r.trisOut);
      geos.push(lg);
    }
    const out = geos.length === 1 ? geos[0] : Geometry.merge(geos);
    for (const a of ['error', 'error_abs']) out.detail.delete(a);
    (out.detail.add('lod', 'string', 1).data as string[])[0] = JSON.stringify(info);
    out.detail.set('lod_tris', Attribute.fromArrays('int[]', [tris]));
    stat('levels', levels.length);
    return out;
  },
});
