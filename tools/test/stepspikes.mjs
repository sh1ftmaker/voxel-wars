// node tools/test/stepspikes.mjs: which world changes make the next Rapier step expensive?
import RAPIER from '@dimforge/rapier3d-compat';
import { VoxelWorld } from '../../src/voxel/VoxelWorld.js';
import { voxelize } from '../../src/voxel/voxelize.js';
import { surfaceNets } from '../../src/voxel/surfaceNets.js';
import { Level } from '../../src/level/fortwar.js';
import { CHUNK, PAD, CHUNK_M } from '../../src/config.js';
await RAPIER.init();
const world = new VoxelWorld();
voxelize(world, new Level());
const rw = new RAPIER.World({ x: 0, y: -30, z: 0 });
const fixed = rw.createRigidBody(RAPIER.RigidBodyDesc.fixed());
const P = CHUNK + 2 * PAD, sdf = new Int8Array(P ** 3), mat = new Uint8Array(P ** 3);
const meshes = new Map(), cols = new Map();
let tb = 0;
for(const c of world.chunks.values()) {
    if(!world.extractPadded(c.cx, c.cy, c.cz, sdf, mat)) continue;
    const m = surfaceNets(sdf, mat, CHUNK);
    if(!m.indices.length) continue;
    const v = m.positions.slice();
    for(let i = 0; i < v.length; i += 3) { v[i] += c.cx * CHUNK_M; v[i + 1] += c.cy * CHUNK_M; v[i + 2] += c.cz * CHUNK_M; }
    meshes.set(c.key, [v, m.indices]);
    const t = performance.now();
    cols.set(c.key, rw.createCollider(RAPIER.ColliderDesc.trimesh(v, m.indices), fixed));
    tb += performance.now() - t;
}
console.log(`${cols.size} trimeshes built in ${tb.toFixed(0)} ms`);
const step = (label) => { const t = performance.now(); rw.step(); const ms = performance.now() - t; if(label) console.log(label.padEnd(40), ms.toFixed(2), 'ms'); return ms; };
for(let i = 0; i < 5; i++) step(i === 0 ? 'first step' : i === 4 ? 'idle step' : '');
// some dynamic boxes resting around x=-20
const bodies = [];
for(let i = 0; i < 20; i++) {
    const b = rw.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(-25 + (i % 5) * 2, 1 + Math.floor(i / 5) * 1.2, -4));
    rw.createCollider(RAPIER.ColliderDesc.cuboid(0.4, 0.4, 0.4), b); bodies.push(b);
}
step('add 20 bodies');
for(let i = 0; i < 60; i++) step();
step('20 bodies settled');
// replace one chunk's collider
const key = [...cols.keys()].find(k => k.startsWith('-3,-1'));
let t = performance.now();
rw.removeCollider(cols.get(key), false);
const [v, idx] = meshes.get(key);
cols.set(key, rw.createCollider(RAPIER.ColliderDesc.trimesh(v, idx), fixed));
console.log('replace trimesh'.padEnd(40), (performance.now() - t).toFixed(2), 'ms');
step('step after trimesh replace');
step('next step');
// replace 10 colliders
t = performance.now();
for(const k of [...cols.keys()].slice(40, 50)) { rw.removeCollider(cols.get(k), false); const [v2, i2] = meshes.get(k); cols.set(k, rw.createCollider(RAPIER.ColliderDesc.trimesh(v2, i2), fixed)); }
console.log('replace 10 trimeshes'.padEnd(40), (performance.now() - t).toFixed(2), 'ms');
step('step after 10 replaced');
// a big compound body
const big = rw.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(-20, 3, 5).setCcdEnabled(true));
for(let i = 0; i < 30; i++) rw.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5).setTranslation((i % 6) - 3, Math.floor(i / 6) * 0.5, 0), big);
step('add 30-box body (ccd)');
for(let i = 0; i < 40; i++) { const ms = step(); if(ms > 3) console.log('  spike while falling', ms.toFixed(2)); }
step('big body landed');
// collision group change on its colliders
t = performance.now();
for(let i = 0; i < big.numColliders(); i++) big.collider(i).setCollisionGroups(0x0002fffe);
step('step after group change');
