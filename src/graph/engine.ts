// Graph evaluation: validation, lazy pull-based cooking, content-addressed caching, time.
//
// Every node result is keyed by a signature = hash(type, resolved params, input
// signatures[, the vars its code reads][, expression references][, the node's name, for a node that names its result
// after itself: NodeDef.usesNodeName]). Editing one parameter therefore re-cooks
// only the nodes downstream of it, and identical sub-results (e.g. loop iterations) are shared. "=expr" params
// are keyed by their values; code reads vars by their bare name, so a code node is keyed by the vars its code
// names (NodeDef.usesVars), and changing another var leaves it cached.
//
// Time: a cook happens at a frame (frame 1 = time 0). A node is time-dependent when its def says so
// (usesTime), when one of its "=expr" params reads frame/time/fps/timeInc, or when its cook reads
// ctx.frame/ctx.time/ctx.fps/ctx.timeInc (wrangle @Frame, script lib.frame, a time-dependent nested
// body). Only then is the time mixed into its signature, so everything else stays cached across
// frames. Dependence discovered while cooking is remembered per base signature (timeDeps), so the
// next cook looks the time-mixed key up directly.
//
// Expression references: npoints("n"), bbox("n"), point("n", i, "P"), ch("n/param") … in "=expr"
// params are found by a static scan before cooking. Referenced nodes are hidden dependencies: they
// are validated (unknown names, cycles), cooked before the param is resolved, and their signatures
// (or, for ch(), the referenced value) are mixed into the dependent node's signature.
//
// Scopes (src/graph/scope.ts): a cook runs in a scope, which gives it its node types, the graphs graph_ref reads and
// the files nodes read; nested cooks inherit it. The cache is shared by all scopes: outside the root scope, a node
// whose result depends on its scope has the scope's id in its signature. It depends on it when it reads it: its
// signatureExtra reads the scope it is given (a file's stamp), or its cook reads ctx.scope or cooks a nested graph in
// it (ctx.subcook without a scope of its own). That is found as time dependence is, and remembered per signature
// (scopeDeps); NodeDef.usesScope says it up front. A node type with a slash is a package output
// (src/graph/packages.ts), which only the scope's packages resolve.
//
// Concurrency: when the host has a worker pool (Engine.concurrent), the inputs of a node (and the nodes its
// expressions reference) are pulled at once, so independent branches overlap wherever a cook awaits (a chunked
// kernel on the pool, file I/O). Cooks of one signature that are in flight at the same time share one cook
// (Engine.inflight). The report is then put in the order a one-at-a-time cook produces, without the nodes such a
// cook would not have reached (it stops at the first failed input), so results, errors and warnings do not depend
// on the pool. Without a pool everything is pulled one input at a time, as before.
import { Geometry, isGeometry } from '../core/geometry.ts';
import { DEFAULT_TRANSFER, expandPacked } from '../core/packed.ts';
import { primIntrinsic } from '../core/intrinsics.ts';
import { splinesToPolylines } from '../core/splines.ts';
import { hashString } from '../core/random.ts';
import type { Host, StopSignal } from '../host/types.ts';
import { targetError } from '../io/targets.ts';
import { allAliases, getNodeDef } from './registry.ts';
import {
  DeferredExpr, REF_FUNCS, didYouMean, hasRefs, resolveParamName, resolveParams, scanNodeRefs, scanValue, vecOut,
} from './params.ts';
import type { ExprRefs, ResolvedParams, TimeState } from './params.ts';
import { outputFieldIssues } from './outputs.ts';
import { parallelMap as runKernel } from './parallel.ts';
import type { PoolStats } from './parallel.ts';
import { parsePackageName, scopeSig } from './scope.ts';
import type { AssetEntry, PackageIssue, PackageResolver, Scope } from './scope.ts';
import { NodeError, STOPPED } from './types.ts';
import type { CookContext, GraphSpec, InputDef, NodeDef, NodeSpec, ParamDef } from './types.ts';
import { VAR_NAME_HINT, varNameError } from './vars.ts';
import { codeVarNames, pickVars } from '../core/usercode.ts';

export type { TimeState } from './params.ts';

export interface Issue { node: string; message: string; hint?: string }

export interface NodeResult {
  node: string;
  geo: Geometry | null;
  sig: string;
  ms: number;
  cached: boolean;
  error?: Issue;
  /** true when the failure happened upstream */
  upstream?: boolean;
  warnings: string[];
  /** the result changes with the cook time (directly, or through its inputs/references in this graph) */
  timeDependent: boolean;
  /** numbers recorded by the node while cooking (e.g. solver steps); absent on cache hits */
  stats?: Record<string, number>;
}

export interface CookReport {
  ok: boolean;
  target: string;
  geo: Geometry | null;
  results: Map<string, NodeResult>;
  errors: Issue[];
  warnings: Issue[];
  notes: string[];
  ms: number;
  /** the time this cook ran at */
  frame: number;
  time: number;
  fps: number;
  /** the target's result depends on time (other than through subgraph inputs) */
  timeDependent: boolean;
  /** the cook was stopped (CookOptions.signal): the node it stopped at */
  stopped?: string;
}

export { STOPPED };

/**
 * A node starting or ending its cook, for CookOptions.onNode (cache hits are not reported), and the steps of a long
 * node between them (ctx.checkpoint: "step", where the host may yield; nothing else to report).
 */
export interface NodeProgress {
  phase: 'start' | 'step' | 'end';
  node: string;
  type: string;
  /** 0 for the graph's own nodes; nested cooks (assets, foreach, solver, graph_ref) report theirs deeper */
  depth: number;
  /** the enclosing nodes of a nested cook, outermost first ([] at depth 0) */
  within: readonly string[];
  /** end: the node's cook time in ms */
  ms?: number;
  /** end: its error, when it failed or was stopped */
  error?: string;
}

export type { StopSignal };

export interface SubInput { geo: Geometry; sig: string }

export interface CookOptions {
  target?: string;
  vars?: Record<string, any>;
  inputs?: SubInput[];
  /**
   * The scope to cook in (src/graph/scope.ts): node types, the graphs graph_ref reads and the files nodes read.
   * Default: the engine's root scope. Nested cooks (subcook, inputAt) inherit it.
   */
  scope?: Scope;
  depth?: number;
  /** frame to cook at (default 1). frame 1 = time 0; frame = time * fps + 1 when only time is given */
  frame?: number;
  /** time in seconds (default derived from frame) */
  time?: number;
  /** frames per second (default 24) */
  fps?: number;
  /** time step in seconds (default 1 / fps; the solver passes 1 / (fps * substeps)) */
  timeInc?: number;
  /**
   * Internal: signatures being cooked by the enclosing nodes of a nested cook (subcook, inputAt). A cook does not wait
   * for an in-flight cook of the same signature when that cook is one of its ancestors (a recursive asset).
   */
  ancestors?: ReadonlySet<string>;
  /**
   * Progress: called when a node starts cooking and when it ends (cache hits are not reported), for the graph's own
   * nodes and for those of nested cooks. A promise returned for a start is awaited before the node cooks: a host
   * yields to its event loop there, so it can serve requests (a stop among them) while a long cook runs.
   */
  onNode?: (ev: NodeProgress) => void | Promise<void>;
  /**
   * Stop: once `aborted` is true the cook stops at the next node boundary. The node about to cook fails with STOPPED,
   * the nodes downstream fail as upstream errors, and the report's `stopped` names the node. A node already cooking
   * runs to its end unless it reads ctx.signal itself. Nested cooks (subcook, inputAt) share the signal.
   */
  signal?: StopSignal;
  /** Internal: the enclosing nodes of a nested cook (NodeProgress.within). */
  within?: readonly string[];
}

/** Frame range for cookFrames (end inclusive). */
export interface FrameRange { start: number; end: number; step?: number }

// ---------------------------------------------------------------- cache

function geoBytes(g: Geometry): number {
  let b = g.primStart.byteLength + g.vertexPoint.byteLength + g.primClosed.byteLength + 256;
  // packed: the per-prim arrays (sources are shared with the nodes that made them)
  if (g.primKind) b += g.primKind.byteLength + g.packedSource!.byteLength + g.packedXform!.byteLength;
  for (const t of [g.points, g.vertices, g.prims, g.detail])
    for (const a of t.map.values()) b += a.bytes();
  for (const m of g.pointGroups.values()) b += m.byteLength;
  for (const m of g.primGroups.values()) b += m.byteLength;
  return b;
}

class GeoCache {
  private map = new Map<string, { geo: Geometry; bytes: number }>();
  private bytes = 0;
  maxBytes: number;
  constructor(maxBytes = 1.5e9) { this.maxBytes = maxBytes; }
  get(k: string) {
    const e = this.map.get(k);
    if (!e) return undefined;
    this.map.delete(k);
    this.map.set(k, e); // LRU bump
    return e.geo;
  }
  set(k: string, geo: Geometry) {
    if (this.map.has(k)) return;
    const bytes = geoBytes(geo);
    if (bytes > this.maxBytes / 2) return;
    this.map.set(k, { geo, bytes });
    this.bytes += bytes;
    for (const [key, e] of this.map) {
      if (this.bytes <= this.maxBytes) break;
      this.map.delete(key);
      this.bytes -= e.bytes;
    }
  }
  clear() { this.map.clear(); this.bytes = 0; }
  get stats() { return { entries: this.map.size, mb: +(this.bytes / 1e6).toFixed(1) }; }
}

// ---------------------------------------------------------------- helpers

export function stableStringify(v: any): string {
  if (v === undefined) return 'u';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (ArrayBuffer.isView(v)) return '[' + Array.from(v as any).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

const now = () => (globalThis.performance ?? Date).now();
const r9 = (x: number) => Math.round(x * 1e9) / 1e9;

/** Resolve frame/time/fps/timeInc from cook options. frame 1 ↔ time 0 (Houdini convention). */
export function resolveTime(o: { frame?: number; time?: number; fps?: number; timeInc?: number } = {}): TimeState {
  const num = (k: string, v: any) => {
    if (v === undefined || v === null) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`${k} must be a finite number, got ${JSON.stringify(v)}`);
    return n;
  };
  const fps = num('fps', o.fps) ?? 24;
  if (!(fps > 0)) throw new Error(`fps must be > 0, got ${fps}`);
  const f = num('frame', o.frame), t = num('time', o.time), inc = num('timeInc', o.timeInc);
  const frame = f ?? (t !== undefined ? r9(t * fps + 1) : 1);
  const time = t ?? r9((frame - 1) / fps);
  return { frame, time, fps, timeInc: inc !== undefined && inc > 0 ? inc : 1 / fps };
}

const timeKey = (t: TimeState) => `T:${t.frame}:${t.time}:${t.fps}:${t.timeInc}`;

/**
 * A scope that calls `read` when what it holds is read: its assets, graphs, files or packages (what a node is given, in
 * signatureExtra and as CookContext.scope: Engine.scopeDeps). Its id alone does not count: a node that reads it keys
 * its result by it itself.
 */
const watchScope = (s: Scope, read: () => void): Scope => ({
  get id() { return s.id; },
  get assets() { read(); return s.assets; },
  get graphs() { read(); return s.graphs; },
  get files() { read(); return s.files; },
  get packages() { read(); return s.packages; },
});

/** Normalise `in` wiring into an ordered list of node names (null = unconnected). */
export function wiringOf(spec: NodeSpec, def: NodeDef): { list: (string | null)[]; errors: string[] } {
  const errors: string[] = [];
  const raw = spec.in;
  if (raw === undefined || raw === null) return { list: [], errors };
  if (typeof raw === 'string') return { list: [raw], errors };
  if (Array.isArray(raw)) return { list: raw.map((x) => (x === undefined ? null : x)), errors };
  if (typeof raw === 'object') {
    const list: (string | null)[] = [];
    for (const [k, v] of Object.entries(raw)) {
      let idx = /^\d+$/.test(k) ? +k : def.inputs.findIndex((i) => i.name.toLowerCase() === k.toLowerCase());
      if (idx < 0) {
        errors.push(`unknown input "${k}". Inputs: ${def.inputs.map((i, n) => `${n}:${i.name}`).join(', ') || '(none)'}`);
        continue;
      }
      list[idx] = v;
    }
    for (let i = 0; i < list.length; i++) if (list[i] === undefined) list[i] = null;
    return { list, errors };
  }
  return { list: [], errors: ['"in" must be a node name, an array of names, or {inputName: node}'] };
}

function inferParamType(meta: any, v: any): ParamDef['type'] {
  if (meta?.type) return meta.type;
  if (Array.isArray(meta?.options) && meta.options.length) return 'enum';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return 'float';
  if (typeof v === 'string') return 'string';
  if (Array.isArray(v) && v.every((x) => typeof x === 'number')) {
    if (v.length === 2) return 'vec2';
    if (v.length === 3) return 'vec3';
    if (v.length === 4) return 'vec4';
  }
  return 'json';
}

/**
 * A graph as a node type (an asset, a package output): its vars are the params, with their "params" declarations, and
 * its input nodes the inputs, by their index.
 */
export function graphInterface(graph: GraphSpec): { params: Record<string, ParamDef>; inputs: InputDef[] } {
  const params: Record<string, ParamDef> = {};
  for (const [k, v] of Object.entries(graph.vars ?? {})) {
    const meta = graph.params?.[k] ?? {};
    params[k] = {
      type: inferParamType(meta, v), default: v, desc: meta.desc ?? '',
      min: meta.min, max: meta.max, options: meta.options,
    };
  }
  let nIn = 0;
  const inputDescs: string[] = [];
  for (const n of Object.values(graph.nodes)) {
    if (typeof n?.type === 'string' && getNodeDef(n.type)?.type === 'input') {
      const idx = Number(n.params?.index ?? 0);
      nIn = Math.max(nIn, idx + 1);
      inputDescs[idx] = n.params?.label ?? n.note ?? '';
    }
  }
  return { params, inputs: Array.from({ length: nIn }, (_, i) => ({ name: `input${i}`, desc: inputDescs[i] || `subgraph input ${i}`, optional: true })) };
}

type ChParams = Map<string, { def: NodeDef; values: Record<string, any> }>;

/** Implementations of the expression reference functions, bound to the referenced results of one node. */
function refFunctions(geo: Map<string, Geometry>, chp: ChParams): Record<string, (...a: any[]) => any> {
  const G = (fn: string, n: any): Geometry => {
    const g = typeof n === 'string' ? geo.get(n) : undefined;
    if (!g) throw new Error(`${fn}(${JSON.stringify(n)}): the node must be named by a string literal in the expression (dynamic names are not supported)`);
    return g;
  };
  const out = (v: any) => (Array.isArray(v) ? vecOut(v.slice()) : v);
  const comp = (v: any, c: any, call: string) => {
    if (c === undefined) return out(v);
    if (!Array.isArray(v)) throw new Error(`${call} is not a vector; drop the component index`);
    if (!(Number.isInteger(c) && c >= 0 && c < v.length)) throw new Error(`${call}: component ${c} out of range 0..${v.length - 1}`);
    return v[c];
  };
  const elem = (fn: string, cls: 'point' | 'prim', n: any, i: any, attr: any, c: any) => {
    const g = G(fn, n);
    const call = `${fn}("${n}", ${i}, ${JSON.stringify(attr)})`;
    const count = cls === 'point' ? g.numPoints : g.numPrims;
    if (!Number.isInteger(i) || i < 0 || i >= count) throw new Error(`${call}: index out of range ("${n}" has ${count} ${cls}s)`);
    if (typeof attr !== 'string') throw new Error(`${call}: the attribute name must be a string`);
    const a = g.table(cls).get(attr);
    if (a) return comp(a.get(i), c, call);
    if (cls === 'prim' && attr === 'P') {
      // prim P without a prim attribute = centroid of the prim's points (as in wrangles)
      const pts = g.primPoints(i), P = g.P, s = [0, 0, 0];
      for (const p of pts) for (let k = 0; k < 3; k++) s[k] += P[p * 3 + k];
      return comp(s.map((x) => (pts.length ? x / pts.length : 0)), c, call);
    }
    throw new Error(`${call}: no ${cls} attribute "${attr}" (${cls} attributes: ${g.table(cls).names().join(', ') || 'none'})`);
  };
  return {
    npoints: (n) => G('npoints', n).numPoints,
    nprims: (n) => G('nprims', n).numPrims,
    nvertices: (n) => G('nvertices', n).numVertices,
    bbox: (n) => {
      const b = G('bbox', n).bbox(true);
      return {
        min: vecOut([...b.min]), max: vecOut([...b.max]),
        size: vecOut([0, 1, 2].map((k) => b.max[k] - b.min[k])),
        center: vecOut([0, 1, 2].map((k) => (b.max[k] + b.min[k]) / 2)),
        empty: b.empty,
      };
    },
    centroid: (n) => {
      const g = G('centroid', n), P = g.P, np = g.numPoints, s = [0, 0, 0];
      for (let i = 0; i < np; i++) for (let k = 0; k < 3; k++) s[k] += P[i * 3 + k];
      return vecOut(s.map((x) => (np ? x / np : 0)));
    },
    detail: (n, attr, c) => {
      const g = G('detail', n);
      const call = `detail("${n}", ${JSON.stringify(attr)})`;
      const a = typeof attr === 'string' ? g.detail.get(attr) : undefined;
      if (!a) throw new Error(`${call}: no detail attribute "${attr}" (detail attributes: ${g.detail.names().join(', ') || 'none'})`);
      return comp(a.get(0), c, call);
    },
    point: (n, i, attr, c) => elem('point', 'point', n, i, attr, c),
    prim: (n, i, attr, c) => elem('prim', 'prim', n, i, attr, c),
    primintrinsic: (n, i, name, c) => {
      const g = G('primintrinsic', n);
      const call = `primintrinsic("${n}", ${i}, ${JSON.stringify(name)})`;
      if (typeof name !== 'string') throw new Error(`${call}: the intrinsic name must be a string`);
      let v: number | string | number[];
      try { v = primIntrinsic(g, i, name); } catch (e: any) { throw new Error(`${call}: ${e.message}`); }
      return comp(v, c, call);
    },
    ch: (a, b) => {
      let node = a, param = b;
      if (b === undefined && typeof a === 'string') {
        const k = a.lastIndexOf('/');
        node = a.slice(0, k);
        param = a.slice(k + 1);
      }
      const e = typeof node === 'string' ? chp.get(node) : undefined;
      if (!e) throw new Error(`ch(${JSON.stringify(a)}${b === undefined ? '' : ', ' + JSON.stringify(b)}): node and param must be string literals (dynamic names are not supported)`);
      const pn = resolveParamName(e.def, String(param));
      if (!pn) throw new Error(`ch("${node}/${param}"): "${e.def.type}" has no param "${param}"`);
      const v = e.values[pn];
      if (v === null || typeof v !== 'object') return v;
      return Array.isArray(v) ? vecOut(structuredClone(v)) : structuredClone(v);
    },
  };
}

/** Per-node resolved params plus what their expressions referenced. */
interface NodeParams {
  rp: ResolvedParams;
  /** signature material from expression references ('' when there are none) */
  refSig: string;
  /** an expression read frame/time/fps/timeInc (directly, or in a param read with ch()) */
  usesTime: boolean;
  /** referenced geometry or params change with time */
  depsTimeDependent: boolean;
  error?: string;
  upstream?: boolean;
}

/** State of one graph cook (one frame, one level of nesting). */
interface CookSession {
  graph: GraphSpec;
  vars: Record<string, any>;
  opts: CookOptions;
  scope: Scope;
  time: TimeState;
  depth: number;
  report: CookReport;
  pull: (n: string) => Promise<NodeResult>;
  paramsOf: (n: string) => Promise<NodeParams>;
  /** node pulls and param resolutions started in this session */
  memo: Map<string, Promise<NodeResult>>;
  pmemo: Map<string, Promise<NodeParams>>;
  /** resolved params by node (for putting a concurrent report in order) */
  pdone: Map<string, NodeParams>;
  /** results that shared another result's in-flight cook */
  shared: { leader: NodeResult; waiter: NodeResult }[];
}

/** What an in-flight cook hands to the cooks that wait for it. */
interface Flight {
  done: Promise<{ geo: Geometry | null; sig: string; timeDep: boolean; failed: boolean }>;
  result: NodeResult;
}

const PSUF = '\u0000params';

// ---------------------------------------------------------------- engine

export class Engine {
  host: Host;
  cache = new GeoCache();
  /** the project's scope: the assets, graphs and files of every cook that is not given another (CookOptions.scope) */
  readonly root: Scope;
  /** base signatures of nodes found to depend on time while cooking */
  timeDeps = new Set<string>();
  /** signatures (without the scope) of nodes found to read their scope: their results are keyed by the scope's id */
  scopeDeps = new Set<string>();
  /** manifold-3d wasm module, loaded by init() */
  manifold: any = null;
  maxDepth = 24;
  scriptTimeoutMs = 30000;
  /**
   * Wall-clock limit of one cook of a long-running node (rbd_settle, rbd_stack, drape, inflate, particles,
   * heightfield_erode, remesh_quad): past it the node fails with an error that names it (src/nodes/util.ts
   * simBudget). Generous by default; the MCP server reads TOPOTOPO_SIM_TIMEOUT_MS.
   */
  simTimeoutMs = 600000;
  /** pull the inputs of a node concurrently (default: when the host has a worker pool) */
  concurrent: boolean;
  /** CookContext.parallelMap usage: jobs run on the pool / on the cooking thread, chunks dispatched */
  poolStats: PoolStats = { parallel: 0, serial: 0, chunks: 0 };
  /** cooks in progress by signature: a second cook of the same signature waits for the first */
  private inflight = new Map<string, Flight>();

  constructor(host: Host) {
    this.host = host;
    this.root = { id: '', assets: new Map(), files: host };
    this.concurrent = !!host.pool && host.pool.size > 0;
  }

  async init() {
    if (!this.manifold) {
      const { loadManifold } = await import('../core/manifold.ts');
      this.manifold = await loadManifold();
      const { MeshoptSimplifier } = await import('meshoptimizer');
      await MeshoptSimplifier.ready;
    }
  }

  /**
   * A node type in a scope: its own assets, then the built-in nodes. A name with a slash is a package output, which
   * only the scope's packages resolve (packageIssue says why one does not).
   */
  resolveDef(type: string, scope: Scope = this.root): NodeDef | undefined {
    if (typeof type !== 'string') return undefined;
    if (type.includes('/')) {
      const r = scope.packages?.resolve(type);
      return r && !('error' in r) ? r : undefined;
    }
    const a = this.asset(type, scope);
    if (a) return a.def;
    return getNodeDef(type);
  }

  /** Why a name with a slash names no node type in a scope: a package the scope does not use, an unknown output … */
  packageIssue(type: string, scope: Scope = this.root): PackageIssue {
    const r = scope.packages?.resolve(type);
    if (r && 'error' in r) return r;
    const n = parsePackageName(type);
    if (typeof n === 'string') return { error: n };
    return { error: `"${type}" is an output of package ${n.package}, and this cook has no packages`, hint: 'packages are used by projects (project.json "uses"), cooked by the TopoTopo CLI, viewer or MCP server' };
  }

  /**
   * The names a did-you-mean offers in a scope: node types and their aliases, its assets, the package outputs it uses,
   * and those its packages offer (PackageResolver.offered), which a graph's first use adds.
   */
  allTypeNames(scope: Scope = this.root): string[] {
    return [...allAliases(), ...this.assetsIn(scope).map((a) => a.name), ...(scope.packages?.names() ?? []), ...(scope.packages?.offered?.() ?? []).map((d) => d.type)];
  }

  /**
   * The node types of package outputs for the catalog and help: those a scope uses, then those its packages offer that
   * it does not use yet (PackageResolver.offered: TopoTopo's own, which a graph's first use adds).
   */
  packageDefs(scope: Scope = this.root): NodeDef[] {
    const used = (scope.packages?.names() ?? []).map((n) => this.resolveDef(n, scope)).filter((d): d is NodeDef => !!d);
    const have = new Set(used.map((d) => d.type));
    return [...used, ...(scope.packages?.offered?.() ?? []).filter((d) => !have.has(d.type))];
  }

  /**
   * A scope for cooks of its own (CookOptions.scope): its id (not "", which is the root's), the folder its relative
   * paths read (absolute, or relative to the host's own; default: the host's files), the graphs graph_ref reads in it
   * and the package outputs its graphs name. Register its assets with registerAsset(name, graph, {scope}), or give it
   * another scope's (`assets`: a scope like that one with other packages).
   */
  createScope(id: string, opts: { folder?: string; graphs?: (name: string) => GraphSpec | undefined; packages?: PackageResolver; assets?: Map<string, AssetEntry> } = {}): Scope {
    if (!id) throw new Error('a scope needs an id ("" is the root scope\'s)');
    if (opts.folder !== undefined && !this.host.filesAt) throw new Error(`scope "${id}": the ${this.host.name} host has no file access for other folders (Host.filesAt)`);
    return { id, assets: opts.assets ?? new Map(), graphs: opts.graphs, files: opts.folder === undefined ? this.host : this.host.filesAt!(opts.folder), packages: opts.packages };
  }

  // ------------------------------------------------------------ assets

  /** The asset a name refers to in a scope: one of the scope's own. */
  asset(name: string, scope: Scope = this.root): AssetEntry | undefined {
    return scope.assets.get(name);
  }

  /** The assets a scope has, in the order they were registered. */
  assetsIn(scope: Scope = this.root): AssetEntry[] {
    return [...scope.assets.values()];
  }

  /** Register a graph as a node type, an asset of a scope (default: the root). The graph is validated in that scope. */
  registerAsset(name: string, graph: GraphSpec, opts: { scope?: Scope } = {}): NodeDef {
    if (!/^[A-Za-z_][\w]*$/.test(name)) throw new Error(`asset name must be an identifier, got "${name}"`);
    const scope = opts.scope ?? this.root;
    if (getNodeDef(name) && !this.asset(name, scope)) throw new Error(`"${name}" clashes with a built-in node type`);
    const issues = this.validate(graph, '', scope);
    if (issues.errors.length) throw new Error(`asset graph invalid: ${issues.errors.map((e) => `${e.node}: ${e.message}`).join('; ')}`);
    const hash = String(hashString(stableStringify(graph)));
    const { params, inputs } = graphInterface(graph);
    const def: NodeDef = {
      type: name,
      category: 'asset',
      summary: graph.description ?? `user asset "${name}"`,
      inputs,
      params,
      // the graph's node types resolve in the scope the asset cooks in
      usesScope: true,
      signatureExtra: () => hash,
      // the asset's own nodes unpack what they need
      packed: 'keep',
      async cook(ctx) {
        const r = await ctx.subcook(graph, {
          vars: ctx.p,
          inputs: ctx.inputs.map((g, i) => ({ geo: g ?? new Geometry(), sig: ctx.inputSigs[i] ?? 'none' })),
        });
        for (const w of r.warnings) ctx.warn(`[${w.node}] ${w.message}`);
        if (!r.ok || !r.geo) throw new NodeError(`asset "${name}" failed: ${r.errors.map((e) => `${e.node}: ${e.message}`).join('; ')}`);
        return r.geo;
      },
    };
    // results of other graphs (and assets) that used the previous definition are cached under unchanged keys
    const prev = this.asset(name, scope);
    if (prev && prev.hash !== hash) this.cache.clear();
    scope.assets.set(name, { name, graph, def, hash });
    return def;
  }

  // ------------------------------------------------------------ validation

  findOutput(graph: GraphSpec, scope: Scope = this.root): { name: string; note?: string } {
    const names = Object.keys(graph.nodes ?? {});
    if (graph.output && graph.nodes[graph.output]) return { name: graph.output };
    const named = names.find((n) => /^(out|output)$/i.test(n));
    if (named) return { name: named };
    const referenced = new Set<string>();
    for (const n of names) {
      const def = this.resolveDef(graph.nodes[n].type, scope);
      if (!def) continue;
      for (const r of wiringOf(graph.nodes[n], def).list) if (r) referenced.add(r);
      // nodes only read by expressions (npoints("x"), ch("x/p")) are not end nodes either
      const refs = scanNodeRefs(def, graph.nodes[n].params);
      for (const r of refs.geo) referenced.add(r);
      for (const c of refs.ch) referenced.add(c.node);
    }
    const leaves = names.filter((n) => !referenced.has(n));
    const pick = leaves.length ? leaves[leaves.length - 1] : names[names.length - 1];
    return {
      name: pick,
      note: leaves.length > 1 ? `several end nodes (${leaves.join(', ')}); displaying "${pick}". Set "output" or merge them.` : undefined,
    };
  }

  validate(graph: GraphSpec, path = '', scope: Scope = this.root): { errors: Issue[]; warnings: Issue[] } {
    const errors: Issue[] = [], warnings: Issue[] = [];
    if (!graph || typeof graph !== 'object' || !graph.nodes || typeof graph.nodes !== 'object' || Array.isArray(graph.nodes)) {
      errors.push({ node: path || '(graph)', message: 'graph must be {"nodes": {"name": {"type": ..., "in": [...], "params": {...}}}, "output": "name"}' });
      return { errors, warnings };
    }
    const names = Object.keys(graph.nodes);
    if (graph.outputs !== undefined) {
      if (!graph.outputs || typeof graph.outputs !== 'object' || Array.isArray(graph.outputs))
        errors.push({ node: path || '(graph)', message: 'outputs must be a map of names to {node, label?}' });
      else for (const [id, out] of Object.entries(graph.outputs)) {
        if (!id || !out || typeof out !== 'object' || typeof out.node !== 'string' || !Object.hasOwn(graph.nodes, out.node) || (out.label !== undefined && typeof out.label !== 'string'))
          errors.push({ node: path || '(graph)', message: `named output "${id}" must reference an existing node and have an optional string label` });
        else if (out.export !== undefined && targetError(out.export))
          errors.push({ node: path || '(graph)', message: `named output "${id}": ${targetError(out.export)}` });
        else if (out.publish !== undefined && typeof out.publish !== 'boolean')
          errors.push({ node: path || '(graph)', message: `named output "${id}": "publish" must be true or false (false keeps it out of the project's package), got ${JSON.stringify(out.publish)}` });
        else for (const i of outputFieldIssues(out)) errors.push({ node: path || '(graph)', message: `named output "${id}": ${i.message}`, hint: i.hint });
      }
    }
    if (graph.export !== undefined && targetError(graph.export))
      errors.push({ node: path || '(graph)', message: targetError(graph.export)! });
    if (!names.length) errors.push({ node: path || '(graph)', message: 'graph has no nodes' });
    if (graph.output && !graph.nodes[graph.output])
      errors.push({ node: path || '(graph)', message: `output "${graph.output}" is not a node`, hint: didYouMean(graph.output, names).join(', ') });
    if (graph.version !== undefined && !(Number.isInteger(graph.version) && graph.version >= 0))
      errors.push({ node: path || '(graph)', message: `"version" must be a non-negative integer, got ${JSON.stringify(graph.version)}` });
    if (graph.vars && typeof graph.vars === 'object') {
      for (const [k, v] of Object.entries(graph.vars)) {
        const r = scanValue(v);
        if (r.geo.length || r.ch.length || r.errors.length)
          errors.push({
            node: path + '(vars)',
            message: `var "${k}" uses a node reference function (${REF_FUNCS.join(', ')}); vars are graph constants and cannot read nodes`,
            hint: `put the expression in the node param that needs it, e.g. "height": "=bbox('base').size.y"`,
          });
      }
    }
    // var names: expressions and code read vars by their bare name
    const declared = new Set<string>();
    for (const o of [graph.vars, graph.params]) if (o && typeof o === 'object' && !Array.isArray(o)) for (const k of Object.keys(o)) declared.add(k);
    for (const k of declared) {
      const bad = varNameError(k);
      if (bad) errors.push({ node: path + '(vars)', message: bad, hint: VAR_NAME_HINT });
    }
    if (graph.params && typeof graph.params === 'object') {
      for (const [k, vd] of Object.entries(graph.params)) {
        const o = vd && typeof vd === 'object' ? (vd as any).options : undefined;
        if (o !== undefined && !(Array.isArray(o) && o.length && o.every((x: any) => typeof x === 'string' || (typeof x === 'number' && Number.isFinite(x)))))
          errors.push({ node: path + '(params)', message: `params "${k}": options must be a list of strings or numbers, got ${JSON.stringify(o)?.slice(0, 80)}` });
      }
    }
    // for did-you-mean, listed once a type is unknown (the package names load the scope's packages)
    let typeNames: string[] | null = null;
    const refsOf = new Map<string, ExprRefs>();
    for (const name of names) {
      const spec = graph.nodes[name];
      const nm = path + name;
      if (!spec || typeof spec !== 'object' || typeof spec.type !== 'string') {
        errors.push({ node: nm, message: 'node spec must be an object with a "type" string' });
        continue;
      }
      const def = this.resolveDef(spec.type, scope);
      if (!def) {
        if (spec.type.includes('/')) {
          const p = this.packageIssue(spec.type, scope);
          errors.push({ node: nm, message: p.error, ...(p.hint ? { hint: p.hint } : {}) });
          continue;
        }
        const s = didYouMean(spec.type, typeNames ??= this.allTypeNames(scope));
        errors.push({ node: nm, message: `unknown node type "${spec.type}"${s.length ? ` — did you mean ${s.join(', ')}?` : ''}`, hint: 'use the catalog tool to list node types' });
        continue;
      }
      const w = wiringOf(spec, def);
      for (const e of w.errors) errors.push({ node: nm, message: e });
      const multi = def.inputs.some((i) => i.multi);
      if (!multi && w.list.length > def.inputs.length)
        errors.push({ node: nm, message: `"${def.type}" takes ${def.inputs.length} input(s) (${def.inputs.map((i) => i.name).join(', ') || 'none'}), got ${w.list.length}` });
      w.list.forEach((ref, i) => {
        if (ref && !graph.nodes[ref]) {
          const s = didYouMean(ref, names);
          errors.push({ node: nm, message: `input ${i} references missing node "${ref}"${s.length ? ` — did you mean ${s.join(', ')}?` : ''}` });
        }
        if (ref === name) errors.push({ node: nm, message: 'node is wired to itself' });
      });
      def.inputs.forEach((inp, i) => {
        if (!inp.optional && !inp.multi && !w.list[i])
          errors.push({ node: nm, message: `required input ${i} "${inp.name}" (${inp.desc}) is not connected` });
      });
      if (spec.params !== undefined && (typeof spec.params !== 'object' || Array.isArray(spec.params))) {
        errors.push({ node: nm, message: '"params" must be an object' });
        continue;
      }
      for (const k of Object.keys(spec.params ?? {})) {
        if (!resolveParamName(def, k)) {
          // a renamed or removed param says what to write now (NodeDef.renamed)
          const now = def.renamed?.[k];
          const s = now ? [] : didYouMean(k, Object.keys(def.params));
          errors.push({
            node: nm,
            message: `unknown param "${k}" for ${def.type}${now ? `: ${now}` : s.length ? ` — did you mean ${s.map((x) => `"${x}"`).join(' or ')}?` : ''}`,
            hint: `valid params: ${Object.keys(def.params).join(', ') || '(none)'}`,
          });
        }
      }
      // expression references to other nodes of this graph
      const refs = scanNodeRefs(def, spec.params);
      refsOf.set(name, refs);
      for (const e of refs.errors) errors.push({ node: nm, message: e });
      for (const r of refs.geo) {
        if (graph.nodes[r]) continue;
        const s = didYouMean(r, names);
        errors.push({ node: nm, message: `expression references unknown node "${r}"${s.length ? ` — did you mean ${s.join(', ')}?` : ''}`, hint: `nodes in this graph: ${names.join(', ')}` });
      }
      for (const c of refs.ch) {
        const target = graph.nodes[c.node];
        if (!target) {
          const s = didYouMean(c.node, names);
          errors.push({ node: nm, message: `ch("${c.node}/${c.param}") references unknown node "${c.node}"${s.length ? ` — did you mean ${s.join(', ')}?` : ''}`, hint: `nodes in this graph: ${names.join(', ')}` });
          continue;
        }
        const tdef = typeof target === 'object' && target ? this.resolveDef(target.type, scope) : undefined;
        if (tdef && !resolveParamName(tdef, c.param)) {
          const s = didYouMean(c.param, Object.keys(tdef.params));
          errors.push({
            node: nm,
            message: `ch("${c.node}/${c.param}"): ${tdef.type} has no param "${c.param}"${s.length ? ` — did you mean ${s.map((x) => `"${x}"`).join(' or ')}?` : ''}`,
            hint: `valid params: ${Object.keys(tdef.params).join(', ') || '(none)'}`,
          });
        }
      }
      // nested graphs (foreach / solver bodies)
      for (const [pk, pd] of Object.entries(def.params)) {
        if (pd.type !== 'graph') continue;
        const key = Object.keys(spec.params ?? {}).find((k) => resolveParamName(def, k) === pk);
        const sub = key ? spec.params![key] : undefined;
        if (sub) {
          const r = this.validate(sub, `${nm}/`, scope);
          errors.push(...r.errors);
          warnings.push(...r.warnings);
        }
      }
    }
    // cycles, over wiring and expression references. A node's cook needs its inputs and its params;
    // its params need the geometry of nodes read by npoints()/bbox()/… and the params of nodes read by ch().
    const edges = (v: string): string[] => {
      if (v.endsWith(PSUF)) {
        const r = refsOf.get(v.slice(0, -PSUF.length));
        if (!r) return [];
        return [...r.geo.filter((g) => graph.nodes[g]), ...r.ch.filter((c) => graph.nodes[c.node]).map((c) => c.node + PSUF)];
      }
      const out: string[] = [];
      const spec = graph.nodes[v];
      const def = spec && this.resolveDef(spec.type, scope);
      if (def) for (const r of wiringOf(spec, def).list) if (r && graph.nodes[r]) out.push(r);
      const rr = refsOf.get(v);
      if (rr && hasRefs(rr)) out.push(v + PSUF);
      return out;
    };
    const label = (v: string) => (v.endsWith(PSUF) ? `${v.slice(0, -PSUF.length)} (params)` : v);
    const state = new Map<string, number>();
    const visit = (v: string, stack: string[]): void => {
      const s = state.get(v);
      if (s === 2) return;
      if (s === 1) {
        const cyc = [...stack.slice(stack.indexOf(v)), v];
        const viaExpr = cyc.some((x) => x.endsWith(PSUF));
        errors.push({
          node: path + v.replace(PSUF, ''),
          message: `cycle: ${cyc.map(label).join(' → ')}`,
          hint: viaExpr ? 'expression references (npoints, bbox, point, detail, ch, …) are dependencies too; a node cannot read itself or a node downstream of it' : undefined,
        });
        return;
      }
      state.set(v, 1);
      for (const e of edges(v)) visit(e, [...stack, v]);
      state.set(v, 2);
    };
    for (const n of names) visit(n, []);
    return { errors, warnings };
  }

  /** Validate and resolve all params without cooking. */
  dryRun(graph: GraphSpec, vars?: Record<string, any>, scope: Scope = this.root): { errors: Issue[]; warnings: Issue[]; notes: string[]; output: string } {
    const v = this.validate(graph, '', scope);
    const notes: string[] = [];
    const allVars = { ...(graph.vars ?? {}), ...(vars ?? {}) };
    if (!v.errors.length) {
      // reference functions need cooked nodes: their params are reported as deferred
      const deferred = Object.fromEntries(REF_FUNCS.map((f) => [f, () => { throw new DeferredExpr(f); }]));
      for (const [name, spec] of Object.entries(graph.nodes)) {
        const def = this.resolveDef(spec.type, scope)!;
        const r = resolveParams(def, spec.params, allVars, { fns: deferred, host: this.host, timeoutMs: this.scriptTimeoutMs });
        for (const e of r.errors) if (!e.startsWith('unknown param')) v.errors.push({ node: name, message: e });
        for (const w of r.warnings) v.warnings.push({ node: name, message: w });
        for (const n of r.notes) notes.push(`${name}: ${n}`);
        if (r.deferred.length) notes.push(`${name}: ${r.deferred.join(', ')} read other nodes (evaluated when cooked)`);
        if (def.deprecated) notes.push(`${name}: "${def.type}" is deprecated — ${def.deprecated}`);
      }
    }
    const out = v.errors.length ? { name: graph.output ?? '' } : this.findOutput(graph, scope);
    if (out.note) notes.push(out.note);
    return { ...v, notes, output: out.name };
  }

  // ------------------------------------------------------------ cooking

  async cook(graph: GraphSpec, opts: CookOptions = {}): Promise<CookReport> {
    const t0 = now();
    const depth = opts.depth ?? 0;
    const report: CookReport = {
      ok: false, target: '', geo: null, results: new Map(), errors: [], warnings: [], notes: [], ms: 0,
      frame: 1, time: 0, fps: 24, timeDependent: false,
    };
    if (depth > this.maxDepth) {
      report.errors.push({ node: '(graph)', message: `subgraph nesting deeper than ${this.maxDepth} (recursive asset?)` });
      return report;
    }
    let time: TimeState;
    try {
      time = resolveTime(opts);
    } catch (e: any) {
      report.errors.push({ node: '(graph)', message: e.message });
      return report;
    }
    report.frame = time.frame;
    report.time = time.time;
    report.fps = time.fps;
    const scope = opts.scope ?? this.root;
    const v = this.validate(graph, '', scope);
    if (v.errors.length) {
      report.errors = v.errors;
      report.ms = now() - t0;
      return report;
    }
    let target = opts.target;
    if (target === undefined) {
      const o = this.findOutput(graph, scope);
      target = o.name;
      if (o.note) report.notes.push(o.note);
    } else if (!graph.nodes[target]) {
      const s = didYouMean(target, Object.keys(graph.nodes));
      report.errors.push({ node: target, message: `no node "${target}" in graph${s.length ? ` — did you mean ${s.join(', ')}?` : ''}` });
      return report;
    }
    report.target = target;
    const memo = new Map<string, Promise<NodeResult>>();
    const pmemo = new Map<string, Promise<NodeParams>>();
    const s: CookSession = {
      graph, opts, scope, time, depth, report, memo, pmemo, pdone: new Map(), shared: [],
      vars: { ...(graph.vars ?? {}), ...(opts.vars ?? {}) },
      pull: (name) => {
        let pr = memo.get(name);
        if (!pr) {
          pr = this.cookOne(s, name);
          // a concurrent pull nobody awaits any more (an earlier input failed) must not reject unhandled
          pr.catch(() => {});
          memo.set(name, pr);
        }
        return pr;
      },
      paramsOf: (name) => {
        let pr = pmemo.get(name);
        if (!pr) {
          pr = this.nodeParams(s, name).then((np) => { s.pdone.set(name, np); return np; });
          pr.catch(() => {});
          pmemo.set(name, pr);
        }
        return pr;
      },
    };

    const res = await s.pull(target);
    if (this.concurrent) {
      // let branches that a failed input left running finish, then order the report as a sequential cook would
      for (let n = -1; n !== memo.size + pmemo.size;) {
        n = memo.size + pmemo.size;
        await Promise.allSettled([...memo.values(), ...pmemo.values()]);
      }
      this.canonicalReport(s, target);
    }
    for (const r of report.results.values()) {
      if (r.error && !r.upstream) report.errors.push(r.error);
      for (const w of r.warnings) report.warnings.push({ node: r.node, message: w });
    }
    report.ok = !res.error;
    report.geo = res.geo;
    report.timeDependent = res.timeDependent;
    // a failure after a stop is the stop's doing: the first node that did not cook (a nested stop fails its parent)
    if (!report.ok && opts.signal?.aborted) report.stopped = (report.errors.find((e) => e.message === STOPPED) ?? report.errors[0])?.node ?? target;
    report.ms = now() - t0;
    return report;
  }

  /** Cook a graph at every frame of a range (end inclusive), in order, reusing the cache across frames. */
  async cookFrames(
    graph: GraphSpec, range: FrameRange, cb: (r: CookReport, frame: number) => void | Promise<void>,
    opts: Omit<CookOptions, 'frame' | 'time'> = {},
  ): Promise<{ frames: number; failed: number[] }> {
    const step = range.step ?? 1;
    if (!(step > 0)) throw new Error(`frame step must be > 0, got ${step}`);
    if (!(range.end >= range.start)) throw new Error(`frame range end (${range.end}) is before start (${range.start})`);
    const n = Math.floor((range.end - range.start) / step + 1e-9) + 1;
    const failed: number[] = [];
    for (let i = 0; i < n; i++) {
      const frame = r9(range.start + i * step);
      const r = await this.cook(graph, { ...opts, frame });
      if (!r.ok) failed.push(frame);
      await cb(r, frame);
    }
    return { frames: n, failed };
  }

  /** Resolve a node's params, cooking the nodes its expressions reference first. */
  private async nodeParams(s: CookSession, name: string): Promise<NodeParams> {
    const spec = s.graph.nodes[name];
    const def = this.resolveDef(spec.type, s.scope)!;
    const refs = scanNodeRefs(def, spec.params);
    if (!hasRefs(refs)) {
      const rp = resolveParams(def, spec.params, s.vars, { time: s.time, host: this.host, timeoutMs: this.scriptTimeoutMs });
      return { rp, refSig: '', usesTime: rp.usesTime, depsTimeDependent: false };
    }
    const fail = (error: string, upstream = false): NodeParams => ({
      rp: { values: {}, errors: [], notes: [], warnings: [], usesTime: false, deferred: [] }, refSig: '', usesTime: false, depsTimeDependent: false, error, upstream,
    });
    const geo = new Map<string, Geometry>();
    const parts: string[] = [];
    let usesTime = false, depTime = false;
    for (const g of refs.geo) {
      const r = await s.pull(g);
      if (r.error || !r.geo) return fail(`expression reference "${g}" failed`, true);
      geo.set(g, r.geo);
      parts.push(`${g}=${r.sig}`);
      depTime ||= r.timeDependent;
    }
    const chp: ChParams = new Map();
    for (const c of refs.ch) {
      if (!chp.has(c.node)) {
        const np = await s.paramsOf(c.node);
        const msg = np.error ?? np.rp.errors.join('; ');
        if (msg) return fail(`ch("${c.node}/${c.param}"): node "${c.node}" has param errors: ${msg}`);
        chp.set(c.node, { def: this.resolveDef(s.graph.nodes[c.node].type, s.scope)!, values: np.rp.values });
        usesTime ||= np.usesTime;
        depTime ||= np.depsTimeDependent;
      }
      const e = chp.get(c.node)!;
      const pn = resolveParamName(e.def, c.param);
      parts.push(`${c.node}.${c.param}=${pn ? stableStringify(e.values[pn]) : 'u'}`);
    }
    const rp = resolveParams(def, spec.params, s.vars, { time: s.time, fns: refFunctions(geo, chp), host: this.host, timeoutMs: this.scriptTimeoutMs });
    return { rp, refSig: parts.join(','), usesTime: usesTime || rp.usesTime, depsTimeDependent: depTime };
  }

  /** Cook a single node of a graph (pulling inputs and referenced nodes through the session). */
  private async cookOne(s: CookSession, name: string): Promise<NodeResult> {
    const { graph, vars, opts, scope, time, depth, report } = s;
    const spec = graph.nodes[name];
    const def = this.resolveDef(spec.type, scope)!;
    const result: NodeResult = { node: name, geo: null, sig: '', ms: 0, cached: false, warnings: [], timeDependent: false };
    report.results.set(name, result);
    if (def.deprecated) result.warnings.push(`"${def.type}" is deprecated: ${def.deprecated}`);
    const wiring = wiringOf(spec, def).list;

    const inputs: (Geometry | null)[] = [];
    const inputSigs: string[] = [];
    const inputRes: (NodeResult | null)[] = [];
    let depTime = false;
    // a node that picks its inputs by param (switch) resolves its params first and cooks only the inputs it reads
    const lazy = !!def.inputsUsed && !spec.bypass && def.type !== 'input';
    let used: boolean[] | null = null;
    if (lazy) {
      const np0 = await s.paramsOf(name);
      if (!np0.error && !np0.rp.errors.length) used = def.inputsUsed!(np0.rp.values, wiring.length);
    }
    const wanted = (i: number) => !!wiring[i] && (!lazy || !!used?.[i]);
    // concurrent: start every input, and the params with the nodes they reference, at once
    const started = this.concurrent ? wiring.map((ref, i) => (wanted(i) ? s.pull(ref!) : null)) : null;
    if (this.concurrent && !lazy && def.type !== 'input') s.paramsOf(name);
    for (let i = 0; i < wiring.length; i++) {
      const ref = wiring[i];
      if (!wanted(i)) { inputs.push(null); inputSigs.push(ref ? 'unused' : 'none'); inputRes.push(null); continue; }
      const r = await (started ? started[i]! : s.pull(ref!));
      if (r.error) {
        result.error = { node: name, message: `input ${i} ("${ref}") failed` };
        result.upstream = true;
        return result;
      }
      inputs.push(r.geo);
      inputSigs.push(r.sig);
      inputRes.push(r);
      depTime ||= r.timeDependent;
    }

    // subgraph inputs are provided by the parent cook (their time dependence is in the parent's signature)
    if (def.type === 'input') {
      const idx = Number(spec.params?.index ?? 0);
      const si = opts.inputs?.[idx];
      result.geo = si?.geo ?? new Geometry();
      result.sig = 'input:' + (si?.sig ?? 'none');
      result.cached = true;
      return result;
    }

    const np = await s.paramsOf(name);
    if (np.error) {
      result.error = { node: name, message: np.error };
      result.upstream = np.upstream;
      return result;
    }
    const rp = np.rp;
    if (rp.errors.length) {
      result.error = { node: name, message: rp.errors.join('; ') };
      return result;
    }
    result.warnings.push(...rp.warnings); // values clamped to a param range: said every cook, cache hits included
    depTime ||= np.depsTimeDependent;

    if (spec.bypass) {
      result.geo = inputs[0] ?? new Geometry();
      result.sig = inputSigs[0] ?? 'bypass';
      result.timeDependent = inputRes[0]?.timeDependent ?? false;
      result.warnings.push('bypassed');
      return result;
    }

    // the scope a node reads, through signatureExtra (a file's stamp) or while it cooks (ctx.scope, a nested cook in
    // it), keys its result outside the root scope (scopeSig); found once, remembered for its signature (scopeDeps)
    let readScope = !!def.usesScope, readScopeCooking = false;
    let extra = '';
    try {
      extra = def.signatureExtra?.(rp.values, watchScope(scope, () => { readScope = true; })) ?? '';
    } catch (e: any) {
      result.error = { node: name, message: e.message };
      return result;
    }
    // vars read by the node's code: all of them (loop bodies, scripts), or those its code names
    const varsSig = def.usesVars === true ? stableStringify(vars)
      : typeof def.usesVars === 'function' ? stableStringify(pickVars(vars, codeVarNames(def.usesVars(rp.values), vars))) : '';
    // a result named after its node (an image's default name) is not shared with an identical node of another name
    const nameSig = def.usesNodeName && (def.usesNodeName === true || def.usesNodeName(rp.values)) ? '|N:' + name : '';
    const material = def.type + '|' + stableStringify(rp.values) + '|' + inputSigs.join(',') + '|' + varsSig + '|' + extra + (np.refSig ? '|R:' + np.refSig : '') + nameSig;
    const plainSig = String(hashString(material));
    if (this.scopeDeps.has(plainSig)) readScope = true;
    const scopedSig = () => (scopeSig(scope) ? String(hashString(material + scopeSig(scope))) : plainSig);
    let baseSig = readScope ? scopedSig() : plainSig;
    const timeSig = () => String(hashString(baseSig + '|' + timeKey(time)));
    let timeDep = !!def.usesTime || np.usesTime || this.timeDeps.has(baseSig);
    let sig = timeDep ? timeSig() : baseSig;
    result.sig = sig;
    result.timeDependent = timeDep || depTime;
    const hit = this.cache.get(sig);
    if (hit) {
      result.geo = hit;
      result.cached = true;
      return result;
    }
    // about to cook: report it (the host may yield there), and stop here when the cook was asked to stop
    const progress: NodeProgress | null = opts.onNode ? { phase: 'start', node: name, type: def.type, depth, within: opts.within ?? [] } : null;
    // a progress hook that throws must not break the cook
    const ended = (ms: number, error?: string) => {
      if (progress) try { void opts.onNode!({ ...progress, phase: 'end', ms, ...(error ? { error } : {}) }); } catch { /* ignore */ }
    };
    if (progress) try { await opts.onNode!(progress); } catch { /* ignore */ }
    if (opts.signal?.aborted) {
      result.error = { node: name, message: STOPPED };
      ended(0, STOPPED);
      return result;
    }
    if (progress) {
      // while the host had the thread, another cook may have made this result
      const made = this.cache.get(sig);
      if (made) { result.geo = made; result.cached = true; ended(0); return result; }
    }
    // the same signature is cooking elsewhere (another branch, an identical node, another iteration): share that cook
    const key = sig;
    const flight = this.inflight.get(key);
    if (flight && !opts.ancestors?.has(key)) {
      const d = await flight.done;
      if (!d.failed && d.geo) {
        result.geo = d.geo;
        result.sig = d.sig;
        result.timeDependent = d.timeDep || depTime;
        result.cached = true;
        s.shared.push({ leader: flight.result, waiter: result });
        ended(0);
        return result;
      }
      // it failed: cook here again, as a cook that came after it would (unless this cook was stopped meanwhile)
      if (opts.signal?.aborted) {
        result.error = { node: name, message: STOPPED };
        ended(0, STOPPED);
        return result;
      }
    }
    let land!: (v: { geo: Geometry | null; sig: string; timeDep: boolean; failed: boolean }) => void;
    const mine: Flight = { done: new Promise((r) => { land = r; }), result };
    this.inflight.set(key, mine);
    let chainSet: Set<string> | null = null;
    const chain = () => (chainSet ??= new Set([...(opts.ancestors ?? []), key]));

    const t0 = now();
    let readTime = false;
    const mark = () => { readTime = true; };
    const engine = this;
    const ctx: CookContext = {
      node: name,
      type: def.type,
      p: rp.values,
      inputs,
      input: (i) => inputs[i] ?? new Geometry(),
      hasInput: (i) => !!inputs[i],
      warn: (m) => result.warnings.push(m),
      vars,
      engine: this,
      scope: watchScope(scope, () => { readScopeCooking = true; }),
      inputSigs,
      depth,
      get frame() { mark(); return time.frame; },
      get time() { mark(); return time.time; },
      get fps() { mark(); return time.fps; },
      get timeInc() { mark(); return time.timeInc; },
      markTimeDependent: mark,
      signal: opts.signal,
      async subcook(g, o = {}) {
        const inherit = o.frame === undefined && o.time === undefined ? { frame: time.frame, time: time.time, timeInc: time.timeInc } : {};
        // a nested cook in this cook's scope resolves its node types there
        if (!o.scope) readScopeCooking = true;
        // nested cooks report their nodes (inside this one), stop with this cook and run in its scope unless given one
        const r = await engine.cook(g, {
          fps: time.fps, ...inherit, ...o, depth: depth + 1, ancestors: chain(),
          onNode: opts.onNode, signal: opts.signal, within: [...(opts.within ?? []), name], scope: o.scope ?? scope,
        });
        if (r.timeDependent) mark();
        return r;
      },
      async inputAt(i, frame) {
        const ref = wiring[i];
        const cur = inputRes[i];
        if (!ref || !cur) return { geo: new Geometry(), sig: 'none', timeDependent: false };
        if (!cur.timeDependent || frame === time.frame) return { geo: cur.geo ?? new Geometry(), sig: cur.sig, timeDependent: cur.timeDependent };
        const r = await engine.cook(graph, { ...opts, target: ref, frame, time: undefined, timeInc: undefined, depth, ancestors: chain() });
        const rr = r.results.get(ref);
        if (!r.ok || !r.geo || !rr) throw new NodeError(`input ${i} ("${ref}") failed at frame ${frame}: ${r.errors.map((e) => `${e.node}: ${e.message}`).join('; ')}`);
        return { geo: r.geo, sig: rr.sig, timeDependent: true };
      },
      stat: (k, v) => { (result.stats ??= {})[k] = v; },
      // the node's pool tasks stop with the cook
      parallelMap: (kernel, job, o) => runKernel(engine.host.pool, kernel, job, opts.signal ? { ...o, signal: opts.signal } : o, engine.poolStats),
      async checkpoint() {
        if (progress) try { await opts.onNode!({ ...progress, phase: 'step' }); } catch { /* ignore */ }
        if (opts.signal?.aborted) throw new NodeError(STOPPED);
      },
    };
    try {
      this.unpackInputs(def, rp.values, inputs, inputSigs, name, result);
      const out = await def.cook(ctx);
      if (!isGeometry(out)) throw new Error(`node returned ${out === null ? 'null' : typeof out} instead of geometry`);
      checkFinite(out, result);
      if (readScopeCooking && !readScope) {
        // found to read its scope: remember it, and key this result by the scope (the root's key stays the same)
        if (this.scopeDeps.size > 100000) { this.scopeDeps.clear(); this.cache.clear(); }
        this.scopeDeps.add(plainSig);
        baseSig = scopedSig();
        sig = timeDep ? timeSig() : baseSig;
        result.sig = sig;
      }
      if (readTime && !timeDep) {
        // discovered while cooking: remember it so later cooks look up the time-mixed key directly
        timeDep = true;
        if (this.timeDeps.size > 100000) this.timeDeps.clear();
        this.timeDeps.add(baseSig);
        sig = timeSig();
        result.sig = sig;
        result.timeDependent = true;
      }
      result.geo = out;
      this.cache.set(sig, out);
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      result.error = { node: name, message: msg, hint: e?.hint };
    }
    result.ms = now() - t0;
    if (this.inflight.get(key) === mine) this.inflight.delete(key);
    land({ geo: result.geo, sig: result.sig, timeDep, failed: !!result.error });
    ended(result.ms, result.error?.message);
    return result;
  }

  /**
   * Put a concurrent cook's report in the order of a sequential cook (one input at a time, each node's results in
   * pull order) and drop the nodes a sequential cook would not have reached: it stops at a node's first failed input
   * or failed expression reference. Results that shared an in-flight cook of the same signature swap roles so the one
   * a sequential cook reaches first is the one that cooked (cached: false, with the cook's warnings and stats).
   */
  private canonicalReport(s: CookSession, target: string) {
    const res = s.report.results;
    const order: string[] = [];
    const seen = new Set<string>(), pseen = new Set<string>();
    const failed = (n: string) => { const r = res.get(n); return !r || !!r.error || !r.geo; };
    const paramsOk = (n: string) => { const np = s.pdone.get(n); return !!np && !np.error && !np.rp.errors.length; };
    // nodeParams: geometry references in order (stop at a failure), then the params of ch() targets
    const params = (n: string): boolean => {
      if (!pseen.has(n)) {
        pseen.add(n);
        const spec = s.graph.nodes[n];
        const def = this.resolveDef(spec.type, s.scope)!;
        const refs = scanNodeRefs(def, spec.params);
        if (hasRefs(refs)) {
          let ok = true;
          for (const g of refs.geo) {
            pull(g);
            if (failed(g)) { ok = false; break; }
          }
          if (ok) {
            const done = new Set<string>();
            for (const c of refs.ch) {
              if (done.has(c.node)) continue;
              done.add(c.node);
              if (!params(c.node)) break;
            }
          }
        }
      }
      return paramsOk(n);
    };
    // cookOne: inputs in order (stop at a failure), then the node's params
    const pull = (n: string) => {
      if (seen.has(n) || !res.has(n)) return;
      seen.add(n);
      order.push(n);
      const spec = s.graph.nodes[n];
      const def = this.resolveDef(spec.type, s.scope)!;
      const wiring = wiringOf(spec, def).list;
      const lazy = !!def.inputsUsed && !spec.bypass && def.type !== 'input';
      let used: boolean[] | null = null;
      if (lazy) {
        if (!params(n)) return;
        used = def.inputsUsed!(s.pdone.get(n)!.rp.values, wiring.length);
      }
      for (let i = 0; i < wiring.length; i++) {
        const ref = wiring[i];
        if (!ref || (used && !used[i])) continue;
        pull(ref);
        if (!res.has(ref) || res.get(ref)!.error) return;
      }
      if (def.type !== 'input') params(n);
    };
    pull(target);
    const all = new Map(res);
    res.clear();
    for (const n of order) res.set(n, all.get(n)!);
    if (!s.shared.length) return;
    const rank = new Map(order.map((n, i) => [n, i]));
    const groups = new Map<NodeResult, NodeResult[]>();
    for (const { leader, waiter } of s.shared) {
      if (res.get(leader.node) !== leader || res.get(waiter.node) !== waiter) continue;
      const g = groups.get(leader) ?? [leader];
      g.push(waiter);
      groups.set(leader, g);
    }
    for (const [leader, members] of groups) {
      members.sort((a, b) => rank.get(a.node)! - rank.get(b.node)!);
      const first = members[0];
      if (first === leader) continue;
      const take = (r: NodeResult) => ({ cached: r.cached, warnings: r.warnings, ms: r.ms, stats: r.stats });
      const a = take(first), b = take(leader);
      Object.assign(first, b);
      Object.assign(leader, a);
      if (!first.stats) delete first.stats;
      if (!leader.stats) delete leader.stats;
    }
  }

  /**
   * Expand packed prims in the inputs of a node that does not handle them (NodeDef.packed, default 'unpack'), and
   * convert spline prims to polylines for a node that works on polygons/polylines (NodeDef.splines), in place, with one
   * warning each. Both are cached under the input's signature, so they happen once per input.
   */
  private unpackInputs(def: NodeDef, p: Record<string, any>, inputs: (Geometry | null)[], sigs: string[], name: string, result: NodeResult) {
    const policy = typeof def.packed === 'function' ? def.packed(p) : def.packed ?? 'unpack';
    const expanded = new Uint8Array(inputs.length);
    if (policy !== 'keep') {
      let n = 0;
      for (let i = 0; i < inputs.length; i++) {
        const g = inputs[i];
        if (!g || !g.hasPacked()) continue;
        n += g.numPacked;
        const key = 'unpack:' + sigs[i];
        let u = this.cache.get(key);
        if (!u) {
          u = expandPacked(g, { transfer: DEFAULT_TRANSFER }).geo;
          this.cache.set(key, u);
        }
        inputs[i] = u;
        expanded[i] = 1;
      }
      if (n) result.warnings.push(`unpacked ${n} instances for ${name} (${def.type} needs real geometry; add an unpack node to choose what is transferred, or keep instances packed upstream)`);
    }
    // spline prims (Bezier/NURBS): NodeDef.splines, by default 'keep' for nodes that keep packed prims (they work on
    // elements and points), else converted to polylines
    const sp = typeof def.splines === 'function' ? def.splines(p) : def.splines ?? (policy === 'keep' ? 'keep' : 'polyline');
    if (sp === 'keep') return;
    let n = 0;
    for (let i = 0; i < inputs.length; i++) {
      const g = inputs[i];
      if (!g || !g.hasSplines()) continue;
      n += g.numSplines;
      const key = (expanded[i] ? 'unpack-polyline:' : 'polyline:') + sigs[i];
      let c = this.cache.get(key);
      if (!c) {
        c = splinesToPolylines(g).geo;
        this.cache.set(key, c);
      }
      inputs[i] = c;
    }
    if (n) result.warnings.push(`converted ${n} spline curve${n === 1 ? '' : 's'} to polylines for ${name} (${def.type} works on polygons/polylines; add convert_curve or resample to choose the resolution)`);
  }
}

function checkFinite(g: Geometry, r: NodeResult) {
  const P = g.P;
  let bad = 0;
  for (let i = 0; i < P.length; i++) if (!Number.isFinite(P[i])) { bad++; P[i] = 0; }
  if (bad) r.warnings.push(`${Math.ceil(bad / 3)} point positions were NaN/Infinity (set to 0)`);
}
