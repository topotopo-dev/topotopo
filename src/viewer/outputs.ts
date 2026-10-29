// Output catalogue, previews, downloads and exports. Geometry stays server-side; cards and previews are lazy.
// A graph's results are cards, one per result (io/targets.ts publishedOutputs: the default output once, marked so). A
// card says what its result is (io/kinds.ts: its kind, mesh, instances, points, curves, terrain, textures, volume or
// scene, and its size; its tags; when it is not the kind its graph pins) and offers the formats that write it. Its Download gets the export as a browser download (the file itself, or a zip of its files: a sidecar, a
// textures folder), with the record of how it was made; its Export writes its target in the graph (io/targets.ts) into
// exports/, Export all every target, and a first export sets the target in the graph so the next click just writes
// again. Saved files (exports/, renders) are cards too: a sidecar or manifest beside an export (io/sidecars.ts) is
// metadata of it, not a card of its own.
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
import { sidecarFile } from '../host/sidecars.ts';
import type { Workspace } from '../workspace.ts';
import type { GraphSource } from './graph-file.ts';
import type { Geometry } from '../core/geometry.ts';
import { Image, referenceableImages, imageToBytes, resizeLayer } from '../core/image.ts';
import { expandPacked } from '../core/packed.ts';
import { withHeightfieldPreview } from '../core/heightfield.ts';
import { withImagePreview } from '../render/texview.ts';
import { renderGeometry } from '../render/raster.ts';
import { encodePNG } from '../render/png.ts';
import { exportGeometryAsync, exportFormatFromPath } from '../io/export.ts';
import { SOURCE_INSIDE, stripExtension } from '../io/files.ts';
import { fittingFormats, kindMismatch, outputKind } from '../io/kinds.ts';
import { packagesNamedIn, packagesUsed } from '../graph/packages.ts';
import { ProjectPackages } from '../gallery/packages.ts';
import type { FormatFit, HeightfieldInfo, OutputKind } from '../io/kinds.ts';
import type { Kind } from '../graph/outputs.ts';
import { SIDECAR_NAMES, SIDECAR_TEXT } from '../io/sidecars.ts';
import type { SidecarRole } from '../io/sidecars.ts';
import { STOPPED } from '../graph/engine.ts';
import { FORMAT_LABELS, TARGET_FORMATS, publishedOutputs, resolveTarget, targetError, targetExtension, targetFormat } from '../io/targets.ts';
import type { PublishedOutput, ResolvedTarget } from '../io/targets.ts';
import { summarize } from '../inspect.ts';

const digest = (x: string) => createHash('sha256').update(x).digest('hex');
const imageExt = /\.(png|jpe?g|webp)$/i;
/** files the file node reads (io/import.ts): a saved one previews as a model */
const modelExt = /\.(glb|gltf|obj|stl|ply|geo|bgeo|json|csv)$/i;
const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.json': 'application/json', '.zip': 'application/zip' };
const mime = (p: string) => MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream';
const deflate = (d: Uint8Array) => zlib.deflateSync(d, { level: 6 });
const stamp = (p: string) => { const s = fs.statSync(p, { throwIfNoEntry: false }); return s ? `${s.size}:${s.mtimeMs}` : 'missing'; };
function err(status: number, message: string): never { throw Object.assign(new Error(message), { status }); }
const idFor = (...parts: string[]) => digest(JSON.stringify(parts)).slice(0, 24);
const inside = (dir: string, p: string) => { const rel = path.relative(dir, p); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
/** The folder every path shares, so zip entries named relative to it never climb out with "../". */
const commonDir = (paths: string[]) => paths.map((p) => path.dirname(p)).reduce((a, b) => { while (a !== path.dirname(a) && path.relative(a, b).startsWith('..')) a = path.dirname(a); return a; });
const fmt = (x: number) => String(+x.toFixed(Math.abs(x) >= 100 ? 1 : 2));

export interface OutputEntry {
  origin?: 'published' | 'saved'; id: string; label: string; graph?: string; node?: string; parent?: string;
  /** how the page shows it: as a 3D model, a 2D image, or only as files to download */
  view: 'model' | 'image' | 'file';
  /** its kind (io/kinds.ts, the words everything shows) once cooked, "empty" for nothing; "metadata" for a sidecar or manifest without its export */
  kind?: Kind | 'empty' | 'metadata';
  /** the parts it holds (io/kinds.ts): what the page can show of it */
  parts?: OutputKind;
  /** its size in a few words ("2049 × 2049 samples, 2 m apart"), and its bounding size (x, y, z metres) */
  about?: string; size?: [number, number, number] | null;
  /** the graph's default output (its output node) */
  default?: boolean;
  /** a named output's tags (its "tags" in the graph's outputs) */
  tags?: string[];
  /** it shows the last finished result, not the values now: its cook was stopped */
  stale?: boolean;
  /** the packages it uses whose working folder this session shows live: it holds their unpublished edits, and so do its exports */
  live?: string[];
  /** a named output: the kind its graph pins ("kind" in its outputs), and what it says when it cooks to another */
  pinned?: string; warning?: string;
  /** its heightfield (samples, spacing, layers with their ranges): the page colours the terrain by a layer */
  heightfield?: HeightfieldInfo;
  /** a published output: the formats that write it, best first (io/kinds.ts) */
  formats?: FormatFit[];
  status: 'loading' | 'ready' | 'error';
  revision: string; error?: string; summary?: string; width?: number; height?: number;
  layers?: string[]; layer?: string; image?: string; generated?: boolean;
  /** a published output's card has an Export button: `output` is its id (null = the graph's default output) */
  exportable?: boolean; output?: string | null;
  /** where it exports (posix path inside exports/, the export tool's options), or null before a first export sets it */
  target?: { format: string; path: string; options: Record<string, unknown> } | null;
  /** its last export to that target: newest file time (ms), total bytes, file count */
  saved?: { at: number; size: number; files: number };
  /** saved files, the main one first; a sidecar with what it is ("heightmap sidecar: height range, …") */
  files?: { id: string; name: string; size: number; role?: SidecarRole; about?: string }[];
  /** a saved output's Download: the one file, or a zip of them all (named so) */
  download?: { name: string; zip: boolean };
}
interface Item {
  entry: OutputEntry; geo?: Geometry; file?: string; files?: string[]; img?: Image; owner?: Item; key?: string; pending?: Promise<void>;
  /** the card this one replaces while it cooks (shown again when a person stops that cook) */
  prev?: Item;
}

/** Predictable ZIP bytes, retaining the bundle directory structure. */
export function outputZip(files: { name: string; bytes: Uint8Array }[]): Uint8Array {
  const entries: Record<string, any> = Object.create(null);
  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name, 'en')))
    entries[f.name] = [f.bytes, { mtime: new Date(1980, 0, 1), level: 6 }];
  return zipSync(entries);
}

/**
 * The files a download of an export carries: all it writes, except the standalone record of a format whose one file
 * carries the record itself (glb, gltf: io/files.ts SOURCE_INSIDE), so a GLB downloads as itself.
 */
export function downloadFiles<T extends { path: string }>(format: string, files: T[], sourceManifest?: string): T[] {
  return SOURCE_INSIDE.includes(format as any) && sourceManifest ? files.filter((f) => f.path !== sourceManifest) : files;
}

/** What a saved heightmap is, from its sidecar: "heightmap 2049 × 2049, 2 m · height 0 .. 350 m". */
function heightmapAbout(sidecar: string): string | undefined {
  try {
    const j = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    const [w, h] = j.resolution ?? [];
    if (!(w > 0 && h > 0)) return undefined;
    return `heightmap ${w} × ${h}${typeof j.cell_size === 'number' ? `, ${fmt(j.cell_size)} m` : ''}${typeof j.height_min === 'number' && typeof j.height_max === 'number' ? ` · height ${fmt(j.height_min)} .. ${fmt(j.height_max)} m` : ''}`;
  } catch { return undefined; }
}

export interface OutputsOptions {
  /** the graph file a graph comes from (topotopo view): a target set on the page goes into it as a minimal edit */
  source?: GraphSource;
  /** the graph whose results cook first (the project's default graph, which the page shows first) */
  first?: () => string | null | undefined;
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
        label: name, view: 'image', about: `${img.width} × ${img.height} px`, generated: true, status: 'ready', revision: item.entry.revision,
        width: img.width, height: img.height, layers: [...img.layers.keys()], layer: img.mainLayer, image: name } });
    }
  };
  /**
   * What a cooked result is, on its card: kind, words, size, heightfield; a published one's fitting formats, and a
   * warning when it is not the kind its graph pins (publishing the project's package would block on it).
   */
  const describe = (e: OutputEntry, g: Geometry) => {
    const info = outputKind(g);
    e.kind = info.published ?? 'empty'; e.parts = info.kind; e.about = info.text; e.size = info.size;
    if (info.heightfield) e.heightfield = info.heightfield; else delete e.heightfield;
    if (e.exportable) e.formats = fittingFormats(info);
    const said = e.pinned ? kindMismatch(e.pinned, info) : null;
    if (said) e.warning = `${e.output ? `output "${e.output}": ` : ''}${said}`; else delete e.warning;
    return info;
  };
  /**
   * A card whose cook a person stopped (Workspace.held) goes back to the card it replaced, with the last finished
   * result; one that never finished says it was stopped.
   */
  const unstop = (item: Item, at?: string) => {
    const prev = item.prev, e = item.entry;
    if (!prev) { e.status = 'error'; e.error = `${STOPPED}${at ? ` at ${at}` : ''}: change a value (or the graph) to cook it`; return; }
    // it shows the last finished result: out of date with the values now
    prev.entry.stale = true;
    items.set(e.id, prev);
    for (const v of items.values()) if (v.owner === item) { v.owner = prev; v.entry.status = 'ready'; delete v.entry.error; }
  };
  const cook = (item: Item) => {
    if (item.pending) return item.pending;
    const key = item.key, e = item.entry;
    item.pending = queue = queue.catch(() => {}).then(async () => {
      // Yield between outputs so navigation and metadata requests remain responsive.
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (closed || items.get(e.id) !== item) return;
      try {
        // a graph whose cooks the person stopped is not cooked again on its own: the card waits for a change
        if (!item.file && ws.held(e.graph!)) { unstop(item); return; }
        const r = item.file
          ? await ws.engine.cook({ nodes: { file: { type: 'file', params: { path: item.file } } }, output: 'file' })
          : await ws.cook(e.graph!, e.node, undefined, { kind: 'preview' });
        if (item.key !== key || items.get(e.id) !== item) return;
        // stopped for a newer value: the next refresh (after that value's cook) cooks the card again
        if (r.stopped && !ws.held(e.graph!)) { item.key = undefined; return; }
        if (r.stopped) { unstop(item, r.stopped); return; }
        if (!r.ok || !r.geo) throw new Error(r.errors.map((x) => `${x.node}: ${x.message}`).join('\n') || 'no geometry');
        delete item.prev;
        item.geo = r.geo;
        e.status = 'ready'; delete e.error; delete e.stale;
        // a saved file that says what it is already (a heightmap by its sidecar) keeps that
        const info = item.file && e.kind ? outputKind(r.geo) : describe(e, r.geo);
        if (item.file && !e.parts) e.parts = info.kind;
        const firstImage = referenceableImages(r.geo).values().next().value;
        if (info.kind === 'image' && firstImage) {
          item.img = firstImage; e.view = 'image'; e.width = firstImage.width; e.height = firstImage.height;
          e.layers = [...firstImage.layers.keys()]; e.layer = firstImage.mainLayer;
        } else if (!item.file) { e.view = 'model'; delete item.img; }
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
  /** How a saved file shows: an image, a model the file node reads, or a file to download. */
  const viewOf = (file: string): OutputEntry['view'] => (imageExt.test(file) ? 'image' : modelExt.test(file) && !/\.r16$/i.test(file) ? 'model' : 'file');
  /** A saved output: its files (the main one first, each sidecar with its role), how it shows and downloads. */
  const savedEntry = (a: Artifact, files: string[], id: string, revision: string): Item => {
    const role = new Map<string, SidecarRole>();
    for (const p of files) { const s = sidecarFile(p); if (s) role.set(p, s.role); }
    const main = files.find((p) => !role.has(p)) ?? files[0];
    const ordered = [main, ...files.filter((p) => p !== main)];
    const format = a.format ?? exportFormatFromPath(main);
    const heightmapSidecar = ordered.find((p) => role.get(p) === 'heightmap');
    const meta = role.has(main);
    const fileList = ordered.map((p) => {
      const r = role.get(p);
      return { id: artifactId(p), name: path.relative(path.dirname(main), p).split(path.sep).join('/'), size: fs.statSync(p, { throwIfNoEntry: false })?.size ?? 0,
        ...(r ? { role: r, about: `${SIDECAR_NAMES[r]}: ${SIDECAR_TEXT[r]}` } : {}) };
    });
    // the record of a glb / gltf is inside it: its download is the file itself (downloadFiles)
    const zip = downloadFiles(exportFormatFromPath(main), ordered.map((p) => ({ path: p })), `${main}.source.json`).length > 1;
    const label = targetFormat(format) ? FORMAT_LABELS[targetFormat(format)!] : path.extname(main).slice(1).toUpperCase() || 'file';
    return { file: main, files: ordered, entry: {
      id, origin: 'saved', label: a.label, graph: a.graph, node: a.node, status: 'ready', revision,
      view: meta ? 'file' : viewOf(main), ...(meta ? { kind: 'metadata' as const } : heightmapSidecar ? { kind: 'terrain' as const } : imageExt.test(main) ? { kind: 'textures' as const } : {}),
      about: meta ? `${SIDECAR_NAMES[role.get(main)!]}: ${SIDECAR_TEXT[role.get(main)!]}` : (heightmapSidecar && heightmapAbout(heightmapSidecar)) || `${label}${ordered.length > 1 ? ` · ${ordered.length} files` : ''}`,
      summary: a.format === 'reference' ? 'Reference image' : `Saved ${a.format ?? path.extname(main).slice(1)} output`,
      files: fileList,
      download: { name: zip ? `${path.basename(stripExtension(a.label.replace(/[\\/]+$/, ''))) || 'export'}.zip` : path.basename(main), zip },
    } };
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
    // the session values (a person tuning a graph file in the viewer) are part of what each output shows, and so are
    // the packages: an update, or a save in a working folder the session follows, changes what they resolve to
    const workspaceRevision = digest(JSON.stringify([...ws.graphs].map(([n, g]) => [n, g, ws.sessionVars(n)])) + inputStamp + JSON.stringify([...sourceFiles]) + (ws.packages?.revision() ?? ''));
    const records = store.records();
    // the packages shown live this session (their working folders): the results that use them hold unpublished edits
    const following = ws.packages instanceof ProjectPackages ? ws.packages.following().map((f) => f.package) : [];
    // the graph the page shows first cooks first: its cards are queued before the others'
    const first = opts.first?.();
    const graphs = [...ws.graphs].sort(([a], [b]) => Number(b === first) - Number(a === first));
    for (const [graph, spec] of graphs) {
      const live = following.length ? packagesNamedIn(spec).filter((x) => following.includes(x)) : [];
      for (const p of publishedOutputs(graph, spec, ws.engine.findOutput(spec).name)) {
        const id = idFor('graph', graph, p.output === null ? 'default' : 'named', p.output ?? 'main'); alive.add(id);
        const key = workspaceRevision, old = items.get(id);
        const named = p.output === null ? undefined : spec.outputs?.[p.output], pinned = named?.kind, tags = named?.tags;
        const meta = {
          label: p.label, output: p.output, default: p.default, target: p.target ? { format: p.target.format, path: p.target.path, options: p.target.options } : null,
          saved: lastSaved(records, graph, p), ...(pinned ? { pinned } : {}), ...(Array.isArray(tags) && tags.length ? { tags } : {}), ...(live.length ? { live } : {}),
        };
        // the same inputs, or a graph held after a stop (the card keeps what it shows until something changes)
        if (old?.key === key || (old && ws.held(graph))) {
          Object.assign(old.entry, meta);
          if (!meta.saved) delete old.entry.saved;
          if (!meta.tags) delete old.entry.tags;
          if (!meta.live) delete old.entry.live;
          continue;
        }
        // while it cooks again, the card keeps what it said (summary, kind, formats), so the details shown for it keep
        // their size; the card it replaces comes back if a person stops the cook
        const prev = old?.prev ?? (old?.entry.status === 'ready' ? old : undefined);
        const kept: Partial<OutputEntry> = {};
        if (old) for (const k of ['summary', 'kind', 'parts', 'about', 'size', 'heightfield', 'formats', 'width', 'height', 'layers', 'layer', 'warning'] as const) if (old.entry[k] !== undefined) (kept as any)[k] = old.entry[k];
        const item: Item = { geo: old?.geo, img: old?.img, key, prev, entry: { id, origin: 'published', graph, node: p.node, view: old?.entry.view ?? 'model', generated: true, exportable: true, status: 'loading', revision: key, ...kept, ...meta } };
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
      items.set(id, savedEntry(a, files, id, revision));
    }
    // A bundle's own files (not its sidecars) are individual inspectable outputs as well as downloads.
    for (const item of [...items.values()]) {
      if (!alive.has(item.entry.id) || item.entry.origin !== 'saved' || !item.files) continue;
      const parts = item.files.filter((p, i) => !item.entry.files?.[i]?.role);
      if (parts.length < 2) continue;
      for (const file of parts) {
        const stat = fs.statSync(file, { throwIfNoEntry: false }); if (!stat?.isFile()) continue;
        const id = item.entry.id + '-' + artifactId(file); alive.add(id);
        const revision = digest(stamp(file));
        if (items.get(id)?.entry.revision === revision) continue;
        items.set(id, { file, files: [file], entry: { id, origin: item.entry.origin, parent: item.entry.id, graph: item.entry.graph, label: path.basename(file),
          view: viewOf(file), ...(imageExt.test(file) ? {} : { about: path.extname(file).slice(1).toUpperCase() }), status: 'ready', revision,
          files: [{ id: artifactId(file), name: path.basename(file), size: stat.size }], download: { name: path.basename(file), zip: false } } });
      }
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
  /**
   * Cook now and serialize to the target (nothing is written yet): the export writes the current graph, whatever the
   * preview last showed, and its record names the time the cook ran at.
   */
  const prepare = async (graph: string, p: PublishedOutput & { target: ResolvedTarget }): Promise<PreparedTarget> => {
    const r = await ws.cook(graph, p.node, undefined, { kind: 'export' });
    if (r.stopped) err(409, `${p.label} (${graph}): the export was stopped at ${r.stopped}; nothing was written`);
    if (!r.ok || !r.geo) err(422, `${p.label} (${graph}): ` + (r.errors.map((e) => `${e.node}: ${e.message}`).join('; ') || 'no geometry'));
    return prepareTarget(r.geo!, graph, p, ws.exportDir, ws.engine.host, { frame: r.frame, fps: r.fps, packages: packagesUsed(ws.engine, p.spec) });
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
      const send = (body: Uint8Array | string, type: string, name?: string, extra: Record<string, string> = {}) => {
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...(name ? { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}` } : {}), ...extra }); res.end(body);
      };
      const json = (j: unknown) => send(JSON.stringify(j), 'application/json');
      const posts = ['/api/output/export', '/api/output/export-all', '/api/output/download'];
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
              // a graph from a file: the target goes into the file (only that key changes), the session values stay
              if (opts.source?.graph === graph) {
                const at = item.entry.output === null ? ['export'] : ['outputs', item.entry.output!, 'export'];
                try { opts.source.save([{ path: at, value: body.export ?? undefined }]); }
                catch (e) { err(500, `could not write ${opts.source.label}: ${(e as Error).message}`); }
              }
              if (body.export === null) { rescan(); changed(); json({ ok: true, cleared: true }); return true; }
            }
            const p = published(item.entry);
            if (!p.target) err(400, 'no export target yet: choose a format');
            const prepared = await prepare(graph, p as PublishedOutput & { target: ResolvedTarget });
            writeTargets([prepared], ws.exportDir);
            rescan(); changed();
            json({ ok: true, path: p.target.path, file: path.join(ws.exportDir, ...p.target.path.split('/')), files: prepared.files.length, summary: prepared.summary, warnings: prepared.warnings });
            return true;
          });
        }
        if (u.pathname === '/api/output/download') {
          // {id, export?}: the export (its target, or the format and options given) as a download; nothing is written
          const body = await readJSON(req), item = get(body?.id);
          if (!item.entry.exportable) err(400, 'only a published output downloads in a format of choice; a saved file downloads as it is');
          const p = published(item.entry), spec = body.export ?? (p.target ? { format: p.target.format, path: p.target.path, ...p.target.options } : null);
          if (!spec) err(400, 'choose a format to download');
          if (targetError(spec)) err(400, targetError(spec)!);
          const target = resolveTarget(spec, p.output ?? item.entry.graph!);
          const prepared = await prepare(item.entry.graph!, { ...p, target });
          const files = downloadFiles(target.format, prepared.files, prepared.sourceManifest);
          const extra = { 'x-file-count': String(files.length) };
          if (files.length === 1) { send(files[0].bytes, mime(files[0].path), path.basename(files[0].path), extra); return true; }
          const root = commonDir(files.map((f) => f.path));
          const zip = outputZip(files.map((f) => ({ name: path.relative(root, f.path).split(path.sep).join('/'), bytes: f.bytes })));
          send(zip, 'application/zip', `${path.basename(stripExtension(target.path.replace(/[\\/]+$/, ''))) || 'export'}.zip`, extra);
          return true;
        }
        if (u.pathname === '/api/output/export-all') {
          return await exclusive(async () => {
            const targets: { graph: string; p: PublishedOutput & { target: ResolvedTarget } }[] = [], skipped: { graph: string; label: string }[] = [];
            for (const [graph, spec] of ws.graphs) for (const p of publishedOutputs(graph, spec, ws.engine.findOutput(spec).name))
              if (p.target) targets.push({ graph, p: p as PublishedOutput & { target: ResolvedTarget } }); else skipped.push({ graph, label: p.label });
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
          const root = commonDir(item.files);
          send(outputZip(item.files.map((p) => ({ name: path.relative(root, p).split(path.sep).join('/'), bytes: fs.readFileSync(p) }))), 'application/zip', item.entry.download?.zip ? item.entry.download.name : item.entry.label + '.zip'); return true;
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
          if (item.entry.view === 'file') err(400, `${item.entry.label} is not geometry to show: download it`);
          const g = await geometry(item), thumb = u.pathname.endsWith('/thumb');
          // heightfields: the layer drawn in red (the page's layer picker; the mask by default)
          const tint = u.searchParams.get('heightfield_layer') || 'mask';
          const bytes = await cache(`${item.entry.id}:${item.entry.revision}:${thumb}:${thumb ? '' : tint}`, async () => {
            if (!thumb) return exportGeometryAsync(withImagePreview(withHeightfieldPreview(g, 256, tint)), 'glb', { custom: false, splitByName: false, readFile: (p) => ws.engine.host.readFile(p) });
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
