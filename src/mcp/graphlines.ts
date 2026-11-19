import type { GraphSpec } from '../graph/types.ts';

/** A graph as JSON with one node (and one param) per line: readable in a topic page, and JSON.parse gives it back. */
export function graphLines(g: GraphSpec): string {
  const rows = (o: Record<string, any>) => Object.entries(o).map(([k, v]) => `   ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n');
  const parts = Object.entries(g).map(([k, v]) =>
    (k === 'nodes' || k === 'params') && v && typeof v === 'object' ? `${JSON.stringify(k)}: {\n${rows(v)}\n }` : `${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  return `{${parts.join(',\n ')}}`;
}
