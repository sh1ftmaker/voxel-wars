/**
 * Voxel Wars room server: one Durable Object per room (PartyServer), running the same Sequencer the browser rooms use
 * (src/net/sequencer.js). It numbers terrain edits, relays game messages between clients and keeps the edit log and
 * the host's world snapshot, so late joiners catch up and a room survives its host leaving. It never simulates
 * anything: the host client runs physics, bots and the match.
 *
 *   wss://<worker>/parties/room/<name>?cid=<client id>     one socket per client (a reconnect reuses its cid)
 *
 * Wire: every message is one binary frame in the net codec (src/net/codec.js). Server-only messages:
 *   { t: 'ping', c } -> { t: 'pong', c }
 * Limits: messages over MAX_MSG bytes (MAX_SNAPSHOT for the host's snapshots) are dropped; edits are rate limited
 * per client (token bucket: EDIT_RATE per s, EDIT_BURST), other messages at MSG_RATE.
 *
 * Storage (survives the object being evicted when the room is idle): 'snap' (+ 'snap:<i>' parts, values are capped at
 * 128 KiB), 'e:<seq>' log entries after the snapshot, 'meta' { seq, game, at }. A room idle for IDLE_RESET_MS starts
 * a fresh match on the next join.
 */
import { Server, routePartykitRequest } from 'partyserver';
import { Sequencer } from '../../src/net/sequencer.js';
import { encode, decode } from '../../src/net/codec.js';

const MAX_MSG = 512 * 1024, MAX_SNAPSHOT = 4 * 1024 * 1024;
const EDIT_RATE = 25, EDIT_BURST = 60, MSG_RATE = 120, MSG_BURST = 240;
const PART = 120 * 1024;
const IDLE_RESET_MS = 30 * 60 * 1000;
const pad = (n) => String(n).padStart(10, '0');

export class Room extends Server {
    static options = { hibernate: false };

    async onStart() {
        this.conns = new Map();   // cid -> connection
        this.cidOf = new Map();   // connection id -> cid
        this.bucket = new Map();  // cid -> { edits, msgs, t }
        this.seq = new Sequencer({ send: (to, m) => this._send(to, m) });
        this.seq.onLogged = (entry) => this._persistEntry(entry);
        this.seq.onSnapshot = (snap) => this._persistSnap(snap);
        this.seq.onReset = () => this._wipe();
        this.dirty = Promise.resolve();
        const st = this.ctx.storage;
        const meta = await st.get('meta');
        if(meta && Date.now() - (meta.at || 0) > IDLE_RESET_MS) { await st.deleteAll(); return; }
        if(!meta) return;
        this.seq.seq = meta.seq | 0;
        this.seq.game = meta.game || null;
        const snapMeta = await st.get('snap');
        if(snapMeta) {
            const parts = [];
            for(let i = 0; i < snapMeta.parts; i++) parts.push(await st.get(`snap:${i}`));
            const data = new Uint8Array(snapMeta.bytes);
            let o = 0; for(const p of parts) { data.set(new Uint8Array(p), o); o += p.byteLength; }
            this.seq.snap = { seq: snapMeta.seq, data };
        }
        const entries = await st.list({ prefix: 'e:' });
        for(const [, v] of entries) this.seq.log.push(decode(new Uint8Array(v)));
        this.seq.log.sort((a, b) => a.seq - b.seq);
    }

    onConnect(conn, ctx) {
        const url = new URL(ctx.request.url);
        const cid = (url.searchParams.get('cid') || conn.id).slice(0, 32);
        // a reconnect: the old socket (if still half-open) is closed without counting as leaving
        const old = this.conns.get(cid);
        if(old && old !== conn) { this.cidOf.delete(old.id); try { old.close(4000, 'replaced'); } catch(e) {} }
        this.conns.set(cid, conn);
        this.cidOf.set(conn.id, cid);
        if(this.seq.empty && this.lastEmpty && Date.now() - this.lastEmpty > IDLE_RESET_MS) this._wipe(true);
    }

    onMessage(conn, message) {
        const cid = this.cidOf.get(conn.id);
        if(!cid || typeof message === 'string') return;
        const bytes = new Uint8Array(message);
        let m;
        try { m = decode(bytes); } catch(e) { return; }
        if(bytes.length > (m.t === 'snapshot' ? MAX_SNAPSHOT : MAX_MSG)) return;
        if(m.t === 'ping') { conn.send(encode({ t: 'pong', c: m.c, n: this.seq.clients.length })); return; }
        if(!this._allow(cid, m.t === 'edit')) return;
        this.seq.receive(cid, m);
        this._touch();
    }

    onClose(conn) { this._gone(conn); }
    onError(conn) { this._gone(conn); }
    _gone(conn) {
        const cid = this.cidOf.get(conn.id);
        this.cidOf.delete(conn.id);
        if(!cid || this.conns.get(cid) !== conn) return; // replaced by a newer socket
        this.conns.delete(cid);
        this.bucket.delete(cid);
        this.seq.disconnect(cid);
        if(this.seq.empty) this.lastEmpty = Date.now();
        this._touch();
    }

    _allow(cid, edit) {
        const now = Date.now();
        let b = this.bucket.get(cid);
        if(!b) { b = { edits: EDIT_BURST, msgs: MSG_BURST, t: now }; this.bucket.set(cid, b); }
        const dt = (now - b.t) / 1000; b.t = now;
        b.edits = Math.min(EDIT_BURST, b.edits + dt * EDIT_RATE);
        b.msgs = Math.min(MSG_BURST, b.msgs + dt * MSG_RATE);
        if(edit) { if(b.edits < 1) return false; b.edits--; return true; }
        if(b.msgs < 1) return false;
        b.msgs--; return true;
    }

    _send(to, m) {
        const b = encode(m);
        if(to === '*') { for(const c of this.conns.values()) try { c.send(b); } catch(e) {} return; }
        const c = this.conns.get(to);
        if(c) try { c.send(b); } catch(e) {}
    }

    // ---- storage
    _touch() {
        if(this.touchT) return;
        this.touchT = setTimeout(() => { this.touchT = null; this._chain(() => this.ctx.storage.put('meta', { seq: this.seq.seq, game: this.seq.game, at: Date.now() })); }, 2000);
    }
    _chain(fn) { this.dirty = this.dirty.then(fn).catch(e => console.error('storage', e)); return this.dirty; }
    _persistEntry(entry) {
        const v = encode(entry);
        if(v.length > PART) return; // too big to keep (never happens with today's edits); a snapshot will cover it
        this._chain(() => this.ctx.storage.put(`e:${pad(entry.seq)}`, v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)));
        this._touch();
    }
    _persistSnap(snap) {
        const data = snap.data, parts = Math.ceil(data.length / PART), seq = snap.seq;
        this._chain(async () => {
            const st = this.ctx.storage, puts = {};
            for(let i = 0; i < parts; i++) puts[`snap:${i}`] = data.slice(i * PART, (i + 1) * PART).buffer;
            const keys = Object.keys(puts);
            for(let i = 0; i < keys.length; i += 64) { const b = {}; for(const k of keys.slice(i, i + 64)) b[k] = puts[k]; await st.put(b); }
            await st.put('snap', { seq, parts, bytes: data.length });
            const old = [...(await st.list({ prefix: 'e:', end: `e:${pad(seq + 1)}` })).keys()];
            for(let i = 0; i < old.length; i += 128) await st.delete(old.slice(i, i + 128));
        });
    }
    _wipe(memory = false) {
        if(memory) { this.seq.log = []; this.seq.snap = null; this.seq.game = null; }
        this._chain(() => this.ctx.storage.deleteAll());
    }

    onRequest() { return new Response(JSON.stringify(this.seq.stats), { headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } }); }
}

export default {
    async fetch(request, env) {
        const res = await routePartykitRequest(request, env);
        if(res) return res;
        return new Response('Voxel Wars room server. Rooms: /parties/room/<name>', { status: 200, headers: { 'access-control-allow-origin': '*' } });
    },
};
