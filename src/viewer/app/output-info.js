// What an output says about itself on the page: its kind line on the card and in Properties, and the heightfield
// layers a person can see in red over the terrain. The server decides the kind from the cooked geometry
// (src/io/kinds.ts); these plain functions are tested in Node (test/viewer-logic.ts).
import { fmtSize } from './units.js';

/**
 * A result's kind as its badge shows it, in the words everything uses (src/io/kinds.ts): mesh, instances, points,
 * curves, terrain, textures, volume, scene, or empty; '' for a texture of an output, a sidecar or a file.
 */
export const kindBadge = (item) => (item.kind && item.kind !== 'metadata' ? item.kind : '');

/** Its size beside the badge: "2049 × 2049 samples, 2 m apart · 4096 × 312 × 4096 m". */
export function detailLine(item) {
  const what = item.about ?? (item.kind === 'metadata' ? 'metadata' : '');
  return [what, item.size ? fmtSize(item.size) : ''].filter(Boolean).join(' · ');
}

/** What a result that uses packages shown live says: its exports and downloads hold their unpublished edits. */
export const liveText = (item) => (item.live?.length ? `uses the unpublished edits of ${item.live.join(', ')} (shown live this session): Export and Download write them too, and say so in how the file was made` : '');

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

/** The layer shown in red: the one chosen if the heightfield still has it (or "none"), else the mask, else none. */
export function shownLayer(hf, chosen) {
  const names = new Set(hf?.layers.map((l) => l.name));
  return chosen && (chosen === 'none' || names.has(chosen)) ? chosen : names.has('mask') ? 'mask' : 'none';
}
