/**
 * Rigid body physics (box3d, src/physics/box3d/B3.js). Owns the box3d world, the terrain's static colliders (one
 * triangle mesh per chunk octant, rebuilt from each new chunk mesh), dynamic props, and a fixed 60 Hz step.
 *
 * Public API (other modules depend on these signatures; extend, don't break):
 *   await Physics.create(ctx)                      ctx: { world: VoxelWorld, terrain: TerrainRenderer, scene }
 *   physics.b3                                     the B3World; BodyType (exported here too) for setBodyType
 *   physics.step(dt)                               advance (fixed substeps); call once per frame
 *   physics.addBody({ shape, size, position, velocity, angularVelocity, density, friction, restitution, mesh, userData, bullet, kinematic })
 *        shape 'box' (size = half extents [x,y,z]) | 'sphere' (size = radius) | 'capsule' (size = [halfHeight, radius])
 *        returns a Prop { body, collider, mesh, userData }; `mesh` (THREE.Object3D, optional) follows the body
 *   physics.removeBody(prop)
 *   physics.raycast(origin, dir, maxDist, { exclude, ignore }) -> { point, normal, distance, collider, prop|null } | null
 *        exclude: a body, collider or prop to skip; ignore: collider handles (or bodies) to skip
 *   physics.explode(center, radius, strength)      radial velocity change on dynamic bodies, falling off with distance
 *   physics.propOf(collider)                       the Prop owning a collider (null for terrain)
 *   physics.onStep(fn)                             fn(h) after every fixed substep
 *
 * Bodies (B3Body) keep the method names the game was written against: translation(), rotation(), linvel(),
 * setLinvel(v, wake), applyImpulse(j, wake), isDynamic(), isSleeping(), wakeUp(), setBodyType(BodyType.X, wake),
 * setNextKinematicTranslation(t), ... A call on a removed body or collider does nothing (handles are checked in C).
 *
 * Additions:
 *   physics.createBody({ type, position, rotation, linvel, angvel, linearDamping, angularDamping, bullet, enabled })
 *   physics.addProp({ body, colliders, mesh, userData }) -> Prop   register a body made with createBody
 *        (several colliders allowed: prop.collider is the first, prop.colliders all of them)
 *   physics.attachCollider(prop, spec) -> collider / physics.detachColliders(prop)   rebuild a prop's shape;
 *        spec { shape: 'box', half, center } | { shape: 'hull', points } | { shape: 'sphere', radius, center } with
 *        { density, friction, restitution, groups, hitEvents }
 *   physics.onHit(fn)                              fn(collider1, collider2, approachSpeed (m/s), point, normal) for
 *        contacts that begin faster than the hit threshold between colliders with hitEvents, after every substep
 *   physics.onFrame(fn)                            fn(dt) once per frame after the substeps (budgeted background work)
 *   physics.colliderPending(key), flushColliders() terrain colliders are rebuilt under a per-frame budget
 *        (colliderBudgetMs); prop meshes are interpolated between fixed steps (physics.interpolate)
 *   physics.stepMs, physics.stepMsMax              smoothed and recent peak cost of step() per frame (ms)
 *   physics.voxelBodies                            the VoxelBodies manager (src/physics/VoxelBodies.js), set by Destruction
 *   Voxel bodies (detached terrain, src/voxel/VoxelBody.js) are Props with userData.voxelBody; their body origin is
 *   their centre of mass.
 *
 * Determinism (for lockstep debris later): box3d gives bit-identical results everywhere for the same sequence of
 * calls. Everything here creates bodies and colliders in a deterministic order; explode() and some game code still
 * draw spins from Math.random().
 */
import { CHUNK_M } from '../config.js';
import { loadBox3d, B3World, BodyType } from './box3d/B3.js';

export { BodyType };
export const GRAVITY = 30; // m/s²: real gravity reads as slow motion at this scale (WorldParty's DEFAULT_BODY_GRAVITY)
export const STEP = 1 / 60;
/** Collision groups ((memberships << 16) | filter): terrain colliders are in group 0; GROUPS_NO_TERRAIN collides
 *  with everything but the terrain (bodies whose terrain chunks are still being remeshed use it). */
export const GROUPS_TERRAIN = (0x0001 << 16) | 0xffff;
export const GROUPS_NO_TERRAIN = ((0x0002 << 16) | 0xfffe) >>> 0;
export const GROUPS_ALL = 0xffffffff;
const HIT_THRESHOLD = 1.5; // m/s approach speed for hit events

export class Physics {
    static async create(ctx) {
        const M = await loadBox3d();
        Physics.warmup(M);
        return new Physics(ctx, M);
    }
    /** Run the contact code once on a scratch world (box, hull, sphere and capsule on a bumpy mesh), so the browser
     *  has compiled it before the first blast. */
    static warmup(M) {
        const t0 = performance.now();
        const w = new B3World(M, { gravity: [0, -GRAVITY, 0], hitThreshold: HIT_THRESHOLD });
        const ground = w.createBody({ type: BodyType.Fixed });
        const n = 9, v = new Float32Array(n * n * 3), idx = [];
        for(let z = 0; z < n; z++) for(let x = 0; x < n; x++) { const i = (x + z * n) * 3; v[i] = x - 4; v[i + 1] = ((x * 7 + z * 3) % 5) * 0.08; v[i + 2] = z - 4; }
        for(let z = 0; z < n - 1; z++) for(let x = 0; x < n - 1; x++) { const a = x + z * n; idx.push(a, a + n, a + 1, a + 1, a + n, a + n + 1); }
        w.createMesh(ground, v, new Int32Array(idx), { groups: GROUPS_TERRAIN });
        const bodies = [];
        for(let k = 0; k < 4; k++) {
            const b = w.createBody({ position: [-2 + k * 1.3, 1.2 + k * 0.4, 0], linvel: [0, -12, 0], angvel: [1, 2, 0.5], bullet: k === 2 });
            const o = { hitEvents: true };
            if(k === 0) for(let i = 0; i < 4; i++) w.createBox(b, [0.3, 0.2, 0.25], { ...o, center: [i * 0.3 - 0.45, (i & 1) * 0.3, 0] });
            else if(k === 1) w.createHull(b, new Float32Array([0, 0, 0, 0.6, 0, 0, 0, 0.6, 0, 0, 0, 0.6, 0.5, 0.5, 0.5]), o);
            else if(k === 2) w.createSphere(b, 0.35, o);
            else w.createCapsule(b, 0.4, 0.3, o);
            bodies.push(b);
        }
        const hits = [];
        for(let i = 0; i < 45; i++) {
            hits.length = 0;
            w.step(STEP, hits);
            if(i === 20) for(const b of bodies) { b.setLinvel({ x: 3, y: 6, z: -2 }, true); for(const c of b.colliders) c.setCollisionGroups(GROUPS_NO_TERRAIN); }
            if(i === 30) for(const b of bodies) for(const c of b.colliders) c.setCollisionGroups(GROUPS_ALL);
        }
        w.castRay([0, 5, 0], [0, -1, 0], 10);
        w.move({ x: 0, y: 1.5, z: 0 }, 0.5, 0.4, { x: 0.1, y: -0.2, z: 0 }, { walk: true, snap: 0.5, pushMass: 90, dt: STEP });
        w.free();
        Physics.warmupMs = performance.now() - t0;
    }
    constructor({ world, terrain, scene }, M) {
        this.world = world;
        this.scene = scene;
        this.b3 = new B3World(M, { gravity: [0, -GRAVITY, 0], hitThreshold: HIT_THRESHOLD });
        // overlaps are pushed apart at up to 1 m/s (box3d's default 3 m/s makes pieces jump when the surface under
        // them changes, e.g. a body they rest on is stamped into the terrain)
        M._bw_set_contact_tuning(30, 10, 1);
        this.BodyType = BodyType;
        this.terrainColliders = new Map(); // chunk key -> 8 octant slots { hash, collider } | null
        this.terrainBody = this.b3.createBody({ type: BodyType.Fixed });
        this.props = new Set();
        this.byCollider = new Map(); // collider handle -> prop
        this.stepListeners = [];
        this.hitListeners = [];
        this.hits = [];
        this.acc = 0;
        this.stepMs = 0; this.stepMsMax = 0;
        this.frameListeners = [];
        // terrain colliders are rebuilt from new chunk meshes under a per-frame time budget (a mesh build costs
        // ~0.4 ms, and a blast remeshes a dozen chunks or more)
        this.pendingColliders = new Map(); // chunk key -> geometry | null, oldest first
        this.colliderBudgetMs = 0.8;
        this.interpolate = true;
        terrain.onChunkMesh((key, geometry) => this.pendingColliders.set(key, geometry));
    }

    /**
     * Replace a chunk's static colliders from its new render geometry (null removes them). A chunk is collided as 8
     * meshes, one per octant (4 m cube; a triangle goes to the octant of its centroid), and only the octants whose
     * triangles changed are rebuilt: an edit usually touches a few.
     */
    setChunkCollider(key, geometry, deadline = Infinity) {
        let slots = this.terrainColliders.get(key);
        if(!slots) this.terrainColliders.set(key, slots = new Array(8).fill(null));
        const c = this.world.chunks.get(key);
        const ox = c.cx * CHUNK_M, oy = c.cy * CHUNK_M, oz = c.cz * CHUNK_M, H = CHUNK_M / 2;
        const changed = [];
        const b3 = this.b3, body = this.terrainBody;
        const build = (vtx, ind) => b3.createMesh(body, vtx, ind, { friction: 0.9, groups: GROUPS_TERRAIN });
        if(!geometry) {
            for(let o = 0; o < 8; o++) if(slots[o]) { b3.removeCollider(slots[o].collider); slots[o] = null; changed.push(o); }
        } else if(geometry.userData?.octants) {
            // octant arrays and hashes made by the mesh worker (src/voxel/meshPrep.js): only the box3d builds here
            const octs = geometry.userData.octants;
            for(let o = 0; o < 8; o++) {
                const old = slots[o], d = octs[o];
                if(!d) { if(old) { b3.removeCollider(old.collider); slots[o] = null; changed.push(o); } continue; }
                if(old && old.hash === d.hash) continue;
                if(old) b3.removeCollider(old.collider);
                const col = build(d.vtx, d.ind);
                slots[o] = col ? { hash: d.hash, collider: col } : null;
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
                if(!count[o]) { if(old) { b3.removeCollider(old.collider); slots[o] = null; changed.push(o); } continue; }
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
                if(old) b3.removeCollider(old.collider);
                const col = build(new Float32Array(vtx), ind);
                slots[o] = col ? { hash: h, collider: col } : null;
                changed.push(o);
                // out of time: the rest of this chunk goes back in the queue (unchanged octants are skipped then)
                if(o < 7 && performance.now() > deadline) { this.pendingColliders.set(key, geometry); break; }
            }
        }
        if(!changed.length) return;
        // bodies resting on a changed octant must notice the change
        const m = 3;
        for(const p of this.props) {
            if(!p.body.isSleeping() || !p.body.isDynamic()) continue;
            const t = p.body.translation();
            for(const o of changed) {
                const x0 = ox + (o & 1 ? H : 0), y0 = oy + (o & 2 ? H : 0), z0 = oz + (o & 4 ? H : 0);
                if(t.x > x0 - m && t.x < x0 + H + m && t.y > y0 - m && t.y < y0 + H + m && t.z > z0 - m && t.z < z0 + H + m) { p.body.wakeUp(); break; }
            }
        }
    }

    createBody(opts) { return this.b3.createBody(opts); }

    addBody({ shape = 'box', size = [0.5, 0.5, 0.5], position = [0, 0, 0], quaternion, velocity, angularVelocity, density = 1000, friction = 0.7, restitution = 0.1, mesh = null, userData = {}, bullet = false, kinematic = false } = {}) {
        const b3 = this.b3;
        const body = b3.createBody({ type: kinematic ? BodyType.Kinematic : BodyType.Dynamic, position, rotation: quaternion || [0, 0, 0, 1],
            linvel: velocity || [0, 0, 0], angvel: angularVelocity || [0, 0, 0], bullet });
        const o = { density, friction, restitution };
        const collider = shape === 'sphere' ? b3.createSphere(body, size, o)
            : shape === 'capsule' ? b3.createCapsule(body, size[0], size[1], o)
            : b3.createBox(body, size, o);
        const prop = { body, collider, colliders: [collider], mesh, userData };
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
    attachCollider(prop, { shape = 'box', half, center, points, radius, ...opts }) {
        const b3 = this.b3, body = prop.body;
        const c = shape === 'hull' ? b3.createHull(body, points, opts)
            : shape === 'sphere' ? b3.createSphere(body, radius, { center, ...opts })
            : b3.createBox(body, half, { center, ...opts });
        if(!c) return null;
        (prop.colliders ||= prop.collider ? [prop.collider] : []).push(c);
        if(!prop.collider) prop.collider = c;
        this.byCollider.set(c.handle, prop);
        return c;
    }
    detachColliders(prop) {
        for(const c of prop.colliders || [prop.collider]) { if(!c) continue; this.byCollider.delete(c.handle); this.b3.removeCollider(c, false); }
        prop.colliders = []; prop.collider = null;
    }
    onHit(fn) { this.hitListeners.push(fn); }
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
        this.b3.removeBody(prop.body);
        if(prop.mesh) prop.mesh.removeFromParent();
        prop.removed = true;
    }
    propOf(collider) { return collider ? this.byCollider.get(collider.handle) || null : null; }

    /** Bodies for a query's ignore list from collider handles, colliders, bodies or props. */
    ignoreBodies(list, out = []) {
        out.length = 0;
        if(list) for(const x of list) {
            const c = typeof x === 'number' ? this.b3.colliders.get(x) : x;
            const b = c?.body ?? c;
            if(b && b.handle !== undefined && !out.includes(b)) out.push(b);
        }
        return out;
    }
    raycast(origin, dir, maxDist = 100, { exclude, ignore } = {}) {
        const ign = this.ignoreBodies(ignore, this._ign ??= []);
        if(exclude) { const b = exclude.body ?? exclude; if(b?.handle !== undefined && !ign.includes(b)) ign.push(b); }
        const hit = this.b3.castRay(origin, dir, maxDist, { ignore: ign });
        if(!hit) return null;
        return { point: hit.point, normal: hit.normal, distance: hit.distance, collider: hit.collider, prop: this.propOf(hit.collider) };
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
        const interp = this.interpolate, b3 = this.b3;
        while(this.acc >= STEP) {
            if(interp) {
                const xf = b3.xf();
                for(const p of this.props) {
                    if(!p.mesh) continue;
                    const r = p.body.row, q = p._prev || (p._prev = new Float64Array(7));
                    for(let i = 0; i < 7; i++) q[i] = xf[r + i];
                }
            }
            const hits = this.hits; hits.length = 0;
            b3.step(STEP, this.hitListeners.length ? hits : null);
            for(const h of hits) for(const fn of this.hitListeners) try { fn(h.a, h.b, h.speed, h.point, h.normal); } catch(err) { console.error(err); }
            for(const fn of this.stepListeners) fn(STEP);
            this.acc -= STEP;
        }
        for(const fn of this.frameListeners) fn(dt);
        // meshes follow their bodies, interpolated between the last two fixed steps (smooth at any frame rate)
        const a = this.acc / STEP, xf = b3.xf();
        for(const p of this.props) {
            if(!p.mesh) continue;
            const r = p.body.row, q = p._prev;
            const tx = xf[r], ty = xf[r + 1], tz = xf[r + 2], rx = xf[r + 3], ry = xf[r + 4], rz = xf[r + 5], rw = xf[r + 6];
            if(!interp || !q) { p.mesh.position.set(tx, ty, tz); p.mesh.quaternion.set(rx, ry, rz, rw); continue; }
            const b = 1 - a;
            p.mesh.position.set(q[0] * b + tx * a, q[1] * b + ty * a, q[2] * b + tz * a);
            const s = q[3] * rx + q[4] * ry + q[5] * rz + q[6] * rw < 0 ? -a : a; // shortest arc
            const x = q[3] * b + rx * s, y = q[4] * b + ry * s, z = q[5] * b + rz * s, w = q[6] * b + rw * s;
            const l = 1 / (Math.hypot(x, y, z, w) || 1);
            p.mesh.quaternion.set(x * l, y * l, z * l, w * l);
        }
        const ms = performance.now() - t0;
        this.stepMs = this.stepMs * 0.95 + ms * 0.05; // smoothed cost of physics.step per frame (ms)
        this.stepMsMax = Math.max(this.stepMsMax * 0.995, ms);
    }
}
