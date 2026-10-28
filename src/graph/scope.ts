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
//
// Names with a slash are package outputs ("owner/name/output", or "owner/name" for a package's default output, see
// src/graph/packages.ts): never a built-in node, a shelf asset or an asset, they resolve through the scope's packages,
// which the host's package registry gives it: the project's uses for the root, a version's own uses inside it.
import type { HostFiles } from '../host/types.ts';
import type { GraphSpec, NodeDef } from './types.ts';

/** An asset node type: the graph it cooks, its definition and the hash of the graph (Engine.registerAsset). */
export interface AssetEntry { name: string; graph: GraphSpec; def: NodeDef; hash: string }

/** Why a package output's name does not resolve: said as the node's error, with a hint for what to do. */
export interface PackageIssue { error: string; hint?: string }

/** How a scope resolves package outputs (Scope.packages). */
export interface PackageResolver {
  /** the node type a name with a slash names in this scope, or why there is none (never a guess) */
  resolve(name: string): NodeDef | PackageIssue;
  /** every package output name the scope resolves ("owner/name" and "owner/name/output"), for did-you-mean and the catalog */
  names(): string[];
}

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
  /** the package outputs its graphs name; absent: none (a name with a slash is then an error that says so) */
  packages?: PackageResolver;
}

/** Signature material of a result that depends on its scope (NodeDef.usesScope): the scope's id, none for the root. */
export const scopeSig = (scope: Scope): string => (scope.id ? `|S:${scope.id}` : '');

/**
 * A project id, a library name, and each part of a package output's name (owner, name, output): lower-case letters,
 * digits, "-" and "_", starting with a letter or digit, at most 64 characters.
 */
export const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** A package output's name: the package ("owner/name") and the output, null for the package's default output. */
export interface PackageName { package: string; output: string | null }

/** "owner/name/output" or "owner/name" parsed; a message saying what is wrong with any other name with a slash. */
export function parsePackageName(name: string): PackageName | string {
  const parts = name.split('/');
  if ((parts.length !== 2 && parts.length !== 3) || !parts.every((p) => ID_RE.test(p)))
    return `"${name}" is not a package output: write "owner/name/output", or "owner/name" for the package's default output (each part lower-case letters, digits, - and _, starting with a letter or digit)`;
  return { package: `${parts[0]}/${parts[1]}`, output: parts[2] ?? null };
}
