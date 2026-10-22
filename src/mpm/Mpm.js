/**
 * Granular ground (docs/MPM.md): sand, dirt, snow and lava that pour, avalanche and slump when a blast or a dig
 * undercuts them, simulated with PB-MPM (Lewin 2024, "A Position-Based Material Point Method") in local zones and put
 * back into the voxel terrain when they come to rest. ctx.mpm.
 *
 * Flow (every client runs the simulation, cosmetic and local; the terrain stays host-authoritative):
 *   1. a carve near granular matter carries `grains` options in its edit (destruction.grainsFor, set here)
 *   2. the terrain worker applies the edit and, deterministically, cuts the granular voxels that can no longer hold
 *      out of the terrain (src/mpm/grains.js selectGrains): reply.grains, the same on every client
 *   3. each client seeds particles for them in a zone (a 48 x 32 x 48 grid of 0.25 m cells around the edit; up to 4
 *      zones) and simulates them: GPU compute on WebGPU (MpmGPU), a worker on WebGL2 (MpmCPU), drawn as one instanced
 *      mesh (GrainRenderer)
 *   4. when a zone has come to rest (few moving particles, read back a few times a second), the host reads the
 *      particles back once, makes a column deposit (grains.js depositPatch) and submits it as a 'deposit' edit
 *   5. every client applies the deposit in edit order (terrain worker: applyDeposit, a union) and drops its own
 *      particles of that zone when its terrain has been remeshed. Clients never deposit: their piles may differ a
 *      little from the host's until the host's deposit replaces them.
 *   A host without the simulation (?mpm=0, or no free zone) deposits grains straight back where they were.
 *
 * URL: ?mpm=1 turns it on (off by default: the edits stay as they were), ?mpmCpu=1 the CPU solver on WebGPU too,
 * ?mpmIters=N, ?mpmSub=N. Keys (with ?mpm=1): V = avalanche at the crosshair (the surface layer around the point
 * becomes grains, no crater), F6 = log the stats.
 * Knobs: ctx.mpm.knobs (params.js DEFAULT_KNOBS): substeps, iterations, relaxScale, restSpeed, restFrames.
 */
import * as THREE from 'three/webgpu';
import { H, ZONE_DIMS, MAX_ZONES, PER_ZONE, CPU_CAP, GRAVITY, DEFAULT_KNOBS, MAX_PROXIES, GRANULAR, isGranular, isFlowing, packW, SNOW } from './params.js';
import { zoneLo, zoneField, seed, inZone, dropStranded } from './zone.js';
import { depositPatch } from './grains.js';
import { readRegion } from '../soft/region.js';
import { MpmGPU } from './MpmGPU.js';
import { MpmCPU } from './MpmCPU.js';
import { GrainRenderer } from './GrainRenderer.js';
import { sphere } from '../voxel/brushes.js';
import { VOXEL } from '../config.js';

const GRASS_AS = { 2: 1 };
/** A deposit patch as the edit carries it (typed arrays travel raw through the codec). */
const wire = (p) => ({ lo: p.lo, nx: p.nx, nz: p.nz, y0: p.y0, ny: p.ny, grid: p.grid, gmat: p.gmat, base: p.base, vol: p.vol, mat: p.mat });
const STATS_EVERY = 12;   // frames between stats readbacks
const SETTLE = 0.03;      // a zone is at rest when fewer than this share of its particles move
const MAX_LIFE = 14;      // s: a zone deposits then whatever it holds
const WAIT_DEPOSIT = 20;  // s: a client drops a settled zone the host never deposited

export class Mpm {
    constructor(ctx) {
        this.ctx = ctx;
        ctx.mpm = this;
        const p = ctx.params;
        this.enabled = p.get('mpm') === '1';
        this.knobs = { ...DEFAULT_KNOBS };
        if(p.get('mpmIters')) this.knobs.iterations = +p.get('mpmIters');
        if(p.get('mpmSub')) this.knobs.substeps = +p.get('mpmSub');
        this.zones = new Array(MAX_ZONES).fill(null);
        this.stats = { zones: 0, particles: 0, spawned: 0, deposits: 0, depositsApplied: 0, dropped: 0, lastDeposit: null, stepDispatches: 0, backend: 'off' };
        this.frame = 0;
        this.label = 'off';
        const net = ctx.net;
        if(!net) { this.enabled = false; return; } // (?terrainWorker=sync: no edit log, no grains)
        // the deposit edit: every client applies it in order (also when its own simulation is off)
        net.on('deposit', (e, meta) => this._applyDeposit(e, meta));
        ctx.destruction.editHooks.push((e) => this._onEdit(e));
        if(!this.enabled) return;
        const gpu = ctx.renderer.backend?.isWebGPUBackend && p.get('mpmCpu') !== '1';
        try {
            if(gpu) {
                this.sim = new MpmGPU(ctx.renderer);
                this.renderer = new GrainRenderer(ctx.scene, { gpu: this.sim });
                this.sim.warmup();
            } else {
                // the CPU fallback: 2 iterations (about 9 ms a step at its 6k cap, in its worker)
                if(!p.get('mpmIters')) this.knobs.iterations = 2;
                this.sim = new MpmCPU({ cap: CPU_CAP, knobs: this.knobs });
                this.renderer = new GrainRenderer(ctx.scene, { cap: CPU_CAP, divisor: !ctx.renderer.backend?.isWebGPUBackend });
                this.sim.onFrame = ({ buf, n }) => this.renderer.setCPU(buf, n);
            }
        } catch(e) { console.error('mpm: disabled', e); this.enabled = false; return; }
        this.label = this.stats.backend = gpu ? 'GPU compute' : 'CPU worker';
        console.log(`mpm: granular ground on (${this.label})`);
        ctx.destruction.grainsFor = (brush, o) => this.grainsFor(brush, o);
        addEventListener('keydown', (e) => {
            if(e.repeat) return;
            if(e.code === 'KeyV') this.avalancheAtCrosshair();
            if(e.code === 'F6') { e.preventDefault(); console.log('mpm', JSON.stringify(this.summary())); }
        });
    }

    // ------------------------------------------------------------------ edits -> grains

    /** Grain options for a carve, or null when there is no granular matter near it. */
    grainsFor(brush, { kind, impulse = 0 } = {}) {
        if(!this.enabled) return null;
        const c = brush.min.map((v, i) => (v + brush.max[i]) / 2);
        const r = Math.max(...brush.max.map((v, i) => v - brush.min[i])) / 2;
        if(this._force) { const f = this._force; this._force = null; return { c, r: f.r, force: true }; }
        if(r < 0.3) return null;
        // granular matter within reach? a coarse look at the replica (a blast: any; a dig: free-flowing only, since
        // cohesive ground only lets go of a blast's lip)
        const w = this.ctx.world, R = r + 1.5, blast = kind === 'blast';
        let found = false;
        for(let k = -2; k <= 2 && !found; k++) for(let j = -2; j <= 2 && !found; j++) for(let i = -2; i <= 2 && !found; i++) {
            const x = c[0] + i * R / 2, y = c[1] + j * R / 2, z = c[2] + k * R / 2;
            if(w.sample(x, y, z) < 0.3) { const m = w.materialAt(x, y, z); if(blast ? isGranular(m) : isFlowing(m)) found = true; }
        }
        if(!found) return null;
        return { c, r, blast: kind === 'blast', kick: kind === 'blast' ? Math.min(9, 3 + impulse * 0.4) : 0 };
    }

    /** The V key: the granular surface layer around the crosshair turns into grains (no crater). */
    avalancheAtCrosshair(radius = 2.2) {
        if(!this.enabled) return false;
        const cam = this.ctx.camera, d = new THREE.Vector3();
        cam.getWorldDirection(d);
        const hit = this.ctx.world.raycast([cam.position.x, cam.position.y, cam.position.z], [d.x, d.y, d.z], 120);
        if(!hit) return false;
        return this.avalanche(hit.point, radius);
    }
    avalanche(point, radius = 2.2) {
        this._force = { r: radius };
        this.ctx.destruction.carve(sphere(point, 0.3), { kind: 'avalanche', impulse: 0 });
        this._force = null;
        return true;
    }

    _onEdit(e) {
        if(!e.grains?.count) return;
        const g = e.grains;
        if(!this.enabled) { if(this.ctx.net.isHost) this._depositInPlace(g, [e.seq]); return; }
        const c = e.center;
        // the grains' lattice bounds: an existing zone that holds them takes them, else a new zone
        const b0 = [Infinity, Infinity, Infinity], b1 = [-Infinity, -Infinity, -Infinity];
        for(let n = 0; n < g.count; n++) for(let a = 0; a < 3; a++) { b0[a] = Math.min(b0[a], g.idx[n * 3 + a]); b1[a] = Math.max(b1[a], g.idx[n * 3 + a]); }
        let z = this.zones.find(z => z && z.state === 'sim' && inZone(z.lo, b0) && inZone(z.lo, b1));
        if(z) {
            this._uploadZone(z); // the edit changed the terrain inside it
        } else {
            const slot = this.zones.indexOf(null);
            if(slot < 0) { if(this.ctx.net.isHost) this._depositInPlace(g, [e.seq]); return; }
            const mid = [(b0[0] + b1[0]) / 2 * VOXEL, (b0[1] + b1[1]) / 2 * VOXEL, (b0[2] + b1[2]) / 2 * VOXEL];
            z = this.zones[slot] = { slot, lo: zoneLo([c[0] * 0.5 + mid[0] * 0.5, c[1], c[2] * 0.5 + mid[2] * 0.5]), seqs: [], born: performance.now(), state: 'sim', count: 0, moving: 0, quiet: 0, mats: new Set() };
            z.wall = GRANULAR[g.mat[0]]?.wall ?? 0.6;
            this._uploadZone(z);
        }
        z.seqs.push(e.seq);
        for(const m of g.mat) z.mats.add(m);
        // particles per voxel: as many as the zone's room allows (8, 4, 2 or 1)
        const room = this.sim.cpu ? this.sim.cap - this.sim.n : PER_ZONE - this.sim.counts[z.slot];
        let ppcLog = 0;
        while(ppcLog < 3 && g.count * (8 >> ppcLog) > room) ppcLog++;
        // grass lets go as the dirt under it (turf does not pour)
        const sd = seed({ ...g, mat: g.mat.map(m => GRASS_AS[m] ?? m) }, z.lo, { ppcLog, c, kick: e.kind === 'blast' ? Math.min(9, 3 + (e.impulse || 0) * 0.4) : 0, rim: e.size + 1.5 });
        const n = this.sim.spawn(z.slot, sd, { dt: 1 / 60, gravity: GRAVITY, H, packW, isSnow: (m) => GRANULAR[m]?.model === SNOW });
        z.count += n; z.quiet = 0; z.born = performance.now();
        this.stats.spawned += n;
        // no room for all of them (the CPU cap): the rest go straight back (seeded in grain order)
        if(n < sd.n && this.ctx.net.isHost) this._depositInPlace(g, [], Math.ceil(n / (8 >> ppcLog)));
    }

    _uploadZone(z) {
        this.sim.setZone(z.slot, { lo: z.lo, sdf: zoneField(this.ctx.world, z.lo, readRegion), wall: z.wall });
    }

    // ------------------------------------------------------------------ frame

    update(dt) {
        if(!this.enabled) return;
        this.frame++;
        const live = this.zones.some(z => z);
        if(!live) { if(this.sim.cpu) { if(this.renderer.mesh.visible) this.renderer.setCPU(new Float32Array(0), 0); } else this.renderer.setSlots(-1); return; }
        const kn = this.knobs, step = 1 / 60;
        if(this.sim.cpu) {
            const k = JSON.stringify(kn);
            if(k !== this._knobsSent) { this._knobsSent = k; this.sim.setKnobs(kn); }
            this.sim.setProxies(this._proxies());
            this.stats.stepDispatches = this.sim.step({ dt: step });
        } else {
            this.sim.setGlobals({ gstep: GRAVITY * (step / kn.substeps) ** 2 / H, restD: kn.restSpeed * (step / kn.substeps) / H, relaxScale: kn.relaxScale, restFrames: kn.restFrames, vscale: step / kn.substeps / H, maxStep: kn.maxStep });
            this.sim.setProxies(this._proxies());
            this.stats.stepDispatches = this.sim.step({ substeps: kn.substeps, iterations: kn.iterations });
            this.renderer.setSlots(this.sim.maxSlot);
        }
        if(this.frame % STATS_EVERY === 0) this._checkZones();
        for(const z of this.zones) if(z?.state === 'dropping' && (this.ctx.terrain.pending === 0 || --z.dropIn <= 0)) this._free(z);
    }

    /** Spheres of the player and of moving bodies near a zone (one-way coupling). */
    _proxies() {
        const out = [], zs = this.zones.filter(z => z);
        const near = (p) => zs.some(z => p[0] > z.lo[0] * H - 1 && p[0] < (z.lo[0] + 48) * H + 1 && p[2] > z.lo[2] * H - 1 && p[2] < (z.lo[2] + 48) * H + 1);
        const pl = this.ctx.game?.player?.body;
        if(pl) { const c = pl.center, v = pl.vel || { x: 0, y: 0, z: 0 }; if(near([c.x, c.y, c.z])) out.push({ c: [c.x, c.y - pl.halfHeight * 0.5, c.z], r: pl.radius + 0.1, v: [v.x || 0, v.y || 0, v.z || 0] }); }
        for(const p of this.ctx.physics.props) {
            if(out.length >= MAX_PROXIES) break;
            const b = p.body;
            if(!b.isDynamic?.() || b.isSleeping?.()) continue;
            const t = b.translation();
            if(!near([t.x, t.y, t.z])) continue;
            const v = b.linvel(), vol = p.userData?.volume ?? 0.3;
            out.push({ c: [t.x, t.y, t.z], r: Math.min(1.5, Math.max(0.25, Math.cbrt(vol) * 0.55)), v: [v.x, v.y, v.z] });
        }
        return out;
    }

    async _checkZones() {
        if(this._checking) return;
        this._checking = true;
        try {
            const st = await this.sim.readStats();
            if(!st) return;
            const now = performance.now();
            let particles = 0;
            for(const z of this.zones) {
                if(!z) continue;
                z.count = st[z.slot * 2]; z.moving = st[z.slot * 2 + 1];
                particles += z.count;
                if(z.state !== 'sim' && z.state !== 'waiting') continue;
                if(z.state === 'sim') {
                    z.quiet = z.moving <= Math.max(2, z.count * SETTLE) ? z.quiet + 1 : 0;
                    const old = (now - z.born) / 1000 > MAX_LIFE;
                    if(z.quiet >= 3 || old) { z.state = 'waiting'; z.waitSince = now; }
                }
                if(z.state === 'waiting') {
                    // the host deposits; a client waits for the host's deposit (and gives up after a while)
                    if(this.ctx.net.isHost) this._deposit(z);
                    else if((now - z.waitSince) / 1000 > WAIT_DEPOSIT) this._free(z);
                }
            }
            this.stats.zones = this.zones.filter(z => z).length;
            this.stats.particles = particles;
        } finally { this._checking = false; }
    }

    /** Host: read the zone's particles back once and submit them as a deposit edit. */
    async _deposit(z) {
        z.state = 'depositing';
        const t0 = performance.now();
        let pos, w;
        const r = await this.sim.readSlot(z.slot);
        if(r.world) { pos = r.pos; w = r.w; }
        else {
            const n = r.length / 4;
            pos = new Float32Array(n * 3); w = new Int32Array(n);
            let k = 0;
            for(let p = 0; p < n; p++) {
                if(r[p * 4 + 3] < 0) continue;
                for(let a = 0; a < 3; a++) pos[k * 3 + a] = (z.lo[a] + r[p * 4 + a]) * H;
                w[k++] = r[p * 4 + 3];
            }
            pos = pos.subarray(0, k * 3); w = w.subarray(0, k);
        }
        const dropped = dropStranded(pos, z.lo, this.ctx.world);
        // the terrain's solid samples: the zone's field (read once), the world's beyond it
        const world = this.ctx.world, f = zoneField(world, z.lo, readRegion), [nx, ny, nz] = ZONE_DIMS;
        const solidAt = (x, y, zz) => { const i = x - z.lo[0], j = y - z.lo[1], k = zz - z.lo[2]; return i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < nz ? f[i + j * nx + k * nx * ny] < 0 : world.get(x, y, zz) < 0; };
        const patch = depositPatch(pos, w, { solidAt });
        this.stats.lastDeposit = { particles: w.length, dropped, volume: patch?.volume ?? 0, ms: performance.now() - t0 };
        if(!patch) { this._free(z); return; }
        this.stats.deposits++;
        this.ctx.net.submit({ k: 'deposit', patch: wire(patch), seqs: z.seqs });
    }

    /** Host without a zone for them (or the simulation off): the grains go straight back where they were. */
    _depositInPlace(g, seqs, from = 0) {
        const n = g.count - from;
        if(n <= 0) return;
        const pos = new Float32Array(n * 3), w = new Int32Array(n);
        for(let q = 0; q < n; q++) {
            const k = from + q;
            for(let a = 0; a < 3; a++) pos[q * 3 + a] = g.idx[k * 3 + a] * VOXEL;
            w[q] = packW(0, 3, g.mat[k]); // one particle per voxel
        }
        const patch = depositPatch(pos, w);
        if(!patch) return;
        this.stats.deposits++;
        this.ctx.net.submit({ k: 'deposit', patch: wire(patch), seqs });
    }

    /** Every client, in edit order: the terrain takes the deposit; the zones it came from go when remeshed. */
    _applyDeposit(e, meta) {
        const done = this.ctx.world.remote.deposit(e.patch);
        this.stats.depositsApplied++;
        if(meta?.history) return done;
        return done.then(() => {
            for(const z of this.zones) if(z && z.seqs.some(s => e.seqs?.includes(s))) { z.state = 'dropping'; z.dropIn = 30; }
        });
    }

    _free(z) {
        this.sim.removeZone(z.slot);
        this.zones[z.slot] = null;
        this.stats.dropped++;
        if(!this.sim.cpu) this.renderer.setSlots(this.sim.maxSlot);
    }

    summary() {
        return { ...this.stats, knobs: this.knobs, zones: this.zones.map(z => z && { slot: z.slot, state: z.state, count: z.count, moving: z.moving, seqs: z.seqs.length, mats: [...z.mats] }) };
    }
}
