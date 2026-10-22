import { defaultExportSettings, resolveExport, exportStem } from './export-config.js';

const GROUPS = { 'Mesh / scene': ['glb', 'gltf', 'obj', 'usda', 'stl', 'ply'], 'Geometry / data': ['geo', 'json', 'csv', 'pointsjson'], Terrain: ['png16', 'r16', 'mask_png', 'unreal_landscape'], Textures: ['textures'] };
const NOTES = {
  glb: 'One file with material textures embedded.', gltf: 'glTF scene with embedded resources.', obj: 'Mesh, normals and UVs. This exporter omits materials and textures.',
  usda: 'USD scene with generated textures beside it.', stl: 'Triangles only; no materials, textures or UVs.', ply: 'Geometry and vertex attributes; no texture files.',
  geo: 'Houdini geometry, attributes and groups.', json: 'Lossless TopoTopo geometry, separate from the editable graph.', csv: 'Point/instance data with optional companion meshes.', pointsjson: 'Point/instance data with optional companion meshes.',
  png16: '16-bit heightmap with import settings.', r16: 'RAW heightmap with import settings.', mask_png: 'PNG weight layers.', unreal_landscape: 'Landscape, layers, meshes and import manifest.', textures: 'PNG images and selected extra layers.',
};
const element = (tag, value, cls) => { const e = document.createElement(tag); if (value) e.textContent = value; if (cls) e.className = cls; return e; };
const clone = (v) => structuredClone(v);
async function request(route, body) {
  const r = await fetch('/api/output/' + route, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json(); if (!r.ok) throw new Error(j.error); return j;
}
const extension = (format) => ({ textures: '/', unreal_landscape: '/', png16: '.png', mask_png: '.png', pointsjson: '.points.json' })[format] ?? '.' + format;
const destination = (directory, config) => [directory, config.subfolder, config.name + (config.name.toLowerCase().endsWith(extension(config.format)) ? '' : extension(config.format))].filter(Boolean).join('/');

/** Controls are independent of preview selection. All persistence goes through the project settings store. */
export function createExportUI(ctx, { items, directory, refresh, changed }) {
  let settings = defaultExportSettings(), loaded = false, busy = false, pending = Promise.resolve(), dirty = 0;
  const bar = element('div', '', 'output-export-bar'), quick = element('button', 'Export (0)', 'primary'), gear = element('button', '⚙');
  quick.id = 'export-output'; gear.id = 'export-settings'; gear.title = 'Project export settings'; gear.setAttribute('aria-label', gear.title); quick.disabled = gear.disabled = true;
  bar.append(quick, gear);
  const selected = () => items().filter((v) => v.exportable && settings.checked.includes(v.id));
  const sync = () => { quick.textContent = busy ? 'Exporting…' : `Export (${selected().length})`; quick.disabled = !loaded || busy || !selected().length; gear.disabled = !loaded || busy; quick.title = 'Export checked outputs using saved settings; replace existing files'; };
  const update = () => { sync(); changed(); };
  async function save(next) {
    settings = next; dirty++; update();
    const snapshot = clone(next);
    const task = pending.catch(() => {}).then(() => request('settings', snapshot)); pending = task;
    try { await task; }
    catch (e) { if (settings === next) { try { settings = await request('settings'); } catch { loaded = false; } } throw e; }
    finally { if (pending === task) pending = Promise.resolve(); dirty--; update(); }
  }
  async function reload() {
    if (dirty || busy) return;
    try { const next = await request('settings'); if (!dirty) { settings = next; loaded = true; update(); } }
    catch (e) { loaded = false; update(); ctx.message(e.message, 'err'); }
  }
  function ensureName(next, item) {
    if (next.destinations[item.id]) return;
    const used = new Set(Object.values(next.destinations).map((s) => s.toLowerCase()));
    const stem = exportStem(item.label); let name = stem, n = 2;
    while (used.has(name.toLowerCase())) name = `${stem}_${n++}`;
    next.destinations[item.id] = name;
  }
  async function check(item, on) {
    if (!loaded || busy) return;
    const next = clone(settings); next.checked = next.checked.filter((id) => id !== item.id);
    if (on) { next.checked.push(item.id); ensureName(next, item); }
    try { await save(next); } catch (e) { ctx.message(e.message, 'err'); }
  }
  async function batch() {
    if (busy || !selected().length) return;
    busy = true; update(); ctx.message('Preparing all checked outputs…', 'busy');
    try {
      await pending;
      const result = await request('export-batch', { ids: selected().map((v) => v.id) });
      await refresh();
      const warnings = result.results.flatMap((r) => r.warnings);
      ctx.message(`Exported ${result.results.length} output${result.results.length === 1 ? '' : 's'}` +(warnings.length ? ' · ' + warnings.join('; ') : ''), warnings.length ? 'err' : 'ok', 7000);
    } catch (e) { ctx.message(e.message, 'err', 10000); }
    finally { busy = false; update(); }
  }
  quick.onclick = () => settings.initialized ? batch() : dialog('setup');
  gear.onclick = () => dialog('defaults');

  async function reset(item) {
    const next = clone(settings); delete next.overrides[item.id];
    try { await save(next); } catch (e) { ctx.message(e.message, 'err'); }
  }
  function dialog(mode, item) {
    if (!loaded || busy || document.querySelector('.export-dialog')) return;
    const project = mode === 'defaults' || mode === 'setup', temporary = mode === 'once';
    const draft = clone(settings), targets = mode === 'setup' ? selected() : item ? [item] : [];
    for (const target of targets) ensureName(draft, target);
    let profile = 'geometry', format = '', optionDraft = {}, temporaryConfig = item ? resolveExport(draft, item) : null;
    const trigger = document.activeElement, modal = element('dialog', '', 'export-dialog');
    modal.setAttribute('aria-labelledby', 'export-dialog-title');
    modal.innerHTML = `<form><header><h2 id="export-dialog-title"></h2><p class="export-scope"></p></header>
      <div class="export-scroll"><label class="export-field profile-row"><span>Defaults for</span><select name="profile"><option value="geometry">Geometry</option><option value="image">Images</option></select></label>
      <section><h3>Destination</h3><label class="export-field name-row"><span>Filename</span><input name="filename" required></label>
      <label class="export-field"><span>Subfolder</span><input name="subfolder" placeholder="Project exports folder"></label><p class="export-dir"></p>
      <div class="export-targets"></div><label class="export-check replace-row"><input type="checkbox" name="replace" checked><span>Replace existing files</span></label></section>
      <section><h3>Format</h3><label class="export-field"><span>File format</span><select name="format"></select></label><p class="format-note"></p></section>
      <details><summary>Advanced options</summary><div class="export-options"></div></details></div>
      <footer><div class="export-error err" role="alert"></div><div class="export-actions"><button type="button" data-reset>Reset to project defaults</button><span class="grow"></span><button type="button" data-close>Cancel</button><button type="submit" class="primary"></button></div></footer></form>`;
    document.body.append(modal);
    const form = modal.querySelector('form'), fields = form.elements, options = modal.querySelector('.export-options'), submit = form.querySelector('[type=submit]');
    modal.querySelector('h2').textContent = ({ defaults: 'Project export settings', setup: 'Set up export', override: 'Output export settings', once: 'Export once' })[mode];
    modal.querySelector('.export-scope').textContent = project ? 'Defaults apply to outputs without an override.' : `${item.label} · ${temporary ? 'Changes apply only to this export.' : 'Changed values override project defaults for this output.'}`;
    modal.querySelector('.profile-row').hidden = !project;
    modal.querySelector('.name-row').hidden = project; fields.filename.required = !project;
    modal.querySelector('.replace-row').hidden = !temporary;
    const resetButton = modal.querySelector('[data-reset]'); resetButton.hidden = mode !== 'override';
    submit.textContent = mode === 'setup' ? 'Save & export' : temporary ? 'Export' : 'Save settings';
    const close = () => { modal.close(); modal.remove(); trigger?.focus(); };
    modal.querySelector('[data-close]').onclick = close; modal.addEventListener('cancel', (e) => { e.preventDefault(); if (!submit.disabled) close(); });

    const readOptions = () => {
      const values = {};
      for (const el of options.querySelectorAll('input,select')) {
        if (el.type === 'checkbox') values[el.name] = el.checked;
        else if (el.value !== '') values[el.name] = el.type === 'number' || el.name === 'precision' ? Number(el.value) : ['layers', 'attributes'].includes(el.name) ? el.value.split(',').map((v) => v.trim()).filter(Boolean) : el.value;
      }
      return values;
    };
    const collect = () => {
      if (!format) return;
      optionDraft[format] = readOptions();
      if (project) Object.assign(draft.defaults[profile], { format, subfolder: fields.subfolder.value, formats: clone(optionDraft) });
      else if (temporary) Object.assign(temporaryConfig, { name: fields.filename.value, subfolder: fields.subfolder.value, format, options: optionDraft[format] });
      else {
        draft.destinations[item.id] = fields.filename.value;
        const base = draft.defaults[item.kind === 'image' ? 'image' : 'geometry'], override = { formats: {} };
        if (format !== base.format) override.format = format;
        if (fields.subfolder.value !== base.subfolder) override.subfolder = fields.subfolder.value;
        for (const [f, opts] of Object.entries(optionDraft)) {
          const differences = Object.fromEntries(Object.entries(opts).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(base.formats[f]?.[key] ?? optionDefault(f, key))));
          if (Object.keys(differences).length) override.formats[f] = differences;
        }
        if (!Object.keys(override.formats).length) delete override.formats;
        if (Object.keys(override).length) draft.overrides[item.id] = override; else delete draft.overrides[item.id];
      }
    };
    const showPaths = () => {
      modal.querySelector('.export-dir').textContent = project ? directory() + (fields.subfolder.value ? '/' + fields.subfolder.value : '') : destination(directory(), { name: fields.filename.value, subfolder: fields.subfolder.value, format });
      for (const target of targets) {
        const row = modal.querySelector(`[data-target="${target.id}"]`);
        if (row) row.querySelector('small').textContent = destination(directory(), resolveExport(draft, target));
      }
    };
    const input = (key, label, type, value, choices) => {
      const row = element('label', '', type === 'checkbox' ? 'export-check' : 'export-field'); let el;
      if (choices) { el = element('select'); for (const choice of choices) el.append(new Option(choice, choice)); }
      else { el = element('input'); el.type = type; if (type === 'number') el.step = 'any'; }
      el.name = key; const saved = optionDraft[format]?.[key];
      if (type === 'checkbox') el.checked = saved ?? value; else el.value = Array.isArray(saved) ? saved.join(', ') : saved ?? value;
      if (type === 'checkbox') row.append(el, element('span', label)); else row.append(element('span', label), el);
      options.append(row);
    };
    const rebuild = () => {
      options.replaceChildren(); modal.querySelector('.format-note').textContent = NOTES[format];
      for (const [key, label, type, value, choices] of optionFields(format)) input(key, label, type, value, choices);
      if (fields.pcg) {
        const coordinates = () => { const pcg = fields.pcg.checked || fields.pcg_struct.checked; fields.scale.value = pcg ? 100 : 1; fields.up_axis.value = pcg ? 'z' : 'y'; };
        fields.pcg.onchange = coordinates; fields.pcg_struct.onchange = coordinates;
      }
      showPaths();
    };
    const load = () => {
      const config = project ? draft.defaults[profile] : temporary ? temporaryConfig : resolveExport(draft, item);
      const kind = project ? profile : item.kind;
      format = config.format;
      if (project) optionDraft = clone(config.formats);
      else if (temporary) { if (!Object.keys(optionDraft).length) optionDraft[format] = clone(config.options); }
      else {
        const base = draft.defaults[kind === 'image' ? 'image' : 'geometry'];
        optionDraft = clone(base.formats);
        for (const [f, values] of Object.entries(draft.overrides[item.id]?.formats ?? {})) optionDraft[f] = { ...optionDraft[f], ...values };
      }
      fields.filename.value = config.name ?? ''; fields.subfolder.value = config.subfolder;
      fields.format.replaceChildren();
      for (const [group, ids] of Object.entries(GROUPS)) {
        if (kind === 'image' && group !== 'Textures') continue;
        const optgroup = element('optgroup'); optgroup.label = group;
        for (const id of ids) optgroup.append(new Option(id === 'textures' ? 'PNG textures' : id.toUpperCase(), id)); fields.format.append(optgroup);
      }
      fields.format.value = format; rebuild();
    };
    const targetsHost = modal.querySelector('.export-targets'); targetsHost.hidden = mode !== 'setup';
    if (mode === 'setup') for (const target of targets) {
      const row = element('div', '', 'export-target'); row.dataset.target = target.id;
      const label = element('label', '', 'export-field'), name = element('input'); name.value = draft.destinations[target.id]; name.required = true;
      label.append(element('span', target.label), name); row.append(label, element('small'));
      name.oninput = () => { draft.destinations[target.id] = name.value; showPaths(); }; targetsHost.append(row);
    }
    fields.format.onchange = () => { collect(); format = fields.format.value; rebuild(); collect(); showPaths(); };
    fields.profile.onchange = () => { collect(); profile = fields.profile.value; load(); };
    fields.filename.oninput = fields.subfolder.oninput = () => { collect(); showPaths(); };
    resetButton.onclick = () => { delete draft.overrides[item.id]; load(); };
    form.onsubmit = async (event) => {
      event.preventDefault(); collect(); submit.disabled = true; const error = modal.querySelector('.export-error'); error.textContent = '';
      try {
        await pending;
        if (temporary) {
          await refresh(); const current = items().find((v) => v.id === item.id);
          if (!current || current.status !== 'ready') throw new Error(current?.error ?? 'Output is refreshing. Try again when it is ready.');
          const result = await request('export', { id: item.id, revision: current.revision, ...temporaryConfig, replace: fields.replace.checked });
          await refresh(); ctx.message(result.summary + (result.warnings.length ? ' · ' + result.warnings.join('; ') : ''), 'ok', 7000);
        } else {
          if (mode === 'setup') draft.initialized = true;
          await save(draft);
        }
        close(); if (mode === 'setup') await batch();
      } catch (e) { error.textContent = e.message; submit.disabled = false; }
    };
    load(); modal.showModal();
  }
  return { bar, sync, reload, check, reset, dialog, isChecked: (item) => settings.checked.includes(item.id), hasOverride: (item) => !!settings.overrides[item.id], get ready() { return loaded && !busy; } };
}

function optionFields(f) {
  const fields = [], add = (...args) => fields.push(args);
  if (!['textures', 'png16', 'r16', 'mask_png', 'unreal_landscape'].includes(f)) { add('up_axis', 'Up axis', '', 'y', ['y', 'z']); add('scale', 'Scale', 'number', 1); }
  if (['glb', 'gltf', 'usda', 'geo'].includes(f)) add('instancing', 'Instances', '', 'packed', ['packed', 'expand']);
  if (['glb', 'gltf'].includes(f)) {
    add('split_by_name', 'Separate named meshes', 'checkbox', true); add('materials', 'Materials', 'checkbox', true); add('custom_attribs', 'Custom attributes', 'checkbox', true);
    add('compress', 'Compression', '', 'none', ['none', 'meshopt', 'draco']); add('quantize', 'Quantize', 'checkbox', false);
  }
  if (['csv', 'pointsjson'].includes(f)) {
    add('attributes', 'Attributes (comma separated)', 'text', ''); add('instances', 'Instances', '', 'rows', ['rows', 'expand']); add('meshes', 'Companion meshes', 'checkbox', true);
    add('pcg', 'Unreal PCG coordinates', 'checkbox', false); add('pcg_struct', 'Unreal DataTable cells', 'checkbox', false);
  }
  if (f === 'geo') add('precision', 'Precision', '', '64', ['32', '64']);
  if (['textures', 'mask_png', 'unreal_landscape'].includes(f)) add('layers', 'Extra layers (* = all)', 'text', f === 'textures' ? '*' : '');
  if (['png16', 'r16', 'mask_png', 'unreal_landscape'].includes(f)) {
    add('heightfield', 'Heightfield index', 'number', 0); add('layer', 'Layer', 'text', f === 'mask_png' ? 'mask' : 'height');
    add('height_min', 'Minimum height (blank = auto)', 'number', ''); add('height_max', 'Maximum height (blank = auto)', 'number', '');
  }
  if (f === 'unreal_landscape') add('tile_size', 'Tile quads (0 = single)', 'number', 0);
  return fields;
}
function optionDefault(format, key) {
  const field = optionFields(format).find((f) => f[0] === key); if (!field) return undefined;
  if (['layers', 'attributes'].includes(key)) return field[3] ? field[3].split(',') : undefined;
  return key === 'precision' ? Number(field[3]) : field[3] === '' ? undefined : field[3];
}
