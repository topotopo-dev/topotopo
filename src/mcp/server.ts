#!/usr/bin/env node
// TopoTopo MCP server (stdio). Exposes the geometry engine as tools for LLM agents.
//   node src/mcp/server.ts [--project <dir>] [--viewer]
//   topotopo mcp [--project <dir>] [--viewer]   (installed package: src/cli.ts dispatches here)
// Env: TOPOTOPO_PROJECT, TOPOTOPO_VIEWER=1, TOPOTOPO_PORT, TOPOTOPO_SCRIPT_TIMEOUT_MS, TOPOTOPO_SIM_TIMEOUT_MS, TOPOTOPO_WORKERS
// stdout carries the MCP protocol — log only to stderr.
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import '../nodes/index.ts';
import { Engine } from '../graph/engine.ts';
import { createNodeHost } from '../host/node.ts';
import { TOPOTOPO_VERSION } from '../host/version.ts';
import { Session } from '../session.ts';
import { makeTools } from './tools.ts';
import type { ToolDef } from './tools.ts';
import { libraryTool } from './library.ts';
import { INSTRUCTIONS } from './docs.ts';
import { startViewer } from '../viewer/server.ts';
import type { Viewer } from '../viewer/server.ts';
import { startProject, setProgram } from '../gallery/library.ts';
import { openPackages } from '../gallery/packages.ts';
import type { ProjectPackages } from '../gallery/packages.ts';

const argv = process.argv.slice(2);
const argOf = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const named = argOf('--project') ?? process.env.TOPOTOPO_PROJECT;

const log = (...a: any[]) => process.stderr.write('[topotopo] ' + a.join(' ') + '\n');

// hints name the command a person runs: the sources from a clone, or the installed package's
setProgram(import.meta.url.endsWith('.ts') ? 'node src/cli.ts' : 'topotopo');

// The folder, named (--project, TOPOTOPO_PROJECT) or not (<cwd>/topotopo, which takes the name of the folder it
// is in), becomes a project when the server starts if it is in no project and holds nothing but what TopoTopo makes
// itself (graphs/, assets/, exports/, inputs/), or nothing at all, as a new one does: then its graphs use packages,
// TopoTopo's own among them, as they come. A folder in a project works in that project's folder. A folder with
// anything else in it (a repository, a folder of the person's) stays as it is: library {action:"init"} makes it a
// project when the person says so (startProject, src/gallery/library.ts). The first tool reply says what happened.
const start = startProject(path.resolve(named ?? path.join(process.cwd(), 'topotopo')), named ? {} : { name: path.basename(process.cwd()) });
log(start.log);
const wsDir = start.dir;
let firstNote = start.note;

// The folder can change while the server runs (library {action:"open"} opens a gallery project): every tool and
// the live viewer then work on the new folder. Each session has its own engine (asset registry, base directory,
// packages, cache); the worker pool is shared by the process. Sessions follow what other processes write into their folders
// (Session.watch: the gallery's editor, a person editing JSON). The packages a session follows (library
// {action:"follow"}) resolve to their working folders as they are at each cook; the live viewer cooks its graphs again
// when one of those folders changes.
let engine: Engine, ws: Session, packages: ProjectPackages, tools: ToolDef[];
let viewer: Viewer | null = null;
const ensureViewer = async () => {
  if (!viewer) { viewer = await startViewer(ws); log('preview at', viewer.url); }
  return viewer.url;
};
const library = libraryTool({ session: () => ws, packages: () => packages, open: (dir) => openSession(dir) });
async function openSession(dir: string) {
  const e = new Engine(createNodeHost({ baseDir: dir }));
  if (process.env.TOPOTOPO_SCRIPT_TIMEOUT_MS) e.scriptTimeoutMs = Number(process.env.TOPOTOPO_SCRIPT_TIMEOUT_MS);
  if (process.env.TOPOTOPO_SIM_TIMEOUT_MS) e.simTimeoutMs = Number(process.env.TOPOTOPO_SIM_TIMEOUT_MS);
  await e.init();
  // the project the folder belongs to: its packages resolve before its assets register (they may use them)
  const pk = openPackages(e, dir);
  const w = new Session(dir, e);
  w.packages = pk;
  const loaded = w.load();
  w.watch();
  log(`session ${dir}: ${loaded.graphs} graphs, ${loaded.assets} assets${pk.dir ? `; project ${pk.dir}, ${Object.keys(pk.manifest?.uses ?? {}).length} packages used` : '; in no project'}`);
  for (const x of loaded.assetErrors) log('asset error:', x);
  for (const x of pk.check()) log('package problem:', x);
  const prev = ws as Session | undefined;
  engine = e;
  ws = w;
  packages = pk;
  tools = [...makeTools(w, { onPreview: ensureViewer }), library];
  viewer?.setSession(w);
  prev?.unwatch();
  return loaded;
}
await openSession(wsDir);
if (argv.includes('--viewer') || process.env.TOPOTOPO_VIEWER === '1') await ensureViewer();

const server = new Server(
  { name: 'topotopo', version: TOPOTOPO_VERSION },
  { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  const t = tools.find((x) => x.name === req.params.name);
  if (!t) return { content: [{ type: 'text', text: `unknown tool "${req.params.name}". Tools: ${tools.map((x) => x.name).join(', ')}` }], isError: true };
  // a long call (library update) stops when the client cancels it, and says how far it is when the client asks to
  const token = req.params._meta?.progressToken;
  const progress = token === undefined ? undefined : (done: number, total: number, message: string) => {
    extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: done, total, message } }).catch(() => {});
  };
  // the first reply says where the server works when that is news: a folder that became a project, one left as it is,
  // the project a folder lies in
  const note = firstNote;
  firstNote = null;
  let r: any;
  try { r = await t.run(req.params.arguments ?? {}, { signal: extra.signal, progress }); }
  catch (e: any) { r = { content: [{ type: 'text', text: `error: ${e?.message ?? e}` }], isError: true }; }
  if (note) r.content = [...(r.content ?? []), { type: 'text', text: note }];
  return r;
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
