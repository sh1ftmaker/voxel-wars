/**
 * The one entry point for changing matter. Gameplay calls these; they edit the VoxelWorld (and detached voxel bodies),
 * push physics bodies around, detect what lost its support, and announce what was destroyed.
 *
 * API (gameplay depends on these signatures):
 *   destruction.carve(brush, { op = 'carve', mat, hardness = true, author, impulse })
 *       brush from src/voxel/brushes.js. Returns { removed: Float64Array m³ per material, volume, added, center, box }.
 *       `impulse` (number) also kicks dynamic bodies near the brush outward.
 *   destruction.blast(center, radius, { strength, author, seed })    rock-shaped crater + impulse; returns carve's result
 *   destruction.rip(center, radius, { author }) -> Prop | null        tear a lump of terrain out as a dynamic body
 *                                                                     (Donkey Kong style: grab it, throw it)
 *
 * Events on ctx.events (CustomEvent, data in e.detail):
 *   'destroyed' { center: [x,y,z], box: [min, max] (metres), removed: Float64Array, volume, author, kind: 'carve'|'blast'|'impact' }
 *   'detached'  { prop, volume, mat }      a piece of terrain broke loose and is now a body
 */
import { VOXEL } from '../config.js';
import { rock } from '../voxel/brushes.js';

export class Destruction {
    constructor(ctx) {
        this.ctx = ctx;
        this.seed = 1;
    }
    carve(brush, { op = 'carve', mat = 1, hardness = true, author = null, impulse = 0, kind = 'carve' } = {}) {
        const { world, physics, events } = this.ctx;
        const r = world.applyBrush(brush, { op, mat, hardness });
        const center = brush.min.map((v, i) => (v + brush.max[i]) / 2);
        let volume = 0;
        for(let i = 0; i < 256; i++) volume += r.removed[i];
        if(impulse) physics.explode(center, Math.max(...brush.max.map((v, i) => v - brush.min[i])) * 0.9, impulse);
        const box = [r.box[0].map(v => v * VOXEL), r.box[1].map(v => v * VOXEL)];
        const result = { removed: r.removed, volume, added: r.added, center, box, changed: r.changed };
        if(volume > 0) events.dispatchEvent(new CustomEvent('destroyed', { detail: { center, box, removed: r.removed, volume, author, kind } }));
        return result;
    }
    blast(center, radius, { strength = 14, author = null, seed } = {}) {
        return this.carve(rock(center, radius, seed ?? this.seed++), { author, impulse: strength, kind: 'blast' });
    }
    rip(center, radius, { author = null } = {}) { return null; }
}
