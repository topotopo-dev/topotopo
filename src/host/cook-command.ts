// The cook for an engine as a command (the core is src/host/cook.ts, the flavours src/host/godot.ts and unreal.ts):
//   topotopo cook <.topo | package folder | folder>... --for godot|unreal [options]   cook packages into their engine project
//   topotopo cook --jobs <jobs.json> [--force] [--no-cache] [--progress json]         an engine plugin's form (integrations/godot/PROTOCOL.md)
import fs from 'node:fs';
import path from 'node:path';
import { program } from '../package.ts';
import { godotProjectOf } from '../engines.ts';
import { TOPOTOPO_VERSION } from './version.ts';
import { COOK_PROTOCOL, cachePrune, closeCookPools, cookPackage } from './cook.ts';
import type { CookJob, Flavour, PackageReport } from './cook.ts';
import { SetupError, cookTargets, godotFlavour, godotJob, parseArgs, resPath } from './godot.ts';
import type { GivenOptions } from './godot.ts';
import { GODOT_COMMANDS } from './godot-commands.ts';
import { UNREAL_COMMANDS } from './unreal-commands.ts';
import { contentPathOf, unrealFlavour, unrealJob, unrealProjectOf } from './unreal.ts';
import type { Io } from '../packages/commands.ts';

/** An engine a package can be cooked for. */
interface CookEngine {
  /** as "--for" and a jobs file's "for" name it */
  name: string;
  /** a package to cook, checked: throws a SetupError */
  job(topo: string, given: GivenOptions & { adopt?: boolean; report?: string; timeout?: number }): CookJob & { project: string };
  flavour(project: string): Flavour;
  /** an --into or a job's "into", as the engine's job reads it */
  into(text: string): string;
  /** a package's folder as the summary line names it */
  where(project: string, dir: string): string;
  /** what a plugin that speaks another protocol is told to do */
  update(topo: string | undefined): string;
}

const ENGINES: Record<string, CookEngine> = {
  godot: {
    name: 'godot', job: godotJob, flavour: godotFlavour,
    into: (t) => (/^res:\/\//.test(t) ? t : path.resolve(t)),
    where: (project, dir) => resPath(project, dir),
    update: (topo) => `update the Godot addon: ${program()} godot setup ${(topo && godotProjectOf(path.dirname(path.resolve(topo)))) || '<project>'}`,
  },
  unreal: {
    name: 'unreal', job: unrealJob, flavour: unrealFlavour,
    into: (t) => (/^\/[^/]/.test(t) ? t : path.resolve(t)),
    where: (project, dir) => contentPathOf(project, dir),
    update: (topo) => `update the Unreal plugin: ${program()} unreal setup ${(topo && unrealProjectOf(path.dirname(path.resolve(topo)))) || '<project>'}`,
  },
};
const engineNamed = (name: string): CookEngine => {
  const e = Object.hasOwn(ENGINES, name) ? ENGINES[name] : undefined;
  if (!e) throw new SetupError(`--for ${name}: only ${Object.keys(ENGINES).join(' and ')} are supported`);
  return e;
};

/** The cook command's usage. */
const cookUsage = () => [...GODOT_COMMANDS, ...UNREAL_COMMANDS].filter((c) => c.usage.startsWith('cook')).map((c) => `usage: ${program()} ${c.usage}`).join('\n');

const PER_PACKAGE = ['--into', '--skip', '--instancing', '--timeout', '--report'];

/** A list option ("a,b") as a list. */
const list = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean);

/**
 * topotopo cook … --for godot|unreal, and cook --jobs <file>: every package checked first (a usage, setup or protocol
 * error exits 2 and writes nothing), then cooked one after the other in this process; exit 1 when an output or a
 * package failed (records and reports are still written), else 0.
 */
export async function cookCommand(argv: string[], io: Io): Promise<number> {
  let jobs: (CookJob & { project: string })[];
  let engine: CookEngine;
  let flags: { force: boolean; noCache: boolean; json: boolean; quiet: boolean };
  try {
    const { opts, set, rest } = parseArgs(argv, ['--for', '--into', '--skip', '--instancing', '--timeout', '--report', '--progress', '--jobs'], ['--flat', '--adopt', '--force', '--no-cache', '--quiet'], cookUsage);
    const progress = opts['--progress'];
    if (progress !== undefined && progress !== 'json') throw new SetupError(`--progress takes json, got "${progress}"`);
    flags = { force: set.has('--force'), noCache: set.has('--no-cache'), json: progress === 'json', quiet: set.has('--quiet') };
    if (opts['--jobs'] !== undefined) {
      const extra = [...PER_PACKAGE.filter((f) => opts[f] !== undefined), ...['--flat', '--adopt'].filter((f) => set.has(f)), ...(rest.length ? [rest[0]] : [])];
      if (extra.length) throw new SetupError(`--jobs names the packages and their options itself: leave out ${extra.join(', ')}\n${cookUsage()}`);
      const read = readJobs(opts['--jobs'], opts['--for']);
      jobs = read.jobs; engine = read.engine;
    } else {
      if (opts['--for'] === undefined) throw new SetupError(`cook needs --for godot or --for unreal (the engine to cook into)\n${cookUsage()}`);
      engine = engineNamed(opts['--for']);
      if (!rest.length) throw new SetupError(`cook needs a .topo, a package folder or a folder\n${cookUsage()}`);
      const instancing = opts['--instancing'];
      if (instancing !== undefined && instancing !== 'packed' && instancing !== 'expand') throw new SetupError(`--instancing takes packed or expand, got "${instancing}"`);
      const timeout = opts['--timeout'] !== undefined ? Number(opts['--timeout']) : undefined;
      if (timeout !== undefined && !(timeout > 0)) throw new SetupError(`--timeout takes seconds above 0, got "${opts['--timeout']}"`);
      const topos = [...new Set(rest.flatMap(cookTargets))];
      if (opts['--report'] !== undefined && topos.length !== 1) throw new SetupError(`--report names one report file, and the targets hold ${topos.length} packages: cook them one at a time, or use --jobs`);
      const into = opts['--into'] === undefined ? undefined : engine.into(opts['--into']);
      const chosen = engine;
      jobs = topos.map((t) => chosen.job(t, {
        into, per_output_folders: set.has('--flat') ? false : undefined, skip: opts['--skip'] !== undefined ? list(opts['--skip']) : undefined,
        instancing: instancing as 'packed' | 'expand' | undefined, adopt: set.has('--adopt'), report: opts['--report'] !== undefined ? path.resolve(opts['--report']) : undefined, timeout,
      }));
      if (!jobs.length) { io.out(`no package below ${rest.join(', ')}: nothing to cook`); return 0; }
    }
  } catch (e: any) {
    io.err(e instanceof SetupError ? e.message : String(e?.message ?? e));
    return 2;
  }
  const human = (s: string) => { if (!flags.quiet) (flags.json ? io.err : io.out)(s); };
  let ok = true;
  try {
    for (const job of jobs) {
      const rep = await cookPackage(job, engine.flavour(job.project), { force: flags.force, noCache: flags.noCache, progress: flags.json ? (l) => io.out(l) : undefined });
      ok &&= rep.ok;
      human(summary(rep, job.project, engine));
      for (const line of failures(rep)) io.err(line);
    }
  } finally {
    await closeCookPools();
    cachePrune();
  }
  return ok ? 0 : 1;
}

/** A package's cook in a line. */
function summary(rep: PackageReport, project: string, engine: CookEngine): string {
  const where = (() => { try { return engine.where(project, rep.package.dir); } catch { return rep.package.dir; } })();
  if (!rep.outputs.length && rep.errors.length) return `${rep.package.id} (${where}): did not cook`;
  const by = (s: string) => rep.outputs.filter((o) => o.state === s).map((o) => o.id);
  const parts = ['written', 'cached', 'unchanged', 'failed', 'skipped'].map((s) => [s, by(s)] as const).filter(([, l]) => l.length).map(([s, l]) => `${s} ${l.join(', ')}`);
  return `${rep.package.id} (${where}): ${rep.outputs.length} output${rep.outputs.length === 1 ? '' : 's'}${parts.length ? `: ${parts.join('; ')}` : ''}; record ${rep.record}${rep.orphans.length ? `; ${rep.orphans.length} orphan file${rep.orphans.length === 1 ? '' : 's'} kept (no longer cooked): ${rep.orphans.join(', ')}` : ''} (${(rep.ms / 1000).toFixed(1)} s)`;
}

/** A package's failures and warnings, a line each, as the plugin's Output says them. */
function failures(rep: PackageReport): string[] {
  const out: string[] = [];
  for (const e of rep.errors) out.push(`TopoTopo: ${rep.package.id}: ${e}`);
  for (const o of rep.outputs) for (const e of o.errors) out.push(`TopoTopo: ${rep.package.id} > ${o.id}: ${e.node ? `[${e.node}] ` : ''}${e.message}${e.hint ? ` (hint: ${e.hint})` : ''}`);
  for (const w of rep.warnings) out.push(`TopoTopo: ${rep.package.id}: warning: ${w}`);
  return out;
}

/** A jobs file read and checked (protocol, engine, each job's package and options); throws a SetupError. */
export function readJobs(file: string, given?: string): { jobs: (CookJob & { project: string })[]; engine: CookEngine } {
  let raw: any;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (e: any) { throw new SetupError(`the jobs file ${file} cannot be read: ${e.message}`); }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.jobs)) throw new SetupError(`${file} is no jobs file: {"for": "godot" or "unreal", "protocol": ${COOK_PROTOCOL}, "jobs": [...]}`);
  if (raw.for !== undefined && (typeof raw.for !== 'string' || !Object.hasOwn(ENGINES, raw.for))) throw new SetupError(`the jobs file is for ${JSON.stringify(raw.for)}: only ${Object.keys(ENGINES).join(' and ')} are supported`);
  if (given !== undefined) engineNamed(given);
  if (given !== undefined && raw.for !== undefined && raw.for !== given) throw new SetupError(`--for ${given}, and the jobs file is for ${raw.for}`);
  const engine = engineNamed(given ?? raw.for ?? 'godot');
  if (raw.protocol !== COOK_PROTOCOL) {
    const topo = raw.jobs.find((j: any) => typeof j?.package === 'string')?.package;
    throw new SetupError(`the jobs file speaks protocol ${JSON.stringify(raw.protocol)} and this TopoTopo ${TOPOTOPO_VERSION} speaks ${COOK_PROTOCOL}: ${engine.update(topo)}`);
  }
  const jobs = raw.jobs.map((j: any, i: number) => {
    const at = `${file}: job ${i + 1}`;
    if (!j || typeof j.package !== 'string') throw new SetupError(`${at} names no "package" (the .topo's absolute path)`);
    const isDir = !!fs.statSync(j.package, { throwIfNoEntry: false })?.isDirectory();
    const topo = isDir ? cookTargets(j.package)[0] : j.package;
    if (!topo || !fs.statSync(topo, { throwIfNoEntry: false })?.isFile()) throw new SetupError(`${at}: no package at ${j.package}`);
    if (j.instancing !== undefined && j.instancing !== 'packed' && j.instancing !== 'expand') throw new SetupError(`${at}: "instancing" is packed or expand`);
    if (j.skip !== undefined && (!Array.isArray(j.skip) || j.skip.some((s: unknown) => typeof s !== 'string'))) throw new SetupError(`${at}: "skip" is a list of output ids`);
    if (j.timeout !== undefined && !(typeof j.timeout === 'number' && j.timeout > 0)) throw new SetupError(`${at}: "timeout" is seconds above 0`);
    if (j.into !== undefined && typeof j.into !== 'string') throw new SetupError(`${at}: "into" is a folder`);
    return engine.job(topo, {
      into: j.into === undefined ? undefined : engine.into(j.into),
      per_output_folders: typeof j.per_output_folders === 'boolean' ? j.per_output_folders : undefined, skip: j.skip, instancing: j.instancing,
      adopt: j.adopt === true, report: typeof j.report === 'string' ? path.resolve(j.report) : undefined, timeout: j.timeout,
    });
  });
  return { jobs, engine };
}
