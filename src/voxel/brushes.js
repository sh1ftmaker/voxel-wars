/** Brushes for VoxelWorld.applyBrush: `{ min, max, d(x, y, z) }`, world AABB in metres and a signed distance
 *  (negative inside). Distances only need to be exact near the surface; they may underestimate elsewhere. */

export function sphere(c, r) {
    return { min: [c[0] - r, c[1] - r, c[2] - r], max: [c[0] + r, c[1] + r, c[2] + r],
        d: (x, y, z) => Math.hypot(x - c[0], y - c[1], z - c[2]) - r };
}

/** Segment a-b swept by a sphere of radius r (the drill's bite). */
export function capsule(a, b, r) {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const L2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2] || 1e-9;
    return {
        min: [Math.min(a[0], b[0]) - r, Math.min(a[1], b[1]) - r, Math.min(a[2], b[2]) - r],
        max: [Math.max(a[0], b[0]) + r, Math.max(a[1], b[1]) + r, Math.max(a[2], b[2]) + r],
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
    return { min: [...min], max: [...max], d: (x, y, z) => {
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
    return { min: [c[0] - R, c[1] - R, c[2] - R], max: [c[0] + R, c[1] + R, c[2] + R], d: (x, y, z) => {
        const px = x - c[0], py = y - c[1], pz = z - c[2];
        let d = Math.hypot(px, py, pz) - R;
        for(const p of planes) { const v = px * p[0] + py * p[1] + pz * p[2] - p[3]; if(v > d) d = v; }
        return d;
    } };
}

/** Moves a brush by an offset (e.g. into a body's local frame when only translated). */
export function translated(b, o) {
    return { min: b.min.map((v, i) => v + o[i]), max: b.max.map((v, i) => v + o[i]), d: (x, y, z) => b.d(x - o[0], y - o[1], z - o[2]) };
}
