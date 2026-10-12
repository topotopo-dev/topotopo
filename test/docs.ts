// Docs staleness: docs/nodes.md must match what scripts/gen-docs.ts generates from the registry.
//   node test/docs.ts
import { readNodesMd, renderNodeReference } from '../scripts/gen-docs.ts';

const want = renderNodeReference();
const have = readNodesMd();
if (have === want) {
  console.log('docs: docs/nodes.md is up to date');
  process.exit(0);
}
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
process.exit(1);
