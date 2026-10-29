// Text-first geometry introspection for LLMs: compact summaries, attribute statistics,
// topology health, and element listings.
//   summarize(g)        the short block every cook report carries (counts, bbox in metres to the millimetre, one images
//                       line, attributes, groups)
//   detail "summary"    one screen: counts and triangles, bbox, parts, materials and their maps, images, uv state,
//                       closed or open (after welding seam splits)
//   detail "budget"     triangles per part (prim "name", what each exported mesh holds) split per LOD (_lodN names),
//                       and per node (what each node adds), sorted, with totals
//   detail "attributes" adds the attribute statistics and each image's layer ranges
import { Geometry } from './core/geometry.ts';
import type { AttribClass, Attribute } from './core/geometry.ts';
import { primArea, signedVolume, topologyReport, triangleReport } from './core/topology.ts';
import { evalGroup } from './core/groups.ts';
import { edgeList } from './core/edges.ts';
import { halfEdges } from './core/halfedge.ts';
import { fmtNum } from './render/raster.ts';
import { expandedTriangles, packedSummaryLine } from './core/packed.ts';
import { packedSourceNames } from './io/common.ts';
import { primMaterials, readMaterials } from './core/materials.ts';
import { lodOf } from './core/uvreport.ts';
import { heightfieldSummary, volumeCounts } from './core/heightfield.ts';
import { imageSummary, imagesOf } from './core/image.ts';
import { sdfGridSummary } from './core/sdfgrid.ts';
import { uvReport, uvReportText } from './core/uvreport.ts';
import { openEdgesText, partsOf, primWhere, solidCauses, solidReport } from './core/report.ts';

const n = (x: number) => x.toLocaleString('en-US');
const v3 = (a: number[]) => `(${a.map(fmtNum).join(', ')})`;
/** metres to the millimetre */
const mm = (x: number) => (Number.isFinite(x) ? (Math.abs(x) < 5e-4 ? 0 : x).toFixed(3) : String(x));
const v3mm = (a: number[]) => `(${a.map(mm).join(', ')})`;
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
  let polys = 0, lines_ = 0, tris = 0, quads = 0, packed = 0, bezier = 0, nurbs = 0;
  for (let p = 0; p < g.numPrims; p++) {
    const k = g.primKind ? g.primKind[p] : 0;
    if (k === 1) packed++;
    else if (k === 2) bezier++;
    else if (k === 3) nurbs++;
    else if (g.primClosed[p]) { polys++; const s = g.primSize(p); if (s === 3) tris++; else if (s === 4) quads++; } else lines_++;
  }
  const parts = [`${n(g.numPoints)} points`, `${n(g.numPrims)} prims`];
  const kinds: string[] = [];
  if (polys) kinds.push(`${n(polys)} polygons (${n(tris)} tri, ${n(quads)} quad, ${n(polys - tris - quads)} ngon)`);
  if (lines_) kinds.push(`${n(lines_)} polylines`);
  if (packed) kinds.push(`${n(packed)} packed`);
  if (bezier) kinds.push(`${n(bezier)} Bezier curve${bezier === 1 ? '' : 's'}`);
  if (nurbs) kinds.push(`${n(nurbs)} NURBS curve${nurbs === 1 ? '' : 's'}`);
  lines.push(`geometry: ${parts.join(', ')}${kinds.length ? ' = ' + kinds.join(' + ') : ''}, ${n(g.numVertices)} vertices${g.volumes.length ? `, ${volumeCounts(g)}` : ''}`);
  const pk = packedSummaryLine(g);
  if (pk) lines.push(pk);
  lines.push(...heightfieldSummary(g));
  lines.push(...sdfGridSummary(g));
  const im = imagesLine(g);
  if (im) lines.push(im);
  const bb = bboxLine(g);
  if (bb) lines.push(bb);
  const attrLines: string[] = [];
  for (const cls of ['point', 'vertex', 'prim', 'detail'] as AttribClass[]) {
    const t = g.table(cls);
    if (!t.map.size) continue;
    const items = [...t.map].map(([k, a]) => {
      if (cls === 'detail') {
        // the summary stays readable: long values (e.g. the materials JSON) are cut; detail "attributes" shows them whole
        const v = fmtAttr(a, 0);
        return `${k} ${typeCode(a)} = ${v.length > 120 ? `${v.slice(0, 100)}… (${v.length} chars)` : v}`;
      }
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

/** One line for the images: name, size and layers of each (inspect detail "attributes" gives each layer's range). */
export function imagesLine(g: Geometry, max = 8): string | null {
  const imgs = imagesOf(g);
  if (!imgs.length) return null;
  const one = (img: (typeof imgs)[number]) => `"${img.name}" ${img.width}×${img.height}${img.layers.size > 1 ? ` ${[...img.layers.keys()].join('+')}` : ''}`;
  return `images (${imgs.length}): ${imgs.slice(0, max).map(one).join(', ')}${imgs.length > max ? `, … ${imgs.length - max} more` : ''}`;
}

/** The bbox in metres to the millimetre: min, max, size, centre. */
export function bboxLine(g: Geometry): string | null {
  if (!(g.numPoints || g.volumes.some((v) => v.kind !== 'image'))) return null;
  const b = g.bbox(true);
  const size = [0, 1, 2].map((a) => b.max[a] - b.min[a]);
  return `bbox: min ${v3mm(b.min)} max ${v3mm(b.max)} size ${size.map(mm).join(' × ')} m, center ${v3mm([0, 1, 2].map((a) => (b.min[a] + b.max[a]) / 2))}`;
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
  /**
   * 'summary' (default): one screen; 'uv': the structured uv report (core/uvreport.ts); 'budget': triangles per part,
   * LOD and node (budget.nodes gives the per-node rows); 'uv' and 'budget' are not part of 'all'. The export's scene
   * (detail "scene") needs the export itself: io/inspect-scene.ts.
   */
  detail?: 'summary' | 'attributes' | 'topology' | 'elements' | 'all' | 'uv' | 'budget';
  cls?: 'point' | 'prim' | 'vertex' | 'detail' | 'edge';
  attribs?: string[];
  start?: number;
  count?: number;
  group?: string;
  /** detail 'uv': uv attribute (default "uv"), texture size for texel density, and the report as JSON after the text */
  uvAttrib?: string;
  uvResolution?: number | [number, number];
  json?: boolean;
  /** detail 'budget': the cooked nodes upstream of the result (nodeBudgetInput), for the per-node rows */
  nodes?: NodeBudgetInput[];
}

export function inspect(g: Geometry, o: InspectOptions = {}): string {
  const detail = o.detail ?? 'summary';
  if (detail === 'summary') return summaryLines(g).join('\n');
  const out: string[] = [summarize(g)];
  if (detail === 'budget') {
    const b = budgetReport(g, o.nodes);
    out.push(...budgetText(b));
    if (o.json) out.push('budget (JSON):', JSON.stringify(b));
    return out.join('\n');
  }
  const sel = o.group && (o.cls === 'point' || o.cls === 'prim' || o.cls === 'vertex') ? evalGroup(g, o.cls, o.group) : null;
  if (detail === 'attributes' || detail === 'all') {
    out.push(...imageSummary(g));
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
  if (detail === 'topology' || detail === 'all') out.push('topology:', ...topologyLines(g));
  if (detail === 'uv') {
    const r = uvReport(g, { attribute: o.uvAttrib, resolution: o.uvResolution });
    out.push(...uvReportText(r));
    if (o.json) out.push('uv report (JSON):', JSON.stringify(r));
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
      } else if (cls === 'prim' && g.isSpline(i)) {
        const oa = g.prims.get('spline_order');
        vals.unshift(`${g.primKind![i] === 2 ? 'bezier' : 'nurbs'}${g.primClosed[i] ? ' closed' : ''} order ${oa ? Number(oa.get(i)) : 4} cvs[${g.primPoints(i).slice(0, 12).join(' ')}${g.primSize(i) > 12 ? ' …' : ''}]`);
      } else if (cls === 'prim') vals.unshift(`${g.primClosed[i] ? 'poly' : 'line'} pts[${g.primPoints(i).slice(0, 12).join(' ')}${g.primSize(i) > 12 ? ' …' : ''}]`);
      if (cls === 'vertex') vals.unshift(`pt ${g.vertexPoint[i]}`);
      out.push(`  ${i}: ${vals.join('  ')}`);
      shown++;
    }
  }
  return out.join('\n');
}

/**
 * One screen: counts with the triangles export and render draw, bbox in metres to the millimetre, parts (prim "name"),
 * materials with their maps, images, the uv state (charts, in-tile overlap, outside 0..1, tiling, utilization) and
 * whether it is a closed solid (open edges after welding seam splits), then attributes and groups.
 */
export function summaryLines(g: Geometry): string[] {
  const short = summarize(g).split('\n');
  const out: string[] = [];
  const tris = expandedTriangles(g);
  out.push(short[0] + (tris ? `; ${n(tris)} triangles` : ''));
  out.push(...short.slice(1).filter((l) => !l.startsWith('attributes:') && !l.startsWith('  ') && !l.startsWith('groups:')));
  const na = g.prims.get('name');
  if (na && na.type === 'string' && g.numPrims) {
    const by = new Map<string, number>();
    for (let p = 0; p < g.numPrims; p++) { const k = String(na.get(p) ?? ''); by.set(k, (by.get(k) ?? 0) + 1); }
    const list = [...by].sort((x, y) => y[1] - x[1]);
    out.push(`parts (prim "name", ${list.length}): ${list.slice(0, 10).map(([k, c]) => `"${k}" ${n(c)}`).join(', ')}${list.length > 10 ? `, … ${list.length - 10} more` : ''}`);
  }
  const table = readMaterials(g), pm = primMaterials(g);
  if (pm || Object.keys(table).length) {
    const count = new Map<string, number>();
    if (pm) for (let p = 0; p < g.numPrims; p++) count.set(pm[p], (count.get(pm[p]) ?? 0) + 1);
    const names = [...new Set([...Object.keys(table), ...count.keys()])].filter((k) => k !== '').sort();
    const one = (k: string) => {
      const m = table[k];
      const maps = m?.textures ? Object.entries(m.textures).filter(([, v]) => !!v).map(([t]) => t) : [];
      return `${k} (${n(count.get(k) ?? 0)} prims${m ? '' : ', not in the table'}${maps.length ? `; maps ${maps.join(', ')}` : ''})`;
    };
    out.push(`materials (${names.length}): ${names.slice(0, 8).map(one).join(', ')}${names.length > 8 ? `, … ${names.length - 8} more` : ''}`);
  }
  // uv state, bounded so a summary stays quick
  const uvA = g.findAttrib('uv', ['vertex', 'point']);
  if (uvA && g.numPrims) {
    const r = uvReport(g, { maxPairTests: 500_000, maxExamples: 1 });
    const ov = r.overlap;
    out.push(`uv: ${n(r.charts)} charts${r.tiling ? `, TILING (${n(r.tilingCharts)} charts run across tile borders)` : ''}; in-tile overlap ${n(ov.inTile.pairs)} pairs${ov.inTile.pairs && ov.examples[0] ? ` (first ${ov.examples[0].where[0]})` : ''}${ov.acrossLods.pairs ? `, across LODs ${n(ov.acrossLods.pairs)}` : ''}; ${n(r.outOfTile)} triangles outside 0..1; ${n(r.collapsed)} collapsed; utilization ${(r.utilization.value * 100).toFixed(1)}%${r.utilization.method === 'raster-estimate' ? ' (estimate)' : ''}${r.complete ? '' : ' (INCOMPLETE: inspect detail "uv")'}`);
  } else if (g.numPrims) out.push('uv: none');
  if (g.numPrims && g.primClosed.some((c) => c === 1)) {
    const sr = solidReport(g, { flips: false });
    out.push(`topology: ${sr.closedAfterWeld ? (sr.closed ? 'closed solid' : 'closed solid after welding seam splits') : 'NOT a closed solid'}; ${openEdgesText(sr)}${sr.openEdges ? `, first ${sr.firstOpen}` : ''}${sr.nonManifoldEdges ? `; ${n(sr.nonManifoldEdges)} non-manifold edges` : ''}; ${n(sr.pieces)} piece(s)`);
  }
  out.push(...short.filter((l) => l.startsWith('attributes:') || l.startsWith('  ') || l.startsWith('groups:')));
  return out;
}

/** A cooked node for the per-node budget: its name, type, output and the nodes it reads. */
export interface NodeBudgetInput { node: string; type: string; geo: Geometry | null; inputs: string[] }

export interface BudgetPart { name: string; lod: number; triangles: number; prims: number; instances: number }
export interface BudgetLod { lod: number; triangles: number; parts: BudgetPart[] }
export interface BudgetNode { node: string; type: string; triangles: number; added: number }
export interface BudgetReport {
  /** triangles drawn: polygons (fan split) plus the triangles of packed instances, expanded */
  triangles: number;
  polygonTriangles: number;
  instanceTriangles: number;
  instances: number;
  /** by prim "name" (what each exported mesh holds), largest first; instances by their packed prim "name" or source */
  parts: BudgetPart[];
  /** the parts by LOD when names carry a _lodN suffix (lod -1: names without one), LOD 0 first */
  lods: BudgetLod[];
  /** per node upstream of the result: its triangles and what it adds over its inputs, largest addition first */
  nodes: BudgetNode[];
}

/** Triangle budget: per part, per LOD and per node (see BudgetReport). */
export function budgetReport(g: Geometry, nodes: NodeBudgetInput[] = []): BudgetReport {
  const na = g.prims.get('name');
  const nameOf = (p: number) => (na && na.type === 'string' ? String(na.get(p) ?? '') : '');
  const by = new Map<string, BudgetPart>();
  const part = (name: string) => { let x = by.get(name); if (!x) by.set(name, (x = { name, lod: lodOf(name), triangles: 0, prims: 0, instances: 0 })); return x; };
  let polyT = 0, instT = 0, instances = 0;
  const srcNames = g.hasPacked() ? packedSourceNames(g) : [];
  const srcTris = g.hasPacked() ? g.packedSources.map(expandedTriangles) : [];
  for (let p = 0; p < g.numPrims; p++) {
    const k = g.primKind ? g.primKind[p] : 0;
    if (k === 1) {
      const t = srcTris[g.packedSource![p]] ?? 0, x = part(nameOf(p) || `instances of ${srcNames[g.packedSource![p]] ?? 'a source'}`);
      x.triangles += t; x.instances++; instT += t; instances++;
      continue;
    }
    if (k || !g.primClosed[p]) continue;
    const sz = g.primSize(p);
    if (sz < 3) continue;
    const x = part(nameOf(p));
    x.triangles += sz - 2; x.prims++; polyT += sz - 2;
  }
  const parts = [...by.values()].filter((x) => x.triangles > 0 || x.prims > 0).sort((x, y) => y.triangles - x.triangles || (x.name < y.name ? -1 : 1));
  const lodSet = [...new Set(parts.map((x) => x.lod))].sort((a, b) => (a < 0 ? 1 : b < 0 ? -1 : a - b));
  const lods = parts.some((x) => x.lod >= 0) ? lodSet.map((lod) => { const ps = parts.filter((x) => x.lod === lod); return { lod, triangles: ps.reduce((s, x) => s + x.triangles, 0), parts: ps }; }) : [];
  // per node: its triangles, minus those of the inputs it reads
  const tris = new Map<string, number>();
  for (const x of nodes) if (x.geo) tris.set(x.node, expandedTriangles(x.geo));
  // nodes whose output draws no triangles (bakes, images, points) are not part of the mesh budget
  const rows: BudgetNode[] = nodes.filter((x) => x.geo && (tris.get(x.node) ?? 0) > 0).map((x) => {
    const t = tris.get(x.node) ?? 0, inT = x.inputs.reduce((s, i) => s + (tris.get(i) ?? 0), 0);
    return { node: x.node, type: x.type, triangles: t, added: t - inT };
  }).sort((a, b) => b.added - a.added || (a.node < b.node ? -1 : 1));
  return { triangles: polyT + instT, polygonTriangles: polyT, instanceTriangles: instT, instances, parts, lods, nodes: rows };
}

/** The budget as text: totals, parts (per LOD when names carry one), nodes. */
export function budgetText(b: BudgetReport): string[] {
  const out = [`budget: ${n(b.triangles)} triangles${b.instances ? ` (${n(b.polygonTriangles)} in polygons + ${n(b.instanceTriangles)} in ${n(b.instances)} packed instances, expanded)` : ''}`];
  const pct = (x: number, of: number) => (of ? `${((x / of) * 100).toFixed(1)}%` : '-');
  const w = Math.min(40, Math.max(8, ...b.parts.map((x) => (x.name || '(no name)').length)));
  const row = (x: BudgetPart, of: number) => `    ${(x.name || '(no name)').padEnd(w)} ${n(x.triangles).padStart(10)}  ${pct(x.triangles, of).padStart(6)}${x.instances ? `  (${n(x.instances)} instances)` : ''}`;
  if (!b.parts.length) out.push('  no polygons');
  else if (b.lods.length) {
    out.push(`by part (prim "name": each exports as its own mesh), per LOD:`);
    const lod0 = b.lods.find((l) => l.lod === 0);
    for (const l of b.lods) {
      out.push(`  ${l.lod >= 0 ? `LOD ${l.lod}` : 'no LOD suffix'}: ${n(l.triangles)} triangles${l.lod > 0 && lod0 ? ` (${pct(l.triangles, lod0.triangles)} of LOD 0)` : ''}, ${l.parts.length} part(s)`);
      for (const x of l.parts.slice(0, 30)) out.push(row(x, l.triangles));
      if (l.parts.length > 30) out.push(`    … ${l.parts.length - 30} more`);
    }
  } else {
    out.push(`by part (prim "name": each exports as its own mesh), ${b.parts.length} part(s):`);
    for (const x of b.parts.slice(0, 40)) out.push(row(x, b.triangles));
    if (b.parts.length > 40) out.push(`    … ${b.parts.length - 40} more`);
  }
  if (b.nodes.length) {
    const shown = b.nodes.filter((x) => x.added !== 0).slice(0, 20);
    out.push(`by node (the triangles each node adds to what its inputs had, negative = removes; nodes upstream of the result):`);
    const wn = Math.min(48, Math.max(8, ...shown.map((x) => `${x.node} (${x.type})`.length)));
    for (const x of shown) out.push(`    ${`${x.node} (${x.type})`.padEnd(wn)} ${(x.added > 0 ? '+' : '') + n(x.added)}`.padEnd(wn + 16) + `  → ${n(x.triangles)}`);
    const changing = b.nodes.filter((x) => x.added !== 0).length, same = b.nodes.length - changing;
    if (changing > shown.length) out.push(`    … ${changing - shown.length} more that add or remove triangles`);
    if (same) out.push(`    ${same} more pass their input's triangles on`);
  }
  return out;
}

/** The cooked nodes of a graph for the per-node budget (graph spec, the cook's results). */
export function nodeBudgetInput(spec: { nodes: Record<string, { type: string; in?: unknown }> }, results: Map<string, { geo: Geometry | null }>): NodeBudgetInput[] {
  const out: NodeBudgetInput[] = [];
  for (const [name, r] of results) {
    const node = spec.nodes?.[name];
    if (!node) continue;
    const raw = node.in, ins: string[] = [];
    if (typeof raw === 'string') ins.push(raw);
    else if (Array.isArray(raw)) for (const x of raw) { if (typeof x === 'string') ins.push(x); }
    else if (raw && typeof raw === 'object') for (const x of Object.values(raw)) { if (typeof x === 'string') ins.push(x); }
    out.push({ node: name, type: node.type, geo: r.geo, inputs: ins.map((x) => x.split(':')[0]) });
  }
  return out;
}

/**
 * The topology section: closed solid or not and why (open edges after welding uv/normal seam splits, non-manifold
 * edges, winding flips, inward pieces, degenerate faces: each with the first one's part and position and the fix),
 * pieces, render/export triangle health, area, volume, genus.
 */
export function topologyLines(g: Geometry): string[] {
  const out: string[] = [];
  const r = topologyReport(g), s = solidReport(g);
  const causes = solidCauses(s);
  if (!s.polys) out.push(`  no polygons (${r.lines} polylines, ${g.numPoints} points): not a surface`);
  else if (s.closedAfterWeld) {
    out.push(s.closed ? '  CLOSED solid (watertight: every polygon edge shared by exactly two polygons)'
      : `  CLOSED solid after welding seam splits: ${openEdgesText(s)}; fuse the points to make it closed as it is`);
    // a closed mesh can still have flipped faces, face inward or hold degenerate faces
    out.push(...causes.map((c) => `    ${c}`));
  } else out.push('  NOT a closed solid:', ...causes.map((c) => `    ${c}`));
  out.push(`  ${s.pieces} connected piece(s) after welding seam splits${r.pieces !== s.pieces ? ` (${r.pieces} as the points are)` : ''}; ${r.edges} edges; ${r.degenerate} degenerate prims; ${r.unusedPoints} unused points`);
  const t = triangleReport(g);
  if (t.triangles) {
    const first = (a: number[]) => (a.length ? ` (first ${primWhere(g, a[0])}${a.length > 1 ? `; parts: ${partsOf(g, a) || `${a.length} prims`}` : ''})` : '');
    out.push(`  ${t.triangles} render/export triangles; min area ${fmtNum(t.minArea)}, min quality ${fmtNum(t.minQuality)}; ${t.degenerate} degenerate${first(t.degeneratePrims)}, ${t.nearDegenerate} near-degenerate${first(t.nearDegeneratePrims)}`);
  }
  let area = 0;
  for (let p = 0; p < g.numPrims; p++) area += primArea(g, p);
  const vol = s.closedAfterWeld ? signedVolume(g) : NaN;
  out.push(`  surface area ${fmtNum(area)}${s.closedAfterWeld ? `; volume ${fmtNum(vol)}${vol < 0 ? ' (NEGATIVE: faces point inward, use reverse)' : ''}` : ''}`);
  if (r.closed && r.pieces === 1) out.push(`  euler ${r.euler} → genus ${(2 - r.euler) / 2}`);
  return out;
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
