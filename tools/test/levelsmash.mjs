/** The showcase structures come down when their supports go: blast the watchtower's piled legs, a fort window, the
 *  glass skybridge's girder ends (both: cut at one end it holds as a steel cantilever), the water tower's legs and a
 *  scaffold pole row; count what comes loose ('detached' events, volume by material) and screenshot each.
 *  node tools/test/levelsmash.mjs [outDir] [--url http://127.0.0.1:5180/] [--only name,name]   (dev server running) */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const args = process.argv.slice(2);
const val = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const out = args[0] && !args[0].startsWith('--') ? args[0] : 'shots/smash';
const base = val('--url', 'http://127.0.0.1:5180/');
const only = val('--only', null)?.split(',');
fs.mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', args: ['--ignore-gpu-blocklist', '--use-angle=vulkan', '--window-size=1280,720'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if(m.type() === 'error') errors.push(m.text()); });
await page.goto(`${base}?fly=1&bots=0&music=0`);
await page.waitForFunction(() => window.ctx && document.getElementById('loading')?.style.display === 'none', { timeout: 180000 });

// the skybridge goes last: its collapse makes many bodies, and detaching is budgeted per frame
const CASES = [
    ['watchtower', [-12, 7, -4], [-23, 3, -13], [[-23.6, 0.6, -14.6, 0.9], [-20.4, 0.6, -11.4, 0.9]]],
    ['window', [-48.5, 4, 22], [-48.5, 3.4, 11.7], [[-48.5, 3.4, 13.3, 0.7]]],
    ['water-tower', [-58, 9, -1], [-71, 6, -13], [[-72.8, 0.8, -14.8, 1.0], [-69.2, 0.8, -11.2, 1.0], [-72.8, 0.8, -11.2, 1.0], [-69.2, 0.8, -14.8, 1.0]]],
    ['scaffold', [-55, 5, 20], [-47, 3, 13], [[-49.5, -0.4, 13.45, 1.2], [-49.5, -0.4, 15.15, 1.2]]],
    ['skybridge', [3, 3.5, 26], [0, -1, 13], [[-8.6, -0.6, 12.7, 2.6], [-8.6, -0.6, 15.3, 2.6], [8.6, -0.6, 12.7, 2.6], [8.6, -0.6, 15.3, 2.6]]],
];
const results = [];
for(const [name, cam, at, blasts] of CASES) {
    if(only && !only.includes(name)) continue;
    const r = await page.evaluate(async (cam, at, blasts) => {
        const d = ctx.destruction, b = d.bodies;
        const w = (ms) => new Promise(r => setTimeout(r, ms));
        ctx.camera.position.set(...cam); ctx.camera.lookAt(...at);
        const byMat = {}; let n = 0;
        const on = (e) => { n++; byMat[e.detail.mat] = +((byMat[e.detail.mat] || 0) + e.detail.volume).toFixed(1); };
        ctx.events.addEventListener('detached', on);
        for(const [x, y, z, r] of blasts) d.blast([x, y, z], r, { strength: 4 });
        await w(1500);
        ctx.events.removeEventListener('detached', on);
        return { bodies: n, volumeByMat: byMat, collapsed: b.stats.collapsed || 0 };
    }, cam, at, blasts);
    await page.screenshot({ path: `${out}/${name}.png` });
    results.push({ name, ...r });
}
for(const r of results) console.log(JSON.stringify(r));
console.log(errors.length ? errors.slice(0, 5) : 'no errors');
await browser.close();
