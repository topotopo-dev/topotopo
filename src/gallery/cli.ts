// The gallery's commands (src/cli.ts dispatches here):
//   topotopo gallery [--port 7340] [--library <folder>] [--no-bake]   the gallery website on 127.0.0.1
//   topotopo library add <name> <folder>                             list a folder as a library (~/.topotopo/config.json)
//   topotopo library list                                            libraries, projects and problems
//   topotopo library new <library> <folder/name> [--title t] [--tags a,b] [--description d]
//   topotopo library bake <project folder> | --stale | --all          bake previews in this process
//   topotopo edit <project folder> [--port 7341] [--json]             the live viewer on a project (the gallery's editor)
// and a project's packages (src/gallery/packages.ts, src/gallery/update.ts):
//   topotopo init [folder] [--package owner/name]                     make a folder a project (project.json)
//   topotopo use owner/name [folder]                                  add a package from the libraries the project lists
//   topotopo packages [folder]                                        what it uses, and the packages in its libraries
//   topotopo publish [folder] --note "..." [--big] [--check]          publish the next version of the project's package
//                                                                     (--check: a dry run, nothing written)
//   topotopo search [words] [--kind k] [--tag t]                      the outputs of every library, for the current project
//   topotopo outdated [folder]                                        the newer versions of what it uses, with their notes
//   topotopo update owner/name [folder] [--to <version>] [--render <folder>] [--apply]
//                                                                     the before/after of an update; --apply applies it
import fs from 'node:fs';
import path from 'node:path';
import { KINDS } from '../graph/outputs.ts';
import { addLibrary, createProject, initProject, isStale, loadConfig, projectDirOf, readBakeState, scanAll, slugify } from './library.ts';
import type { GalleryConfig } from './library.ts';

const fail = (msg: string): never => { console.error(msg); process.exit(1); };

export async function galleryCommand(argv: string[], prog: string) {
  const opt = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  let cfg: GalleryConfig;
  try { cfg = loadConfig(); } catch (e: any) { return fail(e.message); }
  const extra = opt('--library');
  if (extra) {
    const name = slugify(path.basename(path.resolve(extra))) || 'library';
    cfg = { ...cfg, libraries: [...cfg.libraries.filter((l) => l.name !== name), { name, path: path.resolve(extra) }] };
  }
  if (!cfg.libraries.length) console.log(`no libraries yet: add a folder with \`${prog} library add <name> <folder>\` (or pass --library <folder>)`);
  const port = opt('--port') !== undefined ? Number(opt('--port')) : cfg.gallery.port;
  const { startGallery, runningGallery } = await import('./server.ts');
  try {
    const g = await startGallery({ config: cfg, port, bake: !argv.includes('--no-bake'), log: (m) => console.log(m) });
    const n = cfg.libraries.length;
    console.log(`gallery: ${g.url}  (${n} librar${n === 1 ? 'y' : 'ies'}: ${cfg.libraries.map((l) => `${l.name} → ${l.path}`).join(', ') || 'none'}; Ctrl+C to stop)`);
    if (g.queue.size) console.log(`baking ${g.queue.size} project(s) in the background`);
  } catch (e: any) {
    if (e?.code !== 'EADDRINUSE') throw e;
    const url = await runningGallery(port);
    if (url) { console.log(`gallery: ${url}  (already running)`); process.exit(0); }
    fail(`port ${port} is taken by another program: pass --port, or set "gallery": {"port": N} in ${cfg.file}`);
  }
}

export async function libraryCommand(argv: string[], prog: string) {
  const opt = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const [sub, a, b] = argv;
  const usage = `usage: ${prog} library add <name> <folder> | list | new <library> <folder/name> [--title t] [--tags a,b] [--description d] | bake <project folder> | bake --stale | bake --all`;
  let cfg: GalleryConfig;
  try { cfg = loadConfig(); } catch (e: any) { return fail(e.message); }

  if (sub === 'add') {
    if (!a || !b) fail(usage);
    try { cfg = addLibrary(a, b); } catch (e: any) { fail(e.message); }
    console.log(`library ${a} → ${path.resolve(b)} (in ${cfg.file})`);
    return;
  }
  if (sub === 'list') {
    if (!cfg.libraries.length) console.log(`no libraries (config ${cfg.file}): ${prog} library add <name> <folder>`);
    for (const s of scanAll(cfg)) {
      console.log(`${s.name}  ${s.root}  (${s.projects.length} projects)`);
      for (const p of s.projects) {
        const st = readBakeState(p.dir);
        const status = !st ? 'not baked' : !st.ok ? 'bake failed' : isStale(p) ? 'stale' : 'baked';
        console.log(`  ${p.id.padEnd(24)} ${p.rel.padEnd(32)} ${status}${p.manifest.tags.length ? '  [' + p.manifest.tags.join(', ') + ']' : ''}`);
      }
      for (const pr of s.problems) console.log(`  ! ${pr}`);
    }
    return;
  }
  if (sub === 'new') {
    if (!a || !b) fail(usage);
    const lib = cfg.libraries.find((l) => l.name === a) ?? fail(`no library "${a}" (${cfg.libraries.map((l) => l.name).join(', ') || `none: ${prog} library add <name> <folder>`})`);
    try {
      const p = createProject(lib, b, { title: opt('--title'), description: opt('--description'), tags: opt('--tags')?.split(',').map((t) => t.trim()).filter(Boolean) });
      console.log(`project ${p.lib}/${p.id} → ${p.dir}`);
      console.log(`  gallery: http://127.0.0.1:${cfg.gallery.port}/p/${p.lib}/${p.id}`);
    } catch (e: any) { fail(e.message); }
    return;
  }
  if (sub === 'bake') {
    if (!a) fail(usage);
    const { bakeProject } = await import('./bake.ts');
    let dirs: string[];
    if (a === '--all' || a === '--stale') dirs = scanAll(cfg).flatMap((s) => s.projects).filter((p) => a === '--all' || isStale(p)).map((p) => p.dir);
    else {
      const d = projectDirOf(a);
      if (!d) fail(`${a}: no project.json here or in a parent folder`);
      dirs = [d!];
    }
    let failed = 0;
    for (const d of dirs) {
      const s = await bakeProject(d);
      if (!s.ok) failed++;
      console.log(`${s.ok ? 'ok  ' : 'FAIL'} ${d}  ${s.ok ? `${s.ms} ms, ${s.points} points, ${s.prims} prims${s.glb ? '' : ', no preview.glb'}` : s.error}`);
    }
    if (!dirs.length) console.log('nothing to bake');
    process.exit(failed ? 1 : 0);
  }
  fail(usage);
}

/** `edit <project>`: the live viewer on a project's workspace, following changes other processes make to it. */
export async function editCommand(argv: string[], prog: string) {
  const opt = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const dir = argv[0] && !argv[0].startsWith('-') ? projectDirOf(argv[0]) ?? path.resolve(argv[0]) : fail(`usage: ${prog} edit <project folder> [--port 7341] [--json]`);
  if (!fs.existsSync(dir)) fail(`no folder ${dir}`);
  const { Engine } = await import('../graph/engine.ts');
  const { createNodeHost } = await import('../host/node.ts');
  const { Workspace } = await import('../workspace.ts');
  const { startViewer } = await import('../viewer/server.ts');
  const { openPackages } = await import('./packages.ts');
  const engine = new Engine(createNodeHost({ baseDir: dir }));
  await engine.init();
  const ws = new Workspace(dir, engine);
  ws.packages = openPackages(engine, dir);
  ws.load();
  ws.watch();
  const v = await startViewer(ws, opt('--port') !== undefined ? Number(opt('--port')) : undefined);
  if (argv.includes('--json')) {
    // started by the gallery: report the URL, and stop once no page has been open for a while
    console.log(JSON.stringify({ url: v.url }));
    let idleSince = Date.now();
    setInterval(() => {
      if (v.clients() > 0) idleSince = Date.now();
      else if (Date.now() - idleSince > 10 * 60_000) { v.close(); process.exit(0); }
    }, 30_000);
  } else console.log(`edit: ${v.url}  (${dir}; Ctrl+C to stop)`);
}

/** The folder a package command acts on: the argument that is not an option (or its value), else the current one. */
function folderArg(argv: string[], valued: string[], skip = 0): string {
  const rest = argv.filter((x, i) => !x.startsWith('--') && !valued.includes(argv[i - 1]));
  return path.resolve(rest[skip] ?? '.');
}

/** `init [folder] [--package owner/name]`: make a folder a project. */
export async function initCommand(argv: string[], prog: string) {
  const opt = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  if (argv.includes('--package') && (opt('--package') === undefined || opt('--package')!.startsWith('--'))) fail(`usage: ${prog} init [folder] [--package owner/name]`);
  try {
    const { dir, manifest } = initProject(folderArg(argv, ['--package']), { package: opt('--package') });
    console.log(`project ${manifest.id} → ${dir}${manifest.package ? ` (package ${manifest.package})` : ''}`);
    console.log(`  graphs go in graphs/ ("graph": "${manifest.graph}" is the one it shows); list the libraries it finds packages in under "libraries" in project.json`);
  } catch (e: any) { fail(e.message); }
}

/** The packages of the project a folder belongs to, in an engine of their own. */
async function projectPackages(dir: string, prog: string) {
  const { Engine } = await import('../graph/engine.ts');
  const { createNodeHost } = await import('../host/node.ts');
  const { openPackages } = await import('./packages.ts');
  const project = projectDirOf(dir) ?? fail(`${dir} is in no project: ${prog} init <folder> makes a folder a project (project.json)`);
  const engine = new Engine(createNodeHost({ baseDir: project }));
  await engine.init();
  return { engine, project, pk: openPackages(engine, project) };
}

/** `use owner/name [folder]`: add a package to the project from the libraries it lists. */
export async function useCommand(argv: string[], prog: string) {
  const [pkg] = argv.filter((x) => !x.startsWith('--'));
  if (!pkg) fail(`usage: ${prog} use owner/name [folder]`);
  const { pk } = await projectPackages(folderArg(argv, [], 1), prog);
  try { console.log(pk.use(pkg).text); } catch (e: any) { fail(e.message); }
  for (const p of pk.check()) console.error(`warning: ${p}`);
}

/** `packages [folder]`: what the project uses, and the packages in the libraries it lists. */
export async function packagesCommand(argv: string[], prog: string) {
  const { packagesText } = await import('./packages.ts');
  const { pk } = await projectPackages(folderArg(argv, []), prog);
  console.log(packagesText(pk));
}

/**
 * `publish [folder] --note "..." [--big]`: publish the next version of the project's package; `--check` is a dry run
 * that says what publishing would do and writes nothing.
 */
export async function publishCommand(argv: string[], prog: string) {
  const opt = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  if (argv.includes('--note') && (opt('--note') === undefined || opt('--note')!.startsWith('--'))) fail(`usage: ${prog} publish [folder] --note "what changed" [--big] [--check]`);
  const { loadProject, publishPackage, publishText } = await import('./packages.ts');
  const { Workspace } = await import('../workspace.ts');
  const { engine, project, pk } = await projectPackages(folderArg(argv, ['--note']), prog);
  // the project's graphs and assets in the root, read without writing anything into its folder (a workspace's load
  // would make its folders)
  const ws = new Workspace(project, engine);
  ws.packages = pk;
  for (const p of loadProject(engine, project)) console.error(`warning: ${p}`);
  const r = await publishPackage(ws, pk, { note: opt('--note'), big: argv.includes('--big'), check: argv.includes('--check') });
  console.log(publishText(r));
  await engine.host.pool?.close();
  process.exit(r.ok ? 0 : 1);
}

/** `search [words] [--kind k] [--tag t]`: the outputs of every library, and whether the current folder's project can use them. */
export async function searchCommand(argv: string[], prog: string) {
  const opt = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const valued = ['--kind', '--tag'];
  if (valued.some((f) => argv.includes(f) && (opt(f) === undefined || opt(f)!.startsWith('--')))) fail(`usage: ${prog} search [words] [--kind ${KINDS.join('|')}] [--tag t]`);
  const words = argv.filter((x, i) => !x.startsWith('--') && !valued.includes(argv[i - 1]));
  const { searchPackages, searchText } = await import('./packages.ts');
  try { console.log(searchText(searchPackages(projectDirOf(process.cwd()), { query: words.join(' '), kind: opt('--kind'), tag: opt('--tag') }))); }
  catch (e: any) { fail(e.message); }
}

/** `outdated [folder]`: for each package the project uses, the newer versions in its libraries and their notes. */
export async function outdatedCommand(argv: string[], prog: string) {
  const { outdatedText } = await import('./update.ts');
  const { pk } = await projectPackages(folderArg(argv, []), prog);
  try { console.log(outdatedText(pk)); } catch (e: any) { fail(e.message); }
}

/**
 * `update owner/name [folder] [--to <version>] [--render <folder>] [--apply]`: the before/after of updating a package
 * the project uses, which writes nothing (--render writes its overlay renders into a folder); the same command with
 * --apply applies the update. Ctrl+C stops a long before/after at the next node.
 */
export async function updateCommand(argv: string[], prog: string) {
  const opt = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const usage = `usage: ${prog} update owner/name [folder] [--to <version>] [--render <folder>] [--apply]`;
  const valued = ['--to', '--render'];
  if (valued.some((f) => argv.includes(f) && (opt(f) === undefined || opt(f)!.startsWith('--')))) fail(usage);
  const [pkg, folder] = argv.filter((x, i) => !x.startsWith('--') && !valued.includes(argv[i - 1]));
  if (!pkg) fail(usage);
  const { applyUpdate, beforeAfter, beforeAfterText, overlayRenders } = await import('./update.ts');
  const { loadProject } = await import('./packages.ts');
  const { engine, project, pk } = await projectPackages(path.resolve(folder ?? '.'), prog);
  try {
    if (argv.includes('--apply')) { console.log(applyUpdate(pk, pkg, opt('--to')).text); return; }
    for (const p of loadProject(engine, project)) console.error(`warning: ${p}`);
    const stop = { aborted: false };
    process.once('SIGINT', () => { stop.aborted = true; console.error('stopping at the next node (Ctrl+C again ends it at once); nothing is written'); });
    const r = await beforeAfter(pk, pkg, { to: opt('--to'), signal: stop, progress: (done, total, what) => console.error(`[${done + 1}/${total}] ${what}`) });
    const again = `${prog} ${['update', pkg, ...(folder ? [folder] : []), '--to', r.target.to, '--apply'].map((x) => (/\s/.test(x) ? JSON.stringify(x) : x)).join(' ')}`;
    console.log(beforeAfterText(r, `nothing was written. To apply it: ${again}`));
    const renders = overlayRenders(r, Infinity), dir = opt('--render');
    if (dir && renders.length) {
      fs.mkdirSync(path.resolve(dir), { recursive: true });
      const files = renders.map((x, i) => {
        const file = path.join(path.resolve(dir), `${String(i + 1).padStart(2, '0')}-${x.title.replace(/[^A-Za-z0-9_.-]+/g, '_')}.png`);
        fs.writeFileSync(file, x.png);
        return file;
      });
      console.log(`overlay renders (grey: the same with both, blue: only with ${r.target.to}, orange: only with ${r.target.from}):`, ...files.map((f) => `\n  ${f}`));
    } else if (renders.length) console.log(`--render <folder> writes an overlay render of each place that changed`);
    await engine.host.pool?.close();
    process.exit(r.stopped ? 1 : 0);
  } catch (e: any) { fail(e.message); }
}
