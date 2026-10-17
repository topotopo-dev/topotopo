// A workspace: named graphs (persisted as JSON files), saved assets, and the engine
// that cooks them. Shared by the MCP server, the live viewer and the CLI.
import fs from 'node:fs';
import path from 'node:path';
import { Engine, wiringOf } from './graph/engine.ts';
import type { CookReport } from './graph/engine.ts';
import type { GraphSpec, NodeSpec } from './graph/types.ts';
import { didYouMean, renameExprRefs } from './graph/params.ts';
import { migrateGraph } from './graph/migrate.ts';

export interface EditOp {
  op: 'set' | 'add' | 'remove' | 'connect' | 'rename' | 'output' | 'vars' | 'bypass' | 'replace' | 'insert';
  node?: string;
  params?: Record<string, any>;
  spec?: NodeSpec;
  type?: string;
  in?: any;
  input?: number;
  from?: string | null;
  to?: string;
  after?: string;
  vars?: Record<string, any>;
  value?: boolean;
  note?: string;
}

const NAME_RE = /^[A-Za-z_][\w.-]*$/;

// stand-in: session A implements this; the orchestrator keeps A's version at merge
export interface InputFile { path: string; kind: 'geometry' | 'image' | 'other'; ext: string; size: number; mtime: number }

export class Workspace {
  dir: string;
  engine: Engine;
  graphs = new Map<string, GraphSpec>();
  versions = new Map<string, number>();
  lastReport = new Map<string, CookReport>();
  listeners = new Set<(ev: { graph: string; version: number }) => void>();

  constructor(dir: string, engine: Engine) {
    this.dir = path.resolve(dir);
    this.engine = engine;
    (engine as any).graphResolver = (n: string) => this.graphs.get(n);
  }

  get graphDir() { return path.join(this.dir, 'graphs'); }
  get assetDir() { return path.join(this.dir, 'assets'); }
  get exportDir() { return path.join(this.dir, 'exports'); }
  // stand-in: session A implements this; the orchestrator keeps A's version at merge
  get inputDir(): string { return path.join(this.dir, 'inputs'); }

  // stand-in: session A implements this; the orchestrator keeps A's version at merge
  listInputs(): InputFile[] {
    const out: InputFile[] = [];
    const walk = (dir: string, rel: string) => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { walk(path.join(dir, e.name), r); continue; }
        if (!e.isFile()) continue;
        const s = fs.statSync(path.join(dir, e.name));
        const lower = e.name.toLowerCase();
        const ext = lower.endsWith('.points.json') ? 'points.json' : lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
        const kind = ['obj', 'stl', 'ply', 'glb', 'gltf', 'geo', 'bgeo', 'blend', 'csv', 'json', 'points.json'].includes(ext) ? 'geometry' : ext === 'png' ? 'image' : 'other';
        out.push({ path: r, kind, ext, size: s.size, mtime: Math.round(s.mtimeMs) });
      }
    };
    walk(this.inputDir, '');
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  load() {
    for (const d of [this.dir, this.graphDir, this.assetDir, this.exportDir]) fs.mkdirSync(d, { recursive: true });
    const assetErrors: string[] = [];
    for (const f of fs.readdirSync(this.assetDir).filter((f) => f.endsWith('.json'))) {
      try {
        const spec = migrateGraph(JSON.parse(fs.readFileSync(path.join(this.assetDir, f), 'utf8')));
        this.engine.registerAsset(path.basename(f, '.json'), spec);
      } catch (e: any) { assetErrors.push(`${f}: ${e.message}`); }
    }
    for (const f of fs.readdirSync(this.graphDir).filter((f) => f.endsWith('.json'))) {
      // migrated in memory; the file is rewritten (with its version) on the next save
      try { this.graphs.set(path.basename(f, '.json'), migrateGraph(JSON.parse(fs.readFileSync(path.join(this.graphDir, f), 'utf8')))); }
      catch { /* skip unreadable */ }
    }
    // workspace assets were registered over shelf assets of the same name (engine.init loads the shelf first)
    const defs = [...this.engine.assets.values()].map((a) => a.def);
    return {
      graphs: this.graphs.size, assets: defs.filter((d) => d.category !== 'shelf').length, shelf: defs.filter((d) => d.category === 'shelf').length,
      assetErrors: [...assetErrors, ...this.engine.shelfErrors.map((e) => `shelf ${e}`)],
    };
  }

  private persist(name: string) {
    const g = this.graphs.get(name);
    const file = path.join(this.graphDir, name + '.json');
    if (!g) { if (fs.existsSync(file)) fs.unlinkSync(file); return; }
    fs.writeFileSync(file, JSON.stringify(g, null, 2));
  }

  bump(name: string) {
    const v = (this.versions.get(name) ?? 0) + 1;
    this.versions.set(name, v);
    for (const l of this.listeners) try { l({ graph: name, version: v }); } catch { /* ignore */ }
  }

  getGraph(name: string): GraphSpec {
    const g = this.graphs.get(name);
    if (!g) {
      const s = didYouMean(name, [...this.graphs.keys()]);
      throw new Error(`no graph "${name}"${s.length ? ` — did you mean ${s.join(', ')}?` : ''}. Graphs: ${[...this.graphs.keys()].join(', ') || '(none yet — use build)'}`);
    }
    return g;
  }

  setGraph(name: string, spec: GraphSpec) {
    if (!NAME_RE.test(name)) throw new Error(`graph name must match ${NAME_RE}`);
    this.graphs.set(name, migrateGraph(spec));
    this.persist(name);
  }

  deleteGraph(name: string) {
    this.getGraph(name);
    this.graphs.delete(name);
    this.persist(name);
  }

  /** Merge nodes/vars/output of `patch` into an existing graph (upsert). */
  mergeGraph(name: string, patch: GraphSpec): GraphSpec {
    patch = migrateGraph(patch);
    const base = structuredClone(this.graphs.get(name) ?? { nodes: {} });
    Object.assign(base.nodes, patch.nodes ?? {});
    if (patch.vars) base.vars = { ...(base.vars ?? {}), ...patch.vars };
    if (patch.params) base.params = { ...(base.params ?? {}), ...patch.params };
    if (patch.output) base.output = patch.output;
    if (patch.description) base.description = patch.description;
    return base;
  }

  /** Apply edit operations; returns the new graph (not yet stored) and notes. */
  applyEdits(name: string, ops: EditOp[]): { graph: GraphSpec; notes: string[] } {
    const g: GraphSpec = structuredClone(this.getGraph(name));
    const notes: string[] = [];
    const need = (n: string | undefined, what: string): string => {
      if (!n) throw new Error(`${what}: "node" is required`);
      if (!g.nodes[n]) {
        const s = didYouMean(n, Object.keys(g.nodes));
        throw new Error(`${what}: no node "${n}"${s.length ? ` — did you mean ${s.join(', ')}?` : ''}`);
      }
      return n;
    };
    const refsTo = (target: string) => {
      const out: { node: string; idx: number | string }[] = [];
      for (const [k, spec] of Object.entries(g.nodes)) {
        if (Array.isArray(spec.in)) spec.in.forEach((r, i) => r === target && out.push({ node: k, idx: i }));
        else if (typeof spec.in === 'string') { if (spec.in === target) out.push({ node: k, idx: 0 }); }
        else if (spec.in && typeof spec.in === 'object') for (const [ik, r] of Object.entries(spec.in)) if (r === target) out.push({ node: k, idx: ik });
      }
      return out;
    };
    const setRef = (node: string, idx: number | string, value: string | null) => {
      const spec = g.nodes[node];
      if (typeof spec.in === 'string') spec.in = [value];
      else if (Array.isArray(spec.in)) spec.in[idx as number] = value;
      else if (spec.in && typeof spec.in === 'object') (spec.in as any)[idx] = value;
    };
    for (const [i, op] of ops.entries()) {
      const where = `op ${i} (${op.op})`;
      switch (op.op) {
        case 'set': {
          const n = need(op.node, where);
          const spec = g.nodes[n];
          spec.params = { ...(spec.params ?? {}) };
          for (const [k, v] of Object.entries(op.params ?? {})) {
            if (v === null) delete spec.params[k]; else spec.params[k] = v;
          }
          break;
        }
        case 'add': {
          if (!op.node || !NAME_RE.test(op.node)) throw new Error(`${where}: "node" must be a valid new node name`);
          if (g.nodes[op.node]) throw new Error(`${where}: node "${op.node}" already exists (use set/replace)`);
          g.nodes[op.node] = op.spec ?? { type: op.type!, ...(op.in !== undefined ? { in: op.in } : {}), ...(op.params ? { params: op.params } : {}) };
          if (!g.nodes[op.node].type) throw new Error(`${where}: "type" is required`);
          break;
        }
        case 'replace': {
          const n = need(op.node, where);
          g.nodes[n] = op.spec ?? { ...g.nodes[n], ...(op.type ? { type: op.type } : {}), ...(op.params ? { params: op.params } : {}), ...(op.in !== undefined ? { in: op.in } : {}) };
          break;
        }
        case 'remove': {
          const n = need(op.node, where);
          const refs = refsTo(n);
          // reconnect consumers to this node's first input when possible
          const def = this.engine.resolveDef(g.nodes[n].type);
          const up = def ? wiringOf(g.nodes[n], def).list[0] ?? null : null;
          for (const r of refs) setRef(r.node, r.idx, up);
          if (refs.length) notes.push(`removed "${n}"; rewired ${refs.map((r) => r.node).join(', ')} to ${up ?? '(nothing)'}`);
          delete g.nodes[n];
          if (g.output === n) delete g.output;
          break;
        }
        case 'connect': {
          const n = need(op.node, where);
          if (op.in !== undefined) g.nodes[n].in = op.in;
          else if (op.input !== undefined) {
            const spec = g.nodes[n];
            const def = this.engine.resolveDef(spec.type);
            const list = def ? wiringOf(spec, def).list.slice() : [];
            while (list.length <= op.input) list.push(null);
            list[op.input] = op.from ?? null;
            spec.in = list;
          } else throw new Error(`${where}: give "in" (full wiring) or "input" + "from"`);
          break;
        }
        case 'rename': {
          const n = need(op.node, where);
          if (!op.to || !NAME_RE.test(op.to) || g.nodes[op.to]) throw new Error(`${where}: "to" must be a new valid name`);
          g.nodes[op.to] = g.nodes[n];
          delete g.nodes[n];
          for (const r of refsTo(n)) setRef(r.node, r.idx, op.to);
          if (g.output === n) g.output = op.to;
          // expression references: npoints("old"), ch("old/param") …
          const touched: string[] = [];
          for (const [k, spec] of Object.entries(g.nodes)) {
            if (!spec.params) continue;
            const before = JSON.stringify(spec.params);
            spec.params = Object.fromEntries(Object.entries(spec.params).map(([pk, pv]) => [pk, renameExprRefs(pv, n, op.to!)]));
            if (JSON.stringify(spec.params) !== before) touched.push(k);
          }
          if (touched.length) notes.push(`updated expression references to "${n}" in ${touched.join(', ')}`);
          break;
        }
        case 'output': g.output = need(op.node, where); break;
        case 'vars': {
          g.vars = { ...(g.vars ?? {}) };
          for (const [k, v] of Object.entries(op.vars ?? {})) { if (v === null) delete g.vars[k]; else g.vars[k] = v; }
          break;
        }
        case 'bypass': g.nodes[need(op.node, where)].bypass = op.value ?? true; break;
        case 'insert': {
          const after = need(op.after, `${where} after`);
          if (!op.node || !NAME_RE.test(op.node) || g.nodes[op.node]) throw new Error(`${where}: "node" must be a new valid name`);
          if (!op.type && !op.spec) throw new Error(`${where}: "type" is required`);
          const consumers = refsTo(after);
          g.nodes[op.node] = op.spec ?? { type: op.type!, in: [after], ...(op.params ? { params: op.params } : {}) };
          for (const r of consumers) setRef(r.node, r.idx, op.node);
          if (g.output === after) g.output = op.node;
          notes.push(`inserted "${op.node}" after "${after}"${consumers.length ? `; now feeds ${consumers.map((c) => c.node).join(', ')}` : ''}`);
          break;
        }
        default: throw new Error(`${where}: unknown op. Use set, add, remove, connect, rename, output, vars, bypass, replace, insert`);
      }
    }
    return { graph: g, notes };
  }

  // stand-in: session A implements this; the orchestrator keeps A's version at merge
  async edit(name: string, ops: EditOp[], opts?: { frame?: number }): Promise<{ graph: GraphSpec; notes: string[]; report: CookReport }> {
    const { graph, notes } = this.applyEdits(name, ops);
    const v = this.engine.validate(graph);
    if (v.errors.length) throw Object.assign(new Error(`✗ edits rejected (graph unchanged) — ${v.errors.length} error(s):\n` + v.errors.map((e) => `  [${e.node}] ${e.message}`).join('\n')), { errors: v.errors });
    this.setGraph(name, graph);
    let report: CookReport;
    try { report = await this.cook(name, undefined, opts?.frame); } finally { this.bump(name); }
    return { graph: this.getGraph(name), notes, report };
  }

  async cook(name: string, target?: string, frame?: number) {
    const g = this.getGraph(name);
    const r = await this.engine.cook(g, { target, frame });
    if (!target) this.lastReport.set(name, r);
    return r;
  }
}
