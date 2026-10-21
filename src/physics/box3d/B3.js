/**
 * box3d (Erin Catto, MIT; vendor/box3d, built by tools/box3d/build.sh from tools/box3d/bind.c) as a small JS object
 * model: B3World, B3Body, B3Collider. Single-threaded wasm; the SIMD build where wasm SIMD is supported, else the
 * scalar one (both give bit-identical results).
 *
 * Safety: bodies and colliders are int handles checked by the C side (slot + generation), so a call on a removed
 * object is a no-op instead of a crash, and nothing calls back into JS during a step or query.
 *
 * Reads: every body's pose lives in one shared Float32Array (the transform table, 8 floats per body slot: position,
 * quaternion, awake), refreshed after each step from box3d's move events and on every set; translation()/rotation()
 * read it without calling into wasm. Velocities, mass and centre of mass are fetched on demand.
 *
 * Collision groups are the 32-bit (memberships << 16) | filter words Physics.js uses: a pair collides when each one's
 * memberships meet the other's filter.
 */
import createBox3d from '../../../vendor/box3d/box3d.mjs';

const SLOT_MASK = 0x1ffff;
const XF = 8;
const HIT = 10;
export const BodyType = { Fixed: 0, Kinematic: 1, Dynamic: 2 };
const ZERO = new Float32Array(16);

// wasm SIMD feature test (a function returning a v128)
const SIMD_TEST = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11);
export const simdSupported = () => { try { return WebAssembly.validate(SIMD_TEST); } catch(e) { return false; } };

let modulePromise = null;
/** Load the wasm module once (`simd`: force a build, default by feature test). */
export function loadBox3d({ simd = simdSupported() } = {}) {
    return modulePromise ??= (async () => {
        const file = simd ? 'box3d-simd.wasm' : 'box3d-scalar.wasm';
        let wasmBinary;
        if(typeof process !== 'undefined' && process.versions?.node && typeof window === 'undefined') {
            const fs = await import('node:fs');
            wasmBinary = fs.readFileSync(new URL(`../../../vendor/box3d/${file}`, import.meta.url));
        } else {
            // bundled code runs from dist/: the wasm is served from vendor/ next to it
            const res = await fetch(new URL(`../vendor/box3d/${file}`, import.meta.url));
            if(!res.ok) throw new Error(`box3d: ${file} ${res.status}`);
            wasmBinary = new Uint8Array(await res.arrayBuffer());
        }
        const M = await createBox3d({ instantiateWasm: (imports, done) => { WebAssembly.instantiate(wasmBinary, imports).then(r => done(r.instance)); return {}; } });
        M.simd = simd;
        return M;
    })();
}

const groupsCat = (g) => (g >>> 16) >>> 0;
const groupsMask = (g) => (g & 0xffff) >>> 0;

export class B3Collider {
    constructor(world, handle, body, groups) {
        this.world = world; this.handle = handle; this.body = body; this.groups = groups;
        this.userData = null;
        this.enabled = true;
    }
    isValid() { return this.handle >= 0 && this.world.M._bw_shape_valid(this.handle) === 1; }
    isSensor() { return false; }
    setCollisionGroups(g) { this.groups = g >>> 0; this.world.M._bw_shape_set_filter(this.handle, groupsCat(g), groupsMask(g)); }
    collisionGroups() { return this.groups; }
    setEnabled(on) { this.enabled = !!on; this.world.M._bw_shape_enable(this.handle, on ? 1 : 0); }
    isEnabled() { return this.enabled; }
}

export class B3Body {
    constructor(world, handle, type) {
        this.world = world; this.handle = handle; this.type = type;
        this.colliders = [];
        this.row = (handle & SLOT_MASK) * XF;
        this.kt = null; this.kr = null; // pending kinematic target (applied at the next step)
        this.enabled = true;
    }
    get M() { return this.world.M; }
    isValid() { return this.M._bw_body_valid(this.handle) === 1; }
    // ---- pose (transform table)
    translation() { const x = this.world.xf(), r = this.row; return { x: x[r], y: x[r + 1], z: x[r + 2] }; }
    rotation() { const x = this.world.xf(), r = this.row; return { x: x[r + 3], y: x[r + 4], z: x[r + 5], w: x[r + 6] }; }
    setTranslation(t, wake = true) {
        const x = this.world.xf(), r = this.row;
        this.M._bw_body_set_transform(this.handle, t.x, t.y, t.z, x[r + 3], x[r + 4], x[r + 5], x[r + 6], wake ? 1 : 0);
    }
    setRotation(q, wake = true) {
        const x = this.world.xf(), r = this.row;
        this.M._bw_body_set_transform(this.handle, x[r], x[r + 1], x[r + 2], q.x, q.y, q.z, q.w, wake ? 1 : 0);
    }
    /** Kinematic: where the body should be after the next step (box3d moves it there by velocity). */
    setNextKinematicTranslation(t) { (this.kt ??= { x: 0, y: 0, z: 0 }); this.kt.x = t.x; this.kt.y = t.y; this.kt.z = t.z; this.world.kinematic.add(this); }
    setNextKinematicRotation(q) { (this.kr ??= { x: 0, y: 0, z: 0, w: 1 }); this.kr.x = q.x; this.kr.y = q.y; this.kr.z = q.z; this.kr.w = q.w; this.world.kinematic.add(this); }
    // ---- velocity, mass (on demand)
    _get() { return this.M._bw_body_get(this.handle) ? this.world.out() : ZERO; }
    linvel() { const o = this._get(); return { x: o[0], y: o[1], z: o[2] }; }
    angvel() { const o = this._get(); return { x: o[3], y: o[4], z: o[5] }; }
    mass() { return this._get()[7]; }
    worldCom() { const o = this._get(); return { x: o[8], y: o[9], z: o[10] }; }
    setLinvel(v, wake = true) { this.M._bw_body_set_linvel(this.handle, v.x, v.y, v.z, wake ? 1 : 0); }
    setAngvel(v, wake = true) { this.M._bw_body_set_angvel(this.handle, v.x, v.y, v.z, wake ? 1 : 0); }
    applyImpulse(j, wake = true) { this.M._bw_body_impulse(this.handle, j.x, j.y, j.z, 0, 0, 0, 0, wake ? 1 : 0); }
    applyImpulseAtPoint(j, p, wake = true) { this.M._bw_body_impulse(this.handle, j.x, j.y, j.z, p.x, p.y, p.z, 1, wake ? 1 : 0); }
    applyTorqueImpulse(t, wake = true) { this.M._bw_body_angular_impulse(this.handle, t.x, t.y, t.z, wake ? 1 : 0); }
    /** Scale the mass from the colliders (and the inertia with it) to `m` kg. */
    setMass(m) { this.M._bw_body_set_mass(this.handle, m); }
    setLinearDamping(d) { this._lin = d; this.M._bw_body_set_damping(this.handle, d, this._ang ?? 0); }
    setAngularDamping(d) { this._ang = d; this.M._bw_body_set_damping(this.handle, this._lin ?? 0, d); }
    setBullet(on) { this.M._bw_body_set_bullet(this.handle, on ? 1 : 0); }
    // ---- state
    isDynamic() { return this.type === BodyType.Dynamic; }
    isKinematic() { return this.type === BodyType.Kinematic; }
    isFixed() { return this.type === BodyType.Fixed; }
    bodyType() { return this.type; }
    setBodyType(type, wake = true) {
        if(type === this.type) return;
        this.type = type;
        this.M._bw_body_set_type(this.handle, type);
        if(type !== BodyType.Kinematic) { this.kt = this.kr = null; this.world.kinematic.delete(this); }
        if(wake && type !== BodyType.Fixed) this.wakeUp();
    }
    isSleeping() { return this.world.xf()[this.row + 7] === 0; }
    wakeUp() { this.M._bw_body_set_awake(this.handle, 1); }
    sleep() { this.M._bw_body_set_awake(this.handle, 0); }
    setEnabled(on) { this.enabled = !!on; this.M._bw_body_enable(this.handle, on ? 1 : 0); }
    isEnabled() { return this.enabled; }
    numColliders() { return this.colliders.length; }
    collider(i) { return this.colliders[i]; }
}

/** One box3d world. */
export class B3World {
    constructor(M, { gravity = [0, -9.81, 0], hitThreshold = 1 } = {}) {
        this.M = M;
        M._bw_world_create(gravity[0], gravity[1], gravity[2], hitThreshold);
        this.xfPtr = M._bw_xf() >> 2;
        this.hitPtr = M._bw_hits() >> 2;
        this.outPtr = M._bw_out() >> 2;
        this.ignPtr = M._bw_ignore() >> 2;
        this.bodies = new Map();    // handle -> B3Body
        this.colliders = new Map(); // handle -> B3Collider
        this.kinematic = new Set(); // bodies with a pending kinematic target
        this.substeps = 4;
        this.scratch = { ptr: 0, bytes: 0 };
        this._xf = null;
    }
    /** The transform table (a view that follows memory growth). */
    xf() {
        const h = this.M.HEAPF32;
        if(!this._xf || this._xf.buffer !== h.buffer) this._xf = h.subarray(this.xfPtr, this.xfPtr + 32768 * XF);
        return this._xf;
    }
    out() { return this.M.HEAPF32.subarray(this.outPtr, this.outPtr + 64); }

    /** Fixed step. Pending kinematic targets are reached at the end of it (and the bodies stop there). Returns the hit
     *  events as { a, b (B3Collider), point [x,y,z], normal, speed (approach, m/s) }. */
    step(dt, hitsOut = null) {
        const M = this.M, kin = this.kinematic;
        if(kin.size) for(const b of kin) {
            const x = this.xf(), r = b.row, t = b.kt, q = b.kr;
            M._bw_body_set_target(b.handle, t ? t.x : x[r], t ? t.y : x[r + 1], t ? t.z : x[r + 2],
                q ? q.x : x[r + 3], q ? q.y : x[r + 4], q ? q.z : x[r + 5], q ? q.w : x[r + 6], dt);
        }
        const n = M._bw_step(dt, this.substeps);
        if(kin.size) {
            for(const b of kin) { b.kt = b.kr = null; M._bw_body_set_linvel(b.handle, 0, 0, 0, 0); M._bw_body_set_angvel(b.handle, 0, 0, 0, 0); }
            kin.clear();
        }
        if(!hitsOut || !n) return n;
        const f = M.HEAPF32, i32 = M.HEAP32, p = this.hitPtr;
        for(let k = 0; k < n; k++) {
            const o = p + k * HIT;
            const a = this.colliders.get(i32[o]), b = this.colliders.get(i32[o + 1]);
            if(!a || !b) continue;
            hitsOut.push({ a, b, point: [f[o + 2], f[o + 3], f[o + 4]], normal: [f[o + 5], f[o + 6], f[o + 7]], speed: f[o + 8] });
        }
        return n;
    }
    awakeCount() { return this.M._bw_awake_count(); }

    createBody({ type = BodyType.Dynamic, position = [0, 0, 0], rotation = [0, 0, 0, 1], linvel = [0, 0, 0], angvel = [0, 0, 0], linearDamping = 0, angularDamping = 0, bullet = false, enabled = true, gravityScale = 1 } = {}) {
        const h = this.M._bw_body_create(type, position[0], position[1], position[2], rotation[0], rotation[1], rotation[2], rotation[3],
            linvel[0], linvel[1], linvel[2], angvel[0], angvel[1], angvel[2], linearDamping, angularDamping, bullet ? 1 : 0, enabled ? 1 : 0, gravityScale);
        if(h < 0) throw new Error('box3d: out of body slots');
        const b = new B3Body(this, h, type);
        b._lin = linearDamping; b._ang = angularDamping; b.enabled = enabled;
        this.bodies.set(h, b);
        return b;
    }
    removeBody(b) {
        if(!this.bodies.delete(b.handle)) return;
        for(const c of b.colliders) this.colliders.delete(c.handle);
        b.colliders.length = 0;
        this.kinematic.delete(b);
        this.M._bw_body_destroy(b.handle);
    }
    _add(body, h, groups) {
        if(h < 0) return null;
        const c = new B3Collider(this, h, body, groups >>> 0);
        body.colliders.push(c);
        this.colliders.set(h, c);
        return c;
    }
    /** Common collider options: { density, friction, restitution, groups, hitEvents, updateMass } */
    createBox(body, half, { center = [0, 0, 0], rotation = [0, 0, 0, 1], density = 1000, friction = 0.6, restitution = 0, groups = 0xffffffff, hitEvents = false, updateMass = true } = {}) {
        return this._add(body, this.M._bw_shape_box(body.handle, half[0], half[1], half[2], center[0], center[1], center[2], rotation[0], rotation[1], rotation[2], rotation[3],
            density, friction, restitution, groupsCat(groups), groupsMask(groups), hitEvents ? 1 : 0, updateMass ? 1 : 0), groups);
    }
    createSphere(body, radius, { center = [0, 0, 0], density = 1000, friction = 0.6, restitution = 0, groups = 0xffffffff, hitEvents = false, updateMass = true } = {}) {
        return this._add(body, this.M._bw_shape_sphere(body.handle, radius, center[0], center[1], center[2], density, friction, restitution,
            groupsCat(groups), groupsMask(groups), hitEvents ? 1 : 0, updateMass ? 1 : 0), groups);
    }
    /** Capsule along y (sphere centres at +-halfHeight). */
    createCapsule(body, halfHeight, radius, { density = 1000, friction = 0.6, restitution = 0, groups = 0xffffffff, hitEvents = false, updateMass = true } = {}) {
        return this._add(body, this.M._bw_shape_capsule(body.handle, halfHeight, radius, density, friction, restitution,
            groupsCat(groups), groupsMask(groups), hitEvents ? 1 : 0, updateMass ? 1 : 0), groups);
    }
    /** Convex hull of body-local points (xyz). Null if no hull could be made. */
    createHull(body, points, { density = 1000, friction = 0.6, restitution = 0, groups = 0xffffffff, hitEvents = false, updateMass = true } = {}) {
        const ptr = this._scratch(points.length * 4);
        this.M.HEAPF32.set(points, ptr >> 2);
        return this._add(body, this.M._bw_shape_hull(body.handle, ptr, points.length / 3, density, friction, restitution,
            groupsCat(groups), groupsMask(groups), hitEvents ? 1 : 0, updateMass ? 1 : 0), groups);
    }
    /** Static triangle mesh (world-space vertices, counter-clockwise outward triangles). */
    createMesh(body, vertices, indices, { friction = 0.9, groups = 0xffffffff } = {}) {
        const vb = vertices.length * 4, ptr = this._scratch(vb + indices.length * 4);
        const M = this.M;
        M.HEAPF32.set(vertices, ptr >> 2);
        M.HEAP32.set(indices, (ptr + vb) >> 2);
        return this._add(body, M._bw_shape_mesh(body.handle, ptr, vertices.length / 3, ptr + vb, indices.length / 3, friction, groupsCat(groups), groupsMask(groups)), groups);
    }
    removeCollider(c, updateMass = false) {
        if(!this.colliders.delete(c.handle)) return;
        const l = c.body.colliders, i = l.indexOf(c);
        if(i >= 0) l.splice(i, 1);
        this.M._bw_shape_destroy(c.handle, updateMass ? 1 : 0);
    }
    _scratch(bytes) {
        const s = this.scratch;
        if(s.bytes < bytes) {
            if(s.ptr) this.M._bw_free(s.ptr);
            s.bytes = Math.max(bytes, s.bytes * 2, 1 << 16);
            s.ptr = this.M._bw_malloc(s.bytes);
        }
        return s.ptr;
    }
    /** Bodies (handles) skipped by the next query / move. */
    setIgnore(bodies) {
        const i32 = this.M.HEAP32;
        let n = 0;
        if(bodies) for(const b of bodies) { if(n >= 32) break; i32[this.ignPtr + n++] = b.handle ?? b; }
        this.M._bw_ignore_count(n);
    }
    /** Closest hit: { collider, distance, point, normal } or null. `ignore`: bodies to skip. */
    castRay(origin, dir, maxDist, { groups = 0xffffffff, ignore = null } = {}) {
        this.setIgnore(ignore);
        const hit = this.M._bw_raycast(origin[0], origin[1], origin[2], dir[0], dir[1], dir[2], maxDist, groupsCat(groups), groupsMask(groups));
        this.M._bw_ignore_count(0);
        if(!hit) return null;
        const f = this.out(), h = this.M.HEAP32[this.outPtr + 1];
        return { collider: this.colliders.get(h) || null, distance: f[2], point: [f[3], f[4], f[5]], normal: [f[6], f[7], f[8]] };
    }
    /**
     * Character mover (tools/box3d/bind.c bw_move): moves a y-axis capsule centred at `c` by `t`, sliding along what it
     * touches (castOnly: stops at the first contact instead). Returns `out` = { x, y, z (the movement), grounded, floorY (normal.y of the ground) }.
     */
    move(c, halfHeight, radius, t, { walk = false, castOnly = false, floorCos = 0.5, snap = 0, pushMass = 0, dt = 0, groups = 0xffffffff, ignore = null } = {}, out = {}) {
        this.setIgnore(ignore);
        this.M._bw_move(c.x, c.y, c.z, halfHeight, radius, t.x, t.y, t.z, (walk ? 1 : 0) | (castOnly ? 2 : 0), floorCos, snap, pushMass, dt, groupsCat(groups), groupsMask(groups));
        this.M._bw_ignore_count(0);
        const f = this.out();
        out.x = f[0]; out.y = f[1]; out.z = f[2]; out.grounded = f[3] > 0; out.floorY = f[4];
        return out;
    }
    free() { this.M._bw_world_destroy(); }
}
