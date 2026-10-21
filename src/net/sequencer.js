/**
 * The room's sequencer: gives every edit a global sequence number, keeps the edit log for late joiners, and relays
 * messages between clients. Pure (no DOM, no timers, no I/O): a transport feeds it what clients send and delivers
 * what it emits, so the same module runs in a tab (src/net/transports.js) and inside the PartyServer Durable Object
 * (server/src/index.js). It never looks inside edits: terrain stays on the clients (the host's terrain worker makes
 * snapshots).
 *
 *   const s = new Sequencer({ send: (to, msg) => ..., keepLog = true })   to: a client id or '*' (everyone, sender included)
 *   s.connect(id)            a client arrived (the first one is the host); the others get 'peer' { id, on: true }
 *   s.disconnect(id)         a client left: 'peer' { id, on: false }; the host passes to the oldest remaining client
 *                            ('host' { id }); s.empty is then true when nobody is left
 *   s.receive(from, msg)     a client's message:
 *     { t: 'join', since = 0 }               -> 'welcome' { you, host, peers, snap: { seq, data } | null, log: [entry],
 *                                                next, game }. since > 0: a client reconnecting that has every edit up
 *                                                to `since`: only the log after it (or the snapshot, if the log no
 *                                                longer reaches back that far)
 *     { t: 'edit', req, e, log = true }      -> '*' 'seq' { seq, from, req, e, log } (log: false = transient, kept as a
 *                                                stub so late joiners see no gap in the numbering)
 *     { t: 'snapshot', seq, data }           (host) the world after `seq` (opaque bytes); the log up to seq is dropped
 *     { t: 'direct', to, m }                 -> to 'direct' { from, m }
 *     { t: 'bcast', m }                      -> '*' except the sender: 'bcast' { from, m }; the host's m.t === 'game'
 *                                                (the game state) is also kept for the next welcome
 *     { t: 'reset' }                         (host) a new match: the log, snapshot and game state are dropped and
 *                                                everyone gets 'reset' (they reload; numbering goes on)
 *
 * Log entries are the 'seq' messages themselves. stats: { seq, logged, snapSeq, snapBytes, clients }.
 * Hooks for a persisting host (the Durable Object): onLogged(entry), onSnapshot(snap), onReset().
 */
export class Sequencer {
    constructor({ send, keepLog = true }) {
        this.send = send;
        this.keepLog = keepLog; // false: single player (nobody can join, so nothing is kept)
        this.seq = 0;
        this.log = [];
        this.snap = null;
        this.game = null;    // the host's last game state message
        this.clients = [];   // join order
        this.host = null;
    }
    get stats() { return { seq: this.seq, logged: this.log.length, snapSeq: this.snap?.seq ?? 0, snapBytes: this.snap?.data?.length ?? 0, clients: this.clients.length }; }
    get empty() { return this.clients.length === 0; }
    connect(id) {
        if(this.clients.includes(id)) return;
        this.clients.push(id);
        if(this.host === null) this.host = id;
        if(this.keepLog) for(const c of this.clients) if(c !== id) this.send(c, { t: 'peer', id, on: true });
    }
    disconnect(id) {
        if(!this.clients.includes(id)) return;
        this.clients = this.clients.filter(c => c !== id);
        for(const c of this.clients) this.send(c, { t: 'peer', id, on: false });
        if(this.host === id) {
            this.host = this.clients[0] ?? null;
            if(this.host !== null) this.send('*', { t: 'host', id: this.host });
        }
    }
    receive(from, msg) {
        switch(msg.t) {
            case 'join': {
                this.connect(from);
                const since = msg.since | 0;
                let snap = this.snap, log = this.log;
                // a reconnecting client that has everything up to `since`: the rest of the log is enough
                if(since > 0 && since >= (this.snap?.seq ?? 0) && (!log.length || log[0].seq <= since + 1)) { snap = null; log = log.filter(m => m.seq > since); }
                this.send(from, { t: 'welcome', you: from, host: this.host, peers: this.clients.filter(c => c !== from), snap, log, next: this.seq + 1, from: snap ? snap.seq + 1 : (log[0]?.seq ?? this.seq + 1), game: this.game });
                break;
            }
            case 'edit': {
                const log = msg.log !== false;
                const m = { t: 'seq', seq: ++this.seq, from, req: msg.req, e: msg.e, log };
                if(this.keepLog) {
                    const entry = log ? m : { t: 'seq', seq: m.seq, from, skip: true };
                    this.log.push(entry);
                    this.onLogged?.(entry);
                }
                this.send('*', m);
                break;
            }
            case 'snapshot':
                if(from !== this.host || msg.seq <= (this.snap?.seq ?? 0)) break;
                this.snap = { seq: msg.seq, data: msg.data };
                this.log = this.log.filter(m => m.seq > msg.seq);
                this.onSnapshot?.(this.snap);
                break;
            case 'direct': if(this.clients.includes(msg.to)) this.send(msg.to, { t: 'direct', from, m: msg.m }); break;
            case 'bcast':
                if(msg.m?.t === 'game' && from === this.host) this.game = msg.m;
                for(const c of this.clients) if(c !== from) this.send(c, { t: 'bcast', from, m: msg.m });
                break;
            case 'reset':
                if(from !== this.host) break;
                this.log = []; this.snap = null; this.game = null;
                this.onReset?.();
                this.send('*', { t: 'reset' });
                break;
        }
    }
}
