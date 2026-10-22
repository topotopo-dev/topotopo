// The export target popover: a format and a file name inside exports/, opened by an output's Export button when it
// has no target yet, or to change it. Submitting stores the target in the graph and exports.
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

/**
 * Open the popover under `anchor`. item: an output entry (label, kind, graph, output, target); formats: [{format, label,
 * extension}] from /api/outputs; directory: the exports folder. Resolves to {format, path} or null (cancelled).
 */
export function exportPopover({ anchor, item, formats, directory }) {
  document.querySelector('.export-popover')?.dispatchEvent(new Event('cancel'));
  return new Promise((resolve) => {
    const stem = item.output ?? item.graph ?? 'output';
    const startFormat = item.target?.format ?? (item.kind === 'image' ? 'textures' : 'glb');
    const box = el('form', 'export-popover');
    box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', `Export ${item.label}`);
    const title = el('div', 'export-title', item.target ? `Export target of ${item.label}` : `Export ${item.label}`);
    const format = el('select'); format.setAttribute('aria-label', 'Format');
    for (const f of formats) format.append(new Option(f.label, f.format));
    format.value = startFormat;
    const file = el('input'); file.type = 'text'; file.spellcheck = false; file.setAttribute('aria-label', 'File in exports/');
    file.value = item.target?.path ?? defaultPath(stem, startFormat, formats);
    const where = el('div', 'export-where dim');
    const error = el('div', 'export-error err');
    const cancel = el('button', '', 'Cancel'), go = el('button', 'primary', 'Export');
    cancel.type = 'button'; go.type = 'submit';
    const field = (label, input) => { const l = el('label', 'export-field'); l.append(el('span', 'dim', label), input); return l; };
    const actions = el('div', 'export-actions'); actions.append(cancel, go);
    box.append(title, field('Format', format), field('File', file), where, error, actions);
    let previous = format.value;
    const sync = () => { where.textContent = `${directory}/${file.value.trim() || '…'}`; error.textContent = ''; };
    format.onchange = () => { file.value = swapExtension(file.value.trim(), previous, format.value, formats); previous = format.value; sync(); };
    file.oninput = sync;
    const close = (value) => { box.remove(); removeEventListener('pointerdown', outside, true); anchor?.focus?.(); resolve(value); };
    const outside = (e) => { if (!box.contains(e.target)) close(null); };
    box.addEventListener('cancel', () => close(null));
    cancel.onclick = () => close(null);
    box.onkeydown = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(null); } };
    box.onsubmit = (e) => {
      e.preventDefault();
      const p = file.value.trim().replace(/\\/g, '/');
      if (!p || p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').some((s) => !s || s === '.' || s === '..')) { error.textContent = 'a path inside exports/, without ".." or a drive'; file.focus(); return; }
      close({ format: format.value, path: p });
    };
    sync();
    document.body.append(box);
    const r = anchor.getBoundingClientRect();
    box.style.left = Math.max(6, Math.min(r.left, innerWidth - box.offsetWidth - 6)) + 'px';
    box.style.top = (r.bottom + 4 + box.offsetHeight < innerHeight ? r.bottom + 4 : Math.max(6, r.top - box.offsetHeight - 4)) + 'px';
    addEventListener('pointerdown', outside, true);
    format.focus();
  });
}
