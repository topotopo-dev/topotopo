// Bridge between Geometry and manifold-3d (robust mesh booleans, hulls, Minkowski,
// level sets, 2D cross-sections). Float point/vertex attributes ride through as
// manifold "properties" so they are interpolated across new intersection edges.
import { Geometry } from './geometry.ts';
import { topologyReport, triangulate } from './topology.ts';
import type { Vec3 } from './math.ts';

let wasm: any = null;

export async function loadManifold() {
  if (wasm) return wasm;
  const Module = (await import('manifold-3d')).default as any;
  wasm = await Module();
  wasm.setup();
  return wasm;
}

export function M(): any {
  if (!wasm) throw new Error('manifold not initialised (call engine.init())');
  return wasm;
}

export interface PropLayout {
  names: string[];
  sizes: number[];
  cls: ('point' | 'vertex')[];
  offset: number[];
  numProp: number;
}

const SKIP_PROPS = new Set(['P', 'N']);

/** Union of float point/vertex attributes (size ≤ 4) across geometries. */
export function propLayout(geos: Geometry[], include?: string[] | null): PropLayout {
  const L: PropLayout = { names: [], sizes: [], cls: [], offset: [], numProp: 3 };
  for (const cls of ['point', 'vertex'] as const)
    for (const g of geos)
      for (const [name, a] of g.table(cls).map) {
        if (SKIP_PROPS.has(name) || a.type !== 'float' || a.size > 4 || L.names.includes(name)) continue;
        if (include && !include.includes(name)) continue;
        L.names.push(name); L.sizes.push(a.size); L.cls.push(cls); L.offset.push(L.numProp);
        L.numProp += a.size;
      }
  return L;
}

/** The original ID of a manifold made by toManifold (or its own originalID otherwise). */
export function manifoldId(m: any): number {
  return m.__pfId ?? m.originalID();
}

export class NotManifoldError extends Error {
  hint?: string;
}

/** Convert closed polygon geometry to a Manifold. Throws a descriptive error when not solid. */
export function toManifold(g: Geometry, L: PropLayout = propLayout([g])): any {
  const W = M();
  const { tris, triPrim } = triangulate(g);
  if (tris.length === 0) return new W.Manifold(new W.Mesh({ numProp: 3, vertProperties: new Float32Array(0), triVerts: new Uint32Array(0) }));
  const P = g.P;
  const hasVtx = L.cls.includes('vertex');
  // one manifold vertex per point, or per unique (point, vertex-attribute values) combination
  const keyToVert = new Map<string, number>();
  const firstOfPoint = new Int32Array(g.numPoints).fill(-1);
  const props: number[] = [];
  const from: number[] = [], to: number[] = [];
  const vertOf = new Int32Array(g.numVertices).fill(-1);
  const tmp: number[] = [];
  const fill = (pt: number, vtx: number) => {
    tmp.length = 0;
    tmp.push(P[pt * 3], P[pt * 3 + 1], P[pt * 3 + 2]);
    for (let k = 0; k < L.names.length; k++) {
      const a = g.table(L.cls[k]).get(L.names[k]);
      const idx = L.cls[k] === 'point' ? pt : vtx;
      for (let c = 0; c < L.sizes[k]; c++) tmp.push(a && a.type === 'float' && c < a.size ? (a.data as Float64Array)[idx * a.size + c] : 0);
    }
  };
  for (let t = 0; t < tris.length; t++) {
    const v = tris[t];
    if (vertOf[v] >= 0) continue;
    const pt = g.vertexPoint[v];
    fill(pt, v);
    const key = hasVtx ? pt + ':' + tmp.slice(3).join(',') : String(pt);
    let mv = keyToVert.get(key);
    if (mv === undefined) {
      mv = props.length / L.numProp;
      for (const x of tmp) props.push(x);
      keyToVert.set(key, mv);
      if (firstOfPoint[pt] < 0) firstOfPoint[pt] = mv;
      else { from.push(mv); to.push(firstOfPoint[pt]); }
    }
    vertOf[v] = mv;
  }
  const triVerts = new Uint32Array(tris.length);
  for (let i = 0; i < tris.length; i++) triVerts[i] = vertOf[tris[i]];
  // reserve an explicit original ID so results can be traced back to this input
  const id = W.Manifold.reserveIDs(1);
  const mesh = new W.Mesh({
    numProp: L.numProp,
    vertProperties: Float32Array.from(props),
    triVerts,
    mergeFromVert: Uint32Array.from(from),
    mergeToVert: Uint32Array.from(to),
    faceID: Uint32Array.from(triPrim),
    runIndex: Uint32Array.from([0, triVerts.length]),
    runOriginalID: Uint32Array.from([id]),
  });
  mesh.merge();
  try {
    const m = new W.Manifold(mesh);
    m.__pfId = id;
    return m;
  } catch (e: any) {
    const r = topologyReport(g);
    const err = new NotManifoldError(
      `input is not a closed solid (manifold): ${r.boundaryEdges} open/boundary edges, ${r.nonManifoldEdges} non-manifold edges, ${r.degenerate} degenerate faces.`,
    );
    err.hint = 'Solid ops need watertight meshes. Try fuse (weld points), fill_holes, clean, or remesh through sdf_from_mesh → sdf_to_mesh. Open surfaces can use clip instead of boolean.';
    throw err;
  }
}

export interface FromManifoldResult { geo: Geometry; primSource: Int32Array; primFace: Int32Array }

/**
 * Convert a Manifold back to Geometry. `sources` lists the input geometries with their
 * manifold originalIDs so primitive attributes and groups can be carried over.
 */
export function fromManifold(m: any, L: PropLayout, sources: { geo: Geometry; id: number }[] = []): FromManifoldResult {
  const mesh = m.getMesh();
  const np = mesh.numProp as number;
  const vp = mesh.vertProperties as Float32Array;
  const tv = mesh.triVerts as Uint32Array;
  const nVert = vp.length / np;
  const canon = new Int32Array(nVert);
  for (let i = 0; i < nVert; i++) canon[i] = i;
  const mf = mesh.mergeFromVert as Uint32Array, mt = mesh.mergeToVert as Uint32Array;
  for (let i = 0; i < mf.length; i++) canon[mf[i]] = mt[i];
  const ptOf = new Int32Array(nVert).fill(-1);
  const pos: number[] = [];
  const ptVert: number[] = [];
  for (let i = 0; i < tv.length; i++) {
    const c = canon[tv[i]];
    if (ptOf[c] < 0) { ptOf[c] = ptVert.length; ptVert.push(c); pos.push(vp[c * np], vp[c * np + 1], vp[c * np + 2]); }
  }
  const nTri = tv.length / 3;
  const prims: number[][] = [];
  for (let t = 0; t < nTri; t++) prims.push([ptOf[canon[tv[t * 3]]], ptOf[canon[tv[t * 3 + 1]]], ptOf[canon[tv[t * 3 + 2]]]]);
  const g = new Geometry({ positions: pos, prims });
  // properties -> attributes
  for (let k = 0; k < L.names.length; k++) {
    if (L.offset[k] + L.sizes[k] > np) continue;
    const s = L.sizes[k], off = L.offset[k];
    if (L.cls[k] === 'point') {
      const a = g.points.add(L.names[k], 'float', s);
      const d = a.data as Float64Array;
      for (let p = 0; p < ptVert.length; p++) for (let c = 0; c < s; c++) d[p * s + c] = vp[ptVert[p] * np + off + c];
    } else {
      const a = g.vertices.add(L.names[k], 'float', s);
      const d = a.data as Float64Array;
      for (let v = 0; v < tv.length; v++) for (let c = 0; c < s; c++) d[v * s + c] = vp[tv[v] * np + off + c];
    }
  }
  // provenance
  const primSource = new Int32Array(nTri).fill(-1);
  const primFace = new Int32Array(nTri).fill(-1);
  const runIndex = mesh.runIndex as Uint32Array, runID = mesh.runOriginalID as Uint32Array;
  const faceID = mesh.faceID as Uint32Array;
  if (sources.length && runIndex?.length) {
    for (let r = 0; r < runID.length; r++) {
      const si = sources.findIndex((s) => s.id === runID[r]);
      const t0 = runIndex[r] / 3, t1 = (runIndex[r + 1] ?? tv.length) / 3;
      for (let t = t0; t < t1; t++) {
        primSource[t] = si;
        primFace[t] = faceID?.length ? faceID[t] : -1;
      }
    }
    // carry prim attributes and prim groups
    const merged = Geometry.merge(sources.map((s) => s.geo));
    const offsets: number[] = [];
    let o = 0;
    for (const s of sources) { offsets.push(o); o += s.geo.numPrims; }
    const gatherIdx = new Int32Array(nTri);
    for (let t = 0; t < nTri; t++) {
      const si = primSource[t], f = primFace[t];
      gatherIdx[t] = si >= 0 && f >= 0 && f < sources[si].geo.numPrims ? offsets[si] + f : -1;
    }
    g.prims = merged.prims.gather(gatherIdx);
    for (const [k, mask] of merged.primGroups) {
      const out = new Uint8Array(nTri);
      for (let t = 0; t < nTri; t++) if (gatherIdx[t] >= 0) out[t] = mask[gatherIdx[t]];
      g.primGroups.set(k, out);
    }
    g.detail = merged.detail.clone();
  }
  mesh.delete?.();
  return { geo: g, primSource, primFace };
}

// ---------------------------------------------------------------- 2D cross sections

export type Plane = 'xz' | 'xy' | 'yz';

export const PLANE_FRAMES: Record<Plane, { U: Vec3; V: Vec3; N: Vec3 }> = {
  xz: { U: [1, 0, 0], V: [0, 0, -1], N: [0, 1, 0] },
  xy: { U: [1, 0, 0], V: [0, 1, 0], N: [0, 0, 1] },
  yz: { U: [0, 1, 0], V: [0, 0, 1], N: [1, 0, 0] },
};

export function detectPlane(g: Geometry): Plane {
  const b = g.bbox();
  const ext = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
  const minAx = ext.indexOf(Math.min(...ext));
  return minAx === 1 ? 'xz' : minAx === 2 ? 'xy' : 'yz';
}

/** Closed prims of g → 2D polygons in plane coordinates, plus the plane offset along N. */
export function toPolygons(g: Geometry, plane: Plane): { polys: [number, number][][]; offset: number } {
  const F = PLANE_FRAMES[plane];
  const P = g.P;
  const polys: [number, number][][] = [];
  let off = 0, cnt = 0;
  for (let p = 0; p < g.numPrims; p++) {
    const s = g.primStart[p], e = g.primStart[p + 1];
    if (e - s < 3) continue;
    // treat open polylines whose ends meet as closed too
    const poly: [number, number][] = [];
    for (let v = s; v < e; v++) {
      const i = g.vertexPoint[v] * 3;
      const x = P[i], y = P[i + 1], z = P[i + 2];
      poly.push([x * F.U[0] + y * F.U[1] + z * F.U[2], x * F.V[0] + y * F.V[1] + z * F.V[2]]);
      off += x * F.N[0] + y * F.N[1] + z * F.N[2];
      cnt++;
    }
    if (!g.primClosed[p]) {
      const a = poly[0], b = poly[poly.length - 1];
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9) poly.pop();
    }
    polys.push(poly);
  }
  return { polys, offset: cnt ? off / cnt : 0 };
}

/** Column-major Mat4 mapping manifold (u, v, w) space into the world plane frame. */
export function planeMatrix(plane: Plane, offset = 0): number[] {
  const { U, V, N } = PLANE_FRAMES[plane];
  return [U[0], U[1], U[2], 0, V[0], V[1], V[2], 0, N[0], N[1], N[2], 0, N[0] * offset, N[1] * offset, N[2] * offset, 1];
}

/** 2D polygons → closed polygons (Houdini-style closed curves) in the world plane. */
export function polygonsToGeo(polys: [number, number][][], plane: Plane, offset = 0, asPolygons = true): Geometry {
  const { U, V, N } = PLANE_FRAMES[plane];
  const pos: number[] = [];
  const prims: number[][] = [];
  for (const poly of polys) {
    const ids: number[] = [];
    for (const [u, v] of poly) {
      ids.push(pos.length / 3);
      pos.push(U[0] * u + V[0] * v + N[0] * offset, U[1] * u + V[1] * v + N[1] * offset, U[2] * u + V[2] * v + N[2] * offset);
    }
    prims.push(ids);
  }
  return new Geometry({ positions: pos, prims, closed: asPolygons });
}

/** Triangulated faces (holes respected) for a CrossSection, in the world plane. */
export function crossSectionFaces(cs: any, plane: Plane, offset = 0): Geometry {
  const W = M();
  const parts = cs.decompose();
  const out: Geometry[] = [];
  for (const part of parts) {
    const polys = part.toPolygons() as [number, number][][];
    part.delete();
    if (!polys.length) continue;
    const flat = polys.flat();
    // single contour without holes → keep as one n-gon
    if (polys.length === 1) {
      out.push(polygonsToGeo(polys, plane, offset, true));
      continue;
    }
    const tris = W.triangulate(polys) as [number, number, number][];
    const { U, V, N } = PLANE_FRAMES[plane];
    const pos: number[] = [];
    for (const [u, v] of flat) pos.push(U[0] * u + V[0] * v + N[0] * offset, U[1] * u + V[1] * v + N[1] * offset, U[2] * u + V[2] * v + N[2] * offset);
    out.push(new Geometry({ positions: pos, prims: tris }));
  }
  return Geometry.merge(out);
}
