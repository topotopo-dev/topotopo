// Houdini-style geometry: points / vertices / primitives / detail, each with attribute
// tables, plus named point, vertex, primitive and edge groups and optional volumes (SDFs, heightfields).
//
//  points    – positions (P) and per-point attributes
//  prims     – polygons (closed) or polylines (open), stored CSR-style:
//              vertices of prim p are primStart[p] .. primStart[p+1]-1
//  vertices  – polygon corners; vertexPoint[v] is the point a vertex references;
//              per-corner attributes (uv seams, hard normals) live here
//  detail    – one value per geometry (metadata)
//
// Attributes: fixed-size float/int tuples or strings, or variable-length arrays (float[], int[],
// string[]) stored CSR-style (offsets + flat entries), see Attribute.
//
// Groups: point, vertex and prim groups are byte masks (one byte per element). Edge groups are
// EdgeSets of unordered point pairs (see edges.ts): they survive every operation that keeps
// point numbers and are remapped wherever points are renumbered or deleted.
//
// Packed primitives (instances, see packed.ts): a prim with primKind 1 has exactly one vertex, whose point is the
// instance anchor (P = instance position, as in Houdini), and references a shared, immutable source Geometry
// (packedSources[packedSource[p]]) through a 3×3 rotation·scale matrix (packedXform, 9 numbers per prim, column-major).
// World transform of the instance = translate(P[anchor]) · packedXform. primClosed is 0 for packed prims. The three
// per-prim arrays are allocated lazily (absent = no packed prims) and travel with clone, merge, subsets and GeoBuilder.
//
// Cooked geometry is treated as immutable: nodes clone() before modifying. Packed sources are never modified.
import type { Mat4, Vec3 } from './math.ts';
import { EdgeSet, EDGE_KEY_LIMIT } from './edges.ts';
import { geoContentHash } from './geohash.ts';

export type AttribClass = 'point' | 'vertex' | 'prim' | 'detail';
/** Element types: fixed-size tuples (float/int with tuple size 1-16, or string) and variable-length arrays. */
export type AttribBaseType = 'float' | 'int' | 'string';
export type AttribArrayType = 'float[]' | 'int[]' | 'string[]';
export type AttribType = AttribBaseType | AttribArrayType;
export type AttribData = Float64Array | Int32Array | string[];
/**
 * A value as returned by Attribute.get: a number (size 1), a tuple, a string, or the array of an
 * array attribute (string[] attributes return string arrays; use getArray() for a precise type).
 */
export type AttribValue = number | number[] | string;

export const ATTRIB_CLASSES: AttribClass[] = ['point', 'vertex', 'prim', 'detail'];
export const ARRAY_TYPES: AttribArrayType[] = ['float[]', 'int[]', 'string[]'];

/** Is t an array attribute type ('float[]', 'int[]', 'string[]')? */
export function isArrayType(t: string): t is AttribArrayType {
  return t === 'float[]' || t === 'int[]' || t === 'string[]';
}
/** Entry type of an attribute type: 'float[]' → 'float'; fixed types map to themselves. */
export function baseType(t: AttribType): AttribBaseType {
  return (isArrayType(t) ? t.slice(0, -2) : t) as AttribBaseType;
}
/** The array type whose entries have type t: 'float' → 'float[]'. */
export function arrayType(t: AttribType): AttribArrayType {
  return (isArrayType(t) ? t : t + '[]') as AttribArrayType;
}

/** Flat entry storage for n entries of an array type. */
function arrayStore(t: AttribType, n: number): AttribData {
  return t === 'string[]' ? new Array<string>(n).fill('') : t === 'int[]' ? new Int32Array(n) : new Float64Array(n);
}

/** Write vals into flat array storage at pos, converted to the entry type (Int32Array storage truncates ints). */
function writeEntries(t: AttribType, d: AttribData, pos: number, vals: ArrayLike<any>) {
  if (t === 'string[]') for (let k = 0; k < vals.length; k++) (d as string[])[pos + k] = String(vals[k] ?? '');
  else for (let k = 0; k < vals.length; k++) (d as Float64Array)[pos + k] = Number(vals[k]);
}

/** A value assigned to an array element: arrays/typed arrays as they are, null/undefined = empty, a scalar = one entry. */
function asEntries(v: any): ArrayLike<any> {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v) || ArrayBuffer.isView(v)) return v as ArrayLike<any>;
  return [typeof v === 'boolean' ? +v : v];
}

/** Element classes that can hold groups. Point, vertex and prim groups are masks; edge groups are EdgeSets. */
export type GroupClass = 'point' | 'vertex' | 'prim' | 'edge';
export type MaskGroupClass = 'point' | 'vertex' | 'prim';
export const GROUP_CLASSES: GroupClass[] = ['point', 'vertex', 'prim', 'edge'];

/** Houdini-compatible default values for well-known attribute names. */
export function defaultValueFor(name: string, size: number, type: AttribType): number[] | string {
  if (isArrayType(type)) return []; // array attributes default to the empty array
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

/**
 * One attribute: a value per element of a class.
 *
 * Fixed-size attributes (float/int tuples of `size` components, or strings) store `data` flat,
 * element i at data[i*size .. i*size+size).
 *
 * Array attributes ('float[]', 'int[]', 'string[]'; `size` is always 1) hold a variable-length list
 * per element in CSR form: `offsets` (count + 1 entries) and flat entry storage `data`
 * (Float64Array, Int32Array or string[]), element i = data[offsets[i] .. offsets[i+1]). A million
 * short arrays therefore cost two typed arrays, not a million objects. `get(i)` returns a fresh JS
 * array (a copy), `set(i, arr)` accepts any length (a scalar is a one-entry array, null/undefined
 * empty). A set that changes an element's length switches the attribute to a "loose" layout (entries
 * appended to amortised-growing storage, per-element start + length) instead of shifting everything
 * after it; `compact()` restores canonical CSR. Code reading `offsets`/`data` of an array attribute
 * directly must call `compact()` first (clone, gather, IO and fingerprints do).
 */
export class Attribute {
  type: AttribType;
  size: number;
  data: AttribData;
  def: number[] | string;
  /** Array attributes only: CSR offsets, count + 1 entries (starts of the elements while loose). */
  offsets: Int32Array | undefined;
  /** Array attributes in loose layout: per-element entry counts (undefined when compact). */
  private lens: Int32Array | undefined;
  /** Array attributes in loose layout: entries used in data (the rest is growth room). */
  private used = 0;

  constructor(type: AttribType, size: number, data: AttribData, def?: number[] | string, offsets?: Int32Array) {
    const arr = isArrayType(type);
    if (arr && !offsets) throw new Error(`array attribute (${type}) needs offsets`);
    this.type = type;
    this.size = arr ? 1 : size;
    this.data = data;
    this.def = arr ? [] : def ?? (type === 'string' ? '' : new Array(size).fill(0));
    this.offsets = arr ? offsets : undefined;
    this.lens = undefined;
  }

  static create(type: AttribType, size: number, count: number, def?: number[] | string): Attribute {
    if (isArrayType(type)) return new Attribute(type, 1, arrayStore(type, 0), [], new Int32Array(count + 1));
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

  /**
   * An array attribute from one list per element (plain arrays or typed arrays), e.g.
   * Attribute.fromArrays('int[]', [[1, 2], [], [3]]).
   */
  static fromArrays(type: AttribArrayType, lists: ArrayLike<ArrayLike<any> | null | undefined>): Attribute {
    const n = lists.length, off = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) off[i + 1] = off[i] + asEntries(lists[i]).length;
    const data = arrayStore(type, off[n]);
    for (let i = 0; i < n; i++) writeEntries(type, data, off[i], asEntries(lists[i]));
    return new Attribute(type, 1, data, [], off);
  }

  /** True for 'float[]', 'int[]' and 'string[]' attributes. */
  get isArray(): boolean {
    return this.offsets !== undefined;
  }

  get count(): number {
    if (this.offsets) return this.offsets.length - 1;
    return this.type === 'string' ? this.data.length : this.data.length / this.size;
  }

  /** Array attributes: number of entries of element i (no allocation). Fixed attributes: the tuple size. */
  arrayLength(i: number): number {
    const o = this.offsets;
    if (!o) return this.size;
    return this.lens ? this.lens[i] : o[i + 1] - o[i];
  }

  get(i: number): AttribValue {
    if (this.offsets) return this.getArray(i) as number[];
    if (this.type === 'string') return (this.data as string[])[i];
    if (this.size === 1) return (this.data as Float64Array)[i];
    const o = i * this.size, out = new Array(this.size);
    for (let c = 0; c < this.size; c++) out[c] = (this.data as Float64Array)[o + c];
    return out;
  }

  /**
   * Array attributes: a copy of element i's list (numbers, or strings for string[]), written into `out`
   * when given (lets the wrangle realm receive its own arrays). Fixed attributes: the value as an array.
   */
  getArray(i: number, out?: any[]): number[] | string[] {
    const o = this.offsets;
    if (!o) {
      const v = this.get(i);
      if (!out) return Array.isArray(v) ? v : [v as any];
      out.length = 0;
      if (Array.isArray(v)) for (const x of v) out.push(x); else out.push(v);
      return out;
    }
    const s = o[i], n = this.lens ? this.lens[i] : o[i + 1] - s, d = this.data;
    const r = out ?? new Array(n);
    r.length = n;
    for (let k = 0; k < n; k++) r[k] = d[s + k];
    return r;
  }

  set(i: number, v: AttribValue | string[] | ArrayLike<number>) {
    if (this.offsets) {
      this.setArray(i, v);
      return;
    }
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

  /** Array attributes: replace element i's list (any length). */
  private setArray(i: number, v: any) {
    const vals = asEntries(v), n = vals.length, o = this.offsets!;
    if (!this.lens) {
      if (o[i + 1] - o[i] === n) { writeEntries(this.type, this.data, o[i], vals); return; }
      this.loosen();
    }
    const lens = this.lens!;
    if (n <= lens[i]) { writeEntries(this.type, this.data, o[i], vals); lens[i] = n; return; }
    // append at the end of the used storage (typed storage grows geometrically; string storage by push)
    const need = this.used + n;
    if (this.type === 'string[]') {
      const d = this.data as string[];
      d.length = this.used;
      for (let k = 0; k < n; k++) d.push(String(vals[k] ?? ''));
    } else {
      if (need > this.data.length) {
        const grown = this.type === 'int[]' ? new Int32Array(Math.max(need, this.data.length * 2, 16)) : new Float64Array(Math.max(need, this.data.length * 2, 16));
        grown.set((this.data as Float64Array).subarray(0, this.used));
        this.data = grown;
      }
      writeEntries(this.type, this.data, this.used, vals);
    }
    o[i] = this.used;
    lens[i] = n;
    this.used = need;
  }

  /** Switch an array attribute to the loose layout (offsets become starts, lengths kept separately). */
  private loosen() {
    const o = this.offsets!, n = o.length - 1, lens = new Int32Array(n);
    for (let i = 0; i < n; i++) lens[i] = o[i + 1] - o[i];
    this.lens = lens;
    this.used = o[n];
  }

  /** Restore canonical CSR storage for an array attribute after length-changing sets (no-op otherwise). */
  compact(): this {
    const lens = this.lens;
    if (!lens) return this;
    const starts = this.offsets!, n = lens.length, off = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) off[i + 1] = off[i] + lens[i];
    const src = this.data, dst = arrayStore(this.type, off[n]);
    if (this.type === 'string[]') {
      for (let i = 0; i < n; i++) for (let k = 0; k < lens[i]; k++) (dst as string[])[off[i] + k] = (src as string[])[starts[i] + k];
    } else {
      for (let i = 0; i < n; i++) (dst as Float64Array).set((src as Float64Array).subarray(starts[i], starts[i] + lens[i]), off[i]);
    }
    this.offsets = off;
    this.data = dst;
    this.lens = undefined;
    this.used = 0;
    return this;
  }

  /** Approximate memory footprint in bytes (cache accounting). */
  bytes(): number {
    const d = this.data;
    const b = Array.isArray(d) ? d.length * 24 : (d as Float64Array).byteLength;
    return this.offsets ? b + this.offsets.byteLength + (this.lens ? this.lens.byteLength : 0) : b;
  }

  clone(): Attribute {
    if (this.offsets) {
      this.compact();
      return new Attribute(this.type, 1, this.data.slice() as AttribData, [], this.offsets.slice());
    }
    const data = this.type === 'string' ? (this.data as string[]).slice() : (this.data as Float64Array).slice();
    return new Attribute(this.type, this.size, data, Array.isArray(this.def) ? this.def.slice() : this.def);
  }

  /** New attribute whose element i is this[indices[i]] (index < 0 → default; the empty array for array attributes). */
  gather(indices: ArrayLike<number>): Attribute {
    if (this.offsets) return this.gatherArrays(indices);
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

  private gatherArrays(indices: ArrayLike<number>): Attribute {
    const n = indices.length, o = this.offsets!, off = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) off[i + 1] = off[i] + (indices[i] >= 0 ? this.arrayLength(indices[i]) : 0);
    const src = this.data, dst = arrayStore(this.type, off[n]);
    for (let i = 0; i < n; i++) {
      const j = indices[i];
      if (j < 0) continue;
      const s = o[j], len = off[i + 1] - off[i];
      if (Array.isArray(dst)) for (let k = 0; k < len; k++) dst[off[i] + k] = (src as string[])[s + k];
      else dst.set((src as Float64Array).subarray(s, s + len), off[i]);
    }
    return new Attribute(this.type, 1, dst, [], off);
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

  /**
   * Create (or replace if type/size differ) an attribute. Existing compatible attributes are kept.
   * Array types ('float[]', 'int[]', 'string[]') always have size 1. Replacing a numeric attribute
   * keeps the overlapping components; replacing to or from an array type converts the values
   * (a tuple becomes an array of its components, an array's entries change type).
   */
  add(name: string, type: AttribType = 'float', size = 1, def?: number[] | string): Attribute {
    if (isArrayType(type)) size = 1;
    const ex = this.map.get(name);
    if (ex && ex.type === type && ex.size === size) return ex;
    const a = Attribute.create(type, size, this.count, def ?? defaultValueFor(name, size, type));
    if (ex && (ex.isArray || a.isArray)) {
      for (let i = 0; i < this.count; i++) {
        const v = ex.get(i);
        a.set(i, a.isArray && !Array.isArray(v) ? [v as any] : v);
      }
      a.compact();
    } else if (ex && ex.type !== 'string' && type !== 'string') {
      // preserve overlapping components when changing size of a numeric attribute
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
export interface SdfVolume {
  name: string;
  kind: 'sdf';
  bounds: { min: Vec3; max: Vec3 };
  sample: (x: number, y: number, z: number) => number;
}

/**
 * A heightfield (Houdini's model): a regular grid of samples in the XZ plane, Y up, with named float layers
 * (height, mask, flow, sediment, debris, water and any user layer). Sample (i, j) sits at world
 * X = origin[0] + i * cellSize, Z = origin[1] + j * cellSize; layers are row-major (index j * width + i), and the
 * height layer holds absolute world Y. Layer arrays are shared between cooked geometries (clone() copies the layer
 * map, not the arrays): copy an array before writing to it. Implemented by Heightfield in core/heightfield.ts.
 */
export interface HeightfieldVolume {
  name: string;
  kind: 'heightfield';
  /** samples along X */
  width: number;
  /** samples along Z */
  height: number;
  /** distance between neighbouring samples (metres) */
  cellSize: number;
  /** world X and Z of sample (0, 0) */
  origin: [number, number];
  /** world X and Z of the field centre */
  readonly center: [number, number];
  layers: Map<string, Float32Array>;
  /** X/Z extent of the samples and the Y range of the height layer */
  readonly bounds: { min: Vec3; max: Vec3 };
  /** bilinear height at world (x, z), clamped to the field */
  sample(x: number, z: number): number;
  /** bilinear value of a layer at world (x, z), clamped to the field (0 when the layer is missing) */
  sampleLayer(name: string, x: number, z: number): number;
  /** a copy with its own layer map that shares the layer arrays */
  clone(): HeightfieldVolume;
}

export type Volume = SdfVolume | HeightfieldVolume;

/** Volumes for a new geometry: heightfields get their own layer map (the arrays stay shared), SDFs are immutable. */
export function cloneVolumes(vs: Volume[]): Volume[] {
  return vs.map((v) => (v.kind === 'heightfield' ? v.clone() : v));
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
  // Vertex and edge groups are created lazily, so geometry assembled with
  // Object.create(Geometry.prototype) (fast paths in nodes) never sees them undefined.
  private _vertexGroups?: Map<string, Uint8Array>;
  private _edgeGroups?: Map<string, EdgeSet>;
  /** Packed prims: 1 = packed instance, 0 = polygon/polyline (see the file comment). Absent = no packed prims. */
  primKind?: Uint8Array;
  /** Packed prims: index into packedSources per prim (-1 for other prims). Allocated with primKind. */
  packedSource?: Int32Array;
  /** Packed prims: 3×3 rotation·scale per prim, 9 numbers column-major (identity for other prims). Allocated with primKind. */
  packedXform?: Float64Array;
  private _packedSources?: Geometry[];

  /** Vertex groups: one byte per vertex. */
  get vertexGroups(): Map<string, Uint8Array> { return this._vertexGroups ?? (this._vertexGroups = new Map()); }
  set vertexGroups(m: Map<string, Uint8Array>) { this._vertexGroups = m; }
  /** Edge groups: sets of unordered point pairs. */
  get edgeGroups(): Map<string, EdgeSet> { return this._edgeGroups ?? (this._edgeGroups = new Map()); }
  set edgeGroups(m: Map<string, EdgeSet>) { this._edgeGroups = m; }
  /** Shared, immutable geometries referenced by packed prims (deduplicated). */
  get packedSources(): Geometry[] { return this._packedSources ?? (this._packedSources = []); }
  set packedSources(s: Geometry[]) { this._packedSources = s; }

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

  /** Mask groups of a class (edge groups live in edgeGroups as EdgeSets). */
  groups(cls: MaskGroupClass): Map<string, Uint8Array> {
    return cls === 'point' ? this.pointGroups : cls === 'prim' ? this.primGroups : this.vertexGroups;
  }

  /** Number of elements of a mask-group class. */
  count(cls: MaskGroupClass): number {
    return cls === 'point' ? this.numPoints : cls === 'prim' ? this.numPrims : this.numVertices;
  }

  /** Names of the groups of a class. */
  groupNames(cls: GroupClass): string[] {
    return [...(cls === 'edge' ? this.edgeGroups.keys() : this.groups(cls).keys())];
  }

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
    g.vertexGroups = new Map([...this.vertexGroups].map(([k, v]) => [k, v.slice()]));
    g.edgeGroups = new Map([...this.edgeGroups].map(([k, v]) => [k, v.clone()]));
    g.volumes = cloneVolumes(this.volumes);
    if (this.primKind) {
      // sources are shared (immutable), the per-prim arrays are copied
      g.primKind = this.primKind.slice();
      g.packedSource = this.packedSource!.slice();
      g.packedXform = this.packedXform!.slice();
      g.packedSources = this.packedSources.slice();
    }
    return g;
  }

  /**
   * Bounding box of the points, the packed instances (their sources' boxes, transformed) and optionally the SDF
   * volumes. Anchor points used only by packed prims are not counted: the box is the one of what is drawn.
   */
  bbox(includeVolumes = false): { min: Vec3; max: Vec3; empty: boolean } {
    const P = this.P;
    const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
    const anchorsOnly = this.primKind ? packedAnchorOnly(this) : null;
    for (let i = 0; i < P.length; i += 3) {
      if (anchorsOnly && anchorsOnly[i / 3]) continue;
      const x = P[i], y = P[i + 1], z = P[i + 2];
      if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x;
      if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y;
      if (z < min[2]) min[2] = z; if (z > max[2]) max[2] = z;
    }
    if (this.primKind) packedBounds(this, includeVolumes, min, max);
    if (includeVolumes)
      for (const v of this.volumes)
        for (let c = 0; c < 3; c++) {
          min[c] = Math.min(min[c], v.bounds.min[c]);
          max[c] = Math.max(max[c], v.bounds.max[c]);
        }
    const empty = !(min[0] <= max[0]);
    return empty ? { min: [0, 0, 0], max: [0, 0, 0], empty } : { min, max, empty };
  }

  addGroup(cls: MaskGroupClass, name: string, mask?: Uint8Array): Uint8Array {
    const n = this.count(cls);
    const m = mask ?? new Uint8Array(n);
    if (m.length !== n) throw new Error(`group mask size ${m.length} != ${n}`);
    this.groups(cls).set(name, m);
    return m;
  }

  /** Create or replace an edge group. */
  addEdgeGroup(name: string, edges?: EdgeSet): EdgeSet {
    const s = edges ?? new EdgeSet();
    this.edgeGroups.set(name, s);
    return s;
  }

  // ------------------------------------------------------------ packed primitives

  /** True when at least one prim is a packed instance. */
  hasPacked(): boolean {
    return !!this.primKind && this.packedSources.length > 0 && this.primKind.includes(1);
  }

  /** Is prim p a packed instance? */
  isPacked(p: number): boolean {
    return this.primKind !== undefined && this.primKind[p] === 1;
  }

  /** Number of packed prims. */
  get numPacked(): number {
    const k = this.primKind;
    if (!k) return 0;
    let n = 0;
    for (let i = 0; i < k.length; i++) n += k[i];
    return n;
  }

  /** Allocate the packed per-prim arrays (no packed prims yet) if absent, or pad them after prims were appended. */
  ensurePacked(): this {
    const n = this.numPrims;
    if (this.primKind && this.primKind.length === n) return this;
    const kind = new Uint8Array(n), src = new Int32Array(n).fill(-1), X = new Float64Array(n * 9);
    for (let p = 0; p < n; p++) { X[p * 9] = 1; X[p * 9 + 4] = 1; X[p * 9 + 8] = 1; }
    if (this.primKind) {
      const m = Math.min(n, this.primKind.length);
      kind.set(this.primKind.subarray(0, m));
      src.set(this.packedSource!.subarray(0, m));
      X.set(this.packedXform!.subarray(0, m * 9));
    }
    this.primKind = kind;
    this.packedSource = src;
    this.packedXform = X;
    return this;
  }

  /** Drop all packed bookkeeping (call after removing every packed prim by hand). */
  clearPacked(): this {
    this.primKind = undefined;
    this.packedSource = undefined;
    this.packedXform = undefined;
    this._packedSources = undefined;
    return this;
  }

  /** Index of a source in packedSources, appending it if it is not there yet (dedup by object identity). */
  addPackedSource(src: Geometry): number {
    const list = this.packedSources;
    const i = list.indexOf(src);
    if (i >= 0) return i;
    list.push(src);
    return list.length - 1;
  }

  /** World transform of packed prim p: translate(P[anchor]) · packedXform (a 4×4, column-major). */
  packedFullTransform(p: number): Mat4 {
    const m = new Float64Array(16);
    const X = this.packedXform, o = p * 9;
    if (X) {
      m[0] = X[o]; m[1] = X[o + 1]; m[2] = X[o + 2];
      m[4] = X[o + 3]; m[5] = X[o + 4]; m[6] = X[o + 5];
      m[8] = X[o + 6]; m[9] = X[o + 7]; m[10] = X[o + 8];
    } else { m[0] = 1; m[5] = 1; m[10] = 1; }
    if (this.primStart[p + 1] > this.primStart[p]) {
      const a = this.vertexPoint[this.primStart[p]], P = this.P;
      m[12] = P[a * 3]; m[13] = P[a * 3 + 1]; m[14] = P[a * 3 + 2];
    }
    m[15] = 1;
    return m;
  }

  /**
   * Set this geometry's packed arrays to src's, gathered by prim index (primIdx[i] = source prim of prim i, -1 = not
   * packed), and drop sources no prim uses any more. Used by subsets and by nodes that reorder prims.
   */
  gatherPacked(src: Geometry, primIdx: ArrayLike<number>): this {
    if (!src.primKind) { this.clearPacked(); return this; }
    const n = primIdx.length;
    const kind = new Uint8Array(n), s = new Int32Array(n), X = new Float64Array(n * 9);
    const sk = src.primKind, ss = src.packedSource!, sx = src.packedXform!;
    for (let i = 0; i < n; i++) {
      const j = primIdx[i];
      if (j >= 0 && sk[j]) {
        kind[i] = 1; s[i] = ss[j];
        for (let c = 0; c < 9; c++) X[i * 9 + c] = sx[j * 9 + c];
      } else { s[i] = -1; X[i * 9] = 1; X[i * 9 + 4] = 1; X[i * 9 + 8] = 1; }
    }
    this.primKind = kind;
    this.packedSource = s;
    this.packedXform = X;
    this.packedSources = src.packedSources.slice();
    return this.compactPackedSources();
  }

  /** Renumber packed sources to the ones in use (first-use order kept); clears the packed arrays when none is left. */
  compactPackedSources(): this {
    const kind = this.primKind;
    if (!kind) return this;
    const list = this.packedSources, S = this.packedSource!;
    const remap = new Int32Array(list.length).fill(-1);
    const used: Geometry[] = [];
    let identity = true;
    for (let p = 0; p < kind.length; p++) {
      if (!kind[p]) continue;
      const i = S[p];
      if (remap[i] < 0) { remap[i] = used.length; used.push(list[i]); }
      if (remap[i] !== i) identity = false;
    }
    if (!used.length) return this.clearPacked();
    if (identity && used.length === list.length) return this;
    for (let p = 0; p < kind.length; p++) if (kind[p]) S[p] = remap[S[p]];
    this.packedSources = used;
    return this;
  }

  /**
   * Delete vertices where keep[v] is falsy, with the subsetPoints rules: closed polygons that
   * lose a vertex are deleted; open polylines lose those vertices (and are deleted if fewer than
   * 2 remain). Points stay unless removeUnusedPoints.
   */
  subsetVertices(keep: ArrayLike<number | boolean>, removeUnusedPoints = false): Geometry {
    const primIdx: number[] = [], vtxIdx: number[] = [], starts = [0];
    const kind = this.primKind;
    for (let p = 0; p < this.numPrims; p++) {
      const s = this.primStart[p], e = this.primStart[p + 1];
      let missing = 0;
      for (let v = s; v < e; v++) if (!keep[v]) missing++;
      if (missing && this.primClosed[p]) continue;
      if (e - s - missing < (this.primClosed[p] || (kind && kind[p]) ? 1 : 2)) continue;
      primIdx.push(p);
      for (let v = s; v < e; v++) if (keep[v]) vtxIdx.push(v);
      starts.push(vtxIdx.length);
    }
    const g = this.clone();
    g.prims = this.prims.gather(primIdx);
    g.vertices = this.vertices.gather(vtxIdx);
    g.primClosed = Uint8Array.from(primIdx, (p) => this.primClosed[p]);
    g.primStart = Int32Array.from(starts);
    g.vertexPoint = Int32Array.from(vtxIdx, (v) => this.vertexPoint[v]);
    g.primGroups = new Map([...this.primGroups].map(([k, m]) => [k, Uint8Array.from(primIdx, (p) => m[p])]));
    g.vertexGroups = gatherGroups(this.vertexGroups, vtxIdx);
    g.edgeGroups = pruneEdgeGroups(g, this.edgeGroups);
    if (this.primKind) g.gatherPacked(this, primIdx);
    return removeUnusedPoints ? g.removeUnusedPoints() : g;
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
    g.vertexGroups = gatherGroups(this.vertexGroups, vtxIdx);
    // edges that no longer bound any primitive leave their edge groups
    g.edgeGroups = pruneEdgeGroups(g, this.edgeGroups);
    if (this.primKind) g.gatherPacked(this, primIdx);
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
    const kind = this.primKind;
    for (let p = 0; p < this.numPrims; p++) {
      const s = this.primStart[p], e = this.primStart[p + 1];
      let missing = 0;
      for (let v = s; v < e; v++) if (remap[this.vertexPoint[v]] < 0) missing++;
      if (missing && this.primClosed[p]) continue;
      if (e - s - missing < (this.primClosed[p] || (kind && kind[p]) ? 1 : 2)) continue;
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
    g.vertexGroups = gatherGroups(this.vertexGroups, vtxIdx);
    if (this.edgeGroups.size) g.edgeGroups = pruneEdgeGroups(g, new Map([...this.edgeGroups].map(([k, e]) => [k, e.remap(remap)])));
    g.volumes = cloneVolumes(this.volumes);
    if (this.primKind) g.gatherPacked(this, primIdx);
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
    out.vertexGroups = mergeGroups(geos.map((g) => [g.vertexGroups, g.numVertices] as const), nv);
    out.edgeGroups = mergeEdgeGroups(geos.map((g) => [g.edgeGroups, g.numPoints] as const));
    out.volumes = cloneVolumes(geos.flatMap((g) => g.volumes));
    if (geos.some((g) => g.primKind)) mergePacked(out, geos);
    return out;
  }
}

// ---------------------------------------------------------------- packed helpers

/** Concatenate the packed arrays of merged inputs. Sources are shared, deduplicated by identity and by content. */
function mergePacked(out: Geometry, geos: Geometry[]) {
  out.ensurePacked();
  const kind = out.primKind!, S = out.packedSource!, X = out.packedXform!;
  const sources: Geometry[] = [];
  const byObj = new Map<Geometry, number>(), byHash = new Map<string, number>();
  const index = (src: Geometry): number => {
    let i = byObj.get(src);
    if (i !== undefined) return i;
    const h = geoContentHash(src);
    i = byHash.get(h);
    if (i === undefined) { i = sources.length; sources.push(src); byHash.set(h, i); }
    byObj.set(src, i);
    return i;
  };
  let o = 0;
  for (const g of geos) {
    if (g.primKind) {
      const map = g.packedSources.map(index);
      const gk = g.primKind, gs = g.packedSource!, gx = g.packedXform!;
      for (let p = 0; p < gk.length; p++) {
        if (!gk[p]) continue;
        kind[o + p] = 1;
        S[o + p] = map[gs[p]];
        X.set(gx.subarray(p * 9, p * 9 + 9), (o + p) * 9);
      }
    }
    o += g.numPrims;
  }
  out.packedSources = sources;
  out.compactPackedSources();
}

/** Points referenced only by packed prims (anchors), as a mask (1 = anchor only). */
export function packedAnchorOnly(g: Geometry): Uint8Array {
  const np = g.numPoints, out = new Uint8Array(np);
  const kind = g.primKind;
  if (!kind) return out;
  const other = new Uint8Array(np);
  for (let p = 0; p < g.numPrims; p++) {
    const flag = kind[p] ? out : other;
    for (let v = g.primStart[p]; v < g.primStart[p + 1]; v++) flag[g.vertexPoint[v]] = 1;
  }
  for (let i = 0; i < np; i++) if (other[i]) out[i] = 0;
  return out;
}

const sourceBoxes = new WeakMap<Geometry, { min: Vec3; max: Vec3; empty: boolean }[]>();

/** Grow min/max by every packed instance's source box, transformed (exact box of the transformed box). */
function packedBounds(g: Geometry, includeVolumes: boolean, min: Vec3, max: Vec3) {
  const kind = g.primKind!, S = g.packedSource!, X = g.packedXform!, P = g.P;
  const boxes = g.packedSources.map((src) => {
    let c = sourceBoxes.get(src);
    if (!c) { c = []; sourceBoxes.set(src, c); }
    const k = includeVolumes ? 1 : 0;
    return c[k] ?? (c[k] = src.bbox(includeVolumes));
  });
  for (let p = 0; p < kind.length; p++) {
    if (!kind[p] || g.primStart[p + 1] === g.primStart[p]) continue;
    const b = boxes[S[p]];
    if (!b || b.empty) continue;
    const a = g.vertexPoint[g.primStart[p]], o = p * 9;
    const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2, cz = (b.min[2] + b.max[2]) / 2;
    const ex = (b.max[0] - b.min[0]) / 2, ey = (b.max[1] - b.min[1]) / 2, ez = (b.max[2] - b.min[2]) / 2;
    for (let r = 0; r < 3; r++) {
      const m0 = X[o + r], m1 = X[o + 3 + r], m2 = X[o + 6 + r];
      const c = P[a * 3 + r] + m0 * cx + m1 * cy + m2 * cz;
      const e = Math.abs(m0) * ex + Math.abs(m1) * ey + Math.abs(m2) * ez;
      if (c - e < min[r]) min[r] = c - e;
      if (c + e > max[r]) max[r] = c + e;
    }
  }
}

function gatherGroups(groups: Map<string, Uint8Array>, idx: ArrayLike<number>): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const [k, m] of groups) out.set(k, Uint8Array.from(idx, (i) => (i >= 0 ? m[i] : 0)));
  return out;
}

/** Keep only pairs that are still an edge of some prim of g (used after primitives were deleted). */
function pruneEdgeGroups(g: Geometry, groups: Map<string, EdgeSet>): Map<string, EdgeSet> {
  const out = new Map<string, EdgeSet>();
  if (!groups.size) return out;
  const live = new Set<number>();
  for (let p = 0; p < g.numPrims; p++) {
    const s = g.primStart[p], e = g.primStart[p + 1];
    const last = g.primClosed[p] ? e : e - 1;
    for (let v = s; v < last; v++) {
      const a = g.vertexPoint[v], b = g.vertexPoint[v + 1 < e ? v + 1 : s];
      if (a !== b) live.add(a < b ? a * EDGE_KEY_LIMIT + b : b * EDGE_KEY_LIMIT + a);
    }
  }
  for (const [k, set] of groups) {
    const ns = new EdgeSet();
    for (const key of set.keyIterator()) if (live.has(key)) ns.addKey(key);
    out.set(k, ns);
  }
  return out;
}

function mergeEdgeGroups(list: (readonly [Map<string, EdgeSet>, number])[]): Map<string, EdgeSet> {
  const out = new Map<string, EdgeSet>();
  let off = 0;
  for (const [m, np] of list) {
    for (const [k, set] of m) {
      let dst = out.get(k);
      if (!dst) { dst = new EdgeSet(); out.set(k, dst); }
      for (const [a, b] of set) dst.add(a + off, b + off);
    }
    off += np;
  }
  return out;
}

const DISPLAY_ATTRIBS = ['Cd', 'Alpha', 'N', 'uv'];

/** Promote display attributes to vertex class where inputs disagree on their class. */
export function unifyDisplayAttribs(geos: Geometry[]): Geometry[] {
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

/** Common entry type of two attribute types: string wins over float, float over int. */
function unifyBase(a: AttribType, b: AttribType): AttribBaseType {
  const x = baseType(a), y = baseType(b);
  return x === 'string' || y === 'string' ? 'string' : x === 'float' || y === 'float' ? 'float' : 'int';
}

/**
 * Concatenate array attribute k of the tables (an input that lacks it contributes empty arrays; one that has
 * it as a fixed-size attribute contributes its tuple, or its string, as an array).
 */
function mergeArrayAttrib(tables: AttribTable[], k: string, type: AttribArrayType, count: number): Attribute {
  const off = new Int32Array(count + 1);
  let o = 0;
  for (const t of tables) {
    const src = t.map.get(k);
    for (let i = 0; i < t.count; i++) off[o + i + 1] = off[o + i] + (src ? src.arrayLength(i) : 0);
    o += t.count;
  }
  const data = arrayStore(type, off[count]);
  o = 0;
  for (const t of tables) {
    const src = t.map.get(k);
    if (src?.isArray) {
      // compact CSR keeps the entries of consecutive elements contiguous: copy the block
      const sd = src.compact().data;
      if (src.type === type && !Array.isArray(sd)) (data as Float64Array).set(sd as Float64Array, off[o]);
      else writeEntries(type, data, off[o], sd);
    } else if (src) for (let i = 0; i < t.count; i++) writeEntries(type, data, off[o + i], asEntries(src.get(i)));
    o += t.count;
  }
  return new Attribute(type, 1, data, [], off);
}

function mergeTables(tables: AttribTable[], count: number): AttribTable {
  const out = new AttribTable(count);
  const schema = new Map<string, { type: AttribType; size: number; def: number[] | string }>();
  for (const t of tables)
    for (const [k, a] of t.map) {
      const s = schema.get(k);
      if (!s) schema.set(k, { type: a.type, size: a.size, def: a.def });
      else if (a.isArray || isArrayType(s.type)) {
        // an array in any input makes the merged attribute an array
        s.type = arrayType(unifyBase(s.type, a.type));
        s.size = 1; s.def = [];
      } else {
        if (a.type === 'string' || s.type === 'string') s.type = 'string';
        else if (a.type === 'float') s.type = 'float';
        if (a.size > s.size) { s.size = a.size; s.def = a.def; }
      }
    }
  for (const [k, s] of schema) {
    if (isArrayType(s.type)) {
      out.map.set(k, mergeArrayAttrib(tables, k, s.type, count));
      continue;
    }
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
  set(i: number, v: number | number[] | string | string[]) {
    this.vals[i] = typeof v === 'number' ? new Array(this.size).fill(v) : (v as any);
  }
}

/**
 * Incrementally builds new geometry. Elements can carry provenance (which source
 * point / vertex / prim they came from, or a weighted blend) and every attribute and
 * group of the source geometry is interpolated onto the result automatically.
 *
 * Attribute rules on build(): float attributes are blended with the provenance weights; int and
 * string attributes take the dominant source's value (largest weight). Array attributes are never
 * blended: an element with a single source copies its array, a blended element takes the array of
 * its heaviest source (first one on ties); elements without provenance get the empty array.
 *
 * Group inheritance on build():
 *  - point / prim groups: membership of the dominant source (largest blend weight).
 *  - vertex groups: a new vertex is a member only if it copies a single source vertex
 *    (a number, or a blend with one non-zero weight) that is a member. Blended corners drop out.
 *  - edge groups: a new edge (two consecutive vertices of a new prim) is a member if each of its
 *    two points copies a single source point and those two source points form a grouped edge.
 *    Edges touching blended points drop out (nodes that split edges, like subdivide, add their
 *    child edges explicitly with edgeGroup()).
 * Groups the node creates with group()/edgeGroup() replace same-named inherited groups.
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
  private grpVertex = new Map<string, Set<number>>();
  private grpEdge = new Map<string, EdgeSet>();
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
    if (isArrayType(type)) size = 1;
    const m = this.grow[cls];
    let a = m.get(name);
    if (!a) {
      a = new GrowAttr(type, size, def ?? defaultValueFor(name, size, type));
      m.set(name, a);
    }
    return a;
  }

  /** A point, prim or vertex group created by the node (indices of new elements). */
  group(cls: MaskGroupClass, name: string): Set<number> {
    const m = cls === 'point' ? this.grpPoint : cls === 'prim' ? this.grpPrim : this.grpVertex;
    let s = m.get(name);
    if (!s) { s = new Set(); m.set(name, s); }
    return s;
  }

  /** An edge group created by the node (pairs of new point indices). */
  edgeGroup(name: string): EdgeSet {
    let s = this.grpEdge.get(name);
    if (!s) { s = new EdgeSet(); this.grpEdge.set(name, s); }
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
    g.vertexGroups = new Map();
    g.edgeGroups = new Map();
    if (src && this.keepSrcGroups) {
      if (src.vertexGroups.size) {
        const single = Int32Array.from(this.vtxSrc, singleSource);
        for (const [k, m] of src.vertexGroups) {
          const out = new Uint8Array(nv);
          for (let v = 0; v < nv; v++) if (single[v] >= 0 && single[v] < m.length) out[v] = m[single[v]];
          g.vertexGroups.set(k, out);
        }
      }
      if (src.edgeGroups.size) for (const [k, s] of inheritEdgeGroups(src.edgeGroups, this.ptSrc, g)) g.edgeGroups.set(k, s);
    }
    for (const [k, s] of this.grpVertex) {
      const m = new Uint8Array(nv);
      for (const i of s) m[i] = 1;
      g.vertexGroups.set(k, m);
    }
    for (const [k, s] of this.grpEdge) g.edgeGroups.set(k, s.clone());
    g.volumes = this.volumes;
    // a prim copied from a single packed source prim keeps its kind, source and transform (if it has one vertex)
    if (src && src.primKind) {
      const idx = new Int32Array(npr);
      for (let p = 0; p < npr; p++) {
        const s = this.primSrc[p];
        idx[p] = s >= 0 && s < src.primKind.length && src.primKind[s] && this.starts[p + 1] - this.starts[p] === 1 ? s : -1;
      }
      g.gatherPacked(src, idx);
    }
    return g;
  }
}

/** The single source element of a provenance record, or -1 for blends of several sources / none. */
function singleSource(s: Src): number {
  if (s === null || s === undefined) return -1;
  if (typeof s === 'number') return s >= 0 ? s : -1;
  let found = -1;
  for (let k = 0; k < s.i.length; k++) {
    if (!(s.w[k] !== 0)) continue;
    if (found >= 0 && s.i[k] !== found) return -1;
    found = s.i[k];
  }
  return found;
}

/** Edge-group inheritance rule of GeoBuilder.build (see the class comment). */
function inheritEdgeGroups(groups: Map<string, EdgeSet>, ptSrc: Src[], g: Geometry): Map<string, EdgeSet> {
  const single = Int32Array.from(ptSrc, singleSource);
  const out = new Map<string, EdgeSet>();
  const list = [...groups];
  for (const [k] of list) out.set(k, new EdgeSet());
  for (let p = 0; p < g.numPrims; p++) {
    const s = g.primStart[p], e = g.primStart[p + 1];
    const last = g.primClosed[p] ? e : e - 1;
    for (let v = s; v < last; v++) {
      const a = g.vertexPoint[v], b = g.vertexPoint[v + 1 < e ? v + 1 : s];
      if (a === b) continue;
      const sa = single[a], sb = single[b];
      if (sa < 0 || sb < 0 || sa === sb) continue;
      for (const [k, set] of list) if (set.has(sa, sb)) out.get(k)!.add(a, b);
    }
  }
  return out;
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
    if (a.isArray) {
      // arrays are not interpolated: copy the single source's array, or the heaviest source's for a blend
      out.map.set(name, a.gather(Int32Array.from(srcs as Src[], dominant)));
      continue;
    }
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
    a.compact();
  }
}
