/**
 * GPU side of the soft ground (WebGPU compute through TSL): node and tet buffers for MAX_ZONES zone slots, the
 * solver kernels and the terrain deformation node.
 *
 * Solver (per substep, as worldparty-dmm / dmm-js): predict (Verlet, damping, plastic creep of the rest shape), then
 * K Jacobi iterations of { tet pass: per-tet shape matching (rotation extracted from the warm-started quaternion,
 * goal = R (rest - rest centroid) + centroid, blended by the material's stiffness) ; node pass: average of the goals
 * of the tet corners on the node (found implicitly from the lattice: 8 cells x up to 4 tets), Chebyshev
 * over-relaxation }. Pinned nodes stay at u = 0. No gravity: the rest shape is the current terrain.
 *
 * Slot uniforms: slotA[s] = (origin xyz (m), mode: 0 off, 1 simulating, 2 frozen = drawn only),
 *                slotB[s] = (node dims x, y, z, cell count), slotC[s] = (extra damping 1/s, -, -, -).
 */
import * as THREE from 'three/webgpu';
import {
    Fn, If, Loop, Return, instanceIndex, instancedArray, uniform, uniformArray, attribute, modelWorldMatrix,
    float, int, vec3, vec4, cross, dot, length, max, min, mix, sin, cos, abs, select, normalize, clamp, floor,
} from 'three/tsl';
import { MATERIALS } from '../voxel/materials.js';
import { H, MAX_ZONES, NODE_CAP, CELL_CAP, TET_OFF, CORNER_TETS, CORNER_OF, F_ACTIVE, F_PINNED } from './core.js';

const WG = 64;
const MAXU = 0.9;      // m: clamp on a node's displacement
const MAXV = 0.06;     // m per substep: clamp on a node's speed
export const MAX_KICKS = 4;
const P_SLOTA = 0, P_SLOTB = MAX_ZONES, P_SLOTC = 2 * MAX_ZONES, P_KICKA = 3 * MAX_ZONES, P_KICKB = P_KICKA + MAX_KICKS,
    P_KICKC = P_KICKB + MAX_KICKS, PARAMS = P_KICKC + MAX_KICKS;

/** A vec4 view into the CPU mirror of the parameter buffer (writes mark it for upload). */
export class V4 {
    constructor(sim, o) { this.sim = sim; this.o = o; }
    set(x, y, z, w) { const a = this.sim.P, o = this.o; a[o] = x; a[o + 1] = y; a[o + 2] = z; a[o + 3] = w; this.sim.dirty = true; return this; }
    get x() { return this.sim.P[this.o]; } set x(v) { this.sim.P[this.o] = v; this.sim.dirty = true; }
    get y() { return this.sim.P[this.o + 1]; } set y(v) { this.sim.P[this.o + 1] = v; this.sim.dirty = true; }
    get z() { return this.sim.P[this.o + 2]; } set z(v) { this.sim.P[this.o + 2] = v; this.sim.dirty = true; }
    get w() { return this.sim.P[this.o + 3]; } set w(v) { this.sim.P[this.o + 3] = v; this.sim.dirty = true; }
}

const rotate = (v, q) => v.add(cross(q.xyz, cross(q.xyz, v).add(v.mul(q.w))).mul(2.0));
const qmul = (a, b) => vec4(
    a.w.mul(b.x).add(a.x.mul(b.w)).add(a.y.mul(b.z)).sub(a.z.mul(b.y)),
    a.w.mul(b.y).sub(a.x.mul(b.z)).add(a.y.mul(b.w)).add(a.z.mul(b.x)),
    a.w.mul(b.z).add(a.x.mul(b.y)).sub(a.y.mul(b.x)).add(a.z.mul(b.w)),
    a.w.mul(b.w).sub(a.x.mul(b.x)).sub(a.y.mul(b.y)).sub(a.z.mul(b.z)),
);
// Müller et al. rotation extraction (from dmm-js / worldparty-dmm)
function extractRotation(A0, A1, A2, q, iterations) {
    for(let i = 0; i < iterations; i++) {
        const X = rotate(vec3(1, 0, 0), q), Y = rotate(vec3(0, 1, 0), q), Z = rotate(vec3(0, 0, 1), q);
        const omega = cross(X, A0).add(cross(Y, A1)).add(cross(Z, A2))
            .div(abs(dot(X, A0).add(dot(Y, A1)).add(dot(Z, A2))).add(1e-9)).toVar();
        const w = length(omega).toVar();
        const half = w.mul(0.5);
        const dq = vec4(omega.div(max(w, 1e-9)).mul(sin(half)), cos(half));
        q.assign(qmul(dq, q).normalize());
    }
    return q;
}

export class SoftSim {
    constructor(renderer, { iterations = 4 } = {}) {
        this.renderer = renderer;
        this.iterations = iterations;
        const Z = MAX_ZONES, NN = Z * NODE_CAP, NC = Z * CELL_CAP, NT = NC * 5;
        this.nPos = instancedArray(NN, 'vec4');     // u (displacement from the lattice point)
        this.nPrev = instancedArray(NN, 'vec4');
        this.nOld = instancedArray(NN, 'vec4');     // previous iterate (Chebyshev)
        this.nRest = instancedArray(NN, 'vec4');    // rest displacement (plastic creep)
        this.nFlag = instancedArray(new Int32Array(NN), 'int');
        this.cellIdx = instancedArray(new Int32Array(NN).fill(-1), 'int');
        this.cells = instancedArray(new Int32Array(NC), 'int');
        this.tetQ = instancedArray(NT, 'vec4');
        this.goals = instancedArray(NT * 4, 'vec4');
        const v4 = () => new THREE.Vector4();
        const softTable = [], softTable2 = [];
        for(let m = 0; m < 16; m++) {
            const M = MATERIALS[m] || MATERIALS[1];
            softTable.push(new THREE.Vector4(M.stiffness, M.damping, M.plasticity, M.yield));
            softTable2.push(new THREE.Vector4(M.softness, M.density / 1000, M.toughness, 0));
        }
        // per-slot and per-kick parameters live in one small storage buffer (uniform arrays shared between several
        // compute pipelines and the vertex stage do not stay in sync), mirrored on the CPU: slotA, slotB, slotC, kickA..C
        this.P = new Float32Array(PARAMS * 4);
        this.params = instancedArray(this.P, 'vec4');
        const views = (base, n) => Array.from({ length: n }, (_, i) => new V4(this, (base + i) * 4));
        this.slotA = views(P_SLOTA, Z); this.slotB = views(P_SLOTB, Z); this.slotC = views(P_SLOTC, Z);
        this.kickA = views(P_KICKA, MAX_KICKS); this.kickB = views(P_KICKB, MAX_KICKS); this.kickC = views(P_KICKC, MAX_KICKS);
        const par = this.params;
        const el = (base) => ({ element: (i) => par.element(int(i).add(base)) });
        this.u = {
            dt: uniform(1 / 240),
            slotA: el(P_SLOTA), slotB: el(P_SLOTB), slotC: el(P_SLOTC),
            kickA: el(P_KICKA), kickB: el(P_KICKB), kickC: el(P_KICKC),
            initMask: uniform(0, 'int'),
            // constant tables: uniform arrays are fine (their values never change after the first build)
            mat: uniformArray(softTable, 'vec4'),
            mat2: uniformArray(softTable2, 'vec4'),
            tetOff: uniformArray(TET_OFF, 'int'),
            cornerTets: uniformArray(CORNER_TETS, 'int'),
        };
        this.r = this.u;
        this._kernels();
    }

    _kernels() {
        const u = this.u, { nPos, nPrev, nOld, nRest, nFlag, cellIdx, cells, tetQ, goals } = this;
        const Z = MAX_ZONES;
        const K = (fn, n) => Fn(fn)().compute(n, [WG]);
        const nodeSlot = () => {
            const g = int(instanceIndex).toVar();
            const slot = g.div(NODE_CAP).toVar(), local = g.mod(NODE_CAP).toVar();
            return { g, slot, local };
        };
        const latticeOf = (local, B) => {
            const nx = int(B.x), nxy = int(B.x).mul(int(B.y));
            return ivec(local.mod(nx), local.div(nx).mod(int(B.y)), local.div(nxy));
        };
        const ivec = (a, b, c) => ({ x: a.toVar(), y: b.toVar(), z: c.toVar() });

        this.initPass = K(() => {
            const g = int(instanceIndex).toVar();
            If(g.lessThan(Z * NODE_CAP), () => {
                const slot = g.div(NODE_CAP);
                If(u.initMask.shiftRight(slot).bitAnd(1).equal(1), () => {
                    nPos.element(g).assign(vec4(0)); nPrev.element(g).assign(vec4(0));
                    nOld.element(g).assign(vec4(0)); nRest.element(g).assign(vec4(0));
                });
            });
            If(g.lessThan(Z * CELL_CAP * 5), () => {
                const slot = g.div(CELL_CAP * 5);
                If(u.initMask.shiftRight(slot).bitAnd(1).equal(1), () => { tetQ.element(g).assign(vec4(0, 0, 0, 1)); });
            });
        }, Math.max(Z * NODE_CAP, Z * CELL_CAP * 5));

        // velocity kicks: the impact pushes nodes (Verlet: move prev back)
        this.kickPass = K(() => {
            const { g, slot, local } = nodeSlot();
            const A = u.slotA.element(slot).toVar();
            If(A.w.notEqual(1), () => { Return(); });
            const f = nFlag.element(g).toVar();
            If(f.bitAnd(F_ACTIVE).equal(0).or(f.bitAnd(F_PINNED).notEqual(0)), () => { Return(); });
            const B = u.slotB.element(slot);
            const L = latticeOf(local, B);
            const wp = A.xyz.add(vec3(float(L.x), float(L.y), float(L.z)).mul(H)).toVar();
            const soft = u.mat2.element(f.shiftRight(8).bitAnd(15)).x.toVar();
            const dv = vec3(0).toVar();
            for(let k = 0; k < MAX_KICKS; k++) {
                const ka = u.kickA.element(k), kb = u.kickB.element(k), kc = u.kickC.element(k);
                If(ka.w.greaterThan(0).and(int(kc.x).equal(slot)), () => {
                    const d = wp.sub(ka.xyz).toVar();
                    const r = length(d).toVar();
                    If(r.lessThan(ka.w), () => {
                        const f1 = float(1).sub(r.div(ka.w));
                        const fall = f1.mul(f1).mul(float(3).sub(f1.mul(2))).toVar(); // smoothstep: no crease at the rim
                        const radial = normalize(d.add(vec3(0, ka.w.mul(kc.y), 0)).add(vec3(0, 1e-4, 0)));
                        const dir = select(length(kb.xyz).greaterThan(0.01), kb.xyz, radial);
                        dv.addAssign(dir.mul(kb.w.mul(fall)));
                    });
                });
            }
            nPrev.element(g).subAssign(vec4(dv.mul(soft).mul(u.dt), 0));
        }, Z * NODE_CAP);

        this.predictPass = K(() => {
            const { g, slot } = nodeSlot();
            If(u.slotA.element(slot).w.notEqual(1), () => { Return(); });
            const f = nFlag.element(g).toVar();
            If(f.bitAnd(F_ACTIVE).equal(0), () => { Return(); });
            If(f.bitAnd(F_PINNED).notEqual(0), () => {
                nPos.element(g).assign(vec4(0)); nPrev.element(g).assign(vec4(0)); nOld.element(g).assign(vec4(0));
                Return();
            });
            const M = u.mat.element(f.shiftRight(8).bitAnd(15)).toVar();
            const p = nPos.element(g).xyz.toVar();
            const damp = M.y.add(u.slotC.element(slot).x);
            const vel = p.sub(nPrev.element(g).xyz).mul(max(float(0), float(1).sub(damp.mul(u.dt)))).toVar();
            const vl = length(vel);
            vel.mulAssign(min(float(1), float(MAXV).div(max(vl, 1e-9))));
            // plastic creep: the rest shape follows the part of the deformation past the yield
            If(M.z.greaterThan(0), () => {
                const r = nRest.element(g).xyz.toVar();
                const d = p.sub(r).toVar();
                const dl = length(d).toVar();
                If(dl.greaterThan(M.w), () => {
                    const rate = float(1).sub(float(1).sub(M.z).pow(u.dt.mul(60)));
                    nRest.element(g).xyz.assign(r.add(d.mul(dl.sub(M.w).div(dl)).mul(rate)));
                });
            });
            const np = p.add(vel).toVar();
            nPrev.element(g).xyz.assign(p);
            nPos.element(g).xyz.assign(np);
            nOld.element(g).xyz.assign(np);
        }, Z * NODE_CAP);

        // per tet shape matching -> goals of its 4 corners
        this.tetPass = K(() => {
            const t = int(instanceIndex).toVar();
            const slot = t.div(CELL_CAP * 5).toVar();
            const lt = t.mod(CELL_CAP * 5).toVar();
            const cl = lt.div(5).toVar(), l = lt.mod(5).toVar();
            const A = u.slotA.element(slot).toVar(), B = u.slotB.element(slot).toVar();
            If(A.w.notEqual(1).or(cl.greaterThanEqual(int(B.w))), () => { Return(); });
            const cell = cells.element(slot.mul(CELL_CAP).add(cl)).toVar();
            const ci = cell.bitAnd(255), cj = cell.shiftRight(8).bitAnd(255), ck = cell.shiftRight(16).bitAnd(255);
            const m = cell.shiftRight(24).bitAnd(15).toVar();
            const par = ci.add(cj).add(ck).bitAnd(1).toVar();
            const nx = int(B.x).toVar(), nxy = int(B.x).mul(int(B.y)).toVar();
            const P = [], R = [];
            for(let k = 0; k < 4; k++) {
                const o = u.tetOff.element(par.mul(20).add(l.mul(4)).add(k)).toVar();
                const ox = ci.add(o.bitAnd(1)), oy = cj.add(o.shiftRight(1).bitAnd(1)), oz = ck.add(o.shiftRight(2).bitAnd(1));
                const n = slot.mul(NODE_CAP).add(ox).add(oy.mul(nx)).add(oz.mul(nxy)).toVar();
                const X = vec3(float(ox), float(oy), float(oz)).mul(H).toVar();
                P.push(X.add(nPos.element(n).xyz).toVar());
                R.push(X.add(nRest.element(n).xyz).toVar());
            }
            const c = P[0].add(P[1]).add(P[2]).add(P[3]).mul(0.25).toVar();
            const rc = R[0].add(R[1]).add(R[2]).add(R[3]).mul(0.25).toVar();
            const r = R.map((x) => x.sub(rc).toVar());
            const q = P.map((x) => x.sub(c));
            const A0 = q[0].mul(r[0].x).add(q[1].mul(r[1].x)).add(q[2].mul(r[2].x)).add(q[3].mul(r[3].x)).toVar();
            const A1 = q[0].mul(r[0].y).add(q[1].mul(r[1].y)).add(q[2].mul(r[2].y)).add(q[3].mul(r[3].y)).toVar();
            const A2 = q[0].mul(r[0].z).add(q[1].mul(r[1].z)).add(q[2].mul(r[2].z)).add(q[3].mul(r[3].z)).toVar();
            const rot = tetQ.element(t).toVar();
            extractRotation(A0, A1, A2, rot, 1);
            tetQ.element(t).assign(rot);
            const M = u.mat.element(m), M2 = u.mat2.element(m);
            const stiff = M.x, w = M2.y;
            for(let k = 0; k < 4; k++) goals.element(t.mul(4).add(k)).assign(vec4(mix(P[k], rotate(r[k], rot).add(c), stiff), w));
        }, Z * CELL_CAP * 5);

        // node pass: average the goals of the tet corners on the node (Jacobi) with Chebyshev weight omega
        const makeProject = (omega) => K(() => {
            const { g, slot, local } = nodeSlot();
            const A = u.slotA.element(slot);
            If(A.w.notEqual(1), () => { Return(); });
            const f = nFlag.element(g).toVar();
            If(f.bitAnd(F_ACTIVE).equal(0).or(f.bitAnd(F_PINNED).notEqual(0)), () => { Return(); });
            const B = u.slotB.element(slot).toVar();
            const L = latticeOf(local, B);
            // toVar: an expression first used inside an If is declared in that branch by TSL and reads 0 elsewhere
            const nx = int(B.x).toVar(), ny = int(B.y).toVar(), nz = int(B.z).toVar(), nxy = nx.mul(ny).toVar();
            const sum = vec3(0).toVar(), wsum = float(0).toVar();
            for(let c8 = 0; c8 < 8; c8++) {
                const ox = c8 & 1, oy = (c8 >> 1) & 1, oz = c8 >> 2;
                // cell (L - 1 + o): this node is its corner (1 - o)
                const cx = L.x.sub(int(1 - ox)).toVar(), cy = L.y.sub(int(1 - oy)).toVar(), cz = L.z.sub(int(1 - oz)).toVar();
                const inside = cx.greaterThanEqual(int(0)).and(cy.greaterThanEqual(int(0))).and(cz.greaterThanEqual(int(0)))
                    .and(cx.lessThan(nx.sub(1))).and(cy.lessThan(ny.sub(1))).and(cz.lessThan(nz.sub(1)));
                If(inside, () => {
                    const cell = cellIdx.element(slot.mul(NODE_CAP).add(cx).add(cy.mul(nx)).add(cz.mul(nxy))).toVar();
                    If(cell.greaterThanEqual(0), () => {
                        const corner = CORNER_OF[(1 - ox) + 2 * (1 - oy) + 4 * (1 - oz)];
                        const par = cx.add(cy).add(cz).bitAnd(1);
                        const gbase = slot.mul(CELL_CAP).add(cell).mul(20).toVar();
                        const tb = par.mul(32).add(corner * 4).toVar();
                        for(let j = 0; j < 4; j++) {
                            const e = u.cornerTets.element(tb.add(j)).toVar();
                            If(e.greaterThanEqual(0), () => {
                                const gl = goals.element(gbase.add(e)).toVar();
                                sum.addAssign(gl.xyz.mul(gl.w)); wsum.addAssign(gl.w);
                            });
                        }
                    });
                });
            }
            If(wsum.lessThanEqual(0), () => { Return(); });
            const X = vec3(float(L.x), float(L.y), float(L.z)).mul(H);
            const cur = nPos.element(g).xyz.toVar();
            const np = mix(nOld.element(g).xyz, sum.div(wsum).sub(X), float(omega)).toVar();
            const nl = length(np);
            np.mulAssign(min(float(1), float(MAXU).div(max(nl, 1e-9))));
            nOld.element(g).xyz.assign(cur);
            nPos.element(g).xyz.assign(np);
        }, Z * NODE_CAP);
        const omegas = [], Kit = this.iterations;
        const rho = Math.min(0.95, Math.max(0.6, 1 - 1.5 / Kit)), rho2 = rho * rho;
        let om = 1;
        for(let k = 0; k < Kit; k++) { om = k < 2 ? 1 : k === 2 ? 2 / (2 - rho2) : 4 / (4 - rho2 * om); omegas.push(om); }
        const cache = new Map();
        this.projectPasses = omegas.map((o) => { const key = o.toFixed(5); if(!cache.has(key)) cache.set(key, makeProject(o)); return cache.get(key); });
        this.allKernels = [this.initPass, this.kickPass, this.predictPass, this.tetPass, ...cache.values()];
    }

    /** Set the dispatch extents to the slots in use (slots 0..maxSlot). */
    setExtent(maxSlot) {
        const s = maxSlot + 1;
        this.kickPass.count = this.predictPass.count = s * NODE_CAP;
        for(const p of this.projectPasses) p.count = s * NODE_CAP;
        this.tetPass.count = s * CELL_CAP * 5;
    }

    /** Upload a zone's lattice into slot s. */
    upload(s, z) {
        const put = (attr, src, off, len) => {
            attr.array.set(src.subarray(0, len), off);
            attr.addUpdateRange(off, len);
            attr.needsUpdate = true;
        };
        const nodes = (z.n[0] + 1) * (z.n[1] + 1) * (z.n[2] + 1);
        put(this.nFlag.value, z.flags, s * NODE_CAP, nodes);
        put(this.cellIdx.value, z.cellIdx, s * NODE_CAP, nodes);
        put(this.cells.value, z.cells, s * CELL_CAP, Math.max(1, z.count));
    }

    /** One frame of solver work: kicks, then `substeps` substeps. Returns the number of dispatches. */
    /** Upload the parameter buffer if it changed (also needed for drawing frozen zones). */
    flush() {
        if(!this.dirty) return;
        this.dirty = false;
        this.params.value.needsUpdate = true;
    }

    run(substeps, { init = 0, kicks = false } = {}) {
        this.flush();
        const list = [];
        if(init) { this.u.initMask.value = init; list.push(this.initPass); }
        if(kicks) list.push(this.kickPass);
        for(let s = 0; s < substeps; s++) {
            list.push(this.predictPass);
            for(const p of this.projectPasses) list.push(this.tetPass, p);
        }
        if(list.length) this.renderer.compute(list);
        return list.length;
    }

    /** Compile every pipeline up front (all slots off: every thread returns at once). */
    warmup() {
        this.setExtent(0);
        this.renderer.compute(this.allKernels);
    }

    /** Read back slot s's node displacements (Float32Array, 4 per node). */
    async readSlot(s, nodes) {
        const buf = await this.renderer.getArrayBufferAsync(this.nPos.value, null, s * NODE_CAP * 16, Math.ceil(nodes * 16 / 4) * 4);
        return new Float32Array(buf.slice ? buf.slice(0) : buf);
    }

    /**
     * Terrain deformation for a material's vertex stage: returns { position, normal, rest } TSL nodes for a chunk mesh
     * (world = model matrix * local, translation only). `skip` (int uniform): bit s set = ignore slot s for this
     * object (its mesh already has slot s baked in).
     */
    deformNode(skip) {
        const u = this.r, nPos = this.nPos;
        const p = attribute('position', 'vec3');
        const n0 = attribute('normal', 'vec3');
        const wp = modelWorldMatrix.mul(vec4(p, 1)).xyz.toVar();
        const disp = vec3(0).toVar(), jx = vec3(0).toVar(), jy = vec3(0).toVar(), jz = vec3(0).toVar();
        for(let s = 0; s < MAX_ZONES; s++) {
            const A = u.slotA.element(s), B = u.slotB.element(s);
            const gp = wp.sub(A.xyz).div(H).toVar();
            const on = A.w.greaterThan(0.5).and(skip.shiftRight(s).bitAnd(1).equal(0))
                .and(gp.x.greaterThanEqual(0)).and(gp.y.greaterThanEqual(0)).and(gp.z.greaterThanEqual(0))
                .and(gp.x.lessThan(B.x.sub(1))).and(gp.y.lessThan(B.y.sub(1))).and(gp.z.lessThan(B.z.sub(1)));
            If(on, () => {
                const i0 = floor(gp).toVar();
                const f = gp.sub(i0).toVar();
                const nx = int(B.x), nxy = int(B.x).mul(int(B.y));
                const base = int(s * NODE_CAP).add(int(i0.x)).add(int(i0.y).mul(nx)).add(int(i0.z).mul(nxy)).toVar();
                const U = [];
                for(let c = 0; c < 8; c++) {
                    const a = c & 1, b = (c >> 1) & 1, d = c >> 2;
                    U.push(nPos.element(base.add(a).add(nx.mul(b)).add(nxy.mul(d))).xyz.toVar());
                }
                // trilinear value and partial derivatives (per metre)
                const lx = (a, b) => mix(a, b, f.x);
                const u00 = lx(U[0], U[1]), u10 = lx(U[2], U[3]), u01 = lx(U[4], U[5]), u11 = lx(U[6], U[7]);
                const uy0 = mix(u00, u10, f.y), uy1 = mix(u01, u11, f.y);
                disp.addAssign(mix(uy0, uy1, f.z));
                const dx00 = U[1].sub(U[0]), dx10 = U[3].sub(U[2]), dx01 = U[5].sub(U[4]), dx11 = U[7].sub(U[6]);
                jx.addAssign(mix(mix(dx00, dx10, f.y), mix(dx01, dx11, f.y), f.z).div(H));
                jy.addAssign(mix(u10.sub(u00), u11.sub(u01), f.z).div(H));
                jz.addAssign(uy1.sub(uy0).div(H));
            });
        }
        // deformed normal ~ (I + J)^-T n ~ n - J^T n
        const n = normalize(n0.sub(vec3(dot(jx, n0), dot(jy, n0), dot(jz, n0))));
        return { position: p.add(disp), normal: n, rest: wp };
    }
}
