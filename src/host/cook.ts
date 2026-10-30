// The engine-neutral cook of a package's published outputs into an engine project (`topotopo cook … --for godot`; the
// Godot flavour is src/host/godot.ts): which outputs, the recording host that learns what each output reads, the
// per-output incremental cook, the writing rules (write only changed bytes, never a foreign file, a failed output
// keeps its last good files, orphans), the record, freshness, the shared cook cache, the report and the progress lines.
//
// What is cooked: the package's published outputs (packageOutputs, the rule publishing uses) from its working folder
// at frame 1 with their graphs' var defaults, under --locked rules (nothing of the package is written but its outputs
// and its record; a graph naming a package it does not use, a missing or edited copy, fail that output). Used packages
// come from their pinned copies; working folders are never followed.
//
// The record, <package>/.topotopo/<for>.json, is committed with the outputs: canonical JSON (sorted keys, 2-space
// indent, LF, trailing newline), no times and no machine paths: sources relative to the package (posix), output files
// as the engine names them (res:// in Godot). Same inputs and version give byte-identical outputs and record.
//   {"folders": {<folder>: [<files below it>]}, "for": "godot", "name": <publish name or null>, "notes": [...],
//    "options": {"folder", "instancing", "per_output_folders", "skip"}, "orphans": {<file>: <output>},
//    "outputs": {<id>: {"default", "deps", "errors", "files": {<file>: <sha256>}, "folders", "graph", "instances",
//                       "kind", "label", "node", "state": "ok" | "failed", "warnings"}},
//    "package": <id>, "schema": 1, "skipped": {<id>: {"why", ...}}, "sources": {<file>: <contentSha>}, "topotopo": <version>}
// Source hashes are contentSha (src/packages/registry.ts: text with CRLF read as LF, binary formats raw); output file
// hashes are raw SHA-256. Freshness (freshness() below; the Godot addon ports it byte for byte, integrations/godot/
// PROTOCOL.md) checks, in order: no record, schema and flavour, options, sources, folder listings, output files, the
// installed version, failed outputs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Engine } from '../graph/engine.ts';
import type { Issue } from '../graph/engine.ts';
import type { Kind } from '../graph/outputs.ts';
import type { GraphSpec } from '../graph/types.ts';
import { packagesNamedIn, packagesUsed } from '../graph/packages.ts';
import type { Geometry } from '../core/geometry.ts';
import { kindMismatch, outputKind, publishedKind } from '../io/kinds.ts';
import { packedSourceNames } from '../io/common.ts';
import { PackageUses, contentSha, loadPackage, packageOutputs } from '../packages/registry.ts';
import type { InvalidOutput, PackageOutput } from '../packages/registry.ts';
import { WORKSPACE_FILE, copiesFor, locate, readManifest, renameInto, takeLock, writeAtomic } from '../package.ts';
import { isEngineFile } from '../engines.ts';
import { graphFiles } from '../session.ts';
import { folderKey } from '../scan.ts';
import { createNodeHost } from './node.ts';
import type { Host, HostFiles, WorkerPool } from './types.ts';
import { TOPOTOPO_VERSION } from './version.ts';

/** The jobs file's and report's protocol: an engine plugin that speaks another one is told to update. */
export const COOK_PROTOCOL = 1;
/** The record's schema. */
export const RECORD_SCHEMA = 1;
/** The package's folder of TopoTopo's engine files (a dot folder: engines never import it). */
export const RECORD_DIR = '.topotopo';
/** A file being written: <file>.topotopo-part, moved into place. */
export const PART_SUFFIX = '.topotopo-part';
/** The folders whose listings every record holds. */
export const LISTED_FOLDERS = ['assets', 'graphs', 'inputs'];
/** Why an output listed in the options' skip is not cooked. */
export const SKIPPED_BY_OPTIONS = "listed in the import options' skip (outputs/skip)";

export type OutputState = 'written' | 'unchanged' | 'cached' | 'failed' | 'skipped';
/** An error of an output: the node (or ''), the message and its hint (or ''). */
export interface CookIssue { node: string; message: string; hint: string }

/** An engine cook's options as the record holds them. */
export interface EngineOptions {
  /** the folder of the outputs, as the engine names it ("res://assets/props") */
  folder: string;
  instancing: 'packed' | 'expand';
  /** each output in a folder of its own, <folder>/<id>/ */
  per_output_folders: boolean;
  /** output ids not cooked, sorted */
  skip: string[];
}

/** The record of an output. */
export interface RecordOutput {
  default: boolean;
  /** the files it read, relative to the package (posix), sorted */
  deps: string[];
  errors: CookIssue[];
  /** its files as the engine names them, with their SHA-256 (a failed output: its last good files) */
  files: Record<string, string>;
  /** the folders it listed, relative to the package */
  folders: string[];
  graph: string;
  /** packed instances by source name */
  instances: Record<string, number>;
  kind: string;
  label: string;
  node: string;
  state: 'ok' | 'failed';
  warnings: string[];
}

/** An output not cooked into the engine: listed in the options' skip, or of a kind the engine does not import. */
export interface RecordSkipped { why: string; kind?: string; graph?: string; node?: string; label?: string; deps?: string[]; folders?: string[] }

export interface CookRecord {
  folders: Record<string, string[]>;
  for: string;
  name: string | null;
  notes: string[];
  options: EngineOptions;
  orphans: Record<string, string>;
  outputs: Record<string, RecordOutput>;
  package: string;
  schema: number;
  skipped: Record<string, RecordSkipped>;
  sources: Record<string, string>;
  topotopo: string;
}

/** What one output's cook wrote: its files in its folder, by name. */
export interface WrittenFiles { files: { name: string; bytes: Uint8Array }[]; warnings: string[] }

/** What an engine's flavour of the cook supplies (src/host/godot.ts). */
export interface Flavour {
  /** the engine: "godot" */
  for: string;
  /** the engine project's folder (absolute) */
  project: string;
  /** why outputs of a kind are not imported by the engine, or null */
  skipKind(kind: Kind): string | null;
  /** an output's folder (absolute) */
  outputDir(o: EngineOptions, id: string): string;
  /** the files of a cooked output (`host`: the cook's, whose reads are recorded) */
  write(geo: Geometry, x: { id: string; output: PackageOutput; kind: Kind; options: EngineOptions; packageName: string; packages: Record<string, string>; host: Host }): Promise<WrittenFiles>;
  /** a file as the record and the report name it (res://…), and back */
  recordPath(abs: string): string;
  absolutePath(recorded: string): string;
  /** the package a file at an output path says it was cooked for (a GLB's source block, a PNG's tEXt chunk), or null */
  ownerOf(abs: string): string | null;
  /** the package's TopoTopo folders the engine imports (no .gdignore): "graphs/" … */
  exposed(dir: string): string[];
}

/** One package to cook. */
export interface CookJob {
  /** the package folder and its manifest (absolute) */
  dir: string;
  topo: string;
  id: string;
  options: EngineOptions;
  /** take over files at the output paths that no record lists and no source block names */
  adopt?: boolean;
  /** the report file to write (absolute), always, also on failure */
  report?: string;
  /** seconds; the cook stops and the remaining outputs fail */
  timeout?: number;
}

export interface CookFlags {
  /** recook every output, ignoring the record and the cache */
  force?: boolean;
  /** no cache lookup (results are still stored) */
  noCache?: boolean;
  /** a progress line (JSON, ASCII) */
  progress?: (line: string) => void;
}

export interface OutputReport {
  id: string;
  label: string;
  kind: string;
  default: boolean;
  state: OutputState;
  files: string[];
  written: string[];
  instances: Record<string, number>;
  /** cooked in this run (by the engine or from the cache), not carried over from the record */
  cooked: boolean;
  ms: number;
  errors: CookIssue[];
  warnings: string[];
}

export interface PackageReport {
  protocol: number;
  topotopo: string;
  ok: boolean;
  ms: number;
  package: { id: string; name: string | null; dir: string; topo: string };
  outputs: OutputReport[];
  orphans: string[];
  exposed: string[];
  errors: string[];
  warnings: string[];
  /** the record: written, unchanged, or not written (the package did not open) */
  record: 'written' | 'unchanged' | 'none';
}

// ---------------------------------------------------------------------------------------------------------- files

const sha256 = (d: string | Uint8Array) => createHash('sha256').update(d).digest('hex');
const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const posix = (p: string) => p.split(path.sep).join('/');
/** An absolute path as reports and progress lines give it: forward slashes ("C:/game/props/props.topo"). */
export const slash = (p: string) => path.resolve(p).split(path.sep).join('/');
const isUrl = (p: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(p);
/** `inner` is `outer` or below it */
const within = (inner: string, outer: string) => { const r = path.relative(path.resolve(outer), path.resolve(inner)); return !r || (!r.startsWith('..') && !path.isAbsolute(r)); };

/** TopoTopo's own files (fonts, kernels, dependencies): the version rule covers them, a record never names them. */
const TOPOTOPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const OWN = ['assets', 'kernels', 'node_modules', 'library'].map((d) => path.join(TOPOTOPO_ROOT, d));

/**
 * The files below a folder, as a record's "folders" lists them: relative posix paths, recursively, sorted; names
 * starting with "." (files and folders), the files engines write beside ours (*.import, *.uid, *.translation,
 * *.uasset) and *.topotopo-part left out. A folder that is not there lists nothing.
 */
export function listing(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string, depth: number) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (depth < 32) walk(path.join(d, e.name), r, depth + 1); }
      else if (e.isFile() && !isEngineFile(e.name) && !e.name.endsWith(PART_SUFFIX)) out.push(r);
    }
  };
  walk(dir, '', 0);
  return out.sort(byCode);
}

const sameList = (a: string[] | undefined, b: string[]) => !!a && a.length === b.length && [...a].sort(byCode).every((x, i) => x === b[i]);

/** A record's path for a file: relative to the package (posix) inside the engine project, else absolute (posix). */
function relOf(dir: string, project: string, abs: string): string {
  if (!within(abs, project)) return posix(path.resolve(abs));
  return posix(path.relative(dir, abs)) || '.';
}

/** A record's path back to an absolute one. */
const absOf = (dir: string, rel: string) => (path.isAbsolute(rel) || /^[A-Za-z]:\//.test(rel) ? path.resolve(rel) : path.resolve(dir, ...rel.split('/')));

/** contentSha of files, each hashed once per cook (null: missing). */
class Shas {
  private memo = new Map<string, string | null>();
  of(abs: string): string | null {
    const k = folderKey(abs);
    if (this.memo.has(k)) return this.memo.get(k)!;
    let s: string | null = null;
    try { s = contentSha(abs, fs.readFileSync(abs)); } catch { /* missing */ }
    this.memo.set(k, s);
    return s;
  }
  /** a file's hash as it was read during a cook (the first one taken stays) */
  seen(abs: string, sha: string) { const k = folderKey(abs); if (!this.memo.has(k)) this.memo.set(k, sha); }
}

/** SHA-256 of a file's bytes, or null when it is not there. */
function rawSha(abs: string): string | null {
  try { return sha256(fs.readFileSync(abs)); } catch { return null; }
}

/** JSON with every object's keys sorted, 2-space indent, LF, one key per line, a trailing newline. */
export function canonicalText(v: unknown): string {
  const sort = (x: any): any => {
    if (Array.isArray(x)) return x.map(sort);
    if (!x || typeof x !== 'object') return x;
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(x).sort(byCode)) if (x[k] !== undefined) o[k] = sort(x[k]);
    return o;
  };
  return JSON.stringify(sort(v), null, 2) + '\n';
}

/** A record file's path for a flavour. */
export const recordFile = (dir: string, flavour: string) => path.join(dir, RECORD_DIR, `${flavour}.json`);

/** A package's record (null: none; throws when it cannot be read). */
export function readRecord(dir: string, flavour: string): CookRecord | null {
  const file = recordFile(dir, flavour);
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  let raw: any;
  try { raw = JSON.parse(text.replace(/^\uFEFF/, '')); } catch (e: any) { throw new Error(`${file}: ${e.message}`); }
  if (!raw || typeof raw !== 'object' || typeof raw.schema !== 'number') throw new Error(`${file} is not a cook record (it has no "schema")`);
  return raw as CookRecord;
}

/** "0.4.0" against "0.10.1": numeric parts, missing ones 0. */
export function compareVersions(a: string, b: string): number {
  const p = (v: string) => String(v).split('.').map((x) => parseInt(x, 10) || 0);
  const x = p(a), y = p(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return d; }
  return 0;
}

/** Options as the record compares them: skip sorted, each once. */
export const normalOptions = (o: EngineOptions): EngineOptions => ({ folder: o.folder, instancing: o.instancing, per_output_folders: o.per_output_folders, skip: [...new Set(o.skip)].sort(byCode) });
const sameOptions = (a: EngineOptions | undefined, b: EngineOptions) => !!a && canonicalText(normalOptions(a)) === canonicalText(normalOptions(b));

// ------------------------------------------------------------------------------------------------------ freshness

export type FreshState = 'ok' | 'failed' | 'stale' | 'never_cooked';
/**
 * Whether a package's committed outputs match its sources: the state, why (a code: record, newer_schema, schema,
 * options, source, folder, output, version, failed, or ''), the file, folder or output it names, a note ("update_topotopo":
 * the record was cooked by a newer TopoTopo than the one installed), and the reason in words.
 */
export interface Freshness { state: FreshState; why: string; path: string; note: string; text: string }

/**
 * The one definition of freshness (the Godot addon ports it: integrations/godot/PROTOCOL.md), checked in this order:
 *   1. no record: never cooked;
 *   2. schema newer than this TopoTopo knows: stale (update); schema or flavour ("for") another: stale;
 *   3. the options differ from the import options: stale;
 *   4. a source missing or its contentSha differs: stale, naming it;
 *   5. a folder's listing differs: stale, naming it;
 *   6. an output file missing or its SHA-256 differs: stale, naming it;
 *   7. the installed TopoTopo (`installed`, when it is known) is newer than the record's: stale; older: a note only;
 *   8. an output failed: failed;
 *   9. ok.
 * `absolutePath`: an output file as the record names it, as a path.
 */
export function freshness(dir: string, record: CookRecord | null, options: EngineOptions, o: { for: string; absolutePath: (p: string) => string; installed: string | null; shas?: Shas }): Freshness {
  const shas = o.shas ?? new Shas();
  const f = (state: FreshState, why: string, p: string, text: string, note = ''): Freshness => ({ state, why, path: p, note, text });
  if (!record) return f('never_cooked', 'record', '', 'never cooked');
  if (record.schema > RECORD_SCHEMA) return f('stale', 'newer_schema', '', `the record has schema ${record.schema}, newer than this TopoTopo reads (${RECORD_SCHEMA}): update TopoTopo`);
  if (record.schema !== RECORD_SCHEMA || record.for !== o.for) return f('stale', 'schema', '', `the record is of another kind (schema ${record.schema}, for ${record.for})`);
  if (!sameOptions(record.options, options)) return f('stale', 'options', '', 'the import options changed since the last cook');
  for (const rel of Object.keys(record.sources ?? {}).sort(byCode)) {
    const now = shas.of(absOf(dir, rel));
    if (now === null) return f('stale', 'source', rel, `${rel} is missing`);
    if (now !== record.sources[rel]) return f('stale', 'source', rel, `${rel} changed after the last cook`);
  }
  for (const folder of Object.keys(record.folders ?? {}).sort(byCode)) {
    if (!sameList(record.folders[folder], listing(absOf(dir, folder)))) return f('stale', 'folder', folder, `${folder}/ holds other files than at the last cook`);
  }
  for (const id of Object.keys(record.outputs ?? {}).sort(byCode)) {
    for (const [file, s] of Object.entries(record.outputs[id].files ?? {}).sort(([a], [b]) => byCode(a, b))) {
      const now = rawSha(o.absolutePath(file));
      if (now === null) return f('stale', 'output', file, `${file} is missing`);
      if (now !== s) return f('stale', 'output', file, `${file} was changed after the last cook`);
    }
  }
  let note = '';
  if (o.installed) {
    const c = compareVersions(o.installed, record.topotopo);
    if (c > 0) return f('stale', 'version', '', `cooked with TopoTopo ${record.topotopo}; ${o.installed} is installed`);
    if (c < 0) note = 'update_topotopo';
  }
  const failed = Object.keys(record.outputs ?? {}).sort(byCode).filter((id) => record.outputs[id].state === 'failed');
  if (failed.length) return f('failed', 'failed', failed[0], `${failed.length === 1 ? 'output' : 'outputs'} ${failed.join(', ')} did not cook`, note);
  return f('ok', '', '', 'cooked, current', note);
}

// ------------------------------------------------------------------------------------------- the recording host

/** The files and folders the cook of one output read (absolute; files with their contentSha when read whole). */
class Recorder {
  active = false;
  files = new Map<string, { abs: string; sha: string | null }>();
  dirs = new Map<string, string>();
  urls = new Set<string>();
  start() { this.active = true; this.files.clear(); this.dirs.clear(); this.urls.clear(); }
  stop() { this.active = false; }
  file(p: string, bytes?: Uint8Array) {
    if (!this.active) return;
    if (isUrl(p)) { this.urls.add(p); return; }
    const k = folderKey(p), have = this.files.get(k);
    if (bytes) { if (!have?.sha) this.files.set(k, { abs: path.resolve(p), sha: contentSha(p, bytes) }); }
    else if (!have) this.files.set(k, { abs: path.resolve(p), sha: null });
  }
  dir(p: string) { if (this.active && !isUrl(p)) this.dirs.set(folderKey(p), path.resolve(p)); }
}

/**
 * A host whose file operations tell `rec` what they read: readFile, fileStamp, isDirectory (a folder), listDir,
 * convertFile (its source) and the hosts filesAt gives, the only ways the core reads files.
 */
function recordingHost(host: Host, rec: Recorder): Host {
  const w: Host = Object.create(host);
  const { readFile, fileStamp, isDirectory, listDir, convertFile, filesAt } = host;
  w.readFile = async function (this: HostFiles, p: string) { const bytes = await readFile.call(this, p); rec.file(this.resolvePath(p), bytes); return bytes; };
  w.fileStamp = function (this: HostFiles, p: string) { const s = fileStamp.call(this, p); rec.file(this.resolvePath(p)); return s; };
  if (isDirectory) w.isDirectory = function (this: HostFiles, p: string) { const d = isDirectory.call(this, p); if (d) rec.dir(this.resolvePath(p)); return d; };
  if (listDir) w.listDir = function (this: HostFiles, p: string) { const l = listDir.call(this, p); rec.dir(this.resolvePath(p)); return l; };
  if (convertFile) w.convertFile = async function (this: HostFiles, p: string, t: 'glb') { rec.file(this.resolvePath(p)); return convertFile.call(this, p, t); };
  // the hosts of other folders (a copy's scope) take their methods from `this`: the recording ones
  if (filesAt) w.filesAt = function (dir: string) { return filesAt.call(w, dir); };
  return w;
}

// -------------------------------------------------------------------------------------------------------- the cache

/** Candidates kept per cache entry. */
const MAX_CANDIDATES = 8;
/** The cache's size cap: the oldest blobs go first. */
export const CACHE_MAX_BYTES = 2 * 2 ** 30;
const CACHE_FORMAT = 1;

/** The cook cache, shared by every checkout and worktree: $TOPOTOPO_CACHE/cook, else ~/.topotopo/cache/cook. */
export function cacheRoot(): string {
  return path.join(process.env.TOPOTOPO_CACHE ? path.resolve(process.env.TOPOTOPO_CACHE) : path.join(os.homedir(), '.topotopo', 'cache'), 'cook');
}

/** A cached result: the deps it read and their hashes, the folders it listed, its files (by name in its folder: blob). */
interface Candidate { deps: Record<string, string>; folders: Record<string, string[]>; files: Record<string, string>; kind: string; instances: Record<string, number>; warnings: string[] }

const cacheKey = (flavour: string, instancing: string, pkg: string, id: string) => sha256(JSON.stringify([TOPOTOPO_VERSION, flavour, { instancing }, pkg, id]));

function readCandidates(key: string): Candidate[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(cacheRoot(), key, 'manifest.json'), 'utf8'));
    return raw?.format === CACHE_FORMAT && Array.isArray(raw.candidates) ? raw.candidates : [];
  } catch { return []; }
}

/** The first candidate whose deps and folders match the package as it is now, with its files' bytes; null for none. */
function cacheLookup(key: string, match: (c: Candidate) => boolean): { c: Candidate; files: { name: string; bytes: Uint8Array }[] } | null {
  for (const c of readCandidates(key)) {
    if (!match(c)) continue;
    const files: { name: string; bytes: Uint8Array }[] = [];
    let complete = true;
    for (const [name, blob] of Object.entries(c.files).sort(([a], [b]) => byCode(a, b))) {
      const at = path.join(cacheRoot(), 'blobs', blob);
      try {
        const bytes = new Uint8Array(fs.readFileSync(at));
        if (sha256(bytes) !== blob) { complete = false; break; }
        files.push({ name, bytes });
        const now = new Date();
        try { fs.utimesSync(at, now, now); } catch { /* still a hit */ }
      } catch { complete = false; break; }
    }
    if (complete) return { c, files };
  }
  return null;
}

/** Keep a result (its blobs, then the entry's candidates, newest first); a cache that cannot be written is no failure. */
function cacheStore(key: string, c: Candidate, files: { name: string; bytes: Uint8Array }[]) {
  try {
    const root = cacheRoot();
    fs.mkdirSync(path.join(root, 'blobs'), { recursive: true });
    for (const f of files) {
      const at = path.join(root, 'blobs', c.files[f.name]);
      if (!fs.existsSync(at)) writeAtomic(at, f.bytes);
    }
    const same = canonicalText(c.deps) + canonicalText(c.folders);
    const rest = readCandidates(key).filter((x) => canonicalText(x.deps) + canonicalText(x.folders) !== same);
    fs.mkdirSync(path.join(root, key), { recursive: true });
    writeAtomic(path.join(root, key, 'manifest.json'), JSON.stringify({ format: CACHE_FORMAT, candidates: [c, ...rest].slice(0, MAX_CANDIDATES) }) + '\n');
  } catch { /* a cache */ }
}

/** Keep the cache below its cap: the blobs used longest ago go first. */
export function cachePrune(maxBytes = CACHE_MAX_BYTES) {
  const dir = path.join(cacheRoot(), 'blobs');
  let entries: { at: string; size: number; t: number }[];
  try { entries = fs.readdirSync(dir).map((n) => { const at = path.join(dir, n), s = fs.statSync(at); return { at, size: s.size, t: s.mtimeMs }; }); } catch { return; }
  let total = entries.reduce((s, e) => s + e.size, 0);
  if (total <= maxBytes) return;
  for (const e of entries.sort((a, b) => a.t - b.t)) {
    if (total <= maxBytes) break;
    try { fs.rmSync(e.at, { force: true }); total -= e.size; } catch { /* in use */ }
  }
}

// ---------------------------------------------------------------------------------------------------------- report

/** One progress line: JSON in ASCII (every other character escaped as \uXXXX), so any decoding reads it. */
export function progressLine(ev: Record<string, unknown>): string {
  return JSON.stringify(ev).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

const issues = (list: Issue[]): CookIssue[] => list.map((e) => ({ node: e.node ?? '', message: e.message, hint: e.hint ?? '' }));
const issue = (message: string, hint = '', node = ''): CookIssue => ({ node, message, hint });

// ------------------------------------------------------------------------------------------------------------ cook

/**
 * Cook one package into its engine folder (see the top of this file): holding <package>/.topotopo/cook.lock, every
 * output that is not current (or all with `force`) from the cache or cooked anew, its files written where their bytes
 * changed, the record last; the report always (to job.report when given).
 */
export async function cookPackage(job: CookJob, flavour: Flavour, flags: CookFlags = {}): Promise<PackageReport> {
  const t0 = performance.now();
  const say = (ev: Record<string, unknown>) => flags.progress?.(progressLine(ev));
  const rep: PackageReport = {
    protocol: COOK_PROTOCOL, topotopo: TOPOTOPO_VERSION, ok: false, ms: 0, package: { id: job.id, name: null, dir: slash(job.dir), topo: slash(job.topo) },
    outputs: [], orphans: [], exposed: [], errors: [], warnings: [], record: 'none',
  };
  let release: (() => void) | null = null;
  let engine: Engine | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let started = false;
  try {
    rep.exposed = flavour.exposed(job.dir);
    const lockFile = path.join(job.dir, RECORD_DIR, 'cook.lock');
    release = takeLock(lockFile, {
      pidOnly: true, waitMs: (job.timeout ?? 600) * 1000,
      held: (pid) => `${lockFile} is held by another cook of this package (process ${pid}); it was still running after ${job.timeout ?? 600} s`,
    });
    const m = readManifest(job.dir);
    const pkgName = m.name ?? job.id;
    rep.package.name = m.name ?? null;
    const options = normalOptions(job.options);
    let old: CookRecord | null = null;
    try { old = readRecord(job.dir, flavour.for); } catch (e: any) { rep.warnings.push(`${e.message}; the package is cooked anew`); }
    if (old && (old.schema !== RECORD_SCHEMA || old.for !== flavour.for)) old = null;
    const listed = packageOutputs(job.dir);
    const notes = [...listed.problems];
    say({ event: 'start', package: slash(job.topo), outputs: listed.outputs.length + listed.invalid.length });
    started = true;

    // leftovers of a cook that was stopped: beside the files the record lists, and in each output's own folder
    for (const f of oldFiles(old)) fs.rmSync(flavour.absolutePath(f) + PART_SUFFIX, { force: true });
    if (job.options.per_output_folders) for (const x of listed.outputs) {
      const dir = flavour.outputDir(normalOptions(job.options), x.id);
      try { for (const n of fs.readdirSync(dir)) if (n.endsWith(PART_SUFFIX)) fs.rmSync(path.join(dir, n), { force: true }); } catch { /* not there yet */ }
    }

    const shas = new Shas();
    const abs = (rel: string) => absOf(job.dir, rel);
    const rel = (p: string) => relOf(job.dir, flavour.project, p);
    const store = copiesFor(job.dir);
    const ws = locate(job.dir).workspace;
    const fixed = [manifestRel(job), ...(fs.existsSync(path.join(store.packages, 'lock.json')) ? [rel(path.join(store.packages, 'lock.json'))] : []), ...(ws ? [rel(path.join(ws, WORKSPACE_FILE))] : [])];
    const listings = new Map<string, string[]>();
    const listingOf = (folder: string) => { let l = listings.get(folder); if (!l) { l = listing(abs(folder)); listings.set(folder, l); } return l; };

    // what makes every output cook again: --force, no record, other options, a newer TopoTopo, another graphs/ listing
    const installedNewer = !!old && compareVersions(TOPOTOPO_VERSION, old.topotopo) > 0;
    const all = !!flags.force || !old || !sameOptions(old.options, options) || installedNewer || !sameList(old.folders?.graphs, listingOf('graphs'));
    const depsChanged = (deps: string[]) => deps.some((d) => old!.sources?.[d] === undefined || shas.of(abs(d)) !== old!.sources[d]);
    const foldersChanged = (folders: string[]) => folders.some((f) => !sameList(old!.folders?.[f], listingOf(f)));
    const filesChanged = (files: Record<string, string>) => Object.entries(files).some(([f, s]) => rawSha(flavour.absolutePath(f)) !== s);

    const outputs: Record<string, RecordOutput> = {}, skipped: Record<string, RecordSkipped> = {};
    // the files of the outputs of this cook (key → output), and those the old record lists (the guard lets them be replaced)
    const claimed = new Map<string, string>();
    const known = new Set(oldFiles(old).map((f) => folderKey(flavour.absolutePath(f))));
    let cookedAny = false, timedOut = false;
    const signal = { aborted: false };
    if (job.timeout) timer = setTimeout(() => { signal.aborted = true; timedOut = true; void engine?.host.pool?.close(); }, job.timeout * 1000);

    // the engine, made when the first output cooks: the package's graphs and assets, its uses from their copies
    const rec = new Recorder();
    let pk: PackageUses | null = null;
    const getEngine = async (): Promise<{ e: Engine; pk: PackageUses }> => {
      if (engine && pk) return { e: engine, pk };
      const e = new Engine(recordingHost(createNodeHost({ baseDir: job.dir }), rec));
      if (e.host.pool) pools.add(e.host.pool);
      await e.init();
      // no working folder is followed: the copies the package pins
      const uses = new PackageUses(e, job.dir, { start: job.dir });
      e.root.packages = uses.resolver;
      for (const p of loadPackage(e, job.dir)) if (!notes.includes(p)) notes.push(p);
      if (uses.error && !notes.includes(uses.error)) notes.push(uses.error);
      const files = graphFiles(job.dir), graphs = e.root.graphs;
      // a graph_ref's graph is a dep of the output that reads it
      e.root.graphs = (n) => { const f = files.get(n); if (f) rec.file(f); return graphs?.(n); };
      engine = e; pk = uses;
      return { e, pk: uses };
    };

    const report = (o: OutputReport) => {
      o.ms = Math.round(o.ms);
      rep.outputs.push(o);
      say({ event: 'output', package: slash(job.topo), output: o.id, state: o.state, ms: Math.round(o.ms) });
    };
    const base = (x: { id: string; label?: string; default?: boolean }, kind = ''): Omit<OutputReport, 'state'> =>
      ({ id: x.id, label: x.label ?? x.id, kind, default: !!x.default, files: [], written: [], instances: {}, cooked: false, ms: 0, errors: [], warnings: [] });

    // outputs that cannot be published as they are: failed, their last good files kept
    for (const inv of listed.invalid) {
      if (options.skip.includes(inv.id)) {
        skipped[inv.id] = { why: SKIPPED_BY_OPTIONS };
        report({ ...base({ id: inv.id }), state: 'skipped' });
        continue;
      }
      const prev = old?.outputs?.[inv.id];
      const deps = [...new Set([...fixed, ...inv.graphs.map((g) => rel(graphFiles(job.dir).get(g) ?? path.join(job.dir, 'graphs', `${g}.json`)))])].sort(byCode);
      outputs[inv.id] = failedEntry(inv, prev, deps);
      report({ ...base({ id: inv.id, label: prev?.label, default: prev?.default }, prev?.kind ?? ''), state: 'failed', files: Object.keys(prev?.files ?? {}), errors: [issue(inv.message)] });
    }

    for (const x of listed.outputs) {
      const t = performance.now();
      const label = x.label ?? x.id;
      if (options.skip.includes(x.id)) {
        skipped[x.id] = { why: SKIPPED_BY_OPTIONS };
        report({ ...base({ id: x.id, label, default: x.default }, x.kind ?? ''), state: 'skipped' });
        continue;
      }
      const prev: RecordOutput | undefined = old?.outputs?.[x.id];
      const prevSkip = old?.skipped?.[x.id]?.deps ? old.skipped[x.id] : undefined;
      const same = (p: { graph?: string; node?: string; default?: boolean }) => p.graph === x.graph && p.node === x.node && (p.default === undefined || p.default === x.default);
      const current = !all && (prev
        ? prev.state === 'ok' && same(prev) && !depsChanged(prev.deps) && !foldersChanged(prev.folders ?? []) && !filesChanged(prev.files)
        : !!prevSkip && same(prevSkip) && !depsChanged(prevSkip.deps!) && !foldersChanged(prevSkip.folders ?? []));
      if (current && prev) {
        outputs[x.id] = { ...prev, label, default: x.default };
        for (const f of Object.keys(prev.files)) claimed.set(folderKey(flavour.absolutePath(f)), x.id);
        report({ ...base({ id: x.id, label, default: x.default }, prev.kind), state: 'unchanged', files: Object.keys(prev.files), instances: prev.instances, warnings: prev.warnings });
        continue;
      }
      if (current && prevSkip) {
        skipped[x.id] = { ...prevSkip, label };
        report({ ...base({ id: x.id, label, default: x.default }, prevSkip.kind ?? ''), state: 'skipped', warnings: [prevSkip.why] });
        continue;
      }
      cookedAny = true;
      const dir = flavour.outputDir(options, x.id);
      const fail = (errors: CookIssue[], deps: string[], folders: string[], warnings: string[] = []) => {
        outputs[x.id] = { ...failedEntry({ id: x.id, graphs: [x.graph], message: '' }, prev, deps), errors, folders, graph: x.graph, node: x.node, label, default: x.default, warnings };
        for (const f of Object.keys(outputs[x.id].files)) claimed.set(folderKey(flavour.absolutePath(f)), x.id);
        report({ ...base({ id: x.id, label, default: x.default }, prev?.kind ?? x.kind ?? ''), state: 'failed', files: Object.keys(outputs[x.id].files), errors, warnings, cooked: true, ms: performance.now() - t });
      };
      if (signal.aborted) { fail([issue(`the cook timed out after ${job.timeout} s before this output`, 'raise the timeout (cook_timeout in the editor settings, --timeout)')], [rel(x.file), ...fixed].sort(byCode), []); continue; }

      // 1. the cache: a result whose deps and folders match the package as it is now
      const key = cacheKey(flavour.for, options.instancing, pkgName, x.id);
      const hit = flags.force || flags.noCache ? null : cacheLookup(key, (c) =>
        Object.entries(c.deps).every(([d, s]) => shas.of(abs(d)) === s) && Object.entries(c.folders).every(([f, l]) => sameList(l, listingOf(f))));
      let result: { deps: string[]; folders: string[]; kind: Kind; instances: Record<string, number>; warnings: string[]; files: { name: string; bytes: Uint8Array }[] } | null = null;
      let state: OutputState = 'written';
      if (hit) {
        result = { deps: Object.keys(hit.c.deps).sort(byCode), folders: Object.keys(hit.c.folders).sort(byCode), kind: hit.c.kind as Kind, instances: hit.c.instances, warnings: hit.c.warnings, files: hit.files };
        state = 'cached';
      } else {
        // 2. cook it: every read recorded, from a cold engine cache so that a result shared with another output still reads its files
        const { e, pk: uses } = await getEngine();
        const spec: GraphSpec = x.spec;
        e.cache.clear();
        rec.start();
        let cooked: { geo: Geometry; kind: Kind; warnings: string[] } | null = null;
        let errors: CookIssue[] = [];
        let written: WrittenFiles | null = null;
        try {
          const unlocked = uses.locked(spec);
          const invalid = unlocked.length ? [] : e.validate(spec, '', { ...e.root, packages: uses.resolver }).errors;
          if (unlocked.length) errors = unlocked.map((u) => issue(u.replace(/ \(a cook without --locked adds it\)$/, ''), 'a cook for an engine changes nothing of the package: add the package it names, or restore the copy, then cook again'));
          else if (invalid.length) errors = issues(invalid);
          else {
            const r = await e.cook(spec, { target: x.node, frame: 1, signal });
            if (signal.aborted || r.stopped) errors = [issue(`the cook timed out after ${job.timeout} s`, 'raise the timeout (cook_timeout in the editor settings, --timeout)', r.stopped ?? '')];
            else if (!r.ok || !r.geo) errors = r.errors.length ? issues(r.errors) : [issue('it cooks to no geometry')];
            else {
              const info = outputKind(r.geo), kind = publishedKind(info);
              const warnings = r.warnings.map((w) => `[${w.node}] ${w.message}`);
              const pinned = x.kind ? kindMismatch(x.kind, info) : null;
              if (pinned) warnings.push(pinned);
              if (!kind) errors = [issue('it cooks to nothing: no polygons, curves, points, instances, heightfields, images, materials or volumes')];
              else {
                cooked = { geo: r.geo, kind, warnings };
                if (!flavour.skipKind(kind)) {
                  written = await flavour.write(r.geo, { id: x.id, output: x, kind, options, packageName: pkgName, packages: packagesUsed(e, spec, e.root), host: e.host });
                }
              }
            }
          }
        } catch (err: any) {
          errors = [issue(String(err?.message ?? err))];
        } finally { rec.stop(); }
        const deps = depsOf(x, spec, e, uses, shas, rec);
        const folders = [...rec.dirs.values()].map(rel).filter((f) => !isUrl(f)).sort(byCode);
        for (const u of rec.urls) if (!notes.includes(`${x.id} reads ${u}: a URL's changes are not tracked (put the file in inputs/)`)) notes.push(`${x.id} reads ${u}: a URL's changes are not tracked (put the file in inputs/)`);
        for (const d of deps) if (path.isAbsolute(d) || /^[A-Za-z]:\//.test(d)) {
          const said = `${x.id} reads ${d}, outside the engine project: a checkout elsewhere does not have it (put the file in inputs/)`;
          if (!notes.includes(said)) notes.push(said);
        }
        if (errors.length || !cooked) { fail(errors, deps, folders); continue; }
        const why = flavour.skipKind(cooked.kind);
        const instances = instanceCounts(cooked.geo);
        if (why) {
          skipped[x.id] = { why, kind: cooked.kind, graph: x.graph, node: x.node, label, deps, folders };
          cacheStore(key, candidate(deps, folders, cooked.kind, instances, cooked.warnings, [], shas, abs, listingOf), []);
          report({ ...base({ id: x.id, label, default: x.default }, cooked.kind), state: 'skipped', warnings: [why, ...cooked.warnings], cooked: true, ms: performance.now() - t });
          continue;
        }
        result = { deps, folders, kind: cooked.kind, instances, warnings: [...cooked.warnings, ...written!.warnings], files: written!.files };
        cacheStore(key, candidate(deps, folders, cooked.kind, instances, result.warnings, result.files, shas, abs, listingOf), result.files);
      }
      if (flavour.skipKind(result.kind)) {
        const why = flavour.skipKind(result.kind)!;
        skipped[x.id] = { why, kind: result.kind, graph: x.graph, node: x.node, label, deps: result.deps, folders: result.folders };
        report({ ...base({ id: x.id, label, default: x.default }, result.kind), state: 'skipped', warnings: [why, ...result.warnings], cooked: true, ms: performance.now() - t });
        continue;
      }

      // 3. the writing rules: no clash with another output, no foreign file, only changed bytes
      const placed = place(result.files, dir, { id: x.id, claimed, known, pkgName, adopt: !!job.adopt, flavour });
      if ('error' in placed) { fail([placed.error], result.deps, result.folders, result.warnings); continue; }
      outputs[x.id] = {
        default: x.default, deps: result.deps, errors: [], files: placed.files, folders: result.folders, graph: x.graph, instances: result.instances,
        kind: result.kind, label, node: x.node, state: 'ok', warnings: result.warnings,
      };
      report({
        ...base({ id: x.id, label, default: x.default }, result.kind), state: state === 'cached' ? 'cached' : placed.written.length ? 'written' : 'unchanged',
        files: Object.keys(placed.files), written: placed.written, instances: result.instances, warnings: result.warnings, cooked: true, ms: performance.now() - t,
      });
    }
    if (timedOut) rep.errors.push(`the cook timed out after ${job.timeout} s`);

    // orphans: files an output had and has no more (an output no longer published, another folder), kept until removed
    const orphans: Record<string, string> = {};
    const now = new Set<string>();
    for (const o of Object.values(outputs)) for (const f of Object.keys(o.files)) now.add(folderKey(flavour.absolutePath(f)));
    const was: [string, string][] = [...Object.entries(old?.orphans ?? {}), ...Object.entries(old?.outputs ?? {}).flatMap(([id, o]) => Object.keys(o.files ?? {}).map((f) => [f, id] as [string, string]))];
    for (const [f, id] of was) if (!now.has(folderKey(flavour.absolutePath(f))) && fs.existsSync(flavour.absolutePath(f))) orphans[f] = id;
    rep.orphans = Object.keys(orphans).sort(byCode);

    // the record, last: its sources (the deps of every output), the listings, the notes
    const sources: Record<string, string> = {};
    const allDeps = [...Object.values(outputs).flatMap((o) => o.deps), ...Object.values(skipped).flatMap((s) => s.deps ?? [])];
    for (const d of allDeps) { const s = shas.of(abs(d)); if (s !== null) sources[d] = s; }
    const folders: Record<string, string[]> = {};
    for (const f of [...LISTED_FOLDERS, ...Object.values(outputs).flatMap((o) => o.folders), ...Object.values(skipped).flatMap((s) => s.folders ?? [])]) folders[f] = listingOf(f);
    const record: CookRecord = {
      folders, for: flavour.for, name: m.name ?? null, notes: [...new Set(notes)], options, orphans, outputs, package: job.id, schema: RECORD_SCHEMA, skipped, sources,
      topotopo: cookedAny || !old ? TOPOTOPO_VERSION : old.topotopo,
    };
    const text = canonicalText(record), file = recordFile(job.dir, flavour.for);
    let have = '';
    try { have = fs.readFileSync(file, 'utf8'); } catch { /* new */ }
    if (have !== text) { fs.mkdirSync(path.dirname(file), { recursive: true }); writeAtomic(file, text); rep.record = 'written'; }
    else rep.record = 'unchanged';
    rep.warnings.push(...notes);
    if (old && compareVersions(TOPOTOPO_VERSION, old.topotopo) < 0 && !cookedAny) rep.warnings.push(`cooked elsewhere with TopoTopo ${old.topotopo}, newer than this one (${TOPOTOPO_VERSION}): update TopoTopo`);
  } catch (e: any) {
    rep.errors.push(String(e?.message ?? e));
  } finally {
    if (timer) clearTimeout(timer);
    release?.();
    rep.ok = !rep.errors.length && rep.outputs.every((o) => o.state !== 'failed');
    rep.ms = Math.round(performance.now() - t0);
    if (!started) say({ event: 'start', package: slash(job.topo), outputs: 0 });
    if (job.report) {
      try { fs.mkdirSync(path.dirname(job.report), { recursive: true }); writeAtomic(job.report, JSON.stringify(rep, null, 2) + '\n'); }
      catch (e: any) { rep.errors.push(`the report ${job.report} could not be written: ${e.message}`); rep.ok = false; }
    }
    say({ event: 'done', package: slash(job.topo), ok: rep.ok, report: job.report ? slash(job.report) : '' });
  }
  return rep;

  /** The files an output read, as the record names them: its reads, its graph, the package's assets, manifest, lock and workspace file, the version records of the copies it uses. */
  function depsOf(x: PackageOutput, spec: GraphSpec, e: Engine, uses: PackageUses, shas: Shas, rec: Recorder): string[] {
    const rel = (p: string) => relOf(job.dir, flavour.project, p);
    const set = new Set<string>([rel(x.file), manifestRel(job), ...listing(path.join(job.dir, 'assets')).map((f) => `assets/${f}`)]);
    const store = copiesFor(job.dir);
    if (fs.existsSync(path.join(store.packages, 'lock.json'))) set.add(rel(path.join(store.packages, 'lock.json')));
    const ws = locate(job.dir).workspace;
    if (ws) set.add(rel(path.join(ws, WORKSPACE_FILE)));
    for (const { abs, sha } of rec.files.values()) {
      if (OWN.some((d) => within(abs, d)) && !within(abs, job.dir)) continue;
      if (sha) shas.seen(abs, sha);
      set.add(rel(abs));
    }
    let used: Record<string, string> = {};
    try { used = packagesUsed(e, spec, e.root); } catch { /* said by the cook */ }
    const self = uses.manifest?.name;
    for (const k of Object.keys(used)) {
      const at = k.lastIndexOf('@'), pkg = k.slice(0, at), v = k.slice(at + 1);
      if (v === 'working') continue;
      set.add(rel(path.join(store.packages, ...pkg.split('/'), v, 'version.json')));
    }
    // a graph that names the package's own outputs reads its other graphs
    if (self && (packagesNamedIn(spec).includes(self) || Object.keys(used).includes(`${self}@working`))) for (const f of graphFiles(job.dir).values()) set.add(rel(f));
    return [...set].filter((d) => fs.existsSync(absOf(job.dir, d))).sort(byCode);
  }
}

/** The manifest's path in the record. */
const manifestRel = (job: CookJob) => path.basename(job.topo);

/** Every output file a record lists (outputs and orphans). */
function oldFiles(old: CookRecord | null): string[] {
  if (!old) return [];
  return [...Object.keys(old.orphans ?? {}), ...Object.values(old.outputs ?? {}).flatMap((o) => Object.keys(o.files ?? {}))];
}

/** A failed output's record: its last good files and what it was, the error. */
function failedEntry(inv: InvalidOutput, prev: RecordOutput | undefined, deps: string[]): RecordOutput {
  return {
    default: prev?.default ?? false, deps, errors: inv.message ? [issue(inv.message)] : [], files: prev?.files ?? {}, folders: [], graph: inv.graphs[0] ?? '',
    instances: prev?.instances ?? {}, kind: prev?.kind ?? '', label: prev?.label ?? inv.id, node: prev?.node ?? '', state: 'failed', warnings: [],
  };
}

/** A cache candidate of a result: its deps with their hashes now, its folders' listings, its files' blobs. */
function candidate(deps: string[], folders: string[], kind: string, instances: Record<string, number>, warnings: string[], files: { name: string; bytes: Uint8Array }[], shas: Shas, abs: (rel: string) => string, listingOf: (f: string) => string[]): Candidate {
  return {
    deps: Object.fromEntries(deps.map((d) => [d, shas.of(abs(d)) ?? ''])), folders: Object.fromEntries(folders.map((f) => [f, listingOf(f)])),
    files: Object.fromEntries(files.map((f) => [f.name, sha256(f.bytes)])), kind, instances, warnings,
  };
}

/** Packed instances per source name (the GLB's node names). */
function instanceCounts(g: Geometry): Record<string, number> {
  if (!g.hasPacked()) return {};
  const names = packedSourceNames(g), out: Record<string, number> = {};
  const kind = g.primKind!, src = g.packedSource!;
  for (let p = 0; p < kind.length; p++) if (kind[p] === 1) { const n = names[src[p]] ?? `source_${src[p]}`; out[n] = (out[n] ?? 0) + 1; }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => byCode(a, b)));
}

/**
 * The writing rules for one output's files in `dir`: none at a path another output of this cook writes; an existing
 * file is replaced only when the old record lists it, its source block names this package, or with `adopt`; a file
 * is written (through <file>.topotopo-part, moved into place) only when its bytes differ. All or nothing: a refused
 * file writes none of the output's.
 */
function place(files: { name: string; bytes: Uint8Array }[], dir: string, o: { id: string; claimed: Map<string, string>; known: Set<string>; pkgName: string; adopt: boolean; flavour: Flavour }):
  { files: Record<string, string>; written: string[] } | { error: CookIssue } {
  const targets = files.map((f) => ({ abs: path.join(dir, ...f.name.split('/')), bytes: f.bytes }));
  for (const t of targets) {
    const k = folderKey(t.abs), other = o.claimed.get(k);
    if (other && other !== o.id) return { error: issue(`${o.flavour.recordPath(t.abs)} is also an output file of "${other}"`, 'two outputs cannot write one file: per-output folders (outputs/per_output_folders), or rename one output or its images') };
  }
  for (const t of targets) {
    if (!fs.existsSync(t.abs) || o.adopt || o.known.has(folderKey(t.abs))) continue;
    if (o.flavour.ownerOf(t.abs) === o.pkgName) continue;
    return { error: issue(`${o.flavour.recordPath(t.abs)} is there already and was not cooked from this package`, 'cook into another folder (outputs/folder, --into), or take the file over once with --adopt (its import settings are kept)') };
  }
  const out: Record<string, string> = {}, written: string[] = [];
  for (const t of targets) {
    o.claimed.set(folderKey(t.abs), o.id);
    const r = o.flavour.recordPath(t.abs);
    out[r] = sha256(t.bytes);
    let same = false;
    try { same = Buffer.from(fs.readFileSync(t.abs)).equals(Buffer.from(t.bytes.buffer, t.bytes.byteOffset, t.bytes.byteLength)); } catch { /* new */ }
    if (same) continue;
    fs.mkdirSync(path.dirname(t.abs), { recursive: true });
    const part = t.abs + PART_SUFFIX;
    try { fs.writeFileSync(part, t.bytes); renameInto(part, t.abs); } catch (e: any) { fs.rmSync(part, { force: true }); return { error: issue(`${r} could not be written: ${e.message}`) }; }
    written.push(r);
  }
  return { files: Object.fromEntries(Object.entries(out).sort(([a], [b]) => byCode(a, b))), written: written.sort(byCode) };
}

/** The worker pools of the engines the cooks made (the process's shared one): closed when a command ends. */
const pools = new Set<WorkerPool>();
export async function closeCookPools() {
  for (const p of pools) await p.close();
  pools.clear();
}
