# R-17: pre-release correctness review

Scope: the code merged on 2026-10-12/13 that the brief lists (particles, rbd + Rapier loader, XPBD cloth, scatter
kernels, user-code guard, expression sandbox, Node host and pool, SAH BVH, `remesh_quad` and `sdf_grid` adapters, PCG
CSV after 8ae9ec6). Base `3289c6b`; branch `worktree-agent-a52c620fa7e63c5b7`, `main` (a0a9622) merged before the
final gates. Every fixed finding has a test that fails without the fix (the hang in F2 fails by hanging; its repro
below runs under `timeout`). Goldens are unchanged: no fix changes the output of a graph that cooked before.

Severity: **High** = a graph can hang or crash the process, or cook a wrong result silently; **Medium** = a spurious
failure, or an export the consumer rejects; **Low** = validation or consistency gaps with a narrow trigger.

## Findings

| id | where (at 3289c6b) | severity | status | summary |
|---|---|---|---|---|
| F1 | src/core/particles.ts:660, 672, 699 | High | fixed 95e5812 | refused births looped one by one (hang on a large `emit_rate`); the refused count wrapped at 2^31 |
| F2 | src/host/node.ts:215, 217 | High | fixed 5666c03 (+674710a typing) | `runGuardedAsync` read and called the script promise's `then` outside the time limit: a replaced `Promise.prototype.then` hangs the process |
| F3 | src/host/pool.ts:179 | Medium | fixed 6bad69d | a task retried after "shared data missing" went by key only and failed when another worker that had also dropped the key took it |
| F4 | src/io/points.ts:132, 145 | Medium | fixed 40121ea | PCG CSV: attributes named exactly `Seed`/`Name`/`Density` (and `Position` in the flat layout) repeat a column; `name` + `NAME` both become `name_attr`; `constructor` looked up through `Object.prototype` |
| F5 | src/graph/params.ts:200 | Low | fixed 8201263 | numeric strings were not checked for finiteness (`"Infinity"`, `"1e999"`), unlike numbers; `resample {count: "Infinity"}` crashed the process (heap OOM) |
| F6 | src/core/particles.ts:564 | Low | fixed 017c647 | an SDF field whose bounds overflow the sampling grid gave NaN velocities on every particle |
| N1 | src/host/node.ts:98-102; src/core/wrangle.ts:353, 360 | High | not fixed (documented gap, R-13) | the engine assigns realm globals `__job` / `__cur`: a script that defines a setter for them hangs the process |
| N2 | src/nodes/code.ts:183 | High | not fixed (documented gap, R-13) | `res instanceof Geometry` on a Proxy a script returns runs its trap outside the time limit |
| N3 | src/core/particles.ts:646; src/nodes/particles.ts:211-238 | Medium | not fixed | births per run are not capped (max_particles caps live particles): high rate × short life × many steps exhausts the heap |
| N4 | src/nodes/curves.ts:303 and other unbounded int params; src/nodes/rbd.ts:92; src/nodes/cloth.ts steps × substeps × iterations | Medium | not fixed | resource exhaustion: huge finite counts crash the process (fatal OOM), long simulations have no time limit |
| N5 | src/core/rbd.ts:553; src/nodes/rbd.ts:112, 117 | Low | not fixed | an exception inside the `RbdSim` constructor leaks its Rapier world |
| N6 | src/nodes/rbd.ts:85 | Low | not fixed | `ground_plane: auto` adds the ground when input 1 is connected but has no triangles; the param says "only when input 1 is not connected" |
| N7 | src/core/rbd.ts:607 | Low | not fixed | body order rounds origins to 1e-6 m and breaks ties by input index: permuting coincident pieces of different shapes changes the result |
| N8 | src/io/points.ts:438 | Low | not fixed (design) | the CSV reader keeps the `_attr` suffix: a topotopo round trip turns `name` into `name_attr` (since 8ae9ec6) |
| N9 | src/host/pool.ts:183; src/host/worker.ts:70 | Low | not fixed | a `transfer: true` task with shared data would retry with detached arrays (no caller combines them) |
| N10 | src/core/kernels.ts:293 | Low | not fixed | `hashArrays` (64-bit, non-cryptographic) keys worker-cached shared data: a collision would reuse another job's data |
| N11 | src/core/particles.ts:689 | Low | not fixed | particle `id` is int32: wraps after 2^31 births in one simulation |
| N12 | src/core/xpbd.ts:109; src/nodes/cloth.ts:69 | Low | not fixed | point-pair keys are exact only below 2^26 points (`max_points` has no upper bound) |
| N13 | src/graph/engine.ts:1146 | Info | not fixed | the engine's finite check resets only P; NaN in v, packedXform and other attributes passes downstream |

## Fixed

**F1. particles: refused births (High).** `emitSteps` counted a refused birth per loop iteration, so an `emit_rate` far
above `max_particles` cost one iteration per refused birth: `{steps: 2, emit_rate: 1.2e9, max_particles: 10}` took 6-9 s,
`emit_rate: 1e12` would run for hours (an MCP server hangs). The count was an int detail and wrapped: the warning read
`-1894967306 births were refused`. Now the rest of a point's births in a step are refused at once (no slot frees within a
step) and `__pskipped` is a float. Test: test/particles.ts, section max_particles (2,399,999,990 refused births counted in
~0 ms).

**F2. script promise subscribed outside the time limit (High).** After the first timed call, `runGuardedAsync` did
`typeof res.then` and `res.then(...)` on the script's promise. `then` is looked up on the scripting realm's
`Promise.prototype`, which scripts can replace, so

```js
Promise.prototype.then = function () { while (true) {} };
return geo;
```

hung the process for good (repro: a `script` node with that code, engine `scriptTimeoutMs` 500, was still running when
`timeout 30` killed the process, exit 124; an in-process watchdog timer never fired). The lookup and the subscription
now run inside the timed call; the handlers are engine-realm
functions, so they still run in the main queue. The poisoning script and every later script in that realm fail with
`script exceeded N ms`. Test: test/fuzz.ts, "poisoned Promise.prototype.then" (a looping `then`, a looping `then`
getter, a `then` that never calls back; each poisoning script and a later plain script). This is the class R-13 left
open as "the vm realm is not a security boundary"; N1 and N2 below are the remaining members.

**F3. pool retry of evicted shared data (Medium).** Workers keep 8 shared keys (LRU), while each slot's list on the main
thread keeps every key it ever sent. A task sent by key to a worker that had dropped the data is retried once
(`job.resent`), but the retry was again sent by key if the next worker's list had the key; if that worker had dropped it
too, the task failed with `kernel "x" failed: shared data "K" missing in the worker`. The retry lands on another worker
when a worker earlier in the slot list is idle at that moment (concurrent jobs, or a job with fewer chunks than workers,
e.g. a long particle run over few particles, or `TOPOTOPO_POOL_MIN=1`), so in practice a rare, timing-dependent node
failure that only happens with the pool on. A retry now always carries the data. Test: test/pool.ts (two workers both
drop K; the K task, slowed by a 40 MB array, goes to the second worker while the first finishes a task; 3 of 3 rounds
failed before the fix).

**F4. PCG CSV repeated columns (Medium).** 8ae9ec6 suffixed attributes named like a standard column in another case, but
not exact names: a point attribute `Seed` was written as a second `Seed` column (likewise `Name`, `Density`, and
`Position.x/y/z` next to `Position.X/Y/Z` in the flat layout), which the TopoTopoPCG loader on `main` rejects
("Duplicate CSV column"), and the topotopo reader dropped those attributes on re-import. Two attributes differing only in
case (`name`, `NAME`) both became `name_attr`. The table was indexed through `Object.prototype`, so `constructor` became
`constructor_attr`. Now every attribute named like a standard column gets `_attr` (except the instance stream's own
`Mesh`), a column that would still repeat one gets another suffix, and only the table's own keys count. A lone `name`
is still `name_attr` (8ae9ec6's case). Test: test/interop.ts after the struct-cell round trip (flat and struct layouts).

**F5. non-finite numeric strings (Low).** `coerce` rejected a non-finite number but accepted `"Infinity"`,
`"-Infinity"` and `"1e999"`, which is how such a value arrives in JSON (graph files, MCP). `resample {mode: count, count:
"Infinity"}` ran the process out of heap (fatal error, exit 134); `box {size: ["Infinity", 1, 1]}` cooked with a warning.
They now fail the param like non-finite numbers (`param "count" expects an integer, got "Infinity"`). Large finite
values are still accepted (N4). Test: test/engine.ts, section param coercion.

**F6. particles SDF field bounds (Low).** `fieldFrom` samples an SDF field on a grid over its bounds padded by a half;
bounds whose padded extent overflows (`sdf_shape {shape: sphere, radius: 1e308}` as the field input) made the grid size
and origin NaN, and the cook succeeded with `v = NaN` on every particle (P reset to 0 by the engine's finite check, with
a warning). The node now fails with `the field's SDF volume "sdf" cannot be sampled: its bounds … are too large`. Test:
test/particles.ts, fields and forces.

## Not fixed

**N1, N2 (High, documented in WORKLOG R-13 as open).** Both still hang the process:
`Object.defineProperty(globalThis, '__job', { set() { for (;;) {} }, configurable: true }); return geo;` (the engine's
`realmGlobal.__job = undefined` after the timed call runs the setter) and
`return new Proxy(geo, { getPrototypeOf() { for (;;) {} } });` (`instanceof` runs the trap). Both repros exit 124 under
`timeout 20`. `__job` can become a lexical binding set through a realm closure, as the expression realm already does
(`exprCtx` in src/host/node.ts); `__cur` is read by the snippet library as a global property, so it needs the same change
there. Proxy returns need a host-level check (`util.types.isProxy`), i.e. a Host API addition. Left for a follow-up
because R-13 decided to keep them in the documented gap.

**N3 (Medium).** `max_particles` counts live particles. A run of steps materialises every birth of the run before
integrating it (`emitSteps` arrays, then one state geometry), so a high rate with a short life over many steps (for
example 1e4 per step from 100 points over 1,000 steps with `life: 0.01`: every slot frees within a step or two, so
several hundred million births land in one run) exhausts the JS heap and kills the process instead of failing the node. Not run to completion (it takes the process down); the count follows from
the code. A cap on births per run (a NodeError past, say, 50 million) would turn it into a node error.

**N4 (Medium).** Resource exhaustion in general: int params without an upper bound that size allocations crash the
process with a fatal OOM for large finite values (`resample {count: 1e15}`), and simulations have no time limit
(`rbd_stack` runs `(pieces − 1) × interval + duration × rate` steps, up to ~10^10 within the param bounds; `drape` steps
× substeps × iterations up to 10^9 sweeps). The README's Security section says code can burn memory and CPU; a per-cook
budget would be the general fix.

**N5 (Low).** `new RbdSim` creates the world first and the colliders after; an exception in between (the trimesh
fallback at src/core/rbd.ts:602, or a static piece's trimesh collider in `addBody`, are not guarded) would leak the WASM
world, since the node constructs the sim outside its `try`. I could not make Rapier throw: NaN and 1e300 instance scales cook (NaN packedXform out, warning), and
later rbd cooks in the same process are unaffected.

**N6 (Low).** `ground_plane: auto` is coded as "no static triangles", documented as "input 1 not connected": a collision
input with only points or SDF volumes gets a ground plane at y = 0 (with the SDF note). The code's behaviour is the
friendlier one; the param text should say so.

**N7 (Low).** Bodies are inserted in the order of their origins rounded to 1e-6 m, ties by input index, and the jitter
is seeded by that rank. Pieces at the same position (rbd_stack's use case, "give every crate the same position") are
therefore ordered by input index: permuting coincident pieces of different shapes changes the result. Identical pieces
give the same set of results.

**N8 (Low, design).** The topotopo CSV reader keeps `name_attr` as the attribute name, so exporting and re-importing
PCG CSV renames `name` since 8ae9ec6; Unreal sees `name_attr` too. Mapping `<canonical>_attr` back would need the
writer to escape attributes that are literally named `<canonical>_attr`. Left to the orchestrator.

**N9-N13 (Low/Info).** See the table. N9 is an API trap (no caller uses `transfer` with shared data). N10 would need two
different shared payloads with equal 64-bit keys inside one worker's 8-entry cache. N11 needs 2^31 births in one
animated simulation. N12 needs more than 67 million cloth points. N13: the engine resets non-finite P to 0 with a
warning, other attributes keep NaN.

## Checked and could not break

- **particles**: pool parity on 10 edge cases (no emitter points, zero-area collider, `use_pscale` with pscale 0, a
  sphere resting on a grid, IDW field over coincident points, tiny life with trails, attract to a missing surface, fps
  0.001, packed emitter, float ids): pool off and a forced 3-worker pool give the same bits, no NaN in any output
  attribute. `deathStep`'s loops start within a step of the answer; `knnInto`'s fixed stack is far above the tree depth;
  trail ring slots and ages agree with `ageAt`; `emitSteps` and `compactState` never write into a cached state
  (clone/merge copy every array); the per-frame chain includes params and input signatures.
- **cloth (xpbd)**: coincident points (zero rest length), a single triangle, polylines only, points only with self
  collision, thickness 0 against a box, a zero-area collider, all points pinned, all stiffnesses 0, non-positive `mass`
  attributes, pins far from the cloth, `inflate` on open and flat two-sided meshes: all cook, finite, pool-identical.
  Degenerate hinges and stencils are dropped at build time (NaN/Infinity filtered); chain pivots stay positive (the
  system is SPD, inactive links get a decoupled row); colouring and the bend Map iterate in insertion order.
- **rbd / Rapier**: flat, single-point and line pieces, coincident stack drops, sphere shapes, mesh shape on a moving
  piece, zero-scale and mirrored instances, NaN and 1e300 instance scales, animated stack; `castShape` frees its raw
  shapes, the scratch world is freed in `finally`, animated worlds are an LRU of two. `loadRapier` writes nothing to
  stdout (the MCP channel), and a failed load can be retried.
- **scatter kernels**: list alignment of `elimListsRange` and the conflict lists with chunk order, NaN weights in the
  elimination heap, the dense fallback, relaxation of coincident points.
- **expression sandbox**: the straight-line classifier admits no braces, semicolons, function literals, method calls or
  templates, so untimed expressions cannot loop or leave their wrapper (also in the precompiled batch); the memo is
  sound (frozen realm, copied vars, `Math` reads are never memoised).
- **usercode / checkSyntax**: thrown values are read inside the limit; host errors only by `message`; `checkSyntax`
  parses a body on its own (`vm.compileFunction`), so a stray `}` cannot close a wrapper.
- **SAH BVH**: `-0` ray components (`invDir`), NaN slab products, the depth bound (SAH to depth 48, then median splits),
  `closestOnTri` on degenerate triangles (a NaN distance never wins).
- **remesh_quad / sdf_grid adapters**: provenance index bookkeeping, `MAX_GRID_SAMPLES`, finite checks in
  `gridFromImplicit`, scripted fields sampled under the limit.
- **host boundary and determinism**: no Node APIs in src/core, src/graph, src/nodes, src/io, src/wasm; `Date.now` only
  for time limits; no `Math.random`; Unreal centimetres and Z-up only in src/io/points.ts and the exporters.

## Gates

On the branch after merging `main` (a0a9622), Windows 11, Node 24.14: `npm run typecheck` exit 0; `npm test` exit 0
(1,895 PASS lines, no FAIL; golden 290/290 unchanged, property 0 failed, fuzz layers 0 failed including the new
poisoned-`then` layer, examples 222/222, particles 76/76, pool 79/79, interop all passed, engine 111/111); `npm run
showcase` exit 0 with `examples/renders/*.png` byte-identical (`git status` clean). Baseline before any change (3289c6b):
the same gates green.
