// Cook scopes: what the names and relative paths of a graph refer to while it cooks.
//
// A scope has asset node types of its own (by bare name), the graphs graph_ref reads, and the files relative paths
// read (a folder of its own, through Host.filesAt). A node type resolves in the scope's own assets first, then in the
// shipped shelf, then in the built-in nodes. The engine's root scope (Engine.root, id "") is the workspace's; other
// scopes come from Engine.createScope. A cook runs in CookOptions.scope (default: the root), and its nested cooks
// (assets, foreach and solver bodies, graph_ref, lib.run) run in the same scope unless they are given another.
//
// The result cache is shared by all scopes. A node whose result depends on its scope (NodeDef.usesScope) has the
// scope's id in its signature outside the root, so scopes share only the results that cannot differ between them.
import type { HostFiles } from '../host/types.ts';
import type { GraphSpec, NodeDef } from './types.ts';

/** An asset node type: the graph it cooks, its definition and the hash of the graph (Engine.registerAsset). */
export interface AssetEntry { name: string; graph: GraphSpec; def: NodeDef; hash: string }

export interface Scope {
  /**
   * "" for the root scope. Outside the root, the results that depend on a scope are cached under its id: within one
   * engine, an id always means the same assets, graphs and folder.
   */
  readonly id: string;
  /** the scope's own asset node types by bare name (Engine.registerAsset) */
  readonly assets: Map<string, AssetEntry>;
  /** the graphs graph_ref reads, by name; absent: graph_ref has none */
  graphs?: (name: string) => GraphSpec | undefined;
  /** the files nodes read: relative paths resolve against the scope's folder */
  readonly files: HostFiles;
}

/** Signature material of a result that depends on its scope (NodeDef.usesScope): the scope's id, none for the root. */
export const scopeSig = (scope: Scope): string => (scope.id ? `|S:${scope.id}` : '');
