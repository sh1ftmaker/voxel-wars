/** Brushes for VoxelWorld.applyBrush: `{ min, max, d(x, y, z) }`, world AABB in metres and a signed distance
 *  (negative inside). Distances only need to be exact near the surface; they may underestimate elsewhere.
 *
 *  Additions (perf): every brush made here also carries
 *    `spec`    a plain, structured-clonable description ({ type, ...params }) so the edit can be posted to the
 *              terrain worker (src/workers/terrain.js); `brushFromSpec(spec)` rebuilds the identical brush there
 *    `radius`  (optional) every point of the brush lies within `radius` of its AABB centre and d(p) >= |p - c| - radius
 *  A brush without `spec` (hand-made `{ min, max, d }`) still works: `gridBrush(brush)` samples it on the lattice
 *  so it can travel as data (trilinear in between; exact on lattice points).
 *  Brushes are convex and contain their AABB centre (VoxelWorld.applyBrush relies on it for hardness scaling).
 */
import { VOXEL } from '../config.js';

export function sphere(c, r) {
    return { min: [c[0] - r, c[1] - r, c[2] - r], max: [c[0] + r, c[1] + r, c[2] + r], radius: r, spec: { type: 'sphere', c: [...c], r },
        d: (x, y, z) => Math.hypot(x - c[0], y - c[1], z - c[2]) - r };
}

/** Segment a-b swept by a sphere of radius r (the drill's bite). */
export function capsule(a, b, r) {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const L2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2] || 1e-9;
    return {
        min: [Math.min(a[0], b[0]) - r, Math.min(a[1], b[1]) - r, Math.min(a[2], b[2]) - r],
        max: [Math.max(a[0], b[0]) + r, Math.max(a[1], b[1]) + r, Math.max(a[2], b[2]) + r],
        radius: Math.sqrt(L2) / 2 + r, spec: { type: 'capsule', a: [...a], b: [...b], r },
        d: (x, y, z) => {
            const px = x - a[0], py = y - a[1], pz = z - a[2];
            const t = Math.max(0, Math.min(1, (px * ab[0] + py * ab[1] + pz * ab[2]) / L2));
            return Math.hypot(px - ab[0] * t, py - ab[1] * t, pz - ab[2] * t) - r;
        },
    };
}

/** Axis-aligned box between two corners, optionally with rounded edges of radius `round`. */
export function box(min, max, round = 0) {
    const c = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const h = [(max[0] - min[0]) / 2 - round, (max[1] - min[1]) / 2 - round, (max[2] - min[2]) / 2 - round];
    return { min: [...min], max: [...max], radius: Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2, spec: { type: 'box', min: [...min], max: [...max], round }, d: (x, y, z) => {
        const qx = Math.abs(x - c[0]) - h[0], qy = Math.abs(y - c[1]) - h[1], qz = Math.abs(z - c[2]) - h[2];
        const out = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0));
        return out + Math.min(Math.max(qx, qy, qz), 0) - round;
    } };
}

/** Small deterministic PRNG (mulberry32). */
export function rng(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * A blast crater shaped like broken rock: a sphere whose surface is cut by random planes, so it is bounded by flat
 * facets meeting at angles the way stone breaks (the intersection of half-spaces, softened toward the sphere).
 * `seed` makes it repeatable.
 */
export function rock(c, r, seed = 1) {
    const rand = rng(seed);
    const planes = [];
    const n = 14;
    const golden = Math.PI * (3 - Math.sqrt(5)), rot = rand() * Math.PI * 2;
    for(let i = 0; i < n; i++) {
        const y = 1 - (2 * i + 1) / n, rr = Math.sqrt(1 - y * y), a = i * golden + rot;
        let d = [Math.cos(a) * rr + (rand() - 0.5) * 0.5, y + (rand() - 0.5) * 0.5, Math.sin(a) * rr + (rand() - 0.5) * 0.5];
        const l = Math.hypot(...d); d = d.map(v => v / l);
        planes.push([d[0], d[1], d[2], r * (0.82 + rand() * 0.3)]);
    }
    const R = r * 1.15;
    const pl = Float64Array.from(planes.flat()), np = pl.length; // flat for the hot loop (same arithmetic)
    const cx = c[0], cy = c[1], cz = c[2];
    return { min: [c[0] - R, c[1] - R, c[2] - R], max: [c[0] + R, c[1] + R, c[2] + R], radius: R, spec: { type: 'rock', c: [...c], r, seed }, d: (x, y, z) => {
        const px = x - cx, py = y - cy, pz = z - cz;
        let d = Math.hypot(px, py, pz) - R;
        for(let i = 0; i < np; i += 4) { const v = px * pl[i] + py * pl[i + 1] + pz * pl[i + 2] - pl[i + 3]; if(v > d) d = v; }
        return d;
    } };
}

/** Moves a brush by an offset (e.g. into a body's local frame when only translated). */
export function translated(b, o) {
    return { min: b.min.map((v, i) => v + o[i]), max: b.max.map((v, i) => v + o[i]), radius: b.radius, spec: b.spec ? { type: 'translated', b: b.spec, o: [...o] } : undefined,
        d: (x, y, z) => b.d(x - o[0], y - o[1], z - o[2]) };
}

/**
 * Any brush as data: its distance sampled on the lattice over its AABB (plus a margin of `pad` samples), trilinear in
 * between. Returns a brush with a `spec` of type 'grid'. Exact on lattice points, so non-scaled edits match.
 */
export function gridBrush(b, pad = 5) {
    const lo = b.min.map(v => Math.floor(v / VOXEL) - pad), hi = b.max.map(v => Math.ceil(v / VOXEL) + pad);
    const dims = [hi[0] - lo[0] + 1, hi[1] - lo[1] + 1, hi[2] - lo[2] + 1];
    const data = new Float64Array(dims[0] * dims[1] * dims[2]);
    let o = 0;
    for(let z = 0; z < dims[2]; z++) for(let y = 0; y < dims[1]; y++) for(let x = 0; x < dims[0]; x++) data[o++] = b.d((lo[0] + x) * VOXEL, (lo[1] + y) * VOXEL, (lo[2] + z) * VOXEL);
    return fromGrid({ type: 'grid', min: [...b.min], max: [...b.max], lo, dims, data });
}
function fromGrid(spec) {
    const { lo, dims, data } = spec, dx = dims[0], dxy = dims[0] * dims[1];
    const far = 4 * VOXEL * 2;
    const d = (x, y, z) => {
        const fx = x / VOXEL - lo[0], fy = y / VOXEL - lo[1], fz = z / VOXEL - lo[2];
        if(fx < 0 || fy < 0 || fz < 0 || fx > dims[0] - 1 || fy > dims[1] - 1 || fz > dims[2] - 1) return far;
        const ix = Math.min(Math.floor(fx), dims[0] - 2), iy = Math.min(Math.floor(fy), dims[1] - 2), iz = Math.min(Math.floor(fz), dims[2] - 2);
        const tx = fx - ix, ty = fy - iy, tz = fz - iz, i = ix + iy * dx + iz * dxy;
        const a = data[i] + (data[i + 1] - data[i]) * tx, b2 = data[i + dx] + (data[i + dx + 1] - data[i + dx]) * tx;
        const c = data[i + dxy] + (data[i + dxy + 1] - data[i + dxy]) * tx, e = data[i + dxy + dx] + (data[i + dxy + dx + 1] - data[i + dxy + dx]) * tx;
        const f = a + (b2 - a) * ty, g = c + (e - c) * ty;
        return f + (g - f) * tz;
    };
    return { min: [...spec.min], max: [...spec.max], spec, d };
}

/** Rebuild a brush from its `spec` (see the header). */
export function brushFromSpec(s) {
    switch(s.type) {
        case 'sphere': return sphere(s.c, s.r);
        case 'capsule': return capsule(s.a, s.b, s.r);
        case 'box': return box(s.min, s.max, s.round);
        case 'rock': return rock(s.c, s.r, s.seed);
        case 'translated': return translated(brushFromSpec(s.b), s.o);
        case 'grid': return fromGrid(s);
        default: throw new Error(`unknown brush spec ${s.type}`);
    }
}
/** A brush's spec, sampling it into a grid brush when it has none. */
export function specOf(b) { return b.spec || gridBrush(b).spec; }

// ---------------------------------------------------------------- material-shaped carving
/**
 * How carving bites into each material (VoxelWorld.applyBrush with hardness): the brush's distance at a solid sample is
 * offset by `carveOffset(mat, x, y, z)` (metres, + carves less, - carves more) and, along a wood's grain, stretched by
 * CARVE_STRETCH (the evaluation point is pulled toward the brush centre on that axis: an elongated bite).
 *   stone (0, 8, 9), dark rock (12): faceted chips, a random plane per 0.7 m cell
 *   brick (5): whole bricks (running bond cells 0.5 x 0.25 x 0.5 m) go or stay: stepped, brick-shaped holes
 *   cobble (11): rounded (smooth value noise, 0.5 m)
 *   wood (10, 14, 15): stretched 1.8x along the grain, fibres (0.25 m cross-grain cells, 1.5 m long) stick out or
 *                      break deeper: a splintered, jagged bite
 *   metal, glass, soils: plain (clean holes; soils get a rim mound instead, VoxelWorld.applyBrush `rim`)
 * Pure functions of the position: every client carves the same.
 * CARVE_AMP[m] bounds |carveOffset| (block skipping in applyBrush relies on it).
 */
export const CARVE_AMP = new Float32Array(256);
export const CARVE_STRETCH = new Float32Array(256).fill(1);
export const CARVE_GRAIN = new Int8Array(256).fill(-1);
const SHAPE = new Uint8Array(256);
for(const m of [0, 8, 9, 12]) { SHAPE[m] = 1; CARVE_AMP[m] = 0.32; }
SHAPE[5] = 2; CARVE_AMP[5] = 0.19;
SHAPE[11] = 3; CARVE_AMP[11] = 0.16;
[10, 14, 15].forEach((m, axis) => { SHAPE[m] = 4; CARVE_AMP[m] = 0.26; CARVE_STRETCH[m] = 1.8; CARVE_GRAIN[m] = axis; });

function hash3u(x, y, z) {
    let h = Math.imul(x, 0x8da6b343) ^ Math.imul(y, 0xd8163841) ^ Math.imul(z, 0xcb1ab31f);
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
    return h >>> 0;
}
const hash3 = (x, y, z) => hash3u(x, y, z) / 4294967296;
export function carveOffset(m, x, y, z) {
    switch(SHAPE[m]) {
        case 1: { // facets: a plane through each 0.7 m cell at a random tilt and height
            const cs = 0.7, fx = x / cs, fy = y / cs, fz = z / cs, ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
            // one hash: 8 bits each for the height and the plane's tilt
            const u = hash3u(ix, iy, iz), h = (u & 255) / 255 - 0.5, nx = ((u >>> 8) & 255) / 255 - 0.5, ny = ((u >>> 16) & 255) / 255 - 0.5, nz = (u >>> 24) / 255 - 0.5;
            return h * 0.18 + ((fx - ix - 0.5) * nx + (fy - iy - 0.5) * ny + (fz - iz - 0.5) * nz) * 0.3;
        }
        case 2: { // bricks in running bond
            const row = Math.floor(y / 0.25), off = (row & 1) * 0.25;
            return (hash3(Math.floor((x + off) / 0.5), row, Math.floor((z + off) / 0.5)) - 0.5) * 0.38;
        }
        case 3: { // cobbles: trilinear value noise
            const cs = 0.5, fx = x / cs, fy = y / cs, fz = z / cs, ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
            const tx = fx - ix, ty = fy - iy, tz = fz - iz;
            const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty), sz = tz * tz * (3 - 2 * tz);
            const l = (a, b, t) => a + (b - a) * t;
            const c = (dx, dy, dz) => hash3(ix + dx, iy + dy, iz + dz);
            const v = l(l(l(c(0, 0, 0), c(1, 0, 0), sx), l(c(0, 1, 0), c(1, 1, 0), sx), sy), l(l(c(0, 0, 1), c(1, 0, 1), sx), l(c(0, 1, 1), c(1, 1, 1), sx), sy), sz);
            return (v - 0.5) * 0.32;
        }
        case 4: { // wood fibres: constant along the grain for 1.5 m, random across it
            const g = CARVE_GRAIN[m], fs = 0.25;
            const a = g === 0 ? x : g === 1 ? y : z, u = g === 0 ? y : x, v = g === 2 ? y : z;
            const h = hash3(Math.floor(u / fs), Math.floor(v / fs), Math.floor(a / 1.5) + g * 977);
            return (h - 0.5) * 0.52;
        }
    }
    return 0;
}
