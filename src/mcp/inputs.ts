// The human-input layer for agents: the files people drop into <workspace>/inputs (meshes, guide curves and points,
// PNG masks and heightmaps) and what each one holds: curves vs meshes vs points, bbox, names and roles, attributes,
// materials. Registered by makeTools in tools.ts; help topic "inputs" (docs.ts) explains the guide conventions.
import fs from 'node:fs';
import path from 'node:path';
import type { Workspace, InputFile } from '../workspace.ts';
import { inputExt, inputKind } from '../workspace.ts';
import type { Geometry, Attribute } from '../core/geometry.ts';
import { decodePNG } from '../io/png-decode.ts';
import { SIDECAR_NAMES, SIDECAR_TEXT } from '../io/sidecars.ts';
import type { Sidecar, SidecarRole } from '../io/sidecars.ts';
import { imageNameOf } from '../io/textures.ts';
import { readMaterials, MATERIAL_ATTRIB } from '../core/materials.ts';
import { didYouMean } from '../graph/params.ts';
import { fmtNum } from '../render/raster.ts';
import type { ToolDef, ToolResult } from './tools.ts';

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) });

/** Most distinct values of `name` / `role` listed per class. */
const MAX_VALUES = 50;
/** `inputs list` stops describing files it has not seen before after this long (the rest say so). */
const LIST_BUDGET_MS = 15_000;
/** name prefixes that mark a guide's role (help topic "inputs") */
export const ROLES = ['site', 'path', 'zone', 'volume', 'blockout'] as const;

const n = (x: number) => x.toLocaleString('en-US');
const plural = (k: number, one: string, many = one + 's') => `${n(k)} ${k === 1 ? one : many}`;
const sizeText = (b: number) => (b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);
const dateText = (ms: number) => {
  const d = new Date(ms), p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const typeText = (a: Attribute) => (a.isArray ? a.type : a.size === 1 ? a.type : `${a.type}${a.size}`);
/** where people get a readable file from formats we do not read */
const OTHER_HINTS: Record<string, string> = {
  fbx: 'FBX is not read: export glTF (.glb) instead', dae: 'export glTF (.glb) instead', '3ds': 'export glTF (.glb) instead',
  abc: 'Alembic is not read: export glTF (.glb) or .geo', usd: 'USD is written, not read: export glTF (.glb)', usda: 'USD is written, not read: export glTF (.glb)',
  usdc: 'USD is written, not read: export glTF (.glb)', usdz: 'USD is written, not read: export glTF (.glb)',
  jpg: 'only PNG images are read: save it as PNG', jpeg: 'only PNG images are read: save it as PNG', tif: 'only PNG images are read: save it as PNG (16-bit grey for heightmaps)',
  tiff: 'only PNG images are read: save it as PNG (16-bit grey for heightmaps)', exr: 'only PNG images are read: save it as 16-bit PNG', hdr: 'only PNG images are read',
  webp: 'only PNG images are read: save it as PNG', sc: 'compressed Houdini geometry is not read: save .geo or uncompressed .bgeo', gz: 'compressed files are not read: unpack it first',
  blend1: 'a Blender backup file (the .blend next to it is the current one)',
};
const READABLE = 'geometry: obj stl ply glb gltf geo bgeo csv json points.json, and blend with Blender installed; images: png';

interface Described {
  /** one line for inputs list */
  short: string;
  /** the full inputs describe text (without the header line) */
  long: string;
  failed: boolean;
}

/** inputs/ file → its description, keyed by path and invalidated by the host's file stamp (mtime + size). */
export class InputDescriber {
  ws: Workspace;
  private cache = new Map<string, { stamp: string; d: Promise<Described> }>();

  constructor(ws: Workspace) { this.ws = ws; }

  /** Describe one file (cached while its stamp holds). */
  describe(f: InputFile): Promise<Described> {
    const rel = `inputs/${f.path}`;
    const stamp = this.ws.engine.host.fileStamp(rel);
    const hit = this.cache.get(f.path);
    if (hit && hit.stamp === stamp) return hit.d;
    const d = (f.kind === 'geometry' ? this.geometry(rel, f.ext) : f.kind === 'image' ? this.image(rel) : f.kind === 'metadata' && f.sidecar ? this.metadata(rel, f.sidecar)
      : Promise.resolve(other(f.ext)))
      .catch((e: any): Described => ({ short: `cannot read: ${e?.message ?? e}`, long: `cannot read: ${e?.message ?? e}`, failed: true }));
    this.cache.set(f.path, { stamp, d });
    return d;
  }

  /** Whether describe() would answer from the cache. */
  cached(f: InputFile): boolean {
    const hit = this.cache.get(f.path);
    return !!hit && hit.stamp === this.ws.engine.host.fileStamp(`inputs/${f.path}`);
  }

  /** Forget files that are gone. */
  prune(keep: InputFile[]) {
    const live = new Set(keep.map((f) => f.path));
    for (const k of [...this.cache.keys()]) if (!live.has(k)) this.cache.delete(k);
  }

  /** Cook the one-node graph a file node would be (never a workspace graph) and read the result. */
  private async geometry(rel: string, ext: string): Promise<Described> {
    const r = await this.ws.engine.cook({ nodes: { f: { type: 'file', params: { path: rel } } }, output: 'f' });
    const warnings = r.warnings.map((w) => w.message);
    if (!r.ok || !r.geo) {
      const err = r.errors.map((e) => e.message + (e.hint ? ` (hint: ${e.hint})` : '')).join('; ') || 'no geometry';
      let why = ext === 'blend' ? '\n.blend files are converted by a headless Blender: it must be installed (and found) for the file node to read them.' : '';
      if (ext === 'json') {
        try {
          const j = JSON.parse(new TextDecoder().decode(await this.ws.engine.host.readFile(rel)));
          if (j && typeof j === 'object' && !Array.isArray(j) && j.nodes && typeof j.nodes === 'object')
            why = '\nThis JSON is a topotopo graph, not geometry: build it (build {graph}) instead of reading it with a file node.';
          else if (j?.format === 'topotopo-export-source' && j.source && typeof j.source === 'object') {
            // the record an export writes next to its file (io/source.ts): say what it is instead of a cook failure
            const what = `how ${Array.isArray(j.files) ? j.files.join(', ') : 'an export'} was made (graph "${j.source.graph}", frame ${j.source.frame})`;
            return { short: `export source: ${what}, not geometry`, long: `an export's source manifest, not geometry: ${what}. help topic "export" (SOURCE) tells how to make it again.`, failed: false };
          }
        } catch { /* not JSON at all: the error says so */ }
      }
      return { short: `cook failed: ${err}`, long: `the file node failed: ${err}${why}${warnings.length ? '\nwarnings:\n  ' + warnings.join('\n  ') : ''}`, failed: true };
    }
    return geometryText(r.geo, rel, ext, warnings);
  }

  /** An export's sidecar (io/sidecars.ts): what it records and the file it describes, without cooking it. */
  private async metadata(rel: string, s: Sidecar): Promise<Described> {
    const of = s.of === null ? 'an export that is not in inputs/' : `inputs/${s.of}`;
    if (s.role === 'source') {
      try {
        const j = JSON.parse(new TextDecoder().decode(await this.ws.engine.host.readFile(rel)));
        const what = `how ${Array.isArray(j.files) ? j.files.join(', ') : 'an export'} was made (graph "${j.source?.graph}", frame ${j.source?.frame})`;
        return { short: `export source: ${what}, not geometry`, long: `an export's source manifest, not geometry: ${what}. help topic "export" (SOURCE) tells how to make it again.`, failed: false };
      } catch { /* unreadable: said as for the other sidecars */ }
    }
    const read: Record<SidecarRole, string> = {
      source: 'help topic "export" (SOURCE) tells how to make it again',
      heightmap: s.of?.endsWith('.r16') ? 'the RAW heightmap beside it is for Unreal (a file node reads PNG heightmaps)'
        : 'read the heightmap with heightfield_from_image (height_min / height_max are in this sidecar)',
      meshes: 'read the instance stream (.csv / .points.json) beside it; its Mesh column names these meshes',
      landscape: 'the files it lists are in its folder (help topic "export", UNREAL LANDSCAPE BUNDLE)',
    };
    const what = `${SIDECAR_NAMES[s.role]} of ${of}: ${SIDECAR_TEXT[s.role]}`;
    return { short: `${what}, not geometry`, long: `${what}. Not geometry: ${read[s.role]}.`, failed: false };
  }

  private async image(rel: string): Promise<Described> {
    const img = decodePNG(await this.ws.engine.host.readFile(rel));
    const ch = img.channels, names = ['grey', 'grey + alpha', 'RGB', 'RGBA'][ch - 1];
    const lo = new Array(ch).fill(Infinity), hi = new Array(ch).fill(-Infinity), sum = new Array(ch).fill(0);
    const d = img.data, px = img.width * img.height;
    for (let i = 0; i < px; i++)
      for (let c = 0; c < ch; c++) { const v = d[i * ch + c]; if (v < lo[c]) lo[c] = v; if (v > hi[c]) hi[c] = v; sum[c] += v; }
    const label = (c: number) => (ch <= 2 ? ['grey', 'alpha'][c] : 'rgba'[c]);
    const ranges = lo.map((_, c) => `${label(c)} ${fmtNum(lo[c] / img.maxValue)}..${fmtNum(hi[c] / img.maxValue)} (mean ${fmtNum(sum[c] / px / img.maxValue)})`);
    const short = `${img.width} × ${img.height} px, ${img.bitDepth}-bit ${names} (${plural(ch, 'channel')})`;
    const [w, h] = [img.width, img.height];
    const long = [
      `image: ${short}`,
      `values (0..1): ${ranges.join(', ')}`,
      'read it as:',
      `  a heightmap  {"type":"heightfield_from_image","params":{"path":"${rel}","size":[${w - 1},${h - 1}],"height_min":0,"height_max":20}}`,
      '               (size = the extent in metres in X and Z; height_min/max = the heights of black and white; 16-bit greys keep the detail)',
      `  a mask layer {"type":"heightfield_from_image","in":["terrain"],"params":{"path":"${rel}","layer":"mask","height_min":0,"height_max":1,"size":[${w - 1},${h - 1}]}}`,
      '               (the image lies at size/center in the world, read at each sample\'s X/Z, so tiles match; fit "field" stretches it over the heightfield instead; then heightfield_scatter, mask_layer, …)',
      `  on points    {"type":"attribute_from_map","in":["pts"],"params":{"path":"${rel}","projection":"xz","size":[100,100],"name":"mask"}}`,
      '               (top view: column along +X, row 0 at min Z; then scatter density_mask, prune, copy_to_points scale_attrib)',
      `  a texture    {"type":"image_file","params":{"path":"${rel}"}}`,
      `               (an image "${imageNameOf(rel)}" for the texture nodes and texture_to_material; a file node reads it the same way)`,
    ].join('\n');
    return { short, long, failed: false };
  }
}

function other(ext: string): Described {
  const hint = OTHER_HINTS[ext];
  const what = ext ? `.${ext}` : 'a file without an extension';
  return {
    short: `not read${hint ? `: ${hint}` : ''}`,
    long: `${what} is not a format topotopo reads${hint ? `: ${hint}` : ''}. Readable: ${READABLE}.`,
    failed: false,
  };
}

/** Distinct values of a string attribute with counts, sorted by value. */
function stringValues(a: Attribute, count: number): [string, number][] {
  const freq = new Map<string, number>();
  for (let i = 0; i < count; i++) { const v = String(a.get(i)); freq.set(v, (freq.get(v) ?? 0) + 1); }
  return [...freq].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
}

/** Prim kinds: 0 polygon, 1 open polyline, 2 packed, 3 spline curve. */
function primKinds(g: Geometry): Uint8Array {
  const k = new Uint8Array(g.numPrims);
  for (let p = 0; p < g.numPrims; p++) {
    const pk = g.primKind ? g.primKind[p] : 0;
    k[p] = pk === 1 ? 2 : pk === 2 || pk === 3 ? 3 : g.primClosed[p] ? 0 : 1;
  }
  return k;
}
const KIND_NAMES: [string, string][] = [['polygon', 'polygons'], ['polyline', 'polylines'], ['packed prim', 'packed prims'], ['spline curve', 'spline curves']];
const kindsText = (c: number[]) => c.map((x, i) => (x ? plural(x, KIND_NAMES[i][0], KIND_NAMES[i][1]) : '')).filter(Boolean).join(' + ');

/** A role value, or the role of a name by its prefix like the wrangle of help topic "inputs" ("Path.River.001" → path). */
const roleOf = (s: string, isName: boolean) => {
  const r = (isName ? s.split('.')[0] : s).toLowerCase();
  return (ROLES as readonly string[]).includes(r) ? r : null;
};

/** What a guide of this role should be made of, given the prims carrying it (counts per kind, see primKinds). */
function roleChecks(role: string, v: string, k: number[]): string[] {
  const curves = k[1] + k[3], what = kindsText(k);
  if (role === 'path' && !curves) return [`${v} is ${what}: a path is an open polyline (in Blender a curve, or a mesh of edges only)`];
  if (role === 'zone' && !k[0] && curves) return [`${v} is ${what}: a zone is a closed area; ends {mode:"close"} turns closed loops into polygons`];
  if (role === 'site' && (k[0] || curves)) return [`${v} is ${what}: a site is a point; pack {by:"name", pivot:"bbox_center_bottom"} gives one anchor point per object`];
  if ((role === 'volume' || role === 'blockout') && !k[0] && !k[2]) return [`${v} is ${what}: a ${role} is a mesh (a box or a closed solid)`];
  return [];
}

function geometryText(g: Geometry, rel: string, ext: string, warnings: string[]): Described {
  const kinds = primKinds(g);
  const counts = [0, 0, 0, 0];
  for (let p = 0; p < g.numPrims; p++) counts[kinds[p]]++;
  const used = new Uint8Array(g.numPoints);
  for (let v = 0; v < g.numVertices; v++) used[g.vertexPoint[v]] = 1;
  let loose = 0;
  for (let i = 0; i < g.numPoints; i++) if (!used[i]) loose++;
  const lines: string[] = [];
  const elems = [kindsText(counts), loose ? plural(loose, 'loose point') : ''].filter(Boolean).join(' + ') || 'empty';
  lines.push(`elements: ${plural(g.numPoints, 'point')}, ${plural(g.numPrims, 'prim')} = ${elems}`);
  lines.push(`  (polygons are closed faces, polylines open curves, loose points belong to no prim, packed prims are instances${counts[3] ? ', spline curves Bezier/NURBS' : ''})`);
  const vols = g.volumes.length ? g.volumes.map((v) => `${v.kind} "${v.name}"`).join(', ') : '';
  if (vols) lines.push(`volumes: ${vols}`);
  const b = g.bbox(true);
  const size = [0, 1, 2].map((a) => b.max[a] - b.min[a]);
  const v3 = (a: number[]) => `(${a.map(fmtNum).join(', ')})`;
  const bboxShort = b.empty ? 'no bbox' : `bbox ${size.map(fmtNum).join(' × ')} m`;
  if (!b.empty) lines.push(`bbox (metres, as read, Y up): min ${v3(b.min)} max ${v3(b.max)} size ${size.map(fmtNum).join(' × ')}`);

  // attributes and groups
  const attrs: string[] = [];
  for (const cls of ['point', 'vertex', 'prim', 'detail'] as const) {
    const t = g.table(cls);
    if (t.map.size) attrs.push(`  ${cls}: ${[...t.map].map(([k, a]) => `${k} ${typeText(a)}`).join(', ')}`);
  }
  if (attrs.length) lines.push('attributes:', ...attrs);
  const grp: string[] = [];
  for (const cls of ['point', 'prim', 'vertex'] as const) {
    const m = g.groups(cls);
    if (m.size) grp.push(`${cls}: ${[...m].map(([k, mask]) => `${k} ${n(mask.reduce((s, x) => s + x, 0))}`).join(', ')}`);
  }
  if (g.edgeGroups.size) grp.push(`edge: ${[...g.edgeGroups].map(([k, set]) => `${k} ${n(set.size)}`).join(', ')}`);
  lines.push(grp.length ? `groups: ${grp.join('  ')}` : 'groups: none');

  // name and role values, with the kind of prims that carry each
  const isStr = (a: Attribute | undefined): a is Attribute => !!a && a.type === 'string' && !a.isArray;
  const kindsOf = (a: Attribute) => {
    const m = new Map<string, number[]>();
    for (let p = 0; p < g.numPrims; p++) { const v = String(a.get(p)); let c = m.get(v); if (!c) m.set(v, (c = [0, 0, 0, 0])); c[kinds[p]]++; }
    return m;
  };
  const shortNames: string[] = [];
  for (const attr of ['name', 'role'] as const)
    for (const cls of ['prim', 'point'] as const) {
      const a = g.table(cls).get(attr);
      if (!isStr(a)) continue;
      const vals = stringValues(a, cls === 'prim' ? g.numPrims : g.numPoints);
      const per = cls === 'prim' ? kindsOf(a) : null;
      lines.push(`${cls} ${attr} (${plural(vals.length, 'value')}):`);
      for (const [v, c] of vals.slice(0, MAX_VALUES)) lines.push(`  ${JSON.stringify(v)}  ${per ? kindsText(per.get(v)!) : plural(c, 'point')}`);
      if (vals.length > MAX_VALUES) lines.push(`  … ${plural(vals.length - MAX_VALUES, 'more value')}`);
      if (attr === 'name' && !shortNames.length) shortNames.push(...vals.map(([v]) => v));
    }
  // roles, per element as the wrangle of help topic "inputs" derives them: the role attribute, else the name prefix
  const objects = new Map<string, Map<string, number[]>>(), points = new Map<string, number>(), checks: string[] = [];
  let fromAttr = false, fromName = false;
  for (const cls of ['prim', 'point'] as const) {
    const ra = g.table(cls).get('role'), na = g.table(cls).get('name');
    const roleA = isStr(ra) ? ra : null, nameA = isStr(na) ? na : null;
    if (!roleA && !nameA) continue;
    for (let i = 0, count = cls === 'prim' ? g.numPrims : g.numPoints; i < count; i++) {
      const rv = roleA ? String(roleA.get(i)) : '', nv = nameA ? String(nameA.get(i)) : '';
      const role = rv ? roleOf(rv, false) : roleOf(nv, true);
      if (!role) continue;
      if (rv) fromAttr = true; else fromName = true;
      if (cls === 'point') { points.set(role, (points.get(role) ?? 0) + 1); continue; }
      let objs = objects.get(role);
      if (!objs) objects.set(role, (objs = new Map()));
      const label = nv || rv;
      let k = objs.get(label);
      if (!k) objs.set(label, (k = [0, 0, 0, 0]));
      k[kinds[i]]++;
    }
  }
  const roleNames = ROLES.filter((r) => objects.has(r) || points.has(r));
  if (roleNames.length) {
    const src = fromAttr && fromName ? 'the role attribute and name prefixes' : fromAttr ? 'the role attribute' : 'name prefixes';
    lines.push(`roles (from ${src}): ${roleNames.map((r) => `${r} ${[objects.has(r) ? plural(objects.get(r)!.size, 'object') : '', points.has(r) ? plural(points.get(r)!, 'point') : ''].filter(Boolean).join(' + ')}`).join(', ')}`);
    for (const [role, objs] of objects) for (const [label, k] of objs) checks.push(...roleChecks(role, JSON.stringify(label), k));
  } else lines.push('roles: none marked (name objects site.* path.* zone.* volume.* blockout.*, or give them a string attribute "role"; help topic "inputs")');
  for (const m of checks) lines.push(`  check: ${m}`);

  // materials
  const mat = g.table('prim').get(MATERIAL_ATTRIB);
  const table = Object.keys(readMaterials(g));
  if ((mat && mat.type === 'string') || table.length) {
    const used = mat && mat.type === 'string' ? stringValues(mat, g.numPrims).filter(([v]) => v !== '') : [];
    const unused = table.filter((t) => !used.some(([v]) => v === t));
    lines.push(`materials: ${used.length ? used.slice(0, MAX_VALUES).map(([v, c]) => `${JSON.stringify(v)} ${plural(c, 'prim')}`).join(', ') : 'none assigned'}${used.length > MAX_VALUES ? `, … ${used.length - MAX_VALUES} more` : ''}${unused.length ? `; in the table only: ${unused.join(', ')}` : ''}`);
  } else lines.push('materials: none');
  if (warnings.length) lines.push('warnings:', ...warnings.map((w) => `  ${w}`));

  // up axis: OBJ/STL/PLY carry none
  const flatY = !b.empty && size[2] < 0.1 * Math.max(size[0], size[1]) && size[1] > 0.5 * size[0] && size[1] > 0;
  if (['obj', 'stl', 'ply'].includes(ext) && flatY)
    lines.push(`up axis: this looks Z-up (flat in Z, spread in X and Y): read it with "up_axis":"z" if it should lie on the ground.`);
  lines.push('up axis: OBJ/STL/PLY exports from Blender (with Up = Z) and from Unreal are Z-up and need "up_axis":"z" on the file node; glTF is +Y up already.');
  lines.push(`read it: {"type":"file","params":{"path":"${rel}"}}`);

  const names = shortNames.length ? `; name: ${shortNames.slice(0, 6).join(', ')}${shortNames.length > 6 ? ` (+${shortNames.length - 6})` : ''}` : '';
  const short = `${plural(g.numPoints, 'point')}, ${plural(g.numPrims, 'prim')} = ${elems}; ${bboxShort}${names}${warnings.length ? `; ${plural(warnings.length, 'warning')}` : ''}`;
  return { short, long: lines.join('\n'), failed: false };
}

/** "inputs/a.obj", "./a.obj", "a.obj" → "a.obj" (posix, inside inputs/), or an Error naming the files there. */
function resolveInput(ws: Workspace, p: unknown, files: InputFile[]): InputFile {
  if (typeof p !== 'string' || !p.trim()) throw new Error('"path" is required: a file under inputs/ (inputs {action:"list"} lists them)');
  const rel = p.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  if (path.isAbsolute(rel) || /^[a-z]:\//i.test(rel) || rel.split('/').includes('..')) throw new Error(`"${p}": give a path inside inputs/, relative to it (e.g. "guides.glb")`);
  const byPath = new Map(files.map((f) => [f.path, f]));
  const hit = byPath.get(rel) ?? (rel.startsWith('inputs/') ? byPath.get(rel.slice(7)) : undefined);
  if (hit) return hit;
  // a file the walk skipped (dot-file) or that just arrived: describe it if it is there
  const abs = path.join(ws.inputDir, rel.startsWith('inputs/') && !fs.existsSync(path.join(ws.inputDir, rel)) ? rel.slice(7) : rel);
  try {
    const st = fs.statSync(abs);
    if (st.isFile()) {
      const r = path.relative(ws.inputDir, abs).split(path.sep).join('/'), ext = inputExt(r);
      return { path: r, kind: inputKind(ext), ext, size: st.size, mtime: Math.round(st.mtimeMs) };
    }
  } catch { /* not there */ }
  const s = didYouMean(rel.replace(/^inputs\//, ''), files.map((f) => f.path));
  throw new Error(`no input "${rel}"${s.length ? ` — did you mean ${s.join(', ')}?` : ''}. ${files.length ? `Files: ${files.slice(0, 20).map((f) => f.path).join(', ')}${files.length > 20 ? ', …' : ''}` : `inputs/ is empty (${ws.inputDir})`}`);
}

export function inputsTool(ws: Workspace): ToolDef {
  const describer = new InputDescriber(ws);
  return {
    name: 'inputs',
    description: 'The human\'s own material: files people drop into the workspace inputs/ folder (meshes, guide curves and points from Blender/Houdini/Unreal, blockouts, PNG masks and heightmaps). list: every file with kind (geometry/image/metadata/other; metadata = an export\'s sidecar such as a heightmap\'s .json or <file>.source.json), size, date and a summary (counts, curves vs meshes, bbox, object names; PNG size and bit depth). describe {path}: what a file node reads from it: polygons vs open polylines vs loose points vs packed prims, bbox in metres, attributes, groups, every name and role value, materials, warnings. Call list FIRST when building a landscape or scene: guides mark sites, paths, zones, volumes and blockouts (help topic "inputs"). Read a file with {type:"file", params:{path:"inputs/<path>"}}.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'describe'] },
        path: { type: 'string', description: 'describe: the file, relative to inputs/ (as list prints it)' },
      },
    },
    run: async (a) => {
      const files = ws.listInputs();
      describer.prune(files);
      if (a.action === 'describe') {
        const f = resolveInput(ws, a.path, files);
        const d = await describer.describe(f);
        const head = `inputs/${f.path}: ${f.kind}${f.ext ? ` (.${f.ext})` : ''}, ${sizeText(f.size)}, modified ${dateText(f.mtime)}`;
        return text(`${head}\n${d.long}`, d.failed);
      }
      if (a.action !== 'list') return text(`unknown action "${a.action}": use list or describe {path}`, true);
      if (!files.length)
        return text(`no input files yet. People drop meshes, guide curves and points, blockouts and PNG masks into ${ws.inputDir} (or onto the live viewer); then inputs list shows them. Readable: ${READABLE}.`);
      const t0 = Date.now();
      const rows: string[] = [];
      let skipped = 0;
      for (const f of files) {
        let summary: string;
        if (f.kind === 'other' || f.kind === 'metadata' || describer.cached(f) || Date.now() - t0 < LIST_BUDGET_MS) summary = (await describer.describe(f)).short;
        else { summary = 'not summarised yet (list time budget): inputs describe reads it'; skipped++; }
        rows.push(`  ${f.path}  ${f.kind}  ${sizeText(f.size)}  ${dateText(f.mtime)}  ${summary}`);
      }
      const kinds = (['geometry', 'image', 'metadata', 'other'] as const).map((k) => [k, files.filter((f) => f.kind === k).length] as const).filter(([, c]) => c);
      return text([
        `inputs/ (${ws.inputDir}): ${plural(files.length, 'file')} (${kinds.map(([k, c]) => `${c} ${k}`).join(', ')})`,
        ...rows,
        ...(skipped ? [`${plural(skipped, 'file')} not summarised within ${LIST_BUDGET_MS / 1000} s; list again (summaries are cached) or describe them one by one.`] : []),
        'A file node reads one: {"type":"file","params":{"path":"inputs/<path>"}} (paths are relative to the workspace). inputs {action:"describe", path} shows curves vs meshes, every name and role, attributes and materials; help {topic:"inputs"} explains the guide roles (site, path, zone, volume, blockout) and recipes.',
        'OBJ/STL from Blender (Up = Z) and Unreal are Z-up: add "up_axis":"z". A .blend needs Blender installed (converted headlessly).',
      ].join('\n'));
    },
  };
}
