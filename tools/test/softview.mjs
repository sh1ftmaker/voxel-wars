/**
 * Soft ground, seen from a player's distance (headless Chromium; WebGL2 by default, so the CPU worker solver):
 * frames the grass field, then (1) a pure wake (no carve: every changed pixel is the ground moving) and (2) a rocket
 * blast, screenshotting a sequence and measuring the pixel change against the frame before. Also reports the frame
 * interval, the main-thread soft cost and the worker's solver time.
 *   node tools/test/softview.mjs [outPrefix] [--webgpu] [--tets] [--url http://127.0.0.1:5191/] [--point x,z] [--dist 14]
 */
import puppeteer from 'puppeteer-core';
const args = process.argv.slice(2);
const val = (k, d) => args.includes(k) ? args[args.indexOf(k) + 1] : d;
const out = args.find(a => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--')) || '/tmp/softview';
const webgpu = args.includes('--webgpu');
const base = val('--url', 'http://127.0.0.1:5191/');
const [px, pz] = val('--point', '-22,8').split(',').map(Number);
const dist = +val('--dist', 14), height = +val('--height', 2);
const url = `${base}?fly=1&bots=0&music=0${args.includes('--tets') ? '&tets=1' : ''}${val('--extra', '')}`;
const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new',
    args: [...(webgpu ? ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU'] : ['--use-angle=vulkan']), '--ignore-gpu-blocklist', '--window-size=960,540'] });
const page = await browser.newPage();
await page.setViewport({ width: 960, height: 540 });
const errors = [];
page.on('console', m => { const t = m.text(); if(m.type() === 'error') errors.push(t); if(!/GPU stall|powerPreference|WebGPU is not available/.test(t)) console.log('[console]', m.type(), t.slice(0, 300)); });
page.on('pageerror', e => { errors.push(e.message); console.log('[pageerror]', e.message); });
if(!webgpu) await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'gpu', { get: () => undefined }); });
await page.goto(url);
await page.waitForFunction(() => window.ctx && document.getElementById('loading')?.style.display === 'none', { timeout: 120000 });
const wall = args.includes('--wall');
const p = await page.evaluate((px, pz, dist, height, wall) => {
    const ctx = window.ctx, cam = ctx.camera;
    let p;
    if(wall) { // the red fort's east wall, seen from the field at eye level
        p = ctx.world.raycast([-28, 2.5, 0.3], [-1, 0, 0], 40).point;
        cam.position.set(p[0] + dist * 0.8, 2.2, p[2] + dist * 0.6);
    } else {
        p = ctx.world.raycast([px, 30, pz], [0, -1, 0], 60).point;
        cam.position.set(p[0] + 0.01, p[1] + height, p[2] + dist);
    }
    cam.lookAt(p[0], p[1], p[2]);
    window.__p = p; window.__wall = wall;
    // frame intervals
    window.__dts = [];
    let last = performance.now();
    const tick = (t) => { window.__dts.push(t - last); last = t; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    return p;
}, px, pz, dist, height, wall);
console.log('point', p.map(v => v.toFixed(2)).join(' '), 'url', url);
await new Promise(r => setTimeout(r, 3000)); // textures
const shot = async (name) => { const b64 = await page.screenshot({ encoding: 'base64' }); if(name) await page.screenshot({ path: `${out}-${name}.png` }); return b64; };
const diff = (a, b) => page.evaluate(async (a, b) => {
    const load = (s) => new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = 'data:image/png;base64,' + s; });
    const [A, B] = await Promise.all([load(a), load(b)]);
    const c = document.createElement('canvas'); c.width = A.width; c.height = A.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(A, 0, 0); const da = g.getImageData(0, 0, c.width, c.height).data;
    g.drawImage(B, 0, 0); const db = g.getImageData(0, 0, c.width, c.height).data;
    let changed = 0, sum = 0;
    for(let i = 0; i < da.length; i += 4) {
        if(i / 4 < c.width * 40) continue; // skip the stats line
        const d = Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
        sum += d; if(d > 30) changed++;
    }
    return { changedPct: +(100 * changed / (da.length / 4)).toFixed(2), meanDiff: +(sum / (da.length / 4)).toFixed(2) };
}, a, b);
const state = () => page.evaluate(() => { const s = window.ctx.soft; return { label: s.label, zones: s.zones.map(z => `${z.state}:${z.count ?? '?'}c`).join(','), cpuMs: +s.stats.cpuMs.toFixed(3), cpuMax: +s.stats.cpuMax.toFixed(3), worker: s.sim?.stats ? { ms: +s.sim.stats.workerMs.toFixed(2), max: +s.sim.stats.workerMax.toFixed(2), dropped: s.sim.stats.dropped } : null, bake: s.stats.lastBake }; });

for(const scenario of ['wake', 'blast']) {
    const ref = await shot(`${scenario}-0`);
    const t0 = Date.now();
    await page.evaluate((scenario) => {
        const ctx = window.ctx, p = window.__p;
        window.__dts.length = 0;
        if(scenario === 'wake') ctx.soft.wake([p[0], p[1], p[2]], { speed: 10, radius: 3, up: 0.45 });
        else if(window.__wall) ctx.destruction.blast([p[0] + 0.3, p[1], p[2]], 1.4, { strength: 14 });
        else ctx.destruction.blast([p[0] + 3, p[1] + 0.3, p[2] - 2], 1.6, { strength: 14 });
    }, scenario);
    for(const t of [100, 250, 450, 700, 1000, 1500, 2200, 3500]) {
        const wait = t - (Date.now() - t0);
        if(wait > 0) await new Promise(r => setTimeout(r, wait));
        const s = await shot(`${scenario}-${String(t).padStart(4, '0')}`);
        console.log(`${scenario} t=${t}`, JSON.stringify(await diff(ref, s)), JSON.stringify(await state()));
    }
    const dts = await page.evaluate(() => window.__dts.slice(2).sort((a, b) => a - b));
    console.log(`${scenario} frame interval ms: median ${dts[dts.length >> 1]?.toFixed(1)} p95 ${dts[Math.floor(dts.length * 0.95)]?.toFixed(1)} max ${dts.at(-1)?.toFixed(1)} (${dts.length} frames)`);
    await new Promise(r => setTimeout(r, 1500));
}
console.log('errors', errors.length, errors.slice(0, 5));
await browser.close();
