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
