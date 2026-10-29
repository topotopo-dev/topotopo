// The page's messages: what something the person did came to, in a small area over the view that clears itself, so
// the status bar keeps only the cook line and what is shown. Plain functions, tested in Node (test/viewer-logic.ts).

/** While the event stream is down: it stays until the page reconnects. */
export const DISCONNECTED_LINE = 'the viewer server is not answering (stopped?): this page reconnects when it runs again';
/** When the event stream comes back. */
export const RECONNECTED_LINE = 'connected again';

/**
 * How long a message stays (ms), Infinity until another replaces it: an error 12 s, work in progress ("busy") until its
 * result replaces it, the disconnected line until the page reconnects, others 6 s; `hold` makes it at least that long.
 */
export function messageLife(text, kind = '', hold = 0) {
  if (!text) return 0;
  if (kind === 'busy' || text === DISCONNECTED_LINE) return Infinity;
  return Math.max(hold, kind === 'err' ? 12000 : 6000);
}
