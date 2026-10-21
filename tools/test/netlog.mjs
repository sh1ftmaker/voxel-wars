// node tools/test/netlog.mjs: the edit log keeps clients' terrain identical (src/net). Two TerrainCores (the host's and
// a client's terrain worker) apply the same sequenced edits: blasts that shed islands, the bridge blown out at one end
// (a structural collapse), a drill, a build, a rip (lift), a seeded fracture of an island, a stamp of a piece at a
// rotated pose and a soft-ground-style sample patch. Every edit reaches the client through the wire codec and the
// Sequencer. Their chunk hashes must match; a third core joining late from the host's snapshot plus the log tail
// must match too; a chunk corrupted on purpose must be found by the hashes and repaired by a resync.
import { TerrainCore } from '../../src/voxel/TerrainCore.js';
import { rock, box, capsule, sphere } from '../../src/voxel/brushes.js';
import { Sequencer } from '../../src/net/sequencer.js';
import { encode, decode } from '../../src/net/codec.js';
import { readRegion } from '../../src/soft/region.js';

let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if(!c) fails++; };
const t0 = performance.now();

// ---- codec round trip: doubles bit-exact, typed arrays intact, big messages deflated
{
    const m = { a: 0.1 + 0.2, b: [Math.PI, -1e-300, 1 / 3], s: new Int8Array([-128, 0, 127]), f: new Float64Array([Math.E, 2 ** -1074]), big: new Uint8Array(50000).fill(7), n: null, o: { k: 'x' } };
    const bytes = encode(m), d = decode(bytes);
    ok(d.a === m.a && d.b.every((v, i) => v === m.b[i]) && d.f[0] === Math.E && d.f[1] === 2 ** -1074, 'codec: doubles round-trip bit-exact');
    ok(d.s instanceof Int8Array && d.s[0] === -128 && d.big.length === 50000 && d.big[49999] === 7 && d.n === null && d.o.k === 'x', 'codec: typed arrays and structure');
    ok(bytes.length < 2000, `codec: deflated (${bytes.length} B for a 50 kB array)`);
}

// ---- a room: the host's core applies edits as sequenced; the client's gets them through the codec
const inbox = new Map([['host', []], ['guest', []]]);
const seq = new Sequencer({ send: (to, m) => { const b = encode(m); for(const [id, box_] of inbox) if(to === '*' || to === id) box_.push(decode(b)); } });
seq.connect('host'); seq.connect('guest');
const host = new TerrainCore(), guest = new TerrainCore();
host.handle({ type: 'init' }); guest.handle({ type: 'init' });
console.log(`init x2 ${(performance.now() - t0).toFixed(0)} ms`);

const sentBy = (from, e) => seq.receive(from, { t: 'edit', req: 1, e, log: true });
/** Apply what the sequencer delivered to one core, in order (as Net does), returning the replies by seq. */
function drain(core, id, out = new Map()) {
    const box_ = inbox.get(id);
    while(box_.length) {
        const m = box_.shift();
        if(m.t !== 'seq' || m.skip) continue;
        out.set(m.seq, apply(core, m.e));
    }
    return out;
}
function apply(core, e) {
    switch(e.k) {
        case 'brush': return core.handle({ type: 'brush', spec: e.spec, op: e.op, mat: e.mat, hardness: e.hardness, conn: e.conn, erode: e.erode, debris: e.debris, lift: e.lift }).reply;
        case 'stamp': return core.handle({ type: 'stamp', grid: e.grid, t: e.t, q: e.q }).reply;
        case 'samples': return core.handle({ type: 'samples', patch: e.patch }).reply;
    }
}
const brush = (spec, o = {}) => ({ k: 'brush', spec, op: 'carve', mat: 1, hardness: true, conn: true, erode: 48, debris: 16, ...o });
const diff = (a, b) => { const A = new Map(a.hashes()), B = new Map(b.hashes()); const bad = []; for(const [k, h] of A) if(B.get(k) !== h) bad.push(k); return bad; };

// edits from both clients
sentBy('host', brush(rock([0, -0.3, -2], 1.2, 3).spec));
sentBy('guest', brush(rock([-25, 0, 5], 3, 4).spec));
sentBy('host', brush(box([-10.5, -1.6, -5], [-7.2, 1.6, 5]).spec));           // the bridge's west end: collapse
sentBy('guest', brush(capsule([30, 1, 0], [34, 1.2, 1], 0.9).spec));         // a drill
sentBy('host', brush(box([-30, 0, -10], [-27, 3, -8], 0.06).spec, { op: 'add', mat: 5, conn: false })); // a build
sentBy('guest', brush(rock([-20, 0.5, -6], 1.3, 77).spec, { hardness: false, lift: true }));            // a rip
sentBy('host', brush(rock([37.3, 2.5, -6], 1.6, 5).spec));                   // a fort wall hole
let hostReps = drain(host, 'host'); drain(guest, 'guest');
const islands = [...hostReps.values()].flatMap(r => r.islands || []);
ok(islands.length > 0 && islands.some(i => i.collapse), `islands came loose (${islands.length}, collapse: ${islands.some(i => i.collapse)})`);
ok([...hostReps.values()].some(r => r.lift && r.lift.count > 0), 'the rip lifted a lump in the worker');
let bad = diff(host, guest);
ok(bad.length === 0, `after ${hostReps.size} edits (both clients): chunk hashes equal (${bad.length} differ)`);

// a seeded fracture of the biggest island: the same pieces on both clients (as a 'bsplit' replays)
const big = islands.reduce((a, b) => (a.grid.count > b.grid.count ? a : b)).grid;
const split = (core) => core.handle({ type: 'split', grid: { ...big, sdf: big.sdf.slice(), mat: big.mat.slice() }, point: [2, 1, 1], n: 5, minCount: 16, generation: 1, seed: 12345 }).reply;
const sa = split(host), sb = split(guest);
ok(sa.pieces.length > 1 && sa.pieces.length === sb.pieces.length && sa.pieces.every((p, i) => p.count === sb.pieces[i].count && p.sdf.every((v, j) => v === sb.pieces[i].sdf[j])), `seeded fracture: the same ${sa.pieces.length} pieces on both`);

// the owner stamps a piece back at a rotated pose, and the host bakes a sample patch
const piece = sa.pieces[0];
const a = 0.37, q = [0, Math.sin(a / 2), 0.05, Math.cos(a / 2)], ql = Math.hypot(...q);
sentBy('host', { k: 'stamp', id: '3:0.f0', grid: { nx: piece.nx, ny: piece.ny, nz: piece.nz, sdf: piece.sdf, mat: piece.mat, count: piece.count, offset: piece.offset }, t: [-12.3, 0.71, 4.2], q: q.map(v => v / ql) });
const reg = readRegion(host.world, [-100, -4, -10], [-80, 8, 10]);
for(let i = 0; i < reg.sdf.length; i++) reg.sdf[i] = Math.max(-127, Math.min(127, reg.sdf[i] - ((i * 7919) % 5) + 2));
sentBy('host', { k: 'samples', patch: { lo: reg.lo, dims: reg.dims, sdf: reg.sdf, mat: reg.mat } });
const before = seq.seq;

// ---- snapshot here (as the host does on a 'mark'): only the chunks that differ from the generated level
hostReps = drain(host, 'host'); drain(guest, 'guest');
bad = diff(host, guest);
ok(bad.length === 0, `after a stamp and a sample patch: chunk hashes equal (${bad.length} differ)`);
const snapData = host.handle({ type: 'chunks', modified: true }).reply.data;
const snapBytes = encode(snapData);
seq.receive('host', { t: 'snapshot', seq: before, data: snapBytes });
ok(seq.log.length === 0, `snapshot at seq ${before}: ${snapData.length} modified chunks in ${(snapBytes.length / 1024).toFixed(1)} kB, log compacted`);

// more edits after the snapshot, then a late joiner
sentBy('guest', brush(rock([10, 0.2, 12], 2.5, 91).spec));
sentBy('host', brush(sphere([-40, 1, 0], 2).spec));
drain(host, 'host'); drain(guest, 'guest');
inbox.set('late', []);
seq.receive('late', { t: 'join' });
const welcome = inbox.get('late').shift();
ok(welcome.t === 'welcome' && welcome.snap?.seq === before && welcome.log.length === 2, `welcome: snapshot at ${welcome.snap?.seq}, ${welcome.log.length} edits after it`);
const late = new TerrainCore();
late.handle({ type: 'init' });
late.handle({ type: 'setChunks', data: decode(welcome.snap.data) });
for(const m of welcome.log) if(!m.skip) apply(late, m.e);
bad = diff(host, late);
ok(bad.length === 0, `late joiner (snapshot + log tail): chunk hashes equal (${bad.length} differ)`);

// ---- drift: a chunk corrupted on the guest is found by the hashes and repaired by a resync
const victim = [...guest.world.chunks.values()].find(c => c.sdf && host.initVersion.get(c.key) !== c.version);
victim.sdf[100] = victim.sdf[100] > 0 ? -5 : 5; victim.version++;
bad = diff(host, guest);
ok(bad.length === 1 && bad[0] === victim.key, `a corrupted chunk is found by its hash (${bad.join(' ')})`);
const fix = host.handle({ type: 'chunks', keys: bad }).reply.data;
guest.handle({ type: 'setChunks', data: decode(encode(fix)) });
ok(diff(host, guest).length === 0, 'resync: equal again');

// hash cost (all chunks, then cached)
let t = performance.now(); host.hashCache = null; host.hashes(); const full = performance.now() - t;
t = performance.now(); host.hashes(); const cached = performance.now() - t;
console.log(`hashes: ${host.world.chunks.size} chunks, ${full.toFixed(1)} ms cold, ${cached.toFixed(2)} ms cached`);

console.log(fails ? `${fails} FAILED` : 'all ok', `(${(performance.now() - t0).toFixed(0)} ms)`);
process.exit(fails ? 1 : 0);
