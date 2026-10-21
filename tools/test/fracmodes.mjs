/** Fracture modes per material (src/softbody/behaviour.js, lattice.js, bake.js) on synthetic grids, in node:
 *  wood splinters along its grain (long pieces), stone shatters into a piece count by size, glass into mostly dust,
 *  metal bends (stays one piece, bent; the bake keeps its matter), dirt crumbles into clods, sand mostly into dust,
 *  and the face thresholds and Voronoi splits are deterministic for a seed.   node tools/test/fracmodes.mjs */
import { newGrid, splitGrid, voronoiLabels } from '../../src/voxel/islands.js';
import { rng } from '../../src/voxel/brushes.js';
import { buildLattice, SoftLattice, cellSampleLabels } from '../../src/softbody/lattice.js';
import { behaviour, pieceCount } from '../../src/softbody/behaviour.js';
import { bakeLattice } from '../../src/softbody/bake.js';

const PAD = 2, V = 0.25;
let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if(!ok) fails++; };
function block(nx, ny, nz, mat) {
    const g = newGrid(nx, ny, nz), P = nx + 2 * PAD, PP = P * (ny + 2 * PAD);
    g.sdf.fill(16); // near-surface distances outside (as a real body grid), not "far"
    for(let z = 0; z < nz; z++) for(let y = 0; y < ny; y++) for(let x = 0; x < nx; x++) { const i = x + PAD + (y + PAD) * P + (z + PAD) * PP; g.sdf[i] = -16; g.mat[i] = mat; }
    g.count = nx * ny * nz;
    return g;
}
/** Extents (samples) of a piece's solid samples per axis. */
function extents(p) {
    const P = p.nx + 2 * PAD, PP = P * (p.ny + 2 * PAD), lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
    for(let z = 0; z < p.nz; z++) for(let y = 0; y < p.ny; y++) for(let x = 0; x < p.nx; x++) if(p.sdf[x + PAD + (y + PAD) * P + (z + PAD) * PP] < 0) {
        const c = [x, y, z]; for(let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], c[a]); hi[a] = Math.max(hi[a], c[a]); }
    }
    return lo.map((v, a) => hi[a] - v + 1);
}
const run = (L, steps, kick) => {
    if(kick) L.kick(kick);
    for(let s = 0; s < steps && !L.asleep && !L.frozen; s++) {
        if(kick && s % 6 === 0 && s < 30) L.kick(kick);
        if(L.step(1 / 60, 2)) { const c = L.components(); if(c.count > 1) return c; }
    }
    return null;
};
const pieces = (g, L, c) => splitGrid(g, cellSampleLabels(g, c.labels, L.cellOf, L.cs, L.dims));

// 1. grain: wood faces whose normal runs along the fibres are much tougher than faces along them
{
    const L = new SoftLattice(buildLattice(block(32, 8, 8, 10)), { seed: 7 });
    const by = [[], [], []];
    for(let f = 0; f < L.faceThr.length; f++) by[L.faces[f * 3 + 2]].push(L.faceThr[f]);
    const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
    check(mean(by[0]) > 5 * mean(by[1]) && mean(by[0]) > 5 * mean(by[2]), `wood (grain x): across-grain faces ${mean(by[0]).toFixed(2)} vs along ${mean(by[1]).toFixed(2)} / ${mean(by[2]).toFixed(2)}`);
    const L2 = new SoftLattice(buildLattice(block(32, 8, 8, 10)), { seed: 7 }), L3 = new SoftLattice(buildLattice(block(32, 8, 8, 10)), { seed: 8 });
    check(L.faceThr.every((v, i) => v === L2.faceThr[i]), 'face thresholds are the same for the same seed (every client)');
    check(L.faceThr.some((v, i) => v !== L3.faceThr[i]), 'and differ for another seed');
    const st = new SoftLattice(buildLattice(block(16, 8, 8, 0)), { seed: 7 }), sp = st.faceThr;
    const smin = Math.min(...sp), smax = Math.max(...sp);
    check(smax / smin > 1.8, `stone thresholds vary per face (spread): ${smin.toFixed(3)}..${smax.toFixed(3)}`);
}
// 2. wood beam hit hard in the middle: cracks along the grain, long thin pieces (x is the grain)
{
    const g = block(40, 6, 6, 10);
    const L = new SoftLattice(buildLattice(g), { seed: 3 });
    const c = run(L, 240, { type: 'impact', p: [5, 0, 0.75], dv: [0, 22, 0], frag: 3 });
    check(!!c, `wood splits (${c ? c.count : 0} lattice pieces, ${L.cracks || 0} faces cracked)`);
    if(c) {
        const ps = pieces(g, L, c).filter(p => p.count >= 16);
        const ar = ps.map(p => { const e = extents(p); return e[0] / Math.max(e[1], e[2]); });
        const long = ar.filter(a => a >= 2.5).length;
        check(long >= Math.ceil(ps.length / 2), `wood pieces are long along the grain: aspect ${ar.map(a => a.toFixed(1)).join(', ')}`);
    }
    // the same with the grain across the beam (grain y): it snaps across instead (short pieces)
    const L2 = new SoftLattice(buildLattice(g), { seed: 3 });
    for(let f = 0; f < L2.faceThr.length; f++) { const ax = L2.faces[f * 3 + 2]; L2.faceThr[f] = 0.09 * 6 * (ax === 1 ? 3.75 : 0.35); }
    const c2 = run(L2, 240, { type: 'impact', p: [5, 0, 0.75], dv: [0, 22, 0], frag: 3 });
    if(c2) {
        const ps = pieces(g, L2, c2).filter(p => p.count >= 16);
        const ar = ps.map(p => { const e = extents(p); return e[0] / Math.max(e[1], e[2]); });
        check(Math.min(...ar) < 2.5, `grain across the beam: it snaps across (aspect ${ar.map(a => a.toFixed(1)).join(', ')})`);
    } else check(false, 'grain across the beam: snaps');
    // the fallback cleave: a Voronoi split stretched along the grain
    const P = pieceCount(behaviour(10), { volume: g.count * V ** 3, count: g.count, energy: 3 });
    const vp = splitGrid(g, voronoiLabels(g, [5, 0.75, 0.75], P.n, rng(5), P.aniso), { minCount: 16 });
    const var2 = vp.map(p => { const e = extents(p); return e[0] / Math.max(e[1], e[2]); });
    check(var2.filter(a => a >= 2).length >= vp.length / 2, `wood cleave (Voronoi along the grain, n ${P.n}): aspect ${var2.map(a => a.toFixed(1)).join(', ')}`);
}
// 3. stone: piece count from its piece size range, finer for harder hits; same seed, same pieces
{
    const g = block(8, 8, 8, 0), vol = g.count * V ** 3;
    const soft = pieceCount(behaviour(0), { volume: vol, count: g.count, energy: 1 }), hard = pieceCount(behaviour(0), { volume: vol, count: g.count, energy: 4 });
    check(soft.n >= 2 && hard.n > soft.n, `stone ${vol} m³: ${soft.n} pieces for a bare break, ${hard.n} for a hard hit`);
    const a = splitGrid(g, voronoiLabels(g, [1, 1, 1], hard.n, rng(11)), { minCount: hard.minCount });
    const b = splitGrid(block(8, 8, 8, 0), voronoiLabels(g, [1, 1, 1], hard.n, rng(11)), { minCount: hard.minCount });
    check(a.length >= Math.min(hard.n, 6) && a.length === b.length && a.every((p, i) => p.count === b[i].count), `stone shatters into ${a.length} pieces, identical for the same seed`);
    const e = a.map(extents).map(e => Math.max(...e) / Math.min(...e));
    check(Math.max(...e) < 6, `stone pieces are chunky (max aspect ${Math.max(...e).toFixed(1)})`);
}
// 4. glass: many slivers, mostly dust (particles), a few bodies
{
    const g = block(16, 16, 2, 16), vol = g.count * V ** 3;
    const P = pieceCount(behaviour(16), { volume: vol, count: g.count, energy: 2 });
    const dust = new Float64Array(256);
    const ps = splitGrid(g, voronoiLabels(g, [1, 1, 0.25], P.n, rng(2)), { minCount: P.minCount, dust });
    const kept = ps.reduce((s, p) => s + p.count, 0) * V ** 3;
    check(P.n >= 6 && ps.length >= 1 && dust[16] > kept, `glass: ${P.n} sites, ${ps.length} bodies (${kept.toFixed(2)} m³), ${dust[16].toFixed(2)} m³ to slivers`);
}
// 5. dirt crumbles into 3-8 clods; sand mostly falls apart
{
    const g = block(12, 8, 12, 1), vol = g.count * V ** 3;
    const P = pieceCount(behaviour(1), { volume: vol, count: g.count, energy: 2 });
    const dust = new Float64Array(256);
    const ps = splitGrid(g, voronoiLabels(g, [1.5, 0, 1.5], P.n, rng(4)), { minCount: P.minCount, dust });
    check(P.n >= 3 && P.n <= 8 && ps.length >= 3, `dirt ${vol} m³ crumbles: ${P.n} sites, ${ps.length} clods, ${dust[1].toFixed(2)} m³ crumbs`);
    const gs = block(12, 8, 12, 3);
    const Ps = pieceCount(behaviour(3), { volume: vol, count: gs.count, energy: 2 });
    const ds = new Float64Array(256);
    const pss = splitGrid(gs, voronoiLabels(gs, [1.5, 0, 1.5], Ps.n, rng(4)), { minCount: Ps.minCount, dust: ds });
    const kept = pss.reduce((s, p) => s + p.count, 0) * V ** 3;
    check(ds[3] > kept, `sand falls apart: ${pss.length} lumps (${kept.toFixed(2)} m³), ${ds[3].toFixed(2)} m³ to particles`);
}
// 6. metal: a beam hit near one end bends, stays one piece, freezes bent and bakes into a bent grid
{
    const g = block(32, 4, 4, 6);
    const L = new SoftLattice(buildLattice(g), { seed: 1 });
    check(!!L.ur, 'metal lattice is plastic');
    let split = null, steps = 0;
    L.kick({ type: 'impact', p: [0.5, 0.5, 0.5], dv: [0, 14, 0] });
    for(; steps < 900 && !L.asleep && !L.frozen; steps++) {
        if((steps < 24 && steps % 4 === 0) || steps === 0) L.kick({ type: 'impact', p: [0.5, 0.5, 0.5], dv: [0, 14, 0] });
        if(L.step(1 / 60, 2)) { const c = L.components(); if(c.count > 1) { split = c; break; } }
    }
    check(!split, 'metal does not break');
    check(L.frozen && L.maxUr > 0.04, `metal stays bent (max plastic displacement ${L.maxUr.toFixed(3)} m, frozen ${L.frozen} after ${(steps / 60).toFixed(1)} s)`);
    const t0 = performance.now();
    const b = L.frozen ? bakeLattice(g, L) : null;
    const ms = performance.now() - t0;
    check(!!b && Math.abs(b.count - g.count) / g.count < 0.2, `bake keeps its matter: ${b?.count} of ${g.count} samples (${ms.toFixed(1)} ms)`);
    if(b) {
        // bent: the beam's two ends and middle no longer line up in y/z
        const P = b.nx + 2 * PAD, PP = P * (b.ny + 2 * PAD);
        const cy = (x0, x1) => { let s = 0, n = 0; for(let z = 0; z < b.nz; z++) for(let y = 0; y < b.ny; y++) for(let x = x0; x < x1; x++) if(b.sdf[x + PAD + (y + PAD) * P + (z + PAD) * PP] < 0) { s += y + z; n++; } return n ? s / n : 0; };
        const m = -b.offset[0], e0 = cy(m, m + 4), mid = cy(m + 14, m + 18), e1 = cy(m + 28, m + 32);
        const dev = Math.abs((e0 + e1) / 2 - mid);
        check(dev > 0.5 || Math.abs(e0 - e1) > 1, `baked grid is bent (ends vs middle ${dev.toFixed(2)} samples, ends apart ${Math.abs(e0 - e1).toFixed(2)})`);
    }
    // a gentle tap springs back (no bake)
    const L2 = new SoftLattice(buildLattice(g), { seed: 1 });
    L2.kick({ type: 'impact', p: [0.5, 0.5, 0.5], dv: [0, 2, 0] });
    for(let s = 0; s < 600 && !L2.asleep && !L2.frozen; s++) L2.step(1 / 60, 2);
    check(L2.asleep && !L2.frozen, `a gentle tap springs back (max plastic ${L2.maxUr.toFixed(3)} m)`);
}
// 7. determinism: the same kicks on the same seed crack the same way
{
    const go = () => { const L = new SoftLattice(buildLattice(block(40, 6, 6, 10)), { seed: 9 }); const c = run(L, 240, { type: 'impact', p: [5, 0, 0.75], dv: [0, 22, 0], frag: 3 }); return c ? Array.from(c.labels).join() : ''; };
    const a = go(), b = go();
    check(a && a === b, 'two runs with the same seed crack identically');
}
// 8. cost: a 3 x 8 x 3 m wood piece and a metal beam per 60 Hz step
{
    for(const [mat, dims] of [[10, [12, 32, 12]], [6, [32, 6, 6]]]) {
        const L = new SoftLattice(buildLattice(block(...dims, mat)), { seed: 1 });
        L.kick({ type: 'impact', p: [0.5, 0.5, 0.5], dv: [0, 6, 0] });
        const t0 = performance.now(); let n = 0;
        for(; n < 120 && !L.asleep && !L.frozen; n++) L.step(1 / 60, 2);
        const ms = (performance.now() - t0) / Math.max(1, n);
        check(ms < 1, `${behaviour(mat).mode} ${dims.map(d => d * V).join(' x ')} m: ${ms.toFixed(3)} ms per step (${L.ncell} cells)`);
    }
}
console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
