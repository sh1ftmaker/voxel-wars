/**
 * The fluid without WebGPU compute (WebGL2 backend, or ?fluidCpu=1): the same interface as FluidGPU, but the solver
 * (src/fluid/cpuSolver.js) runs in a worker (src/workers/fluid.js) and the particles reach the renderer through
 * instanced attributes uploaded each time the worker answers (one step in flight; when it falls behind, steps are
 * dropped and the fluid moves in slow motion).
 */
import * as THREE from 'three/webgpu';
import { instancedBufferAttribute } from 'three/tsl';
import { PAGE } from './sdfPages.js';
import { MAX_KICKS } from './params.js';

export class FluidCPU {
    constructor(renderer, settings) {
        this.cpu = true;
        this.cap = settings.cap;
        this.extent = 0;
        this.pages = settings.pages;
        this.posAttr = new THREE.InstancedBufferAttribute(new Float32Array(this.cap * 4), 4);
        this.infoAttr = new THREE.InstancedBufferAttribute(new Float32Array(this.cap * 4), 4); // surface normal, density
        this.spdAttr = new THREE.InstancedBufferAttribute(new Float32Array(this.cap), 1);
        for(const a of [this.posAttr, this.infoAttr, this.spdAttr]) a.setUsage(THREE.DynamicDrawUsage);
        this.spare = { pos: new Float32Array(this.cap * 4), info: new Float32Array(this.cap * 4), spd: new Float32Array(this.cap) };
        this.inflight = false;
        this.backlog = 0;
        this.lastStats = null;
        this.stats = { workerMs: 0, workerMax: 0, dropped: 0 };
        this.proxies = new Float32Array(0); this.nProxies = 0; this.kicks = new Float32Array(MAX_KICKS * 8);
        this.worker = new Worker(new URL('./fluid.js', import.meta.url), { type: 'module' });
        this.worker.onmessage = (e) => this._onMessage(e.data);
        const { spacing, cap, iterations, substeps } = settings;
        this.worker.postMessage({ op: 'init', settings: { spacing, cap, iterations, substeps }, table: this.pages.table.slice(), data: this.pages.data.slice() });
    }
    _onMessage(m) {
        if(m.op === 'error') { console.error('fluid worker', m.error); this.inflight = false; return; }
        if(m.op !== 'frame') return;
        this.inflight = false;
        const st = this.stats;
        st.workerMs = st.workerMs * 0.9 + m.ms * 0.1; st.workerMax = Math.max(st.workerMax * 0.995, m.ms);
        const n = m.n;
        for(const [a, src, k] of [[this.posAttr, m.pos, 4], [this.infoAttr, m.info, 4], [this.spdAttr, m.spd, 1]]) {
            a.array.set(src.subarray(0, n * k));
            a.clearUpdateRanges(); a.addUpdateRange(0, n * k); a.needsUpdate = true;
        }
        this.spare = { pos: m.pos, info: m.info, spd: m.spd };
        this.lastStats = m.stats;
    }
    write(start, n, data) {
        this.worker.postMessage({ op: 'write', start, n, data: data.slice(0, n * 8) });
        // show them at once (the worker's next frame replaces this)
        for(let i = 0; i < n; i++) { const o = (start + i) * 4, s = i * 8; this.posAttr.array.set(data.subarray(s, s + 4), o); this.infoAttr.array.set([0, 0, 0, 1], o); }
        this.posAttr.needsUpdate = true; this.infoAttr.needsUpdate = true;
        if(start + n > this.extent) this.extent = start + n;
    }
    updatePage(ci, page) {
        const entry = this.pages.table[ci];
        this.worker.postMessage({ op: 'page', ci, entry, bytes: page >= 0 ? this.pages.data.slice(page * PAGE, (page + 1) * PAGE) : null });
    }
    setInteraction(proxies, nProxies, kicks) {
        this.proxies = proxies; this.nProxies = nProxies;
        // kicks accumulate until a step carries them
        for(let k = 0; k < MAX_KICKS; k++) if(kicks[k * 8 + 3] > 0) this.kicks.set(kicks.subarray(k * 8, k * 8 + 8), k * 8);
    }
    step(steps, dt, { stats = false } = {}) {
        if(!this.extent || steps <= 0) return 0;
        if(this.inflight) { this.backlog += steps; return 0; }
        const n = Math.min(2, steps + this.backlog);
        this.stats.dropped += steps + this.backlog - n;
        this.backlog = 0;
        this.inflight = true;
        const { pos, info, spd } = this.spare;
        this.worker.postMessage({ op: 'step', steps: n, dt, proxies: this.proxies.slice(0, this.nProxies * 12), nProxies: this.nProxies, kicks: this.kicks.slice(), pos, info, spd },
            [pos.buffer, info.buffer, spd.buffer]);
        this.kicks.fill(0);
        return n;
    }
    /** The worker's latest stats as the GPU stats layout (Uint32Array: alive, moving, max speed bits, occupancy). */
    readStats() {
        const s = this.lastStats;
        if(!s) return null;
        this.lastStats = null;
        const out = new Uint32Array(3 + s.occ.length);
        out[0] = s.alive; out[1] = s.moving; out[2] = new Uint32Array(new Float32Array([s.maxSpeed]).buffer)[0];
        out.set(s.occ, 3);
        return Promise.resolve(out);
    }
    warmup() {}
    renderNodes() {
        return { pos: instancedBufferAttribute(this.posAttr), surf: instancedBufferAttribute(this.infoAttr), speed: instancedBufferAttribute(this.spdAttr) };
    }
}
