// Live preview web server: serves a three.js viewer that shows any graph/node of the
// workspace and refreshes over Server-Sent Events whenever a graph is rebuilt/edited.
// Bound to 127.0.0.1 only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Workspace } from '../workspace.ts';
import { exportGeometryAsync } from '../io/export.ts';
import { summarize } from '../inspect.ts';
import { withHeightfieldPreview } from '../core/heightfield.ts';
import { wiringOf } from '../graph/engine.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const threeDir = path.join(root, 'node_modules', 'three');

const MIME: Record<string, string> = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary' };

export async function startViewer(ws: Workspace, port = Number(process.env.POLYFORGE_PORT ?? 7341)): Promise<{ url: string; close: () => void }> {
  const clients = new Set<http.ServerResponse>();
  ws.listeners.add((ev) => {
    const msg = `data: ${JSON.stringify(ev)}\n\n`;
    for (const c of clients) c.write(msg);
  });

  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://localhost');
      const send = (code: number, body: string | Uint8Array, type = 'text/plain; charset=utf-8') => {
        res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
        res.end(body);
      };
      if (u.pathname === '/' || u.pathname === '/index.html') return send(200, fs.readFileSync(path.join(here, 'index.html')), MIME['.html']);
      if (u.pathname.startsWith('/vendor/three/')) {
        const rel = decodeURIComponent(u.pathname.slice('/vendor/three/'.length));
        const p = path.resolve(threeDir, rel);
        if (!p.startsWith(threeDir) || !fs.existsSync(p)) return send(404, 'not found');
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
            nodes: Object.entries(g.nodes).map(([n, spec]) => {
              const def = ws.engine.resolveDef(spec.type);
              const r = last?.results.get(n);
              return { name: n, type: spec.type, in: def ? wiringOf(spec, def).list : [], error: r?.error?.message ?? null, ms: r?.ms ?? null };
            }),
          };
        });
        return send(200, JSON.stringify(out), MIME['.json']);
      }
      if (u.pathname === '/api/geo' || u.pathname === '/api/info') {
        const name = u.searchParams.get('graph') ?? 'main';
        const node = u.searchParams.get('node') || undefined;
        const g = ws.graphs.get(name);
        if (!g) return send(404, JSON.stringify({ error: `no graph ${name}` }), MIME['.json']);
        const r = await ws.engine.cook(g, { target: node });
        if (!r.ok || !r.geo) return send(500, JSON.stringify({ error: r.errors.map((e) => `[${e.node}] ${e.message}`).join('\n') }), MIME['.json']);
        if (u.pathname === '/api/info') return send(200, JSON.stringify({ target: r.target, summary: summarize(r.geo), ms: r.ms }), MIME['.json']);
        return send(200, await exportGeometryAsync(withHeightfieldPreview(r.geo), 'glb', { splitByName: false, lineMode: 'lines', custom: false }), MIME['.glb']);
      }
      send(404, 'not found');
    } catch (e: any) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(e?.message ?? e) }));
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
  return { url: `http://127.0.0.1:${actual}/`, close: () => { clearInterval(keepAlive); server.close(); } };
}
