/**
 * Fill a VoxelWorld from a signed distance field `{ sdf(x, y, z), material(x, y, z) }` (metres, negative inside).
 *
 * Works in blocks of B³ samples: a block whose centre distance is further from the surface than its half diagonal
 * plus the stored band is filled uniformly without evaluating its samples, so only the thin shell around the surface
 * costs a full evaluation. `sdf` must not overestimate distances (Lipschitz 1 or less); a capped field such as
 * Level's (it returns at most REACH) works as long as REACH exceeds the block test radius.
 */
import { VOXEL, CHUNK, SDF_MAX } from '../config.js';
import { toStored } from './VoxelWorld.js';

const B = 4; // block edge in samples (1 m)

export function voxelize(world, field, { onProgress } = {}) {
    const N = CHUNK, N2 = N * N, N3 = N * N * N;
    const reachTest = (B * Math.sqrt(3) / 2 + 4.5) * VOXEL; // block half diagonal + saturated band (4 voxels) + margin
    let dense = 0, i = 0;
    const total = world.chunks.size;
    for(const c of world.chunks.values()) {
        i++;
        const sdf = new Int8Array(N3), mat = new Uint8Array(N3);
        let anyIn = false, anyOut = false, mixedMat = false, firstMat = -1;
        for(let bz = 0; bz < N; bz += B) for(let by = 0; by < N; by += B) for(let bx = 0; bx < N; bx += B) {
            const ox = c.cx * N + bx, oy = c.cy * N + by, oz = c.cz * N + bz;
            const cxm = (ox + (B - 1) / 2) * VOXEL, cym = (oy + (B - 1) / 2) * VOXEL, czm = (oz + (B - 1) / 2) * VOXEL;
            const dc = field.sdf(cxm, cym, czm);
            if(dc > reachTest) {
                for(let z = 0; z < B; z++) for(let y = 0; y < B; y++) { const o = bx + (by + y) * N + (bz + z) * N2; sdf.fill(SDF_MAX, o, o + B); }
                anyOut = true;
                continue;
            }
            if(dc < -reachTest) {
                // solid block: one material if its corners and centre agree
                const ms = [field.material(cxm, cym, czm)];
                for(const [a, b, d] of [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]])
                    ms.push(field.material((ox + a * (B - 1)) * VOXEL, (oy + b * (B - 1)) * VOXEL, (oz + d * (B - 1)) * VOXEL));
                const one = ms.every(m => m === ms[0]);
                for(let z = 0; z < B; z++) for(let y = 0; y < B; y++) for(let x = 0; x < B; x++) {
                    const o = (bx + x) + (by + y) * N + (bz + z) * N2;
                    sdf[o] = -SDF_MAX;
                    mat[o] = one ? ms[0] : field.material((ox + x) * VOXEL, (oy + y) * VOXEL, (oz + z) * VOXEL);
                }
                anyIn = true;
                if(!one || (firstMat >= 0 && firstMat !== ms[0])) mixedMat = true;
                if(firstMat < 0) firstMat = ms[0];
                continue;
            }
            for(let z = 0; z < B; z++) for(let y = 0; y < B; y++) for(let x = 0; x < B; x++) {
                const px = (ox + x) * VOXEL, py = (oy + y) * VOXEL, pz = (oz + z) * VOXEL;
                const d = field.sdf(px, py, pz);
                const o = (bx + x) + (by + y) * N + (bz + z) * N2;
                // a sample exactly on a surface counts as inside: where two solids of a union share a face (the grass
                // layer on the dirt) the field reads 0 along it, and a 0 there would leave a sheet of air inside
                sdf[o] = d <= 1e-6 ? Math.min(-1, toStored(d)) : toStored(d);
                if(d < VOXEL * 2) mat[o] = field.material(px, py, pz);
                anyIn ||= d < 0; anyOut ||= d >= 0;
            }
            mixedMat = true;
        }
        if(anyIn && !anyOut && !mixedMat) { c.sdf = null; c.mat = null; c.fill = -SDF_MAX; c.fillMat = firstMat; }
        else if(anyOut && !anyIn && !mixedMat) { c.sdf = null; c.mat = null; c.fill = SDF_MAX; c.fillMat = 0; }
        else { c.sdf = sdf; c.mat = mat; c.tryCollapse(); dense += c.sdf ? 1 : 0; }
        c.version++;
        if(onProgress && (i & 31) === 0) onProgress(i / total);
    }
    return { dense, total };
}
