// Packages (src/graph/packages.ts, src/gallery/packages.ts). The engine: package output names and their errors, a
// scope's package resolver, a package output's node type (its sliders, inputs, scope, signature and texture paths), the
// packages a graph names and uses, "publish": false. The registry: publishing (the version rule, --big, blocks and
// warnings, version.json, the hash, what a version holds), a package's graphs naming its own outputs (in its project, in
// a version, in a followed working folder; loops), TopoTopo's built-in library (looked in without listing it, copied
// and locked, a new version an update, publishing under "topotopo", following with and without a working folder, the
// reserved library name), first use and `use` (copies, flat dependencies, the lock,
// the project's libraries only, relative and registered libraries), cooking package outputs (sliders, inputs, a
// package that uses another, two versions side by side, files and textures read from the version, nothing leaking),
// hand-edited and missing copies, following a working folder, exports' source records, and the CLI commands.
// Everything sits in a temp folder with a config of its own ($TOPOTOPO_CONFIG):
//   repo/lib/      a library in the same repository as the project that uses it (listed as "../lib")
//   repo/forest/   the project that uses packages
//   game/          a registered library ("game"), other/ one the project does not list ("other")
//   node test/packages.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import '../src/nodes/index.ts';
import { Geometry } from '../src/core/geometry.ts';
import { readMaterials, rebaseTexturePaths, writeMaterials } from '../src/core/materials.ts';
import { Engine } from '../src/graph/engine.ts';
import type { CookReport } from '../src/graph/engine.ts';
import { packageOutputDef, packagesNamedIn, packagesUsed } from '../src/graph/packages.ts';
import { parsePackageName } from '../src/graph/scope.ts';
import type { PackageResolver } from '../src/graph/scope.ts';
import type { GraphSpec, NodeDef } from '../src/graph/types.ts';
import { createNodeHost } from '../src/host/node.ts';
import { exportSource } from '../src/io/source.ts';
import { encodePNG } from '../src/render/png.ts';
import { Workspace } from '../src/workspace.ts';
import { addLibrary, loadConfig, parseManifest, readManifest, scanLibrary } from '../src/gallery/library.ts';
import { builtinVersions, compareInterfaces, lockFile, openPackages, packagesText, publishPackage, readLock, startsBigVersion, versionHash } from '../src/gallery/packages.ts';
import type { ProjectPackages, PublishResult } from '../src/gallery/packages.ts';
import { applyUpdate, beforeAfter, beforeAfterText, outdatedText, overlayRenders } from '../src/gallery/update.ts';
import { ROOT } from './fixtures.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'topotopo-packages-'));
process.env.TOPOTOPO_CONFIG = path.join(tmp, 'cfg', 'config.json');
delete process.env.TOPOTOPO_LIBRARIES;

let failures = 0, passes = 0;
const check = (cond: any, msg: string) => { if (cond) passes++; else failures++; console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); };
const section = (s: string) => console.log(`\n== ${s}`);
const write = (file: string, data: string | Uint8Array) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };
const errorOf = (r: CookReport) => r.errors.map((e) => e.message + (e.hint ? ` (hint: ${e.hint})` : '')).join('; ');
const size = (r: CookReport, k: number) => (r.ok && r.geo ? +(r.geo.bbox().max[k] - r.geo.bbox().min[k]).toFixed(4) : NaN);
const top = (r: CookReport) => (r.ok && r.geo ? +r.geo.bbox().max[1].toFixed(4) : NaN);
const triangle = (s: number) => `v 0 0 0\nv ${s} 0 0\nv 0 ${s} 0\nf 1 2 3\n`;
const grey = (v: number) => encodePNG(new Uint8Array(16).map((_, i) => (i % 4 === 3 ? 255 : v)), 2, 2, (d) => zlib.deflateSync(d, { level: 0 }));
const engines: Engine[] = [];
const newEngine = async (dir: string) => { const e = new Engine(createNodeHost({ baseDir: dir })); await e.init(); engines.push(e); return e; };

// ------------------------------------------------------------------ the engine
section('names');
{
  const ok = parsePackageName('studio/trees/pine'), def = parsePackageName('studio/trees');
  check(typeof ok !== 'string' && ok.package === 'studio/trees' && ok.output === 'pine' && typeof def !== 'string' && def.package === 'studio/trees' && def.output === null,
    'owner/name/output, and owner/name for the default output');
  for (const bad of ['Studio/trees', 'studio/trees/', 'a/b/c/d', '/trees', 'studio/tr ees', `studio/${'x'.repeat(65)}`, 'studio/-trees'])
    check(typeof parsePackageName(bad) === 'string', `"${bad.length > 20 ? bad.slice(0, 20) + '…' : bad}" is not a package output name`);
  const named = packagesNamedIn({ nodes: { a: { type: 'studio/trees/pine' }, b: { type: 'box' }, l: { type: 'foreach', params: { body: { nodes: { r: { type: 'nordic/rocks' } } } } }, x: { type: 'Bad/Name' } } });
  check(JSON.stringify(named) === '["studio/trees","nordic/rocks"]', `the packages a graph names, in nested graphs too; malformed names are none (${named})`);
  const e = await newEngine(tmp);
  const none = await e.cook({ nodes: { t: { type: 'studio/trees/pine' } } });
  check(!none.ok && /"studio\/trees\/pine" is an output of package studio\/trees, and this cook has no packages/.test(errorOf(none)), `an engine without packages says so: ${errorOf(none)}`);
  const bad = await e.cook({ nodes: { t: { type: 'Studio/Trees' } } });
  check(!bad.ok && /is not a package output: write "owner\/name\/output"/.test(errorOf(bad)), `a malformed name says how to write one: ${errorOf(bad)}`);
  check(!e.resolveDef('studio/trees') && !e.allTypeNames().some((n) => n.includes('/')), 'no package names without packages');
}

section('the engine: a scope resolves package outputs through its packages');
{
  // a version's folder, scope, asset and graphs, by hand: what the registry (src/gallery/packages.ts) builds from disk
  const base = path.join(tmp, 'engine'), vdir = path.join(base, 'kit');
  write(path.join(base, 'inputs', 'mark.obj'), triangle(1));
  write(path.join(vdir, 'inputs', 'mark.obj'), triangle(3));
  write(path.join(vdir, 'inputs', 'bark.png'), grey(50));
  const e = await newEngine(base);
  const graphs: Record<string, GraphSpec> = {
    main: {
      nodes: {
        base: { type: 'input', params: { index: 0, label: 'base' } },
        f: { type: 'file', params: { path: 'inputs/mark.obj' } },
        s: { type: 'transform', in: ['f'], params: { scale: '=k' } },
        m: { type: 'material', in: ['s'], params: { name: 'bark', base_color_map: 'inputs/bark.png' } },
        r: { type: 'graph_ref', params: { graph: 'piece' } },
        out: { type: 'merge', in: ['m', 'r', 'base'] },
        pt: { type: 'add', params: { points: [[0, 0, 0]] } },
        packed: { type: 'copy_to_points', in: ['m', 'pt'], params: { pack: true } },
      },
      output: 'out', vars: { k: 1 }, params: { k: { type: 'float', min: 0, max: 5, label: 'Scale' } },
    },
    piece: { nodes: { p: { type: 'part' } }, output: 'p' },
  };
  const scope = e.createScope('test/kit@1.0', { folder: vdir, graphs: (n) => graphs[n] });
  e.registerAsset('part', { nodes: { b: { type: 'box', params: { size: [0.5, 0.5, 0.5] } } }, output: 'b' }, { scope });
  const out = (o: { output: string; node: string; hash?: string; version?: string | null }) => packageOutputDef({
    package: 'test/kit', version: o.version === undefined ? '1.0' : o.version, hash: o.hash ?? 'h1', signature: o.hash ?? 'h1', output: o.output, graph: 'main', spec: graphs.main, node: o.node, scope, note: 'first kit',
  });
  const mark = out({ output: 'mark', node: 'out' }), packed = out({ output: 'packed', node: 'packed' });
  const defs: Record<string, NodeDef> = { 'test/kit/mark': mark, 'test/kit/packed': packed };
  const resolver: PackageResolver = { resolve: (n) => defs[n] ?? { error: `no "${n}" here`, hint: 'only test/kit/mark and test/kit/packed' }, names: () => Object.keys(defs) };
  e.root.packages = resolver;
  check(e.resolveDef('test/kit/mark') === mark && !e.resolveDef('test/kit/x') && e.allTypeNames().includes('test/kit/packed') && e.packageDefs().length === 2,
    'resolveDef, allTypeNames and packageDefs ask the scope\'s packages');
  const v = e.validate({ nodes: { a: { type: 'test/kit/x' } } });
  check(v.errors[0]?.message === 'no "test/kit/x" here' && v.errors[0].hint === 'only test/kit/mark and test/kit/packed', 'validate gives the resolver\'s error and hint');
  check(!e.resolveDef('test/kit/mark', e.createScope('test/none')) && !e.resolveDef('part'), 'another scope has none of it, and the root not the version\'s asset');
  check(mark.category === 'package' && mark.params.k?.max === 5 && mark.inputs.length === 1 && mark.inputs[0].desc === 'base' && /test\/kit 1\.0: first kit/.test(mark.description ?? '') && !mark.usesScope,
    'its node type: the graph\'s vars are its params, its input nodes its inputs; version and note in its description');
  const a = await e.cook({ nodes: { k: { type: 'test/kit/mark', params: { k: 2 } } } });
  const bb = a.geo?.bbox();
  check(a.ok && bb!.max[0] === 6 && bb!.min[0] === -0.25, `it cooks in the version's scope: its file (3 wide, scaled 2) and its asset through its graph_ref (${errorOf(a)} ${bb?.min[0]}..${bb?.max[0]})`);
  const tex = a.geo ? readMaterials(a.geo).bark?.textures?.baseColor : '';
  check(tex === path.join(vdir, 'inputs', 'bark.png'), `a texture path relative to the version is made absolute: ${tex}`);
  const p = await e.cook({ nodes: { k: { type: 'test/kit/packed' } } });
  const src = p.geo?.hasPacked() ? readMaterials(p.geo.packedSources[0]).bark?.textures?.baseColor : '';
  check(src === path.join(vdir, 'inputs', 'bark.png'), `in packed sources too: ${src}`);
  const g = await e.cook({ nodes: { grid: { type: 'grid', params: { size: [20, 20] } }, k: { type: 'test/kit/mark', in: ['grid'] } }, output: 'k' });
  check(size(g, 0) === 20, 'an input goes to its input node');
  // the signature: the version's hash and the node, shared by every scope that resolves the same output
  const again = await e.cook({ nodes: { k: { type: 'test/kit/mark', params: { k: 2 } } } });
  const elsewhere = await e.cook({ nodes: { k: { type: 'test/kit/mark', params: { k: 2 } } } }, { scope: e.createScope('test/user', { packages: resolver }) });
  check(again.results.get('k')!.cached && elsewhere.results.get('k')!.cached && elsewhere.results.get('k')!.sig === a.results.get('k')!.sig, 'one version cooks once for every scope that uses it');
  defs['test/kit/mark'] = out({ output: 'mark', node: 'out', hash: 'h2' });
  const other = await e.cook({ nodes: { k: { type: 'test/kit/mark', params: { k: 2 } } } });
  check(!other.results.get('k')!.cached && other.results.get('k')!.sig !== a.results.get('k')!.sig, 'another hash is another result');
  // the packages a graph uses: directly, through an asset and a graph_ref graph
  e.registerAsset('uses_kit', { nodes: { k: { type: 'test/kit/packed' } }, output: 'k' });
  e.root.graphs = (n) => (n === 'refd' ? { nodes: { k: { type: 'test/kit/mark' } }, output: 'k' } : undefined);
  const used = packagesUsed(e, { nodes: { a: { type: 'uses_kit' }, r: { type: 'graph_ref', params: { graph: 'refd' } } } });
  check(JSON.stringify(used) === '{"test/kit@1.0":"h2"}', `packagesUsed finds them through assets and graph_ref graphs: ${JSON.stringify(used)}`);
  defs['test/kit/working'] = out({ output: 'working', node: 'out', version: null, hash: 'w1' });
  check(JSON.stringify(packagesUsed(e, { nodes: { w: { type: 'test/kit/working' }, a: { type: 'uses_kit' } } })) === '{"test/kit@1.0":"h1","test/kit@working":"w1"}', 'a working folder is "@working", keys sorted');
  // which texture paths are rebased: file paths, relative and absolute, not images or URLs
  const geo = new Geometry();
  writeMaterials(geo, { t: { baseColor: [1, 1, 1], metallic: 0, roughness: 1, emissive: [0, 0, 0], alpha: 1, doubleSided: false, unlit: false, textures: { baseColor: 'image:noise', normal: 'https://example.com/n.png', roughness: '/abs/r.png', orm: 'maps/orm.png' } } });
  const t = readMaterials(rebaseTexturePaths(geo, (x, relative) => `${relative ? 'V' : 'A'}|${x}`)).t.textures!;
  check(t.baseColor === 'image:noise' && t.normal === 'https://example.com/n.png' && t.roughness === 'A|/abs/r.png' && t.orm === 'V|maps/orm.png', 'file paths are rebased, told whether they are relative; images and URLs are not');
  check(readMaterials(geo).t.textures!.orm === 'maps/orm.png', 'the cooked geometry itself is never changed');
  check(rebaseTexturePaths(geo, (x) => x) === geo, 'nothing rewritten: the same geometry');
  // given rootPath (as the registry gives it), the root's result names its textures by it, another scope's absolutely
  const named = packageOutputDef({
    package: 'test/kit', version: '1.0', hash: 'h1', signature: 'h1', output: 'mark', graph: 'main', spec: graphs.main, node: 'out', scope,
    rootPath: (abs) => `root:${path.basename(abs)}`,
  });
  defs['test/kit/named'] = named;
  const forRoot = await e.cook({ nodes: { k: { type: 'test/kit/named' } } });
  const inside = await e.cook({ nodes: { k: { type: 'test/kit/named' } } }, { scope: e.createScope('test/user', { packages: resolver }) });
  const texOf = (r: CookReport) => (r.geo ? readMaterials(r.geo).bark?.textures?.baseColor : '');
  check(texOf(forRoot) === 'root:bark.png' && texOf(inside) === path.join(vdir, 'inputs', 'bark.png'), `with rootPath: the root's result names its textures by it, another scope's absolutely (${texOf(forRoot)}, ${texOf(inside)})`);
  check(forRoot.results.get('k')!.sig !== inside.results.get('k')!.sig, 'so the two are cached apart');
}

section('"publish": false');
{
  const e = await newEngine(tmp);
  const v = e.validate({ nodes: { b: { type: 'box' } }, outputs: { a: { node: 'b', publish: 'no' as any } } });
  check(v.errors.some((x) => /named output "a": "publish" must be true or false/.test(x.message)), `publish is validated like the other output fields: ${v.errors.map((x) => x.message)}`);
  check(!e.validate({ nodes: { b: { type: 'box' } }, outputs: { a: { node: 'b', publish: false }, c: { node: 'b', publish: true } } }).errors.length, 'publish: true and false are valid');
}

// ------------------------------------------------------------------ the package registry
const throws = (f: () => unknown, re: RegExp) => { try { f(); return false; } catch (e: any) { return re.test(e.message); } };
const errorText = (f: () => unknown) => { try { f(); return ''; } catch (e: any) { return String(e.message); } };
const json = (file: string, v: unknown) => write(file, JSON.stringify(v, null, 2) + '\n');
const readJSON = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
const exists = (...p: string[]) => fs.existsSync(path.join(...p));
const sha = (d: string | Uint8Array) => createHash('sha256').update(d).digest('hex');
/** The files below a folder (posix paths), recursively. */
const listing = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (d: string, rel: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(path.join(d, e.name), r); else out.push(r); } };
  walk(dir, '');
  return out.sort();
};

const dirs = {
  repo: path.join(tmp, 'repo'), lib: path.join(tmp, 'repo', 'lib'), forest: path.join(tmp, 'repo', 'forest'),
  game: path.join(tmp, 'game'), other: path.join(tmp, 'other'),
};
json(process.env.TOPOTOPO_CONFIG, { libraries: [{ name: 'game', path: dirs.game }, { name: 'other', path: dirs.other }] });

/** A project folder: project.json over the defaults, its graphs, and any other files. */
function project(dir: string, manifest: Record<string, unknown>, graphs: Record<string, GraphSpec>, files: Record<string, string | Uint8Array> = {}) {
  json(path.join(dir, 'project.json'), { id: path.basename(dir), title: path.basename(dir), graph: 'main', ...manifest });
  for (const [n, g] of Object.entries(graphs)) json(path.join(dir, 'graphs', `${n}.json`), g);
  for (const [rel, d] of Object.entries(files)) write(path.join(dir, rel), d);
}
const setGraph = (dir: string, name: string, g: GraphSpec) => json(path.join(dir, 'graphs', `${name}.json`), g);
const editManifest = (dir: string, f: (m: any) => void) => { const m = readJSON(path.join(dir, 'project.json')); f(m); json(path.join(dir, 'project.json'), m); };

interface Opened { engine: Engine; pk: ProjectPackages; ws: Workspace }
/** An engine, the packages of the project `dir` belongs to, and a workspace on it, as the tools open them. */
async function open(dir: string, follow: string[] = [], builtin?: string): Promise<Opened> {
  const engine = await newEngine(dir);
  const pk = openPackages(engine, dir, { follow, builtin });
  const ws = new Workspace(dir, engine);
  ws.packages = pk;
  ws.load();
  return { engine, pk, ws };
}
const publish = async (dir: string, note: string | undefined, big = false): Promise<PublishResult> => { const o = await open(dir); return publishPackage(o.ws, o.pk, { note, big }); };

// nordic/rocks: a mesh and a texture from its own inputs/ (the project that uses it has an inputs/rock.obj of its own)
const ROCKS = path.join(dirs.lib, 'rocks');
project(ROCKS, { package: 'nordic/rocks', libraries: ['game'] }, {
  main: {
    nodes: {
      mesh: { type: 'file', params: { path: 'inputs/rock.obj' } },
      scaled: { type: 'transform', in: ['mesh'], params: { scale: '=size' } },
      mat: { type: 'material', in: ['scaled'], params: { name: 'moss', base_color_map: 'inputs/moss.png' } },
    },
    output: 'mat', vars: { size: 1 }, params: { size: { type: 'float', min: 0.1, max: 10, label: 'Size' } },
    outputs: { boulder: { node: 'mat', label: 'Boulder' } },
  },
}, {
  'inputs/rock.obj': triangle(2), 'inputs/moss.png': grey(90),
  // not part of a version
  'exports/old.glb': 'x', 'attachments/concept.png': grey(10), '.gallery/thumb.png': grey(20), 'notes.txt': 'notes', 'scripts/build.py': 'print(1)',
});

// studio/trees: an asset, a graph_ref graph, an input, a package of its own (nordic/rocks), a viewer-only output
const TREES = path.join(dirs.game, 'trees');
const treesMain: GraphSpec = {
  nodes: {
    ground: { type: 'input', params: { index: 0, label: 'ground' } },
    trunk: { type: 'bark', params: { r: 0.3 } },
    tall: { type: 'transform', in: ['trunk'], params: { scale: [1, '=height', 1] } },
    crown: { type: 'graph_ref', params: { graph: 'crown' } },
    lifted: { type: 'transform', in: ['crown'], params: { translate: [0, '=height', 0] } },
    rock: { type: 'nordic/rocks/boulder', params: { size: 0.5 } },
    out: { type: 'merge', in: ['tall', 'lifted', 'rock', 'ground'] },
  },
  output: 'out', vars: { height: 4 }, params: { height: { type: 'float', min: 1, max: 20, label: 'Height' } },
  outputs: { pine: { node: 'out', label: 'Pine' }, preview: { node: 'lifted', publish: false } },
};
const crown = (r: number): GraphSpec => ({ nodes: { s: { type: 'sphere', params: { radius: r } } }, output: 's' });
project(TREES, { package: 'studio/trees', libraries: ['../../repo/lib'] }, { main: treesMain, crown: crown(1) }, {
  'assets/bark.json': JSON.stringify({ nodes: { t: { type: 'tube', params: { radius: '=r', height: 1 } } }, output: 't', vars: { r: 0.2 } }),
});

// studio/grove: uses studio/trees (a package that uses a package that uses another)
const GROVE = path.join(dirs.game, 'grove');
project(GROVE, { package: 'studio/grove', libraries: ['game'] }, { main: { nodes: { t: { type: 'studio/trees/pine', params: { height: 2 } } }, output: 't' } });

// other/thing: in a registered library the forest does not list
project(path.join(dirs.other, 'thing'), { package: 'other/thing' }, { main: { nodes: { b: { type: 'box' } }, output: 'b' } });

section('project.json: package, uses, libraries');
{
  check(throws(() => parseManifest({ package: 'trees' }, 'x'), /"package" "trees" must be "owner\/name"/), 'package is owner/name');
  check(throws(() => parseManifest({ package: 'studio/trees/pine' }, 'x'), /must be "owner\/name"/), 'a package name has no output');
  check(throws(() => parseManifest({ uses: { 'studio/trees': '1' } }, 'x'), /needs a version such as "1\.3"/), 'uses need big.small versions');
  check(throws(() => parseManifest({ uses: { 'studio/trees': '01.0' } }, 'x'), /needs a version/) && throws(() => parseManifest({ uses: { trees: '1.0' } }, 'x'), /not a package name/), 'no leading zeros; keys are package names');
  check(throws(() => parseManifest({ libraries: 'game' }, 'x'), /"libraries" must be a list/) && throws(() => parseManifest({ libraries: [path.join(tmp, 'x')] }, 'x'), /is an absolute path/), 'libraries: a list, no absolute paths');
  const m = parseManifest({ package: 'studio/trees', uses: { 'b/b': '1.0', 'a/a': '2.3' }, libraries: ['game', '../lib'] }, 'x');
  check(m.package === 'studio/trees' && Object.keys(m.uses).join() === 'a/a,b/b' && m.libraries.join() === 'game,../lib', 'package, uses (sorted) and libraries are read');
  const plain = parseManifest({}, 'x');
  check(plain.package === undefined && !Object.keys(plain.uses).length && !plain.libraries.length, 'none of them is needed');
  // scans skip versions/ and packages/
  const lib = path.join(tmp, 'scanlib');
  project(path.join(lib, 'p'), {}, {});
  project(path.join(lib, 'versions', 'q'), {}, {});
  project(path.join(lib, 'packages', 'r'), {}, {});
  check(scanLibrary({ name: 'scan', path: lib }).projects.map((p) => p.id).join() === 'p', 'library scans skip versions/ and packages/');
}

// ------------------------------------------------------------------ publishing
section('publishing: the first version, what it holds, its hash');
{
  const r = await publish(ROCKS, 'first rocks');
  check(r.ok && r.version === '1.0' && !r.previous && /versions[\\/]1\.0$/.test(r.dir ?? ''), `the first version is 1.0: ${r.blocks.join('; ')}`);
  const v = path.join(ROCKS, 'versions', '1.0');
  const files = listing(v);
  check(files.join() === 'graphs/main.json,inputs/moss.png,inputs/rock.obj,project.json,version.json', `a version holds project.json, graphs/, assets/, inputs/ and version.json (${files})`);
  check(!files.some((f) => /exports|attachments|gallery|notes|scripts/.test(f)), 'and leaves exports/, attachments/, .gallery/, scripts and other files out');
  const pj = readJSON(path.join(v, 'project.json'));
  check(pj.package === 'nordic/rocks' && !('libraries' in pj) && pj.id === 'rocks', 'its project.json is the project\'s, without "libraries"');
  const info = readJSON(path.join(v, 'version.json'));
  const pkgVersion = readJSON(path.join(ROOT, 'package.json')).version;
  check(info.package === 'nordic/rocks' && info.version === '1.0' && info.note === 'first rocks' && info.big === false && !Number.isNaN(Date.parse(info.published)) && info.topotopo === pkgVersion,
    'version.json: package, version, note, published, big, TopoTopo version');
  check(JSON.stringify(info.outputs) === JSON.stringify({ boulder: { graph: 'main', node: 'mat', label: 'Boulder', sliders: { size: { type: 'float', default: 1, min: 0.1, max: 10, label: 'Size' } }, inputs: [] } })
    && info.default.graph === 'main' && info.default.node === 'mat', `version.json: each output's graph, node, sliders and inputs, and the default output (${JSON.stringify(info.outputs)})`);
  // the hash: every file but version.json, sorted posix paths with each file's SHA-256
  const lines = files.filter((f) => f !== 'version.json').map((f) => `${sha(fs.readFileSync(path.join(v, ...f.split('/'))))}  ${f}\n`).join('');
  check(info.hash === sha(lines) && versionHash(v) === info.hash && r.hash === info.hash, 'the hash covers every file but version.json: sorted paths, each with its SHA-256');
  const again = await publish(ROCKS, 'again');
  check(!again.ok && again.blocks.join() === 'nothing changed since 1.0', `nothing changed: refused (${again.blocks})`);
  const noNote = await publish(ROCKS, '  ');
  check(!noNote.ok && noNote.blocks.some((b) => /a version needs a note/.test(b)), 'no note: refused');
}

section('publishing: the version rule');
{
  const RULES = path.join(dirs.lib, 'rules');
  const g: any = {
    nodes: {
      base: { type: 'input', params: { index: 0, label: 'base' } },
      b: { type: 'box', params: { size: '=w' } },
      out: { type: 'merge', in: ['b', 'base'] },
    },
    output: 'out', vars: { w: 1, style: 'a' }, params: { w: { type: 'float', min: 0, max: 10 }, style: { type: 'enum', options: ['a', 'b'] } },
    outputs: { box: { node: 'out' } },
  };
  project(RULES, { package: 'studio/rules' }, { main: g });
  const step = async (change: () => void, want: string, re: RegExp | null, big = false) => {
    change();
    setGraph(RULES, 'main', g);
    const r = await publish(RULES, `to ${want}`, big);
    const said = [...r.bigBecause, ...r.changes].join('; ');
    check(r.ok && r.version === want && (!re || re.test(said)), `${want}: ${said || r.blocks.join('; ')}`);
    return r;
  };
  await step(() => {}, '1.0', null, true);
  check(readJSON(path.join(RULES, 'versions', '1.0', 'version.json')).big === true, '--big on the first version still gives 1.0, and records the mark');
  const r11 = await step(() => { g.vars.w = 2; }, '1.1', /slider "w" default 1 → 2/);
  check(r11.changes.join() === 'output "box": slider "w" default 1 → 2', `a default output that is a named output is listed once: ${r11.changes}`);
  await step(() => { g.outputs.lid = { node: 'b' }; }, '1.2', /output "lid" added/);
  await step(() => { g.params.w.max = 20; }, '1.3', /range 0\.\.10 → 0\.\.20 \(wider\)/);
  await step(() => { g.params.w.min = 1; }, '2.0', /range 0\.\.20 → 1\.\.20 \(narrower\)/);
  await step(() => { g.params.style.options = ['a']; }, '3.0', /lost option "b"/);
  await step(() => { g.params.style.options = ['a', 'c']; }, '3.1', /gained option "c"/);
  await step(() => { g.outputs.lid.publish = false; }, '4.0', /output "lid" removed/);
  await step(() => { g.nodes.top = { type: 'input', params: { index: 1, label: 'top' } }; g.nodes.out.in.push('top'); }, '4.1', /input 1 \("top"\) added/);
  const r50 = await step(() => { g.nodes.base.params.index = 2; }, '5.0', /input "base" moved from 0 to 2/);
  check(!r50.changes.some((c) => /added/.test(c)), `a moved input is not also added: ${r50.changes}`);
  await step(() => { g.params.w.type = 'int'; }, '6.0', /slider "w" is now int \(was float\)/);
  await step(() => { g.nodes.b.params.divisions = 2; }, '7.0', /the author marked it big/, true);
  await step(() => { g.nodes.b.params.divisions = 3; }, '7.1', null);
  // a version is never written over
  fs.mkdirSync(path.join(RULES, 'versions', '7.2'));
  g.nodes.b.params.divisions = 4;
  setGraph(RULES, 'main', g);
  const over = await publish(RULES, 'over');
  check(!over.ok && over.blocks.some((b) => /is there already: a version is never written over/.test(b)), `a version folder that is there is never written over: ${over.blocks}`);
  check(compareInterfaces({ outputs: {}, default: { graph: 'a', node: 'n', sliders: {}, inputs: [] } }, { outputs: {}, default: { graph: 'b', node: 'n', sliders: {}, inputs: [] } }).small.some((s) => /the default output now cooks/.test(s)),
    'a default output moved to another graph is a small change');
  check(['2.0', '7.0', '10.0'].every(startsBigVersion) && !['1.0', '1.1', '1.10', '2.20'].some(startsBigVersion), 'a version that starts a big version: 2.0 and 10.0, never 1.0 or 1.10');
}

section('publishing: blocks and warnings');
{
  const box: GraphSpec = { nodes: { b: { type: 'box' } }, output: 'b' };
  const at = (n: string) => path.join(dirs.lib, n);
  project(at('noname'), {}, { main: box });
  project(at('reserved'), { package: 'topotopo/thing' }, { main: box });
  project(at('nocook'), { package: 'studio/nocook' }, { main: { nodes: { f: { type: 'file', params: { path: 'inputs/missing.obj' } } }, output: 'f', outputs: { mesh: { node: 'f' } } } });
  project(at('clash'), { package: 'studio/clash' }, { main: { ...box, outputs: { same: { node: 'b' } } }, other: { ...box, outputs: { same: { node: 'b' } } } });
  project(at('nodefault'), { package: 'studio/nodefault' }, { main: { nodes: { b: { type: 'box' } } } });
  project(at('badname'), { package: 'studio/badname' }, { main: { ...box, outputs: { Big_Box: { node: 'b' } } } });
  const blocks = async (n: string) => (await publish(at(n), 'note')).blocks.join(' | ');
  const said = { noname: await blocks('noname'), reserved: await blocks('reserved'), nocook: await blocks('nocook'), clash: await blocks('clash'), nodefault: await blocks('nodefault'), badname: await blocks('badname') };
  check(/project\.json has no "package"/.test(said.noname), `no package name: ${said.noname}`);
  check(/the owner "topotopo" is reserved/.test(said.reserved), `the owner topotopo is reserved: ${said.reserved}`);
  check(/output "mesh" \(graph "main"\) does not cook: \[f\]/.test(said.nocook), `an output that does not cook: ${said.nocook}`);
  check(/output "same" is published by graphs "main" and "other"/.test(said.clash), `an output name clash: ${said.clash}`);
  check(/no default output: set "output" in graphs\/main\.json/.test(said.nodefault), `no default output: ${said.nodefault}`);
  check(/output "Big_Box" \(graph "main"\) is not a package output name/.test(said.badname), `output names follow the id rule: ${said.badname}`);
  check(!exists(at('nocook'), 'versions') && !exists(at('clash'), 'versions'), 'a blocked publish writes nothing');
  // warnings: a URL, a file outside the package, the size
  const url = 'https://example.com/model.glb';
  project(at('warns'), { package: 'studio/warns' }, { main: box, extra: { nodes: { u: { type: 'file', params: { path: url } }, o: { type: 'file', params: { file: '../outside.obj' } } } } });
  const w = await publish(at('warns'), 'warns\n  and a second line');
  check(w.ok && w.warnings.some((x) => x.includes(`graphs/extra.json: u reads ${url}: a version holds no copy of a URL`)) && w.warnings.some((x) => /o reads \.\.\/outside\.obj, outside the package folder/.test(x)),
    `unpinned URLs and files outside the package warn: ${w.warnings.join(' | ')}`);
  check(readJSON(path.join(at('warns'), 'versions', '1.0', 'version.json')).note === 'warns and a second line', 'a note is one line');
  project(at('heavy'), { package: 'studio/heavy' }, { main: box }, { 'inputs/big.bin': new Uint8Array(51 * 2 ** 20) });
  const h = await publish(at('heavy'), 'heavy');
  check(h.ok && h.warnings.some((x) => /holds 51 MB \(above 50 MB\)/.test(x)), `a version above 50 MB warns: ${h.warnings.join(' | ')}`);
  fs.rmSync(at('heavy'), { recursive: true });
}

section('outputs of the same package: by full name, the same version, no entry in uses; a loop does not resolve');
{
  // studio/blocks: a brick; a wall of the kit's own bricks; the shown graph builds on the wall directly, in a foreach
  // body and through an asset of the package (a pier of one brick)
  const KITLIB = path.join(tmp, 'kitlib'), BLOCKS = path.join(KITLIB, 'blocks');
  const brick = (h: number): GraphSpec => ({ nodes: { b: { type: 'box', params: { size: ['=w', h, 0.5] } } }, output: 'b', vars: { w: 1 }, params: { w: { type: 'float', min: 0.1, max: 4 } }, outputs: { brick: { node: 'b', label: 'Brick' } } });
  project(BLOCKS, { package: 'studio/blocks' }, {
    brick: brick(0.5),
    wall: { nodes: { a: { type: 'studio/blocks/brick', params: { w: '=brick' } }, row: { type: 'copy_xform', in: ['a'], params: { count: '=n', translate: ['=brick', 0, 0] } } }, output: 'row', vars: { n: 3, brick: 1 }, outputs: { wall: { node: 'row', label: 'Wall' } } },
    main: {
      nodes: {
        w: { type: 'studio/blocks/wall', params: { n: 4 } },
        rows: { type: 'foreach', params: { mode: 'count', count: 2, body: { nodes: { w: { type: 'studio/blocks/wall' }, up: { type: 'transform', in: ['w'], params: { translate: [0, '=iteration', 0] } } }, output: 'up' } } },
        p: { type: 'pier' },
        out: { type: 'merge', in: ['w', 'rows', 'p'] },
      },
      output: 'out',
    },
  }, { 'assets/pier.json': JSON.stringify({ nodes: { b: { type: 'studio/blocks/brick', params: { w: 0.5 } }, t: { type: 'transform', in: ['b'], params: { translate: [0, 0, 2] } } }, output: 't' }) });
  // in the project that is the package: its own graphs as they are now
  const k = await open(BLOCKS);
  const wall = await k.engine.cook({ nodes: { w: { type: 'studio/blocks/wall' } } });
  const def = k.engine.resolveDef('studio/blocks/wall');
  check(wall.ok && size(wall, 0) === 3 && def?.package?.version === null && /studio\/blocks \(working folder\)/.test(def.summary), `the package's own project cooks its outputs from its graphs (width ${size(wall, 0)}; ${def?.summary ?? errorOf(wall)})`);
  check(['studio/blocks', 'studio/blocks/brick', 'studio/blocks/wall'].every((n) => k.engine.packageDefs().some((d) => d.type === n)), 'its catalog lists its own outputs');
  check(/this project is the package studio\/blocks: its graphs name its own outputs by full name, with no entry in "uses"/.test(errorText(() => k.pk.use('studio/blocks'))), 'it does not use itself');
  setGraph(BLOCKS, 'brick', brick(0.8));
  check(k.pk.refresh() && top(await k.engine.cook({ nodes: { w: { type: 'studio/blocks/wall' } } })) === 0.4, 'a change to its graphs: refresh sees it and the wall has the new bricks');
  const p = await publish(BLOCKS, 'first blocks');
  check(p.ok && p.version === '1.0', `publishing cooks the wall from the project's own brick: ${p.blocks.join('; ')}`);
  const info = readJSON(path.join(BLOCKS, 'versions', '1.0', 'version.json'));
  check(Object.keys(info.outputs).join() === 'brick,wall' && !('uses' in readJSON(path.join(BLOCKS, 'versions', '1.0', 'project.json'))) && !exists(BLOCKS, 'versions', '1.0', 'packages'),
    'the version publishes both, and names no package of its own in its uses');
  // a project that uses it: the version's outputs name each other within that version
  const USER = path.join(tmp, 'blocks-user');
  project(USER, { libraries: ['../kitlib'] }, {});
  const u = await open(USER);
  const scene: GraphSpec = { nodes: { k: { type: 'studio/blocks', params: {} } }, output: 'k' };
  check(u.pk.addFor(scene).length === 1 && JSON.stringify(readManifest(USER).uses) === '{"studio/blocks":"1.0"}' && Object.keys(readLock(USER).packages).join() === 'studio/blocks',
    'first use adds the package once: uses and the lock name nothing else');
  const r = await u.engine.cook(scene);
  check(r.ok && size(r, 0) === 4 && size(r, 2) === 2.5, `its default output cooks: the wall, a foreach of walls and the pier asset, of its own bricks (${size(r, 0)} × ${size(r, 2)}; ${errorOf(r)})`);
  const w = u.engine.resolveDef('studio/blocks/wall')!, inside = u.engine.resolveDef('studio/blocks/brick', w.package!.scope);
  check(inside?.package?.version === '1.0' && inside.package.hash === w.package!.hash && inside.package.scope === w.package!.scope, 'inside the version, the brick is the same version\'s');
  check(JSON.stringify(Object.keys(packagesUsed(u.engine, scene))) === '["studio/blocks@1.0"]', 'exports record the one version');
  // following its working folder: the wall's own bricks come from that folder too
  setGraph(BLOCKS, 'brick', brick(1.2));
  const f = await open(USER, ['studio/blocks']);
  check(top(await f.engine.cook({ nodes: { w: { type: 'studio/blocks/wall' } } })) === 0.6, 'a followed working folder\'s outputs name its own outputs in that folder');
  setGraph(BLOCKS, 'brick', brick(0.8));

  // studio/loops: a and b name each other, c names itself; ok names itself only in a node its output does not cook
  const LOOPS = path.join(KITLIB, 'loops');
  project(LOOPS, { package: 'studio/loops' }, {
    main: { nodes: { a: { type: 'studio/loops/a' } }, output: 'a' },
    a: { nodes: { b: { type: 'studio/loops/b' } }, output: 'b', outputs: { a: { node: 'b' } } },
    b: { nodes: { x: { type: 'box' }, a: { type: 'studio/loops/a' }, m: { type: 'merge', in: ['x', 'a'] } }, output: 'm', outputs: { b: { node: 'm' } } },
    c: { nodes: { c: { type: 'studio/loops/c' } }, output: 'c', outputs: { c: { node: 'c' } } },
    ok: { nodes: { x: { type: 'box' }, aside: { type: 'studio/loops/ok' } }, output: 'x', outputs: { ok: { node: 'x' } } },
  });
  const l = await open(LOOPS);
  const loopA = errorOf(await l.engine.cook({ nodes: { n: { type: 'studio/loops/a' } } }));
  check(/studio\/loops \(working folder\): output "a" is in a loop: studio\/loops\/a → studio\/loops\/b → studio\/loops\/a name each other in a loop/.test(loopA), `outputs that name each other: ${loopA}`);
  check(/output "c" is in a loop: studio\/loops\/c names itself/.test(errorOf(await l.engine.cook({ nodes: { n: { type: 'studio/loops/c' } } }))), 'an output that names itself');
  check((await l.engine.cook({ nodes: { n: { type: 'studio/loops/ok' } } })).ok, 'a node its output does not cook is no loop');
  const viaLoop = await l.engine.cook({ nodes: { n: { type: 'studio/loops' } } });
  check(!viaLoop.ok && !!l.engine.resolveDef('studio/loops') && /is in a loop/.test(errorOf(viaLoop)), 'an output that uses one in a loop resolves, and its cook says why it fails');
  const lp = await publish(LOOPS, 'loops');
  check(!lp.ok && lp.blocks.some((b) => /^studio\/loops\/a → studio\/loops\/b → studio\/loops\/a name each other in a loop$/.test(b)) && lp.blocks.some((b) => /^studio\/loops\/c names itself$/.test(b)) && !exists(LOOPS, 'versions'),
    `publishing refuses a loop: ${lp.blocks.join(' | ')}`);
}

// ------------------------------------------------------------------ first use, use, copies and the lock
section('first use in a package: studio/trees uses nordic/rocks');
{
  const o = await open(TREES);
  const notes = o.pk.addFor(treesMain);
  check(notes.length === 1 && /^added nordic\/rocks 1\.0 to project trees from library "\.\.\/\.\.\/repo\/lib": packages\/nordic\/rocks\/1\.0$/.test(notes[0]), `the graph names it: added on first use (${notes})`);
  check(JSON.stringify(readManifest(TREES).uses) === '{"nordic/rocks":"1.0"}', 'project.json "uses" names the version');
  const lock = readLock(TREES);
  check(JSON.stringify(lock.packages['nordic/rocks']['1.0']) === JSON.stringify({ hash: readJSON(path.join(ROCKS, 'versions', '1.0', 'version.json')).hash, library: '../../repo/lib', uses: {} }),
    'the lock: the copy\'s hash, the library it came from as listed, its own uses');
  check(listing(path.join(TREES, 'packages')).join() === 'lock.json,nordic/rocks/1.0/graphs/main.json,nordic/rocks/1.0/inputs/moss.png,nordic/rocks/1.0/inputs/rock.obj,nordic/rocks/1.0/project.json,nordic/rocks/1.0/version.json',
    'the copy holds the version');
  check(o.pk.addFor(treesMain).length === 0, 'a package in uses is not added again');
  const r = await o.engine.cook(treesMain);
  check(r.ok && size(r, 0) === 2, `the package's graph cooks with the copy: ${errorOf(r)}`);
  const p = await publish(TREES, 'first trees');
  check(p.ok && p.version === '1.0', `studio/trees 1.0: ${p.blocks}`);
  const files = listing(path.join(TREES, 'versions', '1.0'));
  check(['packages/lock.json', 'packages/nordic/rocks/1.0/version.json', 'packages/nordic/rocks/1.0/inputs/rock.obj', 'assets/bark.json', 'graphs/crown.json'].every((f) => files.includes(f)),
    'a version holds the copies it uses and their lock, and its assets');
  const info = readJSON(path.join(TREES, 'versions', '1.0', 'version.json'));
  check(Object.keys(info.outputs).join() === 'pine' && JSON.stringify(info.outputs.pine.inputs) === '[{"index":0,"label":"ground"}]' && info.outputs.pine.sliders.height.max === 20,
    '"publish": false keeps the preview out; the inputs with position and label');
}

section('use: a registered library, flat dependencies');
{
  const o = await open(GROVE);
  const r = o.pk.use('studio/trees');
  check(r.version === '1.0' && /^added studio\/trees 1\.0 to project grove from library "game", with nordic\/rocks 1\.0/.test(r.text), `use copies the newest version and what it uses: ${r.text}`);
  check(exists(GROVE, 'packages', 'studio', 'trees', '1.0', 'version.json') && exists(GROVE, 'packages', 'nordic', 'rocks', '1.0', 'version.json')
    && !exists(GROVE, 'packages', 'studio', 'trees', '1.0', 'packages', 'nordic') && exists(GROVE, 'packages', 'studio', 'trees', '1.0', 'packages', 'lock.json'),
    'flat: each version once beside the others; a copy keeps its version\'s lock, not its copies');
  const lock = readLock(GROVE);
  check(lock.packages['nordic/rocks']['1.0'].library === 'game' && JSON.stringify(lock.packages['studio/trees']['1.0'].uses) === '{"nordic/rocks":"1.0"}', 'the lock lists both, with the library they came from');
  check(/already uses studio\/trees 1\.0/.test(o.pk.use('studio/trees').text), 'use of a package in use says so');
  const p = await publish(GROVE, 'first grove');
  check(p.ok && p.version === '1.0', `studio/grove 1.0 (a package that uses one that uses another): ${p.blocks}`);
  // trees moves on: its copies in grove's version stay 1.0
  setGraph(TREES, 'crown', crown(1.5));
  const t = await publish(TREES, 'bigger crown');
  check(t.ok && t.version === '1.1' && !t.bigBecause.length, `a geometry change is small: studio/trees ${t.version}`);
}

section('a project that uses packages: first use, two versions side by side');
{
  // the forest has its own bark asset, crown graph and inputs/rock.obj: none may reach the packages
  project(dirs.forest, { package: 'studio/forest', libraries: ['../lib', 'game'] }, { crown: crown(5) }, {
    'assets/bark.json': JSON.stringify({ nodes: { b: { type: 'box', params: { size: [9, 9, 9] } } }, output: 'b' }),
    'inputs/rock.obj': triangle(5),
  });
  const o = await open(dirs.forest);
  const graph: GraphSpec = { nodes: { pine: { type: 'studio/trees/pine', params: { height: 6 } }, grove: { type: 'studio/grove' }, out: { type: 'merge', in: ['pine', 'grove'] } }, output: 'out' };
  o.ws.setGraph('main', { nodes: { b: { type: 'box' } }, output: 'b' });
  const ed = await o.ws.edit('main', [{ op: 'replace', node: 'b', spec: { type: 'studio/trees/pine', params: { height: 6 } } }, { op: 'add', node: 'grove', type: 'studio/grove' }, { op: 'add', node: 'out', type: 'merge', in: ['b', 'grove'] }, { op: 'output', node: 'out' }]);
  check(ed.report.ok && ed.notes.some((n) => /^added studio\/trees 1\.1 to project forest from library "game"/.test(n)) && ed.notes.some((n) => /^added studio\/grove 1\.0 .*, with studio\/trees 1\.0: packages\/studio\/grove\/1\.0$/.test(n)),
    `an edit that names packages adds their newest versions (with what they use): ${ed.notes.join(' | ')} ${errorOf(ed.report)}`);
  check(JSON.stringify(readManifest(dirs.forest).uses) === '{"studio/grove":"1.0","studio/trees":"1.1"}', 'uses: the packages its graphs name, with their versions');
  check(listing(path.join(dirs.forest, 'packages')).filter((f) => f.endsWith('version.json')).join() === 'nordic/rocks/1.0/version.json,studio/grove/1.0/version.json,studio/trees/1.0/version.json,studio/trees/1.1/version.json',
    'the copies sit flat: each version once, two versions of trees side by side');
  const lock = readLock(dirs.forest);
  check(Object.entries(lock.packages).flatMap(([p, vs]) => Object.keys(vs).map((v) => `${p}@${v}`)).join() === 'nordic/rocks@1.0,studio/grove@1.0,studio/trees@1.0,studio/trees@1.1', 'the lock lists every copied version');
  const one = await o.engine.cook({ nodes: { t: { type: 'studio/trees/pine', params: { height: 6 } } } });
  const grove = await o.engine.cook({ nodes: { g: { type: 'studio/grove' } } });
  check(size(one, 0) === 3 && size(grove, 0) === 2, `trees 1.1 (crown 1.5) and trees 1.0 inside grove (crown 1) cook side by side (widths ${size(one, 0)}, ${size(grove, 0)})`);
  check(top(one) === 7.5 && top(grove) === 3, `sliders: height 6 → top 7.5, height 2 inside grove → top 3 (${top(one)}, ${top(grove)})`);
  const def = await o.engine.cook({ nodes: { t: { type: 'studio/trees' } } });
  check(def.ok && size(def, 0) === 3 && top(def) === 5.5, `owner/name alone cooks the default output at its defaults (top ${top(def)})`);
  const clamped = await o.engine.cook({ nodes: { t: { type: 'studio/trees/pine', params: { height: 50 } } } });
  check(clamped.ok && clamped.warnings.some((w) => /height/.test(w.message) && /20/.test(w.message)), `a slider outside its range is clamped with a warning: ${clamped.warnings.map((w) => w.message)}`);
  const typo = await o.engine.cook({ nodes: { t: { type: 'studio/trees/pine', params: { heigth: 3 } } } });
  check(!typo.ok && /unknown param "heigth" for studio\/trees\/pine — did you mean "height"/.test(errorOf(typo)), `a slider the version does not have: ${errorOf(typo)}`);
  const withInput = await o.engine.cook({ nodes: { g: { type: 'grid', params: { size: [30, 30] } }, t: { type: 'studio/trees/pine', in: ['g'] } }, output: 't' });
  check(size(withInput, 0) === 30, `its inputs are the graph's input nodes: a grid on input 0 goes in (width ${size(withInput, 0)})`);
  // nothing leaks either way
  check(size(one, 0) !== 9 && size(one, 0) !== 10, 'the package reads its own bark asset and crown graph, not the project\'s');
  const own = await o.engine.cook({ nodes: { b: { type: 'bark' } } });
  check(size(own, 0) === 9, 'the project\'s bark is its own');
  const hidden = await o.engine.cook({ nodes: { b: { type: 'nordic/rocks/boulder' } } });
  check(!hidden.ok && /package nordic\/rocks is not in this project's uses/.test(errorOf(hidden)), `a package another package uses is not the project's: ${errorOf(hidden)}`);
  const added = o.pk.use('nordic/rocks');
  check(/^added nordic\/rocks 1\.0 to project forest from library/.test(added.text) && !added.copied.length, `use of a version the project holds already copies nothing: ${added.text}`);
  check(readLock(dirs.forest).packages['nordic/rocks']['1.0'].library === 'game', 'the lock keeps the library the copy came from (inside studio/trees, from "game")');
  const rock = await o.engine.cook({ nodes: { b: { type: 'nordic/rocks/boulder' } } });
  const tex = rock.geo ? readMaterials(rock.geo).moss?.textures?.baseColor : undefined;
  check(size(rock, 0) === 2, `files are read from the version's folder: the rock is 2 wide, not the project's 5 (${size(rock, 0)})`);
  check(tex === 'packages/nordic/rocks/1.0/inputs/moss.png' && fs.existsSync(path.join(dirs.forest, tex)), `texture paths name the version's files, relative to the project: ${tex}`);
  const inPine = one.geo ? readMaterials(one.geo).moss?.textures?.baseColor : undefined;
  check(inPine === tex, `also through a package that uses it (${inPine})`);
  // the catalog and help
  const names = o.engine.packageDefs().map((d) => d.type);
  check(['studio/trees', 'studio/trees/pine', 'studio/grove', 'nordic/rocks/boulder'].every((n) => names.includes(n)) && !names.includes('studio/trees/preview'), `the catalog lists the project's package outputs: ${names}`);
  const pine = o.engine.resolveDef('studio/trees/pine')!;
  check(pine.category === 'package' && pine.package?.version === '1.1' && /studio\/trees 1\.1: bigger crown/.test(pine.description ?? '') && pine.params.height.max === 20 && pine.inputs[0].desc === 'ground',
    'a package output\'s node type: its version and note, sliders and inputs');
  const listed = packagesText(o.pk);
  check(/studio\/trees 1\.1 {2}from library "game" {2}"bigger crown"/.test(listed) && /studio\/trees 1\.0 \(used by another package\)/.test(listed) && /studio\/rules {2}7\.1/.test(listed) && /packages in them:/.test(listed),
    `packages lists what the project uses and the packages in its libraries:\n${listed.split('\n').slice(0, 6).join('\n')}`);
}

section('errors: unknown outputs, packages the libraries do not have, libraries the project does not list');
{
  const o = await open(dirs.forest);
  const pin = await o.engine.cook({ nodes: { t: { type: 'studio/trees/pin' } } });
  check(/studio\/trees 1\.1 has no output "pin" — did you mean pine\? \(hint: its outputs: pine; "studio\/trees" alone is its default output\)/.test(errorOf(pin)), `an unknown output lists the package's outputs: ${errorOf(pin)}`);
  const oaks: GraphSpec = { nodes: { t: { type: 'studio/oaks/oak' } } };
  check(!o.pk.addFor(oaks).length, 'a package no library has is not added');
  const r = await o.engine.cook(oaks);
  check(/package studio\/oaks is not in this project's uses \(project\.json\), and it could not be added: no library this project lists has a package studio\/oaks/.test(errorOf(r)) && /topotopo use studio\/oaks/.test(errorOf(r)),
    `why, and the hint: ${errorOf(r)}`);
  const thing = errorText(() => o.pk.use('other/thing'));
  check(/other\/thing is in library "other" \(.*\), which this project does not list: add "other" to "libraries"/.test(thing), `a package only in a library the project does not list: ${thing}`);
  check(/did you mean studio\/trees/.test(errorText(() => o.pk.use('studio/tres'))), 'did-you-mean over the packages in its libraries');
  check(/this project is the package studio\/forest/.test(errorText(() => o.pk.use('studio/forest'))), 'a project does not use its own package');
  const lonely = path.join(tmp, 'lonely');
  project(lonely, {}, {});
  const lo = await open(lonely);
  check(/this project lists no libraries to find nordic\/rocks in/.test(errorText(() => lo.pk.use('nordic/rocks'))), 'a project that lists no libraries says so');
  check(/studio\/trees is in library "game" .*which this project does not list/.test(errorText(() => lo.pk.use('studio/trees'))), 'and names a registered library that has the package');
  editManifest(lonely, (m) => { m.libraries = ['nowhere']; });
  const lo2 = await open(lonely);
  check(/lists library "nowhere", which is not registered on this machine/.test(errorText(() => lo2.pk.use('studio/trees'))), 'an unregistered library name says how to register it');
  editManifest(lonely, (m) => { m.libraries = ['./missing']; });
  const lo3 = await open(lonely);
  check(/lists library "\.\/missing", and .* is not a folder/.test(errorText(() => lo3.pk.use('studio/trees'))), 'a library path that is not a folder');
  // outside any project
  const loose = path.join(tmp, 'loose');
  fs.mkdirSync(loose);
  const lp = await open(loose);
  const out = await lp.engine.cook({ nodes: { t: { type: 'studio/trees/pine' } } });
  check(!lp.pk.dir && /this graph is in no project, and only projects use packages \(hint: topotopo init/.test(errorOf(out)), `outside a project: ${errorOf(out)}`);
  check(/topotopo init/.test(errorText(() => lp.pk.use('studio/trees'))), 'use outside a project says how to make one');
}

section('copies: edited by hand, missing, one version with two contents');
{
  const crownFile = path.join(dirs.forest, 'packages', 'studio', 'trees', '1.1', 'graphs', 'crown.json');
  const before = fs.readFileSync(crownFile);
  fs.writeFileSync(crownFile, JSON.stringify(crown(3)));
  const o = await open(dirs.forest);
  const r = await o.engine.cook({ nodes: { t: { type: 'studio/trees/pine' } } });
  check(o.pk.check().some((p) => /the copy of studio\/trees 1\.1 \(packages\/studio\/trees\/1\.1\) was edited by hand/.test(p)), 'loading checks the hashes: a copy edited by hand is a problem');
  check(r.ok && r.warnings.some((w) => /edited by hand/.test(w.message)), 'and its cooks warn');
  check(o.pk.verifyCopies().some((p) => /edited by hand/.test(p)), 'checked now as well');
  const blocked = await publish(dirs.forest, 'with an edited copy');
  check(!blocked.ok && blocked.blocks.some((b) => /edited by hand/.test(b)), 'publishing a project with a copy edited by hand is refused');
  fs.writeFileSync(crownFile, before);
  check(!(await open(dirs.forest)).pk.check().some((p) => /edited by hand/.test(p)), 'restored, it is fine again');
  // missing
  const groveCopy = path.join(dirs.forest, 'packages', 'studio', 'grove', '1.0');
  fs.renameSync(groveCopy, groveCopy + '-away');
  const m = await open(dirs.forest);
  const g = await m.engine.cook({ nodes: { g: { type: 'studio/grove' } } });
  check(/the copy of studio\/grove 1\.0 is missing: packages\/studio\/grove\/1\.0/.test(errorOf(g)), `a missing copy: ${errorOf(g)}`);
  const back = m.pk.use('studio/grove');
  check(back.text === 'copied what was missing of studio/grove 1.0 again from library "game": studio/grove 1.0' && exists(groveCopy, 'version.json'), `use copies it again: ${back.text}`);
  check((await m.engine.cook({ nodes: { g: { type: 'studio/grove' } } })).ok, 'and the same session cooks it');
  fs.rmSync(groveCopy + '-away', { recursive: true });
  const depCopy = path.join(dirs.forest, 'packages', 'studio', 'trees', '1.0');
  fs.renameSync(depCopy, depCopy + '-away');
  check(o.pk.verifyCopies().some((p) => p === 'the copy of studio/trees 1.0 is missing: packages/studio/trees/1.0'), 'a missing copy of a version another package uses is found');
  const dep = m.pk.use('studio/grove');
  check(dep.copied.join() === 'studio/trees 1.0' && exists(depCopy, 'version.json'), `use of the package that needs it copies it again: ${dep.text}`);
  fs.rmSync(depCopy + '-away', { recursive: true });
  // a version changed after publishing is not copied
  const TAMPER = path.join(dirs.lib, 'tamper');
  project(TAMPER, { package: 'studio/tamper' }, { main: { nodes: { b: { type: 'box' } }, output: 'b' } });
  check((await publish(TAMPER, 'tamper')).ok, 'studio/tamper 1.0');
  setGraph(path.join(TAMPER, 'versions', '1.0'), 'main', { nodes: { b: { type: 'sphere' } }, output: 'b' });
  check(/studio\/tamper 1\.0 in .* \(library "\.\.\/lib"\) was changed after publishing/.test(errorText(() => m.pk.use('studio/tamper'))), 'a version whose files no longer give its hash is not copied');
  // the same version with other files in a second library
  const twin = path.join(dirs.game, 'rocks-twin');
  fs.cpSync(ROCKS, twin, { recursive: true });
  const tv = path.join(twin, 'versions', '1.0');
  write(path.join(tv, 'inputs', 'rock.obj'), triangle(7));
  const ti = readJSON(path.join(tv, 'version.json'));
  ti.hash = versionHash(tv);
  json(path.join(tv, 'version.json'), ti);
  editManifest(twin, (x) => { x.id = 'rocks-twin'; });
  const fresh = path.join(dirs.repo, 'fresh');
  project(fresh, { libraries: ['../lib', 'game'] }, {});
  const f = await open(fresh);
  const two = errorText(() => f.pk.use('nordic/rocks'));
  check(/nordic\/rocks 1\.0 has different files in .*rocks.*versions.*1\.0 \(library "\.\.\/lib"\) and in .*rocks-twin.*\(library "game"\).*never picks one/.test(two), `one version with different files in two libraries names both: ${two}`);
  fs.rmSync(twin, { recursive: true });
}

// ------------------------------------------------------------------ following
section('following a working folder for one session');
{
  setGraph(TREES, 'crown', crown(2));  // unpublished: trees 1.1 has 1.5
  const o = await open(dirs.forest, ['studio/trees']);
  const pine: GraphSpec = { nodes: { t: { type: 'studio/trees/pine' } } };
  const a = await o.engine.cook(pine);
  const def = o.engine.resolveDef('studio/trees/pine')!;
  check(size(a, 0) === 4 && def.package?.version === null && /^studio\/trees@working-[0-9a-f]{16}$/.test(def.package!.scope.id), `the package resolves to its working folder (crown 2, width ${size(a, 0)}; scope ${def.package?.scope.id})`);
  const g = await o.engine.cook({ nodes: { g: { type: 'studio/grove' } } });
  check(size(g, 0) === 2, 'a version that uses it keeps its own copy (frozen)');
  check(o.pk.following().map((f) => f.package).join() === 'studio/trees' && !o.pk.refresh(), 'nothing changed: refresh says so');
  const scope1 = def.package!.scope.id;
  setGraph(TREES, 'crown', crown(2.5));
  check(o.pk.refresh(), 'an edit in the working folder: refresh sees it');
  const b = await o.engine.cook(pine);
  check(size(b, 0) === 5 && o.engine.resolveDef('studio/trees/pine')!.package!.scope.id !== scope1 && !b.results.get('t')!.cached, `under a new scope id it cooks again (width ${size(b, 0)})`);
  // exports record it
  const graph: GraphSpec = { nodes: { t: { type: 'studio/trees/pine' }, g: { type: 'studio/grove' }, out: { type: 'merge', in: ['t', 'g'] } }, output: 'out' };
  const used = packagesUsed(o.engine, graph);
  const lock = readLock(dirs.forest);
  check(Object.keys(used).join() === 'nordic/rocks@1.0,studio/grove@1.0,studio/trees@1.0,studio/trees@working' && used['studio/trees@working'] === o.engine.resolveDef('studio/trees/pine')!.package!.hash
    && used['studio/grove@1.0'] === lock.packages['studio/grove']['1.0'].hash, `the export's source record names every version it used and the working folder's hash (${Object.keys(used)})`);
  const src = exportSource({ graph: 'main', spec: graph, node: 'out', format: 'glb', packages: used, version: '0' });
  check(JSON.stringify(Object.keys(src)) === JSON.stringify(['graph', 'graph_sha256', 'output', 'node', 'frame', 'fps', 'vars', 'seeds', 'packages', 'export', 'topotopo']) && src.packages!['studio/trees@working'] === used['studio/trees@working'],
    'exportSource writes them as "packages"');
  const plain = exportSource({ graph: 'main', spec: { nodes: { b: { type: 'box' } } }, node: 'b', format: 'glb', packages: {}, version: '0' });
  check(!('packages' in plain), 'a graph without packages has no "packages" (records stay as they were)');
  // publishing while following
  const p = await publishPackage(o.ws, o.pk, { note: 'while following' });
  check(!p.ok && p.blocks.some((x) => /this session follows studio\/trees from its working folder/.test(x)), `publishing a project that follows a package is refused: ${p.blocks.join(' | ')}`);
  check(/stopped following studio\/trees: it resolves to its copy \(1\.1\) again/.test(o.pk.follow('studio/trees', false)), 'stop following');
  const c = await o.engine.cook(pine);
  check(size(c, 0) === 3, `the copy again (width ${size(c, 0)})`);
  // the viewer's re-cook: a save in a followed folder calls back
  o.pk.follow('studio/trees', true);
  const changed = new Promise<boolean>((resolve) => { const t = setTimeout(() => resolve(false), 5000); o.pk.watch(() => { clearTimeout(t); resolve(true); }); });
  setTimeout(() => setGraph(TREES, 'crown', crown(2.2)), 100);
  check(await changed, 'a save in a followed working folder is noticed (watch)');
  o.pk.unwatch();
  // a package with no published version yet is followed without being added
  const SAPLING = path.join(dirs.game, 'sapling');
  project(SAPLING, { package: 'studio/sapling' }, { main: { nodes: { c: { type: 'cone' } }, output: 'c', outputs: { tip: { node: 'c' } } } });
  const s = await open(dirs.forest, ['studio/sapling']);
  const sg: GraphSpec = { nodes: { s: { type: 'studio/sapling/tip' } } };
  check(!s.pk.addFor(sg).length && (await s.engine.cook(sg)).ok && !readManifest(dirs.forest).uses['studio/sapling'], 'a followed package with no version yet cooks from its folder and is not added to uses');
  check(/has a working folder in more than one library|no library this project lists has a package studio\/oaks/.test(errorText(() => s.pk.follow('studio/oaks'))), 'following a package the libraries do not have fails');
  setGraph(TREES, 'crown', crown(1.5));
}

// ------------------------------------------------------------------ TopoTopo's built-in library
section('TopoTopo\'s built-in library: looked in without listing it; copies and locks; a new version is an update');
{
  // a built-in library as TopoTopo's repository has it: topotopo/kit's working folder, which publishes its versions
  const BUILTIN = path.join(tmp, 'builtin'), KIT = path.join(BUILTIN, 'kit');
  const cube = (s: number): GraphSpec => ({ description: 'A test cube. Its size is s.', nodes: { b: { type: 'box', params: { size: ['=s', '=s', '=s'] } } }, output: 'b', vars: { s }, params: { s: { type: 'float', min: 0.1, max: 9 } }, outputs: { cube: { node: 'b', label: 'Cube' } } });
  project(KIT, { package: 'topotopo/kit' }, { main: cube(1) });
  const asTopoTopo = async (dir: string, note: string, builtin?: string, flag = true) => { const o = await open(dir, [], builtin); return publishPackage(o.ws, o.pk, { note, builtin: flag }); };
  const refused = await asTopoTopo(KIT, 'mine', BUILTIN, false), outside = await asTopoTopo(KIT, 'mine');
  check(!refused.ok && refused.blocks.some((b) => /the owner "topotopo" is reserved for TopoTopo's own packages, which TopoTopo's repository publishes into its built-in library/.test(b)), `a project does not publish under "topotopo": ${refused.blocks.join(' | ')}`);
  check(!outside.ok && outside.blocks.some((b) => /only a folder of TopoTopo's built-in library .* publishes one of TopoTopo's own packages/.test(b)), `nor does a folder outside the built-in library: ${outside.blocks.join(' | ')}`);
  const WRONG = path.join(BUILTIN, 'other');
  project(WRONG, { package: 'topotopo/kit2' }, { main: cube(1) });
  check((await asTopoTopo(WRONG, 'x', BUILTIN)).blocks.some((b) => /the folder other of TopoTopo's built-in library holds the package topotopo\/other, and its project\.json names topotopo\/kit2/.test(b)), 'a folder of the built-in library holds the package of its name');
  fs.rmSync(WRONG, { recursive: true });
  const v1 = await asTopoTopo(KIT, 'first kit', BUILTIN);
  check(v1.ok && v1.version === '1.0', `the built-in library's folder publishes topotopo/kit 1.0: ${v1.blocks.join('; ')}`);
  // a project that lists no library: first use copies the kit in and locks it, from library "topotopo"
  const APP = path.join(tmp, 'app');
  project(APP, {}, {});
  const a = await open(APP, [], BUILTIN);
  const scene: GraphSpec = { nodes: { c: { type: 'topotopo/kit/cube', params: { s: 3 } } }, output: 'c' };
  const added = a.pk.addFor(scene);
  check(added.length === 1 && added[0] === 'added topotopo/kit 1.0 to project app from library "topotopo" (TopoTopo\'s built-in library): packages/topotopo/kit/1.0',
    `found without listing a library: ${added.join(' | ')}`);
  check(JSON.stringify(readManifest(APP).uses) === '{"topotopo/kit":"1.0"}' && readLock(APP).packages['topotopo/kit']['1.0'].library === 'topotopo' && readLock(APP).packages['topotopo/kit']['1.0'].hash === v1.hash
    && exists(APP, 'packages', 'topotopo', 'kit', '1.0', 'version.json'), 'copied and locked like any package: the lock names library "topotopo" and the version\'s hash');
  check(size(await a.engine.cook(scene), 0) === 3, 'it cooks from the copy');
  const listed = packagesText(a.pk);
  check(/libraries: none listed .*; TopoTopo's built-in library "topotopo" \(.*builtin\), which every project looks in/.test(listed) && /\n {2}topotopo\/kit {2}1\.0 "first kit" {2}\[library "topotopo" \(TopoTopo's built-in library\)\] {2}\(this project uses 1\.0\)/.test(listed),
    `packages names TopoTopo's built-in library and the packages in it:\n${listed}`);
  // the catalog and help: offered where it is not used yet, with its description as the summary
  const B = path.join(tmp, 'app-b');
  project(B, { libraries: ['topotopo'] }, {});
  const b = await open(B, [], BUILTIN);
  const offered = b.engine.packageDefs().find((d) => d.type === 'topotopo/kit/cube');
  check(!!offered && offered.summary === 'A test cube.' && /^Its size is s\.\ntopotopo\/kit 1\.0: first kit\nOutput "cube" of package topotopo\/kit 1\.0 \(Cube\): it cooks node "b"/.test(offered.description ?? '') && !b.engine.resolveDef('topotopo/kit/cube'),
    `a project that does not use it gets it offered: the catalog lists it (${offered?.summary}), and only a graph's first use makes it resolve`);
  check(b.pk.libraries().length === 0 && /^added topotopo\/kit 1\.0/.test(b.pk.use('topotopo/kit').text), 'a project that lists "topotopo" lists nothing more: the built-in library is looked in anyway');
  const loose = path.join(tmp, 'loose-builtin');
  fs.mkdirSync(loose);
  const lo = await open(loose, [], BUILTIN);
  const notHere = await lo.engine.cook(scene);
  check(lo.engine.packageDefs().some((d) => d.type === 'topotopo/kit/cube') && /this graph is in no project, and only projects use packages \(hint: topotopo init <folder> \(MCP: library \{action:"init"\} for the open workspace\) makes the folder a project/.test(errorOf(notHere)),
    `outside a project it is offered too, and naming it says how to make the folder a project: ${errorOf(notHere)}`);
  // a TopoTopo release with a new version: an update, never a silent change
  setGraph(KIT, 'main', cube(2));
  const v11 = await asTopoTopo(KIT, 'a bigger cube', BUILTIN);
  check(v11.ok && v11.version === '1.1', `topotopo/kit 1.1: ${v11.blocks.join('; ')}`);
  const a2 = await open(APP, [], BUILTIN);
  const late = a2.pk.outdated()[0];
  check(late.package === 'topotopo/kit' && late.small === '1.1' && late.libraries.join() === 'topotopo' && /topotopo\/kit 1\.0: small update 1\.1 {2}\[library "topotopo" \(TopoTopo's built-in library\)\]\n {4}1\.1 {2}"a bigger cube"/.test(outdatedText(a2.pk)),
    `the new built-in version shows as an update (${outdatedText(a2.pk).split('\n')[1]})`);
  check(size(await a2.engine.cook(scene), 0) === 3, 'and the project keeps cooking the copy of 1.0 until it updates');
  check(builtinVersions('topotopo/kit', BUILTIN).map((v) => v.version).join() === '1.0,1.1' && !builtinVersions('studio/trees', BUILTIN).length, 'the versions the built-in library holds (the Gallery names the newest)');
  const up = applyUpdate(a2.pk, 'topotopo/kit');
  check(/from library "topotopo" \(TopoTopo's built-in library\)/.test(up.text) && size(await a2.engine.cook({ nodes: { c: { type: 'topotopo/kit/cube' } } }), 0) === 2 && readLock(APP).packages['topotopo/kit']['1.1'].library === 'topotopo',
    `Update copies 1.1 in from the built-in library: ${up.text.split('\n')[0]}`);
  // following: the working folder in TopoTopo's repository; an installed TopoTopo ships the versions alone
  check(/^following topotopo\/kit for this session: its working folder .*kit \(library "topotopo" \(TopoTopo's built-in library\)\)/.test(a2.pk.follow('topotopo/kit')) && a2.pk.outdated()[0].working.length === 1, 'the built-in library\'s working folder is followed like any');
  const SHIPPED = path.join(tmp, 'shipped');
  fs.cpSync(path.join(KIT, 'versions'), path.join(SHIPPED, 'kit', 'versions'), { recursive: true });
  const a3 = await open(APP, [], SHIPPED);
  check(/topotopo\/kit has no working folder in the libraries this project looks in: "topotopo" holds its versions alone \(an installed TopoTopo ships its own packages without their working folders\), and follow needs one/.test(errorText(() => a3.pk.follow('topotopo/kit')))
    && a3.pk.outdated()[0].working.length === 0 && a3.pk.outdated()[0].libraries.join() === 'topotopo', 'without a working folder there is nothing to follow (the viewer offers no switch)');
  check((await a3.engine.cook(scene)).ok && a3.engine.packageDefs().length > 0, 'and the versions alone serve the project');
  // no registered library takes the built-in library's name
  check(/"topotopo" is the name of TopoTopo's built-in library, which every project looks in: give this library another name/.test(errorText(() => addLibrary('topotopo', path.join(tmp, 'mylib')))), 'library add refuses the name "topotopo"');
  process.env.TOPOTOPO_LIBRARIES = `topotopo=${path.join(tmp, 'mylib')}`;
  check(/^TOPOTOPO_LIBRARIES: "topotopo" is the name of TopoTopo's built-in library/.test(errorText(() => loadConfig())), 'and so does the config');
  delete process.env.TOPOTOPO_LIBRARIES;
}

// ------------------------------------------------------------------ the CLI
section('the CLI: init, use, packages, publish, --follow, --catalog');
{
  const cli = (args: string[], cwd = ROOT) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'src', 'cli.ts'), ...args], { cwd, encoding: 'utf8', env: { ...process.env, TOPOTOPO_WORKERS: '0' } });
    return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
  };
  const CLI = path.join(dirs.repo, 'cliproj');
  const init = cli(['init', CLI, '--package', 'studio/cli']);
  check(init.code === 0 && /^project cliproj → .*cliproj \(package studio\/cli\)/.test(init.out) && readManifest(CLI).package === 'studio/cli' && exists(CLI, '.gitignore'), `init makes a folder a project: ${init.out.split('\n')[0]}`);
  const PLAIN = path.join(dirs.repo, 'plainproj');
  const plain = cli(['init', PLAIN]);
  check(exists(CLI, 'graphs') && plain.code === 0 && /graphs go in graphs\//.test(plain.out) && exists(PLAIN, 'graphs') && readManifest(PLAIN).package === undefined,
    'init makes graphs/, where it says graphs go, for a package and a plain project alike');
  check(cli(['init', CLI]).code === 1 && cli(['init', path.join(CLI, 'inner')]).code === 1, 'init refuses a project, and a folder inside one');
  editManifest(CLI, (m) => { m.libraries = ['../lib']; });
  setGraph(CLI, 'main', { nodes: { r: { type: 'nordic/rocks/boulder', params: { size: 2 } } }, output: 'r' });
  const use = cli(['use', 'nordic/rocks', CLI]);
  check(use.code === 0 && /added nordic\/rocks 1\.0 to project cliproj from library "\.\.\/lib"/.test(use.out), `use: ${use.out.trim()}`);
  const ls = cli(['packages', CLI]);
  check(ls.code === 0 && /nordic\/rocks 1\.0 {2}from library "\.\.\/lib"/.test(ls.out) && /studio\/trees/.test(ls.out) === false && /studio\/rules/.test(ls.out), `packages: ${ls.out.split('\n').slice(0, 3).join(' | ')}`);
  const exp = path.join(CLI, 'exports', 'rock.obj');
  const cook = cli([path.join(CLI, 'graphs', 'main.json'), '--export', exp]);
  const rec = fs.existsSync(exp + '.source.json') ? readJSON(exp + '.source.json').source : {};
  check(cook.code === 0 && JSON.stringify(rec.packages) === JSON.stringify({ 'nordic/rocks@1.0': readLock(CLI).packages['nordic/rocks']['1.0'].hash }), `a graph-file cook records the packages it used: ${JSON.stringify(rec.packages)} ${cook.code ? cook.out : ''}`);
  // the texture of a package output names the copy relative to the root's folder (here graphs/, the graph file's), so
  // exports that carry texture paths name no folder of this machine
  const moss = '../packages/nordic/rocks/1.0/inputs/moss.png';
  for (const ext of ['json', 'geo']) {
    const out = path.join(CLI, 'exports', `rock.${ext}`);
    const r = cli([path.join(CLI, 'graphs', 'main.json'), '--export', out]);
    const txt = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
    const named = txt.split('moss.png').length - 1, relative = txt.split(moss).length - 1;
    check(r.code === 0 && named > 0 && named === relative && fs.existsSync(path.resolve(CLI, 'graphs', moss)), `a .${ext} export of a package output is portable: its texture is ${moss} (${relative} of ${named})`);
  }
  const pub = cli(['publish', CLI, '--note', 'from the cli']);
  check(pub.code === 0 && /✓ published studio\/cli 1\.0 \(the first version\): "from the cli"/.test(pub.out), `publish: ${pub.out.split('\n')[0]}`);
  const again = cli(['publish', CLI, '--note', 'again']);
  check(again.code === 1 && /nothing changed since 1\.0/.test(again.out), 'publish without a change fails');
  // first use from a graph-file cook, --follow, the catalog of the current folder's project
  const FILE = path.join(dirs.forest, 'scene.json');
  json(FILE, { nodes: { t: { type: 'studio/trees/pine' }, x: { type: 'studio/rules/box' }, out: { type: 'merge', in: ['t', 'x'] } }, output: 'out' });
  setGraph(TREES, 'crown', crown(2));
  const fexp = path.join(dirs.forest, 'exports', 'scene.glb');
  const followed = cli([FILE, '--follow', 'studio/trees', '--export', fexp]);
  const frec = fs.existsSync(fexp + '.source.json') ? readJSON(fexp + '.source.json').source : {};
  check(followed.code === 0 && /added studio\/rules 7\.1 to project forest/.test(followed.out) && /following studio\/trees: its working folder/.test(followed.out)
    && typeof frec.packages?.['studio/trees@working'] === 'string' && frec.packages?.['studio/rules@7.1'], `a cook adds on first use and follows a working folder: ${followed.out.split('\n').slice(0, 3).join(' | ')} ${JSON.stringify(frec.packages)}`);
  const cat = cli(['--catalog'], dirs.forest);
  check(cat.code === 0 && /\[package\]/.test(cat.out) && /studio\/trees\/pine ◦? ?— output "pine" of package studio\/trees 1\.1 \(Pine\)/.test(cat.out), `--catalog lists the current project's package outputs: ${cat.out.split('\n').find((l) => l.includes('studio/trees/pine'))}`);
  const hn = cli(['--help-node', 'studio/trees/pine'], dirs.forest);
  check(hn.code === 0 && /## studio\/trees\/pine \(package\)/.test(hn.out) && /studio\/trees 1\.1: bigger crown/.test(hn.out) && /height float = 4 \[1\.\.20\]/.test(hn.out), '--help-node gives a package output\'s sliders, version and note');
  const lost = path.join(tmp, 'loose', 'g.json');
  json(lost, { nodes: { t: { type: 'studio/trees/pine' } } });
  const no = cli([lost]);
  check(no.code === 1 && /in no project, and only projects use packages \(hint: topotopo init/.test(no.out), `a graph outside a project: ${no.out.trim().split('\n')[0]}`);
  setGraph(TREES, 'crown', crown(1.5));
}

// ------------------------------------------------------------------ out of date and Update
const rejection = async (p: Promise<unknown>) => { try { await p; return ''; } catch (e: any) { return String(e.message); } };
/** What an update must leave alone until it is applied: the project's files and copies, and the library. */
const untouched = (dir: string) => JSON.stringify([fs.readFileSync(path.join(dir, 'project.json'), 'utf8'), fs.readFileSync(lockFile(dir), 'utf8'), listing(path.join(dir, 'packages')), listing(dirs.game), listing(dirs.lib)]);

section('out of date: the newer versions of what a project uses, with their notes');
{
  // nordic/rocks 1.1; studio/trees moves to it with an update of its own, then publishes 1.2 (a wider crown and a
  // stump) and 1.3 (taller by default)
  write(path.join(ROCKS, 'inputs', 'rock.obj'), triangle(2.5));
  check((await publish(ROCKS, 'a bigger rock')).version === '1.1', 'nordic/rocks 1.1');
  const t = await open(TREES);
  const own = applyUpdate(t.pk, 'nordic/rocks');
  check(readManifest(TREES).uses['nordic/rocks'] === '1.1' && Object.keys(readLock(TREES).packages['nordic/rocks']).join() === '1.1' && !exists(TREES, 'packages', 'nordic', 'rocks', '1.0') && exists(TREES, 'packages', 'nordic', 'rocks', '1.1', 'version.json'),
    `a package updates what it uses too: ${own.text.split('\n')[0]}`);
  setGraph(TREES, 'crown', crown(1.8));
  treesMain.outputs!.stump = { node: 'tall', label: 'Stump' };
  setGraph(TREES, 'main', treesMain);
  const p12 = await publish(TREES, 'a wider crown, and a stump');
  treesMain.vars!.height = 5;
  setGraph(TREES, 'main', treesMain);
  const p13 = await publish(TREES, 'taller by default');
  check(p12.version === '1.2' && p13.version === '1.3', `studio/trees 1.2 and 1.3, small: ${p12.blocks} ${p13.blocks}`);
  const o = await open(dirs.forest);
  const list = o.pk.outdated(), of = (p: string) => list.find((x) => x.package === p)!;
  check(of('studio/trees').small === '1.3' && !of('studio/trees').big && of('studio/trees').newer.map((v) => `${v.version} ${v.note}`).join(' | ') === '1.2 a wider crown, and a stump | 1.3 taller by default' && of('studio/trees').libraries.join() === 'game',
    `studio/trees 1.1: the small update and the versions after it, with their notes (${JSON.stringify(of('studio/trees'))?.slice(0, 160)})`);
  check(of('nordic/rocks').small === '1.1' && !of('studio/grove').small && !of('studio/grove').big && of('studio/grove').newer.length === 0 && !of('studio/rules').small, 'the others: a small update of nordic/rocks, grove and rules up to date');
  const said = outdatedText(o.pk);
  check(/^project forest: 2 of the 4 packages it uses are out of date/.test(said) && /\n {2}studio\/trees 1\.1: small update 1\.3 {2}\[library "game"\]\n {4}1\.2 {2}"a wider crown, and a stump"\n {4}1\.3 {2}"taller by default"/.test(said)
    && /studio\/grove 1\.0: up to date/.test(said) && /topotopo update owner\/name \[folder\] shows the before\/after/.test(said), `outdated:\n${said}`);
  check(/out of date: nordic\/rocks 1\.0 \(small update 1\.1\), studio\/trees 1\.1 \(small update 1\.3\); outdated lists the notes/.test(packagesText(o.pk)), 'packages says in a line what is out of date');
}

section('Update: the before/after of a small update; nothing is written until it is applied');
{
  // the forest uses studio/trees in graphs/main.json, in a foreach body (graphs/loop.json), in an asset and in a graph
  // file outside graphs/ (scene.json)
  setGraph(dirs.forest, 'loop', { nodes: { loop: { type: 'foreach', params: { mode: 'count', count: 2, body: { nodes: { t: { type: 'studio/trees/pine', params: { height: '=2 + iteration' } }, m: { type: 'transform', in: ['t'], params: { translate: ['=iteration * 6', 0, 0] } } }, output: 'm' } } } }, output: 'loop' });
  write(path.join(dirs.forest, 'assets', 'twin.json'), JSON.stringify({ nodes: { t: { type: 'studio/trees/pine', params: { height: '=h' } } }, output: 't', vars: { h: 3 } }));
  // not a place: a graph in an exports/ folder, here beside a graph file in a subfolder
  write(path.join(dirs.forest, 'levels', 'exports', 'scene.json'), fs.readFileSync(path.join(dirs.forest, 'scene.json')));
  const o = await open(dirs.forest);
  check(/this project does not use studio\/oaks: its uses are nordic\/rocks, studio\/grove, studio\/rules, studio\/trees/.test(await rejection(beforeAfter(o.pk, 'studio/oaks'))), 'a package the project does not use');
  check(/studio\/grove 1\.0 is the newest version in the project's libraries: there is nothing to update/.test(await rejection(beforeAfter(o.pk, 'studio/grove'))), 'a package that is up to date');
  check(/no library this project lists has studio\/trees 1\.9: they have 1\.0, 1\.1, 1\.2, 1\.3/.test(await rejection(beforeAfter(o.pk, 'studio/trees', { to: '1.9' }))) && /this project uses studio\/trees 1\.1 already/.test(await rejection(beforeAfter(o.pk, 'studio/trees', { to: '1.1' }))),
    'a version no library has, and the version in use');
  const was = untouched(dirs.forest);
  const steps: string[] = [];
  const r = await beforeAfter(o.pk, 'studio/trees', { progress: (done, total, what) => steps.push(`${done}/${total} ${what}`) });
  check(r.target.from === '1.1' && r.target.to === '1.3' && !r.target.big && r.target.library === 'game' && r.target.between.map((v) => v.version).join() === '1.2,1.3', `without "to": the newest version with the same big number, ${r.target.from} → ${r.target.to}`);
  check(r.uses.map((u) => `${u.file} ${u.node}`).join(' | ') === 'graphs/loop.json loop/t | graphs/main.json b | assets/twin.json t | scene.json t',
    `every place the project uses it: graphs, a nested graph, an asset, a graph file (${r.uses.map((u) => `${u.file} ${u.node}`).join(' | ')})`);
  check(r.compared.map((c) => c.node).join() === 'loop,b,t,t' && r.compared.every((c) => c.before.ok && c.after.ok && c.diff && !c.diff.identical),
    `each cooked with both versions and compared; a use in a nested graph through the node that holds it (${r.compared.map((c) => `${c.file} ${c.node}: ${c.after.errors.join(';') || (c.diff?.identical ? 'same' : 'changed')}`).join(' | ')})`);
  const main = r.compared.find((c) => c.file === 'graphs/main.json')!;
  check(/^counts: points/m.test(main.diff!.text) && /^bbox delta:/m.test(main.diff!.text) && /^attributes:/m.test(main.diff!.text) && /^verdict: shape changed by up to/m.test(main.diff!.text), 'what changed: counts, size, attributes, the largest move');
  check(steps.length === 8 && steps[0] === '0/8 graphs/loop.json loop with studio/trees 1.1' && steps[7] === '7/8 scene.json t with studio/trees 1.3', `progress before each cook (${steps[0]} … ${steps[7]})`);
  check(untouched(dirs.forest) === was && readManifest(dirs.forest).uses['studio/trees'] === '1.1', 'nothing is written: project.json, the lock, the copies and the libraries are as they were');
  const text = beforeAfterText(r, 'nothing was written');
  check(/^before\/after: studio\/trees 1\.1 → 1\.3 \(a small update\) in project forest; nothing has changed yet\nstudio\/trees 1\.3 is in library "game"\. The versions after 1\.1:\n {2}1\.2 {2}"a wider crown, and a stump"\n {2}1\.3 {2}"taller by default"/.test(text)
    && /\n4 places use studio\/trees; each cooked with 1\.1 \(a\) and with 1\.3 \(b\):/.test(text) && /\n {2}graphs\/loop\.json {2}loop: holds loop\/t \(studio\/trees\/pine \{"height":"=2 \+ iteration"\}\); its result compared/.test(text)
    && /\n {2}graphs\/main\.json {2}b: studio\/trees\/pine \{"height":6\}\n {4}counts:/.test(text) && /\nin short: 4 of the 4 compared changed\nnothing was written$/.test(text) && !/must change/.test(text), `the before/after says it:\n${text.split('\n').slice(0, 12).join('\n')}`);
  const renders = overlayRenders(r);
  check(renders.length === 4 && renders.every((x) => x.png.length > 1000 && x.png[1] === 0x50), `an overlay render of each place that changed (${renders.map((x) => x.title).join(', ')})`);
  // it reuses the cook cache: a second before/after cooks nothing
  const again = await beforeAfter(o.pk, 'studio/trees');
  check(again.compared.every((c) => c.before.cooked === 0 && c.after.cooked === 0) && r.compared.some((c) => c.after.cooked > 0), 'the cook cache: a second before/after cooks nothing again');
  // a stop ends it at the next node: what was compared is kept
  const fresh = await open(dirs.forest), stop = { aborted: false };
  const s = await beforeAfter(fresh.pk, 'studio/trees', { signal: stop, progress: (done) => { if (done === 2) stop.aborted = true; } });
  check(s.stopped && s.compared.length === 1 && /stopped after 1 of 4 comparisons/.test(beforeAfterText(s, '')), `it can be stopped (${s.compared.length} compared)`);
  // following a package plays no part: the before/after compares the copies
  const f = await open(dirs.forest, ['studio/trees']);
  const fr = await beforeAfter(f.pk, 'studio/trees');
  check(fr.compared.length === 4 && fr.compared.every((c, i) => c.before.ok && Math.abs(c.diff!.hausdorff - r.compared[i].diff!.hausdorff) < 1e-9), 'while following its working folder, the before is still the copy in use');
  // apply: the new version and what it uses are copied in, the uses and the lock name them, unused copies go
  const a = applyUpdate(o.pk, 'studio/trees');
  const lock = readLock(dirs.forest);
  check(a.target.to === '1.3' && JSON.stringify(readManifest(dirs.forest).uses) === '{"nordic/rocks":"1.0","studio/grove":"1.0","studio/rules":"7.1","studio/trees":"1.3"}', `applied: project.json uses studio/trees 1.3 (${a.text.split('\n')[0]})`);
  check(Object.keys(lock.packages['studio/trees']).join() === '1.0,1.3' && Object.keys(lock.packages['nordic/rocks']).join() === '1.0,1.1' && lock.packages['studio/trees']['1.3'].library === 'game',
    'the lock: trees 1.3 and the rocks 1.1 it uses; trees 1.0 and rocks 1.0, which grove and the project still use, stay');
  check(exists(dirs.forest, 'packages', 'studio', 'trees', '1.3', 'version.json') && exists(dirs.forest, 'packages', 'nordic', 'rocks', '1.1', 'version.json') && !exists(dirs.forest, 'packages', 'studio', 'trees', '1.1')
    && exists(dirs.forest, 'packages', 'studio', 'trees', '1.0', 'version.json') && exists(dirs.forest, 'packages', 'nordic', 'rocks', '1.0', 'version.json'), 'the copies: 1.3 and what it uses copied in, 1.1 deleted, the dependencies still used kept');
  check(/^updated studio\/trees 1\.1 → 1\.3 in project forest: project\.json uses studio\/trees 1\.3, from library "game"\n {2}copied into packages\/: nordic\/rocks 1\.1, studio\/trees 1\.3; packages\/lock\.json records them\n {2}deleted the copies nothing uses any more: studio\/trees 1\.1$/.test(a.text), `it says what it did:\n${a.text}`);
  const cooked = await o.engine.cook(o.ws.getGraph('main'));
  check(cooked.ok && top(cooked) === 7.8 && o.pk.verifyCopies().length === 0, `the project cooks with 1.3 at once (top ${top(cooked)}), and its copies check`);
  const back = await beforeAfter(o.pk, 'studio/trees', { to: '1.2' });
  check(back.target.between.map((v) => v.version).join() === '1.3' && /\(back to an older version\)/.test(beforeAfterText(back, '')), 'going back to an older version lists the ones it leaves');
}

section('Update: a big version is named, and says what the graphs must change');
{
  // studio/trees 2.0: "height" is now "trunk_height", no ground input, no stump, no rock (and so no nordic/rocks)
  const g2: any = structuredClone(treesMain);
  g2.vars = { trunk_height: 5 };
  g2.params = { trunk_height: { type: 'float', min: 1, max: 20, label: 'Height' } };
  g2.nodes.tall.params.scale = [1, '=trunk_height', 1];
  g2.nodes.lifted.params.translate = [0, '=trunk_height', 0];
  delete g2.nodes.ground;
  delete g2.nodes.rock;
  g2.nodes.out.in = ['tall', 'lifted'];
  delete g2.outputs.stump;
  setGraph(TREES, 'main', g2);
  editManifest(TREES, (m) => { m.uses = {}; });
  fs.rmSync(path.join(TREES, 'packages'), { recursive: true });
  const p2 = await publish(TREES, 'height in trunk_height; no ground, no stump, no rock');
  check(p2.version === '2.0' && p2.bigBecause.some((b) => /slider "height" removed/.test(b)), `studio/trees 2.0, big: ${p2.bigBecause.join('; ')}`);
  // the yard uses the stump and wires the ground input
  setGraph(dirs.forest, 'yard', { nodes: { g: { type: 'grid', params: { size: [10, 10] } }, p: { type: 'studio/trees/pine', in: ['g'], params: { height: 2 } }, s: { type: 'studio/trees/stump' }, out: { type: 'merge', in: ['p', 's'] } }, output: 'out' });
  const o = await open(dirs.forest);
  check(o.pk.outdated().find((x) => x.package === 'studio/trees')?.big === '2.0', 'outdated names the big update');
  check(/studio\/trees 1\.3 is the newest 1\.x in the project's libraries, and 2\.0 is a big version, a step of its own: name it, --to 2\.0 \(library \{action:"update", package:"studio\/trees", to:"2\.0"\}\)/.test(await rejection(beforeAfter(o.pk, 'studio/trees'))),
    'without "to", a big version is not taken: it says how to name it');
  const was = untouched(dirs.forest);
  const r = await beforeAfter(o.pk, 'studio/trees', { to: '2.0' });
  check(r.target.big && r.interfaceBig.some((x) => /output "pine": slider "height" removed/.test(x)) && r.interfaceBig.some((x) => /input 0 \("ground"\) removed/.test(x)) && r.interfaceBig.some((x) => /output "stump" removed/.test(x)),
    `what goes away in 2.0: ${r.interfaceBig.join('; ')}`);
  const must = r.mustChange.join('\n');
  check(/^graphs\/loop\.json loop\/t: sets slider "height", which studio\/trees 2\.0 does not have — did you mean "trunk_height"\? \(its sliders: trunk_height\)$/m.test(must)
    && /^graphs\/main\.json b: sets slider "height"/m.test(must) && /^assets\/twin\.json t: sets slider "height"/m.test(must) && /^graphs\/yard\.json p: sets slider "height"/m.test(must),
    'sliders the graphs set that 2.0 does not have, with did-you-mean');
  check(/^graphs\/yard\.json p: wires input 0 \("ground"\), which studio\/trees 2\.0 does not have \(it has 0 inputs\)$/m.test(must), 'inputs they wire that are gone');
  check(/^graphs\/yard\.json s: uses studio\/trees\/stump, and studio\/trees 2\.0 has no output "stump"/m.test(must) && !/scene\.json/.test(must) && r.mustChange.length === 6, `outputs they use that are gone; nothing for a use that sets nothing (${r.mustChange.length}):\n${must}`);
  const main = r.compared.find((c) => c.file === 'graphs/main.json')!, scene = r.compared.find((c) => c.file === 'scene.json')!;
  check(main.before.ok && !main.after.ok && /unknown param "height" for studio\/trees\/pine — did you mean "trunk_height"/.test(main.after.errors.join()) && scene.after.ok && !!scene.diff,
    'with 2.0 a use that must change does not cook, the others are compared');
  const text = beforeAfterText(r, 'nothing was written');
  check(/\(a big update\)/.test(text) && /\n2\.0 is a big version; what goes away or means something else:\n/.test(text) && /\nwhat the project's graphs must change \(updating is allowed; until they change, they report these errors\):\n/.test(text) && /with 2\.0 it does not cook: \[b\] unknown param "height"/.test(text),
    'the before/after says it');
  check(untouched(dirs.forest) === was, 'nothing written');
  // applying is allowed: the graphs then report what they must change
  const a = applyUpdate(o.pk, 'studio/trees', '2.0');
  check(readManifest(dirs.forest).uses['studio/trees'] === '2.0' && /deleted the copies nothing uses any more: nordic\/rocks 1\.1, studio\/trees 1\.3/.test(a.text) && !exists(dirs.forest, 'packages', 'nordic', 'rocks', '1.1') && exists(dirs.forest, 'packages', 'nordic', 'rocks', '1.0', 'version.json'),
    `applied: 1.3 and the rocks 1.1 only it used are deleted, rocks 1.0 stays (${a.text.split('\n')[2]})`);
  check(/the project's graphs must change for studio\/trees 2\.0; until they do, they report these errors:\n {2}graphs\/loop\.json loop\/t: sets slider "height"/.test(a.text) && a.mustChange.length === 6, 'applying says what the graphs must change');
  const cooked = await o.engine.cook(o.ws.getGraph('main'));
  check(!cooked.ok && /unknown param "height" for studio\/trees\/pine — did you mean "trunk_height"/.test(errorOf(cooked)), `the graphs report it until they change: ${errorOf(cooked)}`);
  const back = await beforeAfter(o.pk, 'studio/trees', { to: '1.3' }), backText = beforeAfterText(back, '');
  check(/\(back to an older big version\)/.test(backText) && /\ngoing back to 1\.3 crosses a big version; what goes away or means something else:\n {2}output "pine": slider "trunk_height" removed\n/.test(backText) && !back.mustChange.length,
    'going back across a big version says what goes away, and the graphs, which set "height", need no change for it');
  // a package the project uses only through another
  const user = path.join(dirs.repo, 'grove-user');
  project(user, { libraries: ['../../game'] }, {});
  const u = await open(user);
  u.pk.use('studio/grove');
  check(/this project does not use studio\/trees itself \(studio\/grove 1\.0 uses studio\/trees 1\.0\): a version keeps what it uses/.test(await rejection(beforeAfter(u.pk, 'studio/trees'))), 'a package used only through another says so');
}

section('the CLI: outdated, update and --apply');
{
  const cli = (args: string[], cwd = ROOT) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'src', 'cli.ts'), ...args], { cwd, encoding: 'utf8', env: { ...process.env, TOPOTOPO_WORKERS: '0' } });
    return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
  };
  const CLI = path.join(dirs.repo, 'cliproj');
  const od = cli(['outdated', CLI]);
  check(od.code === 0 && /nordic\/rocks 1\.0: small update 1\.1 {2}\[library "\.\.\/lib"\]\n {4}1\.1 {2}"a bigger rock"/.test(od.out), `outdated: ${od.out.trim().split('\n').slice(0, 3).join(' | ')}`);
  const was = untouched(CLI);
  const renders = path.join(tmp, 'renders');
  const ba = cli(['update', 'nordic/rocks', CLI, '--render', renders]);
  check(ba.code === 0 && /^before\/after: nordic\/rocks 1\.0 → 1\.1 \(a small update\) in project cliproj/.test(ba.out) && /graphs\/main\.json {2}r: nordic\/rocks\/boulder \{"size":2\}/.test(ba.out) && /\[1\/2\] graphs\/main\.json r with nordic\/rocks 1\.0/.test(ba.err),
    `update shows the before/after, progress on stderr:\n${ba.out.split('\n').slice(0, 4).join('\n')}`);
  check(new RegExp(`nothing was written\\. To apply it: node src/cli\\.ts update nordic/rocks ${CLI.replace(/[\\.]/g, '\\$&')} --to 1\\.1 --apply`).test(ba.out), 'and how to apply it');
  check(fs.existsSync(renders) && fs.readdirSync(renders).join() === '01-graphs_main.json_r.png' && untouched(CLI) === was, `--render writes the overlay renders, and nothing else is written (${fs.existsSync(renders) ? fs.readdirSync(renders) : 'none'})`);
  const ap = cli(['update', 'nordic/rocks', CLI, '--apply']);
  check(ap.code === 0 && /^updated nordic\/rocks 1\.0 → 1\.1 in project cliproj/.test(ap.out) && readManifest(CLI).uses['nordic/rocks'] === '1.1' && !exists(CLI, 'packages', 'nordic', 'rocks', '1.0'), `--apply applies it: ${ap.out.split('\n')[0]}`);
  const none = cli(['update', 'nordic/rocks', CLI]);
  check(none.code === 1 && /nordic\/rocks 1\.1 is the newest version in the project's libraries: there is nothing to update/.test(none.err), `nothing newer: ${none.err.trim()}`);
  check(cli(['update']).code === 1 && /usage: .* update owner\/name \[folder\]/.test(cli(['update']).err), 'update without a package says how to use it');
}

await engines[0]?.host.pool?.close();
console.log(`\n${passes} passed, ${failures} failed — temp ${tmp}`);
process.exit(failures ? 1 : 0);
