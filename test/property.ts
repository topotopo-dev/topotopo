// Property tests: random node chains from the registry, checked for engine invariants.
//
//   node test/property.ts [--count N] [--seed S] [--only I] [--verbose] [--strict]
//   PROPERTY_COUNT=500 node test/property.ts
//
// Each graph is a fixture source followed by 1–4 nodes whose first input takes geometry. Extra inputs come from
// the fixtures (INPUTS), params are randomised within min/max/options (small int ranges so cooks stay fast).
// Checks per graph:
//   - no exception escapes engine.cook (errors must be reported per node),
//   - every successfully cooked node result passes checkGeo,
//   - determinism: two cold-cache cooks give the same fingerprint (or the same errors),
//   - immutability: no node's cooked result changes after downstream nodes have cooked (clone before writing),
//   - cache correctness: change a numeric param, cook, restore it, cook → same fingerprint as the first cook,
//     and the engine reports the restored node (and the output) as cached.
// --strict also fails on node errors that look like internal JS errors (TypeError etc.).
// On failure the graph JSON is printed; reproduce with --seed S --only I.
import { allNodeDefs, getNodeDef } from '../src/graph/registry.ts';
import { hash32, rng } from '../src/core/random.ts';
import type { Engine, CookReport } from '../src/graph/engine.ts';
import type { GraphSpec, NodeDef, NodeSpec, ParamDef } from '../src/graph/types.ts';
import { INPUTS, PARAMS, SKIP, addFixture, checkGeo, createFixtureEngine } from './fixtures.ts';
import { diffFields, fingerprint, formatDiff } from './fingerprint.ts';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const COUNT = Number(flag('--count') ?? process.env.PROPERTY_COUNT ?? 150);
const SEED = Number(flag('--seed') ?? process.env.PROPERTY_SEED ?? 1);
const ONLY = flag('--only') !== undefined ? Number(flag('--only')) : undefined;
const VERBOSE = args.includes('--verbose');
const STRICT = args.includes('--strict');

/** Fixtures a chain may start from. */
const SOURCES = ['MESH', 'BOX', 'GRID', 'CURVE', 'CIRCLE', 'SHAPE', 'PTS', 'SDF', 'COLORED', 'PROFILE', 'LOFT', 'SMALLSPHERE'];

/** Per-node param ranges that keep cooks fast ('keep' = leave the default). Vector ranges apply per component. */
const LIMITS: Record<string, Record<string, [number, number] | 'keep'>> = {
  subdivide: { levels: [0, 2] },
  smooth_solid: { refine: [1, 3] },
  resample: { length: [0.02, 0.5], count: [1, 60] },
  sdf_to_mesh: { edge_length: 'keep', divisions: [8, 32] },
  sdf_from_mesh: { voxel_size: 'keep', divisions: [8, 24] },
  remesh: { edge_length: 'keep', divisions: [8, 24] },
  grid_split: { size: [0.3, 2], divisions: [1, 4] },
  scatter: { count: [0, 300], density: [0, 20] },
  copy_xform: { count: [0, 6] },
  voronoi_fracture: { count: [1, 10], neighbors: [4, 24] },
  sweep: { divisions: [2, 16] },
  polywire: { divisions: [3, 12] },
  revolve: { segments: [3, 48] },
  offset_curve: { segments: [3, 24] },
  foreach: { max_iterations: [50, 200], count: [0, 6] },
  poly_extrude: { divisions: [1, 3] },
  smooth: { iterations: [0, 20] },
  voronoi2d: { count: [1, 40], relax: [0, 3] },
  slice: { count: [1, 10] },
  bound: { divisions: [1, 3] },
  sdf_modify: { count: [1, 3], octaves: [1, 4] },
  uv_unwrap: { max_iterations: [1, 2], resolution: 'keep', texels_per_unit: 'keep', padding: [0, 8], bruteforce: 'keep', max_boundary_length: 'keep' },
  uv_autoseam: { max_cost: [0.5, 4] },
  uv_layout: { iterations: [1, 4], udims: [1, 4] },
};

/** Node types that get slow on big inputs: only chained when the incoming geometry has at most this many prims. */
const MAX_INPUT_PRIMS: Record<string, number> = {
  minkowski: 400, convex_hull: 20000, voronoi_fracture: 3000, boolean: 20000, remesh: 20000, sdf_from_mesh: 20000,
  smooth_solid: 3000, decimate: 50000, uv_unwrap: 3000, uv_autoseam: 3000, uv_flatten: 20000, uv_layout: 20000, foreach: 2000, copy_to_points: 5000, triangulate2d: 20000, voronoi2d: 20000,
};

const GROUP_PATTERNS = ['', '', '', '@P.y>0', '0-10', '!0-5', '@P.x<0.2', '*', 'top', '0-100:2'];
const MAX_ELEMENTS = 300_000;
const MAX_NODE_MS = 1500;

type Rand = () => number;
const pick = <T>(r: Rand, a: T[]): T => a[Math.floor(r() * a.length)];
const randInt = (r: Rand, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

function intRange(pd: ParamDef, lim?: [number, number] | 'keep'): [number, number] {
  if (Array.isArray(lim)) return lim;
  const d = typeof pd.default === 'number' ? pd.default : Array.isArray(pd.default) ? Math.max(...pd.default) : 1;
  const lo = pd.min ?? 0;
  const hi = Math.min(pd.max ?? Infinity, Math.max(lo + 2, Math.min(d * 2, lo + 16)));
  return [lo, hi];
}

function floatRange(pd: ParamDef, d: number, lim?: [number, number] | 'keep'): [number, number] {
  if (Array.isArray(lim)) return lim;
  const span = Math.max(1, Math.abs(d));
  let lo = pd.min ?? d - span;
  let hi = pd.max ?? (pd.min !== undefined ? Math.max(pd.min + 1, d * 2) : d + span);
  if (hi < lo) [lo, hi] = [hi, lo];
  return [lo, hi];
}

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

/** A random value for one param, or undefined to keep the default. */
function randomParam(r: Rand, type: string, name: string, pd: ParamDef): any {
  const lim = LIMITS[type]?.[name];
  if (lim === 'keep') return undefined;
  switch (pd.type) {
    case 'int': {
      const [lo, hi] = intRange(pd, lim);
      return randInt(r, lo, hi);
    }
    case 'float': {
      const [lo, hi] = floatRange(pd, typeof pd.default === 'number' ? pd.default : 0, lim);
      return r4(lo + r() * (hi - lo));
    }
    case 'bool': return r() < 0.5;
    case 'enum': return pd.options?.length ? pick(r, pd.options) : undefined;
    case 'color': return [r4(r()), r4(r()), r4(r())];
    case 'vec2': case 'vec3': case 'vec4': {
      const n = pd.type === 'vec2' ? 2 : pd.type === 'vec3' ? 3 : 4;
      const def = Array.isArray(pd.default) ? pd.default : new Array(n).fill(0);
      return def.map((d: number) => {
        const [lo, hi] = floatRange(pd, d, lim);
        return r4(lo + r() * (hi - lo));
      });
    }
    case 'ivec2': case 'ivec3': {
      const def = Array.isArray(pd.default) ? pd.default : [1, 1, 1];
      const [lo, hi] = intRange(pd, lim);
      return def.map(() => randInt(r, Math.max(lo, 1), Math.max(hi, 1)));
    }
    case 'group': return pick(r, GROUP_PATTERNS);
    default: return undefined; // string, json, code, ramp, graph, path: keep defaults
  }
}

function randomParams(r: Rand, def: NodeDef): Record<string, any> {
  const base = PARAMS[def.type] ? structuredClone(PARAMS[def.type]) : {};
  const out: Record<string, any> = { ...base };
  for (const [name, pd] of Object.entries(def.params)) {
    if (name in base || r() < 0.4) continue;
    const v = randomParam(r, def.type, name, pd);
    if (v !== undefined) out[name] = v;
  }
  return out;
}

/** Wire the inputs of `def`: input 0 is the chain, extra inputs come from the fixtures. */
function wireInputs(r: Rand, def: NodeDef, prev: string, nodes: Record<string, NodeSpec>): (string | null)[] {
  if (def.inputs.some((i) => i.multi)) {
    const extra = (INPUTS[def.type] ?? ['MESH', 'BOX']).slice(1);
    const ins = [prev];
    for (const f of ['MESH', 'BOX', 'CURVE', ...extra]) if (r() < 0.3) { addFixture(nodes, f); ins.push(f); }
    return ins;
  }
  const ins: (string | null)[] = [prev];
  for (let i = 1; i < def.inputs.length; i++) {
    const inp = def.inputs[i];
    const f = INPUTS[def.type]?.[i] ?? (inp.optional ? null : 'MESH');
    if (f && (!inp.optional || r() < 0.7)) { addFixture(nodes, f); ins[i] = f; }
    else ins[i] = null;
  }
  while (ins.length > 1 && ins[ins.length - 1] === null) ins.pop();
  return ins;
}

const CHAINABLE = allNodeDefs().filter((d) => d.inputs.length > 0 && !SKIP.has(d.type));

interface Built { graph: GraphSpec; chain: string[]; truncated: string }

/** Build a chain incrementally, cooking as it grows so it can stop before outputs get large or slow. */
async function buildGraph(engine: Engine, seed: number): Promise<Built> {
  const r = rng(seed);
  const nodes: Record<string, NodeSpec> = {};
  const src = pick(r, SOURCES);
  addFixture(nodes, src);
  const chain = [src];
  let prev = src;
  let prevPrims = 0;
  try {
    const first = await engine.cook({ nodes: structuredClone(nodes), output: src });
    prevPrims = first.geo?.numPrims ?? 0;
  } catch { /* reported by the checks below */ }
  const want = randInt(r, 1, 4);
  let truncated = '';
  for (let k = 1; k <= want; k++) {
    let def: NodeDef | undefined;
    for (let tries = 0; tries < 20 && !def; tries++) {
      const d = pick(r, CHAINABLE);
      if (MAX_INPUT_PRIMS[d.type] !== undefined && prevPrims > MAX_INPUT_PRIMS[d.type]) continue;
      def = d;
    }
    if (!def) break;
    const name = `n${k}`;
    const trial = structuredClone(nodes);
    trial[name] = { type: def.type, in: wireInputs(r, def, prev, trial), params: randomParams(r, def) };
    let rep: CookReport | null = null;
    try {
      rep = await engine.cook({ nodes: trial, output: name });
    } catch { /* keep the node: the throw is the bug the checks will report */ }
    const res = rep?.results.get(name);
    const g = rep?.geo;
    if (g && g.numPoints + g.numPrims + g.numVertices > MAX_ELEMENTS) { truncated = `${def.type}: output too large`; break; }
    if (res && res.ms > MAX_NODE_MS) { truncated = `${def.type}: ${res.ms.toFixed(0)} ms`; break; }
    Object.assign(nodes, trial);
    chain.push(def.type);
    prev = name;
    prevPrims = g?.numPrims ?? 0;
  }
  return { graph: { nodes, output: prev }, chain, truncated };
}

// ------------------------------------------------------------------ checks

const INTERNAL = /(TypeError|RangeError|ReferenceError|Cannot read propert|is not a function|is not iterable|is not defined|Invalid array length|Maximum call stack|undefined \(reading)/;

interface Outcome { ok: boolean; sig: string; fp: any }

async function cookChecked(engine: Engine, graph: GraphSpec, problems: string[], label: string): Promise<{ rep: CookReport | null; out: Outcome }> {
  let rep: CookReport | null = null;
  try {
    rep = await engine.cook(structuredClone(graph));
  } catch (e: any) {
    problems.push(`${label}: engine.cook threw: ${e?.stack ?? e}`);
    return { rep: null, out: { ok: false, sig: 'threw', fp: null } };
  }
  for (const res of rep.results.values()) {
    if (!res.geo) continue;
    const errs = checkGeo(res.geo);
    if (errs.length) problems.push(`${label}: node "${res.node}" fails checkGeo: ${errs.join(', ')}`);
  }
  const fp = rep.geo ? fingerprint(rep.geo) : null;
  return { rep, out: { ok: rep.ok, sig: JSON.stringify(rep.errors.map((e) => `[${e.node}] ${e.message}`)), fp } };
}

/** Node names with every node after the nodes it is wired to. */
function topoOrder(graph: GraphSpec): string[] {
  const out: string[] = [], seen = new Set<string>();
  const visit = (n: string) => {
    if (seen.has(n) || !graph.nodes[n]) return;
    seen.add(n);
    const ins = graph.nodes[n].in;
    for (const d of Array.isArray(ins) ? ins : typeof ins === 'string' ? [ins] : []) if (d) visit(d);
    out.push(n);
  };
  for (const n of Object.keys(graph.nodes)) visit(n);
  return out;
}

const sameOutcome = (a: Outcome, b: Outcome) => a.ok === b.ok && a.sig === b.sig && JSON.stringify(a.fp) === JSON.stringify(b.fp);

function outcomeDiff(a: Outcome, b: Outcome): string[] {
  return formatDiff(diffFields({ ok: a.ok, errors: a.sig, fp: a.fp }, { ok: b.ok, errors: b.sig, fp: b.fp }), 12);
}

/** Pick a scalar numeric param on a chain node and a different value for it. */
function pickParamChange(r: Rand, graph: GraphSpec): { node: string; param: string; from: any; to: number } | null {
  const cands: { node: string; param: string; pd: ParamDef; type: string }[] = [];
  for (const [node, spec] of Object.entries(graph.nodes)) {
    if (!/^n\d+$/.test(node)) continue;
    const def = getNodeDef(spec.type)!;
    for (const [param, pd] of Object.entries(def.params)) if (pd.type === 'float' || pd.type === 'int') cands.push({ node, param, pd, type: def.type });
  }
  if (!cands.length) return null;
  const c = pick(r, cands);
  const spec = graph.nodes[c.node];
  const has = spec.params && c.param in spec.params;
  const cur = has ? spec.params![c.param] : c.pd.default;
  const curN = typeof cur === 'number' ? cur : 0;
  let to: number;
  if (c.pd.type === 'int') {
    const [lo, hi] = intRange(c.pd, LIMITS[c.type]?.[c.param]);
    to = curN + 1 <= hi ? curN + 1 : Math.max(lo, curN - 1);
  } else {
    to = r4(curN + Math.abs(curN) * 0.25 + 0.1);
    if (c.pd.max !== undefined && to > c.pd.max) to = r4(Math.max(c.pd.min ?? -Infinity, curN - (Math.abs(curN) * 0.25 + 0.1)));
  }
  return { node: c.node, param: c.param, from: has ? cur : undefined, to };
}

// ------------------------------------------------------------------ run

const { engine } = await createFixtureEngine();
const t0 = performance.now();
let failures = 0, okGraphs = 0, errGraphs = 0, cacheChecks = 0, cacheHitAsserts = 0, truncatedCount = 0, nodeCount = 0;
const errorsByType = new Map<string, Map<string, number>>();
const internal: string[] = [];
const typeCoverage = new Map<string, number>();

const indices = ONLY !== undefined ? [ONLY] : Array.from({ length: COUNT }, (_, i) => i);
for (const i of indices) {
  const seed = hash32(SEED * 7919 + i * 104729 + 1);
  const problems: string[] = [];
  const built = await buildGraph(engine, seed);
  const { graph } = built;
  nodeCount += built.chain.length - 1;
  for (const t of built.chain.slice(1)) typeCoverage.set(t, (typeCoverage.get(t) ?? 0) + 1);
  if (built.truncated) truncatedCount++;

  // cook 1: cold cache, fingerprint every node result afterwards
  engine.cache.clear();
  const A = await cookChecked(engine, graph, problems, 'cook 1');
  const after = new Map<string, any>();
  if (A.rep) for (const [n, res] of A.rep.results) if (res.geo) after.set(n, fingerprint(res.geo));

  // cook 2: cold cache again, one node at a time in topological order, fingerprinting each result right away
  // (before anything downstream has seen it). Determinism: the output matches cook 1. Immutability: every node's
  // result in cook 1 still matches its fresh fingerprint, i.e. no downstream node wrote to its input.
  engine.cache.clear();
  let B: Awaited<ReturnType<typeof cookChecked>> | null = null;
  const fresh = new Map<string, any>();
  for (const n of topoOrder(graph)) {
    const r2 = await cookChecked(engine, { ...graph, output: n }, problems, `cook 2 (target ${n})`);
    const g = r2.rep?.results.get(n)?.geo;
    if (g) fresh.set(n, fingerprint(g));
    if (n === graph.output) B = r2;
  }
  if (A.rep && B?.rep && !sameOutcome(A.out, B.out)) problems.push(`not deterministic: cook 1 vs cook 2 (both cold cache)\n${outcomeDiff(A.out, B.out).join('\n')}`);
  for (const [n, fp] of after) {
    const f = fresh.get(n);
    if (!f || n === graph.output || JSON.stringify(f) === JSON.stringify(fp)) continue;
    const consumers = Object.entries(graph.nodes).filter(([, s]) => Array.isArray(s.in) && s.in.includes(n)).map(([m, s]) => `${m} (${s.type})`);
    problems.push(`immutability: the result of "${n}" (${graph.nodes[n].type}) changed after downstream nodes cooked; one of ${consumers.join(', ')} writes to its input without clone()\n${formatDiff(diffFields(f, fp), 8).join('\n')}`);
  }

  if (A.rep) {
    if (A.rep.ok) okGraphs++; else errGraphs++;
    for (const e of A.rep.errors) {
      const type = graph.nodes[e.node]?.type ?? e.node;
      const msg = e.message.replace(/\d+(\.\d+)?/g, '#').slice(0, 90);
      const m = errorsByType.get(type) ?? new Map<string, number>();
      m.set(msg, (m.get(msg) ?? 0) + 1);
      errorsByType.set(type, m);
      if (INTERNAL.test(e.message)) internal.push(`graph #${i} [${e.node}: ${type}] ${e.message.slice(0, 200)}`);
    }
  }

  // cache correctness: change → cook → restore → cook
  const change = pickParamChange(rng(seed ^ 0x5bd1e995), graph);
  if (A.rep && change) {
    cacheChecks++;
    const spec = graph.nodes[change.node];
    spec.params = { ...(spec.params ?? {}), [change.param]: change.to };
    await cookChecked(engine, graph, problems, `cook 3 (${change.node}.${change.param}=${change.to})`);
    if (change.from === undefined) delete spec.params[change.param];
    else spec.params[change.param] = change.from;
    const D = await cookChecked(engine, graph, problems, 'cook 4 (param restored)');
    if (D.rep) {
      if (!sameOutcome(A.out, D.out)) problems.push(`cache: result after restoring ${change.node}.${change.param} differs from cook 1\n${outcomeDiff(A.out, D.out).join('\n')}`);
      const okBefore = A.rep.results.get(change.node);
      if (okBefore && !okBefore.error) {
        for (const n of new Set([change.node, graph.output!])) {
          const res = D.rep.results.get(n);
          if (res && !res.error) cacheHitAsserts++;
          if (res && !res.error && !res.cached) problems.push(`cache: node "${n}" re-cooked after restoring ${change.node}.${change.param} (expected a cache hit)`);
        }
      }
    }
  }

  const desc = `#${i} ${built.chain.join(' → ')}`;
  if (problems.length) {
    failures++;
    console.log(`FAIL ${desc}`);
    for (const p of problems) console.log('  ' + p.split('\n').join('\n  '));
    console.log(`  reproduce: node test/property.ts --seed ${SEED} --only ${i}`);
    console.log('  graph: ' + JSON.stringify(graph));
  } else if (VERBOSE) {
    const g = A.rep?.geo;
    console.log(`ok   ${desc}  ${A.rep?.ok ? `${g?.numPoints} pts ${g?.numPrims} prims` : `error: ${A.rep?.errors[0]?.message.slice(0, 80)}`}${built.truncated ? `  (stopped: ${built.truncated})` : ''}`);
  }
}

const secs = ((performance.now() - t0) / 1000).toFixed(1);
console.log(`\nnode errors seen (expected for some random params; per type, most common first):`);
for (const [type, m] of [...errorsByType].sort((a, b) => a[0].localeCompare(b[0]))) {
  const top = [...m].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([msg, n]) => `${n}× ${msg}`);
  console.log(`  ${type}: ${top.join(' | ')}`);
}
if (internal.length) {
  console.log(`\nnode errors that look like internal JS errors (${internal.length}${STRICT ? ', failing because of --strict' : ''}):`);
  for (const l of [...new Set(internal)].slice(0, 15)) console.log('  ' + l);
  if (STRICT) failures += internal.length;
}
const untested = CHAINABLE.map((d) => d.type).filter((t) => !typeCoverage.has(t));
console.log(`\ncoverage: ${typeCoverage.size}/${CHAINABLE.length} chainable node types${untested.length ? ` (not drawn: ${untested.join(', ')})` : ''}`);
console.log(`property: ${indices.length} graphs (seed ${SEED}), ${nodeCount} random nodes, ${okGraphs} cooked ok, ${errGraphs} with node errors, ${cacheChecks} param change/restore checks (${cacheHitAsserts} cache hits asserted), ${truncatedCount} chains stopped early; ${failures} failed (${secs}s)`);
process.exit(failures ? 1 : 0);
