// Text-first geometry introspection for LLMs: compact summaries, attribute statistics,
// topology health, and element listings.
import { Geometry } from './core/geometry.ts';
import type { AttribClass, Attribute } from './core/geometry.ts';
import { primArea, signedVolume, topologyReport } from './core/topology.ts';
import { evalGroup } from './core/groups.ts';
import { edgeList } from './core/edges.ts';
import { halfEdges } from './core/halfedge.ts';
import { fmtNum } from './render/raster.ts';
import { packedSummaryLine } from './core/packed.ts';
import { heightfieldSummary, volumeCounts } from './core/heightfield.ts';

const n = (x: number) => x.toLocaleString('en-US');
const v3 = (a: number[]) => `(${a.map(fmtNum).join(', ')})`;
const typeCode = (a: Attribute) => (a.isArray ? a.type : (a.type === 'float' ? 'f' : a.type === 'int' ? 'i' : 's') + a.size);

function fmtVal(v: any): string {
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '(' + v.map((x) => fmtNum(x)).join(', ') + ')';
  return fmtNum(v);
}

/** An array attribute's element as [a, b, …] (long arrays are cut after 16 entries). */
function fmtArr(v: any[], ints: boolean): string {
  const f = (x: any) => (typeof x === 'string' ? JSON.stringify(x) : ints ? String(x) : fmtNum(x));
  return '[' + v.slice(0, 16).map(f).join(', ') + (v.length > 16 ? `, … +${v.length - 16}` : '') + ']';
}

/** Value of element i of a, formatted (arrays in brackets, tuples in parentheses). */
const fmtAttr = (a: Attribute, i: number) => (a.isArray ? fmtArr(a.getArray(i), a.type === 'int[]') : fmtVal(a.get(i)));

/** Array length range and mean over the (selected) elements: "len 0–12, avg 4.1". */
function arrayLens(a: Attribute, count: number, sel?: Uint8Array | null): string {
  let lo = Infinity, hi = -Infinity, sum = 0, k = 0;
  for (let i = 0; i < count; i++) {
    if (sel && !sel[i]) continue;
    const n = a.arrayLength(i);
    if (n < lo) lo = n; if (n > hi) hi = n; sum += n; k++;
  }
  if (!k) return 'no elements';
  return `len ${lo === hi ? lo : `${lo}–${hi}`}, avg ${+(sum / k).toFixed(2)}`;
}

/** Stats of an array attribute: lengths, then entry range (numbers) or most frequent entries (strings). */
function arrayStats(a: Attribute, count: number, sel?: Uint8Array | null): string {
  const lens = arrayLens(a, count, sel);
  if (lens === 'no elements') return lens;
  a.compact();
  const o = a.offsets!, d = a.data;
  if (a.type === 'string[]') {
    const freq = new Map<string, number>();
    for (let i = 0; i < count; i++) if (!sel || sel[i]) for (let k = o[i]; k < o[i + 1]; k++) freq.set((d as string[])[k], (freq.get((d as string[])[k]) ?? 0) + 1);
    const top = [...freq].sort((x, y) => y[1] - x[1]).slice(0, 8).map(([s, c]) => `${JSON.stringify(s)}×${c}`);
    return `${lens}; ${freq.size} unique entries${top.length ? ': ' + top.join(', ') : ''}${freq.size > 8 ? ', …' : ''}`;
  }
  let mn = Infinity, mx = -Infinity, sum = 0, k = 0;
  for (let i = 0; i < count; i++) if (!sel || sel[i]) for (let j = o[i]; j < o[i + 1]; j++) {
    const x = (d as Float64Array)[j];
    if (!Number.isFinite(x)) continue;
    if (x < mn) mn = x; if (x > mx) mx = x; sum += x; k++;
  }
  const f = (x: number) => (a.type === 'int[]' ? String(x) : fmtNum(x));
  return k ? `${lens}; entries min ${f(mn)} max ${f(mx)} mean ${fmtNum(sum / k)}` : `${lens}; no entries`;
}

export function summarize(g: Geometry): string {
  const lines: string[] = [];
  let polys = 0, lines_ = 0, tris = 0, quads = 0, packed = 0;
  for (let p = 0; p < g.numPrims; p++) {
    if (g.primKind && g.primKind[p]) packed++;
    else if (g.primClosed[p]) { polys++; const s = g.primSize(p); if (s === 3) tris++; else if (s === 4) quads++; } else lines_++;
  }
  const parts = [`${n(g.numPoints)} points`, `${n(g.numPrims)} prims`];
  const kinds: string[] = [];
  if (polys) kinds.push(`${n(polys)} polygons (${n(tris)} tri, ${n(quads)} quad, ${n(polys - tris - quads)} ngon)`);
  if (lines_) kinds.push(`${n(lines_)} polylines`);
  if (packed) kinds.push(`${n(packed)} packed`);
  lines.push(`geometry: ${parts.join(', ')}${kinds.length ? ' = ' + kinds.join(' + ') : ''}, ${n(g.numVertices)} vertices${g.volumes.length ? `, ${volumeCounts(g)}` : ''}`);
  const pk = packedSummaryLine(g);
  if (pk) lines.push(pk);
  lines.push(...heightfieldSummary(g));
  if (g.numPoints || g.volumes.length) {
    const b = g.bbox(true);
    const size = [0, 1, 2].map((a) => b.max[a] - b.min[a]);
    lines.push(`bbox: min ${v3(b.min)} max ${v3(b.max)} size ${size.map(fmtNum).join(' × ')} center ${v3([0, 1, 2].map((a) => (b.min[a] + b.max[a]) / 2))}`);
  }
  const attrLines: string[] = [];
  for (const cls of ['point', 'vertex', 'prim', 'detail'] as AttribClass[]) {
    const t = g.table(cls);
    if (!t.map.size) continue;
    const items = [...t.map].map(([k, a]) => {
      if (cls === 'detail') return `${k} ${typeCode(a)} = ${fmtAttr(a, 0)}`;
      if (a.isArray) return `${k} ${a.type} (${arrayLens(a, t.count)})`;
      if (a.type === 'string') { const u = new Set(a.data as string[]); return `${k} s (${u.size} unique)`; }
      return `${k} ${typeCode(a)}`;
    });
    attrLines.push(`  ${cls}: ${items.join(', ')}`);
  }
  if (attrLines.length) lines.push('attributes:', ...attrLines);
  const grp: string[] = [];
  for (const cls of ['point', 'prim', 'vertex'] as const) {
    const m = g.groups(cls);
    if (!m.size) continue;
    grp.push(`${cls}[${[...m].map(([k, mask]) => `${k} ${n(mask.reduce((s, x) => s + x, 0))}`).join(', ')}]`);
  }
  if (g.edgeGroups.size) grp.push(`edge[${[...g.edgeGroups].map(([k, set]) => `${k} ${n(set.size)}`).join(', ')}]`);
  if (grp.length) lines.push(`groups: ${grp.join('  ')}`);
  return lines.join('\n');
}

function attribStats(a: Attribute, count: number, sel?: Uint8Array | null): string {
  if (a.isArray) return arrayStats(a, count, sel);
  if (a.type === 'string') {
    const freq = new Map<string, number>();
    for (let i = 0; i < count; i++) if (!sel || sel[i]) freq.set((a.data as string[])[i], (freq.get((a.data as string[])[i]) ?? 0) + 1);
    const top = [...freq].sort((x, y) => y[1] - x[1]).slice(0, 8).map(([k, c]) => `${JSON.stringify(k)}×${c}`);
    return `${freq.size} unique: ${top.join(', ')}${freq.size > 8 ? ', …' : ''}`;
  }
  const s = a.size, d = a.data as Float64Array;
  const mn = new Array(s).fill(Infinity), mx = new Array(s).fill(-Infinity), sum = new Array(s).fill(0);
  let k = 0, nan = 0;
  for (let i = 0; i < count; i++) {
    if (sel && !sel[i]) continue;
    k++;
    for (let c = 0; c < s; c++) {
      const x = d[i * s + c];
      if (!Number.isFinite(x)) { nan++; continue; }
      if (x < mn[c]) mn[c] = x; if (x > mx[c]) mx[c] = x; sum[c] += x;
    }
  }
  if (!k) return 'no elements';
  const f = (arr: number[]) => (s === 1 ? fmtNum(arr[0]) : v3(arr));
  let extra = '';
  if (a.type === 'int' && s === 1) {
    const u = new Set<number>();
    for (let i = 0; i < count && u.size < 1000; i++) if (!sel || sel[i]) u.add(d[i]);
    extra = `, ${u.size >= 1000 ? '1000+' : u.size} unique`;
  }
  return `min ${f(mn)} max ${f(mx)} mean ${f(sum.map((x) => x / k))}${extra}${nan ? `, ${nan} NaN/inf` : ''}`;
}

export interface InspectOptions {
  detail?: 'summary' | 'attributes' | 'topology' | 'elements' | 'all';
  cls?: 'point' | 'prim' | 'vertex' | 'detail' | 'edge';
  attribs?: string[];
  start?: number;
  count?: number;
  group?: string;
}

export function inspect(g: Geometry, o: InspectOptions = {}): string {
  const out: string[] = [summarize(g)];
  const detail = o.detail ?? 'summary';
  const sel = o.group && (o.cls === 'point' || o.cls === 'prim' || o.cls === 'vertex') ? evalGroup(g, o.cls, o.group) : null;
  if (detail === 'attributes' || detail === 'all') {
    out.push('attribute stats:');
    for (const cls of ['point', 'vertex', 'prim', 'detail'] as AttribClass[]) {
      if (o.cls && o.cls !== cls) continue;
      const t = g.table(cls);
      for (const [k, a] of t.map) {
        if (o.attribs && !o.attribs.includes(k)) continue;
        out.push(`  ${cls} ${k} ${typeCode(a)}: ${cls === 'detail' ? fmtAttr(a, 0) : attribStats(a, t.count, cls === o.cls ? sel : null)}`);
      }
    }
  }
  if (detail === 'topology' || detail === 'all') {
    const r = topologyReport(g);
    out.push('topology:');
    out.push(`  ${r.closed ? 'CLOSED manifold surface (watertight)' : `open/non-manifold: ${r.boundaryEdges} boundary edges, ${r.nonManifoldEdges} non-manifold edges`}`);
    out.push(`  ${r.pieces} connected piece(s); ${r.edges} edges; ${r.degenerate} degenerate prims; ${r.unusedPoints} unused points`);
    const flipped = halfEdges(g).flippedEdges.size;
    if (flipped) out.push(`  ${flipped} edge(s) with inconsistent winding between neighbouring polygons (use reverse on part of the mesh or clean fix_winding)`);
    let area = 0;
    for (let p = 0; p < g.numPrims; p++) area += primArea(g, p);
    out.push(`  surface area ${fmtNum(area)}${r.closed ? `; volume ${fmtNum(signedVolume(g))}${signedVolume(g) < 0 ? ' (NEGATIVE: faces point inward — use reverse)' : ''}` : ''}`);
    if (r.closed && r.pieces === 1) out.push(`  euler ${r.euler} → genus ${(2 - r.euler) / 2}`);
  }
  if ((detail === 'elements' || detail === 'all') && o.cls === 'edge') out.push(...edgeElements(g, o));
  else if (detail === 'elements' || detail === 'all') {
    const cls = (o.cls ?? 'point') as AttribClass;
    const t = g.table(cls);
    const total = cls === 'detail' ? 1 : t.count;
    const start = Math.max(0, o.start ?? 0), count = Math.min(o.count ?? 10, 200);
    const names = [...t.map.keys()].filter((k) => !o.attribs || o.attribs.includes(k));
    out.push(`${cls} elements ${start}..${Math.min(total, start + count) - 1} of ${total}${o.group ? ` (group ${o.group})` : ''}:`);
    let shown = 0;
    for (let i = start; i < total && shown < count; i++) {
      if (sel && !sel[i]) continue;
      const vals = names.map((k) => `${k}=${fmtAttr(t.get(k)!, i)}`);
      if (cls === 'prim' && g.isPacked(i)) {
        const X = g.packedXform!, o9 = i * 9;
        vals.unshift(`packed pt ${g.primPoints(i)[0]} source ${g.packedSource![i]} xform[${Array.from({ length: 9 }, (_, k) => fmtNum(X[o9 + k])).join(' ')}]`);
      } else if (cls === 'prim') vals.unshift(`${g.primClosed[i] ? 'poly' : 'line'} pts[${g.primPoints(i).slice(0, 12).join(' ')}${g.primSize(i) > 12 ? ' …' : ''}]`);
      if (cls === 'vertex') vals.unshift(`pt ${g.vertexPoint[i]}`);
      out.push(`  ${i}: ${vals.join('  ')}`);
      shown++;
    }
  }
  return out.join('\n');
}

/** Edge listing: index, point pair, length, polygon count, dihedral angle, edge groups. */
function edgeElements(g: Geometry, o: InspectOptions): string[] {
  const L = edgeList(g);
  const sel = o.group ? evalGroup(g, 'edge', o.group, L) : null;
  const he = halfEdges(g);
  const start = Math.max(0, o.start ?? 0), count = Math.min(o.count ?? 10, 200);
  const out = [`edge elements ${start}..${Math.min(L.count, start + count) - 1} of ${L.count}${o.group ? ` (group ${o.group})` : ''}:`];
  const groups = [...g.edgeGroups];
  let shown = 0;
  for (let i = start; i < L.count && shown < count; i++) {
    if (sel && !sel[i]) continue;
    const a = L.a[i], b = L.b[i], e = he.edgeId(a, b);
    const P = g.P, len = Math.hypot(P[a * 3] - P[b * 3], P[a * 3 + 1] - P[b * 3 + 1], P[a * 3 + 2] - P[b * 3 + 2]);
    const ang = e >= 0 ? he.dihedralAngle(e) : NaN;
    const inG = groups.filter(([, s]) => s.has(a, b)).map(([k]) => k);
    out.push(`  ${i}: p${a}-${b}  length=${fmtNum(len)}  polys=${L.polyCount[i]}${Number.isFinite(ang) ? `  angle=${fmtNum(ang)}` : ''}${inG.length ? `  groups=${inG.join(',')}` : ''}`);
    shown++;
  }
  return out;
}
