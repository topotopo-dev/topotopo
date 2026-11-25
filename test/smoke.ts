// Smoke test: cook every node type with sensible inputs; check geometry invariants.
//   node test/smoke.ts [filter]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { allNodeDefs } from '../src/graph/registry.ts';
import { SKIP, checkGeo, createFixtureEngine, fixtureGraphFor } from './fixtures.ts';

const { engine, tmp } = await createFixtureEngine();

const filter = process.argv[2];
let fail = 0, pass = 0;
const rows: string[] = [];
for (const def of allNodeDefs()) {
  if (SKIP.has(def.type) || (filter && !def.type.includes(filter))) continue;
  const graph = fixtureGraphFor(def.type);
  const t0 = performance.now();
  let line: string;
  try {
    const r = await engine.cook(graph);
    const ms = performance.now() - t0;
    if (!r.ok || !r.geo) { fail++; line = `FAIL ${def.type}: ${r.errors.map((e) => `[${e.node}] ${e.message}`).join('; ')}`; }
    else {
      const errs = checkGeo(r.geo);
      if (errs.length) { fail++; line = `FAIL ${def.type}: invariants: ${errs.join(', ')}`; }
      else { pass++; line = `ok   ${def.type.padEnd(18)} ${ms.toFixed(0).padStart(5)}ms  ${r.geo.numPoints} pts ${r.geo.numPrims} prims${r.geo.volumes.length ? ` ${r.geo.volumes.length} vol` : ''}${r.warnings.length ? `  (warn: ${r.warnings[0].message.slice(0, 60)})` : ''}`; }
    }
  } catch (e: any) {
    fail++;
    line = `FAIL ${def.type}: threw ${e?.stack ?? e}`;
  }
  rows.push(line);
  console.log(line);
}

if (!filter) {
  const dir = path.join(tmp, 'cli'), graph = path.join(dir, 'parts.json');
  const exists = (file: string) => fs.existsSync(path.join(dir, 'exports', file));
  fs.mkdirSync(dir);
  const run = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../src/cli.ts'), ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, TOPOTOPO_HOME: path.join(dir, 'home'), TOPOTOPO_CONFIG: path.join(dir, 'config.json'),
      TOPOTOPO_CACHE: path.join(dir, 'cache'), TOPOTOPO_NODE_CACHE_DIR: path.join(dir, 'node-cache') },
  });
  const cli = (...args: string[]) => run(dir, ...args);
  const check = (ok: boolean, what: string, detail: string) => {
    if (ok) pass++; else fail++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : ` (${detail.trim().replace(/\r?\n/g, ' | ')})`}`);
  };
  const box = { type: 'box' }, guard = {
    type: 'assert', in: ['b'], params: { on_fail: 'error', label: 'Size guard', expr: 'false' },
  };
  fs.writeFileSync(path.join(dir, 'parts.topo'), JSON.stringify({ title: 'Parts', graph: 'parts' }));
  fs.writeFileSync(graph, JSON.stringify({
    nodes: { b: box, preview: guard, other: box }, output: 'b', export: 'glb',
    outputs: { preview: { node: 'preview', publish: false, export: 'glb' }, other: { node: 'other' } },
  }));
  const exports = cli(graph, '--export-all');
  check(exports.status === 0 && !exists('preview.glb') && !/preview/.test(exports.stdout + exports.stderr),
    '--export-all leaves an unrelated private output alone', `${exports.status}: ${exports.stdout}${exports.stderr}`);
  check(exports.status === 0 && exists('other.glb') && /other.*written.*default.*glb/i.test(exports.stdout),
    '--export-all uses the editor’s first fitting format for a targetless mesh', `${exports.status}: ${exports.stdout}${exports.stderr}`);
  const again = cli(graph, '--export-all');
  check(again.status === 0 && /parts.*unchanged.*kept/.test(again.stdout) && /other.*unchanged.*kept/.test(again.stdout),
    '--export-all keeps both unchanged outputs on the second run', `${again.status}: ${again.stdout}${again.stderr}`);
  fs.writeFileSync(graph, JSON.stringify({
    nodes: { b: box, guard, sdf: { type: 'sdf_shape' } }, output: 'b', export: 'glb',
    outputs: { guard: { node: 'guard', label: 'Guarded part', export: 'glb' }, implicit: { node: 'sdf' } },
  }));
  const failed = cli(graph, '--export-all');
  check(failed.status === 1 && /Guarded part.*FAILED.*Size guard/.test(failed.stdout) && /implicit.*FAILED.*no export target: add/.test(failed.stdout)
    && /^.*0 written, 1 unchanged, 2 failed.*$/m.test(failed.stdout) && !exists('guard.glb'),
  '--export-all reports a failed cook and a missing format, and counts each output', `${failed.status}: ${failed.stdout}${failed.stderr}`);

  const basic = path.join(dir, 'box.json');
  fs.writeFileSync(basic, JSON.stringify({ nodes: { b: box }, output: 'b' }));
  const help = cli('--help'), opening = help.stdout.split(/\r?\n/).slice(0, 8).join('\n');
  check(help.status === 0 && /init/.test(opening) && /--help-topic examples/.test(opening) && /init --example/.test(opening)
    && /--render/.test(opening) && /--export/.test(opening) && /\bedit\b/.test(opening) && /\bmcp\b/.test(opening),
  '--help starts with the first job', opening);
  const alias = cli('--help-node', 'heightfield_road');
  check(alias.status === 0 && /^heightfield_road is another name for heightfield_path\r?\n## heightfield_path/.test(alias.stdout),
    '--help-node resolves the road alias', alias.stdout + alias.stderr);
  const noPackage = run(fs.mkdtempSync(`${tmp}-loose-`), '--help-node', 'topotopo/architecture/house');
  check(/run (?:topotopo|node src\/cli\.ts) init <folder> first: only a package can use packages/.test(noPackage.stdout),
    'package help outside a package leads with init', noPackage.stdout.trimEnd().split(/\r?\n/).at(-1) ?? noPackage.stderr);
  const png = path.join(dir, 'out.png'), picture = cli(basic, '--views', 'persp', '--annotate', '--size', '1000x650', '--render', png);
  const header = fs.existsSync(png) ? fs.readFileSync(png).subarray(16, 24) : undefined;
  check(picture.status === 0 && /\(1000x650\)/.test(picture.stdout) && header?.readUInt32BE(0) === 1000 && header.readUInt32BE(4) === 650,
    '--size includes the footer in the PNG dimensions', picture.stdout + picture.stderr);
  const camera = cli(basic, '--from', '28 26 30', '--to', '0, 3 0', '--render', png);
  check(camera.status === 0 && /rendered /.test(camera.stdout), 'camera accepts PowerShell and mixed triples', camera.stdout + camera.stderr);
  const look = cli(basic, '--look-at', '0, 0 0', '--bounds', '-2 -2,-2 2,2 2', '--views', 'front', '--render', png);
  check(look.status === 0 && /rendered /.test(look.stdout), 'look-at and bounds accept mixed separators', look.stdout + look.stderr);
  const bad = cli(basic, '--from', '28,,30', '--to', '0 0 0', '--render', png);
  check(bad.status === 1 && /e\.g\. --from 6,1\.7,9/.test(bad.stderr), 'a bad camera triple gives a CLI example', bad.stderr);

  fs.writeFileSync(basic, '\uFEFF' + fs.readFileSync(basic, 'utf8'));
  const bom = cli(basic);
  check(bom.status === 0 && /cooked .*box\.json/.test(bom.stdout), 'a graph with a UTF-8 BOM cooks from the CLI', bom.stdout + bom.stderr);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
