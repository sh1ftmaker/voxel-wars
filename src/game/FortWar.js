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
 * Online (?room=name, ctx.net not single): src/game/NetGame.js joins the match: teams are balanced by the host, the
 * other players appear as RemoteActors, bots run on the host only (filling both teams), and the host keeps health,
 * crates, the score and the clock.
 *
 * URL: ?bots=N (0..5, default 3), ?minutes=M (default 10), ?music=0, ?touch=1 (force touch controls), ?name=Nick.
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
import { NetGame } from './NetGame.js';
import { TEAM_COLOR } from './avatar.js';

const BOT_NAMES = { blue: ['Blue Barry', 'Blue Bonnie', 'Blue Boris', 'Blue Bea', 'Blue Bruno'], red: ['Red Rex', 'Red Ruby', 'Red Rory', 'Red Rosa', 'Red Rudy'] };

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
        this.player.netId = `p:${ctx.net?.id ?? 'local'}`;
        this.actors.push(this.player);
        this.bots = [];
        const online = ctx.net && !ctx.net.single;
        // bots: ?bots=N wins; else the saved choice (HUD toggle); else 3
        const q = p.get('bots');
        let saved = null; try { saved = localStorage.getItem('bananza.bots'); } catch(e) {}
        this.botCount = q != null ? Math.max(0, Math.min(5, +q || 0)) : 3;
        this.botsOn = q != null ? this.botCount > 0 : saved !== '0';
        if(this.botCount === 0) this.botCount = 3; // turning them on later brings the usual three
        // online the host runs the bots (NetGame fills both teams with them)
        if(online) this.netGame = new NetGame(this);
        else if(this.botsOn) this.spawnBots();
        this.hud = new Hud(this);
        this.netGame?.start();
        this.score = { red: 0, blue: 0 };
        this.on('death', ({ actor, by }) => { if(by && by !== actor) by.kills++; });
        this.emit('hint', { text: this.input.touch ? 'Left thumb: move · drag right: look · grab the crates, bank them in your vault' : 'Click to play · WASD + mouse · steal the crates and bank them in your vault (under your fort)', long: true });
    }

    on(name, fn) { if(!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(fn); }
    emit(name, detail = {}) {
        this.netGame?.mirror(name, detail);
        const fns = this.listeners.get(name);
        if(fns) for(const fn of fns) { try { fn(detail); } catch(e) { console.error(`game event ${name}`, e); } }
        this.ctx.events.dispatchEvent(new CustomEvent(name, { detail }));
    }

    damage(actor, amount, by, impulse, cause) {
        if(this.netGame) return this.netGame.damage(actor, amount, by, impulse, cause);
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
            if(this.timeLeft <= 0 && (!this.netGame || this.netGame.isHost)) this.endMatch(); // online the host ends it
        }
        this.player.update(dt);
        for(const b of this.bots) b.update(dt);
        if(this.netGame) this.netGame.update(dt); // remote actors, streams, respawns (host)
        else for(const a of this.actors) if(!a.alive && !this.over) { a.respawnIn -= dt; if(a.respawnIn <= 0) { a.respawn(); this.emit('respawn', { actor: a }); } }
        this.combat.update(dt);
        this.crates.update(dt);
        this.score.red = this.crates.count('red');
        this.score.blue = this.crates.count('blue');
        this.fx.update(dt);
        this.sfx.listen(this.ctx.camera);
        this.music.update(dt);
        this.hud.update(dt);
    }

    endMatch(score = null) {
        if(this.over) return;
        this.over = true;
        if(score) Object.assign(this.score, score);
        const mine = this.score[this.player.team], theirs = this.score[this.player.team === 'red' ? 'blue' : 'red'];
        this.result = mine > theirs ? 'win' : mine < theirs ? 'loss' : 'draw';
        this.netGame?.over();
        if(document.pointerLockElement) document.exitPointerLock();
        this.emit('matchOver', { result: this.result, score: { ...this.score } });
    }
    restart() { if(this.netGame) this.netGame.restart(); else location.reload(); }

    spawnBots() {
        const n = this.botCount;
        for(let i = 0; i < n; i++) this.addBot('blue', i, n);
    }
    /** Bot i of n on `team` (its name, spawn point, skill and role follow from i). */
    addBot(team, i, n, at = null) {
        const T = GAME.teams[team];
        const b = new Bot(this, { team, name: BOT_NAMES[team][i % 5], spawn: T.spawns[i % T.spawns.length], skill: 0.35 + 0.2 * (i % 3), role: i === 0 && n >= 3 ? 'defender' : 'raider', phase: i / n, color: TEAM_COLOR[team] });
        b.netId = `b:${team}${i}`;
        b.yaw = team === 'blue' ? Math.PI / 2 : -Math.PI / 2; // face the enemy fort
        if(at) { b.body.teleport(at); b.prev.copy(b.body.center); b.view.copy(b.body.center); }
        this.bots.push(b); this.actors.push(b);
        return b;
    }
    removeBot(b) {
        if(b.carrying && this.crates.authority) this.crates.drop(b.carrying);
        if(b.held) b.held = null;
        this.actorByCollider.delete(b.body.collider.handle);
        b.body.dispose();
        b.dispose();
        this.actors = this.actors.filter(a => a !== b);
        this.bots = this.bots.filter(a => a !== b);
    }
    removeBots() { for(const b of [...this.bots]) this.removeBot(b); }
    /** HUD toggle: bots on or off, live; the choice is remembered. */
    setBots(on) {
        on = !!on;
        if(on === this.botsOn) return;
        if(this.netGame && !this.netGame.isHost) { this.emit('hint', { text: 'The host decides about bots' }); return; }
        this.botsOn = on;
        try { localStorage.setItem('bananza.bots', on ? '1' : '0'); } catch(e) {}
        if(this.netGame) this.netGame.fillBots();
        else if(on) this.spawnBots(); else this.removeBots();
        this.emit('hint', { text: on ? 'Blue bots are in the game' : 'Bots off: the fort is yours to wreck' });
    }
    get maxHealth() { return MAX_HEALTH; }
}
