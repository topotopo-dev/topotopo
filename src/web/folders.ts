// The web app's folder pages, below the pages themselves (src/web/folder-page.ts): every registered workspace and
// library is a tree of folders, and this file reads that tree. Paths from a URL are checked to stay inside their root
// (no "..", no dot names, no symlink leading out); the plumbing a page never shows is left out (dot folders,
// node_modules, topotopo-packages, a package's versions/ and packages/, the engines' caches); a folder is listed with
// its subfolders and its files by type (images, audio, video, models, notes, the rest), the files engines write
// beside ours hidden and Unreal's assets counted; links in notes are resolved (relative to the note's folder, res://
// to the Godot project, /Game/ to Unreal's Content/, YouTube and Vimeo to their privacy players); files are served
// with ranges; and a tree is audited for its flags: links to missing files, previews that did not cook, versions not
// published, exports older than their graphs, published outputs no package of the workspace uses.
import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import { MANIFEST_EXT } from '../session.ts';
import { engineAbove, engineTypeOf, godotProjectOf } from '../engines.ts';
import type { EngineType } from '../engines.ts';
import { canonicalJSON } from '../io/source.ts';
import { sha256Hex } from '../core/sha256.ts';
import { jsonFormat, SIDECAR_FORMATS, SIDECAR_HEAD_BYTES } from '../io/sidecars.ts';
import { skippedName, isCheckout, WORKSPACE_FILE } from '../scan.ts';
import { escHtml, markdownLinks, renderMarkdown, slug } from './markdown.ts';
import type { LinkOut, MdLink } from './markdown.ts';

// ---------------------------------------------------------------------------------------------------------- roots

export type RootKind = 'w' | 'l';

/** A registered workspace ("w") or library ("l") as a tree of pages. */
export interface Root {
  kind: RootKind;
  /** its name in URLs: /w/<name>/, /l/<name>/ */
  name: string;
  /** absolute */
  dir: string;
  /** TopoTopo's built-in library */
  builtin?: boolean;
  /** the engine project its workspace file names (the project file, absolute) */
  engine: { type: EngineType; file: string } | null;
}

export const rootKey = (r: Pick<Root, 'kind' | 'name'>) => `${r.kind}/${r.name}`;

// ---------------------------------------------------------------------------------------------------------- files

export type FileKind = 'image' | 'audio' | 'video' | 'model' | 'note' | 'other';

const KINDS: Record<string, FileKind> = {
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image', '.gif': 'image', '.avif': 'image', '.bmp': 'image',
  '.wav': 'audio', '.ogg': 'audio', '.mp3': 'audio', '.flac': 'audio',
  '.mp4': 'video', '.webm': 'video',
  '.glb': 'model', '.gltf': 'model',
  '.md': 'note', '.txt': 'note',
};
export const kindOf = (name: string): FileKind => KINDS[path.extname(name).toLowerCase()] ?? 'other';

/** The media types files are served with; anything else is application/octet-stream. */
export const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif', '.bmp': 'image/bmp',
  '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.flac': 'audio/flac',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.pdf': 'application/pdf',
  '.svg': 'image/svg+xml', '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
};
/** Shown in the browser; everything else is a download (SVG and HTML among them: they run scripts). */
const INLINE = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp', '.wav', '.ogg', '.mp3', '.flac', '.mp4', '.webm', '.glb', '.gltf', '.bin', '.md', '.txt', '.log', '.csv', '.json', '.pdf']);

/** Files Godot writes beside the files it imports: hidden. */
const GODOT_SIDE = /\.(import|uid|translation)$/i;
/** Unreal's assets: counted, as one line. */
const UNREAL_ASSET = /\.(uasset|umap)$/i;

const isTopo = (f: string) => f.endsWith(MANIFEST_EXT) && f.length > MANIFEST_EXT.length;

/**
 * Why a folder named `name` is plumbing no page shows, or null: what the scan never enters (src/scan.ts: dot folders,
 * node_modules, topotopo-packages, the engines' caches and build folders), and a package's versions/ and packages/.
 * `parentFiles`: the files of the folder it is in, or a function that lists them (called only when they matter).
 */
export function plumbing(name: string, parentFiles: string[] | (() => string[])): string | null {
  const why = skippedName(name, parentFiles);
  if (why) return why;
  const l = name.toLowerCase();
  if ((l === 'versions' || l === 'packages') && (typeof parentFiles === 'function' ? parentFiles() : parentFiles).some(isTopo)) return `a package's ${l}/ folder`;
  return null;
}

/** Why a path from `base` along `parts` is not shown (a dot name or plumbing on the way, the last part included), or null. */
function hiddenOnWay(base: string, parts: string[]): string | null {
  let d = base;
  for (const p of parts) {
    const why = p.startsWith('.') ? `${p} is a dot name` : plumbing(p, () => filesIn(d));
    if (why) return why;
    d = path.join(d, p);
  }
  return null;
}

const leaves = (r: string) => r === '..' || r.startsWith(`..${path.sep}`) || path.isAbsolute(r);

/**
 * Where an existing `abs` really is below `top`, links and short names resolved (fs.realpathSync.native: a junction,
 * a symlink, a Windows 8.3 name like GIT~1, the letter case on disk): its posix path from `top`, or why it is not shown
 * (it leads out of `top`, or through a dot folder or plumbing by another name; `dotsOnly`: a dot name only).
 */
export function realBelow(top: string, abs: string, dotsOnly = false): { rel: string } | { why: string; out: boolean } {
  const outside = { why: 'it leads out of the folder', out: true };
  const relative = path.relative(path.resolve(top), path.resolve(abs));
  if (leaves(relative)) return outside;
  let realTop: string;
  try { realTop = fs.realpathSync.native(top); } catch { return { why: 'it cannot be read', out: false }; }
  let parts = relative ? relative.split(path.sep) : [], current = realTop, links = 0;
  while (parts.length) {
    const part = parts.shift()!;
    const hidden = part.startsWith('.') ? 'a dot name' : !dotsOnly && plumbing(part, () => filesIn(current));
    if (hidden) return { why: `hidden plumbing by another name (${hidden})`, out: false };
    const next = path.join(current, part);
    let st: fs.Stats | undefined;
    try { st = fs.lstatSync(next, { throwIfNoEntry: false }); } catch { return { why: 'it cannot be read', out: false }; }
    if (!st) {
      // A missing child still belongs to its canonical parent. Never probe through a hidden alias just to
      // distinguish a missing file from one that exists.
      const hiddenTail = dotsOnly ? parts.some((p) => p.startsWith('.')) : hiddenOnWay(current, [part, ...parts]);
      if (hiddenTail) return { why: 'hidden plumbing', out: false };
      current = path.join(next, ...parts);
      break;
    }
    if (st.isSymbolicLink()) {
      if (++links > 40) return { why: 'too many symbolic links', out: false };
      let target: string;
      try { target = fs.readlinkSync(next); } catch { return { why: 'it cannot be read', out: false }; }
      // readlink reads the link itself. Reject network and device targets before any call follows them.
      if (/^[\\/]{2}/.test(target)) return outside;
      const r = path.relative(realTop, path.resolve(current, target));
      if (leaves(r)) return outside;
      parts = [...(r ? r.split(path.sep) : []), ...parts];
      current = realTop;
      continue;
    }
    // With links checked one component at a time, native realpath only expands this component's short name
    // and letter case. Check that expanded name before proceeding to any child.
    try { current = fs.realpathSync.native(next); } catch { return { why: 'it cannot be read', out: false }; }
    const r = path.relative(realTop, current);
    if (leaves(r)) return outside;
    const canonical = r ? r.split(path.sep) : [];
    const why = dotsOnly ? canonical.some((p) => p.startsWith('.')) : hiddenOnWay(realTop, canonical);
    if (why) return { why: 'hidden plumbing by another name', out: false };
  }
  return { rel: path.relative(realTop, current).split(path.sep).join('/') };
}

/** fs.statSync that never throws (a path Windows refuses, a share that does not answer: not there). */
const statOf = (p: string) => { try { return fs.statSync(p, { throwIfNoEntry: false }) ?? null; } catch { return null; } };

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
/** File name order, numbers as numbers ("2-x" before "10-x"), case aside. */
export const byName = (a: string, b: string) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

export class PathError extends Error {
  status: number;
  constructor(status: number, msg: string) { super(msg); this.status = status; }
}

/**
 * The file or folder that URL path segments name below a root, or a PathError: each segment is percent-decoded and
 * must be a plain name (no "", ".", "..", dot names, separators, NUL, and on Windows no ":" or reserved characters);
 * no folder on the way may be plumbing; and with links and short names resolved the path must stay inside the root and
 * clear of plumbing too. `rel` is in the letter case on disk when only the case differs from the request.
 */
export function resolveIn(rootDir: string, segs: string[]): { abs: string; rel: string; parts: string[] } {
  const parts: string[] = [];
  for (const raw of segs) {
    let s: string;
    try { s = decodeURIComponent(raw); } catch { throw new PathError(400, 'a path segment is not valid percent-encoding'); }
    if (!s || s === '.' || s === '..' || s.startsWith('.') || /[\\/\u0000-\u001f]/.test(s) || (process.platform === 'win32' && (/[:*?"<>|]/.test(s) || /[. ]$/.test(s))))
      throw new PathError(400, `"${s}" is no file or folder name the web app serves (no "..", no dot names, no separators)`);
    parts.push(s);
  }
  const root = path.resolve(rootDir);
  const abs = path.join(root, ...parts);
  if (leaves(path.relative(root, abs))) throw new PathError(400, 'the path leaves the folder');
  if (!parts.length) return { abs, rel: '', parts };
  const real = realBelow(root, abs);
  if ('why' in real) throw real.out ? new PathError(400, 'the path leaves the folder (a link to elsewhere)') : new PathError(404, `not shown: ${real.why}`);
  if (!statOf(abs)) throw new PathError(404, `nothing at ${parts.join('/')}`);
  // the same folder asked for in another letter case is the one on disk (its flags and notices are found by that path)
  const asked = parts.join('/');
  return { abs, rel: real.rel.toLowerCase() === asked.toLowerCase() ? real.rel : asked, parts };
}

const filesIn = (dir: string) => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name); } catch { return []; } };

/**
 * Send a file: its media type (SVG, HTML and unknown types as downloads, `download` for any), a sandbox policy, an
 * ETag, and byte ranges (one range: 206 with Content-Range; past the end: 416).
 */
export function sendFile(req: http.IncomingMessage, res: http.ServerResponse, abs: string, o: { download?: boolean } = {}) {
  const st = fs.statSync(abs);
  const ext = path.extname(abs).toLowerCase();
  const name = path.basename(abs);
  const etag = `"${st.size.toString(36)}-${Math.round(st.mtimeMs).toString(36)}"`;
  const headers: Record<string, string> = {
    'content-type': MIME_TYPES[ext] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff', 'content-security-policy': 'sandbox',
    'accept-ranges': 'bytes', 'cache-control': 'no-cache', etag, 'last-modified': st.mtime.toUTCString(),
  };
  if (o.download || !INLINE.has(ext)) headers['content-disposition'] = `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;
  if (req.headers['if-none-match'] === etag && !req.headers.range) { res.writeHead(304, { etag, 'cache-control': 'no-cache' }); res.end(); return; }
  const size = st.size;
  let start = 0, end = size - 1, status = 200;
  const range = req.headers.range;
  const ifRange = req.headers['if-range'];
  if (range && (!ifRange || ifRange === etag)) {
    // one range: "bytes=a-b", "bytes=a-", "bytes=-n"; several ranges or another unit: the whole file
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m && (m[1] !== '' || m[2] !== '')) {
      if (m[1] === '') { start = Math.max(0, size - Number(m[2])); end = Number(m[2]) === 0 ? -1 : size - 1; }
      else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
      if (start >= size || start > end) {
        res.writeHead(416, { 'content-range': `bytes */${size}`, 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' });
        res.end('range not satisfiable');
        return;
      }
      status = 206;
      headers['content-range'] = `bytes ${start}-${end}/${size}`;
    }
  }
  headers['content-length'] = String(size ? end - start + 1 : 0);
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || !size) { res.end(); return; }
  const stream = fs.createReadStream(abs, { start, end });
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

// -------------------------------------------------------------------------------------------------------- listing

export interface FileEntry {
  name: string;
  /** posix path from the root */
  rel: string;
  size: number;
  mtime: number;
  kind: FileKind;
  /** an export TopoTopo made: what its sidecar records */
  made?: ExportMade;
}

/** What an export's recorded source says (src/io/source.ts). */
export interface ExportMade { graph: string; output: string | null; node: string; graph_sha256: string; vars: Record<string, unknown> }

export interface FolderEntry {
  name: string;
  rel: string;
  /** an engine project (project.godot, *.uproject): one card that opens on demand, never audited */
  engine?: { type: EngineType; title: string };
  /** another workspace (it holds topotopo-workspace.json) */
  workspace?: boolean;
  /** it holds a .topo file */
  package?: boolean;
  /** its own files (shown ones, as its page counts them) and subfolders */
  files: number;
  folders: number;
  /** its Unreal assets (*.uasset, *.umap), which its page shows as one line */
  unreal: number;
  /** its first image (posix path from the root) */
  image?: string;
}

export interface Listing {
  folders: FolderEntry[];
  /** every shown file but the notes, in file name order */
  files: FileEntry[];
  /** the .md and .txt files, in file name order */
  notes: FileEntry[];
  /** Unreal's *.uasset and *.umap files: one line */
  engineAssets: number;
  /** the .topo files: one makes the folder a package */
  topo: string[];
  /** the export source recorded for the folder itself (a textures folder's source.json) */
  made?: ExportMade;
}

/**
 * The files of a folder that its page lists (`names`: the folder's file names): dot files, the files engines write
 * beside ours and .topo files left out, Unreal's assets counted apart, an export's sidecar joined to the file it
 * describes. The folder cards, the front page and the folder page count by this.
 */
function shownFiles(abs: string, names: string[]): { shown: string[]; unreal: number } {
  const shown: string[] = [], side: string[] = [];
  let unreal = 0;
  for (const f of names) {
    if (f.startsWith('.') || GODOT_SIDE.test(f) || isTopo(f)) continue;
    if (UNREAL_ASSET.test(f)) { unreal++; continue; }
    (isSidecarName(f) ? side : shown).push(f);
  }
  const have = new Set(shown.filter((f) => kindOf(f) !== 'note'));
  for (const s of side) if (sidecarTargetName(s, (n) => have.has(n)) === undefined || !readSource(path.join(abs, s))) shown.push(s);
  return { shown, unreal };
}

/** A folder's look from outside: its shown files and folders, its first image, what it is. */
function peek(abs: string, rel: string): Omit<FolderEntry, 'name' | 'rel'> {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return { files: 0, folders: 0, unreal: 0 }; }
  const files = entries.filter((e) => e.isFile()).map((e) => e.name);
  const { shown, unreal } = shownFiles(abs, files);
  const out: Omit<FolderEntry, 'name' | 'rel'> = { files: shown.length, folders: 0, unreal };
  const project = files.find((f) => engineTypeOf(f));
  if (project) out.engine = { type: engineTypeOf(project)!, title: engineTitle(path.join(abs, project)) };
  if (files.includes(WORKSPACE_FILE)) out.workspace = true;
  if (files.some(isTopo)) out.package = true;
  const image = shown.filter((f) => kindOf(f) === 'image').sort(byName)[0];
  out.folders = entries.filter((e) => e.isDirectory() && !plumbing(e.name, files)).length;
  if (image) out.image = `${rel}/${image}`;
  return out;
}

/** An engine project's own name: project.godot's config/name, a .uproject's file name. */
export function engineTitle(file: string): string {
  if (engineTypeOf(file) === 'unreal') return path.basename(file).replace(/\.uproject$/i, '');
  try { return /^config\/name\s*=\s*"([^"]*)"/m.exec(fs.readFileSync(file, 'utf8'))?.[1] || path.basename(path.dirname(file)); } catch { return path.basename(path.dirname(file)); }
}

/**
 * A folder below a root (`rel` posix, '' for the root): its subfolders, files by type and notes; plumbing left out, and
 * links that lead out of `root` (when given).
 */
export function listFolder(abs: string, rel: string, root?: string): Listing {
  const at = (n: string) => (rel ? `${rel}/${n}` : n);
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { entries = []; }
  const fileNames = entries.filter((e) => e.isFile()).map((e) => e.name);
  const out: Listing = { folders: [], files: [], notes: [], engineAssets: 0, topo: fileNames.filter(isTopo).sort() };
  const sidecars: string[] = [];
  for (const e of entries.sort((a, b) => byName(a.name, b.name))) {
    let dir = e.isDirectory(), file = e.isFile();
    if (e.isSymbolicLink()) {
      // a link is shown when it leads somewhere inside the root, and not into plumbing (resolveIn checks it again when
      // it is opened)
      if (!root || 'why' in realBelow(root, path.join(abs, e.name))) continue;
      const st = statOf(path.join(abs, e.name));
      dir = !!st?.isDirectory();
      file = !!st?.isFile();
    }
    if (dir) {
      if (plumbing(e.name, fileNames)) continue;
      out.folders.push({ name: e.name, rel: at(e.name), ...peek(path.join(abs, e.name), at(e.name)) });
      continue;
    }
    if (!file || e.name.startsWith('.') || GODOT_SIDE.test(e.name) || isTopo(e.name)) continue;
    if (UNREAL_ASSET.test(e.name)) { out.engineAssets++; continue; }
    if (isSidecarName(e.name)) { sidecars.push(e.name); continue; }
    const st = fs.statSync(path.join(abs, e.name), { throwIfNoEntry: false });
    if (!st) continue;
    const f: FileEntry = { name: e.name, rel: at(e.name), size: st.size, mtime: Math.round(st.mtimeMs), kind: kindOf(e.name) };
    (f.kind === 'note' ? out.notes : out.files).push(f);
  }
  // sidecars: an export's recorded source joins the file it describes; one that describes nothing here is a file
  const byFile = new Map(out.files.map((f) => [f.name, f]));
  for (const s of sidecars) {
    const t = sidecarTargetName(s, (n) => byFile.has(n));
    const of = t === undefined ? undefined : t === null ? null : byFile.get(t)!;
    const made = of !== undefined ? readSource(path.join(abs, s)) : null;
    if (of === null && made) { out.made = made; continue; }
    if (of && made) { of.made = made; continue; }
    const st = fs.statSync(path.join(abs, s), { throwIfNoEntry: false });
    if (st) out.files.push({ name: s, rel: at(s), size: st.size, mtime: Math.round(st.mtimeMs), kind: 'other' });
  }
  out.files.sort((a, b) => byName(a.name, b.name));
  return out;
}

/** Names an export's sidecar may have (src/io/sidecars.ts): <file>.source.json, source.json, landscape.json, <base>.meshes.json, <base>.json. */
const isSidecarName = (n: string) => /\.json$/i.test(n) && n.toLowerCase() !== 'package.json';

/** The name of the file a sidecar describes, among those `has` knows (undefined: none, so not a sidecar; null: the folder itself). */
function sidecarTargetName(name: string, has: (n: string) => boolean): string | null | undefined {
  const l = name.toLowerCase();
  const first = (...c: string[]) => c.find(has);
  if (l.endsWith('.source.json')) return first(name.slice(0, -'.source.json'.length));
  if (l === 'source.json' || l === 'landscape.json') return null;
  if (l.endsWith('.meshes.json')) { const b = name.slice(0, -'.meshes.json'.length); return first(`${b}.csv`, `${b}.points.json`); }
  const b = name.slice(0, -'.json'.length);
  return first(`${b}.png`, `${b}.r16`);
}

/** The export source a sidecar records (its "format" names a TopoTopo sidecar), or null. */
export function readSource(file: string): ExportMade | null {
  try {
    const fd = fs.openSync(file, 'r');
    let head: Buffer;
    try { head = Buffer.alloc(SIDECAR_HEAD_BYTES); fs.readSync(fd, head, 0, SIDECAR_HEAD_BYTES, 0); } finally { fs.closeSync(fd); }
    const fmt = jsonFormat(head);
    if (!fmt || !SIDECAR_FORMATS[fmt] || fs.statSync(file).size > 8 * 2 ** 20) return null;
    return madeOf(JSON.parse(fs.readFileSync(file, 'utf8'))?.source);
  } catch { return null; }
}

const madeOf = (s: any): ExportMade | null =>
  s && typeof s === 'object' && typeof s.graph === 'string' && typeof s.graph_sha256 === 'string'
    ? { graph: s.graph, output: typeof s.output === 'string' ? s.output : null, node: String(s.node ?? ''), graph_sha256: s.graph_sha256, vars: s.vars && typeof s.vars === 'object' ? s.vars : {} }
    : null;

/** The source a GLB or glTF export carries in asset.extras.source, or null (its JSON is read, never its buffers). */
export function modelSource(file: string): ExportMade | null {
  try {
    if (/\.gltf$/i.test(file)) return fs.statSync(file).size <= 16 * 2 ** 20 ? madeOf(JSON.parse(fs.readFileSync(file, 'utf8'))?.asset?.extras?.source) : null;
    const fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(20);
      if (fs.readSync(fd, head, 0, 20, 0) < 20 || head.toString('latin1', 0, 4) !== 'glTF' || head.readUInt32LE(16) !== 0x4e4f534a) return null;
      const len = head.readUInt32LE(12);
      if (len > 16 * 2 ** 20) return null;
      const json = Buffer.alloc(len);
      fs.readSync(fd, json, 0, len, 20);
      return madeOf(JSON.parse(json.toString('utf8'))?.asset?.extras?.source);
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

/**
 * Whether the graph an export was made from changed since (the hash it recorded is not the graph file's, with the
 * vars it was made with); null when the graph cannot be read.
 */
export function exportStale(graphFile: string, m: ExportMade): boolean | null {
  let g: any;
  try { g = JSON.parse(fs.readFileSync(graphFile, 'utf8')); } catch { return null; }
  if (sha256Hex(canonicalJSON(g)) === m.graph_sha256) return false;
  if (g && typeof g === 'object' && g.vars && typeof g.vars === 'object' && sha256Hex(canonicalJSON({ ...g, vars: m.vars })) === m.graph_sha256) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------------------- links

/** Where a link in a note leads. */
export type LinkTarget =
  /** a web address; `player`: the privacy player of a YouTube or Vimeo video */
  | { t: 'web'; url: string; player?: string }
  /** a heading of the note itself ("#usage") */
  | { t: 'anchor'; id: string }
  /**
   * a file or folder: `rel` from the root (null: in the engine project, outside the root), whether it is there; `hash`
   * names a heading in a note
   */
  | { t: 'path'; abs: string; rel: string | null; exists: boolean; dir: boolean; hash: string }
  /** not a link here: it stays text (`why` says) */
  | { t: 'text'; why: string };

const YT_ID = /^[A-Za-z0-9_-]{11}$/;

/** A YouTube or Vimeo address as its privacy player's address (youtube-nocookie.com, player.vimeo.com), or null. */
export function videoPlayer(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase().replace(/^(www\.|m\.)/, '');
  const seconds = (t: string | null) => {
    if (!t) return 0;
    const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(t);
    return m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : 0;
  };
  let id: string | null = null;
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com' || host === 'music.youtube.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else { const m = /^\/(?:embed|shorts|live|v)\/([^/?#]+)/.exec(u.pathname); id = m?.[1] ?? null; }
  }
  if (id !== null) {
    if (!YT_ID.test(id)) return null;
    const start = seconds(u.searchParams.get('t') ?? u.searchParams.get('start'));
    return `https://www.youtube-nocookie.com/embed/${id}${start ? `?start=${start}` : ''}`;
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const m = /^\/(?:video\/|channels\/[^/]+\/|groups\/[^/]+\/videos\/)?(\d{3,12})(?:\/([0-9a-f]{6,20}))?\/?$/i.exec(u.pathname);
    if (!m) return null;
    const h = m[2] ?? u.searchParams.get('h');
    return `https://player.vimeo.com/video/${m[1]}?dnt=1${h && /^[0-9a-f]{6,20}$/i.test(h) ? `&h=${h}` : ''}`;
  }
  return null;
}

/**
 * Where a link written in a note in `folder` leads, below `root`: a web address; a heading of the note ("#usage"); a
 * path relative to the folder, from the root when it starts with "/", res:// from the Godot project (the workspace's
 * engine, else the one the folder is in), /Game/ from Unreal's Content/ (with .uasset or .umap added when that is the
 * file); anything else stays text. A path is judged by its letters before the file system is asked anything: one that
 * is absolute (a drive, a network share \\host\share), leaves the root (or the engine project), or passes a dot folder
 * or plumbing stays text and is never looked up; only what is left is, and then by where it really is (links and short
 * names resolved). A lookup that fails says "not there"; this never throws.
 */
export function resolveLink(root: Root, folder: string, href: string): LinkTarget {
  const h = href.trim();
  if (!h) return { t: 'text', why: 'an empty link' };
  if (/^https?:\/\//i.test(h)) { const player = videoPlayer(h); return { t: 'web', url: h, ...(player ? { player } : {}) }; }
  if (/^mailto:/i.test(h)) return { t: 'web', url: h };
  if (h.startsWith('#')) return { t: 'anchor', id: h.slice(1) };
  /** where the path is read from, and what it must stay inside */
  let base: string, scope: string, p: string, game = false;
  if (/^res:\/\//i.test(h)) {
    const godot = root.engine?.type === 'godot' ? path.dirname(root.engine.file) : godotProjectOf(folder);
    if (!godot) return { t: 'text', why: 'res:// names a file of a Godot project, and there is none here' };
    base = scope = godot;
    p = h.slice('res://'.length);
  } else if (/^\/Game\//.test(h)) {
    const ue = root.engine?.type === 'unreal' ? root.engine.file : (() => { const a = engineAbove(folder); return a?.type === 'unreal' ? a.file : null; })();
    if (!ue) return { t: 'text', why: '/Game/ names an asset of an Unreal project, and there is none here' };
    base = scope = path.join(path.dirname(ue), 'Content');
    p = h.slice('/Game/'.length);
    game = true;
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith('//') || h.startsWith('\\')) {
    return { t: 'text', why: 'only web addresses and paths inside this tree are links in a note' };
  } else if (h.startsWith('/')) {
    base = scope = root.dir;
    p = h.slice(1);
  } else {
    base = folder;
    scope = root.dir;
    p = h;
  }
  const hashAt = p.indexOf('#');
  const hash = hashAt >= 0 ? p.slice(hashAt + 1) : '';
  p = (hashAt >= 0 ? p.slice(0, hashAt) : p).split('?')[0];
  try { p = decodeURIComponent(p); } catch { /* as written */ }
  // judged by its letters: no control characters, nothing absolute (a drive, \\host\share, a second leading slash)
  if (/[\u0000-\u001f]/.test(p)) return { t: 'text', why: 'not a file name' };
  if (/^[\\/]/.test(p) || /^[A-Za-z]:/.test(p) || path.isAbsolute(p)) return { t: 'text', why: 'an absolute path: a note links to files inside this tree' };
  let abs = path.resolve(base, p);
  const r = path.relative(path.resolve(scope), abs);
  if (leaves(r)) return { t: 'text', why: 'outside this tree' };
  const real = realBelow(scope, abs);
  if ('why' in real) return { t: 'text', why: real.out ? 'outside this tree' : `not shown: ${real.why}` };
  // only now is the file system asked
  let st = statOf(abs);
  if (!st && game) {
    // /Game/Props/SM_Crate or /Game/Props/SM_Crate.SM_Crate: the package file SM_Crate.uasset (or a map's .umap)
    const noObj = abs.replace(/\.[^.\\/]+$/, '');
    for (const c of [abs + '.uasset', abs + '.umap', noObj + '.uasset', noObj + '.umap']) {
      const s = statOf(c);
      if (s) { abs = c; st = s; break; }
    }
  }
  const lexical = () => { const x = path.relative(path.resolve(root.dir), abs); return leaves(x) ? null : x.split(path.sep).join('/'); };
  if (!st) return { t: 'path', abs, rel: lexical(), exists: false, dir: false, hash };
  // where it really is: a link or short name that leads out, or into plumbing, stays text
  const inRoot = realBelow(root.dir, abs);
  return { t: 'path', abs, rel: 'rel' in inRoot ? inRoot.rel : null, exists: true, dir: st.isDirectory(), hash };
}

/** What a note's page needs to show its links: the URLs of the root's pages and files, and a folder's card. */
export interface NoteEnv {
  root: Root;
  folderUrl(rel: string): string;
  fileUrl(rel: string): string;
  modelUrl(rel: string): string;
  /** the address of a note's box (`rel` the note's path from the root), at one of its headings when `anchor` names one */
  noteUrl(rel: string, anchor: string): string;
  /** a folder as a card: a package's title and preview, else the folder's name and first image */
  card(rel: string, abs: string): { title: string; sub: string; thumb?: string };
}

/** The anchor of a note on its folder's page. */
export const noteId = (name: string) => `note-${name.replace(/[^A-Za-z0-9_.-]/g, '-')}`;
/** What a note's heading ids start with on its folder's page: the note's anchor, so a link can name a heading of another note. */
export const headingPrefix = (name: string) => `${noteId(name)}--`;
const decodeSafe = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
/** A heading's anchor in the note `name`, from what a link writes after "#" ("Usage", "usage"). */
export const headingId = (name: string, hash: string) => headingPrefix(name) + slug(decodeSafe(hash));

const fileName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** An image's size in pixels from its header (PNG, GIF, JPEG, WebP), kept while the file is unchanged; null when unknown. */
const sizes = new Map<string, { key: string; size: { w: number; h: number } | null }>();
export function imageSize(file: string): { w: number; h: number } | null {
  const st = statOf(file);
  if (!st?.isFile()) return null;
  const key = `${st.size}-${st.mtimeMs}`, have = sizes.get(file);
  if (have?.key === key) return have.size;
  let size: { w: number; h: number } | null = null;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(Math.min(st.size, 64 * 1024));
      fs.readSync(fd, head, 0, head.length, 0);
      size = headerSize(head, (at, n) => { const b = Buffer.alloc(n); const got = fs.readSync(fd, b, 0, n, at); return b.subarray(0, got); });
    } finally { fs.closeSync(fd); }
  } catch { size = null; }
  if (sizes.size > 4096) sizes.clear();
  sizes.set(file, { key, size });
  return size;
}

function headerSize(b: Buffer, more: (at: number, n: number) => Buffer): { w: number; h: number } | null {
  const ok = (w: number, h: number) => (w > 0 && h > 0 && w < 100_000 && h < 100_000 ? { w, h } : null);
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString('latin1', 12, 16) === 'IHDR') return ok(b.readUInt32BE(16), b.readUInt32BE(20));
  if (b.length >= 10 && b.toString('latin1', 0, 4) === 'GIF8') return ok(b.readUInt16LE(6), b.readUInt16LE(8));
  if (b.length >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = b.toString('latin1', 12, 16);
    if (chunk === 'VP8 ') return ok(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
    if (chunk === 'VP8L') return ok(1 + (((b[22] & 0x3f) << 8) | b[21]), 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)));
    if (chunk === 'VP8X') return ok(1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3));
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    // JPEG: the markers up to the frame header (SOFn), which may lie past a large EXIF block
    let at = 2;
    for (let guard = 0; guard < 512; guard++) {
      const m = more(at, 10);
      if (m.length < 4 || m[0] !== 0xff) return null;
      const marker = m[1];
      if (marker === 0xff) { at++; continue; }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { at += 2; continue; }
      const len = m.readUInt16BE(2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return m.length >= 9 ? ok(m.readUInt16BE(7), m.readUInt16BE(5)) : null;
      if (len < 2) return null;
      at += 2 + len;
    }
  }
  return null;
}

/** An inline link of a note that names what it leads to with a small icon ("lk-dir", "lk-pkg", "lk-img" …). */
const inlineLink = (kind: string, href: string, label: string, extra = '') => `<a class="lk lk-${kind}" href="${escHtml(href)}"${extra}>${label}</a>`;

/**
 * A link of a note as HTML, by what it leads to: an image, audio and video in a player, a model as a 3D view on
 * click, a folder or package as a card, a note as a link to its box (or one of its headings), a heading of the note
 * itself, YouTube and Vimeo in their privacy players, a missing file struck through (`broken` gets it), anything else
 * a plain link. The author's words stay: a card is titled with the link's text (the folder's name and counts below
 * it), a linked image carries it as a caption. A card, picture or player is shown in place when the link stands alone
 * in its paragraph or list item (`at.alone`); in running text the link stays a link, marked with an icon, and the
 * card, picture or player follows the paragraph (`block`).
 */
export function linkHtml(env: NoteEnv, folder: string, l: MdLink, inner: string, broken: string[], at: { alone: boolean; idPrefix: string } = { alone: false, idPrefix: '' }): LinkOut {
  const t = resolveLink(env.root, folder, l.href);
  const label = inner || escHtml(l.text || l.href);
  const words = l.text && l.text !== l.href ? l.text : '';
  const place = (inline: string, block: string): LinkOut => (at.alone ? { inline: '', block } : { inline, block });
  if (t.t === 'text') return `<span class="lnk-text" title="${escHtml(t.why)}">${label}</span>`;
  if (t.t === 'anchor') return `<a href="#${escHtml(at.idPrefix + slug(decodeSafe(t.id)))}">${label}</a>`;
  if (t.t === 'web') {
    if (t.player) {
      const player = `<span class="embed web"><iframe src="${escHtml(t.player)}" title="${escHtml(words || 'video')}" loading="lazy" allow="encrypted-media; picture-in-picture; fullscreen" referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"></iframe>`
        + `<a class="cap" href="${escHtml(t.url)}" target="_blank" rel="noopener noreferrer">${label}</a></span>`;
      return place(`<a class="lk lk-video" href="${escHtml(t.url)}" target="_blank" rel="noopener noreferrer">${label}</a>`, player);
    }
    return `<a href="${escHtml(t.url)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  }
  if (!t.exists) {
    broken.push(l.href);
    return `<s class="missing" title="${escHtml(`missing: ${l.href}`)}">${label}</s>`;
  }
  if (t.rel === null) return `<span class="lnk-text" title="${escHtml('outside this tree')}">${label}</span>`;
  if (t.dir) {
    const c = env.card(t.rel, t.abs);
    const href = env.folderUrl(t.rel);
    // the author's words as the title; what the folder is below them
    const title = words || c.title, sub = words ? `${c.title} · ${c.sub}` : c.sub;
    const card = `<a class="lcard" href="${escHtml(href)}">${c.thumb ? `<img src="${escHtml(c.thumb)}" alt="" loading="lazy">` : '<span class="lcard-icon"></span>'}<span><b>${escHtml(title)}</b><span>${escHtml(sub)}</span></span></a>`;
    return place(inlineLink(c.sub.startsWith('package') ? 'pkg' : 'dir', href, label), card);
  }
  const url = env.fileUrl(t.rel);
  const fname = escHtml(fileName(t.rel));
  const cap = words ? escHtml(words) : fname;
  switch (kindOf(t.abs)) {
    case 'image': {
      const s = imageSize(t.abs);
      const img = `<img src="${escHtml(url)}" alt="${escHtml(l.text)}"${s ? ` width="${s.w}" height="${s.h}"` : ''} loading="lazy">`;
      const pic = `<a class="limg" href="${escHtml(url)}" data-view="image" data-name="${fname}">${img}</a>`;
      // an image written as an image is a picture where it stands; a link to one keeps its words as a caption
      if (l.image) return pic;
      return place(inlineLink('img', url, label, ` data-view="image" data-name="${fname}"`), `<figure class="lfig">${pic}<figcaption>${cap}</figcaption></figure>`);
    }
    case 'audio': return place(inlineLink('audio', url, label), `<span class="embed audio"><span class="cap">${cap}</span><audio controls preload="metadata" src="${escHtml(url)}"></audio></span>`);
    case 'video': return place(inlineLink('video', url, label), `<span class="embed video"><video controls preload="metadata" src="${escHtml(url)}"></video><span class="cap">${cap}</span></span>`);
    case 'model': {
      const view = ` data-view="model" data-src="${escHtml(env.modelUrl(t.rel))}" data-name="${fname}"`;
      return place(inlineLink('model', env.modelUrl(t.rel), label, view), `<button type="button" class="lmodel"${view}><span class="cube"></span><span><b>${cap}</b><span>${words && words !== fileName(t.rel) ? `${fname} · ` : ''}View in 3D</span></span></button>`);
    }
    case 'note': {
      const name = fileName(t.rel);
      return `<a href="${escHtml(env.noteUrl(t.rel, t.hash ? headingId(name, t.hash) : noteId(name)))}">${label}</a>`;
    }
    default: return `<a href="${escHtml(url)}">${label}</a>`;
  }
}

/** Notes longer than this are linked, not shown. */
export const MAX_NOTE_BYTES = 1024 * 1024;

/** Web addresses in plain text, linked: found in the raw text, then each piece escaped (a "&" or "'" stays in its address). */
export function linkText(text: string): string {
  let out = '', last = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s<>"]+/gi)) {
    let url = m[0];
    // trailing punctuation ends the sentence, not the address; so does a ")" without its "("
    while (/[.,:;!?'"*_~]$/.test(url)) url = url.slice(0, -1);
    while (url.endsWith(')') && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) url = url.slice(0, -1);
    out += escHtml(text.slice(last, m.index)) + `<a href="${escHtml(url)}" target="_blank" rel="noopener noreferrer">${escHtml(url)}</a>`;
    last = m.index! + url.length;
  }
  return out + escHtml(text.slice(last));
}

/** A note (.md rendered, .txt as text with its web addresses linked) as HTML, and the links in it to missing files. */
export function noteHtml(env: NoteEnv, folder: string, file: string, idPrefix: string): { html: string; broken: string[]; long: boolean } {
  const broken: string[] = [];
  let text: string;
  try {
    if (fs.statSync(file).size > MAX_NOTE_BYTES) return { html: '', broken, long: true };
    text = fs.readFileSync(file, 'utf8');
  } catch { return { html: '<p class="dim">This note cannot be read.</p>', broken, long: false }; }
  if (/\.txt$/i.test(file)) return { html: `<pre class="txt">${linkText(text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'))}</pre>`, broken, long: false };
  const html = renderMarkdown(text, { idPrefix, link: (l, inner, at) => linkHtml(env, folder, l, inner, broken, { alone: at.alone, idPrefix }) });
  return { html, broken, long: false };
}

// ---------------------------------------------------------------------------------------------------------- flags

export type FlagKind = 'link' | 'bake' | 'publish' | 'export' | 'unused' | 'workspace';

/** Something TopoTopo can tell is wrong in a folder, and the one thing to do about it. */
export interface Flag {
  kind: FlagKind;
  /** the folder it is in: posix path from the root ('' for the root) */
  at: string;
  what: string;
  todo: string;
  /** a broken link's note (its file name) */
  note?: string;
}

/** A tree's walk: its folders and files (plumbing and engine projects left out), a few images, its notes' broken links. */
export interface Walk {
  folders: number;
  files: number;
  notes: number;
  /** the first images, nearest the root first (posix paths from the root) */
  images: string[];
  /** folders holding an engine project below the root: browsable, not audited */
  engines: string[];
  flags: Flag[];
  /** where the walk stopped short, in words ("the first 10,000 notes were checked for links"): flags past it are not counted */
  cut: string[];
  ms: number;
}

/** How far a walk goes: folders deep, folders in all, notes whose links it checks. */
export interface WalkLimits { depth: number; folders: number; notes: number }
export const WALK_LIMITS: WalkLimits = { depth: 16, folders: 50_000, notes: 10_000 };

/** The links of the notes a walk read, kept while each note is unchanged (its size and time): a walk again reads only what changed. */
export type NoteLinks = Map<string, { key: string; hrefs: string[] }>;

export interface WalkOptions {
  limits?: Partial<WalkLimits>;
  /** the notes' links from earlier walks (the walk adds to it) */
  links?: NoteLinks;
  /** give the event loop a turn after this many milliseconds of work (a server's pages and files keep answering) */
  slice?: number;
}

const turn = () => new Promise<void>((r) => setImmediate(r));

/**
 * Walk a root: count its folders and files (as its pages count them), keep its first images, and check every link of
 * its notes (.md files), a flag for each that leads to a missing file. Engine projects below the root, other
 * workspaces and TopoTopo checkouts are not entered (as the scan); plumbing is not either. A walk that stops short
 * says where (`cut`).
 */
export async function walkTree(root: Root, o: WalkOptions = {}): Promise<Walk> {
  const t0 = performance.now();
  const lim = { ...WALK_LIMITS, ...o.limits };
  const out: Walk = { folders: 0, files: 0, notes: 0, images: [], engines: [], flags: [], cut: [], ms: 0 };
  const top = path.resolve(root.dir);
  const queue: { abs: string; rel: string; depth: number }[] = [{ abs: top, rel: '', depth: 0 }];
  let since = performance.now(), deep = false, many = false, notesCut = false;
  const pause = async () => { if (o.slice !== undefined && performance.now() - since > o.slice) { await turn(); since = performance.now(); } };
  for (let qi = 0; qi < queue.length; qi++) {
    await pause();
    const { abs, rel, depth } = queue[qi];
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { continue; }
    const files = entries.filter((e) => e.isFile()).map((e) => e.name);
    if (rel) {
      if (files.some((f) => engineTypeOf(f))) { out.engines.push(rel); continue; }
      if (files.includes(WORKSPACE_FILE) || (files.includes('package.json') && isCheckout(abs))) continue;
    }
    const { shown } = shownFiles(abs, files);
    out.files += shown.length;
    for (const f of shown.sort(byName)) {
      if (kindOf(f) === 'image' && out.images.length < 8) out.images.push(rel ? `${rel}/${f}` : f);
      if (!/\.md$/i.test(f)) continue;
      if (out.notes >= lim.notes) { notesCut = true; continue; }
      out.notes++;
      for (const href of noteHrefs(path.join(abs, f), o.links)) {
        // one link that cannot be looked up never hides the others
        let t: LinkTarget;
        try { t = resolveLink(root, abs, href); } catch { continue; }
        if (t.t === 'path' && !t.exists) out.flags.push({ kind: 'link', at: rel, note: f, what: `${f} links to ${href}, which is not there`, todo: 'Fix the link, or put the file there' });
      }
      await pause();
    }
    for (const e of entries) {
      if (!e.isDirectory() || plumbing(e.name, files)) continue;
      out.folders++;
      if (depth + 1 > lim.depth) { deep = true; continue; }
      if (queue.length >= lim.folders) { many = true; continue; }
      queue.push({ abs: path.join(abs, e.name), rel: rel ? `${rel}/${e.name}` : e.name, depth: depth + 1 });
    }
  }
  if (many) out.cut.push(`the first ${lim.folders.toLocaleString('en')} folders were audited`);
  if (deep) out.cut.push(`folders more than ${lim.depth} below the root were not audited`);
  if (notesCut) out.cut.push(`the first ${lim.notes.toLocaleString('en')} notes were checked for links`);
  out.ms = Math.round(performance.now() - t0);
  return out;
}

/** The links a note makes (each once), from `cache` while the note is unchanged. */
function noteHrefs(file: string, cache?: NoteLinks): string[] {
  const st = statOf(file);
  if (!st || st.size > MAX_NOTE_BYTES) return [];
  const key = `${st.size}-${st.mtimeMs}`, have = cache?.get(file);
  if (have?.key === key) return have.hrefs;
  let hrefs: string[] = [];
  try { hrefs = [...new Set(markdownLinks(fs.readFileSync(file, 'utf8')).map((l) => l.href))]; } catch { /* unreadable: no links */ }
  cache?.set(file, { key, hrefs });
  return hrefs;
}

/** The node types a graph file's nodes have, nested graphs included ("owner/name/output" when it uses a package). */
export function graphTypes(file: string): string[] {
  let g: any;
  try { g = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
  const out = new Set<string>();
  const walk = (x: any, depth: number) => {
    if (!x || typeof x !== 'object' || depth > 32) return;
    if (Array.isArray(x)) { for (const v of x) walk(v, depth + 1); return; }
    if (x.nodes && typeof x.nodes === 'object' && !Array.isArray(x.nodes)) {
      for (const n of Object.values<any>(x.nodes)) {
        if (n && typeof n.type === 'string') out.add(n.type);
        if (n && n.params && typeof n.params === 'object') walk(n.params, depth + 1);
      }
      return;
    }
    for (const v of Object.values(x)) walk(v, depth + 1);
  };
  walk(g, 0);
  return [...out];
}

/** Exports below a package's exports/ with the source each records: sidecars, and GLB / glTF files that carry one. */
export function exportSources(dir: string): { rel: string; made: ExportMade }[] {
  const out: { rel: string; made: ExportMade }[] = [];
  const walk = (abs: string, rel: string, depth: number) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    const names = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
    for (const e of entries.sort((a, b) => byName(a.name, b.name))) {
      if (e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (depth < 8) walk(path.join(abs, e.name), r, depth + 1); continue; }
      if (isSidecarName(e.name)) {
        const made = readSource(path.join(abs, e.name));
        if (made) out.push({ rel: e.name.toLowerCase().endsWith('.source.json') ? r.slice(0, -'.source.json'.length) : r, made });
      } else if (/\.(glb|gltf)$/i.test(e.name) && !names.has(`${e.name}.source.json`)) {
        const made = modelSource(path.join(abs, e.name));
        if (made) out.push({ rel: r, made });
      }
    }
  };
  walk(path.join(dir, 'exports'), '', 0);
  return out;
}
