// Out of date and Update (the registry is src/gallery/packages.ts): the newer versions of the packages a project uses,
// and the before/after of an update. The before/after finds every place the project uses the package (each node of
// its type in the project's graphs, assets and graph files, nested graphs included, with its params and inputs as they
// are), cooks each with the version in use and with the version the update goes to, says what changed (diffGeometry)
// and draws an overlay; with it come the notes of the versions between them and, for a big version, what the graphs
// must change. Nothing is written: the new version is read where its library holds it. Applying is a step of its own,
// taken when the person says so.
//
// Graphs and assets cook in the project's root scope (as a session has them; a command reads them with
// loadProject, the viewer of a graph file into a scope of their own: BeforeAfterOptions.project), with the version in
// use, and in a scope like it whose packages resolve the update's version. A graph file elsewhere in the folder cooks
// in a scope of its folder, as `topotopo <file>` cooks it. A use inside a nested graph (a foreach or solver body) is
// compared through the node that holds it. Each cook gets only what its node needs, so another node's error stays out
// of it, and reuses the engine's cache.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { Geometry } from '../core/geometry.ts';
import { expandPacked } from '../core/packed.ts';
import { diffGeometry, diffOverlay } from '../explain.ts';
import type { DiffResult } from '../explain.ts';
import { wiringOf } from '../graph/engine.ts';
import type { CookReport, NodeProgress, StopSignal } from '../graph/engine.ts';
import { migrateGraph } from '../graph/migrate.ts';
import { upstreamOf } from '../graph/packages.ts';
import { didYouMean, resolveParamName } from '../graph/params.ts';
import { parsePackageName } from '../graph/scope.ts';
import type { PackageResolver, Scope } from '../graph/scope.ts';
import type { GraphSpec, NodeSpec } from '../graph/types.ts';
import { encodePNG } from '../render/png.ts';
import { renderGeometry } from '../render/raster.ts';
import { NAME_RE } from '../session.ts';
import { program } from './library.ts';
import { compareInterfaces, compareVersions, kindChanges, libraryText } from './packages.ts';
import type { ProjectPackages, UpdateTarget } from './packages.ts';

/**
 * Folders a search for graph files does not enter: anywhere, those holding data and exports (a graph file has its own
 * inputs/ and exports/ beside it) and node_modules; at the top of the project, its own folders (graphs/ and assets/
 * are read as such); never dot-folders or another project's folder.
 */
const NO_GRAPHS = new Set(['inputs', 'exports', 'node_modules']);
const OWN = new Set(['graphs', 'assets', 'attachments', 'versions', 'packages']);
/** Graph files are read up to this size (a graph is up to about 100 KB). */
const MAX_GRAPH_BYTES = 16 * 2 ** 20;
/** Packed results are compared expanded, up to this many triangles. */
const MAX_TRIANGLES = 4_000_000;

const isGraph = (v: unknown): v is GraphSpec => !!v && typeof v === 'object' && !Array.isArray(v) && !!(v as GraphSpec).nodes && typeof (v as GraphSpec).nodes === 'object' && !Array.isArray((v as GraphSpec).nodes);

type GraphKind = 'graph' | 'asset' | 'file';

/** A graph of the project: one in graphs/, an asset in assets/, or a graph file elsewhere in its folder. */
interface ProjectGraph {
  /** the file, posix and relative to the project */
  file: string;
  kind: GraphKind;
  spec: GraphSpec;
  /** a graph file's folder, where its relative paths read */
  folder?: string;
}

/** A node of the package's type in a graph of the project. */
export interface UsePlace {
  file: string;
  kind: GraphKind;
  /** the node: "pine", or "loop/pine" for one in the nested graph of node "loop" */
  node: string;
  type: string;
  spec: NodeSpec;
}

/** How one side of a comparison cooked; `cooked`: the nodes it cooked, the others came from the cache. */
export interface CookedSide { ok: boolean; geo: Geometry | null; errors: string[]; warnings: string[]; cooked: number }

/** A node of a graph cooked with each version: a use, or the node whose nested graph holds uses. */
export interface Compared {
  file: string;
  kind: GraphKind;
  node: string;
  /** the uses it holds: the node itself, or those in its nested graphs */
  uses: UsePlace[];
  before: CookedSide;
  after: CookedSide;
  /** when both cooked: what changed, and the two results compared (packed ones expanded) */
  diff?: DiffResult;
  geo?: [Geometry, Geometry];
  /** what expanding packed results says (a subset above the triangle budget) */
  notes: string[];
}

export interface BeforeAfter {
  target: UpdateTarget;
  /** "project forest" */
  project: string;
  /** every place the project uses the package, and the cooks that compare them */
  uses: UsePlace[];
  compared: Compared[];
  /** how many cooks compare all the places (compared is shorter when stopped) */
  total: number;
  /** what goes away or means something else between the two versions, and the other changes (compareInterfaces) */
  interfaceBig: string[];
  interfaceSmall: string[];
  /** what the project's graphs must change for the version the update goes to */
  mustChange: string[];
  /** stopped (BeforeAfterOptions.signal) before every place was compared */
  stopped: boolean;
  /** graph files that could not be read, the new version's own problems */
  problems: string[];
  ms: number;
}

export interface BeforeAfterOptions {
  /** the version to go to (default: the newest with the same big number) */
  to?: string;
  /** a person's stop: the cooks stop at their next node and the comparison ends there */
  signal?: StopSignal;
  /** before each cook: the cooks done, of all, and what cooks now */
  progress?: (done: number, total: number, what: string) => void;
  /**
   * Where the project's graphs and assets are when the engine's root does not hold them (the viewer of a graph file
   * keeps its session in a scratch folder): a scope that holds them (loadProject), whose packages are the project's
   * resolver, and the project folder their relative paths read.
   */
  project?: { scope: Scope; folder: string };
}

// ---------------------------------------------------------------------------------------------- the project's uses

/** The graphs of the project that name the package: in graphs/, in assets/, and graph files elsewhere in its folder. */
function graphsNaming(dir: string, pkg: string, problems: string[]): ProjectGraph[] {
  const out: ProjectGraph[] = [];
  const read = (abs: string, file: string, kind: GraphKind) => {
    let text: string;
    try {
      if (fs.statSync(abs).size > MAX_GRAPH_BYTES) return;
      text = fs.readFileSync(abs, 'utf8');
    } catch (e: any) { problems.push(`${file}: ${e.message}`); return; }
    // only graphs that name the package matter: its name starts a node's type
    if (!text.includes(`"${pkg}`)) return;
    let spec: unknown;
    try { spec = JSON.parse(text); } catch (e: any) { if (kind !== 'file') problems.push(`${file}: ${e.message}`); return; }
    if (!isGraph(spec)) return;
    try { out.push({ file, kind, spec: migrateGraph(spec), ...(kind === 'file' ? { folder: path.dirname(abs) } : {}) }); }
    catch (e: any) { problems.push(`${file}: ${e.message}`); }
  };
  for (const [sub, kind] of [['graphs', 'graph'], ['assets', 'asset']] as const) {
    let files: string[] = [];
    try { files = fs.readdirSync(path.join(dir, sub)).filter((f) => f.endsWith('.json')).sort(); } catch { /* none */ }
    for (const f of files) if (kind === 'asset' || NAME_RE.test(f.slice(0, -5))) read(path.join(dir, sub, f), `${sub}/${f}`, kind);
  }
  // graph files elsewhere in the folder, which `topotopo <file>` and `topotopo view` cook; not those of another project
  const walk = (d: string, rel: string, depth: number) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(d, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!NO_GRAPHS.has(e.name) && !(depth === 0 && OWN.has(e.name)) && depth < 8 && !fs.existsSync(path.join(abs, 'project.json'))) walk(abs, r, depth + 1);
      } else if (e.isFile() && e.name.endsWith('.json') && e.name !== 'project.json') read(abs, r, 'file');
    }
  };
  walk(dir, '', 0);
  return out;
}

/** The nodes of a graph whose type is an output of `pkg`, nested graphs included, and the top-level node holding each. */
function usesIn(g: GraphSpec, pkg: string): { node: string; top: string; spec: NodeSpec }[] {
  const out: { node: string; top: string; spec: NodeSpec }[] = [];
  const walk = (x: GraphSpec, prefix: string, top: string | null, depth: number) => {
    if (depth > 64) return;
    for (const [name, spec] of Object.entries(x.nodes)) {
      if (!spec || typeof spec !== 'object') continue;
      if (typeof spec.type === 'string' && spec.type.includes('/')) {
        const n = parsePackageName(spec.type);
        if (typeof n !== 'string' && n.package === pkg) out.push({ node: prefix + name, top: top ?? name, spec });
      }
      if (spec.params && typeof spec.params === 'object') for (const v of Object.values(spec.params)) if (isGraph(v)) walk(v, `${prefix}${name}/`, top ?? name, depth + 1);
    }
  };
  walk(g, '', null, 0);
  return out;
}

/** Every place the project uses the package, and the cooks that compare them: a graph's node with the uses it holds. */
function placesOf(dir: string, pkg: string, problems: string[]): { uses: UsePlace[]; units: { g: ProjectGraph; node: string; uses: UsePlace[] }[] } {
  const uses: UsePlace[] = [], units: { g: ProjectGraph; node: string; uses: UsePlace[] }[] = [];
  for (const g of graphsNaming(dir, pkg, problems)) {
    const byTop = new Map<string, UsePlace[]>();
    for (const u of usesIn(g.spec, pkg)) {
      const place: UsePlace = { file: g.file, kind: g.kind, node: u.node, type: u.spec.type, spec: u.spec };
      uses.push(place);
      if (!byTop.has(u.top)) byTop.set(u.top, []);
      byTop.get(u.top)!.push(place);
    }
    for (const [node, list] of byTop) units.push({ g, node, uses: list });
  }
  return { uses, units };
}

/**
 * What the project's graphs must change for the version the update goes to: outputs they use that it does not have,
 * params they set that it does not have (with did-you-mean over its params), values they set that its narrower range
 * clamps or that are options it no longer has, inputs they wire that it does not have.
 */
function mustChange(uses: UsePlace[], before: PackageResolver, after: PackageResolver, t: UpdateTarget): { must: string[]; problems: string[] } {
  const must: string[] = [], problems: string[] = [], at = `${t.package} ${t.to}`;
  // the version loads when the resolver names its outputs; else what it says is a problem of the version, not a change
  const loads = after.names().some((n) => n === t.package || n.startsWith(`${t.package}/`));
  for (const u of uses) {
    const where = `${u.file} ${u.node}`;
    const was = before.resolve(u.type), now = after.resolve(u.type);
    if ('error' in now) {
      const said = `${now.error}${now.hint ? ` (${now.hint})` : ''}`;
      if (loads) must.push(`${where}: uses ${u.type}, and ${said}`);
      else if (!problems.includes(said)) problems.push(said);
      continue;
    }
    // a use that does not resolve now does not resolve after either: the update changes nothing about it
    if ('error' in was) continue;
    for (const [k, value] of Object.entries(u.spec.params ?? {})) {
      if (!resolveParamName(was, k)) continue;
      const pn = resolveParamName(now, k);
      if (!pn) {
        const s = didYouMean(k, Object.keys(now.params));
        must.push(`${where}: sets param "${k}", which ${at} does not have${s.length ? ` — did you mean ${s.map((x) => `"${x}"`).join(' or ')}?` : ''} (its params: ${Object.keys(now.params).join(', ') || 'none'})`);
        continue;
      }
      // a value the new version takes otherwise: clamped to a narrower range, or an option it no longer has
      const p = now.params[pn];
      if (typeof value === 'number') {
        const clamped = Math.min(p.max ?? Infinity, Math.max(p.min ?? -Infinity, value));
        if (clamped !== value) must.push(`${where}: sets "${k}" ${value}, which ${at} clamps to ${clamped} (its range is ${p.min ?? ''}..${p.max ?? ''})`);
      }
      if (p.options && (typeof value === 'number' || (typeof value === 'string' && !value.startsWith('='))) && !p.options.includes(value as any))
        must.push(`${where}: sets "${k}" ${JSON.stringify(value)}, an option ${at} does not have (its options: ${p.options.map((x) => JSON.stringify(x)).join(', ')})`);
    }
    wiringOf(u.spec, was).list.forEach((ref, i) => {
      if (!ref) return;
      const label = was.inputs[i]?.desc ?? `input ${i}`, there = now.inputs.findIndex((x) => x.desc === label);
      if (i >= now.inputs.length) must.push(`${where}: wires input ${i} ("${label}"), which ${at} does not have${there >= 0 ? `: it is input ${there} there` : ` (it has ${now.inputs.length === 1 ? '1 input' : `${now.inputs.length} inputs`})`}`);
      else if (there >= 0 && there !== i && now.inputs[i].desc !== label) must.push(`${where}: wires input ${i} ("${label}"), which is input ${there} in ${at}`);
    });
  }
  return { must, problems };
}

// ---------------------------------------------------------------------------------------------------- cooking

/** The graph with only what `target` needs, upstream: its inputs and the nodes its expressions read. */
function needed(g: GraphSpec, target: string): GraphSpec {
  const keep = new Set(upstreamOf(g, target));
  const out: GraphSpec = { ...g, nodes: Object.fromEntries(Object.entries(g.nodes).filter(([k]) => keep.has(k))), output: target };
  delete out.outputs;
  delete out.export;
  return out;
}

/** A cook's progress hook that lets the event loop turn every 15 ms or so, so a stop and other requests get through. */
function yielding(): (ev: NodeProgress) => Promise<void> | void {
  let last = performance.now();
  return (ev) => {
    if (ev.phase === 'end' || performance.now() - last < 15) return;
    last = performance.now();
    return new Promise<void>((resolve) => setImmediate(resolve));
  };
}

const sideOf = (r: CookReport): CookedSide => ({
  ok: r.ok && !!r.geo, geo: r.ok ? r.geo : null,
  errors: r.errors.map((e) => `[${e.node}] ${e.message}${e.hint ? ` (hint: ${e.hint})` : ''}`),
  warnings: r.warnings.map((w) => `[${w.node}] ${w.message}`),
  cooked: [...r.results.values()].filter((x) => !x.cached && !x.error).length,
});

/**
 * The before/after of updating a package the project uses (to `o.to`, or the newest version with the same big
 * number): every place it is used, cooked with both versions and compared, the notes of the versions between, and
 * for a big version what the graphs must change. Throws when there is no update (ProjectPackages.updateTarget).
 */
export async function beforeAfter(pk: ProjectPackages, pkg: string, o: BeforeAfterOptions = {}): Promise<BeforeAfter> {
  const t0 = performance.now();
  const t = pk.updateTarget(pkg, o.to);
  const { dir } = pk.project();
  const engine = pk.engine, root = o.project?.scope ?? engine.root;
  const { before, after, key, problems: versionProblems } = pk.updateResolvers(t);
  const problems: string[] = [];
  const { uses, units } = placesOf(dir, pkg, problems);
  // graphs and assets: the project's root, and a scope like it with the update's packages; graph files: their folder
  const scopes = new Map<string, { before: Scope; after: Scope }>();
  const scopesOf = (g: ProjectGraph) => {
    const id = g.folder ?? '';
    let s = scopes.get(id);
    if (!s) {
      const like = (name: string, packages: PackageResolver) => (g.folder
        ? engine.createScope(`update ${name} ${key} ${g.folder}`, { folder: g.folder, packages })
        : engine.createScope(`update ${name} ${key}${o.project ? ` ${o.project.folder}` : ''}`, { assets: root.assets, graphs: (n) => root.graphs?.(n), packages, ...(o.project ? { folder: o.project.folder } : {}) }));
      s = { before: !g.folder && before === pk.resolver ? root : like('before', before), after: like('after', after) };
      scopes.set(id, s);
    }
    return s;
  };
  const onNode = yielding();
  const total = units.length * 2;
  const compared: Compared[] = [];
  let done = 0, stopped = false;
  const cook = async (u: (typeof units)[number], scope: Scope, v: string) => {
    o.progress?.(done, total, `${u.g.file} ${u.node} with ${t.package} ${v}`);
    const r = await engine.cook(needed(u.g.spec, u.node), { target: u.node, scope, signal: o.signal, onNode });
    done++;
    return r;
  };
  for (const u of units) {
    if (o.signal?.aborted) { stopped = true; break; }
    const s = scopesOf(u.g);
    const rb = await cook(u, s.before, t.from);
    const ra = rb.stopped ? rb : await cook(u, s.after, t.to);
    if (rb.stopped || ra.stopped) { stopped = true; break; }
    const c: Compared = { file: u.g.file, kind: u.g.kind, node: u.node, uses: u.uses, before: sideOf(rb), after: sideOf(ra), notes: [] };
    if (c.before.geo && c.after.geo) {
      const [x, y] = [c.before.geo, c.after.geo].map((g) => (g.hasPacked() ? expandPacked(g, { maxTriangles: MAX_TRIANGLES }) : { geo: g, notes: [] as string[] }));
      if (c.before.geo.hasPacked() || c.after.geo.hasPacked()) c.notes.push('packed instances compared expanded', ...new Set([...x.notes, ...y.notes]));
      c.diff = diffGeometry(x.geo, y.geo, [`${t.package} ${t.from}`, `${t.package} ${t.to}`]);
      c.geo = [x.geo, y.geo];
    }
    compared.push(c);
  }
  const m = mustChange(uses, before, after, t);
  const ic = t.fromInfo ? compareInterfaces(t.fromInfo, t.toInfo) : { big: [], small: [] };
  return {
    target: t, project: pk.label, uses, compared, total, interfaceBig: ic.big, interfaceSmall: ic.small, mustChange: m.must, stopped,
    problems: [...new Set([...problems, ...m.problems, ...versionProblems()])], ms: performance.now() - t0,
  };
}

/**
 * Apply an update, the step after its before/after, from the version in use to the version it showed (both named: what
 * the person saw, and refused when project.json uses another version now): copy the version in with what it uses, name
 * it in "uses" and the lock, delete the copies nothing uses any more, and say what the graphs must change for it (a big
 * version is applied anyway: the graphs report those errors until they change). The CLI, the library tool and the
 * viewer apply updates through it.
 */
export function applyUpdate(pk: ProjectPackages, pkg: string, o: { from: string; to: string }): { target: UpdateTarget; text: string; mustChange: string[] } {
  if (typeof o?.from !== 'string' || typeof o?.to !== 'string') throw new Error('applying an update needs "from" and "to": the version in use and the version of the before/after the person saw');
  const { dir } = pk.project();
  pk.refresh();
  const now = pk.manifest?.uses[pkg];
  if (now !== undefined && now !== o.from) throw new Error(`project.json uses ${pkg} ${now} now, not ${o.from}: look at the before/after again`);
  const t = pk.updateTarget(pkg, o.to);
  const { before, after } = pk.updateResolvers(t);
  const m = mustChange(placesOf(dir, pkg, []).uses, before, after, t);
  const r = pk.applyUpdate(t);
  const lines = [r.text];
  if (m.must.length) lines.push(`the project's graphs must change for ${t.package} ${t.to}; until they do, they report these errors:`, ...m.must.map((x) => `  ${x}`));
  return { target: t, text: lines.join('\n'), mustChange: m.must };
}

/**
 * Remove a package the project uses (ProjectPackages.remove): refused while a graph of the project still names it (in
 * graphs/, assets/ or a graph file in its folder, nested graphs included), which it lists.
 */
export function removePackage(pk: ProjectPackages, pkg: string): { deleted: string[]; text: string } {
  const { dir } = pk.project();
  pk.refresh();
  const places = typeof parsePackageName(pkg) === 'string' ? [] : placesOf(dir, pkg, []).uses.map((u) => `${u.file} ${u.node}`);
  return pk.remove(pkg, places);
}

// ---------------------------------------------------------------------------------------------- what is said

/** A node's params and wiring, short (with a space before it, empty when it sets none). */
export function setText(spec: NodeSpec): string {
  const parts: string[] = [];
  if (spec.params && Object.keys(spec.params).length) parts.push(JSON.stringify(spec.params));
  if (spec.in !== undefined && spec.in !== null && (typeof spec.in !== 'object' || Object.keys(spec.in).length)) parts.push(`in ${JSON.stringify(spec.in)}`);
  const s = parts.join(' ');
  return s ? ` ${s.length > 120 ? `${s.slice(0, 117)}…` : s}` : '';
}

/** A before/after as the CLI and the library tool say it, ending with `closing` (how to apply it). */
export function beforeAfterText(r: BeforeAfter, closing: string): string {
  const t = r.target, up = compareVersions(t.to, t.from) > 0;
  const kind = t.big ? (up ? 'a big update' : 'back to an older big version') : up ? 'a small update' : 'back to an older version';
  const lines = [`before/after: ${t.package} ${t.from} → ${t.to} (${kind}) in ${r.project}; nothing has changed yet`];
  lines.push(`${t.package} ${t.to} is in ${libraryText(t.library)}. ${up ? `The versions after ${t.from}` : `The versions it goes back over`}:`, ...t.between.map((v) => `  ${v.version}  "${v.note}"`));
  if (t.big) {
    const step = up ? `${t.to} is a big version` : `going back to ${t.to} crosses a big version`;
    lines.push(r.interfaceBig.length ? `${step}; what goes away or means something else:` : `${step}: nothing goes away between the two, and a version between was marked big by its author, its meaning changed in a way the tools cannot see (its note says how)`);
    lines.push(...r.interfaceBig.map((x) => `  ${x}`));
  }
  if (r.mustChange.length) lines.push(`what the project's graphs must change (updating is allowed; until they change, they report these errors):`, ...r.mustChange.map((x) => `  ${x}`));
  if (!r.uses.length) lines.push(`no graph of the project uses ${t.package}: the update changes no geometry`);
  else {
    lines.push(`${r.uses.length === 1 ? '1 place uses' : `${r.uses.length} places use`} ${t.package}; each cooked with ${t.from} (a) and with ${t.to} (b):`);
    for (const c of r.compared) {
      const self = c.uses.length === 1 && c.uses[0].node === c.node;
      lines.push(`  ${c.file}  ${c.node}: ${self ? `${c.uses[0].type}${setText(c.uses[0].spec)}` : `holds ${c.uses.map((u) => `${u.node} (${u.type}${setText(u.spec)})`).join(', ')}; its result compared`}`);
      if (!c.before.ok) lines.push(`    with ${t.from} it does not cook: ${c.before.errors.join('; ') || 'no geometry'}`);
      if (!c.after.ok) lines.push(`    with ${t.to} it does not cook: ${c.after.errors.join('; ') || 'no geometry'}`);
      if (c.diff) {
        if (c.diff.identical) lines.push(`    ${/^verdict: (.*)$/m.exec(c.diff.text)?.[1] ?? 'no geometric change'}`);
        else lines.push(...c.diff.text.split('\n').slice(1).map((l) => `    ${l}`));
      }
      if (c.notes.length) lines.push(`    (${c.notes.join('; ')})`);
    }
    const changed = r.compared.filter((c) => c.diff && !c.diff.identical).length, failed = r.compared.filter((c) => !c.after.ok).length;
    lines.push(`in short: ${changed} of the ${r.compared.length} compared changed${failed ? `, ${failed} ${failed === 1 ? 'does' : 'do'} not cook with ${t.to}` : ''}${r.stopped ? `; stopped after ${r.compared.length} of ${r.total / 2} comparisons: the others are not listed` : ''}`);
  }
  if (r.problems.length) lines.push('problems:', ...r.problems.map((p) => `  ${p}`));
  lines.push(closing);
  return lines.join('\n');
}

/**
 * Overlay renders of the places that changed most (at most `max`): b where it lies on a grey, b away from a blue (moved
 * or new with the new version), a away from b orange (moved from or gone).
 */
export function overlayRenders(r: BeforeAfter, max = 6): { title: string; png: Uint8Array }[] {
  const far = (c: Compared) => (Number.isFinite(c.diff!.hausdorff) ? c.diff!.hausdorff : Number.MAX_VALUE);
  return r.compared
    .filter((c) => c.diff && !c.diff.identical && c.geo && c.geo[0].numPoints && c.geo[1].numPoints)
    .sort((a, b) => far(b) - far(a))
    .slice(0, max)
    .map((c) => {
      const img = renderGeometry(diffOverlay(c.geo![0], c.geo![1]), { size: 300, title: `${c.file} ${c.node}: orange ${r.target.from}, blue ${r.target.to}` });
      return { title: `${c.file} ${c.node}`, png: encodePNG(img.rgba, img.width, img.height, (d) => zlib.deflateSync(d, { level: 6 })) };
    });
}

/**
 * The out-of-date packages of a project as the CLI (or, `mcp`, the library tool) says them: each with the notes of the
 * versions after the one in use (and the outputs of another kind), then one line for those up to date, what could not
 * be checked, and the update to run for each. `folder`: the project folder as the command named it, for those lines.
 */
export function outdatedText(pk: ProjectPackages, mcp = false, folder?: string): string {
  const problems: string[] = [];
  const list = pk.outdated(problems);
  if (!list.length) return `${pk.label} uses no packages${problems.length ? `\ncould not check ${problems.length}:\n${problems.map((p) => `  ${p}`).join('\n')}` : ''}`;
  const late = list.filter((o) => o.small || o.big), fine = list.filter((o) => !o.error && !o.small && !o.big), failed = list.filter((o) => o.error);
  const counts = [late.length ? `${late.length} out of date` : '', fine.length ? `${fine.length} up to date` : '', failed.length || problems.length ? `could not check ${failed.length + problems.length}` : ''].filter(Boolean);
  const lines = [`${pk.label} uses ${list.length} package${list.length === 1 ? '' : 's'}: ${counts.join(', ')}`];
  for (const o of late) {
    lines.push(`  ${o.package} ${o.version}: ${[o.small ? `${o.small} is out` : '', o.big ? `${o.big} is out (big)` : ''].filter(Boolean).join(', ')}  [${o.libraries.map(libraryText).join(', ')}]`);
    // each newer version's note, and its outputs of another kind
    let was = pk.copyInfo(o.package, o.version);
    for (const v of o.newer) {
      const kinds = was ? kindChanges(was, v) : [];
      lines.push(`    ${v.version}  "${v.note}"${kinds.length ? `  (another kind: ${kinds.join('; ')})` : ''}`);
      was = v;
    }
  }
  if (fine.length) lines.push(`${fine.length} up to date: ${fine.map((o) => `${o.package} ${o.version}`).join(', ')}`);
  if (failed.length || problems.length) lines.push(`could not check ${failed.length + problems.length}:`, ...failed.map((o) => `  ${o.package} ${o.version}: ${o.error}`), ...problems.map((p) => `  ${p}`));
  const at = folder ? ` ${/\s/.test(folder) ? JSON.stringify(folder) : folder}` : '';
  for (const o of late) {
    const to = o.small ?? o.big!;
    lines.push(mcp
      ? `library {action:"update", package:"${o.package}"${o.small ? '' : `, to:"${to}"`}} shows the before/after of ${o.version} → ${to}; nothing changes until the person says so`
      : `${program()} update ${o.package}${at}${o.small ? '' : ` --to ${to}`} shows the before/after of ${o.version} → ${to}; nothing changes until you apply it`);
    if (o.small && o.big) lines.push(mcp ? `  the big one: library {action:"update", package:"${o.package}", to:"${o.big}"}` : `  the big one: ${program()} update ${o.package}${at} --to ${o.big}`);
  }
  return lines.join('\n');
}
