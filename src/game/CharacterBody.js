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
        this.cc = rw.createCharacterController(0.03);
        this.cc.enableAutostep(0.55, 0.15, true);
        this.cc.enableSnapToGround(0.35);
        this.cc.setMaxSlopeClimbAngle(55 * Math.PI / 180);
        this.cc.setMinSlopeSlideAngle(65 * Math.PI / 180);
        this.cc.setApplyImpulsesToDynamicBodies(true);
        this.cc.setCharacterMass(90);
        this.cc.setSlideEnabled(true);
        this.ignore = new Set();  // collider handles the controller passes through (a carried crate, a held rock)
        this.filter = (c) => !this.ignore.has(c.handle) && !c.isSensor();
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
        const m = this.cc.computedMovement(this._moved);
        const wasGrounded = this.grounded;
        this.grounded = this.cc.computedGrounded() && v.y <= 0.5;
        // blocked: drop the velocity the obstacle ate
        if(dt > 0) {
            if(Math.abs(m.x) < Math.abs(desired.x) - 1e-4) v.x = m.x / dt;
            if(Math.abs(m.z) < Math.abs(desired.z) - 1e-4) v.z = m.z / dt;
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

    dispose() {
        this.rw.removeCharacterController(this.cc);
        this.rw.removeRigidBody(this.body);
    }
}
