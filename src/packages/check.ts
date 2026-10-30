// topotopo check: cook what a game relies on and say what broke and why, changing nothing; after a TopoTopo update
// above all, when a renamed param or a changed node can break a package version published before it. In a workspace:
// the newest published version of every package in its libraries, each output cooked as a project that uses it cooks
// it (in the version's own folder, with the copies it holds), and every graph of the projects that share its copies,
// with the versions they use. Outside one: the libraries the project around the folder lists, and its graphs; in no
// project, the registered libraries. There are no param migrations: a version that no longer cooks says why (the error
// and its hint) and its author publishes a fixed one, which projects take with an update.
import path from 'node:path';
import { Engine } from '../graph/engine.ts';
import { createNodeHost } from '../host/node.ts';
import { graphFiles } from '../session.ts';
import { loadConfig } from '../config.ts';
import { WORKSPACE_FILE, copiesFor, librariesFor, locate, program, resolveLibraries } from '../package.ts';
import type { LibraryAt } from '../package.ts';
import { readWorkspace } from '../workspace.ts';
import { scanLibrary } from '../gallery/library.ts';
import { libraryText, loadPackage, openPackages, publishedVersions } from './registry.ts';

/** What a check cooked of one package version or one project, and what failed. */
export interface CheckItem {
  what: 'package' | 'project';
  /** "owner/name 1.3", or the project's folder (from the workspace or the library) */
  name: string;
  cooked: number;
  failures: { where: string; error: string }[];
  /** graphs not cooked: fragments ("fragment": true) that another graph or a script completes */
  skipped: string[];
}

export interface CheckResult {
  /** what was checked: 'workspace "raven-hunt"', "project forest", "the registered libraries" */
  scope: string;
  items: CheckItem[];
  /** what could not be read (a library, a workspace file) */
  problems: string[];
  ms: number;
}

/** One cook to make in a folder: a graph's node (default: its output), named for the report. */
interface Job { graph: string; node?: string; label: string }

/**
 * Cook jobs in a folder that holds a project (a working folder, or a published version, which holds its copies and
 * lock): an engine of its own with the folder's packages, graphs and assets, as `topotopo` cooks a file there. A
 * failure is the cook's errors with their hints; nothing is written (no package is added on first use).
 */
async function cookIn(dir: string, jobs: Job[]): Promise<{ cooked: number; failures: CheckItem['failures']; skipped: string[] }> {
  const engine = new Engine(createNodeHost({ baseDir: dir }));
  await engine.init();
  const failures: CheckItem['failures'] = [];
  const pk = openPackages(engine, dir);
  if (pk.notice()) failures.push({ where: 'packages', error: pk.notice()! });
  for (const p of loadPackage(engine, dir)) failures.push({ where: 'files', error: p });
  let cooked = 0;
  const skipped: string[] = [];
  for (const j of jobs) {
    const spec = engine.root.graphs?.(j.graph);
    if (!spec) { failures.push({ where: j.label, error: `there is no graph "${j.graph}"` }); continue; }
    if (spec.fragment === true) { skipped.push(j.graph); continue; }
    const r = await engine.cook(spec, { target: j.node });
    if (r.ok && r.geo) { cooked++; continue; }
    failures.push({ where: j.label, error: r.errors.map((e) => `[${e.node}] ${e.message}${e.hint ? ` (${e.hint})` : ''}`).join('; ') || 'it cooks to no geometry' });
  }
  return { cooked, failures, skipped };
}

/** The newest published version of each package in the libraries, its outputs cooked in the version's folder. */
async function checkPackages(libs: { name: string; root: string }[], problems: string[], progress?: (what: string) => void): Promise<CheckItem[]> {
  const items: CheckItem[] = [];
  const seen = new Set<string>();
  for (const lib of libs) {
    const scan = scanLibrary({ name: lib.name, path: lib.root });
    problems.push(...scan.problems.map((p) => `${libraryText(lib.name)}: ${p}`));
    for (const p of scan.projects) {
      const pkg = p.manifest.package;
      if (!pkg || seen.has(pkg)) continue;
      seen.add(pkg);
      const v = publishedVersions(p.dir, pkg).at(-1);
      if (!v) continue;
      progress?.(`${pkg} ${v.version}`);
      // each output once: the default output is also a named one, or an entry of its own
      const jobs = new Map<string, Job>();
      for (const [k, o] of Object.entries(v.outputs)) jobs.set(`${o.graph}\n${o.node}`, { graph: o.graph, node: o.node, label: `${pkg}/${k}` });
      if (!jobs.has(`${v.default.graph}\n${v.default.node}`)) jobs.set(`${v.default.graph}\n${v.default.node}`, { graph: v.default.graph, node: v.default.node, label: pkg });
      const r = await cookIn(path.join(p.dir, 'versions', v.version), [...jobs.values()]);
      items.push({ what: 'package', name: `${pkg} ${v.version}`, ...r });
    }
  }
  return items;
}

/** A project's graphs (graphs/, and graph files beside project.json), each cooked to its output. */
async function checkPackage(dir: string, name: string): Promise<CheckItem> {
  const jobs = [...graphFiles(dir).keys()].map((g) => ({ graph: g, label: `graph ${g}` }));
  return { what: 'project', name, ...(await cookIn(dir, jobs)) };
}

/**
 * Check what the folder `start` belongs to (see the top of this file). `progress` hears what is cooked next. Writes
 * nothing.
 */
export async function checkAll(start: string, o: { progress?: (what: string) => void } = {}): Promise<CheckResult> {
  const t0 = performance.now();
  const problems: string[] = [];
  const { project, workspace } = locate(start);
  let scope: string, libs: { name: string; root: string }[], projects: { dir: string; name: string }[];
  if (workspace) {
    const m = readWorkspace(workspace);
    scope = `workspace "${m.name}" (${workspace})`;
    const listed = resolveLibraries([{ file: path.join(workspace, WORKSPACE_FILE), base: workspace, entries: m.libraries, from: 'workspace' }]);
    problems.push(...listed.problems);
    libs = listed.libs.map((l: LibraryAt) => ({ name: l.name, root: l.root }));
    // the projects that share the workspace's copies: its scenes, not its packages (their versions are checked)
    projects = scanLibrary({ name: m.name, path: workspace }).projects
      .filter((p) => copiesFor(p.dir).workspace === workspace)
      .map((p) => ({ dir: p.dir, name: p.rel }));
  } else if (project) {
    scope = `project ${path.basename(project)} (${project})`;
    const listed = librariesFor(project);
    problems.push(...listed.problems);
    libs = listed.libs.map((l) => ({ name: l.name, root: l.root }));
    projects = [{ dir: project, name: path.basename(project) }];
  } else {
    scope = 'the registered libraries';
    libs = loadConfig().libraries.map((l) => ({ name: l.name, root: l.path }));
    projects = [];
  }
  const items = await checkPackages(libs, problems, o.progress);
  for (const p of projects) {
    o.progress?.(p.name);
    items.push(await checkPackage(p.dir, p.name));
  }
  return { scope, items, problems: [...new Set(problems)], ms: performance.now() - t0 };
}

/** A check as the CLI and the library tool say it: what broke first, with why, then what cooked. */
export function checkText(r: CheckResult): string {
  const broke = r.items.filter((i) => i.failures.length), fine = r.items.filter((i) => !i.failures.length);
  const pk = r.items.filter((i) => i.what === 'package').length, pr = r.items.length - pk;
  const lines = [`check of ${r.scope}: ${pk} package version${pk === 1 ? '' : 's'} (the newest of each) and ${pr} project${pr === 1 ? '' : 's'}, in ${(r.ms / 1000).toFixed(1)} s`];
  if (!r.items.length) lines.push(`nothing to check: no published package in the libraries and no project (${program()} libraries add, or workspace init --library, lists a library)`);
  for (const i of broke) {
    lines.push(`BROKEN  ${i.what === 'package' ? i.name : `project ${i.name}`}: ${i.failures.length} failure${i.failures.length === 1 ? '' : 's'}${i.cooked ? `, ${i.cooked} cooked` : ''}`);
    for (const f of i.failures) lines.push(`  ${f.where}: ${f.error}`);
  }
  if (fine.length) lines.push(`ok: ${fine.map((i) => `${i.what === 'package' ? i.name : `project ${i.name}`} (${i.cooked})`).join(', ')}`);
  const skipped = r.items.filter((i) => i.skipped.length);
  if (skipped.length) lines.push(`skipped, fragments ("fragment": true) that another graph or a script completes: ${skipped.map((i) => `${i.name} ${i.skipped.join(', ')}`).join('; ')}`);
  if (r.problems.length) lines.push(`could not read ${r.problems.length}:`, ...r.problems.map((p) => `  ${p}`));
  lines.push(broke.length
    ? `${broke.length} of ${r.items.length} broke; nothing was changed. A broken package version is fixed in its working folder and published again (${program()} publish); the projects take it with an update.`
    : 'nothing broke; nothing was changed');
  return lines.join('\n');
}
