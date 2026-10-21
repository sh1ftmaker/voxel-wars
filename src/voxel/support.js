/**
 * Structural support: overhangs that cannot carry themselves break off at their roots. Pure (no THREE, no physics engine):
 * runs in the terrain worker after a carve, and in Node for tests.
 *
 * Connectivity (src/voxel/islands.js) only frees matter that lost every bond to the ground, so a bridge blown out at
 * one end stayed hanging from the other. Here, around an edit, on a lattice of 2x2x2-sample cells (0.5 m):
 *   - a solid cell is supported when a solid column runs straight down from it to the bottom of the region (the
 *     ground carries it in compression, whatever the materials); the other solid cells hang;
 *   - a hanging cell's lever is its horizontal path distance (cells) to the nearest root through hanging cells of its
 *     bond class (BOND_CLASS): a root is a hanging cell bonded to a supported one of its class, or resting on solid
 *     matter of another class, or on the edge of the examined region (unknown beyond: assumed held). Horizontal: what
 *     stands on a beam or hangs under it weighs at the beam's arm;
 *   - a hanging cell whose lever passes its material's reach (SPAN: cells) is overloaded, and the overhang it belongs
 *     to breaks off where it meets its support: everything hanging connected to it with a lever of at least CUT
 *     (about a metre out from the support) comes off as one piece.
 * The reach is calibrated so the intact Twin Forts stand (tools/test/support.mjs): the gorge bridge, held at both
 * ends, reaches 8.6 m from either; blown out at one end its far end is 17 m from the other and it falls. Tunnel
 * roofs and cave ceilings reach half their width from their walls: a wide cave under dirt caves in.
 * Pieces over maxCells stay put (as connectivity's budget).
 */
import { BEDROCK_SAMPLES } from '../config.js';
import { BEDROCK } from './materials.js';
import { BOND_CLASS } from './islands.js';
import { readRegion } from '../soft/region.js';

/** Reach of an overhang per material id (cells of 0.5 m from its support). */
export const SPAN = new Float32Array(256).fill(16);
const K = { 0: 24, 1: 12, 2: 12, 3: 6, 4: 6, 5: 18, 6: 40, 7: 4, 8: 18, 9: 18, 10: 24, 11: 24, 12: 28, 13: 1e9 };
for(const id in K) SPAN[id] = K[id];
/** Pieces break off this many cells out from their support. */
const CUT = 2;

/**
 * @param world VoxelWorld
 * @param lo, hi inclusive box of world samples the edit touched
 * @param opts { margin: [mx, my, mz] samples examined around the box, below: samples examined below it,
 *               maxCells: largest piece that may come off, kScale (multiplies SPAN) }
 * @returns { islands: [{ samples, count, min, max, mat }] (world-local packed indices, as findIslands),
 *            maxLoad: highest lever / reach seen (< 1: everything stands), ms }
 */
export function findUnsupported(world, lo, hi, { margin = [64, 40, 64], below = 40, maxCells = 8000, kScale = 1 } = {}) {
    const t0 = performance.now();
    const smin = world.smin, smax = world.smax;
    const bedTop = smin[1] + BEDROCK_SAMPLES;
    // region (even-aligned so cells are whole 2x2x2 blocks), clamped to the world
    const r0 = [lo[0] - margin[0], Math.max(bedTop, lo[1] - below), lo[2] - margin[2]].map((v, a) => Math.max(smin[a], v) & ~1);
    const r1 = [hi[0] + margin[0], hi[1] + margin[1], hi[2] + margin[2]].map((v, a) => Math.min(smax[a] - 1, v) | 1);
    const reg = readRegion(world, r0, r1);
    const [dx, dy] = reg.dims, dxy = dx * dy;
    const CX = reg.dims[0] >> 1, CY = reg.dims[1] >> 1, CZ = reg.dims[2] >> 1, CXY = CX * CY, NC = CXY * CZ;
    // cells: solid if any of their 8 samples is; material of the most solid sample
    const cmat = new Uint8Array(NC), solid = new Uint8Array(NC);
    const { sdf, mat } = reg;
    for(let k = 0; k < CZ; k++) for(let j = 0; j < CY; j++) for(let i = 0; i < CX; i++) {
        let best = 0, bm = 0;
        for(let c = 0; c < 8; c++) {
            const o = (2 * i + (c & 1)) + (2 * j + ((c >> 1) & 1)) * dx + (2 * k + (c >> 2)) * dxy;
            if(sdf[o] < best) { best = sdf[o]; bm = mat[o]; }
        }
        if(best < 0) { const ci = i + j * CX + k * CXY; solid[ci] = 1; cmat[ci] = bm; }
    }
    // supported: a solid column down to the region's floor (or bedrock)
    const sup = new Uint8Array(NC);
    for(let k = 0; k < CZ; k++) for(let i = 0; i < CX; i++) {
        let held = true;
        for(let j = 0; j < CY; j++) {
            const ci = i + j * CX + k * CXY;
            held = held && solid[ci] === 1;
            if(solid[ci] && cmat[ci] === BEDROCK) held = true;
            if(held) sup[ci] = 1;
        }
    }
    // levers: the horizontal distance to the nearest root through the overhang (the moment arm: what hangs above or
    // below a cell adds weight at the same arm). Dial's algorithm over half-cell costs: up/down 0, along x or z 2,
    // diagonally in x-z 3 (an octagonal metric within 6% of Euclid). lever (cells) = cost / 2 (INF: no root reached:
    // connectivity frees those).
    const NB = [1, -1, CX, -CX, CXY, -CXY, 1 + CXY, 1 - CXY, -1 + CXY, -1 - CXY];
    const NW = [2, 2, 0, 0, 2, 2, 3, 3, 3, 3];
    const NDI = [1, -1, 0, 0, 0, 0, 1, 1, -1, -1], NDJ = [0, 0, 1, -1, 0, 0, 0, 0, 0, 0], NDK = [0, 0, 0, 0, 1, -1, 1, -1, 1, -1];
    const nbOk = (d, i, j, k) => { const a = i + NDI[d], b = j + NDJ[d], c = k + NDK[d]; return a >= 0 && a < CX && b >= 0 && b < CY && c >= 0 && c < CZ; };
    const INF = 0x3fffffff;
    const cost = new Int32Array(NC).fill(INF);
    const buckets = [[], [], [], []];
    let pending = 0;
    for(let k = 0; k < CZ; k++) for(let j = 0; j < CY; j++) for(let i = 0; i < CX; i++) {
        const c = i + j * CX + k * CXY;
        if(!solid[c] || sup[c]) continue;
        let root = i === 0 || i === CX - 1 || k === 0 || k === CZ - 1 || j === CY - 1;
        const cls = BOND_CLASS[cmat[c]];
        for(let d = 0; d < 6 && !root; d++) {
            if(!nbOk(d, i, j, k)) continue;
            const q = c + NB[d];
            if(!solid[q]) continue;
            const same = BOND_CLASS[cmat[q]] === cls;
            if((sup[q] && same) || (d === 3 && !same)) root = true;
        }
        if(root) { cost[c] = 2; buckets[2].push(c); pending++; }
    }
    let maxLoad = 0;
    const over = [];
    for(let cur = 2; pending > 0; cur++) {
        const b = buckets[cur & 3];
        while(b.length) {
            const c = b.pop(); pending--;
            if(cost[c] !== cur) continue; // stale entry
            const k = (c / CXY) | 0, rem = c - k * CXY, j = (rem / CX) | 0, i = rem - j * CX;
            const load = cur / 2 / (SPAN[cmat[c]] * kScale);
            if(load > maxLoad) maxLoad = load;
            if(load > 1) over.push(c);
            const cls = BOND_CLASS[cmat[c]];
            for(let d = 0; d < 10; d++) {
                if(!nbOk(d, i, j, k)) continue;
                const q = c + NB[d], nc = cur + NW[d];
                if(nc >= cost[q] || !solid[q] || sup[q] || BOND_CLASS[cmat[q]] !== cls) continue;
                cost[q] = nc; buckets[nc & 3].push(q); pending++;
            }
        }
    }
    // the overloaded overhangs break off CUT cells out from their support
    const islands = [];
    const taken = new Uint8Array(NC);
    const W = smax[0] - smin[0], WH = W * (smax[1] - smin[1]);
    for(const o of over) {
        if(taken[o]) continue;
        const cls = BOND_CLASS[cmat[o]];
        const list = [o];
        taken[o] = 1;
        let big = false;
        for(let h = 0; h < list.length && !big; h++) {
            const c = list[h];
            const k = (c / CXY) | 0, rem = c - k * CXY, j = (rem / CX) | 0, i = rem - j * CX;
            if(i === 0 || i === CX - 1 || k === 0 || k === CZ - 1 || j === CY - 1) { big = true; break; } // reaches the unknown
            for(let d = 0; d < 6; d++) {
                if(!nbOk(d, i, j, k)) continue;
                const q = c + NB[d];
                if(taken[q] || !solid[q] || sup[q] || BOND_CLASS[cmat[q]] !== cls) continue;
                if(cost[q] < 2 * CUT) continue;
                taken[q] = 1; list.push(q);
                if(list.length > maxCells) { big = true; break; }
            }
        }
        if(big) continue;
        // its samples (of the overhang's class) as an island
        const samples = [], hist = new Uint32Array(256);
        const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
        for(const c of list) {
            const ck = (c / CXY) | 0, rem = c - ck * CXY, cj = (rem / CX) | 0, ci = rem - cj * CX;
            for(let s = 0; s < 8; s++) {
                const sx = 2 * ci + (s & 1), sy = 2 * cj + ((s >> 1) & 1), sz = 2 * ck + (s >> 2);
                const so = sx + sy * dx + sz * dxy;
                if(sdf[so] >= 0 || BOND_CLASS[mat[so]] !== cls || mat[so] === BEDROCK) continue;
                const wx = sx + r0[0], wy = sy + r0[1], wz = sz + r0[2];
                samples.push((wx - smin[0]) + (wy - smin[1]) * W + (wz - smin[2]) * WH);
                hist[mat[so]]++;
                if(wx < mn[0]) mn[0] = wx; if(wx > mx[0]) mx[0] = wx;
                if(wy < mn[1]) mn[1] = wy; if(wy > mx[1]) mx[1] = wy;
                if(wz < mn[2]) mn[2] = wz; if(wz > mx[2]) mx[2] = wz;
            }
        }
        let m = 0; for(let i = 1; i < 256; i++) if(hist[i] > hist[m]) m = i;
        if(samples.length) islands.push({ samples: Int32Array.from(samples), count: samples.length, min: mn, max: mx, mat: m, support: true });
    }
    return { islands, maxLoad, ms: performance.now() - t0 };
}
