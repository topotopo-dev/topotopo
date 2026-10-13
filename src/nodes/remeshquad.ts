// Geometry/provenance adapter for the host-independent Rust field-aligned remesher.
import { GeoBuilder, Geometry } from '../core/geometry.ts';
import type { Src } from '../core/geometry.ts';
import { EdgeSet } from '../core/edges.ts';
import { halfEdges } from '../core/halfedge.ts';
import { ClosestBVH, primRegions, sideTwins, vertexAttribsDiffer } from '../core/remesh.ts';
import { refreshNormals, triangulate } from '../core/topology.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import { loadHostKernels } from '../wasm/kernels.ts';
import type { QuadRemeshResult } from '../wasm/kernels.ts';
import { edgeMask, mask, P } from './util.ts';

interface SourceMesh {
  positions: Float64Array;
  tris: Uint32Array;
  points: number[];
  vertices: Uint32Array;
  prims: Uint32Array;
  creases: EdgeSet;
  locked: EdgeSet;
  seams: EdgeSet;
  normalCreases: EdgeSet;
  selected: Uint8Array;
}

const nextTriangle = (h: number) => h % 3 === 2 ? h - 2 : h + 1;

/** Compact selected polygons, retaining the original corner numbers for UV wedges. */
function sourceMesh(g: Geometry, selection: Uint8Array | null, explicitCreases: EdgeSet | null): SourceMesh {
  const { tris: vertices, triPrim: prims } = triangulate(g, selection);
  if (!prims.length) throw new NodeError('remesh_quad: input or group has no polygons to remesh');
  const points: number[] = [], pointIndex = new Int32Array(g.numPoints).fill(-1);
  const tris = new Uint32Array(vertices.length), selected = new Uint8Array(g.numPrims);
  // Preserve source order so the whole-mesh adapter agrees with direct kernel calls,
  // and changing a selection preserves the relative order of its remaining points.
  for (const vertex of vertices) pointIndex[g.vertexPoint[vertex]] = 0;
  for (let p = 0; p < pointIndex.length; p++) if (pointIndex[p] === 0) {
    pointIndex[p] = points.length; points.push(p);
  }
  for (let h = 0; h < vertices.length; h++) {
    tris[h] = pointIndex[g.vertexPoint[vertices[h]]];
    selected[prims[Math.floor(h / 3)]] = 1;
  }
  const positions = new Float64Array(points.length * 3);
  for (let i = 0; i < points.length; i++) positions.set(g.P.subarray(points[i] * 3, points[i] * 3 + 3), i * 3);
  const twins = sideTwins(Int32Array.from(tris), points.length);
  const creases = new EdgeSet(), locked = new EdgeSet(), seams = new EdgeSet(), normalCreases = new EdgeSet();
  const attrs = [...g.vertices.map].filter(([name, a]) => name !== 'N' && !a.isArray).map(([, a]) => a);
  const regions = primRegions(g);
  // The border between remeshed polygons and retained primitives must keep its exact edge partition.
  const retainedEdges = new EdgeSet();
  for (let p = 0; p < g.numPrims; p++) {
    if (selected[p]) continue;
    const start = g.primStart[p], end = g.primStart[p + 1], last = g.primClosed[p] ? end : end - 1;
    for (let v = start; v < last; v++) retainedEdges.add(g.vertexPoint[v], g.vertexPoint[v + 1 < end ? v + 1 : start]);
  }
  for (let h = 0; h < tris.length; h++) {
    const twin = twins[h], a = tris[h], b = tris[nextTriangle(h)], pa = points[a], pb = points[b];
    if (twin === -2) throw new NodeError('remesh_quad: input has a non-manifold edge or inconsistent winding; run mesh_repair first');
    if (twin >= 0 && twin < h) continue;
    if (retainedEdges.has(pa, pb)) locked.add(a, b);
    if (explicitCreases?.has(pa, pb)) { creases.add(a, b); normalCreases.add(a, b); }
    if (twin < 0) continue;
    const seam = attrs.length > 0 && (vertexAttribsDiffer(attrs, vertices[h], vertices[nextTriangle(twin)]) ||
      vertexAttribsDiffer(attrs, vertices[nextTriangle(h)], vertices[twin]));
    if (seam) seams.add(a, b);
    if (regions && regions[prims[Math.floor(h / 3)]] !== regions[prims[Math.floor(twin / 3)]]) creases.add(a, b);
  }
  return { positions, tris, points, vertices, prims, creases, locked, seams, normalCreases, selected };
}

function segmentBVH(positions: Float64Array, edges: EdgeSet): ClosestBVH | null {
  if (!edges.size) return null;
  const segments = new Float64Array(edges.size * 6);
  let k = 0;
  for (const [a, b] of edges) {
    segments.set(positions.subarray(a * 3, a * 3 + 3), k);
    segments.set(positions.subarray(b * 3, b * 3 + 3), k + 3);
    k += 6;
  }
  return new ClosestBVH(segments, 2);
}

/** Testing endpoints and midpoint allows an output edge to span several collinear source segments. */
function onSegments(bvh: ClosestBVH | null, positions: Float64Array, a: number, b: number, tolerance2: number): boolean {
  if (!bvh) return false;
  const ai = a * 3, bi = b * 3;
  for (const t of [0, 0.5, 1]) {
    bvh.closest(positions[ai] * (1 - t) + positions[bi] * t,
      positions[ai + 1] * (1 - t) + positions[bi + 1] * t,
      positions[ai + 2] * (1 - t) + positions[bi + 2] * t);
    if (bvh.d2 > tolerance2) return false;
  }
  return true;
}

/** Resolve corners per connected wedge, so smooth source UVs stay exactly continuous at shared output points. */
function cornerSources(source: SourceMesh, result: QuadRemeshResult, tolerance2: number): Src[] {
  const { positions: pos, prim_start: starts, vertex_point: corners } = result;
  const polygons = Array.from({ length: starts.length - 1 }, (_, p) => corners.subarray(starts[p], starts[p + 1]));
  const topology = halfEdges(new Geometry({ positions: pos, prims: polygons }));
  const parent = Int32Array.from({ length: corners.length }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  };
  const join = (a: number, b: number) => { const x = find(a), y = find(b); if (x !== y) parent[x] = y; };
  const seams = segmentBVH(source.positions, source.seams);
  for (let h = 0; h < topology.numHalfEdges; h++) {
    const twin = topology.heTwin[h];
    if (twin < h) continue;
    if (onSegments(seams, pos, topology.heOrigin[h], topology.dest(h), tolerance2)) continue;
    join(topology.heVertex[h], topology.heVertex[topology.heNext[twin]]);
    join(topology.heVertex[topology.heNext[h]], topology.heVertex[twin]);
  }
  const refTriangles = new Float64Array(source.tris.length * 3);
  for (let i = 0; i < source.tris.length; i++) refTriangles.set(source.positions.subarray(source.tris[i] * 3, source.tris[i] * 3 + 3), i * 3);
  const bvh = new ClosestBVH(refTriangles, 3), wedge = new Map<number, Src>();
  const onSeam = new Uint8Array(pos.length / 3);
  if (seams) for (let i = 0; i < onSeam.length; i++) {
    seams.closest(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    onSeam[i] = seams.d2 <= tolerance2 ? 1 : 0;
  }
  const provenance: Src[] = new Array(corners.length);
  for (let f = 0; f + 1 < starts.length; f++) {
    const start = starts[f], end = starts[f + 1], center = [0, 0, 0];
    for (let v = start; v < end; v++) for (let c = 0; c < 3; c++) center[c] += pos[corners[v] * 3 + c] / (end - start);
    for (let v = start; v < end; v++) {
      const root = find(v);
      if (!wedge.has(root)) {
        const i = corners[v], x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
        let t = result.source_triangle[i], weights: ArrayLike<number> = result.barycentric.subarray(i * 3, i * 3 + 3);
        if (onSeam[i]) {
          // Only seam points need a side selection. Nudging an interior point across an input
          // triangle's diagonal would clamp its UV to that diagonal instead of its final projection.
          t = bvh.closest(x + (center[0] - x) * 1e-3, y + (center[1] - y) * 1e-3,
            z + (center[2] - z) * 1e-3, t);
          bvh.onItem(t, x, y, z);
          weights = [bvh.b0, bvh.b1, bvh.b2];
        }
        const indices = source.vertices.subarray(t * 3, t * 3 + 3);
        const exact = Array.from(weights).findIndex(w => w === 1);
        wedge.set(root, exact >= 0 ? indices[exact] : { i: indices, w: weights });
      }
      provenance[v] = wedge.get(root);
    }
  }
  return provenance;
}

function rebuild(g: Geometry, source: SourceMesh, result: QuadRemeshResult, featureAngle: number, preserveSharp: boolean): Geometry {
  const builder = new GeoBuilder(g), copied = new Int32Array(g.numPoints).fill(-1);
  const copyPoint = (p: number): number => copied[p] < 0 ? (copied[p] = builder.copyPoint(p)) : copied[p];
  const retainedPrims: [number, number][] = [], retainedVertices: [number, number][] = [];
  for (let p = 0; p < g.numPrims; p++) {
    if (source.selected[p]) continue;
    const points: number[] = [], vertices: number[] = [];
    for (let v = g.primStart[p]; v < g.primStart[p + 1]; v++) {
      points.push(copyPoint(g.vertexPoint[v])); vertices.push(v);
      retainedVertices.push([builder.numVertices + vertices.length - 1, v]);
    }
    retainedPrims.push([builder.addPrim(points, !!g.primClosed[p], p, vertices), p]);
  }
  const retainedPoints: [number, number][] = [];
  for (let p = 0; p < copied.length; p++) if (copied[p] >= 0) retainedPoints.push([copied[p], p]);
  const remap = new Int32Array(result.positions.length / 3);
  for (let i = 0; i < remap.length; i++) {
    const t = result.source_triangle[i], weights = result.barycentric.subarray(i * 3, i * 3 + 3);
    const indices = [0, 1, 2].map(k => source.points[source.tris[t * 3 + k]]);
    const x = result.positions[i * 3], y = result.positions[i * 3 + 1], z = result.positions[i * 3 + 2];
    const exact = indices.find((p, k) => weights[k] === 1 && g.P[p * 3] === x && g.P[p * 3 + 1] === y && g.P[p * 3 + 2] === z);
    remap[i] = exact === undefined ? builder.addPoint(x, y, z, { i: indices, w: weights }) : copyPoint(exact);
  }
  // Match curves at the remeshed scale. A distant retained component must not
  // widen this tolerance and make unrelated output edges inherit seam groups.
  let coordinateScale = 0;
  for (const value of source.positions) coordinateScale = Math.max(coordinateScale, Math.abs(value));
  const tolerance2 = Math.max(result.quality.target_edge_length * 1e-6,
    coordinateScale * Number.EPSILON * 8, 1e-12) ** 2;
  const needsCorners = [...g.vertices.map.keys()].some(name => name !== 'N') || g.vertexGroups.size > 0;
  const cornerProvenance = needsCorners ? cornerSources(source, result, tolerance2) : null;
  for (let p = 0; p + 1 < result.prim_start.length; p++) {
    const start = result.prim_start[p], end = result.prim_start[p + 1];
    builder.addPrim(Array.from(result.vertex_point.subarray(start, end), i => remap[i]), true,
      source.prims[result.src_prim[p]], cornerProvenance?.slice(start, end));
  }
  const out = builder.build();
  const hard = new EdgeSet();
  // Edge groups inherit copied edges in GeoBuilder; also recover edges resampled along the input curves.
  if (g.edgeGroups.size || source.normalCreases.size) {
    const he = halfEdges(out);
    for (const [name, edges] of g.edgeGroups) {
      const bvh = segmentBVH(g.P, edges), group = out.edgeGroups.get(name) ?? new EdgeSet();
      for (let e = 0; e < he.numEdges; e++) if (onSegments(bvh, out.P, he.edgeA[e], he.edgeB[e], tolerance2)) group.add(he.edgeA[e], he.edgeB[e]);
      out.edgeGroups.set(name, group);
    }
    const creaseBVH = segmentBVH(source.positions, source.normalCreases);
    for (let e = 0; e < he.numEdges; e++) if (onSegments(creaseBVH, out.P, he.edgeA[e], he.edgeB[e], tolerance2)) hard.add(he.edgeA[e], he.edgeB[e]);
  }
  refreshNormals(out, preserveSharp && featureAngle > 0 ? featureAngle : 180, hard);
  // Refresh affects the remeshed region; copied primitive/corner normals in the complement stay exact.
  for (const [cls, pairs] of [['point', retainedPoints], ['prim', retainedPrims], ['vertex', retainedVertices]] as const) {
    const src = g.table(cls).get('N'), dst = out.table(cls).get('N');
    if (src && dst) for (const [a, b] of pairs) dst.set(a, src.get(b));
  }
  for (const [name, value] of Object.entries(result.quality)) {
    (out.detail.add(name, name === 'singularities' ? 'int' : 'float', 1).data as Float64Array | Int32Array)[0] = value;
  }
  return out;
}

defineNode({
  type: 'remesh_quad', category: 'topology',
  aliases: ['quadremesh', 'quad_remesh', 'instant_meshes'],
  summary: 'Field-aligned quad-dominant remeshing in Rust/WASM, with feature alignment and source attribute transfer.',
  description: 'Smooths a four-way orientation field and a position field through a multiresolution hierarchy, then ' +
    'extracts mostly quads on the original surface. Density is approximate: target_faces takes precedence over ' +
    'target_length; 0 for both uses the input scale. Quads-only splits residual non-quads and their affected ' +
    'neighbors conformingly; locked group borders can retain triangles. Cleanup removes avoidable topology defects. ' +
    'Feature edges, explicit creases and material/group borders constrain the fields; UV seams constrain the orientation field ' +
    'without fixing the position field. Original seam geometry is retained for attribute transfer. Selected group ' +
    'borders stay fixed and unselected primitives pass through. Point attributes interpolate from final source-triangle ' +
    'barycentrics, vertex attributes interpolate per seam wedge, and prim attributes copy the source triangle. ' +
    'Existing normals are recomputed. Detail quality statistics describe the remeshed region. ' +
    'irregular_fraction is the number of interior vertices with valence other than four divided by all remeshed vertices. ' +
    'This is an independent implementation, not the Instant Meshes library.',
  inputs: [{ name: 'geo', desc: 'consistently oriented manifold polygon mesh' }],
  params: {
    target_length: { type: 'float', default: 0, min: 0, desc: 'target quad edge length in scene units (0 = automatic input scale)', aliases: ['edge_length', 'target_size'] },
    target_faces: { type: 'int', default: 0, min: 0, desc: 'approximate target face count (> 0 overrides target_length)' },
    mode: { type: 'enum', options: ['quad_dominant', 'quads_only'], default: 'quad_dominant', desc: 'quad_dominant permits triangles; quads_only conformingly splits residual non-quads when unlocked' },
    feature_angle: { type: 'float', default: 45, min: 0, max: 180, desc: 'dihedral threshold in degrees for automatic sharp-feature alignment (0 disables it)' },
    align_boundaries: { type: 'bool', default: true, desc: 'align the orientation field along open boundaries' },
    smooth_iterations: { type: 'int', default: 8, min: 0, max: 100, desc: 'orientation and position field smoothing passes per hierarchy level' },
    preserve_sharp: { type: 'bool', default: true, desc: 'constrain extraction to detected sharp feature curves' },
    cleanup: { type: 'bool', default: true, desc: 'remove avoidable irregular vertices and short edges after extraction' },
    crease_group: { type: 'group', default: '', groupClass: 'edge', desc: 'edge group or pattern used as hard alignment constraints (empty = none)' },
    group: P.group('prim', 'primitives to remesh (empty = all); edges shared with the remainder stay fixed'),
    max_faces: { type: 'int', default: 1000000, min: 1, desc: 'refuse estimated or extracted output above this primitive count, including the retained group complement', advanced: true },
  },
  outputs: 'quad-dominant polygons; interpolated point/vertex attributes and copied prim attributes; detail quad_fraction, singularities, irregular_fraction and edge/planarity statistics',
  example: { type: 'remesh_quad', in: ['mesh'], params: { target_faces: 1000, feature_angle: 45 } },
  cook: async ({ input, p, engine, stat }) => {
    const g = input(0), selection = mask(g, 'prim', p.group);
    if (selection && !selection.some((selected, prim) => selected && g.primClosed[prim] && g.primSize(prim) >= 3)) return g.clone();
    const source = sourceMesh(g, selection, p.crease_group ? edgeMask(g, p.crease_group) : null);
    const retainedCount = g.numPrims - source.selected.reduce((sum, selected) => sum + selected, 0);
    const availableFaces = p.max_faces - retainedCount;
    if (availableFaces < 1) throw new NodeError(`remesh_quad: retained group complement already uses ${retainedCount} primitives (max_faces ${p.max_faces}); raise max_faces`);
    const kernels = await loadHostKernels(engine.host);
    let result: QuadRemeshResult;
    try {
      result = kernels.remesh_quad(source.positions, source.tris, {
        target_length: p.target_length, target_faces: p.target_faces, quad_only: p.mode === 'quads_only',
        feature_angle: p.feature_angle * Math.PI / 180, align_boundaries: p.align_boundaries,
        smooth_iterations: p.smooth_iterations, preserve_sharp: p.preserve_sharp, cleanup: p.cleanup,
        crease_edges: Uint32Array.from(source.creases.toPairs()), locked_edges: Uint32Array.from(source.locked.toPairs()),
        direction_edges: Uint32Array.from(source.seams.toPairs()),
        max_faces: availableFaces,
      });
    } catch (error) {
      throw new NodeError(error instanceof Error ? error.message : String(error), 'check the target density and max_faces; use mesh_repair for invalid topology');
    }
    if (result.prim_start.length - 1 > availableFaces) throw new NodeError(`remesh_quad: output plus retained primitives exceeds max_faces ${p.max_faces}; raise target_length or max_faces`);
    const out = rebuild(g, source, result, p.feature_angle, p.preserve_sharp);
    stat('faces', result.prim_start.length - 1);
    stat('quad_fraction', result.quality.quad_fraction);
    stat('singularities', result.quality.singularities);
    stat('irregular_fraction', result.quality.irregular_fraction);
    stat('target_length', result.quality.target_edge_length);
    return out;
  },
});
