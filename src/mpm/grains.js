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
 *   depositPatch(pos (world m, xyz), w (packed words, params.js), opts) -> { lo, dims, sdf, mat, volume }
 *       The host's re-deposit of settled particles: their volume splatted (trilinear) onto the lattice, the
 *       occupancy turned into a signed distance (half occupied = the surface). Sent as a 'deposit' edit.
 *   applyDeposit(world, patch, readRegion) -> result   (terrain worker) union of the patch with the terrain: a sample
 *       only gets more solid; new solid takes the deposit's material.
 */
import { VOXEL, SDF_SCALE, SDF_MAX, BEDROCK_SAMPLES } from '../config.js';
import { GRANULAR, isGranular, unpackW } from './params.js';

const V = VOXEL;
/** Materials that come back as something else (a grass avalanche leaves dirt). */
const DEPOSIT_AS = { 2: 1 };

export function selectGrains(world, readRegion, { c, r = 1, blast = false, force = false, reach = null, max = 2048 }) {
    reach ??= force ? r : Math.min(5, r * 1.5 + 2);
    const lo = [Math.floor((c[0] - reach) / V) - 1, Math.floor((c[1] - Math.min(reach, 3)) / V) - 1, Math.floor((c[2] - reach) / V) - 1];
    const hi = [Math.ceil((c[0] + reach) / V) + 1, Math.ceil((c[1] + Math.min(reach, 3.5)) / V) + 1, Math.ceil((c[2] + reach) / V) + 1];
    lo[1] = Math.max(lo[1], world.smin[1] + BEDROCK_SAMPLES + 1);
    const reg = readRegion(world, lo, hi);
    const [nx, ny, nz] = reg.dims, nxy = nx * ny, sdf = reg.sdf, mat = reg.mat;
    const pick = new Uint8Array(sdf.length);
    const rim = blast ? r + 0.5 : 0, rim2 = rim * rim, reach2 = reach * reach;
    const cosRepose = new Float32Array(32).fill(2);
    for(const m in GRANULAR) cosRepose[m] = Math.cos((GRANULAR[m].friction + 5) * Math.PI / 180);
    const cand = [], hang = [];
    for(let k = 1; k < nz - 1; k++) for(let j = 1; j < ny - 1; j++) for(let i = 1; i < nx - 1; i++) {
        const o = i + j * nx + k * nxy, s = sdf[o];
        // solid, granular, near the surface (saturated samples are deep inside)
        if(s >= 0 || s <= -SDF_MAX || !isGranular(mat[o])) continue;
        const x = (lo[0] + i) * V - c[0], y = (lo[1] + j) * V - c[1], z = (lo[2] + k) * V - c[2];
        const d2 = x * x + y * y + z * z;
        if(d2 > reach2) continue;
        // outward normal from the distance gradient
        const gx = sdf[o + 1] - sdf[o - 1], gy = sdf[o + nx] - sdf[o - nx], gz = sdf[o + nxy] - sdf[o - nxy];
        const l = Math.sqrt(gx * gx + gy * gy + gz * gz), ny_ = l > 0 ? gy / l : 1;
        // a blast's rim (the top half metre of the crater's lip), the avalanche key's whole surface layer, or a
        // surface steeper than the angle of repose (5 deg of slack), or facing down (undercut)
        // (the gradient means something only within ~2.5 voxels of the surface: deeper, the distances saturate)
        // (and the level's own seams between primitives read like surfaces inside the solid: an air sample within two
        // steps along some axis tells a real surface)
        let air = false;
        for(const st of [1, nx, nxy]) if(sdf[o + st] >= 0 || sdf[o - st] >= 0 || (o + 2 * st < sdf.length && sdf[o + 2 * st] >= 0) || (o - 2 * st >= 0 && sdf[o - 2 * st] >= 0)) { air = true; break; }
        const near = air && s > -2.5 * SDF_SCALE && l > SDF_SCALE * 0.75;
        const take = (force && air) || (d2 < rim2 && s > -2 * SDF_SCALE) || (near && ny_ < cosRepose[mat[o]]);
        const under = near && ny_ < 0.1;
        if(globalThis.MPM_DEBUG && take) { const D = globalThis.MPM_DBG ||= {}; const k = (d2 < rim2 && s > -64 ? 'rim' : 'steep') + (under ? '-under' : '') + '-m' + mat[o]; D[k] = (D[k] || 0) + 1; }
        if(take) { pick[o] = 1; cand.push(o); if(under) hang.push(o); }
    }
    // what an undercut or a blast leaves hanging above a chosen voxel goes with it (no floating caps)
    for(const o of hang) {
        for(let q = o + nx, n = 0; n < 8 && q < sdf.length; q += nx, n++) {
            if(sdf[q] >= 0 || !isGranular(mat[q])) break;
            if(!pick[q]) { pick[q] = 1; cand.push(q); }
        }
    }
    if(globalThis.MPM_DEBUG) { console.log(JSON.stringify(globalThis.MPM_DBG)); globalThis.MPM_DBG = {}; }
    if(globalThis.MPM_DEBUG) console.log("grains: candidates", cand.length, "hanging", hang.length, "rim", rim.toFixed(2), "reach", reach.toFixed(2));
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
        frac[n] = Math.round(Math.min(1, Math.max(0, 0.5 - sdf[o] / SDF_SCALE)) * 255);
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
 * Settled particles as columns of matter: their volume splatted (bilinear in x, z) onto the lattice's columns, with
 * the lowest particle of each column (where the worker starts looking for the ground) and the column's main material.
 *   -> { lo: [x, z] (lattice), nx, nz, base: Int16Array (lattice y), vol: Float32Array (voxels), mat: Uint8Array,
 *        volume (m³) }  or null
 */
export function depositPatch(pos, w) {
    const n = w.length;
    if(!n) return null;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for(let p = 0; p < n; p++) {
        const x = pos[p * 3] / V, z = pos[p * 3 + 2] / V;
        x0 = Math.min(x0, Math.floor(x)); x1 = Math.max(x1, Math.ceil(x)); z0 = Math.min(z0, Math.floor(z)); z1 = Math.max(z1, Math.ceil(z));
    }
    const nx = x1 - x0 + 1, nz = z1 - z0 + 1, N = nx * nz;
    const vol = new Float32Array(N), base = new Int16Array(N).fill(32767), mat = new Uint8Array(N);
    const mats = [], votes = [];
    let volume = 0;
    for(let p = 0; p < n; p++) {
        const { mat: m0, ppcLog } = unpackW(w[p]);
        const m = DEPOSIT_AS[m0] ?? m0;
        let mi = mats.indexOf(m);
        if(mi < 0 && mats.length < 4) { mi = mats.length; mats.push(m); votes.push(new Float32Array(N)); }
        if(mi < 0) mi = 0;
        const v = (1 << ppcLog) / 8; // voxels of matter the particle carries
        volume += v * V ** 3;
        const fx = pos[p * 3] / V - x0, fz = pos[p * 3 + 2] / V - z0, y = Math.floor(pos[p * 3 + 1] / V);
        const ix = Math.min(nx - 2, Math.floor(fx)), iz = Math.min(nz - 2, Math.floor(fz)), tx = fx - ix, tz = fz - iz;
        for(let b = 0; b < 2; b++) for(let a = 0; a < 2; a++) {
            const wt = (a ? tx : 1 - tx) * (b ? tz : 1 - tz) * v, o = (ix + a) + (iz + b) * nx;
            vol[o] += wt; votes[mi][o] += wt;
            if(wt > 0.01 * v && y < base[o]) base[o] = y;
        }
    }
    for(let o = 0; o < N; o++) {
        let best = 0;
        for(let q = 1; q < mats.length; q++) if(votes[q][o] > votes[best][o]) best = q;
        mat[o] = mats[best];
    }
    return { lo: [x0, z0], nx, nz, base, vol, mat, volume };
}

/**
 * Stack a deposit's columns on the terrain (terrain worker; the host's 'deposit' edit, so every client gets the same):
 * in each column, the ground is the first solid sample at or below the column's lowest particle (or that particle's
 * height when there is none within 3 m); the column's volume goes on top of it as a heightfield (fractional top), in
 * union with the terrain. Returns writeSamples' result.
 */
export function applyDeposit(world, patch, readRegion) {
    const { lo, nx, nz, base, vol, mat } = patch;
    let y0 = Infinity, y1 = -Infinity;
    for(let o = 0; o < base.length; o++) if(vol[o] > 0.005) { y0 = Math.min(y0, base[o]); y1 = Math.max(y1, base[o] + Math.ceil(vol[o])); }
    if(y0 === Infinity) return { changed: 0, box: [[0, 0, 0], [0, 0, 0]] };
    const DOWN = 12;
    y0 = Math.max(world.smin[1] + BEDROCK_SAMPLES, y0 - DOWN); y1 += 6;
    const ny = y1 - y0 + 1;
    const cur = readRegion(world, [lo[0], y0, lo[1]], [lo[0] + nx - 1, y1, lo[1] + nz - 1]);
    const dx = nx, dxy = nx * ny, sdf = cur.sdf, cm = cur.mat;
    for(let k = 0; k < nz; k++) for(let i = 0; i < nx; i++) {
        const c = i + k * nx, v = vol[c];
        if(!(v > 0.005)) continue;
        // the ground under the column: the first solid sample at or below its lowest particle
        // (a column on a slope may start inside the ground uphill of its lowest particle: then go up to the surface)
        let j = Math.min(ny - 1, base[c] - y0), floor = null;
        while(j < ny - 1 && sdf[i + j * dx + k * dxy] < 0 && sdf[i + (j + 1) * dx + k * dxy] < 0) j++;
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
            if(nv < sdf[o]) { if(sdf[o] >= 0 && nv < 0) cm[o] = mat[c]; sdf[o] = nv; }
        }
    }
    return world.writeSamples({ lo: [lo[0], y0, lo[1]], dims: [nx, ny, nz], sdf, mat: cm });
}
