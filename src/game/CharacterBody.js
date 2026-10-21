/**
 * A walking capsule (player and bots): Rapier's KinematicCharacterController against the terrain trimeshes and bodies,
 * with arcade gravity, jumping, knockback, and a push-out from solid terrain (sampling the voxel SDF) for when the
 * world is built or collapses around it.
 *
 *   const cb = new CharacterBody(ctx, { position: [x, y, z] (feet), radius, halfHeight })
 *   cb.step(dt, wishX, wishZ, { jump, speed, accel, airAccel })  wish = desired horizontal velocity (m/s)
 *   cb.feet / cb.center (THREE.Vector3), cb.vel, cb.grounded, cb.knock([x,y,z]), cb.teleport([x,y,z])
 */
import * as THREE from 'three/webgpu';

export const PLAYER_GRAVITY = 8 * 9.81;     // WorldParty: players fall at 8 g, bodies at 30 m/s²
const COYOTE = 0.1;
const STEP_UP = 0.6;          // tallest ledge (or collider seam) walked over without jumping

export class CharacterBody {
    constructor(ctx, { position = [0, 0, 0], radius = 0.4, halfHeight = 0.5, gravity = PLAYER_GRAVITY, owner = null } = {}) {
        this.ctx = ctx;
        const { R, rw } = ctx.physics;
        this.R = R; this.rw = rw;
        this.radius = radius; this.halfHeight = halfHeight;
        this.height = 2 * (radius + halfHeight);
        this.gravity = gravity;
        this.center = new THREE.Vector3(position[0], position[1] + radius + halfHeight, position[2]);
        this.vel = new THREE.Vector3();
        this.grounded = false;
        this.airTime = 0;
        this.landSpeed = 0;     // vertical speed at the last landing (for land sounds / shake)
        this.justLanded = false;
        this.body = rw.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(this.center.x, this.center.y, this.center.z));
        this.collider = rw.createCollider(R.ColliderDesc.capsule(halfHeight, radius).setFriction(0), this.body);
        this.collider.userData = { actor: owner };
        this.cc = rw.createCharacterController(0.05);
        // voxel terrain is a field of small facets and ledges: step over anything knee high, even narrow tops
        this.cc.enableAutostep(0.6, 0.05, true);
        this.cc.enableSnapToGround(0.5);
        this.cc.setMaxSlopeClimbAngle(60 * Math.PI / 180);
        this.cc.setMinSlopeSlideAngle(70 * Math.PI / 180);
        this.cc.setApplyImpulsesToDynamicBodies(true);
        this.cc.setCharacterMass(90);
        this.cc.setSlideEnabled(true);
        this.ignore = new Set();  // collider handles the controller passes through (a carried crate, a held rock)
        // (sensors are excluded by QueryFilterFlags.EXCLUDE_SENSORS: calling c.isSensor() here re-enters Rapier
        // while it is borrowed, which throws every time and cost the bots up to ~10 ms a frame)
        this.filter = (c) => !this.ignore.has(c.handle);
        this._n = [0, 0, 0];
        this._desired = { x: 0, y: 0, z: 0 }; this._moved = { x: 0, y: 0, z: 0 };
    }
    get feet() { return this._feet ??= new THREE.Vector3(), this._feet.set(this.center.x, this.center.y - this.radius - this.halfHeight, this.center.z); }
    /** Eye point (a little below the top of the capsule). */
    eye(out = new THREE.Vector3()) { return out.set(this.center.x, this.center.y + this.halfHeight + this.radius * 0.55, this.center.z); }

    teleport(feet) {
        this.center.set(feet[0], feet[1] + this.radius + this.halfHeight, feet[2]);
        this.vel.set(0, 0, 0);
        this.body.setTranslation(this.center, true);
        this.collider.setTranslation(this.center);
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
        this.collider.setTranslation(this.center);
        const desired = this._desired; desired.x = v.x * dt; desired.y = v.y * dt; desired.z = v.z * dt;
        this.cc.computeColliderMovement(this.collider, desired, this.R.QueryFilterFlags.EXCLUDE_SENSORS, undefined, this.filter);
        let m = this.cc.computedMovement(this._moved);
        let ground = this.cc.computedGrounded();
        // Blocked on the ground: retry the step from higher up and settle back down. The terrain is many trimesh
        // colliders, and Rapier's controller catches on the seams between them and on small ledges the voxel surface
        // leaves (its autostep needs a clean step); lifting over them keeps walking smooth up any walkable slope.
        const want = Math.hypot(desired.x, desired.z);
        // (a failed retry is not repeated from the same spot for a moment: pushing against a wall would otherwise cost
        // four controller queries a frame, a few ms per bot at high frame rates)
        const sf = this._stepFail;
        const retry = !sf || sf.t <= 0 || Math.abs(sf.x - this.center.x) + Math.abs(sf.z - this.center.z) > 0.05 || (sf.dx * desired.x + sf.dz * desired.z) <= 0;
        if(sf) sf.t -= dt;
        if(retry && (this.grounded || ground) && want > 1e-4 && Math.hypot(m.x, m.z) < want * 0.6) {
            const r = this._stepUp(desired);
            if(r) { m = r; ground = true; this._stepFail = null; }
            else this._stepFail = { t: 0.1, x: this.center.x, z: this.center.z, dx: desired.x, dz: desired.z };
        }
        const wasGrounded = this.grounded;
        this.grounded = ground && v.y <= 0.5;
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

    /** Move by `desired` horizontally after lifting up to STEP_UP, then drop back onto the ground. Returns the total
     *  movement (into this._stepMoved) if that got further than the plain move and lands on walkable ground, else null. */
    _stepUp(desired) {
        const cc = this.cc, col = this.collider, c = this.center, flags = this.R.QueryFilterFlags.EXCLUDE_SENSORS;
        const d = this._d2 ??= { x: 0, y: 0, z: 0 }, out = this._stepMoved ??= { x: 0, y: 0, z: 0 }, tmp = this._tmpV ??= { x: 0, y: 0, z: 0 };
        const p = this._p2 ??= { x: 0, y: 0, z: 0 };
        // up
        d.x = 0; d.y = STEP_UP; d.z = 0;
        cc.computeColliderMovement(col, d, flags, undefined, this.filter);
        const up = cc.computedMovement(tmp).y;
        if(up < 0.1) return null;
        p.x = c.x; p.y = c.y + up; p.z = c.z;
        col.setTranslation(p);
        // across
        d.x = desired.x; d.y = 0; d.z = desired.z;
        cc.computeColliderMovement(col, d, flags, undefined, this.filter);
        const a = cc.computedMovement(tmp);
        const ax = a.x, az = a.z;
        p.x += ax; p.z += az;
        col.setTranslation(p);
        // down: as far as we went up plus the ordinary descent
        d.x = 0; d.y = -(up + Math.max(0, -desired.y) + 0.05); d.z = 0;
        cc.computeColliderMovement(col, d, flags, undefined, this.filter);
        const dn = cc.computedMovement(tmp).y, landed = cc.computedGrounded();
        col.setTranslation(c);
        if(!landed || Math.hypot(ax, az) < 1e-3) return null;
        out.x = ax; out.y = up + dn; out.z = az;
        return out;
    }

    dispose() {
        this.rw.removeCharacterController(this.cc);
        this.rw.removeRigidBody(this.body);
    }
}
