/**
 * Soft ground check (headless Chromium, WebGPU through SwiftShader): blast / land / punch the ground, screenshot a
 * sequence and print the soft ground state. node tools/test/soft.mjs [outPrefix] [--webgl] [--scenario blast|land|bake]
 */
import puppeteer from 'puppeteer-core';
const args = process.argv.slice(2);
const out = args.find(a => !a.startsWith('--')) || '/tmp/soft';
const webgl = args.includes('--webgl');
const scenario = args.includes('--scenario') ? args[args.indexOf('--scenario') + 1] : 'blast';
const url = args.find(a => a.startsWith('http')) || 'http://127.0.0.1:5180/?fly=1&bots=0';
const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new',
    args: [...(webgl ? ['--use-angle=vulkan'] : (process.env.SOFT_ARGS ? process.env.SOFT_ARGS.split(' ') : ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU'])), '--ignore-gpu-blocklist', '--window-size=960,540'] });
const page = await browser.newPage();
await page.setViewport({ width: 960, height: 540 });
page.on('console', m => { const t = m.text(); if(!/GPU stall|powerPreference/.test(t)) console.log('[console]', m.type(), t.slice(0, 400)); });
page.on('pageerror', e => console.log('[pageerror]', e.message));
if(webgl) await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'gpu', { get: () => undefined }); });
await page.goto(url);
await page.waitForFunction(() => window.ctx && document.getElementById('loading')?.style.display === 'none', { timeout: 120000 });
await new Promise(r => setTimeout(r, 1500));
const info = await page.evaluate(async (scenario) => {
    const ctx = window.ctx, cam = ctx.camera;
    // a flat-ish ground point in front of the start
    const target = [-58, 0, 6];
    const hit = ctx.world.raycast([target[0], 20, target[2]], [0, -1, 0], 40);
    const p = hit ? hit.point : target;
    cam.position.set(p[0] - 9, p[1] + 4.5, p[2] + 0.01);
    cam.lookAt(p[0], p[1], p[2]);
    window.__p = p;
    return { soft: !!ctx.soft?.enabled, p, mat: hit?.mat };
}, scenario);
console.log('setup', JSON.stringify(info));
const shot = async (name) => page.screenshot({ path: `${out}-${name}.png` });
await shot('0-before');
const t0 = Date.now();
await page.evaluate((scenario) => {
    const ctx = window.ctx, p = window.__p;
    if(scenario === 'land') ctx.soft.wake([p[0], p[1] - 0.1, p[2]], { speed: 7, radius: 2.2, dir: [0, -1, 0] });
    else if(scenario === 'kick') ctx.soft.wake([p[0], p[1], p[2]], { speed: 8, radius: 3, up: 0.4 });
    else ctx.destruction.blast([p[0], p[1] + 0.2, p[2]], 1.6, { strength: 14 });
}, scenario);
const times = [80, 200, 400, 700, 1100, 1600, 2500, 4000];
for(const t of times) {
    const wait = t - (Date.now() - t0);
    if(wait > 0) await new Promise(r => setTimeout(r, wait));
    const st = await page.evaluate(() => { const s = window.ctx.soft; return s ? { zones: s.zones.map(z => ({ state: z.state, slot: z.slot, n: z.n, cells: z.count, life: +z.life.toFixed(2), maxU: z.maxU })), stats: s.stats } : null; });
    console.log(`t=${t}`, JSON.stringify(st));
    await shot(`${String(t).padStart(4, '0')}`);
}
// measure max |u| via readback of slot 0 while running? report fps
const fps = await page.evaluate(() => document.getElementById('stats')?.textContent);
console.log('stats', fps);
await browser.close();
