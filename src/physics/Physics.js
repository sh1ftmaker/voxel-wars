/**
 * Rigid body physics (Rapier). Owns the Rapier world, the terrain's static colliders (one trimesh per chunk, rebuilt
 * from each new chunk mesh), dynamic props, and a fixed 60 Hz step.
 *
 * Public API (other modules depend on these signatures; extend, don't break):
 *   await Physics.create(ctx)                      ctx: { world: VoxelWorld, terrain: TerrainRenderer, scene }
 *   physics.R                                      the RAPIER module
 *   physics.rw                                     the RAPIER.World
 *   physics.step(dt)                               advance (fixed substeps); call once per frame
 *   physics.addBody({ shape, size, position, velocity, angularVelocity, density, friction, restitution, mesh, userData, ccd })
 *        shape 'box' (size = half extents [x,y,z]) | 'sphere' (size = radius) | 'capsule' (size = [halfHeight, radius])
 *        returns a Prop { body, collider, mesh, userData }; `mesh` (THREE.Object3D, optional) follows the body
 *   physics.removeBody(prop)
 *   physics.raycast(origin, dir, maxDist, { exclude }) -> { point, normal, distance, collider, prop|null } | null
 *   physics.explode(center, radius, strength)      radial velocity change on dynamic bodies, falling off with distance
 *   physics.propOf(collider)                       the Prop owning a collider (null for terrain)
 *   physics.onStep(fn)                             fn(h) after every fixed substep
 *
 * Additions (physics agent):
 *   physics.addProp({ body, colliders, mesh, userData }) -> Prop   register a body built directly with Rapier
 *        (several colliders allowed: prop.collider is the first, prop.colliders all of them)
 *   physics.attachCollider(prop, colliderDesc) -> collider / physics.detachColliders(prop)   rebuild a prop's shape
 *   physics.onContactForce(fn)                     fn(collider1, collider2, totalForce (N), maxForceDirection) for
 *        contacts above a collider's contact force event threshold, after every substep
 *   physics.onFrame(fn)                            fn(dt) once per frame after the substeps (budgeted background work)
 *   physics.colliderPending(key), flushColliders() terrain colliders are rebuilt under a per-frame budget
 *        (colliderBudgetMs); prop meshes are interpolated between fixed steps (physics.interpolate)
 *   physics.stepMs, physics.stepMsMax              smoothed and recent peak cost of step() per frame (ms)
 *   physics.voxelBodies                            the VoxelBodies manager (src/physics/VoxelBodies.js), set by Destruction
 *   Voxel bodies (detached terrain, src/voxel/VoxelBody.js) are Props with userData.voxelBody; their body origin is
 *   their centre of mass.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { CHUNK_M } from '../config.js';

const REMOVED_BODY = new Proxy({}, { get: (_, k) => k === 'isValid' ? () => false : k === 'handle' ? -1 : () => { throw new Error(`physics: ${String(k)}() on a removed body`); } });

export const GRAVITY = 30; // m/s²: real gravity reads as slow motion at this scale (WorldParty's DEFAULT_BODY_GRAVITY)
export const STEP = 1 / 60;
/** Collision groups ((memberships << 16) | filter): terrain colliders are in group 0; GROUPS_NO_TERRAIN collides
 *  with everything but the terrain (bodies whose terrain chunks are still being remeshed use it). */
export const GROUPS_TERRAIN = (0x0001 << 16) | 0xffff;
export const GROUPS_NO_TERRAIN = (0x0002 << 16) | 0xfffe;
export const GROUPS_ALL = 0xffffffff;

export class Physics {
    static async create(ctx) {
        await RAPIER.init();
        Physics.warmup();
        return new Physics(ctx);
    }
    /**
     * Run Rapier's contact code once on a scratch world: the browser compiles wasm functions lazily, so the first
     * compound body landing on the terrain trimeshes in play cost a ~12 ms step (compiling cuboid-trimesh manifolds,
     * CCD, contact force events). Here it costs ~20 ms during loading instead.
     */
    static warmup() {
        const t0 = performance.now();
        const R = RAPIER, rw = new R.World({ x: 0, y: -GRAVITY, z: 0 });
        rw.timestep = STEP;
        const q = new R.EventQueue(true);
        // a bumpy 8 x 8 m trimesh floor
        const n = 9, v = new Float32Array(n * n * 3), idx = [];
        for(let z = 0; z < n; z++) for(let x = 0; x < n; x++) { const i = (x + z * n) * 3; v[i] = x - 4; v[i + 1] = ((x * 7 + z * 3) % 5) * 0.08; v[i + 2] = z - 4; }
        for(let z = 0; z < n - 1; z++) for(let x = 0; x < n - 1; x++) { const a = x + z * n; idx.push(a, a + n, a + 1, a + 1, a + n, a + n + 1); }
        rw.createCollider(R.ColliderDesc.trimesh(v, new Uint32Array(idx)).setCollisionGroups(GROUPS_TERRAIN));
        const bodies = [];
        for(let k = 0; k < 4; k++) {
            const b = rw.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(-2 + k * 1.3, 1.2 + k * 0.4, 0).setCcdEnabled(k !== 3).setLinvel(0, -12, 0).setAngvel({ x: 1, y: 2, z: 0.5 }));
            const ev = (d) => d.setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(10).setCollisionGroups(GROUPS_ALL);
            if(k === 0) for(let i = 0; i < 4; i++) rw.createCollider(ev(R.ColliderDesc.cuboid(0.3, 0.2, 0.25).setTranslation(i * 0.3 - 0.45, (i & 1) * 0.3, 0)), b);
            else if(k === 1) rw.createCollider(ev(R.ColliderDesc.convexHull(new Float32Array([0, 0, 0, 0.6, 0, 0, 0, 0.6, 0, 0, 0, 0.6, 0.5, 0.5, 0.5]))), b);
            else if(k === 2) rw.createCollider(ev(R.ColliderDesc.ball(0.35)), b);
            else rw.createCollider(ev(R.ColliderDesc.capsule(0.4, 0.3)), b);
            bodies.push(b);
        }
        for(let i = 0; i < 45; i++) {
            rw.step(q);
            q.drainContactForceEvents(e => { e.totalForceMagnitude(); e.maxForceDirection(); });
            if(i === 20) for(const b of bodies) { b.setLinvel({ x: 3, y: 6, z: -2 }, true); for(let c = 0; c < b.numColliders(); c++) b.collider(c).setCollisionGroups(GROUPS_NO_TERRAIN); }
            if(i === 30) for(const b of bodies) for(let c = 0; c < b.numColliders(); c++) b.collider(c).setCollisionGroups(GROUPS_ALL);
        }
        const ray = new R.Ray({ x: 0, y: 5, z: 0 }, { x: 0, y: -1, z: 0 });
        rw.castRayAndGetNormal(ray, 10, true);
        q.free(); rw.free();
        Physics.warmupMs = performance.now() - t0;
    }
    constructor({ world, terrain, scene }) {
        this.R = RAPIER;
        this.world = world;
        this.scene = scene;
        this.rw = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
        this.rw.timestep = STEP;
        // 2 solver iterations instead of Rapier's 4: debris resting on the terrain trimeshes is most of a step's cost and
        // settles as well (tools/test/fracturecost.mjs: ~40% cheaper steps)
        this.rw.integrationParameters.numSolverIterations = 2;
        this.terrainColliders = new Map(); // chunk key -> 8 octant slots { hash, collider } | null
        this.terrainBody = this.rw.createRigidBody(RAPIER.RigidBodyDesc.fixed());
        this.props = new Set();
        this.byCollider = new Map(); // collider handle -> prop
        this.stepListeners = [];
        this.contactListeners = [];
        this.eventQueue = new RAPIER.EventQueue(true);
        this.acc = 0;
        this.stepMs = 0; this.stepMsMax = 0;
        this.frameListeners = [];
        // terrain colliders are rebuilt from new chunk meshes under a per-frame time budget (a trimesh build costs
        // ~0.5 ms, and a blast remeshes a dozen chunks or more)
        this.pendingColliders = new Map(); // chunk key -> geometry | null, oldest first
        this.colliderBudgetMs = 0.8;
        this.interpolate = true;
        terrain.onChunkMesh((key, geometry) => this.pendingColliders.set(key, geometry));
    }

    /**
     * Replace a chunk's static colliders from its new render geometry (null removes them). A chunk is collided as 8
     * trimeshes, one per octant (4 m cube; a triangle goes to the octant of its centroid), and only the octants whose
     * triangles changed are rebuilt: an edit usually touches a few, and a trimesh build costs ~0.3 ms per 1000
     * triangles. Colliders are parentless (static): attached to one shared fixed body, every replacement made
     * Rapier's next step re-process all terrain colliders (~18 ms); without a parent it stays ~0.1 ms.
     */
    setChunkCollider(key, geometry, deadline = Infinity) {
        let slots = this.terrainColliders.get(key);
        if(!slots) this.terrainColliders.set(key, slots = new Array(8).fill(null));
        const c = this.world.chunks.get(key);
        const ox = c.cx * CHUNK_M, oy = c.cy * CHUNK_M, oz = c.cz * CHUNK_M, H = CHUNK_M / 2;
        const changed = [];
        if(!geometry) {
            for(let o = 0; o < 8; o++) if(slots[o]) { this.rw.removeCollider(slots[o].collider, false); slots[o] = null; changed.push(o); }
        } else if(geometry.userData?.octants) {
            // octant arrays and hashes made by the mesh worker (src/voxel/meshPrep.js): only the Rapier builds here
            const octs = geometry.userData.octants;
            for(let o = 0; o < 8; o++) {
                const old = slots[o], d = octs[o];
                if(!d) { if(old) { this.rw.removeCollider(old.collider, false); slots[o] = null; changed.push(o); } continue; }
                if(old && old.hash === d.hash) continue;
                if(old) this.rw.removeCollider(old.collider, false);
                const desc = RAPIER.ColliderDesc.trimesh(d.vtx, d.ind).setFriction(0.9).setCollisionGroups(GROUPS_TERRAIN);
                slots[o] = { hash: d.hash, collider: this.rw.createCollider(desc) };
                changed.push(o);
                if(o < 7 && performance.now() > deadline) { this.pendingColliders.set(key, geometry); break; }
            }
        } else {
            const pos = geometry.attributes.position.array, idx = geometry.index.array;
            const nt = idx.length / 3, nv = pos.length / 3;
            // octant of every triangle, and triangle counts per octant
            const oct = new Uint8Array(nt), count = new Int32Array(8);
            for(let t = 0; t < nt; t++) {
                const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, d = idx[t * 3 + 2] * 3;
                const o = ((pos[a] + pos[b] + pos[d]) >= 3 * H ? 1 : 0) | ((pos[a + 1] + pos[b + 1] + pos[d + 1]) >= 3 * H ? 2 : 0) | ((pos[a + 2] + pos[b + 2] + pos[d + 2]) >= 3 * H ? 4 : 0);
                oct[t] = o; count[o]++;
            }
            const remap = new Int32Array(nv), stamp = new Int32Array(nv);
            for(let o = 0; o < 8; o++) {
                const old = slots[o];
                if(!count[o]) { if(old) { this.rw.removeCollider(old.collider, false); slots[o] = null; changed.push(o); } continue; }
                // the octant's own vertex and index arrays (world space), and a hash of them
                const ind = new Uint32Array(count[o] * 3);
                const vtx = [];
                let ni = 0, vn = 0, h = 0x811c9dc5 ^ count[o];
                for(let t = 0; t < nt; t++) {
                    if(oct[t] !== o) continue;
                    for(let k = 0; k < 3; k++) {
                        const v = idx[t * 3 + k];
                        if(stamp[v] !== o + 1) {
                            stamp[v] = o + 1; remap[v] = vn++;
                            const x = pos[v * 3] + ox, y = pos[v * 3 + 1] + oy, z = pos[v * 3 + 2] + oz;
                            vtx.push(x, y, z);
                            h = Math.imul(h ^ Math.round(x * 4096), 16777619); h = Math.imul(h ^ Math.round(y * 4096), 16777619); h = Math.imul(h ^ Math.round(z * 4096), 16777619);
                        }
                        ind[ni++] = remap[v];
                        h = Math.imul(h ^ remap[v], 16777619);
                    }
                }
                if(old && old.hash === h) continue;
                if(old) this.rw.removeCollider(old.collider, false);
                const desc = RAPIER.ColliderDesc.trimesh(new Float32Array(vtx), ind).setFriction(0.9).setCollisionGroups(GROUPS_TERRAIN);
                slots[o] = { hash: h, collider: this.rw.createCollider(desc) };
                changed.push(o);
                // out of time: the rest of this chunk goes back in the queue (unchanged octants are skipped then)
                if(o < 7 && performance.now() > deadline) { this.pendingColliders.set(key, geometry); break; }
            }
        }
        if(!changed.length) return;
        // bodies resting on a changed octant must notice the change
        const m = 3;
        for(const p of this.props) {
            if(!p.body.isSleeping()) continue;
            const t = p.body.translation();
            for(const o of changed) {
                const x0 = ox + (o & 1 ? H : 0), y0 = oy + (o & 2 ? H : 0), z0 = oz + (o & 4 ? H : 0);
                if(t.x > x0 - m && t.x < x0 + H + m && t.y > y0 - m && t.y < y0 + H + m && t.z > z0 - m && t.z < z0 + H + m) { p.body.wakeUp(); break; }
            }
        }
    }

    addBody({ shape = 'box', size = [0.5, 0.5, 0.5], position = [0, 0, 0], quaternion, velocity, angularVelocity, density = 1000, friction = 0.7, restitution = 0.1, mesh = null, userData = {}, ccd = true, kinematic = false } = {}) {
        const R = RAPIER;
        const bd = (kinematic ? R.RigidBodyDesc.kinematicPositionBased() : R.RigidBodyDesc.dynamic()).setTranslation(...position).setCcdEnabled(ccd);
        if(quaternion) bd.setRotation({ x: quaternion[0], y: quaternion[1], z: quaternion[2], w: quaternion[3] });
        if(velocity) bd.setLinvel(...velocity);
        if(angularVelocity) bd.setAngvel({ x: angularVelocity[0], y: angularVelocity[1], z: angularVelocity[2] });
        const body = this.rw.createRigidBody(bd);
        const cd = shape === 'sphere' ? R.ColliderDesc.ball(size)
            : shape === 'capsule' ? R.ColliderDesc.capsule(size[0], size[1])
            : R.ColliderDesc.cuboid(size[0], size[1], size[2]);
        cd.setDensity(density).setFriction(friction).setRestitution(restitution);
        const collider = this.rw.createCollider(cd, body);
        const prop = { body, collider, mesh, userData };
        this.props.add(prop);
        this.byCollider.set(collider.handle, prop);
        if(mesh) { mesh.matrixAutoUpdate = true; this.scene.add(mesh); }
        return prop;
    }
    addProp({ body, colliders = [], mesh = null, userData = {} }) {
        const prop = { body, collider: colliders[0] || null, colliders: [...colliders], mesh, userData };
        this.props.add(prop);
        for(const c of colliders) this.byCollider.set(c.handle, prop);
        if(mesh) { mesh.matrixAutoUpdate = true; this.scene.add(mesh); }
        return prop;
    }
    attachCollider(prop, desc) {
        const c = this.rw.createCollider(desc, prop.body);
        (prop.colliders ||= [prop.collider]).push(c);
        if(!prop.collider) prop.collider = c;
        this.byCollider.set(c.handle, prop);
        return c;
    }
    detachColliders(prop) {
        for(const c of prop.colliders || [prop.collider]) { if(!c) continue; this.byCollider.delete(c.handle); this.rw.removeCollider(c, false); }
        prop.colliders = []; prop.collider = null;
    }
    onContactForce(fn) { this.contactListeners.push(fn); }
    /** fn(dt) once per frame at the end of step() (after the fixed substeps), for budgeted background work. */
    onFrame(fn) { this.frameListeners.push(fn); }
    /** True while a chunk's new terrain collider is waiting to be built. */
    colliderPending(key) { return this.pendingColliders.has(key); }
    /** Build pending terrain colliders now (e.g. after loading, before play starts). */
    flushColliders() { for(const [k, g] of this.pendingColliders) this.setChunkCollider(k, g); this.pendingColliders.clear(); }

    removeBody(prop) {
        if(!this.props.delete(prop)) return;
        for(const c of prop.colliders || []) if(c) this.byCollider.delete(c.handle);
        if(prop.collider) this.byCollider.delete(prop.collider.handle);
        this.rw.removeRigidBody(prop.body);
        if(prop.mesh) prop.mesh.removeFromParent();
        // any later use of the removed body would be a Rust panic that poisons Rapier for good ("recursive use of an
        // object" on every step after it); make it an ordinary, catchable JS error instead
        prop.removed = true;
        prop.body = REMOVED_BODY;
        if(prop.collider) prop.collider = REMOVED_BODY;
    }
    propOf(collider) { return collider ? this.byCollider.get(collider.handle) || null : null; }

    raycast(origin, dir, maxDist = 100, { exclude } = {}) {
        const ray = new RAPIER.Ray({ x: origin[0], y: origin[1], z: origin[2] }, { x: dir[0], y: dir[1], z: dir[2] });
        const hit = this.rw.castRayAndGetNormal(ray, maxDist, true, undefined, undefined, undefined, exclude?.body ?? exclude);
        if(!hit) return null;
        const t = hit.timeOfImpact;
        return { point: [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t], normal: [hit.normal.x, hit.normal.y, hit.normal.z], distance: t, collider: hit.collider, prop: this.propOf(hit.collider) };
    }

    explode(center, radius, strength) {
        for(const p of this.props) {
            if(!p.body.isDynamic()) continue;
            if(p.userData?.voxelBody) { p.userData.voxelBody.explode(center, radius, strength); continue; }
            const t = p.body.translation();
            const dx = t.x - center[0], dy = t.y - center[1], dz = t.z - center[2];
            const d = Math.hypot(dx, dy, dz);
            if(d > radius) continue;
            const k = strength * (1 - d / radius) / Math.max(d, 0.3);
            const v = p.body.linvel();
            p.body.setLinvel({ x: v.x + dx * k, y: v.y + dy * k + strength * 0.3 * (1 - d / radius), z: v.z + dz * k }, true);
            const a = p.body.angvel();
            p.body.setAngvel({ x: a.x + (Math.random() - 0.5) * strength * 0.5, y: a.y + (Math.random() - 0.5) * strength * 0.5, z: a.z + (Math.random() - 0.5) * strength * 0.5 }, true);
        }
    }

    onStep(fn) { this.stepListeners.push(fn); }

    step(dt) {
        const t0 = performance.now();
        this.acc = Math.min(this.acc + dt, STEP * 4);
        // the first step builds every collider queued while loading; later ones go oldest first, at least one per frame
        if(!this.started) { this.started = true; this.flushColliders(); }
        if(this.pendingColliders.size) {
            const end = t0 + this.colliderBudgetMs;
            for(const [k, g] of this.pendingColliders) {
                this.pendingColliders.delete(k);
                this.setChunkCollider(k, g, end);
                if(performance.now() > end) break;
            }
        }
        const interp = this.interpolate;
        while(this.acc >= STEP) {
            if(interp) for(const p of this.props) {
                if(!p.mesh) continue;
                const t = p.body.translation(), r = p.body.rotation();
                const q = p._prev || (p._prev = new Float64Array(7));
                q[0] = t.x; q[1] = t.y; q[2] = t.z; q[3] = r.x; q[4] = r.y; q[5] = r.z; q[6] = r.w;
            }
            this.rw.step(this.eventQueue);
            if(this.contactListeners.length) this.eventQueue.drainContactForceEvents(e => {
                const c1 = this.rw.getCollider(e.collider1()), c2 = this.rw.getCollider(e.collider2());
                const f = e.totalForceMagnitude(), d = e.maxForceDirection();
                // a throw inside Rapier's drain callback would leave the event queue borrowed and fail every later step
                for(const fn of this.contactListeners) try { fn(c1, c2, f, d); } catch(err) { console.error(err); }
            });
            else this.eventQueue.clear();
            for(const fn of this.stepListeners) fn(STEP);
            this.acc -= STEP;
        }
        for(const fn of this.frameListeners) fn(dt);
        // meshes follow their bodies, interpolated between the last two fixed steps (smooth at any frame rate)
        const a = this.acc / STEP;
        for(const p of this.props) {
            if(!p.mesh) continue;
            const t = p.body.translation(), r = p.body.rotation(), q = p._prev;
            if(!interp || !q) { p.mesh.position.set(t.x, t.y, t.z); p.mesh.quaternion.set(r.x, r.y, r.z, r.w); continue; }
            const b = 1 - a;
            p.mesh.position.set(q[0] * b + t.x * a, q[1] * b + t.y * a, q[2] * b + t.z * a);
            const s = q[3] * r.x + q[4] * r.y + q[5] * r.z + q[6] * r.w < 0 ? -a : a; // shortest arc
            const x = q[3] * b + r.x * s, y = q[4] * b + r.y * s, z = q[5] * b + r.z * s, w = q[6] * b + r.w * s;
            const l = 1 / (Math.hypot(x, y, z, w) || 1);
            p.mesh.quaternion.set(x * l, y * l, z * l, w * l);
        }
        const ms = performance.now() - t0;
        this.stepMs = this.stepMs * 0.95 + ms * 0.05; // smoothed cost of physics.step per frame (ms)
        this.stepMsMax = Math.max(this.stepMsMax * 0.995, ms);
    }
}
