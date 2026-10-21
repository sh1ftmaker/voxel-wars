/**
 * The authoritative terrain: owns a VoxelWorld and performs every edit of it (brush edits, connectivity and
 * detaching, stamping rubble back, sample patches such as soft-ground bakes, startup voxelization) plus pure grid
 * work (fracture splits). It runs in the terrain worker (src/workers/terrain.js); TerrainSync (main thread) keeps a
 * read-only replica of the world in step with it. Pure (no DOM, no three.js, no Rapier): also runs in Node and
 * in-process (TerrainSync's fallback when workers are unavailable).
 *
 * Messages (`core.handle(msg) -> { reply, transfer }`), every reply carries the changed chunks:
 *   { type: 'init' }                              voxelize Fort War; reply.chunks holds every chunk
 *   { type: 'brush', spec, op, mat, hardness, conn, erode, debris }
 *        applyBrush(brushFromSpec(spec)); with conn (carves) the regions that lost their support are cut out:
 *        reply.result { removed, added, changed, box }, reply.islands [{ grid, prep, dirty }] (become bodies),
 *        reply.dust [{ center, removed }] (islands too small for a body); then structural failure
 *        (src/voxel/structure.js, unless collapse: false): overhangs too weak to hold, cut free at their root, also
 *        in reply.islands with { collapse: { root (m), dir, reason } }; reply.collapseMs, collapseChecked
 *   { type: 'stamp', grid, t, q }                 union a body's grid into the world (islands.stampGrid)
 *   { type: 'samples', patch }                    VoxelWorld.writeSamples (soft-ground bakes)
 *   { type: 'split', grid, point?, n?, cells?, minCount, generation }   (cells: { labels, cellOf, cs, dims } of a soft body's crack)
 *        point/n: Voronoi fracture (voronoiLabels) else connected components; reply.pieces [grid with .prep],
 *        reply.same (the grid is one piece: nothing to split), reply.dust (Float64Array m³ per material)
 *   { type: 'carveGrid', grid, spec, lmin, lmax, t, m, f, hardness }
 *        carve a voxel body's grid (body frame: world = t + M (local - f)); reply { grid, removed, changed }
 * Any message may carry `recycle`: [typed arrays] the main thread no longer needs (CHUNK³ chunk arrays, padded
 * windows), transferred back and reused for later replies (no garbage per edit).
 * Every reply: { id, chunks: [{ key, fill, fillMat, version, sdf?, mat? }], dirty: [chunk keys to remesh],
 *               windows: [{ key, sdf, mat } | { key, empty: true }] (each dirty chunk's padded mesher window) }.
 */
import { VOXEL, CHUNK, PAD } from '../config.js';

const P3 = (CHUNK + 2 * PAD) ** 3, N3 = CHUNK ** 3;
import { VoxelWorld } from './VoxelWorld.js';
import { voxelize } from './voxelize.js';
import { brushFromSpec } from './brushes.js';
import { findIslands, detachIsland, stampGrid, splitGrid, voronoiLabels, gridPrep, carveGrid } from './islands.js';
import { cellSampleLabels } from '../softbody/lattice.js';
import { findCollapses } from './structure.js';
import { Level } from '../level/fortwar.js';

export class TerrainCore {
    constructor(world = null) {
        this.world = world;
        this.chunkPool = []; // Int8Array / Uint8Array of CHUNK³ (both kinds: only the length matters, filled with .set)
        this.windowPool = []; // padded window arrays
        this.dirty = new Set();
        this.touched = new Set();
        if(world) this._listen();
    }
    _listen() {
        this.world.onChange((r) => { for(const k of r.dirty) this.dirty.add(k); });
    }
    handle(msg) {
        const transfer = [];
        // arrays the main thread is done with (old replica chunks, used mesher windows), for reuse
        if(msg.recycle) for(const a of msg.recycle) {
            const pool = a.length === N3 ? this.chunkPool : a.length === P3 ? this.windowPool : null;
            if(pool && pool.length < 256) pool.push(a);
        }
        let reply;
        switch(msg.type) {
            case 'init': reply = this.init(msg); break;
            case 'brush': reply = this.brush(msg, transfer); break;
            case 'stamp': { const r = stampGrid(this.world, msg.grid, msg.t, msg.q); reply = { result: { added: r.added, changed: r.changed, box: r.box } }; break; }
            case 'samples': { const r = this.world.writeSamples(msg.patch); reply = { result: { changed: r.changed, box: r.box } }; break; }
            case 'split': reply = this.split(msg, transfer); break;
            case 'carveGrid': reply = this.carveGrid(msg, transfer); break;
            default: throw new Error(`terrain core: unknown message ${msg.type}`);
        }
        reply.id = msg.id;
        reply.type = msg.type;
        if(msg.type !== 'init') this._collect(reply, transfer);
        return { reply, transfer };
    }
    init() {
        this.world = new VoxelWorld();
        const t0 = performance.now();
        voxelize(this.world, new Level());
        this._listen();
        // warm the structural check's JIT (read only): the first blast in play should not wait on a cold one
        for(let k = 0; k < 3; k++) findCollapses(this.world, [-40 + k * 8, -8, -8], [-24 + k * 8, 8, 8]);
        const chunks = [];
        this.sent = new Map();
        for(const c of this.world.chunks.values()) { chunks.push(this._diff(c)); this.sent.set(c.key, c.version); }
        return { chunks, ms: performance.now() - t0 };
    }
    brush(msg, transfer) {
        const w = this.world, brush = brushFromSpec(msg.spec);
        const r = w.applyBrush(brush, { op: msg.op, mat: msg.mat, hardness: msg.hardness });
        const reply = { result: { removed: r.removed, added: r.added, changed: r.changed, box: r.box }, islands: [], dust: [] };
        if(msg.conn && msg.op === 'carve' && r.changed) {
            const t0 = performance.now();
            const res = findIslands(w, r.box[0], r.box[1], { erode: msg.erode ?? 0, near: brush });
            for(const isl of res.islands) {
                const small = isl.count < msg.debris;
                const d = detachIsland(w, isl, { keepGrid: !small });
                if(!d.count) continue;
                if(small || !d.grid.count) { reply.dust.push({ center: isl.min.map((v, a) => (v + isl.max[a]) * 0.5 * VOXEL), removed: d.removed }); continue; }
                const g = d.grid;
                g.prep = gridPrep(g, 0);
                transfer.push(g.sdf.buffer, g.mat.buffer);
                reply.islands.push({ grid: g, dirty: [...d.dirty] });
            }
            reply.islandsMs = performance.now() - t0;
            // structural failure: overhangs still attached but too weak to hold themselves (src/voxel/structure.js)
            if(msg.collapse !== false) {
                const t1 = performance.now();
                const col = findCollapses(w, r.box[0], r.box[1]);
                for(const isl of col.islands) {
                    const small = isl.count < msg.debris;
                    const d = detachIsland(w, isl, { keepGrid: !small });
                    if(!d.count) continue;
                    if(small || !d.grid.count) { reply.dust.push({ center: isl.min.map((v, a) => (v + isl.max[a]) * 0.5 * VOXEL), removed: d.removed }); continue; }
                    const g = d.grid;
                    g.prep = gridPrep(g, 0);
                    transfer.push(g.sdf.buffer, g.mat.buffer);
                    reply.islands.push({ grid: g, dirty: [...d.dirty], collapse: isl.collapse });
                }
                reply.collapseMs = performance.now() - t1;
                reply.collapseChecked = col.checked;
            }
        }
        return reply;
    }
    split(msg, transfer) {
        const g = msg.grid;
        const dust = new Float64Array(256);
        const c = msg.cells; // a soft body's crack: labels per lattice cell (src/softbody)
        const labels = c ? cellSampleLabels(g, c.labels, c.cellOf, c.cs, c.dims) : msg.n ? voronoiLabels(g, msg.point, msg.n) : null;
        const pieces = splitGrid(g, labels, { minCount: msg.minCount ?? 0, dust });
        const same = pieces.length === 1 && pieces[0] === g;
        for(const p of pieces) {
            p.prep = gridPrep(p, msg.generation ?? 0);
            if(!same) transfer.push(p.sdf.buffer, p.mat.buffer);
        }
        return { pieces: same ? [] : pieces, same, prep: same ? pieces[0].prep : null, dust };
    }
    /** Carve a body's grid with a world brush seen from the body's frame (as VoxelBodies.carve does on the main
     *  thread): world = t + M (local - f), M row-major. The grid comes back (transferred) with what was removed. */
    carveGrid(msg, transfer) {
        const b = brushFromSpec(msg.spec), t = msg.t, m = msg.m, f = msg.f;
        const local = { min: msg.lmin, max: msg.lmax, d: (x, y, z) => {
            const lx = x - f[0], ly = y - f[1], lz = z - f[2];
            return b.d(t[0] + m[0] * lx + m[1] * ly + m[2] * lz, t[1] + m[3] * lx + m[4] * ly + m[5] * lz, t[2] + m[6] * lx + m[7] * ly + m[8] * lz);
        } };
        const g = msg.grid;
        const r = carveGrid(g, local, { hardness: msg.hardness });
        transfer.push(g.sdf.buffer, g.mat.buffer);
        return { grid: g, removed: r.removed, changed: r.changed };
    }
    /** Chunk contents as a message (copies: the core keeps its own). */
    _diff(c) { return { key: c.key, fill: c.fill, fillMat: c.fillMat, version: c.version, sdf: c.sdf ? this._copy(c.sdf, Int8Array) : null, mat: c.mat ? this._copy(c.mat, Uint8Array) : null }; }
    /** A copy of a chunk array, in a recycled buffer when one is free. */
    _copy(a, T) { const b = this.chunkPool.pop(); if(!b) return a.slice(); const v = new T(b.buffer); v.set(a); return v; }
    _window(T) { const b = this.windowPool.pop(); return b ? new T(b.buffer) : new T(P3); }
    _collect(reply, transfer) {
        const chunks = [];
        const sent = this.sent ||= new Map();
        for(const k of this.dirty) {
            const c = this.world.chunks.get(k);
            if(!c || sent.get(k) === c.version) continue;
            sent.set(k, c.version);
            const d = this._diff(c);
            if(d.sdf) transfer.push(d.sdf.buffer, d.mat.buffer);
            chunks.push(d);
        }
        reply.chunks = chunks;
        reply.dirty = [...this.dirty];
        // the padded mesh windows of the dirty chunks, so the main thread hands them to the mesher as they are
        const windows = [];
        for(const k of this.dirty) {
            const c = this.world.chunks.get(k);
            if(!c) continue;
            const sdf = this._window(Int8Array), mat = this._window(Uint8Array);
            if(this.world.extractPadded(c.cx, c.cy, c.cz, sdf, mat)) { windows.push({ key: k, sdf, mat }); transfer.push(sdf.buffer, mat.buffer); }
            else { windows.push({ key: k, empty: true }); this.windowPool.push(sdf, mat); }
        }
        reply.windows = windows;
        this.dirty.clear();
    }
}
