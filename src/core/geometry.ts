// Houdini-style geometry: points / vertices / primitives / detail, each with attribute
// tables, plus named point & primitive groups and optional SDF volumes.
//
//  points    – positions (P) and per-point attributes
//  prims     – polygons (closed) or polylines (open), stored CSR-style:
//              vertices of prim p are primStart[p] .. primStart[p+1]-1
//  vertices  – polygon corners; vertexPoint[v] is the point a vertex references;
//              per-corner attributes (uv seams, hard normals) live here
//  detail    – one value per geometry (metadata)
//
// Cooked geometry is treated as immutable: nodes clone() before modifying.
import type { Vec3 } from './math.ts';

export type AttribClass = 'point' | 'vertex' | 'prim' | 'detail';
export type AttribType = 'float' | 'int' | 'string';
export type AttribData = Float64Array | Int32Array | string[];
export type AttribValue = number | number[] | string;

export const ATTRIB_CLASSES: AttribClass[] = ['point', 'vertex', 'prim', 'detail'];

/** Houdini-compatible default values for well-known attribute names. */
export function defaultValueFor(name: string, size: number, type: AttribType): number[] | string {
  if (type === 'string') return '';
  const ones = (n: number) => new Array(n).fill(1);
  switch (name) {
    case 'Cd': case 'scale': return ones(size);
    case 'Alpha': case 'pscale': case 'density': case 'mass': return ones(size);
    case 'orient': case 'rot': return size === 4 ? [0, 0, 0, 1] : new Array(size).fill(0);
    case 'up': return size === 3 ? [0, 1, 0] : new Array(size).fill(0);
    default: return new Array(size).fill(0);
  }
}

export class Attribute {
  type: AttribType;
  size: number;
  data: AttribData;
  def: number[] | string;

  constructor(type: AttribType, size: number, data: AttribData, def?: number[] | string) {
    this.type = type;
    this.size = size;
    this.data = data;
    this.def = def ?? (type === 'string' ? '' : new Array(size).fill(0));
  }

  static create(type: AttribType, size: number, count: number, def?: number[] | string): Attribute {
    const d = def ?? (type === 'string' ? '' : new Array(size).fill(0));
    let data: AttribData;
    if (type === 'string') data = new Array(count).fill(d as string);
    else {
      data = type === 'int' ? new Int32Array(count * size) : new Float64Array(count * size);
      const dv = d as number[];
      if (dv.some((x) => x !== 0)) for (let i = 0; i < count; i++) for (let c = 0; c < size; c++) data[i * size + c] = dv[c];
    }
    return new Attribute(type, size, data, d);
  }

  get count(): number {
    return this.type === 'string' ? this.data.length : this.data.length / this.size;
  }

  get(i: number): AttribValue {
    if (this.type === 'string') return (this.data as string[])[i];
    if (this.size === 1) return (this.data as Float64Array)[i];
    const o = i * this.size, out = new Array(this.size);
    for (let c = 0; c < this.size; c++) out[c] = (this.data as Float64Array)[o + c];
    return out;
  }

  set(i: number, v: AttribValue) {
    if (this.type === 'string') {
      (this.data as string[])[i] = String(v);
      return;
    }
    const d = this.data as Float64Array | Int32Array;
    if (typeof v === 'number' || typeof v === 'boolean') {
      for (let c = 0; c < this.size; c++) d[i * this.size + c] = Number(v);
    } else if (Array.isArray(v) || ArrayBuffer.isView(v)) {
      const a = v as ArrayLike<number>;
      for (let c = 0; c < this.size; c++) d[i * this.size + c] = c < a.length ? Number(a[c]) : 0;
    }
  }

  clone(): Attribute {
    const data = this.type === 'string' ? (this.data as string[]).slice() : (this.data as Float64Array).slice();
    return new Attribute(this.type, this.size, data, Array.isArray(this.def) ? this.def.slice() : this.def);
  }

  /** New attribute whose element i is this[indices[i]] (index < 0 → default). */
  gather(indices: ArrayLike<number>): Attribute {
    const n = indices.length, s = this.size;
    const out = Attribute.create(this.type, s, n, this.def);
    if (this.type === 'string') {
      const src = this.data as string[], dst = out.data as string[];
      for (let i = 0; i < n; i++) if (indices[i] >= 0) dst[i] = src[indices[i]];
    } else {
      const src = this.data as Float64Array, dst = out.data as Float64Array;
      for (let i = 0; i < n; i++) {
        const j = indices[i];
        if (j < 0) continue;
        for (let c = 0; c < s; c++) dst[i * s + c] = src[j * s + c];
      }
    }
    return out;
  }
}

export class AttribTable {
  count: number;
  map = new Map<string, Attribute>();

  constructor(count: number) {
    this.count = count;
  }

  has(name: string) { return this.map.has(name); }
  get(name: string) { return this.map.get(name); }
  names() { return [...this.map.keys()]; }
  delete(name: string) { return this.map.delete(name); }

  /** Create (or replace if type/size differ) an attribute. Existing compatible attributes are kept. */
  add(name: string, type: AttribType = 'float', size = 1, def?: number[] | string): Attribute {
    const ex = this.map.get(name);
    if (ex && ex.type === type && ex.size === size) return ex;
    const a = Attribute.create(type, size, this.count, def ?? defaultValueFor(name, size, type));
    // preserve overlapping components when changing size of a numeric attribute
    if (ex && ex.type !== 'string' && type !== 'string') {
      const m = Math.min(ex.size, size);
      for (let i = 0; i < this.count; i++)
        for (let c = 0; c < m; c++) (a.data as Float64Array)[i * size + c] = (ex.data as Float64Array)[i * ex.size + c];
    }
    this.map.set(name, a);
    return a;
  }

  set(name: string, a: Attribute) {
    if (a.count !== this.count) throw new Error(`attribute "${name}" has ${a.count} elements, table has ${this.count}`);
    this.map.set(name, a);
  }

  clone(): AttribTable {
    const t = new AttribTable(this.count);
    for (const [k, v] of this.map) t.map.set(k, v.clone());
    return t;
  }

  gather(indices: ArrayLike<number>): AttribTable {
    const t = new AttribTable(indices.length);
    for (const [k, v] of this.map) t.map.set(k, v.gather(indices));
    return t;
  }
}

/** A signed distance field: negative inside, positive outside. */
export interface Volume {
  name: string;
  kind: 'sdf';
  bounds: { min: Vec3; max: Vec3 };
  sample: (x: number, y: number, z: number) => number;
}

export interface GeoInit {
  positions?: ArrayLike<number>;
  prims?: ArrayLike<number>[];
  closed?: boolean | boolean[];
}

export class Geometry {
  points: AttribTable;
  vertices: AttribTable;
  prims: AttribTable;
  detail: AttribTable;
  primStart: Int32Array;
  vertexPoint: Int32Array;
  primClosed: Uint8Array;
  pointGroups = new Map<string, Uint8Array>();
  primGroups = new Map<string, Uint8Array>();
  volumes: Volume[] = [];

  constructor(init: GeoInit = {}) {
    const pos = init.positions ?? [];
    const np = Math.floor(pos.length / 3);
    this.points = new AttribTable(np);
    const P = this.points.add('P', 'float', 3);
    (P.data as Float64Array).set(pos as ArrayLike<number>);
    const prims = init.prims ?? [];
    let nv = 0;
    for (const p of prims) nv += p.length;
    this.primStart = new Int32Array(prims.length + 1);
    this.vertexPoint = new Int32Array(nv);
    this.primClosed = new Uint8Array(prims.length);
    let v = 0;
    prims.forEach((p, i) => {
      this.primStart[i] = v;
      for (let k = 0; k < p.length; k++) this.vertexPoint[v++] = p[k];
      const c = init.closed;
      this.primClosed[i] = (Array.isArray(c) ? c[i] : c ?? true) ? 1 : 0;
    });
    this.primStart[prims.length] = v;
    this.vertices = new AttribTable(nv);
    this.prims = new AttribTable(prims.length);
    this.detail = new AttribTable(1);
  }

  static empty() { return new Geometry(); }

  get numPoints() { return this.points.count; }
  get numPrims() { return this.primClosed.length; }
  get numVertices() { return this.vertexPoint.length; }
  get P(): Float64Array { return this.points.get('P')!.data as Float64Array; }

  table(cls: AttribClass): AttribTable {
    return cls === 'point' ? this.points : cls === 'vertex' ? this.vertices : cls === 'prim' ? this.prims : this.detail;
  }

  groups(cls: 'point' | 'prim') { return cls === 'point' ? this.pointGroups : this.primGroups; }

  /** Find an attribute by name, searching classes in Houdini precedence order (vertex, point, prim, detail). */
  findAttrib(name: string, order: AttribClass[] = ['vertex', 'point', 'prim', 'detail']) {
    for (const c of order) {
      const a = this.table(c).get(name);
      if (a) return { cls: c, attr: a };
    }
    return null;
  }

  primSize(p: number) { return this.primStart[p + 1] - this.primStart[p]; }

  primPoints(p: number): number[] {
    const out: number[] = [];
    for (let v = this.primStart[p]; v < this.primStart[p + 1]; v++) out.push(this.vertexPoint[v]);
    return out;
  }

  /** Map each vertex to its primitive. */
  vertexPrims(): Int32Array {
    const out = new Int32Array(this.numVertices);
    for (let p = 0; p < this.numPrims; p++) for (let v = this.primStart[p]; v < this.primStart[p + 1]; v++) out[v] = p;
    return out;
  }

  clone(): Geometry {
    const g = Object.create(Geometry.prototype) as Geometry;
    g.points = this.points.clone();
    g.vertices = this.vertices.clone();
    g.prims = this.prims.clone();
    g.detail = this.detail.clone();
    g.primStart = this.primStart.slice();
    g.vertexPoint = this.vertexPoint.slice();
    g.primClosed = this.primClosed.slice();
    g.pointGroups = new Map([...this.pointGroups].map(([k, v]) => [k, v.slice()]));
    g.primGroups = new Map([...this.primGroups].map(([k, v]) => [k, v.slice()]));
    g.volumes = this.volumes.slice();
    return g;
  }

  bbox(includeVolumes = false): { min: Vec3; max: Vec3; empty: boolean } {
    const P = this.P;
    const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < P.length; i += 3) {
      const x = P[i], y = P[i + 1], z = P[i + 2];
      if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x;
      if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y;
      if (z < min[2]) min[2] = z; if (z > max[2]) max[2] = z;
    }
    if (includeVolumes)
      for (const v of this.volumes)
        for (let c = 0; c < 3; c++) {
          min[c] = Math.min(min[c], v.bounds.min[c]);
          max[c] = Math.max(max[c], v.bounds.max[c]);
        }
    const empty = !(min[0] <= max[0]);
    return empty ? { min: [0, 0, 0], max: [0, 0, 0], empty } : { min, max, empty };
  }

  addGroup(cls: 'point' | 'prim', name: string, mask?: Uint8Array): Uint8Array {
    const n = cls === 'point' ? this.numPoints : this.numPrims;
    const m = mask ?? new Uint8Array(n);
    if (m.length !== n) throw new Error(`group mask size ${m.length} != ${n}`);
    this.groups(cls).set(name, m);
    return m;
  }

  /** Keep only primitives where keep[p] is truthy. Optionally drop points no longer referenced. */
  subsetPrims(keep: ArrayLike<number | boolean>, removeUnusedPoints = true): Geometry {
    const primIdx: number[] = [], vtxIdx: number[] = [];
    const starts: number[] = [0];
    for (let p = 0; p < this.numPrims; p++) {
      if (!keep[p]) continue;
      primIdx.push(p);
      for (let v = this.primStart[p]; v < this.primStart[p + 1]; v++) vtxIdx.push(v);
      starts.push(vtxIdx.length);
    }
    const g = this.clone();
    g.prims = this.prims.gather(primIdx);
    g.vertices = this.vertices.gather(vtxIdx);
    g.primClosed = Uint8Array.from(primIdx, (p) => this.primClosed[p]);
    g.primStart = Int32Array.from(starts);
    g.vertexPoint = Int32Array.from(vtxIdx, (v) => this.vertexPoint[v]);
    g.primGroups = new Map([...this.primGroups].map(([k, m]) => [k, Uint8Array.from(primIdx, (p) => m[p])]));
    return removeUnusedPoints ? g.removeUnusedPoints() : g;
  }

  /** Drop points not referenced by any primitive (keeps all if there are no prims and keepIsolated). */
  removeUnusedPoints(): Geometry {
    const used = new Uint8Array(this.numPoints);
    for (let v = 0; v < this.numVertices; v++) used[this.vertexPoint[v]] = 1;
    return this.subsetPoints(used);
  }

  /**
   * Keep points where keep[i] is truthy. Closed polygons that lose a point are deleted;
   * open polylines lose those vertices (and are deleted if fewer than 2 remain).
   */
  subsetPoints(keep: ArrayLike<number | boolean>): Geometry {
    const remap = new Int32Array(this.numPoints).fill(-1);
    const ptIdx: number[] = [];
    for (let i = 0; i < this.numPoints; i++) if (keep[i]) { remap[i] = ptIdx.length; ptIdx.push(i); }
    if (ptIdx.length === this.numPoints) return this.clone();
    const primIdx: number[] = [], vtxIdx: number[] = [], starts = [0];
    for (let p = 0; p < this.numPrims; p++) {
      const s = this.primStart[p], e = this.primStart[p + 1];
      let missing = 0;
      for (let v = s; v < e; v++) if (remap[this.vertexPoint[v]] < 0) missing++;
      if (missing && this.primClosed[p]) continue;
      if (e - s - missing < (this.primClosed[p] ? 1 : 2)) continue;
      primIdx.push(p);
      for (let v = s; v < e; v++) if (remap[this.vertexPoint[v]] >= 0) vtxIdx.push(v);
      starts.push(vtxIdx.length);
    }
    const g = Object.create(Geometry.prototype) as Geometry;
    g.points = this.points.gather(ptIdx);
    g.vertices = this.vertices.gather(vtxIdx);
    g.prims = this.prims.gather(primIdx);
    g.detail = this.detail.clone();
    g.primStart = Int32Array.from(starts);
    g.vertexPoint = Int32Array.from(vtxIdx, (v) => remap[this.vertexPoint[v]]);
    g.primClosed = Uint8Array.from(primIdx, (p) => this.primClosed[p]);
    g.pointGroups = new Map([...this.pointGroups].map(([k, m]) => [k, Uint8Array.from(ptIdx, (i) => m[i])]));
    g.primGroups = new Map([...this.primGroups].map(([k, m]) => [k, Uint8Array.from(primIdx, (p) => m[p])]));
    g.volumes = this.volumes.slice();
    return g;
  }

  /**
   * Concatenate geometries. Attributes are unioned; missing values take attribute defaults.
   * Display attributes (Cd, Alpha, N, uv) that live on different classes in different inputs
   * are promoted to vertex attributes first, so every input keeps its look (a point Cd from one
   * input never masks a prim Cd from another).
   */
  static merge(geos: Geometry[]): Geometry {
    geos = geos.filter(Boolean);
    if (geos.length === 0) return new Geometry();
    if (geos.length === 1) return geos[0].clone();
    geos = unifyDisplayAttribs(geos);
    const out = Object.create(Geometry.prototype) as Geometry;
    const total = (f: (g: Geometry) => number) => geos.reduce((s, g) => s + f(g), 0);
    const np = total((g) => g.numPoints), nv = total((g) => g.numVertices), nprim = total((g) => g.numPrims);
    out.points = mergeTables(geos.map((g) => g.points), np);
    out.vertices = mergeTables(geos.map((g) => g.vertices), nv);
    out.prims = mergeTables(geos.map((g) => g.prims), nprim);
    out.detail = new AttribTable(1);
    for (const g of geos) for (const [k, a] of g.detail.map) if (!out.detail.has(k)) out.detail.map.set(k, a.clone());
    out.primStart = new Int32Array(nprim + 1);
    out.vertexPoint = new Int32Array(nv);
    out.primClosed = new Uint8Array(nprim);
    let po = 0, vo = 0, pro = 0;
    for (const g of geos) {
      for (let v = 0; v < g.numVertices; v++) out.vertexPoint[vo + v] = g.vertexPoint[v] + po;
      for (let p = 0; p < g.numPrims; p++) {
        out.primStart[pro + p] = g.primStart[p] + vo;
        out.primClosed[pro + p] = g.primClosed[p];
      }
      po += g.numPoints; vo += g.numVertices; pro += g.numPrims;
    }
    out.primStart[nprim] = nv;
    out.pointGroups = mergeGroups(geos.map((g) => [g.pointGroups, g.numPoints] as const), np);
    out.primGroups = mergeGroups(geos.map((g) => [g.primGroups, g.numPrims] as const), nprim);
    out.volumes = geos.flatMap((g) => g.volumes);
    return out;
  }
}

const DISPLAY_ATTRIBS = ['Cd', 'Alpha', 'N', 'uv'];

/** Promote display attributes to vertex class where inputs disagree on their class. */
function unifyDisplayAttribs(geos: Geometry[]): Geometry[] {
  let out = geos;
  for (const name of DISPLAY_ATTRIBS) {
    const classes = new Set<AttribClass>();
    for (const g of geos) for (const c of ATTRIB_CLASSES) if (g.table(c).get(name)?.type === 'float') classes.add(c);
    if (classes.size <= 1) continue;
    out = out.map((g) => {
      const f = g.findAttrib(name);
      if (!f || f.cls === 'vertex' || f.attr.type !== 'float') return g;
      const c = geos.includes(g) ? g.clone() : g; // never mutate cooked inputs
      const src = c.table(f.cls).get(name)!;
      const vp = f.cls === 'prim' ? c.vertexPrims() : null;
      const idx = Int32Array.from({ length: c.numVertices }, (_, v) => (f.cls === 'point' ? c.vertexPoint[v] : f.cls === 'prim' ? vp![v] : 0));
      c.vertices.set(name, src.gather(idx));
      for (const cls of ['point', 'prim', 'detail'] as AttribClass[]) c.table(cls).delete(name);
      return c;
    });
  }
  return out;
}

function mergeTables(tables: AttribTable[], count: number): AttribTable {
  const out = new AttribTable(count);
  const schema = new Map<string, { type: AttribType; size: number; def: number[] | string }>();
  for (const t of tables)
    for (const [k, a] of t.map) {
      const s = schema.get(k);
      if (!s) schema.set(k, { type: a.type, size: a.size, def: a.def });
      else {
        if (a.type === 'string' || s.type === 'string') s.type = 'string';
        else if (a.type === 'float') s.type = 'float';
        if (a.size > s.size) { s.size = a.size; s.def = a.def; }
      }
    }
  for (const [k, s] of schema) {
    const def = s.type === 'string' ? '' : padDef(s.def, s.size);
    const dst = Attribute.create(s.type, s.size, count, def);
    let off = 0;
    for (const t of tables) {
      const src = t.map.get(k);
      if (src) {
        if (s.type === 'string') {
          const d = dst.data as string[];
          for (let i = 0; i < t.count; i++) d[off + i] = String(src.get(i));
        } else if (src.type === 'string') {
          // numeric destination, string source: leave defaults
        } else {
          const d = dst.data as Float64Array, sd = src.data as Float64Array, m = Math.min(src.size, s.size);
          for (let i = 0; i < t.count; i++) for (let c = 0; c < m; c++) d[(off + i) * s.size + c] = sd[i * src.size + c];
        }
      }
      off += t.count;
    }
    out.map.set(k, dst);
  }
  return out;
}

function padDef(def: number[] | string, size: number): number[] {
  const d = Array.isArray(def) ? def.slice(0, size) : [];
  while (d.length < size) d.push(0);
  return d;
}

function mergeGroups(list: (readonly [Map<string, Uint8Array>, number])[], count: number) {
  const names = new Set<string>();
  for (const [m] of list) for (const k of m.keys()) names.add(k);
  const out = new Map<string, Uint8Array>();
  for (const n of names) {
    const mask = new Uint8Array(count);
    let off = 0;
    for (const [m, c] of list) {
      const g = m.get(n);
      if (g) mask.set(g, off);
      off += c;
    }
    out.set(n, mask);
  }
  return out;
}

// ---------------------------------------------------------------- builder

/** Provenance of a new element: a source index, a weighted blend of sources, or nothing. */
export type Src = number | { i: ArrayLike<number>; w: ArrayLike<number> } | null | undefined;

class GrowAttr {
  type: AttribType; size: number; def: number[] | string;
  vals: (number[] | string | undefined)[] = [];
  constructor(type: AttribType, size: number, def: number[] | string) { this.type = type; this.size = size; this.def = def; }
  set(i: number, v: number | number[] | string) {
    this.vals[i] = typeof v === 'number' ? new Array(this.size).fill(v) : (v as any);
  }
}

/**
 * Incrementally builds new geometry. Elements can carry provenance (which source
 * point / vertex / prim they came from, or a weighted blend) and every attribute and
 * group of the source geometry is interpolated onto the result automatically.
 */
export class GeoBuilder {
  src: Geometry | null;
  pos: number[] = [];
  private ptSrc: Src[] = [];
  private vtxSrc: Src[] = [];
  private primSrc: number[] = [];
  private vp: number[] = [];
  private starts: number[] = [0];
  private closed: number[] = [];
  private grow = { point: new Map<string, GrowAttr>(), vertex: new Map<string, GrowAttr>(), prim: new Map<string, GrowAttr>() };
  private grpPoint = new Map<string, Set<number>>();
  private grpPrim = new Map<string, Set<number>>();
  /** Source attribute names to skip when interpolating. */
  skip = { point: new Set<string>(), vertex: new Set<string>(), prim: new Set<string>() };
  keepSrcGroups = true;
  volumes: Volume[];

  constructor(src: Geometry | null = null) {
    this.src = src;
    this.volumes = src ? src.volumes.slice() : [];
  }

  get numPoints() { return this.pos.length / 3; }
  get numPrims() { return this.closed.length; }
  get numVertices() { return this.vp.length; }

  addPoint(x: number, y: number, z: number, src: Src = null): number {
    this.pos.push(x, y, z);
    this.ptSrc.push(src);
    return this.pos.length / 3 - 1;
  }

  /** Copy a source point (position + attributes). */
  copyPoint(srcPt: number): number {
    const P = this.src!.P;
    return this.addPoint(P[srcPt * 3], P[srcPt * 3 + 1], P[srcPt * 3 + 2], srcPt);
  }

  /** Point at the weighted blend of source points (position interpolated too). */
  blendPoint(idx: ArrayLike<number>, w: ArrayLike<number>): number {
    const P = this.src!.P;
    let x = 0, y = 0, z = 0;
    for (let k = 0; k < idx.length; k++) {
      x += P[idx[k] * 3] * w[k]; y += P[idx[k] * 3 + 1] * w[k]; z += P[idx[k] * 3 + 2] * w[k];
    }
    return this.addPoint(x, y, z, { i: idx, w });
  }

  /** Add a polygon (closed) or polyline (open). vtxSrc gives per-corner provenance. */
  addPrim(pts: ArrayLike<number>, closed = true, primSrc = -1, vtxSrc?: ArrayLike<Src> | Src[]): number {
    for (let k = 0; k < pts.length; k++) {
      this.vp.push(pts[k]);
      this.vtxSrc.push(vtxSrc ? (vtxSrc as Src[])[k] : null);
    }
    this.starts.push(this.vp.length);
    this.closed.push(closed ? 1 : 0);
    this.primSrc.push(primSrc);
    return this.closed.length - 1;
  }

  /** Explicitly set attribute values on new elements (overrides interpolated values). */
  attrib(cls: 'point' | 'vertex' | 'prim', name: string, size = 1, type: AttribType = 'float', def?: number[] | string): GrowAttr {
    const m = this.grow[cls];
    let a = m.get(name);
    if (!a) {
      a = new GrowAttr(type, size, def ?? defaultValueFor(name, size, type));
      m.set(name, a);
    }
    return a;
  }

  group(cls: 'point' | 'prim', name: string): Set<number> {
    const m = cls === 'point' ? this.grpPoint : this.grpPrim;
    let s = m.get(name);
    if (!s) { s = new Set(); m.set(name, s); }
    return s;
  }

  build(): Geometry {
    const g = Object.create(Geometry.prototype) as Geometry;
    const np = this.numPoints, nv = this.numVertices, npr = this.numPrims;
    const src = this.src;
    g.points = src ? interpTable(src.points, this.ptSrc, this.skip.point, ['P']) : new AttribTable(np);
    const P = g.points.add('P', 'float', 3);
    (P.data as Float64Array).set(this.pos);
    g.vertices = src ? interpTable(src.vertices, this.vtxSrc, this.skip.vertex, []) : new AttribTable(nv);
    g.prims = src ? interpTable(src.prims, this.primSrc, this.skip.prim, []) : new AttribTable(npr);
    g.detail = src ? src.detail.clone() : new AttribTable(1);
    applyGrow(g.points, this.grow.point);
    applyGrow(g.vertices, this.grow.vertex);
    applyGrow(g.prims, this.grow.prim);
    g.primStart = Int32Array.from(this.starts);
    g.vertexPoint = Int32Array.from(this.vp);
    g.primClosed = Uint8Array.from(this.closed);
    g.pointGroups = new Map();
    g.primGroups = new Map();
    if (src && this.keepSrcGroups) {
      for (const [k, m] of src.pointGroups) g.pointGroups.set(k, interpMask(m, this.ptSrc));
      for (const [k, m] of src.primGroups) g.primGroups.set(k, interpMask(m, this.primSrc));
    }
    // groups created by the node replace same-named source groups
    for (const [k, s] of this.grpPoint) {
      const m = new Uint8Array(np);
      for (const i of s) m[i] = 1;
      g.pointGroups.set(k, m);
    }
    for (const [k, s] of this.grpPrim) {
      const m = new Uint8Array(npr);
      for (const i of s) m[i] = 1;
      g.primGroups.set(k, m);
    }
    g.volumes = this.volumes;
    return g;
  }
}

function dominant(s: Src): number {
  if (s === null || s === undefined) return -1;
  if (typeof s === 'number') return s;
  let best = -1, bw = -Infinity;
  for (let k = 0; k < s.i.length; k++) if (s.w[k] > bw) { bw = s.w[k]; best = s.i[k]; }
  return best;
}

function interpTable(t: AttribTable, srcs: Src[] | number[], skip: Set<string>, alsoSkip: string[]): AttribTable {
  const n = srcs.length;
  const out = new AttribTable(n);
  for (const [name, a] of t.map) {
    if (skip.has(name) || alsoSkip.includes(name)) continue;
    const dst = Attribute.create(a.type, a.size, n, a.def);
    const s = a.size;
    if (a.type === 'float') {
      const sd = a.data as Float64Array, dd = dst.data as Float64Array;
      for (let i = 0; i < n; i++) {
        const src = srcs[i];
        if (src === null || src === undefined || (typeof src === 'number' && src < 0)) continue;
        if (typeof src === 'number') {
          for (let c = 0; c < s; c++) dd[i * s + c] = sd[src * s + c];
        } else {
          for (let c = 0; c < s; c++) {
            let acc = 0;
            for (let k = 0; k < src.i.length; k++) acc += sd[src.i[k] * s + c] * src.w[k];
            dd[i * s + c] = acc;
          }
        }
      }
    } else {
      for (let i = 0; i < n; i++) {
        const j = dominant(srcs[i]);
        if (j >= 0) dst.set(i, a.get(j));
      }
    }
    out.map.set(name, dst);
  }
  return out;
}

function interpMask(m: Uint8Array, srcs: Src[] | number[]): Uint8Array {
  const out = new Uint8Array(srcs.length);
  for (let i = 0; i < srcs.length; i++) {
    const j = dominant(srcs[i]);
    if (j >= 0) out[i] = m[j];
  }
  return out;
}

function applyGrow(t: AttribTable, grow: Map<string, GrowAttr>) {
  for (const [name, ga] of grow) {
    const ex = t.get(name);
    const a = ex && ex.type === ga.type && ex.size === ga.size ? ex : t.add(name, ga.type, ga.size, ga.def);
    for (let i = 0; i < t.count; i++) {
      const v = ga.vals[i];
      if (v !== undefined) a.set(i, v as any);
    }
  }
}
