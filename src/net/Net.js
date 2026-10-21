/**
 * The client's edit log. Everything that changes the terrain goes through here: local code submits an edit, the
 * transport takes it to the room's sequencer (src/net/sequencer.js), which numbers it and sends it to every client,
 * and every client (the submitter too) applies the edits strictly in sequence order. Since each edit carries all it
 * needs (brush specs, seeds, grids, sample patches) and the terrain worker applies them deterministically, every
 * client's terrain stays the same; chunk hashes are compared now and then and a chunk that drifted is resent.
 *
 *   const net = new Net({ transport, terrain })   terrain: TerrainSync (hash, chunkData, setChunks)
 *   await net.connect()                           join the room (welcome: snapshot + log for a late joiner)
 *   net.on(kind, fn(e, meta), { blocking })        apply edits of `kind`: meta { seq, from, local, req, history }
 *                                                 (history: an edit from before this client joined, replayed to
 *                                                 catch up: no effects, no bodies);
 *                                                 a blocking handler's promise is awaited before the next edit
 *   net.ready()                                   handlers registered and world initialised: start applying
 *   net.submit(e, { log = true }) -> Promise       e = { k: kind, ... }; resolves to the handler's result when the
 *                                                 edit comes back and applies here. log: false for transient edits
 *                                                 (late joiners skip them: body events, marks)
 *   net.id, net.isHost, net.single (LocalTransport: single player), net.applied (last applied seq)
 *   host duties (hash checks, snapshots) run on a 1 s timer, not the frame loop: a host tab in the background gets
 *   no animation frames but still serves the room
 *   net.hashNow() -> Promise<Map key -> hash>     this client's chunk hashes in its current applied state
 *
 * Game messages (not sequenced; src/game/NetGame.js): net.bcast(m) to everyone else, net.direct(to, m) to one client;
 * net.onMsg(type, fn(from, m)) receives them by m.t, and also the room's own events: 'peer' (from, { id, on }),
 * 'host' (from, { id }), 'reset', 'rejoined', 'status' ({ status } of a PartyTransport's socket).
 * net.peers: the other clients' ids; net.hostId; net.ping (ms, PartyTransport only); net.gameState (the host's last
 * 'game' message, from the welcome). A dropped connection re-joins with `since` = the last edit seen and catches up.
 *
 * Built-in edit kinds (transient): 'mark' { what: 'hash' | 'snap' } (everyone hashes / the host snapshots at that
 * point of the order), 'resync' { to, keys } (the host sends `to` those chunks as they are at that point; `to` waits
 * for them before applying anything later). Direct messages: 'hashes' (host -> all), 'resyncReq', 'resyncData'.
 *
 * stats: { applied, submitted, hashChecks, mismatches, resyncs, snapshots, snapBytes, lastSnapMs }.
 */
import { encode, decode } from './codec.js';

const HASH_EVERY = 3;      // s between hash checks (host, when something changed)
const SNAP_EVERY = 30;     // s between snapshots (host, when the log grew; a snapshot is ~100-200 kB up to the server)
const SNAP_EDITS = 200;    // or after this many logged edits (late joiners replay the rest)

export class Net {
    constructor({ transport, terrain, snapEvery = SNAP_EVERY }) {
        this.transport = transport;
        this.snapEvery = snapEvery;
        this.terrain = terrain;
        this.handlers = new Map();
        this.pending = new Map();     // req -> { resolve, reject }
        this.queue = new Map();       // seq -> 'seq' message, waiting its turn
        this.next = 0;                // the seq to apply next (0: not welcomed yet)
        this.applied = 0;
        this.reqNo = 0;
        this.isReady = false;
        this.busy = false;
        this.hashT = 0; this.snapT = 0; this.editsSinceSnap = 0; this.editsSinceHash = 0;
        this.myHashes = new Map();    // seq -> Promise<Map>
        this.hostHashes = new Map();  // seq -> [[key, h]]
        this.resyncData = new Map();  // seq -> { data, resolve }
        this.stats = { applied: 0, submitted: 0, hashChecks: 0, mismatches: 0, resyncs: 0, snapshots: 0, snapBytes: 0, lastSnapMs: 0 };
        this.msgHandlers = new Map();
        this.peers = new Set();
        this.lastSeen = 0;
        this.ping = 0;
        this.on('mark', (e, m) => this._mark(e, m), { blocking: false });
        this.on('resync', (e, m) => this._resync(e, m), { blocking: true });
    }
    get id() { return this.transport.id; }
    get isHost() { return this.transport.isHost; }
    get single() { return !!this.transport.single; }

    async connect() {
        await this.transport.connect((m) => this._message(m));
        this.transport.onReopen = () => { this.rejoining = true; this.transport.send({ t: 'join', since: this.lastSeen }); };
        this.transport.onStatus = (status) => this._emit('status', null, { status });
        this.transport.send({ t: 'join' });
        // a host tab that is still loading may miss the first join: ask again until welcomed
        if(!this.next) {
            await new Promise((resolve) => {
                this.welcomed = resolve;
                const again = () => { if(this.next) return; this.transport.send({ t: 'join' }); setTimeout(again, 400); };
                setTimeout(again, 400);
            });
        }
    }
    on(kind, fn, { blocking = false } = {}) { this.handlers.set(kind, { fn, blocking }); }
    onMsg(type, fn) { if(!this.msgHandlers.has(type)) this.msgHandlers.set(type, []); this.msgHandlers.get(type).push(fn); }
    _emit(type, from, m) {
        const fns = this.msgHandlers.get(type);
        if(fns) for(const fn of fns) { try { fn(from, m); } catch(e) { console.error(`net: ${type} handler`, e); } }
    }
    bcast(m) { if(!this.single) this.transport.send({ t: 'bcast', m }); }
    direct(to, m) { if(!this.single) this.transport.send({ t: 'direct', to, m }); }
    ready() {
        this.isReady = true;
        this._pump();
        if(!this.single && !this.timer) this.timer = setInterval(() => this._duties(1), 1000);
        if(this.transport.server && !this.pingTimer) {
            const ping = () => { if(this.transport.status === 'open') this.transport.send({ t: 'ping', c: performance.now() }); };
            this.pingTimer = setInterval(ping, 2000); ping();
        }
    }

    submit(e, { log = true } = {}) {
        const req = ++this.reqNo;
        this.stats.submitted++;
        const p = new Promise((resolve, reject) => this.pending.set(req, { resolve, reject }));
        this.transport.send({ t: 'edit', req, e, log });
        return p;
    }

    // ------------------------------------------------------------------ incoming

    _message(m) {
        switch(m.t) {
            case 'welcome': {
                this.hostId = m.host;
                this.transport.isHost = m.host === this.id;
                this.peers = new Set(m.peers || []);
                if(this.rejoining && this.next) { this._rejoin(m); return; }
                this.rejoining = false;
                this.lastSeen = Math.max(this.lastSeen, m.next - 1);
                if(this.next) return; // a repeated join
                this.welcome = m;
                this.gameState = m.game || null;
                const base = m.from ?? (m.snap ? m.snap.seq + 1 : 1);
                this.next = base;
                this.liveFrom = m.next; // edits before this are history (a late joiner catching up)
                for(const e of m.log) if(e.seq >= base) this.queue.set(e.seq, e);
                // live edits that arrived before the welcome
                for(const [s] of this.queue) if(s < base) this.queue.delete(s);
                this.welcomed?.();
                this._pump();
                break;
            }
            case 'seq':
                if(m.seq > this.lastSeen) this.lastSeen = m.seq;
                if(this.next && m.seq < this.next) return; // already in the welcome's log
                this.queue.set(m.seq, m);
                this._pump();
                break;
            case 'bcast': case 'direct': this._direct(m.from, m.m); break;
            case 'host': this.hostId = m.id; this.transport.isHost = m.id === this.id; this._emit('host', null, m); break;
            case 'peer': if(m.on) this.peers.add(m.id); else this.peers.delete(m.id); this._emit('peer', null, m); break;
            case 'reset': this._emit('reset', null, m); break;
            case 'pong': this.ping = this.ping ? this.ping * 0.7 + (performance.now() - m.c) * 0.3 : performance.now() - m.c; this.roomSize = m.n; break;
        }
    }

    /** A reconnect's welcome: the edits missed while away (or the snapshot, if the log no longer reaches back). */
    _rejoin(m) {
        this.rejoining = false;
        this.lastSeen = Math.max(this.lastSeen, m.next - 1);
        if(m.snap && m.snap.seq >= this.next) {
            this.welcome = m; this.snapApplied = false;
            this.queue.clear();
            this.next = m.snap.seq + 1;
            this.liveFrom = m.next;
        }
        for(const e of m.log) if(e.seq >= this.next) this.queue.set(e.seq, e);
        console.log(`net: re-joined at seq ${this.applied}, ${m.log.length} edits to catch up${m.snap ? ' (from a snapshot)' : ''}`);
        this._emit('rejoined', null, m);
        this._pump();
    }

    async _pump() {
        if(this.busy || !this.isReady || !this.next) return;
        this.busy = true;
        try {
            if(this.welcome?.snap && !this.snapApplied) {
                this.snapApplied = true;
                const t0 = performance.now();
                await this.terrain.setChunks(decode(this.welcome.snap.data));
                this.applied = this.welcome.snap.seq;
                console.log(`net: joined from a snapshot at seq ${this.applied} (${this.welcome.snap.data.length} B, ${(performance.now() - t0).toFixed(0)} ms), ${this.welcome.log.length} edits after it`);
            }
            while(this.queue.has(this.next)) {
                const m = this.queue.get(this.next);
                this.queue.delete(this.next);
                this.next++;
                const local = m.from === this.id;
                const p = local ? this.pending.get(m.req) : null;
                if(p) this.pending.delete(m.req);
                if(m.skip) { this.applied = m.seq; continue; }
                const h = this.handlers.get(m.e?.k);
                let res;
                try { res = h ? h.fn(m.e, { seq: m.seq, from: m.from, local, req: m.req, history: m.seq < this.liveFrom }) : undefined; }
                catch(err) { console.error(`net: applying ${m.e?.k} #${m.seq}`, err); p?.reject(err); this.applied = m.seq; continue; }
                if(m.log !== false) { this.editsSinceSnap++; this.editsSinceHash++; }
                this.applied = m.seq;
                this.stats.applied++;
                p?.resolve(res);
                if(h?.blocking && res && typeof res.then === 'function') await res.catch(err => console.error('net', err));
            }
        } finally { this.busy = false; }
        if(this.queue.has(this.next)) this._pump();
    }

    // ------------------------------------------------------------------ host duties: hash checks, snapshots

    _duties(dt) {
        if(!this.isHost || this.single || !this.isReady) return;
        this.hashT += dt; this.snapT += dt;
        if(this.hashT > HASH_EVERY && this.editsSinceHash > 0) { this.hashT = 0; this.editsSinceHash = 0; this.submit({ k: 'mark', what: 'hash' }, { log: false }); }
        if((this.snapT > this.snapEvery && this.editsSinceSnap > 0) || this.editsSinceSnap >= SNAP_EDITS) { this.snapT = 0; this.editsSinceSnap = 0; this.submit({ k: 'mark', what: 'snap' }, { log: false }); }
    }

    /** This client's hashes as of now (in its applied order). */
    async hashNow() { return new Map(await this.terrain.hash()); }

    _mark(e, { seq }) {
        if(this.single) return;
        if(e.what === 'hash') {
            const p = this.terrain.hash();
            this.myHashes.set(seq, p);
            if(this.myHashes.size > 8) this.myHashes.delete(this.myHashes.keys().next().value);
            if(this.isHost) p.then(h => this.transport.send({ t: 'bcast', m: { t: 'hashes', seq, h } }));
            else if(this.hostHashes.has(seq)) this._compare(seq);
        } else if(e.what === 'snap' && this.isHost) {
            const t0 = performance.now();
            this.terrain.chunkData({ modified: true }).then(data => {
                const bytes = encode(data);
                this.transport.send({ t: 'snapshot', seq, data: bytes });
                this.stats.snapshots++; this.stats.snapBytes = bytes.length; this.stats.lastSnapMs = performance.now() - t0;
            });
        }
    }
    async _compare(seq) {
        const host = this.hostHashes.get(seq), mine = this.myHashes.get(seq);
        if(!host || !mine) return;
        this.hostHashes.delete(seq);
        const my = new Map(await mine);
        const bad = [];
        for(const [k, h] of host) if(my.get(k) !== h) bad.push(k);
        this.stats.hashChecks++;
        this.lastCheck = { seq, chunks: host.length, bad: bad.length };
        if(!bad.length) return;
        this.stats.mismatches += bad.length;
        console.warn(`net: ${bad.length} chunk(s) differ from the host at seq ${seq}: ${bad.slice(0, 6).join(' ')}${bad.length > 6 ? ' ...' : ''}; asking for them`);
        this.transport.send({ t: 'direct', to: this.hostId, m: { t: 'resyncReq', keys: bad } });
    }
    _direct(from, m) {
        switch(m.t) {
            case 'hashes':
                this.hostHashes.set(m.seq, m.h);
                if(this.hostHashes.size > 8) this.hostHashes.delete(this.hostHashes.keys().next().value);
                if(this.myHashes.has(m.seq)) this._compare(m.seq);
                break;
            case 'resyncReq': if(this.isHost) this.submit({ k: 'resync', to: from, keys: m.keys }, { log: false }); break;
            case 'resyncData': {
                const w = this.resyncData.get(m.seq);
                if(w?.resolve) w.resolve(m.data); else this.resyncData.set(m.seq, { data: m.data });
                break;
            }
            default: this._emit(m.t, from, m);
        }
    }
    /** 'resync' at this point of the order: the host reads the chunks and sends them; the target overwrites its own. */
    _resync(e, { seq }) {
        if(this.isHost && e.to !== this.id) {
            // queued in the worker at this point of the order: the data is the chunks as of this seq
            this.terrain.chunkData({ keys: e.keys }).then(data => { this.transport.send({ t: 'direct', to: e.to, m: { t: 'resyncData', seq, data } }); });
            return null;
        }
        if(e.to !== this.id) return null;
        const got = this.resyncData.get(seq);
        const data = got ? Promise.resolve(got.data) : new Promise(resolve => this.resyncData.set(seq, { resolve }));
        return data.then(d => { this.resyncData.delete(seq); this.stats.resyncs += d.length; return this.terrain.setChunks(d); });
    }
}
