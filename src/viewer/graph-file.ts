// `topotopo view <graph.json>`: the live viewer on one graph file, which stays the only source of the graph. GraphFile
// loads the file into a scratch session, follows its saves (the person's editor, an agent) and writes what the page
// changes back into it as minimal edits (json-edit.ts): an export target, the values "Save values to graph" keeps.
// The rest of the file stays as it was written. The values a person tunes are session values over the graph
// (Session.sessionVars): they survive every reload of the file, the viewer's own writes included. The graph uses the
// packages of the project the file belongs to; one it names for the first time is added to the project, and a package
// followed with --follow (or the viewer's switch) re-cooks the graph whenever its working folder changes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../nodes/index.ts';
import { Engine } from '../graph/engine.ts';
import { migrateGraph } from '../graph/migrate.ts';
import { createNodeHost } from '../host/node.ts';
import { openPackages } from '../gallery/packages.ts';
import { Session } from '../session.ts';
import { startViewer } from './server.ts';
import { exportsFolderFor } from '../host/export-targets.ts';
import type { Viewer } from './server.ts';
import { applyJSONEdits, editJSONText } from './json-edit.ts';
import type { JSONEdit } from './json-edit.ts';

/** Where a graph's source lives when it is not the project's graphs/ folder (ViewerOptions.source). */
export interface GraphSource {
  /** the project graph it holds */
  graph: string;
  /** its file name, for the page ("boxes.json") */
  label: string;
  /**
   * Write these changes into the source, then store the graph as the source now has it (Session.setGraph, which
   * also lets session values the graph now holds go). Throws when it cannot write.
   */
  save(edits: JSONEdit[]): void;
}

const errorText = (e: unknown) => String((e as Error)?.message ?? e);

export class GraphFile implements GraphSource {
  readonly graph: string;
  readonly label: string;
  readonly file: string;
  private ws: Session;
  private log: (line: string) => void;
  /** the file's text as last read or written: a change event that finds it again is the viewer's own write */
  private text: string | null = null;
  private watcher: fs.FSWatcher | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private loading: Promise<void> | null = null;
  private again = false;

  constructor(ws: Session, file: string, graph: string, log: (line: string) => void = (l) => console.log(l)) {
    this.ws = ws;
    this.file = path.resolve(file);
    this.graph = graph;
    this.label = path.basename(file);
    this.log = log;
  }

  /**
   * Read the file into the project graph and cook it, unless it holds what the graph already is. A file that is not
   * valid JSON (half saved, a typo) keeps the last good version. Loads never overlap: a change during one loads again.
   */
  load(): Promise<void> {
    if (this.loading) { this.again = true; return this.loading; }
    this.loading = (async () => {
      try {
        do { this.again = false; await this.loadOnce(); } while (this.again);
      } finally { this.loading = null; }
    })();
    return this.loading;
  }

  private async loadOnce() {
    let text: string;
    try { text = fs.readFileSync(this.file, 'utf8'); } catch (e) { this.log(`${this.file}: ${errorText(e)} (keeping the last good version)`); return; }
    if (text === this.text && this.ws.graphs.has(this.graph)) return;
    let spec;
    try { spec = JSON.parse(text.replace(/^﻿/, '')); } catch (e) { this.log(`${this.file}: ${errorText(e)} (keeping the last good version)`); return; }
    this.text = text;
    const cur = this.ws.graphs.get(this.graph);
    try {
      if (cur && JSON.stringify(migrateGraph(spec)) === JSON.stringify(cur)) return;
      for (const n of this.ws.packages?.addFor(migrateGraph(spec)) ?? []) this.log(n);
      this.ws.setGraph(this.graph, spec);
    } catch (e) { this.log(`${this.file}: ${errorText(e)} (keeping the last good version)`); return; }
    await this.cook();
  }

  /** Cook the graph as it is, say how it went, and have the page read it again. */
  async cook() {
    const r = await this.ws.cook(this.graph);
    const what = r.ok ? 'cooked' : r.stopped ? 'stopped' : 'FAILED';
    this.log(`${what} ${this.graph} in ${r.ms.toFixed(0)} ms${r.ok ? '' : r.stopped ? ` at ${r.stopped}` : ': ' + r.errors.map((e) => `${e.node}: ${e.message}`).join('; ')}`);
    // the graph changed, cooked or not: the page reads it again (a stopped cook leaves the last geometry in view)
    this.ws.bump(this.graph);
  }

  save(edits: JSONEdit[]) {
    // the file as it is now: a save that has not been loaded yet is kept, the edits go on top of it
    const before = fs.readFileSync(this.file, 'utf8');
    let text: string;
    try { text = editJSONText(before, edits); }
    catch (e) {
      if (e instanceof SyntaxError) throw new Error(`${this.label} is not valid JSON now (${e.message}): fix it in the editor, then try again`);
      // an edit the text editor cannot place: the content is still right, laid out as JSON.stringify does
      text = JSON.stringify(applyJSONEdits(JSON.parse(before.replace(/^﻿/, '')), edits), null, 2) + '\n';
      this.log(`${this.file}: rewritten in full (${errorText(e)})`);
    }
    if (text !== before) fs.writeFileSync(this.file, text);
    this.text = text;
    const spec = JSON.parse(text.replace(/^﻿/, ''));
    const cur = this.ws.graphs.get(this.graph);
    if (!cur || JSON.stringify(migrateGraph(spec)) !== JSON.stringify(cur)) this.ws.setGraph(this.graph, spec);
  }

  /** Follow saves of the file: its folder is watched, so editors that save by replacing the file are followed too. */
  watch() {
    if (this.watcher) return;
    const base = path.basename(this.file);
    try {
      this.watcher = fs.watch(path.dirname(this.file), (_ev, f) => {
        if (f && path.basename(String(f)) !== base) return;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => { this.load().catch((e) => this.log(errorText(e))); }, 150);
      });
      this.watcher.on('error', () => { this.watcher?.close(); this.watcher = null; });
      this.watcher.unref();
    } catch (e) { this.log(`${this.file}: cannot watch it (${errorText(e)}); restart the viewer after saving`); }
  }

  close() {
    clearTimeout(this.timer);
    this.watcher?.close();
    this.watcher = null;
  }
}

export interface ViewGraphFileOptions {
  /** the graph's name in the project and on the page (the file name, made a valid graph name) */
  name: string;
  port?: number;
  /** where status lines go (default: stdout) */
  log?: (line: string) => void;
  /** packages ("owner/name") whose working folders the graph uses instead of their copies, for this session */
  follow?: string[];
}

/**
 * `topotopo view <graph.json>`: cook the file, serve the live viewer on it and follow its saves. The session is a
 * scratch folder; inputs/ and exports/ are beside the graph file (inputs/ made by the first file dropped on the page).
 */
export async function viewGraphFile(file: string, opts: ViewGraphFileOptions): Promise<{ url: string; viewer: Viewer; ws: Session; source: GraphFile; close: () => void }> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const dir = path.dirname(path.resolve(file));
  const engine = new Engine(createNodeHost({ baseDir: dir }));
  await engine.init();
  const packages = openPackages(engine, dir, { follow: opts.follow });
  // exports go into the project's exports/ (a graph file in no project: beside it), as the CLI's do
  const ws = new Session(fs.mkdtempSync(path.join(os.tmpdir(), 'topotopo-view-')), engine, { inputs: path.join(dir, 'inputs'), exports: exportsFolderFor(file) });
  ws.packages = packages;
  ws.load();
  for (const p of packages.check()) log(`warning: ${p}`);
  for (const f of packages.following()) log(`following ${f.package}: its working folder ${f.dir} instead of its copy`);
  const source = new GraphFile(ws, file, opts.name, log);
  await source.load();
  // the viewer cooks the graph again after a save in the working folder of a package it follows (src/viewer/packages.ts)
  const viewer = await startViewer(ws, opts.port, { inputsWhere: `beside ${path.basename(file)}`, source });
  log(`view: ${viewer.url}  (watching ${file}; files dropped on the page go to ${path.join(path.dirname(file), 'inputs') + path.sep}; Ctrl+C to stop)`);
  source.watch();
  return { url: viewer.url, viewer, ws, source, close: () => { source.close(); viewer.close(); } };
}
