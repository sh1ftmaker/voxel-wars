/** Screenshot tour of the level from fixed viewpoints, plus load and render stats (load time, chunks, triangles,
 *  draw calls, frame time at each view).
 *  node tools/test/leveltour.mjs [outDir] [--url http://127.0.0.1:5180/] [--only name,name]   (dev server running) */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const args = process.argv.slice(2);
const val = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const out = args[0] && !args[0].startsWith('--') ? args[0] : 'shots/tour';
const base = val('--url', 'http://127.0.0.1:5180/');
const only = val('--only', null)?.split(',');
fs.mkdirSync(out, { recursive: true });

// [name, camera position, look-at]
const VIEWS = [
    ['overview', [0, 45, 62], [0, 0, 0]],
    ['red-fort', [-20, 18, 24], [-48, 3, 0]],
    ['blue-fort', [20, 18, -24], [48, 3, 0]],
    ['gorge', [0, 10, -20], [0, -2, 10]],
    ['bridge', [14, 4, 0], [-6, 0, 0]],
    ['north', [-20, 16, 4], [-10, 5, 30]],
    ['south', [20, 14, -8], [10, 2, -30]],
    ['vault', [-42, 4, 0], [-55, -3, 0]],
    ['watchtower', [-12, 7, -4], [-23, 3, -13]],
    ['water-tower', [-58, 9, -1], [-71, 6, -13]],
    ['skybridge', [3, 3.5, 26], [0, -1, 13]],
    ['observatory', [-17, 11, 22], [-24, 7, 30]],
    ['footbridge', [11, 4, -8], [0, -3, -14]],
    ['lava', [-18, 9, -26], [-24, 4, -34]],
    ['scaffold', [-55, 5, 20], [-47, 3, 13]],
];

const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', args: ['--ignore-gpu-blocklist', '--use-angle=vulkan', '--window-size=1280,720'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if(m.type() === 'error') errors.push(m.text()); });
const t0 = Date.now();
await page.goto(`${base}?fly=1&bots=0&music=0`);
await page.waitForFunction(() => window.ctx && document.getElementById('loading')?.style.display === 'none', { timeout: 180000 });
const loadMs = Date.now() - t0;
await new Promise(r => setTimeout(r, 1500));
const stats = [];
for(const [name, pos, at] of VIEWS) {
    if(only && !only.includes(name)) continue;
    const s = await page.evaluate(async (pos, at) => {
        const c = ctx.camera;
        c.position.set(...pos); c.lookAt(...at);
        const fly = ctx.systems?.find?.(s => s.constructor.name === 'FlyCamera');
        // let the frame settle, then time 60 frames
        await new Promise(r => setTimeout(r, 500));
        const ts = [];
        let last = performance.now();
        for(let i = 0; i < 60; i++) { await new Promise(r => requestAnimationFrame(r)); const n = performance.now(); ts.push(n - last); last = n; }
        ts.sort((a, b) => a - b);
        const info = ctx.renderer.info.render;
        return { calls: info.drawCalls ?? info.calls, tris: info.triangles, frameMed: +ts[30].toFixed(1) };
    }, pos, at);
    await page.screenshot({ path: `${out}/${name}.png` });
    stats.push({ name, ...s });
}
const world = await page.evaluate(() => ({ chunks: ctx.terrain.meshes?.size ?? null, bodies: ctx.physics.props.size }));
console.log(JSON.stringify({ loadMs, world, stats }));
console.log(errors.length ? errors.slice(0, 5) : 'no errors');
await browser.close();
