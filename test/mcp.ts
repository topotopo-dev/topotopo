// End-to-end MCP test: spawns the stdio server like a real client and exercises every tool.
//   node test/mcp.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polyforge-mcp-'));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, 'src/mcp/server.ts'), '--workspace', wsDir],
  stderr: 'pipe',
});
const client = new Client({ name: 'polyforge-test', version: '0.0.1' });
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
check(info?.name === 'polyforge', `server name ${info?.name}`);
check((client.getInstructions() ?? '').includes('WORKFLOW'), 'server instructions present');
const { tools } = await client.listTools();
check(tools.length >= 9, `tools: ${tools.map((t) => t.name).join(', ')}`);

const cat = await call('catalog', {});
check(cat.txt.includes('copy_to_points') && cat.txt.includes('[sdf]'), 'catalog lists nodes');
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

for (const fmt of ['glb', 'obj', 'usda', 'ply', 'stl', 'json']) {
  const x = await call('export', { path: `exports/scene.${fmt}` });
  check(!x.isError && fs.existsSync(path.join(wsDir, 'exports', `scene.${fmt}`)), `export ${fmt}: ${x.txt.split('\n')[0].slice(0, 90)}`);
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

await client.close();
console.log(`\n${failures ? failures + ' FAILURES' : 'ALL PASSED'} — workspace ${wsDir}`);
process.exit(failures ? 1 : 0);
