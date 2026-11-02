// TopoTopo Bench: what an agent built, judged the same way for every model. The graph the agent left in its package
// is cooked again here (not trusted from the transcript), checked against the task's checks, rendered from one fixed
// camera and exported as a GLB, so every model's result is seen and compared alike.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import '../../src/nodes/index.ts';
import { Engine } from '../../src/graph/engine.ts';
import { createNodeHost } from '../../src/host/node.ts';
import { openPackages } from '../../src/packages/registry.ts';
import { renderGeometry } from '../../src/render/raster.ts';
import { renderArgs } from '../../src/render/options.ts';
import { encodePNG } from '../../src/render/png.ts';
import { exportGeometryAsync } from '../../src/io/export.ts';
import { importGeometryAsync } from '../../src/io/import.ts';
import { expandPacked, expandedTriangles } from '../../src/core/packed.ts';
import { solidReport } from '../../src/core/report.ts';
import { connectivity, primCentroid } from '../../src/core/topology.ts';
import { evalGroup } from '../../src/core/groups.ts';
import type { Geometry } from '../../src/core/geometry.ts';

/** One check of a task (bench/llm/tasks/<id>.json "checks"). */
export interface Check {
  kind: 'cooks' | 'extent' | 'triangles' | 'pieces' | 'materials' | 'closed' | 'uv' | 'covers_inputs' | 'near_points';
  label?: string;
  /** extent: x | y | z | longest_horizontal | shortest_horizontal (x and z sorted, so a model may face either way) */
  axis?: string;
  min?: number;
  max?: number;
  /** points of the score this check is worth (default 1) */
  weight?: number;
  /** covers_inputs, near_points: a file in the task's package, relative to it */
  file?: string;
  /** near_points: the elements of `file` to find geometry at (a group pattern) and their class */
  group?: string;
  class?: 'point' | 'prim';
  /** near_points: metres, measured from above (x and z) */
  within?: number;
}

export interface Task {
  id: string;
  title: string;
  category: string;
  prompt: string;
  checks: Check[];
  /** a folder under bench/llm/tasks/ whose contents are copied into the agent's package before it starts (an inputs/ folder) */
  inputs?: string;
}

export interface CheckResult { label: string; kind: string; pass: boolean; detail: string; weight: number }

export interface Scored {
  ok: boolean;
  errors: string[];
  warnings: string[];
  /** 0..100: the weighted share of checks passed (0 when the graph does not cook) */
  score: number;
  checks: CheckResult[];
  stats: { triangles: number; pieces: number; materials: number; size: [number, number, number]; cookMs: number } | null;
}

const fmt = (x: number) => (Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(2));

/** A label for a check that has none, in words a person reads on the comparison page. */
export function checkLabel(c: Check): string {
  if (c.label) return c.label;
  const num = (x: number | undefined) => (x ?? 0).toLocaleString('en-US');
  const range = c.min !== undefined && c.max !== undefined ? `${num(c.min)}–${num(c.max)}` : c.min !== undefined ? `≥ ${num(c.min)}` : `≤ ${num(c.max)}`;
  switch (c.kind) {
    case 'cooks': return 'cooks without errors';
    case 'extent': return `${c.axis} extent ${range} m`;
    case 'triangles': return `${range} triangles`;
    case 'pieces': return `${range} pieces`;
    case 'materials': return `${range} materials`;
    case 'closed': return 'closed, watertight';
    case 'uv': return 'has uv';
    default: return c.kind;
  }
}

/** The geometry with packed instances cooked out (checks count what a renderer or an engine would draw). */
function flat(g: Geometry): Geometry {
  return g.hasPacked() ? expandPacked(g, {}).geo : g;
}

function materialCount(g: Geometry): number {
  const m = g.prims.get('material');
  if (!m || m.type !== 'string') return 0;
  const names = new Set<string>();
  for (let p = 0; p < g.numPrims; p++) { const v = String(m.get(p) ?? ''); if (v) names.add(v); }
  return names.size;
}

/** Cook a package graph file in its package, as the agent's own session would. */
export async function cookGraph(pkgDir: string, graphFile: string): Promise<{ ok: boolean; errors: string[]; warnings: string[]; geo: Geometry | null; ms: number }> {
  const engine = new Engine(createNodeHost({ baseDir: pkgDir }));
  await engine.init();
  openPackages(engine, pkgDir);
  let graph: any;
  try { graph = JSON.parse(fs.readFileSync(graphFile, 'utf8')); } catch (e: any) { return { ok: false, errors: [`the graph file does not parse: ${e.message}`], warnings: [], geo: null, ms: 0 }; }
  const t0 = performance.now();
  try {
    const r = await engine.cook(graph);
    return { ok: r.ok && !!r.geo, errors: r.errors.map((e) => `[${e.node}] ${e.message}`), warnings: r.warnings.map((w) => `[${w.node}] ${w.message}`), geo: r.geo ?? null, ms: performance.now() - t0 };
  } catch (e: any) {
    return { ok: false, errors: [`the cook threw: ${e?.message ?? e}`], warnings: [], geo: null, ms: performance.now() - t0 };
  }
}

async function readInput(pkgDir: string, file: string): Promise<Geometry> {
  const bytes = new Uint8Array(fs.readFileSync(path.join(pkgDir, file)));
  return importGeometryAsync(bytes, 'json', { path: file });
}

/** Run a task's checks on what was cooked. */
export async function runChecks(task: Task, cooked: { ok: boolean; errors: string[]; geo: Geometry | null }, pkgDir: string): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const g = cooked.geo && cooked.ok ? cooked.geo : null;
  const f = g ? flat(g) : null;
  const bb = f && f.numPoints ? f.bbox() : null;
  const size = bb ? [bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]] : null;
  for (const c of task.checks) {
    const label = checkLabel(c), weight = c.weight ?? 1;
    const res = (pass: boolean, detail: string) => out.push({ label, kind: c.kind, pass, detail, weight });
    const inRange = (v: number) => (c.min === undefined || v >= c.min) && (c.max === undefined || v <= c.max);
    if (c.kind === 'cooks') { res(!!g, g ? 'cooked' : cooked.errors[0] ?? 'nothing cooked'); continue; }
    if (!g || !f) { res(false, 'nothing cooked'); continue; }
    switch (c.kind) {
      case 'extent': {
        if (!size) { res(false, 'empty'); break; }
        const [sx, sy, sz] = size;
        const v = c.axis === 'x' ? sx : c.axis === 'y' ? sy : c.axis === 'z' ? sz : c.axis === 'longest_horizontal' ? Math.max(sx, sz) : Math.min(sx, sz);
        res(inRange(v), `${fmt(v)} m`);
        break;
      }
      case 'triangles': { const t = expandedTriangles(g); res(inRange(t), `${t.toLocaleString('en-US')} triangles`); break; }
      case 'pieces': { const n = connectivity(f).count; res(inRange(n), `${n} pieces`); break; }
      case 'materials': { const n = materialCount(f); res(inRange(n), `${n} material${n === 1 ? '' : 's'}`); break; }
      case 'closed': {
        if (!f.numPrims) { res(false, 'no polygons'); break; }
        const s = solidReport(f, { flips: false });
        res(s.closedAfterWeld, s.closedAfterWeld ? 'closed after welding seam splits' : `${s.openEdges} open, ${s.nonManifoldEdges} non-manifold edges`);
        break;
      }
      case 'uv': { const uv = f.findAttrib('uv', ['vertex', 'point']); res(!!uv, uv ? `uv on ${uv.cls}` : 'no uv attribute'); break; }
      case 'covers_inputs': {
        // the share of the guides' footprint (seen from above) that the result's footprint covers
        const ref = await readInput(pkgDir, c.file!), rb = ref.bbox();
        const ix = Math.max(0, Math.min(rb.max[0], bb!.max[0]) - Math.max(rb.min[0], bb!.min[0]));
        const iz = Math.max(0, Math.min(rb.max[2], bb!.max[2]) - Math.max(rb.min[2], bb!.min[2]));
        const area = Math.max(1e-9, (rb.max[0] - rb.min[0]) * (rb.max[2] - rb.min[2])), share = (ix * iz) / area;
        res(share >= (c.min ?? 1), `${(share * 100).toFixed(0)}% covered`);
        break;
      }
      case 'near_points': {
        // geometry within `within` metres (from above) of each chosen element of the guides
        const ref = await readInput(pkgDir, c.file!);
        const cls = c.class ?? 'prim', sel = evalGroup(ref, cls, c.group ?? '');
        const targets: number[][] = [];
        const n = cls === 'prim' ? ref.numPrims : ref.numPoints;
        for (let i = 0; i < n; i++) if (!sel || sel[i]) targets.push(cls === 'prim' ? primCentroid(ref, i) : [ref.P[i * 3], ref.P[i * 3 + 1], ref.P[i * 3 + 2]]);
        const r2 = (c.within ?? 1) ** 2, P = f.P;
        let hit = 0;
        for (const t of targets) {
          for (let i = 0; i < P.length; i += 3) { const dx = P[i] - t[0], dz = P[i + 2] - t[2]; if (dx * dx + dz * dz <= r2) { hit++; break; } }
        }
        res(targets.length > 0 && hit === targets.length, `${hit} of ${targets.length}`);
        break;
      }
      default: res(false, `unknown check kind "${(c as any).kind}"`);
    }
  }
  return out;
}

export const scoreOf = (checks: CheckResult[]) => {
  const total = checks.reduce((s, c) => s + c.weight, 0);
  return total ? Math.round((100 * checks.reduce((s, c) => s + (c.pass ? c.weight : 0), 0)) / total) : 0;
};

/** Cook, check, and write render.png, views.png and model.glb into outDir. */
export async function scoreResult(task: Task, pkgDir: string, graphFile: string | null, outDir: string): Promise<Scored> {
  fs.mkdirSync(outDir, { recursive: true });
  const cooked = graphFile ? await cookGraph(pkgDir, graphFile) : { ok: false, errors: ['the agent left no graph'], warnings: [], geo: null, ms: 0 };
  const checks = await runChecks(task, cooked, pkgDir);
  const g = cooked.ok ? cooked.geo : null;
  let stats: Scored['stats'] = null;
  if (g) {
    const f = flat(g), bb = f.bbox();
    stats = { triangles: expandedTriangles(g), pieces: connectivity(f).count, materials: materialCount(f), size: [bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]], cookMs: Math.round(cooked.ms) };
    const write = (name: string, args: Record<string, any>, crop?: number) => {
      const img = renderGeometry(g, { ...renderArgs(args), title: task.id });
      // the hero picture without the footer line (the views drawn are exactly the size asked for, above it)
      const h = crop && img.height > crop ? crop : img.height;
      fs.writeFileSync(path.join(outDir, name), encodePNG(img.rgba.subarray(0, img.width * h * 4), img.width, h, (d) => zlib.deflateSync(d)));
    };
    try { write('render.png', { views: ['persp'], size: '960x720', azimuth: 35, elevation: 22, grid: false, view_labels: false }, 720); } catch (e: any) { cooked.warnings.push(`render: ${e.message}`); }
    try { write('views.png', { views: ['front', 'right', 'top', 'persp'], size: 400 }); } catch (e: any) { cooked.warnings.push(`views: ${e.message}`); }
    try { fs.writeFileSync(path.join(outDir, 'model.glb'), await exportGeometryAsync(g, 'glb', { compress: 'meshopt', quantize: true })); } catch (e: any) { cooked.warnings.push(`glb: ${e.message}`); }
  }
  return { ok: !!g, errors: cooked.errors, warnings: cooked.warnings, score: g ? scoreOf(checks) : 0, checks, stats };
}
