// node tools/test/structure.mjs: structural failure (src/voxel/structure.js). The untouched level holds everywhere;
// a bridge blown out at one end comes down; small craters and the intact bridge stand.
import { VoxelWorld } from '../../src/voxel/VoxelWorld.js';
import { voxelize } from '../../src/voxel/voxelize.js';
import { rock, box } from '../../src/voxel/brushes.js';
import { Level } from '../../src/level/fortwar.js';
import { findIslands, detachIsland } from '../../src/voxel/islands.js';
import { findCollapses } from '../../src/voxel/structure.js';
import { VOXEL } from '../../src/config.js';

const world = new VoxelWorld();
voxelize(world, new Level());
let fails = 0;
const check = (ok, msg) => { console.log(ok ? '  ok  ' : '  FAIL', msg); if(!ok) fails++; };
const S = (m) => Math.round(m / VOXEL);
const desc = (isl) => `${isl.count}@mat${isl.mat} ${isl.collapse.reason} [${isl.min.map(v => (v * VOXEL).toFixed(1))}]..[${isl.max.map(v => (v * VOXEL).toFixed(1))}]`;

// 1. the untouched level: sweep the whole surface in 8 m tiles (full height)
let n = 0, ms = 0, worst = 0, checked = 0;
const found = [];
for(let x = -80; x < 80; x += 8) for(let z = -40; z < 40; z += 8) {
    const r = findCollapses(world, [S(x), S(-8), S(z)], [S(x + 8) - 1, S(8), S(z + 8) - 1]);
    n++; ms += r.ms; worst = Math.max(worst, r.ms); checked += r.checked;
    for(const i of r.islands) found.push(desc(i));
}
console.log(`level sweep: ${n} tiles, ${(ms / n).toFixed(1)} ms mean, ${worst.toFixed(1)} ms worst, ${checked} hanging samples checked`);
check(found.length === 0, `untouched level: no collapses${found.length ? ': ' + found.slice(0, 6).join('; ') : ''}`);

/** Carve, cut islands, then collapses (as TerrainCore.brush). */
function edit(name, brush) {
    const r = world.applyBrush(brush, { op: 'carve' });
    const isl = findIslands(world, r.box[0], r.box[1], { erode: 48, near: brush });
    for(const i of isl.islands) detachIsland(world, i);
    const c = findCollapses(world, r.box[0], r.box[1]);
    console.log(`${name}: islands ${isl.islands.length} (${isl.ms.toFixed(1)} ms), collapses ${c.islands.length} (${c.ms.toFixed(1)} ms, ${c.checked} checked)${c.islands.length ? ': ' + c.islands.map(desc).join('; ') : ''}`);
    for(const i of c.islands) detachIsland(world, i);
    return c;
}
// 2. small crater in the middle of the bridge deck: stands
let c = edit('bridge deck crater r1.2', rock([0, -0.3, -2], 1.2, 3));
check(c.islands.length === 0, 'a small hole in the bridge: it stands');
// 3. ground blasts and a fort wall hole: nothing falls
c = edit('ground blast', rock([-25, 0, 5], 3, 4));
check(c.islands.length === 0, 'ground blast: nothing collapses');
c = edit('wall hole', rock([37.3, 2.5, -6], 1.6, 5));
check(c.islands.length === 0, 'hole in a fort wall: it stands');
// 4. blow out the bridge's west end: the span comes down at the east rim
c = edit('bridge west end blown', box([-10.5, -1.6, -5], [-7.2, 1.6, 5]));
const big = c.islands.reduce((a, i) => Math.max(a, i.count), 0);
check(big > 5000, `bridge blown out at one end collapses (largest piece ${big} samples = ${(big * VOXEL ** 3).toFixed(1)} m³)`);
check(c.islands.every(i => i.max[0] * VOXEL < 9.2), 'it breaks at the east rim, not beyond');
// 5. built cantilevers (a carve next to them triggers the check): a short dirt ledge holds, a long one snaps at the
// root; a stone beam of the same length holds (boxes overlap: samples on a shared face read 0, not solid)
world.applyBrush(box([-34, 0, -2], [-32, 4, 0]), { op: 'add', mat: 1 });
world.applyBrush(box([-32.5, 3, -2], [-29, 4, 0]), { op: 'add', mat: 1 });
c = edit('dirt ledge 3 m', rock([-29.2, 4, -1], 0.5, 9));
check(c.islands.length === 0, 'a 3 m dirt ledge holds');
world.applyBrush(box([-29.5, 3, -2], [-24, 4, 0]), { op: 'add', mat: 1 });
c = edit('dirt ledge 8 m', rock([-24.2, 4, -1], 0.5, 10));
check(c.islands.length > 0 && c.islands.every(i => i.min[0] * VOXEL > -32.6), 'an 8 m dirt ledge snaps near its root');
world.applyBrush(box([-34, 0, 6], [-32, 4, 8]), { op: 'add', mat: 0 });
world.applyBrush(box([-32.5, 3, 6], [-24, 4, 8]), { op: 'add', mat: 0 });
c = edit('stone beam 8 m', rock([-24.2, 4, 7], 0.5, 11));
check(c.islands.length === 0, 'an 8 m stone beam holds');
process.exit(fails ? 1 : 0);
