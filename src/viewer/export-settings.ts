import fs from 'node:fs';
import path from 'node:path';
import { EXPORT_FORMATS } from '../io/export.ts';
import { defaultExportSettings } from './app/export-config.js';

export function exportError(status: number, message: string): never { throw Object.assign(new Error(message), { status }); }
const object = (v: any) => v && typeof v === 'object' && !Array.isArray(v);
export function validateOptions(o: any) {
  if (!object(o)) exportError(400, 'options must be an object');
  for (const k of ['split_by_name', 'materials', 'custom_attribs', 'quantize', 'pcg', 'pcg_struct', 'meshes']) if (o[k] !== undefined && typeof o[k] !== 'boolean') exportError(400, `invalid ${k}`);
  for (const [k, values] of Object.entries({ instancing: ['packed', 'expand'], instances: ['rows', 'expand'], precision: [32, 64], up_axis: ['y', 'z'], compress: ['none', 'meshopt', 'draco'] }))
    if (o[k] !== undefined && !(values as any[]).includes(o[k])) exportError(400, `invalid ${k}`);
  for (const k of ['attributes', 'layers']) if (o[k] !== undefined && (!Array.isArray(o[k]) || !o[k].every((v: unknown) => typeof v === 'string'))) exportError(400, `${k} must be names`);
  if (o.layer !== undefined && typeof o.layer !== 'string') exportError(400, 'layer must be a name');
  if (o.scale !== undefined && !(Number.isFinite(o.scale) && o.scale > 0)) exportError(400, 'scale must be positive');
  for (const k of ['height_min', 'height_max', 'tile_size', 'heightfield']) if (o[k] !== undefined && !Number.isFinite(o[k])) exportError(400, `invalid ${k}`);
  for (const k of ['tile_size', 'heightfield']) if (o[k] !== undefined && (!Number.isInteger(o[k]) || o[k] < 0)) exportError(400, `invalid ${k}`);
}
export function validateName(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 160 || /[\\/<>:"|?*\x00-\x1f]/.test(raw) || raw.startsWith('.') || /[. ]$/.test(raw) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(raw)) exportError(400, 'use a plain filename without folders');
  return raw.trim();
}
export function validateSubfolder(raw: unknown): string {
  if (typeof raw !== 'string') exportError(400, 'subfolder must be a relative folder');
  if (!raw) return '';
  const parts = raw.replace(/\\/g, '/').split('/');
  for (const p of parts) validateName(p);
  return parts.join('/');
}
/** Check existing ancestors too, so a junction/symlink cannot redirect a write outside exports/. */
export function exportPath(root: string, destination: string): string {
  const abs = path.resolve(destination), rel = path.relative(path.resolve(root), abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) exportError(400, 'export path must stay inside exports/');
  let current = path.resolve(root);
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) exportError(400, 'export paths cannot traverse symbolic links');
  }
  return abs;
}
export function validateSettings(s: any) {
  if (!object(s) || s.version !== 1 || typeof s.initialized !== 'boolean' || !Array.isArray(s.checked) || !s.checked.every((x: unknown) => typeof x === 'string') || !object(s.defaults) || !object(s.overrides) || !object(s.destinations)) exportError(400, 'invalid export settings');
  const profile = (p: any, partial: boolean) => {
    if (!object(p)) exportError(400, 'invalid export profile');
    if ((!partial || p.format !== undefined) && !EXPORT_FORMATS.includes(p.format)) exportError(400, 'choose a supported export format');
    if (!partial || p.subfolder !== undefined) validateSubfolder(p.subfolder);
    if (!partial || p.formats !== undefined) {
      if (!object(p.formats)) exportError(400, 'invalid format options');
      for (const [f, options] of Object.entries(p.formats)) { if (!EXPORT_FORMATS.includes(f as any)) exportError(400, 'invalid format'); validateOptions(options); }
    }
  };
  profile(s.defaults.geometry, false); profile(s.defaults.image, false);
  if (s.defaults.image.format !== 'textures') exportError(400, 'image outputs export as PNG textures');
  for (const p of Object.values(s.overrides)) profile(p, true);
  for (const n of Object.values(s.destinations)) validateName(n);
  return s;
}
export class ExportSettingsStore {
  file: string;
  constructor(dir: string) { this.file = path.join(dir, '.export-settings.json'); }
  read() {
    if (!fs.existsSync(this.file)) return defaultExportSettings();
    try { return validateSettings(JSON.parse(fs.readFileSync(this.file, 'utf8'))); }
    catch { exportError(422, 'Cannot read .export-settings.json; repair the project settings before exporting.'); }
  }
  write(settings: any) {
    validateSettings(settings);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.part', JSON.stringify(settings, null, 2) + '\n');
    fs.renameSync(this.file + '.part', this.file);
    return settings;
  }
}
