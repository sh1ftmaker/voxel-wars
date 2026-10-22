/** The CPU PB-MPM solver (src/mpm/cpuSolver.js) off the main thread: the WebGL2 backend's granular ground
 *  (src/mpm/MpmCPU.js). Messages: zone, spawn, remove, knobs, proxies, step { dt, buf } (answers frame { buf (world
 *  xyz + packed word per particle), n, stats, ms }), read { slot }. */
import { MpmSolverCPU } from '../mpm/cpuSolver.js';
import { H, MAX_ZONES } from '../mpm/params.js';

let s = null;
onmessage = (e) => {
    const m = e.data;
    try {
        switch(m.op) {
            case 'init': s = new MpmSolverCPU({ cap: m.cap }); Object.assign(s.knobs, m.knobs || {}); break;
            case 'zone': s.setZone(m.slot, m.zone); break;
            case 'spawn': postMessage({ op: 'spawned', slot: m.slot, n: s.spawn(m.slot, m.pos, m.vel, m.mats, m.ppcLog, m.dt) }); break;
            case 'remove': s.removeZone(m.slot); break;
            case 'knobs': Object.assign(s.knobs, m.knobs); break;
            case 'proxies': s.proxies = m.list; break;
            case 'step': {
                const t0 = performance.now();
                if(s.n) s.step(m.dt);
                const ms = performance.now() - t0;
                const buf = m.buf && m.buf.length >= s.n * 4 ? m.buf : new Float32Array(Math.max(s.cap, 1) * 4);
                for(let p = 0; p < s.n; p++) {
                    const z = s.zones[s.w[p] >> 7];
                    for(let a = 0; a < 3; a++) buf[p * 4 + a] = z ? (z.lo[a] + s.x[p * 3 + a]) * H : 0;
                    buf[p * 4 + 3] = s.w[p];
                }
                const stats = [];
                for(let z = 0; z < MAX_ZONES; z++) { const st = s.zones[z] ? s.zoneStats(z) : { count: 0, moving: 0 }; stats.push(st.count, st.moving); }
                postMessage({ op: 'frame', buf, n: s.n, stats, ms }, [buf.buffer]);
                break;
            }
            case 'read': { const r = s.read(m.slot); postMessage({ op: 'read', id: m.id, pos: r.pos, w: r.w }, [r.pos.buffer, r.w.buffer]); break; }
        }
    } catch(err) { postMessage({ op: 'error', error: String(err?.stack || err), id: m.id }); }
};
