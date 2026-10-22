/**
 * Fluid worker: the CPU fluid solver (src/fluid/cpuSolver.js) for the WebGL2 backend, driven by src/fluid/FluidCPU.js.
 *
 *   in:  { op: 'init', settings, table, data }            the SDF pages (src/fluid/sdfPages.js)
 *        { op: 'page', ci, entry, bytes }                  one chunk's table entry and page (bytes: Int8Array or null)
 *        { op: 'write', start, n, data }                   particles (8 floats each: x y z phase vx vy vz -)
 *        { op: 'step', steps, dt, proxies, nProxies, kicks, pos, info }   pos / info: buffers to fill (transferred)
 *   out: { op: 'frame', pos, info, n, stats, ms }          pos: x y z phase per particle, info: speed, density
 */
import { FluidSolver } from '../fluid/cpuSolver.js';
import { PageSDF, PAGE } from '../fluid/sdfPages.js';

let solver = null, sdf = null;

self.onmessage = (e) => {
    const m = e.data;
    try {
        if(m.op === 'init') {
            sdf = new PageSDF(0);
            sdf.capacity = m.data.length / PAGE;
            sdf.table = m.table; sdf.data = m.data;
            solver = new FluidSolver({ ...m.settings, sdf });
        } else if(m.op === 'page') {
            sdf.table[m.ci] = m.entry;
            if(m.bytes && m.entry >= 0) sdf.data.set(m.bytes, m.entry * PAGE);
        } else if(m.op === 'write') {
            const d = m.data;
            for(let i = 0; i < m.n; i++) { const s = i * 8; solver.write(m.start + i, d[s], d[s + 1], d[s + 2], d[s + 3], d[s + 4], d[s + 5], d[s + 6]); }
        } else if(m.op === 'step') {
            const t0 = performance.now();
            solver.proxies.fill(0);
            solver.proxies.set(m.proxies.subarray(0, m.nProxies * 12));
            solver.kicks.set(m.kicks);
            for(let s = 0; s < m.steps; s++) {
                solver.step(m.dt);
                solver.kicks.fill(0); // kicks act once
            }
            const n = solver.extent, pos = m.pos, info = m.info, P = solver.pos, V = solver.vel, D = solver.dens;
            pos.set(P.subarray(0, n * 4));
            for(let i = 0; i < n; i++) { const o = i * 4; info[i * 2] = Math.hypot(V[o], V[o + 1], V[o + 2]); info[i * 2 + 1] = D[i]; }
            const st = solver.stats;
            self.postMessage({ op: 'frame', pos, info, n, ms: performance.now() - t0,
                stats: { alive: st.alive, moving: st.moving, maxSpeed: st.maxSpeed, occ: st.occ.slice() } }, [pos.buffer, info.buffer]);
        }
    } catch(err) { self.postMessage({ op: 'error', error: String(err?.stack || err) }); }
};
