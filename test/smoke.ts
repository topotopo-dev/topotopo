// Smoke test: cook every node type with sensible inputs; check geometry invariants.
//   node test/smoke.ts [filter]
import { allNodeDefs } from '../src/graph/registry.ts';
import { SKIP, checkGeo, createFixtureEngine, fixtureGraphFor } from './fixtures.ts';

const { engine } = await createFixtureEngine();

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
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
