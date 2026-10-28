// Verification tools for agents: explain (describe a cooked geometry in words) and diff (compare two graph
// versions, nodes or frames, with an optional overlay render). Registered by makeTools in tools.ts.
import zlib from 'node:zlib';
import type { Workspace } from '../workspace.ts';
import type { Geometry } from '../core/geometry.ts';
import { renderGeometry } from '../render/raster.ts';
import type { ViewName } from '../render/raster.ts';
import { encodePNG } from '../render/png.ts';
import { diffGeometry, diffOverlay, explainGeometry } from '../explain.ts';
import type { Content, ToolDef } from './tools.ts';

interface GeoRef { graph?: string; node?: string; frame?: number }

/** "graph", "graph/node", or {graph, node, frame}. */
function parseRef(r: any, what: string): GeoRef {
  if (r === undefined || r === null) throw new Error(`"${what}" is required: {graph, node?, frame?} or "graph/node"`);
  if (typeof r === 'string') {
    const [graph, node] = r.split('/');
    return { graph: graph || undefined, node: node || undefined };
  }
  if (typeof r === 'object') return { graph: r.graph, node: r.node, frame: r.frame };
  throw new Error(`"${what}" must be an object {graph, node?, frame?} or a string "graph/node"`);
}

/** Cook a graph (or one of its nodes) at a frame; errors carry the failing nodes. */
async function cookRef(ws: Workspace, ref: GeoRef): Promise<{ geo: Geometry; label: string }> {
  const name = ref.graph ?? 'main';
  const r = await ws.engine.cook(ws.getGraph(name), { target: ref.node || undefined, frame: ref.frame });
  const label = `${name}/${r.target}${r.frame !== 1 ? ` @ frame ${r.frame}` : ''}`;
  if (!r.ok || !r.geo) throw new Error(`${label} failed to cook: ${r.errors.map((e) => `[${e.node}] ${e.message}`).join('; ') || 'no geometry'}`);
  return { geo: r.geo, label };
}

const REF_SCHEMA = {
  description: 'a geometry to compare: {graph (default "main"), node (default: graph output), frame (default 1)} or "graph/node"',
  anyOf: [
    { type: 'string' },
    { type: 'object', properties: { graph: { type: 'string' }, node: { type: 'string' }, frame: { type: 'number' } } },
  ],
};

export function verifyTools(ws: Workspace): ToolDef[] {
  return [
    {
      name: 'explain',
      description: 'Describe a node\'s cooked geometry in words, for checking a result without a render: a "reads as" summary (e.g. "one closed piece, box-like, 2 × 1 × 1 m, 3 cm thin walls, mirror-symmetric in x, z"), pieces with counts/bbox/volume, watertightness, genus and boundary loops, flipped normals, mirror symmetry about the bbox-centre planes, principal axis and aspect ratio, sampled wall thickness, degenerate faces, polygon mix, attributes, groups and materials.',
      inputSchema: {
        type: 'object',
        properties: {
          graph: { type: 'string', description: 'graph name (default "main")' },
          node: { type: 'string', description: 'node to explain (default: the graph output)' },
          frame: { type: 'number', description: 'frame to cook at (default 1)' },
        },
      },
      run: async (a) => {
        const t0 = performance.now();
        const { geo, label } = await cookRef(ws, { graph: a.graph, node: a.node, frame: a.frame });
        const text = explainGeometry(geo, label);
        return { content: [{ type: 'text', text: `${text}\n(explained in ${(performance.now() - t0).toFixed(0)} ms)` }] };
      },
    },
    {
      name: 'diff',
      description: 'Compare two geometries (two graphs, two nodes of one graph, or two frames) to see what a change did: point/prim counts, bbox delta, topology and volume, attribute schema and group changes, heightfields, images and SDF grids sample by sample, symmetric Hausdorff and mean surface distance (sampled, BVH), per-point displacement when point counts match, and a one-line verdict. render:true adds a quad-view overlay PNG: grey = unchanged, blue = only in b (moved or new), orange = only in a. Tip: graphs {action:"duplicate"} before an edit, then diff the copy against the edited graph.',
      inputSchema: {
        type: 'object',
        required: ['a', 'b'],
        properties: {
          a: REF_SCHEMA,
          b: REF_SCHEMA,
          render: { type: 'boolean', description: 'also return an overlay render (default false)' },
          samples: { type: 'number', description: 'surface samples per side for the distances (default 3000)' },
          views: { description: 'render views: "quad" (default) or a list of persp/front/back/left/right/top/bottom', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          size: { type: 'number', description: 'render: pixels per view tile' },
        },
      },
      run: async (args) => {
        const ra = parseRef(args.a, 'a'), rb = parseRef(args.b, 'b');
        const A = await cookRef(ws, ra), B = await cookRef(ws, rb);
        const samples = Math.max(100, Math.min(100000, Math.round(args.samples ?? 3000)));
        const d = diffGeometry(A.geo, B.geo, [A.label, B.label], samples);
        const content: Content[] = [{ type: 'text', text: d.text }];
        if (args.render) {
          let views: ViewName[] | undefined;
          if (typeof args.views === 'string' && args.views !== 'quad') views = args.views.split(/[\s,]+/) as ViewName[];
          else if (Array.isArray(args.views)) views = args.views;
          const known = ['persp', 'front', 'back', 'left', 'right', 'top', 'bottom'];
          for (const v of views ?? []) if (!known.includes(v)) throw new Error(`unknown view "${v}" (use ${known.join(', ')} or "quad")`);
          const img = renderGeometry(diffOverlay(A.geo, B.geo), { views, size: args.size, title: 'diff: grey same, blue b only, orange a only' });
          const png = encodePNG(img.rgba, img.width, img.height, (x) => zlib.deflateSync(x, { level: 6 }));
          content.push({ type: 'image', data: Buffer.from(png).toString('base64'), mimeType: 'image/png' });
          content.push({ type: 'text', text: 'overlay: grey = b where it lies on a (unchanged), blue = b away from a (moved / added), orange = a away from b (moved from / removed)' });
        }
        return { content };
      },
    },
  ];
}
