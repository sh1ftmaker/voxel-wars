/**
 * Soft ground solver on the CPU (runs in src/workers/softSim.js when there is no WebGPU compute; also importable from
 * node for tests). The same lattice, tets and shape matching as the GPU kernels in src/soft/SoftSim.js: per substep
 * predict (Verlet, damping, plastic creep of the rest shape), then K Jacobi iterations of { per-tet shape matching
 * (rotation from the warm-started quaternion) scattered into per-node goal sums ; node update with Chebyshev
 * over-relaxation }. Pinned nodes stay at u = 0.
 *
 * The GPU runs 4 iterations at 240 Hz; this runs fewer, so the materials' per-iteration stiffness is rescaled to give
 * the same pull per second (stiffness' = 1 - (1 - stiffness)^(960 / (rate * iterations))).
 *
 * Parameters arrive as the same packed vec4 array as the GPU parameter buffer (slotA/B/C, kickA/B/C: see SoftSim.js).
 */
import { MATERIALS } from '../voxel/materials.js';
import { H, MAX_ZONES, NODE_CAP, CELL_CAP, TET_OFF, F_ACTIVE, F_PINNED } from './core.js';

export const MAX_KICKS = 4;
export const P_SLOTA = 0, P_SLOTB = MAX_ZONES, P_SLOTC = 2 * MAX_ZONES, P_KICKA = 3 * MAX_ZONES, P_KICKB = P_KICKA + MAX_KICKS,
    P_KICKC = P_KICKB + MAX_KICKS, PARAMS = P_KICKC + MAX_KICKS;
export const MAXU = 0.9;          // m: clamp on a node's displacement
export const MAXV_PER_S = 14.4;   // m/s: clamp on a node's speed

class Slot {
    constructor() {
        this.n = [0, 0, 0]; this.count = 0;
        this.pos = new Float32Array(NODE_CAP * 3); this.prev = new Float32Array(NODE_CAP * 3);
        this.old = new Float32Array(NODE_CAP * 3); this.rest = new Float32Array(NODE_CAP * 3);
        this.sum = new Float32Array(NODE_CAP * 3); this.wsum = new Float32Array(NODE_CAP);
        this.flags = new Int32Array(NODE_CAP); this.cells = new Int32Array(CELL_CAP);
        this.tetN = new Int32Array(CELL_CAP * 20);  // node index of each tet corner
        this.tetX = new Uint8Array(CELL_CAP * 5);   // parity * 5 + tet: row of the corner offset table (CpuSoft.XT)
        this.nodes = 0;
        this.tetQ = new Float32Array(CELL_CAP * 5 * 4);
        this.active = new Int32Array(NODE_CAP); this.nActive = 0; // free (active, unpinned) nodes
    }
    reset() {
        this.pos.fill(0); this.prev.fill(0); this.old.fill(0); this.rest.fill(0);
        for(let i = 0; i < this.tetQ.length; i += 4) { this.tetQ[i] = 0; this.tetQ[i + 1] = 0; this.tetQ[i + 2] = 0; this.tetQ[i + 3] = 1; }
    }
}

export class CpuSoft {
    constructor({ iterations = 3, rate = 120 } = {}) {
        this.iterations = iterations;
        this.slots = Array.from({ length: MAX_ZONES }, () => new Slot());
        this.P = new Float32Array(PARAMS * 4);
        // material tables (16 ids): stiffness (rescaled), damping, plasticity, yield, softness, weight
        const k = 960 / (rate * iterations);
        this.mat = new Float32Array(16 * 6);
        for(let m = 0; m < 16; m++) {
            const M = MATERIALS[m] || MATERIALS[1];
            this.mat.set([1 - Math.pow(1 - Math.min(0.999, M.stiffness), k), M.damping, M.plasticity, M.yield, M.softness, M.density / 1000], m * 6);
        }
        const Kit = iterations, rho = Math.min(0.95, Math.max(0.6, 1 - 1.5 / Kit)), rho2 = rho * rho;
        this.omegas = []; let om = 1;
        for(let i = 0; i < Kit; i++) { om = i < 2 ? 1 : i === 2 ? 2 / (2 - rho2) : 4 / (4 - rho2 * om); this.omegas.push(om); }
        // tet corner offsets as (dx, dy, dz) in nodes: TET_OFF bits -> per parity, tet, corner
        this.tetOff = Int32Array.from(TET_OFF);
        this._Pq = new Float64Array(12); this._Rr = new Float64Array(12);
        // corner offsets (m) of tet l's corners in a cell of parity p: XT[(p * 5 + l) * 12 + k * 3 + axis]
        this.XT = new Float64Array(120);
        for(let i = 0; i < 40; i++) { const o = TET_OFF[i]; this.XT[i * 3] = (o & 1) * H; this.XT[i * 3 + 1] = ((o >> 1) & 1) * H; this.XT[i * 3 + 2] = ((o >> 2) & 1) * H; }
    }

    /** A zone's lattice (from classifyZone). `init`: zero its state (a new zone) or keep the motion (a refresh). */
    upload(s, { n, flags, cellIdx, cells, count }, init) {
        const S = this.slots[s];
        if(init) S.reset();
        S.n = [...n]; S.count = count;
        const NX = n[0] + 1, NY = n[1] + 1, nodes = NX * NY * (n[2] + 1);
        S.flags.fill(0); S.flags.set(flags.subarray(0, nodes));
        S.cells.set(cells.subarray(0, count));
        S.nodes = nodes;
        S.wsum.fill(0);
        const T = this.tetOff, NXY = NX * NY;
        for(let c = 0, t = 0; c < count; c++) {
            const v = cells[c], i = v & 255, j = (v >> 8) & 255, k = (v >> 16) & 255, par = (i + j + k) & 1;
            const base = i + j * NX + k * NXY, w = this.mat[((v >> 24) & 15) * 6 + 5];
            for(let l = 0; l < 5; l++, t++) {
                S.tetX[t] = par * 5 + l;
                for(let q = 0; q < 4; q++) {
                    const o = T[par * 20 + l * 4 + q], n = base + (o & 1) + ((o >> 1) & 1) * NX + ((o >> 2) & 1) * NXY;
                    S.tetN[t * 4 + q] = n; S.wsum[n] += w;
                }
            }
        }
        S.nActive = 0;
        for(let i = 0; i < nodes; i++) {
            const f = S.flags[i];
            if(!(f & F_ACTIVE)) continue;
            if(f & F_PINNED) { S.pos[i * 3] = S.pos[i * 3 + 1] = S.pos[i * 3 + 2] = 0; S.prev.set(S.pos.subarray(i * 3, i * 3 + 3), i * 3); continue; }
            S.active[S.nActive++] = i;
        }
    }

    reset(s) { this.slots[s].reset(); }

    /** JIT warm-up on a small solid block in slot 0 (the first real wake should not run the cold code). */
    warmup() {
        const n = [6, 6, 6], NX = 7, nodes = 343, flags = new Int32Array(nodes), cells = new Int32Array(216), cellIdx = new Int32Array(nodes).fill(-1);
        let count = 0;
        for(let k = 0; k < 6; k++) for(let j = 0; j < 6; j++) for(let i = 0; i < 6; i++) { cellIdx[i + j * NX + k * 49] = count; cells[count++] = i | (j << 8) | (k << 16) | (1 << 24); }
        for(let k = 0; k <= 6; k++) for(let j = 0; j <= 6; j++) for(let i = 0; i <= 6; i++) flags[i + j * NX + k * 49] = F_ACTIVE | (1 << 8) | (j === 0 ? F_PINNED : 0);
        const P = this.P, keep = P.slice();
        P.fill(0);
        P.set([0, 0, 0, 1], P_SLOTA * 4); P.set([7, 7, 7, count], P_SLOTB * 4);
        P.set([1.5, 3, 1.5, 2], P_KICKA * 4); P.set([0, -1, 0, 5], P_KICKB * 4);
        this.upload(0, { n, flags, cellIdx, cells, count }, true);
        for(let f = 0; f < 40; f++) this.step(1, 1 / 60, f === 0);
        this.write(new Float32Array((MAX_ZONES * NODE_CAP + 2 * MAX_ZONES) * 4));
        this.read(0, nodes);
        P.set(keep);
        this.slots[0].reset();
    }

    /** Apply this frame's kicks (P's kick entries), then `substeps` substeps of dt. Returns the tets processed. */
    step(substeps, dt, kicks) {
        const P = this.P;
        let work = 0;
        if(kicks) this._kicks(dt);
        for(let s = 0; s < MAX_ZONES; s++) {
            if(P[(P_SLOTA + s) * 4 + 3] !== 1) continue;
            const S = this.slots[s];
            const extra = P[(P_SLOTC + s) * 4];
            for(let i = 0; i < substeps; i++) {
                this._predict(S, dt, extra);
                for(const om of this.omegas) { this._tets(S); this._project(S, om); work += S.count * 5; }
            }
        }
        return work;
    }

    _kicks(dt) {
        const P = this.P, mat = this.mat;
        for(let k = 0; k < MAX_KICKS; k++) {
            const a = (P_KICKA + k) * 4, b = (P_KICKB + k) * 4, c = (P_KICKC + k) * 4;
            const R = P[a + 3];
            if(!(R > 0)) continue;
            const s = P[c] | 0, up = P[c + 1], S = this.slots[s];
            if(P[(P_SLOTA + s) * 4 + 3] !== 1) continue;
            const ox = P[(P_SLOTA + s) * 4], oy = P[(P_SLOTA + s) * 4 + 1], oz = P[(P_SLOTA + s) * 4 + 2];
            const NX = S.n[0] + 1, NXY = NX * (S.n[1] + 1);
            const dl = Math.hypot(P[b], P[b + 1], P[b + 2]), speed = P[b + 3];
            for(let j = 0; j < S.nActive; j++) {
                const i = S.active[j];
                const lx = i % NX, ly = ((i / NX) | 0) % (S.n[1] + 1), lz = (i / NXY) | 0;
                const dx = ox + lx * H - P[a], dy = oy + ly * H - P[a + 1], dz = oz + lz * H - P[a + 2];
                const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
                if(r >= R) continue;
                const f1 = 1 - r / R, fall = f1 * f1 * (3 - 2 * f1);
                let vx, vy, vz;
                if(dl > 0.01) { vx = P[b]; vy = P[b + 1]; vz = P[b + 2]; }
                else { vx = dx; vy = dy + R * up + 1e-4; vz = dz; const l = Math.hypot(vx, vy, vz); vx /= l; vy /= l; vz /= l; }
                const g = speed * fall * mat[((S.flags[i] >> 8) & 15) * 6 + 4] * dt;
                S.prev[i * 3] -= vx * g; S.prev[i * 3 + 1] -= vy * g; S.prev[i * 3 + 2] -= vz * g;
            }
        }
    }

    _predict(S, dt, extra) {
        const { pos, prev, old, rest, flags, active } = S, mat = this.mat;
        const maxv = MAXV_PER_S * dt;
        for(let j = 0; j < S.nActive; j++) {
            const i = active[j], o = i * 3, m = ((flags[i] >> 8) & 15) * 6;
            const px = pos[o], py = pos[o + 1], pz = pos[o + 2];
            const damp = Math.max(0, 1 - (mat[m + 1] + extra) * dt);
            let vx = (px - prev[o]) * damp, vy = (py - prev[o + 1]) * damp, vz = (pz - prev[o + 2]) * damp;
            const vl = Math.sqrt(vx * vx + vy * vy + vz * vz);
            if(vl > maxv) { const f = maxv / vl; vx *= f; vy *= f; vz *= f; }
            const plast = mat[m + 2];
            if(plast > 0) {
                const dx = px - rest[o], dy = py - rest[o + 1], dz = pz - rest[o + 2];
                const dl = Math.sqrt(dx * dx + dy * dy + dz * dz), yld = mat[m + 3];
                if(dl > yld) {
                    const f = (dl - yld) / dl * (1 - Math.pow(1 - plast, dt * 60));
                    rest[o] += dx * f; rest[o + 1] += dy * f; rest[o + 2] += dz * f;
                }
            }
            prev[o] = px; prev[o + 1] = py; prev[o + 2] = pz;
            pos[o] = old[o] = px + vx; pos[o + 1] = old[o + 1] = py + vy; pos[o + 2] = old[o + 2] = pz + vz;
        }
    }

    /** Per tet shape matching; each corner's goal displacement (weighted) is added to its node's sum (the weight
     *  sums per node are fixed: S.wsum, from upload). */
    _tets(S) {
        const { pos, rest, sum, tetN, tetX, tetQ } = S, XT = this.XT, mat = this.mat, cells = S.cells;
        sum.fill(0, 0, S.nodes * 3);
        const Pq = this._Pq, Rr = this._Rr;
        for(let c = 0, t = 0; c < S.count; c++) {
            const m = ((cells[c] >> 24) & 15) * 6, stiff = mat[m], w = mat[m + 5];
            for(let l = 0; l < 5; l++, t++) {
                const t4 = t * 4, xo = tetX[t] * 12;
                let cx = 0, cy = 0, cz = 0, rx = 0, ry = 0, rz = 0;
                for(let k = 0, k3 = 0; k < 4; k++, k3 += 3) {
                    const n3 = tetN[t4 + k] * 3, X = XT[xo + k3], Y = XT[xo + k3 + 1], Z = XT[xo + k3 + 2];
                    const px = X + pos[n3], py = Y + pos[n3 + 1], pz = Z + pos[n3 + 2];
                    const qx = X + rest[n3], qy = Y + rest[n3 + 1], qz = Z + rest[n3 + 2];
                    Pq[k3] = px; Pq[k3 + 1] = py; Pq[k3 + 2] = pz; Rr[k3] = qx; Rr[k3 + 1] = qy; Rr[k3 + 2] = qz;
                    cx += px; cy += py; cz += pz; rx += qx; ry += qy; rz += qz;
                }
                cx *= 0.25; cy *= 0.25; cz *= 0.25; rx *= 0.25; ry *= 0.25; rz *= 0.25;
                // A = sum q r^T, columns A0 (r.x), A1 (r.y), A2 (r.z)
                let a00 = 0, a01 = 0, a02 = 0, a10 = 0, a11 = 0, a12 = 0, a20 = 0, a21 = 0, a22 = 0;
                for(let k3 = 0; k3 < 12; k3 += 3) {
                    const qx = Pq[k3] - cx, qy = Pq[k3 + 1] - cy, qz = Pq[k3 + 2] - cz;
                    const sx = Rr[k3] - rx, sy = Rr[k3 + 1] - ry, sz = Rr[k3 + 2] - rz;
                    Rr[k3] = sx; Rr[k3 + 1] = sy; Rr[k3 + 2] = sz;
                    a00 += qx * sx; a01 += qy * sx; a02 += qz * sx;
                    a10 += qx * sy; a11 += qy * sy; a12 += qz * sy;
                    a20 += qx * sz; a21 += qy * sz; a22 += qz * sz;
                }
                // one Müller iteration on the warm-started quaternion (rotation matrix columns X, Y, Z)
                let qx = tetQ[t4], qy = tetQ[t4 + 1], qz = tetQ[t4 + 2], qw = tetQ[t4 + 3];
                let xx = qx * qx, yy = qy * qy, zz = qz * qz, xy = qx * qy, xz = qx * qz, yz = qy * qz, wx = qw * qx, wy = qw * qy, wz = qw * qz;
                let X0 = 1 - 2 * (yy + zz), X1 = 2 * (xy + wz), X2 = 2 * (xz - wy);
                let Y0 = 2 * (xy - wz), Y1 = 1 - 2 * (xx + zz), Y2 = 2 * (yz + wx);
                let Z0 = 2 * (xz + wy), Z1 = 2 * (yz - wx), Z2 = 1 - 2 * (xx + yy);
                let ox = (X1 * a02 - X2 * a01) + (Y1 * a12 - Y2 * a11) + (Z1 * a22 - Z2 * a21);
                let oy = (X2 * a00 - X0 * a02) + (Y2 * a10 - Y0 * a12) + (Z2 * a20 - Z0 * a22);
                let oz = (X0 * a01 - X1 * a00) + (Y0 * a11 - Y1 * a10) + (Z0 * a21 - Z1 * a20);
                const den = 1 / (Math.abs(X0 * a00 + X1 * a01 + X2 * a02 + Y0 * a10 + Y1 * a11 + Y2 * a12 + Z0 * a20 + Z1 * a21 + Z2 * a22) + 1e-9);
                ox *= den; oy *= den; oz *= den;
                const w2 = ox * ox + oy * oy + oz * oz;
                if(w2 > 1e-14) {
                    let sh, ch;
                    if(w2 < 0.25) { sh = 0.5 - w2 / 48; ch = 1 - w2 / 8; } // small angle (renormalized below)
                    else { const wl = Math.sqrt(w2); sh = Math.sin(wl * 0.5) / wl; ch = Math.cos(wl * 0.5); }
                    const dx = ox * sh, dy = oy * sh, dz = oz * sh, dw = ch;
                    const nx = dw * qx + dx * qw + dy * qz - dz * qy;
                    const ny = dw * qy - dx * qz + dy * qw + dz * qx;
                    const nz = dw * qz + dx * qy - dy * qx + dz * qw;
                    const nw = dw * qw - dx * qx - dy * qy - dz * qz;
                    const il = 1 / (Math.sqrt(nx * nx + ny * ny + nz * nz + nw * nw) || 1);
                    qx = nx * il; qy = ny * il; qz = nz * il; qw = nw * il;
                    tetQ[t4] = qx; tetQ[t4 + 1] = qy; tetQ[t4 + 2] = qz; tetQ[t4 + 3] = qw;
                    xx = qx * qx; yy = qy * qy; zz = qz * qz; xy = qx * qy; xz = qx * qz; yz = qy * qz; wx = qw * qx; wy = qw * qy; wz = qw * qz;
                    X0 = 1 - 2 * (yy + zz); X1 = 2 * (xy + wz); X2 = 2 * (xz - wy);
                    Y0 = 2 * (xy - wz); Y1 = 1 - 2 * (xx + zz); Y2 = 2 * (yz + wx);
                    Z0 = 2 * (xz + wy); Z1 = 2 * (yz - wx); Z2 = 1 - 2 * (xx + yy);
                }
                // goal displacement: u + (R r + c - P) * stiff, weighted
                const sw = stiff * w;
                for(let k = 0, k3 = 0; k < 4; k++, k3 += 3) {
                    const sx = Rr[k3], sy = Rr[k3 + 1], sz = Rr[k3 + 2];
                    const n3 = tetN[t4 + k] * 3;
                    sum[n3] += pos[n3] * w + (X0 * sx + Y0 * sy + Z0 * sz + cx - Pq[k3]) * sw;
                    sum[n3 + 1] += pos[n3 + 1] * w + (X1 * sx + Y1 * sy + Z1 * sz + cy - Pq[k3 + 1]) * sw;
                    sum[n3 + 2] += pos[n3 + 2] * w + (X2 * sx + Y2 * sy + Z2 * sz + cz - Pq[k3 + 2]) * sw;
                }
            }
        }
    }

    _project(S, omega) {
        const { pos, old, sum, wsum, active } = S;
        for(let j = 0; j < S.nActive; j++) {
            const i = active[j], ws = wsum[i];
            if(!(ws > 0)) continue;
            const o = i * 3;
            let nx = old[o] + (sum[o] / ws - old[o]) * omega, ny = old[o + 1] + (sum[o + 1] / ws - old[o + 1]) * omega, nz = old[o + 2] + (sum[o + 2] / ws - old[o + 2]) * omega;
            const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
            if(l > MAXU) { const f = MAXU / l; nx *= f; ny *= f; nz *= f; }
            old[o] = pos[o]; old[o + 1] = pos[o + 1]; old[o + 2] = pos[o + 2];
            pos[o] = nx; pos[o + 1] = ny; pos[o + 2] = nz;
        }
    }

    /** Write slot displacements (RGBA per node, slot-major, NODE_CAP per slot) and the slot parameters (2 texels per
     *  slot after the nodes) into `out`, the data of the deformation texture. */
    write(out) {
        const P = this.P;
        for(let s = 0; s < MAX_ZONES; s++) {
            const a = (P_SLOTA + s) * 4, mode = P[a + 3], S = this.slots[s];
            const pb = (MAX_ZONES * NODE_CAP + s * 2) * 4;
            out[pb] = P[a]; out[pb + 1] = P[a + 1]; out[pb + 2] = P[a + 2]; out[pb + 3] = mode;
            const b = (P_SLOTB + s) * 4;
            out[pb + 4] = P[b]; out[pb + 5] = P[b + 1]; out[pb + 6] = P[b + 2]; out[pb + 7] = P[b + 3];
            if(!(mode > 0)) continue;
            const nodes = (S.n[0] + 1) * (S.n[1] + 1) * (S.n[2] + 1), pos = S.pos;
            let o = s * NODE_CAP * 4;
            for(let i = 0, i3 = 0; i < nodes; i++, i3 += 3, o += 4) { out[o] = pos[i3]; out[o + 1] = pos[i3 + 1]; out[o + 2] = pos[i3 + 2]; }
        }
    }

    /** Node displacements of slot s as 4 floats per node (the layout SoftGround's bake expects). */
    read(s, nodes) {
        const out = new Float32Array(nodes * 4), pos = this.slots[s].pos;
        for(let i = 0; i < nodes; i++) { out[i * 4] = pos[i * 3]; out[i * 4 + 1] = pos[i * 3 + 1]; out[i * 4 + 2] = pos[i * 3 + 2]; }
        return out;
    }
}
