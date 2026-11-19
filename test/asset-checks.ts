// Checks shared by TopoTopo's own packages (test/builtin.ts) and the examples (test/cards.ts): the params a person tunes,
// the variants that sweep them, and the conventions a cooked result keeps (every prim named, with a material the
// material table defines; closed pieces where promised). Each returns what is wrong, as messages (none: nothing).
import { Geometry } from '../src/core/geometry.ts';
import { expandPacked } from '../src/core/packed.ts';
import { pieceReport } from '../src/core/analysis.ts';
import { readMaterials } from '../src/core/materials.ts';
import type { GraphSpec } from '../src/graph/types.ts';

export const NUMERIC = new Set(['float', 'int']);
/** How many params a graph a person tunes declares. */
export const MIN_PARAMS = 3, MAX_PARAMS = 10;

/** Polygons of g, packed instances expanded. */
export const flat = (g: Geometry) => (g.hasPacked() ? expandPacked(g).geo : g);

/** Why g is not closed ('' when every piece is): boundary edges, non-manifold edges, polylines. */
export function watertightProblem(g: Geometry): string {
  const pr = pieceReport(g);
  const be = pr.pieces.reduce((s, x) => s + x.boundaryEdges, 0), nme = pr.pieces.reduce((s, x) => s + x.nonManifoldEdges, 0);
  const lines = pr.pieces.reduce((s, x) => s + x.lines, 0);
  return be || nme || lines ? `${be} boundary edges, ${nme} non-manifold edges, ${lines} polylines` : '';
}

/**
 * What a cooked result misses of its naming: every prim carries the string attributes "name" and "material", and every
 * material it names has an entry in the material table (packed results are expanded first; the table check reads an
 * unpacked result only, where the table lives).
 */
export function namingProblems(g0: Geometry): string[] {
  const g = flat(g0);
  if (!g.numPrims) return [];
  const out: string[] = [];
  const nm = g.prims.get('name'), mt = g.prims.get('material');
  if (!nm || nm.type !== 'string') out.push('no prim string attribute "name"');
  if (!mt || mt.type !== 'string') out.push('no prim string attribute "material"');
  if (nm && mt) {
    let missing = 0;
    for (let i = 0; i < g.numPrims; i++) if (!nm.get(i) || !mt.get(i)) missing++;
    if (missing) out.push(`${missing} of ${g.numPrims} prims without name or material`);
  }
  if (!g0.hasPacked() && mt) {
    const table = readMaterials(g), used = new Set<string>((mt.data as string[]).filter(Boolean));
    const undefinedMats = [...used].filter((m) => !table[m]);
    if (undefinedMats.length) out.push(`materials without a table entry: ${undefinedMats.join(', ')}`);
  }
  return out;
}

/**
 * What a graph's params miss: MIN_PARAMS–MAX_PARAMS vars, each with a params entry that has a type and a desc, a
 * default equal to the var, numeric ones a range around it (ints an integer default), enums options holding it; and no
 * params entry without a var.
 */
export function paramProblems(graph: GraphSpec): string[] {
  const out: string[] = [];
  const vars = graph.vars ?? {}, params = graph.params ?? {};
  const names = Object.keys(vars);
  if (names.length < MIN_PARAMS || names.length > MAX_PARAMS) out.push(`${MIN_PARAMS}–${MAX_PARAMS} params (${names.length})`);
  const orphans = Object.keys(params).filter((p) => !(p in vars));
  if (orphans.length) out.push(`params without a var: ${orphans.join(', ')}`);
  for (const p of names) {
    const pd = params[p];
    if (!pd) { out.push(`var "${p}" has no params entry`); continue; }
    if (!pd.type || typeof pd.desc !== 'string' || pd.desc.length <= 3) out.push(`param "${p}" needs type and desc`);
    if (JSON.stringify(pd.default) !== JSON.stringify(vars[p])) out.push(`param "${p}" default ${JSON.stringify(pd.default)} differs from the var ${JSON.stringify(vars[p])}`);
    if (NUMERIC.has(pd.type ?? '')) {
      if (!(typeof pd.min === 'number' && typeof pd.max === 'number' && pd.min <= vars[p] && vars[p] <= pd.max)) out.push(`numeric param "${p}" needs min ≤ default ≤ max`);
      if (pd.type === 'int' && !Number.isInteger(vars[p])) out.push(`int param "${p}" default is not an integer`);
    }
    if (pd.type === 'enum' && !(Array.isArray(pd.options) && pd.options.includes(vars[p]))) out.push(`enum param "${p}" needs options containing the default`);
  }
  return out;
}

/** The variants that sweep a graph's params: every numeric one at its min and max, every other enum option, every bool flipped. */
export function sweepOf(graph: GraphSpec): [label: string, vars: Record<string, any>][] {
  const vars = graph.vars ?? {}, params = graph.params ?? {};
  const out: [string, Record<string, any>][] = [];
  for (const p of Object.keys(vars)) {
    const pd = params[p];
    if (!pd) continue;
    if (NUMERIC.has(pd.type ?? '')) out.push([`${p}=${pd.min}`, { [p]: pd.min }], [`${p}=${pd.max}`, { [p]: pd.max }]);
    else if (pd.type === 'enum') for (const x of pd.options ?? []) { if (x !== vars[p]) out.push([`${p}=${x}`, { [p]: x }]); }
    else if (pd.type === 'bool') out.push([`${p}=${!vars[p]}`, { [p]: !vars[p] }]);
  }
  return out;
}
