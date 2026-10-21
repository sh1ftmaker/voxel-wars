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
 *   PartyTransport                the room on the PartyServer (server/): a WebSocket to
 *                                 <server>/parties/room/<room>?cid=<id>, reconnecting with backoff. The client id is
 *                                 kept for the tab's session (sessionStorage), so a reload or a dropped connection
 *                                 comes back as the same client. While it is down, messages wait (up to QUEUE_MAX).
 *                                 transport.status: 'connecting' | 'open' | 'closed'; transport.onStatus(status);
 *                                 transport.onReopen(): called before the queue is flushed (Net re-joins there).
 *                                 A socket that has been silent for SILENT_MS (Net pings every 2 s) is given up on
 *                                 and replaced (half-open connections); transport.drop() does that at once.
 */
import { Sequencer } from './sequencer.js';
import { encode, decode } from './codec.js';

export class LocalTransport {
    constructor() { this.id = 'local'; this.isHost = true; this.single = true; this.kind = 'local'; }
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
    constructor(server, id) { this.server = server; this.id = id; this.isHost = false; this.kind = 'loopback'; }
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
        this.kind = 'tabs';
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

export const DEFAULT_SERVER = 'wss://voxel-wars.sh1ftmaker.workers.dev';
const QUEUE_MAX = 2000;
const SILENT_MS = 7000;

export class PartyTransport {
    constructor(room, server = DEFAULT_SERVER) {
        this.room = room;
        this.server = server.replace(/\/+$/, '').replace(/^http/, 'ws');
        let id = null;
        try { id = sessionStorage.getItem(`voxelwars.cid.${room}`); } catch(e) {}
        if(!id) { id = Math.random().toString(36).slice(2, 10); try { sessionStorage.setItem(`voxelwars.cid.${room}`, id); } catch(e) {} }
        this.id = id;
        this.isHost = false;
        this.status = 'connecting';
        this.queue = [];
        this.bytes = { up: 0, down: 0 };
        this.byType = {};
        this.retry = 0;
        this.opens = 0;
        this.kind = 'room server';
    }
    get url() { return `${this.server}/parties/room/${encodeURIComponent(this.room)}?cid=${this.id}&_pk=${this.id}-${this.opens}`; }
    connect(onMessage) {
        this.onMessage = onMessage;
        addEventListener('pagehide', () => this.close());
        this.watch = setInterval(() => { if(this.status === 'open' && performance.now() - this.lastRecv > SILENT_MS) this.drop(); }, 1000);
        return new Promise((resolve, reject) => {
            this.firstOpen = resolve;
            this.firstFail = reject;
            this._open();
        });
    }
    _open() {
        if(this.closed) return;
        this.opens++;
        const ws = this.ws = new WebSocket(this.url);
        ws.binaryType = 'arraybuffer';
        this._setStatus('connecting');
        ws.onopen = () => {
            if(ws !== this.ws) return;
            this.retry = 0;
            this.lastRecv = performance.now();
            this._setStatus('open');
            const q = this.queue; this.queue = [];
            if(this.firstOpen) { const r = this.firstOpen; this.firstOpen = this.firstFail = null; r(); }
            else this.onReopen?.(); // the re-join goes out before what waited
            for(const b of q) this._raw(b);
        };
        ws.onmessage = (ev) => {
            if(ws !== this.ws) return;
            const b = new Uint8Array(ev.data);
            this.bytes.down += b.length;
            this.lastRecv = performance.now();
            let m;
            try { m = decode(b); } catch(e) { console.warn('net: bad message', e); return; }
            if(m.t === 'welcome') this.isHost = m.host === this.id;
            else if(m.t === 'host') this.isHost = m.id === this.id;
            this.onMessage(m);
        };
        ws.onclose = () => {
            if(ws !== this.ws) return;
            this._lost();
        };
        ws.onerror = () => {};
    }
    /** Give up on the current socket now (silent, or a test) and reconnect. */
    drop() {
        const ws = this.ws;
        if(!ws) return;
        this.ws = null;
        try { ws.close(); } catch(e) {}
        this._lost();
    }
    _lost() {
        this._setStatus('closed');
        if(this.closed) return;
        if(this.firstFail && this.retry >= 3) { const r = this.firstFail; this.firstOpen = this.firstFail = null; r(new Error(`cannot reach ${this.server}`)); return; }
        const wait = Math.min(8000, 400 * 2 ** this.retry++) * (0.75 + Math.random() * 0.5);
        setTimeout(() => this._open(), wait);
    }
    _setStatus(s) { if(s !== this.status) { this.status = s; this.onStatus?.(s); } }
    _raw(b) { this.bytes.up += b.length; this.ws.send(b); }
    send(m) {
        const b = encode(m);
        const k = m.t === 'bcast' || m.t === 'direct' ? m.m?.t : m.t; // bytes up by message type (stats)
        this.byType[k] = (this.byType[k] || 0) + b.length;
        if(this.ws?.readyState === 1 && !this.queue.length) this._raw(b);
        else if(this.queue.length < QUEUE_MAX) this.queue.push(b);
    }
    close() {
        if(this.closed) return;
        this.closed = true;
        clearInterval(this.watch);
        try { this.ws?.close(1000, 'bye'); } catch(e) {}
    }
}
