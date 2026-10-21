// node tools/test/support.mjs: structural support (src/voxel/support.js). The intact level must stand everywhere
// (prints the most loaded overhangs per material: SPAN_K calibration); a bridge blown out at one end must fall; a
// tunnel through a hill and a punched hole must not bring anything down.
import { VoxelWorld } from '../../src/voxel/VoxelWorld.js';
import { voxelize } from '../../src/voxel/voxelize.js';
import { rock, sphere, capsule } from '../../src/voxel/brushes.js';
import { Level } from '../../src/level/fortwar.js';
import { findUnsupported, SPAN } from '../../src/voxel/support.js';
import { findIslands, detachIsland } from '../../src/voxel/islands.js';
import { MATERIALS } from '../../src/voxel/materials.js';
import { VOXEL } from '../../src/config.js';

let fails = 0;
const check = (ok, msg) => { console.log(ok ? '  ok  ' : '  FAIL', msg); if(!ok) fails++; };
const fresh = () => { const w = new VoxelWorld(); voxelize(w, new Level()); return w; };
const S = (m) => Math.round(m / VOXEL);

// 1) the intact level: every overhang anywhere (tiles of 16 m, examined with the default margins)
{
    const world = fresh();
    let ms = 0, worst = 0;
    const failing = [];
    for(let x = world.smin[0]; x < world.smax[0]; x += 64) for(let z = world.smin[2]; z < world.smax[2]; z += 64) {
        const r = findUnsupported(world, [x, S(-8), z], [x + 63, S(10), z + 63]);
        ms = Math.max(ms, r.ms); worst = Math.max(worst, r.maxLoad);
        for(const i of r.islands) failing.push(`${MATERIALS[i.mat].name} ${(i.count * VOXEL ** 3).toFixed(0)} m³ at ${i.min.map(v => (v * VOXEL).toFixed(0))}`);
    }
    console.log(`intact level: slowest tile ${ms.toFixed(1)} ms, highest load ${worst.toFixed(2)} of the reach`);
    check(failing.length === 0, `nothing in the intact level falls (${failing.join(', ')})`);
}

/** Carve, then connectivity and support as the terrain worker does; returns the volumes (m³) that came off. */
function edit(world, brush, label) {
    const r = world.applyBrush(brush, { hardness: false });
    const isl = findIslands(world, r.box[0], r.box[1], { erode: 48, near: brush });
    let loose = 0;
    for(const i of isl.islands) loose += detachIsland(world, i, { keepGrid: false }).count * VOXEL ** 3;
    const sup = findUnsupported(world, r.box[0], r.box[1]);
    let fell = 0;
    for(const i of sup.islands) fell += detachIsland(world, i, { keepGrid: false }).count * VOXEL ** 3;
    console.log(`${label}: islands ${loose.toFixed(1)} m³, unsupported ${fell.toFixed(1)} m³ in ${sup.islands.length} pieces (${sup.ms.toFixed(1)} ms; highest load ${sup.maxLoad.toFixed(2)})`);
    return { loose, fell };
}

// 2) the gorge bridge (cobble deck x -8.6..8.6, z -4..4, y -1..0, plaza x -6..6 z -9..9): blow out its west end
{
    const world = fresh();
    let r = { fell: 0, loose: 0 };
    for(const z of [-3.2, 0, 3.2]) { const e = edit(world, rock([-7.6, -0.5, z], 1.8, 7), `west end z ${z}`); r.fell += e.fell; r.loose += e.loose; }
    check(r.fell + r.loose > 80, `the bridge comes down when its west end is blown out (${(r.fell + r.loose).toFixed(0)} m³)`);
}
// 3) a hole in the middle of the bridge deck: both halves stay held at their ends
{
    const world = fresh();
    const e = edit(world, rock([0, -0.5, -2.5], 1.6, 3), 'hole mid deck');
    check(e.fell < 1, `a hole in the deck brings nothing down (${e.fell.toFixed(1)} m³)`);
}
// 4) a tunnel through the ground, and a wall punched through
{
    const world = fresh();
    const e = edit(world, capsule([20, -2, -10], [20, -2, 6], 1.3), 'tunnel');
    check(e.fell < 1, `a tunnel brings nothing down (${e.fell.toFixed(1)} m³)`);
    const w = edit(world, rock([37, 2.5, 0], 1.2, 5), 'wall hole');
    check(w.fell < 1, `a hole through a fort wall brings nothing down (${w.fell.toFixed(1)} m³)`);
}
// 5) a cliff undercut: dig a cave far under a ledge of dirt
{
    const world = fresh();
    let fell = 0;
    for(let i = 0; i < 6; i++) fell += edit(world, capsule([24 + i * 1.6, -2.2, -14], [24 + i * 1.6, -2.2, -2], 1.4), `cave ${i}`).fell;
    console.log(`  undercut cave: ${fell.toFixed(1)} m³ fell`);
}
console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
