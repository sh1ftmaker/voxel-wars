/**
 * Bake a bent soft lattice into its voxel grid (metal that bent and stays bent): new_sdf(x) = old_sdf(x - u(x)) with
 * u the lattice's frozen displacement (trilinear over its nodes), as src/soft/core.js bakeZone does for the ground.
 * The grid grows by a margin so the bent shape fits; the result's `offset` (samples, relative to the old grid's local
 * samples) says where it sits, as islands.splitGrid pieces do. Pure: runs in the soft debris worker and in node.
 */
import { VOXEL, PAD, SDF_MAX } from '../config.js';
import { newGrid } from '../voxel/islands.js';

/** -> grid (with offset and count) or null when nothing solid is left. */
export function bakeLattice(g, L) {
    const m = Math.ceil(L.maxUr / VOXEL) + 1;
    const nx = g.nx + 2 * m, ny = g.ny + 2 * m, nz = g.nz + 2 * m;
    const out = newGrid(nx, ny, nz);
    const P = g.nx + 2 * PAD, PP = P * (g.ny + 2 * PAD), Q = nx + 2 * PAD, QQ = Q * (ny + 2 * PAD);
    const s = new Float32Array(6);
    // old sdf at a sample position (fractional, unpadded): trilinear, outside the grid empty
    const at = (fx, fy, fz) => {
        const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz), tx = fx - x0, ty = fy - y0, tz = fz - z0;
        let d = 0;
        for(let c = 0; c < 8; c++) {
            const a = c & 1, b = (c >> 1) & 1, e = c >> 2;
            const x = x0 + a, y = y0 + b, z = z0 + e;
            const v = x < -PAD || y < -PAD || z < -PAD || x >= g.nx + PAD || y >= g.ny + PAD || z >= g.nz + PAD ? SDF_MAX : g.sdf[x + PAD + (y + PAD) * P + (z + PAD) * PP];
            d += v * (a ? tx : 1 - tx) * (b ? ty : 1 - ty) * (e ? tz : 1 - tz);
        }
        return d;
    };
    const matAt = (x, y, z) => {
        x = Math.max(-PAD, Math.min(g.nx + PAD - 1, Math.round(x))); y = Math.max(-PAD, Math.min(g.ny + PAD - 1, Math.round(y))); z = Math.max(-PAD, Math.min(g.nz + PAD - 1, Math.round(z)));
        return g.mat[x + PAD + (y + PAD) * P + (z + PAD) * PP];
    };
    let count = 0, fallback = 0;
    for(let i = 0; i < g.mat.length; i++) if(g.sdf[i] < 0) { fallback = g.mat[i]; break; }
    for(let z = -PAD; z < nz + PAD; z++) for(let y = -PAD; y < ny + PAD; y++) for(let x = -PAD; x < nx + PAD; x++) {
        // the old grid's local position of this sample, pulled back along the displacement
        const ox = x - m, oy = y - m, oz = z - m;
        L.sampleAt(ox * VOXEL, oy * VOXEL, oz * VOXEL, s);
        const sx = ox - s[0] / VOXEL, sy = oy - s[1] / VOXEL, sz = oz - s[2] / VOXEL;
        const d = Math.max(-128, Math.min(SDF_MAX, Math.round(at(sx, sy, sz))));
        const i = x + PAD + (y + PAD) * Q + (z + PAD) * QQ;
        out.sdf[i] = d;
        if(d < 0) {
            let mt = matAt(sx, sy, sz);
            if(!mt && fallback) mt = fallback;
            out.mat[i] = mt;
            if(x >= 0 && y >= 0 && z >= 0 && x < nx && y < ny && z < nz) count++;
        }
    }
    // the padding ring stays empty (a body's grid has no matter there)
    for(let z = -PAD; z < nz + PAD; z++) for(let y = -PAD; y < ny + PAD; y++) for(let x = -PAD; x < nx + PAD; x++) {
        if(x >= 0 && y >= 0 && z >= 0 && x < nx && y < ny && z < nz) continue;
        const i = x + PAD + (y + PAD) * Q + (z + PAD) * QQ;
        if(out.sdf[i] < 0) out.sdf[i] = 1;
    }
    if(!count) return null;
    out.count = count;
    out.offset = [-m, -m, -m];
    return out;
}
