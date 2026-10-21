/** Frame cost with and without soft debris: blasts along the forts for 10 s (lots of falling, cracking debris),
 *  recorded by the in-game profiler (?profile), uncapped. node tools/test/softperf.mjs [baseUrl] */
import puppeteer from 'puppeteer-core';
const base = process.argv[2] || 'http://127.0.0.1:5180/';
const runOnce = async (extra) => {
    const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new',
        args: ['--ignore-gpu-blocklist', '--use-angle=vulkan', '--window-size=1280,720', '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if(m.type() === 'error') errors.push(m.text()); });
    await page.goto(`${base}?fly=1&bots=0&music=0&profile=10${extra}`);
    await page.waitForFunction(() => window.ctx && document.getElementById('loading')?.style.display === 'none', { timeout: 90000 });
    const res = await page.evaluate(async () => {
        const cam = ctx.camera, s = ctx.destruction.bodies.soft;
        const T = { awake: 0, workerMs: 0, bodies: 0, mainMs: 0, frames: 0 };
        // main-thread cost of the soft layer (timer resolution is 0.1 ms here: summed over the run, it averages out)
        for(const fn of ['frame', '_message', 'impact', 'blast', 'inherit']) {
            const f = s[fn]; if(!s.enabled || !f) continue;
            s[fn] = function(...a) { const t = performance.now(); try { return f.apply(this, a); } finally { T.mainMs += performance.now() - t; } };
        }
        if(s.enabled) s.worker.onmessage = (e) => s._message(e.data);
        const t0 = performance.now();
        let next = 0, k = 0;
        // blasts at the bases of the red fort's walls and towers, the camera watching from the field
        const spots = [[-40, 2, -10], [-40, 6, 10], [-38, 3, 0], [-44, 9, -16], [-44, 9, 16], [-40, 4, -4], [-40, 4, 6], [-36, 2, 14], [-36, 2, -14], [-42, 7, 0]];
        await new Promise(resolve => {
            const tick = () => {
                const t = (performance.now() - t0) / 1000;
                cam.position.set(-18 + Math.sin(t * 0.3) * 3, 9, Math.sin(t * 0.4) * 10); cam.lookAt(-40, 3, 0);
                if(t > next && k < spots.length * 2) { next += 0.7; const p = spots[k++ % spots.length]; ctx.destruction.blast(p, 2.6 + (k % 3) * 0.6, { strength: 16 }); }
                if(s.enabled) { T.awake = Math.max(T.awake, s.stats.awake); T.workerMs = Math.max(T.workerMs, s.stats.ms); }
                T.bodies = Math.max(T.bodies, ctx.destruction.bodies.list.size); T.frames++;
                if(window.lastProfile) resolve(); else requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
        });
        const S = window.lastProfile.summary;
        return { fps: +S.fps.toFixed(0), interval: S.interval, cpu: S.cpu, sections: Object.fromEntries(Object.entries(S.sections).map(([k, v]) => [k, v && { mean: v.mean, p99: v.p99, max: v.max }])),
            soft: s.enabled ? { ...T, mainMsPerFrame: +(T.mainMs / T.frames).toFixed(4), splits: s.stats.splits, built: s.stats.built } : null, fractured: ctx.destruction.bodies.stats.fractured, cracked: ctx.destruction.bodies.stats.cracked || 0, maxBodies: T.bodies };
    });
    await browser.close();
    return { res, errors };
};
for(const [name, extra] of [['soft debris off', '&softDebris=0'], ['soft debris on', '']]) {
    const { res, errors } = await runOnce(extra);
    console.log(`== ${name}`);
    console.log(JSON.stringify(res));
    console.log('errors:', errors.length ? errors.slice(0, 6).join(' | ') : 'none');
}
