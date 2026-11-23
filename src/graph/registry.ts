import type { NodeDef } from './types.ts';
import { norm, resolveParamName } from './params.ts';

const nodes = new Map<string, NodeDef>();
const lookup = new Map<string, string>(); // normalised name/alias -> type

export function defineNode(def: NodeDef): NodeDef {
  if (nodes.has(def.type)) throw new Error(`duplicate node type ${def.type}`);
  if (def.renamed) {
    // Shared lists of old names can include params this node still accepts.
    const renamed = Object.entries(def.renamed).filter(([key]) => resolveParamName(def, key) === null);
    def.renamed = renamed.length ? Object.fromEntries(renamed) : undefined;
  }
  nodes.set(def.type, def);
  for (const n of [def.type, ...(def.aliases ?? [])]) {
    const k = norm(n);
    if (!lookup.has(k)) lookup.set(k, def.type);
  }
  return def;
}

export function getNodeDef(type: string): NodeDef | undefined {
  const d = nodes.get(type);
  if (d) return d;
  const t = lookup.get(norm(type));
  return t ? nodes.get(t) : undefined;
}

export function allNodeDefs(): NodeDef[] {
  return [...nodes.values()];
}

export function allNodeNames(): string[] {
  return [...lookup.keys()].map((k) => lookup.get(k)!).filter((v, i, a) => a.indexOf(v) === i);
}

export function allAliases(): string[] {
  const out: string[] = [];
  for (const d of nodes.values()) out.push(d.type, ...(d.aliases ?? []));
  return out;
}

export const CATEGORY_ORDER = [
  'generate', 'curve', 'transform', 'deform', 'attribute', 'measure', 'group', 'topology', 'copy',
  'solid', 'sdf', 'heightfield', 'uv', 'code', 'flow', 'io',
];
