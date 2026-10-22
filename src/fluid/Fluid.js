/**
 * SPH fluid (Position Based Fluids) as a game system: water in the water towers' tanks, lava over the lava basins, and
 * blobs spawned by hand. The fluid follows the voxel world's SDF, so breaching a tank lets the water out and it runs
 * down the terrain. See docs/SPH.md for the design, caps and budgets.
 *
 * Backends: WebGPU runs the solver in compute shaders (src/fluid/FluidGPU.js: 32k particles of 0.2 m); WebGL2 or
 * `?fluidCpu=1` runs it in a worker (src/fluid/FluidCPU.js, src/workers/fluid.js: 4k particles of 0.3 m). Either way
 * the particles are drawn by src/fluid/FluidRender.js in one draw call.
 *
 * Cosmetic and local: nothing is sent over the network. Everything that moves the fluid already reaches every client:
 * terrain edits (the world replica's change listeners: the SDF pages follow, and the fluid wakes), blasts (edit hooks
 * with an impulse: a velocity kick), bodies and actors (pushed out of the fluid as proxies every step).
 *
 * Sleep: when (almost) nothing moves for a second the solver stops (the particles stay drawn); an edit, a kick, a
 * spawn or a moving body or actor in a chunk the fluid occupies wakes it. Stats come back asynchronously every few
 * frames (alive, moving, max speed, occupied chunks), never the particles.
 *
 *   ctx.fluid.spawnBlob(center, { n = 7, kind = 'water', vel })   a cube of n³ particles
 *   ctx.fluid.wake()
 *   ?fluid=0 off, ?fluidCpu=1 CPU solver on WebGPU too, ?fluidIters=, ?fluidSub= solver iterations / substeps,
 *   H (dev key): a water blob at the crosshair. ctx.fluid.label, ctx.fluid.stats.
 */
import * as THREE from 'three/webgpu';
import { VOXEL, CHUNK_M, WORLD_CHUNKS } from '../config.js';
import { GPU_SETTINGS, CPU_SETTINGS, STEP, WATER, LAVA, MAX_PROXIES, MAX_KICKS } from './params.js';
import { PageSDF, N_CHUNKS, NCX, NCY, NCZ, chunkIndex, uniformSdf } from './sdfPages.js';
import { packProxy, packKick, occIndex } from './cpuSolver.js';
import { FluidGPU } from './FluidGPU.js';
import { FluidCPU } from './FluidCPU.js';
import { FluidRender } from './FluidRender.js';
import { FluidSurface } from './FluidSurface.js';
import { FLUID_SOURCES } from '../level/showcase.js';

const STATS_EVERY = 6;   // frames between stats reads
const CALM_TIME = 1.0;   // s with (almost) nothing moving before the solver sleeps
const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _b = new THREE.Box3();

export class Fluid {
    constructor(ctx) {
        this.ctx = ctx;
        ctx.fluid = this;
        this.enabled = false;
        this.label = 'off';
        const params = ctx.params;
        if(params.get('fluid') === '0') { this.label = 'off (?fluid=0)'; return; }
        const t0 = performance.now();
        const gpu = ctx.renderer.backend?.isWebGPUBackend && params.get('fluidCpu') !== '1';
        const base = gpu ? GPU_SETTINGS : CPU_SETTINGS;
        this.settings = { ...base, iterations: +(params.get('fluidIters') || base.iterations), substeps: +(params.get('fluidSub') || base.substeps) };
        const world = ctx.world;
        let dense = 0;
        for(const c of world.chunks.values()) if(c.sdf && !uniformSdf(c.sdf)) dense++;
        this.pages = new PageSDF(Math.min(N_CHUNKS, dense + 160)).fromWorld(world);
        try {
            const opts = { ...this.settings, pages: this.pages };
            this.sim = gpu ? new FluidGPU(ctx.renderer, opts) : new FluidCPU(ctx.renderer, opts);
            this.sim.warmup();
            // a screen-space surface (default) or the particles as shaded spheres (?fluidRender=sprites)
            this.render = params.get('fluidRender') === 'sprites' ? new FluidRender(ctx.scene, this.sim.renderNodes(), { spacing: this.settings.spacing, count: 0 })
                : new FluidSurface(ctx, this.sim.renderNodes(), { spacing: this.settings.spacing });
        } catch(e) { this.label = 'off (error)'; console.error('fluid: disabled', e); return; }
        this.enabled = true;
        this.label = `${gpu ? 'GPU' : 'CPU worker'}`;
        this.cap = this.settings.cap;
        this.persistent = 0;      // slots [0, persistent) hold the level's fluid; the rest is a ring for spawns
        this.ring = 0;
        this.occ = new Uint32Array(Math.ceil(N_CHUNKS / 32));
        this.awake = true; this.calm = 0; this.frame = 0; this.acc = 0;
        this.statsPending = false;
        this.proxies = new Float32Array(MAX_PROXIES * 12); this.nProxies = 0;
        this.kicks = new Float32Array(MAX_KICKS * 8); this.kickList = [];
        this.stats = { alive: 0, moving: 0, maxSpeed: 0, steps: 0, sleeping: false, dispatches: 0 };
        this._buf = new Float32Array(this.cap * 8); this._S = [0, 0, 0, 0];

        this.sources = FLUID_SOURCES.map(src => ({ ...src, count: this.fillSource(src) }));
        this.persistent = this.ring = this.sim.extent;
        console.log(`fluid: ${this.label}, ${this.sim.extent} particles of ${this.settings.spacing} m (${this.sources.map(s => `${s.kind} ${s.count}`).join(', ')}; cap ${this.cap}), ${this.pages.capacity - this.pages.free.length} of ${this.pages.capacity} SDF pages, ${(performance.now() - t0).toFixed(0)} ms`);

        world.onChange((r) => this._onWorldChange(r));
        ctx.destruction?.editHooks?.push((e) => this._onEdit(e));
        addEventListener('keydown', (e) => {
            if(e.code !== 'KeyH' || e.repeat) return;
            const cam = ctx.camera, d = cam.getWorldDirection(_v).toArray();
            const hit = world.raycast(cam.position.toArray(), d, 80);
            const p = hit ? hit.point : cam.position.clone().addScaledVector(_v, 8).toArray();
            this.spawnBlob([p[0] - d[0] * 1.5, p[1] + 2.5, p[2] - d[2] * 1.5]);
        });
    }

    // ------------------------------------------------------------------ particles

    /** Allocate n slots from the spawn ring (overwriting the oldest spawns). */
    _alloc(n) {
        n = Math.min(n, this.cap - this.persistent);
        if(n <= 0) return -1;
        if(this.ring + n > this.cap) this.ring = this.persistent;
        const s = this.ring;
        this.ring += n;
        return s;
    }
    _put(start, list) {
        const n = list.length / 8;
        if(!n) return;
        this.sim.write(start, n, list);
        for(let i = 0; i < n; i++) {
            const o = i * 8;
            if(list[o + 3] === 0) continue;
            const ci = occIndex(list[o], list[o + 1], list[o + 2]);
            this.occ[ci >> 5] |= 1 << (ci & 31);
        }
        this.wake();
    }
    /** Fill a level source (FLUID_SOURCES in src/level/showcase.js) on a lattice of the particle spacing: a volume up to
     *  `fill` of its height, or `layers` layers resting on whatever floor the voxelized SDF has in each column. */
    fillSource(src) {
        const d = this.settings.spacing, m = d * 0.6, out = [], r = d * 0.5, S = [0, 0, 0, 0];
        const phase = src.kind === 'lava' ? LAVA : WATER;
        const R = src.r - m;
        for(let x = -R; x <= R; x += d) for(let z = -R; z <= R; z += d) {
            if(x * x + z * z > R * R) continue;
            const px = src.x + x, pz = src.z + z;
            let y = src.y0 + m, top;
            if(src.layers) {
                // the floor where the particle rests (the voxelized basin is shallower than its CSG)
                while(y < src.y1 + d && this.pages.sample(px, y, pz, S) < r * 1.02) y += 0.01;
                top = y + (src.layers - 1) * d + 1e-3;
            } else top = src.y0 + (src.y1 - src.y0) * src.fill;
            for(; y <= top; y += d) {
                // not in a crease: the trilinear SDF underestimates the distance there and the collision would shoot it out
                if(this.pages.sample(px, y, pz, S) < r) continue;
                if(this.persistent + out.length / 8 >= this.cap) break;
                out.push(px, y, pz, phase, 0, 0, 0, 0);
            }
        }
        const start = this.sim.extent;
        this._put(start, Float32Array.from(out));
        this.persistent = start + out.length / 8;
        return out.length / 8;
    }
    /** A cube of n³ particles centred at `center` (m). Returns the number spawned. */
    spawnBlob(center, { n = 7, kind = 'water', vel = [0, 0, 0] } = {}) {
        if(!this.enabled) return 0;
        const d = this.settings.spacing, phase = kind === 'lava' ? LAVA : WATER;
        const count = Math.min(n * n * n, this.cap - this.persistent);
        const start = this._alloc(count);
        if(start < 0) return 0;
        const buf = this._buf;
        let k = 0;
        for(let z = 0; z < n; z++) for(let y = 0; y < n; y++) for(let x = 0; x < n; x++) {
            if(k >= count) break;
            const o = k * 8;
            buf[o] = center[0] + (x - (n - 1) / 2) * d; buf[o + 1] = center[1] + (y - (n - 1) / 2) * d; buf[o + 2] = center[2] + (z - (n - 1) / 2) * d;
            if(this.pages.sample(buf[o], buf[o + 1], buf[o + 2], this._S) < d * 0.5) continue; // inside the terrain
            buf[o + 3] = phase; buf[o + 4] = vel[0]; buf[o + 5] = vel[1]; buf[o + 6] = vel[2]; buf[o + 7] = 0;
            k++;
        }
        const spawned = k;
        for(; k < count; k++) buf.fill(0, k * 8, k * 8 + 8); // slots left over (inside the terrain): dead
        this._put(start, buf.subarray(0, count * 8));
        return spawned;
    }
    wake() { this.awake = true; this.calm = 0; this.stats.sleeping = false; }

    // ------------------------------------------------------------------ the world

    /** Is any chunk the fluid occupies within the box (m, [min, max]) grown by `margin` m? */
    occupied(min, max, margin = 1) {
        const c0 = [], c1 = [];
        for(let a = 0; a < 3; a++) {
            c0[a] = Math.max(0, Math.floor((min[a] - margin) / CHUNK_M) - WORLD_CHUNKS.min[a]);
            c1[a] = Math.min([NCX, NCY, NCZ][a] - 1, Math.floor((max[a] + margin) / CHUNK_M) - WORLD_CHUNKS.min[a]);
        }
        for(let z = c0[2]; z <= c1[2]; z++) for(let y = c0[1]; y <= c1[1]; y++) for(let x = c0[0]; x <= c1[0]; x++) {
            const ci = x + y * NCX + z * NCX * NCY;
            if(this.occ[ci >> 5] & (1 << (ci & 31))) return true;
        }
        return false;
    }
    _onWorldChange(r) {
        const world = this.ctx.world;
        for(const key of r.dirty || []) {
            const c = world.chunks.get(key);
            if(!c) continue;
            const page = this.pages.setChunk(c.cx, c.cy, c.cz, c.sdf, c.fill);
            this.sim.updatePage(chunkIndex(c.cx, c.cy, c.cz), page);
        }
        if(r.box && this.occupied(r.box[0].map(v => v * VOXEL), r.box[1].map(v => v * VOXEL), 1.5)) this.wake();
    }
    _onEdit({ op, center, size, impulse, kind }) {
        if(!impulse || op !== 'carve') return;
        const radius = size * 2.2 + 1.5;
        if(!this.occupied([center[0] - radius, center[1] - radius, center[2] - radius], [center[0] + radius, center[1] + radius, center[2] + radius], 0)) return;
        this.kickList.push({ center: [...center], radius, speed: Math.min(kind === 'blast' ? 12 : 7, 2 + impulse * 0.6) });
        this.wake();
    }

    // ------------------------------------------------------------------ interaction

    _gatherProxies() {
        const ctx = this.ctx, P = this.proxies;
        let n = 0, moving = false;
        const add = (p) => { if(n < MAX_PROXIES) packProxy(P, n++, p); };
        for(const a of ctx.game?.actors || []) {
            const b = a.body;
            if(!a.alive || !b?.center) continue;
            const c = b.center, hh = b.halfHeight ?? 0.5, r = b.radius ?? 0.4;
            if(!this.occupied([c.x - 1, c.y - 2, c.z - 1], [c.x + 1, c.y + 2, c.z + 1], 0)) continue;
            add({ type: 'capsule', a: [c.x, c.y - hh, c.z], b: [c.x, c.y + hh, c.z], r });
            if(b.vel && b.vel.lengthSq() > 0.09) moving = true;
        }
        for(const p of ctx.physics.props) {
            if(n >= MAX_PROXIES) break;
            const mesh = p.mesh, body = p.body;
            if(!mesh || !body?.isDynamic?.()) continue;
            const t = body.translation();
            if(!this.occupied([t.x - 2, t.y - 2, t.z - 2], [t.x + 2, t.y + 2, t.z + 2], 0)) continue;
            const box = localBox(mesh);
            if(!box) continue;
            mesh.updateWorldMatrix(false, false);
            mesh.matrixWorld.decompose(_v, _q, _s);
            const c = box.getCenter(new THREE.Vector3()).applyMatrix4(mesh.matrixWorld);
            const h = box.getSize(new THREE.Vector3()).multiply(_s).multiplyScalar(0.5);
            add({ type: 'box', c: c.toArray(), half: h.toArray(), q: [_q.x, _q.y, _q.z, _q.w] });
            if(!body.isSleeping()) moving = true;
        }
        this.nProxies = n;
        return moving;
    }

    // ------------------------------------------------------------------ frame

    update(dt) {
        if(!this.enabled) return;
        const sim = this.sim;
        this.frame++;
        if(this._gatherProxies()) this.wake();
        this.acc = Math.min(this.acc + dt, STEP * 3);
        let steps = Math.floor(this.acc / STEP + 1e-6);
        this.acc -= steps * STEP;
        if(this.awake && steps > 0) {
            this.kicks.fill(0);
            this.kickList.slice(-MAX_KICKS).forEach((k, i) => packKick(this.kicks, i, k));
            this.kickList.length = 0;
            sim.setInteraction(this.proxies, this.nProxies, this.kicks);
            const wantStats = !this.statsPending && this.frame % STATS_EVERY === 0;
            this.stats.dispatches = sim.step(steps, STEP, { stats: wantStats });
            this.stats.steps += steps;
            if(wantStats) this._readStats();
        }
        this.render.count = sim.extent;
        this.render.sunDir.value.copy(this.ctx.env?.sunDir ?? this.render.sunDir.value);
        this.render.render?.(this._inView());
    }
    /** Is a chunk the fluid occupies in the camera's frustum? */
    _inView() {
        const cam = this.ctx.camera;
        cam.updateMatrixWorld();
        _frustum.setFromProjectionMatrix(_m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
        const occ = this.occ;
        for(let w = 0; w < occ.length; w++) {
            if(!occ[w]) continue;
            for(let b = 0; b < 32; b++) {
                if(!(occ[w] & (1 << b))) continue;
                const ci = w * 32 + b, cx = ci % NCX, cy = Math.floor(ci / NCX) % NCY, cz = Math.floor(ci / (NCX * NCY));
                const x = (cx + WORLD_CHUNKS.min[0]) * CHUNK_M, y = (cy + WORLD_CHUNKS.min[1]) * CHUNK_M, z = (cz + WORLD_CHUNKS.min[2]) * CHUNK_M;
                // grown by a metre: a particle sits in the chunk of its centre
                _box.min.set(x - 1, y - 1, z - 1); _box.max.set(x + CHUNK_M + 1, y + CHUNK_M + 1, z + CHUNK_M + 1);
                if(_frustum.intersectsBox(_box)) return true;
            }
        }
        return false;
    }
    _readStats() {
        const p = this.sim.readStats();
        if(!p) return;
        this.statsPending = true;
        const t = performance.now();
        p.then((s) => {
            this.statsPending = false;
            const st = this.stats;
            st.alive = s[0]; st.moving = s[1]; st.maxSpeed = new Float32Array(s.buffer, 8, 1)[0];
            this.occ.set(s.subarray(3, 3 + this.occ.length));
            const elapsed = Math.max(STEP, (t - (this._lastStatsT ?? t)) / 1000);
            this._lastStatsT = t;
            if(st.moving <= Math.max(2, st.alive * 0.004)) this.calm += elapsed; else this.calm = 0;
            if(this.calm > CALM_TIME && !this.kickList.length) { this.awake = false; st.sleeping = true; }
        }, (e) => { this.statsPending = false; console.warn('fluid stats', e); });
    }
}

const _frustum = new THREE.Frustum(), _m = new THREE.Matrix4(), _box = new THREE.Box3();
/** A mesh's (or group's) bounding box in its own frame, cached per set of geometries. */
function localBox(obj) {
    const geos = [];
    obj.traverse((o) => { if(o.geometry) geos.push(o); });
    if(!geos.length) return null;
    const key = geos.map(o => o.geometry.id).join(',');
    if(obj.userData._fluidBoxKey === key) return obj.userData._fluidBox;
    const box = new THREE.Box3();
    obj.updateWorldMatrix(false, true);
    const inv = new THREE.Matrix4().copy(obj.matrixWorld).invert();
    for(const o of geos) {
        if(!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        _b.copy(o.geometry.boundingBox).applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
        box.union(_b);
    }
    obj.userData._fluidBoxKey = key; obj.userData._fluidBox = box;
    return box;
}
