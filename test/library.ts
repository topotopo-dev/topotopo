// Gallery libraries (src/gallery/library.ts, bake.ts): the config, scanning a library (projects, collections, what a
// scan skips, id collisions), project.json validation, creating projects, the bake key, and baking previews (a valid
// PNG and meshopt GLB; a failed bake keeps the previous files and says why).
//   node test/library.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addLibrary, bakeKey, createProject, isStale, loadConfig, parseManifest, projectDirOf, readBakeState, readManifest, scanLibrary, slugify, writeManifest,
} from '../src/gallery/library.ts';
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
  check(slugify('Raven Hunt: Uzi!') === 'raven-hunt-uzi' && slugify('Ünïcode') === 'unicode', 'slugify');
}

const lib = { name: 'game', path: path.join(tmp, 'lib') };
section('create and scan');
{
  const uzi = createProject(lib, 'weapons/uzi', { title: 'Uzi', tags: ['weapon', 'hero'], links: [{ label: 'concept', url: 'http://board.local/c/12' }], graph: BOX });
  check(uzi.id === 'uzi' && uzi.collection === 'weapons' && uzi.rel === 'weapons/uzi', 'a project in a collection');
  for (const d of ['graphs', 'assets', 'inputs', 'exports', 'attachments']) check(fs.existsSync(path.join(uzi.dir, d)), `created ${d}/`);
  check(fs.readFileSync(path.join(uzi.dir, '.gitignore'), 'utf8').includes('.gallery/'), '.gitignore keeps the derived files out');
  check(JSON.parse(fs.readFileSync(path.join(uzi.dir, 'graphs', 'main.json'), 'utf8')).output === 'b', 'the given graph is graphs/main.json');
  check(throws(() => createProject(lib, 'props/uzi'), /already|used by/), 'an id is unique in its library');
  check(throws(() => createProject(lib, 'weapons/uzi/parts'), /inside another project/), 'no project inside a project');
  check(throws(() => createProject(lib, '../out'), /bad project path/), 'no path outside the library');
  createProject(lib, 'Crate Big');
  // things a scan must not enter or take as projects
  fs.mkdirSync(path.join(lib.path, '.hidden', 'p'), { recursive: true });
  fs.writeFileSync(path.join(lib.path, '.hidden', 'p', 'project.json'), '{}');
  fs.mkdirSync(path.join(lib.path, 'node_modules', 'p'), { recursive: true });
  fs.writeFileSync(path.join(lib.path, 'node_modules', 'p', 'project.json'), '{}');
  fs.mkdirSync(path.join(uzi.dir, 'attachments', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(uzi.dir, 'attachments', 'nested', 'project.json'), '{}');
  // a folder copied in Explorer: same id; and a broken manifest
  fs.cpSync(uzi.dir, path.join(lib.path, 'weapons', 'uzi - Copy'), { recursive: true });
  fs.mkdirSync(path.join(lib.path, 'broken'));
  fs.writeFileSync(path.join(lib.path, 'broken', 'project.json'), '{"graph": 5}');
  const s = scanLibrary(lib);
  check(s.projects.map((p) => p.id).join() === 'crate-big,uzi', `projects found, skipped folders ignored (${s.projects.map((p) => p.rel)})`);
  check(s.problems.some((p) => p.includes('uzi - Copy') && p.includes('already used')), 'a copied folder\'s duplicate id is a problem; the first path keeps it');
  check(s.problems.some((p) => p.includes('broken') && p.includes('"graph"')), 'a bad project.json is a problem naming the key');
  check(s.projects.find((p) => p.id === 'uzi')!.manifest.links[0].label === 'concept', 'links are read');
  fs.rmSync(path.join(lib.path, 'weapons', 'uzi - Copy'), { recursive: true });
  fs.rmSync(path.join(lib.path, 'broken'), { recursive: true });
  check(projectDirOf(path.join(uzi.dir, 'graphs')) === uzi.dir, 'projectDirOf finds the project above a folder');
  check(scanLibrary({ name: 'none', path: path.join(tmp, 'missing') }).problems[0].includes('no folder'), 'a missing library folder is a problem');
}

section('manifest');
{
  check(parseManifest({}, 'x').graph === 'main' && parseManifest({}, 'x').title === 'x', 'defaults: graph main, title = id');
  check(throws(() => parseManifest({ id: 'Bad Id' }, 'x'), /"id"/), 'ids are checked');
  check(throws(() => parseManifest({ graph: '../x' }, 'x'), /graph name/), 'graph names are checked');
  check(throws(() => parseManifest({ bake: { frame: 'a' } }, 'x'), /bake.frame/), 'bake.frame is a number');
  const dir = path.join(lib.path, 'weapons', 'uzi');
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
  raw.custom = { keep: true };
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(raw));
  writeManifest(dir, { ...readManifest(dir), description: 'SMG' });
  const back = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
  check(back.description === 'SMG' && back.custom?.keep === true, 'writing a manifest keeps keys it does not know');
}

section('bake');
{
  const p = scanLibrary(lib).projects.find((x) => x.id === 'uzi')!;
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
  const p2 = scanLibrary(lib).projects.find((x) => x.id === 'uzi')!;
  check(isStale(p2) && (await bakeProject(p2.dir)).ok, 'the manifest\'s graph choice is part of the key, and is what bakes');
  const none = await bakeProject(scanLibrary(lib).projects.find((x) => x.id === 'crate-big')!.dir);
  check(!none.ok && /no graph "main"/.test(none.error ?? ''), 'a project without its graph says so');
}

section('bake queue (child processes)');
{
  const p = scanLibrary(lib).projects.find((x) => x.id === 'uzi')!;
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

console.log(`\n${passes} passed, ${failures} failed — temp ${tmp}`);
process.exit(failures ? 1 : 0);
