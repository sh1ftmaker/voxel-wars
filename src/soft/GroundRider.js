/**
 * Ground riders: things resting on soft ground ride its wobble. The soft ground only bends the terrain's drawn mesh
 * (collisions stay on the undeformed terrain), so without this a heave swallows a resting chunk and a dip leaves it
 * floating. Each frame, after physics placed every prop's mesh and the game placed the actors and the camera, this
 * samples the ground's displacement u under them and moves their drawn pose with it: a purely visual offset, never
 * fed back into physics or the network.
 *
 *   props (detached chunks, crates, ...): five support points under the drawn AABB (four inset corners and the
 *     middle, at its bottom). Each counts by how close it is to the ground (world SDF: full within 0.2 m, none past
 *     0.5 m) or, failing that, to the top of a lower rider it rests on (stacks ride along). Offset = their weighted
 *     mean u; tilt from the difference in heave across them (clamped), about the support centre.
 *   actors (bots, remote players) and the local player's camera: u at the feet while grounded.
 *
 * Sampling: the CPU solver's displacement texture is on the main thread, so its lookup runs here (SoftSimCPU.sample);
 * with GPU compute, a small gather pass reads u at the query points back asynchronously (SoftSim.gather: one or two
 * frames late, never stalling). Slots a chunk mesh already has baked in (geometry.userData.softSkip) are skipped,
 * so when a plastic bake lands the offset fades as the terrain (and the physics pose) takes over.
 * Offsets are smoothed (RATE per second) so zones starting, sleeping or being skipped never pop.
 */
import * as THREE from 'three/webgpu';
import { VOXEL, CHUNK_M } from '../config.js';
import { chunkKey } from '../voxel/VoxelWorld.js';
import { GATHER } from './SoftSim.js';

const PTS = 5;          // support points per prop
const NEAR = 0.2, FAR = 0.5; // m above the ground: full weight / none
const MAX_TILT = 0.3;   // rad
const RATE = 200;       // 1/s smoothing toward the target offset (light: the ground's own motion is smooth)
const SLOW = 6;         // 1/s ... for RELEASE s after a bake lands under it (the physics pose catches up meanwhile)
const RELEASE = 0.6;
const EPS = 1e-4;

const _box = new THREE.Box3(), _v = new THREE.Vector3(), _c = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
const _u = [0, 0, 0], _sw = new Float32Array(PTS), _su = new Float32Array(PTS);

export class GroundRider {
    constructor(soft) {
        this.soft = soft;
        this.ctx = soft.ctx;
        this.state = new Map();       // prop | actor | 'camera' -> rider state
        this.q = new Float32Array(GATHER * 4);
        this.qMap = [];               // GPU: query i -> [state, point index]
        this.stats = { riders: 0, ms: 0, msMax: 0, maxOffset: 0 };
    }

    _st(key, kind) {
        let s = this.state.get(key);
        if(!s) this.state.set(key, s = { kind, u: new Float32Array(PTS * 3), w: new Float32Array(PTS), pts: new Float32Array(PTS * 3),
            box: [0, 0, 0, 0, 0, 0], off: [0, 0, 0], ax: 0, az: 0, seen: 0, skip: 0, skipNow: 0, release: 0 });
        return s;
    }

    /** Skip mask of the terrain chunk mesh at a point (slots its mesh has baked in). */
    _skip(x, y, z) {
        const m = this.ctx.terrain.meshes.get(chunkKey(Math.floor(x / CHUNK_M), Math.floor(y / CHUNK_M), Math.floor(z / CHUNK_M)));
        return m ? m.geometry.userData.softSkip | 0 : 0;
    }

    update(dt) {
        const soft = this.soft, sim = soft.sim;
        const live = soft.zones.length > 0;
        if(!live && !this.state.size) return;
        const t0 = performance.now();
        const ctx = this.ctx, world = ctx.world, frame = (this.frame = (this.frame || 0) + 1);
        const gpu = !sim.cpu;
        let nq = 0;
        const query = (s, i, x, y, z) => {
            const skip = this._skip(x, y, z);
            s.skipNow |= skip;
            if(gpu) {
                if(nq >= GATHER) { s.w[i] = 0; return; }
                const o = nq * 4;
                this.q[o] = x; this.q[o + 1] = y; this.q[o + 2] = z; this.q[o + 3] = skip;
                this.qMap[nq++] = [s, i];
            } else {
                sim.sample(x, y, z, skip, _u);
                s.u[i * 3] = _u[0]; s.u[i * 3 + 1] = _u[1]; s.u[i * 3 + 2] = _u[2];
            }
        };

        // only what is near a live zone is sampled (the rest eases back to its physics pose)
        const zb = soft.zones.map(z => z.box);
        const nearZone = (x0, y0, z0, x1, y1, z1) => {
            for(const b of zb) if(x0 < b[1][0] + 1 && x1 > b[0][0] - 1 && y0 < b[1][1] + 1 && y1 > b[0][1] - 1 && z0 < b[1][2] + 1 && z1 > b[0][2] - 1) return true;
            return false;
        };

        // ---- props: support points under the drawn AABB
        const props = [];
        if(live) for(const p of ctx.physics?.props || []) {
            const m = p.mesh, b = p.body;
            if(!m || !m.visible || p.userData?.held || b.isKinematic?.()) continue;
            const t = m.position;
            if(!nearZone(t.x - 8, t.y - 8, t.z - 8, t.x + 8, t.y + 8, t.z + 8)) continue; // cheap cull before the box
            const vb = p.userData?.voxelBody;
            if(vb) {
                if(vb.dead) continue;
                const g = vb.grid, f = vb.frame;
                _box.min.set(-VOXEL - f[0], -VOXEL - f[1], -VOXEL - f[2]);
                _box.max.set(g.nx * VOXEL - f[0], g.ny * VOXEL - f[1], g.nz * VOXEL - f[2]);
                m.updateMatrix();
                _box.applyMatrix4(m.matrix);
            } else {
                m.updateMatrixWorld(true);
                _box.setFromObject(m);
                if(_box.isEmpty()) continue;
            }
            if(!nearZone(_box.min.x, _box.min.y, _box.min.z, _box.max.x, _box.max.y, _box.max.z)) continue;
            const s = this._st(p, 'prop');
            s.seen = frame; s.skipNow = 0;
            const bx = s.box;
            bx[0] = _box.min.x; bx[1] = _box.min.y; bx[2] = _box.min.z; bx[3] = _box.max.x; bx[4] = _box.max.y; bx[5] = _box.max.z;
            const x0 = bx[0] + (bx[3] - bx[0]) * 0.25, x1 = bx[0] + (bx[3] - bx[0]) * 0.75;
            const z0 = bx[2] + (bx[5] - bx[2]) * 0.25, z1 = bx[2] + (bx[5] - bx[2]) * 0.75, y = bx[1];
            const P = s.pts;
            P[0] = x0; P[2] = z0; P[3] = x1; P[5] = z0; P[6] = x0; P[8] = z1; P[9] = x1; P[11] = z1;
            P[12] = (x0 + x1) / 2; P[14] = (z0 + z1) / 2;
            for(let i = 0; i < PTS; i++) {
                P[i * 3 + 1] = y;
                const d = world.sample(P[i * 3], y, P[i * 3 + 2]);
                const w = Math.min(1, Math.max(0, (FAR - d) / (FAR - NEAR)));
                s.w[i] = w;
                if(w > 0) query(s, i, P[i * 3], y - 0.05, P[i * 3 + 2]);
            }
            props.push([p, s]);
        }

        // ---- actors (bots, remote players) and the local player's eye
        const actors = [];
        if(live) for(const a of ctx.game?.actors || []) {
            const f = a.alive && a.body?.feet;
            if(!f || !nearZone(f.x, f.y, f.z, f.x, f.y, f.z) || !(a.body.grounded || world.sample(f.x, f.y, f.z) < 0.25)) continue;
            const s = this._st(a, 'actor');
            s.seen = frame; s.skipNow = 0;
            s.pts[0] = f.x; s.pts[1] = f.y; s.pts[2] = f.z;
            s.w[0] = 1;
            query(s, 0, f.x, f.y - 0.05, f.z);
            actors.push([a, s]);
        }

        // ---- GPU: read the queries back (a frame or two late); the results land in the states then
        if(gpu && nq) {
            const map = this.qMap.slice(0, nq);
            const pr = sim.gather(this.q, nq);
            if(pr) pr.then((r) => { for(let i = 0; i < map.length; i++) { const [s, k] = map[i]; s.u[k * 3] = r[i * 4]; s.u[k * 3 + 1] = r[i * 4 + 1]; s.u[k * 3 + 2] = r[i * 4 + 2]; } })
                .catch(() => {});
        }

        // ---- apply, lowest props first (a stack's upper pieces take their support's offset)
        const kFast = 1 - Math.exp(-RATE * dt), kSlow = 1 - Math.exp(-SLOW * dt);
        // a slot newly skipped under a rider: a bake landed there (the terrain itself moved): ease over instead of popping
        const rate = (s) => {
            if(s.skipNow & ~s.skip) s.release = RELEASE;
            s.skip = s.skipNow;
            s.release = Math.max(0, s.release - dt);
            return s.release > 0 ? kSlow : kFast;
        };
        let maxOff = 0;
        props.sort((a, b) => a[1].box[1] - b[1].box[1]);
        const placed = [];
        for(const [p, s] of props) {
            let W = 0, ox = 0, oy = 0, oz = 0;
            let hx0 = 0, wx0 = 0, hx1 = 0, wx1 = 0, hz0 = 0, wz0 = 0, hz1 = 0, wz1 = 0;
            const sw = _sw, su = _su;
            for(let i = 0; i < PTS; i++) {
                sw[i] = 0;
                let w = s.w[i], ux = s.u[i * 3], uy = s.u[i * 3 + 1], uz = s.u[i * 3 + 2];
                if(w < 1) {
                    // resting on a lower rider: take its offset
                    const px = s.pts[i * 3], py = s.pts[i * 3 + 1], pz = s.pts[i * 3 + 2];
                    for(const o of placed) {
                        const b = o.box;
                        if(px < b[0] || px > b[3] || pz < b[2] || pz > b[5] || Math.abs(py - b[4]) > 0.35) continue;
                        const wo = 1 - w;
                        ux = ux * w + o.off[0] * wo; uy = uy * w + o.off[1] * wo; uz = uz * w + o.off[2] * wo; w = 1;
                        break;
                    }
                }
                if(!(w > 0)) continue;
                sw[i] = w; su[i] = uy;
                W += w; ox += ux * w; oy += uy * w; oz += uz * w;
                if(i === 0 || i === 2) { hx0 += uy * w; wx0 += w; } else if(i === 1 || i === 3) { hx1 += uy * w; wx1 += w; }
                if(i === 0 || i === 1) { hz0 += uy * w; wz0 += w; } else if(i === 2 || i === 3) { hz1 += uy * w; wz1 += w; }
            }
            let tx = 0, ty = 0, tz = 0, tax = 0, taz = 0;
            if(W > 0) {
                const fade = Math.min(1, W / 2); // barely touching: a share of it
                tx = ox / W; tz = oz / W;
                // the ground under it as a plane (heave at the middle + slopes across), lifted until no support point
                // is above it: a rigid piece rests on the highest ground (bridges a dip, is never swallowed by a bump)
                const b = s.box, cx = (b[0] + b[3]) / 2, cz = (b[2] + b[5]) / 2;
                const dx = (b[3] - b[0]) * 0.5, dz = (b[5] - b[2]) * 0.5;
                const sx = wx0 > 0 && wx1 > 0 && dx > 0.1 ? (hx1 / wx1 - hx0 / wx0) / dx : 0;
                const sz = wz0 > 0 && wz1 > 0 && dz > 0.1 ? (hz1 / wz1 - hz0 / wz0) / dz : 0;
                let a = oy / W, lift = -Infinity;
                for(let i = 0; i < PTS; i++) {
                    if(!(sw[i] > 0.5)) continue;
                    lift = Math.max(lift, su[i] - (a + sx * (s.pts[i * 3] - cx) + sz * (s.pts[i * 3 + 2] - cz)));
                }
                if(lift > -Infinity) a += lift;
                tx *= fade; ty = a * fade; tz *= fade;
                taz = clamp(Math.atan(sx) * fade, MAX_TILT);
                tax = clamp(-Math.atan(sz) * fade, MAX_TILT);
            }
            const k = rate(s);
            s.off[0] += (tx - s.off[0]) * k; s.off[1] += (ty - s.off[1]) * k; s.off[2] += (tz - s.off[2]) * k;
            s.ax += (tax - s.ax) * k; s.az += (taz - s.az) * k;
            placed.push(s);
            const mag = Math.abs(s.off[0]) + Math.abs(s.off[1]) + Math.abs(s.off[2]) + Math.abs(s.ax) + Math.abs(s.az);
            maxOff = Math.max(maxOff, Math.hypot(s.off[0], s.off[1], s.off[2]));
            if(mag < EPS) continue;
            const m = p.mesh, b = s.box;
            _c.set((b[0] + b[3]) / 2, b[1], (b[2] + b[5]) / 2); // tilt about the support centre
            _q.setFromEuler(_e.set(s.ax, 0, s.az));
            _v.copy(m.position).sub(_c).applyQuaternion(_q).add(_c);
            m.position.set(_v.x + s.off[0], _v.y + s.off[1], _v.z + s.off[2]);
            m.quaternion.premultiply(_q);
        }
        for(const [a, s] of actors) {
            const k = rate(s);
            s.off[0] += (s.u[0] - s.off[0]) * k; s.off[1] += (s.u[1] - s.off[1]) * k; s.off[2] += (s.u[2] - s.off[2]) * k;
            maxOff = Math.max(maxOff, Math.hypot(s.off[0], s.off[1], s.off[2]));
            this._shift(a, s.off);
        }

        // ---- riders that left the ground (or zones that ended) ease back to their physics pose
        for(const [key, s] of this.state) {
            if(s.seen === frame) continue;
            const k = kSlow * 2;
            s.off[0] -= s.off[0] * k; s.off[1] -= s.off[1] * k; s.off[2] -= s.off[2] * k; s.ax -= s.ax * k; s.az -= s.az * k;
            const mag = Math.abs(s.off[0]) + Math.abs(s.off[1]) + Math.abs(s.off[2]) + Math.abs(s.ax) + Math.abs(s.az);
            if(mag < EPS || (s.kind === 'prop' && !ctx.physics?.props.has(key)) || (s.kind === 'actor' && !key.alive)) { this.state.delete(key); continue; }
            if(s.kind === 'prop') {
                if(!key.mesh) continue;
                const m = key.mesh;
                _c.copy(m.position);
                _q.setFromEuler(_e.set(s.ax, 0, s.az));
                m.position.set(_c.x + s.off[0], _c.y + s.off[1], _c.z + s.off[2]);
                m.quaternion.premultiply(_q);
            } else this._shift(key, s.off);
        }
        this.stats.riders = props.length + actors.length;
        this.stats.maxOffset = maxOff;
        const ms = performance.now() - t0;
        this.stats.ms = this.stats.ms * 0.95 + ms * 0.05; this.stats.msMax = Math.max(this.stats.msMax * 0.999, ms);
        if(this.stats.riders) { this.stats.peakRiders = Math.max(this.stats.peakRiders || 0, this.stats.riders); }
    }

    /** An actor's drawn body (its mesh), or the camera for the local player in first person. */
    _shift(a, off) {
        if(a.isPlayer && a === this.ctx.game?.player && a.alive) this.ctx.camera.position.add(_v.set(off[0], off[1], off[2]));
        else if(a.mesh?.visible) a.mesh.position.add(_v.set(off[0], off[1], off[2]));
    }
}

const clamp = (v, m) => Math.max(-m, Math.min(m, v));
