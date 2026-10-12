// Houdini-style group patterns, evaluated to a selection mask.
//
//   ""  or "*"          everything
//   top                 named group (wildcards allowed: "side*")
//   0-10  5  0-100:2    index ranges (":2" = every 2nd)
//   @P.y>0.5            ad-hoc attribute test; ops: = == != > < >= <=
//   @name=piece*        string attribute glob
//   !top                everything except "top" (unioned)
//   ^top                remove "top" from the selection so far
// Tokens are separated by spaces and applied left to right.
//
// Four classes: point, prim, vertex, edge.
//  vertex   names = vertex groups; ranges = vertex numbers; @attr tests read vertex attributes, then
//           the vertex's point, prim and detail attributes; @vtxnum @ptnum @primnum.
//  edge     the unique-edge list of edgeList() (first occurrence walking prims, polyline segments
//           included) is what index ranges address. Extra tokens:
//             p3-7  p3-7-12-4  p3-7-12-3   explicit edges and (closed) chains of point numbers
//             2e1                          side 1 of prim 2 (vertex 1 → vertex 2)
//             boundary | unshared          edges used by exactly one polygon
//             shared                       edges used by two or more polygons
//             nonmanifold                  edges used by more than two polygons
//             angle>30  angle<=10          dihedral angle between the two polygons (degrees; boundary edges never match)
//             length>0.5                   edge length
//             border:top                   border of a prim group/pattern (sides used by exactly one selected polygon)
//             group:name  edge:name        edge groups only; prim:name point:name vertex:name convert those groups
//           @attr tests use the average of the two endpoints' point attributes; @edgenum.
//           A bare name is an edge group first, then a keyword above, then a group of another class.
// A pattern of any class may name a group of another class; it is converted (see groupconvert.ts):
// to points = points touched by the elements; to prims = prims whose points/vertices/sides are all
// selected; to vertices = vertices of the selected points/prims/edges; to edges = sides of selected
// prims, or edges whose two points (vertices) are selected.
import { Geometry } from './geometry.ts';
import type { AttribClass, GroupClass } from './geometry.ts';
import { primCentroid } from './topology.ts';
import { EdgeSet, edgeKey, edgeList, maskToEdgeSet } from './edges.ts';
import type { EdgeList } from './edges.ts';
import { convertSelection } from './groupconvert.ts';
import { halfEdges } from './halfedge.ts';

const COMP: Record<string, number> = { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3, u: 0, v: 1 };

function globToRe(glob: string) {
  return new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
}

export class GroupError extends Error {}

interface Ctx { list: EdgeList | null }

function elemCount(g: Geometry, cls: GroupClass, ctx: Ctx): number {
  return cls === 'point' ? g.numPoints : cls === 'prim' ? g.numPrims : cls === 'vertex' ? g.numVertices : ctx.list!.count;
}

/**
 * Returns a mask, or null meaning "all elements". For cls 'edge' the mask runs over edgeList(g)
 * (use evalEdgeGroup for an EdgeSet).
 */
export function evalGroup(g: Geometry, cls: GroupClass, pattern: string | null | undefined, list?: EdgeList): Uint8Array | null {
  const pat = (pattern ?? '').trim();
  if (pat === '' || pat === '*') return null;
  const ctx: Ctx = { list: cls === 'edge' ? list ?? edgeList(g) : null };
  const n = elemCount(g, cls, ctx);
  const sel = new Uint8Array(n);
  const tokens = tokenize(pat);
  for (const tok of tokens) {
    let op: 'add' | 'sub' | 'not' = 'add';
    let t = tok;
    if (t.startsWith('^')) { op = 'sub'; t = t.slice(1); }
    else if (t.startsWith('!')) { op = 'not'; t = t.slice(1); }
    const m = cls === 'point' || cls === 'prim' ? tokenMask(g, cls, t, n) : cls === 'vertex' ? vertexTokenMask(g, t, n) : edgeTokenMask(g, t, ctx.list!);
    for (let i = 0; i < n; i++) {
      if (op === 'add') { if (m[i]) sel[i] = 1; }
      else if (op === 'sub') { if (m[i]) sel[i] = 0; }
      else if (!m[i]) sel[i] = 1;
    }
  }
  return sel;
}

/** Edge pattern → EdgeSet (empty pattern = every edge of every prim). */
export function evalEdgeGroup(g: Geometry, pattern: string | null | undefined, list?: EdgeList): EdgeSet {
  const L = list ?? edgeList(g);
  return maskToEdgeSet(L, evalGroup(g, 'edge', pattern, L));
}

function tokenize(p: string): string[] {
  // keep "@attr op value" together even if the user typed spaces around the operator
  return p.replace(/\s*(==|!=|>=|<=|=|>|<)\s*/g, '$1').split(/\s+/).filter(Boolean);
}

function rangeMask(t: string, n: number): Uint8Array | null {
  const rng = /^(\d+)(?:-(\d+))?(?::(\d+))?$/.exec(t);
  if (!rng) return null;
  const m = new Uint8Array(n);
  const a = +rng[1], b = rng[2] !== undefined ? +rng[2] : a, step = rng[3] ? Math.max(1, +rng[3]) : 1;
  for (let i = Math.min(a, b); i <= Math.min(Math.max(a, b), n - 1); i += step) m[i] = 1;
  return m;
}

const OTHER: Record<GroupClass, GroupClass[]> = {
  point: ['prim', 'vertex', 'edge'], prim: ['point', 'vertex', 'edge'], vertex: ['point', 'prim', 'edge'], edge: ['prim', 'point', 'vertex'],
};

/** Include rule when a pattern of class `to` names a group of class `from`. */
function promoteRule(to: GroupClass): 'any' | 'all' {
  return to === 'prim' || to === 'edge' ? 'all' : 'any';
}

/** OR the members of groups of class `from` whose names match re (converted to class `to`) into m. */
function matchOtherClass(g: Geometry, from: GroupClass, to: GroupClass, re: RegExp, m: Uint8Array, list: EdgeList | null): boolean {
  let hit = false;
  if (from === 'edge') {
    for (const [name, set] of g.edgeGroups)
      if (re.test(name)) { hit = true; orInto(m, convertSelection(g, 'edge', to, set, promoteRule(to), list ?? undefined), list); }
  } else {
    for (const [name, mask] of g.groups(from))
      if (re.test(name)) {
        hit = true;
        if (to === 'edge') {
          // prim → edge: every side of the prims; point/vertex → edge: both endpoints selected
          if (from === 'prim') orInto(m, convertSelection(g, 'prim', 'edge', mask, 'any', list ?? undefined), list);
          else {
            const pts = from === 'point' ? mask : (convertSelection(g, 'vertex', 'point', mask, 'any') as Uint8Array);
            orInto(m, convertSelection(g, 'point', 'edge', pts, 'all', list ?? undefined), list);
          }
        } else orInto(m, convertSelection(g, from, to, mask, promoteRule(to), list ?? undefined), list);
      }
  }
  return hit;
}

function orInto(m: Uint8Array, sel: Uint8Array | EdgeSet, list: EdgeList | null) {
  if (sel instanceof EdgeSet) {
    for (let i = 0; i < list!.count; i++) if (sel.hasKey(edgeKey(list!.a[i], list!.b[i]))) m[i] = 1;
  } else for (let i = 0; i < m.length; i++) if (sel[i]) m[i] = 1;
}

function unknownGroup(g: Geometry, cls: GroupClass, t: string): GroupError {
  const avail = [cls, ...OTHER[cls]].flatMap((c) => g.groupNames(c).map((k) => `${c}:${k}`));
  return new GroupError(`unknown group "${t}". Available groups: ${avail.length ? avail.join(', ') : '(none)'}`);
}

function tokenMask(g: Geometry, cls: 'point' | 'prim', t: string, n: number): Uint8Array {
  const m = new Uint8Array(n);
  if (t === '*') return m.fill(1);
  // index ranges
  const rm = rangeMask(t, n);
  if (rm) return rm;
  if (t.startsWith('@')) return adhoc(g, cls, t.slice(1), n);
  // named groups (with wildcards), with cross-class promotion as a convenience
  const re = globToRe(t);
  const own = g.groups(cls), other = g.groups(cls === 'point' ? 'prim' : 'point');
  let hit = false;
  for (const [name, mask] of own) if (re.test(name)) { hit = true; for (let i = 0; i < n; i++) if (mask[i]) m[i] = 1; }
  if (!hit) {
    for (const [name, mask] of other)
      if (re.test(name)) {
        hit = true;
        promoteInto(g, cls, mask, m);
      }
  }
  if (!hit) hit = matchOtherClass(g, 'vertex', cls, re, m, null);
  if (!hit && g.edgeGroups.size) hit = matchOtherClass(g, 'edge', cls, re, m, null);
  if (!hit && !/[*?]/.test(t)) {
    const avail = [...own.keys()].map((k) => `${cls}:${k}`).concat([...other.keys()].map((k) => `${cls === 'point' ? 'prim' : 'point'}:${k}`))
      .concat(g.groupNames('vertex').map((k) => `vertex:${k}`), g.groupNames('edge').map((k) => `edge:${k}`));
    throw new GroupError(`unknown group "${t}". Available groups: ${avail.length ? avail.join(', ') : '(none)'}`);
  }
  return m;
}

/** point mask -> prims whose points are all selected; prim mask -> points of selected prims. */
function promoteInto(g: Geometry, cls: 'point' | 'prim', src: Uint8Array, dst: Uint8Array) {
  if (cls === 'point') {
    for (let p = 0; p < g.numPrims; p++)
      if (src[p]) for (let v = g.primStart[p]; v < g.primStart[p + 1]; v++) dst[g.vertexPoint[v]] = 1;
  } else {
    for (let p = 0; p < g.numPrims; p++) {
      let all = g.primSize(p) > 0;
      for (let v = g.primStart[p]; v < g.primStart[p + 1]; v++) if (!src[g.vertexPoint[v]]) { all = false; break; }
      if (all) dst[p] = 1;
    }
  }
}

// ---------------------------------------------------------------- vertex patterns

function vertexTokenMask(g: Geometry, t: string, n: number): Uint8Array {
  const m = new Uint8Array(n);
  if (t === '*') return m.fill(1);
  const rm = rangeMask(t, n);
  if (rm) return rm;
  if (t.startsWith('@')) return adhocVertex(g, t.slice(1), n);
  const pre = /^(group|vertex|point|prim|edge):(.+)$/.exec(t);
  const re = globToRe(pre ? pre[2] : t);
  let hit = false;
  if (!pre || pre[1] === 'group' || pre[1] === 'vertex')
    for (const [name, mask] of g.vertexGroups) if (re.test(name)) { hit = true; for (let i = 0; i < n; i++) if (mask[i]) m[i] = 1; }
  for (const c of OTHER.vertex) {
    if (hit && !pre) break;
    if (pre && pre[1] !== c) continue;
    if (matchOtherClass(g, c, 'vertex', re, m, null)) hit = true;
  }
  if (!hit && !/[*?]/.test(pre ? pre[2] : t)) throw unknownGroup(g, 'vertex', t);
  return m;
}

function adhocVertex(g: Geometry, expr: string, n: number): Uint8Array {
  const pe = parseAdhoc(expr);
  const vprim = g.vertexPrims();
  const special: Record<string, (i: number) => number> = {
    vtxnum: (i) => i, elemnum: (i) => i, ptnum: (i) => g.vertexPoint[i], primnum: (i) => vprim[i],
    numvtx: () => g.numVertices, numpt: () => g.numPoints, numprim: () => g.numPrims,
  };
  let get: (i: number) => number | string | number[];
  if (special[pe.name]) get = special[pe.name];
  else {
    const f = g.findAttrib(pe.name, ['vertex', 'point', 'prim', 'detail']);
    if (!f && pe.name === 'P') get = (i) => { const p = g.vertexPoint[i] * 3; return [g.P[p], g.P[p + 1], g.P[p + 2]]; };
    else if (!f) throw new GroupError(`ad-hoc group: no vertex, point, prim or detail attribute "${pe.name}"`);
    else if (f.cls === 'vertex') get = (i) => f.attr.get(i);
    else if (f.cls === 'point') get = (i) => f.attr.get(g.vertexPoint[i]);
    else if (f.cls === 'prim') get = (i) => f.attr.get(vprim[i]);
    else { const v = f.attr.get(0); get = () => v; }
  }
  return compareMask(n, get, pe);
}

// ---------------------------------------------------------------- edge patterns

const CMP_RE = /^(angle|length)(==|!=|>=|<=|=|>|<)(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)$/i;

function edgeTokenMask(g: Geometry, t: string, L: EdgeList): Uint8Array {
  const n = L.count;
  const m = new Uint8Array(n);
  if (t === '*') return m.fill(1);
  const rm = rangeMask(t, n);
  if (rm) return rm;
  // explicit edges / chains: p3-7, p3-7-12-4
  const chain = /^p(\d+(?:-\d+)+)$/.exec(t);
  if (chain) {
    const pts = chain[1].split('-').map(Number);
    for (let k = 0; k + 1 < pts.length; k++) {
      if (pts[k] === pts[k + 1]) continue;
      const i = L.index.get(edgeKey(pts[k], pts[k + 1]));
      if (i !== undefined) m[i] = 1;
    }
    return m;
  }
  // prim side: 2e1
  const side = /^(\d+)e(\d+)$/.exec(t);
  if (side) {
    const p = +side[1], k = +side[2];
    if (p < g.numPrims) {
      const s = g.primStart[p], sz = g.primSize(p);
      if (k < (g.primClosed[p] ? sz : sz - 1)) {
        const a = g.vertexPoint[s + k], b = g.vertexPoint[s + ((k + 1) % sz)];
        const i = a === b ? undefined : L.index.get(edgeKey(a, b));
        if (i !== undefined) m[i] = 1;
      }
    }
    return m;
  }
  if (t.startsWith('@')) return adhocEdge(g, t.slice(1), L);
  const cmp = CMP_RE.exec(t);
  if (cmp) {
    const kind = cmp[1].toLowerCase(), op = cmp[2], val = Number(cmp[3]);
    const he = kind === 'angle' ? halfEdges(g) : null;
    const P = g.P;
    const get = (i: number) => {
      if (he) { const e = he.edgeId(L.a[i], L.b[i]); return e < 0 ? NaN : he.dihedralAngle(e); }
      const a = L.a[i] * 3, b = L.b[i] * 3;
      return Math.hypot(P[a] - P[b], P[a + 1] - P[b + 1], P[a + 2] - P[b + 2]);
    };
    return compareMask(n, get, { name: kind, comp: -1, op, rawVal: cmp[3], num: val, isNum: true, re: null });
  }
  const border = /^border:(.+)$/.exec(t);
  if (border) {
    const pm = evalGroup(g, 'prim', border[1]);
    const cnt = new Int32Array(n);
    for (let p = 0; p < g.numPrims; p++) {
      if (!g.primClosed[p] || (pm && !pm[p]) || g.primSize(p) < 3) continue;
      const s = g.primStart[p], e = g.primStart[p + 1];
      for (let v = s; v < e; v++) {
        const a = g.vertexPoint[v], b = g.vertexPoint[v + 1 < e ? v + 1 : s];
        if (a === b) continue;
        const i = L.index.get(edgeKey(a, b));
        if (i !== undefined) cnt[i]++;
      }
    }
    for (let i = 0; i < n; i++) if (cnt[i] === 1) m[i] = 1;
    return m;
  }
  const pre = /^(group|edge|point|prim|vertex):(.+)$/.exec(t);
  const name = pre ? pre[2] : t;
  const re = globToRe(name);
  let hit = false;
  if (!pre || pre[1] === 'group' || pre[1] === 'edge')
    for (const [gn, set] of g.edgeGroups)
      if (re.test(gn)) { hit = true; for (let i = 0; i < n; i++) if (set.hasKey(edgeKey(L.a[i], L.b[i]))) m[i] = 1; }
  if (!hit && !pre) {
    const kw = t.toLowerCase();
    if (kw === 'boundary' || kw === 'unshared') { for (let i = 0; i < n; i++) if (L.polyCount[i] === 1) m[i] = 1; return m; }
    if (kw === 'shared') { for (let i = 0; i < n; i++) if (L.polyCount[i] >= 2) m[i] = 1; return m; }
    if (kw === 'nonmanifold') { for (let i = 0; i < n; i++) if (L.polyCount[i] > 2) m[i] = 1; return m; }
  }
  for (const c of OTHER.edge) {
    if (hit && !pre) break;
    if (pre && pre[1] !== c) continue;
    if (matchOtherClass(g, c, 'edge', re, m, L)) hit = true;
  }
  if (!hit && !/[*?]/.test(name)) {
    const e = unknownGroup(g, 'edge', t);
    e.message += '. Edge selectors: p3-7, p3-7-12 (chains), 2e1 (prim side), boundary, shared, angle>30, length<0.1, border:primgroup, 0-10 (edge index)';
    throw e;
  }
  return m;
}

function adhocEdge(g: Geometry, expr: string, L: EdgeList): Uint8Array {
  const pe = parseAdhoc(expr);
  const n = L.count;
  const special: Record<string, (i: number) => number> = { edgenum: (i) => i, elemnum: (i) => i, numedge: () => n };
  let get: (i: number) => number | string | number[];
  if (special[pe.name]) get = special[pe.name];
  else {
    const f = g.findAttrib(pe.name, ['point', 'detail']);
    if (!f) throw new GroupError(`ad-hoc edge group: no point or detail attribute "${pe.name}" (edge tests average the two endpoints)`);
    if (f.cls === 'detail') { const v = f.attr.get(0); get = () => v; }
    else {
      const a = f.attr;
      get = (i) => {
        if (a.type === 'string') return a.get(L.a[i]);
        const x = a.get(L.a[i]), y = a.get(L.b[i]);
        if (a.size === 1) return ((x as number) + (y as number)) / 2;
        return (x as number[]).map((v, c) => (v + (y as number[])[c]) / 2);
      };
    }
  }
  return compareMask(n, get, pe);
}

// ---------------------------------------------------------------- ad-hoc attribute tests

interface Adhoc { name: string; comp: number; op: string; rawVal: string; num: number; isNum: boolean; re: RegExp | null }

function parseAdhoc(expr: string): Adhoc {
  const mm = /^([A-Za-z_]\w*)(?:\.([xyzwrgbauv])|\[(\d)\])?(==|!=|>=|<=|=|>|<)(.*)$/.exec(expr);
  if (!mm) throw new GroupError(`bad ad-hoc group "@${expr}". Use forms like @P.y>0.5, @class==2, @name=piece*`);
  const [, name, compL, compI, op, rawVal] = mm;
  const num = Number(rawVal);
  const isNum = rawVal.trim() !== '' && !isNaN(num);
  return { name, comp: compL ? COMP[compL] : compI ? +compI : -1, op, rawVal, num, isNum, re: isNum ? null : globToRe(rawVal.replace(/^["']|["']$/g, '')) };
}

function compareMask(n: number, get: (i: number) => number | string | number[], pe: Adhoc): Uint8Array {
  const { comp, op, rawVal, num, isNum, re } = pe;
  const m = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let v = get(i);
    if (Array.isArray(v)) v = comp >= 0 ? v[comp] : Math.hypot(...v);
    let ok: boolean;
    if (typeof v === 'string' || !isNum) {
      const s = String(v);
      const eq = re ? re.test(s) : s === rawVal;
      ok = op === '!=' ? !eq : op === '=' || op === '==' ? eq : false;
    } else {
      const x = v as number;
      switch (op) {
        case '=': case '==': ok = Math.abs(x - num) < 1e-9; break;
        case '!=': ok = Math.abs(x - num) >= 1e-9; break;
        case '>': ok = x > num; break;
        case '<': ok = x < num; break;
        case '>=': ok = x >= num; break;
        default: ok = x <= num;
      }
    }
    if (ok) m[i] = 1;
  }
  return m;
}

function adhoc(g: Geometry, cls: 'point' | 'prim', expr: string, n: number): Uint8Array {
  const pe = parseAdhoc(expr);
  const name = pe.name;
  // element numbers
  const special: Record<string, (i: number) => number> = {
    ptnum: (i) => i, primnum: (i) => i, elemnum: (i) => i,
    numpt: () => g.numPoints, numprim: () => g.numPrims,
  };
  let get: (i: number) => number | string | number[];
  if (special[name]) get = special[name];
  else {
    const order: AttribClass[] = cls === 'point' ? ['point', 'detail'] : ['prim', 'detail', 'point'];
    let found = null as null | { cls: AttribClass; attr: any };
    for (const c of order) {
      const a = g.table(c).get(name);
      if (a) { found = { cls: c, attr: a }; break; }
    }
    if (!found && cls === 'prim' && name === 'P') {
      get = (i) => primCentroid(g, i);
    } else if (!found) {
      throw new GroupError(`ad-hoc group: no ${cls} attribute "${name}"`);
    } else if (found.cls === 'detail') {
      const v = found.attr.get(0);
      get = () => v;
    } else if (found.cls === 'point' && cls === 'prim') {
      // prim test against point attribute: use average over the prim's points
      const a = found.attr;
      get = (p) => {
        const s = g.primStart[p], e = g.primStart[p + 1];
        if (a.type === 'string') return a.get(g.vertexPoint[s]);
        const acc = new Array(a.size).fill(0);
        for (let v = s; v < e; v++) { const x = a.get(g.vertexPoint[v]); for (let c = 0; c < a.size; c++) acc[c] += Array.isArray(x) ? x[c] : x; }
        return a.size === 1 ? acc[0] / (e - s) : acc.map((x) => x / (e - s));
      };
    } else {
      get = (i) => found!.attr.get(i);
    }
  }
  return compareMask(n, get, pe);
}

/** Convenience: selection as list of indices. */
export function maskIndices(mask: Uint8Array | null, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (!mask || mask[i]) out.push(i);
  return out;
}

/** Selected points of a prim selection (mask over prims). */
export function primMaskToPoints(g: Geometry, primMask: Uint8Array | null): Uint8Array {
  const m = new Uint8Array(g.numPoints);
  for (let p = 0; p < g.numPrims; p++)
    if (!primMask || primMask[p]) for (let v = g.primStart[p]; v < g.primStart[p + 1]; v++) m[g.vertexPoint[v]] = 1;
  return m;
}
