// The cook for Unreal and the plugin's setup, without the editor: `topotopo unreal setup` (the plugin copied, the .uproject, the
// Auto Reimport exclusions, .gitignore, idempotence, refusals), the cook's mapping of output kinds to files and import steps
// (src/host/unreal.ts, integrations/unreal/PROTOCOL.md), axes in rows and sockets, freshness and incremental cooks, a failed output
// keeping its last good files, status, the jobs file, and that the plugin's C++ speaks the same protocol and exclusions. What the
// plugin does in the editor (import, reimport, Auto Reimport) is not checked here.
import './cache-guard.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import '../src/nodes/index.ts';
import { cookCommand } from '../src/host/cook-command.ts';
import { COOK_PROTOCOL, RECORD_SCHEMA } from '../src/host/cook.ts';
import { GITIGNORE_LINES, PLUGIN_NAME, PLUGIN_SOURCE, REIMPORT_INI, UNREAL_EXCLUDES, assetName, contentPathOf, enableInUproject, isContentPath, missingExcludes, normalContentPath, unrealCommand, unrealPlan, unrealStatus, withExcludes } from '../src/host/unreal.ts';
import { UNREAL_COMMANDS } from '../src/host/unreal-commands.ts';
import { topicText } from '../src/mcp/docs.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src', 'cli.ts');
const FIXTURE = path.join(ROOT, 'test', 'data', 'cook', 'props');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'topotopo-unreal-'));
process.env.TOPOTOPO_CONFIG = path.join(tmp, 'config.json');
process.env.TOPOTOPO_CACHE = path.join(tmp, 'cache');

let fail = 0, pass = 0;
const check = (ok: boolean, what: string) => { if (ok) { pass++; console.log(`  ok   ${what}`); } else { fail++; console.log(`  FAIL ${what}`); } };
const section = (s: string) => console.log(`\n${s}`);
const write = (f: string, text: string) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const copyDir = (from: string, to: string) => fs.cpSync(from, to, { recursive: true });
const posix = (p: string) => p.split(path.sep).join('/');

/** An empty Unreal project; `props` puts the fixture package at Content/props. */
function project(name: string, props = true): string {
  const dir = path.join(tmp, name);
  write(path.join(dir, `${name}.uproject`), JSON.stringify({ FileVersion: 3, EngineAssociation: '5.8', Plugins: [{ Name: 'PythonScriptPlugin', Enabled: true }] }, null, '\t') + '\n');
  if (props) copyDir(FIXTURE, path.join(dir, 'Content', 'props'));
  return dir;
}

async function run(fn: (argv: string[], io: { out: (s: string) => void; err: (s: string) => void }) => Promise<number>, argv: string[]) {
  const out: string[] = [], err: string[] = [];
  const code = await fn(argv, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join('\n'), err: err.join('\n'), text: [...out, ...err].join('\n') };
}
const cook = (argv: string[]) => run(cookCommand as any, argv);
const unreal = (argv: string[]) => run(unrealCommand as any, argv);
const readJson = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));

/** A small package in a project's Content/<name>: one graph, its outputs, and an import file when given. */
function pkg(game: string, name: string, nodes: Record<string, unknown>, outputs: Record<string, unknown>, importText?: string): string {
  const dir = path.join(game, 'Content', name);
  write(path.join(dir, `${name}.topo`), JSON.stringify({ title: name, graph: name, created: '2026-01-01', name: `studio/${name}` }));
  write(path.join(dir, 'graphs', `${name}.json`), JSON.stringify({ nodes, output: Object.values(outputs as Record<string, { node: string }>)[0].node, outputs }));
  if (importText) write(path.join(dir, `${name}.topo.import`), importText);
  return dir;
}

// ---------------------------------------------------------------------------------------------------------- paths
section('content paths');
{
  const p = path.join(tmp, 'paths');
  check(contentPathOf(p, path.join(p, 'Content', 'props')) === '/Game/props', 'Content/props is /Game/props');
  let threw = '';
  try { contentPathOf(p, path.join(p, 'Plugins', 'Kit', 'Content', 'props')); } catch (e: any) { threw = e.message; }
  check(/in the plugin Kit: .*belong under the project's Content\/ for now/.test(threw), `a plugin's Content/ is refused for now (${threw.slice(-80)})`);
  check(isContentPath('/Game/props') && isContentPath('/Game') && !isContentPath('/home/me/game/Content/props') && !isContentPath('/Gamer/x') && !isContentPath('C:/game/Content'),
    'a content path starts with /Game; an absolute macOS or Linux path is a folder');
  threw = '';
  try { contentPathOf(p, path.join(p, 'Saved', 'x')); } catch (e: any) { threw = e.message; }
  check(/outside the Unreal project's Content/.test(threw), 'a folder outside Content/ is refused');
  check(normalContentPath('/Game//props/./a/../b/') === '/Game/props/b', 'a content path is normalised');
  threw = '';
  try { normalContentPath('/Game/my props'); } catch (e: any) { threw = e.message; }
  check(/no Unreal content path/.test(threw), 'a folder name Unreal refuses is refused');
  check(assetName('a.b c') === 'a_b_c', 'an asset name loses what Unreal refuses');
}

// ---------------------------------------------------------------------------------------------------------- setup
section('unreal setup');
{
  const game = project('setupgame', false);
  const s = await unreal(['setup', game]);
  const copied = path.join(game, 'Plugins', PLUGIN_NAME);
  check(s.code === 0 && fs.existsSync(path.join(copied, `${PLUGIN_NAME}.uplugin`)), `the plugin is copied into Plugins/ (${s.out.split('\n')[0]})`);
  check(fs.existsSync(path.join(copied, 'Source', 'TopoTopoImportEditor', 'Private', 'TopoTopoImporter.cpp')) && fs.existsSync(path.join(copied, 'README.md')), 'with its source and README');
  check(readJson(path.join(game, 'setupgame.uproject')).Plugins.some((p: any) => p.Name === PLUGIN_NAME && p.Enabled === true), 'it is enabled in the .uproject');
  check(readJson(path.join(game, 'setupgame.uproject')).Plugins.some((p: any) => p.Name === 'PythonScriptPlugin'), "the .uproject's other plugins stay");
  check(readJson(process.env.TOPOTOPO_CONFIG!).install?.cli && readJson(process.env.TOPOTOPO_CONFIG!).install?.node, 'where TopoTopo is goes in the install record');
  const ini = fs.readFileSync(path.join(game, ...REIMPORT_INI.split('/')), 'utf8');
  check(!missingExcludes(game).length && UNREAL_EXCLUDES.every((w) => ini.includes(`(Wildcard="${w}",bInclude=False)`)), 'the ini excludes every TopoTopo folder from Auto Reimport');
  check(ini.includes('!AutoReimportDirectorySettings=ClearArray') && ini.includes('(Wildcard="Localization/*",bInclude=False)'), "the ini replaces the engine's entry and keeps its wildcard");
  const ignore = fs.readFileSync(path.join(game, '.gitignore'), 'utf8');
  check(GITIGNORE_LINES.every((l) => ignore.includes(l)), '.gitignore holds the cook\'s lines');

  // again: nothing changes, and what the build wrote stays
  write(path.join(copied, 'Binaries', 'Win64', 'built.dll'), 'x');
  write(path.join(copied, 'stale.txt'), 'x');
  const before = [fs.readFileSync(path.join(game, 'setupgame.uproject'), 'utf8'), fs.readFileSync(path.join(game, ...REIMPORT_INI.split('/')), 'utf8'), fs.readFileSync(path.join(game, '.gitignore'), 'utf8')];
  const again = await unreal(['setup', path.join(game, 'setupgame.uproject')]);
  check(again.code === 0 && /already/.test(again.out), 'setup takes a .uproject too, and says what was already there');
  const after = [fs.readFileSync(path.join(game, 'setupgame.uproject'), 'utf8'), fs.readFileSync(path.join(game, ...REIMPORT_INI.split('/')), 'utf8'), fs.readFileSync(path.join(game, '.gitignore'), 'utf8')];
  check(before.every((t, i) => t === after[i]), 'a second setup changes nothing');
  check(fs.existsSync(path.join(copied, 'Binaries', 'Win64', 'built.dll')) && !fs.existsSync(path.join(copied, 'stale.txt')), 'what the build wrote stays, and what an old plugin had goes');

  const off = project('noenable', false);
  const n = await unreal(['setup', off, '--no-enable']);
  check(n.code === 0 && !readJson(path.join(off, 'noenable.uproject')).Plugins.some((p: any) => p.Name === PLUGIN_NAME), '--no-enable leaves the .uproject');
  const pcg = project('withpcg', false);
  const w = await unreal(['setup', pcg, '--with-pcg']);
  const pcgPlugin = readJson(path.join(pcg, 'withpcg.uproject')).Plugins.find((p: any) => p.Name === 'TopoTopoPCG');
  check(w.code === 0 && fs.existsSync(path.join(pcg, 'Plugins', 'TopoTopoPCG', 'TopoTopoPCG.uplugin')) && pcgPlugin?.Enabled === true, '--with-pcg installs TopoTopoPCG too');
  const pcgDescriptor = readJson(path.join(pcg, 'Plugins', 'TopoTopoPCG', 'TopoTopoPCG.uplugin'));
  check(JSON.stringify(pcgPlugin?.SupportedTargetPlatforms) === JSON.stringify(pcgDescriptor.SupportedTargetPlatforms) && pcgDescriptor.SupportedTargetPlatforms?.length > 0,
    `its entry names the descriptor's platforms, so 5.8 does not warn (${pcgPlugin?.SupportedTargetPlatforms})`);
  const bare = '{"Plugins":[{"Name":"TopoTopoPCG","Enabled":true}]}';
  check(JSON.parse(enableInUproject(bare, 'TopoTopoPCG', ['Win64'])!).Plugins[0].SupportedTargetPlatforms?.join() === 'Win64' && enableInUproject(enableInUproject(bare, 'TopoTopoPCG', ['Win64'])!, 'TopoTopoPCG', ['Win64']) === null,
    'an enabled entry without the platforms gains them, once');

  const notAProject = path.join(tmp, 'nothing');
  fs.mkdirSync(notAProject);
  const e = await unreal(['setup', notAProject]);
  check(e.code === 2 && /no Unreal project folder/.test(e.err), `a folder without a .uproject exits 2 (${e.err})`);
  check((await unreal(['setup'])).code === 2 && (await unreal(['nope'])).code === 2, 'usage errors exit 2');

  let threw = '';
  try { enableInUproject('not json', PLUGIN_NAME); } catch (x: any) { threw = x.message; }
  check(/no JSON/.test(threw), 'a broken .uproject is said, not overwritten');
  check(enableInUproject('{"Plugins":[{"Name":"TopoTopoImport","Enabled":true}]}', PLUGIN_NAME) === null, 'an enabled plugin stays as it is');

  // an ini that already has an entry of its own keeps it
  const own = '[/Script/UnrealEd.EditorLoadingSavingSettings]\n+AutoReimportDirectorySettings=(SourceDirectory="/Game/",MountPoint="",Wildcards=((Wildcard="Mine/*",bInclude=False)))\n';
  const merged = withExcludes(own)!;
  check(merged.includes('Wildcard="Mine/*"') && UNREAL_EXCLUDES.every((x) => merged.includes(`Wildcard="${x}"`)) && !merged.includes('ClearArray'), 'a /Game/ entry of the project keeps its wildcards and gains the exclusions');
  check(withExcludes(merged) === null, 'and is left alone next time');
}

// ----------------------------------------------------------------------------------------------------------- plan
section('the plan: what each kind becomes');
{
  const options = { folder: '/Game/p/outputs', instancing: 'packed' as const, per_output_folders: true, skip: [] };
  const at = 'Saved/TopoTopo/Game/p/outputs';
  const mesh = unrealPlan({ id: 'crate', kind: 'mesh', files: [`${at}/crate/crate.glb`, `${at}/crate/crate_lod2.glb`, `${at}/crate/crate_lod1.glb`, `${at}/crate/crate.sockets.json`] }, options);
  check(mesh.length === 1 && mesh[0].as === 'static_mesh' && mesh[0].folder === '/Game/p/outputs/crate' && mesh[0].name === 'crate', 'a mesh is one static mesh in its folder');
  check(mesh[0].lods?.join() === `${at}/crate/crate_lod1.glb,${at}/crate/crate_lod2.glb` && mesh[0].sockets === `${at}/crate/crate.sockets.json`, 'its LODs in order, and its sockets');
  const inst = unrealPlan({ id: 'scatter', kind: 'instances', files: [`${at}/scatter/scatter.instances.csv`, `${at}/scatter/scatter.instances.meshes.json`, `${at}/scatter/scatter_meshes/a.glb`, `${at}/scatter/scatter_meshes/b.glb`] }, options);
  check(inst.map((s) => s.as).join() === 'static_mesh,static_mesh,instances,points', 'instances: the meshes first, then the instances and the points');
  check(inst[0].folder === '/Game/p/outputs/scatter/Meshes' && inst[2].name === 'scatter_Instances' && inst[3].name === 'scatter_Points' && inst[2].meshes?.a === '/Game/p/outputs/scatter/Meshes/a.a', 'with the assets its rows name');
  const flat = unrealPlan({ id: 'scatter', kind: 'instances', files: [`${at}/scatter.instances.csv`, `${at}/scatter_meshes/a.glb`] }, { ...options, per_output_folders: false });
  check(flat[0].folder === '/Game/p/outputs/scatter_Meshes', 'flat: its meshes keep a folder of their own');
  const points = unrealPlan({ id: 'pts', kind: 'points', files: [`${at}/pts/pts.points.csv`] }, options);
  check(points.length === 1 && points[0].as === 'points' && points[0].name === 'pts_Points', 'points are a PCG asset');
  const tex = unrealPlan({ id: 'panels', kind: 'textures', files: [`${at}/panels/a.png`, `${at}/panels/b c.png`] }, options);
  check(tex.map((s) => `${s.as}:${s.name}`).join() === 'texture:a,texture:b_c', 'textures are one asset per image');
  const land = unrealPlan({ id: 'isle', kind: 'terrain', files: [`${at}/isle/landscape.json`, `${at}/isle/heightmap.png`] }, options);
  check(land.length === 1 && land[0].as === 'landscape' && land[0].file === `${at}/isle/landscape.json`, 'terrain is its bundle');
}

// ----------------------------------------------------------------------------------------------------------- cook
section('the cook');
{
  const game = project('lampgame', false);
  const lamps = pkg(game, 'props', {
    source: { type: 'box' },
    pts: { type: 'points', params: { positions: [[0, 0, 0]] } },
    lamps: { type: 'copy_to_points', in: ['source', 'pts'], params: { pack: true } },
  }, { placed: { node: 'lamps', kind: 'instances' } });
  const report = path.join(tmp, 'lamps.json');
  const result = await cook([lamps, '--for', 'unreal', '--report', report]);
  const output = readJson(report).outputs.find((o: any) => o.id === 'placed');
  const mesh = output?.import.find((s: any) => s.as === 'static_mesh');
  const instances = output?.import.find((s: any) => s.as === 'instances');
  check(result.code === 0 && mesh?.name === 'lamps' && mesh.file.endsWith('/lamps.glb') &&
    instances?.meshes?.lamps === '/Game/props/outputs/placed/Meshes/lamps.lamps',
  `Unreal cook uses the copy node name in its mesh file and import plan (${mesh?.name})`);
}
{
  const game = project('game');
  const dir = path.join(game, 'Content', 'props');
  const report = path.join(tmp, 'report.json');
  const c = await cook([dir, '--for', 'unreal', '--report', report]);
  check(c.code === 0, `the fixture cooks (${c.out.split('\n')[0]})`);
  const rep = readJson(report);
  const out = (id: string) => rep.outputs.find((o: any) => o.id === id);
  const below = 'Saved/TopoTopo/Game/props/outputs';
  check(rep.protocol === COOK_PROTOCOL && rep.ok === true, `the report speaks protocol ${COOK_PROTOCOL}`);
  check(!fs.existsSync(path.join(dir, 'outputs')) && fs.existsSync(path.join(game, ...below.split('/'), 'crate', 'crate.glb')), 'cooked files go below Saved/, nothing beside the package');
  check(fs.readFileSync(path.join(game, ...below.split('/'), 'crate', 'crate.glb')).subarray(0, 4).toString() === 'glTF', 'a mesh is a GLB');
  check(out('crate').import[0].as === 'static_mesh' && out('crate').import[0].lods?.length === 1 && !!out('crate').import[0].sockets, `the crate has a LOD and sockets (${out('crate').files.length} files)`);
  const nodeNames = (f: string) => { const b = fs.readFileSync(path.join(game, ...below.split('/'), 'crate', f)); return JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString('utf8')).nodes.map((n: any) => n.name); };
  check([...nodeNames('crate.glb'), ...nodeNames('crate_lod1.glb')].every((n: string) => !/_lod\d+$/i.test(n)), `each level's names drop _lod<n>, so Interchange does not take them for LOD names (${nodeNames('crate_lod1.glb')})`);
  check(out('scatter').kind === 'instances' && out('scatter').import.map((s: any) => s.as).join() === 'static_mesh,static_mesh,static_mesh,instances,points', 'scatter has its meshes, instances and points');
  check(out('panels').import[0].as === 'texture' && out('island').import[0].as === 'landscape', 'panels are textures and island a landscape');
  check((out('island').warnings ?? []).some((w: string) => /does not fit Unreal's landscape grid/.test(w)), 'a terrain off the landscape grid warns that it will not be placed');
  const rec = readJson(path.join(dir, '.topotopo', 'unreal.json'));
  check(rec.schema === RECORD_SCHEMA && rec.for === 'unreal' && rec.options.folder === '/Game/props/outputs', 'the record is for Unreal, with the content path');
  check(Object.keys(rec.outputs.crate.files).every((f) => f.startsWith(`${below}/crate/`)) && !JSON.stringify(rec).includes(posix(tmp)), 'it names files below the project, no machine paths');

  // axes: Unreal X = x, Y = z, Z = y, in centimetres
  const csv = fs.readFileSync(path.join(game, ...below.split('/'), 'scatter', 'scatter.instances.csv'), 'utf8').trim().split(/\r?\n/);
  check(csv[0].startsWith('Name,Position.X,Position.Y,Position.Z,Rotation.Roll,Rotation.Pitch,Rotation.Yaw,Scale.X,Scale.Y,Scale.Z,Density,Color.R') && csv[0].includes(',Mesh'), 'the rows have the PCG columns');
  const row = csv[2].split(',');
  check(Number(row[1]) === 100 && Number(row[2]) === 0 && Number(row[3]) === 0, `a point at x = 1 m is X = 100 cm (${row.slice(1, 4).join(' ')})`);
  const sockets = readJson(path.join(game, ...below.split('/'), 'crate', 'crate.sockets.json'));
  check(sockets.format === 'topotopo-sockets' && sockets.version === 1 && sockets.sockets.length > 0 && Array.isArray(sockets.sockets[0].location) && typeof sockets.sockets[0].rotation.yaw === 'number', `the sockets file (${sockets.sockets.map((s: any) => s.name).join()})`);
  const handle = sockets.sockets[0];
  check(/centimetres/.test(sockets.units) && handle.location.join() === '0,0,25', `the handle at y = 0.25 m is Z = 25 cm (${handle.name} at ${handle.location.join(' ')})`);
  // off every axis: a point and a socket at x = 1, y = 2, z = 3 m are X = 100, Y = 300, Z = 200 cm
  const axesGame = project('axesgame', false);
  const axes = pkg(axesGame, 'axes', {
    spots: { type: 'add', params: { points: [[1, 2, 3]] } },
    body: { type: 'box', params: { size: [0.2, 0.2, 0.2] } },
    tip: { type: 'scene_null', in: ['body'], params: { name: 'tip', translation: [1, 2, 3] } },
  }, { spots: { node: 'spots', kind: 'points' }, tip: { node: 'tip', kind: 'mesh' } });
  check((await cook([axes, '--for', 'unreal'])).code === 0, 'a package of a point and a socket off the axes cooks');
  const axesAt = path.join(axesGame, 'Saved', 'TopoTopo', 'Game', 'axes', 'outputs');
  const pt = fs.readFileSync(path.join(axesAt, 'spots', 'spots.points.csv'), 'utf8').trim().split(/\r?\n/)[1].split(',');
  check(pt.slice(1, 4).map(Number).join() === '100,300,200', `a point at (1, 2, 3) m is X Y Z = 100 300 200 cm (${pt.slice(1, 4).join(' ')})`);
  const tip = readJson(path.join(axesAt, 'tip', 'tip.sockets.json')).sockets[0];
  check(tip.location.join() === '100,300,200', `a socket at (1, 2, 3) m is at 100 300 200 cm (${tip.location.join(' ')})`);

  // incremental
  const unchanged = await cook([dir, '--for', 'unreal', '--report', report]);
  check(unchanged.code === 0 && readJson(report).outputs.every((o: any) => o.state === 'unchanged'), 'a second cook changes nothing');
  const graph = path.join(dir, 'graphs', 'crate.json');
  const original = fs.readFileSync(graph, 'utf8');
  const edited = readJson(graph);
  const first = Object.keys(edited.nodes).find((n) => edited.nodes[n].type === 'box') ?? Object.keys(edited.nodes)[0];
  edited.nodes[first].params = { ...(edited.nodes[first].params ?? {}), size: [3, 3, 3] };
  write(graph, JSON.stringify(edited, null, 2));
  const again = await cook([dir, '--for', 'unreal', '--report', report]);
  const states = Object.fromEntries(readJson(report).outputs.map((o: any) => [o.id, o.state]));
  check(again.code === 0 && states.crate !== 'unchanged', `an edited graph cooks its output again (crate: ${states.crate})`);
  check(states.scatter === 'unchanged' && states.panels === 'unchanged', 'and not the others');

  // a failed output keeps its last good files, and its import
  const good = fs.readFileSync(path.join(game, ...below.split('/'), 'crate', 'crate.glb'));
  write(graph, JSON.stringify({ ...edited, nodes: { ...edited.nodes, [first]: { ...edited.nodes[first], type: 'no_such_node' } } }, null, 2));
  const broken = await cook([dir, '--for', 'unreal', '--report', report]);
  const failed = readJson(report).outputs.find((o: any) => o.id === 'crate');
  check(broken.code === 1 && failed.state === 'failed' && failed.errors.length > 0, `a broken graph fails its output, exit 1 (${failed.errors[0]?.message?.slice(0, 60)})`);
  check(fs.readFileSync(path.join(game, ...below.split('/'), 'crate', 'crate.glb')).equals(good), 'its last good file stays');
  check(failed.import?.[0]?.as === 'static_mesh' && failed.import[0].file === `${below}/crate/crate.glb` && failed.import[0].lods?.length === 1,
    `and its import names that file, so the plugin keeps its asset (${failed.import?.map((s: any) => s.as).join()})`);
  const stale = unrealStatus(game);
  check(!stale.ok && stale.packages[0].outputs.some((o) => o.id === 'crate' && o.state === 'failed'), 'status says it failed');
  write(graph, original);
  await cook([dir, '--for', 'unreal']);

  // no cooked files: a checkout is still current
  const status = unrealStatus(game);
  check(status.packages.length === 1 && status.packages[0].state === 'ok' && status.packages[0].content === '/Game/props', 'status reads the package as current');
  fs.rmSync(path.join(game, 'Saved'), { recursive: true });
  check(unrealStatus(game).packages[0].state === 'ok', 'without Saved/TopoTopo/ it is still current (a checkout)');
  // exposed until setup
  check(unrealStatus(game).packages[0].exposed.includes('graphs/') && !unrealStatus(game).ok, "before setup, status says Auto Reimport sees the package's folders");
  const strict = await unreal(['status', game, '--strict']);
  check(strict.code === 1 && /exposed/.test(strict.out), '--strict exits 1 for it');
  await unreal(['setup', game]);
  const fine = await unreal(['status', game, '--strict']);
  check(fine.code === 0 && /every package is current/.test(fine.out), `after setup, --strict exits 0 (${fine.out.split('\n').at(-1)})`);
  check(readJson(path.join(tmp, 'report.json')).protocol === COOK_PROTOCOL && JSON.parse((await unreal(['status', game, '--json'])).out).plugin === true, '--json reports the plugin');

  // options and flags
  write(path.join(dir, 'props.topo.import'), '[params]\n\noutputs/folder="/Game/Elsewhere"\noutputs/per_output_folders=false\noutputs/skip="island, panels"\ninstances/mode=1\n');
  const opts = await cook([dir, '--for', 'unreal', '--report', report]);
  const r2 = readJson(report);
  check(opts.code === 0 && r2.outputs.find((o: any) => o.id === 'crate').import[0].folder === '/Game/Elsewhere', 'the import file sets the folder');
  check(r2.outputs.find((o: any) => o.id === 'island').state === 'skipped' && !r2.outputs.find((o: any) => o.id === 'island').import, 'and what is skipped');
  check(r2.outputs.find((o: any) => o.id === 'scatter').import.map((s: any) => s.as).join() === 'static_mesh', 'instances/mode 1 expands them into one mesh');
  const flag = await cook([dir, '--for', 'unreal', '--into', '/Game/Flagged', '--report', report]);
  check(flag.code === 0 && readJson(report).outputs.find((o: any) => o.id === 'crate').import[0].folder === '/Game/Flagged', '--into overrides it');
  fs.rmSync(path.join(dir, 'props.topo.import'));

  // refusals
  const outside = project('outside', false);
  copyDir(FIXTURE, path.join(outside, 'NotContent', 'props'));
  const o = await cook([path.join(outside, 'NotContent', 'props'), '--for', 'unreal']);
  check(o.code === 2 && /outside the Unreal project's Content/.test(o.text), `a package outside Content/ exits 2 (${o.text.slice(-70)})`);
  const rootGame = project('rootgame', false);
  copyDir(FIXTURE, path.join(rootGame, 'Content'));
  const root = await cook([path.join(rootGame, 'Content'), '--for', 'unreal']);
  check(root.code === 2 && /directly in Content/.test(root.text), 'a package directly in Content/ exits 2');
  const none = path.join(tmp, 'noproject');
  copyDir(FIXTURE, none);
  const noP = await cook([none, '--for', 'unreal']);
  check(noP.code === 2 && /is in no Unreal project/.test(noP.text), `a package in no project exits 2 (${noP.text.slice(-70)})`);
  const kit = project('kitgame', false);
  write(path.join(kit, 'Plugins', 'Kit', 'Kit.uplugin'), '{"FileVersion": 3}');
  copyDir(FIXTURE, path.join(kit, 'Plugins', 'Kit', 'Content', 'props'));
  const inKit = await cook([path.join(kit, 'Plugins', 'Kit', 'Content', 'props'), '--for', 'unreal']);
  check(inKit.code === 2 && /in the plugin Kit: TopoTopo packages and their assets belong under the project's Content\//.test(inKit.text), `a package in a plugin's Content/ exits 2 (${inKit.text.slice(-90)})`);
  const kitStatus = unrealStatus(kit);
  check(!kitStatus.ok && kitStatus.inPlugins.length === 1 && kitStatus.inPlugins[0].topo === 'Plugins/Kit/Content/props/props.topo', 'status lists it as unsupported');
  const posixInto = await cook([dir, '--for', 'unreal', '--into', '/srv/game/Content/props', '--report', report]);
  check(posixInto.code === 2 && /outside the Unreal project's Content/.test(posixInto.text), `an absolute macOS or Linux --into is a folder, not a content path (${posixInto.text.slice(-60)})`);
  // --into: a content path (above), or a folder on disk under Content/; a relative folder is the working directory's
  const abs = await cook([dir, '--for', 'unreal', '--into', path.join(game, 'Content', 'Baked'), '--report', report]);
  check(abs.code === 0 && readJson(report).outputs.find((o: any) => o.id === 'crate').import[0].folder === '/Game/Baked/crate', '--into takes a folder under Content/ as its content path');
  const recordBefore = fs.readFileSync(path.join(dir, '.topotopo', 'unreal.json'), 'utf8');
  const u = await cook([dir, '--for', 'unreal', '--into', 'relative/folder']);
  check(u.code === 2 && /outside the Unreal project's Content/.test(u.text) && fs.readFileSync(path.join(dir, '.topotopo', 'unreal.json'), 'utf8') === recordBefore,
    `a relative --into outside Content/ exits 2 and writes nothing (${u.text.split('\n')[0].slice(-60)})`);

  // the jobs file
  const jobs = path.join(tmp, 'jobs.json');
  write(jobs, JSON.stringify({ for: 'unreal', protocol: COOK_PROTOCOL, jobs: [{ package: path.join(dir, 'props.topo'), report, timeout: 600 }] }));
  const j = await cook(['--jobs', jobs, '--progress', 'json', '--quiet']);
  const events = j.out.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
  check(j.code === 0 && events[0].event === 'start' && events.at(-1).event === 'done' && events.at(-1).ok === true, `the plugin's form works, with progress lines (${events.length})`);
  write(jobs, JSON.stringify({ for: 'unreal', protocol: COOK_PROTOCOL + 1, jobs: [{ package: path.join(dir, 'props.topo') }] }));
  const p = await cook(['--jobs', jobs]);
  check(p.code === 2 && /topotopo unreal setup /.test(p.text) && !/Godot/.test(p.text), `another protocol asks for setup (${p.text.slice(0, 90)})`);
  write(jobs, JSON.stringify({ for: 'other', protocol: COOK_PROTOCOL, jobs: [] }));
  check((await cook(['--jobs', jobs])).code === 2, 'another engine exits 2');

  // two packages with one output folder: the second is refused, naming both; a file no package placed is taken over
  const box = { body: { type: 'box', params: { size: [0.5, 0.5, 0.5] } } };
  const shared = '[params]\n\noutputs/folder="/Game/Shared"\n';
  const one = pkg(game, 'one', box, { thing: { node: 'body', kind: 'mesh' } }, shared);
  const two = pkg(game, 'two', { body: { type: 'box', params: { size: [0.3, 0.3, 0.3] } } }, { thing: { node: 'body', kind: 'mesh' } }, shared);
  const sharedGlb = path.join(game, 'Saved', 'TopoTopo', 'Game', 'Shared', 'thing', 'thing.glb');
  check((await cook([one, '--for', 'unreal'])).code === 0, 'a package cooks into a shared folder');
  const firstGlb = fs.readFileSync(sharedGlb);
  const tr = path.join(tmp, 'two.json');
  const second = await cook([two, '--for', 'unreal', '--report', tr]);
  const refusal = readJson(tr).outputs[0].errors[0]?.message ?? '';
  check(second.code === 1 && /belongs to \/Game\/one\/one, and \/Game\/two\/two would write over it/.test(refusal) && fs.readFileSync(sharedGlb).equals(firstGlb),
    `another package with that folder is refused, naming both, and the file stays (${refusal})`);
  const stray = pkg(game, 'stray', { spots: { type: 'add', params: { points: [[0, 0, 0]] } } }, { pts: { node: 'spots', kind: 'points' } });
  write(path.join(game, 'Saved', 'TopoTopo', 'Game', 'stray', 'outputs', 'pts', 'pts.points.csv'), 'left over\n');
  check((await cook([stray, '--for', 'unreal'])).code === 0 && /^Name,/.test(fs.readFileSync(path.join(game, 'Saved', 'TopoTopo', 'Game', 'stray', 'outputs', 'pts', 'pts.points.csv'), 'utf8')),
    'a file below Saved/TopoTopo/ that no package placed is taken over');
  // flat: a texture named like a mesh would make two assets of one name
  const clash = pkg(game, 'clash', {
    body: { type: 'box', params: { size: [0.5, 0.5, 0.5] } },
    noise: { type: 'tex_noise', params: { resolution: [8, 8], name: 'crate' } },
  }, { crate: { node: 'body', kind: 'mesh' }, look: { node: 'noise', kind: 'textures' } }, '[params]\n\noutputs/per_output_folders=false\n');
  const cr = path.join(tmp, 'clash.json');
  const flat = await cook([clash, '--for', 'unreal', '--report', cr]);
  const clashed = readJson(cr).outputs.find((o: any) => o.state === 'failed');
  check(flat.code === 1 && clashed?.id === 'look' && /"crate" and "look" would both make the asset \/Game\/clash\/outputs\/crate/.test(clashed.errors[0].message),
    `flat: an output whose asset is named like another's fails (${clashed?.errors[0]?.message})`);

  // collision pieces by name: Unreal's UCX_ for TopoTopo's -convcolonly / -colonly
  const hulls = path.join(game, 'Content', 'hulls');
  write(path.join(hulls, 'hulls.topo'), JSON.stringify({ title: 'Hulls', graph: 'hulls', created: '2026-01-01', name: 'studio/hulls' }));
  const named = (node: string, input: string, value: string) => ({ [node]: { type: 'attrib_create', in: [input], params: { name: 'name', class: 'prim', value } } });
  write(path.join(hulls, 'graphs', 'hulls.json'), JSON.stringify({
    nodes: {
      body: { type: 'box', params: { size: [1, 0.5, 0.5] } }, ...named('body_n', 'body', 'body'),
      a: { type: 'box', params: { size: [0.6, 0.6, 0.6], center: [-0.3, 0, 0] } }, ...named('a_n', 'a', 'left-convcolonly'),
      b: { type: 'box', params: { size: [0.6, 0.6, 0.6], center: [0.3, 0, 0] } }, ...named('b_n', 'b', 'right-colonly'),
      all: { type: 'merge', in: ['body_n', 'a_n', 'b_n'] },
    },
    output: 'all', outputs: { hulls: { node: 'all', kind: 'mesh' } },
  }));
  const hr = path.join(tmp, 'hulls.json');
  check((await cook([hulls, '--for', 'unreal', '--report', hr])).code === 0, 'a mesh with collision pieces cooks');
  const hb = fs.readFileSync(path.join(game, 'Saved', 'TopoTopo', 'Game', 'hulls', 'outputs', 'hulls', 'hulls.glb'));
  const hn = JSON.parse(hb.subarray(20, 20 + hb.readUInt32LE(12)).toString('utf8')).nodes.map((n: any) => n.name).sort().join();
  check(hn === 'UCX_body_00,UCX_body_01,body', `-convcolonly and -colonly pieces become UCX_<mesh>_<nn> (${hn})`);
  const hw: string[] = readJson(hr).outputs[0].warnings ?? [];
  check(hw.some((w) => /right-colonly becomes a convex hull/.test(w)) && !hw.some((w) => /left-convcolonly/.test(w)), 'a -colonly piece says it becomes convex');
}

// ---------------------------------------------------------------------------------------------------- the commands
section('the commands: every list of them says them the same way');
{
  const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' }).stdout;
  const lists: [string, string, string][] = [
    ['src/cli.ts (its header)', fs.readFileSync(CLI, 'utf8'), '//   node src/cli.ts '],
    ['--help', help, 'node src/cli.ts '],
    ['README.md', fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8'), 'topotopo '],
    ['help topic "unreal"', topicText('unreal') ?? '', 'topotopo '],
    ['integrations/unreal/PROTOCOL.md', fs.readFileSync(path.join(ROOT, 'integrations', 'unreal', 'PROTOCOL.md'), 'utf8'), 'topotopo '],
  ];
  for (const [where, text, prefix] of lists) {
    const missing = UNREAL_COMMANDS.filter((c) => !text.includes(`${prefix}${c.usage}`)).map((c) => c.usage);
    check(!missing.length, `${where} lists every command as UNREAL_COMMANDS says it${missing.length ? `: missing ${missing.join(' | ')}` : ''}`);
  }
}

// ------------------------------------------------------------------------------------------------------- the plugin
section('the plugin speaks this TopoTopo');
{
  const editor = path.join(PLUGIN_SOURCE, 'Source', 'TopoTopoImportEditor', 'Private');
  const read = (f: string) => fs.readFileSync(path.join(editor, f), 'utf8');
  check(new RegExp(`constexpr int32 Protocol = ${COOK_PROTOCOL};`).test(read('TopoTopoCook.h')), `its protocol is ${COOK_PROTOCOL}`);
  const list = /Excludes\[\] = \{([^}]*)\}/.exec(read('TopoTopoImportEditorModule.cpp'))?.[1] ?? '';
  const excludes = [...list.matchAll(/TEXT\("([^"]*)"\)/g)].map((m) => m[1]);
  check(excludes.join() === UNREAL_EXCLUDES.join(), `it adds the exclusions setup writes (${excludes.length})`);
  const importer = read('TopoTopoImporter.cpp');
  const kinds = [...importer.matchAll(/Step\.As == TEXT\("([a-z_]+)"\)/g)].map((m) => m[1]);
  check(['static_mesh', 'texture', 'instances', 'points', 'landscape'].every((k) => kinds.includes(k)), `it carries out every kind of step (${[...new Set(kinds)].join(', ')})`);
  const uplugin = readJson(path.join(PLUGIN_SOURCE, `${PLUGIN_NAME}.uplugin`));
  check(uplugin.EngineVersion === '5.8.0' && uplugin.Modules.map((m: any) => m.Name).join() === 'TopoTopoImport,TopoTopoImportEditor', 'its descriptor is for 5.8, with both modules');
  check(!('SupportedTargetPlatforms' in uplugin), 'no target platforms, so a .uproject entry of name and Enabled gives no warning');
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const banned = walk(PLUGIN_SOURCE).filter((f) => /\.(py|uasset)$/i.test(f));
  check(!banned.length, 'no Python and no Blueprints in it');
  const pkg = readJson(path.join(ROOT, 'package.json'));
  check(pkg.files.includes('integrations/unreal/TopoTopoImport/**') && pkg.files.includes('integrations/unreal/TopoTopoPCG/**'), 'the npm package carries the plugins');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
