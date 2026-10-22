# Granular ground: PB-MPM sand, dirt, snow and lava (src/mpm)

Blast or undercut a dune, a berm or a snow cap and the ground that can no longer hold pours, avalanches and slumps,
then settles back into ordinary, diggable voxel terrain. Turn it on with **`?mpm=1`**. It is off by default, and
the edits are then exactly as on main.

The simulation is **PB-MPM**: Chris Lewin, *A Position-Based Material Point Method*, SIGGRAPH 2024 Talks (EA SEED),
<https://doi.org/10.1145/3641233.3664323>. Our solver is a 3D port of EA's 2D WebGPU reference
(github.com/electronicarts/pbmpm, BSD-3, `shaders/g2p2g.wgsl`). The transfers are MLS-MPM/APIC (Hu et al. 2018) with
quadratic B-splines. The plasticity is Drucker-Prager for sand (Klár et al. 2016), Stomakhin et al. 2013 for snow,
and a volume-preserving viscoplastic clamp for lava, all as in the reference.

## Where to see it

The red side is listed below; the blue side is the mirror image (x → -x).

| Spot | Where (m) | What happens |
|---|---|---|
| Sand dunes | (-14, 0.5, -17) and (-30, 0.5, -17.5) | Blast the crest and the dune caves into the crater and spreads. Blast the toe and the flank above fails up the slope. |
| Dirt berm | (-14, 0.5, 9.3), beside the trench | The blast's lip slumps into the crater. Dirt is cohesive, so dug walls and tunnels hold. |
| Snow caps on the north crags | for example (-21, 8.7, 25), (-58, 8.5, 27) | A cap's edge pours over the cliff in a stream; the rest slumps into the crater. |
| Lava basins | (±24, 4.6, -33.5) | A thick paste that slumps (thin basins, so a small effect). |

Keys (with `?mpm=1`): **V** starts an avalanche at the crosshair, turning the free-flowing surface layer within
2.2 m into grains with no crater. On a slope it slides. **F6** logs `ctx.mpm.summary()`.

## How it works

1. **The edit carries grain options.** `destruction.grainsFor(brush, { kind, impulse })` is set by `Mpm`. When the
   carve is near granular matter, it adds `grains: { c, r, blast }` to the brush edit. A blast checks for any
   granular matter; a dig checks only for free-flowing matter.
2. **The terrain worker cuts the grains out, deterministically** (`grains.js selectGrains`, in
   `TerrainCore.brush` after the carve and before connectivity). A granular sample goes when any of these holds:
   - it is in the blast's lip (within r + 0.5 m, the top half metre);
   - its surface is steeper than its material's friction angle + 5°;
   - it faces down (undercut).

   This repeats for up to 10 passes on the newly exposed surface (**progressive failure**), so cutting a dune's toe
   takes the flank above it. Whatever hangs above an undercut sample goes with it. The pick is capped at the 2048
   samples nearest the edit. Only **flowing** materials (sand, snow) follow the slope rules on any carve. **Cohesive**
   materials (dirt, grass, lava) only lose a blast's lip and the steepest of what that exposes (2 passes), so tunnels
   and dug walls in the field hold. The chosen samples are carved out of the SDF by a grid brush in the same edit,
   and the reply lists them as `reply.grains { idx, mat, frac }`. Every client's worker does the same at the same
   point of the edit order.
3. **Every client simulates them, locally and cosmetically.** `Mpm` turns each grain sample into up to 8 particles,
   jittered in its cell; a part-solid surface sample gets fewer. Blasts add a kick. The particles go into a **zone**:
   - a dense grid of 48 × 32 × 48 nodes at 0.25 m (12 × 8 × 12 m) on the voxel lattice;
   - 4 zone slots, at most 16,384 particles per zone on the GPU and 6,144 in all on the CPU;
   - grains landing inside a live zone join it.

   Grass is released as dirt.
4. **Settle and deposit (host only).** Every 12 frames a small readback gives each zone's particle count and how
   many are still moving (`statsPass`, 8 integers). A zone is at rest once fewer than 3% of its particles have moved
   in the last 20 steps (below 0.12 m/s), three readbacks in a row; it is also forced after 14 s. The host then:
   - reads that zone's particle positions back once;
   - drops grains held up by the zone's walls straight down onto the terrain;
   - builds a **deposit** (`depositPatch`) and submits it as a `'deposit'` edit.

   The deposit is a hybrid that keeps the matter's volume:
   - **Dense matter:** where the trilinear occupancy reaches half a voxel, it is written where it lies (a pile, a
     clump, a sheet of snow on a cliff).
   - **The rest** (thin films, single grains, over-packed matter) is summed per lattice column, spread over its
     neighbours, and stacked as a heightfield on the surface under each column. It never goes into a wall, and it
     is dropped where there is nothing under it within 3 m.
5. **Every client applies the deposit in order** (`TerrainCore 'deposit'`, `applyDeposit`: a union, so a sample only
   gets more solid). Each client then drops its particles of the zones listed in the edit's `seqs` once the chunks
   have been remeshed.

### Multiplayer

The terrain stays host-authoritative, and the simulation is cosmetic and local. I chose the **edit log**
(`src/net`), not `NetGame` messages:

- **Grain selection.** Grains are selected inside the brush edit by the terrain worker, so every client removes
  exactly the same voxels at the same point of the order. `mpm.mjs` checks two cores for identical chunk hashes.
- **Determinism.** The selection has no clock and no randomness. Particle seeding, which is local, may use
  `Math.random`.
- **Deposits.** Only the host deposits, and its deposit is an ordinary sequenced edit. That edit carries everything
  (column volumes, the dense grid) and is applied by the same pure function everywhere. So settled sand cannot
  diverge between clients, hash checks keep passing, and late joiners replay it like any other edit (snapshots
  included).
- **Clients' piles.** A client's own piles may differ a little from the host's until the host's deposit replaces
  them. Clients never deposit. A settled zone waits up to 20 s for the host's deposit, then goes.
- **Host migration.** A client that becomes host deposits its waiting zones at its next stats readback.
- **Host without the simulation.** With `?mpm=0`, no free zone, or the CPU cap reached, the host deposits grains
  straight back where they were, so the terrain never loses matter. A client that runs `?mpm=1` against a host that
  doesn't still gets its grains back that way.
- **Why not NetGame.** Streaming particles through `NetGame` would cost bandwidth for something cosmetic, and would
  still need an edit to change the terrain.

### The solver (PB-MPM)

Every frame (60 Hz, `substeps` = 1 by default) runs `iterations` times:

1. **Constraint projection:** drive the candidate deformation gradient F\* = (I + D) F towards the material's target
   (see below).
2. **P2G:** APIC momentum m (d + D (x_i − x_p)) and mass, with fixed-point i32 `atomicAdd` (scale 2^20, range ±2048),
   because WebGPU has no float atomics.
3. **Grid update:** displacement = momentum / mass, then the boundary conditions.
4. **G2P:** d = Σ w d_i and D = 4 Σ w d_i (x_i − x_p)ᵀ.

Then **integrate**:

- F = (I + D) F, followed by the SVD and the plasticity (below);
- x += d, after a CFL clamp (`maxStep` cells per step);
- push particles out of the terrain;
- add gravity to d for the next step (d is the next step's candidate displacement).

Units are grid cells.

| Model | Constraint (per iteration) | Plasticity (per step, on the SVD of F) |
|---|---|---|
| Sand (sand; dirt and grass with a higher friction angle) | target U Σ' Vᵀ with Σ' = clamp(Σ, 1, e^cohesion) while logJp = 0 (sand resists compression, not tension), blended with F\*/det^⅓; then a viscosity that damps D's symmetric part | Drucker-Prager return mapping in log strain with logJp volume memory (the reference's branch). Σ ≥ `minStretch` (0.8): a hard landing compacts instead of storing a rebound |
| Snow | corotated: target R = U Vᵀ blended with F\*/det^⅓; relaxation × Stomakhin hardening e^{ξ(1 − Jp)} (capped at 1) | Σ clamped to [1 − θc, 1 + θs]; the plastic part goes into Jp; packed snow (Jp = 0.6) compresses no further |
| Lava (paste) | like snow, with a high viscosity | Σ clamped to [e^−y, e^y], then rescaled to keep the volume (the reference's visco branch) |

- **SVD.** 3×3 SVD through 4 cyclic Jacobi sweeps on FᵀF, with U built by Gram-Schmidt from F V. Scalars in JS,
  unrolled TSL on the GPU.
- **Boundary conditions at the nodes:**
  - **Terrain:** the zone samples the terrain's SDF once into a node field (normal, distance). A node within a cell
    of the surface may not move into it, and Coulomb friction (μ = the zone material's `wall`) acts on the
    tangential part. Nodes deeper than 1.5 cells are fixed.
  - **Zone walls:** no motion out through them, with friction along them.
  - **Bodies and the player:** up to 8 spheres per frame push the material out at their velocity (one-way).
- **Stability.** With 3 iterations PB-MPM stays stable at the full 1/60 s step. The 4 m-drop and wall tests stayed
  bounded once the CFL clamp and `minStretch` were in.

## Backends and rendering

- **WebGPU:** `MpmGPU` is the solver in TSL compute.
  - **Kernels per frame:** `p2gFirst`, then (`grid`, `g2pP2g`) × (iterations − 1), then `grid`, `g2pIntegrate`.
    That is 7 dispatches at 3 iterations.
  - **Extents:** dispatches cover only the slots in use.
  - **Readback:** none per frame, except the 8-integer stats every 12 frames and one position readback per deposit.
- **WebGL2, or `?mpmCpu=1`:** `MpmCPU` runs the same algorithm (`cpuSolver.js`) in a worker (`src/workers/mpmSim.js`).
  - Capped at 6,144 particles, with 2 iterations.
  - Up to one step in flight: if the worker falls behind, the grains move in slow motion and the frame doesn't
    stall.
  - The worker returns world positions for the draw.
- **Rendering** (`GrainRenderer`): **one draw call** for all grains.
  - **Shape:** an 8-triangle, rounded-shaded octahedron per grain, randomly squashed and turned.
  - **Colour:** the material's own terrain texture (the terrain's texture array, sampled from above at the grain's
    spot) times its tint, with ±15% brightness per grain. Lava glows.
  - **Depth:** depth-tested and depth-written.
  - **GPU path:** reads the particle buffer in the vertex stage.
  - **CPU path:** an instanced attribute, with each particle drawn as up to 8 grains (attribute divisor 8), so the
    fallback pours as finely as the GPU path.

## Knobs

`ctx.mpm.knobs`; URL `?mpmIters=N`, `?mpmSub=N`.

| Knob | Default | Effect |
|---|---|---|
| `iterations` | 3 (CPU: 2) | PB-MPM solve iterations per substep. Fewer looks softer (unconverged); each one is roughly one explicit MPM step of work |
| `substeps` | 1 | substeps per 60 Hz frame |
| `relaxScale` | 1 | multiplies every material's relaxation (the stiffness knob; a relaxation past ~1 per iteration diverges, so snow's hardening is capped at 1) |
| `maxStep` | 1 | CFL clamp: cells a particle may move per step (15 m/s at 60 Hz) |
| `restSpeed`, `restFrames` | 0.12 m/s, 20 | when a particle counts as at rest |

Per material (`src/mpm/params.js GRANULAR`):

- **Common:** `model`, `friction` (deg; also the slope rule), `relax`, `visc`, `alpha` (shape vs volume target),
  `wall` (terrain friction), `density`, `minStretch`, `flow` (free-flowing or cohesive).
- **Sand:** `cohesion`.
- **Snow:** `thetaC`, `thetaS`, `xi`.
- **Lava:** `yield`.

Module constants: `ZONE_DIMS`, `MAX_ZONES`, `PER_ZONE`, `CPU_CAP`, `FIXED`, `MAX_PROXIES`.

## Budgets and measurements

These were measured on the dev machine (RTX 4090, Chromium 154, Node 22).

**GPU compute per frame** at 3 iterations (`tools/test/mpmgpu.mjs`: three.js's WebGPU backend on Dawn in Node, on
the 4090, with timestamp queries):

| Particles | GPU ms per frame (median, max) |
|---|---|
| 8k | 0.105–0.131 (0.131) |
| 16k | 0.18–0.22 (0.24) |
| 32k (2 zones) | 0.30–0.32 (0.38–0.50) |
| 64k (4 zones) | 0.55–0.59 (0.66–0.89) |

- P2G atomics are about 85–90% of that at 64k.
- Workgroup-tiled accumulation (EA's "bukkits") is the next optimisation if this budget ever tightens. At 32k the
  solver already uses about 1/6 of the 2 ms budget, so I left it out.
- The GPU and CPU solvers give the same pile to within 1 mm.

**CPU fallback** (`tools/test/mpm.mjs`): 5,184 particles, 2 iterations, 7.0 ms per step in the worker. At 3
iterations it is about 4.9 ms per step for 2.3k particles.

**Main thread:** about 0 ms median, 0.2 ms max for `Mpm.update` (stats bookkeeping). The host's deposit (readback,
patch) takes 1–8 ms once per slide, and the terrain worker's grain selection 3–12 ms per edit.

**Leveltour** (15 views, WebGL2 on the 4090): main@e3fe6fa, this branch, and this branch with `?mpm=1` are identical.

- Draw calls and triangles: overview 642 calls and 1.83M triangles; scaffold 566 and 1.61M; and so on.
- Every view runs at 60 fps (16.6–16.7 ms vsync-capped), with no errors.

**Three slides at once** (`mpmgame.mjs busy --uncapped`; 3 zones at the CPU cap, 6,144 particles drawn as 49k
grains):

| View | Idle (median, p95) | Three slides (median, p95) | Calls | Triangles |
|---|---|---|---|---|
| Overview | 6.1–6.6 ms, 6.8–7.9 ms | 6.6–7.5 ms, 7.6–8.4 ms | +9 | +0.4M |
| Midfield | 3.9–4.0 ms, 4.2–4.9 ms | 4.1–4.2 ms, 4.8–5.3 ms | +1 | +0.4M |

**Volume:** blast, simulate and deposit return the grains' volume to the terrain:

- `mpm.mjs`: dune 99%, berm 107%, snow cap 88%;
- `mpmgame.mjs` (game, measured in a box): dune 98%, snow 90%, avalanche 99%.

Snow that spreads thin or leaves the box accounts for its loss.

**PB-MPM against explicit MLS-MPM:** I did not build an explicit solver before switching, so there are no measured
numbers to compare. For reference: an explicit solver with a sand stiffness that keeps a pile's shape needs a
CFL/sound-speed step of order 10⁻⁴ s, which is around 100 substeps per frame. PB-MPM runs at the frame step with 3
iterations, and its cost does not depend on the stiffness. What it trades is softness when the solve has not
converged, as the paper says.

## Tests

- **`node tools/test/mpm.mjs`** (CPU solver, Node):
  - column collapses: sand angle of repose ≈ 23°, dirt ≈ 22–26°;
  - snow compresses (mean Jp 0.62) and holds in one clump; lava slumps;
  - no NaNs, and particles stay inside the zone and above the ground;
  - the CPU cost at the cap;
  - blast, simulate and deposit round trips on the level's dune, berm and a snow cap (88–107% of the volume back);
  - two terrain cores stay identical through the grains and the deposit.
- **`node tools/test/mpmgpu.mjs [outDir]`** (GPU solver on a real GPU through Dawn):
  - needs the `webgpu` package: `npm i --no-save webgpu`, or `MPM_WEBGPU=<dir>`; skips cleanly without it;
  - timings, GPU against CPU, and a render of the grains from the GPU buffers (`mpmgpu-grains.png`).
- **`node tools/test/mpmgame.mjs [outDir] --url <dev server> [--uncapped] [--mp]`** (the game in headless Chromium, WebGL2,
  `?mpm=1`):
  - blasts the dune and a snow cap, and runs the avalanche key on a dune flank;
  - screenshots before, during and after;
  - checks that the deposit was applied and the terrain took the volume back, frame times, and no console errors;
  - the busy scenario (three slides at once);
  - `--mp`: two tabs in a room. Both cut the same grains, only the host deposits, and the chunk hashes end equal.
    A host running `?mpm=0` puts a guest's grains straight back.

## Known limitations

- **Headless WebGPU.** Headless Chromium here only offers WebGPU through SwiftShader, whose device is lost within
  seconds even with MPM off. So the in-page WebGPU path is tested on a real GPU only through Dawn (`mpmgpu.mjs`:
  every kernel and the grain material's vertex stage). The game test runs the WebGL2 / CPU-worker path. A real
  browser on WebGPU has not been tried here.
- **One-way coupling.** Bodies and the player push grains, but grains do not push back. There is no aggregate force
  readback, and the player walks through grains (not into them) until they are deposited.
- **The deposit swaps particles for terrain in one frame.** Matter packed tighter than a voxel, or spread thinner
  than one, is redistributed (spread over neighbouring columns), so a pile's crest can shift by a voxel at that
  moment.
- **Snow on cliffs.** Snow sheets that stick to a cliff stay there as terrain; a little is lost off the world's edge.
- **Dirt is cohesive by design** (tunnels must hold). Only sand and snow follow slope rules on every dig.
- **Showcase scale.** The level's dunes are small (1.4 m tall), so the biggest slides are dune collapses into a
  crater and snow pouring off a crag. Larger dunes would show more (a level-design call; the level is unchanged).
- **Protocol change.** The `grains` option of brush edits and the `deposit` edit are new, so a room must run one
  build. An older client would ignore the grains and diverge until a hash check resyncs it.
- **Water** is out of scope here (SPH is on the `sph` branch). The material table has no liquid model, though PB-MPM
  supports one.
