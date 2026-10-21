/**
 * A walking capsule (player and bots): box3d's capsule mover (collide, solve the contact planes, cast; B3World.move)
 * against the terrain meshes and bodies, with arcade gravity, jumping, knockback, ground snapping, a step-up over
 * ledges, and a push-out from solid terrain (sampling the voxel SDF) for when the world is built or collapses around
 * it. A kinematic capsule body follows it, so bodies and the other actors' movers collide with it.
 *
 *   const cb = new CharacterBody(ctx, { position: [x, y, z] (feet), radius, halfHeight })
 *   cb.step(dt, wishX, wishZ, { jump, speed, accel, airAccel })  wish = desired horizontal velocity (m/s)
 *   cb.feet / cb.center (THREE.Vector3), cb.vel, cb.grounded, cb.knock([x,y,z]), cb.teleport([x,y,z])
 */
import * as THREE from 'three/webgpu';
import { BodyType } from '../physics/Physics.js';

export const PLAYER_GRAVITY = 8 * 9.81;     // WorldParty: players fall at 8 g, bodies at 30 m/s²
const COYOTE = 0.1;
const STEP_UP = 0.75;         // tallest ledge (or collider seam) walked over without jumping (the vault trench's is 0.67 m)
const MANTLE = 3.0;           // m: a ledge up to this high (arm's reach) is hopped onto after pushing into it for MANTLE_T s
const MANTLE_T = 0.2;
const STEP_PROBE = 0.25;      // m: how far past a ledge's edge the step-up looks for ground
const FLOOR_COS = Math.cos(60 * Math.PI / 180); // walkable up to 60°; steeper is a wall while walking, a slide in the air
const SNAP = 0.5;             // stays on the ground over drops and down slopes up to this
const PUSH_MASS = 90;         // kg the mover pushes bodies with

export class CharacterBody {
    constructor(ctx, { position = [0, 0, 0], radius = 0.4, halfHeight = 0.5, gravity = PLAYER_GRAVITY, owner = null } = {}) {
        this.ctx = ctx;
        const physics = this.physics = ctx.physics;
        this.radius = radius; this.halfHeight = halfHeight;
        this.height = 2 * (radius + halfHeight);
        this.gravity = gravity;
        this.center = new THREE.Vector3(position[0], position[1] + radius + halfHeight, position[2]);
        this.vel = new THREE.Vector3();
        this.grounded = false;
        this.airTime = 0;
        this.landSpeed = 0;     // vertical speed at the last landing (for land sounds / shake)
        this.justLanded = false;
        this.body = physics.createBody({ type: BodyType.Kinematic, position: [this.center.x, this.center.y, this.center.z] });
        this.collider = physics.b3.createCapsule(this.body, halfHeight, radius, { friction: 0 });
        this.collider.userData = { actor: owner };
        this.ignore = new Set();  // collider handles the mover passes through (a carried crate, a held rock)
        this._ign = [];
        this._n = [0, 0, 0];
        this._desired = { x: 0, y: 0, z: 0 }; this._moved = { x: 0, y: 0, z: 0, grounded: false };
    }
    /** One mover query from `from` by `d` (B3World.move). */
    _move(from, d, walk, snap, dt, out, castOnly = false) {
        return this.physics.b3.move(from, this.halfHeight, this.radius, d,
            { walk, castOnly, floorCos: FLOOR_COS, snap, pushMass: dt > 0 ? PUSH_MASS : 0, dt, ignore: this._ign }, out);
    }
    get feet() { return this._feet ??= new THREE.Vector3(), this._feet.set(this.center.x, this.center.y - this.radius - this.halfHeight, this.center.z); }
    /** Eye point (a little below the top of the capsule). */
    eye(out = new THREE.Vector3()) { return out.set(this.center.x, this.center.y + this.halfHeight + this.radius * 0.55, this.center.z); }

    teleport(feet) {
        this.center.set(feet[0], feet[1] + this.radius + this.halfHeight, feet[2]);
        this.vel.set(0, 0, 0);
        this.body.setTranslation(this.center, true);
    }
    knock(v) {
        this.vel.x += v[0]; this.vel.y += v[1]; this.vel.z += v[2];
        if(v[1] > 2) { this.grounded = false; this.airTime = COYOTE; this.knocked = 0.25; }
    }
    canJump() { return this.grounded || this.airTime < COYOTE; }

    /** Push the capsule out of solid terrain (the world was built or fell onto it). Uses the voxel SDF, so it works
     *  even before the new collider mesh arrives. */
    unstick() {
        const w = this.ctx.world, c = this.center, h = this.halfHeight, n = this._n;
        for(let it = 0; it < 4; it++) {
            let worst = 0, wy = 0;
            for(let k = -1; k <= 1; k++) {
                const oy = k * h, d = w.sample(c.x, c.y + oy, c.z);
                if(d < worst) { worst = d; wy = oy; }
            }
            if(worst >= -0.02) return it > 0;
            if(worst < -0.9) { c.y += 0.5; continue; }     // buried deep (saturated distances): climb out
            w.normal(c.x, c.y + wy, c.z, n);
            const push = this.radius * 0.5 - worst;
            c.x += n[0] * push; c.y += n[1] * push; c.z += n[2] * push;
        }
        return true;
    }

    /** Advance one frame. wishX/wishZ: desired horizontal velocity. */
    step(dt, wishX, wishZ, { jump = false, jumpSpeed = 20, accel = 90, airAccel = 28, friction = 10 } = {}) {
        const v = this.vel;
        this.justLanded = false;
        if(this.knocked > 0) this.knocked -= dt;
        // horizontal: approach the wish velocity; extra speed (knockback) bleeds off with friction on the ground
        const a = this.grounded && !(this.knocked > 0) ? accel : airAccel;
        let dx = wishX - v.x, dz = wishZ - v.z;
        const dl = Math.hypot(dx, dz), maxD = a * dt;
        const speed = Math.hypot(v.x, v.z), wishSpeed = Math.hypot(wishX, wishZ);
        if(!this.grounded && speed > wishSpeed && wishSpeed > 0.1) {
            // airborne faster than walking (rocket jump): steer without killing momentum
            const k = Math.min(1, maxD / Math.max(dl, 1e-6)) * 0.35;
            v.x += dx * k; v.z += dz * k;
        } else if(!this.grounded && wishSpeed < 0.1) {
            const k = Math.max(0, 1 - 0.6 * dt); v.x *= k; v.z *= k;
        } else if(dl > maxD) { v.x += dx / dl * maxD; v.z += dz / dl * maxD; }
        else { v.x = wishX; v.z = wishZ; }
        if(this.grounded && speed > wishSpeed + 1 && !(this.knocked > 0)) { const k = Math.max(0, 1 - friction * dt); v.x = wishX + (v.x - wishX) * k; v.z = wishZ + (v.z - wishZ) * k; }

        if(jump && this.canJump()) { v.y = jumpSpeed; this.grounded = false; this.airTime = COYOTE; this.jumped = true; }
        v.y -= this.gravity * dt;
        if(v.y < -60) v.y = -60;

        this.unstick();
        // the mover skips our own capsule and whatever we hold or carry
        const ign = this.physics.ignoreBodies(this.ignore, this._ign);
        if(!ign.includes(this.body)) ign.push(this.body);
        // on the ground: no gravity into the slope (the mover would slide down it), snapping keeps us on the ground
        const walk = this.grounded && v.y <= 0.5;
        const desired = this._desired; desired.x = v.x * dt; desired.y = walk ? 0 : v.y * dt; desired.z = v.z * dt;
        let m = this._move(this.center, desired, walk, walk ? SNAP : 0, dt, this._moved);
        let ground = m.grounded;
        // Blocked on the ground: retry the step from higher up and settle back down (ledges taller than the capsule's
        // round bottom climbs by itself, and seams between terrain meshes)
        const want = Math.hypot(desired.x, desired.z);
        // (a failed retry is not repeated from the same spot for a moment: pushing against a wall would otherwise cost
        // four mover queries a frame)
        const sf = this._stepFail;
        const retry = !sf || sf.t <= 0 || Math.abs(sf.x - this.center.x) + Math.abs(sf.z - this.center.z) > 0.05 || (sf.dx * desired.x + sf.dz * desired.z) <= 0;
        if(sf) sf.t -= dt;
        if(retry && (this.grounded || ground) && want > 1e-4 && Math.hypot(m.x, m.z) < want * 0.6) {
            const r = this._stepUp(desired);
            if(r && Math.hypot(r.x, r.z) > Math.hypot(m.x, m.z) + 1e-4) { m = r; ground = true; this._stepFail = null; }
            else this._stepFail = { t: 0.1, x: this.center.x, z: this.center.z, dx: desired.x, dz: desired.z };
        }
        const wasGrounded = this.grounded;
        this.grounded = ground && v.y <= 0.5;
        // pushing into a wall on the ground (little progress the way we want to go): hop onto it if it has a top within reach (out of craters and pits)
        if(this.mantleCool > 0) this.mantleCool -= dt;
        if(this.grounded && want > 1e-4 && (m.x * desired.x + m.z * desired.z) < want * want * 0.3) this.blockedT = (this.blockedT || 0) + dt; else this.blockedT = 0;
        if(this.blockedT > MANTLE_T && !(this.mantleCool > 0)) {
            this.blockedT = 0; this.mantleCool = 0.5;
            const h = this._ledge(desired);
            if(h > 0) { v.y = Math.sqrt(2 * this.gravity * (h + 0.3)); this.grounded = false; this.airTime = COYOTE; this.mantled = true; }
        }
        // blocked: drop the velocity the obstacle ate. Not while climbing: a slope turns part of the step into height,
        // and taking that off the speed every frame stalled the player halfway up any ramp
        const climbing = m.y > Math.max(desired.y, 0) + 1e-4;
        if(dt > 0 && !climbing) {
            const want = Math.hypot(desired.x, desired.z), got = Math.hypot(m.x, m.z);
            if(got < want * 0.2) { if(Math.abs(m.x) < Math.abs(desired.x) - 1e-4) v.x = m.x / dt; if(Math.abs(m.z) < Math.abs(desired.z) - 1e-4) v.z = m.z / dt; }
            if(desired.y > 0 && m.y < desired.y * 0.5) v.y = Math.min(v.y, 0);           // head bump
        }
        if(this.grounded) {
            if(!wasGrounded) { this.justLanded = true; this.landSpeed = -v.y; }
            v.y = Math.max(v.y, -2);
            this.airTime = 0;
        } else this.airTime += dt;
        this.center.x += m.x; this.center.y += m.y; this.center.z += m.z;
        this.body.setNextKinematicTranslation(this.center);
    }

    /** Move by `desired` horizontally after lifting up to STEP_UP, then drop back onto the ground; when the way straight
     *  ahead has no ground to stand on, 45° to either side is tried (finding the way up a faceted crater wall). Returns
     *  the total movement (into this._stepMoved) if it lands on walkable ground, else null. */
    _stepUp(desired) {
        const c = this.center;
        const d = this._d2 ??= { x: 0, y: 0, z: 0 }, tmp = this._tmpV ??= {};
        // up
        d.x = 0; d.y = STEP_UP; d.z = 0;
        const up = this._move(c, d, false, 0, 0, tmp).y;
        if(up < 0.1) return null;
        // across: at least STEP_PROBE (pushing against a step kills the speed, and a step only counts if there is room
        // to stand on top of it)
        const want = Math.hypot(desired.x, desired.z), k = Math.max(1, STEP_PROBE / Math.max(want, 1e-6));
        const fx = desired.x * k, fz = desired.z * k, C = Math.SQRT1_2;
        return this._stepAcross(up, fx, fz, desired)
            || this._stepAcross(up, (fx - fz) * C, (fz + fx) * C, desired)
            || this._stepAcross(up, (fx + fz) * C, (fz - fx) * C, desired);
    }
    /** Height of the top of the ledge ahead (within MANTLE) the capsule could stand on, or 0. */
    _ledge(desired) {
        const c = this.center, d = this._d2 ??= { x: 0, y: 0, z: 0 }, tmp = this._tmpV ??= {}, p = this._p2 ??= { x: 0, y: 0, z: 0 };
        d.x = 0; d.y = MANTLE; d.z = 0;
        const up = this._move(c, d, false, 0, 0, tmp).y;
        if(up < STEP_UP) return 0;
        const want = Math.hypot(desired.x, desired.z), k = (this.radius + STEP_PROBE) / Math.max(want, 1e-6);
        p.x = c.x; p.y = c.y + up; p.z = c.z;
        d.x = desired.x * k; d.y = 0; d.z = desired.z * k;
        const a = this._move(p, d, true, 0, 0, tmp);
        if(Math.hypot(a.x, a.z) < this.radius) return 0;
        p.x += a.x; p.y += a.y; p.z += a.z;
        d.x = 0; d.y = -up; d.z = 0;
        const dn = this._move(p, d, false, 0, 0, tmp, true);
        const h = up + a.y + dn.y;
        return dn.grounded && h > 0.3 ? h : 0;
    }
    _stepAcross(up, dx, dz, desired) {
        const c = this.center, d = this._d2, tmp = this._tmpV, out = this._stepMoved ??= { x: 0, y: 0, z: 0, grounded: false };
        const p = this._p2 ??= { x: 0, y: 0, z: 0 };
        p.x = c.x; p.y = c.y + up; p.z = c.z;
        d.x = dx; d.y = 0; d.z = dz;
        const a = this._move(p, d, true, 0, 0, tmp);
        const ax = a.x, ay = a.y, az = a.z;
        if(Math.hypot(ax, az) < 1e-3) return null;
        p.x += ax; p.y += ay; p.z += az;
        // down: as far as we went up plus the ordinary descent, stopping on whatever is under us (sliding here would
        // pull the capsule back off a ledge's edge)
        d.x = 0; d.y = -(up + Math.max(0, -desired.y) + 0.05); d.z = 0;
        const dn = this._move(p, d, false, 0, 0, tmp, true);
        if(!dn.grounded) return null;
        out.x = ax; out.y = up + ay + dn.y; out.z = az; out.grounded = true;
        return out;
    }

    dispose() {
        this.physics.b3.removeBody(this.body);
    }
}
