import { GeoBuilder } from './geometry.ts';
import { curveParams, evalPoint, fitSpline, fitSplineTolerance, makeSpline, nurbsToBezier, setSplinePrim, uniformBreakpoints } from './splines.ts';
import type { FitResult } from './splines.ts';
import { traceMask } from './traceimage.ts';
import type { PixelPoint } from './traceimage.ts';

export const BLUEPRINT_VIEWS = ['side', 'top', 'front', 'rear'] as const;
export const BLUEPRINT_MAX_RADIUS = 8192;
type ViewName = typeof BLUEPRINT_VIEWS[number];
type Box = [number, number, number, number];
type Solid = ['disc', number, number, number] | ['rect', ...Box];
type Direction = 'left' | 'right' | 'up' | 'down';
type Mirror = 'upper' | 'lower' | 'left' | 'right';
type Axis = 0 | 1;
type View = {
  name: ViewName; box: Box; ground?: number; centre?: number; front: Direction; mirror?: Mirror;
  erase: Box[]; seeds: PixelPoint[]; solid: Solid[]; close?: number; thin?: number;
};
type Options = {
  views: unknown; length: number; length_view: ViewName; metres_per_pixel: number;
  ink: number; close: number; thin: number; smoothing: number; tolerance: number;
};

const VIEW_KEYS = ['box', 'ground', 'centre', 'front', 'mirror', 'erase', 'seeds', 'solid', 'close', 'thin'];
const DIRECTIONS = ['left', 'right', 'up', 'down'] as const;
const HALVES = ['upper', 'lower', 'left', 'right'] as const;
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isTuple = (value: unknown, n: number): value is number[] =>
  Array.isArray(value) && value.length === n && Array.from(value).every(isNumber);
const isBox = (value: unknown): value is Box =>
  isTuple(value, 4) && value.every(Number.isInteger) && value[0] < value[2] && value[1] < value[3];

function parseViews(value: unknown, width: number, height: number): View[] {
  const valid = BLUEPRINT_VIEWS.join(', ');
  if (!isRecord(value)) throw new Error(`blueprint: set views to an object with boxes for ${valid}.`);
  for (const name of Object.keys(value)) {
    if (!(BLUEPRINT_VIEWS as readonly string[]).includes(name))
      throw new Error(`blueprint: unknown view "${name}". Use ${valid}.`);
  }
  if (Object.keys(value).length === 0) throw new Error(`blueprint: add a box in views for at least one of ${valid}.`);
  return BLUEPRINT_VIEWS.filter((name) => Object.hasOwn(value, name)).map((name) => {
    const v = value[name], label = `blueprint: ${name}`;
    if (!isRecord(v)) throw new Error(`${label} must be an object with a box.`);
    for (const key of Object.keys(v)) {
      if (!VIEW_KEYS.includes(key)) throw new Error(`${label} has unknown key "${key}". Use ${VIEW_KEYS.join(', ')}.`);
    }
    const { box, ground, centre, mirror, front = name === 'top' ? 'up' : 'left', erase = [], seeds = [], solid = [], close, thin } = v;
    if (!isBox(box) || box[0] < 0 || box[1] < 0 || box[2] > width || box[3] > height)
      throw new Error(`${label} needs a box [x0, y0, x1, y1] in whole pixels within the ${width} × ${height} sheet.`);
    if (ground !== undefined && !isNumber(ground))
      throw new Error(`${label} needs a finite ground coordinate in sheet pixels.`);
    if (centre !== undefined && !isNumber(centre))
      throw new Error(`${label} needs a finite centre coordinate in sheet pixels.`);
    if (!DIRECTIONS.includes(front as Direction))
      throw new Error(`${label} front must be one of ${DIRECTIONS.join(', ')}.`);
    if (mirror !== undefined && !HALVES.includes(mirror as Mirror))
      throw new Error(`${label} mirror must be one of ${HALVES.join(', ')}.`);
    const axis = mirror === 'left' || mirror === 'right' ? 0 : 1;
    if (mirror !== undefined && centre !== undefined &&
        (!Number.isInteger(2 * centre) || centre <= box[axis] || centre >= box[axis + 2]))
      throw new Error(`${label} mirror needs a centre inside its box on a whole or half pixel.`);
    if (!Array.isArray(erase) || !erase.every(isBox))
      throw new Error(`${label} erase must list rectangles [x0, y0, x1, y1] in whole sheet pixels.`);
    if (!Array.isArray(seeds) || !seeds.every((p) => isTuple(p, 2) &&
        p[0] >= box[0] && p[0] < box[2] && p[1] >= box[1] && p[1] < box[3]))
      throw new Error(`${label} seeds must list [x, y] positions in sheet pixels inside its box.`);
    if (!Array.isArray(solid) || !solid.every((s) => Array.isArray(s) &&
        ((s[0] === 'disc' && isTuple(s.slice(1), 3) && s[3] > 0) || (s[0] === 'rect' && isBox(s.slice(1))))))
      throw new Error(`${label} solid must list ["disc", cx, cy, radius] with a positive radius or ["rect", x0, y0, x1, y1] in sheet pixels.`);
    for (const [key, radius] of [['close', close], ['thin', thin]] as const) {
      if (radius !== undefined && (!isNumber(radius) || !Number.isInteger(radius) || radius < 0 || radius > BLUEPRINT_MAX_RADIUS))
        throw new Error(`${label} ${key} must be a radius from 0 to ${BLUEPRINT_MAX_RADIUS} in whole pixels.`);
    }
    return { name, box, ground, centre, front: front as Direction, mirror: mirror as Mirror | undefined, erase, seeds, solid,
      close: close as number | undefined, thin: thin as number | undefined };
  });
}

// Pixels are either paper, ink, border paper or paper reached from a seed.
const PAPER = 0, INK = 1, BORDER = 2, SEED = 3;

function reflect(data: Uint8Array, w: number, h: number, axis: Axis, line: number, keepLow: boolean) {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = axis ? y : x;
    if (keepLow ? p + 0.5 <= line : p + 0.5 >= line) continue;
    const q = 2 * line - 1 - p;
    data[y * w + x] = q >= 0 && q < (axis ? h : w) ? data[axis ? q * w + x : y * w + q] : PAPER;
  }
}

function flood(queue: Int32Array, w: number, size: number, visit: (k: number) => void, end: () => number) {
  for (let head = 0; head < end(); head++) {
    const k = queue[head], x = k % w;
    if (x > 0) visit(k - 1);
    if (x < w - 1) visit(k + 1);
    if (k >= w) visit(k - w);
    if (k + w < size) visit(k + w);
  }
}

// Binary square max and min filters use running counts of the selected value along each axis.
function filterLines(src: Uint8Array, out: Uint8Array, length: number, lines: number, step: number, stride: number, radius: number, value: number) {
  for (let line = 0; line < lines; line++) {
    const start = line * stride;
    let count = 0;
    for (let i = 0; i <= Math.min(radius, length - 1); i++) count += +(src[start + i * step] === value);
    for (let i = 0; i < length; i++) {
      out[start + i * step] = count ? value : 1 - value;
      if (i >= radius) count -= +(src[start + (i - radius) * step] === value);
      if (i + radius + 1 < length) count += +(src[start + (i + radius + 1) * step] === value);
    }
  }
}

function morph(pixels: Uint8Array, w: number, h: number, radius: number, first: number) {
  if (!radius) return;
  const temp = new Uint8Array(pixels.length);
  for (const value of [first, 1 - first]) {
    filterLines(pixels, temp, w, h, 1, w, radius, value);
    filterLines(temp, pixels, h, w, w, 1, radius, value);
  }
}

function silhouette(data: Float32Array, width: number, view: View, o: Options) {
  const box: Box = [...view.box];
  const axis: Axis = view.mirror === 'left' || view.mirror === 'right' ? 0 : 1;
  const centre = view.centre ?? (box[axis] + box[axis + 2]) / 2;
  const keepLow = view.mirror === 'upper' || view.mirror === 'left';
  // Make room for the reflection when the centre is off the box midpoint.
  if (view.mirror) {
    if (keepLow) box[axis + 2] = 2 * centre - box[axis];
    else box[axis] = 2 * centre - box[axis + 2];
  }
  const [x0, y0, x1, y1] = box, w = x1 - x0, h = y1 - y0;
  const line = centre - box[axis];
  const pixels = new Uint8Array(w * h), queue = new Int32Array(pixels.length);
  for (let y = Math.max(view.box[1], y0); y < Math.min(view.box[3], y1); y++)
    for (let x = Math.max(view.box[0], x0); x < Math.min(view.box[2], x1); x++)
      pixels[(y - y0) * w + x - x0] = data[y * width + x] < o.ink ? INK : PAPER;
  for (const [a, b, c, d] of view.erase) {
    for (let y = Math.max(y0, b); y < Math.min(y1, d); y++) {
      const start = Math.max(x0, a), stop = Math.min(x1, c);
      if (start < stop) pixels.fill(PAPER, (y - y0) * w + start - x0, (y - y0) * w + stop - x0);
    }
  }
  if (view.mirror) reflect(pixels, w, h, axis, line, keepLow);
  morph(pixels, w, h, view.close ?? o.close, INK);

  let tail = 0, mark = BORDER;
  const visit = (k: number) => {
    if (pixels[k] === PAPER) { pixels[k] = mark; queue[tail++] = k; }
  };
  for (let y = 0; y < h; y++) { visit(y * w); visit(y * w + w - 1); }
  for (let x = 0; x < w; x++) { visit(x); visit((h - 1) * w + x); }
  flood(queue, w, pixels.length, visit, () => tail);
  tail = 0; mark = SEED;
  for (const [sx, sy] of view.seeds) {
    const x = Math.floor(sx) - x0, y = Math.floor(sy) - y0;
    if (view.mirror) {
      const p = axis ? y : x;
      if (keepLow ? p + 0.5 > line : p + 0.5 < line) continue;
      const q = 2 * line - 1 - p;
      if (q >= 0 && q < (axis ? h : w)) visit(axis ? q * w + x : y * w + q);
    }
    visit(y * w + x);
  }
  flood(queue, w, pixels.length, visit, () => tail);

  const mask = Uint8Array.from(pixels, (p) => +(p < BORDER));
  if (tail) {
    // Remove thin ink dividers between two kinds of outside paper. Keep the object stroke
    // where it borders enclosed paper, including where an annotation meets the object.
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const k = y * w + x;
      if (pixels[k] !== INK) continue;
      let nearby = 0;
      for (let j = Math.max(0, y - 2); j <= Math.min(h - 1, y + 2); j++)
        for (let i = Math.max(0, x - 2); i <= Math.min(w - 1, x + 2); i++) nearby |= 1 << pixels[j * w + i];
      if (nearby === ((1 << INK) | (1 << BORDER) | (1 << SEED))) mask[k] = 0;
    }
  }
  morph(mask, w, h, view.thin ?? o.thin, PAPER);
  for (const s of view.solid) {
    const [kind, a, b, c] = s;
    const bounds = kind === 'disc' ? [Math.floor(a - c), Math.floor(b - c), Math.ceil(a + c), Math.ceil(b + c)] : [a, b, c, s[4]];
    for (let y = Math.max(y0, bounds[1]); y < Math.min(y1, bounds[3]); y++)
      for (let x = Math.max(x0, bounds[0]); x < Math.min(x1, bounds[2]); x++)
        if (kind === 'rect' || (x + 0.5 - a) ** 2 + (y + 0.5 - b) ** 2 <= c ** 2) mask[(y - y0) * w + x - x0] = 1;
  }
  if (view.mirror) reflect(mask, w, h, axis, line, keepLow);

  let largest = new Int32Array(0);
  const areas: number[] = [];
  const take = (k: number) => {
    if (mask[k] === 1) { mask[k] = 2; queue[tail++] = k; }
  };
  for (let k = 0; k < mask.length; k++) {
    if (mask[k] !== 1) continue;
    tail = 0;
    take(k);
    flood(queue, w, mask.length, take, () => tail);
    areas.push(tail);
    if (tail > largest.length) largest = queue.slice(0, tail);
  }
  const hint = 'check its box, ink or seeds.';
  if (!areas.length) throw new Error(`blueprint: ${view.name} silhouette is empty. Please ${hint}`);
  const bounds: Box = [w, h, 0, 0];
  for (const k of largest) {
    const x = k % w, y = Math.floor(k / w);
    bounds[0] = Math.min(bounds[0], x); bounds[1] = Math.min(bounds[1], y);
    bounds[2] = Math.max(bounds[2], x + 1); bounds[3] = Math.max(bounds[3], y + 1);
  }
  if (bounds[0] === 0 && bounds[1] === 0 && bounds[2] === w && bounds[3] === h)
    throw new Error(`blueprint: ${view.name} silhouette touches all four sides. Please ${hint}`);
  const [a, b, c, d] = bounds, mw = c - a, mh = d - b;
  const cropped = new Float32Array(mw * mh);
  for (const k of largest) cropped[(Math.floor(k / w) - b) * mw + k % w - a] = 1;
  const outer = traceMask(cropped, mw, mh, 0.5, 0, 0).find((contour) => !contour.hole)!;
  const droppedLarge = areas.reduce((count, area) => count + +(area * 100 > largest.length), -1);
  return { outline: outer.points, bounds: [a + x0, b + y0, c + x0, d + y0] as Box, dropped: areas.length - 1, droppedLarge };
}

// Find exact extrema of the unweighted cubic in each pixel axis before placing it.
function splineBox(fit: FitResult): Box {
  const spline = makeSpline('nurbs', fit.P, { order: fit.order, knots: fit.knots, closed: true });
  const { cvs } = nurbsToBezier(spline);
  const bounds: Box = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < cvs.length; i += 3) for (const axis of [0, 1] as const) {
    const [a, b, c, d] = [0, 1, 2, 3].map((j) => cvs[(i + j) % cvs.length].P[axis]);
    const u = b - a, v = c - b, w = d - c;
    const A = u - 2 * v + w, B = 2 * (v - u), D = B * B - 4 * A * u;
    const q = -0.5 * (B + (B < 0 ? -1 : 1) * Math.sqrt(D));
    const roots = A === 0 ? [-u / B] : D >= 0 ? [q / A, u / q] : [];
    const values = [a, d];
    for (const t of roots) {
      if (t > 0 && t < 1) {
        const s = 1 - t;
        values.push(s ** 3 * a + 3 * s * s * t * b + 3 * s * t * t * c + t ** 3 * d);
      }
    }
    bounds[axis] = Math.min(bounds[axis], ...values);
    bounds[axis + 2] = Math.max(bounds[axis + 2], ...values);
  }
  return bounds;
}

function fitSamples(outline: PixelPoint[], tolerance: number) {
  if (tolerance === 0) {
    const points: number[] = [];
    for (let i = 0; i < outline.length; i++) {
      const [x, y] = outline[i], [ex, ey] = outline[(i + 1) % outline.length];
      const steps = Math.ceil(Math.hypot(ex - x, ey - y) / 4);
      for (let k = 0; k < steps; k++) points.push(x + (ex - x) * k / steps, y + (ey - y) * k / steps, 0);
    }
    return points;
  }
  // Even spacing and a short averaging pass soften the stair steps of a pixel boundary.
  const distances = [0];
  for (let i = 0; i < outline.length; i++) {
    const [x, y] = outline[i], [ex, ey] = outline[(i + 1) % outline.length];
    distances.push(distances[i] + Math.hypot(ex - x, ey - y));
  }
  const perimeter = distances[outline.length], n = Math.max(4, Math.ceil(perimeter / 1.5));
  const samples: PixelPoint[] = [];
  for (let i = 0, j = 0; i < n; i++) {
    const d = i * perimeter / n;
    while (distances[j + 1] <= d) j++;
    const t = (d - distances[j]) / (distances[j + 1] - distances[j]);
    const [x, y] = outline[j], [ex, ey] = outline[(j + 1) % outline.length];
    samples.push([x + (ex - x) * t, y + (ey - y) * t]);
  }
  const blend = 0.18 * Math.min(1, tolerance);
  return samples.flatMap(([x, y], i) => {
    const [ax, ay] = samples[(i + n - 1) % n], [bx, by] = samples[(i + 1) % n];
    return [x + blend * (ax + bx - 2 * x), y + blend * (ay + by - 2 * y), 0];
  });
}

function fitContour(points: number[], o: Options): FitResult {
  const options = { closed: true, order: 4, mode: 'chord' as const, smoothing: o.smoothing, tolerance: o.tolerance };
  const n = points.length / 3;
  if (n > 16 && o.tolerance > 0) {
    const params = curveParams(points, true, 'chord').subarray(0, n);
    let knots = Array.from(uniformBreakpoints(16));
    // Put extra knots only in spans that miss the target instead of increasing density around the whole curve.
    for (let pass = 0; pass < 16; pass++) {
      const cvs = knots.length - 1;
      const fit = fitSpline(points, { ...options, cvs, knots, params });
      if (fit.error <= o.tolerance) return fit;
      const curve = makeSpline('nurbs', fit.P, { order: fit.order, closed: true, knots: fit.knots });
      const split = new Uint8Array(cvs), p = [0, 0, 0];
      for (let i = 0; i < n; i++) {
        const u = fit.params[i];
        evalPoint(curve, u, p);
        if ((p[0] - points[i * 3]) ** 2 + (p[1] - points[i * 3 + 1]) ** 2 <= o.tolerance ** 2) continue;
        let lo = 0, hi = cvs;
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1;
          if (knots[mid] <= u) lo = mid;
          else hi = mid;
        }
        if (knots[lo + 1] - knots[lo] > 1 / n) split[lo] = 1;
      }
      const refined = knots.flatMap((u, i) => split[i] ? [u, (u + knots[i + 1]) / 2] : [u]);
      if (refined.length === knots.length || refined.length > n) break;
      knots = refined;
    }
  }
  return fitSplineTolerance(points, options);
}

function fitOutline(outline: PixelPoint[], box: Box, o: Options): FitResult {
  const fit = fitContour(fitSamples(outline, o.tolerance), o);
  const bounds = splineBox(fit);
  // Restore the measured extents so that smoothing cannot change the sheet calibration.
  for (const axis of [0, 1] as const) {
    const ratio = (box[axis + 2] - box[axis]) / (bounds[axis + 2] - bounds[axis]);
    for (let k = axis; k < fit.P.length; k += 3) fit.P[k] = box[axis] + (fit.P[k] - bounds[axis]) * ratio;
  }
  return fit;
}

type Extent = 'length' | 'width' | 'height';

export function blueprint(data: Float32Array, width: number, height: number, o: Options) {
  if ((o.length > 0) === (o.metres_per_pixel > 0))
    throw new Error('blueprint: set exactly one of length (metres) or metres_per_pixel and leave the other at 0.');
  const views = parseViews(o.views, width, height);
  if (o.length > 0 && !views.some((v) => v.name === o.length_view))
    throw new Error(`blueprint: add a box for length_view "${o.length_view}" or choose a view already in views.`);
  if (!views.some((v) => v.name === 'side') && views.some((v) => v.name === 'front' || v.name === 'rear'))
    throw new Error('blueprint: add a side view box to place the front and rear at its ends.');
  const outlines = views.map((v) => ({ ...v, ...silhouette(data, width, v, o) }));
  const reference = outlines.find((v) => v.name === o.length_view);
  const scale = o.metres_per_pixel || o.length / (reference!.bounds[2] - reference!.bounds[0]);
  const extents: Record<Extent, { name: ViewName; pixels: number }[]> = { length: [], width: [], height: [] };
  const stats: Record<string, number> = { views: views.length, parts_dropped: 0, parts_dropped_large: 0, extent_mismatch: 0 };
  const warnings: string[] = [], b = new GeoBuilder();
  const pixelPositions: PixelPoint[] = [], fits: FitResult[] = [];
  const extent = (name: ViewName, e: Extent, pixels: number) => {
    extents[e].push({ name, pixels });
    stats[`${name}_${e}`] = pixels * scale;
  };
  let sideEnd = 0;
  for (const v of outlines) {
    const long: Axis = v.front === 'up' || v.front === 'down' ? 1 : 0, across = (1 - long) as Axis;
    const hasLength = v.name === 'side' || v.name === 'top';
    const size = (i: Axis) => v.bounds[i + 2] - v.bounds[i];
    const mid = (i: Axis) => (v.bounds[i] + v.bounds[i + 2]) / 2;
    if (hasLength) extent(v.name, 'length', size(long));
    if (v.name !== 'side') extent(v.name, 'width', size(v.name === 'top' ? across : 0));
    if (v.name !== 'top') extent(v.name, 'height', size(v.name === 'side' ? across : 1));
    if (v.name === 'side') sideEnd = size(long) * scale / 2;
    stats.parts_dropped += v.dropped;
    stats.parts_dropped_large += v.droppedLarge;
    if (v.droppedLarge) warnings.push(`blueprint: ${v.name} dropped ${v.droppedLarge} smaller part${v.droppedLarge === 1 ? '' : 's'} over 1% of the kept area. Check its box, erase, seeds or solid shapes.`);

    const widthAxis = v.name === 'top' ? across : 0, heightAxis = v.name === 'side' ? across : 1;
    const mirrorAxis = v.mirror === 'left' || v.mirror === 'right' ? 0 : 1;
    const centre = (!v.mirror || mirrorAxis === widthAxis) ? v.centre ?? mid(widthAxis) : mid(widthAxis);
    const zSign = v.front === 'left' || v.front === 'up' ? -1 : 1;
    // Seen from above with the front up, the sheet's right is -X (Y-up, right-handed, front at +Z), as the front
    // view sees +X on its right and the rear view on its left.
    const xSign = v.name === 'top' ? (v.front === 'left' || v.front === 'down' ? 1 : -1) : v.name === 'rear' ? -1 : 1;
    const ySign = v.name === 'side' && v.front === 'down' ? 1 : -1;
    // Traced outlines run along pixel edges, so the default ground is the box's bottom edge.
    const ground = v.ground ?? (ySign > 0 ? v.box[heightAxis] : v.box[heightAxis + 2]);
    const fit = fitOutline(v.outline, v.bounds, o), ids: number[] = [];
    stats[`${v.name}_cvs`] = fit.P.length / 3;
    for (let k = 0; k < fit.P.length; k += 3) {
      const px: PixelPoint = [fit.P[k], fit.P[k + 1]];
      pixelPositions.push(px);
      ids.push(b.addPoint(
        v.name === 'side' ? 0 : xSign * (px[widthAxis] - centre) * scale,
        v.name === 'top' ? 0 : ySign * (px[heightAxis] - ground) * scale,
        hasLength ? zSign * (px[long] - mid(long)) * scale : v.name === 'front' ? sideEnd : -sideEnd,
      ));
    }
    b.addPrim(ids, true);
    fits.push(fit);
  }

  let mismatch = '';
  const metres = (pixels: number) => pixels * scale < 0.001 ? (pixels * scale).toPrecision(4) : (pixels * scale).toFixed(3);
  for (const e of ['length', 'width', 'height'] as const) {
    const measures = extents[e];
    for (let i = 0; i < measures.length; i++) for (let j = i + 1; j < measures.length; j++) {
      const [a, b] = [measures[i], measures[j]];
      const difference = Math.abs(a.pixels - b.pixels) / Math.max(a.pixels, b.pixels);
      if (difference <= stats.extent_mismatch) continue;
      stats.extent_mismatch = difference;
      mismatch = `blueprint: ${e} differs by ${(difference * 100).toFixed(2)}% between ${a.name} (${metres(a.pixels)} m) and ${b.name} (${metres(b.pixels)} m). Check their boxes, ink or seeds.`;
    }
  }
  if (stats.extent_mismatch > 0.01) warnings.push(mismatch);
  const geo = b.build();
  const names = geo.prims.add('name', 'string', 1), px = geo.points.add('blueprint_px', 'float', 2);
  pixelPositions.forEach((xy, i) => px.set(i, xy));
  views.forEach((v, i) => { names.set(i, v.name); setSplinePrim(geo, i, 'nurbs', fits[i].order, fits[i].knots); });
  geo.detail.add('metres_per_pixel', 'float', 1).set(0, scale);
  for (const e of ['length', 'width', 'height'] as const) geo.detail.add(e, 'float', 1).set(0, (extents[e][0]?.pixels ?? 0) * scale);
  return { geo, stats, warnings };
}
