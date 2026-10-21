/** Soft ground worker: classifies zone lattices (tets) and computes plastic bakes off the main thread.
 *  { op: 'classify', id, region, c0, n, bedrockY } -> { id, cells, count, cellIdx, flags, solid }
 *  { op: 'bake', id, region, zone }                 -> { id, patch }                              (src/soft/core.js) */
import { classifyZone, bakeZone } from '../soft/core.js';

self.onmessage = (e) => {
    const m = e.data;
    try {
        if(m.op === 'classify') {
            const r = classifyZone(m.region, m.c0, m.n, m.bedrockY);
            self.postMessage({ id: m.id, ...r }, [r.cells.buffer, r.cellIdx.buffer, r.flags.buffer]);
        } else if(m.op === 'bake') {
            const patch = bakeZone(m.region, m.zone);
            self.postMessage({ id: m.id, patch }, [patch.sdf.buffer, patch.mat.buffer]);
        }
    } catch(err) { self.postMessage({ id: m.id, error: String(err?.stack || err) }); }
};
