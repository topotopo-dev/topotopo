// Packages, the engine side (src/graph/packages.ts): package output names and their errors, a scope's package resolver,
// a package output's node type (its sliders, inputs, scope, signature and texture paths), the packages a graph names
// and uses, "publish": false.
//   node test/packages.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
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
import { encodePNG } from '../src/render/png.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'topotopo-packages-'));

let failures = 0, passes = 0;
const check = (cond: any, msg: string) => { if (cond) passes++; else failures++; console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); };
const section = (s: string) => console.log(`\n== ${s}`);
const write = (file: string, data: string | Uint8Array) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };
const errorOf = (r: CookReport) => r.errors.map((e) => e.message + (e.hint ? ` (hint: ${e.hint})` : '')).join('; ');
const size = (r: CookReport, k: number) => (r.ok && r.geo ? +(r.geo.bbox().max[k] - r.geo.bbox().min[k]).toFixed(4) : NaN);
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
  // which texture paths are rebased: relative file paths, not images, URLs or absolute paths
  const geo = new Geometry();
  writeMaterials(geo, { t: { baseColor: [1, 1, 1], metallic: 0, roughness: 1, emissive: [0, 0, 0], alpha: 1, doubleSided: false, unlit: false, textures: { baseColor: 'image:noise', normal: 'https://example.com/n.png', roughness: '/abs/r.png', orm: 'maps/orm.png' } } });
  const t = readMaterials(rebaseTexturePaths(geo, (x) => `V/${x}`)).t.textures!;
  check(t.baseColor === 'image:noise' && t.normal === 'https://example.com/n.png' && t.roughness === '/abs/r.png' && t.orm === 'V/maps/orm.png', 'only relative file paths are rebased');
  check(readMaterials(geo).t.textures!.orm === 'maps/orm.png', 'the cooked geometry itself is never changed');
}

section('"publish": false');
{
  const e = await newEngine(tmp);
  const v = e.validate({ nodes: { b: { type: 'box' } }, outputs: { a: { node: 'b', publish: 'no' as any } } });
  check(v.errors.some((x) => /named output "a": "publish" must be true or false/.test(x.message)), `publish is validated like the other output fields: ${v.errors.map((x) => x.message)}`);
  check(!e.validate({ nodes: { b: { type: 'box' } }, outputs: { a: { node: 'b', publish: false }, c: { node: 'b', publish: true } } }).errors.length, 'publish: true and false are valid');
}

await engines[0]?.host.pool?.close();
console.log(`\n${passes} passed, ${failures} failed — temp ${tmp}`);
process.exit(failures ? 1 : 0);
