// Tool implementations shared by the MCP server (and usable from tests/CLI).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Session, EditRejected } from '../session.ts';
import type { EditOp } from '../session.ts';
import type { CookReport } from '../graph/engine.ts';
import type { GraphSpec } from '../graph/types.ts';
import { allNodeDefs } from '../graph/registry.ts';
import { didYouMean } from '../graph/params.ts';
import { catalogText, nodeDoc, topicList, topicText, INSTRUCTIONS } from './docs.ts';
import { nodeBudgetInput, summarize, inspect } from '../inspect.ts';
import { glbSceneReport, sceneReportText } from '../io/inspect-scene.ts';
import { renderGeometryAsync } from '../render/raster.ts';
import type { RenderOptions } from '../render/raster.ts';
import { renderArgs } from '../render/options.ts';
import { encodePNG } from '../render/png.ts';
import { EXPORT_FORMATS, exportFormatFromPath } from '../io/export.ts';
import type { ExportFormat } from '../io/export.ts';
import { exportToolOptions, publishedOutputs } from '../io/targets.ts';
import { kindMismatch, outputKind } from '../io/kinds.ts';
import { exportSource } from '../io/source.ts';
import { packageAt, packagesUsed } from '../graph/packages.ts';
import type { ExportSource } from '../io/source.ts';
import { ArtifactStore } from '../host/artifacts.ts';
import { prepareTarget, serializeExport, writeExportFiles, writeTargets } from '../host/export-targets.ts';
import type { PreparedTarget } from '../host/export-targets.ts';
import type { Host, StopSignal } from '../host/types.ts';
import { TOPOTOPO_VERSION } from '../host/version.ts';
import { evalGroup } from '../core/groups.ts';
import { Geometry } from '../core/geometry.ts';
import { verifyTools } from './verify.ts';
import { inputsTool } from './inputs.ts';

export type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export interface ToolResult { content: Content[]; isError?: boolean }

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) });

/** What a call brings besides its arguments: the client's stop, and how to tell the client how far a long call is. */
export interface ToolCall {
  signal?: StopSignal;
  progress?: (done: number, total: number, message: string) => void;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: any;
  run: (args: any, call?: ToolCall) => Promise<ToolResult>;
}

/** " at frame N" when the cook was not at frame 1. */
const atFrame = (r: { frame: number }) => (r.frame !== 1 ? ` at frame ${r.frame}` : '');

function reportText(name: string, r: CookReport, extraNotes: string[] = [], extraWarnings: string[] = []): string {
  const lines: string[] = [];
  const nodes = [...r.results.values()];
  const cooked = nodes.filter((n) => !n.cached && !n.error).length;
  if (r.ok) lines.push(`✓ graph "${name}" → "${r.target}" cooked${atFrame(r)} in ${r.ms.toFixed(0)} ms (${nodes.length} nodes: ${cooked} cooked, ${nodes.length - cooked} cached/skipped)`);
  else lines.push(`✗ graph "${name}" failed${r.target ? ` at "${r.target}"` : ''}${atFrame(r)} — ${r.errors.length} error(s):`);
  for (const e of r.errors) lines.push(`  [${e.node}] ${e.message}${e.hint ? `\n     hint: ${e.hint}` : ''}`);
  for (const n of [...r.notes, ...extraNotes]) lines.push(`note: ${n}`);
  if (r.warnings.length || extraWarnings.length) {
    lines.push('warnings:');
    for (const w of extraWarnings) lines.push(`  ${w}`);
    for (const w of r.warnings.slice(0, 15)) lines.push(`  [${w.node}] ${w.message}`);
    if (r.warnings.length > 15) lines.push(`  … ${r.warnings.length - 15} more`);
  }
  if (r.geo) lines.push(summarize(r.geo));
  const slow = nodes.filter((n) => n.ms > 50).sort((a, b) => b.ms - a.ms).slice(0, 4);
  if (slow.length) lines.push(`slowest: ${slow.map((n) => `${n.node} ${n.ms.toFixed(0)}ms`).join(', ')}`);
  const stats = nodes.filter((n) => n.stats);
  if (stats.length) lines.push(`stats: ${stats.slice(0, 6).map((n) => `${n.node} ${Object.entries(n.stats!).map(([k, v]) => `${k}=${v}`).join(' ')}`).join('; ')}`);
  const timed = nodes.filter((n) => n.timeDependent).map((n) => n.node);
  if (timed.length) lines.push(`time-dependent: ${timed.slice(0, 12).join(', ')}${timed.length > 12 ? ', …' : ''}`);
  return lines.join('\n');
}

const FRAME_PROP = {
  frame: { type: 'number', description: 'frame to cook at (default 1; frame 1 = time 0, 24 fps). Only time-dependent nodes (solver, @Frame wrangles, "=frame" params) change between frames.' },
};

/** Render to a PNG content block; shading "pbr" reads texture files through the host. */
async function pngContent(g: Geometry, o: RenderOptions, host: Host): Promise<{ img: Content; notes: string[]; png: Uint8Array }> {
  const r = await renderGeometryAsync(g, o, (t) => host.readFile(t));
  const png = encodePNG(r.rgba, r.width, r.height, (d) => zlib.deflateSync(d, { level: 6 }));
  return { img: { type: 'image', data: Buffer.from(png).toString('base64'), mimeType: 'image/png' }, notes: r.notes, png };
}

/**
 * Write every file of an export (heightmap sidecars and layers, instance-stream sidecar and mesh GLBs, the Unreal
 * Landscape bundle, or the single file of other formats) and the record of how it was made (`source`, io/source.ts).
 * Textures are read through the host; USD texture paths are written relative to the output file. Returns the report
 * text.
 */
export async function writeExport(geo: Geometry, format: ExportFormat, p: string, a: any, host: Host, record?: (files: string[]) => void, source?: ExportSource): Promise<string> {
  const res = await serializeExport(geo, format, p, a, host, source);
  writeExportFiles(res.files);
  if (res.files.length) record?.(res.files.map((f) => f.path));
  return exportReport(res.files, res.outDir, format, res.summary, res.warnings, res.sourceFile, res.sourceManifest);
}

/**
 * "wrote <file or N files in dir> (format, KB): summary", where the export's source is recorded, then any warnings. A
 * standalone <file>.source.json is named on its own line, not in the file list.
 */
function exportReport(all: { path: string; bytes: Uint8Array }[], outDir: string, format: string, summary: string, warnings: string[], sourceFile?: string, sourceManifest?: string): string {
  const files = all.filter((f) => f.path !== sourceManifest);
  const total = files.reduce((s, f) => s + f.bytes.byteLength, 0);
  const rel = (f: string) => path.relative(outDir, f).split(path.sep).join('/');
  const list = files.length === 1 ? files[0].path : `${files.length} files in ${outDir}: ${files.slice(0, 12).map((f) => rel(f.path)).join(', ')}${files.length > 12 ? ', …' : ''}`;
  return `wrote ${list} (${format}, ${(total / 1024).toFixed(1)} KB): ${summary}${sourceFile ? `\nsource recorded in ${rel(sourceFile)} (graph, vars, seeds, frame; help topic "export")` : ''}${warnings.length ? '\nwarnings:\n  ' + warnings.join('\n  ') : ''}`;
}
function renderOpts(a: any, g: Geometry, label: string | undefined, dir: string): RenderOptions {
  const ro = renderArgs(a); // views (presets, persp@az, section), overlays, shading, labels … (src/render/options.ts)
  // a reference image is a path relative to the package, as save_to is
  if (ro.underlay) ro.underlay = path.resolve(dir, ro.underlay);
  let highlight: RenderOptions['highlight'] = null;
  if (a.highlight) {
    const cls = a.highlight_class === 'point' ? 'point' : 'prim';
    const m = evalGroup(g, cls, a.highlight);
    if (m) highlight = { cls, mask: m, label: a.highlight };
  }
  return {
    ...ro, wireframe: ro.wireframe ?? 'auto', colorBy: ro.colorBy ?? null, highlight,
    points: ro.points ?? 'auto', target: ro.target ?? null, title: label, checker: !!ro.checker,
  };
}

const RENDER_PROPS = {
  views: { description: 'views: "quad" (persp+front+right+top, default), "quad_uv" (persp + uv side by side), "turntable" (persp at azimuth 0/90/180/270), a single view, or a list of persp/front/back/left/right/top/bottom/front_left/front_right/back_left/back_right/uv/section/texture/persp@<azimuth> (front_left … are persp views at azimuth -45/45/-135/135). Every 3D view fits the bounds. "texture" draws images flat (see texture). "uv" draws the 0..1 UV square (UDIM tiles, 0.1 grid): polygons filled by chart/island colour, island borders yellow, overlaps red. "section" slices along section_axis and looks along it: the cut filled red (blue = inside-out solid), open sheets as yellow lines, the far half ghosted', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
  checker: { type: 'boolean', description: 'shade 3D views with an 8×8 uv checker (light cells tinted red along u, green along v) to see stretch, seams and flips' },
  size: { description: 'pixels per view: n (square; default 512 for several views, 800 for one) or "WxH" / [w, h] (e.g. "1600x600" for a long prop: the views fit the bounds to that aspect); scale 2 doubles it', anyOf: [{ type: 'number' }, { type: 'string' }, { type: 'array', items: { type: 'number' } }] },
  transparent: { type: 'boolean', description: 'transparent background: pixels without surface, line or point get alpha 0 (PNG with alpha); no ground grid or axis gizmo; the footer stays opaque' },
  grid: { type: 'boolean', description: 'the persp ground grid on y = 0 (default true, false with transparent)' },
  underlay: { type: 'string', description: 'a reference image (PNG, path relative to the package) drawn behind the 3D views, e.g. a side photo behind views:"front"' },
  underlay_opacity: { type: 'number', description: 'underlay opacity 0..1 (default 0.5)' },
  underlay_fit: { type: 'string', enum: ['bounds', 'width', 'height', 'view'], description: 'where the underlay goes: "bounds" (default: fitted into the rectangle the bounds cover in each view, keeping its aspect, so a reference cropped to the object lines up with it), "width" (its width spans the width of the bounds), "height" (its height spans their height), "view" (the whole view)' },
  sockets: { type: 'boolean', description: 'draw scene empties (scene_null sockets) as dots with their name and orient axes (X red, Y green, Z blue), through surfaces; without it pbr renders hide them' },
  color_by: { type: 'string', description: 'colour by attribute (e.g. "height", "class", "N", "P.y"); ints/strings get categorical colours; under shading "pbr" the colours tint the shaded material' },
  highlight: { type: 'string', description: 'group pattern to highlight in orange (e.g. "front", "@P.y>1")' },
  highlight_class: { type: 'string', enum: ['prim', 'point'] },
  wireframe: { description: 'true/false/"auto" (polygon edges; auto, the default, draws them below 6,000 polygons but never under shading "pbr" or textures:true, and the footer says EDGES AUTO when it does), or a crisp 1 px edge overlay: "all" (every edge: topology density), "hard" (dihedral > hard_angle in cyan + crease/hard/sharp edge groups), "boundary" (open edges pink, non-manifold yellow, winding flips violet), "groups" (each edge group in its colour, with legend), "none"', anyOf: [{ type: 'boolean' }, { type: 'string', enum: ['auto', 'none', 'all', 'hard', 'boundary', 'groups'] }] },
  points: { type: 'boolean', description: 'draw all points, sized by pscale when present (default: only loose points)' },
  azimuth: { type: 'number', description: 'persp camera azimuth in degrees around +Y (default 35): 0 = camera on +Z looking at the front, 90 = on +X (right side), 180 = back, -90 = left' },
  elevation: { type: 'number', description: 'persp camera elevation in degrees above the horizon (default 25; 90 looks straight down)' },
  zoom: { type: 'number', description: 'relative to the fit: 1 (default) = the bounds fill the view with a small margin, 0.5 = half that size. Above 1 it magnifies around look_at and crops: only with look_at or ortho_scale, else it is held at 1 (a note says so)' },
  target: { type: 'array', items: { type: 'number' }, description: 'look-at point [x,y,z] (same as look_at)' },
  hard_angle: { type: 'number', description: 'wireframe "hard": dihedral angle threshold in degrees (default 30)' },
  point_numbers: { type: 'boolean', description: 'label visible point numbers (the first max_labels points)' },
  prim_numbers: { type: 'boolean', description: 'label visible prim numbers at prim centroids (the first max_labels prims)' },
  max_labels: { type: 'number', description: 'at most this many labels per kind (default 200); the rest are skipped with a note' },
  section_axis: { type: 'string', enum: ['x', 'y', 'z'], description: 'plane normal of the "section" view (default y)' },
  section_offset: { type: 'number', description: 'section plane position as a fraction of the bbox along the axis (default 0.5), or a coordinate with section_absolute' },
  section_absolute: { type: 'boolean', description: 'section_offset is a world coordinate' },
  clip: {
    type: 'object', description: 'cut the persp view(s) by a plane and remove the camera side to reveal interiors: {axis, offset (bbox fraction, default 0.5), absolute, cap (default true: fill the cut red, blue where a solid is inside-out; false: see the inside, back faces blue)}',
    properties: { axis: { type: 'string', enum: ['x', 'y', 'z'] }, offset: { type: 'number' }, absolute: { type: 'boolean' }, cap: { type: 'boolean' } },
  },
  glyphs: { type: 'string', enum: ['none', 'N', 'up', 'orient', 'v', 'custom'], description: 'per-element vectors as lines with a bright tip (parts behind the surface dimmed): N (normals; computed face normals if absent), up, v (length by magnitude), orient (X red, Y green, Z blue axes), custom (glyph_attrib)' },
  glyph_attrib: { type: 'string', description: 'attribute for glyphs "custom": 3 floats = vector, 4 floats = quaternion' },
  glyph_scale: { type: 'number', description: 'glyph length in world units (default 5% of the bbox diagonal)' },
  max_glyphs: { type: 'number', description: 'evenly subsample to at most this many glyphs (default 400)' },
  max_triangles: { type: 'number', description: 'packed instances: draw up to this many expanded triangles (default 600000, max 50M); above it an evenly spread subset is drawn and a note says so' },
  heightfield_res: { description: 'heightfields: the most quads drawn per side (default 256: a 513 × 513 field draws at 257 × 257, and the footer and a note say so), or "full" for every sample', anyOf: [{ type: 'number', minimum: 1 }, { type: 'string', enum: ['full'] }] },
  heightfield_layer: { type: 'string', description: 'heightfields: the layer drawn in red over the shaded terrain (default "mask"; e.g. "flow", "sediment", "path"; "none" for none). 0..1 layers show as they are, others from their min to their max; the footer legend names it, and a note says when a field has no such layer' },
  label_groups: { type: 'boolean', description: 'name each point/prim group on a visible member near its centroid, outline prim groups / mark group points in the label colour, legend with counts' },
  label_pieces: { type: 'boolean', description: 'number connected pieces (#0, #1, … in connectivity order)' },
  label_attrib: { type: 'string', description: 'label each distinct value of a string/int attribute (e.g. "name") on its elements; colours match color_by' },
  legend: { type: 'boolean', description: 'legend for color_by (gradient bar with min/max, or categorical swatches) and highlight' },
  shading: { type: 'string', enum: ['default', 'flat', 'matcap', 'ao', 'pbr'], description: 'flat: facets (ignores N); matcap: clay that reads form; ao: screen-space ambient occlusion darkens creases and cavities; pbr: the exported metallic-roughness material (base colour, normal, orm/roughness maps, emissive, unlit) under a fixed studio light rig, deterministic' },
  exposure: { type: 'number', description: 'shading "pbr": exposure in stops (default 0)' },
  ao_radius: { type: 'number', description: 'shading "ao": sample radius in pixels (default 10)' },
  look_at: { type: 'array', items: { type: 'number' }, description: 'look-at point [x, y, z] in world metres (x right, y up, z towards the front; default the bbox centre): the view centres on it and still fits the bounds; with zoom > 1 it zooms into that point' },
  ortho_scale: { type: 'number', description: 'ortho and section views: the world width in metres across a view (default: fit the bounds), e.g. 0.5 shows 50 cm across' },
  scale: { type: 'number', description: '2 (up to 4) for a 2× image: tiles, text, lines and markers scaled' },
  annotate: { type: 'boolean', description: 'second footer line naming the active overlays plus geometry notes (pieces, open edges, back-facing %); default on whenever an overlay option is used' },
  view_labels: { type: 'boolean', description: 'false hides the name label of every view and the persp axis gizmo (clean thumbnails); default true' },
  textures: { type: 'boolean', description: '3D views show the base colour maps of materials with image textures (texture_to_material; needs uv); texture × Cd like glTF' },
  texture: { type: 'string', description: 'adds the "texture" view and picks what it shows: an image name, "image/layer", or a material name (its maps as a labelled strip); "" = every image. A geometry holding only images renders as the texture view by default' },
};

export function makeTools(ws: Session, opts: { onPreview?: () => Promise<string> } = {}): ToolDef[] {
  // One file per graph node, overwritten by each render: agents render after most edits, so a new file per render
  // would pile up in exports/renders (save_to keeps a copy elsewhere).
  const renderDestination = (name: string, node: string) =>
    path.join(ws.exportDir, 'renders', `${name}-${node}`.replace(/[^A-Za-z0-9_.-]/g, '_') + '.png');
  const engine = ws.engine;

  /**
   * The named outputs of a cooked graph that cook to another kind than their author pinned ("kind" in its outputs, help
   * topic "packages"), each said as a warning: publishing the package would block on them.
   */
  const kindWarnings = async (name: string, r: CookReport, frame?: number): Promise<string[]> => {
    const out: string[] = [];
    if (!r.ok) return out;
    for (const [id, o] of Object.entries(ws.graphs.get(name)?.outputs ?? {})) {
      if (!o || typeof o.kind !== 'string') continue;
      const c = o.node === r.target ? r : await ws.cook(name, o.node, frame);
      // an output that does not cook says so when it is cooked
      if (!c.ok || !c.geo) continue;
      const said = kindMismatch(o.kind, outputKind(c.geo));
      if (said) out.push(`[output "${id}"] ${said}`);
    }
    return out;
  };

  /** The text (+ optional render) of a cook report. */
  const reportResult = async (name: string, r: CookReport, a: any, extraNotes: string[] = []): Promise<ToolResult> => {
    const content: Content[] = [{ type: 'text', text: reportText(name, r, extraNotes, await kindWarnings(name, r, a.frame)) }];
    if (r.geo && a.render) {
      const ro = renderOpts(typeof a.render === 'object' ? a.render : {}, r.geo, `${name}/${r.target}${atFrame(r)}`, ws.dir);
      const { img, notes, png } = await pngContent(r.geo, ro, engine.host);
      const renderPath = renderDestination(name, r.target);
      fs.mkdirSync(path.dirname(renderPath), { recursive: true }); fs.writeFileSync(renderPath, png);
      new ArtifactStore(ws.exportDir).record([renderPath], { graph: name, node: r.target, format: 'png' });
      content.push(img);
      if (notes.length) content.push({ type: 'text', text: 'render: ' + notes.join('; ') });
    }
    return { content, isError: !r.ok };
  };

  const cookAndReport = async (name: string, a: any, extraNotes: string[] = []): Promise<ToolResult> => {
    const r = await ws.cook(name, undefined, a.frame);
    ws.bump(name);
    return reportResult(name, r, a, extraNotes);
  };

  const resolveNodeGeo = async (a: any, forExport = false) => {
    const name = a.graph ?? a.name ?? 'main'; // `name` is what build/edit call it; accept both
    const g = ws.getGraph(name);
    const target = a.node || undefined;
    // an export uses the published copies of the packages the session shows live (following is for looking)
    const scope = forExport && ws.packages?.publishedNote?.(g) ? ws.packages.published?.() : null;
    const r = await engine.cook(g, { target, frame: a.frame, ...(scope ? { scope } : {}) });
    if (!r.ok || !r.geo) throw new Error(reportText(name, r));
    return { r, name, geo: r.geo, scope };
  };
  /** What an export of a graph made while following says (the published versions it used), on a line of its own. */
  const publishedLine = (spec: GraphSpec) => { const n = ws.packages?.publishedNote?.(spec); return n ? `\n${n}` : ''; };

  /** export without a path: the graph's targets (the default output's, a named one's, or all), inside exports/ */
  const exportTargets = async (a: any): Promise<ToolResult> => {
    const name = a.graph ?? a.name ?? 'main', spec = ws.getGraph(name);
    const published = publishedOutputs(name, spec, engine.findOutput(spec).name);
    const hint = (o: string | undefined) => `edit {ops:[{op:"export"${o === undefined ? '' : `, output:"${o}"`}, export:"glb"}]}`;
    let chosen = published;
    if (!a.all) {
      const p = a.output === undefined ? published[0] : published.find((x) => x.output === a.output);
      if (!p) return text(`graph "${name}" publishes no output "${a.output}" (outputs: ${published.filter((x) => x.output !== null).map((x) => `${x.output}${x.default ? ' (default)' : ''}`).join(', ') || 'none'})`, true);
      if (!p.target) return text(`${a.output === undefined ? 'the default output' : `output "${a.output}"`} of "${name}" has no export target: set one with ${hint(a.output)}, or pass path`, true);
      chosen = [p];
    }
    const targets = chosen.filter((p) => p.target);
    if (!targets.length) return text(`no output of "${name}" has an export target: set one with ${hint(undefined)}, or pass path`, true);
    const prepared: PreparedTarget[] = [];
    for (const p of targets) {
      const r = await ws.cook(name, p.node, a.frame, { kind: 'export' });
      if (!r.ok || !r.geo) return text(reportText(name, r), true);
      prepared.push(await prepareTarget(r.geo, name, p as typeof p & { target: NonNullable<typeof p.target> }, ws.exportDir, engine.host, { frame: r.frame, fps: r.fps, packages: packagesUsed(engine, spec, ws.packages?.published?.() ?? engine.root) }));
    }
    writeTargets(prepared, ws.exportDir);
    const skipped = chosen.filter((p) => !p.target).map((p) => p.label);
    return text(prepared.map((p) => exportReport(p.files, p.root, p.target.format, `${p.label}: ${p.summary}`, p.warnings, p.sourceFile, p.sourceManifest)).join('\n')
      + (skipped.length ? `\nno export target (skipped): ${skipped.join(', ')}` : '') + publishedLine(spec));
  };

  const tools: ToolDef[] = [
    {
      name: 'catalog',
      description: 'List available node types grouped by category (generate, curve, transform, deform, attribute, measure, group, topology, copy, solid, sdf, heightfield, uv, code, flow, io, pcg, asset = package assets, package = package outputs, "owner/name/output": those the package uses, and TopoTopo\'s own, ready-made walls, houses, roofs, stairs, rocks, trees, props and roads such as "topotopo/architecture/house" or "topotopo/nature/rock", which a graph\'s first use adds to the package). Optional filter by category or search text. Building a landscape or scene for a person? Call inputs {action:"list"} first: the meshes, guide curves and masks they dropped into the package.',
      inputSchema: {
        type: 'object',
        properties: {
          category: { type: 'string' },
          search: { type: 'string', description: 'substring match on names/descriptions, e.g. "scatter" or "bevel"' },
          include_deprecated: { type: 'boolean', description: 'also list deprecated node types (hidden by default)' },
        },
      },
      run: async (a) => {
        const cat = catalogText([...allNodeDefs(), ...engine.assetsIn().map((x) => x.def), ...engine.packageDefs()], { category: a.category, search: a.search, deprecated: a.include_deprecated });
        const nIn = ws.listInputs().length;
        // the package outputs listed cannot be used where the server's folder is in no package: say why, and how that changes
        const notice = (!a.category || a.category === 'package') ? ws.packages?.notice() : null;
        return text(`${cat}${notice ? `\nPACKAGES: ${notice}` : ''}\nHUMAN INPUT: ${nIn ? `${nIn} file${nIn === 1 ? '' : 's'} in` : 'nothing yet in'} the package inputs/ folder (meshes, guide curves and points, blockouts, PNG masks people drop in). Building a landscape or scene: inputs {action:"list"} first, then read them with file nodes (help topic "inputs").`);
      },
    },
    {
      name: 'help',
      description: `Exact docs for node types (params with types, defaults, ranges, aliases; inputs; examples; a package output "owner/name/output": its params, inputs, version and note, also one search found that the package does not use yet) and concept topics: ${topicList().join(', ')}. Call before using unfamiliar nodes.`,
      inputSchema: { type: 'object', properties: { nodes: { type: 'array', items: { type: 'string' }, description: 'node type names' }, topic: { type: 'string', description: `one of: ${topicList().join(', ')}, overview` } } },
      run: async (a) => {
        const out: string[] = [];
        if (a.topic) out.push(topicText(String(a.topic)) ?? `unknown topic "${a.topic}". Topics: overview, ${topicList().join(', ')}`);
        for (const n of a.nodes ?? []) {
          const d = engine.resolveDef(n);
          if (!d && String(n).includes('/')) {
            const p = engine.packageIssue(String(n));
            // a package this package does not use yet (TopoTopo's own, or one search found in a library it lists): its
            // docs, read where its library holds it, and what naming it does here
            const offered = engine.packageDefs().find((x) => x.type === n) ?? ws.packages?.describe(String(n)) ?? undefined;
            out.push(offered ? `${nodeDoc(offered)}\nin this package: ${p.error}${p.hint ? ` (hint: ${p.hint})` : ''}` : `${p.error}${p.hint ? `\n  hint: ${p.hint}` : ''}`);
            continue;
          }
          if (!d) { const s = didYouMean(n, engine.allTypeNames()); out.push(`unknown node "${n}"${s.length ? ` — did you mean ${s.join(', ')}?` : ''}`); continue; }
          out.push(nodeDoc(d));
        }
        if (!out.length) out.push(INSTRUCTIONS, '', 'Topics: ' + topicList().join(', '));
        return text(out.join('\n\n'));
      },
    },
    {
      name: 'build',
      description: 'Create or replace a whole node graph and cook it. Returns per-node errors with hints, warnings, and a summary of the output geometry (counts, bbox, attributes, groups). mode "merge" upserts nodes into the existing graph. dry_run validates and resolves params without cooking. render:true (or render options) also returns an image. Expose the 3–8 vars a human would tune: declare "params": {var: {type, desc, min, max, options, label, step}}; the live viewer shows them as controls. Humans may change vars at any time, so read the graph (graphs {action:"get"}) before assuming a var\'s value.',
      inputSchema: {
        type: 'object',
        required: ['graph'],
        properties: {
          graph: { type: 'object', description: '{"nodes": {name: {"type", "in", "params"}}, "output": name, "outputs": {id: {"node": name, "label": "Published result", "export": "glb", "publish": false (not published), "kind": "mesh" (pinned: build warns and publishing blocks when it cooks to another kind), "tags": ["conifer", "low-poly"], "description": "what it is"}}, "export": "glb", "vars": {...}, "params": {var: {"type", "desc", "min", "max", "options", "label", "step"}}}. Publish intended deliverables in outputs; output remains the default. A node "type" "owner/name/output" is an output of a package (help topic "packages"). "export" (on the graph for the default output, or on a named output) is where it exports: a format, or {format, path?, ...export options}, written inside exports/ by the viewer\'s Export buttons and export {output} / {all:true}.' },
          name: { type: 'string', description: 'graph name (default "main")' },
          mode: { type: 'string', enum: ['replace', 'merge'] },
          dry_run: { type: 'boolean' },
          render: { description: 'true or render options (views, color_by, …)', anyOf: [{ type: 'boolean' }, { type: 'object' }] },
          ...FRAME_PROP,
        },
      },
      run: async (a) => {
        const name = a.name ?? 'main';
        let spec: GraphSpec = a.graph;
        if (typeof spec === 'string') spec = JSON.parse(spec);
        spec = spec;
        if (a.mode === 'merge' && ws.graphs.has(name)) spec = ws.mergeGraph(name, spec);
        if (a.dry_run) {
          // a package the graph names for the first time: checked against the version a build adds, nothing copied
          const dry = ws.dryScope(spec);
          const d = engine.dryRun(spec, undefined, dry.scope);
          const first = dry.notes.map((n) => `\nnote: ${n}`).join('');
          return text(d.errors.length
            ? `✗ ${d.errors.length} error(s):\n` + d.errors.map((e) => `  [${e.node}] ${e.message}${e.hint ? `\n     hint: ${e.hint}` : ''}`).join('\n') + first
            : `✓ valid: ${Object.keys(spec.nodes).length} nodes, output "${d.output}"` + (d.notes.length ? '\nnotes: ' + d.notes.join('; ') : '') + first, d.errors.length > 0);
        }
        // validated as a dry run sees it: a graph that is not saved adds no package and writes nothing
        const v = engine.validate(spec, '', ws.dryScope(spec).scope);
        if (v.errors.length) return text(`✗ graph not saved — ${v.errors.length} error(s):\n` + v.errors.map((e) => `  [${e.node}] ${e.message}${e.hint ? `\n     hint: ${e.hint}` : ''}`).join('\n'), true);
        // packages the graph names for the first time join the package
        const added = ws.packages?.addFor(spec) ?? [];
        ws.setGraph(name, spec);
        return cookAndReport(name, a, added);
      },
    },
    {
      name: 'edit',
      description: 'Incrementally edit a graph, then re-cook (only affected nodes recompute). ops: {op:"set",node,params} (null removes a param) · {op:"add",node,type,in,params} · {op:"insert",node,type,params,after} (splice after a node) · {op:"remove",node} (rewires consumers) · {op:"connect",node,in:[...]} or {op:"connect",node,input:1,from:"x"} · {op:"rename",node,to} · {op:"replace",node,type?,params?,in?} · {op:"output",node} · {op:"vars",vars:{k:v}} · {op:"bypass",node,value} · {op:"export",output?,export} (the export target of a named output, or of the default output without "output": a format "glb" or {format, path?, ...export options}; null removes it).',
      inputSchema: {
        type: 'object',
        required: ['ops'],
        properties: {
          name: { type: 'string', description: 'graph name (default "main")' },
          ops: { type: 'array', items: { type: 'object' } },
          render: { anyOf: [{ type: 'boolean' }, { type: 'object' }] },
          ...FRAME_PROP,
        },
      },
      run: async (a) => {
        const name = a.name ?? 'main';
        let res: Awaited<ReturnType<Session['edit']>>;
        try { res = await ws.edit(name, a.ops as EditOp[], { frame: a.frame }); }
        catch (e) { if (e instanceof EditRejected) return text(e.message, true); throw e; }
        return reportResult(name, res.report, a, res.notes);
      },
    },
    {
      name: 'inspect',
      description: 'Inspect any node\'s output as text: detail "summary" (default: one screen: counts, triangles, bbox in mm, parts, materials and maps, images, uv state, closed or open edges after welding seam splits); "budget" (triangles per part (prim "name", each an exported mesh) split per LOD (_lodN names), and per node (what each adds), sorted, with totals); "scene" (the glb export read back: nodes and parents, sockets, meshes and triangles, materials and maps, images; export_options as for export); "attributes" (min/max/mean, unique strings), "topology" (a closed solid or why not: open edges counted after welding the vertex splits of uv/normal seams, non-manifold edges, flipped faces, inward pieces, degenerate faces, each with the part (prim name/group) and world position of the first one and the fix; pieces, volume, area, genus, render/export triangle health), "elements" (list values for a range), "all", or "uv" (exact uv overlaps split into in-tile (atlas) overlap, tiling overlap (charts across tile borders: a repeating texture, flagged tiling) and overlap across LODs (_lodN names), each listed with parts and positions; collapsed / non-finite / out-of-tile triangles, charts, utilization, per-piece texel density with resolution; json:true appends the machine-readable report).',
      inputSchema: {
        type: 'object',
        properties: {
          graph: { type: 'string', description: 'graph name (default "main")' },
          node: { type: 'string', description: 'node to inspect (default: graph output)' },
          detail: { type: 'string', enum: ['summary', 'attributes', 'topology', 'elements', 'all', 'uv', 'budget', 'scene'] },
          export_options: { type: 'object', description: 'detail "scene": export options as the export tool takes them (up_axis, scale, split_by_name, materials, custom_attribs, tangents, instancing, compress …)' },
          uv_attrib: { type: 'string', description: 'detail "uv": the uv attribute (default "uv")' },
          resolution: { description: 'detail "uv": texture size in texels for texel density, n or [width, height]', anyOf: [{ type: 'number' }, { type: 'array', items: { type: 'number' } }] },
          json: { type: 'boolean', description: 'detail "uv", "budget" or "scene": append the report as JSON' },
          class: { type: 'string', enum: ['point', 'prim', 'vertex', 'detail', 'edge'], description: 'element class; "edge" lists unique edges (point pair, length, polygon count, dihedral angle, edge groups)' },
          attribs: { type: 'array', items: { type: 'string' } },
          start: { type: 'number' }, count: { type: 'number' },
          group: { type: 'string', description: 'restrict elements/stats to a group pattern (with class point/prim/vertex/edge)' },
          ...FRAME_PROP,
        },
      },
      run: async (a) => {
        const { geo, r, name } = await resolveNodeGeo(a);
        const node = r.target;
        const res = r.results.get(node);
        const head = `${name}/${node}${atFrame(r)}${res ? ` (${res.cached ? 'cached' : res.ms.toFixed(0) + ' ms'})` : ''}`;
        if (a.detail === 'scene') {
          // the glb export with these options, read back from its bytes (io/inspect-scene.ts)
          const ex = await serializeExport(geo, 'glb', path.join(ws.exportDir, 'scene.glb'), exportToolOptions(a.export_options ?? {}), engine.host);
          const glb = ex.files.find((f) => /\.glb$/i.test(f.path));
          if (!glb) return text(`${head}\nscene: the glb export wrote no file`, true);
          const rep = glbSceneReport(glb.bytes);
          return text([head, ...sceneReportText(rep), ...ex.warnings.map((w) => `warning: ${w}`), ...(a.json ? ['scene (JSON):', JSON.stringify(rep)] : [])].join('\n'));
        }
        const nodes = a.detail === 'budget' ? nodeBudgetInput(ws.getGraph(name), r.results) : undefined;
        return text(head + '\n' + inspect(geo, { detail: a.detail, cls: a.class, attribs: a.attribs, start: a.start, count: a.count, group: a.group, uvAttrib: a.uv_attrib, uvResolution: a.resolution, json: a.json, nodes }));
      },
    },
    {
      name: 'render',
      description: 'Render a node\'s output to a PNG you can see: labelled orthographic + perspective views, smooth shading, wireframe, curves and points; back-faces show BLUE (flipped normals). color_by maps an attribute to colours; highlight shows a group in orange. Overlays that answer questions (help topic "render"): wireframe "all"/"hard"/"boundary"/"groups" (topology, creases, holes), views "section" or clip (interiors, wall thickness), glyphs N/up/orient/v (orientation), label_groups/label_pieces/label_attrib/point_numbers/prim_numbers (what is where), shading matcap/ao (form), legend, views "turntable".',
      inputSchema: {
        type: 'object',
        properties: {
          graph: { type: 'string', description: 'graph name (default "main")' }, node: { type: 'string', description: 'node to look at (default: the graph output)' },
          ...RENDER_PROPS,
          save_to: { type: 'string', description: 'also write the PNG to this path (relative to the package)' },
          ...FRAME_PROP,
        },
      },
      run: async (a) => {
        const { geo, name, r } = await resolveNodeGeo(a);
        const { img, notes, png } = await pngContent(geo, renderOpts(a, geo, `${name}/${r.target}${atFrame(r)}`, ws.dir), engine.host);
        const content: Content[] = [img];
        const info: string[] = [];
        {
          const p = a.save_to ? path.resolve(ws.dir, a.save_to) : renderDestination(name, r.target);
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, png);
          new ArtifactStore(ws.exportDir).record([p], { graph: name, node: r.target, format: 'png' });
          info.push(`saved ${p}`);
        }
        if (notes.length) info.push(notes.join('; '));
        if (info.length) content.push({ type: 'text', text: info.join('\n') });
        return { content };
      },
    },
    {
      name: 'export',
      description: 'Write a node\'s output to a file: .glb/.gltf (glTF via gltf-transform: materials + texture maps, vertex colours, uv, custom attributes, EXT_mesh_gpu_instancing with per-instance attributes, meshopt compression; best for Unreal/Blender/web), .obj, .usda (PointInstancer with per-instance primvars, UsdPreviewSurface materials), .ply, .stl, .geo (Houdini JSON geometry, every attribute and group, packed prims as PackedGeometry), .csv (point stream; pcg:true for Unreal PCG columns; packed instances = one row per instance + Mesh column + .meshes.json sidecar + one GLB per source), .points.json, .json (lossless topotopo). Relative paths go into the package. help {topic:"export"} for details. Heightfields: png16 (.png, 16-bit Unreal Landscape heightmap) or r16 (.r16/.raw) plus a .json sidecar with the height range and the Unreal scale/location, mask_png (8-bit weight layers; param layers), unreal_landscape (a directory: heightmap, every layer, manifest with the exact Landscape import settings, objects.glb and the instance stream). Textures: glb/gltf embed the image textures of materials (texture_to_material) as PNG, usda writes them to <name>_textures/ next to the file, format textures writes every image as <path>/<image>.png (layers: extra layers, or ["*"]). Every export records how it was made (graph, vars, seeds, frame, version) in its sidecar or in <file>.source.json next to it (help topic "export").',
      inputSchema: {
        type: 'object',
        properties: {
          graph: { type: 'string', description: 'graph name (default "main")' }, node: { type: 'string', description: 'node to look at (default: the graph output)' },
          path: { type: 'string', description: 'e.g. "exports/rock.glb", "exports/trees.csv", "exports/pts.points.json", "exports/terrain.png" (heightmap), "exports/level" (unreal_landscape: a directory), "exports/maps" (textures: a directory). Without path: the graph\'s export targets (output / all), written inside exports/' },
          output: { type: 'string', description: 'without path: export this named output (graph.outputs) to its target; omitted = the default output (graph.export)' },
          all: { type: 'boolean', description: 'without path: export every output of the graph that has an export target' },
          format: { type: 'string', enum: EXPORT_FORMATS, description: 'default: from the extension (.points.json = pointsjson)' },
          layer: { type: 'string', description: 'heightmaps: layer to write (png16/r16 default "height", mask_png default "mask")' },
          layers: { type: 'array', items: { type: 'string' }, description: 'mask_png: layers to write, one PNG each (name_<layer>.png); textures: extra image layers to write as <image>_<layer>.png ("*" = all)' },
          height_min: { type: 'number', description: 'png16/r16: fixed range start (default: the layer minimum), e.g. shared by tiles' },
          height_max: { type: 'number', description: 'png16/r16: fixed range end (default: the layer maximum)' },
          tile_size: { type: 'integer', minimum: 0, maximum: 8160, description: 'unreal_landscape: quads per tile, 0 keeps the single landscape (default); e.g. 252, 1008 or 2016. Exact Unreal section fit required; edge padding to the tile grid, shared height range and per-tile instance streams.' },
          heightfield: { type: 'number', description: 'heightmaps: which heightfield when there are several (index, default 0)' },
          up_axis: { type: 'string', enum: ['y', 'z'] },
          scale: { type: 'number', description: 'multiply positions (100 = metres → centimetres; pcg csv defaults to 100)' },
          split_by_name: { type: 'boolean', description: 'separate meshes per prim "name" (default true)' },
          custom_attribs: { type: 'boolean', description: 'glTF/PLY/USD: include extra numeric attributes (glTF _NAME vertex and per-instance accessors, PLY properties, USD primvars; default false for glb/gltf/usda, true for ply). The CLI flag is --custom-attribs / --no-custom-attribs' },
          materials: { type: 'boolean', description: 'glTF: write materials from the prim "material" attribute + table (default true)' },
          vertex_colors: { type: 'boolean', description: 'glTF: also write Cd as COLOR_0 on prims that have a named material (default false: the material decides their colour; prims without one keep their Cd)' },
          compress: { type: 'string', enum: ['none', 'meshopt', 'draco'], description: 'glTF: meshopt = EXT_meshopt_compression + quantization; draco needs the optional draco3dgltf package' },
          quantize: { type: 'boolean', description: 'glTF: KHR_mesh_quantization (smaller, lossy) without compression' },
          tangents: { type: 'string', enum: ['auto', 'preserve', 'none'], description: 'glTF TANGENT: auto (default) = MikkTSpace for normal-mapped materials, a valid supplied "tangent" attribute elsewhere; preserve = the supplied attribute wherever it exists (malformed = error); none = never' },
          attributes: { type: 'array', items: { type: 'string' }, description: 'csv / points.json: point attributes to write (default all)' },
          pcg: { type: 'boolean', description: 'csv: Unreal PCG columns (Position/Rotation/Scale/Density/Color/Seed) in Unreal space (Z-up, left-handed, cm)' },
          pcg_struct: { type: 'boolean', description: 'csv with pcg: Unreal struct-text cells ("(X=…,Y=…,Z=…)") for DataTable import with a row struct' },
          precision: { type: 'number', enum: [32, 64], description: 'geo: float storage (64 = lossless default, 32 = Houdini default)' },
          instancing: { type: 'string', enum: ['packed', 'expand'], description: 'packed prims: glb/gltf (EXT_mesh_gpu_instancing), usda (PointInstancer) and geo (PackedGeometry) keep instances by default; expand writes real copies' },
          instances: { type: 'string', enum: ['rows', 'expand'], description: 'csv / points.json of packed prims: rows (default) = one row per instance (full transform, Mesh column, anchor attributes) + <name>.meshes.json + <name>_meshes/<Mesh>.glb; expand = the points of the expanded geometry' },
          meshes: { type: 'boolean', description: 'instance rows: also write one GLB per packed source (default true)' },
          ...FRAME_PROP,
        },
      },
      run: async (a) => {
        if (a.path === undefined) return exportTargets(a);
        const { geo, name, r, scope } = await resolveNodeGeo(a, true);
        const p = path.resolve(ws.dir, a.path);
        const fmt0 = String(a.format ?? exportFormatFromPath(p)).toLowerCase();
        const ext = (({ png: 'png16', raw: 'r16' } as Record<string, string>)[fmt0] ?? fmt0) as ExportFormat;
        if (!EXPORT_FORMATS.includes(ext)) throw new Error(`unknown format "${ext}"; use ${EXPORT_FORMATS.map((f) => (f === 'pointsjson' ? '.points.json' : '.' + f)).join(' ')}`);
        const source = exportSource({
          graph: name, spec: ws.getGraph(name), node: r.target, frame: r.frame, fps: r.fps,
          format: ext, options: exportToolOptions(a), packages: packagesUsed(engine, ws.getGraph(name), scope ?? engine.root), version: TOPOTOPO_VERSION,
        });
        const report = await writeExport(geo, ext, p, a, engine.host, (files) => new ArtifactStore(ws.exportDir).record(files, { graph: name, node: r.target, format: ext }), source);
        return text(`${report}\n(from ${name}/${r.target}${atFrame(r)}: ${geo.numPoints} points, ${geo.numPrims} prims)${publishedLine(ws.getGraph(name))}`);
      },
    },
    {
      name: 'graphs',
      description: 'Manage package graphs: list (with node counts), get (full JSON), delete, rename, duplicate. Graphs persist as JSON files in the package graphs/ folder.',
      inputSchema: {
        type: 'object',
        required: ['action'],
        properties: { action: { type: 'string', enum: ['list', 'get', 'delete', 'rename', 'duplicate'] }, name: { type: 'string' }, to: { type: 'string' } },
      },
      run: async (a) => {
        switch (a.action) {
          case 'list': {
            if (!ws.graphs.size) return text(`no graphs yet (package ${ws.dir}). Use build.`);
            return text([...ws.graphs].map(([k, g]) => {
              const r = ws.lastReport.get(k);
              return `${k}: ${Object.keys(g.nodes).length} nodes, output ${g.output ?? '(auto)'}${r ? `, last cook ${r.ok ? 'ok' : 'FAILED'}${r.geo ? ` (${r.geo.numPoints} pts, ${r.geo.numPrims} prims)` : ''}` : ''}`;
            }).join('\n') + `\nfolder: ${ws.dir}`);
          }
          case 'get': return text(JSON.stringify(ws.getGraph(a.name ?? 'main'), null, 1));
          case 'delete': ws.deleteGraph(a.name); return text(`deleted graph "${a.name}"`);
          case 'rename': case 'duplicate': {
            const g = ws.getGraph(a.name);
            if (!a.to) throw new Error('"to" is required');
            ws.setGraph(a.to, structuredClone(g));
            if (a.action === 'rename') ws.deleteGraph(a.name);
            return text(`${a.action}d "${a.name}" → "${a.to}"`);
          }
        }
        return text('unknown action', true);
      },
    },
    {
      name: 'assets',
      description: 'Reusable custom node types built from graphs (like HDAs), the package\'s own (assets/). save {name, from_graph | graph, description, params:{var:{desc,min,max}}}: the graph\'s vars become parameters and its "input" nodes become inputs. list, get, delete. fork {name: "owner/name/output", to?} copies the graph of a package output, TopoTopo\'s own included ("topotopo/architecture/stairs" …), into the package\'s assets as "to" (default: the output\'s name), an asset to edit and use like any other; get shows its graph, save writes it back.',
      inputSchema: {
        type: 'object',
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['save', 'list', 'get', 'delete', 'fork'] },
          name: { type: 'string', description: 'the asset; fork: the package output to copy, "owner/name/output" (or "owner/name" for its default output)' },
          from_graph: { type: 'string' }, graph: { type: 'object' },
          description: { type: 'string' }, params: { type: 'object' },
          to: { type: 'string', description: 'fork: name of the asset to create (default: the output\'s name)' },
        },
      },
      run: async (a) => {
        const assetOf = (n: string) => {
          const x = engine.asset(n);
          if (!x) { const s = didYouMean(String(n), engine.assetsIn().map((x) => x.name)); throw new Error(`no asset "${n}"${s.length ? ` — did you mean ${s.join(', ')}?` : ''}`); }
          return x;
        };
        /**
         * An asset's name and graph checked as a dry run sees the graph, before it adds a package or writes a file:
         * throws as registering it would.
         */
        const validAsset = (n: string, g: GraphSpec) => {
          if (!/^[A-Za-z_][\w]*$/.test(n)) throw new Error(`asset name must be an identifier, got "${n}"`);
          const v = engine.validate(g, '', ws.dryScope(g).scope);
          if (v.errors.length) throw new Error(`asset graph invalid: ${v.errors.map((e) => `${e.node}: ${e.message}`).join('; ')}`);
        };
        switch (a.action) {
          case 'list': {
            const all = engine.assetsIn();
            if (!all.length) return text('no assets yet (assets {action:"save"} makes one of a graph; fork copies a package output\'s graph, catalog {category:"package"} lists them)');
            const line = (x: { name: string; def: any }) => `  ${x.name} — ${x.def.summary}; params: ${Object.keys(x.def.params).join(', ') || 'none'}; inputs: ${x.def.inputs.length}`;
            return text([`[asset] package assets (${all.length})`, ...all.map(line)].join('\n'));
          }
          case 'get': {
            const x = assetOf(a.name);
            return text(nodeDoc(x.def) + '\n\n' + JSON.stringify(x.graph, null, 1));
          }
          case 'delete': {
            assetOf(a.name);
            engine.root.assets.delete(a.name);
            const f = path.join(ws.assetDir, a.name + '.json');
            if (fs.existsSync(f)) fs.unlinkSync(f);
            return text(`deleted asset "${a.name}"`);
          }
          case 'fork': {
            const name = String(a.name ?? '');
            if (!name.includes('/')) throw new Error(`fork copies a package output's graph into the package's assets: name one, "owner/name/output" (catalog {category:"package"} lists them, TopoTopo's own as "topotopo/architecture/stairs" …)${engine.asset(name) ? `; "${name}" is an asset of the package already: get shows its graph` : ''}`);
            // an output the package uses, or one of TopoTopo's own it does not use yet
            const all = engine.packageDefs(), o = (engine.resolveDef(name) ?? all.find((x) => x.type === name))?.package;
            if (!o) {
              const s = didYouMean(name, all.map((x) => x.type)), p = engine.packageIssue(name);
              throw new Error(s.length ? `no package output "${name}" — did you mean ${s.join(', ')}?` : `${p.error}${p.hint ? ` (hint: ${p.hint})` : ''}`);
            }
            const to = String(a.to ?? o.output ?? o.package.split('/')[1]);
            // the asset cooks the output's node; it publishes nothing and exports nowhere of its own
            const g: GraphSpec = { ...structuredClone(o.spec), output: o.node };
            delete g.outputs;
            delete g.export;
            // the package's other outputs its graph names join the package (first use), once it validates
            validAsset(to, g);
            const added = ws.packages?.addFor(g) ?? [];
            const def = engine.registerAsset(to, g);
            fs.writeFileSync(path.join(ws.assetDir, to + '.json'), JSON.stringify(g, null, 2));
            return text(`forked ${name} (${packageAt(o)}) into asset "${to}" of the package (assets/${to}.json; use {"type": "${to}"}): its vars are the params, its "input" nodes the inputs. ` +
              `assets {action:"get", name:"${to}"} shows its graph; change it and write it back with assets {action:"save", name:"${to}", graph}. Relative paths in it now read the package's files.` +
              `${added.map((n) => `\nnote: ${n}`).join('')}\n\n${nodeDoc(def)}`);
          }
          case 'save': {
            if (!a.name) throw new Error('"name" is required');
            const g: GraphSpec = structuredClone(a.graph ?? ws.getGraph(a.from_graph ?? 'main'));
            if (a.description) g.description = a.description;
            if (a.params) g.params = { ...(g.params ?? {}), ...a.params };
            validAsset(String(a.name), g);
            const added = ws.packages?.addFor(g) ?? [];
            const def = engine.registerAsset(a.name, g);
            fs.writeFileSync(path.join(ws.assetDir, a.name + '.json'), JSON.stringify(g, null, 2));
            return text(`saved asset "${a.name}" (use {"type": "${a.name}"})${added.map((n) => `\nnote: ${n}`).join('')}\n\n${nodeDoc(def)}`);
          }
        }
        return text('unknown action', true);
      },
    },
  ];
  tools.push(...verifyTools(ws), inputsTool(ws)); // explain, diff; the human's input files
  if (opts.onPreview) {
    tools.push({
      name: 'preview',
      description: 'Start (or get the URL of) the live viewer for humans: an editor viewport of the package (graph menu, an outliner with the graph\'s nodes, single and quad views, the graph\'s params as Controls, input layers and guides) that updates after every build/edit. Returns the URL to open in a browser.',
      inputSchema: { type: 'object', properties: {} },
      run: async () => text(`live preview: ${await opts.onPreview!()}  (updates automatically on every build/edit; click a node in the outliner to see its result)`),
    });
  }
  // A person can add files to inputs/ at any time (the viewer's Add input, a drop, the folder). The first answer says
  // what is there, later answers what is new or changed since the last one; the inputs tool's own answer counts.
  let heard: Map<string, string> | null = null;
  const inputsNote = (tool: string): string => {
    const files = ws.listInputs(), now = new Map(files.map((f) => [f.path, `${f.size}:${f.mtime}`]));
    const first = heard === null, fresh = files.filter((f) => heard?.get(f.path) !== now.get(f.path));
    heard = now;
    if (tool === 'inputs' || !fresh.length) return '';
    const shown = fresh.slice(0, 8).map((f) => `inputs/${f.path} (${f.kind}, ${(f.size / 1024).toFixed(0)} KB)`).join(', ') + (fresh.length > 8 ? `, and ${fresh.length - 8} more` : '');
    return `${first ? `inputs/ holds ${files.length} file(s) from the person` : 'new or changed in inputs/ since your last call'}: ${shown}. inputs {action:"describe", path} tells what one holds.`;
  };
  for (const t of tools) {
    const run = t.run;
    t.run = async (args) => {
      // what changed on disk since the last call (a followed working folder, the manifest): every tool sees it
      ws.packages?.refresh();
      const result = await run(args);
      const note = inputsNote(t.name);
      if (note) result.content.push({ type: 'text', text: note });
      return result;
    };
  }
  return tools;
}
