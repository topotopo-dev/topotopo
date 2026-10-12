// Overlay primitives for the renderer, drawn at output resolution after supersampling so lines
// stay 1 px crisp: depth-tested lines (hidden parts skipped or dimmed), dots, translucent boxes,
// labels with collision-avoiding placement and leader lines, legends, and screen-space AO.
// Buffers are RGB float (3 per pixel), row-major. Depth buffers hold larger = nearer.
import { drawText, textWidth } from './font.ts';

export type RGB = number[];

/** Depth tolerance: absolute part plus a part relative to |z| (perspective z is 1/distance). */
export interface DepthTol { abs: number; rel: number }

/**
 * 1 px (× width) line from (x0, y0, z0) to (x1, y1, z1). With a depth buffer `zt`, samples behind
 * the surface are skipped (hiddenAlpha 0) or drawn with hiddenAlpha.
 */
export function lineOv(
  buf: Float32Array, W: number, H: number,
  x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
  c: RGB, alpha: number, width: number, zt: Float32Array | null, tol: DepthTol, hiddenAlpha = 0,
) {
  const dx = x1 - x0, dy = y1 - y0;
  const steps = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)));
  if (!Number.isFinite(steps) || steps > 1e5) return;
  // trivially off-screen
  if ((x0 < -width && x1 < -width) || (y0 < -width && y1 < -width) || (x0 > W + width && x1 > W + width) || (y0 > H + width && y1 > H + width)) return;
  const hw = Math.max(0.5, width / 2);
  const c0 = c[0], c1 = c[1], c2 = c[2];
  for (let s = 0; s <= steps; s++) {
    const t = steps ? s / steps : 0;
    const x = x0 + dx * t, y = y0 + dy * t, z = z0 + (z1 - z0) * t;
    const xa = Math.floor(x - hw + 0.5), xb = Math.floor(x + hw - 0.5), ya = Math.floor(y - hw + 0.5), yb = Math.floor(y + hw - 0.5);
    for (let py = ya; py <= yb; py++) {
      if (py < 0 || py >= H) continue;
      for (let px = xa; px <= xb; px++) {
        if (px < 0 || px >= W) continue;
        const zi = py * W + px;
        let a = alpha;
        if (zt && z < zt[zi] - (tol.abs + Math.abs(z) * tol.rel)) { if (hiddenAlpha <= 0) continue; a = hiddenAlpha; }
        const i = zi * 3;
        buf[i] += (c0 - buf[i]) * a; buf[i + 1] += (c1 - buf[i + 1]) * a; buf[i + 2] += (c2 - buf[i + 2]) * a;
      }
    }
  }
}

/** Filled axis-aligned rectangle [x0, x1) × [y0, y1) blended with alpha. */
export function fillRect(buf: Float32Array, W: number, H: number, x0: number, y0: number, x1: number, y1: number, c: RGB, alpha: number) {
  const xa = Math.max(0, Math.round(x0)), xb = Math.min(W, Math.round(x1)), ya = Math.max(0, Math.round(y0)), yb = Math.min(H, Math.round(y1));
  for (let y = ya; y < yb; y++)
    for (let x = xa; x < xb; x++) {
      const i = (y * W + x) * 3;
      buf[i] += (c[0] - buf[i]) * alpha; buf[i + 1] += (c[1] - buf[i + 1]) * alpha; buf[i + 2] += (c[2] - buf[i + 2]) * alpha;
    }
}

/** Square dot of side `size` centred at (x, y) with a dark rim. */
export function dotOv(buf: Float32Array, W: number, H: number, x: number, y: number, size: number, c: RGB, rim = true) {
  const h = size / 2;
  if (rim) fillRect(buf, W, H, x - h - 1, y - h - 1, x + h + 1, y + h + 1, [0.04, 0.04, 0.05], 0.85);
  fillRect(buf, W, H, x - h, y - h, x + h, y + h, c, 1);
}

/** Greedy label placement: candidate spots around the anchor, first one free of overlaps wins. */
export class LabelPlacer {
  private rects: number[] = [];
  placed = 0;
  skipped = 0;
  readonly W: number;
  readonly H: number;
  constructor(W: number, H: number) { this.W = W; this.H = H; }
  reserve(x0: number, y0: number, x1: number, y1: number) { this.rects.push(x0, y0, x1, y1); }
  free(x0: number, y0: number, x1: number, y1: number): boolean {
    if (x0 < 1 || y0 < 1 || x1 > this.W - 1 || y1 > this.H - 1) return false;
    const r = this.rects;
    for (let i = 0; i < r.length; i += 4) if (x0 < r[i + 2] && x1 > r[i] && y0 < r[i + 3] && y1 > r[i + 1]) return false;
    return true;
  }
  /** Top-left of a free w × h box near (ax, ay) and whether it sits far enough to need a leader line; null if none. */
  find(ax: number, ay: number, w: number, h: number, gap: number): { x: number; y: number; far: boolean } | null {
    const near: [number, number][] = [
      [gap, -h - gap], [gap, gap], [-w - gap, -h - gap], [-w - gap, gap], [-w / 2, -h - gap * 2], [-w / 2, gap * 2], [gap * 2, -h / 2], [-w - gap * 2, -h / 2],
    ];
    for (const [dx, dy] of near) {
      const x = Math.round(ax + dx), y = Math.round(ay + dy);
      if (this.free(x, y, x + w, y + h)) return { x, y, far: false };
    }
    for (const r of [1.6, 2.6, 3.8, 5.2]) {
      const dist = (h + gap) * r + w * 0.25 * (r - 1);
      for (let k = 0; k < 12; k++) {
        const ang = (k / 12) * Math.PI * 2 - Math.PI / 2;
        const cx = ax + Math.cos(ang) * (dist + w / 2), cy = ay + Math.sin(ang) * dist;
        const x = Math.round(cx - w / 2), y = Math.round(cy - h / 2);
        if (this.free(x, y, x + w, y + h)) return { x, y, far: true };
      }
    }
    return null;
  }
}

/**
 * Text label for anchor (ax, ay): translucent dark box, coloured text, an anchor dot, and a leader
 * line when the label had to move away. Returns false (and counts it) when no free spot exists.
 */
export function drawLabel(buf: Float32Array, W: number, H: number, pl: LabelPlacer, ax: number, ay: number, text: string, color: RGB, fs: number, dot = true): boolean {
  const pad = Math.max(1, Math.round(fs));
  const w = textWidth(text, fs) - fs + pad * 2 + fs, h = 7 * fs + pad * 2 + fs;
  const spot = pl.find(ax, ay, w, h, 3 * Math.max(1, fs));
  if (!spot) { pl.skipped++; return false; }
  pl.reserve(spot.x, spot.y, spot.x + w, spot.y + h);
  pl.placed++;
  if (spot.far) {
    const lx = Math.max(spot.x, Math.min(spot.x + w, ax)), ly = Math.max(spot.y, Math.min(spot.y + h, ay));
    lineOv(buf, W, H, ax, ay, 0, lx, ly, 0, color, 0.75, Math.max(1, fs / 2), null, { abs: 0, rel: 0 });
  }
  fillRect(buf, W, H, spot.x, spot.y, spot.x + w, spot.y + h, [0.05, 0.05, 0.07], 0.62);
  drawText(buf, W, H, spot.x + pad, spot.y + pad, text, color, fs, true);
  if (dot) dotOv(buf, W, H, ax, ay, Math.max(2, fs + 1), color);
  return true;
}

export interface LegendItem {
  /** swatch colour (omit for a heading line) */
  color?: RGB;
  text: string;
  /** a gradient bar with end labels instead of a swatch */
  gradient?: { map: (t: number) => RGB; lo: string; hi: string };
}

/**
 * Legend box in the top-right corner of the tile (at `top`, or below the view label when the box would reach into
 * it: `avoid` = [right, bottom] of that label); reserves its rectangle in the placer.
 */
export function drawLegend(buf: Float32Array, W: number, H: number, items: LegendItem[], fs: number, pl: LabelPlacer | null, top = 6, avoid: [number, number] = [0, 0]) {
  if (!items.length) return;
  const lineH = 9 * fs, pad = 3 * fs, sw = 7 * fs;
  let w = 0, h = pad * 2;
  for (const it of items) {
    w = Math.max(w, textWidth(it.text, fs) + (it.color ? sw + 2 * fs : 0), it.gradient ? 64 * fs : 0);
    h += it.gradient ? lineH * 2 + 4 * fs : lineH;
  }
  w += pad * 2;
  const x0 = Math.max(0, W - w - 6), y0 = x0 < avoid[0] ? avoid[1] + 2 : top;
  fillRect(buf, W, H, x0, y0, x0 + w, y0 + h, [0.05, 0.05, 0.07], 0.72);
  if (pl) pl.reserve(x0 - 2, y0 - 2, x0 + w + 2, y0 + h + 2);
  let y = y0 + pad;
  for (const it of items) {
    let x = x0 + pad;
    if (it.color) {
      fillRect(buf, W, H, x, y, x + sw, y + sw, it.color, 1);
      x += sw + 2 * fs;
    }
    drawText(buf, W, H, x, y, it.text, it.color ? [0.92, 0.92, 0.92] : [1, 0.85, 0.4], fs, false);
    y += lineH;
    if (it.gradient) {
      const bw = w - pad * 2, bh = 6 * fs;
      for (let i = 0; i < bw; i++) fillRect(buf, W, H, x0 + pad + i, y, x0 + pad + i + 1, y + bh, it.gradient.map(i / Math.max(1, bw - 1)), 1);
      y += bh + 2 * fs;
      drawText(buf, W, H, x0 + pad, y, it.gradient.lo, [0.85, 0.85, 0.85], fs, false);
      drawText(buf, W, H, x0 + pad + bw - textWidth(it.gradient.hi, fs) + fs, y, it.gradient.hi, [0.85, 0.85, 0.85], fs, false);
      y += lineH - 2 * fs + 4 * fs;
    }
  }
}

/**
 * Screen-space ambient occlusion on a w × h output-resolution grid from linear view depth `lin`
 * (distance along the view axis, Infinity = background). Each sample pair (+o, -o) measures how far the
 * surface around the pixel rises towards the camera on both sides (concavity), so creases and cavities
 * darken while flat or convex areas stay lit. `px2world(z)` converts a pixel distance at depth z to
 * world units. Returns a lighting factor per pixel (1 = unoccluded).
 */
export function ambientOcclusion(lin: Float32Array, w: number, h: number, radius: number, px2world: (z: number) => number, strength = 1.1): Float32Array {
  const occ = new Float32Array(w * h);
  const dirs = [[1, 0], [0.7071, 0.7071], [0, 1], [-0.7071, 0.7071]];
  const radii = [radius, radius * 0.55, radius * 0.25];
  // 4×4 interleaved rotation pattern, removed by the blur below
  const rot = [0, 0.5, 0.125, 0.625, 0.75, 0.25, 0.875, 0.375, 0.1875, 0.6875, 0.0625, 0.5625, 0.9375, 0.4375, 0.8125, 0.3125];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x, z = lin[i];
      if (!Number.isFinite(z)) continue;
      const a0 = rot[(y & 3) * 4 + (x & 3)] * (Math.PI / 4);
      const ca = Math.cos(a0), sa = Math.sin(a0);
      let sum = 0, cnt = 0;
      for (const r of radii) {
        const lw = Math.max(1e-9, px2world(z) * r), range = lw * 3;
        for (const [dx0, dy0] of dirs) {
          const dx = (dx0 * ca - dy0 * sa) * r, dy = (dx0 * sa + dy0 * ca) * r;
          const xa = Math.round(x + dx), ya = Math.round(y + dy), xb = Math.round(x - dx), yb = Math.round(y - dy);
          if (xa < 0 || ya < 0 || xa >= w || ya >= h || xb < 0 || yb < 0 || xb >= w || yb >= h) continue;
          // a pair with a sample on the background or across a depth jump says nothing about the local
          // surface (keeping only the other half would read a plane's slope as occlusion at silhouettes)
          const d1 = z - lin[ya * w + xa], d2 = z - lin[yb * w + xb];
          if (!(Math.abs(d1) < range && Math.abs(d2) < range)) continue;
          const rise = (d1 + d2) * 0.5 / lw;
          if (rise > 0) sum += Math.min(1, rise * 1.6);
          cnt++;
        }
      }
      if (cnt) occ[i] = sum / cnt;
    }
  // 3×3 blur over valid pixels
  const out = new Float32Array(w * h).fill(1);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!Number.isFinite(lin[i])) continue;
      let s = 0, n = 0;
      for (let j = -1; j <= 1; j++)
        for (let k = -1; k <= 1; k++) {
          const xx = x + k, yy = y + j;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const q = yy * w + xx;
          if (!Number.isFinite(lin[q])) continue;
          s += occ[q]; n++;
        }
      out[i] = Math.max(0.2, 1 - strength * (n ? s / n : 0));
    }
  return out;
}
