/**
 * The first-person player (team Red): input -> CharacterBody, mouse/touch look, camera with head bob, shake, recoil
 * and a sprint FOV kick, the tools (Arsenal) and the view model. Dead: the camera drifts up and waits for respawn.
 */
import * as THREE from 'three/webgpu';
import { Actor } from './Actor.js';
import { Arsenal } from './weapons/Arsenal.js';
import { ViewModel } from './ViewModel.js';

const WALK = 9.5, SPRINT = 14, CARRY = 0.85, JUMP = 20;
const BASE_FOV = 74;
const noise = (t, f, o) => Math.sin(t * f + o) * 0.6 + Math.sin(t * f * 2.3 + o * 1.7) * 0.4;

export class Player extends Actor {
    constructor(game, input, opts) {
        super(game, { ...opts, isPlayer: true });
        this.input = input;
        this.camera = game.ctx.camera;
        const s = opts.spawn;
        this.yaw = s[0] < 0 ? -Math.PI / 2 : Math.PI / 2; // face the enemy fort
        this.pitch = -0.05;
        this.recoil = 0;       // pitch kick (rad), recovers
        this.trauma = 0;       // camera shake 0..1
        this.bob = 0;
        this.fov = BASE_FOV;
        this.jumpBuffer = 0;
        this.euler = new THREE.Euler(0, 0, 0, 'YXZ');
        this.eyePos = new THREE.Vector3();
        this.forward = new THREE.Vector3();
        this.arsenal = new Arsenal(game, this);
        this.viewModel = new ViewModel(game, this);
        this.deathCam = 0;
        this.stepT = 0;
        this._aim = [0, 0, 0]; this._eye = [0, 0, 0];
    }
    respawn() {
        super.respawn();
        this.yaw = this.spawn[0] < 0 ? -Math.PI / 2 : Math.PI / 2;
        this.pitch = -0.05; this.recoil = 0; this.trauma = 0;
    }
    shake(amount) { this.trauma = Math.min(1, this.trauma + amount); }
    kick(rad) { this.recoil = Math.min(0.25, this.recoil + rad); }
    /** Aim direction [x, y, z] (unit) from the camera's yaw and pitch. */
    aimDir(out = this._aim) {
        const cp = Math.cos(this.pitch);
        out[0] = -Math.sin(this.yaw) * cp; out[1] = Math.sin(this.pitch); out[2] = -Math.cos(this.yaw) * cp;
        return out;
    }
    /** Eye position [x, y, z] (a reused array: copy it to keep it). */
    eye(out = this._eye) { this.body.eye(this.eyePos); out[0] = this.eyePos.x; out[1] = this.eyePos.y; out[2] = this.eyePos.z; return out; }

    update(dt) {
        const input = this.input, body = this.body;
        input.updateKeys();
        this.tickCommon(dt);
        const lx = input.look[0], ly = input.look[1]; input.look[0] = input.look[1] = 0;
        if(this.alive && !this.game.over) {
            this.yaw -= lx; this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch - ly));
            const sprint = input.down('sprint') && input.move.y > 0.2;
            let speed = sprint ? SPRINT : WALK;
            if(this.carrying) speed *= CARRY;
            const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
            const mx = input.move.x, my = input.move.y;
            const wx = (-sy * my + cy * mx) * speed, wz = (-cy * my - sy * mx) * speed;
            if(input.pressed('jump')) this.jumpBuffer = 0.14;
            const wantJump = this.jumpBuffer > 0 && body.canJump();
            if(wantJump) this.jumpBuffer = 0; else this.jumpBuffer -= dt;
            body.step(dt, wx, wz, { jump: wantJump, jumpSpeed: JUMP });
            if(wantJump) this.game.emit('jump', { actor: this });
            if(body.justLanded && body.landSpeed > 12) { this.shake(Math.min(0.5, (body.landSpeed - 12) / 50)); this.game.emit('land', { actor: this, speed: body.landSpeed }); }
            // footsteps and head bob
            const hs = Math.hypot(body.vel.x, body.vel.z);
            if(body.grounded && hs > 1) {
                this.bob += dt * hs * 1.15;
                this.stepT -= dt * hs;
                if(this.stepT <= 0) { this.stepT = sprint ? 4.2 : 3.4; this.game.emit('step', { actor: this }); }
            } else this.bob *= 0.9;
            this.fov += ((sprint && hs > 10 ? BASE_FOV + 8 : BASE_FOV) - this.fov) * Math.min(1, dt * 8);
            this.arsenal.update(dt, input);
            if(body.center.y < -24) this.game.damage(this, 1000, null, null, 'fell');
        } else {
            body.vel.set(0, 0, 0);
            if(this.held) this.arsenal.release(false);
        }
        this.updateCamera(dt);
        this.viewModel.update(dt);
        input.endFrame();
    }

    updateCamera(dt) {
        const cam = this.camera;
        this.recoil *= Math.max(0, 1 - dt * 9);
        this.trauma = Math.max(0, this.trauma - dt * 1.6);
        const sh = this.trauma * this.trauma, t = performance.now() / 1000;
        if(this.alive) {
            this.body.eye(this.eyePos);
            cam.position.copy(this.eyePos);
            cam.position.y += Math.abs(Math.sin(this.bob)) * 0.06 - 0.03 * (this.bob ? 1 : 0);
            this.deathCam = 0;
        } else {
            this.deathCam += dt;
            cam.position.y += dt * Math.max(0, 2 - this.deathCam);
            this.pitch += (-0.9 - this.pitch) * Math.min(1, dt * 2);
        }
        // shake: smooth noise on the angles and a little on the position
        cam.position.x += noise(t, 31, 1) * sh * 0.12; cam.position.y += noise(t, 29, 2) * sh * 0.12;
        this.euler.set(this.pitch + this.recoil + noise(t, 27, 3) * sh * 0.06, this.yaw + noise(t, 23, 4) * sh * 0.06, noise(t, 19, 5) * sh * 0.05 + Math.sin(this.bob * 0.5) * 0.004, 'YXZ');
        cam.quaternion.setFromEuler(this.euler);
        if(Math.abs(cam.fov - this.fov) > 0.05) { cam.fov = this.fov; cam.updateProjectionMatrix(); }
    }
}
