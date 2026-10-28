import type { Geometry } from '../core/geometry.ts';
import type { CookOptions, CookReport, Engine, StopSignal } from './engine.ts';
import type { PackageOutput } from './packages.ts';
import type { Kind } from './outputs.ts';
import type { KernelJob, ParallelOptions, ParallelRun } from './parallel.ts';
import type { Scope } from './scope.ts';

/** Current graph format version. Bump it together with a migration in migrate.ts. */
export const GRAPH_VERSION = 1;

export type ParamType =
  | 'float' | 'int' | 'bool' | 'string' | 'enum'
  | 'vec2' | 'vec3' | 'vec4' | 'ivec2' | 'ivec3' | 'color'
  | 'code' | 'group' | 'ramp' | 'json' | 'graph' | 'path';

export interface ParamDef {
  type: ParamType;
  desc: string;
  default?: any;
  min?: number;
  max?: number;
  /** enum choices: strings or numbers; the param's value is the option itself (numeric options give numbers) */
  options?: (string | number)[];
  aliases?: string[];
  /** for 'group' params: which element class the pattern selects */
  groupClass?: 'point' | 'prim' | 'vertex' | 'edge';
  /** GUI hint: hide behind an "advanced" fold */
  advanced?: boolean;
}

export interface InputDef {
  name: string;
  desc: string;
  optional?: boolean;
  /** variadic input (merge/switch): accepts any number of connections */
  multi?: boolean;
}

export interface NodeDef {
  type: string;
  category: string;
  summary: string;
  description?: string;
  aliases?: string[];
  inputs: InputDef[];
  params: Record<string, ParamDef>;
  /** attributes / groups the node writes, for docs */
  outputs?: string;
  /** a minimal example node spec (or small graph) for docs */
  example?: any;
  /**
   * The node's code reads graph vars by their bare name, so they key its cache: a function giving the code it runs
   * (from the resolved params; only the vars named in it count, src/core/usercode.ts codeVarNames), or true for any
   * var (loop bodies, and scripts, whose lib.run "=expr" params can read every var).
   */
  usesVars?: true | ((p: Record<string, any>) => string);
  /**
   * the node always depends on the cook time (e.g. solver): frame/time are mixed into its signature.
   * Other nodes become time-dependent per cook when their "=expr" params read frame/time/fps or when
   * their cook reads ctx.frame / ctx.time / ctx.fps / ctx.timeInc.
   */
  usesTime?: boolean;
  /**
   * The result depends on the scope the node cooks in (CookContext.scope): the node reads files or graphs through it,
   * or cooks nested graphs in it (subcook, lib.run), whose node types resolve there. Every node that reads ctx.scope,
   * or calls ctx.subcook without naming a scope (CookOptions.scope), says so. Outside the root scope the scope's id is
   * then part of its signature.
   */
  usesScope?: boolean;
  /** deprecation notice naming the replacement; hidden from the catalog, warned about on cook */
  deprecated?: string;
  /**
   * Packed primitives: 'keep' = the node handles packed prims (instances) in its inputs; 'unpack' (default) = the
   * engine expands them before cooking the node, with a warning. A function decides per cook from the resolved params.
   */
  packed?: 'keep' | 'unpack' | ((p: Record<string, any>) => 'keep' | 'unpack');
  /**
   * Spline prims (Bezier/NURBS curves): 'keep' = the node handles them (moves CVs, edits attributes or evaluates the
   * curves itself); 'polyline' = the engine converts them to polylines before cooking the node, with a warning. Default:
   * 'keep' when the node keeps packed prims (it works on elements and points, not on polygon shapes), else 'polyline'.
   */
  splines?: 'keep' | 'polyline' | ((p: Record<string, any>) => 'keep' | 'polyline');
  /**
   * The inputs the cook reads, decided from the resolved params before any input is cooked (switch: only the
   * selected candidate). Inputs marked false are not cooked and appear as null. Default: all inputs.
   */
  inputsUsed?: (p: Record<string, any>, count: number) => boolean[];
  /** extra cache-key material (e.g. file mtime), from the scope the node cooks in */
  signatureExtra?: (p: Record<string, any>, scope: Scope) => string;
  /** a package output's node type (src/graph/packages.ts): the package, its version and what it cooks */
  package?: PackageOutput;
  cook(ctx: CookContext): Geometry | Promise<Geometry>;
}

export interface NodeSpec {
  type: string;
  in?: string | (string | null)[] | Record<string, string | null>;
  params?: Record<string, any>;
  bypass?: boolean;
  note?: string;
  ui?: any;
}

/** An exposed var: asset parameter docs and range, and the control the live viewer draws for it. */
export interface VarDef {
  type?: string;
  default?: any;
  desc?: string;
  min?: number;
  max?: number;
  /** choices (type enum): strings or numbers, and the var holds the option itself */
  options?: (string | number)[];
  /** control label for humans (default: the var name) */
  label?: string;
  /** slider step (default: 1 for ints, else derived from the range) */
  step?: number;
}

/** Free-form graph metadata (showcase render presets, editor layout, …). */
export interface GraphMeta {
  [key: string]: any;
}

/**
 * Where a published output exports to: a format name ("glb"), written as exports/<output>.<ext>, or an object with
 * the format, an optional path inside exports/ and the export tool's options ({format: "obj", up_axis: "z"}).
 */
export type ExportTarget = string | { format: string; path?: string; [option: string]: unknown };

export interface GraphSpec {
  /** graph format version (see GRAPH_VERSION); missing = 0, migrated on load */
  version?: number;
  nodes: Record<string, NodeSpec>;
  output?: string;
  /** where the default output exports to (io/targets.ts): a format ("glb"), or {format, path?, ...export options} */
  export?: ExportTarget;
  /**
   * Named deliverables for the viewer. `output` remains the default cook target. A project that is a package publishes
   * every named output of its graphs but those with `publish: false` (viewer-only previews), with its kind (detected,
   * or pinned here and checked), its tags and its description (else the graph's): src/graph/outputs.ts.
   */
  outputs?: Record<string, { node: string; label?: string; export?: ExportTarget; publish?: boolean; kind?: Kind; tags?: string[]; description?: string }>;
  vars?: Record<string, any>;
  /** metadata for exposed vars: asset parameters, and the controls the live viewer shows for them */
  params?: Record<string, VarDef>;
  description?: string;
  meta?: GraphMeta;
}

export interface CookContext {
  node: string;
  type: string;
  p: Record<string, any>;
  inputs: (Geometry | null)[];
  /** input i, or an empty geometry if unconnected */
  input(i: number): Geometry;
  hasInput(i: number): boolean;
  warn(msg: string): void;
  vars: Record<string, any>;
  engine: Engine;
  /**
   * The scope the node cooks in (src/graph/scope.ts): the files it reads, the graphs graph_ref reads and the node
   * types of nested cooks, which run in it too. A node that reads it sets NodeDef.usesScope.
   */
  scope: Scope;
  /** cache signatures of the inputs (for nested cooks) */
  inputSigs: string[];
  depth: number;
  /** current frame (1 = time 0). Reading it makes this cook time-dependent. */
  readonly frame: number;
  /** current time in seconds. Reading it makes this cook time-dependent. */
  readonly time: number;
  /** frames per second. Reading it makes this cook time-dependent. */
  readonly fps: number;
  /** time step in seconds (1/fps, or 1/(fps*substeps) inside a solver). Reading it makes this cook time-dependent. */
  readonly timeInc: number;
  /** mark the result as depending on time (when the dependency is not visible to the engine) */
  markTimeDependent(): void;
  /**
   * The cook's stop signal (CookOptions.signal), if it has one. The engine stops at node boundaries; pool tasks of the
   * node (parallelMap, big WASM calls) stop with it, and a long node calls checkpoint() between its steps.
   */
  readonly signal?: StopSignal;
  /**
   * Between the steps of a long node (iterations, simulation steps): lets the host serve requests meanwhile (a stop
   * among them), and throws NodeError(STOPPED) once the cook was asked to stop. Cheap when the cook has no signal.
   */
  checkpoint(): Promise<void>;
  /**
   * cook a nested graph (foreach body, asset, solver step) inheriting the time and the scope (unless opts.scope is
   * given); propagates time dependence
   */
  subcook(graph: GraphSpec, opts?: CookOptions): Promise<CookReport>;
  /** input i cooked at another frame (the current result if the input is not time-dependent) */
  inputAt(i: number, frame: number): Promise<{ geo: Geometry; sig: string; timeDependent: boolean }>;
  /** record a numeric statistic on the node result (e.g. solver steps) */
  stat(name: string, value: number): void;
  /**
   * Run a registered per-element kernel (src/core/kernels.ts) over job.count elements: in chunks on the host's worker
   * pool when there is one and the job is large enough, else in one piece on this thread, synchronously (the result is
   * then not a promise, so a node stays synchronous). Outputs are written in place; the result is the same bit for bit.
   */
  parallelMap(kernel: string, job: KernelJob, opts?: ParallelOptions): ParallelRun | Promise<ParallelRun>;
}

export class NodeError extends Error {
  hint?: string;
  constructor(msg: string, hint?: string) {
    super(msg);
    this.hint = hint;
  }
}

/** The error of a node that a stopped cook did not cook, or stopped while it cooked (CookOptions.signal). */
export const STOPPED = 'cook stopped';
