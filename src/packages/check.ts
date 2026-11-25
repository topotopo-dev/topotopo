// topotopo check: cook every published output of the package's working graphs, including its assert nodes. In a
// workspace, do this for each of its packages. Also cook the newest published version of each of those packages
// and of the packages in the workspace's listed libraries, in the version folders with their own locked copies.
// Outside a workspace, check the package around the folder and the published versions in its library. Outside
// any package, check the registered libraries' published versions. Report what broke and why. Only missing
// .gdignore files inside a Godot project are written.
import path from 'node:path';
import { Engine } from '../graph/engine.ts';
import { createNodeHost } from '../host/node.ts';
import { graphFiles } from '../session.ts';
import { loadConfig } from '../config.ts';
import { librariesFor, locate, program, readManifest, resolveListed } from '../package.ts';
import { readWorkspace, scanWorkspace } from '../workspace.ts';
import { scanTree } from '../scan.ts';
import type { Package } from '../scan.ts';
import { godotIgnore } from '../engines.ts';
import { libraryText, loadPackage, openPackages, packageOutputs, publishedVersions } from './registry.ts';

/** What a check cooked of one package version or one package, and what failed. */
export interface CheckItem {
  what: 'version' | 'package';
  /** "owner/name 1.3", or the package's folder (from the workspace or the library) */
  name: string;
  outputs: number;
  cooked: number;
  failures: { where: string; error: string }[];
  /** graphs not cooked: fragments ("fragment": true) that another graph or a script completes */
  skipped: string[];
}

export interface CheckResult {
  /** what was checked: 'workspace "my-game"', "package forest", "the registered libraries" */
  scope: string;
  items: CheckItem[];
  /** what could not be read (a library, a workspace file) */
  problems: string[];
  /** the .gdignore files it added: inside a Godot project, the working folders of the packages it checked lacked them */
  fixed: string[];
  ms: number;
}

/** One cook to make in a folder: a graph's node (default: its output), named for the report. */
interface Job { graph: string; node?: string; label: string }

/**
 * Cook jobs in a folder that holds a package (a working folder, or a published version, which holds its copies and
 * lock): an engine of its own with the folder's packages, graphs and assets, as `topotopo` cooks a file there. A
 * failure is the cook's errors with their hints; nothing is written (no package is added on first use).
 */
async function cookIn(dir: string, jobs?: Job[]): Promise<Pick<CheckItem, 'outputs' | 'cooked' | 'failures' | 'skipped'>> {
  const engine = new Engine(createNodeHost({ baseDir: dir }));
  await engine.init();
  const failures: CheckItem['failures'] = [];
  const pk = openPackages(engine, dir);
  const notice = pk.notice();
  if (notice) failures.push({ where: 'packages', error: notice });
  const problems = loadPackage(engine, dir);
  let outputs = 0, cooked = 0;
  const skipped = new Set<string>();
  const working = jobs === undefined;
  if (!jobs) {
    const current = packageOutputs(dir);
    problems.push(...current.problems);
    for (const bad of current.invalid) failures.push({ where: bad.id, error: bad.message });
    outputs += current.invalid.length;
    jobs = current.outputs.map((o) => ({ graph: o.graph, node: o.node, label: o.label ?? o.id }));
    for (const g of graphFiles(dir).keys()) {
      if (engine.root.graphs?.(g)?.fragment === true && !jobs.some((j) => j.graph === g)) skipped.add(g);
    }
  }
  for (const p of new Set(problems)) failures.push({ where: 'files', error: p });
  for (const j of jobs) {
    const spec = engine.root.graphs?.(j.graph);
    if (!working && spec?.fragment === true) { skipped.add(j.graph); continue; }
    outputs++;
    if (!spec) { failures.push({ where: j.label, error: `there is no graph "${j.graph}"` }); continue; }
    const r = await engine.cook(spec, { target: j.node });
    if (r.ok && r.geo) { cooked++; continue; }
    failures.push({ where: j.label, error: r.errors.map((e) => `[${e.node}] ${e.message}${e.hint ? ` (${e.hint})` : ''}`).join('; ') || 'it cooks to no geometry' });
  }
  return { outputs, cooked, failures, skipped: [...skipped] };
}

/** The newest published version of each package that publishes, its outputs cooked in the version's folder; each name once. */
async function checkVersions(packages: Pick<Package, 'dir' | 'manifest'>[], seen: Set<string>, progress?: (what: string) => void): Promise<CheckItem[]> {
  const items: CheckItem[] = [];
  for (const p of packages) {
    const pkg = p.manifest.name;
    if (!pkg || seen.has(pkg)) continue;
    const v = publishedVersions(p.dir, pkg).at(-1);
    if (!v) continue;
    seen.add(pkg);
    progress?.(`${pkg} ${v.version}`);
    // each output once: the default output is also a named one, or an entry of its own
    const jobs = new Map<string, Job>();
    for (const [k, o] of Object.entries(v.outputs)) jobs.set(`${o.graph}\n${o.node}`, { graph: o.graph, node: o.node, label: `${pkg}/${k}` });
    if (!jobs.has(`${v.default.graph}\n${v.default.node}`)) jobs.set(`${v.default.graph}\n${v.default.node}`, { graph: v.default.graph, node: v.default.node, label: pkg });
    const r = await cookIn(path.join(p.dir, 'versions', v.version), [...jobs.values()]);
    items.push({ what: 'version', name: `${pkg} ${v.version}`, ...r });
  }
  return items;
}

/**
 * Check what the folder `start` belongs to (see the top of this file). `progress` hears what is cooked next. Writes
 * nothing but the .gdignore files a package inside a Godot project lacks (said).
 */
export async function checkAll(start: string, o: { progress?: (what: string) => void } = {}): Promise<CheckResult> {
  const t0 = performance.now();
  const problems: string[] = [], fixed: string[] = [], seen = new Set<string>();
  const { package: inside, workspace } = locate(start);
  let scope: string, versions: Pick<Package, 'dir' | 'manifest'>[] = [], graphs: { dir: string; name: string }[] = [];
  const libs: { name: string; root: string }[] = [];
  if (workspace) {
    let m: ReturnType<typeof readWorkspace> | null = null;
    try { m = readWorkspace(workspace); } catch (e: any) { problems.push(e.message); }
    scope = `workspace "${m?.name ?? path.basename(workspace)}" (${workspace})`;
    if (m) {
      const scan = scanWorkspace(workspace, m);
      problems.push(...scan.problems.map((p) => `the workspace "${m!.name}": ${p}`));
      versions = scan.packages;
      graphs = scan.packages.map((p) => ({ dir: p.dir, name: p.rel }));
      for (const p of scan.packages) fixed.push(...godotIgnore(p.dir));
      const listed = resolveListed(workspace, m.libraries);
      problems.push(...listed.problems);
      libs.push(...listed.libs.map((l) => ({ name: l.name, root: l.root })));
    }
  } else if (inside) {
    scope = `package ${path.basename(inside)} (${inside})`;
    const self = librariesFor(inside).self;
    if (self) libs.push({ name: self.name, root: self.root });
    versions = [{ dir: inside, manifest: readManifest(inside) }];
    graphs = [{ dir: inside, name: path.basename(inside) }];
    fixed.push(...godotIgnore(inside));
  } else {
    scope = 'the registered libraries';
    try { libs.push(...loadConfig().libraries.map((l) => ({ name: l.name, root: l.path }))); } catch (e: any) { problems.push(e.message); }
  }
  const items = await checkVersions(versions, seen, o.progress);
  for (const lib of libs) {
    const scan = scanTree(lib.name, lib.root);
    problems.push(...scan.problems.map((p) => `${libraryText(lib.name)}: ${p}`));
    items.push(...await checkVersions(scan.packages, seen, o.progress));
  }
  for (const p of graphs) {
    o.progress?.(`outputs of package ${p.name}`);
    items.push({ what: 'package', name: p.name, ...(await cookIn(p.dir)) });
  }
  return { scope, items, problems: [...new Set(problems)], fixed, ms: performance.now() - t0 };
}

/** A check as the CLI and the workspace tool say it: what broke first, with why, then what cooked. */
export function checkText(r: CheckResult): string {
  const broke = r.items.filter((i) => i.failures.length), fine = r.items.filter((i) => !i.failures.length);
  const versions = r.items.filter((i) => i.what === 'version'), packages = r.items.filter((i) => i.what === 'package');
  const n = packages.reduce((total, i) => total + i.outputs, 0);
  const scope = [
    ...(packages.length ? [`${n} output${n === 1 ? '' : 's'} of ${r.scope.startsWith('workspace ') ? "its packages'" : 'its'} graphs`] : []),
    ...(versions.length === 1 ? [`the published version ${versions[0].name}`]
      : versions.length ? [`${versions.length} published package versions (the newest of each)`] : []),
  ].join(' and ');
  const lines = [`check of ${r.scope}${scope ? `: ${scope}` : ''}, in ${(r.ms / 1000).toFixed(1)} s`];
  if (!r.items.length) lines.push(`nothing to check: no published package and no package (${program()} workspace library add <name or folder> lists a shared library for a workspace)`);
  for (const i of broke) {
    lines.push(`BROKEN  ${i.what === 'version' ? i.name : `package ${i.name}`}: ${i.failures.length} failure${i.failures.length === 1 ? '' : 's'}${i.cooked ? `, ${i.cooked} cooked` : ''}`);
    for (const f of i.failures) lines.push(`  ${f.where}: ${f.error}`);
  }
  if (fine.length) lines.push(`ok: ${fine.map((i) => `${i.what === 'version' ? i.name : `package ${i.name}`} (${i.cooked})`).join(', ')}`);
  const skipped = r.items.filter((i) => i.skipped.length);
  if (skipped.length) lines.push(`skipped, fragments ("fragment": true) that another graph or a script completes: ${skipped.map((i) => `${i.name} ${i.skipped.join(', ')}`).join('; ')}`);
  if (r.fixed.length) lines.push(`added ${r.fixed.length} missing .gdignore file${r.fixed.length === 1 ? '' : 's'}, which keep Godot's importer out of TopoTopo's working folders: ${r.fixed.join(', ')}`);
  if (r.problems.length) lines.push(`could not read ${r.problems.length}:`, ...r.problems.map((p) => `  ${p}`));
  const repair = broke.some((i) => i.what === 'version')
    ? ` Fix a broken version in its working folder, publish it again (${program()} publish), then update the packages that use it.`
    : ' Fix the errors in the graphs and run check again.';
  lines.push(broke.length
    ? `${broke.length} of ${r.items.length} broke; nothing ${r.fixed.length ? 'else ' : ''}was changed.${repair}`
    : `nothing broke; ${r.fixed.length ? 'nothing else was changed' : 'nothing was changed'}`);
  return lines.join('\n');
}

