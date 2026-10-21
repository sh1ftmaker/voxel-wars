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
  the zones' tetrahedra. Tests: `tools/test/softcpu.mjs` (node: solver cost and motion), `softview.mjs` (headless
  WebGL2: screenshots and pixel change of a wake, a blast, `--wall`), `softgame.mjs` (WebGPU path, SwiftShader).
- **Meshing**: replies carry the dirty chunks' padded mesher windows (no extraction on the main thread); the mesh
  worker post-processes meshes (`src/voxel/meshPrep.js`: material attributes, bounds, collider octants with hashes), so
  the main thread only wraps arrays in a BufferGeometry and Rapier builds the octant trimeshes (budgeted per frame).
- **Brushes are data**: brushes from `brushes.js` carry a `spec` (`brushFromSpec`) and a `radius`; a hand-made
  `{ min, max, d }` brush still works (sampled into a grid brush, `gridBrush`). `ctx.destruction.brushes` exposes them.
- **Physics**: Rapier stays on the main thread (the character controller needs synchronous queries). Its wasm is
  warmed up at load (`Physics.warmup`), the solver runs 2 iterations, voxel bodies use few collider boxes
  (`islands.maxBoxesFor`), and new island bodies are created one per frame.
- **Profiling**: `node tools/profile.mjs "<url>" <seconds> --scenario idle|blasts|topple|dig|game [--cpu] [--under fn]`
  reports frame interval and main-thread CPU per frame (p50/p99/max) with a per-section breakdown. Headless Chromium
  uses SwiftShader (no GPU), so frame intervals and render cost are not representative; main-thread CPU is. Its
  WebGPU device breaks shortly after load (then buffer creation fails); with soft ground on it is lost entirely, so
  add `soft=0` to the URL there. Tests: `tools/test/terrainsync.mjs`
  (worker protocol), `brushbench.mjs` (edit speed, world hash must match), `fracturecost.mjs` (Rapier debris cost).

## Context (src/main.js)

`ctx = { renderer, scene, camera, sun, world, terrain, physics, destruction, params, events, addSystem }`.
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
- **Physics** (`src/physics/Physics.js`, Rapier 0.21): `addBody`, `removeBody`, `raycast`, `explode`, `propOf`,
  `onStep`, `R` (the RAPIER module) and `rw` (the RAPIER.World). Gravity is 30 m/s². Terrain is one trimesh
  collider per chunk, rebuilt from every new chunk mesh (`terrain.onChunkMesh`).
- **Rendering**: `TerrainRenderer` (chunk meshes), `geometryFromMesh(mesh)` and `createTerrainMaterial()`.
  Detached bodies use the same mesher and material, so they look like the terrain they came from.

## Material ids
0 Stone, 1 Dirt, 2 Grass, 3 Sand, 4 Snow, 5 Brick, 6 Metal, 7 Lava, 8 Red Stone, 9 Blue Stone, 10 Wood, 11 Cobble,
12 Dark Rock, 13 Bedrock (see `src/voxel/materials.js` for hardness, density and textures).
