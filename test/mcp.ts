// End-to-end MCP test: spawns the stdio server like a real client and exercises every tool.
//   node test/mcp.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { INPUTS_EXAMPLE } from '../src/mcp/docs.ts';
import { builtinVersions } from '../src/gallery/packages.ts';

/** A 16-bit grey PNG made by hand (signature, IHDR, IDAT, IEND), the way a heightmap arrives. */
function grey16PNG(w: number, h: number, values: number[]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    out.writeUInt32BE(zlib.crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 16; ihdr[9] = 0; // bit depth 16, colour type grey
  const raw = Buffer.alloc(h * (1 + w * 2)); // filter byte 0 per row
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.writeUInt16BE(values[y * w + x], y * (1 + w * 2) + 1 + x * 2);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topotopo-mcp-'));
// the library tool reads the person's config: give it one of its own, never the real ~/.topotopo
const libDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topotopo-mcp-lib-'));
const configFile = path.join(libDir, 'config.json');
fs.writeFileSync(configFile, JSON.stringify({ libraries: [{ name: 'game', path: path.join(libDir, 'lib') }], gallery: { port: 7399 } }));
fs.mkdirSync(path.join(libDir, 'lib'));
// a folder of the person's (a file of their own in it): the server leaves it as it is, in no project
fs.writeFileSync(path.join(wsDir, 'notes.md'), 'what this folder is for\n');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, 'src/mcp/server.ts'), '--workspace', wsDir],
  env: { ...getDefaultEnvironment(), TOPOTOPO_CONFIG: configFile },
  stderr: 'pipe',
});
const client = new Client({ name: 'topotopo-test', version: '0.0.1' });
await client.connect(transport);

let failures = 0;
const check = (cond: any, msg: string) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failures++; };
/** the newest version of topotopo/nature in TopoTopo's built-in library, which a first use adds, and as a pattern */
const NATURE = builtinVersions('topotopo/nature').at(-1)!.version, NV = NATURE.replace('.', '\\.');
const call = async (name: string, args: any) => {
  const r: any = await client.callTool({ name, arguments: args });
  const txt = r.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
  const img = r.content.find((c: any) => c.type === 'image');
  return { r, txt, img, isError: !!r.isError };
};

const info = client.getServerVersion();
check(info?.name === 'topotopo', `server name ${info?.name}`);
check(!fs.existsSync(path.join(wsDir, 'project.json')), 'a named folder that holds files of its own is not made a project');
check((client.getInstructions() ?? '').includes('WORKFLOW'), 'server instructions present');
const { tools } = await client.listTools();
check(tools.length >= 9, `tools: ${tools.map((t) => t.name).join(', ')}`);

const cat = await call('catalog', {});
check(cat.txt.includes('copy_to_points') && cat.txt.includes('[sdf]'), 'catalog lists nodes');
check(cat.txt.includes('[package]') && cat.txt.includes('topotopo/architecture/wall_segment ◦ — Straight wall from x = 0'), 'catalog lists the outputs of TopoTopo\'s own packages with their descriptions, in a workspace in no project too');
const help = await call('help', { nodes: ['scatter', 'copytopoints', 'nope_node'], topic: 'wrangle' });
check(help.txt.includes('## scatter') && help.txt.includes('## copy_to_points') && help.txt.includes('unknown node "nope_node"'), 'help resolves nodes + aliases');

// validation errors with hints
const bad = await call('build', { graph: { nodes: { a: { type: 'sphre' }, b: { type: 'scatter', in: ['a'], params: { cnt: 10 } } } } });
check(bad.isError && bad.txt.includes('did you mean sphere') && bad.txt.includes('"count"'), 'build reports did-you-mean errors');

const graph = {
  nodes: {
    terrain: { type: 'terrain', params: { size: [12, 12], divisions: [64, 64], height: 2, seed: 4 } },
    pts: { type: 'scatter', in: ['terrain'], params: { count: '=n', seed: 2 } },
    flat: { type: 'delete', in: ['pts'], params: { class: 'point', group: '@N.y<0.8' } },
    sc: { type: 'attrib_randomize', in: ['flat'], params: { name: 'pscale', min: 0.15, max: 0.45 } },
    rock: { type: 'sphere', params: { type: 'ico', level: 2 } },
    rk: { type: 'noise_displace', in: ['rock'], params: { amplitude: 0.3, frequency: 1.7 } },
    rocks: { type: 'copy_to_points', in: ['rk', 'sc'] },
    tint: { type: 'color', in: ['terrain'], params: { mode: 'ramp', attrib: 'height' } },
    out: { type: 'merge', in: ['tint', 'rocks'] },
  },
  vars: { n: 120 },
};
const b = await call('build', { graph, render: { views: 'persp', size: 400 } });
check(!b.isError && b.txt.includes('✓ graph "main"'), 'build ok');
check(b.img && b.img.mimeType === 'image/png' && b.img.data.length > 1000, 'build returns png');
if (b.img) fs.writeFileSync(path.join(wsDir, 'build.png'), Buffer.from(b.img.data, 'base64'));
console.log(b.txt.split('\n').slice(0, 4).join('\n'));

const e = await call('edit', { ops: [{ op: 'vars', vars: { n: 300 } }, { op: 'insert', node: 'smooth1', type: 'smooth', after: 'terrain', params: { iterations: 3 } }] });
check(!e.isError && /cached/.test(e.txt), 'edit re-cooks incrementally');
console.log(e.txt.split('\n')[0]);

const ins = await call('inspect', { node: 'rocks', detail: 'all', class: 'point', count: 3 });
check(ins.txt.includes('topology:') && ins.txt.includes('point elements'), 'inspect detail');
const insSum = await call('inspect', { node: 'rocks' });
check(/\d triangles\n/.test(insSum.txt) && /^bbox: min \(-?\d+\.\d{3}, /m.test(insSum.txt) && /^topology: /m.test(insSum.txt), 'inspect summary (default): one screen with triangles, the bbox to the mm and the topology');
const insBud = await call('inspect', { node: 'rocks', detail: 'budget', json: true });
check(!insBud.isError && /^budget: [\d,]+ triangles/m.test(insBud.txt) && /^by node \(the triangles each node adds/m.test(insBud.txt) && /budget \(JSON\):\n\{"triangles":/.test(insBud.txt), 'inspect detail "budget": totals, parts, nodes, and JSON');
const insScene = await call('inspect', { node: 'rocks', detail: 'scene', export_options: { split_by_name: false } });
check(!insScene.isError && /^scene \(the glb export, read back\): 1 nodes, 1 meshes/m.test(insScene.txt), `inspect detail "scene": the glb export read back (${insScene.txt.split('\n')[1]?.slice(0, 100)})`);

const rnd = await call('render', { node: 'terrain', color_by: 'height', views: ['top', 'persp'] });
check(!!rnd.img, 'render tool image');
if (rnd.img) fs.writeFileSync(path.join(wsDir, 'render.png'), Buffer.from(rnd.img.data, 'base64'));
const ov = await call('render', { node: 'rocks', views: ['persp', 'section'], section_axis: 'x', wireframe: 'hard', glyphs: 'N', max_glyphs: 50, label_pieces: true, max_labels: 5, shading: 'matcap', size: 256 });
check(!!ov.img && !ov.isError && /overlays: shading matcap .*section x=.*wire hard>30/.test(ov.txt) && /label_pieces: first 5 of/.test(ov.txt), `render tool overlays: ${ov.txt.split('\n').find((l) => l.includes('overlays'))?.slice(0, 120)}`);
const pngSize = (img: any) => { const b = Buffer.from(img.data, 'base64'); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
const ul = await call('render', { node: 'rocks', views: 'front_left', size: '300x150', underlay: 'render.png', underlay_opacity: 0.4, sockets: true });
check(!!ul.img && !ul.isError && pngSize(ul.img).join('x') === '300x188' && /no scene empties/.test(ul.txt), `render tool: size "WxH", a named view, an underlay read from the workspace, sockets (${ul.img ? pngSize(ul.img).join('x') : ul.txt.slice(0, 120)})`);
const ulBad = await call('render', { node: 'rocks', underlay: 'missing.png' });
check(ulBad.isError && /underlay "[^"]*missing\.png" cannot be read/.test(ulBad.txt), 'render tool: a missing underlay is an error naming it');
const ovBad = await call('render', { node: 'rocks', shading: 'toon' });
check(ovBad.isError && /unknown shading "toon"/.test(ovBad.txt), 'render tool rejects an unknown shading mode');
const helpR = await call('help', { topic: 'render' });
check(helpR.txt.includes('QUESTION → OPTION') && helpR.txt.includes('wireframe:"boundary"'), 'help topic render');

// verification tools: explain a node, then diff two versions of the graph with an overlay render
const ex = await call('explain', { node: 'rk' });
check(!ex.isError && /reads as: one closed piece/.test(ex.txt) && /watertight/.test(ex.txt), `explain: ${ex.txt.split('\n')[0]}`);
const dup = await call('graphs', { action: 'duplicate', name: 'main', to: 'before' });
check(!dup.isError, 'graphs duplicate main → before');
await call('edit', { ops: [{ op: 'set', node: 'rk', params: { amplitude: 0.45 } }] });
const df = await call('diff', { a: 'before/rk', b: { graph: 'main', node: 'rk' }, render: true, views: 'persp', size: 300 });
check(!df.isError && /Hausdorff/.test(df.txt) && /points \(same count/.test(df.txt) && df.img?.mimeType === 'image/png', `diff: ${df.txt.split('\n').find((l: string) => l.startsWith('verdict')) ?? df.txt.slice(0, 120)}`);
if (df.img) fs.writeFileSync(path.join(wsDir, 'diff.png'), Buffer.from(df.img.data, 'base64'));
const dfBad = await call('diff', { a: 'before/nope', b: 'main' });
check(dfBad.isError && /nope/.test(dfBad.txt), 'diff reports an unknown node');

for (const fmt of ['glb', 'gltf', 'obj', 'usda', 'ply', 'stl', 'json', 'geo', 'csv', 'points.json']) {
  const x = await call('export', { path: `exports/scene.${fmt}` });
  check(!x.isError && fs.existsSync(path.join(wsDir, 'exports', `scene.${fmt}`)), `export ${fmt}: ${x.txt.split('\n')[0].slice(0, 90)}`);
  if (fmt === 'glb') {
    // every export records how it was made: the graph, its vars (after the edit above), seeds, frame, version
    const man = JSON.parse(fs.readFileSync(path.join(wsDir, 'exports', 'scene.glb.source.json'), 'utf8'));
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    check(JSON.stringify(man.files) === '["scene.glb"]' && man.source.graph === 'main' && man.source.node === 'out' && man.source.output === null && man.source.frame === 1
      && JSON.stringify(man.source.vars) === '{"n":300}' && man.source.seeds.terrain === 4 && man.source.seeds.pts === 2 && man.source.topotopo === pkg.version
      && /^wrote \S*scene\.glb \(glb/.test(x.txt) && /source recorded in scene\.glb\.source\.json/.test(x.txt),
      `export records its source next to the file (${x.txt.split('\n').find((l) => l.startsWith('source')) ?? 'no source line'})`);
  }
}
{
  const x = await call('export', { path: 'exports/scene_z.obj', up_axis: 'z', scale: 100, frame: 3 });
  const s = JSON.parse(fs.readFileSync(path.join(wsDir, 'exports', 'scene_z.obj.source.json'), 'utf8')).source;
  check(!x.isError && s.frame === 3 && JSON.stringify(s.export) === '{"format":"obj","options":{"instancing":"packed","scale":100,"split_by_name":true,"up_axis":"z"}}', `the source records the frame, the export options given and the defaults of the rest (${JSON.stringify(s.export)})`);
}
{
  const x = await call('export', { path: 'exports/scene_meshopt.glb', compress: 'meshopt' });
  const y = await call('export', { path: 'exports/scene_pcg.csv', pcg: true, attributes: ['pscale'] });
  check(!x.isError && x.txt.includes('glb') && !y.isError && fs.readFileSync(path.join(wsDir, 'exports', 'scene_pcg.csv'), 'utf8').startsWith('Name,Position.X'), 'export meshopt glb and Unreal PCG csv');
}
{
  // packed instances on a heightfield: the Unreal Landscape bundle and the instance stream with its meshes
  const ue = await call('build', { name: 'ue', graph: { nodes: {
    hf: { type: 'heightfield', params: { size: [32, 32], samples: [65, 65] } },
    n: { type: 'heightfield_noise', in: ['hf'], params: { amplitude: 3, element_size: 10 } },
    pts: { type: 'heightfield_scatter', in: ['n'], params: { count: 25, mask_layer: '' } },
    s: { type: 'sphere', params: { type: 'ico', level: 1, radius: 0.4 } },
    sn: { type: 'attrib_create', in: ['s'], params: { name: 'name', class: 'prim', value: 'shrub' } },
    inst: { type: 'copy_to_points', in: ['sn', 'pts'], params: { pack: true } },
    out: { type: 'merge', in: ['n', 'inst'] },
  } } });
  // an unknown output lists every named one, the named default output included
  await call('build', { name: 'named_default', graph: { nodes: { b: { type: 'box' }, c: { type: 'sphere' } }, output: 'b', outputs: { crate: { node: 'b', export: 'glb' }, ball: { node: 'c' } } } });
  const noOut = await call('export', { graph: 'named_default', output: 'nope' });
  check(noOut.isError && /publishes no output "nope" \(outputs: crate \(default\), ball\)/.test(noOut.txt), `export: an unknown output lists them all, the default one first (${noOut.txt.slice(0, 120)})`);
  const b1 = await call('export', { graph: 'ue', format: 'unreal_landscape', path: 'exports/level' });
  const man = path.join(wsDir, 'exports', 'level', 'landscape.json');
  check(!ue.isError && !b1.isError && fs.existsSync(man) && fs.existsSync(path.join(wsDir, 'exports', 'level', 'meshes', 'shrub.glb')) && /Unreal Landscape bundle/.test(b1.txt) && /not an exact fit/.test(b1.txt),
    `export unreal_landscape: ${b1.txt.split('\n')[0].slice(0, 120)}`);
  const b2 = await call('export', { graph: 'ue', node: 'inst', path: 'exports/shrubs.csv', pcg: true });
  check(!b2.isError && fs.existsSync(path.join(wsDir, 'exports', 'shrubs.meshes.json')) && fs.existsSync(path.join(wsDir, 'exports', 'shrubs_meshes', 'shrub.glb'))
    && fs.readFileSync(path.join(wsDir, 'exports', 'shrubs.csv'), 'utf8').trim().split('\n').length === 26, `export instance rows + meshes sidecar: ${b2.txt.split('\n')[0].slice(0, 120)}`);
  // formats with a sidecar or manifest keep the source there
  const bundleSource = JSON.parse(fs.readFileSync(man, 'utf8')).source;
  const rowsSource = JSON.parse(fs.readFileSync(path.join(wsDir, 'exports', 'shrubs.meshes.json'), 'utf8')).source;
  check(bundleSource?.graph === 'ue' && bundleSource.export.format === 'unreal_landscape' && rowsSource?.node === 'inst' && JSON.stringify(rowsSource.export.options) === '{"custom_attribs":false,"instances":"rows","instancing":"packed","materials":true,"meshes":true,"pcg":true,"pcg_struct":false,"scale":100,"up_axis":"y"}'
    && !fs.existsSync(path.join(wsDir, 'exports', 'shrubs.csv.source.json')) && /source recorded in shrubs\.meshes\.json/.test(b2.txt),
    'unreal_landscape records the source in landscape.json, instance rows in <name>.meshes.json');
}

const gl = await call('graphs', { action: 'list' });
check(gl.txt.includes('main:'), 'graphs list');
check(fs.existsSync(path.join(wsDir, 'graphs', 'main.json')), 'graph persisted to disk');

// asset round trip
const assetGraph = {
  nodes: {
    src: { type: 'input', params: { index: 0, label: 'points' } },
    pill: { type: 'tube', params: { radius: '=r', height: '=h', cols: 12 } },
    out: { type: 'copy_to_points', in: ['pill', 'src'] },
  },
  vars: { r: 0.1, h: 0.5 },
  params: { r: { desc: 'radius', min: 0 }, h: { desc: 'height' } },
};
const as = await call('assets', { action: 'save', name: 'pills', graph: assetGraph, description: 'pills on points' });
check(!as.isError && as.txt.includes('saved asset "pills"'), 'asset saved');
const useAsset = await call('build', { name: 'asset_test', graph: { nodes: { g: { type: 'grid', params: { divisions: [3, 3] } }, p: { type: 'pills', in: ['g'], params: { r: 0.2 } } } } });
check(!useAsset.isError && /geometry: \d/.test(useAsset.txt), `asset used as node: ${useAsset.txt.split('\n')[0]}`);

// only a project's graphs use packages: in a workspace that is none, naming one says how it becomes one; init makes it one
{
  const probe = { name: 'pkg_probe', graph: { nodes: { t: { type: 'studio/none/thing' } } } };
  const outside = await call('build', probe);
  check(outside.isError && /package studio\/none: this graph is in no project, and only projects use packages/.test(outside.txt) && /library \{action:"init"\} for the open workspace/.test(outside.txt),
    `a package named outside a project says how the workspace becomes one: ${outside.txt.split('\n').slice(1, 3).join(' ')}`);
  const init = await call('library', { action: 'init' });
  check(!init.isError && fs.existsSync(path.join(wsDir, 'project.json')) && /^made the workspace .* a project, id "/.test(init.txt) && fs.existsSync(path.join(wsDir, 'assets', 'pills.json')),
    `library init makes the open workspace a project: ${init.txt.slice(0, 80)}…`);
  const again = await call('library', { action: 'init' });
  check(again.isError && /is in a project already: .*project\.json/.test(again.txt), 'init refuses a workspace that is a project');
  const inside = await call('build', probe);
  check(inside.isError && /package studio\/none is not in this project's uses/.test(inside.txt), `in the project, a package is looked for in its libraries: ${inside.txt.split('\n')[1]}`);
  const kept = await call('build', { name: 'asset_test', graph: { nodes: { g: { type: 'grid', params: { divisions: [3, 3] } }, p: { type: 'pills', in: ['g'], params: { r: 0.2 } } } } });
  check(!kept.isError, 'the workspace keeps its graphs and assets');
}

// human input: files people drop into <workspace>/inputs, listed and described for the agent
{
  const inDir = path.join(wsDir, 'inputs');
  const empty = await call('inputs', { action: 'list' });
  check(fs.existsSync(inDir) && !empty.isError && /no input files yet/.test(empty.txt), 'inputs/ exists; inputs list says it is empty');
  check((client.getInstructions() ?? '').includes('inputs {action:"list"}') && cat.txt.includes('inputs {action:"list"}'), 'overview and catalog point at inputs list');
  // an OBJ with a named open polyline (l) and a named polygon (f), and a 16-bit heightmap
  fs.writeFileSync(path.join(inDir, 'guides.obj'), ['v 0 0 0', 'v 4 0 1', 'v 10 0 6', 'v 2 0 2', 'v 6 0 2', 'v 6 0 5', 'v 2 0 5',
    'o path.river', 'l 1 2 3', 'o zone.park', 'f 4 5 6 7', ''].join('\n'));
  fs.mkdirSync(path.join(inDir, 'maps'));
  fs.writeFileSync(path.join(inDir, 'maps', 'heights.png'), grey16PNG(3, 2, [0, 1000, 65535, 30000, 40000, 50000]));
  fs.writeFileSync(path.join(inDir, 'notes.txt'), 'the river runs east');
  const ls = await call('inputs', { action: 'list' });
  const row = (f: string) => ls.txt.split('\n').find((l) => l.startsWith(`  ${f}  `)) ?? '';
  check(!ls.isError && /^ {2}guides\.obj {2}geometry {2}\d+ B .*7 points, 2 prims = 1 polygon \+ 1 polyline; bbox 10\.0 × 0\.00 × 6\.00 m; name: path\.river, zone\.park/.test(row('guides.obj'))
    && /^ {2}maps\/heights\.png {2}image .*3 × 2 px, 16-bit grey \(1 channel\)/.test(row('maps/heights.png')) && /^ {2}notes\.txt {2}other /.test(row('notes.txt'))
    && ls.txt.includes('{"type":"file","params":{"path":"inputs/<path>"}}'), `inputs list:\n${ls.txt.split('\n').slice(0, 4).join('\n')}`);
  const ds = await call('inputs', { action: 'describe', path: 'guides.obj' });
  check(!ds.isError && /elements: 7 points, 2 prims = 1 polygon \+ 1 polyline/.test(ds.txt) && /"path\.river" {2}1 polyline/.test(ds.txt) && /"zone\.park" {2}1 polygon/.test(ds.txt)
    && /bbox \(metres.*min \(0\.00, 0\.00, 0\.00\) max \(10\.0, 0\.00, 6\.00\)/.test(ds.txt) && /roles \(from name prefixes\): path 1 object, zone 1 object/.test(ds.txt)
    && /prim: name string/.test(ds.txt) && /"up_axis":"z"/.test(ds.txt), `inputs describe obj: ${ds.txt.split('\n').slice(1, 3).join(' | ')}`);
  const dp = await call('inputs', { action: 'describe', path: 'inputs/maps/heights.png' });
  check(!dp.isError && /16-bit grey/.test(dp.txt) && /grey 0\.00\.\.1\.00/.test(dp.txt) && /heightfield_from_image/.test(dp.txt)
    && /\{"type":"image_file","params":\{"path":"inputs\/maps\/heights\.png"\}\}/.test(dp.txt) && /a node "heights"/.test(dp.txt), 'inputs describe png (heightmap, mask, points and texture readings)');
  const dm = await call('inputs', { action: 'describe', path: 'guide.obj' });
  check(dm.isError && /did you mean guides\.obj/.test(dm.txt), 'inputs describe: unknown file with did-you-mean');

  // the help topic's example graph (as the LLM reads it) on a guides.glb exported into inputs/, the way a person drops one
  const help = await call('help', { topic: 'inputs' });
  const exText = /\n(\{"nodes": \{\n[\s\S]*?\n \}\})\n/.exec(help.txt)?.[1];
  const example = exText ? JSON.parse(exText) : null;
  check(!!example && JSON.stringify(example) === JSON.stringify(INPUTS_EXAMPLE) && help.txt.includes('@name=path.*') && help.txt.includes("s@role = s@role || @name.split('.')[0].toLowerCase();"),
    'help topic inputs: group pattern, role wrangle and the example graph');
  // it names topotopo/nature/tree_lowpoly: a dry run checks it against the kit's version a build adds, and copies nothing
  const dry = await call('build', { name: 'land', graph: example, dry_run: true });
  check(!dry.isError && /^✓ valid: 15 nodes/.test(dry.txt) && new RegExp(`\\nnote: build or edit adds topotopo/nature ${NV} to project .* on first use, from library "topotopo" \\(TopoTopo's built-in library\\): this dry run read it there and copied nothing`).test(dry.txt),
    `a dry run of the help inputs example validates the kit's output where it lies: ${dry.txt.split('\n').slice(0, 2).join(' | ')}`);
  check(!fs.existsSync(path.join(wsDir, 'packages', 'topotopo', 'nature')) && !JSON.parse(fs.readFileSync(path.join(wsDir, 'project.json'), 'utf8')).uses?.['topotopo/nature'] && !fs.existsSync(path.join(wsDir, 'graphs', 'land.json')),
    'and writes nothing: no copy, no entry in uses, no graph');
  const dryTypo = await call('build', { name: 'land', graph: { nodes: { t: { type: 'topotopo/nature/tree_lowpoly', params: { heigth: 7 } } } }, dry_run: true });
  check(dryTypo.isError && /unknown param "heigth" for topotopo\/nature\/tree_lowpoly — did you mean "height"/.test(dryTypo.txt) && new RegExp(`\\nnote: build or edit adds topotopo/nature ${NV}`).test(dryTypo.txt),
    `a slider the version does not have is an error of the dry run: ${dryTypo.txt.split('\n')[1]}`);
  await call('build', { name: 'guides_src', graph: { nodes: {
    road: { type: 'curve', params: { points: [[-60, 0, -20], [-10, 0, 0], [30, 0, 10], [70, 0, 40]] } },
    road_n: { type: 'attrib_create', in: ['road'], params: { name: 'name', class: 'prim', type: 'string', value: 'path.road' } },
    park: { type: 'circle', params: { radius: 15, plane: 'xz', segments: 12, center: [20, 0, -30] } },
    park_n: { type: 'attrib_create', in: ['park'], params: { name: 'name', class: 'prim', type: 'string', value: 'zone.park' } },
    out: { type: 'merge', in: ['road_n', 'park_n'] },
  } } });
  const xg = await call('export', { graph: 'guides_src', path: 'inputs/guides.glb' });
  const land = await call('build', { name: 'land', graph: example });
  check(!xg.isError && !land.isError && /packed: \d+ instances of 1 source/.test(land.txt) && /point: .*\bpath f1/.test(land.txt), `help inputs example cooks on inputs/guides.glb: ${land.txt.split('\n')[0]}`);
  check(new RegExp(`note: added topotopo/nature ${NV} to project .* from library "topotopo" \\(TopoTopo's built-in library\\): packages/topotopo/nature/${NV}`).test(land.txt) && fs.existsSync(path.join(wsDir, 'packages', 'topotopo', 'nature', NATURE, 'version.json')),
    `its first use copies the nature kit's newest version (${NATURE}) in from TopoTopo's built-in library`);
  const dry2 = await call('build', { name: 'land', graph: example, dry_run: true });
  check(!dry2.isError && /✓ valid: 15 nodes/.test(dry2.txt), `then the help inputs example validates: ${dry2.txt.split('\n')[0]}`);
  const lsg = await call('inputs', { action: 'list' });
  check(/guides\.glb {2}geometry .*1 polyline.*name: path\.road, zone\.park/.test(lsg.txt), 'inputs list shows the exported glb');
  check(/guides\.glb\.source\.json {2}metadata .*export source: how guides\.glb was made \(graph "guides_src", frame 1\), not geometry/.test(lsg.txt)
    && /\(\d+ geometry, 1 image, 1 metadata, 1 other\)/.test(lsg.txt), 'inputs list names the export\'s source manifest as metadata instead of a failed cook');
  // a heightmap and its sidecar, as an export writes them: the sidecar is metadata of the PNG, not geometry
  const hx = await call('export', { graph: 'land', node: 'ground', path: 'inputs/terrain.png' });
  const lsh = await call('inputs', { action: 'list' });
  const dsh = await call('inputs', { action: 'describe', path: 'terrain.json' });
  check(!hx.isError && /terrain\.json {2}metadata .*heightmap sidecar of inputs\/terrain\.png: height range, Unreal import settings, how it was made, not geometry/.test(lsh.txt)
    && /terrain\.png {2}image /.test(lsh.txt) && !dsh.isError && /heightfield_from_image/.test(dsh.txt), `a heightmap's sidecar is metadata of its PNG: ${lsh.txt.split('\n').find((l) => l.includes('terrain.json'))}`);
  const lg = JSON.parse((await call('graphs', { action: 'get', name: 'land' })).txt);
  check(lg.params?.relief?.label === 'Hill height (m)' && lg.params?.tree_density?.step === 0.005, 'exposed params keep label and step');

  // an edit "vars" op changes the stored vars; an invalid edit is rejected with the graph unchanged
  const box = { b: { type: 'box', params: { size: '=s' } }, t: { type: 'transform', in: ['b'], params: { translate: [0, '=t', 0] } } };
  const vb = await call('build', { name: 'varsed', graph: { nodes: box, vars: { s: 2, t: 1 } } });
  const ve = await call('edit', { name: 'varsed', ops: [{ op: 'vars', vars: { s: 5, t: 3 } }] });
  const g1 = JSON.parse((await call('graphs', { action: 'get', name: 'varsed' })).txt);
  check(!vb.isError && !ve.isError && g1.vars.s === 5 && g1.vars.t === 3, 'edit vars stores the new values');
  const rej = await call('edit', { name: 'varsed', ops: [{ op: 'set', node: 'b', params: { sise: 3 } }] });
  check(rej.isError && rej.txt.startsWith('✗ edits rejected (graph unchanged) — 1 error(s):\n  [b] unknown param "sise"'), 'edit rejects invalid edits with the same text');
}

const pv = await call('preview', {});
check(/http:\/\/127\.0\.0\.1:\d+/.test(pv.txt), `preview url: ${pv.txt.split(' ')[2]}`);
const url = /http:\/\/127\.0\.0\.1:\d+\//.exec(pv.txt)?.[0];
if (url) {
  const g = await fetch(url + 'api/graphs').then((r) => r.json());
  check(Array.isArray(g) && g.length >= 1, 'viewer api/graphs');
  const glb = await fetch(url + 'api/geo?graph=main').then((r) => r.arrayBuffer());
  check(glb.byteLength > 1000, `viewer api/geo glb ${glb.byteLength} bytes`);
  // live update: an edit must push an SSE event to connected viewers
  const ac = new AbortController();
  const res = await fetch(url + 'api/events', { signal: ac.signal });
  const reader = res.body!.getReader();
  const got = (async () => {
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return '';
      buf += dec.decode(value);
      const m = /data: (.*)\n\n/.exec(buf);
      if (m) return m[1];
    }
  })();
  await call('edit', { ops: [{ op: 'set', node: 'pts', params: { seed: 9 } }] });
  const ev = await Promise.race([got, new Promise<string>((r) => setTimeout(() => r(''), 5000))]);
  ac.abort();
  check(ev.includes('"graph":"main"'), `viewer SSE update event: ${ev}`);
}

// libraries: create opens the project as the workspace; build lands in it; the viewer follows
{
  const empty = await call('library', { action: 'list' });
  check(empty.txt.includes('library "game"') && empty.txt.includes('0 projects'), 'library list: the configured library');
  const made = await call('library', { action: 'create', library: 'game', path: 'props/barrel', title: 'Barrel', tags: ['props'], links: [{ label: 'board', url: 'http://board.local/1' }] });
  const projDir = path.join(libDir, 'lib', 'props', 'barrel');
  check(!made.isError && made.txt.includes('opened') && made.txt.includes('http://127.0.0.1:7399/p/game/barrel'), `library create: ${made.txt.split('\n')[0]}`);
  await call('build', { graph: { nodes: { c: { type: 'cylinder' } }, output: 'c' } });
  check(fs.existsSync(path.join(projDir, 'graphs', 'main.json')) && !fs.existsSync(path.join(wsDir, 'graphs', 'barrel.json')), 'build after open writes into the project folder');
  const url = (await call('preview', {})).txt.match(/http:\/\/[^\s]+/)?.[0] ?? '';
  const names = ((await (await fetch(url + 'api/graphs')).json()) as any[]).map((g: any) => g.name);
  check(names.join() === 'main', `the live viewer shows the project (${names})`);
  const upd = await call('library', { action: 'set', description: 'An oil barrel', bake: { frame: 1 } });
  check(!upd.isError && JSON.parse(fs.readFileSync(path.join(projDir, 'project.json'), 'utf8')).description === 'An oil barrel', "library set edits the open project's project.json");
  const bk = await call('library', { action: 'bake' });
  check(!bk.isError && !!bk.img && fs.existsSync(path.join(projDir, '.gallery', 'preview.glb')), 'library bake renders the previews and shows the thumbnail');
  const got = await call('library', { action: 'get', library: 'game', id: 'barrel', thumbnail: true });
  check(got.txt.includes('(open)') && got.txt.includes('main (shown)') && got.txt.includes('board: http://board.local/1') && !!got.img, 'library get: manifest, graphs, links, thumbnail');
  const back = await call('library', { action: 'open', path: fs.mkdtempSync(path.join(os.tmpdir(), 'topotopo-mcp-loose-')) });
  check(back.isError && back.txt.includes('no project.json'), 'open refuses a folder that is not a project');
  const found = await call('library', { action: 'list', query: 'barrel' });
  check(found.txt.includes('barrel (open)') && found.txt.includes('baked'), 'library list finds it by words, marks the open one and its status');
}

// packages: a project publishes a version of its package; another lists the library, uses it and cooks its output
{
  const kit = path.join(libDir, 'lib', 'kits', 'crates');
  await call('library', { action: 'create', library: 'game', path: 'kits/crates', title: 'Crates' });
  const named = await call('library', { action: 'set', package: 'studio/crates' });
  check(!named.isError && JSON.parse(fs.readFileSync(path.join(kit, 'project.json'), 'utf8')).package === 'studio/crates', 'library set names the package');
  await call('build', { graph: {
    nodes: { c: { type: 'box', params: { size: '=s' } }, peek: { type: 'sphere' } }, output: 'c',
    vars: { s: 1 }, params: { s: { type: 'float', min: 0.1, max: 5, label: 'Size' } },
    outputs: { crate: { node: 'c', label: 'Crate' }, peek: { node: 'peek', publish: false } },
  } });
  const noNote = await call('library', { action: 'publish' });
  check(noNote.isError && /a version needs a note/.test(noNote.txt), 'library publish needs a note');
  const dry = await call('library', { action: 'publish', dry_run: true });
  check(!dry.isError && /^✓ would publish studio\/crates 1\.0 \(the first version\); publishing it needs a note/.test(dry.txt) && /\n {2}crate {2}mesh {2}"Crate"\n/.test(dry.txt) && !fs.existsSync(path.join(kit, 'versions')),
    `library publish dry_run:true is a dry run: the number, each output's kind, nothing written (${dry.txt.split('\n')[0]})`);
  const pub = await call('library', { action: 'publish', note: 'first crates' });
  check(!pub.isError && /✓ published studio\/crates 1\.0 \(the first version\): "first crates"/.test(pub.txt) && fs.existsSync(path.join(kit, 'versions', '1.0', 'version.json')), `library publish: ${pub.txt.split('\n')[0]}`);
  const again = await call('library', { action: 'publish', note: 'again' });
  check(again.isError && /nothing changed since 1\.0/.test(again.txt), 'publishing again without a change is refused');

  const yard = path.join(libDir, 'lib', 'levels', 'yard');
  await call('library', { action: 'create', library: 'game', path: 'levels/yard', title: 'Yard' });
  // the person lists the library the project finds packages in
  const pj = JSON.parse(fs.readFileSync(path.join(yard, 'project.json'), 'utf8'));
  fs.writeFileSync(path.join(yard, 'project.json'), JSON.stringify({ ...pj, libraries: ['game'] }, null, 2));
  const listed = await call('library', { action: 'packages' });
  check(!listed.isError && /\n {2}studio\/crates 1\.0 +1 output {2}\[library "game"\]/.test(listed.txt), `library packages lists the packages in the project's libraries: ${listed.txt.split('\n').find((l) => l.includes('studio/crates'))}`);
  const found = await call('library', { action: 'search', query: 'crate' });
  check(!found.isError && /^search "crate": \d+ outputs/.test(found.txt) && /\nlibrary "game" \(.*\): project yard lists it: a graph that names one of these adds its package\n {2}studio\/crates\/crate {2}mesh {2}"Crate" {2}1\.0/.test(found.txt)
    && /\n {2}topotopo\/props\/crate {2}/.test(found.txt), `library search finds outputs in the project's library and TopoTopo's built-in one: ${found.txt.split('\n').filter((l) => /^ {2}\S/.test(l)).join(' | ')}`);
  const meshes = await call('library', { action: 'search', kind: 'mesh', tag: 'nothing-has-this' });
  check(!meshes.isError && /^search kind mesh, tag nothing-has-this: no output matches in /.test(meshes.txt), `kind and tag filters: ${meshes.txt.split('\n')[0]}`);
  const b = await call('build', { graph: { nodes: { a: { type: 'studio/crates/crate', params: { s: 2 } }, d: { type: 'studio/crates', params: { s: 0.5 } }, t: { type: 'transform', in: ['d'], params: { translate: [3, 0, 0] } }, out: { type: 'merge', in: ['a', 't'] } }, output: 'out' } });
  check(!b.isError && /note: added studio\/crates 1\.0 to project yard from library "game"/.test(b.txt) && /✓ graph "main"/.test(b.txt) && fs.existsSync(path.join(yard, 'packages', 'studio', 'crates', '1.0', 'version.json')),
    `a build that names a package adds it on first use and cooks its outputs: ${b.txt.split('\n').filter((l) => /✓|note:|✗|\[/.test(l)).join(' | ')}`);
  const used = await call('library', { action: 'use', package: 'studio/crates' });
  check(!used.isError && /already uses studio\/crates 1\.0/.test(used.txt), 'library use: already in use');
  const h = await call('help', { nodes: ['studio/crates/crate', 'studio/crates/peek'] });
  check(/## studio\/crates\/crate \(package\)/.test(h.txt) && /studio\/crates 1\.0: first crates/.test(h.txt) && /s float = 1 \[0\.1\.\.5\]/.test(h.txt) && /has no output "peek"/.test(h.txt),
    'help gives a package output\'s sliders, version and note; a "publish": false output is not one');
  const c = await call('catalog', { category: 'package' });
  check(/\[package\]/.test(c.txt) && /studio\/crates\/crate ◦ — output "crate" of package studio\/crates 1\.0 \(Crate\)/.test(c.txt) && /studio\/crates ◦ — the default output/.test(c.txt), 'catalog lists the project\'s package outputs');
  const x = await call('export', { path: 'exports/yard.glb' });
  const rec = JSON.parse(fs.readFileSync(path.join(yard, 'exports', 'yard.glb.source.json'), 'utf8')).source;
  const lock = JSON.parse(fs.readFileSync(path.join(yard, 'packages', 'lock.json'), 'utf8'));
  check(!x.isError && JSON.stringify(rec.packages) === JSON.stringify({ 'studio/crates@1.0': lock.packages['studio/crates']['1.0'].hash }), `the export records the package version it used: ${JSON.stringify(rec.packages)}`);
  // following the kit's working folder for the session: an edit there re-cooks here; publishing is refused meanwhile
  const kitGraph = JSON.parse(fs.readFileSync(path.join(kit, 'graphs', 'main.json'), 'utf8'));
  kitGraph.nodes.c.params.size = '=s * 3';
  fs.writeFileSync(path.join(kit, 'graphs', 'main.json'), JSON.stringify(kitGraph, null, 2));
  const before = await call('inspect', { node: 'a' });
  const fol = await call('library', { action: 'follow', package: 'studio/crates', on: true });
  check(!fol.isError && /following studio\/crates for this session: its working folder/.test(fol.txt), `library follow: ${fol.txt.slice(0, 100)}`);
  const ins = await call('inspect', { node: 'a' });
  check(/size 2\.000 × 2\.000 × 2\.000 m/.test(before.txt) && /size 6\.000 × 6\.000 × 6\.000 m/.test(ins.txt), 'the followed package cooks from its working folder (an edit there shows here)');
  kitGraph.nodes.c.params.size = '=s * 4';
  fs.writeFileSync(path.join(kit, 'graphs', 'main.json'), JSON.stringify(kitGraph, null, 2));
  const ins2 = await call('inspect', { node: 'a' });
  check(/size 8\.000 × 8\.000 × 8\.000 m/.test(ins2.txt), 'a later edit there re-cooks it');
  const xf = await call('export', { path: 'exports/yard_followed.glb' });
  const frec = JSON.parse(fs.readFileSync(path.join(yard, 'exports', 'yard_followed.glb.source.json'), 'utf8')).source;
  check(!xf.isError && typeof frec.packages?.['studio/crates@working'] === 'string' && !frec.packages['studio/crates@1.0'], `an export while following records the working folder: ${JSON.stringify(frec.packages)}`);
  const blocked = await call('library', { action: 'publish', note: 'while following' });
  check(blocked.isError && /this session follows studio\/crates from its working folder/.test(blocked.txt), 'publishing while following is refused');
  const off = await call('library', { action: 'follow', package: 'studio/crates', on: false });
  check(!off.isError && /it resolves to its copy \(1\.0\) again/.test(off.txt), 'library follow on:false goes back to the copy');

  // out of date and Update: the kit publishes 1.1 (its crate four times the size since the edits above); the yard sees
  // it, looks at the before/after while it cooks, and updates once told to
  await call('library', { action: 'open', path: kit });
  const p11 = await call('library', { action: 'publish', note: 'four times the size' });
  check(!p11.isError && /✓ published studio\/crates 1\.1 \(small, after 1\.0\)/.test(p11.txt), `the kit publishes 1.1: ${p11.txt.split('\n')[0]}`);
  await call('library', { action: 'open', path: yard });
  const od = await call('library', { action: 'outdated' });
  check(!od.isError && /studio\/crates 1\.0: 1\.1 is out {2}\[library "game"\]\n {4}1\.1 {2}"four times the size"/.test(od.txt) && /\nlibrary \{action:"update", package:"studio\/crates"\} shows the before\/after of 1\.0 → 1\.1/.test(od.txt),
    `library outdated: ${od.txt.split('\n').slice(0, 3).join(' | ')}`);
  const pjBefore = fs.readFileSync(path.join(yard, 'project.json'), 'utf8');
  const steps: { progress: number; total?: number; message?: string }[] = [];
  const ba: any = await client.callTool({ name: 'library', arguments: { action: 'update', package: 'studio/crates' } }, undefined, { onprogress: (p) => steps.push(p) });
  const baText = ba.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
  const baImages = ba.content.filter((c: any) => c.type === 'image');
  check(!ba.isError && /^before\/after: studio\/crates 1\.0 → 1\.1 \(a small update\) in project yard; nothing has changed yet/.test(baText) && /\n {2}graphs\/main\.json {2}a: studio\/crates\/crate \{"s":2\}\n/.test(baText)
    && /\n {2}graphs\/main\.json {2}d: studio\/crates \{"s":0\.5\}\n/.test(baText) && /apply it only when they say so: library \{action:"update", package:"studio\/crates", from:"1\.0", to:"1\.1", apply:true\}/.test(baText),
    `library update shows the before/after:\n${baText.split('\n').slice(0, 6).join('\n')}`);
  check(baImages.length === 2 && baImages.every((x: any) => x.mimeType === 'image/png') && /overlay renders of the 2 places that changed, in order: graphs\/main\.json a, graphs\/main\.json d/.test(baText), `and an overlay render of each place that changed (${baImages.length})`);
  check(steps.length === 4 && steps.every((s, i) => s.progress === i && s.total === 4) && steps[0].message === 'graphs/main.json a with studio/crates 1.0', `progress notifications while it cooks (${steps.map((s) => `${s.progress}/${s.total}`).join(' ')})`);
  check(fs.readFileSync(path.join(yard, 'project.json'), 'utf8') === pjBefore && !fs.existsSync(path.join(yard, 'packages', 'studio', 'crates', '1.1')), 'the before/after writes nothing');
  if (baImages[0]) fs.writeFileSync(path.join(wsDir, 'update.png'), Buffer.from(baImages[0].data, 'base64'));
  const noTo = await call('library', { action: 'update', package: 'studio/crates', apply: true });
  check(noTo.isError && /apply:true needs "from" and "to": the version in use and the version of the before\/after the person saw/.test(noTo.txt), 'applying names the version whose before/after the person saw');
  const ap = await call('library', { action: 'update', package: 'studio/crates', from: '1.0', to: '1.1', apply: true });
  check(!ap.isError && /^updated studio\/crates 1\.0 → 1\.1 in project yard/.test(ap.txt) && JSON.parse(fs.readFileSync(path.join(yard, 'project.json'), 'utf8')).uses['studio/crates'] === '1.1'
    && fs.existsSync(path.join(yard, 'packages', 'studio', 'crates', '1.1', 'version.json')) && !fs.existsSync(path.join(yard, 'packages', 'studio', 'crates', '1.0')), `library update with apply:true applies it: ${ap.txt.split('\n')[0]}`);
  const grown = await call('inspect', { node: 'a' });
  check(/size 8\.000 × 8\.000 × 8\.000 m/.test(grown.txt), 'the graphs cook with the new version at once');
}

await client.close();

// a new workspace becomes a project when the server starts, named or not: the default one (no --workspace, no
// TOPOTOPO_WORKSPACE), <cwd>/workspace, which is not there yet, and a named folder that is empty
for (const named of [false, true]) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'topotopo-mcp-default-'));
  const dir = named ? fs.mkdtempSync(path.join(os.tmpdir(), 'topotopo-mcp-empty-')) : path.join(cwd, 'workspace');
  const own = new Client({ name: 'topotopo-test-new', version: '0.0.1' });
  await own.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'src/mcp/server.ts'), ...(named ? ['--workspace', dir] : [])], cwd, env: { ...getDefaultEnvironment(), TOPOTOPO_CONFIG: configFile }, stderr: 'pipe' }));
  const r: any = await own.callTool({ name: 'library', arguments: { action: 'packages' } });
  const txt = r.content.map((c: any) => c.text ?? '').join('\n');
  const pj = path.join(dir, 'project.json'), id = fs.existsSync(pj) ? JSON.parse(fs.readFileSync(pj, 'utf8')).id : null;
  const title = fs.existsSync(pj) ? JSON.parse(fs.readFileSync(pj, 'utf8')).title : null;
  check(!r.isError && !!id && new RegExp(`^project ${id} \\(.*\\)\\nuses no packages yet`).test(txt) && /became a project, ".*", when the server started/.test(txt) && (named || title === path.basename(cwd)),
    `${named ? 'a named empty folder' : 'the default workspace (named after the folder it is in)'} is made a project, and the first reply says so: ${txt.split('\n')[0]}`);
  const b: any = await own.callTool({ name: 'build', arguments: { graph: { nodes: { r: { type: 'topotopo/nature/rock', params: { size: 2 } } } } } });
  const bt = b.content.map((c: any) => c.text ?? '').join('\n');
  check(!b.isError && /✓ graph "main"/.test(bt) && new RegExp(`note: added topotopo/nature ${NV}`).test(bt), `its graphs use TopoTopo's own packages as they come: ${bt.split('\n')[0]}`);
  await own.close();
}
console.log(`\n${failures ? failures + ' FAILURES' : 'ALL PASSED'} — workspace ${wsDir}`);
process.exit(failures ? 1 : 0);
