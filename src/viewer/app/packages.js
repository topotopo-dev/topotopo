// The Packages tab (src/viewer/packages.ts serves it), shown while the project uses packages: a card per package with
// the version in use, its note and its outputs with their kinds and tags, the updates the project's libraries have (a
// small one, the newest version with the same big number, and a big one, a step of its own) with the notes of the newer
// versions, and, where the libraries hold its working folder, the follow switch, "Use the trees I'm editing": for this
// viewer's session the package cooks from its working folder and every save there cooks the scene again. A save there
// while the switch is off is offered through the status bar's question.
// Before/after cooks every place the project uses the package with the version in use (a) and the new one (b), its
// progress in the cook lines with their Stop; a place shows alone in the view as an output card does, as a, as b or
// both overlaid, and its details say what changed. Nothing changes until Update. A node of a package with an update
// carries a mark in the Scene tree (nodeMark). The plain functions are tested in Node (test/viewer-logic.ts).
import { api } from './api.js';
import { compareLine, fmtDuration } from './cooking.js';

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

/** The follow switch, in the package's own name: "Use the trees I'm editing". */
export const followLabel = (pkg) => `Use the ${pkg.slice(pkg.indexOf('/') + 1)} I'm editing`;

/** The day of an ISO time ("2026-10-28"), '' without one. */
export const day = (iso) => (typeof iso === 'string' ? iso.slice(0, 10) : '');

/** The libraries that hold a package, as its card names them: library "game", and TopoTopo's built-in library ("topotopo"). */
export const librariesText = (libs) => (libs ?? []).map((l) => (l === 'topotopo' ? 'TopoTopo\'s built-in library' : `library "${l}"`)).join(', ');

/**
 * An output of the version in use on a package's card: {name, kind, tags}; its name without the package ("pine"), or
 * "(default)" for the package's default output named by the package alone. kind '' when its record has none.
 */
export const outputLine = (pkg, o) => ({ name: o.type.startsWith(`${pkg}/`) ? o.type.slice(pkg.length + 1) : '(default)', kind: o.kind ?? '', tags: o.tags ?? [] });

/** "a small update", "a big update", "back to an older version", "back to an older big version" */
export const stepText = (t) => (t.big ? (t.up ? 'a big update' : 'back to an older big version') : t.up ? 'a small update' : 'back to an older version');

/**
 * What a package's card says about it: {kind, text, title}. kind: "followed" (it cooks from its working folder this
 * session), "error", "small" (a small update, maybe a big one too), "big" or "current" (up to date).
 */
export function packageState(p) {
  const ups = [p.small ? `small update ${p.small}` : '', p.big ? `big update ${p.big}` : ''].filter(Boolean);
  const updates = ups.length ? `${p.package} ${p.version} is in use: ${[p.small ? `${p.small} is the newest ${p.version.split('.')[0]}.x` : '', p.big ? `${p.big} is a big version, a step of its own` : ''].filter(Boolean).join('; ')}` : '';
  if (p.followed) {
    return {
      kind: 'followed', text: ['following its working folder', ...ups].join(' · '),
      title: `for this session ${p.package} cooks from ${p.followed.dir} (library "${p.followed.library}")${p.version ? ` instead of the copy of ${p.version}` : ''}; every save there cooks the scene again; nothing about it is saved${updates ? `\n${updates}` : ''}`,
    };
  }
  if (p.error) return { kind: 'error', text: p.error, title: p.error };
  if (!ups.length) return { kind: 'current', text: 'up to date', title: `${p.version} is the newest version in ${librariesText(p.libraries) || 'the project\'s libraries'}` };
  return { kind: p.small ? 'small' : 'big', text: ups.join(' · '), title: updates };
}

/**
 * The mark of a node in the Scene tree: {kind, text, title} when a package it names (its type, or in its nested graphs)
 * has an update ("↑ 1.3") or cooks from its working folder this session ("working"), else null. `rows`: the packages by
 * name.
 */
export function nodeMark(names, rows) {
  const ps = (names ?? []).map((n) => rows.get(n)).filter(Boolean);
  const late = ps.find((p) => p.small || p.big);
  if (late) {
    const v = late.small ?? late.big;
    const what = [late.small ? `${late.small} is a small update` : '', late.big ? `${late.big} ${late.small ? 'a big one' : 'is a big update'}` : ''].filter(Boolean).join(', ');
    return { package: late.package, kind: late.small ? 'small' : 'big', text: `↑ ${v}`, title: `${late.package} ${late.version} is in use: ${what} (click: its before/after in the Packages tab)${late.followed ? '; it cooks from its working folder this session' : ''}` };
  }
  const followed = ps.find((p) => p.followed);
  if (followed) return { package: followed.package, kind: 'followed', text: 'working', title: `${followed.package} cooks from its working folder this session (click: the switch in the Packages tab)` };
  return null;
}

/** A place's line in a before/after: {kind, text}; kind "changed", "same" or "failed". */
export function placeVerdict(c, t) {
  if (!c.before.ok && !c.after.ok) return { kind: 'failed', text: `does not cook with ${t.from} nor with ${t.to}` };
  if (!c.after.ok) return { kind: 'failed', text: `does not cook with ${t.to}` };
  if (!c.before.ok) return { kind: 'changed', text: `cooks with ${t.to} only` };
  if (!c.diff || c.diff.identical) return { kind: 'same', text: 'no change' };
  // the verdict without its asides: "shape changed by up to 50 cm" (the details have the whole diff)
  return { kind: 'changed', text: c.diff.verdict.replace(/ \([^)]*\)/g, '') || 'changed' };
}

/** A before/after in short, as the CLI says it: "1 of the 2 compared changed, 1 does not cook with 2.0". */
export function shortText(r) {
  const changed = r.places.filter((c) => c.diff && !c.diff.identical).length, failed = r.places.filter((c) => !c.after.ok).length;
  return `${changed} of the ${r.places.length} compared changed${failed ? `, ${failed} do${failed === 1 ? 'es' : ''} not cook with ${r.target.to}` : ''}`;
}

/** What a place shows first: the overlay where it changed, else b, else a; null when it cooked with neither. */
export const firstView = (c) => (c.views.overlay && c.diff && !c.diff.identical ? 'overlay' : c.views.b ? 'b' : c.views.a ? 'a' : null);

export function createPackagesPanel(ctx, host) {
  const P = { rows: new Map(), project: null, problems: [], running: null, result: null, ended: null };
  const tab = document.getElementById('tab-packages');
  /** the view each place was last shown as (a, b, overlay), by the id it has in the view */
  const views = new Map();
  const placeId = (r, c) => `compare:${r.id}:${c.index}`;
  /** The place in the view (the output panel's isolated result) is the row marked selected. */
  const markPlaces = () => { const id = ctx.outputs?.active?.id; for (const e of host.querySelectorAll('.pkg-place')) e.classList.toggle('sel', e.dataset.id === id); };
  ctx.on('output', markPlaces);
  let comparing = false, applying = false, asking = false;
  /** the packages whose offer the person turned down: not asked again in this page */
  const declined = new Set();

  // the progress of a before/after, kept across renders; its Stop is the viewer's Stop for it
  const line = el('div', 'cookline none'), lineText = el('span', 'ctext'), stopButton = el('button', 'cstop', 'Stop');
  stopButton.type = 'button';
  stopButton.title = 'stop the before/after at the next node; what was compared stays';
  stopButton.onclick = () => { stopButton.blur(); P.stop(); };
  line.append(el('span', 'cdot'), lineText, stopButton);
  /** The before/after line: its progress while it runs, then how it ended. */
  P.renderLine = () => {
    const r = P.running;
    let l;
    if (r) l = compareLine(r, performance.now() - r.at);
    else if (P.ended?.error) l = { kind: 'failed', text: P.ended.error, title: P.ended.error };
    else if (P.result) {
      const n = P.result.places.length;
      l = P.result.stopped
        ? { kind: 'stopped', text: `stopped after ${n} of ${P.result.comparisons} place${P.result.comparisons === 1 ? '' : 's'}`, title: 'the places not compared are not listed; Before/after compares them all again (what was cooked is reused)' }
        : { kind: 'ok', text: `compared ${n} place${n === 1 ? '' : 's'} in ${fmtDuration(P.result.ms)}`, title: 'each place cooked with both versions' };
    } else l = { kind: 'none', text: '', title: '' };
    line.className = `cookline ${l.kind}`;
    if (lineText.textContent !== l.text) lineText.textContent = l.text;
    line.title = l.title;
  };

  const button = (label, cls, title, action) => {
    const b = el('button', cls, label);
    b.type = 'button';
    b.title = title;
    b.onclick = () => { b.blur(); action(); };
    return b;
  };
  const list = (items, cls = '') => { const u = el('ul', `pkg-list ${cls}`); for (const x of items) u.append(el('li', '', x)); return u; };
  const versions = (title, rows) => {
    const box = el('div', 'pkg-versions');
    box.append(el('div', 'pkg-sub', title));
    for (const v of rows) {
      const r = el('div', 'pkg-v');
      r.append(el('span', 'pkg-vn', v.version), el('span', 'pkg-vd', day(v.published)), el('span', 'pkg-vt', v.note));
      if (v.big || v.marked) { const tag = el('span', 'pkg-tag', 'big'); tag.title = v.big ? `${v.version} is a big version: something a project relies on goes away or means something else` : 'its author marked it big'; r.append(tag); }
      box.append(r);
    }
    return box;
  };

  // ---------------------------------------------------------------- the cards
  function render() {
    const rows = [...P.rows.values()];
    const late = rows.filter((p) => p.small || p.big).length;
    // the tab shows while the project uses packages; its count turns the accent colour while one has an update
    ctx.setTabShown?.('packages', rows.length > 0);
    const count = tab.querySelector('.count');
    count.textContent = rows.length ? String(rows.length) : '';
    count.classList.toggle('late', late > 0);
    count.title = late ? `${late} of the ${rows.length} packages the project uses ${late === 1 ? 'has' : 'have'} an update` : `the project uses ${rows.length === 1 ? '1 package' : `${rows.length} packages`}`;
    const bar = el('div', 'packages-bar');
    if (P.project) {
      bar.append(el('span', 'dim', `${P.project.label} · libraries: ${[...P.project.libraries.filter((l) => l !== 'topotopo'), 'TopoTopo\'s built-in library'].join(', ')}`));
      bar.title = `${P.project.dir}: its project.json lists the libraries it finds packages in, and every project looks in TopoTopo's built-in library, which holds TopoTopo's own packages; the copies of the versions it uses are in packages/`;
    }
    const parts = [bar];
    if (P.problems.length) parts.push(list(P.problems, 'err'));
    for (const p of rows) parts.push(card(p));
    host.replaceChildren(...parts);
    // the cook lines show a before/after while it runs (main.js), and this card's line
    if (ctx.renderCook) ctx.renderCook(); else P.renderLine();
  }

  function card(p) {
    const box = el('div', 'pkg-card');
    box.dataset.package = p.package;
    const head = el('div', 'pkg-head');
    head.append(el('span', 'pkg-name', p.package), el('span', 'pkg-ver', p.version ?? 'working folder'));
    const st = packageState(p), state = el('div', `pkg-state ${st.kind}`, st.text);
    state.title = st.title;
    box.append(head, state);
    if (p.version && (p.note || p.published)) box.append(el('div', 'pkg-note', [day(p.published), p.note].filter(Boolean).join(' · ')));
    if (p.libraries?.length) box.append(el('div', 'pkg-note', `in ${librariesText(p.libraries)}`));
    // the outputs of the version in use: what each is, and its tags
    if (p.outputs?.length) {
      const outs = el('div', 'pkg-outs');
      for (const o of p.outputs) {
        const l = outputLine(p.package, o), r = el('div', 'pkg-out');
        r.title = `${o.type}${o.label ? ` (${o.label})` : ''}`;
        r.append(el('span', 'pkg-on', l.name));
        if (l.kind) { const k = el('span', 'pkg-kind', l.kind); k.title = 'what the output is'; r.append(k); }
        if (l.tags.length) r.append(el('span', 'pkg-otags', l.tags.join(', ')));
        outs.append(r);
      }
      box.append(outs);
    }
    const r = P.result?.target.package === p.package ? P.result : null;
    const running = P.running?.package === p.package ? P.running : null;
    // the newer versions' notes; a before/after lists those it goes over instead
    if (p.newer.length && !r && !running) box.append(versions('Newer versions', [...p.newer].reverse()));
    const acts = el('div', 'pkg-actions');
    const at = (v, big) => `cook every place the project uses ${p.package} with ${p.version} and with ${v}, and compare them${big ? `; ${v} is a big version, a step of its own: the before/after also says what the graphs must change` : ''}. Nothing changes until Update`;
    if (p.small) acts.append(button(`Before/after ${p.small}`, 'primary', at(p.small, false), () => P.compare(p.package, p.small)));
    if (p.big) acts.append(button(`Before/after ${p.big} (big)`, p.small ? '' : 'primary', at(p.big, true), () => P.compare(p.package, p.big)));
    for (const b of acts.children) b.disabled = comparing || applying;
    if (acts.children.length && !r && !running) box.append(acts);
    // a package whose libraries hold its versions alone (TopoTopo's own in an installed TopoTopo) has nothing to follow
    if (p.followed || p.working.length) box.append(followSwitch(p));
    if (p.mustChange) {
      const m = el('div', 'pkg-must');
      m.append(el('div', 'pkg-sub', `Updated to ${p.mustChange.to}: the project's graphs must change; until they do, they report these errors:`), list(p.mustChange.items, 'err'));
      m.append(button('Dismiss', '', 'hide this list (the nodes report their errors until the graphs change)', () => P.dismiss(p.package)));
      box.append(m);
    }
    if (r || running) box.append(compareBlock(p, r, running));
    return box;
  }

  function followSwitch(p) {
    const label = el('label', 'pkg-follow'), box = el('input');
    box.type = 'checkbox';
    box.checked = !!p.followed;
    const one = p.followed ?? (p.working.length === 1 ? p.working[0] : null);
    box.disabled = !one;
    label.title = one
      ? `for this session, cook ${p.package} from its working folder ${one.dir} (library "${one.library}") instead of ${p.version ? `the copy of ${p.version}` : 'a copy'}: every save there cooks the scene again. Nothing about it is saved; off goes back to the copy`
      : `${p.package} has a working folder in more than one library this project lists (${p.working.map((w) => w.dir).join(', ')}): following needs exactly one`;
    box.onchange = () => { box.blur(); P.follow(p.package, box.checked); };
    label.append(box, el('span', '', followLabel(p.package)));
    return label;
  }

  function compareBlock(p, r, running) {
    const b = el('div', 'pkg-compare');
    const t = r?.target ?? { ...running, up: true };
    b.append(el('div', 'pkg-ctitle', `Before/after ${t.from} → ${t.to} · ${r ? stepText(t) : t.big ? 'a big update' : 'a small update'}`), line);
    if (!r) return b;
    if (t.between.length) b.append(versions(t.up ? `The versions after ${t.from}` : 'The versions it goes back over', [...t.between].reverse()));
    if (t.big) {
      const step = t.up ? `${t.to} is a big version` : `Going back to ${t.to} crosses a big version`;
      b.append(el('div', 'pkg-sub', r.interfaceBig.length ? `${step}; what goes away or means something else:` : `${step}: nothing goes away between the two; a version between was marked big by its author (its note says why)`));
      if (r.interfaceBig.length) b.append(list(r.interfaceBig));
    }
    if (r.mustChange.length) b.append(el('div', 'pkg-sub err', 'What the project\'s graphs must change (Update is allowed; until they change, they report these errors):'), list(r.mustChange, 'err'));
    b.append(el('div', 'pkg-sub', r.uses.length
      ? `${r.uses.length === 1 ? '1 place uses' : `${r.uses.length} places use`} ${t.package}, ${r.uses.length === 1 ? '' : 'each '}cooked with ${t.from} (a) and with ${t.to} (b): click one to look at it`
      : `No graph of the project uses ${t.package}: the update changes no geometry`));
    for (const c of r.places) b.append(placeRow(r, c));
    if (r.places.length) b.append(el('div', 'pkg-sub', `In short: ${shortText(r)}`));
    if (r.stopped) b.append(el('div', 'pkg-sub', `Stopped after ${r.places.length} of ${r.comparisons}: the others are not compared. Before/after again compares them all, reusing what was cooked.`));
    if (r.problems.length) b.append(list(r.problems, 'err'));
    const acts = el('div', 'pkg-actions');
    const update = button(`Update to ${t.to}${t.big ? ' (big)' : ''}`, 'primary', `copy ${t.package} ${t.to} into the project, name it in project.json and the lock, delete the copies nothing uses any more, then cook the scene again`, () => P.update(r));
    update.disabled = applying || !!P.running;
    acts.append(update);
    if (r.stopped) acts.append(button('Before/after again', '', `compare every place again; what was cooked is reused`, () => P.compare(t.package, t.to)));
    acts.append(button('Close', '', 'close the before/after; nothing changes', () => P.close()));
    // values tuned over a graph file and not saved (topotopo view) are the viewer's, not the project's
    const tuned = ctx.graph.list.some((g) => g.overrides?.length);
    b.append(acts, el('div', 'hint', `Nothing has changed yet: the project uses ${t.package} ${t.from} until you click Update.${tuned ? ' The values tuned in this viewer and not saved play no part: the before/after compares the graphs as their files hold them, as Update changes them.' : ''}`));
    return b;
  }

  function placeRow(r, c) {
    const row = el('div', 'pkg-place'), v = placeVerdict(c, r.target);
    row.tabIndex = 0;
    row.append(el('span', 'pkg-pn', `${c.file} · ${c.node}`), el('span', `pkg-pv ${v.kind}`, v.text));
    row.title = `${c.uses.map((u) => `${u.node}: ${u.type}${u.set ? ` ${u.set}` : ''}`).join('\n')}\n${c.diff?.verdict || v.text}`;
    row.dataset.id = placeId(r, c);
    row.classList.toggle('sel', ctx.outputs?.active?.id === row.dataset.id);
    row.onclick = () => P.show(r, c);
    row.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); P.show(r, c); } };
    return row;
  }

  // ---------------------------------------------------------------- a place in the view
  /** Show a place of a before/after alone in the view, as a (the version in use), b (the new one) or both overlaid. */
  P.show = (r, c, view = views.get(placeId(r, c)) ?? firstView(c)) => {
    if (!c.views[view]) view = firstView(c);
    if (!view) { ctx.message(`${c.file} ${c.node} does not cook with either version: ${c.after.errors[0] ?? c.before.errors[0] ?? 'no geometry'}`, 'err'); return; }
    const id = placeId(r, c), same = ctx.outputs.active?.id === id;
    views.set(id, view);
    const t = r.target, said = { a: `a, with ${t.package} ${t.from}`, b: `b, with ${t.package} ${t.to}`, overlay: `a and b overlaid: grey the same, blue only with ${t.to}, orange only with ${t.from}` }[view];
    // the same place keeps its camera when it switches between a, b and the overlay
    ctx.outputs.isolate({
      id, label: `${c.file} · ${c.node}`, view: 'model', status: 'ready', revision: view, message: `${c.file} · ${c.node}: ${said}`,
      load: async () => { const g = await api.compareGeo(r.id, c.index, view); if (!g.ok) throw new Error(g.error); return g.buf; },
      details: (d) => details(d, r, c, view),
    }, same);
    markPlaces();
  };

  /** A place's details beside the view: what it uses, a / b / overlay, what changed. */
  function details(d, r, c, view) {
    const t = r.target;
    d.append(el('p', 'dim', c.uses.map((u) => `${u.node}: ${u.type}${u.set ? ` ${u.set}` : ''}`).join('\n')));
    const seg = el('div', 'pkg-views');
    for (const [k, label, title] of [['a', `a · ${t.from}`, `cooked with ${t.package} ${t.from}, the version in use`], ['b', `b · ${t.to}`, `cooked with ${t.package} ${t.to}`], ['overlay', 'overlay', `both: grey where they are the same, blue only with ${t.to}, orange only with ${t.from}`]]) {
      const b = button(label, k === view ? 'on' : '', c.views[k] ? title : k === 'overlay' ? 'no overlay: it needs points cooked with both versions' : `it does not cook with ${k === 'a' ? t.from : t.to}`, () => P.show(r, c, k));
      b.disabled = !c.views[k];
      seg.append(b);
    }
    d.append(seg);
    if (view === 'overlay') {
      const lg = el('div', 'pkg-legend');
      for (const [cls, text] of [['same', 'the same'], ['b', `only with ${t.to}`], ['a', `only with ${t.from}`]]) lg.append(el('span', `sw ${cls}`), el('span', '', text));
      d.append(lg);
    }
    if (!c.before.ok) d.append(el('p', 'err', `with ${t.from} it does not cook: ${c.before.errors.join('; ') || 'no geometry'}`));
    if (!c.after.ok) d.append(el('p', 'err', `with ${t.to} it does not cook: ${c.after.errors.join('; ') || 'no geometry'}`));
    if (c.diff) d.append(el('pre', 'summary', c.diff.text.split('\n').slice(1).join('\n')));
    if (c.notes.length) d.append(el('p', 'dim', `(${c.notes.join('; ')})`));
  }

  /** Back to the scene when the view shows a place of a before/after. */
  const leavePlace = () => { if (String(ctx.outputs.active?.id ?? '').startsWith('compare:')) ctx.outputs.scene(); };

  // ---------------------------------------------------------------- what the person does
  P.compare = async (pkg, to) => {
    if (comparing || applying) return;
    const p = P.rows.get(pkg);
    leavePlace();
    comparing = true;
    P.result = null; P.ended = null;
    P.running = { id: '', package: pkg, from: p?.version ?? '', to, big: to === p?.big, done: 0, total: 0, what: 'starting', elapsed: 0, running: true, stopping: false, at: performance.now() };
    render();
    ctx.message(`before/after: ${pkg} ${p?.version ?? ''} → ${to}; the cook line shows how far it is`, 'busy');
    const j = await api.compare(pkg, to);
    comparing = false;
    // a newer before/after took its place: that one answers
    if (j.status === 409) return;
    if (P.running?.package === pkg) P.running = null;
    if (!j.ok) { P.ended = { package: pkg, error: j.error }; ctx.message(j.error, 'err', 10000); render(); return; }
    P.result = j;
    ctx.message(`before/after of ${pkg} ${j.target.from} → ${j.target.to}: ${j.stopped ? `stopped after ${j.places.length} of ${j.comparisons} places` : shortText(j)}; nothing has changed yet`, j.stopped ? '' : 'ok', 6000);
    render();
  };
  P.stop = async () => {
    if (P.running) { P.running.stopping = true; P.renderLine(); }
    const j = await api.stopCompare();
    if (!j.ok) ctx.message(j.error, 'err');
    else ctx.message(j.stopping ? 'stopping the before/after: the node cooking runs to its end' : 'no before/after is running');
  };
  P.close = () => { leavePlace(); P.result = null; P.ended = null; render(); };
  P.update = async (r) => {
    const t = r.target;
    applying = true;
    render();
    ctx.message(`updating ${t.package} ${t.from} → ${t.to}…`, 'busy');
    const j = await api.updatePackage(t.package, t.from, t.to);
    applying = false;
    if (!j.ok) { ctx.message(j.error, 'err', 10000); render(); return; }
    // done with the before/after: the scene cooks again with the new version
    leavePlace();
    P.result = null; P.ended = null;
    ctx.message(`${j.text.split('\n')[0]}${j.mustChange.length ? ' · the graphs must change: the Packages tab lists what' : ''}`, j.mustChange.length ? 'err' : 'ok', 8000);
    await P.refresh();
  };
  P.follow = async (pkg, on) => {
    const j = await api.followPackage(pkg, on);
    ctx.message(j.ok ? j.text : j.error, j.ok ? 'ok' : 'err', j.ok ? 6000 : 10000);
    await P.refresh();
  };
  P.dismiss = async (pkg) => {
    const j = await api.dismissPackage(pkg);
    if (!j.ok) ctx.message(j.error, 'err');
    await P.refresh();
  };

  // ---------------------------------------------------------------- the server's news
  P.refresh = ctx.coalesce(async () => {
    const s = await api.packages();
    if (!s) return;
    P.project = s.project;
    P.problems = s.problems ?? [];
    P.rows = new Map((s.packages ?? []).map((p) => [p.package, p]));
    // a before/after another page started (or one running before a reload) shows its progress here too
    if (s.running && !P.running) P.running = { ...s.running, at: performance.now() };
    render();
    ctx.emit('packages');
  });
  /** {packages: n, saved?}: what the tab shows changed; `saved`: a working folder the session does not follow was saved. */
  P.onEvent = async (ev) => {
    await P.refresh();
    if (ev.saved) offer(ev.saved);
  };
  /** {compare: progress}: a before/after moved on, or ended. */
  P.onCompare = async (pr) => {
    const start = !P.running || (P.running.id && P.running.id !== pr.id);
    if (pr.running) { P.running = { ...pr, at: performance.now() }; if (start) render(); else P.renderLine(); return; }
    // this page's own before/after ends with its answer (P.compare)
    if (comparing) return;
    if (P.running?.id === pr.id) P.running = null;
    // one another page started: its result is read here
    if (!pr.superseded && !pr.error && P.result?.id !== pr.id) {
      const j = await api.lastCompare();
      if (j.compare?.id === pr.id) P.result = j.compare;
    }
    render();
  };
  async function offer(pkg) {
    const p = P.rows.get(pkg);
    if (!p || p.followed || declined.has(pkg) || asking || p.working.length !== 1 || !document.getElementById('ask').hidden) return;
    asking = true;
    const yes = await ctx.ask(`${pkg} was saved in its working folder. Use the ${pkg.slice(pkg.indexOf('/') + 1)} you are editing, for this session?`, 'Yes', 'Not now');
    asking = false;
    if (yes) { await P.follow(pkg, true); return; }
    declined.add(pkg);
    ctx.message(`${pkg}: the scene keeps the copy of ${p.version}; the Packages tab has the switch, "${followLabel(pkg)}"`);
  }

  /** The Scene tree's mark of a node (/api/graphs names the packages each node names). */
  P.nodeMark = (n) => nodeMark(n.packages, P.rows);
  /** The Packages tab, at a package's card (a click on a node's mark). */
  P.reveal = (pkg) => {
    ctx.showTab?.('packages');
    host.querySelector(`.pkg-card[data-package="${CSS.escape(pkg)}"]`)?.scrollIntoView({ block: 'nearest' });
  };
  return P;
}
