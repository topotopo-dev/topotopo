// Persistent output receipts shared by the CLI, MCP and viewer. Paths are registered by trusted host code;
// HTTP callers only receive identifiers, never a route that reads an arbitrary absolute path.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { sidecarFile } from './sidecars.ts';

export interface Artifact {
  id: string;
  label: string;
  graph?: string;
  node?: string;
  format?: string;
  sourceRevision?: string;
  /** the published output a target export wrote ('' = the graph's default output) */
  output?: string;
  files: string[];
}
export const artifactId = (p: string) => createHash('sha256').update(path.resolve(p)).digest('hex').slice(0, 24);

export class ArtifactStore {
  dir: string;
  constructor(dir: string) { this.dir = path.resolve(dir); }
  get manifest() { return path.join(this.dir, '.outputs.json'); }
  records(): Artifact[] {
    try { const j = JSON.parse(fs.readFileSync(this.manifest, 'utf8')); return Array.isArray(j) ? j.filter((a) => a && typeof a.id === 'string' && Array.isArray(a.files) && a.files.every((p: unknown) => typeof p === 'string')) : []; }
    catch { return []; }
  }
  record(files: string[], info: Partial<Omit<Artifact, 'id' | 'files'>> = {}): Artifact {
    if (!files.length) throw new Error('an output needs at least one file');
    files = files.map((p) => path.resolve(p));
    const a: Artifact = { id: artifactId(files[0]), label: path.basename(files[0]), ...info, files };
    const all = this.records().filter((x) => x.id !== a.id);
    all.push(a);
    fs.mkdirSync(this.dir, { recursive: true });
    const temp = this.manifest + '.part';
    fs.writeFileSync(temp, JSON.stringify(all, null, 2) + '\n');
    fs.renameSync(temp, this.manifest);
    return a;
  }
  /**
   * Discover unregistered agent-written files too, one output each; an export's sidecar among them (a heightmap's
   * .json, <file>.source.json …: io/sidecars.ts) joins the output of the file it describes. Never follow
   * symlinks/junctions while scanning.
   */
  list(): Artifact[] {
    const all = this.records().filter((a) => a.files.some((p) => fs.statSync(p, { throwIfNoEntry: false })?.isFile()));
    const known = new Set(all.flatMap((a) => a.files.map((p) => path.resolve(p))));
    const found: Artifact[] = [];
    const walk = (dir: string) => {
      // a folder can be missing, or vanish between listing its parent and reading it
      const entries = (() => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } })();
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
        if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile() && !known.has(p)) found.push({ id: artifactId(p), label: path.relative(this.dir, p).split(path.sep).join('/'), files: [p] });
      }
    };
    walk(this.dir);
    const owner = new Map<string, Artifact>();
    for (const a of [...all, ...found]) for (const p of a.files) if (!owner.has(path.resolve(p))) owner.set(path.resolve(p), a);
    for (const a of found) {
      const s = sidecarFile(a.files[0]), of = s?.of ? owner.get(path.resolve(s.of)) : undefined;
      if (of && of !== a) of.files.push(a.files[0]);
      else all.push(a);
    }
    return all;
  }
}
