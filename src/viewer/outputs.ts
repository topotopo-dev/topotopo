// Output catalogue and download/export routes. Geometry stays server-side; cards and previews are lazy.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import type http from 'node:http';
import { zipSync } from 'fflate';
import { ArtifactStore, artifactId } from '../host/artifacts.ts';
import type { Workspace } from '../workspace.ts';
import type { Geometry } from '../core/geometry.ts';
import { Image, referenceableImages, imageToBytes, resizeLayer } from '../core/image.ts';
import { expandPacked } from '../core/packed.ts';
import { withHeightfieldPreview } from '../core/heightfield.ts';
import { withImagePreview } from '../render/texview.ts';
import { renderGeometry } from '../render/raster.ts';
import { encodePNG } from '../render/png.ts';
import { exportGeometryAsync, EXPORT_FORMATS } from '../io/export.ts';
import type { ExportFormat } from '../io/export.ts';
import { exportFilesAsync } from '../io/files.ts';
import { summarize } from '../inspect.ts';

const digest = (x: string) => createHash('sha256').update(x).digest('hex');
const imageExt = /\.(png|jpe?g|webp)$/i;
const meshExt = /\.(glb|gltf|obj|stl|ply|geo|bgeo|json|csv)$/i;
const mime = (p: string) => ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.glb': 'model/gltf-binary' })[path.extname(p).toLowerCase()] ?? 'application/octet-stream';
const deflate = (d: Uint8Array) => zlib.deflateSync(d, { level: 6 });
const stamp = (p: string) => { const s = fs.statSync(p, { throwIfNoEntry: false }); return s ? `${s.size}:${s.mtimeMs}` : 'missing'; };
function err(status: number, message: string): never { throw Object.assign(new Error(message), { status }); }
const idFor = (...parts: string[]) => digest(JSON.stringify(parts)).slice(0, 24);

export interface OutputEntry {
  id: string; label: string; graph?: string; node?: string; parent?: string;
  kind: 'geometry' | 'image' | 'file' | 'bundle'; status: 'loading' | 'ready' | 'error';
  revision: string; error?: string; summary?: string; width?: number; height?: number;
  layers?: string[]; layer?: string; image?: string; generated?: boolean; exportable?: boolean;
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

export function createOutputs(ws: Workspace, changed: () => void) {
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
      items.set(id, { owner: item, img, entry: { id, parent: item.entry.id, graph: item.entry.graph, node: item.entry.node,
        label: name, kind: 'image', generated: true, exportable: !!item.entry.exportable, status: 'ready', revision: item.entry.revision,
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
    for (const [graph, spec] of ws.graphs) {
      const target = ws.engine.findOutput(spec).name;
      const outputs = [{ node: target, label: 'Main output', id: 'main', primary: true }, ...Object.entries(spec.outputs ?? {}).map(([id, o]) => ({ ...o, id, primary: false }))];
      for (const o of outputs) {
        const id = idFor('graph', graph, o.primary ? 'default' : 'named', o.id); alive.add(id);
        const key = workspaceRevision;
        const old = items.get(id);
        if (old?.key === key) { old.entry.label = o.label ?? o.id; continue; }
        const item: Item = { geo: old?.geo, key, entry: { id, graph, node: o.node, label: o.label ?? o.id, kind: 'geometry', generated: true, exportable: true, status: 'loading', revision: key } };
        // Carry last valid images until the replacement cook completes.
        if (old) for (const v of items.values()) if (v.owner === old) { v.owner = item; v.entry.status = 'loading'; }
        items.set(id, item); void cook(item);
      }
    }
    const saved = store.list();
    for (const f of ws.listInputs().filter((f) => f.kind === 'image')) saved.push({ id: 'input-' + artifactId(path.join(ws.inputDir, f.path)), label: f.path, files: [path.join(ws.inputDir, f.path)], format: 'reference' });
    for (const a of saved) {
      const id = 'file-' + a.id; alive.add(id);
      const files = a.files.filter((p) => fs.statSync(p, { throwIfNoEntry: false })?.isFile());
      if (!files.length) { alive.delete(id); continue; }
      const revision = digest(files.map((p) => p + stamp(p)).join('|'));
      if (items.get(id)?.entry.revision === revision) continue;
      const file = files[0];
      const kind = files.length > 1 ? 'bundle' : imageExt.test(file) ? 'image' : meshExt.test(file) ? 'geometry' : 'file';
      items.set(id, { file, files, entry: { id, label: a.label, graph: a.graph, node: a.node, kind, status: 'ready', revision,
        summary: a.format === 'reference' ? 'Reference image' : `Saved ${a.format ?? path.extname(file).slice(1)} output`,
        files: files.map((p) => ({ id: artifactId(p), name: path.relative(path.dirname(file), p).split(path.sep).join('/'), size: fs.statSync(p).size })) } });
    }
    // Bundle contents are individual inspectable outputs as well as downloads.
    for (const item of [...items.values()]) if (alive.has(item.entry.id) && item.files && item.files.length > 1) for (const file of item.files) {
      const stat = fs.statSync(file, { throwIfNoEntry: false }); if (!stat?.isFile()) continue;
      const id = item.entry.id + '-' + artifactId(file); alive.add(id);
      const revision = digest(stamp(file));
      if (items.get(id)?.entry.revision === revision) continue;
      items.set(id, { file, files: [file], entry: { id, parent: item.entry.id, graph: item.entry.graph, label: path.basename(file),
        kind: imageExt.test(file) ? 'image' : meshExt.test(file) ? 'geometry' : 'file', status: 'ready', revision,
        files: [{ id: artifactId(file), name: path.basename(file), size: stat.size }] } });
    }
    for (const [id, item] of items) if (!alive.has(id) && !item.owner) { items.delete(id); for (const [child, v] of items) if (v.owner === item) items.delete(child); }
    const signature = JSON.stringify([...items.values()].filter((v) => v.files).map((v) => [v.entry.id, v.entry.revision]));
    if (signature !== lastFiles) { lastFiles = signature; changed(); }
  };
  const get = (id: string | null) => items.get(id ?? '') ?? err(404, 'output no longer exists');
  const geometry = async (item: Item) => { if (item.owner) item = item.owner; if (!item.geo || item.pending) await cook(item); return item.geo ?? err(422, item.entry.error ?? 'no geometry'); };
  const listener = () => { refresh(); changed(); };
  ws.listeners.add(listener);
  const timer = setInterval(() => { if (!closed) refresh(); }, 1500); timer.unref();

  return {
    close() { closed = true; clearInterval(timer); ws.listeners.delete(listener); items.clear(); previewCache.clear(); },
    async handle(req: http.IncomingMessage, res: http.ServerResponse, u: URL, readJSON: (r: http.IncomingMessage) => Promise<any>): Promise<boolean> {
      if (!u.pathname.startsWith('/api/output')) return false;
      const send = (body: Uint8Array | string, type: string, name?: string) => {
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...(name ? { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}` } : {}) }); res.end(body);
      };
      const json = (j: unknown) => send(JSON.stringify(j), 'application/json');
      try {
        if (req.method !== 'GET' && !(req.method === 'POST' && u.pathname === '/api/output/export')) err(405, 'GET, or POST /api/output/export');
        refresh();
        if (u.pathname === '/api/outputs') { json({ items: [...items.values()].map((v) => v.entry), directory: ws.exportDir, formats: EXPORT_FORMATS }); return true; }
        if (u.pathname === '/api/output/export') {
          const body = await readJSON(req);
          let unlock!: () => void;
          const prior = exportQueue; exportQueue = new Promise<void>((r) => { unlock = r; });
          await prior;
          try {
            const item = get(body.id), owner = item.owner ?? item;
            if (!owner.entry.generated) err(400, 'select a live graph output to export');
            await geometry(owner);
            // Recheck external file signatures as well as graph/UI edits before writing.
            const fresh = await ws.cook(owner.entry.graph!, owner.entry.node);
            const freshRevision = digest(`${owner.key}:${fresh.results.get(fresh.target)?.sig ?? ''}`);
            if (!fresh.ok || !fresh.geo) {
              owner.entry.status = 'error'; owner.entry.error = fresh.errors.map((e) => e.message).join('\n') || 'no geometry';
              changed(); err(422, owner.entry.error);
            }
            if (owner.entry.status !== 'ready' || body.revision !== owner.entry.revision || freshRevision !== owner.entry.revision) { owner.key = undefined; refresh(); err(409, 'Output changed. Refresh its preview before exporting.'); }
            const geo = fresh.geo!;
            const format = body.format as ExportFormat;
            if (!EXPORT_FORMATS.includes(format)) err(400, 'choose a supported export format');
            if (item.img && format !== 'textures') err(400, 'select the model output to export geometry; images export as PNG textures');
            const raw = String(body.name ?? '').trim();
            if (!raw || raw.length > 160 || /[\\/<>:"|?*\x00-\x1f]/.test(raw) || raw.startsWith('.') || /[. ]$/.test(raw) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(raw)) err(400, 'use a plain filename without folders');
            const o = body.options ?? {}, warnings: string[] = [];
            if (!o || typeof o !== 'object' || Array.isArray(o)) err(400, 'options must be an object');
            for (const k of ['split_by_name', 'materials', 'custom_attribs', 'quantize', 'pcg', 'pcg_struct', 'meshes']) if (o[k] !== undefined && typeof o[k] !== 'boolean') err(400, `invalid ${k}`);
            if (o.instancing !== undefined && !['packed', 'expand'].includes(o.instancing)) err(400, 'invalid instancing');
            if (o.instances !== undefined && !['rows', 'expand'].includes(o.instances)) err(400, 'invalid instances');
            if (o.precision !== undefined && ![32, 64].includes(o.precision)) err(400, 'invalid precision');
            if (o.attributes !== undefined && (!Array.isArray(o.attributes) || !o.attributes.every((v: unknown) => typeof v === 'string'))) err(400, 'attributes must be names');
            if (o.layer !== undefined && typeof o.layer !== 'string') err(400, 'layer must be a name');
            if (o.scale !== undefined && !(Number.isFinite(o.scale) && o.scale > 0)) err(400, 'scale must be positive');
            if (o.up_axis !== undefined && !['y', 'z'].includes(o.up_axis)) err(400, 'up axis must be y or z');
            if (o.compress !== undefined && !['none', 'meshopt', 'draco'].includes(o.compress)) err(400, 'invalid compression');
            for (const k of ['height_min', 'height_max', 'tile_size', 'heightfield']) if (o[k] !== undefined && !Number.isFinite(o[k])) err(400, `invalid ${k}`);
            for (const k of ['tile_size', 'heightfield']) if (o[k] !== undefined && (!Number.isInteger(o[k]) || o[k] < 0)) err(400, `invalid ${k}`);
            if (o.layers !== undefined && (!Array.isArray(o.layers) || !o.layers.every((v: unknown) => typeof v === 'string'))) err(400, 'layers must be names');
            const extension = ({ textures: '', unreal_landscape: '', png16: '.png', mask_png: '.png', pointsjson: '.points.json' } as Record<string, string>)[format] ?? '.' + format;
            const base = extension && raw.toLowerCase().endsWith(extension) ? raw.slice(0, -extension.length) : raw;
            if (!base || base === '..') err(400, 'filename needs a stem');
            const options = { upAxis: o.up_axis, scale: o.scale, splitByName: o.split_by_name ?? true, materials: o.materials ?? true,
              custom: o.custom_attribs, compress: o.compress ?? 'none', quantize: o.quantize ?? false, instancing: o.instancing,
              pcg: o.pcg || o.pcg_struct, pcgStruct: o.pcg_struct, instances: o.instances, meshes: o.meshes, attributes: o.attributes,
              precision: o.precision, layer: o.layer, layers: o.layers, heightMin: o.height_min, heightMax: o.height_max, heightfield: o.heightfield, tile_size: o.tile_size,
              deflate, readFile: (p: string) => ws.engine.host.readFile(p), warn: (m: string) => warnings.push(m) };
            let result, destination = '';
            for (let n = 0; ; n++) {
              const dest = path.join(ws.exportDir, base + (n ? `_${n + 1}` : '') + extension);
              destination = dest;
              let selected = geo;
              if (item.img) { selected = geo.clone(); selected.volumes = [item.img.clone()]; selected.packedSources = []; }
              result = await exportFilesAsync(selected, format, dest, { ...options, texturePath: (p) => path.relative(path.dirname(dest), ws.engine.host.resolvePath(p)).split(path.sep).join('/') });
              if (body.replace === true || result.files.every((f) => !fs.existsSync(f.path))) break;
              if (n > 999) err(409, 'too many existing files with this name');
            }
            for (const f of result.files) { fs.mkdirSync(path.dirname(f.path), { recursive: true }); fs.writeFileSync(f.path + '.part', f.bytes); fs.renameSync(f.path + '.part', f.path); }
            const artifact = store.record(result.files.map((f) => f.path), { label: path.basename(destination), graph: owner.entry.graph, node: owner.entry.node, format, sourceRevision: owner.entry.revision });
            refresh(); changed(); json({ ok: true, id: 'file-' + artifact.id, summary: result.summary, warnings, directory: ws.exportDir });
          } finally { unlock(); }
          return true;
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
          const root = path.dirname(item.files[0]);
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
          send(bytes, 'image/png'); return true;
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
            const r = renderGeometry(g, { size: 160, views: ['persp'] }); return encodePNG(r.rgba, r.width, r.height, deflate);
          });
          send(bytes, thumb ? 'image/png' : 'model/gltf-binary'); return true;
        }
        err(404, 'unknown output route');
      } catch (error: any) {
        res.writeHead(error.status ?? 500, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ ok: false, error: String(error.message) }));
      }
      return true;
    },
  };
}
