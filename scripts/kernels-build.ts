// Produce both checked-in web packages. Extra arguments go to Cargo, e.g. -- --features profile.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cargoArgs = process.argv.slice(2);
while (cargoArgs[0] === '--') cargoArgs.shift();
// The two output feature sets are fixed; profiling is the only supported build variation.
if (cargoArgs.length && !(cargoArgs.length === 2 && cargoArgs[0] === '--features' && cargoArgs[1] === 'profile')) {
  console.error('usage: npm run kernels:build [-- --features profile]');
  process.exit(1);
}

let total = 0;
for (const simd of [false, true]) {
  const dir = simd ? 'pkg-simd' : 'pkg';
  const features = `target-feature=${simd ? '+' : '-'}simd128,-relaxed-simd`;
  const env = { ...process.env };
  // Cargo's encoded form overrides RUSTFLAGS, so preserve and append to whichever is active.
  if (env.CARGO_ENCODED_RUSTFLAGS !== undefined)
    env.CARGO_ENCODED_RUSTFLAGS = [env.CARGO_ENCODED_RUSTFLAGS, '-C', features].filter(Boolean).join('\x1f');
  else env.RUSTFLAGS = `${env.RUSTFLAGS ?? ''} -C ${features}`.trim();
  console.log(`Building ${simd ? 'SIMD' : 'scalar'} kernels/${dir}`);
  try {
    execFileSync('wasm-pack', [
      'build', 'kernels', '--target', 'web', '--release', '--out-dir', dir,
      '--', '--no-default-features', ...(simd ? ['--features', 'simd'] : []), ...cargoArgs,
    ], { cwd: ROOT, env, stdio: 'inherit' });
  } catch (error) {
    console.error(`kernels:build: ${dir} failed`);
    process.exitCode = 1;
    throw error;
  } finally {
    // Keep both output packages visible to Git and npm; their checked-in .npmignore is also retained.
    fs.rmSync(path.join(ROOT, 'kernels', dir, '.gitignore'), { force: true });
  }
  const bytes = fs.statSync(path.join(ROOT, 'kernels', dir, 'topotopo_kernels_bg.wasm')).size;
  total += bytes;
  console.log(`kernels/${dir}: ${bytes} WASM bytes`);
}
if (total > 2_500_000) throw new Error(`combined scalar/SIMD WASM is ${total} bytes (limit 2500000)`);
console.log(`kernels:build: combined scalar/SIMD WASM ${total} bytes (limit 2500000)`);
