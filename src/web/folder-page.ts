// A folder page of the web app (/w/<workspace>/<path…>/, /l/<library>/<path…>/): the folder's flags, its package when
// it is one (src/web/pages.ts packageBlock, packageCols, packageEnd: the package in one piece), its notes as boxes (kept
// short when pictures, folders or a package come after them; one note with pictures beside it on a wide screen), a card
// per subfolder (the empty ones as one line of links) and its files by type: images to view large, audio and video in
// players, models in 3D on a click, the rest to open or download. A pure function of its data (src/web/server.ts
// gathers it, src/web/folders.ts reads the folder) and a URL builder.
import { count, esc, flagBadge, mosaic, packageBlock, packageCols, packageEnd, shell, size, usesSection, when } from './pages.ts';
import type { PackageData, Urls } from './pages.ts';
import type { FileKind, Flag } from './folders.ts';

/** A subfolder as a card. */
export interface FolderCard {
  name: string;
  url: string;
  /** a plain folder, a package (it holds a .topo), an engine project (opens on demand, never audited), another workspace */
  kind: 'folder' | 'package' | 'engine' | 'workspace';
  /** the package's title, the engine project's name, else the folder's name */
  title: string;
  /** what is in it: "12 files · 3 folders", "Godot project" */
  sub: string;
  thumb?: string;
  /** the flags in it and below it */
  flags: number;
  /** the packages in it and below it (a plain folder) */
  packages: number;
  /** a package's full name and newest version */
  pkg?: { name: string; version: string | null };
  /** a package's preview status ('failed' …) */
  status?: string;
  /** a plain folder with nothing in it: listed in one line, not as a card */
  empty?: boolean;
}

export interface FileItem {
  name: string;
  url: string;
  size: number;
  mtime: number;
  kind: FileKind;
  /** a model's 3D view */
  model?: string;
  /** an export TopoTopo made: its graph and output, and whether the graph changed since */
  made?: { graph: string; output: string | null; stale: boolean | null };
}

export interface NoteBox {
  name: string;
  id: string;
  url: string;
  html: string;
  /** too large to show: linked only */
  long: boolean;
  /** the note a link asked for (?note=): shown whole */
  asked?: boolean;
}

export interface FolderPageData {
  root: { kind: string; name: string; label: string };
  /** posix path from the root ('' for the root) */
  rel: string;
  crumbs: { name: string; url: string }[];
  /** what the folder is, above its name: "Workspace · Godot · My Game", "Package", "Folder" */
  kicker: string;
  title: string;
  /** the folder's own files and folders, in a line */
  stats: string;
  dir: string;
  /** its own flags */
  flags: Flag[];
  /** the flags of its subfolders, by folder */
  below: { at: string; url: string; flags: Flag[] }[];
  /** a word on the folder: an engine project is browsable and not audited, a package outside the scan … */
  notice?: string;
  notes: NoteBox[];
  /** the notes not shown as boxes (listed with the other files) */
  moreNotes: number;
  folders: FolderCard[];
  files: FileItem[];
  /** Unreal's .uasset and .umap files here */
  engineAssets: number;
  package: PackageData | null;
  /** a workspace's root: the one version of each package its packages use */
  uses?: PackageData['uses'];
  /** a root whose audit stopped short: where, in words */
  cut?: string[];
  /** what the page script needs: the root and folder (live updates), the package shown */
  live: { root: string; rel: string; package?: string; reveal: string };
}

/** Each flag's chip: what is wrong, in two words. */
const FLAG_WORD: Record<string, string> = { link: 'broken link', bake: 'bake failed', publish: 'unpublished', export: 'stale export', unused: 'unused outputs', workspace: 'workspace' };

function flagList(flags: Flag[]) {
  return `<ul class="flaglist">${flags.map((f) => `<li class="flag f-${esc(f.kind)}"><span class="fkind">${esc(FLAG_WORD[f.kind] ?? f.kind)}</span><span class="fwhat">${esc(f.what)}</span><span class="ftodo">${esc(f.todo)}</span></li>`).join('')}</ul>`;
}

/** Flags by kind in words: "4 broken links, 2 exports". */
function kinds(flags: Flag[]) {
  const n = new Map<string, number>();
  for (const f of flags) n.set(f.kind, (n.get(f.kind) ?? 0) + 1);
  const word: Record<string, [string, string]> = { link: ['broken link', 'broken links'], bake: ['preview that did not cook', 'previews that did not cook'], publish: ['package to publish', 'packages to publish'], export: ['export older than its graph', 'exports older than their graph'], unused: ['package with unused outputs', 'packages with unused outputs'], workspace: ['workspace problem', 'workspace problems'] };
  return [...n].map(([k, c]) => `${c} ${(word[k] ?? [k, k])[c === 1 ? 0 : 1]}`).join(', ');
}

function flagsSection(d: FolderPageData) {
  const below = d.below.reduce((n, b) => n + b.flags.length, 0);
  if (!d.flags.length && !below) return '';
  const all = d.below.flatMap((b) => b.flags);
  return `<section class="flags" aria-label="Flags">
  <h2>${esc(count(d.flags.length + below, 'flag'))}${below && d.flags.length ? ` <span class="count">${esc(`${d.flags.length} here, ${below} in its folders`)}</span>` : below ? ' <span class="count">in its folders</span>' : ''}</h2>
  ${d.flags.length ? flagList(d.flags) : ''}
  ${below ? `<details class="below"${d.flags.length || below > 6 ? '' : ' open'}><summary>${esc(count(below, 'flag'))} in ${esc(count(d.below.length, 'folder'))} below: ${esc(kinds(all))}</summary>
    ${d.below.map((b) => `<div class="fgroup"><a class="fat" href="${esc(b.url)}">${esc(b.at)}</a>${flagList(b.flags.slice(0, 20))}${b.flags.length > 20 ? `<p class="dim small">and ${b.flags.length - 20} more: <a href="${esc(b.url)}">open the folder</a></p>` : ''}</div>`).join('')}
  </details>` : ''}
</section>`;
}

/**
 * The notes as boxes. Three or more fold shorter, and so do notes with pictures, folders or a package after them
 * (`short`): the page stays an overview, each note a click from whole.
 */
function notesSection(d: FolderPageData, short: boolean) {
  if (!d.notes.length) return '';
  return `<section class="notes${d.notes.length >= 3 ? ' many' : d.notes.length === 1 ? ' one' : ''}${short ? ' short' : ''}" aria-label="Notes">
  ${d.notes.map((n) => `<article class="note${n.asked ? ' open' : ''}" id="${esc(n.id)}">
    <header><a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.name)}</a></header>
    ${n.long ? `<p class="dim">Too long to show here: <a href="${esc(n.url)}" target="_blank" rel="noopener">open ${esc(n.name)}</a>.</p>` : `<div class="md${/\.txt$/i.test(n.name) ? ' txt' : ''}">${n.html}</div>`}
    <button class="more" type="button" hidden>${n.asked ? 'Show less' : 'Show all'}</button>
  </article>`).join('\n')}
  ${d.moreNotes ? `<p class="dim small morenotes">${esc(count(d.moreNotes, 'more note'))} of this folder ${d.moreNotes === 1 ? 'is' : 'are'} listed with its other files.</p>` : ''}
</section>`;
}

function folderCard(c: FolderCard) {
  // a folder without a picture: a folder, a package's cube, the engine's name
  const pic = c.thumb ? mosaic([c.thumb], '') : c.kind === 'engine' ? `<span class="mosaic m0 engine"><span class="mono">${c.sub.startsWith('Unreal') ? 'Unreal' : 'Godot'}</span></span>` : `<span class="mosaic m0 icon ${c.kind === 'package' ? 'cube' : 'dir'}"></span>`;
  return `<a class="fcard k-${esc(c.kind)}" href="${esc(c.url)}">
    ${pic}
    <span class="fbody">
      <span class="ftitle">${esc(c.title)}</span>
      ${c.title !== c.name ? `<span class="fname">${esc(c.name)}/</span>` : ''}
      <span class="fsub">${esc(c.sub)}</span>
      ${c.pkg ? `<span class="pkg">${esc(c.pkg.name)}${c.pkg.version ? ` ${esc(c.pkg.version)}` : ''}</span>` : ''}
      <span class="fmarks">${c.kind === 'package' ? '<span class="kindmark">package</span>' : c.packages ? `<span class="kindmark">${esc(count(c.packages, 'package'))}</span>` : ''}${c.status === 'failed' ? '<span class="status s-failed">bake failed</span>' : ''}${flagBadge(c.flags)}</span>
    </span>
  </a>`;
}

/** The folder's images as tiles. */
function imagesPart(images: FileItem[]) {
  return images.length ? `<h2>Images <span class="count">${images.length}</span></h2>
    <div class="igrid${images.length <= 4 ? ' few' : ''}">${images.map((f) => `<a class="tile" href="${esc(f.url)}" data-view="image" data-name="${esc(f.name)}" title="${esc(`${f.name} · ${size(f.size)}`)}"><img src="${esc(f.url)}" alt="" loading="lazy" decoding="async"><span>${esc(f.name)}</span></a>`).join('')}</div>` : '';
}

/** The folder's files by type (`withImages`: its images too, unless they stand beside its note). */
function filesSection(d: FolderPageData, u: Urls, withImages: boolean) {
  const by = (k: FileKind) => d.files.filter((f) => f.kind === k);
  const images = by('image'), audio = by('audio'), video = by('video'), models = by('model'), other = by('other');
  const made = (f: FileItem) => (f.made ? `<span class="made" title="${esc(`exported from graph "${f.made.graph}"${f.made.output ? `, output "${f.made.output}"` : ''}`)}">from ${esc(f.made.graph)}${f.made.output ? ` · ${esc(f.made.output)}` : ''}</span>${f.made.stale ? '<span class="stale" title="its graph changed since it was exported">older than its graph</span>' : ''}` : '');
  const parts: string[] = [];
  if (withImages && images.length) parts.push(imagesPart(images));
  if (audio.length) {
    // a few sounds load their length at once (shown beside their size); a folder of hundreds loads each when it is played
    const preload = audio.length > 40 ? 'none' : 'metadata';
    parts.push(`<h2>Sounds <span class="count">${audio.length}</span></h2>
    <div class="alist">${audio.map((f) => `<div class="arow"><span class="aname" title="${esc(f.name)}"><span class="ax">${esc(ext(f.name))}</span>${esc(f.name.replace(/\.[^.]+$/, ''))}</span><audio controls preload="${preload}" src="${esc(f.url)}"></audio><span class="adur" title="length"></span><span class="asize">${esc(size(f.size))}</span><a class="dl" href="${esc(f.url)}?download" title="download ${esc(f.name)}" aria-label="download ${esc(f.name)}">download</a></div>`).join('')}</div>`);
  }
  if (video.length) {
    const preload = video.length > 12 ? 'none' : 'metadata';
    parts.push(`<h2>Videos <span class="count">${video.length}</span></h2>
    <div class="vgrid">${video.map((f) => `<figure class="vtile"><video controls preload="${preload}" src="${esc(f.url)}"></video><figcaption><span title="${esc(f.name)}">${esc(f.name)}</span><span class="dim">${esc(size(f.size))}</span></figcaption></figure>`).join('')}</div>`);
  }
  if (models.length) {
    parts.push(`<h2>Models <span class="count">${models.length}</span></h2>
    <div class="mgrid">${models.map((f) => `<button type="button" class="mtile" data-view="model" data-src="${esc(f.model ?? '')}" data-name="${esc(f.name)}"><span class="cube"></span><span class="mname">${esc(f.name)}</span><span class="dim small">${esc(size(f.size))} · View in 3D</span>${made(f)}</button>`).join('')}</div>`);
  }
  if (other.length || d.engineAssets) {
    parts.push(`<h2>Other files <span class="count">${other.length}</span></h2>
    ${other.length ? `<div class="table"><table class="ftable"><tbody>${other.map((f) => `<tr><td class="fn"><a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.name)}</a>${made(f)}</td><td class="fx">${esc(ext(f.name))}</td><td class="fs">${esc(size(f.size))}</td><td class="fd">${esc(when(f.mtime))}</td><td class="fdl"><a class="dl" href="${esc(f.url)}?download" title="download" aria-label="download ${esc(f.name)}">download</a></td></tr>`).join('')}</tbody></table></div>` : ''}
    ${d.engineAssets ? `<p class="engassets">${esc(count(d.engineAssets, 'Unreal asset'))} (.uasset, .umap): the engine's own files, opened in Unreal</p>` : ''}`);
  }
  return parts.length ? `<section class="files" aria-label="Files">${parts.join('\n')}</section>` : '';
}

const ext = (n: string) => { const i = n.lastIndexOf('.'); return i > 0 ? n.slice(i + 1).toLowerCase() : ''; };

/** The subfolders as cards; the empty ones as one line of links after them. */
function foldersSection(d: FolderPageData) {
  if (!d.folders.length) return '';
  const empty = d.folders.filter((f) => f.empty && !f.flags && !f.packages), cards = d.folders.filter((f) => !empty.includes(f));
  return `<section class="folders" aria-label="Folders"><h2>Folders <span class="count">${d.folders.length}${empty.length ? ` · ${empty.length} empty` : ''}</span></h2>
  ${cards.length ? `<div class="fgrid">${cards.map(folderCard).join('\n')}</div>` : ''}
  ${empty.length ? `<p class="empties"><span class="dim">Empty:</span> ${empty.map((f) => `<a href="${esc(f.url)}">${esc(f.name)}</a>`).join('<span class="dim">, </span>')}</p>` : ''}
</section>`;
}

export function folderPage(d: FolderPageData, u: Urls): string {
  const crumbs = d.crumbs.map((c, i) => (i === d.crumbs.length - 1 ? `<span aria-current="page">${esc(c.name)}</span>` : `<a href="${esc(c.url)}">${esc(c.name)}</a>`)).join('<span class="sep">/</span>');
  const empty = !d.notes.length && !d.folders.length && !d.files.length && !d.engineAssets && !d.package;
  const images = d.files.filter((f) => f.kind === 'image');
  // one note and pictures: the pictures beside the note on a wide screen; notes before pictures, folders or a
  // package's attachments stay short
  const split = d.notes.length === 1 && images.length > 0 && !d.package;
  const short = images.length > 0 || d.folders.length > 0 || !!d.package;
  const notes = split ? `<div class="split">${notesSection(d, short)}<section class="files side" aria-label="Images">${imagesPart(images)}</section></div>` : notesSection(d, short);
  return shell(`${d.title} · TopoTopo`, u, `<header class="bar">
  <a class="brand" href="${esc(u.home)}"><b>TopoTopo</b></a>
  <nav class="crumbs" aria-label="Folders">${crumbs}</nav>
  <button class="btn ghost" type="button" data-reveal title="open this folder in your file manager">Show folder</button>
</header>
<main class="wrap folder">
  <div class="head">
    <p class="kicker">${esc(d.kicker)}</p>
    <h1>${esc(d.title)}</h1>
    <p class="hstats">${esc(d.stats)}</p>
  </div>
  ${d.notice ? `<p class="notice">${esc(d.notice)}</p>` : ''}
  ${d.cut?.length ? `<p class="notice cut">Audited in part, a very large tree: ${esc(d.cut.join('; '))}. Flags past that are not counted.</p>` : ''}
  ${flagsSection(d)}
  ${d.package ? packageBlock(d.package, u) + packageCols(d.package) : ''}
  ${notes}
  ${d.package ? packageEnd(d.package, u) : ''}
  ${foldersSection(d)}
  ${d.uses?.length ? `<section class="wsuses">${usesSection(d.uses)}</section>` : ''}
  ${filesSection(d, u, !split)}
  ${empty ? '<p class="empty">This folder is empty.</p>' : ''}
  <p class="foot"><code>${esc(d.dir)}</code></p>
</main>
<dialog id="viewer" aria-label="View">
  <div class="vbar"><span class="vname"></span><a class="vopen" target="_blank" rel="noopener">Open</a><button type="button" class="vprev" aria-label="previous">‹</button><button type="button" class="vnext" aria-label="next">›</button><button type="button" class="vclose" aria-label="close">✕</button></div>
  <div class="vbody"></div>
</dialog>`, { page: 'folder', data: d.live });
}
