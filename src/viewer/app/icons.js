// The editor's icons: outline drawings on a 24-unit grid, drawn in the text colour. Each entry is the inside of an
// <svg> element; icon(name) gives the whole element as markup. A part meant to be solid carries its own fill.
export const ICONS = {
  // the tool strip
  select: '<path d="M6 3.5v15l4.2-3.9 2.9 6 2.4-1.2-2.9-5.9 5.4-.5z"/>',
  move: '<path d="M12 3v18M3 12h18M9.2 5.8 12 3l2.8 2.8M9.2 18.2 12 21l2.8-2.8M5.8 9.2 3 12l2.8 2.8M18.2 9.2 21 12l-2.8 2.8"/>',
  rotate: '<path d="M20 12a8 8 0 1 1-4-6.93M14.6 1.4 16 5.07l-3.9.7"/>',
  scale: '<path d="M4 14h6v6H4zM12.5 11.5 20 4M14.5 4H20v5.5"/>',
  add: '<path d="M12 5v14M5 12h14"/>',
  // the view strip
  camera: '<path d="M3.5 8h10.5v9H3.5zM14 11l6-3v9l-6-3"/>',
  shading: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none"/>',
  snap: '<path d="M6 4v8a6 6 0 0 0 12 0V4h-4v8a2 2 0 0 1-4 0V4zM6 8h4M14 8h4"/>',
  frame: '<path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4"/><circle cx="12" cy="12" r="2.5"/>',
  quad: '<path d="M4 4h16v16H4zM12 4v16M4 12h16"/>',
  // the top bar
  undo: '<path d="M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="m15 14 5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.6 2.4c-.8.5-1.2 1-1.2 2M12 17v.01"/>',
  // the guides of the Create menu
  null: '<path d="M12 4.5v15M4.5 12h15M7.5 16.5l9-9"/>',
  curve: '<path d="M5 17C9 5 14 20 19 8"/><path d="M3.2 16.2h3v3h-3zM17.8 5.2h3v3h-3z"/>',
  area: '<path d="M5 8l8-4 7 6-4 10-10-2zM7.5 14l6.5-6.5M10.5 17.5l7-7"/>',
  volume: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9"/>',
  // menus
  check: '<path d="M5 12.5l5 5 9-10.5"/>',
  caret: '<path d="M8 10l4 4 4-4"/>',
};

const OPEN = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';

/** The markup of one icon. */
export function icon(name) {
  if (!ICONS[name]) throw new Error(`no icon "${name}"`);
  return `${OPEN}${ICONS[name]}</svg>`;
}
