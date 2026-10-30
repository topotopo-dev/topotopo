// Libraries and workspaces (src/scan.ts, src/web/library.ts, bake.ts, src/workspace.ts): the config and its one set of
// names, the scan (packages, collections, what it skips and enters, how deep, id collisions), manifest validation,
// creating packages, the MCP server's package rule, the bake key, baking previews (a valid PNG and meshopt GLB; a failed
// bake keeps the previous files and says why), where a package looks, and workspace init with its engine project.
//   node test/library.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addLibrary, addWorkspace, loadConfig, removeLibrary } from '../src/config.ts';
import { initPackage, manifestAt, manifestFile, oldManifest, packageId, startPackage, notPackageFiles, parseManifest, packageDirOf, readManifest, slugify, writeManifest } from '../src/package.ts';
import { bakeKey, createPackage, isStale, readBakeState, scanAll, scanLibrary } from '../src/web/library.ts';
import { forgetScans, scanTree } from '../src/scan.ts';
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
  check(throws(() => createPackage(lib, '../out'), /bad package path/) && throws(() => createPackage(lib, 'Saved/x'), /bad package path/) && throws(() => createPackage(lib, 'node_modules/x'), /bad package path/), 'no path outside the library, nor through a folder the scan never enters');
  // a path the scan would never reach: refused before anything is written, as the scan says it
  {
    const paths = { name: 'paths', path: path.join(tmp, 'paths') };
    const put = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(paths.path, rel)), { recursive: true }); fs.writeFileSync(path.join(paths.path, rel), text); };
    put('tool/Tool.csproj', '');
    put('other-game/project.godot', 'config/name="Other"\n');
    put('nested-ws/topotopo-workspace.json', '{"name": "nested"}');
    put('checkout/package.json', '{"name": "topotopo"}');
    const refused = (rel: string, why: RegExp) => {
      let said = '';
      try { createPackage(paths, rel); } catch (e: any) { said = e.message; }
      return why.test(said) && !fs.existsSync(path.join(paths.path, ...rel.split('/'))) ? '' : `${rel}: ${said || 'made'}`;
    };
    const wrong = [
      refused('tool/bin/crate', /^bad package path "tool\/bin\/crate": tool\/bin: C#'s bin folder beside a \.csproj or \.sln, which the scan never enters/),
      refused('other-game/props/barrel', /^bad package path .*: other-game: another engine project \(it holds project\.godot\), which the scan does not enter/),
      refused('nested-ws/x', /nested-ws: another workspace \(it holds topotopo-workspace\.json\), which the scan does not enter/),
      refused('checkout/y', /checkout: a TopoTopo checkout, which the scan does not enter/),
      refused('a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q', /a\/b\/c\/d\/e\/f\/g\/h\/i\/j\/k\/l\/m\/n\/o\/p\/q: more than 16 folders below .*, deeper than the scan looks/),
    ].filter(Boolean);
    check(!wrong.length, `a path the scan never reaches is refused, nothing written: C#'s bin, another engine project, another workspace, a checkout, deeper than 16 (${wrong.join(' | ')})`);
    check(createPackage(paths, 'a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p').rel === 'a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p' && createPackage(paths, 'plain/bin/kept').rel === 'plain/bin/kept', 'a path the scan reaches is made: 16 folders deep, a bin folder with no .csproj beside it');
  }
  check(createPackage(lib, 'assets/props/stool').rel === 'assets/props/stool', 'a plain folder named assets holds packages');
  fs.rmSync(path.join(lib.path, 'assets'), { recursive: true });
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
  forgetScans();
  const s = scanLibrary(lib);
  check(s.packages.map((p) => p.rel).join() === 'Crate Big,props/lantern,props/lantern - Copy', `packages found, skipped folders ignored (${s.packages.map((p) => p.rel)})`);
  check(s.problems.some((p) => p.includes('lantern - Copy') && p.includes('id "lantern" is also used by props/lantern') && p.includes('the web app shows props/lantern')), 'a copied folder\'s duplicate id is a problem; the web app shows the first path');
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
  forgetScans();
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

section('the scan: what it skips, what it enters, how deep');
{
  const root = path.join(tmp, 'scan');
  const pkg = (rel: string, m: object = {}) => { fs.mkdirSync(path.join(root, rel), { recursive: true }); fs.writeFileSync(path.join(root, rel, `${path.basename(rel)}.topo`), JSON.stringify(m)); };
  const file = (rel: string, text = '') => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  pkg('assets/props/crate');
  pkg('props/lantern');
  pkg('graphs/g'); pkg('exports/e'); pkg('attachments/a'); pkg('inputs/i');
  for (const d of ['Binaries', 'Intermediate', 'Saved', 'DerivedDataCache', '__ExternalActors__', '__ExternalObjects__', 'node_modules', 'topotopo-packages', '.git', 'saved']) pkg(`${d}/x`);
  file('tool/Tool.csproj'); pkg('tool/bin/b'); pkg('tool/obj/o');
  pkg('plain/bin/kept');
  file('other-game/project.godot', 'config/name="Other"\n'); pkg('other-game/assets/p');
  file('nested-ws/topotopo-workspace.json', '{"name": "nested"}'); pkg('nested-ws/p');
  file('checkout/package.json', '{"name": "topotopo"}'); pkg('checkout/library/x');
  file('notours/package.json', '{"name": "something"}'); pkg('notours/p');
  pkg('deep/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o');       // 16 folders below the root: found
  pkg('too-deep/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p');  // 17: cut off, said
  pkg('props/lantern/parts/glass');                 // inside a package: never entered
  const s = scanTree('scan', root);
  const rels = s.packages.map((p) => p.rel);
  check(rels.join() === 'assets/props/crate,attachments/a,deep/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o,exports/e,graphs/g,inputs/i,notours/p,plain/bin/kept,props/lantern',
    `a package is a folder with one .topo file; plain folders of any name are scanned, a package is never entered (${rels})`);
  check(s.workspaces.length === 1 && /nested-ws$/.test(s.workspaces[0]) && !rels.some((r) => r.startsWith('nested-ws')), 'another workspace inside is listed, not scanned');
  check(!rels.some((r) => /^(Binaries|Intermediate|Saved|saved|DerivedDataCache|__External|node_modules|topotopo-packages|\.git|tool|other-game|checkout)/.test(r)),
    'it skips engine build folders (any case), node_modules, topotopo-packages, dot folders, C#\'s bin and obj beside a .csproj, another engine project and a TopoTopo checkout');
  check(s.problems.filter((p) => /more than 16 below/.test(p)).length === 1 && s.problems.some((p) => /^too-deep\/a\/b\/c\/d\/e\/f\/g\/h\/i\/j\/k\/l\/m\/n\/o: its folders are more than 16 below .* and were not looked in for packages$/.test(p)),
    `a folder cut off by the depth cap is said, once (${s.problems.filter((p) => /below/.test(p))})`);
  // the workspace's own engine project is scanned like any other folder; a library scan skips every engine project
  check(scanTree('scan-own', root, { engine: path.join(root, 'other-game', 'project.godot') }).packages.some((p) => p.rel === 'other-game/assets/p'), 'the folder of the workspace\'s own engine project is scanned');
  // a root that is a package itself: said, and not entered (its versions/ and packages/ hold copies, no packages of its own)
  const rooted = path.join(tmp, 'scan-rooted');
  const put = (rel: string, m: object) => { fs.mkdirSync(path.dirname(path.join(rooted, rel)), { recursive: true }); fs.writeFileSync(path.join(rooted, rel), JSON.stringify(m)); };
  put('game.topo', { name: 'studio/game' });
  put('versions/1.0/game.topo', { name: 'studio/game' });
  put('packages/studio/oak/1.0/oak.topo', { name: 'studio/oak' });
  put('levels/yard/yard.topo', {});
  const rs = scanTree('rooted', rooted);
  check(!rs.packages.length && rs.problems.length === 1 && /game\.topo: the folder of "rooted" is a package itself, and a package holds no other: nothing below it is looked in for packages/.test(rs.problems[0]),
    `a root that is a package is said and not entered: its versions and copies are no packages (${rs.packages.map((p) => p.rel)}; ${rs.problems.join(' | ')})`);
  check(scanTree('scan', root) === s, 'a scan is kept for the length of a command');
  forgetScans();
  check(scanTree('scan', root) !== s, 'and read again once forgotten');
}

// where a package looks for packages: in a workspace, the workspace and the shared libraries its file lists; outside
// one, the library it is in and every registered library
{
  const game = path.join(tmp, 'game');
  const w = (f: string, d: unknown) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof d === 'string' ? d : JSON.stringify(d)); };
  const shared = path.join(tmp, 'shared-materials');
  w(path.join(shared, LIBRARY_FILE), { name: 'game-materials' });
  w(path.join(game, WORKSPACE_FILE), { name: 'game', libraries: ['../shared-materials', 'game-lib', './art/shared'] });
  fs.mkdirSync(path.join(game, 'art', 'shared'), { recursive: true });
  w(path.join(game, 'art', 'props', 'crate', 'crate.topo'), {});
  const crate = path.join(game, 'art', 'props', 'crate');
  const at = locate(path.join(crate, 'graphs'));
  check(at.package === crate && at.workspace === game, `locate: the package and the workspace around it (${at.package}, ${at.workspace})`);
  check(locate(tmp).workspace === null, 'locate: no workspace outside one');
  const libs = librariesFor(crate);
  check(libs.libs.map((l) => `${l.name}:${l.from}`).join(' ') === 'game:self game-materials:listed' && libs.problems.length === 2
    && /"game-lib" is not registered on this machine/.test(libs.problems[0]) && /"\.\/art\/shared" is inside the workspace/.test(libs.problems[1]),
    `librariesFor: the workspace itself, then the shared libraries it lists, named by their library.json (${libs.libs.map((l) => `${l.name}:${l.from}`).join(' ')}; ${libs.problems.join(' | ')})`);
  check(libraryName(path.join(game, 'art', 'shared')) === null && libraryName(shared) === 'game-materials', 'libraryName: library.json, or none');
  // outside a workspace: the library around the package (registered, or its library.json), then every registered library
  const out = path.join(tmp, 'outside'), inLib = path.join(shared, 'paints');
  w(path.join(out, 'out.topo'), {});
  w(path.join(inLib, 'paints.topo'), {});
  check(librariesFor(out).libs.map((l) => `${l.name}:${l.from}`).join() === 'game:registered', `outside both: every registered library (${librariesFor(out).libs.map((l) => l.name)})`);
  check(librariesFor(inLib).libs.map((l) => `${l.name}:${l.from}`).join() === 'game-materials:self,game:registered' && librariesFor(inLib).libs[0].byPath, 'in a library (its library.json): that library first, then every registered one');
}

// a workspace: its file (name, shared libraries, engine, follow), made by init (the engine found), shown, registered
{
  const game = path.join(tmp, 'ws-game');
  fs.mkdirSync(path.join(game, 'godot'), { recursive: true });
  fs.writeFileSync(path.join(game, 'godot', 'project.godot'), '[application]\n');
  fs.mkdirSync(path.join(game, 'art', 'props', 'crate'), { recursive: true });
  fs.writeFileSync(path.join(game, 'art', 'props', 'crate', 'crate.topo'), JSON.stringify({ name: 'game/crate' }));
  fs.mkdirSync(path.join(game, 'godot', 'assets', 'barrel'), { recursive: true });
  fs.writeFileSync(path.join(game, 'godot', 'assets', 'barrel', 'barrel.topo'), JSON.stringify({ name: 'game/barrel' }));
  const sharedLib = path.join(tmp, 'ws-shared');
  fs.mkdirSync(sharedLib, { recursive: true });
  const made = initWorkspace(game, { libraries: [sharedLib] });
  const m = readWorkspace(game);
  check(m.name === 'ws-game' && m.libraries.join() === '../ws-shared' && m.engine !== 'none' && m.engine?.type === 'godot' && m.engine.project === 'godot/project.godot' && !m.follow,
    `workspace init: the name from the folder, a library folder written from the workspace, the Godot project found below (${made.text.split('\n').join(' | ')})`);
  check(/packages outside the engine project's folder \(godot\/\), whose exports the engine does not import: art\/props\/crate$/m.test(made.text) && !/godot\/assets\/barrel/.test(made.text.split('\n').find((l) => /outside the engine/.test(l)) ?? ''),
    'with the engine project below the workspace, it lists the packages outside the project\'s folder');
  const again = initWorkspace(game, { name: 'mygame', engine: 'none' });
  check(again.manifest.name === 'mygame' && again.manifest.engine === 'none' && again.manifest.libraries.join() === '../ws-shared', 'workspace init again changes only what an option says');
  check(throws(() => initWorkspace(game, { engine: 'godot:nope/project.godot' }), /no file/) && throws(() => initWorkspace(game, { engine: 'blender:x' }), /godot:<path to project\.godot>/), 'a wrong --engine says what to write');
  check(throws(() => parseWorkspace({ name: 'My Game' }, 'x'), /"name" must be lower-case/) && throws(() => parseWorkspace({ engine: { type: 'godot' } }, 'x'), /"engine" must be/)
    && throws(() => parseWorkspace({ follow: 'yes' }, 'x'), /"follow" must be true or false/), 'a malformed workspace file says what is wrong');
  check(throws(() => parseWorkspace({ engine: { type: 'godot', project: 'p.godot', assets: 'a' } }, 'x'), /"engine\.assets" is gone: an export stays in its package's exports\/ folder; put the workspace inside the engine project .*; remove "assets"/)
    && throws(() => initWorkspace(game, { assets: 'godot/assets' }), /^--assets is gone/), '"engine.assets" and --assets are refused, naming the change');
  const shown = workspaceText(path.join(game, 'art', 'props', 'crate'));
  check(/^workspace "mygame"/.test(shown) && /engine: none/.test(shown) && /shared libraries: \.\.\/ws-shared/.test(shown) && /packages: 1\n {2}art\/props\/crate {2}package game\/crate$/m.test(shown),
    `workspace: what it is, from a package inside it; with no engine project of its own, a folder holding one is another project and is not scanned (${shown.split('\n').slice(0, 3).join(' | ')})`);
  check(throws(() => workspaceText(tmp), /is in no workspace: .* workspace init/), 'outside a workspace: how to make one');
  const lines: string[] = [], io = { out: (x: string) => lines.push(x), err: (x: string) => lines.push(`ERR ${x}`) };
  const code = await commands.workspace(['add', game], 'topotopo', io);
  const listed = await commands.workspace(['list'], 'topotopo', io);
  check(code === 0 && listed === 0 && loadConfig().workspaces.some((w) => w.name === 'mygame' && path.resolve(w.path) === path.resolve(game)) && lines.some((l) => /^mygame  /.test(l)),
    `workspace add registers it by its name, list shows it (${lines.join(' | ')})`);
  // one set of names for workspaces and libraries, and none takes "topotopo"
  check(throws(() => addLibrary('mygame', path.join(tmp, 'x')), /"mygame" is the name of a registered workspace .*: workspaces and libraries share one set of names; give the library another name/), 'library add refuses a workspace\'s name');
  check(throws(() => addWorkspace('game', game), /"game" is the name of a registered library .*: workspaces and libraries share one set of names; give the workspace another name/) && throws(() => addWorkspace('topotopo', game), /TopoTopo's built-in library/), 'workspace add refuses a library\'s name and "topotopo"');
  const named = path.join(tmp, 'game-named');
  fs.mkdirSync(named, { recursive: true });
  check(throws(() => initWorkspace(named, { name: 'game' }), /"game" is the name of a registered library .*give the workspace another name \(--name <another name>\)/) && throws(() => initWorkspace(named, { name: 'topotopo' }), /TopoTopo's built-in library/), 'workspace init refuses a library\'s name and "topotopo"');
  check(removeLibrary('game').libraries.length === 0 && throws(() => removeLibrary('game'), /no library "game" is registered/), 'library remove unregisters a library, and says when there is none of that name');
  addLibrary('game', path.join(tmp, 'lib'));
  // a new workspace is named after its engine project (a checkout's folder may be called otherwise)
  const co = path.join(tmp, 'checkout-4062d1');
  fs.mkdirSync(path.join(co, 'game'), { recursive: true });
  fs.writeFileSync(path.join(co, 'game', 'project.godot'), '[application]\n\nconfig/name="My Game"\nrun/main_scene="res://main.tscn"\n');
  check(initWorkspace(co).manifest.name === 'my-game', 'a new workspace takes its engine project\'s name');
  // a registered workspace renamed: registered again under its new name, which every command then uses
  const renamed = initWorkspace(game, { name: 'renamed' });
  const regs = loadConfig().workspaces.filter((w) => path.resolve(w.path) === path.resolve(game)).map((w) => w.name);
  check(regs.join() === 'renamed' && /registered again under its new name "renamed"/.test(renamed.text), `workspace init --name re-registers a registered workspace under its new name (${regs}; ${renamed.text.split('\n').find((l) => /registered/.test(l))})`);
  const out: string[] = [], io2 = { out: (x: string) => out.push(x), err: (x: string) => out.push(`ERR ${x}`) };
  const newIn = await commands.library(['new', 'renamed', 'props/stool'], 'topotopo', io2);
  check(newIn === 0 && out.some((l) => /\/p\/renamed\/stool$/.test(l)) && scanAll().some((s) => s.workspace && s.name === 'renamed' && s.packages.some((p) => p.id === 'stool' && p.lib === 'renamed')),
    `library new and the scans use the workspace's name (${out.join(' | ')})`);
  // renamed by hand in its file: the name in the file is the one used
  const wsFile = path.join(game, WORKSPACE_FILE);
  fs.writeFileSync(wsFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(wsFile, 'utf8')), name: 'by-hand' }));
  forgetScans();
  out.length = 0;
  const byHand = await commands.library(['new', 'by-hand', 'props/bench'], 'topotopo', io2);
  check(byHand === 0 && out.some((l) => /\/p\/by-hand\/bench$/.test(l)) && scanAll().some((s) => s.workspace && s.name === 'by-hand'), `a workspace renamed in its file goes by the name in its file (${out.join(' | ')})`);
  const { workspaceTool } = await import('../src/mcp/workspace.ts');
  const tool = workspaceTool({ session: () => ({ dir: tmp }) as any, packages: () => ({ refresh() {} }) as any, open: async () => ({ graphs: 0, assets: 0 }) });
  const said = async (a: any) => { try { return (await tool.run(a)).content.map((c: any) => c.text ?? '').join('\n'); } catch (e: any) { return `ERR ${e.message}`; } };
  const mcpList = await said({ action: 'list', library: 'by-hand' }), mcpGet = await said({ action: 'get', library: 'by-hand', id: 'bench' });
  check(/^workspace "by-hand" \(/.test(mcpList) && /\/p\/by-hand\/bench/.test(mcpList) && /^package by-hand\/bench: /.test(mcpGet), `the MCP workspace tool lists and gets it by the same name (${mcpList.split('\n')[0]}; ${mcpGet.split('\n')[0]})`);
  addWorkspace('by-hand', game);
  check(loadConfig().workspaces.filter((w) => path.resolve(w.path) === path.resolve(game)).map((w) => w.name).join() === 'by-hand', 'registering a folder again under its new name leaves one entry for it');
  // a registered library inside a registered workspace is the workspace's: listed as such, its new packages made there
  addLibrary('decor-lib', path.join(game, 'decor'));
  out.length = 0;
  const inLib = await commands.library(['new', 'decor-lib', 'lamps/l1'], 'topotopo', io2);
  const listing: string[] = [];
  await commands.library(['list'], 'topotopo', { out: (x) => listing.push(x), err: (x) => listing.push(`ERR ${x}`) });
  const created = await said({ action: 'create', library: 'decor-lib', path: 'lamps/l2', open: false });
  check(inLib === 0 && fs.existsSync(path.join(game, 'decor', 'lamps', 'l1', 'l1.topo')) && out.some((l) => /page: http:\/\/127\.0\.0\.1:\d+\/p\/by-hand\/l1$/.test(l))
    && /^created by-hand\/l2 at .*decor[\\/]lamps[\\/]l2\. Package page: http:\/\/127\.0\.0\.1:\d+\/p\/by-hand\/l2$/.test(created),
    `library new and the MCP create make a package of a library inside a workspace as the workspace's, at the address the web app serves (${out.join(' | ')}; ${created})`);
  check(listing.some((l) => /^workspace by-hand  .*\(\d+ packages\)$/.test(l)) && listing.some((l) => /^decor-lib  .*decor {2}\(shown as the workspace "by-hand"'s, at decor\/\)$/.test(l)),
    `library list marks the workspaces and names a library inside one (${listing.filter((l) => !/^ {2}/.test(l)).join(' | ')})`);
  removeLibrary('decor-lib');
  // two folders of one library holding one id: the MCP tool names both and asks for the folder
  const twins = path.join(tmp, 'twin-ids');
  for (const lv of ['level1', 'level2']) { fs.mkdirSync(path.join(twins, lv, 'ground'), { recursive: true }); fs.writeFileSync(path.join(twins, lv, 'ground', 'ground.topo'), JSON.stringify({ title: `Ground ${lv}` })); }
  addLibrary('twin-ids', twins);
  const twinGet = await said({ action: 'get', library: 'twin-ids', id: 'ground' });
  const byPath = await said({ action: 'get', path: path.join(twins, 'level2', 'ground') });
  check(/^ERR id "ground" is used by 2 folders of "twin-ids": level1\/ground, level2\/ground \(rename one's \.topo file\); give \{path\} for one$/.test(twinGet) && /"Ground level2"/.test(byPath),
    `an id two folders of one library hold: the MCP tool names both and asks for the folder, which works (${twinGet})`);
  removeLibrary('twin-ids');
  const cfgWas = process.env.TOPOTOPO_CONFIG!;
  process.env.TOPOTOPO_CONFIG = path.join(tmp, 'cfg-ws-only', 'config.json');
  fs.mkdirSync(path.dirname(process.env.TOPOTOPO_CONFIG), { recursive: true });
  fs.writeFileSync(process.env.TOPOTOPO_CONFIG, JSON.stringify({ workspaces: [{ name: 'by-hand', path: game }] }));
  const onlyWs: string[] = [];
  await commands.library(['list'], 'topotopo', { out: (x) => onlyWs.push(x), err: (x) => onlyWs.push(`ERR ${x}`) });
  process.env.TOPOTOPO_CONFIG = cfgWas;
  check(!onlyWs.some((l) => /^no libraries/.test(l)) && /^workspace by-hand/.test(onlyWs[0] ?? ''), `with only workspaces registered, library list does not say there is nothing (${onlyWs[0]})`);
  addWorkspace('other-ws', named);
  fs.writeFileSync(path.join(named, WORKSPACE_FILE), JSON.stringify({ name: 'other-ws' }));
  check(throws(() => initWorkspace(game, { name: 'other-ws' }), /"other-ws" is the name of another registered workspace .*: give the workspace another name/), 'a workspace takes no name another registered workspace has');
}

section('the engine project: at or above the workspace first, then below; what Unreal does not see; Godot export presets');
{
  // a workspace at a Godot project's root, and one at a repository's root with game/project.godot: packages under
  // game/assets/… found in both
  const repo = path.join(tmp, 'engine-repo'), godot = path.join(repo, 'game');
  fs.mkdirSync(path.join(godot, 'assets', 'trees', 'pine'), { recursive: true });
  fs.writeFileSync(path.join(godot, 'project.godot'), 'config/name="Valley"\n');
  fs.writeFileSync(path.join(godot, 'assets', 'trees', 'pine', 'pine.topo'), '{}');
  fs.writeFileSync(path.join(godot, 'export_presets.cfg'), [
    '[preset.0]', 'name="Windows Desktop"', 'platform="Windows Desktop"', 'export_filter="all_resources"', 'include_filter=""', 'exclude_filter="*/graphs/*"', '',
    '[preset.0.options]', 'binary_format/embed_pck=false', '',
    '[preset.1]', 'name="Web"', 'export_filter="resources"', 'include_filter="*.json"', 'exclude_filter=""', '',
    '[preset.2]', 'name="Clean"', 'export_filter="resources"', 'include_filter=""', 'exclude_filter=""', '',
    '[preset.3]', 'name="All But"', 'export_filter="exclude"', 'export_files=PackedStringArray()', 'include_filter=""', 'exclude_filter=""', '',
  ].join('\n'));
  const atRoot = initWorkspace(godot);
  check(atRoot.manifest.name === 'valley' && atRoot.manifest.engine !== 'none' && atRoot.manifest.engine?.project === 'project.godot' && /\(found at or above the workspace\)/.test(atRoot.text) && /^packages: 1/m.test(atRoot.text),
    `a workspace at the Godot project's root: the project is the one at its root, and the packages under assets/ are found (${atRoot.text.split('\n').slice(0, 2).join(' | ')})`);
  check(/export preset "Windows Desktop" exports every resource, so it would ship TopoTopo's files: add to its exclude_filter .* \*\/attachments\/\*, \*\/inputs\/\*, \*\.topo, \*\/exports\/\*\.source\.json, \*\/exports\/\.outputs\.json$/m.test(atRoot.text)
    && /export preset "All But" exports every resource but the files it leaves out, so it would ship TopoTopo's files/.test(atRoot.text)
    && /export preset "Web" includes \*\.json, so it would ship TopoTopo's files/.test(atRoot.text) && !/"Clean"/.test(atRoot.text),
    'it reports the presets that would ship TopoTopo\'s files, with the exclude_filter entries each lacks, and edits nothing');
  check(fs.readFileSync(path.join(godot, 'export_presets.cfg'), 'utf8').includes('exclude_filter="*/graphs/*"'), 'the presets stay as they were');
  fs.rmSync(path.join(godot, 'topotopo-workspace.json'));
  const fromRepo = initWorkspace(repo, { name: 'valley-repo' });
  check(fromRepo.manifest.engine !== 'none' && fromRepo.manifest.engine?.project === 'game/project.godot' && /\(found below the workspace\)/.test(fromRepo.text) && /^packages: 1/m.test(fromRepo.text) && !/packages outside the engine project/.test(fromRepo.text),
    `a workspace at the repository's root: the project found below, game/assets/… found too (${fromRepo.text.split('\n').slice(0, 2).join(' | ')})`);
  // a workspace inside the Godot project: the project above it, written upward
  fs.rmSync(path.join(repo, 'topotopo-workspace.json'));
  const inside = initWorkspace(path.join(godot, 'assets'), { name: 'valley-assets' });
  check(inside.manifest.engine !== 'none' && inside.manifest.engine?.project === '../project.godot', `a workspace inside the project: the project above it, its path leading upward (${inside.manifest.engine && inside.manifest.engine !== 'none' ? inside.manifest.engine.project : ''})`);
  // --engine names the project over the one detection finds, its path written from the workspace (leading upward too)
  const two = path.join(tmp, 'two-projects');
  for (const p of ['one', 'two']) { fs.mkdirSync(path.join(two, p, 'assets'), { recursive: true }); fs.writeFileSync(path.join(two, p, 'project.godot'), '[application]\n'); }
  const picked = initWorkspace(two, { name: 'two-picked', engine: 'godot:two/project.godot' });
  const upward = initWorkspace(path.join(two, 'two', 'assets'), { name: 'two-upward', engine: 'godot:../../one/project.godot' });
  const pickedEngine = picked.manifest.engine, upwardEngine = upward.manifest.engine;
  check(pickedEngine !== null && pickedEngine !== 'none' && pickedEngine.type === 'godot' && pickedEngine.project === 'two/project.godot'
    && upwardEngine !== null && upwardEngine !== 'none' && upwardEngine.project === '../../one/project.godot' && readWorkspace(path.join(two, 'two', 'assets')).engine !== 'none',
    `--engine godot:<path> wins over the project detection finds (below: one/; above: two/), written from the workspace (${JSON.stringify(pickedEngine)}; ${JSON.stringify(upwardEngine)})`);
  // Unreal: a workspace outside Content/ is not seen
  const ue = path.join(tmp, 'ue');
  fs.mkdirSync(path.join(ue, 'Content', 'TopoTopo'), { recursive: true });
  fs.mkdirSync(path.join(ue, 'Art'), { recursive: true });
  fs.writeFileSync(path.join(ue, 'Garden.uproject'), '{}');
  const seen = initWorkspace(path.join(ue, 'Content', 'TopoTopo'));
  const unseen = initWorkspace(path.join(ue, 'Art'), { name: 'garden-art' });
  check(seen.manifest.engine !== 'none' && seen.manifest.engine?.type === 'unreal' && seen.manifest.engine.project === '../../Garden.uproject' && !/Unreal will not see/.test(seen.text) && /Unreal will not see this workspace: it imports only what lies under the project's Content\/ folder/.test(unseen.text),
    'Unreal: inside Content/ is seen; outside it init says Unreal will not see the workspace');
}

console.log(`\n${passes} passed, ${failures} failed — temp ${tmp}`);
process.exit(failures ? 1 : 0);
