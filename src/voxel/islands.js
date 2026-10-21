/**
 * Connectivity and voxel grids for detached pieces. Pure (no THREE, no physics engine): runs in Node for tests.
 *
 * Terrain connectivity (`findIslands`): after an edit, flood fill the solid samples around the edit box. A fill is
 * grounded when it reaches the bottom of the world, a side of the world, a uniform solid chunk (8 m of solid rock is
 * an anchor) or more than `budget` samples (huge masses stay put). Everything else is an island: it lost its
 * support and should become a body. The fill is a DFS that tries "down" first, so a fill through the ground drills
 * straight to an anchor in a few dozen steps and only real islands get fully explored.
 *
 * Bonds: samples are 6-connected. A bond between a building material (brick, metal, red/blue stone, wood) and
 * anything but the same material does not hold: buildings merely stand on the ground. So a piece of
 * a fort cut loose from the fort (a tower blasted free of its walls, a wall section cut on both sides) becomes a
 * body standing where it was, and the blast's push or gravity topples it, while the intact fort, far over the
 * budget, stays put.
 *
 * Grids: a detached piece is a `Grid` { nx, ny, nz, sdf: Int8Array, mat: Uint8Array, count, offset } holding
 * (nx + 2*PAD) x (ny + 2*PAD) x (nz + 2*PAD) samples (index x + y*Px + z*Px*Py, padded coordinates: padded PAD is
 * local sample 0), exactly the layout the mesher takes (MeshPool.meshGrid). Local sample i sits at i * VOXEL in the
 * body's frame. `offset` is where local 0 sits in the parent (world samples for an extracted island, parent local
 * samples for a split piece).
 */
import { VOXEL, CHUNK, SDF_SCALE, SDF_MAX, PAD, BEDROCK_SAMPLES } from '../config.js';
import { REACH, MATERIALS, BEDROCK } from './materials.js';
import { toStored } from './VoxelWorld.js';

const N = CHUNK, N2 = N * N;
/** Crack faces: samples either side of a break sit half a voxel from the new surface. */
const HALF = SDF_SCALE >> 1;
export const SAMPLE_VOLUME = VOXEL ** 3;

/** Bond classes: bonds only hold within a class. Natural ground (0) bonds with all natural ground; each building
 *  material (brick, metal, red/blue stone, wood) is its own class, so a wooden door is not glued into a stone wall
 *  and a building only stands on the ground. (A level can make a tower its own material id to make it independent
 *  of the walls it touches.) */
export const BOND_CLASS = new Uint8Array(256);
for(const id of [5, 6, 8, 9, 10]) BOND_CLASS[id] = 1 + id;
BOND_CLASS[14] = BOND_CLASS[15] = BOND_CLASS[10]; // wood with y / z grain bonds with wood
BOND_CLASS[16] = 17;                              // glass: its own class (a pane is not glued into its frame)

// ---------------------------------------------------------------- terrain connectivity

const REACH_MAX = REACH.reduce((a, r) => Math.max(a, r), 0);
const caches = new WeakMap();
function cacheFor(world) {
    let c = caches.get(world);
    if(c) return c;
    const W = world.smax[0] - world.smin[0], H = world.smax[1] - world.smin[1], D = world.smax[2] - world.smin[2];
    const CX = W / N, CY = H / N, CZ = D / N;
    const chunks = new Array(CX * CY * CZ);
    for(const ch of world.chunks.values())
        chunks[(ch.cx - world.bounds.min[0]) + (ch.cy - world.bounds.min[1]) * CX + (ch.cz - world.bounds.min[2]) * CX * CY] = ch;
    const total = W * H * D;
    c = { W, H, D, CX, CY, CZ, chunks, seen: new Uint32Array((total >>> 5) + 1), cur: new Uint32Array((total >>> 5) + 1), isl: new Uint32Array((total >>> 5) + 1),
        stack: new Int32Array(1 << 16), list: new Int32Array(1 << 16) };
    caches.set(world, c);
    return c;
}

/**
 * Find the solid regions around a box of samples that are no longer anchored.
 * @param world VoxelWorld
 * @param lo, hi inclusive box of world samples (e.g. applyBrush's result.box)
 * @param opts { budget: samples before a fill counts as anchored, erode: stored SDF units of erosion (0 = off),
 *               near: the edit's brush (erosion only within nearDist metres of it) }
 * @returns { islands: [{ samples: Int32Array (packed world-local indices), count, min, max (world samples), mat }],
 *            visited, ms }
 */
export function findIslands(world, lo, hi, opts = {}) {
    const g = islandsJob(world, lo, hi, opts, Infinity);
    let r = g.next();
    while(!r.done) r = g.next();
    return r.value;
}

/**
 * findIslands as a generator that yields after about `slice` samples of work, so callers can spread it over frames
 * (VoxelBodies runs it under a per-frame time budget). Only one job may run at a time (they share scratch
 * bitsets); `job.return()` aborts and cleans up. The world must not change inside the box while a job is suspended
 * (VoxelBodies restarts jobs whose box an edit touches).
 */
export function* islandsJob(world, lo, hi, { budget = 40000, erode = 0, near = null, nearDist = 0.6 } = {}, slice = 4096) {
    const t0 = performance.now();
    let work = 0, curList = null, curN = 0;
    const C = cacheFor(world);
    const { W, H, D, CX, CY, chunks, seen, cur, isl } = C;
    const WH = W * H, CXY = CX * CY;
    const sx = world.smin[0], sy = world.smin[1], sz = world.smin[2];
    const bedY = BEDROCK_SAMPLES; // world-local y at or below which everything is anchored
    // seed box (world-local), one sample beyond the edit
    const x0 = Math.max(0, lo[0] - sx - 1), x1 = Math.min(W - 1, hi[0] - sx + 1);
    const y0 = Math.max(0, lo[1] - sy - 1), y1 = Math.min(H - 1, hi[1] - sy + 1);
    const z0 = Math.max(0, lo[2] - sz - 1), z1 = Math.min(D - 1, hi[2] - sz + 1);
    // Erosion: inside the box (and within nearDist metres of the brush `near`, if given), samples closer than `erode`
    // stored units to a surface are weak: phase 0 fills only through strong samples, so thin remnants of a blast
    // (necks thinner than about 2 * erode) no longer hold up what hangs on them; an island takes the weak samples next
    // to it (two rings). Phase 1 then fills from the remaining weak samples through everything, so weak fragments
    // that float on their own are found too; it stops as soon as it touches matter phase 0 found grounded.
    const weakAt = erode > 0 ? -erode : 0;
    const inBox = (x, y, z) => x >= x0 && x <= x1 && y >= y0 && y <= y1 && z >= z0 && z <= z1;
    const isWeak = near ? (x, y, z) => near.d((x + sx) * VOXEL, (y + sy) * VOXEL, (z + sz) * VOXEL) < nearDist : () => true;
    const weak = (v, x, y, z) => v > weakAt && inBox(x, y, z) && isWeak(x, y, z);
    const islands = [];
    let visited = 0;
    const seenList = []; // fills to clear afterwards
    // neighbour order: up, sides, down last (pops first)
    const DX = [0, 1, -1, 0, 0, 0], DY = [1, 0, 0, 0, 0, -1], DZ = [0, 0, 0, 1, -1, 0];
    const DQ = DX.map((_, k) => DX[k] + DY[k] * W + DZ[k] * WH);

    try {
    for(let phase = 0; phase < (erode > 0 ? 2 : 1); phase++) {
        const strongOnly = erode > 0 && phase === 0;
        for(let z = z0; z <= z1; z++) for(let y = y0; y <= y1; y++) for(let x = x0; x <= x1; x++) {
            const s = x + y * W + z * WH;
            if(++work >= slice) { work = 0; yield; }
            if(seen[s >>> 5] & (1 << (s & 31))) continue;
            const ch0 = chunks[(x >> 5) + (y >> 5) * CX + (z >> 5) * CXY];
            if(!ch0.sdf) continue; // air, or inside an anchor chunk
            const li0 = (x & 31) + ((y & 31) << 5) + ((z & 31) << 10);
            const v0 = ch0.sdf[li0];
            if(v0 >= 0 || (strongOnly && weak(v0, x, y, z))) continue;
            const m0 = ch0.mat[li0];
            if(m0 === BEDROCK) continue;
            // ---- one fill
            const cls = BOND_CLASS[m0];
            let stack = C.stack, list = C.list, sp = 0, n = 0, grounded = false;
            stack[sp++] = s;
            seen[s >>> 5] |= 1 << (s & 31); cur[s >>> 5] |= 1 << (s & 31);
            list[n++] = s;
            let mnx = x, mny = y, mnz = z, mxx = x, mxy = y, mxz = z;
            curList = list; curN = 1;
            fill: while(sp > 0) {
                if(++work >= slice) { work = 0; curList = list; curN = n; yield; stack = C.stack; list = C.list; }
                const p = stack[--sp];
                const pz = (p / WH) | 0, rem = p - pz * WH, py = (rem / W) | 0, px = rem - py * W;
                if(py <= bedY || px === 0 || pz === 0 || px === W - 1 || pz === D - 1) { grounded = true; break; }
                if(px < mnx) mnx = px; else if(px > mxx) mxx = px;
                if(py < mny) mny = py; else if(py > mxy) mxy = py;
                if(pz < mnz) mnz = pz; else if(pz > mxz) mxz = pz;
                for(let k = 0; k < 6; k++) {
                    const q = p + DQ[k];
                    const wi = q >>> 5, bit = 1 << (q & 31);
                    if(cur[wi] & bit) continue;
                    const qx = px + DX[k], qy = py + DY[k], qz = pz + DZ[k];
                    if(qy >= H) continue;
                    const ch = chunks[(qx >> 5) + (qy >> 5) * CX + (qz >> 5) * CXY];
                    let mq;
                    if(ch.sdf === null) {
                        if(ch.fill >= 0) continue;
                        if(BOND_CLASS[ch.fillMat] === cls) { grounded = true; break fill; } // anchor: 8 m of solid
                        continue;
                    } else {
                        const li = (qx & 31) + ((qy & 31) << 5) + ((qz & 31) << 10);
                        const v = ch.sdf[li];
                        if(v >= 0) continue;
                        if(strongOnly && v > weakAt && qx >= x0 && qx <= x1 && qy >= y0 && qy <= y1 && qz >= z0 && qz <= z1 && isWeak(qx, qy, qz)) continue;
                        mq = ch.mat[li];
                    }
                    if(BOND_CLASS[mq] !== cls) continue;
                    if(seen[wi] & bit) {
                        if(isl[wi] & bit) continue; // part of an island found earlier: not support
                        grounded = true; break fill;  // touches an earlier, grounded fill
                    }
                    seen[wi] |= bit; cur[wi] |= bit;
                    if(sp >= stack.length) { const ns = new Int32Array(stack.length * 2); ns.set(stack); C.stack = stack = ns; }
                    stack[sp++] = q;
                    if(n >= list.length) { const nl = new Int32Array(list.length * 2); nl.set(list); C.list = list = nl; }
                    list[n++] = q;
                }
                if(n > budget) { grounded = true; break; }
            }
            if(!grounded && strongOnly) {
                // the island takes the weak samples next to it (two rings): it breaks off at the far side of the neck
                let from = 0;
                for(let ring = 0; ring < 2; ring++) {
                    const to = n;
                    for(let i = from; i < to; i++) {
                        if(++work >= slice) { work = 0; curList = list; curN = n; yield; }
                        const p = list[i];
                        const pz = (p / WH) | 0, rem = p - pz * WH, py = (rem / W) | 0, px = rem - py * W;
                        for(let k = 0; k < 6; k++) {
                            const qx = px + DX[k], qy = py + DY[k], qz = pz + DZ[k];
                            if(qy >= H || qy <= bedY || !inBox(qx, qy, qz)) continue;
                            const q = p + DQ[k], wi = q >>> 5, bit = 1 << (q & 31);
                            if(seen[wi] & bit) continue;
                            const ch = chunks[(qx >> 5) + (qy >> 5) * CX + (qz >> 5) * CXY];
                            if(!ch.sdf) continue;
                            const li = (qx & 31) + ((qy & 31) << 5) + ((qz & 31) << 10);
                            const v = ch.sdf[li];
                            if(v >= 0 || v <= weakAt || BOND_CLASS[ch.mat[li]] !== cls || !isWeak(qx, qy, qz)) continue;
                            seen[wi] |= bit; cur[wi] |= bit;
                            if(n >= list.length) { const nl = new Int32Array(list.length * 2); nl.set(list); C.list = list = nl; }
                            list[n++] = q;
                            if(qx < mnx) mnx = qx; else if(qx > mxx) mxx = qx;
                            if(qy < mny) mny = qy; else if(qy > mxy) mxy = qy;
                            if(qz < mnz) mnz = qz; else if(qz > mxz) mxz = qz;
                        }
                    }
                    from = to;
                }
            }
            // every pushed sample is in `list`, so clearing `cur` from it is complete
            for(let i = 0; i < n; i++) { const q = list[i]; cur[q >>> 5] &= ~(1 << (q & 31)); }
            curList = null;
            visited += n;
            const samples = list.slice(0, n);
            seenList.push(samples);
            if(grounded) continue;
            for(let i = 0; i < n; i++) { const q = samples[i]; isl[q >>> 5] |= 1 << (q & 31); }
            // dominant material
            const hist = new Uint32Array(256);
            for(let i = 0; i < n; i++) {
                const q = samples[i], qz = (q / WH) | 0, r = q - qz * WH, qy = (r / W) | 0, qx = r - qy * W;
                const ch = chunks[(qx >> 5) + (qy >> 5) * CX + (qz >> 5) * CXY];
                hist[ch.mat[(qx & 31) + ((qy & 31) << 5) + ((qz & 31) << 10)]]++;
            }
            let mat = 0; for(let i = 1; i < 256; i++) if(hist[i] > hist[mat]) mat = i;
            islands.push({ samples, count: n, min: [mnx + sx, mny + sy, mnz + sz], max: [mxx + sx, mxy + sy, mxz + sz], mat });
        }
    }
    } finally {
        // also runs when the job is aborted (job.return())
        if(curList) for(let i = 0; i < curN; i++) { const q = curList[i], m = ~(1 << (q & 31)); cur[q >>> 5] &= m; seen[q >>> 5] &= m; }
        for(const l of seenList) for(let i = 0; i < l.length; i++) { const q = l[i], m = ~(1 << (q & 31)); seen[q >>> 5] &= m; isl[q >>> 5] &= m; }
    }
    return { islands, visited, ms: performance.now() - t0 };
}

/**
 * Copy an island out of the world into a Grid (with a one sample margin of the surrounding air) and turn its samples
 * into air in the world. Notifies the world's change listeners (renderers remesh).
 * @returns { grid, removed: Float64Array m³ per material, dirty }
 */
export function detachIsland(world, island, { notify = true, keepGrid = true } = {}) {
    const C = cacheFor(world);
    const { W, H, D, CX, CY, chunks } = C;
    const WH = W * H, CXY = CX * CY;
    const sx = world.smin[0], sy = world.smin[1], sz = world.smin[2];
    const ox = island.min[0] - 1, oy = island.min[1] - 1, oz = island.min[2] - 1; // world sample of local 0
    const nx = island.max[0] - island.min[0] + 3, ny = island.max[1] - island.min[1] + 3, nz = island.max[2] - island.min[2] + 3;
    const nxy = nx * ny;
    const removed = new Float64Array(256);
    const S = island.samples;
    // the box's samples (world values) and island membership, read once
    const vs = new Int8Array(nxy * nz).fill(SDF_MAX), ms = new Uint8Array(nxy * nz), inIsl = new Uint8Array(nxy * nz);
    for(let lz = 0; lz < nz; lz++) {
        const z = lz + oz - sz;
        if(z < 0 || z >= D) continue;
        for(let ly = 0; ly < ny; ly++) {
            const y = ly + oy - sy;
            if(y < 0 || y >= H) continue;
            for(let lx = 0; lx < nx; lx++) {
                const x = lx + ox - sx;
                if(x < 0 || x >= W) continue;
                const ch = chunks[(x >> 5) + (y >> 5) * CX + (z >> 5) * CXY];
                const o = lx + ly * nx + lz * nxy;
                if(!ch.sdf) { vs[o] = ch.fill; ms[o] = ch.fillMat; continue; }
                const li = (x & 31) + ((y & 31) << 5) + ((z & 31) << 10);
                vs[o] = ch.sdf[li]; ms[o] = ch.mat[li];
            }
        }
    }
    for(let i = 0; i < S.length; i++) {
        const q = S[i], qz = (q / WH) | 0, r = q - qz * WH, qy = (r / W) | 0, qx = r - qy * W;
        const o = (qx + sx - ox) + (qy + sy - oy) * nx + (qz + sz - oz) * nxy;
        if(vs[o] < 0) inIsl[o] = 1; // (a sample carved meanwhile is no longer part of it)
    }
    // solid but not in the island: the other side of a crack
    const touchesOther = (o, lx, ly, lz) =>
        (lx > 0 && vs[o - 1] < 0 && !inIsl[o - 1]) || (lx < nx - 1 && vs[o + 1] < 0 && !inIsl[o + 1]) ||
        (ly > 0 && vs[o - nx] < 0 && !inIsl[o - nx]) || (ly < ny - 1 && vs[o + nx] < 0 && !inIsl[o + nx]) ||
        (lz > 0 && vs[o - nxy] < 0 && !inIsl[o - nxy]) || (lz < nz - 1 && vs[o + nxy] < 0 && !inIsl[o + nxy]);
    // 1) copy into the grid
    let grid = null, count = 0;
    if(keepGrid) {
        grid = newGrid(nx, ny, nz);
        const P = nx + 2 * PAD, PP = P * (ny + 2 * PAD);
        for(let lz = 0; lz < nz; lz++) for(let ly = 0; ly < ny; ly++) for(let lx = 0; lx < nx; lx++) {
            const o = lx + ly * nx + lz * nxy;
            const gi = (lx + PAD) + (ly + PAD) * P + (lz + PAD) * PP;
            const v = vs[o];
            if(inIsl[o]) {
                grid.sdf[gi] = Math.min(-1, touchesOther(o, lx, ly, lz) ? Math.max(v, -HALF) : v); grid.mat[gi] = ms[o]; count++;
            } else {
                grid.sdf[gi] = v >= 0 ? v : HALF; grid.mat[gi] = ms[o];
            }
        }
        grid.count = count;
        grid.offset = [ox, oy, oz];
    }
    // 2) turn the island into air (flipped distances; half a voxel next to remaining solid)
    const dirtyChunks = new Set();
    let n = 0;
    for(let lz = 1; lz < nz - 1; lz++) for(let ly = 1; ly < ny - 1; ly++) for(let lx = 1; lx < nx - 1; lx++) {
        const o = lx + ly * nx + lz * nxy;
        if(!inIsl[o]) continue;
        const x = lx + ox - sx, y = ly + oy - sy, z = lz + oz - sz;
        const ch = chunks[(x >> 5) + (y >> 5) * CX + (z >> 5) * CXY];
        if(!ch.sdf) ch.densify();
        removed[ms[o]] += SAMPLE_VOLUME; n++;
        ch.sdf[(x & 31) + ((y & 31) << 5) + ((z & 31) << 10)] = touchesOther(o, lx, ly, lz) ? HALF : Math.max(1, -vs[o]);
        dirtyChunks.add(ch);
    }
    for(const ch of dirtyChunks) { ch.version++; ch.tryCollapse(); }
    const lo = [island.min[0] - 1, island.min[1] - 1, island.min[2] - 1], hi = [island.max[0] + 1, island.max[1] + 1, island.max[2] + 1];
    const dirty = world.chunksInSampleBox(lo.map(v => v - PAD - 1), hi.map(v => v + PAD + 1));
    if(notify && n) for(const fn of world.listeners) fn({ removed: new Float64Array(256), added: 0, changed: n, dirty, box: [lo, hi], detach: true });
    return { grid, removed, dirty, count: n };
}

const NB6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

// ---------------------------------------------------------------- grids

export function newGrid(nx, ny, nz) {
    const len = (nx + 2 * PAD) * (ny + 2 * PAD) * (nz + 2 * PAD);
    return { nx, ny, nz, sdf: new Int8Array(len).fill(SDF_MAX), mat: new Uint8Array(len), count: 0, offset: [0, 0, 0] };
}

/** Per material volume (m³), mass (kg) and dominant material of a grid. */
export function gridStats(g) {
    const hist = new Float64Array(256);
    let count = 0, mass = 0, cx = 0, cy = 0, cz = 0;
    const P = g.nx + 2 * PAD, PP = P * (g.ny + 2 * PAD);
    for(let z = PAD; z < PAD + g.nz; z++) for(let y = PAD; y < PAD + g.ny; y++) for(let x = PAD; x < PAD + g.nx; x++) {
        const i = x + y * P + z * PP;
        if(g.sdf[i] >= 0) continue;
        const m = g.mat[i];
        hist[m] += SAMPLE_VOLUME; count++;
        const w = MATERIALS[m].density * SAMPLE_VOLUME;
        mass += w; cx += (x - PAD) * w; cy += (y - PAD) * w; cz += (z - PAD) * w;
    }
    let mat = 0; for(let i = 1; i < 256; i++) if(hist[i] > hist[mat]) mat = i;
    g.count = count;
    return { volumes: hist, volume: count * SAMPLE_VOLUME, count, mass, mat, com: mass ? [cx / mass * VOXEL, cy / mass * VOXEL, cz / mass * VOXEL] : [0, 0, 0] };
}

/**
 * Connected components of a grid's solid samples (6-connected; with `labels`, only samples of equal label connect).
 * @returns { comp: Int32Array per padded index (-1 air), comps: [{ id, count, min, max (local samples) }] }
 */
export function gridComponents(g, labels = null) {
    const P = g.nx + 2 * PAD, Py = g.ny + 2 * PAD, PP = P * Py;
    const comp = new Int32Array(g.sdf.length).fill(-1);
    const comps = [];
    const stack = [];
    const steps = [1, -1, P, -P, PP, -PP];
    for(let z = PAD; z < PAD + g.nz; z++) for(let y = PAD; y < PAD + g.ny; y++) for(let x = PAD; x < PAD + g.nx; x++) {
        const s = x + y * P + z * PP;
        if(g.sdf[s] >= 0 || comp[s] >= 0) continue;
        const id = comps.length, lab = labels ? labels[s] : 0;
        const c = { id, count: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
        comps.push(c);
        comp[s] = id; stack.push(s);
        while(stack.length) {
            const p = stack.pop();
            c.count++;
            const pz = (p / PP) | 0, r = p - pz * PP, py = (r / P) | 0, px = r - py * P;
            const lx = px - PAD, ly = py - PAD, lz = pz - PAD;
            if(lx < c.min[0]) c.min[0] = lx; if(lx > c.max[0]) c.max[0] = lx;
            if(ly < c.min[1]) c.min[1] = ly; if(ly > c.max[1]) c.max[1] = ly;
            if(lz < c.min[2]) c.min[2] = lz; if(lz > c.max[2]) c.max[2] = lz;
            for(let k = 0; k < 6; k++) {
                const q = p + steps[k];
                // the padding is always air, so q never leaves the array through a solid sample
                if(g.sdf[q] >= 0 || comp[q] >= 0) continue;
                if(labels && labels[q] !== lab) continue;
                comp[q] = id; stack.push(q);
            }
        }
    }
    return { comp, comps };
}

/** Cut component `c` (from gridComponents) out of grid `g` into its own grid; crack faces get half voxel distances. */
export function subGrid(g, comp, c) {
    const P = g.nx + 2 * PAD, PP = P * (g.ny + 2 * PAD);
    const nx = c.max[0] - c.min[0] + 3, ny = c.max[1] - c.min[1] + 3, nz = c.max[2] - c.min[2] + 3;
    const out = newGrid(nx, ny, nz);
    const Q = nx + 2 * PAD, QQ = Q * (ny + 2 * PAD);
    const ox = c.min[0] - 1, oy = c.min[1] - 1, oz = c.min[2] - 1;
    let count = 0;
    for(let lz = 0; lz < nz; lz++) for(let ly = 0; ly < ny; ly++) for(let lx = 0; lx < nx; lx++) {
        const px = lx + ox + PAD, py = ly + oy + PAD, pz = lz + oz + PAD;
        if(px < 0 || py < 0 || pz < 0 || px >= P || py >= g.ny + 2 * PAD || pz >= g.nz + 2 * PAD) continue;
        const s = px + py * P + pz * PP;
        const o = (lx + PAD) + (ly + PAD) * Q + (lz + PAD) * QQ;
        const v = g.sdf[s];
        if(comp[s] === c.id) {
            let crack = false;
            for(const d of [1, -1, P, -P, PP, -PP]) { const q = s + d; if(g.sdf[q] < 0 && comp[q] !== c.id) { crack = true; break; } }
            out.sdf[o] = crack ? Math.min(-1, Math.max(v, -HALF)) : v; out.mat[o] = g.mat[s]; count++;
        } else {
            out.sdf[o] = v >= 0 ? v : HALF; out.mat[o] = g.mat[s];
        }
    }
    out.count = count;
    out.offset = [ox, oy, oz];
    return out;
}

/**
 * Split a grid into its connected pieces (each with `offset` relative to g's local samples). Pieces with fewer than
 * `minCount` samples get no grid: their volume per material is added to `dust` (Float64Array(256), optional).
 */
export function splitGrid(g, labels = null, { minCount = 0, dust = null } = {}) {
    const { comp, comps } = gridComponents(g, labels);
    if(comps.length === 1 && !labels && comps[0].count >= minCount) { g.offset = [0, 0, 0]; g.count = comps[0].count; return [g]; }
    const out = [];
    const small = new Set();
    for(const c of comps) { if(c.count >= minCount) out.push(subGrid(g, comp, c)); else small.add(c.id); }
    if(dust && small.size) for(let i = 0; i < comp.length; i++) if(comp[i] >= 0 && small.has(comp[i])) dust[g.mat[i]] += SAMPLE_VOLUME;
    return out;
}

/**
 * Voronoi fracture labels: `n` sites among the solid samples, denser around `point` (local metres) so the region
 * that took the hit breaks finer. Returns an Int32Array label per padded index (only solid samples matter).
 * `aniso` [wx, wy, wz] scales the distance per axis: a small weight stretches the cells along that axis (wood's grain).
 */
export function voronoiLabels(g, point, n, rand = Math.random, aniso = null) {
    const P = g.nx + 2 * PAD, PP = P * (g.ny + 2 * PAD);
    let ns = 0;
    let buf = new Int32Array(Math.max(g.count, 64));
    for(let z = PAD; z < PAD + g.nz; z++) for(let y = PAD; y < PAD + g.ny; y++) {
        let i = PAD + y * P + z * PP;
        for(let x = 0; x < g.nx; x++, i++) if(g.sdf[i] < 0) {
            if(ns >= buf.length) { const nb = new Int32Array(buf.length * 2); nb.set(buf); buf = nb; }
            buf[ns++] = i;
        }
    }
    const labels = new Int32Array(g.sdf.length).fill(-1);
    if(!ns) return labels;
    const pxs = point[0] / VOXEL + PAD, pys = point[1] / VOXEL + PAD, pzs = point[2] / VOXEL + PAD;
    const K = Math.max(1, n);
    const S = new Float64Array(K * 6);
    for(let k = 0; k < K; k++) {
        let best = buf[(rand() * ns) | 0];
        if(k < K * 0.6) {
            // biased toward the impact: best of a few tries by distance to the point
            let bd = Infinity;
            for(let t = 0; t < 4; t++) {
                const i = buf[(rand() * ns) | 0];
                const z = (i / PP) | 0, r = i - z * PP, y = (r / P) | 0, x = r - y * P;
                const d = (x - pxs) * (x - pxs) + (y - pys) * (y - pys) + (z - pzs) * (z - pzs);
                if(d < bd) { bd = d; best = i; }
            }
        }
        const z = (best / PP) | 0, r = best - z * PP, y = (r / P) | 0, x = r - y * P;
        // a random anisotropic weight per site gives slabs and shards rather than round cells
        S[k * 6] = x; S[k * 6 + 1] = y; S[k * 6 + 2] = z;
        S[k * 6 + 3] = 0.6 + rand() * 0.8; S[k * 6 + 4] = 0.6 + rand() * 0.8; S[k * 6 + 5] = 0.6 + rand() * 0.8;
        if(aniso) { S[k * 6 + 3] *= aniso[0]; S[k * 6 + 4] *= aniso[1]; S[k * 6 + 5] *= aniso[2]; }
    }
    for(let s = 0; s < ns; s++) {
        const i = buf[s];
        // jittered positions (hashed per sample, about ±1 sample): rough, interlocking crack faces
        const h = Math.imul(i, 2654435761) >>> 0;
        const z = ((i / PP) | 0) + ((h & 255) / 256 - 0.5), r = i - ((i / PP) | 0) * PP;
        const y = ((r / P) | 0) + (((h >>> 8) & 255) / 256 - 0.5), x = (r - ((r / P) | 0) * P) + (((h >>> 16) & 255) / 256 - 0.5);
        let best = 0, bd = Infinity;
        for(let k = 0, o = 0; k < K; k++, o += 6) {
            const dx = x - S[o], dy = y - S[o + 1], dz = z - S[o + 2];
            const d = dx * dx * S[o + 3] + dy * dy * S[o + 4] + dz * dz * S[o + 5];
            if(d < bd) { bd = d; best = k; }
        }
        labels[i] = best;
    }
    return labels;
}

/**
 * Carve a grid with a brush given in the grid's local metres (`d(x, y, z)` over local positions, `min/max` local AABB).
 * Same rules as VoxelWorld.applyBrush 'carve' (hardness reach; bedrock never carves). Returns removed m³ per material.
 */
export function carveGrid(g, brush, { hardness = true } = {}) {
    const P = g.nx + 2 * PAD, PP = P * (g.ny + 2 * PAD);
    const removed = new Float64Array(256);
    let changed = 0;
    const band = 4;
    // as VoxelWorld.applyBrush: with hardness, reach r scales the brush about its centre (r < 1 shrinks it in hard
    // materials, r > 1 grows it in soft ones), so the range covers the grown brush
    const bc = [0, 1, 2].map(a => (brush.min[a] + brush.max[a]) / 2);
    const grow = hardness ? REACH_MAX : 1;
    const lo = [0, 1, 2].map(a => Math.max(0, Math.floor((bc[a] - (bc[a] - brush.min[a]) * grow) / VOXEL) - band));
    const hi = [0, 1, 2].map(a => Math.min([g.nx, g.ny, g.nz][a] - 1, Math.ceil((bc[a] + (brush.max[a] - bc[a]) * grow) / VOXEL) + band));
    for(let z = lo[2]; z <= hi[2]; z++) for(let y = lo[1]; y <= hi[1]; y++) for(let x = lo[0]; x <= hi[0]; x++) {
        const i = (x + PAD) + (y + PAD) * P + (z + PAD) * PP;
        const old = g.sdf[i], m = g.mat[i];
        if(old >= SDF_MAX) continue;
        const r = hardness ? REACH[m] : 1;
        if(r === 0) continue;
        const px = x * VOXEL, py = y * VOXEL, pz = z * VOXEL;
        const db = r === 1 ? brush.d(px, py, pz) : brush.d(bc[0] + (px - bc[0]) / r, bc[1] + (py - bc[1]) / r, bc[2] + (pz - bc[2]) / r) * r;
        const s = -toStored(db);
        if(s <= old) continue;
        g.sdf[i] = s; changed++;
        if(old < 0 && s >= 0) { removed[m] += SAMPLE_VOLUME; g.count--; }
    }
    return { removed, changed };
}

/**
 * Collider boxes for a grid: occupancy at `res` samples per cell (a cell is solid when at least half its samples
 * are), greedily merged into boxes. Returns [{ c: [x,y,z] centre, h: [x,y,z] half extents }] in local metres.
 */
export function gridBoxes(g, res = 2, shrink = 0.02) {
    const P = g.nx + 2 * PAD, PP = P * (g.ny + 2 * PAD);
    const bx = Math.ceil(g.nx / res), by = Math.ceil(g.ny / res), bz = Math.ceil(g.nz / res);
    const occ = new Uint8Array(bx * by * bz);
    const need = Math.max(1, (res * res * res) >> 1);
    for(let cz = 0; cz < bz; cz++) for(let cy = 0; cy < by; cy++) for(let cx = 0; cx < bx; cx++) {
        let n = 0;
        for(let z = cz * res; z < Math.min(g.nz, cz * res + res); z++) for(let y = cy * res; y < Math.min(g.ny, cy * res + res); y++) for(let x = cx * res; x < Math.min(g.nx, cx * res + res); x++)
            if(g.sdf[(x + PAD) + (y + PAD) * P + (z + PAD) * PP] < 0) n++;
        if(n >= need) occ[cx + cy * bx + cz * bx * by] = 1;
    }
    const boxes = [];
    const at = (x, y, z) => occ[x + y * bx + z * bx * by] === 1;
    for(let z = 0; z < bz; z++) for(let y = 0; y < by; y++) for(let x = 0; x < bx; x++) {
        if(!at(x, y, z)) continue;
        let x1 = x; while(x1 + 1 < bx && at(x1 + 1, y, z)) x1++;
        let y1 = y; grow: while(y1 + 1 < by) { for(let i = x; i <= x1; i++) if(!at(i, y1 + 1, z)) break grow; y1++; }
        let z1 = z; growz: while(z1 + 1 < bz) { for(let j = y; j <= y1; j++) for(let i = x; i <= x1; i++) if(!at(i, j, z1 + 1)) break growz; z1++; }
        for(let k = z; k <= z1; k++) for(let j = y; j <= y1; j++) for(let i = x; i <= x1; i++) occ[i + j * bx + k * bx * by] = 0;
        // cells x..x1 cover samples [x*res, (x1+1)*res): tighten to the solid samples inside, each a VOXEL cube
        const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for(let sz = z * res; sz < Math.min(g.nz, (z1 + 1) * res); sz++) for(let sy = y * res; sy < Math.min(g.ny, (y1 + 1) * res); sy++) for(let sx = x * res; sx < Math.min(g.nx, (x1 + 1) * res); sx++) {
            if(g.sdf[(sx + PAD) + (sy + PAD) * P + (sz + PAD) * PP] >= 0) continue;
            if(sx < lo[0]) lo[0] = sx; if(sx > hi[0]) hi[0] = sx;
            if(sy < lo[1]) lo[1] = sy; if(sy > hi[1]) hi[1] = sy;
            if(sz < lo[2]) lo[2] = sz; if(sz > hi[2]) hi[2] = sz;
        }
        const a = lo.map(v => (v - 0.5) * VOXEL), b = hi.map(v => (v + 0.5) * VOXEL);
        boxes.push({ c: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], h: [Math.max(0.03, (b[0] - a[0]) / 2 - shrink), Math.max(0.03, (b[1] - a[1]) / 2 - shrink), Math.max(0.03, (b[2] - a[2]) / 2 - shrink)] });
    }
    return boxes;
}

/** Most collider boxes for a body: every box is a box-mesh contact pair against the terrain, the bulk of a
 *  physics step with debris about (tools/test/fracturecost.mjs). Detached islands 24, fracture pieces 8 (4 when
 *  small, under ~6 m³): coarser boxes sit visibly off the surface, so pieces rest on each other at odd heights and
 *  shift when one is stamped into the (exact) terrain. */
export function maxBoxesFor(count, generation = 0) { return generation > 0 ? (count < 400 ? 4 : 8) : 24; }
/** The collider boxes VoxelBody uses for a grid: the finest resolution (by size) that needs at most `maxBoxes`
 *  boxes (maxBoxesFor). Empty when the grid is too thin for boxes (VoxelBody falls back to a convex hull). */
export function colliderBoxes(g, count, generation = 0, maxBoxes = maxBoxesFor(count, generation)) {
    let res = count > 6000 ? 3 : count > 150 ? 2 : 1;
    let boxes = gridBoxes(g, res);
    while(boxes.length > maxBoxes && res < 8) boxes = gridBoxes(g, ++res);
    return boxes;
}
/** Precomputed body data for a grid (stats and collider boxes), so the main thread only builds the physics body. */
export function gridPrep(g, generation = 0) {
    const stats = gridStats(g);
    return { stats, boxes: colliderBoxes(g, stats.count, generation), generation };
}

/** Surface sample positions (local metres) of a grid's solid samples next to air, for convex hulls. */
export function gridHullPoints(g) {
    const P = g.nx + 2 * PAD, PP = P * (g.ny + 2 * PAD);
    const pts = [];
    const h = VOXEL * 0.45;
    for(let z = PAD; z < PAD + g.nz; z++) for(let y = PAD; y < PAD + g.ny; y++) for(let x = PAD; x < PAD + g.nx; x++) {
        const i = x + y * P + z * PP;
        if(g.sdf[i] >= 0) continue;
        if(g.sdf[i + 1] < 0 && g.sdf[i - 1] < 0 && g.sdf[i + P] < 0 && g.sdf[i - P] < 0 && g.sdf[i + PP] < 0 && g.sdf[i - PP] < 0) continue;
        const cx = (x - PAD) * VOXEL, cy = (y - PAD) * VOXEL, cz = (z - PAD) * VOXEL;
        pts.push(cx - h, cy - h, cz - h, cx + h, cy + h, cz + h, cx - h, cy + h, cz + h, cx + h, cy - h, cz - h);
    }
    return new Float32Array(pts);
}

/**
 * Union a grid into the world at a pose (translation t in metres, rotation quaternion q = [x,y,z,w] of local -> world).
 * Rubble becomes terrain again. Notifies the world's listeners. Returns { added (m³), dirty, box }.
 */
export function stampGrid(world, g, t, q) {
    const job = stampJob(world, g, t, q, Infinity);
    let r = job.next();
    while(!r.done) r = job.next();
    return r.value;
}

/** stampGrid as a generator yielding after about `slice` world samples (the world's listeners hear about the edit
 *  once, at the end). */
export function* stampJob(world, g, t, q, slice = 8192) {
    const C = cacheFor(world);
    const { W, H, D, CX, CY, chunks } = C;
    const P = g.nx + 2 * PAD, Py = g.ny + 2 * PAD, Pz = g.nz + 2 * PAD, PP = P * Py;
    // rotation matrix (local -> world) and its transpose
    const [qx, qy, qz, qw] = q;
    const m00 = 1 - 2 * (qy * qy + qz * qz), m01 = 2 * (qx * qy - qz * qw), m02 = 2 * (qx * qz + qy * qw);
    const m10 = 2 * (qx * qy + qz * qw), m11 = 1 - 2 * (qx * qx + qz * qz), m12 = 2 * (qy * qz - qx * qw);
    const m20 = 2 * (qx * qz - qy * qw), m21 = 2 * (qy * qz + qx * qw), m22 = 1 - 2 * (qx * qx + qy * qy);
    // world AABB of the local box
    const lmin = [-1, -1, -1].map(v => v * VOXEL), lmax = [g.nx, g.ny, g.nz].map(v => v * VOXEL);
    const wmin = [Infinity, Infinity, Infinity], wmax = [-Infinity, -Infinity, -Infinity];
    for(let k = 0; k < 8; k++) {
        const x = k & 1 ? lmax[0] : lmin[0], y = k & 2 ? lmax[1] : lmin[1], z = k & 4 ? lmax[2] : lmin[2];
        const w = [m00 * x + m01 * y + m02 * z + t[0], m10 * x + m11 * y + m12 * z + t[1], m20 * x + m21 * y + m22 * z + t[2]];
        for(let a = 0; a < 3; a++) { wmin[a] = Math.min(wmin[a], w[a]); wmax[a] = Math.max(wmax[a], w[a]); }
    }
    const sx = world.smin[0], sy = world.smin[1], sz = world.smin[2];
    const lo = wmin.map((v, a) => Math.max(Math.floor(v / VOXEL), world.smin[a] + (a === 1 ? BEDROCK_SAMPLES : 0)));
    const hi = wmax.map((v, a) => Math.min(Math.ceil(v / VOXEL), world.smax[a] - 1));
    let added = 0, changed = 0;
    const touched = new Set();
    const sampleGrid = (x, y, z) => {
        // trilinear in padded coordinates; outside the grid reads as far air
        if(x < 0 || y < 0 || z < 0 || x >= P - 1 || y >= Py - 1 || z >= Pz - 1) return SDF_MAX;
        const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
        const fx = x - ix, fy = y - iy, fz = z - iz;
        const i = ix + iy * P + iz * PP, s = g.sdf;
        const c00 = s[i] * (1 - fx) + s[i + 1] * fx, c10 = s[i + P] * (1 - fx) + s[i + P + 1] * fx;
        const c01 = s[i + PP] * (1 - fx) + s[i + PP + 1] * fx, c11 = s[i + PP + P] * (1 - fx) + s[i + PP + P + 1] * fx;
        return (c00 * (1 - fy) + c10 * fy) * (1 - fz) + (c01 * (1 - fy) + c11 * fy) * fz;
    };
    let work = 0;
    for(let iz = lo[2]; iz <= hi[2]; iz++) for(let iy = lo[1]; iy <= hi[1]; iy++) {
    if((work += hi[0] - lo[0] + 1) >= slice) { work = 0; yield; }
    for(let ix = lo[0]; ix <= hi[0]; ix++) {
        const dx = ix * VOXEL - t[0], dy = iy * VOXEL - t[1], dz = iz * VOXEL - t[2];
        const lx = (m00 * dx + m10 * dy + m20 * dz) / VOXEL + PAD, ly = (m01 * dx + m11 * dy + m21 * dz) / VOXEL + PAD, lz = (m02 * dx + m12 * dy + m22 * dz) / VOXEL + PAD;
        const v = Math.round(sampleGrid(lx, ly, lz));
        if(v >= SDF_MAX) continue;
        const x = ix - sx, y = iy - sy, z = iz - sz;
        const ch = chunks[(x >> 5) + (y >> 5) * CX + (z >> 5) * CX * CY];
        const li = (x & 31) + ((y & 31) << 5) + ((z & 31) << 10);
        const old = ch.sdf ? ch.sdf[li] : ch.fill;
        if(v >= old) continue;
        // material: the nearest solid grid sample
        let m = -1;
        const rx = Math.round(lx), ry = Math.round(ly), rz = Math.round(lz);
        if(rx >= 0 && ry >= 0 && rz >= 0 && rx < P && ry < Py && rz < Pz && g.sdf[rx + ry * P + rz * PP] < 0) m = g.mat[rx + ry * P + rz * PP];
        else {
            let bd = Infinity;
            for(let c = 0; c < 8; c++) {
                const cx = Math.floor(lx) + (c & 1), cy = Math.floor(ly) + ((c >> 1) & 1), cz = Math.floor(lz) + ((c >> 2) & 1);
                if(cx < 0 || cy < 0 || cz < 0 || cx >= P || cy >= Py || cz >= Pz) continue;
                const s = g.sdf[cx + cy * P + cz * PP];
                if(s < bd && s < 0) { bd = s; m = g.mat[cx + cy * P + cz * PP]; }
            }
        }
        if(v < 0 && m < 0) continue;
        if(!ch.sdf) ch.densify();
        if(v < 0 && old >= 0) added += SAMPLE_VOLUME;
        ch.sdf[li] = v;
        if(v < 0) ch.mat[li] = m;
        touched.add(ch); changed++;
    }
    }
    for(const ch of touched) { ch.version++; ch.tryCollapse(); }
    const dirty = world.chunksInSampleBox(lo.map(v => v - PAD - 1), hi.map(v => v + PAD + 1));
    if(changed) for(const fn of world.listeners) fn({ removed: new Float64Array(256), added, changed, dirty, box: [lo, hi], stamp: true });
    return { added, changed, dirty, box: [lo, hi] };
}

/** Lift a lump out of the world: the world's solid samples inside `brush` (world metres), bedrock excluded. */
export function liftGrid(world, brush) {
    const lo = brush.min.map(v => Math.floor(v / VOXEL) - 1), hi = brush.max.map(v => Math.ceil(v / VOXEL) + 1);
    const nx = hi[0] - lo[0] + 1, ny = hi[1] - lo[1] + 1, nz = hi[2] - lo[2] + 1;
    const g = newGrid(nx, ny, nz);
    const P = nx + 2 * PAD, PP = P * (ny + 2 * PAD);
    let count = 0;
    const bedTop = world.smin[1] + BEDROCK_SAMPLES;
    for(let z = 0; z < nz; z++) for(let y = 0; y < ny; y++) for(let x = 0; x < nx; x++) {
        const ix = x + lo[0], iy = y + lo[1], iz = z + lo[2];
        if(!world.inWorld(ix, iy, iz) || iy < bedTop) continue;
        const m = world.getMat(ix, iy, iz);
        if(m === BEDROCK) continue;
        const v = Math.max(world.get(ix, iy, iz), toStored(brush.d(ix * VOXEL, iy * VOXEL, iz * VOXEL)));
        const i = (x + PAD) + (y + PAD) * P + (z + PAD) * PP;
        g.sdf[i] = v; g.mat[i] = m;
        if(v < 0) count++;
    }
    g.count = count;
    g.offset = lo;
    return g;
}
