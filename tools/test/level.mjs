// node tools/test/level.mjs: the Twin Forts level (src/level/fortwar.js + showcase.js). Builds deterministically
// (every client generates it), keeps its tunnels, vaults and caches open (no pile runs through them), every
// material is used, and only the pieces meant to be loose (glass panes, crate stacks, the fort gates) are islands:
// every other structure is anchored.
import { VoxelWorld } from '../../src/voxel/VoxelWorld.js';
import { voxelize } from '../../src/voxel/voxelize.js';
import { Level } from '../../src/level/fortwar.js';
import { findIslands } from '../../src/voxel/islands.js';
import { VOXEL } from '../../src/config.js';

let fails = 0;
const check = (ok, msg) => { console.log(ok ? '  ok  ' : '  FAIL', msg); if(!ok) fails++; };

function build() {
    const t = performance.now();
    const w = new VoxelWorld();
    const r = voxelize(w, new Level());
    return { w, ms: performance.now() - t, ...r };
}
function hashWorld(w) {
    let h = 2166136261 >>> 0;
    const mix = (v) => { h ^= v & 255; h = Math.imul(h, 16777619) >>> 0; };
    for(const c of w.chunks.values()) {
        if(c.sdf) { for(let i = 0; i < c.sdf.length; i++) { mix(c.sdf[i]); mix(c.mat[i]); } }
        else { mix(c.fill); mix(c.fillMat); }
    }
    return h.toString(16);
}
const A = build(), B = build();
console.log(`build ${A.ms.toFixed(0)} / ${B.ms.toFixed(0)} ms, dense chunks ${A.dense}/${A.total}`);
check(hashWorld(A.w) === hashWorld(B.w), 'two builds are identical');

const w = A.w;
// open spaces: the vaults, their ramps, the sewers, the south tunnel, the caves, the caches (centre lines)
const air = [];
for(const s of [-1, 1]) {
    const X = v => -s * v + 0.1;
    air.push(['vault', [X(-55), -4, 0.1]], ['vault ramp', [X(-54.5), -1, 5]], ['sewer', [X(-40), -4.4, 0.1]], ['sewer jog', [X(-30), -4.4, 3]],
        ['sewer to gorge', [X(-18), -4.4, 5.1]], ['cave', [X(-43), 1.6, -22]], ['cache', [X(-46), -8.7, 6.6]], ['cache 2', [X(-14), -9.7, -11.4]],
        ['gate', [X(-37.3) + s * 1.5, 2, 0.1]]);
}
for(const x of [-40, -20, 0, 20, 40]) air.push(['south tunnel', [x + 0.1, 1.6, -27.4]]);
const blocked = air.filter(([, p]) => w.sample(...p) <= 0).map(([n, p]) => `${n} ${p.map(v => v.toFixed(1))}`);
check(blocked.length === 0, `tunnels, vaults, caches and gates open${blocked.length ? ': ' + blocked.join('; ') : ''}`);

// every material of the showcase is in the world
const counts = new Map();
for(const c of w.chunks.values()) {
    if(!c.sdf) { if(c.fill < 0) counts.set(c.fillMat, (counts.get(c.fillMat) || 0) + 32768); continue; }
    for(let i = 0; i < c.sdf.length; i++) if(c.sdf[i] < 0) counts.set(c.mat[i], (counts.get(c.mat[i]) || 0) + 1);
}
const names = { 0: 'stone', 1: 'dirt', 2: 'grass', 3: 'sand', 4: 'snow', 5: 'brick', 6: 'metal', 7: 'lava', 8: 'red stone', 9: 'blue stone', 10: 'wood x', 11: 'cobble', 12: 'dark rock', 14: 'wood y', 15: 'wood z', 16: 'glass' };
console.log('  volume by material (m³):', Object.entries(names).map(([id, n]) => `${n} ${((counts.get(+id) || 0) * VOXEL ** 3).toFixed(0)}`).join(', '));
const missing = Object.entries(names).filter(([id]) => !(counts.get(+id) > 0)).map(([, n]) => n);
check(missing.length === 0, `every material is used${missing.length ? ' (missing: ' + missing.join(', ') + ')' : ''}`);

// loose islands over the whole surface layer: only glass, wood crate stacks and gates may be loose
const t = performance.now();
const isl = findIslands(w, [w.smin[0], Math.round(-8 / VOXEL), w.smin[2]], [w.smax[0] - 1, w.smax[1] - 1, w.smax[2] - 1]).islands;
const byMat = {};
for(const i of isl) (byMat[names[i.mat] || i.mat] ||= []).push(i);
console.log(`  islands: ${isl.length} in ${(performance.now() - t).toFixed(0)} ms:`, Object.entries(byMat).map(([m, l]) => `${m} ${l.length} (largest ${(Math.max(...l.map(i => i.count)) * VOXEL ** 3).toFixed(1)} m³)`).join(', '));
const gate = (i) => i.mat === 14 && Math.abs(i.min[0] * VOXEL) > 36 && Math.abs(i.max[0] * VOXEL) < 38.5 && Math.abs(i.min[2] * VOXEL) < 2.5; // fort gates: loose doors by design
const bad = isl.filter(i => !(i.mat === 16 || gate(i) || ((i.mat === 10 || i.mat === 14) && i.count * VOXEL ** 3 < 12)));
check(bad.length === 0, `only panes, crate stacks and gates are loose${bad.length ? ': ' + bad.slice(0, 6).map(i => `${names[i.mat]} ${(i.count * VOXEL ** 3).toFixed(1)} m³ at ${i.min.map(v => (v * VOXEL).toFixed(1))}`).join('; ') : ''}`);
check(isl.filter(i => i.mat === 16).length >= 12, `glass panes are separate islands (${isl.filter(i => i.mat === 16).length})`);

console.log(fails ? `${fails} failed` : 'all ok');
process.exit(fails ? 1 : 0);
