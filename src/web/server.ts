// The web app server: a file explorer of the registered workspaces and libraries. The front page shows each as a
// card (a few pictures from inside, its packages, folders, files and flags; TopoTopo's built-in library last) and
// searches every package and output. Every folder below a workspace or library is a page (/w/<workspace>/<path…>/,
// /l/<library>/<path…>/, src/web/folder-page.ts): its flags, its package when it is one (preview, versions, outputs,
// who uses it, graphs, Open in editor, Re-bake), its notes, its subfolders as cards and its files by type, which the
// same addresses serve (read only, inside the folder, with ranges). A package keeps a stable address for boards,
// /p/<workspace or library>/<id>, which leads to its folder page, with its thumbnail and an iframe embed.
// It reads files and serves baked previews; it never cooks: bakes run in child processes (BakeQueue) and "Open in
// editor" starts a `topotopo edit` child. Bound to 127.0.0.1 on a fixed port (stable links); requests must name this
// server as their Host, and writes must come from its own pages. `topotopo open` asks it (POST /api/open) for the page of a
// package or workspace, which it lists for its run when the config does not (src/host/open.ts).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { encodePNG } from '../render/png.ts';
import { MIME, appDir, threeDir } from '../viewer/server.ts';
import { webDir, isStale, listFiles, placeNamed, readBakeState, scanAll, scanLibrary } from './library.ts';
import { BUILTIN_LIBRARY, loadConfig } from '../config.ts';
import { readWorkspace, engineFile } from '../workspace.ts';
import { VERSION_RE, WORKSPACE_PACKAGES, locate, manifestAt, packageDirOf, slugify, workspaceAt, workspaceFilePath } from '../package.ts';
import type { WorkspaceManifest } from '../workspace.ts';
import { folderKey, forgetScans, forgetScansOf, scanSingle, scanTree, unscanned } from '../scan.ts';
import { engineTypeOf } from '../engines.ts';
import { graphFiles } from '../session.ts';
import type { BakeState, LibraryScan, Package } from './library.ts';
import type { LibraryRef, WebConfig } from '../config.ts';
import { builtinLibrary, compareVersions, copyRecord, isDefaultOutput, publishedVersions, startsBigVersion, workingHash } from '../packages/registry.ts';
import type { VersionInfo } from '../packages/registry.ts';
import { engineSha256 } from '../host/engine-code.ts';
import { isPublishedCopy } from '../host/godot.ts';
import { TOPOTOPO_VERSION } from '../host/version.ts';
import { BakeQueue } from './bake.ts';
import { editorPage, embedPage, esc, frontPage, importMap, modelPage, shell, count } from './pages.ts';
import type { CardData, OutputRow, PackageData, RootCardData, Urls, UserRow } from './pages.ts';
import { PICTURE_STRIP, folderPage } from './folder-page.ts';
import type { FileItem, FolderCard, FolderPageData, NoteBox } from './folder-page.ts';
import { PathError, byName, engineTitle, exportSources, exportStale, graphSummary, graphTypes, headingPrefix, kindOf, listFolder, noteHtml, noteId, plumbing, realBelow, resolveIn, rootKey, sendFile, walkTree } from './folders.ts';
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
/** a page waits this long for the audit of its tree as it is, then shows the one before (or none yet) */
const AUDIT_WAIT_MS = 250;
/** A pause that gives the event loop a turn once some milliseconds of work have passed since the last. */
const slicer = (ms = 8) => {
  let since = performance.now();
  return async () => { if (performance.now() - since > ms) { await new Promise<void>((r) => setImmediate(r)); since = performance.now(); } };
};
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
/** What every page says once a `topotopo open` of another version or engine code has asked this web app for a page. */
const CHANGED_BANNER = '<div class="changed" role="status">TopoTopo has changed since this server started. <button type="button" data-stop-topotopo>Stop TopoTopo</button> then open your file again.</div>';
/** How long a bake that is running is given to finish when the web app is stopped, and an editor to leave. */
// an editor is given longer than the export it may be finishing (EDITOR_GRACE_MS in src/packages/commands.ts)
const BAKE_STOP_MS = 20_000, EDITOR_STOP_MS = 20_000;
const README = /^(readme|index)\.(md|txt)$/i;

/** A copy opened through an alias is still a copy of the same package. */
function publishedFolder(topo: string): string | null {
  const dir = path.dirname(topo);
  if (isPublishedCopy(topo)) return dir;
  let real: string;
  try { real = fs.realpathSync.native(dir); } catch { return null; }
  return real !== dir && isPublishedCopy(path.join(real, path.basename(topo))) ? real : null;
}

const publishedPackage = (p: Package) => publishedFolder(path.join(p.dir, `${p.id}.topo`));
const workingScan = (s: LibraryScan): LibraryScan => ({ ...s, packages: s.packages.filter((p) => !publishedPackage(p)) });

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
  /** how long a page waits for the audit of its tree as it is before it shows the one before (default 250 ms; tests wait longer) */
  auditWait?: number;
  /** what ends the process after POST /api/stop has shut the web app down (`topotopo web`); without it the request is refused */
  onStop?: () => void;
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
    const file = workspaceAt(ws)?.file;
    if (!file) return null;
    const e = JSON.parse(fs.readFileSync(file, 'utf8'))?.engine;
    return e && (e.type === 'godot' || e.type === 'unreal') && typeof e.project === 'string' && e.project ? { type: e.type, file: path.resolve(ws, e.project) } : null;
  } catch { return null; }
}

const firstLine = (s: string | undefined) => { const l = (s ?? '').trim().split('\n')[0] ?? ''; return l.length > 240 ? `${l.slice(0, 240)}…` : l; };

export async function startWeb(o: WebOptions = {}): Promise<WebServer> {
  const cfg = o.config ?? loadConfig();
  const log = o.log ?? (() => {});
  const bakeOn = o.bake ?? true;
  // what /api/health says of this server, hashed now so that a health check never waits for it (topotopo open compares them)
  const engine = engineSha256();
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
  /** a workspace: its file (or what is wrong with it), engine project and scan */
  type Game = { name: string; dir: string; m: WorkspaceManifest | null; problem?: string; engine: Root['engine']; scan: LibraryScan };
  /** the registered workspaces, and those `topotopo open` listed for this run */
  let games: Game[] = [];
  /** every registered workspace and library as a tree of pages, TopoTopo's built-in library last */
  let roots: Root[] = [];
  /** the names this run gave workspaces whose own name another workspace or library had (by folder) */
  const runNames = new Map<string, string>();
  /** the packages `topotopo open` listed one by one for this run: each a root of itself, nothing around it read */
  const singles: { name: string; dir: string }[] = [];
  /** the workspaces `topotopo open` added to the config's list in memory for this run */
  const runListed = new Set<LibraryRef>();
  /** the folders being watched (a root that is gone is let go) */
  const watched = new Map<string, fs.FSWatcher>();
  const stopWatching = (dir: string) => { watched.get(dir)?.close(); watched.delete(dir); };
  const isDir = (d: string) => !!fs.statSync(d, { throwIfNoEntry: false })?.isDirectory();
  /** a root `topotopo open` listed whose folder has gone (moved, renamed, deleted) is dropped from memory, quietly */
  const dropGone = () => {
    for (let i = singles.length - 1; i >= 0; i--) {
      if (isDir(singles[i].dir)) continue;
      log(`${singles[i].dir} is gone: no longer listed`);
      stopWatching(singles[i].dir);
      singles.splice(i, 1);
    }
    for (const w of [...runListed]) {
      if (isDir(w.path)) continue;
      log(`${w.path} is gone: no longer listed`);
      stopWatching(path.resolve(w.path));
      cfg.workspaces.splice(cfg.workspaces.indexOf(w), 1);
      runListed.delete(w);
      runNames.delete(folderKey(w.path));
    }
  };
  /** what no timer, watcher or rescan lets take the process down: one line in the log */
  const safe = (what: string, f: () => void) => { try { f(); } catch (e: any) { try { log(`${what}: ${e?.message ?? e}`); } catch { /* no log */ } } };
  const indexPackages = () => {
    packages.clear();
    byDir.clear();
    // a package's address is its library's or workspace's name and its id: the first folder of an id keeps it (the scan says so)
    for (const s of scans) for (const p of s.packages) {
      if (!packages.has(keyOf(p))) packages.set(keyOf(p), p);
      if (!byDir.has(folderKey(p.dir))) byDir.set(folderKey(p.dir), p);
    }
  };
  /** A workspace's scan as a game: its file read, or when it cannot be, the problem and the folders still scanned. */
  const gameFor = (scanned: LibraryScan): { game: Game; scan: LibraryScan } => {
    // a workspace listed for this run under another name than its file's: its packages are that name's
    const alias = runNames.get(folderKey(scanned.root));
    const s: LibraryScan = alias && scanned.name !== alias
      ? { ...scanned, name: alias, packages: scanned.packages.map((p) => Object.create(Object.getPrototypeOf(p), { ...Object.getOwnPropertyDescriptors(p), lib: { value: alias, enumerable: true, writable: true, configurable: true } })) }
      : scanned;
    try {
      const m = readWorkspace(s.root), e = engineFile(s.root, m);
      return { game: { name: runNames.get(folderKey(s.root)) ?? m.name, dir: s.root, m, engine: e && m.engine && m.engine !== 'none' ? { type: m.engine.type, file: e } : null, scan: s }, scan: s };
    } catch (err: any) {
      // the workspace file cannot be read: its folder pages still show its folders and packages (scanned with the
      // engine project the file names), and the problem as a flag on it
      const engine = engineWritten(s.root);
      const t = scanTree(s.name, s.root, { engine: engine?.file ?? null });
      const scan: LibraryScan = { ...t, problems: t.problems, workspace: true };
      return { game: { name: s.name, dir: s.root, m: null, problem: err.message, engine, scan }, scan };
    }
  };
  const buildRoots = () => {
    roots = [
      ...games.map((g): Root => ({ kind: 'w', name: g.name, dir: g.dir, engine: g.engine })),
      ...scans.filter((s) => !s.workspace && s.name !== BUILTIN_LIBRARY.name).map((s): Root => ({ kind: 'l', name: s.name, dir: s.root, engine: null })),
      { kind: 'l', name: BUILTIN_LIBRARY.name, dir: BUILTIN_LIBRARY.path, engine: null, builtin: true },
    ];
  };
  /**
   * Read the packages of the workspaces and libraries again: those of `roots` (their folders), else all of them. The
   * audits stay: what changed decides which go (forget()).
   */
  const rescanPackages = (changed?: string[]) => {
    dropGone();
    if (changed) for (const d of changed) forgetScansOf(d);
    else forgetScans();
    // the libraries (but those inside a registered workspace) and the workspaces, then the packages opened one by one;
    // TopoTopo's built-in library last, read again each time: a built-in package published while the web app runs shows
    const all: LibraryScan[] = [...scanAll(cfg), ...singles.map((x) => scanSingle(x.name, x.dir))];
    games = [];
    for (const [i, s] of all.entries()) {
      if (!s.workspace) continue;
      const g = gameFor(s);
      games.push(g.game);
      all[i] = g.scan;
    }
    scans = [...all.map(workingScan), scanBuiltin()];
    indexPackages();
    buildRoots();
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
    if (!p || publishedPackage(p)) throw new HttpError(404, `no package "${id}" in library "${lib}"`);
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
  const graphsAt = (p: Package) => builtinAt.get(p.dir)?.from ?? p.dir;
  const graphsOf = (p: Package) => graphFiles(graphsAt(p));
  const defaultFile = (p: Package) => graphsOf(p).get(p.manifest.bake.graph ?? p.manifest.graph);
  const unreadDefault = (p: Package, file: string | undefined) => {
    if (!file) return;
    const { error } = graphSummary(file);
    if (error !== undefined) return `Its graph file ${path.relative(graphsAt(p), file).split(path.sep).join('/')} cannot be read: ${error}`;
  };
  const bakeIfStale = (p: Package) => {
    if (!bakeOn || isBuiltin(p) || queue.pending(p.dir)) return;
    const file = defaultFile(p);
    if (!file || unreadDefault(p, file)) return;
    try { if (isStale(p) && queue.add(p.dir)) broadcast({ package: keyOf(p), baking: true }); } catch { /* removed meanwhile */ }
  };
  // the audits: each tree's walk and flags, made when a page asks and made again soon after something in that tree
  // changes (rewarm). A page waits a moment for the audit of the tree as it is, then shows the one before: a page never
  // waits for a large tree's audit. An audit gives the event loop a turn every few milliseconds: pages, files and the
  // event stream keep answering while a large tree is audited
  /**
   * `stale`: each package's exports older than their graphs (by the package's folderKey; its page marks them); `gen`: the
   * tree's count of changes when the audit began; `dir`: the tree's folder; `n`: its number, counted up as audits are
   * kept (a page made from an audit that is not of the tree as it is waits for one with a higher number)
   */
  type Audit = { walk: Walk; flags: Flag[]; stale: Map<string, Set<string>>; at: number; gen: number; dir: string; n: number };
  /** the newest audit of each tree: kept after a change, until the next one is made */
  const audits = new Map<string, Audit>();
  let auditCount = 0;
  /** the audits under way, and each tree's count of changes (an audit begun before a change is not of the tree as it is) */
  const auditing = new Map<string, { gen: number; made: Promise<Audit> }>();
  const changes = new Map<string, number>();
  const auditWait = o.auditWait ?? AUDIT_WAIT_MS;
  /** the links of the notes the walks read, by file: a walk again reads only the notes that changed */
  const noteLinks: NoteLinks = new Map();
  const forget = (key: string) => { changes.set(key, (changes.get(key) ?? 0) + 1); };
  const forgetAll = () => { for (const r of roots) forget(rootKey(r)); };
  let warm: ReturnType<typeof setTimeout> | undefined, closed = false;
  /** a `topotopo open` came from another version or engine code than this web app's: the pages say so */
  let changedSince = false;
  /** a request to stop has been accepted: from then on this is no web app to open files in (health says so, /api/open refuses) */
  let stopRequested = false;
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
    changeTimer = setTimeout(() => safe('rescan after a change', () => {
      const before = [...packages.keys()].join('\n');
      rescanPackages([...changedRoots]);
      watchRoots(); // a folder that was gone and is back is watched again
      for (const k of staleAudits) forget(k);
      for (const k of touched) { const p = packages.get(k); if (p) bakeIfStale(p); }
      for (const p of packages.values()) if (!readBakeState(p.dir)) bakeIfStale(p);
      broadcast({ changed: [...touched], list: before !== [...packages.keys()].join('\n'), folders: [...changedFolders] });
      rewarm();
      touched.clear();
      changedFolders.clear();
      changedRoots.clear();
      staleAudits.clear();
    }), 500);
  };
  const watchers: fs.FSWatcher[] = [];
  /** Watch the folders of the scans not watched yet (those at the start, and those a request opened later). */
  const watchRoots = () => { for (const s of scans) {
    if (s.name === BUILTIN_LIBRARY.name || watched.has(s.root)) continue; // nothing of it is baked here: read again at each rescan
    try {
      const w = fs.watch(s.root, { recursive: true }, (_ev, f) => safe('watch', () => {
        if (watched.get(s.root) !== w) return; // let go already: the events still queued are of a folder that is gone
        const rel = f ? String(f).split(path.sep).join('/') : '';
        if (path.isAbsolute(rel)) {
          // the root itself went away (deleted, renamed or moved; Windows then sends its events by the thousand, with the
          // root's full path): let the watch go and read the packages again now, not at the next periodic rescan
          if (isDir(s.root)) return;
          stopWatching(s.root);
          changedRoots.add(s.root);
          for (const r of roots) if (r.dir === s.root) staleAudits.add(rootKey(r));
          onChange();
          return;
        }
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
      }));
      w.on('error', () => { w.close(); if (watched.get(s.root) === w) watched.delete(s.root); });
      w.unref();
      watched.set(s.root, w);
      watchers.push(w);
    } catch { /* no folder (a problem on the page) or no recursive watch: the periodic rescan covers it */ }
  } };
  watchRoots();
  const periodic = setInterval(() => safe('periodic rescan', () => { rescan(); for (const p of packages.values()) bakeIfStale(p); rewarm(); }), RESCAN_MS);
  periodic.unref();

  // ---------------------------------------------------------------- pages for what topotopo open asks for
  /** The name a workspace, library or package opened by itself takes: the wanted one, else it with -2, -3 … (one set of names). */
  const freeName = (wanted: string): string => {
    // every name in use: the config's, those of this run, the pages' (a workspace's own name is its file's) and the scans'
    const taken = (n: string) => [...cfg.workspaces, ...cfg.libraries, ...singles, ...roots, ...games, ...scans, BUILTIN_LIBRARY].some((x) => x.name === n);
    let name = wanted;
    for (let n = 2; taken(name); n++) name = `${wanted}-${n}`;
    return name;
  };
  /**
   * Add one scan (a root listed for this run) and nothing else is read again: the pages know it at once, it is watched,
   * and its packages are queued for a bake (the bake itself runs in a child process, after the answer).
   */
  const addScan = (s: LibraryScan) => {
    let scan = s;
    if (s.workspace) { const g = gameFor(s); games.push(g.game); scan = g.scan; }
    scan = workingScan(scan);
    // the libraries inside a workspace are the workspace's own
    scans = [...scans.filter((x) => x.name === BUILTIN_LIBRARY.name ? false : !(s.workspace && !x.workspace && within(x.root, s.root))), scan, scans.find((x) => x.name === BUILTIN_LIBRARY.name) ?? scanBuiltin()];
    indexPackages();
    buildRoots();
    watchRoots();
    for (const p of scan.packages) bakeIfStale(p);
    broadcast({ list: true });
    rewarm();
  };
  /** List a workspace for this run (the config is not written): under its file's name, or another when that is taken. */
  const addWorkspaceRoot = (dir: string, fileName: string): string => {
    const name = freeName(fileName);
    if (name !== fileName) runNames.set(folderKey(dir), name);
    const ref = { name, path: dir };
    cfg.workspaces.push(ref);
    runListed.add(ref);
    forgetScansOf(dir);
    addScan(scanLibrary({ name, path: dir, workspace: true }));
    return name;
  };
  /** List one package for this run as itself: nothing outside its folder is scanned, watched, served or baked. */
  const addSingle = (dir: string, id: string) => {
    const name = freeName(id);
    const scan = scanSingle(name, dir);
    if (scan.packages.some(publishedPackage)) return;
    singles.push({ name, dir });
    addScan(scan);
  };
  /** The page of a package folder or a workspace folder, listed first when it is not. */
  const openPage = (kind: 'package' | 'workspace', dir: string): string => {
    if (kind === 'workspace') {
      const file = workspaceAt(dir);
      if (!file) throw new HttpError(400, `${dir} holds no .topows file`);
      const have = games.find((g) => folderKey(g.dir) === folderKey(dir));
      return urls.folder('w', have ? have.name : addWorkspaceRoot(dir, file.name), '');
    }
    const m = manifestAt(dir), copy = m && publishedFolder(m.file);
    let p = byDir.get(folderKey(dir));
    if (!p || copy) {
      const at = locate(copy ?? dir), ws = at.workspace ?? at.outside?.workspace;
      const wsName = ws ? workspaceAt(ws)?.name ?? (slugify(path.basename(ws)) || 'workspace') : '';
      const rel = ws ? path.relative(ws, copy ?? dir).split(path.sep) : [];
      // a copy the workspace uses (its topotopo-packages folder) has no page: the package it is a copy of has
      if (ws && rel[0]?.toLowerCase() === WORKSPACE_PACKAGES)
        throw new HttpError(409, `${dir} is a copy of ${rel[1] && rel[2] ? `${rel[1]}/${rel[2]}` : 'a package'} that the workspace "${wsName}" uses (its ${WORKSPACE_PACKAGES} folder), which has no page: open the package itself, in the folder of the workspace or library that holds it`);
      if (copy) {
        const parent = path.dirname(copy), source = path.dirname(parent), version = path.basename(copy);
        if (path.basename(parent).toLowerCase() === 'versions' && VERSION_RE.test(version)) {
          const original = manifestAt(source);
          if (original && !publishedFolder(original.file)) return `${openPage('package', source)}?copy=${encodeURIComponent(version)}`;
        }
        const storage = path.dirname(source);
        const holder = packageDirOf(parent) ?? ws ?? (path.basename(storage).toLowerCase() === WORKSPACE_PACKAGES ? path.dirname(storage) : parent);
        let name = `${path.basename(source)}/${path.basename(parent)}`, v = version;
        try {
          const record = JSON.parse(fs.readFileSync(path.join(copy, 'version.json'), 'utf8'));
          if (typeof record?.package === 'string' && typeof record?.version === 'string') { name = record.package; v = record.version; }
        } catch { /* the folder names still say which copy it is */ }
        throw new HttpError(409, `${dir} is a copy of ${name} ${v} that ${holder} uses, which is never changed and has no page: open the package itself`);
      }
      // made a moment ago, before the watch noticed: the roots around it (not all of them) are read again
      const near = scans.filter((x) => x.name !== BUILTIN_LIBRARY.name && within(dir, x.root)).map((x) => x.root);
      if (near.length) { rescanPackages(near); p = byDir.get(folderKey(dir)); }
      if (!p && at.workspace) {
        // the workspace the person works in is listed, as the workspace
        if (!games.some((g) => folderKey(g.dir) === folderKey(at.workspace!))) addWorkspaceRoot(at.workspace, wsName);
        p = byDir.get(folderKey(dir));
      } else if (!p) {
        if (!m) throw new HttpError(400, `${dir} holds no .topo file`);
        addSingle(dir, m.id);
        p = byDir.get(folderKey(dir));
      }
    }
    if (!p) throw new HttpError(409, `${dir} is a package the web app cannot list (another package there uses its id, or its manifest cannot be read): see its folder page`);
    return pageOf(p);
  };

  // ---------------------------------------------------------------- editors
  const editors = new Map<string, { child: ChildProcess; package: string; url: string | null; memory: number | null }>();
  const editorErrors = new Map<string, string>();
  const editorAlive = (child: ChildProcess) => !!child.pid && child.exitCode === null && child.signalCode === null && !child.killed;
  const editorReason = (error: unknown) => {
    const text = (error instanceof Error ? error.message : String(error)).trim().replace(/\s*[\r\n]+\s*/g, ' ');
    return /[.!?]$/.test(text) ? text : `${text}.`;
  };
  const editorFor = (p: Package) => {
    const child = spawn(process.execPath, [cli, 'edit', p.dir, '--json'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const editor = { child, package: p.manifest.title, url: null as string | null, memory: null as number | null };
    editors.set(p.dir, editor);
    child.stdin!.on('error', () => {});
    let err = '', failed = false;
    const failStart = (reason: unknown) => {
      if (editor.url || failed || editors.get(p.dir) !== editor) return;
      failed = true;
      editorErrors.set(p.dir, editorReason(reason));
    };
    const t = setTimeout(() => {
      failStart('The editor did not start within a minute.');
      safe('stop editor', () => { child.kill(); });
    }, EDITOR_START_MS);
    t.unref();
    const output = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    output.on('error', () => {});
    output.on('line', (line) => {
      let msg: any;
      try { msg = JSON.parse(line); } catch { return; }
      if (!failed && !editor.url && typeof msg?.url === 'string' && msg.url) { editor.url = msg.url; clearTimeout(t); }
      else if (editor.url && typeof msg?.memory === 'number' && Number.isFinite(msg.memory)) editor.memory = msg.memory;
    });
    child.stderr!.on('data', (d) => { if (err.length < 4000) err += d; });
    child.on('error', failStart);
    child.on('close', (code, signal) => {
      clearTimeout(t);
      const detail = err.trim().split('\n').slice(-3).join(' ');
      failStart(`The editor stopped (${signal ?? `exit ${code}`})${detail ? `: ${detail}` : ''}`);
      if (editors.get(p.dir) === editor) editors.delete(p.dir);
    });
  };

  /**
   * Stop the way a person would: no timer or watch runs on, a bake that is running gets time to finish (nothing queued
   * starts), each editor is asked to end (its stdin is closed: its viewer closes and it leaves; only one that does not is
   * ended), the pages' event streams close and the server stops listening.
   */
  let stopping: Promise<void> | undefined;
  const shutdown = (): Promise<void> => stopping ??= (async () => {
    clearInterval(periodic); clearInterval(keepAlive); clearTimeout(changeTimer); clearTimeout(warm);
    closed = true;
    for (const w of watchers) w.close();
    await Promise.all([
      queue.stop(BAKE_STOP_MS),
      ...[...editors.values()].map(({ child }) => new Promise<void>((resolve) => {
        if (!editorAlive(child)) return resolve();
        const t = setTimeout(() => { safe('stop editor', () => { child.kill(); }); resolve(); }, EDITOR_STOP_MS);
        t.unref();
        child.once('close', () => { clearTimeout(t); resolve(); });
        child.stdin?.end();
      })),
    ]);
    for (const c of clients) c.end();
    server.close();
    server.closeAllConnections?.();
  })();

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
  const status = (p: Package, s: BakeState | null): CardData['status'] => {
    const file = defaultFile(p);
    return unreadDefault(p, file) ? 'unread' : isBuiltin(p) ? 'ok' : !file ? 'empty' : queue.pending(p.dir) ? 'baking' : !s ? 'new' : s.ok ? 'ok' : 'failed';
  };
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
  /**
   * The exports of a package older than the graph they were made from, by path below exports/; the event loop gets a
   * turn every few milliseconds (a graph read and hashed for the first time can take a while).
   */
  const staleExports = async (p: Package) => {
    const graphs = graphsOf(p), out = new Set<string>(), pause = slicer();
    for (const e of exportSources(p.dir)) { const f = graphs.get(e.made.graph); if (f && exportStale(f, e.made)) out.add(e.rel); await pause(); }
    return out;
  };
  /** A package's page data; its exports older than their graphs as the audit shown says (none before the first audit). */
  const packageData = (p: Package, audit: Audit | null): PackageData => {
    const builtin = isBuiltin(p), s = builtin ? null : readBakeState(p.dir);
    const graphs = [...graphsOf(p)].map(([name, file]) => { const { nodes, vars, error } = graphSummary(file); return { name, nodes, vars, error }; });
    const unread = unreadDefault(p, defaultFile(p));
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
    const stale = builtin ? new Set<string>() : audit?.stale.get(folderKey(p.dir)) ?? new Set<string>();
    return {
      ...cardOf(p), builtin, rel: p.rel, place: games.some((g) => g.scan.packages.includes(p)) ? `in the workspace "${p.lib}"` : builtin ? 'in TopoTopo\'s built-in library' : `in library "${p.lib}"`, links: m.links, graph: m.bake.graph ?? m.graph, graphs, unread, created: m.created,
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
   * of the workspace uses (`used`: node type → the folders of the packages whose graphs use it; null outside a workspace;
   * `stale`: its exports older than their graphs, staleExports).
   */
  const packageFlags = (p: Package, used: Map<string, Set<string>> | null, stale: Set<string>): Flag[] => {
    const out: Flag[] = [], at = p.rel, m = p.manifest;
    const s = readBakeState(p.dir);
    if (s && !s.ok && status(p, s) === 'failed') out.push({ kind: 'bake', at, what: `The preview of ${m.title} did not cook: ${firstLine(s.error) || 'no reason given'}`, todo: 'Open it in the editor to see why; it bakes again when the graph is saved, or press Re-bake' });
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
    for (const e of stale) out.push({ kind: 'export', at, what: `exports/${e} was made from an older version of its graph`, todo: 'Export it again: the Export button in the editor, or ask your agent' });
    return out;
  };
  /** Whether an audit is of the tree as it is (made since its last change; TopoTopo's own library: recently). */
  const fresh = (r: Root, a: Audit) => a.dir === r.dir && a.gen === (changes.get(rootKey(r)) ?? 0) && (!r.builtin || Date.now() - a.at < BUILTIN_AUDIT_MS);
  /**
   * A tree's audit as it is now: its walk (counts, images, broken links in notes) and its packages' flags; one at a time
   * per tree (pages that ask meanwhile wait for the same one). The newest one made is kept, also one begun before a
   * change (pages show it until the next is made); it is what this gives (an older one that ends late is dropped). When
   * the one kept is of the tree as it is, the pages hear of it (an event with its number): each page made from an older
   * one, or from none, reloads. One begun before a change is no news: the change makes another (rewarm).
   */
  const auditOf = (r: Root): Promise<Audit> => {
    const key = rootKey(r), have = audits.get(key);
    if (have && fresh(r, have)) return Promise.resolve(have);
    // one under way since the last change serves; one begun before it does not (its walk may have missed the change)
    const gen = changes.get(key) ?? 0, going = auditing.get(key);
    if (going && going.gen === gen) return going.made;
    const made = auditNow(r).then((x) => {
      const known = audits.get(key);
      if (known && known.dir === r.dir && known.gen > gen) return known;
      const a: Audit = { ...x, gen, dir: r.dir, n: ++auditCount };
      audits.set(key, a);
      if (fresh(r, a)) broadcast({ audited: key, n: a.n });
      return a;
    }).finally(() => { if (auditing.get(key)?.made === made) auditing.delete(key); });
    auditing.set(key, { gen, made });
    return made;
  };
  /** The trees whose audit kept is of the tree as it is, with its number: what a page that connects now has missed. */
  const auditsReady = () => Object.fromEntries(roots.flatMap((r) => { const a = audits.get(rootKey(r)); return a && fresh(r, a) ? [[rootKey(r), a.n]] : []; }));
  /**
   * What a page made from this audit waits for: undefined when it is of the tree as it is; else its number (0: none), and
   * the page reloads when an audit of the tree with a higher number is made.
   */
  const waitOf = (r: Root, a: Audit | null) => (a && fresh(r, a) ? undefined : a?.n ?? 0);
  /**
   * The audit a page shows: the tree's audit as it is now when it is ready within auditWait, else the newest one made
   * (the next one goes on meanwhile), else null: none yet (the page says the tree is being checked).
   */
  const shownAudit = async (r: Root): Promise<Audit | null> => {
    const made = auditOf(r);
    made.catch(() => { /* a page that stopped waiting: the next page asks again */ });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = await Promise.race([made, new Promise<null>((res) => { timer = setTimeout(() => res(null), auditWait); })]).finally(() => clearTimeout(timer));
    if (waited) return waited;
    const known = audits.get(rootKey(r));
    return known && known.dir === r.dir ? known : null;
  };
  const auditNow = async (r: Root): Promise<Omit<Audit, 'gen' | 'dir' | 'n'>> => {
    if (noteLinks.size > 100_000) noteLinks.clear();
    const walk = await walkTree(r, { links: noteLinks, slice: 8, limits: o.walkLimits });
    const pause = slicer();
    const flags: Flag[] = [];
    const g = r.kind === 'w' ? games.find((x) => x.name === r.name) : undefined;
    if (g?.problem) flags.push({ kind: 'workspace', at: '', what: /\.topows: /.test(g.problem) ? `${path.basename(workspaceFilePath(r.dir))} cannot be read: ${g.problem.replace(/^.*?\.topows: /, '')}` : g.problem, todo: 'Fix the file as this says: until then TopoTopo cannot use the workspace (its folders still show here)' });
    for (const prob of scans.find((s) => s.root === r.dir && s.name === r.name)?.problems ?? []) if (!g?.problem || !prob.includes(g.problem)) flags.push({ kind: 'workspace', at: '', what: prob, todo: 'Fix it in the folder it names: until then that package is not found' });
    const pk = packagesOf(r);
    let used: Map<string, Set<string>> | null = null;
    if (r.kind === 'w') {
      used = new Map();
      for (const q of pk) for (const f of graphsOf(q).values()) {
        for (const t of graphTypes(f)) { if (!used.has(t)) used.set(t, new Set()); used.get(t)!.add(folderKey(q.dir)); }
        await pause();
      }
    }
    const stale = new Map<string, Set<string>>();
    for (const p of pk) {
      const s = await staleExports(p);
      stale.set(folderKey(p.dir), s);
      flags.push(...packageFlags(p, used, s));
      await pause();
    }
    walk.flags.forEach((f) => flags.push(f));
    // an engine project below the root is browsable, never audited
    const inEngine = (at: string) => walk.engines.some((e) => at === e || at.startsWith(e + '/'));
    return { walk, flags: flags.filter((f) => !inEngine(f.at)), stale, at: Date.now() };
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
  const folderData = async (r: Root, rel: string, abs: string, askedNote: string | null, copy: string | null): Promise<FolderPageData> => {
    const listing = listFolder(abs, rel, r.dir);
    // none yet: the page shows no flags and says the tree is being checked; one from before a change: the page says it is
    // checked again. Either reloads when the audit of the tree as it is is made (wait)
    const audit = await shownAudit(r), wait = waitOf(r, audit);
    const engines = audit?.walk.engines ?? [];
    const engineAt = engines.find((e) => rel === e || rel.startsWith(e + '/'));
    const found = listing.topo.length ? byDir.get(folderKey(abs)) : undefined;
    const p = found && !publishedPackage(found) ? found : null;
    const name = rel ? rel.split('/').pop()! : r.name;
    const crumbs = [{ name: r.name, url: urls.folder(r.kind, r.name, '') }, ...rel.split('/').filter(Boolean).map((s, i, a) => ({ name: s, url: urls.folder(r.kind, r.name, a.slice(0, i + 1).join('/')) }))];
    // a .topo here that is none of the tree's packages: why the scan leaves it out
    let notice: string | undefined;
    if (p && copy && VERSION_RE.test(copy)) {
      notice = `You opened the published copy ${copy}. Published copies are never changed: this is the package it was published from.`;
    } else if (engineAt !== undefined) {
      const e = engineTypeOf(fs.readdirSync(path.join(r.dir, ...engineAt.split('/'))).find((f) => engineTypeOf(f)) ?? '');
      notice = `${engineAt === rel ? 'This is' : 'This is inside'} the ${e === 'unreal' ? 'Unreal' : 'Godot'} project: shown as it is, not audited for flags.`;
    } else if (listing.topo.length && !p) {
      const why = listing.topo.length > 1 ? `it holds ${listing.topo.join(' and ')}, and a package has one .topo file` : unscanned(r.dir, abs, { engine: r.engine?.file ?? null }) ?? 'its manifest cannot be read, or its id is taken by another folder';
      notice = `This folder holds ${listing.topo.join(', ')} but is none of the packages of ${r.kind === 'w' ? 'the workspace' : 'the library'}: ${why}.`;
    }
    const flagsHere = engineAt !== undefined || !audit ? [] : flagsNow(r, audit);
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
        try { wsName = workspaceAt(fabs)?.name ?? f.name; } catch { /* its folder's name */ }
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
    // a package's folders of images (previews/, renders/…): its page shows their first pictures with its attachments.
    // Not attachments/ and exports/ (shown above), inputs/ (masks and guides, not pictures to look at) and thumbs/ (the
    // output thumbnails the outputs table shows). Only the names are read, and the first few files stat'ed: a renders/
    // folder of thousands of frames costs one listing.
    const pictures = !p ? [] : listing.folders.filter((f) => f.image && !f.engine && !f.workspace && !f.package && !/^(attachments|exports|inputs|thumbs)$/i.test(f.name)).map((f) => {
      const dir = path.join(abs, f.name);
      let names: string[] = [];
      try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && !e.name.startsWith('.') && kindOf(e.name) === 'image').map((e) => e.name).sort(byName); } catch { /* unreadable: no strip */ }
      const images = names.slice(0, PICTURE_STRIP).flatMap((n) => {
        const st = fs.statSync(path.join(dir, n), { throwIfNoEntry: false });
        return st ? [{ name: n, url: urls.raw(r.kind, r.name, `${f.rel}/${n}`), size: st.size, mtime: Math.round(st.mtimeMs), kind: 'image' as const }] : [];
      });
      return { name: f.name, url: urls.folder(r.kind, r.name, f.rel), images, count: names.length };
    }).filter((x) => x.images.length);
    const own = flagsHere.filter((x) => x.at === rel);
    const below = new Map<string, Flag[]>();
    for (const x of flagsHere) if (x.at !== rel && under(rel, x.at)) { if (!below.has(x.at)) below.set(x.at, []); below.get(x.at)!.push(x); }
    const kicker = !rel ? [rootLabel(r), ...(r.kind === 'w' && engineLabel(r) ? [engineLabel(r)!] : [])].join(' · ')
      : p ? `Package${p.manifest.name ? ` · ${p.manifest.name}` : ''}` : engineAt === rel ? `${notice?.includes('Unreal') ? 'Unreal' : 'Godot'} project` : 'Folder';
    const stats = [count(listing.folders.length, 'folder'), count(listing.files.length + listing.notes.length, 'file'), ...(listing.notes.length ? [count(listing.notes.length, 'note')] : []), ...(!rel && r.kind === 'w' ? [count(packagesOf(r).length, 'package')] : [])].join(' · ');
    return {
      root: { kind: r.kind, name: r.name, label: rootLabel(r) }, rel, crumbs, kicker, title: p ? p.manifest.title : name, stats, dir: abs,
      flags: own, below: [...below].sort(([a], [b]) => byName(a, b)).map(([at, fl]) => ({ at, url: urls.folder(r.kind, r.name, at), flags: fl })),
      ...(!rel ? { uses: workspaceUses(r) } : {}), ...(!rel && audit?.walk.cut.length ? { cut: audit.walk.cut } : {}), ...(audit ? wait !== undefined ? { rechecking: true } : {} : { checking: true }),
      ...(notice ? { notice } : {}), notes, moreNotes: unboxed.length, folders, files, engineAssets: listing.engineAssets, package: p ? packageData(p, audit) : null,
      ...(pictures.length ? { pictures } : {}),
      live: { root: rootKey(r), rel, ...(p ? { package: keyOf(p) } : {}), ...(wait !== undefined ? { wait } : {}), reveal: `${urls.folder(r.kind, r.name, rel)}?reveal` },
    };
  };
  // ---------------------------------------------------------------- front page data
  const rootCard = async (r: Root): Promise<RootCardData> => {
    // none yet: the card has no counts and says the tree is being checked; one from before a change: its counts, and it
    // says the tree is checked again. Either way the page reloads when the audit of the tree as it is is made (wait)
    const a = await shownAudit(r), wait = waitOf(r, a), pk = r.builtin ? (scans.find((s) => s.name === BUILTIN_LIBRARY.name)?.packages ?? []) : packagesOf(r);
    const thumbs: string[] = [];
    for (const p of pk) { if (thumbs.length >= 4) break; const t = previewOf(p); if (t) thumbs.push(t); }
    for (const i of a?.walk.images ?? []) { if (thumbs.length >= 4) break; thumbs.push(urls.raw(r.kind, r.name, i)); }
    const g = r.kind === 'w' ? games.find((x) => x.name === r.name) : undefined;
    const problem = g?.problem ? 'Its workspace file cannot be read: see its page' : !fs.existsSync(r.dir) ? 'Its folder is not there' : undefined;
    return {
      kind: r.kind, name: r.name, dir: r.dir, url: urls.folder(r.kind, r.name, ''), ...(engineLabel(r) ? { engine: engineLabel(r) } : {}), ...(r.builtin ? { builtin: true } : {}),
      thumbs, packages: pk.length, folders: a?.walk.folders ?? 0, files: a?.walk.files ?? 0, flags: a ? flagsNow(r, a).length : 0,
      ...(a ? {} : { checking: true }), ...(wait !== undefined ? { wait, ...(a ? { rechecking: true } : {}) } : {}), ...(problem ? { problem } : {}), ...(a?.walk.cut.length ? { cut: true } : {}),
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
    const html = (page: string, framable: boolean | 'view' = false, code = 200) => send(code, changedSince && framable !== true ? page.replace(/(<body[^>]*>)/, `$1${CHANGED_BANNER}`) : page, MIME['.html'], { 'content-security-policy': framable === true ? viewCsp(map, true) : framable === 'view' ? viewCsp(map, false) : PAGE_CSP });
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
      // a web app that is stopping (its bakes finish first, which can take seconds) is not one to open a file in: it says so
      // with its pid, and `topotopo open` waits for it to leave and starts another
      if (u.pathname === '/api/health' && stopRequested) return json(503, { web: true, stopping: true, pid: process.pid });
      if (u.pathname === '/api/health') return json(200, { web: true, pid: process.pid, version: TOPOTOPO_VERSION, engine, open: true, libraries: scans.length, packages: packages.size, baking: queue.size });
      if (u.pathname === '/api/status') {
        if (write) throw new HttpError(405, 'GET');
        const running = [...editors.values()].filter(({ child }) => editorAlive(child)).map(({ package: title, memory }) => ({ package: title, memory }));
        const memory = running.reduce((sum, editor) => sum + (editor.memory ?? 0), process.memoryUsage().rss);
        return json(200, { ok: true, stoppable: !!o.onStop, baking: queue.size, memory, editors: running });
      }
      if (u.pathname === '/api/open' || u.pathname === '/api/stop') {
        // what only the program that starts the web app (and the page's own button) asks: a POST with a header that a page
        // of another origin cannot send without a preflight, which is refused (the Host and Origin checks above apply too)
        if (req.method !== 'POST') throw new HttpError(405, 'POST');
        if (req.headers['x-topotopo-open'] !== '1') throw new HttpError(403, 'only topotopo open and this page may ask for this');
        let text = '';
        for await (const c of req) { text += c; if (text.length > 100_000) throw new HttpError(413, 'too long'); }
        if (u.pathname === '/api/stop') {
          // a request to stop: the answer first, then a stop the way a person would (bakes finish, editors end), then the process
          if (!o.onStop) throw new HttpError(501, 'this web app was not started by topotopo web: it cannot be stopped from a request');
          stopRequested = true;
          json(200, { ok: true });
          setTimeout(() => { shutdown().then(() => o.onStop!(), (e) => { log(`stop: ${e?.message ?? e}`); o.onStop!(); }); }, 50).unref();
          return;
        }
        if (stopRequested) throw new HttpError(503, 'this web app is stopping: open the file again in a moment');
        // `topotopo open`: the page of a package or workspace, which the web app lists for this run when the config does not
        // (nothing is written to the config). The program tells its version and engine code: when they are not this web
        // app's, every page says so (changedSince)
        let ask: any;
        try { ask = JSON.parse(text); } catch { throw new HttpError(400, 'a JSON body {"kind", "dir"} is expected'); }
        if ((ask?.kind !== 'package' && ask?.kind !== 'workspace') || typeof ask.dir !== 'string') throw new HttpError(400, 'a JSON body {"kind": "package" | "workspace", "dir": folder} is expected');
        if ((typeof ask.version === 'string' && ask.version !== TOPOTOPO_VERSION) || (typeof ask.engine === 'string' && ask.engine !== engine)) changedSince = true;
        return json(200, { url: openPage(ask.kind, path.resolve(ask.dir)) });
      }
      if (u.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(': hello\n\n');
        // first, the trees whose audit is ready: a page made before it, which connects only after, still hears of it
        res.write(`data: ${JSON.stringify({ audits: auditsReady() })}\n\n`);
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
          return html(folderPage(await folderData(r, found.rel, found.abs, asked && kindOf(asked) === 'note' && !/[\\/]/.test(asked) ? asked : null, u.searchParams.get('copy')), urls));
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
        const rest = seg.slice(3);
        if (rest[0] === 'edit') {
          const wait = u.searchParams.get('wait') === '1';
          let p: Package;
          try {
            p = find(decodeURIComponent(seg[1]), decodeURIComponent(seg[2]));
            if (isBuiltin(p)) throw new HttpError(400, 'TopoTopo\'s built-in packages are not edited or baked here: TopoTopo\'s repository publishes them');
            if (stopRequested) throw new HttpError(503, 'TopoTopo is stopping.');
          } catch (e) {
            const code = e instanceof HttpError ? e.status : 500;
            const error = editorReason(e);
            return wait ? json(code, { ok: false, error }) : html(missingPage(error, '/'), false, code);
          }
          const editor = editors.get(p.dir);
          if (wait) {
            const error = editorErrors.get(p.dir);
            if (error !== undefined) { editorErrors.delete(p.dir); return json(500, { ok: false, error }); }
            if (editor?.url && editorAlive(editor.child)) return json(200, { ok: true, url: editor.url });
            if (editor && !editor.url) return json(200, { ok: true, starting: true });
            return json(404, { ok: false, error: 'The editor is no longer starting.' });
          }
          const edit = urls.edit(p.lib, p.id)!, back = pageOf(p);
          if (editor?.url && editorAlive(editor.child)) return redirect(302, editor.url);
          if (!editor || !editorAlive(editor.child) || editorErrors.has(p.dir)) {
            editorErrors.delete(p.dir);
            try { editorFor(p); } catch (e) {
              const reason = editorReason(e);
              editorErrors.set(p.dir, reason);
              return html(editorPage(p.manifest.title, edit, back, urls, reason), false, 500);
            }
          }
          return html(editorPage(p.manifest.title, edit, back, urls));
        }
        const p = find(decodeURIComponent(seg[1]), decodeURIComponent(seg[2]));
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
            return json(404, { error: unreadDefault(p, defaultFile(p)) ?? (s?.ok === false ? `the bake failed: ${s.error}` : 'not baked yet') });
          }
          const etag = `"${s?.key ?? 'x'}-${s?.at ?? 0}"`;
          if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag }); return res.end(); }
          return send(200, fs.readFileSync(file), rest[0] === 'thumb.png' ? 'image/png' : MIME['.glb'], { etag, 'cache-control': 'no-cache' });
        }
        if (rest[0] === 'files' && rest.length > 1) return sendFile(req, res, packageFile(p, rest.slice(1).join('/')));
        if (rest[0] === 'bake') {
          if (isBuiltin(p)) throw new HttpError(400, 'TopoTopo\'s built-in packages are not edited or baked here: TopoTopo\'s repository publishes them');
          if (req.method !== 'POST') throw new HttpError(405, 'POST to bake again');
          const file = defaultFile(p);
          if (!file) throw new HttpError(400, `no default graph yet: ${p.manifest.title} has no graph "${p.manifest.bake.graph ?? p.manifest.graph}" to bake`);
          const unread = unreadDefault(p, file);
          if (unread) throw new HttpError(400, unread);
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
