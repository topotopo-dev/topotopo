// Poly bevel: chamfer / round edges and points (Houdini PolyBevel). Kernels in core/bevel.ts.
import { defineNode } from '../graph/registry.ts';
import { bevelEdges, bevelPoints } from '../core/bevel.ts';
import { edgeMask, mask } from './util.ts';

defineNode({
  type: 'poly_bevel',
  category: 'topology',
  summary: 'Bevel edges (chamfer strips or round profiles with corner patches) or points; watertight on closed meshes (Houdini PolyBevel).',
  description:
    'Edge mode: every edge in "group" becomes a strip of divisions+1 quads; the faces on both sides shrink by "offset" ' +
    '(measured across each face, Houdini "Distance"). Where bevelled edges meet, a corner patch fills the hole: a polygon ' +
    'for a chamfer (triangle at a box corner), rings of quads for round bevels (a sphere octant at a box corner). A ' +
    'bevelled edge ending at an unbevelled point slides its offset along the neighbouring edges and ends flush; two ' +
    'bevelled edges meeting at a point with one other edge (a cylinder rim) are mitred. Boundary and non-manifold edges ' +
    'are skipped with a warning (chamfering open-mesh boundary edges is out of scope). clamp scales all offsets down just ' +
    'enough that no face edge collapses past another (huge offsets stay clean). Point mode truncates the selected points: ' +
    'every edge at the point is cut at "offset", the corner becomes a polygon, or a dome of "divisions" rings. Faces keep ' +
    'their attributes (uv is interpolated inside each face), strips take prim attributes from the larger neighbouring face, ' +
    'corner patches from the first face around the point; N is recomputed if present. Select edges with patterns: ' +
    '"angle>80" (sharp edges), "border:top" (rim of a prim group), "p0-1-2-3-0" (chains), edge groups from the group node; ' +
    'the output edge group bevel_edges (where the bevel meets the faces) lets a second bevel soften the first.',
  aliases: ['polybevel', 'bevel', 'chamfer'],
  inputs: [{ name: 'geo', desc: 'polygon mesh (closed meshes stay watertight)' }],
  params: {
    group: {
      type: 'group', default: '',
      desc: 'edges to bevel (edge pattern or group: "angle>80", "border:top", "p0-1", "rim"; "" = every edge shared by two polygons); with mode "points", a point pattern ("" = all points)',
      aliases: ['edges', 'edge_group', 'points'],
    },
    mode: { type: 'enum', options: ['edges', 'points'], default: 'edges', desc: 'bevel edges, or truncate points', aliases: ['bevel_type', 'class'] },
    offset: { type: 'float', default: 0.1, min: 0, desc: 'distance from the edge across each adjacent face (points mode: along each edge)', aliases: ['distance', 'width', 'radius', 'size', 'amount'] },
    offset_mode: { type: 'enum', options: ['distance', 'fraction'], default: 'distance', desc: 'distance = offset in scene units; fraction = offset x the shortest edge at the edge\'s points (stays proportional on small faces)', aliases: ['distance_mode', 'offsetmode'] },
    clamp: { type: 'bool', default: true, desc: 'scale all offsets down by one factor, just enough that no bevel crosses its neighbours (Houdini Clamp Offset); warns when it does', aliases: ['clamp_offset', 'clamp_overlap'] },
    divisions: { type: 'int', default: 0, min: 0, max: 64, desc: '0 = flat chamfer (one strip of quads per edge); n = round profile with n+1 strips', aliases: ['segments', 'divs', 'subdivisions'] },
    shape: { type: 'float', default: 0, min: -1, max: 1, desc: 'profile convexity for round bevels: 0 = circular arc, 1 = bulges out to a nearly square corner, -0.5 = straight, -1 = concave cove', aliases: ['profile_shape', 'convexity', 'profile'] },
  },
  outputs: 'prim groups bevel (strips and corner patches), bevel_corner (corner patches); edge group bevel_edges (edges where the bevel meets the original faces)',
  example: { type: 'poly_bevel', params: { group: 'angle>80', offset: 0.1, divisions: 3 } },
  cook: ({ input, p, warn }) => {
    const g = input(0);
    const opts = { offset: p.offset, offsetMode: p.offset_mode, clamp: p.clamp, divisions: p.divisions, shape: p.shape };
    const pattern = String(p.group ?? '').trim();
    const r = p.mode === 'points'
      ? bevelPoints(g, mask(g, 'point', pattern), opts)
      : bevelEdges(g, pattern === '' ? null : edgeMask(g, pattern), opts);
    for (const w of r.warnings) warn(w);
    return r.geo;
  },
});
