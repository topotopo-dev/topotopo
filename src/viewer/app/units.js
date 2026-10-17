// Units on screen: the adaptive grid's step and how lengths and coordinates are printed (metres, Y up).
// Plain functions, tested in Node (test/viewer-logic.ts).

/** The grid steps the views choose from (docs/design/viewer.md section 4), in metres. */
export const GRID_STEPS = [0.01, 0.1, 1, 10, 100, 1000];
/** Major lines every this many steps. */
export const MAJOR_EVERY = 10;
/** A minor cell is at least this many pixels wide. */
export const MIN_CELL_PX = 8;

/**
 * The step for a view showing `worldPerPixel` metres per pixel around its target: the smallest step whose cells are
 * at least MIN_CELL_PX wide, clamped to GRID_STEPS.
 */
export function gridStep(worldPerPixel, minPx = MIN_CELL_PX) {
  if (!(worldPerPixel > 0) || !Number.isFinite(worldPerPixel)) return 1;
  for (const s of GRID_STEPS) if (s / worldPerPixel >= minPx) return s;
  return GRID_STEPS[GRID_STEPS.length - 1];
}

/** "1 m", "0.01 m", "1000 m". */
export const fmtStep = (s) => `${+s.toPrecision(6)} m`;

/** Decimals that show a coordinate to a hundredth of the grid step (at least 0, at most 4). */
export const decimalsFor = (step) => Math.max(0, Math.min(4, Math.ceil(-Math.log10(step)) + 2));

/** A number with fixed decimals, without "-0". */
export function fmtNum(x, d = 2) {
  if (!Number.isFinite(x)) return String(x);
  const s = x.toFixed(d);
  return /^-0(\.0*)?$/.test(s) ? s.slice(1) : s;
}

/** A length in metres with decimals that suit its size: 0.0042 m, 0.85 m, 12.3 m, 1250 m. */
export function fmtLen(m) {
  const a = Math.abs(m);
  const d = a === 0 ? 0 : a < 0.01 ? 4 : a < 1 ? 3 : a < 10 ? 2 : a < 1000 ? 1 : 0;
  return fmtNum(m, d);
}

/** A box's size, "1.20 × 0.80 × 1.10 m". */
export const fmtSize = (size) => `${size.map(fmtLen).join(' × ')} m`;

/** A point, "(1.20, 0.00, -3.45)", to a hundredth of `step`. */
export const fmtPoint = (p, step = 1) => `(${p.map((x) => fmtNum(x, decimalsFor(step))).join(', ')})`;

/** File sizes. */
export const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);

/** Counts with thousands separators, the same on every machine. */
export const fmtCount = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
