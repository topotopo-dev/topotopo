// Benchmarks: named cooks with target times, printed as a Markdown table and written to bench/last.json.
//
//   npm run bench                         full sizes
//   npm run bench -- --quick              smaller sizes (CI smoke, quick local checks)
//   npm run bench -- --filter boolean     only cases whose name contains "boolean"
//   npm run bench -- --runs 5             timed runs per case (default 3, after one warm-up)
//   npm run bench -- --write-baseline     also store the results as bench/baseline.json
//   npm run bench -- --filter scatter --backend kernel   preload WASM and select the scatter backend
//   npm run bench -- --assert-auto --workers 4            scatter medians: auto <= 1.05 * min(kernel, js), pool off/on
//   npm run bench -- --assert-auto --runs 12              3 warm-ups; use multiples of 6 timed runs for balanced order
//   npm run bench -- --assert-auto --filter scatter_relax_mask --scatter-count 20000   tune the node count
//   npm run bench -- --output out/run.json               preserve a named report instead of bench/last.json
//
// Each case cooks a graph with a cleared cache (warm-up run, then best of N). The time reported is the target node's
// own cook time (inputs are cooked first and not counted); "total" is the whole graph. Targets are working goals.
// Results are informational: a missed target never fails the run (a failed cook does). bench/baseline.json is a
// reference run from one machine.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import '../src/nodes/index.ts';
import { Engine } from '../src/graph/engine.ts';
import { createNodeHost } from '../src/host/node.ts';
import { workersFromEnv } from '../src/host/pool.ts';
import { sampleEliminate } from '../src/core/scatter.ts';
import { rng } from '../src/core/random.ts';
import { getLoadedKernels, kernelsWasmURL, kernelsWasmVariant, loadKernels } from '../src/wasm/kernels.ts';
import type { GraphSpec, NodeSpec } from '../src/graph/types.ts';
import type { PoolStats } from '../src/graph/parallel.ts';
import type { WorkerPool } from '../src/host/types.ts';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const QUICK = args.includes('--quick');
const FILTER = flag('--filter');
const ASSERT_AUTO = args.includes('--assert-auto');
const ASSERT_AUTO_CASE = flag('--assert-auto-case');
const RUNS = Number(flag('--runs') ?? (ASSERT_AUTO || ASSERT_AUTO_CASE ? 12 : 3));
if (!Number.isInteger(RUNS) || RUNS < 1) throw new Error('--runs must be a positive integer');
const WORKERS = flag('--workers') === undefined ? workersFromEnv() : Number(flag('--workers'));
if (!Number.isInteger(WORKERS) || WORKERS < 0) throw new Error('--workers must be a nonnegative integer');
const SCATTER_COUNT = args.includes('--scatter-count') ? Number(flag('--scatter-count')) : undefined;
if (SCATTER_COUNT !== undefined && (!Number.isInteger(SCATTER_COUNT) || SCATTER_COUNT < 1 || SCATTER_COUNT > 1_000_000))
  throw new Error('--scatter-count must be an integer from 1 to 1000000');
const BACKEND = flag('--backend');
if (BACKEND !== undefined && !['auto', 'kernel', 'js'].includes(BACKEND)) throw new Error('--backend must be auto, kernel or js');
if ((ASSERT_AUTO || ASSERT_AUTO_CASE) && BACKEND !== undefined) throw new Error('--assert-auto measures all backends; omit --backend');
const OUTPUT = flag('--output');
const benchDir = path.dirname(fileURLToPath(import.meta.url));

interface Case {
  name: string;
  /** what is measured, for the table */
  what: (q: boolean) => string;
  /** element count the throughput is computed from */
  elements: (q: boolean) => number;
  unit: string;
  /** target for the full size (ms); quick runs scale it by quickScale */
  target: number;
  targetSource: string;
  /** Original full-size scatter node count; direct kernels and other node types do not use --scatter-count. */
  scatterFullCount?: number;
  graph?: (q: boolean) => GraphSpec;
  /** Prepare inputs outside the timed region, then measure the complete direct kernel call, including WASM copies. */
  direct?: (q: boolean) => (backend?: string) => ArrayLike<number>;
}

const k = (n: number) => (n >= 1e6 ? `${+(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}k` : String(n));
const scatterCount = (q: boolean, full: number) => SCATTER_COUNT ?? (q ? full / 10 : full);
const fullSize = (c: Case) => !QUICK && (!c.scatterFullCount || SCATTER_COUNT === undefined || SCATTER_COUNT === c.scatterFullCount);

/** Grid with about n faces (square, divisions d×d). */
const gridDiv = (faces: number) => Math.round(Math.sqrt(faces));
/** uv sphere rows/cols with about n triangles once triangulated: 2·(rows−2)·cols + 2·cols ≈ rows·cols·2 with cols = 2·rows. */
const sphereRows = (tris: number) => Math.round(Math.sqrt(tris / 4));
const uvSphereTris = (rows: number) => 2 * (rows - 2) * (2 * rows) + 2 * (2 * rows);

const CASES: Case[] = [
  {
    name: 'scatter_eliminate_1m',
    what: (q) => `weighted elimination of ${k(q ? 1e5 : 1e6)} uniform candidates to ${k(q ? 1e4 : 1e5)} points (neighbour search + heap + ABI copies)`,
    elements: (q) => q ? 1e5 : 1e6, unit: 'candidates',
    target: 1500, targetSource: 'K-10 session 12 (1M candidates to 100k under 1.5 s)',
    direct: (q) => {
      const count = q ? 1e5 : 1e6, target = q ? 1e4 : 1e5, random = rng(1);
      const positions = new Float64Array(count * 3);
      for (let i = 0; i < count; i++) { positions[i * 3] = random() * 100; positions[i * 3 + 2] = random() * 100; }
      const radius = Math.sqrt(10000 / (2 * Math.sqrt(3) * target));
      return (backend) => {
        const kernels = backend === 'js' ? undefined : getLoadedKernels();
        return kernels ? kernels.scatter_eliminate(positions, target, radius) : sampleEliminate(positions, target, radius);
      };
    },
  },
  {
    name: 'scatter_1m',
    what: (q) => `scatter ${k(scatterCount(q, 1e6))} points on a grid (relax off)`,
    elements: (q) => scatterCount(q, 1e6), unit: 'points', scatterFullCount: 1e6,
    target: 1000, targetSource: 'roadmap §1.7 (scatter + packed copy of 1M under 1 s)',
    graph: (q) => ({
      nodes: {
        g: { type: 'grid', params: { size: [100, 100], divisions: [100, 100] } },
        target: { type: 'scatter', in: ['g'], params: { count: scatterCount(q, 1e6), relax: false, seed: 1 } },
      },
    }),
  },
  {
    name: 'copy_to_points_100k',
    what: (q) => `copy a 100-triangle mesh to ${k(q ? 1e4 : 1e5)} points`,
    elements: (q) => (q ? 1e4 : 1e5) * 100, unit: 'triangles out',
    target: 1000, targetSource: 'goal (roadmap targets packed copies; these are real copies)',
    graph: (q) => ({
      nodes: {
        tg: { type: 'grid', params: { size: [0.05, 0.05], divisions: [10, 5] } },
        tt: { type: 'triangulate', in: ['tg'] },
        tmpl: { type: 'attrib_delete', in: ['tt'], params: { names: '*' } },
        pts: { type: 'point_grid', params: { counts: q ? [100, 1, 100] : [100, 10, 100], size: [100, 10, 100] } },
        target: { type: 'copy_to_points', in: ['tmpl', 'pts'] },
      },
    }),
  },
  {
    name: 'subdivide_100k',
    what: (q) => `Catmull-Clark, 1 level, ${k(gridDiv(q ? 1e4 : 1e5) ** 2)}-face grid`,
    elements: (q) => gridDiv(q ? 1e4 : 1e5) ** 2, unit: 'input faces',
    target: 500, targetSource: 'roadmap §1.7 (100k faces × 2 levels under 1 s)',
    graph: (q) => ({
      nodes: {
        g: { type: 'grid', params: { size: [10, 10], divisions: [gridDiv(q ? 1e4 : 1e5), gridDiv(q ? 1e4 : 1e5)] } },
        target: { type: 'subdivide', in: ['g'], params: { levels: 1 } },
      },
    }),
  },
  {
    name: 'subdivide_100k_x2',
    what: (q) => `Catmull-Clark, 2 levels, ${k(gridDiv(q ? 1e4 : 1e5) ** 2)}-face grid`,
    elements: (q) => gridDiv(q ? 1e4 : 1e5) ** 2, unit: 'input faces',
    target: 1000, targetSource: 'roadmap §1.7',
    graph: (q) => ({
      nodes: {
        g: { type: 'grid', params: { size: [10, 10], divisions: [gridDiv(q ? 1e4 : 1e5), gridDiv(q ? 1e4 : 1e5)] } },
        target: { type: 'subdivide', in: ['g'], params: { levels: 2 } },
      },
    }),
  },
  {
    name: 'boolean_100k',
    what: (q) => `boolean subtract of two ${k(uvSphereTris(sphereRows(q ? 2e4 : 1e5)))}-triangle spheres`,
    elements: (q) => 2 * uvSphereTris(sphereRows(q ? 2e4 : 1e5)), unit: 'input triangles',
    target: 1200, targetSource: 'roadmap §1.7 (500k triangles under 3 s), scaled to 200k',
    graph: (q) => booleanGraph(sphereRows(q ? 2e4 : 1e5)),
  },
  {
    name: 'boolean_500k',
    what: (q) => `boolean subtract of two ${k(uvSphereTris(sphereRows(q ? 5e4 : 2.5e5)))}-triangle spheres`,
    elements: (q) => 2 * uvSphereTris(sphereRows(q ? 5e4 : 2.5e5)), unit: 'input triangles',
    target: 3000, targetSource: 'roadmap §1.7',
    graph: (q) => booleanGraph(sphereRows(q ? 5e4 : 2.5e5)),
  },
  {
    name: 'noise_displace_1m',
    what: (q) => `noise_displace (fbm, along normals) on ${k((gridDiv(q ? 1e5 : 1e6) + 1) ** 2)} points`,
    elements: (q) => (gridDiv(q ? 1e5 : 1e6) + 1) ** 2, unit: 'points',
    target: 1000, targetSource: 'goal',
    graph: (q) => ({
      nodes: {
        g: { type: 'grid', params: { size: [10, 10], divisions: [gridDiv(q ? 1e5 : 1e6), gridDiv(q ? 1e5 : 1e6)] } },
        target: { type: 'noise_displace', in: ['g'], params: { amplitude: 0.2, frequency: 2 } },
      },
    }),
  },
  {
    name: 'wrangle_1m',
    what: (q) => `point wrangle (sin + colour) over ${k((gridDiv(q ? 1e5 : 1e6) + 1) ** 2)} points`,
    elements: (q) => (gridDiv(q ? 1e5 : 1e6) + 1) ** 2, unit: 'points',
    target: 500, targetSource: 'goal',
    graph: (q) => ({
      nodes: {
        g: { type: 'grid', params: { size: [10, 10], divisions: [gridDiv(q ? 1e5 : 1e6), gridDiv(q ? 1e5 : 1e6)] } },
        target: { type: 'wrangle', in: ['g'], params: { code: '@P.y += sin(@P.x * 3) * 0.1;\n@Cd = [@P.x, @P.y, 0.5];' } },
      },
    }),
  },
  {
    name: 'sdf_to_mesh_128',
    what: (q) => `sdf_to_mesh of a torus at ${q ? 64 : 128}³`,
    elements: (q) => (q ? 64 : 128) ** 3, unit: 'voxels',
    target: 1000, targetSource: 'goal',
    graph: (q) => ({
      nodes: {
        s: { type: 'sdf_shape', params: { shape: 'torus', radius: 0.6, radius2: 0.2 } },
        target: { type: 'sdf_to_mesh', in: ['s'], params: { divisions: q ? 64 : 128 } },
      },
    }),
  },
  {
    name: 'triangulate_500k',
    what: (q) => `triangulate a ${k(gridDiv(q ? 5e4 : 5e5) ** 2)}-quad grid`,
    elements: (q) => gridDiv(q ? 5e4 : 5e5) ** 2, unit: 'polygons',
    target: 500, targetSource: 'goal',
    graph: (q) => ({
      nodes: {
        g: { type: 'grid', params: { size: [10, 10], divisions: [gridDiv(q ? 5e4 : 5e5), gridDiv(q ? 5e4 : 5e5)] } },
        target: { type: 'triangulate', in: ['g'] },
      },
    }),
  },
  {
    name: 'merge_100',
    what: (q) => `merge ${q ? 20 : 100} spheres (1280 triangles each)`,
    elements: (q) => (q ? 20 : 100) * 1280, unit: 'triangles out',
    target: 100, targetSource: 'goal',
    graph: (q) => {
      const n = q ? 20 : 100;
      const nodes: Record<string, NodeSpec> = {};
      const ins: string[] = [];
      for (let i = 0; i < n; i++) {
        nodes[`s${i}`] = { type: 'sphere', params: { type: 'ico', level: 3, radius: 0.4, center: [i % 10, 0, Math.floor(i / 10)] } };
        ins.push(`s${i}`);
      }
      nodes.target = { type: 'merge', in: ins };
      return { nodes, output: 'target' };
    },
  },
  {
    name: 'fuse_500k',
    what: (q) => `fuse ${k(2 * (gridDiv(q ? 5e4 : 2.5e5) + 1) ** 2)} points (every point doubled)`,
    elements: (q) => 2 * (gridDiv(q ? 5e4 : 2.5e5) + 1) ** 2, unit: 'points',
    target: 1000, targetSource: 'goal',
    graph: (q) => ({
      nodes: {
        g: { type: 'grid', params: { size: [10, 10], divisions: [gridDiv(q ? 5e4 : 2.5e5), gridDiv(q ? 5e4 : 2.5e5)] } },
        two: { type: 'copy_xform', in: ['g'], params: { count: 2, translate: [0, 0, 0] } },
        target: { type: 'fuse', in: ['two'], params: { distance: 1e-4 } },
      },
    }),
  },
  {
    name: 'occlusion_50k',
    what: (q) => `occlusion (32 rays per point, BVH build included) on a noisy sphere with ${k(q ? 63 * 80 + 2 : 198 * 251 + 2)} points`,
    elements: (q) => (q ? 63 * 80 + 2 : 198 * 251 + 2) * 32, unit: 'rays',
    target: 2000, targetSource: 'P1-F (50k points × 32 samples under 2 s)',
    graph: (q) => ({
      nodes: {
        s: { type: 'sphere', params: { rows: q ? 64 : 199, cols: q ? 80 : 251 } },
        n: { type: 'noise_displace', in: ['s'], params: { amplitude: 0.3, frequency: 2 } },
        target: { type: 'occlusion', in: ['n'], params: { samples: 32 } },
      },
    }),
  },
  {
    name: 'tex_noise_2048',
    what: (q) => `tex_noise ${q ? 512 : 2048}² (perlin fbm, 5 octaves, tileable)`,
    elements: (q) => (q ? 512 : 2048) ** 2, unit: 'pixels',
    target: 1000, targetSource: 'P3-T (2048² noise under 1 s with the pool)',
    graph: (q) => ({ nodes: { target: { type: 'tex_noise', params: { resolution: q ? 512 : 2048 } } } }),
  },
  {
    name: 'bake_curvature_50k_2048',
    what: (q) => `bake_curvature ${q ? 512 : 2048}² of a noisy ${k(q ? 2 * 80 * 80 : 2 * 160 * 160)}-triangle grid (uv covers 0..1)`,
    elements: (q) => (q ? 512 : 2048) ** 2, unit: 'texels',
    target: 5000, targetSource: 'P3-T (bakes of a 50k-triangle mesh at 2048² under 5 s)',
    graph: (q) => ({
      nodes: {
        g: { type: 'grid', params: { size: [4, 4], divisions: q ? [80, 80] : [160, 160] } },
        n: { type: 'noise_displace', in: ['g'], params: { amplitude: 0.3, frequency: 1.2 } },
        target: { type: 'bake_curvature', in: ['n'], params: { resolution: q ? 512 : 2048 } },
      },
    }),
  },
  {
    name: 'bake_ao_50k_2048',
    what: (q) => `bake_ao ${q ? 512 : 2048}² (8 rays per texel) of a noisy ${k(q ? 2 * 80 * 80 : 2 * 160 * 160)}-triangle grid (uv covers 0..1)`,
    elements: (q) => (q ? 512 : 2048) ** 2 * 8, unit: 'rays',
    target: 5000, targetSource: 'P3-T (bakes of a 50k-triangle mesh at 2048² under 5 s)',
    graph: (q) => ({
      nodes: {
        g: { type: 'grid', params: { size: [4, 4], divisions: q ? [80, 80] : [160, 160] } },
        n: { type: 'noise_displace', in: ['g'], params: { amplitude: 0.3, frequency: 1.2 } },
        target: { type: 'bake_ao', in: ['n'], params: { resolution: q ? 512 : 2048, samples: 8 } },
      },
    }),
  },
  {
    name: 'copy_to_points_1m_packed',
    what: (q) => `packed copies of a 100-triangle mesh on ${k(q ? 1e5 : 1e6)} points (orient + pscale)`,
    elements: (q) => (q ? 1e5 : 1e6), unit: 'instances',
    target: 1000, targetSource: 'roadmap §1.7 (scatter + packed copy of 1M under 1 s)',
    graph: (q) => ({
      nodes: {
        tg: { type: 'grid', params: { size: [0.05, 0.05], divisions: [10, 5] } },
        tt: { type: 'triangulate', in: ['tg'] },
        tmpl: { type: 'attrib_delete', in: ['tt'], params: { names: '*' } },
        pts: { type: 'point_grid', params: { counts: q ? [100, 10, 100] : [100, 100, 100], size: [100, 10, 100] } },
        ori: { type: 'attrib_randomize', in: ['pts'], params: { name: 'orient', distribution: 'orient' } },
        sc: { type: 'attrib_randomize', in: ['ori'], params: { name: 'pscale', min: 0.5, max: 1.5 } },
        target: { type: 'copy_to_points', in: ['tmpl', 'sc'], params: { pack: true } },
      },
    }),
  },
  {
    name: 'unpack_100k',
    what: (q) => `unpack ${k(q ? 1e4 : 1e5)} packed instances of a 100-triangle mesh`,
    elements: (q) => (q ? 1e4 : 1e5) * 100, unit: 'triangles out',
    target: 2000, targetSource: 'goal (P2-A)',
    graph: (q) => ({
      nodes: {
        tg: { type: 'grid', params: { size: [0.05, 0.05], divisions: [10, 5] } },
        tt: { type: 'triangulate', in: ['tg'] },
        tmpl: { type: 'attrib_delete', in: ['tt'], params: { names: '*' } },
        pts: { type: 'point_grid', params: { counts: q ? [100, 1, 100] : [100, 10, 100], size: [100, 10, 100] } },
        ori: { type: 'attrib_randomize', in: ['pts'], params: { name: 'orient', distribution: 'orient' } },
        cp: { type: 'copy_to_points', in: ['tmpl', 'ori'], params: { pack: true } },
        target: { type: 'unpack', in: ['cp'] },
      },
    }),
  },
  {
    name: 'heightfield_erode_512',
    what: (q) => `erosion (droplets + thermal), ${q ? 256 : 512}² samples × 100 iterations`,
    elements: (q) => (q ? 256 : 512) ** 2 * 100, unit: 'sample-iterations',
    target: 3000, targetSource: 'P2-C brief (512² × 100 iterations under 3 s)',
    graph: (q) => ({
      nodes: {
        hf: { type: 'heightfield', params: { size: [51.1, 51.1], samples: [q ? 256 : 512, q ? 256 : 512] } },
        n: { type: 'heightfield_noise', in: ['hf'], params: { amplitude: 5, element_size: 10, range: 'positive', seed: 1 } },
        target: { type: 'heightfield_erode', in: ['n'], params: { iterations: 100, seed: 1 } },
      },
    }),
  },
  {
    name: 'scatter_relax_100k',
    what: (q) => `scatter ${k(scatterCount(q, 1e5))} points on a grid with relax (sample elimination of 5× candidates)`,
    elements: (q) => scatterCount(q, 1e5), unit: 'points', scatterFullCount: 1e5,
    target: 500, targetSource: 'K-10 session 12 (100k relaxed blue-noise points under 0.5 s)',
    graph: (q) => ({
      nodes: {
        g: { type: 'grid', params: { size: [100, 100], divisions: [100, 100] } },
        target: { type: 'scatter', in: ['g'], params: { count: scatterCount(q, 1e5), seed: 1 } },
      },
    }),
  },
  {
    name: 'scatter_relax_mask_100k',
    what: (q) => `scatter ${k(scatterCount(q, 1e5))} points by a noise density mask, relax (radii follow the density)`,
    elements: (q) => scatterCount(q, 1e5), unit: 'points', scatterFullCount: 1e5,
    target: 1000, targetSource: 'K-10 session 12 (100k density-mask blue-noise points under 1 s)',
    graph: (q) => ({
      nodes: {
        g: { type: 'grid', params: { size: [100, 100], divisions: [100, 100] } },
        m: { type: 'mask', in: ['g'], params: { by: 'noise', min: 0.3, max: 1, falloff: 0.1 } },
        target: { type: 'scatter', in: ['m'], params: { count: scatterCount(q, 1e5), seed: 1, generate_by: 'count', density_mask: 'mask' } },
      },
    }),
  },
  {
    name: 'scatter_relax_iter_50k',
    what: (q) => `scatter ${k(scatterCount(q, 5e4))} points with relax and 5 relaxation passes (projected back onto the surface)`,
    elements: (q) => scatterCount(q, 5e4) * 5, unit: 'point-passes', scatterFullCount: 5e4,
    target: 2000, targetSource: 'R-8 (goal)',
    graph: (q) => ({
      nodes: {
        g: { type: 'grid', params: { size: [100, 100], divisions: [100, 100] } },
        n: { type: 'noise_displace', in: ['g'], params: { amplitude: 2, frequency: 0.05 } },
        target: { type: 'scatter', in: ['n'], params: { count: scatterCount(q, 5e4), seed: 1, relax_iterations: 5 } },
      },
    }),
  },
  {
    name: 'scatter_min_distance_100k',
    what: (q) => `scatter ${k(scatterCount(q, 1e5))} points with relax and an exact min distance (refills from 5× candidates)`,
    elements: (q) => scatterCount(q, 1e5), unit: 'points', scatterFullCount: 1e5,
    target: 2000, targetSource: 'R-8 (goal)',
    graph: (q) => ({
      nodes: {
        g: { type: 'grid', params: { size: [100, 100], divisions: [100, 100] } },
        target: { type: 'scatter', in: ['g'], params: { count: scatterCount(q, 1e5), seed: 1, min_distance: q ? 0.8 : 0.25 } },
      },
    }),
  },
  {
    name: 'heightfield_scatter_100k',
    what: (q) => `heightfield_scatter ${k(q ? 1e4 : 1e5)} points with relax on a ${q ? 101 : 401}² field`,
    elements: (q) => (q ? 1e4 : 1e5), unit: 'points',
    target: 2000, targetSource: 'R-8 (goal)',
    graph: (q) => ({
      nodes: {
        h: { type: 'heightfield', params: { size: [200, 200], samples: q ? [101, 101] : [401, 401] } },
        n: { type: 'heightfield_noise', in: ['h'], params: { amplitude: 5, element_size: 20 } },
        target: { type: 'heightfield_scatter', in: ['n'], params: { count: q ? 1e4 : 1e5, mask_layer: '', seed: 1 } },
      },
    }),
  },
  {
    name: 'point_normals_1m',
    what: (q) => `normal (point normals, area-weighted) on a noisy ${k((gridDiv(q ? 1e5 : 1e6) + 1) ** 2)}-point grid`,
    elements: (q) => (gridDiv(q ? 1e5 : 1e6) + 1) ** 2, unit: 'points',
    target: 200, targetSource: 'R-8 (goal)',
    graph: (q) => ({
      nodes: {
        g: { type: 'grid', params: { size: [10, 10], divisions: [gridDiv(q ? 1e5 : 1e6), gridDiv(q ? 1e5 : 1e6)] } },
        n: { type: 'noise_displace', in: ['g'], params: { amplitude: 0.2, frequency: 2 } },
        target: { type: 'normal', in: ['n'], params: { class: 'point' } },
      },
    }),
  },
  {
    name: 'distance_100k',
    what: (q) => `distance: closest points on a ${k(uvSphereTris(sphereRows(q ? 1e4 : 1e5)))}-triangle sphere from ${k((q ? 100 : 316) ** 2)} points (BVH build included)`,
    elements: (q) => (q ? 100 : 316) ** 2, unit: 'queries',
    target: 1000, targetSource: 'R-8 (goal)',
    graph: (q) => ({
      nodes: {
        s: { type: 'sphere', params: { type: 'uv', rows: sphereRows(q ? 1e4 : 1e5), cols: 2 * sphereRows(q ? 1e4 : 1e5) } },
        p: { type: 'point_grid', params: { counts: [q ? 100 : 316, 1, q ? 100 : 316], size: [3, 0, 3], center: [0, 0.3, 0] } },
        target: { type: 'distance', in: ['p', 's'], params: { extra: true } },
      },
    }),
  },
  {
    name: 'subdivide_sphere_100k',
    what: (q) => `Catmull-Clark, 1 level, UV sphere with ${k(uvSphereFaces(q ? 71 : 224))} faces (vertex N, vertex uv)`,
    elements: (q) => uvSphereFaces(q ? 71 : 224), unit: 'input faces',
    target: 500, targetSource: 'goal (P0-F: attribute interpolation + normal refresh)',
    graph: (q) => ({
      nodes: {
        s: { type: 'sphere', params: { rows: q ? 71 : 224, cols: q ? 142 : 448 } },
        n: { type: 'normal', in: ['s'] },
        target: { type: 'subdivide', in: ['n'], params: { levels: 1 } },
      },
    }),
  },
  {
    name: 'ray_100k',
    what: (q) => `ray node: project ${k((q ? 100 : 316) ** 2)} points onto a ${k(uvSphereTris(sphereRows(q ? 1e4 : 1e5)))}-triangle sphere (BVH build included)`,
    elements: (q) => (q ? 100 : 316) ** 2, unit: 'rays',
    target: 1000, targetSource: 'goal (P0-F)',
    graph: (q) => ({
      nodes: {
        s: { type: 'sphere', params: { type: 'uv', rows: sphereRows(q ? 1e4 : 1e5), cols: 2 * sphereRows(q ? 1e4 : 1e5) } },
        p: { type: 'point_grid', params: { counts: [q ? 100 : 316, 1, q ? 100 : 316], size: [1.6, 0, 1.6], center: [0, 3, 0] } },
        target: { type: 'ray', in: ['p', 's'] },
      },
    }),
  },
  {
    name: 'particles_100k',
    what: (q) => `particles: ${k(q ? 1e4 : 1e5)} particles × 200 steps falling and bouncing on a floor (emit_all, velocity_var 2)`,
    elements: (q) => (q ? 1e4 : 1e5) * 200, unit: 'particle-steps',
    target: 3000, targetSource: 'P3-B (100k × 200 steps with floor collisions under 3 s with the pool)',
    graph: (q) => ({
      nodes: {
        p: { type: 'point_grid', params: { counts: [50, 1, q ? 200 : 2000], size: [10, 0, q ? 40 : 400], center: [0, 5, 0] } },
        target: { type: 'particles', in: ['p'], params: { steps: 200, emit_all: true, emit_rate: 0, velocity_var: 2, floor: true, collide: 'bounce', seed: 1 } },
      },
    }),
  },
  {
    name: 'drape_100x100',
    what: (q) => `drape: a ${q ? 50 : 100}×${q ? 50 : 100} cloth, 200 steps over a 5k-triangle sphere and the floor`,
    elements: (q) => (q ? 51 : 101) ** 2 * 200, unit: 'point-steps',
    target: 3000, targetSource: 'brief P3-C (100×100 cloth, 200 steps, floor + mesh collisions under 3 s)',
    graph: (q) => ({
      nodes: {
        cloth: { type: 'grid', params: { size: [4, 4], divisions: [q ? 50 : 100, q ? 50 : 100], center: [0, 2.2, 0] } },
        ball: { type: 'sphere', params: { type: 'ico', level: 4, radius: 1, center: [0, 1, 0] } },
        target: { type: 'drape', in: ['cloth', 'ball'], params: { steps: 200 } },
      },
    }),
  },
];

/** Faces of a UV sphere with `rows` rows and 2·rows columns (triangle caps + quads). */
function uvSphereFaces(rows: number) { return 2 * rows * rows; }

function booleanGraph(rows: number): GraphSpec {
  return {
    nodes: {
      a: { type: 'sphere', params: { type: 'uv', rows, cols: 2 * rows, radius: 1 } },
      b: { type: 'sphere', params: { type: 'uv', rows, cols: 2 * rows, radius: 0.8, center: [0.7, 0.2, 0.1] } },
      target: { type: 'boolean', in: ['a', 'b'], params: { operation: 'subtract' } },
    },
  };
}

// ------------------------------------------------------------------ run

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function writeReport(outputPath: string, report: unknown) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
}

type ScatterBackend = 'auto' | 'kernel' | 'js';
const AUTO_BACKENDS: ScatterBackend[] = ['auto', 'kernel', 'js'];
// All six permutations balance both positions and preceding backends. The first three also balance positions
// for warm-up. Multiples of six timed rounds preserve the balance; explicit --runs values are always honored.
const AUTO_ORDERS: ScatterBackend[][] = [
  ['auto', 'kernel', 'js'], ['kernel', 'js', 'auto'], ['js', 'auto', 'kernel'],
  ['auto', 'js', 'kernel'], ['js', 'kernel', 'auto'], ['kernel', 'auto', 'js'],
];
const AUTO_LIMIT = 1.05;
const AUTO_WARMUPS = 3;
interface AutoResult {
  name: string; what: string; workers: number; runs: number; warmups: number; out: string;
  scatter_count: number | null; elements: number; unit: string; target_ms: number; target_applicable: boolean;
  pool: { requested_threads: number; warmed_threads: number; min_elements: number | null; stats: ReturnType<WorkerPool['stats']> | null };
  backends: Record<ScatterBackend, {
    median_ms: number; runs_ms: number[]; total_median_ms: number;
    /** Engine pool counters for timed whole-graph cooks, including input nodes; excludes warm-ups. */
    pool_stats: PoolStats; pool_runs: PoolStats[];
  }>;
  fastest_ms: number; auto_ratio: number; limit: number; passed: boolean; peak_rss_bytes: number;
}

/** One child owns one case and pool; its exit releases retained WASM heaps and worker shared-array caches. */
async function measureAuto(c: Case): Promise<AutoResult> {
  await loadKernels(fs.readFileSync(kernelsWasmURL));
  // Direct elimination has no pool integration; avoid starting unused workers for it.
  const direct = c.direct?.(QUICK);
  const requestedThreads = direct ? 0 : WORKERS;
  const host = createNodeHost({ baseDir: benchDir, workers: requestedThreads, pool: { idleMs: 300_000 } });
  const engine = direct ? undefined : new Engine(host);
  const times: Record<ScatterBackend, number[]> = { auto: [], kernel: [], js: [] };
  const totals: Record<ScatterBackend, number[]> = { auto: [], kernel: [], js: [] };
  const poolRuns: Record<ScatterBackend, PoolStats[]> = { auto: [], kernel: [], js: [] };
  let warmedThreads = 0, poolStats: ReturnType<WorkerPool['stats']> | null = null;
  let out = '';
  async function measure(backend: ScatterBackend) {
    engine?.cache.clear();
    const before = engine ? { ...engine.poolStats } : { parallel: 0, serial: 0, chunks: 0 };
    // The child is launched with --expose-gc. Collection is outside the measured region, after old results/cache
    // have become unreachable, so one backend does not inherit another backend's garbage-collection bill.
    globalThis.gc?.();
    if (direct) {
      const t = performance.now(), kept = direct(backend), ms = performance.now() - t;
      out = `${k(kept.length)} kept`;
      return { ms, total: ms, poolStats: before };
    }
    const graph = c.graph!(QUICK);
    for (const node of Object.values(graph.nodes))
      if (node.type === 'scatter') node.params = { ...node.params, backend };
    const r = await engine!.cook(graph, { target: 'target' });
    if (!r.ok || !r.geo) throw new Error(r.errors.map((e) => `[${e.node}] ${e.message}`).join('; '));
    out = `${k(r.geo.numPoints)} pts, ${k(r.geo.numPrims)} prims`;
    const ms = r.results.get('target')!.ms;
    engine!.cache.clear();
    const after = engine!.poolStats;
    return { ms, total: r.ms, poolStats: {
      parallel: after.parallel - before.parallel, serial: after.serial - before.serial, chunks: after.chunks - before.chunks,
    } };
  }
  try {
    await engine?.init();
    await host.pool?.warm();
    warmedThreads = host.pool?.threads ?? 0;
    if (warmedThreads !== requestedThreads)
      throw new Error(`worker pool warm-up started ${warmedThreads}/${requestedThreads} requested threads; refusing a serial-fallback benchmark`);
    // Warm every complete path, including lazily loaded worker WASM, then repeat the complete six-order schedule.
    for (let round = -AUTO_WARMUPS; round < RUNS; round++) {
      const order = AUTO_ORDERS[(round < 0 ? round + AUTO_WARMUPS : round) % AUTO_ORDERS.length];
      for (const backend of order) {
        const measured = await measure(backend);
        if (round >= 0) {
          times[backend].push(measured.ms); totals[backend].push(measured.total); poolRuns[backend].push(measured.poolStats);
        }
      }
    }
    poolStats = host.pool?.stats() ?? null;
    if (poolStats && (poolStats.crashes > 0 || poolStats.timeouts > 0))
      throw new Error(`worker pool had ${poolStats.crashes} crashes and ${poolStats.timeouts} timeouts; refusing a degraded benchmark`);
  } finally {
    engine?.cache.clear();
    await host.pool?.close();
  }
  const backends = Object.fromEntries(AUTO_BACKENDS.map((backend) => [backend, {
    median_ms: median(times[backend]), runs_ms: times[backend], total_median_ms: median(totals[backend]),
    pool_stats: poolRuns[backend].reduce((sum, stats) => ({
      parallel: sum.parallel + stats.parallel, serial: sum.serial + stats.serial, chunks: sum.chunks + stats.chunks,
    }), { parallel: 0, serial: 0, chunks: 0 }), pool_runs: poolRuns[backend],
  }])) as AutoResult['backends'];
  const fastest = Math.min(backends.kernel.median_ms, backends.js.median_ms);
  return { name: c.name, what: c.what(QUICK), workers: WORKERS, runs: RUNS, warmups: AUTO_WARMUPS, out, backends,
    scatter_count: c.scatterFullCount ? scatterCount(QUICK, c.scatterFullCount) : null,
    elements: c.elements(QUICK), unit: c.unit, target_ms: c.target, target_applicable: fullSize(c),
    pool: { requested_threads: requestedThreads, warmed_threads: warmedThreads, min_elements: host.pool?.minElements ?? null, stats: poolStats },
    fastest_ms: fastest, auto_ratio: backends.auto.median_ms / fastest, limit: AUTO_LIMIT,
    passed: backends.auto.median_ms <= AUTO_LIMIT * fastest, peak_rss_bytes: process.resourceUsage().maxRSS * 1024 };
}

if (ASSERT_AUTO_CASE) {
  const c = CASES.find((c) => c.name === ASSERT_AUTO_CASE && c.name.startsWith('scatter_'));
  if (!c) throw new Error(`unknown scatter assertion case: ${ASSERT_AUTO_CASE}`);
  console.log(JSON.stringify(await measureAuto(c)));
  process.exit(0);
}

if (ASSERT_AUTO) {
  const selected = CASES.filter((c) => c.name.startsWith('scatter_') && (!FILTER || c.name.includes(FILTER)));
  if (!selected.length) throw new Error(`no scatter assertion case matches "${FILTER ?? ''}"`);
  const pools = [...new Set([0, WORKERS])];
  const outputPath = OUTPUT ? path.resolve(OUTPUT) : path.join(benchDir, 'last.json');
  const results: AutoResult[] = [], errors: { name: string; workers: number; error: string }[] = [];
  const report = {
    generated: new Date().toISOString(), node: process.version, platform: `${process.platform}-${process.arch}`,
    cpu: os.cpus()[0]?.model ?? '', cpus: os.cpus().length, quick: QUICK, runs: RUNS, warmups: AUTO_WARMUPS,
    wasm: kernelsWasmVariant, workers: pools, scatter_count: SCATTER_COUNT ?? null,
    backend_orders: AUTO_ORDERS, balanced_order: RUNS % AUTO_ORDERS.length === 0,
    assertion: 'median(auto) <= 1.05 * min(median(kernel), median(js))',
    results, errors,
  };
  console.log(`scatter --assert-auto${QUICK ? ' (quick)' : ''}: ${selected.length} cases, workers ${pools.join('/')}, ${AUTO_WARMUPS} warm-ups + median of ${RUNS}\n`);
  if (RUNS % AUTO_ORDERS.length !== 0) console.log(`  honoring --runs ${RUNS}; multiples of 6 balance every backend order`);
  if (selected.some((c) => c.direct)) console.log('  direct elimination is measured once with workers 0; it has no pool integration');
  for (const workers of pools) for (const c of selected) {
    if (c.direct && workers !== 0) continue;
    console.log(`  measuring ${c.name}, workers ${workers}...`);
    const childArgs = [
      ...process.execArgv.filter((arg) => arg !== '--expose-gc'), '--expose-gc', fileURLToPath(import.meta.url),
      '--assert-auto-case', c.name, '--workers', String(workers), '--runs', String(RUNS), ...(QUICK ? ['--quick'] : []),
      ...(SCATTER_COUNT === undefined ? [] : ['--scatter-count', String(SCATTER_COUNT)]),
    ];
    const child = spawnSync(process.execPath, childArgs, { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    try {
      if (child.error) throw child.error;
      if (child.status !== 0) throw new Error(`child exit ${child.status}${child.signal ? ` (${child.signal})` : ''}: ${child.stderr.trim()}`);
      const result = JSON.parse(child.stdout.trim()) as AutoResult;
      results.push(result);
      const b = result.backends;
      console.log(`  ${result.passed ? 'PASS' : 'FAIL'} ${c.name}: auto ${b.auto.median_ms.toFixed(1)} ms, kernel ${b.kernel.median_ms.toFixed(1)} ms, js ${b.js.median_ms.toFixed(1)} ms; ratio ${result.auto_ratio.toFixed(4)} <= ${AUTO_LIMIT}`);
    } catch (error) {
      errors.push({ name: c.name, workers, error: String(error) });
      console.log(`  FAIL ${c.name}: ${error}`);
    }
    // Checkpoint every completed child, so an interrupted long run preserves its earlier samples.
    writeReport(outputPath, report);
  }
  const failed = errors.length + results.filter((r) => !r.passed).length;
  console.log(`\nwrote ${OUTPUT ?? 'bench/last.json'}; ${results.length + errors.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

const host = createNodeHost({ baseDir: benchDir, workers: WORKERS });
const engine = new Engine(host);
await engine.init();
if (BACKEND === 'kernel' || BACKEND === 'auto') await loadKernels(fs.readFileSync(kernelsWasmURL));

const baselinePath = path.join(benchDir, 'baseline.json');
const baseline = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, 'utf8')) : null;
const baselineMs = (name: string, elements: number): number | undefined =>
  baseline && baseline.quick === QUICK ? baseline.results?.find((r: any) => r.name === name && r.elements === elements)?.ms : undefined;

interface Result {
  name: string; what: string; elements: number; unit: string; ms: number; median_ms: number; runs: number[]; total_ms: number;
  elements_per_sec: number; target_ms: number; target_source: string; target_applicable: boolean; meets_target: boolean | null;
  scatter_count: number | null; out: string;
}
const results: Result[] = [];
let failed = 0;
const selected = CASES.filter((c) => !FILTER || c.name.includes(FILTER));
if (!selected.length) { console.log(`no benchmark matches "${FILTER}". Cases: ${CASES.map((c) => c.name).join(', ')}`); process.exit(1); }

console.log(`topotopo bench${QUICK ? ' (quick)' : ''}: ${selected.length} case(s), warm-up + best of ${RUNS} · node ${process.version} · ${os.cpus()[0]?.model ?? os.arch()} · backend ${BACKEND ?? 'default'}${getLoadedKernels() ? ` (${kernelsWasmVariant})` : ''}\n`);
for (const c of selected) {
  const graph = c.graph?.(QUICK), direct = c.direct?.(QUICK);
  if (graph && BACKEND) for (const node of Object.values(graph.nodes))
    if (node.type === 'scatter') node.params = { ...node.params, backend: BACKEND };
  const times: number[] = [], totals: number[] = [];
  let out = '', error = '';
  for (let run = 0; run <= RUNS; run++) {
    engine.cache.clear();
    if (direct) {
      const t = performance.now();
      try {
        const kept = direct(BACKEND), ms = performance.now() - t;
        out = `${k(kept.length)} kept`;
        if (run > 0) { times.push(ms); totals.push(ms); }
      } catch (e) { error = String(e); break; }
      continue;
    }
    if (!graph) throw new Error(`${c.name}: missing graph or direct runner`);
    const r = await engine.cook(graph, { target: 'target' });
    if (!r.ok || !r.geo) { error = r.errors.map((e) => `[${e.node}] ${e.message}`).join('; '); break; }
    out = `${k(r.geo.numPoints)} pts, ${k(r.geo.numPrims)} prims`;
    if (run === 0) continue; // warm-up
    times.push(r.results.get('target')!.ms);
    totals.push(r.ms);
  }
  engine.cache.clear();
  if (error) {
    failed++;
    console.log(`FAIL ${c.name}: ${error}`);
    continue;
  }
  const ms = Math.min(...times);
  const elements = c.elements(QUICK);
  const res: Result = {
    name: c.name, what: c.what(QUICK), elements, unit: c.unit, ms: +ms.toFixed(1), median_ms: +median(times).toFixed(1), runs: times.map((t) => +t.toFixed(1)),
    total_ms: +Math.min(...totals).toFixed(1), elements_per_sec: Math.round(elements / (ms / 1000)),
    target_ms: c.target, target_source: c.targetSource, target_applicable: fullSize(c), meets_target: fullSize(c) ? ms <= c.target : null,
    scatter_count: c.scatterFullCount ? scatterCount(QUICK, c.scatterFullCount) : null, out,
  };
  results.push(res);
  console.log(`  ${c.name.padEnd(22)} ${res.ms.toFixed(0).padStart(7)} ms  (graph ${res.total_ms.toFixed(0)} ms)  ${out}`);
}

const fmtRate = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)} M` : `${(n / 1e3).toFixed(1)} k`);
const lines = [
  '',
  `| case | what | elements | ms (best of ${RUNS}) | elements/s | target ms | ${baseline ? 'baseline ms | ' : ''}status |`,
  `|---|---|---|---|---|---|${baseline ? '---|' : ''}---|`,
];
for (const r of results) {
  const b = baselineMs(r.name, r.elements);
  lines.push(`| ${r.name} | ${r.what} | ${k(r.elements)} ${r.unit} | ${r.ms.toFixed(0)} | ${fmtRate(r.elements_per_sec)} | ${r.target_ms}${!r.target_applicable ? ' (original full size)' : ''} | ${baseline ? `${b === undefined ? '–' : b.toFixed(0)} | ` : ''}${!r.target_applicable ? '–' : r.meets_target ? 'ok' : 'slower'} |`);
}
console.log(lines.join('\n'));
if (results.some((r) => !r.target_applicable)) console.log('\n(targets apply only to the original full-size cases)');

const report = {
  generated: new Date().toISOString(),
  node: process.version, platform: `${process.platform}-${process.arch}`, cpu: os.cpus()[0]?.model ?? '', cpus: os.cpus().length,
  quick: QUICK, runs: RUNS, scatter_count: SCATTER_COUNT ?? null, backend: BACKEND ?? 'default', wasm: getLoadedKernels() ? kernelsWasmVariant : null,
  workers: WORKERS, results,
  peak_rss_bytes: process.resourceUsage().maxRSS * 1024,
};
const outputPath = OUTPUT ? path.resolve(OUTPUT) : path.join(benchDir, 'last.json');
writeReport(outputPath, report);
if (args.includes('--write-baseline')) {
  if (FILTER || SCATTER_COUNT !== undefined) console.log('not writing baseline: run without --filter or --scatter-count');
  else { fs.writeFileSync(baselinePath, JSON.stringify(report, null, 2) + '\n'); console.log('wrote bench/baseline.json'); }
}
console.log(`\nwrote ${OUTPUT ?? 'bench/last.json'}${failed ? ` · ${failed} case(s) failed to cook` : ''}`);
await host.pool?.close();
process.exit(failed ? 1 : 0);
