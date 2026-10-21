// node tools/test/restcost.mjs: Rapier step cost of 25 pieces resting on the terrain trimesh, by shape and CCD.
import RAPIER from '@dimforge/rapier3d-compat';
import { VoxelWorld } from '../../src/voxel/VoxelWorld.js';
import { voxelize } from '../../src/voxel/voxelize.js';
import { surfaceNets } from '../../src/voxel/surfaceNets.js';
import { Level } from '../../src/level/fortwar.js';
import { box } from '../../src/voxel/brushes.js';
import { CHUNK, PAD, CHUNK_M, VOXEL } from '../../src/config.js';
import { findIslands, detachIsland, splitGrid, voronoiLabels, gridHullPoints, gridStats, gridBoxes } from '../../src/voxel/islands.js';
await RAPIER.init();
const world = new VoxelWorld(); voxelize(world, new Level());
world.applyBrush(box([-42, 0.2, 9.2], [-35.5, 8, 9.9]), { hardness: false });
const r = world.applyBrush(box([-39.8, 0.2, 9.5], [-39.1, 8, 13.6]), { hardness: false });
const tower = detachIsland(world, findIslands(world, r.box[0], r.box[1]).islands.sort((a, b) => b.count - a.count)[0], { notify: false }).grid;
let seed = 3; const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const pieces = splitGrid(tower, voronoiLabels(tower, [2, 2, 2], 30, rand), { minCount: 40 }).slice(0, 25);
const P = CHUNK + 2 * PAD, sdf = new Int8Array(P ** 3), mat = new Uint8Array(P ** 3);
const tris = [];
for(const c of world.chunks.values()) {
    if(!world.extractPadded(c.cx, c.cy, c.cz, sdf, mat)) continue;
    const m = surfaceNets(sdf, mat, CHUNK); if(!m.indices.length) continue;
    const v = m.positions.slice(); for(let i = 0; i < v.length; i += 3) { v[i] += c.cx * CHUNK_M; v[i + 1] += c.cy * CHUNK_M; v[i + 2] += c.cz * CHUNK_M; }
    tris.push([v, m.indices]);
}
function run(kind, ccd, extra = {}) {
    const rw = new RAPIER.World({ x: 0, y: -30, z: 0 });
    for(const [v, i] of tris) rw.createCollider(RAPIER.ColliderDesc.trimesh(v, i));
    const bodies = [];
    pieces.forEach((g, k) => {
        const st = gridStats(g);
        const b = rw.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setCcdEnabled(ccd).setTranslation(-28 + (k % 5) * 3.2, 2 + Math.floor(k / 5) * 2.5, -6 + (k % 3)).setAngularDamping(extra.ad ?? 0.15).setLinearDamping(extra.ld ?? 0.02));
        const com = st.com;
        if(kind === 'hull') { const pts = gridHullPoints(g); for(let i = 0; i < pts.length; i += 3) { pts[i] -= com[0]; pts[i + 1] -= com[1]; pts[i + 2] -= com[2]; } rw.createCollider(RAPIER.ColliderDesc.convexHull(pts).setMass(st.mass).setFriction(0.8), b); }
        else if(kind === 'ball') rw.createCollider(RAPIER.ColliderDesc.ball(Math.cbrt(st.volume * 3 / 4 / Math.PI)).setMass(st.mass).setFriction(0.8), b);
        else if(kind === 'boxes') for(const x of gridBoxes(g, 2)) rw.createCollider(RAPIER.ColliderDesc.cuboid(...x.h).setTranslation(x.c[0] - com[0], x.c[1] - com[1], x.c[2] - com[2]).setDensity(2300).setFriction(0.8), b);
        else if(kind === 'roundhull') { const pts = gridHullPoints(g); for(let i = 0; i < pts.length; i += 3) { pts[i] -= com[0]; pts[i + 1] -= com[1]; pts[i + 2] -= com[2]; } rw.createCollider(RAPIER.ColliderDesc.roundConvexHull(pts, 0.05).setMass(st.mass).setFriction(0.8), b); }
        bodies.push(b);
    });
    const times = [];
    let firstSleep = -1;
    for(let i = 0; i < 300; i++) {
        const t = performance.now(); rw.step(); times.push(performance.now() - t);
        const asleep = bodies.filter(b => b.isSleeping()).length;
        if(firstSleep < 0 && asleep >= 20) firstSleep = i;
    }
    const avg = (a, b) => (times.slice(a, b).reduce((x, y) => x + y, 0) / (b - a)).toFixed(2);
    const awake = bodies.filter(b => !b.isSleeping()).length;
    console.log(`${kind.padEnd(9)} ccd=${ccd} ${JSON.stringify(extra)} fall ${avg(0, 60)} ms, rest(1-2s) ${avg(60, 120)} ms, 4-5s ${avg(240, 300)} ms, max ${Math.max(...times).toFixed(1)}, awake@5s ${awake}, 20 asleep at step ${firstSleep}`);
    rw.free();
}
for(const k of ['hull', 'boxes', 'ball', 'roundhull']) run(k, true);
run('hull', false);
run('boxes', false);
run('hull', true, { ad: 1.5, ld: 0.3 });
run('boxes', true, { ad: 1.5, ld: 0.3 });
