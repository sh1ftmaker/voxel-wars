/**
 * Detached terrain as rigid bodies: connectivity after edits, fracture on impact, carving bodies, ripping lumps, and
 * settling rubble back into the terrain. Owned by Destruction (ctx.destruction.bodies, also physics.voxelBodies).
 *
 *   bodies.queueConnectivity(lo, hi, brush?, kick?)   connectivity after a terrain edit, run in the background:
 *        unsupported regions become bodies over the next frames ('detached' events); kick { center, radius,
 *        strength } is the blast's push, applied to them when they appear
 *   bodies.detachAround(lo, hi, brush?) -> { bodies, removed, volume, ms }   the same, synchronously (tests, tools)
 *   bodies.carve(brush, { hardness }) -> { removed, volume, done }                 apply a carve to overlapping bodies
 *        (with the terrain worker the grids are carved there: removed / volume arrive with `done`, a Promise of
 *        { removed, volume }, or null when no body was touched)
 *   bodies.rip(brush) -> VoxelBody | null                                          tear a lump out of the world
 *   bodies.fracture(vb, point, dv)                                                 break a body (Voronoi pieces)
 *   bodies.crack(vb, split)                                                        break a body along its soft
 *        lattice's broken faces (bodies.soft: src/softbody/SoftBodies.js calls it)
 *   bodies.list                                                                    the live VoxelBody set
 *   bodies.budgetMs, maxBodies, breakScale, erode, impactDv                        tuning
 *
 * Frame budget: connectivity (a resumable flood fill), detaching, fracturing and stamping run as jobs under
 * `budgetMs` per frame (physics.onFrame), so a blast never costs a frame spike beyond the edit itself. A job whose
 * box a newer edit touches restarts merged with it.
 *
 * Lifecycle of a body:
 *   - impacts: Rapier contact force events, summed per body per step, give the velocity change dv = F h / m.
 *     dv > impactDv emits 'impact' { point, speed, mat, prop }; dv over the body's break threshold (scaled by
 *     material hardness, falling with mass, rising with each generation of fracture) splits it into Voronoi pieces
 *     seeded densest around the hit. Pieces under DEBRIS samples are pulverized: 'destroyed' { kind: 'impact' }.
 *   - soft layer (bodies.soft): impacts and blasts also kick the body's tet lattice, so it bends and jiggles. A hit
 *     over the break threshold but under SHATTER (8) times it cracks the lattice instead of the Voronoi split: faces
 *     break where it bent most and the body splits along them (crack()); if no crack forms within CRACK_WAIT s, a hit
 *     over CRACK_FALLBACK times the threshold cleaves it into 2-3 Voronoi pieces. Only harder hits shatter.
 *   - structural collapse: pieces the terrain worker cut off a failing overhang (src/voxel/structure.js) start
 *     turning about the broken root, their soft layer sagging (_hinge).
 *   - settling: a body asleep (or barely moving) for SETTLE seconds is stamped back into the VoxelWorld at its pose
 *     and removed once the terrain under it has been remeshed: rubble becomes diggable terrain again.
 *   - budget: over maxBodies (48), the stillest bodies are stamped early and small moving ones are pulverized; near
 *     the cap fractures make fewer pieces and more dust.
 *   - bodies leaving the world are removed; bodies the game removes (physics.removeBody) are forgotten.
 *   - a kinematic body (held by a player) or one with userData.held never settles or fractures.
 */
import { VOXEL, CHUNK } from '../config.js';
import { MATERIALS } from '../voxel/materials.js';
import { VoxelWorld } from '../voxel/VoxelWorld.js';
import { sphere, box, rock, specOf } from '../voxel/brushes.js';
import { stampGrid, findIslands, islandsJob, detachIsland, splitGrid, voronoiLabels, carveGrid, stampJob, liftGrid, gridStats, gridBoxes, gridHullPoints, newGrid, SAMPLE_VOLUME } from '../voxel/islands.js';
import { PAD } from '../config.js';
import { VoxelBody } from '../voxel/VoxelBody.js';
import { GRAVITY } from './Physics.js';
import { createTerrainMaterial } from '../render/terrainMaterial.js';
import { SoftBodies } from '../softbody/SoftBodies.js';
import { cellSampleLabels } from '../softbody/lattice.js';

/** Rotate vector v by quaternion q = [x,y,z,w]. */
function rotate(q, v) {
    const [x, y, z, w] = q;
    const ix = w * v[0] + y * v[2] - z * v[1], iy = w * v[1] + z * v[0] - x * v[2], iz = w * v[2] + x * v[1] - y * v[0], iw = -x * v[0] - y * v[1] - z * v[2];
    return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
}

/** Islands and pieces with fewer solid samples than this are dust, not bodies (0.25 m³). */
export const DEBRIS = 16;
const MAX_BODIES = 48;
const SETTLE = 2;
/** A budgeted job waiting for the terrain worker's answer. */
const WAIT = 'wait';
/** Bodies smaller than this never fracture (≈ 1.9 m³). */
const MIN_FRACTURE = 120;
/** Hits up to this many times the break threshold crack the soft lattice (a few big pieces along where it bent);
 *  only harder ones shatter (Voronoi). Thrown lumps and falling spans stay physics objects and break apart. */
const SHATTER = 8;
/** A crack attempt that formed no crack within CRACK_WAIT s: hits over CRACK_FALLBACK times the threshold cleave
 *  the body into a few pieces anyway (Voronoi, CLEAVE pieces at most, a gentle push apart). */
const CRACK_WAIT = 0.4, CRACK_FALLBACK = 1.8, CLEAVE = 3;
/** Velocity changes (m/s) under this do not shake the soft layer. */
const SOFT_DV = 1.5;

export class VoxelBodies {
    constructor(ctx) {
        this.ctx = ctx;
        this.world = ctx.world;
        this.physics = ctx.physics;
        this.scene = ctx.scene;
        this.events = ctx.events;
        this.pool = ctx.terrain.pool;
        this.material = createTerrainMaterial({ local: true });
        this.list = new Set();
        this.ghosts = [];          // meshes of broken bodies shown until their pieces are meshed
        this.hits = new Map();     // VoxelBody -> { f, fmax, c, o } this step
        this.impactDv = 3;         // m/s: weaker contacts are not reported
        this.maxBodies = MAX_BODIES;
        this.breakScale = 1;       // tuning knob for fracture thresholds
        this.erode = 48;           // stored SDF units (32 per voxel): necks thinner than ~2x this break after an edit (-1: off)
        this.budgetMs = 1.2;       // background work per frame (connectivity, detach, fracture, stamping)
        this.jobs = [];            // FIFO: { kind: 'conn' | 'stamp', ... }
        this.breaks = new Map();   // VoxelBody -> [point, dv]: fractures waiting for the next frame's budget
        this.stats = { detached: 0, fractured: 0, stamped: 0, pulverized: 0, lastIslandsMs: 0, lastFractureMs: 0, frameMs: 0, frameMsMax: 0, jobs: 0 };
        this.physics.voxelBodies = this;
        this.soft = new SoftBodies({ material: this.material, params: ctx.params });
        this.soft.onSplit = (vb, split) => this.crack(vb, split);
        // later generations are tougher (as breakDv); pieces too small to fracture only wobble
        this.soft.toughOf = (vb) => vb.grid.count >= MIN_FRACTURE ? 1 + 0.4 * vb.generation : 0;
        this.physics.onContactForce((c1, c2, f) => this._contact(c1, c2, f));
        this.physics.onStep((h) => this._step(h));
        this.physics.onFrame(() => this._frame());
        const w = this.world;
        this.bounds = { min: w.smin.map(v => v * VOXEL - 8), max: w.smax.map(v => v * VOXEL + 8) };
        // Warm the JIT up on a scratch world: every code path of an edit, a detach, a body, a fracture and a stamp
        // runs once now, so the first blast in play does not pay several times its warm cost.
        const t0 = performance.now();
        this._warmup();
        this.stats.warmupMs = performance.now() - t0;
    }

    _warmup() {
        const w = new VoxelWorld({ min: [0, 0, 0], max: [2, 2, 2] }); // 16 m, its own chunks
        for(let k = 0; k < 3; k++) {
            w.applyBrush(sphere([8, 9, 8], 3.2), { op: 'add', mat: 1 });
            w.applyBrush(box([2, 0, 2], [5, 6, 5]), { op: 'add', mat: 8 });
            w.applyBrush(rock([8, 9, 8], 1.4, 1 + k), { op: 'carve' });
            w.applyBrush(rock([3.5, 1.5, 3.5], 1.2, 1 + k), { op: 'paint', mat: 5 });
            const res = findIslands(w, [0, 0, 0], [63, 63, 63], { erode: Math.max(0, this.erode), near: sphere([8, 9, 8], 4) });
            for(const isl of res.islands) {
                const { grid } = detachIsland(w, isl);
                if(!grid || grid.count < DEBRIS) continue;
                stampGrid(w, grid, [2, 3, 2], [0, Math.sin(0.2), 0, Math.cos(0.2)]);
                // a body far below the level, broken up and thrown away
                const vb = this.add(grid, { origin: [0, -900 - k * 50, 0] });
                const dust = new Float64Array(256);
                carveGrid(vb.grid, sphere([1, 1, 1], 1));
                const pieces = splitGrid(vb.grid, voronoiLabels(vb.grid, [1, 1, 1], 5), { minCount: DEBRIS, dust });
                const { bodies } = this.replace(vb, pieces, { point: [0, -900, 0], spread: 2, generation: 1 });
                for(const b of bodies) { b.dispose(); this.list.delete(b); }
            }
        }
        for(const g of this.ghosts) g.vb.disposeMesh();
        this.ghosts.length = 0;
    }

    get count() { return this.list.size; }

    // ------------------------------------------------------------ creation

    add(grid, opts) {
        const vb = new VoxelBody(this, grid, opts);
        this.list.add(vb);
        return vb;
    }

    /** Queue connectivity after a terrain edit inside the sample box [lo, hi] (see the header). */
    queueConnectivity(lo, hi, brush = null, kick = null) {
        const job = { kind: 'conn', lo: [...lo], hi: [...hi], brush, kicks: kick ? [kick] : [], gen: null, islands: null, i: 0 };
        const m = 8;
        for(let k = this.jobs.length - 1; k >= 0; k--) {
            const j = this.jobs[k];
            if(j.kind !== 'conn') continue;
            if(j.lo[0] > job.hi[0] + m || j.lo[1] > job.hi[1] + m || j.lo[2] > job.hi[2] + m || j.hi[0] < job.lo[0] - m || j.hi[1] < job.lo[1] - m || j.hi[2] < job.lo[2] - m) continue;
            // overlapping: abort that one and redo both boxes together
            if(j.gen) j.gen.return();
            for(let a = 0; a < 3; a++) { job.lo[a] = Math.min(job.lo[a], j.lo[a]); job.hi[a] = Math.max(job.hi[a], j.hi[a]); }
            const b1 = job.brush, b2 = j.brush;
            job.brush = b1 && b2 ? { min: b1.min.map((v, a) => Math.min(v, b2.min[a])), max: b1.max.map((v, a) => Math.max(v, b2.max[a])), d: (x, y, z) => Math.min(b1.d(x, y, z), b2.d(x, y, z)) } : null;
            job.kicks.push(...j.kicks);
            this.jobs.splice(k, 1);
        }
        this.jobs.push(job);
        return job;
    }

    /** Connectivity after a terrain edit inside the sample box [lo, hi], synchronously. */
    detachAround(lo, hi, brush = null) {
        for(const j of this.jobs) if(j.kind === 'conn' && j.gen) { j.gen.return(); j.gen = null; j.islands = null; } // they share scratch state
        const removed = new Float64Array(256);
        let volume = 0;
        const out = [];
        const res = findIslands(this.world, lo, hi, { erode: Math.max(0, this.erode), near: brush });
        const ms = res.ms;
        this._detach(res.islands, removed, out, (v) => { volume += v; });
        this.stats.lastIslandsMs = ms;
        return { bodies: out, removed, volume, ms };
    }
    _detach(islands, removed, out, addVolume) {
        for(const isl of islands) {
            const small = isl.count < DEBRIS;
            const d = detachIsland(this.world, isl, { keepGrid: !small });
            if(small) { for(let i = 0; i < 256; i++) removed[i] += d.removed[i]; addVolume(isl.count * SAMPLE_VOLUME); continue; }
            const g = d.grid;
            const vb = this.add(g, { origin: [g.offset[0] * VOXEL, g.offset[1] * VOXEL, g.offset[2] * VOXEL], waitKeys: [...d.dirty] });
            vb.body.wakeUp();
            this.stats.detached++;
            out.push(vb);
            this.events.dispatchEvent(new CustomEvent('detached', { detail: { prop: vb.prop, volume: vb.volume, mat: vb.mat } }));
        }
    }
    /** Bodies and dust from a terrain worker reply (TerrainCore 'brush' with conn): islands cut out of the world. */
    fromWorker(rep, kick = null) {
        const kicks = kick ? [kick] : [];
        if(rep.islandsMs !== undefined) this.stats.lastIslandsMs = rep.islandsMs;
        for(const d of rep.dust || []) this._dust(d.center, d.removed, 'carve');
        // one body per budgeted unit (a frame each when several arrive): a body's first contacts cost a Rapier step
        for(const isl of rep.islands || []) this.jobs.push({ kind: 'island', isl, kicks });
    }
    /** A body for an island the terrain worker cut out (dust when far over the body cap). */
    _runIsland(j) {
        if(this.islandFrame === this.frameNo) return WAIT;
        const isl = j.isl;
        if(this.list.size >= this.maxBodies * 2) this._dust(isl.grid.offset.map(v => v * VOXEL), isl.grid.prep.stats.volumes, 'carve');
        else this._bodyFromIsland(isl, j.kicks);
        this.islandFrame = this.frameNo; // one new body per frame
        return true;
    }
    /** Detach one island found by a background job: a body, or dust if tiny. */
    _detachOne(isl, kicks) { const d = this._cutIsland(isl); if(d) this._bodyFromIsland(d, kicks); }
    /** Remove an island from the world; tiny ones are dust (returns null), others return { grid, dirty }. */
    _cutIsland(isl) {
        const small = isl.count < DEBRIS;
        const d = detachIsland(this.world, isl, { keepGrid: !small });
        if(!d.count) return null;
        if(small || !d.grid.count) { const c = isl.min.map((v, a) => (v + isl.max[a]) * 0.5 * VOXEL); this._dust(c, d.removed, 'carve'); return null; }
        return d;
    }
    _bodyFromIsland(d, kicks) {
        const g = d.grid;
        const vb = this.add(g, { origin: [g.offset[0] * VOXEL, g.offset[1] * VOXEL, g.offset[2] * VOXEL], waitKeys: [...d.dirty], prep: g.prep || null });
        vb.body.wakeUp();
        this.stats.detached++;
        if(d.collapse) this._hinge(vb, d.collapse);
        for(const k of kicks) vb.explode(k.center, k.radius, k.strength);
        this.events.dispatchEvent(new CustomEvent('detached', { detail: { prop: vb.prop, volume: vb.volume, mat: vb.mat, collapse: d.collapse?.reason ?? null } }));
    }
    /** A structural failure (src/voxel/structure.js) snapped this piece off at `root`: it starts turning about the
     *  broken root (the free end drops first) and its soft layer sags (the far end lags the root's give). */
    _hinge(vb, { root, dir }) {
        this.stats.collapsed = (this.stats.collapsed || 0) + 1;
        const b = vb.body, com = b.worldCom();
        const h = Math.hypot(dir[0], dir[2]);
        if(h > 0.1) {
            const lever = Math.max(0.5, Math.hypot(com.x - root[0], com.z - root[2]));
            const w = Math.min(1.2, 2.2 / Math.sqrt(lever)); // rad/s: a long span tips slower
            const ax = dir[2] / h * w, az = -dir[0] / h * w;   // up x dir: the free end goes down
            const rx = com.x - root[0], ry = com.y - root[1], rz = com.z - root[2];
            b.setAngvel({ x: ax, y: 0, z: az }, true);
            b.setLinvel({ x: -az * ry, y: az * rx - ax * rz, z: ax * ry }, true); // w x r: the root stays put
        }
        this.soft.impact(vb, root, [0, 3.5, 0], 1);
    }

    // ------------------------------------------------------------ per frame: budgeted jobs

    _frame() {
        const t0 = performance.now(), end = t0 + this.budgetMs;
        this.soft.frame(Math.min(0.1, (t0 - (this.lastFrame ?? t0)) / 1000));
        this.lastFrame = t0;
        this.frameNo = (this.frameNo || 0) + 1;
        // fractures go first (staged jobs: pieces, then one disabled body per unit, then an atomic swap)
        for(const [vb, [point, dv, cells, few]] of this.breaks) {
            this.breaks.delete(vb);
            if(vb.dead || vb.fracturing || vb.stamping || !this.list.has(vb) || !vb.body.isDynamic() || (cells && vb.prop.userData.held)) { if(cells) this.soft.gridChanged(vb); continue; }
            vb.fracturing = true;
            this.jobs.unshift({ kind: 'frac', vb, point, dv, cells, few: few || 0, pieces: null, kids: [], i: 0, dust: new Float64Array(256) });
        }
        // jobs run in order; one waiting for the terrain worker (WAIT) lets the next ones run meanwhile
        let first = true, k = 0;
        while(k < this.jobs.length && (first || performance.now() < end)) {
            first = false;
            const j = this.jobs[k];
            const done = j.kind === 'conn' ? this._runConn(j, end) : j.kind === 'stamp' ? this._runStamp(j, end) : j.kind === 'frac' ? this._runFracture(j) : j.kind === 'island' ? this._runIsland(j) : this._rebody(j.vb);
            if(done === WAIT) { k++; first = true; continue; }
            if(done) this.jobs.splice(this.jobs.indexOf(j), 1);
        }
        const ms = performance.now() - t0;
        this.stats.jobs = this.jobs.length;
        this.stats.frameMs = this.stats.frameMs * 0.95 + ms * 0.05;
        this.stats.frameMsMax = Math.max(this.stats.frameMsMax * 0.995, ms);
    }
    _runConn(j, end) {
        if(!j.islands) {
            if(!j.gen) { j.gen = islandsJob(this.world, j.lo, j.hi, { erode: Math.max(0, this.erode), near: j.brush }, 2048); j.ms = 0; }
            const t = performance.now();
            let r;
            do r = j.gen.next(); while(!r.done && performance.now() < end);
            j.ms += performance.now() - t;
            if(!r.done) return false;
            j.gen = null;
            j.islands = r.value.islands;
            this.stats.lastIslandsMs = j.ms;
            return !j.islands.length;
        }
        // one unit per call (the frame loop calls again while there is time): cut an island out of the world, then
        // make its body
        if(j.pending) { this._bodyFromIsland(j.pending, j.kicks); j.pending = null; return j.i >= j.islands.length; }
        j.pending = this._cutIsland(j.islands[j.i++]);
        return !j.pending && j.i >= j.islands.length;
    }
    _runFracture(j) {
        const vb = j.vb;
        if(vb.dead || !this.list.has(vb) || vb.stamping || !vb.body.isDynamic()) {
            for(const k of j.kids) k.kid.dispose();
            vb.fracturing = false;
            if(j.cells && !vb.dead) this.soft.gridChanged(vb); // the lattice stopped at the split: start over
            return true;
        }
        const t0 = performance.now();
        const remote = this.world.remote;
        if(!j.pieces && remote) {
            // the Voronoi split runs in the terrain worker; pieces come back with their stats and collider boxes
            if(j.asked) return WAIT;
            j.asked = true;
            const g = vb.grid;
            const energy = Math.min(4, j.dv / this.breakDv(vb));
            const crowd = Math.max(0.35, Math.min(1, 1.3 - this.pressure()));
            const n = j.few || Math.max(2, Math.min(14, Math.round((1 + energy * 2 + Math.log2(1 + vb.volume)) * crowd)));
            const c = j.cells, cells = c ? { labels: c.labels, cellOf: c.cellOf, cs: c.cs, dims: c.dims } : null;
            remote.split(g, { point: vb.toLocal(j.point), n, cells, minCount: this.debrisMin(), generation: vb.generation + 1 }).then(rep => {
                j.pieces = rep.same ? [g] : rep.pieces;
                j.dust.set(rep.dust);
            }, () => { j.pieces = []; });
            j.sibling = 1 << (2 + (this.siblingNext = ((this.siblingNext || 0) + 1) % 12));
            j.held = { ...vb.prop.userData }; delete j.held.voxelBody; delete j.held.ripped;
            j.ms = performance.now() - t0;
            return WAIT;
        }
        if(!j.pieces) {
            const g = vb.grid;
            if(this.debug) console.log(`fracture n=${g.count} gen=${vb.generation} age=${vb.age.toFixed(2)} dv=${j.dv.toFixed(1)} break=${this.breakDv(vb).toFixed(1)} mass=${(vb.mass / 1000).toFixed(1)}t`);
            const energy = Math.min(4, j.dv / this.breakDv(vb));
            const crowd = Math.max(0.35, Math.min(1, 1.3 - this.pressure()));
            const n = j.few || Math.max(2, Math.min(14, Math.round((1 + energy * 2 + Math.log2(1 + vb.volume)) * crowd)));
            const c = j.cells;
            j.pieces = splitGrid(g, c ? cellSampleLabels(g, c.labels, c.cellOf, c.cs, c.dims) : voronoiLabels(g, vb.toLocal(j.point), n), { minCount: this.debrisMin(), dust: j.dust });
            j.sibling = 1 << (2 + (this.siblingNext = ((this.siblingNext || 0) + 1) % 12));
            j.held = { ...vb.prop.userData }; delete j.held.voxelBody; delete j.held.ripped;
            j.ms = performance.now() - t0;
            return false;
        }
        if(j.i < j.pieces.length) {
            // one piece per unit, parked (disabled, hidden) at the parent's current pose
            const p = j.pieces[j.i++];
            const kid = new VoxelBody(this, p, { origin: vb.toWorld([p.offset[0] * VOXEL, p.offset[1] * VOXEL, p.offset[2] * VOXEL]), rotation: vb.rotation(), generation: vb.generation + 1, userData: { ...j.held }, waitKeys: vb.waitKeys, sibling: j.sibling, enabled: false, prep: p.prep || null });
            j.kids.push({ kid, p });
            j.ms += performance.now() - t0;
            return false;
        }
        // swap: the pieces take over the parent's motion where it is now, plus a spread away from the hit (a crack:
        // a nudge apart; the pieces keep the parent's wobble)
        const b = vb.body, v = b.linvel(), w = b.angvel(), com = b.worldCom(), rot = vb.rotation();
        const spread = j.cells ? 0.8 : j.few ? 1.2 : Math.min(8, 1.5 + j.dv * 0.15), point = j.cells ? [com.x, com.y, com.z] : j.point;
        for(const { kid, p } of j.kids) this.soft.inherit(kid, vb, [p.offset[0] * VOXEL, p.offset[1] * VOXEL, p.offset[2] * VOXEL]);
        for(const { kid, p } of j.kids) {
            const o = vb.toWorld([p.offset[0] * VOXEL, p.offset[1] * VOXEL, p.offset[2] * VOXEL]);
            const rc = rotate(rot, kid.stats.com), c = [o[0] + rc[0], o[1] + rc[1], o[2] + rc[2]];
            const rx = c[0] - com.x, ry = c[1] - com.y, rz = c[2] - com.z;
            const lv = [v.x + w.y * rz - w.z * ry, v.y + w.z * rx - w.x * rz, v.z + w.x * ry - w.y * rx];
            const av = [w.x, w.y, w.z];
            let dx = c[0] - point[0], dy = c[1] - point[1], dz = c[2] - point[2];
            const l = Math.hypot(dx, dy, dz) || 1, k = spread * (0.5 + Math.random() * 0.7) / l;
            lv[0] += dx * k; lv[1] += dy * k + spread * 0.25; lv[2] += dz * k;
            for(let a = 0; a < 3; a++) av[a] += (Math.random() - 0.5) * spread * 0.6;
            kid.activate({ origin: o, rotation: rot, linvel: lv, angvel: av });
            this.list.add(kid);
        }
        vb.dispose({ keepMesh: true });
        this.list.delete(vb);
        const ghost = { vb, t: 0 };
        this.ghosts.push(ghost);
        Promise.all(j.kids.map(k => k.kid.meshed)).then(() => { ghost.done = true; });
        this.stats.fractured++;
        this.stats.lastFractureMs = j.ms + performance.now() - t0; // total over its frames
        if(j.cells) j.dust[vb.mat] += 0.1; // crumbs along the crack
        this._dust(j.point, j.dust, 'impact', vb);
        return true;
    }
    _runStamp(j, end) {
        const vb = j.vb;
        if(vb.dead) return true;
        let r;
        do r = j.gen.next(); while(!r.done && performance.now() < end);
        if(!r.done) return false;
        vb.stampKeys = [...r.value.dirty];
        vb.stampT = 0;
        return true;
    }

    /** Tear the world's matter inside `brush` out as one body (the largest connected piece; the rest becomes rubble). */
    rip(brush, userData = {}) {
        const g = liftGrid(this.world, brush);
        if(g.count < DEBRIS) return null;
        const remote = this.world.remote;
        const r = remote ? null : this.world.applyBrush(brush, { op: 'carve', hardness: false });
        // with the terrain worker the world is cut a frame or two later (the lump ignores the terrain until then)
        const waitKeys = r ? [...r.dirty] : [...this.world.chunksInSampleBox(brush.min.map(v => Math.floor(v / VOXEL) - 4 - PAD - 1), brush.max.map(v => Math.ceil(v / VOXEL) + 4 + PAD + 1))];
        const pieces = splitGrid(g).filter(p => p.count > 0);
        pieces.sort((a, b) => b.count - a.count);
        let lump = null;
        for(const p of pieces) {
            if(p.count < DEBRIS && lump) continue;
            const o = [(g.offset[0] + p.offset[0]) * VOXEL, (g.offset[1] + p.offset[1]) * VOXEL, (g.offset[2] + p.offset[2]) * VOXEL];
            const vb = this.add(p, { origin: o, waitKeys, userData: lump ? {} : { ripped: true, ...userData } });
            if(!lump) lump = vb;
        }
        if(remote) {
            const made = [...this.list].filter(vb => vb.waitKeys === waitKeys);
            for(const vb of made) vb.waitRemote = true;
            const release = () => { for(const vb of made) vb.waitRemote = false; };
            remote.brush(brush, { op: 'carve', hardness: false, conn: true, erode: Math.max(0, this.erode), debris: DEBRIS }).then(rep => { release(); this.fromWorker(rep); }, release);
        }
        else if(r.changed) this.queueConnectivity(r.box[0], r.box[1], brush);
        return lump;
    }

    // ------------------------------------------------------------ carving

    /** Apply a carving brush (world metres) to every body it overlaps. Returns { removed, volume }. */
    carve(brush, { hardness = true } = {}) {
        const removed = new Float64Array(256);
        let volume = 0;
        const pending = [];
        for(const vb of [...this.list]) {
            if(vb.dead || vb.stamping) continue;
            const [mn, mx] = vb.worldBox();
            if(mn[0] > brush.max[0] || mn[1] > brush.max[1] || mn[2] > brush.max[2] || mx[0] < brush.min[0] || mx[1] < brush.min[1] || mx[2] < brush.min[2]) continue;
            // the brush in the body's grid-local frame
            const lmin = [Infinity, Infinity, Infinity], lmax = [-Infinity, -Infinity, -Infinity];
            for(let k = 0; k < 8; k++) {
                const l = vb.toLocal([k & 1 ? brush.max[0] : brush.min[0], k & 2 ? brush.max[1] : brush.min[1], k & 4 ? brush.max[2] : brush.min[2]]);
                for(let a = 0; a < 3; a++) { lmin[a] = Math.min(lmin[a], l[a]); lmax[a] = Math.max(lmax[a], l[a]); }
            }
            const t = vb.body.translation(), q = vb.body.rotation(), f = vb.frame;
            // rotation matrix columns (local -> world) for the brush's distance query
            const { x: qx, y: qy, z: qz, w: qw } = q;
            const m00 = 1 - 2 * (qy * qy + qz * qz), m01 = 2 * (qx * qy - qz * qw), m02 = 2 * (qx * qz + qy * qw);
            const m10 = 2 * (qx * qy + qz * qw), m11 = 1 - 2 * (qx * qx + qz * qz), m12 = 2 * (qy * qz - qx * qw);
            const m20 = 2 * (qx * qz - qy * qw), m21 = 2 * (qy * qz + qx * qw), m22 = 1 - 2 * (qx * qx + qy * qy);
            const remote = this.world.remote;
            if(remote) {
                // carved in the terrain worker; edits of one body are chained so each starts from the last one's grid
                const spec = specOf(brush), tt = [t.x, t.y, t.z], M = [m00, m01, m02, m10, m11, m12, m20, m21, m22], ff = [...f];
                const p = (vb.gridOp || Promise.resolve()).then(() => {
                    if(vb.dead || vb.stamping) return null;
                    return remote.carveGrid(vb.grid, spec, { lmin, lmax, t: tt, m: M, f: ff, hardness }).then(rep => {
                        if(vb.dead || vb.stamping || !rep.changed) return null;
                        vb.grid = rep.grid;
                        this._carved(vb);
                        return rep.removed;
                    });
                }).catch(() => null);
                vb.gridOp = p;
                pending.push(p);
                continue;
            }
            const local = { min: lmin, max: lmax, d: (x, y, z) => {
                const lx = x - f[0], ly = y - f[1], lz = z - f[2];
                return brush.d(t.x + m00 * lx + m01 * ly + m02 * lz, t.y + m10 * lx + m11 * ly + m12 * lz, t.z + m20 * lx + m21 * ly + m22 * lz);
            } };
            const r = carveGrid(vb.grid, local, { hardness });
            if(!r.changed) continue;
            for(let i = 0; i < 256; i++) { removed[i] += r.removed[i]; volume += r.removed[i]; }
            this._carved(vb);
        }
        // with the worker: removed / volume are 0 here, `done` resolves to the full { removed, volume }
        const done = pending.length ? Promise.all(pending).then(list => {
            for(const rm of list) if(rm) for(let i = 0; i < 256; i++) { removed[i] += rm[i]; volume += rm[i]; }
            return { removed, volume };
        }) : null;
        return { removed, volume, done };
    }
    /** A body's grid was carved: remesh at once, the shape (split, colliders) in a budgeted job. */
    _carved(vb) {
        vb.carves = (vb.carves || 0) + 1;
        this.soft.gridChanged(vb);
        vb.remesh();
        vb.body.wakeUp();
        vb.still = 0;
        if(!vb.rebody) { vb.rebody = true; this.jobs.unshift({ kind: 'rebody', vb }); }
    }
    /** After carving: split a body cut in two, or rebuild its colliders. */
    _rebody(vb) {
        const remote = this.world.remote;
        if(remote) return this._rebodyRemote(vb, remote);
        vb.rebody = false;
        if(vb.dead || vb.stamping || !this.list.has(vb)) return true;
        const dust = new Float64Array(256);
        const t = vb.body.translation(); // before replace() removes the body: reading a removed body panics Rapier
        const pieces = splitGrid(vb.grid, null, { minCount: DEBRIS, dust });
        if(pieces.length === 1 && pieces[0] === vb.grid) {
            vb.stats = gridStats(vb.grid);
            vb.updateUserData();
            vb.buildColliders();
        } else {
            const r = this.replace(vb, pieces, {});
            for(let i = 0; i < 256; i++) dust[i] += r.removed[i];
        }
        this._dust([t.x, t.y, t.z], dust, 'carve', vb);
        return true;
    }
    /** _rebody with the component split in the terrain worker (a job: WAIT until the answer is in). */
    _rebodyRemote(vb, remote) {
        const j = vb.rebodyJob ||= { asked: false, rep: null, v: 0 };
        if(vb.dead || vb.stamping || !this.list.has(vb)) { vb.rebody = false; vb.rebodyJob = null; return true; }
        if(!j.asked) {
            j.asked = true; j.v = vb.carves || 0;
            remote.split(vb.grid, { minCount: DEBRIS, generation: vb.generation }).then(rep => { j.rep = rep; }, () => { j.rep = { same: true, prep: null, dust: new Float64Array(256) }; });
            return WAIT;
        }
        if(!j.rep) return WAIT;
        vb.rebodyJob = null;
        // carved again meanwhile: split the newer grid instead
        if((vb.carves || 0) !== j.v) { vb.rebodyJob = null; return this._rebodyRemote(vb, remote); }
        vb.rebody = false;
        const rep = j.rep, dust = rep.dust;
        const t = vb.body.translation();
        if(rep.same) {
            vb.stats = rep.prep?.stats || gridStats(vb.grid);
            vb.grid.count = vb.stats.count;
            vb.updateUserData();
            vb.buildColliders(rep.prep && rep.prep.generation === vb.generation ? rep.prep.boxes : null);
        } else {
            const r = this.replace(vb, rep.pieces, {});
            for(let i = 0; i < 256; i++) dust[i] += r.removed[i];
        }
        this._dust([t.x, t.y, t.z], dust, 'carve', vb);
        return true;
    }

    /**
     * Swap a body for pieces of its grid (each with `offset` in the body's grid-local samples). Pieces inherit the
     * body's motion (v + w x r) plus `spread` m/s away from `point`. Tiny pieces are dust. Returns { removed, bodies }.
     */
    replace(vb, pieces, { point = null, spread = 0, generation = vb.generation }) {
        const b = vb.body;
        const v = b.linvel(), w = b.angvel(), com = b.worldCom();
        const rot = vb.rotation();
        const removed = new Float64Array(256);
        const held = { ...vb.prop.userData };
        delete held.voxelBody; delete held.ripped;
        const kids = [];
        const sibling = 1 << (2 + (this.siblingNext = ((this.siblingNext || 0) + 1) % 12));
        const pieceData = pieces.map(p => {
            const st = p.prep?.stats || gridStats(p);
            // world origin of the piece's local 0 (same rotation as the parent)
            const o = vb.toWorld([p.offset[0] * VOXEL, p.offset[1] * VOXEL, p.offset[2] * VOXEL]);
            return { p, st, o };
        });
        vb.dispose({ keepMesh: true });
        this.list.delete(vb);
        for(const { p, st, o } of pieceData) {
            if(st.count < this.debrisMin()) { for(let i = 0; i < 256; i++) removed[i] += st.volumes[i]; continue; }
            // centre of mass of the piece in world space
            const rc = rotate(rot, st.com), c = [o[0] + rc[0], o[1] + rc[1], o[2] + rc[2]];
            const rx = c[0] - com.x, ry = c[1] - com.y, rz = c[2] - com.z;
            const lv = [v.x + w.y * rz - w.z * ry, v.y + w.z * rx - w.x * rz, v.z + w.x * ry - w.y * rx];
            const av = [w.x, w.y, w.z];
            if(point && spread) {
                let dx = c[0] - point[0], dy = c[1] - point[1], dz = c[2] - point[2];
                const l = Math.hypot(dx, dy, dz) || 1;
                const k = spread * (0.5 + Math.random() * 0.7) / l;
                lv[0] += dx * k; lv[1] += dy * k + spread * 0.25; lv[2] += dz * k;
                for(let a = 0; a < 3; a++) av[a] += (Math.random() - 0.5) * spread * 0.6;
            }
            const kid = this.add(p, { origin: o, rotation: rot, linvel: lv, angvel: av, generation, userData: { ...held }, waitKeys: vb.waitKeys, sibling: pieces.length > 1 ? sibling : 0, prep: p.prep || null });
            this.soft.inherit(kid, vb, [p.offset[0] * VOXEL, p.offset[1] * VOXEL, p.offset[2] * VOXEL]);
            kids.push(kid);
        }
        // keep showing the old mesh until the pieces have theirs (a frame or two)
        const ghost = { vb, t: 0 };
        this.ghosts.push(ghost);
        Promise.all(kids.map(k => k.meshed)).then(() => { ghost.done = true; });
        return { removed, bodies: kids };
    }

    /** Bodies in play over the cap (0 = empty, 1 = at the cap). */
    pressure() { let n = 0; for(const vb of this.list) if(!vb.stamping) n++; return n / this.maxBodies; }
    /** Pieces smaller than this (samples) become dust; grows as the body count nears the cap. */
    debrisMin() { const p = this.pressure(); return p > 0.6 ? Math.round(DEBRIS * (1 + (p - 0.6) * 8)) : DEBRIS; }

    // ------------------------------------------------------------ fracture

    /** The soft lattice of `vb` came apart (a SoftBodies split): break the body along it (a 'frac' job). */
    crack(vb, split) {
        if(this.breaks.has(vb) || vb.dead || !this.list.has(vb)) return;
        this.stats.cracked = (this.stats.cracked || 0) + 1;
        this.breaks.set(vb, [vb.toWorld(split.at || vb.frame), 0, split]);
    }

    /** Velocity change (m/s) a body takes before breaking. */
    breakDv(vb) {
        const hard = MATERIALS[vb.mat]?.hardness ?? 1;
        const massT = Math.max(0.2, vb.mass / 1000);
        return this.breakScale * 6.5 * Math.sqrt(Math.min(hard, 6)) * Math.pow(massT, -0.12) * (1 + 0.4 * vb.generation);
    }

    fracture(vb, point, dv) {
        const t0 = performance.now();
        const g = vb.grid;
        if(this.debug) console.log(`fracture n=${g.count} gen=${vb.generation} age=${vb.age.toFixed(2)} dv=${dv.toFixed(1)} break=${this.breakDv(vb).toFixed(1)} mass=${(vb.mass/1000).toFixed(1)}t`);
        const energy = Math.min(4, dv / this.breakDv(vb));
        const crowd = Math.max(0.35, Math.min(1, 1.3 - this.pressure()));
        const n = Math.max(2, Math.min(14, Math.round((1 + energy * 2 + Math.log2(1 + vb.volume)) * crowd)));
        const labels = voronoiLabels(g, vb.toLocal(point), n);
        const dust = new Float64Array(256);
        const pieces = splitGrid(g, labels, { minCount: this.debrisMin(), dust });
        const { removed } = this.replace(vb, pieces, { point, spread: Math.min(8, 1.5 + dv * 0.15), generation: vb.generation + 1 });
        for(let i = 0; i < 256; i++) removed[i] += dust[i];
        this.stats.fractured++;
        this.stats.lastFractureMs = performance.now() - t0;
        this._dust(point, removed, 'impact', vb);
    }

    /** Emit 'destroyed' for pulverized material. */
    _dust(point, removed, kind, vb = null) {
        let volume = 0;
        for(let i = 0; i < 256; i++) volume += removed[i];
        if(volume <= 0) return;
        this.stats.pulverized += volume;
        const r = Math.max(0.5, Math.cbrt(volume));
        const box = [point.map(v => v - r), point.map(v => v + r)];
        this.events.dispatchEvent(new CustomEvent('destroyed', { detail: { center: [...point], box, removed, volume, author: null, kind, prop: vb?.prop ?? null } }));
    }

    _contact(c1, c2, f) {
        const p1 = this.physics.propOf(c1), p2 = this.physics.propOf(c2);
        const a = p1?.userData?.voxelBody, b = p2?.userData?.voxelBody;
        if(a) this._hit(a, f, c1, c2);
        if(b) this._hit(b, f, c2, c1);
    }
    _hit(vb, f, c, o) {
        let h = this.hits.get(vb);
        if(!h) this.hits.set(vb, h = { f: 0, fmax: 0, c, o });
        h.f += f;
        if(f > h.fmax) { h.fmax = f; h.c = c; h.o = o; }
    }
    _contactPoint(vb, c, o) {
        let p = null;
        // a collider removed since the step would panic inside Rapier (not catchable: it poisons the whole module)
        if(c?.isValid() && o?.isValid()) try {
            this.physics.rw.contactPair(c, o, (m) => {
                if(p) return;
                if(m.numSolverContacts() > 0) { const s = m.solverContactPoint(0); p = [s.x, s.y, s.z]; }
            });
        } catch(e) { /* a collider may be gone */ }
        if(p) return p;
        const t = vb.body.translation();
        return [t.x, t.y - vb.radius * 0.5, t.z];
    }

    // ------------------------------------------------------------ per step

    _step(h) {
        // impacts and fracture
        if(this.hits.size) {
            for(const [vb, hit] of this.hits) {
                if(vb.dead || !this.list.has(vb)) continue;
                const b = vb.body;
                if(!b.isDynamic() || vb.prop.userData.held) continue;
                // velocity change: the contact force's (dv = F h / m) and the body's measured one, whichever is
                // smaller (forces spike while Rapier pushes overlapping shapes apart; kicks change velocity without contact)
                const v = b.linvel(), p = vb.prevV;
                const dx = v.x - p[0], dy = v.y - p[1] + GRAVITY * h, dz = v.z - p[2];
                const dvV = Math.hypot(dx, dy, dz);
                const dv = Math.min(hit.f * h / Math.max(1, b.mass()), dvV);
                if(dv < Math.min(SOFT_DV, this.impactDv)) continue;
                const point = this._contactPoint(vb, hit.c, hit.o);
                const brk = this.breakDv(vb), energy = dv / brk;
                // the soft layer: matter away from the contact keeps going (a crack attempt when hit hard enough)
                const sc = dv / (dvV || 1);
                this.soft.impact(vb, point, [dx * sc, dy * sc, dz * sc], energy > 1 ? energy * 1.3 : 1);
                if(dv < this.impactDv) continue;
                if(vb.cool <= 0) {
                    vb.cool = 0.12;
                    this.events.dispatchEvent(new CustomEvent('impact', { detail: { point, speed: dv, mat: vb.mat, prop: vb.prop } }));
                }
                if(vb.age > 0.2 && vb.grid.count >= MIN_FRACTURE && dv > brk) {
                    // under SHATTER: let the soft lattice crack it (crack()), with a Voronoi fallback if it holds
                    const soft = this.soft.enabled && energy < SHATTER && vb.softRec?.state !== 'dead';
                    if(soft) { if(!vb.crackWait || vb.crackWait.dv < dv) vb.crackWait = { t: vb.age, point, dv, energy }; }
                    else {
                        // no soft layer (off, or too big for one): cleave into a few pieces; only extreme hits shatter
                        const q = this.breaks.get(vb);
                        if(!q || q[1] < dv) this.breaks.set(vb, [point, dv, null, energy < SHATTER ? Math.min(CLEAVE, 2 + Math.floor(energy / 4)) : 0]);
                    }
                }
            }
            this.hits.clear();
        }
        // lifecycle
        const { min, max } = this.bounds;
        for(const vb of this.list) {
            if(vb.dead || !this.physics.props.has(vb.prop)) { if(!vb.dead) { vb.dead = true; vb.disposeMesh(); } this.list.delete(vb); continue; }
            vb.age += h; vb.cool -= h;
            if(vb.sibling && vb.age > 0.3) vb.touchSiblings();
            if(vb.waitKeys) {
                vb.waitT += h;
                const pool = this.pool;
                if(vb.waitT > 1.5 || (!vb.waitRemote && !vb.waitKeys.some(k => pool.queue.has(k) || pool.inflight.has(k) || this.physics.colliderPending(k)))) vb.touchTerrain();
            }
            if(vb.stamping) { if(vb.stampKeys) this._finishStamp(vb, h); continue; }
            const cw = vb.crackWait;
            if(cw && vb.age - cw.t > CRACK_WAIT) {
                vb.crackWait = null;
                // the lattice held: a hit far over the threshold shatters it after all
                if(cw.energy >= CRACK_FALLBACK && !vb.fracturing && vb.softRec?.state !== 'split' && !this.breaks.has(vb))
                    this.breaks.set(vb, [cw.point, cw.dv, null, Math.min(CLEAVE, 2 + Math.floor(cw.energy / 4))]);
            }
            const b = vb.body;
            const lv = b.linvel(); vb.prevV[0] = lv.x; vb.prevV[1] = lv.y; vb.prevV[2] = lv.z;
            if(!b.isDynamic() || vb.prop.userData.held) { vb.still = 0; continue; }
            const t = b.translation();
            if(t.y < min[1] || t.x < min[0] || t.z < min[2] || t.x > max[0] || t.z > max[2] || t.y > max[1] + 50) { vb.dispose(); this.list.delete(vb); continue; }
            if(b.isSleeping()) vb.still += h;
            else {
                const v = b.linvel(), w = b.angvel();
                // slow bodies get heavy damping so they come to rest (and sleep) soon instead of jittering on the
                // terrain: resting contacts are what the physics step spends its time on
                const slow = vb.age > 0.4 && v.x * v.x + v.y * v.y + v.z * v.z < 4 && w.x * w.x + w.y * w.y + w.z * w.z < 4;
                if(slow !== !!vb.damped) { vb.damped = slow; b.setLinearDamping(slow ? 0.6 : 0.02); b.setAngularDamping(slow ? 2 : 0.15); }
                // barely moving counts too (bodies woken by a terrain remesh nearby settle again at once)
                if(v.x * v.x + v.y * v.y + v.z * v.z < 0.25 && w.x * w.x + w.y * w.y + w.z * w.z < 0.25) vb.still += h;
                else vb.still = Math.max(0, vb.still - h * 4);
            }
            if(vb.still > SETTLE || (vb.age > 25 && vb.still > 0.5)) this.stamp(vb);
        }
        // budget: over the cap, stamp the stillest bodies, then pulverize the smallest moving ones
        let over = Math.round((this.pressure() - 1) * this.maxBodies);
        if(over > 0) {
            const cands = [...this.list].filter(vb => !vb.stamping && !vb.dead && vb.body.isDynamic() && !vb.prop.userData.held);
            cands.sort((a, b) => b.still - a.still);
            for(const vb of cands) { if(over <= 0 || vb.still < 0.3) break; this.stamp(vb); over--; }
            if(over > 0) {
                cands.sort((a, b) => a.grid.count - b.grid.count);
                for(const vb of cands) {
                    if(over <= 0 || vb.grid.count > 250) break;
                    if(vb.stamping || vb.dead) continue;
                    const t = vb.body.translation();
                    this._dust([t.x, t.y, t.z], vb.stats.volumes, 'impact', vb);
                    vb.dispose(); this.list.delete(vb); over--;
                }
            }
        }
        // ghosts of broken bodies
        for(let i = this.ghosts.length - 1; i >= 0; i--) {
            const g = this.ghosts[i];
            g.t += h;
            if(g.done || g.t > 0.5) { g.vb.disposeMesh(); this.ghosts.splice(i, 1); }
        }
    }

    /** Union a body into the terrain at its pose (a background job); it is removed once the terrain there has been
     *  remeshed and has its new colliders. */
    stamp(vb) {
        if(vb.stamping || vb.dead || vb.fracturing) return;
        this.stats.stamped++;
        this.soft.gridChanged(vb); // stamped as built: no more wobble
        vb.body.setBodyType(this.physics.R.RigidBodyType.Fixed, false);
        vb.stamping = true;
        vb.stampKeys = null;
        const remote = this.world.remote;
        if(remote) {
            remote.stamp(vb.grid, vb.gridOrigin(), vb.rotation()).then(rep => { vb.stampKeys = rep.dirty; vb.stampT = 0; }, () => { vb.stampKeys = []; vb.stampT = 0; });
            return;
        }
        this.jobs.push({ kind: 'stamp', vb, gen: stampJob(this.world, vb.grid, vb.gridOrigin(), vb.rotation(), 4096) });
    }
    _finishStamp(vb, h) {
        vb.stampT += h;
        const pool = this.pool;
        const pending = vb.stampKeys.some(k => pool.queue.has(k) || pool.inflight.has(k) || this.physics.colliderPending(k));
        if(pending && vb.stampT < 2) return;
        vb.dispose();
        this.list.delete(vb);
    }

    /** Stamp every body now (e.g. before a level reset or a save). */
    settleAll() { for(const vb of [...this.list]) if(!vb.dead && vb.body.isDynamic()) this.stamp(vb); }
}
