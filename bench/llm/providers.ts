// TopoTopo Bench: the models under test, behind one small interface. A conversation is the agent loop's view of a
// model: it is started with the system prompt, the task and the tools, asked for its next turn, and given the tool
// results. Providers:
//   anthropic:<model>   Claude through the official SDK (ANTHROPIC_API_KEY or another credential the SDK finds)
//   openai:<model>, openrouter:<model>, google:<model>, deepseek:<model>, xai:<model>, ollama:<model>,
//   compat:<model>      any OpenAI-compatible chat-completions endpoint (--base-url, --api-key-env)
//   script:<file>       a fixed list of tool calls, no model (tests, and the hand-written reference solutions)
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import Anthropic from '@anthropic-ai/sdk';

export interface ToolSpec { name: string; description: string; schema: Record<string, any> }
export interface ToolCall { id: string; name: string; input: any }
export interface ToolOutput { id: string; text: string; images: { data: string; mimeType: string }[]; isError: boolean }
export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number }
export interface Turn {
  text: string;
  calls: ToolCall[];
  /** why the model stopped: 'tool_use' (calls to run), 'end' (done), 'refusal', 'max_tokens', or the provider's word */
  stop: string;
  usage: Usage;
}
export interface Conversation {
  next(signal?: AbortSignal): Promise<Turn>;
  addResults(results: ToolOutput[]): void;
}
export interface Settings {
  /** reasoning effort where the provider has one (Claude: output_config.effort; OpenAI-compatible: reasoning_effort) */
  effort?: string;
  /** send tool images to the model (default true; off for text-only models) */
  images: boolean;
  baseUrl?: string;
  apiKeyEnv?: string;
  /** script: the folder of per-task scripts, <dir>/<task id>.json */
  scriptDir?: string;
}
export interface Provider {
  /** "anthropic", "openai", …: the part before the colon */
  kind: string;
  model: string;
  start(task: string, system: string, prompt: string, tools: ToolSpec[]): Conversation;
}

const zero = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

// ------------------------------------------------------------------ Claude (official SDK)
function anthropicProvider(model: string, s: Settings): Provider {
  const client = new Anthropic({ ...(s.apiKeyEnv ? { apiKey: process.env[s.apiKeyEnv] } : {}), ...(s.baseUrl ? { baseURL: s.baseUrl } : {}) });
  return {
    kind: 'anthropic', model,
    start(_task, system, prompt, specs) {
      const tools: Anthropic.Tool[] = specs.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema as Anthropic.Tool.InputSchema }));
      // the history is only ever appended to (thinking blocks stay valid), and the whole prefix is cached
      const messages: Anthropic.MessageParam[] = [{ role: 'user', content: prompt }];
      return {
        async next(signal) {
          signal?.throwIfAborted();
          // No refusal fallbacks on purpose: a fallback would answer with another model, and the bench measures this
          // one. A refusal is recorded as the model's result. Thinking and effort stay at the model's defaults unless
          // --effort is given, and the run records which.
          const stream = client.messages.stream({
            model, max_tokens: 64000, system, tools, messages,
            cache_control: { type: 'ephemeral' },
            ...(s.effort ? { output_config: { effort: s.effort as any } } : {}),
          }, { signal });
          const msg = await stream.finalMessage();
          messages.push({ role: 'assistant', content: msg.content });
          const calls = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input }));
          const text = msg.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n');
          const u = msg.usage;
          // a tool call cut off by max_tokens is not run: its input may be incomplete
          const stop = msg.stop_reason === 'tool_use' ? 'tool_use' : msg.stop_reason === 'end_turn' ? 'end' : String(msg.stop_reason);
          return { text, calls: stop === 'tool_use' ? calls : [], stop, usage: { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 } };
        },
        addResults(results) {
          messages.push({
            role: 'user',
            content: results.map((r): Anthropic.ToolResultBlockParam => ({
              type: 'tool_result', tool_use_id: r.id, is_error: r.isError,
              content: [
                { type: 'text', text: r.text || '(no text)' },
                ...(s.images ? r.images.map((im) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: im.mimeType as 'image/png', data: im.data } })) : []),
              ],
            })),
          });
        },
      };
    },
  };
}

// ------------------------------------------------------------------ OpenAI-compatible chat completions
const COMPAT: Record<string, { base: string; key: string | null }> = {
  openai: { base: 'https://api.openai.com/v1', key: 'OPENAI_API_KEY' },
  openrouter: { base: 'https://openrouter.ai/api/v1', key: 'OPENROUTER_API_KEY' },
  google: { base: 'https://generativelanguage.googleapis.com/v1beta/openai', key: 'GEMINI_API_KEY' },
  deepseek: { base: 'https://api.deepseek.com/v1', key: 'DEEPSEEK_API_KEY' },
  xai: { base: 'https://api.x.ai/v1', key: 'XAI_API_KEY' },
  ollama: { base: 'http://localhost:11434/v1', key: null },
  compat: { base: '', key: null },
};

async function postJSON(url: string, body: unknown, headers: Record<string, string>, signal?: AbortSignal): Promise<any> {
  // retried on rate limits and server errors, with backoff (2, 4, 8, 16, 32 s)
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
    if (r.ok) return r.json();
    const text = await r.text();
    if ((r.status === 429 || r.status >= 500) && attempt < 5) { await delay(2000 * 2 ** attempt, undefined, { signal }); continue; }
    throw new Error(`${url}: HTTP ${r.status} ${text.slice(0, 500)}`);
  }
}

function compatProvider(kind: string, model: string, s: Settings): Provider {
  const preset = COMPAT[kind];
  const base = (s.baseUrl ?? preset.base).replace(/\/$/, '');
  if (!base) throw new Error(`${kind}: give --base-url`);
  const keyEnv = s.apiKeyEnv ?? preset.key;
  const key = keyEnv ? process.env[keyEnv] : undefined;
  if (keyEnv && !key) throw new Error(`${kind}: set ${keyEnv} (or name another variable with --api-key-env)`);
  return {
    kind, model,
    start(_task, system, prompt, specs) {
      const tools = specs.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } }));
      const messages: any[] = [{ role: 'system', content: system }, { role: 'user', content: prompt }];
      return {
        async next(signal) {
          const j = await postJSON(`${base}/chat/completions`, { model, messages, tools, tool_choice: 'auto', ...(s.effort ? { reasoning_effort: s.effort } : {}) }, key ? { authorization: `Bearer ${key}` } : {}, signal);
          const choice = j.choices?.[0], m = choice?.message ?? {};
          messages.push({ role: 'assistant', content: m.content ?? null, ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}) });
          const calls: ToolCall[] = (m.tool_calls ?? []).map((c: any) => {
            let input: any;
            try { input = JSON.parse(c.function?.arguments || '{}'); } catch { input = { __unparsed: c.function?.arguments }; }
            return { id: c.id, name: c.function?.name, input };
          });
          const u = j.usage ?? {};
          const stop = choice?.finish_reason === 'length' ? 'max_tokens' : calls.length ? 'tool_use' : choice?.finish_reason === 'stop' ? 'end' : String(choice?.finish_reason ?? 'end');
          const cacheRead = u.prompt_tokens_details?.cached_tokens ?? 0;
          return { text: typeof m.content === 'string' ? m.content : '', calls: stop === 'tool_use' ? calls : [], stop, usage: { input: Math.max(0, (u.prompt_tokens ?? 0) - cacheRead), output: u.completion_tokens ?? 0, cacheRead, cacheWrite: 0 } };
        },
        addResults(results) {
          for (const r of results) messages.push({ role: 'tool', tool_call_id: r.id, content: (r.isError ? 'ERROR: ' : '') + (r.text || '(no text)') });
          // chat completions takes images in user turns only: they follow the tool results they belong to
          const imgs = s.images ? results.flatMap((r) => r.images) : [];
          if (imgs.length) messages.push({ role: 'user', content: [{ type: 'text', text: 'The images the tool calls above returned:' }, ...imgs.map((im) => ({ type: 'image_url', image_url: { url: `data:${im.mimeType};base64,${im.data}` } }))] });
        },
      };
    },
  };
}

// ------------------------------------------------------------------ scripted (no model)
/** A script: {"turns": [{"text"?: string, "calls"?: [{"name", "input"}]}]}; after the last turn it is done. */
function scriptProvider(dir: string): Provider {
  return {
    kind: 'script', model: dir,
    start(task) {
      const file = `${dir}/${task}.json`;
      const turns: { text?: string; calls?: { name: string; input: any }[] }[] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).turns : [];
      let i = 0;
      return {
        async next(signal) {
          signal?.throwIfAborted();
          const t = turns[i++];
          if (!t) return { text: fs.existsSync(file) ? 'done' : `no script for ${task}`, calls: [], stop: 'end', usage: zero() };
          const calls = (t.calls ?? []).map((c, k) => ({ id: `call_${i}_${k}`, name: c.name, input: c.input }));
          return { text: t.text ?? '', calls, stop: calls.length ? 'tool_use' : 'end', usage: zero() };
        },
        addResults() { /* a script does not read them */ },
      };
    },
  };
}

/** "anthropic:claude-opus-5-5", "openrouter:vendor/model", "script:bench/llm/reference", … */
export function makeProvider(spec: string, s: Settings): Provider {
  const i = spec.indexOf(':');
  if (i < 0) throw new Error(`--model ${spec}: write provider:model, e.g. anthropic:claude-opus-5-5 or openai:<model>`);
  const kind = spec.slice(0, i), model = spec.slice(i + 1);
  if (kind === 'anthropic') return anthropicProvider(model, s);
  if (kind === 'script') return scriptProvider(model);
  if (kind in COMPAT) return compatProvider(kind, model, s);
  throw new Error(`--model ${spec}: unknown provider "${kind}" (anthropic, ${Object.keys(COMPAT).join(', ')}, script)`);
}

/** List prices in USD per million tokens [input, output] (Claude: the published rates as of 2026-10; others by --price). */
export const PRICES: Record<string, [number, number]> = {
  'claude-fable-5-1': [10, 50], 'claude-fable-5': [10, 50],
  'claude-opus-5-5': [4, 20], 'claude-opus-5': [5, 25], 'claude-opus-4-8': [5, 25], 'claude-opus-4-7': [5, 25], 'claude-opus-4-6': [5, 25],
  'claude-sonnet-5-5': [2, 10], 'claude-sonnet-5': [2, 10], 'claude-sonnet-4-6': [3, 15],
  'claude-haiku-5-5': [0.1, 0.5], 'claude-haiku-4-5': [1, 5],
};

/** An estimate: cache writes at 1.25× and cache reads at 0.1× the input price. */
export function estimateCost(u: Usage, price: [number, number] | undefined): number | null {
  if (!price) return null;
  return ((u.input + 1.25 * u.cacheWrite + 0.1 * u.cacheRead) * price[0] + u.output * price[1]) / 1e6;
}
