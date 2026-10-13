// Exercise selection before import in fresh processes, including simulated engines without SIMD support.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const moduleURL = new URL('../src/wasm/kernels.ts', import.meta.url).href;
const hostURL = new URL('../src/host/node.ts', import.meta.url).href;
const run = (envValue: string | undefined, setup = '', error = '') => {
  const env = { ...process.env };
  if (envValue === undefined) delete env.TOPOTOPO_WASM;
  else env.TOPOTOPO_WASM = envValue;
  const source = `
    import assert from 'node:assert/strict';
    const nodeProcess = globalThis.process;
    ${setup}
    const moduleURL = ${JSON.stringify(moduleURL)};
    const expectedError = ${JSON.stringify(error)};
    if (expectedError) {
      await assert.rejects(import(moduleURL), (e) => e.message.includes(expectedError));
      console.log(JSON.stringify({ error: expectedError }));
    } else {
      const loader = await import(moduleURL);
      globalThis.process = nodeProcess;
      const { createNodeHost } = await import(${JSON.stringify(hostURL)});
      assert.equal(loader.getLoadedKernels(), undefined, 'import has not instantiated WASM');
      const host = createNodeHost({ workers: 0 });
      const readFile = host.readFile.bind(host), reads = [];
      host.readFile = async path => { reads.push(path); return readFile(path); };
      const [a, b] = await Promise.all([loader.loadHostKernels(host), loader.loadHostKernels(host)]);
      assert.equal(a, b, 'concurrent calls share the loaded module');
      assert.equal(reads.length, 1, 'host loads only the selected package');
      const roof = a.roof([0, 0, 6, 0, 6, 4, 0, 4], [], 35);
      assert.ok(roof.vertices.length > 0);
      console.log(JSON.stringify({ variant: loader.kernelsWasmVariant, url: loader.kernelsWasmURL.href, read: reads[0], vertices: Array.from(roof.vertices) }));
    }
  `;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source], { env, encoding: 'utf8' }).trim());
};

const automatic = run(undefined);
assert.equal(automatic.variant, 'simd', 'Node 22+ defaults to SIMD');
assert.ok(automatic.url.includes('/pkg-simd/') && automatic.read.includes('/pkg-simd/'));
console.log('PASS kernelsloader: auto detects SIMD and cooks with the selected host bytes');
const scalar = run('scalar');
assert.equal(scalar.variant, 'scalar');
assert.ok(scalar.url.includes('/pkg/') && scalar.read.includes('/pkg/'));
assert.deepEqual(scalar.vertices, automatic.vertices);
console.log('PASS kernelsloader: scalar override cooks an identical roof');
const simd = run('simd');
assert.equal(simd.variant, 'simd');
assert.deepEqual(simd.vertices, scalar.vertices);
console.log('PASS kernelsloader: SIMD override cooks an identical roof');
const fallback = run(undefined, 'WebAssembly.validate = () => false;');
assert.equal(fallback.variant, 'scalar');
assert.deepEqual(fallback.vertices, scalar.vertices);
console.log('PASS kernelsloader: unavailable SIMD falls back to the scalar package');
run('simd', 'WebAssembly.validate = () => false;', 'requires WebAssembly simd128 support');
console.log('PASS kernelsloader: forced unsupported SIMD explains the missing feature');
run('invalid', '', 'TOPOTOPO_WASM must be scalar or simd');
console.log('PASS kernelsloader: invalid override fails clearly');
const browser = run(undefined, 'delete globalThis.process;');
assert.equal(browser.variant, 'simd');
console.log('PASS kernelsloader: selection works without a Node process global');
console.log('kernelsloader: 7 selection/initialisation checks passed');
