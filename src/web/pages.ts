// The web app's pages as plain HTML strings: the registered workspaces (the games), the grid of every library's
// packages (TopoTopo's built-in library among them), a package's page and the embed page. Pure functions of their data
// and a URL builder, so the local server (src/web/server.ts) and a static build can share them.
// Styles and the small page script are files: app/web.css and app/web.js here, app/embed.js in the viewer.

export interface Urls {
  home: string;
  package(lib: string, id: string): string;
  thumb(lib: string, id: string, version?: string | number): string;
  glb(lib: string, id: string, version?: string | number): string;
  embed(lib: string, id: string): string;
  file(lib: string, id: string, rel: string): string;
  /** null where there is no editor (a static build) */
  edit(lib: string, id: string): string | null;
  /** the web app's own files (web.css, web.js) */
  asset(name: string): string;
  /** the viewer's modules (embed.js, scene.js) */
  app(name: string): string;
  /** three.js: the import map's base for build/ and examples/jsm/ */
  three: string;
}

export interface CardData {
  lib: string; id: string; title: string; collection: string; tags: string[]; description: string; updated: number;
  /** 'ok' | 'failed' | 'baking' | 'new', or 'empty': the package has not the graph its manifest shows (nothing to bake yet) */
  status: string; version: string;
  /** a package: its full name and newest version (null before the first is published) */
  pkg?: { name: string; version: string | null };
  /** a package's outputs in its newest version, which the search finds by name, label, kind and tag */
  outputs?: { type: string; alias?: string; label: string; kind?: string; tags: string[] }[];
  /** the packages it uses (the search finds a package by them), and those with a newer version than the one in use */
  usesPackages?: string[];
  updates?: { name: string; version: string; newest: string }[];
}

/** A package that uses another, with the version it uses. */
export interface UserRow { lib: string; id: string; title: string; version: string; url: string }

export interface VarRow { name: string; value: unknown; desc?: string; min?: number; max?: number }
export interface FileRow { path: string; size: number; image: boolean }
/**
 * A published output: the node type a graph names it with ("owner/name/output"; `alias` "owner/name" for the default),
 * its kind and tags (none in a version published before TopoTopo recorded kinds), and its thumbnail when the package
 * keeps one (thumbs/<output>.png: TopoTopo's built-in packages do).
 */
export interface OutputRow { type: string; alias?: string; label: string; kind?: string; tags: string[]; graph: string; node: string; params: string[]; inputs: string[]; thumb?: string }
/** A published version: `big` when it starts a big version, `marked` when its author marked it big; its outputs. */
export interface VersionRow { version: string; note: string; published: string; big: boolean; marked: boolean; outputs?: OutputRow[] }
export interface PackageData extends CardData {
  /** one of TopoTopo's own packages (its built-in library): nothing to bake or edit here */
  builtin: boolean;
  rel: string;
  links: { label: string; url: string }[];
  graph: string;
  graphs: { name: string; nodes: number; vars: VarRow[] }[];
  attachments: FileRow[];
  exports: FileRow[];
  glb: boolean;
  bake: { at: number; ok: boolean; error?: string; ms?: number; glb?: boolean; points?: number; prims?: number; warnings?: string[] } | null;
  created: string;
  /** absolute URLs for the copy boxes (the board pastes them) */
  share: { link: string; thumb: string; embed: string };
  /** a package: its versions, newest first, the outputs of the newest, and the packages that use it */
  package: { name: string; versions: VersionRow[]; outputs: OutputRow[]; usedBy?: UserRow[] } | null;
  /** the packages it uses: the version in use and its note, the package's page and its newest version when newer */
  uses: { name: string; version: string; note?: string; published?: string; url?: string; newest?: string }[];
}

/**
 * A registered workspace (a game) on the front page: its engine project, the libraries its packages look in, its
 * packages (linked when a library of the web app holds them) and the packages it uses, those with a newer version marked.
 */
export interface WorkspaceCardData {
  name: string;
  dir: string;
  /** "Godot · game/project.godot · exports to res://assets/topotopo", or null */
  engine: string | null;
  libraries: string[];
  packages: { title: string; rel: string; url?: string; pkg?: string }[];
  uses: { name: string; version: string; url?: string; newest?: string }[];
  problems: string[];
}

/** The front page's data: every library's cards (`builtin`: TopoTopo's built-in library), the workspaces, the problems. */
export interface WebData { libraries: { name: string; cards: CardData[]; builtin?: boolean }[]; workspaces?: WorkspaceCardData[]; problems: string[] }

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 2 ** 20).toFixed(1)} MB`);
const when = (ms: number) => (ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '');
const STATUS: Record<string, string> = { ok: '', failed: 'bake failed', baking: 'baking…', new: 'not baked yet', empty: 'no default graph yet' };

function shell(title: string, u: Urls, body: string, opts: { page: string; data?: object }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="${esc(u.asset('web.css'))}">
<script type="module" src="${esc(u.asset('web.js'))}"></script>
</head>
<body data-page="${opts.page}"${opts.data ? ` data-json="${esc(JSON.stringify(opts.data))}"` : ''}>
${body}
</body>
</html>
`;
}

/** A package's full name and newest version, as the grid and a package page mark it. */
const pkgMark = (p: { name: string; version: string | null }) =>
  `<span class="pkg" title="${esc(`package ${p.name}${p.version ? `, newest version ${p.version}` : ', no version published yet'}`)}">${esc(p.name)}${p.version ? ` ${esc(p.version)}` : ''}</span>`;
const day = (iso: string) => (iso ? iso.slice(0, 10) : '');

/** An output's kind and tags as marks: the kind outlined, each tag a tag. */
const kindTagMarks = (o: { kind?: string; tags: string[] }) =>
  `${o.kind ? `<span class="kind" title="what the output is">${esc(o.kind)}</span>` : ''}${o.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}`;

/** The packages a package uses with a newer version: "ux/crates 1.2 is out". */
const updateMark = (ups: NonNullable<CardData['updates']>) =>
  `<span class="upd" title="${esc(ups.map((x) => `${x.name} ${x.version} is in use; ${x.newest} is out`).join('\n'))}">${esc(ups.length === 1 ? `update: ${ups[0].name} ${ups[0].newest}` : `${ups.length} updates`)}</span>`;

function card(c: CardData, u: Urls) {
  // the search finds a package by the packages it uses too
  const hay = [c.title, c.id, c.collection, c.description, ...c.tags, c.pkg?.name ?? '', ...(c.usesPackages ?? [])].join(' ').toLowerCase();
  // a package's outputs: the search shows those it finds by their name, label, kind or tags
  const outs = (c.outputs ?? []).map((o) => `<span class="out" hidden data-hay="${esc([o.type, o.alias ?? '', o.label, o.kind ?? '', ...o.tags].join(' ').toLowerCase())}"><code>${esc(o.type)}</code>${kindTagMarks(o)}</span>`).join('');
  return `<a class="card" href="${esc(u.package(c.lib, c.id))}" data-key="${esc(`${c.lib}/${c.id}`)}" data-hay="${esc(hay)}" data-tags="${esc(c.tags.join('\n'))}" data-collection="${esc(c.collection)}">
  <span class="thumb"><img src="${esc(u.thumb(c.lib, c.id, c.version))}" alt="" loading="lazy" width="512" height="512"></span>
  <span class="meta">
    <span class="title">${esc(c.title)}</span>
    <span class="sub">${c.collection ? `${esc(c.collection)} · ` : ''}${esc(c.id)}</span>
    ${c.pkg ? pkgMark(c.pkg) : ''}
    ${c.tags.length ? `<span class="tags">${c.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</span>` : ''}
    ${outs ? `<span class="outs">${outs}</span>` : ''}
    ${c.updates?.length ? updateMark(c.updates) : ''}
    <span class="status s-${esc(c.status)}">${esc(STATUS[c.status] ?? '')}</span>
  </span>
</a>`;
}

/**
 * The front page: the registered workspaces first, then every library's packages grouped by collection (TopoTopo's
 * built-in library last), with search and tag filters; packages are marked, and the search finds their outputs by
 * name, kind and tag too.
 */
export function frontPage(d: WebData, u: Urls): string {
  const ws = d.workspaces ?? [];
  const link = (title: string, url?: string) => (url ? `<a href="${esc(url)}">${esc(title)}</a>` : esc(title));
  const wsSection = ws.length ? `
  <section class="hub" id="workspaces">
    <h2>Workspaces <span class="count">${ws.length}</span></h2>
    <p class="dim small">The games your packages belong to: the libraries every package inside looks in, one copy of each package for the whole game, and the engine project exports go to.</p>
    ${ws.map((w) => `<article class="workspace" id="ws-${esc(w.name)}">
      <h3>${esc(w.name)}${w.engine ? ` <span class="dim small">${esc(w.engine)}</span>` : ''}</h3>
      <table class="vars ws"><tbody>
        <tr><th>Libraries</th><td>${w.libraries.length ? w.libraries.map(esc).join(', ') : '<span class="dim">none listed</span>'}</td></tr>
        <tr><th>Packages</th><td>${w.packages.length ? w.packages.map((p) => `${link(p.title, p.url)}${p.pkg ? ` <code>${esc(p.pkg)}</code>` : ''}`).join(', ') : '<span class="dim">none yet</span>'}</td></tr>
        <tr><th>Uses</th><td>${w.uses.length ? w.uses.map((x) => `${link(x.name, x.url)} ${esc(x.version)}${x.newest ? ` <span class="newer">${esc(x.newest)} is out</span>` : ''}`).join(', ') : '<span class="dim">none used yet</span>'}</td></tr>
      </tbody></table>
      ${w.problems.length ? `<ul class="dim small">${w.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
      <p class="dim small"><code>${esc(w.dir)}</code></p>
    </article>`).join('\n')}
  </section>` : '';
  const tags = [...new Set(d.libraries.flatMap((l) => l.cards.flatMap((c) => c.tags)))].sort();
  const total = d.libraries.reduce((n, l) => n + l.cards.length, 0);
  const outputs = d.libraries.reduce((n, l) => n + l.cards.reduce((k, c) => k + (c.outputs?.length ?? 0), 0), 0);
  const libs = d.libraries.map((l) => {
    const groups = new Map<string, CardData[]>();
    for (const c of l.cards) { const g = groups.get(c.collection) ?? []; g.push(c); groups.set(c.collection, g); }
    const sections = [...groups].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([coll, cards]) => `
    <section class="collection" data-collection="${esc(coll)}">
      ${coll ? `<h3>${esc(coll)}</h3>` : ''}
      <div class="grid">${cards.map((c) => card(c, u)).join('\n')}</div>
    </section>`).join('');
    // TopoTopo's built-in library: ready-made packages every package can use, by an output's name
    const example = l.builtin ? l.cards.flatMap((c) => c.outputs ?? []).find((o) => !o.alias)?.type : undefined;
    const note = l.builtin ? `
    <p class="note dim small">TopoTopo's built-in library: ready-made packages every package can use. Ask your agent to use an output by its name${example ? `, such as <code>${esc(example)}</code>` : ''}.</p>` : '';
    return `
  <section class="library" id="lib-${esc(l.name)}">
    <h2>${esc(l.name)} <span class="count" data-total="${l.cards.length}">${l.cards.length}</span></h2>${note}${sections || '<p class="empty">No packages yet. Make one with <code>topotopo library new ' + esc(l.name) + ' &lt;folder/name&gt;</code> or ask your agent to make one.</p>'}
  </section>`;
  }).join('');
  const none = d.libraries.some((l) => !l.builtin) ? '' : `<p class="empty">No libraries of your own yet. Add a folder with <code>topotopo library add &lt;name&gt; &lt;folder&gt;</code>.</p>`;
  return shell('TopoTopo', u, `<header class="bar">
  <a class="brand" href="${esc(u.home)}"><b>TopoTopo</b></a>
  <input id="search" type="search" placeholder="Search ${total} package${total === 1 ? '' : 's'}${outputs ? ` and ${outputs} output${outputs === 1 ? '' : 's'}` : ''}" autocomplete="off" aria-label="Search packages${outputs ? ' and their outputs' : ''}">
  <button id="clear" class="btn" type="button" hidden title="clear the search and the tags">Clear</button>
  <a class="news" href="https://topotopo.kit.com/54b6b32c3f" target="_blank" rel="noopener" title="releases and new packs, about once a month">Get TopoTopo news</a>
</header>
<main class="wrap">
${d.problems.length ? `<details class="problems"><summary>${d.problems.length} problem${d.problems.length > 1 ? 's' : ''} in the libraries</summary><ul>${d.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></details>` : ''}
${tags.length ? `<nav class="chips" aria-label="Tags">${tags.map((t) => `<button class="chip" data-tag="${esc(t)}" aria-pressed="false">${esc(t)}</button>`).join('')}</nav>` : ''}
${wsSection}${none}${libs}
<p class="empty" id="nomatch" hidden>Nothing matches. <button class="btn" type="button" data-clear>Clear the search</button></p>
</main>`, { page: 'front' });
}

function fileList(rows: FileRow[], lib: string, id: string, base: string, u: Urls) {
  return `<ul class="files">${rows.map((f) => `<li><a href="${esc(u.file(lib, id, `${base}/${f.path}`))}"${f.image ? '' : ' download'}>${esc(f.path)}</a><span>${size(f.size)}</span></li>`).join('')}</ul>`;
}

/** A package's versions with their notes and dates, and the outputs its newest version publishes with their kinds and tags. */
function packageSection(pk: NonNullable<PackageData['package']>): string {
  if (!pk.versions.length) return `<h2>Versions</h2><p class="dim">No version published yet: <code>topotopo publish --note "…"</code> in the package's folder publishes the first, which other packages can then use as <code>${esc(pk.name)}</code>.</p>`;
  const big = (v: VersionRow) => (v.big ? ' <span class="tag" title="something a package relies on goes away or means something else">big</span>' : v.marked ? ' <span class="tag" title="its author marked it big">big</span>' : '');
  const outputs = pk.outputs.map((o) => {
    const what = [`node "${o.node}" of graph "${o.graph}"`, o.params.length ? `params ${o.params.join(', ')}` : '', o.inputs.length ? `input${o.inputs.length > 1 ? 's' : ''} ${o.inputs.join(', ')}` : ''].filter(Boolean).join(' · ');
    const marks = kindTagMarks(o);
    return `<tr><th>${o.thumb ? `<img class="othumb" src="${esc(o.thumb)}" alt="" loading="lazy" width="96" height="96">` : ''}<code>${esc(o.type)}</code>${o.alias ? `<br><code>${esc(o.alias)}</code> <span class="dim">(the default)</span>` : ''}</th><td>${esc(o.label)}${marks ? `<span class="tags">${marks}</span>` : ''}</td><td class="dim">${esc(what)}</td></tr>`;
  }).join('');
  return `<h2>Versions <span class="count">${pk.versions.length}</span></h2>
    ${versionList(pk.versions, big)}
    <h2>Published outputs</h2>
    <table class="vars outputs"><tbody>${outputs}</tbody></table>
    <p class="dim small">The outputs of ${esc(pk.versions[0].version)}: a package's graph uses one as a node type, <code>{"type": "${esc(pk.outputs[0]?.type ?? pk.name)}"}</code>, with its params.</p>
    ${usedBySection(pk.usedBy ?? [])}`;
}

/** The versions, newest first: each opens to the outputs it published. */
function versionList(versions: VersionRow[], big: (v: VersionRow) => string) {
  return `<div class="versions">${versions.map((v, i) => `<details class="version" id="v-${esc(v.version)}"${i === 0 ? '' : ''}><summary><span class="vn">${esc(v.version)}</span>${big(v)}<span class="vd">${esc(day(v.published))}</span><span class="vt">${esc(v.note)}</span></summary>
      ${v.outputs?.length ? `<ul class="vouts">${v.outputs.map((o) => `<li><code>${esc(o.type)}</code>${o.label ? ` ${esc(o.label)}` : ''}${kindTagMarks(o) ? `<span class="tags">${kindTagMarks(o)}</span>` : ''}</li>`).join('')}</ul>` : '<p class="dim small">Its record lists no outputs.</p>'}
    </details>`).join('')}</div>`;
}

/** The packages of the libraries and the workspaces that use a package, each linked, with the version it uses. */
function usedBySection(users: UserRow[]) {
  return `<h2>Used by <span class="count">${users.length}</span></h2>${users.length
    ? `<table class="vars uses"><tbody>${users.map((x) => `<tr><th><a href="${esc(x.url)}">${esc(x.title)}</a></th><td>${esc(x.version)}</td><td class="dim">${esc(x.lib)}</td></tr>`).join('')}</tbody></table>`
    : '<p class="dim">No package in the libraries uses it yet.</p>'}`;
}

/** The packages a package uses: the version in use and its note, and when a newer one is out. */
function usesSection(uses: PackageData['uses']): string {
  if (!uses.length) return '';
  return `<h2>Packages it uses</h2>
    <table class="vars uses"><tbody>${uses.map((x) => `<tr><th>${x.url ? `<a href="${esc(x.url)}">${esc(x.name)}</a>` : esc(x.name)}</th><td>${esc(x.version)}</td><td class="dim">${esc([x.note, day(x.published ?? '')].filter(Boolean).join(' · '))}${x.newest ? ` <span class="newer">${esc(x.newest)} is out</span>` : ''}</td></tr>`).join('')}</tbody></table>`;
}

/**
 * A package's page: the 3D view, what it is, links, attachments, a package's versions and outputs, the packages it
 * uses, graphs and their vars, and the snippets for a board.
 */
export function packagePage(p: PackageData, u: Urls): string {
  const images = p.attachments.filter((f) => f.image), other = p.attachments.filter((f) => !f.image);
  const edit = u.edit(p.lib, p.id);
  const snippet = (label: string, value: string) => `<label class="copy"><span>${label}</span><input readonly value="${esc(value)}"><button type="button" data-copy>Copy</button></label>`;
  const b = p.status === 'empty' || p.builtin ? null : p.bake;
  const example = p.package?.outputs.find((o) => !o.alias)?.type;
  const bakeLine = p.builtin
    ? `One of TopoTopo's own packages: every package can use its outputs. Ask your agent to use one by its name${example ? `, such as ${example}` : ''}.`
    : p.status === 'empty'
    ? (p.graphs.length ? `No default graph yet: its manifest shows "${p.graph}", which this package does not have. Ask your agent to build it, or to show one of its graphs.` : 'No default graph yet: this package has no graphs. Ask your agent to build one; the preview appears here when it exists.')
    : !b ? 'Not baked yet.'
    : b.ok ? `Baked ${when(b.at)} in ${((b.ms ?? 0) / 1000).toFixed(1)} s · ${b.points ?? 0} points, ${b.prims ?? 0} prims${b.glb ? '' : ' · no 3D preview (too large)'}`
    : `Bake failed ${when(b.at)}`;
  const view = p.glb
    ? `<iframe class="view" src="${esc(u.embed(p.lib, p.id))}" title="${esc(p.title)} in 3D" allow="fullscreen"></iframe>`
    : `<img class="view" src="${esc(u.thumb(p.lib, p.id, p.version))}" alt="${esc(p.title)}">`;
  return shell(`${p.title} · TopoTopo`, u, `<header class="bar">
  <a class="brand" href="${esc(u.home)}"><b>TopoTopo</b></a>
  <nav class="crumbs"><a href="${esc(u.home)}#lib-${esc(p.lib)}">${esc(p.lib)}</a>${p.collection ? ` / <span>${esc(p.collection)}</span>` : ''} / <span>${esc(p.id)}</span></nav>
</header>
<main class="wrap package">
  <div class="stage">${view}</div>
  <aside class="info">
    <h1>${esc(p.title)}</h1>
    ${p.pkg ? `<p class="pkgline">Package ${pkgMark(p.pkg)}</p>` : ''}
    ${p.description ? `<p class="desc">${esc(p.description)}</p>` : ''}
    ${p.tags.length ? `<p class="tags">${p.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</p>` : ''}
    ${p.links.length ? `<ul class="links">${p.links.map((l) => `<li><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a></li>`).join('')}</ul>` : ''}
    <div class="actions">
      ${edit ? `<a class="btn primary" href="${esc(edit)}" target="_blank" rel="noopener">Open in editor</a>` : ''}
      ${p.builtin ? '' : '<button class="btn" type="button" data-post="bake">Re-bake</button>'}
      <button class="btn" type="button" data-post="reveal">Show folder</button>
    </div>
    <p class="bake ${b && !b.ok ? 'err' : ''}${p.status === 'empty' ? ' empty' : ''}" id="bake">${esc(bakeLine)}</p>
    ${b && !b.ok && b.error ? `<pre class="error">${esc(b.error)}</pre>` : ''}
    ${b?.warnings?.length ? `<details class="warn"><summary>${b.warnings.length} warning${b.warnings.length > 1 ? 's' : ''}</summary><pre>${esc(b.warnings.join('\n'))}</pre></details>` : ''}
    <h2>On your board</h2>
    ${snippet('Link', p.share.link)}
    ${snippet('Image', `<a href="${p.share.link}"><img src="${p.share.thumb}" alt="${esc(p.title)}" width="256"></a>`)}
    ${snippet('3D embed', `<iframe src="${p.share.embed}" width="640" height="480" style="border:0" allow="fullscreen" title="${esc(p.title)}"></iframe>`)}
  </aside>
  <section class="more">
    ${images.length ? `<h2>Attachments</h2><div class="shots">${images.map((f) => `<a href="${esc(u.file(p.lib, p.id, `attachments/${f.path}`))}" target="_blank"><img src="${esc(u.file(p.lib, p.id, `attachments/${f.path}`))}" alt="${esc(f.path)}" loading="lazy"><span>${esc(f.path)}</span></a>`).join('')}</div>` : ''}
    ${other.length ? `${images.length ? '' : '<h2>Attachments</h2>'}${fileList(other, p.lib, p.id, 'attachments', u)}` : ''}
    ${p.package ? packageSection(p.package) : ''}
    ${usesSection(p.uses)}
    <h2>Graphs</h2>
    ${p.graphs.length ? p.graphs.map((g) => `<div class="graph"><h3>${esc(g.name)}${g.name === p.graph ? ' <span class="tag">default</span>' : ''} <span class="count">${g.nodes} nodes</span></h3>${g.vars.length ? `<table class="vars"><tbody>${g.vars.map((v) => `<tr><th>${esc(v.name)}</th><td>${esc(JSON.stringify(v.value))}</td><td class="dim">${esc(v.desc ?? '')}${v.min !== undefined || v.max !== undefined ? ` <span class="range">${esc(v.min ?? '')}…${esc(v.max ?? '')}</span>` : ''}</td></tr>`).join('')}</tbody></table>` : ''}</div>`).join('') : '<p class="dim">No graphs yet. Ask your agent to build one in this package (its workspace tool opens the package); open the editor to watch it appear.</p>'}
    ${p.exports.length ? `<h2>Exports</h2>${fileList(p.exports, p.lib, p.id, 'exports', u)}` : ''}
    <p class="dim small">Folder <code>${esc(p.rel)}</code> in library ${esc(p.lib)}${p.created ? ` · created ${esc(p.created)}` : ''} · updated ${esc(when(p.updated))}</p>
  </section>
</main>`, { page: 'package', data: { lib: p.lib, id: p.id } });
}

/** The page a board embeds in an iframe: the baked preview.glb under an orbit camera, or the thumbnail. */
export function embedPage(e: { lib: string; id: string; title: string; glb: boolean; version: string; packageUrl: string }, u: Urls): string {
  const thumb = u.thumb(e.lib, e.id, e.version);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(e.title)} · TopoTopo</title>
<link rel="icon" href="data:,">
<style>
html, body { margin: 0; height: 100%; background: #2b2d31; overflow: hidden; font: 12px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif; color: #d6d9dd; }
canvas { display: block; width: 100%; height: 100%; touch-action: none; }
.poster { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
.badge { position: absolute; left: 8px; bottom: 8px; padding: 3px 7px; border-radius: 3px; background: rgba(31, 33, 36, 0.8); color: inherit; text-decoration: none; }
.badge:hover { color: #f0a030; }
.note { position: absolute; right: 8px; bottom: 8px; color: #8c939b; }
</style>
${e.glb ? `<script type="importmap">${JSON.stringify({ imports: { three: `${u.three}build/three.module.js`, 'three/addons/': `${u.three}examples/jsm/` } })}</script>
<script type="module" src="${esc(u.app('embed.js'))}"></script>` : ''}
</head>
<body>
<img class="poster" id="poster" src="${esc(thumb)}" alt="${esc(e.title)}">
${e.glb ? `<canvas id="gl" data-src="${esc(u.glb(e.lib, e.id, e.version))}"></canvas>` : ''}
<a class="badge" href="${esc(e.packageUrl)}" target="_blank" rel="noopener">${esc(e.title)} · TopoTopo</a>
<span class="note" id="note"></span>
</body>
</html>
`;
}
