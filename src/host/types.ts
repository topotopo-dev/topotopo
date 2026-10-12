// The engine core never touches Node or DOM APIs directly; a Host supplies them.
// src/host/node.ts implements this for Node (MCP server, CLI). A browser host
// (Web Worker + fetch/OPFS) can implement the same interface for the future GUI.

export interface Host {
  name: string;
  /** Read a file (or URL) as bytes. */
  readFile(path: string): Promise<Uint8Array>;
  /** A string that changes when the file changes (mtime+size), for cache keys. */
  fileStamp(path: string): string;
  resolvePath(path: string): string;
  /**
   * Compile JS source inside the scripting realm (which has the snippet library
   * installed) and return the resulting value (usually a function).
   */
  compile(source: string): any;
  /** Run fn with a wall-clock limit; throws on timeout. */
  runGuarded<T>(fn: () => T, timeoutMs?: number): T;
  /** Locate a font file: explicit path, family name, or a platform default. */
  findFont(name?: string): string | null;
  /**
   * All candidate font files for a request, best first (the first entry equals findFont(name)).
   * Callers try them in order because not every system font parses (opentype.js rejects some GSUB tables).
   */
  fontCandidates?(name?: string): string[];
}
