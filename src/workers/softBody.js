/** Soft debris worker: the tet lattices of detached voxel bodies (src/softbody/lattice.js), all bodies in one worker.
 *  Messages (in order; main thread: src/softbody/SoftBodies.js):
 *    { op: 'add', id, grid, tough }                 build a body's lattice (tough: toughness scale, 0 = never cracks)
 *                                                   -> { op: 'built', id, layout | null }
 *    { op: 'inherit', id, parent, off, frag }       start from the parent's motion (off: id's grid origin in the parent's
 *                                                   grid-local metres)
 *    { op: 'remove', id }
 *    { op: 'step', dt, kicks: [{ id, ...kick }] }   kicks, then fixed 60 Hz substeps over the accumulated time
 *          -> { op: 'stepped', ids, nodes, data (Float32Array RGBA per node, packed), splits: [{ id, labels, cellOf,
 *               cs, dims, at (grid-local m) }], ms }   bodies not in `ids` are asleep (u = 0); a split body stops until removed */
import { buildLattice, SoftLattice } from '../softbody/lattice.js';

const STEP = 1 / 60, ITERS = 2, BUDGET = 5; // ms per message: bodies beyond it wait for the next one
const bodies = new Map();
let acc = 0, rr = 0;

self.onmessage = (e) => {
    const m = e.data;
    try {
        if(m.op === 'add') {
            const lat = buildLattice(m.grid);
            if(lat) { const b = new SoftLattice(lat); b.tough = m.tough > 0 ? b.tough * m.tough : Infinity; bodies.set(m.id, b); } // tough 0: never cracks
            self.postMessage({ op: 'built', id: m.id, layout: lat ? { cs: lat.cs, h: lat.h, origin: lat.origin, nodes: lat.nodes } : null });
        } else if(m.op === 'inherit') {
            const b = bodies.get(m.id), p = bodies.get(m.parent);
            if(b && p) { b.inherit(p, m.off); b.frag = Math.max(1, m.frag || 1); }
        } else if(m.op === 'remove') bodies.delete(m.id);
        else if(m.op === 'step') step(m);
    } catch(err) { self.postMessage({ op: 'error', error: String(err?.stack || err) }); }
};

function step(m) {
    const t0 = performance.now();
    for(const k of m.kicks) { const b = bodies.get(k.id); if(b && !b.split) b.kick(k); }
    acc = Math.min(acc + m.dt, STEP * 3);
    let n = 0;
    while(acc >= STEP && n < 2) { acc -= STEP; n++; }
    if(!n) { self.postMessage({ op: 'stepped', same: true, splits: [] }); return; } // nothing moved (frames faster than 60 Hz)
    const splits = [];
    const list = [...bodies].filter(([, b]) => !b.asleep && !b.split);
    // round robin under the budget: a crowd of wobbling debris slows the wobble down instead of the worker
    for(let k = 0; k < list.length; k++) {
        const [id, b] = list[(k + rr) % list.length];
        if(k && performance.now() - t0 > BUDGET) { rr = (k + rr) % list.length; break; }
        for(let s = 0; s < n && !b.asleep; s++) {
            if(b.step(STEP, ITERS)) {
                const c = b.components();
                if(c.count > 1) {
                    b.split = true;
                    splits.push({ id, labels: c.labels, sizes: c.sizes, cellOf: b.cellOf, cs: b.cs, dims: b.dims, at: b.crackAt });
                    break;
                }
            }
        }
    }
    // node displacements of every awake body (asleep: u = 0, not sent)
    const ids = [], nodes = [];
    let total = 0;
    for(const [id, b] of bodies) if(!b.asleep) { ids.push(id); nodes.push(b.nn); total += b.nn; }
    const data = new Float32Array(total * 4);
    let at = 0;
    for(const id of ids) { const b = bodies.get(id); b.writeTexels(data, at); at += b.nn; }
    self.postMessage({ op: 'stepped', ids, nodes, data, splits, ms: performance.now() - t0, awake: list.length }, [data.buffer]);
}
