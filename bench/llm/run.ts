// TopoTopo Bench: run models on the task suite through TopoTopo's own MCP server, the way an agent uses it.
//
//   node bench/llm/run.ts --model anthropic:claude-opus-5-5
//   node bench/llm/run.ts --model openai:<model> --tasks stone_bridge,oak_tree --effort high
//   node bench/llm/run.ts --model compat:<model> --base-url http://localhost:8000/v1 --api-key-env MY_KEY --no-images
//   node bench/llm/run.ts --model script:bench/llm/reference --label reference    (the hand-written solutions)
//
// Every task runs in a fresh package with a fresh MCP server (src/mcp/server.ts): the model gets the server's tools
// and instructions, the task's prompt, and a budget of tool calls and minutes. When it stops, the graph it left in the
// package is cooked again, checked, rendered from a fixed camera and exported (bench/llm/score.ts). Each result is
// filed under the TopoTopo version it ran on: bench/llm/results/<version>/<model>/<task>/, so a newer engine never
// overwrites or silently mixes with older results (bench/llm/report.ts shows one version at a time).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { TOPOTOPO_VERSION } from '../../src/host/version.ts';
import { makeProvider, PRICES, estimateCost } from './providers.ts';
import type { ToolOutput, ToolSpec, Usage } from './providers.ts';
import { scoreResult } from './score.ts';
import type { Task } from './score.ts';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');
export const TASKS_DIR = path.join(HERE, 'tasks');

/** The bench's own instructions, the same for every model; the MCP server's instructions follow them. */
export const SYSTEM = `You are an agent with TopoTopo, a procedural geometry engine, connected through its MCP tools. A person asks you for a 3D asset or scene. Build it with the tools: the result is the package's default graph, "main". Look at your result (render, inspect) and improve it while you have tool calls left; it is judged on how it looks and on the person's requirements (sizes in metres, Y up). When it is done, reply with two or three sentences on what you built, and stop calling tools.`;

export const promptOf = (t: Task, limits: { toolCalls: number }) =>
  `${t.prompt}\n\nBuild it as the graph named "main" (replace what is there). You have at most ${limits.toolCalls} tool calls.`;

export function loadTasks(ids?: string[]): Task[] {
  const all = fs.readdirSync(TASKS_DIR).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), 'utf8')) as Task);
  if (!ids?.length) return all;
  const missing = ids.filter((id) => !all.some((t) => t.id === id));
  if (missing.length) throw new Error(`no task ${missing.join(', ')} (tasks: ${all.map((t) => t.id).join(', ')})`);
  return all.filter((t) => ids.includes(t.id));
}

/** The suite's identity: a hash of its task files and their inputs, so results of an edited suite are told apart. */
export function suiteHash(): string {
  const h = crypto.createHash('sha256');
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { h.update(path.relative(TASKS_DIR, p)); h.update(fs.readFileSync(p)); }
    }
  };
  walk(TASKS_DIR);
  return h.digest('hex').slice(0, 10);
}

function gitCommit(): string | null {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--', 'src'], { cwd: ROOT, encoding: 'utf8' }).trim();
    return dirty ? `${sha}+changes` : sha;
  } catch { return null; }
}

export const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'model';

/** The MCP server on a package folder, with a config of its own (no libraries of this machine take part). */
async function startServer(pkgDir: string) {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topotopo-bench-config-'));
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ libraries: [] }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'src/mcp/server.ts'), '--package', pkgDir],
    env: { ...getDefaultEnvironment(), TOPOTOPO_CONFIG: path.join(cfgDir, 'config.json') },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'topotopo-bench', version: TOPOTOPO_VERSION });
  await client.connect(transport);
  return { client, close: async () => { await client.close().catch(() => {}); fs.rmSync(cfgDir, { recursive: true, force: true }); } };
}

/** The package's graphs as they are: name → text. */
function graphTexts(pkgDir: string): Map<string, string> {
  const dir = path.join(pkgDir, 'graphs'), out = new Map<string, string>();
  if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) out.set(f.slice(0, -5), fs.readFileSync(path.join(dir, f), 'utf8'));
  return out;
}

/**
 * The graph the agent left: "main" when it changed it, else the graph it changed last; null when it changed none (the
 * starter graph the server made is not the agent's work).
 */
function resultGraph(pkgDir: string, before: Map<string, string>): { name: string; file: string } | null {
  const dir = path.join(pkgDir, 'graphs'), now = graphTexts(pkgDir);
  const changed = [...now].filter(([name, text]) => before.get(name) !== text).map(([name]) => ({ name, file: path.join(dir, `${name}.json`), t: fs.statSync(path.join(dir, `${name}.json`)).mtimeMs }));
  return changed.find((f) => f.name === 'main') ?? changed.sort((a, b) => b.t - a.t)[0] ?? null;
}

export interface RunOptions {
  model: string;
  label?: string;
  tasks?: string[];
  out: string;
  toolCalls: number;
  minutes: number;
  effort?: string;
  images: boolean;
  baseUrl?: string;
  apiKeyEnv?: string;
  price?: [number, number];
  log?: (s: string) => void;
}

export async function runTask(task: Task, o: RunOptions): Promise<any> {
  const log = o.log ?? ((s: string) => process.stderr.write(s + '\n'));
  const provider = makeProvider(o.model, { effort: o.effort, images: o.images, baseUrl: o.baseUrl, apiKeyEnv: o.apiKeyEnv });
  const label = o.label ?? `${provider.model}${o.effort ? ` (${o.effort})` : ''}`;
  const outDir = path.join(o.out, slug(TOPOTOPO_VERSION), slug(label), task.id);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const pkgDir = fs.mkdtempSync(path.join(os.tmpdir(), `topotopo-bench-${task.id}-`));
  if (task.inputs) fs.cpSync(path.join(TASKS_DIR, task.inputs), pkgDir, { recursive: true });

  const server = await startServer(pkgDir);
  const { tools: mcpTools } = await server.client.listTools();
  const tools: ToolSpec[] = mcpTools.map((t) => ({ name: t.name, description: t.description ?? '', schema: t.inputSchema as any }));
  const system = `${SYSTEM}\n\n${server.client.getInstructions() ?? ''}`.trim();
  const limits = { toolCalls: o.toolCalls, minutes: o.minutes };
  const conv = provider.start(task.id, system, promptOf(task, limits), tools);

  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const transcript: any[] = [];
  const before = graphTexts(pkgDir);
  const t0 = performance.now(), deadline = t0 + o.minutes * 60_000;
  let calls = 0, turns = 0, stop = 'done', error: string | null = null, finalText = '', toolErrors = 0;
  try {
    for (;;) {
      if (performance.now() > deadline) { stop = 'time_limit'; break; }
      const turn = await conv.next();
      turns++;
      for (const k of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) usage[k] += turn.usage[k];
      const entry: any = { turn: turns, text: turn.text, stop: turn.stop, usage: turn.usage, calls: [] };
      transcript.push(entry);
      if (turn.text) finalText = turn.text;
      if (turn.stop === 'refusal') { stop = 'refusal'; break; }
      if (!turn.calls.length) { stop = turn.stop === 'end' ? 'done' : turn.stop; break; }
      const results: ToolOutput[] = [];
      for (const c of turn.calls) {
        if (calls >= o.toolCalls || performance.now() > deadline) {
          results.push({ id: c.id, text: `Not run: the budget of ${o.toolCalls} tool calls${performance.now() > deadline ? ` or ${o.minutes} minutes` : ''} is used up. Reply with your summary now.`, images: [], isError: true });
          continue;
        }
        calls++;
        const c0 = performance.now();
        let out: ToolOutput;
        try {
          const r: any = await server.client.callTool({ name: c.name, arguments: c.input ?? {} }, undefined, { timeout: 10 * 60_000 });
          const content: any[] = r.content ?? [];
          out = { id: c.id, text: content.filter((x) => x.type === 'text').map((x) => x.text).join('\n'), images: content.filter((x) => x.type === 'image').map((x) => ({ data: x.data, mimeType: x.mimeType })), isError: !!r.isError };
        } catch (e: any) {
          out = { id: c.id, text: `tool call failed: ${e?.message ?? e}`, images: [], isError: true };
        }
        if (out.isError) toolErrors++;
        results.push(out);
        entry.calls.push({ name: c.name, input: c.input, ms: Math.round(performance.now() - c0), isError: out.isError, result: out.text.slice(0, 4000), images: out.images.length });
        log(`  ${task.id} · ${c.name}${out.isError ? ' (error)' : ''} · ${calls}/${o.toolCalls}`);
      }
      conv.addResults(results);
      if (calls >= o.toolCalls && results.every((r) => r.isError && r.text.startsWith('Not run'))) { stop = 'tool_call_limit'; break; }
    }
  } catch (e: any) {
    stop = 'error'; error = String(e?.message ?? e);
    log(`  ${task.id}: ${error}`);
  }
  const wallMs = Math.round(performance.now() - t0);
  await server.close();

  const graph = resultGraph(pkgDir, before);
  if (graph) fs.copyFileSync(graph.file, path.join(outDir, 'graph.json'));
  const scored = await scoreResult(task, pkgDir, graph?.file ?? null, outDir);
  const price = o.price ?? PRICES[provider.model];
  const result = {
    task: task.id, title: task.title, category: task.category,
    model: provider.model, provider: provider.kind, label,
    topotopo: { version: TOPOTOPO_VERSION, commit: gitCommit() },
    suite: suiteHash(),
    date: new Date().toISOString(),
    settings: { effort: o.effort ?? 'default', images: o.images, limits },
    metrics: { toolCalls: calls, turns, toolErrors, wallMs, usage, costUSD: estimateCost(usage, price) },
    stop, error, graph: graph?.name ?? null, finalText,
    ...scored,
  };
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 1));
  fs.writeFileSync(path.join(outDir, 'transcript.json'), JSON.stringify({ system, prompt: promptOf(task, limits), tools: tools.map((t) => t.name), turns: transcript }, null, 1));
  fs.rmSync(pkgDir, { recursive: true, force: true });
  return result;
}

// ------------------------------------------------------------------ command line
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const arg = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const model = arg('--model');
  if (!model || argv.includes('--help')) {
    console.log(`usage: node bench/llm/run.ts --model <provider:model> [--label name] [--tasks a,b] [--effort low|medium|high|xhigh|max]
       [--tool-calls 40] [--minutes 15] [--no-images] [--base-url url] [--api-key-env VAR] [--price in,out] [--out bench/llm/results]
providers: anthropic, openai, openrouter, google, deepseek, xai, ollama, compat (--base-url), script:<folder of <task>.json>
tasks: ${loadTasks().map((t) => t.id).join(', ')}`);
    process.exit(model ? 0 : 2);
  }
  const price = arg('--price')?.split(',').map(Number) as [number, number] | undefined;
  const o: RunOptions = {
    model, label: arg('--label'), tasks: arg('--tasks')?.split(',').filter(Boolean),
    out: path.resolve(arg('--out') ?? path.join(HERE, 'results')),
    toolCalls: Number(arg('--tool-calls') ?? 40), minutes: Number(arg('--minutes') ?? 15),
    effort: arg('--effort'), images: !argv.includes('--no-images'), baseUrl: arg('--base-url'), apiKeyEnv: arg('--api-key-env'), price,
  };
  const tasks = loadTasks(o.tasks);
  console.log(`TopoTopo ${TOPOTOPO_VERSION} · suite ${suiteHash()} · ${model} · ${tasks.length} task(s)`);
  let sum = 0;
  for (const t of tasks) {
    const r = await runTask(t, o);
    sum += r.score;
    console.log(`${r.score.toString().padStart(3)}  ${t.id}  ${r.stop} · ${r.metrics.toolCalls} tool calls · ${(r.metrics.wallMs / 1000).toFixed(0)} s${r.metrics.costUSD !== null ? ` · ~$${r.metrics.costUSD.toFixed(2)}` : ''}${r.errors.length ? ` · ${r.errors[0]}` : ''}`);
  }
  console.log(`mean ${(sum / tasks.length).toFixed(1)} · results in ${path.relative(process.cwd(), o.out) || '.'} · node bench/llm/report.ts builds the comparison page`);
}
