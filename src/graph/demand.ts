// Material demand: what a cook reads of a node, so a merge of package material outputs cooks only the outputs that
// hold the materials read. A material node with input 1 and "from" reads that one material of its input
// (NodeDef.materialsRead); a merge holds its inputs' materials as they are (NodeDef.passesMaterials), so what is read of
// it is read of each input. A node read anywhere else (as a geometry, by an expression, as the cook's target) is read
// whole. A published version records the materials of each material output (its version.json maps: PackageOutput
// .materials), so a merge whose readers read named materials leaves out the package outputs after the last input that
// may hold one of them, and those outputs are not cooked at all. Only after it: a merge gives a later input's maps and
// materials other names when an earlier input already took theirs (Geometry.merge), so leaving out an earlier input
// could change the names of what is read; a later one never changes an earlier one's. For the same reason a merge
// inside a merge is read for names only when every input after it there is left out. Pure: the engine passes how it
// sees the graph.
import { resolveParamName } from './params.ts';
import type { GraphSpec, NodeDef } from './types.ts';

/** What a cook reads of a node: all of it, or the materials of these names. */
export type Demand = 'all' | Set<string>;

/** How the engine sees a graph's nodes: their type, their wired inputs and the nodes their params reference. */
export interface DemandGraph {
  graph: GraphSpec;
  def(node: string): NodeDef | undefined;
  wiring(node: string): (string | null)[];
  refs(node: string): string[];
}

/** The demand on every node a cook of `target` reaches. */
export function materialDemands(g: DemandGraph, target: string): Map<string, Demand> {
  // the nodes reached, and who reads each (at which input; -1 = by reference)
  const readers = new Map<string, { node: string; input: number }[]>();
  const reached = new Set<string>([target]), todo = [target];
  while (todo.length) {
    const n = todo.pop()!;
    const add = (ref: string | null, input: number) => {
      if (!ref || !Object.hasOwn(g.graph.nodes, ref)) return;
      let r = readers.get(ref);
      if (!r) readers.set(ref, r = []);
      r.push({ node: n, input });
      if (!reached.has(ref)) { reached.add(ref); todo.push(ref); }
    };
    g.wiring(n).forEach((ref, i) => add(ref, i));
    for (const ref of g.refs(n)) add(ref, -1);
  }
  const out = new Map<string, Demand>();
  const demand = (n: string): Demand => {
    let d = out.get(n);
    if (d) return d;
    out.set(n, 'all'); // a cycle (refused by validation) reads all
    d = n === target ? 'all' : readOf(n);
    out.set(n, d);
    return d;
  };
  const readOf = (n: string): Demand => {
    const names = new Set<string>();
    for (const r of readers.get(n) ?? []) {
      const spec = g.graph.nodes[r.node], def = g.def(r.node);
      if (r.input < 0 || !def || spec?.bypass) return 'all';
      const read = def.materialsRead?.(rawParams(spec?.params, def));
      if (read && read.input === r.input) { for (const x of read.names) names.add(x); continue; }
      if (!def.passesMaterials) return 'all';
      const up = demand(r.node);
      if (up === 'all') return 'all';
      // an input that stays after this one would take its names after this one's: all of this one is then read
      const wires = g.wiring(r.node), left = inputsNotRead(g, r.node, up);
      for (let k = r.input + 1; k < wires.length; k++) if (wires[k] && !left.has(k)) return 'all';
      for (const x of up) names.add(x);
    }
    return names;
  };
  for (const n of reached) demand(n);
  return out;
}

/** A node's params as written, read by their canonical names (aliases resolved by the def's names). */
function rawParams(params: Record<string, unknown> | undefined, def: NodeDef): (name: string) => unknown {
  return (name) => {
    const key = Object.keys(params ?? {}).find((k) => resolveParamName(def, k) === name);
    return key === undefined ? undefined : params![key];
  };
}

/**
 * The inputs of a node that passes materials (a merge) a cook can leave out for `demand`: the package outputs after the
 * last input that may hold a material read (an earlier input can rename a later one's maps and materials, so every
 * input up to that one is cooked), each with a version that records its materials, none of them read, cooked with the
 * version's own values (no params set, so the record holds), not bypassed. Their indices. A name read that none of the
 * recorded inputs holds (a misspelt "from", or a material of another input) leaves out nothing, so an error lists
 * every material the merge holds.
 */
export function inputsNotRead(g: DemandGraph, node: string, demand: Demand): Set<number> {
  const skip = new Set<number>();
  if (demand === 'all') return skip;
  const recorded = new Map<number, string[]>();
  g.wiring(node).forEach((ref, i) => {
    if (!ref) return;
    const spec = g.graph.nodes[ref], held = g.def(ref)?.package?.materials;
    if (held && !spec?.bypass && !Object.keys(spec?.params ?? {}).length) recorded.set(i, held);
  });
  const found = new Set([...recorded.values()].flat());
  if ([...demand].some((m) => !found.has(m))) return skip;
  const wires = g.wiring(node);
  for (let i = wires.length - 1; i >= 0; i--) {
    if (!wires[i]) continue;
    const held = recorded.get(i);
    if (!held || held.some((m) => demand.has(m))) break;
    skip.add(i);
  }
  return skip;
}
