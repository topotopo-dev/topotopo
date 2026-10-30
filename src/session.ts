// A session: a folder's named graphs (persisted as JSON files), saved assets, the human's input files, and the engine
// that cooks them. Shared by the MCP server, the live viewer and the CLI.
//   <dir>/graphs/<name>.json   graphs        <dir>/assets/<name>.json   saved assets
//   <dir>/<name>.json          in a project (a folder with project.json), its graph files beside project.json are
//                              graphs too (examples/ keeps its graphs there); graphs/ wins a name both have
//   <dir>/inputs/…             files people drop in (meshes, guide curves, PNG masks), read with file nodes; or a
//                              folder given to the constructor (`topotopo view`: inputs/ beside the graph file)
//   <dir>/exports/…            export output
import fs from 'node:fs';
import path from 'node:path';
import { Engine, wiringOf } from './graph/engine.ts';
import type { CookReport, Issue, NodeProgress, StopSignal } from './graph/engine.ts';
import type { ExportTarget, GraphSpec, NodeDef, NodeSpec } from './graph/types.ts';
import type { PackageResolver, Scope } from './graph/scope.ts';
import { didYouMean, renameExprRefs } from './graph/params.ts';
import { maybeSidecar, sidecarOf } from './io/sidecars.ts';
import type { Sidecar } from './io/sidecars.ts';
import { fileFormat } from './host/sidecars.ts';

export interface EditOp {
  op: 'set' | 'add' | 'remove' | 'connect' | 'rename' | 'output' | 'vars' | 'bypass' | 'replace' | 'insert' | 'export';
  node?: string;
  /** op export: the named output (omitted: the default output) and its target (null removes it) */
  output?: string;
  export?: ExportTarget | null;
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

export const NAME_RE = /^[A-Za-z_][\w.-]*$/;

/** A file under <project>/inputs. */
export interface InputFile {
  /** posix path relative to inputs/ (a file node reads it as "inputs/" + path) */
  path: string;
  /** metadata: an export's sidecar (io/sidecars.ts), which describes the file beside it and is not read as geometry */
  kind: 'geometry' | 'image' | 'metadata' | 'other';
  /** lower-case extension without the dot ("points.json" counts as one) */
  ext: string;
  size: number;
  /** modification time, ms since the epoch */
  mtime: number;
  /** metadata: what it is, and the path (relative to inputs/) of the file or folder it describes, null when that is not there */
  sidecar?: Sidecar;
}

const GEOMETRY_EXTS = new Set(['obj', 'stl', 'ply', 'glb', 'gltf', 'geo', 'bgeo', 'blend', 'csv', 'json', 'points.json']);
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp']);

/** Lower-case extension of a file name without the dot; ".points.json" is one extension, dot-files have none. */
export function inputExt(file: string): string {
  const b = file.toLowerCase().replace(/^.*[\\/]/, '');
  if (b.endsWith('.points.json') && b.length > '.points.json'.length) return 'points.json';
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i + 1) : '';
}

export function inputKind(ext: string): InputFile['kind'] {
  return GEOMETRY_EXTS.has(ext) ? 'geometry' : IMAGE_EXTS.has(ext) ? 'image' : 'other';
}

export interface SessionOptions {
  /**
   * The inputs folder when it is not <dir>/inputs. `topotopo view` keeps its session in a scratch folder but puts
   * inputs/ beside the graph file, where the graph's file nodes read "inputs/<name>" and the files outlive the viewer.
   * load() does not create a folder given here: the first file written into it does (the viewer's upload route), so a
   * graph that never gets a drop leaves no empty inputs/ beside it.
   */
  inputs?: string;
  /** Persistent exports directory; view mode places it beside the source graph. */
  exports?: string;
}

/**
 * Who a session cook is for (Session.cook): "edit" a person's change in the viewer, "preview" what the viewer shows
 * (a node, an output card), "export" an export, "cook" anything else (a reload, an agent's tool). A stop or a newer
 * value stops cooks by kind (Session.stop).
 */
export type CookKind = 'cook' | 'edit' | 'preview' | 'export';

/** The cooks of one graph in progress (Session.activity). */
export interface CookActivity {
  /** cooks in progress, and their kinds */
  cooks: number;
  kinds: CookKind[];
  /** ms the graph has been cooking: since the oldest of them started, or the cook a newer value's cook followed */
  elapsed: number;
  /** the graph's node that has been cooking longest (null between nodes), ms since it started */
  node: string | null;
  nodeElapsed: number;
  /** the node a nested cook inside it is on (an asset's, a foreach body's, a solver step's) */
  inner: string | null;
  /** a person stopped every one of them and they have not ended yet: a node runs to its end, the cook stops after it */
  stopping: boolean;
  /** one of them is stopping for a newer value, which cooks once it has ended */
  superseded: boolean;
}

/** How the last cook of a whole graph (no target) ended (Session.lastCook). */
export interface CookOutcome {
  ok: boolean;
  ms: number;
  /** it was stopped at this node */
  stopped?: string;
  /** its first error: the failing node and the message */
  error?: Issue;
  /** when it ended (ms since the epoch) */
  at: number;
}

interface RunningCook {
  kind: CookKind;
  ac: AbortController;
  /** stopped for a newer value: its outcome is not the graph's (lastCook) */
  superseded?: boolean;
  t0: number;
  /** graph nodes cooking now, and since when */
  nodes: Map<string, number>;
  /** graph node → the node of a nested cook inside it */
  inner: Map<string, string>;
}

const now = () => performance.now();
const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A var's value in a graph: its "vars" entry, else the default its "params" entry declares. */
export function graphVarValue(g: GraphSpec, k: string): unknown {
  return g.vars && Object.hasOwn(g.vars, k) ? g.vars[k] : g.params?.[k]?.default;
}

/**
 * What a session value of var `k` depends on in a graph: the declared type, range and options, and the kind of the
 * graph's value (a number, a string, a 3-vector …). null when the graph has no such var (neither in vars nor params).
 */
export function varDeclaration(g: GraphSpec, k: string): string | null {
  const vd = g.params?.[k];
  if (!vd && !(g.vars && Object.hasOwn(g.vars, k))) return null;
  const v = graphVarValue(g, k);
  const kind = Array.isArray(v) ? `array${v.length}` : v === null || v === undefined ? 'none' : typeof v;
  return JSON.stringify([vd?.type ?? null, vd?.min ?? null, vd?.max ?? null, vd?.options ?? null, kind]);
}

/** Thrown by Session.edit when the edited graph does not validate; the stored graph is unchanged. */
export class EditRejected extends Error {
  errors: Issue[];
  constructor(errors: Issue[], notes: string[] = []) {
    super(`✗ edits rejected (graph unchanged) — ${errors.length} error(s):\n` + errors.map((e) => `  [${e.node}] ${e.message}${e.hint ? `\n     hint: ${e.hint}` : ''}`).join('\n') + notes.map((n) => `\nnote: ${n}`).join(''));
    this.name = 'EditRejected';
    this.errors = errors;
  }
}

/** The folders a project makes in its own folder (Session.load): graphs, assets, exports and inputs. */
export const PROJECT_FOLDERS = ['graphs', 'assets', 'exports', 'inputs'];

/** A graph file's text holds a graph: an object with "nodes" (project.json and other JSON files do not). */
const holdsGraph = (j: unknown) => !!j && typeof j === 'object' && !Array.isArray(j) && !!(j as any).nodes && typeof (j as any).nodes === 'object';

/**
 * The graph files of a folder by graph name: graphs/<name>.json, and in a project (a folder holding project.json) the
 * graph files beside project.json, not below it, whose name graphs/ does not have. A file there is a graph when it
 * holds an object with "nodes"; an unreadable one is left out. The gallery, `topotopo edit` and the MCP server read a
 * project's graphs here.
 */
export function graphFiles(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const json = (d: string) => { try { return fs.readdirSync(d).filter((f) => f.endsWith('.json')).sort(); } catch { return []; } };
  for (const f of json(path.join(dir, 'graphs'))) {
    const name = f.slice(0, -'.json'.length);
    if (NAME_RE.test(name)) out.set(name, path.join(dir, 'graphs', f));
  }
  if (!fs.existsSync(path.join(dir, 'project.json'))) return out;
  for (const f of json(dir)) {
    const name = f.slice(0, -'.json'.length), file = path.join(dir, f);
    if (f === 'project.json' || out.has(name) || !NAME_RE.test(name)) continue;
    try { if (fs.statSync(file).isFile() && holdsGraph(JSON.parse(fs.readFileSync(file, 'utf8')))) out.set(name, file); } catch { /* not a graph */ }
  }
  return out;
}

/**
 * The packages of the project a session's folder belongs to (src/packages/registry.ts), attached by whoever opens it: a graph
 * set or edited through the project that names a package the project does not use yet adds it (first use).
 */
export interface SessionPackages {
  /**
   * add the packages a graph names that the project does not use yet, once the graph validates (nothing is written for
   * one that does not); says what was added
   */
  addFor(graph: GraphSpec): string[];
  /**
   * what a graph is checked with where nothing may be written (a dry run, a trial of a person's values): the project's
   * packages, and those the graph names for the first time at the version build or edit would add, read where a library
   * holds them, nothing copied; the notes say what build or edit add; `id` is the id of a scope that resolves with it
   */
  dryRun(graph: GraphSpec): { resolver: PackageResolver; notes: string[]; id: string };
  /**
   * the node type of an output of a package the project does not use yet, read where a library it looks in holds the
   * newest version (nothing copied): what help says about an output search found; null when none has it
   */
  describe(name: string): NodeDef | null;
  /** why the project's graphs cannot use packages, and how that changes (null when they can) */
  notice(): string | null;
  /** read again what changed on disk (project.json, the lock, working folders followed this session); true if anything did */
  refresh(): boolean;
  /**
   * a stamp of what package names resolve to (the uses, the copies, the followed working folders): a result that may use
   * a package is kept only while it stays the same (the viewer's previews, a person's stop)
   */
  revision(): string;
}

export class Session {
  dir: string;
  engine: Engine;
  graphs = new Map<string, GraphSpec>();
  versions = new Map<string, number>();
  lastReport = new Map<string, CookReport>();
  /** how the last cook of each whole graph ended, stopped ones included (lastReport keeps the last one that ran through) */
  lastCook = new Map<string, CookOutcome>();
  listeners = new Set<(ev: { graph: string; version: number }) => void>();
  /** told when the cooks of a graph start, move to another node (with that node's event), are asked to stop and end (see activity) */
  activityListeners = new Set<(graph: string, ev?: NodeProgress) => void>();
  /** the packages of the project the session's folder belongs to, when whoever opened it attached them (src/packages/registry.ts) */
  packages: SessionPackages | null = null;
  /**
   * Session values: var values a person set in the live viewer over a graph file (`topotopo view`). They shadow the
   * graph's vars in this project's cooks without changing the graph, and stay when the graph is replaced (a reload
   * of the file) unless the var's declaration changed (varDeclaration), the var is gone, or the graph now holds the
   * same value itself. graph → var → value and the declaration it was set under.
   */
  private sessions = new Map<string, Map<string, { value: unknown; decl: string | null }>>();
  private running = new Map<string, Set<RunningCook>>();
  /** per graph: since when it has been cooking, through cooks that follow one another (a newer value's), and when it last fell idle */
  private busy = new Map<string, { since: number; idleAt: number | null }>();
  private holds = new Map<string, string>();
  /** per graph: the last whole-graph cook started, and the newest one whose outcome was recorded */
  private cookSeq = new Map<string, number>();
  private recordedSeq = new Map<string, number>();
  private lastYield = 0;
  /** graphs kept in a project's own folder (graphFiles): their file, where they are saved; the others go in graphs/ */
  private besideProject = new Map<string, string>();
  /** the inputs folder given to the constructor (SessionOptions.inputs), if any */
  private inputsAt: string | undefined;
  private exportsAt: string | undefined;

  constructor(dir: string, engine: Engine, opts: SessionOptions = {}) {
    this.dir = path.resolve(dir);
    this.engine = engine;
    this.inputsAt = opts.inputs === undefined ? undefined : path.resolve(opts.inputs);
    this.exportsAt = opts.exports === undefined ? undefined : path.resolve(opts.exports);
    engine.root.graphs = (n) => this.graphs.get(n);
  }

  // the folders of PROJECT_FOLDERS
  get graphDir() { return path.join(this.dir, 'graphs'); }
  get assetDir() { return path.join(this.dir, 'assets'); }
  get exportDir() { return this.exportsAt ?? path.join(this.dir, 'exports'); }
  /**
   * files people drop in: meshes, guide curves and points, PNG masks and heightmaps (read as "inputs/<path>");
   * <dir>/inputs unless the constructor was given another folder
   */
  get inputDir() { return this.inputsAt ?? path.join(this.dir, 'inputs'); }

  load() {
    // the project's own inputs/ is made at once (people open it to drop files in); a folder given to the constructor
    // is made by the first file written into it
    for (const d of [this.dir, this.graphDir, this.assetDir, this.exportDir, ...(this.inputsAt ? [] : [this.inputDir])]) fs.mkdirSync(d, { recursive: true });
    // as a package version reads them (registerAssets): an asset that uses one registered later is tried again
    const assetErrors: string[] = [], graphErrors: string[] = [];
    registerAssets(this.engine, this.engine.root, this.dir, assetErrors);
    for (const [name, file] of graphFiles(this.dir)) {
      try { this.graphs.set(name, JSON.parse(fs.readFileSync(file, 'utf8'))); }
      catch (e: any) { graphErrors.push(`${path.relative(this.dir, file).split(path.sep).join('/')}: ${e.message}`); continue; }
      if (path.dirname(file) === this.dir) this.besideProject.set(name, file);
    }
    return { graphs: this.graphs.size, assets: this.engine.assetsIn().length, assetErrors, graphErrors };
  }

  /** Where a graph is saved: its file beside project.json, or graphs/<name>.json. */
  graphFile(name: string): string {
    return this.besideProject.get(name) ?? path.join(this.graphDir, name + '.json');
  }

  private persist(name: string) {
    const g = this.graphs.get(name);
    const file = this.graphFile(name);
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
    this.graphs.set(name, spec);
    this.settleSession(name);
    this.persist(name);
  }

  deleteGraph(name: string) {
    this.getGraph(name);
    this.graphs.delete(name);
    this.sessions.delete(name);
    this.persist(name);
  }

  // ------------------------------------------------------------ session values

  /** The session values of a graph (the vars that differ from the graph's own), {} when there are none. */
  sessionVars(name: string): Record<string, any> {
    return Object.fromEntries([...(this.sessions.get(name) ?? [])].map(([k, e]) => [k, e.value]));
  }

  /**
   * Set session values of a graph (null: back to the graph's value). They are not checked here: validate the graph
   * with them first (Engine.validate on effectiveGraph). A value the graph holds itself is no session value.
   */
  setSessionVars(name: string, vars: Record<string, any>) {
    const g = this.getGraph(name);
    let s = this.sessions.get(name);
    if (!s) this.sessions.set(name, s = new Map());
    for (const [k, v] of Object.entries(vars)) {
      if (v === null) s.delete(k);
      else s.set(k, { value: structuredClone(v), decl: varDeclaration(g, k) });
    }
    this.settleSession(name);
  }

  /** The graph as its cooks see it: its vars with the session values over them. */
  effectiveGraph(name: string): GraphSpec {
    const g = this.getGraph(name), s = this.sessions.get(name);
    return s?.size ? { ...g, vars: { ...(g.vars ?? {}), ...this.sessionVars(name) } } : g;
  }

  /** Keep the session values that still apply to the graph as it is now (see sessions). */
  private settleSession(name: string) {
    const s = this.sessions.get(name);
    if (!s) return;
    const g = this.graphs.get(name);
    for (const [k, e] of s) {
      const decl = g ? varDeclaration(g, k) : null;
      if (!g || decl === null || decl !== e.decl || sameValue(graphVarValue(g, k), e.value)) s.delete(k);
    }
    if (!s.size) this.sessions.delete(name);
  }

  // ------------------------------------------------------------ cooks in progress

  /** What is cooking for a graph now, or null. */
  activity(name: string): CookActivity | null {
    const runs = this.running.get(name);
    if (!runs?.size) return null;
    const t = now();
    let t0 = this.busy.get(name)?.since ?? Infinity, node: string | null = null, nodeT0 = Infinity, inner: string | null = null, stopping = true, superseded = false;
    const kinds = new Set<CookKind>();
    for (const r of runs) {
      t0 = Math.min(t0, r.t0);
      stopping &&= r.ac.signal.aborted && !r.superseded;
      superseded ||= r.ac.signal.aborted && !!r.superseded;
      kinds.add(r.kind);
      for (const [n, since] of r.nodes) if (since < nodeT0) { nodeT0 = since; node = n; inner = r.inner.get(n) ?? null; }
    }
    return { cooks: runs.size, kinds: [...kinds], elapsed: t - t0, node, nodeElapsed: node ? t - nodeT0 : 0, inner, stopping, superseded };
  }

  /**
   * Stop the cooks of a graph in progress (all, or those of the given kinds) at their next node boundary; returns how
   * many were asked to. `superseded`: they stop for a newer value, and how they end is not the graph's last outcome.
   */
  stop(name: string, kinds?: CookKind[], opts: { superseded?: boolean } = {}): number {
    let n = 0;
    for (const r of this.running.get(name) ?? []) {
      if (kinds && !kinds.includes(r.kind)) continue;
      // a person's stop of a cook already stopping for a newer value: now it is theirs
      if (r.ac.signal.aborted) { if (r.superseded && !opts.superseded) { r.superseded = false; n++; } continue; }
      r.superseded = !!opts.superseded;
      r.ac.abort();
      n++;
    }
    if (n) this.notifyActivity(name);
    return n;
  }

  /**
   * Hold a graph as it is now (a person stopped its cooks): held() is true until the graph, its session values or the
   * packages it can use change, and what cooks on its own (the viewer's previews) waits for that change instead of
   * cooking it again.
   */
  hold(name: string) {
    if (this.graphs.has(name)) this.holds.set(name, this.holdKey(name));
  }

  held(name: string): boolean {
    const h = this.holds.get(name);
    if (h === undefined) return false;
    if (this.graphs.has(name) && h === this.holdKey(name)) return true;
    this.holds.delete(name);
    return false;
  }

  private holdKey(name: string): string {
    return JSON.stringify(this.effectiveGraph(name)) + (this.packages ? `|${this.packages.revision()}` : '');
  }

  private notifyActivity(name: string, ev?: NodeProgress) {
    for (const l of this.activityListeners) try { l(name, ev); } catch { /* ignore */ }
  }

  /**
   * The progress hook of one cook: tracks its nodes, and lets the event loop turn (requests, a stop, the progress the
   * listeners send) before each of the graph's nodes cooks, which may hold the thread for long, and at least every
   * 15 ms between the nodes of nested cooks and the steps of long nodes.
   */
  private onNode(name: string, run: RunningCook, ev: NodeProgress): Promise<void> | void {
    if (ev.phase !== 'step') {
      if (ev.depth === 0) {
        if (ev.phase === 'start') run.nodes.set(ev.node, now());
        else { run.nodes.delete(ev.node); run.inner.delete(ev.node); }
      } else if (ev.phase === 'start' && ev.within.length) run.inner.set(ev.within[0], ev.node);
      this.notifyActivity(name, ev);
    }
    if (ev.phase === 'end' || (ev.depth > 0 || ev.phase === 'step') && now() - this.lastYield <= 15) return;
    this.lastYield = now();
    return new Promise<void>((resolve) => setImmediate(resolve));
  }

  /**
   * Every file under inputs/, recursively: posix paths relative to it, sorted. Dot-files and dot-folders are skipped.
   * An export's sidecar (a heightmap's .json, <file>.source.json …) is kind "metadata", with the file it describes.
   */
  listInputs(): InputFile[] {
    const out: InputFile[] = [];
    const walk = (dir: string, rel: string, depth: number) => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const abs = path.join(dir, e.name), r = rel ? `${rel}/${e.name}` : e.name;
        let st: fs.Stats;
        try { st = fs.statSync(abs); } catch { continue; } // a broken link
        if (st.isDirectory()) { if (depth < 32) walk(abs, r, depth + 1); } // the depth cap stops link cycles
        else if (st.isFile()) {
          const ext = inputExt(e.name);
          out.push({ path: r, kind: inputKind(ext), ext, size: st.size, mtime: Math.round(st.mtimeMs) });
        }
      }
    };
    walk(this.inputDir, '', 0);
    // sidecars: the files and folders here are what they can describe
    const there = new Set(out.flatMap((f) => f.path.split('/').map((_, i, s) => s.slice(0, i + 1).join('/'))));
    for (const f of out) {
      if (!maybeSidecar(f.path)) continue;
      const s = sidecarOf(f.path, fileFormat(path.join(this.inputDir, ...f.path.split('/'))), (p) => there.has(p));
      if (s) { f.kind = 'metadata'; f.sidecar = s; }
    }
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /** Merge nodes/vars/output of `patch` into an existing graph (upsert). */
  mergeGraph(name: string, patch: GraphSpec): GraphSpec {
    patch = patch;
    const base = structuredClone(this.graphs.get(name) ?? { nodes: {} });
    Object.assign(base.nodes, patch.nodes ?? {});
    if (patch.vars) base.vars = { ...(base.vars ?? {}), ...patch.vars };
    if (patch.params) base.params = { ...(base.params ?? {}), ...patch.params };
    if (patch.output) base.output = patch.output;
    if (patch.outputs) base.outputs = { ...base.outputs, ...patch.outputs };
    if (patch.export !== undefined) base.export = patch.export;
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
          for (const [id, out] of Object.entries(g.outputs ?? {})) if (out.node === n) delete g.outputs![id];
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
          for (const out of Object.values(g.outputs ?? {})) if (out.node === n) out.node = op.to;
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
        case 'export': {
          // the target of the default output, or of a named one; null removes it (validated with the graph)
          if (op.export === undefined) throw new Error(`${where}: give "export": a format ("glb"), {format, path?, ...options}, or null`);
          if (op.output === undefined) { if (op.export === null) delete g.export; else g.export = op.export; break; }
          const out = g.outputs?.[op.output];
          if (!out) {
            const s = didYouMean(op.output, Object.keys(g.outputs ?? {}));
            throw new Error(`${where}: no output "${op.output}"${s.length ? ` — did you mean ${s.join(', ')}?` : ''} (publish it in "outputs" first)`);
          }
          if (op.export === null) delete out.export; else out.export = op.export;
          break;
        }
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
        default: throw new Error(`${where}: unknown op. Use set, add, remove, connect, rename, output, vars, bypass, replace, insert, export`);
      }
    }
    return { graph: g, notes };
  }

  /**
   * The one path for an edit, whoever makes it (the MCP edit tool, the viewer's controls): apply the ops, validate as a
   * dry run sees the graph (an invalid result throws EditRejected listing the per-node errors, and stores, adds and
   * writes nothing), add the packages the graph now names to the project (first use), store, cook at `frame`, then
   * notify the listeners. They hear after the cook so that what they read (lastReport, cached geometry) is the new
   * version's; a cook that throws still notifies, since the graph was stored. A cook that was stopped (`signal`,
   * Session.stop) does not: whoever stopped it cooks again or tells the listeners.
   */
  async edit(name: string, ops: EditOp[], opts: { frame?: number; kind?: CookKind; signal?: StopSignal } = {}): Promise<{ graph: GraphSpec; notes: string[]; report: CookReport }> {
    const { graph, notes } = this.applyEdits(name, ops);
    const v = this.engine.validate(graph, '', this.dryScope(graph).scope);
    if (v.errors.length) throw new EditRejected(v.errors, notes);
    notes.push(...(this.packages?.addFor(graph) ?? []));
    this.setGraph(name, graph);
    let report: CookReport | undefined;
    try { report = await this.cook(name, undefined, opts.frame, { kind: opts.kind, signal: opts.signal }); }
    finally { if (!report?.stopped) this.bump(name); }
    return { graph: this.getGraph(name), notes, report };
  }

  /**
   * The scope a graph is checked in where nothing may be written (a dry run, a trial of a person's values): the
   * engine's root, whose packages include those the graph names for the first time at the version build or edit would
   * add (SessionPackages.dryRun), with notes that say so, under an id of its own. Nothing is copied or written.
   */
  dryScope(graph: GraphSpec): { scope: Scope; notes: string[] } {
    const root = this.engine.root, d = this.packages?.dryRun(graph);
    if (!d || d.resolver === root.packages) return { scope: root, notes: d?.notes ?? [] };
    return { scope: { ...root, id: d.id, packages: d.resolver }, notes: d.notes };
  }

  /**
   * Cook a graph (its output, or `target`) with its session values, as a cook of `kind`. Session.stop and `signal`
   * stop it at a node boundary; activity() reports it while it runs. A cook of the whole graph records its outcome
   * (lastCook) and, unless it was stopped, its report (lastReport), when no cook started after it has done so first.
   */
  async cook(name: string, target?: string, frame?: number, opts: { kind?: CookKind; signal?: StopSignal } = {}) {
    const g = this.getGraph(name);
    // a followed working folder edited since the last cook resolves to its new files
    this.packages?.refresh();
    const run: RunningCook = { kind: opts.kind ?? 'cook', ac: new AbortController(), t0: now(), nodes: new Map(), inner: new Map() };
    const outer = opts.signal;
    const signal: StopSignal = { get aborted() { return run.ac.signal.aborted || !!outer?.aborted; } };
    const seq = target ? 0 : (this.cookSeq.get(name) ?? 0) + 1;
    if (seq) this.cookSeq.set(name, seq);
    let runs = this.running.get(name);
    if (!runs) this.running.set(name, runs = new Set());
    runs.add(run);
    // the cook of a newer value that follows the one it stopped within 100 ms continues its busy time
    const b = this.busy.get(name);
    if (b && (b.idleAt === null || (run.t0 - b.idleAt <= 100 && run.kind === 'edit'))) b.idleAt = null;
    else this.busy.set(name, { since: run.t0, idleAt: null });
    this.notifyActivity(name);
    try {
      const s = this.sessions.get(name);
      const r = await this.engine.cook(g, { target, frame, signal, onNode: (ev) => this.onNode(name, run, ev), ...(s?.size ? { vars: this.sessionVars(name) } : {}) });
      if (seq && !(r.stopped && run.superseded) && seq > (this.recordedSeq.get(name) ?? 0)) {
        this.recordedSeq.set(name, seq);
        if (!r.stopped) this.lastReport.set(name, r);
        // a cook that found every result cached (a target set, a reload without change) keeps the outcome of the
        // cook that made them: its time is what the graph takes
        const fresh = [...r.results.values()].some((x) => !x.cached);
        if (!r.ok || fresh || !this.lastCook.get(name)?.ok)
          this.lastCook.set(name, { ok: r.ok, ms: r.ms, at: Date.now(), ...(r.stopped ? { stopped: r.stopped } : {}), ...(r.errors[0] ? { error: r.errors[0] } : {}) });
      }
      return r;
    } finally {
      runs.delete(run);
      if (!runs.size) { this.running.delete(name); this.busy.get(name)!.idleAt = now(); }
      this.notifyActivity(name);
    }
  }

  private watchers: fs.FSWatcher[] = [];
  private watchTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Follow what other processes write into graphs/ and assets/, and in a project the graph files beside project.json (a
   * second Session on the same folder: the gallery's editor next to an MCP server, or a person editing the JSON). A
   * graph file whose content differs from the stored graph replaces it and notifies the listeners; a removed file
   * removes the graph. Our own writes read back equal, so they change nothing. An asset whose content changed is
   * registered again and every graph is notified (any may use it); a removed asset stays registered until the next
   * load(). Two writers to one graph: the last write wins.
   */
  watch() {
    if (this.watchers.length) return;
    const on = (dir: string, apply: (name: string, file: string) => void) => {
      try {
        const w = fs.watch(dir, (_ev, f) => {
          const rel = f ? String(f) : '';
          // Windows names a removed folder by its absolute path: stop rather than follow a folder that is gone
          if (path.isAbsolute(rel)) { w.close(); return; }
          if (!rel.endsWith('.json') || rel.includes(path.sep) || rel.startsWith('.')) return;
          const name = rel.slice(0, -'.json'.length), key = dir + '|' + name;
          clearTimeout(this.watchTimers.get(key));
          // persist() is not atomic: let the writer finish, and read again if the JSON is still half written
          let tries = 0;
          const run = () => {
            this.watchTimers.delete(key);
            try { apply(name, path.join(dir, rel)); }
            catch (e) { if (e instanceof SyntaxError && ++tries < 5) this.watchTimers.set(key, setTimeout(run, 100).unref()); }
          };
          this.watchTimers.set(key, setTimeout(run, 150).unref());
        });
        w.on('error', () => w.close());
        w.unref();
        this.watchers.push(w);
      } catch { /* no folder: nothing to follow */ }
    };
    const graphChanged = (name: string, file: string) => {
      if (!NAME_RE.test(name) || this.graphFile(name) !== file) return;
      if (!fs.existsSync(file)) {
        this.besideProject.delete(name);
        if (this.graphs.delete(name)) { this.lastReport.delete(name); this.bump(name); }
        return;
      }
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!holdsGraph(j)) return;
      const spec = j;
      const cur = this.graphs.get(name);
      if (cur && JSON.stringify(cur) === JSON.stringify(spec)) return;
      this.graphs.set(name, spec);
      this.settleSession(name);
      this.lastReport.delete(name);
      this.bump(name);
    };
    on(this.graphDir, graphChanged);
    // a project's graph files beside project.json, when graphs/ has no graph of that name
    if (fs.existsSync(path.join(this.dir, 'project.json'))) on(this.dir, (name, file) => {
      if (name === 'project' || fs.existsSync(path.join(this.graphDir, name + '.json'))) return;
      if (!this.graphs.has(name) && fs.existsSync(file)) this.besideProject.set(name, file);
      graphChanged(name, file);
    });
    on(this.assetDir, (name, file) => {
      if (!fs.existsSync(file)) return;
      const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
      const before = this.engine.asset(name)?.hash;
      this.engine.registerAsset(name, spec);
      if (this.engine.asset(name)?.hash === before) return;
      for (const g of this.graphs.keys()) { this.lastReport.delete(g); this.bump(g); }
    });
  }

  /** Stop following the folders (watch()). */
  unwatch() {
    for (const w of this.watchers) w.close();
    for (const t of this.watchTimers.values()) clearTimeout(t);
    this.watchers = [];
    this.watchTimers.clear();
  }
}

/** Register a folder's assets/*.json into a scope; an asset that uses one registered later is tried again. */
export function registerAssets(engine: Engine, scope: Scope, dir: string, problems: string[]) {
  let pending: { name: string; graph: GraphSpec }[] = [];
  let files: string[] = [];
  try { files = fs.readdirSync(path.join(dir, 'assets')).filter((f) => f.endsWith('.json')).sort(); } catch { /* no assets */ }
  for (const f of files) {
    try { pending.push({ name: f.slice(0, -5), graph: JSON.parse(fs.readFileSync(path.join(dir, 'assets', f), 'utf8')) }); }
    catch (e: any) { problems.push(`assets/${f}: ${e.message}`); }
  }
  for (let pass = 0; pending.length; pass++) {
    const failed: { name: string; graph: GraphSpec; error: string }[] = [];
    for (const a of pending) {
      try { engine.registerAsset(a.name, a.graph, { scope }); }
      catch (e: any) { failed.push({ ...a, error: e.message }); }
    }
    if (failed.length === pending.length || pass > 8) { for (const a of failed) problems.push(`assets/${a.name}.json: ${a.error}`); break; }
    pending = failed;
  }
}
