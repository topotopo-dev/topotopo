// Geometry fingerprints: a compact, stable summary of a cooked result for golden and property tests.
//
// Stable across runs and tolerant to float noise: positions are quantised to 1e-5, other numeric attributes to
// 1e-4, bboxes rounded to 1e-4, and everything is hashed with a fixed two-lane FNV-1a over the quantised integers.
// Array attributes hash their CSR offsets and then their entries.
// Point/prim order is part of the fingerprint (it is observable behaviour, as in Houdini).
import { hashString } from '../src/core/random.ts';
import type { Geometry } from '../src/core/geometry.ts';

const POS_Q = 1e5; // positions: 1e-5
const ATTR_Q = 1e4; // other numeric attributes: 1e-4
const BBOX_Q = 1e4; // bbox: 1e-4

/** Two independent 32-bit FNV-1a lanes (different offset bases) → 16 hex chars. Deterministic, order-sensitive. */
export class Hasher {
  private a = 0x811c9dc5;
  private b = 0x050c5d1f;
  private n = 0;

  /** Feed one 32-bit word, byte by byte. */
  word(w: number): this {
    w = w >>> 0;
    for (let k = 0; k < 4; k++) {
      const byte = (w >>> (k * 8)) & 0xff;
      this.a = Math.imul(this.a ^ byte, 0x01000193);
      this.b = Math.imul(this.b ^ byte ^ 0x5c, 0x01000193);
    }
    this.n++;
    return this;
  }

  /** Feed a (safe) integer as two words, so values beyond 32 bits still hash exactly. */
  int(v: number): this {
    if (!Number.isFinite(v)) return this.word(v !== v ? 0x7fc00000 : v > 0 ? 0x7f800000 : 0xff800000).word(0xdeadbeef);
    if (v === 0) v = 0; // fold -0
    const lo = v % 4294967296;
    const hi = Math.floor(v / 4294967296);
    return this.word(lo).word(hi);
  }

  /** Feed a float quantised to a 1/q grid (Math.round, -0 folded into 0). */
  float(v: number, q: number): this {
    if (!Number.isFinite(v)) return this.int(v);
    return this.int(Math.round(v * q));
  }

  str(s: string): this {
    const h = hashString(s);
    return this.int(h).int(s.length);
  }

  hex(): string {
    return (this.a >>> 0).toString(16).padStart(8, '0') + (this.b >>> 0).toString(16).padStart(8, '0');
  }
}

const round = (v: number, q: number) => {
  const r = Math.round(v * q) / q;
  return r === 0 ? 0 : r; // fold -0
};

export interface Fingerprint {
  counts: { points: number; vertices: number; prims: number; volumes: number };
  bbox: { min: number[]; max: number[] } | null;
  attributes: Record<string, string[]>;
  groups: Record<string, string[]>;
  hashes: {
    P: string;
    topology: string;
    attributes: Record<string, string>;
  };
  /**
   * SDFs: bounds + a hash of a 9³ sample lattice. Heightfields: grid (samples, cell size, origin), bounds and a hash
   * of each layer's quantised values.
   */
  volumes?: {
    name: string; kind: string; bounds: { min: number[]; max: number[] }; samples?: string;
    grid?: { width: number; height: number; cellSize: number; origin: number[] }; layers?: Record<string, string>;
  }[];
  /** packed instances (only present when there are some): count, per-source fingerprint hashes, per-prim source + xform hash */
  packed?: { instances: number; sources: string[]; hash: string };
  /** spline prims (only when present): counts per kind and a hash of (prim, kind) */
  splines?: { bezier: number; nurbs: number; hash: string };
}

const CLASSES = ['point', 'vertex', 'prim', 'detail'] as const;

/** Group maps present on this geometry, by class. Future group classes (vertex, edge) are picked up automatically. */
function groupMaps(g: Geometry): [string, Map<string, ArrayLike<number> | Set<any>>][] {
  const out: [string, Map<string, any>][] = [];
  for (const [key, cls] of [['pointGroups', 'point'], ['primGroups', 'prim'], ['vertexGroups', 'vertex'], ['edgeGroups', 'edge']] as const) {
    const m = (g as any)[key];
    if (m instanceof Map) out.push([cls, m]);
  }
  return out;
}

function hashGroupMembership(h: Hasher, m: any) {
  if (m instanceof Set) {
    const items = [...m].map((x) => (typeof x === 'number' ? x : String(x)));
    items.sort((a: any, b: any) => (typeof a === 'number' && typeof b === 'number' ? a - b : String(a) < String(b) ? -1 : 1));
    h.int(items.length);
    for (const x of items) typeof x === 'number' ? h.int(x) : h.str(x);
  } else if (m && typeof m.length === 'number') {
    h.int(m.length);
    for (let i = 0; i < m.length; i++) if (m[i]) h.int(i);
  } else h.str(JSON.stringify(m));
}

/**
 * Fingerprint a cooked geometry. SDF volumes are sampled on a fixed 9³ lattice inside their bounds; heightfields
 * record their grid and a hash of every layer (values quantised like attributes).
 */
export function fingerprint(g: Geometry): Fingerprint {
  const bb = g.bbox();
  const fp: Fingerprint = {
    counts: { points: g.numPoints, vertices: g.numVertices, prims: g.numPrims, volumes: g.volumes.length },
    bbox: bb.empty ? null : { min: bb.min.map((v) => round(v, BBOX_Q)), max: bb.max.map((v) => round(v, BBOX_Q)) },
    attributes: {},
    groups: {},
    hashes: { P: '', topology: '', attributes: {} },
  };

  for (const cls of CLASSES) {
    const t = g.table(cls);
    const names = t.names().sort();
    fp.attributes[cls] = names.map((n) => {
      const a = t.get(n)!;
      return `${n}:${a.type}:${a.size}`;
    });
    for (const n of names) {
      if (cls === 'point' && n === 'P') continue;
      const a = t.get(n)!;
      const h = new Hasher();
      if (a.isArray) {
        // array attributes: CSR offsets (element lengths and order), then the quantised entries
        a.compact();
        h.int(a.offsets!.length);
        for (const o of a.offsets!) h.int(o);
        if (a.type === 'string[]') for (const s of a.data as string[]) h.str(s);
        else if (a.type === 'int[]') for (const v of a.data as Int32Array) h.int(v);
        else for (const v of a.data as Float64Array) h.float(v, ATTR_Q);
      } else if (a.type === 'string') for (const s of a.data as string[]) h.str(s);
      else if (a.type === 'int') for (const v of a.data as Int32Array) h.int(v);
      else for (const v of a.data as Float64Array) h.float(v, ATTR_Q);
      fp.hashes.attributes[`${cls}.${n}`] = h.hex();
    }
  }

  for (const [cls, m] of groupMaps(g)) {
    const names = [...m.keys()].sort();
    fp.groups[cls] = names;
    for (const n of names) {
      const h = new Hasher();
      hashGroupMembership(h, m.get(n));
      fp.hashes.attributes[`group.${cls}.${n}`] = h.hex();
    }
  }

  const hp = new Hasher();
  for (const v of g.P) hp.float(v, POS_Q);
  fp.hashes.P = hp.hex();

  const ht = new Hasher();
  ht.int(g.primStart.length);
  for (const v of g.primStart) ht.int(v);
  ht.int(g.vertexPoint.length);
  for (const v of g.vertexPoint) ht.int(v);
  ht.int(g.primClosed.length);
  for (const v of g.primClosed) ht.int(v);
  fp.hashes.topology = ht.hex();

  if (g.hasPacked()) {
    // each source by the hash of its own fingerprint (recursively), then per packed prim: number, source, quantised 3×3
    const srcs = g.packedSources.map((s) => new Hasher().str(sortedJSON(fingerprint(s))).hex());
    const h = new Hasher();
    const k = g.primKind!, S = g.packedSource!, X = g.packedXform!;
    let n = 0;
    for (let p = 0; p < k.length; p++) {
      if (k[p] !== 1) continue;
      n++;
      h.int(p).str(srcs[S[p]]);
      for (let c = 0; c < 9; c++) h.float(X[p * 9 + c], ATTR_Q);
    }
    fp.packed = { instances: n, sources: srcs, hash: h.hex() };
  }

  if (g.hasSplines()) {
    const h = new Hasher(), k = g.primKind!;
    let bz = 0, nb = 0;
    for (let p = 0; p < k.length; p++) {
      if (k[p] < 2) continue;
      if (k[p] === 2) bz++; else nb++;
      h.int(p).int(k[p]);
    }
    fp.splines = { bezier: bz, nurbs: nb, hash: h.hex() };
  }

  if (g.volumes.length) {
    fp.volumes = g.volumes.map((vol) => {
      if (vol.kind === 'heightfield') {
        const { min, max } = vol.bounds;
        const layers: Record<string, string> = {};
        for (const name of [...vol.layers.keys()].sort()) {
          const h = new Hasher();
          const a = vol.layers.get(name)!;
          h.int(a.length);
          for (let i = 0; i < a.length; i++) h.float(a[i], ATTR_Q);
          layers[name] = h.hex();
        }
        return {
          name: vol.name,
          kind: vol.kind,
          bounds: { min: Array.from(min, (v) => round(v, BBOX_Q)), max: Array.from(max, (v) => round(v, BBOX_Q)) },
          grid: { width: vol.width, height: vol.height, cellSize: round(vol.cellSize, 1e6), origin: vol.origin.map((v) => round(v, BBOX_Q)) },
          layers,
        };
      }
      const h = new Hasher();
      const { min, max } = vol.bounds;
      const N = 9;
      for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) for (let k = 0; k < N; k++) {
        const x = min[0] + ((max[0] - min[0]) * i) / (N - 1);
        const y = min[1] + ((max[1] - min[1]) * j) / (N - 1);
        const z = min[2] + ((max[2] - min[2]) * k) / (N - 1);
        h.float(vol.sample(x, y, z), ATTR_Q);
      }
      return {
        name: vol.name,
        kind: vol.kind,
        bounds: { min: Array.from(min, (v) => round(v, BBOX_Q)), max: Array.from(max, (v) => round(v, BBOX_Q)) },
        samples: h.hex(),
      };
    });
  }
  return fp;
}

/**
 * JSON with object keys sorted recursively (arrays keep their order), pretty-printed with 2 spaces.
 * Short arrays of primitives stay on one line so bboxes and schemas read well in diffs.
 */
export function sortedJSON(v: any): string {
  const fmt = (x: any, ind: string): string => {
    if (x === null || typeof x !== 'object') return JSON.stringify(x);
    const inner = ind + '  ';
    if (Array.isArray(x)) {
      if (!x.length) return '[]';
      if (x.every((e) => e === null || typeof e !== 'object')) {
        const one = '[' + x.map((e) => JSON.stringify(e)).join(', ') + ']';
        if (one.length + ind.length <= 100) return one;
      }
      return '[\n' + x.map((e) => inner + fmt(e, inner)).join(',\n') + '\n' + ind + ']';
    }
    const keys = Object.keys(x).filter((k) => x[k] !== undefined).sort();
    if (!keys.length) return '{}';
    return '{\n' + keys.map((k) => `${inner}${JSON.stringify(k)}: ${fmt(x[k], inner)}`).join(',\n') + '\n' + ind + '}';
  };
  return fmt(v, '');
}

/** Flatten to path → leaf. Arrays of primitives are one leaf (compact, readable diffs); other arrays are indexed. */
export function flatten(v: any, prefix = '', out: Map<string, string> = new Map()): Map<string, string> {
  if (v === null || typeof v !== 'object') out.set(prefix || '(root)', JSON.stringify(v));
  else if (Array.isArray(v) && v.every((x) => x === null || typeof x !== 'object')) out.set(prefix || '(root)', JSON.stringify(v));
  else if (Array.isArray(v)) {
    if (!v.length) out.set(prefix, '[]');
    v.forEach((x, i) => flatten(x, `${prefix}[${i}]`, out));
  } else {
    const keys = Object.keys(v).sort();
    if (!keys.length) out.set(prefix || '(root)', '{}');
    for (const k of keys) flatten(v[k], prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

/** Field-by-field differences between two JSON values: [{path, old, new}] (old/new undefined = missing). */
export function diffFields(oldV: any, newV: any): { path: string; old?: string; new?: string }[] {
  const a = flatten(oldV), b = flatten(newV);
  const keys = [...new Set([...a.keys(), ...b.keys()])].sort();
  const out: { path: string; old?: string; new?: string }[] = [];
  for (const k of keys) if (a.get(k) !== b.get(k)) out.push({ path: k, old: a.get(k), new: b.get(k) });
  return out;
}

/** Human-readable diff lines, truncated to `max` entries. */
export function formatDiff(d: { path: string; old?: string; new?: string }[], max = 25): string[] {
  const clip = (s?: string) => (s === undefined ? '(missing)' : s.length > 140 ? s.slice(0, 137) + '...' : s);
  const lines = d.slice(0, max).map((x) => `    ${x.path}: ${clip(x.old)} → ${clip(x.new)}`);
  if (d.length > max) lines.push(`    … ${d.length - max} more field(s)`);
  return lines;
}
