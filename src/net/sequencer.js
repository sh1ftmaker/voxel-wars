/**
 * The room's sequencer: gives every edit a global sequence number, keeps the edit log for late joiners, and relays
 * messages between clients. Pure (no DOM, no timers, no I/O): a transport feeds it what clients send and delivers
 * what it emits, so the same module runs in a tab (src/net/transports.js) or later inside a PartyServer Durable Object.
 * It never looks inside edits: terrain stays on the clients (the host's terrain worker makes snapshots).
 *
 *   const s = new Sequencer({ send: (to, msg) => ..., keepLog = true })   to: a client id or '*' (everyone, sender included)
 *   s.connect(id)            a client arrived (the first one is the host)
 *   s.disconnect(id)         a client left (the host passes to the oldest remaining client: 'host' { id })
 *   s.receive(from, msg)     a client's message:
 *     { t: 'join' }                          -> 'welcome' { you, host, snap: { seq, data } | null, log: [entry], next }
 *     { t: 'edit', req, e, log = true }      -> '*' 'seq' { seq, from, req, e, log } (log: false = transient, kept as a
 *                                                stub so late joiners see no gap in the numbering)
 *     { t: 'snapshot', seq, data }           (host) the world after `seq` (opaque bytes); the log up to seq is dropped
 *     { t: 'direct', to, m }                 -> to 'direct' { from, m }
 *     { t: 'bcast', m }                      -> '*' except the sender: 'bcast' { from, m }
 *
 * Log entries are the 'seq' messages themselves. stats: { seq, logged, snapSeq, snapBytes, clients }.
 */
export class Sequencer {
    constructor({ send, keepLog = true }) {
        this.send = send;
        this.keepLog = keepLog; // false: single player (nobody can join, so nothing is kept)
        this.seq = 0;
        this.log = [];
        this.snap = null;
        this.clients = [];   // join order
        this.host = null;
    }
    get stats() { return { seq: this.seq, logged: this.log.length, snapSeq: this.snap?.seq ?? 0, snapBytes: this.snap?.data?.length ?? 0, clients: this.clients.length }; }
    connect(id) {
        if(!this.clients.includes(id)) this.clients.push(id);
        if(this.host === null) this.host = id;
    }
    disconnect(id) {
        this.clients = this.clients.filter(c => c !== id);
        if(this.host === id) {
            this.host = this.clients[0] ?? null;
            if(this.host !== null) this.send('*', { t: 'host', id: this.host });
        }
    }
    receive(from, msg) {
        switch(msg.t) {
            case 'join':
                this.connect(from);
                this.send(from, { t: 'welcome', you: from, host: this.host, snap: this.snap, log: this.log, next: this.seq + 1 });
                break;
            case 'edit': {
                const log = msg.log !== false;
                const m = { t: 'seq', seq: ++this.seq, from, req: msg.req, e: msg.e, log };
                if(this.keepLog) this.log.push(log ? m : { t: 'seq', seq: m.seq, from, skip: true });
                this.send('*', m);
                break;
            }
            case 'snapshot':
                if(from !== this.host || msg.seq <= (this.snap?.seq ?? 0)) break;
                this.snap = { seq: msg.seq, data: msg.data };
                this.log = this.log.filter(m => m.seq > msg.seq);
                break;
            case 'direct': this.send(msg.to, { t: 'direct', from, m: msg.m }); break;
            case 'bcast': for(const c of this.clients) if(c !== from) this.send(c, { t: 'bcast', from, m: msg.m }); break;
        }
    }
}
