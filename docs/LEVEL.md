# Twin Forts: the materials showcase

The level is one SDF program (`src/level/fortwar.js`, primitives in `src/level/prims.js`), evaluated by the terrain
worker on every client. The materials showcase (`src/level/showcase.js`) adds structures built for the materials
branch's per-material destruction: wood splinters along its grain, stone shatters, metal bends, dirt and sand crumble,
glass shatters. Everything is mirror-symmetric in x (red at x < 0, blue at x > 0); the two teams get the same level.

## Areas (red side; blue mirrors it)

| Area | Where | Materials | What it is for |
|---|---|---|---|
| Fort | x -62..-36 | red / blue stone, cobble courtyard, wood gate (vertical grain) | as before; plus 3 glass windows in each side wall (shoot out of them, or knock the pane in) |
| Catwalk | front towers' tops, y 9.5 | metal | a girder walkway across the gate between the two front towers: a high firing line that bends and drops when blasted |
| Scaffolding | outside the north wall | wood (vertical poles, planks along x) | two plank levels: attackers mantle up 2.5 m at a time and onto the wall walk; defenders blow it down |
| Stockade | before the gate, x -32 | wood logs (vertical grain) on a buried sill | cover on both sides of the road; logs splinter, sections fall when cut from the sill |
| Road | gate to bridge | cobble at the gate and under the arch, dirt track between | paved where it is protected; the midfield stays soft (a paved field leaves craters with undercut lips you cannot climb out of) |
| Brick arch | bridgehead, x -11 | brick | a gateway over the road; pillars on piles, so the arch stands until a pillar goes |
| Watchtower | x -22, z -13 | wood (legs vertical grain, deck and ramp along x) | a 6 m platform with a crate, reached by a plank ramp; blow both piled legs and the tower topples |
| Midfield cover | x -30..-14 | dark rock boulders, dirt trench and berm, wooden crate stacks, sand dunes | boulders are tough cover; the crate stacks are loose (they topple when hit); dunes and berms crumble |
| Water tower | behind the fort, x -71, z -13 | metal (hollow tank on four girder legs) | a landmark that bends and falls when its legs are cut |
| Observatory | north ridge, x -24, z 30 | glass dome in four panes between metal ribs, on a metal ring | a crate inside: break a pane to reach it |
| Snow | north ridge | snow caps on the crags, a snowy crest on the back wall | soft, crumbling footing up high |
| Lava basins | south ridge, x ±24 | lava | decorative glow (lava does no damage) |

Shared, across the gorge (x -9.6..9.6):

| Crossing | z | Materials |
|---|---|---|
| Skybridge | 12.5..15.5 | glass deck in 8 panes between metal mullions, on two metal girders, metal railings. A pane knocked out falls into the gorge; cut one end and it holds as a steel cantilever, cut both and it falls |
| Cobble bridge | -4..4 | as before (the well, the plaza) |
| Footbridge | -14.6..-13 | wood deck along x on two trestles standing on the gorge's ramp |

New crate spots: on each watchtower's deck and inside each observatory (`src/game/Crates.js`).

## How structures stand

- Building materials bond only within their own class (`BOND_CLASS` in `src/voxel/islands.js`; wood of any grain is
  one class, glass its own). A wooden or metal structure that does not reach the bedrock through its own material is
  a loose island the first time an edit touches it. So each structure stands on hidden **piles** of its own material
  down to the bedrock band (y -15.95). Intact it holds; cut what joins it to its piles and it falls as a body.
- Piles are 1.05 m square below ground. The voxelizer fills deep solid 1 m blocks with one material when the block's
  corners and centre agree, so a thinner pile would vanish into the dirt. A 0.4 m neck joins the pile to its
  structure. Piles keep clear of the tunnels, vaults and caches (`tools/test/level.mjs` checks they stay open).
- Glass is never anchored: every pane is its own island in a frame of another material, so a hit knocks out one pane.
- Loose by design: the glass panes (28), the wooden crate stacks and the fort gates.
- Structural check (`src/voxel/structure.js`): the intact level must not collapse. Spans are kept within their
  material's reach (snow and lava cannot span the gorge; glass reaches as far as the frame that carries it).

## Building it fast

`Level` buckets primitives on a 4 m grid. `sdf()` runs over the bucket with no allocation, and `material()` walks a
per-bucket list sorted by priority, returning the first primitive that contains the point. The primitives use
`Math.sqrt`, not `Math.hypot` (several times slower in V8). With 2.5× the primitives (593), the world builds faster
than the original level did.

## Measurements

Measured on the dev machine (node 22; headless Chromium, WebGL2, RTX 4090).

| | before | after |
|---|---|---|
| Primitives | 234 | 593 |
| Voxelize (node) | 1.74 s | 1.55–1.61 s |
| Dense chunks / memory | 592 / 38.8 MB | 619 / 40.6 MB |
| Mesh triangles (all chunks) | 963k | 1,065k (+11%) |
| Page load to playable | 2.42 s | 2.46–2.57 s |
| Terrain meshes drawn | 334 | 348 |
| Draw calls, overview | 563 | 589 |
| Uncapped frame, overview / bridge / fort | 5.31 / 4.17 / 3.11 ms | 5.59 / 4.50 / 3.40 ms |

## Tests

- `node tools/test/level.mjs` checks four things:
  - the level builds deterministically;
  - tunnels, vaults, caches and gates are open;
  - every material is used;
  - only the intended pieces are loose.
- `node tools/test/structure.mjs`: the intact level does not collapse.
- `node tools/test/leveltour.mjs <dir> --url <dev server>`: screenshot tour and render statistics.
- `node tools/test/levelsmash.mjs <dir> --url <dev server>`: blasts the watchtower legs, a window, the water tower,
  the scaffolding and the skybridge, and reports what comes loose.
