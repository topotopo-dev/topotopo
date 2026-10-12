// Packed primitives: pack pieces into instances, unpack instances into geometry (see src/core/packed.ts).
import { AttribTable, Geometry } from '../core/geometry.ts';
import type { AttribClass, Attribute } from '../core/geometry.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';
import { connectivity } from '../core/topology.ts';
import { geoContentHash } from '../core/geohash.ts';
import { DEFAULT_TRANSFER, expandPacked } from '../core/packed.ts';
import type { Vec3 } from '../core/math.ts';
import { P, mask } from './util.ts';

/** Is attribute a constant over all its elements? */
function uniform(a: Attribute): boolean {
  const n = a.count;
  if (n <= 1) return true;
  if (a.isArray) {
    const f = JSON.stringify(a.getArray(0));
    for (let i = 1; i < n; i++) if (JSON.stringify(a.getArray(i)) !== f) return false;
    return true;
  }
  const d = a.data, s = a.size;
  for (let i = 1; i < n; i++) for (let c = 0; c < s; c++) if (d[i * s + c] !== d[c]) return false;
  return true;
}

/** Value of an attribute for the anchor: the constant, else the average (float) or the first element. */
function anchorValue(a: Attribute): any {
  if (a.count === 0) return a.def;
  if (a.isArray || a.type !== 'float' || uniform(a)) return a.get(0);
  const s = a.size, d = a.data as Float64Array, n = a.count, acc = new Array(s).fill(0);
  for (let i = 0; i < n; i++) for (let c = 0; c < s; c++) acc[c] += d[i * s + c];
  const avg = acc.map((x) => x / n);
  return s === 1 ? avg[0] : avg;
}

defineNode({
  type: 'pack',
  category: 'copy',
  packed: 'keep',
  summary: 'Turn pieces into packed instances: one anchor point + packed prim per piece, referencing a shared source (identical pieces share one source).',
  aliases: ['packgeometry', 'pack_geometry', 'assemble'],
  description:
    'Each piece becomes a source geometry moved so its pivot is at the origin; the anchor point sits at the pivot, so nothing moves. ' +
    'Attributes listed in "carry" go onto the instance (prim attributes onto the packed prim, point/vertex attributes onto the anchor point): ' +
    'a value that is constant over the piece moves out of the source (so pieces that differ only by colour or name share a source), ' +
    'otherwise the anchor gets the average (floats) or first value and the source keeps its own. Points not used by any prim stay ' +
    'unpacked unless by = "all". Packed prims are drawn, transformed, merged and exported as instances; unpack turns them back into polygons.',
  inputs: [{ name: 'geo', desc: 'geometry to pack' }],
  params: {
    by: { type: 'enum', options: ['connectivity', 'name', 'attrib', 'all'], default: 'connectivity', desc: 'pieces: connected parts, prim "name" values, values of a prim attribute ("attrib"), or everything as one instance ("all", Houdini Pack)' },
    attrib: { type: 'string', default: '', desc: 'by = attrib: prim attribute whose values define the pieces' },
    pivot: { type: 'enum', options: ['centroid', 'origin', 'bbox_min', 'bbox_center_bottom'], default: 'centroid', desc: 'instance pivot per piece: bbox centre, world origin, bbox minimum, or centre of the bbox bottom (trees, buildings)' },
    carry: { type: 'string', default: 'name Cd material', desc: 'attributes carried onto the instances (names or patterns)' },
    source_dedup: { type: 'bool', default: true, desc: 'pieces with identical content (after moving to their pivot) share one source' },
  },
  outputs: 'packed prims (one per piece) on anchor points; carried attributes on the anchor point / packed prim',
  example: { type: 'pack', in: ['fractured'], params: { by: 'connectivity', pivot: 'centroid' } },
  cook: ({ input, p }) => {
    const g = input(0);
    if (!g.numPrims && !g.numPoints) return g;
    const n = g.numPrims;
    // piece key per prim
    let key: ArrayLike<any>;
    if (p.by === 'all') key = new Int32Array(n);
    else if (p.by === 'connectivity') key = connectivity(g).primClass;
    else {
      const name = p.by === 'name' ? 'name' : p.attrib;
      if (!name) throw new NodeError('by = "attrib" needs the attrib param (a prim attribute name)');
      const a = g.prims.get(name);
      if (!a) throw new NodeError(`no prim attribute "${name}" to pack by (prim attributes: ${g.prims.names().join(', ') || 'none'})`);
      key = Array.from({ length: n }, (_, i) => JSON.stringify(a.get(i)));
    }
    const order: any[] = [], members = new Map<any, number[]>();
    for (let pr = 0; pr < n; pr++) {
      const k = key[pr];
      let m = members.get(k);
      if (!m) { m = []; members.set(k, m); order.push(k); }
      m.push(pr);
    }
    const want = String(p.carry ?? '').split(/[\s,]+/).filter(Boolean).map((s) => new RegExp('^' + s.replace(/[.+$()|[\]\\{}^]/g, '\\$&').replace(/\*/g, '.*') + '$'));
    const carried = (name: string) => name !== 'P' && want.some((r) => r.test(name));
    const sources: Geometry[] = [];
    const byHash = new Map<string, number>();
    const pivots: number[] = [], srcIdx: number[] = [];
    const pointVals = new Map<string, { a: Attribute; vals: any[] }>(), primVals = new Map<string, { a: Attribute; vals: any[] }>();
    const isolated = new Uint8Array(g.numPoints).fill(1);
    for (let v = 0; v < g.numVertices; v++) isolated[g.vertexPoint[v]] = 0;
    const hasIsolated = isolated.includes(1);
    const pieces = p.by === 'all' ? [null] : order;
    for (let k = 0; k < pieces.length; k++) {
      let piece: Geometry;
      if (p.by === 'all') piece = g.clone();
      else {
        const m = new Uint8Array(n);
        for (const pr of members.get(pieces[k])!) m[pr] = 1;
        piece = g.subsetPrims(m, true);
      }
      piece.volumes = [];
      // pivot
      const b = piece.bbox();
      const c: Vec3 = p.pivot === 'origin' ? [0, 0, 0]
        : p.pivot === 'bbox_min' ? [b.min[0], b.min[1], b.min[2]]
        : [(b.min[0] + b.max[0]) / 2, p.pivot === 'bbox_center_bottom' ? b.min[1] : (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
      const Pd = piece.P;
      if (c[0] || c[1] || c[2]) for (let i = 0; i < Pd.length; i += 3) { Pd[i] -= c[0]; Pd[i + 1] -= c[1]; Pd[i + 2] -= c[2]; }
      pivots.push(c[0], c[1], c[2]);
      // carried attributes: prim class → packed prim, point/vertex → anchor point; constants move out of the source
      const names = new Set<string>();
      for (const cls of ['prim', 'point', 'vertex'] as AttribClass[]) for (const name of piece.table(cls).names()) if (carried(name)) names.add(name);
      for (const name of names) {
        const cls: AttribClass = piece.prims.has(name) ? 'prim' : piece.points.has(name) ? 'point' : 'vertex';
        const a = piece.table(cls).get(name)!;
        const dest = cls === 'prim' ? primVals : pointVals;
        let e = dest.get(name);
        if (!e) { e = { a, vals: [] }; dest.set(name, e); }
        e.vals[k] = anchorValue(a);
        if (cls !== 'vertex' && uniform(a)) piece.table(cls).delete(name);
      }
      let si = -1;
      if (p.source_dedup) {
        const h = geoContentHash(piece);
        si = byHash.get(h) ?? -1;
        if (si < 0) byHash.set(h, sources.length);
      }
      if (si < 0) { si = sources.length; sources.push(piece); }
      srcIdx.push(si);
    }
    // output: anchors + packed prims (+ isolated points, kept as they are)
    const count = srcIdx.length;
    const out = Object.create(Geometry.prototype) as Geometry;
    out.points = new AttribTable(count);
    (out.points.add('P', 'float', 3).data as Float64Array).set(pivots);
    out.vertices = new AttribTable(count);
    out.prims = new AttribTable(count);
    for (const [tbl, vals] of [[out.points, pointVals], [out.prims, primVals]] as const)
      for (const [name, { a, vals: vs }] of vals) {
        const dst = tbl.add(name, a.type, a.size, a.def);
        for (let k = 0; k < count; k++) if (vs[k] !== undefined) dst.set(k, vs[k]);
        dst.compact();
      }
    out.detail = g.detail.clone();
    out.primStart = Int32Array.from({ length: count + 1 }, (_, i) => i);
    out.vertexPoint = Int32Array.from({ length: count }, (_, i) => i);
    out.primClosed = new Uint8Array(count);
    out.pointGroups = new Map();
    out.primGroups = new Map();
    out.vertexGroups = new Map();
    out.edgeGroups = new Map();
    out.volumes = g.volumes.slice();
    out.primKind = new Uint8Array(count).fill(1);
    out.packedSource = Int32Array.from(srcIdx);
    out.packedXform = new Float64Array(count * 9);
    for (let k = 0; k < count; k++) { out.packedXform[k * 9] = 1; out.packedXform[k * 9 + 4] = 1; out.packedXform[k * 9 + 8] = 1; }
    out.packedSources = sources;
    if (!count) out.clearPacked();
    if (hasIsolated && p.by !== 'all') {
      const loose = g.subsetPrims(new Uint8Array(n), false).subsetPoints(isolated);
      loose.volumes = [];
      return Geometry.merge([loose, out]);
    }
    return out;
  },
});

defineNode({
  type: 'unpack',
  category: 'copy',
  packed: 'keep',
  summary: 'Expand packed instances into real geometry (transformed copies of their sources); anchor attributes such as Cd and name carry over.',
  aliases: ['unpackgeometry', 'unpack_geometry', 'unpack_packed'],
  description:
    'Instances are expanded in prim order after the other prims; source attributes and groups come along, N/v/up/orient are rotated. ' +
    'transfer_attributes copies anchor point / packed prim attributes onto the unpacked points / prims where the source does not define them ' +
    '(Cd and Alpha: in any class), so a source\'s own colours win and an anchor colour tints sources without colour. Prim and point groups of the ' +
    'packed prims / anchors extend over the unpacked elements. Nodes that need polygons unpack automatically (with a warning); use this node to ' +
    'choose what is transferred, to unpack a subset, or to limit the count while previewing.',
  inputs: [{ name: 'geo', desc: 'geometry with packed prims' }],
  params: {
    group: P.group('prim', 'packed prims to unpack ("" = all); the others stay packed'),
    transfer_attributes: { type: 'string', default: DEFAULT_TRANSFER, desc: 'anchor point / packed prim attributes copied onto the unpacked points / prims (names or patterns, "*" = all, "" = none)', aliases: ['transfer', 'attributes'] },
    limit: { type: 'int', default: 0, min: 0, desc: 'unpack at most this many instances (in prim order) and drop the rest of the selection; 0 = all', aliases: ['max_instances'] },
    piece_attrib: { type: 'string', default: '', desc: 'prim int attribute receiving the packed prim number of every unpacked prim (-1 on prims that were not packed; "" = none)' },
    recursive: { type: 'bool', default: false, desc: 'also unpack instances inside the sources (false = one level, as in Houdini: nested instances become packed prims)' },
  },
  outputs: 'unpacked geometry; transferred anchor attributes; optional prim int piece_attrib',
  example: { type: 'unpack', in: ['forest'], params: { transfer_attributes: 'Cd name', piece_attrib: 'piece' } },
  cook: ({ input, p, warn }) => {
    const g = input(0);
    if (!g.hasPacked()) return g;
    const r = expandPacked(g, { group: mask(g, 'prim', p.group), transfer: p.transfer_attributes, limit: p.limit, pieceAttrib: p.piece_attrib, recursive: !!p.recursive });
    for (const n of r.notes) warn(n);
    return r.geo;
  },
});
