/**
 * Surface Nets mesher for one chunk, with dual-contouring vertices and hard normals for built materials.
 * Pure function, safe to run in a worker.
 *
 * Input: a padded window (VoxelWorld.extractPadded) of (nx + 2*PAD) x (ny + 2*PAD) x (nz + 2*PAD) samples, index
 * x + y*Px + z*Px*Py, Int8 distances and Uint8 materials (a chunk is nx = ny = nz = CHUNK; a detached body's grid
 * can be any size). Samples in the outer PAD layer only feed normals and the cells straddling the border.
 *
 * Cells (the cubes between 8 samples) with a sign change get one vertex. Smooth materials (dirt, grass, sand...) put
 * it at the mean of the cell's edge crossings (classic Surface Nets) with a smooth gradient normal. Built materials
 * (`smooth: false` in materials.js: stone, brick, wood...) solve a small QEF over the crossings' planes (dual
 * contouring: the vertex lands on the corner or edge of a wall) clamped to the cell, and take hard normals: the face
 * normals of the triangles around the vertex, clustered by angle, so a wall's edge is crisp and a carved crater in
 * stone stays smoothly shaded. Every lattice edge with a sign change emits a quad joining the four cells around it.
 * A chunk emits the quads of the edges whose base sample it owns (local [0, n)), so chunks meet without seams.
 *
 * Material blending: a triangle whose cells have different materials carries the pair (A < B) on all three of its
 * vertices (`materials` = A, `materials2` = B) and `blend` = 1 at the vertices whose own material is B, 0 elsewhere,
 * so the material shader blends A to B across it without interpolating ids. Elsewhere materials2 = materials and
 * blend = 0. A vertex's own material is `blend > 0.5 ? materials2 : materials`.
 *
 * Output positions are in metres relative to the chunk's origin sample (local sample 0 at 0).
 */
import { VOXEL, PAD } from '../config.js';
import { MATERIALS } from './materials.js';

// cube corner offsets, bit i of the corner mask = corner i
const CORNERS = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
const EA = new Uint8Array(EDGES.map(e => e[0])), EB = new Uint8Array(EDGES.map(e => e[1]));
const CX = new Uint8Array(CORNERS.map(c => c[0])), CY = new Uint8Array(CORNERS.map(c => c[1])), CZ = new Uint8Array(CORNERS.map(c => c[2]));
/** 1 for materials meshed with crisp (dual contouring) edges */
const SHARP = new Uint8Array(256);
for(const m of MATERIALS) if(m && m.smooth === false) SHARP[m.id] = 1;
/** Samples this close to the surface (stored units) may carry the material of whatever the surface touches; a
 *  vertex reads its material one sample deeper instead. */
const SHALLOW = -4;
/** Hard normals: faces around a vertex closer than this angle share a normal. */
const CLUSTER_COS = Math.cos(35 * Math.PI / 180);
/** QEF regularisation towards the mass point (cell units). */
const QEF_REG = 0.04;
const AO_DIRS = [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

/**
 * @returns {{ positions: Float32Array, normals: Float32Array, materials: Uint8Array, materials2: Uint8Array,
 *             blend: Float32Array, ao: Float32Array, indices: Uint32Array }}
 */
export function surfaceNets(sdf, mat, nx, ny = nx, nz = nx, scale = VOXEL) {
    const P = nx + 2 * PAD, Py = ny + 2 * PAD, Pz = nz + 2 * PAD, P2 = P * Py;
    const cellVert = new Int32Array(P2 * Pz).fill(-1);
    const cornerOff = new Int32Array(CORNERS.map(([x, y, z]) => x + y * P + z * P2));
    const d = new Float32Array(8), g = new Float32Array(24), mg = new Float32Array(24);
    // per cell vertex (growable): position (cell units, padded), smooth normal, ao, material, sharp
    let cap = 4096, cn = 0;
    let cpos = new Float32Array(cap * 3), cnrm = new Float32Array(cap * 3), cao = new Float32Array(cap), cmat = new Uint8Array(cap), csharp = new Uint8Array(cap);
    const grow = () => {
        cap *= 2;
        const np = new Float32Array(cap * 3); np.set(cpos); cpos = np;
        const nn = new Float32Array(cap * 3); nn.set(cnrm); cnrm = nn;
        const na = new Float32Array(cap); na.set(cao); cao = na;
        const nm = new Uint8Array(cap); nm.set(cmat); cmat = nm;
        const ns = new Uint8Array(cap); ns.set(csharp); csharp = ns;
    };
    // cells with base padded coordinate in [PAD-1, PAD+n-1] (local -1..n-1), all the quads below touch
    const c0 = PAD - 1;
    for(let z = c0; z <= PAD + nz - 1; z++) for(let y = c0; y <= PAD + ny - 1; y++) for(let x = c0; x <= PAD + nx - 1; x++) {
        const base = x + y * P + z * P2;
        let mask = 0;
        for(let i = 0; i < 8; i++) { d[i] = sdf[base + cornerOff[i]]; if(d[i] < 0) mask |= 1 << i; }
        if(mask === 0 || mask === 255) continue;
        // material: that of the deepest solid corner on a sign-changing edge (a corner that touches the air; a buried
        // corner may hold a layer that never shows, like the grass under a wall), or one sample deeper still when that
        // corner sits right on the surface
        let best = 1e9, bs = 0;
        for(let e = 0; e < 12; e++) {
            const a = EA[e], b = EB[e];
            if((d[a] < 0) === (d[b] < 0)) continue;
            const i = d[a] < 0 ? a : b;
            if(d[i] < best) { best = d[i]; bs = base + cornerOff[i]; }
        }
        let m = mat[bs];
        if(best > SHALLOW) {
            let dd = best;
            for(const o of [1, -1, P, -P, P2, -P2]) { const q = bs + o; if(q >= 0 && q < sdf.length && sdf[q] < dd) { dd = sdf[q]; m = mat[q]; } }
        }
        const sharp = SHARP[m];
        // corner gradients (central differences)
        for(let i = 0; i < 8; i++) {
            const s = base + cornerOff[i];
            g[i * 3] = sdf[s + 1] - sdf[s - 1]; g[i * 3 + 1] = sdf[s + P] - sdf[s - P]; g[i * 3 + 2] = sdf[s + P2] - sdf[s - P2];
        }
        let sx = 0, sy = 0, sz = 0, cnt = 0;
        for(let e = 0; e < 12; e++) {
            const a = EA[e], b = EB[e], da = d[a], db = d[b];
            if((da < 0) === (db < 0)) continue;
            const t = da / (da - db);
            sx += CX[a] + (CX[b] - CX[a]) * t; sy += CY[a] + (CY[b] - CY[a]) * t; sz += CZ[a] + (CZ[b] - CZ[a]) * t;
            cnt++;
        }
        let fx = sx / cnt, fy = sy / cnt, fz = sz / cnt;
        if(sharp) {
            for(let i = 0; i < 8; i++) {
                const s = base + cornerOff[i], v = d[i];
                mg[i * 3] = minmod(sdf[s + 1] - v, v - sdf[s - 1]);
                mg[i * 3 + 1] = minmod(sdf[s + P] - v, v - sdf[s - P]);
                mg[i * 3 + 2] = minmod(sdf[s + P2] - v, v - sdf[s - P2]);
            }
            // dual contouring: minimise sum (n_i . (v - p_i))^2 + reg |v - mass|^2, relative to the mass point
            let a00 = QEF_REG, a01 = 0, a02 = 0, a11 = QEF_REG, a12 = 0, a22 = QEF_REG, b0 = 0, b1 = 0, b2 = 0;
            for(let e = 0; e < 12; e++) {
                const a = EA[e], b = EB[e], da = d[a], db = d[b];
                if((da < 0) === (db < 0)) continue;
                const t = da / (da - db);
                const px = CX[a] + (CX[b] - CX[a]) * t - fx, py = CY[a] + (CY[b] - CY[a]) * t - fy, pz = CZ[a] + (CZ[b] - CZ[a]) * t - fz;
                // the plane's normal: along the edge the exact difference; across it the minmod (one-sided difference
                // of smaller magnitude, 0 at a kink) at both ends, interpolated. Central differences smear a wall's
                // edge over two voxels; minmod keeps both faces of a corner flat and is exact for planes.
                const ax = e >> 2; // EDGES is ordered x edges, y edges, z edges
                let nx_ = ax === 0 ? db - da : mg[a * 3] + (mg[b * 3] - mg[a * 3]) * t;
                let ny_ = ax === 1 ? db - da : mg[a * 3 + 1] + (mg[b * 3 + 1] - mg[a * 3 + 1]) * t;
                let nz_ = ax === 2 ? db - da : mg[a * 3 + 2] + (mg[b * 3 + 2] - mg[a * 3 + 2]) * t;
                const l = Math.hypot(nx_, ny_, nz_);
                if(l < 1e-6) continue;
                nx_ /= l; ny_ /= l; nz_ /= l;
                a00 += nx_ * nx_; a01 += nx_ * ny_; a02 += nx_ * nz_; a11 += ny_ * ny_; a12 += ny_ * nz_; a22 += nz_ * nz_;
                const dp = nx_ * px + ny_ * py + nz_ * pz;
                b0 += nx_ * dp; b1 += ny_ * dp; b2 += nz_ * dp;
            }
            // symmetric 3x3 solve (Cramer)
            const c00 = a11 * a22 - a12 * a12, c01 = a02 * a12 - a01 * a22, c02 = a01 * a12 - a02 * a11;
            const det = a00 * c00 + a01 * c01 + a02 * c02;
            if(Math.abs(det) > 1e-9) {
                const c11 = a00 * a22 - a02 * a02, c12 = a01 * a02 - a00 * a12, c22 = a00 * a11 - a01 * a01;
                const vx = (c00 * b0 + c01 * b1 + c02 * b2) / det, vy = (c01 * b0 + c11 * b1 + c12 * b2) / det, vz = (c02 * b0 + c12 * b1 + c22 * b2) / det;
                fx = Math.min(1, Math.max(0, fx + vx)); fy = Math.min(1, Math.max(0, fy + vy)); fz = Math.min(1, Math.max(0, fz + vz));
            }
        }
        // smooth normal: trilinear blend of the corners' gradients
        let gx = 0, gy = 0, gz = 0;
        for(let i = 0; i < 8; i++) {
            const w = (CX[i] ? fx : 1 - fx) * (CY[i] ? fy : 1 - fy) * (CZ[i] ? fz : 1 - fz);
            gx += w * g[i * 3]; gy += w * g[i * 3 + 1]; gz += w * g[i * 3 + 2];
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
        if(cn === cap) grow();
        cellVert[base] = cn;
        cpos[cn * 3] = x - PAD + fx; cpos[cn * 3 + 1] = y - PAD + fy; cpos[cn * 3 + 2] = z - PAD + fz;
        cnrm[cn * 3] = gx; cnrm[cn * 3 + 1] = gy; cnrm[cn * 3 + 2] = gz;
        cao[cn] = tot ? 1 - occ / tot : 1;
        cmat[cn] = m;
        csharp[cn] = sharp;
        cn++;
    }

    // output vertices: one per (cell vertex, material pair, blend side, normal cluster), linked per cell
    const head = new Int32Array(cn).fill(-1);
    let ocap = Math.max(1024, cn * 2), on = 0;
    let oNext = new Int32Array(ocap), oCell = new Int32Array(ocap), oA = new Uint8Array(ocap), oB = new Uint8Array(ocap), oW = new Uint8Array(ocap), oN = new Float32Array(ocap * 3);
    const ogrow = () => {
        ocap *= 2;
        const r = (A, C) => { const n = new C(ocap * (A.length / (ocap / 2))); n.set(A); return n; };
        oNext = r(oNext, Int32Array); oCell = r(oCell, Int32Array); oA = r(oA, Uint8Array); oB = r(oB, Uint8Array); oW = r(oW, Uint8Array); oN = r(oN, Float32Array);
    };
    const idx = [];
    let fnx = 0, fny = 0, fnz = 0, fl = 0; // the current triangle's face normal (area weighted) and its length
    const vertexFor = (c, A, B) => {
        const w = cmat[c] === B && A !== B ? 1 : 0;
        const sharp = csharp[c];
        for(let o = head[c]; o >= 0; o = oNext[o]) {
            if(oA[o] !== A || oB[o] !== B || oW[o] !== w) continue;
            if(sharp && fl > 0) {
                const ax = oN[o * 3], ay = oN[o * 3 + 1], az = oN[o * 3 + 2], al = Math.hypot(ax, ay, az);
                if(al > 0 && (ax * fnx + ay * fny + az * fnz) < CLUSTER_COS * al * fl) continue;
                oN[o * 3] += fnx; oN[o * 3 + 1] += fny; oN[o * 3 + 2] += fnz;
            }
            return o;
        }
        if(on === ocap) ogrow();
        const o = on++;
        oNext[o] = head[c]; head[c] = o; oCell[o] = c; oA[o] = A; oB[o] = B; oW[o] = w;
        oN[o * 3] = sharp ? fnx : 0; oN[o * 3 + 1] = sharp ? fny : 0; oN[o * 3 + 2] = sharp ? fnz : 0;
        return o;
    };
    const tri = (i, j, k) => {
        const ix = cpos[i * 3], iy = cpos[i * 3 + 1], iz = cpos[i * 3 + 2];
        const ux = cpos[j * 3] - ix, uy = cpos[j * 3 + 1] - iy, uz = cpos[j * 3 + 2] - iz;
        const vx = cpos[k * 3] - ix, vy = cpos[k * 3 + 1] - iy, vz = cpos[k * 3 + 2] - iz;
        fnx = uy * vz - uz * vy; fny = uz * vx - ux * vz; fnz = ux * vy - uy * vx;
        fl = Math.hypot(fnx, fny, fnz);
        const mi = cmat[i], mj = cmat[j], mk = cmat[k];
        let A = mi, B = mi;
        if(mj !== mi) B = mj; else if(mk !== mi) B = mk;
        if(A > B) { const t = A; A = B; B = t; }
        idx.push(vertexFor(i, A, B), vertexFor(j, A, B), vertexFor(k, A, B));
    };
    // normal of triangle (i, j, k) dotted with that of (i, k, l): how flat the quad split is
    const flatness = (a, b, c, e) => {
        const n1 = triN(cpos, a, b, c), n1x = TN[0], n1y = TN[1], n1z = TN[2];
        const n2 = triN(cpos, a, c, e);
        return n1 > 0 && n2 > 0 ? (n1x * TN[0] + n1y * TN[1] + n1z * TN[2]) / (n1 * n2) : -1;
    };
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
            let v00 = cellVert[s - du - dv], v10 = cellVert[s - dv], v11 = cellVert[s], v01 = cellVert[s - du];
            if(v00 < 0 || v10 < 0 || v11 < 0 || v01 < 0) continue;
            if(!inside) { const t = v10; v10 = v01; v01 = t; } // wind the quad (v00, v10, v11, v01) outwards
            // split: sharp quads along the diagonal that keeps the two triangles flattest (crisp edges), others
            // along the shorter diagonal
            let diag00;
            if(csharp[v00] | csharp[v10] | csharp[v11] | csharp[v01]) diag00 = flatness(v00, v10, v11, v01) >= flatness(v10, v11, v01, v00);
            else diag00 = dist2(cpos, v00, v11) <= dist2(cpos, v10, v01);
            if(diag00) { tri(v00, v10, v11); tri(v00, v11, v01); }
            else { tri(v00, v10, v01); tri(v10, v11, v01); }
        }
    }

    const positions = new Float32Array(on * 3), normals = new Float32Array(on * 3), ao = new Float32Array(on);
    const materials = new Uint8Array(on), materials2 = new Uint8Array(on), blend = new Float32Array(on);
    for(let o = 0; o < on; o++) {
        const c = oCell[o];
        positions[o * 3] = cpos[c * 3] * scale; positions[o * 3 + 1] = cpos[c * 3 + 1] * scale; positions[o * 3 + 2] = cpos[c * 3 + 2] * scale;
        let x = cnrm[c * 3], y = cnrm[c * 3 + 1], z = cnrm[c * 3 + 2];
        if(csharp[c]) {
            const ax = oN[o * 3], ay = oN[o * 3 + 1], az = oN[o * 3 + 2], l = Math.hypot(ax, ay, az);
            if(l > 0) { x = ax / l; y = ay / l; z = az / l; }
        }
        normals[o * 3] = x; normals[o * 3 + 1] = y; normals[o * 3 + 2] = z;
        ao[o] = cao[c];
        materials[o] = oA[o]; materials2[o] = oB[o]; blend[o] = oW[o];
    }
    return { positions, normals, materials, materials2, blend, ao, indices: new Uint32Array(idx) };
}
const minmod = (a, b) => a * b <= 0 ? 0 : (Math.abs(a) < Math.abs(b) ? a : b);
const TN = new Float32Array(3);
function triN(p, i, j, k) {
    const ix = p[i * 3], iy = p[i * 3 + 1], iz = p[i * 3 + 2];
    const ux = p[j * 3] - ix, uy = p[j * 3 + 1] - iy, uz = p[j * 3 + 2] - iz;
    const vx = p[k * 3] - ix, vy = p[k * 3 + 1] - iy, vz = p[k * 3 + 2] - iz;
    TN[0] = uy * vz - uz * vy; TN[1] = uz * vx - ux * vz; TN[2] = ux * vy - uy * vx;
    return Math.hypot(TN[0], TN[1], TN[2]);
}
function dist2(p, a, b) { const x = p[a * 3] - p[b * 3], y = p[a * 3 + 1] - p[b * 3 + 1], z = p[a * 3 + 2] - p[b * 3 + 2]; return x * x + y * y + z * z; }
