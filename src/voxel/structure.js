/**
 * Structural failure: after an edit, find overhangs that are still attached but can no longer carry themselves, so
 * a bridge blown out at one end, an undercut ledge or a cave dug too wide comes down instead of hanging in the air.
 * Pure (no THREE, no physics engine); runs in the terrain worker (TerrainCore.brush) right after findIslands.
 *
 * Model:
 *   full     a solid sample with solid all the way down to the bedrock in its column: it stands on the ground
 *            (across materials: a wall stands on dirt)
 *   hanging  any other solid sample: it is held up sideways or from above
 *   A hanging component is a connected set of hanging samples (bonds: sideways and down only within a bond class,
 *   up across classes: what rests on a beam is part of its load). Its interface is where it touches full samples
 *   sideways (same bond class). Support distance d: a 0-1 BFS from the interface along bonds (a step sideways or
 *   hanging down costs a sample, stacking up is free).
 *   Hanging matter within BAND samples of the interface (the ceiling of a tunnel, the lip of a ledge) counts as
 *   anchored; the rest of the component falls apart into deep parts, each judged on its own against the band:
 *     - no contact with the band: floating
 *     - reach: some of it is further from the real interface than its material reaches (REACH_M: spans and caves
 *       too wide for the material)
 *     - bending: weight x lever (horizontal distance from the part's centre of mass to the centroid of where it
 *       touches the band) over the root's section modulus (contact area x height / 6) exceeds the strength of the
 *       root's material (STRENGTH, Pa). A two-ended bridge has its contact centroid under its mass (no lever); blown
 *       off at one end it is a 16 m cantilever and snaps at the other.
 *   Only components touching the edit's footprint (its columns, full height) are checked, within WINDOW of it
 *   (bonded matter past the window counts as support): everything else had the same support before the edit and
 *   stood then.
 *
 * A failing part is cut free at the band with a jagged crack: samples just past the band (by a smooth noise, up to
 * LIP samples) stay on as broken stubs; the rest is returned as islands for detachIsland (same format as
 * findIslands, one per connected piece) with { collapse: { root (m), dir, reason } } for the body's hinge motion.
 */
import { VOXEL, CHUNK, BEDROCK_SAMPLES } from '../config.js';
import { BEDROCK } from './materials.js';
import { BOND_CLASS } from './islands.js';

const N = CHUNK;
/** Metres a material reaches from its support (cantilever / half span), measured along 6-connected sample paths
 *  (which run up to ~1.4x the straight distance around corners). */
const REACH_M = new Float32Array(256).fill(8);
/** Bending strength (Pa) of a root of this material. */
const STRENGTH = new Float32Array(256).fill(1.5e5);
const DENSITY = new Float32Array(256).fill(1600);
{
    const set = (ids, reach, strength) => { for(const i of ids) { REACH_M[i] = reach; STRENGTH[i] = strength; } };
    set([1, 2], 8, 1.5e5);      // dirt, grass
    set([3, 4], 5, 6e4);        // sand, snow
    set([0, 8, 9], 14, 4e6);    // stone, red / blue stone
    set([5], 13, 3e6);          // brick
    set([6], 20, 5e7);          // metal
    set([10, 14, 15], 12, 5e6); // wood (any grain)
    set([16], 14, 5e6);         // glass (panes lie in frames: they reach as far as what carries them)
    set([11], 16, 5e6);         // cobble (the bridge's wide middle reaches ~15 m from the rims by sample paths)
    set([12], 17, 6e6);         // dark rock
    set([7], 3, 3e4);           // lava (crust)
    REACH_M[BEDROCK] = 1e9; STRENGTH[BEDROCK] = Infinity;
    const dens = { 0: 2400, 1: 1600, 2: 1600, 3: 1700, 4: 500, 5: 2000, 6: 7800, 7: 3000, 8: 2300, 9: 2300, 10: 700, 11: 2300, 12: 2600, 13: 3000, 14: 700, 15: 700, 16: 2500 };
    for(const k in dens) DENSITY[k] = dens[k];
}
const G = 9.81;
/** Largest hanging component checked (samples); bigger ones are taken as standing (and cost too much to check). */
const BUDGET = 200000;
/** Window (samples) around the edit's footprint: bonded matter past it counts as support (an edit cannot change
 *  the support of matter further away than the longest reach plus the band). */
const WINDOW = Math.round(18 / VOXEL);
/** Samples of hanging matter next to the interface that count as anchored (1.5 m). */
const BAND = 6;
/** Deepest broken stub left on the band side of a crack (samples). */
const LIP = 4;
/** Distances are stored as d + 1 (0: not in the current component); UNREACHED: no bond path from the interface. */
const UNREACHED = 255, DMAX = 250;

/** Smooth value noise in [0, 1) (for jagged cracks). */
function hash3(x, y, z) {
    let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 2147483647) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function noise(x, y, z, s) {
    const fx = x / s, fy = y / s, fz = z / s;
    const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
    const tx = fx - ix, ty = fy - iy, tz = fz - iz;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty), sz = tz * tz * (3 - 2 * tz);
    let v = 0;
    for(let c = 0; c < 8; c++) {
        const a = c & 1, b = (c >> 1) & 1, d = c >> 2;
        v += hash3(ix + a, iy + b, iz + d) * (a ? sx : 1 - sx) * (b ? sy : 1 - sy) * (d ? sz : 1 - sz);
    }
    return v;
}

/** Growable Int32 list. */
class List {
    constructor(n = 4096) { this.a = new Int32Array(n); this.n = 0; }
    push(v) { if(this.n >= this.a.length) { const b = new Int32Array(this.a.length * 2); b.set(this.a); this.a = b; } this.a[this.n++] = v; }
}

const caches = new WeakMap();
function cacheFor(world) {
    let c = caches.get(world);
    if(c) return c;
    const W = world.smax[0] - world.smin[0], H = world.smax[1] - world.smin[1], D = world.smax[2] - world.smin[2];
    const CX = W / N, CY = H / N;
    const chunks = new Array(CX * CY * (D / N));
    for(const ch of world.chunks.values()) chunks[(ch.cx - world.bounds.min[0]) + (ch.cy - world.bounds.min[1]) * CX + (ch.cz - world.bounds.min[2]) * CX * CY] = ch;
    c = { W, H, D, CX, CY, chunks,
        dist: new Uint8Array(W * H * D),              // d + 1 per sample of the component being judged, 0 elsewhere
        done: new Uint32Array(((W * H * D) >>> 5) + 1), // bit: hanging sample already in a checked component (this call)
        cols: new Array(W * D).fill(null) };          // per column x + z * W: full flags (this call)
    caches.set(world, c);
    return c;
}

/**
 * @param world VoxelWorld (after the edit)
 * @param lo, hi inclusive box of world samples the edit touched
 * @returns { islands: [{ samples, count, min, max, mat, collapse: { root, dir, reason, ... } }], checked, ms }
 */
export function findCollapses(world, lo, hi, { budget = BUDGET } = {}) {
    const t0 = performance.now();
    const C = cacheFor(world);
    const { W, H, D, CX, CY, chunks, dist, done } = C;
    const part = new Map(); // deep parts of the current component: 1 found, 2 falls, 3 stub, 4 kept stub, 5 cut out
    const P = (q) => part.get(q) | 0;
    const WH = W * H, CXY = CX * CY;
    const sx = world.smin[0], sy = world.smin[1], sz = world.smin[2];
    const val = (x, y, z) => {
        const ch = chunks[(x >> 5) + (y >> 5) * CX + (z >> 5) * CXY];
        return ch.sdf ? ch.sdf[(x & 31) + ((y & 31) << 5) + ((z & 31) << 10)] : ch.fill;
    };
    const matOf = (x, y, z) => {
        const ch = chunks[(x >> 5) + (y >> 5) * CX + (z >> 5) * CXY];
        return ch.sdf ? ch.mat[(x & 31) + ((y & 31) << 5) + ((z & 31) << 10)] : ch.fillMat;
    };
    // columns: full flags, computed on first use (the world does not change during the call)
    const cols = C.cols, colList = new List(1024);
    const isFull = (x, y, z) => {
        const k = x + z * W;
        let c = cols[k];
        if(!c) {
            cols[k] = c = new Uint8Array(H); colList.push(k);
            let f = 1;
            for(let yy = 0; yy < H; yy++) {
                if(yy > BEDROCK_SAMPLES) f = f && val(x, yy, z) < 0 ? 1 : 0;
                c[yy] = f;
            }
        }
        return c[y] === 1;
    };
    const isDone = (q) => (done[q >>> 5] >>> (q & 31)) & 1;
    const setDone = (q) => { done[q >>> 5] |= 1 << (q & 31); doneList.push(q); };
    const DX = [1, -1, 0, 0, 0, 0], DY = [0, 0, 0, 0, 1, -1], DZ = [0, 0, 1, -1, 0, 0];
    const DQ = DX.map((_, k) => DX[k] + DY[k] * W + DZ[k] * WH);
    const x0 = Math.max(1, lo[0] - sx - 2), x1 = Math.min(W - 2, hi[0] - sx + 2);
    const z0 = Math.max(1, lo[2] - sz - 2), z1 = Math.min(D - 2, hi[2] - sz + 2);
    const y0 = Math.max(BEDROCK_SAMPLES + 1, lo[1] - sy - 2);
    const wx0 = x0 - WINDOW, wx1 = x1 + WINDOW, wz0 = z0 - WINDOW, wz1 = z1 + WINDOW;
    const islands = [];
    const doneList = new List();
    let checked = 0, judged = 0;
    const comp = new List(), iface = new List(), dq = new List();
    const xyz = [0, 0, 0];
    const coords = (p) => { const pz = (p / WH) | 0, r = p - pz * WH, py = (r / W) | 0; xyz[0] = r - py * W; xyz[1] = py; xyz[2] = pz; return xyz; };
    const inWorld = (x, y, z) => x >= 0 && z >= 0 && x < W && z < D && y >= 0 && y < H;

    try {
    for(let z = z0; z <= z1; z++) for(let x = x0; x <= x1; x++) for(let y = y0; y < H; y++) {
        const s = x + y * W + z * WH;
        if(isDone(s) || isFull(x, y, z) || val(x, y, z) >= 0 || matOf(x, y, z) === BEDROCK) continue;
        // ---- 1. the hanging component (and its interface with full matter)
        comp.n = 0; iface.n = 0;
        comp.push(s); setDone(s);
        let over = false;
        for(let i = 0; i < comp.n; i++) {
            const p = comp.a[i];
            const [px, py, pz] = coords(p);
            const cls = BOND_CLASS[matOf(px, py, pz)];
            for(let k = 0; k < 6; k++) {
                const qx = px + DX[k], qy = py + DY[k], qz = pz + DZ[k];
                if(!inWorld(qx, qy, qz) || val(qx, qy, qz) >= 0) continue;
                const vertical = k >= 4;
                if(!vertical && BOND_CLASS[matOf(qx, qy, qz)] !== cls) continue;
                const q = p + DQ[k];
                if(qx < wx0 || qx > wx1 || qz < wz0 || qz > wz1 || isFull(qx, qy, qz)) { if(!vertical) iface.push(p); continue; }
                if(isDone(q)) continue;
                setDone(q);
                comp.push(q);
            }
            if(comp.n > budget) { over = true; break; }
        }
        checked += comp.n;
        if(over) continue;
        judged++;
        // ---- 2. support distance from the interface (0-1 BFS: two lists, the 0-cost one drained first)
        for(let i = 0; i < comp.n; i++) dist[comp.a[i]] = UNREACHED;
        dq.n = 0;
        for(let i = 0; i < iface.n; i++) { const p = iface.a[i]; if(dist[p] !== 1) { dist[p] = 1; dq.push(p); } }
        bfs(dq);
        // ---- 3. deep parts (past the band) judged one by one
        for(let i = 0; i < comp.n; i++) {
            const s2 = comp.a[i];
            if(dist[s2] <= BAND + 1 || part.has(s2)) continue;
            deepPart(s2);
        }
        for(let i = 0; i < comp.n; i++) dist[comp.a[i]] = 0;
        part.clear();
    }
    } finally {
        for(let i = 0; i < doneList.n; i++) { const q = doneList.a[i]; done[q >>> 5] &= ~(1 << (q & 31)); }
        for(let i = 0; i < colList.n; i++) cols[colList.a[i]] = null;
    }
    return { islands, checked, judged, ms: performance.now() - t0 };

    /** 0-1 BFS over the current component from the samples in `seed` (their dist already set). */
    function bfs(seed) {
        let cur = seed, zero = new List(256), next = new List(4096);
        while(cur.n) {
            next.n = 0;
            for(let i = 0; i < cur.n; i++) {
                // stacking up is free: the sample and everything resting on it gets the same distance
                zero.n = 0; zero.push(cur.a[i]);
                for(let j = 0; j < zero.n; j++) {
                    const p = zero.a[j], d = dist[p];
                    const [px, py, pz] = coords(p);
                    const cls = BOND_CLASS[matOf(px, py, pz)];
                    for(let k = 0; k < 6; k++) {
                        const qx = px + DX[k], qy = py + DY[k], qz = pz + DZ[k];
                        const q = p + DQ[k];
                        if(!inWorld(qx, qy, qz) || dist[q] === 0) continue; // not in the component
                        const up = k === 4;
                        if(!up && BOND_CLASS[matOf(qx, qy, qz)] !== cls) continue;
                        const nd = up ? d : Math.min(DMAX, d + 1);
                        if(dist[q] !== UNREACHED && dist[q] <= nd) continue;
                        dist[q] = nd;
                        if(up) zero.push(q); else next.push(q);
                    }
                }
            }
            const t = cur; cur = next; next = t === seed ? new List(4096) : t;
        }
    }

    /** One deep part from `s`: flood it, judge it, cut it if it fails. */
    function deepPart(s) {
        const list = new List();
        list.push(s); part.set(s, 1);
        let ni = 0, ix = 0, iy = 0, iz = 0, ymin = Infinity, ymax = -Infinity, sig = 0;
        let m = 0, mx = 0, my = 0, mz = 0, far = -Infinity, farAt = null, unreached = 0;
        const contacts = new List();
        for(let i = 0; i < list.n; i++) {
            const p = list.a[i];
            const [px, py, pz] = coords(p);
            const mp = matOf(px, py, pz), cls = BOND_CLASS[mp], dp = dist[p];
            const w = DENSITY[mp];
            m += w; mx += w * px; my += w * py; mz += w * pz;
            if(dp === UNREACHED) unreached++;
            else if(dp - 1 - REACH_M[mp] / VOXEL > far) { far = dp - 1 - REACH_M[mp] / VOXEL; farAt = [px, py, pz]; }
            for(let k = 0; k < 6; k++) {
                const qx = px + DX[k], qy = py + DY[k], qz = pz + DZ[k];
                const q = p + DQ[k];
                if(!inWorld(qx, qy, qz) || dist[q] === 0) continue;
                const mq = matOf(qx, qy, qz);
                if(k !== 4 && k !== 5 && BOND_CLASS[mq] !== cls) continue;
                if(dist[q] <= BAND + 1) {
                    // contact with the band: sideways, or hanging below it (same class)
                    if(k < 4 || (k === 4 && BOND_CLASS[mq] === cls)) {
                        ni++; ix += qx; iy += qy; iz += qz; if(qy < ymin) ymin = qy; if(qy > ymax) ymax = qy;
                        sig += STRENGTH[mq]; contacts.push(q);
                    }
                    continue;
                }
                if(part.has(q)) continue;
                part.set(q, 1); list.push(q);
            }
        }
        if(list.n < 8) return; // crumbs: leave them
        mx /= m; my /= m; mz /= m;
        const mass = m * VOXEL ** 3;
        let fail = null;
        if(!ni) fail = { reason: 'floating', root: [mx, my, mz], dir: [0, 0, 0] };
        else {
            ix /= ni; iy /= ni; iz /= ni; sig /= ni;
            const area = ni * VOXEL * VOXEL, h = (ymax - ymin + 1) * VOXEL;
            const lever = Math.hypot(mx - ix, mz - iz) * VOXEL;
            const stress = mass * G * lever / (area * h / 6);
            const dir = lever > 1e-3 ? [(mx - ix) * VOXEL / lever, 0, (mz - iz) * VOXEL / lever] : [0, 0, 0];
            const root = [ix, iy, iz];
            if(stress > sig) fail = { reason: 'bending', root, dir, stress, sig, mass, lever };
            else if(far > 0) fail = { reason: 'reach', root, dir, far: far * VOXEL, at: farAt };
            else if(unreached > 64 && unreached > list.n * 0.25) fail = { reason: 'unbonded', root, dir };
        }
        if(!fail) return;
        cut(list, fail);
    }

    /** Cut a failing deep part at the band with a jagged crack; pushes islands (connected pieces). */
    function cut(list, fail) {
        // stubs: just past the band, by the noise (some of the face breaks off flush, some leaves a jagged lip)
        const stubs = new List();
        for(let i = 0; i < list.n; i++) {
            const p = list.a[i], d = dist[p];
            if(d === UNREACHED || d > BAND + 1 + LIP) continue;
            const [x, y, z] = coords(p);
            const lip = (noise(x, y, z, 4) * 1.4 + noise(x, y, z, 1.5) * 0.8 - 0.5) * LIP; // about -2 .. 6.8 samples
            if(d - (BAND + 1) <= lip) { part.set(p, 3); stubs.push(p); }
            else part.set(p, 2);
        }
        for(let i = 0; i < list.n; i++) if(P(list.a[i]) === 1) part.set(list.a[i], 2);
        // a stub must hang on the band through stubs; others fall with the rest
        const keep = new List();
        for(let i = 0; i < stubs.n; i++) {
            const p = stubs.a[i];
            const [px, py, pz] = coords(p);
            let touches = false;
            for(let k = 0; k < 6 && !touches; k++) {
                const qx = px + DX[k], qy = py + DY[k], qz = pz + DZ[k];
                if(inWorld(qx, qy, qz) && dist[p + DQ[k]] !== 0 && dist[p + DQ[k]] <= BAND + 1) touches = true;
            }
            if(touches) { part.set(p, 4); keep.push(p); }
        }
        for(let i = 0; i < keep.n; i++) {
            const p = keep.a[i];
            const [px, py, pz] = coords(p);
            for(let k = 0; k < 6; k++) {
                const qx = px + DX[k], qy = py + DY[k], qz = pz + DZ[k];
                const q = p + DQ[k];
                if(inWorld(qx, qy, qz) && P(q) === 3) { part.set(q, 4); keep.push(q); }
            }
        }
        for(let i = 0; i < stubs.n; i++) if(P(stubs.a[i]) === 3) part.set(stubs.a[i], 2);
        // falling matter (part 2), as connected pieces
        const root = fail.root.map((v, a) => (v + world.smin[a]) * VOXEL);
        const collapse = { root, dir: fail.dir, reason: fail.reason, far: fail.far, stress: fail.stress, sig: fail.sig, mass: fail.mass,
            at: fail.at ? fail.at.map((v, a) => (v + world.smin[a]) * VOXEL) : undefined };
        for(let i = 0; i < list.n; i++) {
            const s = list.a[i];
            if(P(s) !== 2) continue;
            const piece = new List();
            piece.push(s); part.set(s, 5);
            let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
            const hist = new Uint32Array(256);
            for(let j = 0; j < piece.n; j++) {
                const p = piece.a[j];
                const [px, py, pz] = coords(p);
                if(px < mnx) mnx = px; if(px > mxx) mxx = px; if(py < mny) mny = py; if(py > mxy) mxy = py; if(pz < mnz) mnz = pz; if(pz > mxz) mxz = pz;
                hist[matOf(px, py, pz)]++;
                for(let k = 0; k < 6; k++) {
                    const qx = px + DX[k], qy = py + DY[k], qz = pz + DZ[k];
                    const q = p + DQ[k];
                    if(inWorld(qx, qy, qz) && P(q) === 2) { part.set(q, 5); piece.push(q); }
                }
            }
            let mat = 0; for(let k = 1; k < 256; k++) if(hist[k] > hist[mat]) mat = k;
            islands.push({ samples: piece.a.slice(0, piece.n), count: piece.n, min: [mnx + sx, mny + sy, mnz + sz], max: [mxx + sx, mxy + sy, mxz + sz], mat, collapse });
        }
    }
}

export { REACH_M, STRENGTH };
