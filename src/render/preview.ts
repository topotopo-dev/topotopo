// Previews of a cooked result, shared by the built-in packages' thumbnails (scripts/gen-builtin.ts), the live viewer's GLB routes
// and the web app's baked thumb.png / preview.glb (src/web/bake.ts). Host-agnostic: PNG compression is passed in.
import type { Geometry } from '../core/geometry.ts';
import type { GraphSpec } from '../graph/types.ts';
import type { ExportOptions } from '../io/common.ts';
import { exportGeometryAsync } from '../io/export.ts';
import { withHeightfieldPreview } from '../core/heightfield.ts';
import { withImagePreview, withMaterialPreview } from './texview.ts';
import { renderGeometry } from './raster.ts';
import { renderArgs } from './options.ts';
import { encodePNG } from './png.ts';

/** Render options of a thumbnail: one persp view, `size` px (256), matcap, no view label, plus the graph's meta.thumbnail_render. */
export function thumbOptions(g: GraphSpec, size = 256) {
  const extra = g.meta?.thumbnail_render ?? {};
  return { ...renderArgs({ views: 'persp', size, shading: 'matcap', wireframe: false, annotate: false, view_labels: false, ...extra }) };
}

/** A thumbnail PNG: the square view tile only, without the footer. */
export function thumbnailPNG(geo: Geometry, g: GraphSpec, deflate: (d: Uint8Array) => Uint8Array, size = 256): Uint8Array {
  const r = renderGeometry(geo, thumbOptions(g, size));
  const w = r.width; // a single square view tile sits above the footer
  return encodePNG(r.rgba.subarray(0, w * w * 4), w, w, deflate);
}

/**
 * The GLB a viewer page shows: heightfields as meshes (with `heightfieldLayer` in red, default the mask), images as
 * textured quads, a material output as spheres wearing its materials, lines as lines, no custom attributes. `compress: 'meshopt'` for files kept on disk (the page's
 * loader decodes it).
 */
export function previewGLB(g: Geometry, o: Pick<ExportOptions, 'compress'> & { heightfieldLayer?: string } = {}): Promise<Uint8Array> {
  const { heightfieldLayer, ...rest } = o;
  return exportGeometryAsync(withImagePreview(withMaterialPreview(withHeightfieldPreview(g, 256, heightfieldLayer))), 'glb', { splitByName: false, lineMode: 'lines', custom: false, ...rest });
}
