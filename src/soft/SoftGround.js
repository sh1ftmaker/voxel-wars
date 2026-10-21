/**
 * Soft ground ("wake zones"): impacts wake a local box of terrain into a tetrahedral lattice simulated on the GPU
 * (src/soft/SoftSim.js); the terrain chunk meshes are deformed in the vertex shader by the zone's node displacements
 * (no remeshing while it wobbles). When a zone has been calm for its lifetime it sleeps: elastic matter has sprung
 * back; plastic matter (dirt, grass, sand, snow) keeps its deformation, which is read back once and baked into the
 * SDF (src/soft/core.js bakeZone, in the softZone worker), so mounds and dents stay and remain diggable.
 *
 * Wakes: Destruction edits with an impulse (blasts, punches: destruction.editHooks), the player's hard landings
 * ('land'), voxel bodies hitting the ground ('impact'). `ctx.soft.wake(point, { speed, radius, dir, up })` for others.
 *
 * Zone lifecycle: building (worker classifies the lattice) -> sim -> [frozen: read back + bake in the worker ->
 * remesh: wait until every chunk mesh in the box has been rebuilt from the baked SDF; those new meshes skip the
 * zone's displacement] -> free. WebGL2 (no compute / no storage buffers in vertex shaders) and `?soft=0`: disabled.
 *
 * Tuning (ctx.soft): subDt, maxSubsteps, life, settle.
 */
import { VOXEL, BEDROCK_SAMPLES } from '../config.js';
import { MATERIALS } from '../voxel/materials.js';
import { enableTerrainDeform } from '../render/terrainMaterial.js';
import { H, SPC, MAX_ZONES, NODE_CAP, CELL_CAP, MAX_DIM } from './core.js';
import { SoftSim, MAX_KICKS } from './SoftSim.js';
import { readRegion, chunkVersions, applyPatch } from './region.js';

const BAKE_MIN = 0.012; // m: smaller final displacements are dropped instead of baked

export class SoftGround {
    constructor(ctx) {
        this.ctx = ctx;
        this.enabled = false;
        this.zones = [];                  // live zones
        this.slots = new Array(MAX_ZONES).fill(null);
        this.kicks = [];
        this.deferred = [];
        this.subDt = 1 / 240;
        this.maxSubsteps = 4;
        this.acc = 0;
        this.settle = 0.35;               // s of extra damping before a zone sleeps
        this.stats = { zones: 0, built: 0, baked: 0, dispatches: 0, buildMs: 0, cpuMs: 0, cpuMax: 0, lastBake: null };
        ctx.soft = this;
        const backend = ctx.renderer.backend;
        if(ctx.params.get('soft') === '0') { console.log('soft ground: off (?soft=0)'); return; }
        if(!backend?.isWebGPUBackend) { console.log('soft ground: off (needs WebGPU compute)'); return; }
        try {
            this.sim = new SoftSim(ctx.renderer, { iterations: +(ctx.params.get('softIters') || 4) });
            enableTerrainDeform(ctx.terrain.material, (skip) => this.sim.deformNode(skip));
            this.sim.warmup();
        } catch(e) { console.error('soft ground: disabled', e); return; }
        this.enabled = true;
        this.bedrockY = ctx.world.smin[1] + BEDROCK_SAMPLES;
        readRegion(ctx.world, [0, 0, 0], [40, 24, 40]); // warm the JIT: the first wake should not hitch
        this.worker = new Worker(new URL('./softZone.js', import.meta.url), { type: 'module' });
        this.jobs = new Map(); this.jobId = 1;
        this.worker.onmessage = (e) => { const j = this.jobs.get(e.data.id); this.jobs.delete(e.data.id); if(e.data.error) console.error('softZone', e.data.error); j?.(e.data); };
        // wakes
        ctx.destruction.editHooks?.push((e) => this._onEdit(e));
        ctx.events.addEventListener('land', (e) => {
            const a = e.detail.actor, sp = e.detail.speed;
            if(!a?.body) return;
            const f = a.body.feet;
            this.wake([f.x, f.y - 0.1, f.z], { speed: Math.min(9, (sp - 10) * 0.45), radius: 1.6 + sp * 0.03, dir: [0, -1, 0] });
        });
        ctx.events.addEventListener('impact', (e) => {
            const { point, speed, prop } = e.detail;
            if(!point || speed < 4) return;
            if(ctx.world.sample(point[0], point[1], point[2]) > 0.6) return; // body against body, in the air
            const m = prop?.userData?.mass ?? 200;
            this.wake(point, { speed: Math.min(6, speed * 0.25 * Math.min(2, Math.cbrt(m / 200))), radius: 1.2 + Math.min(1.5, Math.cbrt(m) * 0.08) });
        });
        ctx.terrain.onChunkMesh((key, g) => this._onChunkMesh(key, g));
        // before the renderer's listener (which requests the remeshes): which chunks are being meshed right now
        ctx.world.onChange((r) => this._onWorldChange(r));
        ctx.world.listeners.unshift(ctx.world.listeners.pop());
    }

    // ------------------------------------------------------------------ wakes

    _onEdit({ op, center, size, impulse, kind, box }) {
        // a carve or build inside a zone: rebuild that zone's lattice from the new SDF (keeps its motion)
        for(const z of this.zones) if(overlaps(z.box, box)) {
            if(z.state === 'sim' || z.state === 'building') z.refreshAt = 3; // a few frames: the edit may land late
        }
        if(op !== 'carve' || !impulse) return;
        if(kind === 'blast') this.wake(center, { speed: Math.min(16, 4 + impulse * 0.6), radius: size * 1.9 + 0.8, up: 0.45 });
        else this.wake(center, { speed: Math.min(8, 2 + impulse * 0.6), radius: size * 2.2 + 0.6, up: 0.1 });
    }

    /** Wake the ground around `point` (m): nodes within `radius` get up to `speed` m/s along `dir` (or radially
     *  from the point, tilted up by `up`), scaled by each material's softness. */
    wake(point, { speed = 4, radius = 2, dir = null, up = 0 } = {}) {
        if(!this.enabled || !(speed > 0.2)) return;
        const kick = { p: [...point], speed, radius, dir, up };
        const inZone = this.zones.find(z => inside(z.box, point, 0.25));
        if(inZone) {
            if(inZone.state === 'sim') { this._kick(inZone, kick); return; }
            if(inZone.state === 'building') { inZone.pendingKicks.push(kick); inZone.life = Math.max(inZone.life, inZone.maxLife); return; }
            this.deferred.push({ point, opts: { speed, radius, dir, up }, t: 0 }); // baking: try again shortly
            return;
        }
        // the zone box: cells of H, biased downward (the ground under an impact matters more than the air above)
        const hor = Math.min(5.5, radius * 1.15 + 1.0), below = Math.min(3.5, radius * 0.9 + 0.8), above = Math.min(2.2, radius * 0.5 + 0.5);
        let lo = [Math.floor((point[0] - hor) / H), Math.floor((point[1] - below) / H), Math.floor((point[2] - hor) / H)];
        let hi = [Math.ceil((point[0] + hor) / H), Math.ceil((point[1] + above) / H), Math.ceil((point[2] + hor) / H)];
        for(let a = 0; a < 3; a++) {
            const pc = Math.floor(point[a] / H);
            while(hi[a] - lo[a] > MAX_DIM[a]) { if(hi[a] - pc > pc - lo[a]) hi[a]--; else lo[a]++; }
        }
        // stay clear of other zones (their displacements would add up): cut the box on the axis that keeps most
        const pc = point.map(v => Math.floor(v / H));
        for(const z of this.zones) {
            const zl = z.c0, zh = z.c0.map((v, i) => v + z.n[i]);
            if(!(lo[0] < zh[0] && hi[0] > zl[0] && lo[1] < zh[1] && hi[1] > zl[1] && lo[2] < zh[2] && hi[2] > zl[2])) continue;
            let best = null, bestVol = 0;
            for(let a = 0; a < 3; a++) {
                const tries = [];
                if(pc[a] >= zh[a]) tries.push([a, 'lo', zh[a]]);
                if(pc[a] < zl[a]) tries.push([a, 'hi', zl[a]]);
                for(const t of tries) {
                    const l2 = [...lo], h2 = [...hi];
                    if(t[1] === 'lo') l2[a] = Math.max(l2[a], t[2]); else h2[a] = Math.min(h2[a], t[2]);
                    const vol = (h2[0] - l2[0]) * (h2[1] - l2[1]) * (h2[2] - l2[2]);
                    if(vol > bestVol) { bestVol = vol; best = [l2, h2]; }
                }
            }
            if(!best) { lo = hi = null; break; }
            [lo, hi] = best;
        }
        if(!lo || hi[0] - lo[0] < 3 || hi[1] - lo[1] < 3 || hi[2] - lo[2] < 3) {
            // squeezed between zones: shake the nearest live one instead
            const near = this.zones.filter(z => z.state === 'sim').sort((a, b) => dist2(a.center, point) - dist2(b.center, point))[0];
            if(near && dist2(near.center, point) < 64) this._kick(near, kick);
            return;
        }
        const slot = this.slots.indexOf(null);
        if(slot < 0) {
            const near = this.zones.filter(z => z.state === 'sim').sort((a, b) => dist2(a.center, point) - dist2(b.center, point))[0];
            if(near && dist2(near.center, point) < 100) this._kick(near, kick);
            // and hurry the oldest zone to sleep so a slot frees up
            const old = this.zones.filter(z => z.state === 'sim').sort((a, b) => a.born - b.born)[0];
            if(old) old.life = Math.min(old.life, this.settle);
            return;
        }
        const n = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
        const z = {
            slot, c0: lo, n, state: 'building', born: performance.now(),
            box: [lo.map(v => v * H), hi.map(v => v * H)], center: [...point],
            maxLife: Math.min(1.6, 0.8 + speed * 0.07), life: 0, pendingKicks: [kick], plastic: false, refreshAt: -1,
        };
        z.life = z.maxLife;
        this.slots[slot] = z;
        this.zones.push(z);
        this._classify(z, true);
    }

    _kick(z, k) {
        z.life = Math.max(z.life, z.maxLife);
        this.kicks.push(fitKick(k, z.box, z.slot));
    }

    /** Read the zone's samples (main thread: a chunk-wise copy) and classify its lattice in the worker. */
    _classify(z, first) {
        const t0 = performance.now();
        const lo = z.c0.map(v => (v - 1) * SPC), hi = z.c0.map((v, i) => (v + z.n[i] + 1) * SPC);
        const region = readRegion(this.ctx.world, lo, hi);
        this.stats.buildMs = performance.now() - t0;
        const id = this.jobId++;
        z.job = id;
        this.jobs.set(id, (r) => {
            if(z.job !== id || !this.zones.includes(z)) return;
            z.job = 0;
            if(r.error || !r.count) { if(first) this._free(z); return; }
            if(r.solid > CELL_CAP) console.warn(`soft zone: ${r.solid} solid cells, capped at ${CELL_CAP}`);
            z.count = r.count;
            let plastic = false;
            for(let i = 0; i < r.count; i++) if(MATERIALS[(r.cells[i] >>> 24) & 255]?.plasticity > 0) { plastic = true; break; }
            z.plastic = plastic;
            this.sim.upload(z.slot, { n: z.n, flags: r.flags, cellIdx: r.cellIdx, cells: r.cells, count: r.count });
            const A = this.sim.slotA[z.slot], B = this.sim.slotB[z.slot];
            A.set(z.c0[0] * H, z.c0[1] * H, z.c0[2] * H, 1);
            B.set(z.n[0] + 1, z.n[1] + 1, z.n[2] + 1, r.count);
            if(first) {
                this.initMask = (this.initMask || 0) | (1 << z.slot);
                z.state = 'sim';
                this.stats.built++;
                for(const k of z.pendingKicks) this.kicks.push(fitKick(k, z.box, z.slot));
                z.pendingKicks = [];
            }
        });
        this.worker.postMessage({ op: 'classify', id, region, c0: z.c0, n: z.n, bedrockY: this.bedrockY }, [region.sdf.buffer, region.mat.buffer]);
    }

    // ------------------------------------------------------------------ frame

    update(dt) {
        if(!this.enabled) return;
        const t0 = performance.now();
        if(this.zones.length || this.deferred.length) this._update(dt);
        this.sim.flush(); // parameter changes (sleep, free) reach the vertex stage this frame
        const ms = performance.now() - t0, st = this.stats;
        st.cpuMs = st.cpuMs * 0.95 + ms * 0.05; st.cpuMax = Math.max(st.cpuMax * 0.995, ms);
    }

    _update(dt) {
        if(this.deferred.length) {
            const d = this.deferred; this.deferred = [];
            for(const w of d) { w.t += dt; if(w.t < 1 && !this.zones.some(z => z.state !== 'sim' && z.state !== 'building' && inside(z.box, w.point, 0.25))) this.wake(w.point, w.opts); else if(w.t < 1) this.deferred.push(w); }
        }
        const u = this.sim.u;
        let maxSlot = -1;
        for(const z of [...this.zones]) {
            if(z.refreshAt >= 0 && z.state === 'sim' && !z.job && --z.refreshAt < 0) this._classify(z, false);
            if((z.state === 'remesh' || z.state === 'applying') && (z.remeshT = (z.remeshT || 0) + dt) > 3) this._free(z);
            if(z.state !== 'sim') continue;
            z.life -= dt;
            this.sim.slotC[z.slot].x = z.life < this.settle ? 30 * (1 - z.life / this.settle) : 0;
            if(z.life <= 0) { this._sleep(z); continue; }
            maxSlot = Math.max(maxSlot, z.slot);
        }
        this.stats.zones = this.zones.length;
        if(maxSlot < 0) { this.acc = 0; return; }
        // kicks: up to MAX_KICKS a frame (the rest wait a frame)
        let kicks = false;
        for(let i = 0; i < MAX_KICKS; i++) {
            const k = this.kicks.shift();
            const A = this.sim.kickA[i], B = this.sim.kickB[i], C = this.sim.kickC[i];
            if(!k || this.slots[k.slot]?.state !== 'sim') { A.w = 0; continue; }
            kicks = true;
            A.set(k.p[0], k.p[1], k.p[2], k.radius);
            if(k.dir) B.set(k.dir[0], k.dir[1], k.dir[2], k.speed); else B.set(0, 0, 0, k.speed);
            C.set(k.slot, k.up || 0, 0, 0);
        }
        this.acc += Math.min(dt, 0.1);
        let n = Math.floor(this.acc / this.subDt);
        if(n > this.maxSubsteps) { n = this.maxSubsteps; this.acc = 0; } else this.acc -= n * this.subDt;
        if(!n && !kicks && !this.initMask) return;
        u.dt.value = this.subDt;
        this.sim.setExtent(maxSlot);
        this.stats.dispatches = this.sim.run(n, { init: this.initMask | 0, kicks });
        this.initMask = 0;
    }

    // ------------------------------------------------------------------ sleep, bake

    _sleep(z) {
        if(!z.plastic) { this._free(z); return; }
        z.state = 'frozen';
        this.sim.slotA[z.slot].w = 2; // drawn, no longer simulated
        const nodes = (z.n[0] + 1) * (z.n[1] + 1) * (z.n[2] + 1);
        this.sim.readSlot(z.slot, nodes).then((u) => {
            if(!this.zones.includes(z)) return;
            let m = 0;
            for(let i = 0; i < nodes; i++) m = Math.max(m, Math.abs(u[i * 4]), Math.abs(u[i * 4 + 1]), Math.abs(u[i * 4 + 2]));
            z.maxU = m;
            if(m < BAKE_MIN) { this._free(z); return; }
            z.u = u;
            this._bake(z);
        }).catch((e) => { console.error('soft readback', e); this._free(z); });
    }

    _bake(z) {
        const world = this.ctx.world;
        const margin = Math.ceil(z.maxU / VOXEL) + 2;
        const s0 = z.c0.map(v => v * SPC), s1 = z.c0.map((v, i) => (v + z.n[i]) * SPC);
        const lo = s0.map(v => v - margin), hi = s1.map(v => v + margin);
        const ver = chunkVersions(world, lo, hi);
        const region = readRegion(world, lo, hi);
        const id = this.jobId++;
        z.job = id; z.state = 'baking';
        this.jobs.set(id, ({ patch, error }) => {
            if(z.job !== id || !this.zones.includes(z)) return;
            z.job = 0;
            if(error) { this._free(z); return; }
            if(chunkVersions(world, lo, hi) !== ver) { this._bake(z); return; } // edited meanwhile: redo on the new SDF
            // the world's change listeners (renderer first, then ours: _onWorldChange) start the remesh
            z.state = 'applying'; z.patchBox = [patch.lo, patch.lo.map((v, i) => v + patch.dims[i] - 1)];
            applyPatch(world, patch).then((changed) => {
                this.stats.baked++;
                this.stats.lastBake = { changed, maxU: +z.maxU.toFixed(3) };
                if(!changed && this.zones.includes(z)) this._free(z);
            }).catch((e) => { console.error('soft bake', e); this._free(z); });
        });
        this.worker.postMessage({ op: 'bake', id, region, zone: { s0, n: z.n, u: z.u, bedrockY: this.bedrockY } }, [region.sdf.buffer, region.mat.buffer]);
    }

    /** A bake landed (the renderer remeshes the dirty chunks right after this listener). Wait for their new meshes (a
     *  chunk being meshed right now delivers a stale mesh first), which then skip this zone's displacement. */
    _onWorldChange(r) {
        if(r.kind !== 'samples' && r.kind !== 'soft') return;
        const pool = this.ctx.terrain.pool;
        for(const z of this.zones) {
            if(z.state !== 'applying' || !r.box || !boxTouches(r.box, z.patchBox)) continue;
            z.state = 'remesh'; z.remeshT = 0; z.pending = new Map(); z.tagged = [];
            for(const k of r.dirty) z.pending.set(k, pool?.inflight?.has(k) ? 2 : 1);
            if(!z.pending.size) this._free(z);
        }
    }

    _onChunkMesh(key, g) {
        for(const z of this.zones) {
            if(z.state !== 'remesh' || !z.pending.has(key)) continue;
            if(g) { g.userData.softSkip = (g.userData.softSkip | 0) | (1 << z.slot); z.tagged.push(g); }
            const left = z.pending.get(key) - 1;
            if(left > 0) z.pending.set(key, left); else z.pending.delete(key);
            if(!z.pending.size) this._free(z);
        }
    }

    _free(z) {
        const i = this.zones.indexOf(z);
        if(i >= 0) this.zones.splice(i, 1);
        if(this.slots[z.slot] === z) {
            this.slots[z.slot] = null;
            this.sim.slotA[z.slot].w = 0;
            this.sim.slotC[z.slot].x = 0;
        }
        for(const g of z.tagged || []) g.userData.softSkip &= ~(1 << z.slot);
        z.job = 0; z.state = 'free';
    }
}

/** Keep a kick's reach inside its zone (the boundary is pinned: a kick reaching it would leave a crease). */
function fitKick(k, box, slot) {
    const p = k.p;
    const edge = Math.min(p[0] - box[0][0], box[1][0] - p[0], p[2] - box[0][2], box[1][2] - p[2], p[1] - box[0][1]);
    return { ...k, slot, radius: Math.max(0.6, Math.min(k.radius, edge * 0.85)) };
}

const overlaps = (a, b) => a[0][0] < b[1][0] && a[1][0] > b[0][0] && a[0][1] < b[1][1] && a[1][1] > b[0][1] && a[0][2] < b[1][2] && a[1][2] > b[0][2];
const inside = (box, p, m = 0) => p[0] > box[0][0] - m && p[0] < box[1][0] + m && p[1] > box[0][1] - m && p[1] < box[1][1] + m && p[2] > box[0][2] - m && p[2] < box[1][2] + m;
const boxTouches = (a, b) => a[0][0] <= b[1][0] && a[1][0] >= b[0][0] && a[0][1] <= b[1][1] && a[1][1] >= b[0][1] && a[0][2] <= b[1][2] && a[1][2] >= b[0][2];
const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
