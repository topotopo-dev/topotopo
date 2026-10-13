#!/usr/bin/env node
// TopoTopo MCP server (stdio). Exposes the geometry engine as tools for LLM agents.
//   node src/mcp/server.ts [--workspace <dir>] [--viewer]
//   topotopo mcp [--workspace <dir>] [--viewer]   (installed package: src/cli.ts dispatches here)
// Env: TOPOTOPO_WORKSPACE, TOPOTOPO_VIEWER=1, TOPOTOPO_PORT, TOPOTOPO_SCRIPT_TIMEOUT_MS, TOPOTOPO_SIM_TIMEOUT_MS, TOPOTOPO_WORKERS
// stdout carries the MCP protocol — log only to stderr.
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import '../nodes/index.ts';
import { Engine } from '../graph/engine.ts';
import { createNodeHost } from '../host/node.ts';
import { Workspace } from '../workspace.ts';
import { makeTools } from './tools.ts';
import { INSTRUCTIONS } from './docs.ts';
import { startViewer } from '../viewer/server.ts';

const argv = process.argv.slice(2);
const argOf = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const wsDir = path.resolve(argOf('--workspace') ?? process.env.TOPOTOPO_WORKSPACE ?? path.join(process.cwd(), 'workspace'));

const log = (...a: any[]) => process.stderr.write('[topotopo] ' + a.join(' ') + '\n');

const engine = new Engine(createNodeHost({ baseDir: wsDir }));
if (process.env.TOPOTOPO_SCRIPT_TIMEOUT_MS) engine.scriptTimeoutMs = Number(process.env.TOPOTOPO_SCRIPT_TIMEOUT_MS);
if (process.env.TOPOTOPO_SIM_TIMEOUT_MS) engine.simTimeoutMs = Number(process.env.TOPOTOPO_SIM_TIMEOUT_MS);
await engine.init();
const ws = new Workspace(wsDir, engine);
const loaded = ws.load();
log(`workspace ${wsDir}: ${loaded.graphs} graphs, ${loaded.assets} assets, ${loaded.shelf} shelf assets`);
for (const e of loaded.assetErrors) log('asset error:', e);

let viewer: { url: string; close: () => void } | null = null;
const ensureViewer = async () => {
  if (!viewer) { viewer = await startViewer(ws); log('preview at', viewer.url); }
  return viewer.url;
};
if (argv.includes('--viewer') || process.env.TOPOTOPO_VIEWER === '1') await ensureViewer();

const tools = makeTools(ws, { onPreview: ensureViewer });

const server = new Server(
  { name: 'topotopo', version: '0.1.0' },
  { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const t = tools.find((x) => x.name === req.params.name);
  if (!t) return { content: [{ type: 'text', text: `unknown tool "${req.params.name}". Tools: ${tools.map((x) => x.name).join(', ')}` }], isError: true };
  try {
    return (await t.run(req.params.arguments ?? {})) as any;
  } catch (e: any) {
    return { content: [{ type: 'text', text: `error: ${e?.message ?? e}` }], isError: true };
  }
});

// the client closing the pipe (or a signal) ends the session: stop the worker threads and the viewer, then exit
let closing = false;
const shutdown = async (why: string) => {
  if (closing) return;
  closing = true;
  log(`shutting down (${why})`);
  try { viewer?.close(); await engine.host.pool?.close(); } finally { process.exit(0); }
};
process.stdin.on('end', () => void shutdown('stdin closed'));
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void shutdown(sig));

await server.connect(new StdioServerTransport());
log('ready (stdio)');
