import { meshSurfaces } from '../core/surfacemesh.ts';
import { trimSurfaces } from '../core/surfacetrim.ts';
import { defineNode } from '../graph/registry.ts';
import { P, mask } from './util.ts';

defineNode({
  type: 'trim_surface',
  category: 'curve',
  aliases: ['surface_trim', 'nurbs_trim', 'trim_profile'],
  summary: 'Cut openings or keep patches on NURBS surfaces using closed outlines.',
  description: 'A trim is a boundary that tells a smooth surface which part to keep. Project closed side outlines along X, plan outlines along Y, and front outlines along Z. Use hits all to cut both flanks of a symmetric body. Use keep both to get the body and the matching patch for glass or a lid. The trim lives on the exact surface, which keeps its control points. Rendered and exported meshes follow the cut, and later polygon nodes see the openings. The cut edges are closed NURBS curves ready for sweep.',
  packed: 'keep',
  splines: 'keep',
  inputs: [
    { name: 'surfaces', desc: 'NURBS surfaces to cut. Other primitives pass through.' },
    { name: 'outlines', desc: 'Closed polyline, Bezier or NURBS outlines.' },
  ],
  params: {
    project: { type: 'enum', options: ['axis', 'closest'], default: 'axis', desc: 'Axis projects along a line in both directions by default. Closest finds the nearest point on the surface.' },
    direction: { type: 'vec3', default: [0, 0, 0], desc: 'Unitless axis direction. The default [0, 0, 0] uses the normal of the outline plane.' },
    hits: { type: 'enum', options: ['all', 'front', 'back'], default: 'all', desc: 'Axis projection keeps all crossings by default. Front keeps the positive side of the outline plane, and back keeps the negative side.' },
    keep: { type: 'enum', options: ['outside', 'inside', 'both'], default: 'outside', desc: 'Outside cuts out the outlined area by default. Inside keeps that area. Both outputs each part as its own surface.' },
    group: P.group('prim', 'Surface primitive group. Empty by default cuts every surface.'),
    outline_group: P.group('prim', 'Outline primitive group. Empty by default uses every outline.'),
    tolerance: { type: 'float', default: 0.0005, min: 1e-9, desc: 'Maximum projection and edge fitting error in metres. Defaults to 0.0005 m.' },
    edges: { type: 'bool', default: true, desc: 'Output closed NURBS curves along the cut boundaries by default.' },
  },
  outputs: 'Exact NURBS surfaces with trim boundaries in their UV domain. Both creates primitive groups trim_outside and trim_inside. The edges group contains the cut curves with primitive name and edge_surface.',
  example: {
    nodes: {
      ring: { type: 'circle', params: { plane: 'xy', segments: 16 } },
      body: { type: 'loft', in: ['ring'], params: { output: 'surface', sections: [
        { scale: 0.9 }, { offset: [0, 0, 1], scale: 1.1 },
        { offset: [0, 0, 2], scale: 1.05 }, { offset: [0, 0, 3], scale: 0.9 },
      ] } },
      window: { type: 'curve', params: { closed: true, points: [[0, 0.2, 0.6], [0, 0.6, 0.6], [0, 0.6, 1.4], [0, 0.2, 1.4]] } },
      cut: { type: 'trim_surface', in: ['body', 'window'], params: { direction: [1, 0, 0] } },
    },
    output: 'cut',
  },
  cook: ({ input, p, stat }) => {
    const surfaces = input(0), outlines = input(1);
    const r = trimSurfaces(surfaces, outlines, {
      project: p.project, direction: p.direction, hits: p.hits, keep: p.keep, tolerance: p.tolerance, edges: p.edges,
      surfaces: mask(surfaces, 'prim', p.group), outlines: mask(outlines, 'prim', p.outline_group),
    });
    stat('loops', r.loops);
    stat('surfaces_cut', r.surfaces);
    stat('edges', r.edges);
    return r.geo;
  },
});

defineNode({
  type: 'surface_to_mesh',
  category: 'curve',
  aliases: ['surface_mesh', 'nurbs_to_mesh', 'tessellate_surface'],
  summary: 'Make a game-ready quad mesh from an exact NURBS surface.',
  description: 'Follow the u and v directions with quads. Size sets the target edge length in metres and tolerance controls how closely the mesh follows the surface. Add bands for lips, seals, frames and recesses. For a window, use [{ "width": 0.01, "depth": -0.006, "group": "seal" }, { "width": 0.02, "group": "frame" }]. The plain conversion every node gets is still available for previews. UVs are in metres, so a texture tiles once per metre.',
  packed: 'keep',
  splines: 'keep',
  inputs: [{ name: 'surfaces', desc: 'Exact NURBS surfaces to mesh. Other primitives pass through.' }],
  params: {
    size: { type: 'float', default: 0.05, min: 1e-6, desc: 'Target edge length in metres. Defaults to 0.05 m.' },
    counts: { type: 'ivec2', default: [0, 0], min: 0, max: 1024, desc: 'Starting numbers of cells in u and v. Each 0 uses size in that direction by default.' },
    tolerance: { type: 'float', default: 0.001, min: 1e-9, desc: 'Chord error tolerance in metres. Defaults to 0.001 m.' },
    bands: { type: 'json', default: [], desc: 'Bands from the cut into the surface. Each needs a width in metres. Depth in metres defaults to 0, rows defaults to 1, and group defaults to band0, band1 and so on. The default [] joins the grid directly to the trim.' },
  },
  outputs: 'A polygon mesh with point N, vertex uv in metres, and a primitive band index. Grid and transition faces are in surface with band -1. Band faces go in their named groups. For bands and transitions, min_angle gives the smallest face angle in degrees and thin_faces counts faces with angles below 15 degrees. Both are 0 when there are no such faces.',
  example: {
    nodes: {
      ring: { type: 'circle', params: { plane: 'xy', segments: 16 } },
      body: { type: 'loft', in: ['ring'], params: { output: 'surface', sections: [
        { scale: 0.9 }, { offset: [0, 0, 1], scale: 1.1 },
        { offset: [0, 0, 2], scale: 1.05 }, { offset: [0, 0, 3], scale: 0.9 },
      ] } },
      window: { type: 'curve', params: { closed: true, points: [[0, 0.2, 0.6], [0, 0.6, 0.6], [0, 0.6, 1.4], [0, 0.2, 1.4]] } },
      cut: { type: 'trim_surface', in: ['body', 'window'], params: { direction: [1, 0, 0], edges: false } },
      mesh: { type: 'surface_to_mesh', in: ['cut'], params: { size: 0.12, tolerance: 0.003,
        bands: [{ width: 0.01, depth: -0.006, group: 'seal' }, { width: 0.02, group: 'frame' }] } },
    },
    output: 'mesh',
  },
  cook: ({ input, p, stat, warn }) => {
    const { geo, stats } = meshSurfaces(input(0), { size: p.size, counts: p.counts, tolerance: p.tolerance, bands: p.bands });
    const { poles, corners, transitions, ...reported } = stats;
    for (const [key, value] of Object.entries(reported)) stat(key, value);
    if (stats.quad_share < 0.95) {
      const locations = ['poles', 'corners', 'transitions'].filter((_, i) => [poles, corners, transitions][i] === Math.max(poles, corners, transitions));
      warn(`The mesh has ${stats.triangles} triangles, most at ${locations.join(' and ')}. Use a smaller size or adjust counts for more quads.`);
    }
    return geo;
  },
});
