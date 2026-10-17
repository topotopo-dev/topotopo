import type { Geometry } from '../core/geometry.ts';
import type { CookOptions, CookReport, Engine } from './engine.ts';
import type { KernelJob, ParallelOptions, ParallelRun } from './parallel.ts';

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
  options?: string[];
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
  /** the node's code can read graph vars directly (wrangles, scripts) */
  usesVars?: boolean;
  /**
   * the node always depends on the cook time (e.g. solver): frame/time are mixed into its signature.
   * Other nodes become time-dependent per cook when their "=expr" params read frame/time/fps or when
   * their cook reads ctx.frame / ctx.time / ctx.fps / ctx.timeInc.
   */
  usesTime?: boolean;
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
  /** extra cache-key material (e.g. file mtime) */
  signatureExtra?: (p: Record<string, any>, engine: Engine) => string;
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
  options?: string[];
  /** control label for humans (default: the var name) */
  label?: string;
  /** slider step (default: 1 for ints, else derived from the range) */
  step?: number;
}

/** Free-form graph metadata; the fields below have a meaning. */
export interface GraphMeta {
  /** var names a human locked in the viewer: agents' build and edit keep their values and warn */
  locked?: string[];
  [key: string]: any;
}

export interface GraphSpec {
  /** graph format version (see GRAPH_VERSION); missing = 0, migrated on load */
  version?: number;
  nodes: Record<string, NodeSpec>;
  output?: string;
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
  /** cook a nested graph (foreach body, asset, solver step) inheriting the time; propagates time dependence */
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
