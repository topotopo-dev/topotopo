// beam: straight members between two points (posts, rafters, joists, struts, braces), the architecture workhorse.
// A profile (a rectangle, or any closed curve on input 1) is placed across each beam in a frame from the beam's
// direction and an up vector, and swept straight from start to end: side faces, optional caps, uv in metres.
import { GeoBuilder } from '../core/geometry.ts';
import type { Geometry } from '../core/geometry.ts';
import { detectPlane, toPolygons } from '../core/manifold.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** One beam: its end points (and the input points they come from, for provenance), and the input prim it follows. */
interface Span { a: V3; b: V3; pa: number; pb: number; prim: number }

/** Spans from the input: every segment of its curves / polygon edges, or consecutive point pairs (0-1, 2-3 …). */
function spansOf(g: Geometry, from: string): Span[] {
  const P = g.P, pt = (i: number): V3 => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
  const out: Span[] = [];
  const hasLines = (() => { for (let p = 0; p < g.numPrims; p++) if (g.primSize(p) >= 2 && !(g.primKind && g.primKind[p] === 1)) return true; return false; })();
  if (from === 'segments' || (from === 'auto' && hasLines)) {
    for (let p = 0; p < g.numPrims; p++) {
      if (g.primKind && g.primKind[p] === 1) continue;
      const s = g.primStart[p], e = g.primStart[p + 1], n = e - s;
      if (n < 2) continue;
      const segs = g.primClosed[p] && n >= 3 ? n : n - 1;
      for (let k = 0; k < segs; k++) {
        const ia = g.vertexPoint[s + k], ib = g.vertexPoint[s + ((k + 1) % n)];
        out.push({ a: pt(ia), b: pt(ib), pa: ia, pb: ib, prim: p });
      }
    }
  } else {
    for (let i = 0; i + 1 < g.numPoints; i += 2) out.push({ a: pt(i), b: pt(i + 1), pa: i, pb: i + 1, prim: -1 });
  }
  return out;
}

/** The profile loops (2D, counter-clockwise) from input 1, or the rectangle. */
function profilesOf(profile: Geometry | null, size: number[]): [number, number][][] {
  if (!profile) {
    const w = size[0] / 2, h = size[1] / 2;
    return [[[-w, -h], [w, -h], [w, h], [-w, h]]];
  }
  const { polys } = toPolygons(profile, detectPlane(profile));
  const loops = polys.filter((l) => l.length >= 3);
  for (const l of loops) {
    let a = 0;
    for (let i = 0; i < l.length; i++) { const [x0, y0] = l[i], [x1, y1] = l[(i + 1) % l.length]; a += x0 * y1 - x1 * y0; }
    if (a < 0) l.reverse();
  }
  return loops;
}

defineNode({
  type: 'beam',
  category: 'generate',
  summary: 'Beams between two points, between point pairs or along every segment of curves: a rectangle (or any closed profile on input 1) swept straight, with an up vector, caps, uv in metres and a prim name. Posts, rafters, joists, struts, trusses.',
  description:
    'Without input 0 one beam runs from start to end. With input 0 every segment of its curves (polylines, and the ' +
    'edges of polygons) becomes a beam (from "segments"), or, for points only, each consecutive pair (0-1, 2-3 …: from ' +
    '"pairs"); "auto" picks segments when there are curves. The profile lies across the beam: its first axis runs to ' +
    'the side, its second along up projected square to the beam (a beam along up takes +Z, else +X, as up), then roll ' +
    'turns it about the beam. The default profile is a size[0] × size[1] rectangle (width to the side, height up), ' +
    'centred on the line; offset shifts it (offset [0, size[1] / 2] puts the line along the bottom face, e.g. joists ' +
    'resting on a line). A closed curve on input 1 replaces it, drawn flat in any plane (shape2d\'s XZ: x to the side, ' +
    '-z up; XY: x to the side, y up): an I-beam, a channel, a round bar; every closed loop is swept, each capped on its ' +
    'own (switch caps off for hollow sections). extend lengthens the start and end (negative shortens, e.g. by half a ' +
    'post\'s width). uv: along the beam (u) and around the profile (v) in metres × uv_scale; caps are mapped flat. Point ' +
    'attributes of the input (Cd, …) are blended along each beam and prim attributes copied from the curve a beam ' +
    'follows; name (with {index} for the beam number) names every beam\'s prims, "" keeps the curve\'s name.',
  aliases: ['strut', 'post', 'rafter', 'joist', 'brace', 'member', 'lumber', 'girder', 'beams'],
  inputs: [
    { name: 'path', desc: 'optional: curves (each segment a beam) or points (pairs); else start → end', optional: true },
    { name: 'profile', desc: 'optional: a closed cross-section curve, drawn flat (else the size rectangle)', optional: true },
  ],
  params: {
    start: { type: 'vec3', default: [0, 0, 0], desc: 'start point when input 0 is not connected', aliases: ['from', 'p0', 'a'] },
    end: { type: 'vec3', default: [0, 3, 0], desc: 'end point when input 0 is not connected', aliases: ['to', 'p1', 'b'] },
    from: { type: 'enum', options: ['auto', 'segments', 'pairs'], default: 'auto', desc: 'input 0: every curve segment, or consecutive point pairs (auto: segments when there are curves)', aliases: ['mode'] },
    size: { type: 'vec2', default: [0.1, 0.2], min: 0, desc: 'rectangle profile [width to the side, height up] in metres', aliases: ['section', 'dimensions'] },
    up: { type: 'vec3', default: [0, 1, 0], desc: 'which way the profile\'s second axis (the height) faces, projected square to the beam', aliases: ['up_vector'] },
    roll: { type: 'float', default: 0, desc: 'turn the profile about the beam, degrees' },
    offset: { type: 'vec2', default: [0, 0], desc: 'shift of the profile [to the side, up] in metres (the line is its origin)' },
    extend: { type: 'vec2', default: [0, 0], desc: 'lengthen [start, end] along the beam in metres (negative shortens)', aliases: ['overhang', 'extension'] },
    divisions: { type: 'int', default: 1, min: 1, max: 1000, desc: 'segments along the length (for later bending)', aliases: ['segments', 'rows'] },
    caps: { type: 'bool', default: true, desc: 'close both ends', aliases: ['cap', 'end_caps'] },
    uv_scale: { type: 'float', default: 1, min: 0, desc: 'uv units per metre (uv in metres at 1)' },
    name: { type: 'string', default: 'beam', desc: 'prim name of every beam ({index} = the beam number; "" = keep the input curve\'s name)', aliases: ['prim_name'] },
  },
  outputs: 'polygons; prim groups sides, caps; prim string name, prim int beam (the beam number); vertex uv',
  example: {
    nodes: {
      frame: { type: 'curve', params: { points: [[0, 0, 0], [0, 2.4, 0], [3, 2.4, 0], [3, 0, 0]] } },
      posts: { type: 'beam', in: ['frame'], params: { size: [0.12, 0.12], up: [0, 0, 1], name: 'timber_{index}' } },
    },
    output: 'posts',
  },
  cook: (ctx) => {
    const { p, type } = ctx;
    const src = ctx.hasInput(0) ? ctx.input(0) : null;
    const spans = src ? spansOf(src, p.from) : [{ a: p.start as V3, b: p.end as V3, pa: -1, pb: -1, prim: -1 }];
    if (src && !spans.length) throw new NodeError(`${type}: input 0 holds no segment (curves with 2+ points, or point pairs)`, 'connect a curve (each segment a beam) or points in pairs');
    const loops = profilesOf(ctx.hasInput(1) ? ctx.input(1) : null, p.size);
    if (!loops.length) throw new NodeError(`${type}: input 1 holds no closed profile`, 'a closed curve drawn flat: shape2d, circle, curve {closed:true}');
    const roll = (p.roll * Math.PI) / 180, cr = Math.cos(roll), sr = Math.sin(roll);
    const prof = loops.map((l) => l.map(([x, y]) => { const u = x + p.offset[0], v = y + p.offset[1]; return [u * cr - v * sr, u * sr + v * cr] as [number, number]; }));
    // perimeter distance along each loop (v of the side uv)
    const around = prof.map((l) => { const d = [0]; for (let i = 1; i <= l.length; i++) { const a = l[i - 1], b = l[i % l.length]; d.push(d[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1])); } return d; });
    const b = new GeoBuilder(src);
    if (src) for (const n of ['N', 'up', 'orient', 'tangent', 'tangentu', 'tangentv', 'uv']) b.skip.point.add(n);
    if (src) b.skip.vertex.add('uv');
    const uvA = b.attrib('vertex', 'uv', 3);
    const beamA = b.attrib('prim', 'beam', 1, 'int');
    const nameFmt = String(p.name ?? '');
    const nameA = nameFmt ? b.attrib('prim', 'name', 1, 'string', '') : null;
    const sides = b.group('prim', 'sides'), caps = b.group('prim', 'caps');
    const K = Math.max(1, Math.round(p.divisions)), us = p.uv_scale;
    let skipped = 0, index = 0;
    for (const sp of spans) {
      const d = sub(sp.b, sp.a), L0 = len(d);
      if (!(L0 > 1e-12)) { skipped++; continue; }
      const T = unit(d);
      let upv = p.up as V3;
      if (!(len(upv) > 0) || Math.abs(dot(unit(upv), T)) > 0.9999) upv = Math.abs(T[2]) < 0.9999 ? [0, 0, 1] : [1, 0, 0];
      const U = unit(sub(upv, [T[0] * dot(upv, T), T[1] * dot(upv, T), T[2] * dot(upv, T)]));
      const S = cross(U, T);
      const a: V3 = [sp.a[0] - T[0] * p.extend[0], sp.a[1] - T[1] * p.extend[0], sp.a[2] - T[2] * p.extend[0]];
      const L = L0 + p.extend[0] + p.extend[1];
      if (!(L > 1e-12)) { skipped++; continue; }
      const prims: number[] = [];
      prof.forEach((loop, li) => {
        const n = loop.length;
        // rings of points along the beam, blended between the input points it spans
        const rings: number[][] = [];
        for (let k = 0; k <= K; k++) {
          const t = k / K, s = (t * L - p.extend[0]) / L0;
          const c: V3 = [a[0] + T[0] * t * L, a[1] + T[1] * t * L, a[2] + T[2] * t * L];
          const prov = src && sp.pa >= 0 ? { i: [sp.pa, sp.pb], w: [1 - Math.min(1, Math.max(0, s)), Math.min(1, Math.max(0, s))] } : null;
          rings.push(loop.map(([x, y]) => b.addPoint(c[0] + S[0] * x + U[0] * y, c[1] + S[1] * x + U[1] * y, c[2] + S[2] * x + U[2] * y, prov)));
        }
        const dist = around[li];
        for (let k = 0; k < K; k++) {
          for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            const pr = b.addPrim([rings[k][i], rings[k][j], rings[k + 1][j], rings[k + 1][i]], true, sp.prim);
            const u0 = (k / K) * L * us, u1 = ((k + 1) / K) * L * us, v0 = dist[i] * us, v1 = dist[i + 1] * us;
            const base = b.numVertices - 4;
            uvA.set(base, [u0, v0, 0]); uvA.set(base + 1, [u0, v1, 0]); uvA.set(base + 2, [u1, v1, 0]); uvA.set(base + 3, [u1, v0, 0]);
            sides.add(pr);
            prims.push(pr);
          }
        }
        if (p.caps) {
          // the end cap faces along the beam (the profile's own winding), the start cap against it
          const end = b.addPrim(rings[K], true, sp.prim);
          for (let i = 0; i < n; i++) uvA.set(b.numVertices - n + i, [loop[i][0] * us, loop[i][1] * us, 0]);
          const startRing = rings[0].slice().reverse(), startLoop = loop.slice().reverse();
          const start = b.addPrim(startRing, true, sp.prim);
          for (let i = 0; i < n; i++) uvA.set(b.numVertices - n + i, [-startLoop[i][0] * us, startLoop[i][1] * us, 0]);
          caps.add(end); caps.add(start);
          prims.push(end, start);
        }
      });
      for (const pr of prims) {
        beamA.set(pr, index);
        if (nameA) nameA.set(pr, nameFmt.replaceAll('{index}', String(index)));
      }
      index++;
    }
    if (skipped) ctx.warn(`${type}: ${skipped} zero-length segment(s) skipped`);
    ctx.stat('beams', index);
    return b.build();
  },
});
