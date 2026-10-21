/**
 * Worker pool that meshes chunks (and detached bodies' grids) off the main thread. `request(key, extract)` queues a job (latest wins per key);
 * `extract(sdf, mat)` fills a padded window at dispatch time (so a job always meshes the newest data) and returns
 * false when there is nothing to mesh. Results come back through `onMesh(key, mesh | null)`.
 * Jobs are dispatched in priority order (`priority(key)`, lower first: e.g. distance to the camera).
 * For a non-chunk grid pass `dims` = [nx, ny, nz] (unpadded samples); extract then fills (n + 2*PAD) per axis.
 * `meshGrid(sdf, mat, dims)` meshes an already padded grid once (returns a Promise of the mesh).
 */
import { CHUNK, PAD } from '../config.js';

const P = CHUNK + 2 * PAD, P3 = P * P * P;

export class MeshPool {
    constructor({ size = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 1)), onMesh, priority = () => 0 } = {}) {
        this.onMesh = onMesh;
        this.priority = priority;
        this.queue = new Map(); // key -> extract
        this.idle = [];
        this.buffers = [];
        this.inflight = new Map(); // key -> latest job id in flight
        this.nextId = 1;
        this.oneShot = new Map(); // key -> resolve, for meshGrid
        for(let i = 0; i < size; i++) {
            const w = new Worker(new URL('./mesher.js', import.meta.url), { type: 'module' });
            w.onmessage = (e) => this._done(w, e.data);
            w.onerror = (e) => console.error('mesher worker', e.message || e);
            this.idle.push(w);
        }
    }
    request(key, extract, dims = null) { this.queue.set(key, { extract, dims }); this._pump(); }
    meshGrid(sdf, mat, dims) {
        return new Promise(resolve => {
            const key = `grid:${this.nextId++}`;
            this.oneShot.set(key, resolve);
            this.request(key, (s, m) => { s.set(sdf); m.set(mat); return true; }, dims);
        });
    }
    get pending() { return this.queue.size + this.inflight.size; }
    _buffer(len = P3) {
        if(len === P3) return this.buffers.pop() || { sdf: new Int8Array(P3), mat: new Uint8Array(P3) };
        return { sdf: new Int8Array(len), mat: new Uint8Array(len) };
    }
    _pump() {
        while(this.idle.length && this.queue.size) {
            let bestKey = null, best = Infinity;
            for(const k of this.queue.keys()) {
                if(this.inflight.has(k)) continue; // one job per chunk at a time; the newer request waits
                const p = this.priority(k);
                if(p < best) { best = p; bestKey = k; }
            }
            if(bestKey === null) return;
            const { extract, dims } = this.queue.get(bestKey);
            this.queue.delete(bestKey);
            const buf = this._buffer(dims ? dims.reduce((a, n) => a * (n + 2 * PAD), 1) : P3);
            if(!extract(buf.sdf, buf.mat)) { this._recycle(buf); this._deliver(bestKey, null); continue; }
            const id = this.nextId++;
            this.inflight.set(bestKey, id);
            const w = this.idle.pop();
            w.postMessage({ id, key: bestKey, sdf: buf.sdf, mat: buf.mat, dims }, [buf.sdf.buffer, buf.mat.buffer]);
        }
    }
    _recycle(buf) { if(buf.sdf.length === P3) this.buffers.push(buf); }
    _deliver(key, mesh) {
        const r = this.oneShot.get(key);
        if(r) { this.oneShot.delete(key); r(mesh); } else this.onMesh(key, mesh);
    }
    _done(w, { key, mesh, sdf, mat }) {
        this.inflight.delete(key);
        this._recycle({ sdf, mat });
        this.idle.push(w);
        this._deliver(key, mesh);
        this._pump();
    }
}
