// node tools/test/colliders.mjs: Rapier step cost of voxel pieces as box compounds, convex hulls or voxel shapes,
// dropped onto the real terrain trimeshes.
import RAPIER from '@dimforge/rapier3d-compat';
import { VoxelWorld } from '../../src/voxel/VoxelWorld.js';
import { voxelize } from '../../src/voxel/voxelize.js';
import { surfaceNets } from '../../src/voxel/surfaceNets.js';
import { Level } from '../../src/level/fortwar.js';
import { box } from '../../src/voxel/brushes.js';
import { CHUNK, PAD, CHUNK_M, VOXEL } from '../../src/config.js';
import { findIslands, detachIsland, splitGrid, voronoiLabels, gridBoxes, gridHullPoints, gridStats } from '../../src/voxel/islands.js';
await RAPIER.init();
const world = new VoxelWorld();
voxelize(world, new Level());
// tower -> pieces
world.applyBrush(box([-42, 0.2, 9.2], [-35.5, 8, 9.9]), { hardness: false });
const r = world.applyBrush(box([-39.8, 0.2, 9.5], [-39.1, 8, 13.6]), { hardness: false });
const isl = findIslands(world, r.box[0], r.box[1]).islands[0];
const tower = detachIsland(world, isl, { notify: false }).grid;
let rs = 1;
const rand = () => { rs = (rs * 16807) % 2147483647; return rs / 2147483647; };
const pieces = splitGrid(tower, voronoiLabels(tower, [2, 1, 2], 40, rand)).filter(p => p.count > 24);
console.log(`${pieces.length} pieces, samples ${pieces.map(p => p.count).join(' ')}`);
function build(kind) {
    const rw = new RAPIER.World({ x: 0, y: -30, z: 0 });
    rw.timestep = 1 / 60;
    const fixed = rw.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const P = CHUNK + 2 * PAD, sdf = new Int8Array(P ** 3), mat = new Uint8Array(P ** 3);
    for(const c of world.chunks.values()) {
        if(Math.abs(c.cx * CHUNK_M + 36) > 20 || Math.abs(c.cz * CHUNK_M - 12) > 20) continue;
        if(!world.extractPadded(c.cx, c.cy, c.cz, sdf, mat)) continue;
        const m = surfaceNets(sdf, mat, CHUNK);
        if(!m.indices.length) continue;
        const v = m.positions.slice();
        for(let i = 0; i < v.length; i += 3) { v[i] += c.cx * CHUNK_M; v[i + 1] += c.cy * CHUNK_M; v[i + 2] += c.cz * CHUNK_M; }
        rw.createCollider(RAPIER.ColliderDesc.trimesh(v, m.indices), fixed);
    }
    let colliders = 0;
    const t0 = performance.now();
    for(const g of pieces) {
        const o = g.offset;
        const b = rw.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setCcdEnabled(true)
            .setTranslation((tower.offset[0] + o[0]) * VOXEL, (tower.offset[1] + o[1]) * VOXEL + 2, (tower.offset[2] + o[2]) * VOXEL)
            .setAngvel({ x: rand() - 0.5, y: rand() - 0.5, z: rand() - 0.5 }).setLinvel(rand() * 4 - 2, 0, rand() * 4 - 2));
        const st = gridStats(g);
        if(kind === 'boxes') {
            const bs = gridBoxes(g, g.count > 400 ? 2 : 1);
            const vol = bs.reduce((a, x) => a + 8 * x.h[0] * x.h[1] * x.h[2], 0);
            for(const x of bs) { rw.createCollider(RAPIER.ColliderDesc.cuboid(...x.h).setTranslation(...x.c).setDensity(st.mass / vol), b); colliders++; }
        } else if(kind === 'hull') {
            rw.createCollider(RAPIER.ColliderDesc.convexHull(gridHullPoints(g)).setDensity(2000), b); colliders++;
        } else if(kind === 'voxels') {
            // 0.5 m voxels from the solid sample centres
            const pts = [];
            const Px = g.nx + 2 * PAD, PP = Px * (g.ny + 2 * PAD);
            for(let z = 0; z < g.nz; z += 1) for(let y = 0; y < g.ny; y += 1) for(let x = 0; x < g.nx; x += 1)
                if(g.sdf[(x + PAD) + (y + PAD) * Px + (z + PAD) * PP] < 0) pts.push(x * VOXEL, y * VOXEL, z * VOXEL);
            rw.createCollider(RAPIER.ColliderDesc.voxels(new Float32Array(pts), { x: 0.5, y: 0.5, z: 0.5 }).setDensity(2000), b); colliders++;
        }
    }
    const tb = performance.now() - t0;
    let worst = 0;
    const t1 = performance.now();
    for(let i = 0; i < 240; i++) { const s = performance.now(); rw.step(); worst = Math.max(worst, performance.now() - s); }
    const tt = performance.now() - t1;
    let awake = 0; rw.forEachRigidBody(b => { if(b.isDynamic() && !b.isSleeping()) awake++; });
    let minY = Infinity; rw.forEachRigidBody(b => { if(b.isDynamic()) minY = Math.min(minY, b.translation().y); });
    console.log(`${kind}: ${colliders} colliders, build ${tb.toFixed(1)} ms, 240 steps ${tt.toFixed(0)} ms (avg ${(tt / 240).toFixed(2)}, worst ${worst.toFixed(1)}), awake after ${awake}, min y ${minY.toFixed(2)}`);
    rw.free();
}
for(const k of ['boxes', 'hull', 'voxels']) build(k);
