/**
 * Fort War, single player. You are Red; Blue is a few bots. Supply crates lie around the level and buried in caches;
 * carry them into your vault (under your fort) to score, steal the enemy's. Most crates banked when the clock runs
 * out wins. This is the game system main.js adds: it owns the actors, the combat mechanics, the crates, the HUD, the
 * effects and the sounds, and exposes itself as ctx.game for tests.
 *
 * Game events (game.on / game.emit; also dispatched on ctx.events): explosion, rocket, punch, dig, build, rip, throw,
 * slam, bounce, fuse, fired, tool, hint, damage { actor, amount, by, cause }, death { actor, by, cause },
 * respawn { actor }, pickup { crate, actor, from }, deposit { crate, actor }, step, jump, land, matchOver { result }.
 *
 * URL: ?bots=N (0..5, default 3), ?minutes=M (default 10), ?music=0, ?touch=1 (force touch controls).
 */
import { GAME } from '../level/fortwar.js';
import { Input } from './Input.js';
import { Player } from './Player.js';
import { Bot } from './Bot.js';
import { Crates } from './Crates.js';
import { Combat } from './weapons/Combat.js';
import { Hud } from '../ui/Hud.js';
import { Fx } from '../fx/Fx.js';
import { Sfx } from '../audio/Sfx.js';
import { Music } from '../audio/Music.js';
import { MAX_HEALTH } from './Actor.js';

const BOT_NAMES = ['Blue Barry', 'Blue Bonnie', 'Blue Boris', 'Blue Bea', 'Blue Bruno'];

export class FortWar {
    constructor(ctx) {
        this.ctx = ctx;
        ctx.game = this;
        this.listeners = new Map();
        this.actors = [];
        this.actorByCollider = new Map();
        const p = ctx.params;
        this.matchTime = Math.max(0.5, +(p.get('minutes') || 10)) * 60;
        this.timeLeft = this.matchTime;
        this.over = false;
        this.result = null;
        this.started = false;
        this.sfx = new Sfx(this);
        this.music = new Music(this, this.sfx);
        this.fx = new Fx(this);
        this.combat = new Combat(this);
        this.crates = new Crates(this);
        this.input = new Input(ctx);
        const red = GAME.teams.red, blue = GAME.teams.blue;
        this.player = new Player(this, this.input, { team: 'red', name: 'You', spawn: red.spawns[1] });
        this.actors.push(this.player);
        this.bots = [];
        // bots: ?bots=N wins; else the saved choice (HUD toggle); else 3
        const q = p.get('bots');
        let saved = null; try { saved = localStorage.getItem('bananza.bots'); } catch(e) {}
        this.botCount = q != null ? Math.max(0, Math.min(5, +q || 0)) : 3;
        this.botsOn = q != null ? this.botCount > 0 : saved !== '0';
        if(ctx.net && !ctx.net.single && !ctx.net.isHost) this.botsOn = false; // in a room the host runs the bots
        if(this.botCount === 0) this.botCount = 3; // turning them on later brings the usual three
        if(this.botsOn) this.spawnBots();
        this.hud = new Hud(this);
        this.score = { red: 0, blue: 0 };
        this.on('death', ({ actor, by }) => { if(by && by !== actor) by.kills++; });
        this.emit('hint', { text: this.input.touch ? 'Left thumb: move · drag right: look · grab the crates, bank them in your vault' : 'Click to play · WASD + mouse · steal the crates and bank them in your vault (under your fort)', long: true });
    }

    on(name, fn) { if(!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(fn); }
    emit(name, detail = {}) {
        const fns = this.listeners.get(name);
        if(fns) for(const fn of fns) { try { fn(detail); } catch(e) { console.error(`game event ${name}`, e); } }
        this.ctx.events.dispatchEvent(new CustomEvent(name, { detail }));
    }

    damage(actor, amount, by, impulse, cause) {
        if(!actor.alive || this.over) return;
        if(impulse) actor.body.knock(impulse);
        if(amount <= 0) return;
        actor.health -= amount;
        actor.sinceHit = 0;
        this.emit('damage', { actor, amount, by, cause });
        if(actor.health <= 0) {
            actor.health = 0;
            if(actor.held && actor.isPlayer) actor.arsenal.release(false);
            else if(actor.held) actor.held = null;
            if(actor.carrying) this.crates.drop(actor.carrying);
            actor.die();
            this.emit('death', { actor, by, cause });
        }
    }

    update(dt) {
        if(!this.started) { this.started = true; this.emit('start', {}); }
        this.elapsed = (this.elapsed || 0) + dt;
        if(!this.over) {
            const before = this.timeLeft;
            this.timeLeft = Math.max(0, this.timeLeft - dt);
            if(before > 60 && this.timeLeft <= 60) this.emit('hint', { text: 'One minute left!' });
            if(this.timeLeft < 10 && Math.ceil(before) !== Math.ceil(this.timeLeft)) this.emit('tick', {});
            if(this.timeLeft <= 0) this.endMatch();
        }
        this.player.update(dt);
        for(const b of this.bots) b.update(dt);
        for(const a of this.actors) if(!a.alive && !this.over) { a.respawnIn -= dt; if(a.respawnIn <= 0) { a.respawn(); this.emit('respawn', { actor: a }); } }
        this.combat.update(dt);
        this.crates.update(dt);
        this.score.red = this.crates.count('red');
        this.score.blue = this.crates.count('blue');
        this.fx.update(dt);
        this.sfx.listen(this.ctx.camera);
        this.music.update(dt);
        this.hud.update(dt);
    }

    endMatch() {
        this.over = true;
        const r = this.score.red, b = this.score.blue;
        this.result = r > b ? 'win' : r < b ? 'loss' : 'draw';
        if(document.pointerLockElement) document.exitPointerLock();
        this.emit('matchOver', { result: this.result, score: { ...this.score } });
    }
    restart() { location.reload(); }

    spawnBots() {
        const blue = GAME.teams.blue, n = this.botCount;
        for(let i = 0; i < n; i++) {
            const b = new Bot(this, { team: 'blue', name: BOT_NAMES[i], spawn: blue.spawns[i % blue.spawns.length], skill: 0.35 + 0.2 * (i % 3), role: i === 0 && n >= 3 ? 'defender' : 'raider', phase: i / n });
            b.yaw = Math.PI / 2; // face Red
            this.bots.push(b); this.actors.push(b);
        }
    }
    removeBots() {
        for(const b of this.bots) {
            if(b.carrying) this.crates.drop(b.carrying);
            this.actorByCollider.delete(b.body.collider.handle);
            b.body.dispose();
            b.dispose();
        }
        this.actors = this.actors.filter(a => !this.bots.includes(a));
        this.bots = [];
    }
    /** HUD toggle: bots on or off, live; the choice is remembered. */
    setBots(on) {
        on = !!on;
        if(on === this.botsOn) return;
        this.botsOn = on;
        try { localStorage.setItem('bananza.bots', on ? '1' : '0'); } catch(e) {}
        if(on) this.spawnBots(); else this.removeBots();
        this.emit('hint', { text: on ? 'Blue bots are in the game' : 'Bots off: the fort is yours to wreck' });
    }
    get maxHealth() { return MAX_HEALTH; }
}
