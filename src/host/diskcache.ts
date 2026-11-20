// The node cook cache on disk: the results of slow nodes, kept between runs of the CLI and the MCP server (Host.persist).
//
// What is kept: a node result whose own cook took 0.5 s or more (the engine offers it; src/graph/engine.ts decides
// which results are fit to keep). What it is keyed by: the identity string the engine builds (the node's content
// signature material, the scope's files folder when it reads files, the frame of a time-dependent node) and the
// engine's identity: the hash of its code (engine-code.ts), the Node version and platform, and the versions of the
// libraries it uses. An engine change therefore misses.
//
// Where: the user's cache folder for the OS, in topotopo/nodes (Windows %LOCALAPPDATA%, macOS ~/Library/Caches, else
// $XDG_CACHE_HOME or ~/.cache). TOPOTOPO_NODE_CACHE_DIR moves it, TOPOTOPO_NODE_CACHE=off switches it off. Up to 4 GB;
// past that the entries used longest ago go first (an entry's modification time is when it was written or last loaded).
//
// A file per result, <sha256 of the identity>.ttnode: a header (JSON: the structure of the geometry, the warnings, the
// engine identity) and the raw bytes of every array it holds, then a CRC-32 of all of it. Written to a temporary file in
// the same folder and renamed into place, so a reader never sees half a file and two processes writing one result both
// leave a whole one. A file that is truncated, fails its checksum, names another engine or cannot be read is a miss
// (and is removed); the engine cooks the node and writes it again. Nothing here throws into a cook.
//
// The geometry is stored exactly: every attribute (with its default value), group, packed source, volume layer and
// edge set, bit for bit, so a result loaded from here cooks everything downstream as the one it was saved from. A
// result holding something that cannot be stored (an SDF volume is a function) is not kept.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { createHash, randomBytes } from 'node:crypto';
import { Attribute, AttribTable, Geometry } from '../core/geometry.ts';
import type { AttribType, Volume } from '../core/geometry.ts';
import { EdgeSet } from '../core/edges.ts';
import { Heightfield } from '../core/heightfield.ts';
import { Image } from '../core/image.ts';
import { SdfGrid } from '../core/sdfgrid.ts';
import type { GridDims } from '../core/sdfgrid.ts';
import { ENGINE_ROOT, engineSha256, engineStamp } from './engine-code.ts';
import type { NodeStore, StoredNode } from './types.ts';

/** Results of nodes that cooked at least this long (ms) are kept. */
export const NODE_CACHE_MIN_MS = 500;
/** The cache's size cap. */
export const NODE_CACHE_MAX_BYTES = 4 * 2 ** 30;
/** Bump when the file layout changes: older files then miss. */
const FORMAT = 1;
const MAGIC = 'TTNODE1\0';
const EXT = '.ttnode';
const TMP = '.tmp';
/** Temporary files older than this are the leftovers of a process that died while writing. */
const STALE_TMP_MS = 3600_000;
const CHUNK = 64 * 2 ** 20;

/** The environment variable that moves the cache folder. */
export const NODE_CACHE_DIR_VAR = 'TOPOTOPO_NODE_CACHE_DIR';
/** The environment variable that switches the cache off when it is off, 0, false or no. */
export const NODE_CACHE_SWITCH_VAR = 'TOPOTOPO_NODE_CACHE';

type Env = Record<string, string | undefined>;

/** Is the cache switched off in the environment (TOPOTOPO_NODE_CACHE=off)? */
export function nodeCacheOff(env: Env = process.env): boolean {
  return /^(off|0|false|no)$/i.test((env[NODE_CACHE_SWITCH_VAR] ?? '').trim());
}

/** The cache folder: TOPOTOPO_NODE_CACHE_DIR, else topotopo/nodes in the user's cache folder for this OS. */
export function nodeCacheFolder(env: Env = process.env, platform: string = process.platform, home: string = os.homedir()): string {
  const given = (env[NODE_CACHE_DIR_VAR] ?? '').trim();
  if (given) return path.resolve(given);
  const base = platform === 'win32' ? (env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'))
    : platform === 'darwin' ? path.join(home, 'Library', 'Caches')
    : (env.XDG_CACHE_HOME || path.join(home, '.cache'));
  return path.join(base, 'topotopo', 'nodes');
}

// ---------------------------------------------------------------- the engine's identity

const sha256 = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');

/** The installed versions of the libraries the engine uses, as "name@version" (a library not found says so). */
function dependencyVersions(): string {
  let deps: string[] = [];
  try { deps = Object.keys(JSON.parse(fs.readFileSync(path.join(ENGINE_ROOT, 'package.json'), 'utf8')).dependencies ?? {}).sort(); } catch { /* none */ }
  return deps.map((d) => {
    for (let dir = ENGINE_ROOT; ; dir = path.dirname(dir)) {
      try { return `${d}@${JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', d, 'package.json'), 'utf8')).version}`; } catch { /* up one */ }
      if (path.dirname(dir) === dir) return `${d}@?`;
    }
  }).join(',');
}

let engineMemo: string | undefined;

/**
 * What a result depends on besides its identity: the engine's code hash (engine-code.ts), the Node version and platform
 * (a math function may differ in the last bit between them) and the libraries' versions. The hash reads every file of
 * the engine, which takes most of a second, so it is kept in the cache folder under the files' sizes and modification
 * times (engineStamp): a process that finds the same stamp there does not read them again.
 */
function engineIdentity(dir: string): string {
  if (engineMemo) return engineMemo;
  const stamp = engineStamp();
  const memoFile = path.join(dir, 'engine.json');
  let known: Record<string, string> = {};
  try { known = JSON.parse(fs.readFileSync(memoFile, 'utf8')) ?? {}; } catch { /* none yet */ }
  let code = typeof known[stamp] === 'string' && /^[0-9a-f]{64}$/.test(known[stamp]) ? known[stamp] : '';
  if (!code) {
    code = engineSha256();
    const keep = Object.entries(known).slice(-7);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${memoFile}.${process.pid}.${randomBytes(4).toString('hex')}${TMP}`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries([...keep, [stamp, code]])));
      fs.renameSync(tmp, memoFile);
    } catch { /* the hash is just taken again next time */ }
  }
  return (engineMemo = sha256([code, process.version, process.platform, process.arch, dependencyVersions()].join('|')));
}

// ---------------------------------------------------------------- geometry <-> header + arrays

/** A result that cannot be stored. */
class Unstorable extends Error {}

type Typed = Float64Array | Float32Array | Int32Array | Uint8Array;
const KINDS = { f64: Float64Array, f32: Float32Array, i32: Int32Array, u8: Uint8Array } as const;
type Kind = keyof typeof KINDS;

/** The arrays of a result, in the order the file stores them. */
class Arrays {
  views: Uint8Array[] = [];
  kinds: [Kind, number][] = [];
  bytes = 0;
  add(a: ArrayBufferView): number {
    const kind: Kind | undefined = a instanceof Float64Array ? 'f64' : a instanceof Float32Array ? 'f32' : a instanceof Int32Array ? 'i32' : a instanceof Uint8Array ? 'u8' : undefined;
    if (!kind) throw new Unstorable(`an array of a kind that is not stored (${a.constructor?.name})`);
    this.views.push(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
    this.kinds.push([kind, (a as Typed).length]);
    this.bytes += a.byteLength;
    return this.views.length - 1;
  }
}

/** A number as JSON holds it exactly: -0 and the non-finite ones are written as strings. */
const enc = (x: number): number | string => (Number.isFinite(x) && !Object.is(x, -0) ? x : Object.is(x, -0) ? '-0' : String(x));
const dec = (x: number | string): number => (typeof x === 'number' ? x : x === '-0' ? -0 : Number(x));
const encAll = (v: number[]) => v.map(enc);
const decAll = (v: (number | string)[]) => v.map(dec);

function packTable(t: AttribTable, A: Arrays) {
  const attribs: any[] = [];
  for (const [name, a] of t.map) {
    if (a.isArray) a.compact();
    const strings = a.type === 'string' || a.type === 'string[]';
    attribs.push({
      n: name, t: a.type, s: a.size,
      d: typeof a.def === 'string' ? a.def : encAll(a.def),
      v: strings ? a.data : A.add(a.data as Typed),
      ...(a.isArray ? { o: A.add(a.offsets!) } : {}),
    });
  }
  return { count: t.count, attribs };
}

const packMasks = (m: Map<string, Uint8Array>, A: Arrays) => [...m].map(([k, v]) => [k, A.add(v)]);

function packVolume(v: Volume, A: Arrays) {
  if (v.kind === 'sdf') throw new Unstorable('an SDF volume is a function');
  if (v.kind === 'grid') return { k: 'grid', name: v.name, dims: v.dims, origin: encAll(v.origin), voxel: enc(v.voxel), values: A.add(v.values) };
  const layers = [...v.layers].map(([k, a]) => [k, A.add(a)]);
  if (v.kind === 'image') return { k: 'image', name: v.name, width: v.width, height: v.height, layers };
  return { k: 'heightfield', name: v.name, width: v.width, height: v.height, cellSize: enc(v.cellSize), origin: encAll(v.origin), layers };
}

function packGeometry(g: Geometry, A: Arrays): any {
  const out: any = {
    points: packTable(g.points, A), vertices: packTable(g.vertices, A), prims: packTable(g.prims, A), detail: packTable(g.detail, A),
    primStart: A.add(g.primStart), vertexPoint: A.add(g.vertexPoint), primClosed: A.add(g.primClosed),
    pointGroups: packMasks(g.pointGroups, A), primGroups: packMasks(g.primGroups, A), vertexGroups: packMasks(g.vertexGroups, A),
    // an edge group in the order it was built in: [a0, b0, a1, b1, …]
    edgeGroups: [...g.edgeGroups].map(([k, set]) => {
      const pairs = new Int32Array(set.size * 2);
      let i = 0;
      for (const [a, b] of set) { pairs[i++] = a; pairs[i++] = b; }
      return [k, A.add(pairs)];
    }),
    volumes: g.volumes.map((v) => packVolume(v, A)),
  };
  if (g.primKind) { out.primKind = A.add(g.primKind); out.packedSource = A.add(g.packedSource!); out.packedXform = A.add(g.packedXform!); }
  if (g.packedSources.length) out.packedSources = g.packedSources.map((s) => packGeometry(s, A));
  return out;
}

function unpackTable(j: any, arrays: Typed[]): AttribTable {
  const t = new AttribTable(j.count);
  for (const a of j.attribs) {
    const type = a.t as AttribType;
    const data = typeof a.v === 'number' ? arrays[a.v] : a.v;
    const def = typeof a.d === 'string' ? a.d : decAll(a.d);
    t.map.set(a.n, new Attribute(type, a.s, data, def, a.o === undefined ? undefined : (arrays[a.o] as Int32Array)));
  }
  return t;
}

const unpackMasks = (list: [string, number][], arrays: Typed[]) => new Map(list.map(([k, i]) => [k, arrays[i] as Uint8Array]));

function unpackGeometry(j: any, arrays: Typed[]): Geometry {
  const g = new Geometry();
  g.points = unpackTable(j.points, arrays);
  g.vertices = unpackTable(j.vertices, arrays);
  g.prims = unpackTable(j.prims, arrays);
  g.detail = unpackTable(j.detail, arrays);
  g.primStart = arrays[j.primStart] as Int32Array;
  g.vertexPoint = arrays[j.vertexPoint] as Int32Array;
  g.primClosed = arrays[j.primClosed] as Uint8Array;
  g.pointGroups = unpackMasks(j.pointGroups, arrays);
  g.primGroups = unpackMasks(j.primGroups, arrays);
  if (j.vertexGroups.length) g.vertexGroups = unpackMasks(j.vertexGroups, arrays);
  if (j.edgeGroups.length) g.edgeGroups = new Map(j.edgeGroups.map(([k, i]: [string, number]) => {
    const pairs = arrays[i] as Int32Array, set = new EdgeSet();
    for (let p = 0; p < pairs.length; p += 2) set.add(pairs[p], pairs[p + 1]);
    return [k, set];
  }));
  if (j.primKind !== undefined) {
    g.primKind = arrays[j.primKind] as Uint8Array;
    g.packedSource = arrays[j.packedSource] as Int32Array;
    g.packedXform = arrays[j.packedXform] as Float64Array;
  }
  if (j.packedSources) g.packedSources = j.packedSources.map((s: any) => unpackGeometry(s, arrays));
  g.volumes = j.volumes.map((v: any): Volume => {
    if (v.k === 'grid') return new SdfGrid(v.dims as GridDims, decAll(v.origin) as [number, number, number], dec(v.voxel), arrays[v.values] as Float32Array, v.name);
    const layers = new Map<string, Float32Array>(v.layers.map(([k, i]: [string, number]) => [k, arrays[i] as Float32Array]));
    if (v.k === 'image') return new Image(v.width, v.height, v.name, layers);
    return new Heightfield(v.width, v.height, dec(v.cellSize), decAll(v.origin) as [number, number], layers, v.name);
  });
  return g;
}

// ---------------------------------------------------------------- files

const HEAD = 16;

/** Write a whole file through a handle: the head, the header, the arrays, then the CRC-32 of all of it. */
async function writeEntry(tmp: string, header: Buffer, views: Uint8Array[]): Promise<void> {
  const fh = await fsp.open(tmp, 'wx');
  try {
    let crc = 0;
    const put = async (buf: Uint8Array) => {
      for (let o = 0; o < buf.length; o += CHUNK) {
        const part = buf.subarray(o, Math.min(buf.length, o + CHUNK));
        crc = zlib.crc32(part, crc);
        for (let w = 0; w < part.length;) w += (await fh.write(part, w, part.length - w)).bytesWritten;
      }
    };
    const head = Buffer.alloc(HEAD);
    head.write(MAGIC, 0, 'latin1');
    head.writeUInt32LE(header.length, 8);
    await put(head);
    await put(header);
    for (const v of views) await put(v);
    const tail = Buffer.alloc(4);
    tail.writeUInt32LE(crc >>> 0, 0);
    for (let w = 0; w < 4;) w += (await fh.write(tail, w, 4 - w)).bytesWritten;
  } finally {
    await fh.close();
  }
}

/** Read exactly `view.length` bytes at `pos`; false at the end of the file. */
async function readInto(fh: fsp.FileHandle, view: Uint8Array, pos: number): Promise<boolean> {
  for (let o = 0; o < view.length;) {
    const n = Math.min(CHUNK, view.length - o);
    const { bytesRead } = await fh.read(view, o, n, pos + o);
    if (!bytesRead) return false;
    o += bytesRead;
  }
  return true;
}

class DiskNodeStore implements NodeStore {
  readonly minMs: number;
  readonly dir: string;
  readonly maxBytes: number;
  private engine: string | undefined;
  private fixedEngine: string | undefined;
  private written = 0;
  private pruned = false;
  private pruning: Promise<void> | null = null;

  constructor(o: { dir: string; minMs: number; maxBytes: number; engine?: string }) {
    this.dir = o.dir;
    this.minMs = o.minMs;
    this.maxBytes = o.maxBytes;
    this.fixedEngine = o.engine;
  }

  private engineId(): string { return this.fixedEngine ?? (this.engine ??= engineIdentity(this.dir)); }
  private fileOf(id: string) { return path.join(this.dir, sha256(JSON.stringify([FORMAT, id])) + EXT); }

  async load(identity: string): Promise<StoredNode | null> {
    const file = this.fileOf(identity);
    let fh: fsp.FileHandle;
    try { fh = await fsp.open(file, 'r'); } catch { return null; }
    let got: StoredNode | null | 'other' = null;
    let before: fs.Stats | null = null;
    try {
      before = await fh.stat();
      got = await this.read(fh, identity);
    } catch { /* unreadable: as corrupt */ } finally {
      await fh.close().catch(() => {});
    }
    if (got === 'other') return null;
    if (got) {
      // a load is a use: the entry is then the last to go when the folder is over its cap
      const now = new Date();
      await fsp.utimes(file, now, now).catch(() => {});
      return got;
    }
    // a broken file goes, unless another process has put a new one in its place meanwhile
    const after = await fsp.stat(file).catch(() => null);
    if (before && after && after.size === before.size && after.mtimeMs === before.mtimeMs) await fsp.rm(file, { force: true }).catch(() => {});
    return null;
  }

  /** The result a file holds; null when the file is broken; 'other' when it is whole but is another engine's. */
  private async read(fh: fsp.FileHandle, identity: string): Promise<StoredNode | null | 'other'> {
    const size = (await fh.stat()).size;
    const head = Buffer.alloc(HEAD);
    if (size < HEAD + 4 || !(await readInto(fh, head, 0)) || head.toString('latin1', 0, 8) !== MAGIC) return null;
    const hlen = head.readUInt32LE(8);
    if (hlen > size - HEAD - 4) return null;
    const hbuf = Buffer.alloc(hlen);
    if (!(await readInto(fh, hbuf, HEAD))) return null;
    const h = JSON.parse(hbuf.toString('utf8'));
    if (h?.v !== FORMAT || h.id !== sha256(identity) || !Array.isArray(h.arrays)) return null;
    // the sizes the header names must be the file's size, before anything is allocated for them
    let total = HEAD + hlen + 4;
    for (const [k, n] of h.arrays as [Kind, number][]) {
      if (!(k in KINDS) || !Number.isSafeInteger(n) || n < 0) return null;
      total += n * KINDS[k].BYTES_PER_ELEMENT;
    }
    if (total !== size) return null;
    // another engine's result is whole, not broken: left for its engine, and written over when this one cooks the node
    if (h.engine !== this.engineId()) return 'other';
    let crc = zlib.crc32(head, 0);
    crc = zlib.crc32(hbuf, crc);
    const arrays: Typed[] = [];
    let pos = HEAD + hlen;
    for (const [k, n] of h.arrays as [Kind, number][]) {
      const a = new KINDS[k](n);
      const view = new Uint8Array(a.buffer, 0, a.byteLength);
      if (!(await readInto(fh, view, pos))) return null;
      for (let o = 0; o < view.length; o += CHUNK) crc = zlib.crc32(view.subarray(o, Math.min(view.length, o + CHUNK)), crc);
      pos += view.length;
      arrays.push(a);
    }
    const tail = Buffer.alloc(4);
    if (!(await readInto(fh, tail, pos)) || tail.readUInt32LE(0) !== crc >>> 0) return null;
    return { geo: unpackGeometry(h.geo, arrays), warnings: h.warnings ?? [], ...(h.stats ? { stats: h.stats } : {}), cookMs: Number(h.cookMs) || 0 };
  }

  async save(identity: string, node: StoredNode): Promise<void> {
    const A = new Arrays();
    let geo: any;
    try { geo = packGeometry(node.geo, A); } catch (e) { if (e instanceof Unstorable) return; throw e; }
    // one result may not take more than half of the cache
    if (A.bytes > this.maxBytes / 2) return;
    const header = Buffer.from(JSON.stringify({
      v: FORMAT, id: sha256(identity), engine: this.engineId(), cookMs: node.cookMs, warnings: node.warnings,
      ...(node.stats ? { stats: node.stats } : {}), arrays: A.kinds, geo,
    }), 'utf8');
    const file = this.fileOf(identity);
    const tmp = path.join(this.dir, `${path.basename(file, EXT)}.${process.pid}.${randomBytes(4).toString('hex')}${TMP}`);
    try {
      await fsp.mkdir(this.dir, { recursive: true });
      await writeEntry(tmp, header, A.views);
      // the rename replaces what is there; where that is refused (another process has it open) a whole file is in place
      try { await fsp.rename(tmp, file); } catch { await fsp.rm(tmp, { force: true }); }
    } catch {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      return;
    }
    this.written += A.bytes;
    if (!this.pruned || this.written >= this.maxBytes / 16) { this.pruned = true; this.written = 0; await this.prune(); }
  }

  /** Keep the folder within its cap: the entries used longest ago go first; temporary files of dead writers go too. */
  prune(): Promise<void> {
    return (this.pruning ??= this.sweep().finally(() => { this.pruning = null; }));
  }

  private async sweep(): Promise<void> {
    let names: string[];
    try { names = await fsp.readdir(this.dir); } catch { return; }
    const entries: { file: string; size: number; t: number }[] = [];
    const now = Date.now();
    let total = 0;
    for (const n of names) {
      const file = path.join(this.dir, n);
      const isEntry = n.endsWith(EXT), isTmp = n.endsWith(TMP);
      if (!isEntry && !isTmp) continue;
      let st: fs.Stats;
      try { st = await fsp.stat(file); } catch { continue; }
      if (isTmp) { if (now - st.mtimeMs > STALE_TMP_MS) await fsp.rm(file, { force: true }).catch(() => {}); continue; }
      entries.push({ file, size: st.size, t: st.mtimeMs });
      total += st.size;
    }
    if (total <= this.maxBytes) return;
    for (const e of entries.sort((a, b) => a.t - b.t)) {
      if (total <= this.maxBytes) break;
      try { await fsp.rm(e.file, { force: true }); total -= e.size; } catch { /* in use: left */ }
    }
  }
}

export interface NodeCacheOptions {
  /** the folder (default: nodeCacheFolder) */
  dir?: string;
  /** results of nodes that cooked at least this many milliseconds are kept (default 500) */
  minMs?: number;
  /** size cap in bytes (default 4 GB) */
  maxBytes?: number;
  /** the engine's identity, which a result is kept under (default: engineIdentity); for tests */
  engine?: string;
  env?: Env;
}

/**
 * The disk cook cache for a Node host (Host.persist), or null when it is switched off (TOPOTOPO_NODE_CACHE=off) or the
 * machine stores numbers the other way round.
 */
export function openNodeCache(o: NodeCacheOptions = {}): DiskNodeStore | null {
  const env = o.env ?? process.env;
  if (nodeCacheOff(env) || os.endianness() !== 'LE') return null;
  return new DiskNodeStore({ dir: o.dir ?? nodeCacheFolder(env), minMs: o.minMs ?? NODE_CACHE_MIN_MS, maxBytes: o.maxBytes ?? NODE_CACHE_MAX_BYTES, engine: o.engine });
}

export type { DiskNodeStore };
