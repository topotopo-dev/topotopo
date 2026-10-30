// Libraries of the web app (src/web/library.ts, bake.ts): the config, scanning a library (packages, collections, what a
// scan skips, id collisions), manifest validation, creating packages, the MCP server's package rule, the bake
// key, and baking previews (a valid PNG and meshopt GLB; a failed bake keeps the previous files and says why).
//   node test/library.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addLibrary, loadConfig } from '../src/config.ts';
import { initPackage, manifestAt, manifestFile, oldManifest, packageId, startPackage, notPackageFiles, parseManifest, packageDirOf, readManifest, slugify, writeManifest } from '../src/package.ts';
import { bakeKey, createPackage, isStale, readBakeState, scanLibrary } from '../src/web/library.ts';
import { LIBRARY_FILE, WORKSPACE_FILE, librariesFor, libraryName, locate } from '../src/package.ts';
import { initWorkspace, parseWorkspace, readWorkspace, workspaceText } from '../src/workspace.ts';
import { commands } from '../src/packages/commands.ts';
import { bakePackage, BakeQueue } from '../src/web/bake.ts';

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
  check(loadConfig().libraries.length === 0 && loadConfig().web.port === 7340, 'no config file: no libraries, port 7340');
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
  const lantern = createPackage(lib, 'props/lantern', { title: 'Lantern', tags: ['prop', 'hero'], links: [{ label: 'concept', url: 'http://board.local/c/12' }], graph: BOX });
  check(lantern.id === 'lantern' && lantern.collection === 'props' && lantern.rel === 'props/lantern', 'a package in a collection');
  for (const d of ['graphs', 'assets', 'inputs', 'exports', 'attachments']) check(fs.existsSync(path.join(lantern.dir, d)), `created ${d}/`);
  check(fs.readFileSync(path.join(lantern.dir, '.gitignore'), 'utf8').includes('.web/'), '.gitignore keeps the derived files out');
  check(JSON.parse(fs.readFileSync(path.join(lantern.dir, 'graphs', 'main.json'), 'utf8')).output === 'b', 'the given graph is graphs/main.json');
  check(throws(() => createPackage(lib, 'decor/lantern'), /already|used by/), 'an id is unique in its library');
  check(throws(() => createPackage(lib, 'props/lantern/parts'), /inside another package/), 'no package inside a package');
  check(throws(() => createPackage(lib, '../out'), /bad package path/), 'no path outside the library');
  createPackage(lib, 'Crate Big');
  // things a scan must not enter or take as packages
  fs.mkdirSync(path.join(lib.path, '.hidden', 'p'), { recursive: true });
  fs.writeFileSync(path.join(lib.path, '.hidden', 'p', 'p.topo'), '{}');
  fs.mkdirSync(path.join(lib.path, 'node_modules', 'p'), { recursive: true });
  fs.writeFileSync(path.join(lib.path, 'node_modules', 'p', 'p.topo'), '{}');
  fs.mkdirSync(path.join(lantern.dir, 'attachments', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(lantern.dir, 'attachments', 'nested', 'nested.topo'), '{}');
  // a folder copied in Explorer: same id; and a broken manifest
  fs.cpSync(lantern.dir, path.join(lib.path, 'props', 'lantern - Copy'), { recursive: true });
  fs.mkdirSync(path.join(lib.path, 'broken'));
  fs.writeFileSync(path.join(lib.path, 'broken', 'broken.topo'), '{"graph": 5}');
  // a package of before .topo files: no package, said with what to rename
  fs.mkdirSync(path.join(lib.path, 'old'));
  fs.writeFileSync(path.join(lib.path, 'old', 'project.json'), '{"id": "barrel", "package": "studio/barrel"}');
  const s = scanLibrary(lib);
  check(s.packages.map((p) => p.id).join() === 'crate-big,lantern', `packages found, skipped folders ignored (${s.packages.map((p) => p.rel)})`);
  check(s.problems.some((p) => p.includes('lantern - Copy') && p.includes('already used')), 'a copied folder\'s duplicate id is a problem; the first path keeps it');
  check(s.problems.some((p) => p.includes('broken') && p.includes('"graph"')), 'a bad manifest is a problem naming the key');
  check(s.problems.some((p) => /old holds project\.json, which TopoTopo no longer reads: rename it to barrel\.topo and, in it, "package" to "name" and remove "id"$/.test(p)) && !s.packages.some((p) => p.rel === 'old'),
    'a folder with project.json is no package: the scan says what to rename it to');
  fs.rmSync(path.join(lib.path, 'old'), { recursive: true });
  check(s.packages.find((p) => p.id === 'lantern')!.manifest.links[0].label === 'concept', 'links are read');
  fs.rmSync(path.join(lib.path, 'props', 'lantern - Copy'), { recursive: true });
  fs.rmSync(path.join(lib.path, 'broken'), { recursive: true });
  check(packageDirOf(path.join(lantern.dir, 'graphs')) === lantern.dir && manifestFile(lantern.dir) === path.join(lantern.dir, 'lantern.topo') && packageId(lantern.dir) === 'lantern',
    'packageDirOf finds the package above a folder: the nearest folder with a .topo file, whose name is the package id');
  check(scanLibrary({ name: 'none', path: path.join(tmp, 'missing') }).problems[0].includes('no folder'), 'a missing library folder is a problem');
}

section('manifest');
{
  check(parseManifest({}, 'x').graph === 'main' && parseManifest({}, 'x').title === 'x', 'defaults: graph main, title = id');
  check(throws(() => parseManifest({ id: 'x' }, 'x'), /"id": the file's name is the package id; remove "id"/), 'the id is the file\'s name, never a field');
  check(throws(() => parseManifest({ graph: '../x' }, 'x'), /graph name/), 'graph names are checked');
  check(throws(() => parseManifest({ bake: { frame: 'a' } }, 'x'), /bake.frame/), 'bake.frame is a number');
  const dir = path.join(lib.path, 'props', 'lantern');
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'lantern.topo'), 'utf8'));
  raw.custom = { keep: true };
  fs.writeFileSync(path.join(dir, 'lantern.topo'), JSON.stringify(raw));
  writeManifest(dir, { ...readManifest(dir), description: 'Oil lantern' });
  const back = JSON.parse(fs.readFileSync(path.join(dir, 'lantern.topo'), 'utf8'));
  check(back.description === 'Oil lantern' && back.custom?.keep === true && !('id' in back), 'writing a manifest keeps keys it does not know, and writes no id');
  // where a package is: one .topo file in its folder
  const two = path.join(tmp, 'two-manifests');
  fs.mkdirSync(path.join(two, 'graphs'), { recursive: true });
  fs.writeFileSync(path.join(two, 'a.topo'), '{}');
  fs.writeFileSync(path.join(two, 'b.topo'), '{}');
  check(throws(() => packageDirOf(path.join(two, 'graphs')), /two-manifests holds a\.topo and b\.topo: a package has one \.topo file, whose name is its id/), 'a folder with two .topo files is an error naming both');
  const bad = path.join(tmp, 'bad-name');
  fs.mkdirSync(bad);
  fs.writeFileSync(path.join(bad, 'Big Crate.topo'), '{}');
  check(throws(() => manifestAt(bad), /Big Crate\.topo: the file's name is the package id: .* \("big-crate\.topo"\)/), 'a .topo file whose name is no id says the name to give it');
  const old = path.join(tmp, 'old-manifest');
  fs.mkdirSync(old);
  fs.writeFileSync(path.join(old, 'project.json'), '{"title": "Old"}');
  check(packageDirOf(old) === null && manifestAt(old) === null && /old-manifest holds project\.json, which TopoTopo no longer reads: rename it to old-manifest\.topo$/.test(oldManifest(old) ?? '')
    && throws(() => readManifest(old), /rename it to old-manifest\.topo/) && throws(() => initPackage(old), /rename it to old-manifest\.topo/),
    'a folder with project.json and no .topo file is no package: reading it or making it one says to rename the file after the folder');
}

section('the package of the MCP server: a package when it holds nothing but what a package makes itself');
{
  const ws = (name: string, files: Record<string, string> = {}) => {
    const d = path.join(tmp, 'packages', name);
    fs.mkdirSync(d, { recursive: true });
    for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), text); }
    return d;
  };
  const fresh = path.join(tmp, 'packages', 'fresh'), empty = ws('empty');
  const own = ws('own', { 'graphs/main.json': JSON.stringify(BOX), 'assets/rock.json': JSON.stringify(BOX), 'exports/renders/main-b.png': 'png', 'inputs/guides.obj': 'v 0 0 0', '.DS_Store': '', 'Thumbs.db': '' });
  const repo = ws('repo', { 'README.md': '# a game', 'graphs/main.json': JSON.stringify(BOX) }), git = ws('git', { '.git/HEAD': 'ref: refs/heads/main' });
  check([fresh, empty, own].every((d) => !notPackageFiles(d).length), 'a package\'s own folders (and files an operating system leaves) are nothing else, as are no files and no folder');
  check(notPackageFiles(repo).join() === 'README.md' && notPackageFiles(git).join() === '.git/', `anything else is: ${notPackageFiles(repo)}, ${notPackageFiles(git)}`);
  for (const d of [fresh, empty, own]) {
    const s = startPackage(d);
    check(/^made the folder .* a package \([a-z]+\.topo\)/.test(s.log) && s.dir === d && /became a package, ".*", when the server started .* Next: build into graph "main"/.test(s.note ?? '') && fs.existsSync(path.join(d, `${path.basename(d)}.topo`)),
      `${path.basename(d)}: made a package, and the first reply will say so and what to do next`);
  }
  check(packageId(own) === 'own' && fs.existsSync(path.join(own, 'graphs', 'main.json')) && fs.existsSync(path.join(own, 'assets', 'rock.json')), 'its graphs and assets stay where they are');
  check(readManifest(fresh).graph === 'main' && JSON.parse(fs.readFileSync(path.join(fresh, 'graphs', 'main.json'), 'utf8')).output === 'box', 'a new one gets a starter graph, the one its manifest shows');
  const named = ws('parent/package');
  check(packageId(startPackage(named, { title: 'parent' }).dir) === 'parent' && fs.existsSync(path.join(named, 'parent.topo')) && readManifest(named).title === 'parent', 'the default folder takes the name of the folder it is in');
  for (const d of [repo, git]) {
    const s = startPackage(d);
    check(/is in no package and holds .*, which TopoTopo does not make: left as it is$/.test(s.log) && /cannot use packages, TopoTopo's own packages .* Ask the person before making it a package; workspace \{action:"init"\} then does it/.test(s.note ?? '') && !manifestAt(d),
      `${path.basename(d)}: left as it is (${s.log.slice(s.log.indexOf(' holds'))})`);
  }
  check(/^the folder .* is a package$/.test(startPackage(own).log) && startPackage(own).note === null, 'a package stays as it is, with nothing to tell');
  const sub = ws('own/levels'), inSub = startPackage(sub);
  check(inSub.dir === own && /is in the package .*own: working in the package's folder$/.test(inSub.log) && /The server works in the package .*own, the package that holds the folder it was given/.test(inSub.note ?? '') && !manifestAt(sub),
    'a folder in a package becomes no package of its own: the server works in the package\'s folder, and says so');
}

section('bake');
{
  const p = scanLibrary(lib).packages.find((x) => x.id === 'lantern')!;
  check(isStale(p), 'never baked: stale');
  const k0 = bakeKey(p.dir, p.manifest);
  const s = await bakePackage(p.dir);
  const png = fs.readFileSync(path.join(p.dir, '.web', 'thumb.png'));
  const glb = fs.readFileSync(path.join(p.dir, '.web', 'preview.glb'));
  check(s.ok && s.key === k0 && s.points === 8 && s.glb, `baked: ${JSON.stringify(s)}`);
  check(png.subarray(1, 4).toString() === 'PNG' && png.readUInt32BE(16) === 512, 'thumb.png is a 512 px PNG');
  check(glb.toString('latin1', 0, 4) === 'glTF' && glb.toString('latin1').includes('EXT_meshopt_compression'), 'preview.glb is a meshopt GLB');
  check(!isStale(p), 'after a bake: not stale');
  fs.writeFileSync(path.join(p.dir, 'inputs', 'guide.obj'), 'v 0 0 0\n');
  check(isStale(p), 'a new input file makes it stale');
  await bakePackage(p.dir);
  fs.writeFileSync(path.join(p.dir, 'attachments', 'concept.png'), png);
  check(!isStale(p), 'attachments do not');
  fs.writeFileSync(path.join(p.dir, 'graphs', 'main.json'), JSON.stringify({ nodes: { b: { type: 'nope' } }, output: 'b' }));
  check(isStale(p), 'a graph edit makes it stale');
  const before = fs.readFileSync(path.join(p.dir, '.web', 'thumb.png'));
  const bad = await bakePackage(p.dir);
  check(!bad.ok && /nope/.test(bad.error ?? '') && !isStale(p), `a failed bake records why, under the new key (${bad.error?.split('\n')[0]})`);
  check(fs.readFileSync(path.join(p.dir, '.web', 'thumb.png')).equals(before) && fs.existsSync(path.join(p.dir, '.web', 'preview.glb')), 'a failed bake keeps the previous thumbnail and GLB');
  writeManifest(p.dir, { ...readManifest(p.dir), graph: 'other' });
  fs.writeFileSync(path.join(p.dir, 'graphs', 'other.json'), JSON.stringify(BOX));
  const p2 = scanLibrary(lib).packages.find((x) => x.id === 'lantern')!;
  check(isStale(p2) && (await bakePackage(p2.dir)).ok, 'the manifest\'s graph choice is part of the key, and is what bakes');
  const none = await bakePackage(scanLibrary(lib).packages.find((x) => x.id === 'crate-big')!.dir);
  check(!none.ok && /no graph "main"/.test(none.error ?? ''), 'a package without its graph says so');
}

section('bake queue (child processes)');
{
  const p = scanLibrary(lib).packages.find((x) => x.id === 'lantern')!;
  fs.writeFileSync(path.join(p.dir, 'graphs', 'other.json'), JSON.stringify({ nodes: { b: { type: 'sphere' } }, output: 'b' }));
  const done: string[] = [];
  const q = new BakeQueue({ onDone: (dir, st) => done.push(`${dir}:${st?.ok}`) });
  check(q.add(p.dir) && !q.add(p.dir), 'a package is queued once');
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

// where a package looks for packages: its own libraries, then the workspace's (the game around it), each library by
// its library.json name when it has one
{
  const game = path.join(tmp, 'game');
  const w = (f: string, d: unknown) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof d === 'string' ? d : JSON.stringify(d)); };
  w(path.join(game, WORKSPACE_FILE), { name: 'game', libraries: ['./art/materials', './art/shared'] });
  w(path.join(game, 'art', 'materials', LIBRARY_FILE), { name: 'game-materials' });
  fs.mkdirSync(path.join(game, 'art', 'shared'), { recursive: true });
  fs.mkdirSync(path.join(game, 'art', 'props-lib'), { recursive: true });
  w(path.join(game, 'art', 'props', 'crate', 'crate.topo'), { libraries: ['../../props-lib', '../../shared'] });
  const crate = path.join(game, 'art', 'props', 'crate');
  const at = locate(path.join(crate, 'graphs'));
  check(at.package === crate && at.workspace === game, `locate: the package and the workspace around it (${at.package}, ${at.workspace})`);
  check(locate(tmp).workspace === null, 'locate: no workspace outside a game');
  const libs = librariesFor(crate);
  check(libs.libs.map((l) => `${l.name}:${l.from}`).join(' ') === '../../props-lib:package ../../shared:package game-materials:workspace' && !libs.problems.length,
    `librariesFor: the package's libraries, then the workspace's, a library listed by both once, named by library.json (${libs.libs.map((l) => `${l.name}:${l.from}`).join(' ')})`);
  w(path.join(game, WORKSPACE_FILE), { libraries: ['./art/nope'] });
  check(librariesFor(crate).problems.some((p) => p.includes(WORKSPACE_FILE) && /"\.\/art\/nope" is no folder/.test(p)), 'a workspace entry that does not work says so, naming the workspace file');
  check(libraryName(path.join(game, 'art', 'shared')) === null && libraryName(path.join(game, 'art', 'materials')) === 'game-materials', 'libraryName: library.json, or none');
}

// a workspace: the game's file (name, libraries, engine, follow), made by init (the engine found below), shown, registered
{
  const game = path.join(tmp, 'ws-game');
  fs.mkdirSync(path.join(game, 'godot'), { recursive: true });
  fs.writeFileSync(path.join(game, 'godot', 'project.godot'), '[application]\n');
  fs.mkdirSync(path.join(game, 'art', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(game, 'art', 'props', 'crate'), { recursive: true });
  fs.writeFileSync(path.join(game, 'art', 'props', 'crate', 'crate.topo'), JSON.stringify({ name: 'game/crate' }));
  const made = initWorkspace(game, { libraries: ['./art/lib'], assets: 'godot/assets/topotopo' });
  const m = readWorkspace(game);
  check(m.name === 'ws-game' && m.libraries.join() === './art/lib' && m.engine?.type === 'godot' && m.engine.project === 'godot/project.godot' && m.engine.assets === 'godot/assets/topotopo' && !m.follow,
    `workspace init: the name from the folder, the libraries given, the Godot project found, the assets folder (${made.text.split('\n').join(' | ')})`);
  const again = initWorkspace(game, { name: 'raven', engine: 'none' });
  check(again.manifest.name === 'raven' && again.manifest.engine === null && again.manifest.libraries.join() === './art/lib', 'workspace init again changes only what an option says');
  check(throws(() => initWorkspace(game, { engine: 'godot:nope/project.godot' }), /no file/) && throws(() => initWorkspace(game, { engine: 'blender:x' }), /godot:<path to project.godot>/), 'a wrong --engine says what to write');
  check(throws(() => parseWorkspace({ name: 'Raven Hunt' }, 'x'), /"name" must be lower-case/) && throws(() => parseWorkspace({ engine: { type: 'godot' } }, 'x'), /"engine" must be/)
    && throws(() => parseWorkspace({ follow: 'yes' }, 'x'), /"follow" must be true or false/), 'a malformed workspace file says what is wrong');
  const shown = workspaceText(path.join(game, 'art', 'props', 'crate'));
  check(/^workspace "raven"/.test(shown) && /engine: none/.test(shown) && /libraries: \.\/art\/lib/.test(shown) && /packages: 1\n  art\/props\/crate  package game\/crate/.test(shown), `workspace: what it is, from a package inside it (${shown.split('\n').slice(0, 3).join(' | ')})`);
  check(throws(() => workspaceText(tmp), /is in no workspace: .* workspace init/), 'outside a workspace: how to make one');
  const lines: string[] = [], io = { out: (x: string) => lines.push(x), err: (x: string) => lines.push(`ERR ${x}`) };
  const code = await commands.workspace(['add', game], 'topotopo', io);
  const listed = await commands.workspace(['list'], 'topotopo', io);
  check(code === 0 && listed === 0 && loadConfig().workspaces.some((w) => w.name === 'raven' && path.resolve(w.path) === path.resolve(game)) && lines.some((l) => /^raven  /.test(l)),
    `workspace add registers it by its name, list shows it (${lines.join(' | ')})`);
  const lib = librariesFor(path.join(game, 'art', 'props', 'crate'));
  check(lib.libs.some((l) => l.from === 'workspace' && path.resolve(l.root) === path.resolve(game, 'art', 'lib')), 'its packages look in the workspace\'s libraries');
  // a new workspace is named after its engine project (a checkout's folder may be called otherwise)
  const co = path.join(tmp, 'checkout-4062d1');
  fs.mkdirSync(path.join(co, 'game'), { recursive: true });
  fs.writeFileSync(path.join(co, 'game', 'project.godot'), '[application]\n\nconfig/name="Raven Hunt"\nrun/main_scene="res://main.tscn"\n');
  check(initWorkspace(co).manifest.name === 'raven-hunt', 'a new workspace takes its engine project\'s name');
}

console.log(`\n${passes} passed, ${failures} failed — temp ${tmp}`);
process.exit(failures ? 1 : 0);
