// node tools/test/brushbench.mjs [--save]: times VoxelWorld.applyBrush on a sequence of gameplay edits (blasts, drill
// capsules, punches, mason boxes, paints) over Fort War, and checks the resulting world against a saved hash, so an
// optimisation of the edit path can prove it changes no sample. --save writes the reference hash.
import fs from 'node:fs';
import { VoxelWorld } from '../../src/voxel/VoxelWorld.js';
import { voxelize } from '../../src/voxel/voxelize.js';
import { sphere, capsule, box, rock, rng } from '../../src/voxel/brushes.js';
import { Level } from '../../src/level/fortwar.js';

const world = new VoxelWorld();
let t = performance.now();
voxelize(world, new Level());
const voxMs = performance.now() - t;
const rand = rng(7);
const ops = [];
const surf = (x, z) => { const h = world.raycast([x, 30, z], [0, -1, 0], 60); return h ? h.point : [x, 0, z]; };
for(let i = 0; i < 160; i++) {
    const x = -75 + rand() * 150, z = -38 + rand() * 76, p = surf(x, z), k = i % 8;
    if(k < 3) ops.push(['blast', rock([p[0], p[1] - 0.3, p[2]], 2.4 + (i % 3), i + 1), { op: 'carve' }]);
    else if(k === 3) ops.push(['bigblast', rock(p, 5.6, i + 1), { op: 'carve' }]);
    else if(k === 4) ops.push(['drill', capsule([p[0], p[1] + 0.5, p[2]], [p[0] + 1.3, p[1] + 0.2, p[2]], 1.6), { op: 'carve' }]);
    else if(k === 5) ops.push(['punch', rock(p, 1.05, i + 1), { op: 'carve' }]);
    else if(k === 6) ops.push(['mason', box([p[0] - 2, p[1], p[2] - 0.5], [p[0] + 2, p[1] + 3, p[2] + 0.5], 0.06), { op: 'add', mat: 9 }]);
    else ops.push(['paint', sphere(p, 2), { op: 'paint', mat: 4 }]);
}
// warm up the JIT on a scratch world
const scratch = new VoxelWorld({ min: [0, 0, 0], max: [2, 2, 2] });
for(let k = 0; k < 20; k++) for(const [, b, o] of [['', sphere([8, 8, 8], 4), { op: 'add', mat: 1 }], ['', rock([8, 10, 8], 2, k), { op: 'carve' }], ['', capsule([6, 8, 6], [9, 8, 9], 1.5), { op: 'carve' }], ['', sphere([8, 6, 8], 2), { op: 'paint', mat: 5 }]]) scratch.applyBrush(b, o);
const times = new Map();
let changed = 0;
for(const [name, b, o] of ops) {
    t = performance.now();
    const r = world.applyBrush(b, o);
    const ms = performance.now() - t;
    changed += r.changed;
    if(!times.has(name)) times.set(name, []);
    times.get(name).push(ms);
}
let h = 0x811c9dc5;
const keys = [...world.chunks.keys()].sort();
for(const k of keys) {
    const c = world.chunks.get(k);
    if(!c.sdf) { h = Math.imul(h ^ (c.fill + 1000 * c.fillMat), 16777619); continue; }
    for(let i = 0; i < c.sdf.length; i++) h = Math.imul(h ^ ((c.sdf[i] & 255) | (c.mat[i] << 8)), 16777619);
}
h >>>= 0;
console.log(`voxelize ${voxMs.toFixed(0)} ms; ${ops.length} edits, ${changed} samples changed, world hash ${h.toString(16)}`);
for(const [name, ts] of times) {
    ts.sort((a, b) => a - b);
    console.log(`  ${name.padEnd(9)} n ${String(ts.length).padStart(3)}  mean ${(ts.reduce((a, b) => a + b, 0) / ts.length).toFixed(2)}  p50 ${ts[ts.length >> 1].toFixed(2)}  max ${ts[ts.length - 1].toFixed(2)} ms`);
}
const ref = new URL('./brushbench.ref', import.meta.url);
if(process.argv.includes('--save')) { fs.writeFileSync(ref, h.toString(16)); console.log('saved reference hash'); }
else if(fs.existsSync(ref)) { const want = fs.readFileSync(ref, 'utf8').trim(); console.log(want === h.toString(16) ? 'OK: world identical to the reference' : `MISMATCH: reference ${want}`); if(want !== h.toString(16)) process.exitCode = 1; }
