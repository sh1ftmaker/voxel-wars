/**
 * Surface Nets mesher for one chunk. Pure function, safe to run in a worker.
 *
 * Input: a padded window (VoxelWorld.extractPadded) of (nx + 2*PAD) x (ny + 2*PAD) x (nz + 2*PAD) samples, index
 * x + y*Px + z*Px*Py, Int8 distances and Uint8 materials (a chunk is nx = ny = nz = CHUNK; a detached body's grid
 * can be any size). Samples in the outer PAD layer only feed normals and the cells straddling the border. Cells (the cubes between 8 samples) with a sign change get one vertex at the mean of their edge
 * crossings; every lattice edge with a sign change emits a quad joining the four cells around it. A chunk emits the
 * quads of the edges whose base sample it owns (local [0, n)), so neighbouring chunks meet without seams or overlaps.
 *
 * Output positions are in metres relative to the chunk's origin sample (local sample 0 at 0).
 */
import { VOXEL, PAD } from '../config.js';

// cube corner offsets, bit i of the corner mask = corner i
const CORNERS = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];

/**
 * @returns {{ positions: Float32Array, normals: Float32Array, materials: Uint8Array, ao: Float32Array, indices: Uint32Array }}
 */
export function surfaceNets(sdf, mat, nx, ny = nx, nz = nx, scale = VOXEL) {
    const P = nx + 2 * PAD, Py = ny + 2 * PAD, Pz = nz + 2 * PAD, P2 = P * Py;
    const cellVert = new Int32Array(P2 * Pz).fill(-1);
    const pos = [], nrm = [], mats = [], ao = [], idx = [];
    const cornerOff = CORNERS.map(([x, y, z]) => x + y * P + z * P2);
    const d = new Float32Array(8);
    // cells with base padded coordinate in [PAD-1, PAD+n-1] (local -1..n-1), all the quads below touch
    const c0 = PAD - 1;
    for(let z = c0; z <= PAD + nz - 1; z++) for(let y = c0; y <= PAD + ny - 1; y++) for(let x = c0; x <= PAD + nx - 1; x++) {
        const base = x + y * P + z * P2;
        let mask = 0;
        for(let i = 0; i < 8; i++) { d[i] = sdf[base + cornerOff[i]]; if(d[i] < 0) mask |= 1 << i; }
        if(mask === 0 || mask === 255) continue;
        let sx = 0, sy = 0, sz = 0, cnt = 0;
        for(const [a, b] of EDGES) {
            const da = d[a], db = d[b];
            if((da < 0) === (db < 0)) continue;
            const t = da / (da - db);
            const A = CORNERS[a], Bc = CORNERS[b];
            sx += A[0] + (Bc[0] - A[0]) * t; sy += A[1] + (Bc[1] - A[1]) * t; sz += A[2] + (Bc[2] - A[2]) * t;
            cnt++;
        }
        const fx = sx / cnt, fy = sy / cnt, fz = sz / cnt;
        // normal: trilinear blend of the corners' central-difference gradients
        let gx = 0, gy = 0, gz = 0, best = 1e9, m = 0;
        for(let i = 0; i < 8; i++) {
            const [cx, cy, cz] = CORNERS[i];
            const w = (cx ? fx : 1 - fx) * (cy ? fy : 1 - fy) * (cz ? fz : 1 - fz);
            const s = base + cornerOff[i];
            gx += w * (sdf[s + 1] - sdf[s - 1]);
            gy += w * (sdf[s + P] - sdf[s - P]);
            gz += w * (sdf[s + P2] - sdf[s - P2]);
            if(d[i] < best) { best = d[i]; m = mat[s]; }
        }
        const gl = Math.hypot(gx, gy, gz) || 1;
        gx /= gl; gy /= gl; gz /= gl;
        // ambient occlusion: how much solid lies in the half space around the normal (a few samples)
        let occ = 0, tot = 0;
        for(let k = 1; k <= 3; k++) {
            const r = k * 1.5;
            for(const [ox, oy, oz] of AO_DIRS) {
                const dx = gx + ox * 0.8, dy = gy + oy * 0.8, dz = gz + oz * 0.8;
                const qx = Math.round(x + fx + dx * r), qy = Math.round(y + fy + dy * r), qz = Math.round(z + fz + dz * r);
                if(qx < 0 || qy < 0 || qz < 0 || qx >= P || qy >= Py || qz >= Pz) continue;
                tot++;
                if(sdf[qx + qy * P + qz * P2] < 0) occ += 1;
            }
        }
        cellVert[base] = pos.length / 3;
        pos.push((x - PAD + fx) * scale, (y - PAD + fy) * scale, (z - PAD + fz) * scale);
        nrm.push(gx, gy, gz);
        mats.push(m);
        ao.push(tot ? 1 - occ / tot : 1);
    }
    // quads: edges whose base sample is owned by this chunk (padded [PAD, PAD + n))
    const axisStep = [1, P, P2];
    // (u, v) axes for each edge axis, right handed: x -> (y, z), y -> (z, x), z -> (x, y)
    const UV = [[1, 2], [2, 0], [0, 1]];
    for(let z = PAD; z < PAD + nz; z++) for(let y = PAD; y < PAD + ny; y++) for(let x = PAD; x < PAD + nx; x++) {
        const s = x + y * P + z * P2;
        const inside = sdf[s] < 0;
        for(let a = 0; a < 3; a++) {
            if(inside === (sdf[s + axisStep[a]] < 0)) continue;
            const du = axisStep[UV[a][0]], dv = axisStep[UV[a][1]];
            const v00 = cellVert[s - du - dv], v10 = cellVert[s - dv], v11 = cellVert[s], v01 = cellVert[s - du];
            if(v00 < 0 || v10 < 0 || v11 < 0 || v01 < 0) continue;
            // split along the shorter diagonal
            const d1 = dist2(pos, v00, v11), d2 = dist2(pos, v10, v01);
            if(inside) {
                if(d1 <= d2) idx.push(v00, v10, v11, v00, v11, v01); else idx.push(v00, v10, v01, v10, v11, v01);
            } else {
                if(d1 <= d2) idx.push(v00, v11, v10, v00, v01, v11); else idx.push(v00, v01, v10, v10, v01, v11);
            }
        }
    }
    return {
        positions: new Float32Array(pos), normals: new Float32Array(nrm), materials: new Uint8Array(mats),
        ao: new Float32Array(ao), indices: new Uint32Array(idx),
    };
}
const AO_DIRS = [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
function dist2(p, a, b) { const x = p[a * 3] - p[b * 3], y = p[a * 3 + 1] - p[b * 3 + 1], z = p[a * 3 + 2] - p[b * 3 + 2]; return x * x + y * y + z * z; }
