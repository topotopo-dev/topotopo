// Scattering and instancing.
import { Attribute, AttribTable, GeoBuilder, Geometry } from '../core/geometry.ts';
import { EdgeSet } from '../core/edges.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import { rng } from '../core/random.ts';
import { connectivity, primNormals, triangulate } from '../core/topology.ts';
import { composePackedXforms } from '../core/packed.ts';
import { KDTree, TriBVH } from '../core/spatial.ts';
import { lookAtBasis, m4apply, m4applyDir, m4basis, m4fromQuat, m4mul, m4normalMatrix, m4scale, m4translate, normalize } from '../core/math.ts';
import type { Mat4, Vec3 } from '../core/math.ts';
import { P, mask } from './util.ts';

// ---------------------------------------------------------------- scatter

/** Weighted sample elimination (Yuksel 2015) – picks a well-spaced subset of candidates. */
function sampleEliminate(pos: Float64Array, target: number, rmax: number): Int32Array {
  const n = pos.length / 3;
  if (target >= n) return Int32Array.from({ length: n }, (_, i) => i);
  const kd = new KDTree(pos);
  const r2 = 2 * rmax;
  const nbrs: Int32Array[] = new Array(n);
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const list = kd.within(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], r2).filter((j) => j !== i);
    nbrs[i] = Int32Array.from(list);
    for (const j of list) {
      const d = Math.hypot(pos[i * 3] - pos[j * 3], pos[i * 3 + 1] - pos[j * 3 + 1], pos[i * 3 + 2] - pos[j * 3 + 2]);
      w[i] += Math.pow(1 - Math.min(d, r2) / r2, 8);
    }
  }
  // max-heap on w
  const heap = Int32Array.from({ length: n }, (_, i) => i);
  const where = Int32Array.from({ length: n }, (_, i) => i);
  let size = n;
  const swap = (a: number, b: number) => { const t = heap[a]; heap[a] = heap[b]; heap[b] = t; where[heap[a]] = a; where[heap[b]] = b; };
  const up = (k: number) => { while (k > 0) { const p = (k - 1) >> 1; if (w[heap[p]] >= w[heap[k]]) break; swap(p, k); k = p; } };
  const down = (k: number) => {
    for (;;) {
      const l = 2 * k + 1, r = l + 1;
      let m = k;
      if (l < size && w[heap[l]] > w[heap[m]]) m = l;
      if (r < size && w[heap[r]] > w[heap[m]]) m = r;
      if (m === k) break;
      swap(k, m); k = m;
    }
  };
  for (let k = (size >> 1) - 1; k >= 0; k--) down(k);
  const removed = new Uint8Array(n);
  while (size > target) {
    const i = heap[0];
    removed[i] = 1;
    swap(0, size - 1); size--; down(0);
    for (const j of nbrs[i]) {
      if (removed[j]) continue;
      const d = Math.hypot(pos[i * 3] - pos[j * 3], pos[i * 3 + 1] - pos[j * 3 + 1], pos[i * 3 + 2] - pos[j * 3 + 2]);
      w[j] -= Math.pow(1 - Math.min(d, r2) / r2, 8);
      const k = where[j];
      if (k < size) { down(k); up(where[j]); }
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (!removed[i]) out.push(i);
  return Int32Array.from(out);
}

defineNode({
  type: 'scatter',
  category: 'copy',
  summary: 'Scatter points on surfaces (area-weighted, optional blue-noise relax), along curves, or inside volumes.',
  aliases: ['scatter_points', 'distribute'],
  inputs: [{ name: 'geo', desc: 'surface, curves, or closed mesh (volume mode)' }],
  params: {
    count: { type: 'int', default: 500, min: 0, desc: 'number of points', aliases: ['npts', 'points', 'num'] },
    density: { type: 'float', default: 0, min: 0, desc: 'points per unit area/length/volume (overrides count when > 0)' },
    mode: { type: 'enum', options: ['auto', 'surface', 'curve', 'volume'], default: 'auto', desc: 'auto = surface if polygons, curve if only polylines' },
    relax: { type: 'bool', default: true, desc: 'even (blue-noise) spacing via sample elimination' },
    density_attrib: { type: 'string', default: '', desc: 'point float attribute weighting where points land (e.g. a noise mask)' },
    seed: P.seed(),
    group: P.group('prim'),
    keep_attribs: { type: 'bool', default: true, desc: 'interpolate source point attributes onto scattered points' },
  },
  outputs: 'point N (surface normal), sourceprim; interpolated source attributes',
  cook: ({ input, p }) => {
    const g = input(0);
    const r = rng(p.seed + 0.5);
    const sel = mask(g, 'prim', p.group);
    let hasPoly = false, hasLine = false;
    for (let pr = 0; pr < g.numPrims; pr++) if (!sel || sel[pr]) { if (g.primClosed[pr]) hasPoly = true; else hasLine = true; }
    const mode = p.mode === 'auto' ? (hasPoly ? 'surface' : hasLine ? 'curve' : 'volume') : p.mode;
    const dA = p.density_attrib ? g.points.get(p.density_attrib) : null;
    if (p.density_attrib && !dA) throw new NodeError(`density_attrib "${p.density_attrib}" is not a point attribute`);
    const dw = (pt: number) => (dA ? Math.max(0, dA.get(pt) as number) : 1);
    const b = new GeoBuilder(g);
    if (!p.keep_attribs) for (const n of g.points.names()) b.skip.point.add(n);
    b.skip.point.add('N');
    b.keepSrcGroups = false;
    const Nout = b.attrib('point', 'N', 3);
    const sp = b.attrib('point', 'sourceprim', 1, 'int');
    const Pd = g.P;

    if (mode === 'surface') {
      if (!hasPoly) throw new NodeError('no polygons to scatter on (use mode=curve for polylines or volume for a bounding box)');
      const { tris, triPrim } = triangulate(g, sel);
      const nt = tris.length / 3;
      const cdf = new Float64Array(nt);
      let total = 0, area = 0;
      for (let t = 0; t < nt; t++) {
        const a = g.vertexPoint[tris[t * 3]], bb = g.vertexPoint[tris[t * 3 + 1]], c = g.vertexPoint[tris[t * 3 + 2]];
        const ux = Pd[bb * 3] - Pd[a * 3], uy = Pd[bb * 3 + 1] - Pd[a * 3 + 1], uz = Pd[bb * 3 + 2] - Pd[a * 3 + 2];
        const vx = Pd[c * 3] - Pd[a * 3], vy = Pd[c * 3 + 1] - Pd[a * 3 + 1], vz = Pd[c * 3 + 2] - Pd[a * 3 + 2];
        const ar = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
        area += ar;
        total += ar * (dw(a) + dw(bb) + dw(c)) / 3;
        cdf[t] = total;
      }
      if (total <= 0) throw new NodeError('zero scatter area (or density attribute is 0 everywhere)');
      const count = p.density > 0 ? Math.round(p.density * area) : p.count;
      const ncand = p.relax ? count * 5 : count;
      const fn = primNormals(g);
      const cand: { t: number; w: number[]; pos: number[] }[] = [];
      const pos = new Float64Array(ncand * 3);
      for (let k = 0; k < ncand; k++) {
        const x = r() * total;
        let lo = 0, hi = nt - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] < x) lo = mid + 1; else hi = mid; }
        const t = lo;
        const s1 = Math.sqrt(r()), s2 = r();
        const w = [1 - s1, s1 * (1 - s2), s1 * s2];
        const ids = [0, 1, 2].map((j) => g.vertexPoint[tris[t * 3 + j]]);
        const q = [0, 1, 2].map((c) => w[0] * Pd[ids[0] * 3 + c] + w[1] * Pd[ids[1] * 3 + c] + w[2] * Pd[ids[2] * 3 + c]);
        cand.push({ t, w, pos: q });
        pos.set(q, k * 3);
      }
      const keep = p.relax && count > 0 ? sampleEliminate(pos, count, Math.sqrt(area / (2 * Math.sqrt(3) * count))) : Int32Array.from({ length: ncand }, (_, i) => i);
      const nA = g.points.get('N');
      for (const k of keep) {
        const c = cand[k];
        const ids = [0, 1, 2].map((j) => g.vertexPoint[tris[c.t * 3 + j]]);
        const id = b.addPoint(c.pos[0], c.pos[1], c.pos[2], { i: ids, w: c.w });
        const pr = triPrim[c.t];
        let n: number[] = [fn[pr * 3], fn[pr * 3 + 1], fn[pr * 3 + 2]];
        if (nA && nA.size === 3) {
          const d = nA.data as Float64Array;
          n = normalize([0, 1, 2].map((cc) => c.w[0] * d[ids[0] * 3 + cc] + c.w[1] * d[ids[1] * 3 + cc] + c.w[2] * d[ids[2] * 3 + cc]) as Vec3);
        }
        Nout.set(id, n);
        sp.set(id, pr);
      }
      return b.build();
    }

    if (mode === 'curve') {
      const segs: { a: number; b: number; pr: number; len: number }[] = [];
      let total = 0;
      for (let pr = 0; pr < g.numPrims; pr++) {
        if (sel && !sel[pr]) continue;
        const s = g.primStart[pr], e = g.primStart[pr + 1];
        const last = g.primClosed[pr] ? e : e - 1;
        for (let v = s; v < last; v++) {
          const a = g.vertexPoint[v], bb = g.vertexPoint[v + 1 < e ? v + 1 : s];
          const len = Math.hypot(Pd[bb * 3] - Pd[a * 3], Pd[bb * 3 + 1] - Pd[a * 3 + 1], Pd[bb * 3 + 2] - Pd[a * 3 + 2]) * (dw(a) + dw(bb)) / 2;
          total += len;
          segs.push({ a, b: bb, pr, len: total });
        }
      }
      if (!segs.length || total <= 0) throw new NodeError('no curve length to scatter along');
      const count = p.density > 0 ? Math.round(p.density * total) : p.count;
      for (let k = 0; k < count; k++) {
        const x = p.relax ? ((k + 0.5) / count) * total : r() * total;
        let lo = 0, hi = segs.length - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (segs[mid].len < x) lo = mid + 1; else hi = mid; }
        const sg = segs[lo], prev = lo ? segs[lo - 1].len : 0;
        const f = sg.len > prev ? (x - prev) / (sg.len - prev) : 0;
        const id = b.blendPoint([sg.a, sg.b], [1 - f, f]);
        Nout.set(id, normalize([Pd[sg.b * 3] - Pd[sg.a * 3], Pd[sg.b * 3 + 1] - Pd[sg.a * 3 + 1], Pd[sg.b * 3 + 2] - Pd[sg.a * 3 + 2]]));
        sp.set(id, sg.pr);
      }
      return b.build();
    }

    // volume
    const bb = g.bbox();
    const ext = [0, 1, 2].map((a) => bb.max[a] - bb.min[a]);
    const closed = hasPoly ? new TriBVH(g) : null;
    const vol = Math.max(1e-12, ext[0] * ext[1] * ext[2]);
    const count = p.density > 0 ? Math.round(p.density * vol) : p.count;
    const ncand = p.relax ? count * 5 : count;
    const pos: number[] = [];
    let tries = 0;
    while (pos.length / 3 < ncand && tries++ < ncand * 200) {
      const q = [bb.min[0] + r() * ext[0], bb.min[1] + r() * ext[1], bb.min[2] + r() * ext[2]];
      if (closed && !closed.inside(q[0], q[1], q[2])) continue;
      pos.push(q[0], q[1], q[2]);
    }
    const P0 = Float64Array.from(pos);
    const nc = P0.length / 3;
    const keep = p.relax && count > 0 && nc > count ? sampleEliminate(P0, count, Math.cbrt(vol / count) * 0.6) : Int32Array.from({ length: Math.min(nc, count) }, (_, i) => i);
    const out = new Geometry({ positions: Array.from(keep).flatMap((k) => [P0[k * 3], P0[k * 3 + 1], P0[k * 3 + 2]]) });
    return out;
  },
});

// ---------------------------------------------------------------- copy to points

const XFORM_ATTRIBS = new Set(['P', 'N', 'v', 'up', 'orient', 'pscale', 'scale', 'rot', 'trans', 'pivot', 'transform', 'Alpha', 'sourceprim', 'variant']);

/** Instance transform for template point i (Houdini attribute conventions). */
export function pointTransform(t: Geometry, i: number): Mat4 {
  const Pd = t.P;
  const get = (n: string) => t.points.get(n);
  const pos: Vec3 = [Pd[i * 3], Pd[i * 3 + 1], Pd[i * 3 + 2]];
  const tr = get('trans');
  if (tr && tr.size === 3) { const v = tr.get(i) as number[]; pos[0] += v[0]; pos[1] += v[1]; pos[2] += v[2]; }
  let R: Mat4;
  const o = get('orient');
  if (o && o.size === 4) R = m4fromQuat(o.get(i) as any);
  else {
    const N = get('N') ?? get('v');
    const up = get('up');
    if (N && N.size === 3) {
      const d = N.get(i) as number[];
      R = Math.hypot(d[0], d[1], d[2]) > 1e-12 ? lookAtBasis(d as Vec3, up && up.size === 3 ? (up.get(i) as Vec3) : [0, 1, 0]) : m4scale(1, 1, 1);
    } else R = m4scale(1, 1, 1);
  }
  const rot = get('rot');
  if (rot && rot.size === 4) R = m4mul(R, m4fromQuat(rot.get(i) as any));
  const ps = get('pscale'), sc = get('scale');
  const s = ps ? (ps.get(i) as number) : 1;
  const sv = sc && sc.size === 3 ? (sc.get(i) as number[]) : [1, 1, 1];
  let M = m4mul(m4translate(pos[0], pos[1], pos[2]), m4mul(R, m4scale(s * sv[0], s * sv[1], s * sv[2])));
  const pv = get('pivot');
  if (pv && pv.size === 3) { const v = pv.get(i) as number[]; M = m4mul(M, m4translate(-v[0], -v[1], -v[2])); }
  return M;
}

function repeatTable(t: AttribTable, reps: { src: Int32Array }[]): AttribTable {
  let total = 0;
  for (const r of reps) total += r.src.length;
  const idx = new Int32Array(total);
  let o = 0;
  for (const r of reps) { idx.set(r.src, o); o += r.src.length; }
  return t.gather(idx);
}

defineNode({
  type: 'copy_to_points',
  category: 'copy',
  packed: 'keep',
  summary: 'Instance geometry onto points using P, orient | N+up, pscale, scale, rot, pivot, trans. Template point attributes (Cd…) are copied over. pack:true makes packed instances (cheap at millions).',
  aliases: ['copytopoints', 'instance', 'copy_to_pts'],
  description:
    'pack:false (default) makes real copies. pack:true makes one packed prim per template point: an anchor point at the instance position ' +
    'carrying the template point attributes, referencing the shared source with the instance rotation/scale (no geometry is copied). ' +
    'Packed instances render, export to glb (EXT_mesh_gpu_instancing) and usda (PointInstancer), survive transform/merge/delete/attribute ' +
    'nodes, and are expanded automatically for nodes that need polygons (or explicitly with unpack). ' +
    'Variants: variants "name" (split the source by prim name) or "piece" (by connectivity), or piece_attrib for any prim attribute; ' +
    'the template point attribute variant_attrib picks one per copy (an int index into the pieces, sorted by value for attributes, ' +
    'or the exact value, e.g. a string name); without that attribute the pieces cycle.',
  inputs: [{ name: 'geo', desc: 'geometry to copy' }, { name: 'points', desc: 'template points' }],
  params: {
    group: P.group('point', 'template points to use ("" = all)'),
    pack: { type: 'bool', default: false, desc: 'output packed instances (one point + one packed prim per copy, sharing the source) instead of real copies', aliases: ['pack_and_instance', 'packed'] },
    copy_attribs: { type: 'string', default: '*', desc: 'template point attributes copied onto the copies (pattern; transform attributes are always excluded)' },
    copy_attrib: { type: 'string', default: 'copynum', desc: 'prim int attribute with the copy index ("" = none)' },
    variants: { type: 'enum', options: ['none', 'name', 'piece'], default: 'none', desc: 'split the source into variants: name = by prim "name", piece = by connectivity (none = only when piece_attrib is set)' },
    piece_attrib: { type: 'string', default: '', desc: 'variants: source prim attribute that splits the geometry into pieces (e.g. "name" or "class")' },
    variant_attrib: { type: 'string', default: 'variant', desc: 'variants: template point attribute choosing a piece (int index into sorted piece values, or the exact value)' },
  },
  outputs: 'prim copynum; template point attributes on copied points (pack: on the instance anchor points)',
  example: { type: 'copy_to_points', in: ['trees', 'pts'], params: { pack: true, variants: 'name', variant_attrib: 'variant' } },
  cook: ({ input, p }) => {
    const src = input(0), t = input(1);
    const sel = mask(t, 'point', p.group);
    const tpts: number[] = [];
    for (let i = 0; i < t.numPoints; i++) if (!sel || sel[i]) tpts.push(i);
    if (!tpts.length || (!src.numPoints && !src.volumes.length)) return new Geometry();
    // variants
    let pieceOf: ((i: number) => Geometry) | null = null;
    let pieceKey: ((i: number) => any) | null = null;
    let subsets: Map<any, Geometry> | null = null;
    const splitAttr = p.variants === 'name' ? 'name' : p.variants === 'piece' ? '' : p.piece_attrib;
    if (p.variants === 'piece' || splitAttr) {
      let values: any[];
      subsets = new Map<any, Geometry>();
      if (!splitAttr) {
        // connectivity pieces, numbered 0.. in the order of their first prim
        const conn = connectivity(src);
        const order: number[] = [], index = new Map<number, number>();
        for (let pr = 0; pr < src.numPrims; pr++) { const c = conn.primClass[pr]; if (c >= 0 && !index.has(c)) { index.set(c, order.length); order.push(c); } }
        values = order.map((_, k) => k);
        order.forEach((c, k) => subsets!.set(k, src.subsetPrims(Uint8Array.from(conn.primClass, (x) => (x === c ? 1 : 0)))));
      } else {
        const pa = src.prims.get(splitAttr);
        if (!pa) throw new NodeError(p.variants === 'name' ? 'variants "name": the source has no prim attribute "name" (set it with attrib_create or name pieces before merging)' : `piece_attrib "${splitAttr}" not on source prims`);
        values = [...new Set(Array.from({ length: src.numPrims }, (_, i) => pa.get(i) as any))].sort((a: any, b: any) => (a < b ? -1 : a > b ? 1 : 0));
        for (const v of values) subsets.set(v, src.subsetPrims(Uint8Array.from({ length: src.numPrims }, (_, i) => (pa.get(i) === v ? 1 : 0))));
      }
      const va = t.points.get(p.variant_attrib);
      pieceKey = (i) => {
        if (!values.length) return undefined;
        if (!va) return values[i % values.length];
        const v = va.get(i) as any;
        if (subsets!.has(v)) return v;
        if (typeof v === 'number') return values[((Math.floor(v) % values.length) + values.length) % values.length];
        return undefined;
      };
      pieceOf = (i) => subsets!.get(pieceKey!(i)) ?? new Geometry();
    }
    const copyNames = new Set<string>();
    const pats = String(p.copy_attribs).split(/[\s,]+/).filter(Boolean);
    const matches = (n: string) => pats.some((pt) => !pt.startsWith('^') && new RegExp('^' + pt.replace(/\*/g, '.*') + '$').test(n)) && !pats.some((pt) => pt.startsWith('^') && new RegExp('^' + pt.slice(1).replace(/\*/g, '.*') + '$').test(n));
    for (const n of t.points.names()) if (!XFORM_ATTRIBS.has(n) && matches(n)) copyNames.add(n);

    if (p.pack) {
      const sources = subsets ? [...subsets.values()] : [src];
      const keyIndex = subsets ? new Map([...subsets.keys()].map((k, i) => [k, i])) : null;
      const pick = (ti: number) => (keyIndex ? keyIndex.get(pieceKey!(ti)) ?? -1 : 0);
      return packedCopies(src, sources, pick, t, tpts, copyNames, p.copy_attrib);
    }

    if (!pieceOf) {
      // fast path: one source repeated
      const np = src.numPoints, nv = src.numVertices, npr = src.numPrims, nc = tpts.length;
      const out = Object.create(Geometry.prototype) as Geometry;
      const rep = (n: number) => tpts.map(() => ({ src: Int32Array.from({ length: n }, (_, i) => i) }));
      out.points = repeatTable(src.points, rep(np));
      out.vertices = repeatTable(src.vertices, rep(nv));
      out.prims = repeatTable(src.prims, rep(npr));
      out.detail = src.detail.clone();
      out.primStart = new Int32Array(npr * nc + 1);
      out.vertexPoint = new Int32Array(nv * nc);
      out.primClosed = new Uint8Array(npr * nc);
      out.pointGroups = new Map([...src.pointGroups].map(([k, m]) => { const o = new Uint8Array(np * nc); for (let c = 0; c < nc; c++) o.set(m, c * np); return [k, o]; }));
      out.primGroups = new Map([...src.primGroups].map(([k, m]) => { const o = new Uint8Array(npr * nc); for (let c = 0; c < nc; c++) o.set(m, c * npr); return [k, o]; }));
      out.vertexGroups = new Map([...src.vertexGroups].map(([k, m]) => { const o = new Uint8Array(nv * nc); for (let c = 0; c < nc; c++) o.set(m, c * nv); return [k, o]; }));
      out.edgeGroups = new Map([...src.edgeGroups].map(([k, e]) => { const o = new EdgeSet(); for (let c = 0; c < nc; c++) for (const [a, b] of e) o.add(a + c * np, b + c * np); return [k, o]; }));
      out.volumes = [];
      // packed prims in the source: repeated, each copy composing its transform into theirs
      if (src.primKind) {
        out.primKind = new Uint8Array(npr * nc);
        out.packedSource = new Int32Array(npr * nc);
        out.packedXform = new Float64Array(npr * nc * 9);
        out.packedSources = src.packedSources.slice();
        for (let c = 0; c < nc; c++) {
          out.primKind.set(src.primKind, c * npr);
          out.packedSource.set(src.packedSource!, c * npr);
          out.packedXform.set(src.packedXform!, c * npr * 9);
        }
      }
      const Pd = out.P, sP = src.P;
      const NA = out.points.get('N'), VNA = out.vertices.get('N');
      const vecA = ['v', 'up'].map((n) => out.points.get(n)).filter((a) => a && a.size === 3) as Attribute[];
      const cn = p.copy_attrib ? (out.prims.add(p.copy_attrib, 'int', 1).data as Int32Array) : null;
      const tmp = [0, 0, 0];
      tpts.forEach((ti, c) => {
        const M = pointTransform(t, ti), Nm = m4normalMatrix(M);
        for (let i = 0; i < np; i++) m4apply(M, sP[i * 3], sP[i * 3 + 1], sP[i * 3 + 2], Pd, (c * np + i) * 3);
        for (const [A, cnt] of [[NA, np], [VNA, nv]] as [Attribute | undefined, number][]) {
          if (!A || A.size !== 3) continue;
          const d = A.data as Float64Array;
          for (let i = c * cnt; i < (c + 1) * cnt; i++) {
            m4applyDir(Nm, d[i * 3], d[i * 3 + 1], d[i * 3 + 2], tmp);
            const l = Math.hypot(tmp[0], tmp[1], tmp[2]) || 1;
            d[i * 3] = tmp[0] / l; d[i * 3 + 1] = tmp[1] / l; d[i * 3 + 2] = tmp[2] / l;
          }
        }
        for (const A of vecA) { const d = A.data as Float64Array; for (let i = c * np; i < (c + 1) * np; i++) m4applyDir(M, d[i * 3], d[i * 3 + 1], d[i * 3 + 2], d, i * 3); }
        for (let v = 0; v < nv; v++) out.vertexPoint[c * nv + v] = src.vertexPoint[v] + c * np;
        for (let pr = 0; pr < npr; pr++) { out.primStart[c * npr + pr] = src.primStart[pr] + c * nv; out.primClosed[c * npr + pr] = src.primClosed[pr]; }
        if (cn) cn.fill(c, c * npr, (c + 1) * npr);
        if (out.primKind) composePackedXforms(out, M, null, c * npr, (c + 1) * npr);
      });
      out.primStart[npr * nc] = nv * nc;
      for (const n of copyNames) {
        const ta = t.points.get(n)!;
        const a = out.points.add(n, ta.type, ta.size);
        tpts.forEach((ti, c) => { const v = ta.get(ti); for (let i = c * np; i < (c + 1) * np; i++) a.set(i, v); });
        if (n === 'Cd') { out.prims.delete('Cd'); out.vertices.delete('Cd'); }
      }
      return out;
    }
    // variants path: transform each chosen piece
    const parts: Geometry[] = [];
    tpts.forEach((ti, c) => {
      const piece = pieceOf!(ti);
      if (!piece.numPoints) return;
      const M = pointTransform(t, ti), Nm = m4normalMatrix(M);
      const g = piece.clone();
      const Pd = g.P;
      for (let i = 0; i < g.numPoints; i++) m4apply(M, Pd[i * 3], Pd[i * 3 + 1], Pd[i * 3 + 2], Pd, i * 3);
      if (g.primKind) composePackedXforms(g, M);
      for (const cls of ['point', 'vertex'] as const) {
        const A = g.table(cls).get('N');
        if (!A || A.size !== 3) continue;
        const d = A.data as Float64Array;
        for (let i = 0; i < A.count; i++) {
          m4applyDir(Nm, d[i * 3], d[i * 3 + 1], d[i * 3 + 2], d, i * 3);
          const l = Math.hypot(d[i * 3], d[i * 3 + 1], d[i * 3 + 2]) || 1;
          d[i * 3] /= l; d[i * 3 + 1] /= l; d[i * 3 + 2] /= l;
        }
      }
      if (p.copy_attrib) (g.prims.add(p.copy_attrib, 'int', 1).data as Int32Array).fill(c);
      for (const n of copyNames) {
        const ta = t.points.get(n)!;
        const a = g.points.add(n, ta.type, ta.size);
        const v = ta.get(ti);
        for (let i = 0; i < g.numPoints; i++) a.set(i, v);
      }
      parts.push(g);
    });
    return Geometry.merge(parts);
  },
});

/**
 * Instance transforms of template points, written without allocations (1M points in a few tens of ms):
 * pos (3 per point) = translation, X (9 per point) = rotation·scale, column-major. Same conventions and the same
 * arithmetic as pointTransform: P + trans; orient, else N (or v) with up, else identity; then rot; times
 * pscale·scale; pivot moves the translation by -(R·S)·pivot.
 */
export function instanceXforms(t: Geometry, tpts: ArrayLike<number>): { pos: Float64Array; X: Float64Array } {
  const n = tpts.length, pos = new Float64Array(n * 3), X = new Float64Array(n * 9);
  const get = (name: string) => t.points.get(name);
  const f = (a: Attribute | undefined, size: number) => (a && a.size === size && a.type !== 'string' && !a.isArray ? (a.data as Float64Array) : null);
  const Pd = t.P, tr = f(get('trans'), 3), orient = f(get('orient'), 4);
  const NA = get('N') ?? get('v'), N = f(NA, 3), up = f(get('up'), 3), rot = f(get('rot'), 4);
  const psA = get('pscale'), ps = psA && psA.size === 1 && psA.type !== 'string' && !psA.isArray ? (psA.data as Float64Array) : null;
  const sc = f(get('scale'), 3), pv = f(get('pivot'), 3);
  const R = new Float64Array(9), Q = new Float64Array(9);
  const quat = (d: Float64Array, o: number, out: Float64Array) => {
    // m4fromQuat (no normalisation, as there)
    const x = d[o], y = d[o + 1], z = d[o + 2], w = d[o + 3];
    out[0] = 1 - 2 * (y * y + z * z); out[1] = 2 * (x * y + z * w); out[2] = 2 * (x * z - y * w);
    out[3] = 2 * (x * y - z * w); out[4] = 1 - 2 * (x * x + z * z); out[5] = 2 * (y * z + x * w);
    out[6] = 2 * (x * z + y * w); out[7] = 2 * (y * z - x * w); out[8] = 1 - 2 * (x * x + y * y);
  };
  for (let k = 0; k < n; k++) {
    const i = tpts[k];
    let px = Pd[i * 3], py = Pd[i * 3 + 1], pz = Pd[i * 3 + 2];
    if (tr) { px += tr[i * 3]; py += tr[i * 3 + 1]; pz += tr[i * 3 + 2]; }
    R[0] = 1; R[1] = 0; R[2] = 0; R[3] = 0; R[4] = 1; R[5] = 0; R[6] = 0; R[7] = 0; R[8] = 1;
    if (orient) quat(orient, i * 4, R);
    else if (N) {
      // lookAtBasis(N, up): z = N, x = up × z (fallback axis when parallel), y = z × x
      const dx = N[i * 3], dy = N[i * 3 + 1], dz = N[i * 3 + 2];
      if (Math.hypot(dx, dy, dz) > 1e-12) {
        const l = Math.hypot(dx, dy, dz);
        const zx = l > 1e-20 ? dx / l : 0, zy = l > 1e-20 ? dy / l : 0, zz = l > 1e-20 ? dz / l : 0;
        if (Math.hypot(zx, zy, zz) !== 0) {
          const ux = up ? up[i * 3] : 0, uy = up ? up[i * 3 + 1] : 1, uz = up ? up[i * 3 + 2] : 0;
          let xx = uy * zz - uz * zy, xy = uz * zx - ux * zz, xz = ux * zy - uy * zx;
          if (Math.hypot(xx, xy, xz) < 1e-8) {
            const ax = Math.abs(zy) < 0.9 ? 0 : 1, ay = Math.abs(zy) < 0.9 ? 1 : 0;
            xx = ay * zz - 0 * zy; xy = 0 * zx - ax * zz; xz = ax * zy - ay * zx;
          }
          const xl = Math.hypot(xx, xy, xz);
          if (xl > 1e-20) { xx /= xl; xy /= xl; xz /= xl; } else { xx = 0; xy = 0; xz = 0; }
          R[0] = xx; R[1] = xy; R[2] = xz;
          R[3] = zy * xz - zz * xy; R[4] = zz * xx - zx * xz; R[5] = zx * xy - zy * xx;
          R[6] = zx; R[7] = zy; R[8] = zz;
        }
      }
    }
    if (rot) {
      quat(rot, i * 4, Q);
      // R := R · Q, column by column
      const r0 = R[0], r1 = R[1], r2 = R[2], r3 = R[3], r4 = R[4], r5 = R[5], r6 = R[6], r7 = R[7], r8 = R[8];
      for (let c = 0; c < 3; c++) {
        const q0 = Q[c * 3], q1 = Q[c * 3 + 1], q2 = Q[c * 3 + 2];
        R[c * 3] = r0 * q0 + r3 * q1 + r6 * q2;
        R[c * 3 + 1] = r1 * q0 + r4 * q1 + r7 * q2;
        R[c * 3 + 2] = r2 * q0 + r5 * q1 + r8 * q2;
      }
    }
    const s = ps ? ps[i] : 1;
    const sx = s * (sc ? sc[i * 3] : 1), sy = s * (sc ? sc[i * 3 + 1] : 1), sz = s * (sc ? sc[i * 3 + 2] : 1);
    const o = k * 9;
    X[o] = R[0] * sx; X[o + 1] = R[1] * sx; X[o + 2] = R[2] * sx;
    X[o + 3] = R[3] * sy; X[o + 4] = R[4] * sy; X[o + 5] = R[5] * sy;
    X[o + 6] = R[6] * sz; X[o + 7] = R[7] * sz; X[o + 8] = R[8] * sz;
    if (pv) {
      const vx = -pv[i * 3], vy = -pv[i * 3 + 1], vz = -pv[i * 3 + 2];
      px += X[o] * vx + X[o + 3] * vy + X[o + 6] * vz;
      py += X[o + 1] * vx + X[o + 4] * vy + X[o + 7] * vz;
      pz += X[o + 2] * vx + X[o + 5] * vy + X[o + 8] * vz;
    }
    pos[k * 3] = px; pos[k * 3 + 1] = py; pos[k * 3 + 2] = pz;
  }
  return { pos, X };
}

/**
 * Packed copy_to_points: one anchor point + one packed prim per copy. Template attributes go onto the anchors; the
 * attributes they replace in an unpacked copy (point attributes of the same name, and every Cd) are removed from
 * the shared sources once, so unpacking gives the same result as pack:false.
 */
function packedCopies(
  src: Geometry, sources: Geometry[], pick: (ti: number) => number, t: Geometry, tpts: number[], copyNames: Set<string>, copyAttrib: string,
): Geometry {
  const strip = (g: Geometry) => {
    const kill = [...copyNames].filter((n) => g.points.has(n) || (n === 'Cd' && g.findAttrib('Cd')));
    if (!kill.length) return g;
    const c = g.clone();
    for (const n of kill) {
      c.points.delete(n);
      if (n === 'Cd') { c.prims.delete('Cd'); c.vertices.delete('Cd'); }
    }
    return c;
  };
  const srcs = sources.map(strip);
  const chosen: number[] = [], copyIdx: number[] = [], srcIdx: number[] = [];
  tpts.forEach((ti, c) => {
    const s = pick(ti);
    if (s < 0 || !srcs[s] || !srcs[s].numPoints) return; // empty piece: no copy (as unpacked)
    chosen.push(ti); copyIdx.push(c); srcIdx.push(s);
  });
  const n = chosen.length;
  const { pos, X } = instanceXforms(t, chosen);
  const out = Object.create(Geometry.prototype) as Geometry;
  out.points = new AttribTable(n);
  (out.points.add('P', 'float', 3).data as Float64Array).set(pos);
  for (const name of copyNames) out.points.set(name, t.points.get(name)!.gather(chosen));
  out.vertices = new AttribTable(n);
  out.prims = new AttribTable(n);
  if (copyAttrib) (out.prims.add(copyAttrib, 'int', 1).data as Int32Array).set(copyIdx);
  out.detail = src.detail.clone();
  out.primStart = Int32Array.from({ length: n + 1 }, (_, i) => i);
  out.vertexPoint = Int32Array.from({ length: n }, (_, i) => i);
  out.primClosed = new Uint8Array(n);
  out.pointGroups = new Map();
  out.primGroups = new Map();
  out.vertexGroups = new Map();
  out.edgeGroups = new Map();
  out.volumes = [];
  out.primKind = new Uint8Array(n).fill(1);
  out.packedSource = Int32Array.from(srcIdx);
  out.packedXform = X;
  out.packedSources = srcs;
  return out.compactPackedSources();
}

export { m4basis };
