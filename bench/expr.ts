// Expression benchmark: graphs with 1000 "=expr" parameters, cooked cold (cache cleared) and warm (every node a
// cache hit, so the time is dominated by resolving params and hashing signatures).
//
//   node bench/expr.ts [--runs N] [--workers N]
//
// Shapes: "chain" = 1000 transforms in a row with one expression each; "wide" = 100 transforms with ten
// expressions each; "refs" = 100 boxes (nine expressions) and transforms (one) reading another node with bbox,
// npoints, ch, centroid …; "loops" = 100 transforms whose expression needs the timed path (an arrow function with a
// loop). Prints the median of N runs per shape.
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import type { GraphSpec, NodeSpec } from '../src/graph/types.ts';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const RUNS = Math.max(1, Number(flag('--runs') ?? 15));
const WORKERS = Number(flag('--workers') ?? 0);

function chain(): GraphSpec {
  const nodes: Record<string, NodeSpec> = { n0: { type: 'grid', params: { size: [1, 1], divisions: [1, 1] } } };
  for (let i = 1; i <= 1000; i++) nodes['n' + i] = { type: 'transform', in: ['n' + (i - 1)], params: { translate: [0, `=h * 0.001 + ${i % 7} * k`, 0] } };
  return { vars: { h: 2, k: 0.0001 }, nodes, output: 'n1000' };
}

function wide(): GraphSpec {
  const nodes: Record<string, NodeSpec> = { n0: { type: 'grid', params: { size: [1, 1], divisions: [1, 1] } } };
  for (let i = 1; i <= 100; i++) {
    nodes['n' + i] = {
      type: 'transform', in: ['n' + (i - 1)],
      params: {
        translate: [`=sin(${i} * 0.1) * a`, `=h * 0.001`, `=clamp(${i} / 100, 0, 1) * a`],
        rotate: [`=${i} * 0.5`, `=fit(${i}, 0, 100, 0, 10)`, `=pick([1, 2, 3], ${i}) * 0.1`],
        scale: [`=1 + ${i} * 1e-6`, `=1 + abs(cos(${i})) * 1e-6`, `=1 + lerp(0, 1e-6, 0.5)`],
        uniform_scale: `=max(1, min(2, h / 2))`,
      },
    };
  }
  return { vars: { h: 2, a: 0.01 }, nodes, output: 'n100' };
}

function refs(): GraphSpec {
  const nodes: Record<string, NodeSpec> = { base: { type: 'box', params: { size: [1, 2, 3] } } };
  const parts: string[] = [];
  for (let i = 1; i <= 100; i++) {
    nodes['b' + i] = {
      type: 'box',
      params: {
        size: ["=bbox('base').size.x * 0.1", "=npoints('base') * 0.01", "=ch('base/size')[2] * 0.1"],
        center: [`=${i} * 1.5 + centroid('base').x`, "=bbox('base').max.y", `=nprims('base') * 0 + ${i % 3}`],
        divisions: ["=1 + 0 * nvertices('base')", '=1', `=1 + (${i} % 2)`],
      },
    };
    nodes['t' + i] = { type: 'transform', in: ['b' + i], params: { translate: [0, "=(vars_off ?? 0) + bbox('base').min.y * 0", 0] } };
    parts.push('t' + i);
  }
  nodes.out = { type: 'merge', in: parts };
  return { vars: { vars_off: 0.5 }, nodes, output: 'out' };
}

function loops(): GraphSpec {
  const nodes: Record<string, NodeSpec> = { n0: { type: 'grid', params: { size: [1, 1], divisions: [1, 1] } } };
  for (let i = 1; i <= 100; i++) nodes['n' + i] = { type: 'transform', in: ['n' + (i - 1)], params: { translate: [0, `=((n) => { let s = 0; for (let j = 0; j < n; j++) s += j; return s * 1e-6; })(${i})`, 0] } };
  return { nodes, output: 'n100' };
}

const engine = new Engine(createNodeHost({ workers: WORKERS }));
await engine.init();
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

console.log(`expression benchmark, median of ${RUNS} runs, workers ${WORKERS}, ${process.version}`);
console.log('| shape | expressions | cold cook ms | warm cook ms |');
console.log('|---|---|---|---|');
for (const [name, g, count] of [['chain', chain(), 1000], ['wide', wide(), 1000], ['refs', refs(), 1000], ['loops', loops(), 100]] as const) {
  const cold: number[] = [], warm: number[] = [];
  for (let r = 0; r < RUNS + 1; r++) {
    engine.cache.clear();
    let t = performance.now();
    const rep = await engine.cook(g);
    const c = performance.now() - t;
    if (!rep.ok) throw new Error(`${name}: ${rep.errors.map((e) => `[${e.node}] ${e.message}`).join('; ')}`);
    t = performance.now();
    await engine.cook(g);
    const w = performance.now() - t;
    if (r > 0) { cold.push(c); warm.push(w); }
  }
  console.log(`| ${name} | ${count} | ${median(cold).toFixed(1)} | ${median(warm).toFixed(1)} |`);
}
await engine.host.pool?.close();
