// The Godot addon's headless tests (integrations/godot): the addon in a real Godot editor, headless, never a window.
//   GODOT=<the Godot 4.7 editor> node scripts/test-godot.mjs [--keep]      (npm run test:godot)
// GODOT names the editor binary (on Windows its *_console.exe); without it the tests are skipped and say so.
// --keep leaves the temp folder (projects, logs) for inspection.
//
// Copies integrations/godot/tests/project and the neutral props of the cook tests (test/data/cook/props, plus a small
// kit package) into a temp folder whose path has a space and "é", installs the addon with `topotopo godot setup`, and
// runs Godot with its editor settings and cache, and TopoTopo's config and cook cache, in that temp folder, so the
// user's own are never touched. Godot exits 0 whatever happens, so every run's log is searched for ERROR lines; a step
// names the ones it expects. Steps:
//   0. GDScript unit tests (tests/run_unit.gd): record.gd's hashes and freshness against TopoTopo's golden values,
//      the import options against TopoTopo's reading of the same files, the runner's arguments and discovery.
//   1. --import of a project never cooked: both packages cook in one process before the first scan, every output
//      imports, the .topo imports.
//   2. tests/check_import.gd: each GLB a scene of MeshInstance3D nodes with the sockets where the cook put them,
//      materials using the textures Godot extracted, MultiMeshInstance3D buffers equal to T·R·S of the GLB's instances
//      (rotations and non-uniform scale) with their colours, the textures output as textures, the .topo's status.
//   3. A graph edited, --import again: that output alone is cooked and reimported; the other files and their imports stay.
//   4. A root type and Import As MeshLibrary set on two outputs survive their recooks.
//   5. A broken graph keeps the last good GLB, says which node in the log, fails status --strict and check.gd; fixed,
//      both pass and the .topo imports again.
//   6. Without TopoTopo: a fresh import from the committed files is ok; an edited graph fails the .topo with the
//      "not set up here" message and keeps the GLB; an export names the stale package.
//   7. A published copy in versions/ with .gdignore is never imported; without it, it is refused.
//   8. An export pack (all resources, include *.json, *.txt) carries the outputs and none of TopoTopo's files.
//   9. The same project with a Godot.NET.Sdk .csproj and no build imports cleanly.
//  10. Two fresh projects give byte-identical GLBs and records.
//  11. The window's flow in a headless editor (tests/live/live.gd adds the panel, context menu and inspector): an edit
//      cooks in the background while the editor runs and the GLB is reimported; a broken graph or manifest fails
//      without a cook loop; a deleted output comes back; a no-op recook writes and imports nothing.
//  12. The demo project: `topotopo godot setup` changes none of its files, and its first import gives what its README
//      shows (sockets, LOD pieces, a MultiMesh scatter, a texture set).
//  13. Invalid import options fail that package without script errors or blocking another package's cook; restoring
//      the options makes the package current again.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GODOT = process.env.GODOT;
if (!GODOT) {
  console.log('test:godot skipped: set GODOT to the Godot 4.7 editor (on Windows its *_console.exe) to run the addon\'s headless tests');
  process.exit(0);
}
if (!fs.existsSync(GODOT)) {
  console.error(`test:godot: GODOT names ${GODOT}, which does not exist`);
  process.exit(1);
}
const KEEP = process.argv.includes('--keep');
const CLI = path.join(ROOT, 'src', 'cli.ts');
const ADDON = path.join(ROOT, 'integrations', 'godot', 'addons', 'topotopo');
const TEST_PROJECT = path.join(ROOT, 'integrations', 'godot', 'tests', 'project');
const FIXTURE = path.join(ROOT, 'test', 'data', 'cook', 'props');
const GOLDEN = path.join(ROOT, 'test', 'data', 'cook', 'freshness.json');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'topotopo-godot-'));
const LOGS = path.join(tmp, 'logs');
fs.mkdirSync(LOGS);
const home = path.join(tmp, 'home');
const env = {
  ...process.env,
  // Godot's editor settings and cache (Windows, Linux, macOS), and TopoTopo's config and cook cache
  APPDATA: path.join(home, 'appdata'), LOCALAPPDATA: path.join(home, 'localappdata'),
  XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'), XDG_CACHE_HOME: path.join(home, 'cache'),
  ...(process.platform === 'win32' ? {} : { HOME: home }),
  TOPOTOPO_CLI: CLI, TOPOTOPO_NODE: process.execPath,
  TOPOTOPO_CACHE: path.join(tmp, 'topotopo-cache'), TOPOTOPO_CONFIG: path.join(tmp, 'topotopo-config.json'),
};
delete env.TOPOTOPO_LIBRARIES;
for (const k of ['APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']) fs.mkdirSync(env[k], { recursive: true });

let passes = 0, failures = 0;
const check = (cond, msg) => { if (cond) passes++; else failures++; console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); };
const section = (s) => console.log(`\n== ${s}`);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const md5 = (s) => createHash('md5').update(s).digest('hex');
const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const editJson = (file, f) => { const j = json(file); f(j); write(file, JSON.stringify(j, null, 2) + '\n'); };
const copyDir = (from, to) => {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.isDirectory()) copyDir(path.join(from, e.name), path.join(to, e.name));
    else fs.copyFileSync(path.join(from, e.name), path.join(to, e.name));
  }
};
const filesBelow = (dir) => {
  const out = [];
  const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(path.join(d, e.name), r); else out.push(r); } };
  if (fs.existsSync(dir)) walk(dir, '');
  return out.sort();
};
const abs = (proj, res) => path.join(proj, ...res.replace(/^res:\/\//, '').split('/'));

// ----------------------------------------------------------------------------------------------------- running
let runs = 0;
/**
 * Godot, headless, on a project: its exit code, its log (ANSI colours removed), the ERROR lines no pattern of
 * `expect` names, and those it does.
 */
function godot(proj, args, { expect = [], extraEnv = {}, label = args.find((a) => a.startsWith('--') && a !== '--path') ?? 'run' } = {}) {
  const t0 = Date.now();
  const r = spawnSync(GODOT, ['--headless', '--path', proj, ...args], { env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 600_000, maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  const log = `${r.stdout ?? ''}${r.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '');
  const file = path.join(LOGS, `${String(++runs).padStart(2, '0')}-${label.replace(/[^a-z0-9]+/gi, '_')}.log`);
  fs.writeFileSync(file, log);
  const errors = log.split(/\r?\n/).filter((l) => /\bERROR\b/.test(l));
  const unexpected = errors.filter((l) => !expect.some((re) => re.test(l)));
  const expected = errors.filter((l) => expect.some((re) => re.test(l)));
  console.log(`   godot ${args.join(' ')}: exit ${r.status}${r.error ? ` (${r.error.message})` : ''}, ${((Date.now() - t0) / 1000).toFixed(1)} s, ${errors.length} ERROR line(s) (${path.relative(tmp, file)})`);
  for (const l of unexpected) console.log(`     unexpected: ${l.trim()}`);
  return { code: r.status, log, unexpected, expected, file };
}

/** TopoTopo's command line (this checkout). */
function topotopo(args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { env: { ...env, ...extraEnv }, encoding: 'utf8', windowsHide: true });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** The import of a file: its .import fields ([remap] path, dest_files, valid, importer, [params]). */
function importOf(file) {
  const f = `${file}.import`;
  if (!fs.existsSync(f)) return null;
  const text = fs.readFileSync(f, 'utf8');
  const field = (k) => new RegExp(`^${k}=(.*)$`, 'm').exec(text)?.[1];
  const dest = /^dest_files=\[(.*)\]$/m.exec(text)?.[1]?.split(',').map((s) => s.trim().replace(/^"|"$/g, '')) ?? [];
  return { text, importer: field('importer')?.replace(/"/g, ''), valid: field('valid') !== 'false', dest, path: field('path')?.replace(/"/g, '') ?? dest[0] };
}
const mtime = (f) => fs.statSync(f, { throwIfNoEntry: false })?.mtimeMs ?? -1;

/** The record of a package and its output files (res:// → sha256 the record says). */
const record = (pkg) => json(path.join(pkg, '.topotopo', 'godot.json'));
const outputFiles = (rec) => Object.fromEntries(Object.values(rec.outputs).flatMap((o) => Object.entries(o.files)));

/** A GLB's JSON and its float accessors. */
function glb(file) {
  const b = fs.readFileSync(file);
  const jl = b.readUInt32LE(12);
  const j = JSON.parse(b.subarray(20, 20 + jl).toString('utf8'));
  const bin = b.subarray(20 + jl + 8);
  const acc = (i) => {
    const a = j.accessors[i], bv = j.bufferViews[a.bufferView];
    const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
    const off = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0), stride = bv.byteStride ?? n * 4;
    const f = [];
    for (let k = 0; k < a.count; k++) for (let c = 0; c < n; c++) f.push(bin.readFloatLE(off + k * stride + c * 4));
    return { n, count: a.count, f };
  };
  return { j, acc };
}

/** T·R·S as a MultiMesh row: the basis R·diag(s) by rows, the translation last in each row. */
function trsRow(t, q, s) {
  const [x, y, z, w] = q;
  const R = [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
  const M = R.map((row) => row.map((v, c) => v * s[c]));
  return [M[0][0], M[0][1], M[0][2], t[0], M[1][0], M[1][1], M[1][2], t[1], M[2][0], M[2][1], M[2][2], t[2]];
}
const maxDiff = (a, b) => (a.length !== b.length ? Infinity : a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0));

/** Load files in Godot (tests/check_import.gd) and read what they hold. */
function inspect(proj, files, label = 'check_import') {
  const out = path.join(tmp, `${label}-${runs + 1}.json`);
  const r = godot(proj, ['--script', 'res://tests/check_import.gd', '--', out, ...files], { label });
  return { r, data: fs.existsSync(out) ? json(out) : {} };
}

// --------------------------------------------------------------------------------------------------- the project
const KIT_GRAPH = { description: 'One box.', nodes: { box: { type: 'box', params: { size: [0.5, 0.5, 0.5] } } }, output: 'box' };

/** A test project: the test project, the props (instances rotated too) and a kit package, set up with topotopo godot setup. */
function makeProject(name) {
  const proj = path.join(tmp, name);
  copyDir(TEST_PROJECT, proj);
  const props = path.join(proj, 'assets', 'props');
  copyDir(FIXTURE, props);
  // rotations as well as non-uniform scale, so the instance transforms are T·R·S in full
  editJson(path.join(props, 'graphs', 'yard.json'), (g) => { g.nodes.dress.params.code += ' p@orient = quaternion(radians(@ptnum * 35), normalize(set(0.3, 1, 0.2)));'; });
  write(path.join(props, 'notes.txt'), 'Notes beside the package: never shipped.\n');
  const kit = path.join(proj, 'assets', 'kit');
  write(path.join(kit, 'kit.topo'), JSON.stringify({ title: 'Kit', graph: 'kit' }, null, 2) + '\n');
  write(path.join(kit, 'graphs', 'kit.json'), JSON.stringify(KIT_GRAPH, null, 2) + '\n');
  const s = topotopo(['godot', 'setup', proj]);
  return { proj, props, kit, setup: s };
}

console.log(`test:godot: ${GODOT}\n           TopoTopo ${VERSION} at ${CLI}\n           in ${tmp}`);

// ------------------------------------------------------------------------------------------------------- setup
section('setup: topotopo godot setup installs the addon into a project whose path has a space and "é"');
const A = makeProject('game é');
{
  check(A.setup.code === 0, `setup exits 0\n${A.setup.out.trim().split('\n').map((l) => `     ${l}`).join('\n')}`);
  const copied = filesBelow(path.join(A.proj, 'addons', 'topotopo'));
  check(copied.join() === filesBelow(ADDON).join(), `the addon is copied whole (${copied.length} files)`);
  check(['graphs', 'inputs'].every((d) => fs.existsSync(path.join(A.props, d, '.gdignore'))) && fs.existsSync(path.join(A.kit, 'graphs', '.gdignore')), 'the packages\' TopoTopo folders are hidden from Godot (.gdignore)');
  check(/exclude_filter="addons\/topotopo\/\*"/.test(fs.readFileSync(path.join(A.proj, 'export_presets.cfg'), 'utf8')), 'the export preset excludes the addon');
  const cfg = json(env.TOPOTOPO_CONFIG);
  check(cfg.install?.cli === CLI && cfg.install?.node === process.execPath, `the install record names this TopoTopo and node (${env.TOPOTOPO_CONFIG})`);
}

// --------------------------------------------------------------------------------------------- 0. unit tests
section('0. GDScript unit tests: record.gd against TopoTopo\'s golden values, the import options, the runner');
{
  const { godotOptions } = await import('../src/host/godot.ts');
  const scratch = path.join(tmp, 'unit é & co');
  const project = path.join(scratch, 'proj');
  write(path.join(project, 'project.godot'), 'config_version=5\n');
  const cases = [
    ['defaults (no import file)', null],
    ['a folder relative to the package', '[params]\n\noutputs/folder="../shared/out"\n'],
    ['a res:// folder with dots and slashes', '[params]\n\noutputs/folder="res://assets/./x/../outs/"\noutputs/per_output_folders=false\n'],
    ['skip and expand', '[remap]\n\nimporter="topotopo.package"\n\n[params]\n\noutputs/folder="outputs"\noutputs/per_output_folders=true\noutputs/skip=" b, a ,a,"\ninstances/mode=1\n'],
    ['the project folder itself', '[params]\n\noutputs/folder="res://"\n'],
    ['a folder outside the project', '[params]\n\noutputs/folder="../../../../elsewhere"\n'],
  ];
  const options = cases.map(([name, text], i) => {
    const dir = path.join(project, 'assets', `p${i}`), topo = path.join(dir, `p${i}.topo`);
    write(topo, '{"title": "P"}\n');
    if (text) write(`${topo}.import`, text);
    let expect;
    try { expect = godotOptions(topo, project); } catch (e) { expect = { error: e.message }; }
    return { name, topo: topo.split(path.sep).join('/'), res: `res://assets/p${i}/p${i}.topo`, project: project.split(path.sep).join('/'), expect };
  });
  const echo = path.join(scratch, 'echo argv.mjs');
  write(echo, 'process.stdout.write(JSON.stringify(process.argv.slice(2)).replace(/[\\u007f-\\uffff]/g, (c) => "\\\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")) + "\\n");\n');
  const unit = {
    golden: GOLDEN, scratch: path.join(scratch, 'files').split(path.sep).join('/'), options, node: process.execPath, echo,
    args: [path.join(scratch, 'a b & c é'), 'C:\\x y\\back\\slash\\', 'plain', `${scratch}${path.sep}`], cli: CLI.split(path.sep).join('/'),
    version: VERSION, project: A.proj.split(path.sep).join('/'),
  };
  const unitFile = path.join(tmp, 'unit.json');
  write(unitFile, JSON.stringify(unit, null, 1));
  const r = godot(A.proj, ['--script', 'res://tests/run_unit.gd', '--', unitFile], { label: 'run_unit' });
  const lines = r.log.split(/\r?\n/).filter((l) => /^(PASS|FAIL) /.test(l));
  for (const l of lines.filter((x) => x.startsWith('FAIL'))) console.log(`     ${l}`);
  const passed = lines.filter((l) => l.startsWith('PASS')).length, failed = lines.length - passed;
  check(r.code === 0 && failed === 0 && passed >= 40 && !r.unexpected.length, `run_unit.gd: ${passed} passed, ${failed} failed (golden contentSha and freshness cases, options, argv)`);
}

// ----------------------------------------------------------------------------------------- 1. the first import
section('1. --import of a project never cooked');
let firstCook = {};
const OUTPUTS = ['crate/crate.glb', 'panels/panel_noise.png', 'props/props.glb', 'scatter/scatter.glb'].map((f) => `res://assets/props/outputs/${f}`);
const KIT_GLB = 'res://assets/kit/outputs/kit/kit.glb';
{
  const r = godot(A.proj, ['--import'], { label: 'import-first' });
  check(r.code === 0 && !r.unexpected.length, 'no ERROR in the log');
  check(/TopoTopo: cooking 2 stale packages before the first scan: res:\/\/assets\/kit\/kit\.topo, res:\/\/assets\/props\/props\.topo/.test(r.log), 'both packages cook in one process before the first scan');
  check(/TopoTopo: props > island: not imported: terrain outputs are not imported into Godot yet/.test(r.log), 'the skipped terrain output is said once');
  const rec = record(A.props);
  check(Object.keys(outputFiles(rec)).sort().join() === OUTPUTS.join(), `the record lists the outputs: ${Object.keys(outputFiles(rec)).join(', ')}`);
  const all = [...OUTPUTS, KIT_GLB];
  const missing = all.filter((f) => !importOf(abs(A.proj, f)) || !fs.existsSync(abs(A.proj, importOf(abs(A.proj, f)).path)));
  check(!missing.length, `every output has its .import and its imported file${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);
  for (const t of ['assets/props/props.topo', 'assets/kit/kit.topo']) {
    const imp = importOf(path.join(A.proj, ...t.split('/')));
    check(imp?.importer === 'topotopo.package' && imp.valid && fs.existsSync(abs(A.proj, imp.path)), `${t} imports (topotopo.package, valid)`);
  }
  const extracted = importOf(path.join(A.props, 'outputs', 'crate', 'crate_decal.png'));
  check(extracted?.importer === 'texture', 'Godot extracts the crate\'s embedded texture beside its GLB (crate_decal.png)');
  const reports = filesBelow(path.join(A.proj, '.godot', 'topotopo')).filter((f) => f.endsWith('.report.json'));
  check(reports.length === 2 && reports.every((f) => json(path.join(A.proj, '.godot', 'topotopo', f)).protocol === 1), `a report per package in .godot/topotopo (${reports.join(', ')})`);
  const changed = filesBelow(ADDON).filter((f) => !fs.readFileSync(path.join(ADDON, f)).equals(fs.readFileSync(path.join(A.proj, 'addons', 'topotopo', f))));
  check(!changed.length, `Godot changed no file of the addon${changed.length ? ` (${changed.join(', ')})` : ''}`);
  firstCook = Object.fromEntries([...all, 'res://assets/props/.topotopo/godot.json', 'res://assets/kit/.topotopo/godot.json'].map((f) => [f, sha(fs.readFileSync(abs(A.proj, f)))]));
}

// --------------------------------------------------------------------------------------- 2. what was imported
section('2. what Godot made of the outputs (tests/check_import.gd)');
{
  const { r, data } = inspect(A.proj, [...OUTPUTS, KIT_GLB, 'res://assets/props/props.topo', 'res://assets/kit/kit.topo']);
  check(r.code === 0 && !r.unexpected.length, 'check_import.gd runs without errors');
  // every GLB: a scene of MeshInstance3D nodes, no importer nodes left
  for (const f of [...OUTPUTS.filter((x) => x.endsWith('.glb')), KIT_GLB]) {
    const d = data[f] ?? {};
    const classes = (d.nodes ?? []).map((n) => n.class);
    check(d.class === 'PackedScene' && !classes.some((c) => /Importer/.test(c)) && classes.some((c) => c === 'MeshInstance3D' || c === 'MultiMeshInstance3D'), `${f}: a PackedScene of ${[...new Set(classes)].join(', ')}`);
  }
  // the crate: its socket where the cook put it, its materials on the extracted texture
  const crateFile = abs(A.proj, OUTPUTS[0]);
  const { j: cj } = glb(crateFile);
  const handle = cj.nodes.find((n) => n.name === 'handle');
  const crate = data[OUTPUTS[0]]?.nodes ?? [];
  const socket = crate.find((n) => n.name === 'handle');
  const want = trsRow(handle?.translation ?? [0, 0, 0], handle?.rotation ?? [0, 0, 0, 1], handle?.scale ?? [1, 1, 1]);
  check(socket?.class === 'Node3D' && maxDiff(socket.transform, want) < 1e-5, `crate: the socket "handle" is a Node3D at its transform (${socket?.transform?.map((v) => +v.toFixed(3)).join(' ')})`);
  check(crate.filter((n) => n.class === 'MeshInstance3D').map((n) => n.name).sort().join() === 'crate_lod0,crate_lod1', `crate: the LOD pieces are sibling meshes (${crate.filter((n) => n.class === 'MeshInstance3D').map((n) => n.name).join(', ')})`);
  const tex = crate.flatMap((n) => n.materials ?? []).map((m) => m.albedo_texture);
  check(tex.length > 0 && tex.every((t) => t === 'res://assets/props/outputs/crate/crate_decal.png'), `crate: the materials use the extracted texture (${[...new Set(tex)].join(', ')})`);
  // the scatter: one MultiMeshInstance3D per source, buffers equal to T·R·S (rotations, non-uniform scale) and colours
  const { j: sj, acc } = glb(abs(A.proj, OUTPUTS[3]));
  const scatter = data[OUTPUTS[3]]?.nodes ?? [];
  const sources = sj.nodes.filter((n) => n.extensions?.EXT_mesh_gpu_instancing);
  check(sources.length === 3, `scatter.glb: three packed sources (${sources.map((n) => n.name).join(', ')})`);
  let worst = 0, counted = 0, coloured = true, overrides = true, nonUniform = false, rotated = false;
  for (const n of sources) {
    const at = n.extensions.EXT_mesh_gpu_instancing.attributes;
    const T = acc(at.TRANSLATION).f, Q = acc(at.ROTATION).f, S = acc(at.SCALE).f, C = at._COLOR !== undefined ? acc(at._COLOR) : null;
    const count = T.length / 3;
    const mmi = scatter.find((x) => x.name === n.name);
    if (!mmi || mmi.class !== 'MultiMeshInstance3D' || mmi.instance_count !== count) { worst = Infinity; continue; }
    counted += count;
    coloured &&= !!C && mmi.use_colors;
    overrides &&= mmi.material_override?.vertex_color_use_as_albedo === true && !mmi.has_meta;
    const stride = mmi.use_colors ? 16 : 12;
    for (let i = 0; i < count; i++) {
      const s = [S[i * 3], S[i * 3 + 1], S[i * 3 + 2]], q = [Q[i * 4], Q[i * 4 + 1], Q[i * 4 + 2], Q[i * 4 + 3]];
      nonUniform ||= Math.abs(s[0] - s[1]) > 0.1;
      rotated ||= Math.abs(q[3]) < 0.99;
      const row = [...trsRow([T[i * 3], T[i * 3 + 1], T[i * 3 + 2]], q, s)];
      if (C) row.push(C.f[i * C.n], C.f[i * C.n + 1], C.f[i * C.n + 2], C.n === 4 ? C.f[i * 4 + 3] : 1);
      worst = Math.max(worst, maxDiff(mmi.buffer.slice(i * stride, i * stride + row.length), row));
    }
  }
  check(counted === 7 && nonUniform && rotated, `scatter: 7 instances in MultiMeshInstance3D nodes, rotated and scaled non-uniformly (${counted})`);
  check(worst < 1e-5, `scatter: every MultiMesh.buffer row equals T·R·S of the GLB's instance, colour included (max difference ${worst.toExponential(2)})`);
  check(coloured && overrides, 'scatter: the instance colours are in the MultiMesh, shown by a material override that takes them as albedo');
  check(data[OUTPUTS[1]]?.class === 'CompressedTexture2D' && data[OUTPUTS[1]]?.size?.[0] === 16, `the textures output imports as a texture (${data[OUTPUTS[1]]?.class} ${data[OUTPUTS[1]]?.size?.join('×')})`);
  const pk = data['res://assets/props/props.topo'] ?? {};
  check(/addons\/topotopo\/package\.gd$/.test(pk.script ?? '') && pk.status === 'ok' && pk.package_id === 'props' && pk.package_name === 'studio/props' && pk.topotopo_version === VERSION,
    `props.topo loads as the package's status resource: ${pk.status} (${pk.message})`);
  check((pk.outputs ?? []).map((o) => o.id).join() === 'crate,panels,props,scatter' && pk.skipped?.island?.includes('terrain'), `it lists the outputs and the skipped terrain (${(pk.outputs ?? []).map((o) => `${o.id}:${o.state}`).join(' ')})`);
}

// ------------------------------------------------------------------------------------- 3. one graph edited
section('3. one graph edited: only its output cooks and reimports');
{
  const before = Object.fromEntries([...OUTPUTS, KIT_GLB].map((f) => [f, { sha: sha(fs.readFileSync(abs(A.proj, f))), imported: mtime(abs(A.proj, importOf(abs(A.proj, f)).path)) }]));
  editJson(path.join(A.props, 'graphs', 'crate.json'), (g) => { g.nodes.paint.params.roughness = 0.3; });
  const r = godot(A.proj, ['--import'], { label: 'import-edit' });
  check(r.code === 0 && !r.unexpected.length && /cooking 1 stale package before the first scan: res:\/\/assets\/props\/props\.topo/.test(r.log), 'the package cooks before the first scan, no ERROR');
  const crate = OUTPUTS[0];
  const now = sha(fs.readFileSync(abs(A.proj, crate)));
  check(now !== before[crate].sha && record(A.props).outputs.crate.files[crate] === now, 'crate.glb is cooked again and the record has its new hash');
  check(mtime(abs(A.proj, importOf(abs(A.proj, crate)).path)) > before[crate].imported, 'crate.glb is reimported');
  const same = [...OUTPUTS.slice(1), KIT_GLB].filter((f) => sha(fs.readFileSync(abs(A.proj, f))) === before[f].sha && mtime(abs(A.proj, importOf(abs(A.proj, f)).path)) === before[f].imported);
  check(same.length === 4, `the other outputs are byte-identical and their imports untouched (${same.map((f) => path.basename(f)).join(', ')})`);
}

// ------------------------------------------------------------------------------- 4. Godot's settings survive
section('4. an output\'s own Godot settings survive its recooks');
{
  const crateImport = `${abs(A.proj, OUTPUTS[0])}.import`, kitImport = `${abs(A.proj, KIT_GLB)}.import`;
  fs.writeFileSync(crateImport, fs.readFileSync(crateImport, 'utf8').replace(/^nodes\/root_type=.*$/m, 'nodes/root_type="StaticBody3D"'));
  fs.writeFileSync(kitImport, fs.readFileSync(kitImport, 'utf8').replace(/^importer=.*$/m, 'importer="MeshLibrary"'));
  // Godot sees an edited .import by its time in whole seconds: one written in the second Godot last wrote it would go
  // unseen (a person never edits that fast)
  for (const f of [crateImport, kitImport]) { const t = Date.now() / 1000 + 2; fs.utimesSync(f, t, t); }
  let r = godot(A.proj, ['--import'], { label: 'import-settings' });
  let { data } = inspect(A.proj, [OUTPUTS[0], KIT_GLB]);
  check(!r.unexpected.length && data[OUTPUTS[0]]?.nodes?.[0]?.class === 'StaticBody3D' && data[KIT_GLB]?.class === 'MeshLibrary', `set by hand: crate's root is a StaticBody3D, kit imports as a MeshLibrary (${data[OUTPUTS[0]]?.nodes?.[0]?.class}, ${data[KIT_GLB]?.class})`);
  const before = [sha(fs.readFileSync(abs(A.proj, OUTPUTS[0]))), sha(fs.readFileSync(abs(A.proj, KIT_GLB)))];
  editJson(path.join(A.props, 'graphs', 'crate.json'), (g) => { g.nodes.paint.params.roughness = 0.4; });
  editJson(path.join(A.kit, 'graphs', 'kit.json'), (g) => { g.nodes.box.params.size = [0.6, 0.5, 0.5]; });
  r = godot(A.proj, ['--import'], { label: 'import-recook-settings' });
  ({ data } = inspect(A.proj, [OUTPUTS[0], KIT_GLB]));
  const after = [sha(fs.readFileSync(abs(A.proj, OUTPUTS[0]))), sha(fs.readFileSync(abs(A.proj, KIT_GLB)))];
  check(!r.unexpected.length && after[0] !== before[0] && after[1] !== before[1], 'both GLBs are cooked again');
  check(/^nodes\/root_type="StaticBody3D"$/m.test(fs.readFileSync(crateImport, 'utf8')) && importOf(abs(A.proj, KIT_GLB)).importer === 'MeshLibrary', 'their .import files keep the settings');
  check(data[OUTPUTS[0]]?.nodes?.[0]?.class === 'StaticBody3D' && data[KIT_GLB]?.class === 'MeshLibrary', `and Godot imported them with those settings (${data[OUTPUTS[0]]?.nodes?.[0]?.class}, ${data[KIT_GLB]?.class})`);
}

// ------------------------------------------------------------------------------------------ 5. a broken graph
section('5. a broken graph keeps the last good GLB and says why; fixed, everything is current again');
{
  const crateJson = path.join(A.props, 'graphs', 'crate.json');
  const good = fs.readFileSync(crateJson);
  const before = sha(fs.readFileSync(abs(A.proj, OUTPUTS[0])));
  editJson(crateJson, (g) => { g.nodes.body.in = ['nowhere']; });
  const r = godot(A.proj, ['--import'], { label: 'import-broken', expect: [/TopoTopo: props > crate: \[body\]/, /Error importing 'res:\/\/assets\/props\/props\.topo'/] });
  check(!r.unexpected.length && r.expected.some((l) => /TopoTopo: props > crate: \[body\]/.test(l)), `the log names the output and the node: ${r.expected.find((l) => /TopoTopo: props > crate/.test(l))?.trim()}`);
  check(sha(fs.readFileSync(abs(A.proj, OUTPUTS[0]))) === before, 'crate.glb keeps its last good bytes');
  const rec = record(A.props);
  check(rec.outputs.crate.state === 'failed' && rec.outputs.crate.errors[0]?.node === 'body' && rec.outputs.scatter.state === 'ok', 'the record marks crate failed with its node; the other outputs are ok');
  check(!importOf(path.join(A.props, 'props.topo')).valid, 'the .topo import is failed (Godot\'s ImportFail icon)');
  const st = topotopo(['godot', 'status', A.proj, '--strict']);
  const ck = godot(A.proj, ['--script', 'res://addons/topotopo/tools/check.gd'], { label: 'check-broken' });
  check(st.code === 1 && /failed\s+res:\/\/assets\/props\/props\.topo/.test(st.out), 'topotopo godot status --strict exits 1');
  check(ck.code === 1 && /TopoTopo check: failed\s+res:\/\/assets\/props\/props\.topo/.test(ck.log) && !ck.unexpected.length, 'tools/check.gd exits 1');
  fs.writeFileSync(crateJson, good);
  const fixed = godot(A.proj, ['--import'], { label: 'import-fixed' });
  check(!fixed.unexpected.length && record(A.props).outputs.crate.state === 'ok', 'fixed: the crate cooks');
  check(topotopo(['godot', 'status', A.proj, '--strict']).code === 0, 'topotopo godot status --strict exits 0');
  const ck2 = godot(A.proj, ['--script', 'res://addons/topotopo/tools/check.gd'], { label: 'check-fixed' });
  check(ck2.code === 0 && /every package is current/.test(ck2.log), 'tools/check.gd exits 0');
  check(importOf(path.join(A.props, 'props.topo')).valid, 'the .topo imports again (valid)');
}

// ------------------------------------------------------------------------------------- 6. without TopoTopo
section('6. a machine without TopoTopo: committed outputs are used; a stale package says how to set TopoTopo up');
{
  const none = { TOPOTOPO_CLI: path.join(tmp, 'no-topotopo', 'cli.ts') };
  fs.rmSync(path.join(A.proj, '.godot'), { recursive: true, force: true });
  const r = godot(A.proj, ['--import'], { extraEnv: none, label: 'import-no-topotopo' });
  check(!r.unexpected.length && !/cooking/.test(r.log), 'a fresh import (no .godot) cooks nothing and logs no ERROR');
  const { data } = inspect(A.proj, [OUTPUTS[0], OUTPUTS[3], 'res://assets/props/props.topo']);
  check(data[OUTPUTS[0]]?.class === 'PackedScene' && data[OUTPUTS[3]]?.class === 'PackedScene', 'the committed GLBs import');
  check(data['res://assets/props/props.topo']?.status === 'ok' && /cooked elsewhere, current/.test(data['res://assets/props/props.topo']?.message ?? ''), `the .topo is ok: "${data['res://assets/props/props.topo']?.message}"`);
  const before = sha(fs.readFileSync(abs(A.proj, OUTPUTS[0])));
  editJson(path.join(A.props, 'graphs', 'crate.json'), (g) => { g.nodes.paint.params.roughness = 0.5; });
  const r2 = godot(A.proj, ['--import'], { extraEnv: none, label: 'import-stale-no-topotopo', expect: [/TopoTopo: props\.topo: graphs\/crate\.json changed after the last cook and TopoTopo is not set up here/, /Error importing 'res:\/\/assets\/props\/props\.topo'/] });
  check(!r2.unexpected.length && r2.expected.length > 0, `the .topo import fails and says why: ${r2.expected[0]?.trim().slice(0, 160)}…`);
  check(!importOf(path.join(A.props, 'props.topo')).valid && sha(fs.readFileSync(abs(A.proj, OUTPUTS[0]))) === before, 'the .topo import is failed, crate.glb is unchanged');
  const zip = path.join(tmp, 'stale.zip');
  const ex = godot(A.proj, ['--export-pack', 'Pack', zip], { extraEnv: none, label: 'export-stale', expect: [/TopoTopo: props: stale/, /graphs\/crate\.json changed after the last cook and TopoTopo is not set up here/, /Error importing/] });
  check(ex.expected.some((l) => /TopoTopo: props: stale/.test(l)) && !ex.unexpected.length, 'an export names the stale package in its log');
}

// ---------------------------------------------------------------------------------------- 7. published copies
section('7. a published copy: hidden by .gdignore it is never imported; visible, it is refused');
{
  const v = path.join(A.props, 'versions', '1.0');
  fs.mkdirSync(v, { recursive: true });
  fs.copyFileSync(path.join(A.props, 'props.topo'), path.join(v, 'props.topo'));
  write(path.join(v, 'version.json'), '{"version": "1.0"}\n');
  write(path.join(A.props, 'versions', '.gdignore'), '');
  const r = godot(A.proj, ['--import'], { label: 'import-copy-hidden' });
  check(!r.unexpected.length && !fs.existsSync(path.join(v, 'props.topo.import')), 'hidden: no import of the copy, no ERROR (the package itself cooks again)');
  fs.rmSync(path.join(A.props, 'versions', '.gdignore'));
  const r2 = godot(A.proj, ['--import'], { label: 'import-copy-visible', expect: [/res:\/\/assets\/props\/versions\/1\.0\/props\.topo is a published copy; hide its folder with \.gdignore/, /Error importing 'res:\/\/assets\/props\/versions\/1\.0\/props\.topo'/] });
  check(!r2.unexpected.length && r2.expected.length > 0 && !importOf(path.join(v, 'props.topo')).valid, `visible: refused (${r2.expected[0]?.trim().slice(0, 120)})`);
  fs.rmSync(path.join(A.props, 'versions'), { recursive: true, force: true });
}

// --------------------------------------------------------------------------------------------- 8. an export
section('8. an export pack carries the outputs and none of TopoTopo\'s files');
{
  const zip = path.join(tmp, 'pack.zip');
  const r = godot(A.proj, ['--export-pack', 'Pack', zip], { label: 'export' });
  const names = fs.existsSync(zip) ? Object.keys(unzipSync(new Uint8Array(fs.readFileSync(zip)))) : [];
  check(!r.unexpected.length && names.length > 0, `the pack is written (${names.length} files), no ERROR`);
  const imported = (f) => importOf(abs(A.proj, f))?.dest ?? [];
  const wanted = [...OUTPUTS.filter((f) => f.endsWith('.glb')), KIT_GLB].flatMap((f) => imported(f).filter((d) => d.endsWith('.scn') || d.endsWith('.res')));
  const tex = imported(OUTPUTS[1]).concat(imported('res://assets/props/outputs/crate/crate_decal.png'));
  const has = (res) => names.includes(res.replace(/^res:\/\//, ''));
  check(wanted.length === 4 && wanted.every(has), `the outputs' imported scenes (and the kit's MeshLibrary) are in it (${wanted.filter(has).map((f) => path.basename(f)).join(', ')})`);
  check(tex.some(has), `the textures are in it (${tex.filter(has).map((f) => path.basename(f)).join(', ')})`);
  const bad = names.filter((n) => /\.topo(\.import)?$|\.topo-[0-9a-f]+\.res$|\/graphs\/|\/inputs\/|\.topotopo\/|addons\/topotopo\/|assets\/props\/notes\.txt|\.report\.json$|jobs-/.test(n));
  check(!bad.length, `no .topo or its import, no graphs, inputs, record, notes or addon files${bad.length ? `: ${bad.join(', ')}` : ''}`);
}

// ------------------------------------------------------------------------- 9 and 10. a C# project, fresh twice
section('9. a C# project (a Godot.NET.Sdk .csproj, never built) imports cleanly');
const B = makeProject('other game');
{
  write(path.join(B.proj, 'Other Game.csproj'), '<Project Sdk="Godot.NET.Sdk/4.7.2">\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n    <EnableDynamicLoading>true</EnableDynamicLoading>\n  </PropertyGroup>\n</Project>\n');
  fs.appendFileSync(path.join(B.proj, 'project.godot'), '\n[dotnet]\n\nproject/assembly_name="Other Game"\n');
  const r = godot(B.proj, ['--import'], { label: 'import-csharp' });
  check(B.setup.code === 0 && !r.unexpected.length, 'setup and --import, no ERROR');
  const missing = [...OUTPUTS, KIT_GLB].filter((f) => !importOf(abs(B.proj, f)));
  check(!missing.length && importOf(path.join(B.props, 'props.topo'))?.valid, 'every output imports, the .topo imports');
}

section('10. two fresh projects give byte-identical outputs and records');
{
  const differ = Object.keys(firstCook).filter((f) => sha(fs.readFileSync(abs(B.proj, f))) !== firstCook[f]);
  check(!differ.length, `${Object.keys(firstCook).length} files compared${differ.length ? `; different: ${differ.join(', ')}` : ''}`);
}

section('11. the window\'s flow in a headless editor (tests/live): background cooks, reimports, the panel, failures');
{
  const pg = path.join(A.proj, 'project.godot');
  const text = fs.readFileSync(pg, 'utf8');
  fs.writeFileSync(pg, text.replace('enabled=PackedStringArray("res://addons/topotopo/plugin.cfg")', 'enabled=PackedStringArray("res://addons/topotopo/plugin.cfg", "res://tests/live/plugin.cfg")'));
  // the kit as never cooked: the editor cooks it at startup, in the background
  fs.rmSync(path.join(A.kit, 'outputs'), { recursive: true, force: true });
  fs.rmSync(path.join(A.kit, '.topotopo'), { recursive: true, force: true });
  const r = godot(A.proj, ['--editor'], { label: 'live', extraEnv: { TOPOTOPO_GODOT_WINDOW: '1' }, expect: [/TopoTopo: props > crate: \[body\]/, /Error importing 'res:\/\/assets\/props\/props\.topo'/, /TopoTopo: props: /, /TopoTopo: props\.topo did not cook/, /TopoTopo: res:\/\/assets\/props\/props\.topo did not cook/] });
  fs.writeFileSync(pg, text);
  const lines = r.log.split(/\r?\n/).filter((l) => /^(PASS|FAIL) /.test(l));
  for (const l of lines) console.log(`     ${l}`);
  const failed = lines.filter((l) => l.startsWith('FAIL')).length;
  check(r.code === 0 && failed === 0 && lines.length >= 20 && !r.unexpected.length, `live.gd: ${lines.length - failed} passed, ${failed} failed`);
  check(/TopoTopo: props \(res:\/\/assets\/props\/props\.topo\): cooked, current\n {2}last cook: ok, \d+ ms, record \w+\n {2}crate \(mesh\): unchanged → res:\/\/assets\/props\/outputs\/crate\/crate\.glb/.test(r.log.replace(/\r/g, '')), 'Show Cook Report prints the last cook to Output');
}

section('12. the demo project (integrations/godot/demo): one setup command, then it imports as its README says');
{
  const DEMO = path.join(ROOT, 'integrations', 'godot', 'demo');
  const demo = path.join(tmp, 'demo é');
  copyDir(DEMO, demo);
  const before = Object.fromEntries(filesBelow(demo).map((f) => [f, sha(fs.readFileSync(path.join(demo, f)))]));
  const s = topotopo(['godot', 'setup', demo]);
  const touched = filesBelow(demo).filter((f) => !f.startsWith('addons/topotopo/') && before[f] !== (fs.existsSync(path.join(demo, f)) ? sha(fs.readFileSync(path.join(demo, f))) : undefined));
  check(s.code === 0 && !touched.length && /enabled in project\.godot already/.test(s.out) && /hidden from Godot already/.test(s.out) && /\.gitignore has the cook's lines already/.test(s.out),
    `topotopo godot setup adds the addon and changes no file of the demo${touched.length ? ` (changed: ${touched.join(', ')})` : ''}`);
  write(path.join(demo, 'tests', 'check_import.gd'), fs.readFileSync(path.join(TEST_PROJECT, 'tests', 'check_import.gd')));
  const r = godot(demo, ['--import'], { label: 'demo-import' });
  check(!r.unexpected.length && /cooking 3 stale packages before the first scan/.test(r.log), 'the first import cooks the three packages, no ERROR');
  const crate = 'res://assets/crate/outputs/crate/crate.glb', ground = 'res://assets/yard/outputs/ground/ground.glb', stones = 'res://assets/yard/outputs/stones/stones.glb';
  const maps = ['brick_color', 'brick_normal', 'brick_roughness'].map((m) => `res://assets/bricks/outputs/bricks/${m}.png`);
  const { data } = inspect(demo, [crate, ground, stones, ...maps, 'res://assets/crate/crate.topo', 'res://assets/yard/yard.topo', 'res://assets/bricks/bricks.topo']);
  const nodes = (f) => (data[f]?.nodes ?? []).map((n) => `${n.name}:${n.class}`);
  check(['handle:Node3D', 'side_left:Node3D', 'side_right:Node3D', 'crate_lod0:MeshInstance3D', 'crate_lod1:MeshInstance3D'].every((n) => nodes(crate).includes(n)), `crate.glb: three sockets and two LOD pieces (${nodes(crate).join(', ')})`);
  check((data[crate]?.nodes ?? []).flatMap((n) => n.materials ?? []).every((m) => m.albedo_texture === 'res://assets/crate/outputs/crate/crate_wood.png'), 'crate.glb: its material uses the extracted plank texture');
  const mm = (data[stones]?.nodes ?? []).filter((n) => n.class === 'MultiMeshInstance3D');
  check(mm.length === 3 && mm.reduce((a, n) => a + n.instance_count, 0) === 40 && mm.every((n) => n.use_colors), `stones.glb: 40 stones in three MultiMeshInstance3D nodes, tinted (${mm.map((n) => `${n.name} × ${n.instance_count}`).join(', ')})`);
  check(data[ground]?.class === 'PackedScene' && maps.every((m) => data[m]?.class === 'CompressedTexture2D'), 'ground.glb is a scene, the brick maps are textures');
  check(['crate', 'yard', 'bricks'].every((p) => data[`res://assets/${p}/${p}.topo`]?.status === 'ok'), 'every .topo is ok');
}

section('13. an invalid output folder fails its package without breaking the batch');
{
  const file = path.join(B.props, 'props.topo');
  const original = fs.readFileSync(`${file}.import`, 'utf8');
  const before = sha(fs.readFileSync(abs(B.proj, OUTPUTS[0])));
  const kitBefore = sha(fs.readFileSync(abs(B.proj, KIT_GLB)));
  write(`${file}.import`, original.replace(/^outputs\/folder=.*$/m, 'outputs/folder="res://../outside"'));
  editJson(path.join(B.kit, 'graphs', 'kit.json'), (g) => { g.nodes.box.params.size[0] += 0.1; });
  const r = godot(B.proj, ['--import'], { label: 'import-invalid-options', expect: [/TopoTopo: res:\/\/assets\/props\/props\.topo: the output folder .* is outside the Godot project/, /Error importing 'res:\/\/assets\/props\/props\.topo'/] });
  check(r.code === 0 && !r.unexpected.length && r.expected.length > 0, 'invalid options give a package error, no script errors');
  check(!importOf(file).valid && sha(fs.readFileSync(abs(B.proj, OUTPUTS[0]))) === before, 'the invalid package fails its import and keeps its last good GLB');
  check(importOf(path.join(B.kit, 'kit.topo')).valid && sha(fs.readFileSync(abs(B.proj, KIT_GLB))) !== kitBefore, 'the other stale package still cooks and imports');
  write(`${file}.import`, original);
  const restored = godot(B.proj, ['--import'], { label: 'import-options-restored' });
  check(restored.code === 0 && !restored.unexpected.length && importOf(file).valid && topotopo(['godot', 'status', B.proj, '--strict']).code === 0, 'restoring the options makes every package current');
}

console.log(`\ntest:godot: ${passes} passed, ${failures} failed (${runs} Godot runs; logs in ${LOGS})`);
if (!KEEP && !failures) fs.rmSync(tmp, { recursive: true, force: true });
else console.log(`kept ${tmp}`);
process.exit(failures ? 1 : 0);
