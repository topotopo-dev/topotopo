// Opening a folder to work in, in one place: the engine's root scope gets the package names of the package the folder
// belongs to (its copies, the libraries it looks in, the working folders followed this session) before the session
// gives it the folder's graphs and registers its assets, which may use packages. The MCP server, `topotopo edit`, the
// The web app's bake and the preview script open folders this way.
import type { Engine } from './graph/engine.ts';
import { Session } from './session.ts';
import type { SessionOptions } from './session.ts';
import { openPackages } from './packages/registry.ts';
import type { PackageUses } from './packages/registry.ts';

export interface OpenOptions extends SessionOptions {
  /** packages whose working folders to follow this session */
  follow?: string[];
  /** the folder of TopoTopo's built-in library (default: the one TopoTopo ships) */
  builtin?: string;
  /** follow what other processes write into the folder (Session.watch) */
  watch?: boolean;
}

export interface Opened { session: Session; packages: PackageUses; loaded: ReturnType<Session['load']> }

/** A session on `dir`, with the packages of the package it belongs to, its graphs and its assets. */
export function openPackage(engine: Engine, dir: string, o: OpenOptions = {}): Opened {
  const packages = openPackages(engine, dir, { follow: o.follow, builtin: o.builtin });
  const session = new Session(dir, engine, o);
  session.packages = packages;
  const loaded = session.load();
  if (o.watch) session.watch();
  return { session, packages, loaded };
}
