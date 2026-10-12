// Public API of the engine core (host-agnostic). The MCP server, CLI and a future
// browser GUI all build on this.
import './nodes/index.ts';

export { Engine } from './graph/engine.ts';
export type { CookReport, NodeResult, Issue } from './graph/engine.ts';
export type { GraphSpec, NodeSpec, NodeDef, ParamDef } from './graph/types.ts';
export { allNodeDefs, getNodeDef, CATEGORY_ORDER } from './graph/registry.ts';
export { Geometry, GeoBuilder } from './core/geometry.ts';
export { renderGeometry } from './render/raster.ts';
export { encodePNG } from './render/png.ts';
export { exportGeometry, exportGeometryAsync } from './io/export.ts';
export type { ExportFormat, ExportOptions } from './io/export.ts';
export { importGeometry, importGeometryAsync } from './io/import.ts';
export { readMaterials, writeMaterials, mergeMaterialTables } from './core/materials.ts';
export type { Material, MaterialTable } from './core/materials.ts';
export { geoToJSON, geoFromJSON } from './io/json.ts';
export { summarize, inspect } from './inspect.ts';
