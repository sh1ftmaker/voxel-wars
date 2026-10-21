/** Material debris effects (src/fx/Particles.js, Fx, Sfx): fires each material-fracture event in front of the
 *  player and screenshots it (one sheet per kind with ImageMagick's montage when present), renders the new sounds
 *  offline, then measures the particle system with ~2000 live particles.
 *  node tools/test/fxkinds.mjs [outDir] [--url http://127.0.0.1:5180/]   (dev server running) */
import puppeteer from 'puppeteer-core';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const args = process.argv.slice(2);
const val = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const out = args[0] && !args[0].startsWith('--') ? args[0] : 'shots/fx';
const base = val('--url', 'http://127.0.0.1:5180/');
fs.mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', args: ['--ignore-gpu-blocklist', '--use-angle=vulkan', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
await page.setViewport({ width: 800, height: 450 });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if(m.type() === 'error') errors.push(m.text()); });
await page.goto(`${base}?bots=0&music=0&soft=0`);
await page.waitForFunction(() => window.ctx?.game?.fx && document.getElementById('loading')?.style.display === 'none', { timeout: 90000 });
await page.evaluate(() => new Promise(r => setTimeout(r, 1000)));
// no title card or HUD in the shots; look along the open field from above (the player's camera is frozen while the
// title card would be up, so the camera can be placed by hand)
await page.addStyleTag({ content: '.bz-screen, .bz-play { display: none !important; }' });
await page.evaluate(() => {
    const p = ctx.game.player;
    const tick = () => { ctx.camera.position.set(10, 2.6, 10); ctx.camera.lookAt(10, 1.0, 4); requestAnimationFrame(tick); };
    if(p) p.update = () => {}; // keep the camera where the test puts it
    tick();
});

const CASES = [
    ['wood-x', { ev: 'fracture', d: { mat: 10, mode: 'splinter', energy: 2 } }],
    ['wood-y', { ev: 'splinters', d: { mat: 14, axis: 1, count: 30 } }],
    ['stone', { ev: 'fracture', d: { mat: 0, mode: 'shatter', energy: 2, pieces: 4 } }],
    ['brick', { ev: 'chips', d: { mat: 5, count: 30 } }],
    ['metal', { ev: 'fracture', d: { mat: 6, mode: 'bend', energy: 2 } }],
    ['dirt', { ev: 'crumble', d: { mat: 1, volume: 3 } }],
    ['sand', { ev: 'crumble', d: { mat: 3, volume: 3 } }],
    ['snow', { ev: 'crumble', d: { mat: 4, volume: 3 } }],
    ['glass', { ev: 'fracture', d: { mat: 16, mode: 'shatter', energy: 2 } }],
];
const TIMES = [120, 450, 1500];
const sheets = [];
for(const [name, c] of CASES) {
    const files = [];
    // a spot 5 m ahead of the camera, 1 m up; fired as a ctx event
    await page.evaluate(({ ev, d }) => {
        const p = [10, 1.4, 5];
        window._fxT0 = performance.now();
        ctx.events.dispatchEvent(new CustomEvent(ev, { detail: { ...d, point: p } }));
    }, c);
    for(const t of TIMES) {
        await page.waitForFunction((t) => performance.now() - window._fxT0 >= t, {}, t);
        const f = `${out}/${name}-${t}.png`;
        await page.screenshot({ path: f });
        files.push(f);
    }
    const live = await page.evaluate(() => { const P = ctx.game.fx.parts; return { solid: P.solid.n, glass: P.glass.n, spark: P.spark.n, soft: P.soft.n }; });
    console.log(name, JSON.stringify(live));
    // let it clear before the next one
    await page.evaluate(() => new Promise(r => setTimeout(r, 2500)));
    try {
        const sheet = `${out}/sheet-${name}.png`;
        execFileSync('montage', [...files, '-tile', `${files.length}x1`, '-geometry', '400x225+2+2', sheet]);
        sheets.push(sheet);
    } catch(e) { /* no montage: the frames are there */ }
}
if(sheets.length) try { execFileSync('montage', [...sheets, '-tile', '1x', '-geometry', '+0+2', `${out}/sheet-all.png`]); } catch(e) {}

// the new sounds render (offline) without errors and are not silent
const audio = await page.evaluate(async () => {
    const mod = ctx.game.sfx.constructor;
    const all = await mod.selfTest(1.2);
    const pick = {};
    for(const k of ['fracture', 'tinkle', 'groan', 'crumble', 'shatter']) pick[k] = all[k];
    const bad = Object.entries(all).filter(([k, v]) => typeof v === 'string');
    return { pick, bad };
});
console.log('sounds', JSON.stringify(audio));

// perf: ~2000 live particles of every kind, in front of the camera
const perf = await page.evaluate(async () => {
    const fx = ctx.game.fx, P = fx.parts;
    const cam = ctx.camera, dir = cam.getWorldDirection(cam.position.clone());
    const c = [cam.position.x + dir.x * 8, cam.position.y + 2, cam.position.z + dir.z * 8];
    const fire = () => {
        for(const m of [0, 10, 14, 1, 6, 16, 3]) fx.emit(m, c, 60, { speed: 6, size: 0.1, up: 6 });
        fx.dust(0, c, 30, { linger: true });
    };
    const ms = [], live = [], samples = [];
    const t0 = performance.now();
    let frames = 0, last = performance.now(), worstGap = 0;
    while(performance.now() - t0 < 4000) {
        if(P.live < 2000) fire();
        await new Promise(r => requestAnimationFrame(r));
        const now = performance.now(); worstGap = Math.max(worstGap, now - last); last = now;
        frames++;
        if(frames > 10) { ms.push(P.ms); live.push(P.live); samples.push(P.samples); }
    }
    ms.sort((a, b) => a - b);
    const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
    return { frames, live: Math.round(avg(live)), maxLive: Math.max(...live), msAvg: +avg(ms).toFixed(3), msP95: +ms[Math.floor(ms.length * 0.95)].toFixed(3), msMax: +ms[ms.length - 1].toFixed(3), sdfSamplesPerFrame: Math.round(avg(samples)), worstFrameGap: +worstGap.toFixed(1) };
});
console.log('perf', JSON.stringify(perf));
await page.screenshot({ path: `${out}/perf-2000.png` });
console.log(errors.length ? errors : 'no errors');
await browser.close();
