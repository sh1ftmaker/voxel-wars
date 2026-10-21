/**
 * Read-only sample regions of the VoxelWorld replica (chunk by chunk, no per-sample map lookups), and the write-back
 * of a plastic bake.
 *
 *   readRegion(world, lo, hi) -> { sdf: Int8Array, mat: Uint8Array, lo, dims }   samples lo..hi inclusive
 *   applyPatch(world, patch) -> Promise<changed>                                   write a bake back (see below)
 */
import { CHUNK, SDF_MAX } from '../config.js';
import { BEDROCK } from '../voxel/materials.js';
import { chunkKey } from '../voxel/VoxelWorld.js';

const N = CHUNK, N2 = N * N;

export function readRegion(world, lo, hi) {
    const dims = [hi[0] - lo[0] + 1, hi[1] - lo[1] + 1, hi[2] - lo[2] + 1];
    const dx = dims[0], dxy = dims[0] * dims[1];
    const sdf = new Int8Array(dxy * dims[2]), mat = new Uint8Array(sdf.length);
    for(let cz = Math.floor(lo[2] / N); cz <= Math.floor(hi[2] / N); cz++)
    for(let cy = Math.floor(lo[1] / N); cy <= Math.floor(hi[1] / N); cy++)
    for(let cx = Math.floor(lo[0] / N); cx <= Math.floor(hi[0] / N); cx++) {
        const x0 = Math.max(lo[0], cx * N), x1 = Math.min(hi[0], cx * N + N - 1);
        const y0 = Math.max(lo[1], cy * N), y1 = Math.min(hi[1], cy * N + N - 1);
        const z0 = Math.max(lo[2], cz * N), z1 = Math.min(hi[2], cz * N + N - 1);
        const c = world.chunks.get(chunkKey(cx, cy, cz));
        // outside the world: bedrock below, air elsewhere (the sides are treated as air: zones there are rare)
        const fill = c ? c.fill : (cy < world.bounds.min[1] ? -SDF_MAX : SDF_MAX);
        const fillMat = c ? c.fillMat : BEDROCK;
        for(let z = z0; z <= z1; z++) for(let y = y0; y <= y1; y++) {
            let o = (x0 - lo[0]) + (y - lo[1]) * dx + (z - lo[2]) * dxy;
            if(c && c.sdf) {
                const i = (x0 - cx * N) + (y - cy * N) * N + (z - cz * N) * N2, len = x1 - x0 + 1;
                sdf.set(c.sdf.subarray(i, i + len), o); mat.set(c.mat.subarray(i, i + len), o);
            } else { sdf.fill(fill, o, o + x1 - x0 + 1); mat.fill(fillMat, o, o + x1 - x0 + 1); }
        }
    }
    return { sdf, mat, lo: [...lo], dims };
}

/** Versions of the chunks overlapping a sample box (to detect edits while a bake was computed off-thread). */
export function chunkVersions(world, lo, hi) {
    let s = '';
    for(let cz = Math.floor(lo[2] / N); cz <= Math.floor(hi[2] / N); cz++)
    for(let cy = Math.floor(lo[1] / N); cy <= Math.floor(hi[1] / N); cy++)
    for(let cx = Math.floor(lo[0] / N); cx <= Math.floor(hi[0] / N); cx++) s += (world.chunks.get(chunkKey(cx, cy, cz))?.version ?? -1) + ',';
    return s;
}

/**
 * Hand a baked patch { lo, dims, sdf, mat } to the world: `world.applySamples(patch)` (the terrain worker owns the
 * edits; the replica's listeners run when its reply lands, with kind 'samples') or, without a terrain worker,
 * `world.writeSamples(patch)` (synchronous, listeners run inside with kind 'soft'). Resolves to the changed count.
 */
export async function applyPatch(world, patch) {
    if(typeof world.applySamples === 'function') { const rep = await world.applySamples(patch); return rep?.result?.changed ?? 1; }
    return world.writeSamples(patch).changed;
}
