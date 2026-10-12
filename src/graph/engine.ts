// Graph evaluation: validation, lazy pull-based cooking, content-addressed caching, time.
//
// Every node result is keyed by a signature = hash(type, resolved params, input
// signatures[, vars][, expression references]). Editing one parameter therefore re-cooks only the nodes
// downstream of it, and identical sub-results (e.g. loop iterations) are shared.
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
import { Geometry } from '../core/geometry.ts';
import { hashString } from '../core/random.ts';
import type { Host } from '../host/types.ts';
import { allAliases, getNodeDef } from './registry.ts';
import {
  DeferredExpr, REF_FUNCS, didYouMean, hasRefs, resolveParamName, resolveParams, scanNodeRefs, scanValue, vecOut,
} from './params.ts';
import type { ExprRefs, ResolvedParams, TimeState } from './params.ts';
import { migrateGraphDetailed } from './migrate.ts';
import { NodeError } from './types.ts';
import type { CookContext, GraphSpec, NodeDef, NodeSpec, ParamDef } from './types.ts';

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
}

export interface SubInput { geo: Geometry; sig: string }

export interface CookOptions {
  target?: string;
  vars?: Record<string, any>;
  inputs?: SubInput[];
  depth?: number;
  /** frame to cook at (default 1). frame 1 = time 0; frame = time * fps + 1 when only time is given */
  frame?: number;
  /** time in seconds (default derived from frame) */
  time?: number;
  /** frames per second (default 24) */
  fps?: number;
  /** time step in seconds (default 1 / fps; the solver passes 1 / (fps * substeps)) */
  timeInc?: number;
}

/** Frame range for cookFrames (end inclusive). */
export interface FrameRange { start: number; end: number; step?: number }

interface AssetEntry { name: string; graph: GraphSpec; def: NodeDef; hash: string }

// ---------------------------------------------------------------- cache

function geoBytes(g: Geometry): number {
  let b = g.primStart.byteLength + g.vertexPoint.byteLength + g.primClosed.byteLength + 256;
  for (const t of [g.points, g.vertices, g.prims, g.detail])
    for (const a of t.map.values()) b += a.type === 'string' ? (a.data as string[]).length * 24 : (a.data as Float64Array).byteLength;
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
  time: TimeState;
  depth: number;
  report: CookReport;
  pull: (n: string) => Promise<NodeResult>;
  paramsOf: (n: string) => Promise<NodeParams>;
}

const PSUF = '\u0000params';

// ---------------------------------------------------------------- engine

export class Engine {
  host: Host;
  cache = new GeoCache();
  assets = new Map<string, AssetEntry>();
  /** base signatures of nodes found to depend on time while cooking */
  timeDeps = new Set<string>();
  /** manifold-3d wasm module, loaded by init() */
  manifold: any = null;
  maxDepth = 24;
  scriptTimeoutMs = 30000;

  constructor(host: Host) {
    this.host = host;
  }

  async init() {
    if (this.manifold) return;
    const { loadManifold } = await import('../core/manifold.ts');
    this.manifold = await loadManifold();
    const { MeshoptSimplifier } = await import('meshoptimizer');
    await MeshoptSimplifier.ready;
  }

  resolveDef(type: string): NodeDef | undefined {
    if (typeof type !== 'string') return undefined;
    const a = this.assets.get(type) ?? this.assets.get(type.replace(/^asset:/, ''));
    if (a) return a.def;
    return getNodeDef(type);
  }

  allTypeNames(): string[] {
    return [...allAliases(), ...this.assets.keys()];
  }

  // ------------------------------------------------------------ assets

  registerAsset(name: string, graph: GraphSpec): NodeDef {
    if (!/^[A-Za-z_][\w]*$/.test(name)) throw new Error(`asset name must be an identifier, got "${name}"`);
    if (getNodeDef(name) && !this.assets.has(name)) throw new Error(`"${name}" clashes with a built-in node type`);
    graph = migrateGraphDetailed(graph).graph;
    const issues = this.validate(graph);
    if (issues.errors.length) throw new Error(`asset graph invalid: ${issues.errors.map((e) => `${e.node}: ${e.message}`).join('; ')}`);
    const hash = String(hashString(stableStringify(graph)));
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
      if (getNodeDef(n.type)?.type === 'input') {
        const idx = Number(n.params?.index ?? 0);
        nIn = Math.max(nIn, idx + 1);
        inputDescs[idx] = n.params?.label ?? n.note ?? '';
      }
    }
    const def: NodeDef = {
      type: name,
      category: 'asset',
      summary: graph.description ?? `user asset "${name}"`,
      inputs: Array.from({ length: nIn }, (_, i) => ({ name: `input${i}`, desc: inputDescs[i] || `subgraph input ${i}`, optional: true })),
      params,
      signatureExtra: () => hash,
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
    this.assets.set(name, { name, graph, def, hash });
    return def;
  }

  // ------------------------------------------------------------ validation

  findOutput(graph: GraphSpec): { name: string; note?: string } {
    const names = Object.keys(graph.nodes ?? {});
    if (graph.output && graph.nodes[graph.output]) return { name: graph.output };
    const named = names.find((n) => /^(out|output)$/i.test(n));
    if (named) return { name: named };
    const referenced = new Set<string>();
    for (const n of names) {
      const def = this.resolveDef(graph.nodes[n].type);
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

  validate(graph: GraphSpec, path = ''): { errors: Issue[]; warnings: Issue[] } {
    const errors: Issue[] = [], warnings: Issue[] = [];
    if (!graph || typeof graph !== 'object' || !graph.nodes || typeof graph.nodes !== 'object' || Array.isArray(graph.nodes)) {
      errors.push({ node: path || '(graph)', message: 'graph must be {"nodes": {"name": {"type": ..., "in": [...], "params": {...}}}, "output": "name"}' });
      return { errors, warnings };
    }
    const names = Object.keys(graph.nodes);
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
            hint: 'put the expression in the node param that needs it, e.g. "height": "=bbox(\\"base\\").size.y"',
          });
      }
    }
    const typeNames = this.allTypeNames();
    const refsOf = new Map<string, ExprRefs>();
    for (const name of names) {
      const spec = graph.nodes[name];
      const nm = path + name;
      if (!spec || typeof spec !== 'object' || typeof spec.type !== 'string') {
        errors.push({ node: nm, message: 'node spec must be an object with a "type" string' });
        continue;
      }
      const def = this.resolveDef(spec.type);
      if (!def) {
        const s = didYouMean(spec.type, typeNames);
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
          const s = didYouMean(k, Object.keys(def.params));
          errors.push({
            node: nm,
            message: `unknown param "${k}" for ${def.type}${s.length ? ` — did you mean ${s.map((x) => `"${x}"`).join(' or ')}?` : ''}`,
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
        const tdef = typeof target === 'object' && target ? this.resolveDef(target.type) : undefined;
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
          const r = this.validate(sub, `${nm}/`);
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
      const def = spec && this.resolveDef(spec.type);
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
  dryRun(graph: GraphSpec, vars?: Record<string, any>): { errors: Issue[]; warnings: Issue[]; notes: string[]; output: string } {
    const mig = migrateGraphDetailed(graph);
    graph = mig.graph;
    const v = this.validate(graph);
    const notes: string[] = [...mig.notes];
    const allVars = { ...(graph.vars ?? {}), ...(vars ?? {}) };
    if (!v.errors.length) {
      // reference functions need cooked nodes: their params are reported as deferred
      const deferred = Object.fromEntries(REF_FUNCS.map((f) => [f, () => { throw new DeferredExpr(f); }]));
      for (const [name, spec] of Object.entries(graph.nodes)) {
        const def = this.resolveDef(spec.type)!;
        const r = resolveParams(def, spec.params, allVars, { fns: deferred });
        for (const e of r.errors) if (!e.startsWith('unknown param')) v.errors.push({ node: name, message: e });
        for (const n of r.notes) notes.push(`${name}: ${n}`);
        if (r.deferred.length) notes.push(`${name}: ${r.deferred.join(', ')} read other nodes (evaluated when cooked)`);
        if (def.deprecated) notes.push(`${name}: "${def.type}" is deprecated — ${def.deprecated}`);
      }
    }
    const out = v.errors.length ? { name: graph.output ?? '' } : this.findOutput(graph);
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
    if (depth === 0) {
      // documents are migrated once; nested graphs belong to their parent document
      try {
        const m = migrateGraphDetailed(graph);
        graph = m.graph;
        report.notes.push(...m.notes);
      } catch (e: any) {
        report.errors.push({ node: '(graph)', message: e.message });
        return report;
      }
    }
    const v = this.validate(graph);
    if (v.errors.length) {
      report.errors = v.errors;
      report.ms = now() - t0;
      return report;
    }
    let target = opts.target;
    if (target === undefined) {
      const o = this.findOutput(graph);
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
      graph, opts, time, depth, report,
      vars: { ...(graph.vars ?? {}), ...(opts.vars ?? {}) },
      pull: (name) => {
        let pr = memo.get(name);
        if (!pr) {
          pr = this.cookOne(s, name);
          memo.set(name, pr);
        }
        return pr;
      },
      paramsOf: (name) => {
        let pr = pmemo.get(name);
        if (!pr) {
          pr = this.nodeParams(s, name);
          pmemo.set(name, pr);
        }
        return pr;
      },
    };

    const res = await s.pull(target);
    for (const r of report.results.values()) {
      if (r.error && !r.upstream) report.errors.push(r.error);
      for (const w of r.warnings) report.warnings.push({ node: r.node, message: w });
    }
    report.ok = !res.error;
    report.geo = res.geo;
    report.timeDependent = res.timeDependent;
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
    graph = migrateGraphDetailed(graph).graph;
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
    const def = this.resolveDef(spec.type)!;
    const refs = scanNodeRefs(def, spec.params);
    if (!hasRefs(refs)) {
      const rp = resolveParams(def, spec.params, s.vars, { time: s.time });
      return { rp, refSig: '', usesTime: rp.usesTime, depsTimeDependent: false };
    }
    const fail = (error: string, upstream = false): NodeParams => ({
      rp: { values: {}, errors: [], notes: [], usesTime: false, deferred: [] }, refSig: '', usesTime: false, depsTimeDependent: false, error, upstream,
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
        chp.set(c.node, { def: this.resolveDef(s.graph.nodes[c.node].type)!, values: np.rp.values });
        usesTime ||= np.usesTime;
        depTime ||= np.depsTimeDependent;
      }
      const e = chp.get(c.node)!;
      const pn = resolveParamName(e.def, c.param);
      parts.push(`${c.node}.${c.param}=${pn ? stableStringify(e.values[pn]) : 'u'}`);
    }
    const rp = resolveParams(def, spec.params, s.vars, { time: s.time, fns: refFunctions(geo, chp) });
    return { rp, refSig: parts.join(','), usesTime: usesTime || rp.usesTime, depsTimeDependent: depTime };
  }

  /** Cook a single node of a graph (pulling inputs and referenced nodes through the session). */
  private async cookOne(s: CookSession, name: string): Promise<NodeResult> {
    const { graph, vars, opts, time, depth, report } = s;
    const spec = graph.nodes[name];
    const def = this.resolveDef(spec.type)!;
    const result: NodeResult = { node: name, geo: null, sig: '', ms: 0, cached: false, warnings: [], timeDependent: false };
    report.results.set(name, result);
    if (def.deprecated) result.warnings.push(`"${def.type}" is deprecated: ${def.deprecated}`);
    const wiring = wiringOf(spec, def).list;

    const inputs: (Geometry | null)[] = [];
    const inputSigs: string[] = [];
    const inputRes: (NodeResult | null)[] = [];
    let depTime = false;
    for (let i = 0; i < wiring.length; i++) {
      const ref = wiring[i];
      if (!ref) { inputs.push(null); inputSigs.push('none'); inputRes.push(null); continue; }
      const r = await s.pull(ref);
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
    depTime ||= np.depsTimeDependent;

    if (spec.bypass) {
      result.geo = inputs[0] ?? new Geometry();
      result.sig = inputSigs[0] ?? 'bypass';
      result.timeDependent = inputRes[0]?.timeDependent ?? false;
      result.warnings.push('bypassed');
      return result;
    }

    let extra = '';
    try {
      extra = def.signatureExtra?.(rp.values, this) ?? '';
    } catch (e: any) {
      result.error = { node: name, message: e.message };
      return result;
    }
    const baseSig = String(
      hashString(
        def.type + '|' + stableStringify(rp.values) + '|' + inputSigs.join(',') + '|' +
        (def.usesVars ? stableStringify(vars) : '') + '|' + extra + (np.refSig ? '|R:' + np.refSig : ''),
      ),
    );
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
      inputSigs,
      depth,
      get frame() { mark(); return time.frame; },
      get time() { mark(); return time.time; },
      get fps() { mark(); return time.fps; },
      get timeInc() { mark(); return time.timeInc; },
      markTimeDependent: mark,
      async subcook(g, o = {}) {
        const inherit = o.frame === undefined && o.time === undefined ? { frame: time.frame, time: time.time, timeInc: time.timeInc } : {};
        const r = await engine.cook(g, { fps: time.fps, ...inherit, ...o, depth: depth + 1 });
        if (r.timeDependent) mark();
        return r;
      },
      async inputAt(i, frame) {
        const ref = wiring[i];
        const cur = inputRes[i];
        if (!ref || !cur) return { geo: new Geometry(), sig: 'none', timeDependent: false };
        if (!cur.timeDependent || frame === time.frame) return { geo: cur.geo ?? new Geometry(), sig: cur.sig, timeDependent: cur.timeDependent };
        const r = await engine.cook(graph, { ...opts, target: ref, frame, time: undefined, timeInc: undefined, depth });
        const rr = r.results.get(ref);
        if (!r.ok || !r.geo || !rr) throw new NodeError(`input ${i} ("${ref}") failed at frame ${frame}: ${r.errors.map((e) => `${e.node}: ${e.message}`).join('; ')}`);
        return { geo: r.geo, sig: rr.sig, timeDependent: true };
      },
      stat: (k, v) => { (result.stats ??= {})[k] = v; },
    };
    try {
      const out = await def.cook(ctx);
      if (!(out instanceof Geometry)) throw new Error(`node returned ${out === null ? 'null' : typeof out} instead of geometry`);
      checkFinite(out, result);
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
    return result;
  }
}

function checkFinite(g: Geometry, r: NodeResult) {
  const P = g.P;
  let bad = 0;
  for (let i = 0; i < P.length; i++) if (!Number.isFinite(P[i])) { bad++; P[i] = 0; }
  if (bad) r.warnings.push(`${Math.ceil(bad / 3)} point positions were NaN/Infinity (set to 0)`);
}
