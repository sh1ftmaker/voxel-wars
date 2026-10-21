/**
 * SDF primitives for level programs (src/level/fortwar.js): each is { min, max, mat, d(x, y, z) } with a world AABB
 * (metres) and a signed distance, negative inside. Distances are max-of-planes / Lipschitz-1 underestimates past
 * edges, which is all the voxelizer (and Level's bucketing) needs. Hot: Math.sqrt, not Math.hypot (several times slower
 * in V8), in every per-sample distance.
 */

// Material ids (src/voxel/materials.js): the fortwar palette plus the materials branch's grain-aware wood and glass
export const STONE = 0, DIRT = 1, GRASS = 2, SAND = 3, SNOW = 4, BRICK = 5, METAL = 6, LAVA = 7;
export const RED_STONE = 8, BLUE_STONE = 9, WOOD = 10, COBBLE = 11, DARK = 12;
export const WOOD_X = 10, WOOD_Y = 14, WOOD_Z = 15, GLASS = 16;

export function box(x0, x1, y0, y1, z0, z1, mat) {
    const min = [Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1)], max = [Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)];
    return { min, max, mat, d: (x, y, z) => Math.max(min[0] - x, x - max[0], min[1] - y, y - max[1], min[2] - z, z - max[2]) };
}
/** Wood box whose grain runs along its longest side (Wood X / Y / Z). */
export function wbox(x0, x1, y0, y1, z0, z1) {
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0), dz = Math.abs(z1 - z0);
    return box(x0, x1, y0, y1, z0, z1, dy >= dx && dy >= dz ? WOOD_Y : dx >= dz ? WOOD_X : WOOD_Z);
}
/** Vertical cylinder. */
export function cyl(cx, cz, y0, y1, r, mat) {
    return { min: [cx - r, y0, cz - r], max: [cx + r, y1, cz + r], mat, d: (x, y, z) => Math.max(Math.sqrt((x - cx) ** 2 + (z - cz) ** 2) - r, y0 - y, y - y1) };
}
/** Cylinder along x. */
export function cylX(cy, cz, x0, x1, r, mat) {
    return { min: [Math.min(x0, x1), cy - r, cz - r], max: [Math.max(x0, x1), cy + r, cz + r], mat,
        d: (x, y, z) => Math.max(Math.sqrt((y - cy) ** 2 + (z - cz) ** 2) - r, Math.min(x0, x1) - x, x - Math.max(x0, x1)) };
}
/** Ellipsoid (radii r = [rx, ry, rz]); the distance is scaled by the smallest radius (an underestimate). */
export function ellipsoid(c, r, mat) {
    const k = Math.min(r[0], r[1], r[2]);
    return { min: c.map((v, i) => v - r[i]), max: c.map((v, i) => v + r[i]), mat,
        d: (x, y, z) => (Math.sqrt(((x - c[0]) / r[0]) ** 2 + ((y - c[1]) / r[1]) ** 2 + ((z - c[2]) / r[2]) ** 2) - 1) * k };
}
/** Hemispherical shell (outer radius R, thickness t) standing on y = c[1]. */
export function dome(c, R, t, mat) {
    return { min: [c[0] - R, c[1], c[2] - R], max: [c[0] + R, c[1] + R, c[2] + R], mat,
        d: (x, y, z) => { const l = Math.sqrt((x - c[0]) ** 2 + (y - c[1]) ** 2 + (z - c[2]) ** 2); return Math.max(l - R, R - t - l, c[1] - y); } };
}
/** a minus b (bounds and material of a). */
export function diff(a, b) {
    return { min: [...a.min], max: [...a.max], mat: a.mat, d: (x, y, z) => Math.max(a.d(x, y, z), -b.d(x, y, z)) };
}
/** a intersected with b (material `mat`, default a's). */
export function inter(a, b, mat = a.mat) {
    return { min: a.min.map((v, i) => Math.max(v, b.min[i])), max: a.max.map((v, i) => Math.min(v, b.max[i])), mat, d: (x, y, z) => Math.max(a.d(x, y, z), b.d(x, y, z)) };
}
/** Prism along z: at parameter t = (z - nearZ) / (farZ - nearZ), x in [x0, x1], y in [lerp(lo), lerp(hi)]. */
export function prismZ(nearZ, farZ, x0, x1, nY0, nY1, fY0, fY1, mat) {
    const zl = Math.min(nearZ, farZ), zh = Math.max(nearZ, farZ);
    const xl = Math.min(x0, x1), xh = Math.max(x0, x1);
    const L = farZ - nearZ;
    // planes of the sloped floor and ceiling (y - (a + b z)) / sqrt(1 + b^2)
    const bLo = (fY0 - nY0) / L, aLo = nY0 - bLo * nearZ, nLo = Math.hypot(1, bLo);
    const bHi = (fY1 - nY1) / L, aHi = nY1 - bHi * nearZ, nHi = Math.hypot(1, bHi);
    return { min: [xl, Math.min(nY0, fY0), zl], max: [xh, Math.max(nY1, fY1), zh], mat,
        d: (x, y, z) => Math.max(xl - x, x - xh, zl - z, z - zh, ((aLo + bLo * z) - y) / nLo, (y - (aHi + bHi * z)) / nHi) };
}
export function prismX(nearX, farX, z0, z1, nY0, nY1, fY0, fY1, mat) {
    const xl = Math.min(nearX, farX), xh = Math.max(nearX, farX);
    const zl = Math.min(z0, z1), zh = Math.max(z0, z1);
    const L = farX - nearX;
    const bLo = (fY0 - nY0) / L, aLo = nY0 - bLo * nearX, nLo = Math.hypot(1, bLo);
    const bHi = (fY1 - nY1) / L, aHi = nY1 - bHi * nearX, nHi = Math.hypot(1, bHi);
    return { min: [xl, Math.min(nY0, fY0), zl], max: [xh, Math.max(nY1, fY1), zh], mat,
        d: (x, y, z) => Math.max(xl - x, x - xh, zl - z, z - zh, ((aLo + bLo * x) - y) / nLo, (y - (aHi + bHi * x)) / nHi) };
}
export const slopeZ = (nearZ, farZ, x0, x1, nY0, nY1, fY0, fY1, mat) => prismZ(nearZ, farZ, x0, x1, nY0, nY1, fY0, fY1, mat);
export const wedgeX = (nearX, farX, z0, z1, yBase, yLow, yHigh, mat) => prismX(nearX, farX, z0, z1, yBase, yLow, yBase, yHigh, mat);
export const wedgeZ = (nearZ, farZ, x0, x1, yBase, yLow, yHigh, mat) => prismZ(nearZ, farZ, x0, x1, yBase, yLow, yBase, yHigh, mat);
