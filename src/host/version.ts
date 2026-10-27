// The TopoTopo version, from package.json (two levels above both src/host/version.ts and dist/host/version.js).
import fs from 'node:fs';

export const TOPOTOPO_VERSION: string = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
