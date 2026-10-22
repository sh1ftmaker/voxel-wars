/**
 * PB-MPM on the GPU (WebGPU compute through TSL): the same solver as src/mpm/cpuSolver.js (read that file's header
 * for the algorithm), a 3D port of EA SEED's reference g2p2g.wgsl (github.com/electronicarts/pbmpm, BSD-3).
 *
 * Buffers (MAX_ZONES slots, PER_ZONE particles each: slot s owns particles [s * PER_ZONE, s * PER_ZONE + count)):
 *   pos   vec4  xyz zone-local grid units, w packed word (params.js packW; < 0 dead)
 *   disp  vec4  d xyz (grid units per step: the candidate displacement), w rest counter (substeps)
 *   F, Dm vec4 x3 per particle: the deformation gradient and the deformation displacement, rows; F[0].w = logJp / Jp
 *   acc   i32 atomics, 4 per node (momentum xyz, mass) in fixed point (FIXED): the P2G target, cleared by the grid pass
 *   grid  vec4 per node: the node's displacement after the boundary conditions (xyz), mass (w)
 *   field vec4 per node: the terrain's outward normal (xyz), distance in grid units (w): uploaded once per zone
 *   params (CPU mirror P): slotA[s] = (lattice origin xyz, active), slotB[s] = (wall friction, -, -, -),
 *          proxA[k] = (centre m, radius m), proxB[k] = (velocity m/s, active), glob = (gravity step (cells), rest
 *          step (cells), relax scale, rest frames), glob2 = (dt / H: m/s to cells per step, max cells per step (CFL), -, -)
 *   stats u32 atomics, 2 per slot: (particles, moving) when counted (statsPass)
 *
 * Kernels per substep (iterations K): p2gFirst, grid, (g2pP2g, grid) x (K - 1), g2pIntegrate. P2G uses global
 * fixed-point atomicAdd (WebGPU has no float atomics).
 */
import * as THREE from 'three/webgpu';
import {
    Fn, If, Return, instanceIndex, instancedArray, uniformArray, float, int, uint, vec3, vec4, ivec3,
    dot, cross, length, max, min, abs, sqrt, exp, log, pow, select, clamp, floor, round, normalize, inverseSqrt, sign,
    atomicAdd, atomicLoad, atomicStore,
} from 'three/tsl';
import { ZONE_DIMS, MAX_ZONES, PER_ZONE, GUARD, FIXED, MAX_PROXIES, SAND, SNOW, VISCO, MAT_ROWS, materialTable } from './params.js';

const WG = 64;
const [NX, NY, NZ] = ZONE_DIMS, NXY = NX * NY, NODES = NX * NY * NZ;
export const CAP = MAX_ZONES * PER_ZONE;
const SNOW_JMIN = 0.6;
const P_SLOTA = 0, P_SLOTB = MAX_ZONES, P_PROXA = 2 * MAX_ZONES, P_PROXB = P_PROXA + MAX_PROXIES, P_GLOB = P_PROXB + MAX_PROXIES, P_GLOB2 = P_GLOB + 1, PARAMS = P_GLOB + 2;

// ---------------------------------------------------------------- 3x3 helpers (matrices as rows of vec3 nodes)
const mulMM = (A, B) => A.map((a) => B[0].mul(a.x).add(B[1].mul(a.y)).add(B[2].mul(a.z)));
const C = ['x', 'y', 'z'];
const col = (M, i) => vec3(M[0][C[i]], M[1][C[i]], M[2][C[i]]);
const v = (n) => n.toVar();
function inverse3(M) {
    const c0 = v(cross(M[1], M[2])), c1 = v(cross(M[2], M[0])), c2 = v(cross(M[0], M[1]));
    const d = dot(M[0], c0);
    const k = v(float(1).div(select(abs(d).greaterThan(1e-20), d, float(1e-20))));
    return [vec3(c0.x, c1.x, c2.x).mul(k), vec3(c0.y, c1.y, c2.y).mul(k), vec3(c0.z, c1.z, c2.z).mul(k)];
}
/** SVD through the Jacobi eigen-decomposition of F^T F (4 cyclic sweeps, as svd3 in cpuSolver.js): returns
 *  { U: [u0, u1, u2] columns, S: vec3, V: [v0, v1, v2] columns }. */
function svd3(F) {
    const c = [0, 1, 2].map(i => v(col(F, i)));
    const a = { '00': v(dot(c[0], c[0])), '11': v(dot(c[1], c[1])), '22': v(dot(c[2], c[2])), '01': v(dot(c[0], c[1])), '02': v(dot(c[0], c[2])), '12': v(dot(c[1], c[2])) };
    const A = (i, j) => a[i < j ? `${i}${j}` : `${j}${i}`];
    const V = [v(vec3(1, 0, 0)), v(vec3(0, 1, 0)), v(vec3(0, 0, 1))];
    for(let sweep = 0; sweep < 4; sweep++) for(const [p, q, r] of [[0, 1, 2], [0, 2, 1], [1, 2, 0]]) {
        const apq = v(A(p, q)), app = v(A(p, p)), aqq = v(A(q, q)), arp = v(A(r, p)), arq = v(A(r, q));
        const ok = abs(apq).greaterThan(1e-20);
        const theta = aqq.sub(app).div(select(ok, apq, float(1)).mul(2));
        const t = v(select(ok, sign(theta).add(select(theta.equal(0), float(1), float(0))).div(abs(theta).add(sqrt(theta.mul(theta).add(1)))), float(0)));
        const cs = v(inverseSqrt(t.mul(t).add(1))), sn = v(t.mul(cs));
        A(p, p).assign(app.sub(t.mul(apq))); A(q, q).assign(aqq.add(t.mul(apq))); A(p, q).assign(0);
        A(r, p).assign(cs.mul(arp).sub(sn.mul(arq))); A(r, q).assign(sn.mul(arp).add(cs.mul(arq)));
        const vp = v(V[p]), vq = v(V[q]);
        V[p].assign(vp.mul(cs).sub(vq.mul(sn))); V[q].assign(vp.mul(sn).add(vq.mul(cs)));
    }
    const fv = (x) => vec3(dot(F[0], x), dot(F[1], x), dot(F[2], x));
    const f0 = v(fv(V[0])), f1 = v(fv(V[1])), f2 = v(fv(V[2]));
    const l0 = v(length(f0));
    const u0 = v(select(l0.greaterThan(1e-12), f0.div(max(l0, 1e-12)), V[0]));
    const w1 = v(f1.sub(u0.mul(dot(u0, f1))));
    const l1 = v(length(w1));
    const alt = normalize(cross(u0, select(abs(u0.x).lessThan(0.9), vec3(1, 0, 0), vec3(0, 1, 0))));
    const u1 = v(select(l1.greaterThan(1e-12), w1.div(max(l1, 1e-12)), alt));
    const u2 = v(cross(u0, u1));
    return { U: [u0, u1, u2], S: v(vec3(l0, dot(u1, f1), dot(u2, f2))), V };
}
/** rows of U diag(S) V^T */
const usv = ({ U, V }, S) => [0, 1, 2].map(r => V[0].mul(S.x.mul(U[0][C[r]])).add(V[1].mul(S.y.mul(U[1][C[r]]))).add(V[2].mul(S.z.mul(U[2][C[r]]))));

/** Quadratic B-spline stencil of a particle at p (grid units): base node, fraction, weights per axis. */
function stencil(p) {
    const b = v(floor(p.sub(0.5)));
    const f = v(p.sub(b));
    const w0 = v(f.sub(1.5).mul(f.sub(1.5)).mul(0.5)), w1 = v(float(0.75).sub(f.sub(1).mul(f.sub(1)))), w2 = v(f.sub(0.5).mul(f.sub(0.5)).mul(0.5));
    return { b: v(ivec3(b)), f, W: [w0, w1, w2] };
}

export class MpmGPU {
    constructor(renderer) {
        this.renderer = renderer;
        this.pos = instancedArray(new Float32Array(CAP * 4).fill(-1), 'vec4');
        this.disp = instancedArray(CAP, 'vec4');
        this.F = instancedArray(CAP * 3, 'vec4');
        this.Dm = instancedArray(CAP * 3, 'vec4');
        this.acc = instancedArray(new Int32Array(MAX_ZONES * NODES * 4), 'int').toAtomic();
        this.grid = instancedArray(MAX_ZONES * NODES, 'vec4');
        this.field = instancedArray(new Float32Array(MAX_ZONES * NODES * 4), 'vec4');
        this.stats = instancedArray(new Uint32Array(MAX_ZONES * 2), 'uint').toAtomic();
        this.statsOut = instancedArray(new Uint32Array(MAX_ZONES * 2), 'uint');
        this.P = new Float32Array(PARAMS * 4);
        this.params = instancedArray(this.P, 'vec4');
        const mt = materialTable(), rows = [];
        for(let i = 0; i < mt.length; i += 4) rows.push(new THREE.Vector4(mt[i], mt[i + 1], mt[i + 2], mt[i + 3]));
        this.mat = uniformArray(rows, 'vec4');
        this.counts = new Array(MAX_ZONES).fill(0);
        this.maxSlot = -1;
        this._kernels();
    }

    // ---------------------------------------------------------------- parameters (CPU mirror)
    _set(row, x, y, z, w) { const o = row * 4, a = this.P; a[o] = x; a[o + 1] = y; a[o + 2] = z; a[o + 3] = w; this.dirty = true; }
    setGlobals({ gstep, restD, relaxScale, restFrames, vscale, maxStep = 1 }) { this._set(P_GLOB, gstep, restD, relaxScale, restFrames); this._set(P_GLOB2, vscale, maxStep, 0, 0); }
    setProxies(list) {
        for(let k = 0; k < MAX_PROXIES; k++) {
            const p = list[k];
            if(p) { this._set(P_PROXA + k, p.c[0], p.c[1], p.c[2], p.r); this._set(P_PROXB + k, p.v[0], p.v[1], p.v[2], 1); }
            else if(this.P[(P_PROXB + k) * 4 + 3] !== 0) this._set(P_PROXB + k, 0, 0, 0, 0);
        }
    }
    flush() { if(this.dirty) { this.dirty = false; this.params.value.needsUpdate = true; } }

    /** Upload a zone's terrain field (normals + distance from the stored samples) and activate slot s. */
    setZone(s, { lo, sdf, wall = 0.6 }) {
        const f = this.field.value, a = f.array, base = s * NODES * 4;
        for(let k = 0; k < NZ; k++) for(let j = 0; j < NY; j++) for(let i = 0; i < NX; i++) {
            const o = i + j * NX + k * NXY;
            const gx = sdf[o + (i < NX - 1 ? 1 : 0)] - sdf[o - (i > 0 ? 1 : 0)];
            const gy = sdf[o + (j < NY - 1 ? NX : 0)] - sdf[o - (j > 0 ? NX : 0)];
            const gz = sdf[o + (k < NZ - 1 ? NXY : 0)] - sdf[o - (k > 0 ? NXY : 0)];
            const l = Math.hypot(gx, gy, gz) || 1, q = base + o * 4;
            a[q] = gx / l; a[q + 1] = gy / l; a[q + 2] = gz / l; a[q + 3] = sdf[o] / 32;
        }
        f.addUpdateRange(base, NODES * 4);
        f.needsUpdate = true;
        this._set(P_SLOTA + s, lo[0], lo[1], lo[2], 1);
        this._set(P_SLOTB + s, wall, 0, 0, 0);
        this.maxSlot = Math.max(this.maxSlot, s);
    }
    /** Deactivate slot s (its particles stop and vanish at once). */
    removeZone(s) {
        this._set(P_SLOTA + s, 0, 0, 0, 0);
        this.counts[s] = 0;
        // mark the range dead (a later zone in this slot may hold fewer particles)
        const a = this.pos.value.array, o = s * PER_ZONE * 4;
        a.fill(-1, o, o + PER_ZONE * 4);
        this.pos.value.addUpdateRange(o, PER_ZONE * 4);
        this.pos.value.needsUpdate = true;
        while(this.maxSlot >= 0 && this.P[(P_SLOTA + this.maxSlot) * 4 + 3] === 0) this.maxSlot--;
    }
    /** Append particles (zone-local grid units, vel m/s) to slot s. Returns how many fit. */
    spawn(s, { pos, vel, mats, ppcLog }, { dt, gravity, H, packW, isSnow }) {
        const n = Math.min(mats.length, PER_ZONE - this.counts[s]);
        if(n <= 0) return 0;
        const i0 = s * PER_ZONE + this.counts[s];
        const P = this.pos.value, Dsp = this.disp.value, F = this.F.value, D = this.Dm.value;
        const k = dt / H, g = gravity * dt * dt / H;
        for(let q = 0; q < n; q++) {
            const i = i0 + q;
            P.array.set([pos[q * 3], pos[q * 3 + 1], pos[q * 3 + 2], packW(s, ppcLog, mats[q])], i * 4);
            Dsp.array.set([vel ? vel[q * 3] * k : 0, (vel ? vel[q * 3 + 1] * k : 0) - g, vel ? vel[q * 3 + 2] * k : 0, 0], i * 4);
            F.array.set([1, 0, 0, isSnow(mats[q]) ? 1 : 0, 0, 1, 0, 0, 0, 0, 1, 0], i * 12);
            D.array.fill(0, i * 12, i * 12 + 12);
        }
        for(const [attr, w] of [[P, 4], [Dsp, 4], [F, 12], [D, 12]]) { attr.addUpdateRange(i0 * w, n * w); attr.needsUpdate = true; }
        this.counts[s] += n;
        return n;
    }

    // ---------------------------------------------------------------- kernels
    _kernels() {
        const { pos, disp, F, Dm, acc, grid, field, params, mat, stats } = this;
        const K = (fn, n) => Fn(fn)().compute(n, [WG]);
        const prm = (row) => params.element(int(row));
        const matRow = (m, r) => mat.element(m.mul(MAT_ROWS).add(r));

        /** Load particle i: null-returns for dead ones / inactive slots. */
        const load = () => {
            const i = v(int(instanceIndex));
            const slot = v(i.div(PER_ZONE));
            const P = v(pos.element(i));
            If(P.w.lessThan(0).or(prm(int(P_SLOTA).add(slot)).w.lessThan(0.5)), () => { Return(); });
            const m = v(int(P.w).bitAnd(31));
            return { i, slot, P, m };
        };
        const rows = (buf, i) => [0, 1, 2].map(r => v(buf.element(i.mul(3).add(r))));

        /** The PB-MPM constraint projection: returns the new rows of D. */
        const project = (Fr, Dr, pl, m) => {
            const r0 = v(matRow(m, 0)), r1 = v(matRow(m, 1)), r2 = v(matRow(m, 2));
            const model = v(int(r0.x));
            const F3 = Fr.map(x => x.xyz), D3 = Dr.map(x => x.xyz);
            const Fs = F3.map((f, i) => v(f.add(F3[0].mul(D3[i].x)).add(F3[1].mul(D3[i].y)).add(F3[2].mul(D3[i].z))));
            const sv = svd3(Fs);
            const isSand = model.equal(SAND);
            const smax = select(r0.z.greaterThan(0), exp(r0.z), float(1000));
            const Sc = v(select(isSand, select(pl.equal(0), clamp(sv.S, vec3(1), vec3(smax)), sv.S), vec3(1)));
            const G = usv(sv, Sc).map(v);
            // blend with the volume target F* / det^(1/3) (sand: only compression pushed back)
            const dF = v(sv.S.x.mul(sv.S.y).mul(sv.S.z));
            const cd = v(pow(clamp(abs(dF), 0.1, select(isSand, float(1), float(1000))), 1 / 3).mul(select(dF.lessThan(0), float(-1), float(1))));
            const alpha = r1.y;
            const Gb = G.map((g, i) => g.mul(alpha).add(Fs[i].div(cd).mul(float(1).sub(alpha))));
            const relax0 = v(r0.w.mul(prm(P_GLOB).z));
            const relax = select(model.equal(SNOW), min(float(1), relax0.mul(max(float(0.1), exp(r2.x.mul(float(1).sub(pl)))))), relax0);
            const T = mulMM(Gb, inverse3(F3));
            const Dn = D3.map((d, i) => v(d.add(T[i].sub(vec3(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0)).sub(d).mul(relax))));
            // viscosity: damp the symmetric part
            const visc = v(r1.x.mul(prm(P_GLOB).z).mul(0.5));
            return Dn.map((d, i) => d.sub(d.add(col(Dn, i)).mul(visc)));
        };

        /** P2G of one particle: fixed-point atomics into its slot's accumulator. */
        const p2g = (slot, P, d, D, m) => {
            const { b, f, W } = stencil(P.xyz);
            const mass = v(matRow(m, 2).w);
            const nodeBase = v(slot.mul(NODES).add(b.x).add(b.y.mul(NX)).add(b.z.mul(NXY)));
            for(let c = 0; c < 3; c++) for(let bb = 0; bb < 3; bb++) for(let a = 0; a < 3; a++) {
                const wm = v(W[a].x.mul(W[bb].y).mul(W[c].z).mul(mass));
                const off = vec3(float(a).sub(f.x), float(bb).sub(f.y), float(c).sub(f.z));
                const mom = d.add(vec3(dot(D[0], off), dot(D[1], off), dot(D[2], off))).mul(wm);
                const q = v(nodeBase.add(a + bb * NX + c * NXY).mul(4));
                const fx = (x) => int(round(clamp(x, -2000, 2000).mul(FIXED)));
                atomicAdd(acc.element(q), fx(mom.x));
                atomicAdd(acc.element(q.add(1)), fx(mom.y));
                atomicAdd(acc.element(q.add(2)), fx(mom.z));
                atomicAdd(acc.element(q.add(3)), fx(wm));
            }
        };

        /** G2P: d and D (rows) from the grid. */
        const g2p = (slot, P) => {
            const { b, f, W } = stencil(P.xyz);
            const nodeBase = v(slot.mul(NODES).add(b.x).add(b.y.mul(NX)).add(b.z.mul(NXY)));
            const d = v(vec3(0)), B = [v(vec3(0)), v(vec3(0)), v(vec3(0))];
            for(let c = 0; c < 3; c++) for(let bb = 0; bb < 3; bb++) for(let a = 0; a < 3; a++) {
                const wt = W[a].x.mul(W[bb].y).mul(W[c].z);
                const g = v(grid.element(nodeBase.add(a + bb * NX + c * NXY)).xyz.mul(wt));
                const off = vec3(float(a).sub(f.x), float(bb).sub(f.y), float(c).sub(f.z));
                d.addAssign(g);
                B[0].addAssign(off.mul(g.x)); B[1].addAssign(off.mul(g.y)); B[2].addAssign(off.mul(g.z));
            }
            return { d, D: B.map(x => v(x.mul(4))) };
        };

        const constraintAndP2G = (L, d, Drows) => {
            const Fr = rows(F, L.i);
            const pl = v(Fr[0].w);
            const Dn = project(Fr, Drows.map(x => vec4(x, 0)), pl, L.m).map(v);
            for(let r = 0; r < 3; r++) Dm.element(L.i.mul(3).add(r)).assign(vec4(Dn[r], 0));
            p2g(L.slot, L.P, d, Dn, L.m);
        };

        this.p2gFirst = K(() => {
            const L = load();
            const Dr = rows(Dm, L.i);
            constraintAndP2G(L, v(disp.element(L.i).xyz), Dr.map(x => x.xyz));
        }, CAP);

        this.g2pP2g = K(() => {
            const L = load();
            const { d, D } = g2p(L.slot, L.P);
            disp.element(L.i).xyz.assign(d);
            constraintAndP2G(L, d, D);
        }, CAP);

        // ---- grid update: normalise, then the boundary conditions at the nodes
        this.gridPass = K(() => {
            const g = v(int(instanceIndex));
            const slot = v(g.div(NODES)), local = v(g.mod(NODES));
            const A = v(prm(int(P_SLOTA).add(slot)));
            If(A.w.lessThan(0.5), () => { Return(); });
            const q = v(g.mul(4));
            const mx = atomicLoad(acc.element(q)), my = atomicLoad(acc.element(q.add(1))), mz = atomicLoad(acc.element(q.add(2))), mm = atomicLoad(acc.element(q.add(3)));
            const mass = v(float(mm).div(FIXED));
            const mom = v(vec3(float(mx), float(my), float(mz)).div(FIXED));
            atomicStore(acc.element(q), int(0)); atomicStore(acc.element(q.add(1)), int(0)); atomicStore(acc.element(q.add(2)), int(0)); atomicStore(acc.element(q.add(3)), int(0));
            If(mass.lessThan(1e-6), () => { grid.element(g).assign(vec4(0)); Return(); });
            const d = v(mom.div(mass));
            const mu = v(prm(int(P_SLOTB).add(slot)).x);
            const ix = v(local.mod(NX)), iy = v(local.div(NX).mod(NY)), iz = v(local.div(NXY));
            // terrain: no motion into it (a node within a cell of the surface may close the gap), Coulomb friction along it
            const fl = v(field.element(g));
            If(fl.w.lessThan(-1.5), () => { d.assign(vec3(0)); }).ElseIf(fl.w.lessThan(1), () => {
                const n = fl.xyz;
                const vn = v(dot(d, n)), tgt = v(max(vn, max(fl.w, 0).negate())), dn = v(tgt.sub(vn));
                If(dn.greaterThan(0), () => {
                    const t = v(d.sub(n.mul(vn))), lt = v(length(t));
                    const s = select(lt.greaterThan(1e-9), max(float(0), float(1).sub(mu.mul(dn).div(max(lt, 1e-9)))), float(0));
                    d.assign(n.mul(tgt).add(t.mul(s)));
                });
            });
            // bodies and the player (one-way): push the material out of their spheres at their velocity
            const wp = v(A.xyz.add(vec3(float(ix), float(iy), float(iz))));
            for(let k = 0; k < MAX_PROXIES; k++) {
                const pa = prm(P_PROXA + k), pb = prm(P_PROXB + k);
                If(pb.w.greaterThan(0.5), () => {
                    const H = 0.25;
                    const r = v(pa.xyz.div(H).sub(wp).negate()), l = v(length(r)), R = pa.w.div(H).add(0.5);
                    If(l.lessThan(R).and(l.greaterThan(1e-6)), () => {
                        const e = v(r.div(l));
                        const vn = v(dot(d, e)), pv = v(dot(pb.xyz.mul(prm(P_GLOB2).x), e).add(R.sub(l).mul(0.5)));
                        If(vn.lessThan(pv), () => { d.addAssign(e.mul(pv.sub(vn))); });
                    });
                });
            }
            // the zone's walls: no motion out through them, friction along them
            const wall = (idx, n, comp) => idx.lessThanEqual(GUARD).and(comp.lessThan(0)).or(idx.greaterThanEqual(n - 1 - GUARD).and(comp.greaterThan(0)));
            If(wall(ix, NX, d.x), () => { d.assign(vec3(0, d.y.mul(float(1).sub(mu)), d.z.mul(float(1).sub(mu)))); });
            If(wall(iy, NY, d.y), () => { d.assign(vec3(d.x.mul(float(1).sub(mu)), 0, d.z.mul(float(1).sub(mu)))); });
            If(wall(iz, NZ, d.z), () => { d.assign(vec3(d.x.mul(float(1).sub(mu)), d.y.mul(float(1).sub(mu)), 0)); });
            grid.element(g).assign(vec4(d, mass));
        }, MAX_ZONES * NODES);

        // ---- G2P, integrate, plasticity, terrain push-out, gravity for the next step
        this.g2pIntegrate = K(() => {
            const L = load();
            const { d, D } = g2p(L.slot, L.P);
            const Fr = rows(F, L.i);
            const pl = v(Fr[0].w);
            const F3 = Fr.map(x => x.xyz);
            const Fn = F3.map((f, i) => v(f.add(F3[0].mul(D[i].x)).add(F3[1].mul(D[i].y)).add(F3[2].mul(D[i].z))));
            const sv = svd3(Fn);
            const r0 = v(matRow(L.m, 0)), r1 = v(matRow(L.m, 1)), r2 = v(matRow(L.m, 2)), r3 = v(matRow(L.m, 3));
            // the reference's safety clamp; sand also forgets compression past minStretch (no stored rebound)
            const S = v(clamp(sv.S, vec3(r3.y), vec3(1e4)));
            const model = v(int(r0.x));
            If(model.equal(SAND), () => {
                // Drucker-Prager return mapping (Klár et al. 2016) with logJp (PB-MPM)
                const e = v(log(S));
                const tr = v(e.x.add(e.y).add(e.z).add(pl));
                If(tr.greaterThanEqual(r0.z), () => { S.assign(vec3(1)); pl.assign(tr.mul(0.5)); }).Else(() => {
                    pl.assign(0);
                    const h = v(e.sub(e.x.add(e.y).add(e.z).div(3)));
                    const frob = v(length(h));
                    const dg = v(frob.add(tr.mul(2.5).mul(r0.y)));
                    If(dg.greaterThan(0).and(frob.greaterThan(1e-9)), () => { S.assign(exp(e.sub(h.mul(dg.div(frob))))); });
                });
            }).ElseIf(model.equal(SNOW), () => {
                // Stomakhin et al. 2013: clamp the stretches, the plastic part goes into Jp
                const J0 = v(S.x.mul(S.y).mul(S.z));
                const lo = select(pl.greaterThan(SNOW_JMIN), float(1).sub(r1.z), float(0.1));
                S.assign(clamp(S, vec3(lo), vec3(float(1).add(r1.w))));
                pl.assign(clamp(pl.mul(J0).div(S.x.mul(S.y).mul(S.z)), SNOW_JMIN, 5));
            }).ElseIf(model.equal(VISCO), () => {
                const y = v(exp(r2.y));
                const J0 = v(S.x.mul(S.y).mul(S.z));
                S.assign(clamp(S, vec3(float(1).div(y)), vec3(y)));
                S.mulAssign(pow(J0.div(S.x.mul(S.y).mul(S.z)), 1 / 3));
            });
            const Fo = usv(sv, S);
            for(let r = 0; r < 3; r++) F.element(L.i.mul(3).add(r)).assign(vec4(Fo[r], r === 0 ? pl : 0));
            for(let r = 0; r < 3; r++) Dm.element(L.i.mul(3).add(r)).assign(vec4(D[r], 0));
            // position, rest counter
            const G = v(prm(P_GLOB));
            // CFL: at most maxStep cells per step
            const dl = v(length(d)), maxStep = prm(P_GLOB2).y;
            const dd = v(d.mul(min(float(1), maxStep.div(max(dl, 1e-9)))));
            const x = v(L.P.xyz.add(dd));
            const restPrev = disp.element(L.i).w;
            const rest = select(dot(dd, dd).lessThan(G.y.mul(G.y)), min(restPrev.add(1), 65535), float(0));
            // push out of the terrain (trilinear distance and normal from the field)
            const i0 = v(ivec3(floor(x))), t = v(x.sub(floor(x)));
            const fb = v(L.slot.mul(NODES).add(i0.x).add(i0.y.mul(NX)).add(i0.z.mul(NXY)));
            const acc4 = v(vec4(0));
            for(let c = 0; c < 2; c++) for(let b = 0; b < 2; b++) for(let a = 0; a < 2; a++) {
                const wt = (a ? t.x : float(1).sub(t.x)).mul(b ? t.y : float(1).sub(t.y)).mul(c ? t.z : float(1).sub(t.z));
                acc4.addAssign(field.element(fb.add(a + b * NX + c * NXY)).mul(wt));
            }
            If(acc4.w.lessThan(0), () => {
                const n = v(normalize(acc4.xyz.add(vec3(0, 1e-6, 0))));
                x.subAssign(n.mul(acc4.w));
                const vn = v(dot(dd, n));
                If(vn.lessThan(0), () => { dd.subAssign(n.mul(vn)); });
            });
            x.assign(clamp(x, vec3(GUARD), vec3(NX - 1 - GUARD - 1e-3, NY - 1 - GUARD - 1e-3, NZ - 1 - GUARD - 1e-3)));
            pos.element(L.i).xyz.assign(x);
            disp.element(L.i).assign(vec4(dd.sub(vec3(0, G.x, 0)), rest));
        }, CAP);

        // ---- stats on demand: particles and moving particles per slot
        this.statsClear = K(() => { const i = int(instanceIndex); atomicStore(stats.element(i), uint(0)); }, MAX_ZONES * 2);
        this.statsCount = K(() => {
            const L = load();
            atomicAdd(stats.element(L.slot.mul(2)), uint(1));
            If(disp.element(L.i).w.lessThan(prm(P_GLOB).w), () => { atomicAdd(stats.element(L.slot.mul(2).add(1)), uint(1)); });
        }, CAP);
        const so = this.statsOut;
        this.statsCopy = K(() => { const i = int(instanceIndex); so.element(i).assign(atomicLoad(stats.element(i))); }, MAX_ZONES * 2);
        this.allKernels = [this.p2gFirst, this.g2pP2g, this.gridPass, this.g2pIntegrate, this.statsClear, this.statsCount, this.statsCopy];
    }

    /** Dispatch extents: particle kernels over slots 0..maxSlot, the grid pass over their nodes. */
    _extent() {
        const s = this.maxSlot + 1;
        for(const k of [this.p2gFirst, this.g2pP2g, this.g2pIntegrate, this.statsCount]) k.count = Math.max(1, s * PER_ZONE);
        this.gridPass.count = Math.max(1, s * NODES);
    }

    /** One frame: `substeps` x (`iterations` x P2G / grid / G2P, integrate). Returns the dispatch count. */
    step({ substeps = 1, iterations = 3 } = {}) {
        if(this.maxSlot < 0) return 0;
        this._extent();
        this.flush();
        const list = [];
        for(let s = 0; s < substeps; s++) {
            list.push(this.p2gFirst, this.gridPass);
            for(let it = 1; it < iterations; it++) list.push(this.g2pP2g, this.gridPass);
            list.push(this.g2pIntegrate);
        }
        this.renderer.compute(list);
        return list.length;
    }
    warmup() {
        const m = this.maxSlot; this.maxSlot = 0; this._extent(); this.maxSlot = m;
        this.flush();
        this.renderer.compute(this.allKernels);
    }

    /** Particles and moving particles per slot (a promise of Uint32Array [count0, moving0, ...]), or null while busy. */
    readStats() {
        if(this.statsBusy || this.maxSlot < 0) return null;
        this._extent();
        this.renderer.compute([this.statsClear, this.statsCount, this.statsCopy]);
        this.statsBusy = true;
        return this.renderer.getArrayBufferAsync(this.statsOut.value).then((b) => { this.statsBusy = false; return new Uint32Array(b.slice(0)); }, (e) => { this.statsBusy = false; throw e; });
    }
    /** Slot s's particle positions and words (a promise of Float32Array, 4 per particle: zone-local xyz, packed w). */
    async readSlot(s) {
        const n = this.counts[s];
        if(!n) return new Float32Array(0);
        const buf = await this.renderer.getArrayBufferAsync(this.pos.value, null, s * PER_ZONE * 16, n * 16);
        return new Float32Array(buf.slice ? buf.slice(0) : buf);
    }
}
