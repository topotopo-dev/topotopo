// What an output says about itself on the page: its kind line on the card and in Properties, and the heightfield
// layers a person can see in red over the terrain. The server decides the kind from the cooked geometry
// (src/io/kinds.ts); these plain functions are tested in Node (test/viewer-logic.ts).
import { fmtSize } from './units.js';

/** What a card says it is: "heightfield 2049 × 2049, 2 m · 4096 × 312 × 4096 m" (its view before it has cooked). */
export function kindLine(item) {
  const what = item.about ?? (item.kind === 'metadata' ? 'metadata' : item.kind) ?? (item.view === 'image' ? 'image' : item.view === 'file' ? 'file' : '');
  return [what, item.size ? fmtSize(item.size) : ''].filter(Boolean).join(' · ');
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
