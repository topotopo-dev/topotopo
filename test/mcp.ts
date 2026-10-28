// End-to-end MCP test: spawns the stdio server like a real client and exercises every tool.
//   node test/mcp.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { INPUTS_EXAMPLE } from '../src/mcp/docs.ts';

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
const call = async (name: string, args: any) => {
  const r: any = await client.callTool({ name, arguments: args });
  const txt = r.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
  const img = r.content.find((c: any) => c.type === 'image');
  return { r, txt, img, isError: !!r.isError };
};

const info = client.getServerVersion();
check(info?.name === 'topotopo', `server name ${info?.name}`);
check((client.getInstructions() ?? '').includes('WORKFLOW'), 'server instructions present');
const { tools } = await client.listTools();
check(tools.length >= 9, `tools: ${tools.map((t) => t.name).join(', ')}`);

const cat = await call('catalog', {});
check(cat.txt.includes('copy_to_points') && cat.txt.includes('[sdf]'), 'catalog lists nodes');
check(cat.txt.includes('[shelf]') && cat.txt.includes('wall_segment'), 'catalog lists the shelf assets');
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

const rnd = await call('render', { node: 'terrain', color_by: 'height', views: ['top', 'persp'] });
check(!!rnd.img, 'render tool image');
if (rnd.img) fs.writeFileSync(path.join(wsDir, 'render.png'), Buffer.from(rnd.img.data, 'base64'));
const ov = await call('render', { node: 'rocks', views: ['persp', 'section'], section_axis: 'x', wireframe: 'hard', glyphs: 'N', max_glyphs: 50, label_pieces: true, max_labels: 5, shading: 'matcap', size: 256 });
check(!!ov.img && !ov.isError && /overlays: shading matcap .*section x=.*wire hard>30/.test(ov.txt) && /label_pieces: first 5 of/.test(ov.txt), `render tool overlays: ${ov.txt.split('\n').find((l) => l.includes('overlays'))?.slice(0, 120)}`);
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
  check(!x.isError && s.frame === 3 && JSON.stringify(s.export) === '{"format":"obj","options":{"scale":100,"up_axis":"z"}}', 'the source records the frame and the export options given');
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
  check(bundleSource?.graph === 'ue' && bundleSource.export.format === 'unreal_landscape' && rowsSource?.node === 'inst' && JSON.stringify(rowsSource.export.options) === '{"pcg":true}'
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
    && /\{"type":"image_file","params":\{"path":"inputs\/maps\/heights\.png"\}\}/.test(dp.txt) && /an image "heights"/.test(dp.txt), 'inputs describe png (heightmap, mask, points and texture readings)');
  const dm = await call('inputs', { action: 'describe', path: 'guide.obj' });
  check(dm.isError && /did you mean guides\.obj/.test(dm.txt), 'inputs describe: unknown file with did-you-mean');

  // the help topic's example graph (as the LLM reads it) on a guides.glb exported into inputs/, the way a person drops one
  const help = await call('help', { topic: 'inputs' });
  const exText = /\n(\{"nodes": \{\n[\s\S]*?\n \}\})\n/.exec(help.txt)?.[1];
  const example = exText ? JSON.parse(exText) : null;
  check(!!example && JSON.stringify(example) === JSON.stringify(INPUTS_EXAMPLE) && help.txt.includes('@name=path.*') && help.txt.includes("s@role = s@role || @name.split('.')[0].toLowerCase();"),
    'help topic inputs: group pattern, role wrangle and the example graph');
  const dry = await call('build', { name: 'land', graph: example, dry_run: true });
  check(!dry.isError && /✓ valid: 15 nodes/.test(dry.txt), `help inputs example validates: ${dry.txt.split('\n')[0]}`);
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
  const upd = await call('library', { action: 'update', description: 'An oil barrel', bake: { frame: 1 } });
  check(!upd.isError && JSON.parse(fs.readFileSync(path.join(projDir, 'project.json'), 'utf8')).description === 'An oil barrel', "library update edits the open project's project.json");
  const bk = await call('library', { action: 'bake' });
  check(!bk.isError && !!bk.img && fs.existsSync(path.join(projDir, '.gallery', 'preview.glb')), 'library bake renders the previews and shows the thumbnail');
  const got = await call('library', { action: 'get', library: 'game', id: 'barrel', thumbnail: true });
  check(got.txt.includes('(open)') && got.txt.includes('main (shown)') && got.txt.includes('board: http://board.local/1') && !!got.img, 'library get: manifest, graphs, links, thumbnail');
  const back = await call('library', { action: 'open', path: wsDir });
  check(back.isError && back.txt.includes('no project.json'), 'open refuses a folder that is not a project');
  const found = await call('library', { action: 'list', query: 'barrel' });
  check(found.txt.includes('barrel (open)') && found.txt.includes('baked'), 'library list finds it by words, marks the open one and its status');
}

// packages: a project publishes a version of its package; another lists the library, uses it and cooks its output
{
  const kit = path.join(libDir, 'lib', 'kits', 'crates');
  await call('library', { action: 'create', library: 'game', path: 'kits/crates', title: 'Crates' });
  const named = await call('library', { action: 'update', package: 'studio/crates' });
  check(!named.isError && JSON.parse(fs.readFileSync(path.join(kit, 'project.json'), 'utf8')).package === 'studio/crates', 'library update names the package');
  await call('build', { graph: {
    nodes: { c: { type: 'box', params: { size: '=s' } }, peek: { type: 'sphere' } }, output: 'c',
    vars: { s: 1 }, params: { s: { type: 'float', min: 0.1, max: 5, label: 'Size' } },
    outputs: { crate: { node: 'c', label: 'Crate' }, peek: { node: 'peek', publish: false } },
  } });
  const noNote = await call('library', { action: 'publish' });
  check(noNote.isError && /a version needs a note/.test(noNote.txt), 'library publish needs a note');
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
  check(!listed.isError && /studio\/crates {2}1\.0 "first crates" {2}\[library "game"\]/.test(listed.txt) && /outputs: crate/.test(listed.txt), `library packages lists the packages in the project's libraries: ${listed.txt.split('\n').find((l) => l.includes('studio/crates'))}`);
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
  check(/size 2\.00 × 2\.00 × 2\.00/.test(before.txt) && /size 6\.00 × 6\.00 × 6\.00/.test(ins.txt), 'the followed package cooks from its working folder (an edit there shows here)');
  kitGraph.nodes.c.params.size = '=s * 4';
  fs.writeFileSync(path.join(kit, 'graphs', 'main.json'), JSON.stringify(kitGraph, null, 2));
  const ins2 = await call('inspect', { node: 'a' });
  check(/size 8\.00 × 8\.00 × 8\.00/.test(ins2.txt), 'a later edit there re-cooks it');
  const xf = await call('export', { path: 'exports/yard_followed.glb' });
  const frec = JSON.parse(fs.readFileSync(path.join(yard, 'exports', 'yard_followed.glb.source.json'), 'utf8')).source;
  check(!xf.isError && typeof frec.packages?.['studio/crates@working'] === 'string' && !frec.packages['studio/crates@1.0'], `an export while following records the working folder: ${JSON.stringify(frec.packages)}`);
  const blocked = await call('library', { action: 'publish', note: 'while following' });
  check(blocked.isError && /this session follows studio\/crates from its working folder/.test(blocked.txt), 'publishing while following is refused');
  const off = await call('library', { action: 'follow', package: 'studio/crates', on: false });
  check(!off.isError && /it resolves to its copy \(1\.0\) again/.test(off.txt), 'library follow on:false goes back to the copy');
}

await client.close();
console.log(`\n${failures ? failures + ' FAILURES' : 'ALL PASSED'} — workspace ${wsDir}`);
process.exit(failures ? 1 : 0);
