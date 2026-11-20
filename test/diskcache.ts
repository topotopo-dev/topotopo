// The disk cook cache (src/host/diskcache.ts, the Engine's use of Host.persist): what is kept and what is not, that a result
// loaded from disk is the result that was saved (every node of the catalogue, bit for bit), that every kind of damage is
// a miss, the size cap, two processes at once, the switch and the folder variable, and the CLI and the MCP server end to
// end. Every cache folder here is a temp folder this test deletes; nothing touches the user's real cache folder.
//   node test/diskcache.ts
import './cache-guard.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomFillSync } from 'node:crypto';
import zlib from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import './diskcache-nodes.ts';
import { SLOW_NODE, SLOW_PASS } from './diskcache-nodes.ts';
import { variableTestFont } from './varfont.ts';
import { Engine } from '../src/graph/engine.ts';
import { allNodeDefs, defineNode } from '../src/graph/registry.ts';
import type { GraphSpec } from '../src/graph/types.ts';
import { createNodeHost } from '../src/host/node.ts';
import type { FileDep, NodeStore, StoredNode } from '../src/host/types.ts';
import { NODE_CACHE_MAX_BYTES, NODE_CACHE_MIN_MS, nodeCacheFolder, nodeCacheOff, openNodeCache } from '../src/host/diskcache.ts';
import { Attribute, Geometry } from '../src/core/geometry.ts';
import type { Volume } from '../src/core/geometry.ts';
import { EdgeSet } from '../src/core/edges.ts';
import { Heightfield } from '../src/core/heightfield.ts';
import { Image } from '../src/core/image.ts';
import { SdfGrid } from '../src/core/sdfgrid.ts';
import { openPackages } from '../src/packages/registry.ts';
import { ROOT, SKIP, createFixtureEngine, fixtureGraphFor } from './fixtures.ts';
import { fingerprint, sortedJSON } from './fingerprint.ts';

let fail = 0, pass = 0;
const check = (ok: unknown, msg: string) => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'topotopo-diskcache-test-'));
let counter = 0;
/** A cache folder of its own (not made yet: the cache makes it). */
const folder = () => path.join(tmp, `cache${++counter}`);
const entries = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.ttnode')) : []);
const leftovers = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.tmp') && f !== 'engine.json') : []);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The folder the real cache would use: the tests must never be pointed at it
const realDir = nodeCacheFolder({ ...process.env, TOPOTOPO_NODE_CACHE_DIR: '' });

try {
  // ------------------------------------------------------------ folder and switch
  {
    const dir = process.env.TOPOTOPO_NODE_CACHE_DIR ?? '';
    check(dir !== '' && path.resolve(dir) !== path.resolve(realDir) && path.resolve(dir).startsWith(path.resolve(os.tmpdir())), `the tests run with a cache folder of their own (${dir})`);
    check(nodeCacheFolder({ TOPOTOPO_NODE_CACHE_DIR: 'x/y' }).endsWith(path.join('x', 'y')) && path.isAbsolute(nodeCacheFolder({ TOPOTOPO_NODE_CACHE_DIR: 'x/y' })), 'TOPOTOPO_NODE_CACHE_DIR moves the folder');
    check(nodeCacheFolder({ LOCALAPPDATA: 'C:\\L' }, 'win32', 'C:\\H') === path.join('C:\\L', 'topotopo', 'nodes'), 'Windows: topotopo/nodes in the local app data folder');
    check(nodeCacheFolder({}, 'win32', 'C:\\H') === path.join('C:\\H', 'AppData', 'Local', 'topotopo', 'nodes'), 'Windows without LOCALAPPDATA: under the home folder');
    check(nodeCacheFolder({}, 'darwin', '/Users/a') === path.join('/Users/a', 'Library', 'Caches', 'topotopo', 'nodes'), 'macOS: Library/Caches');
    check(nodeCacheFolder({ XDG_CACHE_HOME: '/x' }, 'linux', '/home/a') === path.join('/x', 'topotopo', 'nodes') && nodeCacheFolder({}, 'linux', '/home/a') === path.join('/home/a', '.cache', 'topotopo', 'nodes'), 'Linux: $XDG_CACHE_HOME, else ~/.cache');
    check(['off', 'OFF', '0', 'false', 'no'].every((v) => nodeCacheOff({ TOPOTOPO_NODE_CACHE: v })) && !nodeCacheOff({}) && !nodeCacheOff({ TOPOTOPO_NODE_CACHE: 'on' }) && !nodeCacheOff({ TOPOTOPO_NODE_CACHE: '1' }), 'TOPOTOPO_NODE_CACHE=off (0, false, no) switches the cache off');
    check(openNodeCache({ env: { TOPOTOPO_NODE_CACHE: 'off' } }) === null && openNodeCache({ dir: folder() }) !== null, 'a switched-off cache is no store');
    check(NODE_CACHE_MIN_MS === 500 && NODE_CACHE_MAX_BYTES === 4 * 2 ** 30, 'results of 0.5 s or more, 4 GB');
    check(createNodeHost({}).persist === undefined && createNodeHost({ nodeCache: { dir: folder() } }).persist !== undefined && createNodeHost({ nodeCache: { env: { TOPOTOPO_NODE_CACHE: 'off' } } }).persist === undefined, 'a host keeps nothing unless asked, and the switch wins');
  }

  // ------------------------------------------------------------ a result, bit for bit
  /** Rewrite the header of an entry with a checksum that is right: a file that is whole, and wrong. */
  const rewriteHeader = (file: string, mutate: (h: any) => void) => {
    const b = fs.readFileSync(file);
    const hlen = b.readUInt32LE(8);
    const h = JSON.parse(b.subarray(16, 16 + hlen).toString('utf8'));
    mutate(h);
    const hb = Buffer.from(JSON.stringify(h), 'utf8');
    const head = Buffer.from(b.subarray(0, 16));
    head.writeUInt32LE(hb.length, 8);
    const arrays = b.subarray(16 + hlen, b.length - 4);
    const tail = Buffer.alloc(4);
    tail.writeUInt32LE(zlib.crc32(arrays, zlib.crc32(hb, zlib.crc32(head))) >>> 0, 0);
    fs.writeFileSync(file, Buffer.concat([head, hb, arrays, tail]));
  };
  /** The first difference between two geometries, or null: every array bit for bit, defaults, key orders, volumes. */
  const bytes = (v: ArrayBufferView) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  const same = (a: ArrayBufferView, b: ArrayBufferView) => a.constructor === b.constructor && bytes(a).equals(bytes(b));
  const num = (x: number) => (Object.is(x, -0) ? '-0' : String(x));
  function diffTable(name: string, a: Geometry['points'], b: Geometry['points']): string | null {
    if (a.count !== b.count) return `${name} count`;
    const ka = a.names(), kb = b.names();
    if (ka.join('|') !== kb.join('|')) return `${name} attribute names ${ka} / ${kb}`;
    for (const k of ka) {
      const x: Attribute = a.get(k)!, y: Attribute = b.get(k)!;
      if (x.type !== y.type || x.size !== y.size) return `${name}.${k} type`;
      if (JSON.stringify(Array.isArray(x.def) ? x.def.map(num) : x.def) !== JSON.stringify(Array.isArray(y.def) ? y.def.map(num) : y.def)) return `${name}.${k} default`;
      if (x.isArray) { x.compact(); y.compact(); }
      if (Array.isArray(x.data)) { if (JSON.stringify(x.data) !== JSON.stringify(y.data)) return `${name}.${k} strings`; }
      else if (!same(x.data as Float64Array, y.data as Float64Array)) return `${name}.${k} data`;
      if (!!x.offsets !== !!y.offsets || (x.offsets && !same(x.offsets, y.offsets!))) return `${name}.${k} offsets`;
    }
    return null;
  }
  function diffMasks(name: string, a: Map<string, Uint8Array>, b: Map<string, Uint8Array>): string | null {
    if ([...a.keys()].join('|') !== [...b.keys()].join('|')) return `${name} group names`;
    for (const [k, v] of a) if (!same(v, b.get(k)!)) return `${name} group ${k}`;
    return null;
  }
  function diffVolume(x: Volume, y: Volume): string | null {
    if (x.kind !== y.kind || x.name !== y.name) return `volume ${x.name} kind`;
    if (x.kind === 'sdf') return null; // a function: two cooks make two, which the cache does not keep
    if (x.kind === 'grid' && y.kind === 'grid') {
      return x.dims.join() === y.dims.join() && x.origin.map(num).join() === y.origin.map(num).join() && num(x.voxel) === num(y.voxel) && same(x.values, y.values) ? null : `grid ${x.name}`;
    }
    if ((x.kind === 'image' || x.kind === 'heightfield') && (y.kind === 'image' || y.kind === 'heightfield')) {
      if (x.width !== y.width || x.height !== y.height) return `${x.kind} ${x.name} size`;
      if (x.kind === 'heightfield' && y.kind === 'heightfield' && (num(x.cellSize) !== num(y.cellSize) || x.origin.map(num).join() !== y.origin.map(num).join())) return `heightfield ${x.name} grid`;
      if ([...x.layers.keys()].join('|') !== [...y.layers.keys()].join('|')) return `${x.kind} ${x.name} layer names`;
      for (const [k, v] of x.layers) if (!same(v, y.layers.get(k)!)) return `${x.kind} ${x.name} layer ${k}`;
      return null;
    }
    return `volume ${x.name} is not stored`;
  }
  function diffGeo(a: Geometry, b: Geometry): string | null {
    for (const t of ['points', 'vertices', 'prims', 'detail'] as const) { const d = diffTable(t, a[t], b[t]); if (d) return d; }
    for (const f of ['primStart', 'vertexPoint', 'primClosed'] as const) if (!same(a[f], b[f])) return f;
    for (const [n, x, y] of [['point', a.pointGroups, b.pointGroups], ['prim', a.primGroups, b.primGroups], ['vertex', a.vertexGroups, b.vertexGroups]] as const) { const d = diffMasks(n, x, y); if (d) return d; }
    const ea = [...a.edgeGroups].map(([k, s]) => [k, [...s].join(';')]), eb = [...b.edgeGroups].map(([k, s]) => [k, [...s].join(';')]);
    if (JSON.stringify(ea) !== JSON.stringify(eb)) return 'edge groups (or their order)';
    if (!!a.primKind !== !!b.primKind) return 'primKind';
    if (a.primKind) for (const f of ['primKind', 'packedSource', 'packedXform'] as const) if (!same(a[f]!, b[f]!)) return f;
    if (a.packedSources.length !== b.packedSources.length) return 'packed sources';
    for (let i = 0; i < a.packedSources.length; i++) { const d = diffGeo(a.packedSources[i], b.packedSources[i]); if (d) return `packed source ${i}: ${d}`; }
    if (a.volumes.length !== b.volumes.length) return 'volumes';
    for (let i = 0; i < a.volumes.length; i++) { const d = diffVolume(a.volumes[i], b.volumes[i]); if (d) return d; }
    return null;
  }

  // A geometry that has everything a result can: every attribute kind, defaults, NaN and -0, loose arrays, all four group
  // kinds, packed instances with a source, a spline prim, an image, a heightfield and a grid.
  function rich(): Geometry {
    const g = new Geometry({ positions: [0, 0, 0, 1, 0, 0, 1, 1, -0, 0, 1, 0, 2, 0, 0], prims: [[0, 1, 2, 3], [1, 4, 2], [4]] });
    g.points.add('Cd', 'float', 3, [0.25, 0.5, 0.75]);
    g.points.add('id', 'int', 1);
    g.points.get('id')!.set(2, 7);
    g.points.add('tag', 'string').set(1, 'a "quoted" \u00e4\u0161 \ud83d\ude00 tag');
    g.points.add('nan', 'float', 1).set(0, NaN);
    // a NaN with a payload, and infinities, which JSON cannot hold
    const raw = new DataView((g.points.get('nan')!.data as Float64Array).buffer);
    raw.setUint32(0, 1, true); raw.setUint32(4, 0x7ff80000, true);
    (g.points.get('nan')!.data as Float64Array)[2] = Infinity; (g.points.get('nan')!.data as Float64Array)[3] = -0;
    g.prims.add('weights', 'float[]');
    g.prims.get('weights')!.set(0, [1, 2, 3]); g.prims.get('weights')!.set(1, []); g.prims.get('weights')!.set(2, [9]); // loose
    g.prims.add('names', 'string[]').set(1, ['x', 'y']);
    g.prims.add('ints', 'int[]').set(0, [5, 6]);
    g.vertices.add('uv', 'float', 2, [0.5, -0]);
    g.detail.add('note', 'string').set(0, 'hello');
    g.detail.add('f', 'float', 4).set(0, [1, 2, 3, 4]);
    g.pointGroups.set('a', Uint8Array.from([1, 0, 1, 0, 1]));
    g.primGroups.set('p', Uint8Array.from([0, 1, 0]));
    g.vertexGroups.set('v', Uint8Array.from({ length: g.numVertices }, (_, i) => i % 2));
    g.edgeGroups.set('e', new EdgeSet([[3, 0], [2, 1], [4, 1]]));
    g.volumes.push(new Image(2, 2, 'img', new Map([['C', Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])], ['mask', Float32Array.from([0, 1, 0, NaN])]])));
    g.volumes.push(new Heightfield(3, 2, 0.5, [-0, 1.5], new Map([['height', Float32Array.from([0, 1, 2, 3, 4, 5])]]), 'terrain'));
    g.volumes.push(new SdfGrid([2, 2, 2], [-0, 0, 1], 0.25, Float32Array.from([-Infinity, -0, 0.5, Infinity, 1, 2, 3, 4]), 'sdf'));
    return g;
  }
  {
    const store = openNodeCache({ dir: folder(), minMs: 0, engine: 'x' })!;
    const g = rich();
    // packed instances of a source, and a spline prim
    const e = new Engine(createNodeHost({ baseDir: tmp }));
    await e.init();
    const packed = (await e.cook({ nodes: { b: { type: 'box' }, p: { type: 'point_grid', params: { counts: [2, 1, 2] } }, c: { type: 'copy_to_points', in: ['b', 'p'], params: { pack: true } }, n: { type: 'nurbs' }, m: { type: 'merge', in: ['c', 'n'] } }, output: 'm' })).geo!;
    check(packed.hasPacked() && packed.hasSplines(), 'the test geometry has packed instances and a spline prim');
    for (const [name, geo] of [['rich', g], ['packed', packed]] as const) {
      await store.save(name, { geo, deps: [{ p: '/a/b.png', k: 'f', s: '1:2' }, { p: '/a', k: 'd', s: '["x"]' }], warnings: ['w1', 'w "2"'], stats: { n: 3 }, cookMs: 1234.5 });
      const back = await store.load(name);
      const d = back ? diffGeo(geo, back.geo) : 'not loaded';
      check(back && d === null, `${name}: the result loaded is the result saved, bit for bit${d ? ` (${d})` : ''}`);
      check(back?.warnings.join('|') === 'w1|w "2"' && back?.stats?.n === 3 && back?.cookMs === 1234.5 && JSON.stringify(back?.deps) === JSON.stringify([{ p: '/a/b.png', k: 'f', s: '1:2' }, { p: '/a', k: 'd', s: '["x"]' }]), `${name}: its warnings, stats, files and cook time come back`);
    }
    const sdf = new Geometry();
    sdf.volumes.push({ kind: 'sdf', name: 's', bounds: { min: [0, 0, 0], max: [1, 1, 1] }, sample: () => 0 });
    await store.save('sdf', { geo: sdf, deps: [], warnings: [], cookMs: 1 });
    check((await store.load('sdf')) === null && entries(store.dir).length === 2, 'a result with an SDF volume (a function) is not kept');
    check((await store.load('nothing')) === null, 'an identity never saved is a miss');
  }

  // ------------------------------------------------------------ what the engine offers, and keys it by
  /** A store in memory that records what the engine asks and offers. */
  class Spy implements NodeStore {
    minMs: number;
    saved = new Map<string, StoredNode>();
    asked: string[] = [];
    constructor(minMs = 0) { this.minMs = minMs; }
    async load(id: string, accept?: (deps: FileDep[]) => boolean) { this.asked.push(id); const n = this.saved.get(id); return n && (!accept || accept(n.deps)) ? n : null; }
    async save(id: string, n: StoredNode) { this.saved.set(id, n); }
  }
  const engineWith = async (store: NodeStore | undefined, baseDir = tmp) => {
    const e = new Engine(createNodeHost({ baseDir }));
    await e.init();
    if (store) e.host.persist = store;
    return e;
  };
  const cookOk = async (e: Engine, g: GraphSpec, o: Parameters<Engine['cook']>[1] = {}) => {
    const r = await e.cook(g, o);
    if (!r.ok) throw new Error(`cook failed: ${r.errors.map((x) => `[${x.node}] ${x.message}`).join('; ')}`);
    return r;
  };
  {
    // which results are offered: a plain node and what is made from the file node or from a graph cooked inside a node
    // are; a node that cooked a graph inside itself is not (its nodes are, on their own); what a script that runs nodes
    // or a URL fed is not, nor what is made from it
    const obj = path.join(tmp, 'cube.obj');
    fs.writeFileSync(obj, 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
    const nodes: GraphSpec['nodes'] = {
      plain: { type: 'box' },
      each: { type: 'foreach', in: ['plain'], params: { mode: 'count', count: 2, body: { nodes: { i: { type: 'input', params: { index: 0 } }, o: { type: 'transform', in: ['i'], params: { translate: [1, 0, 0] } } }, output: 'o' } } },
      scr: { type: 'script', params: { code: "return await lib.run('sphere', { radius: 2 });" } },
      file: { type: 'file', params: { path: obj } },
      url: { type: 'attrib_create', in: ['plain'], params: { name: 'src', type: 'string', value: 'https://example.com/a.png' } },
      safe: { type: 'merge', in: ['plain', 'each', 'file'] },
      fromScript: { type: 'merge', in: ['scr', 'plain'] },
      fromUrl: { type: 'null', in: ['url'] },
    };
    const types = async (out: string) => {
      const spy = new Spy();
      await cookOk(await engineWith(spy), { nodes, output: out });
      return (t: string) => [...spy.saved.keys()].some((k) => k.startsWith(`${t}|`));
    };
    const ofSafe = await types('safe');
    check(ofSafe('box') && ofSafe('file') && ofSafe('merge'), 'a plain node, the file node and a merge of them are offered to the store');
    check(!ofSafe('foreach') && ofSafe('transform'), 'a node that cooked a graph inside itself (foreach) is not, the nodes inside it are');
    const ofScript = await types('fromScript');
    check(!ofScript('script') && !ofScript('merge') && ofScript('box'), 'a script that runs nodes, and what is made from it, is not offered');
    const ofUrl = await types('fromUrl');
    check(!ofUrl('attrib_create') && !ofUrl('null') && ofUrl('box'), 'a node with a URL in a param, and what is made from it, is not offered');
  }
  {
    // an engine without a store, and nodes under the store's minimum, offer nothing
    const spy = new Spy(60_000);
    await cookOk(await engineWith(spy), { nodes: { a: { type: SLOW_NODE, params: { ms: 30 } }, b: { type: 'null', in: ['a'] } }, output: 'b' });
    check(spy.saved.size === 0 && spy.asked.length === 2, `nodes under the store's minimum are asked for but not offered (${spy.asked.length} asked, ${spy.saved.size} offered)`);
  }
  {
    // time: a node that depends on the frame is kept per frame, and one found to depend on it while cooking never answers for another frame
    const g: GraphSpec = { nodes: { b: { type: 'box' }, w: { type: 'wrangle', in: ['b'], params: { code: '@P.y += @Frame * 0.1;' } }, h: { type: 'transform', in: ['w'], params: { translate: [0, '=frame * 0.5', 0] } } }, output: 'h' };
    const spy = new Spy();
    const f1 = await cookOk(await engineWith(spy), g, { frame: 1 });
    const f5spy = new Spy();
    f5spy.saved = new Map(spy.saved);
    const f5 = await cookOk(await engineWith(f5spy), g, { frame: 5 });
    const f5plain = await cookOk(await engineWith(undefined), g, { frame: 5 });
    check(fingerprint(f5.geo!).hashes.P === fingerprint(f5plain.geo!).hashes.P && fingerprint(f5.geo!).hashes.P !== fingerprint(f1.geo!).hashes.P, 'frame 5 cooked with the results of frame 1 in the store is the same as frame 5 cooked alone');
    const f1again = await cookOk(await engineWith(f5spy), g, { frame: 1 });
    check(f1again.results.get('h')!.disk === true && fingerprint(f1again.geo!).hashes.P === fingerprint(f1.geo!).hashes.P, 'frame 1 again comes from the store (a node whose params read the frame is keyed by it)');
    check([...spy.saved.keys()].filter((k) => k.startsWith('transform|')).every((k) => k.includes('T:1:')), 'a time-dependent node is keyed by its frame');
  }

  // ------------------------------------------------------------ files: the stamp and the folder they are read from
  {
    const store = new Spy();
    // a PNG each in two folders: same name, same size, the same modification time, different pixels
    const png = (v: number) => {
      const w = 4, h = 4, raw = Buffer.alloc(h * (1 + w * 4));
      for (let y = 0; y < h; y++) for (let x = 0; x < w * 4; x++) raw[y * (1 + w * 4) + 1 + x] = x % 4 === 3 ? 255 : v;
      return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', Buffer.from([0, 0, 0, w, 0, 0, 0, h, 8, 6, 0, 0, 0])), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
    };
    const A = path.join(tmp, 'fa'), B = path.join(tmp, 'fb');
    fs.mkdirSync(A); fs.mkdirSync(B);
    fs.writeFileSync(path.join(A, 'a.png'), png(40)); fs.writeFileSync(path.join(B, 'a.png'), png(200));
    const t = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(path.join(A, 'a.png'), t, t); fs.utimesSync(path.join(B, 'a.png'), t, t);
    const g: GraphSpec = { nodes: { i: { type: 'image_file', params: { path: 'a.png' } } }, output: 'i' };
    const ra = await cookOk(await engineWith(store, A), g);
    const rb = await cookOk(await engineWith(store, B), g);
    check(!rb.results.get('i')!.disk && sortedJSON(fingerprint(ra.geo!)) !== sortedJSON(fingerprint(rb.geo!)), 'the same file name with the same size and time in another folder is another result');
    const ra2 = await cookOk(await engineWith(store, A), g);
    check(ra2.results.get('i')!.disk === true && sortedJSON(fingerprint(ra2.geo!)) === sortedJSON(fingerprint(ra.geo!)), 'and the same folder again is the stored one');
    // the file changes (another size): a miss
    fs.writeFileSync(path.join(A, 'a.png'), Buffer.concat([png(90), Buffer.from('trailing bytes after IEND')]));
    fs.utimesSync(path.join(A, 'a.png'), new Date(), new Date());
    const ra3 = await cookOk(await engineWith(store, A), g);
    check(!ra3.results.get('i')!.disk && sortedJSON(fingerprint(ra3.geo!)) !== sortedJSON(fingerprint(ra.geo!)), 'a file that changed is a miss');
  }

  // ------------------------------------------------------------ the folder: damage, engine, cap, concurrency
  const slowGraph = (ms: number, value = 1): GraphSpec => ({ nodes: { s: { type: SLOW_NODE, params: { ms, value } }, n: { type: 'null', in: ['s'] } }, output: 'n' });
  {
    const dir = folder();
    const open = (engine = 'e1', o: object = {}) => openNodeCache({ dir, minMs: 100, engine, ...o })!;
    const r1 = await cookOk(await engineWith(open()), slowGraph(150, 2));
    check(entries(dir).length === 1 && !r1.results.get('s')!.cached && leftovers(dir).length === 0, 'a node over the minimum is written, through a temporary file that is gone');
    const r2 = await cookOk(await engineWith(open()), slowGraph(150, 2));
    check(r2.results.get('s')!.disk === true && r2.results.get('s')!.cached && r2.results.get('s')!.savedMs! >= 100 && r2.results.get('s')!.stats?.waited === 150, 'the next engine loads it, and the report says so (disk, savedMs, its stats)');
    check(!(await cookOk(await engineWith(open()), slowGraph(150, 3))).results.get('s')!.disk, 'another param is a miss');
    check(!(await cookOk(await engineWith(open('e2')), slowGraph(150, 2))).results.get('s')!.disk, 'another engine code hash is a miss');
    check((await cookOk(await engineWith(open('e2')), slowGraph(150, 2))).results.get('s')!.disk === true, 'and the engine that wrote the result last finds it');
    check(!(await cookOk(await engineWith(open('e1')), slowGraph(150, 2))).results.get('s')!.disk, '(the one entry now belongs to the newer engine)');
    const w = await cookOk(await engineWith(open('e1')), slowGraph(150, 2));
    check(w.results.get('s')!.disk === true && entries(dir).length === 2, 'a miss writes the result again; one file per result');
    check(w.results.get('s')!.warnings.length === 0, 'a result without warnings has none');

    // the real engine identity (the hash of the engine's code and the libraries) works end to end
    const d2 = folder();
    const real = () => openNodeCache({ dir: d2, minMs: 100 })!;
    await cookOk(await engineWith(real()), slowGraph(120, 5));
    check((await cookOk(await engineWith(real()), slowGraph(120, 5))).results.get('s')!.disk === true && fs.existsSync(path.join(d2, 'engine.json')), 'with the engine\'s own identity a second engine loads it (its hash is noted in the folder)');
  }
  {
    // damage of every kind is a miss, and the node is cooked and written again
    const dir = folder();
    const open = () => openNodeCache({ dir, minMs: 100, engine: 'e' })!;
    const file = () => path.join(dir, entries(dir)[0]);
    await cookOk(await engineWith(open()), slowGraph(120, 2));
    const good = fs.readFileSync(file());
    const damages: [string, (b: Buffer) => Buffer][] = [
      ['truncated in the middle', (b) => b.subarray(0, b.length >> 1)],
      ['truncated by a byte', (b) => b.subarray(0, b.length - 1)],
      ['empty', () => Buffer.alloc(0)],
      ['not a cache file', () => Buffer.from('this is not a cache file at all, only text')],
      ['one flipped bit in the arrays', (b) => { const c = Buffer.from(b); c[c.length - 9] ^= 1; return c; }],
      ['one flipped bit in the header', (b) => { const c = Buffer.from(b); c[40] ^= 1; return c; }],
      ['a header length too large', (b) => { const c = Buffer.from(b); c.writeUInt32LE(0xfffffff0, 8); return c; }],
      ['extra bytes at the end', (b) => Buffer.concat([b, Buffer.from('xx')])],
    ];
    for (const [what, damage] of damages) {
      fs.writeFileSync(file(), damage(good));
      const r = await cookOk(await engineWith(open()), slowGraph(120, 2));
      const ok = !r.results.get('s')!.disk && !r.results.get('s')!.error && (await cookOk(await engineWith(open()), slowGraph(120, 2))).results.get('s')!.disk === true;
      check(ok && entries(dir).length === 1, `a file ${what}: ignored, cooked, written again whole`);
    }
    fs.rmSync(file());
    fs.mkdirSync(path.join(dir, `${'a'.repeat(64)}.ttnode`)); // a folder where a file belongs does not break a cook either
    const r = await cookOk(await engineWith(open()), slowGraph(120, 2));
    check(!r.results.get('s')!.error, 'an entry that cannot be read as a file is no error');
  }
  {
    // size cap: the entries used longest ago go first; a load counts as a use
    const dir = folder();
    // a result of about 100 kB: an image of 100 × 250 pixels with every value v
    const big = (v: number): StoredNode => {
      // random bytes, which no codec shrinks, so an entry is as large as its pixels; the first four values name it
      const px = new Float32Array(25000);
      randomFillSync(new Uint8Array(px.buffer));
      px.fill(v, 0, 4);
      const g = new Geometry(); g.volumes.push(new Image(100, 250, 'i', new Map([['C', px]])));
      return { geo: g, deps: [], warnings: [], cookMs: 1 };
    };
    const store = openNodeCache({ dir, minMs: 0, maxBytes: 250_000, engine: 'e' })!;
    await store.save('A', big(1)); await store.save('B', big(2));
    const files = () => entries(dir).map((f) => path.join(dir, f));
    check(files().length === 2, `two results of about ${Math.round(fs.statSync(files()[0]).size / 1000)} kB fit a cap of 250 kB`);
    // which file holds which result: A holds 1s, B holds 2s, and so on
    const holds = (f: string, v: number) => fs.readFileSync(f).includes(Buffer.from(new Float32Array(4).fill(v).buffer));
    const [fa, fb] = [files().find((f) => holds(f, 1))!, files().find((f) => holds(f, 2))!];
    const ago = (f: string, seconds: number) => { const t = new Date(Date.now() - seconds * 1000); fs.utimesSync(f, t, t); };
    ago(fa, 1000); ago(fb, 500);
    await store.save('C', big(3));
    check(!fs.existsSync(fa) && fs.existsSync(fb) && files().length === 2, 'over the cap, the oldest entry goes first');
    check((await store.load('B')) !== null, 'the newer one is still there, and loading it counts as a use');
    ago(files().find((f) => holds(f, 3))!, 100);
    await store.save('D', big(4));
    check(fs.existsSync(fb) && !files().some((f) => holds(f, 3)) && files().length === 2, 'an entry that was loaded outlives an older one that was not');
    // one result larger than half the cap is not kept
    const huge = openNodeCache({ dir: folder(), minMs: 0, maxBytes: 150_000, engine: 'e' })!;
    await huge.save('H', big(5));
    check(entries(huge.dir).length === 0, 'a result larger than half of the cap is not written');
    // leftovers of a dead writer are swept
    const stale = path.join(dir, 'dead.123.abcd.tmp');
    fs.writeFileSync(stale, 'x'); fs.utimesSync(stale, new Date(Date.now() - 2 * 3600_000), new Date(Date.now() - 2 * 3600_000));
    const fresh = path.join(dir, 'live.456.abcd.tmp');
    fs.writeFileSync(fresh, 'x');
    await store.save('E', big(6));
    check(!fs.existsSync(stale) && fs.existsSync(fresh), 'temporary files of a writer that died are removed, those of a live one are not');
  }
  {
    // many writers and readers of one result at once, in one process
    const dir = folder();
    const stores = Array.from({ length: 6 }, () => openNodeCache({ dir, minMs: 0, engine: 'e' })!);
    const geo = rich();
    const node = { geo, deps: [], warnings: [], cookMs: 5 };
    const loads: Promise<unknown>[] = [];
    await Promise.all(stores.flatMap((s, i) => [s.save('same', node), s.save(`own${i}`, node), (async () => { await sleep(i); loads.push(s.load('same')); })()]));
    const got = await Promise.all(loads);
    check(got.every((x) => x === null || diffGeo(geo, (x as StoredNode).geo) === null), 'a read during writes is a whole result or a miss');
    const last = await stores[0].load('same');
    check(last !== null && diffGeo(geo, last.geo) === null && leftovers(dir).length === 0 && entries(dir).length === 7, 'six writers of one result leave one whole file and no leftovers');
  }

  // ------------------------------------------------------------ what a result was made from: files, graphs inside nodes, URLs
  {
    // A slow node below one that reads a file is kept with the files it was made from: the same files, it loads; any of them
    // changed, the next cook is fresh and says so. The file node is read by name (cube.obj), its side file (its .mtl) apart
    // from what the signature holds, a foreach, graph_ref and an asset whose graph reads it, a solver (never kept)
    const W = path.join(tmp, 'work');
    fs.mkdirSync(W);
    const objFile = path.join(W, 'm.obj'), mtlFile = path.join(W, 'm.mtl');
    let stampN = 0;
    /** A new modification time, whatever the size */
    const bump = (f: string) => { const t = new Date(Date.UTC(2021, 0, 1) + ++stampN * 10_000); fs.utimesSync(f, t, t); };
    const writeObj = (x: number) => { fs.writeFileSync(objFile, `mtllib m.mtl\nusemtl paint\nv 0 0 0\nv ${x} 0 0\nv 0 1 0\nf 1 2 3\n`); bump(objFile); };
    const writeMtl = (r: number) => { fs.writeFileSync(mtlFile, `newmtl paint\nKd ${r} 0.2 0.3\n`); bump(mtlFile); };
    const body: GraphSpec = { nodes: { f: { type: 'file', params: { path: objFile } } }, output: 'f' };
    const withSlow = (nodes: GraphSpec['nodes'], from: string): GraphSpec => ({ nodes: { ...nodes, slow: { type: SLOW_PASS, in: [from], params: { ms: 150 } } }, output: 'slow' });
    const dirs = new Set<string>();
    const cookSlow = async (dir: string, g: GraphSpec, setup?: (e: Engine) => void) => {
      const e = await engineWith(openNodeCache({ dir, minMs: 100, engine: 'files' })!, W);
      setup?.(e);
      const r = await cookOk(e, g);
      return { slow: r.results.get('slow')!, x: r.geo!.bbox(true).max[0], fp: sortedJSON(fingerprint(r.geo!)) };
    };
    /** cook, cook again (loads when it may), change a file, cook again: fresh, never the old result */
    const scenario = async (name: string, g: GraphSpec, mutate: () => void, o: { setup?: (e: Engine) => void; loads?: boolean } = {}) => {
      writeObj(1); writeMtl(0.1);
      const dir = folder();
      dirs.add(dir);
      const a = await cookSlow(dir, g, o.setup), b = await cookSlow(dir, g, o.setup);
      mutate();
      const c = await cookSlow(dir, g, o.setup);
      const loads = o.loads ?? true;
      check(!a.slow.disk && !!b.slow.disk === loads && b.fp === a.fp, `${name}: ${loads ? 'the second cook loads it' : 'it is never kept'}, the same result`);
      check(!c.slow.disk && c.fp !== a.fp, `${name}: after the file changed the next cook is fresh (x ${a.x} → ${c.x}), not the stored one`);
    };
    const newObj = () => writeObj(5), newMtl = () => writeMtl(0.9);
    await scenario('below the file node (its file)', withSlow(body.nodes, 'f'), newObj);
    await scenario('below the file node (its .mtl, which the signature does not hold)', withSlow(body.nodes, 'f'), newMtl);
    const each: GraphSpec['nodes'] = { each: { type: 'foreach', params: { mode: 'count', count: 1, body } } };
    await scenario('below a foreach whose body reads the file', withSlow(each, 'each'), newObj);
    await scenario('below a foreach whose body reads the .mtl', withSlow(each, 'each'), newMtl);
    const ref: GraphSpec['nodes'] = { ref: { type: 'graph_ref', params: { graph: 'g' } } };
    const useGraph = (e: Engine) => { e.root.graphs = (n: string) => (n === 'g' ? structuredClone(body) : undefined); };
    await scenario('below graph_ref whose graph reads the file', withSlow(ref, 'ref'), newObj, { setup: useGraph });
    await scenario('below graph_ref whose graph reads the .mtl', withSlow(ref, 'ref'), newMtl, { setup: useGraph });
    const asset: GraphSpec['nodes'] = { a: { type: 'readm' } };
    const useAsset = (e: Engine) => { e.registerAsset('readm', structuredClone(body)); };
    await scenario('below an asset whose graph reads the file', withSlow(asset, 'a'), newObj, { setup: useAsset });
    await scenario('below an asset whose graph reads the .mtl', withSlow(asset, 'a'), newMtl, { setup: useAsset });
    const solver: GraphSpec['nodes'] = {
      seed: { type: 'box' },
      sol: { type: 'solver', in: ['seed'], params: { body: { nodes: { prev: { type: 'input', params: { index: 0 } }, f: { type: 'file', params: { path: objFile } }, m: { type: 'merge', in: ['prev', 'f'] } }, output: 'm' } } },
    };
    await scenario('below a solver whose body reads the file', withSlow(solver, 'sol'), newObj, { loads: false });
    // the asset used inside another graph: its definition is not in that graph's signature, so nothing below it is kept
    {
      const g = withSlow({ each: { type: 'foreach', params: { mode: 'count', count: 1, body: { nodes: { a: { type: 'readm' } }, output: 'a' } } } }, 'each');
      writeObj(1);
      const dir = folder();
      const a = await cookSlow(dir, g, useAsset), b = await cookSlow(dir, g, useAsset);
      check(!a.slow.disk && !b.slow.disk && entries(dir).length === 0, 'what is made from an asset used inside another graph is not kept (the graph does not hold its definition)');
    }
    // a URL: never kept, nor anything below it
    {
      const g = withSlow({ f: { type: 'file', params: { path: 'http://127.0.0.1:9/m.obj' } }, u: { type: 'null', in: ['f'] } }, 'u');
      const dir = folder();
      const r = await (await engineWith(openNodeCache({ dir, minMs: 100, engine: 'files' })!, W)).cook(g);
      check(!r.ok && entries(dir).length === 0, 'below a URL nothing is kept (the cook fails here: nothing answers)');
      const g2 = withSlow({ b: { type: 'box' }, u: { type: 'attrib_create', in: ['b'], params: { name: 'src', type: 'string', value: 'https://example.com/a.png' } } }, 'u');
      const a = await cookSlow(dir, g2), b = await cookSlow(dir, g2);
      check(!a.slow.disk && !b.slow.disk && entries(dir).length === 0, 'below a node with a URL in a param nothing is kept, and nothing is loaded');
    }
    // a file that holds its stamp: a result loaded from disk makes what is below it keep the files too
    {
      writeObj(1); writeMtl(0.1);
      const dir = folder();
      const g: GraphSpec = { nodes: { ...body.nodes, slow: { type: SLOW_PASS, in: ['f'], params: { ms: 150 } }, after: { type: SLOW_PASS, in: ['slow'], params: { ms: 150 } } }, output: 'after' };
      const run = async () => { const r = await cookOk(await engineWith(openNodeCache({ dir, minMs: 100, engine: 'files' })!, W), g); return { slow: r.results.get('slow')!, after: r.results.get('after')! }; };
      await run();
      const b = await run();
      check(b.slow.disk && b.after.disk, 'two slow nodes in a row both load');
      newMtl();
      const c = await run();
      check(!c.slow.disk && !c.after.disk, 'a changed side file makes both of them cook again');
    }
  }
  {
    // a result cooked while no store was attached is unknown, so unsafe: a store attached later keeps nothing made from it
    const e = await engineWith(undefined);
    const spy = new Spy();
    const nodes: GraphSpec['nodes'] = { b: { type: 'box' }, s: { type: 'transform', in: ['b'], params: { translate: [1, 0, 0] } }, t: { type: 'transform', in: ['s'], params: { translate: [0, 1, 0] } } };
    await cookOk(e, { nodes, output: 's' });
    e.host.persist = spy;
    await cookOk(e, { nodes, output: 't' });
    check(spy.saved.size === 0, `what is made from results cooked before a store was attached is not offered to it (${spy.saved.size} offered)`);
    const spy2 = new Spy();
    await cookOk(await engineWith(spy2), { nodes, output: 't' });
    check(spy2.saved.size === 3, 'while one attached from the start is offered all three');
  }
  {
    // the part of the signature that depends on state the node reads when its cook starts (the kernels loaded): the result
    // is kept under the one the cook used, even when the state changed while the store was asked
    const backend = { v: 'js' };
    defineNode({
      type: 'backend_probe', category: 'test', summary: 'Test node: its signature names a backend, which its cook reads at its start.', inputs: [], params: {},
      example: { type: 'backend_probe' },
      signatureExtra: () => backend.v,
      async cook() {
        const used = backend.v;
        await sleep(5);
        const g = new Geometry({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], prims: [[0, 1, 2]] });
        g.detail.add('backend', 'string').set(0, used);
        return g;
      },
    });
    const spy = new Spy();
    const load = spy.load.bind(spy);
    spy.load = async (id, accept) => { backend.v = 'kernel'; return load(id, accept); };
    const r = await cookOk(await engineWith(spy), { nodes: { p: { type: 'backend_probe' } }, output: 'p' });
    const made = String(r.geo!.detail.get('backend')!.get(0));
    const keys = [...spy.saved.keys()];
    check(made === 'kernel' && keys.length === 1 && /\|\|kernel/.test(keys[0]) && !/\|\|js/.test(keys[0]), `a result is kept under the backend that made it (${made}), not the one the signature named (${/\|\|(\w+)/.exec(spy.asked[0])?.[1]} when asked)`);
  }
  {
    // an entry whose arrays do not fit its own counts is a miss, not a geometry
    const dir = folder();
    const store = openNodeCache({ dir, minMs: 0, engine: 'x' })!;
    const pass = (g: Geometry) => ({ geo: g, deps: [], warnings: [], cookMs: 1 });
    const file = () => path.join(dir, entries(dir)[0]);
    /** Rewrite the header of the entry, with a checksum that is right: a file that is whole, and wrong */
    const tamper = (mutate: (h: any) => void) => rewriteHeader(file(), mutate);
    const cases: [string, (h: any) => void][] = [
      ['more points than the arrays hold', (h) => { h.geo.points.count++; }],
      ['fewer prims than the arrays hold', (h) => { h.geo.prims.count--; }],
      ['a vertex array of the wrong kind', (h) => { h.geo.vertexPoint = h.geo.points.attribs[0].v; }],
      ['a group array of the wrong length', (h) => { h.geo.pointGroups[0][1] = h.geo.primClosed; }],
      ['a heightfield layer of the wrong length', (h) => { h.geo.volumes[1].width += 1; }],
      ['an array that is not there', (h) => { h.geo.primStart = 9999; }],
    ];
    for (const [what, mutate] of cases) {
      const g = rich();
      await store.save('t', pass(g));
      const good = await store.load('t');
      tamper(mutate);
      let got: StoredNode | null | 'threw' = 'threw';
      try { got = await store.load('t'); } catch { /* stays 'threw' */ }
      check(good !== null && got === null, `an entry with ${what} is a miss`);
      for (const f of entries(dir)) fs.rmSync(path.join(dir, f));
    }
  }
  {
    // arrays are stored compressed when that pays; a compressed array that unpacks to another size is a miss
    const dir = folder();
    const store = openNodeCache({ dir, minMs: 0, engine: 'x' })!;
    const g = new Geometry();
    g.volumes.push(new Image(256, 256, 'z', new Map([['C', new Float32Array(65536)]])));
    g.points.add('Cd', 'float', 3);
    await store.save('z', { geo: g, deps: [], warnings: [], cookMs: 1 });
    const file = path.join(dir, entries(dir)[0]);
    const back = await store.load('z');
    check(fs.statSync(file).size < 20_000 && back !== null && diffGeo(g, back.geo) === null, `a compressible result is stored compressed (${fs.statSync(file).size} bytes for 262144 of pixels) and comes back bit for bit`);
    rewriteHeader(file, (h) => { const a = h.arrays.find((x: number[]) => x[2] > 0); a[1] += 2; });
    check((await store.load('z')) === null, 'a compressed array that unpacks to another size than its header says is a miss');
    // one that is too small to pay, or random, is stored as it is
    const px = new Float32Array(4096);
    randomFillSync(new Uint8Array(px.buffer));
    const r = new Geometry();
    r.volumes.push(new Image(64, 64, 'r', new Map([['C', px]])));
    await store.save('r', { geo: r, deps: [], warnings: [], cookMs: 1 });
    const rb = await store.load('r');
    check(rb !== null && diffGeo(r, rb.geo) === null, 'an array that does not shrink is stored raw and comes back');
  }
  {
    // the engine's identity is the code the process loaded: a process whose sources changed after it started keeps nothing
    const app = path.join(tmp, 'app');
    const stage = (dest: string) => {
      fs.mkdirSync(dest, { recursive: true });
      for (const d of ['src', 'kernels/pkg', 'kernels/pkg-simd', 'assets/fonts']) fs.cpSync(path.join(ROOT, d), path.join(dest, d), { recursive: true });
      fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dest, 'package.json'));
      fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dest, 'node_modules'), 'junction');
    };
    const lateSource = `
import fs from 'node:fs';
import './src/nodes/index.ts';
import { Engine } from './src/graph/engine.ts';
import { defineNode } from './src/graph/registry.ts';
import { Geometry } from './src/core/geometry.ts';
import { createNodeHost } from './src/host/node.ts';
const [, , cacheDir, dir] = process.argv;
defineNode({ type: 'slow_wait', category: 'test', summary: 'x', inputs: [], params: { ms: { type: 'int', default: 150, desc: 'ms' }, value: { type: 'float', default: 1, desc: 'v' } }, example: { type: 'slow_wait' },
  async cook({ p }) { await new Promise((r) => setTimeout(r, p.ms)); return new Geometry({ positions: [0, 0, 0, p.value, 0, 0, 0, p.value, 0], prims: [[0, 1, 2]] }); } });
const e = new Engine(createNodeHost({ baseDir: dir, nodeCache: { dir: cacheDir, minMs: 100 } }));
await e.init();
fs.writeFileSync(dir + '/ready', '1');
for (const [go, value] of [['go1', 1], ['go2', 2]] as const) {
  while (!fs.existsSync(dir + '/' + go)) await new Promise((r) => setTimeout(r, 30));
  const r = await e.cook({ nodes: { s: { type: 'slow_wait', params: { value } } }, output: 's' });
  console.log(JSON.stringify({ go, ok: r.ok }));
  fs.writeFileSync(dir + '/' + go + '.done', '1');
}
await e.host.pool?.close();
process.exit(0);
`;
    /** A child on a copy of the engine's sources; edit says when its sources change: before its first use of the store, between its two cooks, never. */
    const child = async (edit: 'before' | 'between' | 'never') => {
      const dest = path.join(app, edit), cache = path.join(dest, 'cache');
      stage(dest);
      fs.writeFileSync(path.join(dest, 'late.ts'), lateSource);
      await sleep(150);
      const p = spawn(process.execPath, [path.join(dest, 'late.ts'), cache, dest], { cwd: dest, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { out += d; });
      const exited = new Promise<void>((r) => p.on('close', () => r()));
      const until = async (f: string) => { for (let i = 0; i < 600 && !fs.existsSync(path.join(dest, f)); i++) await sleep(50); };
      const touch = (f: string) => fs.writeFileSync(path.join(dest, f), '1');
      const change = () => fs.appendFileSync(path.join(dest, 'src', 'core', 'random.ts'), '\n// changed after the process started\n');
      await until('ready');
      if (edit === 'before') { await sleep(60); change(); }
      touch('go1'); await until('go1.done');
      if (edit === 'between') { await sleep(60); change(); }
      touch('go2'); await until('go2.done');
      await exited;
      // the sources' libraries are the repository's own: only the link goes
      try { fs.rmdirSync(path.join(dest, 'node_modules')); } catch { fs.unlinkSync(path.join(dest, 'node_modules')); }
      return { out, files: entries(cache).length, memo: fs.existsSync(path.join(cache, 'engine.json')) };
    };
    const [before, between, never] = await Promise.all([child('before'), child('between'), child('never')]);
    check(never.files === 2 && never.memo, `a process whose sources did not change keeps both results (${never.files})`);
    const told = (o: string) => (o.match(/the disk cache is off for this process/g) ?? []).length;
    check(before.files === 0 && !before.memo && /"ok":true/.test(before.out), `sources changed after the process started, before its first use of the store: nothing kept, the cooks are fine (${before.files} files)`);
    check(between.files === 1 && /"ok":true/.test(between.out), `sources changed between two cooks: the first is kept, the second is not (${between.files} file)`);
    check(told(before.out) === 1 && told(between.out) === 1 && told(never.out) === 0, `a process that switches its cache off says so once on stderr, one that does not says nothing (${told(before.out)}, ${told(between.out)}, ${told(never.out)})`);
  }

  // ------------------------------------------------------------ the CLI and the MCP server, in processes of their own
  const run = (args: string[], env: Record<string, string> = {}, script = 'diskcache-cli.ts') => new Promise<{ code: number | null; out: string }>((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'test', script), ...args], { cwd: ROOT, env: { ...process.env, ...env } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
  const gfile = (name: string, g: GraphSpec) => { const f = path.join(tmp, name); fs.writeFileSync(f, JSON.stringify(g)); return f; };
  const ms = (out: string) => Number(/ in (\d+) ms/.exec(out)?.[1] ?? NaN);
  const summary = (out: string) => out.split('\n').filter((l) => /^(geometry|bbox|  point|  detail|  prim)/.test(l)).join('\n');
  const loaded = (out: string) => /^disk cache: 1 node loaded/m.test(out);
  // the processes are slow to start: each scenario runs on its own, all at once, while the sweep below runs in this process
  const scenarios: Promise<[unknown, string][]>[] = [];
  scenarios.push((async () => {
    const results: [unknown, string][] = [];
    const check = (ok: unknown, msg: string) => { results.push([ok, msg]); };
    const dir = folder();
    const env = { TOPOTOPO_NODE_CACHE_DIR: dir };
    const g = gfile('slow.json', slowGraph(700, 2));
    const cold = await run([g], env);
    check(cold.code === 0 && !loaded(cold.out) && ms(cold.out) >= 690 && entries(dir).length === 1, `CLI: a cook of a node of 0.7 s writes it (${ms(cold.out)} ms)`);
    const warm = await run([g], env);
    check(warm.code === 0 && loaded(warm.out) && ms(warm.out) < ms(cold.out) / 2 && summary(warm.out) === summary(cold.out) && summary(cold.out) !== '', `CLI: the second cook loads it and says so, much faster (${ms(cold.out)} ms, then ${ms(warm.out)} ms), with the same summary`);
    check(/\(cooked in \d/.test(warm.out), 'CLI: the report says how long the stored cook took');
    const timing = await run([g, '--timing'], env);
    check(loaded(timing.out), 'CLI: --timing says it too');
    const other = await run([gfile('slow3.json', slowGraph(700, 3))], env);
    check(other.code === 0 && !loaded(other.out) && ms(other.out) >= 690 && entries(dir).length === 2, 'CLI: a param change misses');
    const off = await run([g, '--no-cache'], env);
    check(off.code === 0 && !loaded(off.out) && ms(off.out) >= 690, 'CLI: --no-cache neither reads the cache');
    const vars = await run([gfile('slowvar.json', { vars: { v: 2 }, nodes: { s: { type: SLOW_NODE, params: { ms: 700, value: '=v' } }, n: { type: 'null', in: ['s'] } }, output: 'n' })], env);
    check(vars.code === 0 && loaded(vars.out), 'CLI: a param that is an expression is keyed by its value (the same result as the literal 2)');
    // damage from the outside
    for (const f of entries(dir)) fs.writeFileSync(path.join(dir, f), 'junk');
    const dmg = await run([g], env);
    const again = await run([g], env);
    check(dmg.code === 0 && !loaded(dmg.out) && summary(dmg.out) === summary(cold.out) && loaded(again.out) && summary(again.out) === summary(cold.out), 'CLI: a corrupt file is no error; it is cooked and written again');
    return results;
  })());
  scenarios.push((async () => {
    const results: [unknown, string][] = [];
    const check = (ok: unknown, msg: string) => { results.push([ok, msg]); };
    const dir = folder();
    const g = gfile('fast.json', slowGraph(150, 2));
    const a = await run([g], { TOPOTOPO_NODE_CACHE_DIR: dir });
    const b = await run([g], { TOPOTOPO_NODE_CACHE_DIR: dir });
    check(a.code === 0 && !fs.existsSync(dir) && !loaded(b.out), 'CLI: a node under 0.5 s writes nothing (no folder was even made)');
    return results;
  })());
  scenarios.push((async () => {
    const results: [unknown, string][] = [];
    const check = (ok: unknown, msg: string) => { results.push([ok, msg]); };
    const dir = folder();
    const g = gfile('slow-off.json', slowGraph(700, 2));
    const a = await run([g], { TOPOTOPO_NODE_CACHE_DIR: dir, TOPOTOPO_NODE_CACHE: 'off' });
    const b = await run([g], { TOPOTOPO_NODE_CACHE_DIR: dir, TOPOTOPO_NODE_CACHE: 'off' });
    check(a.code === 0 && b.code === 0 && !fs.existsSync(dir) && !loaded(b.out), 'CLI: TOPOTOPO_NODE_CACHE=off writes nothing and loads nothing');
    const c = await run([g], { TOPOTOPO_NODE_CACHE_DIR: dir });
    const d = await run([g], { TOPOTOPO_NODE_CACHE_DIR: dir, TOPOTOPO_NODE_CACHE: 'off' });
    check(entries(dir).length === 1 && !loaded(c.out) && !loaded(d.out), 'CLI: with the switch on again the cache works; off, it does not read what is there');
    return results;
  })());
  scenarios.push((async () => {
    const results: [unknown, string][] = [];
    const check = (ok: unknown, msg: string) => { results.push([ok, msg]); };
    // two processes cook the same node at once: both are right, one whole file is left
    const dir = folder();
    const env = { TOPOTOPO_NODE_CACHE_DIR: dir };
    const g = gfile('slow-par.json', slowGraph(700, 7));
    const [a, b] = await Promise.all([run([g], env), run([g], env)]);
    const c = await run([g], env);
    check(a.code === 0 && b.code === 0 && summary(a.out) === summary(b.out) && summary(a.out) !== '', 'two CLI runs at once on one cold cache both finish with the same result');
    check(entries(dir).length === 1 && leftovers(dir).length === 0 && loaded(c.out) && summary(c.out) === summary(a.out), 'and leave one whole file, which the next run loads');
    return results;
  })());
  scenarios.push((async () => {
    const results: [unknown, string][] = [];
    const check = (ok: unknown, msg: string) => { results.push([ok, msg]); };
    // the MCP server keeps results on disk too
    const dir = folder();
    const ws = fs.mkdtempSync(path.join(tmp, 'ws-'));
    const call = async () => {
      const t = new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'test', 'diskcache-mcp.ts'), '--package', ws], env: { ...getDefaultEnvironment(), TOPOTOPO_NODE_CACHE_DIR: dir }, stderr: 'pipe' });
      const c = new Client({ name: 'topotopo-test', version: '0.0.1' });
      await c.connect(t);
      try {
        const r: any = await c.callTool({ name: 'build', arguments: { graph: slowGraph(700, 2) } });
        return r.content.filter((x: any) => x.type === 'text').map((x: any) => x.text).join('\n') as string;
      } finally { await c.close(); }
    };
    const a = await call();
    const b = await call();
    check(entries(dir).length === 1 && !/disk cache/.test(a), 'MCP: the first build writes the slow node');
    check(/disk cache: 1 node loaded/.test(b) && /1 of them from the disk cache/.test(b), 'MCP: the next server loads it and the build report says so');
    return results;
  })());

  scenarios.push((async () => {
    // the case a slow node below a foreach whose body reads a file, in processes of their own: the file changes, the next run is fresh
    const results: [unknown, string][] = [];
    const check = (ok: unknown, msg: string) => { results.push([ok, msg]); };
    const dir = folder(), ws = fs.mkdtempSync(path.join(tmp, 'rep-'));
    const env = { TOPOTOPO_NODE_CACHE_DIR: dir };
    const obj = (x: number) => fs.writeFileSync(path.join(ws, 'm.obj'), `v 0 0 0\nv ${x} 0 0\nv 0 1 0\nf 1 2 3\n`);
    obj(1);
    const g = path.join(ws, 'g.json');
    fs.writeFileSync(g, JSON.stringify({ nodes: { each: { type: 'foreach', params: { mode: 'count', count: 1, body: { nodes: { f: { type: 'file', params: { path: 'm.obj' } } }, output: 'f' } } }, slow: { type: 'slow_pass', in: ['each'], params: { ms: 700 } } }, output: 'slow' }));
    const a = await run([g], env), b = await run([g], env);
    check(a.code === 0 && !loaded(a.out) && loaded(b.out) && summary(a.out) === summary(b.out) && /max \(1\.000/.test(a.out), 'CLI, slow node below a foreach whose body reads m.obj: the second run loads it');
    obj(5);
    fs.utimesSync(path.join(ws, 'm.obj'), new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    const c = await run([g], env), plain = await run([g, '--no-cache'], env);
    check(c.code === 0 && !loaded(c.out) && /max \(5\.000/.test(c.out) && summary(c.out) === summary(plain.out), 'CLI: after m.obj changed the next run is fresh (the new bbox, the one --no-cache gives), and does not say it loaded anything');
    return results;
  })());
  scenarios.push((async () => {
    // a font replaced at the same path
    const results: [unknown, string][] = [];
    const check = (ok: unknown, msg: string) => { results.push([ok, msg]); };
    const dir = folder(), ws = fs.mkdtempSync(path.join(tmp, 'font-'));
    const env = { TOPOTOPO_NODE_CACHE_DIR: dir };
    const font = path.join(ws, 'f.ttf');
    fs.writeFileSync(font, variableTestFont());
    const g = path.join(ws, 'g.json');
    fs.writeFileSync(g, JSON.stringify({ nodes: { t: { type: 'text', params: { text: 'I', font: 'f.ttf', size: 1 } }, slow: { type: 'slow_pass', in: ['t'], params: { ms: 700 } } }, output: 'slow' }));
    const a = await run([g], env), b = await run([g], env);
    check(a.code === 0 && summary(a.out) !== '' && loaded(b.out) && summary(a.out) === summary(b.out), 'CLI, slow node below a text node: the second run loads it');
    fs.copyFileSync(path.join(ROOT, 'assets', 'fonts', 'DejaVuSans.ttf'), font);
    fs.utimesSync(font, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    const c = await run([g], env), plain = await run([g, '--no-cache'], env);
    check(c.code === 0 && !loaded(c.out) && summary(c.out) === summary(plain.out) && summary(c.out) !== summary(a.out), 'CLI: with the font replaced at the same path the next run is fresh, not the stored result');
    return results;
  })());

  scenarios.push((async () => {
    // the same graph with the same name in two folders, each with an m.obj of its own: a node below a foreach has the same
    // signature in both, and must still be made from the files its own folder has
    const results: [unknown, string][] = [];
    const check = (ok: unknown, msg: string) => { results.push([ok, msg]); };
    const dir = folder();
    const env = { TOPOTOPO_NODE_CACHE_DIR: dir };
    const graph = JSON.stringify({ nodes: { each: { type: 'foreach', params: { mode: 'count', count: 1, body: { nodes: { f: { type: 'file', params: { path: 'm.obj' } } }, output: 'f' } } }, slow: { type: 'slow_pass', in: ['each'], params: { ms: 700 } } }, output: 'slow' });
    const obj = (x: number) => `v 0 0 0\nv ${x} 0 0\nv 0 1 0\nf 1 2 3\n`;
    const place = (name: string, x: number, at = new Date('2022-02-02T00:00:00Z')) => {
      const d = fs.mkdtempSync(path.join(tmp, `${name}-`));
      fs.writeFileSync(path.join(d, 'g.json'), graph);
      fs.writeFileSync(path.join(d, 'm.obj'), obj(x));
      fs.utimesSync(path.join(d, 'm.obj'), at, at);
      return d;
    };
    const A = place('a', 1), B = place('b', 5);
    const inA = await run([path.join(A, 'g.json')], env);
    const inB = await run([path.join(B, 'g.json')], env);
    const plainB = await run([path.join(B, 'g.json'), '--no-cache'], env);
    check(/max \(1\.000/.test(inA.out) && !loaded(inB.out) && /max \(5\.000/.test(inB.out) && summary(inB.out) === summary(plainB.out), 'CLI: the same graph in folder B (another m.obj, the same size and time) is not given the result made in folder A');
    const againA = await run([path.join(A, 'g.json')], env), againB = await run([path.join(B, 'g.json')], env);
    check(loaded(againA.out) && loaded(againB.out) && /max \(1\.000/.test(againA.out) && /max \(5\.000/.test(againB.out), 'CLI: and each folder then loads its own');
    // two files of identical content at different paths: results alike, each its own entry
    const C = place('c', 1), D = place('d', 1);
    const inC = await run([path.join(C, 'g.json')], env), inD = await run([path.join(D, 'g.json')], env);
    check(loaded(againA.out) && !loaded(inD.out) && summary(inC.out) === summary(inD.out), 'CLI: files with the same content at other paths give the same result, each kept apart');
    // one folder, the file swapped back and forth
    const E = place('e', 1);
    const gE = path.join(E.toString(), 'g.json');
    const put = (x: number, at: Date) => { fs.writeFileSync(path.join(E, 'm.obj'), obj(x)); fs.utimesSync(path.join(E, 'm.obj'), at, at); };
    const t1 = new Date('2022-03-03T00:00:00Z'), t2 = new Date('2022-04-04T00:00:00Z');
    put(1, t1);
    const e1 = await run([gE], env);
    put(5, t2);
    const e2 = await run([gE], env);
    put(1, t1);
    const e3 = await run([gE], env);
    check(/max \(1\.000/.test(e1.out) && /max \(5\.000/.test(e2.out) && /max \(1\.000/.test(e3.out) && !loaded(e2.out), 'CLI: one folder, m.obj swapped A, B, A: each run gives the result of the file in place');
    check(loaded(e3.out), 'CLI: and the third, with the first file back as it was, loads the first result');
    return results;
  })());

  // ------------------------------------------------------------ the sweep: every node of the catalogue
  {
    const { engine: off, tmp: ft } = await createFixtureEngine();
    const dir = folder();
    const cold = await engineWith(openNodeCache({ dir, minMs: 0, engine: 'sweep' })!, ft);
    openPackages(cold, ft);
    const warm = await engineWith(openNodeCache({ dir, minMs: 0, engine: 'sweep' })!, ft);
    openPackages(warm, ft);
    // the golden fingerprints (test/golden/node.<type>.json, made without any cache) are the oracle for the cold and warm cooks
    let cases = 0, loadedNodes = 0, offeredNodes = 0, firstBad = '';
    for (const def of allNodeDefs()) {
      if (SKIP.has(def.type) || !fs.existsSync(path.join(ROOT, 'test', 'golden', `node.${def.type}.json`))) continue;
      const g = fixtureGraphFor(def.type);
      const gold = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'golden', `node.${def.type}.json`), 'utf8'));
      const b = await cold.cook(g), c = await warm.cook(g);
      if (b.ok !== c.ok || b.ok !== gold.ok) firstBad ||= `${def.type}: cooks differ in success`;
      if (!b.ok || !c.ok || !b.geo || !c.geo) continue;
      cases++;
      if (!gold.env) {
        const fg = sortedJSON(gold.fingerprint), fb = sortedJSON(fingerprint(b.geo)), fc = sortedJSON(fingerprint(c.geo));
        if (fg !== fb || fg !== fc) firstBad ||= `${def.type}: fingerprints differ from the golden one`;
      }
      for (const [name, rb] of b.results) {
        const rc = c.results.get(name)!;
        if (rc.disk) loadedNodes++;
        if (rb.geo && rc.geo) {
          const d = diffGeo(rb.geo, rc.geo);
          if (d) firstBad ||= `${def.type}/${name}: ${d}`;
        }
        if (!rb.cached) offeredNodes++;
      }
    }
    check(cases > 100 && !firstBad, `${cases} node fixtures cook cold and warm as the golden fingerprints say, every node result bit for bit the same${firstBad ? ` (${firstBad})` : ''}`);
    check(loadedNodes > 100, `and the warm cooks loaded ${loadedNodes} node results from disk (of ${offeredNodes} cooked)`);
    // a geometry, an image and a heightfield result by name
    for (const [type, kind] of [['boolean', 'geometry'], ['tex_noise', 'image'], ['heightfield_noise', 'heightfield']] as const) {
      const g = fixtureGraphFor(type);
      const a = await off.cook(g), c = await warm.cook(g);
      const vol = c.geo?.volumes.map((v) => v.kind).join() ?? '';
      check(a.ok && c.ok && sortedJSON(fingerprint(a.geo!)) === sortedJSON(fingerprint(c.geo!)) && (kind === 'geometry' ? vol === '' : vol === kind), `a ${kind} result (${type}): the same fingerprint cooked without the cache and loaded from it`);
    }
  }

  for (const list of await Promise.all(scenarios)) for (const [ok, msg] of list) check(ok, msg);

  // ------------------------------------------------------------ no test writes to the real cache folder
  {
    const covered = (src: string) => /cache-guard\.ts|fixtures\.ts/.test(src);
    // any process a test starts may cook: the web app bakes packages through the CLI, a launcher runs it, and so on
    const starts = (src: string) => /(spawn|spawnSync|execFile|execFileSync|StdioClientTransport|fork)\b/.test(src);
    const bad: string[] = [];
    for (const f of fs.readdirSync(path.join(ROOT, 'test')).filter((x) => x.endsWith('.ts'))) {
      const src = fs.readFileSync(path.join(ROOT, 'test', f), 'utf8');
      if (starts(src) && !covered(src) && !['diskcache.ts'].includes(f)) bad.push(f);
    }
    check(bad.length === 0, `every test that starts a process imports the cache guard${bad.length ? ` (not: ${bad.join(', ')})` : ''}`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

// ---- a PNG by hand, for the file tests
function chunk(type: string, data: Buffer) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(zlib.crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
