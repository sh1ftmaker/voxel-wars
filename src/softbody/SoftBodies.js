/**
 * Soft debris: detached voxel bodies bend, jiggle and crack. Rapier keeps each body's rigid motion; on top of it a
 * body-local tet lattice (src/softbody/lattice.js) is simulated in a worker (src/workers/softBody.js) and drawn by
 * displacing the body mesh in the vertex shader (trilinear over the lattice nodes, read from a float texture atlas:
 * works on WebGL2 and WebGPU). Owned by VoxelBodies (bodies.soft).
 *
 *   soft.impact(vb, point, dv, frag)  the body's velocity changed by dv (world m/s, gravity excluded) at a contact
 *                                     point (world): matter far from the contact lags behind. frag > 1: the hit was
 *                                     hard enough to crack it (the worker breaks faces at toughness / frag)
 *   soft.blast(vb, center, radius, dv) a blast pushed it: the near side harder
 *   soft.inherit(kid, parent, off, frag) a piece of a broken body starts with the parent's wobble (frag: as impact)
 *   soft.gridChanged(vb)              its grid was carved: the lattice is rebuilt on the next kick
 *   soft.stop(vb) / soft.release(vb)  body removed (its mesh may still be shown as a ghost) / mesh gone
 *   soft.onSplit = (vb, split) => {}  the lattice came apart along broken faces (VoxelBodies.crack)
 *   soft.toughOf = (vb) => scale      toughness scale per body (0: never cracks), read when its lattice is built
 *
 * A lattice exists only while a body wobbles: it is built at the first kick (a frame later), sleeps in the worker
 * when calm (zero cost, displacement 0) and keeps its atlas slot only while awake. `?softDebris=0` turns it off.
 */
import * as THREE from 'three/webgpu';
import { Fn, If, int, ivec2, float, vec3, vec4, uniform, attribute, textureLoad, mix, floor, clamp, normalize, dot, positionLocal, normalLocal } from 'three/tsl';
import { NODE_CAP } from './lattice.js';

const W = 256, ROWS = NODE_CAP / W, SLOTS = 32;
const OFF = new THREE.Vector4(0, 0, 0, -1);

export class SoftBodies {
    constructor({ material, params = null }) {
        this.enabled = params?.get('softDebris') !== '0' && typeof Worker !== 'undefined';
        this.recs = new Map();      // id -> record
        this.nextId = 1;
        this.slots = new Array(SLOTS).fill(null);
        this.kicks = [];
        this.removals = [];
        this.busy = false;
        this.dt = 0;
        this.onSplit = null;
        this.stats = { awake: 0, ms: 0, msMax: 0, mainMs: 0, splits: 0, built: 0, steps: 0 };
        if(!this.enabled) return;
        this.atlas = new Float32Array(W * ROWS * SLOTS * 4);
        this.tex = new THREE.DataTexture(this.atlas, W, ROWS * SLOTS, THREE.RGBAFormat, THREE.FloatType);
        this.tex.minFilter = this.tex.magFilter = THREE.NearestFilter;
        this.tex.generateMipmaps = false;
        this.tex.needsUpdate = true;
        this.patchMaterial(material);
        this.worker = new Worker(new URL('./softBody.js', import.meta.url), { type: 'module' });
        this.worker.onmessage = (e) => this._message(e.data);
    }

    /** Displace the mesh by the lattice: positions (grid-local metres) and normals ((I + J)^-T n). */
    patchMaterial(mat) {
        const A = uniform(new THREE.Vector4()).onObjectUpdate(({ object }) => object.userData.voxelBody?.softRec?.A || OFF);
        const B = uniform(new THREE.Vector4(0, 0, 0, -1)).onObjectUpdate(({ object }) => object.userData.voxelBody?.softRec?.B || OFF);
        const tex = this.tex;
        mat.positionNode = Fn(() => {
            const p = attribute('position', 'vec3');
            const n0 = attribute('normal', 'vec3');
            const pos = p.toVar(), nrm = n0.toVar();
            If(B.w.greaterThanEqual(0), () => {
                // lattice coordinates; A = (origin, 1/h), B = (node dims, slot)
                const g = clamp(p.sub(A.xyz).mul(A.w), vec3(0), B.xyz.sub(1.001)).toVar();
                const i0 = floor(g).toVar();
                const f = g.sub(i0).toVar();
                const nx = int(B.x), nxy = int(B.x).mul(int(B.y));
                const base = int(B.w).mul(NODE_CAP).add(int(i0.x)).add(int(i0.y).mul(nx)).add(int(i0.z).mul(nxy)).toVar();
                const U = [];
                for(let c = 0; c < 8; c++) {
                    const a = c & 1, b = (c >> 1) & 1, d = c >> 2;
                    const k = base.add(a).add(nx.mul(b)).add(nxy.mul(d));
                    U.push(textureLoad(tex, ivec2(k.mod(W), k.div(W))).xyz.toVar());
                }
                const lx = (a, b) => mix(a, b, f.x);
                const u00 = lx(U[0], U[1]), u10 = lx(U[2], U[3]), u01 = lx(U[4], U[5]), u11 = lx(U[6], U[7]);
                const uy0 = mix(u00, u10, f.y), uy1 = mix(u01, u11, f.y);
                pos.addAssign(mix(uy0, uy1, f.z));
                const jx = mix(mix(U[1].sub(U[0]), U[3].sub(U[2]), f.y), mix(U[5].sub(U[4]), U[7].sub(U[6]), f.y), f.z).mul(A.w);
                const jy = mix(u10.sub(u00), u11.sub(u01), f.z).mul(A.w);
                const jz = uy1.sub(uy0).mul(A.w);
                nrm.assign(normalize(n0.sub(vec3(dot(jx, n0), dot(jy, n0), dot(jz, n0)))));
            });
            normalLocal.assign(nrm);
            return pos;
        })();
        mat.needsUpdate = true;
    }

    _rec(vb) {
        let r = vb.softRec;
        if(!r) { r = vb.softRec = { id: this.nextId++, vb, state: 'none', layout: null, slot: -1, A: new THREE.Vector4(), B: new THREE.Vector4(0, 0, 0, -1), pending: [] }; this.recs.set(r.id, r); }
        return r;
    }
    /** Make sure the worker has the body's lattice; kicks wait for it. */
    _ensure(vb) {
        const r = this._rec(vb);
        if(r.state === 'none' && !vb.dead) {
            const g = vb.grid;
            r.state = 'building';
            // copies: the grid stays the body's (carving, stamping)
            this.worker.postMessage({ op: 'add', id: r.id, tough: this.toughOf ? this.toughOf(vb) : 1, grid: { nx: g.nx, ny: g.ny, nz: g.nz, sdf: g.sdf.slice(), mat: g.mat.slice() } });
        }
        return r;
    }
    _kick(vb, k) {
        if(!this.enabled || vb.dead || vb.stamping || vb.prop.userData.held) return;
        const r = this._ensure(vb);
        if(r.state === 'dead') return;
        k.id = r.id;
        if(r.state === 'ready') this.kicks.push(k); else r.pending.push(k);
    }

    impact(vb, point, dv, frag = 1) {
        if(!this.enabled) return;
        const p = vb.toLocal(point), o = vb.toLocal([0, 0, 0]);
        const d = vb.toLocal(dv); // a direction: subtract the origin's image
        this._kick(vb, { type: 'impact', p, dv: [d[0] - o[0], d[1] - o[1], d[2] - o[2]], r: vb.radius * 1.4, frag });
    }
    blast(vb, center, radius, dv, frag = 1) {
        if(!this.enabled) return;
        this._kick(vb, { type: 'blast', c: vb.toLocal(center), r: radius + vb.radius, s: dv, frag });
    }
    /** A piece `kid` of `parent` (still in the worker until stop()) starts with its motion; off: the kid's grid-local
     *  origin in the parent's grid-local metres. */
    inherit(kid, parent, off, frag = 1) {
        const pr = parent.softRec;
        if(!this.enabled || !pr || !pr.layout || pr.gone) return; // the parent's lattice is in the worker until frame() flushes its removal
        const r = this._ensure(kid);
        if(r.state === 'building') { this.worker.postMessage({ op: 'inherit', id: r.id, parent: pr.id, off, frag }); this.poke = true; }
    }
    gridChanged(vb) {
        const r = vb.softRec;
        if(!r || r.state === 'none') return;
        this._drop(r, false);
        vb.softRec = null;
    }
    /** The body left physics; its mesh may stay a moment as a ghost (keeps its slot until release). */
    stop(vb) { const r = vb.softRec; if(r && r.state !== 'dead') { this.removals.push(r); r.state = 'dead'; } }
    release(vb) { const r = vb.softRec; if(r) { this.stop(vb); this._drop(r, true); vb.softRec = null; } }
    _drop(r, removed) {
        if(!removed && r.state !== 'dead') this.removals.push(r);
        r.state = 'dead';
        this._freeSlot(r);
        this.recs.delete(r.id);
    }
    _freeSlot(r) { if(r.slot >= 0) { if(this.slots[r.slot] === r) this.slots[r.slot] = null; r.slot = -1; r.B.w = -1; } }

    /** Once per frame (VoxelBodies._frame): kicks out, one step in flight at a time. */
    frame(dt) {
        if(!this.enabled) return;
        this.dt += dt;
        if(this.busy) return;
        const t0 = performance.now();
        for(const r of this.removals) { r.gone = true; this.worker.postMessage({ op: 'remove', id: r.id }); }
        this.removals.length = 0;
        if(!this.stats.awake && !this.kicks.length && !this.poke) { this.dt = 0; return; }
        this.poke = false;
        this.worker.postMessage({ op: 'step', dt: this.dt, kicks: this.kicks });
        this.kicks = [];
        this.dt = 0;
        this.busy = true;
        this.stats.mainMs = performance.now() - t0;
    }

    _message(m) {
        if(m.op === 'built') {
            const r = this.recs.get(m.id);
            if(!r || r.state === 'dead') return;
            if(!m.layout) { r.state = 'dead'; this.removals.push(r); return; } // too big or empty: stays rigid
            const L = r.layout = m.layout;
            r.state = 'ready';
            r.A.set(L.origin[0], L.origin[1], L.origin[2], 1 / L.h);
            r.B.set(L.nodes[0], L.nodes[1], L.nodes[2], -1);
            this.kicks.push(...r.pending);
            r.pending.length = 0;
            this.stats.built++;
            return;
        }
        if(m.op === 'error') { console.error('softBody worker', m.error); return; }
        if(m.op !== 'stepped') return;
        this.busy = false;
        this.stats.steps++;
        for(const s of m.splits) {
            const r = this.recs.get(s.id);
            if(!r || r.state !== 'ready') continue;
            r.state = 'split';
            this.stats.splits++;
            if(this.onSplit && !r.vb.dead) this.onSplit(r.vb, s);
        }
        if(m.same) return;
        const t0 = performance.now();
        this.stats.awake = m.ids.length;
        this.stats.ms = m.ms; this.stats.msMax = Math.max(this.stats.msMax * 0.99, m.ms);
        const awake = new Set();
        let at = 0, wrote = false;
        for(let k = 0; k < m.ids.length; k++) {
            const r = this.recs.get(m.ids[k]), n = m.nodes[k];
            if(r && r.state !== 'none') {
                awake.add(r);
                if(r.slot < 0) { const s = this.slots.indexOf(null); if(s >= 0) { this.slots[s] = r; r.slot = s; } }
                if(r.slot >= 0) {
                    this.atlas.set(m.data.subarray(at * 4, (at + n) * 4), r.slot * NODE_CAP * 4);
                    r.B.w = r.slot; wrote = true;
                }
            }
            at += n;
        }
        // asleep (or gone from the worker): back to the rigid mesh; dead ones keep their last pose for the ghost
        for(let s = 0; s < SLOTS; s++) { const r = this.slots[s]; if(r && !awake.has(r) && r.state !== 'dead') this._freeSlot(r); }
        if(wrote) this.tex.needsUpdate = true;
        this.stats.mainMs += performance.now() - t0;
    }
}
