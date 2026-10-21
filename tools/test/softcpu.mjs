/**
 * CPU soft solver check (node): a full-size zone around a ground point of the Fort War level, kicked like a blast;
 * prints solver cost per frame and the displacement over time, checks it springs back / keeps a plastic dent.
 * node tools/test/softcpu.mjs [x z] [--iters 2] [--rate 60] [--speed 19] [--full (no surface shell)]
 */
import { VoxelWorld } from '../../src/voxel/VoxelWorld.js';
import { voxelize } from '../../src/voxel/voxelize.js';
import { Level } from '../../src/level/fortwar.js';
import { classifyZone, H, SPC, MAX_DIM } from '../../src/soft/core.js';
import { readRegion } from '../../src/soft/region.js';
import { CpuSoft, P_SLOTA, P_SLOTB, P_SLOTC, P_KICKA, P_KICKB, P_KICKC } from '../../src/soft/cpuSolver.js';
import { BEDROCK_SAMPLES } from '../../src/config.js';

const args = process.argv.slice(2);
const opt = (k, d) => args.includes(k) ? +args[args.indexOf(k) + 1] : d;
const nums = args.filter(a => /^-?\d/.test(a) && !['--iters', '--rate'].includes(args[args.indexOf(a) - 1])).map(Number);
const [px, pz] = nums.length >= 2 ? nums : [-58, 6];
const iterations = opt('--iters', 2), rate = opt('--rate', 60); // the game's CPU settings (SoftGround)

const world = new VoxelWorld();
let t = performance.now();
voxelize(world, new Level());
console.log(`world ${(performance.now() - t).toFixed(0)} ms`);
const hit = world.raycast([px, 30, pz], [0, -1, 0], 60);
const p = hit.point;
console.log('ground', p.map(v => v.toFixed(2)).join(' '), 'mat', hit.mat);

// the biggest zone SoftGround makes (a strong blast)
const hor = 5.5, below = 3.5, above = 2.2;
let lo = [Math.floor((p[0] - hor) / H), Math.floor((p[1] - below) / H), Math.floor((p[2] - hor) / H)];
let hi = [Math.ceil((p[0] + hor) / H), Math.ceil((p[1] + above) / H), Math.ceil((p[2] + hor) / H)];
for(let a = 0; a < 3; a++) { const pc = Math.floor(p[a] / H); while(hi[a] - lo[a] > MAX_DIM[a]) { if(hi[a] - pc > pc - lo[a]) hi[a]--; else lo[a]++; } }
const n = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
const region = readRegion(world, lo.map(v => (v - 1) * SPC), lo.map((v, i) => (v + n[i] + 1) * SPC));
const z = classifyZone(region, lo, n, world.smin[1] + BEDROCK_SAMPLES, undefined, { shell: !args.includes("--full") });
console.log('zone', n.join('x'), 'cells', z.count, 'tets', z.count * 5);

const sim = new CpuSoft({ iterations, rate });
sim.upload(0, { ...z, n }, true);
const P = sim.P;
P.set([lo[0] * H, lo[1] * H, lo[2] * H, 1], P_SLOTA * 4);
P.set([n[0] + 1, n[1] + 1, n[2] + 1, z.count], P_SLOTB * 4);
P.set([0, 0, 0, 0], P_SLOTC * 4);
P.set([p[0], p[1], p[2], 3.5], P_KICKA * 4);
P.set([0, 0, 0, +(args.includes("--speed") ? args[args.indexOf("--speed") + 1] : 19)], P_KICKB * 4);
P.set([0, 0.45, 0, 0], P_KICKC * 4);
const dt = 1 / rate, NX = n[0] + 1, NY = n[1] + 1;
const centre = Math.round((p[0] - lo[0] * H) / H) + Math.round((p[1] - lo[1] * H) / H) * NX + Math.round((p[2] - lo[2] * H) / H) * NX * NY;
const maxU = () => { const u = sim.slots[0].pos; let m = 0; for(let i = 0; i < u.length; i += 3) m = Math.max(m, Math.hypot(u[i], u[i + 1], u[i + 2])); return m; };
const perFrame = Math.round(rate / 60);
const times = [];
for(let f = 0; f < 150; f++) {
    const t0 = performance.now();
    sim.step(perFrame, dt, f === 0);
    times.push(performance.now() - t0);
    if(f === 0) P[P_KICKA * 4 + 3] = 0;
    if(f % 10 === 0 || f < 6) {
        const u = sim.slots[0].pos, c = centre * 3;
        console.log(`f${String(f).padStart(3)} ${times.at(-1).toFixed(2)} ms  max|u| ${maxU().toFixed(3)}  centre u ${[u[c], u[c + 1], u[c + 2]].map(v => v.toFixed(3)).join(' ')}`);
    }
}
times.sort((a, b) => a - b);
console.log(`per frame (${perFrame} substeps x ${iterations} it): median ${times[75].toFixed(2)} ms, p95 ${times[142].toFixed(2)} ms, max ${times[149].toFixed(2)} ms`);
const rest = sim.slots[0].rest; let mr = 0; for(let i = 0; i < rest.length; i += 3) mr = Math.max(mr, Math.hypot(rest[i], rest[i + 1], rest[i + 2]));
console.log('final max|u|', maxU().toFixed(3), 'plastic max|rest|', mr.toFixed(3));
if(!(maxU() < 1)) { console.error('FAIL: unstable'); process.exit(1); }
