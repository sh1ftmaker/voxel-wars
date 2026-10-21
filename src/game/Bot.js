/**
 * A Blue bot. Cheap and direct: it picks a goal (the nearest crate it can steal, or home to its vault when carrying),
 * walks straight at it and drills straight through whatever is in the way, so the bots keep tunnelling the world
 * open. When it sees the player it turns and fires rockets (lead and a little error); up close it punches.
 * Thinking runs a few times a second; moving runs every frame (a CharacterBody like the player's).
 */
import * as THREE from 'three/webgpu';
import { Actor } from './Actor.js';
import { WEAPONS } from './weapons/defs.js';
import { makeAvatar } from './avatar.js';

const BOT_STEP = 1 / 30;
const SPEED = 7.2, JUMP = 19, CARRY_SLOW = 0.8, START_DELAY = 5;
const RAMP = 0.5; // rad: how steep a bot digs up toward something above it
const _e = new THREE.Vector3(), _t = new THREE.Vector3();
/** Stands in for "no enemy at all" (a room where every human is on one team and bots are off). */
const NOBODY = { alive: false, carrying: null, body: { center: new THREE.Vector3(), vel: new THREE.Vector3(), grounded: true, eye: (o) => o.set(0, -999, 0) } };

export class Bot extends Actor {
    constructor(game, opts) {
        super(game, opts);
        this.yaw = 0;
        this.aimPitch = 0;
        this.goal = null;          // [x, y, z]
        this.goalKind = '';
        this.think = Math.random() * 0.4;
        this.cool = { rocket: 1.5 + Math.random() * 2, drill: 0, punch: 0, look: 0 };
        this.stuck = 0;
        this.lastPos = new THREE.Vector3().copy(this.body.center);
        this.progressT = 0;
        this.seesPlayer = false;
        this.reaction = 0;
        this.skill = opts.skill ?? 0.5;
        this.role = opts.role ?? 'raider';
        this.dropCooldown = 0;
        this.digging = 0;
        this.mesh = this.makeMesh(opts.color ?? 0x3a7be0);
        game.ctx.scene.add(this.mesh);
        this.walk = 0;
        this._eye = [0, 0, 0]; this._aim = [0, 0, 0]; this._dir = [0, 0, 0]; this._dig = [0, 0, 0];
        this.avoid = new Map(); this.bestD = Infinity; this.bestT = 0;
        this.think = Math.random() * 0.5; // staggered: bots never think on the same frame
        this.acc = (opts.phase ?? Math.random()) * BOT_STEP;
        this.prev = new THREE.Vector3().copy(this.body.center);
        this.view = new THREE.Vector3().copy(this.body.center);
    }
    makeMesh(color) {
        const av = makeAvatar(color);
        this.gun = av.gun; this.legs = av.legs;
        return av.group;
    }
    eye(out = this._eye) { this.body.eye(_e); out[0] = _e.x; out[1] = _e.y; out[2] = _e.z; return out; }
    aimDir(out = this._aim) { const cp = Math.cos(this.aimPitch); out[0] = -Math.sin(this.yaw) * cp; out[1] = Math.sin(this.aimPitch); out[2] = -Math.cos(this.yaw) * cp; return out; }

    /** The enemy this bot cares about: in single player the player; online the nearest living enemy (a crate
     *  carrier within 30 m first). */
    foe() {
        const game = this.game;
        if(!game.netGame) return game.player.team !== this.team ? game.player : NOBODY;
        const me = this.body.center;
        let best = null, bd = Infinity;
        for(const a of game.actors) {
            if(!a.alive || a.team === this.team) continue;
            const d = a.body.center.distanceTo(me) - (a.carrying ? 30 : 0);
            if(d < bd) { bd = d; best = a; }
        }
        return best || NOBODY;
    }
    chooseGoal() {
        const game = this.game, me = this.body.center;
        const pl = this.foe();
        const prevCrate = this.goalCrate;
        this.goalCrate = null;
        if(this.role === 'defender' && !this.carrying) {
            // guard: go after a player who comes over to our side or carries one of our crates, else hang around the vault door
            const pc = pl.body.center;
            if(pl.alive && (pl.carrying || (this.team === 'blue' ? pc.x > 8 : pc.x < -8))) { this.goal = [pc.x, pc.y, pc.z]; this.goalKind = 'hunt'; return; }
            const v = game.crates.vaults[this.team], s = this.team === 'blue' ? 1 : -1;
            this.goal = [s * 44 + (Math.random() - 0.5) * 10, 0.2, (Math.random() - 0.5) * 16]; this.goalKind = 'guard'; return;
        }
        if(this.carrying) { const v = game.crates.vaults[this.team]; this.goal = [(v.min[0] + v.max[0]) / 2, v.min[1] + 1.2, (v.min[2] + v.max[2]) / 2]; this.goalKind = 'home'; return; }
        // a player carrying a crate nearby: chase him down
        if(pl.alive && pl.carrying && pl.body.center.distanceTo(me) < 30) { const c = pl.body.center; this.goal = [c.x, c.y, c.z]; this.goalKind = 'chase'; return; }
        let best = null, bd = Infinity;
        for(const c of game.crates.list) {
            if(c.carrier || c.vault === this.team) continue;
            if((this.avoid.get(c) ?? -1) > game.elapsed) continue; // gave up on this one a moment ago
            const t = c.prop.body.translation();
            // spread out: crates a teammate already goes for cost more
            const taken = game.bots.some(b => b !== this && b.goalCrate === c);
            const d = Math.hypot(t.x - me.x, (t.y - me.y) * 1.5, t.z - me.z) + (taken ? 25 : 0) + (c.vault ? -6 : 0);
            if(d < bd) { bd = d; best = c; }
        }
        if(best !== prevCrate) { this.bestD = Infinity; this.bestT = game.elapsed; }
        this.goalCrate = best;
        if(best) { const t = best.prop.body.translation(); this.goal = [t.x, t.y, t.z]; this.goalKind = 'crate'; }
        else { const c = pl.body.center; this.goal = [c.x, c.y, c.z]; this.goalKind = 'hunt'; }
    }

    /** Line of sight from our eye to the player's eye (nothing but the player in between). */
    canSee(target) {
        const e = this.eye(), t = target.body.eye(_t), d = this._dir;
        d[0] = t.x - e[0]; d[1] = t.y - e[1]; d[2] = t.z - e[2];
        const L = Math.hypot(d[0], d[1], d[2]);
        if(L > 55) return false;
        d[0] /= L; d[1] /= L; d[2] /= L;
        const hit = this.game.combat.raycast(e, d, L, this);
        return !hit || hit.actor === target;
    }

    /** Bots simulate at a fixed 30 Hz, each on its own phase (so they never all land on one frame); between
     *  ticks their meshes interpolate. At 240 fps that is an eighth of the controller work. */
    update(dt) {
        this.acc += dt;
        if(this.acc >= BOT_STEP) {
            const h = Math.min(this.acc, 0.1);
            this.acc = this.acc >= BOT_STEP * 2 ? 0 : this.acc - BOT_STEP;
            this.prev.copy(this.body.center);
            this.tick(h);
        }
        if(this.alive) this.place(Math.min(1, this.acc / BOT_STEP));
    }
    tick(dt) {
        this.tickCommon(dt);
        for(const k in this.cool) this.cool[k] -= dt;
        this.dropCooldown -= dt;
        if(!this.alive) { this.mesh.visible = false; return; }
        this.mesh.visible = true;
        const game = this.game, body = this.body, me = body.center;
        if(game.over) { body.step(dt, 0, 0); this.pose(dt, 0); return; }
        this.think -= dt;
        const pl = this.target && this.target.alive ? this.target : (this.target = this.foe());
        if(this.think <= 0) {
            this.think = 0.35 + Math.random() * 0.2;
            this.target = this.foe();
            if(!this.goal || this.goalKind !== 'crate' || !this.goalCrate || this.goalCrate.carrier || Math.random() < 0.3) this.chooseGoal();
            else { const t = this.goalCrate.prop.body.translation(); this.goal = [t.x, t.y, t.z]; }
            // no progress toward a crate for a long while (it sits somewhere we cannot dig up to): try another
            if(this.goalKind === 'crate' && this.goalCrate) {
                const t = this.goalCrate.prop.body.translation(), dd = Math.hypot(t.x - me.x, t.y - me.y, t.z - me.z);
                if(dd < this.bestD - 1) { this.bestD = dd; this.bestT = game.elapsed; }
                else if(game.elapsed - this.bestT > 12) { this.avoid.set(this.goalCrate, game.elapsed + 40); this.goalCrate = null; this.climbing = false; this.chooseGoal(); }
            }
            const was = this.seesPlayer;
            this.seesPlayer = pl.alive && this.canSee(pl);
            if(this.seesPlayer && !was) this.reaction = 0.5 + (1 - this.skill) * 0.5;
        }
        this.reaction -= dt;
        // where to go
        const g = this.goal || [me.x, me.y, me.z];
        const dx = g[0] - me.x, dy = g[1] - (me.y - 0.9), dz = g[2] - me.z, hd = Math.hypot(dx, dz);
        let moveYaw = Math.atan2(-dx, -dz);
        // right over (or under) the goal: keep moving, so it digs a ramp down (or up) to it instead of waiting there
        let wish = hd > 0.6 || Math.abs(dy) > 1.6 ? SPEED * (this.carrying ? CARRY_SLOW : 1) : 0;
        if(this.goalKind === 'guard' && hd < 3) wish = 0;
        if(game.elapsed < START_DELAY) wish = 0;
        // progress check: stuck against something for a while -> dig through it
        this.progressT += dt;
        if(this.progressT > 0.5) {
            const moved = Math.hypot(me.x - this.lastPos.x, me.z - this.lastPos.z);
            this.stuck = moved < 0.8 && wish > 0 ? this.stuck + this.progressT : Math.max(0, this.stuck - this.progressT * 2);
            this.lastPos.copy(me); this.progressT = 0;
        }

        // digging pitch: straight at the goal, kept walkable
        let digPitch = Math.atan2(dy, Math.max(hd, 0.1));
        const below = dy < -1.2 && hd < Math.max(6, -dy * 2.5);
        let above = dy > 1.6 && hd < dy * 4;
        // something high up: back off far enough to dig a walkable ramp up to it
        if(above) {
            const need = dy / Math.tan(RAMP);
            if(!this.climbing && (hd >= need * 0.75 || this.goalKind === 'hunt')) this.climbing = true;
            if(!this.climbing) { moveYaw += Math.PI; digPitch = 0; above = false; wish = SPEED; }
            else digPitch = Math.min(RAMP + 0.05, Math.atan2(dy, hd));
        } else this.climbing = false;
        digPitch = Math.max(-0.75, Math.min(0.6, digPitch));
        const wantDig = below || (above && this.stuck > 0.3) || this.stuck > 0.4;
        // combat: face and shoot the player
        let aimYaw = moveYaw, aimPitch = digPitch;
        let fight = false;
        if(this.seesPlayer && pl.alive && this.reaction <= 0) {
            const e = this.eye(), t = pl.body.center;
            const dist = Math.hypot(t.x - e[0], t.z - e[2]);
            // lead the target a little
            const tl = dist / WEAPONS.rocket.speed;
            const tx = t.x + pl.body.vel.x * tl * this.skill, ty = t.y - 0.3 + (pl.body.grounded ? 0 : pl.body.vel.y * tl * 0.3), tz = t.z + pl.body.vel.z * tl * this.skill;
            const ax = tx - e[0], ay = ty - e[1], az = tz - e[2];
            aimYaw = Math.atan2(-ax, -az);
            aimPitch = Math.atan2(ay, Math.hypot(ax, az)) + Math.hypot(ax, az) * 0.004; // rockets drop a little
            fight = dist < 40;
            if(dist < 2.6 && this.cool.punch <= 0) {
                this.cool.punch = 0.7; this.yaw = aimYaw; this.aimPitch = aimPitch;
                game.combat.punch(this, e, this.aimDir());
            } else if(fight && this.cool.rocket <= 0 && dist > 4) {
                this.cool.rocket = 2.0 + Math.random() * 1.6 - this.skill * 0.6;
                const err = (1.3 - this.skill) * 0.11;
                this.yaw = aimYaw + (Math.random() - 0.5) * err; this.aimPitch = aimPitch + (Math.random() - 0.5) * err;
                game.combat.fireRocket(this, this.muzzle(), this.aimDir());
            }
            // strafe a little while fighting, unless carrying (then run home)
            if(fight && !this.carrying && this.goalKind !== 'crate') { moveYaw += Math.sin(performance.now() / 600 + this.skill * 9) * 1.2; wish = dist > 12 ? SPEED : SPEED * 0.6; }
        }
        // turn the body toward the aim (smoothly)
        const targetYaw = fight ? aimYaw : moveYaw;
        let dyaw = ((targetYaw - this.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        this.yaw += dyaw * Math.min(1, dt * 8);
        if(!fight) this.aimPitch += (digPitch - this.aimPitch) * Math.min(1, dt * 8);
        // dig toward the goal when it is below / above / something blocks the way
        if(wantDig && this.cool.drill <= 0 && wish > 0) {
            this.cool.drill = WEAPONS.drill.cooldown * 1.5;
            const cp = Math.cos(digPitch);
            const dd = this._dig; dd[0] = -Math.sin(moveYaw) * cp; dd[1] = Math.sin(digPitch); dd[2] = -Math.cos(moveYaw) * cp;
            const vol = game.combat.dig(this, dd);
            this.digging = 0.5;
            // hard rock barely gives: blast it
            if(vol < 0.15 && this.stuck > 2.5 && this.cool.rocket <= 0) {
                this.cool.rocket = 2.5;
                const d = [-Math.sin(moveYaw), Math.max(-0.5, Math.min(0.5, digPitch)), -Math.cos(moveYaw)];
                game.combat.fireRocket(this, this.eye(), d);
                this.stuck = 0;
            }
        }
        this.digging -= dt;
        const jump = (this.stuck > 0.6 && body.grounded && Math.random() < 0.15) || (above && body.grounded && Math.random() < 0.05);
        if(this.stuck > 6) { this.stuck = 0; this.chooseGoal(); }
        const sp = this.digging > 0 && wantDig ? wish * 0.7 : wish;
        body.step(dt, -Math.sin(moveYaw) * sp, -Math.cos(moveYaw) * sp, { jump, jumpSpeed: JUMP, accel: 60 });
        if(me.y < -24) game.damage(this, 1000, null, null, 'fell');
        this.pose(dt, Math.hypot(body.vel.x, body.vel.z));
    }
    muzzle() { const e = this.eye(); const c = Math.cos(this.yaw), s = Math.sin(this.yaw); return [e[0] + c * 0.36, e[1] - 0.35, e[2] - s * 0.36]; }
    /** Mesh between the last two simulated positions (k 0..1). */
    place(k) {
        const c = this.body.center, p = this.prev, m = this.mesh, drop = this.body.radius + this.body.halfHeight;
        this.view.set(p.x + (c.x - p.x) * k, p.y + (c.y - p.y) * k, p.z + (c.z - p.z) * k);
        m.position.set(this.view.x, this.view.y - drop, this.view.z);
    }
    pose(dt, speed) {
        const m = this.mesh;
        m.rotation.y = this.yaw;
        this.walk += dt * speed * 1.4;
        const s = speed > 0.5 ? Math.sin(this.walk) : 0;
        this.legs[0].rotation.x = s * 0.6; this.legs[1].rotation.x = -s * 0.6;
        this.gun.rotation.x = Math.PI / 2 + this.aimPitch;
    }
    respawn() { super.respawn(); this.prev.copy(this.body.center); this.view.copy(this.body.center); this.goal = null; this.stuck = 0; this.cool.rocket = 2; }
    dispose() { this.mesh.removeFromParent(); }
}
