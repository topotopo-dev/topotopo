// The `library` tool: the person's libraries of projects (src/gallery/library.ts) and the packages of the open project
// (src/packages/registry.ts, src/packages/update.ts). An agent lists and searches every library, reads a project, makes
// new ones, edits their project.json, bakes previews, and opens a project: the server's folder becomes that project's
// folder, so build/edit/render/export work on it; or it makes the server's folder a project (init), when the person says
// so: only a project's graphs use packages. In the open project it publishes a version of its package (or a dry run of
// it), searches the outputs of every library and says which the project can use, lists and adds the packages it uses,
// follows a package's working folder for the session, says which packages are out of date, and shows the before/after
// of an update, which it applies only when the person says so.
import fs from 'node:fs';
import path from 'node:path';
import type { Session } from '../session.ts';
import type { ToolDef, ToolResult, Content } from './tools.ts';
import { loadConfig } from '../config.ts';
import { initProject, ownPackageName, parseManifest, program, projectDirOf, readManifest, withProjectLock, writeManifest } from '../project.ts';
import { createProject, graphNames, isStale, listFiles, readBakeState, readGraph, scanAll } from '../gallery/library.ts';
import type { GalleryConfig } from '../config.ts';
import type { LibraryScan, Project } from '../gallery/library.ts';
import { KINDS } from '../graph/outputs.ts';
import { NothingToUpdate, packageText, packagesText, publishPackage, publishText, searchPackages, searchText } from '../packages/registry.ts';
import type { ProjectPackages } from '../packages/registry.ts';
import { applyUpdate, beforeAfter, beforeAfterText, outdatedText, overlayRenders, removePackage } from '../packages/update.ts';

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) });

export interface LibraryToolHost {
  /** the session the other tools use now (its folder, graphs, assets and engine) */
  session(): Session;
  /** the packages of the project the session's folder belongs to */
  packages(): ProjectPackages;
  /** make a folder the one every tool (and the live viewer) works in */
  open(dir: string): Promise<{ graphs: number; assets: number }>;
}

export function libraryTool(host: LibraryToolHost): ToolDef {
  const scan = (): { cfg: GalleryConfig; scans: LibraryScan[] } => { const cfg = loadConfig(); return { cfg, scans: scanAll(cfg) }; };
  const urlsOf = (cfg: GalleryConfig, p: Project) => {
    const b = `http://127.0.0.1:${cfg.gallery.port}`;
    return { page: `${b}/p/${p.lib}/${p.id}`, embed: `${b}/embed/${p.lib}/${p.id}`, thumb: `${b}/p/${p.lib}/${p.id}/thumb.png` };
  };
  const currentDir = () => projectDirOf(host.session().dir);
  const statusOf = (p: Project) => { const s = readBakeState(p.dir); return !s ? 'not baked' : !s.ok ? 'bake failed' : isStale(p) ? 'stale' : 'baked'; };
  /**
   * {library, id}, {path}, or nothing (the open project). The libraries are scanned for an id; for a folder, only to
   * name the library it is in (a config that cannot be read leaves that out).
   */
  const pick = (a: any, scans: () => LibraryScan[]): Project => {
    if (a.id) {
      const hits = scans().flatMap((s) => s.projects).filter((p) => p.id === a.id && (!a.library || p.lib === a.library));
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) throw new Error(`id "${a.id}" is in several libraries (${hits.map((p) => p.lib).join(', ')}): give "library"`);
      throw new Error(`no project "${a.id}"${a.library ? ` in library "${a.library}"` : ''}. library {action:"list"} lists them`);
    }
    const dir = a.path ? projectDirOf(path.resolve(a.path)) : currentDir();
    if (!dir) throw new Error(a.path ? `${a.path}: no project.json there or above` : 'give {library, id}: the server\'s folder is in no project (library {action:"init"} makes it one, when the person says so)');
    let all: Project[] = [];
    try { all = scans().flatMap((s) => s.projects); } catch { /* named without its library */ }
    const p = all.find((x) => x.dir === dir);
    if (p) return p;
    // a project folder outside the configured libraries still works
    const m = readManifest(dir);
    return { lib: '', id: m.id, dir, rel: path.basename(dir), collection: '', manifest: m, updated: 0 };
  };

  return {
    name: 'library',
    description: 'The person\'s libraries of projects (the TopoTopo Gallery website shows them; a board links to them). A library is a folder; a project is a folder in it with project.json (title, description, tags, links to concept art/board pages) and is a project of its own (graphs/, assets/, inputs/, exports/, attachments/ for concept art and references). ' +
      'list {query?, tag?, library?}: every project with status and gallery URL. get {library, id} (or the open project): manifest, graphs and vars, attachments, exports, bake state, URLs; thumbnail:true adds the baked image. ' +
      'open {library, id} | {path}: make that project the folder every tool and the live viewer work in, then build/edit/render/export work in it. create {library, path:"props/lantern", title?, description?, tags?, links?}: a new project, opened. ' +
      'workspace: the workspace (the game) around the open project: its engine project, the libraries every project inside looks in, its projects. workspace {init:true, path?, name?, engine?, assets?, libraries?} makes a game\'s folder (path, default: the folder above the open project that the person names) a workspace (topotopo-workspace.json; the engine project found when not given; its projects then share one copy of each package, in topotopo-packages/, and their own copies move there), when the person says so. ' +
      'init {package?}: make the server\'s folder a project (project.json, graphs/main.json, .gitignore, .gitattributes), when it is none and the person says so: only a project\'s graphs use packages (TopoTopo\'s own included), and a build that names one in a project outside any project fails saying so. ' +
      'set {library?, id?, title?, description?, tags?, links?, graph?, bake?, package?, libraries?}: edit project.json (graph = the graph the gallery shows; bake = {graph?, node?, frame?} what its preview shows; package = "owner/name", the package the project is, set once by its author; libraries = the libraries the project finds packages in, ["../lib", "game"]: a path from the project for a library in the same repository, else a registered name; set it only when the person names the library). bake {library?, id?}: render thumb.png and preview.glb now (the gallery also bakes on its own after changes). ' +
      `Packages of the open project: packages (what it uses and can use, one line each: version, outputs, up to date or the newer version that is out), packages {package} (one package: its versions and notes, its outputs with their kinds, tags, params and inputs); search {query?, kind?, tag?}: the outputs of every library (TopoTopo\'s built-in one, those the project lists, every registered one) by words, kind (${KINDS.join(', ')}) and tag, each with its full name, kind, tags, label, version and description, and whether the project can use it, else the "libraries" entry that would list its library; use {package:"owner/name", version?} adds one (a graph that names "owner/name/output" adds it too); remove {package} removes one no graph of the project names; follow {package, on} uses a package\'s working folder instead of its copy for this session. ` +
      'publish {dry_run:true, note?, big?} is a dry run: every check and cook, the version number it would get, its changes, blocks and warnings, nothing written. Publishing is permanent: run the dry run first, show it to the person, and publish {note, big?} only when they say so. ' +
      'outdated: the packages it uses that have newer versions, with their notes, and one line for those up to date. check: cook the newest version of every package in the libraries of the workspace (or the project) and every graph of its projects, and list what broke and why; it changes nothing (after a TopoTopo update, say). update {package, to?}: the before/after of updating it (to the newest version with the same big number; a big version needs "to"): every place the project uses it, cooked with the version in use and the new one, what changed in each, overlay renders, the notes of the versions between and, for a big version, what the graphs must change. It writes nothing. Show the before/after to the person and apply it only when they say so: update {package, from, to, apply:true} (the versions of the before/after they saw) copies the new version in, updates the uses and the lock, and deletes the copies nothing uses any more. See help topics "library" and "packages".',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'open', 'create', 'init', 'workspace', 'set', 'bake', 'packages', 'search', 'use', 'remove', 'follow', 'publish', 'outdated', 'check', 'update'] },
        library: { type: 'string', description: 'library name (list shows them)' },
        id: { type: 'string', description: 'project id' },
        path: { type: 'string', description: 'create: folder below the library ("props/lantern"); open/get: a project folder on disk instead of {library, id}' },
        query: { type: 'string', description: 'list: words to match in title, id, collection, description, tags; search: words each of which must start a word of a published output\'s full name, label, description or tags, or of its package\'s title or project tags' },
        tag: { type: 'string', description: 'list: only projects with this tag; search: only outputs with this tag' },
        kind: { type: 'string', enum: [...KINDS], description: 'search: only outputs of this kind' },
        dry_run: { type: 'boolean', description: 'publish: a dry run, which writes nothing: every check, every output cooked, the version number it would get, the changes, blocks and warnings' },
        libraries: { type: 'array', items: { type: 'string' }, description: 'set: the libraries the project finds packages in, as the person names them: "../lib" (a path from the project) or "game" (a registered name)' },
        version: { type: 'string', description: 'use: the version to add, such as "1.1" (default: the newest)' },
        from: { type: 'string', description: 'update with apply: the version in use when the person saw the before/after' },
        title: { type: 'string' },
        description: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        links: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, url: { type: 'string' } }, required: ['url'] }, description: 'links back to the board, concept pages, tickets' },
        graph: { type: 'string', description: 'set: the graph the gallery shows and bakes (default "main")' },
        bake: { type: 'object', properties: { graph: { type: 'string' }, node: { type: 'string' }, frame: { type: 'number' } }, description: 'set: what the preview shows instead of the graph output' },
        thumbnail: { type: 'boolean', description: 'get: include the baked thumbnail image' },
        init: { type: 'boolean', description: 'workspace: make the folder (path) a workspace, or change it' },
        name: { type: 'string', description: 'workspace init: its name (default: the folder\'s)' },
        engine: { type: 'string', description: 'workspace init: the engine project, "godot:game/project.godot" or "unreal:Game.uproject" from the workspace folder, or "none" (default: the one found below it)' },
        assets: { type: 'string', description: 'workspace init: the folder in the engine project exports may go to, from the workspace folder' },
        follow: { type: 'boolean', description: 'workspace init: true shows the workspace\'s own packages live from their working folders, for looking (exports use the published versions); false stops it' },
        open: { type: 'boolean', description: 'create: open the new project (default true)' },
        package: { type: 'string', description: 'use / remove / follow / update / packages: a package, "owner/name"; set and init: the package the project is' },
        on: { type: 'boolean', description: 'follow: true to follow the package\'s working folder (default), false to go back to its copy' },
        note: { type: 'string', description: 'publish: one line on what changed (required)' },
        big: { type: 'boolean', description: 'publish: mark the version big (its meaning changed in a way the tools cannot see)' },
        to: { type: 'string', description: 'update: the version to go to, such as "2.0" (default: the newest with the same big number); apply needs it, with "from"' },
        apply: { type: 'boolean', description: 'update: apply it, once the person saw the before/after and said so (default false: show the before/after); needs "from" and "to"' },
      },
    },
    run: async (a, call) => {
      // the registered libraries are read and scanned only by the actions on them: a broken config or a slow library
      // does not stand in the way of the open project's packages
      let scanned: { cfg: GalleryConfig; scans: LibraryScan[] } | null = null;
      const libs = () => (scanned ??= scan());
      // the packages of the open project as its files are now (a person may have edited project.json)
      if (['packages', 'search', 'use', 'remove', 'follow', 'publish', 'outdated', 'update'].includes(a.action)) host.packages().refresh();
      switch (a.action) {
        case 'list': {
          const { cfg, scans } = libs();
          if (!cfg.libraries.length) return text(`no libraries registered (${cfg.file}). The person registers one with \`${program()} library add <name> <folder>\`.`);
          const cur = currentDir();
          const words = String(a.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
          const lines: string[] = [];
          for (const s of scans) {
            if (a.library && s.name !== a.library) continue;
            const ps = s.projects.filter((p) => {
              const m = p.manifest, hay = [m.title, p.id, p.collection, m.description, ...m.tags].join(' ').toLowerCase();
              return words.every((w) => hay.includes(w)) && (!a.tag || m.tags.includes(a.tag));
            });
            lines.push(`library "${s.name}" (${s.root}): ${ps.length}${ps.length !== s.projects.length ? ` of ${s.projects.length}` : ''} projects`);
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
            `project ${p.lib ? `${p.lib}/` : ''}${p.id}: "${m.title}"${p.dir === currentDir() ? ' (open)' : ''}`,
            `folder ${p.dir}`,
            ...(m.description ? [`description: ${m.description}`] : []),
            ...(m.tags.length ? [`tags: ${m.tags.join(', ')}`] : []),
            ...(m.links.length ? ['links:', ...m.links.map((l) => `  ${l.label}: ${l.url}`)] : []),
            `graphs (${graphs.length}):`, ...(graphs.length ? graphs : ['  none yet']),
            ...(att.length ? [`attachments/ (${att.length}): ${att.slice(0, 30).map((f) => f.path).join(', ')}${att.length > 30 ? ', …' : ''}`] : []),
            ...(exp.length ? [`exports/ (${exp.length}): ${exp.slice(0, 30).map((f) => f.path).join(', ')}${exp.length > 30 ? ', …' : ''}`] : []),
            `preview: ${statusOf(p)}${s ? `, baked ${new Date(s.at).toISOString().slice(0, 16)}` : ''}${s && !s.ok ? `: ${s.error}` : ''}${Object.keys(m.bake).length ? `; bake ${JSON.stringify(m.bake)}` : ''}`,
            `gallery: ${u.page}  embed: ${u.embed}  thumbnail: ${u.thumb}`,
          ];
          const content: Content[] = [{ type: 'text', text: lines.join('\n') }];
          const thumb = path.join(p.dir, '.gallery', 'thumb.png');
          if (a.thumbnail && fs.existsSync(thumb)) content.push({ type: 'image', data: fs.readFileSync(thumb).toString('base64'), mimeType: 'image/png' });
          return { content };
        }
        case 'open': {
          const p = pick(a, () => libs().scans);
          const r = await host.open(p.dir);
          let page = '';
          try { page = ` Gallery page: ${urlsOf(libs().cfg, p).page}`; } catch { /* no config to read the port from */ }
          return text(`opened ${p.lib ? `${p.lib}/` : ''}${p.id} ("${p.manifest.title}"): every tool now works in ${p.dir} (${r.graphs} graphs, ${r.assets} assets). ` +
            `Build into graph "${p.manifest.graph}" (the one the gallery shows); put reference images in attachments/ and guide files in inputs/.${page}`);
        }
        case 'create': {
          const { cfg } = libs();
          if (!a.library) throw new Error(`"library" is required (${cfg.libraries.map((l) => l.name).join(', ') || 'none configured'})`);
          if (!a.path) throw new Error('"path" is required: the project folder below the library, e.g. "props/lantern"');
          const lib = cfg.libraries.find((l) => l.name === a.library);
          if (!lib) throw new Error(`no library "${a.library}" (${cfg.libraries.map((l) => l.name).join(', ') || `none: the person registers one with \`${program()} library add <name> <folder>\``})`);
          const p = createProject(lib, a.path, { title: a.title, description: a.description, tags: a.tags, links: a.links });
          let opened = '';
          if (a.open !== false) { await host.open(p.dir); opened = ' and opened it: build/edit now work in it (graph "main" is the one the gallery shows)'; }
          return text(`created ${p.lib}/${p.id} at ${p.dir}${opened}. Gallery page: ${urlsOf(cfg, p).page}`);
        }
        case 'workspace': {
          const { initWorkspace, workspaceText } = await import('../workspace.ts');
          if (a.init) {
            if (!a.path) throw new Error('workspace {init:true} needs path: the game\'s folder (its root), as the person names it');
            const r = initWorkspace(path.resolve(host.session().dir, String(a.path)), { name: a.name, engine: a.engine, assets: a.assets, libraries: Array.isArray(a.libraries) ? a.libraries : undefined, follow: typeof a.follow === 'boolean' ? a.follow : undefined });
            host.packages().refresh();
            return text(`${r.text}\n${workspaceText(r.dir)}`);
          }
          return text(workspaceText(host.session().dir));
        }
        case 'init': {
          const dir = host.session().dir, inside = projectDirOf(dir);
          if (inside) throw new Error(`the folder ${dir} is in a project already: ${path.join(inside, 'project.json')}${a.package ? `; library {action:"set", package:"${a.package}"} names the package it is` : ''}`);
          const { manifest } = initProject(dir, { package: a.package });
          // the tools take in the project (its packages) as a folder opened afresh
          const r = await host.open(dir);
          return text(`made the folder ${dir} a project, id "${manifest.id}"${manifest.package ? `, package ${manifest.package}` : ''} (project.json, graphs/${manifest.graph}.json; ${r.graphs} graphs, ${r.assets} assets): ` +
            'its graphs use packages now. A build that names one adds it on first use: TopoTopo\'s own (topotopo/…) from TopoTopo\'s built-in library, others from the libraries its project.json lists, which library {action:"set", libraries:[...]} sets when the person names them. library {action:"packages"} shows them');
        }
        case 'set': {
          const p = pick(a, () => libs().scans);
          const m = { ...p.manifest };
          for (const k of ['title', 'description', 'tags', 'links', 'graph', 'bake', 'package'] as const) if (a[k] !== undefined) (m as any)[k] = a[k];
          if (a.package !== undefined && a.package !== p.manifest.package) ownPackageName(String(a.package));
          const checked = parseManifest(m, p.id);
          const said: string[] = [];
          withProjectLock(p.dir, () => {
            // project.json as it is on disk now: the fields set over it, "uses" as the packages left it
            const now = readManifest(p.dir);
            writeManifest(p.dir, { ...checked, uses: now.uses, libraries: now.libraries });
          });
          const pk = host.packages();
          if (a.libraries !== undefined) {
            if (pk.dir !== p.dir) throw new Error(`"libraries" is set for the open project only (${pk.dir ?? 'none is open'}): library {action:"open"} the project first`);
            said.push(pk.setLibraries(Array.isArray(a.libraries) ? a.libraries.map(String) : a.libraries));
          }
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
          if (!a.package) throw new Error('"package" is required: "owner/name", a package the project uses (outdated lists them)');
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
          const content: Content[] = [{ type: 'text', text: beforeAfterText(r, `Nothing was written. Show the person this before/after, and apply it only when they say so: library {action:"update", package:"${pkg}", from:"${r.target.from}", to:"${r.target.to}", apply:true}`) }];
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
          return text(`${r.text}. Its outputs are node types now: library {action:"packages", package:"${a.package}"} lists them, help {nodes:[...]} gives one's params`);
        }
        case 'remove': {
          if (!a.package) throw new Error('"package" is required: "owner/name", a package the project uses (packages lists them)');
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
          const r = searchPackages(pk.dir && pk.manifest ? pk.dir : null, { query: a.query, kind: a.kind, tag: a.tag }, { builtin: pk.builtin });
          return text(searchText(r, true));
        }
        case 'bake': {
          const p = pick(a, () => libs().scans);
          const { bakeProject } = await import('../gallery/bake.ts');
          const s = await bakeProject(p.dir);
          if (!s.ok) return text(`bake of ${p.id} failed: ${s.error}`, true);
          const content: Content[] = [{ type: 'text', text: `baked ${p.id} in ${s.ms} ms: ${s.points} points, ${s.prims} prims${s.glb ? '' : ' (no preview.glb: too large)'}${s.warnings?.length ? `; warnings: ${s.warnings.slice(0, 5).join('; ')}` : ''}` }];
          content.push({ type: 'image', data: fs.readFileSync(path.join(p.dir, '.gallery', 'thumb.png')).toString('base64'), mimeType: 'image/png' });
          return { content };
        }
      }
      return text(`unknown action "${a.action}": list, get, open, create, init, set, bake, packages, search, use, remove, follow, publish, outdated, check or update`, true);
    },
  };
}
