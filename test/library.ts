// Gallery libraries (src/gallery/library.ts, bake.ts): the config, scanning a library (projects, collections, what a
// scan skips, id collisions), project.json validation, creating projects, the MCP server's project rule, the bake
// key, and baking previews (a valid PNG and meshopt GLB; a failed bake keeps the previous files and says why).
//   node test/library.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addLibrary, loadConfig } from '../src/config.ts';
import { startProject, notProjectFiles, parseManifest, projectDirOf, readManifest, slugify, writeManifest } from '../src/project.ts';
import { bakeKey, createProject, isStale, readBakeState, scanLibrary } from '../src/gallery/library.ts';
import { LIBRARY_FILE, WORKSPACE_FILE, librariesFor, libraryName, locate } from '../src/project.ts';
import { bakeProject, BakeQueue } from '../src/gallery/bake.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'topotopo-library-'));
process.env.TOPOTOPO_CONFIG = path.join(tmp, 'cfg', 'config.json');
delete process.env.TOPOTOPO_LIBRARIES;

let failures = 0, passes = 0;
const check = (cond: any, msg: string) => { if (cond) passes++; else failures++; console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); };
const section = (s: string) => console.log(`\n== ${s}`);
const throws = (f: () => unknown, re: RegExp) => { try { f(); return false; } catch (e: any) { return re.test(e.message); } };
const BOX = { nodes: { b: { type: 'box', params: { size: [1, 2, 1] } } }, output: 'b' };

section('config');
{
  check(loadConfig().libraries.length === 0 && loadConfig().gallery.port === 7340, 'no config file: no libraries, port 7340');
  const cfg = addLibrary('game', path.join(tmp, 'lib'));
  check(cfg.libraries.length === 1 && cfg.libraries[0].path === path.join(tmp, 'lib') && fs.existsSync(path.join(tmp, 'lib')), 'library add writes the config and makes the folder');
  addLibrary('game', path.join(tmp, 'lib'));
  check(loadConfig().libraries.length === 1, 'adding a library again re-points it');
  check(throws(() => addLibrary('My Game', tmp), /must match/), 'library names are ids');
  process.env.TOPOTOPO_LIBRARIES = ['extra=' + path.join(tmp, 'extra'), path.join(tmp, 'Other Lib')].join(path.delimiter);
  const names = loadConfig().libraries.map((l) => l.name);
  check(names.join() === 'game,extra,other-lib', `TOPOTOPO_LIBRARIES adds name=path and bare folders (${names})`);
  delete process.env.TOPOTOPO_LIBRARIES;
  check(slugify('Night Market: Lantern!') === 'night-market-lantern' && slugify('Ünïcode') === 'unicode', 'slugify');
}

const lib = { name: 'game', path: path.join(tmp, 'lib') };
section('create and scan');
{
  const lantern = createProject(lib, 'props/lantern', { title: 'Lantern', tags: ['prop', 'hero'], links: [{ label: 'concept', url: 'http://board.local/c/12' }], graph: BOX });
  check(lantern.id === 'lantern' && lantern.collection === 'props' && lantern.rel === 'props/lantern', 'a project in a collection');
  for (const d of ['graphs', 'assets', 'inputs', 'exports', 'attachments']) check(fs.existsSync(path.join(lantern.dir, d)), `created ${d}/`);
  check(fs.readFileSync(path.join(lantern.dir, '.gitignore'), 'utf8').includes('.gallery/'), '.gitignore keeps the derived files out');
  check(JSON.parse(fs.readFileSync(path.join(lantern.dir, 'graphs', 'main.json'), 'utf8')).output === 'b', 'the given graph is graphs/main.json');
  check(throws(() => createProject(lib, 'decor/lantern'), /already|used by/), 'an id is unique in its library');
  check(throws(() => createProject(lib, 'props/lantern/parts'), /inside another project/), 'no project inside a project');
  check(throws(() => createProject(lib, '../out'), /bad project path/), 'no path outside the library');
  createProject(lib, 'Crate Big');
  // things a scan must not enter or take as projects
  fs.mkdirSync(path.join(lib.path, '.hidden', 'p'), { recursive: true });
  fs.writeFileSync(path.join(lib.path, '.hidden', 'p', 'project.json'), '{}');
  fs.mkdirSync(path.join(lib.path, 'node_modules', 'p'), { recursive: true });
  fs.writeFileSync(path.join(lib.path, 'node_modules', 'p', 'project.json'), '{}');
  fs.mkdirSync(path.join(lantern.dir, 'attachments', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(lantern.dir, 'attachments', 'nested', 'project.json'), '{}');
  // a folder copied in Explorer: same id; and a broken manifest
  fs.cpSync(lantern.dir, path.join(lib.path, 'props', 'lantern - Copy'), { recursive: true });
  fs.mkdirSync(path.join(lib.path, 'broken'));
  fs.writeFileSync(path.join(lib.path, 'broken', 'project.json'), '{"graph": 5}');
  const s = scanLibrary(lib);
  check(s.projects.map((p) => p.id).join() === 'crate-big,lantern', `projects found, skipped folders ignored (${s.projects.map((p) => p.rel)})`);
  check(s.problems.some((p) => p.includes('lantern - Copy') && p.includes('already used')), 'a copied folder\'s duplicate id is a problem; the first path keeps it');
  check(s.problems.some((p) => p.includes('broken') && p.includes('"graph"')), 'a bad project.json is a problem naming the key');
  check(s.projects.find((p) => p.id === 'lantern')!.manifest.links[0].label === 'concept', 'links are read');
  fs.rmSync(path.join(lib.path, 'props', 'lantern - Copy'), { recursive: true });
  fs.rmSync(path.join(lib.path, 'broken'), { recursive: true });
  check(projectDirOf(path.join(lantern.dir, 'graphs')) === lantern.dir, 'projectDirOf finds the project above a folder');
  check(scanLibrary({ name: 'none', path: path.join(tmp, 'missing') }).problems[0].includes('no folder'), 'a missing library folder is a problem');
}

section('manifest');
{
  check(parseManifest({}, 'x').graph === 'main' && parseManifest({}, 'x').title === 'x', 'defaults: graph main, title = id');
  check(throws(() => parseManifest({ id: 'Bad Id' }, 'x'), /"id"/), 'ids are checked');
  check(throws(() => parseManifest({ graph: '../x' }, 'x'), /graph name/), 'graph names are checked');
  check(throws(() => parseManifest({ bake: { frame: 'a' } }, 'x'), /bake.frame/), 'bake.frame is a number');
  const dir = path.join(lib.path, 'props', 'lantern');
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
  raw.custom = { keep: true };
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(raw));
  writeManifest(dir, { ...readManifest(dir), description: 'Oil lantern' });
  const back = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
  check(back.description === 'Oil lantern' && back.custom?.keep === true, 'writing a manifest keeps keys it does not know');
}

section('the project of the MCP server: a project when it holds nothing but what a project makes itself');
{
  const ws = (name: string, files: Record<string, string> = {}) => {
    const d = path.join(tmp, 'projects', name);
    fs.mkdirSync(d, { recursive: true });
    for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), text); }
    return d;
  };
  const fresh = path.join(tmp, 'projects', 'fresh'), empty = ws('empty');
  const own = ws('own', { 'graphs/main.json': JSON.stringify(BOX), 'assets/rock.json': JSON.stringify(BOX), 'exports/renders/main-b.png': 'png', 'inputs/guides.obj': 'v 0 0 0', '.DS_Store': '', 'Thumbs.db': '' });
  const repo = ws('repo', { 'README.md': '# a game', 'graphs/main.json': JSON.stringify(BOX) }), git = ws('git', { '.git/HEAD': 'ref: refs/heads/main' });
  check([fresh, empty, own].every((d) => !notProjectFiles(d).length), 'a project\'s own folders (and files an operating system leaves) are nothing else, as are no files and no folder');
  check(notProjectFiles(repo).join() === 'README.md' && notProjectFiles(git).join() === '.git/', `anything else is: ${notProjectFiles(repo)}, ${notProjectFiles(git)}`);
  for (const d of [fresh, empty, own]) {
    const s = startProject(d);
    check(/^made the folder .* a project \(project\.json\)/.test(s.log) && s.dir === d && /became a project, ".*", when the server started .* Next: build into graph "main"/.test(s.note ?? '') && fs.existsSync(path.join(d, 'project.json')),
      `${path.basename(d)}: made a project, and the first reply will say so and what to do next`);
  }
  check(readManifest(own).id === 'own' && fs.existsSync(path.join(own, 'graphs', 'main.json')) && fs.existsSync(path.join(own, 'assets', 'rock.json')), 'its graphs and assets stay where they are');
  check(readManifest(fresh).graph === 'main' && JSON.parse(fs.readFileSync(path.join(fresh, 'graphs', 'main.json'), 'utf8')).output === 'box', 'a new one gets a starter graph, the one project.json shows');
  const named = ws('parent/project');
  check(readManifest(startProject(named, { name: 'parent' }).dir).id === 'parent' && readManifest(named).title === 'parent', 'the default folder takes the name of the folder it is in');
  for (const d of [repo, git]) {
    const s = startProject(d);
    check(/is in no project and holds .*, which TopoTopo does not make: left as it is$/.test(s.log) && /cannot use packages, TopoTopo's own kits .* Ask the person before making it a project; library \{action:"init"\} then does it/.test(s.note ?? '') && !fs.existsSync(path.join(d, 'project.json')),
      `${path.basename(d)}: left as it is (${s.log.slice(s.log.indexOf(' holds'))})`);
  }
  check(/^the folder .* is a project$/.test(startProject(own).log) && startProject(own).note === null, 'a project stays as it is, with nothing to tell');
  const sub = ws('own/levels'), inSub = startProject(sub);
  check(inSub.dir === own && /is in the project .*own: working in the project's folder$/.test(inSub.log) && /The server works in the project .*own, the project that holds the folder it was given/.test(inSub.note ?? '') && !fs.existsSync(path.join(sub, 'project.json')),
    'a folder in a project becomes no project of its own: the server works in the project\'s folder, and says so');
}

section('bake');
{
  const p = scanLibrary(lib).projects.find((x) => x.id === 'lantern')!;
  check(isStale(p), 'never baked: stale');
  const k0 = bakeKey(p.dir, p.manifest);
  const s = await bakeProject(p.dir);
  const png = fs.readFileSync(path.join(p.dir, '.gallery', 'thumb.png'));
  const glb = fs.readFileSync(path.join(p.dir, '.gallery', 'preview.glb'));
  check(s.ok && s.key === k0 && s.points === 8 && s.glb, `baked: ${JSON.stringify(s)}`);
  check(png.subarray(1, 4).toString() === 'PNG' && png.readUInt32BE(16) === 512, 'thumb.png is a 512 px PNG');
  check(glb.toString('latin1', 0, 4) === 'glTF' && glb.toString('latin1').includes('EXT_meshopt_compression'), 'preview.glb is a meshopt GLB');
  check(!isStale(p), 'after a bake: not stale');
  fs.writeFileSync(path.join(p.dir, 'inputs', 'guide.obj'), 'v 0 0 0\n');
  check(isStale(p), 'a new input file makes it stale');
  await bakeProject(p.dir);
  fs.writeFileSync(path.join(p.dir, 'attachments', 'concept.png'), png);
  check(!isStale(p), 'attachments do not');
  fs.writeFileSync(path.join(p.dir, 'graphs', 'main.json'), JSON.stringify({ nodes: { b: { type: 'nope' } }, output: 'b' }));
  check(isStale(p), 'a graph edit makes it stale');
  const before = fs.readFileSync(path.join(p.dir, '.gallery', 'thumb.png'));
  const bad = await bakeProject(p.dir);
  check(!bad.ok && /nope/.test(bad.error ?? '') && !isStale(p), `a failed bake records why, under the new key (${bad.error?.split('\n')[0]})`);
  check(fs.readFileSync(path.join(p.dir, '.gallery', 'thumb.png')).equals(before) && fs.existsSync(path.join(p.dir, '.gallery', 'preview.glb')), 'a failed bake keeps the previous thumbnail and GLB');
  writeManifest(p.dir, { ...readManifest(p.dir), graph: 'other' });
  fs.writeFileSync(path.join(p.dir, 'graphs', 'other.json'), JSON.stringify(BOX));
  const p2 = scanLibrary(lib).projects.find((x) => x.id === 'lantern')!;
  check(isStale(p2) && (await bakeProject(p2.dir)).ok, 'the manifest\'s graph choice is part of the key, and is what bakes');
  const none = await bakeProject(scanLibrary(lib).projects.find((x) => x.id === 'crate-big')!.dir);
  check(!none.ok && /no graph "main"/.test(none.error ?? ''), 'a project without its graph says so');
}

section('bake queue (child processes)');
{
  const p = scanLibrary(lib).projects.find((x) => x.id === 'lantern')!;
  fs.writeFileSync(path.join(p.dir, 'graphs', 'other.json'), JSON.stringify({ nodes: { b: { type: 'sphere' } }, output: 'b' }));
  const done: string[] = [];
  const q = new BakeQueue({ onDone: (dir, st) => done.push(`${dir}:${st?.ok}`) });
  check(q.add(p.dir) && !q.add(p.dir), 'a project is queued once');
  await q.idle();
  const st = readBakeState(p.dir)!;
  check(done.length === 1 && st.ok && st.points! > 8 && !isStale(p), `the child baked it (${done[0]})`);
  const slow = new BakeQueue({ timeoutMs: 1 });
  fs.writeFileSync(path.join(p.dir, 'graphs', 'other.json'), JSON.stringify(BOX));
  slow.add(p.dir);
  await slow.idle();
  const late = readBakeState(p.dir)!;
  check(!late.ok && /time limit/.test(late.error ?? ''), `a bake over the time limit is stopped and recorded (${late.error})`);
}

// where a project looks for packages: its own libraries, then the workspace's (the game around it), each library by
// its library.json name when it has one
{
  const game = path.join(tmp, 'game');
  const w = (f: string, d: unknown) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof d === 'string' ? d : JSON.stringify(d)); };
  w(path.join(game, WORKSPACE_FILE), { name: 'game', libraries: ['./art/materials', './art/shared'] });
  w(path.join(game, 'art', 'materials', LIBRARY_FILE), { name: 'game-materials' });
  fs.mkdirSync(path.join(game, 'art', 'shared'), { recursive: true });
  fs.mkdirSync(path.join(game, 'art', 'props-lib'), { recursive: true });
  w(path.join(game, 'art', 'props', 'crate', 'project.json'), { id: 'crate', libraries: ['../../props-lib', '../../shared'] });
  const crate = path.join(game, 'art', 'props', 'crate');
  const at = locate(path.join(crate, 'graphs'));
  check(at.project === crate && at.workspace === game, `locate: the project and the workspace around it (${at.project}, ${at.workspace})`);
  check(locate(tmp).workspace === null, 'locate: no workspace outside a game');
  const libs = librariesFor(crate);
  check(libs.libs.map((l) => `${l.name}:${l.from}`).join(' ') === '../../props-lib:project ../../shared:project game-materials:workspace' && !libs.problems.length,
    `librariesFor: the project's libraries, then the workspace's, a library listed by both once, named by library.json (${libs.libs.map((l) => `${l.name}:${l.from}`).join(' ')})`);
  w(path.join(game, WORKSPACE_FILE), { libraries: ['./art/nope'] });
  check(librariesFor(crate).problems.some((p) => p.includes(WORKSPACE_FILE) && /"\.\/art\/nope" is no folder/.test(p)), 'a workspace entry that does not work says so, naming the workspace file');
  check(libraryName(path.join(game, 'art', 'shared')) === null && libraryName(path.join(game, 'art', 'materials')) === 'game-materials', 'libraryName: library.json, or none');
}

console.log(`\n${passes} passed, ${failures} failed — temp ${tmp}`);
process.exit(failures ? 1 : 0);
