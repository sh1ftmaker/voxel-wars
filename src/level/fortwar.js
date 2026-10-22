/**
 * Twin Forts as a signed distance field: the CSG program of tools/gen-fortwar.mjs (same primitives, same order of
 * unions and subtractions, same seeded rock lumps, same 0.1 m nudge), evaluated per point instead of through
 * Manifold, plus the materials showcase (src/level/showcase.js, docs/LEVEL.md): wood with grain, glass, metal, brick,
 * snow, lava, dunes and earthworks. Primitives live in src/level/prims.js.
 *
 * sdf(p) < 0 inside solid. Union = min, subtraction = max(a, -b). Box / prism distances are max-of-planes
 * (exact inside, a slight underestimate past edges outside), which is all the voxelizer and the node snapping need.
 * material(p) is the material of the last primitive (in program order) that contains p.
 */

import { box, cyl, slopeZ, wedgeX, wedgeZ, STONE, DIRT, GRASS, SAND, SNOW, RED_STONE, BLUE_STONE, WOOD_Y, COBBLE, DARK } from './prims.js';
import { showcase } from './showcase.js';
export { STONE, DIRT, GRASS, SAND, RED_STONE, BLUE_STONE, WOOD, COBBLE, DARK } from './prims.js';
export const MAT_NAMES = { 0: 'Stone', 1: 'Dirt', 2: 'Grass', 3: 'Sand', 4: 'Snow', 5: 'Brick', 6: 'Metal', 7: 'Lava', 8: 'Red Stone', 9: 'Blue Stone',
    10: 'Wood', 11: 'Cobble', 12: 'Dark Rock', 16: 'Glass' };

export const X = 80, Z = 40;
export const SURFACE = 0, BOTTOM = -40;
const WALL_H = 6.5, MERLON_H = 7.6, WALK_Y = 5.5, TOWER_H = 9.5;
const GORGE_W = 8, GORGE_D = 6, BED = -GORGE_D - 0.6;
export const NUDGE = 0.1;

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
        last.push(box(x(-37.6), x(-37), 0, 4.5, -2.2, 2.2, WOOD_Y)); // the gate: vertical planks
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
        late.push(cyl(cx, cz, h - 0.4, h + 0.3, r, SNOW)); // snow caps on the north crags (flush: a lip would hang loose where the crag is cut)
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
    showcase({ late, lateCuts, last }, { TOWER_H, GORGE_W }); // the materials showcase (src/level/showcase.js)
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
            const d = p.d0 = p.d; p.d = (x, y, z) => d(x - NUDGE, y - NUDGE, z - NUDGE);
            const lo = p.min.map(v => Math.floor((v - this.REACH) / this.B)), hi = p.max.map(v => Math.floor((v + this.REACH) / this.B));
            for(let i = lo[0]; i <= hi[0]; i++) for(let j = lo[1]; j <= hi[1]; j++) for(let k = lo[2]; k <= hi[2]; k++) {
                const key = (i * 4096 + j) * 4096 + k; // offsets keep keys unique for |i|,|j|,|k| < 2048
                let b = this.buckets.get(key); if(!b) this.buckets.set(key, b = []);
                b.push(p);
            }
        }));
        // per bucket, the adding primitives by priority (later group, then later in the group, first): material() takes
        // the first that contains the point
        for(const b of this.buckets.values()) b.byPriority = b.filter(p => this.groups[p.group].add).sort((a, c) => c.group - a.group || c.order - a.order);
        this.empty = []; this.empty.byPriority = [];
    }
    _bucket(x, y, z) {
        return this.buckets.get((Math.floor(x / this.B) * 4096 + Math.floor(y / this.B)) * 4096 + Math.floor(z / this.B)) || this.empty;
    }
    /** Signed distance (negative inside). Far from every primitive: +REACH (air). */
    sdf(x, y, z) {
        const prims = this._bucket(x, y, z), R = this.REACH;
        const px = x - NUDGE, py = y - NUDGE, pz = z - NUDGE;
        let g0 = R, g1 = R, g2 = R, g3 = R, g4 = R;
        for(let i = 0; i < prims.length; i++) {
            const p = prims[i], d = p.d0(px, py, pz);
            switch(p.group) {
                case 0: if(d < g0) g0 = d; break;
                case 1: if(d < g1) g1 = d; break;
                case 2: if(d < g2) g2 = d; break;
                case 3: if(d < g3) g3 = d; break;
                default: if(d < g4) g4 = d;
            }
        }
        return Math.min(Math.max(Math.min(Math.max(g0, -g1), g2), -g3), g4);
    }
    /** Material at a solid point: last containing primitive of the last adding group that contains it. */
    material(x, y, z) {
        const prims = this._bucket(x, y, z).byPriority;
        const px = x - NUDGE, py = y - NUDGE, pz = z - NUDGE;
        // same inclusive test as voxelize: faces on the lattice read 0 ± rounding
        for(let i = 0; i < prims.length; i++) if(prims[i].d0(px, py, pz) <= 1e-6) return prims[i].mat;
        return DIRT;
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
