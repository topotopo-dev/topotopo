// Graph format versioning. Every graph document carries `version`; older documents are upgraded
// in place by the registered migrations, in order, then stamped with GRAPH_VERSION.
//
// Migrations run on whole documents (a workspace graph, an asset graph, a file given to the CLI):
// Engine.cook at depth 0, Workspace load/save, MCP build. Nested graphs (foreach/solver bodies,
// node params of type "graph") belong to their parent document, so a migration that changes nodes
// must walk into them itself (see forEachNode). Nested cooks never migrate again.
import { GRAPH_VERSION } from './types.ts';
import type { GraphSpec, NodeSpec } from './types.ts';

export interface Migration {
  /** version this migration upgrades from; it produces from + 1 */
  from: number;
  desc: string;
  /** returns the upgraded graph; must not modify its argument (structuredClone it first when changing things) */
  apply(g: GraphSpec): GraphSpec;
}

/** Registered migrations, ordered by `from`. Version 0 = unversioned graphs from before versioning existed. */
export const MIGRATIONS: Migration[] = [
  { from: 0, desc: 'unversioned graph: no format changes, stamped as version 1', apply: (g) => g },
];

/** Visit every node of a graph and of the graphs nested in its params (bodies), depth first. */
export function forEachNode(g: GraphSpec, fn: (spec: NodeSpec, name: string, graph: GraphSpec) => void) {
  for (const [name, spec] of Object.entries(g.nodes ?? {})) {
    if (!spec || typeof spec !== 'object') continue;
    fn(spec, name, g);
    for (const v of Object.values(spec.params ?? {}))
      if (v && typeof v === 'object' && !Array.isArray(v) && v.nodes && typeof v.nodes === 'object') forEachNode(v, fn);
  }
}

export interface MigrationResult {
  graph: GraphSpec;
  /** descriptions of the migrations that ran */
  applied: string[];
  /** e.g. a document newer than this engine */
  notes: string[];
}

/** Upgrade a graph document to GRAPH_VERSION; reports what ran. Returns the input object when nothing changes. */
export function migrateGraphDetailed(spec: GraphSpec): MigrationResult {
  const applied: string[] = [], notes: string[] = [];
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return { graph: spec, applied, notes };
  const raw = (spec as any).version;
  const from = raw === undefined || raw === null ? 0 : Number(raw);
  if (!Number.isInteger(from) || from < 0) {
    notes.push(`graph "version" must be a non-negative integer, got ${JSON.stringify(raw)}; treated as ${GRAPH_VERSION}`);
    return { graph: stamp(spec), applied, notes };
  }
  if (from > GRAPH_VERSION) {
    notes.push(`graph version ${from} is newer than this engine (${GRAPH_VERSION}); cooking it as is`);
    return { graph: spec, applied, notes };
  }
  if (from === GRAPH_VERSION) return { graph: spec, applied, notes };
  let g: GraphSpec = spec;
  for (let v = from; v < GRAPH_VERSION; v++) {
    const m = MIGRATIONS.find((x) => x.from === v);
    if (!m) throw new Error(`no migration registered from graph version ${v}`);
    g = m.apply(g);
    applied.push(`v${v} → v${v + 1}: ${m.desc}`);
  }
  return { graph: stamp(g), applied, notes };
}

/** Upgrade a graph document to GRAPH_VERSION and stamp the version. */
export function migrateGraph(spec: GraphSpec): GraphSpec {
  return migrateGraphDetailed(spec).graph;
}

function stamp(g: GraphSpec): GraphSpec {
  const { version: _v, ...rest } = g;
  return { version: GRAPH_VERSION, ...rest };
}
