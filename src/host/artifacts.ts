// Persistent output receipts shared by the CLI, MCP and viewer. Paths are registered by trusted host code;
// HTTP callers only receive identifiers, never a route that reads an arbitrary absolute path.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export interface Artifact {
  id: string;
  label: string;
  graph?: string;
  node?: string;
  format?: string;
  sourceRevision?: string;
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
  /** Discover unregistered agent-written files too. Never follow symlinks/junctions while scanning. */
  list(): Artifact[] {
    const all = this.records().filter((a) => a.files.some((p) => fs.statSync(p, { throwIfNoEntry: false })?.isFile()));
    const known = new Set(all.flatMap((a) => a.files.map((p) => path.resolve(p))));
    const walk = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
        if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile() && !known.has(p)) all.push({ id: artifactId(p), label: path.relative(this.dir, p).split(path.sep).join('/'), files: [p] });
      }
    };
    walk(this.dir);
    return all;
  }
}
