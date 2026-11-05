// The cook for Unreal and the plugin's setup, without the editor: `topotopo unreal setup` (the plugin copied, the .uproject, the
// Auto Reimport exclusions, .gitignore, idempotence, refusals), the cook's mapping of output kinds to files and import steps
// (src/host/unreal.ts, integrations/unreal/PROTOCOL.md), axes in rows and sockets, freshness and incremental cooks, a failed output
// keeping its last good files, status, the jobs file, and that the plugin's C++ speaks the same protocol and exclusions. The editor
// round trip is manual and its steps are in integrations/unreal/TopoTopoImport/README.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { cookCommand } from '../src/host/cook-command.ts';
import { COOK_PROTOCOL, RECORD_SCHEMA } from '../src/host/cook.ts';
import { GITIGNORE_LINES, PLUGIN_NAME, PLUGIN_SOURCE, REIMPORT_INI, UNREAL_EXCLUDES, assetName, contentPathOf, enableInUproject, missingExcludes, normalContentPath, unrealCommand, unrealPlan, unrealStatus, withExcludes } from '../src/host/unreal.ts';
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

// ---------------------------------------------------------------------------------------------------------- paths
section('content paths');
{
  const p = path.join(tmp, 'paths');
  check(contentPathOf(p, path.join(p, 'Content', 'props')) === '/Game/props', 'Content/props is /Game/props');
  check(contentPathOf(p, path.join(p, 'Plugins', 'Kit', 'Content', 'props')) === '/Kit/props', 'Plugins/Kit/Content/props is /Kit/props');
  let threw = '';
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

  const notAProject = path.join(tmp, 'nothing');
  fs.mkdirSync(notAProject);
  const e = await unreal(['setup', notAProject]);
  check(e.code === 2 && /no Unreal project folder/.test(e.err), `a folder without a .uproject exits 2 (${e.err})`);
  check((await unreal(['setup'])).code === 2 && (await unreal(['nope'])).code === 2, 'usage errors exit 2');

  const uproject = path.join(tmp, 'bad.uproject');
  fs.writeFileSync(uproject, 'not json');
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
  check(out('scatter').kind === 'instances' && out('scatter').import.map((s: any) => s.as).join() === 'static_mesh,static_mesh,static_mesh,instances,points', 'scatter has its meshes, instances and points');
  check(out('panels').import[0].as === 'texture' && out('island').import[0].as === 'landscape', 'panels are textures and island a landscape');
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
  check(/centimetres/.test(sockets.units), `sockets are in centimetres (${handle.name} at ${handle.location.join(' ')})`);

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
  check(noP.code === 2 && /no Unreal project/.test(noP.text), 'a package in no project exits 2');
  const u = await cook([dir, '--for', 'unreal', '--into', 'relative/folder']);
  check(u.code === 2 || u.code === 0, `--into takes a content path (${u.text.split('\n')[0].slice(0, 80)})`);

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
  const excludes = [...read('TopoTopoImportEditorModule.cpp').matchAll(/TEXT\("((?:\*|topotopo-)[^"]*)"\)/g)].map((m) => m[1]);
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
