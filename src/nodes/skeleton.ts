// Planar footprints and provenance adapter for the Rust straight-skeleton kernels.
import { GeoBuilder } from '../core/geometry.ts';
import type { Geometry, Src } from '../core/geometry.ts';
import { primNormals } from '../core/topology.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import { loadHostKernels } from '../wasm/kernels.ts';
import { mask } from './util.ts';

interface Edge {
  a: number;
  b: number;
  va: number;
  vb: number;
  prim: number;
  /** Global contour edge number in source primitive/vertex order. */
  id: number;
}

interface Ring {
  edges: Edge[];
  xy: Float64Array;
  logArea: number;
  y: number;
  parent: number;
  depth: number;
  tolerance: number;
}

/** Logarithmic area ranks nested loops without squaring a potentially tiny or huge extent. */
function logArea(xy: ArrayLike<number>): number {
  let sum = 0, scale = 0;
  const x = xy[0], z = xy[1];
  for (let i = 0; i < xy.length; i += 2) scale = Math.max(scale, Math.abs(xy[i] - x), Math.abs(xy[i + 1] - z));
  if (scale === 0) return -Infinity;
  if (!Number.isFinite(scale)) throw new NodeError('straight_skeleton: footprint extent exceeds the finite numeric range');
  for (let i = 0, j = xy.length - 2; i < xy.length; j = i, i += 2)
    sum += ((xy[j] - x) / scale) * ((xy[i + 1] - z) / scale) - ((xy[i] - x) / scale) * ((xy[j + 1] - z) / scale);
  return Math.log(Math.abs(sum) / 2) + 2 * Math.log(scale);
}

/** Test distinct contours before containment; crossing contours cannot be independent footprints. */
function contoursTouch(a: Float64Array, b: Float64Array): boolean {
  const orientation = (ax: number, az: number, bx: number, bz: number, cx: number, cz: number): number => {
    const dx = bx - ax, dz = bz - az, qx = cx - ax, qz = cz - az;
    const scale = Math.max(Math.abs(dx), Math.abs(dz), Math.abs(qx), Math.abs(qz));
    return scale ? (dx / scale) * (qz / scale) - (dz / scale) * (qx / scale) : 0;
  };
  const between = (ax: number, az: number, bx: number, bz: number, x: number, z: number): boolean =>
    x >= Math.min(ax, bx) && x <= Math.max(ax, bx) && z >= Math.min(az, bz) && z <= Math.max(az, bz);
  for (let i = 0; i < a.length; i += 2) for (let j = 0; j < b.length; j += 2) {
    const nextA = (i + 2) % a.length, nextB = (j + 2) % b.length;
    const ax = a[i], az = a[i + 1], bx = a[nextA], bz = a[nextA + 1];
    const cx = b[j], cz = b[j + 1], dx = b[nextB], dz = b[nextB + 1];
    if (Math.max(ax, bx) < Math.min(cx, dx) || Math.max(cx, dx) < Math.min(ax, bx)
      || Math.max(az, bz) < Math.min(cz, dz) || Math.max(cz, dz) < Math.min(az, bz)) continue;
    const c = orientation(ax, az, bx, bz, cx, cz), d = orientation(ax, az, bx, bz, dx, dz);
    const aa = orientation(cx, cz, dx, dz, ax, az), bb = orientation(cx, cz, dx, dz, bx, bz);
    if ((c > 0 && d < 0 || c < 0 && d > 0) && (aa > 0 && bb < 0 || aa < 0 && bb > 0)) return true;
    if (c === 0 && between(ax, az, bx, bz, cx, cz) || d === 0 && between(ax, az, bx, bz, dx, dz)
      || aa === 0 && between(cx, cz, dx, dz, ax, az) || bb === 0 && between(cx, cz, dx, dz, bx, bz)) return true;
  }
  return false;
}

function inside(x: number, z: number, xy: Float64Array): boolean {
  let result = false;
  for (let i = 0, j = xy.length - 2; i < xy.length; j = i, i += 2) {
    const xi = xy[i], zi = xy[i + 1], xj = xy[j], zj = xy[j + 1];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * ((z - zi) / (zj - zi)) + xi) result = !result;
  }
  return result;
}

/** Remove doubled bridges so a weakly simple primitive can encode an outer loop and holes. */
function primitiveRings(g: Geometry, prim: number, edgeBase: number): Edge[][] {
  const start = g.primStart[prim], end = g.primStart[prim + 1];
  const key = (point: number): string => `${g.P[point * 3]},${g.P[point * 3 + 2]}`;
  const edges: Edge[] = [];
  for (let va = start; va < end; va++) {
    const vb = va + 1 < end ? va + 1 : start;
    edges.push({ a: g.vertexPoint[va], b: g.vertexPoint[vb], va, vb, prim, id: edgeBase + va - start });
  }
  const removed = new Set<number>();
  for (let i = 0; i < edges.length; i++) {
    if (removed.has(i)) continue;
    const a = key(edges[i].a), b = key(edges[i].b);
    if (a === b) continue;
    for (let j = i + 1; j < edges.length; j++) {
      if (!removed.has(j) && key(edges[j].a) === b && key(edges[j].b) === a) {
        removed.add(i); removed.add(j); break;
      }
    }
  }
  if (!removed.size) return [edges];
  const outgoing = new Map<string, number>();
  for (let i = 0; i < edges.length; i++) {
    if (removed.has(i)) continue;
    const a = key(edges[i].a), b = key(edges[i].b);
    // Explicit repeated closing corners are harmless in a bridged representation.
    if (a === b) { removed.add(i); continue; }
    if (outgoing.has(a)) throw new NodeError(`straight_skeleton: primitive ${prim} has ambiguous hole bridges`);
    outgoing.set(a, i);
  }
  const loops: Edge[][] = [];
  for (let i = 0; i < edges.length; i++) {
    if (removed.has(i)) continue;
    const loop: Edge[] = [];
    let next = i;
    while (!removed.has(next)) {
      removed.add(next);
      const edge = edges[next];
      loop.push(edge);
      const after = outgoing.get(key(edge.b));
      if (after === undefined) throw new NodeError(`straight_skeleton: primitive ${prim} has an open hole bridge`);
      next = after;
    }
    if (next !== i) throw new NodeError(`straight_skeleton: primitive ${prim} has intersecting hole loops`);
    loops.push(loop);
  }
  return loops;
}

function footprints(g: Geometry, selected: Uint8Array | null): Ring[] {
  const loops: Ring[] = [];
  let edgeBase = 0;
  for (let prim = 0; prim < g.numPrims; prim++) {
    const count = g.primStart[prim + 1] - g.primStart[prim];
    if (selected && !selected[prim]) { edgeBase += count; continue; }
    if (!g.primClosed[prim]) throw new NodeError(`straight_skeleton: primitive ${prim} is open; close the footprint first`);
    for (const edges of primitiveRings(g, prim, edgeBase)) {
      if (edges.length < 3) throw new NodeError(`straight_skeleton: primitive ${prim} needs at least three contour vertices`);
      const xy = Float64Array.from(edges.flatMap((edge) => [g.P[edge.a * 3], g.P[edge.a * 3 + 2]]));
      const y = g.P[edges[0].a * 3 + 1];
      let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
      for (let i = 0; i < xy.length; i += 2) {
        minX = Math.min(minX, xy[i]); maxX = Math.max(maxX, xy[i]);
        minZ = Math.min(minZ, xy[i + 1]); maxZ = Math.max(maxZ, xy[i + 1]);
      }
      const tolerance = 1e-10 * Math.max(1, maxX - minX, maxZ - minZ);
      for (const edge of edges) {
        const py = g.P[edge.a * 3 + 1];
        if (![g.P[edge.a * 3], py, g.P[edge.a * 3 + 2]].every(Number.isFinite))
          throw new NodeError(`straight_skeleton: primitive ${prim} has non-finite coordinates`);
        if (Math.abs(py - y) > tolerance)
          throw new NodeError(`straight_skeleton: primitive ${prim} is not planar on XZ (all Y coordinates must match)`);
      }
      loops.push({ edges, xy, logArea: logArea(xy), y, parent: -1, depth: 0, tolerance });
    }
    edgeBase += count;
  }
  for (let i = 0; i < loops.length; i++) for (let j = i + 1; j < loops.length; j++) {
    if (Math.abs(loops[i].y - loops[j].y) > Math.max(loops[i].tolerance, loops[j].tolerance)) continue;
    if (contoursTouch(loops[i].xy, loops[j].xy))
      throw new NodeError(`straight_skeleton: contours from primitives ${loops[i].edges[0].prim} and ${loops[j].edges[0].prim} intersect or touch; separate their boundaries`);
  }
  // A smallest containing loop is the parent. Even/odd nesting handles islands inside courtyards too.
  for (let i = 0; i < loops.length; i++) {
    let best = Infinity;
    for (let j = 0; j < loops.length; j++) {
      if (i === j || Math.abs(loops[j].y - loops[i].y) > Math.max(loops[i].tolerance, loops[j].tolerance)) continue;
      const size = loops[j].logArea;
      if (size > loops[i].logArea && size < best && inside(loops[i].xy[0], loops[i].xy[1], loops[j].xy)) {
        loops[i].parent = j; best = size;
      }
    }
  }
  for (const loop of loops) {
    for (let parent = loop.parent; parent >= 0; parent = loops[parent].parent) loop.depth++;
  }
  return loops;
}

function projection(g: Geometry, edge: Edge, x: number, z: number): { t: number; d: number } {
  const ax = g.P[edge.a * 3], az = g.P[edge.a * 3 + 2];
  const dx = g.P[edge.b * 3] - ax, dz = g.P[edge.b * 3 + 2] - az;
  const length2 = dx * dx + dz * dz;
  // Preserve ordinary rounding while avoiding squared lengths outside the safe f64 range.
  let projected = length2 > 1e-300 && Number.isFinite(length2)
    ? ((x - ax) * dx + (z - az) * dz) / length2
    : NaN;
  if (!Number.isFinite(projected)) {
    const scale = Math.max(Math.abs(dx), Math.abs(dz));
    const ux = dx / scale, uz = dz / scale;
    projected = scale ? (((x - ax) / scale) * ux + ((z - az) / scale) * uz) / (ux * ux + uz * uz) : 0;
  }
  const t = Math.max(0, Math.min(1, projected));
  const d = Math.hypot(x - ax - t * dx, z - az - t * dz);
  if (!Number.isFinite(t) || !Number.isFinite(d))
    throw new NodeError('straight_skeleton: contour provenance exceeds the finite numeric range; rescale the footprint');
  return { t, d };
}

/** Keep ordinary normals unchanged; rescale faces whose Newell calculation over/underflows. */
function roofNormals(g: Geometry): Float64Array {
  const normals = primNormals(g);
  for (let prim = 0; prim < g.numPrims; prim++) {
    const offset = prim * 3;
    const magnitude = Math.hypot(normals[offset], normals[offset + 1], normals[offset + 2]);
    if (Number.isFinite(magnitude) && magnitude > 0) continue;
    const points = g.primPoints(prim);
    if (!g.primClosed[prim] || points.length < 3) continue;
    const origin = points[0] * 3;
    const local = points.map((point) => [g.P[point * 3] - g.P[origin], g.P[point * 3 + 1] - g.P[origin + 1], g.P[point * 3 + 2] - g.P[origin + 2]]);
    let scale = 0;
    for (const point of local) for (const value of point) scale = Math.max(scale, Math.abs(value));
    if (!Number.isFinite(scale)) throw new NodeError('straight_skeleton: roof face extent exceeds the finite numeric range');
    if (!scale) continue;
    for (const point of local) for (let axis = 0; axis < 3; axis++) point[axis] /= scale;
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < local.length; i++) {
      const a = local[i], b = local[(i + 1) % local.length];
      nx += (a[1] - b[1]) * (a[2] + b[2]);
      ny += (a[2] - b[2]) * (a[0] + b[0]);
      nz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    const length = Math.hypot(nx, ny, nz) || 1;
    normals.set([nx / length, ny / length, nz / length], offset);
  }
  return normals;
}

function source(edge: Edge, t: number, vertex = false): Src {
  const a = vertex ? edge.va : edge.a, b = vertex ? edge.vb : edge.b;
  return t <= 0 ? a : t >= 1 ? b : { i: [a, b], w: [1 - t, t] };
}

function nearest(g: Geometry, edges: Edge[], x: number, z: number): { edge: Edge; t: number } {
  let edge = edges[0], t = 0, distance = Infinity;
  for (const candidate of edges) {
    const p = projection(g, candidate, x, z);
    if (p.d < distance) { edge = candidate; t = p.t; distance = p.d; }
  }
  return { edge, t };
}

function pitches(g: Geometry, edges: Edge[], name: string, fallback: number): Float64Array {
  if (!name) return new Float64Array([fallback]);
  const point = g.points.get(name), prim = g.prims.get(name);
  const attr = point ?? prim;
  if (!attr) throw new NodeError(`straight_skeleton: pitch_attrib "${name}" is missing from points and primitives`);
  if (attr.type !== 'float' && attr.type !== 'int') throw new NodeError(`straight_skeleton: pitch_attrib "${name}" must be numeric`);
  if (attr.size !== 1) throw new NodeError(`straight_skeleton: pitch_attrib "${name}" must have one value per element`);
  return Float64Array.from(edges, (edge) => (attr.data as ArrayLike<number>)[point ? edge.a : edge.prim]);
}

defineNode({
  type: 'straight_skeleton',
  category: 'curve',
  summary: 'Straight skeleton, polygon offsets and pitched roofs from planar footprints, including holes.',
  description: 'Input closed polygons lie on XZ at a constant Y. Containment uses even/odd nesting to detect holes, including doubled bridges in one primitive. Positive offset distances move inward. Roof pitch attributes use the outgoing edge of each point (or one pitch for the whole source primitive). Output edge numbers follow input primitive and corner order.',
  inputs: [{ name: 'footprint', desc: 'Closed planar footprints, with nested contours for holes.' }],
  params: {
    mode: { type: 'enum', default: 'skeleton', options: ['skeleton', 'offset', 'roof'], desc: 'Emit skeleton and contour arcs, offset contours, or roof faces.' },
    distance: { type: 'float', default: 0.2, desc: 'Offset distance in metres: positive inward, negative outward.' },
    pitch: { type: 'float', default: 30, min: 0.01, max: 90, desc: 'Roof pitch in degrees (greater than 0, up to 90 for a gable); overridden by pitch_attrib when set.' },
    pitch_attrib: { type: 'string', default: '', desc: 'Scalar point or primitive pitch attribute, in degrees; point values belong to outgoing edges.' },
    height_cap: { type: 'float', default: 0, min: 0, desc: 'Maximum roof height above the footprint; 0 leaves the ridge uncapped.' },
    group: { type: 'group', groupClass: 'prim', default: '', desc: 'Footprint primitives to process; unselected primitives pass through.' },
  },
  outputs: 'Skeleton: prim int kind (0 skeleton, 1 contour). Roof: prim int edge (input contour edge; -1 for a height cap). Source attributes and groups follow contour provenance.',
  example: { nodes: { footprint: { type: 'curve', params: { closed: true, points: [[0, 0, 0], [6, 0, 0], [6, 0, 2], [2, 0, 2], [2, 0, 5], [0, 0, 5]] } }, roof: { type: 'straight_skeleton', in: ['footprint'], params: { mode: 'roof', pitch: 35 } } }, output: 'roof' },
  async cook({ input, p, engine }) {
    const g = input(0), selected = mask(g, 'prim', p.group);
    const loops = footprints(g, selected);
    if (!loops.length) return g.clone();
    const builder = new GeoBuilder(g);
    builder.skip.point.add('N'); builder.skip.vertex.add('N'); builder.skip.prim.add('N');
    const copied = new Map<number, number>();
    for (let prim = 0; prim < g.numPrims; prim++) {
      if (!selected || selected[prim]) continue;
      const points: number[] = [], vertices: number[] = [];
      for (let v = g.primStart[prim]; v < g.primStart[prim + 1]; v++) {
        const point = g.vertexPoint[v];
        if (!copied.has(point)) copied.set(point, builder.copyPoint(point));
        points.push(copied.get(point)!); vertices.push(v);
      }
      builder.addPrim(points, !!g.primClosed[prim], prim, vertices);
    }
    try {
      const kernels = await loadHostKernels(engine.host);
      for (let i = 0; i < loops.length; i++) {
        const outer = loops[i];
        if (outer.depth % 2) continue;
        const holes = loops.filter((loop) => loop.parent === i);
        const edges = [outer, ...holes].flatMap((loop) => loop.edges);
        const holeXY = holes.map((loop) => loop.xy);
        const addPoint = (x: number, z: number, height = 0, sourcePoint = -1): number => {
          const y = outer.y + height;
          if (![x, y, z].every(Number.isFinite))
            throw new NodeError('straight_skeleton: output exceeds the finite numeric range; rescale the footprint or lower its elevation');
          if (sourcePoint >= 0) return builder.addPoint(x, y, z, edges[sourcePoint].a);
          const from = nearest(g, edges, x, z);
          return builder.addPoint(x, y, z, source(from.edge, from.t));
        };
        if (p.mode === 'skeleton') {
          const result = kernels.straight_skeleton(outer.xy, holeXY);
          const kind = builder.attrib('prim', 'kind', 1, 'int');
          const points = new Map<string, number>();
          for (let v = 0; v < result.vertices.length; v += 2) {
            const x = result.vertices[v], z = result.vertices[v + 1];
            points.set(`${x},${z}`, addPoint(x, z, 0, result.src_point[v / 2]));
          }
          const pointAt = (x: number, z: number): number => {
            const key = `${x},${z}`;
            if (!points.has(key)) points.set(key, addPoint(x, z));
            return points.get(key)!;
          };
          for (let arc = 0; arc < result.arc_kind.length; arc++) {
            const a = arc * 4, x = result.arcs[a], z = result.arcs[a + 1], xx = result.arcs[a + 2], zz = result.arcs[a + 3];
            const from = nearest(g, edges, x / 2 + xx / 2, z / 2 + zz / 2).edge;
            const prim = builder.addPrim([pointAt(x, z), pointAt(xx, zz)], false, from.prim,
              [source(from, projection(g, from, x, z).t, true), source(from, projection(g, from, xx, zz).t, true)]);
            kind.set(prim, [result.arc_kind[arc]]);
          }
        } else if (p.mode === 'offset') {
          const result = kernels.offset_polygon(outer.xy, holeXY, p.distance);
          const points: number[] = [];
          for (let v = 0; v < result.vertices.length; v += 2) points.push(addPoint(result.vertices[v], result.vertices[v + 1]));
          for (let poly = 0; poly + 1 < result.polygon_start.length; poly++) {
            const ids = Array.from(result.polygon_vertex_index.slice(result.polygon_start[poly], result.polygon_start[poly + 1])).reverse();
            const from = ids.map((id) => nearest(g, edges, result.vertices[id * 2], result.vertices[id * 2 + 1]));
            builder.addPrim(ids.map((id) => points[id]), true, from[0]?.edge.prim ?? outer.edges[0].prim,
              from.map((item) => source(item.edge, item.t, true)));
          }
        } else {
          const result = kernels.roof(outer.xy, holeXY, pitches(g, edges, p.pitch_attrib, p.pitch), p.height_cap > 0 ? p.height_cap : undefined);
          const points: number[] = [];
          for (let v = 0; v < result.vertices.length; v += 3)
            points.push(addPoint(result.vertices[v], result.vertices[v + 1], result.vertices[v + 2], result.src_point[v / 3]));
          const attr = builder.attrib('prim', 'edge', 1, 'int', [-1]);
          for (let face = 0; face + 1 < result.face_start.length; face++) {
            const ids = Array.from(result.face_vertex_index.slice(result.face_start[face], result.face_start[face + 1])).reverse();
            const edge = edges[result.face_edge[face]];
            const provenance = ids.map((id) => {
              const x = result.vertices[id * 3], z = result.vertices[id * 3 + 1];
              const from = edge ? { edge, t: projection(g, edge, x, z).t } : nearest(g, edges, x, z);
              return source(from.edge, from.t, true);
            });
            const prim = builder.addPrim(ids.map((id) => points[id]), true, edge?.prim ?? outer.edges[0].prim, provenance);
            attr.set(prim, [edge?.id ?? -1]);
          }
        }
      }
    } catch (error) {
      throw new NodeError(`straight_skeleton: ${error instanceof Error ? error.message : String(error)}`);
    }
    const out = builder.build();
    if (p.mode === 'roof') {
      const normals = roofNormals(out);
      (out.prims.add('N', 'float', 3).data as Float64Array).set(normals);
      const corners = out.vertices.add('N', 'float', 3).data as Float64Array;
      for (let prim = 0; prim < out.numPrims; prim++) for (let v = out.primStart[prim]; v < out.primStart[prim + 1]; v++)
        corners.set(normals.subarray(prim * 3, prim * 3 + 3), v * 3);
    }
    return out;
  },
});
