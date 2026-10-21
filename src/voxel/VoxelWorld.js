/**
 * The terrain: a sparse grid of chunks holding a signed distance lattice and a material per sample.
 *
 * Sample (ix, iy, iz) sits at world position (ix, iy, iz) * VOXEL. Stored distances are Int8, SDF_SCALE units per
 * voxel, negative inside solid. A chunk is either uniform (`sdf === null`: every sample is `fill` with material
 * `fillMat`) or dense (`sdf`, `mat`: CHUNK³ entries, index x + y*CHUNK + z*CHUNK², local sample coordinates).
 * Below the world is solid bedrock, everywhere else outside it is air.
 *
 * Every edit goes through `applyBrush`, which returns what changed (removed/added volume per material, dirty chunks,
 * the box it touched) and notifies `onChange` listeners, so renderers, colliders and connectivity can follow.
 */
import { VOXEL, CHUNK, SDF_SCALE, SDF_MAX, PAD, WORLD_CHUNKS, BEDROCK_SAMPLES } from '../config.js';
import { REACH, BEDROCK } from './materials.js';

const N = CHUNK, N2 = N * N, N3 = N * N * N;
export const toStored = (d) => { const v = Math.round(d / VOXEL * SDF_SCALE); return v > SDF_MAX ? SDF_MAX : v < -SDF_MAX ? -SDF_MAX : v; };
export const toMetres = (s) => s * VOXEL / SDF_SCALE;
export const chunkKey = (cx, cy, cz) => `${cx},${cy},${cz}`;

export class Chunk {
    constructor(cx, cy, cz, fill = SDF_MAX, fillMat = 0) {
        this.cx = cx; this.cy = cy; this.cz = cz;
        this.key = chunkKey(cx, cy, cz);
        this.sdf = null; this.mat = null;
        this.fill = fill; this.fillMat = fillMat;
        this.version = 0;
    }
    get uniform() { return this.sdf === null; }
    densify() {
        if(this.sdf) return;
        this.sdf = new Int8Array(N3).fill(this.fill);
        this.mat = new Uint8Array(N3).fill(this.fillMat);
    }
    /** Collapse back to uniform if every sample is saturated the same way with one material. */
    tryCollapse() {
        if(!this.sdf) return;
        const s0 = this.sdf[0], m0 = this.mat[0];
        if(s0 !== SDF_MAX && s0 !== -SDF_MAX) return;
        for(let i = 1; i < N3; i++) if(this.sdf[i] !== s0 || (s0 < 0 && this.mat[i] !== m0)) return;
        this.fill = s0; this.fillMat = m0; this.sdf = null; this.mat = null;
    }
}

export class VoxelWorld {
    constructor(bounds = WORLD_CHUNKS) {
        this.bounds = bounds;
        this.chunks = new Map();
        this.listeners = [];
        // sample bounds of the world
        this.smin = bounds.min.map(c => c * N);
        this.smax = bounds.max.map(c => c * N);
        for(let cz = bounds.min[2]; cz < bounds.max[2]; cz++) for(let cy = bounds.min[1]; cy < bounds.max[1]; cy++) for(let cx = bounds.min[0]; cx < bounds.max[0]; cx++)
            this.chunks.set(chunkKey(cx, cy, cz), new Chunk(cx, cy, cz));
    }
    onChange(fn) { this.listeners.push(fn); return () => this.listeners.splice(this.listeners.indexOf(fn), 1); }
    chunk(cx, cy, cz) { return this.chunks.get(chunkKey(cx, cy, cz)); }
    inWorld(ix, iy, iz) { const a = this.smin, b = this.smax; return ix >= a[0] && iy >= a[1] && iz >= a[2] && ix < b[0] && iy < b[1] && iz < b[2]; }

    /** Stored distance at a sample (bedrock below the world, air elsewhere outside). */
    get(ix, iy, iz) {
        const c = this.chunks.get(chunkKey(Math.floor(ix / N), Math.floor(iy / N), Math.floor(iz / N)));
        if(!c) return iy < this.smin[1] ? -SDF_MAX : SDF_MAX;
        if(!c.sdf) return c.fill;
        return c.sdf[(ix - c.cx * N) + (iy - c.cy * N) * N + (iz - c.cz * N) * N2];
    }
    getMat(ix, iy, iz) {
        const c = this.chunks.get(chunkKey(Math.floor(ix / N), Math.floor(iy / N), Math.floor(iz / N)));
        if(!c) return BEDROCK;
        if(!c.sdf) return c.fillMat;
        return c.mat[(ix - c.cx * N) + (iy - c.cy * N) * N + (iz - c.cz * N) * N2];
    }
    /** Trilinear signed distance in metres at a world position (negative inside). */
    sample(x, y, z) {
        const fx = x / VOXEL, fy = y / VOXEL, fz = z / VOXEL;
        const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
        const tx = fx - ix, ty = fy - iy, tz = fz - iz;
        const g = (a, b, c) => this.get(ix + a, iy + b, iz + c);
        const c00 = g(0, 0, 0) * (1 - tx) + g(1, 0, 0) * tx, c10 = g(0, 1, 0) * (1 - tx) + g(1, 1, 0) * tx;
        const c01 = g(0, 0, 1) * (1 - tx) + g(1, 0, 1) * tx, c11 = g(0, 1, 1) * (1 - tx) + g(1, 1, 1) * tx;
        return toMetres((c00 * (1 - ty) + c10 * ty) * (1 - tz) + (c01 * (1 - ty) + c11 * ty) * tz);
    }
    /** Outward surface normal (normalized gradient) at a world position. */
    normal(x, y, z, out = [0, 0, 0]) {
        const h = VOXEL * 0.5;
        out[0] = this.sample(x + h, y, z) - this.sample(x - h, y, z);
        out[1] = this.sample(x, y + h, z) - this.sample(x, y - h, z);
        out[2] = this.sample(x, y, z + h) - this.sample(x, y, z - h);
        const l = Math.hypot(out[0], out[1], out[2]) || 1;
        out[0] /= l; out[1] /= l; out[2] /= l;
        return out;
    }
    /** Material of the nearest solid sample around a world position. */
    materialAt(x, y, z) {
        const ix = Math.round(x / VOXEL), iy = Math.round(y / VOXEL), iz = Math.round(z / VOXEL);
        let best = Infinity, mat = 1;
        for(let c = -1; c <= 1; c++) for(let b = -1; b <= 1; b++) for(let a = -1; a <= 1; a++) {
            const d = this.get(ix + a, iy + b, iz + c);
            if(d < best) { best = d; mat = this.getMat(ix + a, iy + b, iz + c); }
        }
        return mat;
    }

    /** Sphere-trace a ray against the terrain. dir must be normalized. Returns { point, normal, distance, mat } or null. */
    raycast(o, d, maxDist = 200) {
        let t = 0, prev = this.sample(o[0], o[1], o[2]);
        if(prev < 0) return { point: [...o], normal: [-d[0], -d[1], -d[2]], distance: 0, mat: this.materialAt(o[0], o[1], o[2]) };
        while(t < maxDist) {
            // stored distances saturate at ~4 voxels, so the step is safe but never more than that
            const step = Math.max(prev * 0.9, VOXEL * 0.25);
            const nt = Math.min(t + step, maxDist);
            const s = this.sample(o[0] + d[0] * nt, o[1] + d[1] * nt, o[2] + d[2] * nt);
            if(s < 0) {
                // bisect between t (outside) and nt (inside)
                let a = t, b = nt;
                for(let i = 0; i < 8; i++) { const m = (a + b) / 2; if(this.sample(o[0] + d[0] * m, o[1] + d[1] * m, o[2] + d[2] * m) < 0) b = m; else a = m; }
                const p = [o[0] + d[0] * a, o[1] + d[1] * a, o[2] + d[2] * a];
                return { point: p, normal: this.normal(p[0], p[1], p[2]), distance: a, mat: this.materialAt(p[0], p[1], p[2]) };
            }
            if(nt >= maxDist) break;
            t = nt; prev = s;
        }
        return null;
    }

    /**
     * Edit the terrain with a brush `{ min, max, d(x, y, z) }` (world AABB in metres and signed distance, negative inside).
     *   op 'carve': remove the brush's volume; with `hardness` (default true) the brush reaches 1/sqrt(hardness) as far
     *               into each material, so a blast leaves a shallow dish in stone and a bowl in dirt.
     *   op 'add':   fill the brush's volume with material `mat`.
     *   op 'paint': change the material of solid samples inside the brush to `mat`.
     * Returns { removed: Float64Array(256) m³ per material, added (m³), dirty: Set of chunk keys, box: [min, max] in samples }.
     */
    applyBrush(brush, { op = 'carve', mat = 1, hardness = true, notify = true } = {}) {
        const band = 4; // samples outside the brush whose stored (saturated) distances may still change
        const lo = brush.min.map(v => Math.floor(v / VOXEL) - band), hi = brush.max.map(v => Math.ceil(v / VOXEL) + band);
        for(let a = 0; a < 3; a++) { lo[a] = Math.max(lo[a], this.smin[a]); hi[a] = Math.min(hi[a], this.smax[a] - 1); }
        const removed = new Float64Array(256);
        let added = 0, changed = 0;
        const cell = VOXEL ** 3;
        const bedrockTop = this.smin[1] + BEDROCK_SAMPLES;
        const touched = new Set();
        if(lo[0] > hi[0] || lo[1] > hi[1] || lo[2] > hi[2]) return { removed, added, changed, dirty: touched, box: [lo, hi] };
        for(let cz = Math.floor(lo[2] / N); cz <= Math.floor(hi[2] / N); cz++)
        for(let cy = Math.floor(lo[1] / N); cy <= Math.floor(hi[1] / N); cy++)
        for(let cx = Math.floor(lo[0] / N); cx <= Math.floor(hi[0] / N); cx++) {
            const c = this.chunk(cx, cy, cz);
            if(!c) continue;
            // a uniform chunk the brush cannot change stays uniform
            if(c.uniform && ((op === 'carve' && c.fill === SDF_MAX) || (op === 'add' && c.fill === -SDF_MAX) || (op === 'paint' && (c.fill > 0 || c.fillMat === mat)))) continue;
            const x0 = Math.max(lo[0], cx * N), x1 = Math.min(hi[0], cx * N + N - 1);
            const y0 = Math.max(lo[1], cy * N), y1 = Math.min(hi[1], cy * N + N - 1);
            const z0 = Math.max(lo[2], cz * N), z1 = Math.min(hi[2], cz * N + N - 1);
            let chunkChanged = false;
            for(let iz = z0; iz <= z1; iz++) for(let iy = y0; iy <= y1; iy++) for(let ix = x0; ix <= x1; ix++) {
                const li = (ix - cx * N) + (iy - cy * N) * N + (iz - cz * N) * N2;
                const old = c.sdf ? c.sdf[li] : c.fill;
                const oldMat = c.sdf ? c.mat[li] : c.fillMat;
                let db = brush.d(ix * VOXEL, iy * VOXEL, iz * VOXEL);
                let nv = old, nm = oldMat;
                if(op === 'carve') {
                    if(iy < bedrockTop) continue;
                    if(hardness) { const r = REACH[oldMat]; if(r === 0) continue; db = r > 0 ? db / r : db; }
                    const s = -toStored(db);
                    if(s > old) nv = s;
                } else if(op === 'add') {
                    const s = toStored(db);
                    if(s < old) { nv = s; if(db < VOXEL || old >= 0) nm = mat; }
                } else if(op === 'paint') {
                    if(db < 0 && old < 0 && oldMat !== mat) nm = mat;
                }
                if(nv === old && nm === oldMat) continue;
                if(!c.sdf) c.densify();
                c.sdf[li] = nv; c.mat[li] = nm;
                if(old < 0 && nv >= 0) removed[oldMat] += cell;
                else if(old >= 0 && nv < 0) added += cell;
                changed++; chunkChanged = true;
            }
            if(chunkChanged) { c.version++; c.tryCollapse(); }
        }
        // every chunk whose padded mesh window sees a changed sample is dirty
        const dirty = this.chunksInSampleBox(lo.map(v => v - PAD - 1), hi.map(v => v + PAD + 1));
        const result = { removed, added, changed, dirty, box: [lo, hi] };
        if(changed && notify) for(const fn of this.listeners) fn(result);
        return result;
    }

    /** Keys of the existing chunks overlapping a box of samples (inclusive). */
    chunksInSampleBox(lo, hi) {
        const out = new Set();
        for(let cz = Math.floor(lo[2] / N); cz <= Math.floor(hi[2] / N); cz++)
        for(let cy = Math.floor(lo[1] / N); cy <= Math.floor(hi[1] / N); cy++)
        for(let cx = Math.floor(lo[0] / N); cx <= Math.floor(hi[0] / N); cx++) {
            const k = chunkKey(cx, cy, cz);
            if(this.chunks.has(k)) out.add(k);
        }
        return out;
    }

    /**
     * Copy a chunk's samples plus PAD on every side into `sdf` / `mat` ((CHUNK + 2*PAD)³, index x + y*P + z*P²,
     * padded coordinates: padded 0 is local -PAD). Returns false if the whole window is uniformly air or solid
     * (nothing to mesh).
     */
    extractPadded(cx, cy, cz, sdf, mat) {
        const P = N + 2 * PAD, P2 = P * P;
        const bx = cx * N - PAD, by = cy * N - PAD, bz = cz * N - PAD;
        let anyIn = false, anyOut = false;
        // walk the 3x3x3 neighbourhood of chunks, copying the overlap of each with the window
        for(let dz = -1; dz <= 1; dz++) for(let dy = -1; dy <= 1; dy++) for(let dx = -1; dx <= 1; dx++) {
            const ncx = cx + dx, ncy = cy + dy, ncz = cz + dz;
            const x0 = Math.max(bx, ncx * N), x1 = Math.min(bx + P, ncx * N + N);
            const y0 = Math.max(by, ncy * N), y1 = Math.min(by + P, ncy * N + N);
            const z0 = Math.max(bz, ncz * N), z1 = Math.min(bz + P, ncz * N + N);
            if(x0 >= x1 || y0 >= y1 || z0 >= z1) continue;
            const c = this.chunk(ncx, ncy, ncz);
            if(!c && ncy >= this.bounds.min[1] && ncy < this.bounds.max[1]) {
                // beyond the world's sides: repeat the edge samples, so the terrain runs on instead of ending in a cliff
                for(let z = z0; z < z1; z++) for(let y = y0; y < y1; y++) for(let x = x0; x < x1; x++) {
                    const o = (x - bx) + (y - by) * P + (z - bz) * P2;
                    const qx = Math.min(Math.max(x, this.smin[0]), this.smax[0] - 1), qz = Math.min(Math.max(z, this.smin[2]), this.smax[2] - 1);
                    const s = this.get(qx, y, qz);
                    sdf[o] = s; mat[o] = this.getMat(qx, y, qz);
                    if(s < 0) anyIn = true; else anyOut = true;
                }
                continue;
            }
            const fill = c ? c.fill : (ncy < this.bounds.min[1] ? -SDF_MAX : SDF_MAX);
            const fillMat = c ? c.fillMat : BEDROCK;
            for(let z = z0; z < z1; z++) for(let y = y0; y < y1; y++) {
                let o = (x0 - bx) + (y - by) * P + (z - bz) * P2;
                if(c && c.sdf) {
                    let i = (x0 - ncx * N) + (y - ncy * N) * N + (z - ncz * N) * N2;
                    for(let x = x0; x < x1; x++, o++, i++) { const s = c.sdf[i]; sdf[o] = s; mat[o] = c.mat[i]; if(s < 0) anyIn = true; else anyOut = true; }
                } else {
                    sdf.fill(fill, o, o + (x1 - x0)); mat.fill(fillMat, o, o + (x1 - x0));
                    if(fill < 0) anyIn = true; else anyOut = true;
                }
            }
        }
        return anyIn && anyOut;
    }
}
