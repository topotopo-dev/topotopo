// The trim section of the uv report: per band, what the mapping covered, and faces that miss every band or cross two.
import type { Geometry } from './geometry.ts';
import type { Triangulation } from './topology.ts';
import { primWhere } from './report.ts';
import { readTrimSheets, region } from './trim.ts';
import type { TrimRegion, TrimSheet } from './trim.ts';

export interface TrimBandReport {
  sheet: string;
  band: string;
  prims: number;
  triangles: number;
  /** surface area, m² */
  area: number;
  /** v range the faces use, and the band's own v range */
  v: [number, number];
  bandV: [number, number];
  /** measured texel density, texels per metre, and the sheet's */
  texelsPerMetreU: number;
  texelsPerMetreV: number;
  sheetTexelsPerMetre: number;
  /** worse / better of the two densities (1 = even) */
  stretch: number;
}

export interface TrimUVReport {
  resolution: [number, number];
  bands: TrimBandReport[];
  /** triangles whose uv sits in no band and no rectangle */
  outside: { triangles: number; examples: string[] };
  /** triangles with corners in two different bands */
  straddle: { triangles: number; examples: string[] };
}

/** The trim section, or null when the geometry carries no trim bands. */
export function trimUvReport(g: Geometry, tri: Triangulation, maxExamples = 8): TrimUVReport | null {
  const bandA = g.prims.get('trim_band'), sheetA = g.prims.get('trim_sheet');
  if (!bandA || bandA.type !== 'string') return null;
  const table = readTrimSheets(g);
  if (!Object.keys(table).length) return null;
  const uv = g.findAttrib('uv', ['vertex', 'point']);
  if (!uv || uv.attr.type !== 'float' || uv.attr.size < 2) return null;
  const d = uv.attr.data as Float64Array, sz = uv.attr.size;
  const { tris, triPrim } = tri, nt = tris.length / 3;
  const at = (corner: number) => {
    const v = tris[corner], i = (uv.cls === 'vertex' ? v : g.vertexPoint[v]) * sz;
    return [d[i], d[i + 1]] as [number, number];
  };
  const where = (t: number) => {
    const P = g.P, i0 = g.vertexPoint[tris[t * 3]] * 3, i1 = g.vertexPoint[tris[t * 3 + 1]] * 3, i2 = g.vertexPoint[tris[t * 3 + 2]] * 3;
    return primWhere(g, triPrim[t], [0, 1, 2].map((k) => (P[i0 + k] + P[i1 + k] + P[i2 + k]) / 3));
  };
  const regionsOf = (sheet: TrimSheet) => [...sheet.bands, ...sheet.rects].map((x) => region(sheet, x.name)!);
  const strict = (regs: TrimRegion[], u: number, v: number) => regs.filter((r) => v > r.v[0] + 1e-4 && v < r.v[1] - 1e-4 && (r.tile || (u >= r.u[0] - 1e-4 && u <= r.u[1] + 1e-4)));
  const loose = (regs: TrimRegion[], u: number, v: number) => regs.filter((r) => v >= r.v[0] - 1e-4 && v <= r.v[1] + 1e-4 && (r.tile || (u >= r.u[0] - 1e-4 && u <= r.u[1] + 1e-4)));
  // per sheet+band: prims, triangles, area, v range, density sums
  const acc = new Map<string, { sheet: string; band: string; prims: Set<number>; tris: number; area: number; v0: number; v1: number; du: number; dv: number; w: number }>();
  let outside = 0, straddle = 0;
  const outsideEx: string[] = [], straddleEx: string[] = [];
  for (let t = 0; t < nt; t++) {
    const p = triPrim[t], name = String(bandA.get(p) ?? ''), sheet = table[String(sheetA?.get(p) ?? '')];
    const c0 = at(t * 3), c1 = at(t * 3 + 1), c2 = at(t * 3 + 2);
    const regs = sheet ? regionsOf(sheet) : [];
    const corners = [c0, c1, c2];
    const names = new Set(corners.flatMap(([u, v]) => strict(regs, u, v).map((r) => r.name)));
    if (sheet && names.size > 1) { straddle++; if (straddleEx.length < maxExamples) straddleEx.push(where(t)); }
    if (sheet && !corners.some(([u, v]) => loose(regs, u, v).length)) { outside++; if (outsideEx.length < maxExamples) outsideEx.push(where(t)); }
    if (!sheet || !name) continue;
    const reg = region(sheet, name);
    if (!reg) continue;
    const P = g.P, q = (k: number) => { const i = g.vertexPoint[tris[t * 3 + k]] * 3; return [P[i], P[i + 1], P[i + 2]]; };
    const a = q(0), b = q(1), c = q(2);
    const e1 = b.map((x, i) => x - a[i]), e2 = c.map((x, i) => x - a[i]);
    const area = 0.5 * Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]);
    const du1 = c1[0] - c0[0], dv1 = c1[1] - c0[1], du2 = c2[0] - c0[0], dv2 = c2[1] - c0[1], det = du1 * dv2 - du2 * dv1;
    const key = `${sheet.name}/${name}`;
    let row = acc.get(key);
    if (!row) { row = { sheet: sheet.name, band: name, prims: new Set(), tris: 0, area: 0, v0: Infinity, v1: -Infinity, du: 0, dv: 0, w: 0 }; acc.set(key, row); }
    row.prims.add(p); row.tris++; row.area += area;
    for (const [, v] of [c0, c1, c2]) { row.v0 = Math.min(row.v0, v); row.v1 = Math.max(row.v1, v); }
    if (Math.abs(det) > 1e-12 && area > 0) {
      const dPu = e1.map((x, i) => (dv2 * x - dv1 * e2[i]) / det), dPv = e1.map((x, i) => (du1 * e2[i] - du2 * x) / det);
      const lu = Math.hypot(dPu[0], dPu[1], dPu[2]), lv = Math.hypot(dPv[0], dPv[1], dPv[2]);
      if (lu > 1e-9) row.du += (sheet.resolution[0] / lu) * area;
      if (lv > 1e-9) row.dv += (sheet.resolution[1] / lv) * area;
      row.w += area;
    }
  }
  if (!acc.size && !outside && !straddle) return null;
  const bands: TrimBandReport[] = [...acc.values()].sort((a, b) => a.sheet.localeCompare(b.sheet, 'en') || a.band.localeCompare(b.band, 'en')).map((row) => {
    const sheet = table[row.sheet], reg = region(sheet, row.band)!;
    const tpu = row.w > 0 ? row.du / row.w : 0, tpv = row.w > 0 ? row.dv / row.w : 0;
    const lo = Math.min(tpu, tpv), hi = Math.max(tpu, tpv);
    return {
      sheet: row.sheet, band: row.band, prims: row.prims.size, triangles: row.tris, area: row.area,
      v: [row.v0, row.v1], bandV: reg.v, texelsPerMetreU: tpu, texelsPerMetreV: tpv,
      sheetTexelsPerMetre: sheet.texels_per_metre, stretch: lo > 0 ? hi / lo : 0,
    };
  });
  const res = table[bands[0]?.sheet ?? Object.keys(table)[0]].resolution;
  return { resolution: res, bands, outside: { triangles: outside, examples: outsideEx }, straddle: { triangles: straddle, examples: straddleEx } };
}
