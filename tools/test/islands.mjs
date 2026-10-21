// node tools/test/islands.mjs: connectivity after typical edits (timings + expected detachments) and grid utilities.
import { VoxelWorld } from '../../src/voxel/VoxelWorld.js';
import { voxelize } from '../../src/voxel/voxelize.js';
import { rock, box, sphere } from '../../src/voxel/brushes.js';
import { Level } from '../../src/level/fortwar.js';
import { findIslands, detachIsland, gridStats, splitGrid, voronoiLabels, gridBoxes, stampGrid, carveGrid, liftGrid } from '../../src/voxel/islands.js';

let t = performance.now();
const world = new VoxelWorld();
voxelize(world, new Level());
console.log(`voxelize ${(performance.now() - t).toFixed(0)} ms`);
let fails = 0;
const check = (ok, msg) => { console.log(ok ? '  ok  ' : '  FAIL', msg); if(!ok) fails++; };

const ERODE = +(process.env.ERODE ?? 48);
/** Edit, then connectivity as VoxelBodies.detachAround does it: an eroded pass, then a plain one. */
function edit(name, brush, hardness = true) {
    const t0 = performance.now();
    const r = world.applyBrush(brush, { hardness });
    const t1 = performance.now();
    const islands = [], grids = [];
    let tIsl = 0, tDetach = 0, visited = 0;
    for(const erode of [ERODE]) {
        const res = findIslands(world, r.box[0], r.box[1], { erode, near: brush });
        tIsl += res.ms; visited += res.visited;
        for(const isl of res.islands) {
            const t3 = performance.now();
            grids.push(detachIsland(world, isl).grid);
            tDetach += performance.now() - t3;
            islands.push(isl);
        }
    }
    console.log(`${name}: carve ${(t1 - t0).toFixed(1)} ms, islands ${tIsl.toFixed(1)} ms (visited ${visited}), detach ${tDetach.toFixed(1)} ms -> ${islands.map(i => `${i.count}@mat${i.mat}`).join(', ') || 'none'}`);
    return { res: { islands }, grids };
}

// warm up
edit('warmup ground blast', rock([-20, 0, 30], 2, 7));
let r = edit('ground blast r3.5', rock([-20, 0.5, 0], 3.5, 1));
check(r.res.islands.length === 0, 'ground blast detaches nothing');
r = edit('fort wall blast r3.5', rock([-37.2, 3, 0], 3.5, 2));
check(r.res.islands.every(i => i.count < 200), 'wall blast into intact fort detaches at most crumbs');
r = edit('blast at tower base', rock([-36.4, 1, 12.6], 3.5, 3));
check(r.res.islands.every(i => i.count < 2000), 'tower still held by its walls');
// cut the tower free of both walls (full height), it should detach as one piece
r = edit('cut wall south of tower', box([-42, 0.2, 9.2], [-35.5, 8, 9.9]), false);
r = edit('cut wall west of tower', box([-39.8, 0.2, 9.5], [-39.1, 8, 13.6]), false);
check(r.res.islands.length >= 1 && r.res.islands[0].count > 8000, 'tower detaches after both cuts');
const towerGrid = r.grids[0];
if(towerGrid) {
    const s = gridStats(towerGrid);
    console.log(`  tower grid ${towerGrid.nx}x${towerGrid.ny}x${towerGrid.nz}, ${s.volume.toFixed(1)} m³, ${(s.mass / 1000).toFixed(0)} t, mat ${s.mat}`);
    t = performance.now(); const b2 = gridBoxes(towerGrid, 2); const tb = performance.now() - t;
    t = performance.now(); const b1 = gridBoxes(towerGrid, 1); const tb1 = performance.now() - t;
    console.log(`  boxes res2 ${b2.length} (${tb.toFixed(1)} ms), res1 ${b1.length} (${tb1.toFixed(1)} ms)`);
    t = performance.now();
    const labels = voronoiLabels(towerGrid, [1, 0, 1], 8);
    const dust = new Float64Array(256);
    const pieces = splitGrid(towerGrid, labels, { minCount: 16, dust });
    console.log(`  voronoi 8 -> ${pieces.length} pieces in ${(performance.now() - t).toFixed(1)} ms: ${pieces.map(p => p.count).join(' ')}`);
    const total = pieces.reduce((a, p) => a + p.count, 0) + Math.round(dust.reduce((a, b) => a + b, 0) / 0.25 ** 3);
    check(total === s.count, `pieces keep every sample (${total} / ${s.count})`);
    t = performance.now();
    const st = stampGrid(world, towerGrid, [towerGrid.offset[0] * 0.25 + 3, towerGrid.offset[1] * 0.25, towerGrid.offset[2] * 0.25], [0, 0, Math.sin(0.3), Math.cos(0.3)]);
    console.log(`  stamp tower back rotated: ${(performance.now() - t).toFixed(1)} ms, added ${st.added.toFixed(1)} m³`);
}
// bridge: blow both ends
let bridge = [];
r = edit('bridge end west', rock([-8.5, -0.5, 0], 3.2, 4)); bridge.push(...r.res.islands);
r = edit('bridge cut west', box([-8.4, -1.5, -10], [-7.6, 1.6, 10]), false); bridge.push(...r.res.islands);
r = edit('bridge end east', rock([8.7, -0.5, 0], 3.2, 5)); bridge.push(...r.res.islands);
r = edit('bridge cut east', box([7.8, -1.5, -10], [8.6, 1.6, 10]), false); bridge.push(...r.res.islands);
check(bridge.some(i => i.count > 1000), 'bridge drops after both ends are blown');
// worst case: big structure fill hits the budget
r = edit('blue fort wall blast', rock([37.2, 3, 0], 3.5, 6));
// carve a grid
if(towerGrid) {
    t = performance.now();
    const c = carveGrid(towerGrid, sphere([2.5, 3, 2.5], 3), { hardness: false });
    const parts = splitGrid(towerGrid);
    console.log(`grid carve + split ${(performance.now() - t).toFixed(1)} ms -> ${parts.length} parts`);
}
t = performance.now();
const lump = liftGrid(world, sphere([20, 0, -10], 1.5));
console.log(`lift lump ${(performance.now() - t).toFixed(1)} ms, ${lump.count} samples`);
console.log(fails ? `${fails} FAILED` : 'all ok');
