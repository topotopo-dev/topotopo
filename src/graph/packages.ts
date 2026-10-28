// Packages, the engine side: the node type of a package output, and the packages a graph names and uses. The host's
// package registry (src/gallery/packages.ts) reads the versions from disk and gives each scope its PackageResolver
// (src/graph/scope.ts): the project's root resolves names by the project's uses, a version by its own.
//
// A package is a project with a full name ("owner/name") and published versions: frozen copies of its graphs, assets
// and inputs. A graph uses an output of one as a node type, "owner/name/output", or "owner/name" for the package's
// default output. A package output cooks its graph in the version's own scope (its assets, graphs, files and
// packages), so nothing leaks between the project and the package and two versions of one package cook side by side.
// Its signature is the version's hash and the node it cooks: a frozen version cooks once for everyone who uses it.
import { Geometry } from '../core/geometry.ts';
import { rebaseTexturePaths } from '../core/materials.ts';
import { graphInterface } from './engine.ts';
import type { Engine } from './engine.ts';
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
  /** a problem every cook repeats (a copy edited by hand) */
  warning?: string;
}

/** "studio/trees 1.3", or "studio/trees (working folder)" for one followed this session. */
export const packageAt = (o: Pick<PackageOutput, 'package' | 'version'>) => (o.version === null ? `${o.package} (working folder)` : `${o.package} ${o.version}`);

/** The node type of a package output: its graph's vars are its params and its input nodes the inputs, as for assets. */
export function packageOutputDef(o: PackageOutput): NodeDef {
  const type = o.output === null ? o.package : `${o.package}/${o.output}`;
  const at = packageAt(o);
  const { params, inputs } = graphInterface(o.spec);
  return {
    type,
    category: 'package',
    summary: `${o.output === null ? 'the default output' : `output "${o.output}"`} of package ${at}${o.label ? ` (${o.label})` : ''}`,
    description: [o.spec.description, o.note ? `${at}: ${o.note}` : '', `It cooks node "${o.node}" of the package's graph "${o.graph}"; its params are that graph's vars.`].filter(Boolean).join('\n'),
    inputs,
    params,
    package: o,
    // the version is frozen: its hash and the node say what it cooks, in a scope of its own (no usesScope)
    signatureExtra: () => `${o.signature}|${o.graph}/${o.node}`,
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
      // texture paths relative to the version's folder would be read from the project's: they are made absolute
      return rebaseTexturePaths(r.geo, (p) => o.scope.files.resolvePath(p));
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
