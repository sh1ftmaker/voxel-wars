/**
 * PB-MPM on the CPU: "A Position-Based Material Point Method" (Chris Lewin, EA SEED, SIGGRAPH 2024 talk; reference
 * implementation github.com/electronicarts/pbmpm, 2D WebGPU) ported to 3D in plain typed arrays. The same algorithm
 * as the GPU solver (src/mpm/MpmGPU.js): the fallback for the WebGL2 backend (in a worker, src/workers/mpmSim.js)
 * and the solver of the Node tests (tools/test/mpm.mjs). Pure: no DOM, no three.js.
 *
 * Per substep (dt = the frame step: PB-MPM is stable at 60 Hz with a single substep):
 *   repeat `iterations` times:
 *     constraint projection of each particle's deformation displacement D (the PB-MPM step: drive the candidate
 *       deformation gradient F* = (I + D) F towards the material's target: Drucker-Prager sand, corotated snow,
 *       viscoplastic paste), then P2G (APIC: momentum m (d + D (x_i - x_p)) and mass, quadratic B-splines)
 *     grid update: displacement = momentum / mass, then the boundary conditions at the nodes: the zone's walls, the
 *       terrain's SDF (no motion into it, Coulomb friction along it) and the body / player proxies (one-way)
 *     G2P: the particle's displacement d and D = 4 sum w d_i (x_i - x_p)^T
 *   integrate: F = (I + D) F, x += d, plasticity on the SVD of F (sand: Klár et al. 2016 Drucker-Prager return
 *     mapping with logJp; snow: Stomakhin et al. 2013 clamp and hardening; paste: volume-preserving clamp), particle
 *     push-out of the terrain, gravity added to d for the next substep (d is the next step's candidate displacement).
 * Units: positions and displacements in grid cells (H m), a zone's node i at lattice sample lo + i.
 *
 *   const s = new MpmSolverCPU({ cap })
 *   s.setZone(slot, { lo, dims, sdf })   sdf: stored Int8 samples (src/voxel) of the zone's nodes, x + y nx + z nx ny
 *   s.spawn(slot, pos (Float32Array xyz, grid units), vel (m/s, or null), mats (Uint8Array), ppcLog)
 *   s.step(dt)                            one frame: knobs.substeps x (knobs.iterations x P2G/grid/G2P, integrate)
 *   s.zoneStats(slot) -> { count, moving }  s.read(slot) -> { pos (world m), w (packed) }   s.removeZone(slot)
 */
import { H, ZONE_DIMS, MAX_ZONES, CPU_CAP, GUARD, GRAVITY, MAX_PROXIES, SAND, SNOW, VISCO, MAT_ROWS, materialTable, DEFAULT_KNOBS, packW } from './params.js';

const M3 = () => new Float64Array(9);
const SNOW_JMIN = 0.6; // snow packs to 60% of its volume at most

/** SVD of a 3x3 row-major matrix through the Jacobi eigen-decomposition of F^T F (4 cyclic sweeps): F = U diag(S) V^T,
 *  U and V rotations (S[2] carries the sign of det F). */
export function svd3(F, U, S, V) {
    // A = F^T F (symmetric: 6 values), V = I; cyclic Jacobi rotations in scalars
    let a00 = F[0] * F[0] + F[3] * F[3] + F[6] * F[6], a11 = F[1] * F[1] + F[4] * F[4] + F[7] * F[7], a22 = F[2] * F[2] + F[5] * F[5] + F[8] * F[8];
    let a01 = F[0] * F[1] + F[3] * F[4] + F[6] * F[7], a02 = F[0] * F[2] + F[3] * F[5] + F[6] * F[8], a12 = F[1] * F[2] + F[4] * F[5] + F[7] * F[8];
    let v00 = 1, v01 = 0, v02 = 0, v10 = 0, v11 = 1, v12 = 0, v20 = 0, v21 = 0, v22 = 1;
    for(let sweep = 0; sweep < 4; sweep++) {
        if(a01 > 1e-20 || a01 < -1e-20) {
            const th = (a11 - a00) / (2 * a01), t = (th >= 0 ? 1 : -1) / ((th >= 0 ? th : -th) + Math.sqrt(th * th + 1));
            const c = 1 / Math.sqrt(t * t + 1), s = t * c, rp = a02, rq = a12;
            a00 -= t * a01; a11 += t * a01; a01 = 0; a02 = c * rp - s * rq; a12 = s * rp + c * rq;
            { const vp = v00, vq = v01; v00 = c * vp - s * vq; v01 = s * vp + c * vq; }
            { const vp = v10, vq = v11; v10 = c * vp - s * vq; v11 = s * vp + c * vq; }
            { const vp = v20, vq = v21; v20 = c * vp - s * vq; v21 = s * vp + c * vq; }
        }
        if(a02 > 1e-20 || a02 < -1e-20) {
            const th = (a22 - a00) / (2 * a02), t = (th >= 0 ? 1 : -1) / ((th >= 0 ? th : -th) + Math.sqrt(th * th + 1));
            const c = 1 / Math.sqrt(t * t + 1), s = t * c, rp = a01, rq = a12;
            a00 -= t * a02; a22 += t * a02; a02 = 0; a01 = c * rp - s * rq; a12 = s * rp + c * rq;
            { const vp = v00, vq = v02; v00 = c * vp - s * vq; v02 = s * vp + c * vq; }
            { const vp = v10, vq = v12; v10 = c * vp - s * vq; v12 = s * vp + c * vq; }
            { const vp = v20, vq = v22; v20 = c * vp - s * vq; v22 = s * vp + c * vq; }
        }
        if(a12 > 1e-20 || a12 < -1e-20) {
            const th = (a22 - a11) / (2 * a12), t = (th >= 0 ? 1 : -1) / ((th >= 0 ? th : -th) + Math.sqrt(th * th + 1));
            const c = 1 / Math.sqrt(t * t + 1), s = t * c, rp = a01, rq = a02;
            a11 -= t * a12; a22 += t * a12; a12 = 0; a01 = c * rp - s * rq; a02 = s * rp + c * rq;
            { const vp = v01, vq = v02; v01 = c * vp - s * vq; v02 = s * vp + c * vq; }
            { const vp = v11, vq = v12; v11 = c * vp - s * vq; v12 = s * vp + c * vq; }
            { const vp = v21, vq = v22; v21 = c * vp - s * vq; v22 = s * vp + c * vq; }
        }
    }
    V[0] = v00; V[1] = v01; V[2] = v02; V[3] = v10; V[4] = v11; V[5] = v12; V[6] = v20; V[7] = v21; V[8] = v22;
    // U columns: u0 = F v0 / |F v0|, u1 = the part of F v1 orthogonal to u0, u2 = u0 x u1; sigma_i = u_i . F v_i
    const a0 = F[0] * V[0] + F[1] * V[3] + F[2] * V[6], a1 = F[3] * V[0] + F[4] * V[3] + F[5] * V[6], a2 = F[6] * V[0] + F[7] * V[3] + F[8] * V[6];
    const b0 = F[0] * V[1] + F[1] * V[4] + F[2] * V[7], b1 = F[3] * V[1] + F[4] * V[4] + F[5] * V[7], b2 = F[6] * V[1] + F[7] * V[4] + F[8] * V[7];
    const e0 = F[0] * V[2] + F[1] * V[5] + F[2] * V[8], e1 = F[3] * V[2] + F[4] * V[5] + F[5] * V[8], e2 = F[6] * V[2] + F[7] * V[5] + F[8] * V[8];
    let l = Math.sqrt(a0 * a0 + a1 * a1 + a2 * a2);
    let x0, x1, x2;
    if(l > 1e-12) { x0 = a0 / l; x1 = a1 / l; x2 = a2 / l; } else { x0 = V[0]; x1 = V[3]; x2 = V[6]; }
    S[0] = l;
    const pr = x0 * b0 + x1 * b1 + x2 * b2;
    let y0 = b0 - pr * x0, y1 = b1 - pr * x1, y2 = b2 - pr * x2;
    l = Math.sqrt(y0 * y0 + y1 * y1 + y2 * y2);
    if(l > 1e-12) { y0 /= l; y1 /= l; y2 /= l; }
    else { // any unit vector orthogonal to u0
        const k0 = Math.abs(x0) < 0.9 ? 1 : 0, k1 = 1 - k0;
        y0 = x1 * 0 - x2 * k1; y1 = x2 * k0 - x0 * 0; y2 = x0 * k1 - x1 * k0;
        const m = Math.sqrt(y0 * y0 + y1 * y1 + y2 * y2); y0 /= m; y1 /= m; y2 /= m;
    }
    S[1] = y0 * b0 + y1 * b1 + y2 * b2;
    const z0 = x1 * y2 - x2 * y1, z1 = x2 * y0 - x0 * y2, z2 = x0 * y1 - x1 * y0;
    S[2] = z0 * e0 + z1 * e1 + z2 * e2;
    U[0] = x0; U[1] = y0; U[2] = z0; U[3] = x1; U[4] = y1; U[5] = z1; U[6] = x2; U[7] = y2; U[8] = z2;
}

/** Quadratic B-spline weights of the 3 nodes from the base (f = position - base, in [0.5, 1.5)). */
function weights(f, w) { const a = 1.5 - f, b = f - 1, c = f - 0.5; w[0] = 0.5 * a * a; w[1] = 0.75 - b * b; w[2] = 0.5 * c * c; }

/** out = U diag(S) V^T */
function usv(U, S, V, out) {
    for(let r = 0; r < 3; r++) for(let c = 0; c < 3; c++) out[r * 3 + c] = U[r * 3] * S[0] * V[c * 3] + U[r * 3 + 1] * S[1] * V[c * 3 + 1] + U[r * 3 + 2] * S[2] * V[c * 3 + 2];
}
function mul(A, B, out) {
    for(let r = 0; r < 3; r++) for(let c = 0; c < 3; c++) out[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
}
const det = (m) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
function inv(m, out) {
    const d = det(m), k = 1 / (Math.abs(d) > 1e-20 ? d : 1e-20);
    out[0] = (m[4] * m[8] - m[5] * m[7]) * k; out[1] = (m[2] * m[7] - m[1] * m[8]) * k; out[2] = (m[1] * m[5] - m[2] * m[4]) * k;
    out[3] = (m[5] * m[6] - m[3] * m[8]) * k; out[4] = (m[0] * m[8] - m[2] * m[6]) * k; out[5] = (m[2] * m[3] - m[0] * m[5]) * k;
    out[6] = (m[3] * m[7] - m[4] * m[6]) * k; out[7] = (m[1] * m[6] - m[0] * m[7]) * k; out[8] = (m[0] * m[4] - m[1] * m[3]) * k;
}

export class MpmSolverCPU {
    constructor({ cap = CPU_CAP, maxZones = MAX_ZONES } = {}) {
        this.cap = cap; this.n = 0;
        this.x = new Float32Array(cap * 3); this.d = new Float32Array(cap * 3);
        this.F = new Float32Array(cap * 9); this.D = new Float32Array(cap * 9);
        this.w = new Int32Array(cap);       // packW(slot, ppcLog, mat)
        this.pl = new Float32Array(cap);    // sand: logJp; snow: Jp
        this.rest = new Uint16Array(cap);
        this.zones = new Array(maxZones).fill(null);
        this.mt = materialTable();
        this.knobs = { ...DEFAULT_KNOBS };
        this.proxies = [];                  // { c: [x,y,z] m, r: m, v: [x,y,z] m/s } (world)
        this.gravity = GRAVITY;
        this.t = { U: M3(), V: M3(), A: M3(), Fs: M3(), T: M3(), Fi: M3(), G: M3(), S: new Float64Array(3) };
        this.stats = { steps: 0, ms: 0 };
    }

    /** A zone: nodes `dims` at lattice samples lo..lo+dims-1; `sdf` the stored Int8 distances there (32 per voxel). */
    setZone(slot, { lo, dims = ZONE_DIMS, sdf, wall = 0.6 }) {
        const [nx, ny, nz] = dims, N = nx * ny * nz;
        const old = this.zones[slot];
        const z = old && old.N === N ? old : { N, mom: new Float32Array(N * 3), mass: new Float32Array(N), phi: new Float32Array(N), nrm: new Float32Array(N * 3) };
        Object.assign(z, { slot, lo: [...lo], dims: [...dims], wall });
        // phi: distance in grid units (stored / 32), normals: central differences
        for(let i = 0; i < N; i++) z.phi[i] = sdf[i] / 32;
        const nxy = nx * ny;
        for(let k = 0; k < nz; k++) for(let j = 0; j < ny; j++) for(let i = 0; i < nx; i++) {
            const o = i + j * nx + k * nxy, p = z.phi;
            const gx = p[o + (i < nx - 1 ? 1 : 0)] - p[o - (i > 0 ? 1 : 0)];
            const gy = p[o + (j < ny - 1 ? nx : 0)] - p[o - (j > 0 ? nx : 0)];
            const gz = p[o + (k < nz - 1 ? nxy : 0)] - p[o - (k > 0 ? nxy : 0)];
            const l = Math.hypot(gx, gy, gz) || 1;
            z.nrm[o * 3] = gx / l; z.nrm[o * 3 + 1] = gy / l; z.nrm[o * 3 + 2] = gz / l;
        }
        this.zones[slot] = z;
        return z;
    }
    removeZone(slot) {
        this.zones[slot] = null;
        this._compact((w) => (w >> 7) !== slot);
    }
    _compact(keep) {
        let j = 0;
        for(let i = 0; i < this.n; i++) {
            if(!keep(this.w[i])) continue;
            if(i !== j) {
                this.x.copyWithin(j * 3, i * 3, i * 3 + 3); this.d.copyWithin(j * 3, i * 3, i * 3 + 3);
                this.F.copyWithin(j * 9, i * 9, i * 9 + 9); this.D.copyWithin(j * 9, i * 9, i * 9 + 9);
                this.w[j] = this.w[i]; this.pl[j] = this.pl[i]; this.rest[j] = this.rest[i];
            }
            j++;
        }
        this.n = j;
    }
    get free() { return this.cap - this.n; }

    /** Add particles to zone `slot`: pos in the zone's grid units; vel (m/s) per particle or null. Returns how many. */
    spawn(slot, pos, vel, mats, ppcLog, dt = 1 / 60) {
        const z = this.zones[slot];
        const count = Math.min(mats.length, this.free);
        const lo = GUARD, hi = z.dims.map(v => v - 1 - GUARD - 1e-3);
        const k = dt / H;
        for(let q = 0; q < count; q++) {
            const i = this.n++;
            for(let a = 0; a < 3; a++) {
                this.x[i * 3 + a] = Math.min(hi[a], Math.max(lo, pos[q * 3 + a]));
                this.d[i * 3 + a] = vel ? vel[q * 3 + a] * k : 0;
            }
            this.d[i * 3 + 1] -= this.gravity * dt * dt / H;
            this.F.fill(0, i * 9, i * 9 + 9); this.F[i * 9] = this.F[i * 9 + 4] = this.F[i * 9 + 8] = 1;
            this.D.fill(0, i * 9, i * 9 + 9);
            this.w[i] = packW(slot, ppcLog, mats[q]);
            this.pl[i] = this.mt[mats[q] * MAT_ROWS * 4] === SNOW ? 1 : 0;
            this.rest[i] = 0;
        }
        return count;
    }

    step(dt) {
        const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
        const kn = this.knobs, sub = Math.max(1, kn.substeps | 0), h = dt / sub;
        for(let s = 0; s < sub; s++) {
            for(let it = 0; it < Math.max(1, kn.iterations | 0); it++) {
                for(const z of this.zones) if(z) { z.mom.fill(0); z.mass.fill(0); }
                this._constraintP2G();
                for(const z of this.zones) if(z) this._grid(z, h);
                this._g2p();
            }
            this._integrate(h);
        }
        this.stats.steps++;
        if(t0) this.stats.ms = performance.now() - t0;
    }

    // ---------------------------------------------------------------- kernels

    _constraintP2G() {
        const { x, d, F, D, w, pl, mt } = this, T = this.t, rs = this.knobs.relaxScale;
        const Fp = M3(), Dp = M3(), wx = new Float64Array(3), wy = new Float64Array(3), wz = new Float64Array(3);
        for(let p = 0; p < this.n; p++) {
            const z = this.zones[w[p] >> 7];
            if(!z) continue;
            const m = w[p] & 31, mo = m * MAT_ROWS * 4;
            for(let i = 0; i < 9; i++) { Fp[i] = F[p * 9 + i]; Dp[i] = D[p * 9 + i]; }
            this._project(Fp, Dp, mt, mo, pl[p], rs, T);
            for(let i = 0; i < 9; i++) D[p * 9 + i] = Dp[i];
            // P2G
            const mass = mt[mo + 11];
            const px = x[p * 3], py = x[p * 3 + 1], pz = x[p * 3 + 2];
            const bx = Math.floor(px - 0.5), by = Math.floor(py - 0.5), bz = Math.floor(pz - 0.5);
            const fx = px - bx, fy = py - by, fz = pz - bz;
            weights(fx, wx); weights(fy, wy); weights(fz, wz);
            const nx = z.dims[0], nxy = nx * z.dims[1];
            const dx = d[p * 3], dy = d[p * 3 + 1], dz = d[p * 3 + 2];
            for(let c = 0; c < 3; c++) for(let b = 0; b < 3; b++) for(let a = 0; a < 3; a++) {
                const wm = wx[a] * wy[b] * wz[c] * mass;
                const ox = a - fx, oy = b - fy, oz = c - fz;
                const o = (bx + a) + (by + b) * nx + (bz + c) * nxy;
                z.mom[o * 3] += wm * (dx + Dp[0] * ox + Dp[1] * oy + Dp[2] * oz);
                z.mom[o * 3 + 1] += wm * (dy + Dp[3] * ox + Dp[4] * oy + Dp[5] * oz);
                z.mom[o * 3 + 2] += wm * (dz + Dp[6] * ox + Dp[7] * oy + Dp[8] * oz);
                z.mass[o] += wm;
            }
        }
    }

    /** The PB-MPM constraint projection of one particle's D (in place). */
    _project(Fp, Dp, mt, mo, plp, rs, T) {
        const model = mt[mo];
        const Fs = T.Fs, U = T.U, V = T.V, S = T.S, G = T.G, Fi = T.Fi;
        // F* = (I + D) F
        for(let r = 0; r < 3; r++) for(let c = 0; c < 3; c++) Fs[r * 3 + c] = Fp[r * 3 + c] + Dp[r * 3] * Fp[c] + Dp[r * 3 + 1] * Fp[3 + c] + Dp[r * 3 + 2] * Fp[6 + c];
        svd3(Fs, U, S, V);
        let relax = mt[mo + 3] * rs;
        const alpha = mt[mo + 5];
        if(model === SAND) {
            // resist compression only (sand cannot pull): stretches below 1 go back to 1 unless it is dilating
            // cohesion (dirt): stretching past e^cohesion is resisted too, so clods hold together
            const coh = mt[mo + 2], smax = coh > 0 ? Math.exp(coh) : 1000;
            const dF = S[0] * S[1] * S[2];
            if(plp === 0) for(let i = 0; i < 3; i++) S[i] = Math.min(smax, Math.max(1, S[i]));
            usv(U, S, V, G);
            // blended with the volume target (only compression is pushed back)
            if(alpha < 1) { const cd = Math.cbrt(Math.min(1, Math.max(0.1, Math.abs(dF)))) * (dF < 0 ? -1 : 1); for(let i = 0; i < 9; i++) G[i] = alpha * G[i] + (1 - alpha) * Fs[i] / cd; }
        } else {
            if(model === SNOW) relax = Math.min(1, relax * Math.max(0.1, Math.exp(mt[mo + 8] * (1 - plp)))); // Stomakhin hardening (a relaxation past 1 diverges)
            // corotated shape target R = U V^T blended with the volume target F* / det^(1/3)
            const dF = S[0] * S[1] * S[2], cd = Math.cbrt(Math.min(1000, Math.max(0.1, Math.abs(dF)))) * (dF < 0 ? -1 : 1);
            S[0] = S[1] = S[2] = 1;
            usv(U, S, V, G);
            if(alpha < 1) for(let i = 0; i < 9; i++) G[i] = alpha * G[i] + (1 - alpha) * Fs[i] / cd;
        }
        // D += relax ((target F^-1 - I) - D)
        inv(Fp, Fi);
        mul(G, Fi, T.T);
        const tg = T.T;
        tg[0] -= 1; tg[4] -= 1; tg[8] -= 1;
        for(let i = 0; i < 9; i++) Dp[i] += relax * (tg[i] - Dp[i]);
        // viscosity: damp the symmetric part (the rate of strain)
        const visc = mt[mo + 4] * rs;
        if(visc > 0) {
            for(let r = 0; r < 3; r++) for(let c = r; c < 3; c++) {
                const sym = Dp[r * 3 + c] + Dp[c * 3 + r];
                Dp[r * 3 + c] -= visc * 0.5 * sym;
                if(c !== r) Dp[c * 3 + r] -= visc * 0.5 * sym;
            }
        }
    }

    _grid(z, dt) {
        const wallAxis = (idx, n, g) => (idx <= GUARD && g < 0) || (idx >= n - 1 - GUARD && g > 0);
        const [nx, ny, nz] = z.dims, nxy = nx * ny, mom = z.mom, mass = z.mass, phi = z.phi, nrm = z.nrm;
        const mu = z.wall;
        const k = dt / H;
        const prox = this.proxies.slice(0, MAX_PROXIES).map(p => ({
            c: [p.c[0] / H - z.lo[0], p.c[1] / H - z.lo[1], p.c[2] / H - z.lo[2]], r: p.r / H + 0.5, v: p.v.map(x => x * k) }));
        for(let kk = 0; kk < nz; kk++) for(let j = 0; j < ny; j++) for(let i = 0; i < nx; i++) {
            const o = i + j * nx + kk * nxy;
            const m = mass[o];
            if(m < 1e-6) { mom[o * 3] = mom[o * 3 + 1] = mom[o * 3 + 2] = 0; continue; }
            let gx = mom[o * 3] / m, gy = mom[o * 3 + 1] / m, gz = mom[o * 3 + 2] / m;
            // terrain: no motion into it (a node within one cell of the surface may close the gap), Coulomb friction along it
            const f = phi[o];
            if(f < -1.5) { gx = gy = gz = 0; }
            else if(f < 1) {
                const ex = nrm[o * 3], ey = nrm[o * 3 + 1], ez = nrm[o * 3 + 2];
                const vn = gx * ex + gy * ey + gz * ez, tgt = Math.max(vn, -Math.max(f, 0)), dn = tgt - vn;
                if(dn > 0) {
                    let tx = gx - vn * ex, ty = gy - vn * ey, tz = gz - vn * ez;
                    const lt = Math.hypot(tx, ty, tz), s = lt > 1e-9 ? Math.max(0, 1 - mu * dn / lt) : 0;
                    gx = tgt * ex + tx * s; gy = tgt * ey + ty * s; gz = tgt * ez + tz * s;
                }
            }
            // bodies and the player: one-way, pushing the material out of their spheres at their velocity
            for(const p of prox) {
                const rx = i - p.c[0], ry = j - p.c[1], rz = kk - p.c[2], l = Math.hypot(rx, ry, rz);
                if(l >= p.r || l < 1e-6) continue;
                const ex = rx / l, ey = ry / l, ez = rz / l;
                const vn = gx * ex + gy * ey + gz * ez, pv = p.v[0] * ex + p.v[1] * ey + p.v[2] * ez + (p.r - l) * 0.5;
                if(vn < pv) { gx += (pv - vn) * ex; gy += (pv - vn) * ey; gz += (pv - vn) * ez; }
            }
            // the zone's walls (the guardian of the reference): no motion out through them, friction along them
            if(wallAxis(i, nx, gx)) { gx = 0; gy *= 1 - mu; gz *= 1 - mu; }
            if(wallAxis(j, ny, gy)) { gy = 0; gx *= 1 - mu; gz *= 1 - mu; }
            if(wallAxis(kk, nz, gz)) { gz = 0; gx *= 1 - mu; gy *= 1 - mu; }
            mom[o * 3] = gx; mom[o * 3 + 1] = gy; mom[o * 3 + 2] = gz;
        }
    }

    _g2p() {
        const { x, d, D, w } = this;
        const wx = new Float64Array(3), wy = new Float64Array(3), wz = new Float64Array(3), B = new Float64Array(9);
        for(let p = 0; p < this.n; p++) {
            const z = this.zones[w[p] >> 7];
            if(!z) continue;
            const g = z.mom;
            const px = x[p * 3], py = x[p * 3 + 1], pz = x[p * 3 + 2];
            const bx = Math.floor(px - 0.5), by = Math.floor(py - 0.5), bz = Math.floor(pz - 0.5);
            const fx = px - bx, fy = py - by, fz = pz - bz;
            weights(fx, wx); weights(fy, wy); weights(fz, wz);
            const nx = z.dims[0], nxy = nx * z.dims[1];
            let dx = 0, dy = 0, dz = 0;
            B.fill(0);
            for(let c = 0; c < 3; c++) for(let b = 0; b < 3; b++) for(let a = 0; a < 3; a++) {
                const wt = wx[a] * wy[b] * wz[c];
                const o = ((bx + a) + (by + b) * nx + (bz + c) * nxy) * 3;
                const gx = g[o] * wt, gy = g[o + 1] * wt, gz = g[o + 2] * wt;
                const ox = a - fx, oy = b - fy, oz = c - fz;
                dx += gx; dy += gy; dz += gz;
                B[0] += gx * ox; B[1] += gx * oy; B[2] += gx * oz;
                B[3] += gy * ox; B[4] += gy * oy; B[5] += gy * oz;
                B[6] += gz * ox; B[7] += gz * oy; B[8] += gz * oz;
            }
            d[p * 3] = dx; d[p * 3 + 1] = dy; d[p * 3 + 2] = dz;
            for(let i = 0; i < 9; i++) D[p * 9 + i] = 4 * B[i];
        }
    }

    _integrate(dt) {
        const { x, d, F, D, w, pl, rest, mt } = this, T = this.t, kn = this.knobs;
        const U = T.U, V = T.V, S = T.S, Fn = T.Fs;
        const restD = kn.restSpeed * dt / H, gstep = this.gravity * dt * dt / H, maxStep = kn.maxStep;
        for(let p = 0; p < this.n; p++) {
            const z = this.zones[w[p] >> 7];
            if(!z) continue;
            const m = w[p] & 31, mo = m * MAT_ROWS * 4, model = mt[mo];
            // F = (I + D) F
            const f = p * 9;
            for(let r = 0; r < 3; r++) for(let c = 0; c < 3; c++) Fn[r * 3 + c] = F[f + r * 3 + c] + D[f + r * 3] * F[f + c] + D[f + r * 3 + 1] * F[f + 3 + c] + D[f + r * 3 + 2] * F[f + 6 + c];
            svd3(Fn, U, S, V);
            // the safety clamp of the reference; sand also forgets compression past minStretch (a hard landing
            // compacts it instead of storing a rebound)
            const smin = mt[mo + 13];
            for(let i = 0; i < 3; i++) S[i] = Math.min(1e4, Math.max(smin, S[i]));
            if(model === SAND) {
                // Drucker-Prager return mapping in log strain (Klár et al. 2016), with logJp volume memory (PB-MPM)
                const alphaDP = mt[mo + 1], coh = mt[mo + 2];
                const e0 = Math.log(S[0]), e1 = Math.log(S[1]), e2 = Math.log(S[2]);
                const tr = e0 + e1 + e2 + pl[p];
                if(tr >= coh) { S[0] = S[1] = S[2] = 1; pl[p] = 0.5 * tr; }
                else {
                    pl[p] = 0;
                    const m3 = (e0 + e1 + e2) / 3, h0 = e0 - m3, h1 = e1 - m3, h2 = e2 - m3;
                    const frob = Math.sqrt(h0 * h0 + h1 * h1 + h2 * h2);
                    const dg = frob + 2.5 * tr * alphaDP;
                    if(dg > 0 && frob > 1e-9) { const k = dg / frob; S[0] = Math.exp(e0 - k * h0); S[1] = Math.exp(e1 - k * h1); S[2] = Math.exp(e2 - k * h2); }
                }
            } else if(model === SNOW) {
                const thC = mt[mo + 6], thS = mt[mo + 7];
                const J0 = S[0] * S[1] * S[2];
                // fully packed snow (Jp at SNOW_JMIN) compresses no further: its compression stays elastic
                const lo = pl[p] > SNOW_JMIN ? 1 - thC : 0.1;
                for(let i = 0; i < 3; i++) S[i] = Math.min(1 + thS, Math.max(lo, S[i]));
                pl[p] = Math.min(5, Math.max(SNOW_JMIN, pl[p] * J0 / (S[0] * S[1] * S[2])));
            } else if(model === VISCO) {
                const y = Math.exp(mt[mo + 9]);
                const J0 = S[0] * S[1] * S[2];
                for(let i = 0; i < 3; i++) S[i] = Math.min(y, Math.max(1 / y, S[i]));
                const k = Math.cbrt(J0 / (S[0] * S[1] * S[2]));
                S[0] *= k; S[1] *= k; S[2] *= k;
            }
            usv(U, S, V, Fn);
            for(let i = 0; i < 9; i++) F[f + i] = Fn[i];
            // position, rest, gravity for the next step
            const q = p * 3;
            let dx = d[q], dy = d[q + 1], dz = d[q + 2];
            // CFL: at most maxStep cells per step (a grain faster than the grid can carry piles into the cell ahead)
            const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if(dl > maxStep) { const k = maxStep / dl; dx *= k; dy *= k; dz *= k; }
            x[q] += dx; x[q + 1] += dy; x[q + 2] += dz;
            rest[p] = dx * dx + dy * dy + dz * dz < restD * restD ? Math.min(65535, rest[p] + 1) : 0;
            // push out of the terrain (most of it is done at the nodes already)
            const ph = this._phi(z, x[q], x[q + 1], x[q + 2]);
            if(ph.v < 0) {
                x[q] -= ph.v * ph.n[0]; x[q + 1] -= ph.v * ph.n[1]; x[q + 2] -= ph.v * ph.n[2];
                const vn = dx * ph.n[0] + dy * ph.n[1] + dz * ph.n[2];
                if(vn < 0) { dx -= vn * ph.n[0]; dy -= vn * ph.n[1]; dz -= vn * ph.n[2]; }
            }
            for(let a = 0; a < 3; a++) x[q + a] = Math.min(z.dims[a] - 1 - GUARD - 1e-3, Math.max(GUARD, x[q + a]));
            d[q] = dx; d[q + 1] = dy - gstep; d[q + 2] = dz;
        }
    }

    /** Trilinear terrain distance (grid units) and normal at a zone-local point. */
    _phi(z, px, py, pz) {
        const nx = z.dims[0], nxy = nx * z.dims[1];
        const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
        const tx = px - ix, ty = py - iy, tz = pz - iz;
        let v = 0; const r = this._phiOut ||= { v: 0, n: [0, 0, 0] }, n = r.n; n[0] = n[1] = n[2] = 0;
        for(let c = 0; c < 2; c++) for(let b = 0; b < 2; b++) for(let a = 0; a < 2; a++) {
            const wt = (a ? tx : 1 - tx) * (b ? ty : 1 - ty) * (c ? tz : 1 - tz), o = (ix + a) + (iy + b) * nx + (iz + c) * nxy;
            v += z.phi[o] * wt; n[0] += z.nrm[o * 3] * wt; n[1] += z.nrm[o * 3 + 1] * wt; n[2] += z.nrm[o * 3 + 2] * wt;
        }
        const l = Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]) || 1;
        n[0] /= l; n[1] /= l; n[2] /= l;
        r.v = v;
        return r;
    }

    zoneStats(slot) {
        let count = 0, moving = 0;
        const rf = this.knobs.restFrames;
        for(let p = 0; p < this.n; p++) if((this.w[p] >> 7) === slot) { count++; if(this.rest[p] < rf) moving++; }
        return { count, moving };
    }
    /** The zone's particles in world metres and their packed words. */
    read(slot) {
        const z = this.zones[slot];
        const idx = [];
        for(let p = 0; p < this.n; p++) if((this.w[p] >> 7) === slot) idx.push(p);
        const pos = new Float32Array(idx.length * 3), w = new Int32Array(idx.length);
        idx.forEach((p, i) => { for(let a = 0; a < 3; a++) pos[i * 3 + a] = (z.lo[a] + this.x[p * 3 + a]) * H; w[i] = this.w[p]; });
        return { pos, w };
    }
}
