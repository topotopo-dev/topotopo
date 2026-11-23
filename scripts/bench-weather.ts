// Benchmark cold weather bakes and consecutive slider changes on an already cooked model.
// node scripts/bench-weather.ts <prop.json>... [--resolution 1024,2048] [--leak-density 120,250]
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import type { CookOptions, CookReport } from '../src/graph/engine.ts';
import type { GraphSpec } from '../src/graph/types.ts';
import { createNodeHost } from '../src/host/node.ts';

process.env.TOPOTOPO_NODE_CACHE = 'off';

class WeatherBench extends Engine {
  weatherNode = '_bench_weather';
  steps: { label: string; ms: number }[] | null = null;

  override async cook(graph: GraphSpec, opts: CookOptions = {}): Promise<CookReport> {
    const report = await super.cook(graph, opts);
    if (this.steps && opts.within?.length === 1 && opts.within[0] === this.weatherNode) {
      for (const [name, result] of report.results) {
        if (result.cached) continue;
        const label = `${graph.nodes[name].type} (${name})`;
        let remaining = result.ms;
        for (const [stage, { ms }] of Object.entries(result.stages ?? {})) {
          this.steps.push({ label: `${label} ${stage}`, ms });
          remaining -= ms;
        }
        if (remaining > 0) this.steps.push({ label: `${label} ${result.stages ? 'other' : 'cook'}`, ms: remaining });
      }
    }
    return report;
  }
}

function checked(report: CookReport): CookReport {
  if (!report.ok || !report.geo) throw new Error(report.errors.map((e) => `[${e.node}] ${e.message}`).join('\n') || 'cook failed');
  return report;
}

async function run(propFile: string, resolution: number, density?: number): Promise<void> {
  const prop = JSON.parse(readFileSync(propFile, 'utf8')) as { graph: string; weather?: Record<string, unknown> };
  const graphFile = path.resolve(path.dirname(propFile), prop.graph);
  const graph = JSON.parse(readFileSync(graphFile, 'utf8')) as GraphSpec;
  const host = createNodeHost({ baseDir: path.dirname(graphFile) });
  const engine = new WeatherBench(host);
  console.log(`\n${path.basename(propFile)} at ${resolution}${density === undefined ? '' : `, leak_density ${density}`}`);
  try {
    await engine.init();
    const model = checked(await engine.cook(graph));
    while (Object.hasOwn(graph.nodes, engine.weatherNode)) engine.weatherNode += '_';
    const target = engine.weatherNode;
    let params = { ...prop.weather, resolution, ...(density === undefined ? {} : { leak_density: density }) };
    const cook = async (label: string) => {
      const report = checked(await engine.cook({
        ...graph, nodes: { ...graph.nodes, [target]: { type: 'weather', in: model.target, params } },
      }, { target }));
      console.log(`${label}: ${report.results.get(target)!.ms.toFixed(1)} ms`);
    };
    const steps: NonNullable<WeatherBench['steps']> = [];
    engine.steps = steps;
    await cook('cold');
    engine.steps = null;
    if (density === undefined) {
      const seed = Number(prop.weather?.seed ?? 0) + 1;
      for (const [name, value] of [['dirt', 0.7], ['rust', 0.7], ['age', 0.8], ['wear', 0.8], ['seed', seed]] as const) {
        params = { ...params, [name]: value };
        await cook(`${name} ${value}`);
      }
    }
    console.log(`peak RSS: ${(process.resourceUsage().maxRSS / 1024).toFixed(1)} MiB`);
    for (const { label, ms } of steps.sort((a, b) => b.ms - a.ms).slice(0, 10)) console.log(`${label}: ${ms.toFixed(1)} ms`);
  } finally {
    await host.pool?.close();
  }
}

function values(flag: string, arg: string | undefined, min: number): number[] {
  const list = arg?.split(',').map((s) => s.trim());
  if (!list?.length || list.some((s) => !s || !Number.isSafeInteger(Number(s)) || Number(s) < min)) {
    throw new Error(`${flag} needs a comma-separated list of integers >= ${min}`);
  }
  return list.map(Number);
}

const args = process.argv.slice(2);
if (args[0] === '--case') {
  await run(args[1], Number(args[2]), args[3] === undefined ? undefined : Number(args[3]));
} else {
  const props: string[] = [];
  let resolutions = [1024, 2048], densities: number[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--resolution') resolutions = values(arg, args[++i], 1);
    else if (arg === '--leak-density') densities = values(arg, args[++i], 0);
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else props.push(arg);
  }
  if (!props.length) throw new Error('usage: node scripts/bench-weather.ts <prop.json>... [--resolution 1024,2048] [--leak-density 120,250]');
  // Each case needs its own process so peak RSS does not include the high-water mark of earlier cases.
  for (const prop of props) for (const res of resolutions) for (const density of [undefined, ...densities]) {
    const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), '--case', prop, String(res),
      ...(density === undefined ? [] : [String(density)])], { stdio: 'inherit' });
    if (child.error) throw child.error;
    if (child.status !== 0) process.exitCode = child.status ?? 1;
  }
}
