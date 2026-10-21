/** Soft debris in the browser: a brick bridge's deck falls and a stone column topples; reports the soft layer's
 *  stats (lattices built, awake, cracks, worker / main cost), the largest displacement drawn, and screenshots
 *  (BURST=1: 24 frames, 60 ms apart).
 *  node tools/test/softdebris.mjs [url] [outdir]   (dev server running; WebGL2 headless; WEBGPU=1 for WebGPU) */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const url = process.argv[2] || 'http://127.0.0.1:5180/?fly=1&bots=0&music=0';
const out = process.argv[3] || 'shots';
fs.mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', args: process.env.WEBGPU ? ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--window-size=1280,720'] : ['--ignore-gpu-blocklist', '--use-angle=vulkan', '--window-size=1280,720'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if(m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
await page.goto(url);
await page.waitForFunction(() => window.ctx && document.getElementById('loading')?.style.display === 'none', { timeout: 90000 });
const shot = async (name) => { await page.screenshot({ path: `${out}/${name}.png` }); };
const evalr = (fn, ...a) => page.evaluate(fn, ...a);

const X = +(process.env.X || 16);
await evalr((X) => {
    const cam = ctx.camera; cam.position.set(X - 3, 7, 22); cam.lookAt(X, 3, 0);
    window.__fly = ctx.game || null;
    const B = (min, max) => ctx.destruction.brushes.box(min, max);
    const y0 = 0.1;
    for(const x of [-7.5, 7.5]) ctx.destruction.carve(B([X + x - 1, y0 - 0.5, -1], [X + x + 1, y0 + 7, 1]), { op: 'add', mat: 5 });
    ctx.destruction.carve(B([X - 9, y0 + 7, -1.5], [X + 9, y0 + 8.2, 1.5]), { op: 'add', mat: 5 });
    // a stone column in front
    ctx.destruction.carve(B([X - 1, y0 - 0.5, 5], [X + 1, y0 + 9, 7]), { op: 'add', mat: 0 });
}, X);
await page.waitForFunction(() => ctx.terrain.pending === 0, { timeout: 30000 });
await new Promise(r => setTimeout(r, 800));
await shot('0-built');
// track the soft layer
await evalr(() => {
    const s = ctx.destruction.bodies.soft;
    window.__track = { maxDrawn: 0, maxAwake: 0, maxWorkerMs: 0, mainMs: [], log: [] };
    const T = window.__track;
    const tick = () => {
        if(s.enabled) {
            let m = 0;
            for(let i = 0; i < s.atlas.length; i += 4) { const v = Math.abs(s.atlas[i]) + Math.abs(s.atlas[i + 1]) + Math.abs(s.atlas[i + 2]); if(v > m) m = v; }
            T.maxDrawn = Math.max(T.maxDrawn, m);
            T.maxAwake = Math.max(T.maxAwake, s.stats.awake);
            T.maxWorkerMs = Math.max(T.maxWorkerMs, s.stats.ms);
            T.mainMs.push(s.stats.mainMs); s.stats.mainMs = 0;
        }
        requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
});
// cut the bridge pillars and the column's foot (pushed sideways)
await evalr(async (X) => {
    const B = (min, max) => ctx.destruction.brushes.box(min, max);
    for(const x of [-7.5, 7.5]) ctx.destruction.carve(B([X + x - 1.5, 0.7, -1.5], [X + x + 1.5, 5.2, 1.5]), { hardness: false });
    // the column: its foot cut, then a blast at its top pushes it over
    ctx.destruction.carve(B([X - 1.5, 0.6, 4.5], [X + 1.5, 1.3, 7.5]), { hardness: false });
    await new Promise(r => setTimeout(r, 250));
    ctx.destruction.blast([X - 1.8, 8, 6], 1.2, { strength: 14 });
}, X);
const t0 = Date.now();
for(const ms of (process.env.BURST ? Array.from({ length: 24 }, (_, i) => 250 + i * 60) : [350, 600, 850, 1100, 1500, 2200])) {
    await new Promise(r => setTimeout(r, ms - (Date.now() - t0)));
    await shot(`1-t${String(ms).padStart(4, "0")}`);
}
await new Promise(r => setTimeout(r, 2500));
const res = await evalr(() => {
    const b = ctx.destruction.bodies, s = b.soft, T = window.__track;
    const mm = T.mainMs.filter(x => x > 0).sort((a, c) => a - c);
    return { backend: ctx.renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2', enabled: s.enabled, stats: s.stats, bodies: b.list.size, fractured: b.stats.fractured, cracked: b.stats.cracked || 0, detached: b.stats.detached,
        maxDrawn: +T.maxDrawn.toFixed(3), maxAwake: T.maxAwake, maxWorkerMs: +T.maxWorkerMs.toFixed(2),
        mainMsP50: mm.length ? +mm[mm.length >> 1].toFixed(3) : 0, mainMsMax: mm.length ? +mm[mm.length - 1].toFixed(3) : 0 };
});
console.log(JSON.stringify(res, null, 1));
console.log('errors:', errors.length ? errors.slice(0, 12).join('\n') : 'none');
await browser.close();
