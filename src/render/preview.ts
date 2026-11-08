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
 * Quads per side the live viewer draws a heightfield with by default ("preview"): a 2 km field at 2 m (1001 samples)
 * every 2nd sample (4 m quads, 0.5M triangles, a 15 MB GLB written in about 2 s). Every sample of that field (1024:
 * 2M triangles, 60 MB) takes about 8 s to write, too slow for every change of a var, so it is a choice in the viewer's
 * "terrain detail" setting (heightfieldRes), as is every sample of any field. Baked previews keep 256.
 */
export const HEIGHTFIELD_PREVIEW_RES = 512;

/**
 * The viewer's terrain detail setting as quads per side: "preview" (or nothing) the default budget, a number of quads
 * per side, "full" every sample (Infinity).
 */
export function heightfieldRes(s: string | null | undefined): number {
  if (!s || s === 'preview') return HEIGHTFIELD_PREVIEW_RES;
  if (s === 'full') return Infinity;
  const n = Math.round(Number(s));
  return Number.isFinite(n) && n >= 16 ? n : HEIGHTFIELD_PREVIEW_RES;
}

/**
 * The GLB a viewer page shows: heightfields as meshes (with `heightfieldLayer` in red, default the mask; at most
 * `heightfieldRes` quads per side: 256 by default, the viewer passes its setting, Infinity every sample), images as textured quads,
 * a material output as spheres wearing its materials, lines as lines, no custom attributes. `compress: 'meshopt'` for
 * files kept on disk (the page's loader decodes it).
 */
export function previewGLB(g: Geometry, o: Pick<ExportOptions, 'compress'> & { heightfieldLayer?: string; heightfieldRes?: number } = {}): Promise<Uint8Array> {
  const { heightfieldLayer, heightfieldRes: res = 256, ...rest } = o;
  return exportGeometryAsync(withImagePreview(withMaterialPreview(withHeightfieldPreview(g, res, heightfieldLayer))), 'glb', { splitByName: false, lineMode: 'lines', custom: false, ...rest });
}
