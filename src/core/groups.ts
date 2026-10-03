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
import { Geometry } from './geometry.ts';
import type { AttribClass } from './geometry.ts';
import { primCentroid } from './topology.ts';

const COMP: Record<string, number> = { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3, u: 0, v: 1 };

function globToRe(glob: string) {
  return new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
}

export class GroupError extends Error {}

/** Returns a mask, or null meaning "all elements". */
export function evalGroup(g: Geometry, cls: 'point' | 'prim', pattern: string | null | undefined): Uint8Array | null {
  const pat = (pattern ?? '').trim();
  if (pat === '' || pat === '*') return null;
  const n = cls === 'point' ? g.numPoints : g.numPrims;
  const sel = new Uint8Array(n);
  const tokens = tokenize(pat);
  for (const tok of tokens) {
    let op: 'add' | 'sub' | 'not' = 'add';
    let t = tok;
    if (t.startsWith('^')) { op = 'sub'; t = t.slice(1); }
    else if (t.startsWith('!')) { op = 'not'; t = t.slice(1); }
    const m = tokenMask(g, cls, t, n);
    for (let i = 0; i < n; i++) {
      if (op === 'add') { if (m[i]) sel[i] = 1; }
      else if (op === 'sub') { if (m[i]) sel[i] = 0; }
      else if (!m[i]) sel[i] = 1;
    }
  }
  return sel;
}

function tokenize(p: string): string[] {
  // keep "@attr op value" together even if the user typed spaces around the operator
  return p.replace(/\s*(==|!=|>=|<=|=|>|<)\s*/g, '$1').split(/\s+/).filter(Boolean);
}

function tokenMask(g: Geometry, cls: 'point' | 'prim', t: string, n: number): Uint8Array {
  const m = new Uint8Array(n);
  if (t === '*') return m.fill(1);
  // index ranges
  const rng = /^(\d+)(?:-(\d+))?(?::(\d+))?$/.exec(t);
  if (rng) {
    const a = +rng[1], b = rng[2] !== undefined ? +rng[2] : a, step = rng[3] ? Math.max(1, +rng[3]) : 1;
    for (let i = Math.min(a, b); i <= Math.min(Math.max(a, b), n - 1); i += step) m[i] = 1;
    return m;
  }
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
  if (!hit && !/[*?]/.test(t)) {
    const avail = [...own.keys()].map((k) => `${cls}:${k}`).concat([...other.keys()].map((k) => `${cls === 'point' ? 'prim' : 'point'}:${k}`));
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

function adhoc(g: Geometry, cls: 'point' | 'prim', expr: string, n: number): Uint8Array {
  const mm = /^([A-Za-z_]\w*)(?:\.([xyzwrgbauv])|\[(\d)\])?(==|!=|>=|<=|=|>|<)(.*)$/.exec(expr);
  if (!mm) throw new GroupError(`bad ad-hoc group "@${expr}". Use forms like @P.y>0.5, @class==2, @name=piece*`);
  const [, name, compL, compI, op, rawVal] = mm;
  const comp = compL ? COMP[compL] : compI ? +compI : -1;
  const m = new Uint8Array(n);
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
  const num = Number(rawVal);
  const isNum = rawVal.trim() !== '' && !isNaN(num);
  const re = isNum ? null : globToRe(rawVal.replace(/^["']|["']$/g, ''));
  for (let i = 0; i < n; i++) {
    let v = get!(i);
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
