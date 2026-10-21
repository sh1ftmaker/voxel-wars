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
 *
 * In the game the authoritative world lives in the terrain worker (src/voxel/TerrainCore.js); the main thread's
 * instance is a read-only replica kept in step by TerrainSync (`world.remote`, `setChunks`, `notify`). Patches of
 * samples: `writeSamples(patch)` here, `world.applySamples(patch)` on the replica.
 */
import { VOXEL, CHUNK, SDF_SCALE, SDF_MAX, PAD, WORLD_CHUNKS, BEDROCK_SAMPLES } from '../config.js';
import { REACH, BEDROCK, MATERIALS } from './materials.js';
import { CARVE_AMP, CARVE_STRETCH, CARVE_GRAIN, carveOffset } from './brushes.js';

/** Soils that pile up a rim around a blast crater (applyBrush `rim`). */
const RIM_SOIL = new Uint8Array(256);
for(const m of MATERIALS) if(m.fracture === 'crumble' && m.name !== 'Lava') RIM_SOIL[m.id] = 1;

const N = CHUNK, N2 = N * N, N3 = N * N * N;
const BLOCK_HALF_DIAG = 1.5 * Math.sqrt(3) * VOXEL; // a block of 4 samples spans 3 voxels
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
        // a coarse pass first: a chunk on a surface differs somewhere within the first few strides
        for(let i = 0; i < N3; i += 61) if(this.sdf[i] !== s0 || (s0 < 0 && this.mat[i] !== m0)) return;
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
    /**
     * A mound of `volume` m³ in a ring around a crater at (cx, cy, cz) of radius R: a raised-cosine bump on the ground
     * surface of every column in the ring whose top sample is soil (the column's own material: grass stays on top).
     * Columns whose surface is far above or below the crater centre (walls, cliffs) are left alone. Returns
     * { added, changed, lo, hi } or null.
     */
    _rim(cx, cy, cz, R, volume) {
        const Rc = R * 1.15, w = Math.max(0.6, R * 0.55);
        // ring volume of a raised-cosine profile of height H and half width w: 2 pi Rc * w * H
        const H = Math.min(R * 0.45, 1.1, volume / (2 * Math.PI * Rc * w));
        if(H < VOXEL * 0.3) return null;
        const x0 = Math.floor((cx - Rc - w) / VOXEL), x1 = Math.ceil((cx + Rc + w) / VOXEL);
        const z0 = Math.floor((cz - Rc - w) / VOXEL), z1 = Math.ceil((cz + Rc + w) / VOXEL);
        const yTop = Math.ceil((cy + R + H) / VOXEL) + 2, yBot = Math.floor((cy - R * 1.2) / VOXEL);
        const cell = VOXEL ** 3;
        let added = 0, changed = 0;
        const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        const touched = new Set();
        for(let iz = z0; iz <= z1; iz++) for(let ix = x0; ix <= x1; ix++) {
            const dr = Math.hypot(ix * VOXEL - cx, iz * VOXEL - cz) - Rc;
            if(Math.abs(dr) >= w) continue;
            const h = H * 0.5 * (1 + Math.cos(Math.PI * dr / w));
            // the column's surface: the first solid sample from the top
            let iy = yTop;
            while(iy >= yBot && this.get(ix, iy, iz) >= 0) iy--;
            if(iy < yBot || iy >= yTop) continue;
            const m = this.getMat(ix, iy, iz);
            if(!RIM_SOIL[m]) continue;
            const s0 = this.get(ix, iy, iz), s1 = this.get(ix, iy + 1, iz);
            const top = (iy + s0 / (s0 - s1)) * VOXEL; // the zero crossing between the two samples
            const want = top + h;
            for(let y = iy + 1; y <= Math.min(yTop + 4, Math.ceil(want / VOXEL) + 4); y++) {
                if(!this.inWorld(ix, y, iz)) continue;
                const c = this.chunks.get(chunkKey(Math.floor(ix / N), Math.floor(y / N), Math.floor(iz / N)));
                const li = (ix - c.cx * N) + (y - c.cy * N) * N + (iz - c.cz * N) * N2;
                const old = c.sdf ? c.sdf[li] : c.fill;
                const nv = toStored(y * VOXEL - want);
                if(nv >= old) continue;
                c.densify();
                c.sdf[li] = nv; if(old >= 0) { c.mat[li] = m; if(nv < 0) added += cell; }
                changed++;
                if(!touched.has(c)) { touched.add(c); c.version++; }
                if(ix < lo[0]) lo[0] = ix; if(y < lo[1]) lo[1] = y; if(iz < lo[2]) lo[2] = iz;
                if(ix > hi[0]) hi[0] = ix; if(y > hi[1]) hi[1] = y; if(iz > hi[2]) hi[2] = iz;
            }
        }
        return changed ? { added, changed, lo, hi } : null;
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
    applyBrush(brush, { op = 'carve', mat = 1, hardness = true, notify = true, rim = false } = {}) {
        const band = 4; // samples outside the brush whose stored (saturated) distances may still change
        // material-shaped carving (brushes.js carveOffset / CARVE_STRETCH) and soft materials' reach grow the bite
        // past the brush's box: cover a little more (the band covers the rest)
        const grow = op === 'carve' && hardness ? 0.15 : 0;
        const lo = brush.min.map((v, a) => Math.floor((v - (brush.max[a] - v) * grow * 0.5) / VOXEL) - band), hi = brush.max.map((v, a) => Math.ceil((v + (v - brush.min[a]) * grow * 0.5) / VOXEL) + band);
        for(let a = 0; a < 3; a++) { lo[a] = Math.max(lo[a], this.smin[a]); hi[a] = Math.min(hi[a], this.smax[a] - 1); }
        const removed = new Float64Array(256);
        let added = 0, changed = 0;
        const cell = VOXEL ** 3;
        const bedrockTop = this.smin[1] + BEDROCK_SAMPLES;
        const touched = new Set();
        const bcx = (brush.min[0] + brush.max[0]) / 2, bcy = (brush.min[1] + brush.max[1]) / 2, bcz = (brush.min[2] + brush.max[2]) / 2;
        const carve = op === 'carve', add = op === 'add', paint = op === 'paint';
        const useReach = carve && hardness;
        const Rb = typeof brush.radius === 'number' ? brush.radius : -1;
        const d = brush.d;
        // Block skipping. A sample cannot change when its distance is past the saturated band (4 voxels) for carve /
        // add, or outside for paint. Brushes are convex and contain their centre c. With hardness, a material of reach
        // r scales the brush about c: the sample's distance is r * d(c + (p - c) / r), bounded over a block by
        //   r >= 1:  >= r * d(p) - (r - 1) * |p - c|            (Lipschitz), and <= d(p) (convexity)
        //   r <= 1:  >= d(p) (convexity), >= |p - c| - r * radius (brush.radius, when given)
        //            <= r * d(p) + (1 - r) * |p - c|            (Lipschitz)
        // with the block's centre values widened by its half diagonal. The reach range [rmin, rmax] is that of the
        // block's samples that could change at all (a saturated air sample never changes under carve). Skipped and
        // shortcut samples are exactly those whose result is already decided, so the output is the same as evaluating
        // every sample.
        const SAT = 4 * VOXEL * 1.01, DEEP = -SAT - VOXEL;
        if(lo[0] > hi[0] || lo[1] > hi[1] || lo[2] > hi[2]) return { removed, added, changed, dirty: touched, box: [lo, hi] };
        const HD = BLOCK_HALF_DIAG;
        for(let cz = Math.floor(lo[2] / N); cz <= Math.floor(hi[2] / N); cz++)
        for(let cy = Math.floor(lo[1] / N); cy <= Math.floor(hi[1] / N); cy++)
        for(let cx = Math.floor(lo[0] / N); cx <= Math.floor(hi[0] / N); cx++) {
            const c = this.chunk(cx, cy, cz);
            if(!c) continue;
            // a uniform chunk the brush cannot change stays uniform
            if(c.uniform && ((carve && c.fill === SDF_MAX) || (add && c.fill === -SDF_MAX) || (paint && (c.fill > 0 || c.fillMat === mat)))) continue;
            const x0 = Math.max(lo[0], cx * N), x1 = Math.min(hi[0], cx * N + N - 1);
            const y0 = Math.max(lo[1], cy * N), y1 = Math.min(hi[1], cy * N + N - 1);
            const z0 = Math.max(lo[2], cz * N), z1 = Math.min(hi[2], cz * N + N - 1);
            const ox = cx * N, oy = cy * N, oz = cz * N;
            let sdf = c.sdf, mt = c.mat;
            const fill = c.fill, fillMat = c.fillMat;
            let chunkChanged = false;
            for(let bz = z0; bz <= z1; bz += 4) for(let by = y0; by <= y1; by += 4) for(let bx = x0; bx <= x1; bx += 4) {
            const ex = Math.min(bx + 3, x1), ey = Math.min(by + 3, y1), ez = Math.min(bz + 3, z1);
            // reach range of the samples that could change (carve), or whether any could (add, paint)
            let rmin = Infinity, rmax = -Infinity, amax = 0, stretchy = false;
            if(carve) {
                if(ey < bedrockTop) continue;
                if(!sdf) {
                    const r = useReach ? REACH[fillMat] : 1; if(r === 0) continue; rmin = rmax = r;
                    if(useReach) { amax = CARVE_AMP[fillMat]; stretchy = CARVE_STRETCH[fillMat] !== 1; }
                }
                else {
                    for(let iz = bz; iz <= ez; iz++) for(let iy = Math.max(by, bedrockTop); iy <= ey; iy++) {
                        let li = (bx - ox) + (iy - oy) * N + (iz - oz) * N2;
                        for(let ix = bx; ix <= ex; ix++, li++) {
                            if(sdf[li] === SDF_MAX) continue;
                            const r = useReach ? REACH[mt[li]] : 1;
                            if(r === 0) continue;
                            if(r < rmin) rmin = r;
                            if(r > rmax) rmax = r;
                            if(useReach) { const m = mt[li]; if(CARVE_AMP[m] > amax) amax = CARVE_AMP[m]; if(CARVE_STRETCH[m] !== 1) stretchy = true; }
                        }
                    }
                    if(rmax < 0) continue;
                }
            } else if(sdf) {
                let any = false;
                for(let iz = bz; iz <= ez && !any; iz++) for(let iy = by; iy <= ey && !any; iy++) {
                    let li = (bx - ox) + (iy - oy) * N + (iz - oz) * N2;
                    for(let ix = bx; ix <= ex; ix++, li++) if(add ? sdf[li] !== -SDF_MAX : (sdf[li] < 0 && mt[li] !== mat)) { any = true; break; }
                }
                if(!any) continue;
            }
            const qx = (bx + ex) * 0.5 * VOXEL, qy = (by + ey) * 0.5 * VOXEL, qz = (bz + ez) * 0.5 * VOXEL;
            const dc = d(qx, qy, qz), low = dc - HD;
            const dsH = Math.hypot(qx - bcx, qy - bcy, qz - bcz) + HD, dcH = dc + HD;
            if(paint) { if(low > 0) continue; }
            else if(!carve || !useReach) { if(low > SAT) continue; }
            else {
                // lower bound of the scaled distance over the block's samples and their reach range
                let L = Infinity;
                if(rmin <= 1) { const r = Math.min(rmax, 1); L = Rb >= 0 ? Math.max(low, dsH - 2 * HD - r * Rb) : low; }
                if(rmax > 1) { const a = Math.max(rmin, 1); L = Math.min(L, a * low - (a - 1) * dsH, rmax * low - (rmax - 1) * dsH); }
                // material offsets move the surface by up to amax; a grain stretch has no cheap bound: evaluate all
                if(!stretchy && L - amax > SAT) continue;
            }
            // deep inside the brush every rule saturates the same way: no per-sample evaluation there
            const deep = dcH < DEEP;
            for(let iz = bz; iz <= ez; iz++) for(let iy = by; iy <= ey; iy++) {
                let li = (bx - ox) + (iy - oy) * N + (iz - oz) * N2;
                for(let ix = bx; ix <= ex; ix++, li++) {
                const old = sdf ? sdf[li] : fill;
                let nv = old, nm, oldMat, db;
                if(carve) {
                    if(old === SDF_MAX || iy < bedrockTop) continue; // saturated air only gets more distant: never changes
                    oldMat = sdf ? mt[li] : fillMat;
                    const r = useReach ? REACH[oldMat] : 1;
                    if(r === 0) continue;
                    const st = useReach ? CARVE_STRETCH[oldMat] : 1;
                    if(st === 1 && (r >= 1 ? dcH + amax < DEEP : r * dcH + (1 - r) * dsH + amax < DEEP)) db = -1e9;
                    else {
                        const px = ix * VOXEL, py = iy * VOXEL, pz = iz * VOXEL;
                        if(st !== 1) {
                            // wood: the bite reaches st times further along the grain
                            const g = CARVE_GRAIN[oldMat], kx = g === 0 ? r * st : r, ky = g === 1 ? r * st : r, kz = g === 2 ? r * st : r;
                            db = d(bcx + (px - bcx) / kx, bcy + (py - bcy) / ky, bcz + (pz - bcz) / kz) * r;
                        } else if(r !== 1) db = d(bcx + (px - bcx) / r, bcy + (py - bcy) / r, bcz + (pz - bcz) / r) * r;
                        else db = d(px, py, pz);
                        // (only near the surface: deeper or farther the stored value saturates either way)
                        if(useReach && CARVE_AMP[oldMat] > 0 && db < SAT + CARVE_AMP[oldMat] && db > DEEP - CARVE_AMP[oldMat]) db += carveOffset(oldMat, px, py, pz);
                    }
                    const s = -toStored(db);
                    if(s <= old) continue;
                    nv = s; nm = oldMat;
                } else if(add) {
                    if(old === -SDF_MAX) continue;
                    oldMat = sdf ? mt[li] : fillMat;
                    db = deep ? -1e9 : d(ix * VOXEL, iy * VOXEL, iz * VOXEL);
                    const s = toStored(db);
                    if(s >= old) continue;
                    nv = s; nm = (db < VOXEL || old >= 0) ? mat : oldMat;
                    if(nv === old && nm === oldMat) continue;
                } else {
                    if(old >= 0) continue;
                    oldMat = sdf ? mt[li] : fillMat;
                    if(oldMat === mat) continue;
                    db = deep ? -1e9 : d(ix * VOXEL, iy * VOXEL, iz * VOXEL);
                    if(!(db < 0)) continue;
                    nm = mat;
                }
                if(!sdf) { c.densify(); sdf = c.sdf; mt = c.mat; }
                sdf[li] = nv; mt[li] = nm;
                if(old < 0 && nv >= 0) removed[oldMat] += cell;
                else if(old >= 0 && nv < 0) added += cell;
                changed++; chunkChanged = true;
                }
            }
            }
            if(chunkChanged) { c.version++; c.tryCollapse(); }
        }
        // soils pile part of what a blast threw out into a rim around the crater
        if(carve && rim && changed) {
            let soil = 0;
            for(let i = 0; i < 256; i++) if(RIM_SOIL[i]) soil += removed[i];
            if(soil > 0.05) {
                const R = Math.max(...brush.max.map((v, a) => v - brush.min[a])) / 2;
                const r2 = this._rim(bcx, bcy, bcz, R, soil * 0.45);
                if(r2) { added += r2.added; changed += r2.changed; for(let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], r2.lo[a]); hi[a] = Math.max(hi[a], r2.hi[a]); } }
            }
        }
        // every chunk whose padded mesh window sees a changed sample is dirty
        const dirty = this.chunksInSampleBox(lo.map(v => v - PAD - 1), hi.map(v => v + PAD + 1));
        const result = { removed, added, changed, dirty, box: [lo, hi] };
        if(changed && notify) for(const fn of this.listeners) fn(result);
        return result;
    }

    /**
     * Write a patch of samples { lo: [x,y,z] (samples), dims: [nx,ny,nz], sdf: Int8Array, mat: Uint8Array } (index
     * x + y*nx + z*nx*ny) into the world (e.g. a soft-ground bake). Samples outside the world are ignored; the
     * material of air samples only changes with their distance. Notifies listeners. Returns { changed, dirty, box }.
     * (On the main thread's replica, use `world.applySamples(patch)`: the terrain worker owns the edits.)
     */
    writeSamples(patch, { notify = true } = {}) {
        const { lo, dims, sdf, mat } = patch;
        const hi = [lo[0] + dims[0] - 1, lo[1] + dims[1] - 1, lo[2] + dims[2] - 1];
        const dirty = this.chunksInSampleBox(lo.map(v => v - PAD - 1), hi.map(v => v + PAD + 1));
        const dx = dims[0], dxy = dims[0] * dims[1];
        let changed = 0;
        for(let cz = Math.floor(lo[2] / N); cz <= Math.floor(hi[2] / N); cz++)
        for(let cy = Math.floor(lo[1] / N); cy <= Math.floor(hi[1] / N); cy++)
        for(let cx = Math.floor(lo[0] / N); cx <= Math.floor(hi[0] / N); cx++) {
            const c = this.chunk(cx, cy, cz);
            if(!c) continue;
            const x0 = Math.max(lo[0], cx * N), x1 = Math.min(hi[0], cx * N + N - 1);
            const y0 = Math.max(lo[1], cy * N), y1 = Math.min(hi[1], cy * N + N - 1);
            const z0 = Math.max(lo[2], cz * N), z1 = Math.min(hi[2], cz * N + N - 1);
            let any = false;
            for(let z = z0; z <= z1; z++) for(let y = y0; y <= y1; y++) for(let x = x0; x <= x1; x++) {
                const o = (x - lo[0]) + (y - lo[1]) * dx + (z - lo[2]) * dxy;
                const li = (x - cx * N) + (y - cy * N) * N + (z - cz * N) * N2;
                const old = c.sdf ? c.sdf[li] : c.fill, om = c.sdf ? c.mat[li] : c.fillMat;
                if(old === sdf[o] && (om === mat[o] || old >= 0)) continue;
                if(!c.sdf) c.densify();
                c.sdf[li] = sdf[o]; c.mat[li] = mat[o]; any = true; changed++;
            }
            if(any) { c.version++; c.tryCollapse(); }
        }
        const result = { removed: new Float64Array(256), added: 0, changed, dirty, box: [[...lo], hi], kind: 'soft' };
        if(changed && notify) for(const fn of this.listeners) fn(result);
        return result;
    }

    /** Replace chunks' contents wholesale ({ key, fill, fillMat, version, sdf?, mat? }, arrays taken over, not
     *  copied): how the main thread's replica follows the terrain worker. No notification (the caller notifies). */
    setChunks(list) {
        for(const d of list) {
            const c = this.chunks.get(d.key);
            if(!c) continue;
            c.sdf = d.sdf || null; c.mat = d.mat || null;
            c.fill = d.fill; c.fillMat = d.fillMat; c.version = d.version;
        }
    }
    /** Notify the change listeners of an edit made elsewhere (e.g. by the terrain worker). */
    notify(result) { for(const fn of this.listeners) fn(result); }

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
