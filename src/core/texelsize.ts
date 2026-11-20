// How big a texel is on the model: the metres one texel of a uv atlas covers, so a node that works in metres on the
// image (the height of tex_layers, a filter radius) can say the same thing at 1024 and at 2048.

/**
 * Per triangle, the metres one texel covers along u and along v (2 floats per triangle; 0, 0 where the uv has no area)
 * for an image of w × h texels: the lengths of the surface's derivatives along u and v divided by the texel counts.
 * `positions` has 3 floats per vertex and `uv` 2, indexed by the values of `tris`.
 */
export function triangleTexelSizes(positions: ArrayLike<number>, uv: ArrayLike<number>, tris: ArrayLike<number>, w: number, h: number): Float32Array {
  const nTri = Math.floor(tris.length / 3), out = new Float32Array(nTri * 2);
  for (let t = 0; t < nTri; t++) {
    const a = tris[t * 3], c1 = tris[t * 3 + 1], c2 = tris[t * 3 + 2];
    const du1 = uv[c1 * 2] - uv[a * 2], dv1 = uv[c1 * 2 + 1] - uv[a * 2 + 1], du2 = uv[c2 * 2] - uv[a * 2], dv2 = uv[c2 * 2 + 1] - uv[a * 2 + 1];
    const det = du1 * dv2 - du2 * dv1;
    if (!(Math.abs(det) > 1e-18)) continue;
    let lu = 0, lv = 0;
    for (let q = 0; q < 3; q++) {
      const e1 = positions[c1 * 3 + q] - positions[a * 3 + q], e2 = positions[c2 * 3 + q] - positions[a * 3 + q];
      const pu = (e1 * dv2 - e2 * dv1) / det, pv = (e2 * du1 - e1 * du2) / det;
      lu += pu * pu; lv += pv * pv;
    }
    out[t * 2] = Math.sqrt(lu) / w; out[t * 2 + 1] = Math.sqrt(lv) / h;
  }
  return out;
}

/**
 * Metres the width of a baked image covers: the median texel size over the image's texels (weighted by texels, so a model
 * with big hidden faces on coarse texels does not set the size of the pixels that show) times the width; 1 when no
 * triangle has both an area and a uv area.
 */
export function bakedImageSize(positions: ArrayLike<number>, uv: ArrayLike<number>, tris: ArrayLike<number>, w: number, h: number, skip?: Uint8Array | null): number {
  const t = medianTexelSize(positions, uv, tris, w, h, skip, 'texels');
  return t > 0 ? t * w : 1;
}

/**
 * The median over the triangles of sqrt(3D area / uv area in texels): the texel size along the surface in metres for an
 * image of w × h texels, weighted by 3D area (the default: a typical piece of the model) or by texels (`by: 'texels'`:
 * a typical texel of the image, which a model with a few big hidden faces on coarse texels does not skew).
 * `positions` has 3 floats per vertex and `uv` 2, indexed by the values of `tris`; `skip` leaves triangles out
 * (unbaked prims). 0 when no triangle has both an area and a uv area.
  */
export function medianTexelSize(positions: ArrayLike<number>, uv: ArrayLike<number>, tris: ArrayLike<number>, w: number, h: number, skip?: Uint8Array | null, by: 'area' | 'texels' = 'area'): number {
  const nt = Math.floor(tris.length / 3), items: { d: number; w: number }[] = [];
  for (let t = 0; t < nt; t++) {
    if (skip && skip[t]) continue;
    const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2];
    const ux = positions[b * 3] - positions[a * 3], uy = positions[b * 3 + 1] - positions[a * 3 + 1], uz = positions[b * 3 + 2] - positions[a * 3 + 2];
    const vx = positions[c * 3] - positions[a * 3], vy = positions[c * 3 + 1] - positions[a * 3 + 1], vz = positions[c * 3 + 2] - positions[a * 3 + 2];
    const area = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    const du1 = uv[b * 2] - uv[a * 2], dv1 = uv[b * 2 + 1] - uv[a * 2 + 1], du2 = uv[c * 2] - uv[a * 2], dv2 = uv[c * 2 + 1] - uv[a * 2 + 1];
    const texels = 0.5 * Math.abs(du1 * dv2 - du2 * dv1) * w * h;
    if (!(area > 0) || !(texels > 1e-9)) continue;
    items.push({ d: Math.sqrt(area / texels), w: by === 'texels' ? texels : area });
  }
  if (!items.length) return 0;
  items.sort((x, y) => x.d - y.d);
  let total = 0;
  for (const it of items) total += it.w;
  let run = 0;
  for (const it of items) { run += it.w; if (run >= total / 2) return it.d; }
  return items[items.length - 1].d;
}
