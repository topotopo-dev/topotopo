// The web app server: the registered workspaces (their engine, the shared libraries they list, their packages as the
// scan finds them, the packages they use), every library's packages as a grid (a library inside a registered workspace
// is the workspace's), TopoTopo's built-in library last, a page per package with its 3D preview (a workspace's package
// at /p/<workspace name>/<id>: workspaces and libraries share one set of names), and
// stable URLs a board pastes (link, thumbnail, iframe embed). A package's page lists its versions with their notes and
// the outputs it publishes with their kinds, tags and thumbnails (from its versions' records), which the grid's search
// finds as well, and the packages that use it; any package's page the packages it uses, linked, and the grid marks a
// package with an update. The built-in library's packages have the same page; they are never baked or edited here:
// their thumbnails are those each keeps of its outputs (thumbs/<output>.png). It reads files and serves baked previews;
// it never cooks: bakes run in child processes (BakeQueue) and "Open in editor" starts a `topotopo edit` child.
// Bound to 127.0.0.1 on a fixed port (stable links); requests must name this server as their Host, and writes must
// come from its own pages.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encodePNG } from '../render/png.ts';
import { MIME, appDir, threeDir } from '../viewer/server.ts';
import { webDir, isStale, listFiles, readBakeState, scanAll } from './library.ts';
import { BUILTIN_LIBRARY, loadConfig } from '../config.ts';
import { resolveListed } from '../package.ts';
import { readWorkspace } from '../workspace.ts';
import type { WorkspaceManifest } from '../workspace.ts';
import { forgetScans } from '../scan.ts';
import { graphFiles } from '../session.ts';
import type { BakeState, LibraryScan, Package } from './library.ts';
import type { WebConfig } from '../config.ts';
import { builtinLibrary, compareVersions, copyRecord, isDefaultOutput, publishedVersions, startsBigVersion } from '../packages/registry.ts';
import type { VersionInfo } from '../packages/registry.ts';
import { BakeQueue } from './bake.ts';
import { embedPage, frontPage, packagePage } from './pages.ts';
import type { CardData, OutputRow, PackageData, Urls, UserRow, WorkspaceCardData } from './pages.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const assetDir = path.join(here, 'app');
const cli = path.resolve(here, '..', import.meta.url.endsWith('.ts') ? 'cli.ts' : 'cli.js');
const RESCAN_MS = 5 * 60_000;
const EDITOR_START_MS = 60_000;
const FILE_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.json': 'application/json',
  '.glb': 'model/gltf-binary', '.csv': 'text/csv; charset=utf-8',
};
/** shown inline; everything else (SVG and HTML among them: they run scripts) is a download */
const INLINE = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.pdf', '.txt', '.md', '.json', '.csv']);

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

export async function startWeb(o: WebOptions = {}): Promise<WebServer> {
  const cfg = o.config ?? loadConfig();
  const log = o.log ?? (() => {});
  const bakeOn = o.bake ?? true;
  let base = '';

  // ---------------------------------------------------------------- libraries
  let scans: LibraryScan[] = [];
  const packages = new Map<string, Package>();
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
      const thumb = newest ? Object.keys(newest.outputs).find((o) => fs.existsSync(path.join(b.dir, 'thumbs', `${o}.png`))) ?? null : null;
      builtinAt.set(b.dir, { from: b.from, thumb });
    }
    return {
      name: BUILTIN_LIBRARY.name, root: BUILTIN_LIBRARY.path, problems: [], workspaces: [],
      packages: list.map((b) => ({ lib: BUILTIN_LIBRARY.name, id: b.id, dir: b.dir, rel: b.id, collection: '', manifest: b.manifest, updated: Date.parse(b.versions.at(-1)?.published ?? '') || 0 })),
    };
  };
  /** the registered workspaces: their files, and the packages inside each (scanned with the libraries) */
  let games: { name: string; dir: string; m: WorkspaceManifest | null; problem?: string; scan: LibraryScan | null }[] = [];
  const rescan = () => {
    forgetScans();
    // the libraries (but those inside a registered workspace) and the workspaces; TopoTopo's built-in library last,
    // read again each time: a built-in package published while the web app runs shows
    const all = scanAll(cfg);
    scans = [...all, scanBuiltin()];
    packages.clear();
    // a package's address is its library's or workspace's name and its id: the first folder of an id keeps it (the scan says so)
    for (const s of scans) for (const p of s.packages) if (!packages.has(keyOf(p))) packages.set(keyOf(p), p);
    games = all.filter((s) => s.workspace).map((s) => {
      try { const m = readWorkspace(s.root); return { name: m.name, dir: s.root, m, scan: s }; }
      catch (e: any) { return { name: s.name, dir: s.root, m: null, problem: e.message, scan: null }; }
    });
  };
  /** The libraries' scans, for the grid: a workspace's packages are on its card. */
  const libraryScans = () => scans.filter((s) => !(s as LibraryScan).workspace);
  /** Read TopoTopo's built-in library again (a few small files), the other libraries as they were scanned. */
  const refreshBuiltin = () => {
    const b = scanBuiltin();
    for (const k of [...packages.keys()]) if (k.startsWith(`${BUILTIN_LIBRARY.name}/`)) packages.delete(k);
    for (const p of b.packages) packages.set(keyOf(p), p);
    scans = [...scans.filter((s) => s.name !== BUILTIN_LIBRARY.name), b];
  };
  const find = (lib: string, id: string) => {
    let p = packages.get(`${lib}/${id}`);
    if (!p) { rescan(); p = packages.get(`${lib}/${id}`); } // made a moment ago, before the watch noticed
    if (!p) throw new HttpError(404, `no package "${id}" in library "${lib}"`);
    return p;
  };

  // ---------------------------------------------------------------- events (SSE) and bakes
  const clients = new Set<http.ServerResponse>();
  const broadcast = (ev: object) => { const m = `data: ${JSON.stringify(ev)}\n\n`; for (const c of clients) c.write(m); };
  const queue = new BakeQueue({
    log,
    onDone: (dir, state) => {
      const p = [...packages.values()].find((x) => x.dir === dir);
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
  rescan();
  for (const p of packages.values()) bakeIfStale(p);

  // A change below a library: a manifest, graphs/, assets/ and inputs/ may need a bake; anything else may be a
  // package made, moved or removed, or attachments: read the libraries again and tell the pages.
  const touched = new Set<string>();
  let changeTimer: ReturnType<typeof setTimeout> | undefined;
  const onChange = () => {
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      const before = [...packages.keys()].join('\n');
      rescan();
      for (const k of touched) { const p = packages.get(k); if (p) bakeIfStale(p); }
      for (const p of packages.values()) if (!readBakeState(p.dir)) bakeIfStale(p);
      broadcast({ changed: [...touched], list: before !== [...packages.keys()].join('\n') });
      touched.clear();
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
        onChange();
      });
      w.on('error', () => w.close());
      w.unref();
      watchers.push(w);
    } catch { /* no folder (a problem on the page) or no recursive watch: the periodic rescan covers it */ }
  }
  const periodic = setInterval(() => { rescan(); for (const p of packages.values()) bakeIfStale(p); }, RESCAN_MS);
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

  // ---------------------------------------------------------------- page data
  const enc = encodeURIComponent;
  const urls: Urls = {
    home: '/',
    package: (lib, id) => `/p/${enc(lib)}/${enc(id)}`,
    thumb: (lib, id, v) => `/p/${enc(lib)}/${enc(id)}/thumb.png${v ? `?v=${enc(String(v))}` : ''}`,
    glb: (lib, id, v) => `/p/${enc(lib)}/${enc(id)}/preview.glb${v ? `?v=${enc(String(v))}` : ''}`,
    embed: (lib, id) => `/embed/${enc(lib)}/${enc(id)}`,
    file: (lib, id, rel) => `/p/${enc(lib)}/${enc(id)}/files/${rel.split('/').map(enc).join('/')}`,
    // TopoTopo's own packages are edited in TopoTopo's repository, not from here
    edit: (lib, id) => (lib === BUILTIN_LIBRARY.name ? null : `/p/${enc(lib)}/${enc(id)}/edit`),
    asset: (name) => `/static/${name}`,
    app: (name) => `/app/${name}`,
    three: '/vendor/three/',
  };
  /** A package's thumbnail of one of its outputs (thumbs/<output>.png, which TopoTopo's built-in packages keep). */
  const outputThumb = (p: Package, output: string) => (fs.existsSync(path.join(p.dir, 'thumbs', `${output}.png`)) ? `/p/${enc(p.lib)}/${enc(p.id)}/thumbs/${enc(output)}.png` : undefined);
  /** The newest version of a package the web app knows of: its home's, in a library or TopoTopo's built-in one. */
  const newestOf = (name: string, homes = packageHomes()) => {
    const home = homes.get(name);
    return home ? publishedVersions(home.dir, name).at(-1)?.version : undefined;
  };
  /** The packages of the libraries and the workspaces that use a package, with the version each uses. */
  const usersOf = (name: string): UserRow[] => [
    ...[...packages.values()].filter((p) => p.manifest.uses[name])
      .map((p) => ({ lib: p.lib, id: p.id, title: p.manifest.title, version: p.manifest.uses[name], url: urls.package(p.lib, p.id) })),
    ...games.filter((g) => g.m?.uses[name]).map((g) => ({ lib: 'workspace', id: g.name, title: `workspace ${g.name}`, version: g.m!.uses[name], url: `${urls.home}#ws-${enc(g.name)}` })),
  ].sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
  /** A registered workspace on the front page: its engine, libraries, packages and the packages it uses. */
  const workspaceCard = (g: (typeof games)[number], homes = packageHomes()): WorkspaceCardData => {
    if (!g.m) return { name: g.name, dir: g.dir, engine: null, libraries: [], packages: [], uses: [], problems: [g.problem ?? 'its file cannot be read'] };
    const e = g.m.engine;
    const libs = resolveListed(g.dir, g.m.libraries);
    const inside = (g.scan?.packages ?? []).map((p) => {
      const at = packages.get(keyOf(p)) === p ? p : null;
      return { title: p.manifest.title, rel: p.rel, ...(at ? { url: urls.package(at.lib, at.id) } : {}), ...(p.manifest.name ? { pkg: p.manifest.name } : {}) };
    });
    const uses = Object.entries(g.m.uses).map(([name, v]) => {
      const newest = newestOf(name, homes), home = homes.get(name);
      return { name, version: v, ...(home ? { url: urls.package(home.lib, home.id) } : {}), ...(newest && compareVersions(newest, v) > 0 ? { newest } : {}) };
    });
    return {
      name: g.name, dir: g.dir,
      engine: e && e !== 'none' ? `${e.type === 'godot' ? 'Godot' : 'Unreal'} · ${e.project}` : null,
      libraries: libs.libs.map((l) => l.name), packages: inside, uses, problems: [...libs.problems, ...(g.scan?.problems ?? []), ...(g.scan?.workspaces.length ? [`other workspaces inside, not scanned: ${g.scan.workspaces.join(', ')}`] : [])],
    };
  };
  const status = (p: Package, s: BakeState | null) => (isBuiltin(p) ? 'ok' : !hasDefault(p) ? 'empty' : queue.pending(p.dir) ? 'baking' : !s ? 'new' : s.ok ? 'ok' : 'failed');
  const cardOf = (p: Package): CardData => {
    const s = readBakeState(p.dir);
    const m = p.manifest;
    // a package: its full name, its newest version and its outputs (its published versions' records)
    const newest = m.name ? publishedVersions(p.dir, m.name).at(-1) : undefined;
    const pkg = m.name ? { name: m.name, version: newest?.version ?? null } : undefined;
    const outputs = m.name && newest ? outputsOf(m.name, newest).map((o) => ({ type: o.type, ...(o.alias ? { alias: o.alias } : {}), label: o.label, ...(o.kind ? { kind: o.kind } : {}), tags: o.tags })) : undefined;
    // the packages it uses, and those of them with a newer version: the card says so
    const uses = Object.keys(m.uses);
    const updates = uses.flatMap((name) => { const n = newestOf(name); return n && compareVersions(n, m.uses[name]) > 0 ? [{ name, version: m.uses[name], newest: n }] : []; });
    // a built-in package's thumbnail changes with its versions, a package's with its bakes
    const version = isBuiltin(p) ? newest?.version ?? '0' : String(s?.at ?? 0);
    return {
      lib: p.lib, id: p.id, title: m.title, collection: p.collection, tags: m.tags, description: m.description, updated: p.updated, status: status(p, s), version,
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
    const isDefault = (o: { graph: string; node: string }) => isDefaultOutput(v, o);
    const row = (type: string, o: VersionInfo['default'], dflt: boolean, output?: string): OutputRow => {
      const thumb = p && output ? outputThumb(p, output) : undefined;
      return {
        type, ...(dflt ? { alias: name } : {}), label: o.label ?? '', ...(o.kind ? { kind: o.kind } : {}), tags: o.tags ?? [],
        graph: o.graph, node: o.node, params: Object.keys(o.sliders), inputs: o.inputs.map((i) => i.label || `input ${i.index}`), ...(thumb ? { thumb } : {}),
      };
    };
    const rows = Object.entries(v.outputs).map(([k, o]) => row(`${name}/${k}`, o, isDefault(o), k));
    // a default output that is no named output is listed by the package's name alone
    if (!Object.values(v.outputs).some(isDefault)) rows.unshift(row(name, v.default, false));
    return rows;
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
    const m = p.manifest, homes = packageHomes();
    const versions = m.name ? publishedVersions(p.dir, m.name) : [];
    // the packages it uses: the version in use (its copy's record), its home's page and the newest version there
    const uses = Object.entries(m.uses).map(([name, v]) => {
      const rec = copyRecord(p.dir, name, v), home = homes.get(name), newest = newestOf(name, homes);
      return { name, version: v, ...(rec ? { note: rec.note, published: rec.published } : {}), ...(home ? { url: urls.package(home.lib, home.id) } : {}), ...(newest && compareVersions(newest, v) > 0 ? { newest } : {}) };
    });
    return {
      ...cardOf(p), builtin, rel: p.rel, place: games.some((g) => g.scan?.packages.includes(p)) ? `the workspace "${p.lib}"` : `library "${p.lib}"`, links: m.links, graph: m.bake.graph ?? m.graph, graphs, created: m.created,
      attachments: listFiles(path.join(p.dir, 'attachments')), exports: listFiles(path.join(p.dir, 'exports')),
      glb: !builtin && fs.existsSync(path.join(webDir(p.dir), 'preview.glb')), bake: s,
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
    if (!['attachments', 'exports'].includes(parts[0]) || parts.length < 2 || parts.some((x) => !x || x === '.' || x === '..' || /[\\/\0]/.test(x)))
      throw new HttpError(400, 'files/ serves attachments/<path> and exports/<path>');
    const root = path.join(p.dir, parts[0]);
    const abs = path.join(root, ...parts.slice(1));
    if (!abs.startsWith(root + path.sep)) throw new HttpError(400, 'the path leaves the package');
    if (!fs.statSync(abs, { throwIfNoEntry: false })?.isFile()) throw new HttpError(404, `no file ${parts.join('/')}`);
    const real = path.relative(fs.realpathSync(root), fs.realpathSync(abs));
    if (real.startsWith('..') || path.isAbsolute(real)) throw new HttpError(400, 'the path leaves the package');
    return abs;
  };

  const readStatic = (dir: string, rel: string) => {
    const p = path.resolve(dir, decodeURIComponent(rel));
    if (!p.startsWith(dir + path.sep) || !fs.statSync(p, { throwIfNoEntry: false })?.isFile()) return null;
    return p;
  };

  // ---------------------------------------------------------------- routes
  const server = http.createServer(async (req, res) => {
    const head = (code: number, type: string, extra: Record<string, string> = {}) =>
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
    const send = (code: number, body: string | Uint8Array, type = 'text/plain; charset=utf-8', extra: Record<string, string> = {}) => { head(code, type, extra); res.end(req.method === 'HEAD' ? undefined : body); };
    // pages may only be framed by the web app itself; the embed page is made to be framed by a board
    const html = (body: string, framable = false) => send(200, body, MIME['.html'], framable ? {} : { 'content-security-policy': "frame-ancestors 'self'" });
    const json = (code: number, body: unknown, extra: Record<string, string> = {}) => send(code, JSON.stringify(body), MIME['.json'], extra);
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
        return html(frontPage({ libraries: libraryScans().map((s) => ({ name: s.name, cards: s.packages.filter((p) => packages.get(keyOf(p)) === p).map(cardOf), ...(s.name === BUILTIN_LIBRARY.name ? { builtin: true } : {}) })), workspaces: games.map((g) => workspaceCard(g)), problems: libraryScans().flatMap((s) => s.problems) }, urls));
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
      if (seg[0] === 'embed' && seg.length === 3) {
        const p = find(decodeURIComponent(seg[1]), decodeURIComponent(seg[2]));
        const c = cardOf(p);
        const glb = !isBuiltin(p) && fs.existsSync(path.join(webDir(p.dir), 'preview.glb'));
        return html(embedPage({ lib: p.lib, id: p.id, title: p.manifest.title, glb, version: c.version, packageUrl: urls.package(p.lib, p.id) }, urls), true);
      }
      if (seg[0] === 'p' && seg.length >= 3) {
        const p = find(decodeURIComponent(seg[1]), decodeURIComponent(seg[2]));
        const rest = seg.slice(3);
        if (!rest.length || (rest.length === 1 && !rest[0])) return html(packagePage(packageData(p), urls));
        // a package's thumbnail of one of its outputs (thumbs/<output>.png), nothing else of that folder
        if (rest[0] === 'thumbs' && rest.length === 2) {
          const name = decodeURIComponent(rest[1]);
          const file = /^[a-z0-9][a-z0-9_-]*\.png$/.test(name) ? path.join(p.dir, 'thumbs', name) : '';
          if (!file || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw new HttpError(404, `no thumbnail ${name}`);
          return send(200, fs.readFileSync(file), 'image/png', { 'cache-control': 'max-age=3600' });
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
        if (rest[0] === 'files' && rest.length > 1) {
          const abs = packageFile(p, rest.slice(1).join('/'));
          const ext = path.extname(abs).toLowerCase();
          const disp: Record<string, string> = INLINE.has(ext) ? {} : { 'content-disposition': `attachment; filename="${path.basename(abs).replace(/["\\\r\n]/g, '_')}"` };
          return send(200, fs.readFileSync(abs), FILE_TYPES[ext] ?? 'application/octet-stream', { ...disp, 'content-security-policy': 'sandbox' });
        }
        if ((rest[0] === 'edit' || rest[0] === 'bake') && isBuiltin(p)) throw new HttpError(400, 'TopoTopo\'s built-in packages are not edited or baked here: TopoTopo\'s repository publishes them');
        if (rest[0] === 'edit') {
          const url = await editorFor(p);
          res.writeHead(302, { location: url, 'cache-control': 'no-store' });
          return res.end();
        }
        if (rest[0] === 'bake') {
          if (req.method !== 'POST') throw new HttpError(405, 'POST to bake again');
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
      const code = e instanceof HttpError ? e.status : 500;
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
  return {
    url: base + '/', port: actual, rescan, queue,
    close: () => {
      clearInterval(periodic);
      clearInterval(keepAlive);
      clearTimeout(changeTimer);
      for (const w of watchers) w.close();
      queue.close();
      for (const e of editors.values()) e.child.kill();
      for (const c of clients) c.end();
      server.close();
      server.closeAllConnections?.();
    },
  };
}
