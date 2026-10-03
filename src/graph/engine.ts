// Graph evaluation: validation, lazy pull-based cooking, content-addressed caching.
//
// Every node result is keyed by a signature = hash(type, resolved params, input
// signatures[, vars]). Editing one parameter therefore re-cooks only the nodes
// downstream of it, and identical sub-results (e.g. loop iterations) are shared.
import { Geometry } from '../core/geometry.ts';
import { hashString } from '../core/random.ts';
import type { Host } from '../host/types.ts';
import { allAliases, getNodeDef } from './registry.ts';
import { didYouMean, resolveParamName, resolveParams } from './params.ts';
import { NodeError } from './types.ts';
import type { CookContext, GraphSpec, NodeDef, NodeSpec, ParamDef } from './types.ts';

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
}

export interface SubInput { geo: Geometry; sig: string }

export interface CookOptions {
  target?: string;
  vars?: Record<string, any>;
  inputs?: SubInput[];
  depth?: number;
}

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

// ---------------------------------------------------------------- engine

export class Engine {
  host: Host;
  cache = new GeoCache();
  assets = new Map<string, AssetEntry>();
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
    const engine = this;
    const def: NodeDef = {
      type: name,
      category: 'asset',
      summary: graph.description ?? `user asset "${name}"`,
      inputs: Array.from({ length: nIn }, (_, i) => ({ name: `input${i}`, desc: inputDescs[i] || `subgraph input ${i}`, optional: true })),
      params,
      signatureExtra: () => hash,
      async cook(ctx) {
        const r = await engine.cook(graph, {
          vars: ctx.p,
          inputs: ctx.inputs.map((g, i) => ({ geo: g ?? new Geometry(), sig: ctx.inputSigs[i] ?? 'none' })),
          depth: ctx.depth + 1,
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
    const typeNames = this.allTypeNames();
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
      // nested graphs (foreach bodies)
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
    // cycles
    const state = new Map<string, number>();
    const visit = (n: string, stack: string[]): void => {
      const s = state.get(n);
      if (s === 2) return;
      if (s === 1) {
        errors.push({ node: path + n, message: `cycle: ${[...stack.slice(stack.indexOf(n)), n].join(' → ')}` });
        return;
      }
      state.set(n, 1);
      const spec = graph.nodes[n];
      const def = spec && this.resolveDef(spec.type);
      if (def) for (const r of wiringOf(spec, def).list) if (r && graph.nodes[r]) visit(r, [...stack, n]);
      state.set(n, 2);
    };
    for (const n of names) visit(n, []);
    return { errors, warnings };
  }

  /** Validate and resolve all params without cooking. */
  dryRun(graph: GraphSpec, vars?: Record<string, any>): { errors: Issue[]; warnings: Issue[]; notes: string[]; output: string } {
    const v = this.validate(graph);
    const notes: string[] = [];
    const allVars = { ...(graph.vars ?? {}), ...(vars ?? {}) };
    if (!v.errors.length) {
      for (const [name, spec] of Object.entries(graph.nodes)) {
        const def = this.resolveDef(spec.type)!;
        const r = resolveParams(def, spec.params, allVars);
        for (const e of r.errors) if (!e.startsWith('unknown param')) v.errors.push({ node: name, message: e });
        for (const n of r.notes) notes.push(`${name}: ${n}`);
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
    const report: CookReport = { ok: false, target: '', geo: null, results: new Map(), errors: [], warnings: [], notes: [], ms: 0 };
    if (depth > this.maxDepth) {
      report.errors.push({ node: '(graph)', message: `subgraph nesting deeper than ${this.maxDepth} (recursive asset?)` });
      return report;
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
    const vars = { ...(graph.vars ?? {}), ...(opts.vars ?? {}) };
    const memo = new Map<string, Promise<NodeResult>>();

    const cookNode = (name: string): Promise<NodeResult> => {
      let pr = memo.get(name);
      if (!pr) {
        pr = this.cookOne(graph, name, vars, opts, depth, cookNode, report);
        memo.set(name, pr);
      }
      return pr;
    };

    const res = await cookNode(target);
    for (const r of report.results.values()) {
      if (r.error && !r.upstream) report.errors.push(r.error);
      for (const w of r.warnings) report.warnings.push({ node: r.node, message: w });
    }
    report.ok = !res.error;
    report.geo = res.geo;
    report.ms = now() - t0;
    return report;
  }

  /** Cook a single node of a graph (pulling inputs through `pull`). */
  private async cookOne(
    graph: GraphSpec, name: string, vars: Record<string, any>, opts: CookOptions, depth: number,
    pull: (n: string) => Promise<NodeResult>, report: CookReport,
  ): Promise<NodeResult> {
    const spec = graph.nodes[name];
    const def = this.resolveDef(spec.type)!;
    const result: NodeResult = { node: name, geo: null, sig: '', ms: 0, cached: false, warnings: [] };
    report.results.set(name, result);
    const wiring = wiringOf(spec, def).list;

    const inputs: (Geometry | null)[] = [];
    const inputSigs: string[] = [];
    for (let i = 0; i < wiring.length; i++) {
      const ref = wiring[i];
      if (!ref) { inputs.push(null); inputSigs.push('none'); continue; }
      const r = await pull(ref);
      if (r.error) {
        result.error = { node: name, message: `input ${i} ("${ref}") failed` };
        result.upstream = true;
        return result;
      }
      inputs.push(r.geo);
      inputSigs.push(r.sig);
    }

    // subgraph inputs are provided by the parent cook
    if (def.type === 'input') {
      const idx = Number(spec.params?.index ?? 0);
      const si = opts.inputs?.[idx];
      result.geo = si?.geo ?? new Geometry();
      result.sig = 'input:' + (si?.sig ?? 'none');
      result.cached = true;
      return result;
    }

    const rp = resolveParams(def, spec.params, vars);
    if (rp.errors.length) {
      result.error = { node: name, message: rp.errors.join('; ') };
      return result;
    }

    if (spec.bypass) {
      result.geo = inputs[0] ?? new Geometry();
      result.sig = inputSigs[0] ?? 'bypass';
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
    const sig = String(
      hashString(
        def.type + '|' + stableStringify(rp.values) + '|' + inputSigs.join(',') + '|' +
        (def.usesVars ? stableStringify(vars) : '') + '|' + extra,
      ),
    );
    result.sig = sig;
    const hit = this.cache.get(sig);
    if (hit) {
      result.geo = hit;
      result.cached = true;
      return result;
    }

    const t0 = now();
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
    };
    try {
      const out = await def.cook(ctx);
      if (!(out instanceof Geometry)) throw new Error(`node returned ${out === null ? 'null' : typeof out} instead of geometry`);
      checkFinite(out, result);
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
