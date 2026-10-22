// node tools/test/sph.mjs [--spacing 0.3] [--seconds 6]: the CPU fluid solver (src/fluid/cpuSolver.js, the WebGL2
// fallback's solver) on dam breaks in closed stone boxes carved into a VoxelWorld. Checks that it settles with a small
// density error, without NaNs, without particles leaving the box (SDF walls) or being lost, and reports ms per step:
// at the CPU fallback's settings, at the GPU solver's (finer, on the CPU here) and at the CPU fallback's full load.
import { VoxelWorld } from '../../src/voxel/VoxelWorld.js';
import { box } from '../../src/voxel/brushes.js';
import { PageSDF } from '../../src/fluid/sdfPages.js';
import { FluidSolver } from '../../src/fluid/cpuSolver.js';
import { CPU_SETTINGS, GPU_SETTINGS, STEP, WATER } from '../../src/fluid/params.js';

const args = process.argv.slice(2);
const val = (k, d) => { const i = args.indexOf(k); return i >= 0 ? +args[i + 1] : d; };
let fails = 0;
const check = (ok, msg) => { console.log(ok ? '  ok  ' : '  FAIL', msg); if(!ok) fails++; };

// stone boxes with a 6 x 4 x 3 m and a 10 x 4 x 6 m cavity (inner floor at y = 0), closed on every side
const world = new VoxelWorld();
const SMALL = [[0, 0, 0], [6, 4, 3]], BIG = [[20, 0, 0], [30, 4, 6]];
for(const IN of [SMALL, BIG]) {
    world.applyBrush(box(IN[0].map(v => v - 1), IN[1].map(v => v + 1)), { op: 'add', mat: 0, hardness: false });
    world.applyBrush(box(IN[0], IN[1]), { op: 'carve', hardness: false });
}

/** A column of water `column` (x extent from the cavity's -x wall, height) across the cavity's depth, released. */
function run(settings, label, column, seconds, IN = SMALL) {
    const sdf = new PageSDF(64).fromWorld(world);
    const s = new FluidSolver({ ...settings, sdf });
    const d = settings.spacing;
    let n = 0;
    for(let x = d * 0.6; x < column[0]; x += d) for(let y = d * 0.6; y < column[1]; y += d) for(let z = d * 0.6; z < IN[1][2] - IN[0][2] - d * 0.5; z += d) {
        if(n >= settings.cap) break;
        s.write(n++, IN[0][0] + x, IN[0][1] + y, IN[0][2] + z, WATER);
    }
    console.log(`${label}: spacing ${d} m, ${n} particles, ${settings.iterations} iterations x ${settings.substeps} substeps at 60 Hz`);
    const steps = Math.round(seconds / STEP);
    let ms = 0, msMax = 0, frontT = null;
    for(let k = 0; k < steps; k++) {
        s.step(STEP);
        if(k > 10) { ms += s.stats.ms; msMax = Math.max(msMax, s.stats.ms); }
        if(frontT === null && s.stats.max[0] > IN[1][0] - 0.5) frontT = (k + 1) * STEP;
    }
    ms /= steps - 11;
    let nan = 0, out = 0, dead = 0;
    const r = s.k.radius * 0.5;
    for(let i = 0; i < n; i++) {
        const o = i * 4, p = s.pos;
        if(!Number.isFinite(p[o]) || !Number.isFinite(p[o + 1]) || !Number.isFinite(p[o + 2]) || !Number.isFinite(s.vel[o])) nan++;
        if(p[o + 3] === 0) dead++;
        for(let a = 0; a < 3; a++) if(p[o + a] < IN[0][a] + r || p[o + a] > IN[1][a] - r) { out++; break; }
    }
    const e = s.densityError(), moving = s.movingFraction(0.25);
    console.log(`  front reached the far wall after ${frontT?.toFixed(2)} s; after ${seconds} s: max speed ${s.stats.maxSpeed.toFixed(3)} m/s, ` +
        `moving > 0.25 m/s ${(moving * 100).toFixed(1)} %, bulk density error |mean| ${(e.mean * 100).toFixed(2)} % compression ${(e.compression * 100).toFixed(2)} % max ${(e.max * 100).toFixed(1)} % (${e.n} particles), top y ${s.stats.max[1].toFixed(2)} m`);
    console.log(`  CPU solver: ${ms.toFixed(2)} ms per 60 Hz step (max ${msMax.toFixed(1)}), ${(ms / n * 1000).toFixed(2)} us per particle`);
    check(nan === 0, `${label}: no NaNs (${nan})`);
    check(dead === 0, `${label}: no particle lost (${dead})`);
    check(out === 0, `${label}: no particle outside the SDF walls (${out})`);
    check(frontT !== null && frontT < 2, `${label}: the dam breaks (front at the far wall in ${frontT?.toFixed(2)} s)`);
    check(e.mean < 0.03 && e.compression < 0.01, `${label}: settled bulk density error below 3 % (${(e.mean * 100).toFixed(2)} %), compression below 1 %`);
    check(moving < 0.02 && s.stats.maxSpeed < 1, `${label}: settled (${(moving * 100).toFixed(1)} % faster than 0.25 m/s, max ${s.stats.maxSpeed.toFixed(2)} m/s)`);
    return { n, ms };
}

const seconds = val('--seconds', 6);
run({ ...CPU_SETTINGS, spacing: val('--spacing', CPU_SETTINGS.spacing) }, 'CPU fallback settings', [2.4, 3.0], seconds);
run({ ...GPU_SETTINGS, cap: 4096 }, 'GPU settings (on the CPU)', [1.6, 2.4], seconds);
const load = run(CPU_SETTINGS, 'CPU fallback at full load', [5, 3.2], seconds * 2, BIG); // a 10 m box sloshes longer
check(load.ms < 12, `CPU fallback: ${load.n} particles step in ${load.ms.toFixed(1)} ms (a worker at 60 Hz has 16)`);
console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
