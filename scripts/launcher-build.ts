// Build the Windows launcher (launcher/, Rust) and copy it to launcher/win32-x64/topotopo-open.exe, the file the npm
// package ships. Windows only (the x86_64-pc-windows-msvc target with the Visual Studio C++ build tools).
//   node scripts/launcher-build.ts      (npm run launcher:build)
//
// The exe is committed like kernels/pkg: installing TopoTopo and npm test need no Rust. test/launcher.ts checks that the
// committed exe was built from the sources beside it (a fingerprint the build records in it), so run this after any
// change under launcher/ and commit the exe with the change. CI builds it from source again and runs the same checks.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAUNCHER = path.join(ROOT, 'launcher');
const BUILT = path.join(LAUNCHER, 'target', 'release', 'topotopo-open.exe');
const SHIPPED = path.join(LAUNCHER, 'win32-x64', 'topotopo-open.exe');

if (process.platform !== 'win32') {
  console.error('launcher:build: the launcher is a Windows program; build it on Windows');
  process.exit(1);
}
try {
  // in launcher/, so cargo reads launcher/.cargo/config.toml (static C runtime, reproducible link)
  execFileSync('cargo', ['build', '--release', '--locked'], { cwd: LAUNCHER, stdio: 'inherit' });
} catch (e: any) {
  console.error(`launcher:build: cargo failed${e?.code === 'ENOENT' ? ' (cargo is not installed: https://rustup.rs)' : ''}`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(SHIPPED), { recursive: true });
fs.copyFileSync(BUILT, SHIPPED);
console.log(`launcher:build: ${path.relative(ROOT, SHIPPED).split(path.sep).join('/')} (${fs.statSync(SHIPPED).size} bytes)`);
