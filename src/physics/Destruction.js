/**
 * The one entry point for changing matter. Gameplay calls these; they edit the VoxelWorld (and detached voxel bodies),
 * push physics bodies around, detect what lost its support, and announce what was destroyed.
 *
 * API (gameplay depends on these signatures):
 *   destruction.carve(brush, { op = 'carve', mat, hardness = true, author, impulse })
 *       brush from src/voxel/brushes.js. Returns { removed: Float64Array m³ per material, volume, added, center, box }.
 *       `impulse` (number) also kicks dynamic bodies near the brush outward.
 *       A carve also cuts every voxel body it overlaps (and splits bodies cut in two), then queues a check of the
 *       terrain around the edit for regions that lost their support: those become bodies over the next few frames
 *       ('detached'), pushed by the blast's impulse.
 *   destruction.blast(center, radius, { strength, author, seed })    rock-shaped crater + impulse; returns carve's result
 *   destruction.rip(center, radius, { author }) -> Prop | null        tear a lump of terrain out as a dynamic body
 *                                                                     (Donkey Kong style: grab it, throw it)
 *       The prop's body origin is the lump's centre; userData { voxelBody, ripped: true, mat, volume, mass, author }.
 *
 * Additions (physics agent):
 *   destruction.bodies                     VoxelBodies (src/physics/VoxelBodies.js): live detached bodies, tuning
 *   result.detached                        always [] now: connectivity runs in the background under a frame budget,
 *                                          detached bodies arrive over the next frames as 'detached' events
 *
 * Events on ctx.events (CustomEvent, data in e.detail):
 *   'destroyed' { center: [x,y,z], box: [min, max] (metres), removed: Float64Array, volume, author, kind: 'carve'|'blast'|'impact' }
 *   'detached'  { prop, volume, mat }      a piece of terrain broke loose and is now a body
 *   'impact'    { point, speed, mat, prop } a voxel body hit something hard (speed = its velocity change, m/s)
 */
import { VOXEL } from '../config.js';
import { rock } from '../voxel/brushes.js';
import { VoxelBodies } from './VoxelBodies.js';

export class Destruction {
    constructor(ctx) {
        this.ctx = ctx;
        this.seed = 1;
        this.bodies = new VoxelBodies(ctx);
    }
    carve(brush, { op = 'carve', mat = 1, hardness = true, author = null, impulse = 0, kind = 'carve' } = {}) {
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
        if(volume > 0) events.dispatchEvent(new CustomEvent('destroyed', { detail: { center, box, removed, volume, author, kind } }));
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
