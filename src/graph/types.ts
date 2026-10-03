import type { Geometry } from '../core/geometry.ts';
import type { Engine } from './engine.ts';

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
  groupClass?: 'point' | 'prim';
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

export interface VarDef {
  type?: string;
  default?: any;
  desc?: string;
  min?: number;
  max?: number;
  options?: string[];
}

export interface GraphSpec {
  nodes: Record<string, NodeSpec>;
  output?: string;
  vars?: Record<string, any>;
  /** metadata for exposed vars when the graph is used as an asset */
  params?: Record<string, VarDef>;
  description?: string;
  meta?: any;
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
}

export class NodeError extends Error {
  hint?: string;
  constructor(msg: string, hint?: string) {
    super(msg);
    this.hint = hint;
  }
}
