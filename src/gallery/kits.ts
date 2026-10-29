// TopoTopo's kits: the packages of TopoTopo's built-in library (library/ in the checkout), which every project can use.
// The viewer's welcome and its "Find packages", and the Gallery's search and kit pages list them from here: each kit's
// title and description (its project.json), its newest version and the outputs that version publishes, with their
// kinds, tags and the thumbnail the kit keeps of each (thumbs/<output>.png).
import fs from 'node:fs';
import path from 'node:path';
import { BUILTIN_LIBRARY, readManifest } from './library.ts';
import { builtinVersions } from './packages.ts';
import type { VersionInfo } from './packages.ts';

/** An output of a kit's newest version, by the node type a graph names it with ("topotopo/street/bench"). */
export interface KitOutput {
  type: string;
  /** its id in the kit ("bench") */
  id: string;
  label: string;
  kind?: string;
  tags: string[];
  description?: string;
  /** the kit's thumbnail of it (absolute path), when it has one */
  thumb?: string;
  /** the kit's default output (the kit line-up) */
  default: boolean;
}

export interface Kit {
  /** "topotopo/street" */
  name: string;
  /** "street": its folder, and its id in the Gallery */
  id: string;
  title: string;
  description: string;
  tags: string[];
  dir: string;
  /** its newest version, and every version oldest first */
  version: string | null;
  versions: VersionInfo[];
  outputs: KitOutput[];
}

/** The kits of TopoTopo's built-in library, by name; unreadable ones are left out. */
export function listKits(builtin = BUILTIN_LIBRARY.path): Kit[] {
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(builtin).filter((d) => fs.existsSync(path.join(builtin, d, 'project.json'))).sort(); } catch { return []; }
  const kits: Kit[] = [];
  for (const id of dirs) {
    const dir = path.join(builtin, id);
    try {
      const m = readManifest(dir);
      if (!m.package) continue;
      const versions = builtinVersions(m.package, builtin), newest = versions.at(-1);
      const isDefault = (o: { graph: string; node: string }) => !!newest && o.graph === newest.default.graph && o.node === newest.default.node;
      const outputs: KitOutput[] = newest ? Object.entries(newest.outputs).map(([k, o]) => {
        const thumb = path.join(dir, 'thumbs', `${k}.png`);
        return {
          type: `${m.package}/${k}`, id: k, label: o.label ?? k, ...(o.kind ? { kind: o.kind } : {}), tags: o.tags ?? [],
          ...(o.description ? { description: o.description } : {}), ...(fs.existsSync(thumb) ? { thumb } : {}), default: isDefault(o),
        };
      }) : [];
      kits.push({ name: m.package, id, title: m.title, description: m.description, tags: m.tags, dir, version: newest?.version ?? null, versions, outputs });
    } catch { /* an unreadable kit is left out */ }
  }
  return kits;
}

/** A kit's outputs in a line: "7 outputs: bench, bollard, cable …". */
export const kitOutputsText = (k: Kit, most = 6) => {
  const names = k.outputs.filter((o) => !o.default).map((o) => o.id);
  return `${names.length} output${names.length === 1 ? '' : 's'}${names.length ? `: ${names.slice(0, most).join(', ')}${names.length > most ? ' …' : ''}` : ''}`;
};
