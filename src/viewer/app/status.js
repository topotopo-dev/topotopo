// The status bar's own lines: what the page says when nothing else is reported.
// Plain functions, tested in Node (test/viewer-logic.ts).

/** While the event stream is connected. */
export const LIVE_LINE = 'live — updates on every build, edit and file save';
/** While the workspace has no graph. */
export const NO_GRAPHS_LINE = 'no graphs yet — build one via MCP';

/** The line when the event stream (re)connects: the hint while there is no graph, else the live line. */
export const connectedLine = (graphCount) => (graphCount ? LIVE_LINE : NO_GRAPHS_LINE);

/**
 * The line after the graph list was read, or null to keep the one shown: the hint while there is no graph, and the
 * live line in its place once the first graph arrives. Any other line (an undo, a keymap note, an error) stays.
 * Whichever of the two runs last at startup, the page ends on the line that fits the workspace.
 */
export function graphsLine(shown, graphCount) {
  if (!graphCount) return NO_GRAPHS_LINE;
  return shown === NO_GRAPHS_LINE ? LIVE_LINE : null;
}
