/**
 * The authoritative terrain: owns a VoxelWorld and performs every edit of it (brush edits, connectivity and
 * detaching, stamping rubble back, sample patches such as soft-ground bakes, startup voxelization) plus pure grid
 * work (fracture splits). It runs in the terrain worker (src/workers/terrain.js); TerrainSync (main thread) keeps a
 * read-only replica of the world in step with it. Pure (no DOM, no three.js, no physics engine): also runs in Node and
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
 *   { type: 'split', grid, point?, n?, cells?, minCount, generation, seed?, aniso? }   (cells: { labels, cellOf, cs, dims } of a soft body's crack;
 *        aniso: per axis Voronoi distance weights, wood's grain)
 *        point/n: Voronoi fracture (voronoiLabels) else connected components; reply.pieces [grid with .prep],
 *        reply.same (the grid is one piece: nothing to split), reply.dust (Float64Array m³ per material)
 *        seed: Voronoi sites from rng(seed) (deterministic across clients) instead of Math.random
 *   { type: 'carveGrid', grid, spec, lmin, lmax, t, m, f, hardness }
 *        carve a voxel body's grid (body frame: world = t + M (local - f)); reply { grid, removed, changed }
 *   brush with lift: true (a rip): before the carve, the matter inside the brush is lifted (islands.liftGrid) and
 *        returned as reply.lift (a grid with .prep), so every client makes the same lump
 *   { type: 'hash', keys? }                       reply.hashes [[key, FNV-1a of sdf + mat (or fill)], ...] (all chunks,
 *        or only `keys`); cached per chunk version, so a check costs only the chunks edited since the last one
 *   { type: 'chunks', keys?, modified? }          reply.data [{ key, fill, fillMat, sdf?, mat? }] (copies): `keys`, or with
 *        modified every chunk that differs from the generated level (late-join snapshots, src/net)
 *   { type: 'setChunks', data }                   overwrite chunks wholesale (resync, snapshots); dirty as an edit
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
import { findUnsupported } from './support.js';
import { cellSampleLabels } from '../softbody/lattice.js';
import { findCollapses } from './structure.js';
import { Level } from '../level/fortwar.js';
import { liftGrid } from './islands.js';
import { rng } from './brushes.js';
import { fnv1a } from '../net/codec.js';

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
            case 'hash': reply = { hashes: this.hashes(msg.keys) }; break;
            case 'chunks': reply = { data: this.chunkData(msg, transfer) }; break;
            case 'setChunks': reply = this.setChunks(msg.data); break;
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
        this.initVersion = new Map();
        for(const c of this.world.chunks.values()) { chunks.push(this._diff(c)); this.sent.set(c.key, c.version); this.initVersion.set(c.key, c.version); }
        return { chunks, ms: performance.now() - t0 };
    }
    brush(msg, transfer) {
        const w = this.world, brush = brushFromSpec(msg.spec);
        let lift = null;
        if(msg.lift) { lift = liftGrid(w, brush); lift.prep = gridPrep(lift, 0); transfer.push(lift.sdf.buffer, lift.mat.buffer); }
        const r = w.applyBrush(brush, { op: msg.op, mat: msg.mat, hardness: msg.hardness });
        const reply = { result: { removed: r.removed, added: r.added, changed: r.changed, box: r.box }, islands: [], dust: [], lift };
        const detach = (list) => {
            for(const isl of list) {
                const small = isl.count < (msg.debris ?? 16);
                const d = detachIsland(w, isl, { keepGrid: !small });
                if(!d.count) continue;
                if(small || !d.grid.count) { reply.dust.push({ center: isl.min.map((v, a) => (v + isl.max[a]) * 0.5 * VOXEL), removed: d.removed }); continue; }
                const g = d.grid;
                g.prep = gridPrep(g, 0);
                transfer.push(g.sdf.buffer, g.mat.buffer);
                reply.islands.push({ grid: g, dirty: [...d.dirty], support: !!isl.support, collapse: isl.collapse });
            }
        };
        if(msg.conn && msg.op === 'carve' && r.changed) {
            const t0 = performance.now();
            detach(findIslands(w, r.box[0], r.box[1], { erode: msg.erode ?? 0, near: brush }).islands);
            reply.islandsMs = performance.now() - t0;
            // structural failure: overhangs still attached but too weak to hold themselves (src/voxel/structure.js)
            if(msg.collapse !== false) {
                const t1 = performance.now();
                const col = findCollapses(w, r.box[0], r.box[1]);
                detach(col.islands);
                reply.collapseMs = performance.now() - t1;
                reply.collapseChecked = col.checked;
            }
        }
        if(msg.support === true && r.changed) { // the older reach-based check (src/voxel/support.js), opt-in; structure.js is the default
            const sup = findUnsupported(w, r.box[0], r.box[1]);
            detach(sup.islands);
            reply.supportMs = sup.ms;
        }
        return reply;
    }
    split(msg, transfer) {
        const g = msg.grid;
        const dust = new Float64Array(256);
        const c = msg.cells; // a soft body's crack: labels per lattice cell (src/softbody)
        const labels = c ? cellSampleLabels(g, c.labels, c.cellOf, c.cs, c.dims) : msg.n ? voronoiLabels(g, msg.point, msg.n, msg.seed != null ? rng(msg.seed) : Math.random, msg.aniso || null) : null;
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
    /** FNV-1a per chunk over its samples and materials (a uniform chunk: over fill and fillMat), cached by version. */
    hashes(keys = null) {
        const cache = this.hashCache ||= new Map(), out = [];
        const one = new Uint8Array(2);
        for(const c of keys ? keys.map(k => this.world.chunks.get(k)).filter(Boolean) : this.world.chunks.values()) {
            let e = cache.get(c.key);
            if(!e || e.v !== c.version) {
                let h;
                if(c.sdf) h = fnv1a(c.mat, fnv1a(new Uint8Array(c.sdf.buffer, c.sdf.byteOffset, c.sdf.byteLength)));
                else { one[0] = c.fill & 255; one[1] = c.fillMat; h = fnv1a(one); }
                cache.set(c.key, e = { v: c.version, h });
            }
            out.push([c.key, e.h]);
        }
        return out;
    }
    /** Chunk contents (copies) for snapshots and resyncs: `keys`, or `modified` (every chunk edited since init). */
    chunkData({ keys = null, modified = false }, transfer) {
        const list = keys ? keys.map(k => this.world.chunks.get(k)).filter(Boolean)
            : [...this.world.chunks.values()].filter(c => !modified || this.initVersion?.get(c.key) !== c.version);
        return list.map(c => {
            const d = { key: c.key, fill: c.fill, fillMat: c.fillMat, sdf: c.sdf ? c.sdf.slice() : null, mat: c.mat ? c.mat.slice() : null };
            if(d.sdf) transfer.push(d.sdf.buffer, d.mat.buffer);
            return d;
        });
    }
    /** Overwrite chunks wholesale (a resync or a late-join snapshot); they go to the replica as dirty chunks. */
    setChunks(data) {
        let changed = 0;
        const dirty = new Set();
        for(const d of data) {
            const c = this.world.chunks.get(d.key);
            if(!c) continue;
            c.sdf = d.sdf ? Int8Array.from(d.sdf) : null; c.mat = d.mat ? Uint8Array.from(d.mat) : null;
            c.fill = d.fill; c.fillMat = d.fillMat; c.version++;
            changed++;
            // neighbours too: their padded mesher windows read this chunk
            for(let dz = -1; dz <= 1; dz++) for(let dy = -1; dy <= 1; dy++) for(let dx = -1; dx <= 1; dx++) {
                const k = `${c.cx + dx},${c.cy + dy},${c.cz + dz}`;
                if(this.world.chunks.has(k)) dirty.add(k);
            }
        }
        for(const k of dirty) this.dirty.add(k);
        return { result: { changed, box: [[0, 0, 0], [0, 0, 0]] } };
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
