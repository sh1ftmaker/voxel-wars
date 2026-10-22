/**
 * Voxels <-> grains: the conversion between the SDF terrain and PB-MPM particles. Pure (no DOM, no three.js).
 *
 *   selectGrains(world, opts) -> { idx: Int32Array (lattice x, y, z per grain), mat: Uint8Array, frac: Uint8Array,
 *                                  count, brush }          (terrain worker, inside a 'brush' edit: deterministic)
 *       Granular voxels (src/mpm/params.js GRANULAR: sand, dirt, grass, snow, lava) near an edit that can no longer
 *       hold: their surface is steeper than the material's angle of repose or faces down (undercut), or (a blast)
 *       they are in the crater's rim. Everything above a chosen voxel in its column goes too (no floating caps).
 *       `brush` is a grid brush (spec) that carves exactly those voxels out (the worker applies it with the edit,
 *       so every client's terrain loses the same voxels at the same point of the edit order).
 *       opts: { c: [x, y, z] m, r: m (the edit's size), blast, force (the avalanche key: every granular surface voxel
 *               within r), reach (m, how far around the edit to look), max (grains) }
 *   depositPatch(pos (world m, xyz), w (packed words, params.js), { solidAt }) -> patch
 *       The host's re-deposit of settled particles (sent as a 'deposit' edit): dense matter where it lies, the rest
 *       stacked in columns (see the function).
 *   applyDeposit(world, patch, readRegion) -> result   (terrain worker) the deposit in union with the terrain: a
 *       sample only gets more solid; new solid takes the deposit's material.
 */
import { VOXEL, SDF_SCALE, SDF_MAX, BEDROCK_SAMPLES } from '../config.js';
import { GRANULAR, isGranular, isFlowing, unpackW } from './params.js';

const V = VOXEL;
/** Materials that come back as something else (a grass avalanche leaves dirt). */
const DEPOSIT_AS = { 2: 1 };

export function selectGrains(world, readRegion, { c, r = 1, blast = false, force = false, reach = null, max = 2048 }) {
    reach ??= force ? r : Math.min(5, r * 1.5 + 2);
    const lo = [Math.floor((c[0] - reach) / V) - 1, Math.floor((c[1] - Math.min(reach, 3)) / V) - 1, Math.floor((c[2] - reach) / V) - 1];
    const hi = [Math.ceil((c[0] + reach) / V) + 1, Math.ceil((c[1] + Math.min(reach, 3.5)) / V) + 1, Math.ceil((c[2] + reach) / V) + 1];
    lo[1] = Math.max(lo[1], world.smin[1] + BEDROCK_SAMPLES + 1);
    const reg = readRegion(world, lo, hi);
    const [nx, ny, nz] = reg.dims, nxy = nx * ny, mat = reg.mat;
    const sdf = reg.sdf, orig = sdf.slice(); // sdf: a working copy, chosen samples turn to air as the passes go
    const pick = new Uint8Array(sdf.length);
    const rim = blast ? r + 0.5 : 0, rim2 = rim * rim, reach2 = reach * reach;
    const cosRepose = new Float32Array(32).fill(2);
    for(const m in GRANULAR) cosRepose[m] = Math.cos((GRANULAR[m].friction + 5) * Math.PI / 180);
    const cand = [], hang = [];
    const STEPS = [1, -1, nx, -nx, nxy, -nxy];
    /** Does sample o go? (first pass: also a blast's rim and the avalanche key) */
    const test = (o, first, pass = 0) => {
        const s = sdf[o];
        // solid, granular, near the surface (saturated samples are deep inside)
        if(s >= 0 || s <= -SDF_MAX || pick[o] || !isGranular(mat[o])) return 0;
        const i = o % nx, j = Math.floor(o / nx) % ny, k = Math.floor(o / nxy);
        if(i < 2 || j < 2 || k < 2 || i > nx - 3 || j > ny - 3 || k > nz - 3) return 0;
        const x = (lo[0] + i) * V - c[0], y = (lo[1] + j) * V - c[1], z = (lo[2] + k) * V - c[2];
        const d2 = x * x + y * y + z * z;
        if(d2 > reach2) return 0;
        // outward normal from the distance gradient; it means something only within ~2.5 voxels of the surface
        // (deeper, the distances saturate), and the level's own seams between primitives read like surfaces inside
        // the solid: an air sample within two steps along some axis tells a real surface
        const gx = sdf[o + 1] - sdf[o - 1], gy = sdf[o + nx] - sdf[o - nx], gz = sdf[o + nxy] - sdf[o - nxy];
        const l = Math.sqrt(gx * gx + gy * gy + gz * gz), ny_ = l > 0 ? gy / l : 1;
        let air = false;
        for(const st of STEPS) if(sdf[o + st] >= 0 || sdf[o + 2 * st] >= 0) { air = true; break; }
        const near = air && s > -2.5 * SDF_SCALE && l > SDF_SCALE * 0.75;
        // a blast's rim (the top half metre of the crater's lip), the avalanche key's whole surface layer, or a
        // surface steeper than the angle of repose (5 deg of slack), or facing down (undercut)
        // cohesive ground (dirt, grass, lava) lets go of a blast's lip only, and of what that leaves steep for two
        // passes: tunnels and dug walls hold
        const flowing = isFlowing(mat[o]);
        const steep = near && ny_ < cosRepose[mat[o]] && (flowing || (blast && pass < 2 && d2 < (rim + 1) * (rim + 1)));
        const take = (first && force && air && (flowing || d2 < r * r * 0.25)) || (first && d2 < rim2 && s > -2 * SDF_SCALE) || steep;
        if(!take) return 0;
        return flowing && near && ny_ < 0.1 ? 2 : 1;
    };
    let fresh = [];
    for(let k = 2; k < nz - 2; k++) for(let j = 2; j < ny - 2; j++) for(let i = 2; i < nx - 2; i++) {
        const o = i + j * nx + k * nxy, t = test(o, true);
        if(t) { fresh.push(o); if(t === 2) hang.push(o); }
    }
    // progressive failure: what a pass takes away exposes the matter behind it; where that is now steeper than its
    // angle of repose (an undercut toe, a crater's wall), it goes in the next pass, up the slope
    for(let pass = 0; pass < 10 && fresh.length && cand.length < max * 1.5; pass++) {
        for(const o of fresh) { pick[o] = 1; cand.push(o); }
        for(const o of fresh) {
            sdf[o] = SDF_SCALE >> 1;
            for(const st of STEPS) { if(sdf[o + st] < 0) sdf[o + st] = Math.max(sdf[o + st], -(SDF_SCALE >> 1)); if(sdf[o + 2 * st] < 0) sdf[o + 2 * st] = Math.max(sdf[o + 2 * st], -((3 * SDF_SCALE) >> 1)); }
        }
        const next = new Set();
        for(const o of fresh) for(const st of STEPS) { const q = o + st; if(!pick[q] && sdf[q] < 0) next.add(q); }
        fresh = [];
        for(const q of [...next].sort((a, b) => a - b)) { const t = test(q, false, pass + 1); if(t) { fresh.push(q); if(t === 2) hang.push(q); } }
    }
    for(const o of fresh) { pick[o] = 1; cand.push(o); }
    // what an undercut or a blast leaves hanging above a chosen voxel goes with it (no floating caps)
    for(const o of hang) {
        for(let q = o + nx, n = 0; n < 8 && q < sdf.length; q += nx, n++) {
            if(pick[q]) continue;
            if(sdf[q] >= 0 || !isGranular(mat[q])) break;
            if(!pick[q]) { pick[q] = 1; cand.push(q); }
        }
    }
    // the nearest `max` (deterministic order: distance, then index)
    const list = cand.map(o => {
        const i = o % nx, j = Math.floor(o / nx) % ny, k = Math.floor(o / nxy);
        const x = (lo[0] + i) * V - c[0], y = (lo[1] + j) * V - c[1], z = (lo[2] + k) * V - c[2];
        return [x * x + y * y + z * z, o];
    }).sort((a, b) => a[0] - b[0] || a[1] - b[1]).slice(0, max);
    for(let q = 0; q < pick.length; q++) pick[q] = 0;
    const count = list.length;
    const idx = new Int32Array(count * 3), gm = new Uint8Array(count), frac = new Uint8Array(count);
    list.forEach(([, o], n) => {
        pick[o] = 1;
        const i = o % nx, j = Math.floor(o / nx) % ny, k = Math.floor(o / nxy);
        idx[n * 3] = lo[0] + i; idx[n * 3 + 1] = lo[1] + j; idx[n * 3 + 2] = lo[2] + k;
        gm[n] = mat[o];
        // the share of the voxel cell that is solid: half at the surface, all of it a voxel in
        frac[n] = Math.round(Math.min(1, Math.max(0, 0.5 - orig[o] / SDF_SCALE)) * 255);
    });
    if(!count) return { idx, mat: gm, frac, count, brush: null };
    // the carve: chosen samples go half a voxel out, their kept neighbours come half a voxel in (the new surface
    // between them), everything else is left alone
    let b0 = [Infinity, Infinity, Infinity], b1 = [-Infinity, -Infinity, -Infinity];
    for(let n = 0; n < count; n++) for(let a = 0; a < 3; a++) { b0[a] = Math.min(b0[a], idx[n * 3 + a] - 1); b1[a] = Math.max(b1[a], idx[n * 3 + a] + 1); }
    const dims = [b1[0] - b0[0] + 1, b1[1] - b0[1] + 1, b1[2] - b0[2] + 1];
    const data = new Float64Array(dims[0] * dims[1] * dims[2]).fill(4 * V);
    const at = (x, y, z) => (x - b0[0]) + (y - b0[1]) * dims[0] + (z - b0[2]) * dims[0] * dims[1];
    for(let n = 0; n < count; n++) {
        const x = idx[n * 3], y = idx[n * 3 + 1], z = idx[n * 3 + 2];
        data[at(x, y, z)] = -0.5 * V;
        for(const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
            const q = at(x + dx, y + dy, z + dz);
            if(data[q] > 0.5 * V) data[q] = 0.5 * V;
        }
    }
    const brush = { type: 'grid', min: b0.map(v => v * V), max: b1.map(v => v * V), lo: b0, dims, data };
    return { idx, mat: gm, frac, count, brush };
}

/**
 * Settled particles back to voxels, in two parts that together keep the matter's volume:
 *   dense matter (the volume splatted trilinearly onto the lattice reaches half a voxel): written where it lies, so a
 *     pile, a clump or a sheet of snow on a cliff stays what it is (`grid`: stored distances, half occupied = the
 *     surface, and materials)
 *   the rest (thin films, single grains, matter packed tighter than a voxel holds): per lattice column, stacked on
 *     the surface under it as a heightfield (`base`: the column's lowest grain, `vol`: voxels)
 *   -> { lo: [x, z] (lattice), nx, nz, y0, ny, grid: Int8Array (nx ny nz, x + y nx + z nx ny), gmat, base: Int16Array,
 *        vol: Float32Array, mat: Uint8Array (per column), volume (m³) }  or null
 *   solidAt(x, y, z) (lattice, optional): the terrain there is solid. A grain's share never goes to a column that is
 *   solid at its height (a grain against a wall keeps it in its own column).
 */
export function depositPatch(pos, w, { solidAt = null } = {}) {
    const n = w.length;
    if(!n) return null;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for(let p = 0; p < n; p++) {
        const x = pos[p * 3] / V, y = pos[p * 3 + 1] / V, z = pos[p * 3 + 2] / V;
        x0 = Math.min(x0, Math.floor(x)); x1 = Math.max(x1, Math.ceil(x)); z0 = Math.min(z0, Math.floor(z)); z1 = Math.max(z1, Math.ceil(z));
        y0 = Math.min(y0, Math.floor(y)); y1 = Math.max(y1, Math.ceil(y));
    }
    x0 -= 2; z0 -= 2; x1 += 2; z1 += 2; // room for the remainder to spread
    const nx = x1 - x0 + 1, nz = z1 - z0 + 1, ny = y1 - y0 + 1, N = nx * nz, nxy = nx * ny, NG = nxy * nz;
    const occ = new Float32Array(NG);
    // the terrain's solid samples in the box: a share landing in them goes to the column stack (the union would lose it)
    const solid = new Uint8Array(NG);
    if(solidAt) for(let k = 0; k < nz; k++) for(let j = 0; j < ny; j++) for(let i = 0; i < nx; i++) solid[i + j * nx + k * nxy] = solidAt(x0 + i, y0 + j, z0 + k) ? 1 : 0;
    const vol = new Float32Array(N), base = new Int16Array(N).fill(32767), cvote = new Float32Array(N * 4);
    const toColumn = (col, wt, mi, y) => { vol[col] += wt; cvote[col * 4 + mi] += wt; if(y < base[col]) base[col] = y; };
    const mats = [], votes = [];
    const own = new Int32Array(n), vols = new Float32Array(n), mis = new Uint8Array(n);
    let volume = 0;
    // 1. trilinear occupancy (voxels of matter per sample), with the grains' material votes
    for(let p = 0; p < n; p++) {
        const { mat: m0, ppcLog } = unpackW(w[p]);
        const m = DEPOSIT_AS[m0] ?? m0;
        let mi = mats.indexOf(m);
        if(mi < 0 && mats.length < 4) { mi = mats.length; mats.push(m); votes.push(new Float32Array(NG)); }
        if(mi < 0) mi = 0;
        const v = (1 << ppcLog) / 8; // voxels of matter the particle carries
        vols[p] = v; mis[p] = mi;
        volume += v * V ** 3;
        const fx = pos[p * 3] / V - x0, fy = pos[p * 3 + 1] / V - y0, fz = pos[p * 3 + 2] / V - z0;
        const ix = Math.min(nx - 2, Math.floor(fx)), iy = Math.min(ny - 2, Math.floor(fy)), iz = Math.min(nz - 2, Math.floor(fz));
        const tx = fx - ix, ty = fy - iy, tz = fz - iz;
        own[p] = Math.round(fx) + Math.round(fz) * nx;
        for(let c = 0; c < 2; c++) for(let b = 0; b < 2; b++) for(let a = 0; a < 2; a++) {
            const wt = (a ? tx : 1 - tx) * (b ? ty : 1 - ty) * (c ? tz : 1 - tz) * v, o = (ix + a) + (iy + b) * nx + (iz + c) * nxy;
            if(wt <= 0) continue;
            if(solid[o]) { const col = solid[(ix + a) + Math.min(ny - 1, Math.round(fy)) * nx + (iz + c) * nxy] ? own[p] : (ix + a) + (iz + c) * nx; toColumn(col, wt, mi, y0 + Math.floor(fy)); continue; }
            occ[o] += wt; votes[mi][o] += wt;
        }
    }
    // 2. dense samples are written where they lie; what they do not hold is the remainder, per column
    const grid = new Int8Array(NG).fill(SDF_MAX), gmat = new Uint8Array(NG), mat = new Uint8Array(N);
    for(let k = 0; k < nz; k++) for(let j = 0; j < ny; j++) for(let i = 0; i < nx; i++) {
        const o = i + j * nx + k * nxy, v = occ[o];
        if(v <= 0) continue;
        let best = 0;
        for(let q = 1; q < mats.length; q++) if(votes[q][o] > votes[best][o]) best = q;
        if(v >= 0.5) {
            grid[o] = Math.round((0.5 - Math.min(1, v)) * SDF_SCALE);
            gmat[o] = mats[best];
            if(v > 1) toColumn(i + k * nx, v - 1, best, y0 + j);
        }
    }
    // the sparse grains' share (a sample under half a voxel), back to their columns (never into a wall)
    for(let p = 0; p < n; p++) {
        const fx = pos[p * 3] / V - x0, fy = pos[p * 3 + 1] / V - y0, fz = pos[p * 3 + 2] / V - z0;
        const ix = Math.min(nx - 2, Math.floor(fx)), iy = Math.min(ny - 2, Math.floor(fy)), iz = Math.min(nz - 2, Math.floor(fz));
        const tx = fx - ix, ty = fy - iy, tz = fz - iz, y = y0 + Math.floor(fy);
        for(let c = 0; c < 2; c++) for(let b = 0; b < 2; b++) for(let a = 0; a < 2; a++) {
            const o = (ix + a) + (iy + b) * nx + (iz + c) * nxy;
            if(occ[o] >= 0.5 || solid[o]) continue;
            const wt = (a ? tx : 1 - tx) * (b ? ty : 1 - ty) * (c ? tz : 1 - tz) * vols[p];
            if(wt <= 0) continue;
            let col = (ix + a) + (iz + c) * nx;
            if(col !== own[p] && solid[(ix + a) + Math.min(ny - 1, Math.round(fy)) * nx + (iz + c) * nxy]) col = own[p];
            toColumn(col, wt, mis[p], y);
        }
    }
    // the remainder spread over its neighbours (two conservative [1 2 1] passes in x and z): matter packed tight in a
    // few columns raises the pile around them instead of standing up as a pillar; a column that gets matter only
    // this way starts from its neighbours' lowest grain
    const tmp = new Float32Array(N), tb = new Int16Array(N);
    for(let pass = 0; pass < 4; pass++) {
        const step = pass & 1 ? nx : 1, lim = pass & 1 ? nz : nx;
        tmp.fill(0); tb.set(base);
        for(let k = 0; k < nz; k++) for(let i = 0; i < nx; i++) {
            const c = i + k * nx, v = vol[c];
            if(!(v > 0)) continue;
            const at = pass & 1 ? k : i;
            const lo = at > 0, hi = at < lim - 1;
            const wl = lo ? 0.25 : 0, wh = hi ? 0.25 : 0;
            tmp[c] += v * (1 - wl - wh);
            if(lo) { tmp[c - step] += v * wl; tb[c - step] = Math.min(tb[c - step], base[c]); }
            if(hi) { tmp[c + step] += v * wh; tb[c + step] = Math.min(tb[c + step], base[c]); }
            for(let q = 0; q < 4; q++) { const cv = cvote[c * 4 + q]; if(lo) cvote[(c - step) * 4 + q] += cv * wl; if(hi) cvote[(c + step) * 4 + q] += cv * wh; }
        }
        vol.set(tmp); base.set(tb);
    }
    for(let c = 0; c < N; c++) {
        let best = 0;
        for(let q = 1; q < mats.length; q++) if(cvote[c * 4 + q] > cvote[c * 4 + best]) best = q;
        mat[c] = mats[best] ?? mats[0];
    }
    return { lo: [x0, z0], nx, nz, y0, ny, grid, gmat, base, vol, mat, volume };
}

/**
 * Apply a deposit (terrain worker; the host's 'deposit' edit, so every client gets the same): the dense part in union
 * with the terrain, then each column's remainder stacked on the surface under its lowest grain (the first solid
 * sample at or below it, up to 3 m; a column that starts inside the ground climbs at most 3 samples to its surface;
 * one with nothing under it, or inside a wall, is dropped). Returns writeSamples' result.
 */
export function applyDeposit(world, patch, readRegion) {
    const { lo, nx, nz, base, vol, mat } = patch;
    const DOWN = 12;
    let y0 = patch.y0 ?? Infinity, y1 = patch.y0 !== undefined ? patch.y0 + patch.ny - 1 : -Infinity;
    for(let o = 0; o < base.length; o++) if(vol[o] > 0.005) { y0 = Math.min(y0, base[o]); y1 = Math.max(y1, base[o] + Math.ceil(vol[o])); }
    if(y0 === Infinity) return { changed: 0, box: [[0, 0, 0], [0, 0, 0]] };
    y0 = Math.max(world.smin[1] + BEDROCK_SAMPLES, y0 - DOWN); y1 += 6;
    const ny = y1 - y0 + 1;
    const cur = readRegion(world, [lo[0], y0, lo[1]], [lo[0] + nx - 1, y1, lo[1] + nz - 1]);
    const dx = nx, dxy = nx * ny, sdf = cur.sdf, cm = cur.mat;
    const bedrockTop = world.smin[1] + BEDROCK_SAMPLES;
    // the dense part, in union (and per column the top of it: a column's remainder stacks from there up)
    const top0 = new Int32Array(nx * nz).fill(-1);
    if(patch.grid) {
        const gnxy = nx * patch.ny;
        for(let k = 0; k < nz; k++) for(let j = 0; j < patch.ny; j++) for(let i = 0; i < nx; i++) {
            const g = i + j * nx + k * gnxy, v = patch.grid[g];
            if(v >= SDF_MAX) continue;
            const y = patch.y0 + j;
            if(y < bedrockTop || y < y0 || y > y1) continue;
            const o = i + (y - y0) * dx + k * dxy;
            if(v < sdf[o]) { if(sdf[o] >= 0 && v < 0) cm[o] = patch.gmat[g]; sdf[o] = v; }
            if(v < 0) top0[i + k * nx] = Math.max(top0[i + k * nx], y - y0);
        }
    }
    for(let k = 0; k < nz; k++) for(let i = 0; i < nx; i++) {
        const c = i + k * nx, v = vol[c];
        if(!(v > 0.005)) continue;
        // the ground under the column: the first solid sample at or below its lowest grain
        // (a column on a slope may start inside the ground uphill of its lowest grain: then up to the surface, at
        // most 3 samples)
        let j = Math.min(ny - 1, Math.max(base[c] - y0, top0[c])), floor = null;
        for(let up = 0; up < 3 && j < ny - 1 && sdf[i + j * dx + k * dxy] < 0 && sdf[i + (j + 1) * dx + k * dxy] < 0; up++) j++;
        if(sdf[i + j * dx + k * dxy] < 0 && j + 1 < ny && sdf[i + (j + 1) * dx + k * dxy] < 0) continue; // inside a wall: not a place to pile up
        for(let q = j; q >= Math.max(0, j - DOWN); q--) {
            const o = i + q * dx + k * dxy;
            if(sdf[o] < 0) { const above = q + 1 < ny ? sdf[o + dx] : SDF_MAX; floor = q + (above > 0 ? sdf[o] / (sdf[o] - above) : 1); break; }
        }
        if(floor === null) continue; // nothing under it (off the world's edge): the matter is gone
        const top = floor + v; // lattice units (fractional): the column's new surface
        for(let q = Math.max(0, Math.floor(floor) - 1); q < ny; q++) {
            const d = (q - top) * SDF_SCALE;
            if(d > 4 * SDF_SCALE) break;
            const o = i + q * dx + k * dxy, nv = Math.max(-SDF_MAX, Math.round(d));
            if(y0 + q < bedrockTop) continue;
            if(nv < sdf[o]) { if(sdf[o] >= 0 && nv < 0) cm[o] = mat[c]; sdf[o] = nv; }
        }
    }
    return world.writeSamples({ lo: [lo[0], y0, lo[1]], dims: [nx, ny, nz], sdf, mat: cm });
}
