// Packages, the engine side: the node type of a package output, and the packages a graph names and uses. The host's
// package registry (src/gallery/packages.ts) reads the versions from disk and gives each scope its PackageResolver
// (src/graph/scope.ts): the project's root resolves names by the project's uses, a version by its own.
//
// A package is a project with a full name ("owner/name") and published versions: frozen copies of its graphs, assets
// and inputs. A graph uses an output of one as a node type, "owner/name/output", or "owner/name" for the package's
// default output. A package output cooks its graph in the version's own scope (its assets, graphs, files and
// packages), so nothing leaks between the project and the package and two versions of one package cook side by side.
// Its signature is the version's hash and the node it cooks: a frozen version cooks once for the project and once for
// the packages that use it (which name its texture files differently).
//
// A package's graphs name its own outputs by full name too (a kit whose pieces build on each other: a house of the
// kit's walls): they resolve to the same version, or the same working folder, with no entry in its uses. Outputs that
// name each other in a loop do not resolve (ownOutputsNamed finds what each output names).
import { Geometry } from '../core/geometry.ts';
import { rebaseTexturePaths } from '../core/materials.ts';
import { codeVarNames } from '../core/usercode.ts';
import { graphInterface } from './engine.ts';
import type { Engine } from './engine.ts';
import type { Kind } from './outputs.ts';
import { scanValue } from './params.ts';
import { getNodeDef } from './registry.ts';
import { parsePackageName } from './scope.ts';
import type { Scope } from './scope.ts';
import { NodeError } from './types.ts';
import type { GraphSpec, NodeDef } from './types.ts';

/** What the node type of a package output cooks (NodeDef.package). */
export interface PackageOutput {
  /** "owner/name" */
  package: string;
  /** the published version ("1.3"), or null for a working folder followed this session */
  version: string | null;
  /** the version's hash; a followed working folder's: the hash its files have now */
  hash: string;
  /** what keys its results: the hash, for a followed working folder the hash of every folder followed */
  signature: string;
  /** the output's name, null for the package's default output */
  output: string | null;
  /** the graph that holds it (its name in graphs/) and the node it cooks */
  graph: string;
  spec: GraphSpec;
  node: string;
  /** the version's scope: its own assets, graphs, files and packages */
  scope: Scope;
  /** the author's note on the version */
  note?: string;
  /** the output's label in its graph */
  label?: string;
  /**
   * what it is and the words search finds it by: as the version records them, or for a working folder the kind its
   * author pinned and its tags (src/graph/outputs.ts)
   */
  kind?: Kind;
  tags?: string[];
  /** a problem every cook repeats (a copy edited by hand) */
  warning?: string;
  /**
   * How the root names a file of the version, given its absolute path: relative to the root's folder when the version
   * lies inside the root's project, so exports stay portable, else the absolute path. The registry gives it (the core
   * has no paths); absent, texture paths are absolute.
   */
  rootPath?: (absolute: string) => string;
}

/** "studio/trees 1.3", or "studio/trees (working folder)" for one followed this session. */
export const packageAt = (o: Pick<PackageOutput, 'package' | 'version'>) => (o.version === null ? `${o.package} (working folder)` : `${o.package} ${o.version}`);

/**
 * The node type of a package output: the vars of its graph that its node reads (varsRead) are its params, and its
 * graph's input nodes the inputs, as for assets. A graph that describes itself gives the catalog's summary (its
 * description's first sentence) and the rest of the text.
 */
export function packageOutputDef(o: PackageOutput): NodeDef {
  const type = o.output === null ? o.package : `${o.package}/${o.output}`;
  const at = packageAt(o);
  const { params: all, inputs } = graphInterface(o.spec);
  const read = new Set(varsRead(o.spec, o.node));
  const params = Object.fromEntries(Object.entries(all).filter(([k]) => read.has(k)));
  const what = `${o.output === null ? 'the default output' : `output "${o.output}"`} of package ${at}${o.label ? ` (${o.label})` : ''}`;
  const desc = typeof o.spec.description === 'string' ? o.spec.description.trim() : '';
  const split = /^(.+?[.!?])\s+(.+)$/s.exec(desc);
  const cooks = `it cooks node "${o.node}" of the package's graph "${o.graph}"; its params are the vars of that graph the node reads.`;
  return {
    type,
    category: 'package',
    summary: desc ? split?.[1] ?? desc : what,
    description: [split?.[2] ?? '', o.note ? `${at}: ${o.note}` : '', desc ? `${what[0].toUpperCase()}${what.slice(1)}: ${cooks}` : `${cooks[0].toUpperCase()}${cooks.slice(1)}`].filter(Boolean).join('\n'),
    inputs,
    params,
    package: o,
    // the version is frozen: its hash and the node say what it cooks, in a scope of its own (no usesScope); a result
    // for the root names its textures as the root does (rootPath), one for another scope absolutely
    signatureExtra: (_p, scope) => `${o.signature}|${o.graph}/${o.node}${o.rootPath && scope.id ? '|nested' : ''}`,
    // the package's own nodes unpack what they need
    packed: 'keep',
    async cook(ctx) {
      if (o.warning) ctx.warn(o.warning);
      const r = await ctx.subcook(o.spec, {
        scope: o.scope, target: o.node, vars: ctx.p,
        inputs: ctx.inputs.map((g, i) => ({ geo: g ?? new Geometry(), sig: ctx.inputSigs[i] ?? 'none' })),
      });
      for (const w of r.warnings) ctx.warn(`[${w.node}] ${w.message}`);
      if (!r.ok || !r.geo) throw new NodeError(`${type} (${at}) failed: ${r.errors.map((e) => `${e.node}: ${e.message}`).join('; ')}`);
      // texture paths relative to the version's folder would be read from the project's: they name the version's files.
      // Inside another package's scope they are absolute (that package names them for the root in turn, its own and
      // those of the packages it uses alike); for the root, as the root names them.
      const forRoot = !ctx.scope.id ? o.rootPath : undefined;
      return rebaseTexturePaths(r.geo, (p, relative) => {
        const abs = relative ? o.scope.files.resolvePath(p) : p;
        return forRoot ? forRoot(abs) : abs;
      });
    },
  };
}

const isGraph = (v: unknown): v is GraphSpec => !!v && typeof v === 'object' && !Array.isArray(v) && !!(v as GraphSpec).nodes && typeof (v as GraphSpec).nodes === 'object';

/** The packages ("owner/name") a graph names as node types, in its nested graphs too (foreach and solver bodies). */
export function packagesNamedIn(graph: GraphSpec): string[] {
  const out = new Set<string>();
  const walk = (g: GraphSpec, depth: number) => {
    if (depth > 64) return;
    for (const node of Object.values(g.nodes)) {
      if (!node || typeof node !== 'object') continue;
      if (typeof node.type === 'string' && node.type.includes('/')) {
        const n = parsePackageName(node.type);
        if (typeof n !== 'string') out.add(n.package);
      }
      if (node.params && typeof node.params === 'object') for (const v of Object.values(node.params)) if (isGraph(v)) walk(v, depth + 1);
    }
  };
  if (isGraph(graph)) walk(graph, 0);
  return [...out];
}

/** The nodes of a graph a cook of `node` reaches: the node, its inputs and the nodes its expressions read, upstream. */
export function upstreamOf(g: GraphSpec, node: string): string[] {
  const keep = new Set<string>(), todo = [node];
  while (todo.length) {
    const n = todo.pop()!;
    if (keep.has(n) || !Object.hasOwn(g.nodes, n)) continue;
    keep.add(n);
    const spec = g.nodes[n];
    const wired = typeof spec?.in === 'string' ? [spec.in] : Array.isArray(spec?.in) ? spec.in : spec?.in && typeof spec.in === 'object' ? Object.values(spec.in) : [];
    for (const w of wired) if (typeof w === 'string') todo.push(w);
    const refs = scanValue(Object.values(spec?.params ?? {}));
    todo.push(...refs.geo, ...refs.ch.map((c) => c.node));
  }
  return [...keep];
}

/**
 * The vars of a graph that a cook of its node `node` reads: the vars named in the "=expr" params, code and other text
 * params of the nodes it reaches (upstream), and in the nested graphs of those nodes (all of their nodes: a foreach
 * body reads its graph's vars). They are the params of a package output that cooks that node; a var the node does not
 * read changes nothing about it. Sorted.
 */
export function varsRead(graph: GraphSpec, node: string): string[] {
  const vars = graph.vars ?? {};
  if (!Object.keys(vars).length) return [];
  const out = new Set<string>();
  const names = (s: string) => { for (const n of codeVarNames(s, vars)) out.add(n); };
  // a param's value: "=expr" anywhere; whole text where text is read as code or an expression (code, groups, strings)
  const value = (v: unknown, text: boolean, depth: number) => {
    if (depth > 64) return;
    if (typeof v === 'string') { if (v.startsWith('=') || text) names(v); }
    else if (Array.isArray(v)) for (const x of v) value(x, text, depth + 1);
    else if (isGraph(v)) for (const n of Object.keys(v.nodes)) nodeParams(v, n, depth + 1);
    else if (v && typeof v === 'object') for (const x of Object.values(v)) value(x, text, depth + 1);
  };
  const nodeParams = (g: GraphSpec, n: string, depth: number) => {
    const spec = g.nodes[n];
    if (!spec || typeof spec !== 'object' || !spec.params || typeof spec.params !== 'object') return;
    const def = typeof spec.type === 'string' ? getNodeDef(spec.type) : undefined;
    for (const [k, v] of Object.entries(spec.params)) {
      const t = def?.params[k]?.type;
      value(v, t === undefined || t === 'code' || t === 'group' || t === 'string' || t === 'json', depth);
    }
  };
  if (!Object.hasOwn(graph.nodes, node)) return [];
  for (const n of upstreamOf(graph, node)) nodeParams(graph, n, 0);
  return [...out].sort();
}

/**
 * The outputs of package `pkg` that a cook of node `node` of `graph` names in `scope` (the package's own scope): by full
 * name, upstream of the node, in the nested graphs of those nodes (all of their nodes), and in the asset and graph_ref
 * graphs they cook there. Each output by its name, "" for the package's default output ("owner/name" alone).
 */
export function ownOutputsNamed(pkg: string, graph: GraphSpec, node: string, scope: Scope): string[] {
  const out = new Set<string>();
  const done = new Map<GraphSpec, Set<string>>();
  // `from`: the node whose upstream is cooked, null for every node of the graph
  const visit = (g: GraphSpec, from: string | null, depth: number) => {
    if (depth > 64 || !isGraph(g)) return;
    let seen = done.get(g);
    if (!seen) done.set(g, seen = new Set());
    const key = from ?? '\u0000all';
    if (seen.has(key)) return;
    seen.add(key);
    const at = (x: GraphSpec, n: unknown) => (typeof n === 'string' && n && Object.hasOwn(x.nodes, n) ? n : null);
    for (const name of from === null ? Object.keys(g.nodes) : upstreamOf(g, from)) {
      const spec = g.nodes[name];
      if (!spec || typeof spec !== 'object' || typeof spec.type !== 'string') continue;
      if (spec.type.includes('/')) {
        const n = parsePackageName(spec.type);
        if (typeof n !== 'string' && n.package === pkg) out.add(n.output ?? '');
      } else {
        const asset = scope.assets.get(spec.type) ?? scope.assets.get(spec.type.replace(/^asset:/, ''));
        if (asset) visit(asset.graph, at(asset.graph, asset.graph.output), depth + 1);
        else if (getNodeDef(spec.type)?.type === 'graph_ref' && typeof spec.params?.graph === 'string') {
          const ref = scope.graphs?.(spec.params.graph);
          if (ref && isGraph(ref)) visit(ref, at(ref, spec.params.node) ?? at(ref, ref.output), depth + 1);
        }
      }
      if (spec.params && typeof spec.params === 'object') for (const v of Object.values(spec.params)) if (isGraph(v)) visit(v, null, depth + 1);
    }
  };
  visit(graph, node, 0);
  return [...out];
}

/**
 * The package versions a graph uses, directly or through the packages, assets, graph_ref graphs and nested graphs it
 * names: "owner/name@version" → the version's hash, and "owner/name@working" → the hash of a working folder followed
 * this session. Keys sorted. Exports record them (io/source.ts), so an export can be made again.
 */
export function packagesUsed(engine: Engine, graph: GraphSpec, scope: Scope = engine.root): Record<string, string> {
  const out: Record<string, string> = {};
  const seen = new Map<Scope, Set<GraphSpec>>();
  const once = (g: GraphSpec, s: Scope, depth: number) => {
    let set = seen.get(s);
    if (!set) seen.set(s, set = new Set());
    if (set.has(g)) return;
    set.add(g);
    walk(g, s, depth);
  };
  const walk = (g: GraphSpec, s: Scope, depth: number) => {
    if (depth > 64 || !isGraph(g)) return;
    for (const node of Object.values(g.nodes)) {
      if (!node || typeof node !== 'object' || typeof node.type !== 'string') continue;
      const def = engine.resolveDef(node.type, s);
      const o = def?.package;
      if (o) {
        out[`${o.package}@${o.version ?? 'working'}`] = o.hash;
        once(o.spec, o.scope, depth + 1);
      } else if (def) {
        // an asset's graph and a graph_ref's graph cook in the same scope
        const asset = engine.asset(node.type, s) ?? engine.asset(node.type.replace(/^asset:/, ''), s);
        if (asset?.def === def) once(asset.graph, s, depth + 1);
        else if (def.type === 'graph_ref' && typeof node.params?.graph === 'string') {
          const ref = s.graphs?.(node.params.graph);
          if (ref) once(ref, s, depth + 1);
        }
      }
      if (node.params && typeof node.params === 'object') for (const v of Object.values(node.params)) if (isGraph(v)) walk(v, s, depth + 1);
    }
  };
  once(graph, scope, 0);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
