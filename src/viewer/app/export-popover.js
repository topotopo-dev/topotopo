// The format popover of an output card, opened by its Download button (a format; Download gets the export as a
// browser download) or its Export button (a format and a file inside exports/; Export stores that target in the graph
// and writes). It offers the formats that write the output, best first, each saying in a line what it writes: the
// server decides them from the cooked geometry (io/kinds.ts) and the export code's own formats (io/files.ts).
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

/** A file name stem like the server's (io/targets.ts fileStem). */
export const fileStem = (s) => String(s).replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^\.+|[. ]+$/g, '') || 'output';

/** The path a format writes to by default: <stem><extension>, a folder for formats without one. */
export function defaultPath(stem, format, formats) {
  return fileStem(stem) + (formats.find((f) => f.format === format)?.extension ?? '');
}

/** The path with its extension swapped from one format's to another's (a custom name keeps its stem). */
export function swapExtension(p, from, to, formats) {
  const ext = (f) => formats.find((x) => x.format === f)?.extension ?? '';
  const a = ext(from), b = ext(to);
  const stem = a && p.toLowerCase().endsWith(a.toLowerCase()) ? p.slice(0, -a.length) : p;
  return stem + b;
}

/** A path inside `folder` (the exports folder as the server gives it), written with that folder's separators. */
export function inFolder(folder, p) {
  const sep = String(folder).includes('\\') ? '\\' : '/';
  return `${String(folder).replace(/[\\/]+$/, '')}${sep}${String(p).split(/[\\/]/).join(sep)}`;
}

/** A file name without its folders and extension (".points.json" counts as one), as the server names a zip. */
export const stemOf = (p) => String(p).replace(/[\\/]+$/, '').replace(/^.*[\\/]/, '').replace(/(\.points\.json|\.[^.]*)$/i, '') || 'export';

/**
 * The formats a card offers: the ones that write it (item.formats, from the server), and its target's format when
 * that one does not (an older target: marked, so the person sees why it writes nothing of the output). An output that
 * has not cooked yet (it failed) offers every format.
 */
export function offeredFormats(item, formats) {
  const fits = item.formats ?? formats.map((f) => ({ ...f, writes: '', leaves: [], oneFile: false }));
  const t = item.target?.format;
  if (!t || fits.some((f) => f.format === t)) return fits;
  const f = formats.find((x) => x.format === t) ?? { format: t, label: t, extension: '' };
  return [...fits, { ...f, writes: 'does not fit this output: it writes none of it', leaves: [], oneFile: false, misfit: true }];
}

/**
 * A format's line in the popover: what it writes, and the parts of the output it leaves out. A download is the file
 * itself (or a zip): what an export would add beside it in exports/ is not said there.
 */
export const writesLine = (fit, download = false) => {
  if (!fit) return '';
  const writes = download ? fit.writes.replace(/\s*\(\+ [^)]*in exports\/\)/, '') : fit.writes;
  return `${writes}${fit.leaves?.length ? ` · not the ${fit.leaves.join(' or the ')}` : ''}`;
};

/**
 * The name a download in `format` gets: the target's file name when the format is the target's, else the output's
 * stem with the format's extension; a zip (<stem>.zip) unless the format downloads as one file (fit.oneFile).
 */
export function downloadName(item, fit) {
  const own = item.target && item.target.format === fit.format ? item.target.path : null;
  const stem = own ? stemOf(own) : fileStem(item.output ?? item.graph ?? 'output');
  if (!fit.oneFile) return `${stem}.zip`;
  return own ? String(own).replace(/^.*[\\/]/, '') : stem + (fit.extension ?? '');
}

/** The target a download asks for: the card's own target (its path and options) for its format, else the format alone. */
export function downloadSpec(item, format) {
  const t = item.target;
  return t && t.format === format ? { format, path: t.path, ...(t.options ?? {}) } : format;
}

/** The file name of a Content-Disposition header (filename*=UTF-8''…), or null. */
export function filenameOf(header) {
  const m = /filename\*=UTF-8''([^;]+)/i.exec(header ?? '') ?? /filename="?([^";]+)"?/i.exec(header ?? '');
  try { return m ? decodeURIComponent(m[1]) : null; } catch { return m ? m[1] : null; }
}

/**
 * Open the popover under `anchor`. item: an output entry (label, graph, output, target, formats); formats: every format
 * [{format, label, extension}] from /api/outputs; directory: the exports folder; mode "export" (a format and a file in
 * exports/) or "download" (a format). Resolves to {format, path} (export) or {format} (download), or null (cancelled).
 */
export function exportPopover({ anchor, item, formats, directory, mode = 'export' }) {
  document.querySelector('.export-popover')?.dispatchEvent(new Event('cancel'));
  const download = mode === 'download';
  return new Promise((resolve) => {
    const stem = item.output ?? item.graph ?? 'output';
    // a download offers what writes the output; the export target, its own format too when that one does not
    const offered = download ? item.formats ?? [] : offeredFormats(item, formats);
    const startFormat = offered.find((f) => f.format === item.target?.format)?.format ?? offered[0]?.format;
    const box = el('form', 'export-popover');
    box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', `${download ? 'Download' : 'Export'} ${item.label}`);
    const title = el('div', 'export-title', download ? `Download ${item.label}` : item.target ? `Export target of ${item.label}` : `Export ${item.label}`);
    const about = el('div', 'export-about dim', item.about ?? '');
    // a result that uses a package shown live: the file holds the published version, not the edits shown
    const live = item.live?.length ? el('div', 'export-live', `Writes the published ${item.live.join(', ')}, not the live edits shown`) : null;
    const format = el('select'); format.setAttribute('aria-label', 'Format');
    for (const f of offered) format.append(new Option(f.misfit ? `${f.label} (does not fit)` : f.label, f.format));
    if (startFormat) format.value = startFormat;
    const writes = el('div', 'export-writes');
    const file = el('input'); file.type = 'text'; file.spellcheck = false; file.setAttribute('aria-label', 'File in exports/');
    file.value = item.target?.path ?? (startFormat ? defaultPath(stem, startFormat, formats) : '');
    const where = el('div', 'export-where dim');
    const error = el('div', 'export-error err');
    const cancel = el('button', '', 'Cancel'), go = el('button', 'primary', download ? 'Download' : 'Export');
    cancel.type = 'button'; go.type = 'submit';
    const field = (label, input) => { const l = el('label', 'export-field'); l.append(el('span', 'dim', label), input); return l; };
    const actions = el('div', 'export-actions'); actions.append(cancel, go);
    box.append(title);
    if (item.about) box.append(about);
    if (live) box.append(live);
    if (offered.length) box.append(field('Format', format), writes);
    else box.append(el('div', 'export-writes err', item.kind === 'volume'
      ? 'no format writes an SDF volume of functions: sdf_to_mesh makes it a mesh to export'
      : 'no format writes this output: it holds nothing to export'));
    if (!download && offered.length) box.append(field('File', file), where);
    box.append(error, actions);
    go.disabled = !offered.length;
    let previous = format.value;
    const fit = () => offered.find((f) => f.format === format.value);
    const sync = () => {
      const f = fit();
      writes.textContent = writesLine(f, download);
      writes.classList.toggle('err', !!f?.misfit);
      writes.classList.toggle('part', !!f?.leaves?.length);
      where.textContent = download ? '' : inFolder(directory, file.value.trim() || '…');
      if (download && f) go.textContent = `Download ${downloadName(item, f)}`;
      error.textContent = '';
    };
    format.onchange = () => { file.value = swapExtension(file.value.trim(), previous, format.value, formats); previous = format.value; sync(); };
    file.oninput = sync;
    const close = (value) => { box.remove(); removeEventListener('pointerdown', outside, true); anchor?.focus?.(); resolve(value); };
    const outside = (e) => { if (!box.contains(e.target)) close(null); };
    box.addEventListener('cancel', () => close(null));
    cancel.onclick = () => close(null);
    box.onkeydown = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(null); } };
    box.onsubmit = (e) => {
      e.preventDefault();
      if (!offered.length) return;
      if (download) { close({ format: format.value }); return; }
      const p = file.value.trim().replace(/\\/g, '/');
      if (!p || p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').some((s) => !s || s === '.' || s === '..')) { error.textContent = 'a path inside exports/ (or engine: and a path inside the game engine\'s assets folder), without ".." or a drive'; file.focus(); return; }
      close({ format: format.value, path: p });
    };
    sync();
    document.body.append(box);
    const r = anchor.getBoundingClientRect();
    box.style.left = Math.max(6, Math.min(r.left, innerWidth - box.offsetWidth - 6)) + 'px';
    box.style.top = (r.bottom + 4 + box.offsetHeight < innerHeight ? r.bottom + 4 : Math.max(6, r.top - box.offsetHeight - 4)) + 'px';
    addEventListener('pointerdown', outside, true);
    (download && offered.length ? go : offered.length ? format : cancel).focus();
  });
}
