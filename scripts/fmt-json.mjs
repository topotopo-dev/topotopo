// Pretty-print graph JSON compactly: short objects and number arrays stay on one line.
//   node scripts/fmt-json.mjs examples/*.json
import fs from 'node:fs';
const prim = (x) => x === null || typeof x !== 'object';
function fmt(v, ind = '') {
  const n = ind + '  ';
  if (Array.isArray(v)) {
    if (v.every(prim) || v.every((x) => Array.isArray(x) && x.every(prim))) return '[' + v.map((x) => (Array.isArray(x) ? '[' + x.map((y) => JSON.stringify(y)).join(', ') + ']' : JSON.stringify(x))).join(', ') + ']';
    return '[\n' + v.map((x) => n + fmt(x, n)).join(',\n') + '\n' + ind + ']';
  }
  if (v && typeof v === 'object') {
    const ks = Object.keys(v);
    if (!ks.length) return '{}';
    const inline = '{ ' + ks.map((k) => JSON.stringify(k) + ': ' + fmt(v[k], n)).join(', ') + ' }';
    if (inline.length < 100 && !inline.includes('\n') && !ks.some((k) => k === 'nodes' || k === 'body')) return inline;
    return '{\n' + ks.map((k) => n + JSON.stringify(k) + ': ' + fmt(v[k], n)).join(',\n') + '\n' + ind + '}';
  }
  return JSON.stringify(v);
}
for (const f of process.argv.slice(2)) fs.writeFileSync(f, fmt(JSON.parse(fs.readFileSync(f, 'utf8'))) + '\n');
