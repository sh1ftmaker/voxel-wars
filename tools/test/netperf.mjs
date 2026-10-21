/** Single-player cost of the edit log: the same blast sequence profiled (in-game ?profile) on two servers, e.g. the
 *  build before src/net and this one; plus the same through ?loopback (the codec and a fake 60 ms server).
 *  node tools/test/netperf.mjs <url A> <url B>   e.g. http://127.0.0.1:5180/ http://127.0.0.1:5197/ */
import puppeteer from 'puppeteer-core';
const urls = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', args: ['--ignore-gpu-blocklist', '--use-angle=vulkan', '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
async function run(url) {
    const page = await browser.newPage();
    await page.setViewport({ width: 960, height: 540 });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if(m.type() === 'error') errors.push(m.text()); });
    await page.goto(url);
    await page.waitForFunction(() => window.ctx && document.getElementById('loading')?.style.display === 'none', { timeout: 120000 });
    const r = await page.evaluate(async () => {
        const w = (ms) => new Promise(r => setTimeout(r, ms));
        ctx.camera.position.set(-10, 12, 22); ctx.camera.lookAt(0, 0, 0);
        await w(1500);
        const d = ctx.destruction, t0 = performance.now();
        let removed = 0;
        const blasts = [];
        for(let i = 0; i < 16; i++) { blasts.push(d.blast([-30 + i * 4, 0.3, (i % 3) * 5 - 5], 1.8).done.then(r => { removed += r.volume; })); await w(400); }
        d.carve(d.brushes.box([-10.5, -1.6, -5], [-7.2, 1.6, 5]), { impulse: 6, kind: 'blast' });
        await Promise.all(blasts);
        await w(9000 - (performance.now() - t0));
        return { removed, bodies: ctx.destruction.bodies.stats, net: ctx.net?.stats };
    });
    const p = await page.waitForFunction(() => window.lastProfile, { timeout: 30000 }).then(h => h.jsonValue());
    await page.close();
    return { url, removed: r.removed, frames: p.summary?.frames ?? p.frames?.length, interval: p.summary?.interval, cpu: p.summary?.cpu, sections: p.summary?.sections, errors };
}
for(const u of urls) {
    for(const q of ['?profile=10&fly=1&bots=0&music=0', ...(u.includes('5197') ? ['?profile=10&fly=1&bots=0&music=0&loopback=60,20'] : [])]) {
        const r = await run(u + q);
        const sec = r.sections ? Object.fromEntries(Object.entries(r.sections).map(([k, v]) => [k, v?.mean ?? v])) : null;
        console.log(`${u}${q.includes('loopback') ? ' (loopback 60±20 ms)' : ''}: removed ${r.removed.toFixed(0)} m³, frames ${r.frames}, interval ${JSON.stringify(r.interval)}, cpu ${JSON.stringify(r.cpu)}, sections ${JSON.stringify(sec)}, errors ${r.errors.length}${r.errors.length ? ' ' + r.errors[0] : ''}`);
    }
}
await browser.close();
