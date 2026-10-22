# SPH fluid (src/fluid)

Water fills the two water towers' tanks and stays in until a tank is breached; then it pours out, runs over the
ground and pools against walls. Lava lies over the two lava basins and splashes when blasted. Everything is local
and cosmetic (no network traffic); what moves the fluid already reaches every client in order: terrain edits,
blasts, bodies and actors.

## Solver: Position Based Fluids

Macklin & Müller 2013, per particle, normalized so a particle's mass and the rest density are 1:

- **predict**: gravity (20 m/s²), per-phase damping, blast kicks, speed clamp (16 m/s), `x* = x + v dt`, collide.
- **neighbours**: spatial hash of cells of size h (= 2 x spacing), 65536 bins of at most 32 particles filled with
  `atomicAdd`, then a list of up to 64 neighbours per particle (27 cells; a neighbour's cell coordinates are checked,
  so hash collisions never double count). The CPU solver uses a counting sort into the same hash.
- **density constraint**, K Jacobi iterations of { density with poly6; `C = max(rho / rho0 - 1, 0)` (unilateral: a
  free surface never pulls); `lambda = -C / (sum |grad C|² + eps)` with the spiky gradient; `dx = sum (lambda_i +
  lambda_j + s_corr) grad W / rho0`; collide }. `s_corr` (artificial pressure, k = 0.005, dq = 0.25 h) is kept light:
  stronger, it inflates the free surface.
- **terrain in the density**: there are no boundary particles. A wall at SDF distance d below a particle counts as
  layers of virtual particles at `d + s/2 + k s`, each a continuous plane of the lattice's areal density
  (`plane(y) = pi / (4 s²) poly6 (h² - y²)^4`, closed form), calibrated so a lattice resting on a wall has exactly the
  rest density. Its gradient enters the constraint, so walls push back like fluid and particles at the floor are not
  under-dense (the bulk density error went from 5.5 % to under 1 % with it).
- **velocity**: `v = (x* - x) / dt`, tangential friction where the particle touches the terrain, XSPH viscosity.
- **recycling**: particles outside the world box die; an idle (< 0.08 m/s for 12 s) water particle in a thin film
  (rho < 0.55 rho0) evaporates. Lava never evaporates.

Phases (`pos.w`): 1 water (XSPH 0.04, friction 0.04), 2 lava (XSPH 0.55, friction 0.35, damping 1.6/s), 0 dead.

Why PBF: it is unconditionally stable at the game's 60 Hz step (2 substeps of 1/120 s on the GPU), where weakly
compressible SPH would need dozens of substeps. Four iterations are the fewest that let the 2.8 m deep tank come to
rest: with three a compression wave keeps a third of it moving (measured on the CPU solver, which runs the same
algorithm).

## Collisions with the voxel world

`src/fluid/sdfPages.js`: the world's SDF as pages, one table entry per world chunk (800): a page index or a uniform
chunk's fill value. Dense chunks are copied as they are (32³ Int8, 32 KB); chunks whose distances are all equal count
as uniform. The whole level fits (≈ 600 pages, ~20 MB, capacity +160 for chunks that become dense), so no window has
to follow the fluid and particles can go anywhere. On the GPU the pages are an `int` storage buffer (4 samples per
word, sign-extended in the shader) and a table; `world.onChange` (every terrain edit's dirty chunks, soft-ground
bakes included) re-uploads the dirty chunks' pages and table entries the same frame the replica changes. Carving a
tank wall is therefore all it takes for the water to come out.

A particle closer to the terrain than its radius (spacing / 2) is pushed out along the trilinear SDF gradient (up when
deep inside, where the stored distance saturates). Initial fills skip lattice points closer than the radius: in
concave creases the trilinear SDF underestimates the distance, and the push would shoot them out.

## Interaction

- **Proxies** (one-way, up to 16): actors as capsules (`ctx.game.actors`, from their CharacterBody) and dynamic
  physics props as oriented boxes (their mesh's local bounding box, cached per geometry), but only those in a chunk
  the fluid occupies. Particles are projected out of them in the collide step, so a body falling in displaces the
  water and the water takes its velocity.
- **Kicks** (up to 4 per step): a carve with an impulse (blasts, punches) near the fluid gives the particles within
  `2.2 size + 1.5` m a radial, upward-tilted velocity (blasts up to 12 m/s).
- No force goes back to bodies (no buoyancy): it would need a readback per body; the stats readback is the only one.

## Sleep

Every 6 frames the solver's last substep gathers stats into a small atomic buffer (alive, particles faster than
0.25 m/s, max speed, the chunks the fluid occupies), read back asynchronously (never the particles). When at most
0.4 % of the particles move for a second, the solver stops dispatching (the fluid stays drawn). It wakes on a terrain
edit within 1.5 m of an occupied chunk, a kick, a spawn, or a moving actor or awake body in an occupied chunk. The
intact level's fluid sleeps a couple of seconds after load and costs no compute until something happens.

## Backends and caps

| | WebGPU (`FluidGPU.js`) | WebGL2 / `?fluidCpu=1` (`FluidCPU.js` + `src/workers/fluid.js`) |
|---|---|---|
| particles | 32768 slots, 0.2 m spacing | 4096 slots, 0.3 m spacing |
| level fill | 2 x 4481 water + 2 x 646 lava = 10254 | 2 x 1144 water + 2 x 274 lava = 2836 |
| step | 2 substeps x 4 iterations, 36 dispatches | 1 substep x 4 iterations, in a worker |
| particles reach the renderer | storage buffers as instanced attributes | instanced attributes uploaded per worker frame |

Slots `[0, level fill)` hold the level's fluid; the rest is a ring for spawns (a new blob overwrites the oldest).

## Rendering (`FluidSurface.js`, default)

Screen-space fluid (van der Laan et al. 2009, simplified): the particles are one instanced sprite draw into a
half-size float target holding the distance to the nearest sphere surface (plus lava and foam fractions); a separable
bilateral Gaussian smooths the distance (radius ~4 particle radii on screen, at most 16 texels, every texel sampled:
sparse taps alias into stripes); a full-screen triangle in the main scene, after the opaque terrain, reconstructs
per-pixel normals from the smoothed distance (bilinear by hand over the texels that hold fluid, the smaller
difference per axis, a side without fluid ignored), shades water (deep blue-green body, sky reflection by Fresnel on
|n.v|, sun glint, foam where fast or spraying) or lava (emissive orange under a drifting darker crust) with the
scene's fog, and writes the surface's depth, so terrain in front hides it. All four passes are skipped when no chunk
the fluid occupies is in the camera's frustum. `?fluidRender=sprites` (`FluidRender.js`) draws the particles as
sphere impostors shaded with the solver's surface normal instead (one draw call, looks like a ball pit up close).
Both renderers work on WebGPU and WebGL2.

## Budgets (measured, headless Chromium on an RTX 4090, 1280 x 720)

- GPU compute (timestamp queries): 0 ms asleep; 0.6-0.7 ms with the level's 10k particles spilling; 0.6-1.6 ms at
  the 32k cap (varies run to run with the GPU's clocks; one step measured alone: 0.59 ms). The neighbour gather is
  the largest pass (~0.16 ms at 32k).
- GPU render: +0.1-0.9 ms for the surface passes with the fluid in view (0.58 -> 0.72 ms in the spill view).
- Main thread: ~0.1 ms per frame (proxies, uniforms, dispatch encoding).
- CPU fallback (worker): 2.4-2.6 µs per particle per step: ~6.5 ms per step for the level's 2.8k particles, 9 ms at
  3.5k (`tools/test/sph.mjs`). When the worker falls behind, steps are dropped (slow motion), never the frame.
- Draw calls: +4 when fluid is in view (sprites into the depth target, two blur quads, the surface), +0 otherwise.
  leveltour: 60 fps in every view on both backends, before and after.
- Memory: ~20 MB SDF pages, 8 MB bins, 8 MB neighbour lists, ~3 MB particle state on the GPU.

## Knobs

URL: `?fluid=0` off, `?fluidCpu=1` CPU solver on WebGPU, `?fluidIters=`, `?fluidSub=`, `?fluidRender=sprites`.
Dev key **H**: a 7³ water blob above the crosshair. `ctx.fluid.spawnBlob(center, { n, kind: 'water' | 'lava', vel })`,
`ctx.fluid.wake()`, `ctx.fluid.stats`, `ctx.fluid.label` (also in the stats line).
Constants: `src/fluid/params.js` (spacing, caps, iterations, gravity, s_corr, phases, evaporation), `FluidGPU.js`
(bins, MAXPER), `Fluid.js` (stats cadence, calm time), `FluidSurface.js` (target scale, blur radius, shading).
Level sources: `FLUID_SOURCES` in `src/level/showcase.js` (the tank and basin constants the geometry uses too).

## Tests

- `node tools/test/sph.mjs`: dam breaks in closed stone boxes carved in a VoxelWorld, CPU solver at the fallback's
  and the GPU's settings and at full load: no NaNs, nothing lost, nothing outside the SDF walls, the front reaches
  the far wall, settled bulk density error < 3 % (compression < 1 %), < 2 % still moving; ms per step.
- `node tools/test/sphgame.mjs [outDir] [--url] [--webgl]`: the game with the fluid (WebGPU on the real GPU, or the
  WebGL2 fallback): the tank holds and the solver sleeps, a blast breaches it, the water runs out (> 30 % outside),
  none inside the terrain, none lost, a dropped box pushes the water out of its volume, the spawn ring fills to the
  cap, 60 fps throughout, GPU compute < 2 ms at the cap, no console errors; screenshots, render cost with
  `?fluid=0`.
- `leveltour.mjs --webgpu` runs the tour on WebGPU (default WebGL2).

Headless WebGPU: Chromium needs `--enable-unsafe-webgpu --enable-features=Vulkan --use-angle=vulkan`, and the first
adapter request of a fresh browser can come back empty, so the tests poll `requestAdapter` on a blank page first.
Page screenshots of a WebGPU canvas come out blank headless: the tests read the canvas with `toDataURL` right after a
frame.

## Limitations

- One-way coupling: bodies push the fluid, nothing pushes bodies or slows players.
- The SDF has 0.25 m resolution and the particles 0.2 m: water leaks through cracks narrower than ~0.2 m, not through
  closed walls; concave creases read a little closer than they are.
- Opaque surface: no refraction or thickness-based transparency (the surface pass draws inside the main pass and
  cannot read the scene behind it). Edges are half-resolution and slightly jagged; a thin falling stream breaks into
  drops (resolution).
- The lava is a single layer over the basin's solid lava (the voxelized basin is only ~0.13 m deep); it splashes and
  can be blasted out, but it does not burn anything.
- Water on the CPU fallback is coarser (0.3 m) and its spawn ring is small (~1.2k slots).
