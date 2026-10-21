/**
 * Online Fort War (?room=name): the game layer on top of the edit log (src/net). Terrain already stays in step
 * through the sequenced edits; this replicates everything else with plain messages (net.bcast / net.direct, not
 * sequenced):
 *
 *   actors   every client simulates its own player (the host also its bots) and streams it ('st', STATE_HZ):
 *            position, velocity, yaw, pitch, flags. Others draw it as a RemoteActor, INTERP_DELAY behind.
 *   roster   the host keeps who is in the match ('roster', and in 'game'): { id: netId, name, team, bot, client }.
 *            Joining clients say 'hello'; the host puts them on the team with fewer humans and fills both teams
 *            with bots (fillBots: each team gets max(3, the larger team's humans) actors while bots are on).
 *   actions  a local actor's rockets and bombs ('act'): others fly visual copies (Combat { visual }); bombs are
 *            bodies whose owner streams them and says 'gone' when they blow. Sounds and effects of local events
 *            (MIRROR) are re-emitted on the others ('ev').
 *   damage   whoever's weapon hit (its owner client) sends 'hit' { tg, by, a, i (knockback), c }; the target's
 *            owner applies the knockback, the host applies the damage and announces the result ('hp'; dead: the
 *            host also drops the carried crate). The host respawns the dead ('spawn'): an owner then moves its
 *            actor to its spawn point. Health regenerates on the host for everyone.
 *   match    the host runs the clock, crates (src/game/Crates.js 'crate') and the score; 'game' (GAME_HZ, and
 *            kept by the server for late joiners) carries all of it; 'over' ends the match everywhere.
 *   bodies   each body (debris, crates, bombs) has one owner client (VoxelBodies: what the terrain shed belongs to
 *            the host, a ripped lump to the ripper; whoever holds a body claims it ('own'), a thrown one goes back
 *            to the host when it rests). Owners stream their moving bodies ('bs', BODY_HZ: pose, velocity, held),
 *            sleeping ones now and then; other clients steer their copies toward it (blendBodies). A punch on
 *            someone else's body is sent to its owner ('push').
 *   host     when the host leaves, the next client becomes host: it takes over the bots where they were, the
 *            orphaned bodies, the crates and the clock (all clients reassign bodies of clients that left).
 *
 * Lockstep with box3d's deterministic physics would need every client to step the same inputs at the same tick
 * (and late joiners the world's full physics state), which variable frame rates, latency and late joins do not give
 * us; owners stream instead.
 */
import * as THREE from 'three/webgpu';
import { GAME } from '../level/fortwar.js';
import { RemoteActor, F_ALIVE, F_GROUNDED } from './RemoteActor.js';
import { MAX_HEALTH } from './Actor.js';
import { TEAM_COLOR } from './avatar.js';
import { BodyType } from '../physics/Physics.js';

const STATE_HZ = 25, BODY_HZ = 15, GAME_HZ = 1;
const MIRROR = new Set(['explosion', 'punch', 'dig', 'build', 'rip', 'throw', 'slam', 'land']);
const REFS = ['owner', 'actor', 'by'];
const MAX_HIT = 250;          // damage per hit message, at most
const BODY_MAX = 40;          // bodies per stream message
const REFRESH_MS = 3000;      // a resting body is re-sent this often (late joiners, lost messages)
const BODY_STALE = 1500;      // ms without news: a copy is left to its own physics
const ADJ = ['Swift', 'Brave', 'Rocky', 'Dusty', 'Lucky', 'Mighty', 'Sly', 'Jolly', 'Grumpy', 'Zippy'];
const NOUN = ['Mole', 'Badger', 'Golem', 'Miner', 'Ferret', 'Digger', 'Rook', 'Boulder', 'Gopher', 'Yeti'];

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _p = new THREE.Vector3();
const r2 = (v) => Math.round(v * 100) / 100;

export class NetGame {
    constructor(game) {
        this.game = game;
        this.ctx = game.ctx;
        const net = this.net = game.ctx.net;
        game.netGame = this;
        this.remotes = new Map();   // netId -> RemoteActor
        this.roster = new Map();    // netId -> { id, name, team, bot, client }
        this.left = new Map();      // client -> { team, at } (host: a client that left keeps its team for a while)
        this.clocks = new Map();    // client -> offset (ms) from its clock to ours
        this.idN = 0;
        this.stT = 0; this.bodyT = 0; this.gameT = 0;
        this.stats = { stOut: 0, stIn: 0, bodiesOut: 0, bodiesIn: 0, hits: 0, acts: 0, evs: 0 };
        this.name = this._name();
        const me = game.player;
        me.name = this.name;
        // my team: the one I had (a reload), else the one with fewer humans; the host confirms it
        const gs = net.gameState;
        const was = gs?.roster?.find(r => r.id === me.netId);
        this._setMyTeam(was?.team ?? this._balance(gs?.roster || [], me.netId), true);
        const on = (t, fn) => net.onMsg(t, (from, m) => fn.call(this, from, m));
        on('hello', this._onHello); on('roster', (f, m) => this._applyRoster(m.roster));
        on('st', this._onStates); on('ev', this._onEv); on('act', this._onAct);
        on('hit', this._onHit); on('hp', (f, m) => this._onHp(m)); on('spawn', this._onSpawn);
        on('game', this._onGame); on('over', (f, m) => game.endMatch(m.score));
        on('crate', (f, m) => { if(!this.isHost) game.crates.applyNet(m); });
        on('bs', this._onBodies); on('own', this._onOwn); on('push', this._onPush);
        on('gone', (f, m) => game.combat.removeFusedById(m.id));
        on('peer', (f, m) => this._onPeer(m));
        on('host', () => this._onHostChange());
        on('reset', () => location.reload());
        on('rejoined', () => { this._hello(); this.game.emit('hint', { text: 'Reconnected' }); });
        on('status', (f, m) => { if(m.status === 'closed') this.game.emit('hint', { text: 'Connection lost: reconnecting...', long: true }); });
        if(this.isHost) this._startHost(gs);
        else { if(gs) this._onGame(null, gs); this._hello(); }
    }
    get isHost() { return this.net.isHost; }
    get id() { return this.net.id; }
    send(m) { this.net.bcast(m); }
    /** A new id for something this client makes ('f' bombs). */
    newId(kind) { return `${kind}:${this.id}:${++this.idN}`; }
    actor(netId) {
        if(!netId) return null;
        if(netId === this.game.player.netId) return this.game.player;
        return this.remotes.get(netId) || this.game.bots.find(b => b.netId === netId) || null;
    }

    _name() {
        let n = this.ctx.params.get('name');
        try { if(n) localStorage.setItem('voxelwars.name', n); else n = localStorage.getItem('voxelwars.name'); } catch(e) {}
        if(!n) n = `${ADJ[Math.floor(Math.random() * ADJ.length)]} ${NOUN[Math.floor(Math.random() * NOUN.length)]}`;
        return n.slice(0, 20);
    }
    rename(n) {
        n = (n || '').trim().slice(0, 20); if(!n) return;
        this.name = this.game.player.name = n;
        try { localStorage.setItem('voxelwars.name', n); } catch(e) {}
        if(this.isHost) { const r = this.roster.get(this.game.player.netId); if(r) r.name = n; this._publish(); } else this._hello();
    }
    _balance(roster, me) {
        const n = { red: 0, blue: 0 };
        for(const r of roster) if(!r.bot && r.id !== me) n[r.team]++;
        return n.blue < n.red ? 'blue' : 'red';
    }
    _setMyTeam(team, first = false) {
        const p = this.game.player;
        if(p.team === team && !first) return;
        const changed = p.team !== team;
        p.team = team;
        const sp = GAME.teams[team].spawns;
        p.spawn = sp[(this.id.charCodeAt(0) + this.id.charCodeAt(1)) % sp.length];
        if(changed || first) { p.body.teleport(p.spawn); p.yaw = p.spawn[0] < 0 ? -Math.PI / 2 : Math.PI / 2; }
        if(changed && !first) this.game.emit('hint', { text: `You are on ${team === 'red' ? 'Red' : 'Blue'}` });
    }
    _hello() { this.send({ t: 'hello', id: this.game.player.netId, name: this.name, team: this.game.player.team }); }

    // ------------------------------------------------------------------ host: roster, bots, game state

    _startHost(gs) {
        const g = this.game, me = g.player;
        if(gs) {
            // a room that was running (the host left, or everyone did): the clock, the crates, who was where
            g.timeLeft = gs.time ?? g.timeLeft;
            if(gs.over) g.over = true;
            for(const c of gs.crates || []) { const cr = g.crates.list[c[0]]; if(cr && !c[1]) { cr.vault = c[2]; g.crates._place(cr, [c[3], c[4], c[5]], [0, 0, 0]); } }
            for(const r of gs.roster || []) if(!r.bot && r.client !== this.id && this.net.peers.has(r.client)) this.roster.set(r.id, { ...r });
            for(const r of this.roster.values()) this._remote(r);
        }
        this.roster.set(me.netId, { id: me.netId, name: this.name, team: me.team, bot: false, client: this.id });
        this.fillBots();
    }
    _onHello(from, m) {
        if(!this.isHost || typeof m.id !== 'string' || !m.id.startsWith('p:')) return;
        let r = this.roster.get(m.id);
        if(!r) {
            const team = this.left.get(from)?.team ?? (m.team === 'red' || m.team === 'blue' ? this._balanceWith(m.team, m.id) : this._balance([...this.roster.values()], m.id));
            r = { id: m.id, name: String(m.name || 'Player').slice(0, 20), team, bot: false, client: from };
            this.roster.set(m.id, r);
            this.game.emit('hint', { text: `${r.name} joined ${team === 'red' ? 'Red' : 'Blue'}` });
        } else r.name = String(m.name || r.name).slice(0, 20);
        this._remote(r);
        this.fillBots();
    }
    /** The team a joiner asked for (it guessed from the last game state), unless that unbalances the humans. */
    _balanceWith(want, id) {
        const n = { red: 0, blue: 0 };
        for(const r of this.roster.values()) if(!r.bot && r.id !== id) n[r.team]++;
        const other = want === 'red' ? 'blue' : 'red';
        return n[want] > n[other] ? other : want;
    }
    /** Bots fill both teams to the same size (host; bots on). */
    fillBots() {
        if(!this.isHost) return;
        const g = this.game, humans = { red: 0, blue: 0 };
        for(const r of this.roster.values()) if(!r.bot) humans[r.team]++;
        const size = g.botsOn ? Math.max(3, humans.red, humans.blue) : 0;
        for(const team of ['red', 'blue']) {
            const want = g.botsOn ? Math.max(0, size - humans[team]) : 0;
            const mine = g.bots.filter(b => b.team === team).sort((a, b) => a.netId.localeCompare(b.netId));
            while(mine.length > want) { const b = mine.pop(); this.roster.delete(b.netId); g.removeBot(b); }
            for(let i = 0; mine.length < want && i < 5; i++) {
                if(mine.some(b => b.netId === `b:${team}${i}`)) continue;
                const b = g.addBot(team, i, want);
                mine.push(b);
            }
        }
        for(const [id, r] of this.roster) if(r.bot && !g.bots.some(b => b.netId === id)) this.roster.delete(id);
        for(const b of g.bots) this.roster.set(b.netId, { id: b.netId, name: b.name, team: b.team, bot: true, client: this.id });
        this._publish();
    }
    _publish() {
        if(!this.isHost) return;
        this.send({ t: 'roster', roster: [...this.roster.values()] });
        this.gameT = 1 / GAME_HZ; // and a full state now
    }
    _gameState() {
        const g = this.game;
        return {
            t: 'game', time: r2(g.timeLeft), over: g.over, score: { ...g.score }, bots: g.botsOn, host: this.id,
            roster: [...this.roster.values()],
            actors: g.actors.map(a => [a.netId, Math.round(a.health), a.alive ? 1 : 0, a.kills, a.deaths]),
            crates: g.crates.list.map(c => { const t = c.prop.body.translation(); return [c.id, c.carrier?.netId ?? null, c.vault, r2(t.x), r2(t.y), r2(t.z)]; }),
        };
    }

    // ------------------------------------------------------------------ everyone: roster, game state

    /** A RemoteActor for a roster entry (not ours). */
    _remote(r) {
        if(r.id === this.game.player.netId || this.game.bots.some(b => b.netId === r.id)) return null;
        let ra = this.remotes.get(r.id);
        if(!ra) {
            const sp = GAME.teams[r.team].spawns;
            ra = new RemoteActor(this.game, { netId: r.id, team: r.team, name: r.name, spawn: sp[0], bot: !!r.bot, client: r.client });
            this.remotes.set(r.id, ra);
            this.game.actors.push(ra);
            this._label(ra);
        } else {
            ra.name = r.name; ra.client = r.client;
            if(ra.team !== r.team) { ra.setTeam(r.team); ra.spawn = GAME.teams[r.team].spawns[0]; }
            if(ra.label) { ra.label.textContent = r.name; ra.label.className = `bz-name ${r.team}`; }
        }
        return ra;
    }
    _dropRemote(ra) {
        if(ra.carrying && this.game.crates.authority) this.game.crates.drop(ra.carrying);
        this.remotes.delete(ra.netId);
        this.game.actors = this.game.actors.filter(a => a !== ra);
        ra.label?.remove();
        ra.dispose();
    }
    _applyRoster(list) {
        if(this.isHost || !Array.isArray(list)) return;
        const ids = new Set();
        for(const r of list) {
            ids.add(r.id);
            if(r.id === this.game.player.netId) { this._setMyTeam(r.team); continue; }
            this._remote(r);
        }
        for(const ra of [...this.remotes.values()]) if(!ids.has(ra.netId)) this._dropRemote(ra);
        this.rosterList = list;
    }
    _onGame(from, m) {
        if(this.isHost && from !== null) return;
        const g = this.game;
        this.lastGame = m;
        if(m.roster) this._applyRoster(m.roster);
        if(typeof m.time === 'number' && Math.abs(m.time - g.timeLeft) > 0.5) g.timeLeft = m.time;
        if(m.bots !== undefined) g.botsOn = m.bots;
        for(const [id, hp, alive, kills, deaths] of m.actors || []) {
            const a = this.actor(id); if(!a) continue;
            a.kills = kills; a.deaths = deaths;
            if(alive && !a.alive) { this._respawnActor(a); continue; }
            if(!alive && a.alive) { a.health = 0; this._kill(a, null, null, true); continue; }
            if(alive) a.health = hp;
        }
        if(!this.isHost) for(const [id, carrier, vault, x, y, z] of m.crates || []) {
            const c = g.crates.list[id]; if(!c) continue;
            const ca = carrier ? this.actor(carrier) : null;
            if(ca && c.carrier !== ca) g.crates.applyNet({ id, ev: 'pickup', c: carrier });
            else if(!ca && c.carrier) g.crates.applyNet({ id, ev: 'drop', c: null, vault, p: [x, y, z], v: [0, 0, 0] });
            else if(!ca) {
                c.vault = vault;
                const t = c.prop.body.translation();
                if(Math.hypot(t.x - x, t.y - y, t.z - z) > 3) g.crates._place(c, [x, y, z], [0, 0, 0]); // far off and no stream: put it there
            }
        }
        if(m.over && !g.over) g.endMatch(m.score);
    }
    over() { if(this.isHost) { this.send({ t: 'over', score: { ...this.game.score } }); this.send(this._gameState()); } }
    restart() {
        if(this.isHost) this.net.transport.send({ t: 'reset' });
        else this.game.emit('hint', { text: 'The host starts the next match' });
    }

    _onPeer(m) {
        if(m.on) return; // the newcomer says hello
        if(this.isHost) {
            for(const [id, r] of this.roster) if(!r.bot && r.client === m.id) { this.left.set(m.id, { team: r.team, at: performance.now() }); this.roster.delete(id); if(this.remotes.has(id)) this._dropRemote(this.remotes.get(id)); this.game.emit('hint', { text: `${r.name} left` }); }
            this.fillBots();
        } else for(const ra of [...this.remotes.values()]) if(!ra.isBot && ra.client === m.id) { this.game.emit('hint', { text: `${ra.name} left` }); this._dropRemote(ra); }
        this._orphans();
    }
    _onHostChange() {
        this._orphans();
        if(!this.isHost || this.wasHost) return;
        // we are the host now: take over the old host's bots where they stand, its crates and the clock
        const g = this.game;
        this.roster.clear();
        for(const r of this.rosterList || []) if(!r.bot && (r.client === this.id || this.net.peers.has(r.client))) this.roster.set(r.id, { ...r });
        this.roster.set(g.player.netId, { id: g.player.netId, name: this.name, team: g.player.team, bot: false, client: this.id });
        for(const ra of [...this.remotes.values()]) {
            if(!ra.isBot) continue;
            const f = ra.body.feet, m = /^b:(red|blue)(\d)$/.exec(ra.netId), alive = ra.alive, hp = ra.health;
            this._dropRemote(ra);
            if(!m || !g.botsOn) continue;
            const b = g.addBot(m[1], +m[2], 3, [f.x, f.y, f.z]);
            b.health = alive ? hp : 0;
            if(!alive) b.die();
        }
        for(const c of g.crates.list) if(c.carrier && !g.actors.includes(c.carrier)) g.crates.drop(c);
        this.fillBots();
        this.game.emit('hint', { text: 'You are the host now' });
    }
    /** Bodies whose owner left belong to the host. */
    _orphans() {
        const host = this.net.hostId, me = this.id;
        if(!(host === me || this.net.peers.has(host))) return; // wait for the new host
        for(const prop of this.ctx.physics.props) {
            const o = this._ownerRaw(prop);
            if(o && o !== me && !this.net.peers.has(o)) this._setOwner(prop, host);
        }
    }

    // ------------------------------------------------------------------ actors: state stream

    _sendStates() {
        const g = this.game, list = [g.player, ...(this.isHost ? g.bots : [])];
        const d = new Float32Array(list.length * 9), ids = [];
        list.forEach((a, i) => {
            const c = a.body.center, v = a.body.vel, o = i * 9;
            d[o] = c.x; d[o + 1] = c.y; d[o + 2] = c.z; d[o + 3] = v.x; d[o + 4] = v.y; d[o + 5] = v.z;
            d[o + 6] = a.yaw ?? 0; d[o + 7] = a.pitch ?? a.aimPitch ?? 0;
            d[o + 8] = (a.alive ? F_ALIVE : 0) | (a.body.grounded ? F_GROUNDED : 0);
            ids.push(a.netId);
        });
        this.send({ t: 'st', tm: performance.now(), ids, d });
        this.stats.stOut++;
    }
    _clock(from, tm) {
        const o = performance.now() - tm;
        let c = this.clocks.get(from);
        if(c === undefined || o < c) c = o; else c += (o - c) * 0.004; // the fastest delivery, drifting up slowly
        this.clocks.set(from, c);
        return c;
    }
    _onStates(from, m) {
        if(!Array.isArray(m.ids) || !(m.d instanceof Float32Array)) return;
        this._clock(from, m.tm);
        this.stats.stIn++;
        const d = m.d;
        m.ids.forEach((id, i) => {
            const ra = this.remotes.get(id);
            if(!ra) return;
            const o = i * 9;
            if(ra.client !== from) { ra.client = from; ra.buf.length = 0; } // a new host runs this bot now: its own clock
            ra.push(m.tm, { p: [d[o], d[o + 1], d[o + 2]], v: [d[o + 3], d[o + 4], d[o + 5]], yaw: d[o + 6], pitch: d[o + 7], flags: d[o + 8] });
        });
    }

    // ------------------------------------------------------------------ damage, death, respawn

    damage(actor, amount, by, impulse, cause) {
        const g = this.game;
        if(!actor || !actor.alive || g.over) return;
        if(impulse && actor.local) actor.body.knock(impulse);
        const knock = impulse && !actor.local ? impulse.map(r2) : null;
        if(!(amount > 0) && !knock) return;
        if(cause === 'fell') { if(actor.fellSent > performance.now() - 500) return; actor.fellSent = performance.now(); }
        const m = { t: 'hit', tg: actor.netId, by: by?.netId ?? null, a: amount > 0 ? r2(amount) : 0, i: knock, c: cause || null };
        this.stats.hits++;
        if(this.isHost) {
            if(m.a > 0) this._applyDamage(actor, m.a, by, cause);
            if(knock) this.send({ ...m, a: 0 }); // only the owner's knockback
        } else this.send(m);
    }
    _onHit(from, m) {
        const a = this.actor(m.tg);
        if(!a) return;
        if(a.local && Array.isArray(m.i) && a.alive) a.body.knock(m.i.map(v => Math.max(-80, Math.min(80, +v || 0))));
        if(this.isHost && m.a > 0) this._applyDamage(a, Math.min(MAX_HIT, +m.a || 0), this.actor(m.by), m.c);
    }
    /** Host: health goes down; everyone hears how it went ('hp'). */
    _applyDamage(actor, amount, by, cause) {
        if(!actor.alive || this.game.over) return;
        const hp = Math.max(0, actor.health - amount);
        const m = { t: 'hp', tg: actor.netId, by: by?.netId ?? null, a: amount, c: cause || null, hp: Math.round(hp * 10) / 10, dead: hp <= 0 };
        this.send(m);
        this._onHp(m);
    }
    _onHp(m) {
        const a = this.actor(m.tg); if(!a || !a.alive) return;
        const by = this.actor(m.by);
        a.health = m.hp; a.sinceHit = 0;
        this.game.emit('damage', { actor: a, amount: m.a, by, cause: m.c });
        if(m.dead) this._kill(a, by, m.c);
    }
    _kill(a, by, cause, quiet = false) {
        if(!a.alive) return;
        a.health = 0;
        if(a.held && a.isPlayer) a.arsenal.release(false);
        else if(a.held) a.held = null;
        if(a.carrying && this.game.crates.authority) this.game.crates.drop(a.carrying);
        a.die();
        if(!quiet) this.game.emit('death', { actor: a, by, cause });
    }
    _respawnActor(a) {
        a.respawn();
        this.game.emit('respawn', { actor: a });
    }
    _onSpawn(from, m) {
        const a = this.actor(m.tg);
        if(a && !a.alive) this._respawnActor(a);
    }

    // ------------------------------------------------------------------ events and actions

    /** game.emit: a local actor's event that the others should see and hear too. */
    mirror(name, d) {
        if(!MIRROR.has(name) || d._net) return;
        const who = d.owner ?? d.actor;
        if(who && !who.local) return;
        if(name === 'throw' && d.kind !== 'rock') return; // bombs travel as actions
        const out = {};
        for(const k in d) {
            const v = d[k];
            if(REFS.includes(k)) out[k] = v?.netId ?? null;
            else if(v == null || typeof v !== 'object' || Array.isArray(v)) out[k] = v;
        }
        this.send({ t: 'ev', n: name, d: out });
        this.stats.evs++;
    }
    _onEv(from, m) {
        if(!MIRROR.has(m.n) || !m.d) return;
        const d = m.d;
        for(const k of REFS) if(k in d) d[k] = this.actor(d[k]);
        if(m.n === 'land' && !d.actor) return;
        d._net = true;
        this.game.emit(m.n, d);
    }
    /** A local actor fired a rocket or threw a bomb. */
    act(m, owner) {
        if(!owner?.local) return;
        this.send({ t: 'act', ...m });
        this.stats.acts++;
    }
    _onAct(from, m) {
        const a = this.actor(m.a);
        if(!a || !Array.isArray(m.o) || !Array.isArray(m.d)) return;
        const combat = this.game.combat;
        if(m.k === 'rocket') combat.fireRocket(a, m.o, m.d, { visual: true });
        else if(m.k === 'fused' && (m.kind === 'grenade' || m.kind === 'buster')) combat.throwFused(a, m.kind, m.o, m.d, +m.s || 10, { visual: true, id: m.id, spin: m.spin });
    }
    gone(id) { this.send({ t: 'gone', id }); }

    // ------------------------------------------------------------------ bodies: owners and streams

    _vb(prop) { return prop.userData?.voxelBody || null; }
    netIdOf(prop) { const ud = prop.userData; return ud?.netId ?? ud?.voxelBody?.netId ?? null; }
    _ownerRaw(prop) { const vb = this._vb(prop); return vb ? vb.owner : prop.userData?.owner ?? null; }
    ownerOf(prop) { return this._ownerRaw(prop) ?? this.net.hostId; }
    _setOwner(prop, o) { const vb = this._vb(prop); if(vb) vb.owner = o; else prop.userData.owner = o; }
    _props() {
        const map = new Map();
        for(const p of this.ctx.physics.props) { const id = this.netIdOf(p); if(id && !id.startsWith('pending')) map.set(id, p); }
        return map;
    }
    /** This client takes a body (it holds it): it simulates and streams it from now on. */
    claim(prop) {
        const id = this.netIdOf(prop);
        if(!id || this.ownerOf(prop) === this.id) return;
        this._setOwner(prop, this.id);
        prop._net = null;
        this.send({ t: 'own', id, o: this.id });
    }
    /** A thrown body came to rest: the host's again. */
    unclaim(prop) {
        const id = this.netIdOf(prop), host = this.net.hostId;
        if(!id || host === this.id || this.ownerOf(prop) !== this.id || !this.ctx.physics.props.has(prop)) return;
        this._setOwner(prop, host);
        this.send({ t: 'own', id, o: host });
    }
    _onOwn(from, m) {
        const p = this._props().get(m.id);
        if(!p || typeof m.o !== 'string') return;
        const was = this.ownerOf(p);
        this._setOwner(p, m.o);
        if(was === this.id && m.o !== this.id && this.game.player.held === p) this.game.player.arsenal.release(false); // someone took it
    }
    /** A punch on a body someone else owns: its owner pushes its copy too. */
    push(prop, j, tq) {
        const id = this.netIdOf(prop), o = this.ownerOf(prop);
        if(!id || o === this.id) return;
        this.net.direct(o, { t: 'push', id, j: [j.x, j.y, j.z], tq: [tq.x, tq.y, tq.z] });
    }
    _onPush(from, m) {
        const p = this._props().get(m.id);
        if(!p || this.ownerOf(p) !== this.id || !p.body.isDynamic()) return;
        const c = (v) => Math.max(-1e6, Math.min(1e6, +v || 0));
        p.body.applyImpulse({ x: c(m.j[0]), y: c(m.j[1]), z: c(m.j[2]) }, true);
        p.body.applyTorqueImpulse({ x: c(m.tq[0]), y: c(m.tq[1]), z: c(m.tq[2]) }, true);
    }

    _sendBodies() {
        const now = performance.now(), me = this.id, out = [];
        for(const p of this.ctx.physics.props) {
            const id = this.netIdOf(p);
            if(!id || id.startsWith('pending') || this.ownerOf(p) !== me) continue;
            const ud = p.userData;
            if(ud.crate && this.game.crates.list[+id.slice(6)]?.carrier) continue; // carried: everyone puts it over the carrier
            const b = p.body;
            if(!b.isValid?.()) continue;
            const kin = b.isKinematic(), sleeping = !kin && b.isSleeping();
            // moving bodies every time; resting ones once when they stop, then now and then
            let pri;
            if(kin || !sleeping) { const v = b.linvel(); pri = 1e6 + (kin ? 1e6 : 0) + Math.hypot(v.x, v.y, v.z); p._sentRest = false; }
            else if(!p._sentRest) pri = 5e5;
            else if(now - (p._sentAt || 0) > REFRESH_MS) pri = now - (p._sentAt || 0);
            else continue;
            out.push([pri, id, p, kin, sleeping]);
        }
        if(!out.length) return;
        out.sort((a, b) => b[0] - a[0]);
        const n = Math.min(BODY_MAX, out.length), d = new Float32Array(n * 14), ids = [];
        for(let i = 0; i < n; i++) {
            const [, id, p, kin, sleeping] = out[i], b = p.body, t = b.translation(), q = b.rotation(), v = kin ? { x: 0, y: 0, z: 0 } : b.linvel(), w = kin ? v : b.angvel(), o = i * 14;
            d[o] = t.x; d[o + 1] = t.y; d[o + 2] = t.z; d[o + 3] = q.x; d[o + 4] = q.y; d[o + 5] = q.z; d[o + 6] = q.w;
            d[o + 7] = v.x; d[o + 8] = v.y; d[o + 9] = v.z; d[o + 10] = w.x; d[o + 11] = w.y; d[o + 12] = w.z;
            d[o + 13] = (kin ? 1 : 0) | (sleeping ? 2 : 0);
            ids.push(id);
            p._sentAt = now; if(sleeping) p._sentRest = true;
        }
        this.send({ t: 'bs', tm: now, ids, d });
        this.stats.bodiesOut += n;
    }
    _onBodies(from, m) {
        if(!Array.isArray(m.ids) || !(m.d instanceof Float32Array)) return;
        const off = this._clock(from, m.tm), props = this._props(), d = m.d, now = performance.now();
        m.ids.forEach((id, i) => {
            const p = props.get(id);
            if(!p || this.ownerOf(p) === this.id) return;
            const o = i * 14;
            p._net = { at: now, sent: m.tm + off, p: [d[o], d[o + 1], d[o + 2]], q: [d[o + 3], d[o + 4], d[o + 5], d[o + 6]], v: [d[o + 7], d[o + 8], d[o + 9]], w: [d[o + 10], d[o + 11], d[o + 12]], flags: d[o + 13] };
            this.stats.bodiesIn++;
        });
    }
    /** Steer the copies of bodies others own toward their streamed motion. */
    blendBodies(dt) {
        const now = performance.now(), me = this.id;
        for(const p of this.ctx.physics.props) {
            const s = p._net;
            if(!s) continue;
            const b = p.body;
            if(!b.isValid?.() || this.ownerOf(p) === me || now - s.at > BODY_STALE) {
                p._net = null;
                if(p._netKin && b.isValid?.()) { b.setBodyType(BodyType.Dynamic, true); p._netKin = false; }
                continue;
            }
            const age = Math.min(0.25, Math.max(0, now - s.sent) / 1000);
            const tx = s.p[0] + s.v[0] * age, ty = s.p[1] + s.v[1] * age, tz = s.p[2] + s.v[2] * age;
            if(s.flags & 1) {
                // held by its owner: follow it exactly (kinematic here too)
                if(!b.isKinematic()) { b.setBodyType(BodyType.Kinematic, true); p._netKin = true; }
                _p.set(tx, ty, tz);
                b.setNextKinematicTranslation(_p);
                b.setNextKinematicRotation({ x: s.q[0], y: s.q[1], z: s.q[2], w: s.q[3] });
                continue;
            }
            if(p._netKin) { b.setBodyType(BodyType.Dynamic, true); p._netKin = false; }
            if(!b.isDynamic()) continue;
            const t = b.translation();
            const ex = tx - t.x, ey = ty - t.y, ez = tz - t.z, e = Math.hypot(ex, ey, ez);
            if(s.flags & 2) {
                // at rest over there: put it there once and let it sleep
                if(e > 0.03 || !b.isSleeping()) {
                    b.setTranslation({ x: s.p[0], y: s.p[1], z: s.p[2] }, false);
                    b.setRotation({ x: s.q[0], y: s.q[1], z: s.q[2], w: s.q[3] }, false);
                    b.setLinvel({ x: 0, y: 0, z: 0 }, false); b.setAngvel({ x: 0, y: 0, z: 0 }, false);
                    b.sleep();
                }
                p._net = null;
                continue;
            }
            if(e > 3) {
                b.setTranslation({ x: tx, y: ty, z: tz }, true);
                b.setRotation({ x: s.q[0], y: s.q[1], z: s.q[2], w: s.q[3] }, true);
                b.setLinvel({ x: s.v[0], y: s.v[1], z: s.v[2] }, true);
                b.setAngvel({ x: s.w[0], y: s.w[1], z: s.w[2] }, true);
                continue;
            }
            // a spring toward where it is over there, plus its velocity
            const k = 6;
            b.setLinvel({ x: s.v[0] + ex * k, y: s.v[1] + ey * k, z: s.v[2] + ez * k }, true);
            const q = b.rotation();
            _q.set(q.x, q.y, q.z, q.w).slerp(_q2.set(s.q[0], s.q[1], s.q[2], s.q[3]), Math.min(1, dt * 8));
            b.setRotation(_q, true);
            b.setAngvel({ x: s.w[0], y: s.w[1], z: s.w[2] }, true);
        }
    }

    // ------------------------------------------------------------------ frame

    start() {
        const hud = this.game.hud;
        this.labels = document.createElement('div');
        this.labels.className = 'bz-names';
        hud.root.appendChild(this.labels);
        for(const ra of this.remotes.values()) this._label(ra);
        hud.onlineInfo?.(this);
    }
    _label(ra) {
        if(!this.labels || ra.label) return;
        const el = document.createElement('div');
        el.className = `bz-name ${ra.team}`;
        el.textContent = ra.name;
        this.labels.appendChild(el);
        ra.label = el;
    }
    update(dt) {
        const g = this.game, now = performance.now();
        for(const ra of this.remotes.values()) ra.update(dt, now - (this.clocks.get(ra.client) ?? 0));
        if((this.stT += dt) >= 1 / STATE_HZ) { this.stT = 0; this._sendStates(); }
        if((this.bodyT += dt) >= 1 / BODY_HZ) { this.bodyT = 0; this._sendBodies(); }
        this.blendBodies(dt);
        if(this.isHost) {
            this.wasHost = true;
            for(const a of g.actors) if(!a.alive && !g.over) {
                a.respawnIn -= dt;
                if(a.respawnIn <= 0) { this._respawnActor(a); this.send({ t: 'spawn', tg: a.netId }); }
            }
            if((this.gameT += dt) >= 1 / GAME_HZ) { this.gameT = 0; this.send(this._gameState()); }
            for(const [c, l] of this.left) if(now - l.at > 60e3) this.left.delete(c);
        } else this.wasHost = false;
        this._labels();
    }
    _labels() {
        if(!this.labels) return;
        const cam = this.ctx.camera, w = innerWidth, h = innerHeight, me = this.game.player.body.center;
        for(const ra of this.remotes.values()) {
            const el = ra.label; if(!el) continue;
            _p.copy(ra.view); _p.y += 1.35;
            const dist = _p.distanceTo(me);
            _p.project(cam);
            const show = ra.alive && ra.mesh.visible && _p.z < 1 && dist < 80 && Math.abs(_p.x) < 1.1 && Math.abs(_p.y) < 1.1;
            if(!show) { if(el.style.display !== 'none') el.style.display = 'none'; continue; }
            el.style.display = '';
            el.style.transform = `translate(-50%, -100%) translate(${((_p.x + 1) / 2 * w).toFixed(0)}px, ${((1 - _p.y) / 2 * h).toFixed(0)}px)`;
            el.style.opacity = dist > 40 ? 0.6 : 1;
        }
    }
    get bytes() { return this.net.transport.bytes || { up: 0, down: 0 }; }
}
