// The gallery's pages as plain HTML strings: the grid of projects, a project's page and the embed page. Pure functions
// of their data and a URL builder, so the local server (src/gallery/server.ts) and a static build can share them.
// Styles and the small page script are files: app/gallery.css and app/gallery.js here, app/embed.js in the viewer.

export interface Urls {
  home: string;
  project(lib: string, id: string): string;
  thumb(lib: string, id: string, version?: string | number): string;
  glb(lib: string, id: string, version?: string | number): string;
  embed(lib: string, id: string): string;
  file(lib: string, id: string, rel: string): string;
  /** null where there is no editor (a static gallery) */
  edit(lib: string, id: string): string | null;
  /** the gallery's own files (gallery.css, gallery.js) */
  asset(name: string): string;
  /** the viewer's modules (embed.js, scene.js) */
  app(name: string): string;
  /** three.js: the import map's base for build/ and examples/jsm/ */
  three: string;
}

export interface CardData {
  lib: string; id: string; title: string; collection: string; tags: string[]; description: string; updated: number;
  /** 'ok' | 'failed' | 'baking' | 'new' */
  status: string; version: string;
}

export interface VarRow { name: string; value: unknown; desc?: string; min?: number; max?: number }
export interface FileRow { path: string; size: number; image: boolean }
export interface ProjectData extends CardData {
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
}

export interface GalleryData { libraries: { name: string; cards: CardData[] }[]; problems: string[] }

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 2 ** 20).toFixed(1)} MB`);
const when = (ms: number) => (ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '');
const STATUS: Record<string, string> = { ok: '', failed: 'bake failed', baking: 'baking…', new: 'not baked yet' };

function shell(title: string, u: Urls, body: string, opts: { page: string; data?: object }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="${esc(u.asset('gallery.css'))}">
<script type="module" src="${esc(u.asset('gallery.js'))}"></script>
</head>
<body data-page="${opts.page}"${opts.data ? ` data-json="${esc(JSON.stringify(opts.data))}"` : ''}>
${body}
</body>
</html>
`;
}

function card(c: CardData, u: Urls) {
  const hay = [c.title, c.id, c.collection, c.description, ...c.tags].join(' ').toLowerCase();
  return `<a class="card" href="${esc(u.project(c.lib, c.id))}" data-key="${esc(`${c.lib}/${c.id}`)}" data-hay="${esc(hay)}" data-tags="${esc(c.tags.join('\n'))}" data-collection="${esc(c.collection)}">
  <span class="thumb"><img src="${esc(u.thumb(c.lib, c.id, c.version))}" alt="" loading="lazy" width="512" height="512"></span>
  <span class="meta">
    <span class="title">${esc(c.title)}</span>
    <span class="sub">${c.collection ? `${esc(c.collection)} · ` : ''}${esc(c.id)}</span>
    ${c.tags.length ? `<span class="tags">${c.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</span>` : ''}
    <span class="status s-${esc(c.status)}">${esc(STATUS[c.status] ?? '')}</span>
  </span>
</a>`;
}

/** The front page: every library's projects grouped by collection, with search and tag filters. */
export function galleryPage(d: GalleryData, u: Urls): string {
  const tags = [...new Set(d.libraries.flatMap((l) => l.cards.flatMap((c) => c.tags)))].sort();
  const total = d.libraries.reduce((n, l) => n + l.cards.length, 0);
  const libs = d.libraries.map((l) => {
    const groups = new Map<string, CardData[]>();
    for (const c of l.cards) { const g = groups.get(c.collection) ?? []; g.push(c); groups.set(c.collection, g); }
    const sections = [...groups].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([coll, cards]) => `
    <section class="collection" data-collection="${esc(coll)}">
      ${coll ? `<h3>${esc(coll)}</h3>` : ''}
      <div class="grid">${cards.map((c) => card(c, u)).join('\n')}</div>
    </section>`).join('');
    return `
  <section class="library" id="lib-${esc(l.name)}">
    <h2>${esc(l.name)} <span class="count">${l.cards.length}</span></h2>${sections || '<p class="empty">No projects yet. Make one with <code>topotopo library new ' + esc(l.name) + ' &lt;folder/name&gt;</code> or the MCP <code>library</code> tool.</p>'}
  </section>`;
  }).join('');
  const none = d.libraries.length ? '' : `<p class="empty">No libraries yet. Add a folder with <code>topotopo library add &lt;name&gt; &lt;folder&gt;</code>.</p>`;
  return shell('TopoTopo Gallery', u, `<header class="bar">
  <a class="brand" href="${esc(u.home)}">TopoTopo <b>Gallery</b></a>
  <input id="search" type="search" placeholder="Search ${total} projects" autocomplete="off" aria-label="Search projects">
</header>
<main class="wrap">
${d.problems.length ? `<details class="problems"><summary>${d.problems.length} problem${d.problems.length > 1 ? 's' : ''} in the libraries</summary><ul>${d.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></details>` : ''}
${tags.length ? `<nav class="chips" aria-label="Tags">${tags.map((t) => `<button class="chip" data-tag="${esc(t)}" aria-pressed="false">${esc(t)}</button>`).join('')}</nav>` : ''}
${none}${libs}
<p class="empty" id="nomatch" hidden>Nothing matches.</p>
</main>`, { page: 'gallery' });
}

function fileList(rows: FileRow[], lib: string, id: string, base: string, u: Urls) {
  return `<ul class="files">${rows.map((f) => `<li><a href="${esc(u.file(lib, id, `${base}/${f.path}`))}"${f.image ? '' : ' download'}>${esc(f.path)}</a><span>${size(f.size)}</span></li>`).join('')}</ul>`;
}

/** A project's page: the 3D view, what it is, links, attachments, graphs and their vars, and the snippets for a board. */
export function projectPage(p: ProjectData, u: Urls): string {
  const images = p.attachments.filter((f) => f.image), other = p.attachments.filter((f) => !f.image);
  const edit = u.edit(p.lib, p.id);
  const snippet = (label: string, value: string) => `<label class="copy"><span>${label}</span><input readonly value="${esc(value)}"><button type="button" data-copy>Copy</button></label>`;
  const b = p.bake;
  const bakeLine = !b ? 'Not baked yet.'
    : b.ok ? `Baked ${when(b.at)} in ${((b.ms ?? 0) / 1000).toFixed(1)} s · ${b.points ?? 0} points, ${b.prims ?? 0} prims${b.glb ? '' : ' · no 3D preview (too large)'}`
    : `Bake failed ${when(b.at)}`;
  const view = p.glb
    ? `<iframe class="view" src="${esc(u.embed(p.lib, p.id))}" title="${esc(p.title)} in 3D" allow="fullscreen"></iframe>`
    : `<img class="view" src="${esc(u.thumb(p.lib, p.id, p.version))}" alt="${esc(p.title)}">`;
  return shell(`${p.title} · TopoTopo Gallery`, u, `<header class="bar">
  <a class="brand" href="${esc(u.home)}">TopoTopo <b>Gallery</b></a>
  <nav class="crumbs"><a href="${esc(u.home)}#lib-${esc(p.lib)}">${esc(p.lib)}</a>${p.collection ? ` / <span>${esc(p.collection)}</span>` : ''} / <span>${esc(p.id)}</span></nav>
</header>
<main class="wrap project">
  <div class="stage">${view}</div>
  <aside class="info">
    <h1>${esc(p.title)}</h1>
    ${p.description ? `<p class="desc">${esc(p.description)}</p>` : ''}
    ${p.tags.length ? `<p class="tags">${p.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</p>` : ''}
    ${p.links.length ? `<ul class="links">${p.links.map((l) => `<li><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a></li>`).join('')}</ul>` : ''}
    <div class="actions">
      ${edit ? `<a class="btn primary" href="${esc(edit)}" target="_blank" rel="noopener">Open in editor</a>` : ''}
      <button class="btn" type="button" data-post="bake">Re-bake</button>
      <button class="btn" type="button" data-post="reveal">Show folder</button>
    </div>
    <p class="bake ${b && !b.ok ? 'err' : ''}" id="bake">${esc(bakeLine)}</p>
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
    <h2>Graphs</h2>
    ${p.graphs.length ? p.graphs.map((g) => `<div class="graph"><h3>${esc(g.name)}${g.name === p.graph ? ' <span class="tag">shown</span>' : ''} <span class="count">${g.nodes} nodes</span></h3>${g.vars.length ? `<table class="vars"><tbody>${g.vars.map((v) => `<tr><th>${esc(v.name)}</th><td>${esc(JSON.stringify(v.value))}</td><td class="dim">${esc(v.desc ?? '')}${v.min !== undefined || v.max !== undefined ? ` <span class="range">${esc(v.min ?? '')}…${esc(v.max ?? '')}</span>` : ''}</td></tr>`).join('')}</tbody></table>` : ''}</div>`).join('') : '<p class="dim">No graphs yet: build one with an agent (MCP <code>library {action:"open"}</code>, then <code>build</code>) or open the editor.</p>'}
    ${p.exports.length ? `<h2>Exports</h2>${fileList(p.exports, p.lib, p.id, 'exports', u)}` : ''}
    <p class="dim small">Folder <code>${esc(p.rel)}</code> in library ${esc(p.lib)}${p.created ? ` · created ${esc(p.created)}` : ''} · updated ${esc(when(p.updated))}</p>
  </section>
</main>`, { page: 'project', data: { lib: p.lib, id: p.id } });
}

/** The page a board embeds in an iframe: the baked preview.glb under an orbit camera, or the thumbnail. */
export function embedPage(e: { lib: string; id: string; title: string; glb: boolean; version: string; projectUrl: string }, u: Urls): string {
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
<a class="badge" href="${esc(e.projectUrl)}" target="_blank" rel="noopener">${esc(e.title)} · TopoTopo</a>
<span class="note" id="note"></span>
</body>
</html>
`;
}
