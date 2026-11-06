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

/**
 * A result's name as hover shows it beside the cursor: its published output, else its node; of a piece, the name its
 * file gives it after that, when it is not the same ("house › roof").
 */
export function resultName({ output = null, node = null, part = null } = {}) {
  const base = output || node || 'result';
  return part && part !== base ? `${base} › ${part}` : base;
}

/**
 * The own name of a drawable in a loaded glTF, or null: a primitive the loader numbered after its mesh ("house_1"
 * under "house") goes by the mesh's name; the names the preview gives unnamed parts ("mesh", "source_0", "scene")
 * are no names.
 */
export function partName(name, parent = '') {
  const own = parent && new RegExp(`^${parent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_\\d+$`).test(name) ? parent : name;
  return !own || /^(mesh|source|scene|points|curves|lines)(_\d+)*$/.test(own) ? null : own;
}

/** The counts of a geometry summary (src/inspect.ts summarize): its first line, "1,234 points, 567 prims …". */
export const countsLine = (summary) => String(summary ?? '').split('\n')[0].trim();

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
