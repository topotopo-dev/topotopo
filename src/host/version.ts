// The TopoTopo version, from package.json (two levels above both src/host/version.ts and dist/host/version.js).
import fs from 'node:fs';

const pkg: { name: string; version: string } = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
export const TOPOTOPO_VERSION = pkg.version;

/** Compare major, minor and patch, ignoring anything after them. */
export function isNewerVersion(latest: string, current: string): boolean {
  const numbers = /^(\d+)\.(\d+)\.(\d+)/;
  const a = numbers.exec(latest), b = numbers.exec(current);
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i++) {
    const next = BigInt(a[i]), installed = BigInt(b[i]);
    if (next !== installed) return next > installed;
  }
  return false;
}

export async function fetchLatestVersion(): Promise<string> {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/latest`, {
    signal: AbortSignal.timeout(5000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  if (typeof body !== 'object' || body === null || !('version' in body) || typeof body.version !== 'string') {
    throw new Error('the response has no version');
  }
  return body.version;
}
