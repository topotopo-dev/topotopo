// Benchmarks: named cooks with target times, printed as a Markdown table and written to bench/last.json.
//
//   npm run bench                         full sizes
//   npm run bench -- --quick              smaller sizes (CI smoke, quick local checks)
//   npm run bench -- --filter boolean     only cases whose name contains "boolean"
//   npm run bench -- --runs 5             timed runs per case (default 3, after one warm-up)
//   npm run bench -- --write-baseline     also store the results as bench/baseline.json
//
// Each case cooks a graph with a cleared cache (warm-up run, then best of N). The time reported is the target node's
// own cook time (inputs are cooked first and not counted); "total" is the whole graph. Targets come from
// docs/ROADMAP.md §1.7 where it names one, otherwise they are working goals. Results are informational: a missed
// target never fails the run (a failed cook does). bench/baseline.json is a reference run from one machine.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import type { GraphSpec, NodeSpec } from '../src/graph/types.ts';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const QUICK = args.includes('--quick');
const FILTER = flag('--filter');
const RUNS = Math.max(1, Number(flag('--runs') ?? 3));
const benchDir = path.dirname(fileURLToPath(import.meta.url));

interface Case {
  name: string;
  /** what is measured, for the table */
  what: (q: boolean) => string;
  /** element count the throughput is computed from */
  elements: (q: boolean) => number;
  unit: string;
  /** target for the full size (ms); quick runs scale it by quickScale */
  target: number;
  targetSource: string;
  graph: (q: boolean) => GraphSpec;
}

const k = (n: number) => (n >= 1e6 ? `${+(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}k` : String(n));

/** Grid with about n faces (square, divisions d×d). */
const gridDiv = (faces: number) => Math.round(Math.sqrt(faces));
/** uv sphere rows/cols with about n triangles once triangulated: 2·(rows−2)·cols + 2·cols ≈ rows·cols·2 with cols = 2·rows. */
const sphereRows = (tris: number) => Math.round(Math.sqrt(tris / 4));
const uvSphereTris = (rows: number) => 2 * (rows - 2) * (2 * rows) + 2 * (2 * rows);

const CASES: Case[] = [
  {
    name: 'scatter_1m',
    what: (q) => `scatter ${k(q ? 1e5 : 1e6)} points on a grid (relax off)`,
    elements: (q) => (q ? 1e5 : 1e6), unit: 'points',
    target: 1000, targetSource: 'roadmap §1.7 (scatter + packed copy of 1M under 1 s)',
    graph: (q) => ({
      nodes: {
        g: { type: 'grid', params: { size: [100, 100], divisions: [100, 100] } },
        target: { type: 'scatter', in: ['g'], params: { count: q ? 1e5 : 1e6, relax: false, seed: 1 } },
      },
    }),
  },
  {
    name: 'copy_to_points_100k',
    what: (q) => `copy a 100-triangle mesh to ${k(q ? 1e4 : 1e5)} points`,
    elements: (q) => (q ? 1e4 : 1e5) * 100, unit: 'triangles out',
    target: 1000, targetSource: 'goal (roadmap targets packed copies; these are real copies)',
    graph: (q) => ({
      nodes: {
        tg: { type: 'grid', params: { size: [0.05, 0.05], divisions: [10, 5] } },
        tt: { type: 'triangulate', in: ['tg'] },
        tmpl: { type: 'attrib_delete', in: ['tt'], params: { names: '*' } },
        pts: { type: 'point_grid', params: { counts: q ? [100, 1, 100] : [100, 10, 100], size: [100, 10, 100] } },
        target: { type: 'copy_to_points', in: ['tmpl', 'pts'] },
      },
    }),
  },
  {
    name: 'subdivide_100k',
    what: (q) => `Catmull-Clark, 1 level, ${k(gridDiv(q ? 1e4 : 1e5) ** 2)}-face grid`,
    elements: (q) => gridDiv(q ? 1e4 : 1e5) ** 2, unit: 'input faces',
    target: 500, targetSource: 'roadmap §1.7 (100k faces × 2 levels under 1 s)',
    graph: (q) => ({
      nodes: {
        g: { type: 'grid', params: { size: [10, 10], divisions: [gridDiv(q ? 1e4 : 1e5), gridDiv(q ? 1e4 : 1e5)] } },
        target: { type: 'subdivide', in: ['g'], params: { levels: 1 } },
      },
    }),
  },
  {
    name: 'subdivide_100k_x2',
    what: (q) => `Catmull-Clark, 2 levels, ${k(gridDiv(q ? 1e4 : 1e5) ** 2)}-face grid`,
    elements: (q) => gridDiv(q ? 1e4 : 1e5) ** 2, unit: 'input faces',
    target: 1000, targetSource: 'roadmap §1.7',
    graph: (q) => ({
      nodes: {
        g: { type: 'grid', params: { size: [10, 10], divisions: [gridDiv(q ? 1e4 : 1e5), gridDiv(q ? 1e4 : 1e5)] } },
        target: { type: 'subdivide', in: ['g'], params: { levels: 2 } },
      },
    }),
  },
  {
    name: 'boolean_100k',
    what: (q) => `boolean subtract of two ${k(uvSphereTris(sphereRows(q ? 2e4 : 1e5)))}-triangle spheres`,
    elements: (q) => 2 * uvSphereTris(sphereRows(q ? 2e4 : 1e5)), unit: 'input triangles',
    target: 1200, targetSource: 'roadmap §1.7 (500k triangles under 3 s), scaled to 200k',
    graph: (q) => booleanGraph(sphereRows(q ? 2e4 : 1e5)),
  },
  {
    name: 'boolean_500k',
    what: (q) => `boolean subtract of two ${k(uvSphereTris(sphereRows(q ? 5e4 : 2.5e5)))}-triangle spheres`,
    elements: (q) => 2 * uvSphereTris(sphereRows(q ? 5e4 : 2.5e5)), unit: 'input triangles',
    target: 3000, targetSource: 'roadmap §1.7',
    graph: (q) => booleanGraph(sphereRows(q ? 5e4 : 2.5e5)),
  },
  {
    name: 'noise_displace_1m',
    what: (q) => `noise_displace (fbm, along normals) on ${k((gridDiv(q ? 1e5 : 1e6) + 1) ** 2)} points`,
    elements: (q) => (gridDiv(q ? 1e5 : 1e6) + 1) ** 2, unit: 'points',
    target: 1000, targetSource: 'goal',
    graph: (q) => ({
      nodes: {
        g: { type: 'grid', params: { size: [10, 10], divisions: [gridDiv(q ? 1e5 : 1e6), gridDiv(q ? 1e5 : 1e6)] } },
        target: { type: 'noise_displace', in: ['g'], params: { amplitude: 0.2, frequency: 2 } },
      },
    }),
  },
  {
    name: 'wrangle_1m',
    what: (q) => `point wrangle (sin + colour) over ${k((gridDiv(q ? 1e5 : 1e6) + 1) ** 2)} points`,
    elements: (q) => (gridDiv(q ? 1e5 : 1e6) + 1) ** 2, unit: 'points',
    target: 500, targetSource: 'goal',
    graph: (q) => ({
      nodes: {
        g: { type: 'grid', params: { size: [10, 10], divisions: [gridDiv(q ? 1e5 : 1e6), gridDiv(q ? 1e5 : 1e6)] } },
        target: { type: 'wrangle', in: ['g'], params: { code: '@P.y += sin(@P.x * 3) * 0.1;\n@Cd = [@P.x, @P.y, 0.5];' } },
      },
    }),
  },
  {
    name: 'sdf_to_mesh_128',
    what: (q) => `sdf_to_mesh of a torus at ${q ? 64 : 128}³`,
    elements: (q) => (q ? 64 : 128) ** 3, unit: 'voxels',
    target: 1000, targetSource: 'goal',
    graph: (q) => ({
      nodes: {
        s: { type: 'sdf_shape', params: { shape: 'torus', radius: 0.6, radius2: 0.2 } },
        target: { type: 'sdf_to_mesh', in: ['s'], params: { divisions: q ? 64 : 128 } },
      },
    }),
  },
  {
    name: 'triangulate_500k',
    what: (q) => `triangulate a ${k(gridDiv(q ? 5e4 : 5e5) ** 2)}-quad grid`,
    elements: (q) => gridDiv(q ? 5e4 : 5e5) ** 2, unit: 'polygons',
    target: 500, targetSource: 'goal',
    graph: (q) => ({
      nodes: {
        g: { type: 'grid', params: { size: [10, 10], divisions: [gridDiv(q ? 5e4 : 5e5), gridDiv(q ? 5e4 : 5e5)] } },
        target: { type: 'triangulate', in: ['g'] },
      },
    }),
  },
  {
    name: 'merge_100',
    what: (q) => `merge ${q ? 20 : 100} spheres (1280 triangles each)`,
    elements: (q) => (q ? 20 : 100) * 1280, unit: 'triangles out',
    target: 100, targetSource: 'goal',
    graph: (q) => {
      const n = q ? 20 : 100;
      const nodes: Record<string, NodeSpec> = {};
      const ins: string[] = [];
      for (let i = 0; i < n; i++) {
        nodes[`s${i}`] = { type: 'sphere', params: { type: 'ico', level: 3, radius: 0.4, center: [i % 10, 0, Math.floor(i / 10)] } };
        ins.push(`s${i}`);
      }
      nodes.target = { type: 'merge', in: ins };
      return { nodes, output: 'target' };
    },
  },
  {
    name: 'fuse_500k',
    what: (q) => `fuse ${k(2 * (gridDiv(q ? 5e4 : 2.5e5) + 1) ** 2)} points (every point doubled)`,
    elements: (q) => 2 * (gridDiv(q ? 5e4 : 2.5e5) + 1) ** 2, unit: 'points',
    target: 1000, targetSource: 'goal',
    graph: (q) => ({
      nodes: {
        g: { type: 'grid', params: { size: [10, 10], divisions: [gridDiv(q ? 5e4 : 2.5e5), gridDiv(q ? 5e4 : 2.5e5)] } },
        two: { type: 'copy_xform', in: ['g'], params: { count: 2, translate: [0, 0, 0] } },
        target: { type: 'fuse', in: ['two'], params: { distance: 1e-4 } },
      },
    }),
  },
  {
    name: 'copy_to_points_1m_packed',
    what: (q) => `packed copies of a 100-triangle mesh on ${k(q ? 1e5 : 1e6)} points (orient + pscale)`,
    elements: (q) => (q ? 1e5 : 1e6), unit: 'instances',
    target: 1000, targetSource: 'roadmap §1.7 (scatter + packed copy of 1M under 1 s)',
    graph: (q) => ({
      nodes: {
        tg: { type: 'grid', params: { size: [0.05, 0.05], divisions: [10, 5] } },
        tt: { type: 'triangulate', in: ['tg'] },
        tmpl: { type: 'attrib_delete', in: ['tt'], params: { names: '*' } },
        pts: { type: 'point_grid', params: { counts: q ? [100, 10, 100] : [100, 100, 100], size: [100, 10, 100] } },
        ori: { type: 'attrib_randomize', in: ['pts'], params: { name: 'orient', distribution: 'orient' } },
        sc: { type: 'attrib_randomize', in: ['ori'], params: { name: 'pscale', min: 0.5, max: 1.5 } },
        target: { type: 'copy_to_points', in: ['tmpl', 'sc'], params: { pack: true } },
      },
    }),
  },
  {
    name: 'unpack_100k',
    what: (q) => `unpack ${k(q ? 1e4 : 1e5)} packed instances of a 100-triangle mesh`,
    elements: (q) => (q ? 1e4 : 1e5) * 100, unit: 'triangles out',
    target: 2000, targetSource: 'goal (P2-A)',
    graph: (q) => ({
      nodes: {
        tg: { type: 'grid', params: { size: [0.05, 0.05], divisions: [10, 5] } },
        tt: { type: 'triangulate', in: ['tg'] },
        tmpl: { type: 'attrib_delete', in: ['tt'], params: { names: '*' } },
        pts: { type: 'point_grid', params: { counts: q ? [100, 1, 100] : [100, 10, 100], size: [100, 10, 100] } },
        ori: { type: 'attrib_randomize', in: ['pts'], params: { name: 'orient', distribution: 'orient' } },
        cp: { type: 'copy_to_points', in: ['tmpl', 'ori'], params: { pack: true } },
        target: { type: 'unpack', in: ['cp'] },
      },
    }),
  },
];

function booleanGraph(rows: number): GraphSpec {
  return {
    nodes: {
      a: { type: 'sphere', params: { type: 'uv', rows, cols: 2 * rows, radius: 1 } },
      b: { type: 'sphere', params: { type: 'uv', rows, cols: 2 * rows, radius: 0.8, center: [0.7, 0.2, 0.1] } },
      target: { type: 'boolean', in: ['a', 'b'], params: { operation: 'subtract' } },
    },
  };
}

// ------------------------------------------------------------------ run

const engine = new Engine(createNodeHost({ baseDir: benchDir }));
await engine.init();

const baselinePath = path.join(benchDir, 'baseline.json');
const baseline = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, 'utf8')) : null;
const baselineMs = (name: string): number | undefined =>
  baseline && baseline.quick === QUICK ? baseline.results?.find((r: any) => r.name === name)?.ms : undefined;

interface Result {
  name: string; what: string; elements: number; unit: string; ms: number; runs: number[]; total_ms: number;
  elements_per_sec: number; target_ms: number; target_source: string; meets_target: boolean; out: string;
}
const results: Result[] = [];
let failed = 0;
const selected = CASES.filter((c) => !FILTER || c.name.includes(FILTER));
if (!selected.length) { console.log(`no benchmark matches "${FILTER}". Cases: ${CASES.map((c) => c.name).join(', ')}`); process.exit(1); }

console.log(`polyforge bench${QUICK ? ' (quick)' : ''}: ${selected.length} case(s), warm-up + best of ${RUNS} · node ${process.version} · ${os.cpus()[0]?.model ?? os.arch()}\n`);
for (const c of selected) {
  const graph = c.graph(QUICK);
  const times: number[] = [], totals: number[] = [];
  let out = '', error = '';
  for (let run = 0; run <= RUNS; run++) {
    engine.cache.clear();
    const r = await engine.cook(graph, { target: 'target' });
    if (!r.ok || !r.geo) { error = r.errors.map((e) => `[${e.node}] ${e.message}`).join('; '); break; }
    out = `${k(r.geo.numPoints)} pts, ${k(r.geo.numPrims)} prims`;
    if (run === 0) continue; // warm-up
    times.push(r.results.get('target')!.ms);
    totals.push(r.ms);
  }
  engine.cache.clear();
  if (error) {
    failed++;
    console.log(`FAIL ${c.name}: ${error}`);
    continue;
  }
  const ms = Math.min(...times);
  const elements = c.elements(QUICK);
  const res: Result = {
    name: c.name, what: c.what(QUICK), elements, unit: c.unit, ms: +ms.toFixed(1), runs: times.map((t) => +t.toFixed(1)),
    total_ms: +Math.min(...totals).toFixed(1), elements_per_sec: Math.round(elements / (ms / 1000)),
    target_ms: c.target, target_source: c.targetSource, meets_target: ms <= c.target, out,
  };
  results.push(res);
  console.log(`  ${c.name.padEnd(22)} ${res.ms.toFixed(0).padStart(7)} ms  (graph ${res.total_ms.toFixed(0)} ms)  ${out}`);
}

const fmtRate = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)} M` : `${(n / 1e3).toFixed(1)} k`);
const lines = [
  '',
  `| case | what | elements | ms (best of ${RUNS}) | elements/s | target ms | ${baseline ? 'baseline ms | ' : ''}status |`,
  `|---|---|---|---|---|---|${baseline ? '---|' : ''}---|`,
];
for (const r of results) {
  const b = baselineMs(r.name);
  lines.push(`| ${r.name} | ${r.what} | ${k(r.elements)} ${r.unit} | ${r.ms.toFixed(0)} | ${fmtRate(r.elements_per_sec)} | ${r.target_ms}${QUICK ? ' (full size)' : ''} | ${baseline ? `${b === undefined ? '–' : b.toFixed(0)} | ` : ''}${QUICK ? '–' : r.meets_target ? 'ok' : 'slower'} |`);
}
console.log(lines.join('\n'));
if (QUICK) console.log('\n(quick sizes: targets apply to full-size runs only)');

const report = {
  generated: new Date().toISOString(),
  node: process.version, platform: `${process.platform}-${process.arch}`, cpu: os.cpus()[0]?.model ?? '', cpus: os.cpus().length,
  quick: QUICK, runs: RUNS, results,
};
fs.writeFileSync(path.join(benchDir, 'last.json'), JSON.stringify(report, null, 2) + '\n');
if (args.includes('--write-baseline')) {
  if (FILTER) console.log('not writing baseline: run without --filter');
  else { fs.writeFileSync(baselinePath, JSON.stringify(report, null, 2) + '\n'); console.log('wrote bench/baseline.json'); }
}
console.log(`\nwrote bench/last.json${failed ? ` · ${failed} case(s) failed to cook` : ''}`);
process.exit(failed ? 1 : 0);
