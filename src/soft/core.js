/**
 * Soft ground: shared constants, tet tables and the pure zone classifier (runs in src/workers/softZone.js; also
 * importable from node for tests). No DOM, no three.js.
 *
 * A zone is a box of lattice cells of H = 0.5 m (2 voxels; far zones: 1 m, 4 voxels), aligned to the global lattice
 * of its spacing: cell (I, J, K) spans samples [spc I, spc I + spc] per axis. Each cell is split into 5 tets (mirrored on odd cells so faces conform, as in
 * worldparty-dmm voxels.js / dmm-js builder.js). Nodes sit on cell corners; a node's state is its displacement u.
 */
export const H = 0.5;              // lattice spacing (m) of near zones
export const SPC = 2;              // samples per cell edge of near zones
/** Far zones (big impacts: blasts, walls shuddering along their length) use 1 m cells: twice the reach for the same
 *  node count. A zone's spacing is per slot (slotC.y = cell size in metres). */
export const SPC_FAR = 4;
export const MAX_ZONES = 4;
export const NODE_CAP = 8192;      // nodes per zone slot: (nx+1)(ny+1)(nz+1) <= NODE_CAP
export const CELL_CAP = 4096;      // simulated cells per zone slot (x5 tets)
export const MAX_DIM = [20, 12, 20]; // max cells per axis (near zones)
export const MAX_DIM_FAR = [23, 13, 23]; // (far zones: 24 x 14 x 24 nodes: a tower's height)
export const maxDim = (spc) => spc === SPC_FAR ? MAX_DIM_FAR : MAX_DIM;

// Corners: 0=(000) 1=(100) 2=(110) 3=(010) 4=(001) 5=(101) 6=(111) 7=(011)
export const CUBE = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
export const TETS_EVEN = [[0, 1, 3, 4], [2, 3, 1, 6], [5, 4, 6, 1], [7, 6, 4, 3], [1, 3, 4, 6]];
export const TETS_ODD = [[1, 0, 2, 5], [3, 2, 0, 7], [4, 5, 7, 0], [6, 7, 5, 2], [0, 2, 5, 7]];
/** corner id from offsets (ox + 2 oy + 4 oz) */
export const CORNER_OF = [0, 1, 3, 2, 4, 5, 7, 6];

/** TET_OFF[p*20 + l*4 + k] = corner offset bits (ox | oy<<1 | oz<<2) of corner k of tet l in a cell of parity p. */
export const TET_OFF = [];
/** CORNER_TETS[p*32 + c*4 + j] = l*4 + k of the j-th tet corner of a parity-p cell at cube corner c, or -1. */
export const CORNER_TETS = new Array(64).fill(-1);
[TETS_EVEN, TETS_ODD].forEach((tets, p) => {
    tets.forEach((t, l) => t.forEach((c, k) => {
        const o = CUBE[c];
        TET_OFF.push(o[0] | (o[1] << 1) | (o[2] << 2));
        const base = p * 32 + c * 4;
        let j = 0; while(CORNER_TETS[base + j] !== -1) j++;
        CORNER_TETS[base + j] = l * 4 + k;
    }));
});

// node flags
export const F_ACTIVE = 1, F_PINNED = 2;

/**
 * Classify a zone from a region of samples.
 *   region: { sdf: Int8Array, mat: Uint8Array, lo: [sx, sy, sz] (sample coords of index 0), dims: [nx, ny, nz] }
 *           covering samples [spc*(c0-1), spc*(c0+n+1)] per axis (the zone's cells plus a ring of one cell)
 *   spc: samples per cell edge (SPC, or SPC_FAR for 1 m cells)
 *   c0: first cell (global lattice), n: cells per axis, bedrockY: first sample y that is not bedrock
 *   shell: leave out cells >= ~1 m inside the ground (pinned): the CPU solver simulates the surface skin only
 * Returns { cells: Int32Array (packed i | j<<8 | k<<16 | mat<<24, local cell coords), count,
 *           cellIdx: Int32Array(nodes) local cell index or -1 (indexed like nodes: i + j*NX + k*NX*NY),
 *           flags: Int32Array(nodes) F_ACTIVE | F_PINNED | mat<<8, solidFrac }
 */
export function classifyZone(region, c0, n, bedrockY, cellCap = CELL_CAP, { shell = false, spc = SPC } = {}) {
    const { sdf, mat, lo, dims } = region;
    const [dx, dy] = dims, dxy = dx * dy;
    const MX = n[0] + 2, MY = n[1] + 2, MZ = n[2] + 2; // cells incl. the ring
    // per ring cell: min sample over its 27 samples and the material there (separable min would be faster, but
    // the region is small: ~7k cells)
    const cmin = new Int16Array(MX * MY * MZ), cmat = new Uint8Array(MX * MY * MZ), deep = new Uint8Array(MX * MY * MZ);
    for(let k = 0; k < MZ; k++) for(let j = 0; j < MY; j++) for(let i = 0; i < MX; i++) {
        // ring cell (i, j, k) = global cell c0 - 1 + (i, j, k): samples from spc*i .. spc*i+spc in the region
        let best = 127, bm = 0, worst = -128;
        for(let c = 0; c <= spc; c++) for(let b = 0; b <= spc; b++) {
            let o = (spc * i) + (spc * j + b) * dx + (spc * k + c) * dxy;
            for(let a = 0; a <= spc; a++, o++) { const s = sdf[o]; if(s < best) { best = s; bm = mat[o]; } if(s > worst) worst = s; }
        }
        const ci = i + j * MX + k * MX * MY;
        cmin[ci] = best; cmat[ci] = bm;
        // shell: a cell whose samples are all deep (<= -100: >= ~0.8 m inside; voxelize saturates near -115) is rigid ground; its nodes are pinned
        if(shell && worst <= -100) deep[ci] = 1;
    }
    const NX = n[0] + 1, NY = n[1] + 1, NZ = n[2] + 1;
    const cellIdx = new Int32Array(NX * NY * NZ).fill(-1);
    const flags = new Int32Array(NX * NY * NZ);
    const cells = new Int32Array(cellCap);
    let count = 0, solid = 0;
    for(let k = 0; k < n[2]; k++) for(let j = 0; j < n[1]; j++) for(let i = 0; i < n[0]; i++) {
        const ci = (i + 1) + (j + 1) * MX + (k + 1) * MX * MY;
        if(cmin[ci] >= 0) continue;
        if(deep[ci]) continue;
        solid++;
        if(count >= cellCap) continue;
        const m = cmat[ci];
        cellIdx[i + j * NX + k * NX * NY] = count;
        cells[count++] = i | (j << 8) | (k << 16) | (m << 24);
        // its 8 nodes are active; the node takes the material of the most solid cell around it (set below)
        for(let c = 0; c < 8; c++) {
            const o = CUBE[c], ni = (i + o[0]) + (j + o[1]) * NX + (k + o[2]) * NX * NY;
            flags[ni] |= F_ACTIVE;
        }
    }
    // node materials, pins
    const bedNode = Math.ceil(bedrockY / spc) - c0[1]; // local node y below which nodes are bedrock
    for(let k = 0; k < NZ; k++) for(let j = 0; j < NY; j++) for(let i = 0; i < NX; i++) {
        const ni = i + j * NX + k * NX * NY;
        if(!(flags[ni] & F_ACTIVE)) continue;
        const border = i === 0 || j === 0 || k === 0 || i === n[0] || j === n[1] || k === n[2];
        let best = 127, bm = 0, pin = j <= bedNode;
        // the 8 cells around the node (ring coords: node i touches ring cells i and i + 1)
        for(let c = 0; c < 8; c++) {
            const ri = i + (c & 1), rj = j + ((c >> 1) & 1), rk = k + (c >> 2);
            const ci = ri + rj * MX + rk * MX * MY;
            const s = cmin[ci];
            if(s < best) { best = s; bm = cmat[ci]; }
            // a solid cell outside the zone holds the node in place
            if(border && s < 0 && (ri === 0 || rj === 0 || rk === 0 || ri === MX - 1 || rj === MY - 1 || rk === MZ - 1)) pin = true;
            if(s < 0 && cmat[ci] === 13) pin = true; // bedrock
            if(deep[ci]) pin = true;
        }
        flags[ni] |= (pin ? F_PINNED : 0) | (bm << 8);
    }
    return { cells, count, cellIdx, flags, solid };
}

/**
 * The plastic bake, pure: new_sdf(x) = old_sdf(x - u(x)) and the material advected the same way, over the samples
 * of a zone.
 *   region: { sdf, mat, lo: [sx, sy, sz], dims } samples around the zone (at least the zone plus the largest |u|)
 *   zone:   { s0: [sx, sy, sz] first sample of the node box (= spc * c0), n: cells per axis, u: Float32Array of
 *             node displacements (4 floats per node, i + j*NX + k*NX*NY), bedrockY, spc (samples per cell, default 2) }
 * Returns { lo: [sx,sy,sz], dims: [ex, ey, ez], sdf: Int8Array, mat: Uint8Array, changed } over the zone's sample box
 * (spc n + 1 samples per axis), to be written back into the world.
 */
export function bakeZone(region, zone) {
    const { sdf, mat, lo, dims } = region;
    const [rx, ry, rz] = dims, rxy = rx * ry;
    const { s0, n, u, bedrockY } = zone, spc = zone.spc || SPC;
    const NX = n[0] + 1, NY = n[1] + 1;
    const ex = spc * n[0] + 1, ey = spc * n[1] + 1, ez = spc * n[2] + 1;
    const out = new Int8Array(ex * ey * ez), omat = new Uint8Array(ex * ey * ez);
    const inv = 1 / 0.25; // samples per metre
    let changed = 0;
    const at = (x, y, z) => {
        x = x < 0 ? 0 : x > rx - 1 ? rx - 1 : x; y = y < 0 ? 0 : y > ry - 1 ? ry - 1 : y; z = z < 0 ? 0 : z > rz - 1 ? rz - 1 : z;
        return x + y * rx + z * rxy;
    };
    for(let k = 0; k < ez; k++) for(let j = 0; j < ey; j++) for(let i = 0; i < ex; i++) {
        const o = i + j * ex + k * ex * ey;
        const sx = s0[0] + i, sy = s0[1] + j, sz = s0[2] + k;
        const src = at(sx - lo[0], sy - lo[1], sz - lo[2]);
        // displacement at this sample: trilinear over the node lattice (spc samples per cell)
        const gi = Math.min(n[0] - 1, Math.floor(i / spc)), gj = Math.min(n[1] - 1, Math.floor(j / spc)), gk = Math.min(n[2] - 1, Math.floor(k / spc));
        const fx = i / spc - gi, fy = j / spc - gj, fz = k / spc - gk;
        let ux = 0, uy = 0, uz = 0;
        for(let c = 0; c < 8; c++) {
            const a = c & 1, b = (c >> 1) & 1, d = c >> 2;
            const w = (a ? fx : 1 - fx) * (b ? fy : 1 - fy) * (d ? fz : 1 - fz);
            if(w === 0) continue;
            const ni = ((gi + a) + (gj + b) * NX + (gk + d) * NX * NY) * 4;
            ux += u[ni] * w; uy += u[ni + 1] * w; uz += u[ni + 2] * w;
        }
        if(sy < bedrockY || (ux * ux + uy * uy + uz * uz) < 1e-6) { out[o] = sdf[src]; omat[o] = mat[src]; continue; }
        // sample the old field at x - u(x)
        const px = sx - ux * inv - lo[0], py = sy - uy * inv - lo[1], pz = sz - uz * inv - lo[2];
        const x0 = Math.floor(px), y0 = Math.floor(py), z0 = Math.floor(pz);
        const tx = px - x0, ty = py - y0, tz = pz - z0;
        let v = 0, best = -1, bw = -1;
        for(let c = 0; c < 8; c++) {
            const a = c & 1, b = (c >> 1) & 1, d = c >> 2;
            const w = (a ? tx : 1 - tx) * (b ? ty : 1 - ty) * (d ? tz : 1 - tz);
            const q = at(x0 + a, y0 + b, z0 + d);
            v += sdf[q] * w;
            // material: the heaviest solid corner (or the heaviest corner when none is solid)
            const score = w + (sdf[q] < 0 ? 2 : 0);
            if(score > bw) { bw = score; best = q; }
        }
        const s = Math.max(-127, Math.min(127, Math.round(v)));
        out[o] = s; omat[o] = s < 0 || sdf[src] < 0 ? mat[best] : mat[src];
        if(s !== sdf[src]) changed++;
    }
    return { lo: [s0[0], s0[1], s0[2]], dims: [ex, ey, ez], sdf: out, mat: omat, changed };
}
