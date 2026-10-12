// Regression tests for bugs found by the property and fuzz tests (P0-E), plus a deterministic immutability sweep.
//   node test/bugs.ts [--verbose]
import { allNodeDefs } from '../src/graph/registry.ts';
import type { GraphSpec, NodeDef, NodeSpec } from '../src/graph/types.ts';
import { SKIP, createFixtureEngine, fixtureGraphFor } from './fixtures.ts';
import { diffFields, fingerprint, formatDiff } from './fingerprint.ts';

const VERBOSE = process.argv.includes('--verbose');
const { engine } = await createFixtureEngine();

let fail = 0, pass = 0;
const check = (ok: any, msg: string, detail = '') => {
  if (ok) pass++; else fail++;
  if (!ok || VERBOSE) console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}${!ok && detail ? '\n  ' + detail.split('\n').join('\n  ') : ''}`);
};
const fpOf = (g: any) => JSON.stringify(fingerprint(g));
const errs = (r: { errors: { node: string; message: string }[] }) => r.errors.map((e) => `[${e.node}] ${e.message}`).join('; ');

// ------------------------------------------------------------------ 1. subdivide levels:0 must not touch its input

{
  // the wrangle leaves N inconsistent with the shape, so a normal refresh on the input would change it
  const nodes: Record<string, NodeSpec> = {
    s: { type: 'sphere', params: { type: 'ico', level: 1 } },
    j: { type: 'jitter', in: ['s'], params: { scale: [0.2, 0.2, 0.2] } },
    w: { type: 'wrangle', in: ['j'], params: { code: '@N = [0, 1, 0];' } },
    d: { type: 'subdivide', in: ['w'], params: { levels: 0 } },
  };
  engine.cache.clear();
  const up = await engine.cook({ nodes, output: 'w' });
  const before = fpOf(up.geo!);
  const down = await engine.cook({ nodes, output: 'd' });
  check(down.ok, 'subdivide levels:0 cooks', errs(down));
  const after = fpOf(up.geo!);
  check(before === after, 'subdivide levels:0 leaves the cached upstream result byte-identical',
    formatDiff(diffFields(JSON.parse(before), JSON.parse(after)), 8).join('\n'));
  check(down.geo && fpOf(down.geo) === before, 'subdivide levels:0 passes its input through');
}

// ------------------------------------------------------------------ immutability sweep over every node fixture

/** Param variants per node: the fixture params, then each enum option, each bool flipped, each int at its minimum. */
function variants(def: NodeDef, base: Record<string, any>): Record<string, any>[] {
  const out: Record<string, any>[] = [base];
  for (const [name, pd] of Object.entries(def.params)) {
    if (name in base) continue;
    if (pd.type === 'enum') for (const o of pd.options ?? []) { if (o !== pd.default) out.push({ ...base, [name]: o }); }
    else if (pd.type === 'bool') out.push({ ...base, [name]: !pd.default });
    else if (pd.type === 'int' && pd.min !== undefined && pd.min !== pd.default) out.push({ ...base, [name]: pd.min });
  }
  return out.slice(0, 24);
}

{
  const t0 = performance.now();
  let cooks = 0;
  const broken = new Set<string>();
  for (const def of allNodeDefs()) {
    if (SKIP.has(def.type) || !def.inputs.length) continue;
    const fixture = fixtureGraphFor(def.type);
    // second pass: input 0 carries point normals that do not match its shape, so an in-place normal refresh shows up
    const ins = Array.isArray(fixture.nodes.target.in) ? fixture.nodes.target.in : [];
    const stale: GraphSpec | null = typeof ins[0] === 'string'
      ? { ...fixture, nodes: { ...fixture.nodes, STALE_N: { type: 'wrangle', in: [ins[0]], params: { code: '@N = [0, 1, 0];' } }, target: { ...fixture.nodes.target, in: ['STALE_N', ...ins.slice(1)] } } }
      : null;
    for (const graph of stale ? [fixture, stale] : [fixture])
    for (const params of variants(def, graph.nodes.target.params ?? {})) {
      const upstream = Object.keys(graph.nodes).filter((n) => n !== 'target');
      const g: GraphSpec = { ...graph, nodes: { ...graph.nodes, target: { ...graph.nodes.target, params } } };
      // cook (or fetch from the cache) every upstream result first, then the target: the cache hands the target
      // the very objects fingerprinted here
      const before = new Map<string, { geo: any; fp: string }>();
      for (const n of upstream) {
        const r = await engine.cook({ ...g, output: n });
        if (r.geo) before.set(n, { geo: r.geo, fp: fpOf(r.geo) });
      }
      const t = performance.now();
      await engine.cook(g);
      cooks++;
      for (const [n, b] of before) {
        const now = fpOf(b.geo);
        if (now !== b.fp && !broken.has(def.type)) {
          broken.add(def.type);
          check(false, `immutability: ${def.type} ${JSON.stringify(params)} wrote to its input "${n}"`,
            formatDiff(diffFields(JSON.parse(b.fp), JSON.parse(now)), 8).join('\n'));
        }
      }
      if (performance.now() - t > 1500) break; // slow node: the fixture params are enough
    }
  }
  check(!broken.size, `immutability sweep: ${cooks} cooks, no node writes to its inputs (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
}

console.log(`bugs: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
