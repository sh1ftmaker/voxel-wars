/**
 * Zones and seeding, shared by the GPU and CPU backends (src/mpm/Mpm.js) and the tests. Pure.
 *
 *   zoneLo(c)                         lattice origin of a zone centred on c (m): ZONE_DIMS nodes, biased upward
 *                                     (grains fall: more room above the ground than below it)
 *   zoneField(world, lo, readRegion)  the terrain's stored distances at the zone's nodes (Int8Array, x + y nx + z nx ny)
 *   seed(grains, lo, opts)            particles for a worker reply's grains: per grain voxel ppc particles (fewer for
 *                                     a part-solid surface voxel) jittered in its cell, with a kick for blasts.
 *                                     -> { pos (grid units, zone-local), vel (m/s), mats, n, ppcLog }
 *   dropStranded(pos, lo, world)      before a deposit: particles held up by the zone's floor or walls (they ran out of
 *                                     the zone, e.g. off a ridge) fall straight down onto the terrain (pos: world m)
 */
import { H, ZONE_DIMS, GUARD } from './params.js';

export function zoneLo(c, dims = ZONE_DIMS) {
    return [Math.floor(c[0] / H) - (dims[0] >> 1), Math.floor(c[1] / H) - Math.round(dims[1] * 0.42), Math.floor(c[2] / H) - (dims[2] >> 1)];
}
export function zoneField(world, lo, readRegion, dims = ZONE_DIMS) {
    return readRegion(world, lo, [lo[0] + dims[0] - 1, lo[1] + dims[1] - 1, lo[2] + dims[2] - 1]).sdf;
}
/** Does the zone at `lo` hold lattice point q with room for the stencil? */
export function inZone(lo, q, dims = ZONE_DIMS, margin = GUARD + 1) {
    for(let a = 0; a < 3; a++) { const v = q[a] - lo[a]; if(v < margin || v > dims[a] - 1 - margin) return false; }
    return true;
}

const OCT = [[0, 0, 0], [1, 1, 1], [1, 0, 0], [0, 1, 1], [0, 1, 0], [1, 0, 1], [0, 0, 1], [1, 1, 0]]; // spread first

/** grains: { idx, mat, frac, count }; opts: { ppcLog (0: 8 per voxel .. 3: 1), c (m), kick (m/s), rim (m), rand } */
export function seed(grains, lo, { ppcLog = 0, c = null, kick = 0, rim = 1, rand = Math.random, dims = ZONE_DIMS } = {}) {
    const ppc = 8 >> ppcLog, n0 = grains.count;
    const pos = new Float32Array(n0 * ppc * 3), vel = new Float32Array(n0 * ppc * 3), mats = new Uint8Array(n0 * ppc);
    let n = 0;
    const lim = dims.map(v => v - 1 - GUARD - 0.01);
    for(let g = 0; g < n0; g++) {
        const f = grains.frac[g] / 255;
        const k = Math.max(f > 0.3 ? 1 : 0, Math.round(ppc * f));
        const x = grains.idx[g * 3] - lo[0], y = grains.idx[g * 3 + 1] - lo[1], z = grains.idx[g * 3 + 2] - lo[2];
        const sub = 0.25; // octant offsets: 8 per voxel in all three axes, 4 in x and z, 2 in x
        const rot = Math.floor(rand() * 8);
        for(let q = 0; q < k; q++) {
            const o = OCT[(q + rot) % 8];
            let px = x + (ppc >= 2 ? (o[0] ? sub : -sub) : 0) + (rand() - 0.5) * 0.2;
            let py = y + (ppc >= 8 ? (o[1] ? sub : -sub) : 0) + (rand() - 0.5) * 0.2;
            let pz = z + (ppc >= 4 ? (o[2] ? sub : -sub) : 0) + (rand() - 0.5) * 0.2;
            px = Math.min(lim[0], Math.max(GUARD, px)); py = Math.min(lim[1], Math.max(GUARD, py)); pz = Math.min(lim[2], Math.max(GUARD, pz));
            pos[n * 3] = px; pos[n * 3 + 1] = py; pos[n * 3 + 2] = pz;
            mats[n] = grains.mat[g];
            if(kick > 0 && c) {
                // blast ejecta: away from the centre and up, strongest at the crater
                const wx = (lo[0] + px) * H - c[0], wy = (lo[1] + py) * H - c[1], wz = (lo[2] + pz) * H - c[2];
                const l = Math.hypot(wx, wy, wz) || 1, fall = Math.max(0, 1 - l / rim);
                const s = kick * fall * (0.6 + 0.8 * rand());
                vel[n * 3] = wx / l * s; vel[n * 3 + 1] = (Math.max(0, wy / l) * 0.5 + 0.7) * s; vel[n * 3 + 2] = wz / l * s;
            }
            n++;
        }
    }
    return { pos: pos.subarray(0, n * 3), vel: vel.subarray(0, n * 3), mats: mats.subarray(0, n), n, ppcLog };
}

export function dropStranded(pos, lo, world, dims = ZONE_DIMS) {
    let moved = 0;
    const m = (GUARD + 0.75) * H;
    for(let p = 0; p < pos.length / 3; p++) {
        const x = pos[p * 3], y = pos[p * 3 + 1], z = pos[p * 3 + 2];
        const atWall = y - lo[1] * H < m || x - lo[0] * H < m || z - lo[2] * H < m
            || (lo[0] + dims[0] - 1) * H - x < m || (lo[1] + dims[1] - 1) * H - y < m || (lo[2] + dims[2] - 1) * H - z < m;
        if(!atWall || world.sample(x, y, z) < 0.3) continue;
        const hit = world.raycast([x, y, z], [0, -1, 0], 40);
        if(hit) { pos[p * 3 + 1] = hit.point[1] + 0.06; moved++; }
    }
    return moved;
}
