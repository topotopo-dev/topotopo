// What an output says about itself on the page: its kind line on the card and in Properties, and the heightfield
// layers a person can see in red over the terrain. The server decides the kind from the cooked geometry
// (src/io/kinds.ts); these plain functions are tested in Node (test/viewer-logic.ts).
import { fmtSize } from './units.js';

/**
 * A result's kind as its badge shows it, in the words everything uses (src/io/kinds.ts): mesh, instances, points,
 * curves, terrain, textures, material, volume, scene, or empty; '' for a texture of an output, a sidecar or a file.
 */
export const kindBadge = (item) => (item.kind && item.kind !== 'metadata' ? item.kind : '');

/** Its size beside the badge: "2049 × 2049 samples, 2 m apart · 4096 × 312 × 4096 m". */
export function detailLine(item) {
  const what = item.about ?? (item.kind === 'metadata' ? 'metadata' : '');
  return [what, item.size ? fmtSize(item.size) : ''].filter(Boolean).join(' · ');
}

/** An output's kind and tags in words, as the CLI says them: "mesh [crate, wood]" (the badges read in the same order). */
export const kindTagsLine = (o) => `${o.kind || 'kind not pinned'}${o.tags?.length ? ` [${o.tags.join(', ')}]` : ''}`;

/** What a result that uses packages shown live says: it shows their unpublished edits; its exports and downloads use the published versions. */
export const liveText = (item) => (item.live?.length ? `shows the unpublished edits of ${item.live.join(', ')} (live this session, for looking): Export and Download write the published version` : '');

/** What it is in a line, its kind first: "terrain · 2049 × 2049 samples, 2 m apart · 4096 × 312 × 4096 m" (its view before it has cooked). */
export function kindLine(item) {
  const line = [kindBadge(item), detailLine(item)].filter(Boolean).join(' · ');
  return line || (item.view === 'image' ? 'image' : item.view === 'file' ? 'file' : '');
}

/** A heightfield's layers a person can see in red (not the height itself): the mask first, then the others, then none. */
export function layerChoices(hf) {
  if (!hf) return [];
  const unit = (l) => l.min >= 0 && l.max <= 1;
  const layers = hf.layers.filter((l) => l.name !== 'height').sort((a, b) => (a.name === 'mask' ? -1 : b.name === 'mask' ? 1 : 0));
  return [
    ...layers.map((l) => ({ value: l.name, label: l.name === 'mask' || unit(l) ? l.name : `${l.name} (${+l.min.toPrecision(3)} .. ${+l.max.toPrecision(3)})` })),
    { value: 'none', label: 'none' },
  ];
}

/** Quads per side the viewer draws a heightfield with by default (src/render/preview.ts HEIGHTFIELD_PREVIEW_RES). */
export const PREVIEW_RES = 512;
/** The most triangles a terrain detail choice may draw: more does not load in a browser tab. */
export const MAX_PREVIEW_TRIANGLES = 8.5e6;

/** The sample step and the triangles of a heightfield drawn with at most `res` quads per side (src/core/heightfield.ts). */
export function previewStep(hf, res) {
  const step = Math.max(1, Math.ceil((Math.max(hf.width, hf.height) - 1) / Math.max(1, res)));
  const shown = (n) => Math.ceil((n - 1) / step) + 1;
  return { step, triangles: 2 * (shown(hf.width) - 1) * (shown(hf.height) - 1) };
}

/**
 * The terrain detail choices for a heightfield: the preview, 1024 and 2048 quads per side, every sample ("full"); each
 * says how far apart the drawn samples are and how many triangles that makes. Choices that draw the same as one before
 * are left out (a budget that draws every sample is "full"); one past MAX_PREVIEW_TRIANGLES is disabled.
 */
export function detailChoices(hf) {
  if (!hf) return [];
  const tri = (t) => (t >= 1e6 ? `${+(t / 1e6).toFixed(1)}M` : `${Math.round(t / 1e3)}k`) + ' triangles';
  const out = [], seen = new Set();
  for (let [value, res] of [['preview', PREVIEW_RES], ['1024', 1024], ['2048', 2048], ['full', Infinity]]) {
    const s = previewStep(hf, res);
    if (seen.has(s.step)) continue;
    seen.add(s.step);
    // a budget that draws every sample is "full"
    if (s.step === 1 && value !== 'preview') value = 'full';
    const name = value;
    const spacing = +(hf.cell * s.step).toPrecision(3);
    out.push({
      value, step: s.step, triangles: s.triangles, disabled: s.triangles > MAX_PREVIEW_TRIANGLES,
      label: `${name} (${s.step === 1 ? 'every sample' : `${spacing} m`}, ${tri(s.triangles)}${s.triangles > MAX_PREVIEW_TRIANGLES ? ': too many for the viewer' : ''})`,
    });
  }
  return out;
}

/** The layer shown in red: the one chosen if the heightfield still has it (or "none"), else the mask, else none. */
export function shownLayer(hf, chosen) {
  const names = new Set(hf?.layers.map((l) => l.name));
  return chosen && (chosen === 'none' || names.has(chosen)) ? chosen : names.has('mask') ? 'mask' : 'none';
}
