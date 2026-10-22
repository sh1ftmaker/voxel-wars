/**
 * The materials showcase on Twin Forts (docs/LEVEL.md): wood with grain, glass, metal, brick, dirt works, dunes and
 * boulders, added to the fortwar program's groups (src/level/fortwar.js). Mirror-symmetric in x: every side feature
 * is written in red's coordinates (x < 0) and placed for both teams through X(v) = -s v.
 *
 * Anchoring: building materials only bond within their own class (src/voxel/islands.js BOND_CLASS), so a wooden or
 * metal structure would be a loose island the first time an edit touches it. Each one stands on hidden piles of its
 * own material running down to the bedrock (PILE_Y): intact it holds, cut its legs and it falls. Glass is never
 * anchored: every pane is its own island in a frame of another material, so a hit knocks out one pane at a time.
 * Piles are kept clear of the tunnels, the vault and the caches (fortwar's lateCuts). A pile is a hidden 1.05 m square
 * column (the voxelizer fills deep solid 1 m blocks with one material when their corners and centre agree, so a
 * thinner column would vanish into the dirt) with a thin neck up into its structure.
 */
import { box, wbox, cyl, cylX, ellipsoid, dome, diff, inter, prismX,
    DIRT, SAND, SNOW, BRICK, METAL, LAVA, COBBLE, DARK, WOOD_X, WOOD_Y, GLASS } from './prims.js';

const PILE_Y = -15.95; // bottom of the world's bedrock band: a pile reaching it anchors its structure

// the water towers' tanks (red's side; blue's is mirrored in x) and the lava basins (x for sx = 1): their shapes below,
// and where the fluid (src/fluid/Fluid.js) fills them
const TANK = { x: -71, z: -13, y0: 6.0, y1: 10.2, r: 2.6, wall: 0.35 };
const BASIN = { x: 24, z: -33.5, floor: 4.75, rim: 5.02, r: 3.0 };
/** Fluid sources: water filling each tank's cavity (`fill`: fraction of its height), lava over each basin's floor. */
export const FLUID_SOURCES = [
    ...[-1, 1].map(s => ({ kind: 'water', shape: 'cylinder', x: -s * TANK.x, z: TANK.z, r: TANK.r - TANK.wall,
        y0: TANK.y0 + TANK.wall, y1: TANK.y1 - TANK.wall, fill: 0.8 })),
    ...[-1, 1].map(sx => ({ kind: 'lava', shape: 'cylinder', x: sx * BASIN.x, z: BASIN.z, r: BASIN.r, y0: BASIN.floor, y1: BASIN.rim, layers: 1 })),
];

export function showcase({ late, lateCuts, last }, { TOWER_H, GORGE_W }) {
    /** A pile under (cx, cz) up to `top`: the wide column ends `neck` below the top, a 0.4 m neck joins the structure. */
    const pile = (cx, cz, top, mat = WOOD_Y, neck = 0.35) => {
        last.push(box(cx - 0.525, cx + 0.525, PILE_Y, top - neck, cz - 0.525, cz + 0.525, mat));
        last.push(box(cx - 0.2, cx + 0.2, top - neck - 0.05, top, cz - 0.2, cz + 0.2, mat));
    };

    for(const s of [-1, 1]) {
        const X = v => -s * v;
        // ---- the road from the gate to the bridge: paved at the gate and under the bridgehead arch, a trodden dirt
        // track across the midfield (a paved midfield would leave craters with hard, undercut lips: no way out)
        late.push(box(X(-35.5), X(-GORGE_W - 0.6), -0.6, 0, -2, 2, DIRT));
        late.push(box(X(-35.5), X(-31), -0.6, 0, -2, 2, COBBLE));
        late.push(box(X(-12.5), X(-GORGE_W - 0.6), -0.6, 0, -2, 2, COBBLE));

        // ---- stockade before the gate: vertical logs (grain y) on a buried sill, two piles
        for(const sz of [-1, 1]) {
            for(let z = 3.2; z <= 9.85; z += 0.55) last.push(cyl(X(-32), sz * z, -1.0, 2.8, 0.32, WOOD_Y));
            last.push(wbox(X(-32.3), X(-31.7), -1.3, -0.8, sz * 3, sz * 10));
            pile(X(-32), sz * 9.6, -1.3);
        }

        // ---- watchtower on stilts (wood), a ramp up to it, a crate on top
        {
            const cx = -22, cz = -13, H = 6.0;
            for(const [dx, dz] of [[-1.6, -1.6], [1.6, -1.6], [-1.6, 1.6], [1.6, 1.6]]) {
                last.push(wbox(X(cx + dx - 0.25), X(cx + dx + 0.25), -1.0, H, cz + dz - 0.25, cz + dz + 0.25));
                if(dx === dz) pile(X(cx + dx), cz + dz, -1.0); // two diagonal legs are piled: blow both and it falls
            }
            // braces between the legs
            last.push(wbox(X(cx - 1.85), X(cx + 1.85), 3.0, 3.35, cz - 1.75, cz - 1.45));
            last.push(wbox(X(cx - 1.85), X(cx + 1.85), 3.0, 3.35, cz + 1.45, cz + 1.75));
            last.push(wbox(X(cx - 1.75), X(cx - 1.45), 3.0, 3.35, cz - 1.85, cz + 1.85));
            last.push(wbox(X(cx + 1.45), X(cx + 1.75), 3.0, 3.35, cz - 1.85, cz + 1.85));
            // deck (planks along x) and rails, open toward the ramp
            last.push(box(X(cx - 2.0), X(cx + 2.0), H, H + 0.4, cz - 2.0, cz + 2.0, WOOD_X));
            last.push(wbox(X(cx - 2.0), X(cx + 2.0), H + 0.4, H + 1.3, cz - 2.0, cz - 1.75));
            last.push(wbox(X(cx - 2.0), X(cx + 2.0), H + 0.4, H + 1.3, cz + 1.75, cz + 2.0));
            last.push(wbox(X(cx + 1.75), X(cx + 2.0), H + 0.4, H + 1.3, cz - 2.0, cz + 2.0));
            // ramp: a plank slab from the deck's fort side down to the ground, with a post halfway
            const L = 10.5, px = 5.0, under = H - (H + 0.4) * px / L; // ramp length, post position, slab underside there
            last.push(prismX(X(cx - 2.0), X(cx - 2.0 - L), cz - 0.6, cz + 0.6, H, H + 0.4, -0.4, 0, WOOD_X));
            last.push(wbox(X(cx - 2.0 - px - 0.2), X(cx - 2.0 - px + 0.2), -0.6, under + 0.05, cz - 0.2, cz + 0.2));
        }

        // ---- scaffolding on the outside of the north wall: two plank levels to climb onto the wall walk
        {
            const z0 = 13.3, z1 = 15.3;
            for(const pz of [z0 + 0.15, z1 - 0.15]) {
                for(const px of [-57.5, -53.5, -49.5, -45.5, -41.5]) last.push(wbox(X(px - 0.15), X(px + 0.15), -1.0, 5.6, pz - 0.15, pz + 0.15));
                last.push(wbox(X(-57.8), X(-41.2), -1.3, -0.8, pz - 0.2, pz + 0.2)); // buried sill under the row
                pile(X(-49.5), pz, -1.3);
            }
            for(const y of [2.4, 4.9]) last.push(box(X(-58), X(-41), y, y + 0.3, z0, z1, WOOD_X));
        }

        // ---- glass windows through the fort's side walls (one pane each, set in the stone)
        for(const wx of [-54, -48.5, -43]) for(const sz of [-1, 1]) {
            lateCuts.push(box(X(wx - 0.7), X(wx + 0.7), 2.6, 4.2, sz * 10.4, sz * 13.1, GLASS));
            last.push(box(X(wx - 0.7), X(wx + 0.7), 2.6, 4.2, sz * 11.55, sz * 11.95, GLASS));
        }

        // ---- metal catwalk between the front towers' tops, anchored on piles inside the towers
        {
            const cx = -36.5, y = TOWER_H, E = 11.6;
            lateCuts.push(box(X(cx - 0.6), X(cx + 0.6), y, y + 1.6, -10.6, 10.6, METAL)); // gaps in the towers' parapets
            for(const sz of [-1, 1]) pile(X(cx), sz * 11.2, y, METAL); // inside the towers, clear of their inner faces
            last.push(box(X(cx - 0.5), X(cx + 0.5), y, y + 0.3, -E, E, METAL));
            last.push(box(X(cx - 0.5), X(cx - 0.3), y + 0.3, y + 1.2, -E, E, METAL));
            last.push(box(X(cx + 0.3), X(cx + 0.5), y + 0.3, y + 1.2, -E, E, METAL));
        }

        // ---- water tower behind the fort: a hollow metal tank on four girder legs
        {
            const cx = TANK.x, cz = TANK.z, Y0 = TANK.y0, Y1 = TANK.y1, R = TANK.r, T = TANK.wall;
            for(const [dx, dz] of [[-1.8, -1.8], [1.8, -1.8], [-1.8, 1.8], [1.8, 1.8]]) {
                last.push(box(X(cx + dx - 0.25), X(cx + dx + 0.25), -1.0, Y0, cz + dz - 0.25, cz + dz + 0.25, METAL));
                pile(X(cx + dx), cz + dz, -1.0, METAL);
            }
            last.push(box(X(cx - 2.05), X(cx + 2.05), 2.8, 3.2, cz - 2.05, cz - 1.55, METAL));
            last.push(box(X(cx - 2.05), X(cx + 2.05), 2.8, 3.2, cz + 1.55, cz + 2.05, METAL));
            last.push(box(X(cx - 2.05), X(cx - 1.55), 2.8, 3.2, cz - 2.05, cz + 2.05, METAL));
            last.push(box(X(cx + 1.55), X(cx + 2.05), 2.8, 3.2, cz - 2.05, cz + 2.05, METAL));
            last.push(diff(cyl(X(cx), cz, Y0, Y1, R, METAL), cyl(X(cx), cz, Y0 + T, Y1 - T, R - T, METAL)));
            last.push(cyl(X(cx), cz, Y1, Y1 + 0.35, 1.0, METAL));
        }

        // ---- brick arch over the road at the bridgehead (pillars on brick piles)
        {
            const ax = -11;
            for(const sz of [-1, 1]) {
                last.push(box(X(ax - 0.5), X(ax + 0.5), -0.6, 3.6, sz * 2.6, sz * 3.6, BRICK));
                pile(X(ax), sz * 2.9, -0.6, BRICK); // ends short of the sewer (z 3.5) under the road
            }
            last.push(diff(box(X(ax - 0.5), X(ax + 0.5), 3.4, 5.0, -3.6, 3.6, BRICK), cylX(1.8, 0, X(ax - 0.6), X(ax + 0.6), 2.6, BRICK)));
        }

        // ---- midfield cover: dark rock boulders, a trench with a dirt berm, wooden crate stacks, sand dunes
        last.push(ellipsoid([X(-18), 0.2, -5.5], [1.6, 1.5, 1.3], DARK));
        last.push(ellipsoid([X(-27.5), 0.2, 6.5], [1.4, 1.6, 1.7], DARK));
        lateCuts.push(box(X(-16.2), X(-15.0), -1.3, 0.1, 7.0, 11.5, DIRT));
        last.push(ellipsoid([X(-14.0), -0.2, 9.25], [0.9, 1.1, 2.6], DIRT));
        for(const [bx, bz, n] of [[-20, 7.5, 2], [-28, -7.5, 3]]) {
            for(let i = 0; i < n; i++) last.push(box(X(bx + i * 1.05), X(bx + i * 1.05 + 1), 0, 1, bz - 0.5, bz + 0.5, WOOD_X));
            last.push(box(X(bx + 0.5), X(bx + 1.5), 1, 2, bz - 0.5, bz + 0.5, WOOD_X));
        }
        last.push(ellipsoid([X(-14), -0.6, -17.2], [4.0, 1.4, 2.4], SAND));
        last.push(ellipsoid([X(-30), -0.6, -17.5], [3.5, 1.2, 2.2], SAND));

        // ---- glass observatory on the north ridge: a dome of four panes between metal ribs, a crate inside
        {
            const cx = X(-24), cz = 30, R = 3.2, base = 6.0;
            lateCuts.push(cyl(cx, cz, base + 0.01, base + 6, R + 1.5, DARK)); // a flat terrace in the crags
            last.push(diff(cyl(cx, cz, base - 0.4, base + 0.4, R + 0.2, METAL), cyl(cx, cz, base - 1, base + 1, R - 0.6, METAL)));
            pile(cx + R - 0.2, cz, base - 0.4, METAL);
            const shell = dome([cx, base + 0.4, cz], R, 0.4, GLASS);
            last.push(shell);
            const ribShell = dome([cx, base + 0.4, cz], R + 0.05, 0.5, METAL);
            last.push(inter(ribShell, box(cx - 0.2, cx + 0.2, base, base + R + 1, cz - R - 1, cz + R + 1, METAL), METAL));
            last.push(inter(ribShell, box(cx - R - 1, cx + R + 1, base, base + R + 1, cz - 0.2, cz + 0.2, METAL), METAL));
        }
    }

    // ---- crossings: a glass skybridge on metal girders (north), a wooden trestle footbridge (south)
    {
        const z0 = 12.5, z1 = 15.5, W = GORGE_W + 1.6;
        for(const [a, b] of [[z0, z0 + 0.4], [z1 - 0.4, z1]]) {
            last.push(box(-W, W, -0.9, -0.25, a, b, METAL));
            for(const sx of [-1, 1]) pile(sx * 9.6, (a + b) / 2, -0.9, METAL);
        }
        // panes between mullions: each pane is its own island
        const n = 8, span = 2 * (GORGE_W + 0.6);
        for(let k = 0; k < n; k++) {
            const a = -GORGE_W - 0.6 + k * span / n, b = a + span / n;
            last.push(box(a + 0.2, b - 0.2, -0.35, 0, z0, z1, GLASS));
        }
        for(let k = 0; k <= n; k++) {
            const m = -GORGE_W - 0.6 + k * span / n;
            last.push(box(m - 0.2, m + 0.2, -0.35, 0, z0, z1, METAL));
            for(const [a, b] of [[z0, z0 + 0.3], [z1 - 0.3, z1]]) last.push(box(m - 0.15, m + 0.15, 0, 1.0, a, b, METAL));
        }
        for(const [a, b] of [[z0, z0 + 0.3], [z1 - 0.3, z1]]) last.push(box(-GORGE_W - 0.6, GORGE_W + 0.6, 1.0, 1.25, a, b, METAL));
    }
    {
        const z0 = -14.6, z1 = -13.0, W = GORGE_W + 1.6;
        last.push(box(-W, W, -0.35, 0, z0, z1, WOOD_X));
        for(const [a, b] of [[z0, z0 + 0.25], [z1 - 0.25, z1]]) last.push(box(-GORGE_W - 0.6, GORGE_W + 0.6, 0, 0.9, a, b, WOOD_X));
        for(const sx of [-1, 1]) {
            pile(sx * 9.4, (z0 + z1) / 2, -0.35);
            // trestle posts standing on the gorge's ramp, on piles that end under its surface
            for(const pz of [z0 + 0.4, z1 - 0.4]) {
                last.push(wbox(sx * 3.2 - 0.2, sx * 3.2 + 0.2, -5.4, -0.35, pz - 0.2, pz + 0.2));
                pile(sx * 3.2, pz, -5.0, WOOD_Y, 0.4);
            }
        }
    }
    // lava basins on the south ridge (decorative: lava does no damage), on solid ground: not on the rock roof over the
    // gorge (lava cannot span) and clear of the tunnel below (z -29..-26)
    for(const sx of [-1, 1]) {
        const bx = sx * BASIN.x, bz = BASIN.z;
        lateCuts.push(cyl(bx, bz, 5.01, 11, 5.5, LAVA)); // a terrace cleared in the crags
        lateCuts.push(cyl(bx, bz, 4.4, BASIN.rim, BASIN.r, LAVA));
        last.push(cyl(bx, bz, 4.4, BASIN.floor, BASIN.r, LAVA));
    }
    // a snowy crest on the ridge's back wall
    for(const sx of [-1, 1]) late.push(box(sx * 9, sx * 80, 9, 9.35, 37, 40, SNOW)); // not over the gorge: snow cannot span it
}
