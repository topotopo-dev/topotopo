// TopoTopo Bench (bench/llm/) end to end, with no model and no network: scripted tool calls go through the real MCP
// server, the result is cooked, checked, rendered and exported, and the comparison page is built from it.
//   node test/llmbench.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTask, loadTasks, suiteHash } from '../bench/llm/run.ts';
import { buildReport, collect } from '../bench/llm/report.ts';
import { checkLabel, scoreOf } from '../bench/llm/score.ts';
import { makeProvider, estimateCost } from '../bench/llm/providers.ts';
import { TOPOTOPO_VERSION } from '../src/host/version.ts';

let failures = 0, passes = 0;
const check = (cond: unknown, msg: string) => { if (cond) passes++; else failures++; console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'topotopo-llmbench-'));
const out = path.join(tmp, 'results'), scripts = path.join(tmp, 'scripts');
fs.mkdirSync(scripts);
const quiet = () => {};

try {
  // the suite: every task loads, has checks, and has a reference solution that passes them all
  const tasks = loadTasks();
  check(tasks.length >= 8 && tasks.every((t) => t.id && t.prompt && t.checks.some((c) => c.kind === 'cooks')), `${tasks.length} tasks, each with a prompt and a "cooks" check`);
  const refDir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'bench', 'llm', 'reference');
  check(tasks.every((t) => fs.existsSync(path.join(refDir, `${t.id}.json`))), 'every task has a hand-written reference solution');
  check(/^[0-9a-f]{10}$/.test(suiteHash()) && suiteHash() === suiteHash(), `the suite has a stable hash (${suiteHash()})`);

  // a reference solution through the whole pipeline
  const base = { out, toolCalls: 10, minutes: 5, images: true, log: quiet };
  const bridge = tasks.find((t) => t.id === 'stone_bridge')!;
  const ref = await runTask(bridge, { ...base, model: `script:${refDir}`, label: 'reference' });
  const dir = path.join(out, TOPOTOPO_VERSION, 'reference', 'stone_bridge');
  check(ref.score === 100 && ref.ok && ref.stop === 'done' && ref.graph === 'main', `the bridge reference scores 100 (${ref.score}, ${ref.stop}, ${ref.errors.join('; ')})`);
  check(['result.json', 'transcript.json', 'graph.json', 'render.png', 'views.png', 'model.glb'].every((f) => fs.existsSync(path.join(dir, f))), 'a result keeps its graph, transcript, renders and GLB');
  check(ref.topotopo.version === TOPOTOPO_VERSION && ref.suite === suiteHash() && ref.metrics.toolCalls === 1, 'a result records the TopoTopo version, the suite and the tool calls');
  const tr = JSON.parse(fs.readFileSync(path.join(dir, 'transcript.json'), 'utf8'));
  check(tr.system.includes('TopoTopo') && tr.system.includes('WORKFLOW') && tr.tools.includes('build') && tr.turns[0].calls[0].name === 'build',
    'the transcript holds the system prompt (the bench\'s and the server\'s instructions), the tools and the calls');
  const png = fs.readFileSync(path.join(dir, 'render.png'));
  check(png.readUInt32BE(16) === 960 && png.readUInt32BE(20) === 720, 'the hero render is 960 × 720 (no footer line)');

  // a model that builds something broken scores 0, one that builds the wrong size loses that check
  fs.writeFileSync(path.join(scripts, 'stone_bridge.json'), JSON.stringify({ turns: [{ calls: [{ name: 'build', input: { graph: { nodes: { b: { type: 'box', params: { size: 'oops' } } }, output: 'b' } } }] }] }));
  fs.writeFileSync(path.join(scripts, 'game_crate.json'), JSON.stringify({ turns: [{ calls: [{ name: 'build', input: { graph: { nodes: { b: { type: 'box', params: { size: 3 } } }, output: 'b' } } }] }, { text: 'a crate' }] }));
  const broken = await runTask(bridge, { ...base, model: `script:${scripts}`, label: 'broken' });
  check(broken.score === 0 && !broken.ok && broken.checks.every((c: any) => !c.pass), `a graph that does not cook scores 0 (${broken.errors[0] ?? broken.stop})`);
  const crate = tasks.find((t) => t.id === 'game_crate')!;
  const big = await runTask(crate, { ...base, model: `script:${scripts}`, label: 'broken' });
  const failed = big.checks.filter((c: any) => !c.pass).map((c: any) => c.kind);
  check(big.ok && failed.join() === 'extent,extent,extent,triangles' && big.score === Math.round((100 * 3) / 7) && big.finalText === 'a crate',
    `a 3 m box for the crate fails the three size checks and the triangle minimum, and passes the rest (score ${big.score}, failed ${failed.join(', ')})`);

  // the tool-call budget: calls past it are not run, and the run says so
  fs.writeFileSync(path.join(scripts, 'oak_tree.json'), JSON.stringify({ turns: [{ calls: [1, 2, 3].map(() => ({ name: 'catalog', input: {} })) }, { calls: [{ name: 'catalog', input: {} }] }] }));
  const oak = tasks.find((t) => t.id === 'oak_tree')!;
  const limited = await runTask(oak, { ...base, toolCalls: 2, model: `script:${scripts}`, label: 'broken' });
  check(limited.metrics.toolCalls === 2 && limited.stop === 'tool_call_limit' && limited.score === 0 && limited.graph === null && /left no graph/.test(limited.errors[0]),
    `the tool-call budget stops a run, and the starter graph is not taken for the agent's work (${limited.metrics.toolCalls} calls, ${limited.stop}, ${limited.errors[0]})`);

  // the page: one per TopoTopo version, the newest as index.html
  const old = path.join(out, '0.0.1', 'reference', 'stone_bridge');
  fs.cpSync(dir, old, { recursive: true });
  const r = JSON.parse(fs.readFileSync(path.join(old, 'result.json'), 'utf8'));
  r.topotopo.version = '0.0.1';
  fs.writeFileSync(path.join(old, 'result.json'), JSON.stringify(r));
  check([...collect(out).keys()].sort().join() === `0.0.1,${TOPOTOPO_VERSION}`, 'results are grouped by the TopoTopo version they ran on');
  const site = path.join(tmp, 'site');
  const pages = buildReport(out, site);
  const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8');
  check(pages.map((p) => path.basename(p)).sort().join() === '0.0.1.html,index.html', `one page per version (${pages.map((p) => path.basename(p)).join(', ')})`);
  check(html.includes('Leaderboard') && html.includes(`TopoTopo <b>${TOPOTOPO_VERSION}</b>`) && html.includes('href="0.0.1.html"') && html.includes('id="stone_bridge--reference"') && html.includes('class="open3d"') && !html.includes('class="compare3d"'),
    'the page has the leaderboard, the version and a link to the other, a card per result with its 3D view (no comparison of one)');
  check(/<td>1<\/td><td class="model">reference/.test(html) && html.indexOf('class="model">reference') < html.indexOf('class="model">broken'), 'the leaderboard ranks the reference above the broken model');
  check(fs.existsSync(path.join(site, 'files', TOPOTOPO_VERSION, 'reference', 'stone_bridge', 'model.glb')), 'the page carries the GLBs it links');

  // the providers against local stand-ins of their APIs: request shapes, streaming, tool results with images, usage
  const http = await import('node:http');
  const bodies: { path: string; body: any }[] = [];
  const crateBox = { nodes: { b: { type: 'box', params: { size: 1.2, center: [0, 0.6, 0] } } }, output: 'b' };
  const plan = [
    { name: 'build', input: { graph: crateBox } },
    { name: 'render', input: { views: 'persp' } },
  ];
  const sse = (res: any, events: any[]) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    res.end();
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const body = JSON.parse(raw);
      bodies.push({ path: req.url!, body });
      const turn = body.messages.filter((m: any) => m.role === 'assistant').length;
      const step = plan[turn];
      if (req.url!.endsWith('/v1/messages')) {
        const block = step ? { type: 'tool_use', id: `toolu_${turn}`, name: step.name, input: {} } : { type: 'text', text: '' };
        const delta = step ? { type: 'input_json_delta', partial_json: JSON.stringify(step.input) } : { type: 'text_delta', text: 'A 1.2 m crate.' };
        sse(res, [
          { type: 'message_start', message: { id: `msg_${turn}`, type: 'message', role: 'assistant', model: 'stand-in', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 } } },
          { type: 'content_block_start', index: 0, content_block: block },
          { type: 'content_block_delta', index: 0, delta },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: step ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } },
          { type: 'message_stop' },
        ]);
      } else {
        const m = step ? { role: 'assistant', content: null, tool_calls: [{ id: `call_${turn}`, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.input) } }] } : { role: 'assistant', content: 'A 1.2 m crate.' };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: m, finish_reason: step ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;
  process.env.BENCH_TEST_KEY = 'test-key';
  try {
    const viaClaude = await runTask(crate, { ...base, model: 'anthropic:claude-opus-5-5', label: 'claude stand-in', baseUrl: `http://127.0.0.1:${port}`, apiKeyEnv: 'BENCH_TEST_KEY' });
    const asks = bodies.filter((b) => b.path.endsWith('/v1/messages')).map((b) => b.body);
    const toolResult = asks[2]?.messages.at(-1).content[0];
    check(viaClaude.ok && viaClaude.metrics.toolCalls === 2 && viaClaude.finalText === 'A 1.2 m crate.' && viaClaude.score === Math.round((100 * 6) / 7),
      `Claude (SDK, streamed): two tool calls, the final text, the crate scored (${viaClaude.score}, ${viaClaude.stop}${viaClaude.error ? ', ' + viaClaude.error : ''})`);
    check(asks.length === 3 && asks[0].model === 'claude-opus-5-5' && asks[0].cache_control?.type === 'ephemeral' && asks[0].system.includes('WORKFLOW') && asks[0].tools.some((t: any) => t.name === 'build' && t.input_schema)
      && !('fallbacks' in asks[0]) && !('output_config' in asks[0]),
      'Claude requests: the model, the cached prefix, the system prompt with the server\'s instructions, the tools; no fallbacks, effort left to the model');
    check(toolResult?.type === 'tool_result' && toolResult.tool_use_id === 'toolu_1' && toolResult.content.some((c: any) => c.type === 'image' && c.source?.media_type === 'image/png' && c.source.data.length > 1000),
      'Claude gets the render tool\'s picture inside its tool_result');
    check(viaClaude.metrics.usage.input === 300 && viaClaude.metrics.usage.output === 60 && viaClaude.metrics.usage.cacheRead === 150 && viaClaude.metrics.costUSD > 0,
      `Claude usage is summed over the turns, with a cost from its list price (${JSON.stringify(viaClaude.metrics.usage)}, $${viaClaude.metrics.costUSD?.toFixed(4)})`);
    bodies.length = 0;
    const viaCompat = await runTask(crate, { ...base, model: 'compat:stand-in-model', label: 'compat stand-in', baseUrl: `http://127.0.0.1:${port}/v1`, apiKeyEnv: 'BENCH_TEST_KEY', effort: 'high' });
    const chats = bodies.map((b) => b.body);
    const last = chats[2]?.messages ?? [];
    check(viaCompat.ok && viaCompat.metrics.toolCalls === 2 && viaCompat.score === viaClaude.score && viaCompat.metrics.costUSD === null,
      `OpenAI-compatible: the same run, the same score, no price known (${viaCompat.score}${viaCompat.error ? ', ' + viaCompat.error : ''})`);
    check(chats[0]?.messages[0].role === 'system' && chats[0].tools[0].type === 'function' && chats[0].reasoning_effort === 'high'
      && last.some((m: any) => m.role === 'tool' && m.tool_call_id === 'call_1') && last.at(-1).role === 'user' && last.at(-1).content.some((c: any) => c.type === 'image_url' && c.image_url.url.startsWith('data:image/png;base64,')),
      'OpenAI-compatible requests: system message, function tools, the effort, tool messages and the picture in a user turn after them');
  } finally {
    server.close();
    delete process.env.BENCH_TEST_KEY;
  }

  // small pieces
  check(checkLabel({ kind: 'triangles', min: 100, max: 6000 }) === '100–6,000 triangles' && checkLabel({ kind: 'extent', axis: 'y', min: 3 }) === 'y extent ≥ 3 m', 'check labels read as words');
  check(scoreOf([{ label: '', kind: 'cooks', pass: true, detail: '', weight: 2 }, { label: '', kind: 'uv', pass: false, detail: '', weight: 1 }]) === 67, 'the score weighs checks');
  check(Math.abs(estimateCost({ input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 0 }, [4, 20])! - 24.4) < 1e-9 && estimateCost({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, undefined) === null,
    'cost: input, output and cache reads at a tenth; none without a price');
  const thrown = (f: () => unknown) => { try { f(); return ''; } catch (e: any) { return e.message; } };
  check(/write provider:model/.test(thrown(() => makeProvider('gpt', { images: true }))) && /unknown provider "nope"/.test(thrown(() => makeProvider('nope:x', { images: true }))),
    'a model spec without a known provider is refused with what to write');
  const prevKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  check(/set OPENAI_API_KEY/.test(thrown(() => makeProvider('openai:some-model', { images: true }))), 'a provider without its key says which variable to set');
  if (prevKey !== undefined) process.env.OPENAI_API_KEY = prevKey;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\nllm bench: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
