// The `library` tool: the person's libraries of projects (src/gallery/library.ts) and the packages of the open project
// (src/gallery/packages.ts, src/gallery/update.ts). An agent lists and searches every library, reads a project, makes
// new ones, edits their project.json, bakes previews, and opens a project: the server's workspace becomes that project
// folder, so build/edit/render/export work on it; or it makes the open workspace a project (init), when the person says
// so: only a project's graphs use packages. In the open project it publishes a version of its package, lists and
// adds the packages it uses, follows a package's working folder for the session, says which packages are out of date,
// and shows the before/after of an update, which it applies only when the person says so.
import fs from 'node:fs';
import path from 'node:path';
import type { Workspace } from '../workspace.ts';
import type { ToolDef, ToolResult, Content } from './tools.ts';
import {
  createProject, graphNames, initProject, isStale, listFiles, loadConfig, parseManifest, projectDirOf, readBakeState, readGraph, readManifest,
  scanAll, writeManifest,
} from '../gallery/library.ts';
import type { GalleryConfig, LibraryScan, Project } from '../gallery/library.ts';
import { packagesText, publishPackage, publishText } from '../gallery/packages.ts';
import type { ProjectPackages } from '../gallery/packages.ts';
import { applyUpdate, beforeAfter, beforeAfterText, outdatedText, overlayRenders } from '../gallery/update.ts';

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) });

export interface LibraryToolHost {
  /** the workspace the other tools use now */
  workspace(): Workspace;
  /** the packages of the project the workspace belongs to */
  packages(): ProjectPackages;
  /** make a folder the workspace of every tool (and of the live viewer) */
  open(dir: string): Promise<{ graphs: number; assets: number }>;
}

export function libraryTool(host: LibraryToolHost): ToolDef {
  const scan = (): { cfg: GalleryConfig; scans: LibraryScan[] } => { const cfg = loadConfig(); return { cfg, scans: scanAll(cfg) }; };
  const urlsOf = (cfg: GalleryConfig, p: Project) => {
    const b = `http://127.0.0.1:${cfg.gallery.port}`;
    return { page: `${b}/p/${p.lib}/${p.id}`, embed: `${b}/embed/${p.lib}/${p.id}`, thumb: `${b}/p/${p.lib}/${p.id}/thumb.png` };
  };
  const currentDir = () => projectDirOf(host.workspace().dir);
  const statusOf = (p: Project) => { const s = readBakeState(p.dir); return !s ? 'not baked' : !s.ok ? 'bake failed' : isStale(p) ? 'stale' : 'baked'; };
  /** {library, id}, {path}, or nothing (the open project) */
  const pick = (a: any, scans: LibraryScan[]): Project => {
    const all = scans.flatMap((s) => s.projects);
    if (a.id) {
      const hits = all.filter((p) => p.id === a.id && (!a.library || p.lib === a.library));
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) throw new Error(`id "${a.id}" is in several libraries (${hits.map((p) => p.lib).join(', ')}): give "library"`);
      throw new Error(`no project "${a.id}"${a.library ? ` in library "${a.library}"` : ''}. library {action:"list"} lists them`);
    }
    const dir = a.path ? projectDirOf(path.resolve(a.path)) : currentDir();
    if (!dir) throw new Error(a.path ? `${a.path}: no project.json there or above` : 'give {library, id}: the open workspace is not a library project');
    const p = all.find((x) => x.dir === dir);
    if (p) return p;
    // a project folder outside the configured libraries still works
    const m = readManifest(dir);
    return { lib: '', id: m.id, dir, rel: path.basename(dir), collection: '', manifest: m, updated: 0 };
  };

  return {
    name: 'library',
    description: 'The person\'s libraries of projects (the TopoTopo Gallery website shows them; a board links to them). A library is a folder; a project is a folder in it with project.json (title, description, tags, links to concept art/board pages) and is a workspace of its own (graphs/, assets/, inputs/, exports/, attachments/ for concept art and references). ' +
      'list {query?, tag?, library?}: every project with status and gallery URL. get {library, id} (or the open project): manifest, graphs and vars, attachments, exports, bake state, URLs; thumbnail:true adds the baked image. ' +
      'open {library, id} | {path}: make that project the workspace of every tool and the live viewer, then build/edit/render/export work in it. create {library, path:"props/lantern", title?, description?, tags?, links?}: a new project, opened. ' +
      'init {package?}: make the open workspace a project (project.json in its folder), when it is none: only a project\'s graphs use packages (TopoTopo\'s own included), and a build that names one in a workspace outside any project fails saying so. ' +
      'set {library?, id?, title?, description?, tags?, links?, graph?, bake?, package?}: edit project.json (graph = the graph the gallery shows; bake = {graph?, node?, frame?} what its preview shows; package = "owner/name", the package the project is, set once by its author). bake {library?, id?}: render thumb.png and preview.glb now (the gallery also bakes on its own after changes). ' +
      'Packages of the open project: packages (what it uses, and the packages in the libraries it lists, with their newest version, note and outputs); use {package:"owner/name"} adds one (a graph that names "owner/name/output" adds it too); follow {package, on} uses a package\'s working folder instead of its copy for this session; publish {note, big?} publishes the next version of the project\'s package. ' +
      'outdated: for each package it uses, the newer versions (the small update: the newest with the same big number; the big one) with their notes. update {package, to?}: the before/after of updating it (to the newest version with the same big number; a big version needs "to"): every place the project uses it, cooked with the version in use and the new one, what changed in each, overlay renders, the notes of the versions between and, for a big version, what the graphs must change. It writes nothing. Show the before/after to the person and apply it only when they say so: update {package, to, apply:true} copies the new version in, updates the uses and the lock, and deletes the copies nothing uses any more. See help topics "library" and "packages".',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'open', 'create', 'init', 'set', 'bake', 'packages', 'use', 'follow', 'publish', 'outdated', 'update'] },
        library: { type: 'string', description: 'library name (list shows them)' },
        id: { type: 'string', description: 'project id' },
        path: { type: 'string', description: 'create: folder below the library ("props/lantern"); open/get: a project folder on disk instead of {library, id}' },
        query: { type: 'string', description: 'list: words to match in title, id, collection, description, tags' },
        tag: { type: 'string', description: 'list: only projects with this tag' },
        title: { type: 'string' },
        description: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        links: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, url: { type: 'string' } }, required: ['url'] }, description: 'links back to the board, concept pages, tickets' },
        graph: { type: 'string', description: 'set: the graph the gallery shows and bakes (default "main")' },
        bake: { type: 'object', properties: { graph: { type: 'string' }, node: { type: 'string' }, frame: { type: 'number' } }, description: 'set: what the preview shows instead of the graph output' },
        thumbnail: { type: 'boolean', description: 'get: include the baked thumbnail image' },
        open: { type: 'boolean', description: 'create: open the new project (default true)' },
        package: { type: 'string', description: 'use / follow / update: a package, "owner/name"; set and init: the package the project is' },
        on: { type: 'boolean', description: 'follow: true to follow the package\'s working folder (default), false to go back to its copy' },
        note: { type: 'string', description: 'publish: one line on what changed (required)' },
        big: { type: 'boolean', description: 'publish: mark the version big (its meaning changed in a way the tools cannot see)' },
        to: { type: 'string', description: 'update: the version to go to, such as "2.0" (default: the newest with the same big number); apply needs it' },
        apply: { type: 'boolean', description: 'update: apply it, once the person saw the before/after and said so (default false: show the before/after)' },
      },
    },
    run: async (a, call) => {
      const { cfg, scans } = scan();
      // the packages of the open project as its files are now (a person may have edited project.json)
      if (['packages', 'use', 'follow', 'publish', 'outdated', 'update'].includes(a.action)) host.packages().refresh();
      switch (a.action) {
        case 'list': {
          if (!cfg.libraries.length) return text(`no libraries configured (${cfg.file}). The person adds one with \`topotopo library add <name> <folder>\`.`);
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
          const p = pick(a, scans), m = p.manifest, s = readBakeState(p.dir), u = urlsOf(cfg, p);
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
          const p = pick(a, scans);
          const r = await host.open(p.dir);
          return text(`opened ${p.lib ? `${p.lib}/` : ''}${p.id} ("${p.manifest.title}"): the workspace of every tool is now ${p.dir} (${r.graphs} graphs, ${r.assets} assets). ` +
            `Build into graph "${p.manifest.graph}" (the one the gallery shows); put reference images in attachments/ and guide files in inputs/. Gallery page: ${urlsOf(cfg, p).page}`);
        }
        case 'create': {
          if (!a.library) throw new Error(`"library" is required (${cfg.libraries.map((l) => l.name).join(', ') || 'none configured'})`);
          if (!a.path) throw new Error('"path" is required: the project folder below the library, e.g. "props/lantern"');
          const lib = cfg.libraries.find((l) => l.name === a.library);
          if (!lib) throw new Error(`no library "${a.library}" (${cfg.libraries.map((l) => l.name).join(', ') || `none: the person adds one with \`topotopo library add <name> <folder>\``})`);
          const p = createProject(lib, a.path, { title: a.title, description: a.description, tags: a.tags, links: a.links });
          let opened = '';
          if (a.open !== false) { await host.open(p.dir); opened = ' and opened it: build/edit now work in it (graph "main" is the one the gallery shows)'; }
          return text(`created ${p.lib}/${p.id} at ${p.dir}${opened}. Gallery page: ${urlsOf(cfg, p).page}`);
        }
        case 'init': {
          const dir = host.workspace().dir, inside = projectDirOf(dir);
          if (inside) throw new Error(`the workspace ${dir} is in a project already: ${path.join(inside, 'project.json')}`);
          const { manifest } = initProject(dir, { package: a.package });
          // the tools take in the project (its packages) as a workspace opened afresh
          const r = await host.open(dir);
          return text(`made the workspace ${dir} a project, id "${manifest.id}"${manifest.package ? `, package ${manifest.package}` : ''} (project.json; ${r.graphs} graphs, ${r.assets} assets): ` +
            'its graphs use packages now. A build that names one adds it on first use: TopoTopo\'s own (topotopo/…) from TopoTopo\'s built-in library, others from the libraries its project.json lists under "libraries" (the person lists them). library {action:"packages"} shows them');
        }
        case 'set': {
          const p = pick(a, scans);
          const m = { ...p.manifest };
          for (const k of ['title', 'description', 'tags', 'links', 'graph', 'bake', 'package'] as const) if (a[k] !== undefined) (m as any)[k] = a[k];
          const checked = parseManifest(m, p.id);
          writeManifest(p.dir, checked);
          return text(`set in ${p.lib ? `${p.lib}/` : ''}${p.id}: ${JSON.stringify(checked)}`);
        }
        case 'outdated': return text(outdatedText(host.packages(), true));
        case 'update': {
          if (!a.package) throw new Error('"package" is required: "owner/name", a package the project uses (outdated lists them)');
          const pkg = String(a.package), to = a.to === undefined ? undefined : String(a.to);
          if (a.apply) {
            if (to === undefined) throw new Error('apply:true needs "to": the version whose before/after the person saw');
            const r = applyUpdate(host.packages(), pkg, to);
            // every graph may use it: they cook again, and the viewer shows it
            const ws = host.workspace();
            for (const g of ws.graphs.keys()) { ws.lastReport.delete(g); ws.bump(g); }
            return text(r.text);
          }
          const r = await beforeAfter(host.packages(), pkg, { to, signal: call?.signal, progress: call?.progress });
          const content: Content[] = [{ type: 'text', text: beforeAfterText(r, `Nothing was written. Show the person this before/after, and apply it only when they say so: library {action:"update", package:"${pkg}", to:"${r.target.to}", apply:true}`) }];
          const renders = overlayRenders(r);
          if (renders.length) {
            const changed = r.compared.filter((c) => c.diff && !c.diff.identical).length;
            content.push({ type: 'text', text: `overlay renders of ${renders.length === changed ? `the ${changed === 1 ? 'place' : `${changed} places`} that changed` : `the ${renders.length} places that changed most (of ${changed})`}, in order: ${renders.map((x) => x.title).join(', ')}. Grey: the same with both versions; blue: only with ${r.target.to} (moved or new); orange: only with ${r.target.from} (moved from or gone)` });
            for (const x of renders) content.push({ type: 'image', data: Buffer.from(x.png).toString('base64'), mimeType: 'image/png' });
          }
          return { content };
        }
        case 'packages': return text(packagesText(host.packages()));
        case 'use': {
          if (!a.package) throw new Error('"package" is required: "owner/name"');
          const r = host.packages().use(String(a.package));
          return text(`${r.text}. Its outputs are node types now: help {nodes:["${a.package}"]}, catalog {category:"package"}`);
        }
        case 'follow': {
          if (!a.package) throw new Error('"package" is required: "owner/name"');
          const said = host.packages().follow(String(a.package), a.on !== false);
          // every graph may use it: they cook again, and the viewer shows it
          const ws = host.workspace();
          for (const g of ws.graphs.keys()) { ws.lastReport.delete(g); ws.bump(g); }
          return text(said);
        }
        case 'publish': {
          const r = await publishPackage(host.workspace(), host.packages(), { note: a.note, big: a.big });
          return text(publishText(r), !r.ok);
        }
        case 'bake': {
          const p = pick(a, scans);
          const { bakeProject } = await import('../gallery/bake.ts');
          const s = await bakeProject(p.dir);
          if (!s.ok) return text(`bake of ${p.id} failed: ${s.error}`, true);
          const content: Content[] = [{ type: 'text', text: `baked ${p.id} in ${s.ms} ms: ${s.points} points, ${s.prims} prims${s.glb ? '' : ' (no preview.glb: too large)'}${s.warnings?.length ? `; warnings: ${s.warnings.slice(0, 5).join('; ')}` : ''}` }];
          content.push({ type: 'image', data: fs.readFileSync(path.join(p.dir, '.gallery', 'thumb.png')).toString('base64'), mimeType: 'image/png' });
          return { content };
        }
      }
      return text(`unknown action "${a.action}": list, get, open, create, init, set, bake, packages, use, follow, publish, outdated or update`, true);
    },
  };
}
