// The project's packages in the live viewer (the registry is src/gallery/packages.ts, Update's before/after
// src/gallery/update.ts): what the page's Packages tab shows, each package the project uses with the version in use and
// its outputs' kinds and tags, the updates its libraries have and their notes, its working folder and whether this
// session follows it; the before/after of an update, with progress events and a stop of its own (its cooks are not the
// workspace's, so the workspace's stop does not reach them); applying it; and the follow switch. Following lasts as
// long as the viewer and is never saved. The working folders of the packages the project uses are watched: a save in
// one the session follows cooks the graphs that use it again, a save in another is told to the pages (they offer to
// follow it), and a version published there is a new update.
//
//   GET  /api/packages               the project and its packages (project null: the graphs are in no project)
//   POST /api/packages/compare       {package, to?}: the before/after, answered when it is done or stopped
//   GET  /api/packages/compare       the last before/after in full, and the one in progress
//   GET  /api/packages/compare/geo   ?id&place&side=a|b|overlay: a place cooked with one version, or both overlaid
//   POST /api/packages/stop          stop the before/after at its next node; what was compared stays
//   POST /api/packages/update        {package, from, to}: apply the update; the graphs that use it cook again
//   POST /api/packages/follow        {package, on}: use its working folder instead of its copy for this session, or stop
//   POST /api/packages/dismiss       {package}: drop the list of what the graphs must change kept after a big update
// Events: {packages: n} when what the tab shows changed, with saved: "owner/name" after a save in the working folder of
// a package the session does not follow; {compare: {...}} the progress of a before/after and its end.
import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import type { Geometry } from '../core/geometry.ts';
import { diffOverlay } from '../explain.ts';
import { packagesNamedIn, packagesUsed } from '../graph/packages.ts';
import type { Scope } from '../graph/scope.ts';
import { readManifest } from '../gallery/library.ts';
import { ProjectPackages, compareVersions, loadProject, startsBigVersion } from '../gallery/packages.ts';
import type { VersionInfo } from '../gallery/packages.ts';
import { applyUpdate, beforeAfter, setText } from '../gallery/update.ts';
import type { BeforeAfter, CookedSide, UsePlace } from '../gallery/update.ts';
import { previewGLB } from '../render/preview.ts';
import type { Workspace } from '../workspace.ts';

/** A version on a package's card: its number, note and date; `big` when it starts a big version, `marked` by its author. */
export interface VersionRow { version: string; note: string; published: string; big: boolean; marked: boolean }

/** A package on the Packages tab. */
export interface PackageRow {
  package: string;
  /** the version in use (project.json "uses"); null for a package the session follows without using it yet */
  version: string | null;
  /** the note and date of the version in use, from the project's copy */
  note?: string;
  published?: string;
  /** the outputs of the version in use (its copy's record) with their kinds and tags: "owner/name/output", or "owner/name" for a default output that is no named output */
  outputs?: { type: string; label?: string; kind?: string; tags: string[] }[];
  /** the small update (the newest version with the same big number) and the big one */
  small?: string;
  big?: string;
  /** every version after the one in use, oldest first */
  newer: VersionRow[];
  /** the libraries that hold it, as project.json lists them */
  libraries: string[];
  /** its working folders in those libraries: the follow switch needs exactly one */
  working: { library: string; dir: string }[];
  /** the working folder this session follows, null while it cooks from its copy */
  followed: { library: string; dir: string } | null;
  /** why its versions could not be looked up */
  error?: string;
  /** after a big update applied in this viewer: what the graphs must change for it, until the person dismisses it */
  mustChange?: { from: string; to: string; items: string[] };
}

/** A before/after in progress (the {compare} events), or how it ended. */
export interface CompareProgress {
  id: string;
  package: string;
  from: string;
  to: string;
  big: boolean;
  /** cooks done, of all (two per place), and what cooks now */
  done: number;
  total: number;
  what: string;
  /** ms since it started */
  elapsed: number;
  running: boolean;
  /** a stop was asked for: the node cooking runs to its end */
  stopping: boolean;
  stopped?: boolean;
  /** a newer before/after took its place */
  superseded?: boolean;
  error?: string;
}

export interface PackagesState {
  /** null: the viewer's graphs are in no project (nothing to show) */
  project: { id: string; label: string; dir: string; libraries: string[] } | null;
  packages: PackageRow[];
  problems: string[];
  /** the before/after in progress, and the last one finished (GET /api/packages/compare has it in full) */
  running: CompareProgress | null;
  compare: { id: string; package: string; from: string; to: string } | null;
}

/** What a version holds besides its record: a change there is a save of the working folder (and versions/ a publish). */
const SAVED = new Set(['project.json', 'graphs', 'assets', 'inputs', 'packages']);

function err(status: number, message: string): never { throw Object.assign(new Error(message), { status }); }
/** The registry's errors say what is wrong and what to do: they are the request's (400). */
function asked<T>(f: () => T): T {
  try { return f(); } catch (e: any) { if (typeof e?.status === 'number') throw e; return err(400, String(e?.message ?? e)); }
}
const sameDir = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const versionRow = (v: VersionInfo): VersionRow => ({ version: v.version, note: v.note, published: v.published, big: startsBigVersion(v.version), marked: !!v.big });
/** A version's outputs by the node type a graph names them with, with their kinds and tags (PackageRow.outputs). */
const outputRows = (pkg: string, v: VersionInfo): NonNullable<PackageRow['outputs']> => {
  const row = (type: string, o: VersionInfo['default']) => ({ type, ...(o.label ? { label: o.label } : {}), ...(o.kind ? { kind: o.kind } : {}), tags: o.tags ?? [] });
  const rows = Object.entries(v.outputs).map(([k, o]) => row(`${pkg}/${k}`, o));
  return Object.values(v.outputs).some((o) => o.graph === v.default.graph && o.node === v.default.node) ? rows : [row(pkg, v.default), ...rows];
};
const byName = <T extends { package: string }>(a: T, b: T) => (a.package < b.package ? -1 : a.package > b.package ? 1 : 0);

export function createPackages(ws: Workspace, broadcast: (ev: object) => void) {
  const pk = ws.packages instanceof ProjectPackages ? ws.packages : null;
  let closed = false, n = 0, shown = '', lastStamp = '';
  /** what the graphs must change for a big update applied in this viewer, by package */
  const kept = new Map<string, { from: string; to: string; items: string[] }>();

  /** The project's packages, or the reason there are none to work with (400). */
  const need = (): ProjectPackages => {
    if (!pk) err(400, 'this viewer opened no project: its graphs use no packages (topotopo edit <project folder>, or topotopo view <graph.json> on a graph in a project)');
    asked(() => pk.project());
    return pk;
  };

  // ---------------------------------------------------------------- the state
  function state(): PackagesState {
    const base = { running: run?.progress ?? null, compare: last ? { id: last.id, package: last.result.target.package, from: last.result.target.from, to: last.result.target.to } : null };
    if (!pk?.dir) return { project: null, packages: [], problems: [], ...base };
    pk.refresh();
    if (!pk.manifest) return { project: { id: '', label: pk.label, dir: pk.dir, libraries: [] }, packages: [], problems: [pk.error ?? `${pk.dir}: project.json cannot be read`], ...base };
    const problems: string[] = [];
    let outdated: ReturnType<ProjectPackages['outdated']> = [];
    try { outdated = pk.outdated(); } catch (e: any) { problems.push(e.message); }
    const following = new Map(pk.following().map((f) => [f.package, { library: f.library, dir: f.dir }]));
    const packages: PackageRow[] = outdated.map((o) => {
      const info = pk.copyInfo(o.package, o.version);
      return {
        package: o.package, version: o.version, ...(info ? { note: info.note, published: info.published, outputs: outputRows(o.package, info) } : {}),
        ...(o.small ? { small: o.small } : {}), ...(o.big ? { big: o.big } : {}),
        newer: o.newer.map(versionRow), libraries: o.libraries, working: o.working, followed: following.get(o.package) ?? null,
        ...(o.error ? { error: o.error } : {}), ...(kept.has(o.package) ? { mustChange: kept.get(o.package) } : {}),
      };
    });
    // a package followed before the project uses it (a working folder without a published version, say)
    for (const [p, f] of following) if (!packages.some((r) => r.package === p)) packages.push({ package: p, version: null, newer: [], libraries: [f.library], working: [f], followed: f });
    problems.push(...pk.check());
    return { project: { id: pk.manifest.id, label: pk.label, dir: pk.dir, libraries: pk.manifest.libraries }, packages: packages.sort(byName), problems: [...new Set(problems)], ...base };
  }

  /** Tell the pages that what the tab shows changed (`force`: after something a page did), and watch its folders. */
  function changed(force = false) {
    if (closed) return;
    let s: PackagesState;
    try { s = state(); } catch { return; }
    rewatch(s.packages);
    lastStamp = stamp();
    const key = JSON.stringify({ ...s, running: null, compare: null });
    if (!force && key === shown) return;
    shown = key;
    broadcast({ packages: ++n });
  }

  /** What can change the state without the viewer: project.json, the lock, the versions published in the working folders. */
  const stamp = () => {
    if (!pk?.dir) return '';
    const published = [...watchers.keys()].map((d) => { try { return fs.readdirSync(path.join(d, 'versions')).sort().join(','); } catch { return '-'; } });
    return `${pk.revision()}|${published.join(';')}|${pk.following().map((f) => f.package).join(',')}`;
  };
  const check = () => { if (!closed && stamp() !== lastStamp) changed(); };
  let soonTimer: ReturnType<typeof setTimeout> | undefined;
  const soon = () => { clearTimeout(soonTimer); soonTimer = setTimeout(check, 250); soonTimer.unref?.(); };
  // in a project: a build, an edit or the library tool may add a package or update one; another process may too (the timer)
  const onGraph = () => soon();
  const timer = pk?.dir ? setInterval(check, 2000) : undefined;
  if (timer) { ws.listeners.add(onGraph); timer.unref(); }

  // ---------------------------------------------------------------- the working folders
  const watchers = new Map<string, { w: fs.FSWatcher; pkg: string }>();
  const saves = new Map<string, ReturnType<typeof setTimeout>>();
  function rewatch(rows: PackageRow[]) {
    const want = new Map<string, string>();
    for (const r of rows) for (const w of [...r.working, ...(r.followed ? [r.followed] : [])]) want.set(path.resolve(w.dir), r.package);
    for (const [dir, x] of watchers) if (want.get(dir) !== x.pkg) { x.w.close(); watchers.delete(dir); }
    for (const [dir, p] of want) {
      if (watchers.has(dir)) continue;
      try {
        const w = fs.watch(dir, { recursive: true }, (_ev, f) => onWorking(p, f ? String(f) : ''));
        w.on('error', () => { w.close(); if (watchers.get(dir)?.w === w) watchers.delete(dir); });
        w.unref();
        watchers.set(dir, { w, pkg: p });
      } catch { /* not watchable: the timer still sees versions published there */ }
    }
  }
  /** A change in a package's working folder: a publish (versions/), a save, or something a version does not hold. */
  function onWorking(pkg: string, rel: string) {
    const parts = rel.split(/[\\/]+/);
    if (!rel || path.isAbsolute(rel) || parts[0] === 'versions') { soon(); return; }
    if (!SAVED.has(parts[0]) || parts.some((x) => x.startsWith('.'))) return;
    // a folder the session follows cooks the graphs again (pk.watch below); a save in another is offered to the person
    const followed = () => !!pk?.following().some((f) => f.package === pkg);
    if (followed()) return;
    clearTimeout(saves.get(pkg));
    const t = setTimeout(() => {
      saves.delete(pkg);
      if (!closed && !followed()) broadcast({ packages: ++n, saved: pkg });
    }, 300);
    t.unref?.();
    saves.set(pkg, t);
  }

  // ---------------------------------------------------------------- cooking the scene again
  /** The graphs that use any of the packages: they name one (in nested graphs too) or use it through assets and graph_ref. */
  const usersOf = (pkgs: string[]) => [...ws.graphs].filter(([, g]) => {
    if (packagesNamedIn(g).some((p) => pkgs.includes(p))) return true;
    let used: string[] = [];
    try { used = Object.keys(packagesUsed(ws.engine, g)); } catch { /* it resolves nothing */ }
    return used.some((k) => pkgs.some((p) => k.startsWith(`${p}@`)));
  }).map(([name]) => name);
  const queue = new Set<string>();
  let recooking: Promise<void> | null = null;
  /** Cook the graphs as a whole again, one after the other, and have the pages read them; graphs asked for meanwhile follow. */
  function recook(graphs: string[]): Promise<void> {
    for (const g of graphs) queue.add(g);
    recooking ??= (async () => {
      try {
        while (queue.size && !closed) {
          const g = queue.values().next().value!;
          queue.delete(g);
          if (!ws.graphs.has(g)) continue;
          // a failure is the graph's report (its nodes show it); the page reads the graph again either way
          try { await ws.cook(g); } catch { /* reported */ }
          ws.bump(g);
        }
      } finally { recooking = null; }
    })();
    return recooking;
  }
  // a save in a working folder this session follows: refresh() has taken it in, the graphs that use it cook again
  if (pk) pk.watch(() => { soon(); void recook(usersOf(pk.following().map((f) => f.package))); });

  // ---------------------------------------------------------------- the before/after
  interface Run { id: string; signal: { aborted: boolean }; t0: number; progress: CompareProgress; done: Promise<void> }
  interface Done { id: string; result: BeforeAfter; glb: Map<string, Promise<Uint8Array>> }
  let run: Run | null = null, last: Done | null = null, seq = 0, projectScope: Scope | null = null;
  const send = (r: Run) => { r.progress.elapsed = performance.now() - r.t0; broadcast({ compare: r.progress }); };

  /**
   * Where the project's graphs and assets cook: the engine's root when the workspace is the project folder (the MCP
   * server, topotopo edit), else (topotopo view keeps its workspace in a scratch folder) a scope of the project folder
   * with its graphs and assets, read again for each before/after.
   */
  const projectOption = (p: ProjectPackages) => {
    if (sameDir(path.resolve(ws.dir), p.dir!)) return {};
    projectScope ??= ws.engine.createScope(`project ${p.dir}`, { folder: p.dir!, packages: p.resolver });
    loadProject(ws.engine, p.dir!, projectScope);
    return { project: { scope: projectScope, folder: p.dir! } };
  };

  /**
   * The before/after of updating `pkg` (to `to`, else the newest version with the same big number), with progress
   * events. One runs at a time: a newer one stops the one before. The person's values tuned without saving play no part:
   * like the CLI's and the agent's, it compares the project as its files hold it, which is what Update changes.
   */
  async function compare(pkg: string, to: string | undefined) {
    const p = need();
    if (run) {
      const before = run;
      before.progress.superseded = true;
      before.signal.aborted = true;
      await before.done;
    }
    const target = asked(() => p.updateTarget(pkg, to));
    let finish!: () => void;
    const id = String(++seq), signal = { aborted: false };
    const r: Run = {
      id, signal, t0: performance.now(), done: new Promise<void>((resolve) => { finish = resolve; }),
      progress: { id, package: pkg, from: target.from, to: target.to, big: target.big, done: 0, total: 0, what: 'finding the places the project uses it', elapsed: 0, running: true, stopping: false },
    };
    run = r;
    send(r);
    try {
      const result = await beforeAfter(p, pkg, {
        to: target.to, signal,
        progress: (done, total, what) => { Object.assign(r.progress, { done, total, what }); send(r); },
        ...projectOption(p),
      });
      Object.assign(r.progress, { stopped: result.stopped, done: result.compared.length * 2, total: result.total, what: '' });
      if (r.progress.superseded) err(409, 'a newer before/after took the place of this one');
      last = { id, result, glb: new Map() };
      return summary(last);
    } catch (e: any) {
      if (!r.progress.superseded) r.progress.error = String(e?.message ?? e);
      throw typeof e?.status === 'number' ? e : Object.assign(e instanceof Error ? e : new Error(String(e)), { status: 400 });
    } finally {
      if (run === r) run = null;
      r.progress.running = false;
      r.progress.stopping = false;
      send(r);
      finish();
    }
  }

  const sideOf = (s: CookedSide) => ({ ok: s.ok, errors: s.errors, warnings: s.warnings, cooked: s.cooked });
  const useOf = (u: UsePlace) => ({ node: u.node, type: u.type, set: setText(u.spec).trim() });
  /** A before/after for the page: every place and what changed in each, without the geometry (compare/geo serves it). */
  function summary(d: Done) {
    const r = d.result, t = r.target;
    return {
      ok: true, id: d.id, project: r.project, stopped: r.stopped, ms: Math.round(r.ms), comparisons: r.total / 2,
      target: { package: t.package, from: t.from, to: t.to, big: t.big, up: compareVersions(t.to, t.from) > 0, library: t.library, between: t.between.map(versionRow) },
      interfaceBig: r.interfaceBig, interfaceSmall: r.interfaceSmall, mustChange: r.mustChange, problems: r.problems,
      uses: r.uses.map((u) => ({ file: u.file, kind: u.kind, ...useOf(u) })),
      places: r.compared.map((c, index) => ({
        index, file: c.file, kind: c.kind, node: c.node, uses: c.uses.map(useOf), before: sideOf(c.before), after: sideOf(c.after),
        diff: c.diff ? { text: c.diff.text, identical: c.diff.identical, verdict: /^verdict: (.*)$/m.exec(c.diff.text)?.[1] ?? '', hausdorff: Number.isFinite(c.diff.hausdorff) ? c.diff.hausdorff : null } : null,
        notes: c.notes,
        // what the view can show: each side that cooked, and the overlay when both have points to compare
        views: { a: !!c.before.geo, b: !!c.after.geo, overlay: !!(c.geo && c.geo[0].numPoints && c.geo[1].numPoints) },
      })),
    };
  }

  /** The overlay as the view draws it: diffOverlay's colours, without the materials that would tint them. */
  const overlayOf = (a: Geometry, b: Geometry) => {
    const g = diffOverlay(a, b);
    g.table('prim').delete('material');
    g.table('detail').delete('materials');
    return g;
  };
  /** A place of the last before/after as a GLB: side a (the version in use), b (the new one), or both overlaid. */
  function placeGLB(d: Done, place: number, side: string): Promise<Uint8Array> {
    const c = d.result.compared[place] ?? err(404, `this before/after has no place ${place}`);
    const t = d.result.target, key = `${place}:${side}`;
    let bytes = d.glb.get(key);
    if (!bytes) {
      const failed = (v: string, s: CookedSide) => err(422, `with ${t.package} ${v} it does not cook: ${s.errors.join('; ') || 'no geometry'}`);
      let geo: Geometry;
      if (side === 'a') geo = c.before.geo ?? failed(t.from, c.before);
      else if (side === 'b') geo = c.after.geo ?? failed(t.to, c.after);
      else if (side === 'overlay') {
        if (!c.geo || !c.geo[0].numPoints || !c.geo[1].numPoints) err(422, 'no overlay: it needs points cooked with both versions');
        geo = overlayOf(c.geo[0], c.geo[1]);
      } else return err(400, 'side is a (the version in use), b (the new version) or overlay');
      bytes = previewGLB(geo);
      d.glb.set(key, bytes);
      bytes.catch(() => d.glb.delete(key));
    }
    return bytes;
  }

  // ---------------------------------------------------------------- Update and follow
  async function update(pkg: string, from: unknown, to: unknown) {
    const p = need();
    if (typeof from !== 'string' || typeof to !== 'string') err(400, '"from" and "to" are required: the versions of the before/after the person saw');
    if (run?.progress.package === pkg) { run.signal.aborted = true; await run.done; }
    const now = asked(() => readManifest(p.dir!).uses[pkg]);
    if (now !== from) err(409, now === undefined ? `this project does not use ${pkg} now: look at its packages again` : `project.json uses ${pkg} ${now} now, not ${from}: look at the before/after again`);
    const r = asked(() => applyUpdate(p, pkg, to));
    if (r.mustChange.length) kept.set(pkg, { from, to: r.target.to, items: r.mustChange });
    else kept.delete(pkg);
    if (last?.result.target.package === pkg) last = null;
    changed(true);
    void recook(usersOf([pkg]));
    return { ok: true, text: r.text, package: pkg, from: r.target.from, to: r.target.to, big: r.target.big, mustChange: r.mustChange };
  }

  function follow(pkg: string, on: boolean) {
    const p = need();
    const text = asked(() => p.follow(pkg, on));
    changed(true);
    void recook(usersOf([pkg]));
    return { ok: true, text, followed: p.following().some((f) => f.package === pkg) };
  }

  // the first look, without telling the pages: they ask when they open
  try { const s = state(); rewatch(s.packages); shown = JSON.stringify({ ...s, running: null, compare: null }); lastStamp = stamp(); } catch { /* the next check tries again */ }

  return {
    /** what the Packages tab shows (GET /api/packages) */
    state,
    close() {
      closed = true;
      if (run) run.signal.aborted = true;
      clearInterval(timer);
      clearTimeout(soonTimer);
      for (const t of saves.values()) clearTimeout(t);
      for (const x of watchers.values()) x.w.close();
      watchers.clear();
      ws.listeners.delete(onGraph);
      pk?.unwatch();
      last = null;
    },
    async handle(req: http.IncomingMessage, res: http.ServerResponse, u: URL, readJSON: (r: http.IncomingMessage) => Promise<any>): Promise<boolean> {
      if (u.pathname !== '/api/packages' && !u.pathname.startsWith('/api/packages/')) return false;
      const json = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
      try {
        const gets = ['/api/packages', '/api/packages/compare', '/api/packages/compare/geo'];
        const posts = ['/api/packages/compare', '/api/packages/stop', '/api/packages/update', '/api/packages/follow', '/api/packages/dismiss'];
        if (!gets.includes(u.pathname) && !posts.includes(u.pathname)) err(404, `no route ${u.pathname}`);
        if (req.method === 'GET' || req.method === 'HEAD') {
          if (u.pathname === '/api/packages') { json(200, state()); return true; }
          if (u.pathname === '/api/packages/compare') { json(200, { compare: last ? summary(last) : null, running: run?.progress ?? null }); return true; }
          if (u.pathname === '/api/packages/compare/geo') {
            const id = u.searchParams.get('id'), place = Number(u.searchParams.get('place') || NaN);
            if (!last || last.id !== id) err(404, 'this before/after is no longer the last one: run it again');
            if (!Number.isInteger(place) || place < 0) err(400, 'place is the index of a place in the before/after');
            const bytes = await placeGLB(last, place, u.searchParams.get('side') ?? '');
            res.writeHead(200, { 'content-type': 'model/gltf-binary', 'cache-control': 'no-store' });
            res.end(bytes);
            return true;
          }
          err(405, 'POST required');
        }
        if (req.method !== 'POST' || !posts.includes(u.pathname)) err(405, 'GET required');
        const body = await readJSON(req) ?? {};
        if (u.pathname === '/api/packages/stop') {
          if (run) { run.signal.aborted = true; run.progress.stopping = true; send(run); }
          json(200, { ok: true, stopping: !!run });
          return true;
        }
        const pkg = body.package;
        if (typeof pkg !== 'string' || !pkg) err(400, '"package" is required: "owner/name", a package the project uses (GET /api/packages lists them)');
        if (u.pathname === '/api/packages/compare') {
          if (body.to !== undefined && typeof body.to !== 'string') err(400, '"to" is a version, such as "2.0"');
          json(200, await compare(pkg, body.to));
        } else if (u.pathname === '/api/packages/update') json(200, await update(pkg, body.from, body.to));
        else if (u.pathname === '/api/packages/follow') json(200, follow(pkg, body.on !== false));
        else {
          kept.delete(pkg);
          changed(true);
          json(200, { ok: true });
        }
      } catch (e: any) {
        if (res.headersSent || res.destroyed) return true;
        json(typeof e?.status === 'number' ? e.status : 500, { ok: false, error: String(e?.message ?? e) });
      }
      return true;
    },
  };
}
