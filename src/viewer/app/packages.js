// The Packages tab (src/viewer/packages.ts serves it), in every project: the project's name, Find packages (a search of
// TopoTopo's kits and every library's packages, which says whether the project can use each), and a box per package
// the project uses. A box says the package's name, the version in use and its state as a badge (up to date, update
// available, live); its source, as a two-way switch naming both states, "Published 1.1 | Live folder", where the
// package has a working folder of its own (TopoTopo's kits only inside TopoTopo's own repository): Published is the
// frozen copy, Live shows the folder's edits as they are saved, for this session; the nodes that use it (a click shows
// that node); its outputs, folded, as aligned rows of name, kind and tags, marked where the project uses them; and,
// only when a newer version exists, Update. A save in a working folder the session does not follow is offered in that
// package's box, in words that do not assume the person is its author; using the switch, Not now or Update clears it.
// Update first runs the before/after: every place the project uses the package cooks with the version in use (a) and
// the new one (b); a place shows alone in the view as an output card does, as a, as b or both overlaid (the switch
// over the view), and says in one line what changed, its details folded. Nothing changes until the person confirms in
// the box; a big version whose graphs must change asks once more and gives a line to copy for the agent. A node of a
// package with an update or a live folder carries a mark in the Scene tree (nodeMark); its click opens the box.
// The plain functions are tested in Node (test/viewer-logic.ts).
import { api } from './api.js';
import { compareLine, fmtDuration } from './cooking.js';

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

/** The day of an ISO time ("2026-10-28"), '' without one. */
export const day = (iso) => (typeof iso === 'string' ? iso.slice(0, 10) : '');

/** The libraries that hold a package, as a box names them: library "game", and TopoTopo's built-in library ("topotopo"). */
export const librariesText = (libs) => (libs ?? []).map((l) => (l === 'topotopo' ? 'TopoTopo\'s built-in library' : `library "${l}"`)).join(', ');

/**
 * An output of the version in use in a package's box: {name, kind, tags, used}; its name without the package ("pine"),
 * or "(default)" for the package's default output named by the package alone. kind '' when its record has none.
 */
export const outputLine = (pkg, o) => ({ name: o.type.startsWith(`${pkg}/`) ? o.type.slice(pkg.length + 1) : '(default)', kind: o.kind ?? '', tags: o.tags ?? [], used: !!o.used });

/** "a small update", "a big update", "back to an older version", "back to an older big version" */
export const stepText = (t) => (t.big ? (t.up ? 'a big update' : 'back to an older big version') : t.up ? 'a small update' : 'back to an older version');

/**
 * A package's state as its box's badge says it: {kind, text, title}. kind "live" (it shows its working folder's edits
 * this session, said even when an update exists), "error", "update" (a newer version exists) or "current".
 */
export function packageState(p) {
  const ups = [p.small ? `${p.small} is the newest ${p.version.split('.')[0]}.x` : '', p.big ? `${p.big} is a big version, a step of its own` : ''].filter(Boolean);
  const updates = ups.length ? `${p.package} ${p.version} is in use: ${ups.join('; ')}` : '';
  if (p.followed) {
    return {
      kind: 'live', text: 'live',
      title: `this session shows the edits of ${p.followed.dir} (library "${p.followed.library}")${p.version ? ` instead of the published copy of ${p.version}` : ''}; every save there cooks the scene again; nothing about it is saved${updates ? `\n${updates}` : ''}`,
    };
  }
  if (p.error) return { kind: 'error', text: 'not found', title: p.error };
  if (!ups.length) return { kind: 'current', text: 'up to date', title: `${p.version} is the newest version in ${librariesText(p.libraries) || 'the project\'s libraries'}` };
  return { kind: 'update', text: 'update available', title: updates };
}

/** A folder by its last two names ("lib/crates"): the box has little room; its title has the whole path. */
export const shortDir = (dir) => String(dir ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).slice(-2).join('/');

/** What the source switch says under it: the published copy, or the live folder. */
export function sourceText(p) {
  if (p.followed) return `showing edits from ${shortDir(p.followed.dir)} as they are saved · exports use these edits too, marked unpublished · this session only`;
  return p.version ? `the published copy of ${p.version}: it changes only when you update` : 'not published yet: only its folder exists';
}

/** The offer after a save in the working folder of a package the session does not follow; it does not assume the reader made it. */
export const savedOffer = (pkg) => `${pkg} has new edits in its working folder that are not published yet. Show them here for this session?`;

/**
 * The mark of a node in the Scene tree: {package, kind, text, title} when a package it names (its type, or in its nested
 * graphs) shows its live folder this session ("live", said first) or has an update ("↑ 1.3"), else null. `rows`: the
 * packages by name.
 */
export function nodeMark(names, rows) {
  const ps = (names ?? []).map((n) => rows.get(n)).filter(Boolean);
  const live = ps.find((p) => p.followed);
  if (live) return { package: live.package, kind: 'live', text: 'live', title: `${live.package}: this session shows the unpublished edits of its working folder${live.small || live.big ? `; ${live.small ?? live.big} is out` : ''} (click: its box in the Packages tab)` };
  const late = ps.find((p) => p.small || p.big);
  if (late) {
    const v = late.small ?? late.big;
    const what = [late.small ? `${late.small} is a small update` : '', late.big ? `${late.big} ${late.small ? 'a big one' : 'is a big update'}` : ''].filter(Boolean).join(', ');
    return { package: late.package, kind: 'update', text: `↑ ${v}`, title: `${late.package} ${late.version} is in use: ${what} (click: its box in the Packages tab)` };
  }
  return null;
}

/** A length that changed: metres from 1 m, centimetres under it ("1.62 m", "36 cm", "under 1 cm"). */
export function fmtChange(m) {
  if (!Number.isFinite(m)) return '';
  if (m >= 1) return `${+m.toFixed(2)} m`;
  if (m >= 0.01) return `${Math.round(m * 100)} cm`;
  return 'under 1 cm';
}

/** A place's line in a before/after: {kind, text}; kind "changed", "same" or "failed". */
export function placeVerdict(c, t) {
  if (!c.before.ok && !c.after.ok) return { kind: 'failed', text: `does not cook with ${t.from} nor with ${t.to}` };
  if (!c.after.ok) return { kind: 'failed', text: `does not cook with ${t.to}` };
  if (!c.before.ok) return { kind: 'changed', text: `cooks with ${t.to} only` };
  if (!c.diff || c.diff.identical) return { kind: 'same', text: 'no change' };
  const v = c.diff.verdict ?? '';
  // the shape: by how much, in metres or centimetres; the other verdicts without their asides
  if (/^shape changed/.test(v) && Number.isFinite(c.diff.hausdorff)) return { kind: 'changed', text: `shape changed by up to ${fmtChange(c.diff.hausdorff)}${/topology differs/.test(v) ? ', and its faces differ' : ''}` };
  return { kind: 'changed', text: v.replace(/ \([^)]*\)/g, '') || 'changed' };
}

/** An update in a line: "2 places: 1 does not cook with 2.0, 1 changes, …", or that nothing changes. */
export function shortText(r) {
  const n = r.places.length, failed = r.places.filter((c) => !c.after.ok).length;
  const changed = r.places.filter((c) => c.after.ok && (!c.before.ok || (c.diff && !c.diff.identical))).length, same = n - failed - changed;
  if (!n) return `no graph of the project uses ${r.target.package}: nothing changes`;
  if (!changed && !failed) return `nothing changes in the ${n === 1 ? 'place' : `${n} places`} the project uses it`;
  const parts = [failed ? `${failed} ${failed === 1 ? 'does' : 'do'} not cook with ${r.target.to}` : '', changed ? `${changed} change${changed === 1 ? 's' : ''}` : '', same ? `${same} ${same === 1 ? 'stays' : 'stay'} the same` : ''];
  return `${n} place${n === 1 ? '' : 's'}: ${parts.filter(Boolean).join(', ')}`;
}

/** The line a person gives their agent for a big update whose graphs must change. */
export const agentLine = (r, project) => `update ${r.target.package} to ${r.target.to}${project ? ` in ${project}` : ''} and fix: ${r.mustChange.join('; ')}`;

/** What a place shows first: the overlay where it changed, else b, else a; null when it cooked with neither. */
export const firstView = (c) => (c.views.overlay && c.diff && !c.diff.identical ? 'overlay' : c.views.b ? 'b' : c.views.a ? 'a' : null);

/** The nodes that use a package, in short: "main › row, main › one", the graph left out when there is one. */
export const usedByText = (uses, oneGraph) => uses.map((u) => (oneGraph ? u.node : `${u.graph} › ${u.node}`)).join(', ');

export function createPackagesPanel(ctx, host) {
  const P = { rows: new Map(), project: null, problems: [], running: null, result: null, ended: null, loaded: false };
  const tab = document.getElementById('tab-packages');
  /** the view each place was last shown as (a, b, overlay), by the id it has in the view */
  const views = new Map();
  const placeId = (r, c) => `compare:${r.id}:${c.index}`;
  /** The place in the view (the output panel's isolated result) is the row marked selected. */
  const markPlaces = () => { const id = ctx.outputs?.active?.id; for (const e of host.querySelectorAll('.pkg-place')) e.classList.toggle('sel', e.dataset.id === id); };
  ctx.on('output', markPlaces);
  let comparing = false, applying = false;
  /** per package: a save in its working folder offered (until used or turned down), Update done in this page, confirming a big update */
  const offers = new Set(), updated = new Map(), confirming = new Set();
  /** the outputs lists the person opened, Find packages' words and its result */
  const open = new Set();
  let query = '', found = null, searchSeq = 0;

  // the progress of an update's comparison, kept across renders; the status bar's Stop stops it (one Stop)
  const line = el('div', 'cookline none'), lineText = el('span', 'ctext');
  line.append(el('span', 'cdot'), lineText);
  /** The before/after line: its progress while it runs, then how it ended. */
  P.renderLine = () => {
    const r = P.running;
    let l;
    if (r) l = compareLine(r, performance.now() - r.at);
    else if (P.ended?.error) l = { kind: 'failed', text: P.ended.error, title: P.ended.error };
    else if (P.result) {
      const n = P.result.places.length;
      l = P.result.stopped
        ? { kind: 'stopped', text: `stopped after ${n} of ${P.result.comparisons} place${P.result.comparisons === 1 ? '' : 's'}`, title: 'the places not compared are not listed; Compare again compares them all (what was cooked is reused)' }
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
  const fold = (summary, body, isOpen = false, ontoggle) => { const d = el('details', 'pkg-fold'); d.open = isOpen; d.append(el('summary', '', summary), body); if (ontoggle) d.ontoggle = () => ontoggle(d.open); return d; };
  const versions = (rows) => {
    const box = el('div', 'pkg-versions');
    for (const v of rows) {
      const r = el('div', 'pkg-v');
      r.append(el('span', 'pkg-vn', v.version), el('span', 'pkg-vd', day(v.published)), el('span', 'pkg-vt', v.note));
      if (v.big || v.marked) { const tag = el('span', 'pkg-tag', 'big'); tag.title = v.big ? `${v.version} is a big version: something a project relies on goes away or means something else` : 'its author marked it big'; r.append(tag); }
      box.append(r);
    }
    return box;
  };
  const copyBox = (text, label = 'Copy') => {
    const box = el('div', 'pkg-copy'), field = el('input');
    field.readOnly = true; field.value = text; field.setAttribute('aria-label', 'line for your agent');
    const b = button(label, '', 'copy this line, then give it to your agent', async () => {
      field.select();
      try { await navigator.clipboard.writeText(text); } catch { document.execCommand('copy'); }
      b.textContent = 'Copied'; setTimeout(() => { b.textContent = label; }, 1500);
    });
    box.append(field, b);
    return box;
  };

  // ---------------------------------------------------------------- the tab
  const bar = el('div', 'packages-bar'), head = el('div', 'pkg-project'), search = el('input', 'pkg-search'), results = el('div', 'pkg-found');
  search.type = 'search'; search.placeholder = 'Find packages: tree, lamp, crate…'; search.setAttribute('aria-label', 'Find packages');
  search.title = 'search TopoTopo\'s kits and every library\'s packages by name, kind and tag';
  let searchTimer = 0;
  search.oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => runSearch(search.value), 200); };
  search.onkeydown = (e) => { if (e.key === 'Escape') { search.value = ''; runSearch(''); search.blur(); } };
  bar.append(head, search);
  const cardsBox = el('div', 'pkg-cards');
  results.hidden = true;
  host.replaceChildren(bar, results, cardsBox);

  async function runSearch(q) {
    query = q.trim();
    const seq = ++searchSeq;
    if (!query) { found = null; renderFound(); return; }
    const j = await api.searchPackages(query);
    if (seq !== searchSeq) return;
    found = j;
    renderFound();
  }
  /** Find packages' result: each output found, its kind and tags, whether the project uses it or can. */
  function renderFound() {
    results.hidden = !found;
    if (!found) { results.replaceChildren(); return; }
    if (!found.ok && found.error) { results.replaceChildren(el('div', 'err', found.error)); return; }
    const parts = [];
    const libs = (found.libraries ?? []).filter((l) => l.hits.length);
    if (!libs.length) parts.push(el('div', 'pkg-sub', `Nothing found for "${query}". TopoTopo's kits hold walls, houses, roofs, stairs, rocks, trees, props and roads.`));
    for (const l of libs) {
      parts.push(el('div', 'pkg-libhead', l.standing === 'builtin' ? 'TopoTopo\'s kits' : `library "${l.name}"${l.standing === 'unlisted' ? ' · not listed in this project' : ''}`));
      for (const h of l.hits.slice(0, 40)) {
        const row = el('div', 'pkg-hit');
        const name = el('code', '', h.type), kind = h.kind ? el('span', 'badge kind', h.kind) : null, tags = el('span', 'pkg-tags line');
        for (const t of h.tags) tags.append(el('span', 'tag', t));
        const state = h.used ? `in use (${h.used})` : h.self ? 'this project' : l.standing === 'unlisted' ? `its project.json would list library "${l.name}"` : 'ready to use';
        row.append(name, ...(kind ? [kind] : []), el('span', 'pkg-hitstate dim', state), tags);
        row.title = `${h.type}${h.label ? ` (${h.label})` : ''}${h.description ? `: ${h.description}` : ''}${h.tags.length ? `\ntags: ${h.tags.join(', ')}` : ''}\nTo use it, ask your agent: use ${h.type}`;
        row.append(button('Copy name', 'pkg-hitcopy', `copy ${h.type}: your agent uses it as a node type`, async () => {
          try { await navigator.clipboard.writeText(h.type); ctx.message(`copied ${h.type}: ask your agent to use it`, 'ok'); } catch { ctx.message(h.type); }
        }));
        parts.push(row);
      }
      if (l.hits.length > 40) parts.push(el('div', 'pkg-sub', `and ${l.hits.length - 40} more: add words to narrow it`));
    }
    results.replaceChildren(...parts);
  }

  // ---------------------------------------------------------------- the boxes
  function render() {
    const rows = [...P.rows.values()];
    const late = rows.filter((p) => p.small || p.big).length, live = rows.filter((p) => p.followed).length;
    // in every project: Find packages works without packages too
    ctx.setTabShown?.('packages', !!P.project);
    const count = tab.querySelector('.count');
    count.textContent = rows.length ? String(rows.length) : '';
    count.classList.toggle('late', late > 0);
    count.classList.toggle('live', live > 0 && !late);
    count.title = [late ? `${late} of the ${rows.length} packages the project uses ${late === 1 ? 'has' : 'have'} an update` : `the project uses ${rows.length === 1 ? '1 package' : `${rows.length} packages`}`, live ? `${live} live this session` : ''].filter(Boolean).join('; ');
    if (P.project) {
      head.replaceChildren(el('strong', '', P.project.title || P.project.id), el('span', 'dim', ` · ${rows.length ? `${rows.length} package${rows.length === 1 ? '' : 's'} in use` : 'no packages yet'}`));
      head.title = `${P.project.dir}\nThe project finds packages in TopoTopo's built-in library${P.project.libraries.length ? ` and in ${P.project.libraries.map((l) => `"${l}"`).join(', ')} (project.json "libraries")` : ''}; the copies of the versions it uses are in packages/.`;
    }
    const parts = [];
    if (P.problems.length) parts.push(list(P.problems, 'err'));
    if (P.project?.package) parts.push(authorBox());
    if (!rows.length && P.project) {
      const e = el('div', 'pkg-empty');
      e.append(el('p', '', 'This project uses no packages yet.'), el('p', 'dim', 'Packages are ready-made parts: TopoTopo\'s kits (houses, walls, trees, rocks, props, roads) and your team\'s libraries. Find one above, then ask your agent to use it, for example: "add topotopo/street/lamp_post along the road".'));
      parts.push(e);
    }
    for (const p of rows) parts.push(card(p));
    cardsBox.replaceChildren(...parts);
    // the cook lines show a before/after while it runs (main.js), and this box's line
    if (ctx.renderCook) ctx.renderCook(); else P.renderLine();
  }

  function card(p) {
    const box = el('div', `pkg-card${p.followed ? ' live' : ''}`);
    box.dataset.package = p.package;
    const st = packageState(p);
    const h = el('div', 'pkg-head'), badge = el('span', `pkg-state ${st.kind}`, st.text);
    badge.title = st.title;
    h.append(el('span', 'pkg-name', p.package), el('span', 'pkg-ver', p.version ?? '—'), badge);
    box.append(h);
    if (p.version && (p.note || p.published)) box.append(el('div', 'pkg-note', [day(p.published), p.note].filter(Boolean).join(' · ')));
    if (p.error) box.append(el('div', 'pkg-sub err', p.error));
    // where it comes from: the published copy, or the live folder (the switch names both)
    if (p.canFollow) box.append(sourceSwitch(p));
    else box.append(el('div', 'pkg-note', p.kit ? `${p.version ? `version ${p.version}` : 'not published'} from TopoTopo's kits` : sourceText(p)));
    // a save in its working folder, offered here (cleared by the switch, Not now or Update)
    if (offers.has(p.package) && !p.followed) {
      const o = el('div', 'pkg-offer');
      o.append(el('div', '', savedOffer(p.package)));
      const acts = el('div', 'pkg-actions');
      acts.append(button('Show live edits', 'primary', `show the edits of ${p.working[0]?.dir ?? 'its working folder'} for this session; exports use them too, marked unpublished`, () => P.follow(p.package, true)),
        button('Not now', '', 'keep the published copy; the switch above does it later', () => { offers.delete(p.package); render(); }));
      o.append(acts);
      box.append(o);
    }
    // where the project uses it: a click shows that node
    if (p.usedBy?.length) {
      const graphs = new Set(p.usedBy.map((u) => u.graph)), u = el('div', 'pkg-used');
      u.append(el('span', 'dim', 'Used by '));
      for (const x of p.usedBy) {
        const b = button(graphs.size === 1 ? x.node : `${x.graph} › ${x.node}`, 'pkg-node', `show node ${x.node} of graph ${x.graph} (${x.type})`, () => ctx.showNode?.(x.graph, x.node));
        u.append(b);
      }
      box.append(u);
    } else if (p.version) box.append(el('div', 'pkg-note', 'No graph of the project uses it now.'));
    // its outputs, folded: aligned rows of name, kind and tags, marked where the project uses them
    if (p.outputs?.length) {
      const used = p.outputs.filter((o) => o.used).length;
      const grid = el('div', 'pkg-outs');
      for (const o of p.outputs) {
        const l = outputLine(p.package, o), tags = el('span', 'pkg-tags line');
        for (const t of l.tags) tags.append(el('span', 'tag', t));
        tags.title = l.tags.join(', ');
        const name = el('span', `pkg-on${l.used ? ' used' : ''}`, l.name);
        name.title = `${o.type}${o.label ? ` (${o.label})` : ''}${l.used ? ' · used by the project' : ''}`;
        grid.append(el('span', `pkg-in${l.used ? ' on' : ''}`, l.used ? '●' : ''), name, l.kind ? el('span', 'badge kind', l.kind) : el('span'), tags);
      }
      box.append(fold(`${p.outputs.length} output${p.outputs.length === 1 ? '' : 's'}${used ? ` · ${used} in use` : ''}`, grid, open.has(p.package), (on) => { if (on) open.add(p.package); else open.delete(p.package); }));
    }
    const r = P.result?.target.package === p.package ? P.result : null;
    const running = P.running?.package === p.package ? P.running : null;
    const done = updated.get(p.package);
    if (done && !r && !running) {
      const d = el('div', `pkg-done${done.mustChange?.length ? ' err' : ''}`, `Updated ${done.from} → ${done.to}${done.mustChange?.length ? ': the graphs must change, as listed below' : ': the scene cooked again with it'}.`);
      box.append(d);
    }
    // Update, only when a newer version exists: it first shows the before/after
    if ((p.small || p.big) && !r && !running) {
      if (p.newer.length) box.append(fold(`What is new since ${p.version}`, versions([...p.newer].reverse())));
      const acts = el('div', 'pkg-actions');
      const at = (v, big) => `see what changes where the project uses ${p.package} with ${v}, then confirm${big ? `; ${v} is a big version: it also says what the graphs must change` : ''}. Nothing changes before you confirm`;
      if (p.small) acts.append(button(`Update to ${p.small}…`, 'primary', at(p.small, false), () => P.compare(p.package, p.small)));
      if (p.big) acts.append(button(`Update to ${p.big} (big)…`, p.small ? '' : 'primary', at(p.big, true), () => P.compare(p.package, p.big)));
      for (const b of acts.children) b.disabled = comparing || applying;
      box.append(acts);
    }
    if (p.mustChange) {
      const m = el('div', 'pkg-must');
      m.append(el('div', 'pkg-sub', `Updated to ${p.mustChange.to}: the project's graphs must change; until they do, they report these errors:`), list(p.mustChange.items, 'err'));
      m.append(el('div', 'pkg-sub', 'Give your agent this line:'), copyBox(agentLine({ target: { package: p.package, to: p.mustChange.to }, mustChange: p.mustChange.items }, P.project?.id)));
      m.append(button('Dismiss', '', 'hide this list (the nodes report their errors until the graphs change)', () => P.dismiss(p.package)));
      box.append(m);
    }
    if (r || running) box.append(compareBlock(p, r, running));
    return box;
  }

  /** "Source: [Published 1.1] [Live folder]": the two states, the one in use pressed, and what it means under it. */
  function sourceSwitch(p) {
    const wrap = el('div', 'pkg-source'), row = el('div', 'pkg-switch'), seg = el('div', 'pkg-seg');
    seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', `Source of ${p.package}`);
    const one = p.followed ?? p.working[0];
    const pub = button(p.version ? `Published ${p.version}` : 'Published', p.followed ? '' : 'on', p.version ? `the published copy of ${p.version}: frozen, it changes only when you update` : `${p.package} has no published version yet`, () => { if (p.followed) P.follow(p.package, false); });
    const live = button('Live folder', p.followed ? 'on live' : '', `show the edits of ${one?.dir ?? 'its working folder'} as they are saved, for this session; exports use them too, marked unpublished`, () => { if (!p.followed) P.follow(p.package, true); });
    pub.disabled = !p.version && !p.followed;
    pub.setAttribute('aria-pressed', String(!p.followed)); live.setAttribute('aria-pressed', String(!!p.followed));
    seg.append(pub, live);
    row.append(el('span', 'dim', 'Source'), seg);
    const note = el('div', `pkg-note${p.followed ? ' live' : ''}`, sourceText(p));
    if (one) note.title = one.dir;
    wrap.append(row, note);
    return wrap;
  }

  /** In the package's own project: its last version, unpublished changes, and Check publish (the publish dry run). */
  let author = null, checking = false;
  function authorBox() {
    const box = el('div', 'pkg-card pkg-author'), name = P.project.package;
    const h = el('div', 'pkg-head');
    h.append(el('span', 'pkg-name', name), el('span', 'pkg-ver', author?.last ?? '—'), el('span', 'pkg-state author', 'this project'));
    box.append(h);
    if (!author) { box.append(el('div', 'pkg-note', '…')); return box; }
    box.append(el('div', 'pkg-note', author.last ? `Last published: ${author.last} · ${day(author.published)}${author.note ? ` · ${author.note}` : ''}` : 'Not published yet.'));
    box.append(el('div', `pkg-note${author.changed ? ' warn' : ''}`, author.changed === null ? '' : author.changed ? 'There are changes since the last version: publishing would make a new one.' : 'Nothing changed since the last version.'));
    const acts = el('div', 'pkg-actions');
    const b = button(checking ? 'Checking…' : 'Check publish', '', 'run every publishing check and cook every output, writing nothing: says the version it would get, what changed, and what blocks or warns', () => P.checkPublish());
    b.disabled = checking;
    acts.append(b);
    box.append(acts);
    const c = author.check;
    if (c) {
      const lines = [];
      lines.push(el('div', `pkg-sub ${c.ok ? 'ok' : 'err'}`, c.ok ? `It would publish ${c.version}${c.previous ? ` (after ${c.previous}${c.bigBecause?.length ? ', a big version' : ''})` : ' (the first version)'}.` : `It would not publish: ${c.blocks?.length === 1 ? 'one thing stops it' : `${c.blocks?.length ?? 0} things stop it`}.`));
      if (c.blocks?.length) lines.push(list(c.blocks, 'err'));
      if (c.bigBecause?.length) lines.push(fold('Why it is big', list(c.bigBecause)));
      if (c.changes?.length) lines.push(fold(`${c.changes.length} change${c.changes.length === 1 ? '' : 's'}`, list(c.changes)));
      if (c.warnings?.length) lines.push(fold(`${c.warnings.length} warning${c.warnings.length === 1 ? '' : 's'}`, list(c.warnings)));
      lines.push(el('div', 'pkg-note', 'Publishing itself is your agent\'s step (or topotopo publish --note "…" in the project folder).'));
      box.append(...lines);
    }
    return box;
  }

  function compareBlock(p, r, running) {
    const b = el('div', 'pkg-compare');
    const t = r?.target ?? { ...running, up: true };
    b.append(el('div', 'pkg-ctitle', `Update ${t.from} → ${t.to} · ${r ? stepText(t) : t.big ? 'a big update' : 'a small update'}`), line);
    if (!r) return b;
    // first the verdict, one line per place; the details folded
    b.append(el('div', `pkg-verdict ${r.places.some((c) => !c.after.ok) ? 'err' : ''}`, shortText(r)));
    for (const c of r.places) b.append(placeRow(r, c));
    if (r.places.length) b.append(el('div', 'pkg-note', 'Click a place to look at it in the view: a with the version in use, b with the new one, or both overlaid.'));
    if (r.stopped) b.append(el('div', 'pkg-sub', `Stopped after ${r.places.length} of ${r.comparisons}: the others are not compared.`));
    const more = el('div', 'pkg-more');
    if (t.between.length) more.append(el('div', 'pkg-sub', t.up ? `The versions after ${t.from}` : 'The versions it goes back over'), versions([...t.between].reverse()));
    if (t.big) {
      const step = t.up ? `${t.to} is a big version` : `Going back to ${t.to} crosses a big version`;
      more.append(el('div', 'pkg-sub', r.interfaceBig.length ? `${step}; what goes away or means something else:` : `${step}: nothing goes away between the two; a version between was marked big by its author (its note says why)`));
      if (r.interfaceBig.length) more.append(list(r.interfaceBig));
    }
    if (r.uses.length) more.append(el('div', 'pkg-sub', 'Where the project uses it:'), list(r.uses.map((u) => `${u.file} · ${u.node}: ${u.type}${u.set ? ` ${u.set}` : ''}`)));
    if (r.problems.length) more.append(list(r.problems, 'err'));
    b.append(fold('Details', more));
    if (r.mustChange.length) {
      b.append(el('div', 'pkg-sub err', `With ${t.to} the project's graphs must change; until they do, they report these errors:`), list(r.mustChange, 'err'));
      b.append(el('div', 'pkg-sub', 'Your agent can make these changes. Give it this line:'), copyBox(agentLine(r, P.project?.id)));
    }
    const acts = el('div', 'pkg-actions');
    if (confirming.has(t.package)) {
      b.append(el('div', 'pkg-sub warn', `Update anyway? The graphs keep reporting these errors until they change.`));
      const yes = button(`Yes, update to ${t.to}`, 'primary danger', `copy ${t.package} ${t.to} into the project and name it in project.json; the graphs report errors until they change`, () => P.update(r));
      yes.disabled = applying || !!P.running;
      acts.append(yes, button('Cancel', '', 'keep the version in use', () => { confirming.delete(t.package); render(); }));
    } else {
      const update = button(`Update to ${t.to}${t.big ? ' (big)' : ''}`, 'primary', `copy ${t.package} ${t.to} into the project, name it in project.json and the lock, then cook the scene again`, () => {
        if (r.mustChange.length) { confirming.add(t.package); render(); } else P.update(r);
      });
      update.disabled = applying || !!P.running;
      acts.append(update);
      if (r.stopped) acts.append(button('Compare again', '', 'compare every place again; what was cooked is reused', () => P.compare(t.package, t.to)));
      acts.append(button('Close', '', 'close it; nothing changes', () => P.close()));
    }
    // values tuned over a graph file and not saved (topotopo view) are the viewer's, not the project's
    const tuned = ctx.graph.list.some((g) => g.overrides?.length);
    b.append(acts, el('div', 'hint', `Nothing has changed yet: the project uses ${t.package} ${t.from} until you update.${tuned ? ' Values tuned in this viewer and not saved play no part.' : ''}`));
    return b;
  }

  function placeRow(r, c) {
    const row = el('div', 'pkg-place'), v = placeVerdict(c, r.target);
    row.tabIndex = 0;
    row.append(el('span', 'pkg-pn', `${c.file.replace(/^graphs\//, '').replace(/\.json$/, '')} › ${c.node}`), el('span', `pkg-pv ${v.kind}`, v.text));
    row.title = `${c.file} · ${c.node}\n${c.uses.map((u) => `${u.node}: ${u.type}${u.set ? ` ${u.set}` : ''}`).join('\n')}`;
    row.dataset.id = placeId(r, c);
    row.classList.toggle('sel', ctx.outputs?.active?.id === row.dataset.id);
    row.onclick = () => P.show(r, c);
    row.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); P.show(r, c); } };
    return row;
  }

  // ---------------------------------------------------------------- a place in the view
  /** The a / b / overlay switch over the view while it shows a place. */
  const viewSwitch = el('div', 'compare-switch');
  viewSwitch.hidden = true;
  document.getElementById('viewport').append(viewSwitch);
  function renderSwitch(r, c, view) {
    const t = r.target, parts = [];
    for (const [k, label, title] of [['a', `a · ${t.from}`, `cooked with ${t.package} ${t.from}, the version in use`], ['b', `b · ${t.to}`, `cooked with ${t.package} ${t.to}`], ['overlay', 'overlay', `both: grey where they are the same, blue only with ${t.to}, orange only with ${t.from}`]]) {
      const b = button(label, k === view ? 'on' : '', c.views[k] ? title : k === 'overlay' ? 'no overlay: it needs points cooked with both versions' : `it does not cook with ${k === 'a' ? t.from : t.to}`, () => P.show(r, c, k));
      b.disabled = !c.views[k];
      parts.push(b);
    }
    const legend = el('span', 'compare-legend');
    if (view === 'overlay') for (const [cls, text] of [['same', 'same'], ['b', `only ${t.to}`], ['a', `only ${t.from}`]]) legend.append(el('span', `sw ${cls}`), el('span', '', text));
    viewSwitch.replaceChildren(el('span', 'compare-what', `${c.node}: ${placeVerdict(c, t).text}`), ...parts, legend);
    viewSwitch.hidden = false;
  }
  const hideSwitch = () => { viewSwitch.hidden = true; };
  ctx.on('output', () => { if (!String(ctx.outputs?.active?.id ?? '').startsWith('compare:')) hideSwitch(); });

  /** Show a place of a before/after alone in the view, as a (the version in use), b (the new one) or both overlaid. */
  P.show = (r, c, view = views.get(placeId(r, c)) ?? firstView(c)) => {
    if (!c.views[view]) view = firstView(c);
    if (!view) { ctx.message(`${c.file} ${c.node} does not cook with either version: ${c.after.errors[0] ?? c.before.errors[0] ?? 'no geometry'}`, 'err'); return; }
    const id = placeId(r, c), same = ctx.outputs.active?.id === id;
    views.set(id, view);
    const t = r.target, said = { a: `a, with ${t.package} ${t.from}`, b: `b, with ${t.package} ${t.to}`, overlay: `a and b overlaid` }[view];
    // the same place keeps its camera when it switches between a, b and the overlay
    ctx.outputs.isolate({
      id, label: `${c.file} · ${c.node}`, view: 'model', status: 'ready', revision: view, message: `${c.node}: ${said}`, overlay: view === 'overlay',
      load: async () => { const g = await api.compareGeo(r.id, c.index, view); if (!g.ok) throw new Error(g.error); return g.buf; },
      details: (d) => details(d, r, c, view),
    }, same).then(() => { if (ctx.outputs.active?.id === id) renderSwitch(r, c, view); });
    markPlaces();
  };

  /** A place's details beside the view: its verdict, then what it uses and the whole comparison, folded. */
  function details(d, r, c, view) {
    const t = r.target, v = placeVerdict(c, t);
    d.append(el('p', `pkg-pv ${v.kind}`, v.text));
    if (!c.before.ok) d.append(el('p', 'err', `with ${t.from} it does not cook: ${c.before.errors.join('; ') || 'no geometry'}`));
    if (!c.after.ok) d.append(el('p', 'err', `with ${t.to} it does not cook: ${c.after.errors.join('; ') || 'no geometry'}`));
    d.append(el('p', 'dim', view === 'overlay' ? `Grey: the same · blue: only with ${t.to} · orange: only with ${t.from}` : view === 'a' ? `With ${t.package} ${t.from}, the version in use` : `With ${t.package} ${t.to}`));
    const more = el('div');
    more.append(el('p', 'dim', c.uses.map((u) => `${u.node}: ${u.type}${u.set ? ` ${u.set}` : ''}`).join('\n')));
    if (c.diff) more.append(el('pre', 'summary', c.diff.text.split('\n').slice(1).join('\n')));
    if (c.notes.length) more.append(el('p', 'dim', `(${c.notes.join('; ')})`));
    d.append(fold('Details', more));
  }

  /** Back to the scene when the view shows a place of a before/after. */
  const leavePlace = () => { hideSwitch(); if (String(ctx.outputs.active?.id ?? '').startsWith('compare:')) ctx.outputs.scene(); };

  // ---------------------------------------------------------------- what the person does
  P.compare = async (pkg, to) => {
    if (comparing || applying) return;
    const p = P.rows.get(pkg);
    leavePlace();
    comparing = true;
    offers.delete(pkg); updated.delete(pkg); confirming.delete(pkg);
    P.result = null; P.ended = null;
    P.running = { id: '', package: pkg, from: p?.version ?? '', to, big: to === p?.big, done: 0, total: 0, what: 'starting', elapsed: 0, running: true, stopping: false, at: performance.now() };
    render();
    const j = await api.compare(pkg, to);
    comparing = false;
    // a newer before/after took its place: that one answers
    if (j.status === 409) return;
    if (P.running?.package === pkg) P.running = null;
    if (!j.ok) { P.ended = { package: pkg, error: j.error }; ctx.message(j.error, 'err'); render(); return; }
    P.result = j;
    render();
    P.reveal(pkg, false);
  };
  P.stop = async () => {
    if (P.running) { P.running.stopping = true; P.renderLine(); }
    const j = await api.stopCompare();
    if (!j.ok) ctx.message(j.error, 'err');
  };
  /** Close the before/after: the view goes back to the scene, its messages go. */
  P.close = () => { leavePlace(); P.result = null; P.ended = null; confirming.clear(); ctx.message(''); render(); };
  P.update = async (r) => {
    const t = r.target;
    applying = true;
    render();
    const j = await api.updatePackage(t.package, t.from, t.to);
    applying = false;
    confirming.delete(t.package);
    if (!j.ok) { ctx.message(j.error, 'err'); render(); return; }
    // done with the before/after: the scene cooks again with the new version; the box says so
    leavePlace();
    P.result = null; P.ended = null;
    offers.delete(t.package);
    updated.set(t.package, { from: j.from, to: j.to, mustChange: j.mustChange });
    ctx.message('');
    await P.refresh();
  };
  P.follow = async (pkg, on) => {
    offers.delete(pkg);
    const j = await api.followPackage(pkg, on);
    if (!j.ok) ctx.message(j.error, 'err');
    await P.refresh();
  };
  P.dismiss = async (pkg) => {
    const j = await api.dismissPackage(pkg);
    if (!j.ok) ctx.message(j.error, 'err');
    updated.delete(pkg);
    await P.refresh();
  };
  P.checkPublish = async () => {
    if (checking) return;
    checking = true; render();
    const j = await api.checkPublish();
    checking = false;
    if (!j.ok && j.error) ctx.message(j.error, 'err');
    else author = { ...author, check: j.check };
    render();
  };

  // ---------------------------------------------------------------- the server's news
  P.refresh = ctx.coalesce(async () => {
    const s = await api.packages();
    if (!s) return;
    P.loaded = true;
    P.project = s.project;
    P.problems = s.problems ?? [];
    P.rows = new Map((s.packages ?? []).map((p) => [p.package, p]));
    for (const p of P.rows.values()) if (p.followed) offers.delete(p.package);
    // a before/after another page started (or one running before a reload) shows its progress here too
    if (s.running && !P.running) P.running = { ...s.running, at: performance.now() };
    if (s.project?.package) {
      const a = await api.authorState();
      if (a.ok) author = { ...a, check: author?.check ?? null };
    } else author = null;
    render();
    ctx.emit('packages');
  });
  /** {packages: n, saved?}: what the tab shows changed; `saved`: a working folder the session does not follow was saved. */
  P.onEvent = async (ev) => {
    if (ev.saved) { const p = P.rows.get(ev.saved); if (p?.canFollow && !p.followed) offers.add(ev.saved); }
    await P.refresh();
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

  /** The Scene tree's mark of a node (/api/graphs names the packages each node names). */
  P.nodeMark = (n) => nodeMark(n.packages, P.rows);
  /** The Packages tab, at a package's box, highlighted (a click on a node's mark). */
  P.reveal = (pkg, flash = true) => {
    ctx.showTab?.('packages');
    const box = host.querySelector(`.pkg-card[data-package="${CSS.escape(pkg)}"]`);
    if (!box) return;
    box.scrollIntoView({ block: 'nearest' });
    if (flash) { box.classList.remove('flash'); void box.offsetWidth; box.classList.add('flash'); setTimeout(() => box.classList.remove('flash'), 1600); }
  };
  render();
  return P;
}
