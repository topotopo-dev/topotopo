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
