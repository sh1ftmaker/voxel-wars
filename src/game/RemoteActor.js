/**
 * Another client's player, or a bot the host runs, seen on this client (src/game/NetGame.js). It is not simulated
 * here: its owner streams its state (position, velocity, yaw, pitch, flags) and this draws it INTERP_DELAY behind the
 * owner's clock, interpolating between samples (extrapolating briefly past the last one). Its CharacterBody's
 * kinematic capsule follows the drawn position, so rays, rockets, explosions and bodies hit it as they would a local
 * actor; health, death and respawn come from the host.
 *
 *   ra.push(t, state)    a sample: t = the owner's clock (ms), state = { p: [x,y,z] (capsule centre), v, yaw, pitch, flags }
 *   ra.update(dt, now)   now = this client's clock mapped onto the owner's (ms)
 */
import * as THREE from 'three/webgpu';
import { Actor, MAX_HEALTH, REGEN_DELAY, REGEN_PER_S } from './Actor.js';
import { makeAvatar, TEAM_COLOR } from './avatar.js';

export const INTERP_DELAY = 100;   // ms
const EXTRAPOLATE = 250;           // ms past the last sample, at most
const KEEP = 30;                   // samples kept
export const F_ALIVE = 1, F_GROUNDED = 2;

export class RemoteActor extends Actor {
    constructor(game, { netId, team, name, spawn, bot = false, client = null }) {
        super(game, { team, name, spawn });
        this.netId = netId;
        this.local = false;
        this.isBot = bot;
        this.client = client;
        this.yaw = 0; this.pitch = 0; this.aimPitch = 0;
        this.view = new THREE.Vector3().copy(this.body.center);
        this.buf = [];
        this.walk = 0;
        const av = makeAvatar(TEAM_COLOR[team] ?? 0x888888);
        this.mesh = av.group; this.gun = av.gun; this.legs = av.legs;
        game.ctx.scene.add(this.mesh);
        this.mesh.visible = false; // until its first sample
        this._v = new THREE.Vector3();
    }
    get isHuman() { return !this.isBot; }
    setTeam(team) {
        if(team === this.team) return;
        this.team = team;
        this.mesh.removeFromParent();
        const av = makeAvatar(TEAM_COLOR[team] ?? 0x888888);
        const vis = this.mesh.visible;
        this.mesh = av.group; this.gun = av.gun; this.legs = av.legs; this.mesh.visible = vis;
        this.game.ctx.scene.add(this.mesh);
    }
    push(t, s) {
        const b = this.buf;
        if(b.length && t <= b[b.length - 1].t) return; // out of order or repeated
        b.push({ t, p: s.p, v: s.v, yaw: s.yaw, pitch: s.pitch, flags: s.flags });
        if(b.length > KEEP) b.shift();
    }
    /** Where the owner was at owner-time `t`. */
    sample(t) {
        const b = this.buf, n = b.length;
        if(!n) return null;
        if(t <= b[0].t) return b[0];
        for(let i = n - 1; i > 0; i--) {
            const a = b[i - 1], c = b[i];
            if(t >= a.t && t <= c.t) {
                const k = (t - a.t) / Math.max(1, c.t - a.t);
                const dy = ((c.yaw - a.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
                return { p: [a.p[0] + (c.p[0] - a.p[0]) * k, a.p[1] + (c.p[1] - a.p[1]) * k, a.p[2] + (c.p[2] - a.p[2]) * k],
                    v: c.v, yaw: a.yaw + dy * k, pitch: a.pitch + (c.pitch - a.pitch) * k, flags: c.flags };
            }
        }
        const l = b[n - 1], e = Math.min(EXTRAPOLATE, t - l.t) / 1000;
        return { p: [l.p[0] + l.v[0] * e, l.p[1] + l.v[1] * e, l.p[2] + l.v[2] * e], v: l.v, yaw: l.yaw, pitch: l.pitch, flags: l.flags };
    }
    update(dt, now) {
        const s = this.sample(now - INTERP_DELAY);
        if(s) {
            const c = this.body.center;
            // a big jump (respawn, teleport): no sliding across the map
            c.set(s.p[0], s.p[1], s.p[2]);
            this.body.vel.set(s.v[0], s.v[1], s.v[2]);
            this.body.grounded = !!(s.flags & F_GROUNDED);
            this.yaw = s.yaw; this.pitch = this.aimPitch = s.pitch;
            this.view.copy(c);
            this.body.body.setNextKinematicTranslation(c);
        }
        // the host keeps everyone's health: remote actors regenerate there like local ones
        if(this.alive && this.game.netGame?.isHost) {
            this.sinceHit += dt;
            if(this.sinceHit > REGEN_DELAY && this.health < MAX_HEALTH) this.health = Math.min(MAX_HEALTH, this.health + REGEN_PER_S * dt);
        }
        const m = this.mesh;
        m.visible = this.alive && !!s;
        if(!m.visible) return;
        const drop = this.body.radius + this.body.halfHeight;
        m.position.set(this.view.x, this.view.y - drop, this.view.z);
        m.rotation.y = this.yaw;
        const speed = Math.hypot(this.body.vel.x, this.body.vel.z);
        this.walk += dt * speed * 1.4;
        const sw = speed > 0.5 && this.body.grounded ? Math.sin(this.walk) : 0;
        this.legs[0].rotation.x = sw * 0.6; this.legs[1].rotation.x = -sw * 0.6;
        this.gun.rotation.x = Math.PI / 2 + this.pitch;
    }
    eye(out = [0, 0, 0]) { this.body.eye(this._v); out[0] = this._v.x; out[1] = this._v.y; out[2] = this._v.z; return out; }
    aimDir(out = [0, 0, 0]) { const cp = Math.cos(this.pitch); out[0] = -Math.sin(this.yaw) * cp; out[1] = Math.sin(this.pitch); out[2] = -Math.cos(this.yaw) * cp; return out; }
    /** Alive again (the owner moves it; the host decided when). */
    respawn() {
        this.alive = true;
        this.health = MAX_HEALTH;
        this.sinceHit = 99;
        this.body.collider.setEnabled(true);
        this.buf.length = 0; // no interpolating from where it died
    }
    dispose() {
        this.mesh.removeFromParent();
        this.game.actorByCollider.delete(this.body.collider.handle);
        this.body.dispose();
    }
}
