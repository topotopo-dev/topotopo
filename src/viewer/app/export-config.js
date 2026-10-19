// Shared, host-independent settings resolution. Overrides contain only fields the person changed.
export const defaultExportSettings = () => ({ version: 1, initialized: false, checked: [], destinations: {}, overrides: {}, defaults: {
  geometry: { format: 'glb', subfolder: '', formats: {} }, image: { format: 'textures', subfolder: '', formats: {} },
} });
export function exportStem(label) {
  let stem = label.replace(/[\\/<>:"|?*\x00-\x1f]/g, '_').replace(/^\.+|[. ]+$/g, '').trim() || 'output';
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(stem)) stem = '_' + stem;
  return stem.slice(0, 140);
}
export function resolveExport(settings, item) {
  const base = settings.defaults[item.kind === 'image' ? 'image' : 'geometry'];
  const override = settings.overrides[item.id] ?? {}, format = override.format ?? base.format;
  return { name: settings.destinations[item.id] ?? exportStem(item.label), format,
    subfolder: override.subfolder ?? base.subfolder,
    options: { ...(format === 'textures' ? { layers: ['*'] } : {}), ...base.formats[format], ...override.formats?.[format] } };
}
