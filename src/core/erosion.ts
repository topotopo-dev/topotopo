// Heightfield erosion: hydraulic (particle droplets) + thermal (talus relaxation), deterministic for a seed.
//
// Hydraulic model: rain droplets (Beyer 2015, the model popularised by Sebastian Lague's erosion demo) start at
// random samples, run downhill with inertia, pick up material where they are fast and under capacity
// (capacity = max(drop, min_slope) × speed × water × sediment_capacity) and drop it where they slow down, climb or
// evaporate. Fixes over the common version: speed grows going downhill (speed² − Δh·g), and a droplet that dies
// or (with closed boundaries) reaches the border drops what it still carries, so material is conserved exactly.
// Thermal model: every sample steeper than the talus angle towards any of its 8 neighbours sheds a fraction of
// the excess to the lower ones (Musgrave et al. 1989).
//
// One iteration = erodeStep(field, params, rng): a rain pass of rain_density × samples droplets, then one thermal
// pass. It reads and writes plain typed arrays only, so a native/WASM kernel can replace it: same arrays in, the
// same arrays updated in place, the same parameter meanings (see ErosionField / ErosionParams). The rng is only
// used to draw droplet start positions and the tile order. ErosionParams count in samples (a droplet moves one cell
// per step); dropletParams converts heightfield_erode's settings in metres to them for a field's cell size.
//
// Performance: the droplet pass is bound by memory latency, so droplets run tile by tile (32 × 32 samples, tiles
// in a random order per pass) and the net change is recorded once per pass instead of per write. The thermal pass
// works row by row in small functions (V8 optimises them as ordinary functions instead of on-stack-replacing one
// long loop on every call).

export interface ErosionField {
  /** samples along X */
  width: number;
  /** samples along Z */
  height: number;
  /** sample spacing in metres */
  cellSize: number;
  /** terrain height in metres, row-major (j * width + i); updated in place (Float64 keeps the mass bookkeeping exact) */
  h: Float64Array;
  /** 0..1 resistance per sample: erosion is scaled by (1 - hardness); null = 0 everywhere */
  hardness: Float32Array | null;
  /** 0..1 per sample: 1 freezes it (no erosion, deposition or thermal change); null = 0 everywhere */
  freeze: Float32Array | null;
  /** accumulated water volume passing each sample (raw sum), updated */
  flow: Float64Array;
  /** net hydraulic change in metres (+ deposited, − eroded), updated */
  sediment: Float64Array;
  /** net thermal change in metres (+ debris settled, − worn away), updated */
  debris: Float64Array;
  /** water left by droplets that came to rest at each sample (raw sum), updated */
  water: Float64Array;
}

export interface ErosionParams {
  /** droplets per sample per iteration */
  rainDensity: number;
  /** initial water volume of a droplet */
  rainAmount: number;
  /** fraction of the free capacity picked up per step (0..1) */
  erosionRate: number;
  /** fraction of the excess sediment dropped per step (0..1) */
  depositionRate: number;
  /** carry capacity factor */
  sedimentCapacity: number;
  /** fraction of a droplet's water lost per step (0..1) */
  evaporation: number;
  /** 0 = droplets follow the steepest descent, 1 = keep their direction */
  inertia: number;
  /** acceleration on slopes */
  gravity: number;
  /** minimum capacity (as a slope), keeps droplets eroding on gentle ground */
  minSlope: number;
  /** erosion brush radius in samples */
  erosionRadius: number;
  /** maximum steps per droplet */
  maxLifetime: number;
  /** thermal talus (angle of repose) in degrees */
  talusAngle: number;
  /** 0..1 fraction of the excess material moved per thermal pass (0 = no thermal erosion) */
  thermalRate: number;
  /** 'closed': droplets reaching the border drop their load there (mass is conserved); 'open': the load leaves the field */
  boundary: 'closed' | 'open';
}

export const DEFAULT_EROSION: ErosionParams = {
  rainDensity: 0.02, rainAmount: 1, erosionRate: 0.3, depositionRate: 0.3, sedimentCapacity: 1, evaporation: 0.1,
  inertia: 0.1, gravity: 4, minSlope: 0.01, erosionRadius: 3, maxLifetime: 30, talusAngle: 40, thermalRate: 0.1,
  boundary: 'closed',
};

// ---------------------------------------------------------------- settings in metres

/**
 * Droplet erosion settings in world units (heightfield_erode's params): rain per square metre, lengths in metres, and
 * per-step settings defined for a droplet step of erosionRadius / 3 metres. dropletParams turns them into the
 * per-sample ErosionParams the kernels take for one cell size.
 */
export interface DropletSettings extends Omit<ErosionParams, 'rainDensity' | 'erosionRadius' | 'maxLifetime'> {
  /** droplets per square metre per iteration */
  rainDensity: number;
  /** erosion brush radius in metres; a third of it is the droplet step the per-step settings refer to */
  erosionRadius: number;
  /** the farthest a droplet travels, in metres */
  maxDistance: number;
}

/** The kernel limits dropletParams applied, each with the value it used (in samples). */
export interface DropletLimits { radius?: number; steps?: number; density?: number }

/**
 * The per-sample ErosionParams that erode like `s` on a field with cells of `cell` metres, so the same settings give
 * the same erosion in metres at any spacing (within what the coarser grid can resolve).
 *
 * The kernels move a droplet one cell per step and count in samples. The settings are defined for steps of
 * step = erosionRadius / 3 metres (the default radius of three cells runs them as given), and a cell of `cell` metres
 * is r = cell / step of those steps: the per-step fractions compound (f → 1 − (1 − f)^r, inertia i → i^r), the speed²
 * gained on a slope grows with the drop (gravity × r), the sediment a droplet carries keeps its volume in metres
 * (sediment capacity is a volume in cells³: ÷ r³), and a thermal pass moves the same height per iteration (rate ÷ r,
 * at most 1). Counts become samples: the brush erosionRadius / cell samples (1..64), maxDistance / cell steps
 * (1..4096) and rainDensity × cell² droplets per sample (at most 1); `limited` reports the limits that applied.
 * Ratios within 1e-9 of a whole number are that number, so the defaults at 0.1 m cells give the kernel defaults bit
 * for bit.
 */
export function dropletParams(s: DropletSettings, cell: number): { params: ErosionParams; limited: DropletLimits } {
  const snap = (x: number) => (Math.abs(x - Math.round(x)) < 1e-9 ? Math.round(x) : x);
  const unit = (x: number) => Math.min(1, Math.max(0, x));
  const r = snap(cell / (s.erosionRadius / 3));
  const perStep = (f: number) => (r === 1 ? f : 1 - Math.pow(1 - unit(f), r));
  const limited: DropletLimits = {};
  let radius = Math.max(1, snap(s.erosionRadius / cell));
  if (radius > 64) radius = limited.radius = 64;
  let steps = Math.max(1, Math.round(s.maxDistance / cell));
  if (steps > 4096) steps = limited.steps = 4096;
  let density = s.rainDensity * cell * cell;
  if (density > 1) density = limited.density = 1;
  const params: ErosionParams = {
    rainDensity: density, rainAmount: s.rainAmount,
    erosionRate: perStep(s.erosionRate), depositionRate: perStep(s.depositionRate), evaporation: perStep(s.evaporation),
    sedimentCapacity: Math.min(1e6, s.sedimentCapacity / (r * r * r)),
    inertia: r === 1 ? s.inertia : Math.pow(unit(s.inertia), r),
    gravity: Math.min(1e6, s.gravity * r), minSlope: s.minSlope, erosionRadius: radius, maxLifetime: steps,
    talusAngle: s.talusAngle, thermalRate: Math.min(1, s.thermalRate / r), boundary: s.boundary,
  };
  return { params, limited };
}

/** A fresh field for erosion with zeroed accumulators (heights are copied). */
export function makeErosionField(width: number, height: number, cellSize: number, h: ArrayLike<number>, hardness: Float32Array | null = null, freeze: Float32Array | null = null): ErosionField {
  const n = width * height;
  return {
    width, height, cellSize, h: Float64Array.from(h), hardness, freeze,
    flow: new Float64Array(n), sediment: new Float64Array(n), debris: new Float64Array(n), water: new Float64Array(n),
  };
}

/** One erosion iteration: a rain pass of droplets, then one thermal pass. Updates the field in place. */
export function erodeStep(field: ErosionField, params: ErosionParams, rng: () => number): void {
  if (params.rainDensity > 0 && params.rainAmount > 0) {
    // the net hydraulic change is recorded as the height difference over the pass (cheaper than per-write tracking)
    const h = field.h, sed = field.sediment, before = h.slice();
    hydraulicPass(field, params, rng);
    smoothDeposits(field, before);
    for (let k = 0; k < h.length; k++) sed[k] += h[k] - before[k];
  }
  if (params.thermalRate > 0) thermalPass(field, params);
}

// ---------------------------------------------------------------- hydraulic

/**
 * Spread the material deposited during a pass with a [1 2 1] / 4 kernel along X then Z (weights renormalised at
 * the border, so mass is conserved exactly). Droplets drop their load into the 2 × 2 samples around them, which
 * leaves speckles on flats; eroded gullies are left sharp.
 */
function smoothDeposits(f: ErosionField, before: Float64Array) {
  if (f.freeze) return; // never spread material onto frozen samples
  const W = f.width, Hn = f.height, h = f.h, n = W * Hn;
  const dep = new Float64Array(n), tmp = new Float64Array(n);
  let any = false;
  for (let k = 0; k < n; k++) { const d = h[k] - before[k]; if (d > 0) { dep[k] = d; h[k] -= d; any = true; } }
  if (!any) return;
  for (let j = 0; j < Hn; j++) {
    const o = j * W;
    for (let i = 0; i < W; i++) {
      const v = dep[o + i];
      if (v === 0) continue;
      if (i === 0) { tmp[o] += v * (2 / 3); if (W > 1) tmp[o + 1] += v / 3; else tmp[o] += v / 3; }
      else if (i === W - 1) { tmp[o + i] += v * (2 / 3); tmp[o + i - 1] += v / 3; }
      else { tmp[o + i - 1] += v * 0.25; tmp[o + i] += v * 0.5; tmp[o + i + 1] += v * 0.25; }
    }
  }
  for (let j = 0; j < Hn; j++)
    for (let i = 0; i < W; i++) {
      const k = j * W + i, v = tmp[k];
      if (v === 0) continue;
      if (j === 0) { h[k] += v * (2 / 3); if (Hn > 1) h[k + W] += v / 3; else h[k] += v / 3; }
      else if (j === Hn - 1) { h[k] += v * (2 / 3); h[k - W] += v / 3; }
      else { h[k - W] += v * 0.25; h[k] += v * 0.5; h[k + W] += v * 0.25; }
    }
}

/** Brush offsets and weights (radius - distance, normalised to 1) for the droplet erosion footprint. */
function makeBrush(radius: number): { dx: Int32Array; dz: Int32Array; w: Float64Array; R: number } {
  const R = Math.max(0, Math.ceil(radius) - 1);
  const dx: number[] = [], dz: number[] = [], w: number[] = [];
  let sum = 0;
  for (let z = -R; z <= R; z++)
    for (let x = -R; x <= R; x++) {
      const d = Math.hypot(x, z);
      if (d >= radius && !(x === 0 && z === 0)) continue;
      const wt = Math.max(1e-6, radius - d);
      dx.push(x); dz.push(z); w.push(wt); sum += wt;
    }
  return { dx: Int32Array.from(dx), dz: Int32Array.from(dz), w: Float64Array.from(w, (v) => v / sum), R };
}

function hydraulicPass(f: ErosionField, p: ErosionParams, rng: () => number) {
  const W = f.width, Hn = f.height, c = f.cellSize, inv = 1 / c;
  const h = f.h, flow = f.flow, water = f.water;
  const hard = f.hardness, frz = f.freeze;
  const brush = makeBrush(Math.max(1, p.erosionRadius));
  const bdx = brush.dx, bdz = brush.dz, bw = brush.w, nb = bw.length, R = brush.R;
  const boff = Int32Array.from(bdx, (x, b) => bdz[b] * W + x);
  const plain = !hard && !frz;
  const inertia = Math.min(1, Math.max(0, p.inertia)), follow = 1 - inertia;
  const capK = p.sedimentCapacity, minCap = p.minSlope, erodeK = Math.min(1, Math.max(0, p.erosionRate));
  const depK = Math.min(1, Math.max(0, p.depositionRate)), keep = 1 - Math.min(1, Math.max(0, p.evaporation)), grav = p.gravity;
  const closed = p.boundary !== 'open';
  const life = Math.max(1, Math.round(p.maxLifetime));
  const count = Math.round(p.rainDensity * W * Hn);
  const maxX = W - 1, maxZ = Hn - 1;

  // start positions, then a tile order: counting sort by a shuffled tile rank, random order within a tile
  const xs = new Float64Array(count), zs = new Float64Array(count);
  for (let d = 0; d < count; d++) { xs[d] = rng() * maxX; zs[d] = rng() * maxZ; }
  const TS = 32, ntx = Math.ceil(W / TS), nt = ntx * Math.ceil(Hn / TS);
  const rank = new Int32Array(nt);
  for (let t = 0; t < nt; t++) rank[t] = t;
  for (let t = nt - 1; t > 0; t--) { const s = Math.floor(rng() * (t + 1)); const tmp = rank[t]; rank[t] = rank[s]; rank[s] = tmp; }
  const start = new Int32Array(nt + 1), tileOf = new Int32Array(count), order = new Int32Array(count);
  for (let d = 0; d < count; d++) { const t = rank[((zs[d] / TS) | 0) * ntx + ((xs[d] / TS) | 0)]; tileOf[d] = t; start[t + 1]++; }
  for (let t = 0; t < nt; t++) start[t + 1] += start[t];
  for (let d = 0; d < count; d++) order[start[tileOf[d]]++] = d;

  for (let o = 0; o < count; o++) {
    const d = order[o];
    let px = xs[d], pz = zs[d];
    let dirX = 0, dirZ = 0, speed = 1, wat = p.rainAmount, load = 0;
    let alive = true;
    for (let step = 0; step < life; step++) {
      const ix = px | 0, iz = pz | 0;
      const fx = px - ix, fz = pz - iz;
      const k = iz * W + ix;
      const h00 = h[k], h10 = h[k + 1], h01 = h[k + W], h11 = h[k + W + 1];
      const gx = ((h10 - h00) * (1 - fz) + (h11 - h01) * fz) * inv;
      const gz = ((h01 - h00) * (1 - fx) + (h11 - h10) * fx) * inv;
      const hOld = (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz;
      dirX = dirX * inertia - gx * follow;
      dirZ = dirZ * inertia - gz * follow;
      const len = Math.sqrt(dirX * dirX + dirZ * dirZ);
      flow[k] += wat;
      if (len < 1e-12) break; // flat: the droplet stops here
      dirX /= len; dirZ /= len;
      const nx = px + dirX, nz = pz + dirZ;
      if (nx < 0 || nx >= maxX || nz < 0 || nz >= maxZ) {
        // leaving the field: closed boundaries keep the load at the border sample, open ones lose it
        if (!closed) load = 0;
        alive = false;
        break;
      }
      const jx = nx | 0, jz = nz | 0, ux = nx - jx, uz = nz - jz, m = jz * W + jx;
      const hNew = (h[m] * (1 - ux) + h[m + 1] * ux) * (1 - uz) + (h[m + W] * (1 - ux) + h[m + W + 1] * ux) * uz;
      const dh = (hNew - hOld) * inv; // in samples (a slope × 1 step)
      const cap = (-dh > minCap ? -dh : minCap) * speed * wat * capK;
      if (load > cap || dh > 0) {
        // deposit: fill the pit we are climbing out of, or drop a fraction of the excess
        let amt = dh > 0 ? (dh < load ? dh : load) : (load - cap) * depK;
        if (frz) amt *= 1 - Math.min(1, Math.max(0, (frz[k] + frz[k + 1] + frz[k + W] + frz[k + W + 1]) * 0.25));
        if (amt > 0) {
          load -= amt;
          const a = amt * c;
          h[k] += (1 - fx) * (1 - fz) * a; h[k + 1] += fx * (1 - fz) * a;
          h[k + W] += (1 - fx) * fz * a; h[k + W + 1] += fx * fz * a;
        }
      } else {
        // erode with the brush around the node, never more than the drop to the next position
        const want = (cap - load) * erodeK;
        const amt = (want < -dh ? want : -dh) * c;
        if (amt > 0) {
          if (plain && ix >= R && ix <= maxX - R && iz >= R && iz <= maxZ - R) {
            // interior, no hardness/freeze: the weights sum to 1
            for (let b = 0; b < nb; b++) h[k + boff[b]] -= bw[b] * amt;
            load += amt * inv;
          } else {
            let taken = 0;
            for (let b = 0; b < nb; b++) {
              const x = ix + bdx[b], z = iz + bdz[b];
              if (x < 0 || x > maxX || z < 0 || z > maxZ) continue;
              const q = z * W + x;
              let e = bw[b] * amt;
              if (hard) e *= 1 - Math.min(1, Math.max(0, hard[q]));
              if (frz) e *= 1 - Math.min(1, Math.max(0, frz[q]));
              h[q] -= e;
              taken += e;
            }
            load += taken * inv;
          }
        }
      }
      const v2 = speed * speed - dh * grav;
      speed = v2 > 0 ? Math.sqrt(v2) : 0;
      wat *= keep;
      px = nx; pz = nz;
    }
    // the droplet stops: drop whatever it still carries; slow droplets (stuck in pits and basins) leave their water
    if (load > 0) {
      const ix = px | 0, iz = pz | 0, fx = px - ix, fz = pz - iz, k = iz * W + ix, a = load * c;
      h[k] += (1 - fx) * (1 - fz) * a; h[k + 1] += fx * (1 - fz) * a;
      h[k + W] += (1 - fx) * fz * a; h[k + W + 1] += fx * fz * a;
    }
    if (alive) water[(pz | 0) * W + (px | 0)] += wat / (1 + speed * speed);
  }
}

// ---------------------------------------------------------------- thermal

/** Per-pass constants and arrays of the thermal relaxation. */
class Thermal {
  W: number; Hn: number; h: Float64Array; hard: Float32Array | null; frz: Float32Array | null;
  talus: number; tD: number; rate: number; delta: Float64Array;
  ox = Int32Array.from([1, -1, 0, 0, 1, 1, -1, -1]);
  oz = Int32Array.from([0, 0, 1, -1, 1, -1, 1, -1]);
  tal: Float64Array; ex = new Float64Array(8);

  constructor(f: ErosionField, p: ErosionParams) {
    this.W = f.width; this.Hn = f.height; this.h = f.h; this.hard = f.hardness; this.frz = f.freeze;
    this.talus = Math.tan((Math.min(89.9, Math.max(0, p.talusAngle)) * Math.PI) / 180) * f.cellSize;
    this.tD = this.talus * Math.SQRT2;
    this.rate = Math.min(1, Math.max(0, p.thermalRate));
    this.delta = new Float64Array(f.width * f.height);
    this.tal = Float64Array.from([1, 1, 1, 1, 0, 0, 0, 0], (a) => (a ? this.talus : this.tD));
  }
}

function thermalPass(f: ErosionField, p: ErosionParams) {
  const t = new Thermal(f, p);
  thermalEdgeRow(t, 0);
  for (let j = 1; j < t.Hn - 1; j++) {
    if (t.frz) thermalEdgeRow(t, j);
    else thermalRow(t, j);
  }
  thermalEdgeRow(t, t.Hn - 1);
  const h = f.h, deb = f.debris, delta = t.delta;
  for (let k = 0; k < delta.length; k++) { const d = delta[k]; if (d !== 0) { h[k] += d; deb[k] += d; } }
}

/** An interior row without a freeze layer: quick rejection, then unrolled over the 8 neighbours. */
function thermalRow(t: Thermal, j: number) {
  const W = t.W, h = t.h, delta = t.delta, talus = t.talus, tD = t.tD, rate = t.rate, hard = t.hard;
  thermalCell(t, j, 0);
  for (let i = 1, k = j * W + 1; i < W - 1; i++, k++) {
    const hk = h[k];
    let e0 = hk - h[k + 1] - talus, e1 = hk - h[k - 1] - talus, e2 = hk - h[k + W] - talus, e3 = hk - h[k - W] - talus;
    let e4 = hk - h[k + W + 1] - tD, e5 = hk - h[k - W + 1] - tD, e6 = hk - h[k + W - 1] - tD, e7 = hk - h[k - W - 1] - tD;
    if (e0 <= 0 && e1 <= 0 && e2 <= 0 && e3 <= 0 && e4 <= 0 && e5 <= 0 && e6 <= 0 && e7 <= 0) continue;
    if (e0 < 0) e0 = 0; if (e1 < 0) e1 = 0; if (e2 < 0) e2 = 0; if (e3 < 0) e3 = 0;
    if (e4 < 0) e4 = 0; if (e5 < 0) e5 = 0; if (e6 < 0) e6 = 0; if (e7 < 0) e7 = 0;
    let maxd = e0;
    if (e1 > maxd) maxd = e1; if (e2 > maxd) maxd = e2; if (e3 > maxd) maxd = e3;
    if (e4 > maxd) maxd = e4; if (e5 > maxd) maxd = e5; if (e6 > maxd) maxd = e6; if (e7 > maxd) maxd = e7;
    let move = rate * maxd * 0.5;
    if (hard) move *= 1 - Math.min(1, Math.max(0, hard[k]));
    if (!(move > 0)) continue;
    const s0 = move / (e0 + e1 + e2 + e3 + e4 + e5 + e6 + e7);
    delta[k] -= move;
    delta[k + 1] += e0 * s0; delta[k - 1] += e1 * s0; delta[k + W] += e2 * s0; delta[k - W] += e3 * s0;
    delta[k + W + 1] += e4 * s0; delta[k - W + 1] += e5 * s0; delta[k + W - 1] += e6 * s0; delta[k - W - 1] += e7 * s0;
  }
  thermalCell(t, j, W - 1);
}

/** A border row, or any row when a freeze layer is present: the general per-cell path. */
function thermalEdgeRow(t: Thermal, j: number) {
  for (let i = 0; i < t.W; i++) thermalCell(t, j, i);
}

function thermalCell(t: Thermal, j: number, i: number) {
  const W = t.W, Hn = t.Hn, h = t.h, frz = t.frz, ox = t.ox, oz = t.oz, tal = t.tal, ex = t.ex;
  const k = j * W + i;
  if (frz && frz[k] >= 0.5) return;
  const hk = h[k];
  let total = 0, maxd = 0;
  for (let s = 0; s < 8; s++) {
    ex[s] = 0;
    const x = i + ox[s], z = j + oz[s];
    if (x < 0 || x >= W || z < 0 || z >= Hn) continue;
    const q = z * W + x;
    const d = hk - h[q] - tal[s];
    if (d > 0 && !(frz && frz[q] >= 0.5)) { ex[s] = d; total += d; if (d > maxd) maxd = d; }
  }
  if (total <= 0) return;
  let move = t.rate * maxd * 0.5;
  if (t.hard) move *= 1 - Math.min(1, Math.max(0, t.hard[k]));
  if (!(move > 0)) return;
  t.delta[k] -= move;
  const s0 = move / total;
  for (let s = 0; s < 8; s++) if (ex[s] > 0) t.delta[(j + oz[s]) * W + i + ox[s]] += ex[s] * s0;
}
