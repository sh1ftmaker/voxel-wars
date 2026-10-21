/** Structural collapse and thrown lumps in the browser.
 *  A: the bridge blown out at its west end: the span snaps at the east rim, hinges down, falls into the gorge and
 *     cracks (screenshots 'bridge-*'). The untouched level must not collapse anywhere first.
 *  B: a lump ripped out of the ground and thrown at the red fort's wall: no explosion, no crater; it stays a body
 *     (or a few pieces) (screenshots 'throw-*').
 *  node tools/test/collapse.mjs [url] [outdir]   (dev server running; WebGL2 headless) */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const url = process.argv[2] || 'http://127.0.0.1:5180/?bots=0&music=0';
const out = process.argv[3] || 'shots';
fs.mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', args: ['--ignore-gpu-blocklist', '--use-angle=vulkan', '--window-size=1280,720'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if(m.type() === 'error') errors.push(`[${m.type()}] ${m.text()}`); });
await page.goto(url);
await page.waitForFunction(() => window.ctx && ctx.game && document.getElementById('loading')?.style.display === 'none', { timeout: 90000 });
const shot = async (name) => { await page.screenshot({ path: `${out}/${name}.png` }); };
const evalr = (fn, ...a) => page.evaluate(fn, ...a);
const wait = (ms) => new Promise(r => setTimeout(r, ms));
let fails = 0;
const check = (ok, msg) => { console.log(ok ? '  ok  ' : '  FAIL', msg); if(!ok) fails++; };

// a camera that ignores the player (the game's camera update is skipped while __cam is set)
await evalr(() => {
    window.__log = [];
    window.__rep = [];
    const sync = ctx.world.remote, reply = sync._reply.bind(sync);
    sync._reply = (rep) => { if(rep.type === 'brush') window.__rep.push({ workerMs: +(rep.workerMs || 0).toFixed(1), islandsMs: +(rep.islandsMs || 0).toFixed(1), collapseMs: +(rep.collapseMs || 0).toFixed(1), checked: rep.collapseChecked, islands: rep.islands?.length }); return reply(rep); };
    for(const t of ['detached', 'destroyed', 'impact']) ctx.events.addEventListener(t, (e) => window.__log.push({ t, kind: e.detail.kind, collapse: e.detail.collapse, volume: e.detail.volume, at: performance.now() }));
    ctx.game.on?.('explosion', (d) => window.__log.push({ t: 'explosion', kind: d.kind, at: performance.now() }));
    const g = ctx.game;
    g.player.body.teleport([-60, 1, 30]); // out of the way (the bridge and the fort wall)
    const cam = ctx.camera;
    window.__cam = null;
    const R = ctx.renderer;
    const render = R.render.bind(R);
    R.render = (s, c) => { if(window.__cam) { c.position.set(...window.__cam.p); c.lookAt(...window.__cam.t); c.updateMatrixWorld(); } return render(s, c); };
});

// ---- A. the bridge
await evalr(() => { window.__cam = { p: [-16, 7, -15], t: [0, -2.5, 0] }; ctx.game.started = true; const st = document.createElement('style'); st.textContent = '.bz-screen, #hud, #crosshair { display: none !important }'; document.head.append(st); if(ctx.game.player.viewModel?.root) ctx.game.player.viewModel.root.visible = false; });
await wait(1500);
const before = await evalr(() => ({ bodies: ctx.destruction.bodies.list.size, collapsed: ctx.destruction.bodies.stats.collapsed || 0 }));
check(before.collapsed === 0, 'no collapse before the blast');
await shot('bridge-0');
await evalr(() => {
    const B = ctx.destruction.brushes;
    // the west end: a carve through the deck and its railings at the rim, with a blast's push
    ctx.destruction.carve(B.box([-10.5, -1.6, -5], [-7.2, 1.6, 5]), { impulse: 8, kind: 'blast' });
    // what the big pieces go through (impacts on the soft layer, its state)
    const soft = ctx.destruction.bodies.soft, imp = soft.impact.bind(soft);
    window.__imp = [];
    soft.impact = (vb, p, dv, frag) => { if(vb.volume > 20) window.__imp.push({ vol: +vb.volume.toFixed(0), dv: +Math.hypot(...dv).toFixed(1), frag: +frag.toFixed(2), brk: +ctx.destruction.bodies.breakDv(vb).toFixed(1), state: vb.softRec?.state, age: +vb.age.toFixed(2) }); return imp(vb, p, dv, frag); };
    window.__t0 = performance.now();
});
for(const ms of [150, 350, 600, 900, 1300, 1800, 2600, 3600]) {
    await page.waitForFunction((ms) => performance.now() - window.__t0 >= ms, {}, ms);
    await shot(`bridge-${String(ms).padStart(4, '0')}`);
    const big = await evalr(() => [...ctx.destruction.bodies.list].filter(b => b.volume > 20).map(b => { const t = b.body.translation(); return `${b.volume.toFixed(0)}m³@(${t.x.toFixed(1)},${t.y.toFixed(1)},${t.z.toFixed(1)})${b.stamping ? ' stamping' : ''}`; }).join(' '));
    console.log(`  t=${ms} ${big}`);
}
const A = await evalr(() => {
    const vb = ctx.destruction.bodies;
    const big = [...vb.list].map(b => ({ vol: +b.volume.toFixed(1), y: +b.body.translation().y.toFixed(1), gen: b.generation }));
    return { stats: { ...vb.stats }, soft: { ...vb.soft.stats }, collapses: window.__log.filter(e => e.t === 'detached' && e.collapse).length, bodies: big, workerMs: ctx.world.remote?.stats };
});
console.log('impacts on big pieces:', JSON.stringify(await evalr(() => window.__imp.filter(i => i.dv > 2).slice(0, 12))));
console.log('terrain worker brush replies:', JSON.stringify(await evalr(() => window.__rep)));
console.log('bridge:', JSON.stringify({ collapsed: A.stats.collapsed, cracked: A.stats.cracked, fractured: A.stats.fractured, splits: A.soft.splits, worker: A.workerMs, bodies: A.bodies.slice(0, 8) }));
check(A.stats.collapsed >= 1, 'the bridge span collapsed');
check(A.bodies.some(b => b.vol > 20) || A.stats.stamped > 0 || A.stats.fractured > 0, 'the span is a body (or its pieces)');

// ---- B. a lump thrown at the red fort's east wall
await evalr(() => { window.__cam = { p: [-26, 5, 12], t: [-34, 2, 3] }; window.__log.length = 0; });
await wait(400);
const B0 = await evalr(() => {
    const g = ctx.game, c = g.combat;
    const prop = ctx.destruction.rip([-24, -0.3, 3], 0.95);
    if(!prop) return { ok: false };
    c.hold(prop, true);
    prop.body.setNextKinematicTranslation({ x: -27, y: 2.6, z: 3 });
    window.__prop = prop;
    window.__vol = prop.userData.volume;
    return { ok: true, vol: prop.userData.volume };
});
check(B0.ok, `ripped a lump (${B0.vol?.toFixed?.(2)} m³)`);
await wait(300);
await shot('throw-0');
await evalr(() => {
    const g = ctx.game;
    g.combat.throwHeld(g.player, window.__prop, [-1, 0, 0], 36);
    window.__t1 = performance.now();
    // matter near the wall over time (bodies settle and are stamped back into the terrain after ~2 s)
    window.__near = { n: 0, vol: 0 };
    const tick = () => {
        let n = 0, vol = 0;
        for(const b of ctx.destruction.bodies.list) { if(b.dead) continue; const t = b.body.translation(); if(Math.hypot(t.x + 33, t.z - 3) < 8 && t.y > -2) { n++; vol += b.volume; } }
        if(vol > window.__near.vol * 0.999 || n > window.__near.n) window.__near = { n: Math.max(n, window.__near.n), vol: Math.max(vol, window.__near.vol) };
        if(performance.now() - window.__t1 < 2500) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
});
for(const ms of [100, 200, 350, 600, 1000, 1600]) {
    await page.waitForFunction((ms) => performance.now() - window.__t1 >= ms, {}, ms);
    await shot(`throw-${String(ms).padStart(4, '0')}`);
}
await wait(1200);
const Bres = await evalr(() => {
    const L = window.__log;
    const near = window.__near;
    return { explosions: L.filter(e => e.t === 'explosion').length, blasts: L.filter(e => e.t === 'destroyed' && e.kind === 'blast').length,
        impacts: L.filter(e => e.t === 'impact').length, dust: L.filter(e => e.t === 'destroyed').map(e => +(e.volume || 0).toFixed(2)), near, stamped: ctx.destruction.bodies.stats.stamped };
});
console.log('throw:', JSON.stringify(Bres));
check(Bres.explosions === 0 && Bres.blasts === 0, 'no explosion or crater from the throw');
check(Bres.near.n >= 1 && Bres.near.vol > B0.vol * 0.5, `the lump stays matter: up to ${Bres.near.n} bodies near the wall, ${Bres.near.vol.toFixed(2)} m³`);
const fps = await evalr(() => new Promise(r => { let n = 0; const t0 = performance.now(); const f = () => { if(++n === 60) r(60000 / (performance.now() - t0)); else requestAnimationFrame(f); }; requestAnimationFrame(f); }));
console.log(`fps ${fps.toFixed(0)}`);
console.log('errors', errors.length, errors.slice(0, 5));
check(errors.length === 0, 'no console errors');
await browser.close();
process.exit(fails ? 1 : 0);
