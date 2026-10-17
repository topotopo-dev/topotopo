// Live preview web server: serves a three.js viewer that shows any graph/node of the
// workspace and refreshes over Server-Sent Events whenever a graph is rebuilt/edited.
// It is also the human's control surface: files dropped on the page are stored in the workspace's inputs/ and shown
// as reference layers, and the graph's exposed vars are set from generated controls (POST /api/vars).
// Bound to 127.0.0.1 only; requests must name this server as their Host, and writes must come from its own page.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import type { Workspace } from '../workspace.ts';
import type { Geometry } from '../core/geometry.ts';
import type { GraphSpec } from '../graph/types.ts';
import { exportGeometryAsync } from '../io/export.ts';
import { summarize } from '../inspect.ts';
import { withHeightfieldPreview } from '../core/heightfield.ts';
import { wiringOf } from '../graph/engine.ts';

// index.html sits next to this module (the build copies it to dist/viewer/)
const here = path.dirname(fileURLToPath(import.meta.url));
// three.js where Node resolves it: this checkout's node_modules, or the hoisted copy next to an installed package
const threeDir = (() => {
  try { return path.resolve(path.dirname(fileURLToPath(import.meta.resolve('three'))), '..'); }
  catch { return path.resolve(here, '..', '..', 'node_modules', 'three'); }
})();

const MIME: Record<string, string> = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary' };
/** largest file POST /api/inputs accepts */
export const MAX_UPLOAD = 512 * 1024 * 1024;
/** uploads in progress are written next to their target as `.<name>.<n>.part`, then renamed */
const PART_RE = /(^|\/)\.[^/]*\.part$/;

class HttpError extends Error {
  status: number;
  constructor(status: number, msg: string) { super(msg); this.status = status; }
}

/** The shape every geometry route serves: the same GLB options as /api/geo. */
const toGLB = (g: Geometry) => exportGeometryAsync(withHeightfieldPreview(g), 'glb', { splitByName: false, lineMode: 'lines', custom: false });
const issueText = (e: { node: string; message: string }) => `[${e.node}] ${e.message}`;

/**
 * A dropped file's name as stored in inputs/: a plain basename with its extension. Path separators and ".." are
 * rejected; characters Windows cannot store become "_".
 */
export function inputFileName(raw: string): string {
  const s = raw.normalize('NFC').trim();
  if (!s || /[\\/]/.test(s) || s.includes('..') || s.includes('\0')) throw new HttpError(400, `bad file name ${JSON.stringify(raw)}: give a plain file name, without folders or ".."`);
  let n = s.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '');
  if (!n || n.startsWith('.')) throw new HttpError(400, `bad file name ${JSON.stringify(raw)}: it must not start with "."`);
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(n)) n = '_' + n;
  if (n.length > 200) throw new HttpError(400, 'file name longer than 200 characters');
  return n;
}

interface VarsReply { status: number; body: { ok: boolean; ms: number; errors: string[]; vars?: Record<string, any> } }
interface VarsBatch { vars: Record<string, any>; waiters: ((r: VarsReply) => void)[] }

export async function startViewer(ws: Workspace, port = Number(process.env.TOPOTOPO_PORT ?? 7341)): Promise<{ url: string; close: () => void }> {
  const clients = new Set<http.ServerResponse>();
  const broadcast = (ev: object) => {
    const msg = `data: ${JSON.stringify(ev)}\n\n`;
    for (const c of clients) c.write(msg);
  };
  ws.listeners.add(broadcast);

  // ---------------------------------------------------------------- inputs/
  let inputsVersion = 0;
  const inputsChanged = () => broadcast({ inputs: ++inputsVersion });
  const listInputs = () => ws.listInputs().filter((f) => !PART_RE.test(f.path));
  // files copied into inputs/ by other means (file manager, an agent) show up too
  let watcher: fs.FSWatcher | null = null, watchTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    fs.mkdirSync(ws.inputDir, { recursive: true });
    watcher = fs.watch(ws.inputDir, { recursive: true }, (_ev, f) => {
      if (f && PART_RE.test(String(f).split(path.sep).join('/'))) return;
      clearTimeout(watchTimer);
      watchTimer = setTimeout(inputsChanged, 250);
    });
    watcher.on('error', () => { /* the folder went away: uploads through the viewer still notify */ });
    watcher.unref();
  } catch { watcher = null; }

  /** `path` query of /api/input*: a file below inputs/ (posix, relative). */
  const inputPath = (raw: string | null): { rel: string; abs: string } => {
    const rel = (raw ?? '').replace(/\\/g, '/');
    const parts = rel.split('/');
    if (!rel || rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || parts.some((s) => s === '' || s === '.' || s === '..'))
      throw new HttpError(400, `bad input path ${JSON.stringify(raw)}: give a path relative to inputs/ as GET /api/inputs lists it`);
    const root = path.resolve(ws.inputDir);
    const abs = path.resolve(root, ...parts);
    if (!abs.startsWith(root + path.sep)) throw new HttpError(400, `input path ${JSON.stringify(raw)} leaves inputs/`);
    if (!fs.statSync(abs, { throwIfNoEntry: false })?.isFile()) throw new HttpError(404, `no input "${rel}" (GET /api/inputs lists them)`);
    return { rel, abs };
  };
  /** The one-node graph that loads an input. */
  const inputGraph = (rel: string, abs: string): GraphSpec => {
    // "inputs/<rel>" resolves against the host's base directory, which is the workspace under the MCP server;
    // `topotopo view` keeps a scratch workspace away from the graph file's folder, so it gets the absolute path
    const ref = `inputs/${rel}`;
    const p = path.resolve(ws.engine.host.resolvePath(ref)) === abs ? ref : abs;
    return { nodes: { f: { type: 'file', params: { path: p } } }, output: 'f' };
  };

  const upload = async (req: http.IncomingMessage, u: URL): Promise<{ status: number; body: object }> => {
    const name = inputFileName(u.searchParams.get('name') ?? '');
    const overwrite = u.searchParams.get('overwrite') === '1';
    const root = path.resolve(ws.inputDir);
    const dest = path.join(root, name);
    if (path.dirname(dest) !== root) throw new HttpError(400, `bad file name "${name}"`);
    const len = Number(req.headers['content-length']);
    if (len > MAX_UPLOAD) throw new HttpError(413, `${name} is ${(len / 2 ** 20).toFixed(0)} MB; uploads are limited to ${MAX_UPLOAD / 2 ** 20} MB`);
    const exists = () => fs.existsSync(dest);
    const conflict = { status: 409, body: { ok: false, exists: true, path: name, error: `inputs/${name} exists (overwrite=1 replaces it)` } };
    if (!overwrite && exists()) return conflict;
    fs.mkdirSync(root, { recursive: true });
    const part = path.join(root, `.${name}.${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.part`);
    let n = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _enc, cb) { n += chunk.length; cb(n > MAX_UPLOAD ? new HttpError(413, `uploads are limited to ${MAX_UPLOAD / 2 ** 20} MB`) : null, chunk); },
    });
    try {
      await pipeline(req, limit, fs.createWriteStream(part, { flags: 'wx' }));
      if (!overwrite && exists()) { fs.rmSync(part, { force: true }); return conflict; }
      fs.renameSync(part, dest);
    } catch (e) {
      fs.rmSync(part, { force: true });
      throw e;
    }
    inputsChanged();
    return { status: 200, body: { ok: true, path: name, size: n } };
  };

  // ---------------------------------------------------------------- POST /api/vars
  // One edit + cook at a time per graph. Requests that arrive while one runs are merged (the latest value of each
  // var wins) and applied by a single further cook; every request is answered once its values are applied.
  const varQueues = new Map<string, { busy: boolean; next: VarsBatch | null }>();
  const applyBatch = async (name: string, b: VarsBatch): Promise<VarsReply> => {
    const prev = ws.graphs.get(name);
    if (!prev) return { status: 404, body: { ok: false, ms: 0, errors: [`no graph ${name}`] } };
    try {
      const { graph, report } = await ws.edit(name, [{ op: 'vars', vars: b.vars }]);
      return { status: 200, body: { ok: report.ok, ms: report.ms, errors: report.errors.map(issueText), vars: graph.vars ?? {} } };
    } catch (e: any) {
      // rejected edits carry their issues (one string each); op errors are plain messages
      return { status: 400, body: { ok: false, ms: 0, errors: Array.isArray(e?.errors) ? e.errors.map(issueText) : [String(e?.message ?? e)] } };
    }
  };
  const applyVars = (name: string, vars: Record<string, any>) => new Promise<VarsReply>((resolve) => {
    let q = varQueues.get(name);
    if (!q) varQueues.set(name, q = { busy: false, next: null });
    if (q.next) { Object.assign(q.next.vars, vars); q.next.waiters.push(resolve); }
    else q.next = { vars: { ...vars }, waiters: [resolve] };
    if (q.busy) return;
    q.busy = true;
    (async () => {
      try {
        while (q.next) {
          const b = q.next;
          q.next = null;
          const r = await applyBatch(name, b).catch((e: any): VarsReply => ({ status: 500, body: { ok: false, ms: 0, errors: [String(e?.message ?? e)] } }));
          for (const w of b.waiters) w(r);
        }
      } finally { q.busy = false; }
    })();
  });
  const readJSON = (req: http.IncomingMessage, max = 4 << 20) => new Promise<any>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => { n += c.length; if (n <= max) chunks.push(c); });
    req.on('end', () => {
      if (n > max) return reject(new HttpError(413, `request body over ${max >> 20} MB`));
      const s = Buffer.concat(chunks).toString('utf8');
      try { resolve(s.trim() ? JSON.parse(s) : {}); } catch (e: any) { reject(new HttpError(400, `body is not JSON: ${e.message}`)); }
    });
    req.on('error', reject);
  });

  // ---------------------------------------------------------------- routes
  const server = http.createServer(async (req, res) => {
    const send = (code: number, body: string | Uint8Array, type = 'text/plain; charset=utf-8') => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    const json = (code: number, body: unknown) => send(code, JSON.stringify(body), MIME['.json']);
    let route = '';
    try {
      // DNS rebinding: only requests addressed to this server; cross-site writes: only from this server's own page
      const host = String(req.headers.host ?? '');
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return json(403, { error: `unexpected Host "${host}"` });
      const origin = req.headers.origin;
      if (req.method !== 'GET' && req.method !== 'HEAD' && origin !== undefined && origin !== `http://${host}`) return json(403, { error: `cross-origin ${req.method} refused (${origin})` });
      const u = new URL(req.url ?? '/', 'http://localhost');
      route = u.pathname;
      if (u.pathname === '/' || u.pathname === '/index.html') return send(200, fs.readFileSync(path.join(here, 'index.html')), MIME['.html']);
      if (u.pathname.startsWith('/vendor/three/')) {
        const rel = decodeURIComponent(u.pathname.slice('/vendor/three/'.length));
        const p = path.resolve(threeDir, rel);
        if (!p.startsWith(threeDir + path.sep) || !fs.existsSync(p)) return send(404, 'not found');
        return send(200, fs.readFileSync(p), MIME[path.extname(p)] ?? 'application/octet-stream');
      }
      if (u.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(': hello\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (u.pathname === '/api/graphs') {
        const out = [...ws.graphs].map(([name, g]) => {
          const last = ws.lastReport.get(name);
          return {
            name, output: last?.target ?? g.output ?? null, version: ws.versions.get(name) ?? 0,
            vars: g.vars ?? {}, params: g.params ?? {},
            nodes: Object.entries(g.nodes).map(([n, spec]) => {
              const def = ws.engine.resolveDef(spec.type);
              const r = last?.results.get(n);
              return { name: n, type: spec.type, in: def ? wiringOf(spec, def).list : [], error: r?.error?.message ?? null, ms: r?.ms ?? null };
            }),
          };
        });
        return json(200, out);
      }
      if (u.pathname === '/api/vars') {
        if (req.method !== 'POST') return json(405, { ok: false, ms: 0, errors: ['POST {"vars": {...}}'] });
        const name = u.searchParams.get('graph') ?? 'main';
        const body = await readJSON(req);
        const vars = body?.vars ?? {};
        if (!vars || typeof vars !== 'object' || Array.isArray(vars)) throw new HttpError(400, '"vars" must be an object {name: value}');
        if (!ws.graphs.has(name)) return json(404, { ok: false, ms: 0, errors: [`no graph ${name}`] });
        const r = await applyVars(name, vars);
        return json(r.status, r.body);
      }
      if (u.pathname === '/api/inputs') {
        if (req.method === 'POST') { const r = await upload(req, u); return json(r.status, r.body); }
        return json(200, listInputs());
      }
      if (u.pathname === '/api/input' || u.pathname === '/api/input_info') {
        const { rel, abs } = inputPath(u.searchParams.get('path'));
        const r = await ws.engine.cook(inputGraph(rel, abs));
        if (!r.ok || !r.geo) return json(500, { error: r.errors.map(issueText).join('\n') });
        if (u.pathname === '/api/input_info') return json(200, { path: rel, summary: summarize(r.geo), ms: r.ms });
        return send(200, await toGLB(r.geo), MIME['.glb']);
      }
      if (u.pathname === '/api/geo' || u.pathname === '/api/info') {
        const name = u.searchParams.get('graph') ?? 'main';
        const node = u.searchParams.get('node') || undefined;
        const g = ws.graphs.get(name);
        if (!g) return send(404, JSON.stringify({ error: `no graph ${name}` }), MIME['.json']);
        const r = await ws.engine.cook(g, { target: node });
        if (!r.ok || !r.geo) return send(500, JSON.stringify({ error: r.errors.map(issueText).join('\n') }), MIME['.json']);
        if (u.pathname === '/api/info') return send(200, JSON.stringify({ target: r.target, summary: summarize(r.geo), ms: r.ms }), MIME['.json']);
        return send(200, await toGLB(r.geo), MIME['.glb']);
      }
      send(404, 'not found');
    } catch (e: any) {
      if (res.headersSent || res.destroyed) return;
      const status = e instanceof HttpError ? e.status : 500;
      const msg = String(e?.message ?? e);
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...(status === 413 ? { connection: 'close' } : {}) });
      res.end(JSON.stringify(route === '/api/vars' ? { ok: false, ms: 0, errors: [msg] } : { ok: false, error: msg }));
    }
  });

  const listen = (p: number) => new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(p, '127.0.0.1', () => resolve((server.address() as any).port));
  });
  let actual = 0;
  for (let i = 0; i < 20; i++) {
    try { actual = await listen(port + i); break; } catch (e: any) { if (e.code !== 'EADDRINUSE') throw e; }
  }
  if (!actual) actual = await listen(0);
  const keepAlive = setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 20000);
  keepAlive.unref();
  return {
    url: `http://127.0.0.1:${actual}/`,
    close: () => {
      clearInterval(keepAlive);
      clearTimeout(watchTimer);
      watcher?.close();
      ws.listeners.delete(broadcast);
      for (const c of clients) c.end();
      server.close();
    },
  };
}
