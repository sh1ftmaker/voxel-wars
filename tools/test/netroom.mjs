/** Two tabs in a room (?room=, BroadcastChannel; src/net): both blast, drill, build and rip; the host's debris settles
 *  and is stamped through the log. After everything has settled both tabs' chunk hashes must be equal. Then: a chunk
 *  edited behind the log's back on the guest is caught by the periodic hash check and resynced; a third tab joining
 *  late (snapshot + log tail) converges too; single player (no room) still works. No console errors.
 *  node tools/test/netroom.mjs [base url]   (dev server running, e.g. PORT=5197 node tools/dev.mjs) */
import puppeteer from 'puppeteer-core';
const base = process.argv[2] || 'http://127.0.0.1:5197/';
const room = `t${Date.now() % 100000}`;
const q = `?room=${room}&local=1&snapEvery=10&fly=1&bots=0&music=0`; // local: tabs of this browser (BroadcastChannel)
const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', args: ['--ignore-gpu-blocklist', '--use-angle=vulkan', '--window-size=960,540'] });
const errors = [];
let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if(!c) fails++; };
const w = (ms) => new Promise(r => setTimeout(r, ms));
async function open(url, name) {
    const page = await browser.newPage();
    await page.setViewport({ width: 640, height: 360 });
    page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
    page.on('console', m => { const t = m.text(); if(m.type() === 'error') errors.push(`${name}: ${t}`); else if(/^net:/.test(t)) console.log(`  [${name}] ${t}`); });
    await page.goto(url);
    await page.waitForFunction(() => window.ctx && document.getElementById('loading')?.style.display === 'none', { timeout: 120000 });
    return page;
}
const info = (p) => p.evaluate(() => ({ id: ctx.net.id, host: ctx.net.isHost, applied: ctx.net.applied, queued: ctx.net.queue.size, pending: ctx.world.remote.pending, bodies: ctx.destruction.bodies.list.size, stats: ctx.net.stats, check: ctx.net.lastCheck ?? null }));
/** Wait until every page has applied the same seq and has nothing in flight, then compare their hashes. */
async function converge(pages, label, timeout = 30000) {
    const t0 = Date.now();
    let infos;
    for(;;) {
        infos = await Promise.all(pages.map(info));
        const s = infos[0].applied;
        if(infos.every(i => i.applied === s && !i.queued && !i.pending)) break;
        if(Date.now() - t0 > timeout) break;
        await w(250);
    }
    const hs = await Promise.all(pages.map(p => p.evaluate(async () => [...(await ctx.net.hashNow())])));
    const ref = new Map(hs[0]);
    const bad = hs.slice(1).map(h => h.filter(([k, v]) => ref.get(k) !== v).map(([k]) => k));
    ok(bad.every(b => !b.length) && infos.every(i => i.applied === infos[0].applied), `${label}: seq ${infos.map(i => i.applied).join('/')}, ${ref.size} chunk hashes equal (differ: ${bad.map(b => b.length).join('/')})`);
    return infos;
}

const A = await open(base + q, 'A');
const B = await open(base + q, 'B');
let [ia, ib] = await Promise.all([info(A), info(B)]);
ok(ia.host && !ib.host, `A hosts (${ia.id}), B is a guest (${ib.id})`);

// both tabs edit: blasts that shed debris, the bridge's west end, a drill, a build, a rip
await A.evaluate(() => { const d = ctx.destruction; d.blast([0, -0.3, -2], 1.4); d.carve(d.brushes.box([-10.5, -1.6, -5], [-7.2, 1.6, 5]), { impulse: 6, kind: 'blast' }); d.blast([37.3, 2.5, -6], 1.8); });
await B.evaluate(() => { const d = ctx.destruction; d.blast([-25, 0, 5], 3); d.carve(d.brushes.capsule([30, 1, 0], [34, 1.2, 1], 0.9)); d.carve(d.brushes.box([-30, 0, -10], [-27, 3, -8], 0.06), { op: 'add', mat: 5 }); d.rip([-20, 0.5, -6], 1.3); });
await w(1500);
[ia, ib] = await Promise.all([info(A), info(B)]);
ok(ia.bodies > 0 && ib.bodies > 0, `debris on both tabs (host ${ia.bodies}, guest ${ib.bodies} bodies)`);
// the host breaks its debris: the guest replays the same splits on its copies ('bsplit'). A background tab gets no
// animation frames (no physics), so the tab that has to act is brought to the front.
await A.bringToFront();
await w(1500);
await A.evaluate(async () => {
    const d = ctx.destruction, w = (ms) => new Promise(r => setTimeout(r, ms));
    for(let k = 0; k < 3; k++) {
        for(const vb of [...d.bodies.list]) if(!vb.dead && vb.grid.count > 200) { const c = vb.body.worldCom(); vb.body.applyImpulse({ x: 0, y: -vb.mass * 40, z: 0 }, true); d.bodies.breaks.set(vb, [[c.x, c.y, c.z], 40]); }
        await w(400);
    }
});
await B.bringToFront();
await w(1500);
const fa = await A.evaluate(() => ctx.destruction.bodies.stats.fractured), fb = await B.evaluate(() => ctx.destruction.bodies.stats.fractured);
console.log('  guest split replay:', JSON.stringify(await B.evaluate(() => ({ ...ctx.destruction.bodies.stats.net, later: ctx.destruction.bodies.laterSplits?.size, ids: [...ctx.destruction.bodies.list].map(v => v.netId).slice(0, 12) }))));
ok(fa > 0 && fb > 0, `the host fractured debris ${fa}x, the guest replayed ${fb}x`);
// the host's debris settles and is stamped (edits), the guest drops its copies
await A.bringToFront();
await w(14000);
[ia, ib] = await Promise.all([info(A), info(B)]);
console.log(`  after settling: host bodies ${ia.bodies}, guest ${ib.bodies}; host stats ${JSON.stringify(ia.stats)}`);
await converge([A, B], 'two tabs after blasts, a collapse, a rip and stamps');
ok(ib.stats.hashChecks > 0 && ib.stats.mismatches === 0, `periodic hash checks on the guest: ${ib.stats.hashChecks}, mismatches ${ib.stats.mismatches}`);

// drift: an edit applied on the guest behind the log's back is found by the next check and resynced
await B.evaluate(() => ctx.world.remote.brush({ type: 'sphere', c: [5, 0, 8], r: 1.5 }, { op: 'carve' }));
await A.evaluate(() => ctx.destruction.blast([-5, 0, 14], 1.2)); // something changes, so the host marks a check
await w(6000);
ib = await info(B);
ok(ib.stats.mismatches > 0 && ib.stats.resyncs > 0, `drift caught: ${ib.stats.mismatches} chunk(s) differed, ${ib.stats.resyncs} resent`);
await converge([A, B], 'after the resync');

// a late joiner: the host's snapshot (marked every few seconds) plus the log tail
await A.evaluate(() => { for(let i = 0; i < 3; i++) ctx.destruction.blast([12 + i * 3, 0.2, -12], 1.5); });
await w(11000); // a snapshot mark
await B.evaluate(() => ctx.destruction.blast([20, 0.2, 12], 2));
const C = await open(base + q, 'C');
await w(4000);
const ic = await info(C);
ok(!ic.host && ic.applied > 0, `C joined late (applied up to seq ${ic.applied})`);
await converge([A, B, C], 'three tabs (C from a snapshot and the log tail)');
const snap = (await info(A)).stats;
ok(snap.snapshots > 0, `the host made ${snap.snapshots} snapshot(s), last ${(snap.snapBytes / 1024).toFixed(1)} kB in ${snap.lastSnapMs.toFixed(0)} ms`);

// single player is untouched
const S = await open(base + '?fly=1&bots=0&music=0', 'S');
const sp = await S.evaluate(async () => { const r = ctx.destruction.blast([-25, 0, 5], 2.5); await r.done; return { single: ctx.net.single, volume: r.volume }; });
ok(sp.single && sp.volume > 1, `single player: LocalTransport, a blast removes ${sp.volume.toFixed(1)} m³`);

ok(errors.length === 0, `no console errors${errors.length ? ': ' + errors.slice(0, 5).join(' | ') : ''}`);
await browser.close();
console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
