// The `library` tool: the person's libraries of projects (src/gallery/library.ts) and the packages of the open project
// (src/gallery/packages.ts). An agent lists and searches every library, reads a project, makes new ones, edits their
// project.json, bakes previews, and opens a project: the server's workspace becomes that project folder, so
// build/edit/render/export work on it. In the open project it publishes a version of its package, lists and adds the
// packages it uses, and follows a package's working folder for the session.
import fs from 'node:fs';
import path from 'node:path';
import type { Workspace } from '../workspace.ts';
import type { ToolDef, ToolResult, Content } from './tools.ts';
import {
  createProject, graphNames, isStale, listFiles, loadConfig, parseManifest, projectDirOf, readBakeState, readGraph, readManifest,
  scanAll, writeManifest,
} from '../gallery/library.ts';
import type { GalleryConfig, LibraryScan, Project } from '../gallery/library.ts';
import { packagesText, publishPackage, publishText } from '../gallery/packages.ts';
import type { ProjectPackages } from '../gallery/packages.ts';

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
      'update {library?, id?, title?, description?, tags?, links?, graph?, bake?, package?}: edit project.json (graph = the graph the gallery shows; bake = {graph?, node?, frame?} what its preview shows; package = "owner/name", the package the project is, set once by its author). bake {library?, id?}: render thumb.png and preview.glb now (the gallery also bakes on its own after changes). ' +
      'Packages of the open project: packages (what it uses, and the packages in the libraries it lists, with their newest version, note and outputs); use {package:"owner/name"} adds one (a graph that names "owner/name/output" adds it too); follow {package, on} uses a package\'s working folder instead of its copy for this session; publish {note, big?} publishes the next version of the project\'s package. See help topics "library" and "packages".',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'open', 'create', 'update', 'bake', 'packages', 'use', 'follow', 'publish'] },
        library: { type: 'string', description: 'library name (list shows them)' },
        id: { type: 'string', description: 'project id' },
        path: { type: 'string', description: 'create: folder below the library ("props/lantern"); open/get: a project folder on disk instead of {library, id}' },
        query: { type: 'string', description: 'list: words to match in title, id, collection, description, tags' },
        tag: { type: 'string', description: 'list: only projects with this tag' },
        title: { type: 'string' },
        description: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        links: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, url: { type: 'string' } }, required: ['url'] }, description: 'links back to the board, concept pages, tickets' },
        graph: { type: 'string', description: 'update: the graph the gallery shows and bakes (default "main")' },
        bake: { type: 'object', properties: { graph: { type: 'string' }, node: { type: 'string' }, frame: { type: 'number' } }, description: 'update: what the preview shows instead of the graph output' },
        thumbnail: { type: 'boolean', description: 'get: include the baked thumbnail image' },
        open: { type: 'boolean', description: 'create: open the new project (default true)' },
        package: { type: 'string', description: 'use / follow: a package, "owner/name"; update: the package the project is' },
        on: { type: 'boolean', description: 'follow: true to follow the package\'s working folder (default), false to go back to its copy' },
        note: { type: 'string', description: 'publish: one line on what changed (required)' },
        big: { type: 'boolean', description: 'publish: mark the version big (its meaning changed in a way the tools cannot see)' },
      },
    },
    run: async (a) => {
      const { cfg, scans } = scan();
      // the packages of the open project as its files are now (a person may have edited project.json)
      if (['packages', 'use', 'follow', 'publish'].includes(a.action)) host.packages().refresh();
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
        case 'update': {
          const p = pick(a, scans);
          const m = { ...p.manifest };
          for (const k of ['title', 'description', 'tags', 'links', 'graph', 'bake', 'package'] as const) if (a[k] !== undefined) (m as any)[k] = a[k];
          const checked = parseManifest(m, p.id);
          writeManifest(p.dir, checked);
          return text(`updated ${p.lib ? `${p.lib}/` : ''}${p.id}: ${JSON.stringify(checked)}`);
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
      return text(`unknown action "${a.action}": list, get, open, create, update, bake, packages, use, follow or publish`, true);
    },
  };
}
