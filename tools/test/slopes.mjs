/** Walks the player up real slopes in the level and reports where it got to.
 *  node tools/test/slopes.mjs [url]  (dev server running) */
import puppeteer from 'puppeteer-core';
const url = process.argv[2] || 'http://127.0.0.1:5180/?bots=0&music=0';
const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new', args: ['--ignore-gpu-blocklist', '--use-angle=vulkan', '--window-size=1280,720'] });
const page = await browser.newPage();
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto(url);
await page.waitForFunction(() => window.ctx?.game && document.getElementById('loading')?.style.display === 'none', { timeout: 60000 });
const res = await page.evaluate(async () => {
    const g = ctx.game, p = g.player, w = ms => new Promise(r => setTimeout(r, ms));
    g.started = true;
    const course = async (name, start, yaw, ms, goal, setup) => {
        if(setup) { setup(); await w(600); }
        p.body.teleport(start); p.yaw = yaw; p.pitch = 0;
        g.input.keys.clear(); await w(300);
        g.input.keys.add('KeyW');
        const track = []; const t0 = performance.now();
        while(performance.now() - t0 < ms) { await w(100); const c = p.body.feet; track.push([+c.x.toFixed(1), +c.y.toFixed(1), +c.z.toFixed(1)]); }
        g.input.keys.clear();
        const f = p.body.feet, ok = goal(f);
        return `${ok ? 'PASS' : 'FAIL'} ${name}: end (${f.x.toFixed(1)}, ${f.y.toFixed(1)}, ${f.z.toFixed(1)}) path ${track.filter((_, i) => i % 4 === 0).map(t => t.join(',')).join(' ')}`;
    };
    const out = [];
    out.push(await course('fort ramp (25°)', [-52.9, 0.4, 9.4], -Math.PI / 2, 4000, f => f.y > 5));
    out.push(await course('vault trench ledge (0.67 m)', [-55, 0, 9.4], -Math.PI / 2, 1500, f => f.x > -52.5));
    out.push(await course('dirt ramp (28°)', [-14.1, 0.2, 8], Math.PI, 4000, f => f.y > 5));
    out.push(await course('crater exit', [20.1, -2, 0.1], -Math.PI / 2, 4000, f => f.x > 25 && f.y > -0.5, () => ctx.destruction.blast([20.1, 0, 0.1], 4)));
    out.push(await course('crater exit 2', [-25.1, -2, -5.1], 0, 4000, f => f.z < -10 && f.y > -0.5, () => ctx.destruction.blast([-25.1, 0, -5.1], 4.5)));
    return out.join('\n');
});
console.log(res);
await browser.close();
