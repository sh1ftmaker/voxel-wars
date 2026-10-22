/**
 * Position Based Fluids on the CPU (plain typed arrays): the same algorithm as the GPU kernels in src/fluid/FluidGPU.js,
 * for the WebGL2 backend (run in src/workers/fluid.js) and for node tests (tools/test/sph.mjs). See docs/SPH.md.
 *
 *   const s = new FluidSolver({ spacing, cap, iterations, substeps, sdf })   sdf: PageSDF (src/fluid/sdfPages.js) or
 *                                                                            any { sample(x, y, z, out) }
 *   s.write(i, x, y, z, phase, vx, vy, vz)   put a particle in slot i (s.extent grows to cover it)
 *   s.kill(i)
 *   s.proxies (Float32Array, MAX_PROXIES * 12), s.kicks (Float32Array, MAX_KICKS * 8): see packProxy / packKick
 *   s.step(dt)                               one solver step (`substeps` substeps of dt / substeps)
 *   s.pos (xyz, phase), s.vel (xyz, idle s), s.dens (rho / rho0), s.stats { alive, maxSpeed, min, max, ms }
 */
import { VOXEL } from '../config.js';
import { kernel, wall, PHASES, GRAVITY, MAX_SPEED, S_CORR_K, IDLE_SPEED, EVAPORATE_DENSITY, EVAPORATE_TIME, MAX_NEIGHBOURS, MAX_PROXIES, MAX_KICKS } from './params.js';
import { WORLD_CHUNKS, CHUNK } from '../config.js';
import { NCX, NCY, NCZ, N_CHUNKS } from './sdfPages.js';

const CM = CHUNK * VOXEL;
export const MOVING_SPEED = 0.25; // m/s: a particle faster than this keeps the fluid awake
export const OCC_WORDS = Math.ceil(N_CHUNKS / 32);
/** Chunk index (src/fluid/sdfPages.js order) of a point, clamped into the world: the occupancy bit it sets. */
export function occIndex(x, y, z) {
    const cx = Math.min(NCX - 1, Math.max(0, Math.floor(x / CM) - WORLD_CHUNKS.min[0]));
    const cy = Math.min(NCY - 1, Math.max(0, Math.floor(y / CM) - WORLD_CHUNKS.min[1]));
    const cz = Math.min(NCZ - 1, Math.max(0, Math.floor(z / CM) - WORLD_CHUNKS.min[2]));
    return cx + cy * NCX + cz * NCX * NCY;
}
/** World box particles live in (m); outside it they are recycled. */
export const WORLD_LO = [WORLD_CHUNKS.min[0] * CM, WORLD_CHUNKS.min[1] * CM - 1, WORLD_CHUNKS.min[2] * CM];
export const WORLD_HI = [WORLD_CHUNKS.max[0] * CM, WORLD_CHUNKS.max[1] * CM + 24, WORLD_CHUNKS.max[2] * CM];

/** Proxy layout (12 floats): type (0 none, 1 capsule, 2 box), a xyz | capsule: b xyz, radius | box: half xyz, - | box
 *  rotation quaternion xyzw. */
export function packProxy(arr, k, p) {
    const o = k * 12;
    if(!p) { arr.fill(0, o, o + 12); return; }
    if(p.type === 'capsule') arr.set([1, p.a[0], p.a[1], p.a[2], p.b[0], p.b[1], p.b[2], p.r, 0, 0, 0, 1], o);
    else arr.set([2, p.c[0], p.c[1], p.c[2], p.half[0], p.half[1], p.half[2], 0, p.q[0], p.q[1], p.q[2], p.q[3]], o);
}
/** Kick layout (8 floats): centre xyz, radius, direction xyz (0: radial, tilted up), speed (m/s). */
export function packKick(arr, k, kk) {
    const o = k * 8;
    if(!kk) { arr.fill(0, o, o + 8); return; }
    const d = kk.dir || [0, 0, 0];
    arr.set([kk.center[0], kk.center[1], kk.center[2], kk.radius, d[0], d[1], d[2], kk.speed], o);
}

export class FluidSolver {
    constructor({ spacing, cap, iterations = 3, substeps = 2, sdf, scorr = S_CORR_K }) {
        this.k = kernel(spacing);
        this.cap = cap; this.scorr = scorr; this.iterations = iterations; this.substeps = substeps; this.sdf = sdf;
        this.pos = new Float32Array(cap * 4);
        this.vel = new Float32Array(cap * 4);
        this.pred = new Float32Array(cap * 4);
        this.dp = new Float32Array(cap * 3);
        this.wg = new Float32Array(cap * 3);
        this.vt = new Float32Array(cap * 3);
        this.lam = new Float32Array(cap);
        this.dens = new Float32Array(cap);
        this.nbr = new Int32Array(cap * MAX_NEIGHBOURS);
        this.nn = new Uint8Array(cap);
        let T = 1; while(T < cap * 2) T <<= 1;
        this.T = T;
        this.start = new Int32Array(T + 1);
        this.sorted = new Int32Array(cap);
        this.cellH = new Int32Array(cap);
        this.cellC = new Int32Array(cap * 3);
        this.proxies = new Float32Array(MAX_PROXIES * 12);
        this.kicks = new Float32Array(MAX_KICKS * 8);
        this.extent = 0;
        this.gravity = GRAVITY;
        this.stats = { alive: 0, moving: 0, maxSpeed: 0, min: [0, 0, 0], max: [0, 0, 0], ms: 0, steps: 0, occ: new Uint32Array(OCC_WORDS) };
        this._s = new Float32Array(4);
        this._n = new Float32Array(3);
    }
    write(i, x, y, z, phase, vx = 0, vy = 0, vz = 0) {
        const o = i * 4;
        this.pos[o] = x; this.pos[o + 1] = y; this.pos[o + 2] = z; this.pos[o + 3] = phase;
        this.vel[o] = vx; this.vel[o + 1] = vy; this.vel[o + 2] = vz; this.vel[o + 3] = 0;
        this.dens[i] = 1;
        if(i + 1 > this.extent) this.extent = i + 1;
    }
    kill(i) { this.pos[i * 4 + 3] = 0; }

    /** Push p (index o into array a) out of the terrain and the proxies. Returns 1 when it touched the terrain
     *  (this._n holds the contact normal then). */
    _collide(a, o) {
        const r = this.k.radius, s = this._s;
        let contact = 0;
        // proxies
        const P = this.proxies;
        for(let k = 0; k < MAX_PROXIES; k++) {
            const q = k * 12, type = P[q];
            if(type === 0) continue;
            if(type === 1) {
                const ax = P[q + 1], ay = P[q + 2], az = P[q + 3], bx = P[q + 4] - ax, by = P[q + 5] - ay, bz = P[q + 6] - az;
                const px = a[o] - ax, py = a[o + 1] - ay, pz = a[o + 2] - az;
                const L2 = bx * bx + by * by + bz * bz;
                const t = L2 > 1e-9 ? Math.max(0, Math.min(1, (px * bx + py * by + pz * bz) / L2)) : 0;
                const dx = px - bx * t, dy = py - by * t, dz = pz - bz * t;
                const d = Math.hypot(dx, dy, dz), R = P[q + 7] + r;
                if(d < R && d > 1e-6) { const f = (R - d) / d; a[o] += dx * f; a[o + 1] += dy * f; a[o + 2] += dz * f; }
            } else {
                const qx = P[q + 8], qy = P[q + 9], qz = P[q + 10], qw = P[q + 11];
                const vx = a[o] - P[q + 1], vy = a[o + 1] - P[q + 2], vz = a[o + 2] - P[q + 3];
                // local = conj(q) v
                const l = rotate(vx, vy, vz, -qx, -qy, -qz, qw);
                const hx = P[q + 4] + r, hy = P[q + 5] + r, hz = P[q + 6] + r;
                const ex = hx - Math.abs(l[0]), ey = hy - Math.abs(l[1]), ez = hz - Math.abs(l[2]);
                if(ex > 0 && ey > 0 && ez > 0) {
                    if(ex <= ey && ex <= ez) l[0] = Math.sign(l[0] || 1) * hx;
                    else if(ey <= ez) l[1] = Math.sign(l[1] || 1) * hy;
                    else l[2] = Math.sign(l[2] || 1) * hz;
                    const w = rotate(l[0], l[1], l[2], qx, qy, qz, qw);
                    a[o] = P[q + 1] + w[0]; a[o + 1] = P[q + 2] + w[1]; a[o + 2] = P[q + 3] + w[2];
                }
            }
        }
        // terrain
        const d = this.sdf.sample(a[o], a[o + 1], a[o + 2], s);
        if(d < r) {
            let gx = s[1], gy = s[2], gz = s[3];
            let gl = Math.hypot(gx, gy, gz);
            if(gl < 1e-6) { gx = 0; gy = 1; gz = 0; gl = 1; } // deep inside (saturated): out upward
            gx /= gl; gy /= gl; gz /= gl;
            const push = r - d;
            a[o] += gx * push; a[o + 1] += gy * push; a[o + 2] += gz * push;
            this._n[0] = gx; this._n[1] = gy; this._n[2] = gz;
            contact = 1;
        }
        return contact;
    }

    step(dt) {
        const t0 = performance.now();
        const n = this.substeps, h = dt / n;
        for(let s = 0; s < n; s++) this._substep(h, s === n - 1);
        this.stats.ms = performance.now() - t0;
        this.stats.steps++;
    }

    _substep(dt, last) {
        const { pos, vel, pred, dp, vt, lam, dens, nbr, nn, wg } = this;
        const kk = this.k, ss = this._s;
        const { h, h2, poly6, spiky, rho0, eps, wdq } = this.k;
        const N = this.extent, MAXN = MAX_NEIGHBOURS;
        const g = this.gravity;
        const K = this.kicks;
        // ---- predict
        for(let i = 0; i < N; i++) {
            const o = i * 4, ph = pos[o + 3];
            if(ph === 0) continue;
            const M = PHASES[ph];
            let vx = vel[o], vy = vel[o + 1] - g * dt, vz = vel[o + 2];
            const damp = Math.max(0, 1 - M.damping * dt);
            vx *= damp; vy *= damp; vz *= damp;
            for(let k = 0; k < MAX_KICKS; k++) {
                const q = k * 8, R = K[q + 3];
                if(!(R > 0)) continue;
                const dx = pos[o] - K[q], dy = pos[o + 1] - K[q + 1], dz = pos[o + 2] - K[q + 2];
                const d = Math.hypot(dx, dy, dz);
                if(d >= R) continue;
                const f = 1 - d / R, fall = f * f * (3 - 2 * f), sp = K[q + 7] * fall;
                let ux = K[q + 4], uy = K[q + 5], uz = K[q + 6];
                if(ux * ux + uy * uy + uz * uz < 1e-4) { ux = dx; uy = dy + R * 0.6; uz = dz; }
                const ul = Math.hypot(ux, uy, uz) || 1;
                vx += ux / ul * sp; vy += uy / ul * sp; vz += uz / ul * sp;
            }
            const sp = Math.hypot(vx, vy, vz);
            if(sp > MAX_SPEED) { const f = MAX_SPEED / sp; vx *= f; vy *= f; vz *= f; }
            vel[o] = vx; vel[o + 1] = vy; vel[o + 2] = vz;
            pred[o] = pos[o] + vx * dt; pred[o + 1] = pos[o + 1] + vy * dt; pred[o + 2] = pos[o + 2] + vz * dt;
            this._collide(pred, o);
        }
        // ---- neighbours: hash grid (cell = h), counting sort, then a list per particle
        const T = this.T, start = this.start, sorted = this.sorted, cellH = this.cellH, cellC = this.cellC;
        start.fill(0);
        const inv = 1 / h;
        for(let i = 0; i < N; i++) {
            const o = i * 4;
            if(pos[o + 3] === 0) { cellH[i] = -1; continue; }
            const cx = Math.floor(pred[o] * inv), cy = Math.floor(pred[o + 1] * inv), cz = Math.floor(pred[o + 2] * inv);
            cellC[i * 3] = cx; cellC[i * 3 + 1] = cy; cellC[i * 3 + 2] = cz;
            const hh = hash(cx, cy, cz) & (T - 1);
            cellH[i] = hh; start[hh + 1]++;
        }
        for(let b = 0; b < T; b++) start[b + 1] += start[b];
        const fillp = this._fill || (this._fill = new Int32Array(T));
        fillp.set(start.subarray(0, T));
        for(let i = 0; i < N; i++) if(cellH[i] >= 0) sorted[fillp[cellH[i]]++] = i;
        for(let i = 0; i < N; i++) {
            nn[i] = 0;
            if(cellH[i] < 0) continue;
            const o = i * 4, px = pred[o], py = pred[o + 1], pz = pred[o + 2];
            const cx = cellC[i * 3], cy = cellC[i * 3 + 1], cz = cellC[i * 3 + 2];
            let c = 0;
            const base = i * MAXN;
            for(let dz = -1; dz <= 1; dz++) for(let dy = -1; dy <= 1; dy++) for(let dx = -1; dx <= 1; dx++) {
                const X = cx + dx, Y = cy + dy, Z = cz + dz;
                const b = hash(X, Y, Z) & (T - 1);
                for(let k = start[b], e = start[b + 1]; k < e && c < MAXN; k++) {
                    const j = sorted[k];
                    if(j === i || cellC[j * 3] !== X || cellC[j * 3 + 1] !== Y || cellC[j * 3 + 2] !== Z) continue;
                    const q = j * 4, rx = px - pred[q], ry = py - pred[q + 1], rz = pz - pred[q + 2];
                    if(rx * rx + ry * ry + rz * rz < h2) nbr[base + c++] = j;
                }
            }
            nn[i] = c;
        }
        // ---- density constraint iterations (Jacobi)
        const w0 = poly6 * h2 * h2 * h2;
        for(let it = 0; it < this.iterations; it++) {
            for(let i = 0; i < N; i++) {
                if(cellH[i] < 0) continue;
                const o = i * 4, px = pred[o], py = pred[o + 1], pz = pred[o + 2];
                let rho = w0, gx = 0, gy = 0, gz = 0, g2 = 0;
                for(let k = 0, base = i * MAXN, c = nn[i]; k < c; k++) {
                    const q = nbr[base + k] * 4;
                    const rx = px - pred[q], ry = py - pred[q + 1], rz = pz - pred[q + 2];
                    const r2 = rx * rx + ry * ry + rz * rz;
                    if(r2 >= h2) continue;
                    const r = Math.sqrt(r2), x = h2 - r2;
                    rho += poly6 * x * x * x;
                    if(r > 1e-6) {
                        const f = spiky * (h - r) * (h - r) / r / rho0;
                        const ax = rx * f, ay = ry * f, az = rz * f;
                        gx += ax; gy += ay; gz += az; g2 += ax * ax + ay * ay + az * az;
                    }
                }
                // the terrain's share of the density (src/fluid/params.js wall)
                const sd = this.sdf.sample(px, py, pz, ss);
                const q3 = i * 3;
                wg[q3] = wg[q3 + 1] = wg[q3 + 2] = 0;
                let d = rho / rho0;
                if(sd < h) {
                    const W2 = wall(kk, sd), gl = Math.hypot(ss[1], ss[2], ss[3]) || 1;
                    d += W2[0];
                    const f = W2[1] / gl;
                    wg[q3] = ss[1] * f; wg[q3 + 1] = ss[2] * f; wg[q3 + 2] = ss[3] * f;
                    gx += wg[q3]; gy += wg[q3 + 1]; gz += wg[q3 + 2];
                }
                dens[i] = d;
                const C = d - 1;
                lam[i] = C > 0 ? -C / (g2 + gx * gx + gy * gy + gz * gz + eps) : 0;
            }
            for(let i = 0; i < N; i++) {
                if(cellH[i] < 0) continue;
                const o = i * 4, px = pred[o], py = pred[o + 1], pz = pred[o + 2], li = lam[i];
                let x = 0, y = 0, z = 0;
                for(let k = 0, base = i * MAXN, c = nn[i]; k < c; k++) {
                    const j = nbr[base + k], q = j * 4;
                    const rx = px - pred[q], ry = py - pred[q + 1], rz = pz - pred[q + 2];
                    const r2 = rx * rx + ry * ry + rz * rz;
                    if(r2 >= h2 || r2 < 1e-12) continue;
                    const r = Math.sqrt(r2), w = h2 - r2;
                    const wr = poly6 * w * w * w / wdq;
                    const sc = -this.scorr * wr * wr * wr * wr;
                    const f = (li + lam[j] + sc) * spiky * (h - r) * (h - r) / r / rho0;
                    x += rx * f; y += ry * f; z += rz * f;
                }
                const q = i * 3;
                dp[q] = x + li * wg[q]; dp[q + 1] = y + li * wg[q + 1]; dp[q + 2] = z + li * wg[q + 2];
            }
            for(let i = 0; i < N; i++) {
                if(cellH[i] < 0) continue;
                const o = i * 4, q = i * 3;
                pred[o] += dp[q]; pred[o + 1] += dp[q + 1]; pred[o + 2] += dp[q + 2];
                this._collide(pred, o);
            }
        }
        // ---- velocity from the positions, friction on contact, XSPH viscosity
        const inv_dt = 1 / dt;
        for(let i = 0; i < N; i++) {
            if(cellH[i] < 0) continue;
            const o = i * 4, q = i * 3;
            let vx = (pred[o] - pos[o]) * inv_dt, vy = (pred[o + 1] - pos[o + 1]) * inv_dt, vz = (pred[o + 2] - pos[o + 2]) * inv_dt;
            const d = this.sdf.sample(pred[o], pred[o + 1], pred[o + 2], this._s);
            if(d < this.k.radius * 1.5) {
                const s = this._s, gl = Math.hypot(s[1], s[2], s[3]) || 1;
                const nx = s[1] / gl, ny = s[2] / gl, nz = s[3] / gl;
                const vn = vx * nx + vy * ny + vz * nz;
                const fr = 1 - PHASES[pos[o + 3]].friction;
                vx = (vx - vn * nx) * fr + vn * nx; vy = (vy - vn * ny) * fr + vn * ny; vz = (vz - vn * nz) * fr + vn * nz;
            }
            vt[q] = vx; vt[q + 1] = vy; vt[q + 2] = vz;
        }
        let alive = 0, maxSp = 0, moving = 0;
        const occ = this.stats.occ;
        if(last) occ.fill(0);
        const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
        for(let i = 0; i < N; i++) {
            const o = i * 4, q = i * 3;
            if(cellH[i] < 0) continue;
            const px = pred[o], py = pred[o + 1], pz = pred[o + 2], M = PHASES[pos[o + 3]];
            let ax = 0, ay = 0, az = 0;
            for(let k = 0, base = i * MAXN, c = nn[i]; k < c; k++) {
                const j = nbr[base + k], p = j * 4, v = j * 3;
                const rx = px - pred[p], ry = py - pred[p + 1], rz = pz - pred[p + 2];
                const r2 = rx * rx + ry * ry + rz * rz;
                if(r2 >= h2) continue;
                const w = h2 - r2, W = poly6 * w * w * w / rho0;
                ax += (vt[v] - vt[q]) * W; ay += (vt[v + 1] - vt[q + 1]) * W; az += (vt[v + 2] - vt[q + 2]) * W;
            }
            const vx = vt[q] + M.xsph * ax, vy = vt[q + 1] + M.xsph * ay, vz = vt[q + 2] + M.xsph * az;
            vel[o] = vx; vel[o + 1] = vy; vel[o + 2] = vz;
            pos[o] = px; pos[o + 1] = py; pos[o + 2] = pz;
            const sp = Math.hypot(vx, vy, vz);
            vel[o + 3] = sp < IDLE_SPEED ? vel[o + 3] + dt : 0;
            // recycle: out of the world, or an idle thin film for long enough (evaporated)
            if(px < WORLD_LO[0] || py < WORLD_LO[1] || pz < WORLD_LO[2] || px > WORLD_HI[0] || py > WORLD_HI[1] || pz > WORLD_HI[2]
                || (M.evaporate && vel[o + 3] > EVAPORATE_TIME && dens[i] < EVAPORATE_DENSITY)) { pos[o + 3] = 0; continue; }
            if(last) {
                alive++;
                if(sp > maxSp) maxSp = sp;
                if(sp > MOVING_SPEED) moving++;
                const ci = occIndex(px, py, pz);
                occ[ci >> 5] |= 1 << (ci & 31);
                if(px < mn[0]) mn[0] = px; if(py < mn[1]) mn[1] = py; if(pz < mn[2]) mn[2] = pz;
                if(px > mx[0]) mx[0] = px; if(py > mx[1]) mx[1] = py; if(pz > mx[2]) mx[2] = pz;
            }
        }
        if(last) { const st = this.stats; st.alive = alive; st.moving = moving; st.maxSpeed = maxSp; st.min = mn; st.max = mx; }
    }

    /** Density error over the bulk (particles more than a kernel radius below the surface `top`, default the highest
     *  particle): mean |rho / rho0 - 1|, mean compression (rho > rho0 part), max |error|, count. */
    densityError(top = this.stats.max[1]) {
        let sum = 0, comp = 0, n = 0, max = 0;
        for(let i = 0; i < this.extent; i++) {
            if(this.pos[i * 4 + 3] === 0 || this.pos[i * 4 + 1] > top - this.k.h) continue;
            const e = this.dens[i] - 1;
            sum += Math.abs(e); comp += Math.max(0, e); n++; if(Math.abs(e) > max) max = Math.abs(e);
        }
        return { mean: n ? sum / n : 0, compression: n ? comp / n : 0, max, n };
    }
    /** Fraction of live particles faster than `v` m/s. */
    movingFraction(v) {
        let n = 0, m = 0;
        for(let i = 0; i < this.extent; i++) {
            const o = i * 4;
            if(this.pos[o + 3] === 0) continue;
            n++; if(Math.hypot(this.vel[o], this.vel[o + 1], this.vel[o + 2]) > v) m++;
        }
        return n ? m / n : 0;
    }
}

export function hash(x, y, z) { return (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) >>> 0; }

const _r = [0, 0, 0];
function rotate(vx, vy, vz, qx, qy, qz, qw) {
    // v + 2 q.xyz x (q.xyz x v + w v)
    const cx = qy * vz - qz * vy + qw * vx, cy = qz * vx - qx * vz + qw * vy, cz = qx * vy - qy * vx + qw * vz;
    _r[0] = vx + 2 * (qy * cz - qz * cy); _r[1] = vy + 2 * (qz * cx - qx * cz); _r[2] = vz + 2 * (qx * cy - qy * cx);
    return _r;
}
