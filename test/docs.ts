// Docs staleness: docs/nodes.md must match what scripts/gen-docs.ts generates from the registry and the shelf, and the
// README's node table must list every node type (its "N+ node types" claim must hold).
//   node test/docs.ts
import fs from 'node:fs';
import path from 'node:path';
import { readNodesMd, referenceMarkdown } from '../scripts/gen-docs.ts';
import { allNodeDefs } from '../src/graph/registry.ts';
import { ROOT } from './fixtures.ts';

let fail = 0;
const want = await referenceMarkdown();
const have = readNodesMd();
if (have === want) console.log('docs: docs/nodes.md is up to date');
else {
  fail++;
  if (have === null) console.log('FAIL docs/nodes.md is missing: run npm run docs');
  else {
    const a = have.split('\n'), b = want.split('\n');
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    console.log(`FAIL docs/nodes.md is stale (node definitions changed): run npm run docs`);
    console.log(`  first difference at line ${i + 1}:`);
    console.log(`    file:      ${a[i] === undefined ? '(end of file)' : a[i].slice(0, 160)}`);
    console.log(`    generated: ${b[i] === undefined ? '(end of file)' : b[i].slice(0, 160)}`);
  }
}

// README: the "## Node types" table names every (non-deprecated) built-in node type in backticks
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').replace(/\r\n/g, '\n');
const a = readme.indexOf('\n## Node types'), b = readme.indexOf('\n## ', a + 1);
const defs = allNodeDefs().filter((d) => !d.deprecated);
if (a < 0) { fail++; console.log('FAIL README.md has no "## Node types" section'); }
else {
  const listed = new Set([...readme.slice(a, b < 0 ? undefined : b).matchAll(/`([A-Za-z0-9_]+)`/g)].map((m) => m[1]));
  const missing = defs.filter((d) => !listed.has(d.type)).map((d) => `${d.type} (${d.category})`);
  if (missing.length) { fail++; console.log(`FAIL README.md node table misses ${missing.length} node type(s): ${missing.join(', ')}`); }
  else console.log(`docs: README.md node table lists all ${defs.length} node types`);
}
for (const m of readme.matchAll(/(\d+)\+ node types/g))
  if (Number(m[1]) > defs.length) { fail++; console.log(`FAIL README.md claims "${m[0]}" but the registry has ${defs.length}`); }

process.exit(fail ? 1 : 0);
