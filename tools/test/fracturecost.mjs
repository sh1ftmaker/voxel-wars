// node tools/test/fracturecost.mjs: physics (box3d) step cost when a big body breaks into pieces that hit the terrain
// at once (the "bridge fractures" hitch) and while they rest: bullets, substeps and boxes per piece compared.
import { loadBox3d, B3World, BodyType } from '../../src/physics/box3d/B3.js';
import { VoxelWorld } from '../../src/voxel/VoxelWorld.js';
import { voxelize } from '../../src/voxel/voxelize.js';
import { surfaceNets } from '../../src/voxel/surfaceNets.js';
import { box } from '../../src/voxel/brushes.js';
import { Level } from '../../src/level/fortwar.js';
import { findIslands, detachIsland, splitGrid, voronoiLabels, gridPrep, colliderBoxes } from '../../src/voxel/islands.js';
import { CHUNK, PAD, CHUNK_M, VOXEL } from '../../src/config.js';
const M = await loadBox3d();
const world = new VoxelWorld(); voxelize(world, new Level());
// an 18 m brick deck in the field, cut loose
world.applyBrush(box([-9, 7.1, -1.5], [9, 8.3, 1.5]), { op: 'add', mat: 5 });
const r = world.applyBrush(box([-9.2, 6.8, -1.8], [9.2, 7.1, 1.8]), { hardness: false });
const deck = detachIsland(world, findIslands(world, r.box[0], [r.box[1][0], r.box[1][1] + 8, r.box[1][2]]).islands.sort((a, b) => b.count - a.count)[0], { notify: false }).grid;
console.log(`deck ${deck.count} samples`);
const P = CHUNK + 2 * PAD, sdf = new Int8Array(P ** 3), mat = new Uint8Array(P ** 3);
const mk = () => {
    const w = new B3World(M, { gravity: [0, -30, 0] });
    const fixed = w.createBody({ type: BodyType.Fixed });
    for(const c of world.chunks.values()) {
        if(Math.abs(c.cx) > 3 || Math.abs(c.cz) > 2) continue;
        if(!world.extractPadded(c.cx, c.cy, c.cz, sdf, mat)) continue;
        const m = surfaceNets(sdf, mat, CHUNK);
        if(!m.indices.length) continue;
        const v = m.positions.slice();
        for(let i = 0; i < v.length; i += 3) { v[i] += c.cx * CHUNK_M; v[i + 1] += c.cy * CHUNK_M; v[i + 2] += c.cz * CHUNK_M; }
        w.createMesh(fixed, v, m.indices);
    }
    for(let i = 0; i < 3; i++) w.step(1 / 60);
    return w;
};
const pieces = splitGrid(deck, voronoiLabels(deck, [9, 0.6, 1.5], 12, (() => { let s = 1; return () => (s = (s * 16807) % 2147483647) / 2147483647; })()), { minCount: 16 });
// variants: [label, bullet, siblings filtered, substeps, max boxes per piece]
const variants = [['default (4 substeps, 8 boxes)', false, true, 4, 8], ['bullets', true, true, 4, 8], ['2 substeps', false, true, 2, 8],
    ['4 boxes per piece', false, true, 4, 4], ['1 box per piece', false, true, 4, 1], ['default again', false, true, 4, 8]];
for(const [label, bullet, sib, substeps, maxBoxes] of variants) {
    const w = mk();
    w.substeps = substeps;
    const preps = pieces.map(p => { const pr = gridPrep(p, 1); pr.boxes = colliderBoxes(p, pr.stats.count, 1, maxBoxes); return pr; });
    const bodies = [];
    const t0 = performance.now();
    pieces.forEach((p, i) => {
        const st = preps[i].stats;
        const o = [(deck.offset[0] + p.offset[0]) * VOXEL + st.com[0], (deck.offset[1] + p.offset[1]) * VOXEL + st.com[1] - 4.4, (deck.offset[2] + p.offset[2]) * VOXEL + st.com[2]];
        const b = w.createBody({ position: o, linvel: [0, -16, 0], bullet });
        bodies.push(b);
        for(const x of preps[i].boxes) w.createBox(b, x.h, { center: [x.c[0] - st.com[0], x.c[1] - st.com[1], x.c[2] - st.com[2]], hitEvents: true,
            groups: sib ? (((0x0002 | 4) << 16) | (0xffff & ~4)) >>> 0 : 0xffffffff });
        b.setMass(st.mass);
    });
    const build = performance.now() - t0;
    const hits = [];
    const steps = [];
    for(let i = 0; i < 120; i++) { const t = performance.now(); hits.length = 0; w.step(1 / 60, hits); steps.push(performance.now() - t); }
    const late = steps.slice(20), avg = late.reduce((a, b) => a + b, 0) / late.length;
    const awake = bodies.filter(b => !b.isSleeping()).length;
    console.log(`${label.padEnd(32)} ${pieces.length} pieces ${preps.reduce((a, p) => a + p.boxes.length, 0)} boxes, build ${build.toFixed(1)} ms; impact steps worst ${Math.max(...steps.slice(0, 20)).toFixed(2)}, resting avg ${avg.toFixed(2)} max ${Math.max(...late).toFixed(2)} ms, awake at end ${awake}`);
    w.free();
}
