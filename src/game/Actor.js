/**
 * What the player and the bots have in common: a CharacterBody, a team, health with regeneration, a carried crate,
 * the mason's stone budget, a bunker buster per life, and the colliders their own rays and movement pass through.
 */
import { CharacterBody } from './CharacterBody.js';
import { WEAPONS } from './weapons/defs.js';

export const MAX_HEALTH = 100;
export const RESPAWN_S = 4;
export const REGEN_DELAY = 5, REGEN_PER_S = 15;

export class Actor {
    constructor(game, { team, name, spawn, isPlayer = false }) {
        this.game = game;
        this.team = team;
        this.name = name;
        this.isPlayer = isPlayer;
        this.local = true;     // simulated on this client (online: the own player, and the host's bots; src/game/NetGame.js)
        this.netId = null;     // online: 'p:<client>' or 'b:<team><i>'
        this.spawn = spawn;
        this.body = new CharacterBody(game.ctx, { position: spawn, owner: this });
        game.actorByCollider.set(this.body.collider.handle, this);
        this.health = MAX_HEALTH;
        this.alive = true;
        this.respawnIn = 0;
        this.sinceHit = 99;
        this.carrying = null;
        this.held = null;
        this.stone = WEAPONS.mason.budget;
        this.stoneRegen = 0;
        this.busters = WEAPONS.buster.perLife;
        this.temp = new Map(); // collider handle -> seconds left
        this.kills = 0; this.deaths = 0;
        this._ign = new Set();
    }
    /** A person playing (this client's player, or another client's): bots hurt people less (BOT_DAMAGE_SCALE). */
    get isHuman() { return this.isPlayer; }
    /** Where it is drawn (bots interpolate between their 30 Hz ticks). */
    get viewCenter() { return this.view ?? this.body.center; }
    /** Collider handles this actor's rays and movement ignore. */
    ignoreHandles() {
        const s = this._ign; s.clear();
        s.add(this.body.collider.handle);
        if(this.held) s.add(this.held.collider.handle);
        if(this.carrying) s.add(this.carrying.prop.collider.handle);
        for(const h of this.temp.keys()) s.add(h);
        return s;
    }
    ignoreTemp(handle, seconds) { this.temp.set(handle, seconds); }
    addStone(volume) {
        const m = WEAPONS.mason;
        if(volume > 0.02) this.stone = Math.min(m.budget, this.stone + volume * m.digYield);
    }
    tickCommon(dt) {
        for(const [h, t] of this.temp) { if(t - dt <= 0) this.temp.delete(h); else this.temp.set(h, t - dt); }
        // the controller passes through what we hold and carry
        const ign = this.body.ignore; ign.clear();
        if(this.held) ign.add(this.held.collider.handle);
        if(this.carrying) ign.add(this.carrying.prop.collider.handle);
        for(const h of this.temp.keys()) ign.add(h);
        if(!this.alive) return;
        this.sinceHit += dt;
        if(this.sinceHit > REGEN_DELAY && this.health < MAX_HEALTH) this.health = Math.min(MAX_HEALTH, this.health + REGEN_PER_S * dt);
        const m = WEAPONS.mason;
        if(this.stone < m.budget) { this.stoneRegen += dt; if(this.stoneRegen >= m.regen) { this.stoneRegen = 0; this.stone = Math.min(m.budget, this.stone + 1); } }
    }
    respawn() {
        this.alive = true;
        this.health = MAX_HEALTH;
        this.busters = WEAPONS.buster.perLife;
        this.stone = Math.max(this.stone, WEAPONS.mason.budget / 2);
        this.sinceHit = 99;
        this.body.collider.setEnabled(true);
        const s = this.spawn;
        this.body.teleport([s[0] + (Math.random() - 0.5) * 2, s[1] + 0.3, s[2] + (Math.random() - 0.5) * 2]);
    }
    die() {
        this.alive = false;
        this.respawnIn = RESPAWN_S;
        this.deaths++;
        this.body.collider.setEnabled(false);
    }
}
