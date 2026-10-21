/**
 * Soft ground probe (headless Chromium, WebGL2 -> CPU worker): wake the ground and print, every 50 ms, the largest
 * displacement in the deformation texture and the slot parameters it carries. node tools/test/softprobe.mjs [url]
 */
import puppeteer from 'puppeteer-core';
const url = process.argv[2] || 'http://127.0.0.1:5191/?fly=1&bots=0&music=0';
const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', args: ['--use-angle=vulkan', '--ignore-gpu-blocklist', '--window-size=640,360'] });
const page = await browser.newPage();
page.on('pageerror', e => console.log('[pageerror]', e.message));
page.on('console', m => { if(m.type() === 'error') console.log('[error]', m.text().slice(0, 300)); });
await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'gpu', { get: () => undefined }); });
await page.goto(url);
await page.waitForFunction(() => window.ctx && document.getElementById('loading')?.style.display === 'none', { timeout: 120000 });
const rows = await page.evaluate(async () => {
    const ctx = window.ctx, s = ctx.soft, sim = s.sim;
    const hit = ctx.world.raycast([-22, 30, 8], [0, -1, 0], 60);
    s.wake(hit.point, { speed: 10, radius: 3, up: 0.45 });
    const out = [], t0 = performance.now();
    while(performance.now() - t0 < 2500) {
        await new Promise(r => setTimeout(r, 50));
        const d = sim.tex.image.data, NODE_CAP = 6144;
        let m = 0;
        for(let i = 0; i < NODE_CAP; i++) m = Math.max(m, Math.hypot(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]));
        const pb = 4 * NODE_CAP * 4;
        // u.y along x through the zone centre, on the node rows at the surface (y 0 and 0.5 m)
        const z = s.zones[0];
        let prof = '';
        if(z) {
            const NX = z.n[0] + 1, NY = z.n[1] + 1, k = Math.round((hit.point[2] - z.c0[2] * 0.5) / 0.5), j = Math.round((0 - z.c0[1] * 0.5) / 0.5);
            for(const jj of [j - 1, j, j + 1]) { prof += ` | y${jj}:`; for(let i = 0; i < NX; i += 2) prof += ' ' + d[(i + jj * NX + k * NX * NY) * 4 + 1].toFixed(2); }
        }
        out.push(`${(performance.now() - t0).toFixed(0)}ms${prof}`);
        out.push(`${(performance.now() - t0).toFixed(0)}ms max|u| ${m.toFixed(3)} A ${[...d.slice(pb, pb + 4)].map(v => v.toFixed(1))} B ${[...d.slice(pb + 4, pb + 8)].map(v => v.toFixed(0))} live ${sim.live.value} zones ${s.zones.map(z => z.state)} frames ${sim.stats.frames}`);
    }
    return out;
});
console.log(rows.join('\n'));
await browser.close();
