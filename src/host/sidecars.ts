// Export sidecars on disk (io/sidecars.ts): which JSON files beside an export are its metadata, read from their first
// bytes. Workspace.listInputs, ArtifactStore.list and the viewer's Outputs list ask here. The format a file declares
// is cached by its size and modification time, so listings read each file once.
import fs from 'node:fs';
import path from 'node:path';
import { SIDECAR_HEAD_BYTES, jsonFormat, maybeSidecar, sidecarOf } from '../io/sidecars.ts';
import type { Sidecar } from '../io/sidecars.ts';

const formats = new Map<string, { stamp: string; format: string | null }>();

/** The "format" a JSON file declares at its start, or null (not JSON, no format, unreadable). */
export function fileFormat(file: string): string | null {
  let st: fs.Stats | undefined;
  try { st = fs.statSync(file, { throwIfNoEntry: false }); } catch { return null; }
  if (!st?.isFile()) return null;
  const stamp = `${st.size}:${st.mtimeMs}`, hit = formats.get(file);
  if (hit?.stamp === stamp) return hit.format;
  let format: string | null = null;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const head = new Uint8Array(Math.min(SIDECAR_HEAD_BYTES, st.size));
      fs.readSync(fd, head, 0, head.length, 0);
      format = jsonFormat(head);
    } finally { fs.closeSync(fd); }
  } catch { /* gone or unreadable: not a sidecar */ }
  if (formats.size > 4096) formats.clear();
  formats.set(file, { stamp, format });
  return format;
}

/**
 * Is the file at `file` (absolute) a sidecar, and of what (an absolute path)? `exists` tells whether a path is there
 * (default: on disk).
 */
export function sidecarFile(file: string, exists: (p: string) => boolean = (p) => fs.existsSync(p)): Sidecar | null {
  if (!maybeSidecar(file)) return null;
  const posix = (p: string) => p.split(path.sep).join('/'), native = (p: string) => p.split('/').join(path.sep);
  const s = sidecarOf(posix(file), fileFormat(file), (p) => exists(native(p)));
  return s && { role: s.role, of: s.of === null ? null : native(s.of) };
}
