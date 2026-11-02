// TopoTopo Bench (bench/llm/) end to end, with no model and no network: scripted tool calls go through the real MCP
// server, the result is cooked, checked, rendered and exported, and the comparison page is built from it.
//   node test/llmbench.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTask, loadTasks, suiteHash } from '../bench/llm/run.ts';
import { buildReport, buildPage, collect } from '../bench/llm/report.ts';
import { comparisonKey, participantKey } from '../bench/llm/identity.ts';
import { fileURLToPath } from 'node:url';
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
  const refDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bench', 'llm', 'reference');
  check(tasks.every((t) => fs.existsSync(path.join(refDir, `${t.id}.json`))), 'every task has a hand-written reference solution');
  check(/^[0-9a-f]{16}$/.test(suiteHash()) && suiteHash() === suiteHash(), `the suite has a stable hash (${suiteHash()})`);
  const suiteA = path.join(tmp, 'suite-a'), suiteB = path.join(tmp, 'suite-b');
  for (const d of [suiteA, suiteB]) fs.mkdirSync(path.join(d, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(suiteA, 'task.json'), '{\n "id": "x", "checks": [{"min": 1, "kind": "pieces"}]\n}\n');
  fs.writeFileSync(path.join(suiteB, 'task.json'), '{\r\n "checks": [{"kind": "pieces", "min": 1}], "id": "x"\r\n}\r\n');
  for (const d of [suiteA, suiteB]) fs.writeFileSync(path.join(d, 'nested', 'input.bin'), new Uint8Array([13, 10, 0, 255]));
  check(suiteHash(suiteA) === suiteHash(suiteB), 'nested suite paths and equivalent JSON hash equally with LF, CRLF and different key order');
  fs.writeFileSync(path.join(suiteB, 'nested', 'input.bin'), new Uint8Array([10, 0, 255]));
  check(suiteHash(suiteA) !== suiteHash(suiteB), 'binary input changes remain part of the suite identity');

  // a reference solution through the whole pipeline
  const base = { out, toolCalls: 10, minutes: 5, images: true, log: quiet };
  const bridge = tasks.find((t) => t.id === 'stone_bridge')!;
  const ref = await runTask(bridge, { ...base, model: `script:${refDir}`, label: 'reference' });
  const dir = ref.dir;
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
  check([...collect(out).values()].map((rs) => rs[0].topotopo.version).sort().join() === `0.0.1,${TOPOTOPO_VERSION},${TOPOTOPO_VERSION}`, 'different versions and call budgets are separate comparison groups');
  const site = path.join(tmp, 'site');
  const pages = buildReport(out, site);
  const html = fs.readFileSync(path.join(site, `${ref.comparison}.html`), 'utf8');
  check(pages.length === 3 && fs.existsSync(path.join(site, 'index.html')), `one page per comparison, plus the newest at index.html (${pages.length} comparisons)`);
  check(html.includes('Leaderboard') && html.includes(`TopoTopo <b>${TOPOTOPO_VERSION}</b>`) && html.includes(`href="${comparisonKey(r)}.html"`) && html.includes('id="stone_bridge--reference"') && html.includes('class="open3d"') && !html.includes('class="compare3d"'),
    'the page has the leaderboard, links to other comparisons, cards and a 3D view (one usable result per task)');
  check(/<td>1<\/td><td class="model">reference/.test(html) && html.indexOf('class="model">reference') < html.indexOf('class="model">broken'), 'the leaderboard ranks the reference above the broken model');
  check(fs.existsSync(path.join(site, 'files', ref.comparison, participantKey(ref), 'stone_bridge', 'model.glb')), 'the page carries the GLBs it links without label collisions');
  const variants = [
    { ...ref, topotopo: { ...ref.topotopo, commit: 'different-commit' } },
    { ...ref, suite: 'different-suite' },
    { ...ref, settings: { ...ref.settings, effort: 'high' } },
    { ...ref, settings: { ...ref.settings, images: false } },
    { ...ref, settings: { ...ref.settings, limits: { ...ref.settings.limits, minutes: 1 } } },
  ];
  check(variants.every((v) => comparisonKey(v) !== comparisonKey(ref)), 'commit, suite, effort, images and time budget each separate comparisons');
  let mixed = false;
  try { buildPage([ref, variants[0]], TOPOTOPO_VERSION, []); } catch { mixed = true; }
  check(mixed, 'the page builder itself refuses mixed comparison identities');
  const sameLabel = { ...ref, provider: 'other', model: 'other-model', dir: path.join(out, 'collision'), date: new Date(Date.now() + 1000).toISOString() };
  fs.mkdirSync(sameLabel.dir, { recursive: true });
  fs.writeFileSync(path.join(sameLabel.dir, 'result.json'), JSON.stringify(sameLabel));
  const collided = collect(out).get(ref.comparison)!;
  check(collided.filter((v) => v.label === 'reference').length === 2 && buildPage(collided, TOPOTOPO_VERSION, []).includes('other:other-model'), 'identical display labels cannot combine different providers or models');
  const repeatDir = path.join(out, 'repeat');
  fs.mkdirSync(repeatDir);
  fs.writeFileSync(path.join(repeatDir, 'result.json'), JSON.stringify({ ...ref, date: new Date(Date.now() + 2000).toISOString(), score: 0 }));
  check(collect(out).get(ref.comparison)!.find((v) => participantKey(v) === participantKey(ref))?.score === 0 && fs.existsSync(path.join(dir, 'result.json')), 'a newer failed attempt is displayed without erasing the previous result');

  // the providers against local stand-ins of their APIs: request shapes, streaming, tool results with images, usage
  const http = await import('node:http');
  const bodies: { path: string; body: any }[] = [];
  let slow: '' | 'hang' | 'retry' | 'truncated' = '';
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
      if (slow === 'hang') {
        // An active SSE response for Claude; an unresponsive HTTP request for compatible providers.
        if (req.url!.endsWith('/v1/messages')) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': waiting\n\n'); }
        return;
      }
      if (slow === 'retry') { res.writeHead(429); res.end('rate limited'); return; }
      if (slow === 'truncated') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'cut', function: { name: 'build', arguments: '{' } }] }, finish_reason: 'length' }], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } } }));
        return;
      }
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
    for (const kind of ['anthropic', 'compat']) {
      const provider = makeProvider(`${kind}:stand-in`, { images: true, baseUrl: `http://127.0.0.1:${port}${kind === 'compat' ? '/v1' : ''}`, apiKeyEnv: 'BENCH_TEST_KEY' });
      for (const mode of ['hang', 'retry'] as const) {
        slow = mode;
        const started = performance.now(), count = bodies.length;
        let aborted = false;
        try { await provider.start('test', 'system', 'prompt', []).next(AbortSignal.timeout(150)); } catch { aborted = true; }
        check(aborted && bodies.length === count + 1 && performance.now() - started < 1500, `${kind}: the deadline aborts ${mode === 'hang' ? 'an in-flight response' : 'the retry wait'} instead of waiting past the budget`);
      }
    }
    slow = 'hang';
    const timed = await runTask(crate, { ...base, minutes: 0.15, model: 'compat:stand-in', baseUrl: `http://127.0.0.1:${port}/v1`, label: 'timed', apiKeyEnv: 'BENCH_TEST_KEY' });
    check(timed.stop === 'time_limit' && timed.metrics.wallMs < 12_000 && !timed.metrics.usageComplete && timed.metrics.costUSD === null && timed.graph === null,
      `a stalled model stops the task, records unknown token cost and keeps a failure report (${timed.stop}, ${timed.metrics.wallMs} ms)`);
    slow = 'truncated';
    const cut = await makeProvider('compat:stand-in', { images: true, baseUrl: `http://127.0.0.1:${port}/v1` }).start('test', 'system', 'prompt', []).next();
    check(cut.stop === 'max_tokens' && !cut.calls.length && cut.usage.input === 60 && cut.usage.cacheRead === 40, 'truncated tool calls are never executed and cached prompt tokens are counted once');
    slow = '';
  } finally {
    server.closeAllConnections();
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
