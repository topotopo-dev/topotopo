// solidify (shell): constant-thickness walls from a polygon surface. Algorithm and rejection rules: core/solidify.ts.
import { SolidifyError, solidify } from '../core/solidify.ts';
import { defineNode } from '../graph/registry.ts';
import { NodeError } from '../graph/types.ts';

defineNode({
  type: 'solidify',
  category: 'topology',
  summary: 'Give a consistently wound polygon surface a constant wall thickness (inside, centred or outside), with rim faces; invalid results are errors, never repaired.',
  description:
    'Blender: Solidify (complex mode); Houdini: PolyExtrude with output back + side, or Thicken. Select the intended ' +
    'surface upstream. Every point moves along the mitre of its faces\' offset planes, so each face of both surface copies ' +
    'is exactly its share of thickness away from the original: folds keep their full wall (mitred corners), open ' +
    'boundaries get rim faces. offset -1 grows the wall behind the surface (against the face normal; the input stays the ' +
    'outer face), 0 centres it, +1 grows it outward (the input becomes the inner face). Groups outer, inner, rim; ' +
    'attributes follow their source elements; uv is copied to both surfaces and the rim gets metric uv (u along the ' +
    'boundary, v across the thickness); N and tangent are dropped (recompute downstream). Errors instead of a broken ' +
    'shell: polylines, non-manifold edges or points, inconsistent winding, collapsed faces, mitres longer than ' +
    'miter_limit × thickness, corners whose offset planes do not meet (saddles, twists), surface copies that turn inside ' +
    'out, and any self-intersection of the result (crossings, coplanar overlaps, contacts beyond shared edges). Use ' +
    'poly_extrude for per-face extrusion and sdf shells for organic thickening.',
  aliases: ['shell', 'thicken', 'solidify_surface', 'wall_thickness'],
  inputs: [{ name: 'geo', desc: 'a polygon surface with consistent winding (a sheet, a folded panel or a closed hull)' }],
  params: {
    thickness: { type: 'float', default: 0.01, min: 0, desc: 'wall thickness in metres (must be positive)', aliases: ['thick', 'width', 'depth'] },
    offset: { type: 'float', default: 0, min: -1, max: 1, desc: 'where the wall grows relative to the face winding: -1 inside (behind the normal), 0 centred, +1 outside', aliases: ['bias', 'side'] },
    fill_rim: { type: 'bool', default: true, desc: 'close open boundaries with rim faces (off: two separate surfaces)', aliases: ['rim', 'cap_rim', 'fill'] },
    miter_limit: { type: 'float', default: 4, min: 1, desc: 'largest allowed point offset as a multiple of the thickness at folds (4 ≈ folds up to 150°)', aliases: ['mitre_limit', 'miter'] },
  },
  outputs: 'the shell: prim groups outer, inner, rim',
  example: {
    nodes: {
      panel: { type: 'grid', params: { size: [0.4, 0.3], rows: 3, cols: 4 } },
      fold: { type: 'wrangle', in: ['panel'], params: { snippet: 'if (@P.x > 0.05) { @P.y = @P.x - 0.05; @P.x = 0.05; }' } },
      wall: { type: 'solidify', in: ['fold'], params: { thickness: 0.01, offset: -1 } },
    },
    output: 'wall',
  },
  cook: (ctx) => {
    const { p } = ctx;
    try {
      const r = solidify(ctx.input(0), { thickness: p.thickness, offset: p.offset, fillRim: p.fill_rim, miterLimit: p.miter_limit });
      ctx.stat('rim_faces', r.stats.rim);
      ctx.stat('max_miter', +r.stats.maxMiter.toFixed(4));
      ctx.stat('max_residual', +r.stats.maxResidual.toExponential(2));
      return r.geo;
    } catch (e) {
      if (e instanceof SolidifyError) throw new NodeError(e.message, e.hint);
      throw e;
    }
  },
});
