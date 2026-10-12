// Lossless native format: all attributes, groups and topology.
import { Attribute, AttribTable, Geometry, baseType, isArrayType } from '../core/geometry.ts';
import type { AttribType } from '../core/geometry.ts';
import { EdgeSet } from '../core/edges.ts';

function tableToJSON(t: AttribTable) {
  const out: Record<string, any> = {};
  for (const [k, a] of t.map) {
    // array attributes: CSR offsets (count + 1) + flat entries; element i = data[offsets[i] .. offsets[i+1])
    if (a.isArray) { a.compact(); out[k] = { type: a.type, size: 1, offsets: Array.from(a.offsets!), data: Array.from(a.data as any) }; }
    else out[k] = { type: a.type, size: a.size, data: Array.from(a.data as any) };
  }
  return out;
}

function tableFromJSON(count: number, obj: Record<string, any> | undefined): AttribTable {
  const t = new AttribTable(count);
  for (const [k, a] of Object.entries(obj ?? {})) {
    const type = a.type as AttribType;
    const base = baseType(type);
    const data = base === 'string' ? (a.data as string[]).slice() : base === 'int' ? Int32Array.from(a.data) : Float64Array.from(a.data);
    if (isArrayType(type)) {
      const off = Int32Array.from(a.offsets ?? []);
      let ok = off.length === count + 1 && off[0] === 0 && off[count] === data.length;
      for (let i = 0; ok && i < count; i++) if (off[i + 1] < off[i]) ok = false;
      if (!ok) throw new Error(`attribute "${k}" (${type}): offsets must have ${count + 1} non-decreasing entries from 0 to ${data.length}`);
      t.map.set(k, new Attribute(type, 1, data, [], off));
    } else t.map.set(k, new Attribute(type, a.size, data));
  }
  return t;
}

const groupsToJSON = (m: Map<string, Uint8Array>) => {
  const o: Record<string, number[]> = {};
  for (const [k, mask] of m) { const idx: number[] = []; mask.forEach((v, i) => v && idx.push(i)); o[k] = idx; }
  return o;
};

/** Edge groups as flat sorted point-pair lists [a0, b0, a1, b1, ...] (a < b). */
const edgeGroupsToJSON = (m: Map<string, EdgeSet>) => {
  const o: Record<string, number[]> = {};
  for (const [k, set] of m) o[k] = Array.from(set.toPairs());
  return o;
};

export function geoToJSON(g: Geometry) {
  const groups: Record<string, Record<string, number[]>> = { point: groupsToJSON(g.pointGroups), prim: groupsToJSON(g.primGroups) };
  // written only when present, so files without them are unchanged
  if (g.vertexGroups.size) groups.vertex = groupsToJSON(g.vertexGroups);
  if (g.edgeGroups.size) groups.edge = edgeGroupsToJSON(g.edgeGroups);
  const out: Record<string, any> = {
    format: 'polyforge-geo',
    version: 1,
    points: { count: g.numPoints, attribs: tableToJSON(g.points) },
    vertices: { count: g.numVertices, points: Array.from(g.vertexPoint), attribs: tableToJSON(g.vertices) },
    prims: { count: g.numPrims, start: Array.from(g.primStart), closed: Array.from(g.primClosed), attribs: tableToJSON(g.prims) },
    detail: { attribs: tableToJSON(g.detail) },
    groups,
  };
  // packed instances (only when present): the packed prim numbers, their source index and 3×3 (9 numbers, column-major),
  // and each source once, recursively in the same format
  if (g.hasPacked()) {
    const prims: number[] = [], source: number[] = [], xform: number[] = [];
    const k = g.primKind!, S = g.packedSource!, X = g.packedXform!;
    for (let p = 0; p < k.length; p++) if (k[p]) { prims.push(p); source.push(S[p]); for (let c = 0; c < 9; c++) xform.push(X[p * 9 + c]); }
    out.packed = { prims, source, xform, sources: g.packedSources.map(geoToJSON) };
  }
  return out;
}

export function geoFromJSON(j: any): Geometry {
  if (j?.format !== 'polyforge-geo') throw new Error('not a polyforge-geo JSON file');
  const g = new Geometry();
  g.points = tableFromJSON(j.points.count, j.points.attribs);
  if (!g.points.has('P')) g.points.add('P', 'float', 3);
  g.vertices = tableFromJSON(j.vertices.count, j.vertices.attribs);
  g.prims = tableFromJSON(j.prims.count, j.prims.attribs);
  g.detail = tableFromJSON(1, j.detail?.attribs);
  g.vertexPoint = Int32Array.from(j.vertices.points);
  g.primStart = Int32Array.from(j.prims.start);
  g.primClosed = Uint8Array.from(j.prims.closed);
  for (const [cls, n] of [['point', g.numPoints], ['prim', g.numPrims], ['vertex', g.numVertices]] as const)
    for (const [k, idx] of Object.entries(j.groups?.[cls] ?? {})) {
      const m = new Uint8Array(n);
      for (const i of idx as number[]) m[i] = 1;
      g.groups(cls).set(k, m);
    }
  for (const [k, pairs] of Object.entries(j.groups?.edge ?? {})) {
    const set = new EdgeSet();
    const arr = pairs as number[];
    for (let i = 0; i + 1 < arr.length; i += 2)
      if (arr[i] >= 0 && arr[i] < g.numPoints && arr[i + 1] >= 0 && arr[i + 1] < g.numPoints) set.add(arr[i], arr[i + 1]);
    g.edgeGroups.set(k, set);
  }
  const pk = j.packed;
  if (pk && Array.isArray(pk.prims) && pk.prims.length) {
    const sources = (pk.sources ?? []).map(geoFromJSON);
    g.ensurePacked();
    pk.prims.forEach((p: number, i: number) => {
      const s = pk.source?.[i];
      if (!(Number.isInteger(p) && p >= 0 && p < g.numPrims && g.primSize(p) === 1)) throw new Error(`packed prim ${p}: not a one-vertex prim of this geometry`);
      if (!(Number.isInteger(s) && s >= 0 && s < sources.length)) throw new Error(`packed prim ${p}: source ${s} out of range (${sources.length} sources)`);
      g.primKind![p] = 1;
      g.packedSource![p] = s;
      for (let c = 0; c < 9; c++) g.packedXform![p * 9 + c] = Number(pk.xform?.[i * 9 + c] ?? (c % 4 === 0 ? 1 : 0));
    });
    g.packedSources = sources;
    g.compactPackedSources();
  }
  return g;
}
