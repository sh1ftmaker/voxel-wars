/**
 * Soft ground without WebGPU compute: the same interface as SoftSim (src/soft/SoftSim.js), but the solver runs on the
 * CPU in a worker (src/workers/softSim.js, src/soft/cpuSolver.js) and the node displacements reach the vertex stage
 * through a float texture (vertex texture fetch works on WebGL2).
 *
 * Texture: TEX_W texels per row, RGBA32F. Texel g = slot * NODE_CAP + node holds that node's displacement (xyz); the
 * texels after the nodes hold each slot's parameters as the worker last saw them (slotA, slotB, slotC: 3 per slot), so the
 * displacements and the lattice they belong to always arrive together. A main-thread `live` mask gates each slot as
 * well, so a freed slot stops deforming at once.
 *
 * The worker answers every step with the texture's data (transferred both ways, 3 buffers in flight at most); when it
 * falls behind, substeps are dropped (the ground moves in slow motion) but kicks and resets still go through.
 */
import * as THREE from 'three/webgpu';
import { textureLoad, uniform, attribute, modelWorldMatrix, int, ivec2, float, vec3, vec4, mix, normalize, dot, floor, If } from 'three/tsl';
import { H, MAX_ZONES, NODE_CAP } from './core.js';
import { V4 } from './SoftSim.js';
import { MAX_KICKS, P_SLOTA, P_SLOTB, P_SLOTC, P_KICKA, P_KICKB, P_KICKC, PARAMS } from './cpuSolver.js';

const TEX_W = 256;
const PBASE = MAX_ZONES * NODE_CAP; // first parameter texel
const TEX_H = Math.ceil((PBASE + 3 * MAX_ZONES) / TEX_W);

export class SoftSimCPU {
    constructor(renderer, { iterations = 3, rate = 60 } = {}) {
        this.renderer = renderer;
        this.cpu = true;
        this.P = new Float32Array(PARAMS * 4);
        const views = (base, n) => Array.from({ length: n }, (_, i) => new V4(this, (base + i) * 4));
        this.slotA = views(P_SLOTA, MAX_ZONES); this.slotB = views(P_SLOTB, MAX_ZONES); this.slotC = views(P_SLOTC, MAX_ZONES);
        this.kickA = views(P_KICKA, MAX_KICKS); this.kickB = views(P_KICKB, MAX_KICKS); this.kickC = views(P_KICKC, MAX_KICKS);
        for(const c of this.slotC) { c.y = H; c.z = 1; } // cell size, plasticity until a zone sets its own
        this.u = { dt: { value: 1 / rate } };
        this.rate = rate;
        const size = TEX_W * TEX_H * 4;
        this.tex = new THREE.DataTexture(new Float32Array(size), TEX_W, TEX_H, THREE.RGBAFormat, THREE.FloatType);
        this.tex.minFilter = this.tex.magFilter = THREE.NearestFilter;
        this.tex.generateMipmaps = false;
        this.tex.needsUpdate = true;
        this.pool = [new Float32Array(size), new Float32Array(size)];
        this.live = uniform(0, 'int');
        this.inflight = 0;
        this.sent = false;
        this.stats = { workerMs: 0, workerMax: 0, dropped: 0, frames: 0 };
        this.reads = new Map(); this.readId = 1;
        this.worker = new Worker(new URL('./softSim.js', import.meta.url), { type: 'module' });
        this.worker.onmessage = (e) => this._onMessage(e.data);
        this.worker.postMessage({ op: 'init', opts: { iterations, rate } });
    }

    _onMessage(m) {
        if(m.op === 'frame') {
            this.inflight--;
            const st = this.stats;
            st.frames++; st.workerMs = st.workerMs * 0.9 + m.ms * 0.1; st.workerMax = Math.max(st.workerMax * 0.995, m.ms);
            if(m.buf) { this.pool.push(this.tex.image.data); this.tex.image.data = m.buf; this.tex.needsUpdate = true; }
        } else if(m.op === 'read') { this.reads.get(m.id)?.resolve(m.u); this.reads.delete(m.id); }
        else if(m.op === 'error') { console.error('softSim worker', m.error); if(m.id) { this.reads.get(m.id)?.reject(new Error(m.error)); this.reads.delete(m.id); } }
    }

    upload(s, z) {
        const nodes = (z.n[0] + 1) * (z.n[1] + 1) * (z.n[2] + 1);
        const copy = { n: [...z.n], count: z.count, flags: z.flags.slice(0, nodes), cellIdx: z.cellIdx.slice(0, nodes), cells: z.cells.slice(0, Math.max(1, z.count)) };
        this.worker.postMessage({ op: 'upload', slot: s, z: copy, init: false }, [copy.flags.buffer, copy.cellIdx.buffer, copy.cells.buffer]);
    }

    setExtent() {}
    warmup() {}

    /** The live mask follows the slot modes now; parameter changes without a step this frame still reach the worker
     *  (and through it the texture's parameter texels). */
    flush() {
        let live = 0;
        for(let s = 0; s < MAX_ZONES; s++) if(this.P[(P_SLOTA + s) * 4 + 3] > 0.5) live |= 1 << s;
        this.live.value = live;
        if(this.dirty && !this.sent) this._post(0, 0, false);
        this.sent = false;
    }

    run(substeps, { init = 0, kicks = false } = {}) {
        if(this.inflight >= 3) { this.stats.dropped += substeps; substeps = 0; } // the worker is behind
        if(!substeps && !init && !kicks && !this.dirty) return 0;
        this._post(substeps, init, kicks);
        this.sent = true;
        return substeps;
    }

    _post(substeps, init, kicks) {
        const buf = this.pool.pop() || null;
        this.dirty = false;
        this.inflight++;
        this.worker.postMessage({ op: 'step', P: this.P.slice(), substeps, dt: this.u.dt.value, kicks, init, buf }, buf ? [buf.buffer] : []);
    }

    /** Slot s's node displacements, 4 floats per node (after every step sent so far). */
    readSlot(s, nodes) {
        const id = this.readId++;
        return new Promise((resolve, reject) => { this.reads.set(id, { resolve, reject }); this.worker.postMessage({ op: 'read', id, slot: s, nodes }); });
    }

    /** The displacement the vertex stage draws at world point (x, y, z), skipping the slots in `skip`: the shader's
     *  trilinear lookup on the texture's data, on the CPU (ground riders, src/soft/GroundRider.js). out = [ux, uy, uz]. */
    sample(x, y, z, skip, out) {
        const d = this.tex.image.data, live = this.live.value;
        out[0] = out[1] = out[2] = 0;
        for(let s = 0; s < MAX_ZONES; s++) {
            if(!((live >> s) & 1) || ((skip >> s) & 1)) continue;
            const a = (PBASE + 3 * s) * 4;
            if(!(d[a + 3] > 0.5)) continue;
            const h = Math.max(0.25, d[a + 9]);
            const gx = (x - d[a]) / h, gy = (y - d[a + 1]) / h, gz = (z - d[a + 2]) / h;
            const bx = d[a + 4], by = d[a + 5], bz = d[a + 6];
            if(!(gx >= 0 && gy >= 0 && gz >= 0 && gx < bx - 1 && gy < by - 1 && gz < bz - 1)) continue;
            const ix = Math.floor(gx), iy = Math.floor(gy), iz = Math.floor(gz);
            const fx = gx - ix, fy = gy - iy, fz = gz - iz;
            const nx = bx | 0, nxy = (bx | 0) * (by | 0);
            const base = s * NODE_CAP + ix + iy * nx + iz * nxy;
            for(let c = 0; c < 8; c++) {
                const w = (c & 1 ? fx : 1 - fx) * ((c >> 1) & 1 ? fy : 1 - fy) * (c >> 2 ? fz : 1 - fz);
                if(w === 0) continue;
                const o = (base + (c & 1) + nx * ((c >> 1) & 1) + nxy * (c >> 2)) * 4;
                out[0] += d[o] * w; out[1] += d[o + 1] * w; out[2] += d[o + 2] * w;
            }
        }
        return out;
    }

    /** As SoftSim.deformNode, reading the displacements from the texture. */
    deformNode(skip) {
        const tex = this.tex, live = this.live;
        const fetch = (g) => textureLoad(tex, ivec2(g.mod(TEX_W), g.div(TEX_W)));
        const p = attribute('position', 'vec3');
        const n0 = attribute('normal', 'vec3');
        const wp = modelWorldMatrix.mul(vec4(p, 1)).xyz.toVar();
        const disp = vec3(0).toVar(), jx = vec3(0).toVar(), jy = vec3(0).toVar(), jz = vec3(0).toVar();
        for(let s = 0; s < MAX_ZONES; s++) {
            const A = fetch(int(PBASE + 3 * s)).toVar(), B = fetch(int(PBASE + 3 * s + 1)).toVar();
            const h = fetch(int(PBASE + 3 * s + 2)).y.max(0.25).toVar();
            const gp = wp.sub(A.xyz).div(h).toVar();
            const on = A.w.greaterThan(0.5).and(live.shiftRight(s).bitAnd(1).equal(1)).and(skip.shiftRight(s).bitAnd(1).equal(0))
                .and(gp.x.greaterThanEqual(0)).and(gp.y.greaterThanEqual(0)).and(gp.z.greaterThanEqual(0))
                .and(gp.x.lessThan(B.x.sub(1))).and(gp.y.lessThan(B.y.sub(1))).and(gp.z.lessThan(B.z.sub(1)));
            If(on, () => {
                const i0 = floor(gp).toVar();
                const f = gp.sub(i0).toVar();
                const nx = int(B.x).toVar(), nxy = int(B.x).mul(int(B.y)).toVar();
                const base = int(s * NODE_CAP).add(int(i0.x)).add(int(i0.y).mul(nx)).add(int(i0.z).mul(nxy)).toVar();
                const U = [];
                for(let c = 0; c < 8; c++) {
                    const a = c & 1, b = (c >> 1) & 1, d = c >> 2;
                    U.push(fetch(base.add(a).add(nx.mul(b)).add(nxy.mul(d))).xyz.toVar());
                }
                const lx = (a, b) => mix(a, b, f.x);
                const u00 = lx(U[0], U[1]), u10 = lx(U[2], U[3]), u01 = lx(U[4], U[5]), u11 = lx(U[6], U[7]);
                const uy0 = mix(u00, u10, f.y).toVar(), uy1 = mix(u01, u11, f.y).toVar();
                disp.addAssign(mix(uy0, uy1, f.z));
                const dx00 = U[1].sub(U[0]), dx10 = U[3].sub(U[2]), dx01 = U[5].sub(U[4]), dx11 = U[7].sub(U[6]);
                jx.addAssign(mix(mix(dx00, dx10, f.y), mix(dx01, dx11, f.y), f.z).div(h));
                jy.addAssign(mix(u10.sub(u00), u11.sub(u01), f.z).div(h));
                jz.addAssign(uy1.sub(uy0).div(h));
            });
        }
        const n = normalize(n0.sub(vec3(dot(jx, n0), dot(jy, n0), dot(jz, n0))));
        return { position: p.add(disp), normal: n, rest: wp };
    }
}
