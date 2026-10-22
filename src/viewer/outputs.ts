// Output catalogue, previews, downloads and exports. Geometry stays server-side; cards and previews are lazy.
// A published output exports to its target in the graph (io/targets.ts): its Export button writes it, Export all
// writes every target, and a first export sets the target in the graph so the next click just writes again.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import type http from 'node:http';
import { zipSync } from 'fflate';
import { ArtifactStore, artifactId } from '../host/artifacts.ts';
import type { Artifact } from '../host/artifacts.ts';
import { prepareTarget, writeTargets } from '../host/export-targets.ts';
import type { PreparedTarget } from '../host/export-targets.ts';
import type { Workspace } from '../workspace.ts';
import type { Geometry } from '../core/geometry.ts';
import { Image, referenceableImages, imageToBytes, resizeLayer } from '../core/image.ts';
import { expandPacked } from '../core/packed.ts';
import { withHeightfieldPreview } from '../core/heightfield.ts';
import { withImagePreview } from '../render/texview.ts';
import { renderGeometry } from '../render/raster.ts';
import { encodePNG } from '../render/png.ts';
import { exportGeometryAsync } from '../io/export.ts';
import { FORMAT_LABELS, TARGET_FORMATS, publishedOutputs, targetError, targetExtension } from '../io/targets.ts';
import type { PublishedOutput, ResolvedTarget } from '../io/targets.ts';
import { summarize } from '../inspect.ts';

const digest = (x: string) => createHash('sha256').update(x).digest('hex');
const imageExt = /\.(png|jpe?g|webp)$/i;
const meshExt = /\.(glb|gltf|obj|stl|ply|geo|bgeo|json|csv)$/i;
const mime = (p: string) => ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.glb': 'model/gltf-binary' })[path.extname(p).toLowerCase()] ?? 'application/octet-stream';
const deflate = (d: Uint8Array) => zlib.deflateSync(d, { level: 6 });
const stamp = (p: string) => { const s = fs.statSync(p, { throwIfNoEntry: false }); return s ? `${s.size}:${s.mtimeMs}` : 'missing'; };
function err(status: number, message: string): never { throw Object.assign(new Error(message), { status }); }
const idFor = (...parts: string[]) => digest(JSON.stringify(parts)).slice(0, 24);
const inside = (dir: string, p: string) => { const rel = path.relative(dir, p); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };

export interface OutputEntry {
  origin?: 'published' | 'saved'; id: string; label: string; graph?: string; node?: string; parent?: string;
  kind: 'geometry' | 'image' | 'file' | 'bundle'; status: 'loading' | 'ready' | 'error';
  revision: string; error?: string; summary?: string; width?: number; height?: number;
  layers?: string[]; layer?: string; image?: string; generated?: boolean;
  /** a published output's card has an Export button: `output` is its id (null = the graph's default output) */
  exportable?: boolean; output?: string | null;
  /** where it exports (posix path inside exports/, the export tool's options), or null before a first export sets it */
  target?: { format: string; path: string; options: Record<string, unknown> } | null;
  /** its last export to that target: newest file time (ms), total bytes, file count */
  saved?: { at: number; size: number; files: number };
  files?: { id: string; name: string; size: number }[];
}
interface Item { entry: OutputEntry; geo?: Geometry; file?: string; files?: string[]; img?: Image; owner?: Item; key?: string; pending?: Promise<void> }

/** Predictable ZIP bytes, retaining the bundle directory structure. */
export function outputZip(files: { name: string; bytes: Uint8Array }[]): Uint8Array {
  const entries: Record<string, any> = Object.create(null);
  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name, 'en')))
    entries[f.name] = [f.bytes, { mtime: new Date(1980, 0, 1), level: 6 }];
  return zipSync(entries);
}

export interface OutputsOptions {
  /** after a target is set in a graph (topotopo view writes it back into the graph file) */
  persistGraph?: (graph: string) => void;
}

export function createOutputs(ws: Workspace, changed: () => void, opts: OutputsOptions = {}) {
  const store = new ArtifactStore(ws.exportDir);
  const items = new Map<string, Item>(), previewCache = new Map<string, Uint8Array>();
  let queue = Promise.resolve(), closed = false, lastFiles = '', exportQueue = Promise.resolve();
  const cache = async (key: string, make: () => Uint8Array | Promise<Uint8Array>) => {
    if (previewCache.has(key)) return previewCache.get(key)!;
    const bytes = await make();
    previewCache.set(key, bytes);
    // Bound retained image/GLB bytes, independent of the engine's own geometry cache.
    let total = [...previewCache.values()].reduce((n, b) => n + b.length, 0);
    for (const [k, b] of previewCache) { if (total <= 64 * 1024 * 1024) break; previewCache.delete(k); total -= b.length; }
    return bytes;
  };
  const addImages = (item: Item) => {
    for (const [id, v] of items) if (v.owner === item) items.delete(id);
    if (!item.geo) return;
    for (const [name, img] of referenceableImages(item.geo)) {
      const id = idFor(item.entry.id, name);
      items.set(id, { owner: item, img, entry: { id, origin: item.entry.origin, parent: item.entry.id, graph: item.entry.graph, node: item.entry.node,
        label: name, kind: 'image', generated: true, status: 'ready', revision: item.entry.revision,
        width: img.width, height: img.height, layers: [...img.layers.keys()], layer: img.mainLayer, image: name } });
    }
  };
  const cook = (item: Item) => {
    if (item.pending) return item.pending;
    const key = item.key, e = item.entry;
    item.pending = queue = queue.catch(() => {}).then(async () => {
      // Yield between outputs so navigation and metadata requests remain responsive.
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (closed || items.get(e.id) !== item) return;
      try {
        const r = item.file
          ? await ws.engine.cook({ nodes: { file: { type: 'file', params: { path: item.file } } }, output: 'file' })
          : await ws.cook(e.graph!, e.node);
        if (item.key !== key || items.get(e.id) !== item) return;
        if (!r.ok || !r.geo) throw new Error(r.errors.map((x) => `${x.node}: ${x.message}`).join('\n') || 'no geometry');
        item.geo = r.geo;
        e.status = 'ready'; delete e.error;
        const firstImage = referenceableImages(r.geo).values().next().value;
        if (!r.geo.numPoints && !r.geo.numPrims && firstImage) {
          item.img = firstImage; e.kind = 'image'; e.width = firstImage.width; e.height = firstImage.height;
          e.layers = [...firstImage.layers.keys()]; e.layer = firstImage.mainLayer;
        }
        if (!item.file) e.revision = digest(`${key}:${r.results.get(r.target)?.sig ?? ''}`);
        e.summary = summarize(r.geo);
        addImages(item);
      } catch (error) {
        e.status = 'error'; e.error = String((error as Error).message);
        // Keep the last valid preview but mark its image children stale as well.
        for (const v of items.values()) if (v.owner === item) { v.entry.status = 'error'; v.entry.error = e.error; }
      } finally { item.pending = undefined; if (!closed) changed(); }
    });
    return item.pending;
  };
  /** The last export of a published output to its current target, from the receipts. */
  const lastSaved = (records: Artifact[], graph: string, p: PublishedOutput) => {
    if (!p.target) return undefined;
    const dest = path.join(ws.exportDir, ...p.target.path.split('/'));
    let best: OutputEntry['saved'];
    for (const r of records) {
      if (r.graph !== graph || r.output !== (p.output ?? '') || !r.files.some((f) => inside(dest, f))) continue;
      const stats = r.files.map((f) => fs.statSync(f, { throwIfNoEntry: false })).filter((s) => s?.isFile());
      if (!stats.length) continue;
      const at = Math.max(...stats.map((s) => s!.mtimeMs));
      if (!best || at > best.at) best = { at: Math.round(at), size: stats.reduce((n, s) => n + s!.size, 0), files: stats.length };
    }
    return best;
  };
  const refresh = () => {
    const alive = new Set<string>();
    const inputStamp = JSON.stringify(ws.listInputs().map((f) => [f.path, f.size, f.mtime]));
    // A referenced graph or a file outside inputs/ can change an otherwise unchanged output.
    const sourceFiles = new Map<string, string>();
    for (const spec of ws.graphs.values()) for (const node of Object.values(spec.nodes)) {
      const p = node.params?.path ?? node.params?.file ?? node.params?.filename;
      if (typeof p !== 'string' || !p || p.startsWith('=')) continue;
      sourceFiles.set(p, ws.engine.host.fileStamp(p));
      try { if (ws.engine.host.isDirectory?.(p)) for (const f of ws.engine.host.listDir?.(p) ?? []) {
        const child = path.join(p, f); sourceFiles.set(child, ws.engine.host.fileStamp(child));
      } } catch { /* a disappearing file is reported by the next cook */ }
    }
    const workspaceRevision = digest(JSON.stringify([...ws.graphs]) + inputStamp + JSON.stringify([...sourceFiles]));
    const records = store.records();
    for (const [graph, spec] of ws.graphs) {
      for (const p of publishedOutputs(graph, spec, ws.engine.findOutput(spec).name)) {
        const id = idFor('graph', graph, p.output === null ? 'default' : 'named', p.output ?? 'main'); alive.add(id);
        const key = workspaceRevision, old = items.get(id);
        const meta = { label: p.label, output: p.output, target: p.target ? { format: p.target.format, path: p.target.path, options: p.target.options } : null, saved: lastSaved(records, graph, p) };
        if (old?.key === key) { Object.assign(old.entry, meta); if (!meta.saved) delete old.entry.saved; continue; }
        const item: Item = { geo: old?.geo, key, entry: { id, origin: 'published', graph, node: p.node, kind: 'geometry', generated: true, exportable: true, status: 'loading', revision: key, ...meta } };
        if (!meta.saved) delete item.entry.saved;
        // Carry last valid images until the replacement cook completes.
        if (old) for (const v of items.values()) if (v.owner === old) { v.owner = item; v.entry.status = 'loading'; }
        items.set(id, item); void cook(item);
      }
    }
    const saved = store.list();
    for (const a of saved) {
      const id = 'file-' + a.id; alive.add(id);
      const files = a.files.filter((p) => fs.statSync(p, { throwIfNoEntry: false })?.isFile());
      if (!files.length) { alive.delete(id); continue; }
      const revision = digest(files.map((p) => p + stamp(p)).join('|'));
      if (items.get(id)?.entry.revision === revision) continue;
      const file = files[0];
      const kind = files.length > 1 ? 'bundle' : imageExt.test(file) ? 'image' : meshExt.test(file) ? 'geometry' : 'file';
      items.set(id, { file, files, entry: { id, origin: 'saved', label: a.label, graph: a.graph, node: a.node, kind, status: 'ready', revision,
        summary: a.format === 'reference' ? 'Reference image' : `Saved ${a.format ?? path.extname(file).slice(1)} output`,
        files: files.map((p) => ({ id: artifactId(p), name: path.relative(path.dirname(file), p).split(path.sep).join('/'), size: fs.statSync(p, { throwIfNoEntry: false })?.size ?? 0 })) } });
    }
    // Bundle contents are individual inspectable outputs as well as downloads.
    for (const item of [...items.values()]) if (alive.has(item.entry.id) && item.files && item.files.length > 1) for (const file of item.files) {
      const stat = fs.statSync(file, { throwIfNoEntry: false }); if (!stat?.isFile()) continue;
      const id = item.entry.id + '-' + artifactId(file); alive.add(id);
      const revision = digest(stamp(file));
      if (items.get(id)?.entry.revision === revision) continue;
      items.set(id, { file, files: [file], entry: { id, origin: item.entry.origin, parent: item.entry.id, graph: item.entry.graph, label: path.basename(file),
        kind: imageExt.test(file) ? 'image' : meshExt.test(file) ? 'geometry' : 'file', status: 'ready', revision,
        files: [{ id: artifactId(file), name: path.basename(file), size: stat.size }] } });
    }
    for (const [id, item] of items) if (!alive.has(id) && !item.owner) { items.delete(id); for (const [child, v] of items) if (v.owner === item) items.delete(child); }
    const signature = JSON.stringify([...items.values()].filter((v) => v.files || v.entry.exportable).map((v) => [v.entry.id, v.entry.revision, v.entry.target, v.entry.saved]));
    if (signature !== lastFiles) { lastFiles = signature; changed(); }
  };
  const get = (id: string | null) => items.get(id ?? '') ?? err(404, 'output no longer exists');
  const geometry = async (item: Item) => { if (item.owner) item = item.owner; if (!item.geo || item.pending) await cook(item); return item.geo ?? err(422, item.entry.error ?? 'no geometry'); };
  /** The published output behind a card, as the graph now has it. */
  const published = (entry: OutputEntry): PublishedOutput => {
    const spec = ws.getGraph(entry.graph!);
    return publishedOutputs(entry.graph!, spec, ws.engine.findOutput(spec).name).find((p) => p.output === entry.output) ?? err(404, 'output no longer exists');
  };
  /** Cook now and serialize to the target: the export writes the current graph, whatever the preview last showed. */
  const prepare = async (graph: string, p: PublishedOutput): Promise<PreparedTarget> => {
    const r = await ws.cook(graph, p.node);
    if (!r.ok || !r.geo) err(422, `${p.label} (${graph}): ` + (r.errors.map((e) => `${e.node}: ${e.message}`).join('; ') || 'no geometry'));
    return prepareTarget(r.geo!, graph, p as PublishedOutput & { target: ResolvedTarget }, ws.exportDir, ws.engine.host);
  };
  /** One export at a time, so two clicks never interleave their writes. */
  const exclusive = async <T>(work: () => Promise<T>): Promise<T> => {
    let unlock!: () => void;
    const prior = exportQueue; exportQueue = new Promise<void>((r) => { unlock = r; });
    await prior;
    try { return await work(); } finally { unlock(); }
  };
  // A file can vanish while a scan stats it. The next tick or request rescans; neither callback may throw (an
  // exception in the timer would end the viewer's process, the MCP server's too when it hosts the viewer).
  const rescan = () => { try { refresh(); } catch { /* rescanned on the next tick */ } };
  const listener = () => { rescan(); changed(); };
  ws.listeners.add(listener);
  const timer = setInterval(() => { if (!closed) rescan(); }, 1500); timer.unref();

  return {
    close() { closed = true; clearInterval(timer); ws.listeners.delete(listener); items.clear(); previewCache.clear(); },
    async handle(req: http.IncomingMessage, res: http.ServerResponse, u: URL, readJSON: (r: http.IncomingMessage) => Promise<any>): Promise<boolean> {
      if (!u.pathname.startsWith('/api/output')) return false;
      const send = (body: Uint8Array | string, type: string, name?: string) => {
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...(name ? { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}` } : {}) }); res.end(body);
      };
      const json = (j: unknown) => send(JSON.stringify(j), 'application/json');
      const posts = ['/api/output/export', '/api/output/export-all'];
      try {
        if (posts.includes(u.pathname) ? req.method !== 'POST' : req.method !== 'GET') err(405, posts.includes(u.pathname) ? 'POST required' : 'method not allowed');
        refresh();
        if (u.pathname === '/api/outputs') {
          json({ items: [...items.values()].map((v) => v.entry), directory: ws.exportDir,
            formats: TARGET_FORMATS.map((f) => ({ format: f, label: FORMAT_LABELS[f], extension: targetExtension(f) })) });
          return true;
        }
        if (u.pathname === '/api/output/export') {
          // {id} writes the output to its target; {id, export} first sets the target ({id, export: null} only removes it)
          const body = await readJSON(req), item = get(body?.id);
          if (!item.entry.exportable) err(400, 'only a published output (a card with an Export button) exports');
          return await exclusive(async () => {
            const graph = item.entry.graph!;
            if (body.export !== undefined) {
              if (body.export !== null && targetError(body.export)) err(400, targetError(body.export)!);
              try { await ws.edit(graph, [{ op: 'export', ...(item.entry.output === null ? {} : { output: item.entry.output! }), export: body.export }]); }
              catch (e) { err(400, (e as Error).message); }
              opts.persistGraph?.(graph);
              if (body.export === null) { rescan(); changed(); json({ ok: true, cleared: true }); return true; }
            }
            const p = published(item.entry);
            if (!p.target) err(400, 'no export target yet: choose a format');
            const prepared = await prepare(graph, p);
            writeTargets([prepared], ws.exportDir);
            rescan(); changed();
            json({ ok: true, path: p.target.path, files: prepared.files.length, summary: prepared.summary, warnings: prepared.warnings });
            return true;
          });
        }
        if (u.pathname === '/api/output/export-all') {
          return await exclusive(async () => {
            const targets: { graph: string; p: PublishedOutput }[] = [], skipped: { graph: string; label: string }[] = [];
            for (const [graph, spec] of ws.graphs) for (const p of publishedOutputs(graph, spec, ws.engine.findOutput(spec).name))
              if (p.target) targets.push({ graph, p }); else skipped.push({ graph, label: p.label });
            if (!targets.length) err(400, 'no output has an export target yet: export one with its Export button first');
            // every target cooks and serializes before any file is written
            const prepared: PreparedTarget[] = [];
            for (const t of targets) prepared.push(await prepare(t.graph, t.p));
            writeTargets(prepared, ws.exportDir);
            rescan(); changed();
            json({ ok: true, written: prepared.map((x) => ({ graph: x.graph, label: x.label, path: x.target.path, warnings: x.warnings })), skipped });
            return true;
          });
        }
        const item = get(u.searchParams.get('id'));
        const mode = u.searchParams.get('mode') ?? 'RGB', layer = u.searchParams.get('layer') ?? item.entry.layer ?? '';
        if (u.pathname === '/api/output/file') {
          const p = (item.files ?? []).find((p) => artifactId(p) === u.searchParams.get('file')) ?? (u.searchParams.has('file') ? undefined : item.file);
          if (!p || !fs.statSync(p, { throwIfNoEntry: false })?.isFile()) err(404, 'file no longer exists');
          send(fs.readFileSync(p), mime(p), u.searchParams.has('download') ? path.basename(p) : undefined); return true;
        }
        if (u.pathname === '/api/output/zip') {
          if (!item.files?.length) err(400, 'no saved files');
          // names relative to the folder every file shares, so no entry climbs out with "../"
          const common = (a: string, b: string) => { while (a !== path.dirname(a) && path.relative(a, b).startsWith('..')) a = path.dirname(a); return a; };
          const root = item.files.map((p) => path.dirname(p)).reduce(common);
          send(outputZip(item.files.map((p) => ({ name: path.relative(root, p).split(path.sep).join('/'), bytes: fs.readFileSync(p) }))), 'application/zip', item.entry.label + '.zip'); return true;
        }
        if (u.pathname === '/api/output/image' || u.pathname === '/api/output/thumb' && item.img) {
          if (!item.img) err(400, 'this output is not a generated image');
          let img: Image = item.img;
          if (layer && !img.layers.has(layer)) err(404, 'image layer no longer exists');
          const thumb = u.pathname.endsWith('/thumb');
          const bytes = await cache(`${item.entry.id}:${item.entry.revision}:${layer}:${mode}:${thumb}`, () => {
            if (thumb) {
              const s = Math.min(1, 160 / Math.max(img.width, img.height)), w = Math.max(1, Math.round(img.width * s)), h = Math.max(1, Math.round(img.height * s));
              const l = layer || img.mainLayer;
              const small = new Image(w, h, img.name); small.set(l, resizeLayer(img.layer(l)!, img.channels(l), img.width, img.height, w, h, true)); img = small;
            }
            const data = imageToBytes(img, layer, true), rgba = new Uint8Array(img.count * 4);
            for (let i = 0; i < img.count; i++) {
              const rgb = data.channels === 1 ? [data.bytes[i], data.bytes[i], data.bytes[i], 255] : data.bytes.subarray(i * 4, i * 4 + 4);
              const channel = ['R', 'G', 'B', 'A'].indexOf(mode);
              rgba.set(channel >= 0 ? [rgb[channel], rgb[channel], rgb[channel], 255] : [rgb[0], rgb[1], rgb[2], mode === 'RGBA' ? rgb[3] : 255], i * 4);
            }
            return encodePNG(rgba, img.width, img.height, deflate);
          });
          // a texture card's Download: the image as a PNG named after it
          send(bytes, 'image/png', u.searchParams.has('download') ? `${item.entry.label}${layer && layer !== img.mainLayer ? '_' + layer : ''}.png` : undefined); return true;
        }
        if (u.pathname === '/api/output/uv') {
          const g = expandPacked(await geometry(item)).geo, uv = g.vertices.get('uv') ?? g.points.get('uv'), segments: number[][] = [];
          if (uv) for (let p = 0; p < g.numPrims; p++) {
            const start = g.primStart[p], end = g.primStart[p + 1];
            for (let v = start; v < end; v++) {
              const next = v + 1 === end ? start : v + 1;
              const a = uv.get(g.vertices.get('uv') ? v : g.vertexPoint[v]) as number[], b = uv.get(g.vertices.get('uv') ? next : g.vertexPoint[next]) as number[];
              segments.push([a[0], a[1], b[0], b[1]]);
            }
          }
          json({ segments }); return true;
        }
        if (u.pathname === '/api/output/geo' || u.pathname === '/api/output/thumb') {
          if (item.file && imageExt.test(item.file)) { send(fs.readFileSync(item.file), mime(item.file)); return true; }
          const g = await geometry(item), thumb = u.pathname.endsWith('/thumb');
          const bytes = await cache(`${item.entry.id}:${item.entry.revision}:${thumb}`, async () => {
            if (!thumb) return exportGeometryAsync(withImagePreview(withHeightfieldPreview(g)), 'glb', { custom: false, splitByName: false, readFile: (p) => ws.engine.host.readFile(p) });
            const r = renderGeometry(g, { size: 160, views: ['persp'], viewLabels: false });
            return encodePNG(r.rgba.subarray(0, r.width * 160 * 4), r.width, 160, deflate);
          });
          send(bytes, thumb ? 'image/png' : 'model/gltf-binary'); return true;
        }
        err(404, 'unknown output route');
      } catch (error: any) {
        if (error?.name === 'EditRejected') error.status = 400;
        res.writeHead(error.status ?? 500, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ ok: false, error: String(error.message) }));
      }
      return true;
    },
  };
}
