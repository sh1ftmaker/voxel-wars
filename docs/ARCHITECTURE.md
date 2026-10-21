# Voxel Wars architecture

This is a rewrite of WorldParty's Fort War ("Undermine") on destructible voxel terrain, in the style of Donkey Kong
Bananza. It is a single-player demo first; networking comes later. Keep the world **fast, dynamic and fun**.

`npm run dev` serves on http://localhost:5180 (esbuild watch to `dist/`).
`node tools/shot.mjs <url> <out.png> <waitMs> [js]` takes a headless Chromium screenshot (WebGL2 fallback) and prints
the console. `window.ctx` is exposed for tests. `node tools/test/bench.mjs` benchmarks voxelization and meshing.

## Core data (src/voxel, src/config.js): owned by the lead, extend with care

- `VoxelWorld`: a sparse grid of 32³ chunks. Samples sit on a lattice of `VOXEL` = 0.25 m spacing and hold an Int8
  signed distance (`SDF_SCALE` units per voxel, negative = solid) plus a Uint8 material id (`voxel/materials.js`).
  A uniform chunk has `sdf === null`. API: `get/getMat(ix,iy,iz)`, `sample(x,y,z)` (metres, trilinear),
  `normal`, `materialAt`, `raycast(o, d, max)`, `applyBrush(brush, {op:'carve'|'add'|'paint', mat, hardness})`,
  `extractPadded`, `onChange(fn)`, `writeSamples(patch)`, `setChunks(list)` / `notify(result)` (replica updates);
  `world.remote` / `world.applySamples(patch)` when the terrain worker runs (see below). The world is 160 x 32 x 80 m (chunks x -10..9, y -2..1, z -5..4), with
  unbreakable bedrock at the bottom.
- `brushes.js`: `{min, max, d(x,y,z)}` brushes: `sphere`, `capsule`, `box`, `rock` (faceted crater), `translated`.
- `surfaceNets.js`: a pure mesher over a padded grid of any size, `(nx+2*PAD) x (ny+2*PAD) x (nz+2*PAD)`. It
  outputs positions (local metres), normals, ao, materials and indices.
- `MeshPool.js`: worker pool (`src/workers/mesher.js`). `request(key, extract, dims?)` and
  `meshGrid(sdf, mat, dims) -> Promise<mesh>`.
- `voxelize.js`: fills a world from an SDF. `src/level/fortwar.js` is Twin Forts as an SDF (`Level`, plus `GAME`
  with team spawns and vaults).

## Terrain worker and the frame budget (perf)

Target: 240 fps, so no frame may spend more than ~2-3 ms of main-thread CPU on game, physics or terrain work.

- **The terrain worker owns the world.** `src/workers/terrain.js` runs `TerrainCore` (`src/voxel/TerrainCore.js`,
  pure, also runs in Node): startup voxelization, every brush edit, connectivity and detaching islands, stamping
  rubble back, sample patches, fracture / component splits and body-grid carves. The main thread's `ctx.world` is a
  **read-only replica** (`src/voxel/TerrainSync.js`, `world.remote`), updated from the chunk arrays each reply
  carries (arrays are transferred and recycled), so `sample`, `raycast`, `normal`, `materialAt`, `get` stay
  synchronous. Never write `ctx.world` on the main thread; go through `ctx.destruction` or `world.applySamples`.
- **Edits are asynchronous.** `destruction.carve/blast` return at once with a provisional result (`pending: true`,
  volume of the voxel bodies only) and `result.done`, a Promise of the final result; 'destroyed' / 'detached' and
  `destruction.editHooks` fire when the worker answers (a frame or two later). Without the worker (`?terrainWorker=0`
  runs the same core in-process; `?terrainWorker=sync` is the old synchronous main-thread path) `done` resolves at once.
- **Soft ground / other bakes**: `world.applySamples({ lo, dims, sdf, mat })` (sample box, index x + y*nx + z*nx*ny)
  sends the patch to the worker (`VoxelWorld.writeSamples` there); the replica, meshes and colliders follow. Returns
  a Promise of the reply.
- **Soft ground solver** (`src/soft`): on WebGPU a compute-shader solver (`SoftSim`); on WebGL2 (or `?softCpu=1`) the
  same lattice solved in a worker (`src/workers/softSim.js`, `src/soft/cpuSolver.js`: 60 Hz, 2 iterations, surface
  skin only) whose displacements reach the vertex stage through a float texture (`SoftSimCPU`). `?tets=1` / F7 draws
  the zones' tetrahedra. Zones come in two spacings (per slot: `slotC.y`): near zones (0.5 m cells, ~5 m around:
  punches, landings, impacts, grabs; plastic dirt keeps dents) and far zones (1 m cells, ~12 m around, standing on the
  ground under the impact and a tower's height tall; elastic, at most 2: blasts). A blast heaves its far zone and sends
  rings of upward kicks outward (`blastWave`: ring kicks have an inner radius, `kickC.z`), so a ripple crosses the
  field and walls shudder along their length. Punches drive the surface in along the swing (`carve(..., { dir })`).
  The grab tears the ground: `soft.grab` wakes a zone, `pull` drags the lump's nodes toward the hand every frame for
  0.2-0.6 s (harder matter longer: `Combat.startRip/pullRip/finishRip`, `Arsenal.updateTear`), then the lump comes out
  as a body and `tear` snaps the rim back. Tests: `tools/test/softcpu.mjs` (node: solver cost and motion; `--far`),
  `softview.mjs` (headless WebGL2: screenshots and pixel change of a wake, a blast, `--wall`), `softreach.mjs` (punch,
  blast reach, wall shudder, bridge collapse, grab tear and throw; `--slowtear` for screenshots of the stretch),
  `softgame.mjs` (WebGPU path, SwiftShader).
- **Ground riders** (`src/soft/GroundRider.js`, `?ride=0` off): the soft ground only bends the terrain's drawn mesh, so
  things resting on it ride along visually: every frame (after physics and the game placed meshes, actors and camera)
  props near a live zone sample the displacement at five points under their drawn AABB (weighted by height above the
  ground, or by resting on a lower rider), rest on the highest of that ground (a fitted plane lifted over the support
  points) and tilt with it; actors (bots, remote players) and the local camera take the displacement at their feet.
  CPU solver: `SoftSimCPU.sample` on the texture data; GPU: `SoftSim.gather` (a compute pass over up to 256 query
  points, read back asynchronously). Slots a chunk mesh has baked in are skipped, with a slow release so a landing bake
  never pops. Purely cosmetic and local (not networked). `tools/test/softride.mjs` measures the drawn contact gap.
- **Structural support** (`src/voxel/support.js`, run by the terrain worker after every edit): overhangs that cannot
  carry themselves break off. Cells of 0.5 m; supported = a solid column down to the ground; a hanging cell's lever
  is its horizontal distance to its support through the overhang; past its material's reach (`SPAN`, calibrated so the
  intact level stands) the overhang breaks off about a metre from its support and becomes a body (`reply.islands`
  with `support: true`). Blow out one end of the gorge bridge and it falls in. ~10 ms per edit in the worker. Test:
  `tools/test/support.mjs`.
- **Thrown rocks** stay bodies (`userData.thrown`): a hard hit damages whoever it strikes ('slam') and may crack the
  rock along its soft lattice, never a Voronoi burst.
- **Meshing**: replies carry the dirty chunks' padded mesher windows (no extraction on the main thread); the mesh
  worker post-processes meshes (`src/voxel/meshPrep.js`: material attributes, bounds, collider octants with hashes), so
  the main thread only wraps arrays in a BufferGeometry and box3d builds the octant meshes (budgeted per frame).
- **Brushes are data**: brushes from `brushes.js` carry a `spec` (`brushFromSpec`) and a `radius`; a hand-made
  `{ min, max, d }` brush still works (sampled into a grid brush, `gridBrush`). `ctx.destruction.brushes` exposes them.
- **Physics**: box3d (wasm, single-threaded; `src/physics/box3d/B3.js` over `tools/box3d/bind.c`, built to
  `vendor/box3d/` by `tools/box3d/build.sh` from a pinned commit) stays on the main thread (the character mover needs
  synchronous queries). Its wasm is warmed up at load (`Physics.warmup`), steps run 4 substeps at 60 Hz, voxel bodies
  use few collider boxes (`islands.maxBoxesFor`), and new island bodies are created one per frame. Handles are checked
  in C, so a call on a removed body is a no-op; nothing calls back into JS during a step.
- **Soft debris** (`src/softbody/`, `src/workers/softBody.js`; `bodies.soft`, `?softDebris=0` turns it off): box3d
  keeps each voxel body rigid; on top of it a body-local tet lattice (0.5 m cells, coarser for big bodies, 5 tets per
  cell, shape matching at 60 Hz in one worker for all bodies) bends and jiggles from impacts and blast kicks, and the
  body mesh is displaced in the vertex shader from a float texture atlas (WebGL2 and WebGPU). Hits between the break
  threshold and 8x it crack the lattice instead of the Voronoi shatter (a lattice that holds for 0.4 s after a hit
  over 1.8x is cleaved into 2-3 Voronoi pieces; bodies without a lattice cleave the same way), so thrown lumps and
  falling spans stay physics objects and break into a few pieces: faces break where it bent most, cracks run
  across lattice planes, and when the body comes apart `VoxelBodies.crack` splits the grid by lattice cell (the
  terrain worker's `split` with `cells`); the pieces keep the parent's wobble. Lattices exist only while a body
  wobbles (built at the first kick, asleep when calm). Tests: `tools/test/softbody.mjs` (node: wobble, crack, split),
  `softdebris.mjs` (browser screenshots), `softcrash.mjs`, `softperf.mjs`, `softwgsl.mjs` (WGSL compiles).
- **Structural collapse** (`src/voxel/structure.js`, in the terrain worker after every carve's islands): matter
  that is still attached but hangs (no solid column under it to the bedrock) is judged per hanging component:
  matter within 1.5 m of its support counts as anchored, and each deeper part fails on bending (weight x lever from
  where it meets the anchored band, over that root's section, against the material's strength), reach (further from
  support than the material spans) or floating. A failing part is cut at the band with a jagged lip and comes back in
  `reply.islands` with `collapse { root, dir, reason }`; `VoxelBodies._hinge` starts it turning about the broken root
  with a sag in its soft layer. Only components under the edit's footprint are checked, within 18 m of it (~10 ms in
  the worker). Blowing one end off the bridge drops the span; the untouched level never collapses.
  Tests: `tools/test/structure.mjs` (node: level sweep, bridge, ledges), `collapse.mjs` (browser: bridge, throw).
- **Profiling**: `node tools/profile.mjs "<url>" <seconds> --scenario idle|blasts|topple|dig|game [--cpu] [--under fn]`
  reports frame interval and main-thread CPU per frame (p50/p99/max) with a per-section breakdown. Headless Chromium
  uses SwiftShader (no GPU), so frame intervals and render cost are not representative; main-thread CPU is. Its
  WebGPU device breaks shortly after load (then buffer creation fails); with soft ground on it is lost entirely, so
  add `soft=0` to the URL there. Tests: `tools/test/terrainsync.mjs`
  (worker protocol), `brushbench.mjs` (edit speed, world hash must match), `fracturecost.mjs` and `colliders.mjs` (physics debris cost).

## Net: the edit log (src/net)

Multiplayer plan: the room's sequencer orders terrain edits; the host runs physics and game rules; periodic hash
checks repair drift. Steps 1-2 (this) make every terrain change an entry in one sequenced log:

- `Net` (`src/net/Net.js`, `ctx.net`): local code `submit`s an edit `{ k, ... }`; the transport takes it to the
  `Sequencer` (`src/net/sequencer.js`, pure: runs in a tab now, in a PartyServer Durable Object later), which numbers
  it and sends it to everyone; every client applies edits strictly in seq order through its terrain worker. Kinds:
  `brush` (carve / blast / drill / build / rip with `lift`; islands and structural collapses follow from it
  deterministically in the worker), `stamp` (settled body: the owner's grid at the owner's pose), `samples`
  (soft-ground bakes, host only), transient `bsplit` (a body's fracture, replayed seeded on other clients), `mark`
  (hash check / snapshot point) and `resync`.
- Transports (`src/net/transports.js`, picked in `src/net/index.js`): `LocalTransport` (single player, synchronous:
  nothing changes), `?loopback=latency,jitter` (in-page fake server through the codec), `?room=name`
  (`PartyTransport`: a WebSocket to the room server, `server/`, reconnecting; `?server=` picks another server),
  `?room=name&local=1` (`BroadcastChannelTransport`: tabs of one browser; the tab holding the room's Web Lock hosts
  the sequencer).
- Room server (`server/src/index.js`): one PartyServer Durable Object per room runs the same `Sequencer`, relays game
  messages, persists the log and the host's snapshot in DO storage (a room idle 30 min starts over), elects the
  oldest client host and passes hosting on when it leaves, rate-limits edits and caps message sizes. A reconnecting
  client re-joins with the last seq it saw and gets the log after it (or the snapshot).
- Codec (`src/net/codec.js`): versioned; JSON (doubles round-trip exactly) plus raw typed arrays, deflated when large.
- Determinism: edits carry everything (brush specs with their seeds, grids, patches, `erode`); the worker's islands,
  collapse and fracture use no clock or `Math.random` (Voronoi sites from `rng(seed)`, seed from the body's id).
  Body ids are the same everywhere (`seq:island`, `seq:rN`, `parent.fN` / `.cN`); only a body's owner (host for
  shed terrain, the ripper for a lump) stamps or fractures it. Body motion is not stepped in lockstep yet (box3d itself is
  deterministic across platforms for the same call sequence), so other clients
  keep simulating their copies until the owner's stamp drops them (transform streaming is step 4).
- Drift: the host marks a hash check every 3 s when something changed; at that point of the order every client hashes
  its chunks (FNV-1a, cached per chunk version: ~0.1 ms) and compares with the host's; differing chunks are resent
  (`resync`, applied at its own point of the order). Late join: the host snapshots the chunks that differ from the
  generated level (every 30 s / 200 edits, ~100-200 kB deflated); the sequencer drops the log up to it; a joiner loads
  the level, the snapshot, then the log tail (history: no FX, no bodies).
- Limits: a background tab gets no animation frames, so a host tab in the background runs no physics or bots (it
  still sequences, applies edits and makes snapshots); a late joiner does not get the bodies that are loose when it
  arrives (they appear in the terrain when their owner stamps them).
- Tests: `tools/test/netlog.mjs` (node: two TerrainCores, codec, snapshot join, resync), `tools/test/netroom.mjs`
  (browser: two tabs, a late third, drift repair, single player), `tools/test/netperf.mjs` (single-player cost),
  `tools/test/mp.mjs` (three players through a room server: below).

## Online game (src/game/NetGame.js)

Steps 3-4: everything else in the match, as plain messages (`net.bcast` / `net.direct`, not sequenced). The header of
`NetGame.js` lists them; in short:

- Every client simulates its own player (the host also its bots) and streams it at 25 Hz; other clients draw it as a
  `RemoteActor` (`src/game/RemoteActor.js`) 100 ms behind the owner's clock (interpolated), with a kinematic capsule so
  rays, rockets and bodies hit it, and a name label.
- The host keeps the roster (teams balanced on join, bots fill both teams), health (damage claims `hit` from whoever's
  weapon hit; the host answers `hp`, deaths, respawns), the crates (`Crates.authority`), the clock and the score, and
  sends it all in `game` once a second (the server keeps the last one for late joiners).
- Rockets and bombs are actions: other clients fly visual copies (`Combat { visual }`); explosions, terrain and damage
  come from the owner. Effects and sounds of local events are mirrored (`ev`).
- Bodies have an owner (VoxelBodies `owner`; crates and others: host); owners stream moving bodies at 15 Hz, others
  steer their copies toward it (`blendBodies`: a spring on velocity, held bodies kinematic). Grabbing claims a body;
  a thrown one goes back to the host at rest. Lockstep (box3d is deterministic) would need the same inputs at the same
  ticks on every client and the full physics state for late joiners, so owners stream instead.
- Host migration: the next client takes over the bots where they stand, orphaned bodies, the crates and the clock.
- Single player creates no `NetGame` (`game.netGame` is null): every hook is a no-op.

## Context (src/main.js)

`ctx = { renderer, scene, camera, sun, world, terrain, physics, destruction, params, net, events, addSystem }`.
A system is an object with an optional `update(dt)`, called each frame after `physics.step`. Add yours in
main.js under "game systems are added here", one line each. `ctx.params` holds the URL query
(`?fly=1` etc.).

## Module ownership (parallel work: only edit files you own; main.js only additively)

| Area | Owner | Files |
|---|---|---|
| Rendering and meshing quality | render agent | `src/render/*`, `src/voxel/surfaceNets.js`, `src/workers/mesher.js` |
| Physics, connectivity, detached chunks | physics agent | `src/physics/*`, `src/voxel/islands.js`, `src/voxel/VoxelBody.js` (new) |
| Gameplay, player, weapons, Fort War rules, HUD, FX, audio | game agent | `src/game/*`, `src/ui/*`, `src/fx/*`, `src/audio/*`, `index.html` |

## Contracts between modules

- **Changing matter** always goes through `ctx.destruction` (`src/physics/Destruction.js`): `carve(brush, opts)`,
  `blast(center, radius, opts)`, `rip(center, radius)`. Gameplay never calls `world.applyBrush` directly, so
  detached-chunk handling, body carving and events stay in one place.
- **Events** on `ctx.events` (a `CustomEvent` with the data in `detail`):
  - `destroyed` `{ center, box, removed (Float64Array m³ per material id), volume, author, kind }`: drives VFX, SFX,
    score and crystals
  - `detached` `{ prop, volume, mat }`: a terrain piece became a body
  - `impact` `{ point, speed, mat, prop }`: a body hit something hard (physics emits it; FX and SFX listen)
  - game events (`score`, `pickup`, `damage`, ...) are defined by the game agent in `src/game/`.
- **Physics** (`src/physics/Physics.js`, box3d): `addBody`, `removeBody`, `raycast`, `explode`, `propOf`,
  `onStep`, `onHit` (hit events: approach speed and point), `createBody`, `b3` (the B3World) and `BodyType`. Gravity
  is 30 m/s². Terrain is one triangle mesh per chunk octant, rebuilt from every new chunk mesh
  (`terrain.onChunkMesh`). Players and bots move with box3d's capsule mover (`B3World.move`: collide, solve planes,
  cast) in `src/game/CharacterBody.js`, with ground snapping, a step-up over ledges and a mantle hop.
- **Rendering**: `TerrainRenderer` (chunk meshes), `geometryFromMesh(mesh)` and `createTerrainMaterial()`.
  Detached bodies use the same mesher and material, so they look like the terrain they came from.

## Material ids
0 Stone, 1 Dirt, 2 Grass, 3 Sand, 4 Snow, 5 Brick, 6 Metal, 7 Lava, 8 Red Stone, 9 Blue Stone, 10 Wood, 11 Cobble,
12 Dark Rock, 13 Bedrock (see `src/voxel/materials.js` for hardness, density and textures).
