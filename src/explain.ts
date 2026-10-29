// Shape descriptions for LLMs: explain (what a cooked geometry is, in ~30 lines of text) and diff (what changed
// between two geometries: counts, bbox, attribute schema, groups, volumes, Hausdorff distance, an overlay for the
// renderer). Host-agnostic; the MCP tools in src/mcp/verify.ts resolve graphs and render.
import { Geometry } from './core/geometry.ts';
import type { AttribClass, Attribute, Volume } from './core/geometry.ts';
import type { Vec3 } from './core/math.ts';
import { buildEdges, primArea } from './core/topology.ts';
import { pointWhere } from './core/report.ts';
import {
  RayScene, SurfaceQuery, bboxDiagonal, directedDistance, duplicatePoints, fmt, mirrorSymmetry, newNearest, pieceReport,
  principalAxes, quantile, rayMeasure, sampleSurface,
} from './core/analysis.ts';
import type { PieceReport } from './core/analysis.ts';
import { volumeCounts } from './core/heightfield.ts';

/** A length with a unit an LLM reads at a glance: "1.2 m", "3 cm", "0.4 mm". */
export function fmtLen(x: number): string {
  if (!Number.isFinite(x)) return String(x);
  const a = Math.abs(x);
  if (a === 0) return '0 m';
  if (a >= 1) return `${fmt(x)} m`;
  if (a >= 0.01) return `${fmt(x * 100)} cm`;
  if (a >= 1e-4) return `${fmt(x * 1000)} mm`;
  return `${fmt(x)} m`;
}

const v3 = (a: ArrayLike<number>) => `(${Array.from(a, (x) => fmt(Math.abs(x) < 1e-12 ? 0 : x)).join(', ')})`;
const n = (x: number) => x.toLocaleString('en-US');
const size3 = (s: number[]) => `${s.map((x) => fmt(x)).join(' × ')} m`;
const typeCode = (a: Attribute) => (a.type === 'float' ? 'f' : a.type === 'int' ? 'i' : 's') + a.size;
const plural = (k: number, w: string) => `${n(k)} ${w}${k === 1 ? '' : 's'}`;

function primMix(g: Geometry) {
  let tris = 0, quads = 0, ngons = 0, lines = 0, maxSides = 0, small = 0;
  for (let p = 0; p < g.numPrims; p++) {
    const s = g.primSize(p);
    if (!g.primClosed[p]) { lines++; continue; }
    if (s < 3) small++;
    else if (s === 3) tris++;
    else if (s === 4) quads++;
    else { ngons++; if (s > maxSides) maxSides = s; }
  }
  return { tris, quads, ngons, lines, maxSides, small, polys: tris + quads + ngons + small };
}

/** Name an axis direction: "+X" when within ~5° of a world axis, else the vector. */
function axisName(a: Vec3): string {
  const names = ['X', 'Y', 'Z'];
  for (let i = 0; i < 3; i++) if (Math.abs(a[i]) > 0.996) return `${a[i] > 0 ? '+' : '-'}${names[i]}`;
  return v3(a);
}

interface ShapeFacts {
  pr: PieceReport;
  mix: ReturnType<typeof primMix>;
  size: number[];
  diag: number;
  pca: ReturnType<typeof principalAxes>;
  symmetric: string[];
  thickness: Thickness | null;
}

interface Thickness {
  min: number;
  p5: number;
  median: number;
  at: Vec3;
  count: number;
  /** thickness relative to the size of the sample's piece: 5% quantile and median */
  p5Ratio: number;
  medianRatio: number;
}

/** "box-like", "sphere-like", … from the oriented extents (largest first) and the fill ratio of a closed piece. */
function shapeWord(ext: number[], volume: number, closed: boolean, genus: number): string {
  const [e0, e1, e2] = ext;
  if (!(e0 > 0)) return 'degenerate (zero size)';
  const words: string[] = [];
  const flat = e2 < 0.02 * e0, rod = e1 < 0.25 * e0, plate = !rod && e2 < 0.15 * e0;
  if (!closed) {
    if (flat) words.push(rod ? 'flat strip' : 'flat sheet');
    else words.push(rod ? 'open elongated surface' : 'open surface (not flat)');
  } else {
    const fill = e0 * e1 * e2 > 0 ? Math.abs(volume) / (e0 * e1 * e2) : 0;
    const near = (a: number, b: number) => Math.abs(a - b) <= 0.15 * Math.max(a, b);
    let kind: string;
    if (fill > 0.85) kind = 'box-like';
    else if (fill > 0.68) kind = near(e0, e1) || near(e1, e2) ? 'cylinder-like' : 'rounded box';
    else if (fill > 0.45) kind = near(e0, e2) ? 'sphere-like' : 'ellipsoid-like';
    else if (fill > 0.2) kind = 'irregular';
    else kind = 'hollow or spindly';
    if (genus === 1 && fill < 0.85) kind = 'ring / torus-like';
    words.push(kind);
    if (plate) words.push('plate-like (thin in one direction)');
    else if (rod) words.push('elongated');
    words.push(`fills ${Math.round(fill * 100)}% of its oriented box`);
  }
  if (genus > 0 && closed) words.push(`${plural(genus, 'hole')} through it`);
  return words.join(', ');
}

function readsAs(g: Geometry, f: ShapeFacts): string {
  const { pr, mix } = f;
  if (!g.numPoints && g.volumes.length && g.volumes.every((v) => v.kind === 'image')) return `only ${plural(g.volumes.length, 'image')} (textures: render views "texture" shows them, texture_to_material puts them on a mesh)`;
  if (!g.numPoints) return g.volumes.length ? `only ${plural(g.volumes.length, 'SDF volume')}, no mesh yet (sdf_to_mesh makes one)` : 'empty geometry';
  if (!g.numPrims) return `point cloud of ${n(g.numPoints)} points spanning ${size3(f.size)}`;
  if (!mix.polys) {
    let len = 0;
    for (let p = 0; p < g.numPrims; p++) {
      const s = g.primStart[p], e = g.primStart[p + 1], P = g.P;
      for (let v = s; v < e - 1; v++) { const a = g.vertexPoint[v] * 3, b = g.vertexPoint[v + 1] * 3; len += Math.hypot(P[a] - P[b], P[a + 1] - P[b + 1], P[a + 2] - P[b + 2]); }
    }
    return `${plural(mix.lines, 'curve')}, total length ${fmtLen(len)}, spanning ${size3(f.size)}`;
  }
  // surfaces (pieces with polygons, cavity walls excluded) and curve-only pieces
  const solids = pr.pieces.filter((x) => x.polys > 0 && !x.cavity), cavities = pr.pieces.filter((x) => x.cavity).length;
  const curves = pr.pieces.filter((x) => !x.polys).length;
  const closed = solids.filter((x) => x.closed).length, open = solids.length - closed;
  const parts: string[] = [];
  const cav = cavities ? ` with ${cavities === 1 ? 'an inner cavity' : `${n(cavities)} inner cavities`} (hollow)` : '';
  if (solids.length === 1) parts.push((closed ? 'one closed piece' : 'one open surface') + cav);
  else parts.push(`${n(solids.length)} pieces (${n(closed)} closed, ${n(open)} open)${cav}`);
  const main = solids.reduce((b, x) => (x.area > b.area ? x : b), solids[0]);
  const ext = solids.length === 1 && !curves ? f.pca.extents : [0, 1, 2].map((i) => main.max[i] - main.min[i]).sort((x, y) => y - x);
  if (solids.length > 1) parts.push(`largest ${shapeWord(ext, main.volume, main.closed, main.genus).split(', fills')[0]} (${size3([0, 1, 2].map((i) => main.max[i] - main.min[i]))})`, `overall ${size3(f.size)}`);
  else parts.push(shapeWord(ext, main.volume, main.closed, main.genus).split(', fills')[0], size3(f.size));
  const t = f.thickness;
  if (t && t.medianRatio < 0.1) parts.push(`${fmtLen(t.median)} thin walls`);
  else if (t && t.p5Ratio < 0.05) parts.push(`thin parts down to ${fmtLen(t.p5)}`);
  if (f.symmetric.length) parts.push(`mirror-symmetric in ${f.symmetric.join(', ')}`);
  if (curves) parts.push(`plus ${plural(mix.lines, 'curve')}`);
  return parts.join(', ');
}

/** Thickness at sampled surface points of the closed pieces (inward rays from the outward face normals). */
function sampleThickness(g: Geometry, pr: PieceReport, diag: number, query: SurfaceQuery | null): Thickness | null {
  if (!pr.pieces.some((x) => x.closed)) return null;
  const s = sampleSurface(g, 384, 7);
  const keep: number[] = [], size: number[] = [];
  for (let i = 0; i < s.prim.length; i++) {
    const k = s.prim[i] >= 0 ? pr.primPiece[s.prim[i]] : -1;
    if (k < 0 || !pr.pieces[k].closed) continue;
    const pc = pr.pieces[k];
    // inward-facing pieces are flipped: measure into their material; cavity walls already face away from it
    if (pc.volume < 0 && !pc.cavity) { s.N[i * 3] *= -1; s.N[i * 3 + 1] *= -1; s.N[i * 3 + 2] *= -1; }
    keep.push(i);
    size.push(Math.max(pc.max[0] - pc.min[0], pc.max[1] - pc.min[1], pc.max[2] - pc.min[2]) || 1);
  }
  if (!keep.length) return null;
  const P = new Float64Array(keep.length * 3), N = new Float64Array(keep.length * 3);
  keep.forEach((i, j) => { for (let c = 0; c < 3; c++) { P[j * 3 + c] = s.P[i * 3 + c]; N[j * 3 + c] = s.N[i * 3 + c]; } });
  const scene = query?.rays ?? RayScene.of(g);
  const t = rayMeasure(P, N, scene, { mode: 'thickness', samples: 6, maxDistance: diag, bias: 1e-5 * diag, coneAngle: 15, seed: 3 });
  const ratio = Array.from(t, (x, j) => x / size[j]);
  let mi = 0;
  for (let i = 1; i < t.length; i++) if (t[i] < t[mi]) mi = i;
  return {
    min: t[mi], p5: quantile(t, 0.05), median: quantile(t, 0.5), at: [P[mi * 3], P[mi * 3 + 1], P[mi * 3 + 2]], count: t.length,
    p5Ratio: quantile(ratio, 0.05), medianRatio: quantile(ratio, 0.5),
  };
}

/** Compact text description of a cooked geometry for an LLM (about 15–35 lines). */
export function explainGeometry(g: Geometry, label = ''): string {
  const out: string[] = [];
  const b = g.bbox();
  const size = [0, 1, 2].map((i) => b.max[i] - b.min[i]);
  const diag = bboxDiagonal(g);
  const mix = primMix(g);
  const pr = pieceReport(g);
  const pca = principalAxes(g);
  const query = g.numPoints ? new SurfaceQuery(g) : null;
  const symTol = Math.max(1e-9, 1e-3 * diag);
  const symSamples = g.numPoints ? sampleSurface(g, 600, 1, true) : null;
  const sym = query && symSamples && diag > 0 ? mirrorSymmetry(g, query, symSamples, symTol) : [];
  const symmetric = sym.filter((s) => s.symmetric).map((s) => s.axis);
  const thickness = mix.polys && diag > 0 ? sampleThickness(g, pr, diag, query) : null;
  const facts: ShapeFacts = { pr, mix, size, diag, pca, symmetric, thickness };

  out.push(`${label ? label + ' ' : ''}reads as: ${readsAs(g, facts)}`);
  const edges = g.numPrims ? buildEdges(g) : null;
  out.push(`geometry: ${n(g.numPoints)} points, ${n(g.numPrims)} prims, ${n(g.numVertices)} vertices${edges ? `, ${n(edges.a.length)} edges` : ''}${pr.loosePoints && g.numPrims ? `, ${n(pr.loosePoints)} loose points` : ''}${g.volumes.length ? `, ${volumeCounts(g)} (not measured)` : ''}`);
  if (!g.numPoints) return out.join('\n');
  out.push(`bbox: min ${v3(b.min)} max ${v3(b.max)} size ${size3(size)} center ${v3([0, 1, 2].map((i) => (b.min[i] + b.max[i]) / 2))}`);

  // pieces
  if (g.numPrims) {
    const closed = pr.pieces.filter((x) => x.closed).length, curves = pr.pieces.filter((x) => !x.polys).length;
    const kinds = [`${n(closed)} closed`, `${n(pr.pieces.length - closed - curves)} open`];
    if (curves) kinds.push(`${n(curves)} curve-only`);
    out.push(`pieces: ${n(pr.pieces.length)} (${kinds.join(', ')})${pr.pieces.length > 6 ? ', 6 largest by area:' : ':'}`);
    const order = pr.pieces.map((x, k) => ({ x, k })).sort((p, q) => q.x.area - p.x.area || p.k - q.k).slice(0, 6);
    for (const { x, k } of order) {
      const sz = [0, 1, 2].map((i) => x.max[i] - x.min[i]), c = [0, 1, 2].map((i) => (x.min[i] + x.max[i]) / 2);
      const what = x.polys ? `${plural(x.polys, 'poly')}${x.lines ? ` + ${plural(x.lines, 'line')}` : ''}` : plural(x.lines, 'line');
      const topo = x.polys ? (x.closed ? `closed, genus ${x.genus}, volume ${fmt(x.volume)}` : `open, ${plural(x.boundaryLoops, 'boundary loop')}${x.nonManifoldEdges ? `, ${x.nonManifoldEdges} non-manifold edges` : ''}`) : 'curves';
      out.push(`  #${k}: ${what}, ${topo}${x.area > 0 ? `, area ${fmt(x.area)}` : ''}, size ${size3(sz)} at ${v3(c)}`);
    }
  }
  // topology and orientation
  if (mix.polys) {
    const be = pr.pieces.reduce((s, x) => s + x.boundaryEdges, 0), nme = pr.pieces.reduce((s, x) => s + x.nonManifoldEdges, 0);
    const loops = pr.pieces.reduce((s, x) => s + x.boundaryLoops, 0), genus = pr.pieces.reduce((s, x) => s + (x.closed ? x.genus : 0), 0);
    const water = be === 0 && nme === 0 && mix.lines === 0;
    const hasClosed = pr.pieces.some((x) => x.closed);
    out.push(`topology: ${water ? 'watertight (every edge shared by two polygons)' : `not watertight: ${n(be)} boundary edges in ${plural(loops, 'boundary loop')}${nme ? `, ${n(nme)} edges shared by 3+ polygons` : ''}`}${hasClosed ? `; genus of the closed pieces ${genus}` : ''}`);
    const inward = pr.pieces.filter((x) => x.closed && x.volume < 0 && !x.cavity).length, cav = pr.pieces.filter((x) => x.cavity).length;
    const sides = inward ? `${inward} closed piece(s) face INWARD (negative volume: use reverse)` : pr.pieces.some((x) => x.closed) ? 'closed pieces face outward' : 'no closed pieces';
    out.push(`orientation: ${pr.flippedEdges ? `${n(pr.flippedEdges)} edges between oppositely wound polygons (flipped normals)` : 'winding consistent'}; ${sides}${cav ? `; ${cav} cavity wall(s) face into their cavity (correct for a hollow solid)` : ''}`);
  }
  // symmetry and shape
  if (sym.length) {
    if (symmetric.length) out.push(`symmetry: mirror-symmetric across ${sym.filter((s) => s.symmetric).map((s) => `${s.axis} (plane ${s.axis}=${fmt(s.at)})`).join(', ')}; tolerance ${fmtLen(symTol)}`);
    else {
      const best = sym.reduce((p, q) => (q.maxDeviation < p.maxDeviation ? q : p));
      out.push(`symmetry: none about the bbox-centre planes (closest: ${best.axis}, off by ${Number.isFinite(best.maxDeviation) ? fmtLen(best.maxDeviation) : 'a lot'})`);
    }
  }
  if (diag > 0) {
    const e = pca.extents, ratio = e.map((x) => (e[2] > 1e-9 * e[0] ? x / e[2] : x > 0 ? Infinity : 0));
    const iso = e[0] > 0 && e[2] / e[0] > 0.9;
    out.push(`shape: ${iso ? 'no dominant axis (isotropic)' : `principal axis ${axisName(pca.axes[0])}`}; extents along the principal axes ${size3(e)}${Number.isFinite(ratio[0]) && e[2] > 0 ? ` (aspect ${ratio.map((x) => fmt(x)).join(' : ')})` : ''}`);
    if (mix.polys && pr.pieces.length === 1) out.push(`  ${shapeWord(e, pr.pieces[0].volume, pr.pieces[0].closed, pr.pieces[0].genus)}`);
  }
  if (thickness) out.push(`thickness (closed pieces, ${thickness.count} surface samples): min ${fmtLen(thickness.min)} at ${v3(thickness.at)}, 5% ${fmtLen(thickness.p5)}, median ${fmtLen(thickness.median)}`);
  // quality
  if (g.numPrims) {
    const P = g.P;
    let shortest = Infinity, longest = 0;
    if (edges) for (let e = 0; e < edges.a.length; e++) {
      const a = edges.a[e] * 3, c = edges.b[e] * 3, l = Math.hypot(P[a] - P[c], P[a + 1] - P[c + 1], P[a + 2] - P[c + 2]);
      if (l < shortest) shortest = l;
      if (l > longest) longest = l;
    }
    const amin = (1e-7 * diag) ** 2;
    let degen = 0;
    for (let p = 0; p < g.numPrims; p++) if (g.primClosed[p] && (g.primSize(p) < 3 || primArea(g, p) <= amin)) degen++;
    const dup = g.numPoints <= 300000 ? duplicatePoints(g, 1e-7 * diag).count : -1;
    out.push(`quality: ${n(degen)} degenerate polygons, ${dup < 0 ? 'duplicate points not checked (> 300k points)' : `${n(dup)} coincident points`}, edge length ${fmtLen(shortest)} .. ${fmtLen(longest)}`);
    const m = mix, parts: string[] = [];
    const pct = (k: number) => `${Math.round((100 * k) / Math.max(1, m.polys))}%`;
    if (m.tris) parts.push(`${n(m.tris)} tris (${pct(m.tris)})`);
    if (m.quads) parts.push(`${n(m.quads)} quads (${pct(m.quads)})`);
    if (m.ngons) parts.push(`${n(m.ngons)} n-gons (${pct(m.ngons)}, up to ${m.maxSides} sides)`);
    if (m.small) parts.push(`${n(m.small)} polygons with < 3 corners`);
    if (m.lines) parts.push(`${n(m.lines)} polylines`);
    out.push(`prims: ${parts.join(', ') || 'none'}`);
  }
  // attributes, groups, materials
  const attrs: string[] = [];
  for (const cls of ['point', 'vertex', 'prim', 'detail'] as AttribClass[]) {
    const t = g.table(cls);
    if (!t.map.size) continue;
    attrs.push(`${cls} ${[...t.map].map(([k, a]) => `${k}(${typeCode(a)})`).join(' ')}`);
  }
  out.push(`attributes: ${attrs.join('; ') || 'none'}`);
  const grp: string[] = [];
  for (const cls of ['point', 'vertex', 'prim'] as const) for (const [k, m] of g.groups(cls)) grp.push(`${cls} ${k}(${n(m.reduce((s, x) => s + x, 0))})`);
  for (const [k, s] of g.edgeGroups) grp.push(`edge ${k}(${n(s.size)})`);
  out.push(`groups: ${grp.join(', ') || 'none'}`);
  const mats: string[] = [];
  for (const cls of ['prim', 'detail', 'point'] as AttribClass[]) for (const [k, a] of g.table(cls).map) {
    if (a.type !== 'string' || !/mat/i.test(k)) continue;
    const freq = new Map<string, number>();
    for (const s of a.data as string[]) if (s) freq.set(s, (freq.get(s) ?? 0) + 1);
    if (freq.size) mats.push(`${cls} ${k}: ${[...freq].sort((x, y) => y[1] - x[1]).slice(0, 5).map(([s, c]) => `${s} ×${c}`).join(', ')}${freq.size > 5 ? ', …' : ''}`);
  }
  if (mats.length) out.push(`materials: ${mats.join('; ')}`);
  return out.join('\n');
}

// ---------------------------------------------------------------- diff

function schema(g: Geometry): Map<string, string> {
  const m = new Map<string, string>();
  for (const cls of ['point', 'vertex', 'prim', 'detail'] as AttribClass[]) for (const [k, a] of g.table(cls).map) m.set(`${cls} ${k}`, typeCode(a));
  return m;
}

function groupSizes(g: Geometry): Map<string, number> {
  const m = new Map<string, number>();
  for (const cls of ['point', 'vertex', 'prim'] as const) for (const [k, mask] of g.groups(cls)) m.set(`${cls} ${k}`, mask.reduce((s, x) => s + x, 0));
  for (const [k, s] of g.edgeGroups) m.set(`edge ${k}`, s.size);
  return m;
}

const delta = (a: number, b: number) => {
  const d = b - a;
  return d === 0 ? '=' : `${d > 0 ? '+' : ''}${n(d)}`;
};
const signed = (x: number) => (Math.abs(x) < 1e-12 ? '0' : `${x > 0 ? '+' : ''}${fmt(x)}`);

/** The largest difference between two sample arrays: 0 when they are equal, Infinity when their lengths differ. */
function maxDelta(x: ArrayLike<number>, y: ArrayLike<number>): number {
  if (x === y) return 0;
  if (x.length !== y.length) return Infinity;
  let m = 0;
  for (let i = 0; i < x.length; i++) {
    if (x[i] === y[i]) continue;
    const d = Math.abs(x[i] - y[i]);
    if (!(d <= m)) m = Number.isNaN(d) ? Infinity : d;
  }
  return m;
}

/** How a volume differs from the one of the same kind and name in b, '' when it does not (or, analytic, cannot be told). */
function volumeDelta(a: Volume, b: Volume): string {
  const by = (m: number, metres: boolean) => (Number.isFinite(m) ? (metres ? fmtLen(m) : fmt(m)) : 'a lot');
  if (a.kind === 'sdf' || b.kind === 'sdf') {
    const box = (v: Volume) => `${v3(v.bounds.min)}..${v3(v.bounds.max)}`;
    return box(a) === box(b) ? '' : `bounds ${box(a)} → ${box(b)}`;
  }
  if (a.kind === 'grid' && b.kind === 'grid') {
    const dims = (v: typeof a) => `${v.dims.join(' × ')} at ${fmtLen(v.voxel)} from ${v3(v.origin)}`;
    if (dims(a) !== dims(b)) return `${dims(a)} → ${dims(b)}`;
    const m = maxDelta(a.values, b.values);
    return m ? `distances differ by up to ${by(m, true)}` : '';
  }
  if ((a.kind === 'heightfield' && b.kind === 'heightfield') || (a.kind === 'image' && b.kind === 'image')) {
    const grid = (v: Volume) => (v.kind === 'heightfield' ? `${v.width} × ${v.height} cells of ${fmtLen(v.cellSize)} from (${v.origin.map((x) => fmt(x)).join(', ')})` : v.kind === 'image' ? `${v.width} × ${v.height} px` : '');
    if (grid(a) !== grid(b)) return `${grid(a)} → ${grid(b)}`;
    const parts: string[] = [];
    for (const k of b.layers.keys()) if (!a.layers.has(k)) parts.push(`+ layer ${k}`);
    for (const k of a.layers.keys()) if (!b.layers.has(k)) parts.push(`- layer ${k}`);
    for (const [k, la] of a.layers) {
      const lb = b.layers.get(k), m = lb ? maxDelta(la, lb) : 0;
      if (m) parts.push(`layer ${k} by up to ${by(m, a.kind === 'heightfield' && k === 'height')}`);
    }
    return parts.join(', ');
  }
  return '';
}

/**
 * What changed in the volumes, by kind and name: heightfields, images and SDF grids compared sample by sample, analytic
 * SDFs by their bounds. "+" only in b, "-" only in a, "~" changed.
 */
function volumeChanges(a: Geometry, b: Geometry): string[] {
  const byName = (g: Geometry) => {
    const m = new Map<string, Volume>(), seen = new Map<string, number>();
    for (const v of g.volumes) {
      const base = `${v.kind === 'grid' ? 'SDF grid' : v.kind === 'sdf' ? 'SDF' : v.kind} "${v.name}"`;
      const k = (seen.get(base) ?? 0) + 1;
      seen.set(base, k);
      m.set(k > 1 ? `${base} #${k}` : base, v);
    }
    return m;
  };
  const A = byName(a), B = byName(b), out: string[] = [];
  for (const k of B.keys()) if (!A.has(k)) out.push(`+ ${k}`);
  for (const k of A.keys()) if (!B.has(k)) out.push(`- ${k}`);
  for (const [k, v] of A) {
    const w = B.get(k), d = w ? volumeDelta(v, w) : '';
    if (d) out.push(`~ ${k}: ${d}`);
  }
  return out;
}

export interface DiffResult {
  text: string;
  /** symmetric Hausdorff distance (Infinity when one side is empty) */
  hausdorff: number;
  mean: number;
  identical: boolean;
}

/** What changed from a to b: counts, bbox, topology, attribute schema, groups, volumes, sampled Hausdorff and mean distance. */
export function diffGeometry(a: Geometry, b: Geometry, labels: [string, string] = ['a', 'b'], samples = 3000): DiffResult {
  const out: string[] = [`diff a = ${labels[0]}  vs  b = ${labels[1]}`];
  const ma = primMix(a), mb = primMix(b);
  out.push(`counts: points ${n(a.numPoints)} → ${n(b.numPoints)} (${delta(a.numPoints, b.numPoints)}), prims ${n(a.numPrims)} → ${n(b.numPrims)} (${delta(a.numPrims, b.numPrims)}), vertices ${n(a.numVertices)} → ${n(b.numVertices)} (${delta(a.numVertices, b.numVertices)})${ma.lines || mb.lines ? `, polylines ${n(ma.lines)} → ${n(mb.lines)}` : ''}`);
  const ba = a.bbox(), bb = b.bbox();
  const sa = [0, 1, 2].map((i) => ba.max[i] - ba.min[i]), sb = [0, 1, 2].map((i) => bb.max[i] - bb.min[i]);
  const ca = [0, 1, 2].map((i) => (ba.min[i] + ba.max[i]) / 2), cb = [0, 1, 2].map((i) => (bb.min[i] + bb.max[i]) / 2);
  const d3 = (x: number[], y: number[]) => `(${[0, 1, 2].map((i) => signed(y[i] - x[i])).join(', ')})`;
  if (a.numPoints && b.numPoints) {
    out.push(`bbox a: size ${size3(sa)} center ${v3(ca)}  |  b: size ${size3(sb)} center ${v3(cb)}`);
    out.push(`bbox delta: min ${d3(ba.min, bb.min)} max ${d3(ba.max, bb.max)} size ${d3(sa, sb)} center ${d3(ca, cb)}`);
  } else out.push(`bbox: ${a.numPoints ? '' : 'a is empty'}${!a.numPoints && !b.numPoints ? ', ' : ''}${b.numPoints ? '' : 'b is empty'}`);
  // topology
  const topo = (g: Geometry) => {
    if (!g.numPrims) return g.numPoints ? 'points only' : 'empty';
    const pr = pieceReport(g);
    const closed = pr.pieces.filter((x) => x.closed).length;
    const vol = pr.pieces.reduce((s, x) => s + x.volume, 0), genus = pr.pieces.reduce((s, x) => s + x.genus, 0);
    return { text: `${plural(pr.pieces.length, 'piece')} (${closed} closed), genus ${genus}${closed ? `, volume ${fmt(vol)}` : ''}`, vol, closed };
  };
  const ta = topo(a), tb = topo(b);
  const tt = (t: any) => (typeof t === 'string' ? t : t.text);
  let volNote = '';
  if (typeof ta !== 'string' && typeof tb !== 'string' && ta.closed && tb.closed && Math.abs(ta.vol) > 0) volNote = ` (volume ${signed(((tb.vol - ta.vol) / Math.abs(ta.vol)) * 100)}%)`;
  out.push(tt(ta) === tt(tb) ? `topology: same: ${tt(ta)}` : `topology: a ${tt(ta)}  |  b ${tt(tb)}${volNote}`);
  // attribute schema
  const sA = schema(a), sB = schema(b), attrChanges: string[] = [];
  for (const [k, t] of sB) if (!sA.has(k)) attrChanges.push(`+ ${k} ${t}`);
  for (const [k, t] of sA) if (!sB.has(k)) attrChanges.push(`- ${k} ${t}`);
  for (const [k, t] of sA) if (sB.has(k) && sB.get(k) !== t) attrChanges.push(`~ ${k} ${t} → ${sB.get(k)}`);
  out.push(`attributes: ${attrChanges.length ? attrChanges.join('; ') + ' (+ only in b, - only in a, ~ changed type)' : 'same schema'}`);
  const gA = groupSizes(a), gB = groupSizes(b), grpChanges: string[] = [];
  for (const [k, c] of gB) if (!gA.has(k)) grpChanges.push(`+ ${k} (${n(c)})`);
  for (const [k, c] of gA) if (!gB.has(k)) grpChanges.push(`- ${k} (${n(c)})`);
  for (const [k, c] of gA) if (gB.has(k) && gB.get(k) !== c) grpChanges.push(`~ ${k} ${n(c)} → ${n(gB.get(k)!)} members`);
  out.push(`groups: ${grpChanges.length ? grpChanges.join('; ') : gA.size ? 'same names and sizes' : 'none'}`);
  const volChanges = a.volumes.length || b.volumes.length ? volumeChanges(a, b) : [];
  if (a.volumes.length || b.volumes.length) out.push(`volumes: ${volChanges.length ? volChanges.join('; ') + ' (+ only in b, - only in a, ~ changed)' : `same (${volumeCounts(a)}${a.volumes.some((v) => v.kind === 'sdf') ? '; analytic SDFs by their bounds' : ''})`}`);
  // distances
  let haus = Infinity, mean = Infinity;
  if (a.numPoints && b.numPoints) {
    const qa = new SurfaceQuery(a), qb = new SurfaceQuery(b);
    const smA = sampleSurface(a, samples, 11, true), smB = sampleSurface(b, samples, 13, true);
    const ab = directedDistance(smA.P, qb), ba2 = directedDistance(smB.P, qa);
    haus = Math.max(ab.max, ba2.max);
    mean = (ab.mean * ab.count + ba2.mean * ba2.count) / Math.max(1, ab.count + ba2.count);
    const what = (q: SurfaceQuery) => q.kind;
    const tiny = (x: number) => fmtLen(x <= 1e-12 * Math.max(1, bboxDiagonal(a)) ? 0 : x);
    out.push(`distance: Hausdorff ${tiny(haus)}, mean ${tiny(mean)}  (a→b max ${tiny(ab.max)} at ${v3(ab.at)}; b→a max ${tiny(ba2.max)} at ${v3(ba2.at)}; ${n(ab.count)} + ${n(ba2.count)} samples; a is ${what(qa)}, b is ${what(qb)})`);
  }
  // point-by-point when the point counts match
  if (a.numPoints && a.numPoints === b.numPoints) {
    const PA = a.P, PB = b.P;
    let mx = 0, sum = 0, moved = 0, at = 0;
    const eps = 1e-9 * Math.max(1, bboxDiagonal(a));
    for (let i = 0; i < a.numPoints; i++) {
      const d = Math.hypot(PA[i * 3] - PB[i * 3], PA[i * 3 + 1] - PB[i * 3 + 1], PA[i * 3 + 2] - PB[i * 3 + 2]);
      sum += d;
      if (d > eps) moved++;
      if (d > mx) { mx = d; at = i; }
    }
    out.push(`points (same count, matched by number): ${n(moved)} of ${n(a.numPoints)} moved; max ${fmtLen(mx)}${mx > 0 ? ` (${pointWhere(a, at)} in a)` : ''}, mean ${fmtLen(sum / a.numPoints)}`);
  }
  const sameCounts = a.numPoints === b.numPoints && a.numPrims === b.numPrims && a.numVertices === b.numVertices;
  const diag = Math.max(bboxDiagonal(a), bboxDiagonal(b));
  const identical = sameCounts && !attrChanges.length && !grpChanges.length && !volChanges.length && (a.numPoints === 0 || haus <= 1e-9 * Math.max(1, diag));
  const vols = volChanges.length ? '; the volumes changed' : '';
  let verdict: string;
  if (identical) verdict = `no geometric change (same counts, schema${a.volumes.length ? ', volumes' : ''} and shape within 1e-9)`;
  else if (!a.numPoints && !b.numPoints) verdict = (a.volumes.length || b.volumes.length ? 'no points on either side' : 'both empty') + vols;
  else if (!a.numPoints || !b.numPoints) verdict = `${!a.numPoints ? 'a' : 'b'} is empty${vols}`;
  else if (haus <= 1e-9 * Math.max(1, diag)) verdict = 'same shape; ' + (!sameCounts ? `topology / tessellation differs${vols}` : attrChanges.length || grpChanges.length ? `only attributes/groups differ${vols}` : 'only the volumes differ');
  else verdict = `shape changed by up to ${fmtLen(haus)} (${fmt((100 * haus) / Math.max(1e-12, diag))}% of the bbox diagonal)${sameCounts ? '' : ', and the topology differs'}${vols}`;
  out.push(`verdict: ${verdict}`);
  return { text: out.join('\n'), hausdorff: haus, mean, identical };
}

/** Colours of the diff overlay. */
export const DIFF_COLORS = { same: [0.72, 0.72, 0.72], b: [0.2, 0.5, 1.0], a: [1.0, 0.5, 0.12] };

/**
 * One geometry for the renderer: b (grey where it lies on a, blue where it moved or is new), and in orange the polygons
 * of a that do not lie on b. Those that do are left out, b's grey stands for both there: two coincident surfaces mix
 * their colours in the renderer. So grey = unchanged, blue = only b, orange = only a.
 */
export function diffOverlay(a: Geometry, b: Geometry): Geometry {
  const strip = (g: Geometry) => {
    const c = g.clone();
    for (const cls of ['point', 'vertex', 'prim', 'detail'] as AttribClass[]) c.table(cls).delete('Cd');
    return c;
  };
  let A = strip(a);
  const B = strip(b);
  const qa = a.numPoints ? new SurfaceQuery(a) : null;
  const tol = 1e-3 * Math.max(bboxDiagonal(a), bboxDiagonal(b), 1e-9);
  const cB = B.points.add('Cd', 'float', 3).data as Float64Array, out = newNearest(), P = B.P;
  for (let i = 0; i < B.numPoints; i++) {
    const same = qa && qa.nearest(P[i * 3], P[i * 3 + 1], P[i * 3 + 2], tol, out);
    const c = same ? DIFF_COLORS.same : DIFF_COLORS.b;
    cB[i * 3] = c[0]; cB[i * 3 + 1] = c[1]; cB[i * 3 + 2] = c[2];
  }
  if (b.numPoints && A.numPrims && !A.primKind) {
    // a polygon lies on b when its corners and its centre do
    const qb = new SurfaceQuery(b), PA = A.P, on = new Uint8Array(A.numPoints);
    for (let i = 0; i < A.numPoints; i++) on[i] = qb.nearest(PA[i * 3], PA[i * 3 + 1], PA[i * 3 + 2], tol, out) ? 1 : 0;
    const keep = new Uint8Array(A.numPrims), c = [0, 0, 0];
    let kept = 0;
    for (let p = 0; p < A.numPrims; p++) {
      const s = A.primStart[p], e = A.primStart[p + 1];
      let off = false;
      c[0] = c[1] = c[2] = 0;
      for (let v = s; v < e; v++) {
        const i = A.vertexPoint[v];
        if (!on[i]) { off = true; break; }
        c[0] += PA[i * 3]; c[1] += PA[i * 3 + 1]; c[2] += PA[i * 3 + 2];
      }
      if (off || (e > s && !qb.nearest(c[0] / (e - s), c[1] / (e - s), c[2] / (e - s), tol, out))) { keep[p] = 1; kept++; }
    }
    if (kept < A.numPrims) A = A.subsetPrims(keep);
  }
  const cA = A.points.add('Cd', 'float', 3).data as Float64Array;
  for (let i = 0; i < A.numPoints; i++) { cA[i * 3] = DIFF_COLORS.a[0]; cA[i * 3 + 1] = DIFF_COLORS.a[1]; cA[i * 3 + 2] = DIFF_COLORS.a[2]; }
  return Geometry.merge([B, A]);
}
