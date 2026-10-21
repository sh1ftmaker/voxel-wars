/** Fresh-break tint: blast a stone wall, compare the crater's brightness 4 s after (tinted) and 24 s after (faded).
 *  node tools/test/freshtint.mjs [outDir] [--url http://127.0.0.1:5180/]   (dev server running) */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const args = process.argv.slice(2);
const val = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const out = args[0] && !args[0].startsWith('--') ? args[0] : 'shots/fresh';
const base = val('--url', 'http://127.0.0.1:5180/');
fs.mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', args: ['--ignore-gpu-blocklist', '--use-angle=vulkan'] });
const page = await browser.newPage();
await page.setViewport({ width: 800, height: 500 });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto(`${base}?fly=1&bots=0&music=0&soft=0`);
await page.waitForFunction(() => window.ctx && document.getElementById('loading')?.style.display === 'none', { timeout: 90000 });
await page.evaluate(async () => {
    const d = ctx.destruction, B = d.brushes;
    d.carve(B.box([4, -0.7, 1], [9, 3.5, 3]), { op: 'add', mat: 0 });
    await new Promise(r => setTimeout(r, 1500));
    ctx.camera.position.set(6.5, 1.8, 7.5); ctx.camera.lookAt(6.5, 1.6, 2);
    d.blast([6.5, 1.6, 3.2], 1.3, { strength: 0 });
});
const mean = async () => {
    const buf = await page.screenshot({ clip: { x: 340, y: 200, width: 120, height: 100 }, encoding: 'base64' });
    return page.evaluate(async (b64) => {
        const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
        const c = new OffscreenCanvas(img.width, img.height).getContext('2d'); c.drawImage(img, 0, 0);
        const d = c.getImageData(0, 0, img.width, img.height).data; let s = 0;
        for(let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2];
        return s / (d.length / 4) / 3;
    }, buf);
};
await new Promise(r => setTimeout(r, 4000));
await page.screenshot({ path: `${out}/fresh-4s.png` });
const a = await mean();
await new Promise(r => setTimeout(r, 20000));
await page.screenshot({ path: `${out}/fresh-24s.png` });
const b = await mean();
console.log(`crater brightness: 4 s ${a.toFixed(1)}, 24 s ${b.toFixed(1)} (fresh is ${(a / b * 100 - 100).toFixed(0)}% brighter)`);
console.log(errors.length ? errors : 'no errors');
await browser.close();
