/**
 * Granular ground in the game (headless Chromium, ?mpm=1): blast the red sand dune and a snow cap, pour a dune flank
 * with the avalanche key (V), and check each one end to end:
 *   - grains appear (the terrain worker cut them out of the terrain), pour and come to rest
 *   - the host (single player) re-deposits them: the deposit edit is applied, the zone is gone, and the terrain
 *     around it holds the grains' matter again (solid volume in a box after the deposit vs once the grains were cut)
 *   - frame interval (median, p95) while the grains move, the mpm system's main-thread time per frame, the solver's
 *     time per step (worker), draw calls and triangles
 *   - busy: three slides at once (three zones) in the overview and the midfield: frame interval against idle
 *   - --mp: two tabs in a room: both cut the same grains, only the host deposits, the terrain ends the same in both;
 *     a host without the simulation puts a guest's grains straight back
 *   - no console errors
 * Screenshots before, during (0.25 s, 0.6 s, 1.2 s) and after -> <outDir>/mpm-<scenario>-*.png
 *
 * Backend: Chromium's WebGL2 on the real GPU (the flags of leveltour.mjs), so the CPU-worker solver runs here. Headless
 * Chromium's WebGPU is SwiftShader, whose device is lost within seconds even with MPM off; the GPU solver and its
 * draw path are tested on a real GPU by tools/test/mpmgpu.mjs (Dawn in Node).
 * node tools/test/mpmgame.mjs [outDir] [--url http://127.0.0.1:5180/] [--only dune,snow,avalanche,busy] [--uncapped] [--mp]
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const args = process.argv.slice(2);
const val = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const out = args[0] && !args[0].startsWith('--') ? args[0] : 'shots/mpm';
const base = val('--url', 'http://127.0.0.1:5180/');
const only = val('--only', null)?.split(',');
fs.mkdirSync(out, { recursive: true });

const SCENARIOS = [
    // name, camera, look at, action (in the page), the box (m) whose terrain is measured
    { name: 'dune', cam: [-8.0, 3.6, -11.5], at: [-14.5, 0.2, -17.5], act: 'ctx.destruction.blast([-14.1, 1.0, -17.1], 1.4, { strength: 14 })', box: [[-20, -2, -23], [-8, 4, -11]] },
    { name: 'snow', cam: [-17.0, 11.0, 19.5], at: [-21.3, 8.4, 25.2], act: 'ctx.destruction.blast([-21.3, 8.8, 23.4], 1.4, { strength: 14 })', box: [[-27, 0, 18], [-15, 11, 31]] },
    { name: 'avalanche', cam: [-25.0, 3.0, -12.0], at: [-30.0, 0.2, -17.5], act: 'keyV', aim: [-28.6, 0.5, -16.4], box: [[-36, -2, -24], [-24, 4, -11]] },
];

const uncapped = args.includes('--uncapped'); // vsync off: frame intervals show the frame's cost, not 16.7 ms
const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', args: ['--ignore-gpu-blocklist', '--use-angle=vulkan', '--window-size=1280,720', ...(uncapped ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : [])], protocolTimeout: 600000 });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if(m.type() === 'error') errors.push(m.text()); });
await page.goto(`${base}?fly=1&bots=0&music=0&mpm=1`);
await page.waitForFunction(() => window.ctx && document.getElementById('loading')?.style.display === 'none', { timeout: 300000 });
const backend = await page.evaluate(() => ({ gpu: ctx.renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2', mpm: ctx.mpm.label }));
console.log(`backend ${backend.gpu}, granular ground: ${backend.mpm}`);
await new Promise(r => setTimeout(r, 2500));
// the mpm system's main-thread time per frame
await page.evaluate(() => {
    const m = ctx.mpm, up = m.update.bind(m);
    window.__mpmMs = [];
    m.update = (dt) => { const t0 = performance.now(); up(dt); window.__mpmMs.push(performance.now() - t0); };
});
const solidIn = (box) => page.evaluate((box) => {
    const V = 0.25, w = ctx.world;
    let v = 0;
    for(let z = Math.floor(box[0][2] / V); z <= Math.ceil(box[1][2] / V); z++) for(let y = Math.floor(box[0][1] / V); y <= Math.ceil(box[1][1] / V); y++) for(let x = Math.floor(box[0][0] / V); x <= Math.ceil(box[1][0] / V); x++)
        v += Math.min(1, Math.max(0, 0.5 - w.get(x, y, z) / 32));
    return v * V ** 3;
}, box);

let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if(!ok) failed++; };
const report = [];
for(const sc of SCENARIOS) {
    if(only && !only.includes(sc.name)) continue;
    await page.evaluate((cam, at) => { ctx.camera.position.set(...cam); ctx.camera.lookAt(...at); }, sc.cam, sc.at);
    await new Promise(r => setTimeout(r, 1000));
    await page.screenshot({ path: `${out}/mpm-${sc.name}-0-before.png` });
    const before = await solidIn(sc.box);
    const s0 = await page.evaluate(() => ({ dep: ctx.mpm.stats.depositsApplied, spawned: ctx.mpm.stats.spawned }));
    // frame intervals from now on
    await page.evaluate(() => { window.__frames = []; let last = performance.now(); const tick = (t) => { window.__frames.push(t - last); last = t; if(window.__frames.length < 100000) requestAnimationFrame(tick); }; requestAnimationFrame(tick); window.__mpmMs.length = 0; });
    if(sc.act === 'keyV') {
        await page.evaluate((cam, aim) => { ctx.camera.position.set(...cam); ctx.camera.lookAt(...aim); }, sc.cam, sc.aim);
        await page.keyboard.press('KeyV');
    } else await page.evaluate(sc.act);
    const t0 = Date.now();
    for(const ms of [250, 600, 1200]) {
        await new Promise(r => setTimeout(r, Math.max(0, ms - (Date.now() - t0))));
        await page.screenshot({ path: `${out}/mpm-${sc.name}-${String(ms).padStart(4, '0')}.png` });
    }
    // after the blast landed: the grains were cut out (the deposit comes later: grains need over a second to settle)
    const cut = await page.evaluate((d) => ctx.mpm.stats.depositsApplied - d, s0.dep) === 0 ? await solidIn(sc.box) : null;
    const spawned = await page.evaluate((s) => ctx.mpm.stats.spawned - s, s0.spawned);
    const afterCut = await page.evaluate(() => ctx.mpm.zones.filter(Boolean).length);
    let settled = null, st;
    for(let i = 0; i < 60; i++) {
        st = await page.evaluate((d) => ({ applied: ctx.mpm.stats.depositsApplied - d, zones: ctx.mpm.zones.filter(Boolean).length, last: ctx.mpm.stats.lastDeposit, worker: ctx.mpm.sim.stats?.workerMs }), s0.dep);
        if(st.applied > 0 && st.zones === 0) { settled = (Date.now() - t0) / 1000; break; }
        await new Promise(r => setTimeout(r, 250));
    }
    const perf = await page.evaluate(() => {
        const f = window.__frames.slice(2).sort((a, b) => a - b), m = window.__mpmMs.slice().sort((a, b) => a - b);
        const info = ctx.renderer.info.render;
        return { frames: f.length, med: f[f.length >> 1], p95: f[Math.floor(f.length * 0.95)], mpmMed: m[m.length >> 1], mpmMax: m[m.length - 1], calls: info.drawCalls ?? info.calls, tris: info.triangles };
    });
    await new Promise(r => setTimeout(r, 800));
    await page.screenshot({ path: `${out}/mpm-${sc.name}-9-after.png` });
    const after = await solidIn(sc.box);
    const r = { name: sc.name, grains: spawned, settledS: settled, deposit: st.last, frameMedMs: +perf.med?.toFixed(1), frameP95Ms: +perf.p95?.toFixed(1), mpmMainMs: +perf.mpmMed?.toFixed(3), mpmMainMaxMs: +perf.mpmMax?.toFixed(2), workerMs: st.worker && +st.worker.toFixed(2), calls: perf.calls, tris: perf.tris, terrainBefore: +before.toFixed(2), terrainCut: cut && +cut.toFixed(2), terrainAfter: +after.toFixed(2) };
    report.push(r);
    console.log(JSON.stringify(r));
    check(spawned > 100 && afterCut >= 0, `${sc.name}: grains came out of the terrain (${spawned} particles)`);
    check(settled !== null, `${sc.name}: they came to rest and the host's deposit was applied (${settled?.toFixed(1)} s)`);
    check(st.last && st.last.volume > 0.5, `${sc.name}: the deposit carried ${st.last?.volume.toFixed(2)} m³ (${st.last?.particles} particles)`);
    check(cut !== null && after - cut > 0.8 * (st.last?.volume ?? 0), `${sc.name}: the terrain took the deposit back (${cut?.toFixed(2)} -> ${after.toFixed(2)} m³ in the box)`);
    check(perf.p95 < 20, `${sc.name}: frames held while the grains moved (median ${perf.med?.toFixed(1)} ms, p95 ${perf.p95?.toFixed(1)} ms)`);
}
// ---- busy: three slides at once (dune, berm, snow cap: three zones), the overview and the midfield, frame cost
// uncapped (vsync off) against the same views idle
if(!only || only.includes('busy')) {
    const views = [['overview', [0, 45, 62], [0, 0, 0]], ['midfield', [-6, 6, -4], [-16, 0, -12]]];
    const measure = () => page.evaluate(async () => {
        const ts = []; let last = performance.now();
        for(let i = 0; i < 90; i++) { await new Promise(r => requestAnimationFrame(r)); const n = performance.now(); ts.push(n - last); last = n; }
        ts.sort((a, b) => a - b);
        const info = ctx.renderer.info.render;
        return { med: +ts[45].toFixed(2), p95: +ts[85].toFixed(2), calls: info.drawCalls ?? info.calls, tris: info.triangles, grains: ctx.mpm.zones.filter(Boolean).reduce((a, z) => a + z.count, 0) };
    });
    const res = {};
    for(const [name, pos, at] of views) {
        await page.evaluate((pos, at) => { ctx.camera.position.set(...pos); ctx.camera.lookAt(...at); }, pos, at);
        await new Promise(r => setTimeout(r, 600));
        res[name] = { idle: await measure() };
        await page.evaluate(() => {
            ctx.destruction.blast([-30.0, 0.9, -17.5], 1.4, { strength: 14 });
            ctx.destruction.blast([-14.0, 0.7, 9.3], 1.3, { strength: 14 });
            ctx.destruction.blast([-56.0, 8.6, 27.0], 1.4, { strength: 14 });
        });
        await new Promise(r => setTimeout(r, 300));
        res[name].pouring = await measure();
        await page.screenshot({ path: `${out}/mpm-busy-${name}.png` });
        for(let i = 0; i < 60 && await page.evaluate(() => ctx.mpm.zones.some(Boolean)); i++) await new Promise(r => setTimeout(r, 250));
        console.log(`busy ${name}: idle ${JSON.stringify(res[name].idle)} | three slides ${JSON.stringify(res[name].pouring)}`);
        check(res[name].pouring.grains > 0, `busy ${name}: grains were moving while measured (${res[name].pouring.grains})`);
        check(res[name].pouring.p95 < 20, `busy ${name}: frames held with three zones (median ${res[name].pouring.med} ms, p95 ${res[name].pouring.p95} ms; idle ${res[name].idle.med} ms)`);
    }
    report.push({ name: 'busy', ...res });
}
// ---- multiplayer (--mp): two tabs in a room (BroadcastChannel, src/net). The guest blasts the dune: both tabs cut
// the same grains and simulate them, only the host deposits, and the tabs end with the same terrain. Then a host
// without the simulation (?mpm=0) and a guest with it: the host puts the grains straight back.
if(args.includes('--mp')) {
    for(const [hostMpm, label] of [['1', 'host and guest simulate'], ['0', 'host without the simulation']]) {
        const room = `mpm${Date.now() % 100000}`;
        const open = async (q, name) => {
            const p = await browser.newPage();
            await p.setViewport({ width: 640, height: 360 });
            p.on('pageerror', e => errors.push(`${name}: ${e.message}`));
            p.on('console', m => { if(m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
            await p.goto(`${base}?room=${room}&local=1&fly=1&bots=0&music=0${q}`);
            await p.waitForFunction(() => window.ctx && document.getElementById('loading')?.style.display === 'none', { timeout: 300000 });
            return p;
        };
        const host = await open(`&mpm=${hostMpm}`, 'host');
        await new Promise(r => setTimeout(r, 1500));
        const guest = await open('&mpm=1', 'guest');
        await new Promise(r => setTimeout(r, 2500));
        const roles = await Promise.all([host, guest].map(p => p.evaluate(() => ctx.net.isHost)));
        await guest.evaluate(() => { ctx.camera.position.set(-8, 3.6, -11.5); ctx.camera.lookAt(-14.5, 0.2, -17.5); ctx.destruction.blast([-14.1, 1.0, -17.1], 1.4, { strength: 14 }); });
        await host.bringToFront(); // a background tab gets no frames: the host must be the visible one to simulate
        const st = (p) => p.evaluate(() => ({ zones: ctx.mpm.zones.filter(Boolean).length, spawned: ctx.mpm.stats.spawned, deposits: ctx.mpm.stats.deposits, applied: ctx.mpm.stats.depositsApplied, seq: ctx.net.applied, pending: ctx.world.remote.pending }));
        let a, b;
        for(let i = 0; i < 120; i++) {
            await new Promise(r => setTimeout(r, 250));
            [a, b] = await Promise.all([st(host), st(guest)]);
            // (the guest, a background tab here, gets no frames: it drops its particles when it is shown again)
            if(a.applied > 0 && b.applied > 0 && !a.zones && a.seq === b.seq && !a.pending && !b.pending) break;
        }
        const hs = await Promise.all([host, guest].map(p => p.evaluate(async () => [...(await ctx.net.hashNow())])));
        const ref = new Map(hs[0]), differ = hs[1].filter(([k, v]) => ref.get(k) !== v).length;
        console.log(`mp (${label}): host ${JSON.stringify(a)} guest ${JSON.stringify(b)}`);
        check(roles[0] && !roles[1], `mp (${label}): the first tab hosts`);
        check(b.spawned > 0 && (hostMpm === '0' || a.spawned > 0), `mp (${label}): grains on ${hostMpm === '0' ? 'the guest' : 'both tabs'} (host ${a.spawned}, guest ${b.spawned})`);
        check(a.deposits === 1 && b.deposits === 0 && a.applied === 1 && b.applied === 1, `mp (${label}): only the host deposited, both applied it`);
        check(differ === 0 && ref.size > 0, `mp (${label}): the same terrain in both tabs (${differ} of ${ref.size} chunk hashes differ)`);
        await host.close(); await guest.close();
    }
}
check(errors.length === 0, `no console errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
fs.writeFileSync(`${out}/mpmgame.json`, JSON.stringify({ backend, report }, null, 1));
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
await browser.close();
process.exitCode = failed ? 1 : 0;
