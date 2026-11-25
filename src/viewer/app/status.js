// The page's messages: what something the person did came to, in a small area over the view that clears itself, so
// the status bar keeps only the cook line and what is shown. Plain functions, tested in Node (test/viewer-logic.ts).

/** While the event stream is down: it stays until the page reconnects. */
export const DISCONNECTED_LINE = 'the viewer server is not answering (stopped?): this page reconnects when it runs again';
/** When the event stream comes back. */
export const RECONNECTED_LINE = 'connected again';

export function disconnectedNotice(reopen) {
  return reopen ? {
    text: 'The editor is not answering. It stops by itself 10 minutes after its last tab is closed.',
    links: [{ text: 'Open it again', href: reopen }],
  } : { text: DISCONNECTED_LINE, links: [] };
}

export function otherPackageNotice(title, other, reopen) {
  const links = [];
  if (reopen) links.push({ text: `Open ${title} again`, href: reopen });
  links.push({ text: `Show ${other}`, href: null });
  return { text: `This tab was for ${title}. The editor at this address now shows ${other}.`, links };
}

/** A successful write always names the file first. Warnings go in the expandable part of the message. */
export function exportNotice({ file, path, files, warnings = [], extra = '' }) {
  return {
    text: `Exported ${file ?? 'exports/' + path}${files > 1 ? ` (${files} files)` : ''}${extra}`,
    kind: warnings.length ? 'warn' : 'ok', warnings,
  };
}

/**
 * How long a message stays (ms), Infinity until another replaces it: an error 12 s, work in progress ("busy") until its
 * result replaces it, the disconnected line until the page reconnects, others 6 s; `hold` makes it at least that long.
 */
export function messageLife(text, kind = '', hold = 0) {
  if (!text) return 0;
  if (kind === 'busy' || text === DISCONNECTED_LINE) return Infinity;
  return Math.max(hold, kind === 'err' ? 12000 : 6000);
}
