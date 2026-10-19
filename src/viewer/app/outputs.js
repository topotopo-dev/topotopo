import { createImageView } from './image-view.js';
import { fmtBytes } from './units.js';

const url = (route, item, more = {}) => `/api/output/${route}?` + new URLSearchParams({ id: item.id, rev: item.revision, ...more });
const text = (tag, value, cls) => { const e = document.createElement(tag); e.textContent = value; if (cls) e.className = cls; return e; };
const FORMAT_GROUPS = {
  'Mesh / scene': ['glb', 'gltf', 'obj', 'usda', 'stl', 'ply'],
  'Geometry / data': ['geo', 'json', 'csv', 'pointsjson'],
  Terrain: ['png16', 'r16', 'mask_png', 'unreal_landscape'], Textures: ['textures'],
};
const FORMAT_NOTES = {
  glb: 'One file with material textures embedded.', gltf: 'glTF scene with embedded resources.', obj: 'Mesh, normals and UVs. Materials and textures are not written by this exporter.',
  usda: 'USD scene with generated textures beside it.', stl: 'Triangles only; no materials, textures or UVs.', ply: 'Geometry and vertex attributes; no texture files.',
  geo: 'Houdini geometry, attributes and groups.', json: 'Lossless TopoTopo geometry; this is not the editable graph.', csv: 'Point/instance data with companion meshes when applicable.', pointsjson: 'Point/instance data with companion meshes when applicable.',
  png16: '16-bit heightmap plus import settings.', r16: 'RAW heightmap plus import settings.', mask_png: 'PNG weight layers.', unreal_landscape: 'Landscape, layers, meshes and import manifest.', textures: 'PNG images and selected extra layers.',
};

export function createOutputPanel(ctx) {
  const host = document.getElementById('outputs'), details = document.getElementById('output-details');
  const image = createImageView(document.getElementById('viewport'), ctx.message);
  let list = [], selected = null, directory = '', sequence = 0, lastList = '', initial = true, refreshing = null, refreshAgain = false;
  const P = { active: null };
  const exportButton = document.getElementById('export-output');
  function showDetails(item) {
    details.replaceChildren(); details.hidden = !item;
    exportButton.disabled = !item?.exportable || item.status !== 'ready';
    if (!item) return;
    details.append(text('strong', item.label), text('p', item.error ?? item.summary ?? `${item.kind}${item.width ? ` · ${item.width} × ${item.height}` : ''}`, item.error ? 'err' : 'dim'));
    if (item.files) for (const f of item.files) {
      const a = text('a', `${f.name} · ${fmtBytes(f.size)}`); a.href = url('file', item, { file: f.id, download: '1' }); a.download = f.name; details.append(a);
    }
    if (item.files?.length > 1) { const a = text('a', 'Download ZIP'); a.href = url('zip', item); a.download = item.label + '.zip'; details.append(a); }
  }
  function render() {
    host.replaceChildren();
    if (!list.length) { host.append(text('p', 'Outputs appear here when a graph is built or a file is exported.', 'empty')); return; }
    const groups = new Map();
    for (const item of list) { const g = item.graph ?? (item.summary === 'Reference image' ? 'Images' : 'Saved files'); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(item); }
    for (const [name, items] of groups) {
      host.append(text('div', name, 'output-group'));
      // Keep each model's textures and each bundle's files directly beneath their parent.
      const ordered = [], seen = new Set(), ids = new Set(items.map((item) => item.id));
      const visit = (item) => { if (seen.has(item.id)) return; seen.add(item.id); ordered.push(item); for (const child of items) if (child.parent === item.id) visit(child); };
      for (const item of items) if (!ids.has(item.parent)) visit(item);
      for (const item of items) visit(item);
      for (const item of ordered) {
        const row = document.createElement('button'); row.className = 'output-card' + (item.id === selected ? ' selected' : '') + (item.parent ? ' child' : ''); row.dataset.output = item.id;
        row.setAttribute('aria-label', `${item.label} — ${item.kind}`); row.setAttribute('aria-pressed', String(item.id === selected));
        const thumb = document.createElement('img'); thumb.loading = 'lazy'; thumb.alt = '';
        if (['geometry', 'image'].includes(item.kind) && item.status !== 'loading') thumb.src = item.kind === 'image' && !item.generated ? url('file', item) : url('thumb', item);
        thumb.onerror = () => { thumb.hidden = true; };
        const body = document.createElement('span'); body.append(text('span', item.label, 'output-label'), text('small', item.error ?? (item.status === 'loading' ? 'Cooking…' : `${item.generated ? '' : 'Saved · '}${item.kind}${item.width ? ` · ${item.width}×${item.height}` : ''}`), item.error ? 'err' : 'dim'));
        row.append(thumb, body); row.onclick = () => P.select(item.id); host.append(row);
      }
    }
  }
  P.select = async (id, update = false) => {
    const item = list.find((v) => v.id === id); if (!item) return;
    const changedSelection = selected !== id;
    if (!update) ctx.rememberOutputView?.(selected);
    const seq = ++sequence;
    if (changedSelection) { image.hide(); ctx.hideModelPreview(); }
    selected = id; P.active = item; ctx.isolated = true; ctx.guides.setMode(null);
    render(); showDetails(item);
    if (item.status === 'loading') { ctx.message('Preparing ' + item.label, 'busy'); return; }
    if (item.status === 'error') { ctx.message(item.error, 'err'); return; }
    await ctx.outputGraph?.(item);
    if (seq !== sequence) return;
    if (item.kind === 'image') { ctx.hideModelPreview(); image.show(item); ctx.message(item.label); ctx.emit('output'); return; }
    image.hide();
    if (item.kind !== 'geometry') { ctx.hideModelPreview(); return; }
    try {
      const r = await fetch(url('geo', item));
      if (!r.ok) throw new Error((await r.json()).error);
      const bytes = await r.arrayBuffer(); if (seq !== sequence) return;
      await ctx.previewOutput(item, bytes, update);
      ctx.message(item.label);
    } catch (e) { if (seq === sequence) ctx.message(e.message, 'err'); }
  };
  P.scene = () => {
    sequence++; initial = false; ctx.rememberOutputView?.(selected); selected = null; P.active = null;
    image.hide(); ctx.isolated = false; showDetails(null); render(); ctx.restoreScene();
  };
  P.refresh = async () => {
    if (refreshing) { refreshAgain = true; return refreshing; }
    refreshing = (async () => {
      try {
        const response = await fetch('/api/outputs'), j = await response.json(); if (!response.ok) throw new Error(j.error);
        directory = j.directory; const signature = JSON.stringify(j.items);
        if (signature === lastList) return;
        lastList = signature; const before = P.active; list = j.items;
        const after = list.find((v) => v.id === selected); render();
        if (after && (after.revision !== before?.revision || after.status !== before?.status)) await P.select(after.id, true);
        else if (after) { P.active = after; showDetails(after); }
        else if (selected && !after) P.scene();
        else if (initial && list.length) { initial = false; const main = list.find((v) => v.generated && !v.parent); if (main) await P.select(main.id); }
      } catch (e) { ctx.message(e.message, 'err'); }
      finally { refreshing = null; if (refreshAgain) { refreshAgain = false; void P.refresh(); } }
    })();
    return refreshing;
  };
  document.getElementById('tab-outputs').onclick = () => tabs(true);
  document.getElementById('tab-outliner').onclick = () => tabs(false);
  function tabs(outputs) {
    host.hidden = !outputs; document.getElementById('tree').hidden = outputs;
    document.getElementById('tab-outputs').classList.toggle('on', outputs); document.getElementById('tab-outliner').classList.toggle('on', !outputs);
  }
  document.getElementById('scene-view').onclick = P.scene;
  const picker = document.getElementById('image-file');
  document.getElementById('open-image').onclick = () => picker.click();
  picker.onchange = () => { ctx.layers.upload([...picker.files], []); picker.value = ''; };
  P.openInput = async (path) => { await P.refresh(); const item = list.find((v) => v.label === path && v.summary === 'Reference image'); if (item) P.select(item.id); };

  exportButton.onclick = () => exportDialog();
  function exportDialog() {
    const current = P.active; if (!current?.exportable || current.status !== 'ready') return;
    const dialog = document.createElement('dialog'); dialog.className = 'export-dialog';
    dialog.innerHTML = `<form><h2>Export output</h2><p class="export-target"></p><label>Name <input name="filename" required></label>
      <label>Format <select name="format"></select></label><p class="format-note"></p><p class="export-dir"></p>
      <label><input type="checkbox" name="replace"> Replace existing files</label><details><summary>Advanced options</summary><div class="export-options"></div></details>
      <p class="export-error err" role="alert"></p><footer><button type="button" data-close>Cancel</button><button type="submit">Export</button></footer></form>`;
    document.body.append(dialog); const form = dialog.querySelector('form'), select = form.elements.format, options = dialog.querySelector('.export-options');
    dialog.querySelector('.export-target').textContent = current.label;
    form.elements.filename.value = current.label.replace(/[\\/<>:"|?*]/g, '_');
    dialog.querySelector('.export-dir').textContent = 'Save to ' + directory;
    for (const [group, ids] of Object.entries(FORMAT_GROUPS)) { if (current.kind === 'image' && group !== 'Textures') continue; const optgroup = document.createElement('optgroup'); optgroup.label = group; for (const id of ids) optgroup.append(new Option(id === 'textures' ? 'PNG textures' : id.toUpperCase(), id)); select.append(optgroup); }
    select.value = current.kind === 'image' ? 'textures' : 'glb';
    const input = (key, label, type, value, choices) => {
      const row = document.createElement('label'); row.textContent = label + ' '; let el;
      if (choices) { el = document.createElement('select'); for (const c of choices) el.append(new Option(c, c)); el.value = value; }
      else { el = document.createElement('input'); el.type = type; if (type === 'checkbox') el.checked = value; else el.value = value; }
      el.name = key; if (type === 'number') el.step = 'any'; row.append(el); options.append(row);
    };
    const rebuild = () => {
      options.replaceChildren(); const f = select.value; dialog.querySelector('.format-note').textContent = FORMAT_NOTES[f];
      if (!['textures', 'png16', 'r16', 'mask_png', 'unreal_landscape'].includes(f)) { input('up_axis', 'Up axis', '', 'y', ['y', 'z']); input('scale', 'Scale', 'number', 1); }
      if (['glb', 'gltf', 'usda', 'geo'].includes(f)) input('instancing', 'Instances', '', 'packed', ['packed', 'expand']);
      if (['glb', 'gltf'].includes(f)) { input('split_by_name', 'Separate named meshes', 'checkbox', true); input('materials', 'Materials', 'checkbox', true); input('custom_attribs', 'Custom attributes', 'checkbox', true); input('compress', 'Compression', '', 'none', ['none', 'meshopt', 'draco']); input('quantize', 'Quantize', 'checkbox', false); }
      if (['csv', 'pointsjson'].includes(f)) {
        input('attributes', 'Attributes (comma separated)', 'text', ''); input('instances', 'Instances', '', 'rows', ['rows', 'expand']); input('meshes', 'Companion meshes', 'checkbox', true); input('pcg', 'Unreal PCG coordinates', 'checkbox', false); input('pcg_struct', 'Unreal DataTable cells', 'checkbox', false);
        const coordinates = () => { const pcg = form.elements.pcg.checked || form.elements.pcg_struct.checked; form.elements.scale.value = pcg ? 100 : 1; form.elements.up_axis.value = pcg ? 'z' : 'y'; };
        form.elements.pcg.onchange = coordinates; form.elements.pcg_struct.onchange = coordinates;
      }
      if (f === 'geo') input('precision', 'Precision', '', '64', ['32', '64']);
      if (['textures', 'mask_png', 'unreal_landscape'].includes(f)) input('layers', 'Extra layers (comma separated, * = all)', 'text', f === 'textures' ? '*' : '');
      if (['png16', 'r16', 'mask_png', 'unreal_landscape'].includes(f)) { input('heightfield', 'Heightfield index', 'number', 0); input('layer', 'Layer', 'text', f === 'mask_png' ? 'mask' : 'height'); input('height_min', 'Minimum height (auto if blank)', 'number', ''); input('height_max', 'Maximum height (auto if blank)', 'number', ''); }
      if (f === 'unreal_landscape') input('tile_size', 'Tile quads (0 = single)', 'number', 0);
    };
    select.onchange = rebuild; rebuild();
    const close = () => { dialog.close(); dialog.remove(); };
    dialog.querySelector('[data-close]').onclick = close; dialog.addEventListener('cancel', close);
    form.onsubmit = async (e) => {
      e.preventDefault(); const button = form.querySelector('[type="submit"]'), error = dialog.querySelector('.export-error'); button.disabled = true; error.textContent = '';
      const config = {};
      for (const el of options.querySelectorAll('input, select')) { if (el.type === 'checkbox') config[el.name] = el.checked; else if (el.value !== '') config[el.name] = el.type === 'number' || el.name === 'precision' ? Number(el.value) : ['layers', 'attributes'].includes(el.name) ? el.value.split(',').map((x) => x.trim()).filter(Boolean) : el.value; }
      try {
        const latest = list.find((item) => item.id === current.id);
        if (!latest || latest.status !== 'ready') throw new Error(latest?.error ?? 'Wait for this output to finish refreshing, then export again.');
        const r = await fetch('/api/output/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: latest.id, revision: latest.revision, name: form.elements.filename.value, format: select.value, replace: form.elements.replace.checked, options: config }) });
        const j = await r.json(); if (!r.ok) { if (r.status === 409) await P.refresh(); throw new Error(j.error); }
        close(); await P.refresh(); await P.select(j.id); ctx.message(j.summary + (j.warnings.length ? ' · ' + j.warnings.join('; ') : ''), j.warnings.length ? 'err' : 'ok', 6000);
      } catch (e) { error.textContent = e.message; button.disabled = false; }
    };
    dialog.showModal();
  }
  tabs(true);
  return P;
}
