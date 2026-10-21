/**
 * The one entry point for changing matter. Gameplay calls these; they edit the VoxelWorld (and detached voxel bodies),
 * push physics bodies around, detect what lost its support, and announce what was destroyed.
 *
 * API (gameplay depends on these signatures):
 *   destruction.carve(brush, { op = 'carve', mat, hardness = true, author, impulse, kind, dir })
 *       brush from src/voxel/brushes.js. Returns { removed: Float64Array m³ per material, volume, added, center, box }.
 *       `impulse` (number) also kicks dynamic bodies near the brush outward. `dir` (unit vector): the blow's direction (a
 *       punch: the soft ground is driven in along it).
 *       A carve also cuts every voxel body it overlaps (and splits bodies cut in two), then queues a check of the
 *       terrain around the edit for regions that lost their support: those become bodies over the next few frames
 *       ('detached'), pushed by the blast's impulse.
 *   destruction.blast(center, radius, { strength, author, seed })    rock-shaped crater + impulse; returns carve's result
 *   destruction.rip(center, radius, { author }) -> Prop | null        tear a lump of terrain out as a dynamic body
 *                                                                     (Donkey Kong style: grab it, throw it)
 *       The prop's body origin is the lump's centre; userData { voxelBody, ripped: true, mat, volume, mass, author }.
 *
 * Additions (physics agent):
 *   destruction.brushes                    the brush module (sphere, capsule, box, rock, ...), for tools and tests
 *   destruction.bodies                     VoxelBodies (src/physics/VoxelBodies.js): live detached bodies, tuning
 *   result.detached                        always [] now: connectivity runs in the background under a frame budget,
 *                                          detached bodies arrive over the next frames as 'detached' events
 *
 * Additions (perf): with the terrain worker (world.remote, src/voxel/TerrainSync.js) a carve is asynchronous: the
 *   returned result is provisional (result.pending; removed / volume count only the voxel bodies it cut, changed 0)
 *   and `result.done` is a Promise of the final result. 'destroyed' and 'detached' fire when the worker answers
 *   (a frame or two later). Without the worker result.done resolves at once to the same object.
 *
 * Net (src/net): with ctx.net every terrain edit is submitted to the room's edit log and applied when it comes back in
 *   sequence order (single player: LocalTransport answers synchronously, so nothing changes). The submitter carves
 *   voxel bodies and pushes physics bodies at once; other clients do that when the edit arrives. Edit kinds handled
 *   here: 'brush' { spec, op, mat, hardness, conn, erode, debris, lift, kind, impulse, dir, author } and 'samples'
 *   { patch } (soft-ground bakes, world.applySamples); VoxelBodies handles 'stamp' and 'bsplit'.
 *
 * Events on ctx.events (CustomEvent, data in e.detail):
 *   'destroyed' { center: [x,y,z], box: [min, max] (metres), removed: Float64Array, volume, author, kind: 'carve'|'blast'|'impact' }
 *   'detached'  { prop, volume, mat }      a piece of terrain broke loose and is now a body
 *   'impact'    { point, speed, mat, prop } a voxel body hit something hard (speed = its velocity change, m/s)
 */
import { VOXEL } from '../config.js';
import { rock, specOf, brushFromSpec } from '../voxel/brushes.js';
import * as brushes from '../voxel/brushes.js';
import { VoxelBodies, DEBRIS } from './VoxelBodies.js';

export class Destruction {
    constructor(ctx) {
        this.ctx = ctx;
        this.seed = 1;
        this.bodies = new VoxelBodies(ctx);
        this.brushes = brushes; // the brush constructors (src/voxel/brushes.js), for tools and tests
        /** Soft ground (src/soft/SoftGround.js) and other observers: fn({ op, center, size, impulse, kind, changed, box, dir })
         *  after every carve / add (box in metres). */
        this.editHooks = [];
        const net = ctx.net;
        if(net) {
            net.on('brush', (e, meta) => this._applyBrush(e, meta));
            net.on('samples', (e) => ctx.world.remote.samples(e.patch));
            ctx.world.applySamples = (patch) => net.submit({ k: 'samples', patch });
        }
    }
    /** Submit a terrain edit to the edit log (or apply it here when there is no net). Resolves to the worker's reply. */
    submit(e) {
        const net = this.ctx.net;
        return net ? net.submit(e) : this._applyBrush(e, { local: true, seq: 0, from: null });
    }
    /**
     * A 'brush' edit in sequence order: the terrain worker applies it (connectivity, structural collapse); islands that
     * came loose become bodies (ids from the edit's seq), the soft ground hears about it. An edit from another client
     * also carves this client's voxel bodies, pushes bodies around and emits 'destroyed' (the submitter did that
     * already). Returns the reply's promise.
     */
    _applyBrush(e, { local, seq, from, history = false }) {
        const { world, physics, events } = this.ctx;
        const brush = brushFromSpec(e.spec);
        const center = brush.min.map((v, i) => (v + brush.max[i]) / 2);
        const kick = e.impulse ? { center, radius: Math.max(...brush.max.map((v, i) => v - brush.min[i])) * 0.9, strength: e.impulse } : null;
        if(history) return world.remote.brush(e.spec, { op: e.op, mat: e.mat, hardness: e.hardness, conn: e.conn, erode: e.erode, debris: e.debris });
        if(!local && !e.lift) {
            if(e.op === 'carve') this.bodies.carve(brush, { hardness: e.hardness });
            if(kick) physics.explode(kick.center, kick.radius, kick.strength);
        }
        return world.remote.brush(e.spec, { op: e.op, mat: e.mat, hardness: e.hardness, conn: e.conn, erode: e.erode, debris: e.debris, lift: e.lift }).then(rep => {
            rep.seq = seq;
            this.bodies.fromWorker(rep, kick, { seq, from, local, lift: e.lift });
            const r = rep.result;
            const box = [r.box[0].map(x => x * VOXEL), r.box[1].map(x => x * VOXEL)];
            if(this.editHooks.length && !e.lift) {
                const size = Math.max(...brush.max.map((x, i) => x - brush.min[i])) / 2;
                for(const fn of this.editHooks) try { fn({ op: e.op, center, size, impulse: e.impulse || 0, kind: e.kind, changed: r.changed, box, dir: e.dir || null }); } catch(err) { console.error(err); }
            }
            if(!local) {
                let v = 0;
                for(let i = 0; i < 256; i++) v += r.removed[i];
                if(v > 0) events.dispatchEvent(new CustomEvent('destroyed', { detail: { center, box, removed: r.removed, volume: v, author: e.author ?? null, kind: e.kind || 'carve', remote: true } }));
            }
            return rep;
        });
    }
    carve(brush, opts = {}) {
        if(this.ctx.world.remote) return this._carveRemote(brush, opts);
        const { op = 'carve', mat = 1, hardness = true, author = null, impulse = 0, kind = 'carve', dir = null } = opts;
        const { world, physics, events } = this.ctx;
        const r = world.applyBrush(brush, { op, mat, hardness });
        const center = brush.min.map((v, i) => (v + brush.max[i]) / 2);
        const removed = r.removed;
        const detached = [];
        const kick = impulse ? { center, radius: Math.max(...brush.max.map((v, i) => v - brush.min[i])) * 0.9, strength: impulse } : null;
        if(op === 'carve') {
            const b = this.bodies.carve(brush, { hardness });
            if(b.volume > 0) for(let i = 0; i < 256; i++) removed[i] += b.removed[i];
            // what lost its support breaks loose over the next frames ('detached' events), pushed by this blast
            if(r.changed) this.bodies.queueConnectivity(r.box[0], r.box[1], brush, kick);
        }
        let volume = 0;
        for(let i = 0; i < 256; i++) volume += removed[i];
        if(kick) physics.explode(kick.center, kick.radius, kick.strength);
        const box = [r.box[0].map(v => v * VOXEL), r.box[1].map(v => v * VOXEL)];
        const result = { removed, volume, added: r.added, center, box, changed: r.changed, detached };
        if(this.editHooks.length) {
            const size = Math.max(...brush.max.map((v, i) => v - brush.min[i])) / 2;
            for(const fn of this.editHooks) try { fn({ op, center, size, impulse, kind, changed: r.changed, box, dir }); } catch(e) { console.error(e); }
        }
        if(volume > 0) events.dispatchEvent(new CustomEvent('destroyed', { detail: { center, box, removed, volume, author, kind } }));
        result.done = Promise.resolve(result);
        return result;
    }
    /**
     * The terrain worker's path (world.remote, src/voxel/TerrainSync.js): voxel bodies are carved and pushed now; the
     * terrain edit, connectivity and detaching run in the worker and land a frame or two later. The result returned
     * at once is provisional (removed / volume count the bodies only, changed 0, box the brush's); `result.done`
     * resolves to the final one, and 'destroyed', 'detached' and the edit hooks fire then.
     */
    _carveRemote(brush, { op = 'carve', mat = 1, hardness = true, author = null, impulse = 0, kind = 'carve', dir = null } = {}) {
        const { world, physics, events } = this.ctx;
        const center = brush.min.map((v, i) => (v + brush.max[i]) / 2);
        const removed = new Float64Array(256);
        const kick = impulse ? { center, radius: Math.max(...brush.max.map((v, i) => v - brush.min[i])) * 0.9, strength: impulse } : null;
        let volume = 0;
        let bodyDone = null;
        if(op === 'carve') {
            const b = this.bodies.carve(brush, { hardness });
            if(b.volume > 0) for(let i = 0; i < 256; i++) { removed[i] += b.removed[i]; volume += b.removed[i]; }
            bodyDone = b.done;
        }
        if(kick) physics.explode(kick.center, kick.radius, kick.strength);
        const result = { removed, volume, added: 0, center, box: [brush.min.map(v => v - 4 * VOXEL), brush.max.map(v => v + 4 * VOXEL)], changed: 0, detached: [], pending: true };
        const bodies = this.bodies;
        const terrainDone = this.submit({ k: 'brush', spec: specOf(brush), op, mat, hardness, conn: op === 'carve', erode: Math.max(0, bodies.erode), debris: DEBRIS, kind, impulse, dir, author });
        result.done = Promise.all([terrainDone, bodyDone]).then(([rep, b]) => {
            if(b) for(let i = 0; i < 256; i++) removed[i] += b.removed[i]; // the bodies' share (carved in the worker too)
            const r = rep.result;
            let v = 0;
            for(let i = 0; i < 256; i++) { removed[i] += r.removed[i]; v += removed[i]; }
            result.volume = v; result.added = r.added; result.changed = r.changed; result.pending = false;
            result.box = [r.box[0].map(x => x * VOXEL), r.box[1].map(x => x * VOXEL)];
            if(v > 0) events.dispatchEvent(new CustomEvent('destroyed', { detail: { center, box: result.box, removed, volume: v, author, kind } }));
            return result;
        });
        return result;
    }
    blast(center, radius, { strength = 14, author = null, seed } = {}) {
        return this.carve(rock(center, radius, seed ?? this.seed++), { author, impulse: strength, kind: 'blast' });
    }
    /** Tear a roughly spherical lump out of the terrain and return it as a dynamic body (null if there is no matter). */
    rip(center, radius, { author = null, seed } = {}) {
        const vb = this.bodies.rip(rock(center, radius, seed ?? this.seed++), { author });
        return vb ? vb.prop : null;
    }
}
