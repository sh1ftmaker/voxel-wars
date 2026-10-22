/**
 * The voxel world's signed distance field as pages, for the fluid's terrain collisions: one table entry per world chunk
 * (WORLD_CHUNKS) holds either a page index (the chunk's 32³ Int8 samples, copied as they are) or a uniform chunk's fill
 * value (entry = fill - 1000). Only dense chunks take a page, so the whole level fits in ~11 MB and no window has to
 * follow the fluid around. The GPU solver uploads `table` and `data` (as Int32 words) into storage buffers and updates
 * one page per dirty chunk; the CPU solver samples it here.
 *
 *   const sdf = new PageSDF(capacity)       pages available
 *   sdf.setChunk(cx, cy, cz, sdf, fill)     -> page index written (or -1); sdf: Int8Array(32³) or null (uniform)
 *   sdf.fromWorld(world)                    copy every chunk of a VoxelWorld
 *   sdf.sample(x, y, z, out)                trilinear distance (m) -> out[0], gradient (unnormalized) -> out[1..3]
 */
import { VOXEL, CHUNK, SDF_SCALE, SDF_MAX, WORLD_CHUNKS } from '../config.js';

export const NCX = WORLD_CHUNKS.max[0] - WORLD_CHUNKS.min[0];
export const NCY = WORLD_CHUNKS.max[1] - WORLD_CHUNKS.min[1];
export const NCZ = WORLD_CHUNKS.max[2] - WORLD_CHUNKS.min[2];
export const N_CHUNKS = NCX * NCY * NCZ;
export const PAGE = CHUNK * CHUNK * CHUNK; // samples (bytes) per page
export const PAGE_WORDS = PAGE / 4;
export const FILL_BASE = -1000;
const MINX = WORLD_CHUNKS.min[0], MINY = WORLD_CHUNKS.min[1], MINZ = WORLD_CHUNKS.min[2];
const TO_M = VOXEL / SDF_SCALE;

/** Are all of a chunk's distances the same? */
export function uniformSdf(sdf) {
    const w = new Int32Array(sdf.buffer, sdf.byteOffset, PAGE_WORDS), w0 = w[0], b = w0 << 24 >> 24;
    if((w0 >> 24) !== b || (w0 << 8 >> 24) !== b || (w0 << 16 >> 24) !== b) return false;
    for(let i = 1; i < PAGE_WORDS; i++) if(w[i] !== w0) return false;
    return true;
}

export const chunkIndex = (cx, cy, cz) => (cx - MINX) + (cy - MINY) * NCX + (cz - MINZ) * NCX * NCY;

export class PageSDF {
    constructor(capacity) {
        this.capacity = capacity;
        this.table = new Int32Array(N_CHUNKS).fill(FILL_BASE + SDF_MAX);
        this.data = new Int8Array(capacity * PAGE);
        this.free = [];
        for(let i = capacity - 1; i >= 0; i--) this.free.push(i);
        this.overflow = 0;
    }
    /** Store chunk (cx, cy, cz): dense samples `sdf` (Int8Array) or uniform `fill`. Returns the page written or -1. */
    setChunk(cx, cy, cz, sdf, fill = SDF_MAX) {
        const ci = chunkIndex(cx, cy, cz);
        if(ci < 0 || ci >= N_CHUNKS) return -1;
        let e = this.table[ci];
        // a dense chunk whose distances are all the same (solid or air of mixed materials) is uniform for the fluid
        if(sdf && uniformSdf(sdf)) { fill = sdf[0]; sdf = null; }
        if(!sdf) {
            if(e >= 0) this.free.push(e);
            this.table[ci] = FILL_BASE + fill;
            return -1;
        }
        if(e < 0) {
            if(!this.free.length) { this.overflow++; this.table[ci] = FILL_BASE + SDF_MAX; return -1; } // out of pages: air
            e = this.table[ci] = this.free.pop();
        }
        this.data.set(sdf, e * PAGE);
        return e;
    }
    fromWorld(world) {
        for(const c of world.chunks.values()) this.setChunk(c.cx, c.cy, c.cz, c.sdf, c.fill);
        return this;
    }
    /** Stored distance at sample (ix, iy, iz): bedrock below the world, air elsewhere outside. */
    get(ix, iy, iz) {
        const cx = (ix >> 5) - MINX, cy = (iy >> 5) - MINY, cz = (iz >> 5) - MINZ;
        if(cy < 0) return -SDF_MAX;
        if(cx < 0 || cz < 0 || cx >= NCX || cy >= NCY || cz >= NCZ) return SDF_MAX;
        const e = this.table[cx + cy * NCX + cz * NCX * NCY];
        if(e < 0) return e - FILL_BASE;
        return this.data[e * PAGE + (ix & 31) + ((iy & 31) << 5) + ((iz & 31) << 10)];
    }
    sample(x, y, z, out) {
        const fx = x / VOXEL, fy = y / VOXEL, fz = z / VOXEL;
        const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
        const tx = fx - ix, ty = fy - iy, tz = fz - iz;
        const c000 = this.get(ix, iy, iz), c100 = this.get(ix + 1, iy, iz), c010 = this.get(ix, iy + 1, iz), c110 = this.get(ix + 1, iy + 1, iz);
        const c001 = this.get(ix, iy, iz + 1), c101 = this.get(ix + 1, iy, iz + 1), c011 = this.get(ix, iy + 1, iz + 1), c111 = this.get(ix + 1, iy + 1, iz + 1);
        const x00 = c000 + (c100 - c000) * tx, x10 = c010 + (c110 - c010) * tx, x01 = c001 + (c101 - c001) * tx, x11 = c011 + (c111 - c011) * tx;
        const y0 = x00 + (x10 - x00) * ty, y1 = x01 + (x11 - x01) * ty;
        out[0] = (y0 + (y1 - y0) * tz) * TO_M;
        // analytic gradient of the trilinear interpolation (stored units per voxel: only the direction is used)
        const dx00 = c100 - c000, dx10 = c110 - c010, dx01 = c101 - c001, dx11 = c111 - c011;
        out[1] = (dx00 + (dx10 - dx00) * ty) * (1 - tz) + (dx01 + (dx11 - dx01) * ty) * tz;
        out[2] = (x10 - x00) * (1 - tz) + (x11 - x01) * tz;
        out[3] = y1 - y0;
        return out[0];
    }
}
