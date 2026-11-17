// Tiling neighbours for trim-sheet bakes. A band that tiles repeats every period along u, but the mesh only exists
// where it was built, so occlusion and curvature fade at the open ends. For each straight run of a tiling band this
// adds the run's last period again just past each end (shifted by dP/du, one period), where a constant profile
// continues. The overlapping middle is not copied: a second copy there would hide the run's own edges.
import { GeoBuilder, Geometry } from './geometry.ts';
import { readTrimSheets, region } from './trim.ts';

/** Geometry to add to a bake's scene so tiling bands see one period past each open end, or null when nothing tiles. */
export function tileCopies(g: Geometry): Geometry | null {
  const bandA = g.prims.get('trim_band'), sheetA = g.prims.get('trim_sheet');
  if (!bandA || bandA.type !== 'string' || !sheetA || sheetA.type !== 'string') return null;
  const table = readTrimSheets(g);
  const byKey = new Map<string, { prims: number[]; shift: number[] }>();
  for (let p = 0; p < g.numPrims; p++) {
    if (!g.primClosed[p] || g.primStart[p + 1] - g.primStart[p] < 3) continue;
    const sheet = table[String(sheetA.get(p) ?? '')];
    const reg = sheet ? region(sheet, String(bandA.get(p) ?? '')) : null;
    if (!reg?.tile) continue;
    const d = dPdu(g, p);
    if (!d) continue;
    const len = Math.hypot(d[0], d[1], d[2]);
    if (!(len > 1e-8)) continue;
    const key = `${sheet.name}:${reg.name}:${[0, 1, 2].map((c) => Math.round((d[c] / len) * 50)).join(',')}:${Math.round(len * 100)}`;
    let run = byKey.get(key);
    if (!run) { run = { prims: [], shift: [0, 0, 0] }; byKey.set(key, run); }
    run.prims.push(p);
    run.shift[0] += d[0]; run.shift[1] += d[1]; run.shift[2] += d[2];
  }
  const parts: Geometry[] = [];
  for (const run of byKey.values()) {
    const n = run.prims.length;
    const shift = run.shift.map((x) => x / n);
    const span = Math.hypot(shift[0], shift[1], shift[2]);
    if (!(span > 1e-8)) continue;
    const dir = shift.map((x) => x / span);
    const t = run.prims.map((p) => dot(centroid(g, p), dir));
    let tMin = Infinity, tMax = -Infinity;
    for (const x of t) { tMin = Math.min(tMin, x); tMax = Math.max(tMax, x); }
    const plus = run.prims.filter((_, i) => t[i] > tMax - span - 1e-6);
    const minus = run.prims.filter((_, i) => t[i] < tMin + span + 1e-6);
    if (plus.length) parts.push(shifted(g, plus, shift));
    if (minus.length) parts.push(shifted(g, minus, shift.map((x) => -x)));
  }
  if (!parts.length) return null;
  return parts.length === 1 ? parts[0] : Geometry.merge(parts);
}

/** The scene a tiling bake reads: the mesh plus its end copies. */
export function tiledScene(g: Geometry): Geometry {
  const extra = tileCopies(g);
  return extra ? Geometry.merge([g, extra]) : g;
}

/** dP/du of a prim from its first triangle with area in uv, or null. */
function dPdu(g: Geometry, p: number): number[] | null {
  const uv = g.findAttrib('uv', ['vertex', 'point']);
  if (!uv || uv.attr.type !== 'float' || uv.attr.size < 2) return null;
  const d = uv.attr.data as Float64Array, sz = uv.attr.size;
  const at = (v: number) => {
    const i = (uv.cls === 'vertex' ? v : g.vertexPoint[v]) * sz;
    const q = g.vertexPoint[v] * 3;
    return { u: d[i], v: d[i + 1], p: [g.P[q], g.P[q + 1], g.P[q + 2]] };
  };
  const s = g.primStart[p], e = g.primStart[p + 1];
  const a = at(s);
  for (let v = s + 1; v + 1 < e; v++) {
    const b = at(v), c = at(v + 1);
    const du1 = b.u - a.u, dv1 = b.v - a.v, du2 = c.u - a.u, dv2 = c.v - a.v;
    const det = du1 * dv2 - du2 * dv1;
    if (Math.abs(det) < 1e-12) continue;
    return [0, 1, 2].map((k) => (dv2 * (b.p[k] - a.p[k]) - dv1 * (c.p[k] - a.p[k])) / det);
  }
  return null;
}

function centroid(g: Geometry, p: number): number[] {
  let x = 0, y = 0, z = 0, n = 0;
  for (let v = g.primStart[p]; v < g.primStart[p + 1]; v++) {
    const i = g.vertexPoint[v] * 3; x += g.P[i]; y += g.P[i + 1]; z += g.P[i + 2]; n++;
  }
  return [x / n, y / n, z / n];
}

const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function shifted(g: Geometry, prims: number[], shift: number[]): Geometry {
  const b = new GeoBuilder(g);
  const map = new Map<number, number>();
  const pt = (i: number) => {
    let id = map.get(i);
    if (id === undefined) { id = b.addPoint(g.P[i * 3] + shift[0], g.P[i * 3 + 1] + shift[1], g.P[i * 3 + 2] + shift[2], i); map.set(i, id); }
    return id;
  };
  for (const p of prims) {
    const ids: number[] = [], vs: number[] = [];
    for (let v = g.primStart[p]; v < g.primStart[p + 1]; v++) { ids.push(pt(g.vertexPoint[v])); vs.push(v); }
    b.addPrim(ids, !!g.primClosed[p], p, vs);
  }
  return b.build();
}
