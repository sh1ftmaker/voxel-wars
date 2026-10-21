// node tools/test/bodycost.mjs: main-thread cost of turning grids into Rapier colliders (hull vs boxes), warm.
import RAPIER from '@dimforge/rapier3d-compat';
import { VoxelWorld } from '../../src/voxel/VoxelWorld.js';
import { voxelize } from '../../src/voxel/voxelize.js';
import { box } from '../../src/voxel/brushes.js';
import { Level } from '../../src/level/fortwar.js';
import { findIslands, detachIsland, splitGrid, voronoiLabels, gridBoxes, gridHullPoints, gridStats } from '../../src/voxel/islands.js';
await RAPIER.init();
const world = new VoxelWorld(); voxelize(world, new Level());
world.applyBrush(box([-42, 0.2, 9.2], [-35.5, 8, 9.9]), { hardness: false });
const r = world.applyBrush(box([-39.8, 0.2, 9.5], [-39.1, 8, 13.6]), { hardness: false });
const tower = detachIsland(world, findIslands(world, r.box[0], r.box[1]).islands.sort((a, b) => b.count - a.count)[0], { notify: false }).grid;
const rw = new RAPIER.World({ x: 0, y: -30, z: 0 });
const pieces = splitGrid(tower, voronoiLabels(tower, [2, 2, 2], 12), { minCount: 16 });
const T = (f, n = 5) => { let best = Infinity, v; for(let i = 0; i < n; i++) { const t = performance.now(); v = f(); best = Math.min(best, performance.now() - t); } return [best, v]; };
for(const g of [tower, ...pieces.slice(0, 5)]) {
    const [tp, pts] = T(() => gridHullPoints(g));
    const [th] = T(() => { const b = rw.createRigidBody(RAPIER.RigidBodyDesc.dynamic()); rw.createCollider(RAPIER.ColliderDesc.convexHull(pts), b); rw.removeRigidBody(b); });
    const [tb, bx] = T(() => gridBoxes(g, g.count > 6000 ? 2 : 1));
    const [tbr] = T(() => { const b = rw.createRigidBody(RAPIER.RigidBodyDesc.dynamic()); for(const x of bx) rw.createCollider(RAPIER.ColliderDesc.cuboid(...x.h).setTranslation(...x.c), b); rw.removeRigidBody(b); });
    const [ts] = T(() => gridStats(g));
    console.log(`n=${g.count} hull: pts ${pts.length / 3} gen ${tp.toFixed(2)} rapier ${th.toFixed(2)} | boxes ${bx.length} gen ${tb.toFixed(2)} rapier ${tbr.toFixed(2)} | stats ${ts.toFixed(2)}`);
}
