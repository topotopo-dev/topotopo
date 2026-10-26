// The gallery's commands (src/cli.ts dispatches here):
//   topotopo gallery [--port 7340] [--library <folder>] [--no-bake]   the gallery website on 127.0.0.1
//   topotopo library add <name> <folder>                             list a folder as a library (~/.topotopo/config.json)
//   topotopo library list                                            libraries, projects and problems
//   topotopo library new <library> <folder/name> [--title t] [--tags a,b] [--description d]
//   topotopo library bake <project folder> | --stale | --all          bake previews in this process
//   topotopo edit <project folder> [--port 7341] [--json]             the live viewer on a project (the gallery's editor)
import fs from 'node:fs';
import path from 'node:path';
import { addLibrary, createProject, isStale, loadConfig, projectDirOf, readBakeState, scanAll, slugify } from './library.ts';
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
  const engine = new Engine(createNodeHost({ baseDir: dir }));
  await engine.init();
  const ws = new Workspace(dir, engine);
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
