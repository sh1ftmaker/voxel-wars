/** Soft ground CPU solver worker (src/soft/cpuSolver.js), used when there is no WebGPU compute (src/soft/SoftSimCPU.js).
 *  { op: 'init', opts }                                  create the solver ({ iterations, rate })
 *  { op: 'upload', slot, z, init }                       a zone's lattice
 *  { op: 'step', P, substeps, dt, kicks, init, buf }     parameters, then a frame of solver work -> { op: 'frame', buf, ms, work }
 *                                                        (buf: the deformation texture's data, filled and sent back)
 *  { op: 'read', id, slot, nodes }                       -> { op: 'read', id, u } (4 floats per node)             */
import { CpuSoft } from '../soft/cpuSolver.js';
import { MAX_ZONES } from '../soft/core.js';

let sim = null;
self.onmessage = (e) => {
    const m = e.data;
    try {
        if(m.op === 'init') { sim = new CpuSoft(m.opts); sim.warmup(); return; }
        if(m.op === 'upload') { sim.upload(m.slot, m.z, m.init); return; }
        if(m.op === 'step') {
            const t0 = performance.now();
            sim.P.set(m.P);
            for(let s = 0; s < MAX_ZONES; s++) if(m.init & (1 << s)) sim.reset(s);
            const work = m.substeps || m.kicks ? sim.step(m.substeps, m.dt, m.kicks) : 0;
            if(m.buf) sim.write(m.buf);
            self.postMessage({ op: 'frame', buf: m.buf, ms: performance.now() - t0, work }, m.buf ? [m.buf.buffer] : []);
            return;
        }
        if(m.op === 'read') { const u = sim.read(m.slot, m.nodes); self.postMessage({ op: 'read', id: m.id, u }, [u.buffer]); }
    } catch(err) { self.postMessage({ op: 'error', id: m.id, error: String(err?.stack || err) }); }
};
