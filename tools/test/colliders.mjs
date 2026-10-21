// node tools/test/colliders.mjs: physics (box3d) step cost of voxel pieces as box compounds or convex hulls, dropped
// onto the real terrain meshes.
import { loadBox3d, B3World, BodyType } from '../../src/physics/box3d/B3.js';
import { VoxelWorld } from '../../src/voxel/VoxelWorld.js';
import { voxelize } from '../../src/voxel/voxelize.js';
import { surfaceNets } from '../../src/voxel/surfaceNets.js';
import { Level } from '../../src/level/fortwar.js';
import { box } from '../../src/voxel/brushes.js';
import { CHUNK, PAD, CHUNK_M, VOXEL } from '../../src/config.js';
import { findIslands, detachIsland, splitGrid, voronoiLabels, gridBoxes, gridHullPoints, gridStats } from '../../src/voxel/islands.js';
const M = await loadBox3d();
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
    const w = new B3World(M, { gravity: [0, -30, 0] });
    const fixed = w.createBody({ type: BodyType.Fixed });
    const P = CHUNK + 2 * PAD, sdf = new Int8Array(P ** 3), mat = new Uint8Array(P ** 3);
    for(const c of world.chunks.values()) {
        if(Math.abs(c.cx * CHUNK_M + 36) > 20 || Math.abs(c.cz * CHUNK_M - 12) > 20) continue;
        if(!world.extractPadded(c.cx, c.cy, c.cz, sdf, mat)) continue;
        const m = surfaceNets(sdf, mat, CHUNK);
        if(!m.indices.length) continue;
        const v = m.positions.slice();
        for(let i = 0; i < v.length; i += 3) { v[i] += c.cx * CHUNK_M; v[i + 1] += c.cy * CHUNK_M; v[i + 2] += c.cz * CHUNK_M; }
        w.createMesh(fixed, v, m.indices);
    }
    let colliders = 0;
    const bodies = [];
    const t0 = performance.now();
    for(const g of pieces) {
        const o = g.offset;
        const b = w.createBody({ position: [(tower.offset[0] + o[0]) * VOXEL, (tower.offset[1] + o[1]) * VOXEL + 2, (tower.offset[2] + o[2]) * VOXEL],
            angvel: [rand() - 0.5, rand() - 0.5, rand() - 0.5], linvel: [rand() * 4 - 2, 0, rand() * 4 - 2] });
        bodies.push(b);
        const st = gridStats(g);
        if(kind === 'boxes') {
            const bs = gridBoxes(g, g.count > 400 ? 2 : 1);
            const vol = bs.reduce((a, x) => a + 8 * x.h[0] * x.h[1] * x.h[2], 0);
            for(const x of bs) { w.createBox(b, x.h, { center: x.c, density: st.mass / vol }); colliders++; }
        } else if(kind === 'hull') {
            if(w.createHull(b, gridHullPoints(g), { density: 2000 })) colliders++;
        }
    }
    const tb = performance.now() - t0;
    let worst = 0;
    const t1 = performance.now();
    for(let i = 0; i < 240; i++) { const s = performance.now(); w.step(1 / 60); worst = Math.max(worst, performance.now() - s); }
    const tt = performance.now() - t1;
    const awake = bodies.filter(b => !b.isSleeping()).length;
    const minY = Math.min(...bodies.map(b => b.translation().y));
    console.log(`${kind}: ${colliders} colliders, build ${tb.toFixed(1)} ms, 240 steps ${tt.toFixed(0)} ms (avg ${(tt / 240).toFixed(2)}, worst ${worst.toFixed(1)}), awake after ${awake}, min y ${minY.toFixed(2)}`);
    w.free();
}
for(const k of ['boxes', 'hull']) build(k);
