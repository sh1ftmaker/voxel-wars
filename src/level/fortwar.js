/**
 * Twin Forts as a signed distance field: the same CSG program as tools/gen-fortwar.mjs (same primitives, same
 * order of unions and subtractions, same seeded rock lumps, same 0.1 m nudge), evaluated per point instead of
 * through Manifold, so the DMM world builder can voxelize it and snap surface nodes onto the real surfaces.
 *
 * sdf(p) < 0 inside solid. Union = min, subtraction = max(a, -b). Box / prism distances are max-of-planes
 * (exact inside, a slight underestimate past edges outside), which is all the voxelizer and the node snapping need.
 * material(p) is the material of the last primitive (in program order) that contains p.
 */

// Material ids (fortwar's table: palette 0..7, then the level's own entries)
export const STONE = 0, DIRT = 1, GRASS = 2, SAND = 3;
export const RED_STONE = 8, BLUE_STONE = 9, WOOD = 10, COBBLE = 11, DARK = 12;
export const MAT_NAMES = { 0: 'Stone', 1: 'Dirt', 2: 'Grass', 3: 'Sand', 8: 'Red Stone', 9: 'Blue Stone', 10: 'Wood', 11: 'Cobble', 12: 'Dark Rock' };

export const X = 80, Z = 40;
export const SURFACE = 0, BOTTOM = -40;
const WALL_H = 6.5, MERLON_H = 7.6, WALK_Y = 5.5, TOWER_H = 9.5;
const GORGE_W = 8, GORGE_D = 6, BED = -GORGE_D - 0.6;
export const NUDGE = 0.1;

// ---- primitives (bounding box + signed distance) ----
function box(x0, x1, y0, y1, z0, z1, mat) {
    const min = [Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1)], max = [Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)];
    return { min, max, mat, d: (x, y, z) => Math.max(min[0] - x, x - max[0], min[1] - y, y - max[1], min[2] - z, z - max[2]) };
}
function cyl(cx, cz, y0, y1, r, mat) {
    return { min: [cx - r, y0, cz - r], max: [cx + r, y1, cz + r], mat, d: (x, y, z) => Math.max(Math.hypot(x - cx, z - cz) - r, y0 - y, y - y1) };
}
/** Prism along z: at parameter t = (z - nearZ) / (farZ - nearZ), x in [x0, x1], y in [lerp(lo), lerp(hi)]. */
function prismZ(nearZ, farZ, x0, x1, nY0, nY1, fY0, fY1, mat) {
    const zl = Math.min(nearZ, farZ), zh = Math.max(nearZ, farZ);
    const xl = Math.min(x0, x1), xh = Math.max(x0, x1);
    const L = farZ - nearZ;
    // planes of the sloped floor and ceiling (y - (a + b z)) / sqrt(1 + b^2)
    const bLo = (fY0 - nY0) / L, aLo = nY0 - bLo * nearZ, nLo = Math.hypot(1, bLo);
    const bHi = (fY1 - nY1) / L, aHi = nY1 - bHi * nearZ, nHi = Math.hypot(1, bHi);
    return { min: [xl, Math.min(nY0, fY0), zl], max: [xh, Math.max(nY1, fY1), zh], mat,
        d: (x, y, z) => Math.max(xl - x, x - xh, zl - z, z - zh, ((aLo + bLo * z) - y) / nLo, (y - (aHi + bHi * z)) / nHi) };
}
function prismX(nearX, farX, z0, z1, nY0, nY1, fY0, fY1, mat) {
    const xl = Math.min(nearX, farX), xh = Math.max(nearX, farX);
    const zl = Math.min(z0, z1), zh = Math.max(z0, z1);
    const L = farX - nearX;
    const bLo = (fY0 - nY0) / L, aLo = nY0 - bLo * nearX, nLo = Math.hypot(1, bLo);
    const bHi = (fY1 - nY1) / L, aHi = nY1 - bHi * nearX, nHi = Math.hypot(1, bHi);
    return { min: [xl, Math.min(nY0, fY0), zl], max: [xh, Math.max(nY1, fY1), zh], mat,
        d: (x, y, z) => Math.max(xl - x, x - xh, zl - z, z - zh, ((aLo + bLo * x) - y) / nLo, (y - (aHi + bHi * x)) / nHi) };
}
const slopeZ = (nearZ, farZ, x0, x1, nY0, nY1, fY0, fY1, mat) => prismZ(nearZ, farZ, x0, x1, nY0, nY1, fY0, fY1, mat);
const wedgeX = (nearX, farX, z0, z1, yBase, yLow, yHigh, mat) => prismX(nearX, farX, z0, z1, yBase, yLow, yBase, yHigh, mat);
const wedgeZ = (nearZ, farZ, x0, x1, yBase, yLow, yHigh, mat) => prismZ(nearZ, farZ, x0, x1, yBase, yLow, yBase, yHigh, mat);

/** Builds the program: five groups applied in order (add, cut, add, cut, add), exactly as gen-fortwar.mjs. */
function program() {
    let seed = 1337;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const adds = [], cuts = [], late = [], lateCuts = [], last = [];
    adds.push(box(-X - 1, X, BOTTOM - 1, SURFACE - 0.6, -Z - 1, Z, DIRT));
    adds.push(box(-X - 1, X, SURFACE - 0.6, SURFACE, -Z - 1, Z, GRASS));
    adds.push(box(-X, -X + 2, 0, 4, -Z, Z, DARK));
    adds.push(box(X - 2, X, 0, 4, -Z, Z, DARK));
    function fort(s, mat) {
        const x = v => -s * v;
        adds.push(box(x(-38.5), x(-36), 0, WALL_H, -13, 13, mat));
        adds.push(box(x(-62), x(-59.5), 0, WALL_H, -13, 13, mat));
        adds.push(box(x(-62), x(-36), 0, WALL_H, -13, -10.5, mat));
        adds.push(box(x(-62), x(-36), 0, WALL_H, 10.5, 13, mat));
        for(let z = -12.4; z < 12.5; z += 2.2) { adds.push(box(x(-38.5), x(-36), WALL_H, MERLON_H, z, z + 1.1, mat)); adds.push(box(x(-62), x(-59.5), WALL_H, MERLON_H, z, z + 1.1, mat)); }
        for(let xx = -61; xx < -37; xx += 2.2) { adds.push(box(x(xx), x(xx + 1.1), WALL_H, MERLON_H, -13, -10.5, mat)); adds.push(box(x(xx), x(xx + 1.1), WALL_H, MERLON_H, 10.5, 13, mat)); }
        for(let [tx, tz] of [[-36.5, 12.5], [-36.5, -12.5], [-61.5, 12.5], [-61.5, -12.5]]) {
            adds.push(box(x(tx - 2.5), x(tx + 2.5), 0, TOWER_H, tz - 2.5, tz + 2.5, mat));
            adds.push(box(x(tx - 2.5), x(tx + 2.5), TOWER_H, TOWER_H + 1, tz - 2.5, tz + 2.5, mat));
            lateCuts.push(box(x(tx - 2), x(tx + 2), TOWER_H, TOWER_H + 1.5, tz - 2, tz + 2, mat));
            if(tx > -40) adds.push(box(x(-41.5), x(-39), WALK_Y, WALK_Y + 2, tz > 0 ? 8 : -10, tz > 0 ? 10 : -8, mat));
        }
        adds.push(box(x(-41.6), x(-38.4), WALK_Y - 0.5, WALK_Y, -10.6, 10.6, mat));
        adds.push(wedgeX(x(-53), x(-41.5), 8, 10.6, 0, 0, WALK_Y, mat));
        adds.push(wedgeX(x(-53), x(-41.5), -10.6, -8, 0, 0, WALK_Y, mat));
        lateCuts.push(box(x(-39), x(-35.5), 0, 4.5, -2.2, 2.2, mat));
        last.push(box(x(-37.6), x(-37), 0, 4.5, -2.2, 2.2, WOOD));
        cuts.push(box(x(-59.5), x(-38.5), SURFACE - 0.6, SURFACE + 0.01, -10.5, 10.5, DIRT));
        late.push(box(x(-59.5), x(-38.5), SURFACE - 0.6, SURFACE, -10.5, 10.5, COBBLE));
        lateCuts.push(box(x(-60), x(-50), -6, -2.5, -5, 5, mat));
        lateCuts.push(slopeZ(10.5, -1.5, x(-56), x(-53), 0, 3.4, -6, -2.6, mat));
        lateCuts.push(box(x(-50.5), x(-30), -6, -2.8, -1.5, 1.5, STONE));
        lateCuts.push(box(x(-32), x(-28), -6, -2.8, -1.5, 6.5, STONE));
        lateCuts.push(box(x(-30), x(-7), -6, -2.8, 3.5, 6.5, STONE));
        adds.push(box(x(-50), x(-34), 0, 7.5, 17, 22.5, DARK));
        adds.push(cyl(x(-46), 20, 0, 8.5, 3.5, DARK));
        lateCuts.push(box(x(-45), x(-41), 0, 3.2, -26, -19.5, STONE));
        lateCuts.push(box(x(-47.5), x(-44.5), -10, -7.5, 5, 8, DIRT));
        lateCuts.push(box(x(-15.5), x(-12.5), -11, -8.5, -13, -10, DIRT));
    }
    fort(-1, RED_STONE);
    fort(+1, BLUE_STONE);
    adds.push(box(-X, X, 0, 6, 22, Z, DARK));
    for(let i = 0; i < 26; i++) {
        let cx = -78 + i * 6.2 + rnd() * 2, cz = 25 + rnd() * 13, r = 2.5 + rnd() * 3.5, h = 6.5 + rnd() * 3;
        if(Math.abs(cx) < 11) continue;
        adds.push(cyl(cx, cz, 0, h, r, DARK));
    }
    adds.push(box(-X, X, 0, 9, 37, Z, DARK));
    for(let s of [-1, 1]) for(let rx of [14, 44]) adds.push(wedgeZ(11, 22.2, s * rx - 2, s * rx + 2, 0, 0, 6, DIRT));
    adds.push(box(-X, X, 0, 5, -Z, -20, DARK));
    for(let i = 0; i < 20; i++) {
        let cx = -78 + i * 8 + rnd() * 3, cz = -38 + rnd() * 6, r = 3 + rnd() * 3, h = 5.5 + rnd() * 3;
        adds.push(cyl(cx, cz, 0, h, r, DARK));
    }
    cuts.push(box(-GORGE_W, GORGE_W, BED, SURFACE + 0.01, -Z, Z, DIRT));
    late.push(box(-GORGE_W, GORGE_W, BED, BED + 0.6, -Z, Z, SAND));
    late.push(wedgeZ(10, 22, -GORGE_W, GORGE_W, BED, BED + 0.6, 0, DIRT));
    late.push(wedgeZ(-10, -22, -GORGE_W, GORGE_W, BED, BED + 0.6, 0, DIRT));
    late.push(box(-GORGE_W - 0.6, GORGE_W + 0.6, -1, 0, -4, 4, COBBLE));
    late.push(box(-GORGE_W - 0.6, GORGE_W + 0.6, 0, 1.1, -4.5, -4, COBBLE));
    late.push(box(-GORGE_W - 0.6, GORGE_W + 0.6, 0, 1.1, 4, 4.5, COBBLE));
    late.push(box(-6, 6, -1, 0, -9, 9, COBBLE));
    late.push(cyl(0, 6.5, 0, 3, 2.4, STONE));
    lateCuts.push(cyl(0, 6.5, 0.6, 3.5, 1.7, STONE));
    lateCuts.push(box(-1, 1, 0.6, 2.4, 3.5, 6.5, STONE));
    late.push(box(-GORGE_W - 1.5, GORGE_W + 1.5, 3.5, 7, 29, 35, DARK));
    late.push(box(-GORGE_W - 1.5, GORGE_W + 1.5, -0.8, 4, -30, -25, DARK));
    lateCuts.push(box(-44, 44, 0, 3.2, -29, -26, STONE));
    for(let wx of [-28, -12, 12, 28]) lateCuts.push(box(wx - 1, wx + 1, 1, 3, -26.5, -19.5, STONE));
    lateCuts.push(box(-2, 2, -15, -12, -2, 2, STONE));
    return [{ add: true, list: adds }, { add: false, list: cuts }, { add: true, list: late }, { add: false, list: lateCuts }, { add: true, list: last }];
}

/** Level field with primitives bucketed on a coarse grid (a point only evaluates primitives within REACH). */
export class Level {
    constructor() {
        this.groups = program();
        this.B = 4; // bucket size (m)
        this.REACH = 2.5;
        this.buckets = new Map();
        this.groups.forEach((g, gi) => g.list.forEach((p, pi) => {
            p.group = gi; p.order = pi;
            // nudge: the whole design moves by +0.1 on every axis
            // bounds are copied (box closures hold their own min/max arrays: shifting those would nudge them twice)
            p.min = p.min.map((v) => v + NUDGE); p.max = p.max.map((v) => v + NUDGE);
            let d = p.d; p.d = (x, y, z) => d(x - NUDGE, y - NUDGE, z - NUDGE);
            const lo = p.min.map(v => Math.floor((v - this.REACH) / this.B)), hi = p.max.map(v => Math.floor((v + this.REACH) / this.B));
            for(let i = lo[0]; i <= hi[0]; i++) for(let j = lo[1]; j <= hi[1]; j++) for(let k = lo[2]; k <= hi[2]; k++) {
                const key = (i * 4096 + j) * 4096 + k; // offsets keep keys unique for |i|,|j|,|k| < 2048
                let b = this.buckets.get(key); if(!b) this.buckets.set(key, b = []);
                b.push(p);
            }
        }));
        this.empty = [];
    }
    _bucket(x, y, z) {
        return this.buckets.get((Math.floor(x / this.B) * 4096 + Math.floor(y / this.B)) * 4096 + Math.floor(z / this.B)) || this.empty;
    }
    /** Signed distance (negative inside). Far from every primitive: +REACH (air). */
    sdf(x, y, z) {
        const prims = this._bucket(x, y, z);
        let S = this.REACH;
        const gmin = [this.REACH, this.REACH, this.REACH, this.REACH, this.REACH];
        for(const p of prims) { const d = p.d(x, y, z); if(d < gmin[p.group]) gmin[p.group] = d; }
        S = gmin[0];
        S = Math.max(S, -gmin[1]);
        S = Math.min(S, gmin[2]);
        S = Math.max(S, -gmin[3]);
        S = Math.min(S, gmin[4]);
        return S;
    }
    /** Material at a solid point: last containing primitive of the last adding group that contains it. */
    material(x, y, z) {
        const prims = this._bucket(x, y, z);
        let best = null;
        for(const p of prims) {
            if(!this.groups[p.group].add) continue;
            if(p.d(x, y, z) > 1e-6) continue; // same inclusive test as voxelize: faces on the lattice read 0 ± rounding
            if(!best || p.group > best.group || (p.group === best.group && p.order > best.order)) best = p;
        }
        return best ? best.mat : DIRT;
    }
}

// ---- game layout (gen-fortwar's game config, nudged) ----
const nudge = p => p.map(v => v + NUDGE);
const team = (s, name, color, material) => ({
    name, color, material,
    spawns: [-6, -2, 2, 6].map(z => nudge([s * 57, 0.6, z])),
    vault: { min: nudge([Math.min(s * 60, s * 50), -7, -5]), max: nudge([Math.max(s * 60, s * 50), -1.5, 5]) },
});
export const GAME = {
    teams: { red: team(-1, 'Red', '#e03a2f', RED_STONE), blue: team(+1, 'Blue', '#3a7be0', BLUE_STONE) },
    surfaceY: SURFACE + NUDGE,
};
