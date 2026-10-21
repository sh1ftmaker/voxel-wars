/**
 * Transports: how a client's Net (src/net/Net.js) reaches the room's Sequencer (src/net/sequencer.js).
 *
 *   transport.connect(onMessage) -> Promise    start; onMessage(msg) gets every message for this client, in order
 *   transport.send(msg)                        to the sequencer
 *   transport.id, transport.isHost             set once connect resolves
 *   transport.close()
 *
 *   LocalTransport                single player: the sequencer runs in-process and answers synchronously (no
 *                                 encoding, no copies), so an edit applies inside the call that submitted it
 *   LoopbackServer / .client()    an in-page fake server for tests: every message goes through the codec and
 *                                 arrives after `latency` ± `jitter` ms (order kept per direction)
 *   BroadcastChannelTransport     tabs of one browser on the same origin form a room (`?room=name`): the tab that
 *                                 gets the room's Web Lock first is the host and runs the sequencer; the others
 *                                 talk to it over a BroadcastChannel. The host's own messages are handled
 *                                 synchronously, like LocalTransport.
 */
import { Sequencer } from './sequencer.js';
import { encode, decode } from './codec.js';

export class LocalTransport {
    constructor() { this.id = 'local'; this.isHost = true; this.single = true; }
    connect(onMessage) {
        this.seq = new Sequencer({ send: (to, m) => onMessage(m), keepLog: false });
        this.seq.connect(this.id);
        return Promise.resolve();
    }
    send(m) { this.seq.receive(this.id, m); }
    close() {}
}

export class LoopbackServer {
    constructor({ latency = 40, jitter = 20 } = {}) {
        this.latency = latency; this.jitter = jitter;
        this.clients = new Map();
        this.n = 0;
        this.bytes = { up: 0, down: 0 };
        this.seq = new Sequencer({ send: (to, m) => {
            const b = encode(m);
            for(const c of to === '*' ? this.clients.values() : [this.clients.get(to)]) if(c) { this.bytes.down += b.length; this._later(c, 'downAt', () => c.onMessage?.(decode(b))); }
        } });
    }
    client() { const t = new LoopbackTransport(this, `c${++this.n}`); return t; }
    _later(c, slot, fn) {
        const now = performance.now();
        const at = Math.max(c[slot] || 0, now + this.latency + (Math.random() - 0.5) * 2 * this.jitter);
        c[slot] = at;
        setTimeout(fn, Math.max(0, at - now));
    }
}
class LoopbackTransport {
    constructor(server, id) { this.server = server; this.id = id; this.isHost = false; }
    connect(onMessage) {
        this.onMessage = onMessage;
        this.server.clients.set(this.id, this);
        this.server.seq.connect(this.id);
        this.isHost = this.server.seq.host === this.id;
        return Promise.resolve();
    }
    send(m) {
        const b = encode(m);
        this.server.bytes.up += b.length;
        this.server._later(this, 'upAt', () => this.server.seq.receive(this.id, decode(b)));
    }
    close() { this.server.clients.delete(this.id); this.server.seq.disconnect(this.id); }
}

export class BroadcastChannelTransport {
    constructor(room) {
        this.room = room;
        this.id = Math.random().toString(36).slice(2, 10);
        this.isHost = false;
        this.bytes = { up: 0, down: 0 };
    }
    async connect(onMessage) {
        this.onMessage = onMessage;
        this.ch = new BroadcastChannel(`voxelwars:${this.room}`);
        this.ch.onmessage = (ev) => this._recv(ev.data);
        // the first tab to take the room's lock hosts (it keeps the lock while open)
        this.isHost = await new Promise((resolve) => {
            if(!navigator.locks) { resolve(true); return; }
            navigator.locks.request(`voxelwars-host:${this.room}`, { ifAvailable: true }, (lock) => {
                resolve(!!lock);
                return lock ? new Promise(r => { this.releaseLock = r; }) : undefined;
            });
        });
        if(this.isHost) {
            this.seq = new Sequencer({ send: (to, m) => {
                if(to === this.id || to === '*') this.onMessage(m);
                if(to !== this.id) this._post(to, m);
            } });
            this.seq.connect(this.id);
        }
        addEventListener('pagehide', () => this.close());
    }
    _post(to, m) {
        const b = encode(m);
        this.bytes.up += b.length;
        this.ch.postMessage({ to, from: this.id, b });
    }
    _recv({ to, from, b }) {
        if(to === 'server') { if(this.isHost) { this.bytes.down += b.length; this.seq.receive(from, decode(b)); } return; }
        if(to === 'bye') { if(this.isHost) this.seq.disconnect(from); return; }
        if(to !== '*' && to !== this.id) return;
        this.bytes.down += b.length;
        this.onMessage(decode(b));
    }
    send(m) {
        if(this.isHost) this.seq.receive(this.id, m);
        else this._post('server', m);
    }
    close() {
        if(this.closed) return;
        this.closed = true;
        try { if(!this.isHost) this.ch.postMessage({ to: 'bye', from: this.id, b: new Uint8Array(0) }); } catch(e) { /* closed */ }
        this.releaseLock?.();
        this.ch?.close();
    }
}
