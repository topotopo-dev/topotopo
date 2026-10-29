// Primitive shapes shared by the generator nodes and the previews (render/texview.ts material spheres).
import { GeoBuilder } from './geometry.ts';
import type { Geometry } from './geometry.ts';

/** Latitude/longitude sphere of radius r around the origin, with vertex uv (u around from +X, v up). */
export function uvSphere(r: number, rows: number, cols: number): Geometry {
  rows = Math.max(2, rows); cols = Math.max(3, cols);
  const b = new GeoBuilder();
  const uv = b.attrib('vertex', 'uv', 3);
  const top = b.addPoint(0, r, 0);
  const ring: number[][] = [];
  for (let i = 1; i < rows; i++) {
    const th = (Math.PI * i) / rows, row: number[] = [];
    for (let c = 0; c < cols; c++) {
      const ph = (2 * Math.PI * c) / cols;
      row.push(b.addPoint(r * Math.sin(th) * Math.cos(ph), r * Math.cos(th), -r * Math.sin(th) * Math.sin(ph)));
    }
    ring.push(row);
  }
  const bot = b.addPoint(0, -r, 0);
  const addUV = (us: number[][]) => { const v0 = b.numVertices - us.length; us.forEach((t, k) => uv.set(v0 + k, [t[0], t[1], 0])); };
  for (let c = 0; c < cols; c++) {
    const c1 = (c + 1) % cols, u0 = c / cols, u1 = (c + 1) / cols;
    b.addPrim([top, ring[0][c], ring[0][c1]]);
    addUV([[(u0 + u1) / 2, 1], [u0, 1 - 1 / rows], [u1, 1 - 1 / rows]]);
    for (let i = 0; i < rows - 2; i++) {
      b.addPrim([ring[i][c], ring[i + 1][c], ring[i + 1][c1], ring[i][c1]]);
      const va = 1 - (i + 1) / rows, vb = 1 - (i + 2) / rows;
      addUV([[u0, va], [u0, vb], [u1, vb], [u1, va]]);
    }
    b.addPrim([ring[rows - 2][c], bot, ring[rows - 2][c1]]);
    addUV([[u0, 1 / rows], [(u0 + u1) / 2, 0], [u1, 1 / rows]]);
  }
  return b.build();
}
