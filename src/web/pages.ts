// The web app's pages as plain HTML strings: the front page (the registered workspaces and libraries as cards, a
// search over every package and output), the package block a package's folder page shows (src/web/folder-page.ts),
// the embed page a board frames and the 3D view of a model file. Pure functions of their data and a URL builder.
// Styles and the small page script are files: app/web.css and app/web.js here, app/embed.js in the viewer.

export interface Urls {
  home: string;
  /** a package's stable address (/p/<library or workspace>/<id>): it leads to its folder page */
  package(lib: string, id: string): string;
  thumb(lib: string, id: string, version?: string | number): string;
  glb(lib: string, id: string, version?: string | number): string;
  embed(lib: string, id: string): string;
  file(lib: string, id: string, rel: string): string;
  /** null where there is no editor (TopoTopo's built-in packages) */
  edit(lib: string, id: string): string | null;
  /** a folder page of a workspace ("w") or library ("l"), '' for its root */
  folder(kind: string, name: string, rel: string): string;
  /** a file of a workspace or library, as the browser shows it */
  raw(kind: string, name: string, rel: string): string;
  /** the 3D view of a model file (glb, gltf) */
  model(kind: string, name: string, rel: string): string;
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
  /** its folder page */
  url?: string;
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
  /** where it is, for people: library "props", the workspace "my-game" */
  place: string;
  links: { label: string; url: string }[];
  graph: string;
  graphs: { name: string; nodes: number; vars: VarRow[] }[];
  /** its attachments/ files: images and the rest, each with its URL (a model's 3D view as `model`) */
  attachments: (FileRow & { url: string; model?: string })[];
  /** its exports/ files, each with its URL (a model's 3D view as `model`) and, when its graph changed since, `stale` */
  exports: (FileRow & { url: string; model?: string; stale?: boolean })[];
  glb: boolean;
  /** it has a preview picture (a baked thumb.png, a built-in package's output's) */
  thumb: boolean;
  bake: { at: number; ok: boolean; error?: string; ms?: number; glb?: boolean; points?: number; prims?: number; warnings?: string[] } | null;
  created: string;
  /** absolute URLs for the copy boxes (the board pastes them) */
  share: { link: string; thumb: string; embed: string };
  /** a package: its versions, newest first, the outputs of the newest, and the packages that use it */
  package: { name: string; versions: VersionRow[]; outputs: OutputRow[]; usedBy?: UserRow[] } | null;
  /** the packages it uses: the version in use and its note, the package's page and its newest version when newer */
  uses: { name: string; version: string; note?: string; published?: string; url?: string; newest?: string }[];
}

/** A registered workspace or library on the front page: what it is, a few pictures from inside, its counts. */
export interface RootCardData {
  kind: 'w' | 'l';
  name: string;
  dir: string;
  url: string;
  /** "Godot · My Game" for a workspace with an engine project */
  engine?: string;
  builtin?: boolean;
  /** up to four thumbnails: packages' previews first, then images */
  thumbs: string[];
  packages: number;
  folders: number;
  files: number;
  flags: number;
  /** the folder or its file cannot be read: what is wrong */
  problem?: string;
  /** its audit stopped short (a very large tree): there may be more flags than counted */
  cut?: boolean;
}

/** The front page's data: the workspaces, the libraries (TopoTopo's built-in one last), every package for the search. */
export interface WebData { workspaces: RootCardData[]; libraries: RootCardData[]; packages: CardData[]; problems: string[] }

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const size = (n: number) => (n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(0)} KB` : n < 1 << 30 ? `${(n / 2 ** 20).toFixed(1)} MB` : `${(n / 2 ** 30).toFixed(2)} GB`);
export const when = (ms: number) => (ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '');
export const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`;
const STATUS: Record<string, string> = { ok: '', failed: 'bake failed', baking: 'baking…', new: 'not baked yet', empty: 'no default graph yet' };

export function shell(title: string, u: Urls, body: string, opts: { page: string; data?: object }) {
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

/** A package's full name and newest version, as a card and a package's folder page mark it. */
export const pkgMark = (p: { name: string; version: string | null }) =>
  `<span class="pkg" title="${esc(`package ${p.name}${p.version ? `, newest version ${p.version}` : ', no version published yet'}`)}">${esc(p.name)}${p.version ? ` ${esc(p.version)}` : ''}</span>`;
const day = (iso: string) => (iso ? iso.slice(0, 10) : '');

/** An output's kind and tags as marks: the kind outlined, each tag a tag. */
const kindTagMarks = (o: { kind?: string; tags: string[] }) =>
  `${o.kind ? `<span class="kind" title="what the output is">${esc(o.kind)}</span>` : ''}${o.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}`;

/** The packages a package uses with a newer version: "ux/crates 1.2 is out". */
const updateMark = (ups: NonNullable<CardData['updates']>) =>
  `<span class="upd" title="${esc(ups.map((x) => `${x.name} ${x.version} is in use; ${x.newest} is out`).join('\n'))}">${esc(ups.length === 1 ? `update: ${ups[0].name} ${ups[0].newest}` : `${ups.length} updates`)}</span>`;

/** A package's card in the search results. */
export function card(c: CardData, u: Urls) {
  // the search finds a package by the packages it uses too
  const hay = [c.title, c.id, c.lib, c.collection, c.description, ...c.tags, c.pkg?.name ?? '', ...(c.usesPackages ?? [])].join(' ').toLowerCase();
  // a package's outputs: the search shows those it finds by their name, label, kind or tags
  const outs = (c.outputs ?? []).map((o) => `<span class="out" hidden data-hay="${esc([o.type, o.alias ?? '', o.label, o.kind ?? '', ...o.tags].join(' ').toLowerCase())}"><code>${esc(o.type)}</code>${kindTagMarks(o)}</span>`).join('');
  return `<a class="card" href="${esc(c.url ?? u.package(c.lib, c.id))}" data-key="${esc(`${c.lib}/${c.id}`)}" data-hay="${esc(hay)}">
  <span class="thumb"><img src="${esc(u.thumb(c.lib, c.id, c.version))}" alt="" loading="lazy" width="512" height="512"></span>
  <span class="meta">
    <span class="title">${esc(c.title)}</span>
    <span class="sub">${esc(c.lib)}${c.collection ? ` / ${esc(c.collection)}` : ''} / ${esc(c.id)}</span>
    ${c.pkg ? pkgMark(c.pkg) : ''}
    ${c.tags.length ? `<span class="tags">${c.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</span>` : ''}
    ${outs ? `<span class="outs">${outs}</span>` : ''}
    ${c.updates?.length ? updateMark(c.updates) : ''}
    <span class="status s-${esc(c.status)}">${esc(STATUS[c.status] ?? '')}</span>
  </span>
</a>`;
}

/** Up to four pictures as one tile: one fills it, two side by side, three or four in a grid. */
export function mosaic(thumbs: string[], fallback: string) {
  const t = thumbs.slice(0, 4);
  if (!t.length) return `<span class="mosaic m0"><span class="mono">${esc(fallback)}</span></span>`;
  return `<span class="mosaic m${t.length}">${t.map((s) => `<img src="${esc(s)}" alt="" loading="lazy">`).join('')}</span>`;
}

/** A flag count as a badge (nothing for none). */
export const flagBadge = (n: number) => (n ? `<span class="fbadge" title="${esc(count(n, 'flag'))}: things TopoTopo can tell need a look">${esc(count(n, 'flag'))}</span>` : '');

function rootCard(r: RootCardData) {
  const stat = (n: number, one: string, many: string, cls = '', more = '') => `<span class="stat${cls}"><b>${n.toLocaleString('en')}${more}</b> <span>${n === 1 && !more ? one : many}</span></span>`;
  // the flags first: the figure a look at the card is for
  const stats = [
    stat(r.flags, 'flag', 'flags', r.flags ? ' fstat' : r.cut ? '' : ' ok', r.cut ? '+' : ''),
    stat(r.packages, 'package', 'packages'), stat(r.folders, 'folder', 'folders'), stat(r.files, 'file', 'files'),
  ].join('');
  const sub = r.builtin ? 'TopoTopo\'s built-in library' : r.kind === 'w' ? `Workspace${r.engine ? ` · ${r.engine}` : ''}` : 'Library';
  return `<a class="rcard${r.kind === 'w' ? ' ws' : ''}" href="${esc(r.url)}" data-root="${esc(`${r.kind}/${r.name}`)}">
  ${mosaic(r.thumbs, r.name.slice(0, 2).toUpperCase())}
  <span class="rbody">
    <span class="rsub">${esc(sub)}</span>
    <span class="rtitle">${esc(r.name)}</span>
    <span class="stats">${stats}</span>
    ${r.problem ? `<span class="rprob">${esc(r.problem)}</span>` : ''}
    ${r.cut ? '<span class="rcut">Audited in part: a very large tree (its page says where it stopped)</span>' : ''}
    <span class="path">${esc(r.dir)}</span>
  </span>
</a>`;
}

/**
 * The front page: the registered workspaces as large cards, then the libraries (TopoTopo's built-in one last), each a
 * door to its folder pages; the search finds every package by name, tag and the packages it uses, and their outputs
 * by name, kind and tag.
 */
export function frontPage(d: WebData, u: Urls): string {
  const outputs = d.packages.reduce((n, c) => n + (c.outputs?.length ?? 0), 0);
  const total = d.packages.length;
  const ws = d.workspaces.length
    ? `<div class="rgrid big">${d.workspaces.map(rootCard).join('\n')}</div>`
    : `<p class="empty">No workspace registered yet. Make a folder one with <code>topotopo workspace init &lt;folder&gt;</code>, or register one with <code>topotopo workspace add &lt;folder&gt;</code>.</p>`;
  const own = d.libraries.filter((l) => !l.builtin);
  const libs = `<div class="rgrid">${d.libraries.map(rootCard).join('\n')}</div>${own.length ? '' : `<p class="empty small">No library of your own yet. Add a folder with <code>topotopo library add &lt;name&gt; &lt;folder&gt;</code>.</p>`}`;
  return shell('TopoTopo', u, `<header class="bar">
  <a class="brand" href="${esc(u.home)}"><b>TopoTopo</b></a>
  <input id="search" type="search" placeholder="Search ${total} package${total === 1 ? '' : 's'}${outputs ? ` and ${outputs} output${outputs === 1 ? '' : 's'}` : ''}" autocomplete="off" aria-label="Search packages${outputs ? ' and their outputs' : ''}">
  <button id="clear" class="btn" type="button" hidden title="clear the search">Clear</button>
  <a class="news" href="https://topotopo.kit.com/54b6b32c3f" target="_blank" rel="noopener" title="releases and new packs, about once a month">Get TopoTopo news</a>
</header>
<main class="wrap front">
${d.problems.length ? `<details class="problems"><summary>${d.problems.length} problem${d.problems.length > 1 ? 's' : ''}</summary><ul>${d.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></details>` : ''}
<section class="roots" id="workspaces">
  <h2>Workspaces <span class="count">${d.workspaces.length}</span></h2>
  ${ws}
</section>
<section class="roots" id="libraries">
  <h2>Libraries <span class="count">${d.libraries.length}</span></h2>
  ${libs}
</section>
<section id="results" hidden>
  <h2>Packages <span class="count" id="found" data-total="${total}">${total}</span></h2>
  <div class="grid">${d.packages.map((c) => card(c, u)).join('\n')}</div>
  <p class="empty" id="nomatch" hidden>Nothing matches. <button class="btn" type="button" data-clear>Clear the search</button></p>
</section>
</main>`, { page: 'front' });
}

/** A package's versions with their notes and dates, and the outputs its newest version publishes with their kinds and tags. */
function packageSection(pk: NonNullable<PackageData['package']>): string {
  if (!pk.versions.length) return `<h2>Versions</h2><p class="dim">No version published yet: <code>topotopo publish --note "…"</code> in the package's folder publishes the first, which other packages can then use as <code>${esc(pk.name)}</code>.</p>${usedBySection(pk.usedBy ?? [])}`;
  const big = (v: VersionRow) => (v.big ? ' <span class="tag" title="something a package relies on goes away or means something else">big</span>' : v.marked ? ' <span class="tag" title="its author marked it big">big</span>' : '');
  const outputs = pk.outputs.map((o) => {
    const what = [`node "${o.node}" of graph "${o.graph}"`, o.params.length ? `params ${o.params.join(', ')}` : '', o.inputs.length ? `input${o.inputs.length > 1 ? 's' : ''} ${o.inputs.join(', ')}` : ''].filter(Boolean).join(' · ');
    const marks = kindTagMarks(o);
    return `<tr><th>${o.thumb ? `<img class="othumb" src="${esc(o.thumb)}" alt="" loading="lazy" width="96" height="96">` : ''}<code>${esc(o.type)}</code>${o.alias ? `<br><code>${esc(o.alias)}</code> <span class="dim">(the default)</span>` : ''}</th><td>${esc(o.label)}${marks ? `<span class="tags">${marks}</span>` : ''}</td><td class="dim">${esc(what)}</td></tr>`;
  }).join('');
  return `<h2>Published outputs <span class="count">${pk.outputs.length}</span></h2>
    <div class="table"><table class="vars outputs"><tbody>${outputs}</tbody></table></div>
    <p class="dim small">The outputs of ${esc(pk.versions[0].version)}: a package's graph uses one as a node type, <code>{"type": "${esc(pk.outputs[0]?.type ?? pk.name)}"}</code>, with its params.</p>
    <h2>Versions <span class="count">${pk.versions.length}</span></h2>
    ${versionList(pk.versions, big)}
    ${usedBySection(pk.usedBy ?? [])}`;
}

/** The versions, newest first: each opens to the outputs it published. */
function versionList(versions: VersionRow[], big: (v: VersionRow) => string) {
  return `<div class="versions">${versions.map((v) => `<details class="version" id="v-${esc(v.version)}"><summary><span class="vn">${esc(v.version)}</span>${big(v)}<span class="vd">${esc(day(v.published))}</span><span class="vt">${esc(v.note)}</span></summary>
      ${v.outputs?.length ? `<ul class="vouts">${v.outputs.map((o) => `<li><code>${esc(o.type)}</code>${o.label ? ` ${esc(o.label)}` : ''}${kindTagMarks(o) ? `<span class="tags">${kindTagMarks(o)}</span>` : ''}</li>`).join('')}</ul>` : '<p class="dim small">Its record lists no outputs.</p>'}
    </details>`).join('')}</div>`;
}

/** The packages of the libraries and the workspaces that use a package, each linked, with the version it uses. */
function usedBySection(users: UserRow[]) {
  return `<h2>Used by <span class="count">${users.length}</span></h2>${users.length
    ? `<table class="vars uses"><tbody>${users.map((x) => `<tr><th><a href="${esc(x.url)}">${esc(x.title)}</a></th><td>${esc(x.version)}</td><td class="dim">${esc(x.lib)}</td></tr>`).join('')}</tbody></table>`
    : '<p class="dim">No package in the libraries uses it yet.</p>'}`;
}

/**
 * The packages a package (or a workspace) uses: the version in use, when a newer one is out, its date and its note
 * (one line; the whole note on hover and on the package's page).
 */
export function usesSection(uses: PackageData['uses']): string {
  if (!uses.length) return '';
  return `<h2>Packages it uses <span class="count">${uses.length}</span></h2>
    <table class="vars uses"><tbody>${uses.map((x) => `<tr><th>${x.url ? `<a href="${esc(x.url)}">${esc(x.name)}</a>` : esc(x.name)}</th><td>${esc(x.version)}</td><td class="unotes"><span class="urow">${x.newest ? `<span class="newer">${esc(x.newest)} is out</span>` : ''}${x.published ? `<span class="udate">${esc(day(x.published))}</span>` : ''}${x.note ? `<span class="unote" title="${esc(x.note)}">${esc(x.note)}</span>` : ''}</span></td></tr>`).join('')}</tbody></table>`;
}

/**
 * A package on its folder page, the top part: its 3D view (the baked preview) beside what it is, its links, its
 * actions (Open in editor, Re-bake), how its preview cooked and the snippets for a board.
 */
export function packageBlock(p: PackageData, u: Urls): string {
  const edit = u.edit(p.lib, p.id);
  const snippet = (label: string, value: string) => `<label class="copy"><span>${label}</span><input readonly value="${esc(value)}"><button type="button" data-copy>Copy</button></label>`;
  const b = p.status === 'empty' || p.builtin ? null : p.bake;
  const example = p.package?.outputs.find((o) => !o.alias)?.type;
  const bakeLine = p.builtin
    ? `One of TopoTopo's own packages: every package can use its outputs. Ask your agent to use one by its name${example ? `, such as ${example}` : ''}.`
    : p.status === 'empty'
    ? (p.graphs.length ? `No default graph yet: its manifest shows "${p.graph}", which this package does not have. Ask your agent to build it, or to show one of its graphs.` : 'No default graph yet: this package has no graphs. Ask your agent to build one; the preview appears here when it exists.')
    : p.status === 'baking' ? 'Baking its preview…'
    : !b ? 'Not baked yet.'
    : b.ok ? `Baked ${when(b.at)} in ${((b.ms ?? 0) / 1000).toFixed(1)} s · ${(b.points ?? 0).toLocaleString('en')} points, ${(b.prims ?? 0).toLocaleString('en')} prims${b.glb ? '' : ' · no 3D preview (too large)'}`
    : `Bake failed ${when(b.at)}`;
  // the 3D view; else the preview picture at its own size; else a short word that there is none yet, and why
  const none = p.status === 'empty' ? 'No preview yet: this package has no graph to bake' : p.status === 'baking' ? 'No preview yet: baking it…' : b && !b.ok ? 'No preview: its graph did not cook' : 'No preview yet';
  const view = p.glb
    ? `<iframe class="view" src="${esc(u.embed(p.lib, p.id))}" title="${esc(p.title)} in 3D" allow="fullscreen"></iframe>`
    : p.thumb ? `<img class="view pic" src="${esc(u.thumb(p.lib, p.id, p.version))}" alt="${esc(p.title)}" width="512" height="512">`
    : `<div class="view none"><span class="cube"></span><p>${esc(none)}</p></div>`;
  // a bake that failed leaves the last good preview: marked as such
  const old = !!b && !b.ok && (p.glb || p.thumb);
  return `<section class="pkgblock" data-key="${esc(`${p.lib}/${p.id}`)}">
  <div class="stage${old ? ' old' : ''}">${view}${old ? '<span class="oldmark">Last good preview: the newest graph did not cook</span>' : ''}</div>
  <aside class="info">
    ${p.pkg ? `<p class="pkgline">Package ${pkgMark(p.pkg)}</p>` : '<p class="pkgline">Package <span class="dim">(publishes no versions)</span></p>'}
    ${p.description ? `<p class="desc">${esc(p.description)}</p>` : ''}
    ${p.tags.length ? `<p class="tags">${p.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</p>` : ''}
    ${p.links.length ? `<ul class="links">${p.links.map((l) => `<li><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a></li>`).join('')}</ul>` : ''}
    <div class="actions">
      ${edit ? `<a class="btn primary" href="${esc(edit)}" target="_blank" rel="noopener">Open in editor</a>` : ''}
      ${p.builtin || p.status === 'empty' ? '' : `<button class="btn" type="button" data-post="${esc(`${u.package(p.lib, p.id)}/bake`)}">Re-bake</button>`}
    </div>
    <p class="bake ${b && !b.ok ? 'err' : ''}${p.status === 'empty' ? ' empty' : ''}" id="bake">${esc(bakeLine)}</p>
    ${b && !b.ok && b.error ? `<pre class="error">${esc(b.error)}</pre>` : ''}
    ${b?.warnings?.length ? `<details class="warn"><summary>${b.warnings.length} warning${b.warnings.length > 1 ? 's' : ''}</summary><pre>${esc(b.warnings.join('\n'))}</pre></details>` : ''}
    <details class="board"><summary>On your board</summary>
    ${snippet('Link', p.share.link)}
    ${snippet('Image', `<a href="${p.share.link}"><img src="${p.share.thumb}" alt="${esc(p.title)}" width="256"></a>`)}
    ${snippet('3D embed', `<iframe src="${p.share.embed}" width="640" height="480" style="border:0" allow="fullscreen" title="${esc(p.title)}"></iframe>`)}
    </details>
  </aside>
</section>`;
}

/**
 * A package on its folder page, right below its preview: its published outputs and versions, the packages that use it
 * and those it uses beside its graphs and their vars and its exports (those older than their graph marked). One column
 * when it publishes no versions and uses no package.
 */
export function packageCols(p: PackageData): string {
  const graphs = p.graphs.length
    ? `<div class="graphs">${p.graphs.map((g) => `<details class="graph"${p.graphs.length <= 3 ? ' open' : ''}><summary><b>${esc(g.name)}</b>${g.name === p.graph ? ' <span class="tag">default</span>' : ''} <span class="count">${g.nodes} nodes${g.vars.length ? ` · ${g.vars.length} vars` : ''}</span></summary>${g.vars.length ? `<table class="vars"><tbody>${g.vars.map((v) => `<tr><th>${esc(v.name)}</th><td>${esc(JSON.stringify(v.value))}</td><td class="dim">${esc(v.desc ?? '')}${v.min !== undefined || v.max !== undefined ? ` <span class="range">${esc(v.min ?? '')}…${esc(v.max ?? '')}</span>` : ''}</td></tr>`).join('')}</tbody></table>` : ''}</details>`).join('')}</div>`
    : '<p class="dim">No graphs yet. Ask your agent to build one in this package (its workspace tool opens the package); open the editor to watch it appear.</p>';
  const left = `${p.package ? packageSection(p.package) : ''}${usesSection(p.uses)}`;
  return `<section class="pkgmore">
    <div class="pkgcols${left ? '' : ' solo'}">
      ${left ? `<div>${left}</div>` : ''}
      <div>
        <h2>Graphs <span class="count">${p.graphs.length}</span></h2>
        ${graphs}
        ${p.exports.length ? `<h2>Exports <span class="count">${p.exports.length}</span></h2>${fileList(p.exports)}` : ''}
      </div>
    </div>
  </section>`;
}

/** A package on its folder page, last: its attachments, where it is and its stable link. */
export function packageEnd(p: PackageData, u: Urls): string {
  return `<section class="pkgend">
    ${attachments(p)}
    <p class="dim small">${esc(p.place)}${p.created ? ` · created ${esc(p.created)}` : ''} · updated ${esc(when(p.updated))} · <a href="${esc(u.package(p.lib, p.id))}">stable link</a></p>
  </section>`;
}

/**
 * A package's attachments: its images as tiles and its other files as a list. Many images show one from each
 * folder first (its first by name: a concept before its renders), the rest a click away.
 */
function attachments(p: PackageData): string {
  if (!p.attachments.length) return '';
  const images = p.attachments.filter((f) => f.image), other = p.attachments.filter((f) => !f.image);
  const tile = (f: PackageData['attachments'][number]) => `<a class="tile" href="${esc(f.url)}" data-view="image" data-name="${esc(f.path)}"><img src="${esc(f.url)}" alt="" loading="lazy" decoding="async"><span>${esc(f.path)}</span></a>`;
  let shown = images;
  if (images.length > 16) {
    const firsts = new Map<string, (typeof images)[number]>();
    for (const f of images) { const top = f.path.includes('/') ? f.path.slice(0, f.path.indexOf('/')) : f.path; if (!firsts.has(top)) firsts.set(top, f); }
    shown = [...firsts.values()].slice(0, 16);
  }
  const rest = images.length - shown.length;
  return `<h2>Attachments <span class="count">${p.attachments.length}</span></h2>
    ${shown.length ? `<div class="igrid">${shown.map(tile).join('')}</div>` : ''}
    ${rest > 0 ? `<details class="allatt"><summary>All ${images.length} images</summary><div class="igrid">${images.map(tile).join('')}</div></details>` : ''}
    ${other.length ? `<details class="allatt"${other.length <= 8 ? ' open' : ''}><summary>${other.length} other file${other.length === 1 ? '' : 's'}</summary>${fileList(other)}</details>` : ''}`;
}

const fileList = (rows: (FileRow & { url: string; model?: string; stale?: boolean })[]) =>
  `<ul class="flist">${rows.map((f) => `<li><a href="${esc(f.url)}"${f.image ? ` data-view="image" data-name="${esc(f.path)}"` : f.model ? ` data-view="model" data-src="${esc(f.model)}" data-name="${esc(f.path)}"` : ''}>${esc(f.path)}</a>${f.stale ? ' <span class="stale" title="its graph changed since it was exported">older than its graph</span>' : ''}<span>${size(f.size)}</span></li>`).join('')}</ul>`;

/**
 * The page a board embeds in an iframe (and a package's folder page shows): the baked preview.glb under an orbit
 * camera, or the thumbnail. It sits in a page that scrolls, so the wheel scrolls that page until the view is clicked
 * (or with Ctrl held).
 */
export function embedPage(e: { lib: string; id: string; title: string; glb: boolean; version: string; packageUrl: string }, u: Urls): string {
  return viewPage({ title: e.title, poster: u.thumb(e.lib, e.id, e.version), src: e.glb ? u.glb(e.lib, e.id, e.version) : null, link: e.packageUrl, wheel: 'click' }, u);
}

/** The 3D view of a model file (glb, gltf) of a folder: what a page opens when a model is clicked. */
export function modelPage(m: { title: string; src: string; link: string }, u: Urls): string {
  return viewPage({ title: m.title, poster: null, src: m.src, link: m.link, wheel: 'zoom' }, u);
}

/** The import map the 3D views load three.js with (inline: its hash is in their content policy). */
export const importMap = (u: Urls) => JSON.stringify({ imports: { three: `${u.three}build/three.module.js`, 'three/addons/': `${u.three}examples/jsm/` } });

function viewPage(e: { title: string; poster: string | null; src: string | null; link: string; wheel: 'click' | 'zoom' }, u: Urls): string {
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
.hint { position: absolute; right: 8px; top: 8px; padding: 3px 8px; border-radius: 3px; background: rgba(31, 33, 36, 0.8); color: #8c939b; pointer-events: none; transition: opacity 0.2s; }
</style>
${e.src ? `<script type="importmap">${importMap(u)}</script>
<script type="module" src="${esc(u.app('embed.js'))}"></script>` : ''}
</head>
<body>
${e.poster ? `<img class="poster" id="poster" src="${esc(e.poster)}" alt="${esc(e.title)}">` : ''}
${e.src ? `<canvas id="gl" data-src="${esc(e.src)}" data-wheel="${e.wheel}"></canvas>` : ''}
${e.src && e.wheel === 'click' ? '<span class="hint" id="hint" hidden>Click to zoom with the wheel</span>' : ''}
<a class="badge" href="${esc(e.link)}" target="_blank" rel="noopener">${esc(e.title)} · TopoTopo</a>
<span class="note" id="note">${e.src && !e.poster ? 'Loading…' : ''}</span>
</body>
</html>
`;
}
