// node tools/test/bench.mjs: voxelize Fort War, mesh every chunk, time it, and check a carve.
import { VoxelWorld } from '../../src/voxel/VoxelWorld.js';
import { voxelize } from '../../src/voxel/voxelize.js';
import { surfaceNets } from '../../src/voxel/surfaceNets.js';
import { sphere } from '../../src/voxel/brushes.js';
import { Level } from '../../src/level/fortwar.js';
import { CHUNK, PAD } from '../../src/config.js';
let t = performance.now();
const level = new Level();
const world = new VoxelWorld();
const r = voxelize(world, level);
console.log(`voxelize ${(performance.now() - t).toFixed(0)} ms, dense ${r.dense}/${r.total}, ${(r.dense * CHUNK ** 3 * 2 / 1e6).toFixed(1)} MB`);
const P = CHUNK + 2 * PAD, sdf = new Int8Array(P ** 3), mat = new Uint8Array(P ** 3);
t = performance.now(); let tris = 0, meshed = 0, verts = 0;
for(const c of world.chunks.values()) {
  if(!world.extractPadded(c.cx, c.cy, c.cz, sdf, mat)) continue;
  const m = surfaceNets(sdf, mat, CHUNK); tris += m.indices.length / 3; verts += m.positions.length / 3; meshed++;
}
const dt = performance.now() - t;
console.log(`mesh ${meshed} chunks ${dt.toFixed(0)} ms (${(dt / meshed).toFixed(2)} ms/chunk), ${tris} tris, ${verts} verts`);
t = performance.now();
const res = world.applyBrush(sphere([0, 0, 0], 3));
console.log(`carve ${(performance.now() - t).toFixed(1)} ms, changed ${res.changed}, dirty ${res.dirty.size}, removed dirt ${res.removed[1].toFixed(2)} grass ${res.removed[2].toFixed(2)} cobble ${res.removed[11].toFixed(2)}`);
console.log('raycast', world.raycast([0, 20, 30], [0, -1, 0]));
