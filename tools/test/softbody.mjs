/** Soft debris lattice (src/softbody/lattice.js), in node: wobble, sleep, rigid-part removal, crack + component split
 *  into grid pieces (as VoxelBodies.crack does), inheritance, and the solver's cost.  node tools/test/softbody.mjs */
import { newGrid, splitGrid } from '../../src/voxel/islands.js';
import { buildLattice, SoftLattice, cellSampleLabels, CELL_CAP } from '../../src/softbody/lattice.js';

const PAD = 2;
let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if(!ok) fails++; };
function block(nx, ny, nz, mat) {
    const g = newGrid(nx, ny, nz), P = nx + 2 * PAD, PP = P * (ny + 2 * PAD);
    for(let z = 0; z < nz; z++) for(let y = 0; y < ny; y++) for(let x = 0; x < nx; x++) { const i = x + PAD + (y + PAD) * P + (z + PAD) * PP; g.sdf[i] = -16; g.mat[i] = mat; }
    g.count = nx * ny * nz;
    return g;
}
const run = (L, steps) => { for(let s = 0; s < steps && !L.asleep; s++) { if(L.step(1 / 60, 2)) { const c = L.components(); if(c.count > 1) return c; } } return null; };

// 1. a stone pillar (2 x 6 x 2 m) lands at 8 m/s: it squashes and wobbles, does not break, and sleeps
{
    const L = new SoftLattice(buildLattice(block(8, 24, 8, 0)));
    L.kick({ type: 'impact', p: [1, 0, 1], dv: [0, 8, 0] });
    let maxU = 0, steps = 0, signs = new Set();
    const top = ((L.nodes[1] - 1) * L.nodes[0] + 1) * 3 + 1;
    for(; steps < 400 && !L.asleep; steps++) {
        check.quiet = L.step(1 / 60, 2);
        maxU = Math.max(maxU, L.maxU);
        if(Math.abs(L.u[top]) > 0.02) signs.add(Math.sign(L.u[top]));
    }
    check(maxU > 0.08 && maxU < 0.5, `landing squash visible: max |u| ${maxU.toFixed(3)} m`);
    check(signs.size === 2, 'it springs back past rest (a wobble, not a dent)');
    check(L.asleep && steps < 300, `sleeps when calm (after ${steps} steps = ${(steps / 60).toFixed(1)} s)`);
    check(L.components().count === 1, 'an ordinary landing does not crack it');
}
// 2. no drift: the soft layer carries no net translation or rotation
{
    const L = new SoftLattice(buildLattice(block(8, 24, 8, 1)));
    L.kick({ type: 'impact', p: [0, 6, 0], dv: [6, -3, 2] });
    for(let s = 0; s < 10; s++) L.step(1 / 60, 2);
    let m = [0, 0, 0];
    for(const i of L.actList) for(let a = 0; a < 3; a++) m[a] += L.u[i * 3 + a] / L.actList.length;
    check(Math.hypot(...m) < 1e-3, `mean displacement ~0 (${Math.hypot(...m).toExponential(1)} m)`);
}
// 3. a hard hit (frag 2) cracks it along a plane into a few pieces; the grid splits into matching pieces
{
    const g = block(8, 24, 8, 0);
    const L = new SoftLattice(buildLattice(g));
    L.kick({ type: 'impact', p: [1, 0, 1], dv: [0, 14, 0], frag: 2 });
    const c = run(L, 120);
    check(!!c && c.count >= 2 && c.count <= 6, `cracks into ${c?.count} lattice pieces (cells ${c?.sizes.join(',')})`);
    if(c) {
        const labels = cellSampleLabels(g, c.labels, L.cellOf, L.cs, L.dims);
        let unlabelled = 0;
        const P = g.nx + 2 * PAD, PP = P * (g.ny + 2 * PAD);
        for(let i = 0; i < g.sdf.length; i++) if(g.sdf[i] < 0 && labels[i] < 0) unlabelled++;
        check(unlabelled === 0, 'every solid sample gets a piece');
        const dust = new Float64Array(256);
        const pieces = splitGrid(g, labels, { minCount: 16, dust });
        const total = pieces.reduce((a, p) => a + p.count, 0) + Math.round(dust[0] / 0.25 ** 3);
        check(pieces.length >= 2, `grid splits into ${pieces.length} pieces (${pieces.map(p => p.count).join(', ')} samples)`);
        check(total === g.count, `no matter lost (${total} of ${g.count} samples)`);
        // 4. a piece inherits the parent's wobble
        const p = pieces.sort((a, b) => b.count - a.count)[0];
        const K = new SoftLattice(buildLattice(p));
        K.inherit(L, p.offset.map(v => v * 0.25));
        let mu = 0; for(const i of K.actList) mu = Math.max(mu, Math.abs(K.u[i * 3]), Math.abs(K.u[i * 3 + 1]), Math.abs(K.u[i * 3 + 2]));
        check(mu > 0.01 && !K.asleep, `the biggest piece keeps the parent's deformation (max |u| ${mu.toFixed(3)} m)`);
    }
}
// 5. the same hit without fragility (frag 1) does not crack
{
    const L = new SoftLattice(buildLattice(block(8, 24, 8, 0)));
    L.kick({ type: 'impact', p: [1, 0, 1], dv: [0, 14, 0], frag: 1 });
    check(!run(L, 120), 'hit under the break threshold: bends, holds');
}
// 6. big bodies get coarser lattices within the caps; cost per step at the cap
{
    const L = new SoftLattice(buildLattice(block(40, 40, 40, 1)));
    check(L.ncell <= CELL_CAP && L.nn <= 1024, `10 m cube: ${L.ncell} cells of ${L.h} m, ${L.nn} nodes`);
    const P = new SoftLattice(buildLattice(block(12, 32, 12, 5)));
    for(let s = 0; s < 60; s++) { if(s % 20 === 0) P.kick({ type: 'impact', p: [1, 0, 1], dv: [3, 6, 0] }); P.step(1 / 60, 2); }
    const t = performance.now(); let n = 0;
    for(let s = 0; s < 300; s++) { if(s % 20 === 0) P.kick({ type: 'impact', p: [1, 0, 1], dv: [3, 6, 0] }); P.step(1 / 60, 2); n++; }
    const ms = (performance.now() - t) / n;
    check(ms < 0.35, `3 x 8 x 3 m brick piece: ${P.ncell} cells, ${ms.toFixed(3)} ms per 60 Hz step`);
}
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
