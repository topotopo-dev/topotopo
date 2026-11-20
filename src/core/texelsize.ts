// How big a texel is on the model: the metres one texel of a uv atlas covers, so a node that works in metres on the
// image (the height of tex_layers, a filter radius) can say the same thing at 1024 and at 2048.

/**
 * The area-weighted median over the triangles of sqrt(3D area / uv area in texels): the texel size along the surface in
 * metres for an image of w × h texels. `positions` has 3 floats per vertex and `uv` 2, indexed by the values of `tris`;
 * `skip` leaves triangles out (unbaked prims). 0 when no triangle has both an area and a uv area.
 */
export function medianTexelSize(positions: ArrayLike<number>, uv: ArrayLike<number>, tris: ArrayLike<number>, w: number, h: number, skip?: Uint8Array | null): number {
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
    items.push({ d: Math.sqrt(area / texels), w: area });
  }
  if (!items.length) return 0;
  items.sort((x, y) => x.d - y.d);
  let total = 0;
  for (const it of items) total += it.w;
  let run = 0;
  for (const it of items) { run += it.w; if (run >= total / 2) return it.d; }
  return items[items.length - 1].d;
}
