// Lazy loader for the Rapier physics engine (@dimforge/rapier3d-compat, Apache-2.0), used by the rbd nodes.
//
// The compat build inlines its WASM as base64 in the JavaScript module, so unlike our own kernels (src/wasm/kernels.ts,
// read through Host.readFile) there is no separate file for a host to fetch: the dynamic import below is the lazy hook.
// Importing this module costs nothing; the ~4 MB module is imported and instantiated on the first rbd cook only, in
// Node and in a browser bundle alike (bundlers split a dynamic import into its own chunk). The core stays
// host-agnostic: src/core/rbd.ts receives the loaded module as an argument.
import type RAPIER from '@dimforge/rapier3d-compat';

export type Rapier = typeof RAPIER;

let promise: Promise<Rapier> | undefined;
let loaded: Rapier | undefined;

/** Import and initialise Rapier once per process, sharing concurrent callers. A failed load may be retried. */
export function loadRapier(): Promise<Rapier> {
  if (!promise) {
    promise = (async () => {
      const mod: any = await import('@dimforge/rapier3d-compat');
      const R: Rapier = mod.default ?? mod;
      await R.init();
      loaded = R;
      return R;
    })();
    promise.catch(() => { promise = undefined; });
  }
  return promise;
}

/** The module if a previous loadRapier() finished (no I/O, no load). */
export function getLoadedRapier(): Rapier | undefined { return loaded; }
