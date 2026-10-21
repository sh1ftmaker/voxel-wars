/** Online play end to end (src/game/NetGame.js, src/net, server/): three players in one room on a room server, each in
 *  its own browser (a background tab gets no animation frames). Checks: teams are balanced and everyone sees the
 *  others move; a rocket from B kills A (damage by the host, death and respawn everywhere); blasts and debris converge
 *  (chunk hashes equal, debris poses agree); a grabbed lump follows its holder on the other screens; a late joiner
 *  catches up; when the host leaves the next player hosts and runs the bots on; no console errors. Prints bytes per
 *  second per client.
 *
 *  node tools/test/mp.mjs [page url] [server url]
 *    page url    the game (dev server), default http://127.0.0.1:5199/
 *    server url  the room server, default ws://127.0.0.1:8787 (`npx wrangler dev --port 8787` in server/);
 *                'deployed' uses the client's default (the deployed worker) */
import puppeteer from 'puppeteer-core';
const base = process.argv[2] || 'http://127.0.0.1:5199/';
const server = process.argv[3] || 'ws://127.0.0.1:8787';
const room = `mp${Date.now() % 1000000}`;
const q = (name) => `?room=${room}${server === 'deployed' ? '' : `&server=${encodeURIComponent(server)}`}&music=0&minutes=20&name=${name}`;
const errors = [];
let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); if(!c) fails++; };
const w = (ms) => new Promise(r => setTimeout(r, ms));
const browsers = [];
async function open(name) {
    const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', args: ['--ignore-gpu-blocklist', '--use-angle=vulkan', '--window-size=640,360', '--autoplay-policy=no-user-gesture-required'] });
    browsers.push(browser);
    const page = await browser.newPage();
    await page.setViewport({ width: 640, height: 360 });
    page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
    page.on('console', m => { const t = m.text(); if(m.type() === 'error') errors.push(`${name}: ${t}`); else if(/^net:/.test(t)) console.log(`  [${name}] ${t}`); });
    await page.goto(base + q(name));
    await page.waitForFunction(() => window.ctx?.game && document.getElementById('loading')?.style.display === 'none', { timeout: 120000 });
    page.browser_ = browser;
    return page;
}
const info = (p) => p.evaluate(() => {
    const g = ctx.game, ng = g.netGame, c = g.player.body.center;
    return { id: ctx.net.id, host: ctx.net.isHost, team: g.player.team, alive: g.player.alive, hp: g.player.health, pos: [c.x, c.y, c.z], kills: g.player.kills, deaths: g.player.deaths,
        remotes: [...ng.remotes.values()].map(r => ({ id: r.netId, team: r.team, bot: r.isBot, alive: r.alive, pos: [r.view.x, r.view.y, r.view.z] })),
        bots: g.bots.length, time: g.timeLeft, applied: ctx.net.applied, queued: ctx.net.queue.size, pending: ctx.world.remote.pending, stats: ng.stats, bytes: { ...ctx.net.transport.bytes }, ping: ctx.net.ping };
});
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
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

try {
    const A = await open('Alice');
    const B = await open('Bob');
    await w(2500);
    let [ia, ib] = await Promise.all([info(A), info(B)]);
    ok(ia.host && !ib.host, `A hosts (${ia.id}), B is a guest (${ib.id})`);
    ok(ia.team !== ib.team, `teams balanced: A ${ia.team}, B ${ib.team}`);
    ok(ia.bots >= 4 && ib.bots === 0, `bots run on the host only (host ${ia.bots}, guest ${ib.bots}); guest sees ${ib.remotes.filter(r => r.bot).length} bot(s)`);
    const bOnA = ia.remotes.find(r => r.id === `p:${ib.id}`), aOnB = ib.remotes.find(r => r.id === `p:${ia.id}`);
    ok(!!bOnA && !!aOnB, 'each sees the other player');

    // B walks somewhere: A sees it there
    await B.evaluate(() => { ctx.game.player.body.teleport([4, 0.5, 6]); });
    await w(800);
    [ia, ib] = await Promise.all([info(A), info(B)]);
    const seen = ia.remotes.find(r => r.id === `p:${ib.id}`);
    ok(seen && dist(seen.pos, ib.pos) < 0.6, `A sees B where B is (off by ${seen ? dist(seen.pos, ib.pos).toFixed(2) : '?'} m)`);
    // moving: B runs; A's view lags by about the interpolation delay
    await B.evaluate(() => { const b = ctx.game.player.body; window.__run = setInterval(() => { const c = b.feet; b.teleport([c.x + 0.15, c.y, c.z]); }, 16); });
    await w(1000);
    [ia, ib] = await Promise.all([info(A), info(B)]);
    const run = ia.remotes.find(r => r.id === `p:${ib.id}`);
    console.log(`  B running: B at ${ib.pos.map(v => v.toFixed(1))}, A draws B at ${run?.pos.map(v => v.toFixed(1))} (${dist(run.pos, ib.pos).toFixed(2)} m behind)`);
    ok(run && dist(run.pos, ib.pos) < 4, 'A follows B while it runs');
    await B.evaluate(() => clearInterval(window.__run));

    // bots off for the damage test (the host's toggle), and both players side by side
    await A.evaluate(() => ctx.game.setBots(false));
    await w(800);
    ib = await info(B);
    ok(ib.remotes.filter(r => r.bot).length === 0, 'bots off on the host: gone on the guest too');
    await A.evaluate(() => { ctx.game.player.body.teleport([-6, 0.3, 14]); });
    await B.evaluate(() => { ctx.game.player.body.teleport([-6, 0.3, 4]); });
    await w(1200);
    // B blasts A (B's view of A): the host takes A's health; A dies; B gets the kill; A respawns
    for(let k = 0; k < 6; k++) {
        await B.evaluate(() => { const ng = ctx.game.netGame, a = [...ng.remotes.values()].find(r => !r.isBot); const c = a.body.center; ctx.game.combat.explode([c.x, c.y - 0.6, c.z + 0.3], 'rocket', ctx.game.player); });
        await w(500);
        if(!(await info(A)).alive) break;
    }
    [ia, ib] = await Promise.all([info(A), info(B)]);
    ok(!ia.alive && ia.deaths === 1, `B's rockets killed A (A alive ${ia.alive}, deaths ${ia.deaths})`);
    ok(ib.kills === 1, `B has the kill (${ib.kills})`);
    const aOnB2 = ib.remotes.find(r => r.id === `p:${ia.id}`);
    ok(aOnB2 && !aOnB2.alive, 'B sees A dead');
    await w(5000);
    [ia, ib] = await Promise.all([info(A), info(B)]);
    ok(ia.alive && ia.hp === 100, `A respawned (hp ${ia.hp})`);

    // blasts from both, debris: terrain converges and the host's debris poses agree on the guest
    await A.bringToFront();
    await A.evaluate(() => { const d = ctx.destruction; d.blast([0, -0.3, -2], 1.4); d.carve(d.brushes.box([-10.5, -1.6, -5], [-7.2, 1.6, 5]), { impulse: 6, kind: 'blast' }); });
    await B.evaluate(() => { const d = ctx.destruction; d.blast([-25, 0, 5], 3); });
    await w(1200);
    const poses = async (p) => p.evaluate(() => { const o = {}; for(const vb of ctx.destruction.bodies.list) if(!vb.dead && vb.netId) { const t = vb.body.translation(); o[vb.netId] = [t.x, t.y, t.z, vb.owner]; } return o; });
    let errs = [];
    for(let k = 0; k < 6; k++) {
        const [pa, pb] = await Promise.all([poses(A), poses(B)]);
        for(const id in pa) if(pb[id]) errs.push(dist(pa[id], pb[id]));
        await w(300);
    }
    errs.sort((a, b) => a - b);
    const med = errs[Math.floor(errs.length / 2)] ?? -1, p90 = errs[Math.floor(errs.length * 0.9)] ?? -1;
    console.log(`  debris pose difference host vs guest while falling: ${errs.length} samples, median ${med.toFixed(2)} m, p90 ${p90.toFixed(2)} m, max ${errs.length ? errs[errs.length - 1].toFixed(2) : '-'} m`);
    ok(errs.length > 0 && med < 0.6, 'debris poses agree within tolerance (median < 0.6 m)');
    await w(12000);
    await converge([A, B], 'after blasts, debris and stamps');

    // B rips a lump and holds it: A sees it over B's head (B owns it now)
    const rip = await B.evaluate(async () => {
        const g = ctx.game, p = g.player, w = (ms) => new Promise(r => setTimeout(r, ms));
        p.body.teleport([20, 0.3, -12]); p.yaw = 0; p.pitch = -1.2; await w(300);
        p.arsenal.grab('grab');
        for(let k = 0; k < 40 && !p.held; k++) await w(50);
        await w(800);
        const h = p.held; if(!h) return { fail: { alive: p.alive, carrying: !!p.carrying, tearing: !!p.arsenal.tearing, cool: p.arsenal.cool.grab, pos: p.body.center } };
        const t = h.body.translation();
        return { id: h.userData.voxelBody?.netId ?? null, pos: [t.x, t.y, t.z] };
    });
    await w(400);
    if(rip?.id) {
        const onA = await A.evaluate((id) => { for(const vb of ctx.destruction.bodies.list) if(vb.netId === id) { const t = vb.body.translation(); return { pos: [t.x, t.y, t.z], kin: vb.body.isKinematic(), owner: vb.owner }; } return null; }, rip.id);
        const now = await B.evaluate(() => { const t = ctx.game.player.held.body.translation(); return [t.x, t.y, t.z]; });
        console.log(`  held lump ${rip.id}: on B ${now.map(v => v.toFixed(1))}, on A ${onA?.pos.map(v => v.toFixed(1))} (kinematic ${onA?.kin}, owner ${onA?.owner})`);
        ok(onA && dist(onA.pos, now) < 1.0 && onA.kin, 'A sees the lump held over B (kinematic, within 1 m)');
        await B.evaluate(() => ctx.game.player.arsenal.release(true));
    } else ok(false, `B ripped a lump ${JSON.stringify(rip)}`);

    // bandwidth over 10 s with bots on again
    await A.evaluate(() => ctx.game.setBots(true));
    await w(1500);
    const b0 = await Promise.all([A, B].map(info));
    await w(10000);
    const b1 = await Promise.all([A, B].map(info));
    const types = await A.evaluate(() => ctx.net.transport.byType || {});
    console.log('  host bytes up by type (whole session):', JSON.stringify(Object.fromEntries(Object.entries(types).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Math.round(v / 1024) + ' KB']))));
    ['A (host)', 'B'].forEach((n, i) => console.log(`  ${n}: up ${((b1[i].bytes.up - b0[i].bytes.up) / 10240).toFixed(1)} KB/s, down ${((b1[i].bytes.down - b0[i].bytes.down) / 10240).toFixed(1)} KB/s, ping ${Math.round(b1[i].ping)} ms`));

    // a late joiner
    const C = await open('Carol');
    await w(3000);
    const ic = await info(C);
    ok(ic.remotes.some(r => r.id === `p:${ia.id}`) && ic.remotes.some(r => r.id === `p:${ib.id}`) && ic.remotes.some(r => r.bot), `C joined late and sees A, B and ${ic.remotes.filter(r => r.bot).length} bots`);
    await converge([A, B, C], 'three players (C from snapshot + log)');

    // C's connection drops: edits made meanwhile arrive when it is back, and it is in the match again
    await C.evaluate(() => ctx.net.transport.drop()); // as a dead connection would
    await w(300);
    await A.evaluate(() => ctx.destruction.blast([-14, 0, -8], 2.2));
    await w(5000);
    const icr = await info(C), iar = await info(A);
    console.log('  C transport after the drop:', JSON.stringify(await C.evaluate(() => { const t = ctx.net.transport; return { status: t.status, opens: t.opens, rejoining: ctx.net.rejoining, lastSeen: ctx.net.lastSeen, next: ctx.net.next, queued: ctx.net.queue.size, ready: t.ws?.readyState }; })));
    ok(icr.applied >= iar.applied - 2, `C reconnected and caught up (C seq ${icr.applied}, A ${iar.applied})`);
    ok(iar.remotes.some(r => r.id === `p:${icr.id}`), 'the host has C in the match again');
    await converge([A, B, C], 'after C reconnected');

    // the host leaves: B (the oldest) hosts, takes over the bots, the clock runs on
    const tBefore = (await info(B)).time;
    await A.browser_.close();
    browsers.splice(browsers.indexOf(A.browser_), 1);
    await w(4000);
    const [ib2, ic2] = await Promise.all([info(B), info(C)]);
    ok(ib2.host && !ic2.host, `B hosts now (B ${ib2.host}, C ${ic2.host})`);
    ok(ib2.bots >= 4, `B runs the bots (${ib2.bots})`);
    ok(!ic2.remotes.some(r => r.id === `p:${ia.id}`), 'A is gone from C');
    ok(ic2.remotes.filter(r => r.bot).length >= 4, `C sees B's bots (${ic2.remotes.filter(r => r.bot).length})`);
    ok(ib2.time < tBefore && ib2.time > tBefore - 10, `the clock runs on (${tBefore.toFixed(0)} -> ${ib2.time.toFixed(0)})`);
    const botMoves = await C.evaluate(async () => { const r = [...ctx.game.netGame.remotes.values()].filter(x => x.isBot); const a = r.map(x => x.view.clone()); await new Promise(z => setTimeout(z, 6000)); return r.filter((x, i) => x.view.distanceTo(a[i]) > 0.5).length; });
    ok(botMoves > 0, `the bots keep moving under the new host (${botMoves} moved)`);
    await B.evaluate(() => ctx.destruction.blast([10, 0, 10], 2));
    await w(6000);
    await converge([B, C], 'after the host left');
} catch(e) { console.error(e); fails++; }
const relevant = errors.filter(e => !/favicon/.test(e));
ok(!relevant.length, `no console errors${relevant.length ? ': ' + relevant.slice(0, 5).join(' | ') : ''}`);
for(const b of browsers) await b.close().catch(() => {});
console.log(fails ? `${fails} failed` : 'all ok');
process.exit(fails ? 1 : 0);
