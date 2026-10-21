/**
 * Main-thread side of the terrain worker. The worker (src/workers/terrain.js running TerrainCore) owns the
 * authoritative VoxelWorld and does every edit; the main thread's `world` is a read-only replica, kept in step by the
 * chunk contents each reply carries, so synchronous queries (sample, raycast, normal, materialAt, extractPadded for
 * meshing) keep working. Replies are applied in order as they arrive (a worker message between frames), then the
 * replica's change listeners run once per edit (renderers remesh, colliders follow). The change result also carries
 * `windows` (Map chunk key -> { sdf, mat } | { empty }): the dirty chunks' padded mesher windows, extracted in the
 * worker, so remeshing does not read the replica on the main thread.
 *
 *   const sync = new TerrainSync(world, { worker = true })   sets world.remote = sync and world.applySamples
 *   await sync.init()                                         voxelize the level in the worker, fill the replica
 *   sync.brush(brush, { op, mat, hardness, conn, erode, debris }) -> Promise<reply>   (TerrainCore 'brush')
 *   sync.stamp(grid, t, q) -> Promise<reply>                  union a grid into the world (copied, not transferred)
 *   sync.samples(patch) -> Promise<reply>                     write a sample patch (soft-ground bakes)
 *   world.applySamples(patch)                                 the same, the documented entry for src/soft
 *   sync.split(grid, { point, n, cells, minCount, generation }) -> Promise<reply>   fracture / component split (grid copied)
 *   sync.carveGrid(grid, spec, { lmin, lmax, t, m, f, hardness }) -> Promise<reply>   carve a body's grid
 *   sync.pending                                              requests in flight
 *   sync.stats                                                { requests, lastMs (worker time), maxMs }
 *
 * Without workers (Node, or ?terrainWorker=0) the same TerrainCore runs in-process behind the same asynchronous
 * interface (replies on a microtask), so callers see one behaviour.
 */
import { specOf } from './brushes.js';
import { TerrainCore } from './TerrainCore.js';

export class TerrainSync {
    constructor(world, { worker = true } = {}) {
        this.world = world;
        this.nextId = 1;
        this.waiting = new Map(); // id -> { resolve, reject }
        this.stats = { requests: 0, lastMs: 0, maxMs: 0 };
        this.spare = []; // arrays to hand back to the worker
        if(worker && typeof Worker !== 'undefined') {
            this.worker = new Worker(new URL('./terrain.js', import.meta.url), { type: 'module' });
            this.worker.onmessage = (e) => this._reply(e.data);
            this.worker.onerror = (e) => console.error('terrain worker', e.message || e);
        } else {
            this.core = new TerrainCore();
        }
        world.remote = this;
        world.applySamples = (patch) => this.samples(patch);
    }
    get pending() { return this.waiting.size; }
    /** Hand arrays back to the worker for reuse (sent with the next request). */
    recycle(...arrays) { for(const a of arrays) if(a && this.spare.length < 512) this.spare.push(a); }
    _send(msg, transfer = []) {
        const id = msg.id = this.nextId++;
        if(this.spare.length && this.worker) { msg.recycle = this.spare; for(const a of this.spare) transfer.push(a.buffer); this.spare = []; }
        this.stats.requests++;
        return new Promise((resolve, reject) => {
            this.waiting.set(id, { resolve, reject });
            if(this.worker) this.worker.postMessage(msg, transfer);
            else queueMicrotask(() => {
                let rep;
                try { const t0 = performance.now(); rep = this.core.handle(msg).reply; rep.workerMs = performance.now() - t0; }
                catch(err) { rep = { id, type: msg.type, error: String(err?.stack || err) }; }
                this._reply(rep);
            });
        });
    }
    _reply(rep) {
        const w = this.waiting.get(rep.id);
        this.waiting.delete(rep.id);
        if(rep.error) { console.error('terrain worker:', rep.error); w?.reject(new Error(rep.error)); return; }
        if(rep.workerMs !== undefined && rep.type !== 'init') { this.stats.lastMs = rep.workerMs; this.stats.maxMs = Math.max(this.stats.maxMs * 0.99, rep.workerMs); }
        if(rep.chunks?.length) {
            // the replaced arrays go back to the worker (nothing else holds them: meshing copies windows)
            if(rep.type !== 'init') for(const d of rep.chunks) { const c = this.world.chunks.get(d.key); if(c?.sdf) this.recycle(c.sdf, c.mat); }
            this.world.setChunks(rep.chunks);
            if(rep.type !== 'init') {
                const r = rep.result || {};
                const windows = new Map();
                for(const w of rep.windows || []) windows.set(w.key, w);
                this.world.notify({ removed: r.removed || new Float64Array(256), added: r.added || 0, changed: r.changed || 1, dirty: new Set(rep.dirty), box: r.box || [[0, 0, 0], [0, 0, 0]], kind: rep.type, windows });
            }
        }
        w?.resolve(rep);
    }

    async init() {
        const rep = await this._send({ type: 'init' });
        console.log(`terrain worker: voxelized in ${rep.ms.toFixed(0)} ms${this.worker ? ' (off the main thread)' : ''}`);
        return rep;
    }
    brush(brush, { op = 'carve', mat = 1, hardness = true, conn = false, erode = 0, debris = 16 } = {}) {
        return this._send({ type: 'brush', spec: specOf(brush), op, mat, hardness, conn, erode, debris });
    }
    stamp(grid, t, q) { return this._send({ type: 'stamp', grid: copyGrid(grid), t, q }); }
    samples(patch) { return this._send({ type: 'samples', patch }); }
    carveGrid(grid, spec, { lmin, lmax, t, m, f, hardness = true }) {
        return this._send({ type: 'carveGrid', grid: copyGrid(grid), spec, lmin, lmax, t, m, f, hardness });
    }
    split(grid, { point = null, n = 0, cells = null, minCount = 0, generation = 0 } = {}) {
        return this._send({ type: 'split', grid: copyGrid(grid), point, n, cells, minCount, generation });
    }
}

/** A grid without extra fields (prep, ...), its arrays copied by the structured clone. */
function copyGrid(g) { return { nx: g.nx, ny: g.ny, nz: g.nz, sdf: g.sdf, mat: g.mat, count: g.count, offset: g.offset }; }
