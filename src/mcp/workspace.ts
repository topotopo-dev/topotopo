// The `workspace` tool: the workspace around the open package (its packages, found by scanning it, and the shared
// libraries it lists), the person's registered workspaces and libraries (src/web/library.ts), and the packages the open
// package uses (src/packages/registry.ts, src/packages/update.ts). An agent lists and searches them, reads a package,
// makes new ones, edits their manifest (<id>.topo), bakes previews, and opens a package: the server's folder becomes
// that package's folder, so build/edit/render/export work on it; or it makes the server's folder a package (init), when
// the person says so: only a package's graphs use packages. In the open package it publishes a version (or a dry run of
// one), searches the outputs of every place it looks in and says which the package can use, lists and adds the
// packages it uses, follows a package's working folder for the session, says which packages are out of date, and shows
// the before/after of an update, which it applies only when the person says so. It changes the shared libraries the
// workspace lists when the person says so; registering a library stays the person's act (the CLI).
import fs from 'node:fs';
import path from 'node:path';
import type { Session } from '../session.ts';
import type { ToolDef, ToolResult, Content } from './tools.ts';
import { loadConfig } from '../config.ts';
import { initPackage, locate, manifestFile, oldManifestAbove, ownPackageName, parseManifest, program, packageDirOf, packageId, readManifest, withPackageLock, within, writeManifest } from '../package.ts';
import { createPackage, graphNames, isStale, listFiles, readBakeState, readGraph, scanAll, scanLibrary, workspaceRef } from '../web/library.ts';
import type { PlaceRef } from '../web/library.ts';
import type { WebConfig } from '../config.ts';
import type { LibraryScan, Package } from '../web/library.ts';
import { KINDS } from '../graph/outputs.ts';
import { NothingToUpdate, packageText, packagesText, publishPackage, publishText, searchPackages, searchText } from '../packages/registry.ts';
import type { PackageUses } from '../packages/registry.ts';
import { applyUpdate, beforeAfter, beforeAfterText, outdatedText, overlayRenders, removePackage } from '../packages/update.ts';

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) });

export interface WorkspaceToolHost {
  /** the session the other tools use now (its folder, graphs, assets and engine) */
  session(): Session;
  /** the packages used by the package that holds the session's folder */
  packages(): PackageUses;
  /** make a folder the one every tool (and the live viewer) works in */
  open(dir: string): Promise<{ graphs: number; assets: number }>;
}

export function workspaceTool(host: WorkspaceToolHost): ToolDef {
  /**
   * The registered libraries and workspaces, scanned, and the open package's workspace when it is not registered
   * (its packages are found by name as a workspace's: {library: "<workspace name>", id}).
   */
  const scan = (): { cfg: WebConfig; scans: LibraryScan[]; places: PlaceRef[] } => {
    const cfg = loadConfig(), scans = scanAll(cfg);
    const places: PlaceRef[] = [...cfg.libraries.filter((l) => !cfg.workspaces.some((w) => within(l.path, w.path))), ...cfg.workspaces.map(workspaceRef)];
    const ws = locate(host.session().dir).workspace;
    if (ws && !scans.some((s) => s.workspace && path.resolve(s.root) === path.resolve(ws))) {
      const ref = workspaceRef({ name: path.basename(ws), path: ws });
      scans.push(scanLibrary(ref));
      places.push(ref);
    }
    return { cfg, scans, places };
  };
  const urlsOf = (cfg: WebConfig, p: Package) => {
    const b = `http://127.0.0.1:${cfg.web.port}`;
    return { page: `${b}/p/${p.lib}/${p.id}`, embed: `${b}/embed/${p.lib}/${p.id}`, thumb: `${b}/p/${p.lib}/${p.id}/thumb.png` };
  };
  const currentDir = () => packageDirOf(host.session().dir);
  const statusOf = (p: Package) => { const s = readBakeState(p.dir); return !s ? 'not baked' : !s.ok ? 'bake failed' : isStale(p) ? 'stale' : 'baked'; };
  /**
   * {library, id}, {path}, or nothing (the open package). The libraries are scanned for an id; for a folder, only to
   * name the library it is in (a config that cannot be read leaves that out).
   */
  const pick = (a: any, scans: () => LibraryScan[]): Package => {
    if (a.id) {
      const hits = scans().flatMap((s) => s.packages).filter((p) => p.id === a.id && (!a.library || p.lib === a.library));
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) throw new Error(`id "${a.id}" is in several libraries (${hits.map((p) => p.lib).join(', ')}): give "library"`);
      throw new Error(`no package "${a.id}"${a.library ? ` in "${a.library}"` : ''}. workspace {action:"list"} lists them`);
    }
    const dir = a.path ? packageDirOf(path.resolve(a.path)) : currentDir();
    if (!dir) throw new Error(a.path ? `${a.path}: no .topo file there or above${oldManifestAbove(path.resolve(a.path))}` : `give {library, id}: the server's folder is in no package (workspace {action:"init"} makes it one, when the person says so)${oldManifestAbove(host.session().dir)}`);
    let all: Package[] = [];
    try { all = scans().flatMap((s) => s.packages); } catch { /* named without its library */ }
    const p = all.find((x) => x.dir === dir);
    if (p) return p;
    // a package folder outside the configured libraries still works
    return { lib: '', id: packageId(dir), dir, rel: path.basename(dir), collection: '', manifest: readManifest(dir), updated: 0 };
  };

  return {
    name: 'workspace',
    description: 'Three words: a workspace is a folder tree (topotopo-workspace.json at its root; best inside the engine\'s content folder: the Godot project folder, Unreal\'s Content/); a package is a folder of graphs and the models they make, marked by one <id>.topo file, and every folder of a workspace with one is a package of it; a library is a registered folder of packages shared across workspaces, which a workspace lists to use it (TopoTopo ships one built in, always there). Packages in a workspace find each other by themselves; outside a workspace a package finds packages in every registered library. This tool works on the workspace around the open package, the person\'s registered workspaces and libraries (the web app shows them; a board links to them) and the packages the open package uses and publishes. A package holds <id>.topo (title, description, tags, links to concept art and board pages) and its own graphs/, assets/, inputs/, exports/ and attachments/ (concept art and references). ' +
      'list {query?, tag?, library?}: every package of the registered libraries and workspaces (and of the open package\'s workspace) with status and web app URL. get {library, id} (or the open package; library: a library\'s or a workspace\'s name): manifest, graphs and vars, attachments, exports, bake state, URLs; thumbnail:true adds the baked image. ' +
      'open {library, id} | {path}: make that package the folder every tool and the live viewer work in, then build/edit/render/export work in it. create {library, path:"props/lantern", title?, description?, tags?, links?}: a new package in a library or a workspace (by its name), opened. ' +
      'show: the workspace around the open package: its engine project, the shared libraries it lists, its packages. libraries {add?, remove?}: the shared libraries the open package\'s workspace lists (topotopo-workspace.json "libraries"); with neither, what it lists and where its packages find packages; add / remove a registered library\'s name or a folder outside the workspace (a relative path is read from the server\'s folder), only when the person names the library (registering a new library is the person\'s own act: topotopo library add <name> <folder>). init_workspace {path, name?, engine?, libraries?, follow?} makes a folder (path: its root, as the person names it) a workspace (topotopo-workspace.json; the engine project at or above it found, else one below; its packages then share one copy of each package, in topotopo-packages/, and their own copies move there), when the person says so. ' +
      'init {name?}: make the server\'s folder a package (<id>.topo, graphs/main.json, .gitignore, .gitattributes), when it is none and the person says so: only a package\'s graphs use packages (TopoTopo\'s own included), and a build outside any package that names one fails saying so. ' +
      'set {library?, id?, title?, description?, tags?, links?, graph?, bake?, name?}: edit the manifest (graph = the graph its page shows; bake = {graph?, node?, frame?} what its preview shows; name = "owner/name", the name the package publishes under, set once by its author). bake {library?, id?}: render thumb.png and preview.glb now (the web app also bakes on its own after changes). ' +
      `The packages of the open package: packages (what it uses and can use, one line each: version, outputs, up to date or the newer version that is out, the place that has it), packages {package} (one package: its versions and notes, its outputs with their kinds, tags, params and inputs); search {query?, kind?, tag?}: the outputs of every place the package looks in (its workspace, the shared libraries the workspace lists, TopoTopo\'s built-in one; outside a workspace every registered library) by words, kind (${KINDS.join(', ')}) and tag, each with its full name, kind, tags, label, version and description, and whether the package can use it; in a workspace also the registered libraries it does not list, with the libraries action that would list one; use {package:"owner/name", version?} adds one (a graph that names "owner/name/output" adds it too); remove {package} removes one no graph of the package names; follow {package, on} uses a package\'s working folder instead of its copy for this session. ` +
      'publish {dry_run:true, note?, big?} is a dry run: every check and cook, the version number it would get, its changes, blocks and warnings, nothing written. Publishing is permanent: run the dry run first, show it to the person, and publish {note, big?} only when they say so. ' +
      'outdated: the packages it uses that have newer versions, with their notes, and one line for those up to date. check: cook what the workspace relies on (the newest version of its packages that publish, every graph of the others, the newest versions in the shared libraries it lists; outside a workspace the package and its library), and list what broke and why; it changes nothing but missing .gdignore files (after a TopoTopo update, say). update {package, to?}: the before/after of updating it (to the newest version with the same big number; a big version needs "to"): every place the package uses it, cooked with the version in use and the new one, what changed in each, overlay renders, the notes of the versions between and, for a big version, what the graphs must change. It writes nothing. Show the before/after to the person and apply it only when they say so: update {package, from, to, apply:true} (the versions of the before/after they saw) copies the new version in, updates the uses and the lock, and deletes the copies nothing uses any more. See help topics "workspace" and "packages".',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'open', 'create', 'init', 'init_workspace', 'show', 'libraries', 'set', 'bake', 'packages', 'search', 'use', 'remove', 'follow', 'publish', 'outdated', 'check', 'update'] },
        library: { type: 'string', description: 'a library\'s or a workspace\'s name (list shows them)' },
        id: { type: 'string', description: 'package id' },
        path: { type: 'string', description: 'create: folder below the library ("props/lantern"); open/get: a package folder on disk instead of {library, id}' },
        query: { type: 'string', description: 'list: words to match in title, id, collection, description, tags; search: words each of which must start a word of a published output\'s full name, label, description or tags, or of its package\'s title or package tags' },
        tag: { type: 'string', description: 'list: only packages with this tag; search: only outputs with this tag' },
        kind: { type: 'string', enum: [...KINDS], description: 'search: only outputs of this kind' },
        dry_run: { type: 'boolean', description: 'publish: a dry run, which writes nothing: every check, every output cooked, the version number it would get, the changes, blocks and warnings' },
        libraries: { type: 'array', items: { type: 'string' }, description: 'init_workspace: the shared libraries the new workspace lists, as the person names them: registered names, or folders outside the workspace (read from the server\'s folder)' },
        add: { type: 'string', description: 'libraries: a shared library for the workspace to list: a registered library\'s name, or a folder outside the workspace (a relative path is read from the server\'s folder)' },
        version: { type: 'string', description: 'use: the version to add, such as "1.1" (default: the newest)' },
        from: { type: 'string', description: 'update with apply: the version in use when the person saw the before/after' },
        title: { type: 'string' },
        description: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        links: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, url: { type: 'string' } }, required: ['url'] }, description: 'links back to the board, concept pages, tickets' },
        graph: { type: 'string', description: 'set: the graph its page shows and bakes (default "main")' },
        bake: { type: 'object', properties: { graph: { type: 'string' }, node: { type: 'string' }, frame: { type: 'number' } }, description: 'set: what the preview shows instead of the graph output' },
        thumbnail: { type: 'boolean', description: 'get: include the baked thumbnail image' },
        name: { type: 'string', description: 'init_workspace: the workspace\'s name (default: the folder\'s); set and init: the name the package publishes under, "owner/name"' },
        engine: { type: 'string', description: 'init_workspace: the engine project, "godot:../project.godot" or "unreal:../../Game.uproject" from the workspace folder, or "none" (default: the one at or above the folder, else the one found below it)' },
        follow: { type: 'boolean', description: 'init_workspace: true shows the workspace\'s own packages live from their working folders, for looking (exports use the published versions); false stops it' },
        open: { type: 'boolean', description: 'create: open the new package (default true)' },
        package: { type: 'string', description: 'use / remove / follow / update / packages: a package, "owner/name"' },
        remove: { type: 'string', description: 'libraries: a shared library the workspace lists, to unlist: its entry, its registered name or its folder' },
        on: { type: 'boolean', description: 'follow: true to follow the package\'s working folder (default), false to go back to its copy' },
        note: { type: 'string', description: 'publish: one line on what changed (required)' },
        big: { type: 'boolean', description: 'publish: mark the version big (its meaning changed in a way the tools cannot see)' },
        to: { type: 'string', description: 'update: the version to go to, such as "2.0" (default: the newest with the same big number); apply needs it, with "from"' },
        apply: { type: 'boolean', description: 'update: apply it, once the person saw the before/after and said so (default false: show the before/after); needs "from" and "to"' },
      },
    },
    run: async (a, call) => {
      // the registered libraries are read and scanned only by the actions on them: a broken config or a slow library
      // does not stand in the way of the packages the open package uses
      let scanned: ReturnType<typeof scan> | null = null;
      const libs = () => (scanned ??= scan());
      // the packages of the open package as its files are now (a person may have edited its manifest)
      if (['packages', 'search', 'use', 'remove', 'follow', 'publish', 'outdated', 'update', 'libraries'].includes(a.action)) host.packages().refresh();
      switch (a.action) {
        case 'list': {
          const { cfg, scans } = libs();
          if (!scans.length) return text(`no libraries or workspaces registered (${cfg.file}), and the open package is in no workspace. The person registers one with \`${program()} library add <name> <folder>\` or \`${program()} workspace add <folder>\`.`);
          const cur = currentDir();
          const words = String(a.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
          const lines: string[] = [];
          for (const s of scans) {
            if (a.library && s.name !== a.library) continue;
            const ps = s.packages.filter((p) => {
              const m = p.manifest, hay = [m.title, p.id, p.collection, m.description, ...m.tags].join(' ').toLowerCase();
              return words.every((w) => hay.includes(w)) && (!a.tag || m.tags.includes(a.tag));
            });
            lines.push(`${s.workspace ? 'workspace' : 'library'} "${s.name}" (${s.root}): ${ps.length}${ps.length !== s.packages.length ? ` of ${s.packages.length}` : ''} packages`);
            for (const p of ps) lines.push(`  ${p.id}${p.dir === cur ? ' (open)' : ''}  ${p.rel}  "${p.manifest.title}"${p.manifest.tags.length ? ` [${p.manifest.tags.join(', ')}]` : ''}  ${statusOf(p)}  ${urlsOf(cfg, p).page}`);
            for (const pr of s.problems) lines.push(`  ! ${pr}`);
          }
          return text(lines.join('\n') || 'no library matches');
        }
        case 'get': {
          const { cfg } = libs(), p = pick(a, () => libs().scans), m = p.manifest, s = readBakeState(p.dir), u = urlsOf(cfg, p);
          const graphs = graphNames(p.dir).map((n) => {
            const g = readGraph(p.dir, n) ?? {};
            const vars = Object.entries(g.vars ?? {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ');
            return `  ${n}${n === m.graph ? ' (shown)' : ''}: ${Object.keys(g.nodes ?? {}).length} nodes${vars ? `; vars ${vars}` : ''}`;
          });
          const att = listFiles(path.join(p.dir, 'attachments')), exp = listFiles(path.join(p.dir, 'exports'));
          const lines = [
            `package ${p.lib ? `${p.lib}/` : ''}${p.id}: "${m.title}"${p.dir === currentDir() ? ' (open)' : ''}`,
            `folder ${p.dir}`,
            ...(m.description ? [`description: ${m.description}`] : []),
            ...(m.tags.length ? [`tags: ${m.tags.join(', ')}`] : []),
            ...(m.links.length ? ['links:', ...m.links.map((l) => `  ${l.label}: ${l.url}`)] : []),
            `graphs (${graphs.length}):`, ...(graphs.length ? graphs : ['  none yet']),
            ...(att.length ? [`attachments/ (${att.length}): ${att.slice(0, 30).map((f) => f.path).join(', ')}${att.length > 30 ? ', …' : ''}`] : []),
            ...(exp.length ? [`exports/ (${exp.length}): ${exp.slice(0, 30).map((f) => f.path).join(', ')}${exp.length > 30 ? ', …' : ''}`] : []),
            `preview: ${statusOf(p)}${s ? `, baked ${new Date(s.at).toISOString().slice(0, 16)}` : ''}${s && !s.ok ? `: ${s.error}` : ''}${Object.keys(m.bake).length ? `; bake ${JSON.stringify(m.bake)}` : ''}`,
            `page: ${u.page}  embed: ${u.embed}  thumbnail: ${u.thumb}`,
          ];
          const content: Content[] = [{ type: 'text', text: lines.join('\n') }];
          const thumb = path.join(p.dir, '.web', 'thumb.png');
          if (a.thumbnail && fs.existsSync(thumb)) content.push({ type: 'image', data: fs.readFileSync(thumb).toString('base64'), mimeType: 'image/png' });
          return { content };
        }
        case 'open': {
          const p = pick(a, () => libs().scans);
          const r = await host.open(p.dir);
          let page = '';
          try { page = ` Package page: ${urlsOf(libs().cfg, p).page}`; } catch { /* no config to read the port from */ }
          return text(`opened ${p.lib ? `${p.lib}/` : ''}${p.id} ("${p.manifest.title}"): every tool now works in ${p.dir} (${r.graphs} graphs, ${r.assets} assets). ` +
            `Build into graph "${p.manifest.graph}" (the one its page shows); put reference images in attachments/ and guide files in inputs/.${page}`);
        }
        case 'create': {
          const { cfg, places } = libs();
          if (!a.library) throw new Error(`"library" is required: a library's or a workspace's name (${places.map((l) => l.name).join(', ') || 'none registered'})`);
          if (!a.path) throw new Error('"path" is required: the package folder below the library or workspace, e.g. "props/lantern"');
          const lib = places.find((l) => l.name === a.library);
          if (!lib) throw new Error(`no library or workspace "${a.library}" (${places.map((l) => l.name).join(', ') || `none: the person registers one with \`${program()} library add <name> <folder>\` or \`${program()} workspace add <folder>\``})`);
          const p = createPackage(lib, a.path, { title: a.title, description: a.description, tags: a.tags, links: a.links });
          let opened = '';
          if (a.open !== false) { await host.open(p.dir); opened = ' and opened it: build/edit now work in it (graph "main" is the one its page shows)'; }
          return text(`created ${p.lib}/${p.id} at ${p.dir}${opened}. Package page: ${urlsOf(cfg, p).page}`);
        }
        case 'show': {
          const { workspaceText } = await import('../workspace.ts');
          return text(workspaceText(host.session().dir));
        }
        case 'libraries': {
          const { workspaceLibrary, workspaceLibrariesText } = await import('../workspace.ts');
          if (a.add !== undefined && a.remove !== undefined) throw new Error('libraries: "add" or "remove", not both');
          const dir = host.session().dir;
          if (a.add === undefined && a.remove === undefined) return text(workspaceLibrariesText(dir));
          const said = workspaceLibrary(a.add !== undefined ? 'add' : 'remove', String(a.add ?? a.remove), { at: dir, cwd: dir });
          host.packages().refresh();
          return text(said);
        }
        case 'init_workspace': {
          const { initWorkspace, workspaceText } = await import('../workspace.ts');
          if (!a.path) throw new Error('init_workspace needs path: the workspace\'s folder (its root), as the person names it');
          const r = initWorkspace(path.resolve(host.session().dir, String(a.path)), { name: a.name, engine: a.engine, assets: a.assets, libraries: Array.isArray(a.libraries) ? a.libraries.map(String) : undefined, follow: typeof a.follow === 'boolean' ? a.follow : undefined, cwd: host.session().dir });
          host.packages().refresh();
          return text(`${r.text}\n${workspaceText(r.dir)}`);
        }
        case 'init': {
          const dir = host.session().dir, inside = packageDirOf(dir);
          if (inside) throw new Error(`the folder ${dir} is in a package already: ${manifestFile(inside)}${a.name ? `; workspace {action:"set", name:"${a.name}"} names the package it is` : ''}`);
          const { id, manifest } = initPackage(dir, { name: a.name });
          // the tools take in the package (its packages) as a folder opened afresh
          const r = await host.open(dir);
          return text(`made the folder ${dir} a package, id "${id}"${manifest.name ? `, package ${manifest.name}` : ''} (${id}.topo, graphs/${manifest.graph}.json; ${r.graphs} graphs, ${r.assets} assets): ` +
            'its graphs use packages now. A build that names one adds it on first use: TopoTopo\'s own (topotopo/…) from TopoTopo\'s built-in library, others from its workspace and the shared libraries the workspace lists (workspace {action:"libraries"} shows them), or outside a workspace from every registered library. workspace {action:"packages"} shows them');
        }
        case 'set': {
          if (a.libraries !== undefined) throw new Error('"libraries" is no longer set on a package: the workspace lists the shared libraries its packages use (workspace {action:"libraries", add:"<name or folder>"}, when the person names the library); outside a workspace every registered library counts');
          const p = pick(a, () => libs().scans);
          const m = { ...p.manifest };
          for (const k of ['title', 'description', 'tags', 'links', 'graph', 'bake', 'name'] as const) if (a[k] !== undefined) (m as any)[k] = a[k];
          if (a.name !== undefined && a.name !== p.manifest.name) ownPackageName(String(a.name));
          const checked = parseManifest(m, p.id);
          const said: string[] = [];
          withPackageLock(p.dir, () => {
            // the manifest as it is on disk now: the fields set over it, "uses" as the packages left it
            const now = readManifest(p.dir);
            writeManifest(p.dir, { ...checked, uses: now.uses });
          });
          const pk = host.packages();
          if (pk.dir === p.dir) pk.refresh();
          const shown = readManifest(p.dir);
          return text([`set in ${p.lib ? `${p.lib}/` : ''}${p.id}: ${JSON.stringify(shown)}`, ...said].join('\n'));
        }
        case 'outdated': return text(outdatedText(host.packages(), true));
        case 'check': {
          const { checkAll, checkText } = await import('../packages/check.ts');
          return text(checkText(await checkAll(host.session().dir)));
        }
        case 'update': {
          if (!a.package) throw new Error('"package" is required: "owner/name", a package the open package uses (outdated lists them)');
          const pkg = String(a.package), to = a.to === undefined ? undefined : String(a.to);
          if (a.apply) {
            if (to === undefined || a.from === undefined) throw new Error('apply:true needs "from" and "to": the version in use and the version of the before/after the person saw');
            const r = applyUpdate(host.packages(), pkg, { from: String(a.from), to });
            // every graph may use it: they cook again, and the viewer shows it
            const ws = host.session();
            for (const g of ws.graphs.keys()) { ws.lastReport.delete(g); ws.bump(g); }
            return text(r.text);
          }
          let r;
          try { r = await beforeAfter(host.packages(), pkg, { to, signal: call?.signal, progress: call?.progress }); }
          catch (e) { if (e instanceof NothingToUpdate) return text(e.message); throw e; }
          const content: Content[] = [{ type: 'text', text: beforeAfterText(r, `Nothing was written. Show the person this before/after, and apply it only when they say so: workspace {action:"update", package:"${pkg}", from:"${r.target.from}", to:"${r.target.to}", apply:true}`) }];
          const renders = overlayRenders(r);
          if (renders.length) {
            const changed = r.compared.filter((c) => c.diff && !c.diff.identical).length;
            content.push({ type: 'text', text: `overlay renders of ${renders.length === changed ? `the ${changed === 1 ? 'place' : `${changed} places`} that changed` : `the ${renders.length} places that changed most (of ${changed})`}, in order: ${renders.map((x) => x.title).join(', ')}. Grey: the same with both versions; blue: only with ${r.target.to} (moved or new); orange: only with ${r.target.from} (moved from or gone)` });
            for (const x of renders) content.push({ type: 'image', data: Buffer.from(x.png).toString('base64'), mimeType: 'image/png' });
          }
          return { content };
        }
        case 'packages': return text(a.package ? packageText(host.packages(), String(a.package), true) : packagesText(host.packages(), true));
        case 'use': {
          if (!a.package) throw new Error('"package" is required: "owner/name"');
          const r = host.packages().use(String(a.package), { version: a.version === undefined ? undefined : String(a.version) });
          return text(`${r.text}. Its outputs are node types now: workspace {action:"packages", package:"${a.package}"} lists them, help {nodes:[...]} gives one's params`);
        }
        case 'remove': {
          if (!a.package) throw new Error('"package" is required: "owner/name", a package the open package uses (packages lists them)');
          return text(removePackage(host.packages(), String(a.package)).text);
        }
        case 'follow': {
          if (!a.package) throw new Error('"package" is required: "owner/name"');
          const said = host.packages().follow(String(a.package), a.on !== false);
          // every graph may use it: they cook again, and the viewer shows it
          const ws = host.session();
          for (const g of ws.graphs.keys()) { ws.lastReport.delete(g); ws.bump(g); }
          return text(said);
        }
        case 'publish': {
          const r = await publishPackage(host.packages(), { note: a.note, big: a.big, dryRun: a.dry_run === true });
          return text(publishText(r), !r.ok);
        }
        case 'search': {
          const pk = host.packages();
          const r = searchPackages(pk.dir ?? host.session().dir, { query: a.query, kind: a.kind, tag: a.tag }, { builtin: pk.builtin });
          return text(searchText(r, true));
        }
        case 'bake': {
          const p = pick(a, () => libs().scans);
          const { bakePackage } = await import('../web/bake.ts');
          const s = await bakePackage(p.dir);
          if (!s.ok) return text(`bake of ${p.id} failed: ${s.error}`, true);
          const content: Content[] = [{ type: 'text', text: `baked ${p.id} in ${s.ms} ms: ${s.points} points, ${s.prims} prims${s.glb ? '' : ' (no preview.glb: too large)'}${s.warnings?.length ? `; warnings: ${s.warnings.slice(0, 5).join('; ')}` : ''}` }];
          content.push({ type: 'image', data: fs.readFileSync(path.join(p.dir, '.web', 'thumb.png')).toString('base64'), mimeType: 'image/png' });
          return { content };
        }
      }
      return text(`unknown action "${a.action}": list, get, open, create, init, init_workspace, show, libraries, set, bake, packages, search, use, remove, follow, publish, outdated, check or update`, true);
    },
  };
}
