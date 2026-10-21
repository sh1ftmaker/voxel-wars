// node tools/test/fracturecost.mjs: Rapier step cost when a big body breaks into pieces that hit the terrain at once
// (the "bridge fractures" hitch) and while they rest: CCD, solver iterations and boxes per piece compared.
import RAPIER from '@dimforge/rapier3d-compat';
import { VoxelWorld } from '../../src/voxel/VoxelWorld.js';
import { voxelize } from '../../src/voxel/voxelize.js';
import { surfaceNets } from '../../src/voxel/surfaceNets.js';
import { box } from '../../src/voxel/brushes.js';
import { Level } from '../../src/level/fortwar.js';
import { findIslands, detachIsland, splitGrid, voronoiLabels, gridPrep, colliderBoxes } from '../../src/voxel/islands.js';
import { CHUNK, PAD, CHUNK_M, VOXEL } from '../../src/config.js';
await RAPIER.init();
const world = new VoxelWorld(); voxelize(world, new Level());
// an 18 m brick deck in the field, cut loose
world.applyBrush(box([-9, 7.1, -1.5], [9, 8.3, 1.5]), { op: 'add', mat: 5 });
const r = world.applyBrush(box([-9.2, 6.8, -1.8], [9.2, 7.1, 1.8]), { hardness: false });
const deck = detachIsland(world, findIslands(world, r.box[0], [r.box[1][0], r.box[1][1] + 8, r.box[1][2]]).islands.sort((a, b) => b.count - a.count)[0], { notify: false }).grid;
console.log(`deck ${deck.count} samples`);
const P = CHUNK + 2 * PAD, sdf = new Int8Array(P ** 3), mat = new Uint8Array(P ** 3);
const mk = () => {
    const rw = new RAPIER.World({ x: 0, y: -30, z: 0 });
    for(const c of world.chunks.values()) {
        if(Math.abs(c.cx) > 3 || Math.abs(c.cz) > 2) continue;
        if(!world.extractPadded(c.cx, c.cy, c.cz, sdf, mat)) continue;
        const m = surfaceNets(sdf, mat, CHUNK);
        if(!m.indices.length) continue;
        const v = m.positions.slice();
        for(let i = 0; i < v.length; i += 3) { v[i] += c.cx * CHUNK_M; v[i + 1] += c.cy * CHUNK_M; v[i + 2] += c.cz * CHUNK_M; }
        rw.createCollider(RAPIER.ColliderDesc.trimesh(v, m.indices));
    }
    for(let i = 0; i < 3; i++) rw.step();
    return rw;
};
const pieces = splitGrid(deck, voronoiLabels(deck, [9, 0.6, 1.5], 12, (() => { let s = 1; return () => (s = (s * 16807) % 2147483647) / 2147483647; })()), { minCount: 16 });
// variants: [label, ccd, siblings filtered, solver iterations, max boxes per piece]
const variants = [['default (ccd, 4 iters, 8 boxes)', true, true, 4, 8], ['no ccd', false, true, 4, 8], ['2 solver iterations', true, true, 2, 8],
    ['4 boxes per piece', true, true, 4, 4], ['1 box per piece', true, true, 4, 1], ['default again', true, true, 4, 8]];
for(const [label, ccd, sib, iters, maxBoxes] of variants) {
    const rw = mk();
    if(rw.integrationParameters.numSolverIterations !== undefined) rw.integrationParameters.numSolverIterations = iters;
    const preps = pieces.map(p => { const pr = gridPrep(p, 1); pr.boxes = colliderBoxes(p, pr.stats.count, 1, maxBoxes); return pr; });
    const t0 = performance.now();
    pieces.forEach((p, i) => {
        const st = preps[i].stats;
        const o = [(deck.offset[0] + p.offset[0]) * VOXEL + st.com[0], (deck.offset[1] + p.offset[1]) * VOXEL + st.com[1] - 4.4, (deck.offset[2] + p.offset[2]) * VOXEL + st.com[2]];
        const b = rw.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(...o).setLinvel(0, -16, 0).setCcdEnabled(ccd));
        for(const x of preps[i].boxes) rw.createCollider(RAPIER.ColliderDesc.cuboid(...x.h).setTranslation(x.c[0] - st.com[0], x.c[1] - st.com[1], x.c[2] - st.com[2]).setMass(st.mass / preps[i].boxes.length)
            .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(st.mass * 3 * 60).setCollisionGroups(sib ? (((0x0002 | 4) << 16) | (0xffff & ~4)) >>> 0 : 0xffffffff), b);
    });
    const build = performance.now() - t0;
    const q = new RAPIER.EventQueue(true);
    const steps = [];
    for(let i = 0; i < 120; i++) { const t = performance.now(); rw.step(q); q.drainContactForceEvents(() => {}); steps.push(performance.now() - t); }
    const late = steps.slice(20), avg = late.reduce((a, b) => a + b, 0) / late.length;
    let awake = 0; rw.forEachRigidBody(b => { if(b.isDynamic() && !b.isSleeping()) awake++; });
    console.log(`${label.padEnd(32)} ${pieces.length} pieces ${preps.reduce((a, p) => a + p.boxes.length, 0)} boxes, build ${build.toFixed(1)} ms; impact steps worst ${Math.max(...steps.slice(0, 20)).toFixed(2)}, resting avg ${avg.toFixed(2)} max ${Math.max(...late).toFixed(2)} ms, awake at end ${awake}`);
}
