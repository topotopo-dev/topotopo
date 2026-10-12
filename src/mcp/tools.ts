// Tool implementations shared by the MCP server (and usable from tests/CLI).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Workspace } from '../workspace.ts';
import type { EditOp } from '../workspace.ts';
import type { CookReport } from '../graph/engine.ts';
import type { GraphSpec } from '../graph/types.ts';
import { allNodeDefs } from '../graph/registry.ts';
import { didYouMean } from '../graph/params.ts';
import { migrateGraph } from '../graph/migrate.ts';
import { catalogText, nodeDoc, TOPICS, topicList, INSTRUCTIONS } from './docs.ts';
import { summarize, inspect } from '../inspect.ts';
import { renderGeometry } from '../render/raster.ts';
import type { RenderOptions } from '../render/raster.ts';
import { renderArgs } from '../render/options.ts';
import { encodePNG } from '../render/png.ts';
import { exportGeometry } from '../io/export.ts';
import type { ExportFormat } from '../io/export.ts';
import { evalGroup } from '../core/groups.ts';
import { Geometry } from '../core/geometry.ts';

export type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export interface ToolResult { content: Content[]; isError?: boolean }

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) });

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: any;
  run: (args: any) => Promise<ToolResult>;
}

/** " at frame N" when the cook was not at frame 1. */
const atFrame = (r: { frame: number }) => (r.frame !== 1 ? ` at frame ${r.frame}` : '');

function reportText(name: string, r: CookReport, extraNotes: string[] = []): string {
  const lines: string[] = [];
  const nodes = [...r.results.values()];
  const cooked = nodes.filter((n) => !n.cached && !n.error).length;
  if (r.ok) lines.push(`✓ graph "${name}" → "${r.target}" cooked${atFrame(r)} in ${r.ms.toFixed(0)} ms (${nodes.length} nodes: ${cooked} cooked, ${nodes.length - cooked} cached/skipped)`);
  else lines.push(`✗ graph "${name}" failed${r.target ? ` at "${r.target}"` : ''}${atFrame(r)} — ${r.errors.length} error(s):`);
  for (const e of r.errors) lines.push(`  [${e.node}] ${e.message}${e.hint ? `\n     hint: ${e.hint}` : ''}`);
  for (const n of [...r.notes, ...extraNotes]) lines.push(`note: ${n}`);
  if (r.warnings.length) {
    lines.push('warnings:');
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

function pngContent(g: Geometry, o: RenderOptions): { img: Content; notes: string[]; png: Uint8Array } {
  const r = renderGeometry(g, o);
  const png = encodePNG(r.rgba, r.width, r.height, (d) => zlib.deflateSync(d, { level: 6 }));
  return { img: { type: 'image', data: Buffer.from(png).toString('base64'), mimeType: 'image/png' }, notes: r.notes, png };
}

function renderOpts(a: any, g: Geometry, label?: string): RenderOptions {
  const ro = renderArgs(a); // views (presets, persp@az, section), overlays, shading, labels … (src/render/options.ts)
  let highlight: RenderOptions['highlight'] = null;
  if (a.highlight) {
    const cls = a.highlight_class === 'point' ? 'point' : 'prim';
    const m = evalGroup(g, cls, a.highlight);
    if (m) highlight = { cls, mask: m, label: a.highlight };
  }
  return {
    ...ro, wireframe: ro.wireframe ?? 'auto', colorBy: ro.colorBy ?? null, highlight,
    points: ro.points ?? 'auto', grid: ro.grid ?? true, target: ro.target ?? null, title: label, checker: !!ro.checker,
  };
}

const RENDER_PROPS = {
  views: { description: 'views: "quad" (persp+front+right+top, default), "quad_uv" (persp + uv side by side), "turntable" (persp at azimuth 0/90/180/270), a single view, or a list of persp/front/back/left/right/top/bottom/uv/section/persp@<azimuth>. "uv" draws the 0..1 UV square (UDIM tiles, 0.1 grid): polygons filled by chart/island colour, island borders yellow, overlaps red. "section" slices along section_axis and looks along it: the cut filled red (blue = inside-out solid), open sheets as yellow lines, the far half ghosted', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
  checker: { type: 'boolean', description: 'shade 3D views with an 8×8 uv checker (light cells tinted red along u, green along v) to see stretch, seams and flips' },
  size: { type: 'number', description: 'pixels per view tile (default 512 for multi-view, 800 single); scale 2 doubles it' },
  color_by: { type: 'string', description: 'colour by attribute (e.g. "height", "class", "N", "P.y"); ints/strings get categorical colours' },
  highlight: { type: 'string', description: 'group pattern to highlight in orange (e.g. "front", "@P.y>1")' },
  highlight_class: { type: 'string', enum: ['prim', 'point'] },
  wireframe: { description: 'true/false/"auto" (polygon edges, auto = on below 6000 polys), or a crisp 1 px edge overlay: "all" (every edge: topology density), "hard" (dihedral > hard_angle in cyan + crease/hard/sharp edge groups), "boundary" (open edges pink, non-manifold yellow, winding flips violet), "groups" (each edge group in its colour, with legend), "none"', anyOf: [{ type: 'boolean' }, { type: 'string', enum: ['auto', 'none', 'all', 'hard', 'boundary', 'groups'] }] },
  points: { type: 'boolean', description: 'draw all points, sized by pscale when present (default: only loose points)' },
  azimuth: { type: 'number', description: 'persp camera azimuth degrees (default 35)' },
  elevation: { type: 'number', description: 'persp camera elevation degrees (default 25)' },
  zoom: { type: 'number', description: 'zoom factor (1 = fit bbox)' },
  target: { type: 'array', items: { type: 'number' }, description: 'look-at point override [x,y,z]' },
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
  label_groups: { type: 'boolean', description: 'name each point/prim group on a visible member near its centroid, outline prim groups / mark group points in the label colour, legend with counts' },
  label_pieces: { type: 'boolean', description: 'number connected pieces (#0, #1, … in connectivity order)' },
  label_attrib: { type: 'string', description: 'label each distinct value of a string/int attribute (e.g. "name") on its elements; colours match color_by' },
  legend: { type: 'boolean', description: 'legend for color_by (gradient bar with min/max, or categorical swatches) and highlight' },
  shading: { type: 'string', enum: ['default', 'flat', 'matcap', 'ao'], description: 'flat: facets (ignores N); matcap: clay that reads form; ao: screen-space ambient occlusion darkens creases and cavities' },
  ao_radius: { type: 'number', description: 'shading "ao": sample radius in pixels (default 10)' },
  look_at: { type: 'array', items: { type: 'number' }, description: 'look-at point [x,y,z] (same as target)' },
  ortho_scale: { type: 'number', description: 'ortho/section views: world width across a view (default: fit the bbox)' },
  scale: { type: 'number', description: '2 (up to 4) for a 2× image: tiles, text, lines and markers scaled' },
  annotate: { type: 'boolean', description: 'second footer line naming the active overlays plus geometry notes (pieces, open edges, back-facing %); default on whenever an overlay option is used' },
};

export function makeTools(ws: Workspace, opts: { onPreview?: () => Promise<string> } = {}): ToolDef[] {
  const engine = ws.engine;

  const cookAndReport = async (name: string, a: any, extraNotes: string[] = []): Promise<ToolResult> => {
    const r = await ws.cook(name, undefined, a.frame);
    ws.bump(name);
    const content: Content[] = [{ type: 'text', text: reportText(name, r, extraNotes) }];
    if (r.geo && a.render) {
      const ro = renderOpts(typeof a.render === 'object' ? a.render : {}, r.geo, `${name}/${r.target}${atFrame(r)}`);
      const { img, notes } = pngContent(r.geo, ro);
      content.push(img);
      if (notes.length) content.push({ type: 'text', text: 'render: ' + notes.join('; ') });
    }
    return { content, isError: !r.ok };
  };

  const resolveNodeGeo = async (a: any) => {
    const name = a.graph ?? 'main';
    const g = ws.getGraph(name);
    const target = a.node || undefined;
    const r = await engine.cook(g, { target, frame: a.frame });
    if (!r.ok || !r.geo) throw new Error(reportText(name, r));
    return { r, name, geo: r.geo };
  };

  const tools: ToolDef[] = [
    {
      name: 'catalog',
      description: 'List available node types grouped by category (generate, curve, transform, deform, attribute, group, topology, copy, solid, sdf, uv, code, flow, io, asset). Optional filter by category or search text.',
      inputSchema: {
        type: 'object',
        properties: {
          category: { type: 'string' },
          search: { type: 'string', description: 'substring match on names/descriptions, e.g. "scatter" or "bevel"' },
          include_deprecated: { type: 'boolean', description: 'also list deprecated node types (hidden by default)' },
        },
      },
      run: async (a) => text(catalogText([...allNodeDefs(), ...[...engine.assets.values()].map((x) => x.def)], { category: a.category, search: a.search, deprecated: a.include_deprecated })),
    },
    {
      name: 'help',
      description: `Exact docs for node types (params with types, defaults, ranges, aliases; inputs; examples) and concept topics: ${topicList().join(', ')}. Call before using unfamiliar nodes.`,
      inputSchema: { type: 'object', properties: { nodes: { type: 'array', items: { type: 'string' }, description: 'node type names' }, topic: { type: 'string', description: `one of: ${topicList().join(', ')}, overview` } } },
      run: async (a) => {
        const out: string[] = [];
        if (a.topic) {
          if (a.topic === 'overview' || a.topic === 'instructions') out.push(INSTRUCTIONS);
          else if (TOPICS[a.topic]) out.push(TOPICS[a.topic]);
          else out.push(`unknown topic "${a.topic}". Topics: overview, ${topicList().join(', ')}`);
        }
        for (const n of a.nodes ?? []) {
          const d = engine.resolveDef(n);
          if (!d) { const s = didYouMean(n, engine.allTypeNames()); out.push(`unknown node "${n}"${s.length ? ` — did you mean ${s.join(', ')}?` : ''}`); continue; }
          out.push(nodeDoc(d));
        }
        if (!out.length) out.push(INSTRUCTIONS, '', 'Topics: ' + topicList().join(', '));
        return text(out.join('\n\n'));
      },
    },
    {
      name: 'build',
      description: 'Create or replace a whole node graph and cook it. Returns per-node errors with hints, warnings, and a summary of the output geometry (counts, bbox, attributes, groups). mode "merge" upserts nodes into the existing graph. dry_run validates and resolves params without cooking. render:true (or render options) also returns an image.',
      inputSchema: {
        type: 'object',
        required: ['graph'],
        properties: {
          graph: { type: 'object', description: '{"nodes": {name: {"type", "in", "params"}}, "output": name, "vars": {...}}' },
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
        spec = migrateGraph(spec);
        if (a.mode === 'merge' && ws.graphs.has(name)) spec = ws.mergeGraph(name, spec);
        if (a.dry_run) {
          const d = engine.dryRun(spec);
          return text(d.errors.length
            ? `✗ ${d.errors.length} error(s):\n` + d.errors.map((e) => `  [${e.node}] ${e.message}${e.hint ? `\n     hint: ${e.hint}` : ''}`).join('\n')
            : `✓ valid: ${Object.keys(spec.nodes).length} nodes, output "${d.output}"` + (d.notes.length ? '\nnotes: ' + d.notes.join('; ') : ''), d.errors.length > 0);
        }
        const v = engine.validate(spec);
        if (v.errors.length) return text(`✗ graph not saved — ${v.errors.length} error(s):\n` + v.errors.map((e) => `  [${e.node}] ${e.message}${e.hint ? `\n     hint: ${e.hint}` : ''}`).join('\n'), true);
        ws.setGraph(name, spec);
        return cookAndReport(name, a);
      },
    },
    {
      name: 'edit',
      description: 'Incrementally edit a graph, then re-cook (only affected nodes recompute). ops: {op:"set",node,params} (null removes a param) · {op:"add",node,type,in,params} · {op:"insert",node,type,params,after} (splice after a node) · {op:"remove",node} (rewires consumers) · {op:"connect",node,in:[...]} or {op:"connect",node,input:1,from:"x"} · {op:"rename",node,to} · {op:"replace",node,type?,params?,in?} · {op:"output",node} · {op:"vars",vars:{k:v}} · {op:"bypass",node,value}.',
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
        const { graph, notes } = ws.applyEdits(name, a.ops as EditOp[]);
        const v = engine.validate(graph);
        if (v.errors.length) return text(`✗ edits rejected (graph unchanged) — ${v.errors.length} error(s):\n` + v.errors.map((e) => `  [${e.node}] ${e.message}`).join('\n'), true);
        ws.setGraph(name, graph);
        return cookAndReport(name, a, notes);
      },
    },
    {
      name: 'inspect',
      description: 'Inspect any node\'s output as text: summary; detail "attributes" (min/max/mean, unique strings), "topology" (watertight/manifold, pieces, volume, area, genus), "elements" (list values for a range), or "all".',
      inputSchema: {
        type: 'object',
        properties: {
          graph: { type: 'string', description: 'graph name (default "main")' },
          node: { type: 'string', description: 'node to inspect (default: graph output)' },
          detail: { type: 'string', enum: ['summary', 'attributes', 'topology', 'elements', 'all'] },
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
        return text(head + '\n' + inspect(geo, { detail: a.detail, cls: a.class, attribs: a.attribs, start: a.start, count: a.count, group: a.group }));
      },
    },
    {
      name: 'render',
      description: 'Render a node\'s output to a PNG you can see: labelled orthographic + perspective views, smooth shading, wireframe, curves and points; back-faces show BLUE (flipped normals). color_by maps an attribute to colours; highlight shows a group in orange. Overlays that answer questions (help topic "render"): wireframe "all"/"hard"/"boundary"/"groups" (topology, creases, holes), views "section" or clip (interiors, wall thickness), glyphs N/up/orient/v (orientation), label_groups/label_pieces/label_attrib/point_numbers/prim_numbers (what is where), shading matcap/ao (form), legend, views "turntable".',
      inputSchema: {
        type: 'object',
        properties: {
          graph: { type: 'string' }, node: { type: 'string' },
          ...RENDER_PROPS,
          save_to: { type: 'string', description: 'also write the PNG to this path (relative to the workspace)' },
          ...FRAME_PROP,
        },
      },
      run: async (a) => {
        const { geo, name, r } = await resolveNodeGeo(a);
        const { img, notes, png } = pngContent(geo, renderOpts(a, geo, `${name}/${r.target}${atFrame(r)}`));
        const content: Content[] = [img];
        const info: string[] = [];
        if (a.save_to) {
          const p = path.resolve(ws.dir, a.save_to);
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, png);
          info.push(`saved ${p}`);
        }
        if (notes.length) info.push(notes.join('; '));
        if (info.length) content.push({ type: 'text', text: info.join('\n') });
        return { content };
      },
    },
    {
      name: 'export',
      description: 'Write a node\'s output to a file: .glb (glTF binary; best for Unreal/Blender/web), .obj, .usda, .ply, .stl, .json (lossless). Relative paths go into the workspace.',
      inputSchema: {
        type: 'object',
        required: ['path'],
        properties: {
          graph: { type: 'string' }, node: { type: 'string' },
          path: { type: 'string', description: 'e.g. "exports/rock.glb"' },
          format: { type: 'string', enum: ['glb', 'obj', 'usda', 'ply', 'stl', 'json'] },
          up_axis: { type: 'string', enum: ['y', 'z'] },
          scale: { type: 'number', description: 'multiply positions (100 = metres → centimetres)' },
          split_by_name: { type: 'boolean', description: 'separate meshes per prim "name" (default true)' },
          custom_attribs: { type: 'boolean', description: 'include extra float point attributes' },
          ...FRAME_PROP,
        },
      },
      run: async (a) => {
        const { geo, name, r } = await resolveNodeGeo(a);
        const p = path.resolve(ws.dir, a.path);
        const ext = (a.format ?? path.extname(p).slice(1)).toLowerCase() as ExportFormat;
        if (!['glb', 'obj', 'usda', 'ply', 'stl', 'json'].includes(ext)) throw new Error(`unknown format "${ext}"; use .glb .obj .usda .ply .stl .json`);
        const bytes = exportGeometry(geo, ext, { upAxis: a.up_axis, scale: a.scale, splitByName: a.split_by_name ?? true, custom: a.custom_attribs });
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, bytes);
        return text(`wrote ${p} (${ext}, ${(bytes.byteLength / 1024).toFixed(1)} KB) from ${name}/${r.target}${atFrame(r)}: ${geo.numPoints} points, ${geo.numPrims} prims`);
      },
    },
    {
      name: 'graphs',
      description: 'Manage workspace graphs: list (with node counts), get (full JSON), delete, rename, duplicate. Graphs persist as JSON files in workspace/graphs.',
      inputSchema: {
        type: 'object',
        required: ['action'],
        properties: { action: { type: 'string', enum: ['list', 'get', 'delete', 'rename', 'duplicate'] }, name: { type: 'string' }, to: { type: 'string' } },
      },
      run: async (a) => {
        switch (a.action) {
          case 'list': {
            if (!ws.graphs.size) return text(`no graphs yet (workspace ${ws.dir}). Use build.`);
            return text([...ws.graphs].map(([k, g]) => {
              const r = ws.lastReport.get(k);
              return `${k}: ${Object.keys(g.nodes).length} nodes, output ${g.output ?? '(auto)'}${r ? `, last cook ${r.ok ? 'ok' : 'FAILED'}${r.geo ? ` (${r.geo.numPoints} pts, ${r.geo.numPrims} prims)` : ''}` : ''}`;
            }).join('\n') + `\nworkspace: ${ws.dir}`);
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
      description: 'Reusable custom node types built from graphs (like HDAs). save {name, from_graph | graph, description, params:{var:{desc,min,max}}}: the graph\'s vars become parameters and its "input" nodes become inputs. list, get, delete.',
      inputSchema: {
        type: 'object',
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['save', 'list', 'get', 'delete'] },
          name: { type: 'string' }, from_graph: { type: 'string' }, graph: { type: 'object' },
          description: { type: 'string' }, params: { type: 'object' },
        },
      },
      run: async (a) => {
        switch (a.action) {
          case 'list':
            if (!engine.assets.size) return text('no assets yet');
            return text([...engine.assets.values()].map((x) => `${x.name} — ${x.def.summary}; params: ${Object.keys(x.def.params).join(', ') || 'none'}; inputs: ${x.def.inputs.length}`).join('\n'));
          case 'get': {
            const x = engine.assets.get(a.name);
            if (!x) throw new Error(`no asset "${a.name}"`);
            return text(nodeDoc(x.def) + '\n\n' + JSON.stringify(x.graph, null, 1));
          }
          case 'delete': {
            if (!engine.assets.delete(a.name)) throw new Error(`no asset "${a.name}"`);
            const f = path.join(ws.assetDir, a.name + '.json');
            if (fs.existsSync(f)) fs.unlinkSync(f);
            return text(`deleted asset "${a.name}"`);
          }
          case 'save': {
            if (!a.name) throw new Error('"name" is required');
            const g: GraphSpec = migrateGraph(structuredClone(a.graph ?? ws.getGraph(a.from_graph ?? 'main')));
            if (a.description) g.description = a.description;
            if (a.params) g.params = { ...(g.params ?? {}), ...a.params };
            const def = engine.registerAsset(a.name, g);
            fs.writeFileSync(path.join(ws.assetDir, a.name + '.json'), JSON.stringify(g, null, 2));
            return text(`saved asset "${a.name}" (use {"type": "${a.name}"})\n\n${nodeDoc(def)}`);
          }
        }
        return text('unknown action', true);
      },
    },
  ];
  if (opts.onPreview) {
    tools.push({
      name: 'preview',
      description: 'Start (or get the URL of) the live 3D preview web page for humans: orbit view of any graph/node that auto-refreshes after every build/edit. Returns the URL to open in a browser.',
      inputSchema: { type: 'object', properties: {} },
      run: async () => text(`live preview: ${await opts.onPreview!()}  (updates automatically on every build/edit; click nodes in the sidebar to view intermediate results)`),
    });
  }
  return tools;
}
