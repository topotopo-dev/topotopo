// Structured uv report (core/uvreport.ts, inspect detail "uv"): shared edges are not overlaps, overlapping and
// mirrored charts, folds inside one chart, collapsed / missing / non-finite uv, out-of-tile triangles, large triangle
// ids, exact vs estimated utilization, texel density per piece, bounded work that says it is incomplete.
//   node test/uvreport.ts
import '../src/nodes/index.ts';
import { GeoBuilder } from '../src/core/geometry.ts';
import type { Geometry } from '../src/core/geometry.ts';
import { uvReport } from '../src/core/uvreport.ts';
import { inspect } from '../src/inspect.ts';

let fail = 0, pass = 0;
const check = (ok: unknown, msg: string) => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
};
const near = (a: number, b: number, tol = 1e-12) => Math.abs(a - b) <= tol;

/** Polygons from [3D corners, uv corners] lists; uv is a vertex attribute, prims optionally named. */
function mesh(polys: { P: number[][]; uv: number[][]; name?: string }[], shareByKey = true): Geometry {
  const b = new GeoBuilder();
  const pts = new Map<string, number>();
  const uvs: number[][] = [];
  const names: string[] = [];
  for (const poly of polys) {
    const ids = poly.P.map((p) => {
      const k = p.join(',');
      let i = shareByKey ? pts.get(k) : undefined;
      if (i === undefined) { i = b.addPoint(p[0], p[1], p[2]); pts.set(k, i); }
      return i;
    });
    b.addPrim(ids);
    uvs.push(...poly.uv);
    names.push(poly.name ?? '');
  }
  const g = b.build();
  const a = g.vertices.add('uv', 'float', 3);
  uvs.forEach((u, v) => a.set(v, [u[0], u[1], 0]));
  if (polys.some((p) => p.name)) { const n = g.prims.add('name', 'string', 1); names.forEach((x, p) => n.set(p, x)); }
  return g;
}
/** A unit quad in the XZ plane at (x, z) with uv rectangle [u0, v0]–[u1, v1]. */
const quad = (x: number, z: number, u0: number, v0: number, u1: number, v1: number, name?: string, size = 1) => ({
  P: [[x, 0, z], [x + size, 0, z], [x + size, 0, z + size], [x, 0, z + size]],
  uv: [[u0, v0], [u1, v0], [u1, v1], [u0, v1]], name,
});

// ---------------------------------------------------------------- shared edges and clean atlases
{
  const r = uvReport(mesh([quad(0, 0, 0, 0, 0.5, 0.5), quad(1, 0, 0.5, 0, 1, 0.5)]));
  check(r.complete && r.triangles === 4 && r.charts === 1, `two quads sharing a uv edge: one chart of 4 triangles (${r.charts})`);
  check(r.overlap.pairs === 0 && r.overlap.testedPairs > 0, `shared edges and the quad diagonals are not overlaps (${r.overlap.testedPairs} pairs tested exactly)`);
  check(r.utilization.method === 'exact' && near(r.utilization.value, 0.5), `exact utilization 0.5 (${r.utilization.value})`);
  const seam = uvReport(mesh([quad(0, 0, 0, 0, 0.5, 0.5), quad(1, 0, 0.5, 0.5, 1, 1)]));
  check(seam.charts === 2 && seam.overlap.pairs === 0, 'a uv seam (shared 3D edge, different uv) splits the charts');
}

// ---------------------------------------------------------------- overlaps: between charts, mirrored, within a chart
{
  const r = uvReport(mesh([quad(0, 0, 0, 0, 0.5, 0.5), quad(5, 0, 0.25, 0, 0.75, 0.5)]));
  check(r.overlap.pairs > 0 && near(r.overlap.area, 0.125, 1e-12) && r.overlap.sameChartPairs === 0, `two charts overlapping by 0.25 × 0.5: overlap area ${r.overlap.area} = 0.125 over ${r.overlap.pairs} triangle pairs`);
  check(r.utilization.method === 'raster-estimate' && /ESTIMATE/.test(r.utilization.note) && Math.abs(r.utilization.value - 0.375) < 0.005, `overlapping atlas: utilization is a labelled raster estimate (${r.utilization.value.toFixed(4)} ≈ union 0.375), not the summed 0.5`);
  const ex = r.overlap.examples[0];
  check(ex && ex.prims[0] !== ex.prims[1] && ex.area > 0, `examples name the triangle pair, their prims and the area (${JSON.stringify(ex)})`);
  const mir = uvReport(mesh([quad(0, 0, 0, 0, 0.5, 0.5), quad(5, 0, 1, 0, 0.5, 0.5)]));
  check(mir.mirrored === 2 && mir.overlap.pairs === 0 && mir.utilization.method === 'exact', `a mirrored chart beside another: ${mir.mirrored} mirrored triangles, no overlap, exact utilization`);
  const stacked = uvReport(mesh([quad(0, 0, 0, 0, 0.5, 0.5), quad(5, 0, 0.5, 0, 0, 0.5)]));
  check(stacked.overlap.pairs > 0 && near(stacked.overlap.area, 0.25, 1e-12), `a mirrored copy stacked on its twin overlaps it fully (area ${stacked.overlap.area})`);
  // one connected strip whose third quad folds back over the first in uv
  const fold = uvReport(mesh([quad(0, 0, 0, 0, 0.3, 0.3), quad(1, 0, 0.3, 0, 0.6, 0.3), { P: [[2, 0, 0], [3, 0, 0], [3, 0, 1], [2, 0, 1]], uv: [[0.6, 0], [0.1, 0.02], [0.1, 0.28], [0.6, 0.3]] }]));
  check(fold.charts === 1 && fold.overlap.sameChartPairs > 0 && fold.overlap.sameChartPairs === fold.overlap.pairs, `a fold inside one chart is reported as same-chart overlap (${fold.overlap.sameChartPairs} pairs)`);
}

// ---------------------------------------------------------------- collapsed, missing, non-finite, out of tile
{
  const col = uvReport(mesh([quad(0, 0, 0, 0, 0.5, 0.5), { P: [[3, 0, 0], [4, 0, 0], [4, 0, 1]], uv: [[0.6, 0.6], [0.7, 0.7], [0.8, 0.8]] }]));
  check(col.collapsed === 1 && col.collapsedTriangles[0] === 2 && col.overlap.pairs === 0, 'collinear uv corners: one collapsed triangle, listed by id and kept out of the overlap test');
  const g = mesh([quad(0, 0, 0, 0, 0.5, 0.5)]);
  g.vertices.delete('uv');
  const miss = uvReport(g);
  check(miss.missing && !miss.complete && /no float vertex or point attribute "uv"/.test(miss.reasons[0]), 'missing uv: incomplete, with the reason');
  const nanG = mesh([quad(0, 0, 0, 0, 0.5, 0.5)]);
  nanG.vertices.get('uv')!.set(0, [NaN, 0, 0]);
  const nan = uvReport(nanG);
  check(nan.nonFinite >= 1 && nan.overlap.pairs === 0, `non-finite uv: ${nan.nonFinite} triangle(s) counted and excluded`);
  const out = uvReport(mesh([quad(0, 0, 0, 0, 0.5, 0.5), quad(5, 0, 1.2, 0.1, 1.6, 0.5)]));
  check(out.outOfTile === 2 && out.tiles.join(' ') === '0,0 1,0' && out.utilization.method === 'raster-estimate', `UDIM tile 1001: 2 triangles outside 0..1, tiles ${out.tiles.join(' ')}, utilization estimated for the unit tile`);
}

// ---------------------------------------------------------------- large triangle ids, bounds, determinism
{
  const n = 250, polys: { P: number[][]; uv: number[][] }[] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) polys.push(quad(i, j, i / n, j / n, (i + 1) / n, (j + 1) / n));
  // the last quad's uv lands on the first one's
  polys[polys.length - 1] = { ...polys[polys.length - 1], uv: [[0, 0], [1 / n, 0], [1 / n, 1 / n], [0, 1 / n]] };
  const big = mesh(polys);
  const t0 = performance.now();
  const r = uvReport(big);
  const ms = performance.now() - t0;
  const ids = r.overlap.examples.flatMap((e) => e.triangles);
  check(r.complete && r.triangles === 125000 && r.overlap.pairs >= 2 && ids.some((t) => t >= 124998) && ids.some((t) => t <= 1), `125,000 triangles: the overlap between triangles ${Math.min(...ids)} and ${Math.max(...ids)} is found (${r.overlap.testedPairs} exact tests, ${ms.toFixed(0)} ms)`);
  check(near(r.overlap.area, 1 / (n * n), 1e-15), `overlap area ${r.overlap.area.toExponential(3)} = one quad (${(1 / (n * n)).toExponential(3)})`);
  const capped = uvReport(big, { maxPairTests: 1000 });
  check(!capped.complete && /stopped after 1,000 exact pair tests/.test(capped.reasons.join()) && capped.utilization.method !== 'exact', `a bounded run reports INCOMPLETE with the reason and no exact utilization (${capped.reasons[0]})`);
  check(JSON.stringify(uvReport(big)) === JSON.stringify(r), 'the same input gives the same report');
}

// ---------------------------------------------------------------- texel density per named piece, inspect
{
  const g = mesh([quad(0, 0, 0, 0, 0.5, 0.5, 'small'), quad(5, 0, 0.5, 0.5, 1, 1, 'big', 2)]);
  const r = uvReport(g, { resolution: 1024 });
  const small = r.pieces.find((p) => p.name === 'small')!, big = r.pieces.find((p) => p.name === 'big')!;
  check(near(small.texelsPerMetre!, 512, 1e-9) && near(big.texelsPerMetre!, 256, 1e-9), `texel density at 1024²: 1 m² on 0.25 of the map = 512 texels/m, 4 m² = 256 (${small.texelsPerMetre}, ${big.texelsPerMetre})`);
  const noRes = uvReport(g);
  check(noRes.pieces.length === 2 && noRes.pieces.every((p) => p.texelsPerMetre === undefined), 'without a resolution the pieces list areas only');
  const txt = inspect(g, { detail: 'uv', uvResolution: 1024 });
  const js = inspect(g, { detail: 'uv', uvResolution: 1024, json: true }).split('uv report (JSON):\n')[1];
  check(JSON.parse(js).pieces.length === 2, 'inspect json: the report as parseable JSON after the text');
  check(/uv "uv": COMPLETE analysis of 4 triangles/.test(txt) && /small: 2 tris, surface 1 m², uv 0.25, 512 texels\/m/.test(txt) && /utilization 50.00% \(exact\)/.test(txt), 'inspect detail "uv" prints the report');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
