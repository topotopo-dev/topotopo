// Live preview web server: serves the viewer page (index.html, a shell loading the ES modules of app/ and three.js
// from /vendor/three/; docs/design/viewer.md) that shows any graph/node of the workspace and refreshes over
// Server-Sent Events whenever a graph is rebuilt/edited.
// It is also the human's control surface: files dropped on the page are stored in the workspace's inputs/ (under
// `topotopo view`, the inputs/ beside the graph file) and shown as reference layers, the graph's exposed vars are set
// from generated controls (POST /api/vars), and markers clicked into the view (sites, paths, zones, volumes) become
// inputs/markers.json (POST /api/markers).
// Bound to 127.0.0.1 only; requests must name this server as their Host, and writes must come from its own page.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import type { Workspace } from '../workspace.ts';
import { GeoBuilder } from '../core/geometry.ts';
import type { Geometry } from '../core/geometry.ts';
import type { GraphSpec } from '../graph/types.ts';
import { exportGeometry, exportGeometryAsync } from '../io/export.ts';
import { summarize } from '../inspect.ts';
import { withHeightfieldPreview } from '../core/heightfield.ts';
import { withImagePreview } from '../render/texview.ts';
import { wiringOf } from '../graph/engine.ts';
import { createOutputs } from './outputs.ts';
// the page's guide rules, shared so the page and this server check a marker list the same way
import { MARKER_KINDS as KINDS, MarkerError, parseMarkers as parseMarkerList } from './app/markers.js';

// index.html and app/ sit next to this module (the build copies them to dist/viewer/)
const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, 'app');
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

/** The shape every geometry route serves: the same GLB options as /api/geo; images alone show as textured quads. */
const toGLB = (g: Geometry) => exportGeometryAsync(withImagePreview(withHeightfieldPreview(g)), 'glb', { splitByName: false, lineMode: 'lines', custom: false });
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

// ---------------------------------------------------------------- markers
// What a person clicks into the view to direct the agent: "village here" (site), "road along here" (path), "keep this
// area empty" (zone, volume). The page sends the editable list; the server stores it and writes the geometry agents
// read as inputs/markers.json, in the conventions of help topic "inputs" (string attributes name and role).

export const MARKER_KINDS = KINDS as readonly ['site', 'path', 'zone', 'volume'];
export type MarkerKind = (typeof MARKER_KINDS)[number];
/** One marker, in metres, Y-up, world space. */
export interface Marker {
  id: string;
  kind: MarkerKind;
  name: string;
  /** site: its point; path: an open polyline; zone: a closed one; volume: two ground corners of an axis-aligned box */
  points: [number, number, number][];
  /** site: radius (pscale), default 5 */
  radius?: number;
  /** volume: extent upward from the lower corner's y, default 10 */
  height?: number;
}
/**
 * A marker list (the POST /api/markers body, or the stored list) checked and normalised by the page's own rules
 * (app/markers.js): names trimmed and unique (ignoring case), the defaults filled in, ids given to markers without
 * one. Throws HttpError 400 naming the problem.
 */
export function parseMarkers(body: unknown): Marker[] {
  try { return parseMarkerList(body); } catch (e: any) { throw e instanceof MarkerError ? new HttpError(400, e.message) : e; }
}

/**
 * The geometry of inputs/markers.json. Sites are points with name, role "site", pscale = radius and orient (identity);
 * paths are open polylines, zones closed ones facing up, volumes closed boxes of 6 quads facing out; those carry prim
 * name and role.
 */
export function markersGeometry(list: Marker[]): Geometry {
  const b = new GeoBuilder();
  for (const m of list) {
    if (m.kind === 'site') {
      const [x, y, z] = m.points[0];
      const p = b.addPoint(x, y, z);
      b.attrib('point', 'name', 1, 'string').set(p, m.name);
      b.attrib('point', 'role', 1, 'string').set(p, 'site');
      b.attrib('point', 'pscale').set(p, m.radius ?? 5);
      b.attrib('point', 'orient', 4).set(p, [0, 0, 0, 1]);
      continue;
    }
    const prims: number[] = [];
    if (m.kind === 'volume') {
      const [a, c] = m.points;
      const lo = [Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.min(a[2], c[2])];
      const hi = [Math.max(a[0], c[0]), lo[1] + (m.height ?? 10), Math.max(a[2], c[2])];
      // corner (i, j, k) is point base + 4i + 2j + k, at the low (0) or high (1) side of x, y, z
      const base = b.numPoints;
      for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) for (let k = 0; k < 2; k++) b.addPoint(i ? hi[0] : lo[0], j ? hi[1] : lo[1], k ? hi[2] : lo[2]);
      // the box node's winding: counter-clockwise seen from outside
      for (let ax = 0; ax < 3; ax++) for (const s of [0, 1]) {
        const u = (ax + 1) % 3, v = (ax + 2) % 3;
        const quad = [[0, 0], [1, 0], [1, 1], [0, 1]];
        if (!s) quad.reverse();
        prims.push(b.addPrim(quad.map(([cu, cv]) => { const c3 = [0, 0, 0]; c3[ax] = s; c3[u] = cu; c3[v] = cv; return base + 4 * c3[0] + 2 * c3[1] + c3[2]; })));
      }
    } else {
      let pts = m.points;
      if (m.kind === 'zone') {
        // drawn either way round; stored counter-clockwise seen from above, so the polygon faces up (+Y)
        let ny = 0;
        for (let k = 0; k < pts.length; k++) { const p = pts[k], q = pts[(k + 1) % pts.length]; ny += (p[2] - q[2]) * (p[0] + q[0]); }
        if (ny < 0) pts = pts.slice().reverse();
      }
      prims.push(b.addPrim(pts.map(([x, y, z]) => b.addPoint(x, y, z)), m.kind === 'zone'));
    }
    for (const pr of prims) {
      b.attrib('prim', 'name', 1, 'string').set(pr, m.name);
      b.attrib('prim', 'role', 1, 'string').set(pr, m.kind);
    }
  }
  return b.build();
}

interface VarsReply { status: number; body: { ok: boolean; ms: number; errors: string[]; vars?: Record<string, any> } }
interface VarsBatch { vars: Record<string, any>; waiters: ((r: VarsReply) => void)[] }

export interface ViewerOptions {
  /**
   * Where the inputs folder is, in words that follow "inputs/" on the page: `topotopo view` passes "beside house.json".
   * Default: "in the workspace" (or the folder that holds it, when the workspace was given another inputs folder).
   */
  inputsWhere?: string;
}

export async function startViewer(ws: Workspace, port = Number(process.env.TOPOTOPO_PORT ?? 7341), opts: ViewerOptions = {}): Promise<{ url: string; close: () => void }> {
  const clients = new Set<http.ServerResponse>();
  const broadcast = (ev: object) => {
    const msg = `data: ${JSON.stringify(ev)}\n\n`;
    for (const c of clients) c.write(msg);
  };
  ws.listeners.add(broadcast);
  const outputs = createOutputs(ws, () => broadcast({ outputs: true }));

  // ---------------------------------------------------------------- inputs/
  let inputsVersion = 0;
  const inputsChanged = () => broadcast({ inputs: ++inputsVersion });
  const listInputs = () => ws.listInputs().filter((f) => !PART_RE.test(f.path));
  const inputsWhere = opts.inputsWhere ?? (path.dirname(ws.inputDir) === ws.dir ? 'in the workspace' : `in ${path.dirname(ws.inputDir)}`);
  // Files copied into inputs/ by other means (file manager, an agent) show up too, once the folder exists. The viewer
  // does not make it just to watch it (`topotopo view`'s inputs/ beside the graph file appears with the first drop):
  // uploads and listings start the watch when the folder is there by then.
  let watcher: fs.FSWatcher | null = null, watchTimer: ReturnType<typeof setTimeout> | undefined, closed = false;
  const changed = () => { clearTimeout(watchTimer); watchTimer = setTimeout(inputsChanged, 250); };
  const unwatch = (w = watcher) => { w?.close(); if (watcher === w) watcher = null; };
  const watchInputs = () => {
    if (watcher || closed) return;
    try {
      if (!fs.statSync(ws.inputDir, { throwIfNoEntry: false })?.isDirectory()) return;
      const w = fs.watch(ws.inputDir, { recursive: true }, (_ev, f) => {
        const rel = f ? String(f) : '';
        // The folder itself went away. Windows says so with no error but a stream of events naming it by absolute path,
        // which goes on after the folder is made again. Stop; the listing this change prompts watches a new folder.
        if (path.isAbsolute(rel) || !fs.existsSync(ws.inputDir)) { unwatch(w); changed(); return; }
        if (!PART_RE.test(rel.split(path.sep).join('/'))) changed();
      });
      w.on('error', () => { unwatch(w); changed(); });
      w.unref();
      watcher = w;
    } catch { /* no watch: uploads through the viewer still notify */ }
  };
  watchInputs();

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
    // "inputs/<rel>", the path a graph's file node uses, resolves against the host's base directory: the folder that
    // holds inputs/ under the MCP server (the workspace) and under `topotopo view` (the graph file's folder). A
    // workspace whose engine resolves paths elsewhere (an embedding app, a test) gets the absolute path.
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
    // the first drop makes the folder (again, after it was deleted): a watch from before is on a folder that is gone
    if (fs.mkdirSync(root, { recursive: true }) !== undefined) unwatch();
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
    watchInputs();
    inputsChanged();
    return { status: 200, body: { ok: true, path: name, size: n } };
  };

  // ---------------------------------------------------------------- markers
  // The editable list is inputs/.markers.json (a dot-file: not listed, not read by agents); the geometry is
  // inputs/markers.json. An empty list removes both.
  const markersListFile = () => path.join(ws.inputDir, '.markers.json');
  const markersGeoFile = () => path.join(ws.inputDir, 'markers.json');
  /** Written as a dot-file next to the target and renamed, so readers never see half a file. */
  const writeAtomic = (file: string, data: string | Uint8Array) => {
    const part = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.part`);
    try { fs.writeFileSync(part, data); fs.renameSync(part, file); } catch (e) { fs.rmSync(part, { force: true }); throw e; }
  };
  const loadMarkers = (): { markers: Marker[]; error?: string } => {
    let text: string;
    try { text = fs.readFileSync(markersListFile(), 'utf8'); } catch { return { markers: [] }; }
    try { return { markers: parseMarkers(JSON.parse(text)) }; }
    catch (e: any) { return { markers: [], error: `inputs/.markers.json is unreadable (${e.message}); saving markers replaces it` }; }
  };
  const saveMarkers = (list: Marker[]) => {
    let counts = { points: 0, prims: 0 };
    if (!list.length) for (const f of [markersGeoFile(), markersListFile()]) fs.rmSync(f, { force: true });
    else {
      const g = markersGeometry(list);
      counts = { points: g.numPoints, prims: g.numPrims };
      // as for an upload: the first marker makes the folder (again, after it was deleted), and a watch from before is
      // on a folder that is gone
      if (fs.mkdirSync(ws.inputDir, { recursive: true }) !== undefined) unwatch();
      writeAtomic(markersGeoFile(), exportGeometry(g, 'json'));
      writeAtomic(markersListFile(), JSON.stringify({ markers: list }, null, 1));
    }
    watchInputs();
    inputsChanged();
    return { ok: true, count: list.length, path: list.length ? 'markers.json' : null, ...counts };
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
      if (await outputs.handle(req, res, u, readJSON)) return;
      if (u.pathname === '/' || u.pathname === '/index.html') return send(200, fs.readFileSync(path.join(here, 'index.html')), MIME['.html']);
      // the page's modules and style sheet
      if (u.pathname.startsWith('/app/')) {
        const p = path.resolve(appDir, decodeURIComponent(u.pathname.slice('/app/'.length)));
        if (!p.startsWith(appDir + path.sep) || !fs.statSync(p, { throwIfNoEntry: false })?.isFile()) return send(404, 'not found');
        return send(200, fs.readFileSync(p), MIME[path.extname(p)] ?? 'application/octet-stream');
      }
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
      // the last cook of a graph, for the page's status bar: cook time, errors and warnings
      if (u.pathname === '/api/report') {
        const name = u.searchParams.get('graph') ?? 'main';
        if (!ws.graphs.has(name)) return json(404, { error: `no graph ${name}` });
        const r = ws.lastReport.get(name), version = ws.versions.get(name) ?? 0;
        if (!r) return json(200, { graph: name, version, cooked: false });
        return json(200, { graph: name, version, cooked: true, target: r.target, ok: r.ok, ms: r.ms, errors: r.errors.map(issueText), warnings: r.warnings.map(issueText) });
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
        watchInputs();
        return json(200, listInputs());
      }
      // where dropped files go: the absolute folder, and in words for the page ("beside house.json")
      if (u.pathname === '/api/inputs_dir') return json(200, { dir: ws.inputDir, where: inputsWhere });
      if (u.pathname === '/api/markers') {
        if (req.method === 'POST') return json(200, saveMarkers(parseMarkers(await readJSON(req))));
        if (req.method !== 'GET' && req.method !== 'HEAD') return json(405, { ok: false, error: 'GET, or POST {"markers": [...]}' });
        return json(200, loadMarkers());
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
      closed = true;
      outputs.close();
      clearInterval(keepAlive);
      clearTimeout(watchTimer);
      unwatch();
      ws.listeners.delete(broadcast);
      for (const c of clients) c.end();
      server.close();
    },
  };
}
