/**
 * The CPU backend of the granular ground (WebGL2, or ?mpmCpu=1): the PB-MPM solver in a worker
 * (src/workers/mpmSim.js), at most CPU_CAP particles, one step in flight (when the worker falls behind, the grains
 * move in slow motion rather than stall the frame). The same calls as MpmGPU where Mpm.js uses them.
 */
import { CPU_CAP, MAX_ZONES } from './params.js';

export class MpmCPU {
    constructor({ cap = CPU_CAP, knobs } = {}) {
        this.cpu = true;
        this.cap = cap;
        this.n = 0;
        this.counts = new Array(MAX_ZONES).fill(0);
        this.statsNow = new Uint32Array(MAX_ZONES * 2);
        this.inflight = false;
        this.spare = new Float32Array(cap * 4);
        this.frame = null;     // the last frame's data: { buf, n }
        this.stats = { workerMs: 0, frames: 0 };
        this.reads = new Map(); this.readId = 1;
        this.worker = new Worker(new URL('./mpmSim.js', import.meta.url), { type: 'module' });
        this.worker.onmessage = (e) => this._msg(e.data);
        this.worker.postMessage({ op: 'init', cap, knobs });
    }
    _msg(m) {
        if(m.op === 'frame') {
            this.inflight = false;
            if(this.frame) this.spare = this.frame.buf;
            this.frame = { buf: m.buf, n: m.n };
            this.n = m.n;
            this.statsNow.set(m.stats);
            this.stats.frames++; this.stats.workerMs = this.stats.workerMs * 0.9 + m.ms * 0.1;
            this.onFrame?.(this.frame);
        } else if(m.op === 'read') { this.reads.get(m.id)?.(m); this.reads.delete(m.id); }
        else if(m.op === 'error') console.error('mpm worker', m.error);
    }
    get free() { return this.cap - this.n - this.pendingSpawn; }
    pendingSpawn = 0;
    setZone(s, zone) { this.worker.postMessage({ op: 'zone', slot: s, zone }); }
    removeZone(s) { this.worker.postMessage({ op: 'remove', slot: s }); this.counts[s] = 0; }
    setKnobs(knobs) { this.worker.postMessage({ op: 'knobs', knobs }); }
    setProxies(list) { this.worker.postMessage({ op: 'proxies', list }); }
    spawn(s, { pos, vel, mats, ppcLog }, { dt }) {
        const n = Math.min(mats.length, Math.max(0, this.free));
        if(n <= 0) return 0;
        const p = pos.slice(0, n * 3), v = vel ? vel.slice(0, n * 3) : null, m = mats.slice(0, n);
        this.worker.postMessage({ op: 'spawn', slot: s, pos: p, vel: v, mats: m, ppcLog, dt }, [p.buffer, m.buffer, ...(v ? [v.buffer] : [])]);
        this.counts[s] += n;
        this.n += n;
        return n;
    }
    step({ dt }) {
        if(this.inflight) return 0;
        this.inflight = true;
        const buf = this.spare && this.spare.length >= this.cap * 4 ? this.spare : new Float32Array(this.cap * 4);
        this.spare = null;
        this.worker.postMessage({ op: 'step', dt, buf }, [buf.buffer]);
        return 1;
    }
    readStats() { return Promise.resolve(this.statsNow.slice()); }
    /** Slot s's particles: world xyz + packed word, 4 floats each (the same layout as the GPU's after conversion). */
    readSlot(s) {
        const id = this.readId++;
        return new Promise((resolve) => {
            this.reads.set(id, (m) => resolve({ world: true, pos: m.pos, w: m.w }));
            this.worker.postMessage({ op: 'read', slot: s, id });
        });
    }
}
