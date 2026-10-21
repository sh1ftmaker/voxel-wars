// node tools/test/terrainsync.mjs: the terrain worker protocol, in-process (TerrainSync without a Worker): init, brush
// edits with connectivity, a split, a stamp and a sample patch; the main-thread replica must equal the core's world.
import { VoxelWorld } from '../../src/voxel/VoxelWorld.js';
import { TerrainSync } from '../../src/voxel/TerrainSync.js';
import { rock, box, capsule } from '../../src/voxel/brushes.js';
let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if(!c) fails++; };
const world = new VoxelWorld();
const sync = new TerrainSync(world, { worker: false });
await sync.init();
const same = () => {
    for(const [k, a] of sync.core.world.chunks) {
        const b = world.chunks.get(k);
        if(a.fill !== b.fill || a.fillMat !== b.fillMat || !!a.sdf !== !!b.sdf) return k;
        if(a.sdf) for(let i = 0; i < a.sdf.length; i++) if(a.sdf[i] !== b.sdf[i] || a.mat[i] !== b.mat[i]) return k;
    }
    return null;
};
ok(same() === null, 'replica after init');
let notified = 0;
world.onChange(() => notified++);
const r1 = await sync.brush(rock([0, 0.1, 5], 3, 2), { op: 'carve', conn: true, erode: 48 });
ok(r1.result.changed > 0 && r1.chunks.length > 0 && notified === 1, `blast: ${r1.result.changed} samples, ${r1.chunks.length} chunks sent, worker ${r1.workerMs.toFixed(1)} ms`);
ok(same() === null, 'replica after blast');
// a bridge: build it, cut both ends, the deck comes back as an island
const B = (a, b) => box(a, b);
await sync.brush(B([-8.5, -0.4, -1], [-6.5, 7.1, 1]), { op: 'add', mat: 5 });
await sync.brush(B([6.5, -0.4, -1], [8.5, 7.1, 1]), { op: 'add', mat: 5 });
await sync.brush(B([-9, 7.1, -1.5], [9, 8.3, 1.5]), { op: 'add', mat: 5 });
// a hand-made brush (no spec) travels as a sampled grid
const cutA = { min: [-9, 0.7, -1.5], max: [-6, 5.2, 1.5], d: (x, y, z) => Math.max(-9 - x, x + 6, 0.7 - y, y - 5.2, -1.5 - z, z - 1.5) };
const r1b = await sync.brush(cutA, { op: 'carve', hardness: false, conn: true, erode: 48 });
const r2 = await sync.brush(B([6, 0.7, -1.5], [9, 5.2, 1.5]), { op: 'carve', hardness: false, conn: true, erode: 48 });
const islands = [...r1b.islands, ...r2.islands].sort((a, b) => b.grid.count - a.grid.count);
ok(islands.length >= 1 && islands[0].grid.prep.stats.count > 1000, `bridge deck detached: ${islands.map(i => i.grid.prep.stats.count).join(', ')} samples, ${islands[0]?.grid.prep.boxes.length} boxes`);
ok(world.sample(0, 7.7, 0) > 0 && same() === null, 'replica: deck gone');
const g = islands[0].grid;
const sp = await sync.split(g, { point: [4, 0.5, 0.5], n: 6, minCount: 16, generation: 1 });
ok(sp.pieces.length >= 2 && sp.pieces.every(p => p.prep.stats.count > 0), `fracture split: ${sp.pieces.length} pieces`);
const st = await sync.stamp(g, [0, 0.1, 10], [0, 0, 0, 1]);
ok(st.result.added > 10 && same() === null, `stamp: ${st.result.added.toFixed(1)} m³ added`);
const patch = { lo: [0, 0, 0], dims: [4, 4, 4], sdf: new Int8Array(64).fill(-127), mat: new Uint8Array(64).fill(3) };
const sm = await world.applySamples(patch);
ok(sm.result.changed > 0 && world.getMat(1, 1, 1) === 3 && same() === null, `sample patch: ${sm.result.changed} samples`);
const dig = await sync.brush(capsule([20, 0.5, 0], [21, 0.2, 0], 1.6), { op: 'carve', conn: true });
ok(dig.result.removed.reduce((a, b) => a + b, 0) > 0.5, 'drill removes matter');
console.log(fails ? `${fails} FAILED` : 'all ok');
process.exitCode = fails ? 1 : 0;
