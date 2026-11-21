// Weathering presets and the graphs the weather nodes cook (src/nodes/weather.ts). Data and pure functions only:
// the material kinds and how each ages, the exposure table, the named masks every kind reads, where water leaks
// from (measured on the shape), the planes a stated mount or border adds, and the builder of the graph of bakes and
// the layer stack. The nodes print the graph this builds, so every step can be copied and taken over by hand.
//
//   painted kinds (painted_metal, cast_metal, painted_concrete, painted_plaster, painted_wood, and decal over its
//   substrate) lose their coat: chips on edges and handled parts reveal what is under it (primer, bare metal, concrete,
//   plaster, grey wood), and rust grows in the cores of chips on metal. Bare kinds (concrete, bare_steel, galvanised,
//   stainless, plastic, rubber, bare_wood, asphalt, ceramic) have no coat to lose: they stain, darken, bloom, rust
//   or grey through their whole surface, and their edges only wear lighter. The masks image says which: `coating` is
//   0 on bare kinds.
import { Geometry } from './geometry.ts';
import { RayScene } from './analysis.ts';
import type { GraphSpec, NodeSpec } from '../graph/types.ts';
import { usesName } from './pixelexpr.ts';

// ---------------------------------------------------------------- kinds

/** Kinds whose top layer is a coat that chips off (coating lost shows the layer below). */
export const PAINTED_KINDS = ['painted_metal', 'cast_metal', 'painted_concrete', 'painted_plaster', 'painted_wood', 'decal'] as const;
/** Kinds that source rust runs onto what is below them. */
export const RUSTING_KINDS = ['bare_steel'] as const;
/** Kinds that grow moss and dark organic dirt where water stays (outdoors). */
export const GROWING_KINDS = ['concrete', 'painted_concrete', 'painted_plaster', 'bare_wood', 'painted_wood', 'asphalt', 'ceramic'] as const;

/** A layer as tex_layers reads it (kind layers get the kind's mask multiplied in). */
export type LayerJSON = Record<string, unknown> & { name: string; mask: string };

/**
 * The layers of each kind, bottom to top, over the material's own colour and roughness. `k` is the kind's mask
 * variable (1 on its texels). Masks are the named masks below; colours are display values.
 */
const KIND_LAYERS: Record<string, (k: string) => LayerJSON[]> = {
  painted_metal: (k) => [
    { name: 'fade', mask: `${k} * fade`, color: '#d6d2c8', opacity: 0.55, roughness_offset: 0.25 },
    { name: 'primer', mask: `${k} * chip`, color: '#8e8b84', roughness: 0.75, metallic: 0, height: -0.00004 },
    { name: 'bare', mask: `${k} * bare`, color: '#9a9a96', roughness: 0.4, metallic: 1, height: -0.00008 },
    { name: 'rust', mask: `${k} * clamp(core * 1.1 + bare * 0.45, 0, 1) * clamp(0.2 + rust * 1.1, 0, 1)`, color: [[0, '#3e1c0e'], [0.5, '#64301a'], [1, '#8a4420']], color_by: 'grain', roughness: 0.9, metallic: 0, height: 0.0001 },
  ],
  cast_metal: (k) => [
    { name: 'pitting', mask: `${k} * smoothstep(0.58, 0.8, n_pits) * clamp(k_age * 2, 0, 1)`, roughness_offset: 0.12, height: -0.0003 },
    { name: 'fade', mask: `${k} * fade`, color: '#cfcac0', opacity: 0.45, roughness_offset: 0.2 },
    { name: 'primer', mask: `${k} * chip`, color: '#6f6a64', roughness: 0.7, metallic: 0, height: -0.00004 },
    { name: 'iron', mask: `${k} * bare`, color: '#4d4a46', roughness: 0.6, metallic: 0.85, height: -0.0001 },
    { name: 'rust', mask: `${k} * clamp(core * 1.1 + bare * 0.35, 0, 1) * clamp(0.25 + rust, 0, 1)`, color: [[0, '#5a2814'], [1, '#8c4520']], color_by: 'blotch', roughness: 0.92, metallic: 0, height: 0.00012 },
  ],
  galvanised: (k) => [
    { name: 'dull', mask: `${k} * k_age`, color: '#a3a59f', roughness: 0.75, metallic: 0.7, opacity: 0.8 },
    { name: 'bloom', mask: `${k} * clamp(x_bloom * k_age * (cavity + m_top * 0.6) * (0.4 + blotch), 0, 1)`, color: '#cfcdc4', roughness: 0.9, metallic: 0 },
    { name: 'red_rust', mask: `${k} * k_redrust * smoothstep(0.2, 0.6, convex) * rust`, color: '#7a3b1e', roughness: 0.9, metallic: 0 },
  ],
  bare_steel: (k) => [
    { name: 'mill_scale', mask: `${k} * smoothstep(0.48, 0.62, n_patch) * clamp(k_age * 2, 0, 1)`, color: '#45423e', roughness: 0.65, metallic: 0.7 },
    // rust in patches, opaque where it holds (a thin orange glaze over grey steel reads tan): orange-brown to dark
    // red-brown with the grain, darker in the cavities, low down and in the cores of the patches
    { name: 'flash_rust', mask: `${k} * smoothstep(0.16, 0.36, rust * (0.55 + 0.9 * grain))`, color: [[0, '#5e2a14'], [0.55, '#7c3a1a'], [1, '#9c5222']], color_by: 'grain', roughness: 0.85, metallic: 0 },
    { name: 'heavy_rust', mask: `${k} * smoothstep(0.45, 0.8, rust * (0.6 + cavity + m_low * 0.5) * (0.7 + 0.6 * blotch))`, color: [[0, '#2a1209'], [1, '#4c2210']], color_by: 'grain', roughness: 0.95, metallic: 0, height: 0.0002 },
  ],
  stainless: (k) => [
    { name: 'smudge', mask: `${k} * handled * n_patch * clamp(k_wear * 2, 0, 1)`, roughness_offset: 0.15 },
    { name: 'tea_stain', mask: `${k} * clamp(x_rust * k_age * (cavity * 1.2 + (1 - occlusion)) * blotch, 0, 1)`, color: '#8c6d4a', roughness: 0.55, metallic: 0.6, opacity: 0.6 },
  ],
  plastic: (k) => [
    { name: 'chalk', mask: `${k} * fade`, color: '#d9d6cf', opacity: 0.4, roughness_offset: 0.3 },
    { name: 'scuff', mask: `${k} * chip`, color: '#ffffff', opacity: 0.15, roughness: 0.75 },
  ],
  rubber: (k) => [
    { name: 'bloom', mask: `${k} * fade * 0.8`, color: '#6e6c68', roughness: 0.95, metallic: 0 },
  ],
  concrete: (k) => [
    { name: 'damp', mask: `${k} * damp`, color: [0.8, 0.8, 0.8], color_mode: 'multiply', roughness_offset: -0.08 },
    { name: 'worn_arris', mask: `${k} * edges_soft`, color: '#b8b3a8', opacity: 0.35, height: -0.0002 },
    { name: 'efflorescence', mask: `${k} * clamp(runs_dirt * k_age * 0.8, 0, 1)`, color: '#dedbd2', opacity: 0.5, roughness: 0.95 },
  ],
  painted_concrete: (k) => [
    { name: 'fade', mask: `${k} * fade`, color: '#d9d4ca', opacity: 0.5, roughness_offset: 0.2 },
    { name: 'concrete', mask: `${k} * chip`, color: '#a7a29a', roughness: 0.9, metallic: 0, height: -0.0001 },
    { name: 'damp', mask: `${k} * damp`, color: [0.85, 0.85, 0.85], color_mode: 'multiply' },
  ],
  painted_plaster: (k) => [
    { name: 'fade', mask: `${k} * fade`, color: '#e4e0d6', opacity: 0.4, roughness_offset: 0.15 },
    { name: 'peel', mask: `${k} * peel`, color: '#cfc8bb', roughness: 0.95, metallic: 0, height: -0.0003 },
    { name: 'water_mark', mask: `${k} * clamp(runs_dirt * 1.2 + damp * 0.6, 0, 1)`, color: '#9c8f78', color_mode: 'multiply', opacity: 0.5 },
  ],
  painted_wood: (k) => [
    { name: 'fade', mask: `${k} * fade`, color: '#dcd7cc', opacity: 0.5, roughness_offset: 0.2 },
    { name: 'bare_wood', mask: `${k} * clamp(bare + fade * smoothstep(0.52, 0.72, n_patch), 0, 1)`, color: [[0, '#8b7d68'], [1, '#9a978e']], color_by: 'k_age', roughness: 0.85, metallic: 0, height: -0.0001 },
  ],
  bare_wood: (k) => [
    { name: 'grey', mask: `${k} * clamp(k_age * (0.4 + 0.6 * m_sun) * m_vis, 0, 1) * 0.75`, color: '#9a978e', roughness_offset: 0.1 },
    { name: 'damp', mask: `${k} * damp`, color: [0.7, 0.68, 0.64], color_mode: 'multiply' },
  ],
  asphalt: (k) => [
    { name: 'fade', mask: `${k} * fade`, color: '#6a6762', opacity: 0.5, roughness_offset: 0.1 },
    { name: 'pooling', mask: `${k} * smoothstep(0.75, 0.95, m_top) * smoothstep(0.5, 0.7, blotch) * k_dirt`, color: '#3a3631', opacity: 0.6, roughness_offset: -0.2 },
  ],
  ceramic: (k) => [
    { name: 'bisque', mask: `${k} * chip * 0.6`, color: '#d8d2c6', roughness: 0.85, metallic: 0, height: -0.0002 },
  ],
  decal: (k) => [
    { name: 'fade', mask: `${k} * clamp(k_fade * (0.6 + 0.4 * m_sun), 0, 1)`, color: '#ece8dc', opacity: 0.6, roughness_offset: 0.15 },
    { name: 'scratches', mask: `${k} * smoothstep(0.66, 0.72, n_streak) * k_wear`, color: '#d9d7cf', roughness: 0.6 },
  ],
};

export const WEATHER_KINDS = [...Object.keys(KIND_LAYERS), 'keep'] as const;

/** Words in a material name that suggest a kind: only for the hint of a refusal, never applied. */
const KIND_WORDS: [RegExp, string][] = [
  [/zinc|galvan/, 'galvanised'], [/stainless|inox/, 'stainless'], [/rubber|tyre|tire|seal|gasket/, 'rubber'],
  [/plastic|pvc|abs|poly/, 'plastic'], [/label|decal|sticker|sign|print|foil/, 'decal'], [/cast/, 'cast_metal'],
  [/paint.*(steel|metal|iron)|(steel|metal|iron).*paint/, 'painted_metal'], [/paint.*concrete/, 'painted_concrete'],
  [/plaster|render|stucco/, 'painted_plaster'], [/paint.*wood|wood.*paint/, 'painted_wood'], [/wood|timber|plank/, 'bare_wood'],
  [/concrete|cement/, 'concrete'], [/asphalt|felt|bitumen|tar/, 'asphalt'], [/tile|ceramic|porcelain/, 'ceramic'],
  [/steel|iron|metal|bolt|screw/, 'bare_steel'], [/glass|light|lamp|lens|shadow|interior/, 'keep'],
];
export function suggestKind(name: string): string {
  const s = name.toLowerCase();
  for (const [re, k] of KIND_WORDS) if (re.test(s)) return k;
  return 'keep';
}

// ---------------------------------------------------------------- exposure

export type Exposure = 'outdoor' | 'sheltered' | 'indoor';
/** Multipliers on the masks per exposure (design table 6.3, with growth and damp). */
export const EXPOSURE: Record<Exposure, Record<string, number>> = {
  outdoor: { runs_dirt: 1, runs_rust: 1, fade: 1, dust: 0.6, wash: 0.65, splash: 1, rust: 1, growth: 1, handled: 1, damp: 1, bloom: 1 },
  sheltered: { runs_dirt: 0.3, runs_rust: 0.5, fade: 0.3, dust: 1, wash: 0, splash: 0.3, rust: 0.7, growth: 0.25, handled: 1, damp: 0.5, bloom: 0.5 },
  indoor: { runs_dirt: 0.25, runs_rust: 0, fade: 0.1, dust: 0.8, wash: 0, splash: 0, rust: 0.3, growth: 0, handled: 1.3, damp: 0.2, bloom: 0.2 },
};
const GRIME: Record<Exposure, [string, number]> = { outdoor: ['#3d3529', 0.9], sheltered: ['#40372b', 0.88], indoor: ['#2b2926', 0.45] };

/** The sliders and exposure as the graph vars the stack reads (all k_ and x_ names, so none hides a mask). */
export function weatherVars(o: { wear: number; dirt: number; rust: number; age: number; seed: number; exposure: Exposure; mount: string }): Record<string, number> {
  const A = 0.35 + 1.3 * o.age, x = EXPOSURE[o.exposure];
  const wear = Math.min(1.6, o.wear * A * x.handled ** 0.25);
  return {
    k_wear: wear, k_dirt: o.dirt * A, k_rust: o.rust * A, k_age: Math.min(1, o.age * 1.25), k_fade: o.age * x.fade,
    // a chip shows where the wear field times its noise passes the cut: more wear, a lower cut
    k_cut: wear > 0 ? 1.55 - 0.9 * Math.min(1.3, wear) : 99, k_amount: Math.min(1, wear), k_focus: Math.min(1, 0.5 * x.handled), k_seed: o.seed, k_redrust: Math.max(0, o.rust * A - 0.6) * 2.5,
    k_ground: o.mount === 'ground' ? 1 : 0, k_wall: o.mount === 'wall' ? 1 : 0,
    x_runs_dirt: x.runs_dirt, x_runs_rust: x.runs_rust, x_dust: x.dust, x_wash: x.wash, x_splash: x.splash, x_rust: x.rust,
    x_growth: x.growth, x_handled: x.handled, x_damp: x.damp, x_bloom: x.bloom,
  };
}

// ---------------------------------------------------------------- masks

/** The masks of the full stack, as the masks image holds them (and input 2 may replace). */
export const WEATHER_MASKS = ['edge_wear', 'chip', 'bare', 'core', 'handled', 'cavity', 'occlusion', 'grime', 'dust', 'splash', 'fade', 'rust', 'runs_rust', 'runs_dirt', 'streaks', 'growth', 'damp', 'joints', 'blotch', 'grain'] as const;
/** The masks the masks-only mode packs by default, and every mask it can pack. */
export const PACKED_MASKS = ['dirt', 'leaks', 'edges', 'coating'] as const;
export const PACKABLE = [...PACKED_MASKS, ...WEATHER_MASKS, 'zero', 'one'] as const;

export interface MaskInputs {
  /** handled parts named (distance measure "hand") */
  handled: boolean;
  /** rust runs baked (image rr) */
  rustRuns: boolean;
  /** rust runs from galvanised parts baked (image rg): they show only when the zinc is gone (k_redrust) */
  galvRuns?: boolean;
  /** dirt runs baked from leak sources (image rd) */
  dirtRuns: boolean;
  /** joints baked (image jn) */
  joints: boolean;
  /** kinds present (kind mask variables base_kind_<k>) */
  kinds: string[];
  /** masks replaced by layers of the overrides image (ov) */
  replaced: string[];
  /** a wall is mounted (distance measure "wallnear") */
  wallNear: boolean;
}

/**
 * The named masks, in order (a mask reads the ones before it). Variables: m_* (the measure bake), n_* (the seeded
 * noise bake), part (a 0..1 hash per part), rr / rd (runs), jn_joint, base_kind_* and the k_ / x_ vars.
 */
export function namedMasks(o: MaskInputs, packed = false): { name: string; mask: string }[] {
  const painted = o.kinds.filter((k) => (PAINTED_KINDS as readonly string[]).includes(k)).map((k) => `base_kind_${k}`);
  const grows = o.kinds.filter((k) => (GROWING_KINDS as readonly string[]).includes(k)).map((k) => `base_kind_${k}`);
  const out: { name: string; mask: string }[] = [
    { name: 'pv', mask: '0.8 + 0.4 * frac(part * 13.37 + k_seed * 0.618)' },
    // edges, chips and the handled field come from the edge wear bake (ew): its amount follows the wear slider, and
    // chip, bare and core carry its per-face cap; its C, the raw wear field, is never capped, so no mask cuts it
    { name: 'convex', mask: 'ew_convex' },
    { name: 'occlusion', mask: 'm_occ' },
    { name: 'cavity', mask: 'clamp(m_cav * 1.4 + ew_concave * 0.6, 0, 1)' },
    { name: 'handled', mask: o.handled ? 'ew_handled' : '0' },
    { name: 'edge_wear', mask: 'ew' },
    { name: 'chip', mask: 'ew_chip' },
    { name: 'bare', mask: 'ew_bare' },
    { name: 'core', mask: 'ew_core' },
    { name: 'edges_soft', mask: 'clamp(smoothstep(0.1, 0.6, convex) * (0.3 + 0.8 * n_patch) * k_wear, 0, 1)' },
    { name: 'peel', mask: 'smoothstep(k_cut - 0.1, k_cut - 0.04, (chip * 0.5 + n_patch * 0.8 + m_low * k_ground * 0.4) * pv)' },
    { name: 'blotch', mask: 'n_blotch' }, { name: 'grain', mask: 'n_grain' },
    { name: 'patch_mix', mask: 'n_patch * 0.6 + n_blotch * 0.4' },
    { name: 'grime', mask: 'clamp(k_dirt * (cavity * 1.1 + (1 - m_occ) * 0.9) * (0.4 + 0.9 * n_blotch) * (0.7 + 0.6 * (1 - m_ht)) * pv + handled * k_dirt * 0.35 * n_patch, 0, 1)' },
    { name: 'dust', mask: `clamp(k_dirt * x_dust * smoothstep(0.15, 0.8, m_top) * (1 - x_wash + x_wash * m_shel) * (0.35 + 0.9 * n_grain) ${o.wallNear ? '+ k_wall * m_wallnear * m_top * k_dirt * 0.5' : ''}, 0, 1)` },
    // splash: densest at the ground, thinning upward into spatter (the grain noise cut lower the nearer the ground) with a
    // ragged top; lighter where something overhangs (rain falls less there)
    { name: 'splashd', mask: 'm_low * (0.55 + 0.9 * n_ragged)' },
    { name: 'splash', mask: 'k_ground * clamp(x_splash * k_dirt * 1.3, 0, 1) * clamp(max(smoothstep(0.45, 0.85, splashd), smoothstep(1 - 0.55 * splashd, 1.06 - 0.55 * splashd, n_grain) * smoothstep(0.08, 0.3, splashd)), 0, 1) * (0.6 + 0.5 * n_blotch) * (1 - 0.6 * m_shel)' },
    { name: 'fade', mask: 'clamp(k_fade * m_sun * m_vis * (0.7 + 0.6 * n_blotch), 0, 1)' },
    { name: 'rust', mask: 'clamp(k_rust * x_rust * (0.45 + 0.8 * n_blotch) * (0.7 + 0.5 * cavity + 0.3 * m_top + 0.3 * m_low), 0, 1)' },
    // runs: the core (C) and its broad stain, as separate masks for the layers and together (the stain fainter) as the run
    // (most runs are only their stain, faint; the stronger ones keep a core)
    { name: 'rust_core', mask: `clamp(${[o.rustRuns ? 'rr * smoothstep(0.25, 0.75, rr_strength) * clamp(k_rust * x_runs_rust * 1.6, 0, 1)' : '', o.galvRuns ? 'rg * smoothstep(0.25, 0.75, rg_strength) * clamp(k_redrust * x_runs_rust, 0, 1)' : ''].filter(Boolean).join(' + ') || '0'}, 0, 1)` },
    { name: 'rust_stain', mask: `clamp(${[o.rustRuns ? 'rr_stain * clamp(k_rust * x_runs_rust * 1.5, 0, 1)' : '', o.galvRuns ? 'rg_stain * clamp(k_redrust * x_runs_rust, 0, 1)' : ''].filter(Boolean).join(' + ') || '0'}, 0, 1)` },
    { name: 'runs_rust', mask: 'clamp(rust_core + rust_stain * 0.6, 0, 1)' },
    { name: 'dirt_core', mask: o.dirtRuns ? 'rd * smoothstep(0.7, 1, rd_strength) * clamp(k_dirt * x_runs_dirt * 1.5, 0, 1)' : '0' },
    { name: 'dirt_stain', mask: o.dirtRuns ? 'smoothstep(0.12, 0.85, rd_stain) * clamp(k_dirt * x_runs_dirt * 1.8, 0, 1)' : '0' },
    { name: 'runs_dirt', mask: 'clamp(dirt_core + dirt_stain * 0.6, 0, 1)' },
    // fine rain streaks down steep faces, stronger high up where the water starts
    { name: 'streaks', mask: 'clamp(k_dirt * x_runs_dirt * (1 - m_top) * smoothstep(0.62, 0.8, n_streak) * smoothstep(0.35, 0.65, n_blotch) * m_ht * m_ht * 1.4, 0, 1)' },
    { name: 'damp', mask: 'clamp(x_damp * clamp(k_dirt * 2, 0, 1) * (k_ground * m_low * 0.8 + cavity * 0.4 + runs_dirt * 0.5) * (0.45 + n_patch), 0, 1)' },
    { name: 'growth', mask: grows.length ? `(${grows.join(' + ')}) * clamp(x_growth * k_age * 1.6, 0, 1) * smoothstep(0.38, 0.7, (m_top * (0.55 + 0.45 * m_occ) + k_ground * m_low * 0.9 + cavity * 0.3) * (0.3 + 0.95 * n_moss)) * (1 - 0.5 * m_sun * (1 - m_top))` : '0' },
    { name: 'joints', mask: o.joints ? 'jn_joint' : '0' },
  ];
  if (packed) out.push(
    { name: 'dirt', mask: 'clamp(max(grime, max(dust, max(splash, growth * 0.8))) + joints * 0.9 + damp * 0.3, 0, 1)' },
    { name: 'leaks', mask: 'clamp(runs_dirt + runs_rust + streaks * 0.6, 0, 1)' },
    { name: 'edges', mask: 'clamp(chip + edges_soft * 0.5, 0, 1)' },
    { name: 'coating', mask: painted.length ? `(${painted.join(' + ')}) * clamp(bare + peel * 0.7, 0, 1)` : '0' },
    { name: 'zero', mask: '0' }, { name: 'one', mask: '1' },
  );
  for (const m of out) if (o.replaced.includes(m.name)) m.mask = `ov_${m.name}`;
  // a replaced run is drawn as the core, with no stain of its own
  for (const [run, core, stain] of [['runs_dirt', 'dirt_core', 'dirt_stain'], ['runs_rust', 'rust_core', 'rust_stain']]) {
    if (!o.replaced.includes(run)) continue;
    for (const m of out) if (m.name === core) m.mask = `ov_${run}`; else if (m.name === stain) m.mask = '0';
  }
  return out;
}

/** The shared layers over every weathered kind, after the kind layers. */
export function sharedLayers(o: { exposure: Exposure; kinds: string[]; joints: boolean }): LayerJSON[] {
  const [grimeC, grimeR] = GRIME[o.exposure];
  const out: LayerJSON[] = [
    { name: 'film', mask: '(1 - occlusion) * clamp(k_dirt, 0, 1)', color: [0.86, 0.86, 0.86], color_mode: 'multiply', roughness_offset: 0.1 },
    // a faint grime film over everything, mottled (nothing between the chips stays clean paint), and a soft darkening
    // toward the bottom of the object with a ragged top (never a band)
    { name: 'grime_film', mask: 'clamp(k_dirt * 1.3, 0, 1) * (0.3 + 0.7 * smoothstep(0.2, 0.8, patch_mix))', color: [0.86, 0.84, 0.81], color_mode: 'multiply', roughness_offset: 0.06 },
    { name: 'bottom', mask: 'clamp(k_dirt * 1.4, 0, 1) * (1 - smoothstep(0.0, 0.1 + 0.08 * n_ragged + 0.05 * n_patch, m_ht)) * (0.7 + 0.3 * n_blotch)', color: [0.8, 0.77, 0.73], color_mode: 'multiply', roughness_offset: 0.05 },
    // a light soil over everything, heavier low down and in blotches: nothing stays factory clean
    { name: 'soil', mask: 'clamp(k_dirt * (0.35 + 0.6 * blotch) * (0.6 + 0.7 * (1 - m_ht)), 0, 1)', color: [0.84, 0.82, 0.78], color_mode: 'multiply', roughness_offset: 0.05 },
    { name: 'grime', mask: 'grime', color: grimeC, roughness: grimeR, metallic: 0 },
    { name: 'dust', mask: 'dust', color: '#a69d8b', roughness: 0.95, metallic: 0 },
    { name: 'splash', mask: 'splash', color: [[0, '#3a3128'], [0.5, '#54473a'], [1, '#6e604d']], color_by: 'blotch', opacity: 0.85, roughness: 0.9, metallic: 0 },
    { name: 'streaks', mask: 'streaks', color: '#5f574b', opacity: 0.4, roughness_offset: 0.05 },
    { name: 'dirt_stain', mask: 'dirt_stain', color: '#4c4338', opacity: 0.55, roughness_offset: 0.06 },
    { name: 'runs_dirt', mask: 'dirt_core', color: '#3e372d', opacity: 0.25, roughness_offset: 0.1 },
    { name: 'rust_stain', mask: 'rust_stain', color: '#9a5a2c', opacity: 0.5, roughness_offset: 0.08 },
    { name: 'runs_rust', mask: 'rust_core', color: [[0, '#6a3418'], [1, '#a45a26']], color_by: 'grain', opacity: 0.9, roughness: 0.85, metallic: 0 },
  ];
  if (o.kinds.some((k) => (GROWING_KINDS as readonly string[]).includes(k)) && o.exposure !== 'indoor') out.push({ name: 'growth', mask: 'growth', color: [[0, '#2f3a1f'], [1, '#5a6230']], color_by: 'grain', roughness: 0.95, metallic: 0, height: 0.0002 });
  if (o.joints) out.push({ name: 'joints', mask: 'joints', color: [0.55, 0.55, 0.55], color_mode: 'multiply', roughness_offset: 0.1 });
  out.push(
    { name: 'blotch', mask: '(blotch * 2 - 1) * clamp(k_dirt + k_age, 0, 1)', signed: true, roughness_offset: 0.07 },
    { name: 'grain', mask: '(grain * 2 - 1) * clamp(k_dirt + k_age, 0, 1)', signed: true, roughness_offset: 0.05 },
  );
  return out;
}

/** The kind layers of the kinds present, each named <kind>_<layer> and masked by its kind. */
export function kindLayers(kinds: string[]): LayerJSON[] {
  const out: LayerJSON[] = [];
  for (const k of kinds) for (const L of KIND_LAYERS[k]?.(`base_kind_${k}`) ?? []) out.push({ ...L, name: `${k}_${L.name}` });
  return out;
}

/** Fields an override of a layer may set. */
export const OVERRIDE_FIELDS = ['color', 'opacity', 'roughness', 'roughness_offset', 'metallic', 'height', 'color_mode', 'image', 'normal', 'roughness_image', 'size'] as const;

// ---------------------------------------------------------------- scale

/** Sizes that follow the object: run widths and lengths, noise features, the splash band and the edge radius. */
export function weatherScale(diag: number, height: number, texel: number): { s: number; splash: number; edge: number; cavity: number } {
  const s = Math.min(4, Math.max(0.5, diag / 1.2));
  return { s, splash: Math.min(0.45, Math.max(0.06, 0.2 * height)), edge: Math.max(Math.min(0.03, 0.004 * s), 6 * texel), cavity: Math.max(0.02, 4 * texel) };
}

// ---------------------------------------------------------------- planes

/** A quad (two triangles' worth, one polygon) at center, spanned by the half axes a and b. */
function quad(c: number[], a: number[], b: number[]): Geometry {
  const P: number[] = [];
  for (const [i, j] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) P.push(c[0] + a[0] * i + b[0] * j, c[1] + a[1] * i + b[1] * j, c[2] + a[2] * i + b[2] * j);
  return new Geometry({ positions: P, prims: [[0, 1, 2, 3]] });
}

export interface Box { min: number[]; max: number[] }
/**
 * The plane a stated mount adds: ground = a square at the lowest point, ten times the object's size; wall = one at the
 * stated bbox side, flush with it.
 */
export function mountPlane(b: Box, mount: string, side: string): Geometry | null {
  const c = [0, 1, 2].map((i) => (b.min[i] + b.max[i]) / 2), d = Math.max(1, Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2])) * 5;
  if (mount === 'ground') return quad([c[0], b.min[1], c[2]], [d, 0, 0], [0, 0, d]);
  if (mount !== 'wall') return null;
  const ax = side[1] === 'x' ? 0 : 2, at = side[0] === '-' ? b.min[ax] : b.max[ax];
  const cc = c.slice(); cc[ax] = at;
  return ax === 0 ? quad(cc, [0, 0, d], [0, d, 0]) : quad(cc, [d, 0, 0], [0, d, 0]);
}

/** A plane just above the box: what covers a piece (rain and sky blocked from above). */
export function coverPlane(b: Box): Geometry {
  const c = [(b.min[0] + b.max[0]) / 2, b.max[1] + 0.002, (b.min[2] + b.max[2]) / 2];
  const r = Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2]) * 0.75 + 0.05;
  return quad(c, [r, 0, 0], [0, 0, r]);
}

/**
 * Planes at the joints of a piece: its bbox sides along the long horizontal axis ("sides"), its bottom and its top,
 * each a little larger than the face it closes. A distance bake to them gives the joint band.
 */
export function jointPlanes(b: Box, which: string[]): Geometry[] {
  const ext = [0, 1, 2].map((i) => b.max[i] - b.min[i]), c = [0, 1, 2].map((i) => (b.min[i] + b.max[i]) / 2);
  const along = ext[0] >= ext[2] ? 0 : 2, across = 2 - along, m = 1.02;
  const out: Geometry[] = [];
  const hAlong = [0, 0, 0], hAcross = [0, 0, 0], hUp = [0, ext[1] / 2 * m, 0];
  hAlong[along] = ext[along] / 2 * m; hAcross[across] = Math.max(ext[across], 0.01) / 2 * m;
  if (which.includes('sides')) for (const at of [b.min[along], b.max[along]]) { const cc = c.slice(); cc[along] = at; out.push(quad(cc, hAcross, hUp)); }
  if (which.includes('bottom')) out.push(quad([c[0], b.min[1], c[2]], hAlong, hAcross));
  if (which.includes('top')) out.push(quad([c[0], b.max[1], c[2]], hAlong, hAcross));
  return out;
}

// ---------------------------------------------------------------- leak sources

export interface LeakOptions {
  /** points per metre of source edge */
  density: number;
  seed: number;
  /** rain tested with upward rays (outdoor, sheltered); indoor sources take a fixed weight */
  rain: boolean;
  /** what else blocks the rain (the surroundings) */
  blockers?: Geometry | null;
  /** extra source edges along the top of the box (water from above: a stated border) */
  topEdge?: Box | null;
  /** only prims where this is 1 are measured (the weathered ones) */
  prims?: Uint8Array | null;
  /** at most this many points (thinned evenly along the edges, the weakest first) */
  max?: number;
}
/** The leak points (attribute w), how many each kind of edge gave, and how many were found before the cap thinned them. */
export interface LeakSources { points: Geometry; count: { ledge: number; under: number; top: number }; found: number }

const COS_UP = Math.cos((55 * Math.PI) / 180), STEEP = 0.5;

/**
 * Where water leaves the shape: the outer edge of every surface that faces up and meets a steep face below at a convex
 * edge (sills, copings, parapets, ledges, plate and canopy tops: what drips off the outer edge of an overhang comes from
 * its top), and the wall just under a face turned down that meets it at a concave edge (water creeping under a slab or
 * a canopy), at half weight. Points sit on the steep face a few millimetres from the edge, spaced at 1 / density with a
 * seeded jitter, and are kept with the chance of the rain that reaches their ledge (a few rays up, against the shape and
 * the blockers; indoors a fixed 0.35); point "w" keeps that weight.
 */
export function leakSources(g: Geometry, o: LeakOptions): LeakSources {
  const P = g.P, vp = g.vertexPoint;
  // weld by position so edges between prims that do not share points still meet
  const key = new Map<string, number>(), wid = new Int32Array(g.numPoints);
  const q = 1e5;
  for (let i = 0; i < g.numPoints; i++) {
    const k = `${Math.round(P[i * 3] * q)},${Math.round(P[i * 3 + 1] * q)},${Math.round(P[i * 3 + 2] * q)}`;
    let id = key.get(k);
    if (id === undefined) { id = key.size; key.set(k, id); }
    wid[i] = id;
  }
  const nrm = new Float64Array(g.numPrims * 3), cen = new Float64Array(g.numPrims * 3);
  const edges = new Map<string, { a: number; b: number; prims: number[] }>();
  for (let p = 0; p < g.numPrims; p++) {
    if (!g.primClosed[p] || (o.prims && !o.prims[p])) continue;
    const s = g.primStart[p], e = g.primStart[p + 1], n = e - s;
    if (n < 3) continue;
    let nx = 0, ny = 0, nz = 0, cx = 0, cy = 0, cz = 0;
    for (let k = 0; k < n; k++) {
      const a = vp[s + k] * 3, b = vp[s + ((k + 1) % n)] * 3;
      nx += (P[a + 1] - P[b + 1]) * (P[a + 2] + P[b + 2]);
      ny += (P[a + 2] - P[b + 2]) * (P[a] + P[b]);
      nz += (P[a] - P[b]) * (P[a + 1] + P[b + 1]);
      cx += P[a]; cy += P[a + 1]; cz += P[a + 2];
    }
    const l = Math.hypot(nx, ny, nz);
    if (!(l > 0)) continue;
    nrm[p * 3] = nx / l; nrm[p * 3 + 1] = ny / l; nrm[p * 3 + 2] = nz / l;
    cen[p * 3] = cx / n; cen[p * 3 + 1] = cy / n; cen[p * 3 + 2] = cz / n;
    for (let k = 0; k < n; k++) {
      const pa = vp[s + k], pb = vp[s + ((k + 1) % n)], a = wid[pa], b = wid[pb];
      if (a === b) continue;
      const kk = a < b ? `${a},${b}` : `${b},${a}`;
      let ed = edges.get(kk);
      if (!ed) { ed = { a: pa, b: pb, prims: [] }; edges.set(kk, ed); }
      ed.prims.push(p);
    }
  }
  const world = RayScene.of(o.blockers ? Geometry.merge([g, o.blockers]) : g);
  const scene = o.rain ? world : null;
  const rain = (x: number, y: number, z: number): number => {
    if (!scene) return 0.35;
    let open = 0;
    const dirs = [[0, 1, 0], [0.35, 0.94, 0], [-0.35, 0.94, 0], [0, 0.94, 0.35], [0, 0.94, -0.35]];
    for (const d of dirs) if (!scene.occluded(x, y + 0.002, z, d[0], d[1], d[2], 1e4, 1e-4)) open++;
    return open / dirs.length;
  };
  const pts: number[] = [], wts: number[] = [];
  const count = { ledge: 0, under: 0, top: 0 };
  const under: { a: number[]; b: number[]; w: number[] }[] = [];
  let h = (o.seed * 2654435761) >>> 0;
  const rnd = () => { h = (h + 0x6d2b79f5) >>> 0; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const step = 1 / Math.max(1e-6, o.density);
  /**
   * Points along a-b, set off by `off` (a unit vector times metres) from the edge. Water gathers before it drips: a
   * few points sit at each end of the edge (the ends of a ledge, the joints between its pieces; on a sloping edge the
   * lower end takes them), most of the rest around a few drip spots along it, the remainder anywhere.
   */
  const along = (a: number[], b: number[], off: number[], weight: (x: number, y: number, z: number) => number, kind: keyof typeof count) => {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (!(L > 1e-6)) return;
    const n = Math.max(1, Math.floor(L / step + rnd()));
    const near = Math.min(0.5, 0.03 / L), slope = (b[1] - a[1]) / L;
    const spots = Array.from({ length: Math.max(1, Math.round(L * 2.5 * (0.6 + 0.8 * rnd()))) }, () => near + (1 - 2 * near) * rnd());
    const spread = Math.min(0.25, 0.015 / L);
    for (let i = 0; i < n; i++) {
      const r = rnd();
      let t: number;
      if (r < 0.3) {
        // an end: the lower one of a sloping edge, either of a level one
        const lowB = slope < -0.05 ? 0.85 : slope > 0.05 ? 0.15 : 0.5;
        const nearB = rnd() < lowB;
        t = (nearB ? 1 - rnd() * near : rnd() * near);
      } else if (r < 0.8) {
        const c = spots[Math.floor(rnd() * spots.length)];
        t = Math.min(1 - 1e-3, Math.max(1e-3, c + (rnd() + rnd() + rnd() - 1.5) * spread));
      } else t = rnd();
      const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t, z = a[2] + (b[2] - a[2]) * t;
      // a ledge the rain reaches less keeps fewer of its points
      const w = weight(x, y, z);
      if (!(w > 0.02) || rnd() > w) continue;
      pts.push(x + off[0], y + off[1], z + off[2]);
      wts.push(w);
      count[kind]++;
    }
  };
  const at = (i: number) => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
  for (const ed of edges.values()) {
    if (ed.prims.length !== 2) continue;
    const [p1, p2] = ed.prims;
    const n1 = [nrm[p1 * 3], nrm[p1 * 3 + 1], nrm[p1 * 3 + 2]], n2 = [nrm[p2 * 3], nrm[p2 * 3 + 1], nrm[p2 * 3 + 2]];
    const a = at(ed.a), b = at(ed.b), mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    // which of the two is up-facing / down-facing, which steep
    for (const [u, w, pw] of [[n1, n2, p2], [n2, n1, p1]] as [number[], number[], number][]) {
      if (Math.abs(w[1]) >= STEEP) continue;
      // the side of the steep face's centre relative to the other face's plane: below it = convex for an up face
      const dc = (cen[pw * 3] - mid[0]) * u[0] + (cen[pw * 3 + 1] - mid[1]) * u[1] + (cen[pw * 3 + 2] - mid[2]) * u[2];
      const convex = dc < 0;
      // a point on the steep face, a few millimetres from the edge, away from it inside the face
      const into = [cen[pw * 3] - mid[0], cen[pw * 3 + 1] - mid[1], cen[pw * 3 + 2] - mid[2]];
      const il = Math.hypot(into[0], into[1], into[2]) || 1;
      const off = [(into[0] / il) * 0.004, (into[1] / il) * 0.004, (into[2] / il) * 0.004];
      if (u[1] > COS_UP && convex) along(a, b, off, (x, y, z) => rain(x, y, z), 'ledge');
      else if (u[1] < -COS_UP && !convex) along(a, b, off, () => 0.5, 'under');
      else if (u[1] < -COS_UP && convex) under.push({ a, b, w });
    }
  }
  // the lip of an overhang (a face turned down meeting a steep face above it) over a wall that is a separate piece:
  // water creeps back under it to the wall, found with short level rays from just below the lip
  for (const { a, b, w } of under) {
    const hl = Math.hypot(w[0], w[2]);
    if (!(hl > 1e-6)) continue;
    const dx = -w[0] / hl, dz = -w[2] / hl;
    const L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (!(L > 1e-6)) continue;
    const n = Math.max(1, Math.floor(L / step + rnd()));
    for (let i = 0; i < n; i++) {
      const t = (i + 0.2 + 0.6 * rnd()) / n;
      const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t - 0.003, z = a[2] + (b[2] - a[2]) * t;
      const d = world.nearest(x, y, z, dx, 0, dz, 0.6, 0.002);
      if (!(d < 0.6) || rnd() > 0.5) continue;
      pts.push(x + dx * (d - 0.003), y - 0.004, z + dz * (d - 0.003));
      wts.push(0.5);
      count.under++;
    }
  }
  if (o.topEdge) {
    // water from above along the top edges of the box's steep faces
    const top = o.topEdge.max[1], eps = Math.max(1e-4, (o.topEdge.max[1] - o.topEdge.min[1]) * 1e-3);
    for (const ed of edges.values()) {
      const a = at(ed.a), b = at(ed.b);
      if (a[1] < top - eps || b[1] < top - eps) continue;
      for (const p of ed.prims) {
        if (Math.abs(nrm[p * 3 + 1]) >= STEEP) continue;
        along(a, b, [0, -0.004, 0], () => 1, 'top');
      }
    }
  }
  // thin to the cap: every point stronger than the weakest kept, and of those as strong as it an even share along the
  // edges (every edge keeps its part, not the first ones found)
  let keep = wts.map((_, i) => i);
  if (o.max && keep.length > o.max) {
    const cut = [...wts].sort((x, y) => y - x)[o.max - 1];
    const above = keep.filter((i) => wts[i] > cut), tied = keep.filter((i) => wts[i] === cut), need = o.max - above.length;
    const picked = Array.from({ length: need }, (_, j) => tied[Math.floor(((j + 0.5) * tied.length) / need)]);
    keep = [...above, ...picked].sort((x, y) => x - y);
  }
  const out = new Geometry({ positions: keep.flatMap((i) => [pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]]) });
  const w = out.points.add('w', 'float', 1);
  keep.forEach((i, j) => w.set(j, wts[i]));
  return { points: out, count, found: wts.length };
}

// ---------------------------------------------------------------- the graph

export interface PhotoLayer { layer: string; image: string; size: number; normal: string; roughness: string }
export interface GraphOptions {
  mode: 'maps' | 'masks';
  resolution: number;
  padding: number;
  /** maps: keep, visible or unwrap; masks: keep */
  layout: 'keep' | 'visible' | 'unwrap';
  /** the uv the bakes lie on (masks mode: the mask uv) */
  uv: string;
  /** the uv the material maps are read with */
  mapUV: string;
  kinds: Record<string, string>;
  kindsPresent: string[];
  exposure: Exposure;
  handled: string;
  sun: number[];
  seed: number;
  scale: { s: number; splash: number; edge: number; cavity: number };
  samples: number;
  /** run starts per metre of a rusting part's contact (rust runs) */
  runDensity: number;
  /** inputs of the nested graph present: 1 surroundings, 2 leak points, 3 images (overrides, photos, match), 4 joint planes */
  env: boolean;
  leaks: boolean;
  images: boolean;
  joints: boolean;
  rustSources: boolean;
  /** galvanised parts beside others (rust runs from them once the zinc is gone) */
  galvSources?: boolean;
  mountWall: boolean;
  replaced: string[];
  photos: PhotoLayer[];
  overrides: Record<string, Record<string, unknown>>;
  /** route B: an image of input 3 the stack starts from (the pull toward a reference) */
  match: { image: string; amount: number } | null;
  material: string;
}

export const INPUT_INDEX = { mesh: 0, env: 1, leaks: 2, images: 3, joints: 4 } as const;

/**
 * The mask bakes keep only the layers the stack's expressions name (image m, layer occ is the variable m_occ; layer C,
 * kept always as the main layer, the image's own name), stored as 16-bit floats (tex_compact) except the part ids, which stay exact; a bake nothing
 * reads leaves the merge. The material bake writes no mat_* masks when nothing reads them. In place on nodes and masks.
 */
function compactBakes(nodes: Record<string, NodeSpec>, masks: string[], texts: string[]): void {
  const reads = (v: string) => texts.some((t) => usesName(t, v));
  if (!texts.some((t) => /(^|[^\w$.])base_mat_/.test(t))) nodes.base.params = { ...nodes.base.params, masks: 'kinds' };
  for (let k = masks.length - 1; k >= 0; k--) {
    const id = masks[k], spec = nodes[id];
    const layerNames = spec?.type === 'bake_measure' ? ['C', ...((spec.params?.measures ?? []) as { name: string }[]).map((m) => m.name)]
      : spec?.type === 'bake_flow' ? ['C', 'along', 'strength', 'head', 'id', 'stain']
      : spec?.type === 'bake_edge_wear' ? ['C', 'chip', 'bare', 'core', 'convex', 'concave', 'handled'] : spec?.type === 'bake_mask' ? ['C'] : null;
    if (!layerNames) continue;
    const img = String(spec.params?.name ?? id);
    const used = layerNames.filter((l) => reads(l === 'C' ? img : `${img}_${l}`));
    if (!used.length) { masks.splice(k, 1); continue; }
    // C stays: it is the image's main layer, so the other layers keep their variable names (m_occ, not m)
    if (!used.includes('C')) used.unshift('C');
    nodes[`${id}_kept`] = { type: 'tex_compact', in: [id], params: { keep: used.join(' '), half: spec.type === 'bake_mask' ? '' : '*' } };
    masks[k] = `${id}_kept`;
  }
}

/**
 * The nested graph: (re-packed) atlas, material bake, one measure bake (rays, curvature, facing, height: independent
 * of the seed), one noise bake (seeded), the part hash, runs, joints and photos, then the layer stack; in maps mode
 * texture_to_material puts the maps on the mesh. Sliders reach the stack (graph vars), and wear and age the edge wear
 * threshold, so moving one re-cooks only those.
 */
export function weatherGraph(o: GraphOptions): GraphSpec {
  const nodes: Record<string, NodeSpec> = {};
  const res = o.resolution, pad = o.padding, s = o.scale.s;
  nodes.mesh = { type: 'input', params: { index: INPUT_INDEX.mesh } };
  if (o.env) nodes.surroundings = { type: 'input', params: { index: INPUT_INDEX.env } };
  if (o.leaks) nodes.leak_sources = { type: 'input', params: { index: INPUT_INDEX.leaks } };
  if (o.images) nodes.images = { type: 'input', params: { index: INPUT_INDEX.images } };
  if (o.joints) nodes.joint_planes = { type: 'input', params: { index: INPUT_INDEX.joints } };
  const env = o.env ? ['surroundings'] : [];
  let atlas = 'mesh';
  if (o.layout === 'visible') { nodes.atlas = { type: 'uv_layout', in: ['mesh', ...env], params: { visibility_weight: 1, resolution: res, padding: Math.max(4, pad * 2) } }; atlas = 'atlas'; }
  else if (o.layout === 'unwrap') { nodes.atlas = { type: 'uv_unwrap', in: ['mesh', ...env], params: { visibility_weight: 1, resolution: res, padding: Math.max(4, pad * 2) } }; atlas = 'atlas'; }
  const bake = { resolution: res, padding: pad, uv_attrib: o.uv };
  nodes.base = { type: 'bake_material', in: [atlas], params: { ...bake, map_uv: o.mapUV, kinds: o.kinds, name: 'base' } };
  const f = (v: number) => Math.round(v * 1e4) / 1e4;
  const measures: Record<string, unknown>[] = [
    { by: 'occlusion', name: 'occ' },
    { by: 'cavity', name: 'cav', max_distance: f(o.scale.cavity) },
    { by: 'shelter', name: 'shel', direction: [0, 1, 0], cone: 35 },
    { by: 'visibility', name: 'vis' },
    { by: 'facing', name: 'top', min: 0, max: 20, falloff: 25 },
    { by: 'facing', name: 'sun', direction: o.sun, min: 0, max: 45, falloff: 90 },
    { by: 'height', name: 'ht' },
    // 1 at the lowest point, fading to 0 at the splash height: splash and damp thin out upward, no band with a top
    { by: 'height', name: 'low', min: 0, max: 0, falloff: f(o.scale.splash) },
  ];
  const wallNear = o.mountWall && o.env;
  if (wallNear) measures.push({ by: 'distance', name: 'wallnear', target: 'input1', range: f(0.15 * s) });
  nodes.measure = { type: 'bake_measure', in: [atlas, ...env], params: { ...bake, measures, samples: o.samples, name: 'm' } };
  nodes.noise = {
    type: 'bake_measure', in: [atlas], params: {
      ...bake, seed: o.seed, name: 'n', measures: [
        { by: 'noise', name: 'patch', size: [f(0.15 * s), f(0.15 * s), f(0.15 * s)] },
        { by: 'noise', name: 'grain', size: [f(0.004 * s), f(0.004 * s), f(0.004 * s)], octaves: 3 },
        { by: 'noise', name: 'blotch', size: [f(0.4 * s), f(0.4 * s), f(0.4 * s)] },
        { by: 'noise', name: 'ragged', size: [f(0.03 * s), f(0.03 * s), f(0.03 * s)] },
        { by: 'noise', name: 'streak', size: [f(0.03 * s), f(0.35 * s), f(0.03 * s)] },
        { by: 'noise', name: 'pits', noise: 'worley', size: [0.004, 0.004, 0.004], octaves: 1 },
        { by: 'noise', name: 'moss', size: [f(0.06 * s), f(0.06 * s), f(0.06 * s)], fractal: 'turbulence' },
      ],
    },
  };
  // the worn edges: the wear slider sets the amount (a slider change re-cooks only its threshold and per-face cap, the
  // wear field is kept), the handled parts are its focus
  nodes.wear = {
    type: 'bake_edge_wear', in: [atlas, ...env], params: {
      ...bake, name: 'ew', amount: '=k_amount', radius: f(o.scale.edge), reach: f(o.scale.edge * 2), chip_size: f(0.006 * s),
      patch_size: f(0.15 * s), seed: o.seed, ...(o.handled ? { focus: o.handled, focus_radius: f(0.06 * s), focus_amount: '=k_focus' } : {}),
    },
  };
  nodes.parts = { type: 'bake_mask', in: [atlas], params: { ...bake, attrib: 'wpart', name: 'part' } };
  const masks = ['measure', 'noise', 'wear', 'parts'];
  // water on a flat face goes straight down (it wanders only where the shape turns it): little wobble, many runs whose
  // lengths vary a lot (most short, a few long), each a narrow core in a broad soft stain; the stains add up, so under a
  // long edge they merge into a wash that breaks into streaks lower down, and most are faint (stain_skew), a few strong
  const run = { resolution: res, padding: pad, uv_attrib: o.uv, seed: o.seed, length: [f(0.03 * s), f(0.4 * s)], width: [f(0.002 * s), f(0.008 * s)], wobble: 0.05, breakup: 0.3, stain: 5, stain_skew: 1.5 };
  if (o.rustSources && o.runDensity > 0) { nodes.rust_runs = { type: 'bake_flow', in: [atlas], params: { ...run, sources: '@wrust=1', density: f(o.runDensity), name: 'rr' } }; masks.push('rust_runs'); }
  if (o.galvSources && o.runDensity > 0) { nodes.galv_runs = { type: 'bake_flow', in: [atlas], params: { ...run, sources: '@wrust=2', density: f(o.runDensity), name: 'rg' } }; masks.push('galv_runs'); }
  if (o.leaks) { nodes.dirt_runs = { type: 'bake_flow', in: [atlas, 'leak_sources'], params: { ...run, length: [f(0.03 * s), f(1.0 * s)], width: [f(0.0015 * s), f(0.005 * s)], wobble: 0.04, stain: 6, stain_skew: 2, name: 'rd' } }; masks.push('dirt_runs'); }
  if (o.joints) { nodes.joints = { type: 'bake_measure', in: [atlas, 'joint_planes'], params: { ...bake, name: 'jn', measures: [{ by: 'distance', name: 'joint', target: 'input1', range: 1 }] } }; masks.push('joints'); }
  for (const ph of o.photos) {
    const id = `photo_${ph.layer}`;
    nodes[id] = { type: 'bake_triplanar', in: [atlas, 'images'], params: { ...bake, color: ph.image, normal: ph.normal, roughness: ph.roughness, size: ph.size, seed: o.seed, name: id } };
    masks.push(id);
  }
  if (o.images) masks.push('images');
  const named = namedMasks({ handled: !!o.handled, rustRuns: o.rustSources && o.runDensity > 0, galvRuns: !!o.galvSources && o.runDensity > 0, dirtRuns: o.leaks, joints: o.joints, kinds: o.kindsPresent, replaced: o.replaced, wallNear }, o.mode === 'masks');
  let layers: LayerJSON[] = [];
  if (o.mode === 'maps') {
    if (o.match) layers.push({ name: 'match', mask: '1', image: o.match.image, opacity: o.match.amount });
    layers.push(...kindLayers(o.kindsPresent), ...sharedLayers({ exposure: o.exposure, kinds: o.kindsPresent, joints: o.joints }));
    layers = layers.map((L) => {
      const ov = o.overrides[L.name];
      if (!ov) return L;
      const { image: _i, normal: _n, roughness_image: _r, size: _s, ...rest } = ov;
      const out: LayerJSON = { ...L, ...rest } as LayerJSON;
      if (_i) { delete out.color; delete out.color_by; out.image = `photo_${L.name}`; }
      return out;
    });
  }
  // only the masks people read are written (the steps between them stay in memory): an image layer each is a lot at 4K
  const keep: readonly string[] = o.mode === 'masks' ? PACKABLE : WEATHER_MASKS;
  const written = named.map((m) => (keep.includes(m.name) ? m : { ...m, write: false }));
  compactBakes(nodes, masks, [...written.map((m) => m.mask), ...layers.flatMap((L) => [L.mask, typeof L.color_by === 'string' ? L.color_by : ''])]);
  nodes.mask_images = { type: 'merge', in: masks };
  nodes.stack = { type: 'tex_layers', in: ['base', 'mask_images'], params: { masks: written, layers, outputs: o.mode === 'masks' ? 'masks' : 'both', padding: pad, name: o.material } };
  if (o.mode === 'masks') return { nodes, output: 'stack' };
  const m = o.material;
  nodes.out = { type: 'texture_to_material', in: [atlas, 'stack'], params: { material: m, base_color: `${m}_base_color`, normal: `${m}_normal`, orm: `${m}_orm` } };
  return { nodes, output: 'out' };
}
