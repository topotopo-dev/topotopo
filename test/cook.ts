// The cook for an engine (src/host/cook.ts) and its Godot flavour and commands (src/host/godot.ts): what is cooked and
// where (per-output folders and flat), the record (schema, canonical text, relative paths, no times, no .source.json),
// the GLBs Godot reads (extensions, no compression, the source block's package, sockets, _COLOR alone on instances),
// determinism (two cooks, another path with a space and "é", LF and CRLF), writing only changed files, incremental
// cooks per dep, failures keeping the last good files, the foreign-file guard and --adopt, orphans, options from the
// import file and flags over them, --locked rules, published copies and protocol errors (exit 2), the lock, the cache
// shared by two checkouts, the jobs file (one process, ASCII progress), timeouts, godot setup and status (--strict),
// the freshness golden values the Godot addon's port is tested against (test/data/cook/freshness.json; --update
// rewrites them), and every list of the commands. The fixtures are neutral props in test/data/cook/props.
//   node test/cook.ts [--update]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { encodePNG } from '../src/render/png.ts';
import { decodePNG } from '../src/io/png-decode.ts';
import { contentSha } from '../src/packages/registry.ts';
import { canonicalText, freshness, listing, readRecord } from '../src/host/cook.ts';
import type { CookRecord, EngineOptions, PackageReport } from '../src/host/cook.ts';
import { GODOT_COMMANDS, GODOT_GLTF_EXTENSIONS, cookCommand, enablePlugin, excludeAddon, glbJson, godotCommand, godotSetup, godotStatus, markPng, pngPackage } from '../src/host/godot.ts';
import { topicText } from '../src/mcp/docs.ts';
import { readInstall } from '../src/config.ts';
import { TOPOTOPO_VERSION } from '../src/host/version.ts';
import { ROOT } from './fixtures.ts';

const UPDATE = process.argv.includes('--update');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'topotopo-cook-'));
process.env.TOPOTOPO_CONFIG = path.join(tmp, 'cfg', 'config.json');
process.env.TOPOTOPO_CACHE = path.join(tmp, 'cache');
delete process.env.TOPOTOPO_LIBRARIES;
const FIXTURE = path.join(ROOT, 'test', 'data', 'cook', 'props');
const GOLDEN = path.join(ROOT, 'test', 'data', 'cook', 'freshness.json');
const CLI = path.join(ROOT, 'src', 'cli.ts');

let failures = 0, passes = 0;
const check = (cond: unknown, msg: string) => { if (cond) passes++; else failures++; console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); };
const section = (s: string) => console.log(`\n== ${s}`);
const write = (file: string, data: string | Uint8Array) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };
const read = (file: string) => fs.readFileSync(file);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const json = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
const editJson = (file: string, f: (j: any) => void) => { const j = json(file); f(j); write(file, JSON.stringify(j, null, 2) + '\n'); };
/** Copy a folder (fs.cpSync mangles non-ASCII destination paths on Windows in Node 24). */
const copyDir = (from: string, to: string) => {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.isDirectory()) copyDir(path.join(from, e.name), path.join(to, e.name));
    else fs.copyFileSync(path.join(from, e.name), path.join(to, e.name));
  }
};

/** A Godot project in the temp folder, with the fixture package at `rel` (default props/). */
function project(name: string, rel: string | null = 'props'): string {
  const p = path.join(tmp, name);
  write(path.join(p, 'project.godot'), 'config_version=5\n\n[application]\n\nconfig/name="Cook test"\n');
  if (rel) copyDir(FIXTURE, path.join(p, ...rel.split('/')));
  return p;
}

/** Run the cook command in this process: its exit code, what it said, and the report of a single package. */
async function cook(args: string[], report?: string): Promise<{ code: number; out: string[]; err: string[]; rep: PackageReport | null; text: string }> {
  const out: string[] = [], err: string[] = [];
  const code = await cookCommand([...args, ...(report ? ['--report', report] : [])], { out: (s) => out.push(s), err: (s) => err.push(s) });
  const rep = report && fs.existsSync(report) ? json(report) : null;
  if (report) fs.rmSync(report, { force: true });
  return { code, out, err, rep, text: [...out, ...err].join('\n') };
}
const godot = async (args: string[]) => {
  const out: string[] = [], err: string[] = [];
  const code = await godotCommand(args, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, text: [...out, ...err].join('\n'), out: out.join('\n') };
};
const REPORT = path.join(tmp, 'report.json');
const cookPkg = (pkg: string, ...flags: string[]) => cook([pkg, '--for', 'godot', ...flags], REPORT);
const states = (rep: PackageReport | null) => Object.fromEntries((rep?.outputs ?? []).map((o) => [o.id, o.state]));
const cookedIds = (rep: PackageReport | null) => (rep?.outputs ?? []).filter((o) => o.cooked).map((o) => o.id).sort().join(',');
const stateText = (rep: PackageReport | null) => (rep?.outputs ?? []).map((o) => `${o.id}:${o.state}${o.cooked ? '*' : ''}`).join(' ');
const filesBelow = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (d: string, rel: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(path.join(d, e.name), r); else out.push(r); } };
  if (fs.existsSync(dir)) walk(dir, '');
  return out.sort();
};
const options = (o: Partial<EngineOptions> = {}): EngineOptions => ({ folder: 'res://props/outputs', instancing: 'packed', per_output_folders: true, skip: [], ...o });
const fresh = (pkg: string, proj: string, o: Partial<EngineOptions> = {}, installed: string | null = TOPOTOPO_VERSION) =>
  freshness(pkg, readRecord(pkg, 'godot'), options(o), { for: 'godot', absolutePath: (r) => path.join(proj, ...r.slice(6).split('/')), installed });
const grey = (v: number) => encodePNG(new Uint8Array(64).map((_, i) => (i % 4 === 3 ? 255 : (v + i) % 256)), 4, 4, (d) => zlib.deflateSync(d, { level: 9 }));

// ------------------------------------------------------------------------------------------------ the first cook
section('the first cook: per-output folders, the record, the GLBs Godot reads');
const A = project('a');
const PA = path.join(A, 'props');
{
  const r = await cookPkg(PA);
  check(r.code === 0 && r.rep?.ok, `exit 0 and the report says ok (${stateText(r.rep)}${r.err.length ? ` ${r.err.join(' | ')}` : ''})`);
  const s = states(r.rep);
  check(s.crate === 'written' && s.scatter === 'written' && s.panels === 'written' && s.props === 'written' && s.island === 'skipped', `crate, scatter, panels and the unnamed default output (props) written; the terrain skipped (${JSON.stringify(s)})`);
  const files = filesBelow(path.join(PA, 'outputs'));
  check(files.join() === 'crate/crate.glb,panels/panel_noise.png,props/props.glb,scatter/scatter.glb', `one folder per output: ${files.join(', ')}`);
  check(!filesBelow(A).some((f) => /\.json$/.test(f) && !/^props\/(graphs\/|\.topotopo\/godot\.json$|props\.topo)/.test(f)), 'no .source.json and no materials.json anywhere in the project');
  const recFile = path.join(PA, '.topotopo', 'godot.json');
  const text = fs.readFileSync(recFile, 'utf8');
  const rec: CookRecord = JSON.parse(text);
  check(canonicalText(rec) === text && text.endsWith('}\n') && !text.includes('\r'), 'the record is canonical: sorted keys, 2-space indent, LF, a trailing newline');
  check(rec.schema === 1 && rec.for === 'godot' && rec.package === 'props' && rec.name === 'studio/props' && rec.topotopo === TOPOTOPO_VERSION, 'schema 1, for godot, the package id and publish name, the TopoTopo version');
  check(!/\d{4}-\d\d-\d\dT\d\d:/.test(text) && !text.includes(tmp.replace(/\\/g, '/')) && !text.includes(tmp.replace(/\\/g, '\\\\')), 'no times and no machine paths in the record');
  check(JSON.stringify(rec.options) === JSON.stringify({ folder: 'res://props/outputs', instancing: 'packed', per_output_folders: true, skip: [] }), `the default options: ${JSON.stringify(rec.options)}`);
  const allDeps = Object.values(rec.outputs).flatMap((o) => o.deps);
  check(allDeps.every((d) => !path.isAbsolute(d) && !d.includes('\\')) && Object.keys(rec.sources).sort().join() === 'graphs/crate.json,graphs/yard.json,inputs/decal.png,props.topo',
    `sources relative to the package (posix): ${Object.keys(rec.sources).join(', ')}`);
  check(rec.outputs.crate.deps.join() === 'graphs/crate.json,inputs/decal.png,props.topo' && rec.outputs.scatter.deps.join() === 'graphs/yard.json,props.topo',
    `each output's deps are what it read: crate ${rec.outputs.crate.deps.join(' ')}; scatter ${rec.outputs.scatter.deps.join(' ')}`);
  check(rec.sources['inputs/decal.png'] === sha(read(path.join(PA, 'inputs', 'decal.png'))) && rec.sources['graphs/crate.json'] === contentSha('graphs/crate.json', read(path.join(PA, 'graphs', 'crate.json'))),
    'source hashes are contentSha (a PNG raw, a graph as its LF text)');
  check(Object.keys(rec.outputs.crate.files)[0] === 'res://props/outputs/crate/crate.glb' && rec.outputs.crate.files['res://props/outputs/crate/crate.glb'] === sha(read(path.join(PA, 'outputs', 'crate', 'crate.glb'))),
    'output files are res:// paths with the raw SHA-256 of their bytes');
  check(rec.outputs.props.default && !rec.outputs.crate.default && rec.outputs.props.graph === 'yard' && rec.outputs.props.node === 'ground', 'the default output, named after the package id, is marked default');
  check(rec.skipped.island?.kind === 'terrain' && /not imported/.test(rec.skipped.island.why) && rec.skipped.island.deps?.join() === 'graphs/yard.json,props.topo', `the terrain is listed as skipped with why and its deps (${rec.skipped.island?.why})`);
  check(JSON.stringify(rec.outputs.scatter.instances) === '{"stone_a":3,"stone_b":2,"stone_c":2}' && rec.outputs.scatter.kind === 'instances', `instances counted per source: ${JSON.stringify(rec.outputs.scatter.instances)}`);
  check(JSON.stringify(rec.folders) === JSON.stringify({ assets: [], graphs: ['crate.json', 'yard.json'], inputs: ['decal.png', 'notes.txt'] }), `folder listings: ${JSON.stringify(rec.folders)}`);
  check(r.rep!.package.topo === path.join(PA, 'props.topo').split(path.sep).join('/') && r.rep!.protocol === 1 && r.rep!.record === 'written', `the report names the package with forward slashes and the protocol (${r.rep!.package.topo})`);

  // the GLBs, read back
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const allowed = new Set([...GODOT_GLTF_EXTENSIONS, 'EXT_mesh_gpu_instancing']);
  for (const id of ['crate', 'props', 'scatter']) {
    const bytes = new Uint8Array(read(path.join(PA, 'outputs', id, `${id}.glb`)));
    const j = glbJson(bytes);
    const doc = await io.readBinary(bytes);
    const req: string[] = j.extensionsRequired ?? [], used: string[] = j.extensionsUsed ?? [];
    check(req.every((e) => allowed.has(e)) && !used.some((e) => /meshopt|quantization|draco/i.test(e)) && doc.getRoot().listMeshes().length > 0,
      `${id}.glb: required extensions Godot reads (${req.join(', ') || 'none'}), no meshopt or quantization`);
    check(j.asset?.extras?.source?.package === 'studio/props' && j.asset.extras.source.export.format === 'glb', `${id}.glb: its source block names the package (${j.asset?.extras?.source?.package})`);
  }
  const crate = glbJson(new Uint8Array(read(path.join(PA, 'outputs', 'crate', 'crate.glb'))));
  const names = crate.nodes.map((n: any) => n.name);
  check(['crate_lod0', 'crate_lod1', 'handle'].every((n) => names.includes(n)) && crate.nodes.find((n: any) => n.name === 'handle').mesh === undefined && crate.images?.length === 1,
    `crate.glb: LOD pieces as sibling meshes, the socket as a node without a mesh, the decal embedded (${names.join(', ')})`);
  const scatter = glbJson(new Uint8Array(read(path.join(PA, 'outputs', 'scatter', 'scatter.glb'))));
  const inst = scatter.nodes.filter((n: any) => n.extensions?.EXT_mesh_gpu_instancing);
  const attrs = inst.map((n: any) => Object.keys(n.extensions.EXT_mesh_gpu_instancing.attributes).sort().join('/'));
  check(inst.length === 3 && attrs.every((a: string) => a === 'ROTATION/SCALE/TRANSLATION/_COLOR'), `scatter.glb: three instanced sources, each with TRANSLATION, ROTATION, SCALE and _COLOR alone (${attrs.join(' ')})`);
  const doc = await io.readBinary(new Uint8Array(read(path.join(PA, 'outputs', 'scatter', 'scatter.glb'))));
  const node = doc.getRoot().listNodes().find((n) => n.getName() === 'stone_a')!;
  const im: any = node.getExtension('EXT_mesh_gpu_instancing');
  const sc = im.getAttribute('SCALE').getArray() as Float32Array, col = im.getAttribute('_COLOR').getArray() as Float32Array;
  check(sc.length === 9 && sc[0] !== sc[1] && Math.abs(sc[0] - 1) < 1e-6 && Math.abs(sc[1] - 0.5) < 1e-6 && col.length >= 9 && Math.abs(col[0] - 0.25) < 1e-6,
    `instances keep their non-uniform scale and colour (scale ${Array.from(sc.slice(0, 3)).join(', ')}, colour ${Array.from(col.slice(0, 3)).map((x) => x.toFixed(2)).join(', ')})`);
  const png = new Uint8Array(read(path.join(PA, 'outputs', 'panels', 'panel_noise.png')));
  check(pngPackage(png) === 'studio/props' && png[0] === 0x89, 'the textures output\'s PNG names the package it was cooked for (a tEXt chunk)');
  const img = decodePNG(png);
  check(img.width === 16 && img.height === 16, 'and still decodes as the 16×16 image');
}

section('the same cook again: nothing written, every file keeps its time, the record unchanged');
{
  const mt = Object.fromEntries(filesBelow(PA).map((f) => [f, fs.statSync(path.join(PA, f)).mtimeMs]));
  const r = await cookPkg(PA);
  check(r.code === 0 && Object.values(states(r.rep)).every((s) => s === 'unchanged' || s === 'skipped') && !cookedIds(r.rep) && r.rep!.record === 'unchanged',
    `every output unchanged and none cooked (${stateText(r.rep)})`);
  check(filesBelow(PA).every((f) => fs.statSync(path.join(PA, f)).mtimeMs === mt[f]), 'no file of the package was touched');
  const f = fresh(PA, A);
  check(f.state === 'ok' && f.why === '' && f.note === '', `freshness: ok (${f.text})`);
}

section('incremental: changing a dep cooks exactly the outputs that list it');
{
  editJson(path.join(PA, 'graphs', 'crate.json'), (g) => { g.nodes.paint.params.roughness = 0.4; });
  check(fresh(PA, A).why === 'source' && fresh(PA, A).path === 'graphs/crate.json', `freshness names the changed graph (${fresh(PA, A).text})`);
  let r = await cookPkg(PA);
  check(cookedIds(r.rep) === 'crate' && states(r.rep).crate === 'written' && states(r.rep).scatter === 'unchanged', `graphs/crate.json: crate alone (${stateText(r.rep)})`);
  write(path.join(PA, 'inputs', 'decal.png'), grey(90));
  r = await cookPkg(PA);
  check(cookedIds(r.rep) === 'crate' && states(r.rep).crate === 'written', `inputs/decal.png: crate alone, the one that reads it (${stateText(r.rep)})`);
  editJson(path.join(PA, 'graphs', 'yard.json'), (g) => { g.nodes.panels.params.seed = 4; });
  r = await cookPkg(PA);
  check(cookedIds(r.rep) === 'island,panels,props,scatter' && states(r.rep).crate === 'unchanged' && states(r.rep).panels === 'written', `graphs/yard.json: its outputs alone (their source block holds the graph's hash) (${stateText(r.rep)})`);
  editJson(path.join(PA, 'props.topo'), (m) => { m.description = 'Neutral props, described again.'; });
  r = await cookPkg(PA);
  check(cookedIds(r.rep) === 'crate,island,panels,props,scatter' && r.rep!.outputs.every((o) => o.state !== 'written'), `props.topo: every output cooks, to the same bytes (${stateText(r.rep)})`);
  write(path.join(PA, 'inputs', 'notes.txt'), 'Notes, changed: still nothing reads this file.\n');
  check(fresh(PA, A).state === 'ok', 'a file no output reads changes nothing: still fresh');
  r = await cookPkg(PA);
  check(!cookedIds(r.rep) && r.rep!.record === 'unchanged', `and cooks nothing (${stateText(r.rep)})`);
  write(path.join(PA, 'inputs', 'extra.txt'), 'another file\n');
  check(fresh(PA, A).why === 'folder' && fresh(PA, A).path === 'inputs', `a new file in inputs/ changes its listing (${fresh(PA, A).text})`);
  r = await cookPkg(PA);
  check(!cookedIds(r.rep) && r.rep!.record === 'written' && json(path.join(PA, '.topotopo', 'godot.json')).folders.inputs.includes('extra.txt'), 'it cooks nothing: the record takes the new listing');
  write(path.join(PA, 'graphs', 'extra.json'), JSON.stringify({ nodes: { b: { type: 'box', params: { size: [0.1, 0.1, 0.1] } } }, output: 'b', outputs: { extra: { node: 'b', label: 'Extra' } } }, null, 2) + '\n');
  check(fresh(PA, A).why === 'folder' && fresh(PA, A).path === 'graphs', 'adding a graph changes the graphs/ listing');
  r = await cookPkg(PA);
  check(r.code === 0 && states(r.rep).extra === 'written' && cookedIds(r.rep).split(',').length === 6, `a new graph's output is cooked, and the others with it (the graphs/ listing changed) (${stateText(r.rep)})`);
  // an output file deleted or edited by hand is cooked again (from the cache: nothing else changed)
  fs.rmSync(path.join(PA, 'outputs', 'extra', 'extra.glb'));
  check(fresh(PA, A).why === 'output' && fresh(PA, A).path === 'res://props/outputs/extra/extra.glb', `a deleted output file reads stale (${fresh(PA, A).text})`);
  r = await cookPkg(PA);
  check(states(r.rep).extra === 'cached' && cookedIds(r.rep) === 'extra' && fs.existsSync(path.join(PA, 'outputs', 'extra', 'extra.glb')), `and comes back from the cache (${stateText(r.rep)})`);
}

section('LF and CRLF: the same contentSha, the same record, nothing to cook');
{
  const g = path.join(PA, 'graphs', 'crate.json');
  const lf = read(g);
  const crlf = Buffer.from(lf.toString('utf8').replace(/\n/g, '\r\n'));
  check(contentSha('graphs/crate.json', lf) === contentSha('graphs/crate.json', crlf) && sha(lf) !== sha(crlf), 'a graph checked out with CRLF hashes as its LF text');
  write(g, crlf);
  check(fresh(PA, A).state === 'ok', 'a CRLF checkout of a graph leaves the package fresh');
  const r = await cookPkg(PA);
  check(!cookedIds(r.rep) && r.rep!.record === 'unchanged', 'and cooks nothing');
  write(g, lf);
}

section('determinism: two cooks, another path with a space and "é", give the same bytes');
{
  const B = project('b é/game');
  const PB = path.join(B, 'props');
  for (const f of ['graphs/crate.json', 'graphs/yard.json', 'graphs/extra.json', 'inputs/decal.png', 'inputs/notes.txt', 'inputs/extra.txt', 'props.topo']) fs.copyFileSync(path.join(PA, ...f.split('/')), path.join(PB, ...f.split('/')));
  const r = await cookPkg(PB, '--no-cache');
  const same = filesBelow(path.join(PA, 'outputs')).every((f) => sha(read(path.join(PA, 'outputs', ...f.split('/')))) === sha(read(path.join(PB, 'outputs', ...f.split('/')))));
  check(r.code === 0 && cookedIds(r.rep).split(',').length === 6 && same, `the outputs cooked anew at "${path.relative(tmp, B)}" are byte-identical (${stateText(r.rep)})`);
  check(fs.readFileSync(path.join(PA, '.topotopo', 'godot.json'), 'utf8') === fs.readFileSync(path.join(PB, '.topotopo', 'godot.json'), 'utf8'), 'and so are the records');
  const again = await cookPkg(PA, '--force', '--no-cache');
  check(again.code === 0 && again.rep!.outputs.every((o) => o.cooked && o.state !== 'written') && again.rep!.record === 'unchanged', `--force --no-cache cooks everything again to the same bytes (${stateText(again.rep)})`);
}

section('the cache: a second checkout of the package is a copy, not a cook');
{
  const C = project('c');
  const r = await cookPkg(path.join(C, 'props'));
  const s = states(r.rep);
  check(r.code === 0 && ['crate', 'panels', 'props', 'scatter'].every((k) => s[k] === 'cached') && s.island === 'skipped', `every output from the cache (${stateText(r.rep)})`);
  const n = await cookPkg(path.join(project('c2'), 'props'), '--no-cache');
  check(['crate', 'panels', 'props', 'scatter'].every((k) => states(n.rep)[k] === 'written'), `--no-cache cooks them (${stateText(n.rep)})`);
  check(fs.existsSync(path.join(tmp, 'cache', 'cook', 'blobs')), 'the cache lives in $TOPOTOPO_CACHE/cook');
}

section('a failing output keeps its last good file; the others still update');
{
  const glb = path.join(PA, 'outputs', 'crate', 'crate.glb'), before = sha(read(glb));
  const good = fs.readFileSync(path.join(PA, 'graphs', 'crate.json'), 'utf8');
  editJson(path.join(PA, 'graphs', 'crate.json'), (g) => { g.nodes.check = { type: 'assert', in: ['handle'], params: { min_points: 100000, label: 'broken on purpose' } }; g.outputs.crate.node = 'check'; g.output = 'check'; });
  editJson(path.join(PA, 'graphs', 'yard.json'), (g) => { g.nodes.panels.params.seed = 5; });
  const r = await cookPkg(PA);
  const rec = json(path.join(PA, '.topotopo', 'godot.json'));
  const e = r.rep!.outputs.find((o) => o.id === 'crate')!.errors[0];
  check(r.code === 1 && !r.rep!.ok && states(r.rep).crate === 'failed' && states(r.rep).panels === 'written', `exit 1: crate failed, panels updated (${stateText(r.rep)})`);
  check(sha(read(glb)) === before && rec.outputs.crate.state === 'failed' && rec.outputs.crate.files['res://props/outputs/crate/crate.glb'] === before, 'the GLB keeps its last good bytes, and the record its file');
  check(e?.node === 'check' && /broken on purpose/.test(e.message) && rec.outputs.crate.errors[0].node === 'check', `the error names the node: [${e?.node}] ${e?.message}`);
  check(r.err.some((l) => /^TopoTopo: props > crate: \[check\] .*broken on purpose/.test(l)), `and is said as the plugin says it (${r.err.find((l) => /crate/.test(l))})`);
  check(fresh(PA, A).state === 'failed' && fresh(PA, A).path === 'crate', `freshness: failed (${fresh(PA, A).text})`);
  write(path.join(PA, 'graphs', 'crate.json'), good);
  const fixedRun = await cookPkg(PA);
  check(fixedRun.code === 0 && states(fixedRun.rep).crate !== 'failed' && fresh(PA, A).state === 'ok', `fixed, it cooks again and the package is ok (${stateText(fixedRun.rep)})`);
  // a package that does not open: exit 1, nothing written
  const topo = path.join(PA, 'props.topo'), was = fs.readFileSync(topo, 'utf8'), recWas = fs.readFileSync(path.join(PA, '.topotopo', 'godot.json'), 'utf8');
  write(topo, '{ "title": "broken" ');
  const broken = await cookPkg(PA);
  check(broken.code === 1 && broken.rep && !broken.rep.ok && broken.rep.errors.length === 1 && fs.readFileSync(path.join(PA, '.topotopo', 'godot.json'), 'utf8') === recWas,
    `a manifest that cannot be read: exit 1, the report says why, the record is left as it was (${broken.rep?.errors[0]?.slice(0, 80)})`);
  write(topo, was);
}

section('the foreign-file guard: a file the package did not cook is never replaced, unless adopted');
{
  const D = project('d');
  const PD = path.join(D, 'props');
  const foreign = path.join(PD, 'outputs', 'crate', 'crate.glb');
  write(foreign, Buffer.from('a GLB someone else made'));
  const side = path.join(PD, 'outputs', 'crate', 'crate_base_color.png'), imp = path.join(PD, 'outputs', 'crate', 'crate.glb.import');
  write(side, grey(10));
  write(imp, '[remap]\n\nimporter="scene"\n');
  const r = await cookPkg(PD);
  const e = r.rep!.outputs.find((o) => o.id === 'crate')!.errors[0];
  check(r.code === 1 && states(r.rep).crate === 'failed' && read(foreign).toString() === 'a GLB someone else made' && /res:\/\/props\/outputs\/crate\/crate\.glb is there already/.test(e.message) && /--adopt/.test(e.hint),
    `a planted GLB is refused, naming the file and the fix: ${e.message} (${e.hint})`);
  check(['written', 'cached'].includes(states(r.rep).scatter), `the other outputs still cook (${stateText(r.rep)})`);
  const a = await cookPkg(PD, '--adopt');
  check(a.code === 0 && ['written', 'cached'].includes(states(a.rep).crate) && glbJson(new Uint8Array(read(foreign)))?.asset?.extras?.source?.package === 'studio/props', `--adopt takes it over (${stateText(a.rep)})`);
  check(sha(read(side)) === sha(grey(10)) && fs.readFileSync(imp, 'utf8') === '[remap]\n\nimporter="scene"\n', 'Godot\'s extracted texture and the .import beside the GLB are never touched');
  // a file cooked for this package is its own, even without a record (a deleted record)
  fs.rmSync(path.join(PD, '.topotopo'), { recursive: true });
  const own = await cookPkg(PD);
  check(own.code === 0 && Object.values(states(own.rep)).every((s) => s !== 'failed'), `without its record, the package's own GLBs and PNGs are known by their source block and tEXt chunk (${stateText(own.rep)})`);
}

section('orphans: an output no longer published leaves its files, listed until removed');
{
  const png = path.join(PA, 'outputs', 'panels', 'panel_noise.png');
  editJson(path.join(PA, 'graphs', 'yard.json'), (g) => { g.outputs.panels.publish = false; });
  const r = await cookPkg(PA);
  const rec = json(path.join(PA, '.topotopo', 'godot.json'));
  check(r.code === 0 && fs.existsSync(png) && rec.orphans['res://props/outputs/panels/panel_noise.png'] === 'panels' && !rec.outputs.panels && r.rep!.orphans.join() === 'res://props/outputs/panels/panel_noise.png',
    `its PNG stays, and the record lists it as an orphan (${JSON.stringify(rec.orphans)})`);
  const again = await cookPkg(PA);
  check(json(path.join(PA, '.topotopo', 'godot.json')).orphans['res://props/outputs/panels/panel_noise.png'] === 'panels', 'it stays an orphan on the next cook');
  void again;
  fs.rmSync(png);
  const gone = await cookPkg(PA);
  check(!Object.keys(json(path.join(PA, '.topotopo', 'godot.json')).orphans).length && !gone.rep!.orphans.length, 'removed, it leaves the record');
  editJson(path.join(PA, 'graphs', 'yard.json'), (g) => { delete g.outputs.panels.publish; });
  await cookPkg(PA);
}

section('options: --skip, --instancing expand, --flat --into, the import file, flags over it');
{
  let r = await cookPkg(PA, '--skip', 'scatter');
  let rec = json(path.join(PA, '.topotopo', 'godot.json'));
  check(states(r.rep).scatter === 'skipped' && /skip/.test(rec.skipped.scatter.why) && rec.options.skip.join() === 'scatter' && rec.orphans['res://props/outputs/scatter/scatter.glb'] === 'scatter',
    `--skip scatter: skipped, its GLB kept as an orphan (${rec.skipped.scatter.why})`);
  r = await cookPkg(PA, '--instancing', 'expand');
  const sc = glbJson(new Uint8Array(read(path.join(PA, 'outputs', 'scatter', 'scatter.glb'))));
  check(r.code === 0 && states(r.rep).scatter === 'written' && !(sc.extensionsUsed ?? []).includes('EXT_mesh_gpu_instancing') && json(path.join(PA, '.topotopo', 'godot.json')).options.instancing === 'expand',
    '--instancing expand: real copies, no EXT_mesh_gpu_instancing');
  r = await cookPkg(PA, '--flat', '--into', path.join(A, 'flat'));
  rec = json(path.join(PA, '.topotopo', 'godot.json'));
  check(r.code === 0 && filesBelow(path.join(A, 'flat')).join() === 'crate.glb,extra.glb,panel_noise.png,props.glb,scatter.glb' && rec.options.folder === 'res://flat' && !rec.options.per_output_folders,
    `--flat --into: every file in one folder (${filesBelow(path.join(A, 'flat')).join(', ')})`);
  check(Object.keys(rec.orphans).length === 5 && fs.existsSync(path.join(PA, 'outputs', 'crate', 'crate.glb')), 'the files in the old folder stay, as orphans');
  write(path.join(PA, 'props.topo.import'), '[remap]\n\nimporter="topotopo.package"\ntype="Resource"\n\n[params]\n\noutputs/folder="res://imported"\noutputs/per_output_folders=false\noutputs/skip="extra, island"\ninstances/mode=1\n');
  r = await cookPkg(PA);
  rec = json(path.join(PA, '.topotopo', 'godot.json'));
  check(JSON.stringify(rec.options) === JSON.stringify({ folder: 'res://imported', instancing: 'expand', per_output_folders: false, skip: ['extra', 'island'] }) && fs.existsSync(path.join(A, 'imported', 'crate.glb')),
    `the options come from props.topo.import [params] (${JSON.stringify(rec.options)})`);
  r = await cookPkg(PA, '--into', 'res://props/outputs', '--skip', '', '--instancing', 'packed');
  rec = json(path.join(PA, '.topotopo', 'godot.json'));
  check(rec.options.folder === 'res://props/outputs' && !rec.options.per_output_folders && rec.options.instancing === 'packed' && !rec.options.skip.length, `flags override them (${JSON.stringify(rec.options)})`);
  fs.rmSync(path.join(PA, 'props.topo.import'));
  r = await cookPkg(PA);
  check(r.code === 0 && json(path.join(PA, '.topotopo', 'godot.json')).options.per_output_folders && fresh(PA, A).state === 'ok', 'back to the defaults');
}

section('--locked rules and setup errors: nothing of the package is written; exit 2 for what cannot be cooked');
{
  const E = project('e');
  const PE = path.join(E, 'props');
  const topoWas = fs.readFileSync(path.join(PE, 'props.topo'), 'utf8');
  write(path.join(PE, 'graphs', 'uses.json'), JSON.stringify({ nodes: { c: { type: 'topotopo/props/crate' } }, output: 'c', outputs: { borrowed: { node: 'c' } } }, null, 2) + '\n');
  const r = await cookPkg(PE);
  const e = r.rep!.outputs.find((o) => o.id === 'borrowed')?.errors[0];
  check(r.code === 1 && states(r.rep).borrowed === 'failed' && /names topotopo\/props, which props\.topo does not use: topotopo use topotopo\/props adds it/.test(e?.message ?? '') && !/without --locked/.test(e?.message ?? '') && states(r.rep).crate !== 'failed',
    `a graph naming a package the package does not use fails with the --locked message (${e?.message})`);
  check(fs.readFileSync(path.join(PE, 'props.topo'), 'utf8') === topoWas && !fs.existsSync(path.join(PE, 'packages')) && !fs.existsSync(path.join(E, 'topotopo-packages')), 'the manifest is left as it was and no copy or lock is written');
  // a published copy
  const V = path.join(PE, 'versions', '1.0');
  fs.mkdirSync(V, { recursive: true });
  fs.copyFileSync(path.join(PE, 'props.topo'), path.join(V, 'props.topo'));
  write(path.join(V, 'version.json'), '{}\n');
  const copy = await cook([path.join(V, 'props.topo'), '--for', 'godot']);
  check(copy.code === 2 && /published copy/.test(copy.text) && !fs.existsSync(path.join(V, '.topotopo')), `a version copy exits 2 (${copy.text.split('\n')[0]})`);
  const outside = path.join(tmp, 'no-project', 'props');
  copyDir(FIXTURE, outside);
  const o = await cook([outside, '--for', 'godot']);
  check(o.code === 2 && /no Godot project/.test(o.text) && !fs.existsSync(path.join(outside, '.topotopo')), `a package outside a Godot project exits 2 (${o.text})`);
  const rootPkg = path.join(tmp, 'rootpkg');
  copyDir(FIXTURE, rootPkg);
  write(path.join(rootPkg, 'project.godot'), 'config_version=5\n');
  const root = await cook([rootPkg, '--for', 'godot']);
  check(root.code === 2 && /root of its Godot project/.test(root.text), `a package at the project's root exits 2 (${root.text.split(':').slice(-1)[0].trim().slice(0, 60)})`);
  for (const [args, what] of [[[PE], 'no --for'], [[PE, '--for', 'unreal'], '--for unreal'], [[PE, '--for', 'godot', '--progress', 'text'], '--progress text'], [['--jobs', REPORT, '--into', E], '--jobs with --into'], [[PE, '--for', 'godot', '--bogus'], 'an unknown option'], [[path.join(E, 'nothing'), '--for', 'godot'], 'a missing target']] as [string[], string][]) {
    const u = await cook(args);
    check(u.code === 2, `${what}: exit 2 (${u.text.split('\n')[0]})`);
  }
  const jobs = path.join(tmp, 'jobs-v2.json');
  write(jobs, JSON.stringify({ for: 'godot', protocol: 2, jobs: [{ package: path.join(PE, 'props.topo') }] }));
  const p = await cook(['--jobs', jobs]);
  check(p.code === 2 && /update the Godot addon: topotopo godot setup /.test(p.text), `another protocol exits 2 (${p.text})`);
}

section('unique names: two graphs publishing one output, and a named output taking the default output\'s name, fail and name both graphs');
{
  const U = project('unique');
  const PU = path.join(U, 'props');
  await cookPkg(PU);
  const glb = path.join(PU, 'outputs', 'crate', 'crate.glb'), before = sha(read(glb));
  write(path.join(PU, 'graphs', 'twin.json'), JSON.stringify({ nodes: { b: { type: 'box' } }, output: 'b', outputs: { crate: { node: 'b' }, props: { node: 'b' } } }, null, 2) + '\n');
  const r = await cookPkg(PU);
  const crate = r.rep!.outputs.find((o) => o.id === 'crate')!, def = r.rep!.outputs.find((o) => o.id === 'props')!;
  check(r.code === 1 && crate.state === 'failed' && /published by graphs "crate" and "twin"/.test(crate.errors[0]?.message ?? '') && sha(read(glb)) === before,
    `two graphs publishing "crate": it fails naming both, its last good GLB kept (${crate.errors[0]?.message.slice(0, 70)})`);
  check(def.state === 'failed' && /named after the package, "props", and output "props" \(graph "twin"\)/.test(def.errors[0]?.message ?? '') && states(r.rep).scatter !== 'failed',
    `a named output called like the package: the default output and it fail, naming both graphs; the others cook (${def.errors[0]?.message.slice(0, 70)})`);
}

section('the lock: a cook waits for another cook of the package, and takes over a dead one\'s lock');
{
  const F = project('f');
  const PF = path.join(F, 'props');
  const lock = path.join(PF, '.topotopo', 'cook.lock');
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  write(lock, `${holder.pid} held by a test\n`);
  const child = spawn(process.execPath, [CLI, 'cook', PF, '--for', 'godot', '--progress', 'json'], { env: { ...process.env, TOPOTOPO_WORKERS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const exited = new Promise<number>((resolve) => child.on('exit', (c) => resolve(c ?? -1)));
  await new Promise((r) => setTimeout(r, 2000));
  check(child.exitCode === null && !out.includes('"event":"start"') && !fs.existsSync(path.join(PF, 'outputs')), 'while another live process holds the lock, the cook waits and writes nothing');
  holder.kill();
  const code = await exited;
  check(code === 0 && out.includes('"event":"done"') && fs.existsSync(path.join(PF, 'outputs', 'crate', 'crate.glb')) && !fs.existsSync(lock), `once that process has ended, it takes the lock over and cooks (exit ${code})`);
  // two cooks at once: both finish, one after the other, with one consistent record
  const both = await Promise.all([0, 1].map(() => new Promise<number>((resolve) => {
    const c = spawn(process.execPath, [CLI, 'cook', PF, '--for', 'godot', '--force', '--quiet'], { env: { ...process.env, TOPOTOPO_WORKERS: '0' }, stdio: 'ignore' });
    c.on('exit', (x) => resolve(x ?? -1));
  })));
  check(both.every((c) => c === 0) && fresh(PF, F).state === 'ok' && !fs.existsSync(lock), `two concurrent cooks both succeed, serialised, and leave one current record (${both.join(', ')})`);
  // what a stopped cook left: parts beside the record's files and in an output's own folder
  const parts = [path.join(PF, 'outputs', 'crate', 'crate.glb.topotopo-part'), path.join(PF, 'outputs', 'scatter', 'stray.png.topotopo-part')];
  for (const p of parts) write(p, 'half a file');
  const after = await cookPkg(PF);
  check(after.code === 0 && parts.every((p) => !fs.existsSync(p)), 'a cook removes the parts a stopped cook left');
}

section('the jobs file: three packages in one process, ASCII progress lines, a report each');
{
  const G = project('jobs é', null);
  const ids = ['crates', 'yards', 'stones'];
  for (const id of ids) {
    const d = path.join(G, 'assets', id);
    copyDir(FIXTURE, d);
    fs.renameSync(path.join(d, 'props.topo'), path.join(d, `${id}.topo`));
    editJson(path.join(d, `${id}.topo`), (m) => { m.name = `studio/${id}`; });
  }
  const reports = ids.map((id) => path.join(G, '.godot', 'topotopo', `${id}.report.json`));
  const jobs = path.join(G, '.godot', 'topotopo', 'jobs.json');
  write(jobs, JSON.stringify({ for: 'godot', protocol: 1, jobs: ids.map((id, i) => ({ package: path.join(G, 'assets', id, `${id}.topo`).split(path.sep).join('/'), into: path.join(G, 'assets', id, 'outputs').split(path.sep).join('/'), per_output_folders: true, skip: id === 'stones' ? ['island'] : [], instancing: 'packed', report: reports[i], timeout: 600 })) }));
  const r = spawnSync(process.execPath, [CLI, 'cook', '--jobs', jobs, '--progress', 'json'], { encoding: 'utf8', env: { ...process.env, TOPOTOPO_WORKERS: '0' } });
  const lines = r.stdout.split(/\r?\n/).filter(Boolean);
  const events = lines.map((l) => JSON.parse(l));
  check(r.status === 0 && events.filter((e) => e.event === 'start').length === 3 && events.filter((e) => e.event === 'done' && e.ok).length === 3, `one process cooks the three packages (exit ${r.status}, ${events.length} progress lines)`);
  check(lines.every((l) => /^[\x20-\x7e]*$/.test(l)) && lines.some((l) => l.includes('\\u00e9')) && events[0].package.includes('jobs é'), 'progress lines are ASCII, "é" escaped as \\u00e9');
  check(events.filter((e) => e.event === 'output').every((e) => typeof e.output === 'string' && ['written', 'unchanged', 'cached', 'failed', 'skipped'].includes(e.state) && typeof e.ms === 'number'), 'each output event names the output, its state and its time');
  const reps = reports.map((f) => (fs.existsSync(f) ? json(f) : null));
  check(reps.every((x, i) => x && x.ok && x.package.id === ids[i] && x.protocol === 1) && reps[2].outputs.find((o: any) => o.id === 'island').state === 'skipped',
    'a report per package, as the job named it');
  check(events.filter((e) => e.event === 'done').map((e) => e.report).every((p: string, i: number) => p === reports[i].split(path.sep).join('/')), 'the done line names its report');
}

section('a timeout: the cook stops, the remaining outputs fail, the record and report are written');
{
  const H = project('h');
  const r = await cookPkg(path.join(H, 'props'), '--timeout', '0.001', '--no-cache');
  check(r.code === 1 && r.rep && !r.rep.ok && r.rep.errors.some((e) => /timed out/.test(e)) && r.rep.outputs.some((o) => o.errors.some((e) => /timed out/.test(e.message))) && fs.existsSync(path.join(H, 'props', '.topotopo', 'godot.json')),
    `exit 1, the report says it timed out (${stateText(r.rep)})`);
  const again = await cookPkg(path.join(H, 'props'));
  check(again.code === 0 && fresh(path.join(H, 'props'), H).state === 'ok', 'the next cook finishes it');
}

// ------------------------------------------------------------------------------------------------------- godot
section('godot setup: the addon, the install record, .gdignore, the plugin, .gitignore, export presets');
{
  const S = project('setup', 'assets/props');
  const PS = path.join(S, 'assets', 'props');
  fs.mkdirSync(path.join(PS, 'exports'), { recursive: true });
  write(path.join(S, 'export_presets.cfg'), '[preset.0]\n\nname="Pack"\nplatform="Windows Desktop"\nexport_filter="all_resources"\ninclude_filter="*.json, *.txt"\nexclude_filter=""\n\n[preset.0.options]\n\n[preset.1]\n\nname="Server"\nexclude_filter="*/graphs/*"\n');
  write(path.join(S, '.gitignore'), '.godot/\n');
  const addon = path.join(tmp, 'addon-src');
  write(path.join(addon, 'plugin.cfg'), '[plugin]\nname="TopoTopo"\nscript="plugin.gd"\n');
  write(path.join(addon, 'plugin.gd'), '@tool\nextends EditorPlugin\n');
  write(path.join(S, 'addons', 'topotopo', 'old.gd'), '# from an older addon\n');
  write(path.join(S, 'addons', 'topotopo', 'plugin.gd.uid'), 'uid://abc\n');
  const said = godotSetup(S, { addon });
  check(fs.existsSync(path.join(S, 'addons', 'topotopo', 'plugin.cfg')) && !fs.existsSync(path.join(S, 'addons', 'topotopo', 'old.gd')) && fs.existsSync(path.join(S, 'addons', 'topotopo', 'plugin.gd.uid')),
    'the addon is copied into addons/topotopo/ (a file of an older addon goes, the .uid Godot wrote stays)');
  const inst = readInstall();
  check(inst?.node === process.execPath && inst.cli === path.join(ROOT, 'src', 'cli.ts'), `the install record names node and the CLI (${inst?.cli})`);
  check(['graphs', 'inputs', 'exports'].every((d) => fs.existsSync(path.join(PS, d, '.gdignore'))) && !fs.existsSync(path.join(PS, 'assets')), 'a .gdignore in each TopoTopo folder the package has');
  const pg = fs.readFileSync(path.join(S, 'project.godot'), 'utf8');
  check(/\[editor_plugins\]\n\nenabled=PackedStringArray\("res:\/\/addons\/topotopo\/plugin\.cfg"\)/.test(pg), 'the plugin is enabled in project.godot');
  check(fs.readFileSync(path.join(S, '.gitignore'), 'utf8') === '.godot/\n*.topotopo-part\n**/.topotopo/cook.lock\n', 'the cook\'s files are in .gitignore');
  const presets = fs.readFileSync(path.join(S, 'export_presets.cfg'), 'utf8');
  check(/exclude_filter="addons\/topotopo\/\*"/.test(presets) && /exclude_filter="\*\/graphs\/\*, addons\/topotopo\/\*"/.test(presets), 'every export preset excludes addons/topotopo/*');
  check(said.length >= 6 && said.some((l) => /enabled the plugin/.test(l)) && said.some((l) => /export preset/.test(l)), `setup says each step (${said.length} lines)`);
  const twice = godotSetup(S, { addon });
  check(fs.readFileSync(path.join(S, 'project.godot'), 'utf8') === pg && fs.readFileSync(path.join(S, 'export_presets.cfg'), 'utf8') === presets && /already/.test(twice.join('\n')), 'run again, it changes nothing and says so');
  check(enablePlugin('[editor_plugins]\n\nenabled=PackedStringArray("res://addons/other/plugin.cfg")\n') === '[editor_plugins]\n\nenabled=PackedStringArray("res://addons/other/plugin.cfg", "res://addons/topotopo/plugin.cfg")\n'
    && excludeAddon('exclude_filter="a/*"\n') === 'exclude_filter="a/*, addons/topotopo/*"\n', 'another enabled plugin and another exclude entry are kept');
  const noAddon = (() => { try { godotSetup(S, { addon: path.join(tmp, 'none') }); return ''; } catch (e: any) { return e.message; } })();
  check(/carries no Godot addon/.test(noAddon), `a TopoTopo without the addon says so (${noAddon.slice(0, 60)})`);
  const R = project('setup-root', null);
  copyDir(FIXTURE, R);
  const rootSaid = godotSetup(R, { addon });
  check(rootSaid.some((l) => /not supported: props\.topo makes the project's root a package/.test(l)) && !fs.existsSync(path.join(R, 'graphs', '.gdignore')), 'a package at the project\'s root is refused, and no .gdignore is written for it');
  const st = godotStatus(R);
  check(!st.ok && st.root.length === 1, 'status lists it as unsupported');
}

section('godot status: every package Godot sees; --strict exits 1 on stale, failed, never cooked and exposed');
{
  const T = project('status', 'assets/props');
  const PT = path.join(T, 'assets', 'props');
  let s = await godot(['status', T, '--strict']);
  check(s.code === 1 && /never cooked\s+res:\/\/assets\/props\/props\.topo/.test(s.out) && /exposed: Godot imports graphs\/, inputs\//.test(s.out), `never cooked and exposed folders: exit 1 (${s.out.split('\n')[1]?.trim()})`);
  godotSetup(T, { addon: path.join(tmp, 'addon-src') });
  await cookPkg(PT);
  s = await godot(['status', T, '--strict']);
  check(s.code === 0 && /^\s+ok\s+res:\/\/assets\/props\/props\.topo/m.test(s.out) && /crate: ok mesh → res:\/\/assets\/props\/outputs\/crate\/crate\.glb/.test(s.out), `cooked and hidden: exit 0\n${s.out.split('\n').slice(0, 4).join('\n')}`);
  editJson(path.join(PT, 'graphs', 'crate.json'), (g) => { g.nodes.paint.params.roughness = 0.2; });
  s = await godot(['status', T, '--strict', '--json']);
  const j = JSON.parse(s.out);
  check(s.code === 1 && j.packages[0].state === 'stale' && j.packages[0].why === 'source' && j.packages[0].path === 'graphs/crate.json' && !j.ok, `a changed graph: stale, naming it, exit 1 (--json: ${j.packages[0].text})`);
  check((await godot(['status', T])).code === 0, 'without --strict it exits 0');
  await cookPkg(PT);
  const V = path.join(PT, 'versions', '1.0');
  fs.rmSync(path.join(PT, 'versions'), { recursive: true, force: true });
  fs.mkdirSync(V, { recursive: true });
  fs.copyFileSync(path.join(PT, 'props.topo'), path.join(V, 'props.topo'));
  write(path.join(V, 'version.json'), '{}\n');
  s = await godot(['status', T, '--strict']);
  check(s.code === 1 && /copy\s+res:\/\/assets\/props\/versions\/1\.0\/props\.topo: a published copy Godot sees/.test(s.out) && /exposed: Godot imports versions\//.test(s.out), 'a published copy Godot sees, and its folder, fail --strict');
  write(path.join(PT, 'versions', '.gdignore'), '');
  s = await godot(['status', T, '--strict']);
  check(s.code === 0, `hidden again (.gdignore), status is clean (${s.out.split('\n').pop()})`);
  const noProject = await godot(['status', path.join(tmp, 'nothing-here')]);
  check(noProject.code === 2, 'a folder that is no Godot project exits 2');
  check((await godot(['bogus'])).code === 2 && (await godot([])).code === 2, 'an unknown godot command exits 2');
}

section('LFS: output folders no pattern covers, in a repository that uses LFS');
{
  const L = project('lfs', 'assets/props');
  const git = (args: string[]) => spawnSync('git', args, { cwd: L, encoding: 'utf8' });
  if (git(['init', '-q']).status !== 0) console.log('SKIP git is not available');
  else {
    write(path.join(L, '.gitattributes'), '*.glb filter=lfs diff=lfs merge=lfs -text\n');
    await cookPkg(path.join(L, 'assets', 'props'));
    let st = godotStatus(L);
    check(st.packages[0].lfs.includes('res://assets/props/outputs/panels') && st.packages[0].lfs.length === 4, `*.glb alone: every output folder lacks a PNG pattern (${st.packages[0].lfs.join(', ')})`);
    const said = godotSetup(L, { addon: path.join(tmp, 'addon-src') });
    check(said.some((l) => /uses LFS and no pattern covers res:\/\/assets\/props\/outputs\/crate/.test(l)), 'setup warns about them');
    write(path.join(L, '.gitattributes'), '*.glb filter=lfs diff=lfs merge=lfs -text\n*.png filter=lfs diff=lfs merge=lfs -text\n');
    st = godotStatus(L);
    check(!st.packages[0].lfs.length && st.ok, 'with *.png covered too, none');
    const plain = godotStatus(path.join(tmp, 'status'));
    check(plain.packages.every((p) => !p.lfs.length), 'a project in no repository using LFS gets no LFS warning');
  }
}

// ------------------------------------------------------------------------------------------- freshness goldens
section('freshness golden values: the one definition the Godot addon ports');
{
  const golden = freshnessGoldens();
  const text = JSON.stringify(golden, null, 1) + '\n';
  if (UPDATE) { fs.writeFileSync(GOLDEN, text); console.log(`wrote ${path.relative(ROOT, GOLDEN)}`); }
  check(fs.existsSync(GOLDEN) && fs.readFileSync(GOLDEN, 'utf8').replace(/\r\n/g, '\n') === text, `${path.relative(ROOT, GOLDEN)} is current (node test/cook.ts --update rewrites it)`);
  for (const c of golden.contentSha) {
    const bytes = Buffer.from(c.base64, 'base64');
    check(contentSha(c.name, bytes) === c.sha, `contentSha ${c.name}: ${c.what}`);
  }
  for (const c of golden.cases) {
    const proj = path.join(tmp, 'golden', c.name.replace(/[^a-z0-9]+/gi, '_'));
    for (const [rel, b64] of Object.entries(c.files)) write(path.join(proj, ...rel.split('/')), Buffer.from(b64 as string, 'base64'));
    const pkg = path.join(proj, ...c.package.split('/'));
    const f = freshness(pkg, c.record as CookRecord | null, c.options as EngineOptions, { for: 'godot', absolutePath: (r) => path.join(proj, ...r.slice(6).split('/')), installed: c.installed });
    const got = { state: f.state, why: f.why, path: f.path, note: f.note };
    check(JSON.stringify(got) === JSON.stringify(c.expect), `${c.name}: ${JSON.stringify(got)}`);
  }
}

// ------------------------------------------------------------------------------------------------ the commands
section('the commands: every list of them says them the same way');
{
  const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' }).stdout;
  const lists: [string, string, string][] = [
    ['src/cli.ts (its header)', fs.readFileSync(CLI, 'utf8'), '//   node src/cli.ts '],
    ['--help', help, 'node src/cli.ts '],
    ['README.md', fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8'), 'topotopo '],
    ['help topic "godot"', topicText('godot') ?? '', 'topotopo '],
    ['integrations/godot/PROTOCOL.md', fs.existsSync(path.join(ROOT, 'integrations', 'godot', 'PROTOCOL.md')) ? fs.readFileSync(path.join(ROOT, 'integrations', 'godot', 'PROTOCOL.md'), 'utf8') : '', 'topotopo '],
  ];
  for (const [where, text, prefix] of lists) {
    const missing = GODOT_COMMANDS.filter((c) => !text.includes(`${prefix}${c.usage}`)).map((c) => c.usage);
    check(!missing.length, `${where} lists every command as GODOT_COMMANDS says it${missing.length ? `: missing ${missing.join(' | ')}` : ''}`);
  }
}

/**
 * The freshness golden values: contentSha of LF text, CRLF text, a lone CR, a PNG, text with a NUL; and packages with
 * records checked against their files (every rule of freshness(), each way it reads stale, the version rule both
 * ways, TopoTopo not found). Files are base64 by their path in a project; output files as the record names them.
 */
function freshnessGoldens() {
  const b64 = (s: string | Uint8Array) => Buffer.from(s).toString('base64');
  const lf = '{\n  "nodes": {"b": {"type": "box"}},\n  "output": "b"\n}\n';
  const crlf = lf.replace(/\n/g, '\r\n');
  // a 2×2 PNG, written out (not encoded here: compressed bytes may differ between zlib builds)
  const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAF0lEQVR42mP4z8DwHwwZGP7/5+Xi5QIAQEgGKSO6X8QAAAAASUVORK5CYII=', 'base64'));
  const nul = 'a\r\nb\u0000c\r\n';
  const loneCr = 'one\rtwo\r\nthree\n';
  const contentShaCases = [
    { name: 'graphs/a.json', what: 'LF text, hashed as it is', base64: b64(lf) },
    { name: 'graphs/a.json', what: 'the same text with CRLF line ends: the same hash', base64: b64(crlf) },
    { name: 'inputs/lone.txt', what: 'a lone CR is kept; CRLF is read as LF', base64: b64(loneCr) },
    { name: 'inputs/decal.png', what: 'a PNG (a binary format by its name) is hashed raw, CR LF bytes and all', base64: b64(png) },
    { name: 'inputs/blob.txt', what: 'text with a NUL in its first 8000 bytes is binary: hashed raw, CRLF kept', base64: b64(nul) },
    { name: 'inputs/IMAGE.PNG', what: 'binary names ignore case', base64: b64(crlf) },
  ].map((c) => ({ ...c, sha: contentSha(c.name, Buffer.from(c.base64, 'base64')) }));
  const glb = new TextEncoder().encode('glTF stands in for a cooked GLB\r\n');
  const files: Record<string, string> = {
    'project.godot': b64('config_version=5\n'),
    'props/props.topo': b64('{\n  "title": "Props",\n  "graph": "a"\n}\n'),
    'props/graphs/a.json': b64(lf),
    'props/inputs/decal.png': b64(png),
    'props/inputs/notes.txt': b64('nothing reads this\n'),
    'props/outputs/a/a.glb': b64(glb),
  };
  const opts: EngineOptions = { folder: 'res://props/outputs', instancing: 'packed', per_output_folders: true, skip: [] };
  const record = (o: Partial<CookRecord> = {}): CookRecord => ({
    folders: { assets: [], graphs: ['a.json'], inputs: ['decal.png', 'notes.txt'] }, for: 'godot', name: null, notes: [], options: opts, orphans: {},
    outputs: {
      a: {
        default: true, deps: ['graphs/a.json', 'inputs/decal.png', 'props.topo'], errors: [], files: { 'res://props/outputs/a/a.glb': sha(glb) }, folders: [], graph: 'a',
        instances: {}, kind: 'mesh', label: 'a', node: 'b', state: 'ok', warnings: [],
      },
    },
    package: 'props', schema: 1, skipped: {},
    sources: { 'graphs/a.json': contentSha('graphs/a.json', Buffer.from(lf)), 'inputs/decal.png': sha(png), 'props.topo': contentSha('props.topo', Buffer.from('{\n  "title": "Props",\n  "graph": "a"\n}\n')) },
    topotopo: '0.4.0', ...o,
  });
  const with_ = (over: Record<string, string | null>) => { const f = { ...files }; for (const [k, v] of Object.entries(over)) { if (v === null) delete f[k]; else f[k] = v; } return f; };
  const failed = record();
  failed.outputs.a = { ...failed.outputs.a, state: 'failed', errors: [{ node: 'b', message: 'broken', hint: '' }] };
  const cases: { name: string; files: Record<string, string>; package: string; record: CookRecord | null; options: EngineOptions; installed: string | null; expect: Record<string, string> }[] = [
    { name: 'ok', files, package: 'props', record: record(), options: opts, installed: '0.4.0', expect: { state: 'ok', why: '', path: '', note: '' } },
    { name: 'ok with a CRLF checkout of a graph', files: with_({ 'props/graphs/a.json': b64(crlf) }), package: 'props', record: record(), options: opts, installed: '0.4.0', expect: { state: 'ok', why: '', path: '', note: '' } },
    { name: 'ok with the files engines write beside ours', files: with_({ 'props/inputs/decal.png.import': b64('[remap]\n'), 'props/graphs/a.json.uid': b64('uid://x\n'), 'props/inputs/.gdignore': '', 'props/inputs/.hidden/x.txt': b64('x'), 'props/inputs/decal.png.topotopo-part': b64('part') }), package: 'props', record: record(), options: opts, installed: '0.4.0', expect: { state: 'ok', why: '', path: '', note: '' } },
    { name: 'ok when TopoTopo is not found', files, package: 'props', record: record(), options: opts, installed: null, expect: { state: 'ok', why: '', path: '', note: '' } },
    { name: 'never cooked', files, package: 'props', record: null, options: opts, installed: '0.4.0', expect: { state: 'never_cooked', why: 'record', path: '', note: '' } },
    { name: 'a newer schema', files, package: 'props', record: record({ schema: 2 }), options: opts, installed: '0.4.0', expect: { state: 'stale', why: 'newer_schema', path: '', note: '' } },
    { name: 'another flavour', files, package: 'props', record: record({ for: 'unreal' }), options: opts, installed: '0.4.0', expect: { state: 'stale', why: 'schema', path: '', note: '' } },
    { name: 'other options', files, package: 'props', record: record(), options: { ...opts, skip: ['a'] }, installed: '0.4.0', expect: { state: 'stale', why: 'options', path: '', note: '' } },
    { name: 'the same options, skip in another order', files, package: 'props', record: record({ options: { ...opts, skip: ['b', 'a'] } }), options: { ...opts, skip: ['a', 'b'] }, installed: '0.4.0', expect: { state: 'ok', why: '', path: '', note: '' } },
    { name: 'a source changed', files: with_({ 'props/graphs/a.json': b64(lf.replace('box', 'grid')) }), package: 'props', record: record(), options: opts, installed: '0.4.0', expect: { state: 'stale', why: 'source', path: 'graphs/a.json', note: '' } },
    { name: 'a binary source changed', files: with_({ 'props/inputs/decal.png': b64(new Uint8Array([...png, 0])) }), package: 'props', record: record(), options: opts, installed: '0.4.0', expect: { state: 'stale', why: 'source', path: 'inputs/decal.png', note: '' } },
    { name: 'a source missing', files: with_({ 'props/props.topo': null }), package: 'props', record: record(), options: opts, installed: '0.4.0', expect: { state: 'stale', why: 'source', path: 'props.topo', note: '' } },
    { name: 'a new file in inputs', files: with_({ 'props/inputs/new.txt': b64('new\n') }), package: 'props', record: record(), options: opts, installed: '0.4.0', expect: { state: 'stale', why: 'folder', path: 'inputs', note: '' } },
    { name: 'a new graph in a subfolder', files: with_({ 'props/graphs/more/b.json': b64(lf) }), package: 'props', record: record(), options: opts, installed: '0.4.0', expect: { state: 'stale', why: 'folder', path: 'graphs', note: '' } },
    { name: 'a file gone from inputs', files: with_({ 'props/inputs/notes.txt': null }), package: 'props', record: record(), options: opts, installed: '0.4.0', expect: { state: 'stale', why: 'folder', path: 'inputs', note: '' } },
    { name: 'an output file changed', files: with_({ 'props/outputs/a/a.glb': b64('glTF changed by hand\n') }), package: 'props', record: record(), options: opts, installed: '0.4.0', expect: { state: 'stale', why: 'output', path: 'res://props/outputs/a/a.glb', note: '' } },
    { name: 'an output file missing', files: with_({ 'props/outputs/a/a.glb': null }), package: 'props', record: record(), options: opts, installed: '0.4.0', expect: { state: 'stale', why: 'output', path: 'res://props/outputs/a/a.glb', note: '' } },
    { name: 'a newer TopoTopo is installed', files, package: 'props', record: record(), options: opts, installed: '0.10.0', expect: { state: 'stale', why: 'version', path: '', note: '' } },
    { name: 'an older TopoTopo is installed', files, package: 'props', record: record({ topotopo: '0.4.1' }), options: opts, installed: '0.4.0', expect: { state: 'ok', why: '', path: '', note: 'update_topotopo' } },
    { name: 'a failed output', files, package: 'props', record: failed, options: opts, installed: '0.4.0', expect: { state: 'failed', why: 'failed', path: 'a', note: '' } },
    { name: 'the first rule that applies wins', files: with_({ 'props/graphs/a.json': b64('changed\n'), 'props/inputs/new.txt': b64('new\n') }), package: 'props', record: record({ topotopo: '0.1.0' }), options: opts, installed: '0.4.0', expect: { state: 'stale', why: 'source', path: 'graphs/a.json', note: '' } },
  ];
  return {
    about: 'Freshness golden values for the Godot addon (record.gd): contentSha of each file, and packages whose freshness is checked against their files. Made by test/cook.ts (node test/cook.ts --update); integrations/godot/PROTOCOL.md defines the rules.',
    contentSha: contentShaCases,
    cases,
  };
}

console.log(`\n${passes} passed, ${failures} failed${failures ? ` — temp ${tmp}` : ''}`);
if (!failures) fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
