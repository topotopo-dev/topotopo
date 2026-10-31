// The web app server: a file explorer of the registered workspaces and libraries. The front page shows each as a
// card (a few pictures from inside, its packages, folders, files and flags; TopoTopo's built-in library last) and
// searches every package and output. Every folder below a workspace or library is a page (/w/<workspace>/<path…>/,
// /l/<library>/<path…>/, src/web/folder-page.ts): its flags, its package when it is one (preview, versions, outputs,
// who uses it, graphs, Open in editor, Re-bake), its notes, its subfolders as cards and its files by type, which the
// same addresses serve (read only, inside the folder, with ranges). A package keeps a stable address for boards,
// /p/<workspace or library>/<id>, which leads to its folder page, with its thumbnail and an iframe embed.
// It reads files and serves baked previews; it never cooks: bakes run in child processes (BakeQueue) and "Open in
// editor" starts a `topotopo edit` child. Bound to 127.0.0.1 on a fixed port (stable links); requests must name this
// server as their Host, and writes must come from its own pages.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encodePNG } from '../render/png.ts';
import { MIME, appDir, threeDir } from '../viewer/server.ts';
import { webDir, isStale, listFiles, placeNamed, readBakeState, scanAll } from './library.ts';
import { BUILTIN_LIBRARY, loadConfig } from '../config.ts';
import { readWorkspace, engineFile } from '../workspace.ts';
import { WORKSPACE_PACKAGES } from '../package.ts';
import type { WorkspaceManifest } from '../workspace.ts';
import { folderKey, forgetScans, forgetScansOf, scanTree, unscanned } from '../scan.ts';
import { engineTypeOf } from '../engines.ts';
import { graphFiles } from '../session.ts';
import type { BakeState, LibraryScan, Package } from './library.ts';
import type { WebConfig } from '../config.ts';
import { builtinLibrary, compareVersions, copyRecord, isDefaultOutput, publishedVersions, startsBigVersion, workingHash } from '../packages/registry.ts';
import type { VersionInfo } from '../packages/registry.ts';
import { BakeQueue } from './bake.ts';
import { embedPage, esc, frontPage, importMap, modelPage, shell, count } from './pages.ts';
import type { CardData, OutputRow, PackageData, RootCardData, Urls, UserRow } from './pages.ts';
import { folderPage } from './folder-page.ts';
import type { FileItem, FolderCard, FolderPageData, NoteBox } from './folder-page.ts';
import { PathError, byName, engineTitle, exportSources, exportStale, graphTypes, headingPrefix, kindOf, listFolder, noteHtml, noteId, plumbing, realBelow, resolveIn, rootKey, sendFile, walkTree } from './folders.ts';
import type { Flag, NoteEnv, NoteLinks, Root, Walk, WalkLimits } from './folders.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const assetDir = path.join(here, 'app');
const cli = path.resolve(here, '..', import.meta.url.endsWith('.ts') ? 'cli.ts' : 'cli.js');
const RESCAN_MS = 5 * 60_000;
const EDITOR_START_MS = 60_000;
/** a folder page shows this many notes as boxes (a README first, documents before text files); the rest are listed with its other files */
const MAX_NOTE_BOXES = 24;
/** TopoTopo's built-in library is read again for its page at most this often */
const BUILTIN_AUDIT_MS = 60_000;
/**
 * What the pages may load: their own files, and in notes the privacy players of YouTube and Vimeo, the only outside
 * content the web app shows (a note's link to an outside image stays a link).
 */
const PAGE_CSP = "default-src 'self'; img-src 'self' data:; media-src 'self'; frame-src 'self' https://www.youtube-nocookie.com https://player.vimeo.com; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'";
/**
 * What a 3D view may load (a model's page, a package's embed): its own files and what a model holds (data: and blob:
 * buffers and textures), three.js through the inline import map (allowed by its hash) and the meshopt decoder's
 * WebAssembly; a glTF's buffers or textures on another site are not fetched.
 */
const viewCsp = (map: string, framed: boolean) => `default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'sha256-${crypto.createHash('sha256').update(map).digest('base64')}'; img-src 'self' data: blob:; connect-src 'self' data: blob:; style-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'${framed ? '' : "; frame-ancestors 'self'"}`;
/** A note named so is shown first among the boxes of its folder. */
const README = /^(readme|index)\.(md|txt)$/i;

class HttpError extends Error {
  status: number;
  constructor(status: number, msg: string) { super(msg); this.status = status; }
}

export interface WebOptions {
  /** default: the config's web.port (7340); 0 picks a free port (tests) */
  port?: number;
  config?: WebConfig;
  /** bake packages whose previews are missing or stale (default true) */
  bake?: boolean;
  log?: (msg: string) => void;
  /** how far the audits walk (tests make them short) */
  walkLimits?: Partial<WalkLimits>;
}

export interface WebServer {
  url: string;
  port: number;
  /** read the libraries again (the server does so on file changes and every 5 minutes) */
  rescan: () => void;
  queue: BakeQueue;
  close: () => void;
}

/** A web app answers here already: its URL, or null. */
export async function runningWeb(port: number): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    const j: any = await res.json();
    return j?.web ? `http://127.0.0.1:${port}/` : null;
  } catch { return null; }
}

/** The engine project a workspace file names, read as written even when the file is otherwise refused. */
function engineWritten(ws: string): Root['engine'] {
  try {
    const e = JSON.parse(fs.readFileSync(path.join(ws, 'topotopo-workspace.json'), 'utf8'))?.engine;
    return e && (e.type === 'godot' || e.type === 'unreal') && typeof e.project === 'string' && e.project ? { type: e.type, file: path.resolve(ws, e.project) } : null;
  } catch { return null; }
}

const firstLine = (s: string | undefined) => { const l = (s ?? '').trim().split('\n')[0] ?? ''; return l.length > 240 ? `${l.slice(0, 240)}…` : l; };

export async function startWeb(o: WebOptions = {}): Promise<WebServer> {
  const cfg = o.config ?? loadConfig();
  const log = o.log ?? (() => {});
  const bakeOn = o.bake ?? true;
  let base = '';

  // ---------------------------------------------------------------- workspaces and libraries
  let scans: LibraryScan[] = [];
  const packages = new Map<string, Package>();
  /** the packages by folder (folderKey) */
  const byDir = new Map<string, Package>();
  const keyOf = (p: Package) => `${p.lib}/${p.id}`;
  /** one of TopoTopo's own packages: never baked or edited here */
  const isBuiltin = (p: Package) => p.lib === BUILTIN_LIBRARY.name;
  /**
   * The built-in library's packages, by folder: where their graphs are read (the working folder in TopoTopo's
   * repository, else the newest version) and the output whose thumbnail stands for each.
   */
  const builtinAt = new Map<string, { from: string; thumb: string | null }>();
  /** TopoTopo's built-in library as a library: its packages' manifests from their working folders or newest versions */
  const scanBuiltin = (): LibraryScan => {
    builtinAt.clear();
    const list = builtinLibrary();
    for (const b of list) {
      const newest = b.versions.at(-1);
      const thumb = newest ? Object.keys(newest.outputs).find((x) => fs.existsSync(path.join(b.dir, 'thumbs', `${x}.png`))) ?? null : null;
      builtinAt.set(b.dir, { from: b.from, thumb });
    }
    return {
      name: BUILTIN_LIBRARY.name, root: BUILTIN_LIBRARY.path, problems: [], workspaces: [],
      packages: list.map((b) => ({ lib: BUILTIN_LIBRARY.name, id: b.id, dir: b.dir, rel: b.id, collection: '', manifest: b.manifest, updated: Date.parse(b.versions.at(-1)?.published ?? '') || 0 })),
    };
  };
  /** the registered workspaces: their file (or what is wrong with it), engine project and scan */
  let games: { name: string; dir: string; m: WorkspaceManifest | null; problem?: string; engine: Root['engine']; scan: LibraryScan }[] = [];
  /** every registered workspace and library as a tree of pages, TopoTopo's built-in library last */
  let roots: Root[] = [];
  const indexPackages = () => {
    packages.clear();
    byDir.clear();
    // a package's address is its library's or workspace's name and its id: the first folder of an id keeps it (the scan says so)
    for (const s of scans) for (const p of s.packages) {
      if (!packages.has(keyOf(p))) packages.set(keyOf(p), p);
      if (!byDir.has(folderKey(p.dir))) byDir.set(folderKey(p.dir), p);
    }
  };
  /**
   * Read the packages of the workspaces and libraries again: those of `roots` (their folders), else all of them. The
   * audits stay: what changed decides which go (forget()).
   */
  const rescanPackages = (changed?: string[]) => {
    if (changed) for (const d of changed) forgetScansOf(d);
    else forgetScans();
    // the libraries (but those inside a registered workspace) and the workspaces; TopoTopo's built-in library last,
    // read again each time: a built-in package published while the web app runs shows
    const all = scanAll(cfg);
    games = [];
    for (const [i, s] of all.entries()) {
      if (!s.workspace) continue;
      try {
        const m = readWorkspace(s.root), e = engineFile(s.root, m);
        games.push({ name: m.name, dir: s.root, m, engine: e && m.engine && m.engine !== 'none' ? { type: m.engine.type, file: e } : null, scan: s });
      } catch (err: any) {
        // the workspace file cannot be read: its folder pages still show its folders and packages (scanned with the
        // engine project the file names), and the problem as a flag on it
        const engine = engineWritten(s.root);
        const t = scanTree(s.name, s.root, { engine: engine?.file ?? null });
        all[i] = { ...t, problems: t.problems, workspace: true };
        games.push({ name: s.name, dir: s.root, m: null, problem: err.message, engine, scan: all[i] });
      }
    }
    scans = [...all, scanBuiltin()];
    indexPackages();
    roots = [
      ...games.map((g): Root => ({ kind: 'w', name: g.name, dir: g.dir, engine: g.engine })),
      ...scans.filter((s) => !s.workspace && s.name !== BUILTIN_LIBRARY.name).map((s): Root => ({ kind: 'l', name: s.name, dir: s.root, engine: null })),
      { kind: 'l', name: BUILTIN_LIBRARY.name, dir: BUILTIN_LIBRARY.path, engine: null, builtin: true },
    ];
  };
  /** The libraries' scans: a workspace's packages are its own. */
  const libraryScans = () => scans.filter((s) => !s.workspace);
  /** Read TopoTopo's built-in library again (a few small files), the other libraries as they were scanned. */
  const refreshBuiltin = () => {
    const b = scanBuiltin();
    scans = [...scans.filter((s) => s.name !== BUILTIN_LIBRARY.name), b];
    indexPackages();
  };
  /** when the packages were last read again for an address none has (a board may keep asking for a removed one) */
  let missRescan = 0;
  const find = (lib: string, id: string) => {
    let p = packages.get(`${lib}/${id}`);
    // made a moment ago, before the watch noticed: read the packages again, at most every few seconds
    if (!p && Date.now() - missRescan > 3000) { missRescan = Date.now(); rescanPackages(); p = packages.get(`${lib}/${id}`); }
    if (!p) throw new HttpError(404, `no package "${id}" in library "${lib}"`);
    return p;
  };
  /** The workspace or library a package's folder page is in (workspaces and libraries share one set of names). */
  const rootOf = (p: Package): Root => roots.find((r) => (isBuiltin(p) ? r.builtin : !r.builtin && r.name === p.lib)) ?? roots[roots.length - 1];
  /** A workspace's uses: the version of each package its packages share (its copy's record), the package's page, a newer version. */
  const workspaceUses = (r: Root): PackageData['uses'] => {
    const g = r.kind === 'w' ? games.find((x) => x.name === r.name) : undefined;
    if (!g?.m) return [];
    const homes = packageHomes();
    return Object.entries(g.m.uses).map(([name, v]) => {
      let rec: { note?: string; published?: string } | null = null;
      try { rec = JSON.parse(fs.readFileSync(path.join(g.dir, WORKSPACE_PACKAGES, ...name.split('/'), v, 'version.json'), 'utf8')); } catch { /* no copy yet */ }
      const home = homes.get(name), newest = newestOf(name, homes);
      return { name, version: v, ...(rec ? { note: String(rec.note ?? ''), published: String(rec.published ?? '') } : {}), ...(home ? { url: pageOf(home) } : {}), ...(newest && compareVersions(newest, v) > 0 ? { newest } : {}) };
    });
  };
  const within = (inner: string, outer: string) => { const x = path.relative(path.resolve(outer), path.resolve(inner)); return !x.startsWith('..') && !path.isAbsolute(x); };

  // ---------------------------------------------------------------- events (SSE) and bakes
  const clients = new Set<http.ServerResponse>();
  const broadcast = (ev: object) => { const m = `data: ${JSON.stringify(ev)}\n\n`; for (const c of clients) c.write(m); };
  const queue = new BakeQueue({
    log,
    onDone: (dir, state) => {
      const p = byDir.get(folderKey(dir));
      if (p) { forget(rootKey(rootOf(p))); rewarm(); }
      if (p) broadcast({ package: keyOf(p), ok: state?.ok ?? false, version: state?.at ?? 0 });
    },
  });
  /**
   * A package's graphs (graphs/, and graph files beside its manifest; a built-in package's where it is read from), and
   * whether it has the one its manifest shows.
   */
  const graphsOf = (p: Package) => graphFiles(builtinAt.get(p.dir)?.from ?? p.dir);
  const hasDefault = (p: Package) => graphsOf(p).has(p.manifest.bake.graph ?? p.manifest.graph);
  const bakeIfStale = (p: Package) => {
    // nothing to bake before the package has its default graph: its card says so ("no default graph yet"); TopoTopo's
    // own packages are never baked here
    if (!bakeOn || isBuiltin(p) || queue.pending(p.dir) || !hasDefault(p)) return;
    try { if (isStale(p) && queue.add(p.dir)) broadcast({ package: keyOf(p), baking: true }); } catch { /* removed meanwhile */ }
  };
  // the audits: each tree's walk and flags, made when a page asks and forgotten when something in that tree changes;
  // made again soon after (rewarm), so that a page seldom waits for one. A walk gives the event loop a turn every few
  // milliseconds: pages, files and the event stream keep answering while a large tree is audited
  type Audit = { walk: Walk; flags: Flag[]; at: number };
  const audits = new Map<string, Audit>();
  /** the audits under way, and each tree's count of changes (an audit begun before a change is not kept) */
  const auditing = new Map<string, { gen: number; made: Promise<Audit> }>();
  const changes = new Map<string, number>();
  /** the links of the notes the walks read, by file: a walk again reads only the notes that changed */
  const noteLinks: NoteLinks = new Map();
  const forget = (key: string) => { audits.delete(key); changes.set(key, (changes.get(key) ?? 0) + 1); };
  const forgetAll = () => { for (const r of roots) forget(rootKey(r)); };
  let warm: ReturnType<typeof setTimeout> | undefined, closed = false;
  const rewarm = () => {
    clearTimeout(warm);
    warm = setTimeout(async () => { for (const r of roots) { if (closed) return; try { await auditOf(r); } catch { /* its page says it */ } } }, 200);
    warm.unref();
  };
  const rescan = () => { rescanPackages(); forgetAll(); };
  rescan();
  for (const p of packages.values()) bakeIfStale(p);

  // A change below a library: a manifest, graphs/, assets/ and inputs/ may need a bake; anything else may be a
  // package made, moved or removed, or attachments: read that tree's packages again, forget its audit unless the change
  // is one no audit sees (plumbing, an engine project's own files outside packages), and tell the pages.
  const touched = new Set<string>();
  const changedFolders = new Set<string>();
  const changedRoots = new Set<string>();
  const staleAudits = new Set<string>();
  let changeTimer: ReturnType<typeof setTimeout> | undefined;
  const onChange = () => {
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      const before = [...packages.keys()].join('\n');
      rescanPackages([...changedRoots]);
      for (const k of staleAudits) forget(k);
      for (const k of touched) { const p = packages.get(k); if (p) bakeIfStale(p); }
      for (const p of packages.values()) if (!readBakeState(p.dir)) bakeIfStale(p);
      broadcast({ changed: [...touched], list: before !== [...packages.keys()].join('\n'), folders: [...changedFolders] });
      rewarm();
      touched.clear();
      changedFolders.clear();
      changedRoots.clear();
      staleAudits.clear();
    }, 500);
  };
  const watchers: fs.FSWatcher[] = [];
  for (const s of scans) {
    if (s.name === BUILTIN_LIBRARY.name) continue; // nothing of it is baked here: read again at each rescan
    try {
      const w = fs.watch(s.root, { recursive: true }, (_ev, f) => {
        const rel = f ? String(f).split(path.sep).join('/') : '';
        if (path.isAbsolute(rel)) return; // the root itself went away: the periodic rescan notices
        const parts = rel.split('/');
        if (parts.some((x) => x.startsWith('.') || x === 'node_modules')) return; // .web/, .cache/, .part files
        const p = scans.find((x) => x.root === s.root)?.packages.find((x) => rel === x.rel || rel.startsWith(x.rel + '/'));
        if (p) touched.add(keyOf(p));
        changedRoots.add(s.root);
        for (const r of roots) {
          if (r.dir !== s.root) continue;
          changedFolders.add(`${rootKey(r)}/${parts.slice(0, -1).join('/')}`.replace(/\/$/, ''));
          // plumbing, and an engine project's own files (outside packages), are in no audit
          const engine = audits.get(rootKey(r))?.walk.engines.some((e) => rel === e || rel.startsWith(e + '/'));
          if (p || !(engine || parts.slice(0, -1).some((x) => plumbing(x, [])))) staleAudits.add(rootKey(r));
        }
        onChange();
      });
      w.on('error', () => w.close());
      w.unref();
      watchers.push(w);
    } catch { /* no folder (a problem on the page) or no recursive watch: the periodic rescan covers it */ }
  }
  const periodic = setInterval(() => { rescan(); for (const p of packages.values()) bakeIfStale(p); rewarm(); }, RESCAN_MS);
  periodic.unref();

  // ---------------------------------------------------------------- editors
  const editors = new Map<string, { child: ChildProcess; url: Promise<string> }>();
  const editorFor = (p: Package) => {
    const have = editors.get(p.dir);
    if (have && have.child.exitCode === null) return have.url;
    const child = spawn(process.execPath, [cli, 'edit', p.dir, '--json'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const url = new Promise<string>((resolve, reject) => {
      let out = '', err = '';
      const t = setTimeout(() => { child.kill(); reject(new Error('the editor did not start within a minute')); }, EDITOR_START_MS);
      child.stdout!.on('data', (d) => {
        out += d;
        const line = out.split('\n').find((l) => l.startsWith('{'));
        if (line) { clearTimeout(t); try { resolve(JSON.parse(line).url); } catch (e) { reject(e); } }
      });
      child.stderr!.on('data', (d) => { if (err.length < 4000) err += d; });
      child.on('exit', (code) => { clearTimeout(t); editors.delete(p.dir); reject(new Error(`the editor stopped (exit ${code}): ${err.trim().split('\n').slice(-3).join(' ')}`)); });
    });
    url.catch(() => {});
    editors.set(p.dir, { child, url });
    return url;
  };

  const reveal = (dir: string) => {
    const [cmd, args] = process.platform === 'win32' ? ['explorer.exe', [dir]] : process.platform === 'darwin' ? ['open', [dir]] : ['xdg-open', [dir]];
    const c = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false });
    c.on('error', () => {});
    c.unref();
  };

  // ---------------------------------------------------------------- URLs
  const enc = encodeURIComponent;
  const relPath = (rel: string) => rel.split('/').filter(Boolean).map(enc).join('/');
  const urls: Urls = {
    home: '/',
    package: (lib, id) => `/p/${enc(lib)}/${enc(id)}`,
    thumb: (lib, id, v) => `/p/${enc(lib)}/${enc(id)}/thumb.png${v ? `?v=${enc(String(v))}` : ''}`,
    glb: (lib, id, v) => `/p/${enc(lib)}/${enc(id)}/preview.glb${v ? `?v=${enc(String(v))}` : ''}`,
    embed: (lib, id) => `/embed/${enc(lib)}/${enc(id)}`,
    file: (lib, id, rel) => `/p/${enc(lib)}/${enc(id)}/files/${relPath(rel)}`,
    // TopoTopo's own packages are edited in TopoTopo's repository, not from here
    edit: (lib, id) => (lib === BUILTIN_LIBRARY.name ? null : `/p/${enc(lib)}/${enc(id)}/edit`),
    folder: (kind, name, rel) => `/${kind}/${enc(name)}/${rel ? `${relPath(rel)}/` : ''}`,
    raw: (kind, name, rel) => `/${kind}/${enc(name)}/${relPath(rel)}`,
    model: (kind, name, rel) => `/model/${kind}/${enc(name)}/${relPath(rel)}`,
    asset: (name) => `/static/${name}`,
    app: (name) => `/app/${name}`,
    three: '/vendor/three/',
  };
  /** A package's folder page. */
  const pageOf = (p: Package) => { const r = rootOf(p); return urls.folder(r.kind, r.name, p.rel); };

  // ---------------------------------------------------------------- page data
  /** A package's thumbnail of one of its outputs (thumbs/<output>.png, which TopoTopo's built-in packages keep). */
  const outputThumb = (p: Package, output: string) => (fs.existsSync(path.join(p.dir, 'thumbs', `${output}.png`)) ? `/p/${enc(p.lib)}/${enc(p.id)}/thumbs/${enc(output)}.png` : undefined);
  /** A package's preview as a picture, when it has one: its baked thumbnail, a built-in package's first output's. */
  const previewOf = (p: Package) => {
    if (isBuiltin(p)) { const v = publishedVersions(p.dir, p.manifest.name ?? '').at(-1)?.version; return builtinAt.get(p.dir)?.thumb ? urls.thumb(p.lib, p.id, v) : undefined; }
    const s = readBakeState(p.dir);
    return fs.existsSync(path.join(webDir(p.dir), 'thumb.png')) ? urls.thumb(p.lib, p.id, s?.at ?? 0) : undefined;
  };
  /** The newest version of a package the web app knows of: its home's, in a library or TopoTopo's built-in one. */
  const newestOf = (name: string, homes = packageHomes()) => {
    const home = homes.get(name);
    return home ? publishedVersions(home.dir, name).at(-1)?.version : undefined;
  };
  /** The packages of the libraries and the workspaces that use a package, with the version each uses. */
  const usersOf = (name: string): UserRow[] => [
    ...[...packages.values()].filter((p) => p.manifest.uses[name])
      .map((p) => ({ lib: p.lib, id: p.id, title: p.manifest.title, version: p.manifest.uses[name], url: pageOf(p) })),
    ...games.filter((g) => g.m?.uses[name]).map((g) => ({ lib: 'workspace', id: g.name, title: `workspace ${g.name}`, version: g.m!.uses[name], url: urls.folder('w', g.name, '') })),
  ].sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
  const status = (p: Package, s: BakeState | null) => (isBuiltin(p) ? 'ok' : !hasDefault(p) ? 'empty' : queue.pending(p.dir) ? 'baking' : !s ? 'new' : s.ok ? 'ok' : 'failed');
  const cardOf = (p: Package): CardData => {
    const s = readBakeState(p.dir);
    const m = p.manifest;
    // a package: its full name, its newest version and its outputs (its published versions' records)
    const newest = m.name ? publishedVersions(p.dir, m.name).at(-1) : undefined;
    const pkg = m.name ? { name: m.name, version: newest?.version ?? null } : undefined;
    const outputs = m.name && newest ? outputsOf(m.name, newest).map((x) => ({ type: x.type, ...(x.alias ? { alias: x.alias } : {}), label: x.label, ...(x.kind ? { kind: x.kind } : {}), tags: x.tags })) : undefined;
    // the packages it uses, and those of them with a newer version: the card says so
    const uses = Object.keys(m.uses);
    const updates = uses.flatMap((name) => { const n = newestOf(name); return n && compareVersions(n, m.uses[name]) > 0 ? [{ name, version: m.uses[name], newest: n }] : []; });
    // a built-in package's thumbnail changes with its versions, a package's with its bakes
    const version = isBuiltin(p) ? newest?.version ?? '0' : String(s?.at ?? 0);
    return {
      lib: p.lib, id: p.id, title: m.title, collection: p.collection, tags: m.tags, description: m.description, updated: p.updated, status: status(p, s), version, url: pageOf(p),
      ...(pkg ? { pkg } : {}), ...(outputs ? { outputs } : {}), ...(uses.length ? { usesPackages: uses } : {}), ...(updates.length ? { updates } : {}),
    };
  };
  /** The packages that publish versions, by full name: the first library's when two hold one, TopoTopo's own among them. */
  const packageHomes = () => {
    const homes = new Map<string, Package>();
    for (const p of packages.values()) if (p.manifest.name && !homes.has(p.manifest.name)) homes.set(p.manifest.name, p);
    return homes;
  };
  /**
   * A version's published outputs, each by the node type a graph names it with ("owner/name" alone is the default),
   * with the thumbnail the package `p` keeps of it, if any.
   */
  const outputsOf = (name: string, v: VersionInfo, p?: Package): OutputRow[] => {
    const isDefault = (x: { graph: string; node: string }) => isDefaultOutput(v, x);
    const row = (type: string, x: VersionInfo['default'], dflt: boolean, output?: string): OutputRow => {
      const thumb = p && output ? outputThumb(p, output) : undefined;
      return {
        type, ...(dflt ? { alias: name } : {}), label: x.label ?? '', ...(x.kind ? { kind: x.kind } : {}), tags: x.tags ?? [],
        graph: x.graph, node: x.node, params: Object.keys(x.sliders), inputs: x.inputs.map((i) => i.label || `input ${i.index}`), ...(thumb ? { thumb } : {}),
      };
    };
    const rows = Object.entries(v.outputs).map(([k, x]) => row(`${name}/${k}`, x, isDefault(x), k));
    // a default output that is no named output is listed by the package's name alone
    if (!Object.values(v.outputs).some(isDefault)) rows.unshift(row(name, v.default, false));
    return rows;
  };
  /** The exports of a package older than the graph they were made from, by path below exports/. */
  const staleExports = (p: Package) => {
    const graphs = graphsOf(p), out = new Set<string>();
    for (const e of exportSources(p.dir)) { const f = graphs.get(e.made.graph); if (f && exportStale(f, e.made)) out.add(e.rel); }
    return out;
  };
  const packageData = (p: Package): PackageData => {
    const builtin = isBuiltin(p), s = builtin ? null : readBakeState(p.dir);
    const graphs = [...graphsOf(p)].map(([name, file]) => {
      let g: any = {};
      try { g = JSON.parse(fs.readFileSync(file, 'utf8')) ?? {}; } catch { /* unreadable: listed without nodes */ }
      const meta = g.params ?? {};
      return {
        name, nodes: Object.keys(g.nodes ?? {}).length,
        vars: Object.entries(g.vars ?? {}).map(([k, v]) => ({ name: k, value: v, desc: meta[k]?.desc ?? meta[k]?.label, min: meta[k]?.min, max: meta[k]?.max })),
      };
    });
    const abs = (u: string) => base + u;
    const m = p.manifest, homes = packageHomes(), r = rootOf(p);
    const versions = m.name ? publishedVersions(p.dir, m.name) : [];
    // the packages it uses: the version in use (its copy's record), its home's page and the newest version there
    const uses = Object.entries(m.uses).map(([name, v]) => {
      const rec = copyRecord(p.dir, name, v), home = homes.get(name), newest = newestOf(name, homes);
      return { name, version: v, ...(rec ? { note: rec.note, published: rec.published } : {}), ...(home ? { url: pageOf(home) } : {}), ...(newest && compareVersions(newest, v) > 0 ? { newest } : {}) };
    });
    const at = (sub: string, f: string) => urls.raw(r.kind, r.name, `${p.rel}/${sub}/${f}`);
    const model = (sub: string, f: string) => (/\.(glb|gltf)$/i.test(f) ? { model: urls.model(r.kind, r.name, `${p.rel}/${sub}/${f}`) } : {});
    const stale = builtin ? new Set<string>() : staleExports(p);
    return {
      ...cardOf(p), builtin, rel: p.rel, place: games.some((g) => g.scan.packages.includes(p)) ? `in the workspace "${p.lib}"` : builtin ? 'in TopoTopo\'s built-in library' : `in library "${p.lib}"`, links: m.links, graph: m.bake.graph ?? m.graph, graphs, created: m.created,
      attachments: builtin ? [] : listFiles(path.join(p.dir, 'attachments')).map((f) => ({ ...f, url: at('attachments', f.path), ...model('attachments', f.path) })),
      exports: builtin ? [] : listFiles(path.join(p.dir, 'exports')).filter((f) => !/\.json$/i.test(f.path) || !/(^|\/)(source|landscape)\.json$|\.(source|meshes)\.json$/i.test(f.path)).map((f) => ({ ...f, url: at('exports', f.path), ...model('exports', f.path), ...(stale.has(f.path) ? { stale: true } : {}) })),
      glb: !builtin && fs.existsSync(path.join(webDir(p.dir), 'preview.glb')), thumb: !!previewOf(p), bake: s,
      share: { link: abs(urls.package(p.lib, p.id)), thumb: abs(urls.thumb(p.lib, p.id)), embed: abs(urls.embed(p.lib, p.id)) },
      package: m.name ? {
        name: m.name,
        versions: [...versions].reverse().map((v) => ({ version: v.version, note: v.note, published: v.published, big: startsBigVersion(v.version), marked: v.big, outputs: outputsOf(m.name!, v) })),
        outputs: versions.length ? outputsOf(m.name, versions.at(-1)!, p) : [],
        usedBy: usersOf(m.name),
      } : null,
      uses,
    };
  };
  const listJSON = () => [...packages.values()].map((p) => {
    const c = cardOf(p);
    return {
      lib: p.lib, id: p.id, title: c.title, description: c.description, tags: c.tags, collection: c.collection, updated: p.updated, status: c.status,
      url: base + urls.package(p.lib, p.id), thumb: base + urls.thumb(p.lib, p.id, c.version), embed: base + urls.embed(p.lib, p.id),
      ...(c.pkg ? { package: c.pkg } : {}),
    };
  });

  // ---------------------------------------------------------------- flags
  /** The packages of a workspace or library: those its scan found (TopoTopo's built-in ones are not audited). */
  const packagesOf = (r: Root): Package[] => (r.builtin ? [] : scans.find((s) => s.root === r.dir && s.name === r.name)?.packages ?? []);
  /**
   * What is wrong with a package that TopoTopo can tell from its files: its preview did not cook; it publishes versions
   * and has none, or changes no version holds; an export older than its graph; published outputs that no other package
   * of the workspace uses (`used`: node type → the folders of the packages whose graphs use it; null outside a workspace).
   */
  const packageFlags = (p: Package, used: Map<string, Set<string>> | null): Flag[] => {
    const out: Flag[] = [], at = p.rel, m = p.manifest;
    const s = readBakeState(p.dir);
    if (s && !s.ok && hasDefault(p) && !queue.pending(p.dir)) out.push({ kind: 'bake', at, what: `The preview of ${m.title} did not cook: ${firstLine(s.error) || 'no reason given'}`, todo: 'Open it in the editor to see why; it bakes again when the graph is saved, or press Re-bake' });
    if (m.name) {
      const versions = publishedVersions(p.dir, m.name), last = versions.at(-1);
      if (!last) out.push({ kind: 'publish', at, what: `${m.name} publishes versions and has none yet`, todo: 'Publish the first: topotopo publish --note "…" in its folder, or ask your agent' });
      else {
        let changed = false;
        try { changed = workingHash(p.dir) !== last.hash; } catch { /* unreadable files: topotopo check says why */ }
        if (changed) out.push({ kind: 'publish', at, what: `${m.name} has changes that no version holds (the newest is ${last.version})`, todo: 'Publish them as a new version: topotopo publish --note "…" in its folder, or ask your agent' });
        if (used) {
          const rows = outputsOf(m.name, last);
          const usedHere = (t: string) => [...(used.get(t) ?? [])].some((d) => d !== folderKey(p.dir));
          const unused = rows.filter((x) => !usedHere(x.type) && !(x.alias && usedHere(x.alias))).map((x) => x.type.slice(m.name!.length + 1) || x.type);
          if (unused.length) {
            const all = unused.length === rows.length;
            out.push({
              kind: 'unused', at,
              what: `No package in this workspace uses ${all ? (rows.length === 1 ? 'the output' : `any of the ${rows.length} outputs`) : `${unused.length} of the ${rows.length} outputs`} ${m.name} ${last.version} publishes: ${unused.slice(0, 12).join(', ')}${unused.length > 12 ? ` and ${unused.length - 12} more` : ''}`,
              todo: 'If the game does not use their exports either, drop them from the graph\'s outputs before the next version',
            });
          }
        }
      }
    }
    for (const e of staleExports(p)) out.push({ kind: 'export', at, what: `exports/${e} was made from an older version of its graph`, todo: 'Export it again: the Export button in the editor, or ask your agent' });
    return out;
  };
  /**
   * A tree's audit: its walk (counts, images, broken links in notes) and its packages' flags, kept until it changes;
   * one at a time per tree (pages that ask meanwhile wait for the same one).
   */
  const auditOf = (r: Root): Promise<Audit> => {
    const key = rootKey(r), have = audits.get(key);
    if (have && (!r.builtin || Date.now() - have.at < BUILTIN_AUDIT_MS)) return Promise.resolve(have);
    // one under way since the last change serves; one begun before it does not (its walk may have missed the change)
    const gen = changes.get(key) ?? 0, going = auditing.get(key);
    if (going && going.gen === gen) return going.made;
    const made = auditNow(r).then((a) => { if ((changes.get(key) ?? 0) === gen) audits.set(key, a); return a; })
      .finally(() => { if (auditing.get(key)?.made === made) auditing.delete(key); });
    auditing.set(key, { gen, made });
    return made;
  };
  const auditNow = async (r: Root): Promise<Audit> => {
    if (noteLinks.size > 100_000) noteLinks.clear();
    const walk = await walkTree(r, { links: noteLinks, slice: 8, limits: o.walkLimits });
    const flags: Flag[] = [];
    const g = r.kind === 'w' ? games.find((x) => x.name === r.name) : undefined;
    if (g?.problem) flags.push({ kind: 'workspace', at: '', what: `topotopo-workspace.json cannot be read: ${g.problem.replace(/^.*?topotopo-workspace\.json: /, '')}`, todo: 'Fix the file as this says: until then TopoTopo cannot use the workspace (its folders still show here)' });
    for (const prob of scans.find((s) => s.root === r.dir && s.name === r.name)?.problems ?? []) if (!g?.problem || !prob.includes(g.problem)) flags.push({ kind: 'workspace', at: '', what: prob, todo: 'Fix it in the folder it names: until then that package is not found' });
    const pk = packagesOf(r);
    let used: Map<string, Set<string>> | null = null;
    if (r.kind === 'w') {
      used = new Map();
      for (const q of pk) for (const f of graphsOf(q).values()) for (const t of graphTypes(f)) { if (!used.has(t)) used.set(t, new Set()); used.get(t)!.add(folderKey(q.dir)); }
    }
    for (const p of pk) { flags.push(...packageFlags(p, used)); await new Promise<void>((res) => setImmediate(res)); }
    walk.flags.forEach((f) => flags.push(f));
    // an engine project below the root is browsable, never audited
    const inEngine = (at: string) => walk.engines.some((e) => at === e || at.startsWith(e + '/'));
    return { walk, flags: flags.filter((f) => !inEngine(f.at)), at: Date.now() };
  };
  const under = (rel: string, at: string) => !rel || at === rel || at.startsWith(rel + '/');
  /** A tree's flags as they are now: a preview that did not cook is no flag while it bakes again. */
  const flagsNow = (r: Root, a: Audit) => a.flags.filter((x) => x.kind !== 'bake' || !queue.pending(byDir.get(folderKey(path.join(r.dir, ...x.at.split('/'))))?.dir ?? ''));

  // ---------------------------------------------------------------- folder pages
  const rootLabel = (r: Root) => (r.builtin ? 'TopoTopo\'s built-in library' : r.kind === 'w' ? 'Workspace' : 'Library');
  const engineLabel = (r: Root) => (r.engine ? `${r.engine.type === 'godot' ? 'Godot' : 'Unreal'} · ${engineTitle(r.engine.file)}` : undefined);
  /**
   * A folder's picture: its package's preview, else its first image, else a picture from a package or a shown folder
   * in it (never from plumbing, which is not served).
   */
  const pictureOf = (r: Root, rel: string, abs: string, first?: string): string | undefined => {
    const p = byDir.get(folderKey(abs));
    const own = p ? previewOf(p) : undefined;
    if (own) return own;
    if (first) return urls.raw(r.kind, r.name, first);
    for (const q of packagesOf(r)) if (q.rel.startsWith(rel + '/')) { const t = previewOf(q); if (t) return t; }
    // an image one folder down
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { /* none */ }
    const files = entries.filter((e) => e.isFile()).map((e) => e.name);
    const subs = entries.filter((e) => e.isDirectory() && !plumbing(e.name, files)).sort((a, b) => byName(a.name, b.name)).slice(0, 12);
    for (const s of subs) {
      let names: string[] = [];
      try { names = fs.readdirSync(path.join(abs, s.name)).sort(byName); } catch { continue; }
      const img = names.find((n) => /\.(png|jpe?g|webp|gif|avif)$/i.test(n) && !n.startsWith('.'));
      if (img) return urls.raw(r.kind, r.name, rel ? `${rel}/${s.name}/${img}` : `${s.name}/${img}`);
    }
    return undefined;
  };
  /** Where a note's box is: on this page (`here`: the folder shown and the notes boxed on it), else on its folder's page, which then shows it. */
  const noteUrlOf = (r: Root, here: { rel: string; boxed: Set<string> } | null) => (rel: string, anchor: string) => {
    const at = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '', name = rel.slice(rel.lastIndexOf('/') + 1);
    if (here && here.rel === at && here.boxed.has(name)) return `#${anchor}`;
    return `${urls.folder(r.kind, r.name, at)}?note=${enc(name)}#${anchor}`;
  };
  const noteEnv = (r: Root, here: { rel: string; boxed: Set<string> } | null = null): NoteEnv => ({
    root: r,
    folderUrl: (rel) => urls.folder(r.kind, r.name, rel),
    fileUrl: (rel) => urls.raw(r.kind, r.name, rel),
    modelUrl: (rel) => urls.model(r.kind, r.name, rel),
    noteUrl: noteUrlOf(r, here),
    card: (rel, abs) => {
      const p = byDir.get(folderKey(abs));
      if (p) return { title: p.manifest.title, sub: p.manifest.name ? `package ${p.manifest.name}` : 'package', thumb: pictureOf(r, rel, abs) };
      const l = listFolder(abs, rel, r.dir);
      const image = l.files.find((f) => f.kind === 'image')?.rel;
      let project: string | undefined;
      try { project = fs.readdirSync(abs).find((f) => engineTypeOf(f)); } catch { /* unreadable */ }
      // an engine project: its own picture only (what lies below it is the engine's)
      if (project) return { title: engineTitle(path.join(abs, project)), sub: `${engineTypeOf(project) === 'godot' ? 'Godot' : 'Unreal'} project`, ...(image ? { thumb: urls.raw(r.kind, r.name, image) } : {}) };
      return { title: rel ? rel.split('/').pop()! : r.name, sub: [count(l.folders.length, 'folder'), count(l.files.length + l.notes.length, 'file')].join(' · '), thumb: pictureOf(r, rel, abs, image) };
    },
  });
  /** A folder's notes in the order of their boxes: a README (or index) first, then documents (.md), then text files, each by name. */
  const noteOrder = (a: { name: string }, b: { name: string }) => {
    const rank = (n: string) => (README.test(n) ? 0 : /\.md$/i.test(n) ? 1 : 2);
    return rank(a.name) - rank(b.name) || byName(a.name, b.name);
  };
  const folderData = async (r: Root, rel: string, abs: string, askedNote: string | null = null): Promise<FolderPageData> => {
    const listing = listFolder(abs, rel, r.dir);
    const audit = await auditOf(r);
    const engines = audit.walk.engines;
    const engineAt = engines.find((e) => rel === e || rel.startsWith(e + '/'));
    const p = listing.topo.length ? byDir.get(folderKey(abs)) ?? null : null;
    const name = rel ? rel.split('/').pop()! : r.name;
    const crumbs = [{ name: r.name, url: urls.folder(r.kind, r.name, '') }, ...rel.split('/').filter(Boolean).map((s, i, a) => ({ name: s, url: urls.folder(r.kind, r.name, a.slice(0, i + 1).join('/')) }))];
    // a .topo here that is none of the tree's packages: why the scan leaves it out
    let notice: string | undefined;
    if (engineAt !== undefined) {
      const e = engineTypeOf(fs.readdirSync(path.join(r.dir, ...engineAt.split('/'))).find((f) => engineTypeOf(f)) ?? '');
      notice = `${engineAt === rel ? 'This is' : 'This is inside'} the ${e === 'unreal' ? 'Unreal' : 'Godot'} project: shown as it is, not audited for flags.`;
    } else if (listing.topo.length && !p) {
      const why = listing.topo.length > 1 ? `it holds ${listing.topo.join(' and ')}, and a package has one .topo file` : unscanned(r.dir, abs, { engine: r.engine?.file ?? null }) ?? 'its manifest cannot be read, or its id is taken by another folder';
      notice = `This folder holds ${listing.topo.join(', ')} but is none of the packages of ${r.kind === 'w' ? 'the workspace' : 'the library'}: ${why}.`;
    }
    const flagsHere = engineAt !== undefined ? [] : flagsNow(r, audit);
    // a folder of hundreds of text files shows the first as boxes and lists the rest with the other files: its README
    // and documents before its text files, and always the notes with flags here and the note a link asked for
    const ranked = [...listing.notes].sort(noteOrder);
    const flagged = new Set(flagsHere.filter((x) => x.at === rel && x.note).map((x) => x.note!));
    const boxed = new Set(ranked.slice(0, MAX_NOTE_BOXES).map((n) => n.name));
    for (const n of ranked) if (flagged.has(n.name) || n.name === askedNote) boxed.add(n.name);
    const env = noteEnv(r, { rel, boxed });
    const notes: NoteBox[] = ranked.filter((n) => boxed.has(n.name)).map((n) => {
      const h = noteHtml(env, abs, path.join(abs, n.name), headingPrefix(n.name));
      return { name: n.name, id: noteId(n.name), url: urls.raw(r.kind, r.name, n.rel), html: h.html, long: h.long, ...(n.name === askedNote ? { asked: true } : {}) };
    });
    const unboxed = ranked.filter((n) => !boxed.has(n.name));
    const folders: FolderCard[] = listing.folders.map((f) => {
      const fabs = path.join(abs, f.name);
      const url = urls.folder(r.kind, r.name, f.rel);
      if (f.engine) return { name: f.name, url, kind: 'engine', title: f.engine.title, sub: `${f.engine.type === 'godot' ? 'Godot' : 'Unreal'} project`, ...(f.image ? { thumb: urls.raw(r.kind, r.name, f.image) } : {}), flags: 0, packages: 0 };
      if (f.workspace) {
        let wsName = f.name;
        try { wsName = JSON.parse(fs.readFileSync(path.join(fabs, 'topotopo-workspace.json'), 'utf8'))?.name ?? f.name; } catch { /* its folder's name */ }
        const reg = games.find((g) => folderKey(g.dir) === folderKey(fabs));
        return { name: f.name, url: reg ? urls.folder('w', reg.name, '') : url, kind: 'workspace', title: String(wsName), sub: reg ? 'another workspace' : 'another workspace, not registered', flags: 0, packages: 0 };
      }
      const q = byDir.get(folderKey(fabs));
      const flags = flagsHere.filter((x) => under(f.rel, x.at)).length;
      const what = [count(f.folders, 'folder'), count(f.files, 'file'), ...(f.unreal ? [count(f.unreal, 'Unreal asset')] : [])].join(' · ');
      if (q) {
        const c = cardOf(q);
        return { name: f.name, url, kind: 'package', title: q.manifest.title, sub: what, thumb: pictureOf(r, f.rel, fabs, f.image), flags, packages: 1, ...(c.pkg ? { pkg: c.pkg } : {}), status: c.status };
      }
      const inside = packagesOf(r).filter((x) => x.rel.startsWith(f.rel + '/')).length;
      const empty = !f.folders && !f.files && !f.unreal;
      return { name: f.name, url, kind: 'folder', title: f.name, sub: empty ? 'empty' : what, thumb: pictureOf(r, f.rel, fabs, f.image), flags, packages: inside, ...(empty ? { empty } : {}) };
    });
    // exports TopoTopo made: the package above them says whether their graph changed since
    let above: Package | null = null;
    for (let d = abs; within(d, r.dir); d = path.dirname(d)) { const q = byDir.get(folderKey(d)); if (q) { above = q; break; } if (folderKey(d) === folderKey(r.dir)) break; }
    const graphs = above ? graphsOf(above) : null;
    const files: FileItem[] = [...listing.files, ...unboxed.map((n) => ({ ...n, kind: 'other' as const }))].map((f) => {
      const made = f.made ? { graph: f.made.graph, output: f.made.output, stale: graphs?.get(f.made.graph) ? exportStale(graphs.get(f.made.graph)!, f.made) : null } : undefined;
      return { name: f.name, url: urls.raw(r.kind, r.name, f.rel), size: f.size, mtime: f.mtime, kind: f.kind, ...(f.kind === 'model' ? { model: urls.model(r.kind, r.name, f.rel) } : {}), ...(made ? { made } : {}) };
    });
    const own = flagsHere.filter((x) => x.at === rel);
    const below = new Map<string, Flag[]>();
    for (const x of flagsHere) if (x.at !== rel && under(rel, x.at)) { if (!below.has(x.at)) below.set(x.at, []); below.get(x.at)!.push(x); }
    const kicker = !rel ? [rootLabel(r), ...(r.kind === 'w' && engineLabel(r) ? [engineLabel(r)!] : [])].join(' · ')
      : p ? `Package${p.manifest.name ? ` · ${p.manifest.name}` : ''}` : engineAt === rel ? `${notice?.includes('Unreal') ? 'Unreal' : 'Godot'} project` : 'Folder';
    const stats = [count(listing.folders.length, 'folder'), count(listing.files.length + listing.notes.length, 'file'), ...(listing.notes.length ? [count(listing.notes.length, 'note')] : []), ...(!rel && r.kind === 'w' ? [count(packagesOf(r).length, 'package')] : [])].join(' · ');
    return {
      root: { kind: r.kind, name: r.name, label: rootLabel(r) }, rel, crumbs, kicker, title: p ? p.manifest.title : name, stats, dir: abs,
      flags: own, below: [...below].sort(([a], [b]) => byName(a, b)).map(([at, fl]) => ({ at, url: urls.folder(r.kind, r.name, at), flags: fl })),
      ...(!rel ? { uses: workspaceUses(r) } : {}), ...(!rel && audit.walk.cut.length ? { cut: audit.walk.cut } : {}),
      ...(notice ? { notice } : {}), notes, moreNotes: unboxed.length, folders, files, engineAssets: listing.engineAssets, package: p ? packageData(p) : null,
      live: { root: rootKey(r), rel, ...(p ? { package: keyOf(p) } : {}), reveal: `${urls.folder(r.kind, r.name, rel)}?reveal` },
    };
  };
  // ---------------------------------------------------------------- front page data
  const rootCard = async (r: Root): Promise<RootCardData> => {
    const a = await auditOf(r), pk = r.builtin ? (scans.find((s) => s.name === BUILTIN_LIBRARY.name)?.packages ?? []) : packagesOf(r);
    const thumbs: string[] = [];
    for (const p of pk) { if (thumbs.length >= 4) break; const t = previewOf(p); if (t) thumbs.push(t); }
    for (const i of a.walk.images) { if (thumbs.length >= 4) break; thumbs.push(urls.raw(r.kind, r.name, i)); }
    const g = r.kind === 'w' ? games.find((x) => x.name === r.name) : undefined;
    const problem = g?.problem ? 'Its workspace file cannot be read: see its page' : !fs.existsSync(r.dir) ? 'Its folder is not there' : undefined;
    return {
      kind: r.kind, name: r.name, dir: r.dir, url: urls.folder(r.kind, r.name, ''), ...(engineLabel(r) ? { engine: engineLabel(r) } : {}), ...(r.builtin ? { builtin: true } : {}),
      thumbs, packages: pk.length, folders: a.walk.folders, files: a.walk.files, flags: flagsNow(r, a).length, ...(problem ? { problem } : {}), ...(a.walk.cut.length ? { cut: true } : {}),
    };
  };

  let placeholder: Uint8Array | null = null;
  const placeholderPNG = () => {
    if (!placeholder) {
      const n = 64, rgba = new Uint8Array(n * n * 4);
      for (let i = 0; i < n * n; i++) rgba.set([0x2b, 0x2d, 0x31, 0xff], i * 4);
      placeholder = encodePNG(rgba, n, n, (d) => zlib.deflateSync(d));
    }
    return placeholder;
  };

  /** `files/<rest>` of a package: below attachments/ or exports/, never outside them (links included). */
  const packageFile = (p: Package, rest: string) => {
    const parts = rest.split('/').map((x) => decodeURIComponent(x));
    // decoded segments: "%2F" and "%5C" must not smuggle separators (and so "..") past the split
    if (!['attachments', 'exports'].includes(parts[0]) || parts.length < 2 || parts.some((x) => !x || x.startsWith('.') || /[\\/\0]/.test(x)))
      throw new HttpError(400, 'files/ serves attachments/<path> and exports/<path> (no dot names)');
    const root = path.join(p.dir, parts[0]);
    const abs = path.join(root, ...parts.slice(1));
    if (!abs.startsWith(root + path.sep)) throw new HttpError(400, 'the path leaves the package');
    if (!fs.statSync(abs, { throwIfNoEntry: false })?.isFile()) throw new HttpError(404, `no file ${parts.join('/')}`);
    // where it really is (links and short names resolved): inside, and through no dot folder by another name
    const real = realBelow(root, abs, true);
    if ('why' in real) throw new HttpError(400, `not served: ${real.why}`);
    return abs;
  };

  const readStatic = (dir: string, rel: string) => {
    const p = path.resolve(dir, decodeURIComponent(rel));
    if (!p.startsWith(dir + path.sep) || !fs.statSync(p, { throwIfNoEntry: false })?.isFile()) return null;
    return p;
  };

  /** A page that says there is nothing at an address, with the way back. */
  const missingPage = (msg: string, back: string) => shell('Not found · TopoTopo', urls, `<header class="bar"><a class="brand" href="/"><b>TopoTopo</b></a></header>
<main class="wrap folder"><div class="head"><p class="kicker">Not found</p><h1>Nothing here</h1><p class="hstats">${esc(msg)}</p></div><p><a class="btn" href="${esc(back)}">Back</a></p></main>`, { page: 'missing' });

  // ---------------------------------------------------------------- routes
  const server = http.createServer(async (req, res) => {
    const head = (code: number, type: string, extra: Record<string, string> = {}) =>
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
    const send = (code: number, body: string | Uint8Array, type = 'text/plain; charset=utf-8', extra: Record<string, string> = {}) => { head(code, type, extra); res.end(req.method === 'HEAD' ? undefined : body); };
    // pages may only be framed by the web app itself; the embed page is made to be framed by a board; the 3D views
    // load three.js through an inline import map (allowed by its hash) and nothing from other sites
    const map = importMap(urls);
    const html = (body: string, framable: boolean | 'view' = false, code = 200) => send(code, body, MIME['.html'], { 'content-security-policy': framable === true ? viewCsp(map, true) : framable === 'view' ? viewCsp(map, false) : PAGE_CSP });
    const json = (code: number, body: unknown, extra: Record<string, string> = {}) => send(code, JSON.stringify(body), MIME['.json'], extra);
    const redirect = (code: number, location: string) => { res.writeHead(code, { location, 'cache-control': 'no-store' }); res.end(); };
    try {
      const host = String(req.headers.host ?? '');
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return json(403, { error: `unexpected Host "${host}"` });
      const origin = req.headers.origin;
      const write = req.method !== 'GET' && req.method !== 'HEAD';
      if (write && origin !== undefined && origin !== `http://${host}`) return json(403, { error: `cross-origin ${req.method} refused (${origin})` });
      const u = new URL(req.url ?? '/', 'http://localhost');
      const seg = u.pathname.split('/').slice(1);

      if (u.pathname === '/' || u.pathname === '/index.html') {
        // TopoTopo's built-in library as it is now: a built-in package published while the web app runs shows
        refreshBuiltin();
        const all = [...packages.values()].filter((p) => packages.get(keyOf(p)) === p).map(cardOf).sort((a, b) => byName(a.title, b.title));
        return html(frontPage({
          workspaces: await Promise.all(roots.filter((r) => r.kind === 'w').map(rootCard)),
          libraries: await Promise.all(roots.filter((r) => r.kind === 'l').map(rootCard)),
          packages: all,
          problems: libraryScans().filter((s) => s.name !== BUILTIN_LIBRARY.name && !fs.existsSync(s.root)).map((s) => `library "${s.name}": no folder ${s.root}`),
        }, urls));
      }
      if (seg[0] === 'static') { const p = readStatic(assetDir, seg.slice(1).join('/')); return p ? send(200, fs.readFileSync(p), MIME[path.extname(p)] ?? 'application/octet-stream') : send(404, 'not found'); }
      if (seg[0] === 'app') { const p = readStatic(appDir, seg.slice(1).join('/')); return p ? send(200, fs.readFileSync(p), MIME[path.extname(p)] ?? 'application/octet-stream') : send(404, 'not found'); }
      if (seg[0] === 'vendor' && seg[1] === 'three') {
        const p = readStatic(threeDir, seg.slice(2).join('/'));
        return p ? send(200, fs.readFileSync(p), MIME[path.extname(p)] ?? 'application/octet-stream', { 'cache-control': 'max-age=3600' }) : send(404, 'not found');
      }
      if (u.pathname === '/api/health') return json(200, { web: true, libraries: scans.length, packages: packages.size, baking: queue.size });
      if (u.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(': hello\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (u.pathname === '/api/packages') {
        // a board on another origin may read the list when the config allows it (web.cors)
        const cors: Record<string, string> = origin && cfg.web.cors.includes(origin) ? { 'access-control-allow-origin': origin, vary: 'Origin' } : { vary: 'Origin' };
        if (req.method === 'OPTIONS') return send(204, '', 'text/plain', { ...cors, 'access-control-allow-methods': 'GET' });
        return json(200, { libraries: scans.map((s) => ({ name: s.name, packages: s.packages.length, problems: s.problems })), packages: listJSON() }, cors);
      }
      // a workspace's or library's folder pages and files: /w/<name>/<path…>/ and /l/<name>/<path…>; a model's 3D view
      const model = seg[0] === 'model';
      const at = model ? seg.slice(1) : seg;
      if ((at[0] === 'w' || at[0] === 'l') && at.length >= 2) {
        const kind = at[0], name = decodeURIComponent(at[1]);
        const r = roots.find((x) => x.kind === kind && x.name === name);
        if (!r) {
          // a registered library inside a registered workspace is the workspace's: its folders are there (and a
          // workspace's name under /l/ is the workspace)
          const placed = kind === 'l' ? placeNamed(cfg, name) : null;
          if (placed?.place.workspace) return redirect(302, `${urls.folder('w', placed.place.name, placed.prefix)}${at.slice(2).map((x) => x).join('/')}${u.search}`);
          return html(missingPage(`No ${kind === 'w' ? 'workspace' : 'library'} "${name}" is registered.`, '/'), false, 404);
        }
        const segs = at.slice(2);
        const slash = u.pathname.endsWith('/');
        const parts = slash ? segs.slice(0, -1) : segs;
        if (parts.some((x) => x === '')) throw new PathError(400, 'an empty folder name in the path');
        let found: ReturnType<typeof resolveIn>;
        try { found = resolveIn(r.dir, parts); }
        catch (e) {
          if (e instanceof PathError && e.status === 404) return html(missingPage(e.message, urls.folder(r.kind, r.name, '')), false, 404);
          throw e;
        }
        const st = fs.statSync(found.abs, { throwIfNoEntry: false });
        const up = urls.folder(r.kind, r.name, found.rel.split('/').slice(0, -1).join('/'));
        if (!st) return html(missingPage(`There is no ${found.rel || r.name} in ${r.kind === 'w' ? 'the workspace' : 'the library'} "${r.name}".`, up), false, 404);
        if (model) {
          if (!st.isFile() || !/\.(glb|gltf)$/i.test(found.abs)) throw new HttpError(404, 'a 3D view is of a .glb or .gltf file');
          return html(modelPage({ title: path.basename(found.abs), src: urls.raw(r.kind, r.name, found.rel), link: urls.raw(r.kind, r.name, found.rel) }, urls), 'view');
        }
        if (st.isDirectory()) {
          if (req.method === 'POST' && u.searchParams.has('reveal')) { reveal(found.abs); return json(200, { ok: true }); }
          // a folder's address ends with a slash, in the letter case on disk
          if (!slash || found.rel !== found.parts.join('/')) return redirect(301, `${urls.folder(r.kind, r.name, found.rel)}${u.search}`);
          if (r.builtin) refreshBuiltin();
          const asked = u.searchParams.get('note');
          return html(folderPage(await folderData(r, found.rel, found.abs, asked && kindOf(asked) === 'note' && !/[\\/]/.test(asked) ? asked : null), urls));
        }
        if (slash) return redirect(301, urls.raw(r.kind, r.name, found.rel));
        if (write) throw new HttpError(405, 'files are read only here');
        return sendFile(req, res, found.abs, { download: u.searchParams.has('download') });
      }
      if (seg[0] === 'embed' && seg.length === 3) {
        const p = find(decodeURIComponent(seg[1]), decodeURIComponent(seg[2]));
        const c = cardOf(p);
        const glb = !isBuiltin(p) && fs.existsSync(path.join(webDir(p.dir), 'preview.glb'));
        return html(embedPage({ lib: p.lib, id: p.id, title: p.manifest.title, glb, version: c.version, packageUrl: urls.package(p.lib, p.id) }, urls), true);
      }
      if (seg[0] === 'p' && seg.length >= 3) {
        const p = find(decodeURIComponent(seg[1]), decodeURIComponent(seg[2]));
        const rest = seg.slice(3);
        // a package's stable address leads to its folder page
        if (!rest.length || (rest.length === 1 && !rest[0])) return redirect(302, pageOf(p));
        // a package's thumbnail of one of its outputs (thumbs/<output>.png), nothing else of that folder
        if (rest[0] === 'thumbs' && rest.length === 2) {
          const file = decodeURIComponent(rest[1]);
          const abs = /^[a-z0-9][a-z0-9_-]*\.png$/.test(file) ? path.join(p.dir, 'thumbs', file) : '';
          if (!abs || !fs.statSync(abs, { throwIfNoEntry: false })?.isFile()) throw new HttpError(404, `no thumbnail ${file}`);
          return send(200, fs.readFileSync(abs), 'image/png', { 'cache-control': 'max-age=3600' });
        }
        // a built-in package: the thumbnail of its first output that has one; no 3D preview
        if (isBuiltin(p) && (rest[0] === 'thumb.png' || rest[0] === 'preview.glb')) {
          const thumb = builtinAt.get(p.dir)?.thumb;
          if (rest[0] === 'preview.glb' || !thumb) return rest[0] === 'thumb.png' ? send(200, placeholderPNG(), 'image/png') : json(404, { error: 'TopoTopo\'s built-in packages have no 3D preview here' });
          return send(200, fs.readFileSync(path.join(p.dir, 'thumbs', `${thumb}.png`)), 'image/png', { 'cache-control': 'max-age=3600' });
        }
        if (rest[0] === 'thumb.png' || rest[0] === 'preview.glb') {
          const s = readBakeState(p.dir);
          const file = path.join(webDir(p.dir), rest[0]);
          if (!fs.existsSync(file)) {
            bakeIfStale(p);
            if (rest[0] === 'thumb.png') return send(200, placeholderPNG(), 'image/png');
            return json(404, { error: s?.ok === false ? `the bake failed: ${s.error}` : 'not baked yet' });
          }
          const etag = `"${s?.key ?? 'x'}-${s?.at ?? 0}"`;
          if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag }); return res.end(); }
          return send(200, fs.readFileSync(file), rest[0] === 'thumb.png' ? 'image/png' : MIME['.glb'], { etag, 'cache-control': 'no-cache' });
        }
        if (rest[0] === 'files' && rest.length > 1) return sendFile(req, res, packageFile(p, rest.slice(1).join('/')));
        if ((rest[0] === 'edit' || rest[0] === 'bake') && isBuiltin(p)) throw new HttpError(400, 'TopoTopo\'s built-in packages are not edited or baked here: TopoTopo\'s repository publishes them');
        if (rest[0] === 'edit') {
          const url = await editorFor(p);
          return redirect(302, url);
        }
        if (rest[0] === 'bake') {
          if (req.method !== 'POST') throw new HttpError(405, 'POST to bake again');
          if (!hasDefault(p)) throw new HttpError(400, `no default graph yet: ${p.manifest.title} has no graph "${p.manifest.bake.graph ?? p.manifest.graph}" to bake`);
          const queued = queue.add(p.dir);
          if (queued) broadcast({ package: keyOf(p), baking: true });
          return json(200, { ok: true, queued });
        }
        if (rest[0] === 'reveal') {
          if (req.method !== 'POST') throw new HttpError(405, 'POST to show the folder');
          reveal(p.dir);
          return json(200, { ok: true });
        }
      }
      send(404, 'not found');
    } catch (e: any) {
      if (res.headersSent || res.destroyed) return;
      const code = e instanceof HttpError || e instanceof PathError ? e.status : 500;
      json(code, { ok: false, error: String(e?.message ?? e) });
    }
  });

  const port = o.port ?? cfg.web.port;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const actual = (server.address() as any).port as number;
  base = `http://127.0.0.1:${actual}`;
  const keepAlive = setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 20000);
  keepAlive.unref();
  // the audits of the trees, made now so that the first page does not wait for them
  rewarm();
  return {
    url: base + '/', port: actual, rescan, queue,
    close: () => {
      clearInterval(periodic);
      clearInterval(keepAlive);
      clearTimeout(changeTimer);
      clearTimeout(warm);
      closed = true;
      for (const w of watchers) w.close();
      queue.close();
      for (const e of editors.values()) e.child.kill();
      for (const c of clients) c.end();
      server.close();
      server.closeAllConnections?.();
    },
  };
}
