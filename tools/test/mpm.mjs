/**
 * PB-MPM granular ground, CPU solver (src/mpm/cpuSolver.js) in Node: the physics checks.
 *   1. sand column collapse: a 2 m column on flat ground settles into a pile; reports the angle of repose (the pile's
 *      flank slope fitted over its middle) and the runout; dirt likewise (steeper)
 *   2. snow: a block dropped on the ground compresses (Jp < 1 where it hit) and holds together (one clump)
 *   3. lava paste spreads slowly and stays together
 *   4. no NaNs, every particle inside the zone and above the terrain; ms per step at the CPU cap
 *   5. grain selection (src/mpm/grains.js) on a sand dune in a real VoxelWorld: undercut -> unstable voxels; deposit
 *      round trip conserves the volume
 * node tools/test/mpm.mjs [--iters N] [--sub N] [--quick]
 */
import { MpmSolverCPU } from '../../src/mpm/cpuSolver.js';
import { ZONE_DIMS, H, unpackW, GRANULAR } from '../../src/mpm/params.js';

const args = process.argv.slice(2);
const val = (k, d) => { const i = args.indexOf(k); return i >= 0 ? +args[i + 1] : d; };
const knobs = { iterations: val('--iters', 3), substeps: val('--sub', 1) };
let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if(!ok) failed++; };

/** A zone over flat ground: solid below node row `ground`. */
function flatZone(s, ground = 4, dims = ZONE_DIMS) {
    const [nx, ny, nz] = dims, sdf = new Int8Array(nx * ny * nz);
    for(let k = 0; k < nz; k++) for(let j = 0; j < ny; j++) for(let i = 0; i < nx; i++) sdf[i + j * nx + k * nx * ny] = Math.max(-127, Math.min(127, Math.round((j - ground) * 32)));
    s.setZone(0, { lo: [0, 0, 0], dims, sdf, wall: 0.6 });
}
/** Particles filling a box of cells (8 per cell, jittered). */
function boxParticles(lo, hi, mat, rnd = mulberry(7)) {
    const pos = [], mats = [];
    for(let k = lo[2]; k < hi[2]; k++) for(let j = lo[1]; j < hi[1]; j++) for(let i = lo[0]; i < hi[0]; i++)
        for(let s = 0; s < 8; s++) { pos.push(i + 0.25 + 0.5 * (s & 1) + (rnd() - 0.5) * 0.2, j + 0.25 + 0.5 * ((s >> 1) & 1) + (rnd() - 0.5) * 0.2, k + 0.25 + 0.5 * (s >> 2) + (rnd() - 0.5) * 0.2); mats.push(mat); }
    return { pos: Float32Array.from(pos), mats: Uint8Array.from(mats) };
}
function mulberry(a) { return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function sane(s, ground) {
    let nan = 0, out = 0, under = 0;
    const d = ZONE_DIMS;
    for(let p = 0; p < s.n; p++) {
        for(let a = 0; a < 3; a++) { const v = s.x[p * 3 + a]; if(!Number.isFinite(v)) nan++; else if(v < 0 || v > d[a] - 1) out++; }
        for(let i = 0; i < 9; i++) if(!Number.isFinite(s.F[p * 9 + i])) nan++;
        if(s.x[p * 3 + 1] < ground - 0.6) under++;
    }
    return { nan, out, under };
}
/** Pile shape: height (top particle, m above the ground) per radial ring of 0.25 m around the centre. */
function profile(s, cx, cz, ground) {
    const top = [];
    for(let p = 0; p < s.n; p++) {
        const r = Math.hypot(s.x[p * 3] - cx, s.x[p * 3 + 2] - cz) * H, b = Math.floor(r / 0.25);
        top[b] = Math.max(top[b] ?? 0, (s.x[p * 3 + 1] - ground) * H);
    }
    for(let i = 0; i < top.length; i++) top[i] ??= 0;
    return top;
}
/** Angle of repose: least-squares slope of the flank (between 20% and 80% of the peak height). */
function reposeAngle(top) {
    const peak = Math.max(...top);
    const pts = [];
    for(let i = 0; i < top.length; i++) if(top[i] > peak * 0.2 && top[i] < peak * 0.8) pts.push([(i + 0.5) * 0.25, top[i]]);
    if(pts.length < 2) return { angle: 90, peak, runout: 0 };
    const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length, my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    let sxy = 0, sxx = 0;
    for(const [x, y] of pts) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; }
    let runout = 0;
    for(let i = 0; i < top.length; i++) if(top[i] > 0.05) runout = (i + 1) * 0.25;
    return { angle: Math.atan(Math.abs(sxy / sxx)) * 180 / Math.PI, peak, runout };
}

function columnCollapse(mat, label, seconds = 4) {
    const s = new MpmSolverCPU({ cap: 8192 });
    Object.assign(s.knobs, knobs);
    const ground = 4;
    flatZone(s, ground);
    // a 2 m tall, 1.5 m square column in the middle of the zone
    const c = [24, 24];
    const { pos, mats } = boxParticles([c[0] - 3, ground, c[1] - 3], [c[0] + 3, ground + 8, c[1] + 3], mat);
    s.spawn(0, pos, null, mats, 0);
    const dt = 1 / 60;
    let ms = 0, steps = 0, settledAt = -1;
    for(let f = 0; f < seconds * 60; f++) {
        const t0 = performance.now(); s.step(dt); ms += performance.now() - t0; steps++;
        if(settledAt < 0 && f > 30) { const st = s.zoneStats(0); if(st.moving < st.count * 0.03) settledAt = f / 60; }
    }
    const top = profile(s, c[0], c[1], ground), rep = reposeAngle(top);
    const sn = sane(s, ground);
    console.log(`${label}: ${s.n} particles, ${(ms / steps).toFixed(2)} ms/step (${knobs.substeps} substep x ${knobs.iterations} iterations), settled ${settledAt >= 0 ? settledAt.toFixed(2) + ' s' : 'no'}; pile peak ${rep.peak.toFixed(2)} m, runout ${rep.runout.toFixed(2)} m, angle of repose ${rep.angle.toFixed(1)} deg`);
    console.log('  profile (m per 0.25 m ring):', top.map(v => v.toFixed(2)).join(' '));
    return { s, rep, sn, settledAt, msPerStep: ms / steps };
}

// ---- 1. sand and dirt column collapse
const sand = columnCollapse(3, 'sand column');
check(sand.sn.nan === 0 && sand.sn.out === 0, `sand: no NaNs (${sand.sn.nan}), all inside the zone (${sand.sn.out} out)`);
check(sand.sn.under < sand.s.n * 0.01, `sand: particles stay above the ground (${sand.sn.under} under)`);
check(sand.rep.peak < 1.9 && sand.rep.runout > 1.2, `sand: the column collapses (peak ${sand.rep.peak.toFixed(2)} of 2 m, runout ${sand.rep.runout.toFixed(2)} m)`);
check(sand.rep.angle > 18 && sand.rep.angle < 45, `sand: angle of repose ${sand.rep.angle.toFixed(1)} deg is plausible (18-45; friction angle ${GRANULAR[3].friction})`);
check(sand.settledAt > 0, `sand: comes to rest (${sand.settledAt.toFixed(2)} s)`);
const dirt = columnCollapse(1, 'dirt column');
check(dirt.sn.nan === 0 && dirt.sn.out === 0, 'dirt: no NaNs, inside');
check(dirt.rep.angle >= sand.rep.angle - 2, `dirt stands at least as steep as sand (${dirt.rep.angle.toFixed(1)} vs ${sand.rep.angle.toFixed(1)} deg)`);

// ---- 1b. the CPU fallback's cost at its cap (2 iterations, as the WebGL2 path runs it)
{
    const { CPU_CAP } = await import('../../src/mpm/params.js');
    const s = new MpmSolverCPU({ cap: CPU_CAP });
    s.knobs.iterations = 2;
    flatZone(s, 4);
    const side = Math.floor(Math.cbrt(CPU_CAP / 8));
    const { pos, mats } = boxParticles([24 - side, 4, 24 - side], [24 + side, 4 + Math.floor(CPU_CAP / 8 / (4 * side * side)), 24 + side], 3);
    s.spawn(0, pos, null, mats, 0);
    let ms = 0;
    for(let f = 0; f < 90; f++) { const t0 = performance.now(); s.step(1 / 60); if(f >= 30) ms += performance.now() - t0; }
    console.log(`CPU fallback: ${s.n} particles (cap ${CPU_CAP}), 2 iterations: ${(ms / 60).toFixed(2)} ms/step`);
    check(ms / 60 < 16, `the CPU fallback keeps up with 60 Hz in its worker at the cap (${(ms / 60).toFixed(1)} ms/step)`);
}

// ---- 2. snow block dropped from 1.5 m
{
    const s = new MpmSolverCPU({ cap: 8192 });
    Object.assign(s.knobs, knobs);
    const ground = 4;
    flatZone(s, ground);
    const { pos, mats } = boxParticles([20, ground + 6, 20], [28, ground + 10, 28], 4);
    s.spawn(0, pos, null, mats, 0);
    for(let f = 0; f < 150; f++) s.step(1 / 60);
    let jMin = Infinity, jMean = 0;
    for(let p = 0; p < s.n; p++) { jMin = Math.min(jMin, s.pl[p]); jMean += s.pl[p]; }
    jMean /= s.n;
    // clumps: connected components of particles closer than 0.75 cell
    const comps = components(s, 0.75);
    const sn = sane(s, ground);
    const height = (Math.max(...Array.from({ length: s.n }, (_, p) => s.x[p * 3 + 1])) - ground) * H;
    console.log(`snow block: ${s.n} particles, Jp mean ${jMean.toFixed(3)} min ${jMin.toFixed(3)}, ${comps.length} clumps (largest ${comps[0]} particles), height ${height.toFixed(2)} m (was 1.0)`);
    check(sn.nan === 0 && sn.out === 0, 'snow: no NaNs, inside');
    check(jMean < 0.99, `snow compresses on impact (mean Jp ${jMean.toFixed(3)} < 1)`);
    check(comps[0] > s.n * 0.8, `snow holds together (largest clump ${(comps[0] / s.n * 100).toFixed(0)}% of the block)`);
}
// ---- 3. lava paste
{
    const s = new MpmSolverCPU({ cap: 8192 });
    Object.assign(s.knobs, knobs);
    const ground = 4;
    flatZone(s, ground);
    const { pos, mats } = boxParticles([21, ground, 21], [27, ground + 6, 27], 7);
    s.spawn(0, pos, null, mats, 0);
    for(let f = 0; f < 120; f++) s.step(1 / 60);
    const top = profile(s, 24, 24, ground), rep = reposeAngle(top);
    const sn = sane(s, ground);
    console.log(`lava paste: peak ${rep.peak.toFixed(2)} m (was 1.5), runout ${rep.runout.toFixed(2)} m after 2 s`);
    check(sn.nan === 0 && sn.out === 0, 'lava: no NaNs, inside');
    check(rep.peak < 1.45, 'lava slumps');
}

// ---- 5. the level: blast the red sand dune in the terrain core, simulate the grains, deposit them back
if(!args.includes('--quick')) {
    const { TerrainCore } = await import('../../src/voxel/TerrainCore.js');
    const { rock } = await import('../../src/voxel/brushes.js');
    const { readRegion } = await import('../../src/soft/region.js');
    const { zoneLo, zoneField, seed, dropStranded } = await import('../../src/mpm/zone.js');
    const { depositPatch } = await import('../../src/mpm/grains.js');
    const core = new TerrainCore();
    let t0 = performance.now();
    core.handle({ type: 'init' });
    console.log(`level built in ${(performance.now() - t0).toFixed(0)} ms`);
    const w = core.world;
    const solidVol = (lo, hi) => { const r = readRegion(w, lo, hi); let v = 0; for(const s of r.sdf) v += Math.min(1, Math.max(0, 0.5 - s / 32)); return v * H ** 3; };
    const sites = [['dune', [-14.1, 0.6, -17.1], 3], ['berm', [-14.0, 0.5, 9.3], 1], ['snow cap', [-21.3, 8.7, 25.2], 4]];
    for(const [name, c, matId] of sites) {
        const lo = zoneLo(c), hiZ = lo.map((v, a) => v + ZONE_DIMS[a] - 1), loM = [lo[0], lo[1] - 48, lo[2]]; // measured down to the ground
        const before = solidVol(loM, hiZ);
        const brush = rock(c, 1.4, 11);
        t0 = performance.now();
        const { reply } = core.handle({ type: 'brush', spec: brush.spec, op: 'carve', mat: 1, hardness: true, conn: true, erode: 0, debris: 16, grains: { c, r: 1.4, blast: true } });
        const ms = performance.now() - t0;
        const g = reply.grains;
        const afterCarve = solidVol(loM, hiZ);
        const gm = g ? [...new Set(g.mat)].join(',') : '-';
        console.log(`${name}: blast + grain selection ${ms.toFixed(1)} ms (selection ${reply.grainsMs?.toFixed(1)} ms): ${g?.count ?? 0} grain voxels (materials ${gm}); terrain ${before.toFixed(2)} -> ${afterCarve.toFixed(2)} m³`);
        check(g && g.count > 50, `${name}: the blast frees granular voxels (${g?.count ?? 0})`);
        if(!g) continue;
        check(g.mat.every(m => GRANULAR[m]), `${name}: only granular materials become grains`);
        check(g.mat.includes(matId), `${name}: material ${matId} among the grains`);
        // simulate them in a zone around the blast
        const s = new MpmSolverCPU({ cap: 32768 });
        Object.assign(s.knobs, knobs);
        s.setZone(0, { lo, sdf: zoneField(w, lo, readRegion), wall: 0.6 });
        const sd = seed(g, lo, { ppcLog: 0, c, kick: 6, rim: 2.5, rand: mulberry(3) });
        s.spawn(0, sd.pos, sd.vel, sd.mats, sd.ppcLog);
        const grainVol = sd.n / 8 * H ** 3;
        let f = 0, settled = false;
        for(; f < 600; f++) { s.step(1 / 60); if(f > 30 && f % 10 === 0) { const st = s.zoneStats(0); if(st.moving < st.count * 0.02) { settled = true; break; } } }
        const sn = sane(s, -1e9);
        check(sn.nan === 0, `${name}: no NaNs`);
        check(settled, `${name}: the grains settle (${(f / 60).toFixed(2)} s, ${s.n} particles)`);
        const rd = s.read(0);
        const dropped = dropStranded(rd.pos, lo, w);
        if(dropped) console.log(`${name}: ${dropped} particles ran out of the zone and drop to the ground`);
        const patch = depositPatch(rd.pos, rd.w, { solidAt: (x, y, z) => w.get(x, y, z) < 0 });
        core.handle({ type: 'deposit', patch });
        const after = solidVol(loM, hiZ);
        const lost = before - (after - afterCarve) - afterCarve;
        console.log(`${name}: particles ${grainVol.toFixed(2)} m³ -> deposit patch ${patch.volume.toFixed(2)} m³; terrain after deposit ${after.toFixed(2)} m³ (the grains' share came back: ${((after - afterCarve) / (before - afterCarve - (before - afterCarve - grainVol)) * 100).toFixed(0)}% of ${grainVol.toFixed(2)} m³)`);
        const back = (after - afterCarve) / grainVol;
        check(back > 0.6 && back < 1.4, `${name}: the deposit restores the grains' volume (${(back * 100).toFixed(0)}%)`);
    }
}

// ---- 6. multiplayer: the grain carve and the deposit are deterministic (two cores, the same edits, the same chunks)
if(!args.includes('--quick')) {
    const { TerrainCore } = await import('../../src/voxel/TerrainCore.js');
    const { rock } = await import('../../src/voxel/brushes.js');
    const { depositPatch } = await import('../../src/mpm/grains.js');
    const cores = [new TerrainCore(), new TerrainCore()];
    for(const c of cores) c.handle({ type: 'init' });
    const c = [-14.1, 0.6, -17.1], spec = rock(c, 1.4, 5).spec;
    const reps = cores.map(core => core.handle({ type: 'brush', spec, op: 'carve', mat: 1, hardness: true, conn: true, erode: 0, debris: 16, grains: { c, r: 1.4, blast: true } }).reply);
    const same = reps[0].grains.count === reps[1].grains.count && reps[0].grains.idx.every((v, i) => v === reps[1].grains.idx[i]);
    check(same, `the same grains on two clients (${reps[0].grains.count})`);
    // the host's deposit (any particle positions) applied on both
    const g = reps[0].grains, pos = new Float32Array(g.count * 3), w = new Int32Array(g.count);
    for(let n = 0; n < g.count; n++) { pos[n * 3] = g.idx[n * 3] * H + 0.3; pos[n * 3 + 1] = g.idx[n * 3 + 1] * H - 0.2; pos[n * 3 + 2] = g.idx[n * 3 + 2] * H; w[n] = (3 << 5) | g.mat[n]; }
    const patch = depositPatch(pos, w);
    for(const core of cores) core.handle({ type: 'deposit', patch });
    const h = cores.map(core => new Map(core.hashes()));
    let diff = 0; for(const [k, v] of h[0]) if(h[1].get(k) !== v) diff++;
    check(diff === 0, `the same terrain on two clients after the grains and the deposit (${diff} chunks differ)`);
}

function components(s, r) {
    const n = s.n, cell = new Map(), key = (x, y, z) => `${x},${y},${z}`;
    for(let p = 0; p < n; p++) { const k = key(Math.floor(s.x[p * 3] / r), Math.floor(s.x[p * 3 + 1] / r), Math.floor(s.x[p * 3 + 2] / r)); if(!cell.has(k)) cell.set(k, []); cell.get(k).push(p); }
    const lab = new Int32Array(n).fill(-1), sizes = [];
    for(let p = 0; p < n; p++) {
        if(lab[p] >= 0) continue;
        const st = [p]; lab[p] = sizes.length; let c = 0;
        while(st.length) {
            const q = st.pop(); c++;
            const cx = Math.floor(s.x[q * 3] / r), cy = Math.floor(s.x[q * 3 + 1] / r), cz = Math.floor(s.x[q * 3 + 2] / r);
            for(let dz = -1; dz <= 1; dz++) for(let dy = -1; dy <= 1; dy++) for(let dx = -1; dx <= 1; dx++) for(const o of cell.get(key(cx + dx, cy + dy, cz + dz)) || []) {
                if(lab[o] >= 0) continue;
                if(Math.hypot(s.x[o * 3] - s.x[q * 3], s.x[o * 3 + 1] - s.x[q * 3 + 1], s.x[o * 3 + 2] - s.x[q * 3 + 2]) < r) { lab[o] = sizes.length; st.push(o); }
            }
        }
        sizes.push(c);
    }
    return sizes.sort((a, b) => b - a);
}

console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exitCode = failed ? 1 : 0;
