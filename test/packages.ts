// Packages (src/graph/packages.ts, src/packages/registry.ts). The engine: package output names and their errors, a
// scope's package resolver, a package output's node type (its sliders, inputs, scope, signature and texture paths), the
// packages a graph names and uses, "publish": false. The registry: publishing (the version rule, --big, blocks and
// warnings, version.json, the hash, what a version holds), a package's graphs naming its own outputs (in its package, in
// a version, in a followed working folder; loops), TopoTopo's built-in library (looked in without listing it, copied
// and locked, a new version an update, publishing under "topotopo", following with and without a working folder, the
// reserved library name), first use and `use` (copies, flat dependencies, the lock,
// the places a package looks in: its workspace and the libraries the workspace lists, else every registered library;
// precedence, two folders of one name, "topotopo/…"), cooking package outputs (sliders, inputs, a package that uses
// another, two versions side by side, files and textures read from the version, nothing leaking), hand-edited and
// missing copies, following a working folder, exports' source records, Godot's .gdignore files and the files engines
// write, and the CLI commands. Everything sits in a temp folder with a config of its own ($TOPOTOPO_CONFIG):
//   game/          a registered library ("game"): trees, grove (packages inside a library, outside any workspace)
//   lib/           a registered library ("lib"): rocks, kinds, rules …
//   other/         a registered library ("other"), which the workspace does not list
//   repo/forest/   a package outside any workspace and library: it looks in every registered library
//   valley/          a workspace "valley" listing "lib": packages in plain folders (assets/props/crate, furniture/chair,
//                  levels/…), which find each other by themselves
//   node test/packages.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import '../src/nodes/index.ts';
import { GeoBuilder, Geometry } from '../src/core/geometry.ts';
import { defineNode } from '../src/graph/registry.ts';
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
import { Session } from '../src/session.ts';
import { addLibrary, loadConfig } from '../src/config.ts';
import { copiesFor, librariesFor, libraryEntry, manifestFile, parseManifest, readManifest, resolveListed, writeManifest } from '../src/package.ts';
import { initWorkspace, readWorkspace, workspaceText } from '../src/workspace.ts';
import { resolveTarget, targetError, targetWarning } from '../src/io/targets.ts';
import { forgetScans } from '../src/scan.ts';
import { checkAll, checkText } from '../src/packages/check.ts';
import { scanLibrary } from '../src/web/library.ts';
import { builtinVersions, compareInterfaces, lockFile, openPackages, packagesText, publishPackage, publishText, publishedVersions, readLock, searchPackages, searchText, startsBigVersion, textContent, versionHash } from '../src/packages/registry.ts';
import { makeTools } from '../src/mcp/tools.ts';
import { workspaceTool } from '../src/mcp/workspace.ts';
import { catalogText, topicText } from '../src/mcp/docs.ts';
import { PACKAGE_COMMANDS, commands } from '../src/packages/commands.ts';
import type { PackageUses, PublishResult } from '../src/packages/registry.ts';
import { applyUpdate, beforeAfter, beforeAfterText, outdatedText, overlayRenders, removePackage } from '../src/packages/update.ts';
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
  // a version's folder, scope, asset and graphs, by hand: what the registry (src/packages/registry.ts) builds from disk
  const base = path.join(tmp, 'engine'), vdir = path.join(base, 'parts');
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
  const scope = e.createScope('test/parts@1.0', { folder: vdir, graphs: (n) => graphs[n] });
  e.registerAsset('part', { nodes: { b: { type: 'box', params: { size: [0.5, 0.5, 0.5] } } }, output: 'b' }, { scope });
  const out = (o: { output: string; node: string; hash?: string; version?: string | null }) => packageOutputDef({
    package: 'test/parts', version: o.version === undefined ? '1.0' : o.version, hash: o.hash ?? 'h1', signature: o.hash ?? 'h1', output: o.output, graph: 'main', spec: graphs.main, node: o.node, scope, note: 'first version',
  });
  const mark = out({ output: 'mark', node: 'out' }), packed = out({ output: 'packed', node: 'packed' });
  const defs: Record<string, NodeDef> = { 'test/parts/mark': mark, 'test/parts/packed': packed };
  const resolver: PackageResolver = { resolve: (n) => defs[n] ?? { error: `no "${n}" here`, hint: 'only test/parts/mark and test/parts/packed' }, names: () => Object.keys(defs) };
  e.root.packages = resolver;
  check(e.resolveDef('test/parts/mark') === mark && !e.resolveDef('test/parts/x') && e.allTypeNames().includes('test/parts/packed') && e.packageDefs().length === 2,
    'resolveDef, allTypeNames and packageDefs ask the scope\'s packages');
  const v = e.validate({ nodes: { a: { type: 'test/parts/x' } } });
  check(v.errors[0]?.message === 'no "test/parts/x" here' && v.errors[0].hint === 'only test/parts/mark and test/parts/packed', 'validate gives the resolver\'s error and hint');
  check(!e.resolveDef('test/parts/mark', e.createScope('test/none')) && !e.resolveDef('part'), 'another scope has none of it, and the root not the version\'s asset');
  check(mark.category === 'package' && mark.params.k?.max === 5 && mark.inputs.length === 1 && mark.inputs[0].desc === 'base' && /test\/parts 1\.0: first version/.test(mark.description ?? '') && !mark.usesScope,
    'its node type: the graph\'s vars are its params, its input nodes its inputs; version and note in its description');
  const a = await e.cook({ nodes: { k: { type: 'test/parts/mark', params: { k: 2 } } } });
  const bb = a.geo?.bbox();
  check(a.ok && bb!.max[0] === 6 && bb!.min[0] === -0.25, `it cooks in the version's scope: its file (3 wide, scaled 2) and its asset through its graph_ref (${errorOf(a)} ${bb?.min[0]}..${bb?.max[0]})`);
  const tex = a.geo ? readMaterials(a.geo).bark?.textures?.baseColor : '';
  check(tex === path.join(vdir, 'inputs', 'bark.png'), `a texture path relative to the version is made absolute: ${tex}`);
  const p = await e.cook({ nodes: { k: { type: 'test/parts/packed' } } });
  const src = p.geo?.hasPacked() ? readMaterials(p.geo.packedSources[0]).bark?.textures?.baseColor : '';
  check(src === path.join(vdir, 'inputs', 'bark.png'), `in packed sources too: ${src}`);
  const g = await e.cook({ nodes: { grid: { type: 'grid', params: { size: [20, 20] } }, k: { type: 'test/parts/mark', in: ['grid'] } }, output: 'k' });
  check(size(g, 0) === 20, 'an input goes to its input node');
  // the signature: the version's hash and the node, shared by every scope that resolves the same output
  const again = await e.cook({ nodes: { k: { type: 'test/parts/mark', params: { k: 2 } } } });
  const elsewhere = await e.cook({ nodes: { k: { type: 'test/parts/mark', params: { k: 2 } } } }, { scope: e.createScope('test/user', { packages: resolver }) });
  check(again.results.get('k')!.cached && elsewhere.results.get('k')!.cached && elsewhere.results.get('k')!.sig === a.results.get('k')!.sig, 'one version cooks once for every scope that uses it');
  defs['test/parts/mark'] = out({ output: 'mark', node: 'out', hash: 'h2' });
  const other = await e.cook({ nodes: { k: { type: 'test/parts/mark', params: { k: 2 } } } });
  check(!other.results.get('k')!.cached && other.results.get('k')!.sig !== a.results.get('k')!.sig, 'another hash is another result');
  // the packages a graph uses: directly, through an asset and a graph_ref graph
  e.registerAsset('uses_part', { nodes: { k: { type: 'test/parts/packed' } }, output: 'k' });
  e.root.graphs = (n) => (n === 'refd' ? { nodes: { k: { type: 'test/parts/mark' } }, output: 'k' } : undefined);
  const used = packagesUsed(e, { nodes: { a: { type: 'uses_part' }, r: { type: 'graph_ref', params: { graph: 'refd' } } } });
  check(JSON.stringify(used) === '{"test/parts@1.0":"h2"}', `packagesUsed finds them through assets and graph_ref graphs: ${JSON.stringify(used)}`);
  defs['test/parts/working'] = out({ output: 'working', node: 'out', version: null, hash: 'w1' });
  check(JSON.stringify(packagesUsed(e, { nodes: { w: { type: 'test/parts/working' }, a: { type: 'uses_part' } } })) === '{"test/parts@1.0":"h1","test/parts@working":"w1"}', 'a working folder is "@working", keys sorted');
  // which texture paths are rebased: file paths, relative and absolute, not images or URLs
  const geo = new Geometry();
  writeMaterials(geo, { t: { baseColor: [1, 1, 1], metallic: 0, roughness: 1, emissive: [0, 0, 0], alpha: 1, doubleSided: false, unlit: false, textures: { baseColor: 'image:noise', normal: 'https://example.com/n.png', roughness: '/abs/r.png', orm: 'maps/orm.png' } } });
  const t = readMaterials(rebaseTexturePaths(geo, (x, relative) => `${relative ? 'V' : 'A'}|${x}`)).t.textures!;
  check(t.baseColor === 'image:noise' && t.normal === 'https://example.com/n.png' && t.roughness === 'A|/abs/r.png' && t.orm === 'V|maps/orm.png', 'file paths are rebased, told whether they are relative; images and URLs are not');
  check(readMaterials(geo).t.textures!.orm === 'maps/orm.png', 'the cooked geometry itself is never changed');
  check(rebaseTexturePaths(geo, (x) => x) === geo, 'nothing rewritten: the same geometry');
  // given rootPath (as the registry gives it), the root's result names its textures by it, another scope's absolutely
  const named = packageOutputDef({
    package: 'test/parts', version: '1.0', hash: 'h1', signature: 'h1', output: 'mark', graph: 'main', spec: graphs.main, node: 'out', scope,
    rootPath: (abs) => `root:${path.basename(abs)}`,
  });
  defs['test/parts/named'] = named;
  const forRoot = await e.cook({ nodes: { k: { type: 'test/parts/named' } } });
  const inside = await e.cook({ nodes: { k: { type: 'test/parts/named' } } }, { scope: e.createScope('test/user', { packages: resolver }) });
  const texOf = (r: CookReport) => (r.geo ? readMaterials(r.geo).bark?.textures?.baseColor : '');
  check(texOf(forRoot) === 'root:bark.png' && texOf(inside) === path.join(vdir, 'inputs', 'bark.png'), `with rootPath: the root's result names its textures by it, another scope's absolutely (${texOf(forRoot)}, ${texOf(inside)})`);
  check(forRoot.results.get('k')!.sig !== inside.results.get('k')!.sig, 'so the two are cached apart');
}

section('the engine finds a node that reads its scope, with no flag');
{
  // test only: a box as wide as its scope's id is long, read in its cook; and one whose signatureExtra reads the scope
  defineNode({
    type: 'test_scope_width', category: 'generate', summary: 'test only: a box as wide as the scope id', inputs: [], params: {},
    cook: async (ctx) => { const b = new GeoBuilder(); b.addPoint(0, 0, 0); b.addPoint(ctx.scope.assets.size + (ctx.scope.files === ctx.engine.root.files ? 0 : 1), 1, 1); return b.build(); },
  });
  defineNode({
    type: 'test_scope_stamp', category: 'generate', summary: 'test only: its signature reads the scope', inputs: [], params: {},
    signatureExtra: (_p, scope) => String(scope.assets.size),
    cook: async () => { const b = new GeoBuilder(); b.addPoint(0, 0, 0); return b.build(); },
  });
  const e = await newEngine(tmp);
  const a = e.createScope('a'), bb = e.createScope('bbbb');
  const piece: GraphSpec = { nodes: { b: { type: 'box' } }, output: 'b' };
  e.registerAsset('one', piece, { scope: a });
  for (const n of ['one', 'two']) e.registerAsset(n, piece, { scope: bb });
  const w = async (s: any) => size(await e.cook({ nodes: { n: { type: 'test_scope_width' } } }, { scope: s }), 0);
  check(await w(e.root) === 0 && await w(a) === 1 && await w(bb) === 2 && await w(a) === 1, 'a node that reads ctx.scope while it cooks is cached per scope (found on its first cook, remembered)');
  const st = async (s: any) => (await e.cook({ nodes: { n: { type: 'test_scope_stamp' } } }, { scope: s })).results.get('n')!.sig;
  check(await st(a) !== await st(bb) && await st(e.root) !== await st(a), 'one whose signatureExtra reads the scope is keyed by it from the start');
  const r1 = await e.cook({ nodes: { n: { type: 'box' } } }, { scope: a }), r2 = await e.cook({ nodes: { n: { type: 'box' } } }, { scope: bb });
  check(r1.results.get('n')!.sig === r2.results.get('n')!.sig && r2.results.get('n')!.cached, 'a node that never reads its scope is shared by every scope');
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
/** A folder's files but dot-files (the hash cache, the lock while it is held). */
const shown = (dir: string) => listing(dir).filter((f) => !f.split('/').some((p) => p.startsWith('.')));

const dirs = {
  repo: path.join(tmp, 'repo'), lib: path.join(tmp, 'lib'), forest: path.join(tmp, 'repo', 'forest'),
  game: path.join(tmp, 'game'), other: path.join(tmp, 'other'), valley: path.join(tmp, 'valley'),
};
json(process.env.TOPOTOPO_CONFIG, { libraries: [{ name: 'game', path: dirs.game }, { name: 'lib', path: dirs.lib }, { name: 'other', path: dirs.other }] });

/**
 * A package folder: <folder>.topo over the defaults, its graphs, and any other files. Written behind TopoTopo's back, as
 * a person would: the scans this process keeps are forgotten, as a new command or a refresh forgets them.
 */
function writePackage(dir: string, manifest: Record<string, unknown>, graphs: Record<string, GraphSpec>, files: Record<string, string | Uint8Array> = {}) {
  json(path.join(dir, `${path.basename(dir)}.topo`), { title: path.basename(dir), graph: 'main', ...manifest });
  for (const [n, g] of Object.entries(graphs)) json(path.join(dir, 'graphs', `${n}.json`), g);
  for (const [rel, d] of Object.entries(files)) write(path.join(dir, rel), d);
  forgetScans();
}
const setGraph = (dir: string, name: string, g: GraphSpec) => json(path.join(dir, 'graphs', `${name}.json`), g);
const editManifest = (dir: string, f: (m: any) => void) => { const m = readJSON(manifestFile(dir)); f(m); json(manifestFile(dir), m); };

interface Opened { engine: Engine; pk: PackageUses; ws: Session }
/** An engine, the packages used by the package `dir` belongs to, and a package on it, as the tools open them. */
async function open(dir: string, follow: string[] = [], builtin?: string): Promise<Opened> {
  const engine = await newEngine(dir);
  const pk = openPackages(engine, dir, { follow, builtin });
  const ws = new Session(dir, engine);
  ws.packages = pk;
  ws.load();
  return { engine, pk, ws };
}
const publish = async (dir: string, note: string | undefined, big = false): Promise<PublishResult> => publishPackage(openPackages(await newEngine(dir), dir), { note, big });

// nordic/rocks: a mesh and a texture from its own inputs/ (the package that uses it has an inputs/rock.obj of its own)
const ROCKS = path.join(dirs.lib, 'rocks');
writePackage(ROCKS, { name: 'nordic/rocks' }, {
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
  'exports/old.glb': 'x', 'attachments/concept.png': grey(10), '.web/thumb.png': grey(20), 'notes.txt': 'notes', 'scripts/build.py': 'print(1)',
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
  outputs: { pine: { node: 'out', label: 'Pine', kind: 'mesh', tags: ['conifer', 'tree'] }, preview: { node: 'lifted', publish: false } },
};
const crown = (r: number): GraphSpec => ({ nodes: { s: { type: 'sphere', params: { radius: r } } }, output: 's' });
writePackage(TREES, { name: 'studio/trees' }, { main: treesMain, crown: crown(1) }, {
  'assets/bark.json': JSON.stringify({ nodes: { t: { type: 'tube', params: { radius: '=r', height: 1 } } }, output: 't', vars: { r: 0.2 } }),
});

// studio/grove: uses studio/trees (a package that uses a package that uses another)
const GROVE = path.join(dirs.game, 'grove');
writePackage(GROVE, { name: 'studio/grove' }, { main: { nodes: { t: { type: 'studio/trees/pine', params: { height: 2 } } }, output: 't' } });

// other/thing: in a registered library the workspace does not list
writePackage(path.join(dirs.other, 'thing'), { name: 'other/thing' }, { main: { nodes: { b: { type: 'box' } }, output: 'b' } });

// valley: a workspace listing the library "lib"; its packages in plain folders, one under assets/, one nested by kind
json(path.join(dirs.valley, 'topotopo-workspace.json'), { name: 'valley', libraries: ['lib'] });
const CRATE = path.join(dirs.valley, 'assets', 'props', 'crate'), CHAIR = path.join(dirs.valley, 'furniture', 'chair'), YARD = path.join(dirs.valley, 'levels', 'yard');
writePackage(CRATE, { name: 'valley/crate' }, { main: { nodes: { b: { type: 'box', params: { size: [1, 0.5, 1] } } }, output: 'b', outputs: { crate: { node: 'b', kind: 'mesh', tags: ['crate'], description: 'A crate.' } } } });
writePackage(CHAIR, { name: 'valley/chair' }, { main: { nodes: { t: { type: 'tube' } }, output: 't' } });
writePackage(YARD, {}, {});

section('the manifest: name, uses, no libraries');
{
  check(throws(() => parseManifest({ name: 'trees' }, 'x'), /"name" "trees" must be "owner\/name"/), 'name is owner/name');
  check(throws(() => parseManifest({ name: 'studio/trees/pine' }, 'x'), /must be "owner\/name"/), 'a package name has no output');
  check(throws(() => parseManifest({ package: 'studio/trees' }, 'x'), /"package" is "name" now/) && throws(() => parseManifest({ id: 'trees' }, 'x'), /the file's name is the package id; remove "id"/),
    'no "package" and no "id": the error names the change');
  check(throws(() => parseManifest({ uses: { 'studio/trees': '1' } }, 'x'), /needs a version such as "1\.3"/), 'uses need big.small versions');
  check(throws(() => parseManifest({ uses: { 'studio/trees': '01.0' } }, 'x'), /needs a version/) && throws(() => parseManifest({ uses: { trees: '1.0' } }, 'x'), /not a package name/), 'no leading zeros; keys are package names');
  const gone = errorText(() => parseManifest({ libraries: ['game', '../shared lib'] }, 'x'));
  check(/^"libraries" is gone from the package manifest: a workspace lists the shared libraries its packages use \(topotopo workspace library add <name or folder>\); outside a workspace every registered library counts; remove "libraries"$/.test(gone),
    `a manifest that still lists libraries is refused, naming where each entry goes now: ${gone}`);
  check(throws(() => parseManifest({ libraries: 'game' }, 'x'), /"libraries" is gone/) && !throws(() => parseManifest({ libraries: [] }, 'x'), /./), 'an empty "libraries" is dropped silently');
  const emptied = path.join(tmp, 'emptied');
  writePackage(emptied, { libraries: [] }, {});
  writeManifest(emptied, { ...readManifest(emptied), description: 'kept' });
  check(!('libraries' in readJSON(manifestFile(emptied))) && readJSON(manifestFile(emptied)).description === 'kept', 'writing the manifest drops an empty "libraries"');
  const forms = ['../shared', '../../art/lib', '..', 'game', path.join(tmp, 'x'), 'lib/x', 'Game'].map((e) => { const k = libraryEntry(e); return 'path' in k ? 'path' : 'name' in k ? 'name' : 'error'; });
  check(forms.join() === 'path,path,path,name,error,error,error', `a workspace's entry is a path written from the workspace (./ or ../) or a registered name (${forms})`);
  const m = parseManifest({ name: 'studio/trees', uses: { 'b/b': '1.0', 'a/a': '2.3' } }, 'x');
  check(m.name === 'studio/trees' && Object.keys(m.uses).join() === 'a/a,b/b' && !('libraries' in m), 'name and uses (sorted) are read');
  const plain = parseManifest({}, 'x');
  check(plain.name === undefined && !Object.keys(plain.uses).length, 'none of them is needed');
  // plain folders named versions/ or packages/ are scanned outside a package; a package's own are never entered
  const lib = path.join(tmp, 'scanlib');
  writePackage(path.join(lib, 'p'), {}, {});
  writePackage(path.join(lib, 'p', 'versions', '1.0'), {}, {});
  writePackage(path.join(lib, 'versions', 'q'), {}, {});
  writePackage(path.join(lib, 'packages', 'r'), {}, {});
  check(scanLibrary({ name: 'scan', path: lib }).packages.map((p) => p.rel).join() === 'p,packages/r,versions/q', `a scan finds packages in plain folders of any name, and never enters a package (${scanLibrary({ name: 'scan', path: lib }).packages.map((p) => p.rel)})`);
}

// ------------------------------------------------------------------ publishing
section('publishing: the first version, what it holds, its hash');
{
  const r = await publish(ROCKS, 'first rocks');
  check(r.ok && r.version === '1.0' && !r.previous && /versions[\\/]1\.0$/.test(r.dir ?? ''), `the first version is 1.0: ${r.blocks.join('; ')}`);
  const v = path.join(ROCKS, 'versions', '1.0');
  const files = listing(v);
  check(files.join() === 'graphs/main.json,inputs/moss.png,inputs/rock.obj,rocks.topo,version.json', `a version holds rocks.topo, graphs/, assets/, inputs/ and version.json (${files})`);
  check(!files.some((f) => /exports|attachments|\.web|notes|scripts/.test(f)), 'and leaves exports/, attachments/, .web/, scripts and other files out');
  const pj = readJSON(path.join(v, 'rocks.topo'));
  check(pj.name === 'nordic/rocks' && !('libraries' in pj) && !('id' in pj), 'its rocks.topo is the package\'s');
  const info = readJSON(path.join(v, 'version.json'));
  const pkgVersion = readJSON(path.join(ROOT, 'package.json')).version;
  check(info.package === 'nordic/rocks' && info.version === '1.0' && info.note === 'first rocks' && info.big === false && !Number.isNaN(Date.parse(info.published)) && info.topotopo === pkgVersion,
    'version.json: package, version, note, published, big, TopoTopo version');
  check(JSON.stringify(info.outputs) === JSON.stringify({ boulder: { graph: 'main', node: 'mat', label: 'Boulder', kind: 'mesh', tags: [], sliders: { size: { type: 'float', default: 1, min: 0.1, max: 10, label: 'Size' } }, inputs: [] } })
    && info.default.graph === 'main' && info.default.node === 'mat' && info.default.kind === 'mesh', `version.json: each output's graph, node, kind, tags, sliders and inputs, and the default output (${JSON.stringify(info.outputs)})`);
  check(r.warnings.some((w) => /^output "boulder" \(graph "main"\) has no tags, which search finds an output by/.test(w)) && r.warnings.some((w) => /^output "boulder" \(graph "main"\) has no description/.test(w)),
    `an output without tags or a description warns: ${r.warnings.join(' | ')}`);
  // the hash: every file but version.json, sorted posix paths with each file's SHA-256
  const lines = files.filter((f) => f !== 'version.json').map((f) => `${sha(fs.readFileSync(path.join(v, ...f.split('/'))))}  ${f}\n`).join('');
  check(info.hash === sha(lines) && versionHash(v) === info.hash && r.hash === info.hash, 'the hash covers every file but version.json: sorted paths, each with its SHA-256');
  const again = await publish(ROCKS, 'again');
  check(!again.ok && again.blocks.join() === 'nothing changed since 1.0', `nothing changed: refused (${again.blocks})`);
  const noNote = await publish(ROCKS, '  ');
  check(!noNote.ok && noNote.blocks.some((b) => /a version needs a note/.test(b)), 'no note: refused');
}

section('hashes: text with LF line ends, binary files as they are');
{
  const v = path.join(ROCKS, 'versions', '1.0'), hash = readJSON(path.join(v, 'version.json')).hash;
  // a checkout with core.autocrlf: every text file gets CRLF line ends
  const crlf = path.join(tmp, 'crlf-checkout');
  fs.cpSync(v, crlf, { recursive: true });
  for (const f of ['rocks.topo', 'graphs/main.json', 'inputs/rock.obj']) {
    const p = path.join(crlf, ...f.split('/'));
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/\r?\n/g, '\r\n'));
  }
  check(fs.readFileSync(path.join(crlf, 'rocks.topo'), 'utf8').includes('\r\n') && versionHash(crlf) === hash, 'a checkout that turns LF into CRLF keeps the hash (topo, json, obj)');
  const t = (name: string, s: string | number[]) => textContent(name, typeof s === 'string' ? Buffer.from(s) : new Uint8Array(s)).length;
  check(t('a.json', 'a\r\nb\r\n') === 4 && t('a.csv', 'a\r\nb') === 3 && t('a.txt', 'a\rb') === 3, 'text: CRLF read as LF, a lone CR kept');
  check(t('a.png', 'a\r\nb') === 4 && t('a.glb', 'a\r\nb') === 4 && t('a.dat', [0, 13, 10]) === 3, 'binary: by its name, or a NUL byte in its first 8000 bytes, as it is');
  fs.writeFileSync(path.join(crlf, 'inputs', 'moss.png'), Buffer.concat([fs.readFileSync(path.join(crlf, 'inputs', 'moss.png')), Buffer.from('\r\n')]));
  check(versionHash(crlf) !== hash, 'a changed binary file changes the hash');
}

section('publishing: the version rule');
{
  const RULES = path.join(dirs.lib, 'rules');
  const g: any = {
    nodes: {
      base: { type: 'input', params: { index: 0, label: 'base' } },
      b: { type: 'box', params: { size: '=w' } },
      t: { type: 'transform', in: ['b'], params: { translate: ['=style == "a" ? 0 : 1', 0, 0] } },
      out: { type: 'merge', in: ['t', 'base'] },
    },
    output: 'out', vars: { w: 1, style: 'a' }, params: { w: { type: 'float', min: 0, max: 10 }, style: { type: 'enum', options: ['a', 'b'] } },
    outputs: { box: { node: 'out' } },
  };
  writePackage(RULES, { name: 'studio/rules' }, { main: g });
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
  const r11 = await step(() => { g.vars.w = 2; }, '1.1', /param "w" default 1 → 2/);
  check(r11.changes.join() === 'output "box": param "w" default 1 → 2', `a default output that is a named output is listed once: ${r11.changes}`);
  const r12 = await step(() => { g.outputs.lid = { node: 'b' }; }, '1.2', /output "lid" added/);
  check(JSON.stringify(Object.keys(readJSON(path.join(RULES, 'versions', '1.2', 'version.json')).outputs.lid.sliders)) === '["w"]'
    && r12.warnings.some((w) => /^output "lid" \(graph "main"\) does not read the var "style" of its graph: it is not one of its params/.test(w)),
    `an output's params are the vars its node reads; the others warn (${r12.warnings.filter((w) => /does not read/.test(w))})`);
  await step(() => { g.params.w.max = 20; }, '1.3', /range 0\.\.10 → 0\.\.20 \(wider\)/);
  await step(() => { g.params.w.min = 1; }, '2.0', /range 0\.\.20 → 1\.\.20 \(narrower\)/);
  await step(() => { g.params.style.options = ['a']; }, '3.0', /lost option "b"/);
  await step(() => { g.params.style.options = ['a', 'c']; }, '3.1', /gained option "c"/);
  await step(() => { g.outputs.lid.publish = false; }, '4.0', /output "lid" removed/);
  await step(() => { g.nodes.top = { type: 'input', params: { index: 1, label: 'top' } }; g.nodes.out.in.push('top'); }, '4.1', /input 1 \("top"\) added/);
  const r50 = await step(() => { g.nodes.base.params.index = 2; }, '5.0', /input "base" moved from 0 to 2/);
  check(!r50.changes.some((c) => /added/.test(c)), `a moved input is not also added: ${r50.changes}`);
  await step(() => { g.params.w.type = 'int'; }, '6.0', /param "w" is now int \(was float\)/);
  await step(() => { g.nodes.b.params.divisions = 2; }, '7.0', /the author marked it big/, true);
  await step(() => { g.nodes.b.params.divisions = 3; }, '7.1', null);
  // a version is never written over
  fs.mkdirSync(path.join(RULES, 'versions', '7.2'));
  g.nodes.b.params.divisions = 4;
  setGraph(RULES, 'main', g);
  const over = await publish(RULES, 'over');
  check(!over.ok && over.blocks.some((b) => /is there already, and a version is never written over: move that folder away/.test(b)) && over.version === undefined, `a version folder that is there is never written over: ${over.blocks}`);
  check(compareInterfaces({ outputs: {}, default: { graph: 'a', node: 'n', kind: 'mesh', tags: [], sliders: {}, inputs: [] } }, { outputs: {}, default: { graph: 'b', node: 'n', kind: 'mesh', tags: [], sliders: {}, inputs: [] } }).small.some((s) => /the default output now cooks/.test(s)),
    'a default output moved to another graph is a small change');
  check(['2.0', '7.0', '10.0'].every(startsBigVersion) && !['1.0', '1.1', '1.10', '2.20'].some(startsBigVersion), 'a version that starts a big version: 2.0 and 10.0, never 1.0 or 1.10');
}

section('publishing: blocks and warnings');
{
  const box: GraphSpec = { nodes: { b: { type: 'box' } }, output: 'b' };
  const at = (n: string) => path.join(dirs.lib, n);
  writePackage(at('noname'), {}, { main: box });
  writePackage(at('reserved'), { name: 'topotopo/thing' }, { main: box });
  writePackage(at('nocook'), { name: 'studio/nocook' }, { main: { nodes: { f: { type: 'file', params: { path: 'inputs/missing.obj' } } }, output: 'f', outputs: { mesh: { node: 'f' } } } });
  writePackage(at('clash'), { name: 'studio/clash' }, { main: { ...box, outputs: { same: { node: 'b' } } }, other: { ...box, outputs: { same: { node: 'b' } } } });
  writePackage(at('nodefault'), { name: 'studio/nodefault' }, { main: { nodes: { b: { type: 'box' } } } });
  writePackage(at('badname'), { name: 'studio/badname' }, { main: { ...box, outputs: { Big_Box: { node: 'b' } } } });
  const blocks = async (n: string) => (await publish(at(n), 'note')).blocks.join(' | ');
  const said = { noname: await blocks('noname'), reserved: await blocks('reserved'), nocook: await blocks('nocook'), clash: await blocks('clash'), nodefault: await blocks('nodefault'), badname: await blocks('badname') };
  check(/noname\.topo has no "name": the author names the package once, "name": "<owner>\/noname" \(topotopo init --name <owner>\/noname;/.test(said.noname), `no package name: ${said.noname}`);
  check(/the owner "topotopo" is reserved/.test(said.reserved), `the owner topotopo is reserved: ${said.reserved}`);
  fs.rmSync(at('reserved'), { recursive: true });
  check(/output "mesh" \(graph "main"\) does not cook: f: cannot read/.test(said.nocook), `an output that does not cook: ${said.nocook}`);
  check(/output "same" is published by graphs "main" and "other"/.test(said.clash), `an output name clash: ${said.clash}`);
  check(/no default output: set "output" in graphs\/main\.json/.test(said.nodefault), `no default output: ${said.nodefault}`);
  check(/output "Big_Box" \(graph "main"\) is not a package output name/.test(said.badname), `output names follow the id rule: ${said.badname}`);
  check(!exists(at('nocook'), 'versions') && !exists(at('clash'), 'versions'), 'a blocked publish writes nothing');
  // warnings: a URL, a file outside the package, the size
  const url = 'https://example.com/model.glb';
  writePackage(at('warns'), { name: 'studio/warns' }, { main: box, extra: { nodes: { u: { type: 'file', params: { path: url } }, o: { type: 'file', params: { file: '../outside.obj' } } } } });
  const w = await publish(at('warns'), 'warns\n  and a second line');
  check(w.ok && w.warnings.some((x) => x.includes(`graphs/extra.json: u reads ${url}: a version holds no copy of a URL`)) && w.warnings.some((x) => /o reads \.\.\/outside\.obj, outside the package folder/.test(x)),
    `unpinned URLs and files outside the package warn: ${w.warnings.join(' | ')}`);
  check(readJSON(path.join(at('warns'), 'versions', '1.0', 'version.json')).note === 'warns and a second line', 'a note is one line');
  writePackage(at('heavy'), { name: 'studio/heavy' }, { main: box }, { 'inputs/big.bin': new Uint8Array(51 * 2 ** 20) });
  const h = await publish(at('heavy'), 'heavy');
  check(h.ok && h.warnings.some((x) => /holds 51 MB \(above 50 MB\)/.test(x)), `a version above 50 MB warns: ${h.warnings.join(' | ')}`);
  fs.rmSync(at('heavy'), { recursive: true });
}

// ------------------------------------------------------------------ kinds, tags, descriptions
// studio/kinds: an output of every kind, in one graph; its default output is the mesh
const KINDS_DIR = path.join(dirs.lib, 'kinds');
const kindsGraph: any = {
  description: 'One output of every kind. The default output is the mesh.',
  nodes: {
    b: { type: 'box' },
    c: { type: 'line' },
    g: { type: 'grid' },
    pts: { type: 'scatter', in: ['g'], params: { count: 20 } },
    few: { type: 'scatter', in: ['g'], params: { count: 5 } },
    packed: { type: 'copy_to_points', in: ['b', 'few'], params: { pack: true } },
    hf: { type: 'heightfield', params: { size: 8, resolution: 1 } },
    land: { type: 'heightfield_noise', in: ['hf'] },
    tex: { type: 'tex_noise', params: { resolution: 8 } },
    sdf: { type: 'sdf_shape' },
    street: { type: 'merge', in: ['land', 'packed'] },
  },
  output: 'b',
  outputs: {
    mesh: { node: 'b' }, curves: { node: 'c' }, points: { node: 'pts' }, instances: { node: 'packed' }, terrain: { node: 'land' },
    textures: { node: 'tex' }, volume: { node: 'sdf' }, scene: { node: 'street' },
  },
};
writePackage(KINDS_DIR, { name: 'studio/kinds', tags: ['showcase'], description: 'A sampler: every kind of output' }, { main: kindsGraph });

section('kinds: publishing records what each output cooks to; an output that cooks to nothing blocks');
{
  const r = await publish(KINDS_DIR, 'every kind');
  const info = readJSON(path.join(KINDS_DIR, 'versions', '1.0', 'version.json'));
  const kinds = Object.fromEntries(Object.entries<any>(info.outputs).map(([k, o]) => [k, o.kind]));
  check(r.ok && Object.entries(kinds).every(([k, v]) => k === v) && Object.keys(kinds).length === 8, `each output's kind: heightfield → terrain, image → textures, several → scene, the others as named (${JSON.stringify(kinds)}; ${r.blocks.join('; ')})`);
  check(info.default.kind === 'mesh' && info.outputs.mesh.description === kindsGraph.description && info.default.description === kindsGraph.description,
    'the default output records its kind; a description falls back to the graph\'s');
  check(Object.keys(r.outputs ?? {}).length === 8 && r.outputs!.scene.kind === 'scene', 'the result has the records too');
  const EMPTY = path.join(dirs.lib, 'empty');
  writePackage(EMPTY, { name: 'studio/empty' }, { main: { nodes: { b: { type: 'box' }, d: { type: 'delete', in: ['b'], params: { group: '*' } } }, output: 'd', outputs: { nothing: { node: 'd' } } } });
  const e = await publish(EMPTY, 'nothing');
  check(!e.ok && e.blocks.some((b) => /^output "nothing" \(graph "main"\) cooks to nothing/.test(b)) && !exists(EMPTY, 'versions'), `an output that cooks to nothing blocks: ${e.blocks.join(' | ')}`);
  check(e.blocks.length === 1, 'the default output, which is that output, is said once');
}

section('a pinned kind: publishing blocks on another kind, build warns, a kind not on the list is an error');
{
  const PINNED = path.join(dirs.lib, 'pinned');
  const scatter = (kind: string): GraphSpec => ({
    nodes: { b: { type: 'box' }, g: { type: 'grid' }, s: { type: 'scatter', in: ['g'], params: { count: 5 } }, trees: { type: 'copy_to_points', in: ['b', 's'], params: { pack: true } } },
    output: 'b', outputs: { trees: { node: 'trees', kind: kind as any, tags: ['forest'] }, block: { node: 'b', kind: 'mesh', tags: ['block'] } },
  });
  writePackage(PINNED, { name: 'studio/pinned' }, { main: scatter('mesh') });
  const p = await publish(PINNED, 'pinned');
  check(!p.ok && p.blocks.length === 1 && /^output "trees" \(graph "main"\): its "kind" is "mesh", and it cooks to instances \(5 instances of 1 source\): change what it cooks, or its "kind"/.test(p.blocks[0]) && !exists(PINNED, 'versions'),
    `publishing blocks an output that is not the kind its author pinned: ${p.blocks.join(' | ')}`);
  // build in a package on the package warns before that, for the output it cooks and for another
  const o = await open(PINNED);
  const tools = makeTools(o.ws), build = tools.find((t) => t.name === 'build')!;
  const said = (await build.run({ graph: scatter('mesh') })).content.map((c: any) => c.text ?? '').join('\n');
  check(/✓ graph "main"/.test(said) && /\n {2}\[output "trees"\] its "kind" is "mesh", and it cooks to instances \(5 instances of 1 source\)/.test(said) && !/\[output "block"\]/.test(said),
    `build warns about a pinned kind the output does not cook to:\n${said.split('\n').filter((l) => /warnings|output "/.test(l)).join('\n')}`);
  const target = (await build.run({ graph: { ...scatter('mesh'), output: 'trees' } })).content.map((c: any) => c.text ?? '').join('\n');
  check(/\[output "trees"\] its "kind" is "mesh"/.test(target), 'and when that output is the one it cooks');
  check(!/\[output "/.test((await build.run({ graph: scatter('instances') })).content.map((c: any) => c.text ?? '').join('\n')), 'no warning when the kinds match');
  const ok = await publish(PINNED, 'pinned right');
  check(ok.ok && readJSON(path.join(PINNED, 'versions', '1.0', 'version.json')).outputs.trees.kind === 'instances', 'with the kind it cooks to it publishes');
  // a kind not on the list: an error wherever the graph is read, with the list in the hint
  const v = o.engine.validate({ nodes: { b: { type: 'box' } }, outputs: { brick: { node: 'b', kind: 'level' as any } } });
  check(v.errors.length === 1 && v.errors[0].message === 'named output "brick": "kind" "level" is not a kind' && /mesh, instances, points, curves, terrain, textures, material, volume, scene/.test(v.errors[0].hint ?? ''),
    `validate: ${v.errors.map((x) => `${x.message} (${x.hint})`).join('; ')}`);
  const cooked = await o.engine.cook({ nodes: { b: { type: 'box' } }, outputs: { brick: { node: 'b', kind: 'Mesh' as any } } });
  check(!cooked.ok && /"kind" "Mesh" is not a kind/.test(errorOf(cooked)), 'a cook of it fails the same way');
  setGraph(PINNED, 'main', { ...scatter('instances'), outputs: { ...scatter('instances').outputs, block: { node: 'b', kind: 'level' as any } } });
  const bad = await publish(PINNED, 'material');
  check(!bad.ok && bad.blocks.some((b) => /^output "block" \(graph "main"\): "kind" "level" is not a kind \(the kinds: mesh, instances/.test(b)), `publishing blocks it: ${bad.blocks.join(' | ')}`);
}

section('tags and descriptions: the rule, recorded, searched; the version rule for kinds');
{
  const e = await newEngine(tmp);
  const errs = (tags: unknown) => e.validate({ nodes: { b: { type: 'box' } }, outputs: { o: { node: 'b', tags: tags as any } } }).errors;
  check(!errs(['conifer', 'low-poly', '3d']).length, 'lower-case letters, digits and -');
  const bad = errs(['Low Poly', '-x', 'ok', 'ok']);
  check(bad.length === 3 && bad[0].message === 'named output "o": tag "Low Poly" is malformed' && /lower-case letters, digits and -, starting with a letter or digit/.test(bad[0].hint ?? '') && /tag "-x" is malformed/.test(bad[1].message) && /tag "ok" given twice/.test(bad[2].message),
    `malformed and repeated tags are errors, with the rule in the hint: ${bad.map((x) => x.message).join('; ')}`);
  check(/17 tags, more than 16/.test(errs(Array.from({ length: 17 }, (_, i) => `t${i}`))[0]?.message ?? '') && /"tags" must be a list of words/.test(errs('conifer')[0]?.message ?? '') && errs([`a${'b'.repeat(64)}`]).length === 1,
    'at most 16 tags of at most 64 characters; tags are a list');
  check(/"description" must be a string/.test(e.validate({ nodes: { b: { type: 'box' } }, outputs: { o: { node: 'b', description: 3 as any } } }).errors[0]?.message ?? ''), 'a description is a string');
  const TAGGED = path.join(dirs.lib, 'tagged');
  writePackage(TAGGED, { name: 'studio/tagged' }, { main: { nodes: { b: { type: 'box' } }, output: 'b', outputs: { b: { node: 'b', tags: ['Bad Tag'] } } } });
  const blocked = await publish(TAGGED, 'bad');
  check(!blocked.ok && blocked.blocks.some((b) => /^output "b" \(graph "main"\): tag "Bad Tag" is malformed \(a tag is lower-case letters/.test(b)), `a malformed tag blocks publishing: ${blocked.blocks.join(' | ')}`);

  // studio/kinds 1.1: tags, a description and the kind it has pinned, all small
  kindsGraph.outputs.mesh = { node: 'b', kind: 'mesh', tags: ['block', 'box'], description: 'A unit box.' };
  kindsGraph.outputs.curves.tags = ['wire'];
  setGraph(KINDS_DIR, 'main', kindsGraph);
  const r11 = await publish(KINDS_DIR, 'tags');
  const v11 = readJSON(path.join(KINDS_DIR, 'versions', '1.1', 'version.json'));
  check(r11.ok && r11.version === '1.1' && !r11.bigBecause.length && r11.changes.includes('output "mesh": tags added block, box') && r11.changes.includes('output "mesh": description changed') && r11.changes.includes('output "curves": tag added wire'),
    `tags, a description and pinning the kind it has are small: ${r11.version} ${r11.changes.join('; ')}`);
  check(JSON.stringify(v11.outputs.mesh.tags) === '["block","box"]' && v11.outputs.mesh.description === 'A unit box.' && v11.default.description === 'A unit box.' && JSON.stringify(v11.default.tags) === '["block","box"]',
    'version.json records tags and descriptions; the default output has those of the named output it is');
  check(!r11.warnings.some((w) => /output "mesh".*no tags/.test(w)) && r11.warnings.some((w) => /^output "volume" \(graph "main"\) has no tags/.test(w)) && !r11.warnings.some((w) => /has no description/.test(w)),
    'the warnings name the outputs still without tags (the graph describes them all)');
  // 2.0: "points" now cooks to instances, which makes the version big
  kindsGraph.outputs.points = { node: 'packed' };
  setGraph(KINDS_DIR, 'main', kindsGraph);
  const r20 = await publish(KINDS_DIR, 'points are instances now');
  check(r20.ok && r20.version === '2.0' && r20.bigBecause.join() === 'output "points": kind points → instances' && r20.warnings.some((w) => /^output "points" \(graph "main"\) is now instances \(it was points in 1\.1\): a package that relies on what it is may have to change, and the version is big$/.test(w)),
    `an output of another kind makes the version big, and warns: ${r20.version} ${r20.bigBecause.join('; ')}`);
  // 2.1: the pin removed, the kind the same
  kindsGraph.outputs.mesh = { node: 'b', tags: ['block', 'box'], description: 'A unit box.' };
  setGraph(KINDS_DIR, 'main', kindsGraph);
  const r21 = await publish(KINDS_DIR, 'unpinned');
  check(r21.ok && r21.version === '2.1' && !r21.bigBecause.length, `a pinned kind removed without a change of kind is small: ${r21.version} ${r21.bigBecause.join('; ')}`);
  // a version record names every output's kind and tags
  const vdir = path.join(KINDS_DIR, 'versions', '2.1'), record = readJSON(path.join(vdir, 'version.json'));
  delete record.outputs.mesh.kind;
  fs.writeFileSync(path.join(vdir, 'version.json'), JSON.stringify(record));
  check(publishedVersions(KINDS_DIR, 'studio/kinds').map((v) => v.version).join() === '1.0,1.1,2.0', 'a version.json whose output has no kind is not a version record');
  delete record.outputs.mesh.tags;
  record.outputs.mesh.kind = 'mesh';
  fs.writeFileSync(path.join(vdir, 'version.json'), JSON.stringify(record));
  check(publishedVersions(KINDS_DIR, 'studio/kinds').length === 3, 'nor one without tags');
  record.outputs.mesh.tags = ['block', 'box'];
  fs.writeFileSync(path.join(vdir, 'version.json'), JSON.stringify(record, null, 2) + '\n');
}

section('a dry run: what publishing would do, and nothing written');
{
  kindsGraph.outputs.textures.tags = ['noise'];
  setGraph(KINDS_DIR, 'main', kindsGraph);
  const before = listing(KINDS_DIR);
  const o = await open(KINDS_DIR);
  const d = await publishPackage(o.pk, { dryRun: true });
  check(d.dryRun && d.ok && d.version === '2.2' && d.previous === '2.1' && d.changes.includes('output "textures": tag added noise') && d.warnings.some((w) => /^output "scene" \(graph "main"\) has no tags/.test(w)) && !d.blocks.length,
    `the version number it would get, its changes and warnings (${d.version}: ${d.changes.join('; ')})`);
  const text = publishText(d);
  check(/^✓ would publish studio\/kinds 2\.2 \(small, after 2\.1\); publishing it needs a note, one line on what changed/.test(text) && /\noutputs:\n {2}curves {2}curves \[wire\]\n/.test(text) && /\na dry run: nothing was written$/.test(text),
    `it says so, and that the note is still to write:\n${text.split('\n').slice(0, 3).join('\n')}`);
  check(JSON.stringify(listing(KINDS_DIR)) === JSON.stringify(before), 'nothing is written');
  kindsGraph.outputs.scene.kind = 'terrain';
  setGraph(KINDS_DIR, 'main', kindsGraph);
  const b = await publishPackage(o.pk, { dryRun: true, note: 'scene' });
  check(b.dryRun && !b.ok && b.version === undefined && b.blocks.length === 1 && /^output "scene" \(graph "main"\): its "kind" is "terrain", and it cooks to scene/.test(b.blocks[0])
    && /^✗ would not publish studio\/kinds — 1 problem:\n {2}output "scene"/.test(publishText(b)), `a block, and no version number: ${publishText(b).split('\n').slice(0, 2).join(' | ')}`);
  const noVersion = listing(KINDS_DIR).filter((f) => f.startsWith('versions/2.2'));
  check(!noVersion.length, 'still nothing written');
  delete kindsGraph.outputs.scene.kind;
  setGraph(KINDS_DIR, 'main', kindsGraph);
}

section('outputs of the same package: by full name, the same version, no entry in uses; a loop does not resolve');
{
  // studio/blocks: a brick; a wall of the package's own bricks; the shown graph builds on the wall directly, in a foreach
  // body and through an asset of the package (a pier of one brick)
  // partlib: a library known by its library.json alone (not registered): a package inside it finds its siblings there
  const PARTLIB = path.join(tmp, 'partlib'), BLOCKS = path.join(PARTLIB, 'blocks');
  json(path.join(PARTLIB, 'library.json'), { name: 'partlib' });
  const brick = (h: number): GraphSpec => ({ nodes: { b: { type: 'box', params: { size: ['=w', h, 0.5] } } }, output: 'b', vars: { w: 1 }, params: { w: { type: 'float', min: 0.1, max: 4 } }, outputs: { brick: { node: 'b', label: 'Brick' } } });
  writePackage(BLOCKS, { name: 'studio/blocks' }, {
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
  // in the package that publishes versions: its own graphs as they are now
  const k = await open(BLOCKS);
  const wall = await k.engine.cook({ nodes: { w: { type: 'studio/blocks/wall' } } });
  const def = k.engine.resolveDef('studio/blocks/wall');
  check(wall.ok && size(wall, 0) === 3 && def?.package?.version === null && /studio\/blocks \(working folder\)/.test(def.summary), `the package itself cooks its outputs from its graphs (width ${size(wall, 0)}; ${def?.summary ?? errorOf(wall)})`);
  check(['studio/blocks', 'studio/blocks/brick', 'studio/blocks/wall'].every((n) => k.engine.packageDefs().some((d) => d.type === n)), 'its catalog lists its own outputs');
  check(/this package is studio\/blocks: its graphs name its own outputs by full name, with no entry in "uses"/.test(errorText(() => k.pk.use('studio/blocks'))), 'it does not use itself');
  setGraph(BLOCKS, 'brick', brick(0.8));
  check(k.pk.refresh() && top(await k.engine.cook({ nodes: { w: { type: 'studio/blocks/wall' } } })) === 0.4, 'a change to its graphs: refresh sees it and the wall has the new bricks');
  const p = await publish(BLOCKS, 'first blocks');
  check(p.ok && p.version === '1.0', `publishing cooks the wall from the package's own brick: ${p.blocks.join('; ')}`);
  const info = readJSON(path.join(BLOCKS, 'versions', '1.0', 'version.json'));
  check(Object.keys(info.outputs).join() === 'brick,wall' && !('uses' in readJSON(path.join(BLOCKS, 'versions', '1.0', 'blocks.topo'))) && !exists(BLOCKS, 'versions', '1.0', 'packages'),
    'the version publishes both, and names no package of its own in its uses');
  // a package that uses it: the version's outputs name each other within that version
  const USER = path.join(PARTLIB, 'blocks-user');
  writePackage(USER, {}, {});
  const u = await open(USER);
  const scene: GraphSpec = { nodes: { k: { type: 'studio/blocks', params: {} } }, output: 'k' };
  const firstUse = u.pk.addFor(scene);
  check(firstUse.length === 1 && JSON.stringify(readManifest(USER).uses) === '{"studio/blocks":"1.0"}' && Object.keys(readLock(USER).packages).join() === 'studio/blocks',
    'first use adds the package once: uses and the lock name nothing else');
  check(/from library "partlib"/.test(firstUse[0]) && readLock(USER).packages['studio/blocks']['1.0'].library === '..' && u.pk.libraries().libs[0].from === 'self',
    `a package inside a library (its library.json) finds its sibling there, and the lock names the place by its path from the package (${firstUse[0]}; ${readLock(USER).packages['studio/blocks']['1.0'].library})`);
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
  const LOOPS = path.join(PARTLIB, 'loops');
  writePackage(LOOPS, { name: 'studio/loops' }, {
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

  // studio/warnlib: a piece that warns, and a line-up of two pieces: the warning is said once, under the piece
  defineNode({
    type: 'test_pkg_warn', category: 'generate', summary: 'test only: a box that warns', inputs: [], params: {},
    cook: async (ctx) => { ctx.warn('mind the gap'); const b = new GeoBuilder(); b.addPoint(0, 0, 0); b.addPoint(1, 1, 1); return b.build(); },
  });
  const WARNLIB = path.join(PARTLIB, 'warnlib');
  writePackage(WARNLIB, { name: 'studio/warnlib' }, {
    piece: { description: 'A piece.', nodes: { w: { type: 'test_pkg_warn' } }, output: 'w', outputs: { piece: { node: 'w', kind: 'points', tags: ['piece'] } } },
    main: { description: 'Two pieces.', nodes: { a: { type: 'studio/warnlib/piece' }, b: { type: 'studio/warnlib/piece' }, m: { type: 'merge', in: ['a', 'b'] } }, output: 'm', outputs: { lineup: { node: 'm', kind: 'points', tags: ['pieces'] } } },
  });
  const wk = await publishPackage(openPackages(await newEngine(WARNLIB), WARNLIB), { dryRun: true });
  const gap = wk.warnings.filter((w) => /mind the gap/.test(w));
  check(wk.ok && gap.length === 1 && /^output "piece" \(graph "piece"\): \[w\] mind the gap$/.test(gap[0]), `a piece's warning is said once, under the piece, not again under the line-up that cooks it (${gap.join(' | ')})`);
}

// ------------------------------------------------------------------ first use, use, copies and the lock
section('first use in a package: studio/trees uses nordic/rocks');
{
  const o = await open(TREES);
  const notes = o.pk.addFor(treesMain);
  check(notes.length === 1 && /^added nordic\/rocks 1\.0 to package trees from library "lib": packages\/nordic\/rocks\/1\.0$/.test(notes[0]), `the graph names it: added on first use from another registered library (${notes})`);
  check(JSON.stringify(readManifest(TREES).uses) === '{"nordic/rocks":"1.0"}', 'the manifest\'s "uses" names the version');
  const lock = readLock(TREES);
  check(JSON.stringify(lock.packages['nordic/rocks']['1.0']) === JSON.stringify({ hash: readJSON(path.join(ROCKS, 'versions', '1.0', 'version.json')).hash, library: 'lib', uses: {} }),
    'the lock: the copy\'s hash, the registered library it came from, its own uses');
  check(shown(path.join(TREES, 'packages')).join() === 'lock.json,nordic/rocks/1.0/graphs/main.json,nordic/rocks/1.0/inputs/moss.png,nordic/rocks/1.0/inputs/rock.obj,nordic/rocks/1.0/rocks.topo,nordic/rocks/1.0/version.json',
    'the copy holds the version');
  check(o.pk.addFor(treesMain).length === 0, 'a package in uses is not added again');
  const r = await o.engine.cook(treesMain);
  check(r.ok && size(r, 0) === 2, `the package's graph cooks with the copy: ${errorOf(r)}`);
  check(!o.pk.check().length, 'its copy checks');
  const cache = fs.existsSync(path.join(TREES, 'packages', '.cache.json')) ? readJSON(path.join(TREES, 'packages', '.cache.json')) : {};
  check(cache.format === 1 && /^\d+:[\d.]+ [0-9a-f]{64}$/.test(cache.files?.['packages/nordic/rocks/1.0/inputs/rock.obj'] ?? ''),
    'the hashes of the copy\'s files are kept by size and time in packages/.cache.json, for the next process');
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
  check(r.version === '1.0' && /^added studio\/trees 1\.0 to package grove from library "game", with nordic\/rocks 1\.0/.test(r.text), `use copies the newest version and what it uses: ${r.text}`);
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

section('a package that uses packages: first use, two versions side by side');
{
  // the forest has its own bark asset, crown graph and inputs/rock.obj: none may reach the packages
  writePackage(dirs.forest, { name: 'studio/forest' }, { crown: crown(5) }, {
    'assets/bark.json': JSON.stringify({ nodes: { b: { type: 'box', params: { size: [9, 9, 9] } } }, output: 'b' }),
    'inputs/rock.obj': triangle(5),
  });
  const o = await open(dirs.forest);
  const graph: GraphSpec = { nodes: { pine: { type: 'studio/trees/pine', params: { height: 6 } }, grove: { type: 'studio/grove' }, out: { type: 'merge', in: ['pine', 'grove'] } }, output: 'out' };
  o.ws.setGraph('main', { nodes: { b: { type: 'box' } }, output: 'b' });
  const ed = await o.ws.edit('main', [{ op: 'replace', node: 'b', spec: { type: 'studio/trees/pine', params: { height: 6 } } }, { op: 'add', node: 'grove', type: 'studio/grove' }, { op: 'add', node: 'out', type: 'merge', in: ['b', 'grove'] }, { op: 'output', node: 'out' }]);
  check(ed.report.ok && ed.notes.some((n) => /^added studio\/trees 1\.1 to package forest from library "game"/.test(n)) && ed.notes.some((n) => /^added studio\/grove 1\.0 .*, with studio\/trees 1\.0: packages\/studio\/grove\/1\.0$/.test(n)),
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
  check(size(one, 0) !== 9 && size(one, 0) !== 10, 'the package reads its own bark asset and crown graph, not the package\'s');
  const own = await o.engine.cook({ nodes: { b: { type: 'bark' } } });
  check(size(own, 0) === 9, 'the package\'s bark is its own');
  const hidden = await o.engine.cook({ nodes: { b: { type: 'nordic/rocks/boulder' } } });
  check(!hidden.ok && /package nordic\/rocks is not in this package's uses/.test(errorOf(hidden)), `a package another package uses is not the package's: ${errorOf(hidden)}`);
  const added = o.pk.use('nordic/rocks');
  check(/^added nordic\/rocks 1\.0 to package forest from library/.test(added.text) && !added.copied.length, `use of a version the package holds already copies nothing: ${added.text}`);
  check(readLock(dirs.forest).packages['nordic/rocks']['1.0'].library === 'game', 'the lock keeps the library the copy came from (inside studio/trees, from "game")');
  const rock = await o.engine.cook({ nodes: { b: { type: 'nordic/rocks/boulder' } } });
  const tex = rock.geo ? readMaterials(rock.geo).moss?.textures?.baseColor : undefined;
  check(size(rock, 0) === 2, `files are read from the version's folder: the rock is 2 wide, not the package's 5 (${size(rock, 0)})`);
  check(tex === 'packages/nordic/rocks/1.0/inputs/moss.png' && fs.existsSync(path.join(dirs.forest, tex)), `texture paths name the version's files, relative to the package: ${tex}`);
  const inPine = one.geo ? readMaterials(one.geo).moss?.textures?.baseColor : undefined;
  check(inPine === tex, `also through a package that uses it (${inPine})`);
  // the catalog and help
  const names = o.engine.packageDefs().map((d) => d.type);
  check(['studio/trees', 'studio/trees/pine', 'studio/grove', 'nordic/rocks/boulder'].every((n) => names.includes(n)) && !names.includes('studio/trees/preview'), `the catalog lists the outputs of the packages in use: ${names}`);
  const pine = o.engine.resolveDef('studio/trees/pine')!;
  check(pine.category === 'package' && pine.package?.version === '1.1' && /studio\/trees 1\.1: bigger crown/.test(pine.description ?? '') && pine.params.height.max === 20 && pine.inputs[0].desc === 'ground',
    'a package output\'s node type: its version and note, sliders and inputs');
  const listed = packagesText(o.pk);
  check(/\nuses 3 packages: 3 up to date\n {2}nordic\/rocks 1\.0 {2}1 output {2}up to date\n {2}studio\/grove 1\.0 {2}1 output {2}up to date\n {2}studio\/trees 1\.1 {2}1 output {2}up to date\n {2}and, used by those: studio\/trees 1\.0\n/.test(listed)
    && /\nin the places it looks in, not used yet \(\d+\):\n/.test(listed) && /\n {2}studio\/rules 7\.1 +\d+ outputs? {2}\[library "lib"\]/.test(listed) && /\n {2}studio\/badname +no version published yet {2}\[library "lib"\]/.test(listed)
    && /\nlooks in: library "game" \(.*\), library "lib" \(.*\), library "other" \(.*\), TopoTopo's built-in library; outside a workspace every registered library counts\n/.test(listed),
    `packages lists what the package uses, one line each, the others the places give, and the places (outside a workspace: every registered library):\n${listed}`);
}

section('errors: unknown outputs, packages no place has, a library the workspace does not list, a manifest that still lists libraries');
{
  const o = await open(dirs.forest);
  const pin = await o.engine.cook({ nodes: { t: { type: 'studio/trees/pin' } } });
  check(/studio\/trees 1\.1 has no output "pin" — did you mean pine\? \(hint: its outputs: pine; "studio\/trees" alone is its default output\)/.test(errorOf(pin)), `an unknown output lists the package's outputs: ${errorOf(pin)}`);
  const oaks: GraphSpec = { nodes: { t: { type: 'studio/oaks/oak' } } };
  check(!o.pk.addFor(oaks).length, 'a package no place has is not added');
  const r = await o.engine.cook(oaks);
  check(/package studio\/oaks is not in this package's uses \(forest\.topo\), and it could not be added: no place this package looks in has a package studio\/oaks.*: outside a workspace it looks in library "game" \(.*\), library "lib" \(.*\), library "other" \(.*\), TopoTopo's built-in library/.test(errorOf(r)) && !/use studio\/oaks/.test(errorOf(r)),
    `why, and no hint to add what cannot be added: ${errorOf(r)}`);
  check(/did you mean studio\/trees/.test(errorText(() => o.pk.use('studio/tres'))), 'did-you-mean over the packages the places give');
  check(/this package is studio\/forest/.test(errorText(() => o.pk.use('studio/forest'))), 'a package does not use its own package');
  check(/TopoTopo's built-in library, which alone holds the packages named "topotopo\/…", has no package topotopo\/nope/.test(errorText(() => o.pk.use('topotopo/nope'))), 'a "topotopo/…" name is looked for in the built-in library alone');
  // in the workspace: a package only in a registered library the workspace does not list names the command that lists it
  const y = await open(YARD);
  const notListed = errorText(() => y.pk.use('studio/trees'));
  const was = process.cwd();
  process.chdir(dirs.valley);
  const fromInside = errorText(() => y.pk.use('studio/trees'));
  process.chdir(was);
  check(/^studio\/trees is in library "game" \(.*\), which the workspace "valley" does not list: topotopo workspace library add game --workspace \S*valley lists it \(MCP: workspace \{action:"libraries", add:"game"\}, when the person says so\)/.test(notListed)
    && /which the workspace "valley" does not list: topotopo workspace library add game lists it \(MCP:/.test(fromInside),
    `a package only in a library the workspace does not list: the command that lists it, with --workspace when the current folder is outside the workspace (${notListed}; ${fromInside})`);
  check(/no place this package looks in has a package studio\/oaks .*: it looks in the workspace "valley" \(.*\), library "lib" \(.*\), TopoTopo's built-in library/.test(errorText(() => y.pk.use('studio/oaks'))), 'and one no place has names the places, in order');
  // a manifest that still lists libraries: the package's uses cannot be read, and the error says where each entry goes
  const lonely = path.join(tmp, 'lonely');
  writePackage(lonely, {}, {});
  editManifest(lonely, (m) => { m.libraries = ['nowhere', '../lib']; });
  const lo = await open(lonely);
  const listedLibs = errorText(() => lo.pk.use('studio/trees'));
  check(/lonely\.topo: "libraries" is gone from the package manifest: outside a workspace every registered library counts \(topotopo library add nowhere <its folder>; "\.\.\/lib" is the registered library "lib", which counts already\); remove "libraries"$/.test(listedLibs),
    `a manifest with "libraries" outside a workspace is refused: an entry registered counts already, another is registered (${listedLibs})`);
  editManifest(lonely, (m) => { delete m.libraries; });
  // in a workspace: each entry, its paths read from the package, is listed by the workspace (from outside it, with
  // --workspace); one inside the workspace needs nothing
  const OLD = path.join(dirs.valley, 'levels', 'oldlibs');
  writePackage(OLD, { libraries: ['../../../lib', '../../assets', '../../../vendor-props'] }, {});
  const inWs = errorText(() => readManifest(OLD));
  const vendor = path.join(tmp, 'vendor-props');
  check(inWs.includes(`the workspace lists the shared libraries its packages use (topotopo workspace library add lib --workspace `) && /"\.\.\/\.\.\/assets" \(.*assets\) is inside the workspace, whose packages are found by themselves: nothing to list; /.test(inWs)
    && inWs.includes(`topotopo workspace library add ${vendor} --workspace `) && /; remove "libraries"$/.test(inWs),
    `a manifest with "libraries" in a workspace says the command that lists each entry, its folder read from the package (${inWs})`);
  fs.rmSync(OLD, { recursive: true });
  forgetScans();
  // no registered library: said
  const cfg = process.env.TOPOTOPO_CONFIG!;
  process.env.TOPOTOPO_CONFIG = path.join(tmp, 'no-config.json');
  try {
    const lo2 = await open(lonely);
    check(/^no library has a package nordic\/rocks: this package is in no workspace, so it looks in every registered library, and none is registered \(topotopo library add <name> <folder> registers one\); TopoTopo's built-in library holds TopoTopo's own packages alone/.test(errorText(() => lo2.pk.use('nordic/rocks'))),
      'outside a workspace with no library registered, it says how to register one');
  } finally { process.env.TOPOTOPO_CONFIG = cfg; }
  // the workspace's "libraries": an entry that does not work leaves the others working, and the listings say why
  json(path.join(dirs.valley, 'topotopo-workspace.json'), { name: 'valley', libraries: ['../valley-typo', 'nowhere', '../lib/rocks', './assets', 'topotopo', 'lib'] });
  const both = librariesFor(YARD);
  check(both.libs.map((l) => `${l.name}:${l.from}`).join() === 'valley:self,lib:listed' && both.problems.length === 4 && /"\.\.\/valley-typo" is no folder/.test(both.problems[0])
    && /"nowhere" is not registered on this machine \(.*has game, lib, other\): topotopo library add nowhere <folder> registers it/.test(both.problems[1])
    && /"\.\.\/lib\/rocks" is a package's folder \(rocks\.topo\), not a library/.test(both.problems[2])
    && /"\.\/assets" is inside the workspace \(.*\): its packages are found by themselves; remove it from "libraries"/.test(both.problems[3]),
    `each entry that does not work says why (a typo, a name not registered, a package's folder, a folder inside the workspace; "topotopo" changes nothing), and the others still count (${both.problems.join(' | ')})`);
  const y2 = await open(YARD);
  check(/^added nordic\/rocks 1\.0 to workspace "valley"/.test(y2.pk.use('nordic/rocks').text) && /\ncould not check 4:\n {2}.*topotopo-workspace\.json "libraries": /.test(packagesText(y2.pk)),
    'use and packages work with the others, and say "could not check" for the rest');
  json(path.join(dirs.valley, 'topotopo-workspace.json'), { ...readJSON(path.join(dirs.valley, 'topotopo-workspace.json')), libraries: ['lib'] });
  // an unreadable workspace file: a problem naming it, and only the built-in library is looked in
  const wsFile = path.join(dirs.valley, 'topotopo-workspace.json'), kept = fs.readFileSync(wsFile);
  fs.writeFileSync(wsFile, '{ not json');
  const bad = librariesFor(YARD);
  check(!bad.libs.length && /topotopo-workspace\.json: .*; until it is fixed, packages are found in TopoTopo's built-in library only$/.test(bad.problems[0] ?? ''), `an unreadable workspace file: only the built-in library (${bad.problems[0]})`);
  fs.writeFileSync(wsFile, kept);
  // outside any package
  const loose = path.join(tmp, 'loose');
  fs.mkdirSync(loose);
  const lp = await open(loose);
  const out = await lp.engine.cook({ nodes: { t: { type: 'studio/trees/pine' } } });
  check(!lp.pk.dir && /this graph is in no package, and only packages use packages \(hint: topotopo init/.test(errorOf(out)), `outside a package: ${errorOf(out)}`);
  check(/topotopo init/.test(errorText(() => lp.pk.use('studio/trees'))), 'use outside a package says how to make one');
}

section('dry runs: a package a graph names for the first time is checked against the version its first use adds, and nothing is written');
{
  const DRY = path.join(tmp, 'dry');
  writePackage(DRY, {}, {});
  const o = await open(DRY);
  const before = listing(DRY);
  const dry = (g: GraphSpec) => { const s = o.ws.dryScope(g); const d = o.engine.dryRun(g, undefined, s.scope); return { ...d, said: d.errors.map((e) => e.message + (e.hint ? ` (hint: ${e.hint})` : '')).join('; '), first: s.notes }; };
  const graph: GraphSpec = { nodes: { t: { type: 'studio/trees/pine', params: { height: 3 } }, g: { type: 'studio/grove' }, c: { type: 'topotopo/props/crate' }, out: { type: 'merge', in: ['t', 'g', 'c'] } }, output: 'out' };
  const d = dry(graph);
  check(!d.errors.length && d.output === 'out', `the graph checks against the versions a build would add: ${d.said}`);
  check(d.first.length === 3 && d.first.includes('build or edit adds studio/trees 1.1 to package dry on first use, from library "game": this dry run read it there and copied nothing')
    && d.first.some((n) => /^build or edit adds studio\/grove 1\.0 to package dry on first use, from library "game"/.test(n))
    && d.first.some((n) => n.startsWith(`build or edit adds topotopo/props ${builtinVersions('topotopo/props').at(-1)!.version} to package dry on first use, from TopoTopo's built-in library`)),
    `a note names each package and the version a build adds, from the place that has it: ${d.first.join(' | ')}`);
  check(listing(DRY).join() === before.join() && !exists(DRY, 'packages') && JSON.stringify(readManifest(DRY).uses) === '{}', 'nothing is copied or written: no packages/, the manifest as it was');
  check(!o.engine.resolveDef('studio/trees/pine') && /package studio\/trees is not in this package's uses/.test(o.engine.packageIssue('studio/trees/pine').error), 'and the package\'s own packages are as they were');
  // checked against that version, as a build checks it
  check(/studio\/trees 1\.1 has no output "pin" — did you mean pine\?/.test(dry({ nodes: { t: { type: 'studio/trees/pin' } } }).said), 'an output the version does not have is an error');
  check(/unknown param "heigth" for studio\/trees\/pine — did you mean "height"/.test(dry({ nodes: { t: { type: 'studio/trees/pine', params: { heigth: 3 } } } }).said), 'and so is a slider it does not have');
  const oaks = dry({ nodes: { t: { type: 'studio/oaks/oak' } } });
  check(!oaks.first.length && /package studio\/oaks is not in this package's uses \(dry\.topo\), and it could not be added: no place this package looks in has a package studio\/oaks/.test(oaks.said),
    `a package no place has: why first use could not add it, as a build says: ${oaks.said}`);
  check(!dry({ nodes: { b: { type: 'box' } } }).first.length && o.ws.dryScope({ nodes: { b: { type: 'box' } } }).scope === o.engine.root, 'a graph that names nothing new is checked in the package as it is');
  // the build adds what the dry run said
  const added = o.pk.addFor(graph);
  check(added.length === 3 && added.some((n) => /^added studio\/trees 1\.1 to package dry from library "game"/.test(n)) && !dry(graph).first.length && !dry(graph).errors.length,
    `then build and edit add those versions, and a dry run has nothing new to say: ${added.join(' | ')}`);
  // outside a package it stays the error that says how to make one
  const loose = path.join(tmp, 'dry-loose');
  fs.mkdirSync(loose);
  const lw = (await open(loose)).ws, outside = lw.dryScope({ nodes: { c: { type: 'topotopo/props/crate' } } });
  const od = lw.engine.dryRun({ nodes: { c: { type: 'topotopo/props/crate' } } }, undefined, outside.scope);
  check(!outside.notes.length && /package topotopo\/props: this graph is in no package, and only packages use packages \(hint: topotopo init/.test(od.errors.map((e) => `${e.message} (hint: ${e.hint})`).join('; ')),
    `outside a package a dry run says how to make the folder one: ${od.errors[0]?.message}`);
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
  check(!blocked.ok && blocked.blocks.some((b) => /edited by hand/.test(b)), 'publishing a package with a copy edited by hand is refused');
  fs.writeFileSync(crownFile, before);
  check(!(await open(dirs.forest)).pk.check().some((p) => /edited by hand/.test(p)), 'restored, it is fine again');
  check(!o.pk.check().some((p) => /edited by hand/.test(p)) && !(await o.engine.cook({ nodes: { t: { type: 'studio/trees/pine' } } })).warnings.some((w) => /edited by hand/.test(w.message)),
    'in the same session too: problems are worked out afresh at each check, and the copy loads again without the warning');
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
  check(o.pk.verifyCopies().some((p) => p === 'the copy of studio/trees 1.0 is missing: packages/studio/trees/1.0; restore it, or run topotopo use studio/grove, which copies what is missing'),
    'a missing copy of a version another package uses is found, with the package whose use copies it again');
  const dep = m.pk.use('studio/grove');
  check(dep.copied.join() === 'studio/trees 1.0' && exists(depCopy, 'version.json'), `use of the package that needs it copies it again: ${dep.text}`);
  fs.rmSync(depCopy + '-away', { recursive: true });
  // a version changed after publishing is not copied
  const TAMPER = path.join(dirs.lib, 'tamper');
  writePackage(TAMPER, { name: 'studio/tamper' }, { main: { nodes: { b: { type: 'box' } }, output: 'b' } });
  check((await publish(TAMPER, 'tamper')).ok, 'studio/tamper 1.0');
  setGraph(path.join(TAMPER, 'versions', '1.0'), 'main', { nodes: { b: { type: 'sphere' } }, output: 'b' });
  check(/studio\/tamper 1\.0 in .* \(library "lib"\) was changed after publishing/.test(errorText(() => m.pk.use('studio/tamper'))), 'a version whose files no longer give its hash is not copied');
  // the same name in two places: the first place that has it gives it (game comes before lib); the other is not used, said
  const twin = path.join(dirs.game, 'rocks-twin');
  fs.cpSync(ROCKS, twin, { recursive: true });
  const tv = path.join(twin, 'versions', '1.0');
  write(path.join(tv, 'inputs', 'rock.obj'), triangle(7));
  const ti = readJSON(path.join(tv, 'version.json'));
  ti.hash = versionHash(tv);
  json(path.join(tv, 'version.json'), ti);
  fs.renameSync(path.join(twin, 'rocks.topo'), path.join(twin, 'rocks-twin.topo'));
  const fresh = path.join(dirs.repo, 'fresh');
  writePackage(fresh, {}, {});
  const f = await open(fresh);
  const took = f.pk.use('nordic/rocks');
  check(/^added nordic\/rocks 1\.0 to package fresh from library "game"/.test(took.text) && readLock(fresh).packages['nordic/rocks']['1.0'].hash === ti.hash,
    `precedence: the first place that has a name gives it, its own files (${took.text.split(':')[0]})`);
  check(/\n {2}nordic\/rocks 1\.0 {2}1 output {2}.*; also in library "lib", not used\n/.test(packagesText(f.pk)), `and packages says the later place has it too, not used:\n${packagesText(f.pk).split('\n').find((l) => /nordic\/rocks 1\.0/.test(l))}`);
  fs.rmSync(twin, { recursive: true });
  fs.rmSync(fresh, { recursive: true });
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
  // what the live cook used names the working folder; an export cooks with the published copies, and says so
  const graph: GraphSpec = { nodes: { t: { type: 'studio/trees/pine' }, g: { type: 'studio/grove' }, out: { type: 'merge', in: ['t', 'g'] } }, output: 'out' };
  const used = packagesUsed(o.engine, graph);
  const lock = readLock(dirs.forest);
  check(Object.keys(used).join() === 'nordic/rocks@1.0,studio/grove@1.0,studio/trees@1.0,studio/trees@working' && used['studio/trees@working'] === o.engine.resolveDef('studio/trees/pine')!.package!.hash
    && used['studio/grove@1.0'] === lock.packages['studio/grove']['1.0'].hash, `what the live cook used: every version and the working folder's hash (${Object.keys(used)})`);
  const pub = o.pk.published()!, inUse = readManifest(dirs.forest).uses['studio/trees'];
  const usedPub = packagesUsed(o.engine, graph, pub), cookedPub = await o.engine.cook(pine, { scope: pub });
  check(!!pub && !Object.keys(usedPub).some((k) => k.endsWith('@working')) && !!usedPub[`studio/trees@${inUse}`] && size(cookedPub, 0) === 3
    && new RegExp(`shows studio/trees live from its working folder, for looking; the export used the published studio/trees ${inUse}`).test(o.pk.publishedNote(graph) ?? ''),
    `an export cooks with the published copies while following (width ${size(cookedPub, 0)}; ${Object.keys(usedPub)}; ${o.pk.publishedNote(graph)})`);
  const src = exportSource({ graph: 'main', spec: graph, node: 'out', format: 'glb', packages: used, version: '0' });
  check(JSON.stringify(Object.keys(src)) === JSON.stringify(['graph', 'graph_sha256', 'output', 'node', 'frame', 'fps', 'vars', 'seeds', 'packages', 'export', 'topotopo']) && src.packages!['studio/trees@working'] === used['studio/trees@working'],
    'exportSource writes them as "packages"');
  const plain = exportSource({ graph: 'main', spec: { nodes: { b: { type: 'box' } } }, node: 'b', format: 'glb', packages: {}, version: '0' });
  check(!('packages' in plain), 'a graph without packages has no "packages" (records stay as they were)');
  // publishing while following: checked with the published copies, said
  const p = await publishPackage(o.pk, { note: 'while following', dryRun: true });
  check(!p.blocks.some((x) => /follow/.test(x)) && p.warnings.some((x) => /shows studio\/trees live from its working folder: the version was checked with the published copies/.test(x)),
    `publishing while following is not refused: it uses the published copies (${p.warnings.filter((x) => /live/.test(x)).join(' | ')})`);
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
  writePackage(SAPLING, { name: 'studio/sapling' }, { main: { nodes: { c: { type: 'cone' } }, output: 'c', outputs: { tip: { node: 'c' } } } });
  const s = await open(dirs.forest, ['studio/sapling']);
  const sg: GraphSpec = { nodes: { s: { type: 'studio/sapling/tip' } } };
  check(!s.pk.addFor(sg).length && (await s.engine.cook(sg)).ok && !readManifest(dirs.forest).uses['studio/sapling'], 'a followed package with no version yet cooks from its folder and is not added to uses');
  check(/no place this package looks in has a package studio\/oaks/.test(errorText(() => s.pk.follow('studio/oaks'))), 'following a package no place has fails');
  setGraph(TREES, 'crown', crown(1.5));
}

// ------------------------------------------------------------------ TopoTopo's built-in library
section('TopoTopo\'s built-in library: looked in without listing it; copies and locks; a new version is an update');
{
  // a built-in library as TopoTopo's repository has it: topotopo/shapes's working folder, which publishes its versions
  const BUILTIN = path.join(tmp, 'builtin'), SHAPES = path.join(BUILTIN, 'shapes');
  const cube = (s: number): GraphSpec => ({ description: 'A test cube. Its size is s.', nodes: { b: { type: 'box', params: { size: ['=s', '=s', '=s'] } } }, output: 'b', vars: { s }, params: { s: { type: 'float', min: 0.1, max: 9 } }, outputs: { cube: { node: 'b', label: 'Cube' } } });
  writePackage(SHAPES, { name: 'topotopo/shapes' }, { main: cube(1) });
  const asTopoTopo = async (dir: string, note: string, builtin?: string, flag = true) => { const o = await open(dir, [], builtin); return publishPackage(o.pk, { note, builtin: flag }); };
  const refused = await asTopoTopo(SHAPES, 'mine', BUILTIN, false), outside = await asTopoTopo(SHAPES, 'mine');
  check(!refused.ok && refused.blocks.some((b) => /the owner "topotopo" is reserved for TopoTopo's own packages, which TopoTopo's repository publishes into its built-in library/.test(b)), `a package does not publish under "topotopo": ${refused.blocks.join(' | ')}`);
  check(!outside.ok && outside.blocks.some((b) => /only a folder of TopoTopo's built-in library .* publishes one of TopoTopo's own packages/.test(b)), `nor does a folder outside the built-in library: ${outside.blocks.join(' | ')}`);
  const WRONG = path.join(BUILTIN, 'other');
  writePackage(WRONG, { name: 'topotopo/shapes2' }, { main: cube(1) });
  check((await asTopoTopo(WRONG, 'x', BUILTIN)).blocks.some((b) => /the folder other of TopoTopo's built-in library holds the package topotopo\/other, and its other\.topo names topotopo\/shapes2/.test(b)), 'a folder of the built-in library holds the package of its name');
  fs.rmSync(WRONG, { recursive: true });
  const v1 = await asTopoTopo(SHAPES, 'first version', BUILTIN);
  check(v1.ok && v1.version === '1.0', `the built-in library's folder publishes topotopo/shapes 1.0: ${v1.blocks.join('; ')}`);
  // a package that lists no library: first use copies the built-in package in and locks it, from library "topotopo"
  const APP = path.join(tmp, 'app');
  writePackage(APP, {}, {});
  const a = await open(APP, [], BUILTIN);
  const scene: GraphSpec = { nodes: { c: { type: 'topotopo/shapes/cube', params: { s: 3 } } }, output: 'c' };
  const added = a.pk.addFor(scene);
  check(added.length === 1 && added[0] === 'added topotopo/shapes 1.0 to package app from TopoTopo\'s built-in library: packages/topotopo/shapes/1.0',
    `found without listing a library: ${added.join(' | ')}`);
  check(JSON.stringify(readManifest(APP).uses) === '{"topotopo/shapes":"1.0"}' && readLock(APP).packages['topotopo/shapes']['1.0'].library === 'topotopo' && readLock(APP).packages['topotopo/shapes']['1.0'].hash === v1.hash
    && exists(APP, 'packages', 'topotopo', 'shapes', '1.0', 'version.json'), 'copied and locked like any package: the lock names library "topotopo" and the version\'s hash');
  check(size(await a.engine.cook(scene), 0) === 3, 'it cooks from the copy');
  const listed = packagesText(a.pk);
  check(/\nuses 1 package: 1 up to date\n {2}topotopo\/shapes 1\.0 {2}1 output {2}up to date\n/.test(listed) && /\nlooks in: library "game" .*, TopoTopo's built-in library; outside a workspace every registered library counts/.test(listed),
    `packages: one line for the package, and the places:\n${listed}`);
  // the catalog and help: offered where it is not used yet, with its description as the summary
  const B = path.join(tmp, 'app-b');
  writePackage(B, {}, {});
  const b = await open(B, [], BUILTIN);
  const offered = b.engine.packageDefs().find((d) => d.type === 'topotopo/shapes/cube');
  check(!!offered && offered.summary === 'A test cube.' && /^Its size is s\.\ntopotopo\/shapes 1\.0: first version\nOutput "cube" of package topotopo\/shapes 1\.0 \(Cube\): it cooks node "b"/.test(offered.description ?? '') && !b.engine.resolveDef('topotopo/shapes/cube'),
    `a package that does not use it gets it offered: the catalog lists it (${offered?.summary}), and only a graph's first use makes it resolve`);
  const listsBuiltin = resolveListed(dirs.valley, ['topotopo']);
  check(!listsBuiltin.libs.length && !listsBuiltin.problems.length && /^added topotopo\/shapes 1\.0/.test(b.pk.use('topotopo/shapes').text), 'a workspace that lists "topotopo" lists nothing more: the built-in library is looked in anyway');
  const loose = path.join(tmp, 'loose-builtin');
  fs.mkdirSync(loose);
  const lo = await open(loose, [], BUILTIN);
  const notHere = await lo.engine.cook(scene);
  check(lo.engine.packageDefs().some((d) => d.type === 'topotopo/shapes/cube') && /this graph is in no package, and only packages use packages \(hint: topotopo init <folder> \(MCP: workspace \{action:"init"\} for the server's folder, when the person says so\) makes the folder a package/.test(errorOf(notHere)),
    `outside a package it is offered too, and naming it says how to make the folder a package: ${errorOf(notHere)}`);
  // a TopoTopo release with a new version: an update, never a silent change
  setGraph(SHAPES, 'main', cube(2));
  const v11 = await asTopoTopo(SHAPES, 'a bigger cube', BUILTIN);
  check(v11.ok && v11.version === '1.1', `topotopo/shapes 1.1: ${v11.blocks.join('; ')}`);
  const a2 = await open(APP, [], BUILTIN);
  const late = a2.pk.outdated()[0];
  check(late.package === 'topotopo/shapes' && late.small === '1.1' && late.places.join() === 'TopoTopo\'s built-in library' && /topotopo\/shapes 1\.0: 1\.1 is out {2}\[TopoTopo's built-in library\]\n {4}1\.1 {2}"a bigger cube"/.test(outdatedText(a2.pk)),
    `the new built-in version shows as an update (${outdatedText(a2.pk).split('\n')[1]})`);
  check(size(await a2.engine.cook(scene), 0) === 3, 'and the package keeps cooking the copy of 1.0 until it updates');
  check(builtinVersions('topotopo/shapes', BUILTIN).map((v) => v.version).join() === '1.0,1.1' && !builtinVersions('studio/trees', BUILTIN).length, 'the versions the built-in library holds (the web app names the newest)');
  const up = applyUpdate(a2.pk, 'topotopo/shapes', { from: '1.0', to: '1.1' });
  check(/from TopoTopo's built-in library/.test(up.text) && size(await a2.engine.cook({ nodes: { c: { type: 'topotopo/shapes/cube' } } }), 0) === 2 && readLock(APP).packages['topotopo/shapes']['1.1'].library === 'topotopo',
    `Update copies 1.1 in from the built-in library: ${up.text.split('\n')[0]}`);
  // following: the working folder in TopoTopo's repository; an installed TopoTopo ships the versions alone
  check(/^following topotopo\/shapes for this session: its working folder .*shapes \(TopoTopo's built-in library\)/.test(a2.pk.follow('topotopo/shapes')) && a2.pk.outdated()[0].working.length === 1, 'the built-in library\'s working folder is followed like any');
  const SHIPPED = path.join(tmp, 'shipped');
  fs.cpSync(path.join(SHAPES, 'versions'), path.join(SHIPPED, 'shapes', 'versions'), { recursive: true });
  const a3 = await open(APP, [], SHIPPED);
  check(/topotopo\/shapes has no working folder: TopoTopo's built-in library holds its versions alone \(an installed TopoTopo ships its own packages without their working folders\), and follow needs one/.test(errorText(() => a3.pk.follow('topotopo/shapes')))
    && a3.pk.outdated()[0].working.length === 0 && a3.pk.outdated()[0].places.join() === 'TopoTopo\'s built-in library', 'without a working folder there is nothing to follow (the viewer offers no switch)');
  check((await a3.engine.cook(scene)).ok && a3.engine.packageDefs().length > 0, 'and the versions alone serve the package');
  // no registered library takes the built-in library's name
  check(/"topotopo" is the name of TopoTopo's built-in library, which every package looks in: give this library another name/.test(errorText(() => addLibrary('topotopo', path.join(tmp, 'mylib')))), 'library add refuses the name "topotopo"');
  process.env.TOPOTOPO_LIBRARIES = `topotopo=${path.join(tmp, 'mylib')}`;
  check(/^TOPOTOPO_LIBRARIES: "topotopo" is the name of TopoTopo's built-in library/.test(errorText(() => loadConfig())), 'and so does the config');
  delete process.env.TOPOTOPO_LIBRARIES;
}

// ------------------------------------------------------------------ search
section('search: the places a package looks in, by words, kind and tag; in a workspace the libraries it does not list, and the command that lists one');
{
  // a built-in library of its own: topotopo/woods, published as TopoTopo's repository publishes its packages
  const SB = path.join(tmp, 'search-builtin'), WOODS = path.join(SB, 'woods');
  writePackage(WOODS, { name: 'topotopo/woods' }, {
    main: {
      nodes: { fir: { type: 'cone' }, b: { type: 'box' }, g: { type: 'grid' }, s: { type: 'scatter', in: ['g'], params: { count: 5 } }, grove: { type: 'copy_to_points', in: ['fir', 's'], params: { pack: true } } },
      output: 'fir',
      outputs: { fir: { node: 'fir', label: 'Fir', kind: 'mesh', tags: ['conifer', 'tree'] }, grove: { node: 'grove', kind: 'instances', tags: ['forest', 'conifer'] }, stone: { node: 'b', kind: 'mesh', tags: ['rock'] } },
    },
  });
  const w = await open(WOODS, [], SB);
  check((await publishPackage(w.pk, { note: 'woods', builtin: true })).ok, 'the built-in library of the search: topotopo/woods 1.0');
  // finder is a package of the workspace "valley", which lists "lib"; game and other are registered and not listed
  const FINDER = path.join(dirs.valley, 'levels', 'finder');
  writePackage(FINDER, {}, {});
  const find = (dir: string, q: Parameters<typeof searchPackages>[1]) => searchPackages(dir, q, { builtin: SB });
  const s = find(FINDER, { query: 'conifer' });
  const where = (r: ReturnType<typeof searchPackages>) => r.libraries.map((l) => `${l.name}:${l.standing}:${l.hits.map((h) => h.type).join('+')}`).join(' ');
  check(s.package === 'package finder' && s.workspace === 'valley' && s.libraries.map((l) => `${l.name}:${l.standing}`).join() === 'valley:self,lib:listed,topotopo:builtin,game:unlisted,other:unlisted',
    `the places in the order a lookup takes them (the workspace, the library it lists, the built-in library), then the registered ones it does not list, by name (${where(s)})`);
  check(where(s) === 'valley:self: lib:listed: topotopo:builtin:topotopo/woods/fir+topotopo/woods/grove game:unlisted:studio/trees/pine other:unlisted:',
    `words match the outputs' names, descriptions and tags, across the built-in library and a registered one (${where(s)})`);
  const pine = s.libraries[3].hits[0];
  check(pine.kind === 'mesh' && pine.tags.join() === 'conifer,tree' && pine.label === 'Pine' && pine.version === '1.1' && pine.alias === 'studio/trees' && pine.package === 'studio/trees',
    `each result: full name, kind, tags, label, version (${JSON.stringify(pine)})`);
  const text = searchText(s, true);
  check(/^search "conifer": 3 outputs in 2 of the 5 places looked in, for package finder\n/.test(text) && /\nTopoTopo's built-in library "topotopo": TopoTopo's own packages, which every package can use/.test(text)
    && /\nlibrary "game" \(.*game\): the workspace "valley" does not list it: to use these, workspace \{action:"libraries", add:"game"\} lists it, when the person says so \(the tools never add a library by themselves\)/.test(text)
    && /\nhelp \{nodes:\["topotopo\/woods\/fir"\]\} gives an output's params and inputs/.test(text)
    && /\n {2}studio\/trees\/pine {2}mesh \[conifer, tree\] {2}"Pine" {2}1\.1 {2}\(also studio\/trees, its default output\)\n/.test(text) && /\nnothing matches in the workspace "valley", library "lib", library "other"/.test(text),
    `it says which the package can use, and the command that lists a library for the others:\n${text}`);
  check(where(find(FINDER, { query: 'conifer', kind: 'instances' })) === 'valley:self: lib:listed: topotopo:builtin:topotopo/woods/grove game:unlisted: other:unlisted:', 'kind matches exactly');
  check(where(find(FINDER, { tag: 'conifer' })) === 'valley:self: lib:listed: topotopo:builtin:topotopo/woods/fir+topotopo/woods/grove game:unlisted:studio/trees/pine other:unlisted:'
    && !find(FINDER, { tag: 'conif' }).libraries.some((l) => l.hits.length) && where(find(FINDER, { tag: 'rock' })) === 'valley:self: lib:listed: topotopo:builtin:topotopo/woods/stone game:unlisted: other:unlisted:', 'tag matches exactly');
  const show = find(FINDER, { query: 'showcase' });
  check(show.libraries[1].hits.length === 8 && show.libraries[1].hits.every((h) => h.package === 'studio/kinds' && h.version === '2.1') && show.libraries[1].hits.find((h) => h.type === 'studio/kinds/mesh')?.alias === 'studio/kinds',
    `the package's own tags match too: every output of its newest version (${show.libraries[1].hits.map((h) => h.type).join(', ')})`);
  check(!find(FINDER, { query: 'sampler' }).libraries.some((l) => l.hits.some((h) => h.package === 'studio/kinds')),
    'the package\'s description does not: it lists its contents, which would match every output');
  check(where(find(FINDER, { query: 'conif' })) === where(s) && !find(FINDER, { query: 'onifer' }).libraries.some((l) => l.hits.length) && !find(FINDER, { query: 'ree' }).libraries.some((l) => l.hits.length),
    'a word matches the start of a word ("conif" finds conifers; "onifer" and "ree" find nothing)');
  check(where(find(FINDER, { query: 'nordic boulder' })) === 'valley:self: lib:listed:nordic/rocks/boulder topotopo:builtin: game:unlisted: other:unlisted:', 'every word must match');
  check(throws(() => find(FINDER, { kind: 'level' }), /^"level" is not a kind: mesh, instances, points, curves, terrain, textures, material, volume, scene$/), 'a kind not on the list says the list');
  // outside a workspace every registered library counts; the package itself; a folder in no package
  const used = find(dirs.forest, { tag: 'conifer' });
  check(used.libraries.map((l) => `${l.name}:${l.standing}`).join() === 'game:registered,lib:registered,other:registered,topotopo:builtin' && used.libraries.find((l) => l.name === 'game')!.hits[0].used === '1.1'
    && /\(also studio\/trees, its default output; this package uses 1\.1\)/.test(searchText(used)) && /\nlibrary "game" \(.*\): a registered library: outside a workspace every registered library counts/.test(searchText(used)),
    'outside a workspace: every registered library, which the package can use, and the result says the version it uses');
  const own = find(TREES, { tag: 'conifer' });
  check(own.libraries[0].name === 'game' && own.libraries[0].standing === 'self' && own.libraries[0].hits[0].self === true && /this package's own output/.test(searchText(own)), 'a package inside a library looks there first; the package that publishes versions: its own outputs');
  const none = find(path.join(tmp, 'loose'), { tag: 'conifer' });
  check(none.package === null && none.libraries.map((l) => l.name).join() === 'game,lib,other,topotopo' && /\nthis folder is in no package, and only a package's graphs use packages: topotopo init/.test(searchText(none)),
    'a folder in no package: the registered libraries and TopoTopo\'s built-in one, and how to make it a package');
  const atRoot = find(dirs.valley, { tag: 'conifer' });
  check(atRoot.package === null && atRoot.workspace === 'valley' && /for the workspace "valley"/.test(searchText(atRoot)) && atRoot.libraries.map((l) => l.standing).join() === 'self,listed,builtin,unlisted,unlisted',
    'at a workspace\'s root, in no package, search uses the workspace\'s lookup');
  check(/^search "nothing-here": no output matches in the workspace "valley", library "lib", TopoTopo's built-in library, library "game", library "other"$/.test(searchText(find(FINDER, { query: 'nothing-here' }))), 'nothing found: it says where it looked');
}

// ------------------------------------------------------------------ the CLI
/** A package command run in this process (src/packages/commands.ts): its exit code, and what it said on stdout and stderr. */
const run = async (cmd: string, args: string[], cwd = ROOT) => {
  const out: string[] = [], err: string[] = [];
  const was = process.cwd();
  process.chdir(cwd);
  try {
    const code = await commands[cmd](args, 'topotopo', { out: (s) => out.push(s), err: (s) => err.push(s) });
    return { code: code ?? 0, out: out.join('\n'), err: err.join('\n') };
  } finally { process.chdir(was); }
};
/** The CLI as a person runs it, in a process of its own: what src/cli.ts does itself (a graph-file cook, --help-node). */
const spawnCli = (args: string[], cwd = ROOT) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'src', 'cli.ts'), ...args], { cwd, encoding: 'utf8', env: { ...process.env, TOPOTOPO_WORKERS: '0' } });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
};

section('the CLI: init, libraries, use, remove, packages, publish, search');
{
  const CLI = path.join(dirs.repo, 'cliproj');
  const init = await run('init', [CLI, '--name', 'studio/cli']);
  check(init.code === 0 && /^package cliproj → .*cliproj \(publishes as studio\/cli\)/.test(init.out) && readManifest(CLI).name === 'studio/cli' && exists(CLI, 'cliproj.topo') && exists(CLI, '.gitignore'), `init makes a folder a package: ${init.out.split('\n')[0]}`);
  const pj = readJSON(path.join(CLI, 'cliproj.topo'));
  check(!('libraries' in pj) && pj.graph === 'main' && !('bake' in pj) && !('links' in pj) && readJSON(path.join(CLI, 'graphs', 'main.json')).output === 'box',
    `init writes no "libraries" and a starter graphs/main.json, so the graph it shows is there, and no web app fields (${JSON.stringify(pj)})`);
  check(/outside a workspace it finds packages in every registered library/.test(init.out), `init says where the package finds packages: ${init.out.split('\n')[1]}`);
  check(fs.readFileSync(path.join(CLI, '.gitattributes'), 'utf8') === 'versions/** -text\npackages/** -text\n' && /\npackages\/\.cache\.json\npackages\/\.lock\n$/.test(fs.readFileSync(path.join(CLI, '.gitignore'), 'utf8')),
    'init keeps versions/ and packages/ byte for byte (.gitattributes), and leaves the hash cache and the lock out (.gitignore)');
  const PLAIN = path.join(dirs.repo, 'plainproj');
  write(path.join(PLAIN, '.gitattributes'), '*.png binary');
  json(path.join(PLAIN, 'graphs', 'scene.json'), { nodes: { b: { type: 'box' } }, output: 'b' });
  const plain = await run('init', [PLAIN]);
  check(fs.readFileSync(path.join(PLAIN, '.gitattributes'), 'utf8') === '*.png binary\nversions/** -text\npackages/** -text\n', 'and adds those lines to a .gitattributes that is there');
  check(plain.code === 0 && /graphs go in graphs\/ \(it shows "scene"\)/.test(plain.out) && readManifest(PLAIN).graph === 'scene' && !exists(PLAIN, 'graphs', 'main.json') && readManifest(PLAIN).name === undefined,
    `a folder with graphs shows one of them, and gets no starter graph: ${plain.out}`);
  check((await run('init', [CLI])).code === 1 && (await run('init', [path.join(CLI, 'inner')])).code === 1, 'init refuses a package (without --name), and a folder inside one');
  const named = await run('init', [PLAIN, '--name', 'studio/plain']);
  check(named.code === 0 && /publishes as studio\/plain now/.test(named.out) && readManifest(PLAIN).name === 'studio/plain' && readManifest(PLAIN).graph === 'scene', `init --name on a package sets the name it publishes under: ${named.out}`);
  check(/publishes as studio\/plain already: a package keeps its name/.test((await run('init', [PLAIN, '--name', 'studio/other'])).err), 'and never renames one');
  const reserved = await run('init', [path.join(dirs.repo, 'reserved-init'), '--name', 'topotopo/rocks']);
  check(reserved.code === 1 && /the owner "topotopo" is reserved for TopoTopo's own packages/.test(reserved.err) && !exists(dirs.repo, 'reserved-init', 'reserved-init.topo'), `init refuses the owner "topotopo": ${reserved.err}`);

  // `topotopo libraries` is gone: it says where its work went; the workspace lists its shared libraries
  const gone = await run('libraries', ['add', 'game', CLI]);
  check(gone.code === 1 && gone.err === '`topotopo libraries` is gone: `topotopo workspace library add <entry>` lists a library for the workspace; outside a workspace every registered library counts', `topotopo libraries says where its work went: ${gone.err}`);
  const wsFile = path.join(dirs.valley, 'topotopo-workspace.json');
  const add = await run('workspace', ['library', 'add', 'game', '--workspace', dirs.valley]);
  check(add.code === 0 && JSON.stringify(readJSON(wsFile).libraries) === '["lib","game"]' && /the workspace "valley" lists "lib", "game" in .*topotopo-workspace\.json "libraries" now\nits packages find packages in the workspace itself, then in library "lib" \(.*\), library "game" \(.*\), then in TopoTopo's built-in library/.test(add.out),
    `workspace library add lists a registered library by its name: ${add.out}`);
  const byFolder = await run('workspace', ['library', 'add', path.join('..', 'other')], dirs.valley);
  check(byFolder.code === 0 && JSON.stringify(readJSON(wsFile).libraries) === '["lib","game","../other"]', `a folder, given as the person sees it, is written from the workspace: ${readJSON(wsFile).libraries}`);
  check((await run('workspace', ['library', 'remove', dirs.other], dirs.valley)).code === 0 && (await run('workspace', ['library', 'remove', 'game'], YARD)).code === 0 && JSON.stringify(readJSON(wsFile).libraries) === '["lib"]',
    'workspace library remove takes the entry, its folder or its name; the default workspace is the one around the current folder');
  const inside = await run('workspace', ['library', 'add', './assets'], dirs.valley);
  check(inside.code === 1 && /assets is inside the workspace \(.*\): its packages are found by themselves; .*topotopo-workspace\.json "libraries" lists shared libraries outside it/.test(inside.err), `a folder inside the workspace is refused: ${inside.err}`);
  const pkgFolder = await run('workspace', ['library', 'add', ROCKS, '--workspace', dirs.valley]);
  check(pkgFolder.code === 1 && /is a package's folder \(rocks\.topo\), not a library: .*"libraries" lists the folders of shared libraries/.test(pkgFolder.err), `a package's folder is no library: ${pkgFolder.err}`);
  const unregistered = await run('workspace', ['library', 'add', 'nowhere', '--workspace', dirs.valley]);
  check(unregistered.code === 1 && /^"nowhere" is no folder here and no registered library \(game, lib, other\): .*"libraries" lists a registered library by its name; register it first \(topotopo library add nowhere <folder>\)/.test(unregistered.err), `an unregistered name is refused: ${unregistered.err}`);
  check(/topotopo-workspace\.json does not list "nope": it lists "lib"/.test((await run('workspace', ['library', 'remove', 'nope', '--workspace', dirs.valley])).err), 'and remove says what it lists for one it does not');
  // a registered name and a path to its folder are one library
  const twice = await run('workspace', ['library', 'add', path.relative(dirs.valley, dirs.lib)], dirs.valley);
  check(twice.code === 0 && readJSON(wsFile).libraries.join() === 'lib' && /lists "\.\.\/lib" already \(as "lib", the same folder\)/.test(twice.out), `add of a folder listed by its registered name lists it once (${twice.out.split('\n')[0]})`);
  json(wsFile, { ...readJSON(wsFile), libraries: ['lib', '../game'] });
  const byName = await run('workspace', ['library', 'remove', 'game', '--workspace', dirs.valley]);
  json(wsFile, { ...readJSON(wsFile), libraries: ['lib', '../lib'] });
  const both = await run('workspace', ['library', 'remove', 'lib', '--workspace', dirs.valley]);
  const after = readJSON(wsFile).libraries.join();
  json(wsFile, { ...readJSON(wsFile), libraries: ['lib'] });
  check(byName.code === 0 && /lists "lib" in /.test(byName.out) && both.code === 0 && after === '', `remove by a registered name takes a path entry to its folder too, every entry of that folder (${byName.err || byName.out.split('\n')[0]}; left "${after}")`);
  check(/is in no workspace: topotopo workspace init <folder> makes one; outside a workspace every registered library counts/.test((await run('workspace', ['library', 'add', 'game'], CLI)).err), 'outside a workspace it says so');

  // a folder named must exist; a version is named apart
  const typo = await run('use', ['nordic/rocks', path.join(CLI, 'nowhere')]);
  check(typo.code === 1 && /^no folder .*nowhere$/.test(typo.err) && !Object.keys(readManifest(CLI).uses).length, `a folder that does not exist is an error, never the package above it: ${typo.err}`);
  const version = await run('use', ['nordic/rocks', '1.0'], CLI);
  check(version.code === 1 && /^"1\.0" is no folder here: a version is named with --version, topotopo use nordic\/rocks --version 1\.0$/.test(version.err), `a version where the folder goes: ${version.err}`);
  const at = await run('use', ['nordic/rocks@1.0', CLI]);
  check(at.code === 1 && /"nordic\/rocks@1\.0" is not a package name: name the version apart, topotopo use nordic\/rocks --version 1\.0/.test(at.err), `owner/name@version: ${at.err}`);
  check((await run('use', ['nordic/rocks', CLI, '--version', '9.0'])).code === 1, 'a version no library has fails');
  const use = await run('use', ['nordic/rocks', CLI, '--version', '1.0']);
  check(use.code === 0 && /^added nordic\/rocks 1\.0 to package cliproj from library "lib"/.test(use.out), `use --version: ${use.out}`);
  setGraph(CLI, 'main', { nodes: { r: { type: 'nordic/rocks/boulder', params: { size: 2 } } }, output: 'r' });

  // packages: one line each; one package with its outputs
  const ls = await run('packages', [CLI]);
  check(ls.code === 0 && /\nuses 1 package: 1 up to date\n {2}nordic\/rocks 1\.0 {2}1 output {2}up to date\n/.test(ls.out) && /\nin the places it looks in, not used yet \(\d+\):\n/.test(ls.out) && /\n {2}studio\/rules 7\.1 +1 output {2}\[library "lib"\]/.test(ls.out)
    && /\ntopotopo packages owner\/name shows one with its outputs/.test(ls.out), `packages:\n${ls.out}`);
  const one = await run('packages', ['nordic/rocks', CLI]);
  check(one.code === 0 && /^nordic\/rocks in library "lib" \(.*\): package cliproj uses 1\.0\nversions:\n {2}1\.0 {2}"first rocks" {2}\(in use\)\noutputs of 1\.0:\n {2}nordic\/rocks\/boulder {2}mesh {2}"Boulder" {2}params size {2}\(also nordic\/rocks, its default output\)\ntopotopo --help-node nordic\/rocks\/boulder gives/.test(one.out),
    `packages owner/name:\n${one.out}`);

  // publish: the dry run, the version, nothing changed
  const before = shown(CLI);
  const dry = await run('publish', [CLI, '--dry-run']);
  check(dry.code === 0 && /^✓ would publish studio\/cli 1\.0 \(the first version\); publishing it needs a note/.test(dry.out) && /\noutputs:\n {2}\(default: "r" of graph "main"\) {2}mesh\n/.test(dry.out) && /a dry run: nothing was written/.test(dry.out)
    && JSON.stringify(shown(CLI)) === JSON.stringify(before), `publish --dry-run writes nothing:\n${dry.out}`);
  const pub = await run('publish', [CLI, '--note', 'from the cli']);
  check(pub.code === 0 && /✓ published studio\/cli 1\.0 \(the first version\): "from the cli"/.test(pub.out), `publish: ${pub.out.split('\n')[0]}`);
  const again = await run('publish', [CLI, '--note', 'again']);
  check(again.code === 1 && /nothing changed since 1\.0/.test(again.out) && (await run('publish', [CLI, '--dry-run'])).code === 1, 'publish without a change fails, and so does its dry run');
  check(/^unknown option --check/.test((await run('publish', [CLI, '--check'])).err), 'an unknown option says so, with the usage');

  // remove: refused while a graph names it; then it goes with the copies nothing else uses
  const RM = path.join(dirs.repo, 'rmproj');
  writePackage(RM, {}, { main: { nodes: { t: { type: 'studio/trees/pine' } }, output: 't' } });
  check((await run('use', ['studio/trees', RM])).code === 0 && readManifest(RM).uses['studio/trees'] === '1.1', 'rmproj uses studio/trees 1.1 (with nordic/rocks 1.0)');
  const refused = await run('remove', ['studio/trees', RM]);
  check(refused.code === 1 && /^a graph of the package still names studio\/trees: graphs\/main\.json t; change or remove that node first, then remove the package$/.test(refused.err) && readManifest(RM).uses['studio/trees'] === '1.1',
    `remove is refused while a graph names the package: ${refused.err}`);
  check(/this package does not use nordic\/rocks itself: studio\/trees 1\.1 uses it/.test((await run('remove', ['nordic/rocks', RM])).err), 'a package used only through another is not removed alone');
  setGraph(RM, 'main', { nodes: { b: { type: 'box' } }, output: 'b' });
  const removed = await run('remove', ['studio/trees', RM]);
  check(removed.code === 0 && /^removed studio\/trees 1\.1 from package rmproj: rmproj\.topo no longer uses it; deleted the copies nothing uses any more: nordic\/rocks 1\.0, studio\/trees 1\.1$/.test(removed.out)
    && !Object.keys(readManifest(RM).uses).length && !Object.keys(readLock(RM).packages).length && shown(path.join(RM, 'packages')).join() === 'lock.json', `remove: ${removed.out}`);

  // search, from a folder or for one named
  const found = await run('search', ['conifer', '--kind', 'mesh'], path.join(dirs.valley, 'levels', 'finder'));
  check(found.code === 0 && /^search "conifer", kind mesh: \d+ outputs? in \d+ of the 5 places looked in, for package finder/.test(found.out) && /\n {2}studio\/trees\/pine {2}mesh \[conifer, tree\]/.test(found.out)
    && /the workspace "valley" does not list it: to use these, topotopo workspace library add game lists it/.test(found.out) && !/--workspace/.test(found.out) && /\ntopotopo --help-node \S+ gives an output's params and inputs/.test(found.out), `search: ${found.out.split('\n')[0]}`);
  // the command a hint names works where the person ran the command that printed it, outside the workspace too
  const outside = await run('use', ['studio/trees', path.join(dirs.valley, 'levels', 'finder')]);
  const said = /topotopo workspace library add game --workspace ("[^"]*"|\S+) lists it/.exec(outside.err);
  const listedNow = said ? await run('workspace', ['library', 'add', 'game', '--workspace', said[1].startsWith('"') ? JSON.parse(said[1]) : said[1]]) : null;
  check(outside.code === 1 && listedNow?.code === 0 && readWorkspace(dirs.valley).libraries.join() === 'lib,game', `the hint run outside the workspace names it with --workspace, and works as printed (${outside.err.slice(0, 200)})`);
  const unlisted = await run('workspace', ['library', 'remove', 'game', '--workspace', dirs.valley]);
  check(unlisted.code === 0 && readWorkspace(dirs.valley).libraries.join() === 'lib', 'and is undone');
  // packages at a workspace's root, in no package: the workspace's
  const root = await run('packages', [dirs.valley]);
  check(root.code === 0 && /^the workspace "valley" \(.*\), at its root, in no package: its topotopo-workspace\.json names the versions every package in it uses/.test(root.out) && /\nuses 1 package: 1 up to date\n {2}nordic\/rocks 1\.0 /.test(root.out)
    && /\n {2}valley\/crate +no version published yet {2}\[the workspace "valley"\]/.test(root.out) && /\nlooks in: the workspace "valley" \(.*\), library "lib" \(.*\), TopoTopo's built-in library\n/.test(root.out), `packages at a workspace's root:\n${root.out}`);
  const there = await run('search', ['--tag', 'conifer', CLI]);
  check(there.code === 0 && /for package cliproj/.test(there.out) && /\n {2}studio\/trees\/pine /.test(there.out), 'search for the package of a folder named (a path), --tag');
  check(/^no folder .*nowhere$/.test((await run('search', ['conifer', './nowhere'], CLI)).err), 'a folder that does not exist is an error');
  const wrong = await run('search', ['--kind', 'level'], CLI);
  check(wrong.code === 1 && /"level" is not a kind: mesh, instances/.test(wrong.err), `search --kind with no such kind: ${wrong.err}`);
  // the texture of a package output names the copy relative to the root's folder (the package folder: relative paths
  // read from the nearest .topo file at or above the graph file), so exports that carry texture paths name no folder
  // of this machine
  const ge = await newEngine(path.join(CLI, 'graphs'));
  openPackages(ge, path.join(CLI, 'graphs'));
  const rock = await ge.cook(readJSON(path.join(CLI, 'graphs', 'main.json')));
  const moss = rock.geo ? readMaterials(rock.geo).moss?.textures?.baseColor : '';
  check(moss === 'packages/nordic/rocks/1.0/inputs/moss.png' && fs.existsSync(path.resolve(CLI, moss)), `a package output's texture is portable: ${moss}`);
}

section('the package commands: every list of them says them the same way');
{
  const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const help = spawnCli(['--help']).out;
  const lists: [string, string, string][] = [
    ['src/cli.ts (its header)', read('src/cli.ts'), '//   node src/cli.ts '],
    ['--help', help, 'node src/cli.ts '],
    ['src/packages/commands.ts (its header)', read('src/packages/commands.ts'), '//   topotopo '],
    ['README.md', read('README.md'), 'topotopo '],
    ['help topic "packages"', topicText('packages') ?? '', 'topotopo '],
  ];
  for (const [where, text, prefix] of lists) {
    const missing = PACKAGE_COMMANDS.filter((c) => !text.includes(`${prefix}${c.usage}`)).map((c) => c.usage);
    check(!missing.length, `${where} lists every package command as PACKAGE_COMMANDS says it${missing.length ? `: missing ${missing.join(' | ')}` : ''}`);
  }
  const verbs = new Set(PACKAGE_COMMANDS.map((c) => c.usage.split(' ')[0]));
  check(['workspace', 'init', 'use', 'remove', 'packages', 'publish', 'search', 'outdated', 'check', 'update'].every((v) => verbs.has(v) && commands[v]) && [...verbs].every((v) => commands[v]) && !verbs.has('libraries'),
    'and each is a command the CLI runs');
}

section('the CLI as a person runs it: a graph-file cook (first use, --follow, --locked), --help-node, --catalog');
{
  const FILE = path.join(dirs.forest, 'scene.json');
  const sceneGraph: GraphSpec = { nodes: { t: { type: 'studio/trees/pine' }, x: { type: 'studio/rules/box' }, out: { type: 'merge', in: ['t', 'x'] } }, output: 'out' };
  json(FILE, sceneGraph);
  // --locked: what a cook would add, said and failed, nothing written (the cook checks it with pk.locked)
  const f = await open(dirs.forest);
  const was = fs.readFileSync(manifestFile(dirs.forest), 'utf8');
  const locked = f.pk.locked(sceneGraph);
  check(locked.length === 1 && /^the graph names studio\/rules, which forest\.topo does not use: topotopo use studio\/rules adds it/.test(locked[0]) && fs.readFileSync(manifestFile(dirs.forest), 'utf8') === was,
    `--locked fails for a package it does not use, and writes nothing: ${locked.join(' | ')}`);
  check(!f.pk.locked({ nodes: { t: { type: 'studio/trees/pine' } } }).length, 'and lets one that uses what the package holds cook');
  // a graph-file cook adds on first use, follows a working folder and records the packages it used
  setGraph(TREES, 'crown', crown(2));
  const fexp = path.join(dirs.forest, 'exports', 'scene.glb');
  const followed = spawnCli([FILE, '--follow', 'studio/trees', '--export', fexp]);
  const frec = fs.existsSync(fexp + '.source.json') ? readJSON(fexp + '.source.json').source : {};
  check(followed.code === 0 && /added studio\/rules 7\.1 to package forest/.test(followed.out) && /following studio\/trees: its working folder/.test(followed.out)
    && !Object.keys(frec.packages ?? {}).some((k: string) => k.endsWith('@working')) && Object.keys(frec.packages ?? {}).some((k: string) => k.startsWith('studio/trees@')) && frec.packages?.['studio/rules@7.1']
    && /the export used the published studio\/trees \d+\.\d+/.test(followed.out),
    `a cook adds on first use and shows a working folder; its export uses the published copy: ${followed.out.split('\n').slice(0, 3).join(' | ')} ${JSON.stringify(frec.packages)}`);
  const hn = spawnCli(['--help-node', 'studio/trees/pine'], dirs.forest);
  check(hn.code === 0 && /## studio\/trees\/pine \(package\)/.test(hn.out) && /studio\/trees 1\.1: bigger crown/.test(hn.out) && /height float = 4 \[1\.\.20\]/.test(hn.out), '--help-node gives a package output\'s params, version and note');
  // the catalog of the current folder's package; an output of a package it does not use yet, read from its library
  const c = await open(dirs.forest);
  const cat = catalogText([...c.engine.packageDefs()], { cli: true });
  check(/\[package\]/.test(cat) && /studio\/trees\/pine ◦? ?— output "pine" of package studio\/trees 1\.1 \(Pine\)/.test(cat), `the catalog lists the outputs of the packages in use: ${cat.split('\n').find((l) => l.includes('studio/trees/pine'))}`);
  const thing = c.pk.describe('studio/kinds/mesh'), none = c.pk.describe('studio/kinds/nothing');
  check(c.pk.describe('studio/trees/pine') === null && thing?.package?.version === '2.1' && thing.category === 'package' && none === null && !exists(dirs.forest, 'packages', 'studio', 'kinds'),
    `help on an output search found reads it where its library holds it, copying nothing (${thing?.type} ${thing?.package?.version})`);
  // a graph outside a package
  const loose = path.join(tmp, 'loose');
  fs.mkdirSync(loose, { recursive: true });
  const lo = await newEngine(loose);
  openPackages(lo, loose);
  const no = await lo.cook({ nodes: { t: { type: 'studio/trees/pine' } } });
  check(!no.ok && /in no package, and only packages use packages \(hint: topotopo init/.test(errorOf(no)), `a graph outside a package: ${errorOf(no)}`);
  setGraph(TREES, 'crown', crown(1.5));
}

// ------------------------------------------------------------------ out of date and Update
const rejection = async (p: Promise<unknown>) => { try { await p; return ''; } catch (e: any) { return String(e.message); } };
/** What an update must leave alone until it is applied: the package's files and copies, and the library. */
const untouched = (dir: string) => JSON.stringify([fs.readFileSync(manifestFile(dir), 'utf8'), fs.readFileSync(lockFile(dir), 'utf8'), shown(path.join(dir, 'packages')), shown(dirs.game), shown(dirs.lib)]);

section('out of date: the newer versions of what a package uses, with their notes');
{
  // nordic/rocks 1.1; studio/trees moves to it with an update of its own, then publishes 1.2 (a wider crown and a
  // stump) and 1.3 (taller by default)
  write(path.join(ROCKS, 'inputs', 'rock.obj'), triangle(2.5));
  check((await publish(ROCKS, 'a bigger rock')).version === '1.1', 'nordic/rocks 1.1');
  const t = await open(TREES);
  const own = applyUpdate(t.pk, 'nordic/rocks', { from: '1.0', to: '1.1' });
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
  check(of('studio/trees').small === '1.3' && !of('studio/trees').big && of('studio/trees').newer.map((v) => `${v.version} ${v.note}`).join(' | ') === '1.2 a wider crown, and a stump | 1.3 taller by default' && of('studio/trees').places.join() === 'library "game"',
    `studio/trees 1.1: the small update and the versions after it, with their notes (${JSON.stringify(of('studio/trees'))?.slice(0, 160)})`);
  check(of('nordic/rocks').small === '1.1' && !of('studio/grove').small && !of('studio/grove').big && of('studio/grove').newer.length === 0 && !of('studio/rules').small, 'the others: a small update of nordic/rocks, grove and rules up to date');
  const said = outdatedText(o.pk);
  check(/^package forest uses 4 packages: 2 out of date, 2 up to date\n/.test(said) && /\n {2}studio\/trees 1\.1: 1\.3 is out {2}\[library "game"\]\n {4}1\.2 {2}"a wider crown, and a stump"\n {4}1\.3 {2}"taller by default"/.test(said)
    && /\n2 up to date: studio\/grove 1\.0, studio\/rules 7\.1\n/.test(said) && !/ {2}studio\/grove 1\.0:/.test(said)
    && /\ntopotopo update studio\/trees shows the before\/after of 1\.1 → 1\.3; nothing changes until you apply it/.test(said) && /\ntopotopo update nordic\/rocks shows the before\/after of 1\.0 → 1\.1/.test(said),
    `outdated lists only what is out of date, one line for the rest, and the update to run for each:\n${said}`);
  const listed = packagesText(o.pk);
  check(/\nuses 4 packages: 2 out of date, 2 up to date\n/.test(listed) && /\n {2}studio\/trees 1\.1 {2}1 output {2}1\.3 is out\n/.test(listed), `packages says on each line what is out of date:\n${listed}`);
  check(/\n {2}workspace \{action:"update", package:"studio\/trees"\} shows the before\/after of 1\.1 → 1\.3; nothing changes until the person says so|\nworkspace \{action:"update", package:"studio\/trees"\} shows the before\/after of 1\.1 → 1\.3/.test(outdatedText(o.pk, true)), 'the workspace tool says it as an action');
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
  check(/this package does not use studio\/oaks: its uses are nordic\/rocks, studio\/grove, studio\/rules, studio\/trees/.test(await rejection(beforeAfter(o.pk, 'studio/oaks'))), 'a package it does not use');
  check(/studio\/grove 1\.0 is the newest version in library "game": there is nothing to update/.test(await rejection(beforeAfter(o.pk, 'studio/grove'))), 'a package that is up to date');
  check(/library "game" has no studio\/trees 1\.9: it has 1\.0, 1\.1, 1\.2, 1\.3/.test(await rejection(beforeAfter(o.pk, 'studio/trees', { to: '1.9' }))) && /this package uses studio\/trees 1\.1 already/.test(await rejection(beforeAfter(o.pk, 'studio/trees', { to: '1.1' }))),
    'a version its place does not have, and the version in use');
  const was = untouched(dirs.forest);
  const steps: string[] = [];
  const r = await beforeAfter(o.pk, 'studio/trees', { progress: (done, total, what) => steps.push(`${done}/${total} ${what}`) });
  check(r.target.from === '1.1' && r.target.to === '1.3' && !r.target.big && r.target.library === 'game' && r.target.between.map((v) => v.version).join() === '1.2,1.3', `without "to": the newest version with the same big number, ${r.target.from} → ${r.target.to}`);
  check(r.uses.map((u) => `${u.file} ${u.node}`).join(' | ') === 'graphs/loop.json loop/t | graphs/main.json b | assets/twin.json t | scene.json t',
    `every place the package uses it: graphs, a nested graph, an asset, a graph file (${r.uses.map((u) => `${u.file} ${u.node}`).join(' | ')})`);
  check(r.compared.map((c) => c.node).join() === 'loop,b,t,t' && r.compared.every((c) => c.before.ok && c.after.ok && c.diff && !c.diff.identical),
    `each cooked with both versions and compared; a use in a nested graph through the node that holds it (${r.compared.map((c) => `${c.file} ${c.node}: ${c.after.errors.join(';') || (c.diff?.identical ? 'same' : 'changed')}`).join(' | ')})`);
  const main = r.compared.find((c) => c.file === 'graphs/main.json')!;
  check(/^counts: points/m.test(main.diff!.text) && /^bbox delta:/m.test(main.diff!.text) && /^attributes:/m.test(main.diff!.text) && /^verdict: shape changed by up to/m.test(main.diff!.text), 'what changed: counts, size, attributes, the largest move');
  check(steps.length === 8 && steps[0] === '0/8 graphs/loop.json loop with studio/trees 1.1' && steps[7] === '7/8 scene.json t with studio/trees 1.3', `progress before each cook (${steps[0]} … ${steps[7]})`);
  check(untouched(dirs.forest) === was && readManifest(dirs.forest).uses['studio/trees'] === '1.1', 'nothing is written: the manifest, the lock, the copies and the libraries are as they were');
  const text = beforeAfterText(r, 'nothing was written');
  check(/^before\/after: studio\/trees 1\.1 → 1\.3 \(a small update\) in package forest; nothing has changed yet\nstudio\/trees 1\.3 is in library "game"\. The versions after 1\.1:\n {2}1\.2 {2}"a wider crown, and a stump"\n {2}1\.3 {2}"taller by default"/.test(text)
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
  const a = applyUpdate(o.pk, 'studio/trees', { from: '1.1', to: '1.3' });
  const lock = readLock(dirs.forest);
  check(a.target.to === '1.3' && JSON.stringify(readManifest(dirs.forest).uses) === '{"nordic/rocks":"1.0","studio/grove":"1.0","studio/rules":"7.1","studio/trees":"1.3"}', `applied: forest.topo uses studio/trees 1.3 (${a.text.split('\n')[0]})`);
  check(Object.keys(lock.packages['studio/trees']).join() === '1.0,1.3' && Object.keys(lock.packages['nordic/rocks']).join() === '1.0,1.1' && lock.packages['studio/trees']['1.3'].library === 'game',
    'the lock: trees 1.3 and the rocks 1.1 it uses; trees 1.0 and rocks 1.0, which grove and the package still use, stay');
  check(exists(dirs.forest, 'packages', 'studio', 'trees', '1.3', 'version.json') && exists(dirs.forest, 'packages', 'nordic', 'rocks', '1.1', 'version.json') && !exists(dirs.forest, 'packages', 'studio', 'trees', '1.1')
    && exists(dirs.forest, 'packages', 'studio', 'trees', '1.0', 'version.json') && exists(dirs.forest, 'packages', 'nordic', 'rocks', '1.0', 'version.json'), 'the copies: 1.3 and what it uses copied in, 1.1 deleted, the dependencies still used kept');
  check(/^updated studio\/trees 1\.1 → 1\.3 in package forest: forest\.topo uses studio\/trees 1\.3, from library "game"\n {2}copied into packages\/: nordic\/rocks 1\.1, studio\/trees 1\.3; packages\/lock\.json records them\n {2}deleted the copies nothing uses any more: studio\/trees 1\.1$/.test(a.text), `it says what it did:\n${a.text}`);
  const cooked = await o.engine.cook(o.ws.getGraph('main'));
  check(cooked.ok && top(cooked) === 7.8 && o.pk.verifyCopies().length === 0, `the package cooks with 1.3 at once (top ${top(cooked)}), and its copies check`);
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
  check(p2.version === '2.0' && p2.bigBecause.some((b) => /param "height" removed/.test(b)), `studio/trees 2.0, big: ${p2.bigBecause.join('; ')}`);
  // the yard uses the stump and wires the ground input
  setGraph(dirs.forest, 'yard', { nodes: { g: { type: 'grid', params: { size: [10, 10] } }, p: { type: 'studio/trees/pine', in: ['g'], params: { height: 2 } }, s: { type: 'studio/trees/stump' }, out: { type: 'merge', in: ['p', 's'] } }, output: 'out' });
  const o = await open(dirs.forest);
  check(o.pk.outdated().find((x) => x.package === 'studio/trees')?.big === '2.0', 'outdated names the big update');
  check(/studio\/trees 1\.3 is the newest 1\.x in library "game", and 2\.0 is a big version, a step of its own: name it, topotopo update studio\/trees --to 2\.0 \(workspace \{action:"update", package:"studio\/trees", to:"2\.0"\}\)/.test(await rejection(beforeAfter(o.pk, 'studio/trees'))),
    'without "to", a big version is not taken: it says how to name it');
  const was = untouched(dirs.forest);
  const r = await beforeAfter(o.pk, 'studio/trees', { to: '2.0' });
  check(r.target.big && r.interfaceBig.some((x) => /output "pine": param "height" removed/.test(x)) && r.interfaceBig.some((x) => /input 0 \("ground"\) removed/.test(x)) && r.interfaceBig.some((x) => /output "stump" removed/.test(x)),
    `what goes away in 2.0: ${r.interfaceBig.join('; ')}`);
  const must = r.mustChange.join('\n');
  check(/^graphs\/loop\.json loop\/t: sets param "height", which studio\/trees 2\.0 does not have — did you mean "trunk_height"\? \(its params: trunk_height\)$/m.test(must)
    && /^graphs\/main\.json b: sets param "height"/m.test(must) && /^assets\/twin\.json t: sets param "height"/m.test(must) && /^graphs\/yard\.json p: sets param "height"/m.test(must),
    'params the graphs set that 2.0 does not have, with did-you-mean');
  check(/^graphs\/yard\.json p: wires input 0 \("ground"\), which studio\/trees 2\.0 does not have \(it has 0 inputs\)$/m.test(must), 'inputs they wire that are gone');
  check(/^graphs\/yard\.json s: uses studio\/trees\/stump, and studio\/trees 2\.0 has no output "stump"/m.test(must) && !/scene\.json/.test(must) && r.mustChange.length === 6, `outputs they use that are gone; nothing for a use that sets nothing (${r.mustChange.length}):\n${must}`);
  const main = r.compared.find((c) => c.file === 'graphs/main.json')!, scene = r.compared.find((c) => c.file === 'scene.json')!;
  check(main.before.ok && !main.after.ok && /unknown param "height" for studio\/trees\/pine — did you mean "trunk_height"/.test(main.after.errors.join()) && scene.after.ok && !!scene.diff,
    'with 2.0 a use that must change does not cook, the others are compared');
  const text = beforeAfterText(r, 'nothing was written');
  check(/\(a big update\)/.test(text) && /\n2\.0 is a big version; what goes away or means something else:\n/.test(text) && /\nwhat the package's graphs must change \(updating is allowed; until they change, they report these errors\):\n/.test(text) && /with 2\.0 it does not cook: \[b\] unknown param "height"/.test(text),
    'the before/after says it');
  check(untouched(dirs.forest) === was, 'nothing written');
  // applying is allowed: the graphs then report what they must change
  const a = applyUpdate(o.pk, 'studio/trees', { from: '1.3', to: '2.0' });
  check(readManifest(dirs.forest).uses['studio/trees'] === '2.0' && /deleted the copies nothing uses any more: nordic\/rocks 1\.1, studio\/trees 1\.3/.test(a.text) && !exists(dirs.forest, 'packages', 'nordic', 'rocks', '1.1') && exists(dirs.forest, 'packages', 'nordic', 'rocks', '1.0', 'version.json'),
    `applied: 1.3 and the rocks 1.1 only it used are deleted, rocks 1.0 stays (${a.text.split('\n')[2]})`);
  check(/the package's graphs must change for studio\/trees 2\.0; until they do, they report these errors:\n {2}graphs\/loop\.json loop\/t: sets param "height"/.test(a.text) && a.mustChange.length === 6, 'applying says what the graphs must change');
  const cooked = await o.engine.cook(o.ws.getGraph('main'));
  check(!cooked.ok && /unknown param "height" for studio\/trees\/pine — did you mean "trunk_height"/.test(errorOf(cooked)), `the graphs report it until they change: ${errorOf(cooked)}`);
  const back = await beforeAfter(o.pk, 'studio/trees', { to: '1.3' }), backText = beforeAfterText(back, '');
  check(/\(back to an older big version\)/.test(backText) && /\ngoing back to 1\.3 crosses a big version; what goes away or means something else:\n {2}output "pine": param "trunk_height" removed\n/.test(backText) && !back.mustChange.length,
    'going back across a big version says what goes away, and the graphs, which set "height", need no change for it');
  // a package it uses only through another
  const user = path.join(dirs.repo, 'grove-user');
  writePackage(user, {}, {});
  const u = await open(user);
  u.pk.use('studio/grove');
  check(/this package does not use studio\/trees itself \(studio\/grove 1\.0 uses studio\/trees 1\.0\): a version keeps what it uses/.test(await rejection(beforeAfter(u.pk, 'studio/trees'))), 'a package used only through another says so');
}

section('Update: values the new version clamps, and options it no longer has, are what the graphs must change');
{
  const CLAMP = path.join(dirs.lib, 'clamp');
  const g = (max: number, options: string[]): GraphSpec => ({
    nodes: { b: { type: 'box', params: { size: ['=h', 1, 1] } }, t: { type: 'transform', in: ['b'], params: { translate: ['=look == "round" ? 1 : 0', 0, 0] } } },
    output: 't', vars: { h: 2, look: 'square' }, params: { h: { type: 'float', min: 0, max }, look: { type: 'enum', options } }, outputs: { block: { node: 't', kind: 'mesh', tags: ['block'] } },
  });
  writePackage(CLAMP, { name: 'studio/clamp' }, { main: g(30, ['square', 'round']) });
  check((await publish(CLAMP, 'blocks')).version === '1.0', 'studio/clamp 1.0');
  const USER = path.join(dirs.repo, 'clamp-user');
  writePackage(USER, {}, { main: { nodes: { hero: { type: 'studio/clamp/block', params: { h: 18, look: 'round' } }, low: { type: 'studio/clamp/block', params: { h: 4 } } }, output: 'hero' } });
  const u = await open(USER);
  u.pk.use('studio/clamp');
  setGraph(CLAMP, 'main', g(15, ['square']));
  const v2 = await publish(CLAMP, 'shorter, square only');
  check(v2.version === '2.0' && v2.bigBecause.some((b) => /param "h" range 0\.\.30 → 0\.\.15 \(narrower\)/.test(b)) && v2.bigBecause.some((b) => /param "look" lost option "round"/.test(b)), `2.0: ${v2.bigBecause.join('; ')}`);
  const r = await beforeAfter(u.pk, 'studio/clamp', { to: '2.0' });
  check(r.mustChange.includes('graphs/main.json hero: sets "h" 18, which studio/clamp 2.0 clamps to 15 (its range is 0..15)') && r.mustChange.includes('graphs/main.json hero: sets "look" "round", an option studio/clamp 2.0 does not have (its options: "square")')
    && !r.mustChange.some((m) => /low/.test(m)), `per place: a value the narrower range clamps, an option that is gone (${r.mustChange.join(' | ')})`);
}

section('build and edit add a package only for a graph that validates; nothing is written for one they reject');
{
  const REJ = path.join(dirs.repo, 'rejected');
  writePackage(REJ, {}, { main: { nodes: { b: { type: 'box' } }, output: 'b' } });
  const o = await open(REJ);
  const was = fs.readFileSync(manifestFile(REJ), 'utf8');
  const tools = makeTools(o.ws), build = tools.find((t) => t.name === 'build')!, edit = tools.find((t) => t.name === 'edit')!;
  const said = (await build.run({ graph: { nodes: { r: { type: 'nordic/rocks/boulderr' } }, output: 'r' } })).content.map((c: any) => c.text ?? '').join('\n');
  check(/^✗ graph not saved/.test(said) && /nordic\/rocks 1\.1 has no output "boulderr" — did you mean boulder\?/.test(said) && fs.readFileSync(manifestFile(REJ), 'utf8') === was && !exists(REJ, 'packages'),
    `a build rejected for a wrong output name adds nothing and copies nothing: ${said.split('\n')[1]}`);
  const ed = (await edit.run({ ops: [{ op: 'add', node: 'r', type: 'nordic/rocks/boulder', params: { sizee: 2 } }] })).content.map((c: any) => c.text ?? '').join('\n');
  check(/edits rejected/.test(ed) && /unknown param "sizee"/.test(ed) && fs.readFileSync(manifestFile(REJ), 'utf8') === was && !exists(REJ, 'packages'), `so does a rejected edit: ${ed.split('\n')[1]}`);
  const assets = tools.find((t) => t.name === 'assets')!;
  const saveBad = await assets.run({ action: 'save', name: 'pile', graph: { nodes: { r: { type: 'nordic/rocks/nope' } }, output: 'r' } }).catch((e: any) => ({ content: [{ text: String(e.message) }] }));
  check(/asset graph invalid/.test(saveBad.content.map((c: any) => c.text ?? '').join('')) && !exists(REJ, 'assets', 'pile.json') && fs.readFileSync(manifestFile(REJ), 'utf8') === was, 'and a rejected asset');
  const ok = (await build.run({ graph: { nodes: { r: { type: 'nordic/rocks/boulder' } }, output: 'r' } })).content.map((c: any) => c.text ?? '').join('\n');
  check(/added nordic\/rocks 1\.1 to package rejected/.test(ok) && readManifest(REJ).uses['nordic/rocks'] === '1.1', 'a build that validates adds it');
}

section('publishing cooks the package as a package that uses it does, in its own scope');
{
  // the package's own bark asset is a box; a package opened on a folder inside the package has a bark of its own that
  // cooks to nothing: publishing cooks the package's, so it publishes
  const NEST = path.join(dirs.lib, 'nest');
  writePackage(NEST, { name: 'studio/nest' }, { main: { nodes: { b: { type: 'bark' } }, output: 'b', outputs: { bark: { node: 'b', kind: 'mesh', tags: ['bark'] } } } }, {
    'assets/bark.json': JSON.stringify({ nodes: { b: { type: 'box' } }, output: 'b' }),
    'levels/assets/bark.json': JSON.stringify({ nodes: { b: { type: 'box' }, d: { type: 'delete', in: ['b'], params: { group: '*' } } }, output: 'd' }),
  });
  const o = await open(path.join(NEST, 'levels'));
  check(o.pk.dir === NEST && !(await o.engine.cook({ nodes: { b: { type: 'bark' } } })).geo?.numPrims, 'a package inside the package has a bark of its own, which cooks to nothing');
  const p = await publishPackage(o.pk, { note: 'nested' });
  check(p.ok && p.version === '1.0' && p.outputs?.bark.kind === 'mesh', `publishing cooks the package's own bark: ${p.blocks.join('; ') || p.version}`);
}

section('two writers: the package\'s lock around its manifest and packages/lock.json');
{
  const TWO = path.join(dirs.repo, 'two');
  writePackage(TWO, {}, {});
  const lockAt = path.join(TWO, 'packages', '.lock');
  // a lock left behind by a process that ended is taken over
  write(lockAt, '999999 2026-01-01T00:00:00Z\n');
  const a = await open(TWO);
  check(/^added nordic\/rocks/.test(a.pk.use('nordic/rocks').text) && !fs.existsSync(lockAt), 'a lock left by a process that ended is taken over, and released after');
  // another process holds it: a write waits for it, and loses nothing
  const held = path.join(tmp, 'two-held');
  const script = `import { withPackageLock } from ${JSON.stringify(new URL('../src/package.ts', import.meta.url).href)};
import fs from 'node:fs';
withPackageLock(${JSON.stringify(TWO)}, () => { const m = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(TWO, 'two.topo'))}, 'utf8')); m.title = 'held'; fs.writeFileSync(${JSON.stringify(path.join(TWO, 'two.topo'))}, JSON.stringify(m)); fs.writeFileSync(${JSON.stringify(held)}, 'x'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200); });`;
  const child = (await import('node:child_process')).spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' });
  const t0 = Date.now();
  while (!fs.existsSync(held) && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 20));
  const t1 = Date.now();
  const r = a.pk.use('studio/rules');
  const waited = Date.now() - t1;
  await new Promise((r) => child.on('exit', r));
  check(/^added studio\/rules/.test(r.text) && waited > 300 && readManifest(TWO).title === 'held' && readManifest(TWO).uses['studio/rules'] && readManifest(TWO).uses['nordic/rocks'],
    `a write waits while another process holds the lock (${waited} ms), and keeps that process's change`);
}

section('the CLI: outdated, update and --apply');
{
  const CLI = path.join(dirs.repo, 'cliproj');
  const od = await run('outdated', [CLI]);
  check(od.code === 0 && /^package cliproj uses 1 package: 1 out of date\n {2}nordic\/rocks 1\.0: 1\.1 is out {2}\[library "lib"\]\n {4}1\.1 {2}"a bigger rock"/.test(od.out)
    && new RegExp(`\\ntopotopo update nordic/rocks ${CLI.replace(/[\\.]/g, '\\$&')} shows the before/after of 1\\.0 → 1\\.1; nothing changes until you apply it$`).test(od.out), `outdated, and the update to run:\n${od.out}`);
  const was = untouched(CLI);
  const renders = path.join(tmp, 'renders');
  const ba = await run('update', ['nordic/rocks', CLI, '--render', renders]);
  check(ba.code === 0 && /^before\/after: nordic\/rocks 1\.0 → 1\.1 \(a small update\) in package cliproj/.test(ba.out) && /graphs\/main\.json {2}r: nordic\/rocks\/boulder \{"size":2\}/.test(ba.out) && /\[1\/2\] graphs\/main\.json r with nordic\/rocks 1\.0/.test(ba.err),
    `update shows the before/after, progress on stderr:\n${ba.out.split('\n').slice(0, 4).join('\n')}`);
  check(new RegExp(`nothing was written\\. To apply it: topotopo update nordic/rocks ${CLI.replace(/[\\.]/g, '\\$&')} --from 1\\.0 --to 1\\.1 --apply`).test(ba.out), 'and how to apply it');
  check(fs.existsSync(renders) && fs.readdirSync(renders).join() === '01-graphs_main.json_r.png' && untouched(CLI) === was, `--render writes the overlay renders, and nothing else is written (${fs.existsSync(renders) ? fs.readdirSync(renders) : 'none'})`);
  const bare = await run('update', ['nordic/rocks', CLI, '--apply']);
  check(bare.code === 1 && /--apply needs --from and --to/.test(bare.err) && readManifest(CLI).uses['nordic/rocks'] === '1.0', `--apply needs the versions of the before/after: ${bare.err.split('\n')[0]}`);
  const stale = await run('update', ['nordic/rocks', CLI, '--from', '0.9', '--to', '1.1', '--apply']);
  check(stale.code === 1 && /cliproj\.topo uses nordic\/rocks 1\.0 now, not 0\.9: look at the before\/after again/.test(stale.err), 'and refuses another version in use than the one it showed');
  const ap = await run('update', ['nordic/rocks', CLI, '--from', '1.0', '--to', '1.1', '--apply']);
  check(ap.code === 0 && /^updated nordic\/rocks 1\.0 → 1\.1 in package cliproj/.test(ap.out) && readManifest(CLI).uses['nordic/rocks'] === '1.1' && !exists(CLI, 'packages', 'nordic', 'rocks', '1.0'), `--apply applies it: ${ap.out.split('\n')[0]}`);
  const none = await run('update', ['nordic/rocks', CLI]);
  check(none.code === 0 && /nordic\/rocks 1\.1 is the newest version in library "lib": there is nothing to update/.test(none.out), `nothing newer is no failure: ${none.out.trim()}`);
  const form = await run('update', ['nordic/rocks', CLI, '--to', '2']);
  check(form.code === 1 && /"2" is not a version: write big\.small, such as 2\.0/.test(form.err), `--to 2 says the form: ${form.err}`);
  const usage = await run('update', []);
  check(usage.code === 1 && /usage: topotopo update owner\/name \[folder\]/.test(usage.err), 'update without a package says how to use it');
}

section('the workspace tool: the shared libraries of the open package\'s workspace, changed when the person says so; a broken config stops only the actions on registered libraries');
{
  const LT = path.join(dirs.valley, 'levels', 'tool-package');
  writePackage(LT, {}, {});
  const o = await open(LT);
  const tool = workspaceTool({ session: () => o.ws, packages: () => o.pk, open: async () => ({ graphs: 0, assets: 0 }) });
  const say = async (a: any) => { try { const r = await tool.run(a); return { err: !!r.isError, text: r.content.map((c: any) => c.text ?? '').join('\n') }; } catch (e: any) { return { err: true, text: String(e.message) }; } };
  const wsFile = path.join(dirs.valley, 'topotopo-workspace.json');
  const set = await say({ action: 'set', libraries: ['game'] });
  check(set.err && /"libraries" is no longer set on a package: the workspace lists the shared libraries its packages use \(workspace \{action:"libraries", add:"<name or folder>"\}/.test(set.text) && !('libraries' in readJSON(manifestFile(LT))),
    `set {libraries} is refused, saying where it went: ${set.text}`);
  const shownLibs = await say({ action: 'libraries' });
  check(!shownLibs.err && /^the workspace "valley" lists "lib" in .*topotopo-workspace\.json "libraries"\nits packages find packages in the workspace itself, then in library "lib"/.test(shownLibs.text), `libraries alone says what the workspace lists: ${shownLibs.text}`);
  const added = await say({ action: 'libraries', add: 'game' });
  check(!added.err && JSON.stringify(readJSON(wsFile).libraries) === '["lib","game"]' && !(await say({ action: 'use', package: 'studio/grove' })).err, `libraries {add} writes the workspace file, and the library serves its packages: ${added.text.split('\n')[0]}`);
  check((await say({ action: 'libraries', add: '/abs/lib' })).err && JSON.stringify(readJSON(wsFile).libraries) === '["lib","game"]', 'an entry of the wrong form is refused, and nothing is written');
  check((await say({ action: 'libraries', add: 'game', remove: 'game' })).err, 'add or remove, not both');
  const removed = await say({ action: 'libraries', remove: 'game' });
  check(!removed.err && JSON.stringify(readJSON(wsFile).libraries) === '["lib"]', 'libraries {remove} unlists it');
  const outside = workspaceTool({ session: () => ({ dir: dirs.forest }) as any, packages: () => o.pk, open: async () => ({ graphs: 0, assets: 0 }) });
  check(/is in no workspace: its package finds packages in every registered library \("game", "lib", "other"\)/.test((await outside.run({ action: 'libraries' })).content.map((c: any) => c.text).join()), 'outside a workspace: every registered library counts');
  const cfg = process.env.TOPOTOPO_CONFIG!, broken = path.join(tmp, 'broken-config.json');
  write(broken, '{ not json');
  process.env.TOPOTOPO_CONFIG = broken;
  try {
    const pk = await say({ action: 'packages' }), od = await say({ action: 'outdated' }), list = await say({ action: 'list' });
    check(!pk.err && /uses \d+ packages?/.test(pk.text) && !od.err && list.err && /broken-config\.json/.test(list.text),
      `with a config that cannot be read, the packages in use still work and the list of registered libraries says why it cannot (${list.text.slice(0, 80)})`);
  } finally { process.env.TOPOTOPO_CONFIG = cfg; }
}

section('textures of two packages under the same image names stay apart when their outputs are merged');
{
  // two packages each call their base colour map "basecolor": a red locker, a blue compressor
  const piece = (pkg: string, material: string, color: string): GraphSpec => ({
    nodes: {
      b: { type: 'box' }, uv: { type: 'uv_project', in: ['b'], params: { method: 'box' } },
      basecolor: { type: 'tex_constant', params: { resolution: 8, channels: 'rgba', color } },
      m: { type: 'texture_to_material', in: ['uv', 'basecolor'], params: { material, base_color: 'basecolor' } },
    },
    output: 'm', outputs: { piece: { node: 'm', label: pkg, kind: 'mesh', tags: ['prop'], description: `a ${material}` } },
  });
  const LOCKERS = path.join(dirs.game, 'lockers'), COMPRESSOR = path.join(dirs.game, 'compressor');
  writePackage(LOCKERS, { name: 'studio/lockers' }, { main: piece('lockers', 'locker', '#ff0000') });
  writePackage(COMPRESSOR, { name: 'studio/compressor' }, { main: piece('compressor', 'compressor', '#0000ff') });
  check((await publish(LOCKERS, 'lockers')).ok && (await publish(COMPRESSOR, 'compressor')).ok, 'two packages published, both with an image "basecolor"');
  const HALL = path.join(dirs.repo, 'hall');
  writePackage(HALL, {}, { main: { nodes: { b: { type: 'box' } }, output: 'b' } });
  const o = await open(HALL);
  o.pk.use('studio/lockers');
  o.pk.use('studio/compressor');
  const { exportGeometryAsync } = await import('../src/io/export.ts');
  const { decodePNG } = await import('../src/io/png-decode.ts');
  const { referenceableImages } = await import('../src/core/image.ts');
  const { mergeMaterialTables } = await import('../src/core/materials.ts');
  const red = (img: any) => img.layer('C')[0] > 0.9 && img.layer('C')[2] < 0.1, blue = (img: any) => img.layer('C')[2] > 0.9 && img.layer('C')[0] < 0.1;
  for (const packed of [false, true]) {
    const at = (n: string, x: number): Record<string, any> => packed
      ? { [`${n}_p`]: { type: 'pack', in: [n], params: { by: 'all' } }, [`${n}_at`]: { type: 'transform', in: [`${n}_p`], params: { translate: [x, 0, 0] } } }
      : { [`${n}_at`]: { type: 'transform', in: [n], params: { translate: [x, 0, 0] } } };
    const r = await o.engine.cook({ nodes: { a: { type: 'studio/lockers/piece' }, a2: { type: 'studio/lockers/piece' }, c: { type: 'studio/compressor/piece' }, ...at('a', 0), ...at('a2', 4), ...at('c', 2), out: { type: 'merge', in: ['a_at', 'c_at', 'a2_at'] } }, output: 'out' });
    const label = packed ? 'packed' : 'merged';
    if (!r.ok || !r.geo) { check(false, `${label}: ${errorOf(r)}`); continue; }
    const g = r.geo, table = mergeMaterialTables([g, ...g.packedSources]), imgs = referenceableImages(g);
    const ref = (m: string) => String(table[m]?.textures?.baseColor ?? '').replace(/^image:/, '');
    check(ref('locker') && ref('compressor') && ref('locker') !== ref('compressor') && red(imgs.get(ref('locker'))) && blue(imgs.get(ref('compressor'))) && imgs.size === 2,
      `${label}: each material keeps its own map (locker → "${ref('locker')}", compressor → "${ref('compressor')}"; ${imgs.size} images, the two lockers share one)`);
    const glb = await exportGeometryAsync(g, 'glb');
    const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength), jlen = dv.getUint32(12, true);
    const j = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jlen))), bin = 20 + jlen + 8;
    const texOf = (m: string) => j.textures[j.materials.find((x: any) => x.name === m).pbrMetallicRoughness.baseColorTexture.index].source;
    const pixel = (i: number) => { const bv = j.bufferViews[j.images[i].bufferView]; const png = decodePNG(glb.subarray(bin + (bv.byteOffset ?? 0), bin + (bv.byteOffset ?? 0) + bv.byteLength)); return [png.data[0], png.data[2]]; };
    const [lr, lb] = pixel(texOf('locker')), [cr, cb] = pixel(texOf('compressor'));
    check(j.images.length === 2 && texOf('locker') !== texOf('compressor') && lr === 255 && lb === 0 && cr === 0 && cb === 255 && new Set(j.images.map((i: any) => i.uri ?? i.name)).size === 2,
      `${label} GLB: two images with their own names (${j.images.map((i: any) => i.name).join(', ')}), the locker red and the compressor blue`);
  }
}

section('a follow policy: the used packages whose working folder it accepts');
{
  const g = await open(GROVE);
  if (readManifest(GROVE).uses['studio/trees'] === undefined) g.pk.use('studio/trees');
  const by = g.pk.setFollowPolicy((w) => path.resolve(w.dir).toLowerCase().startsWith(path.resolve(dirs.game).toLowerCase()));
  check(by.includes('studio/trees') && g.pk.following().some((f) => f.package === 'studio/trees' && path.resolve(f.dir) === path.resolve(TREES)),
    `a policy follows the used packages whose working folders it accepts (${by.join(', ')})`);
  check(!g.pk.setFollowPolicy(() => false).length && !g.pk.following().length, 'a policy that accepts none follows none');
  check(!g.pk.setFollowPolicy(null).length, 'null stops it');
}

section('the places in order: precedence, two folders of one name, "topotopo/…" elsewhere, a folder reached twice');
{
  const box = (h: number): GraphSpec => ({ nodes: { b: { type: 'box', params: { size: [1, h, 1] } } }, output: 'b', outputs: { block: { node: 'b', kind: 'mesh', tags: ['block'], description: 'A block.' } } });
  // the workspace comes before the library it lists: a package of the workspace named studio/rules is the one used
  const LOCAL = path.join(dirs.valley, 'assets', 'rules-local');
  writePackage(LOCAL, { name: 'studio/rules' }, { main: box(3) });
  check((await publish(LOCAL, 'the workspace\'s own rules')).version === '1.0', 'a package of the workspace publishes studio/rules 1.0 (library "lib" has 7.1)');
  const y = await open(YARD);
  const rules = y.pk.use('studio/rules');
  const label = readJSON(path.join(dirs.valley, 'topotopo-packages', 'lock.json')).packages['studio/rules']['1.0'].library;
  check(/^added studio\/rules 1\.0 to workspace "valley" .*from the workspace "valley"/.test(rules.text) && label === '.', `the workspace before the library it lists; the lock names the workspace by its path from its store, "." (${rules.text.split(':')[0]}; ${label})`);
  const listed = packagesText(y.pk);
  check(/\n {2}studio\/rules 1\.0 {2}1 output {2}up to date; also in library "lib", not used\n/.test(listed), `packages says the later place has it too, not used:\n${listed.split('\n').find((l) => /studio\/rules/.test(l))}`);
  const hits = searchPackages(YARD, { tag: 'block' }).libraries;
  check(hits[0].name === 'valley' && hits[0].hits.some((h) => h.package === 'studio/rules' && h.also?.join() === 'library "lib"') && !hits[1].hits.some((h) => h.package === 'studio/rules'),
    'search finds it in the workspace, says the library has it too, and lists no hit for the copy not used');
  // a publishing package inside the workspace keeps its own copies: the lock names the workspace by its path from it
  const c = await open(CRATE);
  c.pk.use('studio/rules');
  check(readLock(CRATE).packages['studio/rules']['1.0'].library === '../../..', `a publishing package's own store names the workspace by its path to the workspace's root (${readLock(CRATE).packages['studio/rules']['1.0'].library})`);
  // two folders of one place publishing one name: the name is left out, both named, and publishing blocks
  const TWIN = path.join(dirs.valley, 'assets', 'props', 'crate-twin');
  writePackage(TWIN, { name: 'valley/crate' }, { main: box(1) });
  forgetScans();
  const clash = errorText(() => y.pk.use('valley/crate'));
  check(/^valley\/crate is published by two folders of the workspace "valley", .*crate and .*crate-twin: TopoTopo never picks one, so the name is not used until one is renamed/.test(clash), `two folders of one name: ${clash}`);
  const blocked = await publish(CRATE, 'first crate');
  check(!blocked.ok && blocked.blocks.some((b) => /crate-twin in the workspace "valley" publishes as valley\/crate too: one name, one folder per workspace or library/.test(b)), `publishing blocks while another folder holds its name: ${blocked.blocks.join(' | ')}`);
  fs.rmSync(TWIN, { recursive: true });
  check((await publish(CRATE, 'first crate')).ok && /^added valley\/crate 1\.0 to workspace "valley"/.test(y.pk.use('valley/crate').text), 'one folder again: it publishes, and the workspace\'s packages find it by themselves');
  // a package named "topotopo/…" outside the built-in library is left out, said
  const FAKE = path.join(dirs.valley, 'assets', 'fake');
  writePackage(FAKE, { name: 'topotopo/props' }, { main: box(1) });
  forgetScans();
  const said = packagesText(y.pk);
  check(/the workspace "valley": assets\/fake publishes as topotopo\/props, and the packages named "topotopo\/…" are TopoTopo's built-in library's: it is left out/.test(said) && y.pk.catalog().find((x) => x.package === 'topotopo/props')?.place === 'TopoTopo\'s built-in library',
    'a package named "topotopo/…" outside the built-in library is ignored with a problem; the name stays the built-in library\'s');
  fs.rmSync(FAKE, { recursive: true });
  // a registered library inside another registered library counts once, in the first; one inside the workspace is refused as a listed library
  const SUB = path.join(dirs.lib, 'sublib');
  writePackage(path.join(SUB, 'pebble'), { name: 'studio/pebble' }, { main: box(0.2) });
  addLibrary('sublib', SUB);
  addLibrary('valleylib', path.join(dirs.valley, 'assets'));
  try {
    const f = await open(dirs.forest);
    const pebble = f.pk.catalog().filter((x) => x.package === 'studio/pebble');
    check(pebble.length === 1 && pebble[0].place === 'library "lib"' && !pebble[0].also.length, `a package reached through two registered libraries counts once, in the first (${pebble.map((x) => `${x.place} also ${x.also}`)})`);
    const inWs = resolveListed(dirs.valley, ['valleylib']);
    check(!inWs.libs.length && /"valleylib" is inside the workspace \(.*\): its packages are found by themselves; remove it from "libraries"/.test(inWs.problems[0] ?? ''), `a listed library inside the workspace is a problem and skipped (${inWs.problems[0]})`);
    const add = await run('workspace', ['library', 'add', 'valleylib', '--workspace', dirs.valley]);
    check(add.code === 1 && /library "valleylib" \(.*\) is inside the workspace: its packages are found by themselves/.test(add.err), `workspace library add refuses it: ${add.err}`);
  } finally {
    const { removeLibrary } = await import('../src/config.ts');
    removeLibrary('sublib');
    removeLibrary('valleylib');
    fs.rmSync(SUB, { recursive: true });
  }
}

section('a library from its own checkout: a package outside a workspace finds its siblings in its own worktree first');
{
  // the library "shared" registered at its main checkout; a second checkout (a worktree) of it with its own library.json
  const MAIN = path.join(tmp, 'shared-main'), WT = path.join(tmp, 'shared-wt');
  const block = (h: number): GraphSpec => ({ nodes: { b: { type: 'box', params: { size: [1, h, 1] } } }, output: 'b', outputs: { block: { node: 'b', kind: 'mesh', tags: ['block'], description: 'A block.' } } });
  for (const [root, h] of [[MAIN, 1], [WT, 2]] as [string, number][]) {
    json(path.join(root, 'library.json'), { name: 'shared' });
    writePackage(path.join(root, 'base'), { name: 'shared/base' }, { main: block(h) });
    check((await publish(path.join(root, 'base'), `base ${h}`)).ok, `shared/base 1.0 in ${path.basename(root)}`);
  }
  addLibrary('shared', MAIN);
  try {
    const user = path.join(WT, 'user');
    writePackage(user, {}, {});
    const u = await open(user);
    const libs = u.pk.libraries().libs.map((l) => `${l.name}:${l.from}`);
    check(libs[0] === 'shared:self' && !libs.includes('shared:registered'), `the library it is in comes first, read from its own checkout; the same library registered elsewhere is not looked in again (${libs})`);
    u.pk.use('shared/base');
    const r = await u.engine.cook({ nodes: { b: { type: 'shared/base/block' } } });
    check(size(r, 1) === 2 && readLock(user).packages['shared/base']['1.0'].library === '..', `the sibling comes from the same worktree (height ${size(r, 1)}), the lock naming its library by its path`);
  } finally {
    const { removeLibrary } = await import('../src/config.ts');
    removeLibrary('shared');
  }
}

section('Godot: a .gdignore in the working folders of the packages inside a Godot project; the files engines write are not ours');
{
  const GD = path.join(tmp, 'gd-game'), BARREL = path.join(GD, 'assets', 'barrel');
  write(path.join(GD, 'project.godot'), 'config/name="Gd Game"\n');
  writePackage(BARREL, { name: 'gd/barrel' }, { main: { nodes: { f: { type: 'file', params: { path: 'inputs/shape.obj' } } }, output: 'f', outputs: { barrel: { node: 'f', kind: 'mesh', tags: ['barrel'], description: 'A barrel.' } } } }, { 'inputs/shape.obj': triangle(1) });
  const made = initWorkspace(GD, { libraries: ['lib'] });
  check(made.manifest.name === 'gd-game' && exists(BARREL, 'inputs', '.gdignore') && !exists(BARREL, 'versions') && !exists(BARREL, 'packages') && /added 1 \.gdignore file/.test(made.text),
    `workspace init sweeps the packages: inputs/ that is there gets a .gdignore, no folder is made for nothing (${made.text.split('\n').find((l) => /gdignore/.test(l))})`);
  const v1 = await publish(BARREL, 'first barrel');
  check(v1.ok && exists(BARREL, 'versions', '.gdignore') && !listing(path.join(BARREL, 'versions', '1.0')).some((f) => /gdignore/.test(f)), 'publishing puts a .gdignore in versions/ before the first version lands, and no version holds one');
  // what Godot writes beside the files it imports changes no hash
  write(path.join(BARREL, 'inputs', 'shape.obj.import'), '[remap]\nimporter="wavefront_obj"\n');
  write(path.join(BARREL, 'inputs', 'shape.uid'), 'uid://b1\n');
  write(path.join(BARREL, 'graphs', 'main.json.translation'), 'x');
  const again = await publishPackage(openPackages(await newEngine(BARREL), BARREL), { dryRun: true });
  check(!again.ok && again.blocks.includes('nothing changed since 1.0'), `.import and .uid files beside the inputs leave the version's hash as it was (${again.blocks.join(' | ')})`);
  const b = await open(BARREL);
  check(!b.ws.listInputs().some((f) => /\.import$|\.uid$|gdignore/.test(f.path)) && b.ws.listInputs().some((f) => f.path === 'shape.obj'), 'the inputs listing leaves them out');
  // use: packages/ gets its .gdignore before the first copy lands (a publishing package keeps its own copies)
  b.pk.use('nordic/rocks');
  check(exists(BARREL, 'packages', '.gdignore') && exists(BARREL, 'packages', 'nordic', 'rocks'), 'use puts a .gdignore in packages/ before the copy lands');
  const yard = path.join(GD, 'levels', 'yard');
  writePackage(yard, {}, {});
  (await open(yard)).pk.use('nordic/rocks');
  check(exists(GD, 'topotopo-packages', '.gdignore') && exists(yard, 'inputs', '.gdignore'), 'the workspace\'s shared copies too, and the working folders of the package that uses them');
  // a package made by init and opened (the viewer, the MCP server, edit): the inputs/ its session makes gets one at once
  const { initPackage } = await import('../src/package.ts');
  const fresh = path.join(GD, 'levels', 'fresh'), elsewhere = path.join(tmp, 'plain-session');
  initPackage(fresh);
  initPackage(elsewhere);
  const hadInputs = exists(fresh, 'inputs');
  await open(fresh);
  await open(elsewhere);
  check(!hadInputs && exists(fresh, 'inputs', '.gdignore') && exists(elsewhere, 'inputs') && !exists(elsewhere, 'inputs', '.gdignore'),
    'a session that makes the package\'s inputs/ inside a Godot project puts a .gdignore in it at once; outside one, none');
  // check reports and adds one that is missing
  fs.rmSync(path.join(BARREL, 'inputs', '.gdignore'));
  const ck = await checkAll(BARREL);
  check(ck.fixed.length === 1 && exists(BARREL, 'inputs', '.gdignore') && /added 1 missing \.gdignore file, which keep Godot's importer out of TopoTopo's working folders/.test(checkText(ck)), `check adds a missing .gdignore and says so (${ck.fixed.join(', ')})`);
  const checkHelp = spawnCli(['--help']).out.split('\n').find((l) => / check \[folder\] /.test(l)) ?? '';
  check(/changing nothing but missing \.gdignore files inside a Godot project\)$/.test(checkHelp), `--help says the one thing check writes (${checkHelp.trim()})`);
  // the exports a viewer lists leave the engine's files out
  write(path.join(BARREL, 'exports', 'barrel.glb'), 'glb');
  write(path.join(BARREL, 'exports', 'barrel.glb.import'), '[remap]\n');
  write(path.join(BARREL, 'exports', 'barrel.uasset'), 'x');
  const { ArtifactStore } = await import('../src/host/artifacts.ts');
  const saved = new ArtifactStore(path.join(BARREL, 'exports')).list().map((a) => a.label);
  check(saved.join() === 'barrel.glb', `the viewer's saved outputs leave .import and .uasset files out (${saved})`);
  // the exclude_filter entries the preset report names cover every file TopoTopo writes in exports/ beside the export
  const { GODOT_EXCLUDES } = await import('../src/engines.ts');
  const STOOL = path.join(GD, 'assets', 'stool');
  writePackage(STOOL, {}, { main: { nodes: { b: { type: 'box' } }, output: 'b' } });
  const exported = spawnCli([path.join(STOOL, 'graphs', 'main.json'), '--export', path.join(STOOL, 'exports', 'stool.glb')]);
  const glob = (g: string) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
  const beside = shown(path.join(STOOL, 'exports')).length ? listing(path.join(STOOL, 'exports')).filter((f) => f !== 'stool.glb') : [];
  const shipped = beside.filter((f) => !GODOT_EXCLUDES.some((g) => glob(g).test(`res://assets/stool/exports/${f}`) || glob(g).test(path.basename(f))));
  check(exported.code === 0 && exists(STOOL, 'exports', 'stool.glb') && beside.length >= 2 && !shipped.length,
    `every file an export writes beside it in exports/ (${beside.join(', ')}) matches an exclude_filter entry the preset report names${shipped.length ? `; not: ${shipped.join(', ')}` : ''}`);
  // outside a Godot project there are none
  check(!exists(dirs.forest, 'inputs', '.gdignore') && !exists(dirs.forest, 'packages', '.gdignore') && !exists(ROCKS, 'versions', '.gdignore') && exists(dirs.valley, 'topotopo-packages', '.gdignore'),
    'outside a Godot project no package gets one; a workspace\'s shared copies always do');
}

section('the source names no removed command and no "engine:" prefix but to refuse it');
{
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(ts|js|html)$/.test(e.name)) continue;
      fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
        // the export prefix is "engine:" with no space after it ("engine:props/crate.glb", "engine:<path>", 'engine:')
        const hit = /libraries add/.test(line) || /action:\s*"set",\s*libraries/.test(line) || /engine:\S/.test(line);
        if (hit && !/gone/i.test(line)) offenders.push(`${path.relative(ROOT, p)}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
  };
  walk(path.join(ROOT, 'src'));
  check(!offenders.length, `src/ says "libraries add", action:"set", libraries and "engine:" only where it refuses them${offenders.length ? `:\n${offenders.join('\n')}` : ''}`);
}

section('a workspace: one shared copy of each package for every package in it');
{
  const GAME = path.join(tmp, 'wsgame'), LIB = path.join(GAME, 'art', 'lib'), STONES = path.join(LIB, 'stones'), STICKS = path.join(LIB, 'sticks');
  const A = path.join(GAME, 'scenes', 'a'), B = path.join(GAME, 'scenes', 'b'), C = path.join(GAME, 'scenes', 'c');
  const box = (h: number): GraphSpec => ({ nodes: { b: { type: 'box', params: { size: [1, h, 1] } } }, output: 'b' });
  const scene = (t: string): GraphSpec => ({ nodes: { s: { type: t } }, output: 's' });
  const same = (x: string | null | undefined, y: string) => !!x && path.resolve(x).toLowerCase() === path.resolve(y).toLowerCase();
  // before the folder is a workspace, art/lib is a registered library ("wsart") the packages find these in
  addLibrary('wsart', LIB);
  writePackage(STONES, { name: 'ws/stones' }, { main: box(1) });
  await publish(STONES, 'first');
  setGraph(STONES, 'main', box(2));
  await publish(STONES, 'taller');
  writePackage(STICKS, { name: 'ws/sticks' }, { main: box(3) });
  await publish(STICKS, 'sticks');
  writePackage(A, {}, { main: scene('ws/stones') });
  writePackage(B, {}, { main: scene('ws/stones') });
  // before the folder is a workspace, each package keeps its own copies: here of two versions
  (await open(A)).pk.use('ws/stones', { version: '1.0' });
  (await open(B)).pk.use('ws/stones');
  check(exists(A, 'packages', 'ws', 'stones', '1.0', 'version.json') && exists(B, 'packages', 'ws', 'stones', '1.1', 'version.json'), 'before the workspace each package keeps its own copy');

  const made = initWorkspace(GAME, { engine: 'none' });
  const m = readWorkspace(GAME), said = made.text.split('\n').slice(3).join(' | ');
  check(m.uses['ws/stones'] === '1.1' && !Object.keys(readManifest(A).uses).length && !Object.keys(readManifest(B).uses).length && !exists(A, 'packages') && !exists(B, 'packages')
    && exists(GAME, 'topotopo-packages', 'ws', 'stones', '1.1', 'version.json') && !exists(GAME, 'topotopo-packages', 'ws', 'stones', '1.0') && exists(GAME, 'topotopo-packages', 'lock.json')
    && /used 1\.\d, another package 1\.\d; the workspace uses 1\.1/.test(said) && /moved the copies of scenes\/a/.test(said) && /moved the copies of scenes\/b/.test(said),
    `workspace init moves the packages' copies into one shared copy, one version of each package for the workspace (${said})`);
  check(m.engine === 'none' && initWorkspace(GAME, {}).manifest.engine === 'none' && readJSON(path.join(GAME, 'topotopo-workspace.json')).engine === 'none', '"engine": "none" is kept: init does not look for one again');
  check(exists(GAME, 'topotopo-packages', '.gdignore') && fs.readFileSync(path.join(GAME, '.gitignore'), 'utf8').includes('topotopo-packages/.lock') && fs.readFileSync(path.join(GAME, '.gitattributes'), 'utf8').includes('topotopo-packages/** -text'),
    'the shared copies are kept from Godot\'s import (.gdignore) and committed byte for byte (.gitattributes), their lock and cache ignored');
  check(copiesFor(STONES).workspace === null && same(copiesFor(A).workspace, GAME) && same(copiesFor(A).packages, path.join(GAME, 'topotopo-packages')),
    'a package inside the workspace that publishes keeps its own copies (its uses are published with it); the other packages share the workspace\'s');
  const sharedLock = () => readJSON(path.join(GAME, 'topotopo-packages', 'lock.json')).packages;
  check(sharedLock()['ws/stones']['1.1'].library === 'wsart', `the moved lock keeps the label it had: a registered name (${sharedLock()['ws/stones']['1.1'].library})`);
  const inWs = searchPackages(A, { query: 'stones' });
  const inWsHits = inWs.libraries.flatMap((l) => l.hits.map((h) => `${l.name}:${l.standing}:${h.type}`));
  check(librariesFor(A).libs.map((l) => `${l.name}:${l.from}`).join() === 'wsgame:self' && !inWs.libraries.some((l) => l.name === 'wsart') && inWsHits.join() === 'wsgame:self:ws/stones'
    && !/workspace library add wsart/.test(searchText(inWs)),
    `inside the workspace, the registered library within it is no place of its own, and search does not offer it as one to list: its packages are the workspace's (${inWsHits.join(' ')})`);
  const listed = workspaceText(GAME);
  check(!/\n {2}topotopo-packages\//.test(listed) && !/problems:/.test(listed) && /\n {2}art\/lib\/stones {2}package ws\/stones/.test(listed), `workspace lists its packages as the scan finds them, no shared copy among them (${listed.split('\n').filter((l) => /^ {2}/.test(l)).join(' | ')})`);

  const a = await open(A);
  const ra = await a.engine.cook(scene('ws/stones'));
  check(a.pk.uses()['ws/stones'] === '1.1' && size(ra, 1) === 2, `a package in the workspace cooks the shared copy (${errorOf(ra) || `height ${size(ra, 1)}`})`);
  check(/in workspace "wsgame" \(.*topotopo-workspace\.json names the versions every package in it uses/.test(packagesText(a.pk)), 'packages says the uses are the workspace\'s');

  // a first use in one package adds the package for the whole workspace, found in the workspace itself
  const b = await open(B);
  const notes = b.pk.addFor(scene('ws/sticks'));
  check(readWorkspace(GAME).uses['ws/sticks'] === '1.0' && !Object.keys(readManifest(B).uses).length && exists(GAME, 'topotopo-packages', 'ws', 'sticks', '1.0', 'version.json')
    && /added ws\/sticks 1\.0 to workspace "wsgame" \(one copy for every package in it\) from the workspace "wsgame"/.test(notes.join()) && sharedLock()['ws/sticks']['1.0'].library === '.',
    `a first use adds the package to the workspace, the lock naming the workspace by its path from its store: ${notes.join(' | ')}`);
  a.pk.refresh();
  const rs = await a.engine.cook(scene('ws/sticks'));
  check(size(rs, 1) === 3 && !a.pk.addFor(scene('ws/sticks')).length, `another package of the workspace uses it at once, adding nothing (${errorOf(rs)})`);

  // Update: the before/after covers every package of the workspace, and applying changes them all
  setGraph(STONES, 'main', box(4));
  await publish(STONES, 'tallest');
  setGraph(B, 'main', { nodes: { s: { type: 'ws/stones' }, k: { type: 'ws/sticks' }, m: { type: 'merge', in: ['s', 'k'] } }, output: 'm' });
  const r = await beforeAfter(a.pk, 'ws/stones');
  const files = r.uses.map((u) => u.file).sort().join(', ');
  check(r.target.to === '1.2' && files === 'graphs/main.json, scenes/b/graphs/main.json' && r.compared.length === 2 && r.compared.every((c) => c.before.ok && c.after.ok && !!c.diff),
    `Update's before/after covers every package that shares the copies (${files}; ${r.compared.map((c) => `${c.file} ${c.before.ok}/${c.after.ok} ${c.before.errors.join() || c.after.errors.join()}`).join('; ')})`);
  const up = applyUpdate(a.pk, 'ws/stones', { from: '1.1', to: '1.2' });
  b.pk.refresh();
  const rb = await b.engine.cook(scene('ws/stones'));
  check(readWorkspace(GAME).uses['ws/stones'] === '1.2' && size(rb, 1) === 4 && !exists(GAME, 'topotopo-packages', 'ws', 'stones', '1.1') && /updated ws\/stones 1\.1 → 1\.2 in workspace "wsgame", for every package in it/.test(up.text),
    `applying updates every package in the workspace (${up.text.split('\n')[0]}; b cooks ${size(rb, 1)})`);
  check(throws(() => removePackage(a.pk, 'ws/sticks'), /graph of the workspace's packages still names ws\/sticks: scenes\/b\/graphs\/main\.json k/),
    `remove is refused while another package of the workspace names it (${errorText(() => removePackage(a.pk, 'ws/sticks'))})`);

  // a manifest that still lists uses inside a workspace: said, and the next init moves them
  writePackage(C, { uses: { 'ws/stones': '1.2' } }, { main: scene('ws/stones') });
  const c = await open(C);
  check(/lists "uses" \(ws\/stones 1\.2\), but the package is in the workspace .*workspace init/.test(c.pk.notice() ?? ''), `a package that still lists its own uses in a workspace says how to move them (${c.pk.notice()})`);
  const again = initWorkspace(GAME, {});
  const c2 = await open(C);
  check(!c2.pk.notice() && !Object.keys(readManifest(C).uses).length && size(await c2.engine.cook(scene('ws/stones')), 1) === 4, `init again moves them (${again.text.split('\n').slice(3).join(' | ')})`);
  check(throws(() => initWorkspace(GAME, { libraries: ['lib'] }), /--library is for making a workspace, and .* is the workspace "wsgame" already: topotopo workspace library add <name or folder> --workspace \S*wsgame lists a library for it/)
    && throws(() => initWorkspace(GAME, { libraries: ['lib'], cwd: path.join(GAME, 'scenes') }), /already: topotopo workspace library add <name or folder> lists a library for it/), '--library is for making a workspace only (the command that lists one names the workspace when run outside it)');
  check(/shared libraries: none yet \(topotopo workspace library add <name or folder> --workspace \S*wsgame lists one\)/.test(initWorkspace(GAME, {}).text), 'init says how to list a shared library, naming the workspace from outside it');

  // a workspace that follows its own packages: the viewer and renders show their working folders, exports use the
  // published versions
  const on = initWorkspace(GAME, { follow: true });
  setGraph(STONES, 'main', box(5));
  const f = await open(A);
  const shownLive = await f.engine.cook(scene('ws/stones'));
  const preview = await f.ws.cook('main'), exported = await f.ws.cook('main', undefined, undefined, { kind: 'export' });
  check(readWorkspace(GAME).follow && /follow its own packages live: on/.test(on.text) && f.pk.following().some((x) => x.package === 'ws/stones' && same(x.dir, STONES))
    && size(shownLive, 1) === 5 && size(preview, 1) === 5 && size(exported, 1) === 4,
    `a workspace that follows its own packages shows their working folders, and exports the published versions (shown ${size(preview, 1)}, exported ${size(exported, 1)})`);
  initWorkspace(GAME, { follow: false });
  setGraph(STONES, 'main', box(4));
  check(!(await open(A)).pk.following().length, 'follow off: the copies again');

  // the engine's assets folder is gone: "engine.assets" and --assets are refused; an "engine:" target warns when cooked
  // and is refused where a file would be written
  check(throws(() => initWorkspace(GAME, { assets: 'godot/assets' }), /^--assets is gone: an export stays in its package's exports\/ folder; put the workspace inside the engine project/), '--assets is refused, naming the change');
  const wsFile = path.join(GAME, 'topotopo-workspace.json'), kept = fs.readFileSync(wsFile);
  json(wsFile, { ...readJSON(wsFile), engine: { type: 'godot', project: 'godot/project.godot', assets: 'godot/assets' } });
  check(throws(() => readWorkspace(GAME), /"engine\.assets" is gone: an export stays in its package's exports\/ folder.*; remove "assets"/), 'a workspace file with "engine.assets" is refused, naming the change');
  fs.writeFileSync(wsFile, kept);
  check(targetError({ format: 'glb', path: 'engine:props/stones.glb' }) === null && /^export path "engine:props\/stones\.glb": the "engine:" prefix is gone: an export target is a path inside its package's exports\/ folder \("props\/stones\.glb"\)/.test(targetWarning({ format: 'glb', path: 'engine:props/stones.glb' }) ?? '')
    && resolveTarget({ format: 'glb', path: 'engine:props/stones.glb' }, 'x').refused === 'engine:props/stones.glb', 'an "engine:" path validates with a warning, and its target is marked refused');
  setGraph(A, 'main', { ...scene('ws/stones'), export: { format: 'glb', path: 'engine:props/stones.glb' } });
  const warned = await (await open(A)).ws.cook('main');
  check(warned.ok && warned.warnings.some((w) => /the "engine:" prefix is gone/.test(w.message)), `a cook warns and still cooks (${warned.warnings.map((w) => w.message).join(' | ').slice(0, 160)})`);
  const all = spawnCli([path.join(A, 'graphs', 'main.json'), '--export-all']);
  check(all.code === 1 && /--export-all: "main": export path "engine:props\/stones\.glb": the "engine:" prefix is gone/.test(all.out) && !exists(A, 'exports', 'props') && !exists(A, 'exports', 'stones.glb'),
    `--export-all refuses it and writes nothing (${all.out.split('\n').filter((l) => /export-all/.test(l)).join(' | ')})`);
  // the MCP export tool writes a graph's targets through the same step a viewer's Export does: refused there too
  const mcpA = await open(A), exportTool = makeTools(mcpA.ws).find((t) => t.name === 'export')!;
  const exportSaid = async (a: any) => { try { const r = await exportTool.run(a); return `${r.isError ? 'ERR ' : ''}${r.content.map((c: any) => c.text ?? '').join('\n')}`; } catch (e: any) { return `ERR ${e.message}`; } };
  const one = await exportSaid({ graph: 'main' }), every = await exportSaid({ graph: 'main', all: true });
  check(/^ERR .*export path "engine:props\/stones\.glb": the "engine:" prefix is gone/.test(one) && /^ERR .*the "engine:" prefix is gone/.test(every) && !exists(A, 'exports', 'props') && !exists(A, 'exports', 'stones.glb'),
    `the MCP export tool refuses it and writes nothing (${one.split('\n')[0].slice(0, 160)})`);
  setGraph(A, 'main', scene('ws/stones'));

  // check: the workspace's own packages (the versions of those that publish, the graphs of the others)
  // a fragment another graph or a script completes is skipped
  json(path.join(B, 'graphs', 'piece.json'), { nodes: { m: { type: 'merge', in: ['relief', 'roads'] } }, output: 'm', fragment: true });
  const fine = await checkAll(A);
  const names = fine.items.map((i) => i.name).sort().join(', ');
  check(names === 'scenes/a, scenes/b, scenes/c, ws/sticks 1.0, ws/stones 1.2' && fine.items.every((i) => !i.failures.length && i.cooked > 0) && /nothing broke; nothing was changed$/.test(checkText(fine))
    && /skipped, fragments \("fragment": true\) that another graph or a script completes: scenes\/b piece/.test(checkText(fine)),
    `check cooks the newest version of each package that publishes and the graphs of the others (${names}; ${fine.items.filter((i) => i.failures.length).map((i) => `${i.name}: ${i.failures.map((f) => f.error).join('; ')}`).join(' | ')})`);
  // a published version an engine change broke (here: a param its graph sets that the node does not have)
  const vgraph = path.join(STICKS, 'versions', '1.0', 'graphs', 'main.json'), keptGraph = fs.readFileSync(vgraph);
  json(vgraph, { nodes: { b: { type: 'box', params: { size: [1, 3, 1], strength: 2 } } }, output: 'b' });
  const before = shown(GAME).join();
  const broken = await checkAll(GAME), report = checkText(broken);
  const cli = spawnCli(['check', GAME]);
  fs.writeFileSync(vgraph, keptGraph);
  check(/BROKEN {2}ws\/sticks 1\.0: 1 failure\n {2}ws\/sticks: \[b\] unknown param "strength" for box/.test(report) && /1 of 5 broke; nothing was changed/.test(report) && !/BROKEN {2}package/.test(report)
    && shown(GAME).join() === before && cli.code === 1 && /BROKEN {2}ws\/sticks 1\.0/.test(cli.out),
    `check names the broken version and why; the workspace's own copy still cooks; it changes nothing, and the CLI exits 1 (${report.split('\n').slice(0, 4).join(' | ')})`);
  const { removeLibrary } = await import('../src/config.ts');
  removeLibrary('wsart');
}

section('a folder the workspace\'s scan does not enter is not the workspace\'s: its packages keep their own copies');
{
  // the workspace builds with game/project.godot; lookdev/ is another Godot project inside it, which the scan skips
  const WS = path.join(tmp, 'twoproj'), HALL = path.join(WS, 'hall'), ROCK = path.join(WS, 'lookdev', 'rock'), BARREL = path.join(WS, 'game', 'assets', 'barrel');
  const same = (x: string | null | undefined, y: string) => !!x && path.resolve(x).toLowerCase() === path.resolve(y).toLowerCase();
  const rocks: GraphSpec = { nodes: { r: { type: 'nordic/rocks' } }, output: 'r' };
  write(path.join(WS, 'game', 'project.godot'), '[application]\n');
  write(path.join(WS, 'lookdev', 'project.godot'), '[application]\n');
  writePackage(ROCK, {}, { main: rocks });
  for (const d of [HALL, BARREL]) writePackage(d, {}, { main: { nodes: { b: { type: 'box' } }, output: 'b' } });
  initWorkspace(WS, { name: 'twoproj', engine: 'godot:game/project.godot', libraries: ['lib'] });
  const { locate } = await import('../src/package.ts');
  check(same(locate(HALL).workspace, WS) && same(locate(BARREL).workspace, WS) && locate(ROCK).workspace === null && copiesFor(ROCK).workspace === null && librariesFor(ROCK).workspace === null,
    `the packages the scan finds are the workspace's (the workspace's own engine project among them); one in another engine project is in no workspace (${locate(ROCK).workspace})`);
  check(/lookdev: another engine project \(it holds project\.godot\)/.test(errorText(() => workspaceText(ROCK))), `a folder of it says why it is in no workspace (${errorText(() => workspaceText(ROCK))})`);
  const rock = await open(ROCK);
  rock.pk.use('nordic/rocks', { version: '1.0' });
  const hall = await open(HALL);
  hall.pk.use('nordic/rocks');
  const removed = removePackage(hall.pk, 'nordic/rocks');
  rock.pk.refresh();
  check(exists(ROCK, 'packages', 'nordic', 'rocks', '1.0', 'version.json') && readManifest(ROCK).uses['nordic/rocks'] === '1.0' && !readWorkspace(WS).uses['nordic/rocks'] && rock.pk.uses()['nordic/rocks'] === '1.0',
    `the package in another engine project keeps its own copy at the version it uses, which removing the package from the workspace leaves alone (${removed.text.split('\n')[0]})`);
  // with no engine project of its own, every folder holding one is another
  initWorkspace(WS, { engine: 'none' });
  check(locate(BARREL).workspace === null && same(locate(HALL).workspace, WS), 'with "engine": "none", a package in a folder holding project.godot is in no workspace either');
}

section('two listed libraries of one name are two places: the first has the name, the later one is "also in", not used');
{
  // two checkouts of one library, each naming itself "props" (library.json); both hold dup/crate, the second dup/barrel
  const WT = path.join(tmp, 'props-wt'), MAIN = path.join(tmp, 'props-main'), WS = path.join(tmp, 'twolibs'), USER = path.join(WS, 'user');
  const crate = (h: number, tag: string): GraphSpec => ({ nodes: { b: { type: 'box', params: { size: [1, h, 1] } } }, output: 'b', outputs: { block: { node: 'b', kind: 'mesh', tags: [tag] } } });
  for (const lib of [WT, MAIN]) json(path.join(lib, 'library.json'), { name: 'props' });
  writePackage(path.join(WT, 'crate'), { name: 'dup/crate' }, { main: crate(1, 'dupe') });
  writePackage(path.join(MAIN, 'crate'), { name: 'dup/crate' }, { main: crate(2, 'dupe') });
  writePackage(path.join(MAIN, 'barrel'), { name: 'dup/barrel' }, { main: crate(3, 'dupe') });
  for (const d of [path.join(WT, 'crate'), path.join(MAIN, 'crate'), path.join(MAIN, 'barrel')]) await publish(d, 'first');
  json(path.join(WS, 'topotopo-workspace.json'), { name: 'twolibs', libraries: ['../props-wt', '../props-main'], engine: 'none' });
  writePackage(USER, {}, { main: { nodes: { c: { type: 'dup/crate/block' } }, output: 'c' } });
  const u = await open(USER);
  let used = '';
  try { used = u.pk.use('dup/crate').text; } catch (e: any) { used = e.message; }
  const text = packagesText(u.pk);
  check(/^added dup\/crate 1\.0 .*from library "props"/.test(used) && size(await u.engine.cook({ nodes: { c: { type: 'dup/crate/block' } }, output: 'c' }), 1) === 1
    && /\n {2}dup\/crate 1\.0 .*up to date; also in library "props" \(.*props-main.*\), not used/.test(text) && !/published by two folders/.test(text),
    `the first listed library has the name, the second is also in, not used (${used.split('\n')[0]}; ${text.split('\n').filter((l) => /dup\//.test(l)).join(' | ')})`);
  const s = searchPackages(USER, { tag: 'dupe' });
  const where = s.libraries.filter((l) => l.hits.length).map((l) => `${path.basename(l.root)}:${l.hits.map((h) => h.type).join('+')}`).join(' ');
  check(where === 'props-wt:dup/crate/block props-main:dup/barrel/block', `search shows each package once, under the place that has it (${where})`);
}

section('check outside a workspace: the package and the library it is in, not the other registered libraries');
{
  const names = (r: Awaited<ReturnType<typeof checkAll>>) => r.items.map((i) => `${i.what === 'package' ? 'package ' : ''}${i.name.replace(/ \d+\.\d+$/, '')}`).sort().join(', ');
  // a registered library ("game"): the newest versions of its packages, and the package's graphs
  const inRegistered = await checkAll(GROVE);
  // a library found by its library.json
  const inOwn = await checkAll(path.join(tmp, 'props-main', 'barrel'));
  const ofGame = new Set(scanLibrary({ name: 'game', path: dirs.game }).packages.map((p) => p.manifest.name)), reg = names(inRegistered).split(', ');
  check(['package grove', 'studio/grove', 'studio/trees'].every((n) => reg.includes(n)) && reg.every((n) => n === 'package grove' || ofGame.has(n)) && names(inOwn) === 'dup/barrel, dup/crate, package barrel',
    `check of a package outside a workspace covers its own library, found by its registered name or its library.json, and no other (${names(inRegistered)}; ${names(inOwn)})`);
}

section('a registered library the workspace does not list: named only when listing it would help');
{
  const { removeLibrary } = await import('../src/config.ts');
  const block = (tag: string): GraphSpec => ({ nodes: { b: { type: 'box' } }, output: 'b', outputs: { block: { node: 'b', kind: 'mesh', tags: [tag] } } });
  // a registered library that holds the workspace: the workspace cannot list it, so neither lookup nor search says to
  const STUDIO = path.join(tmp, 'holder'), GAME = path.join(STUDIO, 'game'), HALL = path.join(GAME, 'hall');
  writePackage(path.join(STUDIO, 'props', 'crate'), { name: 'hold/crate' }, { main: block('held') });
  await publish(path.join(STUDIO, 'props', 'crate'), 'first');
  addLibrary('holder', STUDIO);
  json(path.join(GAME, 'topotopo-workspace.json'), { name: 'held-game', libraries: [], engine: 'none' });
  writePackage(HALL, {}, { main: { nodes: { b: { type: 'box' } }, output: 'b' } });
  const hall = await open(HALL);
  const missing = errorText(() => hall.pk.use('hold/crate'));
  const held = searchPackages(HALL, { tag: 'held' });
  check(/^no place this package looks in has a package hold\/crate/.test(missing) && !/workspace library add holder/.test(missing) && !held.libraries.some((l) => l.name === 'holder'),
    `a registered library holding the workspace is not named as one to list (${missing.slice(0, 160)}; ${held.libraries.map((l) => `${l.name}:${l.standing}`).join(' ')})`);
  removeLibrary('holder');
  // a registered library inside a listed one: its packages are the listed one's, shown once
  const LIBS = path.join(tmp, 'outer-libs'), SUB = path.join(LIBS, 'sub'), WS = path.join(tmp, 'nest-ws'), USER = path.join(WS, 'user');
  writePackage(path.join(SUB, 'crate'), { name: 'nest/crate' }, { main: block('nested') });
  await publish(path.join(SUB, 'crate'), 'first');
  addLibrary('outer-libs', LIBS);
  addLibrary('outer-sub', SUB);
  json(path.join(WS, 'topotopo-workspace.json'), { name: 'nest-ws', libraries: ['outer-libs'], engine: 'none' });
  writePackage(USER, {}, { main: { nodes: { b: { type: 'box' } }, output: 'b' } });
  const nested = searchPackages(USER, { tag: 'nested' });
  const hits = nested.libraries.flatMap((l) => l.hits.map((h) => `${l.name}:${l.standing}:${h.type}`));
  check(hits.join() === 'outer-libs:listed:nest/crate/block' && !/workspace library add outer-sub/.test(searchText(nested)), `a package found through a listed library is not shown again under a registered library inside it (${hits.join(' ')})`);
  removeLibrary('outer-libs');
  removeLibrary('outer-sub');
}

await engines[0]?.host.pool?.close();
console.log(`\n${passes} passed, ${failures} failed — temp ${tmp}`);
process.exit(failures ? 1 : 0);
