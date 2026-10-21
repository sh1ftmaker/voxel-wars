/**
 * Soft layer of a detached voxel body: a body-local tetrahedral lattice (cells of `cs` samples, 5 tets per cell as in
 * src/soft/core.js / dmm-js), simulated by per-tet shape matching (Jacobi, as dmm-js) relative to the rigid body.
 * Pure: runs in src/workers/softBody.js and in node (tools/test/softbody.mjs). No DOM, no three.js.
 *
 * Frames: everything is in the body's grid-local metres (sample i at i * VOXEL). The lattice's node (0, 0, 0) is at
 * sample -1 (the mesher's padding ring), node (I, J, K) at sample -1 + cs * (I, J, K). A node's state is its
 * displacement u from that rest point and its velocity v; Rapier owns the rigid motion, so after every substep the
 * lattice's mean translation, mean velocity and best-fit rotation are removed (the soft layer carries only bending,
 * squash and wobble).
 *
 * Inputs: kicks. 'impact' { p, dv, r }: the body's velocity changed by dv at contact point p; matter near p went
 * along with it, matter far from p lags behind (relative velocity -dv, ramping up over r metres): tall pieces sway,
 * long ones bend. 'blast' { c, s, r }: matter nearer the blast is pushed harder, outward. Both scaled by the
 * material's `gain`.
 *
 * Fracture (DMM-style, on the lattice): every substep each tet's strain |F - R| (deformation gradient minus its
 * rotation) is measured; a face between two solid cells breaks when the larger strain of the two cells exceeds the
 * material's toughness (divided by the body's current `frag`ility, raised by hard impacts, and lowered next to an
 * already broken face of the same plane: crack tips propagate). Broken faces damage their cells (softer, so strain
 * concentrates along the crack). When the broken faces cut the solid cells into several components the body reports
 * a split: one label per cell (cellSampleLabels turns it into per-sample labels for islands.splitGrid).
 */
import { VOXEL } from '../config.js';

const PAD = 2;

// Corners: 0=(000) 1=(100) 2=(110) 3=(010) 4=(001) 5=(101) 6=(111) 7=(011); 5 tets per cube, mirrored on odd cells
const CUBE = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
const TETS = [
    [[0, 1, 3, 4], [2, 3, 1, 6], [5, 4, 6, 1], [7, 6, 4, 3], [1, 3, 4, 6]],
    [[1, 0, 2, 5], [3, 2, 0, 7], [4, 5, 7, 0], [6, 7, 5, 2], [0, 2, 5, 7]],
];
/** Per tet type (parity * 5 + l): corner offsets relative to corner 0 (unit cell), Dm^-1 (row-major), rest centroid. */
const TYPE = [];
for(let p = 0; p < 2; p++) for(let l = 0; l < 5; l++) {
    const c = TETS[p][l].map(i => CUBE[i]);
    const off = c.map(o => [o[0] - c[0][0], o[1] - c[0][1], o[2] - c[0][2]]);
    // Dm columns: off1, off2, off3
    const m = [off[1][0], off[2][0], off[3][0], off[1][1], off[2][1], off[3][1], off[1][2], off[2][2], off[3][2]];
    TYPE.push({ corners: TETS[p][l], off, inv: inv3(m), cen: [0, 1, 2].map(a => (off[1][a] + off[2][a] + off[3][a]) / 4) });
}
/** TYPE flattened for the solver: per type 12 offsets (minus the centroid), 9 Dm^-1, 12 offsets. */
const TF = new Float64Array(10 * 33);
TYPE.forEach((T, i) => {
    const o = i * 33;
    for(let j = 0; j < 4; j++) for(let a = 0; a < 3; a++) { TF[o + j * 3 + a] = T.off[j][a] - T.cen[a]; TF[o + 21 + j * 3 + a] = T.off[j][a]; }
    for(let k = 0; k < 9; k++) TF[o + 12 + k] = T.inv[k];
});
function inv3(m) {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    const s = 1 / det;
    return [A * s, -(b * i - c * h) * s, (b * f - c * e) * s, B * s, (a * i - c * g) * s, -(a * f - c * d) * s, C * s, -(a * h - b * g) * s, (a * e - b * d) * s];
}

/** Debris response per material id (the soft ground's table in materials.js is tuned for a 240 Hz ground solver).
 *  stiffness: shape matching pull per iteration; damping 1/s; gain on impact kicks; tough: strain at which faces break. */
export const DEBRIS_SOFT = [];
const ds = (ids, v) => { for(const i of ids) DEBRIS_SOFT[i] = v; };
ds([1, 2], { stiffness: 0.3, damping: 1.8, gain: 2.0, tough: 0.2 });     // dirt, grass
ds([3, 4], { stiffness: 0.22, damping: 2.4, gain: 2.12, tough: 0.16 });   // sand, snow
ds([0, 8, 9, 12], { stiffness: 0.6, damping: 1.4, gain: 1.62, tough: 0.12 }); // stones: stiff, brittle
ds([5, 11], { stiffness: 0.55, damping: 1.5, gain: 1.69, tough: 0.11 }); // brick, cobble: mortar joints crack
ds([6], { stiffness: 0.8, damping: 1.0, gain: 1.0, tough: 0.6 });        // metal: rings, hardly breaks
ds([7], { stiffness: 0.2, damping: 3, gain: 2.25, tough: 0.4 });          // lava
ds([10], { stiffness: 0.4, damping: 1.4, gain: 1.88, tough: 0.25 });      // wood: flexes
ds([13], { stiffness: 0.9, damping: 3, gain: 0.3, tough: 1e9 });         // bedrock
for(let i = 0; i < 256; i++) DEBRIS_SOFT[i] ||= DEBRIS_SOFT[1];

export const NODE_CAP = 1024;   // nodes per body (the render atlas reserves this many texels per slot)
export const CELL_CAP = 360;    // solid cells per body (x5 tets)
const CS_STEPS = [2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32];

/** Lattice layout for a grid of nx * ny * nz samples: { cs, h (m), dims: cells per axis, nodes: node dims, origin (m) }. */
export function latticeLayout(nx, ny, nz, minCs = 2) {
    for(const cs of CS_STEPS) {
        if(cs < minCs) continue;
        const dims = [Math.ceil((nx + 1) / cs), Math.ceil((ny + 1) / cs), Math.ceil((nz + 1) / cs)];
        const nodes = dims.map(d => d + 1);
        if(nodes[0] * nodes[1] * nodes[2] <= NODE_CAP) return { cs, h: cs * VOXEL, dims, nodes, origin: [-VOXEL, -VOXEL, -VOXEL] };
    }
    return null;
}

/**
 * Build a body's lattice from its grid (islands.js Grid: padded Int8 sdf, Uint8 mat).
 * Returns null when the body is too big for the caps or has no solid cell.
 */
export function buildLattice(grid) {
    const { nx, ny, nz, sdf, mat } = grid;
    let L = latticeLayout(nx, ny, nz);
    let built = null;
    while(L) {
        built = classify(grid, L);
        if(built && built.ncell <= CELL_CAP) break;
        L = latticeLayout(nx, ny, nz, L.cs + 1);
        built = null;
    }
    if(!built || !built.ncell) return null;
    return built;

    function classify(g, L) {
        const { cs, dims, nodes } = L;
        const P = nx + 2 * PAD, PP = P * (ny + 2 * PAD);
        const [CX, CY, CZ] = dims, CXY = CX * CY;
        // per cell: solid samples in its closed sample range [-1 + cs*I, -1 + cs*(I+1)], and the dominant material
        const cellOf = new Int32Array(CX * CY * CZ).fill(-1);
        const cellMat = [];
        const cellList = [];
        for(let K = 0; K < CZ; K++) for(let J = 0; J < CY; J++) for(let I = 0; I < CX; I++) {
            const x0 = -1 + cs * I, y0 = -1 + cs * J, z0 = -1 + cs * K;
            let n = 0; const hist = new Map();
            for(let z = Math.max(0, z0); z <= Math.min(nz - 1, z0 + cs); z++) for(let y = Math.max(0, y0); y <= Math.min(ny - 1, y0 + cs); y++) {
                let i = Math.max(0, x0) + PAD + (y + PAD) * P + (z + PAD) * PP;
                for(let x = Math.max(0, x0); x <= Math.min(nx - 1, x0 + cs); x++, i++) if(sdf[i] < 0) { n++; hist.set(mat[i], (hist.get(mat[i]) || 0) + 1); }
            }
            if(!n) continue;
            let bm = 1, bc = -1; for(const [m, c] of hist) if(c > bc) { bc = c; bm = m; }
            cellOf[I + J * CX + K * CXY] = cellList.length;
            cellList.push(I | (J << 10) | (K << 20));
            cellMat.push(bm);
            if(cellList.length > CELL_CAP) return { ncell: cellList.length };
        }
        const ncell = cellList.length;
        const [NX, NY, NZ] = nodes, NXY = NX * NY;
        const nn = NX * NY * NZ;
        const active = new Uint8Array(nn);
        const tetN = new Int32Array(ncell * 20), tetT = new Uint8Array(ncell * 5);
        for(let c = 0; c < ncell; c++) {
            const pk = cellList[c], I = pk & 1023, J = (pk >> 10) & 1023, K = pk >> 20;
            const par = (I + J + K) & 1;
            for(let l = 0; l < 5; l++) {
                const t = c * 5 + l;
                tetT[t] = par * 5 + l;
                const corners = TETS[par][l];
                for(let k = 0; k < 4; k++) {
                    const o = CUBE[corners[k]];
                    const ni = (I + o[0]) + (J + o[1]) * NX + (K + o[2]) * NXY;
                    tetN[t * 4 + k] = ni; active[ni] = 1;
                }
            }
        }
        // faces between solid cells: [cellA, cellB, axis]
        const faces = [];
        for(let c = 0; c < ncell; c++) {
            const pk = cellList[c], I = pk & 1023, J = (pk >> 10) & 1023, K = pk >> 20;
            if(I + 1 < CX) { const o = cellOf[I + 1 + J * CX + K * CXY]; if(o >= 0) faces.push(c, o, 0); }
            if(J + 1 < CY) { const o = cellOf[I + (J + 1) * CX + K * CXY]; if(o >= 0) faces.push(c, o, 1); }
            if(K + 1 < CZ) { const o = cellOf[I + J * CX + (K + 1) * CXY]; if(o >= 0) faces.push(c, o, 2); }
        }
        const faceAt = new Int32Array(ncell * 3).fill(-1); // the face to the +axis neighbour, per cell and axis
        for(let f = 0; f < faces.length; f += 3) faceAt[faces[f] * 3 + faces[f + 2]] = f / 3;
        const nact = active.reduce((a, b) => a + b, 0);
        const actList = new Int32Array(nact);
        for(let i = 0, k = 0; i < nn; i++) if(active[i]) actList[k++] = i;
        return {
            ...L, ncell, cellOf, cells: Int32Array.from(cellList), cellMat: Uint8Array.from(cellMat),
            tetN, tetT, faces: Int32Array.from(faces), faceAt, broken: new Uint8Array(faces.length / 3),
            actList, active, nn,
        };
    }
}

/** A simulated body: the lattice plus state. */
export class SoftLattice {
    constructor(lat) {
        Object.assign(this, lat);
        const nn = this.nn, nt = this.ncell * 5;
        this.u = new Float32Array(nn * 3);
        this.v = new Float32Array(nn * 3);
        this.u0 = new Float32Array(nn * 3);
        this.acc = new Float32Array(nn * 3);
        this.q = new Float32Array(nt * 4); for(let t = 0; t < nt; t++) this.q[t * 4 + 3] = 1;
        this.strain = new Float32Array(this.ncell);   // max tet strain per cell, this substep
        this.damage = new Float32Array(this.ncell);   // 0..1: broken faces soften their cells
        this.rq = [0, 0, 0, 1];                       // best-fit rotation (warm start)
        this.frag = 1;                                // fragility: > 1 after a hard impact, decays
        this.calm = 0;                                // seconds below the sleep thresholds
        this.asleep = true;
        this.maxU = 0; this.maxStrain = 0;
        const S = this.stiff = new Float32Array(this.ncell), D = this.damp = new Float32Array(this.ncell);
        let gain = 0, tough = 0;
        for(let c = 0; c < this.ncell; c++) { const m = DEBRIS_SOFT[this.cellMat[c]]; S[c] = m.stiffness; D[c] = m.damping; gain += m.gain; tough += m.tough; }
        this.gain = gain / this.ncell; this.tough = tough / this.ncell;
        // per node damping (mean of its cells): from the cells' tets
        this.ndamp = new Float32Array(nn);
        const cnt = new Float32Array(nn);
        for(let t = 0; t < nt; t++) { const c = (t / 5) | 0; for(let k = 0; k < 4; k++) { const n = this.tetN[t * 4 + k]; this.ndamp[n] += D[c]; cnt[n]++; } }
        for(let i = 0; i < nn; i++) if(cnt[i]) this.ndamp[i] /= cnt[i];
        this.cnt = cnt;
        const [NX, NY] = this.nodes;
        this.rest = new Float32Array(nn * 3);
        for(let i = 0; i < nn; i++) {
            const x = i % NX, y = ((i / NX) | 0) % NY, z = (i / (NX * NY)) | 0;
            this.rest[i * 3] = this.origin[0] + x * this.h; this.rest[i * 3 + 1] = this.origin[1] + y * this.h; this.rest[i * 3 + 2] = this.origin[2] + z * this.h;
        }
        let cx = 0, cy = 0, cz = 0;
        for(const i of this.actList) { cx += this.rest[i * 3]; cy += this.rest[i * 3 + 1]; cz += this.rest[i * 3 + 2]; }
        const na = this.actList.length;
        this.restC = [cx / na, cy / na, cz / na];
        let r2 = 0;
        for(const i of this.actList) r2 = Math.max(r2, (this.rest[i * 3] - this.restC[0]) ** 2 + (this.rest[i * 3 + 1] - this.restC[1]) ** 2 + (this.rest[i * 3 + 2] - this.restC[2]) ** 2);
        this.radius = Math.sqrt(r2);
    }

    /** Velocity kick (see the header). */
    kick(k) {
        const { u, v, rest, actList } = this;
        const g = this.gain;
        this.asleep = false; this.calm = 0;
        if(k.frag) this.frag = Math.max(this.frag, k.frag);
        if(k.type === 'impact') {
            const R = Math.max(this.h, k.r || this.radius * 1.2);
            for(const i of actList) {
                const dx = rest[i * 3] + u[i * 3] - k.p[0], dy = rest[i * 3 + 1] + u[i * 3 + 1] - k.p[1], dz = rest[i * 3 + 2] + u[i * 3 + 2] - k.p[2];
                const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
                const w = Math.min(1, d / R) * g;
                v[i * 3] -= k.dv[0] * w; v[i * 3 + 1] -= k.dv[1] * w; v[i * 3 + 2] -= k.dv[2] * w;
            }
        } else if(k.type === 'blast') {
            const R = Math.max(this.h, k.r);
            for(const i of actList) {
                const dx = rest[i * 3] + u[i * 3] - k.c[0], dy = rest[i * 3 + 1] + u[i * 3 + 1] - k.c[1], dz = rest[i * 3 + 2] + u[i * 3 + 2] - k.c[2];
                const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
                const w = Math.max(0, 1 - d / R) * k.s * g / d;
                v[i * 3] += dx * w; v[i * 3 + 1] += dy * w; v[i * 3 + 2] += dz * w;
            }
        }
    }

    /**
     * One substep of `dt` seconds with `iters` Jacobi iterations. Returns true when faces broke this substep (call
     * components() to see whether the body came apart).
     */
    step(dt, iters = 3) {
        const { u, v, u0, acc, cnt, actList, tetN, tetT, q, h, strain, stiff, damage, ndamp } = this;
        const MAXV = 8, MAXU = Math.min(0.6, h * 0.9);
        for(const i of actList) {
            const f = Math.exp(-ndamp[i] * dt);
            for(let a = 0; a < 3; a++) {
                const j = i * 3 + a;
                let vv = v[j] * f;
                vv = vv > MAXV ? MAXV : vv < -MAXV ? -MAXV : vv;
                v[j] = vv; u0[j] = u[j]; u[j] += vv * dt;
            }
        }
        const nt = this.ncell * 5, ih = 1 / h;
        let maxS = 0;
        for(let it = 0; it < iters; it++) {
            const last = it === iters - 1;
            if(last) strain.fill(0);
            for(const i of actList) { acc[i * 3] = acc[i * 3 + 1] = acc[i * 3 + 2] = 0; }
            for(let t = 0; t < nt; t++) {
                const c = (t / 5) | 0, o = tetT[t] * 33;
                const t4 = t * 4, n0 = tetN[t4] * 3, n1 = tetN[t4 + 1] * 3, n2 = tetN[t4 + 2] * 3, n3 = tetN[t4 + 3] * 3;
                // positions relative to corner 0's rest point (unit offsets * h + u)
                const p0x = u[n0], p0y = u[n0 + 1], p0z = u[n0 + 2];
                const p1x = TF[o + 24] * h + u[n1], p1y = TF[o + 25] * h + u[n1 + 1], p1z = TF[o + 26] * h + u[n1 + 2];
                const p2x = TF[o + 27] * h + u[n2], p2y = TF[o + 28] * h + u[n2 + 1], p2z = TF[o + 29] * h + u[n2 + 2];
                const p3x = TF[o + 30] * h + u[n3], p3y = TF[o + 31] * h + u[n3 + 1], p3z = TF[o + 32] * h + u[n3 + 2];
                // F = Ds Dm^-1 (Dm = unit offsets * h)
                const d1x = (p1x - p0x) * ih, d1y = (p1y - p0y) * ih, d1z = (p1z - p0z) * ih;
                const d2x = (p2x - p0x) * ih, d2y = (p2y - p0y) * ih, d2z = (p2z - p0z) * ih;
                const d3x = (p3x - p0x) * ih, d3y = (p3y - p0y) * ih, d3z = (p3z - p0z) * ih;
                const m0 = TF[o + 12], m1 = TF[o + 13], m2 = TF[o + 14], m3 = TF[o + 15], m4 = TF[o + 16], m5 = TF[o + 17], m6 = TF[o + 18], m7 = TF[o + 19], m8 = TF[o + 20];
                const F00 = d1x * m0 + d2x * m3 + d3x * m6, F01 = d1x * m1 + d2x * m4 + d3x * m7, F02 = d1x * m2 + d2x * m5 + d3x * m8;
                const F10 = d1y * m0 + d2y * m3 + d3y * m6, F11 = d1y * m1 + d2y * m4 + d3y * m7, F12 = d1y * m2 + d2y * m5 + d3y * m8;
                const F20 = d1z * m0 + d2z * m3 + d3z * m6, F21 = d1z * m1 + d2z * m4 + d3z * m7, F22 = d1z * m2 + d2z * m5 + d3z * m8;
                // rotation of F (Müller et al. 2016), warm started: one small-angle step per iteration
                let qx = q[t4], qy = q[t4 + 1], qz = q[t4 + 2], qw = q[t4 + 3];
                let R00 = 1 - 2 * (qy * qy + qz * qz), R01 = 2 * (qx * qy - qz * qw), R02 = 2 * (qx * qz + qy * qw);
                let R10 = 2 * (qx * qy + qz * qw), R11 = 1 - 2 * (qx * qx + qz * qz), R12 = 2 * (qy * qz - qx * qw);
                let R20 = 2 * (qx * qz - qy * qw), R21 = 2 * (qy * qz + qx * qw), R22 = 1 - 2 * (qx * qx + qy * qy);
                const ox = (R10 * F20 - R20 * F10) + (R11 * F21 - R21 * F11) + (R12 * F22 - R22 * F12);
                const oy = (R20 * F00 - R00 * F20) + (R21 * F01 - R01 * F21) + (R22 * F02 - R02 * F22);
                const oz = (R00 * F10 - R10 * F00) + (R01 * F11 - R11 * F01) + (R02 * F12 - R12 * F02);
                const den = 0.5 / (Math.abs(R00 * F00 + R10 * F10 + R20 * F20 + R01 * F01 + R11 * F11 + R21 * F21 + R02 * F02 + R12 * F12 + R22 * F22) + 1e-9);
                const ax = ox * den, ay = oy * den, az = oz * den;
                if(ax * ax + ay * ay + az * az > 1e-14) {
                    // q = normalize((a, 1) * q)
                    const nx = qx + ax * qw + ay * qz - az * qy, ny = qy - ax * qz + ay * qw + az * qx;
                    const nz = qz + ax * qy - ay * qx + az * qw, nw = qw - ax * qx - ay * qy - az * qz;
                    const l = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz + nw * nw);
                    qx = nx * l; qy = ny * l; qz = nz * l; qw = nw * l;
                    q[t4] = qx; q[t4 + 1] = qy; q[t4 + 2] = qz; q[t4 + 3] = qw;
                    R00 = 1 - 2 * (qy * qy + qz * qz); R01 = 2 * (qx * qy - qz * qw); R02 = 2 * (qx * qz + qy * qw);
                    R10 = 2 * (qx * qy + qz * qw); R11 = 1 - 2 * (qx * qx + qz * qz); R12 = 2 * (qy * qz - qx * qw);
                    R20 = 2 * (qx * qz - qy * qw); R21 = 2 * (qy * qz + qx * qw); R22 = 1 - 2 * (qx * qx + qy * qy);
                }
                if(last) {
                    const e00 = F00 - R00, e01 = F01 - R01, e02 = F02 - R02, e10 = F10 - R10, e11 = F11 - R11, e12 = F12 - R12, e20 = F20 - R20, e21 = F21 - R21, e22 = F22 - R22;
                    const e = Math.sqrt(e00 * e00 + e01 * e01 + e02 * e02 + e10 * e10 + e11 * e11 + e12 * e12 + e20 * e20 + e21 * e21 + e22 * e22);
                    if(e > strain[c]) strain[c] = e;
                    if(e > maxS) maxS = e;
                }
                // goals: centroid + R (rest offset - rest centroid); corrections scaled by the cell's stiffness
                const cx = (p0x + p1x + p2x + p3x) * 0.25, cy = (p0y + p1y + p2y + p3y) * 0.25, cz = (p0z + p1z + p2z + p3z) * 0.25;
                const k = stiff[c] * (1 - 0.85 * damage[c]);
                let rx = TF[o] * h, ry = TF[o + 1] * h, rz = TF[o + 2] * h;
                acc[n0] += (cx + R00 * rx + R01 * ry + R02 * rz - p0x) * k; acc[n0 + 1] += (cy + R10 * rx + R11 * ry + R12 * rz - p0y) * k; acc[n0 + 2] += (cz + R20 * rx + R21 * ry + R22 * rz - p0z) * k;
                rx = TF[o + 3] * h; ry = TF[o + 4] * h; rz = TF[o + 5] * h;
                acc[n1] += (cx + R00 * rx + R01 * ry + R02 * rz - p1x) * k; acc[n1 + 1] += (cy + R10 * rx + R11 * ry + R12 * rz - p1y) * k; acc[n1 + 2] += (cz + R20 * rx + R21 * ry + R22 * rz - p1z) * k;
                rx = TF[o + 6] * h; ry = TF[o + 7] * h; rz = TF[o + 8] * h;
                acc[n2] += (cx + R00 * rx + R01 * ry + R02 * rz - p2x) * k; acc[n2 + 1] += (cy + R10 * rx + R11 * ry + R12 * rz - p2y) * k; acc[n2 + 2] += (cz + R20 * rx + R21 * ry + R22 * rz - p2z) * k;
                rx = TF[o + 9] * h; ry = TF[o + 10] * h; rz = TF[o + 11] * h;
                acc[n3] += (cx + R00 * rx + R01 * ry + R02 * rz - p3x) * k; acc[n3 + 1] += (cy + R10 * rx + R11 * ry + R12 * rz - p3y) * k; acc[n3 + 2] += (cz + R20 * rx + R21 * ry + R22 * rz - p3z) * k;
            }
            // Jacobi: each node moves by the mean of its tets' corrections (x 4: corrections are per tet, a node
            // sits in up to 20 tets; the mean alone converges too slowly at 60 Hz)
            for(const i of actList) {
                const s = 2.5 / cnt[i];
                u[i * 3] += acc[i * 3] * s; u[i * 3 + 1] += acc[i * 3 + 1] * s; u[i * 3 + 2] += acc[i * 3 + 2] * s;
            }
        }
        // velocities, then remove the rigid part (the rigid body carries it)
        const idt = 1 / dt;
        for(const i of actList) for(let a = 0; a < 3; a++) { const j = i * 3 + a; v[j] = (u[j] - u0[j]) * idt; }
        this.removeRigid();
        let mu = 0, mv = 0;
        for(const i of actList) {
            for(let a = 0; a < 3; a++) {
                const j = i * 3 + a;
                if(u[j] > MAXU) u[j] = MAXU; else if(u[j] < -MAXU) u[j] = -MAXU;
                const au = Math.abs(u[j]), av = Math.abs(v[j]);
                if(au > mu) mu = au; if(av > mv) mv = av;
            }
        }
        this.maxU = mu; this.maxV = mv; this.maxStrain = maxS;
        this.frag = 1 + (this.frag - 1) * Math.exp(-dt / 0.25);
        if(mu < 0.004 && mv < 0.03) { this.calm += dt; if(this.calm > 0.25) this.sleep(); } else this.calm = 0;
        return this.fracture();
    }

    /** Remove the lattice's mean translation, mean velocity and best-fit rotation. */
    removeRigid() {
        const { u, v, rest, actList, restC } = this;
        const na = actList.length;
        let cx = 0, cy = 0, cz = 0, vx = 0, vy = 0, vz = 0;
        for(const i of actList) { cx += u[i * 3]; cy += u[i * 3 + 1]; cz += u[i * 3 + 2]; vx += v[i * 3]; vy += v[i * 3 + 1]; vz += v[i * 3 + 2]; }
        cx /= na; cy /= na; cz /= na; vx /= na; vy /= na; vz /= na;
        // A = sum (p - c)(r - rc)^T, p = r + u
        let a00 = 0, a01 = 0, a02 = 0, a10 = 0, a11 = 0, a12 = 0, a20 = 0, a21 = 0, a22 = 0;
        for(const i of actList) {
            const rx = rest[i * 3] - restC[0], ry = rest[i * 3 + 1] - restC[1], rz = rest[i * 3 + 2] - restC[2];
            const px = rx + u[i * 3] - cx, py = ry + u[i * 3 + 1] - cy, pz = rz + u[i * 3 + 2] - cz;
            a00 += px * rx; a01 += px * ry; a02 += px * rz; a10 += py * rx; a11 += py * ry; a12 += py * rz; a20 += pz * rx; a21 += pz * ry; a22 += pz * rz;
        }
        let [qx, qy, qz, qw] = this.rq;
        let R00, R01, R02, R10, R11, R12, R20, R21, R22;
        for(let r = 0; r < 4; r++) {
            R00 = 1 - 2 * (qy * qy + qz * qz); R01 = 2 * (qx * qy - qz * qw); R02 = 2 * (qx * qz + qy * qw);
            R10 = 2 * (qx * qy + qz * qw); R11 = 1 - 2 * (qx * qx + qz * qz); R12 = 2 * (qy * qz - qx * qw);
            R20 = 2 * (qx * qz - qy * qw); R21 = 2 * (qy * qz + qx * qw); R22 = 1 - 2 * (qx * qx + qy * qy);
            const ox = (R10 * a20 - R20 * a10) + (R11 * a21 - R21 * a11) + (R12 * a22 - R22 * a12);
            const oy = (R20 * a00 - R00 * a20) + (R21 * a01 - R01 * a21) + (R22 * a02 - R02 * a22);
            const oz = (R00 * a10 - R10 * a00) + (R01 * a11 - R11 * a01) + (R02 * a12 - R12 * a02);
            const den = Math.abs(R00 * a00 + R10 * a10 + R20 * a20 + R01 * a01 + R11 * a11 + R21 * a21 + R02 * a02 + R12 * a12 + R22 * a22) + 1e-9;
            const wx = ox / den, wy = oy / den, wz = oz / den, w = Math.sqrt(wx * wx + wy * wy + wz * wz);
            if(w < 1e-8) break;
            const s = Math.sin(w * 0.5) / w, cw = Math.cos(w * 0.5), ax = wx * s, ay = wy * s, az = wz * s;
            const nx = cw * qx + ax * qw + ay * qz - az * qy, ny = cw * qy - ax * qz + ay * qw + az * qx;
            const nz = cw * qz + ax * qy - ay * qx + az * qw, nw = cw * qw - ax * qx - ay * qy - az * qz;
            const l = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz + nw * nw);
            qx = nx * l; qy = ny * l; qz = nz * l; qw = nw * l;
        }
        R00 = 1 - 2 * (qy * qy + qz * qz); R01 = 2 * (qx * qy - qz * qw); R02 = 2 * (qx * qz + qy * qw);
        R10 = 2 * (qx * qy + qz * qw); R11 = 1 - 2 * (qx * qx + qz * qz); R12 = 2 * (qy * qz - qx * qw);
        R20 = 2 * (qx * qz - qy * qw); R21 = 2 * (qy * qz + qx * qw); R22 = 1 - 2 * (qx * qx + qy * qy);
        // the lattice's frame now has no rotation: p' = R^T (p - c) + rc, v' = R^T (v - vmean)
        for(const i of actList) {
            const rx = rest[i * 3] - restC[0], ry = rest[i * 3 + 1] - restC[1], rz = rest[i * 3 + 2] - restC[2];
            const px = rx + u[i * 3] - cx, py = ry + u[i * 3 + 1] - cy, pz = rz + u[i * 3 + 2] - cz;
            u[i * 3] = R00 * px + R10 * py + R20 * pz - rx;
            u[i * 3 + 1] = R01 * px + R11 * py + R21 * pz - ry;
            u[i * 3 + 2] = R02 * px + R12 * py + R22 * pz - rz;
            const wx = v[i * 3] - vx, wy = v[i * 3 + 1] - vy, wz = v[i * 3 + 2] - vz;
            v[i * 3] = R00 * wx + R10 * wy + R20 * wz;
            v[i * 3 + 1] = R01 * wx + R11 * wy + R21 * wz;
            v[i * 3 + 2] = R02 * wx + R12 * wy + R22 * wz;
        }
        this.rq = [0, 0, 0, 1];
    }

    sleep() { this.asleep = true; this.u.fill(0); this.v.fill(0); this.calm = 0; this.frag = 1; }

    /**
     * Break faces (true when any broke this substep). The most strained face over the threshold starts a crack, which
     * runs across its lattice plane (DMM-style crack propagation) through faces strained over `run` of the threshold:
     * pieces break off along the line where the body bent, not as dust. One crack per substep.
     */
    fracture() {
        const { faces, broken, strain, damage, faceAt, cells, dims } = this;
        const nf = broken.length;
        const thr = this.tough / this.frag;
        let best = -1, bs = thr;
        for(let f = 0; f < nf; f++) {
            if(broken[f]) continue;
            const s = Math.max(strain[faces[f * 3]], strain[faces[f * 3 + 1]]);
            if(s > bs) { bs = s; best = f; }
        }
        if(best < 0) return false;
        // run the crack across the plane: faces of the same axis between cells of the same layer, edge-adjacent
        const run = thr * (this.frag > 1.4 ? 0.12 : 0.3);
        const axis = faces[best * 3 + 2];
        const [CX, CY] = dims, CXY = CX * CY;
        const stack = [best];
        broken[best] = 1;
        // where it cracked (grid-local metres): the seed face's centre
        {
            const pk = cells[faces[best * 3]], o = this.origin, h = this.h;
            this.crackAt = [o[0] + ((pk & 1023) + 0.5 + (axis === 0 ? 0.5 : 0)) * h, o[1] + (((pk >> 10) & 1023) + 0.5 + (axis === 1 ? 0.5 : 0)) * h, o[2] + ((pk >> 20) + 0.5 + (axis === 2 ? 0.5 : 0)) * h];
        }
        let n = 0;
        while(stack.length) {
            const f = stack.pop();
            n++;
            const a = faces[f * 3], b = faces[f * 3 + 1];
            damage[a] = Math.min(1, damage[a] + 0.5); damage[b] = Math.min(1, damage[b] + 0.5);
            const pk = cells[a], I = pk & 1023, J = (pk >> 10) & 1023, K = pk >> 20;
            for(let d = 0; d < 4; d++) {
                // the 4 in-plane neighbours of cell a (the face's lower cell)
                const s = d & 1 ? 1 : -1, ax = (axis + 1 + (d >> 1)) % 3;
                const ni = I + (ax === 0 ? s : 0), nj = J + (ax === 1 ? s : 0), nk = K + (ax === 2 ? s : 0);
                if(ni < 0 || nj < 0 || nk < 0 || ni >= CX || nj >= CY || nk >= dims[2]) continue;
                const c = this.cellOf[ni + nj * CX + nk * CXY];
                if(c < 0) continue;
                const g = faceAt[c * 3 + axis];
                if(g < 0 || broken[g]) continue;
                if(Math.max(strain[faces[g * 3]], strain[faces[g * 3 + 1]]) < run) continue;
                broken[g] = 1; stack.push(g);
            }
        }
        this.cracks = (this.cracks || 0) + n;
        return true;
    }

    /** Components of the solid cells over unbroken faces: { count, labels: Int32Array per cell, sizes }. */
    components() {
        const { ncell, faces, broken } = this;
        const parent = new Int32Array(ncell); for(let i = 0; i < ncell; i++) parent[i] = i;
        const find = (x) => { while(parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
        for(let f = 0; f < broken.length; f++) if(!broken[f]) { const a = find(faces[f * 3]), b = find(faces[f * 3 + 1]); if(a !== b) parent[a] = b; }
        const labels = new Int32Array(ncell), ids = new Map(), sizes = [];
        for(let c = 0; c < ncell; c++) {
            const r = find(c);
            let id = ids.get(r);
            if(id === undefined) { id = sizes.length; ids.set(r, id); sizes.push(0); }
            labels[c] = id; sizes[id]++;
        }
        return { count: sizes.length, labels, sizes };
    }

    /** Displacement and velocity at a grid-local point (trilinear; clamped to the lattice). */
    sampleAt(x, y, z, out) {
        const [NX, NY, NZ] = this.nodes, NXY = NX * NY, ih = 1 / this.h;
        let gx = (x - this.origin[0]) * ih, gy = (y - this.origin[1]) * ih, gz = (z - this.origin[2]) * ih;
        gx = Math.max(0, Math.min(NX - 1.001, gx)); gy = Math.max(0, Math.min(NY - 1.001, gy)); gz = Math.max(0, Math.min(NZ - 1.001, gz));
        const i = Math.floor(gx), j = Math.floor(gy), k = Math.floor(gz), fx = gx - i, fy = gy - j, fz = gz - k;
        out.fill(0);
        for(let c = 0; c < 8; c++) {
            const a = c & 1, b = (c >> 1) & 1, d = c >> 2;
            const w = (a ? fx : 1 - fx) * (b ? fy : 1 - fy) * (d ? fz : 1 - fz);
            const n = ((i + a) + (j + b) * NX + (k + d) * NXY) * 3;
            for(let e = 0; e < 3; e++) { out[e] += this.u[n + e] * w; out[3 + e] += this.v[n + e] * w; }
        }
        return out;
    }

    /** Start from a parent's motion: `off` = this body's grid-local origin in the parent's grid-local metres. */
    inherit(parent, off) {
        const s = new Float32Array(6);
        for(const i of this.actList) {
            parent.sampleAt(this.rest[i * 3] + off[0], this.rest[i * 3 + 1] + off[1], this.rest[i * 3 + 2] + off[2], s);
            for(let a = 0; a < 3; a++) { this.u[i * 3 + a] = s[a]; this.v[i * 3 + a] = s[3 + a]; }
        }
        this.asleep = false; this.calm = 0;
        this.removeRigid();
    }

    /** Node displacements as RGBA floats (NODE_CAP texels; x + y NX + z NX NY), into `out` at texel `at`. */
    writeTexels(out, at) {
        const { u, nn } = this;
        for(let i = 0, o = at * 4; i < nn; i++, o += 4) { out[o] = u[i * 3]; out[o + 1] = u[i * 3 + 1]; out[o + 2] = u[i * 3 + 2]; out[o + 3] = 0; }
    }
}

/**
 * Per padded sample labels from per cell labels: sample s belongs to cell floor((s + 1) / cs) (the partition the
 * lattice was built on), looked up at a position shifted by up to a sample per axis by smooth waves across the
 * other two axes, so crack faces come out wavy and interlocking instead of flat lattice planes.
 */
export function cellSampleLabels(g, cellLabels, cellOf, cs, dims) {
    const P = g.nx + 2 * PAD, PP = P * (g.ny + 2 * PAD);
    const [CX, CY, CZ] = dims, CXY = CX * CY;
    const labels = new Int32Array(g.sdf.length).fill(-1);
    const cellAt = (x, y, z) => {
        const I = ((x + 1) / cs) | 0, J = ((y + 1) / cs) | 0, K = ((z + 1) / cs) | 0;
        if(x < -1 || y < -1 || z < -1 || I >= CX || J >= CY || K >= CZ) return -1;
        return cellOf[I + J * CX + K * CXY];
    };
    for(let z = 0; z < g.nz; z++) for(let y = 0; y < g.ny; y++) {
        let i = PAD + (y + PAD) * P + (z + PAD) * PP;
        for(let x = 0; x < g.nx; x++, i++) {
            if(g.sdf[i] >= 0) continue;
            const jx = Math.round(1.2 * Math.sin(y * 0.31 + z * 0.43 + 1.3)), jy = Math.round(1.2 * Math.sin(x * 0.37 + z * 0.29 + 2.1));
            const jz = Math.round(1.2 * Math.sin(x * 0.41 + y * 0.33 + 0.4));
            let c = cellAt(x + jx, y + jy, z + jz);
            if(c < 0) c = cellAt(x, y, z);
            labels[i] = c >= 0 ? cellLabels[c] : 0;
        }
    }
    // a crack that stepped from plane to plane is a staircase of cells: two passes of a 3x3x3 majority vote round the
    // steps into slanted faces
    let nl = 0; for(let i = 0; i < cellLabels.length; i++) if(cellLabels[i] >= nl) nl = cellLabels[i] + 1;
    const votes = new Int32Array(nl);
    for(let pass = 0; pass < 2; pass++) {
        const src = labels.slice();
        for(let z = 0; z < g.nz; z++) for(let y = 0; y < g.ny; y++) {
            let i = PAD + (y + PAD) * P + (z + PAD) * PP;
            for(let x = 0; x < g.nx; x++, i++) {
                const l = src[i];
                if(l < 0) continue;
                // only samples on a boundary between pieces can change
                if(src[i + 1] === l && src[i - 1] === l && src[i + P] === l && src[i - P] === l && src[i + PP] === l && src[i - PP] === l) continue;
                votes.fill(0);
                for(let c = -1; c <= 1; c++) for(let b = -1; b <= 1; b++) for(let a = -1; a <= 1; a++) { const q = src[i + a + b * P + c * PP]; if(q >= 0) votes[q]++; }
                let best = l;
                for(let k = 0; k < nl; k++) if(votes[k] > votes[best]) best = k;
                labels[i] = best;
            }
        }
    }
    return labels;
}
