/**
 * Position Based Fluids on the GPU (WebGPU compute through TSL): the same algorithm as src/fluid/cpuSolver.js. Particle
 * state stays on the GPU (never read back per frame); the renderer draws straight from the buffers. See docs/SPH.md.
 *
 * Per substep (dispatches over the particles in use, `extent`, or the bin table):
 *   predict   gravity, damping, kicks, speed clamp, x* = x + v dt, push out of proxies and the terrain SDF
 *   clear     bin counters = 0                      (spatial hash of cells of size h, TABLE bins)
 *   insert    atomicAdd a slot in the particle's bin (at most MAXPER per bin)
 *   gather    neighbour list per particle (27 cells, cell coordinates checked against hash collisions)
 *   K x { lambda: density (poly6 + the terrain's share) and the constraint's multiplier
 *         delta:  position correction (spiky gradient, artificial pressure s_corr, terrain term)
 *         apply:  x* += dx, push out of proxies and terrain }
 *   velocity  v = (x* - x) / dt, tangential friction on terrain contact
 *   xsph      XSPH viscosity, x = x*, idle timer, recycling (out of the world, evaporated films), stats
 *
 * Buffers: pos (xyz, phase), vel (xyz, idle s), pred (xyz, phase), aux (lambda, terrain gradient xyz), dens, dp (dx, or
 * the velocity before XSPH), nbr / nbrN (neighbour lists), bins, the SDF pages (src/fluid/sdfPages.js), params
 * (proxies and kicks, mirrored on the CPU) and stats (atomics read back asynchronously every few frames).
 */
import * as THREE from 'three/webgpu';
import {
    Fn, If, Loop, Return, Continue, instanceIndex, instancedArray, storage, uniform, float, int, uint, vec2, vec3, vec4,
    max, min, abs, sqrt, floor, select, length, normalize, dot, cross, atomicAdd, atomicStore, atomicMax, atomicOr, floatBitsToUint,
} from 'three/tsl';
import { VOXEL, SDF_SCALE, CHUNK_M } from '../config.js';
import { kernel, PHASES, WATER, LAVA, GRAVITY, MAX_SPEED, S_CORR_K, IDLE_SPEED, EVAPORATE_DENSITY, EVAPORATE_TIME,
    MAX_NEIGHBOURS, MAX_PROXIES, MAX_KICKS } from './params.js';
import { NCX, NCY, NCZ, N_CHUNKS, PAGE_WORDS, FILL_BASE } from './sdfPages.js';
import { WORLD_LO, WORLD_HI, MOVING_SPEED, OCC_WORDS } from './cpuSolver.js';
import { WORLD_CHUNKS } from '../config.js';

const WG = 64;
const TABLE = 1 << 16;  // hash bins
const MAXPER = 32;      // particles per bin
const P_PROXY = 0, P_KICK = MAX_PROXIES * 3, PARAMS = P_KICK + MAX_KICKS * 2;
export const STATS = 3 + OCC_WORDS; // [0] alive, [1] moving, [2] max speed (float bits), [3..] chunk occupancy bits


export class FluidGPU {
    constructor(renderer, { spacing, cap, iterations = 3, substeps = 2, pages }) {
        this.renderer = renderer;
        this.k = kernel(spacing);
        this.cap = cap; this.iterations = iterations; this.substeps = substeps;
        this.extent = 0;
        this.pos = instancedArray(new Float32Array(cap * 4), 'vec4');
        this.vel = instancedArray(new Float32Array(cap * 4), 'vec4');
        this.pred = instancedArray(cap, 'vec4');
        this.aux = instancedArray(cap, 'vec4');
        this.dens = instancedArray(new Float32Array(cap).fill(1), 'float');
        this.dp = instancedArray(cap, 'vec4');
        this.nbr = instancedArray(new Uint32Array(cap * MAX_NEIGHBOURS), 'uint');
        this.nbrN = instancedArray(new Uint32Array(cap), 'uint');
        this.binAttr = new THREE.StorageBufferAttribute(new Uint32Array(TABLE), 1, Uint32Array);
        this.binAtomic = storage(this.binAttr, 'uint', TABLE).toAtomic();
        this.binRead = storage(this.binAttr, 'uint', TABLE).toReadOnly();
        this.slots = instancedArray(new Uint32Array(TABLE * MAXPER), 'uint');
        this.statsAttr = new THREE.StorageBufferAttribute(new Uint32Array(STATS), 1, Uint32Array);
        this.stats = storage(this.statsAttr, 'uint', STATS).toAtomic();
        // terrain SDF pages (Int8 samples packed 4 per word)
        this.pages = pages;
        this.table = instancedArray(pages.table, 'int');
        this.pageData = instancedArray(new Int32Array(pages.data.buffer), 'int');
        // proxies and kicks
        this.P = new Float32Array(PARAMS * 4);
        this.params = instancedArray(this.P, 'vec4');
        this.u = {
            dt: uniform(STEP_DEFAULT / substeps),
            extent: uniform(0, 'uint'),
            nProxies: uniform(0, 'int'),
            stats: uniform(0, 'uint'),
            gravity: uniform(GRAVITY),
        };
        this._kernels();
    }

    _kernels() {
        const u = this.u, k = this.k;
        const { pos, vel, pred, aux, dens, dp, nbr, nbrN, slots, table, pageData, params, stats } = this;
        const binAtomic = this.binAtomic, binRead = this.binRead;
        const K = (fn, n) => Fn(fn)().compute(n, [WG]);
        const H = k.h, H2 = k.h2, R = k.radius, MAXN = MAX_NEIGHBOURS;
        const POLY6 = k.poly6, SPIKY = k.spiky, RHO0 = k.rho0, EPS = k.eps, WDQ = k.wdq;
        const MINX = WORLD_CHUNKS.min[0], MINY = WORLD_CHUNKS.min[1], MINZ = WORLD_CHUNKS.min[2];
        const TO_M = VOXEL / SDF_SCALE;
        const W = PHASES[WATER], L = PHASES[LAVA];
        const guard = () => { const i = instanceIndex.toVar(); If(i.greaterThanEqual(u.extent), () => { Return(); }); return i; };

        // ---- terrain SDF (src/fluid/sdfPages.js layout)
        // (plain JS helpers, inlined: buffers referenced only inside a TSL function with a layout are not bound)
        const sdfGet = (ix, iy, iz) => {
            const cx = ix.shiftRight(5).sub(MINX).toVar(), cy = iy.shiftRight(5).sub(MINY).toVar(), cz = iz.shiftRight(5).sub(MINZ).toVar();
            const res = int(127).toVar();
            If(cy.lessThan(0), () => { res.assign(-127); })
                .ElseIf(cx.greaterThanEqual(0).and(cz.greaterThanEqual(0)).and(cx.lessThan(NCX)).and(cy.lessThan(NCY)).and(cz.lessThan(NCZ)), () => {
                    const e = table.element(cx.add(cy.mul(NCX)).add(cz.mul(NCX * NCY))).toVar();
                    If(e.lessThan(0), () => { res.assign(e.sub(FILL_BASE)); }).Else(() => {
                        const local = ix.bitAnd(31).add(iy.bitAnd(31).shiftLeft(5)).add(iz.bitAnd(31).shiftLeft(10)).toVar();
                        const w = pageData.element(e.mul(PAGE_WORDS).add(local.shiftRight(2))).toVar();
                        res.assign(w.shiftLeft(int(24).sub(local.bitAnd(3).mul(8))).shiftRight(24));
                    });
                });
            return res;
        };
        // distance (m) and gradient (unnormalized) at p
        const sdf = (p) => {
            const f = p.div(VOXEL).toVar();
            const i0 = floor(f).toVar();
            const t = f.sub(i0).toVar();
            const ix = int(i0.x).toVar(), iy = int(i0.y).toVar(), iz = int(i0.z).toVar();
            const ix1 = ix.add(1).toVar(), iy1 = iy.add(1).toVar(), iz1 = iz.add(1).toVar();
            const c000 = float(sdfGet(ix, iy, iz)).toVar(), c100 = float(sdfGet(ix1, iy, iz)).toVar();
            const c010 = float(sdfGet(ix, iy1, iz)).toVar(), c110 = float(sdfGet(ix1, iy1, iz)).toVar();
            const c001 = float(sdfGet(ix, iy, iz1)).toVar(), c101 = float(sdfGet(ix1, iy, iz1)).toVar();
            const c011 = float(sdfGet(ix, iy1, iz1)).toVar(), c111 = float(sdfGet(ix1, iy1, iz1)).toVar();
            const x00 = c000.add(c100.sub(c000).mul(t.x)).toVar(), x10 = c010.add(c110.sub(c010).mul(t.x)).toVar();
            const x01 = c001.add(c101.sub(c001).mul(t.x)).toVar(), x11 = c011.add(c111.sub(c011).mul(t.x)).toVar();
            const y0 = x00.add(x10.sub(x00).mul(t.y)).toVar(), y1 = x01.add(x11.sub(x01).mul(t.y)).toVar();
            const d = y0.add(y1.sub(y0).mul(t.z)).mul(TO_M);
            const dx00 = c100.sub(c000), dx10 = c110.sub(c010), dx01 = c101.sub(c001), dx11 = c111.sub(c011);
            const gx = dx00.add(dx10.sub(dx00).mul(t.y)).mul(t.z.oneMinus()).add(dx01.add(dx11.sub(dx01).mul(t.y)).mul(t.z));
            const gy = x10.sub(x00).mul(t.z.oneMinus()).add(x11.sub(x01).mul(t.z));
            const gz = y1.sub(y0);
            return vec4(d, gx, gy, gz);
        };

        const rot = (v, q) => v.add(cross(q.xyz, cross(q.xyz, v).add(v.mul(q.w))).mul(2.0));
        // push p out of the proxies and the terrain; returns p
        const collide = (p0) => {
            const p = p0.toVar();
            Loop({ start: int(0), end: u.nProxies, type: 'int', condition: '<', name: 'pr' }, ({ pr }) => {
                const A = params.element(pr.mul(3).add(P_PROXY)).toVar();
                const B = params.element(pr.mul(3).add(P_PROXY + 1)).toVar();
                If(A.w.equal(1), () => {
                    const ab = B.xyz.sub(A.xyz).toVar();
                    const ap = p.sub(A.xyz).toVar();
                    const L2 = dot(ab, ab);
                    const t = select(L2.greaterThan(1e-9), dot(ap, ab).div(max(L2, 1e-9)).clamp(0, 1), float(0));
                    const dv = ap.sub(ab.mul(t)).toVar();
                    const d = length(dv).toVar();
                    const Rr = B.w.add(R);
                    If(d.lessThan(Rr).and(d.greaterThan(1e-6)), () => { p.addAssign(dv.mul(Rr.sub(d).div(d))); });
                }).ElseIf(A.w.equal(2), () => {
                    const q = params.element(pr.mul(3).add(P_PROXY + 2)).toVar();
                    const qc = vec4(q.xyz.negate(), q.w);
                    const l = rot(p.sub(A.xyz), qc).toVar();
                    const hh = B.xyz.add(R).toVar();
                    const e = hh.sub(abs(l)).toVar();
                    If(e.x.greaterThan(0).and(e.y.greaterThan(0)).and(e.z.greaterThan(0)), () => {
                        If(e.x.lessThanEqual(e.y).and(e.x.lessThanEqual(e.z)), () => { l.x.assign(select(l.x.lessThan(0), hh.x.negate(), hh.x)); })
                            .ElseIf(e.y.lessThanEqual(e.z), () => { l.y.assign(select(l.y.lessThan(0), hh.y.negate(), hh.y)); })
                            .Else(() => { l.z.assign(select(l.z.lessThan(0), hh.z.negate(), hh.z)); });
                        p.assign(A.xyz.add(rot(l, q)));
                    });
                });
            });
            const s = sdf(p).toVar();
            If(s.x.lessThan(R), () => {
                const gl = length(s.yzw);
                const n = select(gl.greaterThan(1e-6), s.yzw.div(max(gl, 1e-6)), vec3(0, 1, 0));
                p.addAssign(n.mul(float(R).sub(s.x)));
            });
            return p;
        };

        const phaseOf = (ph) => ({
            xsph: select(ph.equal(LAVA), float(L.xsph), float(W.xsph)),
            friction: select(ph.equal(LAVA), float(L.friction), float(W.friction)),
            damping: select(ph.equal(LAVA), float(L.damping), float(W.damping)),
            evaporate: ph.equal(WATER),
        });

        // ---- predict
        this.predictPass = K(() => {
            const i = guard();
            const P = pos.element(i).toVar();
            If(P.w.equal(0), () => { Return(); });
            const M = phaseOf(P.w);
            const v = vel.element(i).xyz.toVar();
            v.y.subAssign(u.gravity.mul(u.dt));
            v.mulAssign(max(float(0), float(1).sub(M.damping.mul(u.dt))));
            for(let kk = 0; kk < MAX_KICKS; kk++) {
                const KA = params.element(P_KICK + kk * 2), KB = params.element(P_KICK + kk * 2 + 1);
                If(KA.w.greaterThan(0), () => {
                    const dv = P.xyz.sub(KA.xyz).toVar();
                    const d = length(dv).toVar();
                    If(d.lessThan(KA.w), () => {
                        const f = float(1).sub(d.div(KA.w));
                        const fall = f.mul(f).mul(float(3).sub(f.mul(2)));
                        const radial = dv.add(vec3(0, KA.w.mul(0.6), 0));
                        const dir = normalize(select(dot(KB.xyz, KB.xyz).greaterThan(1e-4), KB.xyz, radial));
                        v.addAssign(dir.mul(KB.w.mul(fall)));
                    });
                });
            }
            const sp = length(v);
            v.mulAssign(min(float(1), float(MAX_SPEED).div(max(sp, 1e-6))));
            vel.element(i).xyz.assign(v);
            pred.element(i).assign(vec4(collide(P.xyz.add(v.mul(u.dt))), P.w));
        }, this.cap);

        // ---- neighbours
        const cellOf = (p) => ivec3(floor(p.div(H)));
        const hash = (c) => uint(c.x).mul(73856093).bitXor(uint(c.y).mul(19349663)).bitXor(uint(c.z).mul(83492791)).bitAnd(TABLE - 1);
        this.clearPass = Fn(() => { atomicStore(binAtomic.element(instanceIndex), uint(0)); })().compute(TABLE, [WG]);
        this.insertPass = K(() => {
            const i = guard();
            const p = pred.element(i).toVar();
            If(p.w.equal(0), () => { Return(); });
            const b = hash(cellOf(p.xyz)).toVar();
            const s = atomicAdd(binAtomic.element(b), uint(1)).toVar();
            If(s.lessThan(MAXPER), () => { slots.element(b.mul(MAXPER).add(s)).assign(i); });
        }, this.cap);
        this.gatherPass = K(() => {
            const i = guard();
            const p = pred.element(i).toVar();
            const c = uint(0).toVar();
            If(p.w.notEqual(0), () => {
                const cell = cellOf(p.xyz);
                const cx = int(cell.x).toVar(), cy = int(cell.y).toVar(), cz = int(cell.z).toVar();
                Loop({ start: int(0), end: int(27), type: 'int', condition: '<', name: 'nc' }, ({ nc }) => {
                    const X = cx.add(nc.mod(3)).sub(1).toVar(), Y = cy.add(nc.div(3).mod(3)).sub(1).toVar(), Z = cz.add(nc.div(9)).sub(1).toVar();
                    const b = hash({ x: X, y: Y, z: Z }).toVar();
                    const n = min(binRead.element(b), uint(MAXPER)).toVar();
                    Loop({ start: uint(0), end: n, type: 'uint', condition: '<', name: 'ks' }, ({ ks }) => {
                        const j = slots.element(b.mul(MAXPER).add(ks)).toVar();
                        If(j.equal(i), () => { Continue(); });
                        const q = pred.element(j).xyz.toVar();
                        const cj = floor(q.div(H)).toVar();
                        If(int(cj.x).notEqual(X).or(int(cj.y).notEqual(Y)).or(int(cj.z).notEqual(Z)), () => { Continue(); });
                        const r = p.xyz.sub(q);
                        If(dot(r, r).lessThan(H2).and(c.lessThan(MAXN)), () => {
                            nbr.element(i.mul(MAXN).add(c)).assign(j);
                            c.addAssign(1);
                        });
                    });
                });
            });
            nbrN.element(i).assign(c);
        }, this.cap);

        // loop over particle i's neighbours: body(j, r (p_i - p_j), r2)
        const eachNeighbour = (i, p, body) => {
            const n = nbrN.element(i).toVar();
            const base = i.mul(MAXN).toVar();
            Loop({ start: uint(0), end: n, type: 'uint', condition: '<', name: 'nk' }, ({ nk }) => {
                const j = nbr.element(base.add(nk)).toVar();
                const r = p.sub(pred.element(j).xyz).toVar();
                const r2 = dot(r, r).toVar();
                If(r2.lessThan(H2), () => { body(j, r, r2); });
            });
        };

        // ---- lambda: density (with the terrain's share) and the constraint multiplier
        const S = k.spacing, WALLC = Math.PI / (4 * S * S) * POLY6 / RHO0 * k.wallScale;
        this.lambdaPass = K(() => {
            const i = guard();
            const P = pred.element(i).toVar();
            If(P.w.equal(0), () => { Return(); });
            const rho = float(POLY6 * H2 * H2 * H2).toVar();
            const g = vec3(0).toVar(), g2 = float(0).toVar();
            eachNeighbour(i, P.xyz, (j, r, r2) => {
                const w = float(H2).sub(r2);
                rho.addAssign(w.mul(w).mul(w).mul(POLY6));
                const rl = sqrt(r2).toVar();
                If(rl.greaterThan(1e-6), () => {
                    const hr = float(H).sub(rl);
                    const a = r.mul(hr.mul(hr).mul(SPIKY / RHO0).div(rl)).toVar();
                    g.addAssign(a); g2.addAssign(dot(a, a));
                });
            });
            const d = rho.div(RHO0).toVar();
            const wg = vec3(0).toVar();
            const s = sdf(P.xyz).toVar();
            If(s.x.lessThan(H), () => {
                const phi = float(0).toVar(), dphi = float(0).toVar();
                for(let l = 0; l < 2; l++) {
                    const y = s.x.add(S * 0.5 + l * S).toVar();
                    If(abs(y).lessThan(H), () => {
                        const a = float(H2).sub(y.mul(y)).toVar();
                        const a3 = a.mul(a).mul(a).toVar();
                        phi.addAssign(a3.mul(a)); dphi.addAssign(y.mul(-8).mul(a3));
                    });
                }
                d.addAssign(phi.mul(WALLC));
                wg.assign(s.yzw.div(max(length(s.yzw), 1e-6)).mul(dphi.mul(WALLC)));
                g.addAssign(wg);
            });
            dens.element(i).assign(d);
            const C = d.sub(1);
            const lam = select(C.greaterThan(0), C.negate().div(g2.add(dot(g, g)).add(EPS)), float(0));
            aux.element(i).assign(vec4(lam, wg));
        }, this.cap);

        // ---- delta: position correction
        this.deltaPass = K(() => {
            const i = guard();
            const P = pred.element(i).toVar();
            If(P.w.equal(0), () => { Return(); });
            const A = aux.element(i).toVar();
            const dx = vec3(0).toVar();
            eachNeighbour(i, P.xyz, (j, r, r2) => {
                If(r2.greaterThan(1e-12), () => {
                    const rl = sqrt(r2);
                    const w = float(H2).sub(r2);
                    const wr = w.mul(w).mul(w).mul(POLY6 / WDQ).toVar();
                    const wr2 = wr.mul(wr);
                    const sc = wr2.mul(wr2).mul(-S_CORR_K);
                    const hr = float(H).sub(rl);
                    dx.addAssign(r.mul(A.x.add(aux.element(j).x).add(sc).mul(hr.mul(hr).mul(SPIKY / RHO0)).div(rl)));
                });
            });
            dp.element(i).assign(vec4(dx.add(A.yzw.mul(A.x)), 0));
        }, this.cap);

        this.applyPass = K(() => {
            const i = guard();
            const P = pred.element(i).toVar();
            If(P.w.equal(0), () => { Return(); });
            pred.element(i).xyz.assign(collide(P.xyz.add(dp.element(i).xyz)));
        }, this.cap);

        // ---- velocity, friction
        this.velocityPass = K(() => {
            const i = guard();
            const P = pred.element(i).toVar();
            If(P.w.equal(0), () => { Return(); });
            const v = P.xyz.sub(pos.element(i).xyz).div(u.dt).toVar();
            const s = sdf(P.xyz).toVar();
            If(s.x.lessThan(R * 1.5), () => {
                const n = s.yzw.div(max(length(s.yzw), 1e-6)).toVar();
                const vn = dot(v, n).toVar();
                const vt = v.sub(n.mul(vn));
                v.assign(vt.mul(float(1).sub(phaseOf(P.w).friction)).add(n.mul(vn)));
            });
            dp.element(i).assign(vec4(v, 0));
        }, this.cap);

        // ---- XSPH viscosity, commit, recycle, stats
        this.xsphPass = K(() => {
            const i = guard();
            const P = pred.element(i).toVar();
            If(P.w.equal(0), () => { Return(); });
            const vi = dp.element(i).xyz.toVar();
            const acc = vec3(0).toVar();
            eachNeighbour(i, P.xyz, (j, r, r2) => {
                const w = float(H2).sub(r2);
                acc.addAssign(dp.element(j).xyz.sub(vi).mul(w.mul(w).mul(w).mul(POLY6 / RHO0)));
            });
            const M = phaseOf(P.w);
            const v = vi.add(acc.mul(M.xsph)).toVar();
            const sp = length(v).toVar();
            const idle = select(sp.lessThan(IDLE_SPEED), vel.element(i).w.add(u.dt), float(0)).toVar();
            vel.element(i).assign(vec4(v, idle));
            const p = P.xyz;
            const out = p.x.lessThan(WORLD_LO[0]).or(p.y.lessThan(WORLD_LO[1])).or(p.z.lessThan(WORLD_LO[2]))
                .or(p.x.greaterThan(WORLD_HI[0])).or(p.y.greaterThan(WORLD_HI[1])).or(p.z.greaterThan(WORLD_HI[2]));
            const evap = M.evaporate.and(idle.greaterThan(EVAPORATE_TIME)).and(dens.element(i).lessThan(EVAPORATE_DENSITY));
            const dead = out.or(evap).toVar();
            pos.element(i).assign(vec4(p, select(dead, float(0), P.w)));
            If(u.stats.equal(1).and(dead.not()), () => {
                atomicAdd(stats.element(0), uint(1));
                If(sp.greaterThan(MOVING_SPEED), () => { atomicAdd(stats.element(1), uint(1)); });
                atomicMax(stats.element(2), floatBitsToUint(sp));
                const ic = (v, hi) => max(min(v, int(hi)), int(0));
                const cx = ic(int(floor(p.x.div(CHUNK_M))).sub(WORLD_CHUNKS.min[0]), NCX - 1);
                const cy = ic(int(floor(p.y.div(CHUNK_M))).sub(WORLD_CHUNKS.min[1]), NCY - 1);
                const cz = ic(int(floor(p.z.div(CHUNK_M))).sub(WORLD_CHUNKS.min[2]), NCZ - 1);
                const ci = uint(cx.add(cy.mul(NCX)).add(cz.mul(NCX * NCY))).toVar();
                atomicOr(stats.element(ci.shiftRight(5).add(3)), uint(1).shiftLeft(ci.bitAnd(31)));
            });
        }, this.cap);

        this.statsClear = Fn(() => { atomicStore(stats.element(instanceIndex), uint(0)); })().compute(STATS, [STATS]);
        this.allKernels = [this.predictPass, this.clearPass, this.insertPass, this.gatherPass, this.lambdaPass, this.deltaPass,
            this.applyPass, this.velocityPass, this.xsphPass, this.statsClear];
    }

    _setCount() {
        const n = Math.max(1, this.extent);
        for(const p of [this.predictPass, this.insertPass, this.gatherPass, this.lambdaPass, this.deltaPass, this.applyPass, this.velocityPass, this.xsphPass]) p.count = n;
        this.u.extent.value = this.extent;
    }

    /** Write particles into slots [start, start + n): data Float32Array of 8 per particle (x, y, z, phase, vx, vy, vz, 0). */
    write(start, n, data) {
        const pa = this.pos.value, va = this.vel.value, da = this.dens.value;
        for(let i = 0; i < n; i++) {
            const o = (start + i) * 4, s = i * 8;
            pa.array[o] = data[s]; pa.array[o + 1] = data[s + 1]; pa.array[o + 2] = data[s + 2]; pa.array[o + 3] = data[s + 3];
            va.array[o] = data[s + 4]; va.array[o + 1] = data[s + 5]; va.array[o + 2] = data[s + 6]; va.array[o + 3] = 0;
            da.array[start + i] = 1;
        }
        pa.addUpdateRange(start * 4, n * 4); pa.needsUpdate = true;
        va.addUpdateRange(start * 4, n * 4); va.needsUpdate = true;
        da.addUpdateRange(start, n); da.needsUpdate = true;
        if(start + n > this.extent) this.extent = start + n;
    }

    /** A chunk's table entry and (dense) page changed in this.pages: upload them. */
    updatePage(ci, page) {
        const t = this.table.value;
        t.addUpdateRange(ci, 1); t.needsUpdate = true;
        if(page >= 0) { const d = this.pageData.value; d.addUpdateRange(page * PAGE_WORDS, PAGE_WORDS); d.needsUpdate = true; }
    }

    /** Proxies (Float32Array, 12 per proxy as cpuSolver.packProxy) and kicks (8 per kick, packKick) for the next step. */
    setInteraction(proxies, nProxies, kicks) {
        const P = this.P;
        for(let k = 0; k < nProxies; k++) {
            const s = k * 12, o = (P_PROXY + k * 3) * 4;
            P[o] = proxies[s + 1]; P[o + 1] = proxies[s + 2]; P[o + 2] = proxies[s + 3]; P[o + 3] = proxies[s];
            P[o + 4] = proxies[s + 4]; P[o + 5] = proxies[s + 5]; P[o + 6] = proxies[s + 6]; P[o + 7] = proxies[s + 7];
            P[o + 8] = proxies[s + 8]; P[o + 9] = proxies[s + 9]; P[o + 10] = proxies[s + 10]; P[o + 11] = proxies[s + 11];
        }
        P.set(kicks, P_KICK * 4);
        this.u.nProxies.value = nProxies;
        this.params.value.needsUpdate = true;
    }

    /** Run `steps` solver steps of `dt` (s); `stats`: gather stats in the last substep. */
    step(steps, dt, { stats = false } = {}) {
        if(!this.extent || steps <= 0) return 0;
        this._setCount();
        this.u.dt.value = dt / this.substeps;
        const list = [];
        for(let s = 0; s < steps; s++) for(let ss = 0; ss < this.substeps; ss++) {
            list.push(this.predictPass, this.clearPass, this.insertPass, this.gatherPass);
            for(let it = 0; it < this.iterations; it++) list.push(this.lambdaPass, this.deltaPass, this.applyPass);
            list.push(this.velocityPass);
            const last = stats && s === steps - 1 && ss === this.substeps - 1;
            if(last) list.push(this.statsClear);
            list.push(this.xsphPass);
        }
        // stats only in the very last xsph pass: the uniform is set per compute call, so split the list there
        if(stats) {
            const tail = list.pop();
            this.u.stats.value = 0;
            if(list.length) this.renderer.compute(list);
            this.u.stats.value = 1;
            this.renderer.compute(tail);
            this.u.stats.value = 0;
        } else {
            this.u.stats.value = 0;
            this.renderer.compute(list);
        }
        return list.length;
    }

    /** Read the stats buffer (promise of a Uint32Array), or null while a read is in flight. */
    readStats() {
        if(this.statsBusy) return null;
        this.statsBusy = true;
        return this.renderer.getArrayBufferAsync(this.statsAttr).then((b) => { this.statsBusy = false; return new Uint32Array(b.slice ? b.slice(0) : b); },
            (e) => { this.statsBusy = false; throw e; });
    }

    /** Compile every pipeline up front (extent 0: every thread returns at once). */
    warmup() {
        const e = this.extent;
        this.extent = 0; this._setCount();
        this.renderer.compute(this.allKernels);
        this.extent = e;
    }

    /** Nodes for the renderer: per-instance position (xyz, phase), speed, density. */
    renderNodes() {
        return { pos: this.pos.toAttribute(), speed: length(this.vel.toAttribute().xyz), dens: this.dens.toAttribute() };
    }
}

const STEP_DEFAULT = 1 / 60;
const ivec3 = (v) => ({ x: int(v.x), y: int(v.y), z: int(v.z) });
